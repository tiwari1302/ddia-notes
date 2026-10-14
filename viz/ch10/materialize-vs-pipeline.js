// Materialize or pipeline? The same workflow (parse → count → top-k) run as two chained
// MapReduce jobs and as one dataflow job on 4 workers + 1 spare. Toggle a straggler, a machine
// failure and a nondeterministic operator to see where materialization costs time and where it
// pays off (recovery: a pipelined job restarts its whole connected region). Illustrative minutes.
(function () {
  "use strict";
  const WORKERS = ["w1", "w2", "w3", "w4"];

  // ---------- schedules (pure): bars {lane, a, b, kind, st?, row?, badLabels?, tip?} ----------
  // st: "lost" | "discarded" | "rerun"; row: -1 / +1 = upper / lower half of a lane (pipelined overlap).
  function mapReduce({ straggler, dies }) {
    const S = straggler ? 8 : 0, M1 = 10 + S, K = M1 + 24;
    const bars = [];
    const add = (lane, a, b, kind, o) => bars.push(Object.assign({ lane, a, b, kind }, o));
    for (const w of WORKERS) {
      const dead = dies && w === "w2";
      add(w, 0, w === "w3" ? M1 : 10, "map");
      add(w, M1, M1 + 10, "count", { tip: "Job 1 reduce: count per (country, url)" });
      add(w, M1 + 10, M1 + 14, "hdfs", { tip: "Job 1 writes its 200 GB output to HDFS with 3 replicas: 600 GB" });
      add(w, M1 + 14, M1 + 17, "startup");
      add(w, M1 + 17, M1 + 22, "remap", { st: dead ? "lost" : "" });
      if (dead) add(w, M1 + 22, K, "topk", { st: "lost", badLabels: ["lost"] });
      else { add(w, M1 + 22, M1 + 30, "topk"); add(w, M1 + 30, M1 + 34, "hdfs"); }
    }
    if (dies) {
      add("spare", K, K + 5, "remap", { st: "rerun" });
      add("spare", K + 5, K + 13, "topk", { st: "rerun" });
      add("spare", K + 13, K + 17, "hdfs");
    }
    const finish = dies ? K + 17 : M1 + 34;
    return {
      bars, finish, kill: dies ? K : null, mix: null, reexec: dies ? 2 : 0,
      brackets: [{ a: 0, b: M1 + 14, labels: ["job 1"] }, { a: M1 + 14, b: M1 + 17, labels: ["start-up"], gap: true },
        { a: M1 + 17, b: finish, labels: ["job 2"] }],
    };
  }

  // mode "pipe": count consumes parse output as it streams (Flink-style pipelined exchange).
  // mode "staged": every stage finishes and writes local shuffle files first (Spark-style).
  // When W2 dies: stage by stage, only W2's partition is recomputed from lineage. Pipelined, nothing
  // was kept between operators and the all-to-all exchanges connect every task, so the whole
  // pipelined region (here the entire job) restarts from the input, as Flink's region failover does.
  function dataflow({ mode, straggler, dies, nondet }) {
    const S = straggler ? 8 : 0, A1 = 10 + S, pipe = mode === "pipe";
    const C0 = A1 + (pipe ? 4 : 7), K = C0 + 4;   // top-k starts at C0; W2 dies 4 min into it
    const R = { parse: 0, count: 10, topk: 17, hdfs: 25, end: 29 };   // staged recomputation of W2's partition
    const bars = [];
    const add = (lane, a, b, kind, o) => bars.push(Object.assign({ lane, a, b, kind }, o));
    const restart = dies && pipe, redo = dies && nondet && !pipe;
    // One pipelined run of every partition, starting at t0 (W2's partition runs on `lane2`).
    const runAll = (t0, lane2, o) => {
      for (const w of WORKERS) {
        const lane = w === "w2" ? lane2 : w, dead = o.dead && w === "w2";
        const st = dead ? "lost" : o.st, end = o.cut === undefined ? Infinity : o.cut;
        const seg = (a, b, kind, x) => { if (a < end) add(lane, t0 + a, t0 + Math.min(b, end), kind, Object.assign({ st }, x)); };
        seg(0, w === "w3" ? A1 : 10, "parse", { row: -1, tip: o.parseTip });
        seg(2, A1, "recv", { row: 1 });
        seg(A1, C0, "count");
        seg(C0, C0 + 8, "topk", o.cut === undefined ? {} : { badLabels: dead ? ["lost"] : ["discarded", "✕"] });
        if (o.cut === undefined) add(lane, t0 + C0 + 8, t0 + C0 + 12, "hdfs");
      }
    };
    if (pipe) {
      runAll(0, "w2", restart ? { st: "restarted", dead: true, cut: K } : { st: "" });
      if (restart) runAll(K, "spare", { st: "rerun", parseTip: "Region restart: read this input split from HDFS and parse it again" });
    } else {
      for (const w of WORKERS) {
        const dead = dies && w === "w2", st = dead ? "lost" : "";
        add(w, 0, w === "w3" ? A1 : 10, "parse", { st });
        add(w, A1, C0, "count", { st });
        if (dead) add(w, C0, K, "topk", { st: "lost", badLabels: ["lost"] });
        else if (redo) {
          add(w, C0, C0 + 8, "topk", { st: "discarded", badLabels: ["discarded", "✕"] });
          add(w, K + R.topk, K + R.hdfs, "topk", { st: "rerun" });
          add(w, K + R.hdfs, K + R.end, "hdfs");
        } else { add(w, C0, C0 + 8, "topk"); add(w, C0 + 8, C0 + 12, "hdfs"); }
      }
      if (dies) {
        add("spare", K, K + 10, "parse", { st: "rerun", tip: "Recompute W2's parse from its original input split in HDFS (lineage)" });
        add("spare", K + R.count, K + R.topk, "count", { st: "rerun" });
        add("spare", K + R.topk, K + R.hdfs, "topk", { st: "rerun" });
        add("spare", K + R.hdfs, K + R.end, "hdfs");
      }
    }
    const finish = restart ? K + C0 + 12 : dies ? K + R.end : C0 + 12;
    return {
      bars, finish, kill: dies ? K : null, mix: redo ? { lane: "w1", t: C0 + 8 } : null,
      reexec: restart ? 3 * WORKERS.length : dies ? (nondet ? 6 : 3) : 0,
      brackets: restart ? [{ a: 0, b: K, labels: ["attempt 1", "1st"] },
        { a: K, b: finish, labels: ["attempt 2: the whole pipelined region restarts", "attempt 2: whole region", "attempt 2", "2nd"] }]
        : pipe ? [{ a: 0, b: finish, labels: ["1 job: parse ▸ count ▸ top-k, pipelined", "1 job, pipelined", "1 job"] }]
        : [{ a: 0, b: A1, labels: ["stage 1", "1"] }, { a: A1, b: C0, labels: ["stage 2", "2"] }, { a: C0, b: finish, labels: ["stage 3", "3"] }],
    };
  }

  const KIND = {
    map: { c: "c2", labels: ["map"], tip: "Job 1 map: parse log lines into (country, url) → 1; output to local disk" },
    parse: { c: "c2", labels: ["parse"], tip: "parse: read an input split, emit (country, url) → 1" },
    remap: { c: "c2", labels: ["re-read", "map"], tip: "Job 2 map: re-reads job 1's output from HDFS only to re-key it by country" },
    recv: { c: "c1", labels: ["receiving"], light: true, tip: "count consumes parse output as it streams in, but can emit final counts only after every parse task has finished" },
    count: { c: "c1", labels: ["count"], tip: "count per (country, url)" },
    topk: { c: "c8", labels: ["top-k"], tip: "top-k URLs per country" },
    hdfs: { c: "warn", labels: ["×3"], tip: "Write the final 1 GB output to HDFS with 3 replicas" },
    startup: { c: "var(--viz-muted)", thin: true, tip: "Job 2 start-up: scheduling and launching fresh JVMs" },
  };
  const ST_TIP = {
    lost: " · LOST: it lived only on W2",
    discarded: " · DISCARDED: it used counts that the recomputation may have changed",
    restarted: " · THROWN AWAY: W2's failure restarted the whole pipelined region",
    rerun: " · re-executed after W2 died",
  };

  Viz.register("ch10/materialize-vs-pipeline", {
    title: "Materialize or pipeline?",
    schedules: { mapReduce, dataflow },
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      const T1 = 64;
      const LANES = WORKERS.map((id, i) => ({ id, label: "W" + (i + 1), color: "c2" }))
        .concat({ id: "spare", label: "spare", color: "var(--viz-muted)" });
      // State lives outside build() so a phone <-> desktop rebuild keeps it.
      const cfg = { mode: "pipe", straggler: false, dies: false, nondet: false };
      let compact = ctx.compact, view = null, sched = null, cursorT = null, playing = false, epoch = 0;
      let widths = {};

      // ---------- text fitting ----------
      function textW(str) {
        if (widths[str] === undefined) {
          view.measurer.textContent = str;
          const w = view.measurer.getComputedTextLength ? view.measurer.getComputedTextLength() : 0;
          widths[str] = w || str.length * view.G.fs * 0.6;
        }
        return widths[str];
      }
      // First candidate label that fits in `avail` px (and a bar tall enough for text), else null.
      const fit = (cands, avail, hh = 99) => (!cands || hh < view.G.fs + 3 ? null : cands.find(c => textW(c) <= avail) || null);

      // ---------- layout ----------
      function build() {
        root.innerHTML = "";
        epoch++; playing = false; cursorT = null; widths = {};
        compact = ctx.compact;
        const G = compact
          ? { W: 360, gut: 40, fs: 11, laneH: 32, bar: 16, sub: 14, titleY: 10, stripY: 31, lanesY: 35, axisY: 207, gap: 224 }
          : { W: 640, gut: 50, fs: 12, laneH: 36, bar: 20, sub: 16, titleY: 11, stripY: 34, lanesY: 39, axisY: 232, gap: 250 };
        const svg = ctx.svg({ w: G.W, h: G.gap + G.axisY + 8, label: "Timelines of the same workflow on MapReduce and on a dataflow engine" });
        const measurer = ctx.text(0, -50, "", { size: G.fs, weight: 600 });
        measurer.setAttribute("visibility", "hidden");
        svg.appendChild(measurer);
        view = { G, svg, measurer };
        view.panels = ["mr", "df"].map((key, i) => makePanel(key, i * G.gap));

        const seg = ui.segmented({
          label: "Dataflow exchange", value: cfg.mode,
          options: [{ value: "pipe", label: compact ? "Pipelined" : "Pipelined (Flink-style)" },
            { value: "staged", label: compact ? "Staged" : "Stage by stage (Spark-style)" }],
          onChange: v => { cfg.mode = v; changed(); },
        });
        const tog = (key, label) => ui.toggle({ label, value: cfg[key], onChange: v => { cfg[key] = v; changed(); } });
        view.playBtn = ui.button("▶ Play", () => play(), { kind: "primary", title: "Race both engines from t = 0" });
        const resetBtn = ui.button("⟲", () => stop(), { kind: "ghost", title: "Show the full timelines" });
        view.stats = ui.stats([
          { key: "mr", label: "MapReduce finishes" },
          { key: "df", label: "Dataflow finishes" },
          { key: "written", label: "GB written to HDFS ×3" },
          { key: "reexec", label: "Tasks re-executed" },
        ]);
        view.note = ui.note("");
        view.foot = h("div", { class: "muted", style: "font-size:12px;line-height:1.4;margin:6px 0 0" });
        const header = h("div", { class: "muted", style: "font-size:12px;line-height:1.45;margin:0 0 10px" },
          "Top URLs per country: parse → count per (country, url) → top-k per country · input 1 TB · 4 machines + 1 spare · illustrative minutes");
        const legend = ui.legend([
          { color: "var(--viz-c2)", label: "parse / map", shape: "square" },
          { color: "var(--viz-c1)", label: "count", shape: "square" },
          { color: "var(--viz-c8)", label: "top-k", shape: "square" },
          { color: "var(--viz-warn)", label: "×3 replicated HDFS write", shape: "square" },
          { color: "var(--viz-muted)", label: "job start-up", shape: "square" },
          { color: "var(--viz-ink)", label: "re-executed", shape: "dash" },
          { color: "var(--viz-bad)", label: "lost or discarded", shape: "square" },
        ]);
        root.append(header, ui.bar(seg, view.playBtn, resetBtn),
          ui.bar(tog("straggler", "Straggler in stage 1"), tog("dies", "Machine W2 dies"), tog("nondet", "Count operator is nondeterministic")),
          svg, view.foot, legend, view.stats, view.note);
        draw();
      }

      function makePanel(key, top) {
        const { G, svg } = view;
        const g = s("g");
        svg.appendChild(g);
        const title = ctx.text(0, top + G.titleY, "", { size: G.fs, weight: 700, anchor: "start" });
        g.appendChild(title);
        const y0 = top + G.lanesY, y1 = y0 + LANES.length * G.laneH;
        const tl = ctx.lanes({ parent: g, x: 0, y: y0, w: G.W, h: y1 - y0, t0: 0, t1: T1, lanes: LANES, labelWidth: G.gut });
        const grid = s("g");
        tl.root.insertBefore(grid, tl.content);
        for (let t = 10; t <= 60; t += 10) {
          grid.appendChild(s("line", { x1: tl.x(t), x2: tl.x(t), y1: y0, y2: y1, stroke: "var(--viz-line)", opacity: 0.35 }));
        }
        const layer = () => g.appendChild(s("g"));
        const P = { key, top, y0, y1, title, tl, timed: [], strip: layer(), axis: layer(), axisAlt: layer(), ghost: layer(), fin: layer(), marks: layer(), cur: layer() };
        P.clipId = `mvp-clip-${ctx.uid}-${key}`;
        P.clipRect = s("rect", { x: 0, y: top, width: G.W, height: G.gap });
        svg.defs.appendChild(s("clipPath", { id: P.clipId }, P.clipRect));
        return P;
      }

      // ---------- drawing ----------
      // While playing, text appears only once the cursor has passed `t` (labels are never cut by the wipe).
      const timed = (P, el, t) => { P.timed.push({ el, t }); return el; };
      const timeAt = (P, x) => (x - P.tl.x(0)) / (P.tl.x(1) - P.tl.x(0));
      function titleFor(key) {
        const pipe = cfg.mode === "pipe";
        if (key === "mr") return compact ? "MapReduce: 2 jobs" : "MapReduce: 2 chained jobs";
        if (compact) return pipe ? "Dataflow: 1 job, pipelined" : "Dataflow: 1 job, stage by stage";
        return pipe ? "Dataflow engine, pipelined: 1 job, 3 operators" : "Dataflow engine, stage by stage: 1 job, 3 stages";
      }

      function drawBar(P, b) {
        const bad = b.st === "lost" || b.st === "discarded" || b.st === "restarted";
        drawBarAs(P, b, false);
        // A bad bar looks normal until it is lost or restarted (when W2 dies) or thrown away (its end).
        if (bad) timed(P, drawBarAs(P, b, true), b.st === "discarded" ? b.b : sched[P.key].kill);
      }

      function drawBarAs(P, b, bad) {
        const { G } = view, k = KIND[b.kind], tl = P.tl;
        const hh = k.thin ? 6 : b.row ? G.sub : G.bar;
        const g = tl.op(b.lane, b.a, b.b, { color: bad ? "bad" : k.c, height: hh, dashed: b.st === "rerun" });
        if (b.row) g.setAttribute("transform", `translate(0,${b.row * (G.sub / 2 + 1)})`);
        if (k.light && !bad) ctx.attr(g.rect, { "fill-opacity": 0.5, "stroke-opacity": 0.6 });
        if (k.thin) { g.rect.style.stroke = "none"; g.rect.setAttribute("fill-opacity", 0.55); }
        const x1 = tl.x(b.a), x2 = tl.x(b.b);
        const lbl = fit((bad && b.badLabels) || k.labels, x2 - x1 - 4, hh);
        if (lbl) {
          g.appendChild(timed(P, ctx.text((x1 + x2) / 2, tl.y(b.lane), lbl,
            { size: G.fs, weight: 600, fill: k.light && !bad ? "var(--viz-muted)" : "var(--viz-ink)" }), timeAt(P, (x1 + x2 + textW(lbl)) / 2)));
        }
        g.appendChild(s("title", null, (b.tip || k.tip) + (bad || b.st === "rerun" ? ST_TIP[b.st] : "")));
        return g;
      }

      function drawKill(P, t) {
        const { G } = view, tl = P.tl, x = tl.x(t), y = tl.y("w2");
        const bad = { weight: 800, fill: "var(--viz-bad)", halo: true };
        P.marks.append(timed(P, ctx.text(x, y, "✕", Object.assign({ size: G.fs + 4 }, bad)), t),
          timed(P, ctx.text(x + 9, y, "W2 dies", Object.assign({ size: G.fs, anchor: "start" }, bad)), t));
      }

      // The discarded top-k outputs could not be committed: label it in the gap below W1.
      function drawMix(P, m) {
        const { G } = view, tl = P.tl;
        tl.mark(m.lane, m.t, { tone: "bad", r: 4.5 });
        P.marks.appendChild(timed(P, ctx.text(tl.x(m.t) + 6, tl.y(m.lane) + tl.laneHeight / 2, "would mix two versions",
          { size: G.fs, weight: 700, fill: "var(--viz-bad)", anchor: "start", halo: true }), m.t));
      }

      // Job / stage brackets above the lanes: the boundaries are where everyone waits.
      // The dataflow panel shows where MapReduce finished, on the same line as the bracket labels.
      const ghostLabel = () => (compact ? "MR done" : "MapReduce done");
      function drawStrip(P, brackets) {
        const { G } = view, tl = P.tl, yl = P.top + G.stripY;
        const gx = tl.x(sched.mr.finish), gw = textW(ghostLabel()) / 2 + 8;
        const clear = (str, cx) => P.key !== "df" || cx + textW(str) / 2 < gx - gw || cx - textW(str) / 2 > gx + gw;
        for (const br of brackets) {
          const x1 = tl.x(br.a), x2 = tl.x(br.b);
          if (!br.gap) {
            P.strip.appendChild(s("path", { d: `M${x1 + 1},${yl + 4}V${yl}H${x2 - 1}V${yl + 4}`, fill: "none", stroke: "var(--viz-muted)", "stroke-width": 1.2 }));
          }
          const lbl = fit(br.labels.filter(c => clear(c, (x1 + x2) / 2)), br.gap ? (compact ? 0 : 60) : x2 - x1 - 6);
          if (!lbl) continue;
          const el = ctx.text((x1 + x2) / 2, yl - 8, lbl, { size: G.fs, weight: 600, fill: "var(--viz-muted)" });
          P.strip.appendChild(timed(P, el, timeAt(P, (x1 + x2 + textW(lbl)) / 2)));
        }
      }

      // Finish line + "done" label on the axis; ticks under the label live in axisAlt (shown while it is hidden).
      function drawAxis(P, sc) {
        const { G } = view, tl = P.tl, y = P.top + G.axisY, xf = tl.x(sc.finish);
        const gain = sched.mr.finish - sc.finish;
        const lbl = `done ${sc.finish} min` + (P.key !== "df" || compact ? "" : gain > 0 ? `, ${gain} sooner` : gain < 0 ? `, ${-gain} later` : ", same time");
        const w = textW(lbl) * 1.05, lx = Math.min(xf, G.W - 2 - w / 2), lo = lx - w / 2 - 4, hi = lx + w / 2 + 4;
        const c = P.key === "df" && gain < 0 ? "var(--viz-bad)" : "var(--viz-ok)";
        P.fin.append(s("line", { x1: xf, x2: xf, y1: P.y0, y2: P.y1 + 3, stroke: c, "stroke-width": 2 }),
          ctx.text(lx, y, lbl, { size: G.fs, weight: 700, fill: c, halo: true }));
        const tick = (x, str) => {
          const tw = textW(str), a = x - tw / 2;
          const el = ctx.text(x, y, str, { size: G.fs, fill: "var(--viz-muted)" });
          (a + tw < lo || a > hi ? P.axis : P.axisAlt).appendChild(el);
        };
        for (let t = 0; t <= 60; t += 10) tick(tl.x(t), t === 60 ? "60 min" : String(t));
        // Where MapReduce finished, for comparison.
        if (P.key === "df") {
          P.ghost.appendChild(s("line", { x1: tl.x(sched.mr.finish), x2: tl.x(sched.mr.finish), y1: P.y0, y2: P.y1,
            stroke: "var(--viz-muted)", "stroke-width": 1.5, "stroke-dasharray": "4 4" }));
          P.ghost.appendChild(ctx.text(tl.x(sched.mr.finish), P.top + G.stripY - 8, ghostLabel(),
            { size: G.fs, weight: 600, fill: "var(--viz-muted)", halo: true }));
          P.ghost.appendChild(s("title", null, `MapReduce finished at ${sched.mr.finish} min`));
        }
      }

      function drawPanel(P, sc) {
        P.tl.clear();
        [P.strip, P.axis, P.axisAlt, P.ghost, P.fin, P.marks, P.cur].forEach(g => { g.innerHTML = ""; });
        P.timed = [];
        P.title.textContent = titleFor(P.key);
        sc.bars.forEach(b => drawBar(P, b));
        if (sc.kill !== null) drawKill(P, sc.kill);
        if (sc.mix) drawMix(P, sc.mix);
        drawStrip(P, sc.brackets);
        drawAxis(P, sc);
      }

      function draw() {
        sched = { mr: mapReduce(cfg), df: dataflow(cfg) };
        view.panels.forEach(P => drawPanel(P, sched[P.key]));
        const { mr, df } = sched, st = view.stats;
        st.set("mr", mr.finish + " min", "");
        st.set("df", df.finish + " min", df.finish < mr.finish - 2 ? "ok" : df.finish < mr.finish ? "warn" : "bad");
        st.set("written", "MR 603 · DF 3", "");
        st.set("reexec", `MR ${mr.reexec} · DF ${df.reexec}`, df.reexec > 3 ? "bad" : df.reexec ? "warn" : "");
        view.note.set(...noteFor(mr, df));
        // Footnotes: how the failure scenarios relate to real engines.
        const foot = !cfg.dies ? ""
          : cfg.mode === "pipe" ? "Flink's region failover restarts every task connected to the failed one through pipelined " +
            "exchanges (a pipelined region). The all-to-all exchanges here connect every task, so the region is the whole job. " +
            "That is why Flink's batch mode makes shuffles blocking by default: each stage becomes its own region, and recovery " +
            "looks like Stage by stage."
          : cfg.nondet ? "Simplified: real Spark reruns a whole nondeterministic stage and everything after it; the idea is the same." : "";
        view.foot.textContent = foot;
        view.foot.style.display = foot ? "" : "none";
        setCursor(null);
      }

      function noteFor(mr, df) {
        const pipe = cfg.mode === "pipe";
        if (cfg.dies && pipe) {
          const base = { ...cfg, dies: false }, lead0 = mapReduce(base).finish - dataflow(base).finish, lead = mr.finish - df.finish;
          return ["Pipelining kept nothing between parse, count and top-k, and the all-to-all exchanges connect every task to " +
            "W2's, so W2's death restarts the <b>whole pipelined region</b>, here the entire job: " +
            `<b>${df.reexec} tasks</b> rerun from the input in HDFS, with the spare taking W2's place. MapReduce reran only ` +
            "<b>2 tasks</b>: job 1's output was safe in HDFS. " +
            (lead > 0 ? `The lead shrank from ${lead0} to ${lead} minutes; it survives only because all four partitions rerun in ` +
              "parallel. The cluster redoes four times the work of Stage by stage, and on a busy cluster that capacity isn't free."
              : `The dataflow engine now finishes <b>${lead < 0 ? -lead + " min after" : "together with"} MapReduce</b>: the restart replays W3's slow parse as well.`) +
            (cfg.nondet ? " <i>A nondeterministic count does no extra harm here: nothing from the first attempt survives, so no task can mix two versions.</i>" : ""),
            lead > 0 ? "warn" : "bad"];
        }
        if (cfg.dies && cfg.nondet) {
          return ["<b>The recomputed counts may differ</b> from the ones the other top-k tasks already used (e.g. random sampling or " +
            "hash-order iteration). Mixing them would corrupt the result, so the engine discards their completed work (24 task-minutes) " +
            "and reruns them: <b>6 tasks re-executed</b>. Make operators deterministic (seeded randomness, no wall-clock, no hash-order " +
            "dependence) or checkpoint before them. MapReduce is immune here because job 1's output was frozen in HDFS.", "bad"];
        }
        if (cfg.dies) {
          return [`Only W2's partition is recomputed: its parse from the original input split (lineage), then its count and top-k, ` +
            `<b>3 tasks</b>, while the other workers' shuffle files on local disk survive. That pushes the dataflow engine to ` +
            `<b>${df.finish} min</b>, almost MapReduce's ${mr.finish}. Skipping materialization makes the happy path fast and recovery ` +
            "expensive; Spark lets you <code>checkpoint()</code> or persist with replication where recomputation would hurt.", "warn"];
        }
        let html, tone = "info";
        if (cfg.straggler) {
          tone = "warn";
          html = pipe
            ? `W3's slow parse task delays both engines by 8 minutes (<b>${df.finish} vs ${mr.finish}</b>): nothing downstream can ` +
              "finish before the slowest task. MapReduce pays it at a hard boundary, with W1, W2 and W4 idle; the dataflow engine " +
              "still overlaps count with the tail of parse."
            : `One slow task delays both engines at a stage boundary (<b>${df.finish} vs ${mr.finish}</b>); the dataflow engine ` +
              "simply has fewer boundaries and no ×3 writes between them.";
        } else if (pipe) {
          html = "Same computation, two engines. MapReduce must finish job 1 completely and write <b>600 GB</b> (200 GB × 3 replicas) " +
            "before job 2 can even start, and job 2 begins with a map stage that just re-reads that output. The dataflow engine " +
            `pipelines parse into count and keeps intermediate data local: <b>${df.finish} vs ${mr.finish} minutes</b>.`;
        } else {
          const piped = dataflow({ ...cfg, mode: "pipe" }).finish;
          html = "Spark-style: count can't start until every parse task has written its shuffle files to local disk, so the dataflow " +
            `engine finishes at <b>${df.finish}</b> instead of ${piped}. It is still far ahead of MapReduce's ${mr.finish}: most of the ` +
            "saving comes from skipping the ×3 HDFS write, the re-read map stage and job start-up, not from pipelining.";
        }
        if (cfg.nondet) {
          html += " <i>The nondeterministic count changes nothing yet: every task ran once, so all consumers saw the same counts. " +
            "It only matters when lost data has to be recomputed.</i>";
        }
        return [html, tone];
      }

      // ---------- play: a cursor sweeps both timelines and reveals them as time passes ----------
      function setCursor(t) {
        cursorT = t;
        const { G } = view, on = t !== null;
        view.panels.forEach((P, i) => {
          const sc = sched[P.key];
          [P.tl.content, P.strip].forEach(el => (on ? el.setAttribute("clip-path", `url(#${P.clipId})`) : el.removeAttribute("clip-path")));
          if (on) P.clipRect.setAttribute("width", P.tl.x(t));
          const done = !on || t >= sc.finish;
          P.fin.style.display = done ? "" : "none";
          P.axisAlt.style.display = done ? "none" : "";
          P.ghost.style.display = !on || t >= sched.mr.finish ? "" : "none";
          P.timed.forEach(o => { o.el.style.visibility = !on || t >= o.t ? "" : "hidden"; });
          P.cur.innerHTML = "";
          if (!on) return;
          const x = P.tl.x(t);
          P.cur.appendChild(s("line", { x1: x, x2: x, y1: P.y0 - 2, y2: P.y1 + 2, stroke: "var(--viz-info)", "stroke-width": 1.6, "stroke-dasharray": "4 3" }));
          if (i === 0) {
            const str = `t = ${Math.round(t)} min`, right = x + 6 + textW(str) < G.W - 2;
            P.cur.appendChild(ctx.text(right ? x + 6 : x - 6, P.top + G.stripY - 8, str,
              { size: G.fs, weight: 700, fill: "var(--viz-info)", anchor: right ? "start" : "end", halo: true }));
          }
        });
        view.playBtn.setLabel(playing ? "❚❚ Pause" : "▶ Play");
      }

      async function play() {
        if (playing) { playing = false; epoch++; setCursor(cursorT); return; }   // pause where we are
        const end = Math.max(sched.mr.finish, sched.df.finish);
        const from = cursorT !== null && cursorT < end ? cursorT : 0;
        const my = ++epoch;
        playing = true;
        setCursor(from);
        await ctx.tween({ ms: (4000 * (end - from)) / end, ease: "linear", onUpdate: k => { if (my === epoch) setCursor(from + (end - from) * k); } });
        if (my !== epoch) return;
        playing = false;
        setCursor(null);
      }
      function stop() { epoch++; playing = false; setCursor(null); }
      function changed() { epoch++; playing = false; draw(); }

      build();
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
