// Row vs column storage (DDIA ch3): one 12-row fact table shown three ways: the logical table, the
// values each layout puts on disk, and the bitmap + run-length encoding of the product column. A
// query picker shows how many values each layout must read; a sort picker reorders whole rows or,
// as a deliberately broken counterexample, the product column on its own. Results, runs, bitmaps
// and RLE are always recomputed position-wise from the column arrays, as an engine would.
(function () {
  "use strict";

  // ---------------- Model (pure, no DOM) ----------------
  const COLS = ["date", "product", "store", "qty", "price"];
  // qty uses c6 (blue), not c4: c4 is the same green as --viz-ok, which marks matching rows.
  const HUE = { date: "c1", product: "c2", store: "c3", qty: "c6", price: "c5" };
  const NUMERIC = { "#": true, qty: true, price: true };
  const ROWS = [
    ["Mon", "apple", "S1", 3, "0.50"], ["Mon", "candy", "S2", 1, "1.20"], ["Tue", "banana", "S1", 2, "0.30"],
    ["Mon", "apple", "S2", 5, "0.50"], ["Tue", "candy", "S1", 2, "1.20"], ["Wed", "dates", "S2", 1, "4.00"],
    ["Tue", "apple", "S1", 4, "0.50"], ["Wed", "candy", "S1", 3, "1.20"], ["Tue", "candy", "S2", 1, "1.20"],
    ["Wed", "banana", "S2", 5, "0.30"], ["Mon", "dates", "S1", 2, "4.00"], ["Wed", "apple", "S2", 1, "0.50"],
  ].map((v, i) => ({ id: i + 1, date: v[0], product: v[1], store: v[2], qty: v[3], price: v[4] }));
  const N = ROWS.length, PRODUCTS = ["apple", "banana", "candy", "dates"], DAY = { Mon: 0, Tue: 1, Wed: 2 };

  const SORTS = {
    insertion: { keys: [], label: ["insertion order", "insertion"] },
    dp: { keys: ["date", "product"], label: ["date, product", "date, product"] },
    pd: { keys: ["product", "date"], label: ["product, date", "product, date"] },
    broken: { keys: ["product"], alone: "product", label: ["product column only (broken)", "product only ✗"],
      title: "Deliberately broken: sorts the product column on its own, never do this" },
  };
  const QUERIES = {
    q1: { cols: ["product", "qty"], label: ["Q1 · SUM(qty) by product", "Q1 by product"],
      sql: "SELECT product, SUM(qty) FROM fact_sales GROUP BY product" },
    q2: { cols: ["date", "product", "qty"], label: ["Q2 · Tue + candy", "Q2 Tue+candy"],
      sql: "SELECT SUM(qty) FROM fact_sales WHERE date = 'Tue' AND product = 'candy'" },
    q3: { cols: COLS, id: 7, label: ["Q3 · fetch row #7", "Q3 one row"],
      sql: "SELECT * FROM fact_sales WHERE id = 7", comment: "-- OLTP point lookup through an index" },
  };

  const sortKey = (c, v) => (c === "date" ? DAY[v] : v);
  /** Stable sort of row indexes by the given columns (ties keep insertion order). */
  function order(keys) {
    return ROWS.map((_, i) => i).sort((a, b) => {
      for (const k of keys) {
        const x = sortKey(k, ROWS[a][k]), y = sortKey(k, ROWS[b][k]);
        if (x !== y) return x < y ? -1 : 1;
      }
      return a - b;
    });
  }

  /** Physical order: one permutation per column file. Whole-row sorts share one; the broken
   *  sort gives the product file its own. perms["#"] is the order of the row ids (the index). */
  function layout(sortId) {
    const st = SORTS[sortId];
    const rows = order(st.alone ? [] : st.keys), alone = st.alone ? order(st.keys) : rows;
    const perms = { "#": rows }, cols = {};
    COLS.forEach(c => { perms[c] = c === st.alone ? alone : rows; cols[c] = perms[c].map(i => ROWS[i][c]); });
    return {
      perms, cols, aligned: !st.alone,
      ids: rows.map(i => ROWS[i].id),
      truth: rows.map(i => ROWS[i].product),   // the product each position's other values belong with
    };
  }

  const runs = arr => arr.reduce((n, v, i) => n + (i === 0 || v !== arr[i - 1] ? 1 : 0), 0);
  const bitmap = (arr, v) => arr.map(x => (x === v ? 1 : 0));
  const positions = bits => bits.reduce((a, b, i) => (b ? a.concat(i) : a), []);
  /** Alternating run lengths starting with the 0s; a final run of 0s is left implicit ("rest 0"). */
  function rle(bits) {
    const nums = [];
    let cur = 0, n = 0;
    bits.forEach(b => { if (b === cur) n++; else { nums.push(n); cur = b; n = 1; } });
    if (cur === 1) nums.push(n);
    return { nums, rest: bits[bits.length - 1] === 0 };
  }
  const rleText = r => r.nums.join(",") + (r.rest ? " (rest 0)" : "");

  function productRle(L) {
    const list = PRODUCTS.map(p => ({ p, bits: bitmap(L.cols.product, p), truth: bitmap(L.truth, p) }));
    list.forEach(e => { e.rle = rle(e.bits); });
    const lens = list.map(e => e.rle.nums.length);
    return { list, total: lens.reduce((a, b) => a + b, 0), max: Math.max(...lens) };
  }

  /** Runs a query position by position over the column arrays. */
  function evaluate(qid, L) {
    const c = L.cols;
    if (qid === "q1") {
      const sums = {};
      PRODUCTS.forEach(p => { sums[p] = 0; });
      c.product.forEach((p, i) => { sums[p] += c.qty[i]; });
      return { sums, text: PRODUCTS.map(p => `${p} ${sums[p]}`).join(" · "), short: PRODUCTS.map(p => sums[p]).join(" · ") };
    }
    if (qid === "q2") {
      const tue = bitmap(c.date, "Tue"), candy = bitmap(c.product, "candy"), and = tue.map((b, i) => b & candy[i]);
      const pos = positions(and), sum = pos.reduce((n, i) => n + c.qty[i], 0);
      return { tue, candy, and, pos, sum, text: `SUM(qty) = ${sum}`, short: String(sum) };
    }
    const p = L.ids.indexOf(QUERIES.q3.id), row = COLS.map(k => c[k][p]);   // the id index says where row #7 sits
    return { pos: [p], row, text: `#${QUERIES.q3.id} = ${row.join(" ")}`, short: row.join(" ") };
  }

  /** Values each layout must read: whole rows from the row file, only the query's columns otherwise. */
  function reads(qid, res) {
    const rows = qid === "q3" ? res.pos : ROWS.map((_, i) => i), cols = QUERIES[qid].cols;
    return { rows, cols, row: rows.length * COLS.length, col: rows.length * cols.length, seeks: cols.length };
  }
  // ---------------- View ----------------
  const MUTED = "var(--viz-muted)", INK = "var(--viz-ink)", OK = "var(--viz-ok)", BAD = "var(--viz-bad)";
  const hue = (c, soft) => `var(--viz-${HUE[c]}${soft ? "-soft" : ""})`;
  const paint = (el, o) => { for (const k in o) el.style.setProperty(k, o[k]); return el; };
  const bit = (b, color, wrong) => (b
    ? { text: 1, fill: `var(--viz-${color})`, ink: "var(--viz-bg)", bold: true, bad: wrong }
    : { text: 0, fill: "var(--viz-node)", stroke: "var(--viz-node-stroke)", ink: MUTED, bad: wrong });

  function geometry(compact) {
    const rowY = r => 40 + r * 17;
    return compact ? {
      W: 360, fs: 11,
      A: { H: 262, idX: 12, colX: i => 52 + i * 64, cw: 60, rowY, footY: 252, runs: "runs " },
      B: { H: 230, x: 8, rowTitleY: 12, colTitleY: 116, cw: 20, ch: 16,
        rowCell: k => { const i = k % 15; return [12 + i * 22 + Math.floor(i / 5) * 3, 22 + Math.floor(k / 15) * 20]; },
        colCell: (j, i) => [70 + i * 22, 126 + j * 20], name: j => [8, 134 + j * 20, "start"] },
      C: { labelX: 56, x0: 62, pitch: 24, cw: 22, ch: 16, top: 12, headStep: 20, step: 24, twoStep: 32, belowDy: 18, belowStep: 25 },
    } : {
      W: 640, fs: 12,
      A: { H: 262, idX: 24, colX: i => 90 + i * 110, cw: 100, rowY, footY: 252, runs: "runs: " },
      B: { H: 130, x: 16, rowTitleY: 14, colTitleY: 76, cw: 8, ch: 22, rowIdY: 59,
        rowCell: k => [16 + k * 9 + Math.floor(k / 5) * 2, 22],
        colCell: (j, i) => [16 + j * 122 + i * 9, 84], name: j => [16 + j * 122 + 53.5, 120, "middle"] },
      C: { labelX: 112, x0: 120, pitch: 28, cw: 26, ch: 20, top: 14, headStep: 24, step: 26, belowStep: 26 },
    };
  }

  Viz.register("ch3/column-store", {
    title: "Row vs column storage",
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      // State lives outside build() so a phone/desktop switch keeps it.
      let query = "q1", sort = "insertion", changed = "query", compact = ctx.compact;
      let G, v, epoch = 0;
      const T = (g, x, y, str, o) => g.appendChild(ctx.text(x, y, str, { size: G.fs, ...o }));

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        G = geometry(compact);
        const opts = defs => Object.keys(defs).map(id => ({ value: id, label: defs[id].label[compact ? 1 : 0], title: defs[id].title }));
        const qSeg = ui.segmented({ label: "Query", options: opts(QUERIES), value: query,
          onChange: q => { query = q; changed = "query"; update(false); } });
        const sSeg = ui.segmented({ label: "Sort rows by", options: opts(SORTS), value: sort,
          onChange: x => { sort = x; changed = "sort"; update(true); } });
        v = {
          note: ui.note(""),
          legend: ui.legend(COLS.map(c => ({ color: hue(c), label: c, shape: "square" })).concat([
            { color: OK, label: "matching row", shape: "square" },
            { color: BAD, label: "value paired with the wrong row", shape: "line" }])),
          sql: h("div", { style: "font-family:var(--font-mono);font-size:12.5px;line-height:1.5;padding:5px 9px;border-radius:7px;background:var(--viz-grid);color:var(--viz-ink);margin:0 0 8px;overflow-wrap:anywhere" }),
          result: h("div", { style: "display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;margin-top:6px;font-size:13px" }),
          stats: ui.stats([
            { key: "row", label: "Row store reads" }, { key: "col", label: "Column store reads" },
            { key: "seeks", label: "Seeks (row / column)" }, { key: "scale", label: "At 1B rows × 100 cols" },
            { key: "rle", label: "product RLE" }]),
          A: buildA(), B: layerSvg(G.B.H, "Row-oriented file and column-oriented files, one square per stored value"),
          C: layerSvg(160, "Bitmap and run-length encoding of one column"),
          cCap: caption(""),
        };
        const pC = section(" ", v.C.svg, v.cCap);
        v.cTitle = pC.firstChild;
        root.append(ui.bar(qSeg), ui.bar(sSeg), v.note, v.legend,
          section("fact_sales: the logical table", v.sql, v.A.svg, v.result),
          section("What the disk holds", v.B.svg,
            caption("Each square is one stored value, in file order; solid squares are the ones this query must read." +
              (compact ? "" : " Hover for the value."))),
          v.stats, pC);
        update(false, true);
      }

      const caption = text => h("div", { class: "muted", style: "font-size:12.5px;line-height:1.45;margin-top:6px" }, text);
      function section(title, ...kids) {
        const p = ui.panel(title, ...kids);
        p.style.marginTop = "12px";
        // Phones: no side padding, so the 360-wide drawings keep their text at >= 10px.
        if (compact) Object.assign(p.style, { padding: "10px 0 4px", borderWidth: "1px 0 0", borderRadius: "0", background: "none" });
        return p;
      }
      function layerSvg(height, label) {
        const svg = ctx.svg({ w: G.W, h: height, label });
        return { svg, layer: svg.appendChild(s("g")) };
      }
      function fade(el, my) {
        el.style.opacity = 0;
        ctx.tween({ ms: 300, ease: "out", onUpdate: k => { if (my === epoch) el.style.opacity = k; } });
      }

      function update(move, init) {
        const my = ++epoch;
        const L = layout(sort), res = evaluate(query, L), want = evaluate(query, layout("insertion"));
        const ok = res.text === want.text, rd = reads(query, res), pr = productRle(L);
        drawA(L, res, ok, my, move && !init, !init);
        drawB(L, rd);
        drawC(L, res, ok, pr);
        if (!init) { fade(v.B.layer, my); fade(v.C.layer, my); }
        const q = QUERIES[query];
        v.sql.innerHTML = q.sql + (q.comment ? ` <span style="color:var(--viz-muted)">${q.comment}</span>` : "");
        v.result.innerHTML = `<span class="viz-panel-title" style="margin:0">Result</span>` +
          `<span class="mono" style="font-weight:700;color:${ok ? OK : BAD}">${res.text}${ok ? "" : " ✗"}</span>` +
          (ok ? "" : `<span class="mono" style="color:var(--viz-muted)">(correct: ${want.short})</span>`);
        setStats(rd, pr, L);
        v.note.set(...noteFor(L, res, want, ok, rd, pr));
        v.legend.children[COLS.length].style.display = query === "q1" ? "none" : "";
        v.legend.lastChild.style.display = L.aligned ? "none" : "";
      }

      function setStats(rd, pr, L) {
        const point = query === "q3";
        v.stats.set("row", rd.row, rd.row > rd.col ? "bad" : "ok");
        v.stats.set("col", rd.col, rd.col < rd.row ? "ok" : "");
        v.stats.set("seeks", `1 / ${rd.seeks}`, point ? "warn" : "");
        // 1e9 rows × 8 bytes per value = 8 GB per column, before compression.
        const [a, b] = point ? ["1 seek", "100 seeks"] : [`${100 * 8} GB`, `${rd.cols.length * 8} GB`];
        v.stats.set("scale", `<span style="display:inline-block;font-size:15px;line-height:1.3">${a} vs <span style="white-space:nowrap">${b}</span></span>`, point ? "warn" : "ok");
        v.stats.set("rle", pr.total, pr.total > 8 ? "" : L.aligned ? "ok" : "warn");
      }

      // ---- Panel A: the logical table. Cell texts persist so a re-sort can slide them. ----
      function buildA() {
        const A = G.A, svg = ctx.svg({ w: G.W, h: A.H, label: "The fact_sales table: 12 rows, 5 columns" });
        const fills = s("g"), over = s("g"), cells = s("g"), head = s("g");
        svg.append(fills, over, cells, head);
        const x = c => (c === "#" ? A.idX : A.colX(COLS.indexOf(c)));
        const fill = {}, sfx = {}, items = [];
        ["#"].concat(COLS).forEach(c => {
          const t = T(head, x(c), 20, c, { weight: 700 });
          if (c !== "#") {
            sfx[c] = t.appendChild(s("tspan"));
            head.appendChild(paint(s("rect", { x: x(c) - A.cw / 2, y: 27, width: A.cw, height: 3, rx: 1.5 }), { fill: hue(c) }));
            fill[c] = fills.appendChild(s("rect", { x: x(c) - A.cw / 2, y: A.rowY(0) - 8.5, width: A.cw, height: 17 * N, rx: 4 }));
          }
          ROWS.forEach((row, r) => {
            const el = T(cells, x(c), A.rowY(r), String(c === "#" ? row.id : row[c]), { mono: !!NUMERIC[c] });
            items.push({ c, r, el, y: A.rowY(r) });
          });
        });
        return { svg, fills, over, x, fill, sfx, items };
      }

      function drawA(L, res, ok, my, move, anim) {
        const A = G.A, P = v.A, used = new Set(QUERIES[query].cols), st = SORTS[sort];
        COLS.forEach(c => {
          paint(P.fill[c], { fill: used.has(c) ? hue(c, true) : "none" });
          const k = st.keys.indexOf(c), sp = compact ? "" : " ";
          P.sfx[c].textContent = st.alone === c ? sp + (compact ? "↓✗" : "↓ alone") : k >= 0 ? `${sp}↓${k + 1}` : "";
          paint(P.sfx[c], { fill: st.alone === c ? BAD : MUTED });
        });
        P.items.forEach(it => paint(it.el, { fill: it.c !== "#" && used.has(it.c) ? INK : MUTED }));
        drawOverlay(L, res, ok);
        const targets = P.items.map(it => ({ it, from: it.y, to: A.rowY(L.perms[it.c].indexOf(it.r)) }));
        const place = k => targets.forEach(t => { t.it.y = ctx.lerp(t.from, t.to, k); t.it.el.setAttribute("y", t.it.y); });
        if (!move) {
          place(1);
          if (anim) { fade(P.over, my); fade(P.fills, my); }
          return;
        }
        // Slide the values to their new positions first, then show the runs they form.
        P.over.style.opacity = 0;
        ctx.tween({ ms: 700, ease: "inOut", onUpdate: k => { if (my === epoch) place(k); } })
          .then(() => { if (my === epoch) fade(P.over, my); });
      }

      // Bands for matching rows, run boundaries, run counts, and mismatched product values.
      function drawOverlay(L, res, ok) {
        const A = G.A, P = v.A, g = P.over, top = p => A.rowY(p) - 8.5, right = A.colX(4) + A.cw / 2 + 2;
        g.innerHTML = "";
        if (query !== "q1") res.pos.forEach(p => {
          const tone = ok ? "ok" : "bad";
          g.appendChild(paint(s("rect", { x: 1, y: top(p), width: right - 1, height: 17, rx: 3 }), { fill: `var(--viz-${tone}-soft)` }));
          g.appendChild(paint(s("rect", { x: 1, y: top(p) + 1, width: 3, height: 15, rx: 1.5 }), { fill: `var(--viz-${tone})` }));
        });
        COLS.forEach(c => {
          const arr = L.cols[c], x0 = P.x(c) - A.cw / 2, n = runs(arr);
          for (let p = 1; p < N; p++) {
            if (arr[p] !== arr[p - 1]) {
              g.appendChild(paint(s("line", { x1: x0 + 4, x2: x0 + A.cw - 4, y1: top(p), y2: top(p) }), { stroke: "var(--viz-node-stroke)", "stroke-width": "1px" }));
            }
          }
          T(g, P.x(c), A.footY, A.runs + n, { fill: n <= 4 ? OK : MUTED, weight: n <= 4 ? 700 : null });
        });
        const x0 = P.x("product") - A.cw / 2;
        L.cols.product.forEach((p, i) => {
          if (p === L.truth[i]) return;
          const r = g.appendChild(paint(s("rect", { x: x0 + 2, y: top(i) + 1, width: A.cw - 4, height: 15, rx: 3 }),
            { fill: "none", stroke: BAD, "stroke-width": "1.6px" }));
          r.appendChild(s("title", null, `Position ${i + 1}: the other columns describe a ${L.truth[i]} sale, but the product file now says ${p}`));
        });
      }

      // ---- Panel B: what each layout stores, one square per value; solid = must be read. ----
      function drawB(L, rd) {
        const B = G.B, g = v.B.layer, rows = new Set(rd.rows), cols = new Set(rd.cols);
        g.innerHTML = "";
        const cell = ([x, y], c, p, on) => {
          const r = g.appendChild(paint(s("rect", { x, y, width: B.cw, height: B.ch, rx: 1.5 }), { fill: hue(c), opacity: on ? 1 : 0.16 }));
          r.appendChild(s("title", null, `row #${L.ids[p]} · ${c} = ${L.cols[c][p]}`));
        };
        const header = (y, title, n, seeks, tone) => {
          T(g, B.x, y, title, { anchor: "start", weight: 700 });
          T(g, G.W - B.x, y, `${compact ? "" : "reads "}${n} of ${N * COLS.length} values · ${seeks} seek${seeks === 1 ? "" : "s"}`,
            { anchor: "end", weight: 600, fill: `var(--viz-${tone})` });
        };
        header(B.rowTitleY, "Row-oriented file", rd.row, 1, rd.row > rd.col ? "bad" : "ok");
        ROWS.forEach((_, p) => COLS.forEach((c, ci) => cell(B.rowCell(p * 5 + ci), c, p, rows.has(p))));
        if (B.rowIdY) {   // desktop: bracket each row's 5 values and name the row
          ROWS.forEach((_, p) => {
            const [xa] = B.rowCell(p * 5), xb = B.rowCell(p * 5 + 4)[0] + B.cw, y = B.ch + 26;
            g.appendChild(paint(s("path", { d: `M${xa},${y - 3} V${y} H${xb} V${y - 3}` }), { fill: "none", stroke: MUTED, "stroke-width": "1px" }));
            T(g, (xa + xb) / 2, B.rowIdY, "#" + L.ids[p], { mono: true, fill: rows.has(p) && rd.rows.length === 1 ? INK : MUTED });
          });
        }
        header(B.colTitleY, "Column-oriented files", rd.col, rd.seeks, rd.col < rd.row ? "ok" : "warn");
        COLS.forEach((c, j) => {
          ROWS.forEach((_, p) => cell(B.colCell(j, p), c, p, cols.has(c) && rows.has(p)));
          const [nx, ny, anchor] = B.name(j);
          T(g, nx, ny, c, { anchor, fill: cols.has(c) ? INK : MUTED, weight: cols.has(c) ? 700 : null });
        });
      }

      // ---- Panel C: bitmaps + RLE of product (Q1/Q3), or a WHERE clause as bitmap AND (Q2). ----
      function drawC(L, res, ok, pr) {
        const hit = query === "q3" ? res.pos[0] : -1;
        const rows = [{ label: "row #", head: true, cells: L.ids.map((id, i) => (i === hit ? { text: id, ink: INK, bold: true } : { text: id })) }];
        const misfit = L.aligned ? "" : " Red outlines mark values and bits that disagree with the row the other files describe.";
        let foot;
        if (query === "q2") {
          const realCandy = bitmap(L.truth, "candy"), realAnd = res.tue.map((b, i) => b & realCandy[i]);
          rows.push(
            { label: "date", sub: "= Tue", cells: res.tue.map(b => bit(b, "c1")), right: "from the date file" },
            { label: "product", sub: "= candy", cells: res.candy.map((b, i) => bit(b, "c2", b !== realCandy[i])), right: "from the product file" },
            { label: "AND", cells: res.and.map((b, i) => bit(b, ok ? "ok" : "bad", b !== realAnd[i])), right: "bit by bit" },
            { label: "qty", cells: L.cols.qty.map((q, i) => (res.and[i]
              ? { text: q, fill: hue("qty", true), stroke: hue("qty"), bold: true } : { text: q, ink: MUTED })) });
          const who = L.aligned ? "rows " + res.pos.map(p => "#" + L.ids[p]).join(", ") : "positions " + res.pos.map(p => p + 1).join(", ");
          foot = [`${who} → SUM(qty) = ${res.pos.map(p => L.cols.qty[p]).join(" + ")} = ${res.sum}${ok ? "" : " ✗"}`, "", ok ? OK : BAD];
          v.cTitle.textContent = "Answering WHERE with bitmaps";
          v.cCap.textContent = "Each condition becomes a bitmap read from one column file. ANDing them bit by bit picks the qty values to add, " +
            "which works only because bit k means the same row in every file." + misfit;
        } else {
          rows.push({ label: "product", cells: L.cols.product.map((p, i) => ({ text: p.slice(0, 3), fill: hue("product", true), bad: p !== L.truth[i] })) });
          pr.list.forEach(e => rows.push({ label: "= " + e.p, cells: e.bits.map((b, i) => bit(b, "c2", b !== e.truth[i])), below: rleText(e.rle) }));
          rows[0].right = "run lengths: 0s, 1s, 0s, …";
          const raw = PRODUCTS.length * N;
          foot = [`RLE numbers: ${pr.total}`, compact ? ` (raw: ${raw} bits)` : ` (the raw bitmaps are ${PRODUCTS.length} × ${N} = ${raw} bits)`,
            pr.total > 8 ? INK : L.aligned ? OK : "var(--viz-warn)"];
          v.cTitle.textContent = "Compressing the product column";
          v.cCap.textContent = "One bitmap per distinct value, one bit per row. Its run-length encoding lists alternating run lengths, " +
            "starting with the 0s; a final run of 0s is left implicit." + misfit;
        }
        renderC(rows, foot);
      }

      function renderC(rows, [footText, footSub, footFill]) {
        const C = G.C, g = v.C.layer, rx = C.x0 + N * C.pitch + 10;
        g.innerHTML = "";
        let y = C.top;
        rows.forEach(row => {
          const two = compact && row.sub;
          if (two) {
            T(g, C.labelX, y - 6, row.label, { anchor: "end", weight: 600 });
            T(g, C.labelX, y + 7, row.sub, { anchor: "end", fill: MUTED });
          } else {
            T(g, C.labelX, y, row.sub ? `${row.label} ${row.sub}` : row.label, { anchor: "end", weight: row.head ? null : 600, fill: row.head ? MUTED : INK });
          }
          row.cells.forEach((cl, i) => {
            const x = C.x0 + i * C.pitch;
            if (!row.head) {
              g.appendChild(paint(s("rect", { x, y: y - C.ch / 2, width: C.cw, height: C.ch, rx: 3 }),
                { fill: cl.fill || "none", stroke: cl.bad ? BAD : cl.stroke || "none", "stroke-width": cl.bad ? "2px" : "1px" }));
            }
            T(g, x + C.cw / 2, y + 0.5, String(cl.text), { mono: true, fill: cl.ink || (row.head ? MUTED : INK), weight: cl.bold ? 700 : null });
          });
          if (row.right && !compact) T(g, rx, y, row.right, { anchor: "start", fill: MUTED });
          if (row.below) {
            if (compact) y += C.belowDy;
            T(g, compact ? C.x0 : rx, y, (compact ? "RLE " : "") + row.below, { anchor: "start", mono: true });
          }
          y += row.head ? C.headStep : two ? C.twoStep : row.below ? C.belowStep : C.step;
        });
        const t = T(g, C.x0, y, footText, { anchor: "start", weight: 700, fill: footFill });
        if (footSub) t.appendChild(paint(s("tspan", { "font-weight": 400 }), { fill: MUTED })).textContent = footSub;
        v.C.svg.setAttribute("viewBox", `0 0 ${G.W} ${y + 12}`);
      }

      // ---- The explanation line: what the last change shows. ----
      function noteFor(L, res, want, ok, rd, pr) {
        const c = L.cols;
        if (!L.aligned) {
          const i = 6;   // position 7: row #7 in every file except product
          const what = ok ? "" : query === "q1" ? brokenQ1(res, want) : query === "q2"
            ? `Q2 now returns <b>${res.sum}</b> instead of ${want.sum}.`
            : `Q3 reassembles row #7 with <b>${res.row[1]}</b> instead of ${want.row[1]}.`;
          return [`Sorting only the product column squeezed it into <b>${runs(c.product)} runs</b>, but position 7 now pairs ` +
            `${c.date[i]}, ${c.store[i]} and qty ${c.qty[i]} with <b>${c.product[i]}</b>: values that never belonged to one sale. ${what} ` +
            "Column files work only because every file keeps the same row order, so always sort whole rows.", "bad"];
        }
        if (changed === "sort" && sort === "pd") {
          return [`Sorting whole rows by product turns the product column into <b>${runs(c.product)} runs</b>: each bitmap's RLE is just ` +
            `${pr.max} numbers. date, the second sort key, compresses less (${runs(c.date)} runs); price, which depends on product, ` +
            `rides along (${runs(c.price)} runs); store and qty look random. ` +
            "On a billion rows the first sort key compresses to a few kilobytes.", "ok"];
        }
        if (changed === "sort" && sort === "dp") {
          return [`Now date is the first sort key (<b>${runs(c.date)} runs</b>), so a query for one day (or for last month, in a real table) ` +
            `reads one contiguous range of each column file; product only forms short runs inside each day (${runs(c.product)} runs).`, "info"];
        }
        if (changed === "sort") {
          return [`Insertion order: each new sale is appended to the end of every column file, which keeps writes cheap, but nothing is ` +
            `grouped: product forms ${runs(c.product)} runs and its bitmaps need ${pr.total} RLE numbers.`, "info"];
        }
        if (query === "q2") {
          return [`Each bitmap has one bit per row, in the same row order in every column file, so <code>date = Tue AND product = candy</code> ` +
            `is a bitwise AND: rows ${res.pos.map(p => "#" + L.ids[p]).join(" and ")}, SUM(qty) = ${res.sum}.`, "ok"];
        }
        if (query === "q3") {
          return ["Fetching one whole row is the row store's home turf: one contiguous read. The column store must visit all " +
            `${rd.seeks} files (100 in a wide fact table). That's why OLTP databases stay row-oriented.`, "warn"];
        }
        return [`<code>SUM(qty) GROUP BY product</code> needs ${rd.cols.length} of ${COLS.length} columns. The row store must read every ` +
          `row in full (${rd.row} values); the column store reads just the product and qty files (${rd.col}). With 100-column fact ` +
          `tables that is ${100 / rd.cols.length}x less I/O, before compression.`, "info"];
      }
      function brokenQ1(res, want) {
        const diff = PRODUCTS.filter(p => res.sums[p] !== want.sums[p]);
        return `Q1 now reports <b>${diff.map(p => `${p} ${res.sums[p]}`).join(", ")}</b> instead of ${diff.map(p => want.sums[p]).join(", ")}.`;
      }

      build();
      // Rebuild with the other layout when the frame crosses the phone breakpoint.
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
