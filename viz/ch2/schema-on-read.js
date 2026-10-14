// Schema-on-read vs schema-on-write. The same users are written to a document store and to a
// relational table. Shipping a new shape costs the table a migration and the document store
// nothing, until a reader meets the old shapes (and a typo) at read time.
Viz.register("ch2/schema-on-read", {
  title: "Where does the schema live?",
  mount(root, ctx) {
    const { s, ui } = ctx;
    const CAP = 8;
    const SEED = ["Ada Lovelace", "Alan Turing", "Edgar Codd", "Jim Gray"];
    const POOL = ["Grace Hopper", "Fran Allen", "Don Knuth", "John Backus"];
    const INK = "var(--viz-ink)", MUTED = "var(--viz-muted)", KEY = "var(--viz-c2)", C6 = "var(--viz-c6)";
    const OK = "var(--viz-ok)", BAD = "var(--viz-bad)", WARN = "var(--viz-warn)", INFO = "var(--viz-info)";
    const TONES = {
      plain: ["var(--viz-panel)", "var(--viz-line)"], code: ["var(--viz-panel)", C6],
      warn: ["var(--viz-warn-soft)", WARN], ok: ["var(--viz-ok-soft)", OK], bad: ["var(--viz-bad-soft)", BAD],
    };
    const INITIAL_NOTE = "Both databases hold 4 users written by app v1 as a single <code>name</code>. " +
      "Product now wants first and last names. Press <b>Ship v2</b> and compare what each database makes you do.";

    // The model is the single source of truth. Every action updates it first, then animates a
    // fresh draw() of it, so Reset or a layout rebuild mid-animation lands on a consistent frame.
    let m = fresh(), busy = false, epoch = 0, compact = ctx.compact, view = null;

    function fresh() {
      return {
        version: "v1", legacyFix: false, typoUsed: false, pool: 0,
        docs: SEED.map(name => ({ name })),
        rows: SEED.map((name, i) => ({ id: i + 1, name, first: null, last: null })),
        migrated: 0, rejected: 0, read: null, banner: "ddl", note: "initial",
      };
    }
    const shapeOf = d => ("frist_name" in d ? "typo" : "first_name" in d ? "v2" : "v1");
    const shapeCount = () => new Set(m.docs.map(shapeOf)).size;
    // The document reader, exactly as its code panel shows it. Returns undefined on a miss.
    function readDoc(d) {
      if (m.version === "v1") return d.name.split(" ")[0];
      return d.first_name ?? (m.legacyFix ? d.name?.split(" ")[0] : undefined);
    }
    const docErrors = () => (m.read ? m.read.filter(v => v === undefined).length : null);

    // ---------------------------------------------------------------- layout
    function layout(phone) {
      if (!phone) return {
        W: 640, H: 356, fs: 12, divider: { x1: 330, y1: 6, x2: 330, y2: 350 },
        A: {
          title: [8, 18], writer: [8, 140], reader: [156, 166], chipY: 26,
          doc: { xs: [8, 167], w: 155, h: 58, y0: 56, dy: 62, l1: 18, l2: 34, res: 52 },
          panel: { x: 8, y: 306, w: 314, h: 44 },
        },
        B: {
          title: [338, 18], writer: [338, 136], reader: [482, 150], chipY: 26,
          table: { x: 340, cols: [24, 104, 84, 80], hy: 56, hh: 22, rh: 26 },
          panel: { x: 338, y: 306, w: 294, h: 44 },
        },
      };
      const oy = 360;   // Lane B starts below Lane A on phones
      return {
        W: 360, H: 690, fs: 11, divider: { x1: 6, y1: 352, x2: 354, y2: 352 },
        A: {
          title: [8, 18], writer: [8, 160], reader: [176, 176], chipY: 26,
          doc: { xs: [8, 182], w: 170, h: 56, y0: 56, dy: 60, l1: 16, l2: 31, res: 49 },
          panel: { x: 8, y: 300, w: 344, h: 44 },
        },
        B: {
          title: [8, oy + 18], writer: [8, 160], reader: [176, 176], chipY: oy + 26,
          table: { x: 10, cols: [22, 110, 104, 104], hy: oy + 58, hh: 22, rh: 24 },
          panel: { x: 8, y: oy + 280, w: 344, h: 44 },
        },
      };
    }
    const docBox = i => {
      const D = view.L.A.doc;
      return { x: D.xs[i % 2], y: D.y0 + Math.floor(i / 2) * D.dy, w: D.w, h: D.h };
    };
    const center = b => [b.x + b.w / 2, b.y + b.h / 2];
    function cols() {
      const T = view.L.B.table;
      let x = T.x;
      return T.cols.map(w => { const c = { x, w }; x += w; return c; });
    }
    const rowY = i => view.L.B.table.hy + view.L.B.table.hh + i * view.L.B.table.rh;
    function rowBox(i) {
      const C = cols(), last = C[m.version === "v2" ? 3 : 1];
      return { x: C[0].x, y: rowY(i), w: last.x + last.w - C[0].x, h: view.L.B.table.rh };
    }
    const readCol = () => (m.version === "v2" ? 2 : 1);   // name before the migration, first_name after
    const cellBox = (i, ci) => { const c = cols()[ci]; return { x: c.x, y: rowY(i), w: c.w, h: view.L.B.table.rh }; };
    const writerTip = lane => { const P = view.L[lane]; return [P.writer[0] + P.writer[1] / 2, P.chipY + 22]; };

    // ---------------------------------------------------------------- svg helpers
    // parts: a string, or [[text, fill], ...] rendered as tspans (white-space kept for code indents).
    function fillText(t, parts) {
      t.textContent = "";
      (typeof parts === "string" ? [[parts]] : parts).forEach(([str, fill]) =>
        t.appendChild(s("tspan", fill ? { fill } : null, str)));
      return t;
    }
    function txt(x, y, parts, o = {}) {
      const t = ctx.text(x, y, "", {
        size: o.size || view.L.fs, anchor: o.anchor || "start", baseline: o.baseline || "alphabetic",
        weight: o.weight, mono: o.mono, fill: o.fill || INK,
      });
      t.style.whiteSpace = "pre";
      return fillText(t, parts);
    }
    function rect(b, o) {
      return s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: o.rx ?? 0, fill: o.fill || "none",
        stroke: o.stroke || "none", "stroke-width": o.width || 1, "stroke-dasharray": o.dash || null });
    }
    function chip(x, y, w) {
      const g = s("g");
      g.appendChild(rect({ x, y, w, h: 22 }, { rx: 11, fill: "var(--viz-c6-soft)", stroke: C6, width: 1.2 }));
      g.label = g.appendChild(txt(x + w / 2, y + 11, "", { anchor: "middle", baseline: "middle" }));
      return g;
    }
    function panel(P, dash) {
      const g = s("g");
      g.box = g.appendChild(rect(P, { rx: 8, width: 1.4, dash }));
      g.l1 = g.appendChild(txt(P.x + 8, P.y + 18, "", { mono: true }));
      g.l2 = g.appendChild(txt(P.x + 8, P.y + 34, "", { mono: true }));
      return g;
    }
    function setPanel(g, tone, l1, l2) {
      ctx.attr(g.box, { fill: TONES[tone][0], stroke: TONES[tone][1] });
      fillText(g.l1, l1);
      fillText(g.l2, l2);
    }
    const outline = (b, pad, o) => view.marks.appendChild(rect({ x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad }, o));
    function fade(els, ms = 300) {
      return Promise.all(els.filter(Boolean).map(el => { el.setAttribute("opacity", 0); return ctx.animate(el, { opacity: 1 }, ms); }));
    }
    const packet = (from, to, lost) => ctx.fly(view.fx, { from, to, fill: C6, ms: 600, r: 6, lost });

    // ---------------------------------------------------------------- texts
    const BANNERS = {
      ddl: () => ["plain", "CREATE TABLE users (id int, name text);", [["-- every write is checked against this", MUTED]]],
      alter: () => ["warn", "ALTER TABLE users ADD first_name text,", [["  ADD last_name text; "], ["-- metadata only", MUTED]]],
      backfill: (k, n) => ["warn", "UPDATE users SET first_name = …,", [["  last_name = …;  "], [`-- row ${k} of ${n}`, MUTED]]],
      done: (k, n) => ["ok", "-- done: columns added (metadata only)", `-- ${n} rows rewritten by the backfill`],
      error: () => ["bad", [["ERROR:", BAD], [' column "'], ["frist_name", BAD], ['" of']], 'relation "users" does not exist'],
    };
    const setBanner = (kind, k = 0) => setPanel(view.banner, ...BANNERS[kind](k, m.migrated));
    function codeLines() {
      if (m.version === "v1") return [`const first = doc.name.split(" ")[0];`, [["// one shape: no checks needed", MUTED]]];
      if (!m.legacyFix) return ["const first = doc.first_name;", [["// assumes every doc has first_name", MUTED]]];
      return ["const first = doc.first_name ??", [[`  doc.name?.split(" ")[0]; `], ["// legacy", MUTED]]];
    }
    const readerLabel = () => (m.version === "v1" ? "reader: v1" : m.legacyFix ? "reader: v2 + legacy fix" : "reader: v2");

    function readNote() {
      const k = docErrors(), tail = "Under schema-on-read, every shape ever written is the reader's problem.";
      if (m.version === "v1") return ["Every record has the same shape, so both readers are happy. The differences appear when the shape changes.", "ok"];
      if (m.typoUsed) {
        return [m.legacyFix
          ? `<b>${k} error${k === 1 ? "" : "s"}.</b> The legacy fix doesn't cover the <code>frist_name</code> document: it's a shape nobody planned for. ${tail}`
          : `<b>${k} errors:</b> ${k - 1} old <code>{name}</code> documents plus the <code>frist_name</code> one. ` +
            `The legacy fix can rescue the old ones but not the typo: it's a shape nobody planned for. ${tail}`, "bad"];
      }
      if (!m.legacyFix) {
        return [`<b>${k} documents rendered as undefined</b>: the v2 reader assumes <code>first_name</code> exists. ` +
          "Nothing failed when the data was written; the error surfaces now, in a reader that may belong to another team. " +
          "The table has no such rows because the migration already converted them.", "bad"];
      }
      return ["The reader converts old documents on the fly (if a doc has <code>name</code> but no <code>first_name</code>, " +
        "split <code>name</code>). Every reader of this collection needs that branch, forever or until a backfill: " +
        "the schema didn't disappear, it moved into application code.", "ok"];
    }
    function noteFor() {
      const full = m.docs.length >= CAP ? " This demo holds 8 records. Press <b>Reset</b> to start over." : "";
      switch (m.note) {
        case "write": return m.version === "v1"
          ? ["Both databases stored the new user as a single <code>name</code>. Every record still has the same shape." + full, "info"]
          : [`New users get <code>first_name</code>/<code>last_name</code>. The document store now holds ${shapeCount()} shapes of user; the table still has 1.` + full, "info"];
        case "ship": return [`The table had to be migrated: adding the columns was instant (metadata only), but the backfill <code>UPDATE</code> ` +
          `rewrote all ${m.migrated} rows, the slow, risky part on a billion-row table. ` +
          "The document store needed nothing: the old documents simply keep their old shape.", "warn"];
        case "typo": return ["The document store happily stored <code>frist_name</code>. The relational database rejected the write immediately, " +
          "with an error the writer's developer will see in testing. Schema-on-write turns a latent data bug into a loud one." + full, "warn"];
        case "toggle": return [m.version === "v1"
          ? "Reader updated. The new branch only matters once v2 ships: for now every document still has <code>name</code>."
          : "Reader updated. Press <b>▶ Run reader</b> again.", "info"];
        case "read": return readNote();
        default: return [INITIAL_NOTE, "info"];
      }
    }

    // ---------------------------------------------------------------- drawing
    function drawStatic() {
      const { L, base } = view;
      base.appendChild(s("line", { ...L.divider, stroke: "var(--viz-line)", "stroke-width": 1 }));
      ["A", "B"].forEach(lane => {
        const P = L[lane];
        base.appendChild(txt(P.title[0], P.title[1],
          lane === "A" ? "Document store · schema-on-read" : "Relational table · schema-on-write", { size: 13, weight: 700 }));
        view["writer" + lane] = base.appendChild(chip(P.writer[0], P.chipY, P.writer[1]));
        view["reader" + lane] = base.appendChild(chip(P.reader[0], P.chipY, P.reader[1]));
      });
      view.code = base.appendChild(panel(L.A.panel, "5 4"));
      view.banner = base.appendChild(panel(L.B.panel));
    }

    function draw(hideRead) {
      [view.docs, view.table, view.marks, view.fx].forEach(g => { g.innerHTML = ""; });
      fillText(view.writerA.label, "writer: app " + m.version);
      fillText(view.writerB.label, "writer: app " + m.version);
      fillText(view.readerA.label, readerLabel());
      fillText(view.readerB.label, "reader: " + m.version);
      setPanel(view.code, "code", ...codeLines());
      setBanner(m.banner);
      view.docEls = [];
      for (let i = 0; i < CAP; i++) {
        if (i < m.docs.length) view.docEls.push(drawDoc(i));
        else view.docs.appendChild(rect(docBox(i), { rx: 8, stroke: "var(--viz-line)", dash: "3 5", width: 1 }));
      }
      drawTable();
      if (m.read && !hideRead) m.docs.forEach((_, i) => { showDocRead(i); if (i < m.rows.length) showRowRead(i); });
    }

    function drawDoc(i) {
      const d = m.docs[i], shape = shapeOf(d), b = docBox(i), D = view.L.A.doc, g = s("g");
      const field = (k, v, kc = KEY) => [[k, kc], [": ", MUTED], [`"${v}"`]];
      const lines = shape === "v1" ? [field("name", d.name)]
        : shape === "v2" ? [field("first_name", d.first_name), field("last_name", d.last_name)]
        : [field("frist_name", d.frist_name, BAD), field("last_name", d.last_name)];
      const card = g.appendChild(rect(b, { rx: 8, fill: "var(--viz-node)", stroke: shape === "typo" ? WARN : KEY, width: 1.5 }));
      lines.forEach((parts, k) => g.appendChild(txt(b.x + 5, b.y + (k ? D.l2 : D.l1), parts, { mono: true })));
      // The version tag shares the result line's baseline, so it never collides with line 1.
      g.appendChild(txt(b.x + b.w - 5, b.y + D.res, { v1: "v1", v2: "v2", typo: "??" }[shape], { anchor: "end", fill: MUTED }));
      const result = g.appendChild(txt(b.x + 5, b.y + D.res, "", { mono: true, weight: 700 }));
      view.docs.appendChild(g);
      return { g, card, result };
    }

    function setCell(el, v, fill) {
      el.textContent = v ?? "NULL";
      el.classList.toggle("viz-mono", v == null);
      ctx.attr(el, { fill: fill || (v == null ? MUTED : INK) });
    }

    function drawTable() {
      const T = view.L.B.table, C = cols(), wide = m.version === "v2";
      const cell = (g, ci, y, h, fill) => g.appendChild(rect({ x: C[ci].x, y, w: C[ci].w, h }, { fill, stroke: "var(--viz-line)" }));
      const label = (g, ci, y, str, o) => g.appendChild(txt(C[ci].x + 5, y, str, { baseline: "middle", ...o }));
      const head = s("g"), headExtra = s("g");   // headExtra: the columns the migration adds
      ["id", "name", "first_name", "last_name"].forEach((name, ci) => {
        if (ci > 1 && !wide) return;
        const g = ci > 1 ? headExtra : head;
        cell(g, ci, T.hy, T.hh, "var(--viz-panel)");
        label(g, ci, T.hy + T.hh / 2, name, { mono: true, weight: 700 });
      });
      view.table.append(head, headExtra);
      view.headExtra = headExtra;
      view.rowEls = m.rows.map((r, i) => {
        const y = rowY(i), mid = y + T.rh / 2, g = s("g"), extra = s("g");
        const el = { g, extra };
        [0, 1].forEach(ci => cell(g, ci, y, T.rh, "var(--viz-node)"));
        label(g, 0, mid, String(r.id), { mono: true, fill: MUTED });
        setCell(el.name = label(g, 1, mid, ""), r.name);
        if (wide) {
          [2, 3].forEach(ci => cell(extra, ci, y, T.rh, "var(--viz-node)"));
          setCell(el.first = label(extra, 2, mid, ""), r.first);
          setCell(el.last = label(extra, 3, mid, ""), r.last);
          g.appendChild(extra);
        }
        view.table.appendChild(g);
        return el;
      });
    }

    function showDocRead(i) {
      const v = m.read[i], el = view.docEls[i];
      fillText(el.result, "→ " + (v === undefined ? "undefined" : v));
      ctx.attr(el.result, { fill: v === undefined ? BAD : OK });
      if (v === undefined) ctx.attr(el.card, { stroke: BAD });
    }
    const showRowRead = i => outline(cellBox(i, readCol()), -1.5, { rx: 3, stroke: OK, width: 2 });

    // ---------------------------------------------------------------- panel sync
    function syncControls() {
      const { btn, fix } = view, full = m.docs.length >= CAP, v2 = m.version === "v2";
      btn.write.disable(busy || full);
      btn.ship.disable(busy || v2).setLabel(v2 ? "v2 shipped ✓" : "Ship v2 (split name)");
      btn.typo.disable(busy || !v2 || m.typoUsed || full);
      btn.read.disable(busy);
      fix.querySelector("input").disabled = busy;
      fix.style.opacity = busy ? 0.55 : "";
    }
    function syncInfo() {
      const { stats, note } = view, shapes = shapeCount(), errs = docErrors();
      stats.set("shapes", shapes, ["", "", "warn", "bad"][shapes]);
      stats.set("docErrors", errs === null ? "–" : errs, errs === null ? "" : errs ? "bad" : "ok");
      stats.set("migrated", m.migrated, m.migrated ? "info" : "");
      stats.set("rejected", m.rejected, m.rejected ? "ok" : "");
      note.set(...noteFor());
    }
    const begin = () => { busy = true; syncControls(); return epoch; };
    function end(my) {
      if (my !== epoch) return;
      busy = false;
      syncControls();
      syncInfo();
    }
    // Any change to data or readers invalidates the last read.
    const changed = note => { m.read = null; m.note = note; };

    // ---------------------------------------------------------------- actions
    async function writeUser() {
      if (busy || m.docs.length >= CAP) return;
      const name = POOL[m.pool++], [first, last] = name.split(" "), v2 = m.version === "v2";
      m.docs.push(v2 ? { first_name: first, last_name: last } : { name });
      m.rows.push({ id: m.rows.length + 1, name: v2 ? null : name, first: v2 ? first : null, last: v2 ? last : null });
      changed("write");
      const my = begin(), di = m.docs.length - 1, ri = m.rows.length - 1;
      draw();
      const doc = view.docEls[di].g, row = view.rowEls[ri].g;
      doc.setAttribute("opacity", 0);
      row.setAttribute("opacity", 0);
      await Promise.all([packet(writerTip("A"), center(docBox(di))), packet(writerTip("B"), center(rowBox(ri)))]);
      if (my !== epoch) return;
      await fade([doc, row]);
      end(my);
    }

    async function shipV2() {
      if (busy || m.version === "v2") return;
      m.version = "v2";
      m.migrated = m.rows.length;
      m.rows.forEach(r => { [r.first, r.last] = r.name.split(" "); });   // every row is v1 at ship time
      m.banner = "done";
      changed("ship");
      const my = begin();
      draw();
      syncInfo();   // the note explains the migration while it plays
      // Lane A: only the app code changes. Lane B: ALTER (instant), then the row-by-row backfill.
      view.rowEls.forEach(r => { setCell(r.first, null); setCell(r.last, null); });
      setBanner("alter");
      view.stats.set("migrated", 0, "");
      await Promise.all([
        fade([view.headExtra, ...view.rowEls.map(r => r.extra), view.banner], 400),
        fade([view.writerA.label, view.readerA.label, view.code.l1, view.code.l2], 400),
      ]);
      await ctx.sleep(200);
      for (let k = 0; k < view.rowEls.length; k++) {
        if (my !== epoch) return;
        const r = view.rowEls[k], src = m.rows[k];
        setBanner("backfill", k + 1);
        setCell(r.first, src.first, WARN);
        setCell(r.last, src.last, WARN);
        await ctx.sleep(300);
        if (my !== epoch) return;
        setCell(r.first, src.first, OK);
        setCell(r.last, src.last, OK);
        view.stats.set("migrated", k + 1, "info");
      }
      setBanner("done");
      await fade([view.banner]);
      end(my);
    }

    async function typoWrite() {
      if (busy || m.version !== "v2" || m.typoUsed || m.docs.length >= CAP) return;
      const prevBanner = m.banner;
      m.typoUsed = true;
      m.rejected = 1;
      m.docs.push({ frist_name: "Tony", last_name: "Hoare" });   // no row: the INSERT fails
      m.banner = "error";
      changed("typo");
      const my = begin(), di = m.docs.length - 1;
      draw();
      setBanner(prevBanner);
      const doc = view.docEls[di].g;
      doc.setAttribute("opacity", 0);
      const target = center(cellBox(m.rows.length, 1));
      await Promise.all([
        packet(writerTip("A"), center(docBox(di))).then(() => my === epoch && fade([doc])),
        packet(writerTip("B"), target, 0.85).then(() => {
          if (my !== epoch) return;
          setBanner("error");
          return fade([view.banner]);
        }),
      ]);
      end(my);
    }

    function toggleFix(v) {
      if (busy) return;
      m.legacyFix = v;
      changed("toggle");
      draw();
      syncInfo();
    }

    async function runReader() {
      if (busy) return;
      m.read = m.docs.map(readDoc);   // the table reader always reads a column that exists
      m.note = "read";
      const my = begin(), n = m.docs.length;
      draw(true);
      for (let i = 0; i < n; i++) {
        const marks = [outline(docBox(i), 3, { rx: 10, stroke: INFO, width: 2.5 })];
        if (i < m.rows.length) {
          marks.push(outline(cellBox(i, readCol()), -1, { fill: "var(--viz-info-soft)" }));
          marks.push(outline(rowBox(i), 1.5, { rx: 4, stroke: INFO, width: 2.5 }));
        }
        await ctx.sleep(250);
        if (my !== epoch) return;
        marks.forEach(el => el.remove());
        showDocRead(i);
        if (i < m.rows.length) showRowRead(i);
      }
      end(my);
    }

    function reset() {
      epoch++;
      busy = false;
      m = fresh();
      view.fix.set(false);
      draw();
      syncControls();
      syncInfo();
    }

    // ---------------------------------------------------------------- build
    function build() {
      epoch++;          // abandon any animation; the model already holds its end state
      busy = false;
      compact = ctx.compact;
      root.innerHTML = "";
      const L = layout(compact);
      const svg = ctx.svg({ w: L.W, h: L.H, label: "The same users stored in a document store and in a relational table" });
      const layers = { base: s("g"), docs: s("g"), table: s("g"), marks: s("g"), fx: s("g") };
      svg.append(...Object.values(layers));
      const btn = {
        write: ui.button("+ Write user", () => writeUser(), { kind: "primary" }),
        ship: ui.button("Ship v2 (split name)", () => shipV2()),
        typo: ui.button("+ Buggy write (typo)", () => typoWrite()),
        read: ui.button("▶ Run reader", () => runReader()),
        reset: ui.button("Reset", () => reset(), { kind: "ghost" }),
      };
      const fix = ui.toggle({ label: "Reader handles old {name} docs", value: m.legacyFix, onChange: toggleFix });
      const stats = ui.stats([
        { key: "shapes", label: "Shapes in doc store", value: 1 },
        { key: "docErrors", label: "Doc reader errors", value: "–" },
        { key: "migrated", label: "Rows rewritten by migration", value: 0 },
        { key: "rejected", label: "SQL writes rejected", value: 0 },
      ]);
      const legend = ui.legend([
        { color: KEY, label: "document", shape: "square" },
        { color: OK, label: "read fine", shape: "dot" },
        { color: BAD, label: "error", shape: "dot" },
        { color: WARN, label: "accepted but suspicious / migrating", shape: "dot" },
      ]);
      const note = ui.note("");
      root.append(ui.bar(btn.write, btn.ship, btn.typo), ui.bar(fix, btn.read, btn.reset), svg, legend, stats, note);
      view = { L, svg, ...layers, btn, fix, stats, note };
      drawStatic();
      draw();
      syncControls();
      syncInfo();
    }

    build();
    // Rebuild for the other layout when the frame crosses the phone breakpoint (deferred so the
    // rebuild's own size change doesn't happen inside the ResizeObserver callback).
    let rebuildQueued = false;
    ctx.onResize(() => {
      if (ctx.compact === compact || rebuildQueued) return;
      rebuildQueued = true;
      ctx.after(0, () => { rebuildQueued = false; if (ctx.compact !== compact) build(); });
    });
  },
});
