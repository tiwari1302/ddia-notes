// Two-phase commit sandbox. A participant's YES vote is a promise it can't take back, and the
// coordinator's logged decision is the commit point. Crash the coordinator at different moments
// to leave participants in doubt (holding locks), recover it, or force a heuristic abort.
Viz.register("ch9/two-phase-commit", {
  title: "Two-phase commit and the in-doubt window",
  mount(root, ctx) {
    const { s, ui } = ctx;
    const PARTS = [
      { name: "Orders DB", short: "Orders", row: "order#42" },
      { name: "Payments DB", short: "Payments", row: "acct#7" },
      { name: "Inventory DB", short: "Inventory", row: "sku#9" },
    ];
    const PAY = 1, INV = 2, MS = 450, GAP = 250;
    const PHASES = ["execute: writes, locks", "phase 1: PREPARE", "phase 1: votes", "phase 2: log decision ★", "phase 2: send decision"];
    // participant state -> [desktop text, phone lines, tone]
    const LOOK = {
      idle: ["idle", ["idle"], "muted"],
      working: ["working", ["working"], "ink"],
      prepared: ["PREPARED · in doubt", ["PREPARED", "in doubt"], "warn"],
      committed: ["COMMITTED", ["COMMITTED"], "ok"],
      aborted: ["ABORTED", ["ABORTED"], "bad"],
      heur: ["ABORTED (heuristic)", ["ABORTED", "(heuristic)"], "bad"],
    };
    const CRASHES = [
      { value: "never", label: "Never" },
      { value: "prepare", label: "After sending PREPARE" },
      { value: "votes", label: "After the votes, before logging" },
      { value: "midsend", label: "After logging, mid-send (only Orders hears)" },
    ];

    // ---------- state (survives layout rebuilds) ----------
    const cfg = { vote: "yes", crash: "never" };
    let clock = 0, gen = 0, running = false, flashing = false;
    let nextTx, parts, coord, diskLog, cur, tx99;
    let view = null, compact = ctx.compact;

    function resetState() {
      gen++; running = false; nextTx = 42; tx99 = null; flashing = false;
      parts = PARTS.map(p => ({ ...p, state: "committed", vote: "yes", acked: true, lockSince: null }));
      coord = { crashed: false, status: "idle" };
      diskLog = [{ tx: "tx41", kind: "COMMIT" }];
      cur = newTx("tx41", { decision: "commit", phase: 5, first: true });
    }

    // ---------- helpers ----------
    const newTx = (id, more) => ({ id, decision: null, phase: 1, crashAt: 0, heur: false, recovered: false, presumed: false, hold: 0, resent: [], ...more });
    const list = a => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
    const shorts = ps => list(ps.map(p => p.short));
    const inState = (...st) => parts.filter(p => st.includes(p.state));
    const secs = t => t.toFixed(1) + (compact ? "s" : " s");
    const toneFill = t => (t === "muted" || t === "ink" ? "var(--viz-node)" : `var(--viz-${t}-soft)`);
    const toneStroke = t => (t === "muted" || t === "ink" ? "var(--viz-node-stroke)" : `var(--viz-${t})`);
    const toneInk = t => `var(--viz-${t})`;
    const resolved = () => !coord.crashed && !inState("working", "prepared").length;

    function outcome() {
      const c = inState("committed").length, a = inState("aborted", "heur").length;
      if (c && a) return { key: "inconsistent", label: "INCONSISTENT", tone: "bad", c, a };
      if (inState("prepared").length) return { key: "doubt", label: "In doubt", tone: "warn" };
      if (c === 3) return { key: "committed", label: "Committed", tone: "ok" };
      if (a === 3) return { key: "aborted", label: "Aborted", tone: "info" };
      return { key: "none", label: "–", tone: "" };
    }

    // ---------- controls (built once; only the SVG is rebuilt on breakpoint change) ----------
    const voteSeg = ui.segmented({
      label: "Payments votes", value: "yes",
      options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      onChange: v => { cfg.vote = v; },
    });
    const crashSel = ui.select({ label: "Coordinator crashes", options: CRASHES, value: "never", onChange: v => { cfg.crash = v; } });
    // Long option labels: let the select wrap under its label and shrink on phones.
    Object.assign(crashSel.style, { flexWrap: "wrap", maxWidth: "100%" });
    crashSel.querySelector("select").style.maxWidth = "100%";
    const btnRun = ui.button("▶ Run tx42", () => runTx(), { kind: "primary" });
    const btnRecover = ui.button("Recover coordinator", () => recover(), { kind: "ok" });
    const btnTx99 = ui.button("tx99 updates acct#7", () => startTx99(), { title: "Another transaction needs Payments' row acct#7" });
    const btnHeur = ui.button("Admin: heuristic abort on Inventory", () => heuristic(), { kind: "danger" });
    const btnReset = ui.button("Reset", () => reset(), { kind: "ghost" });
    const stats = ui.stats([["outcome", "Outcome"], ["locks", "Locks held"], ["doubt", "In doubt"], ["blocked", "Blocked txns"]]
      .map(([key, label]) => ({ key, label })));
    const note = ui.note("");
    const log = ui.log({ title: "What happened", height: 120 });
    const holder = ctx.h("div");
    root.append(
      ui.bar(voteSeg, crashSel),
      ui.bar(btnRun, btnRecover, btnTx99, btnHeur, btnReset),
      holder,
      stats, note,
      ui.legend([
        { color: "var(--viz-c1)", label: "coordinator / PREPARE" },
        { color: "var(--viz-ok)", label: "YES / COMMIT" },
        { color: "var(--viz-bad)", label: "NO / ABORT" },
        { color: "var(--viz-warn)", label: "in doubt, lock held", shape: "square" },
        { color: "var(--viz-c6)", label: "client writes, other transaction" },
      ]),
      log,
    );
    const say = (html, tone) => note.set(html, tone);

    // ---------- scene ----------
    function geom() {
      return compact ? {
        W: 360, H: 310, fs: 11, coord: [100, 8, 160, 48], strip: [60, 62, 240, 50], gap: 13,
        px: [4, 123, 242], py: 212, pw: 114, ph: 92, ports: [80, 180, 280],
        tx99: [186, 148, 88, 34], banner: [4, 188, 352, 18],
      } : {
        W: 640, H: 300, fs: 12, coord: [220, 12, 200, 52], strip: [220, 70, 200, 52], gap: 15,
        px: [12, 225, 438], py: 196, pw: 190, ph: 94, ports: [240, 320, 400],
        tx99: [336, 152, 100, 38], banner: [12, 165, 286, 22],
      };
    }
    const port = i => [view.g.ports[i], view.g.strip[1] + view.g.strip[3]];
    const top = i => [view.g.px[i] + view.g.pw / 2, view.g.py];

    // A box with an opaque underlay, so soft fills hide the wires behind them.
    function rect(parent, x, y, w, h, rx = 8) {
      parent.appendChild(s("rect", { x, y, width: w, height: h, rx, fill: "var(--viz-bg)" }));
      const r = s("rect", { x, y, width: w, height: h, rx, "stroke-width": 1.5 });
      parent.appendChild(r);
      return r;
    }
    const label = (parent, x, y, str, o) => { const t = ctx.text(x, y, str, o); parent.appendChild(t); return t; };

    function buildScene() {
      compact = ctx.compact;
      const g = geom(), fs = g.fs;
      const svg = ctx.svg({ w: g.W, h: g.H, label: "A coordinator with its disk log sends 2PC messages to three participant databases" });
      const wires = s("g"), scene = s("g"), packets = s("g");
      svg.append(wires, scene, packets);
      view = { g, packets };
      PARTS.forEach((_, i) => {
        const [x1, y1] = port(i), [x2, y2] = top(i);
        wires.appendChild(s("line", { x1, y1, x2, y2, stroke: "var(--viz-line)", "stroke-width": 1.2, "stroke-dasharray": "3 4" }));
      });

      const [cx, cy, cw, ch] = g.coord;
      view.cRect = rect(scene, cx, cy, cw, ch);
      view.cTitle = label(scene, cx + cw / 2, cy + ch / 2 - 8, "Coordinator", { size: 13, weight: 700 });
      view.cSub = label(scene, cx + cw / 2, cy + ch / 2 + 10, "", { size: fs });

      const [lx, ly, lw, lh] = g.strip;
      ctx.attr(rect(scene, lx, ly, lw, lh, 4), { fill: "var(--viz-panel)", stroke: "var(--viz-node-stroke)" });
      view.flash = s("rect", { x: lx + 6, width: lw - 12, height: g.gap + 1, rx: 3, fill: "var(--viz-ok-soft)", stroke: "var(--viz-ok)" });
      scene.appendChild(view.flash);
      view.lineY = k => ly + lh / 2 + (k - 1) * g.gap;
      view.lines = [0, 1, 2].map(k => label(scene, lx + lw / 2, view.lineY(k), "", { size: fs, mono: true }));
      const muted = { size: fs, fill: "var(--viz-muted)" };
      if (compact) {
        label(scene, 6, 50, "log on disk ↓", { ...muted, anchor: "start" });
        label(scene, 354, 50, "★ commit point", { ...muted, anchor: "end" });
      } else {
        label(scene, lx - 10, view.lineY(0), "coordinator log", { ...muted, anchor: "end", weight: 700 });
        label(scene, lx - 10, view.lineY(1), "on disk: survives crashes", { ...muted, anchor: "end" });
        label(scene, lx - 10, view.lineY(2), "★ = the commit point", { ...muted, anchor: "end" });
        view.phases = PHASES.map((txt, k) => {
          const y = 20 + k * 21;
          return { glyph: label(scene, 452, y, "", { size: 12, weight: 700 }), text: label(scene, 466, y, txt, { size: 12, anchor: "start" }) };
        });
      }

      view.parts = PARTS.map((p, i) => {
        const x = g.px[i], y = g.py, w = g.pw, mx = x + w / 2;
        const e = { rect: rect(scene, x, y, w, g.ph) };
        e.name = label(scene, mx, y + 18, compact ? p.short : p.name, { size: 13, weight: 700 });
        e.st1 = label(scene, mx, y + (compact ? 40 : 44), "", { size: fs, weight: 700 });
        e.st2 = compact ? label(scene, mx, y + 54, "", { size: fs, weight: 700 }) : null;
        e.lock = label(scene, mx, y + g.ph - (compact ? 16 : 20), "", { size: fs, mono: true });
        return e;
      });

      const [tx, ty, tw, th] = g.tx99;
      view.t99 = s("g");
      ctx.attr(rect(view.t99, tx, ty, tw, th, 6), { fill: "var(--viz-c6-soft)", stroke: "var(--viz-c6)" });
      label(view.t99, tx + tw / 2, ty + th / 2 - 8, "tx99 → acct#7", { size: fs, weight: 700 });
      view.t99s = label(view.t99, tx + tw / 2, ty + th / 2 + 8, "", { size: fs });
      scene.appendChild(view.t99);

      const [bx, by, bw, bh] = g.banner;
      view.banner = s("g");
      ctx.attr(rect(view.banner, bx, by, bw, bh, 5), { fill: "var(--viz-bad-soft)", stroke: "var(--viz-bad)" });
      view.bannerText = label(view.banner, bx + bw / 2, by + bh / 2, "", { size: fs, weight: 700, fill: "var(--viz-bad)" });
      scene.appendChild(view.banner);

      holder.replaceChildren(svg);
      render();
    }

    function phaseLook(k) {
      if (coord.crashed && k >= cur.crashAt) return k === cur.crashAt ? ["✕", "bad"] : ["○", "muted"];
      if (k < cur.phase || (k === cur.phase && !running)) return ["✓", "ok"];
      if (k === cur.phase) return ["●", "c1"];
      return ["○", "muted"];
    }

    function render() {
      const v = view, dead = coord.crashed;
      ctx.attr(v.cRect, {
        fill: dead ? "var(--viz-node)" : "var(--viz-c1-soft)", stroke: dead ? "var(--viz-muted)" : "var(--viz-c1)",
        "stroke-dasharray": dead ? "5 4" : "none",
      });
      ctx.attr(v.cTitle, { fill: dead ? "var(--viz-bad)" : "var(--viz-ink)" });
      v.cSub.textContent = dead ? "CRASHED" : coord.status;
      ctx.attr(v.cSub, { fill: dead ? "var(--viz-bad)" : "var(--viz-muted)", "font-weight": dead ? 700 : 400 });

      const shown = diskLog.slice(-3);
      v.lines.forEach((t, k) => {
        const e = shown[k], now = e && e.tx === cur.id;
        t.textContent = e ? `${e.tx} ${e.kind}${e.kind === "COMMIT" ? " ★" : ""}${e.presumed ? " (presumed)" : ""}` : "";
        ctx.attr(t, { fill: !now ? "var(--viz-muted)" : e.kind === "COMMIT" ? "var(--viz-ok)" : "var(--viz-bad)", "font-weight": now ? 700 : 400 });
      });
      ctx.attr(v.flash, { y: v.lineY(shown.length - 1) - v.g.gap / 2 - 0.5, opacity: flashing ? 1 : 0 });
      if (v.phases) v.phases.forEach((ph, i) => {
        const [glyph, tone] = phaseLook(i + 1);
        ph.glyph.textContent = glyph;
        ctx.attr(ph.glyph, { fill: toneInk(tone) });
        ctx.attr(ph.text, { fill: tone === "muted" ? "var(--viz-muted)" : "var(--viz-ink)", "font-weight": tone === "c1" || tone === "bad" ? 700 : 400 });
      });

      parts.forEach((p, i) => {
        const e = v.parts[i];
        const [one, two, tone] = LOOK[p.state];
        const lines = cur.first ? (compact ? ["COMMITTED", "(tx41)"] : ["COMMITTED (tx41)"]) : compact ? two : [one];
        ctx.attr(e.rect, { fill: toneFill(tone), stroke: toneStroke(tone), "stroke-dasharray": p.state === "heur" ? "5 4" : "none" });
        [e.st1, e.st2].forEach((t, k) => { if (t) { t.textContent = lines[k] || ""; ctx.attr(t, { fill: toneInk(tone) }); } });
        if (compact) ctx.attr(e.st1, { y: v.g.py + (lines[1] ? 40 : 47) });
        const held = p.lockSince !== null;
        e.lock.textContent = !held ? "no locks" : compact ? `${p.row} ${secs(clock - p.lockSince)}` : `lock ${p.row} · ${secs(clock - p.lockSince)}`;
        ctx.attr(e.lock, { fill: held ? "var(--viz-warn)" : "var(--viz-muted)", "font-weight": held ? 700 : 400 });
      });

      v.t99.style.display = tx99 ? "" : "none";
      if (tx99) {
        v.t99s.textContent = tx99.done ? "updated ✓" : `waiting ${secs(clock - tx99.since)}`;
        ctx.attr(v.t99s, { fill: tx99.done ? "var(--viz-ok)" : "var(--viz-warn)", "font-weight": 700 });
      }
      const o = outcome();
      v.banner.style.display = o.key === "inconsistent" ? "" : "none";
      if (o.c) v.bannerText.textContent = `atomicity broken: ${o.c} committed, ${o.a} aborted`;

      stats.set("outcome", o.label, o.tone);
      const held = parts.filter(p => p.lockSince !== null);
      const longest = Math.max(0, ...held.map(p => clock - p.lockSince));
      stats.set("locks", held.length ? `${held.length} · ${longest.toFixed(1)} s` : "0", held.length && coord.crashed ? "warn" : "");
      const doubt = inState("prepared").length;
      stats.set("doubt", String(doubt), doubt ? "warn" : "");
      const blocked = tx99 && !tx99.done ? 1 : 0;
      stats.set("blocked", String(blocked), blocked ? "warn" : "");

      const runLabel = running ? `${cur.id} in progress…` : `▶ Run tx${nextTx}`;
      if (btnRun.textContent !== runLabel) btnRun.setLabel(runLabel);
      btnRun.disable(running || !resolved());
      btnRecover.disable(!coord.crashed || running);
      btnTx99.disable(blocked === 1);
      btnHeur.disable(parts[INV].state !== "prepared");
    }

    // ---------- protocol ----------
    function fly(from, to, text, color, lost) {
      return ctx.fly(view.packets, { from, to, label: text, fill: `var(--viz-${color})`, ms: MS, labelSize: view.g.fs, lost });
    }
    function lock(p) { p.lockSince = clock; }
    function release(p) {
      if (p.lockSince === null) return;
      cur.hold = Math.max(cur.hold, clock - p.lockSince);
      p.lockSince = null;
      if (p === parts[PAY]) tx99Released();
    }
    function writeLog(kind, presumed) {
      diskLog.push({ tx: cur.id, kind, presumed });
      flashing = true;
      ctx.after(600, () => { flashing = false; render(); });
    }
    // at = the protocol phase the crash interrupts (marked ✕ in the phase list)
    function crash(at) {
      coord.crashed = true;
      cur.crashAt = at;
      log.add("✕ coordinator CRASHED", "bad");
      say("<b>The coordinator just crashed.</b>", "bad");
      render();
    }
    function finish() {
      running = false;
      say(...summary());
      render();
    }

    function deliver(p, d) {
      p.acked = true;
      const D = d.toUpperCase();
      if (p.state === "prepared") {
        p.state = d === "commit" ? "committed" : "aborted";
        release(p);
        log.add(`${p.short}: ${D} applied, ${p.row} unlocked`, d === "commit" ? "ok" : "info");
      } else if (p.state === "heur") {
        log.add(d === "commit" ? `${p.short} can't apply COMMIT: it already aborted (heuristic)` : `${p.short} had already aborted (heuristic)`, d === "commit" ? "bad" : "muted");
      }
      render();
    }

    // Decision to each target, Orders first, the rest 150 ms apart.
    function sendDecision(targets, d, live) {
      return Promise.all(targets.map(async (p, k) => {
        await ctx.sleep(k * 150);
        if (!live()) return;
        const i = parts.indexOf(p);
        await fly(port(i), top(i), d === "commit" ? "COMMIT" : "ABORT", d === "commit" ? "ok" : "bad");
        if (live()) deliver(p, d);
      }));
    }

    async function runTx() {
      if (running || !resolved()) return;
      const my = ++gen, live = () => my === gen && ctx.alive;
      const wait = async ms => { await ctx.sleep(ms); return live(); };
      running = true;
      cur = newTx("tx" + nextTx++, { vote: cfg.vote, crash: cfg.crash });
      const id = cur.id;
      parts.forEach(p => Object.assign(p, { state: "idle", vote: null, acked: false }));
      coord.status = `${id} · executing`;
      log.add(`${id} begins: writes order#42, acct#7, sku#9`, "muted");
      say(`<b>${id}</b> starts as an ordinary local transaction on each database: each writes its row and takes a row lock. Until a database votes YES, it may still abort on its own.`, "info");
      render();

      // 1) execute
      await Promise.all(parts.map((p, i) => fly(port(i), top(i), "write", "c6").then(() => {
        if (live()) { p.state = "working"; lock(p); render(); }
      })));
      if (!live() || !(await wait(GAP))) return;

      // 2) PREPARE (a crash here happens right after the packets leave)
      cur.phase = 2;
      coord.status = `${id} · collecting votes`;
      log.add(`coordinator → all: PREPARE ${id}`, "info");
      say(`Phase 1: the coordinator sends <b>PREPARE</b>. To vote YES, a database must be able to commit no matter what: it checks constraints and writes ${id}'s changes plus a prepare record to disk. From then on it has given up the right to abort.`, "info");
      render();
      const prep = parts.map((p, i) => fly(port(i), top(i), "PREPARE", "c1"));
      if (cur.crash === "prepare") crash(3);
      await Promise.all(prep);
      if (!live()) return;

      // 3) each participant makes its promise (or refuses), then votes
      cur.phase = 3;
      parts.forEach((p, i) => {
        if (i === PAY && cur.vote === "no") {
          Object.assign(p, { state: "aborted", vote: "no", acked: true });
          release(p);
          log.add("Payments votes NO and aborts at once (acct#7 unlocked)", "bad");
        } else {
          Object.assign(p, { state: "prepared", vote: "yes" });
          log.add(`${p.short}: prepare record on disk, votes YES`, "ok");
        }
      });
      render();
      if (!(await wait(GAP))) return;
      const lost = coord.crashed ? 0.5 : undefined;
      await Promise.all(parts.map((p, i) => fly(top(i), port(i), p.vote === "yes" ? "YES" : "NO", p.vote === "yes" ? "ok" : "bad", lost)));
      if (!live()) return;
      if (coord.crashed) { log.add("votes lost: the coordinator is down", "muted"); return finish(); }
      log.add("coordinator has all 3 votes", "muted");
      if (!(await wait(GAP))) return;

      // 4) the decision, made durable: the commit point
      cur.phase = 4;
      if (cur.crash === "votes") { crash(4); return finish(); }
      const d = cur.decision = parts.every(p => p.vote === "yes") ? "commit" : "abort";
      writeLog(d === "commit" ? "COMMIT" : "ABORT");
      coord.status = `${id} · decided ${d.toUpperCase()}`;
      if (d === "commit") {
        log.add(`log ← ${id} COMMIT ★ (commit point)`, "ok");
        say(`Phase 2: all three voted YES, so the coordinator writes <b>COMMIT</b> to its own log. That disk write is the <b>commit point</b>: from here on ${id} will commit, whatever crashes.`, "ok");
      } else {
        log.add(`log ← ${id} ABORT`, "info");
        say("Phase 2: Payments voted NO, so the coordinator writes <b>ABORT</b> to its log. Payments has already rolled back; the others roll back when ABORT reaches them.", "info");
      }
      render();
      if (!(await wait(GAP + 300))) return;

      // 5) tell everyone who voted YES
      cur.phase = 5;
      render();
      const targets = parts.filter(p => p.vote === "yes");
      if (cur.crash === "midsend") {
        await sendDecision(targets.slice(0, 1), d, live);
        if (!live()) return;
        crash(5);
      } else {
        await sendDecision(targets, d, live);
        if (!live()) return;
      }
      finish();
    }

    async function recover() {
      if (!coord.crashed || running) return;
      const my = gen, live = () => my === gen && ctx.alive;
      const wait = async ms => { await ctx.sleep(ms); return live(); };
      running = true;
      coord.crashed = false;
      coord.status = `${cur.id} · reading its log`;
      log.add("coordinator restarts and reads its log", "info");
      say("The coordinator restarts and reads its log to find out what it had decided.", "info");
      render();
      if (!(await wait(600))) return;
      let d = cur.decision;
      cur.phase = 4;
      if (d) {
        log.add(`log has ${cur.id} ${d.toUpperCase()}: resend it`, d === "commit" ? "ok" : "info");
      } else {
        d = cur.decision = "abort";
        cur.presumed = true;
        writeLog("ABORT", true);
        log.add(`no decision for ${cur.id} in the log → presumed abort`, "info");
      }
      coord.status = `${cur.id} · decided ${d.toUpperCase()}`;
      render();
      if (!(await wait(GAP + 300))) return;
      cur.phase = 5;
      render();
      cur.resent = parts.filter(p => p.vote === "yes" && !p.acked);
      await sendDecision(cur.resent, d, live);
      if (!live()) return;
      cur.recovered = true;
      finish();
    }

    function heuristic() {
      const p = parts[INV];
      if (p.state !== "prepared") return;
      p.state = "heur";
      cur.heur = true;
      release(p);
      log.add("admin: heuristic abort on Inventory (sku#9 unlocked)", "bad");
      say(...summary());
      render();
    }

    // tx99 needs Payments' row; it waits exactly while acct#7 is locked.
    function startTx99() {
      const t = tx99 = { since: clock, done: false };
      if (parts[PAY].lockSince === null) finishTx99(t);
      else log.add(`tx99 blocked: acct#7 is locked by ${cur.id}`, "warn");
      render();
    }
    function tx99Released() {
      const t = tx99;
      if (!t || t.done) return;
      ctx.after(300, () => { if (tx99 === t && !t.done && parts[PAY].lockSince === null) finishTx99(t); });
    }
    function finishTx99(t) {
      t.done = true;
      const waited = clock - t.since;
      log.add(waited > 0.05 ? `tx99 got acct#7 after waiting ${waited.toFixed(1)} s` : "tx99 updated acct#7 at once (no lock held)", "ok");
      ctx.after(2000, () => { if (tx99 === t) { tx99 = null; render(); } });
      render();
    }

    // ---------- explanations ----------
    function summary() {
      const o = outcome(), id = cur.id;
      const doubt = inState("prepared");
      const are = doubt.length > 1 ? "are" : "is";
      if (cur.first) return ["<b>tx41</b> committed normally. Pick where the coordinator should crash, then run <b>tx42</b>.", "info"];
      if (o.key === "inconsistent") {
        const later = doubt.length ? `, and ${shorts(doubt)} will commit once the coordinator is back` : "";
        return [`The admin's heuristic abort released Inventory's lock, but the coordinator had decided <b>COMMIT</b>: ${shorts(inState("committed"))} committed while Inventory aborted${later}. That's why <em>heuristic</em> is a polite word for <em>probably breaking atomicity</em>.`, "bad"];
      }
      if (cur.heur && o.key === "aborted") {
        return ["The coordinator's decision was <b>ABORT</b>, so the admin's guess happened to be right: all three aborted and atomicity holds. A heuristic decision is safe only when it happens to match the coordinator's.", "info"];
      }
      if (cur.heur && doubt.length && cur.decision === "commit") {
        return [`The admin aborted Inventory by hand and released its lock, but the coordinator has already logged <b>COMMIT</b>. As soon as ${shorts(doubt)} ${doubt.length > 1 ? "apply" : "applies"} it, ${id} is half committed.`, "bad"];
      }
      if (cur.heur && doubt.length && cur.decision === "abort") {
        return [`The admin aborted Inventory by hand. The coordinator had in fact logged <b>ABORT</b>, so this guess will turn out right; ${shorts(doubt)} ${are} still waiting for the decision.`, "warn"];
      }
      if (cur.heur && doubt.length) {
        const unknown = coord.crashed ? "the coordinator's log turns out to say COMMIT" : "the coordinator decides COMMIT";
        return [`The admin aborted Inventory by hand and released its lock, betting that the outcome is ABORT. ${shorts(doubt)} ${are} still in doubt. If ${unknown}, atomicity is broken.`, "warn"];
      }
      if (coord.crashed) {
        if (cur.decision === "commit") {
          return [`Orders has already committed and released its lock; other transactions may already see its change. ${shorts(doubt)} ${are} in doubt. If either aborted on a timeout, ${id} would be half-applied, and neither can commit on its own because it doesn't know the decision. They must wait for the coordinator: this is why 2PC is a <b>blocking</b> protocol.`, "bad"];
        }
        if (cur.decision === "abort") {
          return [`Orders rolled back; ${shorts(doubt)} ${are} still in doubt and holding ${doubt.length > 1 ? "their locks" : "its lock"} until the coordinator returns, even though the outcome was already decided.`, "warn"];
        }
        const yes = parts.filter(p => p.vote === "yes");
        const tryIt = parts[PAY].state === "prepared" ? " Try <b>tx99 updates acct#7</b>." : "";
        return [`${shorts(yes)} voted YES and are now <b>in doubt</b>. They promised to commit if told to, so they can't abort on their own, and they don't know whether the decision was commit. They hold their locks until the coordinator returns; anything else that needs ${list(yes.map(p => p.row)).replace(" and ", " or ")} queues behind them.${tryIt}`, "bad"];
      }
      if (cur.recovered && cur.decision === "commit") {
        return [`The coordinator found <b>COMMIT</b> in its log and resent it: atomicity survived the crash, at the price of the time spent in doubt (locks held for up to ${cur.hold.toFixed(1)} s).`, "ok"];
      }
      if (cur.recovered && cur.presumed) {
        return ["No commit record in the log, so the recovered coordinator aborts (<b>presumed abort</b>). Everyone rolls back and the locks are released.", "info"];
      }
      if (cur.recovered) {
        return [`The coordinator found <b>ABORT</b> in its log and resent it: everyone has rolled back. The outcome was decided all along; ${shorts(cur.resent) || "the participants"} just couldn't know it.`, "info"];
      }
      if (o.key === "committed") {
        return ["Every participant promised (YES), the coordinator wrote COMMIT to its log (the <b>commit point</b>), then told everyone. Atomic: all three committed.", "ok"];
      }
      if (o.key === "aborted") {
        return ["Payments voted NO, so the coordinator logged ABORT and the others rolled back. One NO vetoes the whole transaction.", "info"];
      }
      return [note.innerHTML, "info"];
    }

    function reset() {
      resetState();
      view.packets.innerHTML = "";
      log.clear();
      log.add("tx41: all three COMMITTED; coordinator idle", "muted");
      say(...summary());
      render();
    }

    resetState();
    buildScene();
    reset();
    ctx.every(100, () => { clock += 0.1; render(); });
    ctx.onResize(() => { if (ctx.compact !== compact) buildScene(); });
  },
});
