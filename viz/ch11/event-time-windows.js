// Event time vs processing time (DDIA ch11, "Reasoning about time"). A mobile app's orders are
// counted per minute. Counting by arrival (processing time) puts delayed orders in the wrong
// minute. Counting by event time is right, but the processor never knows when a minute is
// complete: a heuristic watermark (newest event time seen minus a delay) decides when to emit,
// and stragglers that arrive after their window fired are dropped or force a correction.
(function () {
  "use strict";

  // Seconds of processing time / event time. Seed 11 gives no late ordinary orders at a 0 s delay;
  // 12 is the smallest seed above it that does (order n39), which the zero-delay note relies on.
  const END = 420, SPAN = 360, SEED = 12;
  const STRAGGLERS = [[75, 110], [170, 90], [230, 90]];   // [event time, delay]
  const BURST = [130, 140, 150, 160, 205, 215], BURST_AT = 330;

  /** 48 orders spread over 6 minutes with 2-18 s delays, 3 stragglers, and an optional offline burst. */
  function makeEvents(random, burst) {
    const rnd = random(SEED), ev = [];
    for (let i = 0; i < 48; i++) {
      const et = i * 7.5 + rnd() * 7.5;
      ev.push({ id: "n" + i, et, at: et + 2 + Math.min(16, rnd.exp(4)), kind: "normal" });
    }
    STRAGGLERS.forEach(([et, d], k) => ev.push({ id: "s" + (k + 1), et, at: et + d, kind: "straggler" }));
    if (burst) BURST.forEach((et, k) => ev.push({ id: "b" + k, et, at: BURST_AT, kind: "burst", slot: k }));
    return ev;
  }

  /** cfg = {mode: "event"|"proc", delay, late: "drop"|"update", hop}. Windows start every minute. */
  function windowsFor(cfg) {
    const len = cfg.hop ? 120 : 60, span = cfg.mode === "event" ? SPAN : END, out = [];
    for (let s = 0; s + len <= span; s += 60) out.push({ s, e: s + len, row: cfg.hop ? (s / 60) % 2 : 0 });
    return out;
  }

  /** Everything the processor has emitted by processing time pt (pure). */
  function evaluate(events, cfg, pt) {
    const byEvent = cfg.mode === "event", update = cfg.late === "update";
    // The watermark after each arrival: newest event time seen so far minus the delay.
    const marks = [];
    let maxEt = -Infinity, watermark = null;
    events.slice().sort((a, b) => a.at - b.at).forEach(e => {
      maxEt = Math.max(maxEt, e.et);
      marks.push({ at: e.at, wm: maxEt - cfg.delay });
    });
    marks.forEach(m => { if (m.at <= pt) watermark = m.wm; });
    const inWin = (w, t) => t >= w.s && t < w.e;
    const lateIds = new Set();
    const windows = windowsFor(cfg).map(w => {
      const truth = events.filter(e => inWin(w, e.et)).length;
      const arrived = events.filter(e => inWin(w, byEvent ? e.et : e.at) && e.at <= pt);
      // A window that the watermark never passes is flushed when the bounded input ends.
      const fire = byEvent ? marks.find(m => m.wm >= w.e) : { at: w.e };
      const r = { ...w, truth, flushed: !fire, fireAt: fire ? fire.at : END, late: [], state: "open" };
      r.emitted = pt >= r.fireAt;
      r.count = arrived.length;
      if (!r.emitted) return r;
      if (r.flushed) { r.state = "flushed"; return r; }
      r.late = arrived.filter(e => e.at > r.fireAt);
      r.late.forEach(e => lateIds.add(e.id));
      if (!update) r.count -= r.late.length;
      r.state = !r.late.length ? "fired" : update ? "updated" : "late";
      return r;
    });
    const emitted = windows.filter(w => w.emitted), fired = emitted.filter(w => !w.flushed);
    const trueSum = emitted.reduce((a, w) => a + w.truth, 0);
    const err = emitted.reduce((a, w) => a + Math.abs(w.count - w.truth), 0);
    return {
      windows, lateIds,
      watermark: byEvent ? watermark : null,
      emitted: emitted.length,
      dropped: byEvent && !update ? lateIds.size : 0,
      corrections: byEvent && update ? windows.reduce((a, w) => a + w.late.length, 0) : 0,
      avgDelay: fired.length ? fired.reduce((a, w) => a + w.fireAt - w.e, 0) / fired.length : null,
      accuracy: trueSum ? 100 * Math.max(0, 1 - err / trueSum) : null,
      flushed: emitted.filter(w => w.flushed).length,
      wrong: emitted.filter(w => w.count !== w.truth).length,
    };
  }

  const clock = t => { const v = Math.floor(t); return Math.floor(v / 60) + ":" + String(v % 60).padStart(2, "0"); };
  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
  const css = (el, props) => { for (const k in props) el.style.setProperty(k, props[k]); return el; };
  const show = (on, ...els) => els.forEach(el => el && (el.style.display = on ? "" : "none"));

  function layout(compact, hop) {
    const L = compact
      ? { W: 360, x0: 30, xw: 316, tickY: 10, axisY: 22, evY: 50, arY: 112, winY: 150, winH: 44, row2: 202, r: 3.5, fs: 11, countFs: 12 }
      : { W: 640, x0: 44, xw: 580, tickY: 12, axisY: 24, evY: 52, arY: 112, winY: 150, winH: 40, row2: 198, r: 4, fs: 12, countFs: 14 };
    L.x = t => L.x0 + (t / END) * L.xw;
    L.winBottom = (hop ? L.row2 : L.winY) + L.winH;
    L.H = L.winBottom + 8;
    L.textW = str => str.length * L.fs * 0.56;
    return L;
  }

  Viz.register("ch11/event-time-windows", {
    title: "Event time, watermarks and late events",
    model: { makeEvents, windowsFor, evaluate },   // exposed for offline tests
    mount(root, ctx) {
      const { s, ui } = ctx;
      // Settings live outside build() so the phone <-> desktop rebuild keeps them.
      const cfg = { mode: "event", delay: 20, late: "drop", hop: false };
      let burst = false, events = makeEvents(ctx.random, false);
      let gen = 0, playing = false, pausedAt = null, nowPt = END;
      let compact = ctx.compact, L = null, v = null;

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const seg = (label, options, key) => ui.segmented({
          label, options: options.map(([value, text]) => ({ value, label: text })), value: cfg[key],
          onChange: x => { cfg[key] = x; changed(); },
        });
        const modeCtl = seg("Count by", [["event", "Event time"], ["proc", "Processing time"]], "mode");
        const delayCtl = ui.slider({
          label: "Watermark delay", min: 0, max: 120, step: 5, value: cfg.delay, format: x => x + " s",
          onInput: x => { cfg.delay = x; changed(); },
        });
        if (compact) delayCtl.input.style.flex = "1 1 80px";
        const lateCtl = seg("Late events", [["drop", "Drop"], ["update", "Update result"]], "late");
        const winCtl = seg("Window", [[false, "Tumbling 1 min"], [true, "Hopping 2 min"]], "hop");
        const burstBtn = ui.button("", () => { burst = !burst; events = makeEvents(ctx.random, burst); changed(); });
        const playBtn = ui.button("▶ Play", () => (playing ? pause() : play()), { kind: "primary" });
        const svg = ctx.svg({ w: 640, h: 200, label: "Orders on an event-time row and an arrival-time row, with the per-minute windows that count them" });
        const g = svg.appendChild(s("g"));
        // Drop and Update are exclusive, so one card shows dropped events or corrections.
        const stats = ui.stats([
          { key: "fired", label: "Windows emitted" },
          { key: "late", label: "Dropped events" },
          { key: "delay", label: "Avg result delay" },
          { key: "acc", label: "Accuracy" },
        ]);
        const note = ui.note("");
        root.append(ui.bar(modeCtl, winCtl, burstBtn, delayCtl, lateCtl, playBtn), svg, stats, note, legend());
        v = { svg, g, stats, note, delayCtl, lateCtl, burstBtn, playBtn, lateLabel: stats.children[1].firstChild };
        changed();
      }

      function legend() {
        const el = ui.legend([
          { color: "var(--viz-c6)", label: "order, 2–18 s delay" },
          { color: "var(--viz-c5)", label: "delayed / offline order" },
          { color: "var(--viz-bad)", label: "dropped (arrived after its window fired)" },
          { color: "var(--viz-warn)", label: "watermark", shape: "dash" },
          { color: "var(--viz-warn)", label: "open window", shape: "square" },
          { color: "var(--viz-ok)", label: "emitted, correct", shape: "square" },
          { color: "var(--viz-bad)", label: "emitted, wrong count", shape: "square" },
          { color: "var(--viz-info)", label: "corrected", shape: "square" },
        ]);
        // The dropped marker is a hollow ring, as drawn in the arrival row.
        css(el.children[2].firstChild, { background: "transparent", border: "2px solid var(--viz-bad)", "box-sizing": "border-box" });
        return el;
      }

      // Any setting change cancels Play and shows the final state for the new settings.
      function changed() {
        gen++;
        playing = false;
        pausedAt = null;
        const byEvent = cfg.mode === "event";
        [v.delayCtl, v.lateCtl].forEach(el => {
          el.querySelectorAll("input, button").forEach(b => { b.disabled = !byEvent; });
          el.style.opacity = byEvent ? "" : "0.45";
        });
        v.burstBtn.setLabel(burst ? "Remove offline burst" : "Phone was offline").setActive(burst);
        v.playBtn.setLabel("▶ Play");
        scene();
        paint(END);
      }

      // Builds every SVG element for the current settings; paint() only restyles them.
      function scene() {
        L = layout(compact, cfg.hop);
        const byEvent = cfg.mode === "event", g = v.g;
        v.svg.setAttribute("viewBox", `0 0 ${L.W} ${L.H}`);
        g.innerHTML = "";
        const [grid, links, dots, fx, rects, clocks, labels] = Array.from({ length: 7 }, () => g.appendChild(s("g")));
        const muted = { size: L.fs, fill: "var(--viz-muted)" };
        for (let t = 0; t <= END; t += 60) {
          grid.appendChild(s("line", { x1: L.x(t), x2: L.x(t), y1: L.axisY, y2: L.winBottom + 4, stroke: "var(--viz-grid)" }));
          grid.appendChild(s("line", { x1: L.x(t), x2: L.x(t), y1: L.axisY, y2: L.axisY + 5, stroke: "var(--viz-muted)" }));
          grid.appendChild(ctx.text(L.x(t), L.tickY, clock(t), muted));
        }
        grid.appendChild(s("line", { x1: L.x(0), x2: L.x(END), y1: L.axisY, y2: L.axisY, stroke: "var(--viz-line)" }));
        // The row whose clock assigns orders to windows gets a band and a strong label. Labels sit
        // on the side of each row that the connecting lines don't cross.
        [[L.evY, -18, "happened (event time)", byEvent], [L.arY, 19, "arrived (processing time)", !byEvent]].forEach(([y, dy, label, on]) => {
          if (on) grid.appendChild(s("rect", { x: L.x0 - 8, y: y - 11, width: L.xw + 16, height: 22, rx: 6, fill: "var(--viz-grid)", opacity: 0.7 }));
          grid.appendChild(ctx.text(L.x0, y + dy, label + (on ? "  → windows" : ""), {
            size: L.fs, anchor: "start", weight: on ? 700 : 400, fill: on ? "var(--viz-ink)" : "var(--viz-muted)",
          }));
        });

        v.ev = events.map(e => {
          const col = e.kind === "normal" ? "var(--viz-c6)" : "var(--viz-c5)";
          const burstDx = e.kind === "burst" ? (e.slot % 2 ? 1 : -1) * (L.r + 0.6) : 0;
          const burstDy = e.kind === "burst" ? (Math.floor(e.slot / 2) - 1) * (2 * L.r + 1.5) : 0;
          const o = { e, col, xa: L.x(e.at) + burstDx, ya: L.arY + burstDy };
          o.link = links.appendChild(s("line", { x1: L.x(e.et), y1: L.evY, x2: o.xa, y2: o.ya }));
          css(o.link, { stroke: e.kind === "normal" ? "var(--viz-line)" : col, "stroke-width": e.kind === "normal" ? "1" : "1.2" });
          o.et = dots.appendChild(s("circle", { cx: L.x(e.et), cy: L.evY, r: L.r }));
          o.ar = dots.appendChild(s("circle", { cx: o.xa, cy: o.ya, r: L.r }));
          if (e.kind === "straggler" && !compact) {
            const k = 0.8;   // along the link, below the watermark label's track
            o.tag = labels.appendChild(ctx.text(L.x(e.et) + k * (o.xa - L.x(e.et)), L.evY + k * (L.arY - L.evY),
              "+" + Math.round(e.at - e.et) + " s", { size: L.fs, weight: 700, fill: col, halo: true }));
          }
          return o;
        });
        v.fx = fx;

        v.win = windowsFor(cfg).map(w => {
          const x = L.x(w.s) + 2, wd = L.x(w.e) - L.x(w.s) - 4, y = w.row ? L.row2 : L.winY;
          rects.appendChild(s("rect", { x, y, width: wd, height: L.winH, rx: 6, fill: "var(--viz-bg)" }));
          const rect = rects.appendChild(s("rect", { x, y, width: wd, height: L.winH, rx: 6, "stroke-width": 1.5 }));
          const cy = y + L.winH * 0.32, sy = y + L.winH * 0.74;
          const count = labels.appendChild(ctx.text(x + wd / 2, cy, "", { size: L.countFs, weight: 700 }));
          const truth = labels.appendChild(ctx.text(x + wd - 6, cy, "", { size: L.fs, weight: 700, anchor: "end", fill: "var(--viz-bad)" }));
          const state = labels.appendChild(ctx.text(x + wd / 2, sy, "", { size: L.fs }));
          return { x, wd, rect, count, truth, state };
        });

        const dash = { stroke: "var(--viz-warn)", "stroke-width": "1.5", "stroke-dasharray": "4 3" };
        v.wm = css(clocks.appendChild(s("line", { y1: L.evY - 14, y2: L.evY + 14 })), dash);
        v.wmExt = css(clocks.appendChild(s("line", { y1: L.winY - 5, y2: L.winBottom + 4 })), { ...dash, opacity: "0.8" });
        v.wmLabel = labels.appendChild(ctx.text(0, L.evY + 26, "", { size: L.fs, weight: 700, fill: "var(--viz-warn)", halo: true }));
        v.cursor = css(clocks.appendChild(s("line", { y1: L.arY - 14, y2: byEvent ? L.arY + 14 : L.winBottom + 4 })),
          { stroke: "var(--viz-ink)", "stroke-width": "1.5", opacity: "0.5" });
        v.nowLabel = labels.appendChild(ctx.text(0, L.arY, "", { size: L.fs, weight: 700, halo: true }));
      }

      function stateText(w, width) {
        const k = w.late.length;
        const opts = {
          open: ["open"],
          fired: ["fired " + clock(w.fireAt), "fired", "done"],
          late: [`−${k} late`, `−${k}`],
          updated: [`updated ×${k}`, `+${k} late`, `↻${k}`],
          flushed: ["flushed at end", "flushed", "end"],
        }[w.state];
        return opts.find(o => L.textW(o) + 8 <= width) || opts[opts.length - 1];
      }

      function flash(o, color, my) {
        const ring = v.fx.appendChild(s("circle", { cx: o.xa, cy: o.ya, r: L.r, fill: "none" }));
        css(ring, { stroke: color, "stroke-width": "2.5" });
        ctx.tween({ ms: 600, ease: "out", onUpdate: k => {
          if (my !== gen) { ring.remove(); return; }
          ctx.attr(ring, { r: L.r + 12 * k });
          ring.style.opacity = String(1 - k);
          if (k >= 1) ring.remove();
        } });
      }

      // Restyles the scene for processing time pt; prev (while playing) is the previous frame's pt.
      function paint(pt, prev) {
        nowPt = pt;
        const st = evaluate(events, cfg, pt), live = pt < END;
        const byEvent = cfg.mode === "event", update = cfg.late === "update";
        v.ev.forEach(o => {
          const arrived = o.e.at <= pt, late = st.lateIds.has(o.e.id);
          show(arrived, o.ar, o.link, o.tag);
          // Not yet arrived: a faint outline where the order belongs, which the processor can't see yet.
          css(o.et, arrived ? { fill: o.col, stroke: "var(--viz-bg)", "stroke-width": "1", "stroke-dasharray": "none", opacity: "1" }
            : { fill: "none", stroke: o.col, "stroke-width": "1.2", "stroke-dasharray": "2 1.6", opacity: "0.6" });
          css(o.ar, !late ? { fill: o.col, stroke: "var(--viz-bg)", "stroke-width": "1" }
            : update ? { fill: o.col, stroke: "var(--viz-info)", "stroke-width": "2" }
              : { fill: "var(--viz-bg)", stroke: "var(--viz-bad)", "stroke-width": "2" });
          if (late && prev !== undefined && o.e.at > prev) flash(o, update ? "var(--viz-info)" : "var(--viz-bad)", gen);
        });

        st.windows.forEach((w, i) => {
          const el = v.win[i], wrong = w.emitted && w.count !== w.truth, wide = el.wd >= 70;
          const tone = !w.emitted ? "warn" : wrong ? "bad" : w.state === "updated" ? "info" : "ok";
          css(el.rect, { fill: `var(--viz-${tone}-soft)`, stroke: `var(--viz-${tone})`, "stroke-dasharray": w.emitted ? "none" : "5 4" });
          const trueStr = "true " + w.truth;
          el.count.textContent = String(w.count);
          el.truth.textContent = wrong && wide ? trueStr : "";
          ctx.attr(el.count, { x: el.x + (wrong && wide ? (el.wd - L.textW(trueStr) - 6) / 2 : el.wd / 2) });
          el.state.textContent = wrong && !wide ? trueStr : stateText(w, el.wd);
          const sTone = wrong && !wide ? "bad" : w.state === "late" ? "bad" : w.state === "updated" ? "info" : "muted";
          css(el.state, { fill: `var(--viz-${sTone})`, "font-weight": sTone === "muted" ? "400" : "700" });
        });

        const wm = st.watermark, showWm = byEvent && wm !== null && wm >= 0;
        show(showWm, v.wm, v.wmLabel);
        show(showWm && live, v.wmExt);
        if (showWm) {
          const x = L.x(wm), label = "watermark " + clock(wm);
          [v.wm, v.wmExt].forEach(l => ctx.attr(l, { x1: x, x2: x }));
          const half = L.textW(label) / 2 + 2;
          v.wmLabel.textContent = label;
          ctx.attr(v.wmLabel, { x: Math.max(half, Math.min(L.W - half, x)) });
        }
        show(live, v.cursor, v.nowLabel);
        if (live) {
          // The label sits right of the cursor, where nothing has arrived yet; near the end it flips left.
          const x = L.x(pt), label = "now " + clock(pt), flip = x + 8 + L.textW(label) > L.W - 2;
          ctx.attr(v.cursor, { x1: x, x2: x });
          v.nowLabel.textContent = label;
          ctx.attr(v.nowLabel, { x: flip ? x - 8 : x + 8, "text-anchor": flip ? "end" : "start" });
        }
        paintStats(st);
        v.note.set(...(live ? liveNote(st, pt) : finalNote(st)));
      }

      function paintStats(st) {
        const byEvent = cfg.mode === "event", update = cfg.late === "update";
        v.stats.set("fired", `${st.emitted} of ${st.windows.length}`, "");
        v.lateLabel.textContent = !byEvent ? "Late events" : update ? "Corrections" : "Dropped events";
        if (!byEvent) v.stats.set("late", "—", "");
        else if (update) v.stats.set("late", st.corrections, st.corrections ? "info" : "ok");
        else v.stats.set("late", st.dropped, st.dropped ? "bad" : "ok");
        v.stats.set("delay", st.avgDelay === null ? "—" : Math.round(st.avgDelay) + " s", st.avgDelay >= 60 ? "warn" : "");
        const a = st.accuracy;
        v.stats.set("acc", a === null ? "—" : a.toFixed(1) + "%", a === null ? "" : a >= 99 ? "ok" : a >= 90 ? "warn" : "bad");
      }

      function liveNote(st, pt) {
        const head = (pausedAt !== null && !playing ? "Paused at processing time " : "Processing time ") + `<b>${clock(pt)}</b>. `;
        const emitted = ` ${st.emitted} of ${st.windows.length} windows emitted`;
        if (cfg.mode !== "event") return [head + "A window is emitted the moment the clock passes its end, counting whatever has arrived." + emitted + ".", ""];
        if (st.watermark === null) return [head + "Nothing has arrived yet, so there is no watermark.", ""];
        const late = st.lateIds.size, upd = cfg.late === "update";
        return [head + `Watermark <b>${clock(Math.max(0, st.watermark))}</b> = newest event time seen − ${cfg.delay} s; ` +
          "a window is emitted when the watermark passes its end." + emitted +
          (late ? `; ${plural(late, "late event")} ${upd ? "corrected" : "dropped"} so far.` : "."), ""];
      }

      function finalNote(st) {
        const d = cfg.delay, upd = cfg.late === "update", N = st.windows.length;
        const avg = Math.round(st.avgDelay || 0);
        const late = st.windows.flatMap(w => w.late).filter((e, i, a) => a.indexOf(e) === i);
        if (cfg.mode !== "event") {
          return ["Counting by processing time: results are instant, but every delayed order is counted in the minute it " +
            `<b>arrived</b>, not the minute it <b>happened</b>, so <b>${st.wrong} of ${N}</b> windows are wrong. ` +
            "Compare each window with its true count.", st.accuracy < 99 ? "bad" : "warn"];
        }
        if (burst) {
          const k = late.filter(e => e.kind === "burst").length;
          const head = "The phone buffered <b>6 orders</b> from 2:10 to 3:35 and uploaded them at <b>5:30</b>. ";
          if (upd) {
            return [head + `No sensible watermark waits that long, so <b>${k}</b> of them arrived after their window had fired, ` +
              "and Update re-emitted those windows with corrected counts.", "info"];
          }
          return [head + `<b>${k}</b> of them arrived after their window had fired and were dropped. ` +
            "No sensible watermark waits that long: drop them (and count them), or switch Late events to " +
            "<b>Update</b> and emit corrections.", k ? "bad" : "ok"];
        }
        const ordinary = late.filter(e => e.kind === "normal").length;
        if (d === 0 && ordinary) {
          return ["With zero delay the watermark races ahead of normal out-of-order arrivals: " +
            `<b>${plural(ordinary, "ordinary order")}</b> ${ordinary === 1 ? "was" : "were"} late, not just the stragglers. ` +
            "Some delay is always needed.", "bad"];
        }
        if (upd) {
          if (!late.length) return [`At a ${d} s delay nothing arrived late, so no emitted result had to change.`, "ok"];
          return [`<b>${plural(late.length, "late event")}</b> updated results that had already been emitted ` +
            `(${plural(st.corrections, "correction")}). Correct in the end, but every downstream consumer must handle a ` +
            "changed answer (an upsert or a retraction).", "info"];
        }
        const flushed = st.flushed === 1 ? " The last window only came out when the input ended."
          : st.flushed ? ` The last ${st.flushed} windows only came out when the input ended.` : "";
        if (d >= 100 && !st.dropped) {
          return [`With a ${d} s delay nothing was dropped, but each result arrived about <b>${avg} s</b> after its window ` +
            `closed.${flushed} Completeness costs latency.`, "warn"];
        }
        const head = `Counting by event time with a ${d} s watermark delay: each window fired about <b>${avg} s</b> after it ended. `;
        if (!st.dropped) return [head + "Nothing arrived after its window had fired, so every count is complete." + flushed, "ok"];
        const who = late.every(e => e.kind === "straggler") ? plural(late.length, "straggler") : plural(late.length, "order");
        return [head + `<b>${who}</b> arrived after their window had fired and ${late.length === 1 ? "was" : "were"} dropped, ` +
          `so <b>${plural(st.wrong, "window")}</b> undercount.` + flushed, "bad"];
      }

      async function play() {
        const my = ++gen, from = pausedAt !== null ? pausedAt : 0;
        playing = true;
        pausedAt = null;
        v.playBtn.setLabel("⏸ Pause");
        let prev = from;
        paint(from);
        await ctx.tween({ ms: 7000 * (END - from) / END, ease: "linear", onUpdate: k => {
          if (my !== gen) return;
          const pt = from + (END - from) * k;
          paint(pt, prev);
          prev = pt;
        } });
        if (my !== gen) return;
        playing = false;
        v.playBtn.setLabel("▶ Play");
        paint(END);
      }

      function pause() {
        gen++;
        playing = false;
        pausedAt = nowPt;
        v.playBtn.setLabel("▶ Resume");
        paint(nowPt);
      }

      build();
      // Rebuild outside the ResizeObserver callback: changing layout inside it raises a "loop
      // completed with undelivered notifications" error event.
      ctx.onResize(() => ctx.after(0, () => { if (ctx.compact !== compact) build(); }));
    },
  });
})();
