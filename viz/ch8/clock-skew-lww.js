// Last-write-wins on wall-clock timestamps (the book's 42.004 / 42.003 story): Node 1's clock
// runs a few ms fast, so client A's earlier write carries a later timestamp than client B's
// write that read it. Every replica keeps A's value; B was acknowledged and silently lost.
(function () {
  "use strict";

  const DELAY = 1;   // replication delay between any two nodes, ms
  const T_A = 1;     // client A writes x = 1 via Node 1 at this true time, ms
  const NODES = [1, 2, 3];
  const PRESETS = {
    book: { off1: 3, off3: 0, gap: 1, retries: false },
    sync: { off1: 0, off3: 0, gap: 1, retries: false },
    lag: { off1: 4, off3: -1, gap: 1, retries: true },
  };
  const SCENARIOS = [
    { value: "book", label: "Book example" }, { value: "sync", label: "Clocks in sync" },
    { value: "lag", label: "Lagging writer" }, { value: "custom", label: "Custom" },
  ];
  // True-time axis length: covers every event for every slider setting (checkModel asserts it).
  const domain = retries => (retries ? 10 : 7);

  // ------------------------------------------------------------------ pure model
  /** Each write reaches its coordinator at once and the other replicas DELAY later; every
   *  replica applies LWW on arrival: higher timestamp wins, a tie goes to the higher node id. */
  function simulate({ off1, off3, gap, retries }) {
    const off = { 1: off1, 2: 0, 3: off3 };
    const tB = T_A + DELAY + gap;   // B reads x = 1 on Node 3 as A's write lands, then writes
    const writes = [
      { id: "A", client: "A", value: 1, node: 1, t: T_A },
      { id: "B", client: "B", value: 2, node: 3, t: tB },
    ];
    if (retries) for (let k = 1; k <= 3; k++) writes.push({ id: "r" + k, client: "B", value: 2, node: 3, t: tB + k, retry: k });
    writes.forEach((w, i) => Object.assign(w, { i, ts: w.t + off[w.node], lostTo: null }));
    const arrivals = [];
    writes.forEach(w => NODES.forEach(n => arrivals.push({ w, node: n, t: n === w.node ? w.t : w.t + DELAY })));
    arrivals.sort((a, b) => a.t - b.t || a.w.i - b.w.i);
    const cur = {}, held = { 1: [], 2: [], 3: [] };   // held[n]: when node n adopted which write
    for (const a of arrivals) {
      const c = cur[a.node] || null;
      a.prev = c;
      a.tie = !!c && a.w.ts === c.ts;   // exact: all times are multiples of 0.5 ms
      a.kept = !c || a.w.ts > c.ts || (a.tie && a.w.node > c.node);
      if (a.kept) { cur[a.node] = a.w; held[a.node].push({ t: a.t, w: a.w }); }
      else if (c.t < a.w.t && !a.w.lostTo) a.w.lostTo = c;   // rejected for an EARLIER write
    }
    const last = writes[writes.length - 1];
    return {
      writes, arrivals, held, final: cur, last, tB,
      ok: cur[1].value === last.value,
      lost: writes.filter(w => w.lostTo).length,
      ties: arrivals.filter(a => a.tie),
      end: Math.max(...arrivals.map(a => a.t)),
    };
  }

  /** Dev check over the whole slider grid: LWW must converge and stay on the axis. */
  function checkModel() {
    for (let o1 = -5; o1 <= 5; o1 += 0.5) for (let o3 = -5; o3 <= 5; o3 += 0.5) {
      for (let gap = 0.5; gap <= 3; gap += 0.5) for (const retries of [false, true]) {
        const m = simulate({ off1: o1, off3: o3, gap, retries });
        if (m.final[1] !== m.final[2] || m.final[2] !== m.final[3]) return `replicas diverge at ${o1}/${o3}/${gap}/${retries}`;
        if (m.end > domain(retries)) return `event at ${m.end} ms is off the axis`;
      }
    }
    return null;
  }

  /** ms after 42.000 s as seconds: 4 -> "42.004" (short ".004"), -4 -> "41.996", 3.5 -> "42.0035". */
  function fmtTs(ts, short) {
    const ms = Math.round((42000 + ts) * 2) / 2, sec = Math.floor(ms / 1000), rem = ms - sec * 1000;
    return (short ? "" : sec) + "." + String(Math.floor(rem)).padStart(3, "0") + (rem % 1 ? "5" : "");
  }
  const short = ts => fmtTs(ts, true);
  // Short forms (".004") only when both values are in the same second, else ".996" < ".004" misleads.
  const pair = (a, b) => (a < 0 || b < 0 ? [fmtTs(a), fmtTs(b)] : [short(a), short(b)]);
  const firstWin = m => m.writes.find(w => w.client === "B" && !w.lostTo);
  const signed = v => (v < 0 ? "−" : "+") + Math.abs(v).toFixed(1);
  const fmtMs = v => (v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + " ms";
  const textW = (str, size, mono) => str.length * size * (mono ? 0.6 : 0.56);
  const colorOf = w => `var(--viz-${w.client === "A" ? "c6" : "c5"})`;
  const mono = str => `<span class="mono">${str}</span>`;

  /** The explanation under the chart: [html, tone]. */
  function explain(m, p) {
    const A = m.writes[0], B = m.writes[1], skew = p.off1 - p.off3, real = fmtMs(B.t - A.t);
    const tie = m.ties.find(a => a.kept);
    let html, tone = "ok";
    if (!m.ok) {
      html = `B read <b>x = 1</b> and then wrote <b>x = 2</b>, <b>${real}</b> after A's write in real time. ` +
        `But Node 1's clock is <b>${fmtMs(skew)}</b> ahead of Node 3's, so A's write carries the larger timestamp ` +
        `(${mono(fmtTs(A.ts))} vs ${mono(fmtTs(B.ts))}). Every replica keeps <b>x = 1</b>. ` +
        "B got an acknowledgment, and its write vanished without any error.";
      if (p.retries) html += ` Even B's retries (up to ${mono(fmtTs(m.last.ts))}) are stamped older than A's write.`;
      tone = "bad";
    } else if (m.lost) {
      html = `B's writes are thrown away until Node 3's clock reaches A's timestamp (${mono(fmtTs(A.ts))}): ` +
        `<b>${m.lost}</b> acknowledged write${m.lost > 1 ? "s" : ""} vanished before the retry at ${mono(fmtTs(firstWin(m).ts))} won. ` +
        "A node with a lagging clock can't overwrite a write from a fast clock until the skew has elapsed.";
      tone = "warn";
    } else if (tie) {
      html = `Node 1's clock is ${fmtMs(skew)} ahead of Node 3's, exactly the real gap between the writes, ` +
        `so both writes carry the same timestamp.`;
      tone = "warn";
    } else if (skew > 0) {
      html = `Here the skew (<b>${fmtMs(skew)}</b>) is smaller than the real gap between the writes (<b>${real}</b>), ` +
        "so timestamp order matches real order and <b>x = 2</b> survives. " +
        `Add more than ${fmtMs(B.t - A.t - skew)} of skew and it flips: LWW is only as good as your clock sync.`;
    } else if (skew === 0) {
      html = "With the clocks agreeing, timestamp order is real-time order and <b>x = 2</b> survives. " +
        `Push Node 1's clock more than ${real} ahead and it flips: LWW is only as good as your clock sync.`;
    } else {
      html = "Node 3's clock is ahead of Node 1's, so B's later write also gets the larger timestamp and <b>x = 2</b> survives: " +
        "the skew happens to point the right way.";
    }
    if (m.ties.length) {
      html += ` Timestamps tie at ${mono(fmtTs(m.ties[0].w.ts))}; the tiebreaker (node id) picks a winner arbitrarily, ` +
        "not by real-time order. Here the higher id, Node 3, happens to favour B's later write.";
    }
    if (p.off3 > p.off1) html += " Node 3 now runs ahead: its writes would beat later writes from Node 1.";
    return [html, tone];
  }

  /** The one-line verdict drawn under the lanes: [text, tone]. */
  function verdict(m, compact) {
    const A = m.writes[0], B = m.writes[1], tie = m.ties.find(a => a.kept), sp = " ";
    if (!m.ok) {
      return [compact ? `B's write lost: ts ${pair(B.ts, A.ts).join(" < ")}`
        : `Real-time order: A then B${sp}|${sp}Timestamp order: B then A${sp}→${sp}B's write is lost`, "bad"];
    }
    if (m.lost) {
      const ts = fmtTs(firstWin(m).ts, compact);
      return [compact ? `${m.lost} lost, then retry ${ts} wins: x=2`
        : `${m.lost > 1 ? `B's first ${m.lost} writes` : "B's first write"} lost to A's earlier write; the retry at ${ts} wins`, "warn"];
    }
    if (tie) {
      return [compact ? `Tie at ${short(tie.w.ts)}: Node 3 wins, x=2`
        : `Timestamps tie at ${fmtTs(tie.w.ts)}${sp}→${sp}node-id tiebreak picks B${sp}→${sp}x = 2 survives`, "warn"];
    }
    return [compact ? "Same order by clock and in reality: x=2 survives"
      : `Real-time order and timestamp order both say A then B${sp}→${sp}x = 2 survives`, "ok"];
  }

  Viz.register("ch8/clock-skew-lww", {
    title: "Skewed clocks eat writes",
    model: { simulate, fmtTs, checkModel, explain, verdict, PRESETS },   // for offline tests
    mount(root, ctx) {
      const { s, h, ui, lerp, clamp } = ctx;
      // State lives outside build() so a phone <-> desktop rebuild keeps it.
      let params = { ...PRESETS.book }, scenario = "book";
      let compact = ctx.compact, view = null, epoch = 0;
      const problem = checkModel();
      if (problem) console.error("[ch8/clock-skew-lww] " + problem);

      const offsetOf = n => (n === 1 ? params.off1 : n === 3 ? params.off3 : 0);

      function layout() {
        // rows: label offsets from a lane, nearest first ([above], [below]).
        const L = compact
          ? { W: 360, H: 280, x0: 50, x1: 318, endX: 356, lanes: [86, 150, 214], titleY: 11, tickY: 27, axisY: 37,
              verdictY: 266, r: 8, rg: 6, fs: 11, up: [-16, -30], down: [17, 31] }
          : { W: 640, H: 316, x0: 112, x1: 588, endX: 634, lanes: [98, 168, 238], titleY: 13, tickY: 31, axisY: 43,
              verdictY: 300, r: 9, rg: 7, fs: 12, up: [-18, -34], down: [22, 38], ruler: true };
        L.T = domain(params.retries);
        L.x = t => L.x0 + (t / L.T) * (L.x1 - L.x0);
        L.y = n => L.lanes[n - 1];
        return L;
      }

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const L = layout();
        const fmtOff = v => signed(v) + " ms";
        const scen = (compact ? ui.select : ui.segmented)({ label: "Scenario", options: SCENARIOS, value: scenario, onChange: pickScenario });
        const sl = {
          off1: ui.slider({ label: "Node 1 clock", min: -5, max: 5, step: 0.5, value: params.off1, format: fmtOff, onInput: v => userSet("off1", v) }),
          off3: ui.slider({ label: "Node 3 clock", min: -5, max: 5, step: 0.5, value: params.off3, format: fmtOff, onInput: v => userSet("off3", v) }),
          // A zero gap would put B's write exactly on top of A's arrival; 0.5 ms is the minimum.
          gap: ui.slider({ label: "B writes after reading x=1", min: 0.5, max: 3, step: 0.5, value: params.gap, format: v => v.toFixed(1) + " ms", onInput: v => userSet("gap", v) }),
        };
        if (compact) Object.values(sl).forEach(c => { c.input.style.flex = "1 1 80px"; });
        const retry = ui.toggle({ label: "B retries 3×", value: params.retries, onChange: v => userSet("retries", v) });
        const replayBtn = ui.button("▶ Replay", replay, { kind: "primary", title: "Animate the timeline in true time" });

        const svg = ctx.svg({ w: L.W, h: L.H, label: "Three replicas on a true-time axis applying last-write-wins with skewed clocks" });
        const layers = {};
        ["grid", "band", "arrow", "mark", "label", "over"].forEach(k => { layers[k] = s("g"); svg.appendChild(layers[k]); });
        const caption = h("div", { class: "muted", style: "font-size:12.5px;line-height:1.45;margin:-4px 0 8px" },
          compact ? "A write's timestamp is its node's clock (true time + offset). Writes reach the other replicas 1 ms later; " +
              "each keeps the highest timestamp. Lane tint = value held."
            : "Ticks under each lane show that node's own clock, which stamps its writes. Writes reach the other " +
              "replicas 1 ms later; each replica keeps the highest timestamp. Lane tint = the value a replica holds.");
        const chips = h("div", { class: "viz-controls", style: "margin:10px 0 0;gap:6px 8px" });
        const stats = ui.stats([
          { key: "skew", label: "Skew N1 − N3" }, { key: "acked", label: "Writes acknowledged" },
          { key: "final", label: "Final value" }, { key: "lost", label: "Newer writes discarded" },
        ]);
        if (compact) stats.style.gridTemplateColumns = "1fr 1fr";
        const note = ui.note("");
        const legend = ui.legend([
          { color: "var(--viz-c6)", label: "Client A's write (x=1)" },
          { color: "var(--viz-c5)", label: "Client B's write (x=2)" },
          { color: "var(--viz-muted)", label: "replication (1 ms)", shape: "dash" },
          { color: "var(--viz-ok)", label: "adopted" },
          { color: "var(--viz-bad)", label: "discarded: older timestamp" },
        ]);
        root.append(ui.bar(scen, replayBtn), ui.bar(sl.off1, sl.off3, sl.gap, retry), caption, svg, legend, chips, stats, note);
        view = { svg, layers, scen, sl, retry, chips, stats, note };
        render();
      }

      // ------------------------------------------------------------ drawing
      // Timed elements let Replay reveal the scene in true-time order; the static view is t = ∞.
      const fadeIn = (el, t) => { view.timed.push({ el, t, on: null }); return el; };
      const grow = (el, t0, t1, apply) => { view.timed.push({ el, t0, t1, apply }); return el; };

      function setTime(tc, animate) {
        const L = view.L;
        ctx.attr(view.cursor, { x1: L.x(Math.min(tc, L.T)), x2: L.x(Math.min(tc, L.T)) });
        for (const it of view.timed) {
          if (it.apply) {
            const k = it.t1 > it.t0 ? clamp((tc - it.t0) / (it.t1 - it.t0), 0, 1) : tc >= it.t0 ? 1 : 0;
            it.el.style.display = k > 0 ? "" : "none";
            if (k > 0) it.apply(k);
            continue;
          }
          const on = tc >= it.t - 1e-9;
          if (on === it.on) continue;
          it.on = on;
          if (on && animate) ctx.animate(it.el, { opacity: 1 }, 300);
          else it.el.setAttribute("opacity", on ? 1 : 0);
        }
      }

      /** Line from (x1, y1) to (x2, y2) shortened by a at the start and b at the end. */
      function trim(x1, y1, x2, y2, a, b) {
        const d = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / d, uy = (y2 - y1) / d;
        return [x1 + ux * a, y1 + uy * a, x2 - ux * b, y2 - uy * b];
      }
      const cross = (x, y, k, color) => s("path", {
        d: `M${x - k},${y - k} L${x + k},${y + k} M${x + k},${y - k} L${x - k},${y + k}`,
        fill: "none", stroke: color, "stroke-width": 2, "stroke-linecap": "round",
      });
      /** Arrival marker: check (adopted) or cross (discarded). */
      function glyph(x, y, r, kept) {
        const c = kept ? "var(--viz-ok)" : "var(--viz-bad)", k = r * 0.48;
        const g = s("g", null, s("circle", { cx: x, cy: y, r, fill: "var(--viz-bg)", stroke: c, "stroke-width": 1.6 }));
        g.append(kept ? s("path", {
          d: `M${x - k},${y + 0.05 * r} L${x - 0.12 * r},${y + k} L${x + k},${y - k * 0.85}`,
          fill: "none", stroke: c, "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round",
        }) : cross(x, y, k * 0.85, c));
        return g;
      }

      function drawAxis(L) {
        const g = view.layers.grid, muted = { size: L.fs, fill: "var(--viz-muted)" };
        g.append(ctx.text(L.x0, L.titleY, "true time (ms after 42.000 s)", { ...muted, anchor: "start" }));
        g.append(s("line", { x1: L.x(0), x2: L.x(L.T), y1: L.axisY, y2: L.axisY, stroke: "var(--viz-line)" }));
        for (let t = 0; t <= L.T; t++) {
          const x = L.x(t);
          g.append(s("line", { x1: x, x2: x, y1: L.axisY - 4, y2: L.axisY, stroke: "var(--viz-muted)" }));
          g.append(s("line", { x1: x, x2: x, y1: L.axisY + 6, y2: L.lanes[2] + (L.ruler ? 30 : 14), stroke: "var(--viz-grid)" }));
          if (t % 2 === 0) g.append(ctx.text(x, L.tickY, String(t), muted));
        }
      }

      function drawLanes(L) {
        const g = view.layers.grid;
        NODES.forEach(n => {
          const y = L.y(n), off = offsetOf(n), lx = compact ? 4 : 8;
          g.append(s("line", { x1: L.x0 - 8, x2: L.x1 + 4, y1: y, y2: y, stroke: "var(--viz-line)", "stroke-width": 1.5 }));
          g.append(ctx.text(lx, y - 9, compact ? "N" + n : "Node " + n, { size: compact ? 12 : 13, weight: 700, anchor: "start" }));
          g.append(ctx.text(lx, y + 9, compact ? signed(off) : "clock " + signed(off) + " ms",
            { size: L.fs, mono: true, anchor: "start", fill: off ? "var(--viz-warn)" : "var(--viz-muted)" }));
        });
      }

      /** Desktop: the node's local clock under its lane, so a write's timestamp can be read off. */
      function drawRuler(L, n, reserved) {
        const off = offsetOf(n), y = L.y(n), g = view.layers.grid;
        for (let loc = Math.ceil(off); loc <= Math.floor(L.T + off); loc++) {
          const x = L.x(loc - off);
          g.append(s("line", { x1: x, x2: x, y1: y + 5, y2: y + 10, stroke: "var(--viz-muted)" }));
          const lab = short(loc), w = textW(lab, 12, true);
          if (loc % 2 !== 0 || x - w / 2 < L.x0 - 4) continue;
          if (reserved.some(([a, b]) => x + w / 2 + 4 > a && x - w / 2 - 4 < b)) continue;
          g.append(ctx.text(x, y + L.down[0], lab, { size: 12, mono: true, fill: "var(--viz-muted)" }));
        }
      }

      /** Lane tint: which write each replica holds over time, plus its final value at the end. */
      function drawBands(L, m) {
        NODES.forEach(n => {
          const y = L.y(n), segs = m.held[n];
          segs.forEach((sg, i) => {
            const next = segs[i + 1], xa = L.x(sg.t), xb = next ? L.x(next.t) : L.x1 + 4;
            const line = s("line", { x1: xa, x2: xb, y1: y, y2: y, stroke: colorOf(sg.w), "stroke-width": compact ? 6 : 8, opacity: 0.4 });
            view.layers.band.append(grow(line, sg.t, next ? next.t : L.T, k => line.setAttribute("x2", lerp(xa, xb, k))));
          });
          const fw = m.final[n];
          view.layers.label.append(fadeIn(ctx.text(L.endX, y, "x=" + fw.value,
            { size: compact ? 12 : 13, weight: 700, anchor: "end", fill: colorOf(fw) }), L.T));
        });
      }

      /** Marks where a slanted arrow crosses each lane's ruler-label row, so no ruler label lands on it. */
      function reserveCrossings(L, reserved, x1, y1, x2, y2) {
        NODES.forEach(n => {
          const ya = L.y(n) + L.down[0] - 7, yb = ya + 14;
          if (Math.max(y1, y2) < ya || Math.min(y1, y2) > yb) return;
          const xs = [ya, yb].map(yy => x1 + (x2 - x1) * clamp((yy - y1) / (y2 - y1), 0, 1));
          reserved[n].push([Math.min(...xs) - 3, Math.max(...xs) + 3]);
        });
      }

      /** Writes, their replication arrows and arrival markers. Returns the label spans under each lane. */
      function drawWrites(L, m) {
        const reserved = { 1: [], 2: [], 3: [] }, { layers } = view;
        let ignoredShown = false;
        m.writes.forEach(w => {
          const color = colorOf(w), x = L.x(w.t), y = L.y(w.node);
          m.arrivals.filter(a => a.w === w && a.node !== w.node).forEach(a => {
            const tx = L.x(a.t), ty = L.y(a.node);
            const [x1, y1, x2, y2] = trim(x, y, tx, ty, L.r + 1, L.rg + 2);
            const p = ctx.arrow({ x1, y1, x2, y2, color, dashed: true, width: 1.6, svg: view.svg });
            reserveCrossings(L, reserved, x1, y1, x2, y2);
            layers.arrow.append(grow(p, w.t, a.t, k => p.setAttribute("d", `M${x1},${y1} L${lerp(x1, x2, k)},${lerp(y1, y2, k)}`)));
            layers.mark.append(fadeIn(glyph(tx, ty, L.rg, a.kept), a.t));
            // With retries the N2 lane is crossed by many arrows; the glyphs and the note carry it there.
            if (!a.kept && a.node === 2 && !ignoredShown && !compact && !params.retries) {
              ignoredShown = true;
              const lab = `ignored: ${pair(w.ts, a.prev.ts).join(" < ")}`, lx = tx + L.rg + 3;
              layers.label.append(fadeIn(ctx.text(lx, ty + L.down[0], lab, { size: 12, weight: 600, anchor: "start", fill: "var(--viz-bad)", halo: true }), a.t));
              reserved[2].push([lx, lx + textW(lab, 12)]);
            }
          });
          // A write discarded by its own coordinator is drawn hollow with a cross.
          const own = m.arrivals.find(a => a.w === w && a.node === w.node);
          const g = s("g", null, own.kept
            ? s("circle", { cx: x, cy: y, r: L.r, fill: color, stroke: "var(--viz-bg)", "stroke-width": 1.5 })
            : s("circle", { cx: x, cy: y, r: L.r, fill: "var(--viz-bg)", stroke: color, "stroke-width": 2.2 }));
          if (!own.kept) g.append(cross(x, y, L.r * 0.42, "var(--viz-bad)"));
          // Labels go on the side away from the outgoing arrows: timestamp nearest, then the value.
          // Phone retries sit ~27 px apart, so their timestamps alternate between the two rows
          // (and B's value label is dropped there: it would read as part of the next timestamp).
          const rows = w.node === 1 ? L.up : L.down, ts = compact || w.retry ? short(w.ts) : fmtTs(w.ts);
          const tsRow = compact && w.retry % 2 === 1 ? rows[1] : rows[0], half = textW(ts, L.fs, true) / 2;
          if (w.id === "B") view.bLabelLeft = x - half;
          if (!w.retry && !(compact && params.retries && w.id === "B")) {
            const lab = compact ? "x=" + w.value : `${w.client}: x=${w.value}`;
            g.append(ctx.text(x, y + rows[1], lab, { size: L.fs, weight: 700, fill: color, halo: true }));
          }
          g.append(ctx.text(x, y + tsRow, ts, {
            size: L.fs, mono: true, weight: 600, fill: w.lostTo ? "var(--viz-bad)" : "var(--viz-ink)", halo: true,
          }));
          if (tsRow === L.down[0]) reserved[w.node].push([x - half, x + half]);
          layers.mark.append(fadeIn(g, w.t));
        });
        return reserved;
      }

      /** Causality: B's write depends on the x = 1 it read when A's write reached Node 3. */
      function drawReadCue(L, m, reserved) {
        const y = L.y(3), tr = T_A + DELAY, xa = L.x(tr), xb = L.x(m.tB);
        const x1 = xa + L.rg + 2, x2 = xb - L.r - 3;
        if (x2 - x1 > 6) {
          const p = s("path", { fill: "none", stroke: "var(--viz-ink)", "stroke-width": 1.6, "stroke-dasharray": "2 3",
            "marker-end": view.svg.arrow("var(--viz-ink)") });
          view.layers.arrow.append(grow(p, tr, m.tB, k => p.setAttribute("d", `M${x1},${y} L${lerp(x1, x2, k)},${y}`)));
        }
        // Ends just right of the read, or further left when B's timestamp label is close.
        const lab = compact ? "read x=1" : "B read x=1", lx = Math.min(xa + (compact ? 3 : 6), view.bLabelLeft - 9);
        view.layers.label.append(fadeIn(ctx.text(lx, y + L.down[0], lab, { size: L.fs, weight: 600, anchor: "end", halo: true }), tr));
        reserved[3].push([lx - textW(lab, L.fs), lx]);
      }

      function render(fromZero = false) {
        const L = layout(), m = simulate(params), { layers } = view;
        Object.values(layers).forEach(g => { g.innerHTML = ""; });
        Object.assign(view, { L, m, timed: [] });
        drawAxis(L);
        drawLanes(L);
        drawBands(L, m);
        const reserved = drawWrites(L, m);
        drawReadCue(L, m, reserved);
        if (L.ruler) NODES.forEach(n => drawRuler(L, n, reserved[n]));
        const [vText, vTone] = verdict(m, compact);
        view.verdict = ctx.text(L.W / 2, L.verdictY, vText, { size: compact ? 12 : 13, weight: 700, fill: `var(--viz-${vTone})` });
        view.cursor = s("line", { y1: L.axisY - 6, y2: L.lanes[2] + (L.ruler ? 30 : 14), stroke: "var(--viz-muted)", "stroke-width": 2 });
        layers.label.append(view.verdict);
        layers.over.append(view.cursor);
        setTime(fromZero ? 0 : Infinity, false);
        view.cursor.style.display = fromZero ? "" : "none";
        view.verdict.setAttribute("opacity", fromZero ? 0 : 1);
        updatePanel(m);
      }

      function updatePanel(m) {
        const { stats, chips, note } = view, skew = params.off1 - params.off3;
        stats.set("skew", fmtMs(skew), skew ? "warn" : "ok");
        stats.set("acked", String(m.writes.length), "");
        stats.set("final", "x = " + m.final[1].value, m.ok ? "ok" : "bad");
        stats.set("lost", String(m.lost), m.lost ? "bad" : "ok");
        chips.innerHTML = "";
        chips.append(h("span", { class: "muted", style: "font-size:12.5px" }, "Final value on each replica:"),
          ...NODES.map(n => {
            const w = m.final[n], b = ui.badge(`N${n}: x=${w.value} @ ${fmtTs(w.ts)}`, w.value === m.last.value ? "ok" : "bad");
            b.style.cssText += ";font-size:12.5px;font-family:var(--font-mono)";
            return b;
          }));
        note.set(...explain(m, params));
      }

      // ------------------------------------------------------------ interaction
      function userSet(key, v) {
        params = { ...params, [key]: v };
        scenario = "custom";
        view.scen.set("custom");
        epoch++;   // cancels a replay in progress
        render();
      }

      function pickScenario(v) {
        scenario = v;
        if (PRESETS[v]) {
          params = { ...PRESETS[v] };
          ["off1", "off3", "gap"].forEach(k => view.sl[k].set(params[k]));
          view.retry.set(params.retries);
        }
        epoch++;
        render();
      }

      async function replay() {
        const my = ++epoch;
        render(true);
        await ctx.tween({ ms: 3600, ease: "linear", onUpdate: k => { if (my === epoch) setTime(k * view.L.T, true); } });
        if (my !== epoch) return;
        view.cursor.style.display = "none";
        ctx.animate(view.verdict, { opacity: 1 }, 400);
      }

      build();
      ctx.onResize(() => { if (ctx.compact !== compact) { epoch++; build(); } });
    },
  });
})();
