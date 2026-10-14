// Is this history linearizable? One register x, a single Writer, two readers (Alice and Bob)
// and three replicas. Choose where reads go and how far the slow replica lags; a checker
// flags stale reads and reads that go back in time, and draws the real-time order they break.
(function () {
  "use strict";

  // ---- model (pure; every time is an integer number of ms) ----
  const D = 250;                       // one-way client <-> replica hop
  const F1_LAG = 300;                  // the fast follower's fixed lag
  const IDLE = 600;                    // the clock keeps running this long after the last activity
  const MAX_OPS = 14, MAX_T = 20000;
  const SCENARIO = [[200, "writer"], [800, "alice"], [1900, "bob"]];
  const ROUTES = {
    leader: { reps: ["L", "F1", "F2"], alice: ["L"], bob: ["L"] },
    followers: { reps: ["L", "F1", "F2"], alice: ["F1"], bob: ["F2"] },
    quorum: { reps: ["R1", "R2", "R3"], alice: ["R1", "R2"], bob: ["R2", "R3"] },
  };

  function newSim(mode, lag, repair) {
    const sim = { mode, lag, repair, now: 0, lastActivity: -IDLE, queue: [], seq: 0, maxT: 0,
      ops: [], applies: {}, arrivals: [], msgs: [], nextV: 1, scripted: 0, canonical: false };
    ROUTES[mode].reps.forEach(r => { sim.applies[r] = []; });
    sim.analysis = analyze(sim.ops);
    return sim;
  }

  // Event queue ordered by (t, prio, seq). prio: 0 replica apply, 1 read sampling,
  // 2 op completion, 3 scripted op issue.
  function schedule(sim, t, prio, fn) {
    sim.queue.push({ t, prio, seq: sim.seq++, fn });
    sim.queue.sort((a, b) => a.t - b.t || a.prio - b.prio || a.seq - b.seq);
    sim.maxT = Math.max(sim.maxT, t);
  }
  function processUntil(sim, t) {
    while (sim.queue.length && sim.queue[0].t <= t) {
      const ev = sim.queue.shift();
      sim.now = sim.lastActivity = ev.t;
      ev.fn(ev.t);
    }
    sim.now = Math.max(sim.now, t);
  }
  function runAll(sim) {
    const any = sim.queue.length > 0;
    while (sim.queue.length) processUntil(sim, sim.queue[0].t);
    // Same as the animated clock, which idles on for IDLE after the last event: the next op
    // starts strictly after everything so far has finished.
    if (any) sim.now += IDLE;
    sim.lastActivity = sim.now - IDLE; // idle: the clock stays stopped
  }
  const busy = sim => sim.queue.length > 0 || sim.now - sim.lastActivity < IDLE;

  const valueAt = (sim, rep, t) => sim.applies[rep].reduce((m, a) => (a.t <= t && a.v > m ? a.v : m), 0);
  function arrive(sim, rep, t, v, kind) {
    sim.arrivals.push({ rep, t, v, kind });
    if (v > valueAt(sim, rep, t)) sim.applies[rep].push({ t, v }); // older versions are ignored
  }
  function send(sim, from, to, tf, tt, kind, v) {
    sim.msgs.push({ from, to, tf, tt, kind });
    schedule(sim, tt, 0, t => arrive(sim, to, t, v, kind));
  }

  function issueWrite(sim, t) {
    const v = sim.nextV++;
    const op = { client: "writer", kind: "w", start: t, end: null, value: v };
    sim.ops.push(op);
    let end;
    if (sim.mode === "quorum") {
      const extra = { R1: 0, R2: Math.round(0.75 * sim.lag), R3: sim.lag };
      for (const r in extra) send(sim, "writer", r, t, t + D + extra[r], "write", v);
      end = Object.values(extra).map(x => t + 2 * D + x).sort((a, b) => a - b)[1]; // 2nd ack: W = 2
    } else {
      send(sim, "writer", "L", t, t + D, "write", v);
      send(sim, "L", "F1", t + D, t + D + F1_LAG, "repl", v);
      send(sim, "L", "F2", t + D, t + D + sim.lag, "repl", v);
      end = t + 2 * D; // the leader acks right after applying
    }
    schedule(sim, end, 2, at => finish(sim, op, at));
  }

  function issueRead(sim, client, t) {
    const reps = ROUTES[sim.mode][client];
    const op = { client, kind: "r", start: t, end: null, value: null, reps, samples: [], repaired: [] };
    sim.ops.push(op);
    reps.forEach(r => sim.msgs.push({ from: client, to: r, tf: t, tt: t + D, kind: "read" }));
    schedule(sim, t + D, 1, at => {
      op.samples = reps.map(rep => ({ rep, t: at, v: valueAt(sim, rep, at) }));
      schedule(sim, at + D, 2, at2 => replies(sim, op, at2));
    });
  }

  // The reader learns the versions only when the replies arrive, so any repair starts here.
  function replies(sim, op, t) {
    op.value = Math.max(...op.samples.map(x => x.v));
    if (sim.mode === "quorum" && sim.repair) op.repaired = op.samples.filter(x => x.v < op.value).map(x => x.rep);
    if (!op.repaired.length) return finish(sim, op, t);
    op.repaired.forEach(r => send(sim, op.client, r, t, t + D, "repair", op.value));
    schedule(sim, t + 2 * D, 2, at => finish(sim, op, at)); // wait for the repair acks
  }

  function finish(sim, op, t) {
    op.end = t;
    sim.analysis = analyze(sim.ops);
  }

  function issue(sim, who, t) {
    sim.lastActivity = t;
    if (who === "writer") issueWrite(sim, t); else issueRead(sim, who, t);
  }

  function scheduleScenario(sim) {
    sim.canonical = true;
    sim.scripted = SCENARIO.length;
    SCENARIO.forEach(([t, who]) => schedule(sim, t, 3, at => { sim.scripted--; issue(sim, who, at); }));
  }

  // Exact for one sequential writer with increasing values: rules A + C (regular register)
  // plus rule B (no new-old inversion) are equivalent to linearizability.
  function analyze(ops) {
    const done = ops.filter(o => o.end !== null);
    const writes = done.filter(o => o.kind === "w"), reads = done.filter(o => o.kind === "r");
    const res = { done: done.length, reads: reads.length, stale: [], back: [], future: 0 };
    for (const r of reads) {
      const w = writes.filter(o => o.end < r.start).reduce((m, o) => (!m || o.value > m.value ? o : m), null);
      if (w && r.value < w.value) res.stale.push({ r, w });                          // rule A
      const r2 = reads.filter(o => o.end < r.start && o.value > r.value)
        .reduce((m, o) => (!m || o.value > m.value || (o.value === m.value && o.end > m.end) ? o : m), null);
      if (r2) res.back.push({ r, r2 });                                               // rule B
      const src = ops.find(o => o.kind === "w" && o.value === r.value);
      if (r.value > 0 && src && src.start > r.end) {                                  // rule C (guard)
        res.future++;
        console.error("linearizability-checker: read returned a value from the future", r);
      }
    }
    res.ok = !res.stale.length && !res.back.length && !res.future;
    return res;
  }

  // ---- explanations ----
  const NAME = { writer: "Writer", alice: "Alice", bob: "Bob", L: "the Leader", F1: "F1", F2: "F2", R1: "R1", R2: "R2", R3: "R3" };
  const PRON = { alice: ["she", "hers"], bob: ["he", "his"] };
  const secs = ms => (ms / 1000).toFixed(1) + " s";
  const from = r => (r.reps.length > 1 ? `{${r.reps.join(",")}}` : NAME[r.reps[0]]);
  const latest = list => list.reduce((m, x) => (!m || x.r.end > m.r.end ? x : m), null);

  function violationText(sim, a) {
    const b = latest(a.back), st = latest(a.stale);
    if (b && (!st || b.r.end >= st.r.end)) {
      const { r, r2 } = b, who = NAME[r.client], who2 = NAME[r2.client];
      if (sim.mode === "quorum" && !a.stale.some(x => x.r === r)) {
        return `W + R &gt; N, yet ${who} went back in time. ${who2}'s quorum ${from(r2)} included the fast replica R1; ` +
          `${who}'s quorum ${from(r)} contained only stale replicas. The write hadn't finished, so ${who} reading ${r.value} ` +
          `on its own would be allowed; reading ${r.value} after ${who2} read ${r2.value} is not.`;
      }
      return `${who2}'s read from ${from(r2)} returned x=${r2.value}. ${who}'s read started after ${PRON[r2.client][1]} had ` +
        `finished, but ${from(r)} hadn't applied the write yet, so ${PRON[r.client][0]} got x=${r.value}. Once any read has ` +
        `returned the new value, every later read must too: <b>not linearizable</b>.`;
    }
    if (st) {
      return `The write of x=${st.w.value} had finished before ${NAME[st.r.client]}'s read started, but ${from(st.r)} hadn't ` +
        `applied it yet, so ${PRON[st.r.client][0]} got x=${st.r.value}: a stale read. A completed write must be visible to ` +
        `every read that starts after it: <b>not linearizable</b>.`;
    }
    return "A read returned a value whose write had not even started: <b>not linearizable</b>.";
  }

  function explain(sim) {
    const a = sim.analysis, lag = secs(sim.lag);
    const canon = sim.canonical && sim.ops.length === SCENARIO.length;
    if (sim.scripted || (canon && sim.ops.some(o => o.end === null)))
      return ["Replaying: the Writer writes x=1 at 0.2 s, Alice reads at 0.8 s, Bob reads at 1.9 s.", "info"];
    if (!a.reads)
      return ["Press <b>Write x+1</b>, then let Alice and Bob read. Once any read has returned the new value, no read that starts later may return the old one.", "info"];
    if (!a.ok) return [violationText(sim, a), "bad"];
    if (sim.mode === "leader")
      return ["Every read goes to the leader, which applied x before acknowledging the write, so each read sees the latest completed write. Linearizable, as long as this node really is still the leader (see fencing in ch8).", "ok"];
    if (sim.mode === "followers") {
      if (canon) return ["F2 caught up before Bob's read arrived, so this run looks fine, but nothing guarantees it. Drag the lag past 1.7 s.", "info"];
      if (sim.lag <= 500) return [`With only ${lag} of lag, F2 catches up before any later read can reach it. Increase the lag.`, "info"];
      return [`Linearizable so far, but F2 lags ${lag} behind. Try: <b>Write x+1</b>, let Alice read the new value, then have Bob read at once.`, "info"];
    }
    if (!sim.repair) {
      if (canon) return ["R2 got the write before Bob's read reached it, so the quorums happened to overlap on fresh data. Drag the lag past 2.2 s.", "info"];
      if (sim.lag < 700) return [`With only ${lag} of lag, R2 gets each write before any later read can reach it. Increase the lag.`, "info"];
      return ["No read has gone back in time yet. Both quorums share R2, but R2 can lag behind R1: <b>Write x+1</b>, let Alice read the new value, then have Bob read before R2 catches up.", "info"];
    }
    const fixes = sim.ops.filter(o => o.end !== null && o.kind === "r" && o.repaired.length);
    const fixed = canon ? fixes[0] : fixes[fixes.length - 1], also = canon && fixes[1];
    if (fixed) {
      return [`${NAME[fixed.client]} saw two different versions and wrote x=${fixed.value} back to ${fixed.repaired.join(" and ")} ` +
        `before answering, so a majority ${from(fixed)} now holds ${fixed.value}` +
        (also ? ` (${NAME[also.client]}'s read later did the same for ${also.repaired.join(" and ")}). ` : ". ") +
        "Every later quorum overlaps that majority, so no read can go back in time. The price: reads that find " +
        "disagreement take an extra round trip (ABD-style). That is enough for reads and writes, never for compare-and-set.", "ok"];
    }
    return [canon ? "Alice's two replicas already agreed, so no repair was needed. Drag the lag above 0.8 s to make her see two versions."
      : "No read has seen two different versions yet, so nothing needed repairing.", "ok"];
  }

  // ---- view ----
  const LAYOUT = {
    desk: { W: 640, H: 236, laneY: 28, laneH: 180, gutter: 70, fs: 12, head: [16] },
    phone: { W: 360, H: 248, laneY: 40, laneH: 180, gutter: 52, fs: 11, head: [14, 30] },
  };
  const MSG_COLOR = { write: "var(--viz-c6)", read: "var(--viz-c6)", repl: "var(--viz-c1)", repair: "var(--viz-warn)" };
  const textW = (str, size) => str.length * size * 0.6;

  function routing(mode, lag, compact) {
    const repl = `Writer → Leader → F1 (lag ${secs(F1_LAG)}), F2 (lag ${secs(lag)})`;
    const lines = {
      leader: [repl, "Alice and Bob both read from the Leader"],
      followers: [repl, "Alice reads F1 · Bob reads F2"],
      quorum: [`Write ${compact ? "→" : "reaches"} R1 fast, R2 after 0.75 × lag, R3 after lag`, "Alice reads {R1,R2} · Bob reads {R2,R3}"],
    }[mode];
    return compact ? lines : [lines.join(" · ")];
  }

  // Greedy label placement: each label takes the first candidate spot that is inside the
  // drawing and doesn't overlap a bar, a dot or an earlier label.
  // Message lines are soft obstacles: a label avoids them when it can, but may sit on one
  // (with its halo) rather than vanish.
  function placer(W, yMax) {
    const boxes = [], soft = [];
    const box = (x, y, w, h) => ({ x1: x - w / 2, x2: x + w / 2, y1: y - h / 2, y2: y + h / 2 });
    const hit = (b, list) => list.some(o => b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1);
    const inside = b => b.x1 >= 0 && b.x2 <= W && b.y2 <= yMax;
    return {
      block(x, y, w, h) { boxes.push(box(x, y, w, h)); },
      line(x1, y1, x2, y2) {
        const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 5));
        for (let i = 0; i <= n; i++) soft.push(box(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n, 3, 3));
      },
      fit(cands, w, h) {
        for (const strict of [true, false]) {
          for (const [x, y] of cands) {
            const b = box(x, y, w + 4, h + 2);
            if (inside(b) && !hit(b, boxes) && !(strict && hit(b, soft))) { boxes.push(b); return [x, y]; }
          }
        }
        return null; // crowded: better no label than an unreadable one
      },
    };
  }

  Viz.register("ch9/linearizability-checker", {
    title: "Is this history linearizable?",
    mount(root, ctx) {
      const { s, ui } = ctx;
      // State lives outside build() so a phone <-> desktop rebuild keeps it.
      let mode = "followers", lag = 2500, repair = false;
      let sim = null, view = null, stopClock = null, compact = ctx.compact;

      function halt() { if (stopClock) { stopClock(); stopClock = null; } }
      function restart(animated) {
        halt();
        sim = newSim(mode, lag, repair);
        scheduleScenario(sim);
        if (animated && !ctx.instant) startClock(); else runAll(sim);
        draw();
      }
      function clearAll() { halt(); sim = newSim(mode, lag, repair); draw(); }
      function act(who) {
        issue(sim, who, sim.now);
        if (ctx.instant) runAll(sim); else startClock();
        draw();
      }
      // Virtual time runs at 1 s per real second, but only while something is happening.
      function startClock() {
        if (stopClock) return;
        stopClock = ctx.raf(dt => {
          processUntil(sim, sim.now + Math.round(dt * 1000));
          if (!busy(sim)) halt();
          draw();
        });
      }

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const L = compact ? LAYOUT.phone : LAYOUT.desk;
        const seg = ui.segmented({
          label: "Reads go to", value: mode,
          options: [{ value: "leader", label: "Leader" }, { value: "followers", label: "Followers" },
            { value: "quorum", label: "Quorum (N=3, W=2, R=2)" }],
          onChange: v => { mode = v; restart(false); },
        });
        const lagSlider = ui.slider({
          label: "Replication lag (slow replica)", min: 0, max: 3, step: 0.1, value: lag / 1000,
          format: v => v.toFixed(1) + " s", onInput: v => { lag = Math.round(v * 1000); restart(false); },
        });
        const tog = ui.toggle({ label: "Sync read repair", value: repair, onChange: v => { repair = v; restart(false); } });
        const btn = {
          writer: ui.button("Write x+1", () => act("writer"), { kind: "primary" }),
          alice: ui.button("Alice reads", () => act("alice")),
          bob: ui.button("Bob reads", () => act("bob")),
        };
        const svg = ctx.svg({ w: L.W, h: L.H, label: "History of writes and reads on a timeline, with replica applies" });
        const axis = s("g"), head = s("g");
        svg.append(axis, head);
        const stats = ui.stats([
          { key: "verdict", label: "Verdict" }, { key: "reads", label: "Reads" },
          { key: "stale", label: "Stale reads" }, { key: "back", label: "Back in time" },
        ]);
        const note = ui.note("");
        root.append(
          ui.bar(seg, lagSlider, tog),
          svg,
          ui.bar(btn.writer, btn.alice, btn.bob,
            ui.button("▶ Replay scenario", () => restart(true), { kind: "ghost" }),
            ui.button("Clear", clearAll, { kind: "ghost" })),
          stats, note,
          ui.legend([
            { color: "var(--viz-ok)", label: "valid read", shape: "square" },
            { color: "var(--viz-bad)", label: "violates linearizability", shape: "square" },
            { color: "var(--viz-warn)", label: "in flight", shape: "dash" },
            { color: "var(--viz-c6)", label: "write", shape: "square" },
            { color: "var(--viz-ok)", label: "replica applied x", shape: "dot" },
            { color: "var(--viz-warn)", label: "read repair", shape: "dot" },
          ]));
        view = { L, svg, axis, head, tl: null, laneKey: "", infoKey: "", stats, note, tog, btn };
      }

      // Lanes and time axis; rebuilt whenever the mode or the time domain changes.
      function buildLanes(t1) {
        const v = view, L = v.L;
        if (v.tl) v.tl.root.remove();
        const reps = ROUTES[sim.mode].reps.map(r => ({
          id: r, label: r === "L" ? (compact ? "Ldr" : "Leader") : r, color: r === "L" ? "c1" : "c2",
        }));
        v.tl = ctx.lanes({
          parent: v.svg, x: 0, y: L.laneY, w: L.W, h: L.laneH, t0: 0, t1: t1 * 1000, labelWidth: L.gutter,
          lanes: [{ id: "writer", label: "Writer", color: "c6" }, { id: "alice", label: "Alice", color: "c6" },
            { id: "bob", label: "Bob", color: "c6" }, ...reps],
        });
        v.axis.innerHTML = "";
        const pxPerS = (L.W - L.gutter - 8) / t1, yb = L.laneY + L.laneH;
        const step = [1, 2, 5, 10].find(k => k * pxPerS >= (compact ? 30 : 36)) || 10;
        for (let sec = 0; sec <= t1; sec += step) {
          const x = v.tl.x(sec * 1000), label = sec + " s";
          const right = x + textW(label, L.fs) / 2 > L.W;
          v.axis.append(
            s("line", { x1: x, x2: x, y1: L.laneY, y2: yb + 4, stroke: "var(--viz-line)", "stroke-width": 1, opacity: 0.35 }),
            ctx.text(right ? L.W : x, yb + 13, label, { size: L.fs, fill: "var(--viz-muted)", anchor: right ? "end" : "middle" }));
        }
        v.laneKey = sim.mode + t1;
      }

      function drawMsg(tl, m, now, P) {
        if (m.tf > now) return;
        const x1 = tl.x(m.tf), x2 = tl.x(m.tt), y1 = tl.y(m.from), y2 = tl.y(m.to);
        const dir = y2 > y1 ? 1 : -1, ya = y1 + dir * 7, yb = y2 - dir * 7;
        const k = m.tt > m.tf ? Math.min(1, (now - m.tf) / (m.tt - m.tf)) : 1;
        const xe = x1 + (x2 - x1) * k, ye = ya + (yb - ya) * k, col = MSG_COLOR[m.kind];
        P.line(x1, ya, xe, ye);
        const g = s("g", { opacity: m.kind === "repair" ? 0.9 : 0.5 });
        g.appendChild(s("path", { d: `M${x1},${ya} L${xe},${ye}`, fill: "none", stroke: col, "stroke-width": 1.3,
          "marker-end": k === 1 ? view.svg.arrow(col) : null }));
        if (k < 1) g.appendChild(s("circle", { cx: xe, cy: ye, r: 3, fill: col })); // still in transit
        tl.content.appendChild(g);
      }

      function draw() {
        const v = view, L = v.L, fs = L.fs, now = sim.now, a = sim.analysis;
        // The idle tail after the last event (< 0.7 s) doesn't stretch the axis; the cursor is clamped.
        const t1 = Math.max(4, Math.ceil((sim.maxT + 500) / 1000));
        if (v.laneKey !== sim.mode + t1) buildLanes(t1);
        const tl = v.tl, P = placer(L.W, L.laneY + L.laneH);
        tl.clear();

        v.head.innerHTML = "";
        routing(sim.mode, sim.lag, compact).forEach((line, i) => {
          v.head.appendChild(ctx.text(6, L.head[i], line, { size: fs, anchor: "start", fill: "var(--viz-muted)" }));
          P.block(6 + textW(line, fs) / 2, L.head[i], textW(line, fs), fs + 2);
        });
        P.block(L.gutter / 2, L.laneY + L.laneH / 2, L.gutter, L.laneH);

        sim.msgs.forEach(m => drawMsg(tl, m, now, P));

        const labels = { conn: [], op: [], mark: [] };
        const bad = new Set([...a.stale, ...a.back].map(x => x.r));
        const hh = Math.min(22, tl.laneHeight * 0.62);
        sim.ops.forEach(op => {
          const done = op.end !== null, tb = done ? op.end : now;
          const val = done || op.kind === "w" ? op.value : "?";
          const variants = op.kind === "w" ? [`w x=${val}`, `x=${val}`, `${val}`] : [`r→${val}`, `→${val}`, `${val}`];
          const style = op.kind === "w" ? { color: "c6" } : { tone: !done ? "warn" : bad.has(op) ? "bad" : "ok" };
          const x1 = tl.x(op.start), w = Math.max(4, tl.x(tb) - x1), y = tl.y(op.client), cx = x1 + w / 2;
          const inside = variants.find(t => w >= textW(t, fs) + 4); // shorter labels as bars get narrow
          tl.op(op.client, op.start, tb, { ...style, dashed: !done, label: inside || null, size: fs, mono: true });
          P.block(cx, y, w, hh);
          if (!inside) labels.op.push({ text: variants[0], fill: "var(--viz-ink)", cands: [[cx, y - hh / 2 - fs / 2 - 3], [cx, y + hh / 2 + fs / 2 + 3]] });
        });

        sim.arrivals.forEach(ar => {
          const fix = ar.kind === "repair", x = tl.x(ar.t), y = tl.y(ar.rep);
          tl.mark(ar.rep, ar.t, { tone: fix ? "warn" : "ok" });
          P.block(x, y, 12, 12);
          const text = fix ? `fix ${ar.v}` : `x=${ar.v}`, dx = textW(text, fs) / 2 + 9;
          // Messages arrive from the upper left, so the upper right of a dot is usually free.
          labels.mark.push({ text, fill: fix ? "var(--viz-warn)" : "var(--viz-ok)",
            cands: [[x + dx, y - 10], [x, y - 14], [x - dx, y - 10], [x + dx, y + 11], [x, y + 15], [x - dx, y + 11]] });
        });
        sim.ops.forEach(op => (op.samples || []).forEach(x => tl.mark(x.rep, x.t, { color: "c6", r: 3 })));

        // Rule A reads best from the write ("done before" ...), rule B from the later read.
        const conns = [
          ...a.stale.map(x => ["writer", x.w.end, x.r, "done before", true]),
          ...a.back.map(x => [x.r2.client, x.r2.end, x.r, "later read", false]),
        ];
        conns.forEach(([lane, t, r, text, atStart]) => {
          tl.msg(lane, t, r.client, r.start, { color: "bad", dashed: true });
          const x1 = tl.x(t), x2 = tl.x(r.start), y1 = tl.y(lane), y2 = tl.y(r.client), half = textW(text, fs) / 2 + 5;
          const pad = Math.min(10, tl.laneHeight * 0.25) * (y2 > y1 ? 1 : -1), ya = y1 + pad, yb = y2 - pad;
          const ends = [[x1 + half, y1], [x2 - half, y2]];
          const cands = atStart ? ends : ends.reverse();
          [0.5, 0.35, 0.65, 0.2, 0.8].forEach(f => [-11, 11].forEach(dy =>
            cands.push([x1 + f * (x2 - x1), ya + f * (yb - ya) + dy])));
          labels.conn.push({ text, fill: "var(--viz-bad)", cands, backdrop: true, line: [x1, ya, x2, yb] });
        });

        // Most important first: violation labels, then op labels, then replica marks. A
        // connector's own label sits on it; later labels steer clear of the connector.
        [...labels.conn, ...labels.op, ...labels.mark].forEach(lb => {
          const w = textW(lb.text, fs), at = P.fit(lb.cands, w, fs);
          if (lb.line) P.line(...lb.line);
          if (!at) return;
          // A halo doesn't cover the gap between words, so multi-word labels get a backdrop.
          if (lb.backdrop) tl.content.appendChild(s("rect", { x: at[0] - w / 2 - 2, y: at[1] - fs / 2 - 1, width: w + 4, height: fs + 2, rx: 3, fill: "var(--viz-bg)", opacity: 0.9 }));
          tl.content.appendChild(ctx.text(at[0], at[1], lb.text, { size: fs, weight: 600, fill: lb.fill, mono: true, halo: true }));
        });

        if (stopClock) {
          const tc = Math.min(now, t1 * 1000), x = tl.x(tc);
          tl.cursor(tc, { label: "" });
          const right = x + 4 + textW("now", fs) > L.W;
          tl.overlay.appendChild(ctx.text(right ? x - 4 : x + 4, L.laneY + 2, "now", {
            size: fs, weight: 700, fill: "var(--viz-warn)", anchor: right ? "end" : "start", baseline: "hanging", halo: true }));
        }
        update();
      }

      function update() {
        const v = view, a = sim.analysis;
        const full = sim.ops.length >= MAX_OPS || sim.now >= MAX_T;
        ["writer", "alice", "bob"].forEach(who => v.btn[who].disable(
          full || sim.scripted > 0 || sim.ops.some(o => o.client === who && o.end === null)));
        const togInput = v.tog.querySelector("input");
        togInput.disabled = sim.mode !== "quorum";
        v.tog.style.opacity = togInput.disabled ? 0.45 : "";
        v.tog.style.cursor = togInput.disabled ? "not-allowed" : "";

        const [html, tone] = explain(sim);
        const note = html + (full ? " <b>History full:</b> press Clear or Replay scenario." : "");
        const stale = a.stale.length + a.future, key = [note, tone, a.done, a.reads, stale, a.back.length].join("|");
        if (key === v.infoKey) return;
        v.infoKey = key;
        v.note.set(note, tone);
        v.stats.set("verdict", a.done ? (a.ok ? "Linearizable ✓" : "Not linearizable ✗") : "–", a.done ? (a.ok ? "ok" : "bad") : "");
        v.stats.set("reads", a.reads, "");
        v.stats.set("stale", stale, stale ? "bad" : "");
        v.stats.set("back", a.back.length, a.back.length ? "bad" : "");
      }

      build();
      restart(false);
      ctx.onResize(() => { if (ctx.compact !== compact) { build(); draw(); } });
    },
  });
})();
