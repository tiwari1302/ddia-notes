// Fixed fleet vs auto-scaling: one synthetic day of demand served either by a fixed fleet
// sized up front or by a reactive autoscaler whose new servers take minutes to boot.
(function () {
  "use strict";
  // ---- model (pure; exercised by a node test) ----
  const SLOTS = 288, SLOT_MIN = 5;                    // 24 h of 5-minute samples
  const SALE = { from: 144, to: 156, extra: 30 };      // 12:00-13:00, +30 servers of demand
  const VIRAL = { from: 168, ramp: 36, factor: 1.8 };  // from 14:00, x1.8 over 3 h
  const PRESCALE = { from: 138, to: 162, floor: 50 };  // operator's scheduled floor 11:30-13:30
  const ZOOM = { from: 138, to: 162, ticks: [138, 144, 150, 156, 162] }; // detail 11:30-13:30
  const SCALE_IN_SLOTS = 3, MIN_SERVERS = 2;

  const pad2 = n => String(n).padStart(2, "0");
  const hhmm = slot => pad2(Math.floor((slot * SLOT_MIN) / 60)) + ":" + pad2((slot * SLOT_MIN) % 60);
  const fmtPct = v => (v === 0 ? "0%" : v < 0.1 ? "<0.1%" : v < 10 ? v.toFixed(1) + "%" : Math.round(v) + "%");
  const r1 = v => Math.round(v * 10) / 10;

  function demandCurve(noise, surprise) {
    return noise.map((n, i) => {
      const h = i / 12;
      let d = Math.max(1, 4 + 16 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (h - 4)) / 24)) + n);
      if (surprise === "sale" && i >= SALE.from && i < SALE.to) d += SALE.extra;
      if (surprise === "viral" && i >= VIRAL.from) d *= 1 + (VIRAL.factor - 1) * Math.min(1, (i - VIRAL.from) / VIRAL.ramp);
      return d;
    });
  }

  // Reactive autoscaler: each slot it sizes for the PREVIOUS slot's demand at the target
  // utilization; launches arrive after the boot delay; scale-in waits for 3 quiet slots.
  // Returns active capacity C and `ordered` (active + still booting).
  function elasticCapacity(D, { delaySlots, target, prescale }) {
    const C = [], ordered = [], arrivals = new Array(SLOTS + delaySlots + 1).fill(0);
    let cur = Math.ceil(D[0] / target), pending = 0, quiet = 0;
    for (let i = 0; i < SLOTS; i++) {
      const floor = prescale && i >= PRESCALE.from && i < PRESCALE.to ? PRESCALE.floor : 0;
      if (i > 0) {
        cur += arrivals[i]; pending -= arrivals[i];
        const desired = Math.ceil(D[i - 1] / target);
        if (desired > cur + pending) {
          const n = desired - cur - pending;
          if (delaySlots === 0) cur += n; else { arrivals[i + delaySlots] += n; pending += n; }
        }
        if (desired < cur && ++quiet >= SCALE_IN_SLOTS) { cur = Math.max(desired, MIN_SERVERS, floor); quiet = 0; }
        else if (desired >= cur) quiet = 0;
      }
      cur = Math.max(cur, floor);
      C.push(cur); ordered.push(cur + pending);
    }
    return { C, ordered };
  }

  function summarize(D, C, from = 0, to = SLOTS) {
    let sumD = 0, sumC = 0, short = 0, worst = 0;
    const failing = [];
    for (let i = from; i < to; i++) {
      const sf = Math.max(0, D[i] - C[i]);
      sumD += D[i]; sumC += C[i]; short += sf; worst = Math.max(worst, sf);
      if (sf > 0) failing.push(i);
    }
    return {
      failed: (100 * short) / sumD, serverHours: (sumC * SLOT_MIN) / 60, workHours: (sumD * SLOT_MIN) / 60,
      util: (100 * (sumD - short)) / sumC, worst, failing,
    };
  }

  // Smallest "nice" axis top (with ~10% headroom) that needs at most maxN gridline steps.
  function niceScale(max, maxN) {
    let best = { top: 50 * Math.ceil((max * 1.1) / 50), step: 50 };
    for (const step of [5, 10, 20, 25, 40, 50]) {
      const n = Math.ceil((max * 1.1) / step);
      if (n <= maxN && n * step < best.top) best = { top: n * step, step };
    }
    return best;
  }

  // Demand inside slot i as [start, middle, end] values: flat 5-minute steps, or (smooth)
  // a line through the slot midpoints.
  function demandShape(D, smooth) {
    return i => {
      if (!smooth) return [D[i], D[i], D[i]];
      const prev = D[Math.max(0, i - 1)], next = D[Math.min(D.length - 1, i + 1)];
      return [(prev + D[i]) / 2, D[i], (D[i] + next) / 2];
    };
  }
  function demandLine(X, Y, shape, from, to) {
    let d = "";
    for (let i = from; i < to; i++) {
      const [a, m, b] = shape(i);
      d += `${i === from ? "M" : "L"}${X(i)},${Y(a)}L${X(i + 0.5)},${Y(m)}L${X(i + 1)},${Y(b)}`;
    }
    return d;
  }
  // Polygons where sign * (demand - capacity) > 0, with exact crossings
  // (sign 1: requests failing; sign -1: idle capacity).
  function gapPath(X, Y, shape, C, from, to, sign) {
    let d = "", top = [], bottom = [];
    const flush = () => {
      if (top.length) d += "M" + top.concat(bottom.reverse()).map(([x, v]) => `${X(x)},${Y(v)}`).join("L") + "Z";
      top = []; bottom = [];
    };
    for (let i = from; i < to; i++) {
      const [a, m, b] = shape(i), c = C[i];
      for (const [xa, xb, va, vb] of [[i, i + 0.5, a, m], [i + 0.5, i + 1, m, b]]) {
        const fa = sign * (va - c), fb = sign * (vb - c);
        if (fa <= 0) flush();
        if (fa <= 0 && fb <= 0) continue;
        const cross = xa + ((xb - xa) * fa) / (fa - fb);
        const x0 = fa > 0 ? xa : cross, x1 = fb > 0 ? xb : cross;
        const at = x => va + ((vb - va) * (x - xa)) / (xb - xa);
        top.push([x0, at(x0)], [x1, at(x1)]);
        bottom.push([x0, c], [x1, c]);
        if (fb <= 0) flush();
      }
    }
    flush();
    return d;
  }
  function stepLine(X, Y, val, from, to, test = () => true) {
    let d = "", on = false;
    for (let i = from; i < to; i++) {
      if (!test(i)) { on = false; continue; }
      d += (on ? `V${Y(val(i))}` : `M${X(i)},${Y(val(i))}`) + `H${X(i + 1)}`;
      on = true;
    }
    return d;
  }

  // ---- visualization ----
  Viz.register("ch1/elastic-scaling", {
    title: "Fixed fleet vs auto-scaling",
    mount(root, ctx) {
      const { s, ui } = ctx;
      const rnd = ctx.random(3);
      const noise = Array.from({ length: SLOTS }, () => 0.3 * rnd.normal());
      // State lives outside build() so a phone <-> desktop rebuild keeps it.
      const st = { mode: "manual", surprise: "none", fleet: 24, delay: 10, target: 70, prescale: false };
      let cursor = null, playing = false, compact = ctx.compact, view = null, model = null, patternCount = 0;

      function compute() {
        const D = demandCurve(noise, st.surprise);
        const scale = prescale => elasticCapacity(D, { delaySlots: Math.ceil(st.delay / SLOT_MIN), target: st.target / 100, prescale });
        let C, ordered, extraPre = 0;
        if (st.mode === "manual") { C = D.map(() => st.fleet); ordered = C; }
        else {
          ({ C, ordered } = scale(st.prescale));
          if (st.prescale) extraPre = summarize(D, C).serverHours - summarize(D, scale(false).C).serverHours;
        }
        return { D, C, ordered, extraPre, m: summarize(D, C), sale: summarize(D, C, SALE.from, SALE.to) };
      }

      // ---------- layout ----------
      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const seg = (label, key, options) =>
          ui.segmented({ label, options, value: st[key], onChange: v => { st[key] = v; update(); } });
        const slider = (label, key, min, max, step, format) =>
          ui.slider({ label, min, max, step, value: st[key], format, onInput: v => { st[key] = v; update(); } });
        const manualCtl = [slider("Fixed fleet", "fleet", 10, 60, 1, v => v + " servers")];
        const elasticCtl = [
          slider("Scale-up delay", "delay", 0, 30, 5, v => v + " min"),
          slider("Target utilization", "target", 50, 90, 5, v => v + "%"),
          ui.toggle({ label: "Pre-scale for the 12:00 sale", value: st.prescale, onChange: v => { st.prescale = v; update(); } }),
        ];
        const playBtn = ui.button("▶ Play the day", playDay, { title: "Sweep through the day" });

        const main = chartFrame(compact
          ? { W: 360, H: 240, L: 34, R: 342, T: 30, B: 206, size: 11, hours: [0, 6, 12, 18, 24] }
          : { W: 640, H: 260, L: 44, R: 618, T: 30, B: 226, size: 12, hours: [0, 4, 8, 12, 16, 20, 24] },
        "Servers needed versus servers running over one day");
        main.readout = ctx.text(main.G.R, 12, "", { size: main.G.size, anchor: "end" });
        main.svg.append(ctx.text(4, 12, "servers", { size: main.G.size, anchor: "start", fill: "var(--viz-muted)" }), main.readout);
        main.svg.style.touchAction = "pan-y";
        const pick = e => {
          if (playing) return;
          const r = main.svg.getBoundingClientRect(), G = main.G;
          const x = ((e.clientX - r.left) / r.width) * G.W;
          cursor = x < G.L || x > G.R ? null : Math.min(SLOTS - 1, Math.floor(((x - G.L) / (G.R - G.L)) * SLOTS)) + 0.5;
          drawCursor();
        };
        main.svg.addEventListener("pointermove", pick);
        main.svg.addEventListener("pointerdown", pick);
        main.svg.addEventListener("pointerleave", e => { if (!playing && e.pointerType === "mouse") { cursor = null; drawCursor(); } });

        const zoom = chartFrame({ W: compact ? 360 : 640, H: 132, L: compact ? 34 : 44, R: compact ? 342 : 618, T: 30, B: 100, size: compact ? 11 : 12 },
          "Zoom on 11:30 to 13:30, around the flash sale");
        zoom.title = ctx.h("div", { style: "font-size:12.5px;color:var(--viz-muted);margin:10px 0 2px" });
        zoom.wrap = ctx.h("div", null, zoom.title, zoom.svg);

        const stats = ui.stats([
          { key: "failed", label: "Requests failed" },
          { key: "hours", label: "Server-hours paid" },
          { key: "util", label: "Avg utilization" },
          { key: "worst", label: "Worst shortfall" },
        ]);
        const note = ui.note("");
        root.append(
          ui.bar(seg("Capacity", "mode", [
            { value: "manual", label: compact ? "Manual" : "Manual (fixed fleet)" },
            { value: "elastic", label: compact ? "Elastic" : "Elastic (auto-scaling)" },
          ]), seg("Today's surprise", "surprise", [
            { value: "none", label: "None" }, { value: "sale", label: "Flash sale" }, { value: "viral", label: "Viral growth" },
          ])),
          ui.bar(...manualCtl, ...elasticCtl, playBtn),
          main.svg, zoom.wrap,
          ui.legend([
            { color: "var(--viz-c6)", label: "demand", shape: "square" },
            { color: "var(--viz-c1)", label: "capacity", shape: "line" },
            { color: "repeating-linear-gradient(135deg, color-mix(in srgb, var(--viz-c1) 45%, transparent) 0 1.5px, var(--viz-c1-soft) 1.5px 4px)", label: "idle but paid", shape: "square" },
            { color: "var(--viz-bad)", label: "requests failing", shape: "square" },
          ]),
          stats, note,
          ctx.h("div", { style: "font-size:12.5px;color:var(--viz-muted);margin-top:8px;line-height:1.5" },
            "Synthetic, illustrative day sampled every 5 minutes; units are servers of load. " +
            "The autoscaler sizes for the previous sample's demand and scales in after 15 quiet minutes."),
        );
        view = { manualCtl, elasticCtl, playBtn, main, zoom, stats, note };
        syncPlay();
        update();
      }

      function chartFrame(G, label) {
        const svg = ctx.svg({ w: G.W, h: G.H, label });
        const plot = s("g"), cur = s("g");
        svg.append(plot, cur);
        // Diagonal hatching marks capacity that is paid for but idle.
        const id = `es-idle-${ctx.uid}-${++patternCount}`;
        svg.defs.append(s("pattern", { id, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
          s("rect", { width: 6, height: 6, fill: "var(--viz-c1-soft)" }),
          s("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "var(--viz-c1)", "stroke-width": 1.5, "stroke-opacity": 0.35 })));
        return { G, svg, plot, cur, idleFill: `url(#${id})` };
      }

      // ---------- drawing ----------
      function update() {
        model = compute();
        view.manualCtl.forEach(el => { el.style.display = st.mode === "manual" ? "" : "none"; });
        view.elasticCtl.forEach(el => { el.style.display = st.mode === "elastic" ? "" : "none"; });
        drawMain();
        drawZoom();
        drawCursor();
        setStats();
        view.note.set(...explain());
      }

      // Gridlines, y labels, baseline and x tick labels; returns the x/y mappers.
      function axes(fr, sc, from, to, ticks) {
        const { G, plot } = fr;
        const X = i => r1(G.L + ((i - from) / (to - from)) * (G.R - G.L));
        const Y = v => r1(G.B - (v / sc.top) * (G.B - G.T));
        for (let v = 0; v <= sc.top; v += sc.step) {
          plot.append(s("line", { x1: G.L, x2: G.R, y1: Y(v), y2: Y(v), stroke: v ? "var(--viz-grid)" : "var(--viz-line)" }),
            ctx.text(G.L - 6, Y(v), String(v), { size: G.size, anchor: "end", fill: "var(--viz-muted)" }));
        }
        ticks.forEach(i => plot.append(
          s("line", { x1: X(i), x2: X(i), y1: G.B, y2: G.B + 4, stroke: "var(--viz-line)" }),
          ctx.text(X(i), G.B + 16, hhmm(i), { size: G.size, fill: "var(--viz-muted)" })));
        fr.X = X; fr.Y = Y;
        return { X, Y };
      }

      // Shaded sale hour, inserted behind the gridlines.
      function saleBand(fr, X) {
        if (st.surprise !== "sale") return;
        const band = s("rect", { x: X(SALE.from), y: fr.G.T, width: X(SALE.to) - X(SALE.from), height: fr.G.B - fr.G.T, fill: "var(--viz-grid)", opacity: 0.8 });
        fr.plot.insertBefore(band, fr.plot.firstChild);
      }

      function drawSeries(fr, from, to, smooth, showOrdered) {
        const { D, C, ordered } = model, { X, Y } = fr;
        const shape = demandShape(D, smooth), line = demandLine(X, Y, shape, from, to);
        const path = (d, attrs) => s("path", Object.assign({ d, fill: "none", "stroke-linejoin": "round" }, attrs));
        fr.plot.append(
          path(`${line}L${X(to)},${Y(0)}L${X(from)},${Y(0)}Z`, { fill: "var(--viz-c6-soft)" }),
          path(gapPath(X, Y, shape, C, from, to, -1), { fill: fr.idleFill }),
          path(gapPath(X, Y, shape, C, from, to, 1), { fill: "var(--viz-bad)", "fill-opacity": 0.55 }),
          path(line, { stroke: "var(--viz-c6)", "stroke-width": 2 }),
          showOrdered && path(stepLine(X, Y, i => ordered[i], from, to, i => ordered[i] - C[i] >= 2),
            { stroke: "var(--viz-c1)", "stroke-width": 2, "stroke-dasharray": "4 3" }),
          path(stepLine(X, Y, i => C[i], from, to), { stroke: "var(--viz-c1)", "stroke-width": 2.5 }),
        );
      }

      function drawMain() {
        const fr = view.main, G = fr.G, { D, C } = model;
        fr.plot.innerHTML = "";
        const sc = niceScale(Math.max(...D, ...C), 5);
        const ticks = G.hours.map(h => h * 12);
        const { X, Y } = axes(fr, sc, 0, SLOTS, ticks);
        saleBand(fr, X);
        drawSeries(fr, 0, SLOTS, true, false);
        const label = (x, y, str, o) => fr.plot.append(ctx.text(x, y, str, Object.assign({ size: G.size, weight: 600, halo: true }, o)));
        if (st.surprise === "sale") label((X(SALE.from) + X(SALE.to)) / 2, G.T + 9, "flash sale");
        if (st.surprise === "viral") {
          fr.plot.append(s("line", { x1: X(VIRAL.from), x2: X(VIRAL.from), y1: G.T, y2: G.B, stroke: "var(--viz-muted)", "stroke-dasharray": "3 4" }));
          label(X(VIRAL.from) + 5, G.T + 9, "goes viral →", { anchor: "start" });
        }
        if (st.mode === "elastic" && st.prescale) {
          label(X(PRESCALE.from) - 5, Y(PRESCALE.floor), "scheduled floor " + PRESCALE.floor + " →", { anchor: "end", fill: "var(--viz-c1)" });
        }
      }

      function drawZoom() {
        const fr = view.zoom, G = fr.G, { D, C, ordered } = model;
        fr.wrap.style.display = st.surprise === "sale" ? "" : "none";
        if (st.surprise !== "sale") return;
        fr.plot.innerHTML = "";
        let max = 0;
        for (let i = ZOOM.from; i < ZOOM.to; i++) max = Math.max(max, D[i], C[i], ordered[i]);
        const { X, Y } = axes(fr, niceScale(max, 3), ZOOM.from, ZOOM.to, ZOOM.ticks);
        saleBand(fr, X);
        const elastic = st.mode === "elastic";
        drawSeries(fr, ZOOM.from, ZOOM.to, false, elastic);
        const boot = Array.from({ length: SALE.to - SALE.from }, (_, k) => SALE.from + k).find(i => ordered[i] - C[i] >= 2);
        if (boot !== undefined) {
          fr.plot.append(ctx.text(X(boot) - 4, Y(ordered[boot]), "booting", { size: G.size, anchor: "end", fill: "var(--viz-c1)", weight: 600, halo: true }));
        }
        annotateZoom(fr, X);
        fr.title.textContent = "Zoom on 11:30–13:30, around the sale" +
          (elastic && st.delay > 0 ? " · dashed line = servers ordered but still booting" : "");
      }

      // Bracket over the minutes that failed during the sale (or a green "all clear").
      function annotateZoom(fr, X) {
        const G = fr.G, fails = summarize(model.D, model.C, ZOOM.from, ZOOM.to).failing;
        const ok = fails.length === 0;
        const a = ok ? SALE.from : fails[0], b = ok ? SALE.to : fails[fails.length - 1] + 1;
        const mins = fails.length * SLOT_MIN;
        let str;
        if (ok) str = st.mode === "manual" ? `${st.fleet} servers covered the sale: nothing failed` : "capacity was ready before the sale: nothing failed";
        else if (st.mode === "manual") str = `${mins} min short: a fixed fleet can't react`;
        else if (mins === SLOT_MIN + st.delay && b - a === fails.length) {
          str = `${mins} min short: 5 to notice` + (st.delay ? ` + ${st.delay} to boot` : ", instant boot");
        }
        else str = `${mins} min short`;
        const color = ok ? "var(--viz-ok)" : "var(--viz-bad)", y = 20;
        const x1 = X(a), x2 = X(b);
        fr.plot.append(s("path", { d: `M${x1},${y + 5}V${y}H${x2}V${y + 5}`, fill: "none", stroke: color, "stroke-width": 1.5 }));
        const w = str.length * G.size * 0.55;
        const cx = Math.max(G.L + w / 2, Math.min(G.R - w / 2, (x1 + x2) / 2));
        fr.plot.append(ctx.text(cx, y - 10, str, { size: G.size, weight: 700, fill: color, halo: true }));
      }

      function drawCursor() {
        const fr = view.main, G = fr.G, { D, C } = model, ro = fr.readout;
        fr.cur.innerHTML = "";
        ro.textContent = "";
        const tspan = (str, fill, weight) => s("tspan", { fill, "font-weight": weight }, str);
        if (cursor === null) {
          ro.append(tspan(compact ? "tap the chart to inspect a moment" : "hover the chart to inspect a moment", "var(--viz-muted)"));
          return;
        }
        const i = Math.min(SLOTS - 1, Math.floor(cursor)), x = fr.X(cursor);
        if (playing) fr.cur.append(s("rect", { x, y: G.T, width: Math.max(0, G.R - x), height: G.B - G.T, fill: "var(--viz-bg)", opacity: 0.6 }));
        const dot = (v, color) => s("circle", { cx: x, cy: fr.Y(v), r: 4, fill: color, stroke: "var(--viz-bg)", "stroke-width": 1.5 });
        fr.cur.append(s("line", { x1: x, x2: x, y1: G.T - 4, y2: G.B, stroke: "var(--viz-ink)", "stroke-width": 1, "stroke-dasharray": "3 3" }),
          dot(D[i], "var(--viz-c6)"), dot(C[i], "var(--viz-c1)"));
        const failPct = Math.round((100 * Math.max(0, D[i] - C[i])) / D[i]);
        ro.append(tspan(hhmm(i), "var(--viz-ink)", 700), tspan(" · demand ", "var(--viz-muted)"), tspan(String(Math.round(D[i])), "var(--viz-c6)", 700),
          tspan(" · capacity ", "var(--viz-muted)"), tspan(String(C[i]), "var(--viz-c1)", 700), tspan(" · ", "var(--viz-muted)"),
          D[i] > C[i] ? tspan(`${failPct}% failing`, "var(--viz-bad)", 700) : tspan("all served", "var(--viz-ok)", 700));
      }

      function setStats() {
        const { m } = model, S = view.stats;
        S.set("failed", fmtPct(m.failed), m.failed === 0 ? "ok" : m.failed < 1 ? "warn" : "bad");
        S.set("hours", String(Math.round(m.serverHours)), "info");
        S.set("util", Math.round(m.util) + "%", "");
        S.set("worst", m.worst === 0 ? "0" : (m.worst < 1 ? m.worst.toFixed(1) : Math.round(m.worst)) + " servers", m.worst > 0 ? "bad" : "ok");
      }

      // ---------- explanation ----------
      function explain() {
        const { D, m, sale, extraPre } = model, b = v => `<b>${v}</b>`;
        const peak = Math.round(Math.max(...D)), failed = fmtPct(m.failed), sh = Math.round(m.serverHours);
        const tone = m.failed === 0 ? "ok" : m.failed < 1 ? "warn" : "bad";
        if (st.mode === "manual") {
          if (st.surprise === "none") {
            return m.failed === 0
              ? [`${b(st.fleet)} fixed servers cover today's peak of ${b(peak)}${st.fleet - peak >= 2 ? " with headroom" : ""}, and nothing fails. ` +
                 `But at 4 a.m. demand is only ${b(Math.round(D[48]))}: the fleet is mostly idle and you pay for the peak all day ` +
                 `(${b(sh)} server-hours for about ${b(Math.round(m.workHours))} server-hours of actual work).`, "info"]
              : [`${b(st.fleet)} fixed servers are fewer than today's peak of ${b(Math.max(...D).toFixed(1))}, so requests fail around ` +
                 `the afternoon peak (${b(failed)} of the day's). ` +
                 "Size a fixed fleet for the average and it falls over at the peak; size it for the peak and it idles all night.", "bad"];
          }
          if (st.surprise === "sale") {
            const salePeak = Math.round(Math.max(...D.slice(SALE.from, SALE.to)));
            return sale.failed > 0
              ? [`The flash sale needed ~${b(salePeak)} servers; the fixed fleet had ${b(st.fleet)}. During that hour about ${b(fmtPct(sale.failed))} ` +
                 `of the sale's traffic failed (${b(failed)} of the whole day). Manual capacity is only safe if you predicted the peak.`, "bad"]
              : [`${b(st.fleet)} servers rode out the sale (~${b(salePeak)} needed), but only because you sized for it in advance: ` +
                 `${b(sh)} server-hours at ${b(Math.round(m.util) + "%")} average utilization to cover one busy hour.`, m.failed > 0 ? tone : "warn"];
          }
          return m.failed > 0
            ? [`Demand outgrew the fixed fleet at ${b(hhmm(m.failing[0]))} and stayed above it until ${b(hhmm(m.failing[m.failing.length - 1] + 1))}: ` +
               `${b(failed)} of requests failed. A manually scaled system needs a human to notice the trend and add machines.`, "bad"]
            : [`${b(st.fleet)} servers absorbed growth to ~${b(peak)}, but only because you paid for that headroom all day ` +
               `(${b(Math.round(m.util) + "%")} average utilization). Normally a human has to notice the trend and add machines.`, "warn"];
        }
        const zeroDelay = st.delay === 0 ? " (A zero-minute delay is the ideal case; real instances take minutes to boot and warm up.)" : "";
        let out;
        if (st.surprise === "sale" && !st.prescale) {
          const first = m.failing.filter(i => i >= SALE.from && i < SALE.to);
          const n = first.length * SLOT_MIN, all = first.length === m.failing.length;
          out = ["Demand jumped by 30 servers within one 5-minute sample. The autoscaler only saw it a sample later" +
            (st.delay ? `, and its new servers took ${b(st.delay + " min")} to boot, so ` : ", so even with instant boots ") +
            `${b(failed)} of the day's requests failed, ${all ? "all" : "mostly"} in the first ${b(n + " minutes")} of the sale. ` +
            "Auto-scaling follows load; it can't anticipate it.", m.failed < 1 ? "warn" : "bad"];
        } else if (st.surprise === "sale") {
          out = sale.failed === 0
            ? ["An operator scheduled extra capacity for a known event (a floor of 50 servers from 11:30), so the sale went through cleanly. " +
               "Predictable spikes are best handled by planning, not reacting.", "ok"]
            : [`Even with a floor of 50 servers, ${b(fmtPct(sale.failed))} of the sale's traffic failed.`, tone];
        } else if (st.prescale) {
          out = [`Pre-scaling for a sale that didn't happen just added ${b(Math.round(extraPre))} idle server-hours. ` +
            "Scheduled capacity only pays off for events you can actually predict.", "warn"];
        } else if (st.surprise === "viral") {
          out = m.failed < 0.1
            ? [`Gradual growth is where elasticity shines: capacity keeps up with only a small lag (${b(failed)} failed), and the extra servers ` +
               `are paid for only once they're needed (${b(sh)} server-hours).`, "ok"]
            : [`Gradual growth suits elasticity, but this setup cuts it close: with ${st.delay}-minute boots and only ${100 - st.target}% headroom, ` +
               `capacity trails the ramp and ${b(failed)} of requests failed.`, tone];
        } else {
          const ref = Math.max(st.fleet, Math.ceil(Math.max(...D)));
          out = [`Auto-scaling tracks the daily curve: about ${b(sh)} server-hours instead of ${b(ref * 24)} for a fixed fleet of ${ref}, ` +
            (m.failed === 0 ? "with nothing failing, because diurnal load changes slowly."
              : `but at ${st.target}% target utilization the headroom is too thin for random wobbles and ${b(failed)} of requests failed.`), tone];
        }
        return [out[0] + zeroDelay, out[1]];
      }

      // ---------- play the day ----------
      function syncPlay() {
        view.playBtn.disable(playing).setLabel(playing ? "Playing…" : "▶ Play the day");
      }
      async function playDay() {
        if (playing) return;
        playing = true;
        syncPlay();
        await ctx.tween({ ms: 4000, ease: "linear", onUpdate: k => { cursor = k * SLOTS; drawCursor(); } });
        playing = false;
        cursor = null;
        syncPlay();
        drawCursor();
      }

      build();
      // Rebuild with the other layout when the frame crosses the phone breakpoint (onResize
      // callbacks already run on the next frame, outside the ResizeObserver).
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
