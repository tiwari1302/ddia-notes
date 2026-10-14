// Lost update race. Alice and Bob each add one like to post 7 (42 likes, version 7) and the
// reader is the scheduler: every click runs one database operation of one transaction. One
// small interpreter runs all five strategies, for the two-transaction story and for the
// 4-client stress test, so the two can never disagree.
(function () {
  "use strict";

  // ---------- Engine (pure, no DOM) ----------
  const START = 42;
  const PROGRAMS = {
    naive: ["read", "write", "commit"],      // explicit transaction at READ COMMITTED
    atomic: ["update", "commit"],            // UPDATE ... SET likes = likes + 1
    forupd: ["lockread", "write", "commit"], // SELECT ... FOR UPDATE
    cas: ["read", "cas"],                    // auto-committed statements, version check
    auto: ["read", "write", "commit"],       // PostgreSQL REPEATABLE READ
  };
  const LOCKING = { write: true, update: true, lockread: true };

  function newRun(strat, names, target) {
    return {
      strat, events: [],
      db: { value: START, version: 7, pending: null, lock: null, queue: [], stack: [], lost: [], log: [] },
      txs: names.map((name, id) => ({ id, name, pc: 0, v: null, ver: null, state: "ready",
        retries: 0, waits: 0, done: 0, target, retrying: false })),
    };
  }

  function emit(run, tx, kind, extra) {
    const { value, version, pending, lock } = run.db;
    run.events.push(Object.assign({ tx: tx.id, kind, db: { value, version, pending, lock } }, extra));
  }

  // The committed counter as a stack of increments: a write computed from a stale read
  // truncates it, and the truncated increments are the lost ones.
  function commitValue(run, tx, value) {
    const db = run.db, entry = { tx: tx.id, n: tx.done };
    db.lost.push(...db.stack.splice(value - 1 - START));
    db.stack.push(entry);
    db.log.push(entry);
    Object.assign(db, { value, version: db.version + 1, pending: null });
  }

  function advance(run, tx) {
    if (++tx.pc < PROGRAMS[run.strat].length) return;
    tx.pc = 0;
    if (++tx.done >= tx.target) tx.state = "done";
  }

  function restart(tx) { tx.pc = 0; tx.retries++; tx.retrying = true; }

  // Runs tx's next operation and appends what happened to run.events.
  function exec(run, tx, resumed) {
    const db = run.db, op = PROGRAMS[run.strat][tx.pc];
    if (LOCKING[op] && db.lock !== null && db.lock !== tx.id) {
      tx.state = "blocked"; tx.waits++; db.queue.push(tx.id);
      return emit(run, tx, "wait", {});
    }
    if (LOCKING[op]) db.lock = tx.id;
    const retry = tx.retrying;
    tx.retrying = false;
    if (op === "read" || op === "lockread") {
      tx.v = db.value; tx.ver = db.version;
      emit(run, tx, op === "read" ? "read" : "lock", { v: tx.v, ver: tx.ver, retry, resumed });
    } else if (op === "update" || op === "write") {
      if (op === "update") tx.v = db.value;   // the database reads the newest committed value
      if (run.strat === "auto" && db.version !== tx.ver) {
        db.lock = null;                         // ERROR 40001: the transaction is rolled back
        restart(tx);
        return emit(run, tx, "abort", { resumed });
      }
      db.pending = tx.v + 1;
      emit(run, tx, "write", { v: db.pending, resumed });
    } else if (op === "cas") {
      if (db.version !== tx.ver) {
        restart(tx);
        return emit(run, tx, "casfail", { ver: tx.ver, now: db.version });
      }
      commitValue(run, tx, tx.v + 1);
      emit(run, tx, "casok", { v: db.value, ver: tx.ver });
    } else {
      commitValue(run, tx, db.pending);
      db.lock = null;
      emit(run, tx, "commit", { v: db.value });
      advance(run, tx);
      // The lock is free: a waiting statement continues at once (and may abort, freeing it again).
      while (db.lock === null && db.queue.length) {
        const w = run.txs[db.queue.shift()];
        w.state = "ready";
        exec(run, w, true);
      }
      return;
    }
    advance(run, tx);
  }

  // One click: returns the events it produced (two when a waiting statement resumes).
  function step(run, id) {
    const from = run.events.length;
    if (run.txs[id].state === "ready") exec(run, run.txs[id], false);
    return run.events.slice(from);
  }

  function stress(strat, rnd) {
    const run = newRun(strat, ["C1", "C2", "C3", "C4"], 25);
    for (let guard = 0; guard < 100000; guard++) {
      const ready = run.txs.filter(t => t.state === "ready");
      if (!ready.length) break;
      exec(run, rnd.pick(ready), false);
    }
    return run;
  }

  const ENGINE = { newRun, step, stress, PROGRAMS };
  if (typeof module !== "undefined") module.exports = ENGINE;   // node tests
  if (typeof Viz === "undefined") return;

  // ---------- Visualization ----------
  Viz.register("ch7/lost-update-race", {
    title: "Lost update race: you pick the interleaving",
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      const STRATS = [["naive", "Naive"], ["atomic", "Atomic op"], ["forupd", "FOR UPDATE"], ["cas", "CAS"], ["auto", "Auto-detect"]]
        .map(([value, label]) => ({ value, label }));
      const MAX_SLOTS = { naive: 7, atomic: 5, forupd: 7, cas: 6, auto: 9 };   // checked by brute force
      const NAMES = ["Alice", "Bob"], LANE = ["Tx A", "Tx B"], COL = ["var(--viz-c6)", "var(--viz-c5)"];
      const SOFT = ["var(--viz-c6-soft)", "var(--viz-c5-soft)"];
      const PRO = [{ he: "she", his: "her" }, { he: "he", his: "his" }];
      const cm = t => `<span class="muted">${t}</span>`;
      const SQL = {
        naive: "BEGIN; SELECT likes FROM posts WHERE id = 7; " + cm("/* app: v + 1 */") +
          " UPDATE posts SET likes = &lt;v+1&gt; WHERE id = 7; COMMIT;" + cm(" · read committed"),
        atomic: "BEGIN; UPDATE posts SET likes = likes + 1 WHERE id = 7; COMMIT;" + cm(" · the app never sees the value"),
        forupd: "BEGIN; SELECT likes FROM posts WHERE id = 7 FOR UPDATE; UPDATE posts SET likes = &lt;v+1&gt; WHERE id = 7; COMMIT;",
        cas: "SELECT likes, version FROM posts WHERE id = 7; UPDATE posts SET likes = &lt;v+1&gt;, version = version + 1 " +
          "WHERE id = 7 AND version = &lt;seen&gt;;" + cm(" · each statement auto-commits; 0 rows means re-read and retry"),
        auto: "BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT likes FROM posts WHERE id = 7; UPDATE posts SET likes = &lt;v+1&gt; " +
          "WHERE id = 7; COMMIT;" + cm(" · PostgreSQL; MySQL InnoDB's REPEATABLE READ would not abort"),
      };
      const INTRO = {
        naive: "Alice and Bob like the same post. You are the scheduler: step each transaction and try to lose a like, or press <b>Play the classic race</b>.",
        atomic: "Atomic op: the increment happens inside the database, under the row lock. Step Alice and Bob in any order and try to lose a like.",
        forupd: "FOR UPDATE: the read itself takes the row lock, so a second reader has to wait. Try to lose a like.",
        cas: "Compare-and-set: no lock is held between statements; the UPDATE applies only if the version is still the one that was read. Try to lose a like.",
        auto: "Automatic detection: PostgreSQL REPEATABLE READ aborts a transaction that would overwrite a change committed after its snapshot. Try to lose a like.",
      };

      let strat = "naive", run, history = [], epoch = 0, stressEpoch = 0, playing = false;
      let compact = ctx.compact, G = null, svg = null, lastStress = null;
      const tried = {};

      // ---------- controls ----------
      const seg = ui.segmented({ label: "Strategy", options: STRATS, value: strat, onChange: v => { strat = v; reset(); } });
      const sql = h("div", { class: "mono", style: "font-size:12px;line-height:1.5;padding:6px 10px;margin:0 0 12px;" +
        "border:1px solid var(--border);border-radius:8px;background:var(--viz-panel);overflow-wrap:anywhere" });
      const btns = [0, 1].map(i => ui.button("", () => click(i), { kind: "primary" }));
      const PLAY = "▶ Play the classic race";
      const btnPlay = ui.button(PLAY, () => (playing ? stop() : playClassic()), { kind: "ghost" });
      const btnUndo = ui.button("↩ Undo", undo, { kind: "ghost" });
      const btnReset = ui.button("⟲ Reset", reset, { kind: "ghost" });
      const sceneBox = h("div");
      const legend = ui.legend([
        { color: COL[0], label: "Tx A (Alice)" }, { color: COL[1], label: "Tx B (Bob)" },
        { color: "var(--viz-warn)", label: "waiting / lock held / uncommitted", shape: "square" },
        { color: "var(--viz-bad)", label: "lost / aborted", shape: "square" },
        { color: "var(--viz-ok)", label: "committed", shape: "square" },
      ]);
      const note = ui.note("");
      const statsFor = expected => ui.stats([
        { key: "exp", label: "Expected", value: expected }, { key: "final", label: "Final value" },
        { key: "lost", label: "Lost updates" }, { key: "wr", label: "Waits / retries" },
      ]);
      const total = (r, key) => r.txs.reduce((a, t) => a + t[key], 0);
      const stats = statsFor(START + 2);
      const challenge = h("div", { style: "font-size:12px;line-height:1.5;display:flex;flex-wrap:wrap;gap:6px;align-items:center" });

      const btnStress = ui.button("Stress test: 4 clients × 25 likes", runStress);
      const gridBox = h("div", { style: "margin-top:10px" });
      const sStats = statsFor(START + 100);
      const sNote = ui.note("");
      const stressOut = h("div", { style: "display:none" }, gridBox, sStats, sNote);

      root.append(
        ui.bar(seg), sql,
        ui.bar(btns[0], btns[1], btnPlay, btnUndo, btnReset),
        sceneBox, legend, note, stats, challenge,
        h("div", { style: "border-top:1px solid var(--border);margin-top:14px;padding-top:12px" },
          ui.bar(btnStress, h("span", { class: "muted", style: "font-size:12.5px" },
            "Same rules, 4 clients adding 25 likes each in a random interleaving (seed 42).")),
          stressOut));

      // ---------- geometry: one description for both orientations ----------
      // t(k) = slot position along the time axis; c = position across lanes. Boxes are [w, h].
      function geom() {
        const n = MAX_SLOTS[strat];
        if (!compact) {
          const x0 = 86, sw = (640 - x0 - 4) / n;
          return { vert: false, W: 640, H: 272, n, c: [44, 228], cdb: 136, t: k => x0 + sw * (k + 0.5), x0,
            chip: [Math.min(sw - 4, 76), 30], dbc: [Math.min(sw - 4, 66), 26], tagH: 20, gap: 3 };
        }
        const y0 = 66, rh = 46;
        return { vert: true, W: 360, H: y0 + rh * (n - 1) + 22, n, c: [40, 320], cdb: 180, t: k => y0 + rh * k,
          chip: [68, 30], dbc: [62, 28], tagH: 24, gap: 3 };
      }
      const xy = (k, c) => (G.vert ? [c, G.t(k)] : [G.t(k), c]);
      const half = box => (G.vert ? box[0] : box[1]) / 2;   // half extent across lanes
      const dir = i => (i === 0 ? 1 : -1);                 // from tx lane i toward the DB lane

      function rect(layer, k, c, box, o) {
        const [x, y] = xy(k, c);
        const g = ctx.box({ x: x - box[0] / 2, y: y - box[1] / 2, w: box[0], h: box[1], rx: 6, size: 12,
          label: o.label, fill: o.fill, stroke: o.stroke, dashed: o.dashed, weight: o.weight });
        layer.appendChild(g);
        return g;
      }

      function tagBox(snap) {
        const w = snap.pending === null ? 24 : G.vert ? 42 : Math.min(G.chip[0] - 4, 50);
        return [w, G.tagH];
      }
      // Edge of the DB column that faces tx lane i in this slot (the lock tag sits in front of it).
      function dbEdge(snap, i) {
        let d = half(G.dbc);
        if (snap.lock === i) d += G.gap + 2 * half(tagBox(snap));
        return G.cdb - dir(i) * d;
      }

      function padlock(layer, x, y) {
        layer.appendChild(s("rect", { x: x - 4.5, y: y - 1.5, width: 9, height: 7, rx: 1.5, fill: "var(--viz-warn)" }));
        layer.appendChild(s("path", { d: `M${x - 2.8},${y - 1.5} v-2.2 a2.8,2.8 0 0 1 5.6,0 v2.2`,
          fill: "none", stroke: "var(--viz-warn)", "stroke-width": 1.6 }));
      }

      function drawDb(layer, k, snap, tone) {
        const fill = tone ? `var(--viz-${tone}-soft)` : "var(--viz-node)";
        const g = rect(layer, k, G.cdb, G.dbc, { fill, stroke: tone ? `var(--viz-${tone})` : "var(--viz-node-stroke)" });
        const [x, y] = xy(k, G.cdb);
        const t = ctx.text(x, y + 1, "", { size: 13, mono: true });
        t.append(s("tspan", { "font-weight": 700 }, String(snap.value)),
          s("tspan", { fill: "var(--viz-muted)", "font-size": 12 }, " v" + snap.version));
        g.appendChild(t);
        if (snap.lock === null) return;
        const box = tagBox(snap), c = G.cdb - dir(snap.lock) * (half(G.dbc) + G.gap + half(box));
        rect(layer, k, c, box, { fill: "var(--viz-warn-soft)", stroke: "var(--viz-warn)", dashed: true });
        const [tx, ty] = xy(k, c);
        if (snap.pending === null) return padlock(layer, tx, ty);
        padlock(layer, tx - box[0] / 2 + 9, ty);
        layer.appendChild(ctx.text(tx + 6, ty + 1, snap.pending + "?", { size: 12, mono: true, weight: 700 }));
      }

      const CHIP = {
        read: e => [`read ${e.v}`], lock: e => [`lock ${e.v}`], write: e => [`write ${e.v}`],
        wait: () => ["waiting", "warn", true], commit: () => ["commit", "ok"], casok: () => ["CAS ok", "ok"],
        casfail: () => ["CAS fail", "bad"], abort: () => ["ABORT", "bad"],
      };

      function line(layer, k, c1, c2, o) {
        const [x1, y1] = xy(k, c1), [x2, y2] = xy(k, c2);
        layer.appendChild(ctx.arrow({ x1, y1, x2, y2, color: o.color, dashed: o.dashed, svg: o.head ? svg : null, arrow: !!o.head }));
        return [x2, y2];
      }

      function drawEvent(layer, k, e) {
        const i = e.tx, [label, tone, dashed] = CHIP[e.kind](e);
        const near = G.c[i] + dir(i) * half(G.chip), far = dbEdge(e.db, i);
        const gapLen = far - near;
        if (e.kind === "read" || e.kind === "lock") line(layer, k, far, near + dir(i) * 2, { color: COL[i], head: true });
        else if (e.kind === "write" || e.kind === "casok") line(layer, k, near, far - dir(i) * 2, { color: COL[i], head: true });
        else if (e.kind === "casfail" || e.kind === "abort") {
          const [x, y] = line(layer, k, near, near + gapLen * 0.62, { color: "var(--viz-bad)", dashed: true });
          layer.appendChild(ctx.text(x, y + 1, "✕", { size: 14, weight: 800, fill: "var(--viz-bad)" }));
        } else if (e.kind === "wait") {
          const end = near + gapLen * 0.45;
          line(layer, k, near, end, { color: "var(--viz-warn)", dashed: true });
          const [x, y] = xy(k, end), d = 7;   // a bar across the stub: blocked here
          layer.appendChild(s("line", Object.assign({ stroke: "var(--viz-warn)", "stroke-width": 2.4 },
            G.vert ? { x1: x, x2: x, y1: y - d, y2: y + d } : { x1: x - d, x2: x + d, y1: y, y2: y })));
        }
        rect(layer, k, G.c[i], G.chip, {
          label, dashed, weight: 600,
          fill: tone ? `var(--viz-${tone}-soft)` : SOFT[i], stroke: tone ? `var(--viz-${tone})` : COL[i],
        });
      }

      // Dashed amber line along a blocked transaction's lane, from "waiting" to where it resumed
      // (or on to the latest slot while it is still blocked).
      function drawWaits(layer) {
        const evs = run.events, along = (G.vert ? G.chip[1] : G.chip[0]) / 2;
        evs.forEach((e, k) => {
          if (e.kind !== "wait") return;
          const j = evs.findIndex((f, m) => m > k && f.tx === e.tx), end = j < 0 ? evs.length - 1 : j;
          if (end <= k) return;
          const [x1, y1] = xy(k, G.c[e.tx]), [x2, y2] = xy(end, G.c[e.tx]), d = j < 0 ? -along * 0.6 : along;
          const pts = G.vert ? { x1, x2, y1: y1 + along, y2: y2 - d } : { y1, y2, x1: x1 + along, x2: x2 - d };
          layer.appendChild(ctx.arrow(Object.assign({ color: "var(--viz-warn)", dashed: true, width: 2, arrow: false }, pts)));
        });
      }

      function drawStatic(layer) {
        const lock = run.db.lock;
        [[G.c[0], LANE[0], NAMES[0], COL[0]],
          [G.cdb, "DB: likes", lock === null ? "no lock held" : "lock: " + "AB"[lock], "var(--viz-ink)", lock !== null],
          [G.c[1], LANE[1], NAMES[1], COL[1]]].forEach(([c, top, sub, col, warn], j) => {
          if (j !== 1) layer.appendChild(s("rect", Object.assign({ rx: 6, fill: "var(--viz-grid)", opacity: 0.35 },
            G.vert ? { x: c - 37, y: 44, width: 74, height: G.H - 46 } : { x: 4, y: c - 29, width: 632, height: 58 })));
          const [x, y] = G.vert ? [c, 15] : [12, c - 8], anchor = G.vert ? "middle" : "start";
          layer.appendChild(ctx.text(x, y, top, { size: 13, weight: 700, fill: col, anchor }));
          layer.appendChild(ctx.text(x, y + 17, sub, { size: 12, anchor, weight: warn ? 700 : null,
            fill: warn ? "var(--viz-warn)" : "var(--viz-muted)" }));
        });
        if (!G.vert) layer.appendChild(ctx.text(G.x0, G.H - 6, "time →", { size: 12, fill: "var(--viz-muted)", anchor: "start" }));
        // Faint outlines where the next click of each ready transaction will land.
        const k = run.events.length;
        if (k < G.n) run.txs.forEach(t => {
          if (t.state !== "ready") return;
          const [x, y] = xy(k, G.c[t.id]);
          layer.appendChild(s("rect", { x: x - G.chip[0] / 2, y: y - G.chip[1] / 2, width: G.chip[0], height: G.chip[1], rx: 6,
            fill: "none", stroke: COL[t.id], "stroke-dasharray": "4 4", opacity: 0.5 }));
        });
      }

      function bothDone() { return run.txs.every(t => t.state === "done"); }

      function buildScene() {
        G = geom();
        svg = ctx.svg({ w: G.W, h: G.H, label: "Sequence diagram of two transactions incrementing the same counter" });
        sceneBox.innerHTML = "";
        sceneBox.appendChild(svg);
        draw(Infinity);
      }

      function draw(animFrom) {
        Array.from(svg.childNodes).forEach(n => { if (n !== svg.defs) n.remove(); });
        const base = s("g"), waits = s("g"), slots = s("g");
        svg.append(base, waits, slots);
        drawStatic(base);
        drawWaits(waits);
        const evs = run.events, fresh = [];
        if (!evs.length) drawDb(slots, 0, run.db, null);
        evs.forEach((e, k) => {
          const g = s("g");
          const last = k === evs.length - 1, bad = last && bothDone() && run.db.value < START + 2;
          drawDb(g, k, e.db, bad ? "bad" : e.kind === "commit" || e.kind === "casok" ? "ok" : null);
          drawEvent(g, k, e);
          if (bad) {
            const lost = START + 2 - run.db.value, [x, y] = xy(k, G.cdb - dir(1) * (half(G.dbc) + (G.vert ? 6 : 13)));
            g.appendChild(ctx.text(x, y, lost + (lost > 1 ? " likes lost" : " like lost"),
              { size: 12, weight: 700, fill: "var(--viz-bad)", anchor: G.vert ? "start" : "middle" }));
          }
          slots.appendChild(g);
          if (k >= animFrom) fresh.push(g);
        });
        if (fresh.length && !ctx.instant) {
          fresh.forEach(g => g.setAttribute("opacity", 0));
          ctx.tween({ ms: 320, ease: "out", onUpdate: v => fresh.forEach(g => g.setAttribute("opacity", v)) });
        }
      }

      // ---------- notes ----------
      const nm = t => t.name, he = t => PRO[t.id].he, his = t => PRO[t.id].his;
      const cap = w => w[0].toUpperCase() + w.slice(1);
      const abortText = t => `The row ${nm(t)} wants to update was changed by a transaction that committed after ${his(t)} snapshot: ` +
        "<b>ERROR 40001</b>, could not serialize access due to concurrent update. The app retries the whole transaction.";

      function readNote(e, me, ot) {
        if (e.retry) return strat === "cas"
          ? [`${nm(me)} re-read <b>${e.v}</b> at version ${e.ver} and will try the CAS again.`, "info"]
          : [`${nm(me)}'s retry is a new transaction with a fresh snapshot: <b>${e.v}</b> at version ${e.ver}.`, "info"];
        if (ot.ver === e.ver && ot.state !== "done" && ot.v !== null) return {
          naive: [(run.db.lock === ot.id ? `Read committed hides ${nm(ot)}'s uncommitted ${run.db.pending}, so ${nm(me)} read ${e.v}. ` : "") +
            `Both transactions have read ${e.v}, so each will write ${e.v + 1} no matter what happens next.`, "warn"],
          cas: [`Both have read ${e.v} at version ${e.ver}. Only one UPDATE ... AND version = ${e.ver} can match, so one of them will have to retry.`, "info"],
          auto: [`Both snapshots say ${e.v} at version ${e.ver}. Whichever transaction updates the row second will be aborted once the first commits.`, "info"],
        }[strat];
        if (e.v > START) return [`${nm(me)} read <b>${e.v}</b>, which already includes ${nm(ot)}'s like.`, "info"];
        return {
          naive: [`${nm(me)} read <b>${e.v}</b>. ${cap(his(me))} app will compute ${e.v} + 1 = ${e.v + 1} and write it back.`, "info"],
          cas: [`${nm(me)} read <b>${e.v}</b> at version ${e.ver}. No lock is held while ${his(me)} app computes ${e.v + 1}.`, "info"],
          auto: [`${nm(me)}'s transaction took its snapshot: likes = <b>${e.v}</b> at version ${e.ver}.`, "info"],
        }[strat];
      }

      function waitNote(me, ot) {
        return {
          naive: [`${nm(me)} waits for ${nm(ot)}'s row lock (read committed prevents dirty writes), but ${he(me)} already computed ` +
            `${me.v + 1} from a stale read, so waiting won't save the like.`, "warn"],
          atomic: [`${nm(me)}'s UPDATE waits for the row lock; when it runs, it adds 1 to whatever is committed then.`, "info"],
          forupd: [`${nm(me)} can't even read until ${nm(ot)} is done, so ${his(me)} read will return ${ot.v + 1}.`, "info"],
          auto: [`${nm(me)}'s UPDATE waits for ${nm(ot)}'s row lock. If ${nm(ot)} commits, PostgreSQL will abort ${nm(me)}'s ` +
            `transaction; if ${nm(ot)} rolled back instead, ${nm(me)} would continue.`, "info"],
        }[strat];
      }

      function resumeNote(e, r, me, ot) {
        if (r.kind === "abort") return [abortText(ot), "warn"];
        return {
          naive: [`${nm(me)} committed ${e.v} and released the lock. ${nm(ot)}'s waiting UPDATE ran at once and wrote <b>${r.v}</b>, ` +
            `the value ${he(ot)} computed from ${his(ot)} stale read.`, "warn"],
          atomic: [`${nm(me)} committed ${e.v}. ${nm(ot)}'s UPDATE resumed and added 1 to the newest value: <b>${r.v}</b>.`, "ok"],
          forupd: [`${nm(me)} committed ${e.v}. ${nm(ot)}'s locking read resumed and returned <b>${r.v}</b>, not ${START}.`, "ok"],
        }[strat];
      }

      function commitNote(e, me, ot) {
        const base = `${nm(me)} committed: likes = <b>${e.v}</b>, version ${e.db.version}.`;
        const stale = ot.state === "ready" && ot.pc > 0 && ot.ver < e.db.version;   // read before this commit
        if (stale && strat === "naive") return [`${base} ${nm(ot)} already read ${ot.v}, so ${he(ot)} will still write ${ot.v + 1}.`, "warn"];
        if (stale && strat === "auto") return [`${base} ${nm(ot)}'s snapshot still says ${ot.v}, so ${his(ot)} UPDATE will be aborted.`, "info"];
        return [base, "info"];
      }

      function finalNote() {
        const v = run.db.value, f = run.txs[run.db.log[0].tx], S = run.txs[1 - f.id];
        if (v < START + 2) return [`Final ${v}: ${nm(f)}'s like is lost, and nobody saw an error. ${nm(S)}'s ${v} was computed ` +
          `from a read taken before ${nm(f)} committed.`, "bad"];
        const F = nm(f), Sn = nm(S);
        return [{
          naive: `Nothing was lost this time, because ${Sn} read after ${F} committed. The bug needs overlapping reads, which is why tests rarely catch it. Now try interleaving the reads.`,
          atomic: S.waits ? `Final 44: ${Sn} waited for ${F}'s row lock, then ${his(S)} UPDATE added 1 to the newest value.`
            : `Final 44: ${Sn}'s UPDATE ran after ${F} committed, so it added 1 to 43. The app never held a stale value.`,
          forupd: S.waits ? `Final 44: ${Sn} waited for ${F}'s lock, so ${his(S)} locking read returned 43, not 42.`
            : `Final 44: ${Sn} locked and read after ${F} committed.`,
          cas: S.retries ? `Final 44: nobody waited. ${Sn}'s first CAS matched 0 rows, so ${he(S)} re-read 43 and retried.`
            : `Final 44: ${Sn} read after ${F}'s update, so ${his(S)} CAS matched on the first try.`,
          auto: S.retries ? `Final 44: PostgreSQL aborted ${Sn}'s first attempt${S.waits ? ` after ${he(S)} waited for ${F}'s lock` : ""}; the retry read 43 and committed 44.`
            : `Final 44: ${Sn}'s snapshot was taken after ${F} committed, so there was nothing to abort.`,
        }[strat], "ok"];
      }

      function explain(evs) {
        if (bothDone()) return finalNote();
        const e = evs[0], me = run.txs[e.tx], ot = run.txs[1 - e.tx];
        switch (e.kind) {
          case "read": return readNote(e, me, ot);
          case "lock": return [`SELECT ... FOR UPDATE: ${nm(me)} read <b>${e.v}</b> and locked the row until ${his(me)} transaction ends.`, "info"];
          case "write": return strat === "atomic"
            ? [`${nm(me)}'s UPDATE added 1 inside the database: <b>${e.v}</b>, uncommitted, with the row locked until commit.`, "info"]
            : [`${nm(me)} wrote <b>${e.v}</b> (uncommitted) and holds the row lock until ${his(me)} transaction commits.`, "info"];
          case "wait": return waitNote(me, ot);
          case "commit": return evs[1] ? resumeNote(e, evs[1], me, ot) : commitNote(e, me, ot);
          case "casok": return [`The version was still ${e.ver}, so ${nm(me)}'s UPDATE matched 1 row: likes = <b>${e.v}</b>, version ${e.db.version}.`, "info"];
          case "casfail": return [`The version moved from ${e.ver} to ${e.now} after ${nm(me)} read it, so ${his(me)} UPDATE matched 0 rows. ` +
            `${cap(he(me))} re-reads and tries again; no lock was held while ${he(me)} was thinking.`, "warn"];
          default: return [abortText(me), "warn"];
        }
      }

      // ---------- story controls ----------
      function opLabel(t) {
        if (t.state !== "ready") return t.state === "done" ? "done" : "waiting";
        if (t.retrying) return "retry";
        const op = PROGRAMS[strat][t.pc];
        return { read: "read", lockread: "lock + read", update: "update", commit: "commit",
          write: `write ${t.v + 1}`, cas: `write ${t.v + 1} if v${t.ver}` }[op];
      }

      function sync() {
        run.txs.forEach((t, i) => btns[i].setLabel(`${t.name}: ${opLabel(t)}`).disable(playing || t.state !== "ready"));
        btnUndo.disable(playing || !history.length);
        btnPlay.setLabel(playing ? "■ Stop" : PLAY);
        const done = bothDone(), v = run.db.value, tone = v === START + 2 ? "ok" : "bad";
        stats.set("final", done ? v : "–", done ? tone : "");
        stats.set("lost", done ? START + 2 - v : "–", done ? tone : "");
        const w = total(run, "waits"), r = total(run, "retries");
        stats.set("wr", `${w} / ${r}`, w + r ? "warn" : "");
        challenge.innerHTML = "";
        challenge.append(h("span", { class: "muted" }, "Challenge: find a schedule that loses a like under each strategy."));
        STRATS.forEach(o => {
          const rec = tried[o.value];
          challenge.append(!rec ? ui.badge(`${o.label}: not tried`, "muted")
            : ui.badge(`${o.label}: ${rec.runs.size} schedule${rec.runs.size > 1 ? "s" : ""}, ${rec.lost.size} lost`, rec.lost.size ? "bad" : "ok"));
        });
      }

      function record() {
        if (!bothDone()) return;
        const rec = tried[strat] = tried[strat] || { runs: new Set(), lost: new Set() }, key = history.join("");
        rec.runs.add(key);
        if (run.db.value < START + 2) rec.lost.add(key);
      }

      function click(i) {
        if (run.txs[i].state !== "ready") return;
        const from = run.events.length;
        history.push(i);
        const evs = step(run, i);
        record();
        draw(from);
        note.set(...explain(evs));
        sync();
      }

      function undo() {
        if (playing || !history.length) return;
        const keep = history.slice(0, -1);
        run = newRun(strat, NAMES, 1);
        history = keep;
        let evs = null;
        keep.forEach(i => { evs = step(run, i); });
        draw(Infinity);
        if (evs) note.set(...explain(evs)); else note.set(INTRO[strat], "info");
        sync();
      }

      function reset() {
        epoch++;
        playing = false;
        run = newRun(strat, NAMES, 1);
        history = [];
        sql.innerHTML = SQL[strat];
        if (lastStress && lastStress.strat !== strat) { lastStress = null; stressEpoch++; stressOut.style.display = "none"; }
        buildScene();
        note.set(INTRO[strat], "info");
        sync();
      }

      function stop() { epoch++; playing = false; sync(); }

      // Resets, then clicks A, B, A, B, ... skipping a transaction that is blocked or done.
      async function playClassic() {
        reset();
        const my = epoch;
        playing = true;
        sync();
        for (let turn = 0; ; ) {
          const t = run.txs[turn].state === "ready" ? run.txs[turn] : run.txs[1 - turn];
          if (t.state !== "ready") break;
          click(t.id);
          turn = 1 - t.id;
          await ctx.sleep(700);
          if (my !== epoch || !ctx.alive) return;
        }
        playing = false;
        sync();
      }

      // ---------- stress test ----------
      function drawGrid(r, reveal) {
        const W = compact ? 360 : 640, gut = compact ? 26 : 62, st = (W - gut - 4) / 25, cell = st - (compact ? 2.5 : 4);
        const rowH = compact ? st + 5 : st;
        const g = ctx.svg({ w: W, h: rowH * 4, label: "Each square is one like: green kept, red lost" });
        const lost = new Set(r.db.lost.map(e => e.tx + ":" + e.n));
        const shown = new Set(r.db.log.slice(0, reveal).map(e => e.tx + ":" + e.n));
        for (let c = 0; c < 4; c++) {
          g.appendChild(ctx.text(4, c * rowH + rowH / 2, compact ? "C" + (c + 1) : "Client " + (c + 1), { size: 12, anchor: "start", fill: "var(--viz-muted)" }));
          for (let n = 0; n < 25; n++) {
            const key = c + ":" + n, tone = !shown.has(key) ? null : lost.has(key) ? "bad" : "ok";
            g.appendChild(s("rect", { x: gut + n * st, y: c * rowH + (rowH - cell) / 2, width: cell, height: cell, rx: 2.5,
              fill: tone === "bad" ? "var(--viz-bad)" : tone ? "var(--viz-ok-soft)" : "var(--viz-grid)",
              stroke: tone ? `var(--viz-${tone})` : "none", "stroke-width": 1 }));
          }
        }
        gridBox.innerHTML = "";
        gridBox.appendChild(g);
      }

      async function runStress() {
        const my = ++stressEpoch, r = stress(strat, ctx.random(42));
        const v = r.db.value, lost = START + 100 - v;
        const w = total(r, "waits"), re = total(r, "retries");
        lastStress = { strat, r };
        stressOut.style.display = "";
        ["final", "lost", "wr"].forEach(k => sStats.set(k, "–", ""));
        sNote.set("Running 100 increments…", "info");
        await ctx.tween({ ms: 600, ease: "out", onUpdate: k => {
          if (my !== stressEpoch) return;
          sStats.set("final", Math.round(START + k * (v - START)));
          drawGrid(r, Math.round(k * r.db.log.length));
        } });
        if (my !== stressEpoch) return;
        sStats.set("final", v, lost ? "bad" : "ok");
        sStats.set("lost", lost, lost ? "bad" : "ok");
        sStats.set("wr", `${w} / ${re}`, w + re ? "warn" : "");
        const cost = [w && `${w} waits`, re && `${re} retries`].filter(Boolean).join(" and ") || "nothing";
        sNote.set(lost ? `Lost <b>${lost}</b> of 100 likes, with no error anywhere. Each red square is a like that was committed and then overwritten.`
          : strat === "atomic" ? `No likes lost: increments queued on the row lock (${w} waits).`
            : `No likes lost. Cost: ${cost}, the price of correctness under contention.`, lost ? "bad" : "ok");
      }

      reset();
      ctx.onResize(() => {
        if (ctx.compact === compact) return;
        compact = ctx.compact;
        buildScene();
        if (lastStress && stressOut.style.display !== "none") drawGrid(lastStress.r, Infinity);
      });
    },
  });
})();
