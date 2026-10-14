// Embed or reference? The same six profiles stored as documents (left) and as normalized
// relational tables (right). Load a profile, rename an employer (optionally crashing the
// writer halfway) or ask the reverse question, and compare the work each model does.
Viz.register("ch2/normalize-or-embed", {
  title: "Embed or reference?",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const OLD = "Acme Corp", NEW = "Acme Inc";
    const ORG_IDS = ["o1", "o2", "o3"], ORG_NAMES = [OLD, "Globex", "Initech"];
    const USERS = [ // name, positions as [org index, start year]
      ["Ana", [[0, 2019], [1, 2015]]], ["Ben", [[0, 2021]]], ["Chen", [[2, 2016], [0, 2020]]],
      ["Dee", [[1, 2018]]], ["Eli", [[0, 2017], [2, 2022]]], ["Fay", [[1, 2014], [2, 2019]]],
    ];
    const POS = USERS.flatMap(([, ps], u) => ps.map(([o]) => ({ u, o })));  // positions table rows
    const acmeK = u => USERS[u][1].findIndex(([o]) => o === 0);           // u's Acme position, or -1
    const ACME_USERS = USERS.map((_, u) => u).filter(u => acmeK(u) >= 0); // Ana, Ben, Chen, Eli
    const ACME = "var(--viz-c1)", MUTED = "var(--viz-muted)", BAD = "var(--viz-bad)";
    const NODE = { stroke: "var(--viz-node-stroke)", sw: 1.2, fill: "var(--viz-node)" };
    const BARE = { stroke: "none", sw: 0, fill: "none" };

    // State lives outside buildScene() so a phone <-> desktop rebuild keeps it.
    let op = "load", design = "embed", crash = false;
    let docNames, refNames, sqlNames;   // embedded copies per profile; org names per store
    let hl = {}, links = [], crashAt = -1, showIndex = false;   // marks left by the last run
    let cost = null, runId = 0, running = false, fast = false, view = null;

    const LAYOUTS = {
      wide: {
        W: 640, H: 336, fs: 12, left: 12, right: 310, titleY: 18, labelY: 36,
        strip: { y: 44, w: 95, h: 32, step: 101.5 },
        card: { xs: [12, 164], ys: [100, 178, 256], w: 146, h: 72, pad: 10, name: 17, lines: [39, 57], crash: 13 },
        divider: [320, 8, 320, 328],
        rel: { x: 330, r: 632, y: 18 }, tables: { user: [330, 68], pos: [420, 86], org: [528, 104] },
        tTitle: 36, head: 46, row0: 68, cols: { user: [8, 30], org: [8, 30] }, idxY: 302,
      },
      phone: {
        W: 360, H: 580, fs: 11, left: 8, right: 352, titleY: 18, labelY: 36,
        strip: { y: 44, w: 110, h: 32, step: 117 },
        card: { xs: [8, 125, 242], ys: [100, 176], w: 110, h: 70, pad: 8, name: 16, lines: [36, 54], crash: 12 },
        divider: [8, 262, 352, 262],
        rel: { x: 8, r: 352, y: 280 }, tables: { user: [8, 70], pos: [100, 96], org: [218, 134] },
        tTitle: 300, head: 310, row0: 332, cols: { user: [7, 27], org: [8, 30] }, idxY: 568,
      },
    };
    const TABLES = [
      ["user", "users", ["id", "name"], USERS.length],
      ["pos", "positions", ["user → org"], POS.length],
      ["org", "organizations", ["id", "name"], ORG_IDS.length],
    ];

    // ---------------------------------------------------------------- data
    function resetData() {
      docNames = USERS.map(([, ps]) => ps.map(([o]) => ORG_NAMES[o]));
      refNames = ORG_NAMES.slice();
      sqlNames = ORG_NAMES.slice();
    }
    const acmeCopy = u => docNames[u][acmeK(u)];
    // Copies still saying the old name while another copy already says the new one.
    function staleCount() {
      if (design !== "embed") return 0;
      const copies = ACME_USERS.map(acmeCopy);
      return copies.includes(NEW) ? copies.filter(n => n === OLD).length : 0;
    }
    const isStale = u => acmeK(u) >= 0 && acmeCopy(u) === OLD && staleCount() > 0;
    const needsRename = () => sqlNames[0] === OLD ||
      (design === "embed" ? ACME_USERS.some(u => acmeCopy(u) === OLD) : refNames[0] === OLD);

    // ---------------------------------------------------------------- drawing
    const T = (x, y, str, o = {}) => ctx.text(x, y, str, { anchor: "start", size: view.L.fs, ...o });
    function setParts(t, parts) {   // parts: [text, fill, mono, weight]
      t.replaceChildren(...parts.map(([str, fill, mono, weight]) =>
        s("tspan", { fill, class: mono ? "viz-mono" : null, "font-weight": weight }, str)));
    }
    const nameParts = (name, o, stale) =>
      [[name, stale ? BAD : o ? undefined : ACME, false, o ? undefined : 600]];
    const idPart = o => [ORG_IDS[o], o ? undefined : ACME, true, o ? undefined : 600];

    function cardParts(u, k, o, yr) {
      const when = view.compact ? " · '" + String(yr).slice(2) : " · " + yr;
      if (design === "ref") return [["org: ", MUTED, true], idPart(o), [when, MUTED]];
      return [...nameParts(docNames[u][k], o, o === 0 && isStale(u)), [when, MUTED]];
    }

    function buildScene() {
      const L = LAYOUTS[ctx.compact ? "phone" : "wide"];
      const svg = ctx.svg({ w: L.W, h: L.H, label: "Six user profiles stored as documents and as three normalized relational tables" });
      const base = s("g"), linkLayer = s("g"), overlay = s("g");
      svg.append(base, linkLayer, overlay);
      view = { L, compact: ctx.compact, els: {}, linkLayer, overlay };
      const [x1, y1, x2, y2] = L.divider;
      base.append(s("line", { x1, y1, x2, y2, stroke: "var(--viz-line)" }));
      buildDocs(base, L);
      buildTables(base, L);
      sceneHost.replaceChildren(svg);
      refreshTexts();
      redrawMarks();
    }

    function buildDocs(g, L) {
      const E = view.els, c = L.card, st = L.strip;
      g.append(
        T(L.left, L.titleY, "Document model", { size: 13, weight: 700 }),
        T(L.right, L.titleY, design === "embed" ? "embedded names" : "references (org ids)", { anchor: "end", fill: MUTED }),
        T(L.left, L.labelY, "organizations", { fill: MUTED }));
      if (design === "ref") {
        ORG_IDS.forEach((_, o) => {
          const x = L.left + o * st.step;
          const rect = s("rect", { x, y: st.y, width: st.w, height: st.h, rx: 6 });
          const text = T(x + st.w / 2, st.y + st.h / 2, "", { anchor: "middle" });
          g.append(rect, text);
          E["dorg:" + o] = { rect, text, x, base: NODE };
        });
      } else {
        g.append(
          s("rect", { x: L.left, y: st.y, width: L.right - L.left, height: st.h, rx: 6, fill: "none", stroke: "var(--viz-line)", "stroke-dasharray": "5 4" }),
          T((L.left + L.right) / 2, st.y + st.h / 2, "none: names are copied into each profile", { anchor: "middle", fill: MUTED }));
      }
      USERS.forEach(([name, ps], u) => {
        const x = c.xs[u % c.xs.length], y = c.ys[Math.floor(u / c.xs.length)];
        const rect = s("rect", { x, y, width: c.w, height: c.h, rx: 8 });
        const lines = ps.map((_, k) => T(x + c.pad, y + c.lines[k], ""));
        g.append(rect, T(x + c.pad, y + c.name, name, { size: L.fs + 1, weight: 700 }), ...lines);
        E["card:" + u] = { rect, lines, x, y, base: NODE };
      });
    }

    function buildTables(g, L) {
      g.append(
        T(L.rel.x, L.rel.y, "Relational model", { size: 13, weight: 700 }),
        T(L.rel.r, L.rel.y, "normalized: 3 tables", { anchor: "end", fill: MUTED }));
      TABLES.forEach(([key, title, head, n]) => {
        const [x, w] = L.tables[key], y0 = L.head, cols = L.cols[key] || [w / 2];
        const anchor = L.cols[key] ? "start" : "middle", r = 4;
        g.append(T(x, L.tTitle, title, { weight: 700 }), s("path", {
          d: `M${x},${y0 + 22}V${y0 + r}Q${x},${y0} ${x + r},${y0}H${x + w - r}Q${x + w},${y0} ${x + w},${y0 + r}V${y0 + 22}Z`,
          fill: "var(--viz-panel)",
        }));
        head.forEach((txt, i) => g.append(T(x + cols[i], y0 + 11, txt, { weight: 700, anchor })));
        for (let i = 0; i < n; i++) {
          const y = L.row0 + i * 22;
          g.append(s("line", { x1: x, x2: x + w, y1: y, y2: y, stroke: i ? "var(--viz-grid)" : "var(--viz-node-stroke)" }));
          const rect = s("rect", { x: x + 2, y: y + 2, width: w - 4, height: 18, rx: 3 });
          const cells = cols.map(dx => T(x + dx, y + 11, "", { anchor }));
          g.append(rect, ...cells);
          view.els[key + ":" + i] = { rect, cells, base: BARE };
        }
        g.append(s("rect", { x, y: y0, width: w, height: 22 * (n + 1), rx: r, fill: "none", stroke: "var(--viz-node-stroke)", "stroke-width": 1.2 }));
      });
    }

    function refreshTexts() {
      const E = view.els;
      USERS.forEach(([name, ps], u) => {
        ps.forEach(([o, yr], k) => setParts(E["card:" + u].lines[k], cardParts(u, k, o, yr)));
        setParts(E["user:" + u].cells[0], [["u" + (u + 1), undefined, true]]);
        setParts(E["user:" + u].cells[1], [[name]]);
      });
      POS.forEach(({ u, o }, j) => setParts(E["pos:" + j].cells[0], [["u" + (u + 1), undefined, true], [" → ", MUTED], idPart(o)]));
      ORG_IDS.forEach((id, o) => {
        if (E["dorg:" + o]) setParts(E["dorg:" + o].text, [[id + " ", MUTED, true], ...nameParts(refNames[o], o)]);
        setParts(E["org:" + o].cells[0], [[id, undefined, true]]);
        setParts(E["org:" + o].cells[1], nameParts(sqlNames[o], o));
      });
    }

    // A record's look: its highlight from the current run, else red if it is a stale copy.
    function paint(key) {
      const el = view.els[key];
      if (!el) return;
      let t = hl[key];
      if (!t && key.startsWith("card:") && isStale(+key.slice(5))) t = "bad";
      const st = el.rect.style, b = el.base;
      st.stroke = t ? `var(--viz-${t})` : b.stroke;
      st.strokeWidth = (t ? 2.5 : b.sw) + "px";
      st.fill = t && t !== "info" ? `var(--viz-${t}-soft)` : b.fill;   // reads: outline only
    }
    const repaintAll = () => Object.keys(view.els).forEach(paint);
    function mark(key, tone) { hl[key] = tone; paint(key); }

    function rowEdge(key, right) {
      const [t, i] = key.split(":"), [x, w] = view.L.tables[t];
      return [right ? x + w : x, view.L.row0 + Number(i) * 22 + 11];
    }
    // Dashed join curve. ["doc", user, k, org] links a profile card to an org box (vertical);
    // [leftRow, rightRow] links rows of neighbouring tables across the gap between them.
    function linkEl(lk) {
      const { L, els } = view;
      let p, q;
      const vertical = lk[0] === "doc";   // card -> org box, else row -> row
      if (vertical) {
        const card = els["card:" + lk[1]], box = els["dorg:" + lk[3]];
        if (!box) return null;
        p = [card.x + L.card.w * (lk[2] ? 0.72 : 0.36), card.y];
        q = [box.x + L.strip.w / 2, L.strip.y + L.strip.h];
      } else {
        p = rowEdge(lk[0], true);
        q = rowEdge(lk[1], false);
      }
      const [x1, y1] = p, [x2, y2] = q, mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const d = vertical ? `M${x1},${y1}C${x1},${my} ${x2},${my} ${x2},${y2}` : `M${x1},${y1}C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
      const g = s("g");
      g.append(s("path", { d, fill: "none", stroke: "var(--viz-c2)", "stroke-width": 1.5, "stroke-dasharray": "4 3" }),
        ...[p, q].map(([cx, cy]) => s("circle", { cx, cy, r: 2.5, fill: "var(--viz-c2)" })));
      return g;
    }
    function addLink(lk) {
      links.push(lk);
      view.linkLayer.append(...[linkEl(lk)].filter(Boolean));
    }
    function drawOverlay() {
      const { L, els, overlay } = view;
      overlay.replaceChildren();
      if (crashAt >= 0) {
        const c = els["card:" + crashAt];
        overlay.append(T(c.x + L.card.w - L.card.pad, c.y + L.card.name, "✕ crash", { anchor: "end", size: L.card.crash, weight: 700, fill: BAD }));
      }
      if (showIndex) {
        const [x, w] = L.tables.pos;
        overlay.append(T(x + w / 2, L.idxY, "↑ index on org_id", { anchor: "middle", weight: 600, fill: "var(--viz-info)" }));
      }
    }
    function redrawMarks() {
      view.linkLayer.replaceChildren(...links.map(linkEl).filter(Boolean));
      drawOverlay();
      repaintAll();
    }
    function clearMarks() {
      hl = {}; links = []; crashAt = -1; showIndex = false;
      if (view) redrawMarks();
    }

    // ---------------------------------------------------------------- stats
    const statsEl = ui.stats([
      { key: "trips", label: "Doc round trips" },
      { key: "doc", label: "Docs read / written" },
      { key: "sql", label: "SQL rows read / written" },
      { key: "stale", label: "Stale copies of the name", value: 0, tone: "ok" },
    ]);
    // Keep values bottom-aligned when a label wraps onto two lines.
    Array.from(statsEl.children).forEach(c => Object.assign(c.style, { display: "flex", flexDirection: "column", justifyContent: "space-between" }));
    function showCost() {
      statsEl.set("trips", cost ? cost.trips : "–");
      statsEl.set("doc", cost ? `${cost.dr} / ${cost.dw}` : "–");
      statsEl.set("sql", cost ? `${cost.sr} / ${cost.sw}` : "–");
    }
    const bump = (k, n = 1) => { cost[k] += n; showCost(); };
    const trips = n => { cost.trips = n; showCost(); };
    const updateStale = () => { const n = staleCount(); statsEl.set("stale", n, n ? "bad" : "ok"); };

    // ---------------------------------------------------------------- operations
    // Each side animates in parallel; every await is followed by a liveness check so a
    // control change (which bumps runId) stops the run cleanly.
    const isLive = my => ctx.alive && my === runId;
    const wait = ms => (fast ? Promise.resolve() : ctx.sleep(ms));
    // Highlights one record, pauses, and reports whether this run is still current.
    async function hit(my, key, tone, ms = 300) { mark(key, tone); await wait(ms); return isLive(my); }
    // In-place rename of one record: amber while writing, then green.
    async function write(my, key, apply) {
      if (!await hit(my, key, "warn")) return false;
      apply();
      refreshTexts();
      mark(key, "ok");
      repaintAll();
      return true;
    }

    const DOC = {
      async load(my) {
        trips(1); bump("dr");
        if (!await hit(my, "card:0", "info") || design === "embed") return;
        trips(2);   // one batched lookup for both referenced orgs
        for (const [k, [o]] of USERS[0][1].entries()) {
          addLink(["doc", 0, k, o]); bump("dr");
          if (!await hit(my, "dorg:" + o, "info")) return;
        }
      },
      async rename(my, out) {
        trips(1);
        if (design === "ref") {
          bump("dr");
          if (refNames[0] === NEW) { await hit(my, "dorg:0", "info"); return; }   // nothing left to rename
          if (await write(my, "dorg:0", () => { refNames[0] = NEW; })) bump("dw");
          return;
        }
        // No index on the embedded name in this demo, so the update scans every profile.
        for (let u = 0; u < USERS.length; u++) {
          bump("dr");
          if (!await hit(my, "card:" + u, "info", 250)) return;
        }
        const todo = ACME_USERS.filter(u => acmeCopy(u) === OLD);
        out.total = todo.length; out.writes = 0;
        for (const u of todo) {
          if (crash && out.writes === 2) {   // the writer dies right after its 2nd write
            out.crashed = true;
            crashAt = u;
            drawOverlay();
            todo.slice(2).forEach(v => mark("card:" + v, "bad"));
            return;
          }
          if (!await write(my, "card:" + u, () => { docNames[u][acmeK(u)] = NEW; })) return;
          out.writes++; bump("dw"); updateStale();
          await wait(200);
          if (!isLive(my)) return;
        }
      },
      async reverse(my, out) {
        trips(1);
        if (design === "ref") {   // look up Acme's id by name first
          bump("dr");
          if (!await hit(my, "dorg:0", "info")) return;
          trips(2);
        }
        // The app searches for the current name; after a half-done rename that misses copies.
        const target = staleCount() ? NEW : acmeCopy(0);
        for (let u = 0; u < USERS.length; u++) {
          bump("dr");
          if (!await hit(my, "card:" + u, "info", 250)) return;
        }
        out.found = ACME_USERS.filter(u => design === "ref" || acmeCopy(u) === target);
        out.missed = ACME_USERS.filter(u => !out.found.includes(u));
        out.target = target;
        out.found.forEach(u => mark("card:" + u, "ok"));
        out.missed.forEach(u => mark("card:" + u, "bad"));
      },
    };

    const SQL = {
      async load(my) {
        bump("sr");
        if (!await hit(my, "user:0", "info")) return;
        const rows = POS.map((p, j) => j).filter(j => POS[j].u === 0);
        for (const j of rows) {
          addLink(["user:0", "pos:" + j]); bump("sr");
          if (!await hit(my, "pos:" + j, "info")) return;
        }
        for (const j of rows) {
          addLink(["pos:" + j, "org:" + POS[j].o]); bump("sr");
          if (!await hit(my, "org:" + POS[j].o, "info")) return;
        }
      },
      async rename(my, out) {
        bump("sr");
        // A repeat run (after a crash on the document side) finds the row already renamed:
        // UPDATE ... WHERE name = 'Acme Corp' matches nothing, so there's nothing to write.
        if (sqlNames[0] === NEW) { out.sqlNoop = true; await hit(my, "org:0", "info"); return; }
        if (await write(my, "org:0", () => { sqlNames[0] = NEW; })) bump("sw");
      },
      async reverse(my) {
        showIndex = true; drawOverlay();
        bump("sr");
        if (!await hit(my, "org:0", "info")) return;
        const rows = POS.map((p, j) => j).filter(j => POS[j].o === 0);
        for (const j of rows) {
          addLink(["pos:" + j, "org:0"]); bump("sr");
          if (!await hit(my, "pos:" + j, "ok")) return;
        }
        for (const j of rows) {
          addLink(["user:" + POS[j].u, "pos:" + j]); bump("sr");
          if (!await hit(my, "user:" + POS[j].u, "ok")) return;
        }
      },
    };

    async function run() {
      if (running) return;
      const my = ++runId;
      clearMarks();
      if (op === "rename" && !needsRename()) {
        cost = null; showCost();
        note.set("Already renamed. Press <b>Reset data</b> to try again.", "info");
        return;
      }
      setRunning(true);
      cost = { trips: 0, dr: 0, dw: 0, sr: 0, sw: 0 }; showCost();
      note.set(op === "rename" && design === "embed" ? "Rewriting every copy of Acme's name… Watch the stale " +
        "counter: until the last copy is rewritten, readers can see both names." : RUNNING[op], "info");
      const out = {};
      await Promise.all([DOC[op](my, out), SQL[op](my, out)]);
      if (!isLive(my)) return;
      updateStale();
      note.set(...resultNote(out));
      setRunning(false);
    }
    function setRunning(on) { running = on; runBtn.disable(on); }
    // Stops any run and clears its marks and costs; data stays. Returns a note prefix.
    function interrupt() {
      const was = running;
      runId++;
      setRunning(false);
      clearMarks();
      cost = null; showCost();
      updateStale();
      const n = staleCount();
      return was && n ? `The interrupted rename left ${n} stale ${n === 1 ? "copy" : "copies"}. ` : "";
    }

    // ---------------------------------------------------------------- notes
    const list = a => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
    const people = us => list(us.map(u => USERS[u][0]));
    const RUNNING = {
      load: "Loading Ana's profile from both models…",
      rename: "Renaming Acme Corp to Acme Inc in both models…",
      reverse: "Finding everyone who worked at Acme, in both models…",
    };
    const DESIGN_NOTE = {
      embed: "Each profile now embeds its own copy of every employer's <b>name</b>. ",
      ref: "Each profile now stores org <b>ids</b>; the names live once in an <b>organizations</b> collection. ",
    };
    function hint() {
      const base = {
        load: "Press <b>▶ Run</b> to load Ana's profile from both models.",
        rename: "Press <b>▶ Run</b> to rename Acme Corp to <b>Acme Inc</b> in both models.",
        reverse: "Press <b>▶ Run</b> to find everyone who worked at Acme, in both models.",
      }[op];
      if (op !== "rename") return base + (crash ? " (<b>Crash mid-write</b> only affects <b>Rename Acme</b>.)" : "");
      return base + (crash ? " <b>Crash mid-write</b> is on: the writer dies right after its 2nd write."
        : " Turn on <b>Crash mid-write</b> to kill the writer partway through.");
    }
    const REVERSE = "Profiles are trees rooted at a user, so the reverse question (org → people) scans every profile: " +
      "6 here, every user in production, unless you add an index on the embedded field (document databases support " +
      "these, but you have to plan for them). The relational version follows an index on " +
      "<span class=\"mono\">positions.org_id</span>: work proportional to the 4 matches.";
    const ONCE = "The name is stored once and everything points to it by id, so the rename is a single write and " +
      "can't be half-done. Every profile shows the new name on its next read. That's what <b>normalization</b> buys.";

    function resultNote(out) {
      if (op === "load") {
        return [design === "embed"
          ? "Ana's whole profile is one document: one read, no joins. That's <b>locality</b>. The relational schema " +
            "stores the same profile as 5 rows in 3 tables that the database joins for you. Now try <b>Rename Acme</b>."
          : "With references, the profile holds org ids, so your code makes a second request for the organizations: " +
            "an <b>application-side join</b>. It's the relational join, moved into your app (today MongoDB's " +
            "<span class=\"mono\">$lookup</span> can also run it inside the database).", "info"];
      }
      if (op === "rename") {
        if (design === "ref") return [ONCE + (crash ? " The crash had nothing to break: with one write there's no halfway state." : ""), "ok"];
        if (out.crashed) {
          const done = ACME_USERS.filter(u => acmeCopy(u) === NEW), left = ACME_USERS.filter(u => acmeCopy(u) === OLD);
          return [`The writer died after ${out.writes} of ${out.total} rewrites. ${people(done)} now show 'Acme Inc'; ` +
            `${people(left)} still show 'Acme Corp'. The copies disagree: an <b>update anomaly</b>. A multi-document ` +
            "update isn't atomic unless you wrap it in a transaction. Try <b>Who worked at Acme?</b> now, or run the " +
            "rename again to finish the job.", "bad"];
        }
        if (out.total === ACME_USERS.length) {
          return ["One fact, Acme's name, was stored 4 times, so the rename read all 6 profiles and rewrote 4, while " +
            `the relational side ${out.sqlNoop ? "already had the new name" : "updated 1 row"}. Until the last write ` +
            "landed, readers could see both names. With 50 million profiles that's a 50-million-document hunt (or an " +
            "index you must maintain).", "warn"];
        }
        const n = out.total;
        return [`This run found the ${n} ${n === 1 ? "copy" : "copies"} still saying 'Acme Corp' and rewrote ` +
          `${n === 1 ? "it" : "them"}, so the copies agree again. Nothing did that for you: duplicated data needs a ` +
          "sync mechanism (a retry, a background job) or a transaction around the multi-document update." +
          (out.sqlNoop ? " The relational row was renamed by the first run, so this time it had nothing to write." : ""), "ok"];
      }
      if (out.missed.length) {
        return [`The app searched for '${out.target}' and found only ${people(out.found)}: ${people(out.missed)}'s ` +
          "copies still say 'Acme Corp', so the query silently misses them. The relational query looks the name up " +
          "once and follows id o1 to all 4. Run <b>Rename Acme</b> again to repair the copies.", "bad"];
      }
      return [(design === "ref" ? "The org lookup is cheap; finding the profiles that point to it is the scan. " : "") + REVERSE, "info"];
    }

    // ---------------------------------------------------------------- controls
    const opSeg = ui.segmented({
      label: "Operation", value: op,
      options: [
        { value: "load", label: "Load Ana's profile" },
        { value: "rename", label: "Rename Acme" },
        { value: "reverse", label: "Who worked at Acme?" },
      ],
      onChange: v => { op = v; const pre = interrupt(); note.set(pre + hint(), pre ? "bad" : "info"); },
    });
    const designSeg = ui.segmented({
      label: "Document design", value: design,
      options: [{ value: "embed", label: "Embed names" }, { value: "ref", label: "Reference ids" }],
      onChange: v => {
        design = v; interrupt(); resetData(); buildScene(); updateStale();
        note.set(DESIGN_NOTE[v] + hint(), "info");
      },
    });
    const crashToggle = ui.toggle({
      label: "Crash mid-write", value: crash,
      onChange: v => { crash = v; const pre = interrupt(); note.set(pre + hint(), pre ? "bad" : "info"); },
    });
    const runBtn = ui.button("▶ Run", () => run(), { kind: "primary" });
    const resetBtn = ui.button("Reset data", () => {
      interrupt(); resetData(); refreshTexts(); repaintAll(); updateStale();
      note.set("Data reset: every record says 'Acme Corp' again. " + hint(), "info");
    }, { kind: "ghost" });

    const sceneHost = h("div");
    const note = ui.note("", "info");
    root.append(
      ui.bar(opSeg, designSeg),
      ui.bar(crashToggle, runBtn, resetBtn),
      sceneHost,
      ui.legend([
        { color: "var(--viz-info)", label: "read" },
        { color: "var(--viz-warn)", label: "writing" },
        { color: "var(--viz-ok)", label: "written / matched" },
        { color: BAD, label: "stale / crashed" },
        { color: "var(--viz-c2)", label: "join", shape: "dash" },
        { color: ACME, label: "Acme's name or id", shape: "square" },
      ]),
      statsEl,
      note,
    );

    resetData();
    buildScene();
    // First frame: the load result, drawn instantly.
    fast = true;
    run().then(() => { fast = false; });
    ctx.onResize(() => { if (ctx.compact !== view.compact) buildScene(); });
  },
});
