// Replication lag anomalies: a space-time diagram where one slow follower produces three
// user-visible anomalies, and the read-routing rule that removes each one. Every control
// change recomputes the scenario and instantly replays it to the last step.
(function () {
  "use strict";
  const EPS = 1e-9;
  const sec = t => (Math.round(t * 10) / 10).toFixed(1) + " s";
  const has = (applied, readAt) => applied <= readAt + EPS;

  // ---------- declarative marks (times in seconds, lanes by id, dy in lane heights) ----------
  const mk = (k, o) => Object.assign({ k }, o);
  const msg = (from, tf, to, tt, color, o) => mk("msg", Object.assign({ from, tf, to, tt, color, grow: true }, o));
  const dot = (lane, t, color, r) => mk("dot", { lane, t, color, r: r || 4 });
  const txt = (lane, t, text, o) => mk("text", Object.assign({ lane, t, text }, o));
  const span = (lane, ta, tb, tone, o) => mk("op", Object.assign({ lane, ta: Math.min(ta, tb), tb: Math.max(ta, tb), tone }, o));
  const vline = (t, text, anchor) => mk("vline", { t, text, anchor });
  const SCREEN = mk("screen", {});
  const lane = (id, label, sub, role, unused) => ({ id, label, sub, role, unused: !!unused });

  // Labels sit right of their dot, except near the end of the axis where they move below-left.
  const rightOrBelow = t => (t > 4 ? { dx: -7, dy: 0.36, anchor: "end" } : { dx: 7, anchor: "start" });
  // Leader -> follower: dashed arrow that grows for as long as the lag, then an arrival dot.
  // `below` keeps the label clear of slower arrows that cross this lane later.
  const repl = (from, t0, to, t1, label, below) => msg(from, t0, to, t1, "c1", {
    dashed: true, ms: Math.min(1300, 300 + 260 * (t1 - t0)),
    after: [dot(to, t1, "c2"), txt(to, t1, label || sec(t1), Object.assign({ color: "c2" }, below ? { dy: 0.36 } : rightOrBelow(t1)))],
  });

  // A read: request in the client colour, optional wait at the replica, response coloured by
  // what came back. Returns request phases and response phases separately (they are two steps).
  function read(o) {
    const serve = o.serve || o.t + 0.1;
    const req = [[vline(o.t, o.head, o.headAnchor), msg(o.from, o.t, o.to, o.t + 0.04, "c6", { ms: 420 })]];
    if (serve > o.t + 0.11) {
      req.push([span(o.to, o.t, serve - 0.05, "warn", { h: 8 }),
        txt(o.to, (o.t + serve - 0.05) / 2, "waiting " + sec(serve - 0.05 - o.t), { dy: 0.36, color: "warn" })]);
    }
    const back = serve + 0.05, endT = o.endAt ? o.endAt.t : back;
    const endPos = o.endAt || (endT > 3.9 ? { dx: -8, anchor: "end" } : { dx: 8, anchor: "start" });
    const ending = o.end ? [dot(o.from, back, o.tone), txt(o.from, endT, o.end, Object.assign({ color: o.tone }, endPos))] : [];
    const res = [[msg(o.to, serve, o.from, back, o.tone, { ms: 420, after: ending })]];
    return { req, res };
  }
  // Merge two phase lists so their marks animate together.
  const zip = (a, b) => a.map((p, i) => p.concat(b[i] || [])).concat(b.slice(a.length));
  const step = (title, detail, ...phases) => ({ title, detail, phases: phases.filter(p => p && p.length) });

  // ---------- Scenario 1: read your writes ----------
  function ryw(fix, lag, c) {
    const tw = 0.5, tr = 1.5, a2 = tw + lag;
    const waited = fix === "wait" ? Math.max(0, a2 - tr) : 0;
    const fresh = fix !== "off" || has(a2, tr);
    const tone = fresh ? "ok" : "bad";
    const head = {
      off: c ? "reload → F2" : "reload: load balancer picked F2",
      leader: c ? "reload → leader" : "reload: own data → leader",
      wait: c ? "reload → F2, LSN ≥ 1042" : "reload → F2, needs LSN ≥ 1042",
    }[fix];
    const rd = read({
      from: "user", to: fix === "leader" ? "leader" : "f2", t: tr, tone, head,
      serve: waited > 0 ? a2 + 0.05 : undefined,
      end: fresh ? (c ? "seen ✓" : "sees comment ✓") : (c ? "missing ✗" : "comment missing ✗"),
    });
    const write = [msg("user", tw, "leader", tw + 0.05, "c6", { after: [dot("leader", tw + 0.05, "c1")] }),
      txt("user", tw + 0.05, "insert comment", { dx: 6, dy: -0.32, anchor: "start", color: "c6" })];
    const ack = fix === "wait" && [msg("leader", tw + 0.12, "user", tw + 0.17, "c1"),
      txt("user", tw + 0.17, "LSN 1042", { dx: 6, dy: 0.5, anchor: "start", color: "c1" })];

    let title4, detail4, why, whyMarks = [];
    if (fix === "off") {
      title4 = fresh ? "You see your comment" : "Your own comment is missing";
      detail4 = fresh ? "Follower 2 had already applied it, so the lag stayed invisible."
        : "Follower 2 has not applied your write yet, so the page renders without it.";
      why = fresh ? `Follower 2 applied it at ${sec(a2)}, ${sec(tr - a2)} before your read at 1.5 s. With more than 1.0 s of lag the comment would vanish.`
        : `Follower 2 applies it at ${sec(a2)}, ${Math.abs(a2 - tr - 1) < EPS ? "a full second" : sec(a2 - tr)} after your read at 1.5 s. The leader confirmed the write; the follower simply had not seen it yet.`;
      if (!fresh) whyMarks = [span("f2", tr, a2, tone), txt("f2", (tr + a2) / 2, "too late", { dy: 0.36, color: tone })];
    } else if (fix === "leader") {
      title4 = "You see your comment";
      detail4 = "The leader has every write, including yours.";
      why = "Only reads of data you may have modified (here, your own comments) go to the leader; everything else is still served by followers. Across regions, that means a trip to the leader's region.";
      whyMarks = [span("leader", tw + 0.05, tr, "ok")];
    } else {
      title4 = waited > 0 ? `You see your comment, ${sec(waited)} late` : "You see your comment";
      detail4 = waited > 0 ? "Follower 2 answered as soon as it reached LSN 1042." : "Follower 2 had already reached LSN 1042.";
      why = waited > 0 ? `Follower 2 reached LSN 1042 at ${sec(a2)} and only then answered: the right result, but ${sec(waited)} slower. It could also hand the read to a replica that is caught up.`
        : `Follower 2 reached LSN 1042 at ${sec(a2)}, before your read, so it answered at once. Raise the lag above 1.0 s to make it wait.`;
    }
    const notes = {
      off: fresh
        ? [`Follower 2 applied your comment at <b>${sec(a2)}</b>, before your reload. No anomaly this time, which is exactly why these bugs only appear under load, when lag spikes.`, "ok"]
        : [`You wrote at 0.5 s and reloaded at 1.5 s, but Follower 2 only applies your comment at <b>${sec(a2)}</b>. Your own comment vanished: <b>read-your-writes</b> is violated.`, "bad"],
      leader: ["Reads of data you recently changed go to the <b>leader</b>, which always has your write. Cost: extra load on the leader and, across regions, a trip to the leader's region.", "ok"],
      wait: waited > 0
        ? [`Your session remembered the log position of your write (<b>LSN 1042</b>). Follower 2 held the read until it had applied it: correct, but this read took <b>${sec(waited)}</b> longer.`, "warn"]
        : [`Your session remembered the log position of your write (<b>LSN 1042</b>). Follower 2 had already applied it, so the read was served at once.`, "ok"],
    };
    return {
      who: "User 1234",
      lanes: [lane("user", "User 1234", "you", "client"), lane("leader", "Leader", null, "leader"),
        lane("f1", "Follower 1", "lag 0.3 s", "follower"), lane("f2", "Follower 2", "lag " + sec(lag), "follower")],
      steps: [
        step("You post a comment", fix === "wait" ? "The leader applies it at 0.55 s and tells your session its log position, LSN 1042."
          : "Your write goes to the leader, which applies it at 0.55 s and confirms.", write, ack),
        step("The leader streams it to both followers", `Asynchronous replication: Follower 1 applies it at 0.8 s, Follower 2 (lag ${sec(lag)}) at ${sec(a2)}.`,
          [repl("leader", tw + 0.05, "f1", tw + 0.3, null, true), repl("leader", tw + 0.05, "f2", a2, c ? null : "applied " + sec(a2))]),
        step("You reload the page", {
          off: "At 1.5 s the load balancer sends your read to Follower 2.",
          leader: "Your comments are data you may have modified, so the read goes to the leader.",
          wait: "The read carries LSN 1042: Follower 2 may only answer once it has applied that position.",
        }[fix], ...rd.req),
        step(title4, detail4, ...rd.res.map((p, i) => (i === 0 ? p.concat(SCREEN) : p))),
        step("Why", why, whyMarks),
      ],
      screen: fresh ? "your comment is there ✓" : "your comment is missing ✗",
      tone: fix === "wait" && waited > 0 ? "warn" : tone,
      outcome: fix === "wait" && waited > 0 ? [`OK, waited ${sec(waited)}`, "warn"] : fresh ? ["OK", "ok"] : ["Anomaly", "bad"],
      gap: "1.0 s after the write",
      note: notes[fix],
    };
  }

  // ---------- Scenario 2: monotonic reads ----------
  function mono(fix, lag, c) {
    const pin = fix === "pin", tw = 0.3, a = { f1: 0.6, f2: tw + lag }, times = [1.2, 2.0];
    const to = pin ? ["f2", "f2"] : ["f1", "f2"];
    const seen = to.map((id, i) => has(a[id], times[i]));
    // A missing read is only an anomaly if an earlier read already showed the comment.
    const tones = seen.map((s, i) => (s ? "ok" : seen.slice(0, i).some(Boolean) ? "bad" : "warn"));
    const ends = tones.map(tn => ({ ok: c ? "seen ✓" : "sees comment ✓", bad: c ? "gone ✗" : "comment gone ✗", warn: c ? "stale" : "not yet (stale)" }[tn]));
    const heads = pin ? [c ? "read → F2" : "read: hash(2345) → F2", "refresh → F2"] : [c ? "read → F1" : "1st read → F1", "refresh → F2"];
    const reads = times.map((t, i) => read({
      from: "reader", to: to[i], t, tone: tones[i], end: ends[i], head: heads[i], headAnchor: i ? "start" : "end",
      endAt: i ? null : { t, dx: -6, anchor: "end" },
    }));
    const bad = tones.includes("bad"), stale = tones.includes("warn");
    const wording = s => (s ? "has" : "has not yet applied");
    // "Why" highlights the window in which Follower 2 was behind a read (only if one was).
    const firstMiss = seen.indexOf(false);
    const whyMarks = firstMiss < 0 ? [] : [span("f2", times[firstMiss], a.f2, tones[firstMiss])];
    const screen = bad ? "comment, then gone: time went backwards ✗"
      : seen[0] && seen[1] ? "the comment, both times ✓" : seen[1] ? "nothing yet, then the comment ✓" : "nothing yet, twice (stale)";
    return {
      who: "User 2345",
      lanes: [lane("writer", "User 2234", "writer", "client"), lane("leader", "Leader", null, "leader"),
        lane("f1", "Follower 1", "lag 0.3 s", "follower"), lane("f2", "Follower 2", "lag " + sec(lag), "follower"),
        lane("reader", "User 2345", pin ? (c ? "pinned F2" : "pinned to F2") : "reader", "client")],
      steps: [
        step("User 2234 posts a comment", "The write reaches the leader at 0.35 s.",
          [msg("writer", tw, "leader", tw + 0.05, "c6", { after: [dot("leader", tw + 0.05, "c1")] }),
            txt("writer", tw + 0.05, "insert comment", { dx: 6, dy: -0.32, anchor: "start", color: "c6" })]),
        step("Replication: F1 is fast, F2 is slow", `Follower 1 applies the comment at 0.6 s; Follower 2 (lag ${sec(lag)}) at ${sec(a.f2)}.`,
          [repl("leader", tw + 0.05, "f1", a.f1, null, true), repl("leader", tw + 0.05, "f2", a.f2)]),
        step("User 2345 reads (first time)", pin
          ? `hash(2345) maps this user to Follower 2, which ${wording(seen[0])} the comment at 1.2 s.`
          : "At 1.2 s the load balancer sends the read to Follower 1, which has the comment.", ...zip(reads[0].req, reads[0].res)),
        step(bad ? "User 2345 refreshes: the comment is gone" : "User 2345 refreshes", pin
          ? `Pinned again to Follower 2, which at 2.0 s ${wording(seen[1])} the comment.`
          : `Round robin sends the refresh to Follower 2, which at 2.0 s ${wording(seen[1])} the comment.`,
        ...zip(reads[1].req, reads[1].res.map((p, i) => (i === 0 ? p.concat(SCREEN) : p)))),
        step("Why", bad
          ? `The first read hit a replica that was ahead, the refresh one that was behind (Follower 2 applies the comment at ${sec(a.f2)}). Each read alone is a legal stale read; together they go back in time.`
          : pin ? "Both reads hit the same replica, and a replica only moves forward through its log. Stale is possible; backwards is not."
            : `Follower 2 applied the comment at ${sec(a.f2)}, before the refresh. Above 1.7 s of lag the refresh would go back in time.`, whyMarks),
      ],
      screen, tone: bad ? "bad" : stale ? "warn" : "ok",
      outcome: bad ? ["Anomaly", "bad"] : stale ? ["OK: stale, never backwards", "warn"] : ["OK", "ok"],
      gap: "0.9 s and 1.7 s after",
      note: bad ? ["Your first read hit Follower 1 and showed the comment; your refresh hit Follower 2, which has not applied it yet. The comment disappeared: <b>monotonic reads</b> is violated.", "bad"]
        : pin ? [`hash(user 2345) always picks Follower 2. Your reads can be stale (Follower 2 is <b>${sec(lag)}</b> behind), but a later read never shows an older state than an earlier one: <b>monotonic is not the same as fresh</b>.`, stale ? "warn" : "ok"]
          : [`Follower 2 applied the comment at <b>${sec(a.f2)}</b>, before the refresh, so both reads show it. Push the lag past 1.7 s and the refresh lands on a replica that is further behind.`, "ok"],
    };
  }

  // ---------- Scenario 3: consistent prefix ----------
  function cp(fix, lag, c) {
    const same = fix === "same", tq = 0.3, ta = 1.0, tr = 1.8;
    const aQ = tq + lag, aA = same ? ta + lag : ta + 0.3;
    const hasQ = has(aQ, tr), hasA = has(aA, tr);
    const bad = !same && !hasQ;
    const aLane = same ? "p1l" : "p2l", aFol = same ? "p1f" : "p2f";
    const seenText = hasQ && hasA ? "Q, then A" : hasQ ? "only Q so far" : "nothing yet"; // used when not bad
    const p1Tone = bad ? "bad" : same && !(hasQ && hasA) ? "warn" : "ok";
    const r1 = read({ from: "obs", to: "p1f", t: tr, tone: p1Tone, head: same ? "observer reads P1" : "observer reads both partitions", headAnchor: "start",
      end: bad ? (c ? "A, no Q ✗" : "sees A without Q ✗") : (c ? "" : "sees ") + seenText + (p1Tone === "ok" ? " ✓" : "") });
    const r2 = !same && read({ from: "obs", to: "p2f", t: tr, tone: "ok", end: "" });
    const answer = [dot(aLane, ta, "c6", 5), txt(aLane, ta, "Mrs. Cake", { dy: same ? -0.36 : 0.36, color: "c6" }),
      txt(aLane, ta, c ? "A: ~10 s" : "A: about ten seconds", { dx: 8, anchor: "start", color: "c6" })];
    // Causality: Mrs. Cake read the question before answering (dotted, crosses the observer lane at ~0.7 s).
    const saw = !same && msg("p1l", 0.45, "p2l", ta - 0.03, "muted", { dotted: true, ms: 500,
      after: c ? [] : [txt("obs", 0.71, "Cake reads Q", { dx: 6, anchor: "start", color: "muted" })] });
    // On a phone both arrivals share one lane in "same partition", so drop the times there.
    const short = same && c;
    const replQ = repl("p1l", tq + 0.05, "p1f", aQ, short ? "Q" : "Q " + sec(aQ));
    const replA = repl(aLane, ta + 0.05, aFol, aA, short ? "A" : "A " + sec(aA));
    return {
      who: "Observer",
      lanes: [lane("poons", "Mr. Poons", "asks", "client"), lane("p1l", "P1 leader", "partition 1", "leader"),
        lane("p1f", "P1 follower", "lag " + sec(lag), "follower"), lane("obs", "Observer", "reads", "client"),
        lane("p2f", "P2 follower", same ? "(unused)" : "lag 0.3 s", "follower", same),
        lane("p2l", "P2 leader", same ? "(unused)" : "partition 2", "leader", same)],
      steps: [
        step("Mr. Poons asks a question", "He writes Q to partition 1's leader at 0.3 s.",
          [msg("poons", tq, "p1l", tq + 0.05, "c6", { after: [dot("p1l", tq + 0.05, "c1")] }),
            txt("poons", tq + 0.05, c ? "Q: how far ahead…?" : "Q: how far ahead can you see?", { dx: 6, dy: -0.32, anchor: "start", color: "c6" })]),
        step("Mrs. Cake answers", same ? "She reads the question and answers at 1.0 s. With the fix, related messages share a partition, so the answer goes to partition 1 too."
          : "She reads the question (dotted line) and answers at 1.0 s. Her answer is stored in partition 2.", [saw, ...answer].filter(Boolean)),
        step(same ? "Partition 1 replicates both, in log order" : "Each partition replicates independently", same
          ? `One log, applied in order: its follower applies Q at ${sec(aQ)} and A at ${sec(aA)}.`
          : `Partition 1's follower is ${sec(lag)} behind and applies Q at ${sec(aQ)}; partition 2's follower applies A at ${sec(aA)}.`, [replQ, replA]),
        step((same ? "The observer reads partition 1" : "The observer reads both partitions") + (bad ? ": answer before question" : ""),
          bad ? "Partition 2 already has the answer; partition 1 does not have the question yet." : `At 1.8 s the observer sees ${seenText}.`,
          ...(r2 ? zip(r1.req, r2.req) : r1.req), ...(r2 ? zip(r1.res, r2.res) : r1.res).map((p, i) => (i === 0 ? p.concat(SCREEN) : p))),
        step("Why", same ? "Both messages pass through one log. A follower can be behind, but it is behind on a prefix: nothing, Q, or Q then A, never A alone."
          : bad ? "There is no global order across partitions: A was written after Q, but partition 2 delivered it first."
            : `Partition 1's follower had Q by ${sec(aQ)}, so the order looked right. Above 1.5 s of lag it breaks.`,
        bad ? [span("p1f", tr, aQ, "bad")] : []),
      ],
      screen: bad ? "answer before question ✗" : seenText + (p1Tone === "ok" ? " ✓" : ""),
      tone: p1Tone,
      // Same partition but behind: stale like the pinned monotonic read, yet never out of order.
      outcome: bad ? ["Anomaly", "bad"] : p1Tone === "warn" ? ["OK: stale, never out of order", "warn"] : ["OK", "ok"],
      gap: "1.5 s after the question",
      note: bad ? [`The answer went to partition 2, whose follower is fast; the question sits in partition 1, whose follower is <b>${sec(lag)}</b> behind. The observer sees an answer to a question nobody has asked yet.`, "bad"]
        : same ? [`Both messages pass through one partition's log, which followers apply in order, so every reader sees a <b>prefix</b> of the conversation (here: ${seenText}).`, p1Tone]
          : [`Partition 1's follower applied the question at <b>${sec(aQ)}</b>, before the observer's read. Push its lag past 1.5 s and the answer shows up first.`, "ok"],
    };
  }

  const FIXES = {
    ryw: [["off", "Off", "Off"], ["leader", "Read own data from leader", "Read from leader"], ["wait", "Wait for my log position", "Wait for my LSN"]],
    mono: [["off", "Off", "Off"], ["pin", "Pin user to one replica", "Pin to one replica"]],
    cp: [["off", "Off", "Off"], ["same", "Same partition", "Same partition"]],
  };
  function scenario(kind, fix, lag, compact) {
    return ({ ryw, mono, cp })[kind](fix, lag, !!compact);
  }

  Viz.register("ch5/replication-lag", {
    title: "Replication lag anomalies",
    scenario, // pure model, exposed for tests
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      let anomaly = "ryw", fix = "off", lag = 2.0;
      let compact = ctx.compact, view = null, player = null, sc = null;
      const COL = c => `var(--viz-${c})`;

      // Five steps for every scenario; their text and marks come from the current scenario.
      const steps = [0, 1, 2, 3, 4].map(i => ({ title: "", run: st => playPhases(sc.steps[i].phases, st) }));

      async function playPhases(phases, st) {
        for (const phase of phases) {
          await Promise.all(phase.map(m => put(m, st)));
          await ctx.sleep(160);
        }
      }
      function fade(el) {
        if (ctx.instant || !el) return Promise.resolve();
        el.style.opacity = 0;
        return ctx.tween({ ms: 250, onUpdate: k => { el.style.opacity = k; } });
      }
      function grow(line, ms) {
        const [x1, y1, x2, y2] = line.getAttribute("d").match(/-?[\d.]+/g).map(Number);
        return ctx.tween({ ms, onUpdate: k => line.setAttribute("d", `M${x1},${y1} L${x1 + (x2 - x1) * k},${y1 + (y2 - y1) * k}`) });
      }
      async function put(m, st) {
        const { tl } = st, g = view.geo;
        if (m.k === "msg") {
          const el = tl.msg(m.from, m.tf, m.to, m.tt, { color: m.color, dashed: m.dashed });
          if (m.dotted) el.line.setAttribute("stroke-dasharray", "2 4");
          if (m.grow && !ctx.instant) await grow(el.line, m.ms || 450);
          if (m.after) await Promise.all(m.after.map(a => put(a, st)));
          return;
        }
        let el;
        if (m.k === "dot") el = tl.mark(m.lane, m.t, { color: m.color, r: m.r });
        else if (m.k === "op") el = tl.op(m.lane, m.ta, m.tb, { tone: m.tone, height: m.h || 10, dashed: !m.h });
        else if (m.k === "text") {
          if (!m.text) return;
          el = tl.overlay.appendChild(ctx.text(tl.x(m.t) + (m.dx || 0), tl.y(m.lane) + (m.dy || 0) * tl.laneHeight, m.text,
            { size: 11, weight: 600, anchor: m.anchor || "middle", fill: COL(m.color || "ink"), halo: true }));
        } else if (m.k === "vline") {
          const x = tl.x(m.t);
          el = s("g", null,
            s("line", { x1: x, x2: x, y1: g.top, y2: st.yEnd, stroke: "var(--viz-muted)", "stroke-dasharray": "3 4", opacity: 0.7 }),
            m.text ? ctx.text(x + (m.anchor === "end" ? 4 : m.anchor === "start" ? -4 : 0), g.top / 2, m.text,
              { size: 11, weight: 600, anchor: m.anchor || "middle", fill: "var(--viz-muted)" }) : null);
          st.under.appendChild(el);
        } else if (m.k === "screen") {
          el = st.screen;
          ctx.attr(st.screen.rect, { fill: COL(sc.tone + "-soft"), stroke: COL(sc.tone), "stroke-dasharray": "none" });
          ctx.attr(st.screen.label, { fill: COL(sc.tone) });
          st.screen.label.textContent = `${sc.who} sees: ${sc.screen}`;
        }
        await fade(el);
      }

      // Stepper init: rebuild lanes, grid, labels and an empty "screen" for the current scenario.
      function init() {
        const g = view.geo, n = sc.lanes.length, lanesH = n * g.laneH, yEnd = g.top + lanesH;
        view.stage.innerHTML = "";
        view.svg.setAttribute("viewBox", `0 0 ${g.W} ${yEnd + g.bottom}`);
        const tl = ctx.lanes({
          parent: view.stage, x: 0, y: g.top, w: g.W, h: lanesH, t0: 0, t1: 5, labelWidth: g.gutter,
          lanes: sc.lanes.map(l => ({ id: l.id, label: "", color: "var(--viz-line)" })),
        });
        const under = s("g");
        tl.root.insertBefore(under, tl.content);
        for (let t = 0; t <= 5; t++) {
          under.appendChild(s("line", { x1: tl.x(t), x2: tl.x(t), y1: g.top, y2: yEnd, stroke: "var(--viz-grid)" }));
          under.appendChild(ctx.text(tl.x(t), yEnd + 11, t + "s", { size: 11, fill: "var(--viz-muted)" }));
        }
        const roleCol = { client: "c6", leader: "c1", follower: "c2" };
        sc.lanes.forEach(l => {
          const y = tl.y(l.id);
          if (l.unused) under.appendChild(s("rect", { x: 0, y: y - g.laneH / 2, width: g.W, height: g.laneH, fill: "var(--viz-bg)", opacity: 0.6 }));
          under.appendChild(s("g", { opacity: l.unused ? 0.45 : null },
            ctx.text(g.gutter - 6, l.sub ? y - 6 : y, l.label, { size: g.font, weight: 700, anchor: "end", fill: COL(roleCol[l.role]) }),
            l.sub ? ctx.text(g.gutter - 6, y + 8, l.sub, { size: 11, anchor: "end", fill: "var(--viz-muted)" }) : null));
        });
        const by = yEnd + 22, bx = g.gutter, bw = g.W - bx - 6;
        const screen = s("g");
        screen.rect = s("rect", { x: bx, y: by, width: bw, height: 24, rx: 6, fill: "var(--viz-panel)", stroke: "var(--viz-line)", "stroke-dasharray": "4 3" });
        screen.label = ctx.text(bx + bw / 2, by + 12, `${sc.who} sees: …`, { size: g.font, weight: 600, fill: "var(--viz-muted)" });
        screen.append(screen.rect, screen.label);
        view.stage.appendChild(screen);
        return { tl, under, screen, yEnd };
      }

      function refresh() {
        sc = scenario(anomaly, fix, lag, compact);
        sc.steps.forEach((st, i) => { steps[i].title = st.title; steps[i].detail = st.detail; });
        view.stats.set("lag", sec(lag)).set("gap", sc.gap).set("out", sc.outcome[0], sc.outcome[1]);
        view.note.set(sc.note[0], sc.note[1]);
        player.goto(steps.length - 1);
      }
      // Slider drags rebuild at most once per animation frame (timer fallback for hidden tabs).
      let queued = false;
      function schedule() {
        if (queued) return;
        queued = true;
        const go = () => { if (queued && ctx.alive) { queued = false; refresh(); } };
        requestAnimationFrame(go);
        ctx.after(60, go);
      }

      function fixControl() {
        return ui.segmented({
          label: "Fix", value: fix,
          options: FIXES[anomaly].map(([value, long, short]) => ({ value, label: compact ? short : long })),
          onChange: v => { fix = v; refresh(); },
        });
      }
      const lagLabel = () => (anomaly === "cp" ? "Partition 1 follower lag" : "Follower 2 lag");

      function build() {
        compact = ctx.compact;
        root.innerHTML = "";
        const geo = compact
          ? { W: 360, gutter: 80, top: 22, laneH: 42, bottom: 50, font: 11 }
          : { W: 640, gutter: 116, top: 28, laneH: 44, bottom: 52, font: 12 };
        const fixSlot = h("div", { style: "display: contents" }, fixControl());
        const slider = ui.slider({
          label: lagLabel(), min: 0.2, max: 4, step: 0.1, value: lag, format: v => v.toFixed(1) + " s",
          onInput: v => { lag = v; schedule(); },
        });
        const anomalySeg = ui.segmented({
          label: "Anomaly", value: anomaly,
          options: [{ value: "ryw", label: "Read your writes" }, { value: "mono", label: "Monotonic reads" }, { value: "cp", label: "Consistent prefix" }],
          onChange: v => {
            anomaly = v; fix = "off";
            fixSlot.replaceChildren(fixControl());
            slider.querySelector(".viz-slider-label").textContent = lagLabel();
            refresh();
          },
        });
        const svg = ctx.svg({ w: geo.W, h: 300, label: "Space-time diagram: writes, replication and reads on each replica" });
        const stage = s("g");
        svg.appendChild(stage);
        view = {
          geo, svg, stage,
          stats: ui.stats([
            { key: "lag", label: "Slow replica lag", tone: "info" },
            { key: "gap", label: "Read happens" },
            { key: "out", label: "Outcome" },
          ]),
          note: ui.note(""),
        };
        if (!sc) sc = scenario(anomaly, fix, lag, compact);
        if (!player) {
          player = ctx.stepper({
            init, steps, delay: 1300,
            intro: "Press <b>Play</b> to watch it unfold, or drag the lag slider and watch the outcome flip.",
          });
        }
        root.append(
          ui.bar(anomalySeg, fixSlot, slider),
          svg,
          ui.legend([
            { color: "var(--viz-c6)", label: "client" },
            { color: "var(--viz-c1)", label: "leader" },
            { color: "var(--viz-c2)", label: "follower" },
            { color: "var(--viz-c1)", label: "replication", shape: "dash" },
            { color: "var(--viz-ok)", label: "saw the data", shape: "line" },
            { color: "var(--viz-bad)", label: "anomaly", shape: "line" },
            { color: "var(--viz-warn)", label: "stale but allowed / waiting", shape: "line" },
          ]),
          player.el, view.stats, view.note);
        refresh();
      }

      build();
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
