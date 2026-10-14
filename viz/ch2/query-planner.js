// Say what, not how: one question ("which animals are sharks?") asked imperatively, as a loop
// over storage order, and declaratively, as SQL. Changing the database underneath (an index,
// more cores, reorganized storage) speeds the SQL up for free; the loop stays frozen, and its
// hand-optimization silently breaks. Plans are simplified labels at toy scale, not EXPLAIN output.
Viz.register("ch2/query-planner", {
  title: "Say what, not how",
  mount(root, ctx) {
    const { s, h, ui } = ctx;

    // ---------------- Pure model (no DOM) ----------------
    const FAM = { S: { name: "shark", c: "c5" }, W: { name: "whale", c: "c2" }, R: { name: "ray", c: "c8" } };
    const NAMES = {
      S: ["Great white", "Tiger", "Hammerhead", "Mako", "Blacktip", "Nurse"],
      W: ["Blue", "Humpback", "Sperm", "Fin", "Gray", "Minke", "Beluga", "Bowhead", "Right"],
      R: ["Manta", "Stingray", "Eagle ray", "Electric ray", "Devil ray", "Cownose", "Guitarfish", "Sawfish", "Skate"],
    };
    const ANIMALS = ["S", "W", "R"].flatMap(fam => NAMES[fam].map(name => ({ name, fam })));
    const isShark = a => ANIMALS[a].fam === "S";
    const SHARK_IDS = ANIMALS.map((_, a) => a).filter(isShark);
    // A layout maps slot (0-23, six slots per page) -> animal index.
    const LAYOUT_A = ANIMALS.map((_, a) => a);  // bulk-loaded by family
    const LAYOUT_B = (() => {
      const sharks = ["Mako", "Great white", "Nurse", "Tiger", "Blacktip", "Hammerhead"];
      const next = { S: 0, W: 0, R: 0 };
      return [..."WSSRWR" + "SWRSWR" + "RWSWRW" + "SRWRWR"].map(fam => {
        const name = fam === "S" ? sharks[next.S++] : NAMES[fam][next[fam]++];
        return ANIMALS.findIndex(a => a.name === name);
      });
    })();
    // Every run has the same shape: visits[t] = the slots examined during tick t.
    function loopRun(layout, earlyExit) {
      const visits = [], found = [];
      let breakAt = null;
      for (let slot = 0; slot < layout.length; slot++) {
        visits.push([slot]);
        if (isShark(layout[slot])) found.push(layout[slot]);
        else if (earlyExit && found.length) { breakAt = slot; break; }
      }
      return { plan: "loop", visits, found, rows: visits.length, ticks: visits.length, breakAt };
    }
    const planOf = (index, cores) => (index ? "index" : cores === 4 ? "parallel" : "seq");
    function sqlRun(layout, plan) {
      const slots = layout.map((_, sl) => sl);
      const visits = plan === "parallel" ? [0, 1, 2, 3, 4, 5].map(k => [0, 6, 12, 18].map(p => p + k))
        : plan === "index" ? slots.filter(sl => isShark(layout[sl])).map(sl => [sl])  // entries in row order
          : slots.map(sl => [sl]);
      const examined = visits.flat();
      return {
        plan, visits, found: examined.map(sl => layout[sl]).filter(isShark),
        rows: examined.length, ticks: visits.length + (plan === "index" ? 1 : 0), breakAt: null,  // +1 = index probe
      };
    }
    // ---------------- End model ----------------

    const PLAN_TEXT = { index: "Index Scan using animals_family_idx", parallel: "Parallel Seq Scan, 4 workers", seq: "Seq Scan on animals" };
    const PLAN_SHORT = { loop: "loop", seq: "Seq Scan", parallel: "Parallel Seq Scan", index: "Index Scan" };
    const TICK_SUB = { parallel: "24 rows ÷ 4 cores", index: "1 probe + 6 rows" };
    const TICK_MS = 90;

    // State lives outside the SVG so a phone <-> desktop rebuild keeps it.
    let reorganized = false, indexOn = false, cores = 1, earlyExit = false;
    let running = false;     // false, or the program being animated: "loop" | "sql"
    let moving = false, epoch = 0, moveEpoch = 0, lastPlan = "seq";
    let marks = {};          // animal -> "seen" | "found" | "missed" (from the last run)
    let breakSlot = null;    // where the early-exit loop stopped
    let status = ["", ""];   // [text, color] of the live run readout
    let compact = ctx.compact, G = null, V = null;
    const layout = () => (reorganized ? LAYOUT_B : LAYOUT_A);
    const paint = (el, props) => { for (const k in props) el.style.setProperty(k, String(props[k])); return el; };

    // ---------------- Notes ----------------
    const N = {
      initial: ["Both programs answer the same question: <b>which animals are sharks?</b> Right now they do the same work (24 rows). Now change the world (add an index, add cores, reorganize storage) and run them again.", "info"],
      reorg: ["Records moved to new pages, as a database may do to reclaim space. Run both programs again.", "info"],
      restore: ["Records moved back to their original pages, grouped by family. Run both programs again.", "info"],
      exitOn: ["The loop is now <b>hand-optimized</b>: the sharks seem to be stored together, so it stops at the first non-shark after finding one. Run the loop.", "info"],
      exitOff: ["The loop is back to checking every row. Run it again.", "info"],
    };
    function controlNote(what) {
      const p = planOf(indexOn, cores);
      return [what + (p !== lastPlan
        ? ` The SQL text didn't change, but the plan the database picks did: <b>${PLAN_TEXT[p]}</b>.`
        : ` The SQL plan stays <b>${PLAN_TEXT[p]}</b>.`) + " Run both programs.", "info"];
    }
    function loopNote() {
      if (earlyExit && reorganized) return ["The database reorganized its storage (as it's free to do), sharks are no longer contiguous, and the 'optimized' loop <b>silently returned 2 of 6 sharks</b>. The SQL query never depended on storage order, so it's still right.", "bad"];
      if (earlyExit) return ["The hand-optimization works: sharks happen to be stored together, so the loop stops after 7 rows. It relies on a physical detail nobody promised to keep.", "warn"];
      if (reorganized) return ["The plain loop is still correct, but its results come back in a different order. SQL never promised an order (you need <code>ORDER BY</code> for that), so no SQL user could have relied on it.", "info"];
      if (indexOn || cores === 4) {
        const idle = indexOn && cores === 4 ? "The index and the extra cores" : indexOn ? "The index" : "The extra cores";
        return [`${idle} sat idle: the loop's code says 'visit every element, one at a time, in storage order', so that's what runs.`, "warn"];
      }
      return ["The loop examined all 24 rows, exactly as written. So far, nothing to choose between them.", "info"];
    }
    function sqlNote(plan) {
      const [html, tone] = plan === "index"
        ? ["Same SQL, new plan: the database noticed the index and examined only the 6 sharks. The loop can't benefit: it says exactly how to iterate, so it iterates.", "ok"]
        : plan === "parallel"
          ? ["The database split the scan across 4 workers, one page each: 6 ticks instead of 24. The loop prescribes a sequential order, so it stays on one core.", "ok"]
          : ["Seq Scan: with no index and one core, the database does what the loop does and reads all 24 rows. The difference is that it's free to do something smarter the moment something changes.", "info"];
      const interleaved = plan === "parallel" && reorganized ? " The workers' rows arrive interleaved, which is allowed: without <code>ORDER BY</code>, SQL promises no order." : "";
      return [html + (reorganized ? " Storage order changed underneath it; the answer is still exactly the 6 sharks." : "") + interleaved, tone];
    }

    // ---------------- Geometry ----------------
    function geometry(phone) {
      return phone ? {
        W: 360, H: 330, fs: 11, cw: 44, ch: 38, dx: 50, dy: 44,
        page: i => ({ x: [8, 186][i % 2], y: [26, 150][i >> 1], w: 166, h: 116 }),
        index: { x: 8, y: 280, w: 140, h: 36 }, status: [352, 16],
        cores: { x: 160, y: 280, h: 36, sq: 32, x0: 196, step: 39 },
      } : {
        W: 640, H: 220, fs: 12, cw: 40, ch: 40, dx: 46, dy: 46,
        page: i => ({ x: 8 + i * 158, y: 26, w: 150, h: 118 }),
        index: { x: 8, y: 166, w: 150, h: 34 }, status: [632, 184],
        cores: { x: 180, y: 166, h: 34, sq: 32, x0: 224, step: 40 },
      };
    }
    function slotXY(slot) {
      const p = G.page(Math.floor(slot / 6)), i = slot % 6;
      return { x: p.x + 10 + (i % 3) * G.dx, y: p.y + 26 + Math.floor(i / 3) * G.dy };
    }

    // ---------------- SVG scene ----------------
    function makeCell(a) {
      const { fam, name } = ANIMALS[a], c = FAM[fam].c;
      const g = s("g");
      g.append(
        s("rect", { width: G.cw, height: G.ch, rx: 6, fill: "var(--viz-panel)" }),  // hides index lines beneath
        s("rect", { width: G.cw, height: G.ch, rx: 6, fill: `var(--viz-${c}-soft)`, stroke: `var(--viz-${c})`, "stroke-width": 1.5 }),
        ctx.text(G.cw / 2, G.ch / 2 + 1, fam, { size: 13, weight: 700 }),
        s("title", null, `${name} (${FAM[fam].name})`));
      g.mark = s("rect", { x: -2, y: -2, width: G.cw + 4, height: G.ch + 4, rx: 7, fill: "none" });
      g.appendChild(g.mark);
      return g;
    }

    function buildSvg() {
      compact = ctx.compact;
      G = geometry(compact);
      const svg = ctx.svg({ w: G.W, h: G.H, label: "Table animals stored on 4 pages of 6 rows, with an optional index and 1 or 4 CPU cores" });
      const L = {};
      ["pages", "lines", "cells", "bottom", "overlay"].forEach(k => svg.appendChild(L[k] = s("g")));
      const muted = { size: G.fs, anchor: "start", fill: "var(--viz-muted)" };
      L.pages.appendChild(ctx.text(8, 16, "table animals: physical storage", muted));
      const statusEl = ctx.text(G.status[0], G.status[1], "", { size: G.fs, anchor: "end", weight: 700 });
      L.pages.appendChild(statusEl);
      for (let p = 0; p < 4; p++) {
        const pg = G.page(p);
        L.pages.appendChild(s("rect", { x: pg.x, y: pg.y, width: pg.w, height: pg.h, rx: 8, fill: "var(--viz-panel)", stroke: "var(--viz-line)" }));
        L.pages.appendChild(ctx.text(pg.x + 8, pg.y + 16, "page " + (p + 1), muted));
      }
      const cells = ANIMALS.map((_, a) => makeCell(a));
      L.cells.append(...cells);

      const ix = G.index, lines = {};
      SHARK_IDS.forEach(a => { lines[a] = L.lines.appendChild(s("path", { fill: "none", stroke: "var(--viz-c6)", "stroke-dasharray": "4 3" })); });
      const indexRect = s("rect", { x: ix.x, y: ix.y, width: ix.w, height: ix.h, rx: 8 });
      const indexText = ctx.text(ix.x + ix.w / 2, ix.y + ix.h / 2 + 1, "", { size: G.fs });
      L.bottom.append(indexRect, indexText);

      const cc = G.cores, cy = cc.y + cc.h / 2;
      L.bottom.appendChild(ctx.text(cc.x, cy + 1, "cores", muted));
      const coreEls = [0, 1, 2, 3].map(i => {
        const x = cc.x0 + i * cc.step;
        const rect = s("rect", { x, y: cy - cc.sq / 2, width: cc.sq, height: cc.sq, rx: 6 });
        const label = ctx.text(x + cc.sq / 2, cy + 1, String(i + 1), { size: G.fs, weight: 700 });
        L.bottom.append(rect, label);
        return { rect, label };
      });

      V = { ...L, cells, lines, indexRect, indexText, coreEls, statusEl, pos: [] };
      const lay = layout();
      ANIMALS.forEach((_, a) => setPos(a, slotXY(lay.indexOf(a))));
      renderIndex();
      renderCores(0);
      renderMarks();
      setStatus(...status);
      svgHost.replaceChildren(svg);
    }

    // Index pointer to a shark's row: up from the index box into the channel under the pages,
    // along it, then up to the cell (drawn beneath the cells), so it follows the cell when it moves.
    function pointer(a) {
      const ix = G.index, ox = ix.x + ix.w / 2, cy = (G.page(3).y + G.page(3).h + ix.y) / 2;
      const tx = V.pos[a].x + G.cw / 2;
      return [[ox, ix.y], [ox, cy], [tx, cy], [tx, V.pos[a].y + G.ch]];
    }
    function setPos(a, p) {
      V.pos[a] = p;
      V.cells[a].setAttribute("transform", `translate(${p.x},${p.y})`);
      if (V.lines[a]) V.lines[a].setAttribute("d", "M" + pointer(a).join(" L"));
    }
    // A dot that travels along a polyline (the index pointer) in `ms`.
    async function travel(pts, ms) {
      const dot = V.overlay.appendChild(s("circle", { r: 5, fill: "var(--viz-c6)", stroke: "var(--viz-bg)", "stroke-width": 1.5 }));
      const segs = pts.slice(1).map((q, i) => [pts[i], q, Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1])]);
      const total = segs.reduce((sum, sg) => sum + sg[2], 0);
      await ctx.tween({ ms, ease: "inOut", onUpdate: k => {
        let d = k * total, i = 0;
        while (i < segs.length - 1 && d > segs[i][2]) d -= segs[i++][2];
        const [p, q, len] = segs[i], f = len ? Math.min(1, d / len) : 1;
        ctx.attr(dot, { cx: ctx.lerp(p[0], q[0], f), cy: ctx.lerp(p[1], q[1], f) });
      } });
      dot.remove();
    }

    function renderIndex(flash = false) {
      paint(V.indexRect, indexOn
        ? { fill: "var(--viz-c6-soft)", stroke: "var(--viz-c6)", "stroke-width": flash ? 3.5 : 1.5, "stroke-dasharray": "none" }
        : { fill: "none", stroke: "var(--viz-line)", "stroke-width": 1.5, "stroke-dasharray": "5 4" });
      V.indexText.textContent = indexOn ? "index: family" : "no index";
      paint(V.indexText, { fill: indexOn ? "var(--viz-ink)" : "var(--viz-muted)", "font-weight": indexOn ? 600 : 400 });
      Object.values(V.lines).forEach(l => paint(l, { display: indexOn ? "inline" : "none", opacity: flash ? 1 : 0.5, "stroke-width": 1.2 }));
    }

    function renderCores(active) {
      V.coreEls.forEach(({ rect, label }, i) => {
        const avail = i < cores, lit = i < active;
        paint(rect, {
          fill: lit ? "var(--viz-warn-soft)" : avail ? "var(--viz-node)" : "none",
          stroke: lit ? "var(--viz-warn)" : avail ? "var(--viz-node-stroke)" : "var(--viz-muted)",
          "stroke-width": lit ? 2.5 : 1.5, "stroke-dasharray": avail ? "none" : "4 3",
        });
        paint(label, { fill: avail ? "var(--viz-ink)" : "var(--viz-muted)" });
      });
    }

    const MARK = {
      seen: { stroke: "var(--viz-muted)", "stroke-width": 1.5, "stroke-dasharray": "none" },
      found: { stroke: "var(--viz-ok)", "stroke-width": 2.5, "stroke-dasharray": "none" },
      missed: { stroke: "var(--viz-bad)", "stroke-width": 2, "stroke-dasharray": "4 3" },
    };
    function setMark(a, kind) {
      if (kind) marks[a] = kind; else delete marks[a];
      const m = V.cells[a].mark;
      paint(m, kind ? { display: "inline", ...MARK[kind] } : { display: "none" });
    }
    function renderMarks() {
      ANIMALS.forEach((_, a) => setMark(a, marks[a]));
      if (breakSlot !== null && !running) drawBreak(breakSlot);
    }
    function clearMarks() { marks = {}; breakSlot = null; if (V) renderMarks(); }

    function cursorAt(slot, color) {
      const el = s("rect", { width: G.cw + 8, height: G.ch + 8, rx: 9, fill: "none", stroke: color, "stroke-width": 3 });
      moveCursor(el, slot);
      return V.overlay.appendChild(el);
    }
    function moveCursor(el, slot) { const { x, y } = slotXY(slot); ctx.attr(el, { x: x - 4, y: y - 4 }); }

    // Red cursor plus a "break" tag that sits in the gap between the two rows of a page.
    function drawBreak(slot) {
      const { x, y } = slotXY(slot), topRow = slot % 6 < 3, gap = G.dy - G.ch;
      const cx = x + G.cw / 2, ty = topRow ? y + G.ch + gap / 2 : y - gap / 2;
      cursorAt(slot, "var(--viz-bad)");
      V.overlay.append(
        s("rect", { x: cx - 22, y: ty - 8, width: 44, height: 16, rx: 8, fill: "var(--viz-bad)" }),
        ctx.text(cx, ty + 1, "break", { size: G.fs, weight: 700, fill: "var(--viz-bg)" }));
    }

    function setStatus(text, color) {
      status = [text, color];
      V.statusEl.textContent = text;
      paint(V.statusEl, { fill: color || "var(--viz-muted)" });
    }

    // ---------------- Runs ----------------
    async function play(m) {
      const my = ++epoch, who = m.plan === "loop" ? "loop" : "sql";
      const stale = () => my !== epoch;
      if (moving) snapLayout();
      running = who;
      syncButtons();
      clearMarks();
      V.overlay.innerHTML = "";
      setStats(who, null);
      setResult(who, null, "running…");
      const color = who === "loop" ? "var(--viz-warn)" : "var(--viz-c6)";
      let tick = 0, cursors = null;
      const show = () => setStatus(`${PLAN_SHORT[m.plan]} · tick ${tick}`, color);
      renderCores(m.visits[0].length);
      if (m.plan === "index") {   // tick 1: look up 'Sharks' in the index
        tick = 1; show(); renderIndex(true);
        await ctx.sleep(300); if (stale()) return;
        renderIndex(false);
      }
      const lay = layout();
      for (const slots of m.visits) {
        tick++;
        if (m.plan === "index") {   // follow the index entry straight to the row
          const a = lay[slots[0]];
          paint(V.lines[a], { opacity: 1, "stroke-width": 2 });
          await travel(pointer(a), 150);
          if (stale()) return;
        }
        cursors = cursors || slots.map(sl => cursorAt(sl, color));
        slots.forEach((sl, k) => { moveCursor(cursors[k], sl); setMark(lay[sl], isShark(lay[sl]) ? "found" : "seen"); });
        show();
        if (m.plan !== "index") { await ctx.sleep(TICK_MS); if (stale()) return; }
      }
      await ctx.sleep(m.breakAt !== null ? 0 : 250); if (stale()) return;
      V.overlay.innerHTML = "";
      renderIndex();
      renderCores(0);
      SHARK_IDS.forEach(a => { if (!m.found.includes(a)) setMark(a, "missed"); });
      breakSlot = m.breakAt;
      running = false;
      if (breakSlot !== null) drawBreak(breakSlot);
      syncButtons();
      setStatus(`${PLAN_SHORT[m.plan]} · ${m.ticks} ticks`, m.found.length === 6 ? color : "var(--viz-bad)");
      setStats(who, m);
      setResult(who, m);
      note.set(...(who === "loop" ? loopNote() : sqlNote(m.plan)));
    }

    function cancelRun() {
      epoch++;
      if (running) setResult(running, null);
      running = false;
      if (V) { V.overlay.innerHTML = ""; renderIndex(); renderCores(0); setStatus("", ""); }
      syncButtons();
    }

    // Ends a reorganization in progress (a run started mid-move, or a phone/desktop rebuild).
    function snapLayout() {
      moveEpoch++;
      moving = false;
      const lay = layout();
      ANIMALS.forEach((_, a) => setPos(a, slotXY(lay.indexOf(a))));
    }
    async function animateLayout() {
      const my = ++moveEpoch, lay = layout();
      moving = true;
      const from = V.pos.slice(), to = ANIMALS.map((_, a) => slotXY(lay.indexOf(a)));
      // Slightly staggered by destination slot, so the shuffle reads as records moving one by one.
      const lag = (k, a) => ctx.ease.inOut(ctx.clamp((k - lay.indexOf(a) * 0.012) / 0.72, 0, 1));
      await ctx.tween({
        ms: 600, ease: "linear",
        onUpdate: k => {
          if (my !== moveEpoch) return;
          ANIMALS.forEach((_, a) => {
            const f = lag(k, a);
            setPos(a, { x: ctx.lerp(from[a].x, to[a].x, f), y: ctx.lerp(from[a].y, to[a].y, f) });
          });
        },
      });
      if (my === moveEpoch) moving = false;
    }

    // Any change to the world invalidates every number on screen.
    function worldChanged([html, tone]) {
      cancelRun();
      clearMarks();
      ["loop", "sql"].forEach(w => { setStats(w, null); setResult(w, null); });
      updatePlan();
      note.set(html, tone);
    }

    // ---------------- HTML: controls, code, stats ----------------
    const indexToggle = ui.toggle({
      label: "Index on family", value: indexOn,
      onChange: v => { indexOn = v; worldChanged(controlNote(v ? "You added an index on <b>family</b>." : "You dropped the index.")); },
    });
    const coresSeg = ui.segmented({
      label: "CPU cores", options: [{ value: 1, label: "1" }, { value: 4, label: "4" }], value: cores,
      onChange: v => {
        if (v === cores) return;
        cores = v;
        worldChanged(controlNote(v === 4 ? "The machine now has <b>4 CPU cores</b>." : "Back to <b>1 core</b>."));
      },
    });
    const reorgBtn = ui.button("Reorganize storage", () => {
      reorganized = !reorganized;
      reorgBtn.setLabel(reorganized ? "Restore original layout" : "Reorganize storage");
      worldChanged(reorganized ? N.reorg : N.restore);
      animateLayout();
    });
    const exitToggle = ui.toggle({
      label: "Hand-optimize the loop (stop early)", value: earlyExit,
      onChange: v => { earlyExit = v; renderLoopCode(); worldChanged(v ? N.exitOn : N.exitOff); },
    });
    const runLoopBtn = ui.button("▶ Run loop", () => play(loopRun(layout(), earlyExit)));
    const runSqlBtn = ui.button("▶ Run SQL", () => play(sqlRun(layout(), planOf(indexOn, cores))), { kind: "primary" });
    function syncButtons() { runLoopBtn.disable(!!running); runSqlBtn.disable(!!running); }

    const PRE = "margin:0;padding:10px 8px;font-family:var(--font-mono);font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--viz-ink)";
    const LINE = "display:block;padding:0 4px;border-radius:4px;";
    function codeLine(text, extra = "") {
      const [, code, comment] = text.match(/^(.*?)((?:\/\/|--).*)?$/);
      return h("span", { style: LINE + extra }, code || (comment ? "" : " "),
        comment ? h("span", { style: "color:var(--text-muted)" }, comment) : null);
    }
    const LOOP_CODE = [
      "function getSharks() {", "  const sharks = [];", "  // visit rows in storage order", "  for (const a of animals) {",
      '    if (a.family === "Sharks") {', "      sharks.push(a);",
      ["    } else if (sharks.length > 0) {"], ["      break; // hand-optimized"],
      "    }", "  }", "  return sharks;", "}",
    ];
    const loopPre = h("pre", { style: PRE });
    function renderLoopCode() {
      loopPre.replaceChildren(...LOOP_CODE.filter(l => earlyExit || typeof l === "string").map(l =>
        typeof l === "string" ? codeLine(l) : codeLine(l[0], "background:var(--viz-warn-soft);box-shadow:inset 3px 0 var(--viz-warn);")));
    }
    const planEl = h("span", { style: LINE + "color:var(--viz-c6);font-weight:700" });
    const sqlPre = h("pre", { style: PRE },
      ...["SELECT * FROM animals", "WHERE family = 'Sharks';", "", "-- plan chosen by the database:"].map(l => codeLine(l)),
      planEl,
      ...["-- simplified: a real optimizer", "-- uses the index only if its", "-- statistics say that's cheaper"].map(l => codeLine(l)));
    let unflash = null;
    function updatePlan() {
      const p = planOf(indexOn, cores);
      planEl.textContent = PLAN_TEXT[p];
      if (p !== lastPlan) {   // flash so the reader notices the plan changed before any run
        if (unflash) unflash();
        Object.assign(planEl.style, { transition: "background-color .15s", backgroundColor: "color-mix(in srgb, var(--viz-c6) 30%, transparent)" });
        unflash = ctx.after(1100, () => Object.assign(planEl.style, { transition: "background-color .8s", backgroundColor: "transparent" }));
      }
      lastPlan = p;
    }

    const stats = ui.stats([
      { key: "loopRows", label: "Loop: rows examined" }, { key: "loopTicks", label: "Loop: time (ticks)" },
      { key: "loopFound", label: "Loop: sharks found" }, { key: "sqlRows", label: "SQL: rows examined" },
      { key: "sqlTicks", label: "SQL: time (ticks)" }, { key: "sqlFound", label: "SQL: sharks found" },
    ]);
    stats.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";  // loop row above SQL row, metrics aligned
    function setStats(who, m) {
      const sub = m && TICK_SUB[m.plan]
        ? ` <span style="font-size:11px;font-weight:600;color:var(--text-muted);white-space:nowrap">${TICK_SUB[m.plan]}</span>` : "";
      stats.set(who + "Rows", m ? m.rows : "–", "");
      stats.set(who + "Ticks", m ? m.ticks + sub : "–", "");
      stats.set(who + "Found", m ? `${m.found.length} / 6` : "–", m ? (m.found.length === 6 ? "ok" : "bad") : "");
    }
    const resLoop = h("div"), resSql = h("div");
    const results = h("div", { class: "viz-mono", style: "font-size:12px;line-height:1.6;margin-top:-4px" }, resLoop, resSql);
    function setResult(who, m, pending = "–") {
      const names = ids => ids.map(a => ANIMALS[a].name).join(", ");
      const head = `<span style="color:var(--text-muted)">${who === "loop" ? "loop" : "SQL"} returned:</span> `;
      const missed = m ? SHARK_IDS.filter(a => !m.found.includes(a)) : [];
      (who === "loop" ? resLoop : resSql).innerHTML = head + (m ? names(m.found) : pending) +
        (missed.length ? ` <span style="color:var(--viz-bad)">(missed: ${names(missed)})</span>` : "");
    }

    const caption = h("div", { class: "muted", style: "font-size:12px;line-height:1.45;margin:-2px 0 8px" },
      "Toy scale: picture a large table in which sharks are a small fraction of rows. Time: each busy core examines one row per tick.");
    const legend = ui.legend([
      { color: "var(--viz-c5)", label: "S shark", shape: "square" },
      { color: "var(--viz-c2)", label: "W whale", shape: "square" },
      { color: "var(--viz-c8)", label: "R ray", shape: "square" },
      { color: "var(--viz-muted)", label: "row examined", shape: "line" },
      { color: "var(--viz-ok)", label: "shark returned", shape: "line" },
      { color: "var(--viz-bad)", label: "shark missed", shape: "dash" },
    ]);
    const note = ui.note(...N.initial);
    const svgHost = h("div");
    const bars = [ui.bar(indexToggle, coresSeg, reorgBtn), ui.bar(exitToggle, runLoopBtn, runSqlBtn)];
    const code = ui.row(ui.panel("Imperative loop (JavaScript)", loopPre), ui.panel("Declarative query (SQL)", sqlPre));
    [...code.children].forEach(p => { p.style.flex = "1 1 310px"; });  // stack before the code would wrap

    // Phones put the results right under the scene (no scrolling past the code after each run).
    function arrange() {
      const order = compact ? [caption, svgHost, legend, stats, results, note, code] : [caption, svgHost, legend, code, stats, results, note];
      root.append(...bars, ...order);
      code.style.marginTop = compact ? "12px" : "";
      // Uppercase labels would break into three lines in a phone-width card.
      stats.querySelectorAll(".viz-stat-label").forEach(l => {
        Object.assign(l.style, compact ? { textTransform: "none", letterSpacing: "0", fontSize: "11.5px" } : { textTransform: "", letterSpacing: "", fontSize: "" });
      });
    }

    renderLoopCode();
    updatePlan();
    setStats("loop", loopRun(LAYOUT_A, false));
    setResult("loop", loopRun(LAYOUT_A, false));
    setStats("sql", sqlRun(LAYOUT_A, "seq"));
    setResult("sql", sqlRun(LAYOUT_A, "seq"));
    buildSvg();
    arrange();
    syncButtons();

    // Rebuild the scene when the frame crosses the phone breakpoint (deferred out of the
    // ResizeObserver callback, so the layout change doesn't trigger a resize-loop error).
    ctx.onResize(() => ctx.after(0, () => {
      if (ctx.compact === compact) return;
      if (running) { cancelRun(); clearMarks(); }
      moveEpoch++;
      moving = false;
      buildSvg();
      arrange();
    }));
  },
});
