// Queue vs log: the same messages go to two brokers. The queue broker (AMQP/JMS style)
// load-balances deliveries and deletes a message once it is acknowledged, so a crash plus
// redelivery reorders messages and a new subscriber gets no history. The log broker (Kafka
// style) keeps every message and each consumer group only moves its own offset, so a crash
// causes in-order re-reads, and replay or a late subscriber is just an offset moved back.
Viz.register("ch11/queue-vs-log", {
  title: "Queue vs log: what happens after a read",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const TICK = 100;
    // Both consumers take the same time per message, so without a crash messages complete in
    // delivery order and any red chip is caused by redelivery alone (not by speed differences).
    const PROC = 2000, ACK_TIMEOUT = 900, Q_RESTART = 2500, L_RESTART = 900;
    const COMMIT_EVERY = 3, WINDOW = 8, STRIP = 10, SUB_MSG_MS = 3000, DELETED_MS = 1200, SEND_GAP = 200;
    const CHIP_Y = 74, HAND_Y = 116, CONS_Y = 166, STRIP_Y = 231;
    const PRODUCER = [53, 40];
    const slotX = i => 18 + i * 34, slotC = i => slotX(i) + 15;
    const HEAD = [slotC(0), CHIP_Y + 12];
    const GROUP = {
      search: { color: "c2", period: 1000, y: 136 },
      analytics: { color: "c1", period: 1400, y: 176 },   // not c4: green means "completed" here
      audit: { color: "c5", period: 300, y: 216 },
    };
    const INTRO = "Same six messages, two brokers. On the left a message disappears as soon as a consumer " +
      "acknowledges it. On the right nothing is deleted on read: each consumer group just moves its own offset.";
    const v = c => `var(--viz-${c})`;
    const m = id => "m" + id;
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const list = a => (a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a[a.length - 1] : a[0]);
    const tri = (x, top) => `M${x},${top} l5,8 h-10 z`;   // 10 x 8, pointing up

    let S = null;
    const later = (ms, fn) => S.timers.push({ at: S.t + ms, fn });   // simulated time: pauses off-screen
    // ctx.fly that resolves false when Reset happened while the packet was in the air.
    const fly = (layer, o) => { const mine = S; return ctx.fly(layer, o).then(() => S === mine); };

    function group(id, pos, committed) {
      return { id, ...GROUP[id], pos, committed, shown: pos, shownC: committed, acc: 0,
        reread: 0, rereadTo: 0, restarting: false, crashes: 0, anim: 0 };
    }
    function fresh() {
      const consumer = (name, x, hand, progress) => ({ name, x, state: "busy", hand, progress, lost: null, lostAt: 0, gen: 0 });
      return {
        t: 0, timers: [], next: 7, sendAt: -1e9, rereads: 0, hist: null,
        q: {
          queue: [5, 6], done: [{ id: 1 }, { id: 2 }], maxDone: 2, ooo: 0, inAir: 0, incoming: 0,
          cons: [consumer("C1", 85, 3, 0.4), consumer("C2", 235, 4, 0.1)],
          stories: new Map(),   // crashed message id -> what to explain once it completes
          flashAt: -1e9, subAt: null, subFrom: 0, deleted: null,
        },
        log: { msgs: [1, 2, 3, 4, 5, 6], incoming: 0, pulses: [], groups: [group("search", 4, 3), group("analytics", 2, 0)] },
      };
    }

    // ---------------- queue broker ----------------
    function tickQueue() {
      const q = S.q;
      q.cons.filter(c => c.state === "busy" && (c.progress += TICK / PROC) >= 1)
        .sort((a, b) => a.hand - b.hand).forEach(complete);
      q.cons.forEach(c => { if (c.state === "idle" && q.queue.length) deliver(c); });
    }
    function deliver(c) {
      const id = S.q.queue.shift(), gen = c.gen;
      Object.assign(c, { state: "receiving", hand: id, progress: 0 });
      fly(packQ, { from: HEAD, to: [c.x, HAND_Y + 11], ms: 400, fill: v("c6"), label: m(id) })
        .then(ok => { if (ok && c.gen === gen) { c.state = "busy"; render(); } });
    }
    function complete(c) {
      const q = S.q, id = c.hand, ooo = id < q.maxDone, gen = c.gen;
      q.done.push({ id, ooo, by: c.name });
      if (ooo) q.ooo++;
      q.maxDone = Math.max(q.maxDone, id);
      Object.assign(c, { state: "acking", hand: null });
      fly(packQ, { from: [c.x, HAND_Y + 11], to: [c.x, 104], r: 5, ms: 300, fill: v("ok"), label: "ack" })
        .then(ok => {
          if (!ok) return;
          q.deleted = { id, at: S.t };
          if (c.gen === gen) c.state = "idle";
          render();
        });
      const story = q.stories.get(id);
      if (story) { q.stories.delete(id); explainRedelivery(id, ooo, story); }
    }
    function crashConsumer(c, right) {
      const id = c.hand, gen = ++c.gen;
      Object.assign(c, { state: "crashed", hand: null, lost: id, lostAt: S.t });
      S.q.stories.set(id, { by: c.name, doneAt: S.q.done.length, right });
      later(ACK_TIMEOUT, () => redeliver(c, id));
      later(Q_RESTART, () => { if (c.gen === gen) c.state = "idle"; });
    }
    function redeliver(c, id) {
      const q = S.q;
      c.lost = null;
      q.inAir++;
      fly(packQ, { from: [c.x, HAND_Y + 11], to: HEAD, ms: 500, fill: v("warn"), label: "redeliver " + m(id) }).then(ok => {
        if (!ok) return;
        q.inAir--;
        // Back to its original place, which is the head: everything still queued is newer.
        const i = q.queue.findIndex(x => x > id);
        q.queue.splice(i < 0 ? q.queue.length : i, 0, id);
        render();
      });
    }
    function explainRedelivery(id, ooo, story) {
      if (!ooo) {
        note.set(`Left: <b>${m(id)}</b> was redelivered and completed in order this time, because no other message ` +
          `was in flight to overtake it. Press <b>Publish 2</b> and crash while both consumers are busy. ${story.right}`, "info");
        return;
      }
      const overtook = S.q.done.slice(story.doneAt).filter(d => d.id > id);
      const ids = list(overtook.map(d => `<b>${m(d.id)}</b>`)) || `<b>${m(S.q.maxDone)}</b>`;
      const by = [...new Set(overtook.map(d => d.by))];
      const who = by.length === 1 ? `${by[0]} had already finished ${ids}` : `${ids} had already completed`;
      note.set(`Left: <b>${story.by}</b> died holding <b>${m(id)}</b>, so the broker redelivered it after the ack timeout, ` +
        `but ${who}: <b>${m(id)}</b> completes out of order. ${story.right}`, "warn");
    }

    // ---------------- log broker ----------------
    function tickLog() {
      const L = S.log, len = L.msgs.length;
      L.groups.forEach(g => {
        if (g.restarting || g.pos >= len) { g.acc = 0; return; }
        if ((g.acc += TICK) < g.period) return;
        g.acc = 0;
        L.pulses.push({ off: g.pos, color: g.pos < g.rereadTo ? "warn" : g.color, until: S.t + 300 });
        g.pos++;
        g.committed = Math.floor(g.pos / COMMIT_EVERY) * COMMIT_EVERY;
        slide(g, 250);
      });
      L.pulses = L.pulses.filter(p => p.until > S.t);
    }
    // Animate a group's drawn markers towards its current position and committed offset.
    function slide(g, ms) {
      const k = ++g.anim, p0 = g.shown, c0 = g.shownC;
      ctx.tween({ ms, onUpdate: e => {
        if (g.anim !== k) return;
        g.shown = ctx.lerp(p0, g.pos, e);
        g.shownC = ctx.lerp(c0, g.committed, e);
        drawLog();
      } });
    }
    function crashSearch() {
      const g = S.log.groups[0], old = g.pos, n = old - g.committed, k = ++g.crashes;
      Object.assign(g, { pos: g.committed, restarting: true, acc: 0, rereadTo: Math.max(g.rereadTo, old) });
      g.reread += n;
      S.rereads += n;
      slide(g, 500);
      later(L_RESTART, () => { if (g.crashes === k) g.restarting = false; });
      return n
        ? `Right: the <b>search</b> consumer restarts from its last committed offset <b>${g.committed}</b> and ` +
          `re-reads <b>${plural(n, "message")}</b>. Duplicates, but in order.`
        : `Right: <b>search</b> had committed everything it had read, so it restarts at offset <b>${g.committed}</b> with nothing to re-read.`;
    }

    // ---------------- controls ----------------
    function publish() {
      // The producer sends one message at a time, so messages reach both brokers in id order.
      [S.next++, S.next++].forEach(id => {
        S.sendAt = Math.max(S.t, S.sendAt + SEND_GAP);
        later(S.sendAt - S.t, () => send(id));
      });
      if (!S.q.stories.size) {
        note.set("Both brokers received the new messages: the queue hands each one to a single consumer, " +
          "the log appends them for every group to read.", "info");
      }
      render();
    }
    function send(id) {
      const q = S.q, lg = S.log, o = { from: PRODUCER, ms: 400, fill: v("c7"), label: m(id) };
      const qi = Math.min(q.queue.length + q.incoming++, WINDOW - 1), li = Math.min(lg.msgs.length + lg.incoming++, WINDOW - 1);
      fly(packQ, { ...o, to: [slotC(qi), CHIP_Y + 12] }).then(ok => { if (ok) { q.incoming--; q.queue.push(id); render(); } });
      fly(packL, { ...o, to: [slotC(li), CHIP_Y + 12] }).then(ok => { if (ok) { lg.incoming--; lg.msgs.push(id); render(); } });
    }
    function crash() {
      // Crash the consumer holding the oldest message: anything the other one holds is newer
      // and finishes long before the redelivered message can be processed again.
      const holders = S.q.cons.filter(c => c.hand !== null).sort((a, b) => a.hand - b.hand);
      const right = crashSearch();
      if (!holders.length) {
        note.set("Left: no consumer is holding a message right now, so there is nothing to redeliver. " +
          `Press <b>Publish 2</b>, then crash while both consumers are busy. ${right}`, "info");
      } else {
        const [c, other] = holders, id = c.hand;
        note.set(`Left: <b>${c.name}</b> crashed holding <b>${m(id)}</b> before acknowledging it. After the ack timeout ` +
          `the broker puts ${m(id)} back at the head of the queue` +
          (other ? `, while ${other.name} carries on with <b>${m(other.hand)}</b>. Watch the completion order.` : ".") +
          ` ${right}`, "warn");
        crashConsumer(c, right);
      }
      render();
    }
    function subscribe() {
      if (S.log.groups.length > 2) return;
      const n = S.log.msgs.length;
      S.log.groups.push(group("audit", 0, 0));
      Object.assign(S.q, { subAt: S.t, subFrom: S.next });
      S.hist = n;
      auditBtn.disable(true);
      note.set("A queue can only give a new subscriber messages published from now on. The log lets <b>audit</b> " +
        `start at offset 0 and replay all <b>${n}</b> past messages.`, "ok");
      render();
    }
    function replay() {
      const g = S.log.groups[1];
      Object.assign(g, { pos: 0, committed: 0, acc: 0 });
      slide(g, 500);
      S.q.flashAt = S.t;
      const others = S.log.groups.length > 2 ? "<b>search</b> and <b>audit</b> carry on untouched" : "<b>search</b> carries on untouched";
      note.set(`Replay is just moving a pointer back: <b>analytics</b> re-reads from offset 0 while ${others}. ` +
        "The queue has nothing to replay: acknowledged messages were deleted.", "info");
      render();
    }
    function reset() {
      S = fresh();
      packQ.replaceChildren();
      packL.replaceChildren();
      auditBtn.disable(false);
      note.set(INTRO);
      render();
    }

    // ---------------- drawing ----------------
    function chip(layer, x, y, w, hh, text, fill, stroke, o = {}) {
      layer.appendChild(s("rect", { x, y, width: w, height: hh, rx: 5, fill: v("bg") }));
      layer.appendChild(s("rect", { x, y, width: w, height: hh, rx: 5, fill, stroke, "stroke-width": o.sw || 1.5, "stroke-dasharray": o.dash || null }));
      layer.appendChild(ctx.text(x + w / 2, y + hh / 2 + 0.5, text, { size: 11, weight: 600, mono: true }));
    }
    function progressBar(layer, x, frac, fill) {
      layer.appendChild(s("rect", { x, y: HAND_Y + 25, width: 34, height: 3, rx: 1.5, fill: v("grid") }));
      layer.appendChild(s("rect", { x, y: HAND_Y + 25, width: 34 * ctx.clamp(frac, 0, 1), height: 3, rx: 1.5, fill }));
    }
    const label = (layer, x, y, str, o) => layer.appendChild(ctx.text(x, y, str, { size: 11, anchor: "start", fill: v("muted"), ...o }));

    function drawQueue() {
      const q = S.q, L = dynQ, f = S.t - q.flashAt, flash = f < 300 || (f >= 450 && f < 750);
      L.replaceChildren();
      ctx.attr(qBox.rect, { stroke: v(flash ? "bad" : "line"), "stroke-width": flash ? 2.5 : 1.5 });
      qLabel.textContent = f < 1500 ? "nothing to replay: acked messages are gone" : "queue (head on the left)";
      ctx.attr(qLabel, { fill: v(f < 1500 ? "bad" : "muted") });
      if (f >= 1500 && q.deleted && S.t - q.deleted.at < DELETED_MS) label(L, 304, 65, `${m(q.deleted.id)} acked → deleted`, { anchor: "end" });

      const n = q.queue.length, shown = n > WINDOW ? WINDOW - 1 : n;
      q.queue.slice(0, shown).forEach((id, i) =>
        chip(L, slotX(i), CHIP_Y, 30, 24, m(id), v("node"), v(q.stories.has(id) ? "warn" : "node-stroke")));
      if (n > WINDOW) chip(L, slotX(WINDOW - 1), CHIP_Y, 30, 24, "+" + (n - shown), v("node"), v("node-stroke"), { dash: "3 2" });

      q.cons.forEach(c => {
        const dead = c.state === "crashed", hx = c.x - 17;
        L.appendChild(ctx.node({ x: c.x, y: CONS_Y, r: 22, label: c.name, fill: v(dead ? "bad-soft" : "c6-soft"), stroke: v(dead ? "bad" : "c6") }));
        if (dead) {
          L.appendChild(ctx.text(c.x + 24, CONS_Y - 13, "×", { size: 18, weight: 800, fill: v("bad"), halo: true }));
          L.appendChild(ctx.text(c.x, CONS_Y + 33, "crashed", { size: 11, weight: 700, fill: v("bad") }));
        }
        if (c.state === "busy") {
          chip(L, hx, HAND_Y, 34, 22, m(c.hand), v("warn-soft"), v("warn"));
          progressBar(L, hx, c.progress, v("warn"));
        } else if (c.lost !== null) {
          chip(L, hx, HAND_Y, 34, 22, m(c.lost) + "?", v("bad-soft"), v("bad"));
          progressBar(L, hx, 1 - (S.t - c.lostAt) / ACK_TIMEOUT, v("bad"));   // ack timeout running out
        }
      });

      q.done.slice(-STRIP).forEach((d, i) =>
        chip(L, 10 + i * 30, STRIP_Y, 26, 20, m(d.id), v(d.ooo ? "bad-soft" : "ok-soft"), v(d.ooo ? "bad" : "ok")));
      if (q.subAt !== null) {
        const recent = S.t - q.subAt < SUB_MSG_MS;
        label(L, 10, 263, recent ? "audit: 0 past messages (history was deleted)" : `audit's own queue: only ${m(q.subFrom)} onward`,
          { fill: v(recent ? "bad" : "muted"), weight: recent ? 700 : null });
      }
    }

    function drawLog() {
      const lg = S.log, L = dynL, len = lg.msgs.length, w0 = Math.max(0, len - WINDOW);
      L.replaceChildren();
      for (let off = w0; off < len; off++) {
        const i = off - w0, p = lg.pulses.filter(pl => pl.off === off).pop();
        chip(L, slotX(i), CHIP_Y, 30, 24, m(lg.msgs[off]), v(p ? p.color + "-soft" : "node"), v(p ? p.color : "node-stroke"), { sw: p ? 2.5 : 1.5 });
        L.appendChild(ctx.text(slotC(i), 107, String(off), { size: 11, fill: v("muted"), mono: true }));
      }
      if (len - w0 < WINDOW) {   // where the next message will be appended
        L.appendChild(s("rect", { x: slotX(len - w0), y: CHIP_Y, width: 30, height: 24, rx: 5, fill: "none", stroke: v("line"), "stroke-dasharray": "3 3" }));
      }
      lg.groups.forEach(g => drawGroup(L, g, w0));
      if (lg.groups.length < 3) {
        const y = GROUP.audit.y;
        label(L, 10, y, "audit", { size: 12, weight: 700 });
        label(L, 310, y, "not subscribed yet", { anchor: "end" });
        L.appendChild(s("line", { x1: 18, x2: 310, y1: y + 16, y2: y + 16, stroke: v("grid"), "stroke-width": 2, "stroke-dasharray": "4 4" }));
      }
    }
    function drawGroup(L, g, w0) {
      const c = v(g.color), y = g.y, ty = y + 16, x = off => slotC(off - w0);
      label(L, 10, y, g.id, { size: 12, weight: 700, fill: c });
      label(L, 310, y, g.restarting ? `✕ crashed, restarting at offset ${g.committed}` : `offset ${g.pos} · committed ${g.committed} · re-read ${g.reread}`,
        { anchor: "end", fill: v(g.restarting ? "bad" : "muted"), weight: g.restarting ? 700 : null });
      L.appendChild(s("line", { x1: 18, x2: 310, y1: ty, y2: ty, stroke: v("grid"), "stroke-width": 2 }));
      if (g.shown < w0 - 0.01) {   // scrolled out of the 8-offset window
        label(L, 18, ty, `◀ ${g.pos}`, { weight: 700, fill: c, mono: true, halo: true });
        return;
      }
      const xp = x(g.shown), xc = Math.max(18, x(g.shownC));
      // Read but not yet committed: what a crash right now would re-read.
      if (xp > xc + 0.5) L.appendChild(s("line", { x1: xc, x2: xp, y1: ty, y2: ty, stroke: c, "stroke-width": 4, opacity: 0.4 }));
      if (g.shownC >= w0) L.appendChild(s("path", { d: tri(xc, ty + 1), fill: v("panel"), stroke: c, "stroke-width": 1.5 }));
      L.appendChild(s("path", { d: tri(xp, ty - 9), fill: c }));
    }

    function updateStats() {
      const q = S.q, held = q.cons.filter(c => c.hand !== null || c.lost !== null).length;
      stats.set("qstored", q.queue.length + held + q.inAir);
      stats.set("ooo", q.ooo, q.ooo ? "bad" : "");
      stats.set("lstored", S.log.msgs.length, "info");
      stats.set("reread", S.rereads, S.rereads ? "warn" : "");
      stats.set("hist", S.hist === null ? "—" : `<span class="hist-k">queue</span> 0 · <span class="hist-k">log</span> ${S.hist}`);
    }
    function render() { drawQueue(); drawLog(); updateStats(); }

    // ---------------- simulation clock ----------------
    function active() {
      const q = S.q, len = S.log.msgs.length;
      return S.timers.length || S.log.pulses.length || S.t - q.flashAt < 1500 ||
        (q.deleted && S.t - q.deleted.at <= DELETED_MS) ||
        (q.subAt !== null && S.t - q.subAt <= SUB_MSG_MS) ||
        q.cons.some(c => c.state === "busy" || (c.state === "idle" && q.queue.length)) ||
        S.log.groups.some(g => !g.restarting && g.pos < len);
    }
    function tick() {
      if (!active()) return;   // idle: nothing is ever produced on its own
      S.t += TICK;
      const due = S.timers.filter(t => t.at <= S.t);
      S.timers = S.timers.filter(t => t.at > S.t);
      due.forEach(t => t.fn());
      tickQueue();
      tickLog();
      render();
    }

    // ---------------- build ----------------
    function producer(svg) {
      svg.appendChild(ctx.box({ x: 10, y: 10, w: 86, h: 30, label: "Producer", size: 12, fill: v("c7-soft"), stroke: v("c7") }));
      svg.appendChild(ctx.arrow({ x1: 53, y1: 40, x2: 53, y2: 55, color: v("line"), width: 1.5, svg }));
    }
    const svgQ = ctx.svg({ w: 320, h: 270, label: "Queue broker: a producer, a queue, two load-balanced consumers and the order in which messages completed" });
    producer(svgQ);
    label(svgQ, 310, 47, "acked = deleted", { anchor: "end" });
    [85, 235].forEach(x => svgQ.appendChild(s("line", { x1: x, x2: x, y1: 104, y2: CONS_Y - 22, stroke: v("line"), "stroke-dasharray": "3 3" })));
    const qBox = ctx.box({ x: 10, y: 56, w: 300, h: 48, fill: v("bg"), stroke: v("line") });
    svgQ.appendChild(qBox);
    const qLabel = label(svgQ, 16, 65, "");
    label(svgQ, 10, 221, "completion order:");
    svgQ.appendChild(ctx.text(160, CONS_Y, "load-balanced", { size: 11, fill: v("muted") }));
    const dynQ = s("g"), packQ = s("g");
    svgQ.append(dynQ, packQ);

    const svgL = ctx.svg({ w: 320, h: 270, label: "Log broker: a producer, an append-only partition and one offset pointer per consumer group" });
    producer(svgL);
    label(svgL, 310, 47, "read ≠ deleted", { anchor: "end" });
    svgL.appendChild(ctx.box({ x: 10, y: 56, w: 300, h: 60, fill: v("bg"), stroke: v("line") }));
    label(svgL, 16, 65, "partition 0 (append-only)");
    const dynL = s("g"), packL = s("g");
    svgL.append(dynL, packL);

    // Hover titles explain each action; the accessible name stays the visible text.
    const button = (text, fn, kind, title) => ui.button(text, fn, { kind, title, ariaLabel: text });
    const auditBtn = button("Add audit subscriber", subscribe, null, "A new consumer group subscribes to both brokers");
    const stats = ui.stats([
      { key: "qstored", label: "Queue: stored" },
      { key: "ooo", label: "Queue: out of order" },
      { key: "lstored", label: "Log: stored", tone: "info" },
      { key: "reread", label: "Log: re-read after crash" },
      { key: "hist", label: "New subscriber history" },
    ]);
    stats.classList.add("qvl-stats");
    const note = ui.note(INTRO);
    const legendTri = (filled, text) => h("span", { class: "viz-legend-item" },
      s("svg", { width: 12, height: 10, viewBox: "0 0 12 10", "aria-hidden": "true" },
        s("path", { d: "M6,1 L11,9 L1,9 Z", fill: filled ? v("muted") : "none", stroke: v("muted"), "stroke-width": 1.5 })),
      text);
    const legend = ui.legend([
      { color: v("node-stroke"), label: "queued message", shape: "square" },
      { color: v("warn"), label: "in hand / unacked", shape: "square" },
      { color: v("ok"), label: "completed", shape: "square" },
      { color: v("bad"), label: "out of order", shape: "square" },
    ]);
    legend.append(legendTri(true, "group's next offset"), legendTri(false, "committed offset"));

    root.append(
      h("style", null, ".qvl-stats .hist-k{font-size:12px;font-weight:600;opacity:.75}" +
        ".qvl-stats .viz-stat:last-child .viz-stat-value{white-space:nowrap}" +
        "@media (max-width:600px){.qvl-stats .viz-stat:last-child{grid-column:1/-1}}"),
      ui.bar(
        button("Publish 2", publish, "primary", "The producer sends the next two messages to both brokers"),
        button("Crash consumer", crash, "danger", "Kill the queue consumer holding the oldest message, and the search group's consumer"),
        auditBtn,
        button("Replay analytics", replay, null, "Move the analytics group back to offset 0"),
        button("Reset", reset, "ghost", "Back to the starting state")),
      ui.row(ui.panel("Queue broker (AMQP/JMS style)", svgQ), ui.panel("Log broker (Kafka style)", svgL)),
      stats, note, legend);

    reset();
    ctx.every(TICK, tick);
    return { get state() { return S; } };   // for tests
  },
});
