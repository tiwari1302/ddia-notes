// Queueing and the lying benchmark. One worker serves a FIFO queue during a 10-second load
// test. Response time = waiting + service: the waiting creates the tail, a timer inside the
// handler can't see it, and a closed-loop load generator never builds the queue at all.
(function () {
  "use strict";
  // Seed 5 sends ~12% too many requests (614 at 60%); 545 matches λ×10 and keeps the server-side p99 flat.
  const SEED = 545;
  const T_END = 10, FZ_A = 4, FZ_B = 5;   // test length and freeze window (s)
  const SLOW_MS = 200, N_MAX = 20000, N_CURVE = 20000;   // the curve uses long runs
  const CURVE_UTILS = [10, 20, 30, 40, 50, 60, 70, 80, 85, 90, 95];
  // Scatter y-axis ceilings and their tick steps (ms). One scale per util/slow/freeze setting.
  const Y_SCALES = [[250, 50], [500, 100], [750, 250], [1000, 250], [1250, 250], [1500, 500], [2000, 500], [2500, 500], [3000, 1000], [4000, 1000], [5000, 1000]];

  /** Fixed uniforms per request index, so a slider morphs the picture instead of reshuffling it. */
  function makeUniforms(rnd) {
    const U = { gap: [], slow: [], svc: [] };
    for (let i = 0; i < N_MAX; i++) { U.gap.push(rnd()); U.slow.push(rnd()); U.svc.push(rnd()); }
    return U;
  }

  /** One run against a single FIFO worker: a 10 s test, or `n` requests. Times in s, durations in ms. */
  function simulate(U, { util, slowPct, closed = false, freeze = false, n = 0 }) {
    const f = slowPct / 100;
    const lambda = util / 100 / (((1 - f) * 10 + f * SLOW_MS) / 1000);   // req/s
    const gap = i => -Math.log(1 - U.gap[i]) / lambda;                   // Poisson inter-arrival
    const reqs = [];
    let free = 0, next = closed ? 0 : gap(0);
    for (let i = 0; i < N_MAX && (n ? i < n : next <= T_END); i++) {
      const t = next, svc = U.slow[i] < f ? SLOW_MS : 8 + 4 * U.svc[i];
      let start = Math.max(t, free);
      if (freeze && start >= FZ_A && start < FZ_B) start = FZ_B;
      free = start + svc / 1000;
      reqs.push({ t, start, svc, slow: svc === SLOW_MS, resp: (free - t) * 1000 });
      // Closed loop: one virtual user paced at 1/λ that never has two requests outstanding.
      next = closed ? Math.max(free, t + 1 / lambda) : t + gap(i + 1);
    }
    return { reqs, intervalMs: 1000 / lambda };
  }

  /** Nearest-rank percentiles, e.g. pcts(values, 0.5, 0.99) -> [p50, p99]. */
  function pcts(vals, ...qs) {
    const a = Float64Array.from(vals).sort();
    return qs.map(q => (a.length ? a[Math.max(0, Math.ceil(q * a.length) - 1)] : 0));
  }

  // Most requests waiting at once. Starts are monotonic (FIFO): when request i arrives,
  // requests k..i-1 haven't started yet, and neither has i itself unless the server is idle.
  function maxQueue(reqs) {
    let k = 0, max = 0;
    reqs.forEach((r, i) => {
      while (k < i && reqs[k].start <= r.t) k++;
      max = Math.max(max, i - k + (r.start > r.t ? 1 : 0));
    });
    return max;
  }

  /** Seconds after the freeze until the server is idle again. */
  function drainTime(reqs) {
    let end = FZ_B;
    for (const r of reqs) if (r.start >= FZ_B) { if (r.t >= end) break; end = r.start + r.svc / 1000; }
    return end - FZ_B;
  }

  /** Client-side samples; with the correction, HdrHistogram's recordValueWithExpectedInterval. */
  function clientSamples(run, correct) {
    const out = run.reqs.map(r => ({ t: r.t, v: r.resp, slow: r.slow }));
    const I = run.intervalMs;
    if (correct) run.reqs.forEach(r => {
      for (let v = r.resp - I, k = 1; v >= I; v -= I, k++) out.push({ t: r.t + (k * I) / 1000, v, hollow: true });
    });
    return out;
  }

  /** Slow requests and how many later arrivals landed while each one held the worker. */
  function blockers(reqs) {
    const out = [];
    reqs.forEach((r, i) => {
      if (!r.slow) return;
      const end = r.start + r.svc / 1000;
      let j = i + 1, peak = r.resp;
      for (; j < reqs.length && reqs[j].t < end; j++) peak = Math.max(peak, reqs[j].resp);
      out.push({ t: r.t, resp: r.resp, peak, n: j - i - 1 });
    });
    return out;
  }

  function analyze(U, st) {
    const closed = st.gen === "closed", base = { util: st.util, slowPct: st.slowPct, freeze: st.freeze };
    const run = simulate(U, { ...base, closed });
    const open = closed ? simulate(U, base) : run;
    const client = clientSamples(run, closed && st.correct);
    const server = run.reqs.map(r => ({ t: r.t, v: r.svc, slow: r.slow }));
    const shown = st.measure === "server" ? server : client;
    const v = a => a.map(d => d.v);
    const frozen = open.reqs.filter(r => r.t >= FZ_A && r.t < FZ_B), [p50, p99] = pcts(v(shown), 0.5, 0.99);
    // The open-loop run sets the y scale, so switching generator or measure never rescales.
    const yMax = Math.max(...open.reqs.map(r => r.resp), ...v(shown));
    return {
      shown, yMax, intervalMs: run.intervalMs, blockers: blockers(run.reqs),
      worst: run.reqs.reduce((w, r) => (r.resp > w.resp ? { t: r.t, resp: r.resp, peak: r.resp } : w), { resp: -1 }),
      sent: run.reqs.length, openSent: open.reqs.length,
      p50, p99, p99Client: pcts(v(client), 0.99)[0], p99Raw: pcts(run.reqs.map(r => r.resp), 0.99)[0],
      p99Server: pcts(v(server), 0.99)[0], p99Open: pcts(open.reqs.map(r => r.resp), 0.99)[0],
      synthetic: client.length - run.reqs.length, maxQueue: maxQueue(run.reqs),
      inFreeze: frozen.length, freezeWaitS: Math.max(0, ...frozen.map(r => r.start - r.t)), drainS: drainTime(open.reqs),
      over250: run.reqs.filter(r => r.resp > 250).length, stalled: run.reqs.filter(r => r.resp > 500).length,
    };
  }

  /** One point of the utilization curve: a long open-loop run, so it shows the steady state. */
  function curvePoint(U, u, slowPct) {
    const [p50, p99] = pcts(simulate(U, { util: u, slowPct, n: N_CURVE }).reqs.map(r => r.resp), 0.5, 0.99);
    return { u, p50, p99 };
  }

  const tone = v => (v < 50 ? "ok" : v <= 250 ? "warn" : "bad");
  const fmtMs = v => (v >= 1000 ? +(v / 1000).toFixed(2) + " s" : Math.round(v) + (v ? " ms" : ""));
  const niceCeil = v => {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 50))));
    return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(m => m * p).find(c => c >= v);
  };
  /** Approximate text box, for keeping labels apart. */
  const tbox = (x, y, str, fs, anchor) => {
    const w = str.length * fs * 0.58, x0 = anchor === "end" ? x - w : anchor === "start" ? x : x - w / 2;
    return { x0, x1: x0 + w, y0: y - fs * 0.6, y1: y + fs * 0.6 };
  };
  const hits = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const dotsUnder = (b, pts) => pts.reduce((n, p) => n + (p.x > b.x0 - 3 && p.x < b.x1 + 3 && p.y > b.y0 - 3 && p.y < b.y1 + 3 ? p.w : 0), 0);

  const PRESETS = [
    { label: "Busy server", set: { util: 90, slowPct: 0.5, gen: "open", freeze: false, measure: "client" } },
    { label: "Server-side timer", set: { util: 60, slowPct: 0.5, gen: "open", freeze: false, measure: "server" } },
    { label: "Benchmark lies", set: { util: 60, slowPct: 0.5, gen: "closed", freeze: true, measure: "client", correct: false } },
  ];

  Viz.register("ch1/queueing", {
    title: "Queueing and the lying benchmark",
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      const U = makeUniforms(ctx.random(SEED));
      // State lives outside build() so a layout switch (phone <-> desktop) keeps it.
      const st = { util: 60, slowPct: 0.5, gen: "open", freeze: false, measure: "client", correct: false };
      let compact = ctx.compact, view = null, A = null, reveal = 0;
      const curveCache = new Map();
      const curveFor = () => [...new Set([...CURVE_UTILS, st.util])].sort((a, b) => a - b).map(u => {
        const key = u + "/" + st.slowPct;
        if (!curveCache.has(key)) curveCache.set(key, curvePoint(U, u, st.slowPct));
        return curveCache.get(key);
      });

      function set(patch) { Object.assign(st, patch); sync(); update(); }

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const fs = compact ? 11 : 12;
        const c = {
          util: ui.slider({ label: "Server busy (utilization)", min: 10, max: 95, step: 5, value: st.util, format: v => v + "%", onInput: v => set({ util: v }) }),
          slow: ui.slider({ label: "Slow requests (200 ms)", min: 0, max: 5, step: 0.5, value: st.slowPct, format: v => v + "%", onInput: v => set({ slowPct: v }) }),
          gen: ui.segmented({
            label: "Load generator", value: st.gen, onChange: v => set({ gen: v }),
            options: [{ value: "open", label: compact ? "Open loop" : "Open loop (real users)" },
                      { value: "closed", label: compact ? "Closed loop" : "Closed loop (waits for reply)" }],
          }),
          freeze: ui.toggle({ label: "Freeze server 1 s at t = 4 s", value: st.freeze, onChange: v => set({ freeze: v }) }),
          measure: ui.segmented({ label: "Measure", value: st.measure, onChange: v => set({ measure: v }),
            options: [{ value: "client", label: "Client" }, { value: "server", label: "Server" }] }),
          correct: ui.toggle({ label: "Correct for coordinated omission", value: st.correct, onChange: v => set({ correct: v }) }),
        };
        const presets = PRESETS.map(p => {
          const b = ui.button(p.label, () => set({ correct: false, ...p.set }), { title: "Set the controls for this scenario" });
          b.preset = p.set;
          return b;
        });
        view = {
          c, presets, legend: buildLegend(), note: ui.note(""), sc: buildScatter(fs), cu: buildCurve(fs),
          stats: ui.stats([
            { key: "sent", label: "Requests sent" }, { key: "p50", label: "p50" }, { key: "p99", label: "p99" },
            { key: "srv", label: "Server-side p99" }, { key: "queue", label: "Max queue" },
          ]),
        };
        root.append(
          ui.bar(h("span", { class: "viz-seg-label" }, "Try:"), ...presets),
          ui.bar(c.util, c.slow),
          ui.bar(c.gen, c.freeze),
          ui.bar(c.measure, c.correct, ui.button("▶ Run 10-second test", runTest, { kind: "primary" })),
          view.sc.svg, view.stats, view.note, view.legend, view.cu.svg,
          h("div", { style: "font-size:12.5px;line-height:1.5;color:var(--viz-muted);margin-top:6px" },
            "Illustrative model, not measurements: one worker, FIFO queue, fast requests take 8–12 ms, slow ones 200 ms; " +
            "open-loop users arrive at random (Poisson). Each curve point is a long run (20,000 requests), so it can " +
            "differ from one 10-second test. Percentiles use nearest rank."),
        );
        sync();
        update();
      }

      function buildLegend() {
        const el = ui.legend([
          { color: "var(--viz-ok)", label: "< 50 ms" },
          { color: "var(--viz-warn)", label: "50–250 ms" },
          { color: "var(--viz-bad)", label: "> 250 ms" },
          { color: "var(--viz-warn)", label: "a 200 ms request", shape: "square" },
          { color: "transparent", label: "back-filled sample" },
          { color: "var(--viz-c2)", label: "p50", shape: "line" },
          { color: "var(--viz-c5)", label: "p99", shape: "line" },
          { color: "var(--viz-bad-soft)", label: "server frozen", shape: "square" },
        ]);
        // ui.legend has no outlined swatches; outline the ones drawn with a stroke in the chart.
        const items = el.children;
        [[3, "var(--viz-ink)"], [4, "var(--viz-warn)"], [7, "var(--viz-bad)"]].forEach(([i, col]) => {
          items[i].firstChild.style.cssText += ";box-sizing:border-box;border:1.5px solid " + col;
        });
        el.hollow = items[4];
        el.frozen = items[7];
        return el;
      }

      function sync() {
        const { c, presets } = view;
        c.util.set(st.util); c.slow.set(st.slowPct); c.gen.set(st.gen);
        c.freeze.set(st.freeze); c.measure.set(st.measure); c.correct.set(st.correct);
        c.correct.style.display = st.gen === "closed" ? "" : "none";
        presets.forEach(b => b.setActive(Object.keys(b.preset).every(k => b.preset[k] === st[k])));
      }

      function buildScatter(fs) {
        const W = compact ? 360 : 640;
        const g = { x0: compact ? 40 : 54, x1: compact ? 350 : 624, y0: 26, y1: 212, r: compact ? 2.2 : 2.4, fs };
        const X = t => g.x0 + (t / T_END) * (g.x1 - g.x0);
        const svg = ctx.svg({ w: W, h: 250, label: "Latency of every request during the 10-second test" });
        const muted = { size: fs, fill: "var(--viz-muted)" };
        [0, 2, 4, 6, 8, 10].forEach(t => svg.append(ctx.text(X(t), g.y1 + 14, String(t), muted)));
        svg.append(ctx.text((g.x0 + g.x1) / 2, g.y1 + 31, "time the request was sent (s)", muted));
        const yCap = ctx.text(4, 12, "", { ...muted, anchor: "start" });
        const band = s("g", null,
          s("rect", { x: X(FZ_A), y: g.y0, width: X(FZ_B) - X(FZ_A), height: g.y1 - g.y0, fill: "var(--viz-bad-soft)" }),
          ctx.text(X((FZ_A + FZ_B) / 2), 12, "server frozen", { size: fs, weight: 700, fill: "var(--viz-bad)" }));
        const grid = s("g"), dots = s("g"), annot = s("g"), lines = s("g");
        const cursor = s("line", { y1: g.y0 - 4, y2: g.y1, stroke: "var(--viz-c1)", "stroke-width": 1.5, "stroke-dasharray": "4 3", visibility: "hidden" });
        svg.append(yCap, band, grid, dots, annot, lines, cursor);
        return { svg, g, X, yCap, band, grid, dots, annot, lines, cursor, items: [], labels: [] };
      }

      function buildCurve(fs) {
        const W = compact ? 360 : 640;
        const g = { x0: compact ? 44 : 54, x1: compact ? 350 : 624, y0: 30, y1: 150, fs };
        const X = u => g.x0 + ((u - 10) / 90) * (g.x1 - g.x0);
        const svg = ctx.svg({ w: W, h: 192, label: "p50 and p99 response time versus utilization" });
        const muted = { size: fs, fill: "var(--viz-muted)" };
        svg.append(ctx.text(4, 12, "p50 and p99 vs how busy the server is", { size: fs, anchor: "start", weight: 700 }));
        [10, 30, 50, 70, 90].forEach(u => svg.append(ctx.text(X(u), g.y1 + 15, u + "%", muted)));
        svg.append(ctx.text((g.x0 + g.x1) / 2, g.y1 + 32, "utilization (long open-loop runs, no freeze)", muted));
        const grid = s("g"), plot = s("g");
        svg.append(grid, plot);
        return { svg, g, X, grid, plot };
      }

      function dotEl(d, g, x, y) {
        const fill = `var(--viz-${tone(d.v)})`;
        if (y < g.y0) return s("path", { d: `M${x},${g.y0 - 6}l3.5,6h-7z`, fill });   // off the scale
        if (d.slow) return s("rect", { x: x - 3, y: y - 3, width: 6, height: 6, fill, stroke: "var(--viz-ink)", "stroke-width": 0.9 });
        return d.hollow
          ? s("circle", { cx: x, cy: y, r: g.r, fill: "none", stroke: fill, "stroke-width": 1.1 })
          : s("circle", { cx: x, cy: y, r: g.r, fill });
      }

      function drawScatter() {
        const sc = view.sc, { g, X } = sc;
        reveal++;   // cancels a running "Run test" reveal
        const [top, step] = Y_SCALES.find(([m]) => m >= A.yMax) || Y_SCALES[Y_SCALES.length - 1];
        const Y = sc.Y = v => g.y1 - (v / top) * (g.y1 - g.y0);
        sc.grid.innerHTML = "";
        for (let v = 0; v <= top; v += step) sc.grid.append(
          s("line", { x1: g.x0, x2: g.x1, y1: Y(v), y2: Y(v), stroke: v ? "var(--viz-grid)" : "var(--viz-line)" }),
          ctx.text(g.x0 - 6, Y(v), String(v), { size: g.fs, fill: "var(--viz-muted)", anchor: "end" }));
        sc.yCap.textContent = st.measure === "server"
          ? (compact ? "service time (ms)" : "service time inside the handler (ms)")
          : (compact ? "response time (ms)" : "response time seen by clients (ms)");
        sc.band.style.display = st.freeze ? "" : "none";
        sc.dots.innerHTML = "";
        const pts = [];
        sc.items = A.shown.filter(d => d.t <= T_END).sort((a, b) => a.t - b.t).map(d => {
          const x = X(d.t), y = Y(d.v), el = dotEl(d, g, x, y);
          el._t = d.t;
          // Label placement weight: never hide a 200 ms square; tail dots matter more than the fast band.
          pts.push({ x, y, w: d.slow ? 50 : d.v >= 50 ? 1 : 0.02 });
          sc.dots.appendChild(el);
          return el;
        });
        drawLines(sc, pts);
        drawAnnotation(sc, pts);
        [sc.lines, sc.annot].forEach(el => el.setAttribute("visibility", "visible"));
        sc.cursor.setAttribute("visibility", "hidden");
      }

      function drawLines(sc, pts) {
        const { g, Y } = sc;
        sc.lines.innerHTML = "";
        const ends = compact ? [["start", g.x0 + 4], ["end", g.x1 - 2]] : [["end", g.x1 - 2], ["start", g.x0 + 4]];
        // Candidate label spots: either end of the plot, above or below the line (p99 may also sit a
        // row higher, above p50's label). Cost = dots hidden, plus small tie-breaking preferences.
        const spots = (name, v, c, offsets) => {
          const y = Math.max(g.y0, Y(v)), str = `${name} · ${Math.round(v)} ms`;
          return ends.flatMap(([anchor, x], ei) => offsets.map((dy, oi) => {
            const b = tbox(x, y + dy, str, g.fs, anchor), out = b.y0 < g.y0 - 4 || b.y1 > g.y1 - 1;
            return { str, c, y, anchor, x, ly: y + dy, b, cost: dotsUnder(b, pts) + (out ? 1e4 : 0) + [0, 0.6, 10][oi] + ei * 0.3 };
          }));
        };
        let best = null;
        for (const a of spots("p99", A.p99, "c5", [-8, 10, -23])) for (const b of spots("p50", A.p50, "c2", [-8, 10])) {
          const cost = a.cost + b.cost + (hits(a.b, b.b) ? 1e4 : 0);
          if (!best || cost < best.cost) best = { cost, specs: [b, a] };
        }
        best.specs.forEach(sp => sc.lines.append(
          s("line", { x1: g.x0, x2: g.x1, y1: sp.y, y2: sp.y, stroke: `var(--viz-${sp.c})`, "stroke-width": 1.6, "stroke-dasharray": "6 4" })));
        sc.labels = best.specs.map(({ b, x, ly, str, anchor, c }) => {
          sc.lines.append(   // a backing pill keeps the label readable on top of a dense band of dots
            s("rect", { x: b.x0 - 3, y: b.y0 - 1, width: b.x1 - b.x0 + 6, height: b.y1 - b.y0 + 2, rx: 4, fill: "var(--viz-bg)", opacity: 0.88 }),
            ctx.text(x, ly, str, { size: g.fs, anchor, weight: 700, fill: `var(--viz-${c})` }));
          return b;
        });
      }

      // Call out the request that tells the story: a 200 ms request with fast ones queued behind it
      // (head-of-line blocking), or the closed-loop benchmark's lone sample from the freeze.
      function drawAnnotation(sc, pts) {
        const { g, X, Y } = sc, closed = st.gen === "closed";
        sc.annot.innerHTML = "";
        if (st.measure !== "client" || A.synthetic || (st.freeze && !closed)) return;
        const targets = st.freeze
          ? [{ ...A.worst, str: compact ? "lone sample from the freeze" : "the benchmark's only sample from the freeze" }]
          : A.blockers.filter(b => closed || b.n >= 2).sort((a, b) => b.n - a.n).map(b => ({ ...b,
            str: closed ? (compact ? "client waited: nothing queued" : "the client waited for it, so nothing queued behind it")
              : compact ? `${b.n} requests wait behind it` : `${b.n} fast requests wait behind this 200 ms one` }));
        const fits = b => b.x0 >= g.x0 && b.x1 <= g.x1 && b.y0 >= g.y0 && b.y1 <= g.y1 &&
          !sc.labels.some(l => hits(l, b)) && dotsUnder(b, pts) <= 1;
        for (const tg of targets) {
          const x = X(tg.t), y = Y(tg.resp), top = Y(tg.peak) - 16;
          const spot = [
            { anchor: "end", tx: x - 13, ty: y, lead: [x - 11, y, x - 5, y] },          // left of it
            { anchor: "start", tx: x + 13, ty: y, lead: [x + 5, y, x + 11, y] },        // right of it
            { anchor: "start", tx: x - 4, ty: top, lead: [x, top + 7, x, y - 5] },     // above, to the right
            { anchor: "end", tx: x + 4, ty: top, lead: [x, top + 7, x, y - 5] },       // above, to the left
          ].find(p => fits(tbox(p.tx, p.ty, tg.str, g.fs, p.anchor)));
          if (!spot) continue;
          const [x1, y1, x2, y2] = spot.lead;
          sc.annot.append(
            s("line", { x1, y1, x2, y2, stroke: "var(--viz-ink)", "stroke-width": 1.2 }),
            ctx.text(spot.tx, spot.ty, tg.str, { size: g.fs, anchor: spot.anchor, weight: 600, halo: true }));
          return;
        }
      }

      function drawCurve() {
        const cu = view.cu, { g, X } = cu;
        const top = niceCeil(Math.max(...A.curve.map(p => p.p99)));
        const Y = v => g.y1 - (v / top) * (g.y1 - g.y0);
        cu.grid.innerHTML = ""; cu.plot.innerHTML = "";
        [0, top / 2, top].forEach(v => cu.grid.append(
          s("line", { x1: g.x0, x2: g.x1, y1: Y(v), y2: Y(v), stroke: v ? "var(--viz-grid)" : "var(--viz-line)" }),
          ctx.text(g.x0 - 6, Y(v), fmtMs(v), { size: g.fs, anchor: "end", fill: "var(--viz-muted)" })));
        const path = key => A.curve.map((p, i) => (i ? "L" : "M") + X(p.u).toFixed(1) + "," + Y(p[key]).toFixed(1)).join("");
        const line = (key, stroke) => s("path", { d: path(key), fill: "none", stroke, "stroke-width": 2.5, "stroke-linejoin": "round" });
        const cur = A.curve.find(p => p.u === st.util), mx = X(cur.u), my = Y(cur.p99), left = cur.u <= 30;
        cu.plot.append(
          line("p50", "var(--viz-c2)"),
          line("p99", "var(--viz-c5)"),
          s("line", { x1: mx, x2: mx, y1: g.y1, y2: my, stroke: "var(--viz-c5)", "stroke-width": 1, "stroke-dasharray": "3 3" }),
          s("circle", { cx: mx, cy: my, r: 5.5, fill: "var(--viz-c5)", stroke: "var(--viz-bg)", "stroke-width": 2 }),
          // Label above-left of the marker, where the rising curve is lower; at the far left, above-right.
          ctx.text(mx + (left ? 10 : -10), Math.max(g.y0 + 2, my - 12), `p99 ${fmtMs(cur.p99)} at ${cur.u}%`,
            { size: g.fs, anchor: left ? "start" : "end", weight: 700, fill: "var(--viz-c5)", halo: true }));
      }

      function explain() {
        const ms = v => `<b>${Math.round(v)} ms</b>`, closed = st.gen === "closed";
        if (st.measure === "server") return ["bad",
          `A timer inside the request handler only sees service time (p99 = ${ms(A.p99Server)}). It can't see the time clients spent ` +
          `queued before the handler started (their p99 is ${ms(A.p99Client)}). Measure response time where the client is.`];
        if (closed && st.correct) {
          if (!A.synthetic) return ["ok", `No response took two send intervals (${ms(2 * A.intervalMs)}), so there is nothing to back-fill: ` +
            `p99 stays ${ms(A.p99)} (independent users see ${ms(A.p99Open)}).`];
          const close = A.p99 > A.p99Open / 1.5 && A.p99 < A.p99Open * 1.5;
          return ["ok", `Back-filling the <b>${A.synthetic}</b> requests the client should have sent while it was waiting (HdrHistogram's ` +
            `expected-interval correction, hollow dots) brings p99 from ${ms(A.p99Raw)} to ${ms(A.p99)}, ` +
            (close ? `close to the ${ms(A.p99Open)} that independent users see. `
                   : `versus ${ms(A.p99Open)} for independent users: it approximates an open-loop test but isn't one. `) +
            `The fix is to send on a schedule, or at least measure from the intended send time.`];
        }
        if (closed && st.freeze) return ["bad",
          `The closed-loop client sat waiting on one request during the freeze, so it sent <b>${A.sent}</b> requests where independent users ` +
          `would have sent about <b>${A.openSent}</b>. It recorded ${A.stalled === 1 ? "one slow sample" : A.stalled + " slow samples"}: ` +
          `p99 = ${ms(A.p99)}. The benchmark omitted exactly the slow requests (Gil Tene calls this <em>coordinated omission</em>).`];
        if (st.freeze) return ["bad",
          `Real users don't stop clicking because your server paused: <b>${A.inFreeze}</b> requests arrived during the 1 s freeze and all of ` +
          `them waited (up to ${A.freezeWaitS.toFixed(1)} s); ` + (FZ_B + A.drainS < T_END
            ? `draining the backlog took about <b>${A.drainS.toFixed(1)} s</b> more. ` : `the backlog still hadn't drained when the test ended. `) +
          `<b>${A.over250}</b> requests took over 250 ms; p99 = ${ms(A.p99)}.`];
        if (closed) return ["warn",
          `With at most one request in flight, a closed-loop benchmark can never build a queue: it reports p99 = ${ms(A.p99)} versus ` +
          `${ms(A.p99Open)} for independent users at the same rate. Load generators must send on schedule, whatever the responses.`];
        if (A.p99Server >= SLOW_MS) return ["warn",
          `Now about ${st.slowPct}% of requests are slow, so the 200 ms requests are themselves the server-side p99, and the requests ` +
          `queued behind them push the client p99 higher still (${ms(A.p99)}).`];
        if (st.util >= 85) return ["bad",
          `At ${st.util}% busy the queue rarely empties: even the median is ${ms(A.p50)} and p99 is ${ms(A.p99)}, although a typical ` +
          `request needs 10 ms of work. Response time grows non-linearly as utilization approaches 100%, so keep headroom.`];
        if (st.slowPct === 0 && st.util <= 40) return ["ok",
          `Uniform work and low load: there is almost no queue, so p99 ≈ service time (${ms(A.p99)}). Queueing, not work, is what creates the tail.`];
        if (A.p99 < 2 * A.p99Server) return ["ok",
          `At ${st.util}% busy there is little queueing: clients see p99 = ${ms(A.p99)}, close to the server-side ${ms(A.p99Server)}. ` +
          `Raise the utilization to watch the tail grow.`];
        if (st.slowPct === 0) return ["warn",
          `At ${st.util}% busy every request needs 8–12 ms of work, yet clients see p99 = ${ms(A.p99)}: random arrivals sometimes bunch up ` +
          `and wait for each other. Add a few slow requests to see head-of-line blocking.`];
        return ["warn",
          `At ${st.util}% busy a fast request needs ~10 ms of work, yet clients see p99 = ${ms(A.p99)} while the server-side p99 is ` +
          `${ms(A.p99Server)}. The gap is waiting, mostly behind the occasional 200 ms request (<em>head-of-line blocking</em>).`];
      }

      function update() {
        A = analyze(U, st);
        A.curve = curveFor();
        const { stats, note, legend } = view;
        stats.set("sent", A.sent);
        stats.set("p50", fmtMs(A.p50), tone(A.p50));
        stats.set("p99", fmtMs(A.p99), tone(A.p99));
        stats.set("srv", fmtMs(A.p99Server), "ok");
        stats.set("queue", A.maxQueue);
        const [t, html] = explain();
        note.set(html, t);
        legend.frozen.style.display = st.freeze ? "" : "none";
        legend.hollow.style.display = A.shown.some(d => d.hollow) ? "" : "none";
        drawScatter();
        drawCurve();
      }

      // Replay the test: reveal the dots left to right, then show the percentile lines.
      async function runTest() {
        const sc = view.sc, my = ++reveal, items = sc.items;
        items.forEach(el => el.setAttribute("visibility", "hidden"));
        [sc.lines, sc.annot].forEach(el => el.setAttribute("visibility", "hidden"));
        let k = 0;
        await ctx.tween({ ms: 1500, ease: "linear", onUpdate: f => {
          if (my !== reveal) return;
          const now = f * T_END;
          ctx.attr(sc.cursor, { x1: sc.X(now), x2: sc.X(now), visibility: f < 1 ? "visible" : "hidden" });
          while (k < items.length && items[k]._t <= now) items[k++].removeAttribute("visibility");
        } });
        if (my === reveal) [sc.lines, sc.annot].forEach(el => el.setAttribute("visibility", "visible"));
      }

      build();
      // Rebuild with the other layout when the frame crosses the phone breakpoint (onResize
      // callbacks already run on the next frame, outside the ResizeObserver).
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
