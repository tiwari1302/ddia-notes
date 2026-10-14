// Delivery guarantees (DDIA ch11, fault tolerance). A consumer reads orders from one log
// partition and adds each amount to a revenue total in a sink database. When it records its
// progress (the committed offset) relative to its output decides what a crash does: lose an
// order (at-most-once), add it twice (at-least-once), or neither (output and offset committed
// in one DB transaction, or a sink that remembers the last offset it applied). Emails are an
// external side effect that neither database technique can take back.
Viz.register("ch11/exactly-once", {
  title: "Crash, restart, recount: delivery guarantees",
  mount(root, ctx) {
    const { s, ui } = ctx;
    const V = n => `var(--viz-${n})`;
    const AMT = [12, 30, 8, 25, 15, 40, 10, 22, 18, 35], NEV = AMT.length, CORRECT = 215;
    const E = i => "e" + (i + 1);
    const usd = v => "$" + v;
    const uniq = a => [...new Set(a)].sort((x, y) => x - y);
    const and = a => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
    const evs = list => and(uniq(list).map(E));
    const be = list => (uniq(list).length > 1 ? "were" : "was");
    const sum = list => list.reduce((a, i) => a + AMT[i], 0);
    const STRATS = [
      { value: "amo", label: "At-most-once", short: "At-most" },
      { value: "alo", label: "At-least-once", short: "At-least" },
      { value: "atomic", label: "Atomic commit", short: "Atomic" },
      { value: "idem", label: "Idempotent sink", short: "Idempotent" },
    ];
    const PHASES = {
      amo: ["read", "commit", "process", "write"], alo: ["read", "process", "write", "commit"],
      atomic: ["read", "process", "buffer", "commit"], idem: ["read", "process", "write", "commit"],
    };
    // The worst crash point: right after this phase of e5 (index 4).
    const WORST_EV = 4, WORST = {
      amo: ["commit", "just after e5's offset commit, before e5 is processed and written"],
      alo: ["write", "just after e5's write, before the next offset commit"],
      atomic: ["buffer", "just after e5's write is buffered, before the transaction commits"],
      idem: ["write", "just after e5's write, before the next offset commit"],
    };
    const LAYOUT = {
      desk: {
        W: 640, H: [230, 298], fs: 12, big: 18, head: [14, 12], emailTitle: "Email service (external)",
        cell: { x0: 14, step: 62, w: 54, h: 40, perRow: 10, rows: [26] },
        proc: { x: 10, y: 102, w: 320, h: 118, title: 17, cap: 66, phase: 86, restart: 106 },
        pill: { dx: 14, step: 76, w: 64, dy: 28 },
        sink: { x: 345, y: 102, w: 285, h: 118, title: 17, rev: 44, field: 68, chips: 84 },
        email: { x: 10, y: 232, w: 620, h: 58 },
      },
      phone: {
        W: 360, H: [398, 464], fs: 12, big: 17, head: [10, 8], emailTitle: "Email service",
        cell: { x0: 10, step: 70, w: 62, h: 40, perRow: 5, rows: [18, 96] },
        proc: { x: 10, y: 170, w: 340, h: 110, title: 16, cap: 63, phase: 82, restart: 100 },
        pill: { dx: 16, step: 80, w: 68, dy: 26 },
        sink: { x: 10, y: 290, w: 340, h: 100, title: 16, rev: 40, field: 62, chips: 74 },
        email: { x: 10, y: 400, w: 340, h: 58 },
      },
    };

    let strategy = "alo", every = 3, emailOn = false;
    let st = null, running = false, gen = 0, view = null, compact = ctx.compact;
    const note = ui.note("", "info");

    // ---------- model ----------
    function initial() {
      return {
        pos: 3, committed: 3, total: 50, lastOffset: 2,
        counts: AMT.map((_, i) => (i < 3 ? 1 : 0)),
        applied: [0, 1, 2].map(i => ({ i, kind: "once" })),
        txn: [], emails: emailOn ? [0, 1, 2].map(i => ({ i, kind: "sent" })) : [],
        mailed: AMT.map((_, i) => (emailOn && i < 3 ? 1 : 0)),
        cur: null, phase: null, crashed: null, crashView: null, crashes: [], skipped: [],
        worst: "none", fast: false, done: false, msg: [recipe(), ""],
      };
    }
    const inHand = () => (st.cur && st.cur.k > 0 ? st.cur.i : -1);
    const commitDue = () => strategy === "amo" || st.pos - st.committed >= every || st.pos >= NEV;

    function outcome() {
      const hand = inHand(), lost = [], dup = [];
      let extra = 0, short = 0;
      AMT.forEach((a, i) => {
        if (st.counts[i] > 1) { dup.push(i); extra += (st.counts[i] - 1) * a; }
        if (!st.counts[i] && i < st.committed && i !== hand) { lost.push(i); short += a; }
      });
      const mailLost = emailOn ? AMT.map((_, i) => i).filter(i => !st.mailed[i] && i < st.committed && i !== hand) : [];
      const of = kind => uniq(st.emails.filter(e => e.kind === kind).map(e => e.i));
      const sent = st.emails.filter(e => e.kind !== "suppressed").length;
      return { lost, dup, extra, short, should: st.total - extra + short, sent, mailLost, mailDup: of("dup"), suppressed: of("suppressed") };
    }

    function applyWrite(i) {
      st.applied.push({ i, kind: st.counts[i]++ ? "dup" : "once" });
      st.total += AMT[i];
      st.lastOffset = i;
    }
    function apply(name, i) {
      if (name === "read") st.pos = i + 1;
      else if (name === "buffer") st.txn.push(i);
      else if (name === "process" && emailOn) {
        // The idempotent strategy hands the email service a key per event (topic-partition-offset).
        const kind = !st.mailed[i] ? "sent" : strategy === "idem" ? "suppressed" : "dup";
        st.emails.push({ i, kind });
        if (kind !== "suppressed") st.mailed[i]++;
      } else if (name === "write") {
        if (strategy === "idem" && i <= st.lastOffset) { st.applied.push({ i, kind: "skip" }); st.skipped.push(i); }
        else applyWrite(i);
      } else if (name === "commit") {
        if (strategy === "atomic") { st.txn.forEach(applyWrite); st.txn = []; }
        st.committed = st.pos;
      }
    }

    function recipe() {
      return {
        amo: "commits each offset before it processes the event",
        alo: "writes first, commits the offset afterwards",
        atomic: "buffers writes, commits them with the offset",
        idem: "each write carries its offset; repeats are skipped",
      }[strategy];
    }
    function phaseMsg(name, i) {
      const a = usd(AMT[i]);
      if (name === "read") return [`read ${E(i)} (${a}) from the log`, ""];
      if (name === "process") return [emailOn ? `process ${E(i)} and email the customer` : `process ${E(i)}`, ""];
      if (name === "buffer") return [`buffer +${a} in the open DB transaction`, "warn"];
      if (name === "write") {
        if (strategy !== "idem") return [`revenue += ${a}`, ""];
        return i <= st.lastOffset ? [`skip ${E(i)}: offset ${i} already applied`, "ok"] : [`revenue += ${a}, last offset = ${i}`, ""];
      }
      return strategy === "atomic"
        ? [`commit +${usd(sum(st.txn))} and offset ${st.pos} atomically`, "ok"]
        : [`commit offset ${st.pos} to the broker`, ""];
    }

    // ---------- run loop: every await is followed by a generation check ----------
    async function runPhase(name, i, my) {
      const T = st.fast ? 90 : 260, from = pillXY(name);
      st.phase = name;
      st.msg = phaseMsg(name, i);
      render();
      const fly = (to, label, fill, f = from) =>
        ctx.fly(view.packets, { from: f, to, label, fill: V(fill), ms: T, r: 6, labelSize: view.L.fs });
      let anim;
      if (name === "read") anim = fly(from, E(i), "c6", cellCenter(i));
      else if (name === "process") anim = Promise.all([ctx.sleep(T), emailOn && fly(emailSlot(), "✉ " + E(i), "c5")]);
      else if (name === "buffer") anim = fly(sinkSlot(), "+" + usd(AMT[i]), "warn");
      else if (name === "write") anim = fly(sinkSlot(), "+" + usd(AMT[i]) + (strategy === "idem" ? ` @${i}` : ""), "ok");
      else if (strategy === "atomic") anim = fly(sinkSlot(), `+${usd(sum(st.txn))} · offset ${st.pos}`, "ok");
      else anim = fly(committedXY(st.pos), "offset " + st.pos, "c1");
      await anim;
      if (!ctx.alive || my !== gen) return false;
      apply(name, i);
      return true;
    }

    async function loop(my) {
      while (ctx.alive && my === gen) {
        if (!st.cur) {
          if (st.pos >= NEV) return finish();
          st.cur = { i: st.pos, k: 0, done: [] };
        }
        const names = PHASES[strategy], name = names[st.cur.k], i = st.cur.i;
        if (name !== "commit" || commitDue()) {
          if (!(await runPhase(name, i, my))) return;
          st.cur.done.push(name);
        }
        if (st.worst === "pending" && i === WORST_EV && name === WORST[strategy][0]) return crash("worst");
        if (++st.cur.k >= names.length) st.cur = null;
      }
    }

    function finish() {
      running = false;
      Object.assign(st, { done: true, phase: null, cur: null, msg: ["all 10 orders consumed", ""] });
      note.set(...endNote());
      render();
    }

    async function crash(kind) {
      const my = ++gen, cur = st.cur;
      view.packets.replaceChildren();
      const names = PHASES[strategy], from = cur ? cur.k + (kind === "worst" ? 1 : 0) : names.length;
      const c = {
        kind, i: cur ? cur.i : null, done: cur ? cur.done.slice() : [], phase: st.phase, committed: st.committed, aborted: st.txn.slice(),
        undone: names.slice(from).filter(n => n !== "commit" || commitDue()),   // phases that would still have run
      };
      st.crashes.push(c);
      st.worst = kind === "worst" ? "done" : st.worst === "pending" ? "none" : st.worst;
      const msg = c.aborted.length ? `open txn aborted: ${evs(c.aborted)} discarded`
        : c.i === null ? "crashed between events" : !c.done.length ? `crashed while reading ${E(c.i)}`
        : c.undone.length ? `${E(c.i)}'s ${and(c.undone)} never happen${c.undone.length > 1 ? "" : "s"}` : "crashed before the next offset commit";
      Object.assign(st, { crashView: c, txn: [], cur: null, phase: null, crashed: "down", fast: false, msg: [msg, "bad"] });
      note.set(...crashNote(c));
      render();
      if (!(await wait(my, 700))) return;
      st.crashed = "restart";
      render();
      if (!(await wait(my, 500))) return;
      restart();
      loop(my);
    }
    const wait = (my, ms) => ctx.sleep(ms).then(() => ctx.alive && my === gen);
    function restart() {
      Object.assign(st, { crashed: null, crashView: null, pos: st.committed, msg: [`restarted from offset ${st.committed}`, ""] });
      render();
    }

    function run() {
      if (st.done) reset();
      running = true;
      const my = ++gen;
      if (st.crashed) restart(); else render();
      loop(my);
    }
    function pause() {
      gen++;
      running = false;
      st.phase = null;   // the phase in flight is redone on resume; its effect was not applied
      view.packets.replaceChildren();
      render();
    }
    const worstReachable = () => st.worst === "none" && !st.done && !st.crashed && (st.cur
      ? st.cur.i < WORST_EV || (st.cur.i === WORST_EV && st.cur.k <= PHASES[strategy].indexOf(WORST[strategy][0]))
      : st.pos <= WORST_EV);
    function crashAtWorst() {
      if (!worstReachable()) return;
      st.worst = "pending";
      st.fast = true;
      note.set(`Fast-forwarding to the worst moment for this strategy: ${WORST[strategy][1]}.`, "info");
      if (running) render(); else run();
    }
    function reset() {
      gen++;
      running = false;
      st = initial();
      if (view) view.packets.replaceChildren();
      note.set(...introNote());
      render();
    }

    // ---------- explanations ----------
    function introNote() {
      const ev = every === 1 ? "after every event" : `every ${every} events`;
      return [{
        amo: "<b>At-most-once</b>: the consumer commits each order's offset <b>before</b> processing it and adding it to the revenue total. Press <b>Crash at worst moment</b> to crash between the two.",
        alo: `A consumer adds each order to a revenue total and commits its offset ${ev}. Press <b>Crash at worst moment</b> to see what each strategy loses or duplicates.`,
        atomic: `<b>Atomic commit</b>: the consumer buffers its writes in a database transaction and, ${ev}, commits them together with its new offset, which it keeps in the same database. Press <b>Crash at worst moment</b>.`,
        idem: "<b>Idempotent sink</b>: like at-least-once, but each write stores the order's offset in the same row as the total, and the sink skips any write whose offset it has already applied. Press <b>Crash at worst moment</b>.",
      }[strategy], "info"];
    }
    function crashNote(c) {
      const next = c.committed >= NEV ? "the end of the log" : E(c.committed);
      if (c.kind !== "worst") {
        const what = c.i === null ? "between events" : `during ${E(c.i)}'s ${c.phase || "work"}`;
        const ab = c.aborted.length ? ` and the open transaction (${evs(c.aborted)}) aborts` : "";
        return [`<b>Crash</b> ${what}: unfinished work is abandoned${ab}. The consumer restarts from offset ${c.committed} (${next}).`, "warn"];
      }
      const since = [];
      for (let i = c.committed; i <= WORST_EV; i++) since.push(i);
      const replay = `${evs(since)} ${since.length > 1 ? "are" : "is"} already in the revenue total, but the committed offset still points at <b>${next}</b>. The consumer will restart there and read ${since.length > 1 ? "them" : "it"} again.`;
      return {
        amo: [`<b>Crash!</b> e5's offset was already committed, but e5 was never processed or written. The consumer will restart at the committed offset: <b>${next}</b>.`, "bad"],
        alo: [`<b>Crash!</b> ${replay}`, "bad"],
        idem: [`<b>Crash!</b> ${replay} But the sink row also records that it applied everything up to offset ${st.lastOffset} (${E(st.lastOffset)}).`, "warn"],
        atomic: [`<b>Crash!</b> The writes for ${evs(c.aborted)} sat in an open transaction together with the new offset. It aborts: neither the revenue nor the stored offset moves, and the consumer restarts at <b>${next}</b>.`, "warn"],
      }[strategy];
    }
    function endNote() {
      const o = outcome(), c = st.crashes.find(x => x.kind === "worst") || st.crashes[st.crashes.length - 1];
      if (!c) return ["No crash, so the sink ends at the correct <b>$215</b>: every strategy gets this right. They differ only when the consumer crashes. Press <b>Crash at worst moment</b>.", "ok"];
      let html, tone = "ok";
      const many = st.crashes.length > 1;
      if (strategy === "amo") {
        const one = o.lost.length === 1, L = evs(o.lost);
        html = !o.lost.length ? "No order was between its offset commit and its write when the consumer crashed, so nothing was lost this time. At-most-once loses the order in hand only when the crash lands there."
          : (one && !many ? `${L}'s offset was committed before its write. After restarting at ${E(c.committed)}, ${L} was never written`
            : `The offset${one ? "" : "s"} of ${L} ${one ? "was" : "were"} committed before ${one ? "its write" : "their writes"}, and a crash came in between, so ${L} ${be(o.lost)} never written`) +
            `: revenue is <b>${usd(o.short)} short</b>. That is <b>at-most-once</b>.`;
        if (o.lost.length) tone = "bad";
      } else if (strategy === "alo") {
        const it = o.dup.length > 1 ? "them" : "it", D = evs(o.dup);
        html = !o.dup.length ? "Nothing had been written since the last offset commit when the consumer crashed, so the replay added nothing twice. At-least-once duplicates whatever was written after the last commit."
          : (many ? `${D} ${be(o.dup)} written after an offset commit, and the consumer crashed before the next one. Each restart re-read ${it} and added ${it} again`
            : `${D} ${be(o.dup)} written, but the last committed offset was after ${E(c.committed - 1)}. The restarted consumer re-reads ${it} and adds ${it} again`) +
            `: revenue is <b>${usd(o.extra)} too high</b>. <b>At-least-once</b> means duplicates.`;
        if (o.dup.length) tone = "bad";
      } else if (strategy === "atomic") {
        const ab = uniq(st.crashes.flatMap(x => x.aborted));
        html = ab.length
          ? `The writes for ${evs(ab)} were buffered in an open transaction that also carried the new offset (stored in the sink database). The crash aborted it, so neither the revenue nor the offset moved; after the restart ${ab.length > 1 ? "they were" : "it was"} processed and committed once. <b>Effectively-once.</b>`
          : "The crash came between transactions, so the revenue and the offset stored next to it were consistent, and the restart picked up exactly there. <b>Effectively-once.</b>";
      } else {
        const sk = uniq(st.skipped);
        html = sk.length
          ? `The sink stores the offset of the last order applied next to the total. The replayed ${evs(sk)} ${sk.length > 1 ? "carry offsets" : "carries an offset"} it has already applied, so ${sk.length > 1 ? "they were" : "it was"} skipped. <b>Processed twice, applied once.</b>`
          : "No write was replayed this time, so there was nothing to skip; the stored offset would have caught any replay. <b>Effectively-once.</b>";
      }
      if (emailOn && strategy === "amo" && o.mailLost.length) {
        html += ` The email for ${evs(o.mailLost)} was never sent either: at-most-once loses side effects too.`;
      } else if (emailOn && o.mailDup.length) {
        html += strategy === "atomic"
          ? ` But the emails for ${evs(o.mailDup)} went out twice: an email is an external side effect outside the transaction. Exactly-once inside the framework does not reach the outside world unless that service is idempotent too.`
          : ` The emails for ${evs(o.mailDup)} went out twice as well: a replay repeats every side effect.`;
        tone = "bad";
      } else if (emailOn && o.suppressed.length) {
        html += ` The email service received an idempotency key per order (topic, partition and offset), so the repeat emails for ${evs(o.suppressed)} were suppressed.`;
      }
      return [html, tone];
    }

    // ---------- geometry ----------
    const tw = (str, size) => str.length * size * 0.58;   // generous text-width estimate
    function cellAt(i) {
      const c = view.L.cell, r = Math.floor(i / c.perRow);
      return { x: c.x0 + (i % c.perRow) * c.step, y: c.rows[r], w: c.w, h: c.h };
    }
    const cellCenter = i => { const c = cellAt(i); return [c.x + c.w / 2, c.y + c.h / 2]; };
    // The boundary in front of offset k. "after" draws it right of cell k-1 (the end of a row),
    // "before" left of cell k (the start of the next row); k = 10 sits right of the last cell.
    function boundary(k, side) {
      const gap = (view.L.cell.step - view.L.cell.w) / 2;
      if (k >= NEV || (side === "after" && k > 0)) {
        const c = cellAt(Math.min(k, NEV) - 1);
        return { x: c.x + c.w + gap, y: c.y };
      }
      const c = cellAt(k);
      return { x: c.x - gap, y: c.y };
    }
    const committedXY = k => { const b = boundary(k, "after"); return [b.x, b.y + view.L.cell.h + 10]; };
    function pillBox(k) {
      const P = view.L.proc, p = view.L.pill;
      return { x: P.x + p.dx + k * p.step, y: P.y + p.dy, w: p.w, h: 26 };
    }
    const pillXY = name => { const b = pillBox(PHASES[strategy].indexOf(name)); return [b.x + b.w / 2, b.y + b.h / 2]; };
    // Chips are 28 wide on a 32 pitch; a packet lands on the slot of the next chip in a row.
    const slots = w => Math.floor((w - 24 + 4) / 32);
    const slotXY = (B, n, dy) => [B.x + 12 + Math.min(n, slots(B.w) - 1) * 32 + 14, B.y + dy + 9];
    const sinkSlot = () => slotXY(view.L.sink, st.applied.length + st.txn.length, view.L.sink.chips);
    const emailSlot = () => slotXY(view.L.email, st.emails.length, 28);

    // ---------- drawing ----------
    const T = (x, y, str, o = {}) => ctx.text(x, y, str, { size: view.L.fs, ...o });
    const R = (x, y, w, hh, o = {}) => s("rect", { x, y, width: w, height: hh, ...o });
    const CHIP = { once: ["ok-soft", "ok"], dup: ["bad-soft", "bad"], skip: ["ok-soft", "ok"], pending: ["warn-soft", "warn"], aborted: ["bad-soft", "bad"], sent: ["node", "node-stroke"], suppressed: ["ok-soft", "ok"] };
    function chipRow(g, x, y, w, items) {
      const n = slots(w), cut = items.length > n, shown = cut ? items.slice(-(n - 1)) : items;
      if (cut) g.appendChild(T(x + 14, y + 9.5, "…", { fill: V("muted"), weight: 700 }));
      shown.forEach((it, j) => {
        const cx = x + (j + (cut ? 1 : 0)) * 32, [f, k] = CHIP[it.kind], open = it.kind === "pending" || it.kind === "aborted";
        const struck = it.kind === "skip" || it.kind === "suppressed" || it.kind === "aborted";
        g.append(R(cx, y, 28, 18, { rx: 4, fill: V("bg") }),
          R(cx, y, 28, 18, { rx: 4, fill: V(f), stroke: V(k), "stroke-width": 1.2, "stroke-dasharray": open ? "3 2" : null }),
          T(cx + 14, y + 9.5, E(it.i), { weight: 600, fill: it.kind === "dup" ? V("bad") : struck ? V("muted") : V("ink") }));
        if (struck) g.appendChild(s("line", { x1: cx + 3, x2: cx + 25, y1: y + 9.5, y2: y + 9.5, stroke: V(k), "stroke-width": 1.6 }));
      });
    }
    function badge(g, x, y, str) {
      const w = tw(str, view.L.fs) + 10;
      g.append(R(x - w / 2, y - 7.5, w, 15, { rx: 7.5, fill: V("bg") }),
        R(x - w / 2, y - 7.5, w, 15, { rx: 7.5, fill: V("bad-soft"), stroke: V("bad"), "stroke-width": 1.2 }),
        T(x, y + 0.5, str, { weight: 700, fill: V("bad") }));
    }

    function drawCells(g, o) {
      const hand = inHand(), badges = [];
      for (let i = 0; i < NEV; i++) {
        const c = cellAt(i), done = i < st.committed, pending = !done && i < st.pos;
        const lost = o.lost.includes(i), twice = st.counts[i] > 1;
        const cg = g.appendChild(s("g", { opacity: done && !lost && !twice ? 0.55 : 1 }));
        cg.append(R(c.x, c.y, c.w, c.h, { rx: 5, fill: V("bg") }), R(c.x, c.y, c.w, c.h, {
          rx: 5, fill: V(done ? "node" : pending ? "warn-soft" : "panel"),
          stroke: V(lost || twice ? "bad" : pending ? "warn" : done ? "node-stroke" : "line"),
          "stroke-width": i === hand ? 2.6 : 1.3, "stroke-dasharray": lost ? "4 3" : null,
        }), T(c.x + c.w / 2, c.y + 14, E(i), { size: 12, weight: 700 }),
        T(c.x + c.w / 2, c.y + 29, usd(AMT[i]), { size: 12, fill: V("muted") }));
        if (lost) badges.push([c, "lost"]);
        else if (twice) badges.push([c, "×" + st.counts[i]]);
      }
      return badges;
    }

    function drawMarkers(g) {
      const L = view.L, ch = L.cell.h, fs = L.fs;
      const cm = boundary(st.committed, "after"), rd = boundary(st.pos, "before");
      g.appendChild(s("line", { x1: cm.x, x2: cm.x, y1: cm.y - 5, y2: cm.y + ch + 25, stroke: V("c1"), "stroke-width": 2.5 }));
      const names = strategy === "atomic" ? ["offset (stored in sink DB)", "offset (in sink DB)", "DB offset"] : ["committed"];
      const label = names.find(n => tw(n, fs) <= cm.x - 8) || names[names.length - 1];
      g.appendChild(T(cm.x - 5, cm.y + ch + 19, label, { anchor: "end", weight: 700, fill: V("c1"), halo: true }));
      const ty = rd.y + ch + 3;
      g.appendChild(s("path", { d: `M${rd.x},${ty} l-6,9 h12 z`, fill: V("c6") }));
      if (st.pos < NEV) g.appendChild(T(rd.x + 9, rd.y + ch + 19, "read", { anchor: "start", weight: 700, fill: V("c6") }));
      else if (st.committed < NEV) g.appendChild(T(rd.x - 9, rd.y + ch + 19, "read", { anchor: "end", weight: 700, fill: V("c6") }));
    }

    function drawProc(g) {
      const P = view.L.proc, down = !!st.crashed, cv = st.crashView;
      g.appendChild(ctx.box({ x: P.x, y: P.y, w: P.w, h: P.h, rx: 10, fill: V(down ? "bad-soft" : "c2-soft"), stroke: V(down ? "bad" : "c2"), strokeWidth: down ? 2.2 : 1.5 }));
      g.appendChild(T(P.x + 12, P.y + P.title, "consumer", { size: 13, weight: 700, anchor: "start" }));
      const hand = st.cur ? st.cur.i : -1;
      const status = st.crashed === "down" ? "✕ crashed" : st.crashed === "restart" ? `restarting from offset ${st.committed}`
        : st.done ? "done ✓" : hand >= 0 ? `${E(hand)} · ${usd(AMT[hand])}${running ? "" : " · paused"}` : running ? "" : "ready";
      g.appendChild(T(P.x + P.w - 12, P.y + P.title, status, { anchor: "end", weight: down ? 700 : 600, fill: V(down ? "bad" : st.done ? "ok" : "muted") }));
      PHASES[strategy].forEach((name, k) => {
        const b = pillBox(k), done = cv ? cv.done.includes(name) : !!st.cur && st.cur.done.includes(name);
        const active = running && st.phase === name && !down, dead = !!cv && cv.undone.includes(name);
        const [f, sk] = active ? ["warn-soft", "warn"] : done ? ["ok-soft", "ok"] : dead ? ["bad-soft", "bad"] : ["node", "node-stroke"];
        g.append(R(b.x, b.y, b.w, b.h, { rx: 13, fill: V("bg") }),
          R(b.x, b.y, b.w, b.h, { rx: 13, fill: V(f), stroke: V(sk), "stroke-width": active ? 2 : 1.3, "stroke-dasharray": dead ? "4 3" : null }),
          T(b.x + b.w / 2, b.y + 13.5, (done ? "✓ " : dead ? "✕ " : "") + name, { weight: active ? 700 : 600, fill: V(dead ? "bad" : "ink") }));
        if (k > 0) g.appendChild(T(b.x - (view.L.pill.step - b.w) / 2, b.y + 13, "›", { size: 15, fill: V("muted") }));
        if (name === "commit") {
          const cap = strategy === "amo" || every === 1 ? "every event" : `every ${every} events`;
          const cx = Math.min(b.x + b.w / 2, P.x + P.w - 10 - tw(cap, view.L.fs) / 2);
          g.appendChild(T(cx, P.y + P.cap, cap, { fill: V("muted") }));
        }
      });
      const [msg, tone] = st.msg;
      g.appendChild(T(P.x + 12, P.y + P.phase, msg, { anchor: "start", weight: 600, fill: V(tone || "ink") }));
      const k = st.committed, where = strategy === "atomic" ? "sink DB" : "broker";
      const rp = k >= NEV ? `restart point: end of log · offset ${k} in ${where}` : `restart point: ${E(k)} · offset ${k} in ${where}`;
      g.appendChild(T(P.x + 12, P.y + P.restart, rp, { anchor: "start", fill: V("muted") }));
    }

    function drawSink(g, o) {
      const S = view.L.sink, x = S.x + 12, xr = S.x + S.w - 12, off = o.extra || o.short;
      g.appendChild(ctx.box({ x: S.x, y: S.y, w: S.w, h: S.h, rx: 10, fill: V("panel"), stroke: V(off ? "bad" : "node-stroke") }));
      g.appendChild(T(x, S.y + S.title, "Sink DB", { size: 13, weight: 700, anchor: "start" }));
      const row = { amo: "revenue row", alo: "revenue row", atomic: "revenue + offset, one txn", idem: "one row: total + offset" }[strategy];
      g.appendChild(T(xr, S.y + S.title, row, { anchor: "end", fill: V("muted") }));
      g.appendChild(T(x, S.y + S.rev, "revenue " + usd(st.total), { size: view.L.big, weight: 800, anchor: "start", fill: V(off ? "bad" : "ink") }));
      g.appendChild(T(xr, S.y + S.rev, "should be " + usd(o.should), { anchor: "end", fill: V("muted") }));
      const delta = o.should === st.total ? "✓ correct" : st.total > o.should ? `+${usd(st.total - o.should)} too high` : `${usd(o.should - st.total)} short`;
      g.appendChild(T(xr, S.y + S.field, delta, { anchor: "end", weight: 700, fill: V(off ? "bad" : "ok") }));
      const field = strategy === "idem" ? [`last applied: offset ${st.lastOffset} (${E(st.lastOffset)})`, "ink"]
        : strategy === "atomic" ? [`consumer offset: ${st.committed}`, "c1"] : ["no offset stored here", "muted"];
      g.appendChild(T(x, S.y + S.field, field[0], { anchor: "start", weight: 600, fill: V(field[1]) }));
      const open = st.crashView ? st.crashView.aborted.map(i => ({ i, kind: "aborted" })) : st.txn.map(i => ({ i, kind: "pending" }));
      chipRow(g, x, S.y + S.chips, S.w, st.applied.concat(open));
    }

    function drawEmail(g, o) {
      const B = view.L.email, sent = o.sent;
      g.appendChild(ctx.box({ x: B.x, y: B.y, w: B.w, h: B.h, rx: 10, fill: V("panel"), stroke: V("c5") }));
      g.appendChild(T(B.x + 12, B.y + 16, view.L.emailTitle, { size: 13, weight: 700, anchor: "start" }));
      const [txt, tone] = o.mailDup.length ? [`${sent} sent · ${o.mailDup.length} duplicate${o.mailDup.length > 1 ? "s" : ""}`, "bad"]
        : o.mailLost.length ? [`${sent} sent · ${evs(o.mailLost)} never sent`, "bad"]
        : o.suppressed.length ? [`${sent} sent · ${o.suppressed.length} suppressed`, "ok"] : [`${sent} sent · no duplicates`, "muted"];
      g.appendChild(T(B.x + B.w - 12, B.y + 16, txt, { anchor: "end", weight: 700, fill: V(tone) }));
      chipRow(g, B.x + 12, B.y + 28, B.w, st.emails);
    }

    const ids = list => (list.length ? `${list.length} <span style="font-size:12px;font-weight:600">${uniq(list).map(E).join(", ")}</span>` : "0");
    function updateStats(o) {
      const S = view.stats, off = o.extra || o.short;
      S.set("sink", usd(st.total), off ? "bad" : st.done && st.total === CORRECT ? "ok" : "");
      S.set("lost", ids(o.lost), o.lost.length ? "bad" : "");
      S.set("dup", ids(o.dup), o.dup.length ? "bad" : "");
      if (strategy === "idem") S.set("skipped", ids(st.skipped), st.skipped.length ? "ok" : "");
      if (!emailOn) return;
      const sent = o.sent, small = t => ` <span style="font-size:12px;font-weight:600">${t}</span>`;
      if (o.mailDup.length) S.set("emails", sent + small(`(${o.mailDup.length} dup)`), "bad");
      else if (o.mailLost.length) S.set("emails", sent + small(`(${evs(o.mailLost)} never sent)`), "bad");
      else S.set("emails", sent + (o.suppressed.length ? small(`(${o.suppressed.length} suppressed)`) : ""), st.done ? "ok" : "");
    }
    function updateButtons() {
      const b = view.btn, reach = worstReachable();
      b.run.setLabel(running ? "⏸ Pause" : st.done ? "▶ Run again" : "▶ Run");
      b.crash.disable(!running || !!st.crashed);
      b.worst.disable(!reach);
      b.worst.title = reach ? "Crash " + WORST[strategy][1] : st.worst === "pending" ? "Fast-forwarding…" : "Reset first";
    }

    function render() {
      if (!view) return;
      const o = outcome();
      view.dyn.replaceChildren();
      const badges = drawCells(view.dyn, o);
      drawMarkers(view.dyn);
      badges.forEach(([c, str]) => badge(view.dyn, c.x + c.w - 4 - (tw(str, view.L.fs) + 10) / 2, c.y, str));
      drawProc(view.dyn);
      drawSink(view.dyn, o);
      if (emailOn) drawEmail(view.dyn, o);
      updateStats(o);
      updateButtons();
    }

    // Controls; rebuilt only when the layout switches between phone and desktop.
    function build() {
      compact = ctx.compact;
      const seg = ui.segmented({
        label: "Strategy", value: strategy,
        options: STRATS.map(o => ({ value: o.value, label: compact ? o.short : o.label })),
        onChange: v => { if (v !== strategy) { strategy = v; reset(); scene(); } },
      });
      const slider = ui.slider({
        label: "Commit every", min: 1, max: 5, value: every, format: v => v + (v === 1 ? " event" : " events"),
        onInput: v => { every = v; reset(); },
      });
      const toggle = ui.toggle({ label: "Email per order", value: emailOn, onChange: v => { emailOn = v; reset(); scene(); } });
      const btn = {
        run: ui.button("▶ Run", () => (running ? pause() : run()), { kind: "primary" }),
        crash: ui.button("Crash now", () => { if (running && !st.crashed) crash("manual"); }, { kind: "danger" }),
        worst: ui.button("Crash at worst moment", crashAtWorst),
        reset: ui.button("Reset", reset, { kind: "ghost" }),
      };
      const stage = ctx.h("div");
      root.replaceChildren(ui.bar(seg), ui.bar(slider, toggle), ui.bar(btn.run, btn.crash, btn.worst, btn.reset), stage);
      view = { L: compact ? LAYOUT.phone : LAYOUT.desk, btn, slider, stage };
      scene();
    }

    // Drawing surface, legend and stats, which depend on the strategy and the email toggle.
    function scene() {
      const L = view.L, amo = strategy === "amo";
      view.slider.input.disabled = amo;
      view.slider.title = amo ? "At-most-once commits before every event" : "";
      view.slider.style.opacity = amo ? 0.5 : "";
      const svg = ctx.svg({ w: L.W, h: L.H[emailOn ? 1 : 0], label: "A consumer reads orders from a log partition, adds them to a revenue total in a sink database, and commits its offset" });
      const dyn = s("g"), packets = s("g");
      svg.append(ctx.text(L.head[0], L.head[1], "orders log (one partition)", { size: L.fs, anchor: "start", fill: V("muted") }), dyn, packets);
      const stats = ui.stats([
        { key: "correct", label: "Correct total", value: usd(CORRECT) },
        { key: "sink", label: "Sink total" },
        { key: "lost", label: "Lost" },
        { key: "dup", label: "Applied twice" },
        ...(strategy === "idem" ? [{ key: "skipped", label: "Duplicates skipped" }] : []),
        ...(emailOn ? [{ key: "emails", label: "Emails" }] : []),
      ]);
      const legend = ui.legend([
        { color: V("c1"), label: strategy === "atomic" ? "committed offset (stored in sink DB)" : "committed offset", shape: "line" },
        { color: V("warn"), label: "read, not committed", shape: "square" },
        { color: V("ok"), label: "applied once", shape: "square" },
        { color: V("bad"), label: "applied twice", shape: "square" },
        ...(strategy === "atomic" ? [{ color: V("warn"), label: "in the open transaction", shape: "dash" }] : []),
        ...(strategy === "idem" ? [{ color: V("ok"), label: "replay skipped (struck out)", shape: "dash" }] : []),
      ]);
      view.stage.replaceChildren(svg, stats, note, legend);
      Object.assign(view, { svg, dyn, packets, stats });
      render();
    }

    st = initial();
    note.set(...introNote());
    build();
    // Rebuild with the other layout when the frame crosses the phone breakpoint; state is kept.
    // Deferred a tick so the rebuild does not resize the frame inside the ResizeObserver callback.
    ctx.onResize(() => { if (ctx.compact !== compact) ctx.after(0, () => { if (ctx.compact !== compact) build(); }); });
  },
});
