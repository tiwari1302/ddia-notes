// The self-fulfilling model: a toy lending simulation of selective labels. Two groups of 100
// applicants have identical true ability; G2's scores start lower (thin credit files). A loan
// reveals the borrower's ability and moves their score toward it; a denial reveals nothing,
// thins the file and (optionally) harms the applicant, so the starting bias persists or comes true.
Viz.register("ch12/feedback-loop", {
  title: "The self-fulfilling model",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const N = 100, MAX_ROUNDS = 40, EXPLORE_P = 0.15, YMAX = 80;
    const GROUPS = [{ id: "G1", c: "var(--viz-c2)" }, { id: "G2", c: "var(--viz-c5)" }];
    const clip = ctx.clamp;
    const jitter = i => ((i * 37) % 21) - 10;

    // State lives outside build() so a layout switch (phone <-> desktop) keeps it.
    let gap = 12, threshold = 60, explore = false, harm = true, showHidden = true;
    let sim = null, running = false, epoch = 0, animToken = 0;
    let compact = ctx.compact, view = null;

    // ---------------- model ----------------
    function newSim() {
      const pop = ctx.random(12), ability = [];
      for (let i = 0; i < N; i++) ability.push(clip(60 + 12 * pop.normal(), 5, 95));
      // Both groups share the same ability array (paired people); score noise is drawn G1 then G2.
      const people = GROUPS.map((g, gi) => ability.map(a => ({
        a0: a, a, s: clip(a + 6 * pop.normal() - (gi === 1 ? gap : 0), 0, 100),
        loans: 0, repaid: 0, explored: false,
      })));
      const st = { people, rng: ctx.random(99), round: 0, hist: [] };
      st.hist.push({ appr: approvals(st), explore: false });
      return st;
    }

    const approvals = st => st.people.map(ps => Math.round((100 * ps.filter(p => p.s >= threshold).length) / N));

    // One lending round. Fixed draw order: [explore draw if denied & exploring], [if approved: normal, repaid].
    function stepRound(st) {
      const rng = st.rng;
      for (const ps of st.people) {
        for (const p of ps) {
          let ok = p.s >= threshold;
          p.explored = false;
          if (!ok && explore && rng() < EXPLORE_P) ok = p.explored = true;
          if (ok) {
            p.s += 0.35 * (p.a + 4 * rng.normal() - p.s);
            p.loans++;
            if (rng() < clip(0.25 + p.a / 100, 0.05, 0.97)) p.repaid++;
          } else {
            p.s -= 0.5;                                // thin file gets thinner
            if (harm) p.a = Math.max(5, p.a - 0.3);    // the person's real situation worsens
          }
          p.s = clip(p.s, 0, 100);
        }
      }
      st.round++;
      st.hist.push({ appr: approvals(st), explore });
    }

    function measure() {
      return sim.people.map(ps => {
        const m = { appr: 0, ability: 0, start: 0, qd: 0, pushed: 0, loans: 0, repaid: 0 };
        for (const p of ps) {
          if (p.s >= threshold) m.appr++;
          else if (p.a >= threshold) m.qd++;
          if (p.a0 >= threshold && p.a < threshold) m.pushed++;
          m.ability += p.a / N; m.start += p.a0 / N;
          m.loans += p.loans; m.repaid += p.repaid;
        }
        m.appr = Math.round((100 * m.appr) / N);
        m.rate = m.loans ? (100 * m.repaid) / m.loans : null;
        return m;
      });
    }

    // ---------------- layout ----------------
    function layout() {
      return compact
        ? { W: 360, H: 424, sx0: 50, sx1: 350, rowY: [52, 116], band: 27, axisY: 148, labelX: 8, r: 3.5,
            cx0: 40, cx1: 298, cy0: 212, cy1: 392, fs: 11, rowFs: 13 }
        : { W: 640, H: 360, sx0: 110, sx1: 620, rowY: [58, 128], band: 29, axisY: 162, labelX: 12, r: 4,
            cx0: 110, cx1: 576, cy0: 222, cy1: 330, fs: 12, rowFs: 14 };
    }

    function build() {
      root.innerHTML = "";
      compact = ctx.compact;
      const L = layout();

      const gapSlider = ui.slider({
        label: "Starting score gap (G2)", min: 0, max: 25, value: gap, format: v => v + " pts",
        onInput: v => { gap = v; reset(); },
      });
      const thrSlider = ui.slider({
        label: "Approval threshold", min: 50, max: 75, value: threshold,
        onInput: v => { threshold = v; reset(); },
      });
      if (compact) [gapSlider, thrSlider].forEach(sl => { sl.input.style.flex = "1 1 80px"; });
      const exploreToggle = ui.toggle({
        label: "Explore: approve 15% of rejected at random", value: explore,
        onChange: v => { explore = v; refresh(); },
      });
      const harmToggle = ui.toggle({ label: "Denial harms finances", value: harm, onChange: v => { harm = v; refresh(); } });
      const nextBtn = ui.button("Next round", () => { if (!running) advance(); }, { kind: "primary" });
      const runBtn = ui.button("Run 10 rounds", () => runTen());
      const resetBtn = ui.button("⟲ Reset", () => reset(), { kind: "ghost" });

      const svg = ctx.svg({ w: L.W, h: L.H, label: "Applicants of two groups placed by lender's score, and approval rate by round" });
      const scene = s("g"), dotLayer = s("g"), markLayer = s("g"), chartLayer = s("g");
      svg.append(scene, dotLayer, markLayer, chartLayer);
      const rowLabels = drawStatic(scene, L);
      const thr = { line: s("line", { stroke: "var(--viz-ink)", "stroke-width": 1.5, "stroke-dasharray": "5 4", y1: 22, y2: L.axisY }),
        label: ctx.text(0, 11, "", { size: 12, weight: 600, halo: true }) };
      scene.append(thr.line, thr.label);
      const dots = buildDots(dotLayer, markLayer, L);

      const hiddenToggle = ui.toggle({
        label: "Show what the lender can't see:", value: showHidden,
        onChange: v => { showHidden = v; styleDots(); },
      });
      const legend = buildLegend(hiddenToggle);
      const stats = ui.stats([
        { key: "round", label: "Round", value: "" },
        { key: "appr", label: "Approved G1 / G2", value: "" },
        { key: "ability", label: "Avg true ability G1 / G2", value: "" },
        { key: "qd", label: "Qualified but denied G1 / G2", value: "" },
        { key: "pushed", label: "Pushed below the bar G1 / G2", value: "" },
        { key: "repaid", label: "Repaid among approved G1 / G2", value: "" },
      ]);
      stats.style.gridTemplateColumns = compact ? "repeat(2, minmax(0, 1fr))" : "repeat(3, minmax(0, 1fr))";
      const note = ui.note("");

      root.append(
        ui.bar(gapSlider, thrSlider),
        ui.bar(exploreToggle, harmToggle),
        ui.bar(nextBtn, runBtn, resetBtn),
        svg,
        h("div", { class: "muted", style: "font-size:12px;margin:2px 0 4px" },
          "Toy model for intuition, not an empirical model of any real lender. Every denial lowers the lender's score 0.5 " +
          "(the file stays thin); \u201cDenial harms finances\u201d also lowers the person's true ability 0.3 a round."),
        legend,
        stats,
        note,
      );
      view = { L, svg, chartLayer, dots, thr, rowLabels, stats, note, nextBtn, runBtn };
      placeDots(false);
      refresh();
    }

    // Row bands, row labels and the score axis (everything that doesn't change per round).
    function drawStatic(g, L) {
      const xOf = v => L.sx0 + (v / 100) * (L.sx1 - L.sx0);
      const muted = { size: L.fs, fill: "var(--viz-muted)" };
      const labels = GROUPS.map((G, gi) => {
        const y = L.rowY[gi];
        g.appendChild(s("rect", { x: L.sx0 - 6, y: y - L.band, width: L.sx1 - L.sx0 + 12, height: 2 * L.band, rx: 6, fill: "var(--viz-grid)", opacity: 0.35 }));
        g.appendChild(ctx.text(L.labelX, y - 8, G.id, { size: L.rowFs, weight: 700, anchor: "start", fill: G.c }));
        const sub = ctx.text(L.labelX, y + 9, "", { ...muted, anchor: "start" });
        g.appendChild(sub);
        return sub;
      });
      g.appendChild(ctx.text(L.labelX, 11, compact ? "one dot per applicant" : "one dot per applicant, at the lender's score",
        { ...muted, anchor: "start" }));
      g.appendChild(s("line", { x1: L.sx0, x2: L.sx1, y1: L.axisY, y2: L.axisY, stroke: "var(--viz-line)" }));
      for (let v = 0; v <= 100; v += 20) {
        g.appendChild(s("line", { x1: xOf(v), x2: xOf(v), y1: L.axisY, y2: L.axisY + 4, stroke: "var(--viz-line)" }));
        g.appendChild(ctx.text(xOf(v), L.axisY + 15, String(v), muted));
      }
      g.appendChild(ctx.text(L.sx0 - 8, L.axisY + 15, "score", { ...muted, anchor: "end" }));
      return labels;
    }

    function buildDots(dotLayer, markLayer, L) {
      const top = -L.r - 2;
      return sim.people.map((ps, gi) => ps.map((p, i) => {
        const g = s("g"), mark = s("g");
        const ring = s("circle", { r: L.r + 2.6, fill: "none", stroke: "var(--viz-warn)", "stroke-width": 2 });
        const dot = s("circle", { r: L.r, "stroke-width": 1.4 });
        const tick = s("line", { x1: 0, x2: 0, y1: top, y2: top - 7, stroke: "var(--viz-bad)", "stroke-width": 2, "stroke-linecap": "round" });
        const fell = s("path", { d: `M-3.5,${top - 7}L3.5,${top - 7}L0,${top - 1}Z`, fill: "var(--viz-bad)" });
        g.append(ring, dot);
        mark.append(tick, fell);
        dotLayer.appendChild(g);
        markLayer.appendChild(mark);
        return { g, mark, ring, dot, tick, fell, gi, i, y: L.rowY[gi] + jitter(i), x: null };
      })).flat();
    }

    const personOf = d => sim.people[d.gi][d.i];
    const scoreX = v => view.L.sx0 + (v / 100) * (view.L.sx1 - view.L.sx0);
    const show = (el, on) => { el.style.display = on ? "" : "none"; };

    function moveDot(d, x) {
      d.x = x;
      const t = `translate(${x.toFixed(1)},${d.y})`;
      d.g.setAttribute("transform", t);
      d.mark.setAttribute("transform", t);
    }

    function styleDots() {
      for (const d of view.dots) {
        const p = personOf(d), c = GROUPS[d.gi].c, ok = p.s >= threshold;
        ctx.attr(d.dot, { fill: ok ? c : "var(--viz-bg)", stroke: ok ? "var(--viz-bg)" : c });
        show(d.ring, p.explored);
        show(d.tick, showHidden && !ok && p.a >= threshold);
        show(d.fell, showHidden && p.a0 >= threshold && p.a < threshold);
      }
    }

    // Slides every dot from where it is drawn to its current score; restyles when it lands.
    async function placeDots(animate) {
      const my = ++animToken, dots = view.dots;
      const from = dots.map(d => (d.x === null ? scoreX(personOf(d).s) : d.x));
      const to = dots.map(d => scoreX(personOf(d).s));
      dots.forEach(d => show(d.ring, personOf(d).explored));
      if (animate) {
        await ctx.tween({ ms: 240, ease: "inOut", onUpdate: k => {
          if (my === animToken) dots.forEach((d, j) => moveDot(d, ctx.lerp(from[j], to[j], k)));
        } });
        if (my !== animToken) return;
      }
      dots.forEach((d, j) => moveDot(d, to[j]));
      styleDots();
    }

    // ---------------- chart ----------------
    function drawChart() {
      const { L, chartLayer: g } = view;
      g.innerHTML = "";
      // The axis always spans every round you can play, so the scale never jumps mid-run.
      const hist = sim.hist, last = hist.length - 1, xmax = MAX_ROUNDS;
      const X = r => L.cx0 + (r / xmax) * (L.cx1 - L.cx0);
      const Y = v => L.cy1 - (v / YMAX) * (L.cy1 - L.cy0);
      const muted = { size: L.fs, fill: "var(--viz-muted)" };

      g.appendChild(ctx.text(L.cx0, L.cy0 - 16, "% of each group the model approves, by round", { ...muted, anchor: "start" }));
      // Rounds played with exploration on get an amber band (same color as the exploration ring).
      const firstExplore = hist.findIndex(e => e.explore);
      hist.forEach((e, r) => {
        if (e.explore) g.appendChild(s("rect", { x: X(r - 1), y: L.cy0, width: X(r) - X(r - 1), height: L.cy1 - L.cy0, fill: "var(--viz-warn-soft)" }));
      });
      for (let v = 0; v <= YMAX; v += 20) {
        g.appendChild(s("line", { x1: L.cx0, x2: L.cx1, y1: Y(v), y2: Y(v), stroke: "var(--viz-grid)" }));
        g.appendChild(ctx.text(L.cx0 - 6, Y(v), v + "%", { ...muted, anchor: "end" }));
      }
      for (let r = 0; r <= xmax; r += 10) g.appendChild(ctx.text(X(r), L.cy1 + 14, String(r), muted));
      g.appendChild(ctx.text(L.cx0 - 6, L.cy1 + 14, "round", { ...muted, anchor: "end" }));
      if (last === 0) {
        g.appendChild(ctx.text((L.cx0 + L.cx1) / 2, Y(70), compact ? "each round adds a point" : "each round you play adds a point here", { ...muted, halo: true }));
      }
      if (firstExplore > 0) {
        g.appendChild(ctx.text(X(firstExplore - 1) + 3, L.cy0 + 9, "exploring", { size: L.fs, weight: 600, anchor: "start", fill: "var(--viz-warn)", halo: true }));
      }

      const pts = gi => hist.map((e, r) => [X(r), Y(e.appr[gi])]);
      const p1 = pts(0), p2 = pts(1);
      const poly = p => p.map(([x, y]) => x.toFixed(1) + "," + y.toFixed(1)).join(" ");
      if (last > 0) g.appendChild(s("polygon", { points: poly(p1.concat(p2.slice().reverse())), fill: "var(--viz-grid)", opacity: 0.45 }));
      [p1, p2].forEach((p, gi) => {
        const c = GROUPS[gi].c;
        g.appendChild(s("polyline", { points: poly(p), fill: "none", stroke: c, "stroke-width": 2.5, "stroke-linejoin": "round" }));
        p.forEach(([x, y]) => g.appendChild(s("circle", { cx: x, cy: y, r: compact ? 2.5 : 3, fill: c, stroke: "var(--viz-bg)", "stroke-width": 1 })));
      });
      // End labels, pushed apart when the two lines end close together.
      let y1 = p1[last][1], y2 = p2[last][1];
      const minGap = L.fs + 3;
      if (Math.abs(y1 - y2) < minGap) {
        const mid = (y1 + y2) / 2, up = y1 <= y2 ? -1 : 1;
        y1 = mid + (up * minGap) / 2; y2 = mid - (up * minGap) / 2;
      }
      [y1, y2].forEach((y, gi) => g.appendChild(ctx.text(X(last) + 8, y, `${GROUPS[gi].id} ${hist[last].appr[gi]}%`, {
        size: L.fs, weight: 700, anchor: "start", fill: GROUPS[gi].c, halo: true,
      })));
    }

    // ---------------- legend, stats, note ----------------
    function swatch(draw) {
      const v = s("svg", { width: 16, height: 16, viewBox: "-8 -8 16 16", "aria-hidden": "true", style: "flex-shrink:0" });
      draw(v);
      return v;
    }
    const legendItem = (draw, label) => h("span", { class: "viz-legend-item" }, swatch(draw), label);
    const dotSw = (fill, stroke) => v => v.appendChild(s("circle", { r: 4.5, fill, stroke, "stroke-width": 1.5 }));

    function buildLegend(hiddenToggle) {
      hiddenToggle.style.fontSize = "12.5px";
      const hiddenItems = h("span", { style: "display:inline-flex;flex-wrap:wrap;gap:6px 14px" },
        legendItem(v => v.appendChild(s("line", { x1: 0, x2: 0, y1: -6, y2: 6, stroke: "var(--viz-bad)", "stroke-width": 2.2, "stroke-linecap": "round" })),
          "qualified but denied"),
        legendItem(v => v.appendChild(s("path", { d: "M-5,-4L5,-4L0,4Z", fill: "var(--viz-bad)" })),
          "pushed below the bar by denial"));
      return h("div", null,
        h("div", { class: "viz-legend" },
          legendItem(dotSw("var(--viz-c2)", "none"), "G1 approved"),
          legendItem(dotSw("var(--viz-c5)", "none"), "G2 approved"),
          legendItem(dotSw("none", "var(--viz-muted)"), "denied"),
          legendItem(v => { dotSw("var(--viz-muted)", "none")(v); v.appendChild(s("circle", { r: 6.6, fill: "none", stroke: "var(--viz-warn)", "stroke-width": 2 })); },
            "approved by exploration (last round)")),
        h("div", { class: "viz-legend", style: "align-items:center" }, hiddenToggle, hiddenItems));
    }

    const pct = v => (v === null ? "–" : (compact ? Math.round(v) : v.toFixed(1)) + "%");
    const f1 = v => v.toFixed(1);
    const sub = text => `<div style="font-size:11.5px;font-weight:600;color:var(--text-muted);margin-top:2px">${text}</div>`;
    const val = (main, note) => `<span style="font-size:18px">${main}</span>${sub(note)}`;

    function updateStats(m) {
      const [a, b] = m, st = view.stats, r = sim.round, gapNow = a.appr - b.appr;
      st.set("round", val(r, `max ${MAX_ROUNDS}`), r >= MAX_ROUNDS ? "warn" : "");
      st.set("appr", val(`${a.appr}% / ${b.appr}%`, `gap ${gapNow} pts`),
        Math.abs(gapNow) > 25 ? "bad" : Math.abs(gapNow) > 10 ? "warn" : Math.abs(gapNow) <= 5 ? "ok" : "");
      st.set("ability", val(`${f1(a.ability)} / ${f1(b.ability)}`, `both started at ${f1(a.start)}`),
        Math.abs(a.ability - b.ability) > 1 ? "bad" : "");
      st.set("qd", val(`${a.qd} / ${b.qd}`, "invisible to lender"), "info");
      st.set("pushed", val(`${a.pushed} / ${b.pushed}`, "creditworthy at round 0, not now"),
        a.pushed + b.pushed > 0 ? "bad" : r > 0 ? "ok" : "");
      st.set("repaid", val(`${pct(a.rate)} / ${pct(b.rate)}`, "the lender's own data"), r > 0 ? "ok" : "");
    }

    const para = html => `<div style="margin-top:6px">${html}</div>`;
    const noLonger = n => (n === 1 ? "<b>1</b> member of G2 who was creditworthy at round 0 no longer is"
      : `<b>${n}</b> members of G2 who were creditworthy at round 0 no longer are`);

    function noteFor(m) {
      const [a, b] = m, r = sim.round;
      const limit = r >= MAX_ROUNDS ? para(`That's the ${MAX_ROUNDS}-round limit: press <b>Reset</b> to try other settings.`) : "";
      if (r === 0) {
        const start = gap === 0
          ? "Both groups have exactly the same true ability, and with no starting gap their scores differ only by noise."
          : `Both groups have exactly the same true ability. G2 starts <b>${gap} points</b> lower only because thin credit files score worse.`;
        let html = `${start} At a threshold of ${threshold}, <b>${a.appr}%</b> of G1 and <b>${b.appr}%</b> of G2 get loans. ` +
          "Press <b>Run 10 rounds</b> to see what the lender learns.";
        if (explore) html += " Exploration is on: each round, 15% of rejected applicants get a loan anyway.";
        return [html, "info"];
      }
      if (gap === 0) {
        return [`With no starting gap, both groups evolve alike (<b>${a.appr}%</b> vs <b>${b.appr}%</b> approved after ${r} rounds): ` +
          "the disparity came entirely from the biased starting point, not from ability." + limit, "ok"];
      }
      const first = sim.hist.findIndex(e => e.explore);
      if (explore && first > 0) {
        const x = sim.hist[first - 1].appr[1];
        let html = `Random approvals let some denied applicants prove themselves: G2 approval ${b.appr > x ? "rose" : "went"} ` +
          `from <b>${x}%</b> to <b>${b.appr}%</b>. Exploration costs some bad loans (repaid G1 / G2: ${pct(a.rate)} / ${pct(b.rate)}) ` +
          "but is the only way to learn what a <i>no</i> would have cost.";
        if (harm && b.pushed > 0) {
          html += ` It can't undo harm already done: ${noLonger(b.pushed)}.`;
        }
        return [html + limit, "ok"];
      }
      let html = `Round ${r}: the approval gap is still <b>${a.appr - b.appr} points</b>. Approved borrowers' scores move toward ` +
        "their true ability, but denied applicants never get the chance to show theirs.";
      html += b.rate === null
        ? " Nobody in G2 has been approved yet, so the lender has no G2 repayment data at all: nothing it records can show that the no was wrong."
        : a.rate !== null && b.rate >= a.rate + 0.5
          ? ` G2's approved borrowers even repay more often (<b>${pct(b.rate)}</b> vs ${pct(a.rate)}): a sign G2 faces a stricter ` +
            "effective bar, yet a lender watching default rates reads it as \"the model works\"."
          : ` G2's approved borrowers repay about as often as G1's (${pct(b.rate)} vs ${pct(a.rate)}), so the lender's own data shows nothing wrong.`;
      if (explore) html += " Exploration starts with the next round.";
      if (harm && b.pushed > 0) {
        html += para(`Denial also made people poorer: ${noLonger(b.pushed)} ` +
          `(G1: ${a.pushed}), and G2 averages <b>${f1(b.ability)}</b> vs ${f1(a.ability)} for G1 although both started at ${f1(a.start)}. ` +
          "<b>The model's prediction is coming true.</b>");
        return [html + limit, "bad"];
      }
      if (!harm) {
        html += para(`Denial harms no one's finances here, so true abilities stay equal (${f1(a.ability)} / ${f1(b.ability)}), yet the gap persists: ` +
          "selective labels alone keep the bias alive. (Denied scores still slip 0.5 a round: with no new loans the file stays thin, " +
          "which the lender reads as risk. Only the score moves, never the person's real ability.)");
      }
      return [html + limit, "warn"];
    }

    function refresh() {
      const m = measure();
      const L = view.L, x = scoreX(threshold);
      ctx.attr(view.thr.line, { x1: x, x2: x });
      ctx.attr(view.thr.label, { x: clip(x, 70, L.W - 70) });
      view.thr.label.textContent = compact ? `≥ ${threshold}` : `approve if score ≥ ${threshold}`;
      view.rowLabels.forEach((t, gi) => { t.textContent = compact ? `${m[gi].appr}%` : `${m[gi].appr}% approved`; });
      drawChart();
      updateStats(m);
      view.note.set(...noteFor(m));
      const done = running || sim.round >= MAX_ROUNDS;
      view.nextBtn.disable(done);
      view.runBtn.disable(done);
    }

    // ---------------- actions ----------------
    function advance() {
      if (sim.round >= MAX_ROUNDS) return;
      stepRound(sim);
      placeDots(true);
      refresh();
    }

    async function runTen() {
      if (running) return;
      const my = epoch;
      running = true;
      refresh();
      for (let k = 0; k < 10 && sim.round < MAX_ROUNDS; k++) {
        advance();
        await ctx.sleep(300);
        if (my !== epoch) return;   // reset (or a slider) started a new run
      }
      running = false;
      refresh();
    }

    function reset() {
      epoch++;
      running = false;
      sim = newSim();
      placeDots(true);
      refresh();
    }

    sim = newSim();
    build();
    ctx.onResize(() => { if (ctx.compact !== compact) build(); });
  },
});
