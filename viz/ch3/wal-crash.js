// Crash mid-split (DDIA ch3). Inserting 45 into a full B-tree leaf rewrites three pages: the
// shrunken leaf P3′, a new leaf P5 and the parent P1′. Without a write-ahead log, a power failure
// between those page writes leaves the parent routing keys to a half-emptied leaf, so key 50,
// committed long before, vanishes. With a WAL, one fsynced log record makes the split
// all-or-nothing: the client hears OK once the record is durable, and restart redoes only the
// pages whose page LSN is older than the record.
(function () {
  "use strict";

  // ---------------- Model (pure, no DOM) ----------------
  const LSN = 100;                                  // the split's log record
  const OLD_KEYS = [10, 20, 30, 40, 50, 60, 70];
  const LEAVES = ["P2", "P3", "P5", "P4"];          // left to right on screen
  const ORDER = ["P3", "P5", "P1"];                 // write-back order of the split's pages
  const NAME = { P1: "P1′", P3: "P3′", P5: "P5" };  // in-RAM names of the new versions
  const initialDisk = () => ({
    P1: { keys: [30, 60], kids: ["P2", "P3", "P4"], lsn: 80 },
    P2: { keys: [10, 20], lsn: 75 },
    P3: { keys: [30, 40, 50], lsn: 99 },
    P4: { keys: [60, 70], lsn: 98 },
    P5: null,
  });
  // B+tree leaf split: the right half's first key (45) is copied up into the parent.
  const SPLIT = {
    P3: { keys: [30, 40], lsn: LSN },
    P5: { keys: [45, 50], lsn: LSN },
    P1: { keys: [30, 45, 60], kids: ["P2", "P3", "P5", "P4"], lsn: LSN },
  };
  const copy = p => (p ? JSON.parse(JSON.stringify(p)) : null);

  const childIndex = (root, k) => root.keys.filter(sep => k >= sep).length;
  const reachable = (disk, k) => {
    const leaf = disk[disk.P1.kids[childIndex(disk.P1, k)]];
    return !!leaf && leaf.keys.includes(k);
  };
  const orphans = disk => LEAVES.filter(id => disk[id] && !disk.P1.kids.includes(id));
  const needsRedo = (disk, id) => !disk[id] || disk[id].lsn < LSN;
  /** Keys a reader can't find through the on-disk tree: committed ones, plus any stranded in orphans. */
  function unreachable(st) {
    const out = new Set(st.committed.filter(k => !reachable(st.disk, k)));
    orphans(st.disk).forEach(id => st.disk[id].keys.forEach(k => out.add(k)));
    return [...out].sort((a, b) => a - b);
  }
  function treeStatus(st, wal) {
    if (!st.pool.some(p => p.dirty) && !unreachable(st).length) return ["consistent", "ok"];
    if (st.phase === "run") return ["in progress", "warn"];
    return wal ? ["needs redo", "warn"] : ["corrupt", "bad"];
  }

  // ---------------- Layouts ----------------
  const DESK = {
    W: 640, H: 338, fs: 12, trayFs: 13, crash: [320, 109, 14],
    client: { x: 40, y: 52, r: 20, ty: 20, sy: 88 },
    pool: { x: 90, y: 14, w: 542, h: 88, tx: 98, ty: 30, px: [104, 222, 340], py: 44, pw: 100, ph: 40, hy: 13, ky: 29 },
    disk: { x: 90, y: 116, w: 362, h: 214, tx: 98, ty: 132, cap: "max 3 keys per page" },
    root: { x: 224, y: 146, w: 96, h: 34, slot: 28, pad: 6, gap: 8, tagDx: 68 },
    leaf: { xs: { P2: 100, P3: 188, P5: 276, P4: 364 }, y: 226, w: 80, h: 32, slot: 22, pad: 7, ly: 272, tagY: 290 },
    wal: { x: 466, y: 116, w: 166, h: 214, tx: 474, ty: 132, title: "WAL (append-only)", rowX: 472, rowW: 154, rowH: 34,
      old: [{ y: 146, lines: ["LSN 98", "update 70 in P4"] }, { y: 186, lines: ["LSN 99", "update 40 in P3"] }],
      next: { y: 226, lines: ["LSN 100", "split P3; P1 += 45"] },
      off: [[209, "no WAL", 700], [229, "disk pages are"], [245, "the only copy"]],
      rules: [[474, 290, "start"], [474, 311, "start"]] },
    tray: [98, 316],
  };
  const PHONE = {
    W: 360, H: 424, fs: 11, trayFs: 12, crash: [180, 98, 13],
    client: { x: 22, y: 44, r: 16, ty: 16, sy: 72 },
    pool: { x: 46, y: 10, w: 306, h: 82, tx: 54, ty: 24, px: [54, 154, 254], py: 42, pw: 92, ph: 36, hy: 12, ky: 26 },
    disk: { x: 8, y: 104, w: 344, h: 206, tx: 14, ty: 120, cap: "3 keys per page" },
    root: { x: 140, y: 134, w: 84, h: 30, slot: 22, pad: 9, gap: 6, tagDx: 56 },
    leaf: { xs: { P2: 14, P3: 98, P5: 182, P4: 266 }, y: 212, w: 76, h: 30, slot: 22, pad: 5, ly: 254, tagY: 272 },
    wal: { x: 8, y: 322, w: 344, h: 94, tx: 14, ty: 337, title: "WAL", rowX: 12, rowW: 336, rowH: 26,
      old: [{ y: 346, lines: ["LSN 98–99: earlier changes"] }],
      next: { y: 378, lines: ["LSN 100: split P3, P1 += 45"] },
      off: [[360, "no WAL", 700], [378, "disk pages are the only copy"]],
      rules: [[74, 337, "start"], [346, 337, "end"]] },
    tray: [14, 296],
  };

  const INTRO = "Press <b>Play</b>: we insert key 45 into a full leaf, and the power fails partway through writing the result.";
  const NOTE_OFF = ["Without a log there is no atomicity across pages: the crash left a parent pointing at a half-emptied leaf " +
    "and silently lost key 50. Fsyncing each page doesn't help; the problem is the gap between the writes.", "bad"];
  const NOTE_ON = ["The WAL turned three page writes into one atomic, durable log append. Writing pages is now just a " +
    "cache flush that recovery can always finish.", "ok"];
  const FOOT = "Torn pages: a single page write can itself be cut halfway. PostgreSQL logs a full image of a page the first " +
    "time it changes after each checkpoint; InnoDB writes every page twice, first to its doublewrite buffer.";
  const RULES = ["1. log before data", "2. commit after log"];
  const CLIENT = { idle: ["idle", "muted", ""], waiting: ["waiting", "warn", "warn"], ok: ["OK", "ok", "ok"], noreply: ["no reply", "muted", ""] };

  Viz.register("ch3/wal-crash", {
    title: "Crash mid-split: with and without a WAL",
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      const V = c => `var(--viz-${c})`;
      const cfg = { wal: false, after: 1 };
      let compact = ctx.compact, G = null, view = null, player = null, gen = 0;

      const walSeg = ui.segmented({
        label: "Write-ahead log", value: "off",
        options: [{ value: "off", label: "Off" }, { value: "on", label: "On" }],
        onChange: v => { cfg.wal = v === "on"; restart(); },
      });
      const crashSeg = ui.segmented({
        label: "Power fails after", value: 1,
        options: [{ value: 1, label: "1 page written" }, { value: 2, label: "2 pages written" }],
        onChange: v => { cfg.after = v; restart(); },
      });
      const stage = h("div");
      const legend = ui.legend([
        { color: V("c6"), label: "client" },
        { color: V("c1"), label: "internal page", shape: "square" },
        { color: V("c2"), label: "leaf page", shape: "square" },
        { color: V("warn"), label: "dirty / in flight", shape: "square" },
        { color: V("ok"), label: "durable", shape: "square" },
        { color: V("bad"), label: "crash / lost / orphan", shape: "square" },
      ]);
      const stats = ui.stats([
        { key: "writes", label: "Page writes" }, { key: "client", label: "Client" },
        { key: "keys", label: "Reachable on disk" }, { key: "tree", label: "Tree" },
      ]);
      const note = ui.note("");
      const foot = h("div", { class: "muted", style: "font-size:12.5px;line-height:1.45;margin-top:10px" }, FOOT);
      root.append(ui.bar(walSeg, crashSeg), stage, note, stats, foot);

      // ---------- geometry helpers ----------
      const pageBox = id => (id === "P1" ? G.root : { x: G.leaf.xs[id], y: G.leaf.y, w: G.leaf.w, h: G.leaf.h });
      const pagePos = id => { const b = pageBox(id); return [b.x + b.w / 2, b.y + b.h / 2]; };
      const pageTop = id => { const b = pageBox(id); return [b.x + b.w / 2, b.y]; };
      const ptrX = k => G.root.x + G.root.pad + k * G.root.slot;   // child pointer k sits between key slots
      const poolPos = i => [G.pool.px[i] + G.pool.pw / 2, G.pool.py + G.pool.ph / 2];
      const walPos = () => [G.wal.rowX + G.wal.rowW / 2, G.wal.next.y + G.wal.rowH / 2];
      const clientPos = () => [G.client.x, G.client.y];

      // ---------- animation helpers ----------
      // Every await goes through guard(): after a knob change or relayout (gen bumps), a stale step
      // never resumes, so the old script cannot draw over the new one.
      const guard = (st, p) => p.then(v => (st.gen === gen ? v : new Promise(() => {})));
      const sleep = (st, ms) => guard(st, ctx.sleep(ms));
      const tween = (st, ms, fn) => guard(st, ctx.tween({ ms, onUpdate: fn }));
      const fly = (st, from, to, label, color, ms = 650) =>
        guard(st, ctx.fly(view.L.packets, { from, to, label, fill: V(color), ms, labelSize: G.fs }));
      const t = (g, x, y, str, o) => { const el = ctx.text(x, y, str, { size: G.fs, ...o }); g.appendChild(el); return el; };

      function pill(g, x, y, str, tone, anchor = "middle") {
        const col = tone === "muted" ? V("muted") : V(tone), hh = G.fs + 6;
        const label = t(g, x, y + 0.5, str, { weight: 700, fill: col });
        const w = (label.getComputedTextLength() || str.length * G.fs * 0.6) + 14, x0 = anchor === "start" ? x : x - w / 2;
        ctx.attr(label, { x: x0 + w / 2 });
        g.insertBefore(s("rect", { x: x0, y: y - hh / 2, width: w, height: hh, rx: hh / 2,
          fill: tone === "muted" ? V("node") : V(tone + "-soft"), stroke: col, "stroke-width": 1 }), label);
      }

      // ---------- static scene ----------
      function drawPanels(g) {
        const panel = (b, dashed) => g.appendChild(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10,
          fill: "none", stroke: V("line"), "stroke-width": 1.3, "stroke-dasharray": dashed ? "6 5" : null }));
        const title = (b, str) => t(g, b.tx, b.ty, str, { anchor: "start", weight: 700, fill: V("muted") });
        panel(G.pool, true);
        title(G.pool, "Buffer pool (RAM)");
        panel(G.disk);
        title(G.disk, "Disk: B-tree pages");
        t(g, G.disk.x + G.disk.w - 8, G.disk.ty, G.disk.cap, { anchor: "end", fill: V("muted") });
        panel(G.wal, !cfg.wal);
        if (cfg.wal) title(G.wal, G.wal.title);
        else G.wal.off.forEach(([y, str, weight]) => t(g, G.wal.x + G.wal.w / 2, y, str, { fill: V("muted"), weight }));
        const c = G.client;
        g.appendChild(ctx.node({ x: c.x, y: c.y, r: c.r, label: "C", fill: V("c6-soft"), stroke: V("c6") }));
        t(g, c.x, c.ty, "client", { fill: V("muted") });
        view.status = t(g, c.x, c.sy, "", { weight: 700 });
      }

      // ---------- dynamic scene (fully redrawn from state) ----------
      function render(st) {
        const { dyn, pool } = view.L;
        dyn.replaceChildren();
        pool.replaceChildren();
        drawEdges(dyn, st);
        ["P1", ...LEAVES].forEach(id => drawPage(dyn, st, id));
        drawPool(pool, st);
        if (cfg.wal) drawWal(dyn, st);
        if (st.tray) drawTray(dyn, st);
        const [txt, tone] = CLIENT[st.client];
        view.status.textContent = txt;
        ctx.attr(view.status, { fill: V(tone) });
        updateStats(st);
      }

      function drawEdges(g, st) {
        const r = st.disk.P1, y1 = G.root.y + G.root.h;
        r.kids.forEach((id, k) => {
          const [x2, y2] = pageTop(id), hot = st.hot === id, col = hot ? V("bad") : V("muted");
          g.appendChild(ctx.arrow({ x1: ptrX(k), y1, x2, y2: y2 - 1, color: col, width: hot ? 2.2 : 1.3, svg: view.svg }));
          if (hot) {
            const lo = k ? r.keys[k - 1] : "", hi = k < r.keys.length ? r.keys[k] - 1 : "";
            // Right of the arrow: the gap toward the next pointer is empty, while the left side crosses the P2 edge.
            t(g, (ptrX(k) + x2) / 2 + 8, (y1 + y2) / 2, `${lo}–${hi}`, { anchor: "start", weight: 700, fill: col, halo: true });
          }
        });
        r.kids.forEach((_, k) => g.appendChild(s("circle", { cx: ptrX(k), cy: y1, r: 2.5, fill: V("muted") })));
      }

      function drawPage(g, st, id) {
        const b = pageBox(id), pg = st.disk[id], isRoot = id === "P1", geo = isRoot ? G.root : G.leaf;
        const [cx, cy] = pagePos(id);
        if (!pg) {   // the unused page slot that the split will allocate as P5
          g.appendChild(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 6, fill: "none",
            stroke: V("line"), "stroke-width": 1.3, "stroke-dasharray": "4 4" }));
          t(g, cx, cy, "free", { fill: V("muted") });
          t(g, cx, geo.ly, id, { weight: 700, fill: V("muted") });
          return;
        }
        const c = isRoot ? "c1" : "c2", orphan = !isRoot && !st.disk.P1.kids.includes(id), lit = st.flash[id] || st.glow;
        g.appendChild(ctx.box({ x: b.x, y: b.y, w: b.w, h: b.h, rx: 6, fill: V(c + "-soft"),
          stroke: lit ? V("ok") : orphan ? V("bad") : V(c), dashed: orphan && !lit, strokeWidth: st.flash[id] ? 2.6 : 1.6 }));
        const sx = b.x + geo.pad, sy = b.y + 5, sh = b.h - 10, sw = geo.slot;
        g.appendChild(s("rect", { x: sx, y: sy, width: 3 * sw, height: sh, rx: 3, fill: V("bg"), stroke: V("line"), "stroke-width": 1 }));
        [1, 2].forEach(i => g.appendChild(s("line", { x1: sx + i * sw, x2: sx + i * sw, y1: sy, y2: sy + sh,
          stroke: V("line"), "stroke-width": 1 })));
        pg.keys.forEach((k, i) => t(g, sx + i * sw + sw / 2, sy + sh / 2 + 0.5, String(k), { mono: true }));

        const tag = st.tags[id] || (st.flash[id] ? ["✓ written", "ok"] : orphan ? ["orphan", "bad"] : null);
        const lsnFill = st.tags[id] ? V(st.tags[id][1]) : V("muted");
        if (isRoot) {
          t(g, b.x - geo.gap, cy, id, { anchor: "end", weight: 700 });
          if (cfg.wal) t(g, b.x + b.w + geo.gap, cy, `LSN ${pg.lsn}`, { anchor: "start", fill: lsnFill, weight: st.tags[id] ? 700 : 400 });
          if (tag) pill(g, b.x + b.w + geo.tagDx, cy, tag[0], tag[1], "start");
        } else {
          const lbl = t(g, cx, geo.ly, "");   // page LSNs exist only when there is a log
          lbl.append(s("tspan", { "font-weight": 700 }, id),
            cfg.wal ? s("tspan", { fill: lsnFill, "font-weight": st.tags[id] ? 700 : 400 }, ` · LSN ${pg.lsn}`) : "");
          if (tag) pill(g, cx, geo.tagY, tag[0], tag[1]);
        }
      }

      function drawPool(g, st) {
        const P = G.pool;
        if (st.pending) t(g, P.x + P.w - 8, P.ty, "insert 45 pending", { anchor: "end", weight: 700, fill: V("warn") });
        if (!st.pool.length) {
          const msg = st.phase === "run" ? "empty" : st.phase === "crashed" ? "wiped by the power failure" : "empty after restart";
          t(g, P.x + P.w / 2, P.py + P.ph / 2, msg, { fill: V("muted") });
        }
        st.pool.forEach((e, i) => {
          const x = P.px[i], y = P.py, c = e.id === "P1" ? "c1" : "c2";
          const stroke = st.poolDead ? V("bad") : e.dirty ? V("warn") : V(c);
          g.appendChild(ctx.box({ x, y, w: P.pw, h: P.ph, rx: 6, fill: V(c + "-soft"), stroke, strokeWidth: e.dirty ? 2.2 : 1.5 }));
          t(g, x + 8, y + P.hy, e.name, { anchor: "start", weight: 700 });
          if (e.dirty) t(g, x + P.pw - 8, y + P.hy, "dirty", { anchor: "end", weight: 600, fill: V("warn") });
          t(g, x + P.pw / 2, y + P.ky, e.page.keys.join(" "), { mono: true });
        });
      }

      function walRow(g, r, state) {
        const { rowX: x, rowW: w, rowH: hh } = G.wal, tone = state === "written" ? "warn" : state ? "ok" : null;
        const grp = s("g", { opacity: tone ? 1 : 0.6 });
        grp.appendChild(s("rect", { x, y: r.y, width: w, height: hh, rx: 5, fill: tone ? V(tone + "-soft") : "none",
          stroke: tone ? V(tone) : V("line"), "stroke-width": tone ? 1.6 : 1 }));
        const ink = tone ? V("ink") : V("muted"), two = r.lines.length === 2, y0 = two ? r.y + 11 : r.y + hh / 2;
        t(grp, x + 8, y0, r.lines[0], { anchor: "start", mono: true, weight: two ? 700 : 400, fill: ink });
        if (two) t(grp, x + 8, r.y + 25, r.lines[1], { anchor: "start", mono: true, fill: ink });
        if (tone) t(grp, x + w - 8, y0, state === "written" ? "fsync…" : "fsync ✓", { anchor: "end", weight: 700, fill: V(tone) });
        g.appendChild(grp);
      }
      function drawWal(g, st) {
        G.wal.old.forEach(r => walRow(g, r, null));
        if (st.walRec) walRow(g, G.wal.next, st.walRec);
        G.wal.rules.forEach(([x, y, anchor], i) => t(g, x, y, RULES[i] + (st.rules[i] ? " ✓" : ""),
          { anchor, weight: st.rules[i] ? 700 : 400, fill: V(st.rules[i] ? "ok" : "muted") }));
      }

      function drawTray(g, st) {
        const lost = unreachable(st), orphan = orphans(st.disk).length > 0;
        let str, tone;
        if (!lost.length) [str, tone] = [`All ${st.committed.length} keys reachable`, "ok"];
        else if (cfg.wal) [str, tone] = [`Unreachable until redo: ${lost.join(", ")}`, "warn"];
        else [str, tone] = [`Unreachable: ${lost.join(", ")} ${orphan ? "(P5 is an orphan)" : "(no page on disk holds it)"}`, "bad"];
        t(g, G.tray[0], G.tray[1], str, { anchor: "start", size: G.trayFs, weight: 700, fill: V(tone) });
      }

      function updateStats(st) {
        const n = st.committed.length, r = st.committed.filter(k => reachable(st.disk, k)).length;
        const down = st.phase !== "run";
        stats.set("writes", st.split ? `${st.writes} of 3` : "0", st.writes === 3 ? "ok" : down ? (cfg.wal ? "warn" : "bad") : "");
        stats.set("client", CLIENT[st.client][0], CLIENT[st.client][2]);
        stats.set("keys", `${r} / ${n}`, r === n ? "ok" : down && !cfg.wal ? "bad" : "warn");
        stats.set("tree", ...treeStatus(st, cfg.wal));
      }

      // ---------- steps ----------
      async function writePage(st, id, redo) {
        const i = st.pool.findIndex(e => e.id === id);
        if (!redo) await fly(st, poolPos(i), pagePos(id), NAME[id], "warn");
        st.disk[id] = copy(SPLIT[id]);
        st.writes++;
        if (i >= 0) st.pool[i].dirty = false;
        st.flash[id] = true;
        render(st);
        await sleep(st, 550);
        delete st.flash[id];
        render(st);
      }

      async function powerFails(st) {
        const o = s("g", { opacity: 0 }), [bx, by, bs] = G.crash;
        o.appendChild(s("rect", { x: 0, y: 0, width: G.W, height: G.H, rx: 10, fill: V("bad-soft") }));
        view.L.overlay.appendChild(o);
        const label = ctx.attr(t(o, bx, by + 0.5, "POWER FAILURE", { size: bs, weight: 800, fill: V("bg") }), { "letter-spacing": 1 });
        const bw = (label.getComputedTextLength() || 130) + 28;
        o.insertBefore(s("rect", { x: bx - bw / 2, y: by - bs, width: bw, height: 2 * bs, rx: bs, fill: V("bad") }), label);
        await tween(st, 250, k => o.setAttribute("opacity", k));
        st.poolDead = true;
        render(st);
        await sleep(st, 450);
        await tween(st, 350, k => view.L.pool.setAttribute("opacity", 1 - k));
        Object.assign(st, { pool: [], poolDead: false, phase: "crashed", pending: false });
        if (cfg.wal) st.tray = true;
        else st.client = "noreply";
        render(st);
        view.L.pool.setAttribute("opacity", 1);
        await tween(st, 300, k => o.setAttribute("opacity", 1 - k));
        o.remove();
      }

      const stepInsert = () => ({
        title: "Client inserts key <b>45</b>. It belongs in leaf P3, which is full.",
        detail: "To find that leaf, the engine reads root P1 and then P3 from disk into the buffer pool.",
        run: async st => {
          st.client = "waiting";
          render(st);
          await fly(st, clientPos(), poolPos(1), "45", "c6");
          st.pending = true;
          render(st);
          for (const [i, id, c] of [[0, "P1", "c1"], [1, "P3", "c2"]]) {
            await fly(st, pagePos(id), poolPos(i), id, c, 550);
            st.pool.push({ id, name: id, page: copy(st.disk[id]), dirty: false });
            render(st);
          }
        },
      });

      const stepSplit = () => ({
        title: "In RAM, the engine splits P3: P3′ keeps [30 40], new page P5 gets [45 50], and parent P1 gains separator 45.",
        detail: "Nothing on disk has changed yet. The three dirty pages (amber) exist only in RAM.",
        run: async st => {
          Object.assign(st, { pending: false, split: true });
          st.pool[1] = { id: "P3", name: NAME.P3, page: copy(SPLIT.P3), dirty: true };
          st.pool[2] = { id: "P5", name: NAME.P5, page: copy(SPLIT.P5), dirty: true };
          render(st);
          await sleep(st, 450);
          st.pool[0] = { id: "P1", name: NAME.P1, page: copy(SPLIT.P1), dirty: true };
          render(st);
        },
      });

      const stepLog = () => ({
        title: "Before any page reaches disk, append one log record describing the whole change, then fsync it.",
        detail: "Simplified: real engines log each page change as its own record (plus a commit record); " +
          "one record stands for all of them here.",
        run: async st => {
          await fly(st, poolPos(1), walPos(), "LSN 100", "warn");
          st.walRec = "written";
          render(st);
          await sleep(st, 600);
          Object.assign(st, { walRec: "durable", rules: [true, false], committed: [...OLD_KEYS, 45].sort((a, b) => a - b) });
          render(st);
        },
      });

      const stepAck = () => ({
        title: "The change is now durable in the log, so the client is told <b>OK</b>.",
        detail: "Commit = the log record is on disk. Pages can be written later, in any order.",
        run: async st => {
          await fly(st, walPos(), clientPos(), "OK", "ok", 800);
          Object.assign(st, { client: "ok", rules: [true, true] });
          render(st);
        },
      });

      const WRITE_DETAIL = {
        P3: wal => (wal
          ? "Log before data: this write is allowed only because record 100 is already durable. " +
            "The tree on disk is now half-changed, just as without a log."
          : "P1 on disk still sends keys 30–59 to P3, but 50 has moved to P5, which exists only in RAM."),
        P5: () => "P5 is on disk now, but the parent on disk is still the old P1, so nothing points to P5: it is an orphan.",
      };
      const stepWrite = n => {
        const id = ORDER[n - 1];
        return {
          title: `Write ${NAME[id]} to disk (page write ${n} of 3).${cfg.wal && n === 1 ? " Its page LSN becomes 100." : ""}`,
          detail: WRITE_DETAIL[id](cfg.wal),
          run: st => writePage(st, id, false),
        };
      };

      const stepCrash = () => {
        const unwritten = ORDER.slice(cfg.after).map(id => NAME[id]).join(" and ");
        return {
          title: cfg.wal ? "Power fails. RAM is wiped." : "Power fails. RAM is wiped; the remaining page writes never happen.",
          detail: cfg.wal ? "The client was already told OK, so this insert must survive."
            : `${unwritten} existed only in RAM, so ${cfg.after === 1 ? "they are" : "it is"} gone.`,
          run: st => powerFails(st),
        };
      };

      const stepRestart = () => ({
        title: "Restart: the tree on disk is now wrong, and nothing on disk says so.",
        detail: "Key 50 was committed long before this insert. A multi-page change without a log is not atomic: " +
          "a crash between page writes corrupts old data, not just the write in flight.",
        run: async st => {
          st.phase = "restarted";
          render(st);
          await fly(st, clientPos(), pagePos("P1"), "get 50", "c6", 600);
          st.hot = "P3";
          render(st);
          await fly(st, [ptrX(1), G.root.y + G.root.h], pageTop("P3"), "50?", "c6", 450);
          Object.assign(st, { tray: true, tags: { P3: ["50: not found", "bad"] } });
          render(st);
        },
      });

      const stepRedo = () => {
        const skip = ORDER.slice(0, cfg.after).map(id => `${id}: ${LSN} ≥ ${LSN}, skip`);
        const redo = ORDER.slice(cfg.after).map(id => (id === "P5" ? "P5: not on disk, redo" : `P1: 80 < ${LSN}, redo`));
        return {
          title: "Restart: redo from the log. For each page the record touches, compare LSNs.",
          detail: `Page LSN vs record LSN ${LSN}. ${[...skip, ...redo].join(" · ")}.`,
          run: async st => {
            st.phase = "recovering";
            render(st);
            for (const id of ORDER) {
              const redoIt = needsRedo(st.disk, id);
              await fly(st, walPos(), pagePos(id), "100", "warn", 550);
              st.tags[id] = redoIt ? ["redo", "ok"] : ["skip", "muted"];
              if (redoIt) await writePage(st, id, true);
              else { render(st); await sleep(st, 350); }
            }
          },
        };
      };

      const stepRecovered = () => ({
        title: "Recovered: all 8 keys are reachable and the tree is consistent.",
        detail: "Page LSNs make redo idempotent, so even a crash during recovery is harmless. " +
          "A checkpoint later flushes dirty pages and lets old log segments be recycled.",
        run: st => { Object.assign(st, { phase: "recovered", tags: {}, glow: true }); render(st); },
      });

      function makeSteps() {
        const steps = [stepInsert(), stepSplit()];
        if (cfg.wal) steps.push(stepLog(), stepAck());
        for (let n = 1; n <= cfg.after; n++) steps.push(stepWrite(n));
        steps.push(stepCrash());
        steps.push(...(cfg.wal ? [stepRedo(), stepRecovered()] : [stepRestart()]));
        return steps;
      }

      function init(myGen) {
        Object.values(view.L).forEach(g => { if (g !== view.L.panels) g.replaceChildren(); });
        view.L.pool.setAttribute("opacity", 1);
        const st = {
          gen: myGen, disk: initialDisk(), pool: [], committed: OLD_KEYS.slice(), client: "idle", phase: "run",
          writes: 0, split: false, pending: false, walRec: null, rules: [false, false],
          tags: {}, flash: {}, hot: null, tray: false, glow: false, poolDead: false,
        };
        render(st);
        return st;
      }

      function build() {
        compact = ctx.compact;
        G = compact ? PHONE : DESK;
        const myGen = gen;
        const svg = ctx.svg({ w: G.W, h: G.H,
          label: "A client, the buffer pool in RAM, B-tree pages on disk and the write-ahead log during a page split" });
        const L = {};
        ["panels", "dyn", "pool", "packets", "overlay"].forEach(k => svg.appendChild((L[k] = s("g"))));
        view = { svg, L };
        drawPanels(L.panels);
        const steps = makeSteps();
        player = ctx.stepper({
          init: () => init(myGen), steps, delay: 1300, intro: INTRO,
          onStep: i => {
            const last = i === steps.length - 1;
            if (last) note.set(...(cfg.wal ? NOTE_ON : NOTE_OFF));
            note.style.display = last ? "" : "none";
          },
        });
        note.style.display = "none";
        stage.replaceChildren(svg, legend, player.el);
      }

      function restart(keepStep) {
        const idx = keepStep && player ? player.index : -1;
        gen++;
        if (player) player.pause();
        ctx.instant = true;   // finish the old script's in-flight tweens now; guard() parks its step
        build();
        const p = player;
        ctx.after(0, () => { ctx.instant = false; if (idx >= 0 && p === player) p.goto(idx); });
      }

      build();
      // Rebuild outside the ResizeObserver callback, keeping the current step.
      ctx.onResize(() => ctx.after(0, () => { if (ctx.compact !== compact) restart(true); }));
    },
  });
})();
