// Dual writes vs change data capture. Two clients set the same key X while a fault is injected.
// Dual writes: the application writes the database and then the search index itself, so a race
// or a partial failure leaves them permanently different, with no error. CDC: the application
// writes only the database; a connector copies its ordered change log to the index, which
// converges after a short staleness window. scenario() builds each timeline as plain data.
(function () {
  "use strict";
  // Timeline in seconds. t1 = 8 rather than 10 leaves room for labels where the action is.
  const T1 = 8, END = 7.8, PLAY_MS = 5000, GHOST = 0.12, EPS = 1e-9;
  const sec = x => x.toFixed(1) + " s";
  const clamp01 = k => Math.max(0, Math.min(1, k));

  const LANES = {
    c1: { label: "Client 1", short: "Client 1", color: "c6" },
    c2: { label: "Client 2", short: "Client 2", color: "c6" },
    db: { label: "Database", short: "DB", color: "c1" },
    log: { label: "Change log", short: "Log", color: "c7" },
    ix: { label: "Search index", short: "Index", color: "c2" },
  };
  const OUTCOMES = {
    diverged: ["Diverged for good", "bad"],
    consistent: ["Consistent", "ok"],
    converged: ["Converged after lag", "ok"],
  };
  const NOTES = {
    "dual/race": ["<b>Both writes succeeded everywhere</b>, yet the database holds B and the index holds A, because the two systems saw the writes in different orders. Nothing will ever repair this automatically.", "bad"],
    "dual/fail": ["The database committed X=A, the index write failed. The user got an error, but <b>the change is already in the database</b>, and searches keep returning the old value.", "bad"],
    "dual/crash": ["The process died between the two writes. <b>No error was logged anywhere</b>; the index is silently out of date until someone notices.", "bad"],
    "dual/none": ["The happy path, which is what you see in testing. Dual writes fail only under <b>concurrency or partial failure</b>, which is exactly why they pass code review.", "warn"],
    "cdc/race": ["The app writes only to the database; the connector applies the log <b>in commit order</b>, so a slow delivery of #1 just delays #2. The index converges to B, after a staleness window.", "ok"],
    "cdc/fail": ["The index write failed, so the connector <b>retried from its offset</b>. Nothing is lost because the log still has #1.", "ok"],
    "cdc/crash": ["The connector crashed after applying #1 but before committing its offset, so it <b>restarted from #1 and re-applied it</b>. Harmless: setting X to a full value at a known log position is idempotent.", "ok"],
    "cdc/none": ["Same result as dual writes on a good day, but the index trails the database slightly: CDC is <b>asynchronous</b>, so read-your-writes on the index is not guaranteed.", "info"],
  };

  // ---------- scenario: the whole timeline for one (strategy, fault) as drawing commands ----------
  // c = phone layout (only labels and label offsets depend on it, never the times).
  function scenario(strategy, fault, c) {
    const cmds = [], applies = [];
    const P = (desk, phone) => (c ? phone : desk);
    const add = (kind, t, o) => cmds.push(Object.assign({ kind, t }, o));
    const op = (lane, ta, tb, o) => add("op", ta, Object.assign({ lane, ta, tb }, o));
    const msg = (from, tf, to, tt, o) => add("msg", tf, Object.assign({ from, tf, to, tt, color: "c6" }, o));
    const mark = (lane, t, tone, label, o) => add("mark", t, Object.assign({ lane, tone, label }, o));
    // Text only, centred at time `at` (it appears at time t).
    const tag = (lane, t, at, tone, label) => add("tag", t, { lane, at, tone, label });
    const busy = (lane, ta, tb) => op(lane, ta, tb, { tone: "c6", height: 10 });
    // A value lands in a system: drawn as a badge, and recorded for the stats.
    const set = (sys, t, v, tone) => { applies.push({ sys, t, v }); add("val", t, { lane: sys, v, tone: tone || "ok" }); };
    const cdc = strategy === "cdc";
    const subs = { c1: "sets X=A", c2: "sets X=B" };

    if (!cdc && fault === "none") {
      busy("c1", 0.3, 1.3);
      msg("c1", 0.6, "db", 1.2); set("db", 1.2, "A");
      msg("c1", 1.3, "ix", 1.9); set("ix", 1.9, "A");
      busy("c2", 1.9, 2.9);
      msg("c2", 2.2, "db", 2.8); set("db", 2.8, "B");
      msg("c2", 2.9, "ix", 3.5); set("ix", 3.5, "B");
    } else if (!cdc) {
      busy("c1", 0.3, fault === "crash" ? 1.6 : 1.3);
      msg("c1", 0.6, "db", 1.2); set("db", 1.2, "A");
      if (fault === "race") {
        busy("c2", 1.2, 2.1);
        msg("c2", 1.5, "db", 2.0); set("db", 2.0, "B");
        msg("c2", 2.1, "ix", 2.7); set("ix", 2.7, "B");
        // Label above-right of the slow arrow, between the client lanes, so the line never crosses it.
        msg("c1", 1.3, "ix", 4.2, { color: "warn", label: P("X=A (slow network)", "X=A (slow)"), at: 0.3, dy: -10 });
        set("ix", 4.2, "A", "bad");
      } else {
        if (fault === "fail") {
          msg("c1", 1.3, "ix", 2.4, { lost: true, label: "X=A", at: 0.5 });
          op("c1", 2.5, P(3.4, 3.7), { label: "error", tone: "bad" });
        } else {
          mark("c1", 1.6, "bad", "✕ crash");
          op("c1", 1.6, P(3.6, 3.2), { label: P("process down", "down"), tone: "bad", dashed: true, height: 18 });
        }
        // Later, someone searches: the index still has the old value.
        subs.c2 = P("searches X", "reads X");
        busy("c2", 5.0, 6.0);
        msg("c2", 5.0, "ix", 5.4, { label: "search X", at: 0.18, side: "left" });
        msg("ix", 5.6, "c2", 6.0, { color: "bad" });
        tag("c2", 6.0, 5.5, "bad", "X = old");
      }
    } else {
      busy("c1", 0.3, 0.6);
      msg("c1", 0.6, "db", 1.2); set("db", 1.2, "A");
      busy("c2", 1.2, 1.5);
      msg("c2", 1.5, "db", 2.0); set("db", 2.0, "B");
      // The database appends each commit to its change log, in commit order.
      msg("db", 1.2, "log", 1.4, { color: "c1" }); add("cell", 1.4, { lane: "log", label: "#1" });
      msg("db", 2.0, "log", 2.2, { color: "c1" }); add("cell", 2.2, { lane: "log", label: "#2" });
      // The connector delivers log entries to the index strictly in log order.
      const deliver = (tf, tt, o) => msg("log", tf, "ix", tt, Object.assign({ color: "c7" }, o));
      if (fault === "race") {
        deliver(1.6, 3.4, { color: "warn", label: "slow", dx: P(12, 6) }); set("ix", 3.4, "A");
        deliver(3.5, 4.0); set("ix", 4.0, "B");
      } else if (fault === "fail") {
        deliver(1.6, 2.4, { lost: true });
        mark("log", 2.6, "warn", "retry #1", { place: "right" });
        deliver(2.8, 3.4); set("ix", 3.4, "A");
        deliver(3.6, 4.1); set("ix", 4.1, "B");
      } else if (fault === "crash") {
        deliver(1.6, 2.2); set("ix", 2.2, "A");
        mark("log", 2.6, "bad", P("✕ connector crashed", "✕ connector"), { place: "right" });
        op("log", 2.6, 3.6, { label: "down", tone: "bad", dashed: true, height: 16 });
        // Its committed offset still points at #1 (it commits every 2 events), so #1 comes again.
        deliver(3.7, 4.2, { color: "warn", label: P("X=A again", "again"), at: 0.5, side: "left" }); set("ix", 4.2, "A", "warn");
        deliver(4.3, 4.8); set("ix", 4.8, "B");
      } else {
        deliver(1.6, 2.2); set("ix", 2.2, "A");
        deliver(2.4, 3.0); set("ix", 3.0, "B");
      }
    }

    // ---- derived state: values over time, stale windows, outcome ----
    applies.sort((a, b) => a.t - b.t);
    const valueAt = (sys, t) => applies.reduce((v, a) => (a.sys === sys && a.t <= t + EPS ? a.v : v), "old");
    // Maximal intervals during which the index holds a different value than the database.
    const cuts = [0, ...applies.map(a => a.t), T1];
    const gaps = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1];
      if (b - a < EPS || valueAt("db", a) === valueAt("ix", a)) continue;
      const last = gaps[gaps.length - 1];
      if (last && Math.abs(last[1] - a) < EPS) last[1] = b; else gaps.push([a, b]);
    }
    const db = valueAt("db", T1), index = valueAt("ix", T1);
    const outcome = db !== index ? "diverged" : cdc ? "converged" : "consistent";
    const staleSeconds = outcome === "diverged" ? Infinity : gaps.reduce((sum, [a, b]) => sum + b - a, 0);
    const staleWithin = now => gaps.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, now) - a), 0);

    const tEnd = Math.max(...cmds.map(cm => (cm.kind === "msg" ? cm.tt : cm.kind === "op" ? cm.tb : cm.t))) + 0.4;
    // Stale windows go first so they sit underneath the value badges.
    if (outcome !== "diverged") gaps.slice().reverse().forEach(([a, b]) => cmds.unshift({ kind: "op", t: a, lane: "ix", ta: a, tb: b, tone: "warn", dashed: true, height: 14, stale: true }));
    op("db", tEnd, END, { label: "X = " + db, tone: "ok" });
    op("ix", tEnd, END, { label: "X = " + index, tone: index === db ? "ok" : "bad" });
    add("verdict", tEnd, { outcome });

    return {
      lanes: cdc ? ["c1", "c2", "db", "log", "ix"] : ["c1", "c2", "db", "ix"],
      subs, cmds, applies, gaps, db, index, outcome, staleSeconds, staleWithin, valueAt, tEnd,
    };
  }

  Viz.register("ch11/dual-writes", {
    title: "Dual writes vs change data capture",
    scenario, // exposed for tests
    mount(root, ctx) {
      const { s, ui } = ctx;
      let strategy = "dual", fault = "race", compact = ctx.compact, gen = 0;
      let view = null;

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const strategySeg = ui.segmented({
          label: "Strategy", value: strategy,
          options: [{ value: "dual", label: "Dual writes" }, { value: "cdc", label: "CDC" }],
          onChange: v => { strategy = v; redraw(); },
        });
        const faultSeg = ui.segmented({
          label: "What goes wrong", value: fault,
          options: [{ value: "race", label: "Race" }, { value: "fail", label: "Write fails" },
            { value: "crash", label: "Crash" }, { value: "none", label: "Nothing" }],
          onChange: v => { fault = v; redraw(); },
        });
        const playBtn = ui.button("▶ Play", () => play(), { kind: "primary" });
        const stats = ui.stats([
          { key: "db", label: "Database", value: "" },
          { key: "ix", label: "Search index", value: "" },
          { key: "out", label: "Outcome", value: "" },
          { key: "stale", label: "Index stale for", value: "" },
        ]);
        const note = ui.note("");
        const legend = ui.legend([
          { color: "var(--viz-ok)", label: "write / commit", shape: "dot" },
          { color: "var(--viz-warn)", label: "stale or retried", shape: "dash" },
          { color: "var(--viz-bad)", label: "lost or wrong", shape: "dot" },
          { color: "var(--viz-c6)", label: "client", shape: "line" },
          { color: "var(--viz-c1)", label: "database", shape: "line" },
          { color: "var(--viz-c2)", label: "index", shape: "line" },
          { color: "var(--viz-c7)", label: "change log", shape: "line" },
        ]);
        const svg = s("svg");
        root.append(ui.bar(strategySeg, faultSeg, playBtn), svg, stats, note, legend);
        view = { svg, stats, note, legend };
        redraw();
      }

      // ---------- drawing ----------
      function render(sc) {
        const c = compact, W = c ? 360 : 640, laneH = c ? 44 : 46, fs = c ? 11 : 12;
        const H = sc.lanes.length * laneH + 20;
        const svg = ctx.svg({ w: W, h: H, label: "Timeline of two clients writing X, the database and the search index" });
        const tl = ctx.lanes({
          parent: svg, x: 0, y: 10, w: W, h: H - 20, t0: 0, t1: T1, labelWidth: c ? 64 : 100,
          lanes: sc.lanes.map(id => ({ id, label: "", color: LANES[id].color })),
        });
        // Lane names (and what each client does) in the gutter.
        sc.lanes.forEach(id => {
          const d = LANES[id], y = tl.y(id), sub = sc.subs[id];
          tl.root.appendChild(ctx.text(6, sub ? y - 7 : y, c ? d.short : d.label,
            { size: fs, anchor: "start", weight: 700, fill: `var(--viz-${d.color})` }));
          if (sub) tl.root.appendChild(ctx.text(6, y + 8, sub, { size: fs, anchor: "start", fill: "var(--viz-muted)" }));
        });
        const badgeR = c ? 8 : 9;
        const textW = str => str.length * fs * 0.62;
        const items = [];

        const draw = {
          op(cm) {
            const g = tl.op(cm.lane, cm.ta, cm.tb, { label: cm.stale ? null : cm.label, tone: cm.tone, dashed: cm.dashed, height: cm.height, size: fs });
            if (cm.stale) {
              g.label = staleLabel(cm);
              if (g.label) g.appendChild(g.label);
            }
            return { g, progress: now => growOp(g, cm, now) };
          },
          msg(cm) {
            const g = tl.msg(cm.from, cm.tf, cm.to, cm.tt, { label: cm.label, color: cm.color, lost: cm.lost, labelDx: cm.dx, size: fs });
            const ghost = g.line.cloneNode();
            ghost.removeAttribute("marker-end");
            ghost.setAttribute("opacity", 0);
            g.insertBefore(ghost, g.line);
            const cross = Array.from(g.childNodes).find(n => n.textContent === "✕");
            const [x1, y1, x2, y2] = g.line.getAttribute("d").match(/-?[\d.]+/g).map(Number);
            // `at`: put the label beside the arrow at that fraction of its length (right, or left).
            if (cm.at !== undefined) {
              const left = cm.side === "left";
              ctx.attr(g.label, { x: x1 + (x2 - x1) * cm.at + (left ? -7 : 7), y: y1 + (y2 - y1) * cm.at + (cm.dy || 0), "text-anchor": left ? "end" : "start" });
            }
            const tArrive = cm.lost ? (cm.tf + cm.tt) / 2 : cm.tt;
            return {
              g, progress(now) {
                const k = clamp01((now - cm.tf) / (tArrive - cm.tf));
                const flying = k > 0 && k < 1;
                g.line.setAttribute("d", `M${x1},${y1} L${flying ? x1 + (x2 - x1) * k : x2},${flying ? y1 + (y2 - y1) * k : y2}`);
                ghost.setAttribute("opacity", flying ? GHOST : 0);
                if (cross) cross.setAttribute("opacity", k >= 1 ? 1 : 0);
              },
            };
          },
          mark(cm) {
            const g = tl.mark(cm.lane, cm.t, { tone: cm.tone });
            const right = cm.place === "right";
            g.appendChild(ctx.text(tl.x(cm.t) + (right ? 8 : 0), tl.y(cm.lane) - 14, cm.label,
              { size: fs, weight: 700, fill: `var(--viz-${cm.tone})`, anchor: right ? "start" : "middle", halo: true }));
            return { g };
          },
          tag(cm) {
            const g = s("g");
            g.appendChild(ctx.text(tl.x(cm.at), tl.y(cm.lane) - 14, cm.label, { size: fs, weight: 700, fill: `var(--viz-${cm.tone})`, halo: true }));
            tl.content.appendChild(g);
            return { g };
          },
          val(cm) {
            const x = tl.x(cm.t), y = tl.y(cm.lane), g = s("g");
            g.append(
              s("circle", { cx: x, cy: y, r: badgeR, fill: "var(--viz-bg)" }),
              s("circle", { cx: x, cy: y, r: badgeR, fill: `var(--viz-${cm.tone}-soft)`, stroke: `var(--viz-${cm.tone})`, "stroke-width": 1.6 }),
              ctx.text(x, y + 0.5, cm.v, { size: fs, weight: 800 }));
            tl.content.appendChild(g);
            return { g };
          },
          cell(cm) {
            const x = tl.x(cm.t), y = tl.y(cm.lane), w = c ? 20 : 24, g = s("g");
            g.append(
              s("rect", { x: x - w / 2, y: y - 9, width: w, height: 18, rx: 4, fill: "var(--viz-bg)" }),
              s("rect", { x: x - w / 2, y: y - 9, width: w, height: 18, rx: 4, fill: "var(--viz-c7-soft)", stroke: "var(--viz-c7)", "stroke-width": 1.4 }),
              ctx.text(x, y + 0.5, cm.label, { size: fs, weight: 700 }));
            tl.content.appendChild(g);
            return { g };
          },
          verdict(cm) {
            const [label, tn] = { diverged: ["✕ diverged", "bad"], consistent: ["✓ consistent", "ok"], converged: ["✓ converged", "ok"] }[cm.outcome];
            const x = tl.x(cm.t), g = s("g"), flip = x + 6 + textW(label) > W - 4;
            g.append(
              s("line", { x1: x, x2: x, y1: tl.y("c1") + 9, y2: H - 6, stroke: `var(--viz-${tn})`, "stroke-width": 1.4, "stroke-dasharray": "3 3" }),
              ctx.text(flip ? x - 6 : x + 6, tl.y("c1"), label, { size: fs, weight: 800, fill: `var(--viz-${tn})`, anchor: flip ? "end" : "start", halo: true }));
            tl.overlay.appendChild(g);
            return { g };
          },
        };

        // "stale 2.8 s" (or "stale") in the widest stretch of the bar not covered by a badge.
        function staleLabel(cm) {
          const xs = sc.cmds.filter(o => o.kind === "val" && o.lane === "ix" && o.t >= cm.ta - EPS && o.t <= cm.tb + EPS).map(o => tl.x(o.t));
          const edges = [tl.x(cm.ta) - badgeR, ...xs, tl.x(cm.tb) + badgeR].sort((a, b) => a - b);
          let best = null;
          for (let i = 0; i < edges.length - 1; i++) {
            const w = edges[i + 1] - edges[i] - 2 * badgeR;
            if (!best || w > best.w) best = { w, x: (edges[i] + edges[i + 1]) / 2 };
          }
          const str = ["stale " + sec(cm.tb - cm.ta), "stale"].find(t => textW(t) + 6 <= best.w);
          return str ? ctx.text(best.x, tl.y("ix"), str, { size: fs, weight: 700, fill: "var(--viz-warn)", halo: true }) : null;
        }

        // Bars grow with the cursor; the label rides in the middle once it fits.
        function growOp(g, cm, now) {
          const xa = tl.x(cm.ta), xb = tl.x(Math.max(cm.ta, Math.min(cm.tb, now)));
          const w = now < cm.ta ? tl.x(cm.tb) - xa : xb - xa;
          g.querySelectorAll("rect").forEach(r => r.setAttribute("width", Math.max(now < cm.ta ? 4 : 0, w)));
          if (!g.label) return;
          const fits = !cm.stale && w >= textW(cm.label) + 4;
          if (!cm.stale) g.label.setAttribute("x", xa + w / 2);
          g.label.setAttribute("opacity", fits || now >= cm.tb ? 1 : 0);
        }

        sc.cmds.forEach(cm => {
          const it = draw[cm.kind](cm);
          it.t = cm.t;
          items.push(it);
        });
        // Play head (tl.cursor() cannot be hidden again, so draw our own).
        const head = s("g", { display: "none" });
        const headLine = s("line", { y1: 10, y2: H - 10, stroke: "var(--viz-warn)", "stroke-width": 1.5, "stroke-dasharray": "3 3" });
        const headLabel = ctx.text(0, 12, "", { size: fs, weight: 700, fill: "var(--viz-warn)", baseline: "hanging", halo: true });
        head.append(headLine, headLabel);
        tl.overlay.appendChild(head);
        const cursor = now => {
          head.setAttribute("display", now === null ? "none" : "");
          if (now === null) return;
          ctx.attr(headLine, { x1: tl.x(now), x2: tl.x(now) });
          ctx.attr(headLabel, { x: tl.x(now) });
          headLabel.textContent = sec(now);
        };
        return { svg, items, cursor };
      }

      // Show the timeline as of time `now`; done = the final, fully drawn state.
      function show(now, done) {
        const { sc, scene, stats } = view;
        scene.items.forEach(it => {
          it.g.setAttribute("opacity", now >= it.t - EPS ? 1 : GHOST);
          if (it.progress) it.progress(now);
        });
        scene.cursor(done ? null : now);

        const dv = sc.valueAt("db", now), iv = sc.valueAt("ix", now);
        const passed = done || now >= sc.tEnd - EPS;
        const [outLabel, outTone] = OUTCOMES[sc.outcome];
        const stale = passed && sc.outcome === "diverged" ? Infinity : sc.staleWithin(now);
        stats.set("db", "X = " + dv, "");
        stats.set("ix", "X = " + iv, iv === dv ? (passed ? "ok" : "") : passed ? "bad" : "warn");
        stats.set("out", passed ? outLabel : "…", passed ? outTone : "");
        stats.set("stale", stale === Infinity ? "∞" : sec(stale), stale === Infinity ? "bad" : stale > EPS ? "warn" : "");
      }

      function redraw() {
        gen++;  // cancels a running Play
        const sc = scenario(strategy, fault, compact);
        const scene = render(sc);
        view.svg.replaceWith(scene.svg);
        Object.assign(view, { svg: scene.svg, sc, scene });
        view.note.set(...NOTES[strategy + "/" + fault]);
        view.legend.lastChild.style.display = strategy === "cdc" ? "" : "none";
        show(T1, true);
      }

      async function play() {
        const my = ++gen;
        show(0, false);
        await ctx.tween({ ms: PLAY_MS, ease: "linear", onUpdate: k => { if (my === gen) show(k * T1, false); } });
        if (my === gen && ctx.alive) show(T1, true);
      }

      build();
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
