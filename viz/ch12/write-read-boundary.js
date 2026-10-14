// Moving the write/read boundary (DDIA ch12, "Where the write path meets the read path").
// Full-text search over a document collection: the reader picks how much to precompute when a
// document is written (nothing, an inverted index, an index plus a cache of popular results, or
// the results of every query) and the workload, then sees the work on each path and which
// placement of the boundary is cheapest. Illustrative cost model in work units, not a benchmark.
(function () {
  "use strict";

  // ---- model (pure) ----
  const T = 100;                          // distinct terms per document
  const Q = T + (T * (T - 1)) / 2;        // 1- and 2-word queries one document can match: 5,050
  const REFRESH = 5;                      // cached popular queries a new document typically matches
  const CACHED = 1000;                    // cached result lists kept in storage
  const MERGE = 20;                       // matches merged per indexed query
  const BUDGET = 2e6, STORE_BUDGET = 2e9; // work units/s per path; units of storage
  // u = boundary position along the pipeline in stage units (stage i is centred on u = i).
  const STRATS = [
    { id: "none", seg: "Nothing", name: "Nothing (grep)", u: 1.5 },
    { id: "index", seg: "Index", name: "Index", u: 2.5 },
    { id: "cache", seg: "Index + cache", name: "Index + cache", u: 3 },
    { id: "all", seg: "Every query", name: "Every query", u: 3.5 },
  ];
  const strat = id => STRATS.find(st => st.id === id);
  // Slider value -> quantity on a log scale; half steps read as 3x (3k, 300k) rather than 3.16x.
  const pow = v => (Number.isInteger(v) ? 10 ** v : 3 * 10 ** Math.floor(v));

  /** Work per operation and per second for one strategy under workload w = {D, wps, rps, hit}. */
  function costs(id, w) {
    const lookup = 2 * Math.ceil(Math.log2(w.D)) + MERGE;   // two term lookups, then merge
    const [wr, rd, storage] = {
      none: [1, w.D, w.D],
      index: [1 + T, lookup, w.D * (1 + T)],
      cache: [1 + T + REFRESH, w.hit + (1 - w.hit) * lookup, w.D * (1 + T) + CACHED],
      all: [1 + T + Q, 1, w.D * (1 + T + Q)],
    }[id];
    const writePath = w.wps * wr, readPath = w.rps * rd;
    const stale = writePath > BUDGET, slow = readPath > BUDGET, full = storage > STORE_BUDGET;
    return { id, wr, rd, storage, writePath, readPath, total: writePath + readPath,
      stale, slow, full, broken: stale || slow || full };
  }

  /** Every strategy, plus the cheapest one that stays within all budgets (cheapest overall if none does). */
  function evaluate(w) {
    const rows = STRATS.map(st => costs(st.id, w));
    const fits = rows.filter(r => !r.broken);
    const best = (fits.length ? fits : rows).reduce((a, b) => (b.total < a.total ? b : a));
    return { rows, best, anyFits: fits.length > 0 };
  }

  /** 55010 -> "55k", 12660 -> "12.7k", 1e10 -> "10B". */
  function fmt(n) {
    let i = 0;
    while (i < 4 && n >= 999.5 * 1000 ** i) i++;
    return Number((n / 1000 ** i).toPrecision(3)) + ["", "k", "M", "B", "T"][i];
  }
  const num = n => (n % 1 ? n.toFixed(1) : n.toLocaleString("en-US"));
  const perOp = (n, what) => `${num(n)} unit${n === 1 ? "" : "s"} per ${what}`;

  // ---- view ----
  // Short enough to sit inside a 112-wide box with room to spare at 12px bold.
  const STAGES = ["New document", "Store document", "Build index", "Compute results", "Answer query"];
  const LAYOUT = {
    wide: { W: 640, H: 134, vertical: false, box: i => ({ x: 8 + 128 * i, y: 30, w: 112, h: 52 }), at: v => 64 + 128 * v },
    phone: { W: 360, H: 326, vertical: true, box: i => ({ x: 8, y: 8 + 57 * i, w: 250, h: 44 }), at: v => 30 + 57 * v },
  };
  const SIDE = {
    w: ["var(--viz-c5-soft)", "var(--viz-c5)"],
    r: ["var(--viz-c6-soft)", "var(--viz-c6)"],
    n: ["var(--viz-node)", "var(--viz-node-stroke)"],
  };
  const PRESETS = [
    { label: "Read-heavy (100k reads/s, 1 write/s)", v: [5, 0, 5] },
    { label: "Write-heavy (1k docs, 1k writes/s, 1 read/s)", v: [3, 3, 0] },
  ];

  // Outline of half a rounded box: left/right halves in a row layout, top/bottom when stacked.
  // Open at the seam, so two same-coloured halves read as one box.
  function halfPath({ x, y, w, h }, k, vertical, r = 8) {
    if (!vertical) {
      const mx = x + w / 2, ex = k ? x + w : x, sx = k ? -r : r;
      return `M${mx},${y} H${ex + sx} Q${ex},${y} ${ex},${y + r} V${y + h - r} Q${ex},${y + h} ${ex + sx},${y + h} H${mx}`;
    }
    const my = y + h / 2, ey = k ? y + h : y, sy = k ? -r : r;
    return `M${x},${my} V${ey + sy} Q${x},${ey} ${x + r},${ey} H${x + w - r} Q${x + w},${ey} ${x + w},${ey + sy} V${my}`;
  }

  Viz.register("ch12/write-read-boundary", {
    title: "Moving the write/read boundary",
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      // State lives outside build() so a phone <-> desktop rebuild keeps it.
      let sel = "index", docsV = 5, wV = 1, rV = 3, hitPct = 80;
      let u = strat(sel).u, tweenId = 0, compact = ctx.compact, view = null;
      const workload = () => ({ D: pow(docsV), wps: pow(wV), rps: pow(rV), hit: hitPct / 100 });
      const textW = (t, fallback) => (t.getComputedTextLength && t.getComputedTextLength()) || fallback;

      // Which path does half k of stage i belong to? First and last stages are neutral.
      const sideOf = (i, k) => (i === 0 || i === 4 ? "n" : i - 0.25 + 0.5 * k < u ? "w" : "r");
      function stageSub(i) {
        const onWrite = i < u;
        return [
          "~100 terms",
          "1 unit",
          onWrite ? "+100 postings" : `scan ${fmt(pow(docsV))} docs`,
          onWrite ? "+5,050 lists" : sel === "none" ? "match + rank" : "lookups + merge",
          sel === "all" ? "1 lookup" : sel === "cache" ? `${hitPct}% from cache` : "return top hits",
        ][i];
      }

      function drawStage(svg, G, i) {
        const b = G.box(i), g = s("g"), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        g.appendChild(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8, fill: "var(--viz-bg)" }));
        const halves = [0, 1].map(k => {
          const d = halfPath(b, k, G.vertical);
          const fill = s("path", { d: d + "Z" }), edge = s("path", { d, fill: "none", "stroke-width": 1.5 });
          g.append(fill, edge);
          return { fill, edge };
        });
        const muted = { fill: "var(--viz-muted)" };
        const label = G.vertical
          ? ctx.text(b.x + 10, cy, STAGES[i], { size: 12, weight: 700, anchor: "start" })
          : ctx.text(cx, cy - 8, STAGES[i], { size: 12, weight: 700 });
        const sub = G.vertical
          ? ctx.text(b.x + b.w - 10, cy, "", { size: 11, anchor: "end", ...muted })
          : ctx.text(cx, cy + 10, "", { size: 12, ...muted });
        g.append(label, sub);
        // Only "Compute results" is ever split at rest (Index + cache): popular results are
        // precomputed on write, rare ones are computed per query.
        let split = [];
        if (i === 3) {
          split = G.vertical
            ? [ctx.text(cx, cy - 11, "popular results: cached", { size: 11, weight: 700 }),
              ctx.text(cx, cy + 11, "rare results: via index", { size: 11, weight: 700 })]
            : [[b.x + b.w / 4, "popular", "cached"], [b.x + (3 * b.w) / 4, "rare", "via index"]].flatMap(([x, t1, t2]) =>
              [ctx.text(x, cy - 8, t1, { size: 12, weight: 700 }), ctx.text(x, cy + 10, t2, { size: 12, ...muted })]);
          g.append(...split);
        }
        svg.appendChild(g);
        return { i, halves, label, sub, split };
      }

      function buildPipeline() {
        const G = compact ? LAYOUT.phone : LAYOUT.wide;
        const svg = ctx.svg({ w: G.W, h: G.H, label: "Search pipeline from a document arriving to a query being answered, split into a write path and a read path" });
        for (let i = 0; i < 4; i++) {
          const a = G.box(i), b = G.box(i + 1);
          svg.appendChild(ctx.arrow(G.vertical
            ? { x1: a.x + a.w / 2, y1: a.y + a.h + 1, x2: b.x + b.w / 2, y2: b.y - 2, width: 1.3, svg }
            : { x1: a.x + a.w + 1, y1: a.y + a.h / 2, x2: b.x - 2, y2: b.y + b.h / 2, width: 1.3, svg }));
        }
        const stages = STAGES.map((_, i) => drawStage(svg, G, i));
        const line = s("path", { fill: "none", stroke: "var(--viz-ink)", "stroke-width": 1.5, "stroke-dasharray": "6 4" });
        const label = G.vertical
          ? ctx.text(274, 0, "derived data", { size: 11, weight: 700, anchor: "start", halo: true })
          : ctx.text(0, 10, "derived data: write path meets read path", { size: 12, weight: 700, halo: true });
        const regions = ["w", "r"].map(side => {
          const color = SIDE[side][1];
          const bracket = s("path", { fill: "none", stroke: color, "stroke-width": 1.5 });
          const name = side === "w" ? "write path" : "read path", mode = side === "w" ? "eager" : "lazy";
          const title = G.vertical
            ? ctx.text(276, 0, name, { size: 12, weight: 700, anchor: "start", fill: color })
            : ctx.text(0, 108, `${name} (${mode})`, { size: 12, weight: 700, fill: color });
          const sub = G.vertical
            ? ctx.text(276, 0, mode, { size: 11, anchor: "start", fill: "var(--viz-muted)" })
            : ctx.text(0, 124, "", { size: 12 });
          svg.append(bracket, title, sub);
          return { bracket, title, sub };
        });
        // Phone: the per-operation costs get their own lines under the stack.
        const costLines = G.vertical
          ? ["w", "r"].map((side, k) => ctx.text(8, G.H - 28 + 18 * k, "", { size: 12, weight: 600, anchor: "start", fill: SIDE[side][1] }))
          : [];
        svg.append(line, label, ...costLines);
        return { svg, G, stages, line, label, regions, costLines };
      }

      function drawBoundary() {
        const { G, stages, line, label, regions, costLines } = view.pipe;
        stages.forEach(st => {
          const sides = [0, 1].map(k => sideOf(st.i, k));
          st.halves.forEach((hv, k) => {
            ctx.attr(hv.fill, { fill: SIDE[sides[k]][0] });
            ctx.attr(hv.edge, { stroke: SIDE[sides[k]][1] });
          });
          const showSplit = st.split.length > 0 && sel === "cache" && sides[0] !== sides[1];
          st.split.forEach(t => (t.style.display = showSplit ? "" : "none"));
          st.label.style.display = st.sub.style.display = showSplit ? "none" : "";
          st.sub.textContent = stageSub(st.i);
        });
        const p = G.at(u), c = costs(sel, workload());
        const ops = [perOp(c.wr, "document"), perOp(c.rd, "query") + (sel === "cache" ? " (avg)" : "")];
        if (G.vertical) {
          const bottom = G.box(4).y + G.box(4).h;
          ctx.attr(line, { d: `M2,${p} H270` });
          ctx.attr(label, { y: p });
          [[G.box(0).y, p - 11], [p + 11, bottom]].forEach(([y1, y2], k) => {
            const R = regions[k], mid = (y1 + y2) / 2;
            ctx.attr(R.bracket, { d: `M264,${y1} H268 V${y2} H264` });
            ctx.attr(R.title, { y: mid - 7 });
            ctx.attr(R.sub, { y: mid + 8 });
          });
          costLines[0].textContent = "Per document written: " + ops[0].replace(/ per .*/, "");
          costLines[1].textContent = "Per query: " + ops[1].replace(/ per query/, "");
          return;
        }
        ctx.attr(line, { d: `M${p},19 V98` });
        const lw = textW(label, 262);
        ctx.attr(label, { x: Math.max(6 + lw / 2, Math.min(G.W - 6 - lw / 2, p)) });
        [[8, p - 8], [p + 8, G.W - 8]].forEach(([x1, x2], k) => {
          const R = regions[k];
          ctx.attr(R.bracket, { d: `M${x1},90 V94 H${x2} V90` });
          R.sub.textContent = ops[k];
          [R.title, R.sub].forEach(t => {
            const half = textW(t, 120) / 2;
            ctx.attr(t, { x: Math.max(4 + half, Math.min(G.W - 4 - half, (x1 + x2) / 2)) });
          });
        });
      }

      function slideBoundary() {
        const from = u, to = strat(sel).u, my = ++tweenId;
        ctx.tween({ ms: 400, ease: "inOut", onUpdate: k => {
          if (my !== tweenId || !view) return;
          u = from + (to - from) * k;
          drawBoundary();
        } });
      }

      function buildBars() {
        const B = compact
          ? { W: 360, H: 222, x0: 10, x1: 350, row: i => 24 + 52 * i, barY: 18, barH: 16, textY: 9, hlY: -3, hlH: 42, fs: 11 }
          : { W: 640, H: 174, x0: 140, x1: 520, row: i => 26 + 36 * i, barY: 9, barH: 18, textY: 18, hlY: 1, hlH: 34, fs: 12 };
        const svg = ctx.svg({ w: B.W, h: B.H, label: "Total work per second for each strategy on a log scale, split into write-path and read-path work" });
        const X = dec => B.x0 + (dec / 12) * (B.x1 - B.x0);
        const hlLayer = s("g"), gridLayer = s("g"), rowLayer = s("g");
        svg.append(hlLayer, gridLayer, rowLayer);
        ["1", "1k", "1M", "1B", "1T"].forEach((t, k) => {
          const x = X(3 * k), anchor = compact && k === 0 ? "start" : compact && k === 4 ? "end" : "middle";
          gridLayer.appendChild(s("line", { x1: x, x2: x, y1: 18, y2: B.H - 2, stroke: "var(--viz-line)", "stroke-width": 1, opacity: 0.45 }));
          gridLayer.appendChild(ctx.text(x, 9, t, { size: B.fs, fill: "var(--viz-muted)", anchor }));
        });
        if (!compact) gridLayer.appendChild(ctx.text(8, 9, "units/s (log)", { size: 12, anchor: "start", fill: "var(--viz-muted)" }));
        const rows = STRATS.map((st, i) => {
          const r = B.row(i), y = r + B.barY, g = s("g", { style: "cursor:pointer" });
          const hl = s("rect", { x: 2, y: r + B.hlY, width: B.W - 4, height: B.hlH, rx: 7, fill: "var(--viz-grid)", opacity: 0.7 });
          hlLayer.appendChild(hl);
          const tip = s("title");
          g.append(tip,
            s("rect", { x: 0, y: r + B.hlY, width: B.W, height: B.hlH, fill: "transparent" }),
            s("rect", { x: B.x0, y, width: B.x1 - B.x0, height: B.barH, rx: 3, fill: "var(--viz-grid)", opacity: 0.5 }));
          const write = s("rect", { y, height: B.barH, fill: "var(--viz-c5)" });
          const read = s("rect", { y, height: B.barH, fill: "var(--viz-c6)" });
          const outline = s("rect", { x: B.x0 - 1, y: y - 1, height: B.barH + 2, rx: 3, fill: "none", stroke: "var(--viz-ink)", "stroke-width": 2 });
          const name = ctx.text(compact ? B.x0 : 8, r + B.textY, st.name, { size: 12, anchor: "start" });
          const total = ctx.text(0, r + B.textY, "", { size: 12, anchor: "start", mono: true, halo: true });
          const tags = s("g");
          g.append(write, read, outline, name, total, tags);
          g.addEventListener("click", () => { if (ctx.alive) select(st.id); });
          rowLayer.appendChild(g);
          return { r, hl, tip, write, read, outline, name, total, tags };
        });
        return { svg, B, rows };
      }

      // A small rounded tag (cheapest / stale! / slow! / storage!): {el, measure(), place(x, y)}.
      function pill(text, tone, fs, dot) {
        const g = s("g"), c = `var(--viz-${tone})`, pad = 6, dotW = dot ? 9 : 0;
        const bg = s("rect", { rx: 8, height: fs + 6, fill: "var(--viz-bg)" });
        const soft = s("rect", { rx: 8, height: fs + 6, fill: `var(--viz-${tone}-soft)`, stroke: c, "stroke-width": 1 });
        const t = ctx.text(0, 0, text, { size: fs, weight: 700, fill: c, anchor: "start" });
        const d = dot ? s("circle", { r: 3.5, fill: c }) : null;
        g.append(bg, soft, t, d);
        return { el: g, measure() { this.w = pad * 2 + dotW + textW(t, text.length * fs * 0.62); },
          place(x, y) {
            [bg, soft].forEach(rc => ctx.attr(rc, { x, y: y - (fs + 6) / 2, width: this.w }));
            ctx.attr(t, { x: x + pad + dotW, y });
            if (d) ctx.attr(d, { cx: x + pad + 3, cy: y });
          } };
      }

      function drawBars(ev) {
        const { B, rows } = view.bars, span = B.x1 - B.x0;
        ev.rows.forEach((c, i) => {
          const R = rows[i], on = c.id === sel, y = R.r + B.textY;
          const len = (Math.log10(c.total + 1) / 12) * span, wLen = (len * c.writePath) / c.total;
          ctx.attr(R.write, { x: B.x0, width: wLen });
          ctx.attr(R.read, { x: B.x0 + wLen, width: len - wLen });
          ctx.attr(R.outline, { width: len + 2 });
          R.outline.style.display = R.hl.style.display = on ? "" : "none";
          ctx.attr(R.name, { "font-weight": on ? 700 : 500 });
          ctx.attr(R.total, { "font-weight": on ? 700 : 400 });
          R.total.textContent = fmt(c.total) + " units/s";
          R.tip.textContent = `${strat(c.id).name}: ${fmt(c.writePath)} on write + ${fmt(c.readPath)} on read = ${fmt(c.total)} units/s`;
          R.tags.innerHTML = "";
          const items = [{ measure() { this.w = textW(R.total, 90); }, place: x => ctx.attr(R.total, { x }) }];
          if (c.id === ev.best.id) items.push(pill("cheapest", "ok", B.fs, true));
          [["stale", "stale!"], ["slow", "slow!"], ["full", "storage!"]].forEach(([k, t]) => { if (c[k]) items.push(pill(t, "bad", B.fs)); });
          items.slice(1).forEach(it => R.tags.appendChild(it.el));
          items.forEach(it => it.measure());
          const width = items.reduce((a, it) => a + it.w, 0) + 6 * (items.length - 1);
          // Desktop: after the bar end, or inside the bar when it would run off the edge. Phone: right-aligned.
          let x = compact ? B.x1 - width : B.x0 + len + 8;
          if (!compact && x + width > B.W - 4) x = B.x0 + len - 6 - width;
          items.forEach(it => { it.place(x, y); x += it.w + 6; });
        });
      }

      function noteFor(ev, c, w) {
        const first = {
          none: `Writes are trivial, but every query scans all <b>${fmt(w.D)}</b> documents.`,
          index: "Each write adds ~100 postings to the inverted index, so each read is a few lookups.",
          cache: "Popular answers are precomputed when documents arrive; rare queries still use the index.",
          all: "Every read is one lookup, but each new document must update ~5,050 precomputed result lists.",
        }[sel];
        const best = ev.best, bestName = `<b>${strat(best.id).name}</b>`;
        if (c.broken) {
          const why = [];
          if (c.stale) why.push(`The write path needs <b>${fmt(c.writePath)}</b> units/s against a budget of 2M: the precompute pipeline falls behind and every precomputed answer gets staler by the second. Eager precomputation only pays when writes are rare.`);
          if (c.slow) why.push(`Reads need <b>${fmt(c.readPath)}</b> units/s against a budget of 2M: queries queue and latency explodes. Move work to the write path.`);
          if (c.full) why.push(`Storing a result list for every 1- and 2-word query takes <b>${fmt(c.storage)}</b> units against a budget of 2B, and real queries are far more varied than that: the set of possible queries is effectively infinite.`);
          why.push(ev.anyFits ? `${bestName} is the cheapest placement that fits.` : "No placement of the boundary fits this load: it needs more machines.");
          return [why.join(" "), "bad"];
        }
        const fresh = sel === "cache" || sel === "all" ? " Anything precomputed is only as fresh as the pipeline that updates it." : "";
        if (best.id === sel) {
          return [`${first} At <b>${fmt(w.rps)} reads/s</b> and <b>${fmt(w.wps)} writes/s</b> this is the cheapest place for the boundary.${fresh}`, "ok"];
        }
        const later = STRATS.findIndex(st => st.id === best.id) > STRATS.findIndex(st => st.id === sel);
        const dir = later ? "read side (precompute more on write)" : "write side (precompute less, do more per query)";
        return [`${first} At this load, ${bestName} would do less total work (${fmt(best.total)} vs ${fmt(c.total)} units/s): move the boundary toward the ${dir}.${fresh}`, "warn"];
      }

      function update() {
        if (!view) return;
        const w = workload(), ev = evaluate(w), c = ev.rows.find(r => r.id === sel), best = ev.best;
        drawBars(ev);
        drawBoundary();
        const tone = c.broken ? "bad" : best.id === sel ? "ok" : c.total <= 3 * best.total ? "warn" : "bad";
        view.stats.set("w", fmt(c.writePath), c.stale ? "bad" : "");
        view.stats.set("r", fmt(c.readPath), c.slow ? "bad" : "");
        view.stats.set("t", fmt(c.total), tone);
        view.stats.set("s", fmt(c.storage) + " units", c.full ? "bad" : "");
        view.note.set(...noteFor(ev, c, w));
        const ratio = w.rps / w.wps;
        view.ratio.textContent = ratio >= 1 ? `${fmt(ratio)} reads per write` : `${fmt(1 / ratio)} writes per read`;
        view.presets.forEach((b, k) => b.setActive(PRESETS[k].v.join() === [docsV, wV, rV].join()));
        view.hit.style.opacity = sel === "cache" ? "" : "0.45";
      }

      function select(id) {
        if (id === sel) return;
        sel = id;
        view.seg.set(id);
        update();
        slideBoundary();
      }

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const seg = ui.segmented({
          label: "Precompute on write", value: sel, onChange: select,
          options: STRATS.map(st => ({ value: st.id, label: st.seg })),
        });
        const slider = (label, min, max, step, value, format, set) => {
          const sl = ui.slider({ label, min, max, step, value, format, onInput: v => { set(v); update(); } });
          // The track's 140px flex-basis would push the value onto its own line on phones.
          if (compact) sl.input.style.flex = "1 1 80px";
          return sl;
        };
        const qty = v => fmt(pow(v));
        const sliders = [
          slider("Documents", 3, 7, 0.5, docsV, qty, v => (docsV = v)),
          slider("Writes/s", 0, 3, 0.5, wV, qty, v => (wV = v)),
          slider("Reads/s", 0, 5, 0.5, rV, qty, v => (rV = v)),
          slider("Cache hit rate", 50, 99, 1, hitPct, v => v + "%", v => (hitPct = v)),
        ];
        const hit = sliders[3];
        hit.title = "Only affects Index + cache";
        const presets = PRESETS.map(p => {
          const b = ui.button(p.label, () => {
            [docsV, wV, rV] = p.v;
            sliders.slice(0, 3).forEach((sl, k) => sl.set(p.v[k]));
            update();
          }, { kind: "ghost" });
          if (compact) Object.assign(b.style, { whiteSpace: "normal", textAlign: "left" });
          return b;
        });
        const ratio = ui.badge("", "info");
        const pipe = buildPipeline(), bars = buildBars();
        const legend = ui.legend([
          { color: "var(--viz-c5)", label: "work on the write path (eager)", shape: "square" },
          { color: "var(--viz-c6)", label: "work on the read path (lazy)", shape: "square" },
          { color: "var(--viz-ok)", label: "cheapest at this load", shape: "dot" },
        ].concat(compact ? [{ color: "var(--viz-ink)", label: "derived data: where the write path meets the read path", shape: "dash" }] : []));
        const stats = ui.stats([
          { key: "w", label: "Write-path work/s" },
          { key: "r", label: "Read-path work/s" },
          { key: "t", label: "Total work/s" },
          { key: "s", label: "Storage" },
        ]);
        const note = ui.note("");
        const caption = h("div", { class: "muted", style: "font-size:12.5px;line-height:1.5;margin-top:10px" },
          "Illustrative cost model, not a benchmark. 1 unit ≈ one record read or written. Each document has 100 distinct terms; " +
          "an index lookup costs log₂(documents); “Every query” keeps a result list for every 1- and 2-word query " +
          "(5,050 per document). Each path has a budget of 2M units/s and storage 2B units: stale! = the precompute pipeline " +
          "can't keep up, slow! = queries queue, storage! = too much to store. Click a bar to move the boundary there.");
        const workloadBar = ui.bar(...sliders);
        workloadBar.style.marginTop = "14px";
        const tryLabel = h("span", { class: "muted", style: "font-size:13px" }, "Try:");
        root.append(ui.bar(seg), pipe.svg, workloadBar, ui.bar(tryLabel, ...presets, ratio), bars.svg, legend, stats, note, caption);
        view = { seg, hit, presets, ratio, pipe, bars, stats, note };
        update();
      }

      build();
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
