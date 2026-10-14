// Why map and reduce must be pure. A mapReduce query (monthly shark totals) runs on three
// shards; shard B's first map attempt can crash and be re-run. With a pure mapper the retry is
// harmless; with a (hypothetical) side effect the retry double-counts while reduce stays right.
// A model of what the purity rule permits, not a trace of MongoDB internals.
Viz.register("ch2/mapreduce-purity", {
  title: "Why map and reduce must be pure",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const V = n => `var(--viz-${n})`;

    // ---------- data and the pure pipeline ----------
    // Each row: [month, day, year, family, numAnimals]
    const SHARDS = [
      [[12, 25, 1995, "Sharks", 3], [12, 12, 1995, "Sharks", 4], [1, 3, 1996, "Sharks", 2], [12, 30, 1995, "Whales", 7]],
      [[12, 8, 1995, "Sharks", 1], [1, 21, 1996, "Sharks", 5], [1, 9, 1996, "Rays", 4]],
      [[1, 15, 1996, "Sharks", 2], [2, 2, 1996, "Sharks", 6], [12, 19, 1995, "Sharks", 2]],
    ];
    const NAMES = ["A", "B", "C"], KEYS = ["1995-12", "1996-1", "1996-2"];
    const B = 1; // the shard whose first map attempt crashes
    const isShark = r => r[3] === "Sharks";
    const sum = xs => xs.reduce((a, b) => a + b, 0);
    // The query filter runs first; map then calls emit(year + "-" + month, numAnimals) per document.
    const EMITS = SHARDS.map(rows => rows.flatMap((r, row) => (isShark(r) ? [{ row, key: `${r[2]}-${r[0]}`, value: r[4] }] : [])));
    const TRUE_TOTAL = sum(EMITS.flat().map(e => e.value));
    const B_VALS = EMITS[B].map(e => e.value), B_SUM = sum(B_VALS);
    const SQL_RESULT = KEYS.map(k => sum(EMITS.flat().filter(e => e.key === k).map(e => e.value))).join(" · ");
    const pad = n => String(n).padStart(2, "0");
    const fmtDate = r => `${pad(r[0])}/${pad(r[1])}/${String(r[2]).slice(2)}`;
    const pairText = e => `${e.key} → ${e.value}`;

    // ---------- layouts ----------
    const WIDE = {
      compact: false, W: 640, H: 380, fs: 12, xs: [8, 220, 432], cw: 200,
      header: ["observations collection, 3 shards", "each row: date · family · numAnimals"],
      shardY: 22, shardH: 104, titleY: 38, rowY: j => 58 + 18 * j, cols: [10, 86, 188], fam: f => f,
      emitY: 132, emitH: 60, chipW: 92, chipH: 22, slot: j => [4 + (j % 2) * 100, 137 + 28 * Math.floor(j / 2)],
      status: i => ({ x: WIDE.xs[i] + WIDE.cw - 10, y: WIDE.titleY, anchor: "end" }),
      divs: [206, 276], bucketY: 218, bucketH: 44, resultY: 290, resultH: 42, stripY: 344, stripH: 30,
      stripLabel: ["Outside the database:", "Side effect outside the database:"], counterName: "metrics.sharksSeen",
    };
    const PHONE = {
      compact: true, W: 360, H: 414, fs: 11, xs: [6, 124, 242], cw: 112,
      header: ["observations: date · family · numAnimals"],
      shardY: 22, shardH: 104, titleY: 38, rowY: j => 58 + 18 * j, cols: [6, 72, 104], fam: f => f[0],
      legendY: 138, legend: "S = Sharks, W = Whales, R = Rays",
      emitY: 148, emitH: 78, chipW: 106, chipH: 20, slot: j => [3, 152 + 24 * j],
      // Only shard B needs a status line on phones, and its third chip slot is always free.
      status: i => (i === B ? { x: PHONE.xs[i] + PHONE.cw / 2, y: 210, anchor: "middle" } : null),
      divs: [238, 312], bucketY: 250, bucketH: 50, resultY: 324, resultH: 42, stripY: 378, stripH: 30,
      stripLabel: ["Outside the DB:", "Outside the DB:"], counterName: "sharksSeen",
    };

    // ---------- controls, stats, code panel ----------
    let cfg = { impure: false, crash: true };
    let codeView = "mr", codeTag = null;
    const mapperSeg = ui.segmented({
      label: "Mapper", value: "pure",
      options: [{ value: "pure", label: "Pure: only emit" }, { value: "impure", label: "Impure: emit + bump a global counter" }],
      onChange: v => setCfg({ impure: v === "impure" }),
    });
    const crashToggle = ui.toggle({ label: "Shard B's mapper crashes once", value: true, onChange: v => setCfg({ crash: v }) });
    const codeSeg = ui.segmented({
      label: "Show code", value: codeView,
      options: [{ value: "sql", label: "SQL" }, { value: "mr", label: "mapReduce" }, { value: "agg", label: "Aggregation pipeline" }],
      onChange: v => { codeView = v; renderCode(); },
    });
    const stats = ui.stats([
      { key: "attempts", label: "Map attempts", value: 0 },
      { key: "output", label: "Reduce output", value: "–" },
      { key: "counter", label: "Side-effect counter", value: "n/a" },
      { key: "sql", label: "SQL result", value: SQL_RESULT, tone: "info" },
    ]);

    // Code lines: [text, tags]; a line is highlighted while a step with one of its tags runs.
    const SIDE_LINE = ['    metrics.add("sharksSeen", this.numAnimals); // side effect: forbidden', ["map"], "bad"];
    const CODE = {
      sql: () => [
        ["SELECT date_trunc('month', observed_at) AS month,", ["map", "group"]],
        ["       sum(num_animals) AS total_animals", ["reduce"]],
        ["FROM observations", []],
        ["WHERE family = 'Sharks'", ["query"]],
        ["GROUP BY month;", ["group"]],
      ],
      mr: impure => [
        ["db.observations.mapReduce(", []],
        ["  function map() {  // once per document", ["map"]],
        ["    const d = this.observedAt;", ["map"]],
        ['    emit(d.getFullYear() + "-" + (d.getMonth() + 1),', ["map", "group"]],
        ["         this.numAnimals);", ["map", "group"]],
        impure ? SIDE_LINE : null,
        ["  },", ["map"]],
        ["  function reduce(month, counts) {", ["reduce"]],
        ["    return Array.sum(counts); // may run again on partial sums", ["reduce"]],
        ["  },", ["reduce"]],
        ['  { query: { family: "Sharks" }, out: "monthlySharkReport" }', ["query"]],
        [");", []],
      ].filter(Boolean),
      agg: () => [
        ["db.observations.aggregate([", []],
        ['  { $match: { family: "Sharks" } },', ["query"]],
        ["  { $group: {", ["group"]],
        ['      _id: { year: { $year: "$observedAt" },', ["map", "group"]],
        ['             month: { $month: "$observedAt" } },', ["map", "group"]],
        ['      totalAnimals: { $sum: "$numAnimals" } } }', ["reduce"]],
        ["]);", []],
      ],
    };
    const CODE_NOTES = {
      sql: "One declarative query: the database decides how to filter, group and parallelize it.",
      mr: "map reads only <code>this</code>; reduce reads only its arguments. With no I/O, the database may run them " +
        "on any shard, in any order, and run them again after a failure.",
      mrImpure: "<b>Hypothetical:</b> MongoDB doesn't even give map and reduce access to the database. " +
        "This is the rule the demo breaks on purpose.",
      agg: "MongoDB 2.2's aggregation pipeline: declarative JSON stages the database can optimize. " +
        "MongoDB 5.0 deprecated map-reduce in its favor.",
    };
    const pre = h("pre", { style: "margin:0;padding:10px 0;font-size:12px;line-height:1.55;white-space:pre-wrap;" +
      "overflow-wrap:anywhere;background:var(--viz-bg);border:1px solid var(--border);border-radius:8px" });
    const codeNote = h("div", { class: "muted", style: "font-size:12.5px;line-height:1.5;margin-top:8px" });

    function renderCode() {
      pre.replaceChildren(...CODE[codeView](cfg.impure).map(([text, tags, tone]) => {
        // Hanging indent: wrapped continuation lines start two columns right of the line's indent.
        const indent = text.length - text.trimStart().length, body = text.trimStart();
        const at = body.indexOf("//");
        const on = codeTag && tags.includes(codeTag);
        const bg = tone ? V(tone + "-soft") : on ? V("info-soft") : "transparent";
        const bar = on ? V(tone || "info") : tone ? V(tone) : "transparent";
        return h("span", { style: `display:block;padding:0 12px 0 calc(${indent + 2}ch + 12px);text-indent:-2ch;` +
          `background:${bg};box-shadow:inset 3px 0 0 ${bar}` },
          at < 0 ? body : body.slice(0, at),
          at < 0 ? null : h("span", { style: `color:${tone ? V(tone) : "var(--text-muted)"}` }, body.slice(at)));
      }));
      codeNote.innerHTML = codeView === "mr" && cfg.impure ? CODE_NOTES.mrImpure : CODE_NOTES[codeView];
    }
    const setCode = tag => { codeTag = tag; renderCode(); };

    // ---------- scene ----------
    const svgHost = h("div");
    let view = null, compact = ctx.compact;
    function buildSvg() {
      compact = ctx.compact;
      const L = compact ? PHONE : WIDE;
      const svg = ctx.svg({ w: L.W, h: L.H, label: "Three shards run map, pairs are grouped by key, reduce sums each group" });
      const scene = s("g"), chipLayer = s("g"), packets = s("g");
      svg.append(scene, chipLayer, packets);
      svgHost.replaceChildren(svg);
      view = { L, scene, chipLayer, packets };
    }

    const muted = (L, extra) => ({ size: L.fs, fill: V("muted"), ...extra });
    function drawFrame(st) {
      const { L, scene } = st;
      scene.appendChild(ctx.text(L.xs[0], 10, L.header[0], muted(L, { anchor: "start" })));
      if (L.header[1]) scene.appendChild(ctx.text(L.W - L.xs[0], 10, L.header[1], muted(L, { anchor: "end" })));
      if (L.legend) scene.appendChild(ctx.text(L.W / 2, L.legendY, L.legend, muted(L)));
      ["group by key", "reduce(key, values)"].forEach((label, i) => {
        const y = L.divs[i];
        scene.append(
          s("line", { x1: L.xs[0], x2: L.W - L.xs[0], y1: y, y2: y, stroke: V("line"), "stroke-dasharray": "3 4" }),
          ctx.text(L.W / 2, y, `↓ ${label} ↓`, { size: L.fs, weight: 600, fill: V("muted"), halo: true }));
      });
    }

    function drawShard(st, i) {
      const { L, scene } = st, x = L.xs[i], g = s("g");
      const box = ctx.box({ x, y: L.shardY, w: L.cw, h: L.shardH, fill: V("c2-soft"), stroke: V("c2") });
      g.append(box, ctx.text(x + L.cols[0], L.titleY, "Shard " + NAMES[i], { size: 12, weight: 700, anchor: "start" }));
      const rows = SHARDS[i].map((r, j) => {
        const y = L.rowY(j), fill = isShark(r) ? V("ink") : V("muted"), rg = s("g");
        const t = (dx, str, anchor) => ctx.text(x + dx, y, str, { size: L.fs, mono: true, anchor, fill });
        rg.append(t(L.cols[0], fmtDate(r), "start"), t(L.cols[1], L.fam(r[3]), "start"), t(L.cols[2], String(r[4]), "end"));
        // Highlight while map() runs on this document.
        const hl = s("rect", { x: x + 3, y: y - 9, width: L.cw - 6, height: 18, rx: 4, fill: V("warn-soft"), stroke: V("warn"), opacity: 0 });
        const strike = s("line", { x1: x + 4, x2: x + 4, y1: y, y2: y, stroke: V("muted"), "stroke-width": 1.5 });
        g.append(hl, rg, strike);
        return { g: rg, hl, strike, x0: x + 4, x1: x + L.cw - 4, shark: isShark(r) };
      });
      g.appendChild(s("rect", { x, y: L.emitY, width: L.cw, height: L.emitH, rx: 8, fill: "none", stroke: V("line"), "stroke-dasharray": "4 4", opacity: 0.7 }));
      const ph = ctx.text(x + L.cw / 2, L.emitY + L.emitH / 2, "emitted pairs", muted(L, { size: 12 }));
      const pos = L.status(i);
      const status = pos ? ctx.text(pos.x, pos.y, "", { size: 12, weight: 700, anchor: pos.anchor, halo: true }) : null;
      g.append(ph, status);
      scene.appendChild(g);
      return { box, rows, ph, status };
    }

    function setShard(st, i, tone, label) {
      const sh = st.shards[i];
      ctx.attr(sh.box.rect, { stroke: V(tone), "stroke-width": tone === "c2" ? 1.5 : 2.2 });
      if (sh.status) { sh.status.textContent = label; ctx.attr(sh.status, { fill: V(tone) }); }
    }

    function drawKeyBox(st, k, y, hgt) {
      const { L, scene } = st, x = L.xs[k];
      const box = ctx.box({ x, y, w: L.cw, h: hgt, fill: V("node"), stroke: V("line") });
      const cx = x + L.cw / 2, opts = { size: L.fs, mono: true };
      const lines = L.compact
        ? [ctx.text(cx, y + hgt / 2 - 9, KEYS[k], { ...opts, fill: V("muted") }), ctx.text(cx, y + hgt / 2 + 9, "", opts)]
        : [ctx.text(cx, y + hgt / 2, "", opts)];
      box.append(...lines);
      scene.appendChild(box);
      box.lines = lines;
      return box;
    }

    function renderBucket(st, k) {
      const vals = st.arrivals[k].slice().sort((a, b) => a.ord - b.ord).map(a => a.v);
      const list = `[${vals.length ? vals.join(", ") : " "}]`, b = st.buckets[k];
      b.lines[b.lines.length - 1].textContent = st.L.compact ? list : `${KEYS[k]}: ${list}`;
    }

    function renderResult(st, k) {
      const r = st.results[k], total = st.totals[k], done = total !== null;
      const val = (done ? "= " + total : "= ?") + (done && st.final ? " ✓" : "");
      const main = r.lines[r.lines.length - 1];
      main.textContent = st.L.compact ? val : `${KEYS[k]} ${val}`;
      ctx.attr(main, { "font-size": st.L.compact ? 12 : 13, "font-weight": 700, fill: done ? V("ink") : V("muted") });
      ctx.attr(r.rect, { fill: done ? V("ok-soft") : V("node"), stroke: done ? V("ok") : V("line") });
    }

    function drawStrip(st) {
      const { L, scene } = st, x = L.xs[0], w = L.W - 2 * x, cy = L.stripY + L.stripH / 2;
      const box = ctx.box({ x, y: L.stripY, w, h: L.stripH, fill: V("panel"), stroke: V("line"), dashed: true });
      box.label = ctx.text(x + 10, cy, "", muted(L, { anchor: "start" }));
      box.value = ctx.text(x + w - 10, cy, "", { size: 12, mono: true, weight: 700, anchor: "end" });
      box.append(box.label, box.value);
      scene.appendChild(box);
      box.target = [x + w - (L.compact ? 60 : 90), cy];
      return box;
    }

    const counterTone = st => (st.counter > TRUE_TOTAL ? "bad" : st.final && st.counter === TRUE_TOTAL ? "ok" : st.counter ? "warn" : "");
    function refresh(st) {
      const { L, strip, cfg: c } = st, tone = counterTone(st);
      stats.set("attempts", st.attempts, "");
      stats.set("output", st.totals[0] === null ? "–" : st.totals.join(" · "), st.totals[0] === null ? "" : "ok");
      stats.set("counter", c.impure ? st.counter : "n/a", c.impure ? tone : "");
      strip.label.textContent = L.stripLabel[c.impure ? 1 : 0];
      if (!c.impure) {
        strip.value.textContent = L.compact ? "untouched (pure map)" : "nothing: a pure map has no side effects";
        ctx.attr(strip.value, { fill: V("muted"), "font-weight": 400 });
        strip.value.classList.remove("viz-mono");
        return;
      }
      const extra = st.counter > TRUE_TOTAL && !L.compact ? ` (B's ${B_VALS.join(" + ")} counted twice)` : tone === "ok" ? " ✓" : "";
      strip.value.textContent = `${L.counterName} = ${st.counter}${extra}`;
      ctx.attr(strip.value, { fill: tone ? V(tone) : V("ink"), "font-weight": 700 });
      strip.value.classList.add("viz-mono");
      ctx.attr(strip.rect, { stroke: tone ? V(tone) : V("line") });
    }

    // ---------- animation pieces ----------
    const center = (x, y, w, hgt) => [x + w / 2, y + hgt / 2];
    function slotCenter(L, i, j) {
      const [dx, y] = L.slot(j);
      return center(L.xs[i] + dx, y, L.chipW, L.chipH);
    }
    function drawChip(st, i, j, e) {
      const { L } = st, [dx, y] = L.slot(j), x = L.xs[i] + dx;
      const chip = ctx.box({ x, y, w: L.chipW, h: L.chipH, rx: L.chipH / 2, fill: V("warn-soft"), stroke: V("warn"), label: pairText(e), mono: true, size: L.fs });
      chip.center = center(x, y, L.chipW, L.chipH);
      chip.strike = s("line", { x1: x + 8, x2: x + L.chipW - 8, y1: chip.center[1], y2: chip.center[1], stroke: V("bad"), "stroke-width": 1.6, opacity: 0 });
      chip.appendChild(chip.strike);
      st.chipLayer.appendChild(chip);
      return chip;
    }

    async function bump(st, v) {
      st.counter += v;
      refresh(st);
      await ctx.tween({ ms: 350, onUpdate: k => st.strip.rect.setAttribute("stroke-width", 1.5 + 2.5 * (1 - k)) });
    }

    // One shard's map attempt: each matching row emits a pair (and, if impure, bumps the counter).
    async function runMap(st, i, c) {
      st.shards[i].ph.setAttribute("opacity", 0);
      for (const [j, e] of EMITS[i].entries()) {
        const { L } = st, row = st.shards[i].rows[e.row], from = [L.xs[i] + L.cols[2] - 4, L.rowY(e.row)];
        row.hl.setAttribute("opacity", 1);
        const side = c.impure
          ? ctx.fly(st.packets, { from, to: st.strip.target, r: 4, fill: V("bad"), ms: 650 }).then(() => bump(st, e.value))
          : null;
        await ctx.fly(st.packets, { from, to: slotCenter(L, i, j), r: 6, fill: V("warn"), ms: 450 });
        st.chips[i][j] = drawChip(st, i, j, e);
        if (side) await side;
        row.hl.setAttribute("opacity", 0);
        await ctx.sleep(120);
      }
    }

    const fade = (els, from, to, ms) => ctx.tween({ ms, onUpdate: k => els.forEach(el => el.setAttribute("opacity", from + (to - from) * k)) });

    // ---------- steps ----------
    function makeSteps(c) {
      const imp = (pure, impure) => (c.impure ? impure : pure);
      const filter = {
        title: "The query: total sharks sighted per month",
        detail: "The filter <code>{family: 'Sharks'}</code> is the declarative part: the database applies it before calling map.",
        run: async st => {
          setCode("query");
          const out = st.shards.flatMap(sh => sh.rows.filter(r => !r.shark));
          await ctx.tween({ ms: 500, onUpdate: k => out.forEach(r => {
            r.g.setAttribute("opacity", 1 - 0.65 * k);
            r.strike.setAttribute("x2", r.x0 + (r.x1 - r.x0) * k);
          }) });
        },
      };
      const map = {
        title: "map runs on all three shards in parallel",
        detail: imp("For each matching document it calls <code>emit(year-month, numAnimals)</code>.",
          "For each matching document it calls <code>emit(year-month, numAnimals)</code> and also adds " +
          "numAnimals to a global counter outside the database."),
        run: async st => {
          setCode("map");
          st.attempts = 3;
          refresh(st);
          await Promise.all(SHARDS.map((_, i) => runMap(st, i, c)));
        },
      };
      const crash = {
        title: "Shard B's mapper crashes before reporting success",
        detail: "Shards A and C reported success. B's emitted pairs can't be trusted, so the database throws them away." +
          imp("", " <b>But the global counter already moved, and nothing can undo that.</b>"),
        run: async st => {
          setCode(null);
          setShard(st, 0, "ok", "✓ done");
          setShard(st, 2, "ok", "✓ done");
          setShard(st, B, "bad", "✕ crashed");
          st.chips[B].forEach(ch => {
            ch.discarded = true;
            ctx.attr(ch.rect, { stroke: V("bad"), fill: V("bad-soft"), "stroke-dasharray": "4 3" });
            ch.strike.setAttribute("opacity", 1);
          });
          await fade(st.chips[B], 1, 0.45, 500);
        },
      };
      const retry = {
        title: "The database simply runs map again for shard B",
        detail: imp("Same input + same function = same output. Running it twice is harmless&hellip; if it's pure.",
          `The retry emits the same pairs, but it bumps the counter again too: ${TRUE_TOTAL} + ${B_VALS.join(" + ")} = ${TRUE_TOTAL + B_SUM}.`),
        run: async st => {
          setCode("map");
          st.attempts = 4;
          refresh(st);
          setShard(st, B, "c2", "attempt 2");
          const old = st.chips[B];
          await fade(old, 0.45, 0, 300);
          old.forEach(ch => ch.remove());
          st.chips[B] = [];
          await runMap(st, B, c);
          setShard(st, B, "ok", "✓ attempt 2");
        },
      };
      const allOk = {
        title: "Every mapper finished on its first attempt",
        detail: `All three shards reported success, so all ${EMITS.flat().length} pairs are kept.` +
          imp("", ` The counter reads ${TRUE_TOTAL}, matching the true total&hellip; so far.`),
        run: async st => { setCode(null); [0, 1, 2].forEach(i => setShard(st, i, "ok", "✓ done")); },
      };
      const group = {
        title: "Pairs are grouped by key",
        detail: "Only pairs from successful attempts take part. (How this regrouping moves data between machines is Chapter 10's topic.)",
        run: async st => {
          setCode("group");
          const live = st.chips.flatMap((list, i) => list.map((ch, j) => ({ ch, e: EMITS[i][j] }))).filter(x => !x.ch.discarded);
          await Promise.all(live.map(({ ch, e }, ord) => ctx.sleep(ord * 80).then(async () => {
            const k = KEYS.indexOf(e.key), b = st.buckets[k];
            ch.setAttribute("opacity", 0.45);
            await ctx.fly(st.packets, { from: ch.center, to: center(st.L.xs[k], st.L.bucketY, st.L.cw, st.L.bucketH),
              label: String(e.value), labelSize: st.L.fs, fill: V("warn"), ms: 450 });
            st.arrivals[k].push({ ord, v: e.value });
            renderBucket(st, k);
            ctx.attr(b.rect, { stroke: V("warn") });
          })));
        },
      };
      const reduce = {
        title: "reduce(key, values) sums each group",
        detail: 'Called once per key: <code>reduce("1995-12", [3, 4, 1, 2])</code> returns 10. MongoDB skips the call ' +
          "for a key with a single value, so 1996-2's [6] passes straight through.",
        run: async st => {
          setCode("reduce");
          const { L } = st;
          await Promise.all(KEYS.map((_, k) => ctx.fly(st.packets, {
            from: center(L.xs[k], L.bucketY, L.cw, L.bucketH), to: center(L.xs[k], L.resultY, L.cw, L.resultH),
            label: st.arrivals[k].length > 1 ? "Σ" : "as is", labelSize: L.fs, fill: V("ok"), ms: 450,
          })));
          KEYS.forEach((_, k) => {
            st.totals[k] = sum(st.arrivals[k].map(a => a.v));
            renderResult(st, k);
            ctx.attr(st.buckets[k].rect, { stroke: V("line") });
          });
          refresh(st);
        },
      };
      const finalDetail = c.crash
        ? imp(`Shard B's first attempt died, its output was discarded, and the retry produced identical pairs. Result ${SQL_RESULT} matches SQL.`,
          `reduce says ${TRUE_TOTAL} sharks; the side-effect counter says ${TRUE_TOTAL + B_SUM}. The dead attempt's output was discarded, ` +
          "but its side effect couldn't be. <b>That's why map and reduce must be pure.</b>")
        : imp("Nothing failed, so nothing ran twice. Turn the crash back on: with a pure mapper the answer won't change.",
          "Without a failure the side effect looks harmless. The bug only appears on retry, which is what makes it dangerous.");
      const final = {
        title: "Same answer as the SQL query",
        detail: finalDetail,
        run: async st => {
          setCode(null);
          st.final = true;
          KEYS.forEach((_, k) => renderResult(st, k));
          refresh(st);
        },
      };
      return [filter, map, ...(c.crash ? [crash, retry] : [allOk]), group, reduce, final];
    }

    // init() fully rebuilds the scene from cfg; Back = init() + instant replay.
    function init() {
      const { L, scene, chipLayer, packets } = view;
      [scene, chipLayer, packets].forEach(g => g.replaceChildren());
      const st = { L, scene, chipLayer, packets, cfg, counter: 0, attempts: 0, final: false,
        chips: SHARDS.map(() => []), arrivals: KEYS.map(() => []), totals: KEYS.map(() => null) };
      drawFrame(st);
      st.shards = SHARDS.map((_, i) => drawShard(st, i));
      st.buckets = KEYS.map((_, k) => drawKeyBox(st, k, L.bucketY, L.bucketH));
      st.results = KEYS.map((_, k) => drawKeyBox(st, k, L.resultY, L.resultH));
      st.strip = drawStrip(st);
      KEYS.forEach((_, k) => { renderBucket(st, k); renderResult(st, k); });
      refresh(st);
      setCode(null);
      return st;
    }

    // The stepper keeps a reference to this array, so scenarios are swapped in place.
    const steps = makeSteps(cfg);
    function setCfg(patch) {
      cfg = { ...cfg, ...patch };
      steps.length = 0;
      steps.push(...makeSteps(cfg));
      player.reset();
    }

    buildSvg();
    const player = ctx.stepper({
      init, steps, delay: 1300,
      intro: "Press <b>Play</b> to run the monthly shark report as a MapReduce query. Then switch the mapper to <b>Impure</b> and play it again.",
    });
    renderCode();
    root.append(
      ui.bar(mapperSeg, crashToggle),
      svgHost,
      player.el,
      stats,
      h("div", { class: "viz-panel", style: "margin-top:12px" }, ui.bar(codeSeg), pre, codeNote),
    );
    // Rebuild for the other layout and replay to the same step. Deferred so the rebuild doesn't
    // resize the frame inside the ResizeObserver callback ("ResizeObserver loop" error).
    ctx.onResize(() => ctx.after(0, () => { if (ctx.compact !== compact) { buildSvg(); player.goto(player.index); } }));
  },
});
