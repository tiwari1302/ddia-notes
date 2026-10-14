// SSI, catching stale premises: DDIA's on-call doctors (T42 = Alice, T43 = Bob, shift 1234)
// under snapshot isolation vs. serializable snapshot isolation (PostgreSQL SERIALIZABLE).
// A pure model (row versions, snapshots, SIREAD marks, ignored writes, rw edges) is changed by
// read / write / commit / rollback ops and the scene is redrawn from it, so stepper Back,
// free-play Undo and phone/desktop switches all replay exactly. The commit rule follows DDIA
// (check at commit); step details note where real PostgreSQL may fail earlier.
(function () {
  "use strict";
  const DOC = { 42: "Alice", 43: "Bob" }, OTHER = { 42: 43, 43: 42 }, COLOR = { 42: "c6", 43: "c5" };
  const V = n => `var(--viz-${n})`;
  const pick = (v, e) => (v && typeof v === "object" ? v[e] : v);

  // ---------- model ----------
  const newTx = (id, ro) => ({ id, ro, attempt: 1, pc: 0, last: -1, status: "idle", snap: null, snap0: null,
    n: null, wrote: false, decision: null, flags: [], check: null });
  const newModel = (ssi, ro43) => ({ ssi, tx: { 42: newTx(42, false), 43: newTx(43, !!ro43) },
    versions: [], marks: [], edges: [], ignored: [], flash: null, aborts: 0, waits: 0, actor: null, released: null, log: [] });
  const isDone = T => T.status === "committed" || T.status === "rolledback";
  const onCall = m => 2 - m.versions.filter(v => v.st === "committed").length;
  const addEdge = (m, from, to) => {
    if (!m.edges.some(e => e.live && e.from === from && e.to === to)) m.edges.push({ from, to, live: true });
  };
  // u's SIREAD mark still matters to t's write unless u committed before t took its snapshot.
  const overlaps = (m, t, u) => !(m.tx[u].status === "committed" && m.tx[t].snap.includes(u));
  function release(m, t) {   // an ended attempt's SIREAD marks and rw edges are discarded
    m.marks.forEach(k => { if (k.t === t) k.live = false; });
    m.edges.forEach(e => { if (e.from === t || e.to === t) e.live = false; });
    m.released = t;
  }
  const OPS = {
    b(m, t) { m.tx[t].status = "running"; m.actor = null; return []; },   // BEGIN; the snapshot comes later
    r(m, t) {   // first statement: take the snapshot, count on-call doctors
      const T = m.tx[t], ev = [];
      if (T.status === "aborted") Object.assign(T, { attempt: T.attempt + 1, status: "retry", flags: [], check: null, wrote: false, decision: null });
      else T.status = "running";
      T.snap = [42, 43].filter(u => m.tx[u].status === "committed");
      if (T.attempt === 1) T.snap0 = T.snap;
      Object.assign(T, { n: 2, pc: 1, last: 0 });
      m.versions.forEach((v, i) => {
        if (v.st === "committed" && T.snap.includes(v.by)) T.n--;
        else if (v.st === "pending" && v.by !== t && m.ssi) {   // MVCC skips it; SSI remembers that
          m.ignored.push({ reader: t, attempt: T.attempt, v: i });
          T.flags.push({ kind: "ignored", v: i });
          addEdge(m, t, v.by);
        }
      });
      if (m.ssi) m.marks.push({ t, attempt: T.attempt, live: true });
      m.log.push({ t, text: `${T.attempt > 1 ? "retry read" : "read"} ${T.n}` });
      return ev;
    },
    w(m, t) {   // decide on the premise; write own row if at least 2 are on call
      const T = m.tx[t], ev = [];
      Object.assign(T, { pc: 2, last: 1, decision: T.ro ? "report" : T.n >= 2 ? "off" : "stay" });
      m.log.push({ t, text: { off: "UPDATE", stay: "stays", report: "report" }[T.decision] });
      if (T.decision !== "off") return ev;
      T.wrote = true;
      // A write waits only for another transaction's uncommitted write to the same row. SIREAD
      // marks never block, and each doctor updates only their own row, so this stays 0 here.
      if (m.versions.some(v => v.st === "pending" && v.by !== t && v.row === DOC[t])) m.waits++;
      const v = m.versions.push({ by: t, row: DOC[t], st: "pending" }) - 1;
      ev.push({ type: "write", v });
      if (m.ssi) m.marks.forEach((k, i) => {   // tripwire: notify every concurrent reader
        if (!k.live || k.t === t || !overlaps(m, t, k.t)) return;
        addEdge(m, k.t, t);
        m.tx[k.t].flags.push({ kind: "notified", v });
        m.flash = { reader: k.t, mark: i };
        ev.push({ type: "trip", reader: k.t, v, mark: i });
      });
      return ev;
    },
    c(m, t) {
      const T = m.tx[t], u = OTHER[t], U = m.tx[u];
      Object.assign(T, { pc: 3, last: 2 });
      const ign = m.ignored.find(r => r.reader === t && r.attempt === T.attempt);
      // DDIA's check: a committed, overlapping transaction wrote data this writer read.
      const stale = m.ssi && T.wrote && U.status === "committed" && !T.snap.includes(u) &&
        m.versions.some(v => v.by === u && v.st === "committed");
      T.check = !m.ssi ? ["SI check: same row", "written? no → commit", "muted"]
        : stale ? (ign ? ["check: a write I ignored", "has committed → abort ✗", "bad"] : [`check: T${u} committed a`, "write I read → abort ✗", "bad"])
        : !T.wrote ? ["check: wrote nothing,", "so it can commit ✓", "ok"]
        : ign && m.versions[ign.v].st === "aborted" ? ["check: ignored write was", "rolled back → commit ✓", "ok"]
        : ["check: did any premise", "change? no → commit ✓", "ok"];
      m.versions.forEach(v => { if (v.by === t && v.st === "pending") v.st = stale ? "aborted" : "committed"; });
      if (stale) { T.status = "aborted"; m.aborts++; release(m, t); } else T.status = "committed";
      m.log.push({ t, text: stale ? "ABORT 40001" : "COMMIT", tone: stale ? "bad" : null });
      return [];
    },
    x(m, t) {   // voluntary ROLLBACK
      Object.assign(m.tx[t], { pc: 3, last: 2, status: "rolledback" });
      m.versions.forEach(v => { if (v.by === t) v.st = "aborted"; });
      release(m, t);
      m.log.push({ t, text: "ROLLBACK", tone: "bad" });
      return [];
    },
  };
  function apply(m, op) {
    m.flash = null;
    m.actor = +op.slice(1);
    return OPS[op[0]](m, m.actor);
  }
  const nextOp = (m, t) => { const T = m.tx[t]; return isDone(T) ? null : T.status === "aborted" ? "r" : "rwc"[T.pc]; };

  // ---------- scripts ----------
  const BEGIN = "T42 (Alice) and T43 (Bob) begin; the committed data shows <b>2 on call</b>. Each takes its snapshot at its first statement.";
  const SCRIPTS = {
    war: [
      { ops: "b42 b43", t: BEGIN },
      { ops: "r42", t: { ssi: "T42 reads: <b>2 on call</b>. SSI records a SIREAD mark for T42 on the shift 1234 index entry.", si: "T42 reads: <b>2 on call</b>." } },
      { ops: "r43", t: { ssi: "T43 reads: <b>2 on call</b>. Mark for T43 too. Nothing has blocked anyone.", si: "T43 reads: <b>2 on call</b>. Nothing has blocked anyone." } },
      { ops: "w42", t: { ssi: "T42 updates Alice to off call. SSI sees that T43 read this data and notifies T43: its premise may be stale. No waiting, no abort yet.", si: "T42 updates Alice to off call. Nothing records that T43 read this data." },
        d: { ssi: "A SIREAD mark is a tripwire, not a lock: the write goes ahead at once." } },
      { ops: "w43", t: { ssi: "T43 updates Bob to off call; T42 read that too, so T42 is notified as well (rw edges both ways).", si: "T43 updates Bob to off call: a different row from T42's, so there is no write-write conflict." } },
      { ops: "c42", t: { ssi: "T42 commits first. Nothing it read has been changed by a committed transaction, so it succeeds.", si: "T42 commits." },
        d: { ssi: "T43's write is still uncommitted and might never commit, so it doesn't count against T42." } },
      { ops: "c43", t: { ssi: "T43 tries to commit, but a committed concurrent transaction (T42) overwrote data T43 read: <b>ERROR 40001</b> could not serialize access. T43 is aborted.", si: "T43 commits; SI sees no write-write conflict." },
        d: { ssi: "SSI waited until COMMIT, the first moment it knew the premise really went stale. (Real PostgreSQL may raise 40001 at an earlier statement.)", si: "The two writes touch different rows, so first-committer-wins has nothing to catch." } },
      { ops: { ssi: "r43 w43 c43", si: "" }, t: { ssi: "The app retries T43 with a fresh snapshot: <b>1 on call</b>, so Bob can't leave. Invariant holds.", si: "Result: <b>0 on call</b>." },
        d: { si: "Write skew: each decision rested on a count that the other transaction made false." } },
    ],
    stale: [
      { ops: "b42 b43", t: BEGIN },
      { ops: "r42 w42", t: { ssi: "T42 reads 2 and updates Alice to off call (uncommitted). SIREAD mark for T42.", si: "T42 reads 2 and updates Alice to off call (uncommitted)." } },
      { ops: "r43", t: { ssi: "T43 reads: MVCC ignores T42's uncommitted write, so <b>2 on call</b>. SSI records that T43 ignored a write by T42.", si: "T43 reads: MVCC ignores T42's uncommitted write, so <b>2 on call</b>." },
        d: { ssi: "The write came before the read, so there was no mark to trip. The ignored-write record catches this case instead." } },
      { ops: "c42", t: { ssi: "T42 commits. T43's read is now stale, but SSI doesn't abort T43 yet.", si: "T42 commits." },
        d: { ssi: "If T43 turns out to be read-only, a stale read is harmless, so SSI waits." } },
      { ops: "w43", t: { ssi: "T43 updates Bob to off call. T42 read Bob's row too, so this trips T42's SIREAD mark, which SSI keeps after T42's commit because T43 overlaps it.", si: "T43 updates Bob to off call." } },
      { ops: "c43", t: { ssi: "T43 commit check: a write T43 ignored has now committed, so its read was stale: <b>abort (40001)</b>.", si: "T43 commits; SI sees no write-write conflict." },
        d: { ssi: "This follows DDIA's commit-time description; real PostgreSQL may already raise the error at T43's UPDATE, so apps must be ready to retry at any statement." } },
      { ops: { ssi: "r43 w43 c43", si: "" }, t: { ssi: "Retry: <b>1 on call</b>, so Bob stays.", si: "Result: <b>0 on call</b>." } },
    ],
    ro: [
      { ops: "b42 b43", t: "T42 (Alice) and T43 begin. T43 is a read-only report: how many doctors are on call?" },
      { ops: "r43", t: { ssi: "T43 reads: <b>2 on call</b> (SIREAD mark).", si: "T43 reads: <b>2 on call</b>." } },
      { ops: "r42 w42", t: { ssi: "T42 reads, then updates Alice to off call. Tripwire: T43's read is now outdated.", si: "T42 reads, then updates Alice to off call." } },
      { ops: "c42", t: "T42 commits." },
      { ops: "w43 c43", t: { ssi: "T43 commits successfully: it wrote nothing, so it can be ordered before T42, and its stale-but-consistent view is serializable.", si: "T43 commits." },
        d: { ssi: "Aborting T43 the moment its read went stale would have been wasted work. This is why SSI checks at commit." } },
      { ops: "", t: "Result: <b>1 on call</b>; 0 aborts.",
        d: { ssi: "With three or more transactions PostgreSQL can occasionally abort a read-only one; <code>READ ONLY DEFERRABLE</code> avoids that." } },
    ],
    wa: [
      { ops: "b42 b43", t: BEGIN },
      { ops: "r42 w42", t: "T42 reads and updates Alice to off call (uncommitted)." },
      { ops: "r43", t: { ssi: "T43 reads: it ignores T42's uncommitted write and sees <b>2 on call</b>. SSI records the ignored write.", si: "T43 reads: MVCC ignores T42's uncommitted write, so it sees <b>2 on call</b>." } },
      { ops: "x42", t: "Alice changes her mind: T42 <b>ROLLBACK</b>.", d: { ssi: "T42's SIREAD mark and its rw edge are discarded with it." } },
      { ops: "w43 c43", t: { ssi: "T43 updates Bob to off call and commits: the write it ignored never committed, so its premise was true.", si: "T43 updates Bob to off call and commits." } },
      { ops: "", t: "Result: <b>1 on call</b> (Alice), 0 aborts." },
    ],
  };
  const INTRO = {
    war: { ssi: "Same doctors race, now with SSI watching. Nobody ever waits; watch where the abort happens.",
      si: "Same doctors race under plain snapshot isolation. Nobody waits, and nothing checks whether a premise went stale." },
    stale: "This time T42 writes <b>before</b> T43 reads, so T43's snapshot skips an uncommitted write. Was T43's read stale?",
    ro: "T43 is a read-only report this time. Its read will go stale: does that matter?",
    wa: "T42 writes, then changes its mind. T43's read skipped that write: was it really stale?",
    free: "You are the scheduler: click the two buttons in any order. Each transaction reads the count, decides, then commits.",
  };
  const FINAL = {
    war: { ssi: ["Both ran freely; at commit, T43's premise (2 on call) had been invalidated by T42's committed write, so T43 was aborted and its retry saw the truth.", "ok"],
      si: ["Snapshot isolation sees two writes to different rows and commits both: <b>write skew</b>.", "bad"] },
    stale: { ssi: ["T43 read around T42's uncommitted write. Once T42 committed, that read was stale, so T43 couldn't commit.", "ok"],
      si: ["Snapshot isolation never asks whether T43's read went stale: both commit and <b>nobody is on call</b>.", "bad"] },
    ro: { ssi: ["Here the stale read is harmless: T43 wrote nothing, so it can be placed before T42 in the serial order. No abort.", "ok"],
      si: ["SI also gets this one right: T43 only reported a count. SSI matches it without an extra abort.", "ok"] },
    wa: { ssi: ["The write T43 ignored never committed, so its read was right after all. Aborting at read time would have been a false alarm.", "ok"],
      si: ["SI also gets this one right: T42 rolled back, so Alice is still on call. SSI matches it without a false alarm.", "ok"] },
  };

  // ---------- layouts ----------
  const CHIP_W = 62;
  const LAYOUTS = {
    desk: { W: 640, H: 344, Hsi: 262, short: false,
      banner: { x: 180, y: 8, w: 280, h: 28 },
      card: { 42: { x: 8, y: 46 }, 43: { x: 448, y: 46 }, w: 184, h: 206, head: 18, pill: 40, stmt: [66, 86, 106], read: 132, flag: 152, check: [176, 192] },
      table: { x: 212, w: 216, title: 56, rows: { 42: [66, 92], 43: [122, 148] }, rh: 22, indent: 16 },
      index: { x: 212, y: 180, w: 216, h: 70 },
      graph: { y: 306, x: [272, 368], title: { x: 236, y: [290, 306, 322], anchor: "end", lines: ["rw edges", "A → B: A read", "what B overwrote"] }, status: { x: 404, y: [298, 314, 330] } },
      siNote: { x: 320, y: [196, 214, 232, 250] },
    },
    phone: { W: 360, H: 548, Hsi: 448, short: true,
      banner: { x: 50, y: 6, w: 260, h: 28 },
      card: { 42: { x: 8, y: 44 }, 43: { x: 184, y: 44 }, w: 168, h: 184, head: 16, pill: 36, stmt: [58, 76, 94], read: 116, flag: 134, check: [156, 172] },
      table: { x: 8, w: 344, title: 244, rows: { 42: [254, 278], 43: [306, 330] }, rh: 22, indent: 16 },
      index: { x: 8, y: 364, w: 344, h: 70 },
      graph: { y: 500, x: [60, 160], title: { x: 8, y: [452], anchor: "start", lines: ["rw edges (A → B: A read what B overwrote)"] }, status: { x: 204, y: [484, 500, 516] } },
      siNote: { x: 180, y: [380, 398, 416, 434] },
    },
  };
  const PILL = { idle: ["not started", "muted"], running: ["running", "info"], retry: ["retry", "info"],
    committed: ["committed", "ok"], aborted: ["ABORTED 40001", "bad"], rolledback: ["rolled back", "bad"] };

  Viz.register("ch7/ssi-detector", {
    title: "SSI: catching stale premises",
    model: { newModel, apply, nextOp, onCall, SCRIPTS, pick },   // exposed for offline tests
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      const cfg = { engine: "ssi", scn: "war" };
      let compact = ctx.compact, player = null, cur = null, freeHist = [];

      // ---------- controls and panels ----------
      const engineSeg = ui.segmented({ label: "Engine", value: cfg.engine,
        options: [{ value: "si", label: "Snapshot isolation" }, { value: "ssi", label: "SSI (PostgreSQL SERIALIZABLE)" }],
        onChange: v => { cfg.engine = v; restart(); } });
      const scnSeg = ui.segmented({ label: "Scenario", value: cfg.scn,
        options: [{ value: "war", label: "Write after read" }, { value: "stale", label: "Stale read" }, { value: "ro", label: "Read-only reader" },
          { value: "wa", label: "Writer aborts" }, { value: "free", label: "You schedule it" }],
        onChange: v => { cfg.scn = v; freeHist = []; restart(); } });
      const stage = h("div"), slot = h("div"), note = ui.note("");
      const legend = ui.legend([
        { color: V("c6"), label: "T42 (Alice)" }, { color: V("c5"), label: "T43 (Bob)" },
        { color: V("c1"), label: "SIREAD mark", shape: "square" },
        { color: V("warn"), label: "ignored write / tripwire", shape: "dash" },
        { color: V("bad"), label: "abort / violation", shape: "square" },
      ]);
      const stats = ui.stats([
        { key: "oncall", label: "On call (committed)" }, { key: "aborts", label: "Aborts" },
        { key: "waits", label: "Lock waits" }, { key: "marks", label: "SIREAD marks" },
      ]);
      root.append(ui.bar(engineSeg, scnSeg), stage, legend, slot, note, stats);
      const intro = () => pick(INTRO[cfg.scn], cfg.engine);

      // ---------- drawing helpers ----------
      const txt = (g, x, y, str, o) => g.appendChild(ctx.text(x, y, str, { size: 12, anchor: "start", ...o }));
      const width = (el, str) => { try { return el.getComputedTextLength() || str.length * 6.4; } catch (e) { return str.length * 6.4; } };
      const strike = (g, el, str, x, y, color) => g.appendChild(s("line", { x1: x - 2, x2: x + width(el, str) + 2, y1: y, y2: y, stroke: color, "stroke-width": 1.5 }));
      function pill(g, x, y, [label, tone]) {
        const w = label.length * 7 + 16, mu = tone === "muted";
        g.appendChild(s("rect", { x, y: y - 10, width: w, height: 20, rx: 10, fill: V(mu ? "node" : tone + "-soft"), stroke: V(mu ? "line" : tone), "stroke-width": 1.2 }));
        g.appendChild(ctx.text(x + w / 2, y + 1, label, { size: 12, weight: 700, fill: V(mu ? "muted" : tone) }));
      }
      function swoosh(g, svg, [x1, y1], [x2, y2], color) {   // dashed S-curve with an arrowhead
        const xm = (x1 + x2) / 2;
        g.appendChild(s("path", { d: `M${x1},${y1} C${xm},${y1} ${xm},${y2} ${x2},${y2}`, fill: "none", stroke: color,
          "stroke-width": 1.8, "stroke-dasharray": "5 4", "marker-end": svg.arrow(color) }));
      }
      const chipX = (L, i) => L.index.x + 8 + i * (CHIP_W + 5);
      const P = {   // anchor points for packets and arrows
        table: L => [L.table.x + L.table.w / 2, (L.table.rows[42][0] + L.table.rows[43][1] + L.table.rh) / 2],
        card: (L, t, key) => [L.card[t].x + L.card.w / 2, L.card[t].y + (key === "read" ? L.card.read : key === "flag" ? L.card.flag : L.card.stmt[1])],
        cardEdge: (L, t) => [t === 42 ? L.card[42].x + L.card.w : L.card[43].x, L.card[t].y + L.card.flag],
        version: (L, by) => [L.table.x + L.table.indent + (L.table.w - L.table.indent) / 2, L.table.rows[by][1] + L.table.rh / 2],
        chip: (L, i) => [chipX(L, i) + CHIP_W / 2, L.index.y + 35],
      };

      function stmtText(T, i, short) {
        const name = DOC[T.id];
        if (i === 0) return T.n === null ? "SELECT count(*)" : short ? `SELECT … → ${T.n}` : `SELECT count(*) → ${T.n}`;
        if (i === 1) {
          if (T.ro) return "report the count";
          if (T.decision === "off") return short ? "UPDATE → off" : `UPDATE ${name} → off`;
          if (T.decision === "stay") return short ? `n=${T.n}: stay` : `n=${T.n}: stay on call`;
          return short ? "if ≥2: UPDATE" : `if ≥2: UPDATE ${name}`;
        }
        return { rolledback: "ROLLBACK", aborted: "COMMIT ✗ 40001", committed: "COMMIT ✓" }[T.status] || "COMMIT";
      }
      function flagText(m, f, short) {
        const v = m.versions[f.v], w = `T${v.by}`;
        if (v.st === "aborted") return [`✓ ${w}'s write undone`, "muted"];
        const label = f.kind === "ignored" ? `⚠ ignored ${w}'s write` : short ? `⚠ notified by ${w}` : `⚠ notified by ${w}'s write`;
        return [label, v.st === "committed" ? "bad" : "warn"];
      }

      function drawCard(st, t) {
        const { L, m, main } = st, C = L.card, { x, y } = C[t], T = m.tx[t], c = COLOR[t], g = s("g");
        main.appendChild(g);
        g.appendChild(ctx.box({ x, y, w: C.w, h: C.h, rx: 10, fill: V("node"), stroke: V(c), strokeWidth: m.actor === t ? 2.6 : 1.3 }));
        txt(g, x + 10, y + C.head, `T${t} · ${T.ro ? "report" : DOC[t]}`, { size: 13, weight: 700, fill: V(c) });
        const [pl, tone] = PILL[T.status];
        pill(g, x + 10, y + C.pill, [T.status === "committed" && T.attempt > 1 ? "committed (retry)" : pl, tone]);
        const next = isDone(T) ? -1 : T.status === "aborted" ? 0 : T.pc;
        C.stmt.forEach((sy, i) => {
          if (m.actor === t && T.last === i) g.appendChild(s("rect", { x: x + 4, y: y + sy - 10, width: C.w - 8, height: 20, rx: 4, fill: V(c + "-soft") }));
          if (i === next) txt(g, x + 9, y + sy, "▸", { weight: 700, fill: V(c) });
          const bad = i === 2 && (T.status === "aborted" || T.status === "rolledback");
          txt(g, x + 22, y + sy, stmtText(T, i, L.short), { mono: true, fill: V(bad ? "bad" : i <= T.last ? "ink" : "muted"), weight: bad ? 700 : null });
        });
        txt(g, x + 10, y + C.read, T.n === null ? "read: –" : `${T.attempt > 1 ? "retry read" : "read"}: ${T.n} on call`, { weight: 700, fill: V(T.n === null ? "muted" : "ink") });
        const [ft, tn] = T.flags.length ? flagText(m, T.flags[T.flags.length - 1], L.short) : T.attempt > 1 ? ["1st try: ABORTED 40001", "bad"] : [];
        if (ft) txt(g, x + 10, y + C.flag, ft, { weight: 600, fill: V(tn) });
        if (T.check) C.check.forEach((cy, i) => txt(g, x + 10, y + cy, T.check[i], { fill: V(T.check[2]), weight: i ? 700 : null }));
      }

      function drawTable(st) {
        const { L, m, main } = st, T = L.table, g = s("g");
        main.appendChild(g);
        txt(g, T.x, T.title, "doctors · shift 1234", { weight: 700, fill: V("muted") });
        const row = (x, y, w, label, status, tone, dead) => {
          const soft = tone === "node" ? "node" : tone + "-soft", line = tone === "node" ? "node-stroke" : tone;
          g.appendChild(ctx.box({ x, y, w, h: T.rh, rx: 5, fill: V(soft), stroke: V(line), strokeWidth: 1.2, dashed: dead }));
          const cy = y + T.rh / 2 + 1, el = txt(g, x + 8, cy, label, { fill: V(dead || status === "old" ? "muted" : "ink") });
          if (dead) strike(g, el, label, x + 8, cy, V("bad"));
          if (status) g.appendChild(ctx.text(x + w - 8, cy, status, { size: 12, anchor: "end", fill: V(tone === "node" ? "muted" : tone), weight: tone === "node" ? null : 600 }));
        };
        [42, 43].forEach(t => {
          const [y1, y2] = T.rows[t], vi = m.versions.findIndex(v => v.by === t), v = m.versions[vi];
          row(T.x, y1, T.w, `${DOC[t]}: on call (v1)`, v && v.st === "committed" ? "old" : "", "node");
          if (!v) return;
          g.appendChild(s("path", { d: `M${T.x + 8},${y1 + T.rh} V${y2 + T.rh / 2} H${T.x + T.indent}`, fill: "none", stroke: V("line"), "stroke-width": 1.2 }));
          const tone = { pending: "warn", committed: "ok", aborted: "bad" }[v.st];
          let status = { pending: "uncommitted", committed: "committed", aborted: m.tx[t].status === "rolledback" ? "rolled back" : "aborted" }[v.st];
          const ig = m.ignored.find(r => r.v === vi && r.attempt === m.tx[r.reader].attempt);
          if (L.short && ig && v.st === "pending") status += ` · ignored by T${ig.reader}`;
          row(T.x + T.indent, y2, T.w - T.indent, `${DOC[t]}: off (by T${t})`, status, tone, v.st === "aborted");
        });
      }

      function drawIndex(st) {
        const { L, m, main } = st, I = L.index, g = s("g");
        main.appendChild(g);
        g.appendChild(ctx.box({ ...I, rx: 8, fill: V("c1-soft"), stroke: V("c1"), strokeWidth: 1.3 }));
        st.wire = g.appendChild(s("g"));   // the tripwire arrow runs under the chips, not through their labels
        txt(g, I.x + 10, I.y + 14, "SIREAD marks on shift = 1234", { weight: 700 });
        if (!m.marks.length) txt(g, I.x + 10, I.y + 35, "(none yet: nobody has read)", { fill: V("muted") });
        m.marks.forEach((k, i) => {
          const x = chipX(L, i), tripped = m.flash && m.flash.mark === i, cg = s("g", { opacity: k.live ? 1 : 0.45 });
          g.appendChild(cg);
          cg.appendChild(ctx.box({ x, y: I.y + 24, w: CHIP_W, h: 22, rx: 11, fill: V(tripped ? "warn-soft" : "bg"), stroke: V(tripped ? "warn" : "c1"), strokeWidth: tripped ? 2.2 : 1.2 }));
          const label = `T${k.t} ${k.attempt > 1 ? "retry" : "read"}`;
          cg.appendChild(ctx.text(x + CHIP_W / 2, I.y + 36, label, { size: 12, weight: 600 }));
          if (!k.live) cg.appendChild(s("line", { x1: x + 6, x2: x + CHIP_W - 6, y1: I.y + 36, y2: I.y + 36, stroke: V("muted"), "stroke-width": 1.5 }));
        });
        if (m.flash) txt(g, I.x + 10, I.y + 59, `notify T${m.flash.reader}: premise may be stale`, { weight: 700, fill: V("warn") });
      }

      function graphStatus(m) {
        const live = m.edges.filter(e => e.live);
        if (live.length === 2) return [["both ways: a cycle,", "so no serial order", "fits both"], "bad"];
        if (live.length === 1) { const { from: a, to: b } = live[0]; return [[`only T${a} → T${b}: same`, `as running T${a} first`], "warn"]; }
        if (m.edges.length) {
          const t = m.released, how = m.tx[t].status === "rolledback" ? "rolled back" : "aborted";
          return [[`T${t} ${how}, so its`, `edge${m.edges.length > 1 ? "s are" : " is"} dropped`], "muted"];
        }
        return [["no rw edges yet"], "muted"];
      }
      function drawGraph(st) {
        const { L, m, main, svg } = st, G = L.graph, [x1, x2] = G.x, y = G.y, g = s("g");
        main.appendChild(g);
        G.title.lines.forEach((ln, i) => txt(g, G.title.x, G.title.y[i], ln, { anchor: G.title.anchor, weight: i ? null : 700, fill: V(i ? "muted" : "ink") }));
        [[42, 43, -1], [43, 42, 1]].forEach(([a, b, dir]) => {
          const es = m.edges.filter(e => e.from === a && e.to === b), e = es.find(e => e.live) || es[0];
          if (!e) return;
          const xa = a === 42 ? x1 : x2, xb = a === 42 ? x2 : x1, sg = Math.sign(xb - xa), color = V(e.live ? "warn" : "muted");
          g.appendChild(s("path", { d: `M${xa + sg * 11},${y + dir * 10} Q${(x1 + x2) / 2},${y + dir * 40} ${xb - sg * 11},${y + dir * 10}`,
            fill: "none", stroke: color, "stroke-width": 1.8, "stroke-dasharray": e.live ? null : "4 4", "marker-end": svg.arrow(color) }));
          g.appendChild(ctx.text((x1 + x2) / 2, y + dir * 25, "rw", { size: 12, weight: 700, fill: color, halo: true }));
        });
        [42, 43].forEach((t, i) => g.appendChild(ctx.node({ x: G.x[i], y, r: 15, label: `T${t}`, size: 12, fill: V(COLOR[t] + "-soft"), stroke: V(COLOR[t]) })));
        const [lines, tone] = graphStatus(m);
        lines.forEach((ln, i) => txt(g, G.status.x, G.status.y[i], ln, { weight: i ? null : 700, fill: V(tone === "muted" ? "muted" : tone) }));
      }

      function drawArrows(st) {   // desktop only: ignored writes and this step's tripwire
        const { L, m, over, svg } = st;
        m.ignored.forEach(r => {
          if (r.attempt !== m.tx[r.reader].attempt) return;
          const v = m.versions[r.v], [vx, vy] = P.version(L, v.by), half = (L.table.w - L.table.indent) / 2;
          const color = V({ pending: "warn", committed: "bad", aborted: "muted" }[v.st]);
          swoosh(over, svg, [r.reader === 43 ? vx + half : vx - half, vy], P.cardEdge(L, r.reader), color);
        });
        if (m.flash) {
          const [cx, cy] = P.chip(L, m.flash.mark), side = m.flash.reader === 43 ? 1 : -1;
          swoosh(st.wire || over, svg, [cx + side * CHIP_W / 2, cy], P.cardEdge(L, m.flash.reader), V("warn"));
        }
      }

      function render(st) {
        const { L, m, main, over } = st, n = onCall(m);
        main.replaceChildren();
        over.replaceChildren();
        const b = L.banner, ok = n >= 1;
        main.appendChild(ctx.box({ ...b, rx: 14, fill: V(ok ? "ok-soft" : "bad-soft"), stroke: V(ok ? "ok" : "bad"), strokeWidth: ok ? 1.3 : 2.2 }));
        const bt = main.appendChild(ctx.text(b.x + b.w / 2, b.y + b.h / 2 + 1, "", { size: 14, weight: 700 }));
        bt.append(s("tspan", { fill: V(ok ? "ok" : "bad") }, `On call: ${n} ${ok ? "✓" : "✗"}`),
          s("tspan", { fill: V(ok ? "muted" : "bad"), "font-size": 12, "font-weight": ok ? 400 : 700 }, ok ? "   committed · need ≥ 1" : "   nobody on call!"));
        [42, 43].forEach(t => drawCard(st, t));
        drawTable(st);
        if (m.ssi) {
          drawIndex(st);
          drawGraph(st);
          if (!L.short) drawArrows(st);
        } else {
          ["Snapshot isolation keeps no", "record of reads: it only stops", "two writes to the same row.", "Nothing notices a stale premise."].forEach((ln, i) =>
            main.appendChild(ctx.text(L.siNote.x, L.siNote.y[i], ln, { size: 12, fill: V("muted") })));
        }
        stats.set("oncall", String(n), ok ? "ok" : "bad");
        stats.set("aborts", String(m.aborts), m.aborts ? "warn" : "");
        stats.set("waits", String(m.waits), m.waits ? "warn" : "info");
        stats.set("marks", m.ssi ? String(m.marks.length) : "–", "");
      }

      // ---------- running ops (with packets) ----------
      // A state is current until fresh() replaces it; a stale step's awaits park forever.
      const guard = (st, p) => p.then(v => (st === cur ? v : new Promise(() => {})));
      const fly = (st, from, to, label, c, ms = 600) => ctx.fly(st.pk, { from, to, label, fill: V(c), ms, labelSize: 12 });
      async function perform(st, op, anim) {
        const ev = apply(st.m, op), t = st.m.actor, L = st.L;
        if (anim && op[0] === "r") await guard(st, fly(st, P.table(L), P.card(L, t, "read"), `${st.m.tx[t].n} on call`, COLOR[t]));
        const w = ev.find(e => e.type === "write");
        if (anim && w) await guard(st, fly(st, P.card(L, t, "stmt"), P.version(L, t), "off", COLOR[t], 500));
        render(st);
        for (const e of anim ? ev.filter(e => e.type === "trip") : []) {
          await guard(st, fly(st, P.version(L, t), P.chip(L, e.mark), "tripwire", "warn", 450));
          await guard(st, fly(st, P.chip(L, e.mark), P.card(L, e.reader, "flag"), "notify", "warn", 450));
        }
        return ev;
      }

      // ---------- scenario mode ----------
      function buildStepper(fresh) {
        const e = cfg.engine, scn = cfg.scn, last = SCRIPTS[scn].length - 1;
        const steps = SCRIPTS[scn].map(sp => {
          const ops = (pick(sp.ops, e) || "").split(" ").filter(Boolean);
          return { title: pick(sp.t, e), detail: pick(sp.d, e), run: async st => {
            if (!ops.length) { st.m.actor = null; st.m.flash = null; render(st); }
            for (const op of ops) await perform(st, op, true);
          } };
        });
        player = ctx.stepper({
          steps, delay: 1800, intro: "Press <b>Play</b> or <b>Step ▶</b> to run the schedule one statement at a time.",
          init() { const st = fresh(); render(st); return st; },
          onStep: i => note.set(...(i === last ? FINAL[scn][e] : [intro(), "info"])),
        });
        note.set(intro(), "info");
        slot.replaceChildren(player.el);
      }

      // ---------- free play ("You schedule it") ----------
      function opNote(m, op) {
        const t = +op.slice(1), u = OTHER[t], T = m.tx[t], name = DOC[t];
        if (op[0] === "r") {
          const skipped = m.versions.some(v => v.by === u && v.st === "pending");
          return [`T${t} ${T.attempt > 1 ? "retried with a fresh snapshot and " : ""}read <b>${T.n} on call</b>` +
            (T.snap.includes(u) ? ` (its snapshot includes T${u}'s commit).` : ".") +
            (m.ssi ? " SSI put a SIREAD mark on shift 1234." : "") +
            (skipped ? ` MVCC skipped T${u}'s uncommitted write${m.ssi ? "; SSI noted that it did" : ""}.` : ""), "info"];
        }
        if (op[0] === "w") {
          if (T.decision === "stay") return [`T${t} saw only ${T.n} on call, so ${name} stays. No write.`, "info"];
          const trip = m.flash !== null, late = m.tx[u].status === "committed";
          return [`T${t} saw ${T.n}, so ${name} goes off call (uncommitted).` + (!trip ? ""
            : late ? ` The write trips T${u}'s SIREAD mark, kept after T${u}'s commit because the two overlapped: SSI records an rw edge. Nobody waits.`
            : ` The write trips T${u}'s SIREAD mark: T${u} is notified that its premise may be stale. Nobody waits.`), trip ? "warn" : "info"];
        }
        if (T.status === "aborted") return [`T${t}'s COMMIT failed with <b>40001</b>: T${u} had committed a write to data T${t} read. Step T${t} again to retry.`, "warn"];
        return [`T${t} committed.` + (m.ssi && T.wrote ? " No committed write had changed its premise." : ""), "ok"];
      }
      function verdict(m) {
        const a = m.tx[42], b = m.tx[43];
        if (a.snap0.includes(43) || b.snap0.includes(42)) return ["They didn't overlap, so there was nothing to check: the second transaction's read already saw the first one's change. No abort.", "ok"];
        if (!m.ssi) return ["Both premises were stale and both committed: <b>0 on call</b>.", "bad"];
        return ["The second committer's premise had been invalidated by the first committer, so it was aborted; its retry saw <b>1 on call</b>.", "ok"];
      }
      function opLabel(m, t, op) {
        const T = m.tx[t];
        if (!op) return "done";
        if (op === "r") return T.status === "aborted" ? "retry: read" : "read";
        if (op === "w") return T.n >= 2 ? `UPDATE ${DOC[t]} → off` : "stay on call";
        return "COMMIT";
      }
      const schedule = m => (m.log.length ? "<b>Schedule:</b> " + m.log.map(e =>
        `<span style="color:${V(e.tone || COLOR[e.t])};font-weight:600;white-space:nowrap">T${e.t} ${e.text}</span>`).join(" → ")
        : '<span class="muted">Schedule: nothing yet. Pick who goes first.</span>');

      function buildFree(fresh) {
        player = null;
        let st = null, busy = false;
        const btn = t => { const el = ui.button("", () => click(t), { kind: "primary" }); el.style.boxShadow = `inset 5px 0 0 ${V(COLOR[t])}`; return el; };
        const b = { 42: btn(42), 43: btn(43) };
        const undo = ui.button("↩ Undo", () => replay(freeHist.slice(0, -1)), { kind: "ghost" });
        const reset = ui.button("⟲ Reset", () => replay([]), { kind: "ghost" });
        const sched = h("div", { style: "font-size:13px;line-height:1.7;margin-top:8px" });
        slot.replaceChildren(h("div", { class: "viz-stepper" }, ui.bar(b[42], b[43], undo, reset), sched,
          h("div", { class: "muted", style: "font-size:12.5px;margin-top:6px" },
            "Challenge: under SSI, get both doctors off call. Under SI, find a schedule that keeps one on call.")));
        function refresh(msg) {
          [42, 43].forEach(t => { const op = nextOp(st.m, t); b[t].setLabel(`T${t} (${DOC[t]}): ${opLabel(st.m, t, op)}`).disable(busy || !op); });
          undo.disable(busy || !freeHist.length);
          reset.disable(!freeHist.length);
          sched.innerHTML = schedule(st.m);
          if (msg) note.set(...msg);
        }
        const msgAfter = (m, op) => ([42, 43].every(t => isDone(m.tx[t])) ? verdict(m) : opNote(m, op));
        async function click(t) {
          const op = nextOp(st.m, t), mine = st;
          if (busy || !op) return;
          busy = true;
          freeHist.push(t);
          refresh();
          await perform(st, op + t, true);
          if (mine !== st) return;
          busy = false;
          refresh(msgAfter(st.m, op + t));
        }
        // Undo/Reset/engine switch: rebuild and replay the clicks instantly (dropping any that no longer apply).
        function replay(list) {
          st = fresh();
          busy = false;
          let lastOp = null;
          freeHist = list.filter(t => { const op = nextOp(st.m, t); if (op) apply(st.m, (lastOp = op + t)); return !!op; });
          render(st);
          refresh(lastOp ? msgAfter(st.m, lastOp) : [INTRO.free, "info"]);
        }
        replay(freeHist);
      }

      // ---------- assembly ----------
      function build() {
        compact = ctx.compact;
        const L = LAYOUTS[compact ? "phone" : "desk"];
        const svg = ctx.svg({ w: L.W, h: cfg.engine === "ssi" ? L.H : L.Hsi, label: "Two transactions, T42 for Alice and T43 for Bob, next to the doctors table and SSI's read tracking" });
        const layers = { main: s("g"), over: s("g"), pk: s("g") };
        svg.append(layers.main, layers.over, layers.pk);
        stage.replaceChildren(svg);
        [2, 3].forEach(i => { legend.children[i].style.display = cfg.engine === "ssi" ? "" : "none"; });   // SSI-only keys
        const fresh = () => {
          layers.pk.replaceChildren();
          cur = { L, svg, ...layers, m: newModel(cfg.engine === "ssi", cfg.scn === "ro") };
          return cur;
        };
        if (cfg.scn === "free") buildFree(fresh); else buildStepper(fresh);
      }
      function restart(keepStep) {
        const idx = keepStep && player ? player.index : -1;
        if (player) player.pause();
        ctx.instant = true;   // finish in-flight tweens now; guard() parks the old steps
        build();
        const p = player;
        ctx.after(0, () => { ctx.instant = false; if (idx >= 0 && p && p === player) p.goto(idx); });
      }
      build();
      ctx.onResize(() => ctx.after(0, () => { if (ctx.compact !== compact) restart(true); }));
    },
  });
})();
