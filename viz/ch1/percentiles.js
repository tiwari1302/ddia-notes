// Mean vs percentiles: 2,000 synthetic response times as a histogram or a "nines" curve with
// live mean / p50 / p95 / p99 / p99.9. Switch on real sources of slowness, append 30 s timeouts,
// or split the traffic over two servers to see why per-server percentiles can't be averaged.
Viz.register("ch1/percentiles", {
  title: "Mean vs percentiles",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const N = 2000, N_A = 1800, B_EXTRA = 300, TIMEOUT = 30000, MAX_TIMEOUTS = 5;
    const HIST_MAX = 600, CURVE_CAP = 2000;

    // Every request keeps its own dice, so toggling one source never reshuffles the others.
    const rnd = ctx.random(11);
    const base = [], uGc = [], uTcp = [], uDisk = [], uAmt = [];
    for (let i = 0; i < N; i++) {
      base.push(60 * Math.exp(0.35 * rnd.normal()));
      uGc.push(rnd()); uTcp.push(rnd()); uDisk.push(rnd()); uAmt.push(rnd());
    }

    // State lives outside build() so a phone <-> desktop rebuild keeps it.
    const st = { mode: "one", view: "hist", gc: true, tcp: false, disk: false, timeouts: 0 };
    let compact = ctx.compact, view = null, shown = null;

    // ---------- data ----------
    const latency = (i, src) => base[i]
      + (src.gc && uGc[i] < 0.005 ? 150 + 250 * uAmt[i] : 0)
      + (src.tcp && uTcp[i] < 0.005 ? 200 + 800 * uAmt[i] : 0)
      + (src.disk && uDisk[i] < 0.05 ? 50 + 100 * uAmt[i] : 0);
    // Nearest rank. The epsilon stops 99.9 / 100 * 2000 = 1998.0000000000002 rounding up a rank.
    const rank = (sv, X) => sv[Math.ceil((X / 100) * sv.length - 1e-9) - 1];

    function summary(vals) {
      const sv = Float64Array.from(vals).sort();
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const slower = vals.filter(v => v > mean).length / vals.length;
      return { vals, sv, n: vals.length, mean, slower,
        p50: rank(sv, 50), p95: rank(sv, 95), p99: rank(sv, 99), p999: rank(sv, 99.9) };
    }
    // One server: every request. Two servers: A = first 1,800 (+ timeouts), B = last 200, degraded.
    function compute(src = st) {
      const vals = base.map((_, i) => latency(i, src));
      const timeouts = new Array(src.timeouts).fill(TIMEOUT);
      if (src.mode !== "two") return { all: summary(vals.concat(timeouts)) };
      const A = vals.slice(0, N_A).concat(timeouts), B = vals.slice(N_A).map(v => v + B_EXTRA);
      return { A: summary(A), B: summary(B), all: summary(A.concat(B)) };
    }

    // ---------- formatting ----------
    const int = v => Math.round(v).toLocaleString("en-US");
    const ms = v => int(v) + " ms";
    const pctTxt = f => (f * 100).toFixed(f < 0.1 || f > 0.9 ? 1 : 0) + "%";
    const C = k => `var(--viz-${k})`;

    function markers(d) {
      if (st.mode === "two") {
        const avg = (d.A.p99 + d.B.p99) / 2;
        return [
          { key: "mean", label: "mean", color: C("c3"), dashed: true, value: d.all.mean },
          { key: "avg", label: "avg of p99s", color: C("bad"), dashed: true, value: avg },
          { key: "true", label: "true p99", color: C("ok"), dashed: true, value: d.all.p99 },
        ];
      }
      const a = d.all;
      return [
        { key: "mean", label: "mean", color: C("c3"), dashed: true, value: a.mean },
        { key: "p50", label: "p50", color: C("c2"), q: 50, value: a.p50 },
        { key: "p95", label: "p95", color: C("c6"), q: 95, value: a.p95 },
        { key: "p99", label: "p99", color: C("c5"), q: 99, value: a.p99 },
        { key: "p999", label: "p99.9", color: C("c1"), q: 99.9, value: a.p999 },
      ];
    }

    // ---------- geometry ----------
    function geom() {
      return compact
        ? { W: 360, H: 240, x0: 40, x1: 318, ovX: 322, ovW: 28, bins: 30, tick: 200, fs: 11, top: 24, bottom: 204, rows: [] }
        : { W: 640, H: 266, x0: 50, x1: 610, ovX: 614, ovW: 20, bins: 60, tick: 100, fs: 12, top: 52, bottom: 230, rows: [14, 28, 42] };
    }
    // Smallest "nice" step that covers max in at most 5 intervals.
    function niceScale(max) {
      const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, max) / 5)));
      const step = [1, 2, 2.5, 5, 10, 20].map(m => m * mag).find(st2 => Math.ceil(max / st2) <= 5);
      return { step, top: Math.max(step, Math.ceil(max / step) * step) };
    }
    function yAxis(svg, g, scale, yOf, top) {
      for (let v = 0; v <= scale.top + 1e-9; v += scale.step) {
        svg.appendChild(s("line", { x1: g.x0, x2: g.plotR, y1: yOf(v), y2: yOf(v), stroke: v ? C("grid") : C("line") }));
        svg.appendChild(ctx.text(g.x0 - 6, yOf(v), int(v), { size: g.fs, anchor: "end", fill: C("muted") }));
      }
      svg.appendChild(ctx.text(4, top, st.view === "hist" ? "requests" : "ms", { size: g.fs, anchor: "start", fill: C("muted"), halo: true }));
    }

    // Greedy row assignment (desktop only). Each marker line runs from its label down to the axis,
    // so a label may not overlap another label in its row, nor be crossed by a line from a higher row.
    function placeLabels(items, rowsY) {
      const placed = [];
      const inside = (x, o) => x > o.left - 4 && x < o.right + 4;
      const overlap = (it, r) => placed.some(p => p.row === r && it.left < p.right + 6 && it.right > p.left - 6);
      const crossed = (it, r) => placed.some(p => (p.row < r && inside(p.x, it)) || (p.row > r && inside(it.x, p)));
      items.slice().sort((a, b) => a.left - b.left).forEach(it => {
        // Prefer a row with no crossings; markers at (nearly) the same x can't avoid them.
        let r = [0, 1, 2, 3].find(k => !overlap(it, k) && !crossed(it, k));
        if (r === undefined) { r = 0; while (overlap(it, r)) r++; }
        it.row = r;
        it.y = rowsY[0] + 14 * r;
        placed.push(it);
      });
    }

    // ---------- histogram view ----------
    function drawHist(svg, g, d) {
      g.plotR = g.ovX + g.ovW;
      const binMs = HIST_MAX / g.bins, bw = (g.x1 - g.x0) / g.bins;
      const groups = st.mode === "two" ? [[d.A.vals, "c2"], [d.B.vals, "c5"]] : [[d.all.vals, "c2"]];
      const counts = groups.map(([vals]) => {
        const c = new Array(g.bins + 1).fill(0);
        vals.forEach(v => c[Math.min(g.bins, Math.floor(v / binMs))]++);
        return c;
      });
      const totals = counts[0].map((_, b) => counts.reduce((t, c) => t + c[b], 0));
      const scale = niceScale(Math.max(...totals) * 1.04);
      const yOf = c => g.bottom - (c / scale.top) * (g.bottom - g.top);
      yAxis(svg, g, scale, yOf, g.top - (compact ? 16 : 24));

      const bars = s("g");
      let ovCount = null;
      svg.appendChild(bars);
      totals.forEach((_, b) => {
        const x = b < g.bins ? g.x0 + b * bw : g.ovX, w = b < g.bins ? bw : g.ovW;
        let yb = g.bottom;
        groups.forEach(([, col], k) => {
          const c = counts[k][b];
          if (!c) return;
          // Rare outliers would be sub-pixel; keep every non-empty bar visible.
          const hh = Math.max(3, g.bottom - yOf(c));
          bars.appendChild(s("rect", { x: x + 0.5, y: yb - hh, width: w - 1, height: hh, fill: C(col + "-soft"), stroke: C(col), "stroke-width": 1 }));
          yb -= hh;
        });
        if (b === g.bins) ovCount = ctx.text(x + w / 2, yb - 9, int(totals[b]), { size: g.fs, weight: 700, fill: totals[b] ? C("ink") : C("muted"), halo: true });
      });

      const ty = g.bottom + 14;
      for (let v = 0; v < HIST_MAX; v += g.tick) svg.appendChild(ctx.text(g.x0 + v / binMs * bw, ty, String(v), { size: g.fs, fill: C("muted") }));
      svg.appendChild(ctx.text(g.ovX + g.ovW / 2, ty, "600+", { size: g.fs, weight: 700, fill: C("muted") }));
      svg.appendChild(ctx.text((g.x0 + g.x1) / 2, g.H - 6, "response time (ms), " + binMs + " ms bins", { size: g.fs, fill: C("muted") }));

      const xOf = v => v > HIST_MAX ? g.ovX + g.ovW / 2 : g.x0 + (v / HIST_MAX) * (g.x1 - g.x0);
      const mk = markers(d).map(m => ({ ...m, x: xOf(m.value) }));
      const layer = s("g");
      svg.append(layer, ovCount);
      if (!compact) {
        mk.forEach(m => {
          m.text = `${m.label} · ${int(m.value)}${m.value > HIST_MAX ? " →" : ""}`;
          const w = m.text.length * 6.8;
          m.end = m.x + 3 + w > g.W - 4;
          m.left = m.end ? m.x - 3 - w : m.x + 3;
          m.right = m.left + w;
        });
        placeLabels(mk, g.rows);
      }
      const draw = xs => {
        layer.innerHTML = "";
        mk.forEach((m, i) => layer.appendChild(s("line", {
          x1: xs[i], x2: xs[i], y1: compact ? g.top : m.y + 7, y2: g.bottom,
          stroke: m.color, "stroke-width": 2, "stroke-dasharray": m.dashed ? "5 4" : null,
        })));
        if (!compact) mk.forEach((m, i) => layer.appendChild(ctx.text(xs[i] + (m.end ? -3 : 3), m.y, m.text, {
          size: g.fs, weight: 700, fill: m.color, anchor: m.end ? "end" : "start", halo: true,
        })));
      };
      // Slide markers from their previous positions so the eye sees what moved.
      const to = mk.map(m => m.x);
      const from = mk.map(m => (shown && shown[m.key] !== undefined ? shown[m.key] : m.x));
      shown = Object.fromEntries(mk.map(m => [m.key, m.x]));
      draw(from);
      if (from.some((x, i) => x !== to[i])) ctx.tween({ ms: 350, onUpdate: k => draw(from.map((x, i) => ctx.lerp(x, to[i], k))) });

      return {
        read(px) {
          if (px > g.x1 + 2) {
            const k = d.all.vals.filter(v => v >= HIST_MAX).length;
            return `<b>${int(k)}</b> of ${int(d.all.n)} requests (${pctTxt(k / d.all.n)}) took 600 ms or longer.`;
          }
          const t = Math.max(0, Math.round((px - g.x0) / (g.x1 - g.x0) * HIST_MAX));
          const k = d.all.vals.filter(v => v <= t).length, p = (k / d.all.n * 100).toFixed(1);
          return `<b>${t} ms ≈ p${p}</b>: ${p}% of requests finished within ${t} ms; ${int(d.all.n - k)} were slower.`;
        },
      };
    }

    // ---------- percentile-curve ("nines") view ----------
    function drawCurve(svg, g, d) {
      g.top = compact ? 24 : 26;
      g.plotR = g.W - 18;
      const XMAX = 3.31;
      const xOf = nines => g.x0 + (nines / XMAX) * (g.plotR - g.x0);
      const ninesOf = q => Math.log10(1 / (1 - q));
      const maxV = Math.min(CURVE_CAP, d.all.sv[d.all.n - 1]);
      const scale = niceScale(maxV);
      const yOf = v => g.bottom - (Math.min(v, scale.top) / scale.top) * (g.bottom - g.top);
      yAxis(svg, g, scale, yOf, g.top - 16);
      [[0, "0%"], [1, "90%"], [2, "99%"], [3, "99.9%"]].forEach(([n, lbl]) => {
        svg.appendChild(s("line", { x1: xOf(n), x2: xOf(n), y1: g.top, y2: g.bottom, stroke: C("grid") }));
        svg.appendChild(ctx.text(xOf(n), g.bottom + 14, lbl, { size: g.fs, fill: C("muted") }));
      });
      svg.appendChild(ctx.text((g.x0 + g.plotR) / 2, g.H - 6, "percentile (each gridline adds a nine)", { size: g.fs, fill: C("muted") }));

      // Nearest rank as a step function: the i-th fastest value is the answer for every q in (i/n, (i+1)/n].
      const line = (sum, col, w) => {
        const pts = [];
        sum.sv.forEach((v, i) => {
          const y = yOf(v).toFixed(1);
          pts.push(xOf(ninesOf(i / sum.n)).toFixed(1) + "," + y, (i < sum.n - 1 ? xOf(ninesOf((i + 1) / sum.n)) : g.plotR).toFixed(1) + "," + y);
        });
        svg.appendChild(s("polyline", { points: pts.join(" "), fill: "none", stroke: col, "stroke-width": w, "stroke-linejoin": "round" }));
      };
      const mk = markers(d);
      const hline = (m, labelAt) => {
        svg.appendChild(s("line", { x1: g.x0, x2: g.plotR, y1: yOf(m.value), y2: yOf(m.value), stroke: m.color, "stroke-width": 1.8, "stroke-dasharray": "6 4" }));
        if (!compact && labelAt) svg.appendChild(ctx.text(labelAt[0], yOf(m.value) + labelAt[1], `${m.label} · ${int(m.value)}`, { size: g.fs, weight: 700, fill: m.color, anchor: labelAt[2], halo: true }));
      };
      const dot = (q, v, col, label, pos) => {
        const x = xOf(ninesOf(q)), y = yOf(v);
        svg.appendChild(s("circle", { cx: x, cy: y, r: 4.5, fill: col, stroke: C("bg"), "stroke-width": 1.5 }));
        if (!compact && label) svg.appendChild(ctx.text(x + pos[0], y + pos[1], label, { size: g.fs, weight: 700, fill: col, anchor: pos[2], halo: true }));
      };

      if (st.mode === "two") {
        line(d.A, C("c2"), 2); line(d.B, C("c5"), 2); line(d.all, C("ink"), 3);
        hline(mk[0], [g.plotR - 4, -9, "end"]);
        hline(mk[1], [g.x0 + 6, 11, "start"]);
        hline(mk[2], [g.x0 + 6, -9, "start"]);
        const x99 = xOf(2);
        svg.appendChild(s("line", { x1: x99, x2: x99, y1: yOf(d.A.p99), y2: yOf(d.B.p99), stroke: C("muted"), "stroke-width": 1.2 }));
        // Rising curves leave the area up-left of each point empty, so labels go there.
        dot(0.99, d.A.p99, C("c2"), `A p99 · ${int(d.A.p99)}`, [-7, -12, "end"]);
        dot(0.99, d.B.p99, C("c5"), `B p99 · ${int(d.B.p99)}`, [-7, -12, "end"]);
        dot(0.99, mk[1].value, C("bad"));
        dot(0.99, d.all.p99, C("ok"));
      } else {
        line(d.all, C("c2"), 2.5);
        hline(mk[0], [g.plotR - 4, -9, "end"]);
        mk.slice(1).forEach(m => {
          const steep = m.q >= 99;
          dot(m.q / 100, m.value, m.color, `${m.label} · ${int(m.value)}`, steep ? [-7, -12, "end"] : [0, -13, "middle"]);
        });
      }
      // Values above the cap are pinned to the top edge; flag them.
      const firstClip = d.all.sv.findIndex(v => v > scale.top);
      if (firstClip >= 0) {
        const x = xOf(ninesOf(firstClip / d.all.n));
        svg.appendChild(ctx.text(x - 6, g.top + 10, `↑ up to ${ms(d.all.sv[d.all.n - 1])}`, { size: g.fs, weight: 700, anchor: "end", fill: C("bad"), halo: true }));
      }
      return {
        read(px) {
          const nines = Math.max(0, Math.min(XMAX, (px - g.x0) / (g.plotR - g.x0) * XMAX));
          const q = 1 - Math.pow(10, -nines), X = Math.max(1, q * 100);
          const label = X >= 99 ? X.toFixed(2).replace(/0$/, "") : X >= 90 ? X.toFixed(1) : X.toFixed(0);
          const v = rank(d.all.sv, X);
          const oneIn = 1 / (1 - q);
          return `<b>p${label} = ${ms(v)}</b>: ${label}% of requests took at most this long` +
            (oneIn >= 2 ? `; the slowest 1 in ${int(oneIn)} took this long or longer.` : ".");
        },
      };
    }

    // ---------- page ----------
    function build() {
      root.innerHTML = "";
      compact = ctx.compact;
      shown = null;
      const modeSeg = ui.segmented({ label: "Mode", value: st.mode,
        options: [{ value: "one", label: "One server" }, { value: "two", label: "Two servers" }],
        onChange: v => { st.mode = v; shown = null; update(); } });
      const viewSeg = ui.segmented({ label: "View", value: st.view,
        options: [{ value: "hist", label: "Histogram" }, { value: "curve", label: "Percentile curve" }],
        onChange: v => { st.view = v; update(); } });
      const tog = (key, label) => ui.toggle({ label, value: st[key], onChange: v => { st[key] = v; update(); } });
      const addBtn = ui.button("", () => { st.timeouts = Math.min(MAX_TIMEOUTS, st.timeouts + 1); update(); });
      const clearBtn = ui.button("Clear", () => { st.timeouts = 0; update(); }, { kind: "ghost" });
      const chart = h("div");
      const readout = h("div", { style: "font-size:12.5px;color:var(--viz-muted);min-height:20px;margin-top:4px" });
      const legend = h("div");
      const caption = h("div", { style: "font-size:12.5px;line-height:1.5;color:var(--viz-muted)" });
      const statsWrap = h("div");
      const note = ui.note("");
      root.append(
        ui.bar(modeSeg, viewSeg),
        ui.bar(tog("gc", "GC pauses (0.5%)"), tog("tcp", "TCP retransmits (0.5%)"), tog("disk", "Cache miss → disk read (5%)")),
        ui.bar(addBtn, clearBtn),
        chart, legend, readout, caption, statsWrap, note,
      );
      view = { chart, readout, legend, caption, statsWrap, note, addBtn, clearBtn, statsMode: null };
      update();
    }

    function update() {
      const d = compute();
      const g = geom();
      const v = view;
      v.addBtn.setLabel("+ 30 s timeout" + (st.timeouts ? ` (${st.timeouts})` : "")).disable(st.timeouts >= MAX_TIMEOUTS);
      v.clearBtn.disable(st.timeouts === 0);

      const svg = ctx.svg({ w: g.W, h: g.H, label: st.view === "hist" ? "Histogram of response times with mean and percentile markers" : "Response time at each percentile" });
      const plot = st.view === "hist" ? drawHist(svg, g, d) : drawCurve(svg, g, d);
      v.chart.replaceChildren(svg);
      attachReadout(svg, g, plot);

      const mk = markers(d);
      const items = [];
      if (st.mode === "two") {
        items.push({ color: C("c2"), label: "Server A (90% of traffic)", shape: st.view === "hist" ? "square" : "line" },
          { color: C("c5"), label: "Server B, degraded +300 ms (10%)", shape: st.view === "hist" ? "square" : "line" });
        if (st.view === "curve") items.push({ color: C("ink"), label: "All requests (merged)", shape: "line" });
      }
      // Histogram markers are vertical lines; on the curve, percentiles are dots and the rest dashed lines.
      if (compact) mk.forEach(m => items.push({ color: m.color, label: `${m.label} = ${int(m.value)} ms`,
        shape: m.dashed ? "dash" : st.view === "curve" ? "dot" : "line" }));
      v.legend.replaceChildren(items.length ? ui.legend(items) : "");
      v.caption.textContent = (st.view === "hist"
        ? "Bars with any requests are at least 3 px tall so rare outliers stay visible. "
        : "Flat until ~90%, then the tail shoots up. ")
        + "Synthetic, illustrative data; percentiles use nearest rank (tools that interpolate or bucket differ slightly).";

      renderStats(d);
      const [html, tone] = explain(d);
      v.note.set(html, tone);
    }

    function attachReadout(svg, g, plot) {
      const hint = st.view === "hist" ? "Hover or tap the chart to see what fraction of requests finish within a given time."
        : "Hover or tap the curve to read off any percentile.";
      view.readout.innerHTML = hint;
      const cross = s("line", { y1: g.top, y2: g.bottom, stroke: C("muted"), "stroke-width": 1, "stroke-dasharray": "2 3", opacity: 0, "pointer-events": "none" });
      const hit = s("rect", { x: g.x0, y: g.top, width: g.plotR - g.x0, height: g.bottom - g.top, fill: "none", "pointer-events": "all", style: "cursor:crosshair" });
      svg.append(cross, hit);
      const move = e => {
        const m = svg.getScreenCTM();
        if (!m) return;
        const px = (e.clientX - m.e) / m.a;
        ctx.attr(cross, { x1: px, x2: px, opacity: 1 });
        view.readout.innerHTML = plot.read(px);
      };
      hit.addEventListener("pointermove", move);
      hit.addEventListener("pointerdown", move);
      hit.addEventListener("pointerleave", () => { ctx.attr(cross, { opacity: 0 }); view.readout.innerHTML = hint; });
    }

    function renderStats(d) {
      const v = view;
      if (v.statsMode !== st.mode) {
        v.statsMode = st.mode;
        v.stats = ui.stats(st.mode === "two"
          ? [{ key: "a", label: "p99 server A" }, { key: "b", label: "p99 server B" }, { key: "avg", label: "Avg of p99s", tone: "bad" },
             { key: "true", label: "True p99", tone: "ok" }, { key: "err", label: "Error", tone: "bad" }]
          : [{ key: "mean", label: "Mean" }, { key: "p50", label: "p50" }, { key: "p95", label: "p95" },
             { key: "p99", label: "p99" }, { key: "p999", label: "p99.9" }, { key: "slower", label: "Slower than mean" }]);
        // Bottom-align values so a two-line label doesn't stagger the row.
        Array.from(v.stats.children).forEach(c => Object.assign(c.style, { display: "flex", flexDirection: "column", justifyContent: "space-between" }));
        v.statsWrap.replaceChildren(v.stats);
      }
      if (st.mode === "two") {
        const avg = (d.A.p99 + d.B.p99) / 2, err = Math.round(d.all.p99) - Math.round(avg);
        v.stats.set("a", ms(d.A.p99)).set("b", ms(d.B.p99)).set("avg", ms(avg)).set("true", ms(d.all.p99))
          .set("err", (err > 0 ? "+" : err < 0 ? "−" : "") + int(Math.abs(err)) + " ms", err ? "bad" : "ok");
      } else {
        const a = d.all;
        ["mean", "p50", "p95", "p99", "p999"].forEach(k => v.stats.set(k, ms(a[k])));
        v.stats.set("slower", pctTxt(a.slower));
      }
    }

    // The explanation: first matching rule wins; every number is computed live.
    function explain(d) {
      const a = d.all;
      if (st.mode === "two") {
        const avg = (d.A.p99 + d.B.p99) / 2;
        const over = a.vals.filter(v => v > avg).length / a.n;
        const err = Math.round(a.p99) - Math.round(avg);
        const verdict = err === 0 ? "matches it by luck" : `is ${int(Math.abs(err))} ms too ${err > 0 ? "low" : "high"}`;
        return [`Server B is degraded and serves 10% of traffic. Averaging the two p99s (${int(d.A.p99)} and ${int(d.B.p99)} ms) says <b>${ms(avg)}</b>, ` +
          `yet <b>${pctTxt(over)}</b> of all requests are slower than that, not 1%. The true p99 over all ${int(a.n)} requests is <b>${ms(a.p99)}</b>, so the average ${verdict}. ` +
          `Percentiles do not average: add the histograms (or merge sketches like HdrHistogram, t-digest, DDSketch) and compute the percentile from the merged data.`, "bad"];
      }
      if (st.timeouts) {
        const b = compute({ ...st, timeouts: 0 }).all;
        const med = Math.round(b.p50) === Math.round(a.p50) ? `stayed at ${int(a.p50)} ms` : `moved from ${int(b.p50)} to ${int(a.p50)} ms`;
        return [`Each 30 s timeout moves the mean by about 15 ms (30,000 / ${int(N)}): ${st.timeouts} timeout${st.timeouts > 1 ? "s" : ""} ` +
          `(${st.timeouts} of ${int(a.n)} requests) pushed the mean from <b>${int(b.mean)}</b> to <b>${int(a.mean)} ms</b>, slower than ${pctTxt(1 - a.slower)} of requests, while the median ${med} ` +
          `(each extra value shifts it by at most one rank). A handful of outliers can shift the average while the typical request is unchanged.`, "warn"];
      }
      if (st.tcp) {
        const b = compute({ ...st, tcp: false }).all;
        return [`Retransmits hit only 0.5% of requests, so p50 and p95 barely move (${int(b.p50)} → ${int(a.p50)}, ${int(b.p95)} → ${int(a.p95)} ms), ` +
          `but <b>p99.9 jumps from ${ms(b.p999)} to ${ms(a.p999)}</b>. Rare causes of slowness live in the tail, which is why Amazon sets internal response-time targets at p99.9.`, "warn"];
      }
      if (st.disk) {
        const b = compute({ ...st, disk: false }).all;
        return [`Cache misses slow 5% of requests by 50–150 ms: <b>p95 rises from ${int(b.p95)} to ${int(a.p95)} ms</b> and p99 from ${int(b.p99)} to ${int(a.p99)} ms, ` +
          `while the median barely moves (${int(b.p50)} → ${int(a.p50)} ms). Each percentile tells you about a different slice of requests.`, "info"];
      }
      return [`Half of requests finish within <b>p50 = ${ms(a.p50)}</b>, yet the mean is <b>${ms(a.mean)}</b>, ` +
        (st.gc ? "pulled up by a few GC pauses, " : "pulled up by the long right tail, ") +
        `and only ${pctTxt(a.slower)} of requests are slower than the mean; the slowest 1 in 1,000 wait <b>${ms(a.p999)}</b> or more. ` +
        `Percentiles say what fraction of requests wait how long; the mean describes no request in particular.`, "info"];
    }

    build();
    // Rebuild with the other layout when the frame crosses the phone breakpoint.
    ctx.onResize(() => { if (ctx.compact !== compact) build(); });
  },
});
