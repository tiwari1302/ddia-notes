// B-tree lookups and page splits: a toy B+tree with 3 keys per fixed-size page. A lookup reads
// one page per level; an insert into a full page splits it and pushes a separator up, sometimes
// all the way to the root (the only way the tree grows taller). The scale panel connects the toy
// to real page sizes and branching factors.
(function () {
  "use strict";
  const MAX = 3;      // keys per page, leaf and internal
  const CAP = 16;     // toy limit: guarantees <= 8 leaves and depth <= 3
  const INITIAL = [10, 20, 30, 40, 50, 60, 70, 80, 25, 45, 65];
  const RANGE = [20, 60];

  // ------------------------------------------------------------------ model (pure)
  const newPage = (t, leaf) => ({ id: t.nextId++, leaf, keys: [], kids: [], next: null });
  // Child i covers keys k with keys[i-1] <= k < keys[i].
  const childIndex = (p, k) => { let i = 0; while (i < p.keys.length && p.keys[i] <= k) i++; return i; };
  function pathTo(t, k) {
    const path = [t.root];
    for (let p = t.root; !p.leaf; path.push(p)) p = p.kids[childIndex(p, k)];
    return path;
  }
  function levelsOf(t) {
    const levels = [[t.root]];
    while (!levels[levels.length - 1][0].leaf) levels.push(levels[levels.length - 1].flatMap(p => p.kids));
    return levels;
  }

  // Splits an overfull page and adds the separator to its parent (a new root if it has none).
  // Leaf: the right half's first key is COPIED up. Internal: the middle key MOVES up.
  function split(t, page, parent) {
    const right = newPage(t, page.leaf);
    let sep;
    if (page.leaf) {
      right.keys = page.keys.splice(2);
      sep = right.keys[0];
      right.next = page.next;
      page.next = right;
    } else {
      right.keys = page.keys.splice(3);
      right.kids = page.kids.splice(3);
      sep = page.keys.pop();
    }
    const newRoot = !parent;
    if (newRoot) { parent = newPage(t, false); parent.kids = [page]; t.root = parent; }
    const i = parent.kids.indexOf(page);
    parent.keys.splice(i, 0, sep);
    parent.kids.splice(i + 1, 0, right);
    return { type: "split", page, right, sep, parent, newRoot };
  }

  // One insert as a sequence of events; the tree is already updated when an event is yielded.
  function* insertSteps(t, k) {
    const path = pathTo(t, k), leaf = path[path.length - 1];
    yield { type: "path", path };
    if (leaf.keys.includes(k)) { yield { type: "update", page: leaf }; return; }
    leaf.keys.push(k);
    leaf.keys.sort((a, b) => a - b);
    t.size++;
    yield { type: "put", page: leaf };
    for (let lvl = path.length - 1, page = leaf; page.keys.length > MAX; lvl--) {
      const ev = split(t, page, path[lvl - 1]);
      yield ev;
      page = ev.parent;
    }
  }

  function initialTree() {
    const t = { root: null, nextId: 1, size: 0 };
    t.root = newPage(t, true);
    INITIAL.forEach(k => [...insertSteps(t, k)]);
    t.nextId = 1;
    levelsOf(t).flat().forEach(p => { p.id = t.nextId++; });   // BFS numbering: root = P1
    return t;
  }

  // ------------------------------------------------------------------ real-scale arithmetic
  // Pages per level (root first) when every page holds ~b entries.
  function levelPages(rows, b) {
    const out = [Math.ceil(rows / b)];
    while (out[0] > 1) out.unshift(Math.ceil(out[0] / b));
    return out;
  }
  // Size of `pages` pages of `kb` KB (1 KB page = 1024 bytes), in decimal units: 500^4 x 4 KB = 256 TB.
  function fmtSize(pages, kb) {
    if (pages * kb < 1000) return pages * kb + " KB";
    let v = pages * kb * 1024, u = 0;
    const units = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
    while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
    return (v >= 10 ? Math.round(v) : v.toFixed(1)) + " " + units[u];
  }
  function fmtCount(n) {
    if (n < 1e6) return n.toLocaleString("en-US");
    const [d, w] = n < 1e9 ? [1e6, "million"] : n < 1e12 ? [1e9, "billion"] : [1e12, "trillion"];
    return +(n / d).toPrecision(3) + " " + w;
  }
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

  Viz.register("ch3/btree", {
    title: "B-tree lookups and page splits",
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      // Page geometry: pageW = 2 * pad + MAX * slot; phones collapse far-away leaves to stubW stubs.
      const DESK = { W: 640, slot: 20, pad: 5, h: 30, slotH: 22, pageW: 70, fs: 12, badge: 8,
        margin: 12, gap: 6, bottom: 50, levelY: L => 30 + L * 80 };
      const PHONE = { W: 360, slot: 18, pad: 3, h: 28, slotH: 22, pageW: 60, stubW: 24, fs: 11, badge: 7,
        margin: 6, gap: 8, bottom: 46, levelY: L => 26 + L * 70 };
      let tree, rng, fx, focus, lastWrite, lastOp, noteFn, keyVal = 75;
      let pageKB = 4, branching = 500, rows = 1e9;
      let compact, G, view, busy = false, epoch = 0, seq = 0, chain = Promise.resolve();

      const freshFx = () => ({
        state: new Map(),   // page id -> visit | read | write | over
        badge: new Map(),   // page id -> {n, tone}: order in which the last op read/wrote pages
        edges: new Set(),   // child ids whose parent pointer is on the read path
        chain: new Set(),   // leaf ids whose sibling pointer the range scan followed
        hits: new Set(),    // "id:key" found by a lookup / scan
        fresh: new Set(),   // "id:key" written by the last insert
        hideKey: null,      // separator still flying up: {id, key}
        hideEdge: null,     // child whose parent pointer isn't written yet
      });
      const P = p => "<b>P" + p.id + "</b>";
      const ks = p => "[" + p.keys.join(" ") + "]";
      const leafOf = path => path[path.length - 1];
      const leftmost = () => { let p = tree.root; while (!p.leaf) p = p.kids[0]; return p; };

      function resetState() {
        tree = initialTree();
        rng = ctx.random(5);
        fx = freshFx();
        focus = new Set([leftmost().id]);
        lastWrite = 0;
        lastOp = ["–", ""];
        noteFn = () => ["Each box is one fixed-size <b>page</b> (3 keys here; real pages are 4–16 KB and hold hundreds). " +
          "A lookup reads one page per level, so its cost is the depth: 2 pages. Insert <b>75</b> (fits), then <b>47</b> (lands in a full page).", "info"];
      }

      // ---------------------------------------------------------------- layout
      // Phone: when the leaf row is too wide, leaves away from the last operation collapse to stubs.
      function pickStubs(leaves) {
        const out = new Set();
        if (!compact) return out;
        const width = () => leaves.reduce((a, p) => a + spanOf(p, { w: out.has(p.id) ? G.stubW : G.pageW, stub: out.has(p.id) }) + G.gap, 0);
        const fi = leaves.map((p, i) => (focus.has(p.id) ? i : -1)).filter(i => i >= 0);
        const dist = i => (fi.length ? Math.min(...fi.map(f => Math.abs(f - i))) : i);
        const order = leaves.map((p, i) => i).sort((a, b) =>
          (focus.has(leaves[a].id) - focus.has(leaves[b].id)) || dist(b) - dist(a) || b - a);
        for (const i of order) { if (width() <= G.W - 2 * G.margin) break; out.add(leaves[i].id); }
        return out;
      }
      // While a separator flies up, its parent is drawn as it was: without the new key and pointer.
      const shownKeys = p => (fx.hideKey && fx.hideKey.id === p.id ? p.keys.filter(k => k !== fx.hideKey.key) : p.keys);
      const shownKids = p => p.kids.filter(c => c.id !== fx.hideEdge);
      const spanOf = (p, b) => b.w + (shownKeys(p).length > MAX && !b.stub ? G.slot - 2 : 0);   // incl. overflow slot

      function layout() {
        const levels = levelsOf(tree), D = levels.length, leaves = levels[D - 1], pos = new Map();
        const stubs = pickStubs(leaves);
        leaves.forEach(p => pos.set(p.id, { w: stubs.has(p.id) ? G.stubW : G.pageW, stub: stubs.has(p.id), y: G.levelY(D - 1) }));
        const total = leaves.reduce((a, p) => a + spanOf(p, pos.get(p.id)), 0);
        const gap = (G.W - 2 * G.margin - total) / leaves.length;
        let x = G.margin + gap / 2;
        leaves.forEach(p => { const b = pos.get(p.id); b.x = x; x += spanOf(p, b) + gap; });
        for (let L = D - 2; L >= 0; L--) {
          const row = levels[L].map(p => {
            const cx = p.kids.reduce((a, c) => a + pos.get(c.id).x + pos.get(c.id).w / 2, 0) / p.kids.length;
            const b = { x: cx - G.pageW / 2, y: G.levelY(L), w: G.pageW };
            pos.set(p.id, b);
            return [p, b];
          });
          separate(row);
        }
        return { pos, levels, D, leaves, H: G.levelY(D - 1) + G.h + G.bottom };
      }
      // Keeps pages on one level from overlapping (only needed with phone stubs).
      function separate(row) {
        for (let i = 1; i < row.length; i++) {
          const [pp, pb] = row[i - 1];
          row[i][1].x = Math.max(row[i][1].x, pb.x + spanOf(pp, pb) + G.gap);
        }
        for (let i = row.length - 1; i >= 0; i--) {
          const [p, b] = row[i];
          const limit = i === row.length - 1 ? G.W - G.margin : row[i + 1][1].x - G.gap;
          b.x = Math.max(G.margin, Math.min(b.x, limit - spanOf(p, b)));
        }
      }
      // Interpolates two layouts; a new page slides out of `origin[id]` (the page it split from).
      function blend(L0, L1, k, origin) {
        const pos = new Map();
        L1.pos.forEach((b1, id) => {
          const b0 = L0.pos.get(id) || L0.pos.get(origin[id]);
          pos.set(id, { ...b1, x: b0 ? ctx.lerp(b0.x, b1.x, k) : b1.x, y: b0 ? ctx.lerp(b0.y, b1.y, k) : b1.y, alpha: L0.pos.has(id) ? 1 : k });
        });
        return { ...L1, pos, H: ctx.lerp(L0.H, L1.H, k) };
      }
      // Slot i spans boundaryX(i)..boundaryX(i + 1); slot MAX is the overflow cell outside the page.
      const boundaryX = (b, j) => (j <= MAX ? b.x + G.pad + j * G.slot : b.x + b.w - 2 + (j - MAX) * G.slot);
      const slotX = (b, i) => (i < MAX ? boundaryX(b, i) : b.x + b.w - 2 + (i - MAX) * G.slot) + G.slot / 2;
      const slotCenter = (L, p, i) => { const b = L.pos.get(p.id); return [b.stub ? b.x + b.w / 2 : slotX(b, i), b.y + G.h / 2]; };

      // ---------------------------------------------------------------- drawing
      function paint(L = layout()) {
        const { svg, scene } = view;
        svg.setAttribute("viewBox", `0 0 ${G.W} ${L.H.toFixed(1)}`);
        scene.innerHTML = "";
        const edges = s("g"), links = s("g"), hot = s("g"), pages = s("g");
        scene.append(edges, links, hot, pages);
        const alpha = p => { const a = L.pos.get(p.id).alpha; return a === undefined ? 1 : a; };
        const fromLeft = new Set();   // pages whose parent pointer arrives from the upper left
        L.levels.flat().forEach(p => shownKids(p).forEach((c, j) => {
          const b = L.pos.get(p.id), cb = L.pos.get(c.id), on = fx.edges.has(c.id);
          if (boundaryX(b, j) < cb.x + cb.w / 2) fromLeft.add(c.id);
          (on ? hot : edges).appendChild(s("line", {
            x1: boundaryX(b, j), y1: b.y + G.h, x2: cb.x + cb.w / 2, y2: cb.y, opacity: Math.min(alpha(p), alpha(c)),
            stroke: on ? "var(--viz-ok)" : "var(--viz-line)", "stroke-width": on ? 2.5 : 1.4,
          }));
        }));
        L.leaves.forEach((p, i) => {
          const q = L.leaves[i + 1];
          if (q && p.next === q) links.appendChild(siblingArc(L, p, q, Math.min(alpha(p), alpha(q))));
        });
        L.levels.flat().forEach(p => pages.appendChild(drawPage(p, L.pos.get(p.id), fromLeft.has(p.id))));
        const n = L.leaves.length;
        scene.appendChild(ctx.text(G.W / 2, L.H - 11, compact
          ? `All ${n} leaves at depth ${L.D}, linked in key order`
          : `All ${n} leaves are at depth ${L.D}, linked left to right by sibling pointers`, { size: G.fs, fill: "var(--viz-muted)" }));
        view.treeStats.set("depth", L.D).set("pages", L.pos.size).set("keys", tree.size)
          .set("fill", Math.min(100, Math.round((100 * tree.size) / (n * MAX))) + "%");
      }

      function siblingArc(L, p, q, opacity) {
        const a = L.pos.get(p.id), b = L.pos.get(q.id), y = a.y + G.h, dip = compact ? 13 : 16;
        const x1 = a.x + spanOf(p, a) - Math.min(12, a.w / 3), x2 = b.x + Math.min(12, b.w / 3);
        const on = fx.chain.has(p.id), color = on ? "var(--viz-ok)" : "var(--viz-c2)";
        return s("path", {
          d: `M${x1},${y} C${x1},${y + dip} ${x2},${y + dip} ${x2},${y + 2}`, fill: "none", opacity,
          stroke: color, "stroke-width": on ? 1.6 : 1.3, "stroke-dasharray": "4 3", "marker-end": view.svg.arrow(color),
        });
      }

      // The page id sits on the top corner away from the incoming pointer; the I/O badge on the other.
      function drawPage(p, b, labelRight) {
        const col = p.leaf ? "c2" : "c1", st = fx.state.get(p.id);
        const tone = { visit: "warn", read: "ok", write: "warn", over: "bad" }[st];
        const hit = b.stub && p.keys.some(k => fx.hits.has(p.id + ":" + k));
        const g = s("g", { opacity: b.alpha === undefined ? 1 : b.alpha });
        g.append(
          s("rect", { x: b.x, y: b.y, width: b.w, height: G.h, rx: 5, fill: "var(--viz-bg)" }),
          s("rect", {
            x: b.x, y: b.y, width: b.w, height: G.h, rx: 5, "stroke-width": tone ? 2.4 : 1.4,
            fill: st === "visit" ? "var(--viz-warn-soft)" : hit ? "var(--viz-ok-soft)" : `var(--viz-${col}-soft)`,
            stroke: `var(--viz-${tone || col})`,
          }));
        if (b.stub) {
          g.appendChild(ctx.text(b.x + b.w / 2, b.y + G.h / 2 + 0.5, p.keys[0], { size: G.fs, mono: true }));
        } else {
          const keys = shownKeys(p);
          for (let i = 0; i < Math.max(MAX, keys.length); i++) drawSlot(g, p, b, i, keys[i], col);
          shownKids(p).forEach((c, j) => g.appendChild(s("circle", { cx: boundaryX(b, j), cy: b.y + G.h, r: 2.2, fill: `var(--viz-${col})` })));
          g.appendChild(ctx.text(labelRight ? b.x + spanOf(p, b) - 1 : b.x + 1, b.y - 7, "P" + p.id,
            { size: G.fs, anchor: labelRight ? "end" : "start", fill: "var(--viz-muted)", halo: true }));
        }
        const badge = fx.badge.get(p.id);
        if (badge) {
          const cx = labelRight && !b.stub ? b.x + 3 : b.x + spanOf(p, b) - 3, cy = b.y - 1;
          g.append(s("circle", { cx, cy, r: G.badge, fill: `var(--viz-${badge.tone})`, stroke: "var(--viz-bg)", "stroke-width": 1.5 }),
            ctx.text(cx, cy + 0.5, badge.n, { size: G.fs, weight: 700, fill: "var(--viz-bg)" }));
        }
        return g;
      }

      function drawSlot(g, p, b, i, key, col) {
        const over = i >= MAX, tag = p.id + ":" + key, show = key !== undefined;
        const mark = !show ? null : over ? "bad" : fx.hits.has(tag) ? "ok" : fx.fresh.has(tag) ? "warn" : null;
        const cx = slotX(b, i), cy = b.y + G.h / 2;
        const cell = { x: cx - G.slot / 2 + 1, y: cy - G.slotH / 2, width: G.slot - 2, height: G.slotH, rx: 3 };
        if (over) g.appendChild(s("rect", { ...cell, fill: "var(--viz-bg)" }));
        g.appendChild(s("rect", {
          ...cell, fill: mark ? `var(--viz-${mark}-soft)` : "none", stroke: `var(--viz-${mark || col})`,
          "stroke-opacity": mark ? 1 : show ? 0.3 : 0.5, "stroke-width": mark ? 1.5 : 1, "stroke-dasharray": show ? null : "2 2",
        }));
        if (show) g.appendChild(ctx.text(cx, cy + 0.5, key, { size: G.fs, mono: true, weight: mark && !over ? 700 : null }));
      }

      // ---------------------------------------------------------------- operations
      function setLast(html, tone) { lastOp = [html, tone]; view.opStats.set("last", html, tone); }
      function say(fn) { noteFn = fn; refreshNote(); }
      function refreshNote() {
        const [html, tone] = noteFn();
        const full = tree.size >= CAP ? ` This toy tree is full (${CAP} keys; real pages hold hundreds): press <b>Reset</b>.` : "";
        view.note.set(html + full, tone);
      }
      function updateWriteCost() {
        view.opStats.set("cost", lastWrite ? `${lastWrite} × ${pageKB} KB = ${lastWrite * pageKB} KB` : "–", lastWrite ? (lastWrite > 1 ? "warn" : "ok") : "");
      }
      function syncButtons() { const full = tree.size >= CAP; view.insertBtn.disable(full); view.randomBtn.disable(full); }

      // Ops run one at a time; a click while one animates fast-forwards it (ctx.instant).
      function run(op, ...args) {
        const id = ++seq, ep = epoch;
        if (busy) ctx.instant = true;
        chain = chain.then(async () => {
          if (ep !== epoch || !ctx.alive) return;
          ctx.instant = id !== seq;
          busy = true;
          fx = freshFx();
          try { await op(ep, ...args); } finally { busy = false; ctx.instant = false; if (ctx.alive) syncButtons(); }
        }).catch(e => console.error("[viz ch3/btree]", e));
      }

      async function descend(path, ep) {
        for (let i = 0; i < path.length; i++) {
          const p = path[i];
          if (i) fx.edges.add(p.id);
          fx.state.set(p.id, "visit");
          fx.badge.set(p.id, { n: i + 1, tone: "ok" });
          setLast(`reading… ${plural(i + 1, "page")}`, "");
          paint();
          await ctx.sleep(350);
          if (ep !== epoch) return false;
          fx.state.set(p.id, "read");
        }
        paint();
        return true;
      }
      const pathNames = D => ["root", ...Array(Math.max(0, D - 2)).fill("internal"), "leaf"].slice(-D).join(", ");

      async function lookupOp(ep, k) {
        const path = pathTo(tree, k), leaf = leafOf(path), D = path.length;
        focus = new Set([leaf.id]);
        if (!(await descend(path, ep))) return;
        const found = leaf.keys.includes(k);
        if (found) fx.hits.add(leaf.id + ":" + k);
        paint();
        setLast(`read ${plural(D, "page")}`, "ok");
        say(() => found
          ? [`Found <b>${k}</b> after reading ${D} pages: ${pathNames(D)}. With 500 keys per page, 3–4 levels cover billions of rows.`, "ok"]
          : [`<b>${k}</b> not found. The lookup still read ${D} pages to be sure: ${P(leaf)} is the only leaf whose key range could hold ${k}.`, "info"]);
      }

      async function scanOp(ep) {
        const [lo, hi] = RANGE, path = pathTo(tree, lo), D = path.length;
        let leaf = leafOf(path), extra = 0;
        focus = new Set([leaf.id]);
        if (!(await descend(path, ep))) return;
        for (;;) {
          leaf.keys.filter(k => k >= lo && k <= hi).forEach(k => fx.hits.add(leaf.id + ":" + k));
          if (leaf.keys.some(k => k > hi) || !leaf.next) break;
          fx.chain.add(leaf.id);
          leaf = leaf.next;
          extra++;
          focus.add(leaf.id);
          fx.state.set(leaf.id, "visit");
          fx.badge.set(leaf.id, { n: D + extra, tone: "ok" });
          setLast(`reading… ${D} + ${extra} pages`, "");
          paint();
          await ctx.sleep(300);
          if (ep !== epoch) return;
          fx.state.set(leaf.id, "read");
        }
        paint();
        setLast(`read ${D} + ${extra} pages`, "ok");
        say(() => [`Descended once (${D} page reads), then walked right along the leaf chain through ${extra} more ${extra === 1 ? "leaf" : "leaves"} ` +
          "without going back up: that's why B+trees keep sibling pointers.", "ok"]);
      }

      async function insertOp(ep, k) {
        if (tree.size >= CAP) return;
        const gen = insertSteps(tree, k), path = gen.next().value.path;
        focus = new Set([leafOf(path).id]);
        if (!(await descend(path, ep))) return;
        fx.badge.clear();
        const written = [], splits = [];
        const wrote = p => {
          if (written.includes(p)) return;
          written.push(p);
          fx.state.set(p.id, "write");
          fx.badge.set(p.id, { n: written.length, tone: "warn" });
          lastWrite = written.length;
          setLast(`writing… ${plural(lastWrite, "page")}`, lastWrite > 1 ? "warn" : "");
          updateWriteCost();
        };
        let L0 = layout(), r, updated = false;
        while (!(r = gen.next()).done) {
          const ev = r.value;
          if (ev.type === "split") { splits.push(ev); await animateSplit(ev, L0, ep, wrote); }
          else {
            updated = ev.type === "update";
            wrote(ev.page);
            fx.fresh.add(ev.page.id + ":" + k);
            await showOverflow(ev.page, `<b>${k}</b> belongs in ${P(ev.page)}, but that page is full. A page can't grow past its fixed size, so it must split.`);
          }
          if (ep !== epoch) return;
          L0 = layout();
        }
        const leaf = leafOf(path), n = written.length, D = levelsOf(tree).length;
        setLast(`wrote ${plural(n, "page")} <span style="font-size:12px;opacity:.75">(${written.map(p => "P" + p.id).join(", ")})</span>`, n > 1 ? "warn" : "ok");
        updateWriteCost();
        const full = tree.size >= CAP, tone = splits.length || full ? "warn" : updated ? "info" : "ok";
        const fill = Math.round((100 * tree.size) / (levelsOf(tree)[D - 1].length * MAX));
        const fillNote = full ? ` Splits left the leaves only ${fill}% full (the dashed slots); under random inserts, real B-tree pages average about 69% full.` : "";
        say(() => [(splits.length ? splitNote(splits, n, D)
          : updated ? `<b>${k}</b> already exists: the value is overwritten in place in ${P(leaf)} (1 page written).`
          : `<b>${k}</b> fit into ${P(leaf)}: one page rewritten in place. With ${pageKB} KB pages that's ${pageKB} KB written ` +
            "to store one ~100-byte row (plus a WAL record): B-tree write amplification in one line.") + fillNote, tone]);
      }

      async function showOverflow(page, why) {
        const over = page.keys.length > MAX;
        if (over) { fx.state.set(page.id, "over"); view.note.set(why, "bad"); }
        paint();
        if (over) await ctx.sleep(600);
      }

      async function animateSplit(ev, L0, ep, wrote) {
        const { page, right, sep, parent } = ev;
        fx.state.set(page.id, "write");
        right.keys.forEach(k => { if (fx.fresh.has(page.id + ":" + k)) fx.fresh.add(right.id + ":" + k); });
        wrote(right);
        if (page.leaf) focus.add(right.id);
        fx.hideKey = { id: parent.id, key: sep };
        fx.hideEdge = right.id;
        view.note.set(page.leaf
          ? `Split: ${P(page)} keeps ${ks(page)} and new page ${P(right)} takes ${ks(right)}. A <em>copy</em> of <b>${sep}</b> goes up as the separator.`
          : `${P(page)} splits into ${ks(page)} and new page ${P(right)} ${ks(right)}; the middle key <b>${sep}</b> <em>moves</em> up${ev.newRoot ? " into a brand-new root" : ""}.`, "warn");
        const L1 = layout();
        await ctx.tween({ ms: 550, onUpdate: t => { if (ep === epoch) paint(blend(L0, L1, t, { [right.id]: page.id })); } });
        if (ep !== epoch) return;
        // A leaf's separator is copied (it stays in the right half); an internal one leaves its slot.
        const from = page.leaf ? slotCenter(L1, right, 0) : slotCenter(L1, page, page.keys.length);
        await flyKey(from, slotCenter(L1, parent, parent.keys.indexOf(sep)), sep, page.leaf ? "copy" : "moves up");
        if (ep !== epoch) return;
        fx.hideKey = fx.hideEdge = null;
        wrote(parent);
        fx.fresh.add(parent.id + ":" + sep);
        await showOverflow(parent, `${P(parent)} now has ${parent.keys.length} keys: it overflows too.`);
      }

      // The separator travels as a key cell, tagged with whether it was copied or moved.
      async function flyKey(from, to, key, tag) {
        const w = G.slot + 2, hh = G.slotH, g = s("g", { class: "viz-packet" });
        const cell = { x: -w / 2, y: -hh / 2, width: w, height: hh, rx: 4 };
        g.append(s("rect", { ...cell, fill: "var(--viz-bg)" }),
          s("rect", { ...cell, fill: "var(--viz-c1-soft)", stroke: "var(--viz-c1)", "stroke-width": 2 }),
          ctx.text(0, 0.5, key, { size: G.fs, mono: true, weight: 700 }),
          ctx.text(0, -hh / 2 - 8, tag, { size: G.fs, weight: 700, fill: "var(--viz-c1)", halo: true }));
        view.packets.appendChild(g);
        await ctx.tween({ ms: 700, onUpdate: k => g.setAttribute("transform", `translate(${ctx.lerp(from[0], to[0], k)},${ctx.lerp(from[1], to[1], k)})`) });
        g.remove();
      }

      function splitNote(evs, n, D) {
        const [lf, ...up] = evs, top = up[up.length - 1];
        const wal = `One insert rewrote ${n} pages; a crash between those writes would corrupt the tree, which is why B-trees need a write-ahead log (next section).`;
        if (!up.length) {
          return `${P(lf.page)} overflowed: split into ${P(lf.page)} ${ks(lf.page)} and ${P(lf.right)} ${ks(lf.right)}, ` +
            `and a <em>copy</em> of separator <b>${lf.sep}</b> went up into ${P(lf.parent)}. ${wal}`;
        }
        const head = `${P(lf.page)} split and a <em>copy</em> of <b>${lf.sep}</b> went up; ` + up.map(ev =>
          `${P(ev.page)} overflowed too, split, and <em>moved</em> <b>${ev.sep}</b> up${ev.newRoot ? "" : " into " + P(ev.parent)} (it is in neither half now)`).join("; ");
        if (!top.newRoot) return `${head}. ${wal}`;
        return `${head}, so a new root ${P(top.parent)} was created. The tree grew one level taller, at the top; ` +
          `every leaf is still at depth ${D} (that's what 'balanced' means), and this one insert wrote <b>${n} pages</b>.`;
      }

      function reset() {
        epoch++;
        ctx.instant = true;    // flush the running animation; its continuation sees the new epoch
        ctx.instant = false;
        resetState();
        keyVal = 75;
        view.keySlider.set(keyVal);
        view.packets.innerHTML = "";
        refresh();
      }

      // ---------------------------------------------------------------- scale panel
      function buildScale() {
        const seg = (label, options, value, set) => ui.segmented({ label, options, value, onChange: v => { set(v); updateScale(); } });
        const el = ui.panel("At real scale",
          ui.bar(
            seg("Page size", [4, 8, 16].map(v => ({ value: v, label: v + " KB" })), pageKB, v => { pageKB = v; }),
            seg("Branching factor", [100, 250, 500], branching, v => { branching = v; }),
            seg("Rows", [[1e6, "1 million"], [1e9, "1 billion"], [1e12, "1 trillion"]].map(([value, label]) => ({ value, label })), rows, v => { rows = v; })));
        const stats = ui.stats([{ key: "levels", label: "Levels needed" }, { key: "cap", label: "Capacity of 4 levels" }]);
        const pyramid = h("div", { style: "display:grid;grid-template-columns:auto minmax(40px,1fr) auto auto;gap:5px 10px;align-items:center;font-size:12.5px" });
        const note = h("div", { class: "muted", style: "font-size:12.5px;line-height:1.5;margin-top:10px" });
        el.append(stats, pyramid, note);
        el.style.marginTop = "12px";
        return { el, stats, pyramid, note };
      }
      function updateScale() {
        const { stats, pyramid, note } = view.scale;
        const lv = levelPages(rows, branching), inner = lv.slice(0, -1).reduce((a, v) => a + v, 0);
        stats.set("levels", lv.length).set("cap", fmtSize(branching ** 4, pageKB));
        pyramid.innerHTML = "";
        const maxLog = Math.log10(lv[lv.length - 1]) || 1;
        lv.forEach((n, i) => {
          const leaf = i === lv.length - 1, c = leaf ? "c2" : "c1";
          const width = (4 + (96 * Math.log10(n)) / maxLog).toFixed(1);   // log scale: the tree fans out
          const bar = h("div", { style: `height:10px;border-radius:3px;background:var(--viz-${c}-soft);border:1px solid var(--viz-${c});width:${width}%` });
          pyramid.append(h("span", { style: "font-weight:600" }, i === 0 ? "Root" : leaf ? "Leaves" : "Level " + (i + 1)),
            h("div", null, bar), h("span", { class: "mono", style: "text-align:right" }, fmtCount(n) + (n === 1 ? " page" : " pages")),
            h("span", { class: "mono", style: "text-align:right" }, fmtSize(n, pageKB)));
        });
        const rowsLabel = fmtCount(rows), small = inner * pageKB * 1024 <= 64e9;
        note.innerHTML = `With b = ${branching}, ${rowsLabel} rows need <b>${lv.length} levels</b>. Everything above the leaves is ${fmtCount(inner)} pages (${fmtSize(inner, pageKB)}), ` +
          (small ? "so it stays cached and a lookup costs about 1–2 disk reads." : "but the upper levels still stay cached, so a lookup costs only a few disk reads.") +
          " (Assumes ~b entries in every page.)";
        updateWriteCost();
        if (!busy) refreshNote();
      }

      // ---------------------------------------------------------------- build
      function build() {
        if (busy) ctx.instant = true;   // finish an animation that targets the old layout
        root.innerHTML = "";
        compact = ctx.compact;
        G = compact ? PHONE : DESK;
        const keySlider = ui.slider({ label: "Key", min: 1, max: 99, value: keyVal, onInput: v => { keyVal = v; } });
        const insertBtn = ui.button("Insert", () => run(insertOp, keyVal), { kind: "primary" });
        const randomBtn = ui.button("Insert random", () => {
          let k;
          do k = rng.int(1, 99); while (leafOf(pathTo(tree, k)).keys.includes(k));
          keyVal = k;
          keySlider.set(k);
          run(insertOp, k);
        }, { kind: "ghost" });
        const svg = ctx.svg({ w: G.W, h: 200, label: "B-tree pages, child pointers and leaf sibling pointers" });
        const scene = s("g"), packets = s("g");
        svg.append(scene, packets);
        const treeStats = ui.stats([["depth", "Depth"], ["pages", "Pages"], ["keys", "Keys"], ["fill", "Leaf fill"]].map(([key, label]) => ({ key, label })));
        const opStats = ui.stats([{ key: "last", label: "Last op" }, { key: "cost", label: "Write cost" }]);
        opStats.style.marginTop = "-4px";
        treeStats.style.gridTemplateColumns = "repeat(4, minmax(0, 1fr))";
        if (compact) opStats.style.gridTemplateColumns = "1fr";
        // Keep values on one baseline when a label wraps ("Leaf fill" on phones).
        [...treeStats.children].forEach(c => { c.style.display = "flex"; c.style.flexDirection = "column"; c.style.justifyContent = "space-between"; });
        const note = ui.note("");
        view = { svg, scene, packets, treeStats, opStats, note, insertBtn, randomBtn, keySlider };
        view.scale = buildScale();
        root.append(
          ui.bar(keySlider, insertBtn, ui.button("Lookup", () => run(lookupOp, keyVal)), randomBtn,
            ui.button("Range scan 20–60", () => run(scanOp), { kind: "ghost" }), ui.button("Reset", reset, { kind: "ghost" })),
          svg,
          ui.legend([["c1", "internal page"], ["c2", "leaf page"], ["c2", "sibling pointer", "dash"], ["ok", "read path", "line"],
            ["warn", "page written"], ["bad", "split / overflow"]].map(([c, label, shape]) => ({ color: `var(--viz-${c})`, label, shape: shape || "square" }))),
          note, treeStats, opStats, view.scale.el);
        refresh();
      }
      function refresh() {
        paint();
        setLast(...lastOp);
        updateScale();
        refreshNote();
        syncButtons();
      }

      resetState();
      build();
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
