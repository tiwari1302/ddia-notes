// Partitions and consumer groups (DDIA ch11, "Logs as brokers"). Each partition is an append-only
// log read in order by exactly one consumer of the group, which remembers only its offset. So the
// partition count caps the group's parallelism, a slow message blocks every partition its consumer
// owns (head-of-line blocking), a hot key overloads one partition, a consumer whose lag outruns
// retention silently skips messages, and adding a partition remaps most keys.
// Illustrative model: 250 ms ticks, 2.5 msg/s per consumer, retention counted in messages.
(function () {
  "use strict";

  const KEYS = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const HASH = { A: 17, B: 42, C: 8, D: 91, E: 33, F: 64, G: 25, H: 50 };
  const TICK = 250, CAP = 2.5, SLOW_MS = 6000, REBAL_MS = 1500, MOVED_MS = 6000, LOSS_MS = 5000, MAX_P = 6;
  // No amber/orange (lag / producer), and green last: it means "ok" elsewhere in the chapter.
  const COLORS = ["c2", "c1", "c5", "c6", "c8", "c4"];
  const SEED = [[12, 2], [14, 3], [10, 1], [11, 2]];   // initial [messages, lag] of P0..P3

  // ---------------- Pure model (no DOM) ----------------
  const partOf = (key, P) => HASH[key] % P;
  const ownerOf = (p, C) => p % C;   // round-robin assignment
  const ownedBy = (k, P, C) => Array.from({ length: P }, (_, p) => p).filter(p => p % C === k);
  const keyProb = (key, hot) => (hot ? (key === "A" ? 0.6 : 0) + 0.4 / 8 : 1 / 8);
  // Expected msg/s into partition p / consumer k, from the key distribution (not measured).
  const partRate = (st, p) => st.rate * KEYS.filter(key => partOf(key, st.P) === p).reduce((a, key) => a + keyProb(key, st.hot), 0);
  const inRate = (st, k) => ownedBy(k, st.P, st.C).reduce((a, p) => a + partRate(st, p), 0);
  const newConsumer = () => ({ cap: 2, rr: 0, busyUntil: 0, blocking: null });

  function createSim(rnd) {
    const st = {
      rnd, t: 0, running: false, P: 4, C: 2, rate: 4, R: 24, hot: false, acc: 0, parts: [], cons: [],
      lost: 0, rebalances: 0, rebalUntil: 0, consumed: [], losses: [], moved: [], movedAt: -Infinity,
    };
    SEED.forEach(([n, lag], p) => {
      const keys = KEYS.filter(key => partOf(key, 4) === p);
      const msgs = Array.from({ length: n }, (_, off) => ({ off, key: rnd.pick(keys), slow: false }));
      st.parts.push({ start: 0, end: n, pos: n - lag, msgs, lostRange: null });
    });
    st.cons = [newConsumer(), newConsumer()];
    return st;
  }

  function append(st, key, slow) {
    const p = partOf(key, st.P), pt = st.parts[p];
    pt.msgs.push({ off: pt.end++, key, slow });
    trim(st, p);
  }

  // Retention keeps the newest R messages. A position that falls below the start offset jumps
  // forward: those messages were deleted before the consumer read them.
  function trim(st, p) {
    const pt = st.parts[p];
    while (pt.msgs.length > st.R) { pt.msgs.shift(); pt.start++; }
    if (pt.pos < pt.start) {
      const n = pt.start - pt.pos;
      st.lost += n;
      st.losses.push({ t: st.t, n, p, k: ownerOf(p, st.C) });
      pt.lostRange = [pt.pos, pt.start];
      pt.pos = pt.start;
    }
  }

  function commit(st, pt) { pt.pos++; st.consumed.push(st.t); }

  // One thread per consumer: it reads its partitions round-robin, one message at a time, and a
  // slow message holds the thread (so every partition it owns) for SLOW_MS before it is committed.
  function consume(st, k) {
    const c = st.cons[k];
    c.cap = Math.min(2, c.cap + CAP * TICK / 1000);
    if (st.t < st.rebalUntil) return;
    if (c.blocking) {
      if (st.t < c.busyUntil) return;
      const pt = st.parts[c.blocking.p];
      if (pt.pos === c.blocking.off) commit(st, pt);
      c.blocking = null;
    }
    const mine = ownedBy(k, st.P, st.C);
    while (c.cap >= 1) {
      let p = -1;
      for (let i = 0; i < mine.length && p < 0; i++) {
        const q = mine[(c.rr + i) % mine.length];
        if (st.parts[q].pos < st.parts[q].end) { p = q; c.rr = (c.rr + i + 1) % mine.length; }
      }
      if (p < 0) return;
      const pt = st.parts[p], m = pt.msgs[pt.pos - pt.start];
      c.cap -= 1;
      if (m.slow) { c.blocking = { p, off: m.off }; c.busyUntil = st.t + SLOW_MS; return; }
      commit(st, pt);
    }
  }

  function tick(st) {
    st.t += TICK;
    st.acc += st.rate * TICK / 1000;   // multiples of 0.25: exact in floating point
    while (st.acc >= 1) {
      st.acc -= 1;
      append(st, st.hot && st.rnd() < 0.6 ? "A" : st.rnd.pick(KEYS), false);
    }
    st.cons.forEach((_, k) => consume(st, k));
    while (st.consumed.length && st.consumed[0] <= st.t - 4000) st.consumed.shift();
    st.losses = st.losses.filter(l => st.t - l.t < LOSS_MS);
  }

  // Eager rebalance: every consumer stops and gives up its partitions; work in flight is
  // abandoned and re-read from the committed offset. Instant while paused, but still counted.
  function rebalance(st) {
    st.rebalances++;
    st.rebalUntil = st.running ? st.t + REBAL_MS : st.t;
    st.cons.forEach(c => { c.blocking = null; c.rr = 0; });
  }
  function setConsumers(st, C) {
    if (C === st.C) return;
    while (st.cons.length < C) st.cons.push(newConsumer());
    st.cons.length = C;
    st.C = C;
    rebalance(st);
  }
  function addPartition(st) {
    if (st.P >= MAX_P) return;
    const old = st.P++;
    st.parts.push({ start: 0, end: 0, pos: 0, msgs: [], lostRange: null });
    st.moved = KEYS.filter(key => partOf(key, old) !== partOf(key, st.P));
    st.movedAt = st.t;
    rebalance(st);
  }
  function setRetention(st, R) { st.R = R; st.parts.forEach((_, p) => trim(st, p)); }

  // ---------------- Text helpers ----------------
  const cname = k => "C" + (k + 1);
  const list = (a, and = "and") => (a.length < 3 ? a.join(` ${and} `) : a.slice(0, -1).join(", ") + ` ${and} ` + a[a.length - 1]);
  const fmt1 = v => v.toFixed(1).replace(/\.0$/, "");
  const uniq = a => Array.from(new Set(a));
  const partsLabel = ps => (ps.length >= 3 && ps.every((p, i) => !i || p === ps[i - 1] + 1)
    ? `P${ps[0]}–P${ps[ps.length - 1]}` : ps.map(p => "P" + p).join(" "));

  function hotNote(st) {
    const hp = partOf("A", st.P), k = ownerOf(hp, st.C), pr = partRate(st, hp), kr = inRate(st, k);
    const html = `Key A is hot: most events land in <b>P${hp}</b> (${fmt1(pr)} msg/s)`;
    if (pr > CAP) {
      return [html + ", more than one consumer can process (2.5/s), so its lag grows while other partitions idle. " +
        "More consumers cannot help, since one partition is read by at most one consumer in the group.", "warn"];
    }
    if (kr > CAP) {
      return [html + `, and ${cname(k)} receives ${fmt1(kr)} msg/s against its 2.5/s capacity, so its lag grows while ` +
        "others idle. One more consumer would help here, but never more than one per partition.", "warn"];
    }
    return [html + `, but at this rate ${cname(k)} keeps up. Raise the rate: one partition is read by at most one ` +
      `consumer, so P${hp} can never be consumed faster than one consumer's 2.5/s.`, "info"];
  }

  // The explanation line: the first rule that matches wins.
  function noteFor(st) {
    const { P, C } = st;
    if (st.losses.length) {
      const n = st.losses.reduce((a, l) => a + l.n, 0), ks = uniq(st.losses.map(l => cname(l.k)));
      const ps = uniq(st.losses.map(l => l.p)).sort((a, b) => a - b).map(p => "P" + p), many = n > 1;
      return [`<b>${list(ks)}</b> fell so far behind that retention deleted <b>${n}</b> message${many ? "s" : ""} ` +
        `${ks.length > 1 ? "they" : "it"} had not read yet (in ${list(ps)}); ${many ? "they were" : "it was"} skipped. ` +
        "Alert on lag long before it approaches retention.", "bad"];
    }
    const busy = st.cons.findIndex(c => c.blocking);
    if (busy >= 0) {
      const p = st.cons[busy].blocking.p, others = ownedBy(busy, P, C).filter(q => q !== p).map(q => "P" + q);
      return [`<b>${cname(busy)}</b> is stuck on one slow message in <b>P${p}</b>. Everything behind it in P${p} waits ` +
        "(head-of-line blocking)" + (others.length
          ? `, and so ${others.length > 1 ? "do" : "does"} ${list(others)}, because ${cname(busy)} reads its partitions on one thread.`
          : ".") + (C > 1 ? " Other consumers carry on." : " It is the only consumer, so the whole topic waits."), "warn"];
    }
    if (st.t - st.movedAt < MOVED_MS) {
      const stayed = KEYS.filter(key => !st.moved.includes(key));
      return [`Adding P${P - 1} means partition = hash(key) mod ${P} instead of mod ${P - 1}, which moves ` +
        `<b>${st.moved.length} of 8</b> keys` + (stayed.length ? ` (only ${list(stayed)} stay${stayed.length > 1 ? "" : "s"})` : "") +
        ". Their old events stay in the old partition and new ones go elsewhere, so a consumer can now see a key's " +
        "events out of order. Tap a moved key to trace it.", "bad"];
    }
    if (st.t < st.rebalUntil) {
      return ["<b>Rebalancing:</b> in an eager rebalance every consumer in the group stops and gives up its partitions " +
        "until they are reassigned, so nothing is consumed. Kafka's newer protocols (cooperative, KIP-848) shorten this pause.", "warn"];
    }
    const pend = st.parts.findIndex(pt => pt.msgs.some(m => m.slow && m.off >= pt.pos));
    if (pend >= 0) {
      return [`A slow message (C⏳) is waiting in <b>P${pend}</b>. When ${cname(ownerOf(pend, C))} reaches it, its single ` +
        `thread is busy for 6 s${st.running ? "." : ": press <b>Run</b>."}`, "info"];
    }
    const near = st.parts.map((pt, p) => ({ p, lag: pt.end - pt.pos }))
      .filter(o => o.lag > 0.8 * st.R).sort((a, b) => b.lag - a.lag)[0];
    if (near) {
      return [`P${near.p}'s lag (<b>${near.lag}</b>) is close to the retention limit (<b>${st.R}</b> messages): unless ` +
        `${cname(ownerOf(near.p, C))} catches up, retention will delete messages it has not read yet.`, "warn"];
    }
    if (st.hot) return hotNote(st);
    const loads = st.cons.map((_, k) => inRate(st, k)), worst = loads.indexOf(Math.max(...loads));
    if (loads[worst] > CAP + 1e-9) {
      const active = Math.min(C, P), total = active * CAP;
      if (st.rate > total) {
        return [`The producer writes <b>${st.rate}/s</b> but ${active} consumer${active > 1 ? "s" : ""} can process at most ` +
          `<b>${fmt1(total)}/s</b> (2.5/s each), so lag grows. ` + (C < P ? "Add consumers, up to one per partition."
            : "Every partition already has its own consumer: only more partitions (or faster consumers) help."), "warn"];
      }
      return [`<b>${cname(worst)}</b> receives <b>${fmt1(loads[worst])}/s</b> from ${list(ownedBy(worst, P, C).map(p => "P" + p))} ` +
        "but processes only 2.5/s, so its lag grows while other consumers have spare capacity: work is split by partition, " +
        "not by message.", "warn"];
    }
    if (C > P) {
      return [`Only ${P} partitions, so only ${P} consumers get work; the other ${C - P} sit${C - P > 1 ? "" : "s"} idle. ` +
        "A group's parallelism is capped by the partition count.", "info"];
    }
    const tries = [P < MAX_P && "6 consumers", "a slow message", "a hot key", st.R > 12 && "a short retention"].filter(Boolean);
    return [`A topic with ${P} partitions; each is read in order by exactly one consumer in the group, which remembers only ` +
      `its offset (the colored marker). ${st.running ? "Try" : "Press <b>Run</b>, then try"} ${list(tries, "or")}.`, "info"];
  }

  Viz.register("ch11/partitioned-log", {
    title: "Partitions and consumer groups",
    sim: { createSim, tick, append, setConsumers, addPartition, setRetention, partOf, ownedBy, inRate, noteFor },
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      let st = createSim(ctx.random(5));
      let view = null, ctl = null, focus = null, compact = ctx.compact, clipN = 0;
      const colOf = k => `var(--viz-${COLORS[k]})`;
      const toneVar = t => (t === "muted" ? "var(--viz-muted)" : `var(--viz-${t})`);

      function layout() {
        if (compact) {
          return {
            W: 360, N: 8, fs: 11, x0: 44, pitch: 38, cw: 32, ch: 26, laneX: 28, laneR: 350,
            laneY: p => 78 + p * 52, laneH: 30, cellDy: 2, capX: 8,
            gx: 214, gw: 60, gy: 37, lagX: 350, lagY: 40, lagAnchor: "end", l1: 11, l2: 25,
            chip: i => ({ x: 8 + (i % 4) * 88, y: 18 + Math.floor(i / 4) * 26, w: 80, h: 22 }),
            box: k => ({ x: 8 + (k % 3) * 116, y: 82 + st.P * 52 + Math.floor(k / 3) * 40, w: 110, h: 34 }),
            height: () => 82 + st.P * 52 + Math.ceil(st.C / 3) * 40,
          };
        }
        return {
          W: 640, N: 10, fs: 12, x0: 44, pitch: 35, cw: 31, ch: 28, laneX: 28, laneR: 452,
          laneY: p => 66 + p * 46, laneH: 36, cellDy: 4, capX: 104,
          gx: 398, gw: 48, gy: 23, lagX: 398, lagY: 12, lagAnchor: "start", l1: 12, l2: 27,
          chip: i => ({ x: 104 + i * 58, y: 20, w: 52, h: 22 }),
          box: k => ({ x: 536, y: 66 + k * 40, w: 98, h: 36 }),
          height: () => Math.max(56 + st.P * 46, 62 + st.C * 40) + 10,
        };
      }

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const runBtn = ui.button(st.running ? "⏸ Pause" : "▶ Run", () => setRunning(!st.running), { kind: "primary" });
        const slowBtn = ui.button("⏳ Slow message", () => { append(st, "C", true); draw(); },
          { title: "Append one message with key C that takes 6 s to process" });
        const addBtn = ui.button("Add partition", () => { addPartition(st); buildScene(); },
          { title: "Add one partition to the topic (up to 6)" });
        const hotT = ui.toggle({ label: "Hot key A", value: st.hot, onChange: v => { st.hot = v; draw(); } });
        const resetBtn = ui.button("Reset", reset, { kind: "ghost" });
        const cS = ui.slider({ label: "Consumers", min: 1, max: 6, value: st.C, onInput: v => { setConsumers(st, v); draw(); } });
        const rS = ui.slider({ label: "Produce rate", min: 1, max: 12, value: st.rate, format: v => v + "/s",
          onInput: v => { st.rate = v; draw(); } });
        const retS = ui.slider({ label: "Retention", min: 8, max: 40, step: 4, value: st.R, format: v => v + " msgs",
          onInput: v => { setRetention(st, v); draw(); } });
        if (compact) [cS, rS, retS].forEach(sl => { sl.input.style.flex = "1 1 80px"; });
        const stats = ui.stats([
          { key: "lag", label: "Total lag" }, { key: "tput", label: "Consumed/s" }, { key: "idle", label: "Idle consumers" },
          { key: "lost", label: "Lost to retention" }, { key: "reb", label: "Rebalances" },
        ]);
        const note = ui.note(""), host = h("div");
        root.append(
          ui.bar(runBtn, slowBtn, addBtn, hotT, resetBtn),
          ui.bar(cS, rS, retS),
          host,
          stats, note,
          ui.legend([
            { color: "var(--viz-warn)", label: "unread (lag)", shape: "square" },
            { color: "var(--viz-node-stroke)", label: "consumed", shape: "square" },
            { color: "var(--viz-bad)", label: "slow message", shape: "square" },
            { color: "var(--viz-c2)", label: "consumer's offset (next to read)", shape: "line" },
          ]),
          h("div", { class: "muted", style: "font-size:12px;line-height:1.45;margin-top:6px" },
            "Illustrative model: each consumer processes up to 2.5 msg/s on one thread (load = incoming rate ÷ 2.5/s) and a " +
            "slow message takes 6 s. The bar under each lag fills as lag approaches retention, counted here in messages per " +
            "partition (Kafka's is by time or size, 7 days by default). Partition p goes to consumer p mod C."),
        );
        ctl = { runBtn, addBtn, hotT, cS, rS, retS, stats, note, host };
        buildScene();
      }

      function reset() {
        st = createSim(ctx.random(5));
        focus = null;
        ctl.cS.set(st.C); ctl.rS.set(st.rate); ctl.retS.set(st.R); ctl.hotT.set(false);
        buildScene();
        setRunning(false);
      }

      function setRunning(on) {
        st.running = on;
        ctl.runBtn.setLabel(on ? "⏸ Pause" : "▶ Run");
        if (view.svg.pauseAnimations) view.svg[on ? "unpauseAnimations" : "pauseAnimations"]();
        draw();
      }

      // ---------- scene ----------
      function buildScene() {
        const L = layout();
        const svg = ctx.svg({ w: L.W, h: L.height(), label: `A topic with ${st.P} partitions read by one consumer group` });
        const muted = { size: L.fs, fill: "var(--viz-muted)" };
        const caption = ctx.text(L.capX, 10, "", { ...muted, anchor: "start" });
        svg.appendChild(caption);
        if (!compact) {
          svg.appendChild(ctx.box({ x: 8, y: 20, w: 84, h: 22, rx: 6, label: "Producer", size: 12,
            fill: "var(--viz-c7-soft)", stroke: "var(--viz-c7)" }));
          svg.appendChild(ctx.text(L.x0, 55, "◀ older", { ...muted, anchor: "start" }));
          svg.appendChild(ctx.text(L.x0 + (L.N - 1) * L.pitch + L.cw, 55, "newer, appended here ▶", { ...muted, anchor: "end" }));
          svg.appendChild(ctx.text(585, 55, "consumer group", muted));
        }
        const chips = KEYS.map((key, i) => buildChip(svg, L, key, i));
        const connG = s("g");
        svg.appendChild(connG);
        const lanes = st.parts.map((_, p) => buildLane(svg, L, p));
        const boxG = s("g");
        svg.appendChild(boxG);
        ctl.host.replaceChildren(svg);
        view = { L, svg, caption, chips, lanes, connG, boxG, fresh: true };
        if (!st.running && svg.pauseAnimations) svg.pauseAnimations();
        ctl.addBtn.disable(st.P >= MAX_P);
        draw();
        view.fresh = false;
      }

      function buildChip(svg, L, key, i) {
        const b = L.chip(i);
        const g = s("g", { role: "button", tabindex: 0, "aria-label": "Trace key " + key, style: "cursor:pointer" });
        g.rect = s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 5 });
        g.label = ctx.text(b.x + b.w / 2, b.y + b.h / 2 + 0.5, "", { size: L.fs, mono: true });
        g.append(g.rect, g.label);
        const toggle = () => { focus = focus === key ? null : key; draw(); };
        g.addEventListener("click", toggle);
        g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
        svg.appendChild(g);
        return g;
      }

      function buildLane(svg, L, p) {
        const y0 = L.laneY(p), cy = y0 + L.cellDy + L.ch / 2;
        // Cells slide in from under the right edge and out under the left one, like a conveyor.
        const clip = `pl-clip-${ctx.uid}-${++clipN}`, right = L.x0 + (L.N - 1) * L.pitch + L.cw + 4;
        svg.defs.appendChild(s("clipPath", { id: clip },
          s("rect", { x: L.laneX + 4, y: y0 - 4, width: right - L.laneX - 4, height: L.laneH + 8 })));
        const lane = { cells: new Map(), cellsG: s("g", { "clip-path": `url(#${clip})` }) };
        svg.appendChild(s("rect", { x: L.laneX, y: y0, width: L.laneR - L.laneX, height: L.laneH, rx: 6,
          fill: "var(--viz-grid)", opacity: 0.7 }));
        lane.stripe = s("rect", { x: L.laneX, y: y0, width: 4, height: L.laneH, rx: 2 });
        svg.append(lane.stripe, ctx.text(L.laneX - 4, cy, "P" + p, { size: 12, weight: 700, anchor: "end" }), lane.cellsG);
        lane.marker = s("rect", { x: 0, y: y0 + L.cellDy - 3, width: 3, height: L.ch + 6, rx: 1.5 });
        lane.back = ctx.text(L.x0 - 6, cy, "◀", { size: 12, weight: 700 });
        lane.sub = ctx.text(L.lagX, y0 + L.lagY, "", { size: L.fs, anchor: L.lagAnchor });
        lane.sub.owner = s("tspan", { "font-weight": 700 });
        lane.sub.lag = s("tspan");
        lane.sub.append(lane.sub.owner, lane.sub.lag);
        lane.gFill = s("rect", { x: L.gx, y: y0 + L.gy, height: 6, rx: 3 });   // lag ÷ retention
        svg.append(lane.marker, lane.back, lane.sub, s("rect", { x: L.gx, y: y0 + L.gy, width: L.gw, height: 6, rx: 3,
          fill: "var(--viz-bg)", stroke: "var(--viz-line)" }), lane.gFill);
        if (!ctx.instant) lane.marker.style.transition = "transform .3s ease, opacity .3s";
        return lane;
      }

      function makeCell(parent, L) {
        const g = s("g");
        g.rect = s("rect", { width: L.cw, height: L.ch, rx: 4, "stroke-width": 1.5 });
        g.label = ctx.text(L.cw / 2, L.ch / 2 + 0.5, "", { size: 12, weight: 700 });
        g.append(g.rect, g.label);
        if (!ctx.instant) g.style.transition = "transform .3s ease, opacity .3s";
        parent.appendChild(g);
        return g;
      }
      const move = (g, x, y, op) => { g.style.transform = `translate(${x}px,${y}px)`; g.style.opacity = op; };

      // The message a stuck consumer is processing pulses (SMIL, so it pauses with the simulation).
      function setPulse(g, on) {
        if (on && !g.pulse) {
          const L = view.L;
          g.pulse = s("rect", { x: -3, y: -3, width: L.cw + 6, height: L.ch + 6, rx: 6, fill: "none",
            stroke: "var(--viz-bad)", "stroke-width": 2 },
          s("animate", { attributeName: "opacity", values: "1;0.15;1", dur: "1s", repeatCount: "indefinite" }));
          g.appendChild(g.pulse);
        } else if (!on && g.pulse) { g.pulse.remove(); g.pulse = null; }
      }

      function styleCell(g, m, pt, p) {
        const read = m.off < pt.pos;
        const busy = st.cons.some(c => c.blocking && c.blocking.p === p && c.blocking.off === m.off);
        ctx.attr(g.rect, {
          fill: busy ? "var(--viz-bad-soft)" : read ? "var(--viz-node)" : "var(--viz-warn-soft)",
          stroke: m.slow ? "var(--viz-bad)" : read ? "var(--viz-node-stroke)" : "var(--viz-warn)",
          "stroke-width": focus === m.key ? 2.5 : 1.5,
        });
        g.label.textContent = m.key + (m.slow ? "⏳" : "");
        setPulse(g, busy);
        // Tracing a key: its messages at full strength wherever they are, everything else faded.
        if (focus) return m.key === focus ? 1 : 0.15;
        return read ? 0.5 : 1;
      }

      function drawLane(p, rebal) {
        const { L } = view, pt = st.parts[p], lane = view.lanes[p], k = ownerOf(p, st.C);
        const col = rebal ? "var(--viz-muted)" : colOf(k), y = L.laneY(p) + L.cellDy;
        const n = Math.min(L.N, pt.end - pt.start), lo = pt.end - n, animate = !view.fresh && !ctx.instant;
        for (let j = 0; j < n; j++) {
          const off = lo + j, m = pt.msgs[off - pt.start];
          let g = lane.cells.get(off);
          if (!g) {
            g = makeCell(lane.cellsG, L);
            lane.cells.set(off, g);
            if (animate) { move(g, L.x0 + (j + 1) * L.pitch, y, 0); g.getBoundingClientRect(); }   // slide in from the right
          }
          move(g, L.x0 + j * L.pitch, y, styleCell(g, m, pt, p));
        }
        lane.cells.forEach((g, off) => {
          if (off >= lo) return;
          lane.cells.delete(off);
          if (pt.lostRange && off >= pt.lostRange[0] && off < pt.lostRange[1]) {   // deleted before it was read
            ctx.attr(g.rect, { fill: "var(--viz-bad)", stroke: "var(--viz-bad)" });
            g.label.textContent = "✕";
          }
          if (!animate) { g.remove(); return; }
          move(g, L.x0 - L.pitch, y, 0);
          ctx.after(400, () => g.remove());
        });
        // Position marker between the last consumed and the first unread cell; ◀ if further left.
        const b = pt.pos - lo, lag = pt.end - pt.pos;
        ctx.attr(lane.marker, { fill: col });
        lane.marker.style.transform = `translateX(${L.x0 + b * L.pitch - (L.pitch - L.cw) / 2 - 1.5}px)`;
        lane.marker.style.opacity = b >= 0 ? 1 : 0;
        ctx.attr(lane.back, { fill: col });
        lane.back.style.display = b >= 0 ? "none" : "";
        ctx.attr(lane.stripe, { fill: col });
        const tone = lag > 0.8 * st.R ? "bad" : lag > 0 ? "warn" : "muted";
        lane.sub.owner.textContent = compact ? cname(k) + " · " : "";
        ctx.attr(lane.sub.owner, { fill: col });
        lane.sub.lag.textContent = "lag " + lag;
        ctx.attr(lane.sub.lag, { fill: toneVar(tone) });
        ctx.attr(lane.gFill, { width: L.gw * Math.min(1, lag / st.R), fill: toneVar(tone === "bad" ? "bad" : "warn") });
      }

      function statusOf(c, k, mine, rebal) {
        if (c.blocking) return [`⏳ stuck ${Math.max(1, Math.ceil((c.busyUntil - st.t) / 1000))} s`, "bad"];
        if (rebal) return ["rebalancing…", "warn"];
        if (!mine.length) return ["idle", "muted"];
        const load = inRate(st, k) / CAP;
        return [`load ${Math.round(load * 100)}%`, load > 1 + 1e-9 ? "bad" : load > 0.85 ? "warn" : "muted"];
      }

      function drawConsumers(rebal) {
        const { L, boxG, connG } = view;
        boxG.innerHTML = connG.innerHTML = "";
        st.cons.forEach((c, k) => {
          const b = L.box(k), mine = ownedBy(k, st.P, st.C), idle = !mine.length;
          const [txt, tone] = statusOf(c, k, mine, rebal);
          boxG.append(
            ctx.box({ ...b, rx: 6, fill: idle ? "var(--viz-node)" : `var(--viz-${COLORS[k]}-soft)`,
              stroke: idle ? "var(--viz-node-stroke)" : colOf(k), dashed: idle }),
            ctx.text(b.x + 8, b.y + L.l1, cname(k), { size: 12, weight: 700, anchor: "start" }),
            ctx.text(b.x + b.w - 8, b.y + L.l1, partsLabel(mine), { size: L.fs, anchor: "end", fill: "var(--viz-muted)" }),
            ctx.text(b.x + 8, b.y + L.l2, txt, { size: L.fs, anchor: "start", fill: toneVar(tone) }));
        });
        if (compact) return;
        st.parts.forEach((_, p) => {
          const b = L.box(ownerOf(p, st.C)), x1 = L.laneR, y1 = L.laneY(p) + L.laneH / 2, x2 = b.x, y2 = b.y + b.h / 2;
          connG.appendChild(s("path", {
            d: `M${x1},${y1} C${x1 + 46},${y1} ${x2 - 46},${y2} ${x2},${y2}`, fill: "none", "stroke-width": 1.5,
            stroke: rebal ? "var(--viz-muted)" : colOf(ownerOf(p, st.C)), opacity: rebal ? 0.5 : 0.75,
            "stroke-dasharray": rebal ? "4 4" : null,
          }));
        });
      }

      function drawChips() {
        const moved = st.t - st.movedAt < MOVED_MS ? st.moved : [];
        view.chips.forEach((g, i) => {
          const key = KEYS[i], mv = moved.includes(key), hot = st.hot && key === "A", foc = focus === key;
          g.label.textContent = `${key}→P${partOf(key, st.P)}${mv ? "!" : ""}`;
          ctx.attr(g.label, { fill: mv ? "var(--viz-bad)" : "var(--viz-ink)", "font-weight": foc || mv ? 700 : 400 });
          ctx.attr(g.rect, {
            fill: mv ? "var(--viz-bad-soft)" : hot ? "var(--viz-warn-soft)" : "var(--viz-node)",
            stroke: foc ? "var(--viz-ink)" : mv ? "var(--viz-bad)" : hot ? "var(--viz-warn)" : "var(--viz-node-stroke)",
            "stroke-width": foc ? 2.2 : 1.2,
          });
          g.setAttribute("aria-pressed", foc ? "true" : "false");
        });
      }

      function draw() {
        if (!view) return;
        const { L, svg } = view, rebal = st.t < st.rebalUntil;
        svg.setAttribute("viewBox", `0 0 ${L.W} ${L.height()}`);
        view.caption.textContent = `partition = hash(key) mod ${st.P} · ` +
          (focus ? `tracing key ${focus} (${compact ? "tap" : "click"} it again to stop)`
            : compact ? "tap a key to trace it" : "click a key to trace its messages");
        drawChips();
        st.parts.forEach((_, p) => drawLane(p, rebal));
        drawConsumers(rebal);
        const lag = st.parts.reduce((a, pt) => a + pt.end - pt.pos, 0), idle = Math.max(0, st.C - st.P);
        const win = Math.max(1000, Math.min(4000, st.t)) / 1000;
        ctl.stats.set("lag", lag, lag > 40 ? "bad" : lag > 20 ? "warn" : "")
          .set("tput", (st.consumed.length / win).toFixed(1), "")
          .set("idle", idle, idle > 0 ? "warn" : "")
          .set("lost", st.lost, st.lost > 0 ? "bad" : "")
          .set("reb", st.rebalances, "");
        ctl.note.set(...noteFor(st));
      }

      build();
      ctx.every(TICK, () => { if (st.running) { tick(st); draw(); } });
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
