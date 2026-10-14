// Stragglers and hot keys: a reduce stage is done only when its slowest task is done.
// A slow machine is rescued by speculative execution (a backup copy elsewhere); a hot key is
// not, because the backup gets the same oversized partition. Only splitting the key helps.
// Deterministic, illustrative model: 8 reducers, 8 M records, 1 M records/min per healthy machine.
(function () {
  const R = 8, TOTAL = 8, HOT = 2, SLOW = 5, SAMPLE = 0.1, MERGE = 0.05;
  const median = xs => { const a = xs.slice().sort((p, q) => p - q); return (a[3] + a[4]) / 2; };

  // p = {share (0..60 %), slow, spec, split, k}. Times in minutes, records in millions.
  function model(p) {
    const sh = p.share / 100, base = (1 - sh) * TOTAL / R, start = p.split ? SAMPLE : 0;
    const hotRows = p.split ? Array.from({ length: p.k }, (_, j) => (HOT + j) % R) : [HOT];
    const tasks = Array.from({ length: R }, (_, i) => {
      const hot = sh > 0 && hotRows.includes(i) ? (sh * TOTAL) / hotRows.length : 0;
      const rate = p.slow && i === SLOW ? 1 / 3 : 1, rec = base + hot;
      return { i, start, rate, base, hot, rec, f: start + rec / rate, end: start + rec / rate, backup: null };
    });
    // Simplified speculation: at the median finish time m, back up (latest first) at most two
    // tasks predicted to finish after 1.5 m. A backup runs on a healthy machine from scratch.
    const m = median(tasks.map(t => t.f));
    let wasted = 0;
    if (p.spec) {
      tasks.filter(t => t.f > 1.5 * m + 1e-9).sort((a, b) => b.f - a.f || a.i - b.i).slice(0, 2).forEach(t => {
        const finish = m + t.rec, won = finish < t.f - 1e-9;
        t.backup = { launch: m, finish, won };
        if (won) t.end = finish;
        wasted += won ? (finish - t.start) * t.rate : t.f - m;   // the losing copy's work
      });
    }
    const ends = tasks.map(t => t.end), maxF = Math.max(...ends), med = median(ends);
    const stage = maxF + (p.split ? MERGE : 0);
    return {
      p, tasks, m, med, maxF, stage, wasted, start,
      backups: tasks.filter(t => t.backup),
      slowest: tasks.reduce((a, t) => (t.end > a.end + 1e-9 ? t : a)),
      ratio: (maxF - start) / (med - start),
      idle: ends.reduce((a, e) => a + maxF - e, 0),
      reach: Math.max(stage, ...tasks.map(t => Math.max(t.f, t.backup ? t.backup.finish : 0))),
    };
  }

  Viz.register("ch10/stragglers-skew", {
    title: "Stragglers and hot keys",
    model,
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      const st = { share: 35, slow: false, spec: false, split: false, k: 4 };
      let view = null, compact = ctx.compact, runId = 0, patternN = 0;
      const f2 = v => v.toFixed(2);
      const toneOf = r => (r > 2.5 ? "bad" : r > 1.3 ? "warn" : "ok");
      const rowName = i => "R" + (i + 1);

      function layout() {
        const W = compact ? 360 : 640;
        return {
          W, H: 346, x0: compact ? 40 : 100, x1: compact ? 350 : 620, fs: compact ? 11 : 12,
          rowY: i => 56 + 32 * i, barH: 20, bkH: 7, passY: 38, passH: 12,
          topY: 28, medY: 324, tickY: 338, gridTop: 36, gridBot: 314,
        };
      }

      function build() {
        runId++;
        root.innerHTML = "";
        compact = ctx.compact;
        const L = layout();
        const shareS = ui.slider({
          label: "Hot key share", min: 0, max: 60, step: 5, value: st.share,
          format: v => v + "%", onInput: v => set({ share: v }),
        });
        const kS = ui.slider({
          label: "Split across k reducers", min: 2, max: 8, step: 1, value: st.k,
          format: v => "×" + v, onInput: v => set({ k: v }),
        });
        if (compact) [shareS, kS].forEach(sl => { sl.input.style.flex = "1 1 80px"; });
        const toggle = (label, key) => ui.toggle({ label, value: st[key], onChange: v => set({ [key]: v }) });
        const runBtn = ui.button("▶ Run stage", run, { kind: "primary" });

        const svg = ctx.svg({ w: L.W, h: L.H, label: "Timeline of 8 reduce tasks; the stage ends when the slowest one ends" });
        const hatch = `ss-hatch-${ctx.uid}-${++patternN}`;
        svg.defs.append(s("pattern", { id: hatch, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
          s("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "var(--viz-muted)", "stroke-width": 1.4, "stroke-opacity": 0.55 })));
        const layer = s("g");
        svg.appendChild(layer);

        const foot = h("div", { class: "muted", style: "font-size:12px;line-height:1.45;margin:2px 0 6px" });
        const stats = ui.stats([
          { key: "stage", label: "Stage time" },
          { key: "med", label: "Median task" },
          { key: "ratio", label: "Slowest ÷ median" },
          { key: "idle", label: "Idle reducer-min" },
          { key: "waste", label: "Backup waste" },
        ]);
        const note = ui.note("");
        root.append(
          ui.bar(shareS, toggle("Slow machine (R6 at 1/3 speed)", "slow"), toggle("Speculative execution", "spec"),
            toggle("Split hot key", "split"), kS, runBtn),
          svg, foot,
          ui.legend([
            { color: "var(--viz-c2)", label: "normal keys", shape: "square" },
            { color: "var(--viz-bad)", label: "hot-key records", shape: "square" },
            { color: "var(--viz-warn)", label: "backup copy", shape: "square" },
            { color: "var(--viz-grid)", label: "idle, waiting for the slowest task", shape: "square" },
          ]),
          stats, note,
        );
        view = { L, layer, hatch, kS, foot, stats, note, M: null };
        update();
      }

      function set(patch) {
        Object.assign(st, patch);
        runId++;   // cancels a run in progress
        update();
      }

      function update() {
        const M = model(st), { L } = view;
        // Smallest round axis that fits everything, leaving room for the backup labels.
        const room = compact ? 44 : 92;
        const xAt = (t, T) => L.x0 + (t / T) * (L.x1 - L.x0);
        M.tMax = [1.5, 2, 3, 4, 5, 6, 7, 8].find(T => T >= 1.05 * M.reach &&
          M.backups.every(t => xAt(t.backup.finish, T) + room <= L.W - 4)) || 8;
        view.M = M;
        draw(Infinity);
        const tone = toneOf(M.ratio);
        view.stats.set("stage", f2(M.stage) + " min", tone)
          .set("med", f2(M.med) + " min", "")
          .set("ratio", M.ratio.toFixed(1) + "×", tone)
          .set("idle", M.idle.toFixed(1), M.idle < 0.05 ? "ok" : "")
          .set("waste", M.wasted > 0 ? f2(M.wasted) + ' M<span style="font-size:12px;font-weight:600"> records</span>' : "–",
            M.wasted > 0 ? "warn" : "");
        view.note.set(...noteFor(M));
        view.kS.style.opacity = st.split ? "" : "0.45";
        view.foot.textContent = "Illustrative numbers." + (st.spec
          ? " Simplified speculation rule: at the median finish time, back up at most 2 tasks predicted to finish after 1.5 × median. " +
            "Hadoop and Spark use progress-rate heuristics; speculation is on by default in Hadoop MapReduce, off in Spark."
          : "");
      }

      async function run() {
        const my = ++runId, M = view.M;
        draw(0);
        await ctx.tween({ ms: 2500, ease: "linear", onUpdate: k => { if (my === runId) draw(k * M.stage); } });
        if (my === runId && ctx.alive) draw(Infinity);
      }

      // ---------- drawing ----------
      // Text whose box is kept inside [lo, hi]; returns the element and its width.
      function label(x, y, str, o, lo, hi) {
        const t = ctx.text(x, y, str, { size: view.L.fs, ...o });
        view.layer.appendChild(t);
        let w = 0;
        try { w = t.getComputedTextLength(); } catch (e) { /* not rendered yet */ }
        w = w || str.length * view.L.fs * 0.58;
        if (lo !== undefined) {
          const a = o.anchor || "middle", left = a === "start" ? x : a === "end" ? x - w : x - w / 2;
          const shift = Math.max(lo - left, Math.min(0, hi - (left + w)));
          if (shift) t.setAttribute("x", x + shift);
        }
        return { t, w };
      }

      function rect(x0, x1, y, hh, o) {
        if (x1 - x0 < 0.5) return null;
        const r = s("rect", { x: x0, y, width: x1 - x0, height: hh, rx: o.rx === undefined ? 2.5 : o.rx, ...o });
        view.layer.appendChild(r);
        return r;
      }

      function draw(now) {
        const { L, layer, M } = view, live = now < Infinity, p = M.p;
        layer.innerHTML = "";
        const X = t => L.x0 + (t / M.tMax) * (L.x1 - L.x0);
        const muted = { fill: "var(--viz-muted)" };
        const step = M.tMax <= 2 ? 0.5 : 1;
        for (let t = 0; t <= M.tMax + 1e-9; t += step) {
          layer.appendChild(s("line", { x1: X(t), x2: X(t), y1: L.gridTop, y2: L.gridBot, stroke: "var(--viz-grid)" }));
          label(X(t), L.tickY, t === 0 ? "0" : String(t) + " min", muted, 2, L.W - 2);
        }
        label(compact ? 4 : 12, 12, compact ? "8 tasks · 8 M records · 1 M/min each"
          : "8 reduce tasks · 8 M records · 1 M records/min per healthy machine", { ...muted, anchor: "start" });

        // Underneath the bars: idle time, then the median and stage-end lines.
        M.tasks.forEach(t => {
          if (now > t.end) rect(X(t.end), X(Math.min(M.maxF, now)), L.rowY(t.i), L.barH, { fill: "var(--viz-grid)" });
        });
        if (now >= M.med) {
          layer.appendChild(s("line", { x1: X(M.med), x2: X(M.med), y1: L.gridTop, y2: L.gridBot + 2,
            stroke: "var(--viz-muted)", "stroke-width": 1.4, "stroke-dasharray": "4 4" }));
          label(X(M.med), L.medY, "median " + f2(M.med), muted, 2, L.W - 2);
        }
        if (now >= M.stage) {
          const c = M.ratio > 2.5 ? "var(--viz-bad)" : "var(--viz-ok)";
          layer.appendChild(s("line", { x1: X(M.stage), x2: X(M.stage), y1: L.topY + 7, y2: L.gridBot, stroke: c, "stroke-width": 2.2 }));
          label(X(M.stage), L.topY, `stage done ${f2(M.stage)} min`, { fill: c, weight: 700 }, 2, L.W - 2);
        }

        if (p.split) drawPass(0, Math.min(SAMPLE, now), SAMPLE, "sample", live);
        if (p.split && now > M.maxF) drawPass(M.maxF, Math.min(M.stage, now), M.stage, "merge", live);
        M.tasks.forEach(t => drawTask(t, now, X));

        if (live && now < M.stage) {
          layer.appendChild(s("line", { x1: X(now), x2: X(now), y1: L.topY + 7, y2: L.gridBot, stroke: "var(--viz-ink)", "stroke-width": 1.5, opacity: 0.7 }));
          label(X(now), L.topY, `t = ${f2(now)} min`, { weight: 700 }, 2, L.W - 2);
        }
      }

      // Split only: the sampling pass before the reduce tasks and the merge pass after them,
      // drawn on one lane above R1 (sample labelled on its right, merge on its left).
      function drawPass(t0, tNow, t1, name, live) {
        const { L } = view, X = t => L.x0 + (t / view.M.tMax) * (L.x1 - L.x0), y = L.passY;
        if (live) rect(X(t0), X(t1), y, L.passH, { fill: "none", stroke: "var(--viz-line)", "stroke-dasharray": "3 3" });
        rect(X(t0), X(tNow), y, L.passH, { fill: "var(--viz-c3-soft)", stroke: "var(--viz-c3)", "stroke-width": 1.3 });
        const first = name === "sample";
        label(first ? X(t1) + 5 : X(t0) - 5, y + L.passH / 2, name,
          { fill: "var(--viz-c3)", weight: 600, anchor: first ? "start" : "end", halo: true });
      }

      // "R3 · hot key" / "R6 · slow"; a red dot marks every reducer that gets hot-key records
      // once the key is split (and, on phones, an amber dot marks the slow machine).
      function drawRowLabel(t, y) {
        const p = view.M.p, slow = t.rate < 1, hotUnsplit = !p.split && t.hot > 0;
        const fill = slow ? "var(--viz-warn)" : hotUnsplit ? "var(--viz-bad)" : "var(--viz-ink)";
        const dot = (x, c) => view.layer.appendChild(s("circle", { cx: x, cy: y, r: 3.5, fill: c }));
        const text = rowName(t.i) + (compact ? "" : slow ? " · slow" : hotUnsplit ? " · hot key" : "");
        const { w } = label(compact ? 4 : 12, y, text, { anchor: "start", weight: 700, fill });
        if (compact) {
          if (t.hot > 0) dot(25, "var(--viz-bad)");
          if (slow) dot(33, "var(--viz-warn)");
        } else if (p.split && t.hot > 0) dot(12 + w + 8, "var(--viz-bad)");
      }

      function drawTask(t, now, X) {
        const { L, hatch } = view, y = L.rowY(t.i), cy = y + L.barH / 2, live = now < Infinity;
        drawRowLabel(t, cy);
        if (live) rect(X(t.start), X(t.f), y, L.barH, { fill: "none", stroke: "var(--viz-line)", "stroke-dasharray": "3 3" });

        // The task's own work: normal-key records first, then its share of the hot key.
        const solidEnd = Math.min(t.end, now), split = t.start + t.base / t.rate;
        rect(X(t.start), X(solidEnd), y, L.barH, { fill: "var(--viz-bg)" });
        rect(X(t.start), X(Math.min(split, solidEnd)), y, L.barH, { fill: "var(--viz-c2-soft)", stroke: "var(--viz-c2)", "stroke-width": 1.3 });
        if (t.hot > 0 && solidEnd > split) {
          rect(X(split), X(solidEnd), y, L.barH, { fill: "var(--viz-bad-soft)", stroke: "var(--viz-bad)", "stroke-width": 1.3 });
        }
        if (t.rate < 1) rect(X(t.start), X(solidEnd), y, L.barH, { fill: "none", stroke: "var(--viz-warn)", "stroke-width": 1.8, "stroke-dasharray": "5 3" });

        const b = t.backup, killed = b && b.won && now >= t.end;   // killed once its backup finishes
        if (killed) {
          rect(X(t.end), X(t.f), y, L.barH, { fill: `url(#${hatch})`, stroke: "var(--viz-muted)", "stroke-dasharray": "4 3" });
          if (X(t.f) - X(t.end) > 44) label((X(t.end) + X(t.f)) / 2, cy, "killed", { fill: "var(--viz-muted)", weight: 600, halo: true });
        }
        if (now >= t.end) drawBarLabel(t, X, cy, killed);
        if (b && now > b.launch) drawBackup(t, now, X, y + L.barH + 2);
      }

      // Records and duration, right of the bar. Inside the bar (or just the duration) when the
      // full label would run off the chart or across the stage-end line.
      function drawBarLabel(t, X, cy, killed) {
        const { L } = view, dur = f2(t.f - t.start), short = dur + (compact ? "m" : " min");
        const full = compact ? short : `${f2(t.rec)} M · ${dur} min`;
        const est = str => str.length * L.fs * 0.58, xs = X(view.M.stage), xr = X(t.f) + 5;
        const ok = str => xr + est(str) <= L.W - 4 && !(xr < xs && xr + est(str) + 2 > xs);
        const fitsIn = !killed && X(t.end) - X(t.start) > Math.max(compact ? 40 : 0, est(full) + 12);
        if (fitsIn && (compact || !ok(full))) label(X(t.end) - 5, cy, full, { anchor: "end", weight: 600, halo: t.hot > 0 && t.base > 0 });
        else label(xr, cy, ok(full) || !ok(short) ? full : short, { anchor: "start", fill: "var(--viz-muted)", halo: true });
      }

      // Backup copy: a thin bar under its task, solid while it runs, hatched where it was cut off.
      function drawBackup(t, now, X, by) {
        const { L } = view, b = t.backup, stop = b.won ? b.finish : t.f;
        rect(X(b.launch), X(Math.min(stop, now)), by, L.bkH, { fill: "var(--viz-warn)", rx: 2 });
        if (now < stop) return;
        if (!b.won) rect(X(t.f), X(b.finish), by, L.bkH, { fill: `url(#${view.hatch})`, stroke: "var(--viz-warn)", "stroke-dasharray": "3 2", rx: 2 });
        const str = (compact ? "" : "backup ") + (b.won ? "✓ won" : "✕ lost");
        label(X(b.finish) + 5, by + L.bkH / 2 - 0.5, str,
          { anchor: "start", weight: 700, fill: b.won ? "var(--viz-ok)" : "var(--viz-muted)", halo: true });
      }

      // ---------- explanation ----------
      function noteFor(M) {
        const p = M.p, alt = patch => model({ ...p, ...patch });
        const lost = M.backups.filter(t => !t.backup.won), won = M.backups.filter(t => t.backup.won);
        if (p.split && p.share === 0) {
          return [`There is no hot key, so the sampling pass and the merge pass are pure overhead (<b>${f2(M.stage)} min</b> instead of ` +
            `${f2(alt({ split: false }).stage)}). Splitting has a cost: use it for keys you know, or have measured, to be hot.`, "warn"];
        }
        if (p.split && p.slow && !p.spec && M.slowest.i === SLOW) {
          return [`Splitting fixed the hot key, but R6's slow machine is now the straggler (<b>${f2(M.stage)} min</b>). ` +
            "Skew and slow machines are different diseases: turn on <b>Speculative execution</b> too.", "warn"];
        }
        if (lost.length) {
          const t = lost[0], b = t.backup;
          return [`Speculative execution launched a backup of ${rowName(t.i)} at ${f2(b.launch)} min, but the backup must process the same ` +
            `<b>${f2(t.rec)} M records</b>, so it would finish at <b>${f2(b.finish)} min</b>, later than the original. ` +
            "Backups fix slow machines, not skewed data." +
            (won.length ? ` (${rowName(won[0].i)}'s backup did win: its problem was the machine, not the data.)` : "") +
            (p.split ? " Raise k to spread the hot key thinner." : " Turn on <b>Split hot key</b> instead and pick k."), "bad"];
        }
        if (won.length) {
          const t = won[0], before = alt({ spec: false }).stage, pct = Math.round((100 * (before - M.stage)) / before);
          return [`${rowName(t.i)} is on a slow machine. Its backup on a healthy machine finished at <b>${f2(t.backup.finish)} min</b>, ` +
            `beating the original (${f2(t.f)} min): the stage is <b>${pct}% shorter</b>, at the cost of ${f2(M.wasted)} M records of duplicate work.` +
            (p.split && p.share > 0 ? " Splitting took care of the hot key; speculation took care of the slow machine." : ""), "ok"];
        }
        if (p.split) {
          const per = (p.share / 100) * TOTAL / p.k;
          return [`The hot key is spread over <b>${p.k} reducers</b> (${f2(per)} M records each), so the stage takes <b>${f2(M.stage)} min</b> ` +
            `instead of ${f2(alt({ split: false }).stage)}, including a 0.1 min sampling pass that finds the hot key and a 0.05 min merge ` +
            `of the ${p.k} partial results (two-stage aggregation). For a join there is no merge: the other side's record for that key ` +
            `is copied to all ${p.k} reducers instead (Pig's skewed join).` +
            (M.ratio > 1.3 ? " Raise k to even out the load." : ""), M.ratio > 2 ? "warn" : "ok"];
        }
        const noBackup = p.spec ? " Speculative execution launched no backup: no task was predicted to finish after 1.5 × the median." : "";
        if (p.share > 0 && M.slowest.i === HOT) {
          const t = M.tasks[HOT], done = M.tasks.filter(x => x.end <= M.med + 1e-9).length;
          return [`R3 owns the hot key (say, a celebrity's user_id, or every event whose user_id is NULL), so it must process ` +
            `<b>${f2(t.rec)} M records</b> while the others process ${f2(t.base)} M. The stage takes <b>${f2(M.stage)} min</b> ` +
            `although ${done} of 8 reducers sit idle after ${f2(M.med)} min.` +
            (p.slow ? ` R6's slow machine (${f2(M.tasks[SLOW].f)} min) is a second, smaller straggler.` : "") + noBackup +
            (p.spec ? " Try <b>Split hot key</b> and pick k." : " Try <b>Speculative execution</b>, then <b>Split hot key</b> and pick k."),
            M.ratio > 2 ? "bad" : "warn"];
        }
        if (p.slow) {
          return [`One slow machine (3× slower) makes the whole stage take <b>${f2(M.stage)} min</b> instead of ` +
            `${f2(alt({ slow: false }).stage)}. Try <b>Speculative execution</b>.`, "warn"];
        }
        return ["With no hot key every reducer gets 1 M records and finishes together (<b>1.00 min</b>). Drag the hot key share up.", "info"];
      }

      build();
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
