// Who catches the duplicate? (DDIA ch12, the end-to-end argument.) Alice pays Bob $11 through
// Browser -> App server -> Database -> Event log -> Ledger. Each per-layer dedup mechanism is a
// bracket over the part of the path it covers: TCP (one connection), a transaction (one attempt),
// Kafka exactly-once (Kafka to Kafka). Each fault makes a retry start outside one of them; a
// request id minted in the browser and checked at every write (the green bracket) catches it.
Viz.register("ch12/end-to-end-dedup", {
  title: "Who catches the duplicate?",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const V = n => `var(--viz-${n})`;
    const RID = "r-7f3";
    const FAULTS = [
      { value: "none", label: "None" }, { value: "double", label: "Double-click" },
      { value: "lost", label: "Lost reply" }, { value: "crash", label: "Consumer crash" },
    ];
    const PROTS = [{ value: "layer", label: "Per-layer only" }, { value: "e2e", label: "End-to-end ID" }];
    const BOXES = [
      { id: "browser", label: "Browser" }, { id: "app", label: "App server" }, { id: "db", label: "Database" },
      { id: "log", label: "Event log" }, { id: "ledger", label: "Ledger" },
    ];
    const IX = { browser: 0, app: 1, db: 2, log: 3, ledger: 4 };
    const COL = { browser: "c6", app: "node", db: "c1", log: "c1", ledger: "c2" };
    const soft = c => (c === "node" ? V("node") : V(c + "-soft"));
    const strong = c => (c === "node" ? V("node-stroke") : V(c));
    // Rendered width of an attached <text>; estimated when it isn't laid out (detached scene).
    const textW = t => (t.getComputedTextLength && t.getComputedTextLength()) || t.textContent.length * (+t.getAttribute("font-size")) * 0.56;

    // Desktop: boxes in a row, scope brackets stacked above them, tables below. Phone: boxes
    // stacked, brackets become vertical bars with labels in a column on the right.
    const DESK = {
      compact: false, W: 640, H: 338, fs: 12,
      // 118 wide so the longest bold status line ("commit unknown", "retry on TCP #2") keeps clear of the border.
      box: i => ({ x: 6 + 128 * i, y: 150, w: 118, h: 58 }),
      textY: { 0: [15], 1: [21, 40], 2: [15, 33, 48] },
      tcpY: [116, 134], txnY: 94, kafkaY: 64, e2eY: 34,
      email: [[600, 214], [600, 320]], receipts: [406, 322, "start"],
    };
    const PHONE = {
      compact: true, W: 360, H: 478, fs: 11,
      box: i => ({ x: 10, y: 20 + 90 * i, w: 130, h: 50 }),
      textY: { 0: [13], 1: [17, 34], 2: [12, 27, 40] },
      tcpX: [152, 160], scopeX: 176, e2eX: 194, labelX: 206,
      email: [[75, 428], [75, 446]], receipts: [75, 452, "middle"],
    };
    const cx = (L, i) => L.box(i).x + L.box(i).w / 2;
    const cy = (L, i) => L.box(i).y + L.box(i).h / 2;

    const INTRO = {
      none: "Alice pays Bob $11 and nothing goes wrong.",
      double: "Alice pays Bob $11, but the page looks frozen, so she clicks <b>Pay</b> twice.",
      lost: "Alice pays Bob $11. The COMMIT succeeds, but its reply never arrives (the book's Example 12-1).",
      crash: "Alice pays Bob $11. The ledger crashes after its side effects but before committing its Kafka offset.",
    };
    const NOTE0 = "Pick a fault and a protection, then press <b>Play</b>. Watch which bracket the retry starts outside of.";
    const SWITCH = " Now switch <b>Protection</b> to <b>End-to-end ID</b>.";
    const END = {
      none: ["No faults, no duplicates: the hard part is when something fails.", "ok"],
      double: {
        layer: ["Every layer worked as designed, and Alice paid twice. The duplicate was created <b>above</b> all of them." + SWITCH, "bad"],
        e2e: ["The ID was created at the endpoint where the intent originated, so every retry, from anywhere, is recognized.", "ok"],
      },
      lost: {
        layer: ["Two correct transactions, one intent executed twice. Two-phase commit would not help: it coordinates the database participants, not the retrying client." + SWITCH, "bad"],
        e2e: ["The request id outlived the connection that was lost: the database recognized the retry as the same intent.", "ok"],
      },
      crash: {
        layer: ["Kafka's exactly-once covers reads and writes inside Kafka; the ledger's database and the email API are outside that bracket." + SWITCH, "bad"],
        e2e: ["The receipt must be neither duplicated nor lost: skipping the redelivered event must not skip the receipt, which is why it was queued in the same transaction as processed_ids.", "ok"],
      },
    };

    let fault = "lost", prot = "layer", compact = ctx.compact;
    let view = null, player = null, live = null, busy = 0;

    const fresh = () => ({
      browser: ["Pay $11", ""], app: ["has retry logic", ""],
      alice: 100, bob: 50, pay: [], events: [], led: [], receipts: 0, offset: 0,
      tcp2: new Set(), reset: new Set(), missed: new Set(), caught: null, crash: false,
    });
    const applied = rows => rows.filter(r => r.k === "ok" || r.k === "dup").length;
    const countTone = n => (n === 0 ? "" : n === 1 ? "ok" : "bad");

    // ---------- drawing (the whole scene is repainted from the model after every change) ----------
    function bracketH(g, x1, x2, y, col, o = {}) {
      g.appendChild(s("path", { d: `M${x1},${y + 6}V${y}H${x2}V${y + 6}`, fill: "none", stroke: col, "stroke-width": o.w || 1.6, "stroke-dasharray": o.dash ? "5 4" : null }));
    }
    function bracketV(g, y1, y2, x, col, o = {}) {
      g.appendChild(s("path", { d: `M${x - 6},${y1}H${x}V${y2}H${x - 6}`, fill: "none", stroke: col, "stroke-width": o.w || 1.6, "stroke-dasharray": o.dash ? "5 4" : null }));
    }
    // Text with a rect behind it sized to the text (inserted after the text is laid out).
    function backed(g, x, y, str, o, rect) {
      const t = g.appendChild(ctx.text(x, y + 0.5, str, o)), w = textW(t) + rect.pad * 2, hh = o.size + rect.padY * 2;
      g.insertBefore(s("rect", { x: x - w / 2, y: y - hh / 2, width: w, height: hh, rx: rect.rx || 0, fill: rect.fill }), t);
    }
    const pill = (g, x, y, str, tone, fs) => backed(g, x, y, str, { size: fs, weight: 800, fill: V("bg") }, { pad: 7, padY: 3.5, rx: 9, fill: V(tone) });
    // A label sitting on a bracket line, with a background gap so the line doesn't run through it.
    const onLine = (g, x, y, str, col, fs, weight) => backed(g, x, y, str, { size: fs, fill: col, weight }, { pad: 4, padY: 2, fill: V("bg") });
    const tcpLabel = (m, i) => (m.tcp2.has(i) ? (m.reset.has(i) ? "TCP #1 reset" : "TCP #1") : "TCP");
    const scopeCol = (m, key, base) => (m.missed.has(key) ? V("bad") : base);
    const cross = (m, key) => (m.missed.has(key) ? " ✕" : "");

    function scopesDesk(st, g) {
      const L = st.L, m = st.m, fs = L.fs, mu = V("muted");
      const left = L.box(0).x, right = L.box(4).x + L.box(4).w, db = L.box(2), log = L.box(3), led = L.box(4);
      const mid = (left + right) / 2;
      if (st.e2e) {
        bracketH(g, left, right, L.e2eY, V("ok"), { w: 2.4 });
        g.appendChild(ctx.text(mid, L.e2eY - 15, `request_id ${RID} (minted in the browser, checked at every write)`, { size: fs, weight: 700, fill: V("ok") }));
        [2, 4].forEach(i => g.appendChild(s("circle", { cx: cx(L, i), cy: L.e2eY, r: 3.5, fill: V("ok") })));
        if (m.caught) pill(g, cx(L, IX[m.caught]), L.e2eY, "✓ caught", "ok", fs);
      } else {
        bracketH(g, left, right, L.e2eY, V("line"), { dash: true });
        g.appendChild(ctx.text(mid, L.e2eY - 15, "no end-to-end request id", { size: fs, fill: mu }));
      }
      // Kafka's bracket stops short of the Ledger box: the consumer's own DB and email are outside.
      const kc = scopeCol(m, "kafka", V("c1")), kEnd = led.x - 8;
      bracketH(g, log.x, kEnd, L.kafkaY, kc);
      g.appendChild(ctx.text(kEnd, L.kafkaY - 12, "Kafka exactly-once (Kafka to Kafka)" + cross(m, "kafka"), { size: fs, weight: 600, fill: kc, anchor: "end" }));
      g.appendChild(ctx.text(led.x + 10, L.kafkaY + 1, "?", { size: 17, weight: 800, fill: V("warn") }));
      g.appendChild(ctx.text(led.x + 22, L.kafkaY + 1, "outside", { size: fs, weight: 600, fill: V("warn"), anchor: "start" }));
      const tc = scopeCol(m, "txn", V("c1"));
      bracketH(g, db.x, db.x + db.w, L.txnY, tc);
      g.appendChild(ctx.text(cx(L, 2), L.txnY - 12, "transaction (one attempt)" + cross(m, "txn"), { size: fs, weight: 600, fill: tc }));
      for (let i = 0; i < 4; i++) {
        const x1 = cx(L, i) + 6, x2 = cx(L, i + 1) - 6, xm = (x1 + x2) / 2;
        bracketH(g, x1, x2, L.tcpY[0], mu, { dash: m.reset.has(i) });
        onLine(g, xm, L.tcpY[0], tcpLabel(m, i), mu, fs);
        if (!m.tcp2.has(i)) continue;
        const c = scopeCol(m, "tcp" + i, mu);
        bracketH(g, x1, x2, L.tcpY[1], c);
        onLine(g, xm, L.tcpY[1], "TCP #2" + cross(m, "tcp" + i), c, fs, 600);
      }
    }

    function scopesPhone(st, g) {
      const L = st.L, m = st.m, fs = L.fs, mu = V("muted"), lx = L.labelX;
      const label = (y, lines, col, fromX) => {
        g.appendChild(s("path", { d: `M${fromX + 3},${y}H${lx - 4}`, fill: "none", stroke: col, "stroke-width": 1, "stroke-dasharray": "1 3" }));
        lines.forEach((str, k) => g.appendChild(ctx.text(lx, y + (k - (lines.length - 1) / 2) * 13, str,
          { size: fs, weight: k ? null : 600, fill: col, anchor: "start" })));
      };
      for (let i = 0; i < 4; i++) {
        const y1 = cy(L, i) + 8, y2 = cy(L, i + 1) - 8, ym = (y1 + y2) / 2;
        bracketV(g, y1, y2, L.tcpX[0], mu, { dash: m.reset.has(i) });
        label(ym, [tcpLabel(m, i)], mu, L.tcpX[0]);
        if (!m.tcp2.has(i)) continue;
        const c = scopeCol(m, "tcp" + i, mu);
        bracketV(g, y1 + 4, y2 - 4, L.tcpX[1], c);
        label(ym + 14, ["TCP #2" + cross(m, "tcp" + i)], c, L.tcpX[1]);
      }
      const db = L.box(2), log = L.box(3), top = L.box(0).y, bot = L.box(4).y + L.box(4).h;
      const tc = scopeCol(m, "txn", V("c1")), kc = scopeCol(m, "kafka", V("c1"));
      bracketV(g, db.y, db.y + db.h, L.scopeX, tc);
      label(cy(L, 2), ["transaction" + cross(m, "txn"), "(one attempt)"], tc, L.scopeX);
      bracketV(g, log.y, log.y + log.h, L.scopeX, kc);
      label(cy(L, 3), ["Kafka exactly-once" + cross(m, "kafka"), "(Kafka to Kafka)"], kc, L.scopeX);
      g.appendChild(ctx.text(L.scopeX - 2, cy(L, 4), "?", { size: 16, weight: 800, fill: V("warn") }));
      label(cy(L, 4), ["outside Kafka's scope"], V("warn"), L.scopeX + 4);
      const ex = L.e2eX, rx = L.W - 8;
      if (st.e2e) {
        bracketV(g, top, bot, ex, V("ok"), { w: 2.4 });
        [`request_id ${RID}: minted in the`, "browser, checked at every write"].forEach((t, k) =>
          g.appendChild(ctx.text(rx, bot + 18 + 14 * k, t, { size: fs, weight: 700, fill: V("ok"), anchor: "end" })));
        [2, 4].forEach(i => g.appendChild(s("circle", { cx: ex, cy: cy(L, i), r: 3.5, fill: V("ok") })));
        if (m.caught) {
          g.appendChild(s("circle", { cx: ex, cy: cy(L, IX[m.caught]), r: 9, fill: V("ok") }));
          g.appendChild(ctx.text(ex, cy(L, IX[m.caught]) + 0.5, "✓", { size: 12, weight: 800, fill: V("bg") }));
        }
      } else {
        bracketV(g, top, bot, ex, V("line"), { dash: true });
        g.appendChild(ctx.text(rx, bot + 18, "no end-to-end request id", { size: fs, fill: mu, anchor: "end" }));
      }
    }

    function subs(st, id) {
      const m = st.m, phone = st.L.compact;
      if (id === "browser") return [m.browser];
      if (id === "app") return [m.app];
      if (id === "db") {
        const tone = m.alice < 89 ? "bad" : "";
        if (!phone) return [["Alice $" + m.alice, tone], ["Bob $" + m.bob, tone]];
        const n = applied(m.pay), rej = m.pay.length - n;
        return [[`Alice $${m.alice} · Bob $${m.bob}`, tone],
          rej ? [`${n} row · ${rej} rejected`, "ok"] : [`payments: ${n}${n > 1 ? " (dup!)" : ""}`, n > 1 ? "bad" : ""]];
      }
      const n = applied(m.led), tone = n > 1 ? "bad" : "";
      if (!phone) return [["credits: " + n, tone], ["offset: " + m.offset, ""]];
      const rej = m.led.some(r => r.k === "rej"), queued = m.led.some(r => r.k === "queued");
      return [["credits: " + n + (n > 1 ? " (dup!)" : ""), tone],
        rej ? ["redelivery rejected", "ok"] : queued ? ["receipt in outbox", "warn"] : ["offset: " + m.offset, ""]];
    }

    function logCells(st, g, b) {
      const L = st.L, cw = L.compact ? 30 : 26, ch = L.compact ? 16 : 18, gap = 5;
      const x0 = b.x + (b.w - (3 * cw + 2 * gap)) / 2, y0 = b.y + (L.compact ? 24 : 30);
      for (let k = 0; k < 3; k++) {
        const e = st.m.events[k], x = x0 + k * (cw + gap), dup = e && e.k === "dup";
        g.appendChild(s("rect", { x, y: y0, width: cw, height: ch, rx: 3, fill: !e ? V("bg") : dup ? V("bad-soft") : V("c1-soft"), stroke: !e ? V("line") : dup ? V("bad") : V("c1"), "stroke-width": 1.2 }));
        if (e) g.appendChild(ctx.text(x + cw / 2, y0 + ch / 2 + 0.5, e.t, { size: L.fs, weight: 700, fill: dup ? V("bad") : V("ink") }));
      }
    }

    function drawBox(st, g, i) {
      const L = st.L, b = L.box(i), id = BOXES[i].id, c = COL[id], mid = b.x + b.w / 2;
      const crashed = id === "ledger" && st.m.crash;
      g.appendChild(ctx.box({ ...b, fill: crashed ? V("bad-soft") : soft(c), stroke: crashed ? V("bad") : strong(c), strokeWidth: crashed ? 2.4 : 1.5 }));
      const lines = id === "log" ? [] : subs(st, id), ys = L.textY[lines.length];
      g.appendChild(ctx.text(mid, b.y + ys[0], BOXES[i].label, { size: 13, weight: 700 }));
      lines.forEach(([str, tone], k) => g.appendChild(ctx.text(mid, b.y + ys[k + 1], str, { size: L.fs, weight: tone ? 700 : null, fill: V(tone || "muted") })));
      if (id === "log") logCells(st, g, b);
      if (crashed) pill(g, mid, b.y, "CRASH", "bad", L.fs);
    }

    const ROW = {
      ok: c => [soft(c), strong(c), "", ""], dup: () => [V("bad-soft"), V("bad"), "duplicate", V("bad")],
      rej: () => [V("ok-soft"), V("ok"), "rejected: duplicate id", V("ok")],
      queued: () => [V("warn-soft"), V("warn"), "in outbox", V("warn")], sent: c => [soft(c), strong(c), "sent once ✓", V("ok")],
    };
    function tableRow(g, x, y, w, r, c) {
      const [fill, stroke, tag, tagCol] = ROW[r.k](c), rej = r.k === "rej";
      g.appendChild(s("rect", { x, y: y - 10, width: w, height: 20, rx: 5, fill, stroke, "stroke-width": 1.2, "stroke-dasharray": rej ? "4 3" : null }));
      const t = g.appendChild(ctx.text(x + 8, y + 0.5, r.t, { size: 12, anchor: "start", weight: 600, fill: rej ? V("ok") : r.k === "dup" ? V("bad") : V("ink") }));
      if (rej) g.appendChild(s("line", { x1: x + 5, x2: x + 11 + textW(t), y1: y + 0.5, y2: y + 0.5, stroke: V("ok"), "stroke-width": 1.6 }));
      if (tag) g.appendChild(ctx.text(x + w - 8, y + 0.5, tag, { size: 12, weight: 700, anchor: "end", fill: tagCol }));
    }
    // Desktop tables: a panel under the Database and one under the Ledger (which also counts receipts).
    function tablesDesk(st, g) {
      const m = st.m, L = st.L, top = 220;
      [{ x: 132, w: 258, h: 74, i: 2, title: st.e2e ? "Database: requests (id UNIQUE)" : "Database: payments", rows: m.pay },
        { x: 398, w: 238, h: 114, i: 4, title: "Ledger DB: credits", rows: m.led }].forEach(t => {
        const c = COL[BOXES[t.i].id], bx = cx(L, t.i);
        g.appendChild(s("path", { d: `M${bx},${L.box(t.i).y + L.box(t.i).h}V${top}`, stroke: strong(c), "stroke-width": 1.4, "stroke-dasharray": "3 3" }));
        g.appendChild(s("rect", { x: t.x, y: top, width: t.w, height: t.h, rx: 8, fill: V("panel"), stroke: V("line"), "stroke-width": 1 }));
        g.appendChild(ctx.text(t.x + 10, top + 14, t.title, { size: 12, weight: 700, fill: V("muted"), anchor: "start" }));
        if (!t.rows.length) g.appendChild(ctx.text(t.x + 10, top + 33, "(no rows yet)", { size: 12, fill: V("muted"), anchor: "start" }));
        t.rows.forEach((r, k) => tableRow(g, t.x + 6, top + 33 + 22 * k, t.w - 12, r, c));
      });
      g.appendChild(s("path", { d: `M404,${top + 90}H630`, stroke: V("line"), "stroke-width": 1 }));
    }

    function paint(st) {
      const g = st.dyn, L = st.L, m = st.m;
      g.replaceChildren();
      (L.compact ? scopesPhone : scopesDesk)(st, g);
      BOXES.forEach((_, i) => drawBox(st, g, i));
      if (!L.compact) tablesDesk(st, g);
      const [rx, ry, anchor] = L.receipts;
      g.appendChild(ctx.text(rx, ry, `email API: receipts sent ${m.receipts}`, { size: L.fs, weight: m.receipts ? 700 : 600, anchor, fill: m.receipts > 1 ? V("bad") : m.receipts ? V("ok") : V("muted") }));
      if (st.dead) return;
      const S = view.stats, np = applied(m.pay), nc = applied(m.led);
      S.set("alice", "$" + m.alice, m.alice === 100 ? "" : m.alice === 89 ? "ok" : "bad");
      S.set("bob", "$" + m.bob, m.bob === 50 ? "" : m.bob === 61 ? "ok" : "bad");
      S.set("pay", np, countTone(np));
      S.set("cred", nc, countTone(nc));
      S.set("rcpt", m.receipts, countTone(m.receipts));
    }

    // A message chip slides from box to box (on desktop along the TCP connection it travels on).
    function chipPath(L, a, b, conn) {
      const i = IX[a], j = IX[b];
      if (!L.compact) return [[cx(L, i), L.tcpY[conn]], [cx(L, j), L.tcpY[conn]]];
      const A = L.box(i), B = L.box(j), x = cx(L, i);
      return i < j ? [[x, A.y + A.h - 4], [x, B.y + 4]] : [[x, A.y + 4], [x, B.y + B.h - 4]];
    }
    async function chip(st, from, to, label, o = {}) {
      const L = st.L, fs = L.fs, c = o.color || COL[from], hh = fs + 7;
      const [p, q] = o.pts || chipPath(L, from, to, o.conn || 0);
      const under = s("rect", { y: -hh / 2, height: hh, rx: hh / 2, fill: V("bg") });
      const rect = s("rect", { y: -hh / 2, height: hh, rx: hh / 2, fill: soft(c), stroke: strong(c), "stroke-width": 1.4 });
      const t = ctx.text(0, 0.5, label, { size: fs, weight: 700 });
      const fit = () => { const w = textW(t) + 14; [under, rect].forEach(r => ctx.attr(r, { x: -w / 2, width: w })); };
      const g = s("g", { opacity: 0 }, under, rect, t);
      st.chips.appendChild(g);
      fit();
      const stop = o.lost ? 0.5 : 1;
      await ctx.tween({ ms: (o.ms || 650) * stop, ease: o.lost ? "out" : "inOut", onUpdate: k => {
        g.setAttribute("transform", `translate(${ctx.lerp(p[0], q[0], k * stop)},${ctx.lerp(p[1], q[1], k * stop)})`);
        g.setAttribute("opacity", Math.min(1, k * 6));
      } });
      if (o.lost) {
        ctx.attr(rect, { fill: V("bad-soft"), stroke: V("bad") });
        ctx.attr(t, { fill: V("bad") });
        t.textContent = "✕ " + label + " lost";
        fit();
        await ctx.sleep(600);
        await ctx.tween({ ms: 400, onUpdate: k => g.setAttribute("opacity", 1 - k) });
      }
      g.remove();
    }

    // ---------- scripts ----------
    function script(fault, e2e) {
      const rowOf = (n, k = "ok") => ({ t: (e2e ? RID : "pay #" + n) + " · $11", k });
      const wrap = fn => async st => { busy++; try { await fn(st); } finally { busy--; } };
      const S = (title, fn, detail) => ({ title, detail, run: wrap(fn) });
      const upd = (st, f) => { f(st.m); paint(st); };
      const seq = (...fns) => async st => { for (const f of fns) await f(st); };
      const miss = (...keys) => st => upd(st, m => keys.forEach(k => m.missed.add(k)));
      const postLabel = e2e ? "POST /pay " + RID : "POST /pay";

      const post = async st => {
        upd(st, m => { m.browser = ["waiting…", "warn"]; });
        await chip(st, "browser", "app", postLabel);
        upd(st, m => { m.app = ["got POST /pay", ""]; });
      };
      const twoPosts = async st => {
        upd(st, m => { m.browser = ["clicked twice", "warn"]; });
        await Promise.all([chip(st, "browser", "app", postLabel), ctx.sleep(350).then(() => {
          upd(st, m => m.tcp2.add(0));
          return chip(st, "browser", "app", postLabel, { conn: 1 });
        })]);
        upd(st, m => { m.app = ["2 × POST /pay", "warn"]; });
      };
      const txn = (conn = 0) => st => chip(st, "app", "db", "BEGIN…COMMIT", { conn });
      const apply = (n, k = "ok") => st => upd(st, m => {
        m.alice -= 11; m.bob += 11; m.pay.push(rowOf(n, k)); m.app = ["awaiting reply", ""];
      });
      const reject = st => upd(st, m => { m.pay.push({ t: RID + " · $11", k: "rej" }); m.caught = "db"; });
      const reply = (dbConn, brConn, stored) => async st => {
        await chip(st, "db", "app", stored ? "unique violation" : "COMMIT OK", { conn: dbConn });
        await chip(st, "app", "browser", stored ? "200 OK (stored)" : "200 OK", { conn: brConn, color: "ok" });
        upd(st, m => { m.browser = ["Paid ✓", "ok"]; m.app = [stored ? "sent stored OK" : "replied 200 OK", stored ? "ok" : ""]; });
      };
      const lose = async st => {
        await chip(st, "db", "app", "COMMIT OK", { lost: true });
        upd(st, m => { m.reset.add(1); m.app = ["commit unknown", "warn"]; });
      };
      const retry = async st => {
        upd(st, m => { m.tcp2.add(1); m.app = ["retry on TCP #2", "warn"]; });
        await txn(1)(st);
      };
      const publish = (n, k = "ok") => async st => {
        await chip(st, "db", "log", "PaymentMade");
        upd(st, m => m.events.push({ t: "e" + n, k }));
      };
      const deliver = (n, k = "ok", conn = 0) => async st => {
        await chip(st, "log", "ledger", "PaymentMade", { conn });
        upd(st, m => { m.led.push(rowOf(n, k)); if (e2e) m.led.push({ t: "receipt " + RID, k: "queued" }); });
      };
      const redelivered = async st => {
        await chip(st, "log", "ledger", "PaymentMade", { conn: 1 });
        upd(st, m => { m.led.push({ t: RID + " · $11", k: "rej" }); m.caught = "ledger"; });
      };
      const receipt = async st => {
        await chip(st, "ledger", null, e2e ? "receipt, key " + RID : "receipt", { pts: st.L.email, color: "c2" });
        upd(st, m => { m.receipts++; const q = m.led.find(r => r.k === "queued"); if (q) q.k = "sent"; });
      };
      const ack = (conn = 0) => async st => {
        await chip(st, "ledger", "log", "commit offset", { conn });
        upd(st, m => { m.offset = m.events.length; });
      };
      const crash = async st => { upd(st, m => { m.crash = true; }); await ctx.sleep(500); };
      const restart = st => upd(st, m => { m.crash = false; m.tcp2.add(3); });

      const start = [
        S("Browser POSTs <b>pay $11</b> to the app server.", post,
          e2e ? `It carries <b>request_id ${RID}</b>, minted when the payment form was rendered.` : null),
        S(e2e ? `The app runs one transaction: INSERT ${RID} into requests, debit Alice, credit Bob. COMMIT.`
          : "The app runs one transaction: debit Alice, credit Bob, insert payment. COMMIT.", seq(txn(), apply(1)), "Alice $89, Bob $61."),
        S("OK travels back; the browser shows <b>Paid</b>.", reply(0, 0)),
        S("The payment event is published to the log.", publish(1), "Through an outbox / change data capture, so the log matches what the database committed."),
      ];
      const e2eLedger = `Credit, processed id ${RID} and the queued receipt commit in one local transaction; the receipt goes out with ${RID} as its idempotency key.`;
      if (fault === "none") {
        return [...start, S("The ledger consumes it, writes one credit, sends one receipt, commits its offset.", seq(deliver(1), receipt, ack()), e2e ? e2eLedger : null)];
      }
      if (fault === "double") {
        return e2e ? [
          S(`When the payment form was rendered, the browser got request_id <b>${RID}</b>. Both clicks send it.`, twoPosts),
          S(`Attempt 1: INSERT ${RID} into requests (UNIQUE), then debit and credit, COMMIT.`, seq(txn(), apply(1)), "Alice $89, Bob $61."),
          S(`Attempt 2: INSERT ${RID} violates the unique constraint; the transaction aborts and the app returns the stored result of attempt 1.`,
            seq(txn(), reject, miss("tcp0", "txn"), reply(0, 1, true)), "TCP and the transaction still can't tell; the request id can."),
          S(`One event, carrying ${RID}, is published.`, publish(1)),
          S(`The ledger records ${RID} with the credit in one transaction; any redelivery would be rejected the same way.`, seq(deliver(1), receipt, ack()), e2eLedger),
        ] : [
          S("Alice clicks <b>Pay</b>; the page seems frozen, so she clicks again: two separate HTTP requests on two TCP connections.", twoPosts),
          S("To TCP the second click is new data, not a retransmission (here it even travels on a second connection), so there is nothing to deduplicate.",
            seq(miss("tcp0"), () => ctx.sleep(300))),
          S("The database sees two different transactions; both are valid, both commit.",
            seq(txn(), apply(1), txn(), apply(2, "dup"), miss("txn"), reply(0, 1)), "Alice $78, Bob $72: two payment rows."),
          S("Two PaymentMade events are published (each exactly once!).", seq(publish(1), publish(2, "dup"), miss("kafka"))),
          S("The ledger credits twice and sends two receipts.", seq(deliver(1), deliver(2, "dup"), receipt, receipt, ack())),
        ];
      }
      if (fault === "lost") {
        const common = [
          S("The COMMIT acknowledgment is lost when the database connection resets.", lose),
          S("The app server cannot tell whether the commit happened; its retry logic reconnects to the database (<b>TCP #2</b>) and runs the transaction again.", retry),
        ];
        return e2e ? [
          S(`Browser POSTs <b>pay $11</b> with request_id <b>${RID}</b>.`, post),
          S(`The transaction commits in the database: INSERT ${RID} into requests, debit, credit. Alice $89.`, seq(txn(), apply(1))),
          ...common,
          S(`The retry carries ${RID}; the INSERT into requests fails on the unique constraint, so nothing moves twice; the app reads the stored result of attempt 1 and returns OK to the browser.`,
            seq(reject, miss("tcp1", "txn"), reply(1, 0, true))),
          S(`One PaymentMade event, carrying ${RID}, is published.`, publish(1)),
          S(`The ledger records ${RID} with its credit in one transaction and sends one receipt.`, seq(deliver(1), receipt, ack()), e2eLedger),
        ] : [
          S("Browser POSTs <b>pay $11</b>.", post),
          S("The transaction commits in the database: <b>Alice $89</b>.", seq(txn(), apply(1))),
          ...common,
          S("A brand-new transaction runs and commits: <b>Alice $78</b>.", seq(apply(2, "dup"), miss("tcp1", "txn"), reply(1, 0)),
            "Atomicity guaranteed each attempt was all-or-nothing, but it can't know the first attempt already happened. Alice sees a single Paid."),
          S("Downstream, both payments are real: two PaymentMade events are published.", seq(publish(1), publish(2, "dup"), miss("kafka"))),
          S("The ledger credits Bob twice and sends two receipts.", seq(deliver(1), deliver(2, "dup"), receipt, receipt, ack())),
        ];
      }
      const crashStep = S("<b>CRASH</b> before committing its Kafka offset.", crash,
        e2e ? "Credit, processed id and queued receipt are already committed in the ledger's database." : "The credit and the receipt already happened, outside Kafka.");
      return e2e ? [...start,
        S(`In one local transaction the ledger inserts ${RID} into processed_ids, writes the credit row, and queues the receipt in an outbox table.`, deliver(1)),
        crashStep,
        S(`On restart it re-reads the event; ${RID} is already in processed_ids, so the event is skipped. The outbox relay sends the receipt once, passing ${RID} to the email provider as an idempotency key.`,
          seq(restart, redelivered, miss("kafka", "tcp3"), receipt, ack(1))),
      ] : [...start,
        S("The ledger writes the credit to its own database and calls the email API: receipt sent.", seq(deliver(1), receipt)),
        crashStep,
        S("On restart it re-reads PaymentMade from the last committed offset and processes it again: a second credit row and a second receipt.",
          seq(restart, deliver(1, "dup", 1), miss("kafka", "tcp3"), receipt, ack(1))),
      ];
    }

    // ---------- scene, stepper and controls ----------
    function initScene() {
      if (live) live.dead = true;
      const L = view.L;
      const svg = ctx.svg({ w: L.W, h: L.H, label: "A payment flows from the browser through the app server, database and event log to the ledger, with the scope of each duplicate-suppression mechanism drawn as a bracket" });
      const dyn = s("g"), chips = s("g");
      svg.append(dyn, chips);
      view.stage.replaceChildren(svg);
      const st = { L, dyn, chips, e2e: prot === "e2e", m: fresh() };
      live = st;
      paint(st);
      return st;
    }

    function setNote(n, i) {
      const end = fault === "none" ? END.none : END[fault][prot];
      if (i === n - 1) view.note.set(...end);
      else if (i < 0) view.note.set(NOTE0, "info");
      else {
        const prots = prot === "e2e" ? `Every attempt carries request_id ${RID}.` : "Only the per-layer mechanisms are on.";
        view.note.set(`<b>This run:</b> ${INTRO[fault]} ${prots}` + (fault === "none" ? "" : " Watch which bracket the retry starts outside of."), "info");
      }
    }

    // Replaces the stepper (fault/protection changed, or layout switched) and resets the scene.
    function newPlayer(at = -1) {
      if (player) {
        if (busy) ctx.instant = true; // finish the old step at once; its stepper turns instant off again
        player.pause();
      }
      const steps = script(fault, prot === "e2e");
      const p = ctx.stepper({
        init: initScene, steps, delay: 1200,
        intro: INTRO[fault] + " Press <b>Play</b> or <b>Step ▶</b>.",
        onStep: i => { if (p === player) setNote(steps.length, i); },
      });
      player = p;
      view.slot.replaceChildren(p.el);
      setNote(steps.length, -1);
      if (at >= 0) p.goto(Math.min(at, steps.length - 1));
    }

    function build() {
      compact = ctx.compact;
      const at = player ? player.index : -1;
      const faultSeg = ui.segmented({ label: "Fault", options: FAULTS, value: fault, onChange: v => { if (v !== fault) { fault = v; newPlayer(); } } });
      const protSeg = ui.segmented({ label: "Protection", options: PROTS, value: prot, onChange: v => { if (v !== prot) { prot = v; newPlayer(); } } });
      const stats = ui.stats([
        { key: "alice", label: "Alice", value: "$100" }, { key: "bob", label: "Bob", value: "$50" },
        { key: "pay", label: "Payment rows", value: 0 }, { key: "cred", label: "Ledger credits", value: 0 },
        { key: "rcpt", label: "Receipts sent", value: 0 },
      ]);
      const legend = ui.legend([
        { color: V("c6"), label: "client", shape: "square" },
        { color: V("c1"), label: "database / log", shape: "square" },
        { color: V("c2"), label: "downstream consumer", shape: "square" },
        { color: V("muted"), label: "per-layer dedup scope", shape: "line" },
        { color: V("ok"), label: "end-to-end request id", shape: "line" },
        { color: V("bad"), label: "✕ scope the duplicate got past", shape: "line" },
      ]);
      view = { L: compact ? PHONE : DESK, stage: h("div"), slot: h("div"), stats, note: ui.note("") };
      root.replaceChildren(ui.bar(faultSeg, protSeg), view.stage, legend, view.slot, stats, view.note);
      newPlayer(at);
    }

    build();
    // Rebuild with the other layout when the frame crosses the phone breakpoint; the step is kept.
    ctx.onResize(() => { if (ctx.compact !== compact) build(); });
  },
});
