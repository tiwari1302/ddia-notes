// Raft in miniature: five servers elect one leader per term by majority vote, and an entry
// counts as committed only once a majority stores it. Partition the network or crash servers
// and watch terms and overlapping majorities keep every committed entry safe.
(function () {
  "use strict";
  const N = 5, MAJORITY = 3, HEARTBEAT = 900, STEP = 10, MAX_LOG = 10;
  const CMDS = "cdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const name = i => "S" + (i + 1);
  const lastTerm = log => (log.length ? log[log.length - 1].term : 0);
  const same = (a, b) => !!a && !!b && a.term === b.term && a.cmd === b.cmd;
  const cmds = es => es.map(e => e.cmd).join(", ");
  const plural = (n, one, many) => (n === 1 ? one : many);

  // ------------------------------------------------------------------ model
  // Simplified, deterministic Raft. Virtual time advances in fixed steps, so a run depends
  // only on the seed and on when the user acts. emit(type, data) reports events to the view.
  function createCluster(rand, emit) {
    const base = [{ term: 1, cmd: "a" }, { term: 1, cmd: "b" }];
    const sim = { now: 0, msgs: [], elections: 0, version: 0, violation: null, net: "healthy",
      minority: null, origin: {}, nextCmd: 0 };
    const servers = (sim.servers = Array.from({ length: N }, (_, id) => ({
      id, alive: true, term: 1, role: id ? "follower" : "leader", votedFor: 0, votes: new Set(),
      log: base.slice(), commitIndex: 2, timeout: 1, deadline: 0, side: "B", leaderId: 0,
      match: Array(N).fill(2), lastBeat: -HEARTBEAT, blockedNoted: false,
    })));
    const leaderOf = { 1: 0 };   // term -> leader id (assertion: one leader per term)
    const chosen = base.slice(); // index -> committed entry (assertion: never changes)
    let acc = 0;

    const bump = () => sim.version++;
    const others = s => servers.filter(o => o !== s);
    // Timeouts spread far wider than one message delay (250-350 ms) keep split votes rare, and the
    // minimum stays above the worst heartbeat gap (900 + 350 - 250 ms) so a healthy cluster never votes.
    const resetTimer = s => { s.timeout = 1800 + rand() * 6200; s.deadline = sim.now + s.timeout; };
    servers.forEach(s => s.id && resetTimer(s));
    sim.leaders = (group = servers) => group.filter(s => s.alive && s.role === "leader").sort((a, b) => a.term - b.term);
    sim.top = group => sim.leaders(group).pop() || null;
    sim.committed = () => chosen.length;

    function violate(msg) {
      if (!sim.violation) { sim.violation = msg; console.error("[raft] safety violated: " + msg); emit("violation", { msg }); }
    }
    function send(s, to, type, payload) {
      sim.msgs.push({ type, from: s.id, to, term: s.term, sentAt: sim.now, arriveAt: sim.now + 250 + rand() * 100,
        dropped: s.side !== servers[to].side, payload });
    }
    function sendAppends(L) {
      L.lastBeat = sim.now;
      others(L).forEach(o => send(L, o.id, "AE", { log: L.log.slice(), commit: L.commitIndex, fresh: L.log.length > L.match[o.id] }));
    }
    function startElection(s) {
      const retry = s.role === "candidate";
      s.term++;
      Object.assign(s, { role: "candidate", votedFor: s.id, votes: new Set([s.id]), leaderId: null });
      if (!(s.term in sim.origin)) sim.origin[s.term] = s.id;
      resetTimer(s); sim.elections++; bump();
      emit("election", { s, retry, reach: servers.filter(o => o.alive && o.side === s.side).length });
      others(s).forEach(o => send(s, o.id, "RV", { lastTerm: lastTerm(s.log), lastIndex: s.log.length }));
    }
    function becomeLeader(s) {
      if (s.term in leaderOf && leaderOf[s.term] !== s.id) violate(`two leaders in term ${s.term}`);
      leaderOf[s.term] = s.id;
      Object.assign(s, { role: "leader", leaderId: s.id, blockedNoted: false, match: servers.map(o => (o === s ? s.log.length : 0)) });
      sim.minority = null;
      emit("elected", { s, votes: s.votes.size });
      sendAppends(s);
    }
    // Rule 2: any message with a higher term turns the receiver into a follower of that term.
    function observeTerm(s, m) {
      if (m.term <= s.term) return;
      const wasLeader = s.role === "leader", origin = sim.origin[m.term];
      Object.assign(s, { term: m.term, role: "follower", votedFor: null, leaderId: null });
      s.votes.clear(); bump();
      if (!wasLeader) return;
      resetTimer(s);
      const rejoined = !(m.term in leaderOf) && !!sim.minority && sim.minority.has(origin) && !sim.minority.has(s.id);
      emit("stepdown", { s, rejoiner: rejoined ? servers[origin] : null });
    }
    function recordCommits(s) {
      for (let i = 0; i < s.commitIndex; i++) {
        if (chosen[i] && !same(chosen[i], s.log[i])) violate(`index ${i + 1} committed twice with different entries`);
        chosen[i] = chosen[i] || s.log[i];
      }
    }
    // Simplification: the follower takes the leader's whole log. It keeps a longer copy only
    // when that copy came from this same leader (its last entry has the leader's term).
    function adoptLog(s, log, term) {
      const mine = s.log;
      if (mine.length > log.length && lastTerm(mine) === term && log.every((e, i) => same(e, mine[i]))) return;
      const lost = mine.map((entry, index) => ({ entry, index })).filter(x => !same(x.entry, log[x.index]));
      lost.forEach(x => {
        if (x.index < s.commitIndex || same(chosen[x.index], x.entry)) violate(`${name(s.id)} lost committed entry ${x.entry.cmd}`);
      });
      s.log = log;
      if (lost.length) emit("discard", { s, lost });
    }
    // Rule 7: commit the highest index stored on a majority, but only if it is from this term.
    function advanceCommit(L) {
      const stored = n => L.match.filter((m, i) => (i === L.id ? L.log.length : m) >= n).length;
      let n = L.log.length;
      while (n > L.commitIndex && stored(n) < MAJORITY) n--;
      if (n <= L.commitIndex) return;
      if (L.log[n - 1].term !== L.term) {
        if (!L.blockedNoted) emit("blocked", { s: L, entries: L.log.slice(L.commitIndex, n) });
        L.blockedNoted = true;
        return;
      }
      const known = chosen.length; // a restarted leader may be catching up on old commits
      L.commitIndex = n;
      recordCommits(L); bump();
      const fresh = L.log.slice(known, n);
      if (fresh.length) emit("commit", { s: L, entries: fresh, count: stored(n) });
    }

    const handlers = {
      RV(s, m) {
        const p = m.payload, mine = lastTerm(s.log);
        const upToDate = p.lastTerm > mine || (p.lastTerm === mine && p.lastIndex >= s.log.length);
        const granted = m.term === s.term && (s.votedFor === null || s.votedFor === m.from) && upToDate;
        if (granted) { s.votedFor = m.from; resetTimer(s); bump(); }
        else if (m.term === s.term) emit("refuse", { s, cand: servers[m.from], reason: upToDate ? "voted" : "log" });
        send(s, m.from, "RVR", { granted });
      },
      RVR(s, m) {
        if (s.role !== "candidate" || m.term !== s.term || !m.payload.granted) return;
        s.votes.add(m.from); bump();
        if (s.votes.size >= MAJORITY) becomeLeader(s);
      },
      AE(s, m) {
        if (m.term < s.term) return send(s, m.from, "AER", { success: false });
        Object.assign(s, { role: "follower", leaderId: m.from });
        s.votes.clear(); resetTimer(s);
        adoptLog(s, m.payload.log, m.term);
        s.commitIndex = Math.max(s.commitIndex, Math.min(m.payload.commit, s.log.length));
        recordCommits(s); bump();
        send(s, m.from, "AER", { success: true, match: s.log.length });
      },
      AER(s, m) {
        if (s.role !== "leader" || m.term !== s.term || !m.payload.success) return;
        s.match[m.from] = Math.max(s.match[m.from], m.payload.match);
        advanceCommit(s);
      },
    };

    function deliver(m) {
      const s = servers[m.to];
      if (!s.alive) return; // a crashed server never sees it
      observeTerm(s, m);
      handlers[m.type](s, m);
    }
    function tick() {
      sim.now += STEP;
      const due = sim.msgs.filter(m => !m.dropped && m.arriveAt <= sim.now).sort((a, b) => a.arriveAt - b.arriveAt);
      // A dropped message dies halfway and fades for 300 ms.
      sim.msgs = sim.msgs.filter(m => (m.dropped ? sim.now < (m.sentAt + m.arriveAt) / 2 + 300 : m.arriveAt > sim.now));
      due.forEach(deliver);
      servers.forEach(s => {
        if (!s.alive) return;
        if (s.role === "leader") { if (sim.now - s.lastBeat >= HEARTBEAT) sendAppends(s); }
        else if (sim.now >= s.deadline) startElection(s);
      });
    }

    sim.advance = ms => {
      acc = Math.min(acc + ms, 400);
      while (acc >= STEP) { acc -= STEP; tick(); }
    };
    sim.toggle = i => {
      const s = servers[i];
      s.alive = !s.alive;
      if (s.alive) { Object.assign(s, { role: "follower", commitIndex: 0, leaderId: null }); s.votes.clear(); resetTimer(s); }
      bump();
    };
    // Sides are fixed at the moment of selection, around the current leader (S1 if none).
    sim.setNetwork = mode => {
      const L = sim.top(servers) || servers[0];
      const cut = mode === "isolate" ? [L.id] : mode === "split" ? [L.id, (L.id + 1) % N] : [];
      sim.minority = mode === "healthy" && sim.net !== "healthy" ? new Set(servers.filter(s => s.side === "A").map(s => s.id)) : null;
      sim.net = mode;
      servers.forEach(s => (s.side = cut.includes(s.id) ? "A" : "B"));
      bump();
      return { leader: L, cut };
    };
    // One client per side: during a partition each side's leader (if any) gets its own write.
    sim.write = () => {
      const groups = sim.net === "healthy" ? [servers] : ["A", "B"].map(side => servers.filter(s => s.side === side));
      const res = groups.map(g => {
        const L = sim.top(g), r = { side: sim.net === "healthy" ? null : g.length < MAJORITY ? "minority" : "majority", leader: L };
        if (!L) return r;
        r.entry = { term: L.term, cmd: CMDS[sim.nextCmd++ % CMDS.length] };
        L.log.push(r.entry);
        L.match[L.id] = L.log.length;
        sendAppends(L);
        return r;
      });
      bump();
      return res;
    };
    return sim;
  }

  // ------------------------------------------------------------------ view
  const LOOK = { leader: ["c1", 3], follower: ["c2", 2], candidate: ["warn", 2] };
  const DOT = { RV: () => ["warn", 5], RVR: m => (m.payload.granted ? ["ok", 4] : ["muted", 4]),
    AE: m => ["c1", m.payload.fresh ? 6 : 4], AER: () => ["c2", 3] };
  const INTRO = "<b>S1</b> leads term 1 and has replicated <b>a</b> and <b>b</b> to all five servers (green = committed: the leader stored them on a majority during its own term). Try isolating the leader, or crashing it.";

  function layout(compact) {
    const G = compact
      ? { W: 360, H: 276, cx: 180, cy: 132, R: 96, r: 25, tr: 31, f: 12, fs: 11, roleDy: 41, hintY: 268 }
      : { W: 640, H: 320, cx: 165, cy: 156, R: 112, r: 30, tr: 37, f: 13, fs: 12, roleDy: 49, hintY: 313 };
    G.pos = Array.from({ length: N }, (_, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / N;
      return [G.cx + G.R * Math.cos(a), G.cy + G.R * Math.sin(a)];
    });
    const P = compact
      ? { W: 360, H: 198, title: "Logs: letter + term (green = committed)", fs: 11, x: 10, ty: 14, sx: 40, y0: 28, dy: 34, sq: 26, sub: true }
      : { title: "Logs: letter = command, number = term", fs: 12, x: 330, ty: 24, sx: 362, y0: 52, dy: 52, sq: 24, sub: false };
    return { G, P };
  }

  Viz.register("ch9/raft-consensus", {
    title: "Raft: terms, votes and majorities",
    mount(root, ctx) {
      const { ui } = ctx, el = ctx.s;
      let sim, V = null, compact = ctx.compact, paused = false, speed = 1;
      let history, noteState, flashes, steppedAt;

      const stamp = () => `<span style="opacity:.55">${(sim.now / 1000).toFixed(1)}s</span> `;
      function addLog(html, tone) {
        const row = [stamp() + html, tone];
        history.push(row);
        if (history.length > 60) history.shift();
        if (V) V.log.add(...row);
      }
      function setNote(html, tone) { noteState = [html, tone]; if (V) V.note.set(html, tone); }
      const up = () => sim.servers.filter(s => s.alive).length;

      function reset() {
        history = []; flashes = []; steppedAt = {}; noteState = [INTRO, "info"];
        sim = createCluster(ctx.random(5), onEvent);
        addLog("S1 leads term 1; a and b are committed on all five", "muted");
      }

      function onEvent(type, d) {
        const s = d.s && name(d.s.id), t = d.s && d.s.term;
        if (type === "election") {
          addLog(`${s} starts election for term ${t}`, "warn");
          if (up() < MAJORITY) setNote(`${s} timed out and asked for votes in term ${t}, but only ${up()} servers are up, so it can never collect 3 of 5 votes. No leader and no commits, but nothing unsafe happens either.`, "bad");
          else if (d.reach < MAJORITY) setNote(`${s} timed out and moved to term ${t}, but it can reach only ${d.reach} of 5 servers, so it can never collect the 3 votes it needs. It will keep timing out and bumping its term.`, "warn");
          else if (d.retry) setNote(`${s} got no majority in term ${t - 1} (a split vote, or voters refused it), so it tries again in term ${t} after a fresh random timeout. Randomized timeouts make repeated split votes unlikely.`, "warn");
          else setNote(`${s} heard nothing from a leader before its timer ran out, so it moved to term ${t} and asked for votes. It needs 3 of 5, and each server votes at most once per term.`, "warn");
        } else if (type === "elected") {
          addLog(`${s} elected leader of term ${t} (${d.votes} votes)`, "ok");
          setNote(`${s} won term ${t}. Two leaders in one term are impossible: any two majorities share a server, and that server votes only once.`, "ok");
        } else if (type === "refuse") {
          const c = name(d.cand.id);
          if (d.reason === "voted") return addLog(`${s} refused ${c}: already voted in term ${t}`, "muted");
          addLog(`${s} refused ${c}: its log is behind`, "info");
          setNote(`${s} refused to vote for ${c}: ${c}'s log is behind (its last entry has an older term, or its log is shorter). A server only votes for a candidate whose log is at least as up to date as its own, so whoever wins already holds every committed entry.`, "info");
        } else if (type === "stepdown") {
          steppedAt[d.s.id] = sim.now;
          addLog(`${s} sees term ${t} and steps down`, "warn");
          if (d.rejoiner) {
            const r = name(d.rejoiner.id);
            addLog(`${r} rejoined with a higher term and forced an election (real Raft adds PreVote to avoid this)`, "warn");
            setNote(`${r} kept timing out on the minority side and pushed its term up to ${t}. Back on the network, that higher term forced the healthy leader ${s} to step down: a needless election. Raft's PreVote extension avoids this by asking "would you vote for me?" before bumping the term.`, "warn");
          } else setNote(`${s} saw term ${t} and stepped down to follower: a higher term always wins.`, "info");
        } else if (type === "discard") {
          const lost = d.lost.map(x => x.entry), list = cmds(lost);
          d.lost.forEach(x => flashes.push({ id: d.s.id, index: x.index, entry: x.entry, until: sim.now + 1200 }));
          addLog(`${s} discarded uncommitted ${plural(lost.length, "entry", "entries")} ${list}`, "bad");
          const stepped = sim.now - (steppedAt[d.s.id] ?? -1e9) < 3000 ? `${s} saw a higher term and stepped down. ` : "";
          setNote(`${stepped}${stepped ? "Its" : `${s}'s`} uncommitted ${list} ${plural(lost.length, "was", "were")} overwritten by the new leader's log. Safe: ${plural(lost.length, "it was", "they were")} never committed, so no client was told it succeeded.`, "ok");
        } else if (type === "commit") {
          const old = d.entries.filter(e => e.term !== t), cur = d.entries.filter(e => e.term === t);
          addLog(`${plural(d.entries.length, "entry", "entries")} ${cmds(d.entries)} committed (${d.count}/5)`, "ok");
          if (old.length) setNote(`${cmds(old)} from term ${old[0].term} ${plural(old.length, "is", "are")} committed now, together with ${cmds(cur)} from term ${t}: once an entry from the leader's own term is on a majority, everything before it is safe too.`, "ok");
        } else if (type === "blocked") {
          const list = cmds(d.entries), n = d.entries.length;
          addLog(`${list} ${plural(n, "is", "are")} on a majority but from an earlier term: ${s} waits for a term-${t} entry`, "info");
          setNote(`${list} ${plural(n, "is", "are")} already stored on a majority, but ${plural(n, "it was", "they were")} written in an earlier term. ${s} (term ${t}) never commits an old-term entry by counting replicas; it commits automatically once a term-${t} entry reaches a majority. Press <b>Client write</b>.`, "info");
        } else if (type === "violation") {
          addLog(`SAFETY VIOLATED: ${d.msg}`, "bad");
        }
      }

      function onWrite() {
        const res = sim.write();
        res.forEach(r => {
          const where = r.side ? `${r.side} side: ` : "";
          if (r.entry) addLog(`${where}client writes ${r.entry.cmd} to ${name(r.leader.id)} (term ${r.entry.term})`, "info");
          else addLog(`${where}no leader, the client must retry`, "warn");
        });
        const minor = res.find(r => r.entry && r.side === "minority"), major = res.find(r => r.entry && r.side !== "minority");
        if (sim.servers.some(s => s.log.length >= MAX_LOG)) setNote("Logs full: press <b>Reset</b> to start again.", "warn");
        else if (minor) {
          const L = name(minor.leader.id), M = sim.top(sim.servers.filter(s => s.side !== minor.leader.side));
          setNote(`${L} still believes it leads term ${minor.leader.term}, but it can only reach a minority: entry ${minor.entry.cmd} stays uncommitted. ` +
            (M && M.term > minor.leader.term ? `The majority side elected ${name(M.id)} in term ${M.term} and keeps committing.` : "The majority side will elect a new leader in a higher term and keep committing."), "warn");
        } else if (!major) setNote("No leader right now (election in progress): the client has to retry.", "warn");
        else if (up() < MAJORITY) setNote(`${name(major.leader.id)} appended ${major.entry.cmd}, but only ${up()} servers are up, so it can never be stored on 3 of 5: it stays uncommitted until a crashed server comes back.`, "bad");
        else setNote(`${name(major.leader.id)} appended ${major.entry.cmd} (amber: not committed yet) and sent it to the followers. Once 3 of 5 servers store it, ${name(major.leader.id)} marks it committed; followers learn that from its next heartbeat.`, "info");
        render();
      }

      function onNet(mode) {
        const { leader, cut } = sim.setNetwork(mode);
        const A = cut.map(name), B = sim.servers.filter(s => !cut.includes(s.id)).map(s => name(s.id));
        const leads = leader.alive && leader.role === "leader";
        if (mode === "healthy") {
          addLog("network healed", "info");
          setNote("Network healed: every message gets through again. Watch what happens when the two sides' terms meet.", "info");
        } else {
          addLog(`network split: ${A.join(" ")} | ${B.join(" ")}`, "info");
          setNote(mode === "isolate"
            ? `${A[0]} is cut off: messages over the red links are dropped. ${leads ? `It still believes it leads term ${leader.term}, while` : "Meanwhile"} ${B.join(", ")} stop hearing heartbeats and their timers drain.`
            : `${A.join(" and ")} can only reach each other; ${B.join(", ")} form the majority side. ${leads ? `${A[0]} still leads its side, but it needs 3 servers to commit; ` : ""}the 3-server side can elect its own leader.`, "warn");
        }
        drawLinks(); render();
      }

      function toggle(i) {
        const s = sim.servers[i], wasLeader = s.alive && s.role === "leader";
        sim.toggle(i);
        if (s.alive) {
          addLog(`${name(i)} restarted as a follower (commit index 0)`, "muted");
          setNote(`${name(i)} restarted. Its term, vote and log survived on disk, but its commit index is volatile, so its entries look uncommitted until the leader's next heartbeat.`, "info");
        } else {
          addLog(`${name(i)} crashed (term, vote and log kept on disk)`, "bad");
          const n = up(), L = sim.top();
          if (n < MAJORITY) setNote(`Only ${n} ${plural(n, "server is", "servers are")} up: no majority, so no leader can be elected and nothing can commit${L ? ` (${name(L.id)} still thinks it leads, but its writes can never reach 3 servers)` : ""}. Raft stays safe but stops making progress.`, "bad");
          else if (wasLeader) setNote(`${name(i)} crashed. The followers stop hearing heartbeats; the first one whose timer runs out starts an election for term ${s.term + 1}.`, "warn");
          else setNote(`${name(i)} crashed. ${n} of 5 servers are still up, which is a majority, so the cluster keeps working.`, "info");
        }
        render();
      }

      // ---------------------------------------------------------------- drawing
      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const { G, P } = layout(compact);
        const write = ui.button("Client write", onWrite, { kind: "primary", title: "Send a client command to the leader" });
        const net = ui.segmented({ label: "Network", value: sim.net, onChange: onNet, options: [
          { value: "healthy", label: "Healthy" }, { value: "isolate", label: "Isolate leader" }, { value: "split", label: "Split 2 | 3" }] });
        const pause = ui.toggle({ label: "Pause", value: paused, onChange: v => (paused = v) });
        const spd = ui.slider({ label: "Speed", min: 0.25, max: 2, step: 0.25, value: speed, format: v => v + "×", onInput: v => (speed = v) });
        const rst = ui.button("Reset", () => { paused = false; reset(); build(); }, { kind: "ghost" });

        const svg = ctx.svg({ w: G.W, h: G.H, label: "Five Raft servers exchanging votes and log entries" });
        svg.setAttribute("role", "group"); // it holds focusable server buttons
        const links = el("g"), dots = el("g"), timers = el("g"), nodes = el("g");
        svg.append(links, dots, timers, nodes, ctx.text(G.cx, G.hintY, "Tap a server to crash or restart it", { size: G.fs, fill: "var(--viz-muted)" }));
        const pairs = [];
        for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
          const line = el("line", { x1: G.pos[i][0], y1: G.pos[i][1], x2: G.pos[j][0], y2: G.pos[j][1] });
          links.append(line); pairs.push({ i, j, line });
        }
        const rings = G.pos.map(([x, y]) => {
          const arc = el("circle", { cx: x, cy: y, r: G.tr, fill: "none", stroke: "var(--viz-muted)", "stroke-width": 3, opacity: 0.75, transform: `rotate(-90 ${x} ${y})` });
          const g = el("g", null, el("circle", { cx: x, cy: y, r: G.tr, fill: "none", stroke: "var(--viz-grid)", "stroke-width": 3 }), arc);
          timers.append(g);
          return { g, arc };
        });
        const nodeViews = G.pos.map(([x, y], i) => {
          const n = ctx.node({ x, y, r: G.r, label: name(i), size: G.f });
          ctx.attr(n.label, { y: y - G.r * 0.24 });
          const term = ctx.text(x, y + G.r * 0.34, "", { size: G.fs, fill: "var(--viz-muted)" });
          const role = ctx.text(x, y + G.roleDy, "", { size: G.fs, halo: true });
          const cross = ctx.text(x + G.r * 0.78, y - G.r * 0.78, "✕", { size: 14, weight: 800, fill: "var(--viz-bad)", halo: true });
          n.append(term);
          const g = el("g", { tabindex: 0, role: "button", style: "cursor:pointer" },
            el("circle", { cx: x, cy: y, r: G.tr + 2, fill: "transparent" }), n, role, cross);
          g.addEventListener("click", () => toggle(i));
          g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(i); } });
          nodes.append(g);
          return { g, circle: n.circle, term, role, cross };
        });

        const logSvg = compact ? ctx.svg({ w: P.W, h: P.H, label: "Each server's log" }) : svg;
        const logLayer = el("g");
        logSvg.append(ctx.text(P.x, P.ty, P.title, { size: P.fs, anchor: "start", weight: 600, fill: "var(--viz-muted)" }), logLayer);

        const stats = ui.stats([{ key: "term", label: "Term" }, { key: "leader", label: "Leader" },
          { key: "committed", label: "Committed" }, { key: "elections", label: "Elections" },
          { key: "safety", label: "Safety", value: "✗", tone: "bad" }]);
        const note = ui.note(...noteState);
        const log = ui.log({ title: "What happened", height: 110 });
        log.style.marginTop = "8px";
        history.forEach(row => log.add(...row));
        const legend = ui.legend([["c1", "leader / AppendEntries"], ["c2", "follower"], ["warn", "candidate / RequestVote / uncommitted"],
          ["ok", "vote granted / committed"], ["bad", "dropped by partition"]].map(([c, label]) => ({ color: `var(--viz-${c})`, label, shape: c === "bad" ? "dash" : "dot" })));
        const top = compact ? ui.bar(write, rst, net) : ui.bar(write, net, rst);
        // The simplifications (whole-log copy, no PreVote/CheckQuorum) are stated in the caption.
        const sim2 = ui.bar(pause, spd);
        sim2.style.marginTop = "10px";
        root.append(...[top, svg, compact ? logSvg : null, sim2, stats, note, legend, log].filter(Boolean));
        V = { G, P, pairs, rings, nodeViews, dots, dotEls: new Map(), logLayer, stats, note, log, write,
          C: 2 * Math.PI * G.tr, drawn: -1, cache: {} };
        drawLinks(); render();
      }

      function drawLinks() {
        V.pairs.forEach(({ i, j, line }) => {
          const cut = sim.servers[i].side !== sim.servers[j].side;
          ctx.attr(line, { stroke: cut ? "var(--viz-bad)" : "var(--viz-line)", "stroke-width": cut ? 1.6 : 1, "stroke-dasharray": cut ? "6 5" : "none", opacity: cut ? 0.85 : 0.45 });
        });
      }

      function roleText(s) {
        if (!s.alive) return ["crashed", "bad", 700];
        if (s.role === "leader") return ["leader", "c1", 700];
        if (s.role === "candidate") return [`candidate ${s.votes.size}/3`, "warn", 700];
        const c = s.votedFor !== null && s.votedFor !== s.id && sim.servers[s.votedFor];
        if (c && c.alive && c.role === "candidate" && c.term === s.term) return [`voted ${name(c.id)}`, "muted", 400];
        return ["follower", "muted", 400];
      }

      function renderServer(s, i) {
        const v = V.nodeViews[i], ring = V.rings[i], timed = s.alive && s.role !== "leader";
        ring.g.style.display = timed ? "" : "none";
        if (timed) ring.arc.setAttribute("stroke-dasharray", `${V.C * ctx.clamp((s.deadline - sim.now) / s.timeout, 0, 1)} ${V.C}`);
        const [txt, col, wt] = roleText(s), key = [s.alive, s.role, s.term, txt].join();
        if (v.key === key) return;
        v.key = key;
        const [c, w] = s.alive ? LOOK[s.role] : ["muted", 2];
        ctx.attr(v.circle, { fill: s.alive ? `var(--viz-${c}-soft)` : "var(--viz-node)", stroke: `var(--viz-${c})`, "stroke-width": w, "stroke-dasharray": s.alive ? "none" : "5 4" });
        v.term.textContent = "T" + s.term;
        v.cross.style.display = s.alive ? "none" : "";
        v.role.textContent = txt;
        ctx.attr(v.role, { fill: `var(--viz-${col})`, "font-weight": wt });
        v.g.setAttribute("aria-label", `${name(i)}: ${txt}, term ${s.term}. Press Enter to ${s.alive ? "crash" : "restart"} it.`);
      }

      function renderDots() {
        const live = new Set(sim.msgs);
        for (const [m, d] of V.dotEls) if (!live.has(m)) { d.remove(); V.dotEls.delete(m); }
        sim.msgs.forEach(m => {
          let d = V.dotEls.get(m);
          if (!d) {
            const [c, r] = DOT[m.type](m);
            d = el("g", { class: "viz-packet" }, el("circle", { r, fill: `var(--viz-${c})`, stroke: "var(--viz-bg)", "stroke-width": 1.5 }));
            V.dots.append(d); V.dotEls.set(m, d);
          }
          const span = m.arriveAt - m.sentAt, k = ctx.clamp((sim.now - m.sentAt) / span, 0, 1), at = m.dropped ? Math.min(k, 0.5) : k;
          const [x1, y1] = V.G.pos[m.from], [x2, y2] = V.G.pos[m.to];
          d.setAttribute("transform", `translate(${x1 + (x2 - x1) * at},${y1 + (y2 - y1) * at})`);
          if (!m.dropped || k < 0.5) return;
          if (!d.dead) {
            d.dead = true;
            ctx.attr(d.firstChild, { fill: "var(--viz-bad)" });
            d.append(ctx.text(0, -12, "✕", { size: 13, weight: 800, fill: "var(--viz-bad)", halo: true }));
          }
          d.setAttribute("opacity", Math.max(0, 1 - (sim.now - m.sentAt - span / 2) / 300));
        });
      }

      function square(x, y, e, tone) {
        const P = V.P, cx = x + P.sq / 2, g = el("g");
        g.append(el("rect", { x, y, width: P.sq, height: P.sq, rx: 4, fill: `var(--viz-${tone}-soft)`, stroke: `var(--viz-${tone})`,
          "stroke-width": 1.5, "stroke-dasharray": tone === "warn" ? "3 2" : null }));
        const termFill = tone === "bad" ? "var(--viz-bad)" : "var(--viz-muted)";
        if (P.sub) { // phone: the term rides along as a subscript
          const t = ctx.text(cx, y + P.sq / 2, e.cmd, { size: 12, weight: 700 });
          const sub = el("tspan", { "font-size": 11, dy: 3, fill: termFill });
          sub.textContent = e.term;
          t.append(sub); g.append(t);
        } else {
          g.append(ctx.text(cx, y + P.sq / 2, e.cmd, { size: 12, weight: 700 }), ctx.text(cx, y + 36, String(e.term), { size: 12, fill: termFill }));
        }
        if (tone === "bad") g.append(el("line", { x1: x + 3, y1: y + P.sq / 2, x2: x + P.sq - 3, y2: y + P.sq / 2, stroke: "var(--viz-bad)", "stroke-width": 2 }));
        return g;
      }

      function renderLogs() {
        const P = V.P;
        V.logLayer.innerHTML = "";
        sim.servers.forEach((s, i) => {
          const y = P.y0 + i * P.dy, row = el("g", { opacity: s.alive ? 1 : 0.45 }), gone = {};
          flashes.forEach(f => { if (f.id === i) gone[f.index] = f.entry; });
          const lead = s.alive && s.role === "leader";
          row.append(ctx.text(P.x, y + P.sq / 2, name(i), { size: 12, anchor: "start", weight: 700, fill: lead ? "var(--viz-c1)" : "var(--viz-ink)" }));
          for (let k = 0; k < MAX_LOG; k++) {
            const x = P.sx + k * (P.sq + 3), e = gone[k] || s.log[k];
            row.append(e ? square(x, y, e, gone[k] ? "bad" : k < s.commitIndex ? "ok" : "warn")
              : el("rect", { x, y, width: P.sq, height: P.sq, rx: 4, fill: "none", stroke: "var(--viz-grid)", "stroke-width": 1.2 }));
          }
          V.logLayer.append(row);
        });
      }

      function setStat(key, value, tone) {
        const k = value + "|" + tone;
        if (V.cache[key] !== k) { V.cache[key] = k; V.stats.set(key, value, tone); }
      }
      function renderStats() {
        const live = sim.servers.filter(s => s.alive), leaders = sim.leaders(), top = leaders[leaders.length - 1];
        setStat("term", live.length ? Math.max(...live.map(s => s.term)) : "–", "");
        const small = t => `<span style="font-size:12px;font-weight:600"> ${t}</span>`;
        const cutOff = top && live.filter(s => s.side === top.side).length < MAJORITY;
        setStat("leader", !top ? "none" : leaders.length > 1 ? leaders.map(l => name(l.id) + small("T" + l.term)).join(" + ")
          : name(top.id) + (cutOff ? small("no majority") : ""), top && leaders.length === 1 && !cutOff ? "ok" : "warn");
        setStat("committed", sim.committed(), "");
        setStat("elections", sim.elections, "");
        V.stats.lastChild.style.display = sim.violation ? "" : "none";
        const full = sim.servers.some(s => s.log.length >= MAX_LOG);
        V.write.disable(full).setLabel(full ? "Logs full" : "Client write");
      }

      function render() {
        if (!V) return;
        sim.servers.forEach(renderServer);
        renderDots();
        const before = flashes.length;
        flashes = flashes.filter(f => f.until > sim.now);
        if (V.drawn !== sim.version || before !== flashes.length) { V.drawn = sim.version; renderLogs(); renderStats(); }
      }

      reset();
      build();
      // rAF drives the clock; a slow interval keeps it (and the phone/desktop switch) going where rAF
      // and ResizeObserver are throttled, as in headless runs.
      let last = performance.now();
      const frame = () => {
        const now = performance.now(), dt = Math.min(100, now - last);
        last = now;
        if (!paused) sim.advance(dt * speed);
        render();
      };
      ctx.raf(frame);
      const relayout = () => { if (ctx.compact !== compact) build(); };
      ctx.every(100, () => { relayout(); if (performance.now() - last > 90) frame(); });
      ctx.onResize(() => ctx.after(0, relayout)); // deferred: rebuilding inside the observer warns
    },
  });

  // Lets a Node test drive the model directly; inert in the browser.
  if (typeof module === "object" && module.exports) module.exports = { createCluster };
})();
