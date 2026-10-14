// TrueTime and commit wait. T1 commits on node A, then (causally after it) T2 starts on node B.
// Each node's clock reading is an interval TT.now() = [earliest, latest] that holds the true time
// only while the clock's real error stays within ±ε. Without commit wait, clock error can give T2
// the smaller timestamp; with it, T1 stays invisible until s1 is surely in the past, so T2 can't.
(function () {
  "use strict";

  const T1 = 25, TMAX = 75;            // true time (ms) when T1 asks to commit; axis length
  const r1 = v => Math.round(v * 10) / 10;
  const PRESETS = [
    { value: "worst", label: "Worst case" },
    { value: "accurate", label: "Accurate" },
    { value: "random", label: "Random" },
    { value: "broken", label: "Broken clock" },
  ];

  // ---------------------------------------------------------------- pure model
  /** Actual clock errors [eA, eB] in ms (0.1 ms resolution). draw = [fA, fB] in [-1, 1] for Random. */
  function clockErrors(preset, eps, draw) {
    if (preset === "worst") { const e = Math.floor(9 * eps + 1e-9) / 10; return [e, -e]; }  // 0.9ε, kept inside ±ε
    if (preset === "random") return draw.map(f => r1(f * eps));
    if (preset === "broken") return [eps + 2, -(eps + 2)];
    return [0, 0];
  }

  /** Node X's clock reads t + eX, so TT.now() = [t + eX - ε, t + eX + ε]. All times are true time. */
  function model({ eps, eA, eB, gap, wait }) {
    const s1 = r1(T1 + eA + eps);                  // commit timestamp = TT.now().latest on A
    const v1 = wait ? r1(T1 + 2 * eps) : T1;       // first t with TT.now().earliest on A > s1
    const t2 = r1(v1 + gap);                       // T2 starts after the user saw T1
    const s2 = r1(t2 + eB + eps);                  // snapshot timestamp = TT.now().latest on B
    return {
      eps, eA, eB, gap, wait, t1: T1, s1, v1, t2, s2,
      ttA: [r1(T1 + eA - eps), s1], ttB: [r1(t2 + eB - eps), s2],
      ghost: wait ? [s1, r1(s1 + 2 * eps)] : null,  // TT.now() on A when the wait ends
      outA: Math.abs(eA) > eps, outB: Math.abs(eB) > eps,
      violated: s2 < s1,
    };
  }

  // ---------------------------------------------------------------- formatting
  const fmt = v => (r1(v) < 0 ? "−" : "") + Math.abs(r1(v)).toFixed(1).replace(/\.0$/, "");
  const clockShort = e => (e === 0 ? "exact" : `${fmt(Math.abs(e))} ms ${e > 0 ? "fast" : "slow"}`);
  const clockDesc = e => (e === 0 ? "is exact" : `runs <b>${fmt(Math.abs(e))} ms</b> ${e > 0 ? "fast" : "slow"}`);
  const est = (str, fs) => str.length * fs * 0.57;   // rough text width for placement

  function noteFor(m, preset) {
    const b = v => `<b>${fmt(v)}</b>`, ms = v => `<b>${fmt(v)} ms</b>`, d = r1(m.eA - m.eB);
    if (m.wait && (m.outA || m.outB)) {
      if (!m.violated) {
        return [`The clocks are outside their promised bounds, but this time the ${ms(m.gap)} gap covered the error. ` +
          `Drag the gap below <b>4 ms</b>: correctness now depends on luck.`, "warn"];
      }
      return [`Both clocks are off by ${ms(m.eA)}, more than the <b>±${fmt(m.eps)} ms</b> TrueTime promised, so neither ` +
        `TT.now() interval contains the true time (red ticks). Commit wait made T1 visible at true time ${b(m.v1)}, ` +
        `before its own timestamp ${b(m.s1)}, and T2 again got the smaller timestamp ${b(m.s2)}. The guarantee rests ` +
        `entirely on ε being a true bound, which is why Spanner monitors its clocks and evicts machines whose clocks misbehave.`, "bad"];
    }
    if (m.wait) {
      let html = `T1 chose s1 = TT.now().latest = ${b(m.s1)} and then waited until even the earliest possible current ` +
        `time was past s1 (dashed box). That takes 2ε = ${ms(2 * m.eps)} however wrong the clock is (within ±ε), so ` +
        `anything that starts after T1 is visible gets a larger timestamp. The price: ${ms(2 * m.eps)} on every ` +
        `read-write commit. Spanner overlaps the wait with Paxos replication, but it still sets a floor on commit ` +
        `latency, which is why Google keeps ε small with GPS and atomic-clock time masters in every datacenter.`;
      if (m.eps >= 8) html += ` At ε = ${ms(m.eps)} the wait is ${ms(2 * m.eps)} per commit: uncertainty has become a direct latency tax.`;
      return [html, "ok"];
    }
    if (m.violated) {
      return [`Node A's clock ${clockDesc(m.eA)}${m.eA > 0 ? ", so" : " and"} T1 got timestamp ${b(m.s1)}. T2 started ${ms(m.gap)} after T1 was ` +
        `visible, but Node B's clock ${clockDesc(m.eB)}, ${ms(d)} behind A's, so T2 got the smaller timestamp ${b(m.s2)}. ` +
        `A snapshot read at ${b(m.s2)} doesn't include T1: the database contradicts what the user saw. ` +
        `Turn on <b>commit wait</b>.`, "bad"];
    }
    const hint = preset === "worst" || preset === "broken"
      ? `drag the gap below ${ms(d)}.` : "try <b>Worst case</b>.";
    if (m.eA === 0 && m.eB === 0) {
      return [`No violation: with perfect clocks, the transaction that starts later always gets the larger timestamp. ` +
        `Real clocks are never this good; ${hint}`, "warn"];
    }
    if (d <= 0) {
      return [`No violation this time: Node B's clock isn't behind Node A's, so T2, which started later, also got the ` +
        `larger timestamp. Nothing guarantees that; ${hint}`, "warn"];
    }
    return [`No violation this time: Node A's clock is only ${ms(d)} ahead of Node B's, no more than the ${ms(m.gap)} ` +
      `gap between T1 becoming visible and T2 starting. Nothing guarantees that; ${hint}`, "warn"];
  }

  Viz.register("ch8/commit-wait", {
    title: "TrueTime and commit wait",
    model: { clockErrors, model, T1, TMAX },   // for offline tests
    mount(root, ctx) {
      const { s, ui } = ctx;
      const rnd = ctx.random(17);   // first draw: A 1.8 ms fast, B 3.1 ms slow at ε = 5
      // State lives outside build() so a phone <-> desktop rebuild keeps it.
      let wait = false, eps = 5, gap = 1, preset = "worst", draw = null;
      let compact = ctx.compact, view = null, epoch = 0;

      const reroll = () => { draw = [rnd() * 2 - 1, rnd() * 2 - 1]; };
      const current = () => {
        const [eA, eB] = clockErrors(preset, eps, draw);
        return model({ eps, eA, eB, gap, wait });
      };
      const layout = () => compact
        ? { W: 360, x0: 18, k: 4.4, fs: 11, every: 20, yA: 68, yB: 180, axisY: 262, H: 298, clockX: 50, dia: 8 }
        : { W: 640, x0: 50, k: 7.5, fs: 12, every: 10, yA: 72, yB: 196, axisY: 282, H: 318, clockX: 96, dia: 9 };

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const L = layout();
        const svg = ctx.svg({ w: L.W, h: L.H, label: "Two transactions on two nodes with uncertain clocks, on a shared true-time axis" });
        const scene = s("g");
        svg.appendChild(scene);

        const waitToggle = ui.toggle({ label: "Commit wait", value: wait, onChange: v => { wait = v; changed(); } });
        const epsSlider = ui.slider({
          label: compact ? "Uncertainty ε" : "Promised uncertainty ε", min: 1, max: 10, step: 0.5, value: eps,
          format: v => "±" + v.toFixed(1) + " ms", onInput: v => { eps = v; changed(); },
        });
        const gapSlider = ui.slider({
          label: compact ? "T2 starts after" : "T2 starts after T1 is visible", min: 0, max: 10, step: 0.5, value: gap,
          format: v => v.toFixed(1) + " ms", onInput: v => { gap = v; changed(); },
        });
        if (compact) [epsSlider, gapSlider].forEach(sl => { sl.input.style.flex = "1 1 80px"; });
        const presetCtl = (compact ? ui.select : ui.segmented)({
          label: compact ? "Actual clock errors" : "True clock errors (unknown to the nodes)", options: PRESETS, value: preset,
          onChange: v => { preset = v; if (v === "random" && !draw) reroll(); changed(); },
        });
        const rerollBtn = ui.button("⟳ Re-roll", () => { reroll(); changed(); }, { kind: "ghost", title: "Draw new random clock errors" });
        const replayBtn = ui.button("▶ Replay", () => replay(), { kind: "primary", title: "Sweep true time from 0 to 75 ms" });
        const legend = ui.legend([
          { color: "var(--viz-ink)", label: "true time of the event", shape: "line" },
          { color: "var(--viz-c2)", label: "TT.now() = [earliest, latest]", shape: "square" },
          { color: "var(--viz-c2)", label: "TT.now() when the wait ends", shape: "dash" },
          { color: "var(--viz-c6)", label: "s1: T1's commit timestamp", shape: "dot" },
          { color: "var(--viz-c5)", label: "s2: T2's snapshot timestamp", shape: "dot" },
          { color: "var(--viz-warn)", label: "commit wait", shape: "square" },
        ]);
        const stats = ui.stats([
          { key: "s1", label: "T1 timestamp s1" },
          { key: "s2", label: "T2 timestamp s2" },
          { key: "order", label: "Order" },
          { key: "cost", label: "Extra commit latency" },
        ]);
        const note = ui.note("");

        root.append(
          ui.bar(waitToggle, epsSlider, gapSlider),
          ui.bar(presetCtl, rerollBtn, replayBtn),
          svg, legend, stats, note,
        );
        view = { L, scene, stats, note, rerollBtn, legend };
        changed();
      }

      function changed() {
        epoch++;   // cancels a replay in progress
        const m = current();
        render(m);
        const { stats, note, rerollBtn, legend } = view;
        stats.set("s1", fmt(m.s1) + " ms");
        stats.set("s2", fmt(m.s2) + " ms");
        stats.set("order", m.violated ? "VIOLATED" : "correct", m.violated ? "bad" : "ok");
        stats.set("cost", wait ? fmt(2 * eps) + " ms" : "0 ms", wait ? "warn" : "");
        note.set(...noteFor(m, preset));
        rerollBtn.style.display = preset === "random" ? "" : "none";
        legend.children[2].style.display = wait ? "" : "none";
      }

      async function replay() {
        const my = ++epoch, m = current();
        await ctx.tween({ ms: 3600, ease: "linear", onUpdate: k => { if (my === epoch) render(m, k * TMAX); } });
        if (my === epoch) render(m);
      }

      // ------------------------------------------------------------ drawing
      // Draws the scene as it looks at true time `tr` (Infinity = everything, the static view).
      function render(m, tr = Infinity) {
        const L = view.L, X = t => L.x0 + t * L.k;
        const back = s("g"), mid = s("g"), front = s("g");
        view.scene.replaceChildren(back, mid, front);
        const txt = (x, y, str, o = {}) => plate(front, ctx.text(x, y, str, { size: L.fs, ...o }), o.plate !== false);
        const ctr = (x, str, fs = L.fs) => { const w = est(str, fs) / 2 + 3; return Math.max(w, Math.min(L.W - w, x)); };

        drawAxis(back, L, X, txt, tr);
        rowHeader(txt, L, L.yA - 54, compact ? "A · T1" : "Node A · T1", m.eA, m.outA);
        rowHeader(txt, L, L.yB - 54, compact ? "B · T2" : "Node B · T2", m.eB, m.outB);

        // Before its event, each row shows its node's live TT.now() following the cursor.
        if (tr < m.t1) liveBox(mid, L, X, L.yA, tr, m.eA, m.eps, 0.45);
        if (tr >= m.t1) {
          if (m.wait) {
            const end = Math.min(m.v1, tr);
            if (tr < m.v1) liveBox(mid, L, X, L.yA, tr, m.eA, m.eps, 1);
            else mid.appendChild(box(X, L.yA, m.ghost, { dashed: true }));
            waitBar(mid, txt, L, X, m, end, tr);
          }
          drawRow(back, mid, txt, ctr, L, X, {
            y: L.yA, t: m.t1, tt: m.ttA, s: m.s1, name: "s1", color: "var(--viz-c6)", out: m.outA,
            flag: compact ? "commit" : "commit requested",
          });
        }
        if (tr >= m.v1) visibleMark(mid, txt, L, X, m);
        if (tr < m.t2) liveBox(mid, L, X, L.yB, tr, m.eB, m.eps, 0.45);
        if (tr >= m.t2) {
          causalArrow(mid, L, X, m);
          drawRow(back, mid, txt, ctr, L, X, {
            y: L.yB, t: m.t2, tt: m.ttB, s: m.s2, name: "s2", color: "var(--viz-c5)", out: m.outB,
            flag: compact || m.outB ? "T2 starts" : "T2 starts (user saw T1 first)",
          });
        }
        if (tr >= TMAX) verdict(mid, txt, ctr, L, X, m);
        if (tr < Infinity) cursor(back, front, txt, L, X, tr);
      }

      // Opaque backing so guides and arrows passing behind a label don't cut through it.
      function plate(layer, t, on) {
        layer.appendChild(t);
        if (!on) return t;
        let bb = null;
        try { bb = t.getBBox(); } catch (e) { /* not rendered */ }
        if (!bb || !bb.width) {   // hidden frame: estimate from the font size and anchor
          const fs = +t.getAttribute("font-size"), w = est(t.textContent, fs), a = t.getAttribute("text-anchor");
          bb = { x: +t.getAttribute("x") - (a === "end" ? w : a === "middle" ? w / 2 : 0), y: +t.getAttribute("y") - fs * 0.6, width: w, height: fs * 1.2 };
        }
        layer.insertBefore(s("rect", { x: bb.x - 2, y: bb.y - 1, width: bb.width + 4, height: bb.height + 2, rx: 3, fill: "var(--viz-bg)" }), t);
        return t;
      }

      function drawAxis(layer, L, X, txt, tr) {
        const top = L.yA - 40;
        for (let t = 0; t <= TMAX; t += L.every) {
          layer.appendChild(s("line", { x1: X(t), x2: X(t), y1: top, y2: L.axisY, stroke: "var(--viz-grid)", "stroke-width": 1 }));
          layer.appendChild(s("line", { x1: X(t), x2: X(t), y1: L.axisY, y2: L.axisY + 5, stroke: "var(--viz-muted)" }));
          if (!(Math.abs(X(t) - X(tr)) < est("now 00.0", L.fs) / 2 + 9)) txt(X(t), L.axisY + 15, String(t), { fill: "var(--viz-muted)", plate: false });
        }
        layer.appendChild(s("line", { x1: X(0), x2: X(TMAX), y1: L.axisY, y2: L.axisY, stroke: "var(--viz-muted)", "stroke-width": 1.2 }));
        txt(L.W - 6, L.axisY + 30, "true time (ms)", { anchor: "end", fill: "var(--viz-muted)", plate: false });
        [L.yA, L.yB].forEach(y => layer.appendChild(s("line", {
          x1: X(0), x2: X(TMAX), y1: y, y2: y, stroke: "var(--viz-line)", "stroke-width": 1, "stroke-dasharray": "2 4",
        })));
      }

      function rowHeader(txt, L, y, name, e, out) {
        txt(8, y, name, { anchor: "start", weight: 700 });
        const str = compact ? clockShort(e) : "clock " + clockShort(e);
        txt(L.clockX, y, str, { anchor: "start", mono: true, fill: out ? "var(--viz-bad)" : "var(--viz-muted)", weight: out ? 700 : null });
      }

      function box(X, y, [lo, hi], o = {}) {
        return s("rect", {
          x: X(lo), y: y - 9, width: Math.max(1, X(hi) - X(lo)), height: 18, rx: 4,
          fill: o.dashed ? "none" : "var(--viz-c2-soft)", stroke: "var(--viz-c2)", "stroke-width": 1.5,
          "stroke-dasharray": o.dashed ? "4 3" : null, opacity: o.opacity == null ? 1 : o.opacity,
        });
      }

      // The node's current TT.now() while the replay cursor moves (clipped to the axis).
      function liveBox(layer, L, X, y, t, e, eps, opacity) {
        const lo = Math.max(0, t + e - eps), hi = Math.min(TMAX, t + e + eps);
        if (hi > lo) layer.appendChild(box(X, y, [lo, hi], { dashed: true, opacity }));
      }

      function drawRow(back, mid, txt, ctr, L, X, o) {
        mid.appendChild(box(X, o.y, o.tt));
        // Label left of the interval; on a phone it is skipped when there's no room (the legend covers it).
        if (X(o.tt[0]) - 6 - est("TT.now()", L.fs) >= 2) {
          txt(X(o.tt[0]) - 6, o.y, "TT.now()", { anchor: "end", fill: "var(--viz-c2)", weight: 600 });
        }
        // True-time tick: red when the clock's real error exceeds ε (the interval misses true time).
        const tc = o.out ? "var(--viz-bad)" : "var(--viz-ink)";
        mid.appendChild(s("line", { x1: X(o.t), x2: X(o.t), y1: o.y - 36, y2: o.y + 12, stroke: tc, "stroke-width": 2 }));
        const label = o.flag + (o.out ? (compact ? " (outside!)" : " (outside TT.now()!)") : "");
        const right = X(o.t) + 5 + est(label, L.fs) <= L.W - 4;
        txt(X(o.t) + (right ? 5 : -5), o.y - 31, label, { anchor: right ? "start" : "end", fill: tc, weight: 600 });
        // Timestamp diamond with a guide down to the shared axis.
        back.appendChild(s("line", {
          x1: X(o.s), x2: X(o.s), y1: o.y, y2: L.axisY, stroke: o.color, "stroke-width": 1.2, "stroke-dasharray": "3 4", opacity: 0.75,
        }));
        mid.appendChild(diamond(X(o.s), o.y, L.dia, o.color));
        mid.appendChild(s("circle", { cx: X(o.s), cy: L.axisY, r: 3.5, fill: o.color }));
        const str = `${o.name} = ${fmt(o.s)}`;
        txt(ctr(X(o.s), str), o.y + 21, str, { mono: true, weight: 700, fill: o.color });
      }

      function diamond(x, y, d, color) {
        return s("rect", {
          x: x - d / 2, y: y - d / 2, width: d, height: d, transform: `rotate(45 ${x} ${y})`,
          fill: color, stroke: "var(--viz-bg)", "stroke-width": 1.5,
        });
      }

      function waitBar(layer, txt, L, X, m, end, tr) {
        const y = L.yA + 40;
        layer.appendChild(s("rect", {
          x: X(m.t1), y: y - 5, width: Math.max(1, X(end) - X(m.t1)), height: 10, rx: 3,
          fill: "var(--viz-warn-soft)", stroke: "var(--viz-warn)", "stroke-width": 1.4,
        }));
        const label = `${compact ? "wait" : "commit wait"} 2ε = ${fmt(2 * m.eps)} ms`;
        txt(X(m.t1) - 6, y, label, { anchor: "end", fill: "var(--viz-warn)", weight: 600 });
        if (tr < m.v1) {   // replay: A keeps checking its clock until earliest passes s1
          const e = fmt(tr + m.eA - m.eps);
          txt(X(tr) + 8, y, compact ? `earliest ${e} < s1` : `waiting: TT.now().earliest = ${e} < s1`, { anchor: "start", fill: "var(--viz-warn)" });
        }
      }

      function visibleMark(layer, txt, L, X, m) {
        const x = X(m.v1), y = L.yA + 40;
        layer.appendChild(s("circle", { cx: x, cy: y, r: 7.5, fill: "var(--viz-bg)" }));
        layer.appendChild(s("circle", { cx: x, cy: y, r: 7.5, fill: "var(--viz-ok-soft)", stroke: "var(--viz-ok)", "stroke-width": 1.6 }));
        layer.appendChild(ctx.text(x, y + 0.5, "✓", { size: L.fs, weight: 800, fill: "var(--viz-ok)" }));
        const label = m.wait ? "T1 visible" : compact ? "T1 visible at once" : "T1 visible at once (no commit wait)";
        txt(x + 12, y, label, { anchor: "start", fill: "var(--viz-ok)", weight: 700 });
      }

      // The user saw T1 succeed and then started T2: T2 is causally after T1.
      function causalArrow(layer, L, X, m) {
        const y1 = L.yA + 49, y2 = L.yB - 40;
        layer.appendChild(ctx.arrow({ x1: X(m.v1), y1, x2: X(m.t2), y2, color: "var(--viz-ink)", dashed: true, width: 1.4, svg: layer.ownerSVGElement }));
      }

      function verdict(layer, txt, ctr, L, X, m) {
        const y = L.axisY - 12, a = X(Math.min(m.s1, m.s2)), b = X(Math.max(m.s1, m.s2));
        const color = m.violated ? "var(--viz-bad)" : "var(--viz-ok)";
        layer.appendChild(s("line", { x1: a, x2: Math.max(b, a + 1), y1: y, y2: y, stroke: color, "stroke-width": 3, "stroke-linecap": "round" }));
        [a, b].forEach(x => layer.appendChild(s("line", { x1: x, x2: x, y1: y - 5, y2: y + 5, stroke: color, "stroke-width": 2 })));
        const str = m.violated
          ? (compact ? "s2 < s1: T2 misses T1" : "s2 < s1: T2's snapshot misses T1, although T1 finished first")
          : (compact ? "s1 ≤ s2: order OK" : "s1 ≤ s2: T2's snapshot includes T1");
        const fs = compact ? 12 : 13;
        txt(ctr((a + b) / 2, str, fs), L.axisY - 30, str, { size: fs, weight: 700, fill: color });
      }

      function cursor(back, front, txt, L, X, t) {
        const x = X(t);
        back.appendChild(s("line", { x1: x, x2: x, y1: L.yA - 40, y2: L.axisY, stroke: "var(--viz-ink)", "stroke-width": 1.2, "stroke-dasharray": "2 3", opacity: 0.7 }));
        front.appendChild(s("path", { d: `M${x - 5},${L.axisY + 7} L${x + 5},${L.axisY + 7} L${x},${L.axisY + 1} Z`, fill: "var(--viz-ink)" }));
        txt(x, L.axisY + 15, "now " + fmt(t), { weight: 700, size: L.fs });
      }

      build();
      // Rebuild with the other layout when the frame crosses the phone breakpoint.
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
