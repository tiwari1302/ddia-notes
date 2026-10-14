// Tuning a failure detector. Monitor M expects a heartbeat from node B every second and
// declares B dead once the silence exceeds a threshold: a fixed timeout, or a simplified
// φ accrual detector that learns the gap distribution. Network load and GC pauses stretch
// the gaps (false alarms); crashing B shows how long a real failure goes unnoticed.
(function () {
  "use strict";

  const PERIOD = 1000, SPAN = 40000, WINDOW = 60, SIGMA_FLOOR = 100;   // ms
  // φ -> z: suspect once a gap is z standard deviations above the mean (normal tail ≈ 10^-φ).
  const Z = [0, 1.28, 2.33, 3.09, 3.72, 4.26, 4.75, 5.2, 5.61, 6.0, 6.36, 6.71, 7.03];
  const DEFAULTS = { mode: "fixed", timeout: 1.5, phi: 8, load: 60, gc: 1 };
  const SCRIPTED_GC = [{ at: 22000, dur: 2500 }];   // guarantees a false alarm in the first frame
  const meanDelay = load => 5 + 600 * Math.pow(load / 100, 3);   // queueing delay explodes near 100%
  const sec = ms => (ms / 1000).toFixed(1);
  const times = n => (n === 1 ? "once" : n === 2 ? "twice" : n + " times");

  /** Event-driven simulation in sim-time ms. hooks: log(t, html, tone), send(heartbeat). */
  function createSim(rnd, cfg, hooks = {}, scripted = []) {
    scripted = scripted.slice();
    const sim = {
      now: 0, cfg: { ...cfg }, b: "alive", nextSend: PERIOD, pauseEnd: 0, nextGC: Infinity, gc: null,
      inflight: [], lastArrival: 0, window: [], theta: 0, thSince: 0, suspect: null,
      dots: [], bands: [], gcs: [], ths: [], crashes: [], restarts: [],
      statsSince: 0, falseAlarms: 0, faGC: 0, faQueue: 0, crash: null, lastCrash: null, restartPending: false,
    };
    const log = (html, tone) => hooks.log && hooks.log(sim.now, html, tone);
    // Jittered rather than Poisson: exponential gaps leave minute-long droughts that read as "6/min is broken".
    const gcAfter = () => (sim.cfg.gc > 0 ? sim.now + (60000 / sim.cfg.gc - 2750) * (0.4 + 1.2 * rnd()) : Infinity);

    sim.gapStats = () => {
      const w = sim.window, mu = w.reduce((a, g) => a + g, 0) / w.length;
      const sd = Math.sqrt(w.reduce((a, g) => a + (g - mu) ** 2, 0) / w.length);
      return { mu, sigma: Math.max(SIGMA_FLOOR, sd) };
    };
    sim.threshold = () => (sim.cfg.mode === "fixed" ? sim.cfg.timeout * 1000 : sim.theta);
    function updateTheta() {
      const { mu, sigma } = sim.gapStats();
      sim.theta = mu + Z[sim.cfg.phi] * sigma;
    }
    function recordThreshold() {
      let last = sim.ths[sim.ths.length - 1];
      if (last && last.t === sim.now) { sim.ths.pop(); last = sim.ths[sim.ths.length - 1]; }
      const v = sim.threshold(), mode = sim.cfg.mode;
      if (!last || last.v !== v || last.mode !== mode) sim.ths.push({ t: sim.now, v, mode });
    }

    function send() {
      const lost = sim.cfg.load >= 70 && rnd.chance(0.02);
      const delay = 2 + rnd.exp(meanDelay(sim.cfg.load)) + (lost ? 1000 : 0);
      const hb = { sent: sim.now, arrive: sim.now + delay, lost, restart: sim.restartPending };
      sim.restartPending = false;
      sim.inflight.push(hb);
      sim.nextSend = sim.now + PERIOD;
      if (lost) log("B heartbeat lost; TCP retransmitted", "muted");
      if (hooks.send) hooks.send(hb);
    }
    function startPause(dur) {
      sim.b = "paused";
      sim.pauseEnd = sim.now + dur;
      sim.gc = { start: sim.now, end: sim.pauseEnd };
      sim.gcs.push(sim.gc);
      log(`B paused for garbage collection (${sec(dur)} s)`, "warn");
    }
    function endPause() {
      sim.b = "alive";
      sim.nextGC = gcAfter();
      send();   // B catches up immediately, then resumes the 1 s schedule
    }
    function detected() {
      sim.crash.detectAt = sim.now;
      log(`Crash detected after ${sec(sim.now - sim.crash.t)} s`, "warn");
    }
    function suspectNow() {
      sim.suspect = { start: sim.now, end: null };
      sim.bands.push(sim.suspect);
      if (sim.crash && sim.crash.detectAt === null) detected();
    }
    function arrive(hb) {
      sim.inflight.splice(sim.inflight.indexOf(hb), 1);
      const prev = sim.lastArrival, sus = sim.suspect;
      sim.lastArrival = sim.now;
      // The first heartbeat after a restart spans the outage: not a real sample of the gap distribution.
      if (!hb.restart) {
        sim.dots.push({ t: sim.now, gap: sim.now - prev, red: !!sus });
        sim.window.push(sim.now - prev);
        if (sim.window.length > WINDOW) sim.window.shift();
        updateTheta();
        recordThreshold();
      }
      if (sim.crash && sim.crash.detectAt !== null) {
        sim.crash.detectAt = null;
        log("A heartbeat B sent before crashing arrived late: M thinks B is alive again", "muted");
      }
      if (!sus) return;
      sus.end = sim.now;
      sim.suspect = null;
      if (hb.restart || (sim.crash && sus.start >= sim.crash.t)) return;   // B really was dead
      sus.falseAlarm = true;
      if (sus.start >= sim.statsSince) {
        sim.falseAlarms++;
        if (sim.gcs.some(g => g.start < sim.now && g.end > prev)) sim.faGC++; else sim.faQueue++;
      }
      log(`False alarm: B declared dead at ${sec(sus.start)} s, heartbeat arrived at ${sec(sim.now)} s`, "bad");
    }
    function prune() {
      const cut = sim.now - SPAN - 2000;
      const drop = (arr, end) => { while (arr.length && end(arr[0]) < cut) arr.shift(); };
      drop(sim.dots, d => d.t);
      drop(sim.bands, b => (b.end === null ? Infinity : b.end));
      drop(sim.gcs, g => g.end);
      drop(sim.restarts, t => t);
      drop(sim.crashes, c => (c.restartAt === null ? Infinity : c.restartAt));
      while (sim.ths.length > 1 && sim.ths[1].t < cut) sim.ths.shift();
    }

    /** Process every event up to `to` in time order. On ties the first candidate wins. */
    sim.advance = to => {
      for (;;) {
        let t = Infinity, act = null;
        const consider = (tt, fn) => { if (tt < t) { t = tt; act = fn; } };
        let first = null;
        sim.inflight.forEach(hb => { if (!first || hb.arrive < first.arrive) first = hb; });
        if (first) consider(first.arrive, () => arrive(first));   // a gap equal to the threshold is fine
        if (!sim.suspect) consider(Math.max(sim.lastArrival + sim.threshold(), sim.thSince), suspectNow);
        if (sim.b === "alive") {
          while (scripted.length && scripted[0].at < sim.now) scripted.shift();   // B was busy then
          consider(sim.nextSend, send);
          consider(sim.nextGC, () => startPause(1500 + 2500 * rnd()));
          if (scripted.length) consider(scripted[0].at, () => startPause(scripted.shift().dur));
        }
        if (sim.b === "paused") consider(sim.pauseEnd, endPause);
        if (t > to) break;
        sim.now = t;
        act();
      }
      sim.now = to;
      prune();
    };

    /** New settings apply from now on; history stays, counters restart. */
    sim.set = patch => {
      Object.assign(sim.cfg, patch);
      if ("gc" in patch && sim.b === "alive") sim.nextGC = gcAfter();
      updateTheta();
      sim.thSince = sim.now;
      recordThreshold();
      sim.statsSince = sim.now;
      sim.falseAlarms = sim.faGC = sim.faQueue = 0;
      log("settings changed: counters reset", "muted");
      sim.advance(sim.now);
    };
    sim.crashB = () => {
      if (sim.b === "paused") sim.gc.end = sim.now;
      sim.b = "crashed";
      sim.crash = sim.lastCrash = { t: sim.now, detectAt: null, restartAt: null };
      sim.crashes.push(sim.crash);
      log("B crashed", "bad");
      if (sim.suspect) detected();
    };
    sim.restartB = () => {
      sim.crash.restartAt = sim.now;
      log(sim.crash.detectAt === null ? "B restarted before M noticed the crash" : "B restarted", "ok");
      sim.crash = null;
      sim.b = "alive";
      sim.restarts.push(sim.now);
      sim.restartPending = true;
      sim.nextSend = sim.now;
      sim.nextGC = gcAfter();
      sim.advance(sim.now);
    };

    for (let i = 0; i < 20; i++) sim.window.push(PERIOD - 20 + 40 * rnd());
    updateTheta();
    recordThreshold();
    sim.nextGC = gcAfter();
    return sim;
  }

  Viz.register("ch8/failure-detector", {
    title: "Tuning a failure detector",
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      // State lives outside build() so a layout switch (phone <-> desktop) keeps it.
      let settings, speed, running, sim, logRows, compact, view = null;
      let tickFrom = 0, lastNote = 0, lastSettingsLog = 0;
      const hooks = { log: addLog, send: scheduleFly };

      function reset() {
        settings = { ...DEFAULTS };
        speed = 5; running = false; logRows = []; view = null;
        sim = createSim(ctx.random(42), settings, hooks, SCRIPTED_GC);
        sim.advance(SPAN);   // pre-run so the first frame already has 40 s of history
        build();
      }

      function addLog(t, html, tone) {
        if (html.startsWith("settings")) {   // a slider drag fires dozens of changes
          if (performance.now() - lastSettingsLog < 1500) return;
          lastSettingsLog = performance.now();
        }
        const row = { html: `<span class="mono muted">${sec(t)} s</span> ${html}`, tone };
        logRows.push(row);
        if (logRows.length > 60) logRows.shift();
        if (view) view.log.add(row.html, row.tone);
      }

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const W = compact ? 360 : 640, fs = compact ? 11 : 12;
        const mode = ui.segmented({ label: "Detector", value: settings.mode, onChange: v => change({ mode: v }),
          options: [{ value: "fixed", label: "Fixed timeout" }, { value: "adaptive", label: "Adaptive (φ)" }] });
        const sliders = [
          ui.slider({ label: "Timeout", min: 1.1, max: 6, step: 0.1, value: settings.timeout, format: v => v.toFixed(1) + " s", onInput: v => change({ timeout: v }) }),
          ui.slider({ label: "φ threshold", min: 1, max: 12, step: 1, value: settings.phi, onInput: v => change({ phi: v }) }),
          ui.slider({ label: "Network load", min: 0, max: 100, step: 5, value: settings.load, format: v => v + "%", onInput: v => change({ load: v }) }),
          ui.slider({ label: "GC pauses on B", min: 0, max: 6, step: 1, value: settings.gc, format: v => v + "/min", onInput: v => change({ gc: v }) }),
        ];
        // The track's 140px flex-basis would push the value onto its own line on phones.
        if (compact) sliders.forEach(sl => { sl.input.style.flex = "1 1 80px"; });
        const runBtn = ui.button("", toggleRun, { kind: "primary" });
        const crashBtn = ui.button("", crashOrRestart);
        const resetBtn = ui.button("Reset", reset, { kind: "ghost", title: "Default settings and a fresh 40 s of history" });
        const speedSeg = ui.segmented({ label: "Speed", value: speed, onChange: v => { speed = v; },
          options: [2, 5, 20].map(v => ({ value: v, label: v + "×" })) });
        const phiCaption = h("div", { class: "muted", style: "font-size:12.5px;line-height:1.45;margin:-4px 0 10px" },
          "Simplified φ accrual: it keeps the last 60 gaps and assumes they are normally distributed, " +
          "as in the original paper and Akka (Cassandra assumes an exponential distribution).");
        view = {
          fs, timeoutSl: sliders[0], phiSl: sliders[1], runBtn, crashBtn, phiCaption,
          topo: buildTopo(W, fs), chart: buildChart(W, fs), legend: makeLegend(),
          stats: ui.stats([{ key: "falseAlarms", label: "False alarms" }, { key: "rate", label: "False alarms / hour" },
            { key: "threshold", label: "Threshold" }, { key: "detect", label: "Crash detected after" }]),
          note: ui.note(""),
          log: ui.log({ title: "Detector log", height: 100 }),
        };
        logRows.forEach(r => view.log.add(r.html, r.tone));
        root.append(
          ui.bar(mode, ...sliders), phiCaption,
          ui.bar(runBtn, crashBtn, resetBtn, speedSeg),
          view.topo.svg, view.chart.svg, view.legend, view.stats, view.note, view.log);
        syncControls();
        render(true);
      }

      const makeLegend = () => ui.legend([
        { color: "var(--viz-ok)", label: "heartbeat on time", shape: "dot" },
        { color: "var(--viz-bad)", label: "heartbeat after M gave up", shape: "dot" },
        settings.mode === "fixed" ? { color: "var(--viz-ink)", label: "timeout", shape: "dash" }
          : { color: "var(--viz-c1)", label: "φ threshold", shape: "line" },
        { color: "var(--viz-bad-soft)", label: "M thinks B is dead", shape: "square" },
        { color: "var(--viz-warn)", label: "GC pause on B", shape: "square" },
      ]);

      // ---- Scene A: M, B, heartbeats in flight and M's silence timer ----
      function buildTopo(W, fs) {
        const y = 50, xm = compact ? 40 : 60, xb = compact ? 320 : 580;
        const mx0 = xm + 44, mx1 = xb - 44, my = 69;
        const svg = ctx.svg({ w: W, h: 100, label: "Node B sends heartbeats to monitor M" });
        const fly = s("g");
        svg.append(
          ctx.arrow({ x1: xb - 28, y1: y, x2: xm + 28, y2: y, dashed: true, width: 1.4, color: "var(--viz-line)", svg }),
          s("rect", { x: mx0, y: my, width: mx1 - mx0, height: 7, rx: 3.5, fill: "var(--viz-grid)" }), fly);
        const m = ctx.node({ x: xm, y, r: 22, label: "M", fill: "var(--viz-c6-soft)", stroke: "var(--viz-c6)" });
        const b = ctx.node({ x: xb, y, r: 22, label: "B", fill: "var(--viz-c2-soft)", stroke: "var(--viz-c2)" });
        const cross = s("path", { d: `M${xb - 11},${y - 11}l22,22m0,-22l-22,22`, stroke: "var(--viz-bad)", "stroke-width": 3, "stroke-linecap": "round" });
        const meter = s("rect", { x: mx0, y: my, height: 7, rx: 3.5 });
        const status = ctx.text(xb, y + 38, "", { size: fs, weight: 600 });
        const meterText = ctx.text(W / 2, y + 38, "", { size: fs, fill: "var(--viz-muted)" });
        const verdict = ctx.text(W / 2, 14, "", { size: compact ? 12 : 13, weight: 700 });
        svg.append(meter, m, b, cross, ctx.text(xm, y + 38, "monitor", { size: fs, fill: "var(--viz-muted)" }),
          status, meterText, verdict);
        return { svg, fly, b, cross, meter, status, meterText, verdict, xm, xb, y, mx0, mx1 };
      }

      function drawTopo() {
        const v = view.topo, th = sim.threshold(), silent = sim.now - sim.lastArrival;
        const dead = !!sim.suspect, crashed = sim.b === "crashed";
        const [txt, tone] = dead ? [crashed ? "M thinks B is DEAD" : "M thinks B is DEAD (false alarm!)", "bad"]
          : crashed ? ["M thinks B is ALIVE (B crashed!)", "warn"] : ["M thinks B is ALIVE", "ok"];
        v.verdict.textContent = txt;
        ctx.attr(v.verdict, { fill: `var(--viz-${tone})` });
        const [label, stTone, stroke] = { alive: ["alive", "ok", "c2"], paused: ["GC pause", "warn", "warn"], crashed: ["crashed", "bad", "bad"] }[sim.b];
        v.status.textContent = label;
        ctx.attr(v.status, { fill: `var(--viz-${stTone})` });
        ctx.attr(v.b.circle, { stroke: `var(--viz-${stroke})` });
        v.cross.style.display = crashed ? "" : "none";
        v.b.label.style.opacity = crashed ? 0.3 : 1;
        const frac = Math.min(1, silent / th);
        ctx.attr(v.meter, { width: Math.max(0.1, frac * (v.mx1 - v.mx0)), fill: `var(--viz-${dead ? "bad" : frac > 0.75 ? "warn" : "ok"})` });
        const what = settings.mode === "fixed" ? "timeout" : "threshold";
        v.meterText.textContent = compact ? `silent ${sec(silent)} s / ${what} ${sec(th)} s`
          : `no heartbeat for ${sec(silent)} s · ${what} ${sec(th)} s`;
      }

      function scheduleFly(hb) {
        if (!running || speed > 5 || !view) return;
        ctx.after((hb.sent - tickFrom) / speed, () => flyHeartbeat(hb));
      }
      function flyHeartbeat(hb) {
        const v = view.topo, from = [v.xb - 26, v.y], to = [v.xm + 26, v.y];
        const go = delay => ctx.fly(v.fly, { from, to, r: 5, fill: "var(--viz-c2)", ms: Math.min(1200, 220 + delay / speed) });
        if (!hb.lost) return go(hb.arrive - hb.sent);
        ctx.fly(v.fly, { from, to, r: 5, ms: 400, lost: 0.5 });   // dropped, then TCP resends ~1 s later
        ctx.after(1000 / speed, () => go(hb.arrive - hb.sent - 1000));
      }

      // ---- Scene B: gap between heartbeats over the last 40 s of sim time ----
      function buildChart(W, fs) {
        const H = compact ? 210 : 220;
        const pad = compact ? { l: 36, r: 10, t: 12, b: 28 } : { l: 44, r: 16, t: 12, b: 30 };
        const svg = ctx.svg({ w: W, h: H, label: "Gap between consecutive heartbeats over the last 40 seconds, with the detector's threshold" });
        const bands = s("g"), grid = s("g"), dyn = s("g");
        svg.append(bands, grid, dyn);
        return { svg, bands, grid, dyn, pad, W, fs, pw: W - pad.l - pad.r, ph: H - pad.t - pad.b, yMax: 0 };
      }

      function drawGrid(c) {
        const { pad, pw, ph, fs, yMax } = c, step = yMax > 5 ? 2 : 1, muted = { size: fs, fill: "var(--viz-muted)" };
        c.grid.innerHTML = "";
        for (let v = 0; v <= yMax; v += step) {
          const y = pad.t + ph * (1 - v / yMax);
          c.grid.append(
            s("line", { x1: pad.l, x2: pad.l + pw, y1: y, y2: y, stroke: v ? "var(--viz-grid)" : "var(--viz-line)" }),
            ctx.text(pad.l - 6, y, String(v), { ...muted, anchor: "end" }));
        }
        const cy = pad.t + ph / 2, title = ctx.text(compact ? 10 : 12, cy, "gap between heartbeats (s)", muted);
        title.setAttribute("transform", `rotate(-90 ${compact ? 10 : 12} ${cy})`);
        c.grid.appendChild(title);
      }

      function drawChart() {
        const c = view.chart, { pad, pw, ph, fs } = c, t1 = sim.now, t0 = t1 - SPAN;
        const bottom = pad.t + ph, right = pad.l + pw;
        const vis = sim.ths.filter((e, i, a) => i === a.length - 1 || a[i + 1].t > t0);
        const maxTh = Math.max(...vis.map(e => e.v)) / 1000;
        const yMax = maxTh <= 4.6 ? 5 : Math.ceil((maxTh + 0.6) / 2) * 2;
        if (yMax !== c.yMax) { c.yMax = yMax; drawGrid(c); }
        const X = t => +(pad.l + ((t - t0) / SPAN) * pw).toFixed(1);
        const Y = ms => +(pad.t + ph * (1 - Math.min(ms / 1000, yMax) / yMax)).toFixed(1);
        const muted = { size: fs, fill: "var(--viz-muted)" };
        // Label next to x, flipped to the left when it would run off the plot.
        const tag = (x, y, str, o) => ctx.text(x > right - 56 ? x - 4 : x + 4, y, str, { size: fs, anchor: x > right - 56 ? "end" : "start", halo: true, ...o });
        c.bands.innerHTML = c.dyn.innerHTML = "";
        const add = (...els) => c.dyn.append(...els);

        sim.bands.forEach(b => {
          const xa = X(Math.max(b.start, t0)), xb = X(b.end === null ? t1 : b.end);
          if (xb <= pad.l) return;
          const w = Math.max(1, xb - xa);   // soft band, plus a solid cap so it reads in the dark theme
          c.bands.append(s("rect", { x: xa, y: pad.t, width: w, height: ph, fill: "var(--viz-bad-soft)" }),
            s("rect", { x: xa, y: pad.t, width: w, height: 4, fill: "var(--viz-bad)" }));
        });
        sim.gcs.forEach(g => {
          const xa = X(Math.max(g.start, t0)), xb = X(Math.min(g.end, t1));
          if (xb > xa) add(s("rect", { x: xa, y: bottom - 6, width: xb - xa, height: 6, fill: "var(--viz-warn)" }));
        });
        for (let k = Math.ceil(t0 / 10000) * 10000; k <= t1; k += 10000) {
          const x = X(k), anchor = x > c.W - 16 ? "end" : "middle";
          add(s("line", { x1: x, x2: x, y1: bottom, y2: bottom + 4, stroke: "var(--viz-line)" }),
            ctx.text(anchor === "end" ? c.W - 1 : x, bottom + 15, `${k / 1000} s`, { ...muted, anchor }));
        }
        drawThresholdPaths(vis, X, Y, t0, t1);
        sim.dots.forEach(p => {
          if (p.t < t0) return;
          const x = X(p.t), fill = p.red ? "var(--viz-bad)" : "var(--viz-ok)";
          add(p.gap / 1000 > yMax ? s("path", { d: `M${x},${pad.t}l4.5,8h-9z`, fill })   // off the scale
            : s("circle", { cx: x, cy: Y(p.gap), r: 3.5, fill, stroke: "var(--viz-bg)", "stroke-width": 1 }));
        });
        sim.restarts.forEach(t => {
          if (t < t0) return;
          add(s("line", { x1: X(t), x2: X(t), y1: bottom - 8, y2: bottom + 6, stroke: "var(--viz-muted)", "stroke-width": 2 }),
            tag(X(t), bottom - 16, "restart", { fill: "var(--viz-muted)" }));
        });
        sim.crashes.forEach(cr => drawCrash(cr, X, t0, t1, tag));
        // Name the latest false alarm in view (skipped when crash labels may share the top row).
        const fa = sim.bands.filter(b => b.falseAlarm && b.end > t0).pop();
        if (fa && !sim.crashes.some(cr => cr.t >= t0)) add(tag(X(fa.end), pad.t + 13, "false alarm", { weight: 700, fill: "var(--viz-bad)" }));
        const th = sim.threshold(), fixed = settings.mode === "fixed", ty = Y(th);
        add(ctx.text(right - 2, ty - 8 < pad.t + 6 ? ty + 10 : ty - 8,
          fixed ? `timeout ${settings.timeout.toFixed(1)} s` : `φ threshold ${sec(th)} s`,
          { size: fs, anchor: "end", weight: 700, fill: fixed ? "var(--viz-ink)" : "var(--viz-c1)", halo: true }));
      }

      // One step path per run of history in the same detector mode.
      function drawThresholdPaths(vis, X, Y, t0, t1) {
        const style = { fixed: { stroke: "var(--viz-ink)", "stroke-width": 1.5, "stroke-dasharray": "5 4" }, adaptive: { stroke: "var(--viz-c1)", "stroke-width": 2 } };
        let d = "", mode = null;
        const flush = () => { if (d) view.chart.dyn.appendChild(s("path", { d, fill: "none", ...style[mode] })); };
        vis.forEach((e, i) => {
          const xa = X(Math.max(e.t, t0)), xb = X(i + 1 < vis.length ? vis[i + 1].t : t1), y = Y(e.v);
          if (e.mode !== mode) { flush(); mode = e.mode; d = `M${xa},${y}`; } else d += `V${y}`;
          d += `H${xb}`;
        });
        flush();
      }

      // Crash line, plus a bracket from the crash to the moment M noticed (or to now while it hasn't).
      function drawCrash(cr, X, t0, t1, tag) {
        const { pad, ph } = view.chart, add = (...els) => view.chart.dyn.append(...els);
        const end = cr.detectAt !== null ? cr.detectAt : cr.restartAt === null ? t1 : null;
        if (cr.t >= t0) {
          add(s("line", { x1: X(cr.t), x2: X(cr.t), y1: pad.t, y2: pad.t + ph, stroke: "var(--viz-bad)", "stroke-width": 2 }),
            tag(X(cr.t), pad.t + 13, "crash", { weight: 700, fill: "var(--viz-bad)" }));
        }
        if (end === null || end < t0) return;
        const xa = X(Math.max(cr.t, t0)), xb = X(end), y = pad.t + 30, flip = xb > pad.l + view.chart.pw - 56;
        add(s("path", { d: `M${xa},${y - 4}V${y}H${xb}V${y - 4}`, fill: "none", stroke: "var(--viz-ink)", "stroke-width": 1.5 }),
          // Near the right edge the label goes left of the crash line instead of covering the bracket.
          ctx.text(flip ? xa - 4 : xb + 4, y, `+${sec(end - cr.t)} s${cr.detectAt === null ? "…" : ""}`,
            { size: view.fs, anchor: flip ? "end" : "start", weight: 700, halo: true }));
      }

      function drawStats() {
        const st = view.stats, n = sim.falseAlarms, span = sim.now - sim.statsSince;
        st.set("falseAlarms", n, n > 0 ? "bad" : "ok");
        const rate = n / (span / 3.6e6);
        // A rate from under 30 s of data would be mostly noise.
        st.set("rate", span < 30000 ? "–" : rate < 10 ? rate.toFixed(1) : Math.round(rate).toLocaleString("en-US"), span < 30000 ? "" : n > 0 ? "bad" : "ok");
        st.set("threshold", (sim.threshold() / 1000).toFixed(2) + " s", "info");
        const lc = sim.lastCrash;
        if (!lc) st.set("detect", "–", "");
        else if (lc.detectAt !== null) { const d = (lc.detectAt - lc.t) / 1000; st.set("detect", d.toFixed(1) + " s", d > 3 ? "warn" : "ok"); }
        else st.set("detect", sim.crash ? `not yet (${sec(sim.now - lc.t)} s)` : "never", "warn");
      }

      function noteFor() {
        const fixed = settings.mode === "fixed", T = settings.timeout.toFixed(1), L = settings.load;
        const th = (sim.threshold() / 1000).toFixed(2), n = sim.falseAlarms, c = sim.crash;
        if (c && c.detectAt === null) {
          return [`B crashed at ${sec(c.t)} s. To M, a dead node, a paused one and a slow network all look the same: silence. ` +
            `It can only wait for the ${fixed ? T + " s timeout" : "φ threshold (" + th + " s)"}` +
            (running ? "; requests to B hang meanwhile." : ". Press <b>▶ Run</b>."), "warn"];
        }
        if (c && c.detectAt === c.t) {
          return ["B crashed while M already (wrongly) suspected it, so this time the false alarm happened to come true. " +
            "Press <b>Restart B</b> and crash it again while it is healthy to see the real detection delay.", "warn"];
        }
        if (c) {
          return [`B crashed at ${sec(c.t)} s and M noticed <b>${sec(c.detectAt - c.t)} s</b> later; requests to B just hang meanwhile. ` +
            `A ${fixed ? "shorter timeout" : "lower φ"} detects faster but cries wolf more often: no setting wins both. ` +
            "Press <b>Restart B</b> to try another setting.", "warn"];
        }
        if (!fixed) {
          const { mu, sigma } = sim.gapStats();
          let html = `The φ detector learned that gaps average <b>${(mu / 1000).toFixed(2)} s</b> (σ ${(sigma / 1000).toFixed(2)} s) ` +
            "and suspects B once a gap is so long that, if gaps were normally distributed, it would happen by chance with " +
            `probability 10<sup>−${settings.phi}</sup>: right now after <b>${th} s</b>. Change the load and watch the threshold follow.`;
          if (settings.gc >= 3) html += ` Frequent GC pauses taught it that long gaps are normal, so it now waits ${th} s before suspecting B: fewer false alarms, slower crash detection.`;
          else if (n > 0) html += ` Real gaps (queueing spikes, GC pauses) have heavier tails than the normal curve it assumes, so it still misfired <b>${times(n)}</b>.`;
          return [html, "info"];
        }
        const pre = L >= 80 && settings.timeout < 2 ? `Queues are long at ${L}% load. ` : "";
        if (n > 0) {
          const cause = sim.faGC && sim.faQueue ? `queues (load ${L}%) or GC pauses` : sim.faGC ? "GC pauses on B" : `queues (load ${L}%)`;
          return [pre + `${sim.lastCrash ? "B was alive each time" : "B never crashed"}, yet M declared it dead <b>${times(n)}</b>: ` +
            `heartbeats were held up by ${cause} for longer than the ${T} s timeout. Each false alarm would trigger a pointless failover.` +
            (!running && sim.now === SPAN ? " Press <b>▶ Run</b> to watch it live." : ""), "bad"];
        }
        if (sim.now - sim.statsSince < 10000) {
          return [pre + `New setting, counters reset. ${running ? "Watch" : "Press <b>▶ Run</b> and watch"} whether any gap rises above the ${T} s timeout line.`, "info"];
        }
        return [pre + `No false alarms at this setting so far. Now press <b>Crash B</b> and see how long a real failure goes unnoticed with a ${T} s timeout.`, "info"];
      }

      function render(force) {
        drawChart();
        drawTopo();
        drawStats();
        if (force || performance.now() - lastNote > 500) {
          lastNote = performance.now();
          view.note.set(...noteFor());
        }
      }

      function syncControls() {
        const fixed = settings.mode === "fixed", crashed = sim.b === "crashed";
        view.timeoutSl.style.display = fixed ? "" : "none";
        view.phiSl.style.display = view.phiCaption.style.display = fixed ? "none" : "";
        view.runBtn.setLabel(running ? "❚❚ Pause" : "▶ Run");
        view.crashBtn.setLabel(crashed ? "Restart B" : "Crash B");
        view.crashBtn.className = "viz-btn viz-btn--" + (crashed ? "ok" : "danger");
      }

      function change(patch) {
        Object.assign(settings, patch);
        sim.set(patch);
        if ("mode" in patch) {
          const lg = makeLegend();
          view.legend.replaceWith(lg);
          view.legend = lg;
        }
        syncControls();
        render(true);
      }
      function toggleRun() { running = !running; syncControls(); render(true); }
      function crashOrRestart() {
        if (sim.b === "crashed") sim.restartB(); else sim.crashB();
        syncControls();
        render(true);
      }
      function tick() {
        if (!running) return;
        tickFrom = sim.now;
        sim.advance(sim.now + speed * 50);
        render(false);
      }

      reset();
      ctx.every(50, tick);
      // Rebuild with the other layout when the frame crosses the phone breakpoint (deferred: not inside the observer).
      ctx.onResize(() => ctx.after(0, () => { if (ctx.compact !== compact) build(); }));
    },
  });

  // Lets a Node test drive the model directly; inert in the browser.
  if (typeof module === "object" && module.exports) module.exports = { createSim, DEFAULTS, SCRIPTED_GC, meanDelay };
})();
