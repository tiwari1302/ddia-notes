// PageRank in the Pregel / bulk synchronous parallel (BSP) model. Eight pages live in the memory
// of two workers. Each superstep every page reads the messages sent to it in the previous
// superstep, updates its rank and messages its out-links; a barrier separates supersteps.
// Placement changes how many messages cross the network but never the answer, and a worker
// crash rolls the whole graph back to the last checkpoint.
(function () {
  "use strict";
  const IDS = "ABCDEFGH".split("");
  const EDGES = "AB AC AE BA BC CA DA DC EF FA FE GC GD HA HG".split(" ").map(e => ({ from: e[0], to: e[1] }));
  const LINKS = new Set(EDGES.map(e => e.from + e.to));
  const N = IDS.length, DAMP = 0.85, BASE = (1 - DAMP) / N, EPS = 0.001, LAST = 10;
  const OUT = {}, IN = {};
  IDS.forEach(v => {
    OUT[v] = EDGES.filter(e => e.from === v).map(e => e.to);
    IN[v] = EDGES.filter(e => e.to === v).map(e => e.from);
  });
  const byId = f => Object.fromEntries(IDS.map(v => [v, f(v)]));
  const initial = () => byId(() => 1 / N);
  const share = (r, u) => r[u] / OUT[u].length;           // what u sends along each out-link
  const inboxSum = (prev, v) => IN[v].reduce((sum, u) => sum + share(prev, u), 0);
  // Superstep s >= 1: rank = (1 - d)/N + d * (sum of the shares sent to this page in s - 1).
  const nextRanks = prev => byId(v => BASE + DAMP * inboxSum(prev, v));
  const maxChange = (a, b) => Math.max(...IDS.map(v => Math.abs(a[v] - b[v])));
  const f3 = x => x.toFixed(3), f4 = x => x.toFixed(4);
  const span = (a, b) => (a === b ? "superstep " + a : `supersteps ${a}–${b}`);
  const STALE = {};

  // Two placements of the same graph. Positions are relative to the worker panel's corner and
  // were found by an offline search so that no link runs through a page it doesn't touch.
  const PARTS = {
    hash: {
      label: "Hash of page id", workers: ["ACEG", "BDFH"],
      desk: { A: [235, 184], B: [154, 96], C: [45, 135], D: [242, 145], E: [257, 67], F: [43, 66], G: [139, 90], H: [131, 196] },
      phone: { A: [210, 154], B: [124, 94], C: [115, 105], D: [37, 37], E: [305, 71], F: [305, 39], G: [37, 163], H: [262, 138] },
    },
    link: {
      label: "Link-aware", workers: ["ABCD", "EFGH"],
      desk: { A: [168, 184], B: [60, 153], C: [155, 69], D: [251, 110], E: [238, 105], F: [182, 194], G: [40, 64], H: [140, 73] },
      phone: { A: [187, 153], B: [268, 61], C: [120, 65], D: [47, 155], E: [203, 52], F: [303, 58], G: [86, 43], H: [108, 137] },
    },
  };
  Object.values(PARTS).forEach(p => {
    p.worker = v => (p.workers[0].includes(v) ? 0 : 1);
    const cross = EDGES.filter(e => p.worker(e.from) !== p.worker(e.to));
    p.cross = cross.length;
    // A sender-side combiner sums all messages bound for the same remote page into one.
    p.combined = new Set(cross.map(e => e.to)).size;
  });

  const LAYOUT = {
    desk: {
      W: 640, H: 320, fs: 12, rs: 12, rad: [22, 55, 40],
      panels: [{ x: 10, y: 8, w: 300, h: 236 }, { x: 330, y: 8, w: 300, h: 236 }],
      strip: { x: 10, y: 252, w: 620, h: 24 }, track: { x: 82, y: 290, w: 548, cell: 46, label: [10, 301.5] },
    },
    phone: {
      W: 360, H: 500, fs: 12, rs: 11, rad: [21, 45, 34],
      panels: [{ x: 8, y: 8, w: 344, h: 200 }, { x: 8, y: 248, w: 344, h: 200 }],
      strip: { x: 8, y: 216, w: 344, h: 24 }, track: { x: 8, y: 472, w: 344, cell: 28, label: [8, 461] },
    },
  };
  const STRIP = {   // fill, stroke, text
    idle: ["var(--viz-grid)", "var(--viz-grid)", "var(--viz-muted)"],
    phase: ["var(--viz-grid)", "var(--viz-grid)", "var(--viz-ink)"],
    barrier: ["var(--viz-warn-soft)", "var(--viz-warn)", "var(--viz-ink)"],
    ok: ["var(--viz-ok-soft)", "var(--viz-ok)", "var(--viz-ink)"],
    bad: ["var(--viz-bad-soft)", "var(--viz-bad)", "var(--viz-ink)"],
  };

  Viz.register("ch10/pregel-pagerank", {
    title: "PageRank, one superstep at a time",
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      // Model and display state live outside build() so a phone/desktop rebuild keeps them.
      let part = "hash", every = 2, selected = "A";
      let hist = [];                 // hist[s] = ranks after superstep s (superstep 0 sets 1/8)
      let ckpt = null;               // latest checkpoint: { step, ranks }
      const ckSteps = new Set(), redoneSteps = new Set();
      let redone = 0, netMsgs = 0, recovery = null, crashAt = null, lost = null, current = null;
      let running = false, busy = false, armed = false, handling = false, hot = false, w2 = "ok";
      let shown = initial(), strip = ["idle", "barrier"], noteState = ["", "info"];
      let epoch = 0, runToken = 0, view = null, compact = ctx.compact;
      const P = () => PARTS[part];
      const done = () => hist.length - 1;
      const ranks = () => (hist.length ? hist[done()] : initial());
      const change = () => (done() >= 1 ? maxChange(hist[done()], hist[done() - 1]) : null);
      const converged = () => change() !== null && change() < EPS;
      const dead = v => w2 === "crashed" && P().worker(v) === 1;

      // ------------------------------------------------------------ notes
      const linkTail = () => (part === "link"
        ? " Link-aware placement cuts network messages to 5 per superstep, and the ranks come out exactly the same." : "");
      const initialNote = () => "8 pages split over 2 workers. Each superstep, every page sends rank ÷ out-links to the pages " +
        "it links to; no page reads another's state directly. Press <b>Run</b>." + linkTail();
      function stepNote(sNum) {
        const cross = part === "hash" ? `${P().cross} crossed between workers (hash partitioning ignores the link structure)`
          : `only ${P().cross} crossed between workers`;
        const head = sNum === 0 ? "Superstep 0: every page set its rank to 1/8 and sent rank ÷ out-links along each link: " : `Superstep ${sNum}: `;
        const tail = sNum === 0 ? " Next superstep each page adds up only what it received; Pregel delivers every message exactly once, in the following superstep."
          : ` Biggest rank change ${f4(change())}: not converged yet.`;
        return `${head}${EDGES.length} messages, ${cross}.${tail}${linkTail()}`;
      }
      function convergedNote() {
        const r = ranks();
        return `Converged at superstep ${done()}: a global <b>aggregator</b> (the max of every page's change) saw ` +
          `${f4(change())} &lt; 0.001, so in the next superstep every page votes to halt without sending, and the job ends. ` +
          `A, with 5 incoming links, has the highest rank (${f3(r.A)}); H, with none, keeps only the 0.15/8 baseline (${f3(r.H)}).` +
          (redone ? ` The crash cost ${redone} redone superstep${redone > 1 ? "s" : ""}, yet the ranks equal a crash-free run.` : "") +
          linkTail();
      }
      function rollbackNote(sNum, c) {
        const redo = span(c + 1, sNum);
        if (ckpt) {
          return `Worker 2 crashed and its in-memory ranks are gone. Pregel rolls the <b>whole</b> graph back to the checkpoint ` +
            `at superstep ${c} and recomputes ${redo}. Worker 1's pages roll back too, so every page restarts from the same ` +
            "superstep (with logged messages, only Worker 2's pages would need recomputing).";
        }
        if (every) return `Worker 2 crashed before the first checkpoint was written, so the <b>whole</b> graph restarts from superstep 0 and recomputes ${redo}.`;
        return `Worker 2 crashed and its in-memory ranks are gone. No checkpoint: everything restarts from superstep 0 and recomputes ${redo}. ` +
          "Frequent checkpoints cost I/O every few supersteps but cap how much work a crash can throw away.";
      }
      function say(html, tone) { noteState = [html, tone]; if (view) view.note.set(html, tone); }

      // ------------------------------------------------------------ scene
      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const g = LAYOUT[compact ? "phone" : "desk"];
        const partSeg = ui.segmented({
          label: "Partitioning", value: part, onChange: setPartition,
          options: Object.entries(PARTS).map(([value, p]) => ({ value, label: p.label })),
        });
        const ckSeg = ui.segmented({
          label: "Checkpoint every", value: every ? String(every) : "Off", options: ["2", "5", "Off"],
          onChange: v => { every = v === "Off" ? 0 : Number(v); },
        });
        const run = ui.button("▶ Run", toggleRun, { kind: "primary" });
        const step = ui.button("Step superstep", () => { if (!running && !busy) superstep(); });
        const reset = ui.button("⟲ Reset", () => { resetModel(); renderAll(); }, { kind: "ghost" });
        const crash = ui.button("Crash worker 2", armCrash, { kind: "danger" });
        const actions = ui.bar(run, step, reset, crash);
        actions.classList.add("viz-step-controls");   // lets check-viz --steps find the Step button
        const stats = ui.stats([["step", "Superstep"], ["cross", "Cross-worker messages"], ["net", "Network messages so far"],
          ["change", "Max rank change"], ["ckpt", "Last checkpoint"], ["redo", "Supersteps redone"]].map(([key, label]) => ({ key, label })));
        if (!compact) stats.style.gridTemplateColumns = "repeat(3, 1fr)";   // six narrow cards would wrap their values
        const legend = ui.legend([
          { color: "var(--viz-c2)", label: "page (radius = rank)", shape: "dot" },
          { color: "var(--viz-node-stroke)", label: "local message", shape: "line" },
          { color: "var(--viz-warn)", label: "cross-worker message", shape: "dash" },
          { color: "var(--viz-ok)", label: "checkpoint", shape: "square" },
          { color: "var(--viz-bad)", label: "superstep redone after a crash", shape: "square" },
        ]);
        const note = ui.note("");
        const inspect = h("div", { style: "font-size:13px;line-height:1.55;padding:8px 12px;margin-top:10px;border:1px dashed var(--viz-line);border-radius:10px" });
        view = { g, ...buildScene(g), run, step, crash, stats, note, inspect };
        root.append(ui.bar(partSeg, ckSeg), actions, view.svg, legend, stats, note, inspect);
        renderAll();
      }

      function buildScene(g) {
        const svg = ctx.svg({ w: g.W, h: g.H, label: "Eight web pages on two workers exchanging PageRank messages in supersteps" });
        const layer = () => svg.appendChild(s("g"));
        const panelL = layer(), edgeL = layer(), stripL = layer(), nodeL = layer(), packets = layer(), trackL = layer();
        const panels = g.panels.map((p, i) => {
          // On phones Worker 2's header sits at its bottom, away from the links crossing the barrier.
          const rect = s("rect", { x: p.x, y: p.y, width: p.w, height: p.h, rx: 10, "stroke-width": 1.5 });
          const ty = compact && i === 1 ? p.y + p.h - 16 : p.y + 18;
          const title = ctx.text(p.x + 12, ty, "", { size: g.fs + 1, weight: 700, anchor: "start" });
          const sub = ctx.text(p.x + p.w - 12, ty, "", { size: g.fs, anchor: "end", fill: "var(--viz-muted)" });
          panelL.append(rect, title, sub);
          return { rect, title, sub };
        });
        const edges = EDGES.map(e => ({ ...e, path: edgeL.appendChild(s("path", { fill: "none", "stroke-width": 1.8 })) }));
        const st = g.strip;
        stripL.appendChild(s("rect", { x: st.x, y: st.y, width: st.w, height: st.h, rx: 6, fill: "var(--viz-bg)" }));   // hides links below
        const stripRect = stripL.appendChild(s("rect", { x: st.x, y: st.y, width: st.w, height: st.h, rx: 6, "stroke-width": 1.2 }));
        const stripText = stripL.appendChild(ctx.text(st.x + st.w / 2, st.y + st.h / 2 + 0.5, "", { size: 12, weight: 600 }));
        const nodes = byId(v => makeNode(nodeL, v, g));
        const tr = g.track, gap = (tr.w - (LAST + 1) * tr.cell) / LAST;
        trackL.appendChild(ctx.text(tr.label[0], tr.label[1], compact ? "supersteps" : "superstep", { size: g.fs, anchor: "start", fill: "var(--viz-muted)" }));
        const cells = [];
        for (let i = 0; i <= LAST; i++) {
          const x = tr.x + i * (tr.cell + gap);
          const rect = s("rect", { x, y: tr.y, width: tr.cell, height: 22, rx: 5 });
          const label = ctx.text(x + tr.cell / 2, tr.y + 11.5, String(i), { size: g.fs, mono: true });
          const mark = s("rect", { x: x + tr.cell - 6, y: tr.y - 4, width: 9, height: 9, rx: 2, fill: "var(--viz-ok)", stroke: "var(--viz-bg)", "stroke-width": 1.5 });
          trackL.append(rect, label, mark);
          cells.push({ rect, label, mark });
        }
        return { svg, panels, edges, nodes, packets, stripRect, stripText, cells };
      }

      function makeNode(layer, v, g) {
        const el = layer.appendChild(s("g", { style: "cursor:pointer" }));
        const n = {
          el, x: 0, y: 0, r: g.rad[0],
          ring: s("circle", { fill: "none", stroke: "var(--viz-c1)", "stroke-width": 1.5, "stroke-dasharray": "3 3" }),
          under: s("circle", { fill: "var(--viz-bg)" }),
          circle: s("circle", { fill: "var(--viz-c2-soft)" }),
          letter: ctx.text(0, 0, v, { size: 13, weight: 700 }),
          value: ctx.text(0, 0, "", { size: g.rs, mono: true }),
        };
        el.append(n.ring, n.under, n.circle, n.letter, n.value);
        el.addEventListener("click", () => { selected = v; renderSelection(); renderInspector(); });
        return n;
      }
      function placeNode(n, o) {
        Object.assign(n, o);
        [n.under, n.circle].forEach(c => ctx.attr(c, { cx: n.x, cy: n.y, r: n.r }));
        ctx.attr(n.ring, { cx: n.x, cy: n.y, r: n.r + 5 });
        ctx.attr(n.letter, { x: n.x, y: n.y - 6 });
        ctx.attr(n.value, { x: n.x, y: n.y + 8 });
      }
      function homeOf(v) {
        const p = P(), pan = view.g.panels[p.worker(v)], rel = p[compact ? "phone" : "desk"][v];
        return { x: pan.x + rel[0], y: pan.y + rel[1] };
      }
      const radius = r => { const [lo, k, hi] = view.g.rad; return ctx.clamp(lo + k * r, lo, hi); };

      // Quadratic path between circle borders; reciprocal links bow apart so both arrows show.
      function edgeGeom(e) {
        const a = view.nodes[e.from], b = view.nodes[e.to];
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        const off = LINKS.has(e.to + e.from) ? Math.min(24, 0.18 * len) : 0;
        const c = [(a.x + b.x) / 2 - (dy / len) * off, (a.y + b.y) / 2 + (dx / len) * off];
        const rim = (n, gap) => {
          const ux = c[0] - n.x, uy = c[1] - n.y, l = Math.hypot(ux, uy) || 1;
          return [n.x + (ux / l) * (n.r + gap), n.y + (uy / l) * (n.r + gap)];
        };
        return { p0: rim(a, 1), c, p1: rim(b, 3) };
      }
      function layoutEdges() {
        const r1 = x => x.toFixed(1);
        view.edges.forEach(e => {
          const { p0, c, p1 } = edgeGeom(e);
          e.path.setAttribute("d", `M${r1(p0[0])},${r1(p0[1])} Q${r1(c[0])},${r1(c[1])} ${r1(p1[0])},${r1(p1[1])}`);
        });
      }
      function styleEdges() {
        const p = P();
        view.edges.forEach(e => {
          e.cross = p.worker(e.from) !== p.worker(e.to);
          const color = e.cross ? "var(--viz-warn)" : "var(--viz-node-stroke)";
          ctx.attr(e.path, { stroke: color, "stroke-dasharray": e.cross ? "6 5" : "none", "marker-end": view.svg.arrow(color) });
        });
      }

      // ------------------------------------------------------------ rendering
      function renderNodes() {
        const conv = converged();
        IDS.forEach(v => {
          const n = view.nodes[v];
          placeNode(n, { r: radius(shown[v]) });
          n.value.textContent = dead(v) ? "?" : f3(shown[v]);
          n.el.setAttribute("opacity", dead(v) ? 0.5 : 1);
          ctx.attr(n.circle, {
            stroke: hot ? "var(--viz-c1)" : conv ? "var(--viz-ok)" : "var(--viz-c2)",
            "stroke-width": hot ? 3.5 : conv ? 3 : 2,
          });
        });
      }
      function renderPanels() {
        const conv = converged();
        view.panels.forEach((p, i) => {
          const bad = i === 1 && w2 === "crashed";
          ctx.attr(p.rect, { fill: bad ? "var(--viz-bad-soft)" : "var(--viz-panel)", stroke: bad ? "var(--viz-bad)" : "var(--viz-line)" });
          p.title.textContent = i === 0 ? "Worker 1" : { ok: "Worker 2", crashed: "Worker 2 ✕ crashed", replacement: "Worker 2 (replacement)" }[w2];
          ctx.attr(p.title, { fill: bad ? "var(--viz-bad)" : "var(--viz-ink)" });
          p.sub.textContent = bad ? "ranks lost" : conv ? "4 pages · halted"
            : i === 1 && w2 === "replacement" ? "ranks reloaded" : "4 pages · in memory";
        });
      }
      function renderTrack() {
        const d = done(), conv = converged();
        view.cells.forEach((c, i) => {
          const kind = (lost && i >= lost[0] && i <= lost[1]) ? "bad" : i === current ? "c1"
            : i > d ? null : redoneSteps.has(i) ? "bad" : conv && i === d ? "ok" : "c2";
          ctx.attr(c.rect, {
            fill: kind ? `var(--viz-${kind}-soft)` : "var(--viz-bg)",
            stroke: kind ? `var(--viz-${kind})` : "var(--viz-line)", "stroke-width": i === current ? 2 : 1.2,
          });
          ctx.attr(c.label, { fill: kind ? "var(--viz-ink)" : "var(--viz-muted)" });
          c.mark.style.display = ckSteps.has(i) && i <= d ? "" : "none";
        });
      }
      function setStrip(kind, text) {
        strip = [kind, text];
        if (!view) return;
        const [fill, stroke, ink] = STRIP[kind];
        ctx.attr(view.stripRect, { fill, stroke });
        ctx.attr(view.stripText, { fill: ink });
        view.stripText.textContent = text;
      }
      function renderSelection() { IDS.forEach(v => { view.nodes[v].ring.style.display = v === selected ? "" : "none"; }); }

      // "Think like a vertex": the selected page's own view of the last superstep.
      function renderInspector() {
        const v = selected, d = done(), p = P(), k = OUT[v].length;
        const sends = x => `${f4(x / k)} ${k > 1 ? "to each of" : "to"} ${OUT[v].join(", ")}`;
        let body;
        if (dead(v)) body = "It lived on Worker 2, so its rank vanished with the crash.";
        else if (d < 0) body = `It starts at 1/8 = 0.125; in superstep 0 it will send 0.125 ÷ ${k} = ${sends(1 / N)}.`;
        else if (d === 0) body = `Superstep 0: rank = 1/8 = 0.125, then it sent ${sends(1 / N)}.`;
        else {
          const prev = hist[d - 1], sum = inboxSum(prev, v);
          const remote = IN[v].filter(u => p.worker(u) !== p.worker(v));
          const terms = IN[v].map(u => {
            const t = `${f4(share(prev, u))} from ${u}`;
            return remote.includes(u) ? `<span style="color:var(--viz-warn);font-weight:600">${t}</span>` : t;
          });
          const other = p.worker(v) === 0 ? 2 : 1;
          body = `Superstep ${d}. Inbox: ${terms.length ? terms.join(" + ") + " = " + f4(sum) : "empty (no page links here)"}. ` +
            `compute(): 0.15/8 + 0.85 × ${f4(sum)} = <b>${f4(hist[d][v])}</b>, then it sends ${sends(hist[d][v])}.` +
            (remote.length > 1 ? ` The amber messages crossed the network; a combiner on Worker ${other} could pre-sum those ${remote.length} into one.`
              : remote.length ? " The amber message crossed the network." : "");
        }
        view.inspect.innerHTML = `<b>Think like a vertex: page ${v}</b> <span style="color:var(--viz-muted)">(tap any page)</span><br>${body}`;
      }

      function sync() {
        if (!view) return;
        const conv = converged(), d = done(), p = P(), ch = change();
        const sub = t => `<div style="font-size:11.5px;font-weight:600;opacity:.85;margin-top:2px">${t}</div>`;
        view.run.setLabel(running ? "❚❚ Pause" : conv ? "✓ Converged" : "▶ Run").disable(conv && !running);
        view.step.disable(running || busy || conv);
        view.crash.setLabel(armed ? "Crash pending…" : "Crash worker 2").disable(d < 1 || conv || armed || handling);
        view.stats.set("step", d < 0 ? "–" : String(d));
        const pct = `<span style="font-size:13px;font-weight:700;opacity:.85">${Math.round((100 * p.cross) / EDGES.length)}%</span>`;
        view.stats.set("cross", `${p.cross} of ${EDGES.length} ${pct}` + sub(`${p.combined} with a combiner`), part === "hash" ? "warn" : "ok");
        view.stats.set("net", String(netMsgs));
        view.stats.set("change", ch === null ? "–" : f4(ch) + (conv ? sub("✓ converged") : ""), conv ? "ok" : "");
        view.stats.set("ckpt", ckpt ? `<span style="font-size:14px">superstep</span> ${ckpt.step}` : "none");
        view.stats.set("redo", String(redone), redone ? "bad" : "");
      }
      function refresh() { renderPanels(); renderNodes(); renderTrack(); renderInspector(); sync(); }
      function renderAll() {
        IDS.forEach(v => placeNode(view.nodes[v], homeOf(v)));
        styleEdges(); layoutEdges(); renderSelection(); setStrip(...strip); view.note.set(...noteState);
        refresh();
      }

      // ------------------------------------------------------------ animation pieces
      function tweenRanks(next, ms) {
        const my = epoch, v0 = view, from = { ...shown };
        return ctx.tween({ ms, ease: "inOut", onUpdate: k => {
          if (my !== epoch || v0 !== view) return;
          shown = byId(v => ctx.lerp(from[v], next[v], k));
          renderNodes(); layoutEdges();
        } });
      }
      // A message packet following its link's curve; `lostAt` drops it part-way.
      function fly(e, fill, lostAt) {
        const { p0, c, p1 } = edgeGeom(e), stop = lostAt || 1;
        const dot = view.packets.appendChild(s("circle", { r: 5, fill, stroke: "var(--viz-bg)", "stroke-width": 1.5 }));
        const at = t => { const u = 1 - t; ctx.attr(dot, { cx: u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], cy: u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1] }); };
        at(0);
        return ctx.tween({ ms: 700 * stop, ease: "inOut", onUpdate: k => at(k * stop) }).then(async () => {
          if (lostAt) {
            ctx.attr(dot, { fill: "var(--viz-bad)" });
            await ctx.tween({ ms: 400, onUpdate: k => dot.setAttribute("opacity", 1 - k) });
          }
          dot.remove();
        });
      }
      function sendAll(dropW2, my) {
        const p = P();
        const flights = view.edges.map(e => {
          const lostAt = !dropW2 ? 0 : p.worker(e.from) === 1 ? 0.5 : p.worker(e.to) === 1 ? 0.9 : 0;
          return fly(e, e.cross ? "var(--viz-warn)" : "var(--viz-c2)", lostAt);
        });
        if (dropW2) flights.push(ctx.sleep(350).then(() => { if (my === epoch) crashW2(); }));
        return Promise.all(flights);
      }
      function crashW2() {
        w2 = "crashed"; armed = false; handling = true; crashAt = done() + 1;
        say(`Worker 2 crashed in superstep ${done() + 1}: its in-memory ranks are gone, so the barrier can never complete.`, "bad");
        refresh();
      }

      // ------------------------------------------------------------ supersteps
      async function superstep() {
        const my = epoch, sNum = done() + 1;
        const wait = async promise => { await promise; if (my !== epoch || !ctx.alive) throw STALE; };
        const next = sNum === 0 ? initial() : nextRanks(ranks());
        busy = true; current = sNum;
        renderTrack(); sync();
        try {
          // 1. compute: every page reads only its inbox and updates its own rank
          hot = true;
          setStrip("phase", `superstep ${sNum} · ① compute: ${sNum ? "each page sums its inbox" : "every page sets rank = 1/8"}`);
          await wait(tweenRanks(next, 300));
          // 2. send: rank ÷ out-links along every link (a pending crash strikes mid-flight)
          hot = false; renderNodes();
          setStrip("phase", `superstep ${sNum} · ② send rank ÷ out-links on each link`);
          await wait(sendAll(armed, my));
          if (armed || crashAt !== null) { await crashAndRollback(sNum, wait); return true; }
          // 3. barrier: nobody starts superstep s + 1 until every worker and message is done
          setStrip("barrier", "③ BARRIER · waiting for all workers and messages");
          await wait(ctx.sleep(400));
          const wrote = every > 0 && sNum > 0 && sNum % every === 0;
          commit(sNum, next, wrote);
          if (wrote) {
            setStrip("ok", `checkpoint saved (superstep ${sNum})`);
            await wait(ctx.sleep(450));   // writing state to durable storage costs time on the happy path
          }
          if (converged()) setStrip("ok", "✓ converged · every page voted to halt");
          else if (!wrote) setStrip("idle", sNum ? `barrier passed · aggregator: max change ${f4(change())}` : "barrier");
          return true;
        } catch (e) {
          if (e !== STALE) throw e;
          return false;
        } finally {
          if (my === epoch) { busy = false; current = null; renderTrack(); sync(); }
        }
      }
      function commit(sNum, next, wrote) {
        hist.push(next);
        netMsgs += P().cross;
        if (wrote) { ckpt = { step: sNum, ranks: { ...next } }; ckSteps.add(sNum); }
        shown = { ...next }; current = null;
        if (recovery) redoneSteps.add(sNum);
        if (converged()) { armed = false; say(convergedNote(), "ok"); }
        else if (recovery && sNum < recovery.from) {
          say(`Recomputing superstep ${sNum} (rolled back from the crash in superstep ${recovery.from}): same inputs, same code, so the same ranks come out.`, "warn");
        } else if (recovery) {
          say(`Caught up to superstep ${sNum}, where the crash hit. Because PageRank is deterministic, the recomputed ranks are exactly ` +
            `what a crash-free run has; the crash cost ${redone} redone superstep${redone > 1 ? "s" : ""}.`, "ok");
        } else say(stepNote(sNum), "info");
        if (recovery && sNum >= recovery.from) recovery = null;
        refresh();
      }
      async function crashAndRollback(sNum, wait) {
        if (w2 !== "crashed") crashW2();   // armed after the packets left: crash at the end of the send
        current = null;
        const c = ckpt ? ckpt.step : 0;
        lost = [c + 1, sNum];
        renderTrack(); sync();
        setStrip("bad", "BARRIER · Worker 2 never arrives");
        await wait(ctx.sleep(800));
        rollback();
        setStrip("bad", c ? `rollback: every page reloads checkpoint ${c}` : "rollback: every page restarts from the input");
        await wait(tweenRanks(ranks(), 500));
        if (running) await wait(ctx.sleep(1600));   // give the reader time before the redo starts
        handling = false;
      }
      // Both workers restart from the last checkpoint; Worker 2 comes back on a replacement machine.
      function rollback() {
        const sNum = crashAt, c = ckpt ? ckpt.step : 0;
        say(rollbackNote(sNum, c), "bad");
        redone += sNum - c;
        netMsgs += P().cross;          // the crashed superstep had already sent its messages
        hist = hist.slice(0, c + 1);
        if (ckpt) hist[c] = { ...ckpt.ranks };
        w2 = "replacement"; lost = null; crashAt = null;
        recovery = { from: sNum, to: c };
        refresh();
      }

      // ------------------------------------------------------------ controls
      function toggleRun() {
        if (running) { running = false; sync(); return; }
        if (!converged()) runLoop();
      }
      async function runLoop() {
        const my = epoch, tok = ++runToken;
        const live = () => running && my === epoch && tok === runToken && ctx.alive;
        running = true; sync();
        while (live() && !converged()) {
          // Hold while scrolled away (or while a Step is finishing) so nothing is missed.
          if (busy || !ctx.visible) { await new Promise(r => setTimeout(r, 150)); continue; }
          if (!(await superstep())) break;
        }
        if (my === epoch && tok === runToken) { running = false; sync(); }
      }
      function armCrash() {
        armed = true; sync();
        if (!busy) say("Worker 2 will crash during the next superstep, while its messages are in flight and before the barrier. Press <b>Step superstep</b> or <b>Run</b>.", "warn");
      }
      function resetModel() {
        epoch++; runToken++;
        running = busy = armed = handling = hot = false;
        hist = []; ckpt = null; ckSteps.clear(); redoneSteps.clear();
        redone = netMsgs = 0; recovery = crashAt = lost = current = null; w2 = "ok";
        shown = initial(); strip = ["idle", "barrier"]; noteState = [initialNote(), "info"];
        if (view) view.packets.innerHTML = "";
      }
      // Re-placing the graph restarts the job; pages glide to their new worker.
      function setPartition(value) {
        const from = byId(v => ({ x: view.nodes[v].x, y: view.nodes[v].y }));
        part = value;
        resetModel(); renderAll();
        const my = epoch, v0 = view, to = byId(homeOf);
        const move = k => { IDS.forEach(v => placeNode(view.nodes[v], { x: ctx.lerp(from[v].x, to[v].x, k), y: ctx.lerp(from[v].y, to[v].y, k) })); layoutEdges(); };
        move(0);
        ctx.tween({ ms: 650, ease: "inOut", onUpdate: k => { if (my === epoch && v0 === view) move(k); } });
      }

      resetModel();
      build();
      // Rebuild with the other layout when the frame crosses the phone breakpoint (deferred, so the
      // rebuild doesn't resize the frame inside the ResizeObserver callback).
      function relayout() {
        if (ctx.compact === compact) return;
        const wasRunning = running;
        if (busy || crashAt !== null) {     // abandon the superstep in flight; finish a pending rollback
          epoch++; runToken++;
          if (crashAt !== null) rollback();
          running = busy = handling = hot = false; current = null; shown = { ...ranks() }; strip = ["idle", "barrier"];
        }
        build();
        if (wasRunning && !running) runLoop();
      }
      ctx.onResize(() => ctx.after(0, relayout));
    },
  });
})();
