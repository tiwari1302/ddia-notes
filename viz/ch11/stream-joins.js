// Stream joins on one swimlane timeline, in two modes.
//  Window join: searches x clicks by session ID (the book's click-through-rate example). The join
//    keeps both sides in state for the window; the window length decides what counts as a
//    click-through, and a late search stream without a click buffer throws correct clicks away.
//  Enrichment: sales x a local copy of a VAT-rate table kept current from its changelog. Joining
//    with the current version breaks on a late upload or a replay; joining with the version valid
//    at sale time fixes both, but every version must be kept, so the changelog cannot be compacted.
// Each mode is a pure function of its controls returning {lanes, axis, items, stats, note};
// draw() clears the lanes and redraws everything instantly.
(function () {
  "use strict";

  const sm = str => `<span style="font-size:12.5px;font-weight:600">${str}</span>`;
  const range = (a, b, step) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step);

  // ---------------------------------------------------------------- window join
  const SEARCH_T = [1, 13, 25, 37];                                          // event times (min); session i + 1
  const CLICKS = [{ k: 0, s: 0, t: 2 }, { k: 1, s: 2, t: 34 }, { k: 2, s: 3, t: 39 }]; // s = its search
  const CLICK_ROW = [-1, -1, 1];   // c3 and c4 can sit in the buffer together: separate sub-rows
  const LAG = 3;
  const inWindow = (st, ct, W) => st <= ct && ct <= st + W;
  const sName = i => "s" + (i + 1);
  const cName = c => "c" + (c.s + 1);

  // Discrete-event run over arrivals and expiries in time order (arrivals first at equal times).
  function runWindowJoin(W, lag, buffer) {
    const L = lag ? LAG : 0;
    const searches = SEARCH_T.map((t, i) => ({ i, t, a: t + L, end: t + L + W, matched: false }));
    const clicks = CLICKS.map(c => ({ ...c, a: c.t, end: c.t }));
    const queue = [], state = new Set(), buf = new Set(), out = [];
    const push = e => { queue.push(e); queue.sort((x, y) => x.t - y.t || x.pri - y.pri); };
    searches.forEach(s => { push({ t: s.a, pri: 0, s }); push({ t: s.end, pri: 1, s, expire: true }); });
    clicks.forEach(c => push({ t: c.a, pri: 0, c }));
    while (queue.length) {
      const { t, s, c, expire } = queue.shift();
      if (s && !expire) {                 // search arrives: keep it, and look for a buffered click
        state.add(s);
        const hit = buffer && [...buf].find(b => b.s === s.i && inWindow(s.t, b.t, W));
        if (hit) { buf.delete(hit); hit.end = t; s.matched = true; out.push({ t, kind: "match", s, by: "search" }); }
      } else if (s) {                     // search window over
        state.delete(s);
        if (!s.matched) out.push({ t, kind: "miss", s });
      } else if (!expire) {               // click arrives: look for its search
        const hit = [...state].find(x => x.i === c.s && inWindow(x.t, c.t, W));
        if (hit) { hit.matched = true; out.push({ t, kind: "match", s: hit, by: "click" }); }
        else if (buffer) { buf.add(c); push({ t: t + W, pri: 1, c, expire: true }); }
        else out.push({ t, kind: "orphan", c, by: "click" });
      } else if (buf.has(c)) {            // buffered click expires unmatched
        buf.delete(c); c.end = t; out.push({ t, kind: "orphan", c, by: "buffer" });
      }
    }
    // Truth: the match condition on event times, whatever order things arrived in.
    const truly = i => CLICKS.some(x => x.s === i && inWindow(SEARCH_T[i], x.t, W));
    out.forEach(o => {
      o.wrong = o.kind === "miss" ? truly(o.s.i) : o.kind === "orphan" && inWindow(SEARCH_T[o.c.s], o.c.t, W);
    });
    return { L, searches, clicks, out, truth: SEARCH_T.filter((_, i) => truly(i)).length };
  }

  function windowView(W, lag, buffer, compact) {
    const r = runWindowJoin(W, lag, buffer);
    const row = i => (i % 2 ? 1 : -1);   // s1, s3 above; s2, s4 below: 12 min apart, so no overlap for W <= 16
    const items = [];
    r.searches.forEach(s => {
      if (r.L) items.push({ kind: "hollow", lane: "search", t: s.t },
        { kind: "op", lane: "search", ta: s.t, tb: s.a, tone: "warn", dashed: true, height: 8 });
      items.push({ kind: "mark", lane: "search", t: s.a, label: sName(s.i), color: "c2" },
        { kind: "bar", lane: "sstate", ta: s.a, tb: s.end, row: row(s.i), fill: "c2", stroke: s.matched ? "ok" : "muted", label: sName(s.i) });
    });
    r.clicks.forEach(c => {
      items.push({ kind: "mark", lane: "click", t: c.a, label: cName(c), color: "c1" });
      if (c.end > c.a) items.push({ kind: "bar", lane: "cbuf", ta: c.a, tb: c.end, row: CLICK_ROW[c.k], fill: "c1", stroke: "c1", label: cName(c) });
    });
    if (!buffer) items.push({ kind: "text", lane: "cbuf", ta: 0, tb: 60, color: "muted", text: compact ? "off" : "buffering off" });
    r.out.forEach(o => {
      const tone = o.wrong ? "bad" : { match: "ok", miss: "info", orphan: "warn" }[o.kind];
      const label = o.kind === "orphan" ? "?" + cName(o.c) : (o.kind === "match" ? "✓" : "✗") + sName(o.s.i);
      // Each output hangs from its cause: the arrival that matched, or the state that expired.
      const cause = o.kind === "miss" ? { from: "sstate", row: row(o.s.i) }
        : o.by === "buffer" ? { from: "cbuf", row: CLICK_ROW[o.c.k] } : { from: o.by };
      items.push({ kind: "out", lane: "out", t: o.t, label, tone, dashed: o.kind !== "match", ...cause });
    });

    const matched = r.out.filter(o => o.kind === "match").length;
    const wrong = r.out.filter(o => o.wrong).length;
    const held = r.searches.length * W + r.clicks.reduce((sum, c) => sum + c.end - c.a, 0);
    const ctr = n => `${n}/4 ${sm("= " + n * 25 + "%")}`;
    const pct = n => n * 25 + "%";
    let note;
    if (lag && !buffer) {
      const lost = r.out.filter(o => o.kind === "orphan" && o.wrong).map(o => sName(o.c.s)).join(" and ");
      note = [`The searches arrive <b>3 minutes late</b>, so the clicks for ${lost} reached the join first, found nothing, and were thrown away; later both searches expired as "not clicked". <b>CTR ${pct(matched)} instead of ${pct(r.truth)}.</b> Two streams are never ordered relative to each other, so a stream-stream join must buffer <b>both</b> sides.`, "bad"];
    } else if (lag) {
      note = ["The clicks for s1 and s4 arrived <b>before</b> their searches. Because the join buffers clicks too, each match was made when the search finally arrived. Both sides need state.", "ok"];
    } else if (W >= 10) {
      note = [`With a ${W}-minute window, s3's click 9 minutes after its search counts as a click-through: <b>CTR 75%</b>. The window is a business definition, and also a memory bill: at 10,000 searches/s, a ${W}-minute window keeps <b>${(10000 * 60 * W).toLocaleString("en-US")}</b> searches in state.`, "info"];
    } else {
      note = [`s1 and s4 were matched the moment their clicks arrived. s2 was never clicked, and the join can only say so because it <b>kept s2 until its window expired</b>. s3's click came 9 minutes after its search, outside the ${W}-minute window, so it is an orphan` +
        (buffer ? ` (held in the click buffer until ${34 + W}, in case its search was still on the way).`
          : ". Buffering clicks changes nothing while searches always arrive first; add the 3-minute lag to see why it matters."), "info"];
    }
    const ticks = range(0, 60, 10);
    return {
      t1: 60,
      lanes: [
        { id: "search", label: "Searches", short: "Search", color: "c2" },
        { id: "click", label: "Clicks", short: "Click", color: "c1" },
        { id: "sstate", label: "Search state", short: "Search\nstate", color: "c2" },
        { id: "cbuf", label: "Click buffer", short: "Click\nbuffer", color: "c1" },
        { id: "out", label: "Output", short: "Output", color: "muted" },
      ],
      axis: { ticks, labels: ticks.map(t => [t, String(t), 0]), unit: compact ? "min" : "minutes" },
      items,
      stats: [
        ["ctr", "CTR computed", ctr(matched), matched === r.truth ? "ok" : "bad"],
        ["truth", "CTR by definition", ctr(r.truth), "info"],
        ["wrong", "Wrong outputs", String(wrong), wrong ? "bad" : "ok"],
        ["held", "State held", `${held} ${sm("event·min")}`, "info"],
      ],
      note,
    };
  }

  // ---------------------------------------------------------------- enrichment (stream-table)
  const SALES = [   // t in days from Jun 28 00:00; lateA = arrival when uploaded 2 days late
    { n: 1, t: 0.5, day: "Jun 28" },
    { n: 2, t: 2.83, day: "Jun 30", lateA: 4.83, lateDay: "Jul 2" },
    { n: 3, t: 3.62, day: "Jul 1" },
    { n: 4, t: 5.42, day: "Jul 3" },
  ];
  const V2_AT = 3;   // Jul 1 00:00: 16% takes effect, and its changelog event arrives
  const rateAt = t => (t < V2_AT ? 19 : 16);   // the version in force at time t
  const DAYS = ["Jun 28", "Jun 29", "Jun 30", "Jul 1", "Jul 2", "Jul 3", "Jul 4"];

  function tableView(join, late, replay, compact) {
    const asof = join === "asof";
    const rows = SALES.map(x => {
      const a = late && x.lateA ? x.lateA : x.t, correct = rateAt(x.t);
      // Current rate = the newest version whose changelog event had arrived when the sale did.
      const live = asof ? correct : a > V2_AT ? 16 : 19;
      // January replay: a compacted changelog holds only the latest version (19% from Jan 1).
      const again = asof ? correct : 19;
      return { ...x, a, correct, live, again };
    });
    const items = [
      { kind: "op", lane: "table", ta: 0, tb: V2_AT, tone: "c2", label: "v1 19%" },
      { kind: "op", lane: "table", ta: V2_AT, tb: 7, tone: "c2", label: asof ? (compact ? "v1+v2" : "v1 19% + v2 16%") : "v2 16%" },
      { kind: "link", from: "rates", to: "table", t: V2_AT, color: "c1", dashed: true },
      { kind: "mark", lane: "rates", t: V2_AT, label: "v2: 16%", color: "c1" },
    ];
    // The replay runs after the next change, which the live timeline never reaches.
    if (replay) items.push({ kind: "text", lane: "rates", ta: 4.2, tb: 7, dy: -11, color: "c1", text: compact ? "v3 19%, Jan 1 →" : "v3 19% from Jan 1 (replay) →" });
    rows.forEach(r => {
      const ok = r.live === r.correct;
      if (r.a !== r.t) {
        items.push({ kind: "hollow", lane: "sales", t: r.t },
          { kind: "op", lane: "sales", ta: r.t, tb: r.a, tone: "warn", dashed: true, height: 8 });
        if (!compact) items.push({ kind: "text", lane: "sales", ta: r.t, tb: r.a, dy: 15, text: "upload delay", color: "warn" });
        // A temporal join reaches back to the version valid at the sale's own time.
        if (asof) items.push({ kind: "back", lane: "table", ta: r.a, tb: r.t, color: "ok" });
      }
      items.push({ kind: "mark", lane: "sales", t: r.a, label: "#" + r.n, color: "c6" },
        { kind: "out", lane: "inv", t: r.a, from: "sales", label: r.live + "%" + (ok ? "" : " ✗"), tone: ok ? "ok" : "bad" });
    });

    const liveOk = rows.filter(r => r.live === r.correct).length;
    const againOk = rows.filter(r => r.again === r.correct).length;
    const same = rows.every(r => r.again === r.live);
    let note;
    if (asof) note = ["Each sale is joined with the rate <b>in force at its sale time</b>, so the late upload and the January replay both give the right answer. The price: every version of the rate must be kept, so the rate changelog can <b>no longer be compacted</b>. This is the slowly changing dimension fix (version IDs, or a temporal join).", "ok"];
    else if (replay) note = [`Replaying the same four sales in January joins them with January's 19%: #3 and #4 are now wrong${late ? " (and #2 is accidentally right)" : ""}. <b>Same code, same input, different output</b>: the join is nondeterministic.`, "bad"];
    else if (late) note = ["Sale #2 was made on <b>Jun 30</b>, when the rate was 19%, but its upload arrived on Jul 2, after the rate change, so the join used the <b>current 16%</b>. Whether #2 is right depends only on which stream was processed first.", "bad"];
    else note = ["Every sale was processed before the rate changed again, so the current rate happened to be the rate at sale time. Turn on the late upload, or replay in January, to see how fragile that is.", "warn"];

    const labels = compact
      ? DAYS.map((d, i) => [i + 0.5, d.slice(4), 0]).concat([[0.5, "Jun", 1], [3.5, "Jul", 1]])
      : DAYS.map((d, i) => [i + 0.5, d, 0]);
    return {
      t1: 7,
      lanes: [
        { id: "rates", label: "Rate changes", short: "Rate\nchanges", color: "c1" },
        { id: "sales", label: "Sales", short: "Sales", color: "c6" },
        { id: "table", label: "Local table", short: "Local\ntable", color: "c2" },
        { id: "inv", label: "Invoices", short: "Invoice", color: "muted" },
      ],
      axis: { ticks: range(0, 7, 1), labels },
      items, rows,
      stats: [
        ["live", "Correct live", `${liveOk}/4`, liveOk < 4 ? "bad" : "ok"],
        ["replay", "Correct on replay", replay ? `${againOk}/4` : "—", replay ? (againOk < 4 ? "bad" : "ok") : ""],
        ["same", "Replay = live?", replay ? (same ? "yes" : "no") : "—", replay ? (same ? "ok" : "bad") : ""],
        ["versions", "Rate versions kept", asof ? String(replay ? 3 : 2) : `1 ${sm("(compactable)")}`, asof ? "warn" : "info"],
      ],
      note,
    };
  }

  // ---------------------------------------------------------------- layout helpers
  const col = c => `var(--viz-${c})`;
  const gap = ([a, b], x0, x1) => Math.max(a - x1, x0 - b);   // < 0 when [x0, x1] overlaps [a, b]

  // Centre x for a label of width w inside [x0, x1], kept clear of the obstacle intervals;
  // prefers the middle when several spots are clear enough. null when it does not fit.
  function spot(x0, x1, w, obstacles) {
    const lo = x0 + w / 2 + 3, hi = x1 - w / 2 - 3;
    if (lo > hi) return null;
    let best = null, score = -Infinity;
    for (let k = 0; k <= 20; k++) {
      const c = (lo + hi) / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (hi - lo) / 20;
      const clear = Math.min(8, ...obstacles.map(o => gap(o, c - w / 2, c + w / 2)));
      if (clear > score + 0.01) { score = clear; best = c; }
    }
    return best;
  }

  // Output labels, greedy in time order. First choice: centred below the dot (connectors arrive
  // from above); then above, where other outputs' connectors pass; then (phones) a second row
  // below with a leader line; then beside the dot, but never under another output's dot.
  const ROWS = [["below", 0], ["above", 0], ["below2", 0], ["below", 1], ["below", -1], ["above", 1], ["above", -1]];
  function placeOuts(outs, X, widthOf, xMin, xMax, row2) {
    const placed = [], xs = outs.map(o => X(o.t));
    const line = (lx, x0, x1) => (gap([lx, lx], x0, x1) < 2 ? 4 + Math.min(lx - x0, x1 - lx) : 0);
    outs.slice().sort((a, b) => a.t - b.t).forEach(o => {
      const x = X(o.t), w = widthOf(o.label);
      let best = null;
      for (const [row, dx] of ROWS) {
        if (row === "below2" && !row2) continue;
        const x0 = dx === 0 ? x - w / 2 : dx > 0 ? x + 6 : x - 6 - w, x1 = x0 + w;
        let cost = x0 < xMin || x1 > xMax ? 1000 : 0;
        placed.forEach(p => {
          if (p.row === row) cost += Math.max(0, 6 - gap([p.x0, p.x1], x0, x1));
          if (row === "below" && p.row === "below2") cost += line(p.x, x0, x1);      // its leader
          if (row === "below2" && p.row === "below") cost += line(x, p.x0, p.x1);    // my leader
        });
        if (row === "above") xs.forEach(lx => { if (lx !== x) cost += line(lx, x0, x1); });
        if (dx) cost += 1 + 8 * xs.filter(lx => lx !== x && gap([lx, lx], x0, x1) < 0).length;
        if (!best || cost < best.cost - 1e-9) best = { row, dx, x0, x1, x, cost };
        if (cost === 0) break;
      }
      placed.push(best);
      Object.assign(o, { place: best.row, dx: best.dx });
    });
  }

  const LEGENDS = {
    window: [
      { color: col("c2"), label: "search", shape: "dot" },
      { color: col("c1"), label: "click", shape: "dot" },
      { color: col("c2"), label: "search kept in state", shape: "square" },
      { color: col("c1"), label: "click buffered", shape: "square" },
      { color: col("warn"), label: "arrival delay (○ = event time)", shape: "dash" },
      { color: col("ok"), label: "✓ clicked", shape: "dot" },
      { color: col("info"), label: "✗ not clicked", shape: "dot" },
      { color: col("warn"), label: "? click outside the window", shape: "dot" },
      { color: col("bad"), label: "wrong output", shape: "dot" },
    ],
    table: [
      { color: col("c1"), label: "rate change (changelog)", shape: "dot" },
      { color: col("c6"), label: "sale", shape: "dot" },
      { color: col("c2"), label: "table version held", shape: "square" },
      { color: col("warn"), label: "upload delay (○ = sale time)", shape: "dash" },
      { color: col("ok"), label: "correct invoice", shape: "dot" },
      { color: col("bad"), label: "wrong invoice", shape: "dot" },
    ],
  };

  Viz.register("ch11/stream-joins", {
    title: "Stream joins: windows, tables and time",
    mount(root, ctx) {
      const { h, s, ui } = ctx;
      const DEF = { W: 8, lag: false, buffer: true, join: "latest", late: true, replay: false };
      const st = { mode: "window", ...DEF };
      let compact = ctx.compact, view = null, fadeId = 0, fading = false;
      const model = () => (st.mode === "window"
        ? windowView(st.W, st.lag, st.buffer, compact)
        : tableView(st.join, st.late, st.replay, compact));

      // Controls live for the whole mount (only the drawing is rebuilt), so values survive.
      const modeSeg = ui.segmented({
        label: "Join", value: st.mode, onChange: v => { st.mode = v; build(); },
        options: [{ value: "window", label: "Window join" }, { value: "table", label: "Enrichment" }],
      });
      const resetBtn = ui.button("Reset", reset, { kind: "ghost", title: "Restore the defaults of both modes" });
      const winSlider = ui.slider({
        label: "Window", min: 4, max: 16, step: 2, value: st.W, format: v => v + " min",
        onInput: v => { st.W = v; draw(); },
      });
      const lagToggle = ui.toggle({ label: "Searches arrive 3 min late", value: st.lag, onChange: v => { st.lag = v; draw(); } });
      const bufToggle = ui.toggle({ label: "Buffer clicks too", value: st.buffer, onChange: v => { st.buffer = v; draw(); } });
      const joinSeg = ui.segmented({
        label: "Join each sale with", value: st.join, onChange: v => { st.join = v; draw(); },
        options: [{ value: "latest", label: "Current rate" }, { value: "asof", label: "Rate at sale time" }],
      });
      const lateToggle = ui.toggle({ label: "Sale #2 uploaded 2 days late", value: st.late, onChange: v => { st.late = v; draw(); } });
      const replayBtn = ui.button("Replay in January", () => {
        st.replay = !st.replay;
        draw();
        if (st.replay) fadeIn(view.fadeCells);
      });
      const caption = text => h("div", { class: "muted", style: "font-size:12.5px;line-height:1.45;margin:-4px 0 10px" }, text);
      const windowBar = h("div", null, ui.bar(winSlider, lagToggle, bufToggle), caption(
        "Searches and clicks arrive on two streams; sN and cN share session N. A click counts as a click-through if it happens within the window after its search (event time)."));
      const tableBar = h("div", null, ui.bar(joinSeg, lateToggle, replayBtn), caption(
        "Hypothetical shop, modelled on Germany's 2020 VAT cut: each €100 sale is joined with the VAT rate from a local copy of the rates table, kept current from its changelog. The rate drops from 19% to 16% on Jul 1."));
      const svgSlot = h("div"), tableSlot = h("div"), statsSlot = h("div"), legendSlot = h("div");
      const note = ui.note("");
      root.append(ui.bar(modeSeg, resetBtn), windowBar, tableBar, svgSlot, tableSlot, statsSlot, note, legendSlot);

      function build() {
        cancelFade();
        compact = ctx.compact;
        const m = model();
        const W = compact ? 360 : 640, LW = compact ? 60 : 100, LH = compact ? 42 : 44, fs = compact ? 11 : 12;
        const lanesH = m.lanes.length * LH, axisY = lanesH + (compact ? 13 : 0);   // phones: 2nd label row
        const svg = ctx.svg({ w: W, h: axisY + 34, label: st.mode === "window"
          ? "Timeline of a stream-stream join of searches and clicks" : "Timeline of a stream-table join of sales with a tax-rate table" });
        const tl = ctx.lanes({
          parent: svg, x: 0, y: 0, w: W, h: lanesH, t0: 0, t1: m.t1, labelWidth: LW,
          lanes: m.lanes.map(l => ({ id: l.id, label: "", color: l.color })),
        });
        drawFrame(svg, tl, m, fs, lanesH, axisY);
        svgSlot.replaceChildren(svg);
        const stats = ui.stats(m.stats.map(([key, label]) => ({ key, label, value: "" })));
        statsSlot.replaceChildren(stats);
        legendSlot.replaceChildren(ui.legend(LEGENDS[st.mode]));
        windowBar.style.display = st.mode === "window" ? "" : "none";
        tableBar.style.display = st.mode === "table" ? "" : "none";
        const idx = Object.fromEntries(m.lanes.map((l, i) => [l.id, i]));
        view = { svg, tl, stats, fs, idx, xMax: W - 2, fadeCells: [] };
        draw();
      }

      // Rendered label width (bold, plus the halo), so neighbouring labels never touch.
      const meter = h("canvas").getContext("2d");
      const measure = (str, size) => {
        meter.font = `600 ${size}px ${getComputedStyle(root).fontFamily || "sans-serif"}`;
        return meter.measureText(str).width + 3;
      };

      // Static parts: lane labels (two lines on phones), day/minute grid and the tick row.
      function drawFrame(svg, tl, m, fs, lanesH, axisY) {
        m.lanes.forEach(l => {
          const lines = (compact ? l.short : l.label).split("\n");
          lines.forEach((ln, i) => svg.appendChild(ctx.text(6, tl.y(l.id) + (i - (lines.length - 1) / 2) * 13, ln,
            { size: fs, anchor: "start", weight: 700, fill: col(l.color) })));
        });
        const grid = tl.root.firstChild, muted = { size: fs, fill: col("muted") };
        m.axis.ticks.forEach(t => {
          grid.appendChild(s("line", { x1: tl.x(t), x2: tl.x(t), y1: 2, y2: lanesH, stroke: col("line"), "stroke-dasharray": "2 4", opacity: 0.6 }));
          svg.appendChild(s("line", { x1: tl.x(t), x2: tl.x(t), y1: axisY, y2: axisY + 4, stroke: col("muted") }));
        });
        m.axis.labels.forEach(([t, str, row]) => svg.appendChild(ctx.text(tl.x(t), axisY + 15 + row * 13, str, muted)));
        if (m.axis.unit) svg.appendChild(ctx.text(6, axisY + 15, m.axis.unit, { ...muted, anchor: "start" }));
      }

      function draw() {
        cancelFade();
        const m = model();
        view.tl.clear();
        drawItems(m.items);
        m.stats.forEach(([key, , value, tone]) => view.stats.set(key, value, tone));
        note.set(...m.note);
        replayBtn.setLabel(st.replay ? "Hide replay" : "Replay in January").setActive(st.replay);
        view.fadeCells = [];
        tableSlot.replaceChildren(...(m.rows ? [resultsTable(m.rows, st.replay)] : []));
      }

      function drawItems(items) {
        const { tl, svg, fs, idx } = view, X = tl.x, Y = tl.y, add = el => tl.content.appendChild(el);
        const outs = items.filter(it => it.kind === "out"), nudge = 5 / (X(1) - X(0));
        // Two outputs at the same instant (W = 6 with the lag): move them apart so both stay visible.
        outs.forEach((o, i) => outs.slice(0, i).forEach(p => { if (p.t === o.t) { p.t -= nudge; o.t += nudge; } }));
        placeOuts(outs, X, str => measure(str, fs), 2, view.xMax, compact);
        const all = items.flatMap(it => (it.kind !== "out" ? [it] : [
          { kind: "link", from: it.from, row: it.row, to: it.lane, t: it.t, color: it.tone, dashed: it.dashed, stopShort: it.place === "above" && !it.dx },
          { ...it, kind: "outmark" },
        ]));
        // What a label in a lane must keep clear of: connectors crossing it and back-arrows in it.
        const obstacles = lane => all.flatMap(it =>
          it.kind === "link" && idx[it.from] <= idx[lane] && idx[lane] <= idx[it.to] ? [[X(it.t), X(it.t)]]
            : it.kind === "back" && it.lane === lane ? [[X(it.tb), X(it.ta)]] : []);
        const startY = it => Y(it.from) + (it.row ? (it.row < 0 ? -2 : 14) : 7);
        const endY = it => Y(it.to) - (it.stopShort ? 23 : it.to === "table" ? 13 : 8);
        const txt = (x, y, str, size, o) => add(ctx.text(x, y, str, { size, weight: 600, ...o }));
        const label = (lane, x0, x1, y, str, size, o) => {
          const cx = spot(x0, x1, measure(str, size), obstacles(lane));
          if (cx !== null) txt(cx, y, str, size, o);
          return cx;
        };
        const DRAW = {
          op: it => {
            tl.op(it.lane, it.ta, it.tb, { tone: it.tone, dashed: it.dashed, height: it.height });
            if (it.label) label(it.lane, X(it.ta), X(it.tb), Y(it.lane), it.label, fs);
          },
          bar: it => {   // state held in one of two sub-rows of a lane
            const y = Y(it.lane) + (it.row < 0 ? -14 : 2), x = X(it.ta), w = Math.max(4, X(it.tb) - x);
            add(s("rect", { x, y, width: w, height: 12, rx: 3, fill: col("bg") }));
            add(s("rect", { x, y, width: w, height: 12, rx: 3, fill: col(it.fill + "-soft"), stroke: col(it.stroke), "stroke-width": 1.4 }));
            if (w >= 24 && label(it.lane, x, x + w, y + 6.5, it.label, 11) !== null) return;
            // Too short for its name: put it just right of the bar if nothing crosses there.
            const lw = measure(it.label, 11), x0 = x + w + 3;
            if (w < 24 && obstacles(it.lane).every(o => gap(o, x0, x0 + lw) > 1)) {
              txt(x0, y + 6.5, it.label, 11, { anchor: "start", fill: col(it.stroke) });
            }
          },
          link: it => add(ctx.arrow({ x1: X(it.t), y1: startY(it), x2: X(it.t), y2: endY(it), color: col(it.color), dashed: it.dashed, width: 1.5, svg })),
          back: it => add(ctx.arrow({ x1: X(it.ta), y1: Y(it.lane) + 5, x2: X(it.tb) + 3, y2: Y(it.lane) + 5, color: col(it.color), dashed: true, width: 1.5, svg })),
          hollow: it => add(s("circle", { cx: X(it.t), cy: Y(it.lane), r: 4, fill: col("bg"), stroke: col("muted"), "stroke-width": 1.5 })),
          mark: it => tl.mark(it.lane, it.t, { label: it.label, color: it.color, size: fs }),
          outmark: it => {
            tl.mark(it.lane, it.t, { color: it.tone });
            const x = X(it.t) + it.dx * 6, anchor = it.dx ? (it.dx > 0 ? "start" : "end") : "middle";
            const y = Y(it.lane) + { below: 16, above: -14, below2: 29 }[it.place];
            if (it.place === "below2") add(s("line", { x1: x, x2: x, y1: Y(it.lane) + 7, y2: y - 7, stroke: col(it.tone), opacity: 0.7 }));
            txt(x, y, it.label, fs, { fill: col(it.tone), halo: true, anchor });
          },
          text: it => {
            const y = Y(it.lane) + (it.dy || 0), o = { fill: col(it.color), halo: true };
            if (label(it.lane, X(it.ta), X(it.tb), y, it.text, 11, o) === null) txt((X(it.ta) + X(it.tb)) / 2, y, it.text, 11, o);
          },
        };
        const layer = { op: 0, bar: 0, link: 1, back: 1, hollow: 2, mark: 2, outmark: 2, text: 3 };
        all.sort((a, b) => layer[a.kind] - layer[b.kind]).forEach(it => DRAW[it.kind](it));
      }

      function resultsTable(rows, replay) {
        const pad = "padding:4px 6px;";
        const td = (html, extra) => h("td", { html, style: pad + "border-top:1px solid var(--viz-line);" + (extra || "") });
        const rate = (v, ok) => `<span style="color:var(--viz-${ok ? "ok" : "bad"});font-weight:700">${v}% ${ok ? "✓" : "✗"}</span>`;
        const head = h("tr", null, ...["Sale", "Sold", "Correct", "Live", "Replay (Jan)"].map(t =>
          h("th", { style: pad + "text-align:left;font-size:11px;font-weight:700;color:var(--viz-muted)" }, t)));
        const body = rows.map(r => {
          const again = td(replay ? rate(r.again, r.again === r.correct) : '<span style="color:var(--viz-muted)">—</span>');
          if (replay) view.fadeCells.push(again);
          const sold = r.day + (r.a !== r.t ? `<div style="font-size:11px;color:var(--viz-warn)">uploaded ${r.lateDay}</div>` : "");
          return h("tr", null, td("#" + r.n, "font-weight:700"), td(sold), td(r.correct + "%"), td(rate(r.live, r.live === r.correct)), again);
        });
        return h("table", { style: "width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;margin:2px 0 4px" },
          h("thead", null, head), h("tbody", null, ...body));
      }

      async function fadeIn(cells) {
        const my = ++fadeId;
        fading = true;
        cells.forEach(c => { c.style.opacity = "0"; });
        await ctx.tween({ ms: 600, ease: "out", onUpdate: k => cells.forEach(c => { c.style.opacity = String(k); }) });
        if (my === fadeId) fading = false;
      }
      // The toolkit has no per-tween cancel: a momentary ctx.instant flushes the fade to its end.
      function cancelFade() {
        if (!fading) return;
        fading = false;
        fadeId++;
        ctx.instant = true;
        ctx.instant = false;
      }

      function reset() {
        Object.assign(st, DEF);
        winSlider.set(st.W); lagToggle.set(st.lag); bufToggle.set(st.buffer);
        joinSeg.set(st.join); lateToggle.set(st.late);
        draw();
      }

      build();
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
