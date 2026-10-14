// Rebalancing (DDIA ch6): add or remove a node and see which keys have to move. With
// hash mod N almost every key changes node, mostly between nodes that were already there;
// with a fixed set of partitions or a token ring only about the new node's fair share moves,
// and all of it moves to (or from) the node that changed.
(function () {
  "use strict";
  const L = "ABCDEFGH", KEYS = 10000, SHOWN = 120, PARTS = 24, RING = 4294967296;
  const MIN_N = 2, MAX_N = 8, START_N = 4;

  // ------------------------------------------------------------------ model (no DOM)
  /** FNV-1a, then murmur3's fmix32 finalizer so similar strings spread over all 32 bits. */
  function hash32(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }
  const KEY_HASH = Array.from({ length: KEYS }, (_, i) => hash32("key-" + i));

  /** Sorted token positions (and their nodes) for n nodes with T tokens each. */
  function buildRing(n, T) {
    const toks = [];
    for (let k = 0; k < n; k++) for (let t = 0; t < T; t++) toks.push([hash32("v-" + t + "-" + L[k]), k]);
    toks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return { pos: toks.map(t => t[0]), node: toks.map(t => t[1]), T };
  }
  /** Owner of hash h: the node of the first token >= h, wrapping round to the smallest token. */
  function ringOwner(ring, h) {
    let lo = 0, hi = ring.pos.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ring.pos[m] >= h) hi = m; else lo = m + 1; }
    return ring.node[lo === ring.pos.length ? 0 : lo];
  }
  const countOf = (table, k) => table.reduce((c, x) => c + (x === k), 0);
  /** New node n takes partitions, one at a time, from the busiest node until it owns its share. */
  function tableAdd(table, n) {
    const t = table.slice(), target = Math.floor(PARTS / (n + 1));
    while (countOf(t, n) < target) {
      let from = 0;
      for (let k = 1; k < n; k++) if (countOf(t, k) > countOf(t, from)) from = k;
      t[t.lastIndexOf(from)] = n;
    }
    return t;
  }
  /** The last node's partitions go, one at a time, to whichever node has the fewest. */
  function tableRemove(table, n) {
    const t = table.slice(), gone = n - 1;
    for (let p = 0; p < PARTS; p++) {
      if (t[p] !== gone) continue;
      let to = 0;
      for (let k = 1; k < gone; k++) if (countOf(t, k) < countOf(t, to)) to = k;
      t[p] = to;
    }
    return t;
  }
  /** A cluster: placement structure plus every key's owner and the key count per node. */
  function makeCluster(strategy, n, T, table) {
    const c = { strategy, n, T, table: null, ring: null };
    if (strategy === "fixed") c.table = table || Array.from({ length: PARTS }, (_, p) => p % n);
    if (strategy === "ring") c.ring = buildRing(n, T);
    c.owner = KEY_HASH.map(h => (strategy === "modn" ? h % n : strategy === "fixed" ? c.table[h % PARTS] : ringOwner(c.ring, h)));
    c.counts = Array(n).fill(0);
    c.owner.forEach(o => c.counts[o]++);
    return c;
  }
  const grow = c => makeCluster(c.strategy, c.n + 1, c.T, c.table && tableAdd(c.table, c.n));
  const shrink = c => makeCluster(c.strategy, c.n - 1, c.T, c.table && tableRemove(c.table, c.n));
  /** What moved between two clusters. node = the added (kind "add") or removed node. */
  function diff(before, after, kind, node) {
    const flows = new Map();
    let moved = 0, wasted = 0;
    for (let i = 0; i < KEYS; i++) {
      const a = before.owner[i], b = after.owner[i];
      if (a === b) continue;
      const necessary = kind === "add" ? b === node : a === node;
      moved++;
      if (!necessary) wasted++;
      const f = flows.get(a * 8 + b) || { from: a, to: b, keys: 0, necessary };
      f.keys++;
      flows.set(a * 8 + b, f);
    }
    const fair = kind === "add" ? Math.round(KEYS / after.n) : before.counts[node];
    const list = [...flows.values()].sort((x, y) => y.keys - x.keys || x.from - y.from || x.to - y.to);
    return { kind, node, moved, wasted, fair, flows: list };
  }
  const imbalance = c => (Math.max(...c.counts) * c.n) / KEYS;
  /** Ring arcs as runs of [start, end) with owner and whether ownership changed vs `before`. */
  function ringRuns(now, before) {
    const pts = [...new Set(now.pos.concat(before ? before.pos : []))].sort((a, b) => a - b);
    pts.push(RING - 1);
    const runs = [];
    let start = 0;
    for (const p of pts) {
      if (p <= start && runs.length) continue;
      const node = ringOwner(now, p), changed = !!before && ringOwner(before, p) !== node;
      const last = runs[runs.length - 1];
      if (last && last.node === node && last.changed === changed) last.end = p;
      else runs.push({ start, end: p, node, changed });
      start = p;
    }
    return runs;
  }

  // ------------------------------------------------------------------ view
  const fmt = n => n.toLocaleString("en-US");
  const pct = f => (f > 0 && f < 0.005 ? "<1%" : Math.round(f * 100) + "%");
  const capFor = n => Math.max(0.5, 1.25 / n);   // bar scale top; 2 balanced nodes must not look clipped
  const DOT = {
    stay: ["var(--viz-node)", "var(--viz-node-stroke)", 1.5],
    need: ["var(--viz-warn-soft)", "var(--viz-warn)", 2],
    waste: ["var(--viz-bad-soft)", "var(--viz-bad)", 2],
  };

  function geometry(compact) {
    return compact ? {
      W: 360, H: 494, fs: 11, cols: 12, cell: 28, gx: 26, gy: 36, r: 11, capX: 10, capY: 14,
      bandY: 318, sx: 10, sw: 340, sy: 327, sh: 22,
      barsY: 376, top: 384, base: 466, scale: 78, x0: 10, slot: 40, bw: 30, labelY: 482,
    } : {
      W: 640, H: 410, fs: 12, cols: 20, cell: 30, gx: 35, gy: 40, r: 11, capX: 16, capY: 16,
      bandY: 220, sx: 16, sw: 608, sy: 230, sh: 26,
      barsY: 284, top: 292, base: 380, scale: 84, x0: 16, slot: 72, bw: 44, labelY: 398,
    };
  }

  /** Bar outline; a clipped bar gets a zig-zag top whose peaks touch the top of the bar area. */
  function barPath(x, w, base, hgt, clipped) {
    const top = base - hgt;
    if (!clipped) return `M${x},${base}V${top}H${x + w}V${base}Z`;
    let d = `M${x},${base}V${top}`;
    for (let i = 0, tw = w / 4; i < 4; i++) d += `L${x + tw * (i + 0.5)},${top - 4}L${x + tw * (i + 1)},${top}`;
    return d + `V${base}Z`;
  }

  if (typeof Viz !== "undefined") Viz.register("ch6/rebalance-moves", {
    title: "Add a node: what moves?",
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      // State lives outside build() so a phone <-> desktop rebuild keeps it.
      let strategy = "modn", tokens = 16;
      let cur = makeCluster(strategy, START_N, tokens);
      let prev = null, change = null;   // the last add/remove; null after reset or a new cluster
      let compact = ctx.compact, view = null, epoch = 0;

      const strategySeg = ui.segmented({
        label: "Strategy", value: strategy,
        options: [{ value: "modn", label: "hash mod N" }, { value: "fixed", label: "Fixed partitions" }, { value: "ring", label: "Ring + tokens" }],
        onChange: v => { strategy = v; fresh(cur.n); },
      });
      const tokenSeg = ui.segmented({ label: "Tokens per node", options: [1, 4, 16, 64, 256], value: tokens, onChange: v => { tokens = v; fresh(cur.n); } });
      const addBtn = ui.button("+ Add node", () => apply("add"), { kind: "primary" });
      const rmBtn = ui.button("− Remove node", () => apply("remove"), { kind: "danger" });
      const resetBtn = ui.button("Reset", () => fresh(START_N), { kind: "ghost", title: "Back to 4 nodes" });
      const holder = h("div");
      const legend = ui.legend([
        { color: "var(--viz-node-stroke)", label: "stayed", shape: "square" },
        { color: "var(--viz-warn)", label: "moved to/from the changed node (necessary)", shape: "square" },
        { color: "var(--viz-bad)", label: "moved between old nodes (wasted)", shape: "square" },
      ]);
      const stats = ui.stats([
        { key: "moved", label: "Keys moved" }, { key: "fair", label: "Fair share" },
        { key: "wasted", label: "Wasted moves" }, { key: "imb", label: "Imbalance" }, { key: "nodes", label: "Nodes" },
      ]);
      const note = ui.note("");
      const log = ui.log({ title: "Data transferred", height: 154 });
      root.append(ui.bar(strategySeg, tokenSeg), ui.bar(addBtn, rmBtn, resetBtn), holder, legend, stats, note, log);

      // ---------------------------------------------------------------- actions
      function fresh(n) {
        cur = makeCluster(strategy, n, tokens);
        prev = change = null;
        render(false);
      }
      function apply(kind) {
        if (kind === "add" ? cur.n >= MAX_N : cur.n <= MIN_N) return;
        prev = cur;
        cur = kind === "add" ? grow(cur) : shrink(cur);
        change = diff(prev, cur, kind, kind === "add" ? prev.n : prev.n - 1);
        render(true);
      }
      function render(animate) {
        addBtn.disable(cur.n >= MAX_N);
        rmBtn.disable(cur.n <= MIN_N);
        tokenSeg.style.display = strategy === "ring" ? "" : "none";
        drawScene(animate);
        updateStats();
        note.set(...noteFor());
        updateLog();
      }

      // ---------------------------------------------------------------- scene
      function build() {
        compact = ctx.compact;
        const G = geometry(compact);
        const svg = ctx.svg({ w: G.W, h: G.H, label: "Keys and their owning nodes, the placement layer, and keys per node" });
        const muted = (x, y, str, o) => ctx.text(x, y, str, { size: G.fs, anchor: "start", fill: "var(--viz-muted)", ...o });
        svg.append(muted(G.capX, G.capY, "120 of 10,000 keys; letter = owning node"));
        const dots = [];
        for (let i = 0; i < SHOWN; i++) {
          const x = G.gx + (i % G.cols) * G.cell, y = G.gy + Math.floor(i / G.cols) * G.cell;
          const c = s("circle", { cx: x, cy: y, r: G.r });
          const t = ctx.text(x, y + 0.5, "", { size: G.fs, weight: 700 });
          svg.append(c, t);
          dots.push({ c, t, x, y });
        }
        const marker = s("circle", { r: G.r + 3.5, fill: "none", stroke: "var(--viz-ink)", "stroke-width": 1.5, "stroke-dasharray": "3 2" });
        const band = s("g");
        const barsTitle = muted(G.x0, G.barsY, "");
        svg.append(marker, band, barsTitle);
        const bars = [];
        for (let k = 0; k < MAX_N; k++) {
          const x = G.x0 + k * G.slot + (G.slot - G.bw) / 2;
          const ghost = s("rect", { x, width: G.bw, fill: "none", stroke: "var(--viz-muted)", "stroke-dasharray": "4 3" });
          const path = s("path", { "stroke-width": 1.5, "stroke-linejoin": "round" });
          const label = ctx.text(x + G.bw / 2, G.labelY, "", { size: G.fs });
          svg.append(ghost, path, label);
          bars.push({ x, ghost, path, label });
        }
        const ideal = s("line", { x1: G.x0, stroke: "var(--viz-muted)", "stroke-width": 1.5, "stroke-dasharray": "5 4" });
        svg.append(ideal);
        holder.innerHTML = "";
        holder.append(svg);
        view = { G, dots, marker, band, bars, ideal, barsTitle };
        drawScene(false);
      }

      function dotStatus(i) {
        if (!change || prev.owner[i] === cur.owner[i]) return "stay";
        const necessary = change.kind === "add" ? cur.owner[i] === change.node : prev.owner[i] === change.node;
        return necessary ? "need" : "waste";
      }
      function setDot(i, status, owner) {
        const d = view.dots[i], [fill, stroke, width] = DOT[status];
        ctx.attr(d.c, { fill, stroke, "stroke-width": width });
        d.t.textContent = L[owner];
      }
      const slotShares = c => Array.from({ length: MAX_N }, (_, k) => (k < c.n ? c.counts[k] / KEYS : 0));

      function drawBars(shares, cap, idealShare) {
        const { G, bars } = view, n = cur.n;
        bars.forEach((b, k) => {
          const added = change && change.kind === "add" && k === change.node;
          const clipped = shares[k] >= cap;
          const hgt = shares[k] > 0 ? Math.max(1.5, (Math.min(shares[k], cap) / cap) * G.scale) : 0;
          ctx.attr(b.path, {
            d: barPath(b.x, G.bw, G.base, hgt, clipped),
            fill: added ? "var(--viz-warn-soft)" : "var(--viz-c2-soft)", stroke: added ? "var(--viz-warn)" : "var(--viz-c2)",
          });
          b.path.style.display = hgt ? "" : "none";
        });
        const y = G.base - (Math.min(idealShare, cap) / cap) * G.scale;
        ctx.attr(view.ideal, { x2: G.x0 + n * G.slot, y1: y, y2: y });
      }
      // Static per-state parts of the bars: letters + percentages, and the removed node's ghost.
      function labelBars() {
        const { G, bars } = view, cap = capFor(cur.n);
        view.barsTitle.textContent = `keys per node · dashed line = ideal 1/N (${pct(1 / cur.n)})`;
        bars.forEach((b, k) => {
          const share = k < cur.n ? cur.counts[k] / KEYS : 0, gone = change && change.kind === "remove" && k === change.node;
          const clipped = share >= cap;
          b.label.textContent = k < cur.n ? `${L[k]} ${pct(share)}` : gone ? `${L[k]} ${compact ? "✕" : "gone"}` : "";
          ctx.attr(b.label, {
            fill: clipped ? (share * cur.n > 1.5 ? "var(--viz-bad)" : "var(--viz-warn)") : gone ? "var(--viz-muted)" : "var(--viz-ink)",
            "font-weight": clipped ? 800 : 400,
          });
          const old = gone ? Math.min(prev.counts[k] / KEYS, cap) / cap * G.scale : 0;
          ctx.attr(b.ghost, { y: G.base - old, height: old });
          b.ghost.style.display = gone ? "" : "none";
        });
      }

      function drawScene(animate) {
        if (!view) return;
        const my = ++epoch;
        const status = Array.from({ length: SHOWN }, (_, i) => dotStatus(i));
        const moved = status.map((st, i) => (st === "stay" ? -1 : i)).filter(i => i >= 0);
        view.dots.forEach(d => d.c.setAttribute("r", view.G.r));   // an interrupted pulse may have left one swollen
        drawBand(status);
        labelBars();
        const to = slotShares(cur), capTo = capFor(cur.n);
        if (!animate || !prev || ctx.instant) {
          status.forEach((st, i) => setDot(i, st, cur.owner[i]));
          drawBars(to, capTo, 1 / cur.n);
          return;
        }
        const from = slotShares(prev), capFrom = capFor(prev.n), r = view.G.r;
        status.forEach((st, i) => setDot(i, "stay", (st === "stay" ? cur : prev).owner[i]));
        // Moved dots swell and shrink; their letter and colour switch at the peak. Bars grow/shrink.
        ctx.tween({ ms: 500, ease: "linear", onUpdate: k => {
          if (my !== epoch) return;
          const rr = r + 3 * Math.sin(Math.PI * k), e = ctx.ease.inOut(k);
          moved.forEach(i => {
            view.dots[i].c.setAttribute("r", rr);
            if (k >= 0.5) setDot(i, status[i], cur.owner[i]);
          });
          drawBars(from.map((f, j) => ctx.lerp(f, to[j], e)), ctx.lerp(capFrom, capTo, e), ctx.lerp(1 / prev.n, 1 / cur.n, e));
        } });
      }

      // The middle layer between keys and nodes: none (mod N), the partition table, or the ring.
      function drawBand(status) {
        const { G, band, marker } = view;
        band.innerHTML = "";
        marker.style.display = "none";
        const label = str => band.appendChild(ctx.text(G.sx, G.bandY, str, { size: G.fs, anchor: "start", fill: "var(--viz-muted)" }));
        if (strategy === "modn") {
          label(compact ? "node = hash(key) mod N (no middle layer)" : "key → node directly: node = hash(key) mod N (no middle layer)");
          return drawModExample(status);
        }
        if (strategy === "fixed") {
          label(compact ? "24 partitions → node (key → partition is fixed)" : "partition → node table: 24 partitions; a key's partition = hash mod 24, fixed forever");
          const cw = G.sw / PARTS;
          cur.table.forEach((k, p) => {
            const changed = !!change && prev.table[p] !== k;
            const x = G.sx + p * cw;
            band.append(
              s("rect", { x: x + 1, y: G.sy, width: cw - 2, height: G.sh, rx: 3, fill: changed ? "var(--viz-warn-soft)" : "var(--viz-node)",
                stroke: changed ? "var(--viz-warn)" : "var(--viz-node-stroke)", "stroke-width": changed ? 1.5 : 1 }),
              ctx.text(x + cw / 2, G.sy + G.sh / 2 + 0.5, L[k], { size: G.fs, weight: changed ? 800 : 600 }));
          });
          return;
        }
        label(compact ? "hash ring, unrolled 0 → 2³² (wraps)" : "hash ring, unrolled (0 → 2³², wraps); a key goes to the next token to its right");
        drawRing();
      }

      // Worked arithmetic for one key: the first wasted move, else the first move, else key-0.
      function drawModExample(status) {
        const { G, band, dots, marker } = view;
        const i = Math.max(0, status.includes("waste") ? status.indexOf("waste") : status.indexOf("need"));
        ctx.attr(marker, { cx: dots[i].x, cy: dots[i].y });
        marker.style.display = "";
        const hv = KEY_HASH[i], st = status[i];
        const line = (y, parts) => {
          const t = ctx.text(G.sx, y, "", { size: G.fs, anchor: "start" });
          parts.forEach(([str, fill, weight]) => t.appendChild(s("tspan", { fill: fill || null, "font-weight": weight || null }, str)));
          band.appendChild(t);
        };
        const muted = "var(--viz-muted)", tone = st === "waste" ? "var(--viz-bad)" : "var(--viz-warn)";
        const head = [["circled key-" + i + ": ", muted], ["hash = " + fmt(hv), null, 600]];
        const mods = !change ? [[`mod ${cur.n} = ${hv % cur.n} → ${L[cur.owner[i]]}`, null, 700]]
          : [[`mod ${prev.n} = ${hv % prev.n} → ${L[prev.owner[i]]}`, null, 700], ["\u00a0 then \u00a0", muted],
            [`mod ${cur.n} = ${hv % cur.n} → ${L[cur.owner[i]]}`, tone, 800],
            [st === "waste" ? (compact ? "\u00a0 (wasted)" : "\u00a0 (both old nodes: wasted)") : "\u00a0 (necessary)", tone]];
        if (compact) { line(G.sy + 6, head); line(G.sy + 22, mods); }
        else line(G.sy + G.sh / 2, head.concat([["\u00a0\u00a0 "]], mods));
      }

      function drawRing() {
        const { G, band } = view;
        const before = change ? prev.ring : null, runs = ringRuns(cur.ring, before);
        const X = p => G.sx + (p / RING) * G.sw;
        band.appendChild(s("rect", { x: G.sx, y: G.sy, width: G.sw, height: G.sh, rx: 3, fill: "var(--viz-node)", stroke: "var(--viz-node-stroke)" }));
        let changedD = "", sepD = "";
        const dense = cur.ring.pos.length + (before ? before.pos.length : 0) > 180;
        runs.forEach((ru, j) => {
          const x1 = X(ru.start), x2 = X(ru.end);
          if (ru.changed) changedD += `M${x1},${G.sy + 1}H${Math.max(x2, x1 + 0.6)}V${G.sy + G.sh - 1}H${x1}Z`;
          if (!dense && j > 0 && runs[j - 1].node !== ru.node) sepD += `M${x1},${G.sy}V${G.sy + G.sh}`;
        });
        band.append(
          s("path", { d: changedD, fill: "var(--viz-warn)", "fill-opacity": 0.55 }),
          s("path", { d: sepD, stroke: "var(--viz-node-stroke)", "stroke-width": 1, fill: "none" }));
        runs.forEach(ru => {
          const x1 = X(ru.start), x2 = X(ru.end);
          if (x2 - x1 >= 15) band.appendChild(ctx.text((x1 + x2) / 2, G.sy + G.sh / 2 + 0.5, L[ru.node], { size: G.fs, weight: ru.changed ? 800 : 600 }));
        });
        // Mark the changed node's tokens under the strip while there are few enough to see.
        if (!change || cur.T > 16) return;
        const src = change.kind === "add" ? cur.ring : prev.ring, y = G.sy + G.sh + 2;
        let d = "";
        src.pos.forEach((p, j) => { if (src.node[j] === change.node) d += `M${X(p)},${y}l4,7h-8z`; });
        const added = change.kind === "add";
        band.append(
          s("path", { d, fill: added ? "var(--viz-warn)" : "none", stroke: "var(--viz-warn)", "stroke-width": 1.2, "stroke-linejoin": "round" }),
          ctx.text(G.sx + G.sw, G.bandY, `${added ? "▲" : "△"} ${L[change.node]}'s tokens${added ? "" : " (gone)"}`,
            { size: G.fs, anchor: "end", weight: 700, fill: "var(--viz-warn)" }));
      }

      // ---------------------------------------------------------------- readouts
      function updateStats() {
        const imb = imbalance(cur);
        stats.set("imb", "×" + imb.toFixed(2), imb <= 1.2 ? "ok" : imb <= 1.5 ? "warn" : "bad");
        stats.set("nodes", String(cur.n), "");
        if (!change) { ["moved", "fair", "wasted"].forEach(k => stats.set(k, "–", "")); return; }
        const { moved, fair, wasted } = change;
        const small = t => ` <span style="font-size:13px;font-weight:700">(${t})</span>`;
        stats.set("moved", fmt(moved) + small(pct(moved / KEYS)), moved <= 1.3 * fair ? "ok" : moved <= 2 * fair ? "warn" : "bad");
        stats.set("fair", pct(fair / KEYS), "info");
        stats.set("wasted", fmt(wasted), wasted ? "bad" : "ok");
      }

      function updateLog() {
        log.clear();
        if (!change) { log.add("Nothing has moved yet: add or remove a node.", "muted"); return; }
        const fl = change.flows;
        log.add(`${prev.n} → ${cur.n} nodes: ${fmt(change.moved)} keys in ${fl.length} flow${fl.length === 1 ? "" : "s"}`, "info");
        fl.slice(0, 8).forEach(f => log.add(`${L[f.from]} → ${L[f.to]}: ${fmt(f.keys)} keys`, f.necessary ? "warn" : "bad"));
        if (fl.length > 8) log.add(`… and ${fl.length - 8} more flows`, "muted");
        log.querySelector(".viz-log-list").scrollTop = 0;   // ui.log scrolls to the newest row
      }

      const P = x => pct(x / KEYS);
      const join = arr => (arr.length < 2 ? arr.join("") : arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1]);
      function biggest() {
        const k = cur.counts.indexOf(Math.max(...cur.counts));
        return `node <b>${L[k]}</b> owns <b>${P(cur.counts[k])}</b> where ${pct(1 / cur.n)} would be fair`;
      }
      function modNote() {
        const n = cur.n;
        if (!change) return [`<b>hash(key) mod ${n}</b> spreads keys evenly over ${n} nodes. Press <b>+ Add node</b> and count how many keys must move.`, "info"];
        const ex = change.flows.filter(f => !f.necessary).slice(0, 2).map(f => `${L[f.from]} → ${L[f.to]}`).join(", ");
        const X = L[change.node];
        if (change.kind === "add") {
          return [`Going from ${prev.n} to ${n} nodes changed hash mod N for about <b>${P(change.moved)}</b> of keys ` +
            `(a key stays only if hash mod ${prev.n} = hash mod ${n}: about 1 in ${n}). The red ones moved between nodes that ` +
            `were already there (${ex}, …) only because N changed: pure waste. Node ${X} needed just <b>${P(change.fair)}</b>.`, "bad"];
        }
        return [`Removing one of ${prev.n} nodes remapped about <b>${P(change.moved)}</b> of keys, although only the ` +
          `<b>${P(change.fair)}</b> on the removed node ${X} had to move. The rest (${ex}, …) is waste.`, "bad"];
      }
      function fixedNote() {
        const n = cur.n, per = L.slice(0, n).split("").map((_, k) => countOf(cur.table, k));
        const lo = Math.min(...per), hi = Math.max(...per);
        let html, tone;
        if (!change) {
          html = `<b>24 partitions</b>, ${lo === hi ? lo : lo + "–" + hi} per node. A key's partition (hash mod 24) never changes; ` +
            "rebalancing only moves whole partitions between nodes.";
          tone = "info";
        } else {
          const k = cur.table.filter((x, p) => x !== prev.table[p]).length, X = L[change.node];
          html = change.kind === "add"
            ? `Node ${X} took <b>${k} whole partitions</b> from the busiest nodes: about <b>${P(change.moved)}</b> of keys moved, ` +
              `every one of them to ${X}. Key → partition never changed; only partition → node did.`
            : `Node ${X}'s <b>${k} partitions</b> were handed, whole, to the nodes with the fewest: <b>${P(change.moved)}</b> of keys ` +
              `moved, exactly ${X}'s keys, and nothing moved between the other nodes.`;
          tone = "ok";
        }
        if (lo !== hi) {
          const nh = per.filter(x => x === hi).length, nl = n - nh;
          const own = (c, v) => (c === 1 ? `one owns ${v}` : `${c} own ${v}`);
          html += ` With 24 partitions on ${n} nodes, ${own(nh, hi)} and ${own(nl, lo)}: few partitions means coarse balance. ` +
            "Real systems use hundreds or thousands.";
          if (imbalance(cur) > 1.2) tone = "warn";
        }
        return [html, tone];
      }
      function ringNote() {
        const T = cur.T, imb = imbalance(cur), byImb = imb > 1.5 ? "bad" : imb > 1.2 ? "warn" : "ok";
        let html, tone;
        if (!change) {
          if (T === 1) {
            const k = cur.counts.indexOf(Math.max(...cur.counts));
            html = `With one token per node, each node sits at a random point on the ring and owns the gap back to the previous token, ` +
              `so arc sizes are random: node <b>${L[k]}</b> owns about <b>${P(cur.counts[k])}</b> where ${pct(1 / cur.n)} would be fair. ` +
              "Raise tokens per node: many small random arcs average out.";
          } else {
            html = `Each node owns ${T} tokens; a key belongs to the next token clockwise. ` +
              (imb <= 1.2 ? "Many small arcs average out, so load is close to even." : `With this few arcs, ${biggest()}.`);
          }
          tone = byImb;
        } else {
          const X = L[change.node], add = change.kind === "add";
          const peers = [...new Set(change.flows.map(f => (add ? f.from : f.to)))].map(k => L[k]);
          if (add && T === 1) {
            html = `Node ${X}'s single token took the arc just before it from one node, <b>${peers[0]}</b>: <b>${P(change.moved)}</b> of keys ` +
              `moved, all of them to ${X} and all of them from ${peers[0]}.`;
          } else if (add) {
            html = `Node ${X}'s ${T} tokens each took a slice from the next token's owner, so about <b>${P(change.moved)}</b> of keys moved, ` +
              `all of them to ${X}, taken from ${peers.length === prev.n ? "all " + prev.n + " old nodes" : join(peers)} in unequal amounts.`;
          } else {
            html = `Node ${X}'s ${T === 1 ? "only token" : T + " tokens"} left the ring; each arc now belongs to the next token clockwise: ` +
              `<b>${P(change.moved)}</b> of keys moved, exactly ${X}'s keys, ` +
              (peers.length === 1 ? `all onto <b>${peers[0]}</b>, which now carries ${X}'s whole load.` : `spread over ${join(peers)}.`);
          }
          if (add && change.moved > 1.3 * change.fair) html += ` That is more than ${X}'s fair ${P(change.fair)}: with few tokens, arcs are random.`;
          tone = T === 1 || peers.length === 1 || change.moved > 1.3 * change.fair ? "warn" : "ok";
          if (imb > 1.5) { html += ` Load is still lopsided: ${biggest()}.`; tone = "warn"; }
        }
        if (T <= 4) html += " Cassandra historically used 256 tokens per node; 4.0 defaults to 16 together with a smarter token-allocation algorithm.";
        return [html, tone];
      }
      const noteFor = () => (strategy === "modn" ? modNote() : strategy === "fixed" ? fixedNote() : ringNote());

      build();
      render(false);
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });

  // Lets a Node script check the model directly; inert in the browser.
  if (typeof module === "object" && module.exports) {
    module.exports = { hash32, makeCluster, grow, shrink, diff, imbalance, ringRuns, tableAdd, tableRemove, KEYS };
  }
})();
