// LSM-tree sandbox (DDIA ch3, SSTables and LSM-trees). Writes go to a WAL and a sorted memtable,
// flush as immutable L0 SSTables and get compacted into one L1 run. Point reads go newest to
// oldest (key ranges and toy Bloom filters skip files); range scans merge every overlapping run.
// The reader can cause tombstone shadowing, false positives, write stalls and lost writes.
(function () {
  "use strict";

  const KEYS = "abcdefgh".split("");
  const MEM_CAP = 4, L0_COMPACT = 4, L0_STALL = 6;

  // ---------------- Pure model (no DOM) ----------------
  const fmt = e => e.key + ":" + (e.v === null ? "DEL" : e.v);
  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const parse = str => str.split(" ").map(p => { const [key, v] = p.split(":"); return { key, v: v === "DEL" ? null : +v }; });
  // FNV-1a plus murmur3's finalizer: plain FNV-1a's low bits barely mix, so "mod 16" would
  // give a ~40% false-positive rate instead of the ~15% this toy filter should have.
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }
  const bloomPos = (key, id, m) => [0, 1].map(i => hash(key + "#" + i + "#" + id) % m);
  // Tombstones go into the filter like live keys; otherwise a Get would skip the file that
  // holds the tombstone and resurrect an older value from a lower level.
  function makeTable(id, entries) {
    entries = entries.slice().sort(byKey);
    const m = Math.max(16, 4 * entries.length), bits = new Set();
    entries.forEach(e => bloomPos(e.key, id, m).forEach(p => bits.add(p)));
    return { id, entries, bloom: { m, bits }, min: entries[0].key, max: entries[entries.length - 1].key };
  }
  const mayContain = (t, key) => bloomPos(key, t.id, t.bloom.m).every(p => t.bloom.bits.has(p));
  const tablesOf = st => st.l0.concat(st.l1 ? [st.l1] : []);   // newest first
  const memEntries = st => [...st.mem].map(([key, v]) => ({ key, v })).sort(byKey);
  const nextVersion = (st, key) => (st.ver[key] || 0) + 1;

  function initialState() {
    const st = {
      mem: new Map([["c", 3], ["f", 2]]), wal: parse("c:3 f:2"),
      l0: [makeTable(3, parse("b:2 d:2 e:DEL h:3")), makeTable(2, parse("a:2 c:2 g:2 h:2"))],
      l1: makeTable(1, parse(KEYS.map(k => k + ":1").join(" "))),
      nextId: 4, ver: {}, userWrites: 0, diskWrites: 0, lastReads: null,
      bloomOn: true, autoCompact: true, walOn: true,
    };
    const seen = e => { if (e.v !== null) st.ver[e.key] = Math.max(st.ver[e.key] || 0, e.v); };
    tablesOf(st).forEach(t => t.entries.forEach(seen));
    st.wal.forEach(seen);
    return st;
  }
  function put(st, key, v) {   // v === null writes a tombstone
    st.userWrites++;
    if (st.walOn) { st.wal.push({ key, v }); st.diskWrites++; }
    st.mem.set(key, v);
    if (v !== null) st.ver[key] = Math.max(st.ver[key] || 0, v);
  }
  function flush(st) {
    const t = makeTable(st.nextId++, memEntries(st));
    st.l0.unshift(t);
    st.diskWrites += t.entries.length;
    st.mem = new Map();
    st.wal = [];   // those writes are durable in the SSTable now
    return t;
  }
  // Merge L0 (newest first) and L1: the first version of each key wins. L1 is the bottom level,
  // so a winning tombstone is dropped together with everything it shadows.
  function compactPlan(st) {
    const inputs = tablesOf(st), win = new Map(), losers = [];
    inputs.forEach(t => t.entries.forEach(e => {
      if (win.has(e.key)) losers.push({ id: t.id, key: e.key });
      else win.set(e.key, { e, from: t.id });
    }));
    const ws = [...win.values()], l1 = st.l1 ? st.l1.id : -1;
    const out = ws.filter(w => w.e.v !== null).map(w => w.e).sort(byKey);
    return {
      inputs, win, losers, out,
      tombs: ws.filter(w => w.e.v === null).map(w => ({ id: w.from, key: w.e.key })),
      entriesIn: inputs.reduce((n, t) => n + t.entries.length, 0),
      unchanged: out.filter(e => win.get(e.key).from === l1),
    };
  }
  function applyCompact(st, plan) {
    st.l0 = [];
    st.l1 = plan.out.length ? makeTable(st.nextId++, plan.out) : null;
    st.diskWrites += plan.out.length;
  }
  // Point read: memtable, then every table newest to oldest; stop at the first version found.
  function lookup(st, key) {
    if (st.mem.has(key)) return { steps: [{ at: "mem", kind: "hit" }], found: { v: st.mem.get(key), at: "mem" }, reads: 0 };
    const steps = [{ at: "mem", kind: "miss" }];
    let reads = 0;
    for (const t of tablesOf(st)) {
      if (key < t.min || key > t.max) { steps.push({ at: t.id, kind: "range" }); continue; }
      if (st.bloomOn && !mayContain(t, key)) { steps.push({ at: t.id, kind: "bf" }); continue; }
      reads++;
      const e = t.entries.find(x => x.key === key);
      if (e) {
        steps.push({ at: t.id, kind: e.v === null ? "del" : "found" });
        return { steps, found: { v: e.v, at: t.id }, reads };
      }
      steps.push({ at: t.id, kind: st.bloomOn ? "fp" : "miss" });
    }
    return { steps, found: null, reads };
  }
  // Range read: k-way merge of the memtable and every table whose key range overlaps [lo, hi].
  function scan(st, lo, hi) {
    const tags = {}, runs = [{ at: "mem", entries: memEntries(st) }];
    tablesOf(st).forEach(t => {
      tags[t.id] = t.max < lo || t.min > hi ? "skip" : "scan";
      if (tags[t.id] === "scan") runs.push({ at: t.id, entries: t.entries });
    });
    const win = new Map();
    runs.forEach(r => r.entries.forEach(e => {
      if (e.key >= lo && e.key <= hi && !win.has(e.key)) win.set(e.key, { v: e.v, at: r.at });
    }));
    const keys = [...win.keys()].sort();
    return {
      tags, win, reads: runs.length - 1,
      result: keys.filter(k => win.get(k).v !== null).map(k => ({ key: k, v: win.get(k).v })),
      hidden: keys.filter(k => win.get(k).v === null),
    };
  }
  // Crash: RAM is gone; the memtable is rebuilt by replaying the WAL in order.
  function crash(st) {
    const mem = new Map();
    st.wal.forEach(e => mem.set(e.key, e.v));
    return { mem, lost: memEntries(st).filter(e => !mem.has(e.key) || mem.get(e.key) !== e.v) };
  }
  function spaceAmp(st) {
    const seen = new Set();
    let entries = 0, live = 0;
    tablesOf(st).forEach(t => t.entries.forEach(e => {
      entries++;
      if (!seen.has(e.key)) { seen.add(e.key); if (e.v !== null) live++; }
    }));
    return { entries, live };
  }

  // ---------------- Layouts ----------------
  const center = r => [r.x + r.w / 2, r.y + r.h / 2];
  const DESK = {
    W: 640, H: 340, fs: 12, phone: false, client: [17, 46], ram: { x: 32, y: 4, w: 318, h: 96 },
    memTitle: [40, 20], memTag: [340, 16], mem: { x: 40, y: 28, w: 300, h: 58 },
    memSlot: i => ({ x: 48 + i * 72, y: 40, w: 66, h: 34 }), memFs: 13,
    walTitle: [360, 20], wal: { x: 360, y: 28, w: 268, h: 58 },
    walSlot: i => ({ x: 364 + i * 33, y: 40, w: 31, h: 34 }), walFs: 12, walMore: [364, 94, "start"],
    card: i => ({ x: 56 + i * 96, y: 118, w: 88, h: 118 }), head: 14, range: 30, row: r => 46 + r * 19, rowH: 17, tagY: 248,
    l1: { x: 56, y: 262, w: 572, h: 66 }, l1Head: [64, 276], l1Tag: [620, 276],
    l1Cell: i => ({ x: 60 + i * 70, y: 290, w: 66, h: 30 }), l1Fs: 13,
  };
  const PHONE = {
    W: 360, H: 382, fs: 11, phone: true, client: [14, 13], ram: { x: 2, y: 2, w: 356, h: 74 },
    memTitle: [28, 13], memTag: [352, 13], mem: { x: 8, y: 22, w: 344, h: 48 },
    memSlot: i => ({ x: 14 + i * 84, y: 31, w: 78, h: 30 }), memFs: 12,
    walTitle: [8, 98], wal: { x: 8, y: 106, w: 344, h: 42 },
    walSlot: i => ({ x: 13 + i * 42, y: 113, w: 38, h: 28 }), walFs: 11, walMore: [352, 98, "end"],
    card: i => ({ x: 8 + i * 58, y: 174, w: 54, h: 112 }), head: 14, range: 30, row: r => 50 + r * 16, rowH: 14, tagY: 298,
    l1: { x: 8, y: 312, w: 344, h: 64 }, l1Head: [14, 326], l1Tag: [346, 326],
    l1Cell: i => ({ x: 12 + i * 42, y: 338, w: 39, h: 28 }), l1Fs: 11,
  };
  // Probe tags: [desktop text, phone text, tone]
  const TAGS = {
    bf: ["BF: no", "no", "muted"], read: ["read", "read", "warn"], found: ["found", "hit", "ok"],
    fp: ["false +", "FP", "warn"], del: ["deleted", "DEL", "bad"], miss: ["miss", "miss", "warn"],
    range: ["range: no", "skip", "muted"], scan: ["scanned", "scan", "warn"], skip: ["skipped", "skip", "muted"],
  };
  const TONES = {   // [fill, stroke, text]
    plain: ["var(--viz-bg)", "var(--viz-line)", "var(--viz-ink)"],
    tomb: ["var(--viz-bad-soft)", "var(--viz-bad)", "var(--viz-bad)"],
    ok: ["var(--viz-ok-soft)", "var(--viz-ok)", "var(--viz-ink)"],
    bad: ["var(--viz-bad-soft)", "var(--viz-bad)", "var(--viz-bad)"],
    warn: ["var(--viz-warn-soft)", "var(--viz-warn)", "var(--viz-ink)"],
    info: ["var(--viz-info-soft)", "var(--viz-info)", "var(--viz-ink)"],
  };
  const plural = (n, w, many) => `${n} ${n === 1 ? w : many || w + "s"}`;
  const list = a => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
  const INITIAL_NOTE = "Writes land in the <b>memtable</b> (sorted, in RAM) and the <b>WAL</b> (append-only, for crash safety). " +
    "A full memtable becomes an immutable sorted <b>SSTable</b> in L0. Try <b>Get e</b>: the newest version is a tombstone " +
    "that hides the older e:1 in L1. Then pick key <b>g</b> and compare Get with Bloom filters on and off.";

  Viz.register("ch3/lsm-tree", {
    title: "LSM-tree write and read paths",
    model: { initialState, put, flush, compactPlan, applyCompact, lookup, scan, crash, spaceAmp, mayContain, tablesOf, nextVersion },
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      let st = initialState(), rng = ctx.random(42), key = "e", busy = false;
      let G = DESK, compact = null, view = null, refs = null, note = [INITIAL_NOTE, "info"];
      let marks = null;
      const counts = { flush: 0, compact: 0 };
      const clearMarks = () => { marks = { mem: { slots: {} }, t: {} }; };
      const tm = id => marks.t[id] || (marks.t[id] = { rows: {} });
      clearMarks();

      const T = (x, y, str, o = {}) => ctx.text(x, y, str, { size: G.fs, ...o });
      const muted = { fill: "var(--viz-muted)" };
      const say = (html, tone) => { note = [html, tone]; view.note.set(html, tone); };
      const sstName = id => (st.l1 && id === st.l1.id ? "L1" : "SST " + id);
      const stalled = () => st.l0.length >= L0_STALL && !st.autoCompact;

      // ---------- drawing ----------
      function cell(r, label, base, mark, fs, boxed) {
        const tone = mark && mark !== "dim" ? mark : base;
        const [fill, stroke, ink] = TONES[tone];
        const g = s("g", { opacity: mark === "dim" ? 0.3 : 1 });
        if (boxed || tone !== "plain") {
          g.append(s("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 4, fill, stroke: boxed || mark ? stroke : "none", "stroke-width": 1.2 }));
        }
        g.append(ctx.text(r.x + r.w / 2, r.y + r.h / 2 + 0.5, label, { size: fs, mono: true, fill: ink }));
        return g;
      }
      const emptySlot = r => s("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 4, fill: "none", stroke: "var(--viz-line)", "stroke-dasharray": "3 3" });
      function pill(layer, x, y, tag, anchor) {
        const [d, p, tone] = typeof tag === "string" ? TAGS[tag] : [tag.text, tag.text, tag.tone];
        const str = G.phone ? p : d, w = str.length * G.fs * 0.6 + 12, hh = G.fs + 7;
        const x0 = anchor === "end" ? x - w : x - w / 2, col = tone === "muted" ? "var(--viz-muted)" : `var(--viz-${tone})`;
        layer.append(
          s("rect", { x: x0, y: y - hh / 2, width: w, height: hh, rx: hh / 2, fill: tone === "muted" ? "var(--viz-bg)" : `var(--viz-${tone}-soft)`, stroke: col }),
          T(x0 + w / 2, y + 0.5, str, { weight: 700, fill: col }));
      }
      const rowRect = (box, r) => ({ x: box.x + 5, y: box.y + G.row(r) - G.rowH / 2, w: box.w - 10, h: G.rowH });

      function drawDecor(bg) {
        bg.append(s("rect", { x: G.ram.x, y: G.ram.y, width: G.ram.w, height: G.ram.h, rx: 10, fill: "var(--viz-grid)", opacity: 0.6 }));
        if (G.phone) {
          bg.append(s("line", { x1: 2, x2: 358, y1: 83, y2: 83, stroke: "var(--viz-line)", "stroke-dasharray": "4 4" }),
            T(352, 83, "RAM ▲   Disk ▼", { anchor: "end", halo: true, ...muted }),
            T(8, 164, "L0 · newest first →", { anchor: "start", weight: 700 }));
        } else {
          bg.append(s("path", { d: "M354,4 H636 V336 H4 V108 H354 Z", fill: "none", stroke: "var(--viz-line)", "stroke-dasharray": "4 4" }),
            T(344, 94, "RAM: lost on a crash", { anchor: "end", ...muted }),
            T(630, 94, "Disk: survives a crash", { anchor: "end", ...muted }),
            T(10, 150, "L0", { anchor: "start", size: 13, weight: 700 }),
            T(10, 168, "newest", { anchor: "start", ...muted }), T(10, 184, "first", { anchor: "start", ...muted }),
            T(10, 295, "L1", { anchor: "start", size: 13, weight: 700 }));
        }
        const [cx, cy] = G.client;
        bg.append(ctx.node({ x: cx, y: cy, r: G.phone ? 8 : 11, label: "C", size: G.fs, fill: "var(--viz-c6-soft)", stroke: "var(--viz-c6)" }));
      }

      function drawMem(layer) {
        const m = marks.mem, es = memEntries(st);
        layer.append(T(G.memTitle[0], G.memTitle[1], "Memtable (RAM, sorted)", { anchor: "start", weight: 700 }),
          ctx.box({ ...G.mem, fill: "var(--viz-c1-soft)", stroke: m.stroke ? "var(--viz-warn)" : "var(--viz-c1)", strokeWidth: m.stroke ? 2.5 : 1.5 }));
        for (let i = 0; i < MEM_CAP; i++) {
          const r = G.memSlot(i), e = es[i];
          layer.append(e ? cell(r, fmt(e), e.v === null ? "tomb" : "plain", m.slots[e.key], G.memFs, true) : emptySlot(r));
        }
        const tag = m.tag || (stalled() && { text: G.phone ? "stalled" : "writes stalled", tone: "bad" });
        if (tag) pill(layer, G.memTag[0], G.memTag[1], tag, "end");
      }

      function drawWal(layer) {
        const off = !st.walOn, shown = st.wal.slice(-8), more = st.wal.length - shown.length;
        layer.append(T(G.walTitle[0], G.walTitle[1], off ? "WAL (off: new writes skip it)" : "WAL (append-only log)",
          { anchor: "start", weight: 700, fill: off ? "var(--viz-warn)" : null }),
        ctx.box({ ...G.wal, fill: "var(--viz-c5-soft)", stroke: "var(--viz-c5)", dashed: off }));
        if (off && !shown.length) {
          layer.append(T(G.wal.x + G.wal.w / 2, G.wal.y + G.wal.h / 2, "WAL off: writes live only in RAM", muted));
          return;
        }
        for (let i = 0; i < 8; i++) {
          const e = shown[i], r = G.walSlot(i);
          // "c:DEL" doesn't fit a WAL slot, so a logged tombstone is written "c✕".
          layer.append(e ? cell(r, e.v === null ? e.key + "✕" : fmt(e), e.v === null ? "tomb" : "plain", null, G.walFs, true) : emptySlot(r));
        }
        if (more) layer.append(T(G.walMore[0], G.walMore[1], `+${more} earlier`, { anchor: G.walMore[2], ...muted }));
      }

      // One card per SSTable; cellRect(i) places entry i (rows on L0 cards, cells on the L1 card).
      function drawCard(layer, t, box, cellRect, boxed) {
        const m = marks.t[t.id] || { rows: {} }, stroke = m.stroke || (boxed || !stalled() ? null : "bad");
        const g = s("g", { opacity: m.opacity === undefined ? 1 : m.opacity });
        g.append(ctx.box({ ...box, fill: "var(--viz-c2-soft)", stroke: stroke ? `var(--viz-${stroke})` : "var(--viz-c2)", strokeWidth: stroke ? 2.5 : 1.5 }));
        t.entries.forEach((e, i) => {
          const r = cellRect(i), c = cell(r, fmt(e), e.v === null ? "tomb" : "plain", m.rows[e.key], boxed ? G.l1Fs : G.fs, boxed);
          g.append(c);
          refs.rows[t.id + "/" + e.key] = c;
          refs.pos[t.id + "/" + e.key] = center(r);
        });
        layer.append(g);
        refs.cards[t.id] = g;
        return { g, m };
      }

      function drawL0(layer) {
        for (let i = st.l0.length; i < L0_STALL; i++) {
          const r = G.card(i);
          layer.append(s("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 8, fill: "none", stroke: "var(--viz-line)", "stroke-dasharray": "4 4" }));
          const lines = i === L0_COMPACT - 1 ? [`${L0_COMPACT} files:`, st.autoCompact ? "compact" : "auto off"]
            : i === L0_STALL - 1 ? [`${L0_STALL} files:`, "stall"] : [];
          lines.forEach((str, j) => layer.append(T(r.x + r.w / 2, r.y + r.h / 2 + (j - 0.5) * (G.fs + 5), str, muted)));
        }
        st.l0.forEach((t, i) => {
          const box = G.card(i), cx = box.x + box.w / 2;
          const { g, m } = drawCard(layer, t, box, r => rowRect(box, r), false);
          g.append(T(cx, box.y + G.head, (G.phone ? "SST" : "SST ") + t.id, { weight: 700 }),
            T(cx, box.y + G.range, t.min + "–" + t.max, muted));
          if (m.tag) pill(g, cx, G.tagY, m.tag);
        });
      }

      function drawL1(layer) {
        const t = st.l1, box = G.l1;
        if (!t) return layer.append(T(box.x + box.w / 2, box.y + box.h / 2, "L1 is empty: every key was deleted", muted));
        const { g, m } = drawCard(layer, t, box, i => G.l1Cell(i), true);
        const head = G.phone ? `L1 · SST ${t.id} (one sorted run, ${t.min}–${t.max})` : `SST ${t.id} · L1 (one sorted run, ${t.min}–${t.max})`;
        g.append(T(G.l1Head[0], G.l1Head[1], head, { anchor: "start", weight: 700 }));
        if (m.tag) pill(g, G.l1Tag[0], G.l1Tag[1], m.tag, "end");
      }

      function render() {
        const layer = view.scene;
        layer.innerHTML = "";
        refs = { cards: {}, rows: {}, pos: {} };
        drawMem(layer); drawWal(layer); drawL1(layer); drawL0(layer);
      }

      // ---------- stats, caption, notes ----------
      function refreshInfo() {
        const S = view.stats, wa = st.userWrites ? st.diskWrites / st.userWrites : null, r = st.lastReads;
        S.set("uw", st.userWrites).set("dw", st.diskWrites);
        // Below 1x only when writes skipped the WAL and never reached disk: nothing to praise.
        S.set("wa", wa === null ? "–" : wa.toFixed(1) + "x", wa === null || wa < 1 ? "" : wa < 3 ? "ok" : wa < 6 ? "warn" : "bad");
        const unit = t => ` <span style="font-size:12px;font-weight:600">${t}</span>`;
        S.set("lr", r === null ? "–" : r + unit(r === 1 ? "disk read" : "disk reads"), r === null ? "" : r <= 1 ? "ok" : r === 2 ? "warn" : "bad");
        S.set("files", `${tablesOf(st).length} (L0: ${st.l0.length})`, st.l0.length >= L0_STALL ? "bad" : st.l0.length >= L0_COMPACT ? "warn" : "");
        const { entries, live } = spaceAmp(st), sa = live ? entries / live : null;
        S.set("sa", sa !== null ? sa.toFixed(1) + "x" : entries ? "∞" : "–", sa === null ? (entries ? "bad" : "") : sa < 1.5 ? "ok" : sa < 2.5 ? "warn" : "bad");
        view.caption.innerHTML = (st.bloomOn
          ? "Each SSTable has a Bloom filter (toy: 4 bits per key, ~15% false positives; real engines: ~10 bits per key, ~1%). "
          : "Bloom filters off: every file on a Get's path is read. ") +
          "Reads also skip files whose key range (under the file's name) can't hold the key. " +
          "Compaction starts at 4 L0 files; at 6, Puts and Flush stall until you Compact (toy values; RocksDB compacts at 4, slows writes at 20 and stops them at 36).";
        view.b.put.setLabel(`Put ${key}:${nextVersion(st, key)}`);
        view.b.del.setLabel(`Delete ${key}`);
        view.b.get.setLabel(`Get ${key}`);
      }

      const stallNote = () => `<b>Write stall</b>: ${st.l0.length} files waiting in L0 and auto-compaction is off; a Get may now read ` +
        `${tablesOf(st).length} files. RocksDB slows and then stops writes in this situation; engines that don't throttle just get ` +
        "slower until the disk fills. Puts <b>and Flush</b> are both blocked (a flush would add yet another L0 file), so the way out " +
        "is compaction: press <b>Compact</b> or turn auto-compact back on.";

      function putNote(e, prev) {
        const repl = prev === undefined || prev === e.v ? "" : ` (it replaced ${fmt({ key: e.key, v: prev })} in place: the memtable keeps one version per key)`;
        if (e.v === null) {
          return [`<b>Delete ${e.key}</b> wrote a tombstone, <b>${e.key}:DEL</b>${repl}: in an LSM-tree a delete is just another write. ` +
            `Older versions of ${e.key} stay in their files until compaction drops them.` + (st.walOn ? "" : " With the WAL off, it lives only in RAM."), st.walOn ? "info" : "warn"];
        }
        if (!st.walOn) return [`Put <b>${fmt(e)}</b> went only into the memtable${repl}: the WAL is off, so nothing reached disk and a crash before the next flush loses it.`, "warn"];
        return [`Put <b>${fmt(e)}</b>: one sequential WAL append plus an in-memory insert${repl}. No disk page was read or overwritten, which is why LSM writes are fast.`, "info"];
      }

      function getNote(k, res) {
        const f = res.found, of = kind => res.steps.filter(x => x.kind === kind).map(x => sstName(x.at));
        const cost = plural(res.reads, "disk read"), parts = [];
        if (f && f.at === "mem") {
          return f.v === null ? [`The memtable holds a tombstone for <b>${k}</b>, so the answer is 'not found' with zero disk reads.`, "info"]
            : [`Found <b>${fmt({ key: k, v: f.v })}</b> in the memtable: zero disk reads. Recent writes are the cheapest reads.`, "ok"];
        }
        const range = of("range"), bf = of("bf"), fp = of("fp");
        if (range.length) parts.push(`${list(range)} ${range.length === 1 ? "was" : "were"} skipped: ${k} is outside ${range.length === 1 ? "its key range" : "their key ranges"}.`);
        if (!st.bloomOn) parts.push(`Without Bloom filters every table whose range covers ${k} is read.`);
        else if (bf.length) parts.push(`Bloom filters ruled out ${list(bf)} without touching disk.`);
        if (f && f.v === null) {
          const later = tablesOf(st).slice(tablesOf(st).findIndex(t => t.id === f.at) + 1);
          const older = later.find(t => t.entries.some(e => e.key === k));
          const oe = older && older.entries.find(e => e.key === k);
          parts.push(`${sstName(f.at)} holds a tombstone for <b>${k}</b>, so the answer is 'not found' (${cost}). The search stops there` +
            (oe ? `; the older ${fmt(oe)} in ${sstName(older.id)} is never consulted.` : "."));
        } else if (f) parts.push(`${sstName(f.at)} had <b>${fmt({ key: k, v: f.v })}</b>, so this Get cost ${cost}.`);
        else parts.push(`No file has ${k}, so the answer is 'not found' after ${cost}.`);
        if (fp.length) parts.push(fp.length === 1 ? `${fp[0]}'s filter gave a false positive: one wasted read, never a wrong answer.`
          : `${list(fp)} gave false positives: wasted reads, never a wrong answer.`);
        if (!st.bloomOn && res.reads >= 2) parts.push("Lookups for keys that don't exist are the worst case: one read per table.");
        return [parts.join(" "), f && f.v === null ? "info" : res.reads <= 1 ? "ok" : "warn"];
      }

      function compactNote(plan) {
        const files = plural(plan.inputs.length, "file"), out = plan.out.length;
        if (!out) return `Merged ${files} (${plan.entriesIn} entries): every key's newest version was a tombstone, so everything was dropped and L1 is now empty.`;
        const dropped = [];
        if (plan.losers.length) dropped.push(plural(plan.losers.length, "superseded version"));
        if (plan.tombs.length) dropped.push(plural(plan.tombs.length, "tombstone") + " (safe at the bottom level)");
        const u = plan.unchanged;
        return `Merged ${files} (${plan.entriesIn} entries) into one sorted run of ${out}. ` +
          (dropped.length ? `Dropped ${dropped.join(" and ")}. ` : "Nothing was superseded. ") +
          (u.length ? `It wrote ${plural(out, "entry", "entries")}, and ${u.length} of them (${u.map(fmt).join(", ")}) ${u.length === 1 ? "was" : "were"} ` +
            "copied from L1 unchanged: rewriting data that didn't change is where LSM write amplification comes from."
            : `It wrote ${plural(out, "entry", "entries")}: every compaction rewrites its inputs, which is where LSM write amplification comes from.`);
      }

      // ---------- actions ----------
      function setBusy(on) {
        busy = on;
        Object.values(view.b).forEach(b => b.disable(on));
        Object.values(view.tg).forEach(t => { t.querySelector("input").disabled = on; });
      }
      async function run(fn) {
        if (busy) return;
        setBusy(true);
        try { await fn(); } finally { if (ctx.alive) { setBusy(false); refreshInfo(); } }
      }

      async function putKey(k, v, ms = 450) {
        clearMarks(); render();
        if (stalled()) { say(stallNote(), "bad"); return false; }
        const e = { key: k, v }, prev = st.mem.has(k) ? st.mem.get(k) : undefined;
        const slot = [...new Set([...st.mem.keys(), k])].sort().indexOf(k);
        const go = to => ctx.fly(view.packets, { from: G.client, to, label: fmt(e), labelSize: G.fs, fill: "var(--viz-c6)", ms });
        await Promise.all([go(center(G.memSlot(slot))), st.walOn && go(center(G.walSlot(Math.min(st.wal.length, 7))))]);
        put(st, k, v);
        marks.mem.slots[k] = "ok";
        render(); refreshInfo();
        say(...putNote(e, prev));
        if (st.mem.size >= MEM_CAP) { await ctx.sleep(400); await flushMem(fmt(e)); }
        return true;
      }

      async function flushMem(by) {
        if (st.l0.length >= L0_STALL) return say(stallNote(), "bad");
        if (!st.mem.size) return say("The memtable is empty: nothing to flush.", "info");
        clearMarks(); render();
        const cards = st.l0.map(t => refs.cards[t.id]), dx = G.card(1).x - G.card(0).x, box = G.card(0);
        await Promise.all([
          ctx.tween({ ms: 300, onUpdate: k => cards.forEach(g => g.setAttribute("transform", `translate(${k * dx},0)`)) }),
          ...memEntries(st).map((e, r) => ctx.fly(view.packets, { from: center(G.memSlot(r)), to: center(rowRect(box, r)), fill: "var(--viz-c1)", r: 6, ms: 400 })),
        ]);
        const t = flush(st);
        counts.flush++;
        tm(t.id).stroke = "ok";
        render(); refreshInfo();
        say((by ? `Put ${by} filled the memtable to ${MEM_CAP} keys, so it was flushed` : "The memtable was flushed") +
          ` as <b>SST ${t.id}</b>, an immutable sorted file in L0; the WAL was truncated because those writes are now durable in an SSTable.` +
          (st.autoCompact || st.l0.length < 2 ? "" : ` L0 now holds ${st.l0.length} files, and a Get may have to check every one.`),
        st.l0.length >= L0_STALL ? "warn" : "info");
        if (st.autoCompact && st.l0.length >= L0_COMPACT) {
          await ctx.sleep(600);
          await compactAll(`That made ${st.l0.length} files in L0, so compaction ran. `);
        }
      }

      async function compactAll(prefix) {
        if (!st.l0.length) return say("Nothing in L0 to compact.", "info");
        const plan = compactPlan(st), doomed = plan.losers.concat(plan.tombs);
        say(`Compacting: merging ${plural(plan.inputs.length, "file")} like mergesort, newest first. For each key the first version ` +
          "found wins; the older versions it supersedes (red) are dropped, and so are tombstones, since L1 is the bottom level.", "info");
        clearMarks();
        plan.inputs.forEach(t => { tm(t.id).stroke = "warn"; });
        render(); await ctx.sleep(300);
        doomed.forEach(d => { tm(d.id).rows[d.key] = "bad"; });
        render();
        const els = doomed.map(d => refs.rows[d.id + "/" + d.key]);
        await ctx.tween({ ms: 400, onUpdate: k => els.forEach(el => el.setAttribute("opacity", 1 - k)) });
        // Every winner, including the unchanged ones from L1, is rewritten into the new run.
        const cards = plan.inputs.map(t => refs.cards[t.id]);
        await Promise.all([
          ctx.tween({ ms: 450, onUpdate: k => cards.forEach(g => g.setAttribute("opacity", 1 - k)) }),
          ...plan.out.map((e, i) => ctx.fly(view.packets, { from: refs.pos[plan.win.get(e.key).from + "/" + e.key], to: center(G.l1Cell(i)), fill: "var(--viz-c2)", r: 6, ms: 550 })),
        ]);
        applyCompact(st, plan);
        counts.compact++;
        clearMarks();
        if (st.l1) {   // fade the new run in; unchanged entries that were rewritten anyway stay amber
          const m = tm(st.l1.id);
          plan.unchanged.forEach(e => { m.rows[e.key] = "warn"; });
          m.tag = { text: `wrote ${plan.out.length}`, tone: "ok" };
          m.opacity = 0;
          render();
          const g = refs.cards[st.l1.id];
          await ctx.tween({ ms: 400, onUpdate: k => g.setAttribute("opacity", k) });
          delete m.opacity;
        } else render();
        refreshInfo();
        say(prefix + compactNote(plan), "ok");
      }

      async function getKey() {
        const k = key, res = lookup(st, k);
        clearMarks(); marks.mem.stroke = "warn"; render();
        await ctx.sleep(350);
        const show = (m, stroke, tag, ms) => { m.stroke = stroke; m.tag = tag; render(); return ctx.sleep(ms); };
        let reads = 0;
        for (const step of res.steps) {
          if (step.at === "mem") {
            const del = step.kind === "hit" && res.found.v === null;
            if (step.kind === "hit") marks.mem.slots[k] = del ? "bad" : "ok";
            await show(marks.mem, null, step.kind === "miss" ? { text: "miss", tone: "muted" } : del ? "del" : "found", 0);
            continue;
          }
          const m = tm(step.at);
          if (step.kind === "range") { await show(m, null, "range", 250); continue; }
          if (st.bloomOn) await show(m, "c2", null, 200);   // probe the filter: 0 disk reads
          if (step.kind === "bf") { await show(m, null, "bf", 200); continue; }
          st.lastReads = ++reads;
          refreshInfo();
          await show(m, "warn", "read", 350);
          if (step.kind === "found" || step.kind === "del") m.rows[k] = step.kind === "found" ? "ok" : "bad";
          await show(m, null, step.kind, 150);
        }
        st.lastReads = res.reads;
        say(...getNote(k, res));
      }

      async function scanRange() {
        const r = scan(st, "c", "f"), inR = k => k >= "c" && k <= "f";
        clearMarks();
        memEntries(st).forEach(e => { if (inR(e.key)) marks.mem.slots[e.key] = "info"; });
        marks.mem.tag = { text: "scanned", tone: "info" };
        const scanned = tablesOf(st).filter(t => r.tags[t.id] === "scan");
        tablesOf(st).forEach(t => { tm(t.id).tag = r.tags[t.id]; });
        scanned.forEach(t => t.entries.forEach(e => { if (inR(e.key)) tm(t.id).rows[e.key] = "info"; }));
        render();
        await ctx.sleep(700);
        // Merge newest-first: the first version of each key wins, older ones are shadowed.
        const winTone = w => (w.v === null ? "bad" : "ok");
        r.win.forEach((w, k) => { if (w.at === "mem") marks.mem.slots[k] = winTone(w); });
        scanned.forEach(t => t.entries.forEach(e => {
          if (inR(e.key)) tm(t.id).rows[e.key] = r.win.get(e.key).at === t.id ? winTone(r.win.get(e.key)) : "dim";
        }));
        st.lastReads = r.reads;
        render();
        const skipped = tablesOf(st).filter(t => r.tags[t.id] === "skip").map(t => sstName(t.id));
        say(`Scan c–f read ${plural(r.reads, "SSTable")}` +
          (skipped.length ? ` (${list(skipped)} skipped: key range doesn't overlap c–f)` : "") +
          ` plus the memtable and merged them newest-first: <b>${r.result.map(fmt).join(", ") || "nothing"}</b>` +
          (r.hidden.length ? ` (${list(r.hidden)} ${r.hidden.length === 1 ? "is" : "are"} deleted)` : "") +
          ". Bloom filters can't help a range; only the files' key ranges can rule a file out. More sorted runs = slower scans.",
        r.reads >= 3 ? "warn" : "ok");
      }

      async function putRandom() {
        counts.flush = counts.compact = 0;
        const done = [];
        for (let i = 0; i < 8; i++) {
          const k = rng.pick(KEYS), v = nextVersion(st, k);
          if (!(await putKey(k, v, 320))) return;   // write stall: putKey explained it
          done.push(fmt({ key: k, v }));
          await ctx.sleep(250);
        }
        const wa = (st.diskWrites / st.userWrites).toFixed(1);
        say(`Put x8 random wrote ${done.join(", ")}. That caused ${plural(counts.flush, "flush", "flushes")} and ` +
          `${plural(counts.compact, "compaction")}; Write amp is now <b>${wa}x</b>.`, "info");
      }

      async function crashNow() {
        const plan = crash(st), wal = st.wal.slice(), hadMem = st.mem.size > 0;
        clearMarks();
        st.mem.forEach((v, k) => { marks.mem.slots[k] = "bad"; });
        render(); await ctx.sleep(350);
        st.mem = new Map(); marks.mem.slots = {};
        render();
        say("Power failure: everything in RAM is gone. On restart the engine replays the WAL from disk, in order, to rebuild the memtable.", "bad");
        const { x, y, w, h: hh } = G.ram, [cx, cy] = center(G.ram);
        const flash = s("g", null, s("rect", { x, y, width: w, height: hh, rx: 10, fill: "var(--viz-bad-soft)", stroke: "var(--viz-bad)" }),
          T(cx, cy, "power failure", { size: G.phone ? 12 : 14, weight: 700, fill: "var(--viz-bad)", halo: true }));
        view.fx.append(flash);
        await ctx.sleep(600);
        flash.remove();
        const first = wal.length - Math.min(wal.length, 8), ms = Math.max(120, Math.min(300, 2400 / Math.max(1, wal.length)));
        for (let i = 0; i < wal.length; i++) {
          const e = wal[i], slot = [...new Set([...st.mem.keys(), e.key])].sort().indexOf(e.key);
          await ctx.fly(view.packets, { from: center(G.walSlot(Math.max(0, i - first))), to: center(G.memSlot(slot)), label: fmt(e), labelSize: G.fs, fill: "var(--viz-c5)", ms });
          st.mem.set(e.key, e.v);
          marks.mem.slots = { [e.key]: "ok" };
          render();
        }
        st.mem = plan.mem;
        marks.mem.slots = {};
        if (hadMem) marks.mem.tag = plan.lost.length ? { text: `lost ${plan.lost.length}`, tone: "bad" } : { text: "restored", tone: "ok" };
        render();
        if (!hadMem) return say("Power failure: RAM was wiped, but the memtable was empty, so nothing was lost.", "ok");
        if (!plan.lost.length) {
          return say(`The memtable was lost, but every write had hit the WAL first: replayed ${plural(wal.length, "entry", "entries")} and lost nothing that was acknowledged.`, "ok");
        }
        const k = plan.lost[0].key, now = lookup(st, k).found;
        say(`Lost ${plural(plan.lost.length, "acknowledged write")} (${plan.lost.map(fmt).join(", ")}): they lived only in RAM. ` +
          `Get ${k} now returns ${now && now.v !== null ? "the older " + fmt({ key: k, v: now.v }) : "'not found'"}.`, "bad");
      }

      function reset() {
        st = initialState(); rng = ctx.random(42);
        Object.values(view.tg).forEach(t => t.set(true));
        clearMarks(); render();
        say(INITIAL_NOTE, "info");
      }

      function setBloom(on) {
        st.bloomOn = on;
        clearMarks(); render(); refreshInfo();
        say(on ? "Bloom filters on: a Get skips any file whose filter says the key is definitely not there."
          : `Bloom filters off: a Get now reads every file whose key range covers the key, until it finds the key. Try <b>Get ${key}</b>.`, "info");
      }
      function setAuto(on) {
        st.autoCompact = on;
        if (on && st.l0.length >= L0_COMPACT) {
          return run(() => compactAll(`Auto-compaction is back on and L0 had ${st.l0.length} files, so it ran at once. `));
        }
        clearMarks(); render(); refreshInfo();
        say(on ? `Auto-compaction on: once L0 reaches ${L0_COMPACT} files they're merged into L1.`
          : "Compaction paused. Writes now pay only the WAL and the flush (Write amp stops climbing), but every flush adds an L0 file " +
            "that reads must check and that holds duplicate versions (watch Last read and Space amp). That's the LSM trade-off: pay in " +
            "write amplification now, or in read and space amplification later.", on ? "ok" : "warn");
      }
      function setWal(on) {
        st.walOn = on;
        clearMarks(); render();
        say(on ? "WAL on: every new write is appended to the log on disk before it's acknowledged, so a crash can replay it."
          : "WAL off: new writes go only to the memtable in RAM; entries already logged stay. Make a few Puts, then press <b>Crash</b>.", on ? "ok" : "warn");
      }

      // ---------- build (re-run when crossing the phone breakpoint) ----------
      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        G = compact ? PHONE : DESK;
        const btn = (label, fn, kind) => ui.button(label, () => run(fn), { kind });
        const keySel = ui.select({ label: "Key", options: KEYS, value: key, onChange: v => { key = v; refreshInfo(); } });
        const b = {
          put: btn("Put", () => putKey(key, nextVersion(st, key)), "primary"),
          del: btn("Delete", () => putKey(key, null)),
          get: btn("Get", getKey, "ok"),
          scan: btn("Scan c–f", scanRange, "ghost"),
          rand: btn("Put x8 random", putRandom, "ghost"),
          flush: btn("Flush", () => flushMem(null)),
          compact: btn("Compact", () => compactAll("")),
          crash: btn("Crash", crashNow, "danger"),
          reset: btn("Reset", reset, "ghost"),
        };
        const tg = {
          bloom: ui.toggle({ label: "Bloom filters", value: st.bloomOn, onChange: setBloom }),
          auto: ui.toggle({ label: "Auto-compact", value: st.autoCompact, onChange: setAuto }),
          wal: ui.toggle({ label: "WAL", value: st.walOn, onChange: setWal }),
        };
        const svg = ctx.svg({ w: G.W, h: G.H, label: "LSM-tree: memtable and WAL, L0 SSTables newest first, one L1 run" });
        const bg = s("g"), scene = s("g"), fx = s("g"), packets = s("g");
        svg.append(bg, scene, fx, packets);
        const stats = ui.stats([
          { key: "uw", label: "User writes" }, { key: "dw", label: "Disk writes" }, { key: "wa", label: "Write amp" },
          { key: "lr", label: "Last read" }, { key: "files", label: "Files" }, { key: "sa", label: "Space amp" },
        ]);
        const legend = ui.legend([
          { color: "var(--viz-c6)", label: "client write", shape: "dot" },
          { color: "var(--viz-c1)", label: "memtable", shape: "square" },
          { color: "var(--viz-c5)", label: "WAL", shape: "square" },
          { color: "var(--viz-c2)", label: "SSTable", shape: "square" },
          { color: "var(--viz-bad)", label: "tombstone", shape: "square" },
        ]);
        const caption = h("div", { class: "muted", style: "font-size:12px;line-height:1.45;margin:2px 0 10px" });
        view = { scene, fx, packets, stats, caption, b, tg, note: ui.note(...note) };
        root.append(ui.bar(keySel, b.put, b.del, b.get, b.scan, b.rand), ui.bar(b.flush, b.compact, b.crash, b.reset, tg.bloom, tg.auto, tg.wal),
          svg, legend, caption, view.note, stats);
        drawDecor(bg);
        setBusy(busy);
        render(); refreshInfo();
      }

      build();
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
