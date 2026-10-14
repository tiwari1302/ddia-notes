// Chapter 8, "Unreliable networks": a client sends "charge $10" and hears nothing back. The book's
// six fates of an unanswered request look identical from the client's side until its timeout fires,
// and in four of them the customer was (or will be) charged anyway. Retry shows the double charge;
// a server that remembers request IDs turns the retry into a safe one (idempotence, Chapter 12).
// Semantic timing (the 3 s timeout, queue and pause lengths) runs on ctx.after so it stays correct
// when animations are instant (reduced motion); packets move with ctx.tween.
Viz.register("ch8/no-reply", {
  title: "What happened to my request?",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const V = n => `var(--viz-${n})`;
    const TIMEOUT = 3000;
    const CH12 = '<a href="#/ch12/concepts/idempotence-via-operation-ids">Chapter 12</a>';
    const FOUR = " In 4 of the 6 failure modes shown here the customer <b>was</b> (or will be) charged.";
    const SILENCE = "<b>Timeout.</b> A lost request, a queued request, a crashed server, a GC pause, a lost reply " +
      "and a slow reply all look exactly the same from here: silence.";
    const INTRO = "Press <b>Send</b>. Something will go wrong between the client and the server. " +
      "Watch only the client's side: can you tell what happened?";
    // charged: the eventual outcome. line/short: SVG truth line (desktop/phone). note: full sentence.
    // late: [line, short, note] while a late charge is still to come.
    const FAULTS = {
      none: { label: "No fault", charged: true, line: "processed and charged once; client and truth agree",
        short: "charged once", note: "Delivered, processed and answered in time." },
      reqLost: { label: "Request lost", charged: false, line: "the network dropped the request. Not charged.",
        short: "request lost; not charged", note: "The network dropped the request. Not charged." },
      reqQueued: { label: "Request queued", charged: true,
        line: "stuck in a congested switch queue, delivered late, and CHARGED", short: "queued, late; CHARGED",
        note: "Stuck in a congested switch queue, delivered late, and CHARGED.",
        late: ["stuck in a switch queue; will be CHARGED when it gets through", "queued; will be CHARGED",
          "The request is stuck in a congested switch queue; it will be delivered late and CHARGED."] },
      crashed: { label: "Server crashed", charged: false, line: "the server crashed before processing it. Not charged.",
        short: "crashed first; not charged",
        note: "The server crashed before processing. Not charged. (A crash just after charging, before replying, " +
          "would look exactly the same from here.)" },
      paused: { label: "Server paused (GC)", charged: true,
        line: "GC pause; the server charged after the client gave up. CHARGED", short: "GC pause, late; CHARGED",
        note: "The server froze in a GC pause and processed the request after the client gave up. CHARGED.",
        late: ["server frozen in a GC pause; will be CHARGED when it resumes", "GC pause; will be CHARGED",
          "The server is frozen in a GC pause. When it resumes it will process the request and CHARGE the " +
          "customer, long after the client gave up."] },
      replyLost: { label: "Reply lost", charged: true, line: "the charge succeeded; the reply was dropped. CHARGED",
        short: "reply lost; CHARGED", note: "The charge succeeded; the reply was dropped. CHARGED." },
      replySlow: { label: "Reply slow", charged: true, line: "the charge succeeded; the reply sat in a queue. CHARGED",
        short: "reply queued; CHARGED", note: "The charge succeeded; the reply sat in a queue. CHARGED." },
    };
    const MYSTERY = ["reqLost", "reqQueued", "crashed", "paused", "replyLost", "replySlow"];
    const OPTIONS = [{ value: "mystery", label: "Mystery (random)" }]
      .concat(["none", ...MYSTERY].map(f => ({ value: f, label: FAULTS[f].label })));
    // Requests fly along reqY (left to right), replies along repY; xL/xM/xR = client edge, network
    // centre, server edge. Queue slots sit at the bottom of the network box.
    const LAYOUT = {
      desk: { W: 640, H: 244, fs: 12, r: 28, cl: [70, 96], sv: [570, 96], net: [228, 42, 184, 118],
        netTitle: [320, 30], qCap: [240, "switch queue"], reqY: 84, repY: 108, xL: 100, xM: 320, xR: 530,
        slots: [340, 360, 380], slotY: 144, slotS: 18, queuedY: 174, bar: [20, 144, 110, 10], barLabel: [75, 135, "middle"],
        cStat: [75, 174, "middle", 13], charges: [634, 28], sStat: [570, 156, "middle"], seen: [634, 174],
        sep: 192, truth: [20, 210, 232], fog: [150, 12, 484, 174], fogCap: 176 },
      phone: { W: 360, H: 236, fs: 11, r: 24, cl: [46, 92], sv: [314, 92], net: [104, 56, 152, 86],
        netTitle: [180, 46], qCap: [112, "queue"], reqY: 82, repY: 102, xL: 70, xM: 180, xR: 279,
        slots: [196, 214, 232], slotY: 130, slotS: 16, queuedY: 154, bar: [12, 136, 84, 10], barLabel: [12, 128, "start"],
        cStat: [12, 168, "start", 13], charges: [352, 24], sStat: [352, 136, "end"], seen: [352, 152],
        sep: 182, truth: [12, 202, 224], fog: [100, 12, 256, 148], fogCap: 150 },
    };

    // ---------- state (outside build() so a phone/desktop switch keeps it) ----------
    const rnd = ctx.random(8);
    const processed = new Map();      // server side: request ID -> saved reply
    let pick = "mystery", dedupe = false;
    let order = 1, used = false;      // current order r{order}; used once its first request is sent
    let charges = 0, dupes = 0;       // for the current order only
    let sent = 0, inTime = 0, right = 0, guesses = 0;
    let R = null;                     // the current round (one order); null while idle
    let compact = ctx.compact, L = null, v = null;
    const wait = ms => new Promise(res => ctx.after(ms, res));

    const newRound = fault => ({
      fault, mystery: pick === "mystery", phase: "waiting", t0: performance.now(), att: null, retried: false,
      active: 0, busy: 0, crashed: false, paused: false, resume: null, origDone: false, lateDouble: false, dupOrig: false,
      queued: null, guess: null, right: false, hidden: [],
    });
    const fogged = () => (R ? R.mystery && R.guess === null : pick === "mystery");
    const canRetry = () => !!R && (R.phase === "timeout" || R.phase === "revealed") && !R.crashed && !R.paused &&
      !(R.mystery && R.guess === null);

    // ---------- controls (built once; only the fault picker depends on the layout) ----------
    const sendBtn = ui.button("Send charge $10", () => send(), { kind: "primary" });
    const retryBtn = ui.button("Retry", () => { if (canRetry()) attempt(R, "none", true); });
    const resetBtn = ui.button("Reset", () => resetAll(), { kind: "ghost" });
    const dedupeToggle = ui.toggle({ label: "Server remembers request IDs", value: false,
      onChange: on => { dedupe = on; resetRound(); } });
    const guessYes = ui.button("It was charged", () => guess(true));
    const guessNo = ui.button("It was NOT charged", () => guess(false));
    const verdict = h("span");
    const guessBar = ui.bar(h("span", { style: "font-weight:600;font-size:13px" }, "Was the customer charged?"),
      guessYes, guessNo, verdict);
    const legend = ui.legend([
      { color: V("c6"), label: "request" }, { color: V("c2"), label: "reply" },
      { color: V("bad"), label: "lost" }, { color: V("warn"), label: "queued / paused" },
    ]);
    const stats = ui.stats([
      { key: "sent", label: "Requests sent", value: 0 },
      { key: "replies", label: "Replies in time", value: 0 },
      { key: "charges", label: "Charges for this order", value: 0 },
      { key: "guesses", label: "Correct guesses", value: "–" },
    ]);
    const note = ui.note("");
    const log = ui.log({ title: "Client and server log", height: 110 });
    // A placeholder row until the first order, so the log never shows as an empty box.
    let logEmpty = true;
    const logPlaceholder = () => { log.clear(); log.add("Nothing sent yet: press Send to start an order.", "muted"); logEmpty = true; };
    logPlaceholder();

    // ---------- log (server lines stay hidden in Mystery mode until the guess) ----------
    const stamp = r => `<span class="mono muted">${((performance.now() - r.t0) / 1000).toFixed(1)}s</span> `;
    const clientLog = (r, msg, tone) => log.add(stamp(r) + "client: " + msg, tone);
    function serverLog(r, msg, tone) {
      const row = [stamp(r) + "server: " + msg, tone];
      if (r.mystery && r.guess === null) r.hidden.push(row); else log.add(...row);
    }

    // ---------- packets ----------
    const place = (p, [x, y]) => p.g.setAttribute("transform", `translate(${x},${y})`);
    function packet(kind, at) {
      const req = kind === "req";
      const text = req ? (dedupe ? `charge $10 · r${order}` : "charge $10") : "OK";
      const c = s("circle", { r: compact ? 6 : 7, fill: V(req ? "c6" : "c2"), stroke: V("bg"), "stroke-width": 1.5 });
      const lab = ctx.text(0, req ? -15 : 16, text, { size: L.fs, weight: 600, halo: true });
      const p = { g: s("g", null, c, lab), c, lab, kind, text, at, tok: 0 };
      v.packets.appendChild(p.g);
      place(p, at);
      return p;
    }
    function move(p, to, ms) {
      const tok = ++p.tok, from = p.at;
      p.at = to;
      ctx.tween({ ms, onUpdate: t => { if (p.tok === tok) place(p, [ctx.lerp(from[0], to[0], t), ctx.lerp(from[1], to[1], t)]); } });
      return wait(ms);
    }
    function drop(p) {   // lost: turns red and fades out
      p.tok++;
      ctx.attr(p.c, { fill: V("bad") });
      ctx.attr(p.lab, { fill: V("bad") });
      p.lab.textContent = "✕ lost";
      ctx.tween({ ms: 450, ease: "linear", onUpdate: t => p.g.setAttribute("opacity", 1 - t) }).then(() => p.g.remove());
      return wait(450);
    }
    function park(p, on, text) {   // parked: amber dot ringed in its own colour
      const col = V(p.kind === "req" ? "c6" : "c2");
      ctx.attr(p.c, on ? { fill: V("warn"), stroke: col, "stroke-width": 2.5 } : { fill: col, stroke: V("bg"), "stroke-width": 1.5 });
      ctx.attr(p.lab, { fill: V(on ? "warn" : "ink") });
      p.lab.textContent = on ? text : p.text;
    }
    async function lose(r, p, to, ms) {   // dropped halfway along this segment
      await move(p, [(p.at[0] + to[0]) / 2, (p.at[1] + to[1]) / 2], ms / 2);
      if (r === R) await drop(p);
    }
    // Pull a packet aside into a switch queue slot for `ms` in total, then put it back on its path.
    async function queue(r, p, slot, ms, what) {
      const back = p.at, live = () => r === R && ctx.alive;
      await move(p, [L.slots[slot], L.slotY], 250);
      if (!live()) return false;
      park(p, true, "");
      r.queued = { slot, what };
      render();
      await wait(ms - 500);
      if (!live()) return false;
      park(p, false);
      r.queued = null;
      render();
      await move(p, back, 250);
      return live();
    }

    // ---------- one attempt: request -> server -> reply, with the round's fault ----------
    async function attempt(r, fault, retry) {
      const live = () => r === R && ctx.alive;
      const go = async (p, to, ms) => { await move(p, to, ms); return live(); };
      const end = () => { if (live()) { r.active--; render(); } };
      const a = { retry, start: performance.now(), state: "waiting", secs: "", frac: 0 };
      Object.assign(r, { att: a, phase: "waiting", retried: r.retried || retry });
      r.active++;
      sent++;
      clientLog(r, (retry ? "retry: sent charge $10 again" : "sent charge $10") +
        (dedupe ? ` (${retry ? "same " : ""}ID r${order})` : ""));
      ctx.after(TIMEOUT, () => timeout(r, a));
      const stopBar = ctx.raf(() => { drawBar(); if (r !== R || a.state !== "waiting") stopBar(); });
      if (fault === "crashed") ctx.after(500, () => crash(r));
      if (fault === "paused") ctx.after(500, () => pause(r));
      render();

      const req = packet("req", [L.xL, L.reqY]);
      if (!(await go(req, [L.xM, L.reqY], 450))) return;
      if (fault === "reqLost") return lose(r, req, [L.xR, L.reqY], 450).then(end);
      if (fault === "reqQueued" && !(await queue(r, req, 0, 4500, "request"))) return;
      if (!(await go(req, [L.xR, L.reqY], 450))) return;
      if (r.crashed) { await drop(req); return end(); }
      if (r.paused) {   // waits at the frozen server's door until the pause ends
        park(req, true, "waiting");
        await new Promise(res => { r.resume = res; });
        if (!live()) return;
      }
      req.g.remove();
      r.busy++;
      render();
      await wait(400);
      if (!live()) return;
      r.busy--;
      charge(r, retry);
      render();

      const rep = packet("rep", [L.xR, L.repY]);
      if (!(await go(rep, [L.xM, L.repY], 400))) return;
      if (fault === "replyLost") return lose(r, rep, [L.xL, L.repY], 400).then(end);
      if (fault === "replySlow" && !(await queue(r, rep, 2, 3200, "reply"))) return;
      if (!(await go(rep, [L.xL, L.repY], 400))) return;
      rep.g.remove();
      receive(r, a);
      end();
    }

    function timeout(r, a) {
      if (r !== R || a.state !== "waiting") return;
      a.state = "timeout";
      r.phase = "timeout";
      clientLog(r, "no reply within 3 s. Outcome: UNKNOWN", "warn");
      render();
    }
    function receive(r, a) {
      if (a.state !== "waiting") return clientLog(r, "late reply ignored (already timed out)", "warn");
      const ms = performance.now() - a.start;
      Object.assign(a, { state: "ok", secs: (ms / 1000).toFixed(1), frac: Math.min(1, ms / TIMEOUT) });
      r.phase = "ok";
      inTime++;
      clientLog(r, `got OK after ${a.secs} s`, "ok");
    }
    // Check-and-record happens in one synchronous step, so two copies can never both be charged.
    function charge(r, retry) {
      const id = "r" + order;
      if (!retry) r.origDone = true;
      if (dedupe && processed.has(id)) {
        dupes++;
        if (!retry) r.dupOrig = true;   // the late original turned out to be the repeat
        return serverLog(r, `${id} already processed: replying with saved result, no new charge`, "ok");
      }
      charges++;
      if (dedupe) processed.set(id, "OK");
      if (!retry && r.retried && charges > 1) r.lateDouble = true;
      serverLog(r, `charged $10 (total ${charges})`, charges > 1 ? "bad" : "ok");
    }
    function crash(r) {
      if (r !== R) return;
      r.crashed = true;
      serverLog(r, "CRASHED", "bad");
      render();
      ctx.after(TIMEOUT + 2500 - 500, () => {
        if (r !== R) return;
        r.crashed = false;
        serverLog(r, "restarted", "info");
        render();
      });
    }
    function pause(r) {
      if (r !== R) return;
      r.paused = true;
      serverLog(r, "GC pause: the process is frozen", "warn");
      render();
      ctx.after(4200, () => {
        if (r !== R) return;
        r.paused = false;
        serverLog(r, "GC pause over, resuming", "info");
        if (r.resume) r.resume();
        render();
      });
    }

    // ---------- user actions ----------
    function send() {
      if (R && R.phase === "waiting") return;
      resetRound(false);
      used = true;
      R = newRound(pick === "mystery" ? rnd.pick(MYSTERY) : pick);
      if (logEmpty) { log.clear(); logEmpty = false; }
      log.add(`<b>order r${order}</b> · ${R.mystery ? "mystery fault" : FAULTS[R.fault].label}`, "muted");
      attempt(R, R.fault, false);
    }
    function guess(saysCharged) {
      const r = R;
      if (!r || r.phase !== "timeout" || r.guess !== null) return;
      Object.assign(r, { guess: saysCharged, right: saysCharged === FAULTS[r.fault].charged, phase: "revealed" });
      guesses++;
      if (r.right) right++;
      if (r.hidden.length) log.add("server side, now revealed:", "muted");
      r.hidden.forEach(row => log.add(...row));
      r.hidden = [];
      render();
    }
    function resetRound(draw = true) {   // abandons the current order; cumulative stats stay
      R = null;
      if (used) { order++; used = false; }
      charges = dupes = 0;
      if (v) v.packets.replaceChildren();
      if (draw && v) render();
    }
    function resetAll() {
      R = null;
      order = 1; used = false;
      charges = dupes = sent = inTime = right = guesses = 0;
      processed.clear();
      logPlaceholder();
      v.packets.replaceChildren();
      render();
    }

    // ---------- derived text ----------
    function clientLine() {
      const a = R && R.att, c = compact;
      if (!a) return ["nothing sent yet", "muted"];
      if (a.state === "waiting") return [`${a.retry ? "retry" : "request"} sent, no reply yet`, "warn"];
      if (a.state === "ok") {
        return [c ? `OK after ${a.secs} s` : `${a.retry ? "the retry got" : "got"} OK after ${a.secs} s, so the charge went through`, "ok"];
      }
      return [c ? "no reply in 3 s: UNKNOWN" : "no reply within 3 s. Outcome: UNKNOWN", "warn"];
    }
    function truthLine() {
      const r = R, c = compact;
      if (fogged()) return [r && r.phase === "timeout" ? "? (make a guess)" : "? (hidden)", "muted"];
      if (!r) return ["nothing yet", "muted"];
      const F = FAULTS[r.fault];
      if (r.retried && (r.phase !== "waiting" || charges > 1 || dupes)) {
        if (charges > 1) return [c ? "charged TWICE" : "charged TWICE: the first attempt and the retry both went through", "bad"];
        if (dupes) {
          return [c ? "repeat caught; charged once" : r.dupOrig ? `the late original r${order} was answered from the table; charged once`
            : `the repeat of r${order} was answered from the table; charged once`, "ok"];
        }
        if (r.active) return [c ? "first attempt still out there..." : "the retry was charged, but the first attempt is still out there...", "warn"];
        return [c ? "retry charged once" : "the first attempt never got processed; the retry charged once", "ok"];
      }
      if (r.phase === "waiting" && !r.retried) return [c ? "in progress..." : "in progress (watch the network and the server)", "muted"];
      const late = F.late && !r.origDone;
      return [c ? (late ? F.late[1] : F.short) : (late ? F.late[0] : F.line), F.charged && r.fault !== "none" ? "bad" : "ok"];
    }
    function retryNote(r) {
      if (charges > 1) {
        return [(r.lateDouble
          ? "The original request was still stuck in the network. It got through after the retry and charged the customer " +
            "a second time, even though the retry looked like the first successful attempt. "
          : "The first charge had already gone through, so the retry charged the customer again. ") +
          "A timeout can't tell you which case you're in. Retries are only safe if the server can recognize a repeated " +
          `request, e.g., by a unique request ID (${CH12}).`, "bad"];
      }
      if (dupes) {
        return [(r.dupOrig
          ? `The original request was still stuck in the network and arrived after the retry. Both carried request ID ` +
            `r${order}, so the server recognized the late one and replied with the saved result instead of charging again. `
          : `The retry carried the same request ID r${order}; the server recognized the repeat and replied with the ` +
            "saved result, so the customer was charged once. ") +
          `Remembering request IDs is what makes retries safe (${CH12}).`, "ok"];
      }
      if (r.phase === "waiting") {
        return [`Retry sent${dedupe ? ` with the same request ID r${order}` : ""}. The client is waiting on its timer again.`, "warn"];
      }
      if (r.active) return ["The retry was answered OK. Is the first attempt really gone? Something is still in the network...", "warn"];
      return [dedupe
        ? "Retry succeeded and the customer was charged once. The first attempt never got processed, so there was no repeat to catch."
        : "Retry succeeded and the customer was charged once, but only because the first attempt never got processed.", "ok"];
    }
    function noteFor() {
      const r = R;
      if (!r) {
        return [pick === "mystery" ? INTRO : pick === "none" ? "Press <b>Send</b> for the happy path: nothing goes wrong."
          : `Press <b>Send</b>. You picked the fault (<b>${FAULTS[pick].label}</b>), so you can watch it happen. ` +
            "Notice that the client's side looks exactly like every other failure.", "info"];
      }
      if (r.retried) return retryNote(r);
      if (r.phase === "waiting") return ["Waiting... The client sees nothing but its own timer.", "warn"];
      if (r.phase === "ok") {
        return [`Reply in ${r.att.secs} s. The happy path is the only case where the client actually knows the outcome.`, "ok"];
      }
      if (r.mystery && r.guess === null) return [SILENCE + " Make a guess.", "warn"];
      const F = FAULTS[r.fault], late = F.late && !r.origDone;
      const lead = r.mystery ? (r.right ? "<b>Correct guess.</b> " : "<b>Wrong guess.</b> ")
        : "<b>Timeout:</b> the same silence the client gets from every other failure. What actually happened: ";
      const hint = canRetry() ? " Now press <b>Retry</b>." : r.crashed || r.paused ? " <b>Retry</b> unlocks once the server is back." : "";
      return [lead + (late ? F.late[2] : F.note) + FOUR + hint, F.charged ? "bad" : "ok"];
    }

    // ---------- rendering ----------
    const setText = (el, str, tone) => { el.textContent = str; ctx.attr(el, { fill: V(tone || "ink") }); };
    const setLine = (el, prefix, body, tone) => el.replaceChildren(
      s("tspan", { "font-weight": 700, fill: V("muted") }, prefix), s("tspan", { fill: V(tone) }, body));

    function drawBar() {
      const a = R && R.att, w = L.bar[2];
      const f = !a ? 0 : a.state === "ok" ? a.frac : a.state === "waiting" ? Math.min(1, (performance.now() - a.start) / TIMEOUT) : 1;
      ctx.attr(v.barFill, { width: w * f, fill: V(!a || a.state === "waiting" ? "warn" : a.state === "ok" ? "ok" : "bad") });
    }
    function showFog(on) {
      const f = v.fog;
      if (on) { f.tok = (f.tok || 0) + 1; f.style.display = ""; f.setAttribute("opacity", 1); return; }
      if (f.style.display === "none" || f.fading) return;
      const tok = f.tok;
      f.fading = true;
      ctx.tween({ ms: 450, ease: "linear", onUpdate: t => { if (f.tok === tok) f.setAttribute("opacity", 1 - t); } })
        .then(() => { f.fading = false; if (f.tok === tok) f.style.display = "none"; });
    }

    function render() {
      const r = R, a = r && r.att, c = compact;
      const [cs, ct] = !a ? ["idle", "muted"] : a.state === "waiting" ? ["waiting...", "warn"]
        : a.state === "ok" ? [`OK (${a.secs} s)`, "ok"] : ["TIMEOUT: no reply", "bad"];
      setText(v.cStat, cs, ct);
      drawBar();
      const [ss, st] = !r ? ["running", "muted"] : r.crashed ? ["CRASHED", "bad"] : r.paused ? ["GC pause", "warn"]
        : r.busy ? ["processing...", "warn"] : ["running", "muted"];
      setText(v.sStat, ss, st);
      v.cross.style.display = r && r.crashed ? "" : "none";
      v.server.setAttribute("opacity", r && r.paused ? 0.45 : 1);
      setText(v.charges, `${c ? "" : "order "}r${order} · charges: ${charges}${charges > 1 ? " (twice!)" : ""}`,
        charges > 1 ? "bad" : charges ? "ok" : "muted");
      const ids = [...processed.keys()].slice(c ? -2 : -3).join(" ") || "none";
      setText(v.seen, dedupe ? `${c ? "seen" : "IDs seen"}: ${ids}` : "", processed.has("r" + order) ? "ok" : "muted");
      const q = r && r.queued;
      setText(v.queued, q ? q.what + " queued" : "", "warn");
      if (q) v.queued.setAttribute("x", L.slots[q.slot]);
      setLine(v.t1, c ? "Client: " : "Client knows: ", ...clientLine());
      setLine(v.t2, c ? "Truth: " : "What really happened: ", ...truthLine());
      showFog(fogged());

      sendBtn.disable(!!r && r.phase === "waiting");
      retryBtn.disable(!canRetry());
      retryBtn.title = r && r.mystery && r.guess === null ? "Make a guess first" : "";
      guessBar.style.display = r && r.mystery && (r.phase === "timeout" || r.guess !== null) ? "" : "none";
      guessYes.disable(!r || r.guess !== null);
      guessNo.disable(!r || r.guess !== null);
      verdict.replaceChildren(r && r.guess !== null ? ui.badge(r.right ? "✓ right" : "✗ wrong", r.right ? "ok" : "bad") : "");

      stats.set("sent", sent);
      stats.set("replies", inTime);
      if (fogged()) stats.set("charges", "?", "");
      else stats.set("charges", charges, charges > 1 ? "bad" : "ok");
      stats.set("guesses", pick === "mystery" ? `${right} / ${guesses}` : "–", pick === "mystery" ? "info" : "");
      note.set(...noteFor());
    }

    function buildFog(layer) {
      const [x, y, w, hh] = L.fog, [nx, ny, nw, nh] = L.net, [sx, sy] = L.sv;
      const id = "nr-hatch-" + ctx.uid;
      layer.ownerSVGElement.defs.appendChild(s("pattern", { id, width: 8, height: 8, patternUnits: "userSpaceOnUse" },
        s("path", { d: "M0,8 L8,0", stroke: V("grid"), "stroke-width": 1.5 })));
      const dash = { fill: "none", stroke: V("line"), "stroke-width": 1.5, "stroke-dasharray": "5 4" };
      const muted = (tx, ty, str, size, weight) => ctx.text(tx, ty, str, { size, weight, fill: V("muted") });
      const g = s("g", null,
        s("rect", { x, y, width: w, height: hh, rx: 10, fill: V("panel"), stroke: V("line") }),
        s("rect", { x, y, width: w, height: hh, rx: 10, fill: `url(#${id})` }),
        s("rect", { x: nx, y: ny, width: nw, height: nh, rx: 12, ...dash }),
        s("circle", { cx: sx, cy: sy, r: L.r, ...dash }),
        muted(L.netTitle[0], L.netTitle[1], "Network", L.fs + 1, 700),
        muted(nx + nw / 2, ny + nh / 2, "?", 30, 700),
        muted(sx, sy, "?", 22, 700),
        muted(sx, sy + L.r + 13, "Server", L.fs, 700),
        muted(x + w / 2, L.fogCap, compact ? "hidden: only the client's view" : "Hidden: you see only what the client sees", L.fs));
      layer.appendChild(g);
      g.style.display = fogged() ? "" : "none";
      return g;
    }

    function build() {
      compact = ctx.compact;
      L = compact ? LAYOUT.phone : LAYOUT.desk;
      const svg = ctx.svg({ w: L.W, h: L.H, label: "A client sends a charge request through a network to a payments server" });
      const scene = s("g"), packets = s("g"), overlay = s("g");
      svg.append(scene, packets, overlay);
      const [cx, cy] = L.cl, [sx, sy] = L.sv, [nx, ny, nw, nh] = L.net, r = L.r;
      const T = (x, y, str, o) => scene.appendChild(ctx.text(x, y, str, { size: L.fs, ...o }));
      const wire = (x1, x2) => s("line", { x1, x2, y1: cy, y2: cy, stroke: V("line"), "stroke-width": 1.5 });
      scene.append(wire(cx + r, nx), wire(nx + nw, sx - r));
      scene.appendChild(ctx.box({ x: nx, y: ny, w: nw, h: nh, rx: 12, fill: V("panel"), stroke: V("line") }));
      scene.appendChild(s("line", { x1: nx, x2: nx + nw, y1: cy, y2: cy, stroke: V("line"), "stroke-dasharray": "3 5" }));
      T(L.netTitle[0], L.netTitle[1], "Network", { size: L.fs + 1, weight: 700 });
      T(L.qCap[0], L.slotY, L.qCap[1], { anchor: "start", fill: V("muted") });
      L.slots.forEach(x => scene.appendChild(s("rect", { x: x - L.slotS / 2, y: L.slotY - L.slotS / 2, width: L.slotS,
        height: L.slotS, rx: 3, fill: "none", stroke: V("line"), "stroke-width": 1.2 })));
      const queued = T(0, L.queuedY, "", { weight: 600 });

      scene.appendChild(ctx.node({ x: cx, y: cy, r, label: "Client", fill: V("c6-soft"), stroke: V("c6") }));
      const [bx, by, bw, bh] = L.bar;
      T(L.barLabel[0], L.barLabel[1], "timeout 3 s", { anchor: L.barLabel[2], fill: V("muted") });
      scene.appendChild(s("rect", { x: bx, y: by, width: bw, height: bh, rx: 5, fill: V("grid") }));
      const barFill = scene.appendChild(s("rect", { x: bx, y: by, width: 0, height: bh, rx: 5, fill: V("warn") }));
      const cStat = T(L.cStat[0], L.cStat[1], "", { anchor: L.cStat[2], size: L.cStat[3], weight: 600 });

      const server = ctx.node({ x: sx, y: sy, r, label: "Server", sub: compact ? undefined : "payments",
        fill: V("c2-soft"), stroke: V("c2") });
      if (server.sub) server.sub.setAttribute("font-size", 12);
      const d = r * 0.62;
      const cross = s("g", { stroke: V("bad"), "stroke-width": 3, "stroke-linecap": "round" },
        s("line", { x1: sx - d, y1: sy - d, x2: sx + d, y2: sy + d }), s("line", { x1: sx - d, y1: sy + d, x2: sx + d, y2: sy - d }));
      scene.append(server, cross, server.label);   // label on top of the X, readable through it
      server.label.classList.add("viz-halo");
      const sStat = T(L.sStat[0], L.sStat[1], "", { anchor: L.sStat[2] });
      const charges = T(L.charges[0], L.charges[1], "", { anchor: "end", mono: true, size: 12 });
      const seen = T(L.seen[0], L.seen[1], "", { anchor: "end", mono: true });

      scene.appendChild(s("line", { x1: 8, x2: L.W - 8, y1: L.sep, y2: L.sep, stroke: V("grid"), "stroke-width": 1.5 }));
      const t1 = T(L.truth[0], L.truth[1], "", { anchor: "start", size: 12 });
      const t2 = T(L.truth[0], L.truth[2], "", { anchor: "start", size: 12 });
      v = { packets, queued, barFill, cStat, server, cross, sStat, charges, seen, t1, t2 };
      v.fog = buildFog(overlay);

      const onPick = val => { pick = val; resetRound(); };
      const picker = compact
        ? ui.select({ label: "What goes wrong", options: OPTIONS, value: pick, onChange: onPick })
        : ui.segmented({ label: "What goes wrong", options: OPTIONS, value: pick, onChange: onPick });
      root.replaceChildren(ui.bar(picker), ui.bar(sendBtn, retryBtn, resetBtn, dedupeToggle), svg, legend, guessBar,
        note, stats, log);
      render();
    }

    build();
    // Rebuild with the other layout when the frame crosses the phone breakpoint; an order still in
    // flight is abandoned because its packets live in the old drawing.
    ctx.onResize(() => {
      if (ctx.compact === compact) return;
      if (R && (R.phase === "waiting" || R.active || R.crashed || R.paused)) {
        log.add(`order r${order} abandoned (the layout changed)`, "muted");
        resetRound(false);
      }
      build();
    });
  },
});
