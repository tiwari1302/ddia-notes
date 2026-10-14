// Two-phase locking and the phantom booking. Alice (T1) and Bob (T2) each run "SELECT bookings
// overlapping 12:00-13:00; if none, INSERT one; COMMIT". The reader picks how the database locks
// (row locks only, index-range locks, or a whole-table lock when no index fits) and which room Bob
// wants. A pure model (index rows, a lock manager, the two transactions) is mutated by each
// scripted step and fully redrawn, so the lock table and the wait-for graph always match the lock
// manager, including after Back/replay. The model is exposed as def.model for tests.
(function () {
  "use strict";

  // ---------------- pure model ----------------
  const TXS = ["T1", "T2"], NAME = { T1: "Alice", T2: "Bob" };
  const BASE = [
    { id: "e122", room: 122, at: "09:00", who: "" },
    { id: "carol", room: 123, at: "10:00", who: "Carol" },
    { id: "g123", gap: 123 },
    { id: "dave", room: 123, at: "15:00", who: "Dave" },
    { id: "erin", room: 124, at: "11:00", who: "Erin" },
    { id: "g124", gap: 124 },
  ];
  // Index rows a search for the room scans (and range-locks): first and last row; null = index end.
  const SPAN = { 123: ["carol", "dave"], 124: ["erin", null] };
  const RES_ORDER = ["range123", "range124", "table", "row:T1", "row:T2"];
  const roomOf = (m, tx) => (tx === "T1" ? 123 : m.cfg.room);

  function newModel(cfg) {
    const tx = () => ({ pc: -1, status: "idle", attempt: 1, waitFor: null, skip: -1 });
    return { cfg, lm: { locks: [], waits: [] }, added: [], tx: { T1: tx(), T2: tx() },
      empty: [], found: null, hot: null, check: null, n: { waits: 0, deadlocks: 0, aborts: 0 }, done: false };
  }

  // Lock manager. S is compatible only with S; X with nothing.
  const blockers = (lm, tx, res, mode) => [...new Set(lm.locks
    .filter(l => l.res === res && l.holder !== tx && !(l.mode === "S" && mode === "S")).map(l => l.holder))];
  function grant(lm, tx, res, mode) {
    const mine = lm.locks.find(l => l.res === res && l.holder === tx);
    if (!mine) lm.locks.push({ res, mode, holder: tx });
    else if (mode === "X") mine.mode = "X";   // upgrade S -> X
  }
  // Grants the lock, or records a wait; returns the transactions it has to wait for.
  function acquire(lm, tx, res, mode) {
    const by = blockers(lm, tx, res, mode);
    if (by.length) lm.waits.push({ tx, res, mode }); else grant(lm, tx, res, mode);
    return by;
  }
  // Drops everything tx holds or waits for, then grants waiters that no longer conflict.
  function release(lm, tx) {
    lm.locks = lm.locks.filter(l => l.holder !== tx);
    lm.waits = lm.waits.filter(w => w.tx !== tx);
    const granted = [];
    lm.waits.forEach(w => { if (!blockers(lm, w.tx, w.res, w.mode).length) { grant(lm, w.tx, w.res, w.mode); granted.push(w); } });
    lm.waits = lm.waits.filter(w => !granted.includes(w));
    return granted;
  }
  const edges = lm => lm.waits.flatMap(w => blockers(lm, w.tx, w.res, w.mode).map(to => ({ from: w.tx, to })));
  const hasCycle = es => es.some(a => es.some(b => a.from === b.to && a.to === b.from));

  // The lock a statement needs; null = row locks and no matching row, so nothing to lock.
  function resFor(m, tx, write) {
    if (m.cfg.lock === "table") return "table";
    if (m.cfg.lock === "range") return "range" + roomOf(m, tx);
    return write ? "row:" + tx : null;
  }
  function resName(m, res, short) {
    if (res === "table") return short ? "whole table" : "table (all rows)";
    if (res.startsWith("row:")) { const tx = res.slice(4); return short ? "row " + NAME[tx] : `row (${roomOf(m, tx)}, 12:00, ${NAME[tx]})`; }
    const room = res.slice(5), to = room === "123" ? "10:00–15:00" : "11:00–end";
    return short ? `${room}, ${to}` : `range (${room}, ${to})`;
  }

  // Rows in display order with k = share of a row's height (for the insert tween). A new entry
  // fills the gap where its key belongs; with no usable index, new rows go at the end of the table.
  function rows(m) {
    const fresh = m.added.map(e => ({ ...e, k: e.grow }));
    if (m.cfg.lock === "table") return BASE.filter(r => !r.gap).map(r => ({ ...r, k: 1 })).concat(fresh);
    return BASE.flatMap(r => {
      if (!r.gap) return [{ ...r, k: 1 }];
      const mine = fresh.filter(e => e.room === r.gap), k = 1 - (mine.length ? mine[0].k : 0);
      return (k > 0.01 ? [{ ...r, k }] : []).concat(mine);
    });
  }
  const bookings = m => m.added.filter(e => e.room === 123 && e.state === "ok").length;

  function lockOrWait(m, tx, res, mode, out) {
    const others = m.lm.locks.filter(l => l.res === res && l.holder !== tx), by = acquire(m.lm, tx, res, mode);
    m.hot = res;
    // The compatibility rule consulted (only when someone else holds the resource).
    m.check = others.length ? { held: others.some(l => l.mode === "X") ? "X" : "S", want: mode } : null;
    if (!by.length) {
      out.push([`grant ${mode} ${resName(m, res)} to ${tx}` + (others.length ? ` (shared with ${others.map(l => l.holder).join(", ")})` : ""), ""]);
      return true;
    }
    Object.assign(m.tx[tx], { status: "wait", waitFor: by.join(", ") });
    m.n.waits++;
    out.push([`${tx} waits: ${mode} ${resName(m, res)} blocked by ` + others.map(l => `${l.mode} of ${l.holder}`).join(", "), "warn"]);
    if (hasCycle(edges(m.lm))) { m.n.deadlocks++; out.push(["deadlock: T1 waits for T2 and T2 waits for T1", "bad"]); }
    return false;
  }
  // Each op mutates the model and returns log lines [html, tone].
  const OPS = {
    begin(m) { TXS.forEach(t => Object.assign(m.tx[t], { pc: 0, status: "run" })); return [["BEGIN T1 (Alice) and T2 (Bob)", "info"]]; },
    select(m, tx) {
      const res = resFor(m, tx, false), room = roomOf(m, tx), out = [];
      const hit = m.added.find(e => e.room === room && e.state === "ok");
      m.found = hit ? hit.id : null;
      m.tx[tx].pc = 1;
      if (!res) { m.empty.push(room); return [[`${tx} SELECT room ${room}: 0 rows, no row to lock`, "warn"]]; }
      lockOrWait(m, tx, res, "S", out);
      out.push([`${tx} SELECT room ${room}: ` + (hit ? `1 row (${hit.who}'s booking)` : "0 rows"), hit ? "info" : ""]);
      return out;
    },
    insert(m, tx) {
      const out = [];
      if (lockOrWait(m, tx, resFor(m, tx, true), "X", out)) out.push(...OPS.write(m, tx));
      return out;
    },
    write(m, tx) {   // the INSERT itself, once its X lock is granted
      const room = roomOf(m, tx);
      m.added.push({ id: "new" + tx, room, at: "12:00", who: NAME[tx], tx, state: "pending", grow: 1 });
      m.tx[tx].pc = 2;
      return [[`${tx} INSERT (${room}, 12:00, ${NAME[tx]}), uncommitted`, ""]];
    },
    abort(m, tx) {
      Object.assign(m.tx[tx], { status: "abort", waitFor: null });
      m.check = null;
      m.n.aborts++;
      return [[`abort ${tx} (deadlock victim), release its locks`, "bad"], ...wake(m, release(m.lm, tx))];
    },
    commit(m, tx) {
      m.added.forEach(e => { if (e.tx === tx) e.state = "ok"; });
      Object.assign(m.tx[tx], { status: "commit", pc: 3 });
      m.hot = m.check = null;
      return [[`${tx} COMMIT, release all its locks`, "ok"], ...wake(m, release(m.lm, tx))];
    },
    retry(m, tx) {
      Object.assign(m.tx[tx], { pc: 0, status: "run", attempt: 2, skip: -1 });
      return [[`the app retries ${tx} from BEGIN`, "info"]];
    },
    giveup(m, tx) {   // the room is taken: skip the INSERT and end the transaction
      Object.assign(m.tx[tx], { status: "taken", pc: 3, skip: 1 });
      release(m.lm, tx);
      m.hot = m.check = null;
      return [[`${tx} tells ${NAME[tx]} the room is taken; COMMIT releases its S lock`, "info"]];
    },
    done(m) { m.done = true; return []; },
  };
  function wake(m, granted) {
    return granted.map(w => {
      Object.assign(m.tx[w.tx], { status: "run", waitFor: null });
      m.hot = w.res;
      return [`grant ${w.mode} ${resName(m, w.res)} to ${w.tx} (was waiting)`, ""];
    });
  }

  // ---------------- the stories ----------------
  function script(cfg) {
    const same = cfg.room === 123, L = cfg.lock, S = [];
    const step = (title, detail, ...ops) => S.push({ title, detail, ops });
    const deadlock = L === "table" || (L === "range" && same);
    const what = L === "table" ? "the table" : "that range";
    step("Both transactions begin. Under 2PL every read takes a shared (S) lock and every write an exclusive (X) lock; all are held until commit.",
      { range: "Here a search locks the index range it scanned, gaps included, like InnoDB's next-key locks and SQL Server's key-range locks at SERIALIZABLE.",
        row: "Here locks attach only to rows that exist: no predicate or range locks.",
        table: "Here there is no usable index on room_id, so a search scans the whole table." }[L],
      ["begin"]);
    step({ range: "T1: SELECT finds 0 rows and takes an S lock on the index range room 123, 10:00 to 15:00 (where a 12:00 entry would go).",
        row: "T1: SELECT finds 0 rows. Row locks can only lock rows that exist, and none match, so nothing is locked.",
        table: "T1: SELECT finds 0 rows. With no usable index it scans every row, so it takes an S lock on the whole table." }[L],
      { range: "Carol (10:00–11:00) and Dave (15:00) don't overlap 12:00–13:00. Locking the scanned range, gap included, guards rows that don't exist yet.",
        row: "The 12:00 slot is an empty gap in the index: there is no row to attach a lock to.",
        table: "This is the fallback when there is no index to attach a range lock to: safe, but it covers every room." }[L],
      ["select", "T1"]);
    if (L === "row") step(same ? "T2: the same SELECT finds 0 rows, and again nothing is locked." : "T2: SELECT for room 124 finds 0 rows; again nothing is locked.",
      same ? "Neither transaction holds anything that could stop the other's INSERT." : "", ["select", "T2"]);
    else if (L === "range" && !same) step("T2: SELECT for room 124 finds 0 rows and takes an S lock on a different range: room 124, from 11:00 to the end of the index.",
      "The two locks cover different index entries, so they don't interact.", ["select", "T2"]);
    else step((same ? "T2: the same SELECT takes an S lock on " + (L === "table" ? "the table" : "the same range") : "T2: SELECT for room 124 also scans the whole table and takes an S lock on it") +
      ". S locks are compatible, so both hold it.",
      same ? "Readers share: one lock, two holders. Under snapshot isolation neither SELECT would lock anything." : "Different rooms, same lock: with no index, every search covers everything.",
      ["select", "T2"]);

    if (!deadlock) {
      step(L === "row" ? "T1: INSERT locks only its own new row (X) and proceeds." : "T1: INSERT (123, 12:00) upgrades its S lock to X at once (no one else holds that range) and inserts.",
        L === "row" ? "No one holds a lock that conflicts with a brand-new row. The entry stays uncommitted (dashed) until COMMIT." : "The new entry stays uncommitted (dashed) until T1 commits.",
        ["insert", "T1"]);
      step(L === "row" ? (same ? "T2: INSERT locks its own new row and proceeds." : "T2: INSERT (124, 12:00) locks its own new row and proceeds.")
        : "T2: INSERT (124, 12:00) gets X on the room-124 range at once and inserts.",
        L === "row" && same ? "Two different rows, two X locks: the lock manager sees no conflict." : "", ["insert", "T2"]);
      step(L === "row" && same ? "Both commit: double booking. Without predicate or index-range locks, 2PL is not serializable."
        : L === "row" ? "Both commit: one booking per room, which is correct." : "Both commit. No waits, no deadlock, one booking per room.",
        L === "row" && same ? "Each transaction's premise, that the slot was free, was broken by the other's INSERT: a phantom." : "",
        ["commit", "T1"], ["commit", "T2"]);
    } else {
      step(`T1: INSERT (123, 12:00) needs an X lock on ${what}, but T2 holds S, so T1 waits.`,
        same ? "A write waits for every other lock on the object: T2 has read this slot, so T1 can't change it until T2 ends." : "T1 now waits for a transaction that is booking a different room.",
        ["insert", "T1"]);
      step("T2: INSERT needs X too, but T1 holds S, so T2 waits. The waits form a cycle: deadlock.",
        same ? "The classic 2PL deadlock: both read (S), then both try to write (S to X). Neither can proceed." : "A deadlock, although the two bookings never touch the same room.",
        ["insert", "T2"]);
      step("The deadlock detector aborts T2 (the victim) and releases its locks, so T1's waiting X request is granted.",
        "Engines pick victims differently: InnoDB spots the cycle at once and prefers to roll back the transaction that changed fewer rows; PostgreSQL checks only after deadlock_timeout (1 s by default) and fails one with SQLSTATE 40P01.",
        ["abort", "T2"]);
      step("T1 inserts (123, 12:00) and commits; all its locks are released.",
        "Alice has the room. Locks are released only at the end: that's the second of the two phases.",
        ["write", "T1"], ["commit", "T1"]);
      if (same) step("The app retries T2: its SELECT now finds Alice's booking, so Bob is told the room is taken.",
        "Same result as running T1, then T2, one after the other.",
        ["retry", "T2"], ["select", "T2"], ["giveup", "T2"]);
      else step("The app retries T2: room 124 was free all along, so its SELECT finds nothing, and it inserts and commits.",
        "The retry runs alone, so nothing blocks it.",
        ["retry", "T2"], ["select", "T2"], ["insert", "T2"], ["commit", "T2"]);
    }
    S[S.length - 1].ops.push(["done"]);
    return S;
  }
  // [note html, tone] after the last step.
  function finale({ lock, room }) {
    const same = room === 123;
    if (lock === "row") return same
      ? ["<b>Double booking.</b> The conflicting row didn't exist when either SELECT ran, so row locks had nothing to protect. 2PL needs predicate or index-range locks to stop phantoms.", "bad"]
      : ["Correct, but only because the rooms differ: nothing protected either empty slot. Set Bob to Room 123 and the same locking lets a double booking through.", "info"];
    if (lock === "range") return same
      ? ["<b>One booking</b>, as if T1 and T2 had run one at a time. This is the price of pessimism: someone waited, someone was aborted, and the app had to retry.", "ok"]
      : ["Range locks are coarser than exact predicates but still let unrelated bookings run in parallel.", "ok"];
    return same
      ? ["<b>One booking</b>, correct. But the lock covered every room: any other booking would have waited too. Switch Bob to Room 124.", "ok"]
      : ["Both bookings succeed, but only after two waits, a deadlock and a retry: a <b>false conflict</b>. They never wanted the same room. Without a usable index the database had to lock everything.", "warn"];
  }
  const NEXT = {   // guided tour: [button text, config change]
    "range/123": ["Row locks only", { lock: "row" }],
    "row/123": ["Index-range locks, Bob in Room 124", { lock: "range", room: 124 }],
    "range/124": ["No index (table lock)", { lock: "table" }],
    "row/124": ["Bob books Room 123", { room: 123 }],
    "table/123": ["Bob books Room 124", { room: 124 }],
  };

  // ---------------- view ----------------
  Viz.register("ch7/two-phase-locking", {
    title: "Two-phase locking and the phantom booking",
    model: { newModel, OPS, script, finale, edges, hasCycle, rows, bookings, blockers },
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      const V = n => `var(--viz-${n})`;
      const paint = (el, st) => { for (const k in st) if (st[k] !== null) el.style.setProperty(k, st[k]); return el; };
      const T = (x, y, str, o = {}) => ctx.text(x, y, str, { size: 12, anchor: "start", ...o });
      const TXC = { T1: "c6", T2: "c5" };
      const LAYOUTS = {
        desk: { W: 640, H: 338, compact: false,
          cards: [{ x: 8, y: 10, w: 196, h: 152 }, { x: 8, y: 178, w: 196, h: 152 }], cardY: [20, 45, 82, 106, 130],
          idx: { x: 218, w: 138, y: 32, rowH: 28, titleY: 18 }, bx: 362,
          graph: { x: 440, y: 10, w: 192, h: 128, cx: 536, cy: 78, dx: 58, arc: 36, statusY: 127 },
          compat: { x: 440, y: 146, w: 192, h: 86, cols: [450, 545, 595], rows: [178, 198, 217] },
          table: { x: 218, y: 238, w: 414, h: 92, cols: [230, 404, 520] } },
        phone: { W: 360, H: 618, compact: true,
          cards: [{ x: 8, y: 8, w: 168, h: 136 }, { x: 184, y: 8, w: 168, h: 136 }], cardY: [20, 43, 76, 98, 120],
          idx: { x: 8, w: 240, y: 176, rowH: 28, titleY: 162 }, bx: 254,
          graph: { x: 8, y: 480, w: 170, h: 130, cx: 93, cy: 540, dx: 56, arc: 36, statusY: 598 },
          compat: { x: 186, y: 480, w: 166, h: 130, cols: [194, 270, 318], rows: [524, 550, 576] },
          table: { x: 8, y: 382, w: 344, h: 88, cols: [18, 150, 254] } },
      };

      // ---------- controls and shared panels ----------
      const cfg = { lock: "range", room: 123 };   // survives layout rebuilds
      let compact = ctx.compact, gen = 0, player = null;
      const segs = {
        lock: ui.segmented({ label: "Locking", value: cfg.lock, onChange: v => { cfg.lock = v; restart(); },
          options: [{ value: "row", label: "Row locks only" }, { value: "range", label: "Index-range locks" }, { value: "table", label: "No index (table lock)" }] }),
        room: ui.segmented({ label: "Bob wants", value: cfg.room, onChange: v => { cfg.room = v; restart(); },
          options: [{ value: 123, label: "Room 123" }, { value: 124, label: "Room 124" }] }),
      };
      const stage = h("div"), stepSlot = h("div"), nextSlot = h("div");
      const legend = ui.legend([
        { color: V("c3"), label: "S (shared) lock", shape: "square" },
        { color: V("c7"), label: "X (exclusive) lock", shape: "square" },
        { color: V("warn"), label: "waits for", shape: "line" },
        { color: V("bad"), label: "wait-for cycle", shape: "line" },
        { color: V("muted"), label: "uncommitted entry", shape: "dash" },
        { color: V("ok"), label: "committed entry", shape: "square" },
      ]);
      const stats = ui.stats([
        { key: "book", label: "Bookings for room 123 at 12:00" }, { key: "waits", label: "Lock waits" },
        { key: "dl", label: "Deadlocks" }, { key: "abort", label: "Aborted and retried" }, { key: "conflict", label: "Conflict was" },
      ]);
      const note = ui.note("");
      const log = ui.log({ title: "Lock manager log", height: 100 });
      root.append(ui.bar(segs.lock, segs.room), stage, legend, stepSlot, note, nextSlot, stats, log);

      // Every await goes through live(): once the config changes (gen bumps), a stale step parks
      // forever instead of drawing over the new scene or writing to the shared log and stats.
      const live = (st, p) => p.then(v => (st.gen === gen ? v : new Promise(() => {})));
      const sleep = (st, ms) => live(st, ctx.sleep(ms));
      const tween = (st, ms, fn) => live(st, ctx.tween({ ms, onUpdate: fn }));

      // ---------- geometry ----------
      function layoutRows(L, list) {
        let y = L.idx.y;
        const pos = {};
        list.forEach(r => { pos[r.id] = { y, h: L.idx.rowH * r.k }; y += L.idx.rowH * r.k; });
        return pos;
      }
      // [first, last] row index covered by a resource (or by a search's scan range).
      function cover(list, res) {
        const ix = id => list.findIndex(r => r.id === id);
        if (res === "table") return [0, list.length - 1];
        if (res.startsWith("row:")) { const i = ix("new" + res.slice(4)); return [i, i]; }
        const [a, b] = SPAN[res.slice(5)];
        return [ix(a), b ? ix(b) : list.length - 1];
      }
      const extent = (list, pos, [a, b]) => [pos[list[a].id].y, pos[list[b].id].y + pos[list[b].id].h - 4];

      // ---------- drawing ----------
      function drawStatic(st) {
        const { L, bg } = st, G = L.graph, P = L.table, [c0, c1, c2] = P.cols;
        const label = (x, y, str, weight = 700) => bg.appendChild(T(x, y, str, { weight, fill: V("muted") }));
        [G, L.compat, P].forEach(r => bg.appendChild(paint(s("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 10, "stroke-width": 1 }), { fill: V("panel"), stroke: V("line") })));
        label(L.idx.x, L.idx.titleY, cfg.lock === "table" ? "table bookings (no usable index)" : "index on (room_id, start)");
        label(G.x + 10, G.y + 16, "wait-for graph");
        label(L.compat.x + 10, L.compat.y + 16, "lock compatibility");
        label(c0, P.y + 17, "lock table");
        label(c1, P.y + 17, "granted", null);
        label(c2, P.y + 17, "waiting", null);
        bg.appendChild(paint(s("line", { x1: P.x + 8, x2: P.x + P.w - 8, y1: P.y + 27, y2: P.y + 27 }), { stroke: V("line") }));
      }

      const STATUS = {
        idle: () => ["not started", "muted"],
        run: t => [t.attempt > 1 ? "running (retry)" : "running", "info"],
        wait: t => ["waiting for " + t.waitFor, "warn"],
        abort: (t, L) => [L.compact ? "ABORTED: victim" : "ABORTED: deadlock victim", "bad"],
        commit: t => [t.attempt > 1 ? "committed on retry" : "committed", "ok"],
        taken: () => ["retry: room taken", "info"],
      };
      function drawCard(st, tx) {
        const { m, L, dyn } = st, c = L.cards[tx === "T1" ? 0 : 1], t = m.tx[tx], room = roomOf(m, tx);
        const [label, tone] = STATUS[t.status](t, L), [yH, yB, ...yS] = L.cardY, muted = tone === "muted";
        const edge = { abort: "bad", commit: "ok" }[t.status] || TXC[tx];
        dyn.appendChild(paint(s("rect", { x: c.x, y: c.y, width: c.w, height: c.h, rx: 10, "stroke-width": 1.6 }),
          { fill: V("panel"), stroke: V(edge), "stroke-dasharray": t.status === "abort" ? "6 4" : null }));
        dyn.appendChild(T(c.x + 12, c.y + yH, `${tx} · ${NAME[tx]}`, { size: 13, weight: 700, fill: V(TXC[tx]) }));
        dyn.appendChild(T(c.x + c.w - 12, c.y + yH, "room " + room, { anchor: "end", fill: V("muted") }));
        dyn.appendChild(paint(s("rect", { x: c.x + 8, y: c.y + yB - 11, width: c.w - 16, height: 22, rx: 6, "stroke-width": 1 }),
          { fill: V(muted ? "node" : tone + "-soft"), stroke: V(muted ? "line" : tone) }));
        dyn.appendChild(T(c.x + 16, c.y + yB + 1, label, { weight: 700, fill: V(muted ? "muted" : tone) }));
        const stmts = L.compact ? [`SELECT ${room}`, `INSERT ${room}`, "COMMIT"] : [`SELECT room ${room}, 12–13`, `INSERT (${room}, 12:00)`, "COMMIT"];
        stmts.forEach((str, i) => {
          const y = c.y + yS[i], skipped = t.skip === i, cur = i === t.pc, done = i < t.pc && !skipped;
          if (cur && t.status === "abort") dyn.appendChild(T(c.x + 16, y + 1, "✕", { weight: 800, anchor: "middle", fill: V("bad") }));
          else if (cur) dyn.appendChild(paint(s("path", { d: `M${c.x + 11},${y - 6} L${c.x + 20},${y} L${c.x + 11},${y + 6} Z` }), { fill: V(tone) }));
          else if (done) dyn.appendChild(T(c.x + 16, y + 1, "✓", { weight: 700, anchor: "middle", fill: V("ok") }));
          const el = T(c.x + 28, y + 1, str, { mono: true, weight: cur ? 700 : null, fill: V(cur ? "ink" : done || skipped || t.pc > 2 ? "muted" : "ink") });
          if (skipped) el.style.textDecoration = "line-through";
          dyn.appendChild(el);
        });
      }

      const doubled = (m, room) => m.added.filter(e => e.room === room && e.state === "ok").length > 1;
      function drawRow(st, r, p) {
        const { m, L, dyn } = st, x = L.idx.x, w = L.idx.w, hh = p.h - 4, cy = p.y + hh / 2;
        if (hh < 2) return;
        const g = s("g", { opacity: Math.min(1, r.k * 1.2) });
        let fill = "node", stroke = "node-stroke", dash = null, sw = 1.2;
        if (r.gap) { fill = "bg"; stroke = "line"; dash = "4 3"; }
        if (r.gap && m.empty.includes(r.gap)) { stroke = "bad"; sw = 2; }
        if (r.tx) { const ok = r.state === "ok"; fill = ok ? "ok-soft" : TXC[r.tx] + "-soft"; stroke = ok ? "ok" : TXC[r.tx]; dash = ok ? null : "5 3"; sw = 1.6; }
        if (r.tx && doubled(m, r.room)) { fill = "bad-soft"; stroke = "bad"; sw = 2; }
        g.appendChild(paint(s("rect", { x, y: p.y, width: w, height: hh, rx: 5, "stroke-width": sw }), { fill: V(fill), stroke: V(stroke), "stroke-dasharray": dash }));
        if (m.found === r.id) g.appendChild(paint(s("rect", { x: x - 3, y: p.y - 3, width: w + 6, height: hh + 6, rx: 7, fill: "none", "stroke-width": 2.5 }), { stroke: V(TXC.T2) }));
        if (r.k > 0.5) {
          if (r.gap) g.appendChild(T(x + w / 2, cy + 1, "(gap)", { anchor: "middle", fill: V(m.empty.includes(r.gap) ? "bad" : "muted") }));
          else {
            g.appendChild(T(x + 8, cy + 1, `${r.room} ${r.at}`, { mono: true }));
            g.appendChild(T(x + w - 8, cy + 1, r.who, { anchor: "end", weight: r.tx ? 700 : null, fill: V(r.tx && r.state !== "ok" ? TXC[r.tx] : r.tx ? "ink" : "muted") }));
          }
        }
        dyn.appendChild(g);
      }
      // Label lines centred to the right of the bracket column.
      function sideLabel(st, y0, y1, lines, color) {
        const mid = (y0 + y1) / 2, top = mid - (lines.length - 1) * 8;
        lines.forEach((ln, i) => st.dyn.appendChild(T(st.L.bx + 7, top + i * 16 + 1, ln, { weight: 700, fill: V(color) })));
      }
      function drawIndex(st) {
        const { m, L, dyn } = st, list = rows(m), pos = layoutRows(L, list), x = L.bx;
        list.forEach(r => drawRow(st, r, pos[r.id]));
        RES_ORDER.forEach(res => {
          const held = m.lm.locks.filter(l => l.res === res), span = cover(list, res);
          if (!held.length || span.includes(-1)) return;
          const [y0, y1] = extent(list, pos, span), X = held.some(l => l.mode === "X"), col = X ? "c7" : "c3";
          if (y1 - y0 < 8) return;   // its row is still sliding in
          dyn.appendChild(paint(s("path", { d: `M${x - 5},${y0 + 2} H${x} V${y1 - 2} H${x - 5}`, fill: "none", "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" }), { stroke: V(col) }));
          const who = ["X", "S"].map(md => [md, held.filter(l => l.mode === md).map(l => l.holder)]).filter(([, hs]) => hs.length)
            .map(([md, hs]) => `${md}: ${hs.join(", ")}`).join(" ");
          sideLabel(st, y0, y1, res === "table" ? ["table lock", who] : [who], col);
        });
        m.empty.forEach(room => {
          const i = list.findIndex(r => r.gap === room);
          if (i >= 0 && list[i].k > 0.5) sideLabel(st, ...extent(list, pos, [i, i]), ["nothing", "to lock"], "bad");
        });
        if (doubled(m, 123)) {
          const ix = list.map((r, i) => (r.tx && r.room === 123 ? i : -1)).filter(i => i >= 0);
          sideLabel(st, ...extent(list, pos, [ix[0], ix[ix.length - 1]]), ["double", "booking!"], "bad");
        }
        const f = list.findIndex(r => r.id === m.found);
        if (f >= 0 && m.tx.T2.status === "taken") sideLabel(st, ...extent(list, pos, [f, f]), ["found", "by T2"], TXC.T2);
      }

      function modeText(x, y, pairs) {   // "S: T1, T2" groups coloured by mode
        const el = s("text", { x, y: y + 1, "font-size": 12, "dominant-baseline": "middle", "font-weight": 700 });
        const groups = ["X", "S"].map(md => [md, pairs.filter(p => p[0] === md).map(p => p[1])]).filter(([, hs]) => hs.length);
        if (!groups.length) el.appendChild(s("tspan", { fill: V("muted") }, "–"));
        groups.forEach(([md, hs], i) => el.appendChild(s("tspan", { fill: V(md === "X" ? "c7" : "c3") }, (i ? "  " : "") + `${md}: ${hs.join(", ")}`)));
        return el;
      }
      function drawLocks(st) {
        const { m, L, dyn } = st, P = L.table, [c0, c1, c2] = P.cols, lm = m.lm;
        const used = RES_ORDER.filter(r => lm.locks.some(l => l.res === r) || lm.waits.some(w => w.res === r)).slice(0, 3);
        if (!used.length) dyn.appendChild(T(c0, P.y + 43, "(no locks held)", { fill: V("muted") }));
        used.forEach((res, i) => {
          const y = P.y + 43 + i * 19;
          if (res === m.hot) dyn.appendChild(paint(s("rect", { x: P.x + 4, y: y - 9, width: P.w - 8, height: 18, rx: 4 }), { fill: V("info-soft") }));
          dyn.appendChild(T(c0, y + 1, resName(m, res, L.compact)));
          dyn.appendChild(modeText(c1, y, lm.locks.filter(l => l.res === res).map(l => [l.mode, l.holder])));
          dyn.appendChild(modeText(c2, y, lm.waits.filter(w => w.res === res).map(w => [w.mode, w.tx])));
        });
      }

      function drawGraph(st) {
        const { m, L, dyn, svg } = st, G = L.graph, es = edges(m.lm), cyc = hasCycle(es);
        const at = { T1: G.cx - G.dx, T2: G.cx + G.dx }, col = cyc ? "bad" : "warn";
        es.forEach(e => {   // T1 -> T2 arcs over the top, T2 -> T1 under the bottom
          const up = e.from === "T1" ? -1 : 1, dir = Math.sign(at[e.to] - at[e.from]), sy = G.cy + up * 13;
          dyn.appendChild(paint(s("path", { d: `M${at[e.from] + dir * 13},${sy} Q${G.cx},${G.cy + up * G.arc} ${at[e.to] - dir * 13},${sy}`,
            fill: "none", "stroke-width": 2.4, "marker-end": svg.arrow(V(col)) }), { stroke: V(col) }));
        });
        TXS.forEach(tx => {
          const t = m.tx[tx], gone = t.status === "abort", ring = { abort: "bad", commit: "ok" }[t.status] || TXC[tx];
          const n = ctx.node({ x: at[tx], y: G.cy, r: 18, label: tx, size: 13, fill: V(TXC[tx] + "-soft"), stroke: V(ring) });
          if (gone) paint(n.circle, { "stroke-dasharray": "4 3" });
          dyn.appendChild(n);
          dyn.appendChild(T(at[tx], G.cy + 30, gone ? "victim" : NAME[tx], { anchor: "middle", weight: gone ? 700 : null, fill: V(gone ? "bad" : "muted") }));
        });
        if (cyc) dyn.appendChild(T(G.cx, G.cy + 1, "DEADLOCK", { anchor: "middle", weight: 800, fill: V("bad"), halo: true }));
        const victim = TXS.find(tx => m.tx[tx].status === "abort");
        const [msg, tone] = cyc ? ["cycle: abort one", "bad"] : es.length ? [`${es[0].from} waits for ${es[0].to}`, "warn"]
          : victim ? [`${victim} aborted, no cycle`, "muted"] : ["no one is waiting", "muted"];
        dyn.appendChild(T(G.cx, G.statusY, msg, { anchor: "middle", weight: tone === "muted" ? null : 700, fill: V(tone) }));
      }
      // S/X matrix; the cell the lock manager just consulted is highlighted.
      function drawCompat(st) {
        const { m, L, dyn } = st, C = L.compat, [c0, c1, c2] = C.cols, [y0, ...ys] = C.rows, MC = { S: "c3", X: "c7" };
        ["S", "X"].forEach((want, j) => dyn.appendChild(T([c1, c2][j], y0, "asks " + want, { anchor: "middle", weight: 700, fill: V(MC[want]) })));
        ["S", "X"].forEach((held, i) => {
          dyn.appendChild(T(c0, ys[i] + 1, "holds " + held, { weight: 700, fill: V(MC[held]) }));
          ["S", "X"].forEach((want, j) => {
            const ok = held === "S" && want === "S", on = m.check && m.check.held === held && m.check.want === want, tone = ok ? "ok" : "warn", cx = [c1, c2][j];
            dyn.appendChild(paint(s("rect", { x: cx - 22, y: ys[i] - 9, width: 44, height: 18, rx: 5, "stroke-width": on ? 2 : 1 }),
              { fill: V(on ? tone + "-soft" : "node"), stroke: V(on ? tone : "line") }));
            dyn.appendChild(T(cx, ys[i] + 1, ok ? "grant" : "wait", { anchor: "middle", weight: on ? 800 : null, fill: V(on ? tone : "muted") }));
          });
        });
      }

      function conflict(m) {
        if (m.n.waits) return cfg.room === 123 ? ["real", "info"] : ["false", "warn"];
        if (bookings(m) > 1) return ["missed", "bad"];
        return m.done ? ["none", "ok"] : ["–", ""];
      }
      function render(st) {
        const m = st.m, b = bookings(m);
        st.dyn.replaceChildren();
        drawIndex(st); drawCard(st, "T1"); drawCard(st, "T2"); drawLocks(st); drawGraph(st); drawCompat(st);
        stats.set("book", b, b > 1 ? "bad" : b ? "ok" : "");
        [["waits", m.n.waits], ["dl", m.n.deadlocks], ["abort", m.n.aborts]].forEach(([k, v]) => stats.set(k, v, v ? "warn" : ""));
        stats.set("conflict", ...conflict(m));
      }

      // ---------- animation ----------
      // The search's scan: a highlight sweeps over the index range (or the whole table) it reads.
      async function scan(st, tx) {
        const { m, L } = st, list = rows(m), pos = layoutRows(L, list);
        const [a, b] = cover(list, m.cfg.lock === "table" ? "table" : "range" + roomOf(m, tx));
        const y0 = pos[list[a].id].y, y1 = pos[list[b].id].y;
        const bar = paint(s("rect", { x: L.idx.x - 3, y: y0 - 2, width: L.idx.w + 6, height: L.idx.rowH, rx: 6, "stroke-width": 2 }),
          { fill: V(TXC[tx] + "-soft"), stroke: V(TXC[tx]) });
        st.fx.appendChild(bar);
        await tween(st, 170 * (b - a + 1), k => ctx.attr(bar, { y: ctx.lerp(y0, y1, k) - 2 }));
        bar.remove();
      }
      async function exec(st, [op, tx]) {
        const m = st.m, before = m.added.length;
        if (op === "select") await scan(st, tx);
        const lines = OPS[op](m, tx), fresh = m.added.slice(before);
        if (fresh.length) {   // a new index entry slides into its gap
          fresh.forEach(e => { e.grow = 0; });
          await tween(st, 300, k => { fresh.forEach(e => { e.grow = k; }); render(st); });
        }
        render(st);
        lines.forEach(([html, tone]) => log.add(html, tone));
        if (op !== "done") await sleep(st, 380);
      }

      function intro({ room }) {
        const sql = `<code>SELECT … WHERE room_id = R AND end_time &gt; '12:00' AND start_time &lt; '13:00'</code>`;
        return (room === 123 ? "Alice (T1) and Bob (T2) both try to book room 123 for 12:00–13:00 at the same moment."
          : "Alice (T1) books room 123 and Bob (T2) room 124, both for 12:00–13:00, at the same moment.") +
          ` Each runs ${sql}; if it finds no row, <code>INSERT</code>; <code>COMMIT</code>. Existing bookings last an hour. Pick how the database locks, then press <b>Play</b>.`;
      }
      function finish() {
        const [html, tone] = finale(cfg), next = NEXT[`${cfg.lock}/${cfg.room}`];
        note.set(html, tone);
        nextSlot.replaceChildren();
        nextSlot.style.margin = next ? "10px 0" : "";
        if (next) nextSlot.appendChild(ui.button(`Try next: ${next[0]} →`, () => {
          Object.assign(cfg, next[1]);
          for (const k in segs) segs[k].set(cfg[k]);
          restart();
        }, { kind: "primary" }));
      }

      // ---------- assembly ----------
      function build() {
        compact = ctx.compact;
        const L = compact ? LAYOUTS.phone : LAYOUTS.desk, myGen = gen;
        const svg = ctx.svg({ w: L.W, h: L.H, label: "Two booking transactions, an index with range locks, a lock table and a wait-for graph" });
        const layers = {};
        ["bg", "dyn", "fx"].forEach(k => svg.appendChild((layers[k] = s("g"))));
        const story = script(cfg);
        const steps = story.map((sp, i) => ({
          title: sp.title, detail: sp.detail,
          run: async st => {
            for (const op of sp.ops) await exec(st, op);
            if (i === story.length - 1) finish();
          },
        }));
        player = ctx.stepper({
          delay: 1700, steps,
          intro: "Press <b>Play</b> or <b>Step ▶</b> to run both transactions side by side.",
          // Fully rebuilds the scene and the model: Back = init() + instant replay.
          init() {
            Object.values(layers).forEach(g => g.replaceChildren());
            log.clear().add("Every lock request, grant, wait and release is listed here.", "muted");
            note.set(intro(cfg), "info");
            nextSlot.replaceChildren();
            nextSlot.style.margin = "";
            const st = { gen: myGen, L, svg, ...layers, m: newModel({ ...cfg }) };
            drawStatic(st);
            render(st);
            return st;
          },
        });
        stage.replaceChildren(svg);
        stepSlot.replaceChildren(player.el);
      }
      function restart(keepStep) {
        const idx = keepStep && player ? player.index : -1;
        gen++;
        if (player) player.pause();
        ctx.instant = true;   // finish the old story's in-flight tweens now; live() parks its step
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
