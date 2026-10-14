// Tail latency amplification: one user request fans out to N backend calls and has to
// wait for the slowest, so a backend's rare slow calls become the user's common case.
// The optional hedging model (from "The Tail at Scale", beyond the book) re-sends slow calls.
Viz.register("ch1/tail-latency", {
  title: "Tail latency amplification",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const rnd = ctx.random(7);
    // State lives outside build() so a layout switch (phone <-> desktop) keeps it.
    let fanout = 20;    // backend calls per user request
    let pSlow = 1;      // % of backend calls that are slow (the backend's tail)
    let hedge = false;  // send a backup to another replica when a call is slow
    let lastSample = null, simResult = null, running = false, epoch = 0;
    let compact = ctx.compact;
    let view = null;

    // Call outcomes. Illustrative timings: fast ~10 ms, slow ~1 s, rescued = 30 ms hedge + fast reply.
    const FAST = 0, RESCUED = 1, SLOW = 2;
    const probSlow = (n, q) => 1 - Math.pow(1 - q, n);   // P(at least one of n calls is slow)
    // Green only when page loads are about as rarely slow as a single call; 18% slow pages is a warning.
    const toneOf = f => (f > 0.5 ? "bad" : f > 0.05 ? "warn" : "ok");
    const fmtPct = f => {
      const v = f * 100;
      if (v >= 99.95) return "> 99.9%";
      return (v >= 0.995 || v === 0 ? v.toFixed(1) : v >= 0.01 ? v.toFixed(2) : "< 0.01") + "%";
    };
    // Page-latency percentile where slow pages begin: 18.2% slow -> p82, 0.0001% slow -> p99.9999.
    function slowFrom(P) {
      if (P >= 0.5) return "≤ p50";
      const pct = 100 * (1 - P);
      if (pct < 99) return "p" + pct.toFixed(0);
      const d = Math.min(4, Math.max(1, Math.ceil(-Math.log10(100 - pct))));
      return "p" + Math.floor(pct * 10 ** d + 1e-6) / 10 ** d;
    }

    // With hedging, a slow call gets a backup on another replica, which is slow independently.
    const outcome = (slow, backupSlow) => (!slow ? FAST : !hedge || backupSlow ? SLOW : RESCUED);
    function callOutcome(q) {
      const slow = rnd() < q;
      return outcome(slow, slow && hedge && rnd() < q);
    }
    // One pinned example page load: call i is slow when u[i] < p (its backup when v[i] < p), so
    // moving the sliders changes this page smoothly instead of re-rolling it. Seed picked for a
    // typical page: at 1% its first slow call is #48; hedging rescues every slow call below 8%.
    const pin = ctx.random(1012), pinU = [], pinV = [];
    for (let i = 0; i < 100; i++) { pinU.push(pin()); pinV.push(pin()); }
    const pinnedSample = () => pinU.slice(0, fanout).map((u, i) => outcome(u < pSlow / 100, pinV[i] < pSlow / 100));

    const caption = text => h("div", { style: "font-size:12.5px;line-height:1.5;color:var(--viz-muted);margin:-4px 0 10px" }, text);

    function build() {
      root.innerHTML = "";
      compact = ctx.compact;
      const W = compact ? 360 : 640;
      const fs = compact ? 11 : 12;   // smallest SVG text size for this layout

      const fanSlider = ui.slider({
        label: "Fan-out (calls per page)", min: 1, max: 100, value: fanout,
        onInput: v => { fanout = v; paramsChanged(); },
      });
      const slowSlider = ui.slider({
        label: "Backend calls that are slow", min: 0.1, max: 10, step: 0.1, value: pSlow,
        format: v => v.toFixed(1) + "%",
        onInput: v => { pSlow = v; paramsChanged(); },
      });
      // The track's 140px flex-basis would push the long label's value onto its own line on phones.
      if (compact) [fanSlider, slowSlider].forEach(sl => { sl.input.style.flex = "1 1 80px"; });
      const hedgeToggle = ui.toggle({
        label: "Hedge slow calls", value: hedge,
        onChange: v => { hedge = v; paramsChanged(); },
      });
      const runBtn = ui.button("▶ Simulate 1,000 page loads", () => simulate(), { kind: "primary" }).disable(running);

      const stats = ui.stats([
        { key: "theory", label: "Slow page loads", value: "" },
        { key: "sim", label: "Simulated", value: "–" },
        { key: "equiv", label: "Slow pages start at", value: "" },
        { key: "extra", label: "Extra backend load", value: "–" },
      ]);

      // Fan-out picture: page on the left, grid of parallel backend calls on the right.
      const fan = ctx.svg({ w: W, h: 120, label: "One page request fanning out to many parallel backend calls" });
      const fanLayer = s("g");
      fan.appendChild(fanLayer);

      const cellLegend = ui.legend([
        { color: "var(--viz-ok)", label: "fast backend call", shape: "square" },
        { color: "var(--viz-bad)", label: "slow backend call", shape: "square" },
        { color: "var(--viz-warn)", label: "hedged: backup won", shape: "square" },
      ]);
      const curveLegend = ui.legend([
        { color: "var(--viz-c5)", label: "without hedging", shape: "line" },
        { color: "var(--viz-c4)", label: "with hedging", shape: "dash" },
      ]);
      const hedgeNote = caption(
        "Hedging: a call with no reply after 30 ms gets a backup on another replica; if the backup is fast, " +
        "the call ends at ~40 ms. Assumes slowness is independent across replicas and the hedge fires just above " +
        "normal latency. The Tail at Scale suggests hedging after the p95, which caps extra load near 5%.");
      const chart = buildChart(W, fs);
      const note = ui.note("");

      root.append(
        ui.bar(fanSlider, slowSlider,
          h("span", { style: "display:inline-flex;align-items:center;gap:8px" }, hedgeToggle, ui.badge("beyond the book", "muted"))),
        caption("A slow call = one in the backend's tail (for example above its p99). Illustrative timings: ~10 ms fast, ~1 s slow."),
        hedgeNote,
        fan,
        ui.bar(runBtn, cellLegend),
        stats,
        chart.svg,
        curveLegend,
        note,
      );
      view = { W, fs, fan, fanLayer, stats, note, runBtn, chart, cellLegend, curveLegend, hedgeNote };
      update();
    }

    // Probability curve(s): P(page slow) against fan-out, with a marker at the current fan-out.
    function buildChart(W, fs) {
      const CH = compact ? 200 : 214;
      const pad = { l: compact ? 40 : 46, r: 14, t: 26, b: 38 };
      const svg = ctx.svg({ w: W, h: CH, label: "Chance that a page load is slow versus fan-out" });
      const plotW = W - pad.l - pad.r, plotH = CH - pad.t - pad.b;
      const xOf = n => pad.l + ((n - 1) / 99) * plotW;
      const yOf = p => pad.t + (1 - p) * plotH;
      const muted = { size: fs, fill: "var(--viz-muted)" };
      for (let i = 0; i <= 4; i++) {
        const p = i / 4;
        svg.appendChild(s("line", { x1: pad.l, x2: W - pad.r, y1: yOf(p), y2: yOf(p), stroke: "var(--viz-grid)" }));
        svg.appendChild(ctx.text(pad.l - 6, yOf(p), Math.round(p * 100) + "%", { ...muted, anchor: "end" }));
      }
      [1, 25, 50, 75, 100].forEach(n => svg.appendChild(ctx.text(xOf(n), CH - pad.b + 15, String(n), muted)));
      svg.appendChild(ctx.text(pad.l + plotW / 2, CH - 7, "backend calls per page (fan-out)", muted));
      svg.appendChild(ctx.text(4, 10, "slow page loads", { ...muted, anchor: "start" }));
      const titleBox = { x0: 0, y0: 0, x1: 4 + 15 * fs * 0.55, y1: 18 };

      const series = (c, dash) => {
        const g = s("g");
        const area = dash ? null : s("path", { fill: `var(--viz-${c}-soft)` });
        const line = s("path", { fill: "none", stroke: `var(--viz-${c})`, "stroke-width": dash ? 2 : 2.5, "stroke-dasharray": dash || null });
        const guide = dash ? null : s("line", { stroke: `var(--viz-${c})`, "stroke-dasharray": "4 4", "stroke-width": 1.2 });
        const marker = s("circle", { r: 6, fill: `var(--viz-${c})`, stroke: "var(--viz-bg)", "stroke-width": 2 });
        g.append(...[area, line, guide, marker].filter(Boolean));
        const label = ctx.text(0, 0, "", { size: 12, weight: 700, fill: `var(--viz-${c})`, anchor: "start", halo: true });
        return { g, area, line, guide, marker, label };
      };
      const plain = series("c5"), hedged = series("c4", "6 4");
      svg.append(plain.g, hedged.g, plain.label, hedged.label);
      return { svg, W, xOf, yOf, plain, hedged, titleBox };
    }

    // Draws one curve for per-call slow probability q; returns the marker's y.
    function drawSeries(sr, q) {
      const { xOf, yOf } = view.chart;
      let d = "";
      for (let n = 1; n <= 100; n++) d += (n === 1 ? "M" : "L") + xOf(n).toFixed(1) + "," + yOf(probSlow(n, q)).toFixed(1);
      sr.line.setAttribute("d", d);
      if (sr.area) sr.area.setAttribute("d", `M${xOf(1)},${yOf(0)}L${d.slice(1)}L${xOf(100)},${yOf(0)}Z`);
      const x = xOf(fanout), y = yOf(probSlow(fanout, q));
      ctx.attr(sr.marker, { cx: x, cy: y });
      if (sr.guide) ctx.attr(sr.guide, { x1: x, x2: x, y1: yOf(0), y2: y });
      return y;
    }

    const curvePts = q => {
      const { xOf, yOf } = view.chart, pts = [];
      for (let n = 1; n <= 100; n += 0.25) pts.push([xOf(n), yOf(probSlow(n, q))]);
      return pts;
    };
    const hits = (b, x, y) => x >= b.x0 - 2 && x <= b.x1 + 2 && y >= b.y0 - 2 && y <= b.y1 + 2;
    const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    // Puts a value label at the spot around its marker that covers the fewest curve points and
    // stays clear of the axes and of `avoid` boxes; returns its box. `stack` also allows a spot
    // one line higher (at a small cost), so the upper label can sit above the lower one.
    function placeLabel(label, str, my, curves, avoid, stack) {
      const { xOf, yOf, W } = view.chart, mx = xOf(fanout);
      label.textContent = str;
      const w = (label.getComputedTextLength ? label.getComputedTextLength() : 0) || str.length * 7.5;
      const spots = [[-10, -12], [10, -12], [10, 14], [-10, 14]].concat(stack ? [[-10, -30], [10, -30]] : []);
      let best = null;
      for (const [dx, dy] of spots) {
        const x0 = dx < 0 ? mx + dx - w : mx + dx, y0 = my + dy - 7;
        const box = { x0, y0, x1: x0 + w, y1: y0 + 14, dx, dy };
        let cost = box.x0 < xOf(1) || box.x1 > W - 2 || box.y0 < 0 || box.y1 > yOf(0) - 2 ? 1000 : dy < -12 ? 3 : 0;
        curves.forEach(pts => pts.forEach(([x, y]) => { if (hits(box, x, y)) cost++; }));
        avoid.forEach(b => { if (overlaps(box, b)) cost += 500; });
        if (!best || cost < best.cost) best = { ...box, cost };
      }
      ctx.attr(label, { x: mx + best.dx, y: my + best.dy, "text-anchor": best.dx < 0 ? "end" : "start" });
      return best;
    }

    function drawCell(layer, x, y, size, out) {
      const [fill, stroke] = out === SLOW ? ["var(--viz-bad)", "var(--viz-bad)"]
        : out === RESCUED ? ["var(--viz-warn-soft)", "var(--viz-warn)"] : ["var(--viz-ok-soft)", "var(--viz-ok)"];
      const rx = Math.min(5, size / 4);
      const card = (dx, dy) => {
        layer.appendChild(s("rect", { x: x + dx, y: y + dy, width: size, height: size, rx, fill: "var(--viz-bg)" }));
        layer.appendChild(s("rect", { x: x + dx, y: y + dy, width: size, height: size, rx, fill, stroke, "stroke-width": 1.2 }));
      };
      // A hedged call was sent twice: show the second request as a card peeking out behind.
      if (hedge && out !== FAST) card(3, -3);
      card(0, 0);
    }

    function drawFanout(sample) {
      const { W, fs, fan, fanLayer } = view;
      fanLayer.innerHTML = "";
      const boxW = compact ? 76 : 100, boxH = 52, x0 = 4;
      const gx = x0 + boxW + (compact ? 26 : 52), gw = W - gx - 6;
      const cols = Math.min(fanout, compact ? 12 : 20), rows = Math.ceil(fanout / cols);
      const step = Math.min(compact ? 26 : 34, gw / cols), cell = step - 4;
      const gy = 30, gridH = rows * step - 4, cy = gy + gridH / 2;
      const H = Math.max(gy + gridH + 10, cy + boxH / 2 + 44);
      fan.setAttribute("viewBox", `0 0 ${W} ${H}`);

      const calls = fanout === 1 ? "1 backend call" : `${fanout} backend calls in parallel`;
      const title = compact ? "One page load: " + calls : `One page load = ${calls}` + (fanout > 1 ? "; it waits for the slowest" : "");
      fanLayer.appendChild(ctx.text(gx, 14, title, { size: fs, anchor: "start", fill: "var(--viz-muted)" }));
      const wires = s("g"), cells = s("g");
      fanLayer.append(wires, cells);
      const wire = (x, y, color, width) => wires.appendChild(s("line", {
        x1: x0 + boxW, y1: cy, x2: x, y2: y, stroke: color, "stroke-width": width,
      }));
      for (let r = 0; r < rows; r++) wire(gx, gy + r * step + cell / 2, "var(--viz-line)", 1);
      // The page is as slow as its slowest call: highlight the call(s) it ends up waiting for.
      const worst = Math.max(...sample);
      for (let i = 0; i < fanout; i++) {
        const x = gx + (i % cols) * step, y = gy + Math.floor(i / cols) * step;
        if (worst !== FAST && sample[i] === worst) {
          wire(x + cell / 2, y + cell / 2, worst === SLOW ? "var(--viz-bad)" : "var(--viz-warn)", 1.8);
        }
        drawCell(cells, x, y, cell, sample[i]);
      }
      fanLayer.appendChild(ctx.box({
        x: x0, y: cy - boxH / 2, w: boxW, h: boxH, label: "Page", sub: "1 request", size: compact ? 13 : 14,
        fill: "var(--viz-c6-soft)", stroke: "var(--viz-c6)",
      }));
      const anySlow = worst === SLOW, wait = ["~10 ms", "~40 ms", "~1 s"][worst];
      const ty = cy + boxH / 2 + 16;
      fanLayer.appendChild(ctx.text(x0 + boxW / 2, ty, anySlow ? "SLOW page" : "fast page", {
        size: 12, weight: 700, fill: anySlow ? "var(--viz-bad)" : "var(--viz-ok)",
      }));
      fanLayer.appendChild(ctx.text(x0 + boxW / 2, ty + 16, "waits " + wait, { size: fs, fill: "var(--viz-muted)" }));
    }

    function noteFor(q, P, PH) {
      const p1 = Math.abs(pSlow - 1) < 1e-9, ps = pSlow.toFixed(1);
      const formula = base => `<span class="mono">(1 − (1 − ${base})<sup>${fanout}</sup>)</span>`;
      let html = `Each backend call is slow only <b>${ps}%</b> of the time, but a page waits for all <b>${fanout}</b> of them, ` +
        `so <b>${fmtPct(P)}</b> of page loads ${hedge ? "would be" : "are"} slow ${formula(q.toFixed(3))}. `;
      if (hedge) {
        html += `Hedging re-sends only the <b>${ps}%</b> of calls that are slow, so for <b>+${ps}%</b> backend load ${PH < 0.5 ? "only " : ""}` +
          `<b>${fmtPct(PH)}</b> of pages are slow ${formula(q.toFixed(3) + "²")} instead of <b>${fmtPct(P)}</b>. ` +
          "Google reported a BigTable benchmark where hedging after 10 ms cut p99.9 from 1,800 ms to 74 ms for 2% more requests. " +
          "It only works when slowness is uncorrelated and the request is safe to send twice.";
        return [html, PH < 0.2 ? "ok" : PH >= 0.5 ? "bad" : "warn"];
      }
      html += P >= 0.5 ? "The backend's <em>rare</em> tail is now the user's <em>typical</em> experience."
        : "Drag the fan-out up and watch the tail take over.";
      if (p1 && fanout === 100) {
        html += " This is the example from Dean and Barroso's <em>The Tail at Scale</em>: 63% of user requests exceed the backend's p99.";
      }
      if (p1 && (fanout === 69 || fanout === 70)) html += " The backend's p99 has become the page's median.";
      return [html, P >= 0.5 ? "bad" : P > 0.2 ? "warn" : "info"];
    }

    function update() {
      const { chart, stats, note } = view;
      const q = pSlow / 100, P = probSlow(fanout, q), PH = probSlow(fanout, q * q);
      const Pe = hedge ? PH : P;   // what the user actually sees

      chart.plain.g.setAttribute("opacity", hedge ? 0.45 : 1);
      chart.hedged.g.style.display = chart.hedged.label.style.display = hedge ? "" : "none";
      const yP = drawSeries(chart.plain, q), yH = hedge ? drawSeries(chart.hedged, q * q) : 0;
      const curves = hedge ? [curvePts(q), curvePts(q * q)] : [curvePts(q)];
      // The hedged label (lower curve) goes first so the unhedged one can stack above it.
      const avoid = [chart.titleBox];
      if (hedge) avoid.push(placeLabel(chart.hedged.label, fmtPct(PH) + " hedged", yH, curves, avoid));
      placeLabel(chart.plain.label, fmtPct(P), yP, curves, avoid, true);

      drawFanout(lastSample || pinnedSample());
      stats.set("theory", fmtPct(Pe), toneOf(Pe));
      if (!running) stats.set("sim", simResult ? simResult.text : "–", simResult ? simResult.tone : "");
      stats.set("equiv", slowFrom(Pe), Pe >= 0.5 ? "bad" : "info");
      stats.set("extra", hedge ? `+${pSlow.toFixed(1)}%` : "–", hedge ? "info" : "");
      note.set(...noteFor(q, P, PH));
      view.hedgeNote.style.display = view.curveLegend.style.display = hedge ? "" : "none";
      view.cellLegend.children[2].style.display = hedge ? "" : "none";
    }

    function setRunning(on) {
      running = on;
      view.runBtn.disable(on);
    }

    function paramsChanged() {
      epoch++;   // abandons a simulation in progress
      lastSample = null;
      simResult = null;
      setRunning(false);
      update();
    }

    async function simulate() {
      const my = ++epoch, q = pSlow / 100, N = 1000;
      setRunning(true);
      let slowPages = 0;
      // Animate a handful of individual page loads, then crunch the rest instantly.
      for (let k = 0; k < 6; k++) {
        lastSample = Array.from({ length: fanout }, () => callOutcome(q));
        if (lastSample.includes(SLOW)) slowPages++;
        drawFanout(lastSample);
        view.stats.set("sim", `${slowPages} slow / ${k + 1}`, "");
        await ctx.sleep(450);
        if (my !== epoch) return;
      }
      for (let k = 6; k < N; k++) {
        let slow = false;
        for (let i = 0; i < fanout && !slow; i++) slow = callOutcome(q) === SLOW;
        if (slow) slowPages++;
      }
      const frac = slowPages / N;
      simResult = { text: fmtPct(frac), tone: toneOf(frac) };
      view.stats.set("sim", simResult.text, simResult.tone);
      setRunning(false);
    }

    build();
    // Rebuild with the other layout when the frame crosses the phone breakpoint.
    ctx.onResize(() => { if (ctx.compact !== compact) build(); });
  },
});
