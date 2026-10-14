// Lamport clocks vs vector clocks. Build a three-process history out of local events and
// messages, then select events: Lamport timestamps never contradict causality, but they
// also put concurrent events in an order that means nothing. Vector clocks tell the two apart.
(function () {
  "use strict";

  const LANES = [
    { id: "p0", label: "P1", color: "c2" },
    { id: "p1", label: "P2", color: "c5" },
    { id: "p2", label: "P3", color: "c8" },
  ];
  const local = (p, tag) => ({ type: "local", p, tag });
  const msg = (from, to, tag) => ({ type: "msg", from, to, tag });

  const ACTIONS = [
    ["l0", "P1: local event", local(0)], ["l1", "P2: local event", local(1)], ["l2", "P3: local event", local(2)],
    ["m01", "P1 → P2 message", msg(0, 1)], ["m10", "P2 → P1 message", msg(1, 0)],
    ["m12", "P2 → P3 message", msg(1, 2)], ["m21", "P3 → P2 message", msg(2, 1)],
    ["m02", "P1 → P3 message", msg(0, 2)], ["m20", "P3 → P1 message", msg(2, 0)],
  ];
  const ACTION_BY_KEY = Object.fromEntries(ACTIONS.map(([k, , a]) => [k, a]));

  // Event ids are "<action index><l|s|r>" (local, send, receive), so they survive rebuilds.
  const PRESETS = {
    concurrency: {
      actions: [local(2), local(2), local(2), msg(0, 1), local(1), msg(1, 2)],
      select: ["3s", "2l"],
    },
    race: {
      actions: [
        local(2, { text: "claim @ana" }),
        local(0), local(0),
        local(0, { text: "claim @ana · granted", anchor: "end" }),
        // `reveals`: once this receive exists, earlier tags on the same process turn red.
        msg(2, 0, { text: "learns P3 claimed first", anchor: "start", bad: true, reveals: true }),
      ],
      select: ["0l", "3l"],
    },
  };

  // ---------------------------------------------------------------- pure model
  /** Replays the actions; each event gets its own column, Lamport counter L and vector V. */
  function buildHistory(actions) {
    const L = [0, 0, 0], V = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const events = [], msgs = [];
    const push = (ai, kind, p, tag, prev) => {
      const e = { id: ai + kind[0], ai, kind, p, col: events.length, L: L[p], V: V[p].slice(), tag, prev };
      events.push(e);
      return e;
    };
    actions.forEach((a, ai) => {
      if (a.type === "local") { L[a.p]++; V[a.p][a.p]++; push(ai, "local", a.p, a.tag); return; }
      L[a.from]++; V[a.from][a.from]++;
      const send = push(ai, "send", a.from);
      const prev = { L: L[a.to], V: V[a.to].slice() };
      L[a.to] = Math.max(L[a.to], send.L) + 1;
      V[a.to] = V[a.to].map((v, i) => Math.max(v, send.V[i]));
      V[a.to][a.to]++;
      msgs.push({ send, recv: push(ai, "recv", a.to, a.tag, prev) });
    });
    // Ground truth: happens-before = reachability along process order and send -> receive.
    const succ = events.map(() => []);
    const last = [-1, -1, -1];
    events.forEach((e, i) => { if (last[e.p] >= 0) succ[last[e.p]].push(i); last[e.p] = i; });
    msgs.forEach(m => succ[m.send.col].push(m.recv.col));
    const reach = events.map(() => new Set());
    for (let i = events.length - 1; i >= 0; i--) {
      for (const j of succ[i]) { reach[i].add(j); reach[j].forEach(k => reach[i].add(k)); }
    }
    return { events, msgs, succ, reach, cols: events.length };
  }

  const hb = (hist, a, b) => hist.reach[a.col].has(b.col);
  const vecLeq = (a, b) => a.every((v, i) => v <= b[i]);
  const lamportLess = (a, b) => a.L < b.L || (a.L === b.L && a.p < b.p);
  const lamportOrder = events => events.slice().sort((a, b) => a.L - b.L || a.p - b.p);
  const stamp = e => `(${e.L},P${e.p + 1})`;
  const KIND_NAME = { local: "local", send: "send", recv: "receive" };
  const vecStr = V => `[${V.join(",")}]`;

  /** One shortest chain of process steps and messages from a to b (requires a -> b). */
  function pathBetween(hist, a, b) {
    const parent = new Map([[a.col, -1]]), queue = [a.col];
    while (queue.length) {
      const i = queue.shift();
      if (i === b.col) break;
      for (const j of hist.succ[i]) if (!parent.has(j)) { parent.set(j, i); queue.push(j); }
    }
    const steps = [];
    for (let i = b.col; parent.get(i) !== -1; i = parent.get(i)) steps.unshift([parent.get(i), i]);
    return steps;
  }

  /** Developer assertion: vectors must match reachability exactly, Lamport must respect it. */
  function checkClocks(hist) {
    for (const a of hist.events) for (const b of hist.events) {
      if (a === b) continue;
      const before = hb(hist, a, b);
      if (vecLeq(a.V, b.V) !== before) console.error(`[ch9/logical-clocks] vector clock disagrees with happens-before for ${stamp(a)}, ${stamp(b)}`);
      if (before && !(a.L < b.L)) console.error(`[ch9/logical-clocks] Lamport clock violates causality for ${stamp(a)}, ${stamp(b)}`);
    }
  }

  const STYLE = `
.lc-strip { margin-top: 10px; }
.lc-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; font-size: 12.5px; color: var(--text-muted); margin-bottom: 6px; }
.lc-head b { font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; }
.lc-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 0; min-height: 26px; }
.lc-pair { display: inline-flex; align-items: center; }
.lc-chip { font-family: var(--font-mono); font-size: 12px; font-weight: 700; line-height: 1.4; padding: 2px 6px; border-radius: 6px;
  border: 1px solid var(--border-strong); background: var(--viz-panel); cursor: pointer; }
.lc-chip b { color: var(--viz-ink); margin-right: 4px; }
.lc-chip.is-sel { outline: 2px solid var(--viz-ink); outline-offset: 1px; }
.lc-chip.past { background: var(--viz-ok-soft); border-color: var(--viz-ok); }
.lc-chip.future { background: var(--viz-info-soft); border-color: var(--viz-info); }
.lc-chip.conc { opacity: 0.45; }
.lc-sep { font-family: var(--font-mono); font-size: 13px; color: var(--viz-muted); padding: 0 4px; }
.lc-sep.conc { color: var(--viz-warn); font-weight: 800; letter-spacing: -1px; }
.lc-empty { font-size: 12.5px; color: var(--text-muted); }
.lc-sv { font-family: var(--font-mono); font-size: 14px; font-weight: 700; white-space: nowrap; }
.lc-ss { font-size: 11.5px; font-weight: 600; margin-top: 2px; opacity: 0.9; }
.lc-hint { color: var(--text-muted); font-style: italic; }
.lc-hit { cursor: pointer; outline: none; }
.lc-hit:focus-visible { stroke: var(--viz-ink); stroke-width: 1.5; stroke-dasharray: 3 3; }`;

  Viz.register("ch9/logical-clocks", {
    title: "Lamport clocks vs vector clocks",
    model: { buildHistory, lamportOrder, pathBetween, PRESETS, hb, vecLeq }, // for offline tests
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      // State outside build() so a phone <-> desktop rebuild keeps it.
      let actions = [], hist = buildHistory([]), sel = [], preset = null;
      let choice = "m01", showVec = true, flash = null, focusId = null;
      let compact = ctx.compact, view = null;

      const layout = () => compact
        ? { W: 360, H: 236, ly: 14, lh: 206, gutter: 36, maxCols: 10, font: 11, r: 7, selR: 9, ringR: 12, lamY: -18, tagY: -33, vecY: [19, 32], nudge: 7 }
        : { W: 640, H: 232, ly: 12, lh: 200, gutter: 48, maxCols: 14, font: 12, r: 7, selR: 9.5, ringR: 12.5, lamY: -19, tagY: -35, vecY: [21, 35], nudge: 9 };
      const laneColor = p => `var(--viz-${LANES[p].color})`;
      const byId = id => hist.events.find(e => e.id === id);
      const mono = t => `<span class="mono">${t}</span>`;
      const two = (top, sub) => `<div class="lc-sv">${top}</div><div class="lc-ss">${sub}</div>`;

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const G = layout();
        const svg = ctx.svg({ w: G.W, h: G.H, label: "Space-time diagram of three processes with Lamport and vector clocks" });
        svg.setAttribute("role", "group");
        const tl = ctx.lanes({
          parent: svg, x: 0, y: G.ly, w: G.W, h: G.lh, t0: 0.5, t1: G.maxCols + 0.5,
          labelWidth: G.gutter, labelSize: compact ? 12 : 13, lanes: LANES,
        });
        // Phones get short option labels and no "Action" caption so the row fits on one line.
        const shortLabel = l => l.replace(": local event", " local").replace(" message", " msg");
        const actionSel = ui.select({
          label: compact ? null : "Action", value: choice,
          options: ACTIONS.map(([value, label]) => ({ value, label: compact ? shortLabel(label) : label })),
          onChange: v => { choice = v; render(); },
        });
        actionSel.querySelector("select").setAttribute("aria-label", "Action");
        const addBtn = ui.button("Add", add, { kind: "primary" });
        const undoBtn = ui.button("Undo", () => { setHistory(actions.slice(0, -1)); render(); }, { kind: "ghost" });
        const clearBtn = ui.button("Clear", () => { setHistory([]); render(); }, { kind: "ghost" });
        const vecToggle = ui.toggle({ label: "Vector clocks", value: showVec, onChange: v => { showVec = v; render(); } });
        const scenario = ui.segmented({
          label: "Scenario", value: preset,
          options: [{ value: "concurrency", label: "Concurrency" }, { value: "race", label: "Username race" }],
          onChange: loadPreset,
        });
        const chips = h("div", { class: "lc-chips" });
        const strip = h("div", { class: "lc-strip" },
          h("div", { class: "lc-head" }, h("b", null, "Lamport total order"),
            h("span", { html: '<span class="lc-sep">→</span>happened before <span class="lc-sep conc">||</span>concurrent: arbitrary order' })),
          chips);
        const stats = ui.stats([
          { key: "hb", label: "Happens-before" }, { key: "lam", label: "Lamport" }, { key: "vec", label: "Vectors" },
        ]);
        if (compact) { stats.style.gridTemplateColumns = "1fr 1fr"; stats.lastChild.style.gridColumn = "1 / -1"; }
        const note = ui.note("");
        const legend = ui.legend([
          { color: "var(--viz-ok)", label: "A's causal past" },
          { color: "var(--viz-info)", label: "A's causal future" },
          { color: "var(--viz-muted)", label: "concurrent with A (faded)" },
          { color: "var(--viz-ok)", label: "chain from earlier to later", shape: "line" },
        ]);
        legend.prepend(h("span", { class: "lc-hint" }, "Tap events or chips to pick A and B."));
        root.append(h("style", { text: STYLE }), ui.bar(actionSel, addBtn, undoBtn, clearBtn), ui.bar(vecToggle, scenario),
          svg, strip, stats, note, legend);
        view = { G, svg, tl, chips, stats, note, addBtn, undoBtn, clearBtn, scenario, drawn: new Map(), lines: new Map() };
        render();
      }

      // ------------------------------------------------------------ state changes
      function setHistory(next, keepPreset) {
        actions = next;
        hist = buildHistory(actions);
        checkClocks(hist);
        sel = sel.filter(byId);
        flash = null;
        if (!keepPreset) { preset = null; view.scenario.set(null); }
      }
      function loadPreset(name) {
        setHistory(PRESETS[name].actions, true);
        preset = name;
        sel = PRESETS[name].select.slice();
        render();
      }
      function add() {
        setHistory(actions.concat([ACTION_BY_KEY[choice]]));
        flash = actions.length - 1;
        render();
        animateAdd(flash);
      }
      // 1st tap = A, 2nd = B, 3rd: old B becomes A. Tapping a selected event unselects it.
      function tap(id) {
        const i = sel.indexOf(id);
        if (i >= 0) sel.splice(i, 1);
        else if (sel.length < 2) sel.push(id);
        else sel = [sel[1], id];
        flash = null;
        render();
      }

      // ------------------------------------------------------------ drawing
      function render() {
        const { G, tl } = view;
        tl.clear();
        view.drawn.clear(); view.lines.clear();
        const offset = Math.max(0, hist.cols - G.maxCols);
        const tOf = e => Math.max(0.5, e.col - offset + 1);
        const [A, B] = sel.map(byId);
        const rel = e => !A || B ? null : e === A ? "self" : hb(hist, e, A) ? "past" : hb(hist, A, e) ? "future" : "conc";

        if (A && B && (hb(hist, A, B) || hb(hist, B, A))) {
          const [e1, e2] = hb(hist, A, B) ? [A, B] : [B, A];
          pathBetween(hist, e1, e2).forEach(([i, j]) => {
            const a = hist.events[i], b = hist.events[j];
            tl.content.append(s("line", {
              x1: tl.x(tOf(a)), y1: tl.y(LANES[a.p].id), x2: tl.x(tOf(b)), y2: tl.y(LANES[b.p].id),
              stroke: "var(--viz-ok)", "stroke-width": 9, "stroke-linecap": "round", opacity: 0.3,
            }));
          });
        }
        hist.msgs.forEach(m => {
          if (m.recv.col < offset) return;
          const g = tl.msg(LANES[m.send.p].id, tOf(m.send), LANES[m.recv.p].id, tOf(m.recv),
            { color: LANES[m.send.p].color, dashed: m.send.col < offset });
          const rs = rel(m.send), rr = rel(m.recv);
          const inCone = !rs || ((rs === "past" || rs === "self") && (rr === "past" || rr === "self")) ||
            ((rs === "self" || rs === "future") && rr === "future");
          if (!inCone) g.setAttribute("opacity", 0.25);
          view.lines.set(m.send.id, g.line);
        });
        // Nudge Lamport labels sideways where an arrow passes through them (send going up, receive from above).
        const nudge = new Map();
        hist.msgs.forEach(m => {
          if (m.recv.p < m.send.p) nudge.set(m.send.id, -G.nudge);
          else nudge.set(m.recv.id, G.nudge);
        });
        // Vector labels sit under the dot, where a message leaving downwards (send) or arriving
        // from below (receive) would cross them: those lean away from the arrow. Each label takes
        // the first spot (lean or centred, upper or lower row) that doesn't touch a neighbour's.
        const lean = new Map();
        hist.msgs.forEach(m => {
          if (m.recv.p > m.send.p) lean.set(m.send.id, "end");
          else lean.set(m.recv.id, "start");
        });
        const placed = {};
        const placeVec = (e, x) => {
          const w = (compact ? e.V.join(",") : vecStr(e.V)).length * G.font * 0.6;
          const span = a => (a === "end" ? [x + 3 - w, x + 3] : a === "start" ? [x - 3, x - 3 + w] : [x - w / 2, x + w / 2]);
          const cands = [];
          (lean.has(e.id) ? [lean.get(e.id), "middle"] : ["middle"]).forEach(a => [0, 1].forEach(level => cands.push({ anchor: a, level })));
          const ok = c => {
            const [x1, x2] = span(c.anchor), row = placed[e.p + ":" + c.level] || [];
            return x1 >= G.gutter - 6 && x2 <= G.W - 2 && row.every(([a, b]) => x2 + 4 <= a || x1 >= b + 4);
          };
          const pick = cands.find(ok) || { anchor: "middle", level: 0 };
          (placed[e.p + ":" + pick.level] = placed[e.p + ":" + pick.level] || []).push(span(pick.anchor));
          return pick;
        };
        const revealed = new Set(hist.events.filter(e => e.tag && e.tag.reveals).map(e => e.p));
        let prev = null, prevDx = 0;
        hist.events.forEach(e => {
          if (e.col < offset) return;
          const sameLane = prev && prev.p === e.p, x = tl.x(tOf(e));
          let dx = nudge.get(e.id) || 0;
          if (dx < 0 && sameLane && prevDx > 0) dx = 0; // two nudges towards each other would collide
          prev = e; prevDx = dx;
          const letter = e === A ? "A" : e === B ? "B" : null;
          drawEvent(e, x, tl.y(LANES[e.p].id), { state: rel(e), letter, vec: showVec ? placeVec(e, x) : null, dx, revealed: revealed.has(e.p) });
        });
        if (offset > 0) {
          tl.overlay.append(ctx.text(G.gutter, 6, "… earlier events hidden", { size: G.font, anchor: "start", fill: "var(--viz-muted)" }));
        }
        renderStrip(rel);
        renderInfo(A, B, rel);
        if (focusId) { const el = view.tl.overlay.querySelector(`[data-id="${focusId}"]`); if (el) el.focus(); focusId = null; }
      }

      function drawEvent(e, x, y, { state, letter, vec, dx, revealed }) {
        const { G, tl } = view;
        const c = laneColor(e.p);
        const g = s("g", { opacity: state === "conc" ? 0.45 : null });
        const r = letter ? G.selR : G.r;
        const ring = state === "past" ? "ok" : state === "future" ? "info" : null;
        g.append(
          s("circle", { cx: x, cy: y, r, fill: "var(--viz-bg)" }),
          s("circle", {
            cx: x, cy: y, r, fill: ring ? `var(--viz-${ring}-soft)` : c,
            stroke: ring ? `var(--viz-${ring})` : "var(--viz-bg)", "stroke-width": ring ? 2 : 1.5,
          }));
        if (letter) {
          g.append(s("circle", { cx: x, cy: y, r: G.ringR, fill: "none", stroke: "var(--viz-ink)", "stroke-width": 2.5 }),
            ctx.text(x, y + 0.5, letter, { size: G.font, weight: 800, fill: "var(--viz-bg)" }));
        }
        g.append(ctx.text(x + dx, y + G.lamY, (compact ? "L" : "L=") + e.L, { size: G.font, weight: 700, fill: c, mono: true, halo: true }));
        if (vec) {
          const v = compact ? e.V.join(",") : vecStr(e.V), vx = x + (vec.anchor === "end" ? 3 : vec.anchor === "start" ? -3 : 0);
          const vt = ctx.text(vx, y + G.vecY[vec.level], v, { size: G.font, fill: "var(--viz-muted)", mono: true, halo: true, anchor: vec.anchor });
          vt.style.strokeWidth = "5px"; // wider halo: arrows crossing the label get cut cleanly
          g.append(vt);
        }
        if (e.tag) {
          const anchor = e.tag.anchor || "middle";
          const tx = x + (anchor === "end" ? 8 : anchor === "start" ? -8 : 0);
          g.append(ctx.text(tx, y + G.tagY, e.tag.text, {
            size: G.font, weight: 700, anchor, halo: true, fill: e.tag.bad || revealed ? "var(--viz-bad)" : "var(--viz-warn)",
          }));
        }
        tl.content.append(g);
        view.drawn.set(e.id, g);

        const hit = s("circle", {
          cx: x, cy: y, r: 14, fill: "transparent", class: "lc-hit", role: "button", tabindex: 0,
          "aria-label": `${LANES[e.p].label} ${KIND_NAME[e.kind]} event ${stamp(e)}, vector ${vecStr(e.V)}${letter ? ", selected as " + letter : ""}`,
          dataset: { id: e.id },
        });
        hit.addEventListener("click", () => tap(e.id));
        hit.addEventListener("keydown", ev => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          focusId = e.id;
          tap(e.id);
        });
        tl.overlay.append(hit);
      }

      function renderStrip(rel) {
        const { chips } = view;
        chips.innerHTML = "";
        const order = lamportOrder(hist.events);
        if (!order.length) { chips.append(h("span", { class: "lc-empty" }, "No events yet.")); return; }
        order.forEach((e, i) => {
          const pair = h("span", { class: "lc-pair" });
          if (i > 0) {
            const conc = !hb(hist, order[i - 1], e);
            pair.append(h("span", {
              class: "lc-sep" + (conc ? " conc" : ""),
              title: conc ? "concurrent: this order is only a tie-break" : "happened before",
            }, conc ? "||" : "→"));
          }
          const letter = sel[0] === e.id ? "A" : sel[1] === e.id ? "B" : "";
          const state = rel(e);
          const chip = h("button", {
            type: "button", class: "lc-chip" + (letter ? " is-sel" : "") + (state && state !== "self" ? " " + state : ""),
            style: { color: laneColor(e.p) }, title: `Select ${stamp(e)}`, onClick: () => tap(e.id),
          });
          chip.innerHTML = (letter ? `<b>${letter}</b>` : "") + stamp(e);
          pair.append(chip);
          chips.append(pair);
        });
      }

      // ------------------------------------------------------------ stats + note
      function renderInfo(A, B, rel) {
        const { stats, note, G } = view;
        const need = ACTION_BY_KEY[choice].type === "msg" ? 2 : 1;
        const full = hist.cols + need > G.maxCols;
        view.addBtn.disable(full);
        view.undoBtn.disable(!actions.length);
        view.clearBtn.disable(!actions.length);

        if (A && B) {
          const ab = hb(hist, A, B), ba = hb(hist, B, A), conc = !ab && !ba;
          const [f, g] = lamportLess(A, B) ? [A, B] : [B, A];
          const [e1, e2] = ab ? [A, B] : [B, A];
          const nm = e => (e === A ? "A" : "B");
          stats.set("hb", two(conc ? "concurrent" : `${nm(e1)} → ${nm(e2)}`, conc ? "no chain either way" : "a chain exists"), conc ? "warn" : "ok");
          stats.set("lam", two(`${stamp(f)} &lt; ${stamp(g)}`, conc ? "order is arbitrary" : "agrees with causality"), conc ? "warn" : "info");
          if (!showVec) stats.set("vec", two("hidden", "vector clocks are off"), "");
          else if (conc) stats.set("vec", two(`${vecStr(A.V)} vs ${vecStr(B.V)}`, "neither ≤: concurrent"), "warn");
          else stats.set("vec", two(`${vecStr(e1.V)} ≤ ${vecStr(e2.V)}`, `${nm(e1)} ≤ ${nm(e2)}: ${nm(e1)} before ${nm(e2)}`), "ok");
        } else if (A) {
          // One event: how its light cone splits the history, and how many concurrent events Lamport sorts on each side.
          const count = st => hist.events.filter(e => rel(e) === st);
          const conc = count("conc"), before = conc.filter(e => lamportLess(e, A)).length;
          stats.set("hb", two(`${count("past").length} past · ${count("future").length} future`, `${conc.length} concurrent with A`), "");
          stats.set("lam", two(`A = ${stamp(A)}`, conc.length ? `puts ${before} concurrent before A, ${conc.length - before} after` : "no concurrent events"), conc.length ? "warn" : "");
          stats.set("vec", showVec ? two(`A = ${vecStr(A.V)}`, "events A has seen from P1, P2, P3") : two("hidden", "vector clocks are off"), "");
        } else {
          ["hb", "lam", "vec"].forEach(k => stats.set(k, "–", ""));
        }

        let [html, tone] = describe(A, B, rel);
        if (full && hist.cols) {
          html += hist.cols >= G.maxCols ? " <b>Diagram full: Undo or Clear.</b>"
            : " <b>No room for a message (it needs two columns): add a local event, Undo or Clear.</b>";
        }
        note.set(html, tone);
      }

      function describe(A, B, rel) {
        if (!hist.cols) return ["The diagram is empty. Pick an action and press <b>Add</b> to create events.", "info"];
        if (flash !== null) return [explainAdd(hist.events.filter(e => e.ai === flash)), "info"];
        if (A && B) {
          if (preset === "race" && sel.join() === PRESETS.race.select.join()) {
            return ["P1 granted <b>@ana</b> at L=3 because it had seen no other claim. P3's claim " + mono("(1,P3)") +
              " was concurrent and has the lower timestamp, so in Lamport order P3 wins, but P1 only learns that after it " +
              "has already said yes. <b>Lamport order is final only once you've heard from everyone</b>; deciding now needs " +
              "total order broadcast.", "bad"];
          }
          const nm = e => `<b>${e === A ? "A" : "B"}</b>`;
          if (!hb(hist, A, B) && !hb(hist, B, A)) {
            const [f, g] = lamportLess(A, B) ? [A, B] : [B, A];
            const why = f.L < g.L ? `L(${nm(f)}) &lt; L(${nm(g)})` : `Breaking the tie at L=${f.L} by process number`;
            return [`Lamport timestamps put ${nm(f)} ${mono(stamp(f))} before ${nm(g)} ${mono(stamp(g))}, but no chain of ` +
              `messages connects them: they are <b>concurrent</b>. ${why} does not mean ${nm(f)} happened before ${nm(g)}. ` +
              (showVec ? `Vector clocks notice: neither ${mono(vecStr(A.V))} nor ${mono(vecStr(B.V))} is ≤ the other.`
                : "Vector clocks would notice: switch them on."), "warn"];
          }
          const [e1, e2] = hb(hist, A, B) ? [A, B] : [B, A];
          return [`There is a path of process steps and messages from ${nm(e1)} to ${nm(e2)} (highlighted), so ${nm(e1)} ` +
            `happened before ${nm(e2)}, and ${showVec ? "both clocks agree" : "the Lamport clock agrees"}: ` +
            `L(${nm(e1)}) = ${e1.L} &lt; L(${nm(e2)}) = ${e2.L}` +
            (showVec ? ` and V(${nm(e1)}) ${mono(vecStr(e1.V))} ≤ V(${nm(e2)}) ${mono(vecStr(e2.V))}` : "") +
            ". This direction always holds.", "ok"];
        }
        if (A) {
          const conc = hist.events.filter(e => rel(e) === "conc").length;
          return [`Green: everything that could have influenced <b>A</b> ${mono(stamp(A))} (its causal past). Blue: everything ` +
            `A could influence. Faded events are concurrent with A` +
            (conc ? ": the total order still puts each of them before or after A, but that says nothing about cause." : "."), "info"];
        }
        return ["Tap an event to see its causal past and future; tap two to compare their clocks.", "info"];
      }

      function explainAdd(evs) {
        const vec = V => mono(vecStr(V));
        const P = e => `<b>P${e.p + 1}</b>`;
        if (evs.length === 1) {
          const e = evs[0];
          return `${P(e)} ticks its own counter for a local event: L = ${e.L - 1} + 1 = <b>${e.L}</b>` +
            (showVec ? `; in its vector only its own entry grows: ${vec(e.V)}.` : ".");
        }
        const [snd, rcv] = evs;
        return `${P(snd)} ticks to L = ${snd.L} and sends that counter with the message. ${P(rcv)} jumps past anything it ` +
          `has seen: max(own ${rcv.prev.L}, received ${snd.L}) + 1 = <b>${rcv.L}</b>.` +
          (showVec ? ` Its vector is the entrywise max of ${vec(rcv.prev.V)} and ${vec(snd.V)}, then +1 in its own slot: ${vec(rcv.V)}.` : "");
      }

      // New dot fades in; a message's arrow draws from sender to receiver, then the receive appears.
      async function animateAdd(ai) {
        if (ctx.instant) return;
        const evs = hist.events.filter(e => e.ai === ai);
        const groups = evs.map(e => view.drawn.get(e.id));
        if (groups.some(g => !g)) return;
        const fade = g => {
          const base = Number(g.getAttribute("opacity") || 1); // concurrent-with-A events stay faded
          return ctx.tween({ ms: 300, onUpdate: k => { g.style.opacity = k * base; } });
        };
        groups.forEach(g => { g.style.opacity = 0; });
        const line = evs.length === 2 ? view.lines.get(evs[0].id) : null;
        let marker = null, len = 0;
        if (line) {
          len = line.getTotalLength();
          marker = line.getAttribute("marker-end");
          line.removeAttribute("marker-end");
          Object.assign(line.style, { strokeDasharray: `${len}`, strokeDashoffset: `${len}` });
        }
        await fade(groups[0]);
        if (!line) return;
        await ctx.tween({ ms: 400, onUpdate: k => { line.style.strokeDashoffset = `${len * (1 - k)}`; } });
        Object.assign(line.style, { strokeDasharray: "", strokeDashoffset: "" });
        if (marker) line.setAttribute("marker-end", marker);
        await fade(groups[1]);
      }

      build();
      loadPreset("concurrency");
      view.scenario.set("concurrency");
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
