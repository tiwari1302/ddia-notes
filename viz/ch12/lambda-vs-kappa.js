// Fixing history in Lambda vs Kappa. Video #42 has 29,600 recorded plays; 30% turn out to be
// bots, so the true count is 20,720. In Lambda the fix must land in two codebases, or the nightly
// batch run silently undoes it. In Kappa a second instance of the one stream job replays the log
// from offset 0 next to the old one, which only works if the log still holds that history.
// The scene is drawn from a small model by render(st); steps change the model and fly transient
// packets, so Back (init + instant replay) is deterministic.
(function () {
  "use strict";
  // Each full day has 1,000 plays, 700 of them human; "Today" is a partial day.
  const CHIPS = [
    { label: "Days 1-23", plays: 23000, human: 16100, from: 0, to: 23 },
    { label: "Days 24-29", plays: 6000, human: 4200, from: 23, to: 29 },
    { label: "Today", plays: 600, human: 420, from: 29, to: 30 },
  ];
  const TRUE = 20720, PARTIAL = 29420, MS_PER_DAY = 55;
  const CODE = { v1: ["v1: counts bots", "bad"], v2: ["v2: excludes bots", "ok"] };
  const FS = { title: 13, text: 12, val: 16, big: 17 };   // same sizes in both layouts
  const V = c => `var(--viz-${c})`;
  const fmt = n => (n === null || n === undefined ? "–" : Math.round(n).toLocaleString("en-US"));
  const lerp = (a, b, k) => a + (b - a) * k;
  const clamp01 = k => Math.max(0, Math.min(1, k));
  // Human plays counted by a replay that started at day `start` and has reached day `day`.
  const replayed = (start, day) => CHIPS.reduce((sum, c) =>
    sum + (c.from < start ? 0 : c.human * clamp01((day - c.from) / (c.to - c.from))), 0);

  const SCEN = {
    "lambda/speed": "Lambda, with the fix deployed only to the speed layer (Storm). Watch the served number at midnight.",
    "lambda/both": "Lambda, with the fix written for both the batch layer (MapReduce) and the speed layer (Storm).",
    "kappa/forever": "Kappa: one stream job, and the log keeps every event.",
    "kappa/7": "Kappa, but the log deletes events after 7 days.",
  };
  const LESSON = {
    "lambda/speed": ["<b>The fix was undone by the other codebase.</b> Lambda's cost is not speed, it is keeping two implementations identical.", "bad"],
    "lambda/both": ["<b>Correct, but only with two implementations</b> and a merge step that must know the time boundary.", "warn"],
    "kappa/forever": ["<b>One job, replayed from offset 0, rebuilt 30 days of history</b> much faster than real time, and the old table stayed available as a fallback until reads switched. It works because the job is deterministic: same events, same code, same table.", "ok"],
    "kappa/7": ["<b>Replay can only rebuild what the log still holds.</b> Here 23 of the 30 days are gone, so no new code can ever correct them.", "bad"],
  };

  // Coordinates for both layouts. Desktop flows left to right; the phone flows top to bottom with
  // the two pipelines side by side, so no arrow has to cross a box.
  function layout(compact, cfg) {
    const kappa = cfg.arch === "kappa", same = !kappa && cfg.fix === "speed", d = !compact;
    const B = (x, y, w, h) => ({ x, y, w, h, cx: x + w / 2, cy: y + h / 2, r: x + w, b: y + h });
    const chips = d ? [36, 104, 172].map(y => B(12, y, 126, 58)) : [10, 126, 242].map(x => B(x, 22, 108, 58));
    const proc = d ? [36, 156].map(y => B(180, y, 170, 74)) : [10, 190].map(x => B(x, 116, 160, 74));
    const view = d ? [36, 156].map(y => B(380, y, 114, 74)) : [10, 190].map(x => B(x, 216, 160, 66));
    const out = d ? B(522, 90, 110, 86) : B(80, 312, 200, 72);
    const exit = (b, o = 0) => (d ? [b.r, b.cy + o] : [b.cx + o, b.b]);
    const enter = (b, o = 0) => (d ? [b.x, b.cy + o] : [b.cx + o, b.y]);
    const onBus = p => (d ? [159, p[1]] : [p[0], 95]);   // Kappa: every job taps the same log
    const kIn = (i, r) => { const a = exit(chips[i]), b = enter(proc[r]); return [a, onBus(a), onBus(b), b]; };
    const L = {
      compact, kappa, chips, proc, view, out, kIn, pad: 10,
      lamIn: chips.map((c, i) => [exit(c, i === 2 ? -6 : 0), enter(proc[0], (d ? 21 : 50) * (i - 1))]),
      speedIn: [exit(chips[2], 6), enter(proc[1], d ? 4 : 0)],
      stubs: chips.map(c => [exit(c), onBus(exit(c))]),
      bus: [onBus(exit(chips[0])), onBus(exit(chips[2]))],
      p2v: proc.map((p, r) => [exit(p), enter(view[r])]),
      procRows: d ? { title: 18, sub: 35, chip: 45, chipH: 18 } : { title: 17, sub: 33, chip: 44, chipH: 18 },
      barRows: d ? { title: 15, sub: 31, chip: 39, chipH: 17, bar: 62, barH: 8 } : { title: 15, sub: 30, chip: 38, chipH: 17, bar: 61, barH: 7 },
      chipRows: [15, 31, 46],
    };
    if (d) {
      const gapY = (view[0].b + view[1].y) / 2;
      return Object.assign(L, {
        W: 640, H: same ? 284 : 266, title: [12, 20],
        viewRows: [17, 33, 55], outRows: [17, 32, 54, 73],
        outTitle: kappa ? "Reads" : "Serving", outSub: kappa ? "app queries" : "batch + realtime",
        v2o: view.map((v, r) => [[v.r, v.cy], [out.cx, v.cy], [out.cx, r ? out.b : out.y]]),
        // Starts under the Reads box, so it seems to leave the box's top or bottom edge.
        reads: k => { const y = lerp(view[0].cy, view[1].cy, k); return [[out.cx, out.cy], [out.cx, y], [view[0].r + 2, y]]; },
        cant: [[out.cx, out.b], [out.cx, view[1].cy], [view[1].r + 2, view[1].cy]],
        cantMark: [out.cx - 40, view[1].cy], cantLabel: [out.cx - 32, view[1].cy + 15, "can't switch"],
        boundary: [[[view[0].x - 8, gapY], [view[0].r + 8, gapY]], [view[0].cx, gapY + 13]],
        compare: [view[0].cx, gapY, "differ by 8,880"],
        port: [[[proc[1].cx, proc[1].y - 2], [proc[1].cx, proc[0].b + 2]], [proc[1].cx + 8, gapY, "port the fix", "start"]],
        same: [[12, 250, "Same 600 events: 420 yesterday evening, 600 this morning", "start"]],
        bottom: [12, same ? 272 : 252, "start"],
      });
    }
    const mid = [(out.cx + 40 + view[1].cx) / 2, (out.y + view[1].b) / 2];
    return Object.assign(L, {
      W: 360, H: same ? 470 : 436, title: [10, 12],
      viewRows: [16, 32, 51], outRows: [17, null, 40, 60],
      outTitle: kappa ? "Reads (app queries)" : "Serving: batch + realtime",
      v2o: view.map((v, r) => [[v.cx, v.b], [out.cx + (r ? 40 : -40), out.y]]),
      reads: k => [[lerp(out.cx - 40, out.cx + 40, k), out.y], [lerp(view[0].cx, view[1].cx, k), view[0].b + 2]],
      cant: [[out.cx + 40, out.y], [view[1].cx, view[1].b + 2]],
      cantMark: mid, cantLabel: [mid[0] + 11, mid[1] + 5, "can't switch", "start"],
      boundary: [[[180, view[0].y - 6], [180, view[0].b + 6]], [180, (view[0].b + out.y) / 2]],
      compare: [180, (view[0].b + out.y) / 2, "differ by 8,880"],
      port: [null, [180, (proc[0].b + view[0].y) / 2, "← port the fix"]],
      same: [[180, 448, "Same 600 events:"], [180, 463, "420 yesterday evening, 600 this morning"]],
      bottom: [180, 406, "middle"],
    });
  }

  function newModel(cfg) {
    const kappa = cfg.arch === "kappa", short = kappa && cfg.keep === "7";
    // off: why a box does not exist (yet), e.g. "not started" or "deleted"; null when live.
    const box = (title, sub, extra) => Object.assign({ title, sub, tone: "", code: "v1", off: null, value: null }, extra);
    return {
      kappa, bug: false,
      chips: CHIPS.map((c, i) => ({ label: c.label, gone: short && i === 0, hot: false, hi: false })),
      proc: kappa
        ? [box("Stream job v1", "live, at the log head"), box("Stream job v2", "", { code: "v2", off: "not started" })]
        : [box("Batch layer", "MapReduce job"), box("Speed layer", "Storm topology")],
      view: kappa
        ? [box("table_v1", "written by job v1"), box("table_v2", "written by job v2", { off: "not created" })]
        : [box("Batch view", "days 1-29"), box("Realtime view", "today (day 30)")],
      taps: ["muted", null],    // Kappa: colours of the log -> job arrows (null = hidden)
      progress: null,           // Kappa v2 replay: { start, day } in days 0..30
      reads: null,              // Kappa: 0 = reads hit table_v1 ... 1 = table_v2
      out: { value: null, formula: "" },
      marks: {},
      line: kappa ? "jobs running: 1" : "a MapReduce job and a Storm topology",
      hist: ["–", ""],
    };
  }

  function outTone(m) {
    const v = m.out.value;
    if (!m.bug || v === null) return "";
    return v === TRUE ? "ok" : v === PARTIAL ? "warn" : "bad";
  }

  Viz.register("ch12/lambda-vs-kappa", {
    title: "Fixing history: Lambda vs Kappa",
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      // Config lives outside restart() so a phone/desktop rebuild keeps it.
      const cfg = { arch: "lambda", fix: "speed", keep: "forever" };
      const key = () => cfg.arch + "/" + (cfg.arch === "lambda" ? cfg.fix : cfg.keep);
      let compact = ctx.compact, gen = 0, player = null;

      const paint = (el, props) => { for (const k in props) el.style.setProperty(k, String(props[k])); return el; };
      const show = (el, on) => { el.style.display = on ? "" : "none"; };
      const write = (el, str, props) => { el.textContent = str; if (props) paint(el, props); };
      const ptsD = pts => pts.map((p, i) => (i ? "L" : "M") + p[0] + "," + p[1]).join(" ");
      const later = async (ms, fn) => { await ctx.sleep(ms); return fn(); };

      // ---------- controls and panels ----------
      const stats = ui.stats([
        { key: "served", label: "Answer served", value: "–" },
        { key: "true", label: "True answer", value: fmt(TRUE), tone: "info" },
        { key: "code", label: "Codebases", value: "2", tone: "warn" },
        { key: "hist", label: "History fixed?", value: "–" },
      ]);
      const note = ui.note("");
      const legend = ui.legend([["c1", "immutable events"], ["c2", "derived view"], ["ok", "fixed code (v2)"],
        ["bad", "buggy code (v1)"], ["c6", "reads"]].map(([c, label]) => ({ color: V(c), label, shape: "square" })));
      const segmented = (label, prop, options) => ui.segmented({
        label, value: cfg[prop], options: options.map(([value, lab]) => ({ value, label: lab })),
        onChange: v => { if (v !== cfg[prop]) { cfg[prop] = v; changed(prop); } },
      });
      const optionControl = () => (cfg.arch === "lambda"
        ? segmented("Fix applied to", "fix", [["speed", "Speed layer only"], ["both", "Both codebases"]])
        : segmented("Log retention", "keep", [["forever", "Forever"], ["7", "7 days"]]));
      let optSeg = optionControl();
      function changed(prop) {
        if (prop === "arch") { const next = optionControl(); optSeg.replaceWith(next); optSeg = next; }
        restart(false);
      }
      const archSeg = segmented("Architecture", "arch", [["lambda", "Lambda"], ["kappa", "Kappa"]]);
      const stage = h("div"), stepSlot = h("div");
      root.append(ui.bar(archSeg, optSeg), stage, legend, stepSlot, stats, note);

      // ---------- scene ----------
      // Builds every element (once per init) and returns updaters that redraw them from the model.
      function drawScene(svg, L, layers, hatch) {
        const { base, boxes, marks } = layers, ups = [];
        const T = (parent, x, y, str, o) => parent.appendChild(ctx.text(x, y, str, o));
        const path = (parent, pts, o = {}) => {
          const p = parent.appendChild(s("path", { d: ptsD(pts), fill: "none" }));
          p.set = (color, dashed) => {
            paint(p, { stroke: V(color), "stroke-width": o.width || 1.6, "stroke-dasharray": dashed ? "5 4" : "none" });
            if (o.head !== false) p.setAttribute("marker-end", svg.arrow(V(color)));
            return p;
          };
          return p.set(o.color || "muted", o.dashed);
        };
        // A box with an opaque underlay and one text element per [dy, textOptions] row.
        const card = (b, rows, rx = 8) => {
          const g = boxes.appendChild(s("g"));
          g.appendChild(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx, fill: V("bg") }));
          const rect = g.appendChild(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx, "stroke-width": 1.5 }));
          return { g, rect, t: rows.map(([dy, o]) => (dy === null ? null : T(g, b.cx, b.y + dy, "", o))) };
        };
        // Shared look of a job or view that is live, not started yet, or deleted.
        const paintCard = (c, P, fill, stroke) => {
          paint(c.g, { opacity: P.alpha === undefined ? 1 : P.alpha });
          paint(c.rect, { fill: P.off ? V("bg") : fill, stroke: P.off ? V("muted") : stroke, "stroke-dasharray": P.off ? "5 4" : "none" });
          write(c.t[0], P.title, { fill: V(P.off ? "muted" : "ink") });
          write(c.t[1], P.off || P.sub);
        };
        const bold = { size: FS.title, weight: 700 }, plain = { size: FS.text };

        T(base, ...L.title, L.kappa ? "Immutable event log" : "Immutable master dataset", { ...bold, anchor: "start" });
        // Lambda: the whole dataset feeds the batch layer and today feeds the speed layer.
        // Kappa: every job is just another consumer of the same log.
        if (!L.kappa) [...L.lamIn, L.speedIn].forEach(pts => path(base, pts));
        else {
          const stubs = L.stubs.map(pts => path(base, pts, { head: false }));
          path(base, L.bus, { head: false });
          const taps = [0, 1].map(r => path(base, L.kIn(0, r).slice(2)));
          ups.push(m => {
            stubs.forEach((p, i) => p.set("muted", m.chips[i].gone));
            taps.forEach((p, r) => { show(p, !!m.taps[r]); if (m.taps[r]) p.set(m.taps[r]); });
          });
        }

        CHIPS.forEach((c, i) => {
          const { rect, t } = card(L.chips[i], L.chipRows.map((dy, j) => [dy, j ? plain : { size: 12, weight: 700 }]));
          ups.push(m => {
            const k = m.chips[i], gone = k.gone;
            paint(rect, {
              fill: gone ? `url(#${hatch})` : V("c1-soft"), stroke: V(k.hot ? "bad" : gone ? "muted" : k.hi ? "warn" : "c1"),
              "stroke-width": k.hi || k.hot ? 2.5 : 1.5, "stroke-dasharray": gone ? "5 4" : "none",
            });
            write(t[0], k.label, { fill: V(gone ? "muted" : "ink") });
            write(t[1], gone ? "deleted by" : fmt(c.plays) + " plays");
            write(t[2], gone ? "retention" : fmt(c.human) + " human");
            [t[1], t[2]].forEach((el, j) => {
              el.classList.toggle("viz-mono", !gone);
              paint(el, { fill: V(gone ? "bad" : j ? "muted" : "ink"), "font-weight": gone ? 700 : 400 });
            });
          });
        });

        L.proc.forEach((b, r) => {
          const hasBar = L.kappa && r === 1, rows = hasBar ? L.barRows : L.procRows;
          const c = card(b, [[rows.title, bold], [rows.sub, plain]]);
          const cb = { x: b.x + L.pad, y: b.y + rows.chip, w: b.w - 2 * L.pad, h: rows.chipH };
          const chip = c.g.appendChild(s("g"));
          const chipR = chip.appendChild(s("rect", { x: cb.x, y: cb.y, width: cb.w, height: cb.h, rx: cb.h / 2 }));
          const chipT = T(chip, b.cx, cb.y + cb.h / 2 + 0.5, "", { size: FS.text, weight: 700 });
          let bar = null;
          if (hasBar) {
            const y = b.y + rows.bar, hh = rows.barH, X = day => cb.x + (cb.w * day) / 30;
            bar = { g: c.g.appendChild(s("g")), X };
            bar.g.appendChild(s("rect", { x: cb.x, y, width: cb.w, height: hh, rx: 2, fill: V("grid") }));
            bar.miss = bar.g.appendChild(s("rect", { x: cb.x, y, height: hh, rx: 2, fill: V("bad-soft"), stroke: V("bad"), "stroke-width": 1 }));
            bar.fill = bar.g.appendChild(s("rect", { y, height: hh, rx: 2 }));
          }
          ups.push(m => {
            const P = m.proc[r], [txt, tone] = CODE[P.code];
            paintCard(c, P, V("node"), V("node-stroke"));
            paint(c.t[1], { fill: V(P.off || !P.tone ? "muted" : P.tone), "font-weight": P.tone && !P.off ? 700 : 400 });
            show(chip, !P.off);
            paint(chip, { opacity: P.fade === undefined ? 1 : P.fade });
            paint(chipR, { fill: V(tone + "-soft"), stroke: V(tone), "stroke-width": P.flash ? 3 : 1.3 });
            write(chipT, txt, { fill: V(tone) });
            const pr = m.progress;
            if (!bar) return;
            show(bar.g, !!pr && !P.off);
            if (!pr) return;
            show(bar.miss, pr.start > 0);
            ctx.attr(bar.miss, { width: Math.max(0, bar.X(pr.start) - bar.X(0)) });
            ctx.attr(bar.fill, { x: bar.X(pr.start), width: Math.max(0, bar.X(pr.day) - bar.X(pr.start)) });
            paint(bar.fill, { fill: V(pr.day >= 30 ? "ok" : "warn") });
          });
        });

        const p2v = L.p2v.map(pts => path(base, pts));
        ups.push(m => p2v.forEach((p, r) => show(p, !m.proc[r].off && !m.view[r].off)));
        L.view.forEach((b, r) => {
          const [y1, y2, y3] = L.viewRows;
          const c = card(b, [[y1, { ...bold, mono: L.kappa }], [y2, { ...plain, fill: V("muted") }], [y3, { size: FS.val, weight: 800, mono: true }]]);
          ups.push(m => {
            const Q = m.view[r];
            paintCard(c, Q, V("c2-soft"), V("c2"));
            write(c.t[2], Q.off ? "" : fmt(Q.value), { fill: V(Q.tone || "ink") });
          });
        });

        if (!L.kappa) L.v2o.forEach(pts => path(base, pts));
        else {
          const rp = path(base, L.reads(0), { color: "c6", width: 2 });
          ups.push(m => {
            show(rp, m.reads !== null);
            if (m.reads !== null) rp.setAttribute("d", ptsD(L.reads(m.reads)));
          });
        }
        const [o1, o2, o3, o4] = L.outRows;
        const oc = card(L.out, [[o1, bold], [o2, { ...plain, fill: V("muted") }], [o3, { size: FS.big, weight: 800, mono: true }], [o4, { ...plain, mono: true, fill: V("muted") }]], 10);
        write(oc.t[0], L.outTitle);
        if (oc.t[1]) write(oc.t[1], L.outSub);
        ups.push(m => {
          const tone = outTone(m);
          paint(oc.rect, { fill: V("c6-soft"), stroke: V(tone || "c6"), "stroke-width": tone ? 2.2 : 1.5 });
          write(oc.t[2], m.out.value === null ? "?" : fmt(m.out.value), { fill: V(tone || "ink") });
          write(oc.t[3], m.out.formula);
        });

        // Annotations that individual steps switch on.
        const mk = {}, group = name => (mk[name] = marks.appendChild(s("g")));
        const label = (g, [x, y, str, anchor], tone) =>
          T(g, x, y, str, { size: FS.text, weight: 700, fill: V(tone), anchor: anchor || "middle", halo: true });
        if (!L.kappa) {
          path(group("boundary"), L.boundary[0], { color: "info", dashed: true, head: false });
          label(mk.boundary, [...L.boundary[1], "midnight boundary"], "info");
          if (L.port[0]) path(group("port"), L.port[0], { color: "warn", dashed: true });
          label(mk.port || group("port"), L.port[1], "warn");
          L.same.forEach(line => label(mk.same || group("same"), line, "bad"));
        } else {
          label(group("compare"), L.compare, "warn");
          path(group("cant"), L.cant, { color: "bad", dashed: true });
          T(mk.cant, ...L.cantMark, "✕", { size: 15, weight: 800, fill: V("bad"), halo: true });
          label(mk.cant, L.cantLabel, "bad");
        }
        ups.push(m => { for (const k in mk) show(mk[k], !!m.marks[k]); });

        const [bx, by, anchor] = L.bottom;
        const bl = T(marks, bx, by, "", { size: 12, anchor });
        const b1 = bl.appendChild(s("tspan", { "font-weight": 700 }));
        const b2 = bl.appendChild(s("tspan", L.compact ? { x: bx, dy: 16 } : {}));
        ups.push(m => {
          write(b1, `Codebases to maintain: ${m.kappa ? 1 : 2}`, { fill: V(m.kappa ? "ok" : "warn") });
          write(b2, (L.compact ? "" : "  ·  ") + m.line, { fill: V("muted") });
        });
        return ups;
      }

      function render(st) {
        st.ups.forEach(u => u(st.m));
        if (st.gen !== gen) return;   // a superseded player finishing its step
        const m = st.m, [hv, ht] = m.hist;
        stats.set("served", fmt(m.out.value), outTone(m));
        stats.set("code", m.kappa ? "1" : "2", m.kappa ? "ok" : "warn");
        stats.set("hist", hv.length > 10 ? `<span style="font-size:14px">${hv}</span>` : hv, ht);
      }

      // ---------- animation helpers (all honour ctx.instant) ----------
      const patch = (st, obj, props) => { Object.assign(obj, props); render(st); };
      async function flyPath(st, pts, color, ms = 650) {
        const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
        const total = lens.reduce((a, b) => a + b, 0) || 1;
        for (let i = 0; i < lens.length; i++) {
          if (lens[i]) await ctx.fly(st.pk, { from: pts[i], to: pts[i + 1], fill: V(color), ms: (ms * lens[i]) / total, ease: "linear", r: st.L.compact ? 5.5 : 6.5 });
        }
      }
      const flyAll = (st, list, color, ms, stagger = 140) =>
        Promise.all(list.map((pts, i) => later(i * stagger, () => flyPath(st, pts, color, ms))));
      const toServing = st => flyAll(st, st.L.v2o, "c2", 520, 0);
      async function count(st, obj, to, ms = 600) {
        const from = obj.value || 0;
        await ctx.tween({ ms, onUpdate: k => patch(st, obj, { value: lerp(from, to, k) }) });
        patch(st, obj, { value: to });
      }
      async function blink(st, obj, prop, final, ms = 1000) {
        await ctx.tween({ ms, ease: "linear", onUpdate: k => patch(st, obj, { [prop]: k >= 1 ? final : Math.floor(k * 6) % 2 === 0 }) });
        patch(st, obj, { [prop]: final });
      }
      async function flip(st, r, code) {   // swap a layer's code chip with a quick cross-fade
        const P = st.m.proc[r];
        await ctx.tween({ ms: 520, ease: "linear", onUpdate: k => patch(st, P, { fade: Math.abs(1 - 2 * k), code: k >= 0.5 ? code : P.code }) });
        patch(st, P, { fade: 1 });
      }
      const serve = (st, value, formula) => patch(st, st.m, { out: { value, formula } });
      function bugFound(st, props) {
        st.m.view.forEach(Q => { if (Q.value) Q.tone = "bad"; });
        patch(st, st.m, Object.assign({ bug: true }, props));
      }
      // Kappa: job v2 reads one chip of the log while the progress bar and table_v2 advance.
      async function replay(st, i) {
        const m = st.m, c = CHIPS[i], pr = m.progress, ms = Math.max(400, (c.to - c.from) * MS_PER_DAY);
        m.chips[i].hi = true;
        await Promise.all([
          flyPath(st, st.L.kIn(i, 1), "c1", Math.min(600, ms)),
          ctx.tween({ ms, ease: "linear", onUpdate: k => {
            pr.day = lerp(c.from, c.to, k);
            m.view[1].value = replayed(pr.start, pr.day);
            patch(st, m.proc[1], { sub: `replaying day ${Math.max(pr.start + 1, Math.ceil(pr.day - 1e-6))}/30` });
          } }),
        ]);
        patch(st, m.chips[i], { hi: false });
      }

      // ---------- scripts ----------
      const step = (title, run, detail) => ({ title, run, detail });
      function lambdaSteps(both) {
        const s1 = step("Every play is appended to the immutable master dataset and fed to both layers.", async st => {
          // The batch view covers days 1-29; today's plays reach the batch layer at midnight.
          await Promise.all([flyAll(st, st.L.lamIn.slice(0, 2), "c1"), later(280, () => flyPath(st, st.L.speedIn, "c1"))]);
          await flyAll(st, st.L.p2v, "c2", 420, 0);
          st.m.view[0].value = 29000;
          patch(st, st.m.view[1], { value: 600 });
        });
        const s2 = step("Query = batch view (days 1-29: <b>29,000</b>) + realtime view (today: <b>600</b>) = <b>29,600</b>.", async st => {
          await toServing(st);
          serve(st, 29600, "29,000 + 600");
        });
        const s4 = step(both
          ? "Speed layer applies it immediately: today = <b>420</b>. History still has bots until the next batch run: 29,000 + 420 = <b>29,420</b>."
          : "The speed layer now excludes bots: today = <b>420</b>. Query = 29,000 + 420 = <b>29,420</b>: a mix of fixed and unfixed numbers.", async st => {
          await flyPath(st, st.L.speedIn, "c1", 500);
          await flyPath(st, st.L.p2v[1], "c2", 380);
          st.m.view[1].tone = "ok";
          await count(st, st.m.view[1], 420, 500);
          await toServing(st);
          serve(st, PARTIAL, "29,000 + 420");
        });
        // A batch run over the first n chips: the batch view counts to `to`; `before` edits the
        // model just before the new view lands.
        async function rerun(st, n, sub, to, tone, before) {
          const Bt = st.m.proc[0];
          patch(st, Bt, { sub, tone: "warn" });
          await flyAll(st, st.L.lamIn.slice(0, n), "c1", 700, 160);
          await flyPath(st, st.L.p2v[0], "c2", 380);
          if (before) before(st.m);
          st.m.view[0].tone = tone;
          await count(st, st.m.view[0], to, 700);
          patch(st, Bt, { sub: "MapReduce job", tone: "" });
          await toServing(st);
        }
        if (!both) return [s1, s2, step("<b>Bug found:</b> 30% of plays are bots. The fix is written for the Storm topology, the fastest one to change.", async st => {
          bugFound(st, { hist: ["no", "bad"], line: "the fix is in only one of them" });
          await flip(st, 1, "v2");
        }), s4, step("<b>Midnight:</b> the batch job recomputes days 1-30 from scratch with its old code. Today's plays move into the batch view and are counted with bots again.", async st => {
          const m = st.m;
          m.chips[2].label = "Day 30";
          await rerun(st, 3, "recomputing days 1-30", 29600, "bad", () => {
            Object.assign(m.view[1], { value: 0, tone: "", sub: "today (day 31)" });
            m.view[0].sub = "days 1-30";
          });
          m.chips[2].hot = m.marks.same = true;
          serve(st, 29600, "29,600 + 0");
        }, '<span style="color:var(--viz-bad);font-weight:700">The same 600 events: 420 yesterday evening, 600 this morning.</span>'),
        step("The fix has to be ported to the MapReduce job, tested for equivalence, and the history recomputed. <b>Two codebases means two places for every bug.</b>", async st => {
          st.m.marks.port = true;
          await blink(st, st.m.proc[0], "flash", false);
        })];
        return [s1, s2, step("The fix is written twice: once for MapReduce, once for Storm, and both must stay equivalent forever.", async st => {
          bugFound(st, { hist: ["after next batch run", "warn"], line: "the fix was written twice" });
          await Promise.all([flip(st, 0, "v2"), flip(st, 1, "v2")]);
        }), s4, step("A batch rerun with v2 over the same range (days 1-29) takes hours and yields <b>20,300</b>. Query = 20,300 + 420 = <b>20,720</b>. Correct, but only after recomputing all of history in a second framework.", async st => {
          await rerun(st, 2, "rerunning days 1-29", 20300, "ok");
          st.m.hist = ["yes", "ok"];
          serve(st, TRUE, "20,300 + 420");
        }), step("The serving layer must know exactly which time range each view covers; get the boundary wrong by an hour and you double-count or skip events.", async st => {
          patch(st, st.m.marks, { boundary: true });
        })];
      }

      function kappaSteps(short) {
        const s1 = step("One stream job (v1) reads the log and maintains table_v1. Reads come from table_v1: <b>29,600</b>.", async st => {
          const m = st.m, live = [0, 1, 2].filter(i => !m.chips[i].gone);
          await flyAll(st, live.map(i => st.L.kIn(i, 0)), "c1");
          await flyPath(st, st.L.p2v[0], "c2", 380);
          m.reads = 0;
          m.view[0].value = 29600;
          serve(st, 29600, "from table_v1");
        }, short ? "With 7-day retention the log now holds only days 24-30; v1 counted days 1-23 as they arrived, before they expired." : "");
        const s2 = step("Bug found. The fix is written once (v2). Start job v2 as a new consumer at <b>offset 0</b>, writing to a new table_v2; v1 keeps serving live traffic.", async st => {
          const m = st.m, J = m.proc[1], T2 = m.view[1];
          Object.assign(J, { off: null, alpha: 0, sub: "starting at offset 0", tone: "warn" });
          Object.assign(T2, { off: null, alpha: 0, value: 0 });
          m.taps[1] = "warn";
          bugFound(st, { progress: { start: 0, day: 0 }, hist: ["replaying", "warn"], line: "jobs running: 2 (v1 and v2 of the same code)" });
          await ctx.tween({ ms: 500, onUpdate: k => { J.alpha = k; patch(st, T2, { alpha: k }); } });
        });
        // v2 has reached the head of the log: mark it live with the given status and tone.
        const caughtUp = (st, sub, tone, tap, hist) => {
          const m = st.m;
          Object.assign(m.proc[1], { sub, tone });
          Object.assign(m.marks, tone === "ok" ? { compare: true } : { cant: true });
          m.view[1].tone = tone;
          m.taps[1] = tap;
          patch(st, m, { hist });
        };
        if (!short) return [s1, s2, step("v2 replays history much faster than real time.", async st => {
          await replay(st, 0);
          await replay(st, 1);
        }, "29 days of events in minutes, while v1 keeps serving reads from table_v1."),
        step("v2 reaches the live head and processes today: table_v2 = <b>20,720</b>. Both tables are now current; compare them before switching.", async st => {
          await replay(st, 2);
          caughtUp(st, "caught up, live", "ok", "ok", ["in table_v2", "warn"]);
        }), step("Switch reads to table_v2. If v2 were wrong you could switch back instantly: the migration is reversible.", async st => {
          st.m.marks.compare = false;
          await ctx.tween({ ms: 700, onUpdate: k => patch(st, st.m, { reads: k }) });
          st.m.hist = ["yes", "ok"];
          serve(st, TRUE, "from table_v2");
        }), step("Delete job v1 and table_v1. One codebase, one system; history fixed by replay.", async st => {
          const m = st.m;
          m.proc[0].off = m.view[0].off = "deleted";
          m.taps[0] = null;
          patch(st, m, { line: "jobs running: 1" });
        })];
        return [s1, s2, step("v2 starts at the <b>oldest retained offset</b>. Days 1-23 were deleted by the 7-day retention policy, so they can never be replayed.", async st => {
          const m = st.m, pts = st.L.kIn(0, 1);
          m.chips[0].hot = true;
          m.proc[1].sub = "oldest offset: day 24";
          patch(st, m, { hist: ["impossible", "bad"] });
          await ctx.fly(st.pk, { from: pts[0], to: pts[pts.length - 1], fill: V("bad"), lost: 0.45, ms: 800 });
          patch(st, m.progress, { start: 23, day: 23 });
          await replay(st, 1);
        }), step("table_v2 = 4,200 + 420 = <b>4,620</b>: it is correct for the last 7 days and silent about everything before.", async st => {
          await replay(st, 2);
          caughtUp(st, "live, 23 days missing", "bad", "muted", ["impossible", "bad"]);
        }), step("Kappa needs the log to keep full history: long retention, log compaction (for keyed state), tiered storage on object storage, or a one-off backfill from an archive.", async st => {
          await blink(st, st.m.chips[0], "hot", true);
        })];
      }

      function setNote(k, i, n) {
        if (i < 0) note.set(`Pick an architecture and press <b>Play</b>. Video #42 really had <b>20,720</b> human plays. <span class="muted">This run: ${SCEN[k]}</span>`, "info");
        else if (i >= n - 1) note.set(...LESSON[k]);
        else note.set(`<b>This run:</b> ${SCEN[k]}`, "info");
      }

      // Builds the SVG and a fresh stepper for the current config. keep: replay to the same step
      // (used when the layout switches between phone and desktop).
      function restart(keep) {
        const idx = keep && player ? player.index : -1;
        // Let a step still animating in the old player finish instantly; its packets and redraws
        // land in the detached old SVG.
        if (player) { player.pause(); ctx.instant = true; }
        const my = ++gen, k = key();
        compact = ctx.compact;
        const L = layout(compact, cfg);
        const svg = ctx.svg({ w: L.W, h: L.H, label: "Event log feeding processing jobs, derived views and the read path for video 42's play count" });
        const hatch = `lvk-hatch-${ctx.uid}-${my}`;
        svg.defs.appendChild(s("pattern", { id: hatch, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
          s("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: V("muted"), "stroke-width": 1.5, opacity: 0.5 })));
        const layers = { base: s("g"), boxes: s("g"), marks: s("g"), pk: s("g") };
        Object.values(layers).forEach(g => svg.appendChild(g));
        const steps = cfg.arch === "lambda" ? lambdaSteps(cfg.fix === "both") : kappaSteps(cfg.keep === "7");
        player = ctx.stepper({
          steps, delay: 2600,
          intro: "Press <b>Play</b> or <b>Step ▶</b>: 30 days of plays for video #42, then a bug report.",
          init() {
            Object.values(layers).forEach(g => g.replaceChildren());
            const st = { gen: my, L, pk: layers.pk, m: newModel(cfg) };
            st.ups = drawScene(svg, L, layers, hatch);
            render(st);
            return st;
          },
          onStep: i => { if (my === gen) setNote(k, i, steps.length); },
        });
        stage.replaceChildren(svg);
        stepSlot.replaceChildren(player.el);
        setNote(k, -1, steps.length);
        ctx.after(0, () => { if (my === gen) { ctx.instant = false; if (idx >= 0) player.goto(idx); } });
      }

      restart(false);
      ctx.onResize(() => { if (ctx.compact !== compact) restart(true); });
    },
  });
})();
