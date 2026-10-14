// Write skew: two transactions check the same invariant, each writes a different row (or inserts
// a new one), and both commit, so the invariant breaks. A scenario player for two stories
// (on-call doctors, room booking) under the defenses that do or don't help. Concurrency model:
// PostgreSQL READ COMMITTED, where a blocked locking read re-checks the newest committed rows.
(function () {
  "use strict";
  const NAME = { A: "Alice", B: "Bob" };
  const COL = { A: "c6", B: "c5" };
  const V = c => `var(--viz-${c})`;
  const q = sql => `<code>${sql}</code>`;
  const SCENARIOS = [{ value: "doctors", label: "On-call doctors" }, { value: "booking", label: "Room booking" }];
  const DEFENSES = {
    doctors: [{ value: "none", label: "No locks" }, { value: "lock", label: "FOR UPDATE" }],
    booking: [{ value: "none", label: "No locks" }, { value: "lock", label: "FOR UPDATE" },
      { value: "slots", label: "Slot rows" }, { value: "exclude", label: "EXCLUDE" }],
  };

  // Statements listed in each transaction's card (short forms; captions carry the full SQL).
  function statements(scen, def, w) {
    const commit = ["COMMIT"];
    if (scen === "doctors") {
      const check = def === "lock" ? ["SELECT on-call", "FOR UPDATE"] : ["SELECT count(*)", "WHERE on_call"];
      return [check, ["UPDATE doctors", "SET on_call=false", `WHERE name='${NAME[w]}'`], commit];
    }
    const count = ["SELECT count(*)", "overlapping 12–13"], insert = ["INSERT booking", "12:00–13:00"];
    if (def === "slots") return [["SELECT slot 12", "FOR UPDATE"], count, insert, commit];
    return [def === "lock" ? ["SELECT overlaps", "12–13 FOR UPDATE"] : count, insert, commit];
  }

  // ---------- model: every step mutates this small state object; render() draws it ----------
  function freshState() {
    const tx = () => ({ cur: -1, res: {}, status: ["not started", "muted"], bubble: null, tone: null, broken: false, skip: {}, alt: {} });
    return {
      rows: { A: "on", B: "on" },  // doctors' on_call: on | pend (uncommitted off) | off
      books: [],                   // new 12:00 bookings: {w, s: pend | done | try | rejected}
      locks: {}, waiting: {},      // element key ("rowA", "cell", "bookB") -> tx holding / waiting
      tx: { A: tx(), B: tx() },
      phantom: false, waits: 0, locked: null, outcome: null, links: [], linkLabel: "",
      touch: null, flash: new Set(),
    };
  }
  const onCall = st => Object.values(st.rows).filter(r => r !== "off").length;
  const booked = st => st.books.filter(b => b.s === "done").length;
  const HOLDS = ["invariant holds", "ok"];

  const op = {
    status(st, w, s) { if (st.tx[w].status[0] !== s[0]) st.flash.add("badge" + w); st.tx[w].status = s; },
    begin(st) { for (const w of "AB") op.status(st, w, ["running", "info"]); },
    exec(st, w, i, res, tone) {
      st.tx[w].cur = i;
      if (res) st.tx[w].res[i] = [res, tone || COL[w]];
      op.status(st, w, ["running", "info"]);
      st.flash.add("stmt" + w);
    },
    read(st, w, i, res, keys) { op.exec(st, w, i, res); st.touch = { w, keys }; },
    think(st, w, lines, tone) { Object.assign(st.tx[w], { bubble: lines, tone: tone || null }); st.flash.add("bubble" + w); },
    lock(st, w, key) { st.locks[key] = w; st.flash.add("lock" + key); },
    wait(st, w, i, key) {
      op.exec(st, w, i, "waits", "warn");
      op.status(st, w, ["waiting for Alice", "warn"]);
      st.waits++; st.waiting[key] = w; st.flash.add("wait" + key);
    },
    resume(st, w, res) {   // a blocked statement gets its lock and completes
      op.exec(st, w, st.tx[w].cur, res);
      for (const k in st.waiting) if (st.waiting[k] === w) delete st.waiting[k];
    },
    update(st, w, i) { op.exec(st, w, i); st.rows[w] = "pend"; st.touch = { w, keys: ["row" + w] }; st.flash.add("val" + w); },
    insert(st, w, i) { op.exec(st, w, i); st.books.push({ w, s: "pend" }); st.flash.add("book" + w); },
    release(st, w) { for (const k in st.locks) if (st.locks[k] === w) delete st.locks[k]; },
    commit(st, w, i) {
      op.exec(st, w, i);
      if (st.rows[w] === "pend") { st.rows[w] = "off"; st.flash.add("val" + w); }
      st.books.forEach(b => { if (b.w === w && b.s === "pend") { b.s = "done"; st.flash.add("book" + w); } });
      st.flash.add("banner"); op.release(st, w); op.status(st, w, ["committed", "ok"]);
    },
    refuse(st, w, skip, i) { op.exec(st, w, i); st.tx[w].skip[skip] = true; op.release(st, w); op.status(st, w, ["refused", "info"]); },
    link(st, from, to, tone, label) { st.links.push({ from, to, tone }); if (label) st.linkLabel = label; st.flash.add("links"); },
    // A broken run's last frame: each committed write falsified the other transaction's premise.
    skew(st, src, outcome) {
      for (const w of "AB") Object.assign(st.tx[w], { tone: "bad", broken: true });
      op.link(st, src + "A", "B", "bad", "each write broke the other's premise");
      op.link(st, src + "B", "A", "bad");
      st.outcome = outcome;
    },
  };

  // ---------- scripts: six steps per scenario + defense ----------
  const OK_TO_LEAVE = ["sees 2 on call,", "so OK to leave"];
  const FREE = ["no overlaps, so", "the room is free"];
  const RC = "Each starts a transaction at read committed.";
  const startDoctors = ["Alice and Bob both click <b>Go off call</b>", RC, st => op.begin(st)];
  const startBooking = detail => ["Alice and Bob both try to book Room 123 for <b>12:00–13:00</b>", detail, st => op.begin(st)];
  const COUNT_DOC = "SELECT count(*) FROM doctors WHERE on_call = true AND shift_id = 1234";
  const OVERLAP = "WHERE room_id = 123 AND end_time &gt; '12:00' AND start_time &lt; '13:00'";
  const INSERT_SQL = "INSERT INTO bookings (room_id, start_time, end_time, user_id) VALUES (123, '12:00', '13:00', 'alice')";
  const commitBoth = (src, outcome) => async (st, show) => { op.commit(st, "A", 2); await show(450); op.commit(st, "B", 2); op.skew(st, src, outcome); };

  const SCRIPTS = {
    "doctors:none": {
      steps: [
        startDoctors,
        [`Alice: ${q(COUNT_DOC)} returns <b>2</b>`, "",
          st => { op.read(st, "A", 0, "→ 2", ["rowA", "rowB"]); op.think(st, "A", OK_TO_LEAVE); st.locked = ["0", ""]; }],
        ["Bob: the same query also returns <b>2</b>", "Nobody has changed anything yet, so both decisions rest on the same premise.",
          st => { op.read(st, "B", 0, "→ 2", ["rowA", "rowB"]); op.think(st, "B", OK_TO_LEAVE); }],
        [`Alice: ${q("UPDATE doctors SET on_call = false WHERE name = 'Alice' AND shift_id = 1234")}`,
          "Her change is uncommitted, so other transactions still see her on call.", st => op.update(st, "A", 1)],
        [`Bob: ${q("UPDATE … WHERE name = 'Bob' AND shift_id = 1234")}`,
          "Different rows, so no lock conflict and no lost-update detection.", st => op.update(st, "B", 1)],
        ["Both commit", "Each commit is fine on its own; together they leave nobody on call.", commitBoth("row", ["write skew", "bad"])],
      ],
      final: ["Each transaction was correct for its snapshot; together they broke the rule. Different rows were written, so nothing detected a conflict: <b>write skew</b>.", "bad"],
    },
    "doctors:lock": {
      steps: [
        startDoctors,
        [`Alice: ${q("SELECT * FROM doctors WHERE on_call = true AND shift_id = 1234 FOR UPDATE")} locks both rows; 2 rows, so OK to leave`,
          "PostgreSQL won't combine FOR UPDATE with COUNT(*), so select the rows and count them in the app.",
          st => { op.read(st, "A", 0, "→ 2", ["rowA", "rowB"]); op.lock(st, "A", "rowA"); op.lock(st, "A", "rowB"); op.think(st, "A", OK_TO_LEAVE); st.locked = ["2", "warn"]; }],
        [`Bob: the same ${q("SELECT … FOR UPDATE")} must wait for Alice's locks`,
          "Row locks are held until the transaction commits or aborts.", st => op.wait(st, "B", 0, "rowA")],
        ["Alice takes herself off call and commits; the locks are released", "",
          async (st, show) => { op.update(st, "A", 1); await show(500); op.commit(st, "A", 2); }],
        ["Bob's SELECT resumes and re-reads the newest committed rows: only Bob is on call",
          "At REPEATABLE READ, PostgreSQL would instead abort Bob with a serialization error; his retry reaches the same safe answer.",
          st => {
            op.resume(st, "B", "→ 1"); op.lock(st, "B", "rowB"); st.touch = { w: "B", keys: ["rowA", "rowB"] };
            op.think(st, "B", ["only 1 on call,", "so I must stay"], "ok"); op.link(st, "rowA", "B", "ok", "Bob's re-read sees Alice's commit");
          }],
        ["Bob commits without changes", "The app tells him he has to stay on call.", st => { op.refuse(st, "B", 1, 2); st.outcome = HOLDS; }],
      ],
      final: ["Locking the rows the decision depended on made Bob <b>wait and re-check his premise</b>.", "ok"],
    },
    "booking:none": bookingScript("none"),
    "booking:lock": bookingScript("lock"),
    "booking:exclude": bookingScript("exclude"),
    "booking:slots": {
      steps: [
        startBooking("This schema adds a <b>room_slots</b> table: one pre-created row per room and hour, there only to be locked."),
        [`Alice: ${q("SELECT * FROM room_slots WHERE room_id = 123 AND hour = 12 FOR UPDATE")} locks the 12:00 slot row`, "",
          st => { op.read(st, "A", 0, "→ 1", ["cell"]); op.lock(st, "A", "cell"); st.locked = ["1 slot", "warn"]; }],
        ["Bob: the same lock request waits", "Alice holds the slot row's lock until she commits or aborts.", st => op.wait(st, "B", 0, "cell")],
        ["Alice: checks bookings (0 overlap), INSERTs, commits; the slot lock is released", "",
          async (st, show) => {
            op.read(st, "A", 1, "→ 0", ["slot"]); op.think(st, "A", FREE); await show(350);
            op.insert(st, "A", 2); await show(350); op.commit(st, "A", 3);
          }],
        ["Bob gets the slot lock; his check (a new statement) sees Alice's booking: 1 overlap, so he refuses", "",
          async (st, show) => {
            op.resume(st, "B", "→ 1"); op.lock(st, "B", "cell"); await show(350);
            op.read(st, "B", 1, "→ 1", ["slot"]); op.think(st, "B", ["sees 1 overlap, so", "the room is taken"], "ok");
          }],
        ["Bob commits without inserting",
          "The slot rows hold no data; they exist only to be locked. It works, but it leaks concurrency control into the schema. It also relies on read committed: Bob's check after the lock is a new statement with a fresh snapshot. Under PostgreSQL REPEATABLE READ his check would still use his old snapshot, unless the slot row is UPDATEd rather than just locked.",
          st => { op.refuse(st, "B", 2, 3); st.outcome = HOLDS; }],
      ],
      final: ["Turning the slot into a lockable row converts the <b>phantom</b> into an ordinary lock conflict.", "ok"],
    },
  };

  function bookingScript(def) {
    const lock = def === "lock", excl = def === "exclude";
    const where = excl ? "WHERE room_id = 123 AND during &amp;&amp; '[12:00, 13:00)'" : OVERLAP;
    const sql = (lock ? "SELECT * FROM bookings " : "SELECT count(*) FROM bookings ") + where + (lock ? " FOR UPDATE" : "");
    const locked = { none: ["0", ""], lock: ["0", "bad"], exclude: ["none: constraint", "info"] }[def];
    const check = w => st => { op.read(st, w, 0, "→ 0", ["slot"]); op.think(st, w, FREE); };
    const steps = [
      startBooking(excl ? `The table was created with ${q("EXCLUDE USING gist (room_id WITH =, during WITH &amp;&amp;)")}, where <i>during</i> is a time range; the = part needs the btree_gist extension.` : RC),
      [lock ? `Alice: ${q(sql)} matches 0 rows, so nothing is locked` : `Alice: ${q(sql)} returns <b>0</b>`,
        lock ? "FOR UPDATE locks rows that exist. The conflict is over a row that doesn't exist yet: a <b>phantom</b>."
          : excl ? "With the constraint in place, this check only produces a friendly message." : "",
        st => { check("A")(st); st.locked = locked; if (lock) { st.phantom = true; st.flash.add("phantom"); } }],
      [lock ? "Bob: the same query, 0 rows, no wait" : "Bob: the same query also returns <b>0</b>",
        lock ? "This is PostgreSQL and Oracle behavior. MySQL InnoDB at REPEATABLE READ would take a gap lock here, an index-range lock: see two-phase locking." : "",
        check("B")],
      [excl ? "Alice: <b>INSERT</b> 12:00–13:00; the constraint's index now holds her uncommitted entry" : "Alice: <b>INSERT</b> a booking for 12:00–13:00",
        excl ? "" : q(INSERT_SQL), st => { st.phantom = false; op.insert(st, "A", 1); }],
      excl
        ? ["Bob: <b>INSERT</b> 12:00–13:00 overlaps an uncommitted entry, so the database makes him wait to see whether Alice commits", "",
          st => { st.books.push({ w: "B", s: "try" }); op.wait(st, "B", 1, "bookB"); }]
        : ["Bob: <b>INSERT</b> a booking for 12:00–13:00", "Two brand-new rows: neither transaction writes a row the other has written, so nothing conflicts.",
          st => op.insert(st, "B", 1)],
      excl
        ? ["Alice commits; Bob's INSERT fails: <i>conflicting key value violates exclusion constraint</i>. The app tells Bob the room is taken.",
          "Had Alice rolled back, Bob's INSERT would have gone through. The database enforces the rule whatever the timing and at any isolation level.",
          async (st, show) => {
            op.commit(st, "A", 2); await show(450);
            st.books.find(b => b.w === "B").s = "rejected"; st.flash.add("bookB"); st.waiting = {};
            st.tx.B.res[1] = ["error", "bad"]; st.tx.B.alt[2] = ["ROLLBACK"];
            op.exec(st, "B", 2); op.status(st, "B", ["refused", "info"]);
            op.think(st, "B", ["INSERT failed, so", "the room is taken"], "ok");
            op.link(st, "bookA", "B", "ok", "the constraint sees Alice's entry"); st.outcome = HOLDS;
          }]
        : [lock ? "Both commit: <b>still double-booked</b>" : "Both commit: the room is <b>double-booked</b>", "",
          commitBoth("book", ["phantom: double booking", "bad"])],
    ];
    const final = {
      none: ["Each check found the slot free, and each INSERT added a row the other's check never saw. No row was written twice, so nothing conflicted: a <b>phantom</b> led to write skew.", "bad"],
      lock: ["There was <b>nothing to lock</b>: the conflicting row didn't exist when the check ran.", "bad"],
      exclude: ["The database itself refused the second overlapping booking. When the rule fits a constraint, this is the <b>simplest robust fix</b>.", "ok"],
    }[def];
    return { steps, final };
  }

  const INTRO = {
    none: "Both run at read committed; with no locks, snapshot isolation would behave the same.",
    lock: "Now each check locks the rows it reads with <b>FOR UPDATE</b>.",
    slots: "Now each transaction first locks the <b>room_slots</b> row for its hour.",
    exclude: "Now an <b>exclusion constraint</b> guards the bookings table.",
  };

  Viz.register("ch7/write-skew", {
    title: "Write skew: doctors and double bookings",
    model: { freshState, op, SCRIPTS, statements, onCall, booked },   // pure model, for tests
    mount(root, ctx) {
      const { s, ui } = ctx;
      let scen = "doctors", def = "none", compact = ctx.compact, view = null, player = null;
      const script = () => SCRIPTS[scen + ":" + def];

      // ---------- geometry ----------
      function layout() {
        const nStmt = Math.max(...["A", "B"].map(w => statements(scen, def, w).length));
        const nLines = Math.max(...["A", "B"].map(w => statements(scen, def, w).flat().length));
        const g = compact
          ? { W: 360, banner: { x: 8, y: 8, w: 344, h: 40 }, cy: 56, cw: 168, cx: [8, 184], lh: 14, gap: 4, stmtTop: 32,
            bubbleH: 36, bubbleFs: 12, badgeH: 20, x0: 8, x1: 352, tx0: 20, tx1: 340 }
          : { W: 640, banner: { x: 100, y: 8, w: 440, h: 32 }, cy: 52, cw: 160, cx: [10, 470], lh: 15, gap: 5, stmtTop: 34,
            bubbleH: 42, bubbleFs: 13, badgeH: 22, x0: 185, x1: 455, tx0: 195, tx1: 445 };
        Object.assign(g, { compact, mid: (g.x0 + g.x1) / 2 });
        const ch = g.stmtTop + nLines * g.lh + (nStmt - 1) * g.gap + 24 + g.bubbleH + 6 + g.badgeH + 6;
        g.card = { A: { x: g.cx[0], y: g.cy, w: g.cw, h: ch }, B: { x: g.cx[1], y: g.cy, w: g.cw, h: ch } };
        const cardBottom = g.cy + ch;
        g.linkY = cardBottom - 6 - g.badgeH / 2;
        let y = compact ? cardBottom + 14 : g.cy;   // data area: under the cards on phones, between them on desktop
        g.titleY = y + 10; y += 22;
        if (scen === "doctors") {
          const rw = compact ? 168 : 130, rh = def === "lock" ? 100 : 56;   // room for lock + wait chips
          g.rec = { A: { x: g.x0, y, w: rw, h: rh }, B: { x: g.x1 - rw, y, w: rw, h: rh } };
          y += rh;
        } else {
          if (def === "exclude") { g.schemaY = y; y += 42; }
          Object.assign(g, { labelsY: y + 5, trackY: y + 18, trackH: compact ? 44 : 50 });
          y = g.trackY + g.trackH;
          if (def === "slots") { Object.assign(g, { cellsTitleY: y + 18, cellsY: y + 28, cellH: 36, waitY: y + 77 }); y += 87; }
        }
        g.H = Math.ceil(Math.max(cardBottom, y) + 8);
        return g;
      }

      // ---------- small drawing helpers ----------
      const rect = (x, y, w, hh, o = {}) => s("rect", {
        x, y, width: w, height: hh, rx: o.rx === undefined ? 6 : o.rx, fill: o.fill || "none",
        stroke: o.stroke || null, "stroke-width": o.sw || 1.5, "stroke-dasharray": o.dash || null,
      });
      const txt = (x, y, str, o = {}) => ctx.text(x, y, str, Object.assign({ size: 12 }, o));
      const tspan = (str, o = {}) => s("tspan", Object.assign({}, o), str);
      const MUTED = { fill: "var(--viz-muted)", "font-weight": 400, "font-size": 12 };
      const italic = el => ctx.attr(el, { "font-style": "italic" });
      const toucher = (st, key) => (st.touch && st.touch.keys.includes(key) ? st.touch.w : null);   // tx reading/writing it now
      function heading(x, y, main, sub, anchor) {
        const t = txt(x, y, "", { size: 13, weight: 700, anchor: anchor || "middle" });
        t.append(tspan(main), tspan("  " + sub, MUTED));
        return t;
      }
      function chip(x, y, w, hh, label, tone, o = {}) {
        const muted = tone === "muted";
        return s("g", null,
          rect(x, y, w, hh, { rx: hh / 2, fill: o.dash ? "none" : muted ? "var(--viz-grid)" : V(tone + "-soft"), stroke: muted ? "var(--viz-line)" : V(tone), dash: o.dash }),
          txt(x + w / 2 + (o.icon ? 7 : 0), y + hh / 2, label, { weight: 700, fill: o.ink || V(tone) }));
      }
      function padlock(x, y) {   // 9 x 12 icon, top-left at (x, y)
        return s("g", null,
          s("path", { d: `M${x + 2},${y + 5} v-2 a2.5,2.5 0 0 1 5,0 v2`, fill: "none", stroke: V("warn"), "stroke-width": 1.6 }),
          rect(x, y + 5, 9, 7, { rx: 1.5, fill: V("warn") }));
      }
      // Appends the chip first so its label can be measured, then puts the padlock just left of it.
      function addLockChip(add, x, y, w, who, key) {
        const label = `locked by ${NAME[who]}`, g = add(chip(x, y, w, 18, label, "warn", { icon: true, ink: "var(--viz-ink)" }), key);
        const tw = (g.lastChild.getComputedTextLength && g.lastChild.getComputedTextLength()) || label.length * 6.2;
        g.append(padlock(x + w / 2 + 7 - tw / 2 - 13, y + 3));
      }

      // ---------- render: redraws the whole scene from state ----------
      function render(st) {
        const g = view.geo, stage = view.stage, fx = [];
        stage.innerHTML = "";
        view.anchors = {};
        const add = (el, key) => { stage.appendChild(el); if (key && st.flash.has(key)) fx.push(el); return el; };
        drawBanner(st, add);
        for (const w of "AB") drawCard(st, w, add);
        if (scen === "doctors") drawDoctors(st, add); else drawBooking(st, add);
        if (!g.compact) drawLinks(st, add);
        updateStats(st);
        return fx;
      }
      function pulse(fx) {
        if (ctx.instant || !fx.length) return Promise.resolve();
        return ctx.tween({ ms: 350, ease: "out", onUpdate: k => fx.forEach(el => { el.style.opacity = 0.1 + 0.9 * k; }) });
      }

      function drawBanner(st, add) {
        const g = view.geo, b = g.banner, doc = scen === "doctors";
        const n = doc ? onCall(st) : booked(st), ok = doc ? n >= 1 : n <= 1, tone = ok ? "ok" : "bad";
        const rule = txt(0, 0, "", { size: g.compact ? 12 : 13, weight: 700, anchor: g.compact ? "middle" : "start" });
        rule.append(tspan("Invariant: ", { fill: "var(--viz-muted)" }), tspan(doc ? "at least 1 doctor on call" : "no overlapping bookings"));
        const now = txt(0, 0, (doc ? `Now: ${n} on call` : `12:00 slot: ${n} booked`) + (ok ? " ✓" : " ✗"),
          { size: g.compact ? 12 : 13, weight: 800, fill: V(tone), anchor: g.compact ? "middle" : "end" });
        // Phones stack the rule over the current value; desktops put them at either end of one line.
        ctx.attr(rule, g.compact ? { x: b.x + b.w / 2, y: b.y + 13 } : { x: b.x + 14, y: b.y + b.h / 2 });
        ctx.attr(now, g.compact ? { x: b.x + b.w / 2, y: b.y + 29 } : { x: b.x + b.w - 14, y: b.y + b.h / 2 });
        add(s("g", null, rect(b.x, b.y, b.w, b.h, { rx: 9, fill: V(tone + "-soft"), stroke: V(tone), sw: ok ? 1.5 : 2.2 }), rule, now), "banner");
      }

      function drawCard(st, w, add) {
        const g = view.geo, c = g.card[w], t = st.tx[w], col = COL[w];
        add(s("g", null,
          rect(c.x, c.y, c.w, c.h, { rx: 10, fill: "var(--viz-panel)", stroke: V(col), sw: 1.6 }),
          txt(c.x + 12, c.y + 14, "Tx " + NAME[w], { size: 13, weight: 700, anchor: "start", fill: V(col) }),
          s("line", { x1: c.x + 8, x2: c.x + c.w - 8, y1: c.y + 25, y2: c.y + 25, stroke: "var(--viz-line)" })));
        const waiting = t.status[1] === "warn";
        let y = c.y + g.stmtTop;
        statements(scen, def, w).forEach((base, i) => {
          const lines = t.alt[i] || base, hgt = lines.length * g.lh;
          const state = t.skip[i] ? "skip" : i === t.cur ? "cur" : i < t.cur ? "done" : "todo";
          const grp = s("g");
          if (state === "cur") {
            const tone = waiting ? "warn" : col;
            grp.append(rect(c.x + 5, y - 3, c.w - 10, hgt + 6, { rx: 5, fill: V(tone + "-soft") }),
              rect(c.x + 5, y - 3, 3, hgt + 6, { rx: 1.5, fill: V(tone) }));
          }
          const ink = state === "todo" || state === "skip" ? "var(--viz-muted)" : "var(--viz-ink)";
          lines.forEach((ln, k) => {
            const yy = y + k * g.lh + g.lh / 2;
            grp.append(txt(c.x + 12, yy, ln, { mono: true, anchor: "start", fill: ink }));
            if (state === "skip") grp.append(s("line", { x1: c.x + 10, x2: c.x + 14 + ln.length * 7.2, y1: yy, y2: yy, stroke: "var(--viz-muted)", "stroke-width": 1.3 }));
          });
          // A result token ("→ 2", "waits") goes on the statement's shortest line.
          const res = state !== "skip" && t.res[i];
          const k = lines.reduce((m, ln, j) => (ln.length < lines[m].length ? j : m), 0);
          if (res) grp.append(txt(c.x + c.w - 9, y + k * g.lh + g.lh / 2, res[0], { anchor: "end", weight: 800, fill: V(res[1]) }));
          add(grp, i === t.cur ? "stmt" + w : null);
          y += hgt + g.gap;
        });

        // The app's decision ("thought bubble") and the transaction's status badge.
        const bx = c.x + 8, bw = c.w - 16, badgeY = c.y + c.h - 6 - g.badgeH, by = badgeY - 6 - g.bubbleH;
        const bub = s("g");
        if (t.bubble) {
          bub.append(rect(bx, by, bw, g.bubbleH, { rx: 12, fill: "var(--viz-bg)", stroke: V(t.tone || col), sw: t.broken ? 2.2 : 1.3 }));
          t.bubble.forEach((ln, k) => bub.append(italic(txt(bx + bw / 2, by + g.bubbleH / 2 + (k - 0.5) * (g.bubbleFs + 3) + (t.broken ? 1 : 0), ln, { size: g.bubbleFs }))));
          if (t.broken) bub.append(rect(bx + bw - 72, by - 12, 66, 16, { rx: 8, fill: V("bad") }), txt(bx + bw - 39, by - 4, "now false", { weight: 800, fill: "var(--viz-bg)" }));
        } else {
          bub.append(rect(bx, by, bw, g.bubbleH, { rx: 12, stroke: "var(--viz-line)", dash: "4 3", sw: 1.2 }),
            italic(txt(bx + bw / 2, by + g.bubbleH / 2, "app decides here", { fill: "var(--viz-muted)" })));
        }
        add(bub, "bubble" + w);
        view.anchors["bubble" + w] = [w === "A" ? c.x + c.w + 2 : c.x - 2, by + g.bubbleH / 2];
        add(chip(bx, badgeY, bw, g.badgeH, t.status[0], t.status[1]), "badge" + w);
      }

      function drawDoctors(st, add) {
        const g = view.geo;
        add(heading(g.mid, g.titleY, "doctors", "shift_id = 1234"));
        for (const w of "AB") {
          const r = g.rec[w], key = "row" + w;
          const touch = toucher(st, key);
          add(s("g", null,
            rect(r.x, r.y, r.w, r.h, { rx: 8, fill: "var(--viz-node)", stroke: touch ? V(COL[touch]) : "var(--viz-node-stroke)", sw: touch ? 2.6 : 1.3 }),
            txt(r.x + 10, r.y + 14, NAME[w], { size: 13, weight: 700, anchor: "start" }),
            txt(r.x + r.w - 10, r.y + 14, "on_call", { anchor: "end", fill: "var(--viz-muted)", mono: true })));
          const [label, tone] = { on: ["on call", "ok"], pend: ["off (uncommitted)", "warn"], off: ["off", "muted"] }[st.rows[w]];
          add(chip(r.x + 8, r.y + 25, r.w - 16, 22, label, tone), "val" + w);
          if (st.locks[key]) addLockChip(add, r.x + 8, r.y + 54, r.w - 16, st.locks[key], "lock" + key);
          const who = st.waiting[key];
          if (who) add(chip(r.x + 8, r.y + 77, r.w - 16, 18, `${NAME[who]} waits`, COL[who], { dash: "4 3" }), "wait" + key);
          view.anchors[key] = [r.x + r.w / 2, r.y + r.h + 2];
        }
      }

      function drawBooking(st, add) {
        const g = view.geo, hw = (g.tx1 - g.tx0) / 8, X = hr => g.tx0 + (hr - 9) * hw;
        const ty = g.trackY, th = g.trackH, mid = ty + th / 2;
        add(heading(g.mid, g.titleY, "bookings", "room 123"));
        if (def === "exclude") {
          add(s("g", null, rect(g.tx0, g.schemaY, g.tx1 - g.tx0, 34, { rx: 6, fill: "var(--viz-panel)", stroke: "var(--viz-line)", sw: 1 }),
            txt(g.mid, g.schemaY + 10, "EXCLUDE USING gist", { mono: true, fill: "var(--viz-muted)" }),
            txt(g.mid, g.schemaY + 24, "(room_id WITH =, during WITH &&)", { mono: true, fill: "var(--viz-muted)" })));
        }
        const track = s("g");
        track.append(rect(g.tx0, ty, g.tx1 - g.tx0, th, { rx: 4, fill: "var(--viz-panel)", stroke: "var(--viz-line)", sw: 1 }));
        for (let hr = 9; hr <= 17; hr++) {
          if (hr > 9 && hr < 17) track.append(s("line", { x1: X(hr), x2: X(hr), y1: ty, y2: ty + th, stroke: "var(--viz-grid)" }));
          const key = hr === 12 || hr === 13;   // with slot rows, the cells below label every hour
          if (def !== "slots" || key || hr === 9 || hr === 17) {
            track.append(txt(X(hr), g.labelsY, String(hr).padStart(2, "0"), { mono: true, weight: key ? 700 : 400, fill: key ? "var(--viz-ink)" : "var(--viz-muted)" }));
          }
        }
        track.append(rect(X(10) + 1, ty + 3, hw * 1.5 - 2, th - 6, { rx: 4, fill: "var(--viz-node)", stroke: "var(--viz-node-stroke)", sw: 1.2 }),
          txt(X(10.75), mid, "Carol", { fill: "var(--viz-muted)", weight: 600 }));   // an existing 10:00–11:30 booking
        add(track);

        // The requested slot: what both checks look at, and where a phantom can appear.
        const touch = toucher(st, "slot");
        const stroke = st.phantom ? V("bad") : touch ? V(COL[touch]) : "var(--viz-muted)";
        add(rect(X(12) - 3, ty - 4, hw + 6, th + 8, { rx: 5, stroke, sw: st.phantom || touch ? 2.2 : 1.3, dash: "4 3" }));
        if (st.phantom) add(txt(X(13) + 9, mid, "no rows to lock", { anchor: "start", weight: 800, fill: V("bad"), halo: true }), "phantom");

        const dbl = booked(st) > 1, bh = th / 2 - 4;
        st.books.forEach(b => {
          const y = ty + (b.w === "A" ? 3 : th / 2 + 1);
          const [fill, line, dash] = dbl && b.s === "done" ? ["bad-soft", "bad"]
            : { pend: ["warn-soft", "warn"], done: [COL[b.w] + "-soft", COL[b.w]], try: [null, COL[b.w], "3 3"], rejected: [null, "bad", "3 3"] }[b.s];
          add(s("g", null,
            rect(X(12) + 1, y, hw - 2, bh, { rx: 3, fill: fill ? V(fill) : "var(--viz-bg)", stroke: V(line), sw: 1.6, dash }),
            txt(X(12) + hw / 2, y + bh / 2, b.s === "rejected" ? "✗" : b.w, { weight: 800, fill: b.s === "rejected" ? V("bad") : "var(--viz-ink)" })), "book" + b.w);
          // Premise links leave from under the slot and cross toward the other transaction.
          view.anchors["book" + b.w] = [X(12) + hw * (b.w === "A" ? 0.3 : 0.7), ty + th + 6];
        });
        if (dbl) add(txt(X(13) + 9, mid, "double-booked", { anchor: "start", weight: 800, fill: V("bad"), halo: true }), "banner");
        if (def === "slots") drawSlots(st, add, X, hw);
      }

      function drawSlots(st, add, X, hw) {
        const g = view.geo, y = g.cellsY;
        add(heading(g.tx0, g.cellsTitleY, "room_slots", "one row per room and hour", "start"));
        const touch = toucher(st, "cell");
        for (let hr = 9; hr < 17; hr++) {
          const is12 = hr === 12, holder = is12 && st.locks.cell;
          const stroke = holder ? V("warn") : is12 && touch ? V(COL[touch]) : "var(--viz-node-stroke)";
          const grp = s("g", null,
            rect(X(hr) + 1, y, hw - 2, g.cellH, { rx: 4, fill: holder ? V("warn-soft") : "var(--viz-node)", stroke, sw: holder || (is12 && touch) ? 2.2 : 1 }),
            txt(X(hr) + hw / 2, y + 11, String(hr).padStart(2, "0"), { mono: true, fill: is12 ? "var(--viz-ink)" : "var(--viz-muted)", weight: is12 ? 700 : 400 }));
          if (holder) grp.append(txt(X(hr) + hw / 2, y + 26, holder, { weight: 800, fill: V(COL[holder]) }));
          add(grp, is12 ? "lockcell" : null);
        }
        const who = st.waiting.cell, cx = X(12) + hw / 2;
        if (who) {
          add(s("g", null,
            s("circle", { cx, cy: g.waitY, r: 8, fill: "var(--viz-bg)", stroke: V(COL[who]), "stroke-width": 1.5, "stroke-dasharray": "3 2" }),
            txt(cx, g.waitY, who, { weight: 800, fill: V(COL[who]) }),
            txt(cx + 13, g.waitY, `${NAME[who]} waits for this row`, { anchor: "start", weight: 700, fill: V(COL[who]) })), "waitcell");
        }
      }

      function drawLinks(st, add) {
        if (!st.links.length) return;
        const g = view.geo, grp = s("g");
        st.links.forEach(l => {
          const a = view.anchors[l.from], b = view.anchors["bubble" + l.to];
          if (!a || !b) return;
          const c = V(l.tone), dir = b[0] > a[0] ? 1 : -1;
          grp.append(s("path", {
            d: `M${a[0]},${a[1]} C${a[0]},${a[1] + 55} ${b[0] - dir * 70},${b[1]} ${b[0]},${b[1]}`,
            fill: "none", stroke: c, "stroke-width": 2, "stroke-dasharray": l.tone === "bad" ? "6 4" : null, "marker-end": view.svg.arrow(c),
          }));
        });
        if (st.linkLabel) grp.append(txt(g.mid, g.linkY, st.linkLabel, { weight: 800, fill: V(st.links[0].tone), halo: true }));
        add(grp, "links");
      }

      function updateStats(st) {
        const doc = scen === "doctors", n = doc ? onCall(st) : booked(st);
        view.stats.set("inv", String(n), (doc ? n >= 1 : n <= 1) ? "ok" : "bad");
        view.stats.set("locked", st.locked ? st.locked[0] : "–", st.locked ? st.locked[1] : "");
        view.stats.set("waits", String(st.waits), st.waits ? "warn" : "");
        view.stats.set("out", st.outcome ? st.outcome[0] : "–", st.outcome ? st.outcome[1] : "");
      }

      // ---------- stepper: six steps whose text and actions come from the current script ----------
      const steps = [0, 1, 2, 3, 4, 5].map(i => ({
        title: "", detail: "",
        run: async st => {
          st.touch = null; st.flash = new Set();
          const show = async ms => { const fx = render(st); st.flash = new Set(); await pulse(fx); if (ms) await ctx.sleep(ms); };
          await script().steps[i][2](st, show);
          await show(0);
        },
      }));
      const noteFor = i => (i >= steps.length - 1 ? script().final
        : ["Both transactions check the rule, and both are right about what they saw. " + INTRO[def], "info"]);
      const stepOpts = {
        steps, delay: 1500,
        init() { const st = freshState(); render(st); return st; },
        onStep: i => view.note.set(...noteFor(i)),
      };
      function syncSteps() {
        script().steps.forEach(([title, detail], i) => Object.assign(steps[i], { title, detail }));
        stepOpts.intro = (scen === "doctors"
          ? "Alice and Bob are both on call for shift 1234, and both feel unwell."
          : "Alice and Bob both want Room 123 from 12:00 to 13:00.") + " Press <b>Play</b> or <b>Step ▶</b>.";
      }

      function build() {
        compact = ctx.compact;
        root.innerHTML = "";
        const geo = layout();
        const svg = ctx.svg({ w: geo.W, h: geo.H, label: "Two transactions, Alice's and Bob's, checking and changing the same data" });
        const stage = svg.appendChild(s("g"));
        const scenSeg = ui.segmented({ label: "Scenario", value: scen, options: SCENARIOS,
          onChange: v => { if (v !== scen) { scen = v; def = "none"; rebuild(-1); } } });
        const defSeg = ui.segmented({
          label: "Defense", value: def,   // "None" keeps all four options on one row on phones
          options: DEFENSES[scen].map(o => (compact && o.value === "none" ? { value: "none", label: "None" } : o)),
          onChange: v => { if (v !== def) { def = v; rebuild(-1); } },
        });
        const stats = ui.stats([{ key: "inv", label: scen === "doctors" ? "On call" : "Bookings at 12:00" },
          { key: "locked", label: "Rows locked by the check" }, { key: "waits", label: "Waits" }, { key: "out", label: "Outcome" }]);
        view = { geo, svg, stage, anchors: {}, stats, note: ui.note(...noteFor(-1)) };
        syncSteps();
        if (!player) player = ctx.stepper(stepOpts);
        const legend = ui.legend([{ color: V("c6"), label: "Alice's tx" }, { color: V("c5"), label: "Bob's tx" },
          { color: V("warn"), label: "uncommitted / lock", shape: "square" }, { color: V("bad"), label: "invariant violated", shape: "square" }]);
        root.append(ui.bar(scenSeg, defSeg), svg, legend, player.el, view.note, stats);
      }
      // Rebuild the scene and replay to step `index` (-1 = start).
      const rebuild = index => { build(); player.goto(index); };

      build();
      ctx.onResize(() => { if (ctx.compact !== compact) rebuild(player.index); });
    },
  });
})();
