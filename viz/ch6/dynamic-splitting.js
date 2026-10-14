// Dynamic partitioning: a key range splits at its median when it grows past a size threshold
// and small neighbours merge after deletes, so the partition count follows the data. Shows the
// one-partition start, pre-splitting, and why size-based splits cannot spread sequential keys.
(function () {
  "use strict";
  const KEYS = 1000, NODES = 3, PRELOAD = 40, PER_TICK = 6, RECENT = 18, MAX_MARKS = 12;
  const NODE_COL = ["c2", "c5", "c8"];
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");

  // ------------------------------------------------------------------ model (pure)
  const owner = (sim, key) => sim.parts.find(p => key >= p.lo && key <= p.hi);
  const totalRows = sim => sim.parts.reduce((a, p) => a + p.keys.length, 0);

  // Sorted insert; false when the key already exists (an update: the row count stays the same).
  function insert(keys, key) {
    let lo = 0, hi = keys.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (keys[mid] < key) lo = mid + 1; else hi = mid; }
    if (keys[lo] === key) return false;
    keys.splice(lo, 0, key);
    return true;
  }

  function createSim(pattern, preSplit, rand) {
    const sim = { pattern, preSplit, rand, parts: [], nextId: 0, seq: 0, recent: [], writes: 0,
      splits: 0, merges: 0, moved: 0, exhausted: false, deleted: false, lastSplit: null };
    const bounds = preSplit ? [[0, 332], [333, 665], [666, 999]] : [[0, KEYS - 1]];
    bounds.forEach(([lo, hi], node) => sim.parts.push({ id: sim.nextId++, lo, hi, node, keys: [], last: -1 }));
    for (let n = 0; n < PRELOAD;) {
      const k = pattern === "sequential" ? sim.seq++ : rand.int(0, KEYS - 1);
      if (insert(owner(sim, k).keys, k)) n++;
    }
    return sim;
  }

  function nodeLoad(sim) {
    const load = Array.from({ length: NODES }, (_, n) => ({ n, rows: 0, parts: 0 }));
    sim.parts.forEach(p => { load[p.node].rows += p.keys.length; load[p.node].parts++; });
    return load;
  }
  // Home for a new half: fewest rows, then fewest partitions, then lowest node number.
  const pickNode = sim => nodeLoad(sim).sort((a, b) => a.rows - b.rows || a.parts - b.parts || a.n - b.n)[0].n;

  // Split at the median key; the upper half is placed before it joins, so its rows don't count.
  function split(sim, p) {
    const mid = Math.floor(p.keys.length / 2), m = p.keys[mid];
    if (m === undefined || m <= p.lo) return null;
    const right = { id: sim.nextId++, lo: m, hi: p.hi, node: p.node, keys: p.keys.slice(mid), last: p.last };
    p.keys = p.keys.slice(0, mid);
    p.hi = m - 1;
    right.node = pickNode(sim);
    sim.parts.splice(sim.parts.indexOf(p) + 1, 0, right);
    sim.splits++;
    if (right.node !== p.node) sim.moved += right.keys.length;
    sim.lastSplit = { m, from: p.node, to: right.node, rows: right.keys.length, id: right.id, src: p.id };
    return { type: "split", src: p, dst: right, from: p.node, to: right.node };
  }

  // One client write: returns {key, split} where split is the split event it caused, if any.
  function write(sim, S) {
    const key = sim.pattern === "sequential" ? sim.seq++ : sim.rand.int(0, KEYS - 1);
    const p = owner(sim, key);
    insert(p.keys, key);
    p.last = sim.writes++;
    sim.recent.push(key);
    if (sim.recent.length > RECENT) sim.recent.shift();
    if (sim.pattern === "sequential" && sim.seq >= KEYS) sim.exhausted = true;
    return { key, split: p.keys.length > S ? split(sim, p) : null };
  }

  function deleteTwoThirds(sim) {
    sim.parts.forEach(p => { p.keys = p.keys.filter((_, i) => i % 3 === 0); });
    sim.deleted = true;
  }
  // Merges the first key-adjacent pair holding fewer than S/2 rows together into the left one.
  function mergeOne(sim, S) {
    for (let i = 0; i + 1 < sim.parts.length; i++) {
      const a = sim.parts[i], b = sim.parts[i + 1];
      if (a.keys.length + b.keys.length >= S / 2) continue;
      a.keys = a.keys.concat(b.keys);
      a.hi = b.hi;
      a.last = Math.max(a.last, b.last);
      sim.parts.splice(i + 1, 1);
      sim.merges++;
      if (a.node !== b.node) sim.moved += b.keys.length;
      return { type: "merge", src: b, dst: a, from: b.node, to: a.node };
    }
    return null;
  }

  // "Taking writes now" = owns one of the last RECENT written keys under the CURRENT map.
  function hotSets(sim) {
    const parts = new Set(), nodes = new Set();
    sim.recent.forEach(k => { const p = owner(sim, k); parts.add(p.id); nodes.add(p.node); });
    return { parts, nodes };
  }

  // ------------------------------------------------------------------ view
  function geometry(compact) {
    return compact
      ? { compact, W: 360, H: 324, x0: 10, ppk: 0.34, barY: 36, barH: 34, markTop: 23, markTip: 33, tickY: 86,
          ticks: [0, 500, 999], fs: 11, boxX: [6, 124, 242], boxY: 100, boxW: 112, boxH: 220, headSize: 12,
          rowTop: 42, gap: 22, rowH: 16, trackX: 6, trackW: 100, maxRows: 8 }
      : { compact, W: 640, H: 306, x0: 20, ppk: 0.6, barY: 40, barH: 40, markTop: 27, markTip: 37, tickY: 96,
          ticks: [0, 250, 500, 750, 999], fs: 12, boxX: [20, 225, 430], boxY: 112, boxW: 190, boxH: 190, headSize: 13,
          rowTop: 54, gap: 22, rowH: 16, trackX: 10, trackW: 170, maxRows: 6 };
  }

  Viz.register("ch6/dynamic-splitting", {
    title: "Dynamic splitting and merging",
    mount(root, ctx) {
      const { s, ui } = ctx;
      // State lives outside build() so a phone <-> desktop rebuild keeps it.
      const st = { pattern: "uniform", preSplit: false, S: 60 };
      let sim = null, running = false, phase = null, epoch = 0, fixing = false, mergePending = false;
      let compact = ctx.compact, view = null;
      const arriving = new Set();   // split halves still flying: their destination row is a placeholder
      const pins = new Map();       // flight targets: always listed in their node box

      const pin = id => pins.set(id, (pins.get(id) || 0) + 1);
      const unpin = id => { const c = (pins.get(id) || 0) - 1; if (c > 0) pins.set(id, c); else pins.delete(id); };
      const X = key => view.L.x0 + key * view.L.ppk;
      const txt = (x, y, str, o) => ctx.text(x, y, str, { size: view.L.fs, ...o });

      function reset() {
        epoch++;
        fixing = false; mergePending = false; phase = null;
        arriving.clear(); pins.clear();
        sim = createSim(st.pattern, st.preSplit, ctx.random(42));
        setRunning(false);
        view.marks.innerHTML = "";
        view.flights.innerHTML = "";
        render();
        fixUp(); // a threshold below the 40 preloaded rows splits right away
      }

      function setRunning(on) {
        running = on && !sim.exhausted;
        if (!view) return;
        view.runBtn.setLabel(running ? "❚❚ Pause" : "▶ Start writes").disable(sim.exhausted);
      }

      function tick() {
        if (!running || !view) return;
        const before = view.rowPos, events = [];
        for (let i = 0; i < PER_TICK && !sim.exhausted; i++) {
          const w = write(sim, st.S);
          addMarker(w.key);
          if (w.split) events.push(w.split);
        }
        if (phase && ++phase.age > 8) phase = null;
        if (sim.exhausted) setRunning(false);
        show(events, before);
      }

      // Draw the new state, then fly each partition that changed node from its old row to its new one.
      function show(events, before) {
        const moves = events.filter(ev => ev.from !== ev.to);
        moves.forEach(ev => { pin(ev.dst.id); if (ev.type === "split") arriving.add(ev.dst.id); });
        render();
        moves.forEach(ev => fly(ev, before[ev.src.id], view.rowPos[ev.dst.id]));
      }

      function fly(ev, from, to) {
        const id = ev.dst.id;
        const land = () => { arriving.delete(id); unpin(id); render(); };
        if (!from || !to) { land(); return; }
        const { L, flights } = view, c = NODE_COL[ev.to];
        const label = ev.type === "split" ? `P${ev.dst.id} → Node ${ev.to + 1}` : `P${ev.src.id} → P${ev.dst.id}`;
        const g = s("g");
        g.append(
          s("rect", { width: L.trackW, height: L.rowH, rx: 4, fill: "var(--viz-bg)" }),
          s("rect", { width: L.trackW, height: L.rowH, rx: 4, fill: `var(--viz-${c}-soft)`, stroke: `var(--viz-${c})`, "stroke-width": 1.5 }),
          txt(8, L.rowH / 2 + 1, label, { anchor: "start", weight: 700 }));
        flights.appendChild(g);
        const place = k => g.setAttribute("transform", `translate(${ctx.lerp(from.x, to.x, k)},${ctx.lerp(from.y, to.y, k)})`);
        place(0);
        ctx.tween({ ms: 600, ease: "inOut", onUpdate: place }).then(() => { g.remove(); land(); });
      }

      // Background repair after Delete (merges) or a lower threshold (splits): one change per 300 ms.
      function nextFix() {
        if (mergePending) {
          const ev = mergeOne(sim, st.S);
          if (ev) return ev;
          mergePending = false;
        }
        const big = sim.parts.find(p => p.keys.length > st.S);
        return big ? split(sim, big) : null;
      }
      function fixUp() {
        if (fixing) return;
        fixing = true;
        const my = epoch;
        const step = () => {
          if (my !== epoch) return;
          const before = view.rowPos, ev = nextFix();
          if (!ev) { fixing = false; render(); return; }
          show([ev], before);
          ctx.after(300, step);
        };
        step();
      }

      function thresholdChanged(v) {
        st.S = v;
        if (sim.parts.some(p => p.keys.length > v)) {
          if (!phase || phase.type !== "threshold") phase = { type: "threshold", age: 0, splits: sim.splits, moved: sim.moved };
          phase.age = 0;
          fixUp();
        }
        render();
      }

      function deleteRows() {
        setRunning(false);
        const rows = totalRows(sim);
        deleteTwoThirds(sim);
        phase = { type: "deleted", age: 0, parts: sim.parts.length, rows, after: totalRows(sim), merges: sim.merges };
        mergePending = true;
        fixUp();
        render();
      }

      function addMarker(key) {
        const { L, marks } = view, x = X(key + 0.5);
        const m = s("path", { d: `M${x - 4},${L.markTop}L${x + 4},${L.markTop}L${x},${L.markTip}Z`, fill: "var(--viz-warn)" });
        marks.appendChild(m);
        while (marks.childNodes.length > MAX_MARKS) marks.firstChild.remove();
        if (!ctx.instant) ctx.animate(m, { opacity: 0 }, 600, "in").then(() => m.remove());
      }

      // ---------------------------------------------------------------- build
      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const L = geometry(compact);
        const keysSeg = ui.segmented({
          label: "Keys", value: st.pattern,
          options: [{ value: "uniform", label: "Uniform random" }, { value: "sequential", label: "Sequential (timestamps)" }],
          onChange: v => { st.pattern = v; reset(); },
        });
        const preToggle = ui.toggle({ label: "Pre-split into 3 ranges", value: st.preSplit, onChange: v => { st.preSplit = v; reset(); } });
        const slider = ui.slider({
          label: "Split at", min: 30, max: 120, step: 10, value: st.S, format: v => v + " rows", onInput: thresholdChanged,
        });
        if (compact) slider.input.style.flex = "1 1 80px";
        const runBtn = ui.button("▶ Start writes", () => setRunning(!running), { kind: "primary" });
        const delBtn = ui.button("Delete two-thirds of rows", deleteRows);
        const resetBtn = ui.button("Reset", reset, { kind: "ghost" });

        const svg = ctx.svg({ w: L.W, h: L.H, label: "Keyspace 0 to 999 cut into partitions, and the three nodes that host them" });
        const deco = s("g"), bar = s("g"), marks = s("g"), nodes = s("g"), flights = s("g");
        svg.append(deco, bar, marks, nodes, flights);
        view = { L, bar, marks, nodes, flights, runBtn, rowPos: {} };
        const muted = { fill: "var(--viz-muted)" };
        view.fillLabel = txt(L.x0 + KEYS * L.ppk, L.markTop - 12, "", { anchor: "end", ...muted });
        deco.append(txt(L.x0, L.markTop - 12, "keyspace 0–999", { anchor: "start", ...muted }), view.fillLabel);
        L.ticks.forEach(k => {
          const x = X(k === 999 ? KEYS : k), y = L.barY + L.barH;
          deco.append(s("line", { x1: x, x2: x, y1: y, y2: y + 4, stroke: "var(--viz-line)" }),
            txt(x, L.tickY, String(k), { anchor: k === 999 ? "end" : k ? "middle" : "start", ...muted }));
        });

        view.stats = ui.stats([
          { key: "parts", label: "Partitions" },
          { key: "nodes", label: "Nodes taking writes now" },
          { key: "hot", label: "Partitions taking writes now" },
          { key: "sm", label: "Splits / merges" },
          { key: "moved", label: "Rows moved" },
        ]);
        view.note = ui.note("");
        const legend = ui.legend([
          ...NODE_COL.map((c, n) => ({ color: `var(--viz-${c})`, label: `on Node ${n + 1}`, shape: "square" })),
          { color: "var(--viz-warn)", label: "latest writes", shape: "dot" },
        ]);
        root.append(ui.bar(keysSeg, preToggle, slider), ui.bar(runBtn, delBtn, resetBtn), svg, legend, view.stats, view.note);
        setRunning(running);
        render();
      }

      // ---------------------------------------------------------------- render
      function render() {
        if (!view) return;
        const hot = hotSets(sim), live = sim.writes > 0;
        view.fillLabel.textContent = compact ? `fill = rows ÷ ${st.S}` : `fill height = rows ÷ ${st.S} (full = split)`;
        drawBar();
        drawNodes(hot, live);
        drawStats(hot);
        view.note.set(...noteFor(hot));
      }

      function drawBar() {
        const { L, bar } = view;
        bar.innerHTML = "";
        sim.parts.forEach(p => {
          const x = X(p.lo), w = X(p.hi + 1) - x, c = NODE_COL[p.node], rows = p.keys.length;
          const fillH = Math.min(1, rows / st.S) * (L.barH - 2), over = rows > st.S;
          bar.append(
            s("rect", { x, y: L.barY, width: w, height: L.barH, fill: `var(--viz-${c}-soft)`,
              stroke: over ? "var(--viz-bad)" : `var(--viz-${c})`, "stroke-width": over ? 2 : 1,
              "stroke-dasharray": arriving.has(p.id) ? "4 3" : null }),
            s("rect", { x: x + 1, y: L.barY + L.barH - 1 - fillH, width: Math.max(0, w - 2), height: fillH, fill: `var(--viz-${c})`, opacity: 0.45 }));
          if (w < 30) return;
          const two = !compact && w >= 70, cx = x + w / 2;
          bar.appendChild(txt(cx, L.barY + (two ? 14 : L.barH / 2), "P" + p.id, { weight: 700 }));
          if (two) bar.appendChild(txt(cx, L.barY + 29, plural(rows, "row")));
        });
      }

      // Which partitions a full node box lists: flight targets, then the ones taking writes, then the most recently written.
      function visibleRows(mine, hot, max) {
        if (mine.length <= max) return { list: mine, hidden: [] };
        const rank = p => (pins.has(p.id) ? 2 : 0) + (hot.parts.has(p.id) ? 1 : 0);
        const ranked = mine.slice().sort((a, b) => rank(b) - rank(a) || b.last - a.last || b.id - a.id);
        return { list: ranked.slice(0, max - 1).sort((a, b) => a.lo - b.lo), hidden: ranked.slice(max - 1) };
      }

      function drawNodes(hot, live) {
        const { L, nodes } = view, load = nodeLoad(sim), pos = {};
        nodes.innerHTML = "";
        for (let n = 0; n < NODES; n++) {
          const x = L.boxX[n], y = L.boxY, c = NODE_COL[n], isHot = hot.nodes.has(n);
          const mine = sim.parts.filter(p => p.node === n), sw = compact ? 8 : 10, pad = compact ? 7 : 12;
          const headY = y + (compact ? 15 : 20);
          nodes.append(
            s("rect", { x, y, width: L.boxW, height: L.boxH, rx: 8, fill: "var(--viz-node)",
              stroke: isHot ? "var(--viz-warn)" : "var(--viz-node-stroke)", "stroke-width": isHot ? 2 : 1.2 }),
            s("rect", { x: x + pad, y: headY - sw / 2, width: sw, height: sw, rx: 2, fill: `var(--viz-${c}-soft)`, stroke: `var(--viz-${c})` }),
            ctx.text(x + pad + sw + 5, headY, `Node ${n + 1}`, { size: L.headSize, weight: 700, anchor: "start" }));
          const status = [isHot ? "taking writes" : "idle", { weight: isHot ? 700 : 400, fill: isHot ? "var(--viz-warn)" : "var(--viz-muted)" }];
          if (compact) nodes.appendChild(txt(x + pad, y + 31, status[0], { anchor: "start", ...status[1] }));
          else {
            nodes.appendChild(txt(x + L.boxW - pad, headY, status[0], { anchor: "end", ...status[1] }));
            const sub = mine.length ? `${plural(load[n].rows, "row")} · ${plural(mine.length, "partition")}` : "0 rows";
            nodes.appendChild(txt(x + pad, y + 39, sub, { anchor: "start", fill: "var(--viz-muted)" }));
          }
          if (!mine.length) {
            nodes.appendChild(txt(x + L.boxW / 2, y + L.boxH / 2, compact ? "no partitions" : "no partitions yet", { fill: "var(--viz-muted)" }));
            continue;
          }
          const { list, hidden } = visibleRows(mine, hot, L.maxRows);
          list.forEach((p, i) => {
            const rx = x + L.trackX, ry = y + L.rowTop + i * L.gap;
            pos[p.id] = { x: rx, y: ry };
            drawRow(p, rx, ry, hot.parts.has(p.id), live);
          });
          if (hidden.length) {
            const ry = y + L.rowTop + list.length * L.gap;
            nodes.appendChild(txt(x + L.trackX + 2, ry + L.rowH / 2, `+${hidden.length} more`, { anchor: "start", fill: "var(--viz-muted)" }));
            hidden.forEach(p => { pos[p.id] = { x: x + L.trackX, y: ry }; });
          }
        }
        view.rowPos = pos;
      }

      function drawRow(p, x, y, isHot, live) {
        const { L, nodes } = view, c = NODE_COL[p.node], rows = p.keys.length, over = rows > st.S;
        if (arriving.has(p.id)) {
          nodes.appendChild(s("rect", { x, y, width: L.trackW, height: L.rowH, rx: 4, fill: "none",
            stroke: `var(--viz-${c})`, "stroke-dasharray": "4 3" }));
          return;
        }
        const g = s("g", { opacity: !live || isHot ? 1 : 0.6 });
        g.append(
          s("rect", { x, y, width: L.trackW, height: L.rowH, rx: 4, fill: "var(--viz-grid)",
            stroke: over ? "var(--viz-bad)" : "none", "stroke-width": 1.5 }),
          s("rect", { x, y, width: Math.min(1, rows / st.S) * L.trackW, height: L.rowH, rx: 4, fill: `var(--viz-${c})`, opacity: 0.45 }));
        if (isHot && live) g.appendChild(s("rect", { x, y, width: 4, height: L.rowH, rx: 2, fill: "var(--viz-warn)" }));
        const label = txt(x + (compact ? 7 : 9), y + L.rowH / 2 + 1, `P${p.id} ${p.lo}–${p.hi}`, { anchor: "start", weight: compact ? 400 : 600 });
        const count = txt(x + L.trackW - 4, y + L.rowH / 2 + 1, compact ? String(rows) : plural(rows, "row"), { anchor: "end" });
        g.append(label, count);
        nodes.appendChild(g);
        // Narrow phone tracks: drop the count rather than let a long range label run into it.
        const room = L.trackW - 15 - label.getComputedTextLength();
        if (room < count.getComputedTextLength()) count.remove();
      }

      function drawStats(hot) {
        const stats = view.stats, n = sim.parts.length, ready = sim.writes >= RECENT;
        const kn = hot.nodes.size, kp = hot.parts.size;
        stats.set("parts", n, "");
        stats.set("nodes", ready ? `${kn} of ${NODES}` : "–", ready ? ["", "bad", "warn", "ok"][kn] : "");
        const partTone = kp === 1 ? (n > 1 ? "bad" : "warn") : kp * 2 < n && kp < 3 ? "warn" : "ok";
        stats.set("hot", ready ? `${kp} of ${n}` : "–", ready ? partTone : "");
        stats.set("sm", `${sim.splits} / ${sim.merges}`, "");
        stats.set("moved", sim.moved, "");
      }

      // ---------------------------------------------------------------- explanation
      function noteFor(hot) {
        const n = sim.parts.length, S = st.S, seq = sim.pattern === "sequential";
        const intact = !sim.deleted && sim.merges === 0;   // pre-split boundaries still as created
        const newest = sim.recent.length ? owner(sim, sim.recent[sim.recent.length - 1]) : null;
        if (sim.exhausted) {
          return [`Keyspace used up: 1,000 sequential keys made <b>${plural(n, "partition")}</b>, and each one took writes only while it held the newest key. Reset to try again.`, "info"];
        }
        if (phase && phase.type === "deleted") return deletedNote(n, S);
        if (phase && phase.type === "threshold") {
          const k = sim.splits - phase.splits, mv = sim.moved - phase.moved;
          return [`<b>Split at</b> is now ${S} rows, so every partition over it splits at once: <b>${plural(k, "split")}</b>${fixing ? " so far" : ""}, ${plural(mv, "row")} moved. A lower threshold means more, smaller partitions; each one adds overhead (files, metadata).`, "info"];
        }
        if (sim.preSplit && seq && intact && sim.seq < 666) {
          if (!sim.writes) return ["Pre-split into 3 ranges, one per node, but the keys are sequential, like timestamps. Press <b>Start writes</b> and watch which range gets the writes.", "warn"];
          const now = `(now P${newest.id} on Node ${newest.node + 1})`;
          if (sim.seq < 333) return [`<b>Pre-splitting did not help</b>: sequential keys only ever hit the range holding the newest key ${now}, so P1 and P2 sit empty until the sequence reaches 333 and 666. A static guess cannot beat "always the newest key".`, "bad"];
          return [`<b>Pre-splitting did not help</b>: writes moved into P1's range only because the sequence reached 333 ${now}. Nothing below it gets another write, and P2 [666–999] sits empty until the sequence reaches 666.`, "bad"];
        }
        if (sim.preSplit && !seq && intact && sim.splits === 0) {
          return sim.writes
            ? ["<b>Pre-split into 3 ranges</b>: writes spread across all nodes from the first second, because the guess about the key distribution was right.", "ok"]
            : ["Pre-split into 3 ranges, one per node, before any data arrived. Press <b>Start writes</b>: if the guess about the key distribution is right, writes spread across all nodes at once.", "info"];
        }
        if (n === 1) {
          const p = sim.parts[0], others = [0, 1, 2].filter(k => k !== p.node).map(k => k + 1).join(" and ");
          if (!sim.writes) {
            return [`A new table starts as <b>a single partition</b> covering every key, on Node ${p.node + 1}. Press <b>Start writes</b>: every write lands on Node ${p.node + 1} while Nodes ${others} sit idle until the first split.` +
              (seq ? " With sequential keys, keep watching after the split." : ""), "warn"];
          }
          return [`<b>Node ${p.node + 1} takes 100% of writes</b>: P${p.id} holds ${plural(p.keys.length, "row")} and cannot split until it passes ${S}, so Nodes ${others} sit idle.`, "bad"];
        }
        if (seq && newest) {
          const older = sim.parts.filter(p => p.hi < newest.lo).map(p => p.keys.length);
          const lo = Math.min(...older), hi = Math.max(...older);
          const sizes = lo === hi ? lo + " rows each" : lo + "–" + hi + " rows";
          const left = !older.length ? "" : sim.deleted || sim.preSplit
            ? `, and every older partition never gets another write (${sizes})`
            : `, and every older partition is left half-full (${sizes})`;
          return [`<b>Sequential keys</b>: only the partition holding the newest keys (P${newest.id}, now on Node ${newest.node + 1}) receives writes. It fills, splits, and its upper half moves to another node, so the hot spot hops between nodes, but at any moment <b>one partition on one node takes 100% of writes</b>${left}. Splitting by size fixes size, not a moving hot spot.`, "bad"];
        }
        const ls = sim.lastSplit;
        if (n === 2 && sim.splits === 1 && intact && !sim.preSplit && ls) {
          return [`P${ls.src} passed ${S} rows, split at its median key <b>${ls.m}</b>, and the upper half (P${ls.id}, ${plural(ls.rows, "row")}) moved to Node ${ls.to + 1}. From here the partition count grows with the data (HBase splits regions at 10 GB by default; Bigtable tablets are about 100–200 MB). The viz moves the new half at once; HBase first keeps both halves on the same server and lets its balancer move one.`, "ok"];
        }
        const used = new Set(sim.parts.map(p => p.node)).size, k = hot.nodes.size;
        if (used < NODES) {
          return [`${plural(n, "partition")}, but only on ${plural(used, "node")} so far: Node ${pickNode(sim) + 1} has no rows, so the next split sends its upper half there.`, "info"];
        }
        if (!sim.writes) return [`${plural(n, "partition")} on 3 nodes. Press <b>Start writes</b> to see where the writes land.`, "info"];
        return [`<b>${plural(n, "partition")} on 3 nodes</b>, ${k === NODES ? "all 3" : k + " of 3"} taking writes. Boundaries followed the data; nobody chose them by hand.`, k === NODES ? "ok" : "warn"];
      }

      function deletedNote(n, S) {
        const merges = sim.merges - phase.merges, rows = `(${phase.rows} → ${phase.after} rows)`;
        if (phase.parts === 1) return [`Deleted two-thirds of the rows ${rows}. A single partition has no neighbour to merge with. Press <b>Start writes</b> to keep going.`, "info"];
        if (!merges && !mergePending) return [`Deleted two-thirds of the rows ${rows}, but no two neighbours together hold fewer than ${S / 2} rows, so nothing merged.`, "info"];
        return [`Deleting data left small partitions ${rows}; neighbours whose combined size fell below <b>${S / 2} rows</b> merged (like B-tree pages): <b>${plural(merges, "merge")}</b>${fixing ? " so far" : ""}, ${phase.parts} → ${n} partitions.`, "info"];
      }

      sim = createSim(st.pattern, st.preSplit, ctx.random(42));
      build();
      fixUp();
      ctx.every(350, tick);
      // Rebuild with the other layout when the frame crosses the phone breakpoint (deferred: not inside the observer).
      ctx.onResize(() => ctx.after(0, () => { if (ctx.compact !== compact) build(); }));
    },
  });

  // Lets a Node test drive the model directly; inert in the browser.
  if (typeof module === "object" && module.exports) {
    module.exports = { createSim, write, split, mergeOne, deleteTwoThirds, hotSets, nodeLoad, KEYS, PER_TICK };
  }
})();
