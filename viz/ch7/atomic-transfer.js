// All-or-nothing transfer: Alice moves $100 from Savings to Checking with two UPDATEs.
// The reader picks autocommit vs. a transaction, where a crash happens, and what the app does
// on error. A pure model (committed balances, the in-flight transaction, the write-ahead log,
// the transfers table) is mutated by each step and redrawn, so Back/replay is exact.
// Lesson: atomicity makes "retry after a crash" safe, but when only the reply was lost a blind
// retry runs the transfer twice; an idempotency key written in the same transaction fixes that.
Viz.register("ch7/atomic-transfer", {
  title: "All-or-nothing transfer",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const V = n => `var(--viz-${n})`;
    const paint = (el, st) => { for (const k in st) el.style.setProperty(k, st[k]); return el; };
    const show = (el, on) => { el.style.display = on ? "" : "none"; };
    const money = v => "$" + v.toLocaleString("en-US");
    const ID = "t-7f3", ACCTS = ["savings", "checking"];

    // ---------- layouts ----------
    // The log strip gets exactly the rows this story needs, so the scene height depends on cfg.
    const BASE = {
      desk: {
        W: 640, bal: 18, side: true, was: true, dupText: "✗ duplicate key", titleY: 30,
        app: { x: 14, w: 112, h: 56 }, db: { x: 146, y: 10, w: 482 },
        acct: { savings: { x: 162, y: 48, w: 218, h: 70 }, checking: { x: 394, y: 48, w: 218, h: 70 } },
        tbl: { x: 162, y: 130, w: 450, h: 38 }, wal: { x: 162, y: 180, w: 450 },
        chip: { w: 70, h: 32, gap: 5, vgap: 8, perRow: 5, x0: 232 },
      },
      phone: {
        W: 360, bal: 16, side: false, was: false, dupText: "✗ duplicate", titleY: 90,
        app: { x: 10, y: 10, w: 140, h: 48 }, db: { x: 10, y: 70, w: 340 },
        acct: { savings: { x: 22, y: 106, w: 152, h: 64 }, checking: { x: 186, y: 106, w: 152, h: 64 } },
        tbl: { x: 22, y: 180, w: 316, h: 36 }, wal: { x: 22, y: 226, w: 316 },
        chip: { w: 72, h: 32, gap: 6, vgap: 6, perRow: 4, x0: 27 },
      },
    };
    // Log records per attempt for a story (makeChip throws if a story writes more).
    function logShape({ mode, crash, policy }) {
      const tx = mode === "tx", key = policy === "key";
      const first = (tx ? 1 : 0) + (key ? 1 : 0) + 1 + (crash === "debit" ? 0 : tx ? 2 : 1);
      if (crash === "none" || policy === "giveup") return [first, 0];
      if (policy === "retry") return [first, tx ? 4 : 2];
      return [first, tx && crash === "debit" ? 5 : tx ? 3 : 1];
    }
    function layout(compact, cfg) {
      const B = BASE[compact ? "phone" : "desk"], c = B.chip;
      const L = { ...B, rows: [], att: [] };
      let y = B.wal.y + 26;
      logShape(cfg).forEach((n, a) => {
        if (!n) return;
        if (B.side) L.att[a] = { x: B.wal.x + 12, y: y + c.h / 2, anchor: "start" };   // label column
        else if (a === 0) L.att[a] = { x: B.wal.x + B.wal.w - 12, y: B.wal.y + 16, anchor: "end" };
        else { L.att[a] = { x: B.wal.x + B.wal.w - 12, y: y + 6, anchor: "end", rule: B.wal.x + 12 }; y += 20; }
        L.rows[a] = [];
        for (let r = 0; r < Math.ceil(n / c.perRow); r++) { L.rows[a].push(y); y += c.h + c.vgap; }
      });
      L.wal = { ...B.wal, h: y - c.vgap + 10 - B.wal.y };
      L.db = { ...B.db, h: L.wal.y + L.wal.h + 10 - B.db.y };
      L.H = L.db.y + L.db.h + 8;
      if (B.side) {
        const cy = L.db.y + L.db.h / 2;
        L.app = { ...B.app, y: cy - B.app.h / 2 - 20 };
        L.lines = { x: B.app.x + B.app.w / 2, y: cy + 30, dy: 16, anchor: "middle" };
        L.port = [B.app.x + B.app.w, cy - 20];
      } else {
        L.lines = { x: 162, y: 20, dy: 15, anchor: "start" };
        L.port = [B.app.x + B.app.w / 2, B.app.y + B.app.h];
      }
      return L;
    }
    function chipPos(L, a, i) {
      const c = L.chip, row = L.rows[a] && L.rows[a][Math.floor(i / c.perRow)];
      if (row === undefined) throw new Error(`log slot ${i} of attempt ${a + 1} is not laid out`);
      const x = c.x0 + (i % c.perRow) * (c.w + c.gap);
      return { x, y: row, cx: x + c.w / 2, cy: row + c.h / 2 };
    }

    // ---------- model ----------
    const newModel = () => ({
      bal: { savings: 500, checking: 500 }, tx: null, ids: {}, idState: null, dup: false,
      debits: 0, credits: 0, wal: [[], []], at: 0, app: ["idle", "c6"], crashed: false, restored: {}, done: false,
    });
    const shown = (m, a) => (m.tx && a in m.tx.w ? m.tx.w[a] : m.bal[a]);
    const tally = (m, d) => { if (d < 0) m.debits++; else if (d > 0) m.credits++; };
    const rec = (m, op, arg, st) => { const r = { op, arg, st }; m.wal[m.at].push(r); if (m.tx && st === "pending") m.tx.recs.push(r); return r; };
    const begin = m => { m.tx = { w: {}, ids: [], recs: [] }; rec(m, "BEGIN", null, "pending"); };
    function update(m, a, d) {
      const arg = (d < 0 ? "−" : "+") + Math.abs(d);
      if (m.tx) { m.tx.w[a] = shown(m, a) + d; rec(m, a, arg, "pending"); return; }
      m.bal[a] += d; tally(m, d); rec(m, a, arg, "ok");   // autocommit: its own transaction
    }
    function insert(m) {   // false = duplicate key (the UNIQUE constraint fired)
      if (m.ids[ID] || (m.tx && m.tx.ids.length)) { rec(m, "INSERT", "✗ " + ID, "err"); m.dup = true; return false; }
      if (m.tx) { m.tx.ids.push(ID); m.idState = "pending"; rec(m, "INSERT", ID, "pending"); return true; }
      m.ids[ID] = true; m.idState = "ok"; rec(m, "INSERT", ID, "ok");
      return true;
    }
    function commit(m) {
      for (const a in m.tx.w) { tally(m, m.tx.w[a] - m.bal[a]); m.bal[a] = m.tx.w[a]; }
      if (m.tx.ids.length) { m.ids[ID] = true; m.idState = "ok"; }
      m.tx.recs.forEach(r => { r.st = "ok"; });
      m.tx = null;
      rec(m, "COMMIT", null, "ok");
    }
    // Abort: every uncommitted write of the transaction is discarded (at recovery or on ROLLBACK).
    function abort(m, explicit) {
      if (!m.tx) return;
      m.tx.recs.forEach(r => { r.st = "gone"; });
      for (const a in m.tx.w) m.restored[a] = true;
      if (m.idState === "pending") m.idState = "gone";
      m.tx = null;
      if (explicit) rec(m, "ROLLBACK", null, "abort");
    }

    // ---------- controls and shared panels ----------
    const cfg = { mode: "auto", crash: "debit", policy: "giveup" };   // survives layout rebuilds
    let compact = ctx.compact, gen = 0, player = null;
    const seg = (label, key, options) => ui.segmented({ label, value: cfg[key], options, onChange: v => { cfg[key] = v; restart(); } });
    const segs = {
      mode: seg("Mode", "mode", [{ value: "auto", label: "No transaction" }, { value: "tx", label: "Transaction" }]),
      crash: seg("Crash", "crash", [{ value: "none", label: "None" }, { value: "debit", label: "After debit" }, { value: "reply", label: "Before reply" }]),
      policy: seg("On error", "policy", [{ value: "giveup", label: "Give up" }, { value: "retry", label: "Retry" }, { value: "key", label: "Retry with transfer id" }]),
    };
    const stage = h("div"), stepSlot = h("div"), nextSlot = h("div");
    const legend = ui.legend([{ color: V("warn"), label: "written, not committed", shape: "square" }, { color: V("ok"), label: "committed", shape: "square" },
      { color: V("bad"), label: "discarded (rolled back)", shape: "dash" }, { color: V("c6"), label: "app (client)", shape: "dot" }]);
    const stats = ui.stats([
      { key: "savings", label: "Savings" }, { key: "checking", label: "Checking" },
      { key: "total", label: "Total (must be $1,000)" }, { key: "dc", label: "Debits / credits applied (want 1 / 1)" },
    ]);
    const note = ui.note("");
    const log = ui.log({ title: "What happened", height: 110 });
    root.append(ui.bar(segs.mode, segs.crash, segs.policy), stage, legend, stepSlot, note, nextSlot, stats, log);

    // ---------- animation helpers ----------
    // Every await goes through live(): once the config changes (gen bumps), a stale step parks
    // forever instead of drawing over the new scene or writing to the shared log and stats.
    const live = (st, p) => p.then(v => (st.gen === gen ? v : new Promise(() => {})));
    const fly = (st, from, to, o) => live(st, ctx.fly(st.pk, { ms: 600, labelSize: 12, ...o, from, to }));
    const sleep = (st, ms) => live(st, ctx.sleep(ms));
    const tween = (st, ms, fn) => live(st, ctx.tween({ ms, onUpdate: fn }));
    function target(st, where) {
      if (where === "log") { const p = chipPos(st.L, st.m.at, st.m.wal[st.m.at].length); return [p.cx, p.cy]; }
      if (where === "id") return st.idAt;
      const r = st.L.acct[where];
      return [r.x + r.w / 2, r.y + r.h / 2];
    }
    // One SQL statement: request packet, apply to the model, redraw, optional reply packet.
    async function stmt(st, label, where, op, o = {}) {
      const to = target(st, where);
      await fly(st, st.L.port, to, { label, fill: V("c6"), ms: o.fast ? 380 : 600 });
      const res = op(st.m);
      st.last = to;
      render(st);
      if (o.reply) await reply(st, o.reply);
      return res;
    }
    const reply = (st, label, lost) =>
      fly(st, st.last, st.L.port, { label, fill: V(label === "OK" ? "ok" : "bad"), ms: 500, lost });
    const setApp = (st, text, tone = "c6") => { st.m.app = [text, tone]; render(st); };

    // Recovery: a cursor sweeps the log, then writes without a COMMIT record are discarded.
    async function recover(st) {
      const L = st.L, c = L.chip, line = s("line", { y1: L.wal.y + 6, y2: L.wal.y + L.wal.h - 6, "stroke-width": 3, "stroke-linecap": "round" });
      st.fx.appendChild(paint(line, { stroke: V("info") }));
      const x0 = c.x0 - 6, x1 = c.x0 + c.perRow * (c.w + c.gap);
      await tween(st, 800, k => ctx.attr(line, { x1: ctx.lerp(x0, x1, k), x2: ctx.lerp(x0, x1, k) }));
      line.remove();
      const before = { savings: shown(st.m, "savings"), checking: shown(st.m, "checking") };
      abort(st.m);
      st.m.crashed = false;
      render(st);
      const moved = ACCTS.filter(a => before[a] !== st.m.bal[a]);
      if (moved.length) await tween(st, 700, k => moved.forEach(a => {
        st.cards[a].bal.textContent = money(Math.round(ctx.lerp(before[a], st.m.bal[a], k)));
      }));
    }

    // ---------- the story ----------
    function makeSteps({ mode, crash, policy }) {
      const tx = mode === "tx", key = policy === "key", S = [], F = { fast: true };
      const step = (title, detail, line, run) => S.push({ title, detail, line, run });
      const debit = (st, o) => stmt(st, "UPDATE savings", "savings", m => update(m, "savings", -100), o);
      const credit = (st, o) => stmt(st, "UPDATE checking", "checking", m => update(m, "checking", 100), o);
      const commitStmt = (st, o) => stmt(st, "COMMIT", "log", commit, o);
      const sql = (d, acct) => `<code>UPDATE accounts SET balance = balance ${d} 100 WHERE name = '${acct}'</code>`;

      step("The app asks the database to move <b>$100</b> from Savings to Checking",
        tx ? "<code>BEGIN</code> opens a transaction: none of its writes count until <code>COMMIT</code>."
           : "No transaction: every statement commits on its own (autocommit).",
        tx ? ["BEGIN: a transaction starts", "info"] : ["autocommit: each UPDATE will be its own transaction", "info"],
        async st => {
          setApp(st, "waiting…");
          if (tx) await stmt(st, "BEGIN", "log", begin, { reply: "OK" });
          else await sleep(st, 400);
        });
      if (key) step(`<code>INSERT INTO transfers (id) VALUES ('${ID}')</code>`,
        `The app generated <code>${ID}</code> once for this transfer, not once per attempt. ` +
        (tx ? "The row belongs to the transaction; the UNIQUE constraint rejects a second copy." : "Without a transaction the row commits immediately, on its own."),
        [`id ${ID} inserted` + (tx ? " (uncommitted)" : " and committed"), tx ? "warn" : "ok"],
        st => stmt(st, `INSERT ${ID}`, "id", insert, { reply: "OK" }));
      step(sql("-", "savings"),
        tx ? "Savings reads $400 only inside this transaction: its log record has no COMMIT yet."
           : "It commits at once: anyone reading now sees a total of $900.",
        tx ? ["savings −100 (uncommitted)", "warn"] : ["savings −100 committed: the total is now $900", "bad"],
        st => debit(st, { reply: "OK" }));

      if (crash === "debit") {
        step("The database crashes before the second UPDATE runs",
          "The app's next statement finds the connection gone: all it gets is an error.",
          ["CRASH after the debit: the app gets an error", "bad"],
          async st => {
            st.m.crashed = true; render(st);
            await sleep(st, 300);
            await fly(st, st.L.port, target(st, "checking"), { label: "UPDATE checking", fill: V("c6"), lost: 0.5 });
            setApp(st, "error!", "bad");
          });
        step("Recovery: the database replays its log",
          tx ? "No COMMIT record, so every write of the transaction is undone."
             : "The debit was a committed transaction of its own, so recovery keeps it. Nothing records that a credit should follow.",
          tx ? ["recovery: attempt 1 has no COMMIT, so its writes are discarded. Engines differ in mechanics (InnoDB, Oracle and SQL Server apply undo records; " +
                "PostgreSQL never marks the transaction committed, so its new row versions stay invisible), but the effect is the same.", "ok"]
             : ["recovery: the debit had committed, so it stays; $100 is missing", "bad"],
          st => recover(st));
      } else {
        const lostReply = crash === "reply" && !tx;   // autocommit: this OK is the one that gets lost
        step(sql("+", "checking"),
          tx ? "Checking reads $600, still uncommitted." : crash === "none"
            ? "It commits at once. Between the two UPDATEs, any reader could have seen a total of $900."
            : "It commits at once, so the transfer is complete.",
          tx ? ["checking +100 (uncommitted)", "warn"] : ["checking +100 committed: the total is back to $1,000", "ok"],
          async st => {
            await credit(st, { reply: lostReply ? null : "OK" });
            if (!tx && crash === "none") setApp(st, "OK", "ok");
          });
        if (tx) step("<code>COMMIT</code>: the commit record is written to the log",
          "From this instant the transfer is durable.",
          ["COMMIT record written: the transfer is durable", "ok"],
          async st => {
            await commitStmt(st, { reply: crash === "reply" ? null : "OK" });
            if (crash === "none") setApp(st, "OK", "ok");
          });
        if (crash === "reply") {
          step("The connection dies before OK reaches the app",
            `The database went down right after ${tx ? "the COMMIT" : "the second UPDATE"}. The app cannot tell whether the transfer happened.` +
            (tx ? "" : " The lost reply is the one for <code>UPDATE checking</code>, which had already auto-committed."),
            ["the OK was lost: the app only sees a timeout", "warn"],
            async st => {
              await reply(st, "OK", 0.5);
              st.m.crashed = true;
              setApp(st, "timeout?", "warn");
            });
          step(tx ? "Recovery: the COMMIT record is in the log, so the transfer survives"
                  : "Recovery: both UPDATEs had committed, so the transfer survives",
            "Recovery keeps every committed write. The app still knows only “timeout”.",
            ["recovery: the transfer is committed and stays", "ok"],
            st => recover(st));
        }
      }

      if (crash !== "none") policySteps(step, { tx, crash, policy, debit, credit, commitStmt, F });
      const [headline, , tone] = verdict({ mode, crash, policy });
      step(`Result: ${headline}`, "", [`result: ${headline}`, tone], async st => {
        st.m.done = true; render(st);
        finish();
        await sleep(st, 100);
      });
      return S;
    }

    function policySteps(step, { tx, crash, policy, debit, credit, commitStmt, F }) {
      const retryStart = st => { st.m.at = 1; setApp(st, "retrying…"); };
      if (policy === "giveup") {
        step("The app shows an error and stops",
          crash === "reply" ? "But the transfer did happen: Alice is told it failed."
            : tx ? "Safe: recovery already undid the half-done transfer." : "Nobody undoes the committed debit.",
          ["the app gave up", crash === "reply" || tx ? "warn" : "bad"],
          st => setApp(st, "gave up", "bad"));
        return;
      }
      if (policy === "retry") {
        step("The app retries the whole transfer",
          tx ? "<code>BEGIN</code>, both UPDATEs and <code>COMMIT</code> run again as attempt 2." : "Both UPDATEs run again, each committing on its own.",
          crash === "reply" ? ["retry: the transfer ran a second time", "bad"]
            : tx ? ["retry: attempt 2 started from a clean slate and committed", "ok"] : ["retry: Savings is debited a second time", "bad"],
          async st => {
            retryStart(st);
            if (tx) await stmt(st, "BEGIN", "log", begin, F);
            await debit(st, F); await credit(st, F);
            if (tx) await commitStmt(st, F);
            await reply(st, "OK");
            setApp(st, "OK", "ok");
          });
        return;
      }
      const fresh = tx && crash === "debit";   // the first attempt's id row was rolled back
      step(`The app retries with the same transfer id <code>${ID}</code>`,
        fresh ? "Recovery rolled the first attempt's id row back with it, so this INSERT succeeds."
          : `Duplicate key: <code>${ID}</code> is already committed, so the app treats the transfer as already done` + (tx ? " and rolls attempt 2 back." : "."),
        fresh ? [`retry: id ${ID} is new, the transfer runs again`, "info"] : [`retry: INSERT ${ID} failed with a duplicate key, "already done"`, tx ? "ok" : "warn"],
        async st => {
          retryStart(st);
          if (tx) await stmt(st, "BEGIN", "log", begin, F);
          const ok = await stmt(st, `INSERT ${ID}`, "id", insert);
          await reply(st, ok ? "OK" : "duplicate key");
          if (ok) return;
          if (tx) await stmt(st, "ROLLBACK", "log", m => abort(m, true), { reply: "OK" });
          setApp(st, "already done", "ok");
        });
      if (fresh) step("Attempt 2 runs the transfer in the same transaction as the id",
        "<code>savings −100</code>, <code>checking +100</code>, <code>COMMIT</code>: the id row and the money move together.",
        ["attempt 2 committed", "ok"],
        async st => {
          await debit(st, F); await credit(st, F); await commitStmt(st, F);
          await reply(st, "OK");
          setApp(st, "OK", "ok");
        });
    }

    // [headline, note html, tone] for the final step.
    function verdict({ mode, crash, policy }) {
      const tx = mode === "tx";
      if (crash === "none") return ["one transfer, nothing failed", "Happy path: atomicity only matters when something fails. Pick a crash point.", "info"];
      if (crash === "debit" && tx) return {
        giveup: ["nothing moved, nothing lost", "Recovery rolled the half-done transfer back, so both accounts are untouched: safe, but Alice's transfer didn't happen. The failed attempt left no trace, so retrying would be safe.", "warn"],
        retry: ["exactly one transfer", "The crash rolled the half-done transfer back, so retrying was safe. This is what atomicity buys you: abortability.", "ok"],
        key: ["exactly one transfer", "The rollback took the id row with it, so the retry's INSERT succeeded and the money moved once. The id earns its keep when the outcome is unknown: try a crash before the reply.", "ok"],
      }[policy];
      if (crash === "debit") return {
        giveup: ["$100 vanished", "$100 vanished: the debit had committed on its own and nothing undid it.", "bad"],
        retry: ["debited twice, credited once", "The retry ran the whole transfer again on top of a debit that had already committed: Savings lost $200, Checking gained $100, and $100 is still missing.", "bad"],
        key: ["the credit never happened", "The duplicate id told the app the transfer was done, but only the debit had committed. An idempotency key cannot repair a half-applied operation. You need both: atomicity and idempotency.", "bad"],
      }[policy];
      return {
        giveup: ["done, but reported as failed", `The transfer did happen (${tx ? "its COMMIT was durable" : "both UPDATEs had committed"}), yet the app told Alice it failed. If she tries again by hand, the money moves twice.`, "warn"],
        retry: ["the money moved twice", (tx ? "Both attempts were complete, valid transactions, so atomicity had nothing to undo." : "Both attempts ran to completion, so there was nothing to undo.") +
          " The invariant holds, yet the money moved twice.", "bad"],
        key: ["exactly one transfer", "The UNIQUE transfer id turned the retry into a no-op: exactly one effect. (See Chapter 12 on operation IDs.)" +
          (tx ? "" : " Without a transaction this only worked because the crash came after both UPDATEs: try a crash after the debit."), "ok"],
      }[policy];
    }
    function intro({ mode, crash, policy }) {
      const tx = mode === "tx";
      const how = tx ? "inside one transaction (BEGIN … COMMIT)" : "with two UPDATEs and no transaction";
      const onErr = crash === "none" ? "" : { giveup: "", retry: " On an error, the app retries the whole transfer.",
        key: ` On an error, the app retries with the same transfer id <code>${ID}</code>.` }[policy];
      const watch = { debit: "Press <b>Play</b> and watch what a crash halfway through does.",
        reply: `Press <b>Play</b>: this time the crash comes after ${tx ? "the COMMIT" : "both UPDATEs"}, just before the app hears OK.`,
        none: "Press <b>Play</b> for the happy path: nothing fails." }[crash];
      return `Alice moves $100 from Savings to Checking ${how}.${onErr} ${watch}`;
    }
    // The guided path through the idea; each entry is [button text, config change].
    const NEXT = {
      "auto/debit/giveup": ["Transaction mode", { mode: "tx" }],
      "tx/debit/giveup": ["retry on error", { policy: "retry" }],
      "tx/debit/retry": ["crash before the reply", { crash: "reply" }],
      "tx/reply/retry": ["retry with a transfer id", { policy: "key" }],
      "tx/reply/key": ["transfer id without a transaction", { mode: "auto", crash: "debit" }],
    };
    function finish() {
      const [, html, tone] = verdict(cfg), next = NEXT[`${cfg.mode}/${cfg.crash}/${cfg.policy}`];
      note.set(html, tone);
      nextSlot.replaceChildren();
      nextSlot.style.margin = next ? "10px 0" : "";
      if (next) nextSlot.appendChild(ui.button(`Try next: ${next[0]} →`, () => {
        Object.assign(cfg, next[1]);
        for (const k in segs) segs[k].set(cfg[k]);
        restart();
      }, { kind: "primary" }));
    }

    // ---------- scene ----------
    // Rounded label; its width follows the text (the svg is in the document while drawing).
    const pillAt = (parent, x, y, anchor) => {
      const g = s("g");
      g.rect = s("rect", { y: y - 11, height: 22, rx: 11, "stroke-width": 1.4 });
      g.t = ctx.text(0, y + 1, "", { size: 12, weight: 700 });
      g.append(g.rect, g.t);
      parent.appendChild(g);
      g.say = (str, fill, stroke, ink) => {
        g.t.textContent = str;
        paint(g.rect, { fill: V(fill), stroke: V(stroke) });
        paint(g.t, { fill: V(ink) });
        const w = ((g.t.getComputedTextLength && g.t.getComputedTextLength()) || str.length * 7.2) + 20;
        const x0 = anchor === "end" ? x - w : x;
        ctx.attr(g.rect, { x: x0, width: w });
        ctx.attr(g.t, { x: x0 + w / 2 });
      };
      return g;
    };
    function drawScene(st) {
      const { L, bg } = st, key = cfg.policy === "key", d = L.db;
      st.app = ctx.box({ ...L.app, label: "App", sub: "idle", size: 14, fill: V("c6-soft"), stroke: V("c6") });
      bg.appendChild(st.app);
      ["moves $100", "Savings → Checking"].concat(key ? [`transfer id ${ID}`] : []).forEach((t, i) =>
        bg.appendChild(ctx.text(L.lines.x, L.lines.y + i * L.lines.dy, t, { size: 12, anchor: L.lines.anchor, fill: V(i === 2 ? "c6" : "muted"), weight: i === 2 ? 600 : null })));
      st.dbRect = s("rect", { x: d.x, y: d.y, width: d.w, height: d.h, rx: 12 });
      bg.appendChild(paint(st.dbRect, { fill: V("panel") }));
      // While crashed, a red CRASH pill takes the title's place (phones have no room for both).
      st.title = bg.appendChild(ctx.text(d.x + 16, L.titleY, "Database", { size: 12, weight: 700, anchor: "start", fill: V("muted") }));
      st.crashPill = pillAt(bg, d.x + 10, L.titleY);
      st.crashPill.say("CRASH", "bad", "bad", "bg");
      st.totalPill = pillAt(bg, d.x + d.w - 12, L.titleY, "end");
      st.cards = {};
      ACCTS.forEach(a => {
        const r = L.acct[a], cx = r.x + r.w / 2;
        const g = ctx.box({ ...r, rx: 10 });
        g.appendChild(ctx.text(cx, r.y + 16, a === "savings" ? "Savings" : "Checking", { size: 13, weight: 600 }));
        g.bal = ctx.text(cx, r.y + r.h / 2 + 3, "", { size: L.bal, weight: 700, mono: true });
        g.sub = ctx.text(cx, r.y + r.h - 12, "", { size: 12 });
        g.append(g.bal, g.sub);
        bg.appendChild(g);
        st.cards[a] = g;
      });
      const t = L.tbl, ty = t.y + t.h / 2, cx = t.x + 164;
      bg.appendChild(ctx.box({ ...t, rx: 8, fill: V("bg"), stroke: V("line") }));
      bg.appendChild(ctx.text(t.x + 12, ty, "transfers (id UNIQUE)", { size: 12, weight: 600, anchor: "start" }));
      if (!key) bg.appendChild(ctx.text(cx, ty, "not used", { size: 12, anchor: "start", fill: V("muted") }));
      st.idAt = [cx + 31, ty];
      st.idChip = chipEl(bg, cx, ty - 12, 62, 24, [ID]);
      st.dupText = ctx.text(cx + 70, ty, L.dupText, { size: 12, weight: 700, anchor: "start", fill: V("bad") });
      bg.appendChild(st.dupText);
      const w = L.wal;
      bg.appendChild(ctx.box({ ...w, rx: 8, fill: V("bg"), stroke: V("line") }));
      bg.appendChild(ctx.text(w.x + 12, w.y + 16, "write-ahead log", { size: 12, weight: 600, anchor: "start" }));
      st.attLabels = L.att.map((p, i) => {
        const g = s("g");
        if (p.rule) g.appendChild(paint(s("line", { x1: p.rule, x2: p.x - 68, y1: p.y, y2: p.y, "stroke-dasharray": "3 4" }), { stroke: V("line") }));
        g.appendChild(ctx.text(p.x, p.y, `attempt ${i + 1}`, { size: 12, anchor: p.anchor, fill: V("muted") }));
        bg.appendChild(g);
        return g;
      });
      st.chips = [[], []];
    }

    const CHIP = {   // status -> [fill, stroke, text]
      pending: ["warn-soft", "warn", "ink"], ok: ["ok-soft", "ok", "ink"], gone: ["bad-soft", "bad", "muted"],
      err: ["bad-soft", "bad", "bad"], abort: ["node", "bad", "bad"],
    };
    // A log record or table row: one or two mono lines; strike lines show when it is discarded.
    function chipEl(parent, x, y, w, hh, lines) {
      const g = s("g"), box = { x, y, width: w, height: hh, rx: 5 }, cx = x + w / 2, cy = y + hh / 2;
      g.rect = s("rect", { ...box, "stroke-width": 1.4 });
      g.texts = lines.map((str, i) => ctx.text(cx, lines.length > 1 ? cy + (i ? 8 : -7) : cy, str, { size: 12, mono: true, weight: i ? null : 600 }));
      g.strikes = g.texts.map(t => s("line", { x1: x + 7, x2: x + w - 7, y1: +t.getAttribute("y"), y2: +t.getAttribute("y"), "stroke-width": 1.6 }));
      g.append(s("rect", { ...box, fill: V("bg") }), g.rect, ...g.texts, ...g.strikes);
      parent.appendChild(g);
      return g;
    }
    function makeChip(st, a, i, r) {
      const c = st.L.chip, p = chipPos(st.L, a, i);
      return chipEl(st.walLayer, p.x, p.y, c.w, c.h, r.arg === null ? [r.op] : [r.op, r.arg]);
    }
    function paintChip(g, status) {
      const [fill, stroke, ink] = CHIP[status];
      paint(g.rect, { fill: V(fill), stroke: V(stroke) });
      g.texts.forEach(t => paint(t, { fill: V(ink) }));
      g.strikes.forEach(l => { show(l, status === "gone"); paint(l, { stroke: V("bad") }); });
    }

    function render(st) {
      const m = st.m;
      ACCTS.forEach(a => {
        const c = st.cards[a], pend = !!(m.tx && a in m.tx.w), back = !!m.restored[a];
        const tone = pend ? "warn" : back ? "ok" : null;
        paint(c.rect, { fill: V(tone ? tone + "-soft" : "node"), stroke: V(tone || "node-stroke") });
        c.bal.textContent = money(shown(m, a));
        paint(c.bal, { fill: V(tone || "ink") });
        c.sub.textContent = pend ? "uncommitted" + (st.L.was ? ` · was ${money(m.bal[a])}` : "") : back ? `rolled back to ${money(m.bal[a])}` : "committed";
        paint(c.sub, { fill: V(tone || "muted") });
      });
      show(st.idChip, m.idState);
      if (m.idState) paintChip(st.idChip, m.idState);
      show(st.dupText, m.dup);
      m.wal.forEach((rows, a) => rows.forEach((r, i) => paintChip(st.chips[a][i] || (st.chips[a][i] = makeChip(st, a, i, r)), r.st)));
      if (st.attLabels[1]) show(st.attLabels[1], m.at === 1);
      const total = m.bal.savings + m.bal.checking, ok = total === 1000;
      st.totalPill.say(`committed total ${money(total)} ${ok ? "✓" : "✗"}`, ok ? "ok-soft" : "bad-soft", ok ? "ok" : "bad", ok ? "ok" : "bad");
      paint(st.dbRect, { stroke: V(m.crashed ? "bad" : "line"), "stroke-width": m.crashed ? "2.5" : "1.5", "stroke-dasharray": m.crashed ? "7 5" : "none" });
      show(st.crashPill, m.crashed);
      show(st.title, !m.crashed);
      const [text, tone] = m.app;
      paint(st.app.rect, { stroke: V(tone) });
      st.app.sub.textContent = text;
      paint(st.app.sub, { fill: V(tone === "c6" ? "muted" : tone), "font-weight": tone === "c6" ? "400" : "700" });
      renderStats(m);
    }
    function renderStats(m) {
      ACCTS.forEach(a => {
        const pend = m.tx && a in m.tx.w;
        stats.set(a, money(m.bal[a]) + (pend ? ` <span style="font-size:12px;font-weight:600;color:var(--viz-warn);white-space:nowrap">(${money(m.tx.w[a])} uncommitted)</span>` : ""), "");
      });
      const total = m.bal.savings + m.bal.checking;
      stats.set("total", money(total), total === 1000 ? "ok" : "bad");
      const one = m.debits === 1 && m.credits === 1, none = m.debits + m.credits === 0;
      stats.set("dc", `${m.debits} / ${m.credits}`, one ? "ok" : none ? (m.done ? "warn" : "") : "bad");
    }

    // ---------- assembly ----------
    function build() {
      compact = ctx.compact;
      const L = layout(compact, cfg), myGen = gen;
      const svg = ctx.svg({ w: L.W, h: L.H, label: "An app moving $100 between two accounts in a database with a write-ahead log" });
      const layers = {};
      ["bg", "walLayer", "fx", "pk"].forEach(k => svg.appendChild((layers[k] = s("g"))));
      const steps = makeSteps(cfg).map(({ title, detail, line, run }) => ({
        title, detail,
        run: async st => {
          st.m.restored = {};   // a rollback's green flash lasts one step
          render(st);
          await run(st);
          if (st.gen === gen) log.add(line[0], line[1]);
        },
      }));
      stage.replaceChildren(svg);   // before init() draws, so pills can measure their text
      player = ctx.stepper({
        delay: 1500, steps,
        intro: "Invariant: Savings + Checking must always add up to <b>$1,000</b>. Press <b>Play</b> or <b>Step ▶</b>.",
        // Fully redraws the scene: Back = init() + instant replay.
        init() {
          Object.values(layers).forEach(g => g.replaceChildren());
          log.clear().add("Each step's writes, crashes and retries are listed here.", "muted");
          note.set(intro(cfg), "info");
          nextSlot.replaceChildren();
          nextSlot.style.margin = "";
          const st = { gen: myGen, L, ...layers, m: newModel() };
          drawScene(st);
          render(st);
          return st;
        },
      });
      stepSlot.replaceChildren(player.el);
    }
    function restart(keepStep) {
      const idx = keepStep && player ? player.index : -1;
      gen++;
      if (player) player.pause();
      ctx.instant = true;   // finish the old story's in-flight tweens now; live() parks its step
      build();
      const p = player;
      ctx.after(0, () => { ctx.instant = false; if (idx >= 0 && p === player) p.goto(idx); });
    }

    build();
    // Rebuild outside the ResizeObserver callback (avoids "ResizeObserver loop" errors), keeping the step.
    ctx.onResize(() => ctx.after(0, () => { if (ctx.compact !== compact) restart(true); }));
  },
});
