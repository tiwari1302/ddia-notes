// Publishing batch output (DDIA ch10): writing rows into the live database from inside batch
// tasks vs building an immutable new version and atomically switching readers to it.
// Every control change rebuilds the scenario. All numbers are illustrative.
Viz.register("ch10/batch-output", {
  title: "Publishing batch output",
  mount(root, ctx) {
    const { s, h, ui, lerp } = ctx;
    const V = n => `var(--viz-${n})`;
    const PER = 50;                                    // thousands of users per task
    const K = v => (Math.round(v) === 0 ? "0" : Math.round(v) + "k");
    const p99Tone = ms => (ms <= 20 ? "ok" : ms <= 50 ? "warn" : "bad");
    const TASKS = ["T1 · users 0–50k", "T2 · users 50–100k", "T3 · users 100–150k", "T4 · users 150–200k"];
    const LAYOUTS = {
      desk: {
        W: 640, H: { direct: 300, swap: 300 }, mono: 12, below: false,
        job: { x: 10, y: 24, w: 240, h: 256, row0: 50, dy: 54 },
        db: { x: 300, y: 124, w: 330 }, webD: { x: 390, y: 36, w: 150 },
        store: { x: 264, y: 34, w: 172 }, serve: { x: 450, y: 112, w: 180 }, webS: { x: 450, y: 24, w: 180 },
      },
      phone: {
        W: 360, H: { direct: 466, swap: 494 }, mono: 11, below: true,
        job: { x: 8, y: 8, w: 344, h: 200, row0: 46, dy: 38 },
        db: { x: 8, y: 226, w: 344 }, webD: { x: 105, y: 400, w: 150 },
        store: { x: 8, y: 226, w: 168 }, serve: { x: 184, y: 248, w: 168 }, webS: { x: 184, y: 404, w: 168 },
      },
    };

    // ---------- model: a task holds the progress (0..1) of each attempt; attempt 2 is a retry ----------
    const newTasks = () => TASKS.map(() => ({ att: [0], dead: false }));
    const cur = t => t.att[t.att.length - 1];
    const deadNow = t => t.dead && t.att.length === 1;
    // Direct writes: every row any attempt wrote stays in the DB, so a retry writes the overlap
    // of both attempts' ranges a second time.
    const v42Rows = t => Math.max(...t.att) * PER;
    const dupRows = t => (t.att.length > 1 ? Math.min(t.att[0], t.att[1]) * PER : 0);
    const total = (st, f) => st.tasks.reduce((a, t) => a + f(t), 0);

    // ---------- persistent state and panels (survive rebuilds) ----------
    let mode = "direct", fail = true, bug = false, compact = ctx.compact, gen = 0, player = null;
    const stage = h("div");
    const note = ui.note("");
    const stats = ui.stats([
      { key: "vis", label: "Rows visible before job done", value: "0" },
      { key: "dup", label: "Duplicate rows", value: "0" },
      { key: "p99", label: "Web p99 during job", value: "–" },
      { key: "undo", label: "Undo a bad run", value: "–" },
    ]);

    function controls() {
      const seg = ui.segmented({
        label: "Publish by", value: mode,
        options: [
          { value: "direct", label: compact ? "Write to live DB" : "Writing rows into the live DB" },
          { value: "swap", label: compact ? "Build & swap" : "Building files, then swapping" },
        ],
        onChange: v => { if (v !== mode) { mode = v; restart(); } },
      });
      const failT = ui.toggle({ label: "A task fails and is retried", value: fail, onChange: v => { fail = v; restart(); } });
      const bugT = ui.toggle({ label: "The new code has a bug", value: bug, onChange: v => { bug = v; restart(); } });
      return ui.bar(seg, failT, bugT);
    }

    // ---------- small SVG helpers ----------
    const T = (x, y, str, o = {}) => ctx.text(x, y, str, { size: 12, ...o });
    const R = (x, y, w, hh, o = {}) => s("rect", { x, y, width: w, height: hh, ...o });
    const group = (parent, x, y) => parent.appendChild(s("g", { transform: `translate(${x},${y})` }));
    const spans = (el, parts) => el.replaceChildren(...parts.map(([str, c]) => s("tspan", { fill: V(c) }, str)));

    // ---------- animation helpers: every await goes through guard(), so after a rebuild
    // (gen bumps) a stale step never resumes and cannot draw over the new scenario ----------
    const guard = (st, p) => p.then(v => (st.gen === gen ? v : new Promise(() => {})));
    const nap = (st, ms) => guard(st, ctx.sleep(ms));
    const tween = (st, ms, fn) => guard(st, ctx.tween({ ms, onUpdate: k => { fn(k); render(st); } }));
    const fade = (st, el, to, ms = 350) => {
      const from = Number(el.getAttribute("opacity") ?? 1);
      return tween(st, ms, k => el.setAttribute("opacity", lerp(from, to, k)));
    };
    // Moves each task's current attempt to its target progress (undefined = unchanged).
    function advance(st, to, ms, extra) {
      const from = st.tasks.map(cur);
      return tween(st, ms, k => {
        st.tasks.forEach((t, i) => { if (to[i] !== undefined) t.att[t.att.length - 1] = lerp(from[i], to[i], k); });
        if (extra) extra(k);
      });
    }
    // Output packets leaving task rows; list = [[task, delayMs, color?]]. Targets are read at launch.
    const send = (st, list) => Promise.all(list.map(([i, delay, color]) => nap(st, delay).then(() =>
      guard(st, ctx.fly(st.packets, { from: st.rows[i].out, to: st.target(i), r: 5, ms: 550, fill: V(color || "c5") })))));
    const wave = (n, gap, offset = 150) => {           // n packets per task, staggered
      const out = [];
      for (let j = 0; j < n; j++) for (let i = 0; i < 4; i++) out.push([i, offset + j * gap + i * 90]);
      return out;
    };
    const setAll = (st, text, tone) => { st.status = st.tasks.map(() => [text, tone]); };

    // ---------- scene ----------
    function drawJob(st, parent) {
      const J = st.L.job, g = group(parent, J.x, J.y), x0 = 12, bw = J.w - 24;
      g.append(R(0, 0, J.w, J.h, { rx: 10, fill: V("panel"), stroke: V("line") }),
        T(x0, 20, "Nightly job v42", { anchor: "start", weight: 700, size: 13 }));
      st.jobEl = g.appendChild(T(J.w - 12, 20, "", { anchor: "end", weight: 600 }));
      st.rows = TASKS.map((name, i) => {
        const y = J.row0 + i * J.dy, by = y + 9, tx = x0 + 0.6 * bw;
        g.append(T(x0, y, name, { anchor: "start" }), R(x0, by, bw, 12, { rx: 3, fill: V("grid") }));
        return {
          bw, out: [J.x + x0 + bw + 6, J.y + by + 6],
          status: g.appendChild(T(x0 + bw, y, "", { anchor: "end", weight: 600 })),
          fill: g.appendChild(R(x0, by, 0, 12, { rx: 3, fill: V("c5") })),
          // where the failed attempt died, kept visible while the retry runs
          tick: g.appendChild(s("line", { x1: tx, x2: tx, y1: by - 4, y2: by + 16, stroke: V("bad"), "stroke-width": 2.5, opacity: 0 })),
        };
      });
    }

    function drawDB(st, parent) {
      const D = st.L.db, P = st.L.webD, below = st.L.below, g = group(parent, D.x, D.y);
      const bx = 14, by = 80, qw = (D.w - 28) / 4;
      st.dbRect = g.appendChild(R(0, 0, D.w, 132, { rx: 10, fill: V("panel"), stroke: V("node-stroke"), "stroke-width": 1.5 }));
      g.appendChild(T(D.w / 2, 20, "Production DB", { weight: 700, size: 13 }));
      st.loadEl = g.appendChild(T(D.w / 2, 40, ""));
      st.caption = g.appendChild(T(D.w / 2, 66, "", { weight: 600 }));
      g.appendChild(R(bx, by, qw * 4, 20, { fill: V("c2"), "fill-opacity": 0.45 }));
      st.qw = qw;
      st.q = TASKS.map((_, i) => {
        const x = bx + i * qw;
        g.appendChild(T(x + qw / 2, by + 34, "T" + (i + 1), { fill: V("muted") }));
        return { v42: g.appendChild(R(x, by, 0, 20, { fill: V("c5"), "stroke-width": 2, "stroke-dasharray": "4 2" })), dup: g.appendChild(R(x, by, 0, 20, { fill: V("bad") })) };
      });
      for (let i = 1; i < 4; i++) g.appendChild(s("line", { x1: bx + i * qw, x2: bx + i * qw, y1: by - 3, y2: by + 23, stroke: V("panel"), "stroke-width": 2 }));
      // Packets land at the spot in the users table the task is currently writing.
      st.target = i => [D.x + bx + (i + cur(st.tasks[i])) * qw, D.y + by + 10];
      const wx = P.x + P.w / 2, y1 = below ? P.y - 2 : P.y + 42, y2 = below ? D.y + 136 : D.y - 4;
      parent.append(ctx.arrow({ x1: wx, y1, x2: wx, y2, color: V("c6"), svg: st.svg }),
        T(wx + 8, (y1 + y2) / 2, "reads", { anchor: "start", fill: V("muted") }));
    }

    function drawStore(st, parent) {
      const S = st.L.store, W = S.w, M = st.L.mono, g = group(parent, S.x, S.y);
      const mono = (x, y, str, o) => T(x, y, str, { anchor: "start", mono: true, size: M, ...o });
      g.append(R(0, 0, W, 236, { rx: 10, fill: V("panel"), stroke: V("line") }),
        T(W / 2, 16, "HDFS / object store", { weight: 700 }),
        R(8, 28, W - 16, 42, { rx: 6, fill: V("c2-soft"), stroke: V("c2"), "stroke-width": 1.5 }),
        mono(16, 43, "/recs/v41/", { weight: 700 }),
        T(16, 60, "4 files · _SUCCESS ✓", { anchor: "start", fill: V("muted") }));
      // Tonight's output directory appears when the job starts.
      const v42 = st.v42 = group(g, 0, 0);
      v42.setAttribute("opacity", 0);
      st.v42Rect = v42.appendChild(R(8, 80, W - 16, 148, { rx: 6, fill: "none", stroke: V("node-stroke"), "stroke-width": 1.5, "stroke-dasharray": "5 4" }));
      v42.appendChild(mono(16, 96, "/recs/v42/", { weight: 700 }));
      st.temp = v42.appendChild(s("g"));
      st.temp.append(R(14, 106, W - 28, 116, { rx: 5, fill: V("warn-soft"), stroke: V("warn"), "stroke-dasharray": "3 3" }),
        mono(22, 121, "_temporary/", { fill: V("muted") }));
      st.filesG = v42.appendChild(s("g"));
      const tx = W - 56;
      st.files = TASKS.map((_, i) => {
        const y = 142 + 20 * i, row = st.filesG.appendChild(s("g"));
        row.append(R(tx, y - 4, 36, 8, { rx: 2, fill: V("grid") }));
        return {
          row, w: 36, at: [S.x + tx + 18, S.y + y],
          label: row.appendChild(mono(22, y, `T${i + 1}/attempt_0`)),
          fill: row.appendChild(R(tx, y - 4, 0, 8, { rx: 2, fill: V("warn") })),
          strike: row.appendChild(s("line", { x1: 18, x2: W - 16, y1: y, y2: y, stroke: V("bad"), "stroke-width": 2, opacity: 0 })),
        };
      });
      st.success = v42.appendChild(mono(22, 206, "_SUCCESS ✓", { weight: 700, fill: V("ok") }));
      st.success.setAttribute("opacity", 0);
      st.v42At = [S.x + W / 2, S.y + 160];
      st.target = i => st.files[i].at;
    }

    function drawServe(st, parent) {
      const S = st.L.serve, W = S.w, P = st.L.webS, below = st.L.below, g = group(parent, S.x, S.y);
      const cy = below ? 46 : 10, ty = below ? 16 : 78, cw = (W - 24) / 2;
      g.append(R(0, 0, W, 108, { rx: 10, fill: V("panel"), stroke: V("node-stroke"), "stroke-width": 1.5 }),
        T(W / 2, ty, "Serving cluster", { weight: 700 }),
        T(W / 2, ty + 16, "read-only, local disks", { fill: V("muted") }),
        R(16 + cw, cy, cw, 50, { rx: 6, fill: "none", stroke: V("line"), "stroke-dasharray": "4 4" }));
      st.chips = ["v41", "v42"].map((ver, i) => {
        const x = 8 + i * (cw + 8), c = g.appendChild(s("g")), color = i ? "c5" : "c2";
        const chip = {
          g: c, cx: S.x + x + cw / 2, edge: S.y + (below ? cy + 54 : cy - 4),
          rect: c.appendChild(R(x, cy, cw, 50, { rx: 6, fill: V(color + "-soft"), stroke: V(color), "stroke-width": 1.5 })),
          load: c.appendChild(R(x, cy, 0, 50, { rx: 6, fill: V(color), "fill-opacity": 0.22 })),
          w: cw,
        };
        c.appendChild(T(x + cw / 2, cy + 18, ver, { weight: 700, size: 13 }));
        chip.status = c.appendChild(T(x + cw / 2, cy + 36, "", { weight: 600 }));
        return chip;
      });
      st.chips[1].g.setAttribute("opacity", 0);
      const x1 = st.chips[0].cx, y1 = below ? P.y - 2 : P.y + 42;
      st.ptr = parent.appendChild(ctx.arrow({ x1, y1, x2: x1, y2: st.chips[0].edge, color: V("c6"), width: 2.2, svg: st.svg }));
      parent.appendChild(T(x1 - 8, (y1 + st.chips[0].edge) / 2, "reads", { anchor: "end", fill: V("muted") }));
      st.point = f => st.ptr.setAttribute("d", `M${x1},${y1} L${lerp(st.chips[0].cx, st.chips[1].cx, f)},${st.chips[0].edge}`);
      st.chipAt = [st.chips[1].cx, st.chips[1].edge + (below ? -25 : 25)];
      st.seesEl = parent.appendChild(T((below ? P : S).x + W / 2, below ? P.y + 58 : S.y + 126, "", { weight: 600 }));
      chipStatus(st, 0, "serving", "c6");
      sees(st, "v41");
    }
    const sees = (st, ver) => spans(st.seesEl, [["readers see: ", "muted"], ["all of " + ver, ver === "v41" ? "c2" : "c5"]]);
    function chipStatus(st, i, text, tone) { st.chips[i].status.textContent = text; st.chips[i].status.style.fill = V(tone); }

    function render(st) {
      if (st.gen !== gen) return;
      st.tasks.forEach((t, i) => {
        const r = st.rows[i];
        ctx.attr(r.fill, { width: cur(t) * r.bw });
        r.fill.style.fill = deadNow(t) ? `url(#${st.hatch})` : V("c5");
        r.tick.setAttribute("opacity", t.dead && !deadNow(t) ? 1 : 0);
        r.status.textContent = st.status[i][0];
        r.status.style.fill = V(st.status[i][1]);
      });
      st.jobEl.textContent = st.job[0];
      st.jobEl.style.fill = V(st.job[1]);
      st.p99El.textContent = `p99 read: ${Math.round(st.p99)} ms`;
      st.p99El.style.fill = V(p99Tone(st.p99));
      // v42 rows readers can already see while the job is still running (frozen once it is done)
      if (!st.jobDone) st.visible = st.direct ? total(st, v42Rows) : 0;
      const dup = st.direct ? total(st, dupRows) : 0, zero = st.writing ? "ok" : "";
      stats.set("vis", st.visible > 199.5 ? "all 200k" : K(st.visible), st.visible > 0.5 ? "bad" : zero);
      stats.set("dup", K(dup), dup > 0.5 ? "bad" : zero);
      if (st.direct) renderDB(st, dup);
      else st.tasks.forEach((t, i) => {
        const f = st.files[i];
        ctx.attr(f.fill, { width: cur(t) * f.w });
        f.fill.style.fill = deadNow(t) ? `url(#${st.hatch})` : V(st.committed ? "c5" : "warn");
      });
    }

    function renderDB(st, dup) {
      const v42 = total(st, v42Rows), sep = [" · ", "muted"];
      st.tasks.forEach((t, i) => {
        const q = st.q[i];
        ctx.attr(q.v42, { width: (v42Rows(t) / PER) * st.qw, "fill-opacity": st.broken ? 1 : 0.7 });
        q.v42.style.fill = st.broken ? `url(#${st.hatch})` : V("c5");
        ctx.attr(q.dup, { width: (dupRows(t) / PER) * st.qw });
        // rows left behind by an attempt that died mid-way
        q.v42.style.stroke = deadNow(t) ? V("bad") : "none";
      });
      let parts;
      if (st.broken) parts = [["200k users: empty lists", "bad"], sep, ["v41 overwritten", "muted"]];
      else if (v42 < 0.5) parts = [["200k users", "ink"], sep, ["all v41", "c2"]];
      else if (v42 > 199.5) parts = [["all 200k users on v42", "c5"]];
      else parts = [[K(v42) + " v42", "c5"], sep, [K(200 - v42) + " v41", "c2"]];
      if (dup > 0.5 && !st.broken) parts.push(sep, [K(dup) + " duplicated", "bad"]);
      spans(st.caption, parts);
      const busy = st.writes > 2000;
      st.loadEl.textContent = `writes: ${st.writes.toLocaleString("en-US")}/s` + (busy ? " (normal 2,000/s)" : " (normal)");
      st.loadEl.style.fill = V(busy ? "bad" : "muted");
      st.loadEl.setAttribute("font-weight", busy ? 700 : 400);
      st.dbRect.style.stroke = V(st.broken ? "bad" : busy ? "warn" : "node-stroke");
    }

    // ---------- scenarios ----------
    const START = {
      title: "Job v42 starts: 4 tasks, 50,000 users each",
      run: async st => {
        setAll(st, "running", "ink");
        st.job = ["running", "warn"];
        render(st);
        if (!st.direct) await fade(st, st.v42, 1, 400);
        note.set("Each task computes recommendations for its own 50,000 users. " + (st.direct
          ? "So far every reader still gets yesterday's v41 rows."
          : "The output directory <b>/recs/v42/</b> exists, but tasks write only under its <b>_temporary/</b> area."), "info");
        await nap(st, 300);
      },
    };
    // Step 3 (failure): every task reaches 60%, then T3's machine dies.
    const dieAt60 = async st => {
      await Promise.all([advance(st, [0.6, 0.6, 0.6, 0.6], 700), send(st, wave(1, 0, 50))]);
      st.tasks[2].dead = true;
      st.status[2] = ["✕ died at 60%", "bad"];
      render(st);
    };
    // Step 4 (failure): T3 restarts from zero while the others keep going.
    const retryT3 = (st, packets) => {
      st.tasks[2].att.push(0);
      st.status[2] = ["attempt 2", "warn"];
      render(st);
      return Promise.all([advance(st, [0.9, 0.9, 0.7, 0.9], 1500), send(st, packets)]);
    };

    function directSteps() {
      const steps = [START, {
        title: "Each task writes its rows straight into the production DB, one request per row",
        run: async st => {
          st.writing = true;
          st.writes = 40000;
          stats.set("p99", "85 ms", "bad");
          note.set("Half the users already see v42 while the other half see v41: the job's partial output is public. " +
            "If the job were abandoned now, the DB would stay half-updated. Live reads also slowed down because the DB " +
            "is busy absorbing batch writes.", "warn");
          await Promise.all([advance(st, [0.5, 0.5, 0.5, 0.5], 1500, k => { st.p99 = lerp(12, 85, Math.min(1, k * 1.5)); }),
            send(st, wave(2, 650))]);
        },
      }];
      if (fail) steps.push({
        title: "T3's machine dies at 60%, after writing 30,000 rows",
        run: async st => {
          await dieAt60(st);
          note.set("Those 30,000 rows are already in the DB. Nothing can take them back.", "bad");
        },
      }, {
        title: "The framework retries T3 from the start",
        run: async st => {
          // The retry's first 60% re-sends rows that are already there (red packets).
          await retryT3(st, [[2, 100, "bad"], [2, 400, "bad"], [2, 700, "bad"], [2, 1150], [0, 250], [1, 550], [3, 850]]);
          note.set("The retry writes its first 30,000 users again. With append-style writes they now have duplicate " +
            "recommendations; idempotent upserts would avoid duplicates but not the half-updated view readers already saw.", "bad");
        },
      });
      steps.push({
        title: "All tasks finish",
        run: async st => {
          await Promise.all([advance(st, [1, 1, 1, 1], 1300, k => { st.p99 = k < 0.7 ? 85 : lerp(85, 12, (k - 0.7) / 0.3); }),
            send(st, [[0, 100], [1, 250], [2, 400], [3, 550], [2, 750]])]);
          st.writes = 2000;
          st.jobDone = true;
          setAll(st, "✓ done", "ok");
          st.job = ["✓ done", "ok"];
          render(st);
          note.set(fail
            ? "Done, but for the whole run readers saw a mix of v41 and v42, live reads slowed to 85 ms p99, and 30,000 users now have duplicate rows."
            : "Done, but for the whole run readers saw a mix of v41 and v42 and live reads slowed to 85 ms p99. A retried (or speculative) task would also have written duplicates.",
          fail ? "bad" : "warn");
        },
      });
      if (bug) steps.push({
        title: "v42 had a bug: it wrote empty recommendation lists",
        run: async st => {
          await nap(st, 200);
          st.broken = true;
          render(st);
          stats.set("undo", "hours", "bad");
          note.set("Rolling back the code does not roll back the data: v41's rows were overwritten. Recovery means rerunning " +
            "v41 against the DB (another hour of heavy writes) or restoring a backup.", "bad");
          await nap(st, 300);
        },
      });
      return steps;
    }

    function swapSteps() {
      const steps = [START, {
        title: "Each task writes sorted files into its own temporary attempt directory; readers can't see them",
        run: async st => {
          st.writing = true;
          stats.set("p99", "12 ms", "ok");
          note.set("The serving side is untouched: it keeps answering from v41. No request touches a live database, " +
            "so tasks write at full speed and p99 stays at 12 ms.", "ok");
          await Promise.all([advance(st, [0.5, 0.5, 0.5, 0.5], 1500), send(st, wave(2, 650))]);
        },
      }];
      if (fail) steps.push({
        title: "T3's machine dies at 60%",
        run: async st => {
          await dieAt60(st);
          const f = st.files[2];
          f.label.style.fill = V("bad");
          f.strike.setAttribute("opacity", 1);
          note.set("Its partial attempt files are simply deleted; no reader ever saw them.", "ok");
          await nap(st, 500);
          await fade(st, f.row, 0, 400);
        },
      }, {
        title: "The framework retries T3; only one successful attempt per task is ever committed",
        run: async st => {
          const f = st.files[2];
          f.label.textContent = "T3/attempt_1";
          f.label.style.fill = V("ink");
          f.strike.setAttribute("opacity", 0);
          f.row.setAttribute("opacity", 1);
          await retryT3(st, [[2, 100], [2, 450], [2, 800], [2, 1150], [0, 250], [1, 550], [3, 850]]);
          note.set("No duplicates: the failed attempt left no trace. The driver lets only one attempt per task commit, " +
            "so a speculative copy of a task can't land its files twice either.", "ok");
        },
      });
      steps.push({
        title: "Tasks finish; the job commit moves their outputs into /recs/v42/ and writes a _SUCCESS marker",
        run: async st => {
          await Promise.all([advance(st, [1, 1, 1, 1], 900), send(st, [[0, 50], [1, 150], [2, 250], [3, 350]])]);
          setAll(st, "✓ done", "ok");
          st.job = ["committing", "warn"];
          st.jobDone = st.committed = true;
          await tween(st, 600, k => {
            st.temp.setAttribute("opacity", 1 - k);
            st.filesG.setAttribute("transform", `translate(0,${-22 * k})`);
            st.success.setAttribute("opacity", k);
          });
          st.files.forEach((f, i) => { f.label.textContent = `part-0000${i}`; });
          ctx.attr(st.v42Rect, { stroke: V("c5"), fill: V("c5-soft") });
          st.v42Rect.removeAttribute("stroke-dasharray");
          st.job = ["✓ _SUCCESS", "ok"];
          render(st);
          note.set("On HDFS the move is a cheap metadata rename (object stores have no atomic rename and need special " +
            "committers). Loaders and downstream jobs wait for <b>_SUCCESS</b>, so nobody reads a half-written v42.", "ok");
        },
      }, {
        title: "The serving cluster copies v42 to its local disks in the background while still serving v41",
        run: async st => {
          const c = st.chips[1];
          c.rect.setAttribute("stroke-dasharray", "4 3");
          chipStatus(st, 1, "loading", "warn");
          await fade(st, c.g, 1, 250);
          const fly = d => nap(st, d).then(() => guard(st, ctx.fly(st.packets, { from: st.v42At, to: st.chipAt, r: 5, ms: 600, fill: V("c5") })));
          await Promise.all([fly(0), fly(350), fly(700), tween(st, 1300, k => {
            ctx.attr(c.load, { width: k * c.w });
            c.status.textContent = `loading ${Math.round(k * 100)}%`;
          })]);
          c.rect.removeAttribute("stroke-dasharray");
          ctx.attr(c.load, { width: 0 });
          chipStatus(st, 1, "loaded", "ink");
          note.set("Like Voldemort's read-only stores or HBase bulk loads, servers copy immutable, sorted files instead of " +
            "absorbing 200,000 writes. Live reads are unaffected: p99 stays 12 ms.", "ok");
        },
      }, {
        title: "Atomic switch: readers move from v41 to v42 in one step",
        run: async st => {
          await tween(st, 500, k => st.point(k));
          sees(st, "v42");
          chipStatus(st, 1, "serving", "c6");
          chipStatus(st, 0, "kept", "muted");
          note.set("Every reader sees either all of v41 or all of v42, never a mix. v41 stays on disk, untouched.", "ok");
          await nap(st, 200);
        },
      });
      if (bug) steps.push({
        title: "v42 is buggy: flip the pointer back to v41",
        run: async st => {
          const c = st.chips[1];
          c.rect.style.stroke = V("bad");
          c.rect.style.fill = V("bad-soft");
          chipStatus(st, 1, "bad", "bad");
          await nap(st, 300);
          await tween(st, 500, k => st.point(1 - k));
          sees(st, "v41");
          chipStatus(st, 0, "serving", "c6");
          stats.set("undo", "seconds", "ok");
          note.set("Undo took seconds because v41's files were never modified. Fix the code and rerun to build v43.", "ok");
        },
      });
      return steps;
    }

    // ---------- build ----------
    const legendFor = direct => ui.legend([
      { color: V("c2"), label: "v41 (old)", shape: "square" },
      { color: V("c5"), label: "v42 (new)", shape: "square" },
      !direct && { color: V("warn"), label: "temporary, uncommitted", shape: "square" },
      { color: V("bad"), label: direct ? "duplicated / broken" : "failed / broken", shape: "square" },
      { color: V("c6"), label: "web app", shape: "dot" },
    ].filter(Boolean));

    function buildStage() {
      const L = LAYOUTS[compact ? "phone" : "desk"], direct = mode === "direct", myGen = gen;
      const svg = ctx.svg({ w: L.W, h: L.H[mode], label: direct
        ? "Batch tasks writing rows directly into the production database that the web app reads"
        : "Batch tasks writing files to a distributed filesystem, then a serving cluster swapping versions" });
      const hatch = `bo-hatch-${ctx.uid}-${myGen}`;
      svg.defs.appendChild(s("pattern", { id: hatch, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
        R(0, 0, 6, 6, { fill: V("bad-soft") }), s("line", { x1: 1, y1: 0, x2: 1, y2: 6, stroke: V("bad"), "stroke-width": 2.5 })));
      const scene = svg.appendChild(s("g")), packets = svg.appendChild(s("g"));
      player = ctx.stepper({
        delay: 1200,
        intro: "Yesterday's recommendations (v41) are live. Tonight's job builds v42. Pick how to publish it, then press <b>Play</b>.",
        steps: direct ? directSteps() : swapSteps(),
        // Fully redraws the scene: Back = init() + instant replay.
        init() {
          scene.replaceChildren();
          packets.replaceChildren();
          const st = {
            gen: myGen, L, svg, packets, hatch, direct, tasks: newTasks(), status: TASKS.map(() => ["waiting", "muted"]),
            job: ["not started", "muted"], p99: 12, writes: 2000, visible: 0,
            writing: false, jobDone: false, broken: false, committed: false,
          };
          drawJob(st, scene);
          const P = direct ? L.webD : L.webS;
          const web = scene.appendChild(ctx.box({ x: P.x, y: P.y, w: P.w, h: 40, label: "Web app", sub: "p99", size: 14, fill: V("c6-soft"), stroke: V("c6") }));
          st.p99El = ctx.attr(web.sub, { "font-weight": 600 });
          if (direct) drawDB(st, scene);
          else {
            drawStore(st, scene);
            drawServe(st, scene);
          }
          scene.appendChild(T(L.W - 8, L.H[mode] - 8, "illustrative numbers", { anchor: "end", fill: V("muted") }));
          stats.set("p99", "–", "");
          stats.set("undo", "–", "");
          note.set(direct
            ? "Each task opens a client to the <b>production DB</b>, the same database the website reads from, and writes rows as it computes them."
            : "Each task writes <b>files</b> to the distributed filesystem. A separate read-only <b>serving cluster</b> answers the website from local copies of finished versions.",
          "info");
          render(st);
          return st;
        },
      });
      stage.replaceChildren(svg, legendFor(direct), player.el);
    }

    function restart(keepStep) {
      const idx = keepStep && player ? player.index : -1;
      gen++;
      if (player) player.pause();
      ctx.instant = true;   // finish the old scenario's tweens now; guard() parks its step
      buildStage();
      ctx.instant = false;
      if (idx >= 0) player.goto(idx);    // instant replay finishes before the next paint
    }

    function buildAll() {
      compact = ctx.compact;
      root.replaceChildren(controls(), stage, stats, note);
    }

    buildAll();
    buildStage();
    ctx.onResize(() => { if (ctx.compact !== compact) { buildAll(); restart(true); } });
  },
});
