// MVCC snapshots: DDIA's Alice example (T12 audit, T13 transfer, T14 phone-app read) over a table
// of row versions tagged created_by / deleted_by. One visibility function decides every read, so
// the same history gives a dirty read (read uncommitted), read skew (read committed) or a
// consistent $1,000 (snapshot isolation). Readers take no locks, so no writer ever waits for one.
Viz.register("ch7/mvcc-snapshots", {
  title: "MVCC snapshots",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const cfg = { level: "rc", end: "commit" };
    const TX = [
      { id: 12, name: "T12 audit", does: "reads acct 1, later acct 2", color: "c6" },
      { id: 13, name: "T13 transfer", does: "moves $100: acct 2 to acct 1", color: "c5" },
      { id: 14, name: "T14 phone app", does: "reads acct 2 once", color: "c6" },
    ];
    const BADGE = { "not started": "muted", active: "warn", committed: "ok", aborted: "bad" };
    const INK = { committed: "var(--viz-ink)", active: "var(--viz-warn)", aborted: "var(--viz-bad)" };
    const BAR = { committed: "var(--viz-ok)", active: "var(--viz-warn)", aborted: "var(--viz-bad)" };
    const DESK = {
      W: 640, H: 320,
      pill: { x: 10, w: 230, h: 62, ys: [36, 104, 172], l1: 16, l2: 35, l3: 52 },
      titles: [[10, 20, "Transactions"], [258, 20, "accounts: row versions"]],
      tbl: { x: 258, w: 372, head: 46, top: 60, rowH: 34, gap: 8 },
      cols: { id: 270, bal: 300, cb: 372, db: 470, sees: 604 },
      why: "reasons",   // under the table: per-version reasons during a read, else the rule
      strip: { x: 10, y: 262, w: 620, h: 48 },
    };
    const PHONE = {
      W: 360, H: 470,
      pill: { x: 10, w: 340, h: 58, ys: [10, 74, 138], l1: 15, l2: 33, l3: 49 },
      titles: [[10, 214, "accounts: row versions"]],
      tbl: { x: 10, w: 340, head: 234, top: 246, rowH: 32, gap: 6 },
      cols: { id: 22, bal: 50, cb: 130, db: 214, sees: 318 },
      why: "rule",   // phones get the rule only (when it fits); reasons go to the log
      strip: { x: 10, y: 386, w: 340, h: 76 },
    };
    let G = null, view = null, compact = ctx.compact;

    const usd = n => "$" + n.toLocaleString("en-US");
    const key = v => v.id + "/" + v.cb;
    const tag = v => `v(${v.id},$${v.bal})`;
    const running = st => Object.keys(st.tx).map(Number).filter(t => st.tx[t] === "active");
    const total = st => (st.saw[1] != null && st.saw[2] != null ? st.saw[1] + st.saw[2] : null);
    const markFill = m => (!m.ok ? "var(--viz-muted)" : m.dirty ? "var(--viz-bad)" : "var(--viz-ok)");

    // ---------- the visibility rule ----------
    // Can `reader` see writes by transaction c? -> [visible, phrase that completes "txid c ..."]
    function sees(st, reader, c) {
      const state = st.tx[c], R = "T" + reader;
      if (state === "aborted") return [false, "aborted"];
      if (cfg.level === "ru") return [true, state === "committed" ? "committed" : "is uncommitted, used anyway"];
      if (cfg.level === "rc") return state === "committed" ? [true, "committed before this statement"] : [false, "has not committed"];
      if (c > reader) return [false, `is later than ${R}'s snapshot`];
      if (st.snap[reader].includes(c)) return [false, `was running at ${R}'s snapshot`];
      return state === "committed" ? [true, `committed before ${R} began`] : [false, "has not committed"];
    }
    // A version is visible if its creator is visible and its deleter (if any) is not.
    function judge(st, reader, v) {
      const [cOk, cWhy] = sees(st, reader, v.cb);
      const head = `${tag(v)} by ${v.cb}: txid ${v.cb} ${cWhy}`;
      if (!cOk || !v.db) return { ok: cOk, short: `${tag(v)}: txid ${v.cb} ${cWhy}`, long: head };
      const [dOk, dWhy] = sees(st, reader, v.db);
      return dOk
        ? { ok: false, short: `${tag(v)}: deleter ${v.db} ${dWhy}`, long: `${head}, but its deleter ${v.db} ${dWhy}` }
        : { ok: true, short: `${tag(v)}: deleter ${v.db} ${dWhy}, still counts`,
            long: `${head}; its deleter ${v.db} ${dWhy}, so the deletion is invisible and it still counts` };
    }

    // ---------- controls ----------
    const levelSeg = ui.segmented({
      label: "Isolation level", value: cfg.level,
      options: [{ value: "ru", label: "Read uncommitted" }, { value: "rc", label: "Read committed" }, { value: "si", label: "Snapshot isolation" }],
      onChange: v => { cfg.level = v; player.reset(); },
    });
    const endSeg = ui.segmented({
      label: "T13 ends with", value: cfg.end,
      options: [{ value: "commit", label: "Commit" }, { value: "abort", label: "Abort" }],
      onChange: v => { cfg.end = v; player.reset(); },
    });
    const stats = ui.stats([
      { key: "total", label: "T12 total", value: "–" },
      { key: "versions", label: "Row versions stored", value: "2" },
      { key: "anomaly", label: "Anomaly", value: "none" },
      { key: "wait", label: "Writer waited for a reader?", value: "–" },
    ]);
    const note = ui.note("");
    const log = ui.log({ title: "Visibility decisions", height: 120 });
    const holder = h("div");

    // ---------- scene ----------
    function buildScene() {
      compact = ctx.compact;
      G = compact ? PHONE : DESK;
      const svg = ctx.svg({ w: G.W, h: G.H, label: "Three transactions next to the accounts table, which stores every row version with the txids that created and deleted it" });
      const statics = s("g"), pills = s("g"), rows = s("g"), why = s("g"), strip = s("g"), fx = s("g");
      svg.append(statics, pills, rows, why, strip, fx);
      const muted = { size: 12, anchor: "start", fill: "var(--viz-muted)" };
      G.titles.forEach(([x, y, t]) => statics.appendChild(ctx.text(x, y, t, { ...muted, weight: 700 })));
      const C = G.cols, hy = G.tbl.head;
      [["id", C.id], ["balance", C.bal], ["created_by", C.cb], ["deleted_by", C.db]].forEach(([t, x]) =>
        statics.appendChild(ctx.text(x, hy, t, muted)));
      const seesHead = ctx.text(C.sees, hy, "sees", { size: 12, fill: "var(--viz-muted)" });
      statics.appendChild(seesHead);
      view = { svg, pills, rows, why, strip, fx, seesHead, rowEls: new Map() };
      holder.replaceChildren(svg);
    }

    function badge(layer, xr, y, state) {
      const tone = BADGE[state], w = state.length * 6.6 + 16, muted = tone === "muted";
      const col = muted ? "var(--viz-muted)" : `var(--viz-${tone})`;
      const fill = muted ? "var(--viz-node)" : `var(--viz-${tone}-soft)`, stroke = muted ? "var(--viz-node-stroke)" : col;
      layer.append(
        s("rect", { x: xr - w, y: y - 9, width: w, height: 18, rx: 9, fill, stroke }),
        ctx.text(xr - w / 2, y + 0.5, state, { size: 12, weight: 700, fill: col }));
    }

    function snapLine(st, t) {
      if (t.id === 13) {
        const n = st.locks.length;
        if (st.tx[13] === "active" && n) return `holds write lock${n > 1 ? "s: rows" : ": row"} ${st.locks.join(", ")}`;
        return st.tx[13] === "not started" || st.tx[13] === "active" ? "writer: takes row write locks" : "write locks released";
      }
      if (cfg.level === "ru") return "snap: none, reads newest";
      if (cfg.level === "rc") return "snap: new per statement";
      const snap = st.snap[t.id];
      return snap ? `snap: txid<${t.id}, active {${snap.join(",")}}` : "snap: taken when it begins";
    }

    function drawPills(st) {
      const P = G.pill, L = view.pills;
      L.replaceChildren();
      TX.forEach((t, i) => {
        const y = P.ys[i], col = `var(--viz-${t.color})`, focus = st.focus === t.id;
        L.append(
          s("rect", { x: P.x, y, width: P.w, height: P.h, rx: 10, fill: "var(--viz-panel)" }),
          s("rect", { x: P.x, y, width: P.w, height: P.h, rx: 10, fill: focus ? `var(--viz-${t.color}-soft)` : "var(--viz-panel)", stroke: col, "stroke-width": focus ? 2.5 : 1.5 }),
          ctx.text(P.x + 12, y + P.l1, t.name, { size: 13, weight: 700, anchor: "start" }));
        badge(L, P.x + P.w - 10, y + P.l1, st.tx[t.id]);
        const saw = t.id === 14 && st.t14;
        const line2 = saw ? `saw acct 2 = $${saw.bal}${saw.dirty ? " (dirty read)" : ""}` : t.does;
        L.append(
          ctx.text(P.x + 12, y + P.l2, line2, { size: 12, anchor: "start", weight: saw ? 700 : null, fill: !saw ? "var(--viz-ink)" : saw.dirty ? "var(--viz-bad)" : "var(--viz-ok)" }),
          ctx.text(P.x + 12, y + P.l3, snapLine(st, t), { size: 12, anchor: "start", mono: true, fill: st.snap[t.id] ? "var(--viz-c6)" : "var(--viz-muted)" }));
      });
    }

    function rowYs(vs) {
      const ys = {};
      let y = G.tbl.top, prev = null;
      vs.forEach(v => {
        if (prev !== null && v.id !== prev) y += G.tbl.gap;
        ys[key(v)] = y; y += G.tbl.rowH; prev = v.id;
      });
      return ys;
    }
    const place = (g, y) => { g._y = y; g.setAttribute("transform", `translate(0,${y})`); };

    function paintRow(g, v, st) {
      const { x, w } = G.tbl, rh = G.tbl.rowH - 4, my = rh / 2, C = G.cols;
      const cs = st.tx[v.cb], ds = v.db && st.tx[v.db], dead = cs === "aborted";
      const mark = st.read && st.read.marks[key(v)];
      const cell = (cx, str, o = {}) => g.appendChild(ctx.text(cx, my, str, { size: 13, anchor: "start", mono: true, ...o }));
      const strike = (x1, x2) => g.appendChild(s("line", { x1, x2, y1: my, y2: my, stroke: "var(--viz-bad)", "stroke-width": 1.8 }));
      // Opaque underlay, the version's fill (amber while its creator runs), then the status bar.
      g.replaceChildren(
        s("rect", { x, y: 0, width: w, height: rh, rx: 6, fill: "var(--viz-bg)" }),
        s("rect", {
          x, y: 0, width: w, height: rh, rx: 6, fill: cs === "active" ? "var(--viz-warn-soft)" : "var(--viz-node)",
          stroke: mark ? "var(--viz-c6)" : "var(--viz-line)", "stroke-width": mark ? 2 : 1,
        }),
        s("rect", { x: x + 1.5, y: 1.5, width: 4, height: rh - 3, rx: 2, fill: BAR[cs] }));
      const ink = dead ? "var(--viz-muted)" : "var(--viz-ink)";
      cell(C.id, String(v.id), { fill: ink });
      cell(C.bal, "$" + v.bal, { size: 14, weight: 700, fill: ink });
      cell(C.cb, String(v.cb), { fill: INK[cs], weight: cs === "active" ? 700 : null });
      if (dead) strike(C.id - 6, C.cb + 22);
      if (!v.db) cell(C.db, "–", { fill: "var(--viz-muted)" });
      else {
        cell(C.db, String(v.db), { fill: INK[ds], weight: ds === "active" ? 700 : null });
        if (ds === "aborted") strike(C.db - 3, C.db + 19);
      }
      if (mark) {
        g.appendChild(ctx.text(C.sees, my, mark.ok ? "✓" : "✗", { size: 15, weight: 800, fill: markFill(mark) }));
      }
    }

    function drawRows(st) {
      const ys = rowYs(st.versions), live = new Set(st.versions.map(key));
      for (const [k, g] of view.rowEls) if (!live.has(k)) { g.remove(); view.rowEls.delete(k); }
      st.versions.forEach(v => {
        let g = view.rowEls.get(key(v));
        if (!g) { g = s("g"); view.rows.appendChild(g); view.rowEls.set(key(v), g); place(g, ys[key(v)]); }
        paintRow(g, v, st);
      });
      const r = st.read;
      view.seesHead.textContent = r ? `T${r.reader} sees` : "sees";
      ctx.attr(view.seesHead, { fill: r ? "var(--viz-c6)" : "var(--viz-muted)", "font-weight": r ? 700 : null });
      view.why.replaceChildren();
      view.why.removeAttribute("transform");
      const y0 = Math.max(...[...view.rowEls.values()].map(g => g._y)) + G.tbl.rowH + 12;
      const line = (i, ...kids) => view.why.appendChild(ctx.text(G.tbl.x + 4, y0 + i * 19, "", { size: 12, anchor: "start" })).append(...kids);
      if (!r) {
        if (y0 + 29 > G.strip.y) return;
        const m = { fill: "var(--viz-muted)" };
        line(0, s("tspan", { ...m, "font-weight": 700 }, compact ? "Rule: " : "Visibility rule: "), s("tspan", m, "a version counts if the reader can see"));
        line(1, s("tspan", m, "its created_by txid but not its deleted_by txid."));
        return;
      }
      if (G.why === "reasons") r.order.forEach((k, i) => {
        const m = r.marks[k];
        line(i, s("tspan", { "font-weight": 800, fill: markFill(m) }, m.ok ? "✓ " : "✗ "), m.short);
      });
    }

    // Slide rows to their slots (after an insert or a garbage collection); the lines under the
    // table ride along with the bottom row until the next paint redraws them.
    async function relayout(st) {
      const ys = rowYs(st.versions);
      const moves = st.versions.filter(v => view.rowEls.has(key(v))).map(v => [view.rowEls.get(key(v)), view.rowEls.get(key(v))._y, ys[key(v)]]);
      if (moves.every(([, a, b]) => a === b)) return;
      const dy = Math.max(...moves.map(m => m[2])) - Math.max(...moves.map(m => m[1]));
      await ctx.tween({ ms: 300, onUpdate: k => {
        moves.forEach(([g, a, b]) => place(g, ctx.lerp(a, b, k)));
        view.why.setAttribute("transform", `translate(0,${dy * k})`);
      } });
    }

    function drawStrip(st) {
      const { x, y, w, h: sh } = G.strip, L = view.strip, tot = total(st);
      const val = n => (n == null ? "?" : usd(n));
      const totFill = tot == null ? "var(--viz-ink)" : tot === 1000 ? "var(--viz-ok)" : "var(--viz-bad)";
      const [verdict, vFill] = tot == null ? ["should be $1,000", "var(--viz-muted)"]
        : tot === 1000 ? ["consistent ✓", "var(--viz-ok)"] : ["$100 missing", "var(--viz-bad)"];
      const span = (str, o = {}) => s("tspan", o, str);
      const sep = () => span(" | ", { fill: "var(--viz-muted)" });
      const accts = [span("acct 1 = "), span(val(st.saw[1]), { "font-weight": 700 }), sep(), span("acct 2 = "), span(val(st.saw[2]), { "font-weight": 700 })];
      const totSpans = [span("total = "), span(val(tot), { "font-weight": 800, fill: totFill })];
      const ly = compact ? y + 16 : y + sh / 2;
      L.replaceChildren(
        s("rect", { x, y, width: w, height: sh, rx: 10, fill: "var(--viz-panel)", stroke: tot == null ? "var(--viz-line)" : totFill, "stroke-width": tot == null ? 1 : 1.8 }),
        ctx.text(x + 12, ly, compact ? "T12 (audit) saw" : "T12 saw:", { size: 12, weight: 700, anchor: "start", fill: "var(--viz-muted)" }),
        ctx.text(x + w - 12, ly, verdict, { size: 13, weight: 700, anchor: "end", fill: vFill }));
      if (compact) {
        L.appendChild(ctx.text(x + w / 2, y + 40, "", { size: 14, mono: true })).append(...accts);
        L.appendChild(ctx.text(x + w / 2, y + 62, "", { size: 15, mono: true })).append(...totSpans);
      } else {
        L.appendChild(ctx.text(x + 78, ly, "", { size: 15, mono: true, anchor: "start" })).append(...accts, sep(), ...totSpans);
      }
    }

    function anomaly(st) {
      const tot = total(st);
      if (st.t14 && st.t14.dirty) {
        return [st.tx[13] === "aborted" ? 'dirty read<div style="font-size:12.5px">(never committed)</div>' : "dirty read", "bad"];
      }
      if (tot != null && tot !== 1000) return ["read skew", "bad"];
      return ["none", tot != null ? "ok" : ""];
    }

    function paint(st) {
      drawPills(st);
      drawRows(st);
      drawStrip(st);
      const tot = total(st);
      stats.set("total", tot == null ? "–" : usd(tot), tot == null ? "" : tot === 1000 ? "ok" : "bad");
      stats.set("versions", String(st.versions.length), "");
      stats.set("anomaly", ...anomaly(st));
      stats.set("wait", ...waitStat(st));
    }

    // Computed from the lock table: did T13 ever find a row locked by someone else when it wrote?
    // Reads never add an entry (MVCC readers take no locks), so this stays "no" at every level.
    function waitStat(st) {
      if (!st.writes) return ["–", ""];
      if (st.waits.length) return ["yes", "bad"];
      const sub = st.overlap.length ? `<div style="font-size:12.5px;font-weight:500">(${st.overlap[0]}, which took no lock)</div>` : "";
      return ["no" + sub, "ok"];
    }
    // Who holds a lock on this row? Only writers ever take one here.
    const lockHolders = (st, rowId) => (st.locks.includes(rowId) ? [13] : []);

    // ---------- actions ----------
    function begin(st, id) {
      st.tx[id] = "active";
      st.focus = id;
      if (cfg.level === "si") st.snap[id] = running(st).filter(t => t !== id);
      const how = cfg.level === "si" ? `snapshot fixed: txid<${id}, active {${st.snap[id].join(",")}}`
        : cfg.level === "rc" ? "no fixed snapshot (a new one per statement)" : "no snapshot (reads the newest version)";
      log.add(`T${id} begins: ${how}`, "info");
    }

    async function read(st, reader, rowId) {
      st.focus = reader;
      st.read = { reader, marks: {}, order: [] };
      let hit = null;
      (st.readSet[reader] = st.readSet[reader] || []).push(rowId);   // remembered, but no lock is taken
      for (const v of st.versions.filter(v => v.id === rowId)) {
        const j = judge(st, reader, v);
        j.dirty = j.ok && st.tx[v.cb] !== "committed";
        st.read.marks[key(v)] = j;
        st.read.order.push(key(v));
        if (j.ok) hit = v;
        log.add(`${j.ok ? "✓" : "✗"} T${reader} · ${j.long}: <b>${j.ok ? "visible" : "invisible"}</b>`, j.dirty ? "bad" : j.ok ? "ok" : "muted");
        paint(st);
        await ctx.sleep(500);
      }
      const g = hit && view.rowEls.get(key(hit));
      if (g) {
        const P = G.pill, py = P.ys[TX.findIndex(t => t.id === reader)] + P.h / 2;
        // Desktop: the value leaves the row's left edge for the pill; phone: its top edge, upwards.
        await ctx.fly(view.fx, {
          from: compact ? [G.cols.bal + 70, g._y] : [G.tbl.x, g._y + (G.tbl.rowH - 4) / 2],
          to: [P.x + P.w - (compact ? 60 : 24), py],
          label: "$" + hit.bal, labelSize: 12, fill: "var(--viz-c6)", ms: 650,
          labelFill: st.read.marks[key(hit)].dirty ? "var(--viz-bad)" : "var(--viz-ink)",
        });
      }
      return hit;
    }

    // UPDATE = mark the current version deleted by T13 + insert a new version created by T13.
    async function update(st, rowId, delta) {
      st.read = null;
      st.focus = 13;
      const old = st.versions.find(v => v.id === rowId && !v.db);
      // T13 must wait if anyone else holds a lock on the row; running readers of the row hold none.
      const blockers = lockHolders(st, rowId).filter(t => t !== 13);
      const readers = running(st).filter(t => t !== 13 && (st.readSet[t] || []).includes(rowId));
      st.waits.push(...blockers);
      st.overlap.push(...readers.map(t => `T${t} read row ${rowId}`));
      st.writes++;
      old.db = 13;
      st.locks.push(rowId);
      paint(st);
      await ctx.sleep(450);
      const nv = { id: rowId, bal: old.bal + delta, cb: 13, db: null };
      st.versions.splice(st.versions.indexOf(old) + 1, 0, nv);
      await relayout(st);
      paint(st);
      const g = view.rowEls.get(key(nv));
      g.setAttribute("opacity", 0);   // before the first frame, so the new row fades in without a flash
      await ctx.tween({ ms: 350, onUpdate: k => g.setAttribute("opacity", k) });
      log.add(`T13 UPDATE row ${rowId}: ${tag(old)} gets deleted_by 13, new ${tag(nv)} created_by 13. ` +
        `Write lock on row ${rowId}; readers hold no locks, so T13 does not wait`, "warn");
    }

    // After T12 commits nothing is running, so only the latest committed state can be read again:
    // versions written by an aborted transaction, or deleted by a committed one, are garbage.
    async function collect(st) {
      const dead = st.versions.filter(v => st.tx[v.cb] === "aborted" || (v.db && st.tx[v.db] === "committed"));
      dead.forEach(v => log.add(`GC removes ${tag(v)} by ${v.cb}: ` + (st.tx[v.cb] === "aborted"
        ? `txid ${v.cb} aborted, so it is invisible to every reader` : `deleted by committed txid ${v.db}, and no running transaction can still see it`), "info"));
      const els = dead.map(v => view.rowEls.get(key(v))).filter(Boolean);
      await ctx.tween({ ms: 600, onUpdate: k => els.forEach(g => g.setAttribute("opacity", 1 - k)) });
      st.versions = st.versions.filter(v => !dead.includes(v));
      st.versions.forEach(v => {
        if (v.db && st.tx[v.db] === "aborted") { log.add(`GC clears deleted_by ${v.db} on ${tag(v)} (txid ${v.db} aborted)`, "info"); v.db = null; }
      });
      paint(st);
      await relayout(st);
    }

    // ---------- story ----------
    const lvl = () => cfg.level, commits = () => cfg.end === "commit";
    const pick = o => o[lvl()];
    const steps = [
      {
        title: "T12 (audit) begins",
        get detail() {
          return pick({
            si: "Its snapshot is fixed now: it will see only versions by txids below 12 that had committed, and nothing else was running (<code>active {}</code>).",
            rc: "Read committed takes a <b>new snapshot for every statement</b>, so T12 has no fixed view of the data.",
            ru: "Read uncommitted takes no snapshot: every read returns the <b>newest version</b>, committed or not.",
          });
        },
        run: async st => { st.read = null; begin(st, 12); paint(st); },
      },
      {
        title: "T12 reads account 1 and sees $500",
        detail: "v(1,$500) was created by txid 3, which committed before T12 began, so it is visible at every level. The read takes no lock.",
        run: async st => { const v = await read(st, 12, 1); st.saw[1] = v.bal; paint(st); },
      },
      {
        title: "T13 begins: <code>UPDATE accounts SET balance = balance + 100 WHERE id = 1</code>",
        detail: "An update never overwrites in place: it marks the old version deleted and adds a new one. T13 also holds a row write lock, so no other writer can touch row 1 until it ends. T12 just read row 1 but holds no lock, so T13 does not wait.",
        run: async st => {
          st.read = null;
          st.tx[13] = "active";
          st.focus = 13;
          log.add("T13 begins (writer)", "info");
          paint(st);
          await ctx.sleep(300);
          await update(st, 1, 100);
        },
      },
      {
        title: "T13: <code>UPDATE accounts SET balance = balance - 100 WHERE id = 2</code>",
        detail: "Same on row 2: v(2,$500) gets deleted_by 13 and a new v(2,$400) appears. Both of T13's new versions are still uncommitted (amber).",
        run: async st => { await update(st, 2, -100); },
      },
      {
        title: "T14 (phone app) reads account 2 while T13 is still running",
        get detail() {
          return pick({
            si: "T14's snapshot lists T12 and T13 as running (<code>active {12,13}</code>), so T13's $400 is invisible: <b>no dirty read</b>. T14 sees $500 and commits (it is read-only).",
            rc: "T13 has not committed, so its $400 is invisible: <b>no dirty read</b>. T14 sees $500 and commits (it is read-only).",
            ru: "<b>Dirty read</b>: T14 shows $400, but T13 has not committed and might still abort.",
          });
        },
        run: async st => {
          st.read = null;
          begin(st, 14);
          paint(st);
          await ctx.sleep(400);
          const v = await read(st, 14, 2);
          st.t14 = { bal: v.bal, dirty: st.tx[v.cb] !== "committed" };
          st.tx[14] = "committed";
          const dirty = st.t14.dirty;
          log.add(`T14 commits (read-only)${dirty ? `: it showed the user $${v.bal}, written by uncommitted T13` : ""}`, dirty ? "bad" : "info");
          paint(st);
        },
      },
      {
        get title() { return commits() ? "T13 commits" : "T13 aborts (ROLLBACK)"; },
        get detail() {
          return commits() ? "Commit is a single atomic flip: both of T13's new versions become committed at the same instant, and its row locks are released."
            : "In this PostgreSQL-style model nothing is copied back: versions written by an aborted transaction stay in the table and are simply ignored by every reader (visibility rule 2).";
        },
        run: async st => {
          st.read = null;
          st.focus = 13;
          st.tx[13] = commits() ? "committed" : "aborted";
          st.locks = [];
          log.add(commits() ? "T13 commits: v(1,$600) and v(2,$400) are committed together; locks released"
            : "T13 aborts: its versions and deleted_by marks are now ignored; locks released", commits() ? "ok" : "bad");
          paint(st);
        },
      },
      {
        title: "T12 reads account 2",
        get detail() {
          if (!commits()) {
            return "T13's versions are ignored, so every level sees $500: total $1,000." +
              (lvl() === "ru" ? " The run is still an anomaly: T14 showed the user $400, a balance that never existed." : "");
          }
          return pick({
            si: "Txid 13 is later than T12's snapshot, so v(2,$400) is invisible, and v(2,$500) is still visible because its deletion by 13 is invisible too: $500, total <b>$1,000</b>.",
            rc: "A fresh statement snapshot sees T13 committed, so $400: total <b>$900</b>. <b>Read skew</b>: T12 saw account 1 before the transfer and account 2 after it.",
            ru: "The newest version is T13's $400: total <b>$900</b>.",
          });
        },
        run: async st => {
          const v = await read(st, 12, 2);
          st.saw[2] = v.bal;
          const tot = total(st);
          log.add(`T12 total = ${usd(tot)}${tot === 1000 ? "" : ": $100 has vanished"}`, tot === 1000 ? "ok" : "bad");
          paint(st);
        },
      },
      {
        title: "T12 commits; garbage collection",
        get detail() {
          if (!commits()) {
            return "No transaction can see the aborted versions, so garbage collection removes them (PostgreSQL leaves them in the table until VACUUM runs)." +
              (lvl() === "ru" ? " Under read uncommitted that came too late: T14 had already shown $400 to the user." : "");
          }
          return pick({
            si: "T12's snapshot needed the old versions until it ended: a transaction that runs for hours keeps old versions alive for hours (bloat).",
            rc: "Under read committed T12 needed old versions only while each statement ran, so they could have been removed as soon as T13 committed; snapshot isolation must keep them for the whole transaction.",
            ru: "Read uncommitted never keeps old versions for readers; the price is that readers can see data that never commits.",
          });
        },
        run: async st => {
          st.read = null;
          st.focus = 12;
          st.tx[12] = "committed";
          log.add("T12 commits (read-only)", "info");
          paint(st);
          await ctx.sleep(400);
          await collect(st);
          st.focus = null;
          paint(st);
        },
      },
    ];

    const INTRO = {
      rc: "Alice's audit (<b>T12</b>) reads two accounts while a transfer (<b>T13</b>) runs. Play it under <b>Read committed</b>, then switch to <b>Snapshot isolation</b>.",
      si: "Alice's audit (<b>T12</b>) reads two accounts while a transfer (<b>T13</b>) runs. Under <b>snapshot isolation</b> T12 ignores, for its whole life, writes by transactions that were running when it began or that started later.",
      ru: "Alice's audit (<b>T12</b>) reads two accounts while a transfer (<b>T13</b>) runs. <b>Read uncommitted</b> returns the newest version, committed or not.",
    };
    const intro = () => INTRO[lvl()] + (lvl() === "ru" && commits() ? " Then try <b>T13 ends with: Abort</b>." : "");
    function verdict() {
      if (lvl() === "ru") {
        return commits() ? ["Read uncommitted exposed T13's uncommitted $400 to the phone app, and the audit total is still wrong.", "bad"]
          : ["The phone app showed <b>$400</b>, a balance that never existed: T13 rolled back. This is why almost nobody runs at read uncommitted.", "bad"];
      }
      if (!commits()) return ["Writes by an aborted transaction are invisible at every level above read uncommitted. Total <b>$1,000</b>.", "ok"];
      return lvl() === "rc"
        ? ["Read committed never showed T13's uncommitted data, but T12 saw account 1 before the transfer and account 2 after it: <b>$900</b>. Fine for a page refresh, fatal for a backup.", "bad"]
        : ["Every read in T12 used the snapshot from its start, so the transfer is invisible to it and the total is <b>$1,000</b>. T13 never waited for T12, and T12 never waited for T13.", "ok"];
    }
    const setNote = i => (i >= 6 ? note.set(...verdict()) : note.set(intro(), "info"));

    buildScene();
    const player = ctx.stepper({
      init() {
        view.rows.replaceChildren(); view.fx.replaceChildren(); view.rowEls.clear();
        log.clear().add("Every read lists each version it checks and why it is visible or not.", "muted");
        const st = {
          versions: [{ id: 1, bal: 500, cb: 3, db: null }, { id: 2, bal: 500, cb: 5, db: null }],
          tx: { 3: "committed", 5: "committed", 12: "not started", 13: "not started", 14: "not started" },
          snap: {}, saw: {}, t14: null, locks: [], read: null, focus: null,
          readSet: {}, writes: 0, waits: [], overlap: [],
        };
        paint(st);
        return st;
      },
      steps,
      delay: 1600,
      intro: "Press <b>Play</b> or <b>Step ▶</b> to run the story. Change a setting above to replay it under different rules.",
      onStep: setNote,
    });
    setNote(-1);

    root.append(
      ui.bar(levelSeg, endSeg),
      holder,
      ui.legend([
        { color: "var(--viz-warn)", label: "written by a running tx", shape: "square" },
        { color: "var(--viz-ok)", label: "committed version", shape: "line" },
        { color: "var(--viz-bad)", label: "aborted / anomaly", shape: "line" },
        { color: "var(--viz-c6)", label: "reader" },
        { color: "var(--viz-c5)", label: "writer" },
      ]),
      player.el, note, stats, log,
    );
    // Phone <-> desktop: rebuild the scene and replay to the current step.
    ctx.onResize(() => { if (ctx.compact !== compact) { buildScene(); player.goto(player.index); } });
  },
});
