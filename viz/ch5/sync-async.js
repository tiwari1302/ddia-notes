// Sync, semi-sync and async replication. The one real dial in single-leader replication is how
// many followers must confirm a write before the client hears "OK". Waiting buys durability with
// latency (and availability when a follower dies); not waiting is fast, but an acknowledged write
// can vanish when the leader dies before any follower has it.
Viz.register("ch5/sync-async", {
  title: "Sync, semi-sync and async replication",
  mount(root, ctx) {
    const { s, ui } = ctx;
    // Simulated round trip (what the stats report) and animation durations, per link speed.
    // FAST.out is slow-motion on purpose: it leaves the reader time to crash the leader after the
    // OK but before the followers have the write (the caption asks for exactly that).
    const FAST = { rtt: 4, out: 1000, back: 350 };
    const SLOW = { rtt: 300, out: 2200, back: 1400 };
    const SQ = 18, GAP = 3, SLOTS = 6, DB = ["L", "F1", "F2"];
    const V = n => `var(--viz-${n})`;
    const STYLE = { // log square: fill, stroke, number colour, by write status
      acked: [V("ok-soft"), V("ok"), V("ink")],
      pending: [V("warn-soft"), V("warn"), V("ink")],
      lost: [V("bad"), V("bad"), V("bg")],
      dropped: [V("grid"), V("muted"), V("muted")],
    };
    // pos: [x, y, r]; strip: [x, y, align] of each log; cap: role/status caption; rtt: [x, y, anchor, angle]
    // label per leader-follower edge; curve: control point for the client's edge to a promoted follower.
    const GEO = {
      desk: {
        W: 640, H: 238, font: 12,
        pos: { C: [60, 115, 22], L: [250, 115, 28], F1: [470, 48, 24], F2: [470, 182, 24] },
        strip: { L: [250, 153, "center"], F1: [504, 39, "left"], F2: [504, 173, "left"] },
        cap: { L: [250, 75], F1: [470, 87], F2: [470, 221] },
        okAt: [60, 170],
        rtt: { "F1-L": [381, 65, "middle", -16.9], "F2-L": [381, 165, "middle", 16.9], "F1-F2": [458, 115, "end", 0] },
        curve: { "C-F1": [265, 0], "C-F2": [265, 255] },
      },
      phone: {
        W: 360, H: 284, font: 11,
        pos: { C: [45, 60, 20], L: [190, 60, 24], F1: [95, 205, 22], F2: [275, 205, 22] },
        strip: { L: [222, 51, "left"], F1: [95, 239, "center"], F2: [275, 239, "center"] },
        cap: { L: [190, 26], F1: [95, 271], F2: [275, 271] },
        okAt: [45, 108],
        rtt: { "F1-L": [134, 132, "end", 0], "F2-L": [241, 132, "start", 0], "F1-F2": [185, 221, "middle", 0] },
        curve: { "C-F1": [110, 110] },
      },
    };
    const INTRO = "Async mode: the leader said OK to write <b>#4</b> the moment it had it, and F2's slow link means F2 " +
      "gets it seconds later. Press <b>Write</b> a few times, then <b>Crash leader</b> before the followers catch up.";

    let S = null, view = null, compact = ctx.compact, stopAuto = null;
    const live = st => ctx.alive && st === S;
    const list = ids => (ids.length > 1 ? "writes " : "write ") + ids.map(i => "#" + i).join(", ").replace(/, (?=[^,]*$)/, " and ");
    const cap = str => str[0].toUpperCase() + str.slice(1);

    // ---------------- model ----------------
    function fresh() {
      // inc (incarnation) is bumped on every crash, so packets sent to or from an earlier life are void.
      const mk = log => ({ alive: true, log, inc: 0, chain: Promise.resolve(), recovering: false, catchup: false });
      const st = {
        mode: "async", slow: true, phase: "normal", policy: null, leaderId: "L", oldLeader: null, nextId: 5,
        nodes: { L: mk([1, 2, 3, 4]), F1: mk([1, 2, 3, 4]), F2: mk([1, 2, 3]) },
        writes: [], byId: {}, lastOK: { html: "1 ms", tone: "ok" }, clientOK: 4, note: [INTRO, "info"],
        logLines: [["#1–#4 acknowledged in async mode; #4 still on its way to F2", "muted"]],
      };
      for (let id = 1; id <= 4; id++) addWrite(st, id, "acked");
      return st;
    }
    function addWrite(st, id, status) {
      const w = (st.byId[id] = { id, status, mode: st.mode, need: new Set(), acks: new Set(), rtt: {}, after: null, failed: null });
      st.writes.push(w);
      return w;
    }
    const followers = () => DB.filter(id => id !== S.leaderId && id !== S.oldLeader);
    const up = id => S.nodes[id].alive;
    const isSlow = (a, b) => S.slow && a !== "C" && b !== "C" && (a === "F2" || b === "F2");
    const speed = (a, b) => (isSlow(a, b) ? SLOW : FAST);
    const canWrite = () => up(S.leaderId) && (S.phase === "normal" || S.phase === "failedOver");
    const pending = () => S.writes.filter(w => w.status === "pending");
    const needs = (w, f) => w.need && w.need.has(f) && !w.acks.has(f);
    const blocked = w => w.need === null || [...w.need].some(f => !w.acks.has(f) && !up(f));
    const stuck = w => blocked(w) || /revived/.test(w.after); // still counts as blocked until the revived follower confirms
    const isSync = f => S.mode === "sync" || (S.mode === "semi" && followers().find(up) === f);
    const atRisk = () => S.writes.filter(w => w.status === "acked" && S.nodes[S.leaderId].log.includes(w.id) &&
      !followers().some(f => S.nodes[f].log.includes(w.id)));
    // Followers whose ack a new write must collect. null = semi-sync with nobody alive: wait for whoever returns.
    function syncSet(mode) {
      const fs = followers(), first = fs.find(up);
      return mode === "async" ? new Set() : mode === "sync" ? new Set(fs) : first ? new Set([first]) : null;
    }

    // A packet along edge a -> b. Resolves true if delivered. If the sender crashes mid-flight the
    // packet dies on the spot; if the receiver crashed, it is dropped on arrival (red flash).
    // `always` packets (an OK already sent to the client) cannot be recalled.
    function send(a, b, o) {
      const st = S, na = st.nodes[a], nb = st.nodes[b];
      const incA = na ? na.inc : 0, incB = nb ? nb.inc : 0;
      const stop = nb && !nb.alive ? 0.6 : 1;
      const [p0, c, p2] = path(a, b), r = o.r || 7;
      const dot = s("circle", { r, fill: o.fill, stroke: V("bg"), "stroke-width": 1.5 });
      const label = ctx.text(0, -r - 8, o.label, { size: view.geo.font, weight: 600, halo: true });
      const g = s("g", { class: "viz-packet" }, dot, label);
      view.packets.append(g);
      let dead = null;
      const kill = () => {
        ctx.attr(dot, { fill: V("bad") });
        label.textContent = "✕";
        return (dead = ctx.tween({ ms: 300, onUpdate: k => g.setAttribute("opacity", 1 - k) }).then(() => g.remove()));
      };
      const place = k => {
        if (dead) return;
        if (na && na.inc !== incA && !o.always) return kill();
        const q = 1 - k, x = q * q * p0[0] + 2 * k * q * c[0] + k * k * p2[0], y = q * q * p0[1] + 2 * k * q * c[1] + k * k * p2[1];
        g.setAttribute("transform", `translate(${x},${y})`);
      };
      place(0);
      return ctx.tween({ ms: o.ms * stop, onUpdate: k => place(k * stop) }).then(async () => {
        if (dead) return false;
        const ok = stop === 1 && (o.always || ((!na || na.inc === incA) && (!nb || (nb.alive && nb.inc === incB))));
        if (!ok) await kill();
        g.remove();
        return ok;
      });
    }
    function path(a, b) {
      const P = view.geo.pos, p0 = P[a], p2 = P[b];
      return [p0, view.geo.curve[[a, b].sort().join("-")] || [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2], p2];
    }

    async function write() {
      if (!canWrite()) return;
      const st = S, to = st.leaderId, w = addWrite(st, st.nextId++, "sending");
      const ok = await send("C", to, { label: "#" + w.id, fill: V("c6"), ms: 450 });
      if (!live(st)) return;
      if (!ok) { w.status = "dropped"; return refresh(); }
      st.nodes[to].log.push(w.id);
      Object.assign(w, { status: "pending", mode: st.mode, need: syncSet(st.mode) });
      followers().forEach(f => { if (up(f) && !st.nodes[f].recovering) replicate(f, [w.id]); });
      if (w.need && !w.need.size) acknowledge(w, null);
      else if (blocked(w)) blockedNote(w);
      refresh();
    }

    function replicate(f, ids, label, onApplied) {
      const st = S, n = st.nodes[f], sp = speed(st.leaderId, f);
      ids.forEach(id => { st.byId[id].rtt[f] = sp.rtt; });
      const flight = send(st.leaderId, f, { label: label || "#" + ids[0], fill: V("c1"), ms: sp.out });
      // Flights overlap (it is a stream), but each follower applies entries strictly in log order.
      n.chain = n.chain.then(() => flight).then(ok => {
        if (!ok || !live(st)) return;
        ids.forEach(id => { if (!n.log.includes(id)) n.log.push(id); });
        if (pending().some(w => needs(w, f) && n.log.includes(w.id))) sendAck(f);
        if (onApplied) onApplied();
        refresh();
      });
    }
    async function sendAck(f) {
      const st = S, have = new Set(st.nodes[f].log);
      const ok = await send(f, st.leaderId, { label: "ack", fill: V("ok"), r: 5, ms: speed(f, st.leaderId).back });
      if (ok && live(st)) confirm(f, have);
    }
    function confirm(f, have) {
      pending().forEach(w => {
        if (!needs(w, f) || !have.has(w.id)) return;
        w.acks.add(f);
        if ([...w.need].every(x => w.acks.has(x))) acknowledge(w, f);
      });
      refresh();
    }
    function acknowledge(w, via) {
      const st = S;
      w.status = "acked";
      const lat = latency(w, via);
      st.lastOK = lat;
      log(`#${w.id} OK${w.after ? "," : " after"} ${lat.text}`, lat.tone);
      ackNote(w, via, lat);
      send(st.leaderId, "C", { label: "OK #" + w.id, fill: V("ok"), ms: 400, always: true }).then(() => {
        if (live(st)) { st.clientOK = Math.max(st.clientOK, w.id); refresh(); }
      });
    }
    function latency(w, via) {
      if (w.after) {
        const ms = speed(S.leaderId, via).rtt;
        return { ms, html: `${ms} ms<span style="display:block;font-size:12px;font-weight:600">${w.after}</span>`, text: `${ms} ms ${w.after}`, tone: "warn" };
      }
      const ms = 1 + Math.max(0, ...[...w.need].map(f => w.rtt[f] || speed(S.leaderId, f).rtt));
      return { ms, html: ms + " ms", text: ms + " ms", tone: ms > 50 ? "warn" : "ok" };
    }

    function crashFollower(f) {
      const st = S, n = st.nodes[f], wasSync = isSync(f);
      Object.assign(n, { alive: false, recovering: false, catchup: false, chain: Promise.resolve(), inc: n.inc + 1 });
      log(`${f} crashed`, "bad");
      if (st.phase !== "down") {
        // Semi-sync: pending writes that were waiting for f move to the next live follower.
        const next = followers().find(up);
        const moved = pending().filter(w => w.mode === "semi" && needs(w, f));
        moved.forEach(w => Object.assign(w, { need: next ? new Set([next]) : null, after: next ? `after ${f} failed` : null, failed: f }));
        if (next && !st.nodes[next].recovering && moved.some(w => st.nodes[next].log.includes(w.id))) sendAck(next);
        crashNote(f, wasSync, next);
      }
      refresh();
    }
    function reviveFollower(f) {
      const st = S;
      st.nodes[f].alive = true;
      log(`${f} revived`, "info");
      if (st.phase === "down") { refresh(); return elect(); }
      pending().forEach(w => {
        if (w.need === null) w.need = new Set([f]);
        else if (!needs(w, f)) return;
        w.after = `after ${f} revived`;
      });
      say(`<b>${f}</b> is back. It asks the leader for every entry after its last one and applies them in one batch.`, "info");
      catchUp(f);
    }
    // Catch-up recovery: "from #k" request; the leader replies with everything the follower lacks.
    async function catchUp(f) {
      const st = S, n = st.nodes[f], lead = st.leaderId, L = st.nodes[lead];
      n.recovering = n.catchup = true; // recovering: not streamed to yet; catchup: shown as "catching up…"
      refresh();
      const have = new Set(n.log);
      const from = L.log[n.log.length] || (n.log[n.log.length - 1] || 0) + 1;
      const ok = await send(f, lead, { label: "from #" + from, fill: V("c2"), r: 5, ms: speed(f, lead).back });
      if (!ok || !live(st)) return;
      n.recovering = false;
      let same = 0;
      while (same < n.log.length && n.log[same] === L.log[same]) same++;
      const extra = n.log.splice(same); // only after an async failover: entries the new leader never got
      if (extra.length) log(`${f} discarded ${list(extra)}`, "bad");
      const threw = extra.length ? ` First it threw away ${list(extra)}, which the new leader never had.` : "";
      const missing = L.log.slice(n.log.length);
      if (missing.length) {
        const range = "#" + missing[0] + (missing.length > 1 ? "–#" + missing[missing.length - 1] : "");
        replicate(f, missing, range, () => {
          n.catchup = false;
          log(`${f} caught up from #${missing[0]}`, "info");
          say(`<b>${f}</b> caught up from #${missing[0]}: one request for everything after its last entry, one batch (${range}) back.` + threw,
            extra.length ? "warn" : "info");
        });
      } else {
        n.catchup = false;
        log(`${f} is in sync with the leader`, "info");
        say(`<b>${f}</b> is back` + (extra.length ? `.${threw} Now its log matches the leader's.` : " and already has every entry the leader has, so there is nothing to copy."),
          extra.length ? "warn" : "info");
      }
      confirm(f, have);
    }

    async function crashLeader() {
      const st = S, lead = st.nodes[st.leaderId];
      Object.assign(lead, { alive: false, inc: lead.inc + 1 });
      Object.assign(st, { phase: "electing", policy: st.mode });
      setAuto(false);
      const risky = atRisk().map(w => w.id);
      log(`Leader ${st.leaderId} crashed`, "bad");
      say("The leader crashed, and the replication packets it had not delivered died with it. Followers only notice when heartbeats stop, " +
        "so they wait out a timeout before promoting one of them." +
        (risky.length ? ` Acknowledged ${list(risky)} ${risky.length > 1 ? "exist" : "exists"} only on the dead leader.` : ""), "warn");
      refresh();
      const cands = followers().filter(up);
      if (cands.length) await timeoutArcs(cands);
      if (live(st)) elect();
    }
    function timeoutArcs(ids) {
      const arcs = ids.map(id => {
        const [x, y, r] = view.geo.pos[id], len = 2 * Math.PI * (r + 7);
        const el = s("circle", { cx: x, cy: y, r: r + 7, fill: "none", stroke: V("warn"), "stroke-width": 3, "stroke-linecap": "round",
          "stroke-dasharray": len, "stroke-dashoffset": len, transform: `rotate(-90 ${x} ${y})` });
        view.fx.append(el);
        return { el, len };
      });
      return ctx.tween({ ms: 1200, ease: "linear", onUpdate: k => arcs.forEach(a => a.el.setAttribute("stroke-dashoffset", a.len * (1 - k))) })
        .then(() => arcs.forEach(a => a.el.remove()));
    }
    // Promote the live follower with the longest log. In semi/sync mode the cluster refuses to promote
    // a follower that lacks an acknowledged write while a (dead) follower that has it could come back.
    function elect() {
      const st = S, fs = followers(), alive = fs.filter(up);
      if (!alive.length) {
        st.phase = "down";
        say("No follower to promote: the database is down until a node comes back.", "bad");
        return refresh();
      }
      const best = alive.reduce((a, b) => (st.nodes[b].log.length > st.nodes[a].log.length ? b : a));
      const target = Math.max(0, ...st.writes.filter(w => w.status === "acked").map(w => w.id));
      const holder = fs.find(f => !up(f) && st.nodes[f].log.includes(target));
      if (st.policy !== "async" && holder && !st.nodes[best].log.includes(target)) {
        st.phase = "down";
        say(`<b>${holder}</b> is down, and it is the only follower with every acknowledged write (up to #${target}). ` +
          `Promoting <b>${best}</b> would lose writes the client was told were safe, so the database stays down until ` +
          `${holder} is back: durability bought with availability. Revive ${holder}.`, "warn");
        return refresh();
      }
      promote(best);
    }
    function promote(nl) {
      const st = S, newLog = st.nodes[nl].log, lost = [], dropped = [];
      Object.assign(st, { oldLeader: st.leaderId, leaderId: nl, phase: "failedOver" });
      st.writes.forEach(w => {
        if (w.status === "acked" && !newLog.includes(w.id)) { w.status = "lost"; lost.push(w.id); }
        else if (w.status === "pending" || w.status === "sending") {
          if (w.status === "pending") dropped.push(w.id);
          w.status = "dropped";
        }
      });
      log(`${nl} promoted to leader`, "ok");
      if (lost.length) log(`${cap(list(lost))} lost`, "bad");
      failoverNote(nl, lost, dropped);
      followers().forEach(f => {
        const n = st.nodes[f];
        Object.assign(n, { chain: Promise.resolve(), recovering: false, catchup: false });
        if (n.alive && n.log.join() !== newLog.join()) catchUp(f);
      });
      refresh();
    }

    // ---------------- explanations ----------------
    function say(html, tone) { S.note = [html, tone]; if (view) view.note.set(html, tone); }
    function log(html, tone) {
      S.logLines.push([html, tone]);
      if (S.logLines.length > 40) S.logLines.shift();
      if (view) view.log.add(html, tone);
    }
    const redesignText = (f, next) => `<b>${f}</b> is down, so the leader made <b>${next}</b> its synchronous follower. ` +
      `Writes still land on two machines${isSlow(S.leaderId, next) ? `, but now they pay ${next}'s 300 ms link` : ""}.`;
    const noSyncText = () => (followers().length > 1 ? "Both followers are down" : "The only follower is down") +
      ", so there is no synchronous follower to wait for and writes block.";
    function ackNote(w, via, lat) {
      const n = `Write <b>#${w.id}</b>`, fs = followers();
      if (w.mode === "async") return say(`${n}: OK after 1 ms. Right now only the leader has it; if the leader dies before ` +
        "the packets land, the client was told success for a write that no longer exists.", "warn");
      if (w.failed) return say(`${n}: OK, ${lat.text}. ` + redesignText(w.failed, via), "warn");
      if (w.after) return say(`${n}: OK, ${lat.text}. It was stuck the whole time ${via} was down.`, "warn");
      if (w.mode === "semi") {
        if (fs[0] !== via && !up(fs[0])) return say(`${n}: OK after ${lat.ms} ms. ` + redesignText(fs[0], via), "warn");
        const other = fs.find(f => f !== via);
        return say(`${n}: OK after ${lat.ms} ms. The leader waited for ${via}, its one synchronous follower, so two machines ` +
          `have it${other ? `; ${other} catches up in the background` : ""}.`, "ok");
      }
      if (lat.ms > 50) return say(`${n} took ${lat.ms} ms: in fully synchronous mode every write waits for the slowest follower.`, "warn");
      say(`${n}: OK after ${lat.ms} ms. Every follower confirmed it before the client heard OK, so no single crash can lose it. ` +
        "Now try <b>Slow F2 link</b> or <b>Crash F2</b>.", "ok");
    }
    function blockedNote(w) {
      if (w.need === null) return say(noSyncText(), "bad");
      const dead = [...w.need].filter(f => !up(f)), many = dead.length > 1;
      say(`Write <b>#${w.id}</b> is stuck. Fully synchronous replication needs every follower, and ${dead.join(" and ")} ` +
        `${many ? "are" : "is"} down: ${many ? "dead nodes have" : "one dead node has"} stopped all writes.`, "bad");
    }
    function crashNote(f, wasSync, next) {
      const w = pending().find(blocked);
      if (w) return blockedNote(w);
      if (S.mode === "async") return say(`<b>${f}</b> is down. Async mode never waits for it, so writes keep flowing, ` +
        `but ${f} falls further behind. Revive it to watch it catch up.`, "info");
      if (S.mode === "sync") return say(`<b>${f}</b> is down. Fully synchronous replication needs every follower, so the next ` +
        `write will block until ${f} is back. Press <b>Write</b>.`, "warn");
      if (!next) return say(noSyncText(), "bad");
      if (wasSync) return say(redesignText(f, next), "warn");
      say(`<b>${f}</b> was only an async follower: the leader still waits for ${next} alone, so writes carry on.`, "info");
    }
    function failoverNote(nl, lost, dropped) {
      const many = lost.length > 1;
      const tail = dropped.length ? ` ${cap(list(dropped))} never got ${dropped.length > 1 ? "their" : "its"} OK (grey), so the client would retry.` : "";
      const also = followers().filter(f => lost.some(id => S.nodes[f].log.includes(id)));
      if (lost.length) return say(`<b>${nl}</b> was promoted, but ${list(lost)} ` +
        (also.length ? `never reached it: only the old leader and ${also.join(", ")} (down) had ${many ? "them" : "it"}.` : "had only reached the old leader.") +
        ` The client was told ${many ? "they" : "it"} succeeded. ${many ? "They are" : "It is"} gone.` + tail, "bad");
      if (S.policy === "async") return say(`<b>${nl}</b> was promoted and happened to have every acknowledged write. Async got ` +
        "lucky: press Reset, Write twice, and crash the leader immediately." + tail, "warn");
      say(`<b>${nl}</b> was promoted. Every acknowledged write was on a follower before the client heard OK, so nothing was ` +
        "lost. That is what the extra milliseconds bought." + tail, "ok");
    }
    // ---------------- controls ----------------
    function setMode(m) {
      const fs = followers();
      S.mode = m;
      log(`Mode: ${{ async: "Async", semi: "Semi-sync", sync: "Sync" }[m]}`, "muted");
      say({
        async: "Async: the leader says OK the moment it has the write and streams it to followers afterwards. Fastest, but for a moment the only copy is on the leader.",
        semi: `Semi-sync: the leader waits for one synchronous follower (${fs.length > 1 ? `${fs[0]}, or ${fs[1]} if ${fs[0]} is down` : `its only follower, ${fs[0]}`}), ` +
          "so every OK means two machines have the write.",
        sync: "Fully synchronous: the leader waits for every follower. Nothing acknowledged can be lost, but the slowest follower sets the pace, and a dead one stops all writes.",
      }[m], "info");
      refresh();
    }
    function setSlow(on) {
      S.slow = on;
      log(on ? "F2 link slow (300 ms)" : "F2 link fast (4 ms)", "muted");
      say(on ? "F2's link is slow now: a 300 ms round trip." + (S.leaderId === "F2" ? "" : isSync("F2")
        ? " The leader waits for F2, so every write now pays it." : " The leader isn't waiting for F2, so writes stay fast while F2 lags.")
        : "F2's link is fast again: a 4 ms round trip, like F1's.", "info");
      refresh();
    }
    function setAuto(on) {
      if (stopAuto) { stopAuto(); stopAuto = null; }
      if (view) view.auto.set(on);
      if (!on) return;
      write();
      stopAuto = ctx.every(1500, write);
    }
    function reset() {
      setAuto(false);
      S = fresh();
      if (view) {
        view.packets.innerHTML = view.fx.innerHTML = "";
        view.log.clear();
        S.logLines.forEach(([h, tone]) => view.log.add(h, tone));
        view.mode.set("async");
        view.slow.set(true);
        view.note.set(...S.note);
      }
      // Start the lagging #4 only once the frame is on screen, so the reader actually sees it.
      const st = S, stop = ctx.every(100, () => {
        stop();
        ctx.after(300, () => { if (live(st) && canWrite() && up("F2") && !st.nodes.F2.recovering) replicate("F2", [4]); });
      });
      refresh();
    }

    // ---------------- drawing ----------------
    function build() {
      compact = ctx.compact;
      const geo = GEO[compact ? "phone" : "desk"];
      root.innerHTML = "";
      const svg = ctx.svg({ w: geo.W, h: geo.H, label: "A client writing to a leader that replicates to two followers" });
      const scene = s("g"), packets = s("g"), fx = s("g");
      svg.append(scene, packets, fx);
      const mode = ui.segmented({ label: "Mode", value: S.mode, onChange: setMode,
        options: [{ value: "async", label: "Async" }, { value: "semi", label: "Semi-sync" }, { value: "sync", label: "Sync" }] });
      const writeBtn = ui.button("Write", () => write(), { kind: "primary", title: "Send one write to the leader" });
      const auto = ui.toggle({ label: "Auto-write", value: !!stopAuto, onChange: setAuto });
      const slow = ui.toggle({ label: "Slow F2 link", value: S.slow, onChange: setSlow });
      const crash = {};
      ["F1", "F2"].forEach(f => { crash[f] = ui.button("Crash " + f, () => (up(f) ? crashFollower(f) : reviveFollower(f))); });
      const crashL = ui.button("Crash leader", crashLeader, { kind: "danger", title: "Kill the leader and fail over to a follower" });
      const stats = ui.stats([
        { key: "last", label: "Last OK took" },
        { key: "risk", label: "Acked, only on leader" },
        { key: "wait", label: "Waiting for followers" },
        { key: "lost", label: "Lost in failover" },
      ]);
      const legend = ui.legend([
        { color: V("c6"), label: "client" },
        { color: V("c1"), label: "leader" },
        { color: V("c2"), label: "follower" },
        { color: V("ok"), label: "acknowledged", shape: "square" },
        { color: V("warn"), label: "not yet acknowledged", shape: "square" },
        { color: V("bad"), label: "lost in failover", shape: "square" },
        { color: V("warn"), label: "at risk (acked, only on leader)", shape: "dash" },
        { color: V("muted"), label: "not on this node", shape: "square" },
      ]);
      Object.assign(legend.lastChild.firstChild.style, { background: "none", border: `1.5px dashed ${V("muted")}`, boxSizing: "border-box" });
      const note = ui.note(...S.note);
      note.setAttribute("aria-live", "polite");
      const logEl = ui.log({ title: "What happened", height: 96 });
      S.logLines.forEach(([h, t]) => logEl.add(h, t));
      root.append(ui.bar(mode, writeBtn, auto), ui.bar(slow, crash.F1, crash.F2, crashL, ui.button("Reset", reset, { kind: "ghost" })),
        svg, legend, stats, note, logEl);
      view = { geo, scene, packets, fx, mode, writeBtn, auto, slow, crash, crashL, stats, note, log: logEl };
      refresh();
    }

    function refresh() {
      if (!view) return;
      drawScene();
      const pend = pending(), isStuck = up(S.leaderId) && pend.some(stuck);
      const risk = atRisk().length, lost = S.writes.filter(w => w.status === "lost").length;
      view.stats.set("last", isStuck ? "blocked" : S.lastOK.html, isStuck ? "bad" : S.lastOK.tone);
      view.stats.set("risk", risk, risk ? "warn" : "ok");
      view.stats.set("wait", pend.length, isStuck ? "bad" : "");
      view.stats.set("lost", lost, lost ? "bad" : "ok");
      const can = canWrite();
      view.writeBtn.disable(!can);
      view.auto.querySelector("input").disabled = !can;
      view.auto.style.opacity = can ? "" : "0.45";
      ["F1", "F2"].forEach(f => {
        const b = view.crash[f];
        b.setLabel((up(f) ? "Crash " : "Revive ") + f).disable(S.phase === "electing" || f === S.leaderId);
        b.classList.toggle("viz-btn--ok", !up(f));
      });
      view.crashL.disable(S.phase !== "normal");
    }

    function drawScene() {
      const { geo, scene } = view, lead = S.leaderId, leadUp = up(lead);
      scene.innerHTML = "";
      const edge = (a, b, dashed) => {
        const [p0, c, p2] = path(a, b);
        scene.append(s("path", { d: `M${p0[0]},${p0[1]} Q${c[0]},${c[1]} ${p2[0]},${p2[1]}`, fill: "none", stroke: V("line"), "stroke-width": 1.5, "stroke-dasharray": dashed ? "5 5" : null }));
      };
      edge("C", lead, !leadUp);
      followers().forEach(f => {
        edge(lead, f, !leadUp || !up(f));
        const [x, y, anchor, angle] = geo.rtt[[lead, f].sort().join("-")], slow = isSlow(lead, f);
        scene.append(ctx.attr(ctx.text(x, y, `RTT ${speed(lead, f).rtt} ms`, { size: geo.font, mono: true, anchor, halo: true,
          fill: slow ? V("warn") : V("muted"), weight: slow ? 700 : null }), { transform: angle ? `rotate(${angle} ${x} ${y})` : null }));
      });
      ["C", ...DB].forEach(drawNode);
      const ids = [...new Set([].concat(...DB.map(id => S.nodes[id].log)))].sort((a, b) => a - b).slice(-SLOTS);
      DB.forEach(id => { drawStrip(id, ids); drawCaption(id); });
      const [cx, cy, cr] = geo.pos.C;
      scene.append(ctx.text(cx, cy + cr + 14, "client", { size: geo.font, fill: V("muted") }),
        ctx.text(geo.okAt[0], geo.okAt[1], `got OK #${S.clientOK}`, { size: geo.font, weight: 600, fill: V("ok") }));
    }

    function drawNode(id) {
      const [x, y, r] = view.geo.pos[id], n = S.nodes[id], dead = n && !n.alive;
      const role = id === "C" ? "c6" : id === S.leaderId ? "c1" : "c2";
      const g = ctx.node({ x, y, r, label: id, ink: dead ? V("muted") : undefined,
        fill: dead ? V("node") : V(role + "-soft"), stroke: dead ? V("bad") : V(role) });
      view.scene.append(g);
      if (!dead) return;
      const d = r * 0.62;
      [1, -1].forEach(k => view.scene.append(s("line", { x1: x - d, y1: y - d * k, x2: x + d, y2: y + d * k,
        stroke: V("bad"), "stroke-width": 3, "stroke-linecap": "round" })));
      g.label.classList.add("viz-halo");
      view.scene.append(g.label); // keep the name readable on top of the cross
    }

    // The last SLOTS write ids across all logs, aligned, so a gap shows exactly what a node lacks.
    function drawStrip(id, ids) {
      const n = S.nodes[id], [ax, y, align] = view.geo.strip[id], scene = view.scene;
      const width = ids.length * (SQ + GAP) - GAP, x0 = align === "center" ? ax - width / 2 : ax;
      const X = i => x0 + i * (SQ + GAP);
      const risky = id === S.leaderId ? atRisk().map(w => w.id) : [];
      let run = null;
      const ring = () => scene.append(s("rect", { x: X(run[0]) - 3, y: y - 3, width: X(run[1]) - X(run[0]) + SQ + 6, height: SQ + 6, rx: 6,
        fill: "none", stroke: V("warn"), "stroke-width": 1.6, "stroke-dasharray": "4 3" }));
      ids.forEach((wid, i) => {
        if (risky.includes(wid)) run = run ? [run[0], i] : [i, i];
        else if (run) { ring(); run = null; }
        if (!n.log.includes(wid)) {
          scene.append(s("rect", { x: X(i) + 1, y: y + 1, width: SQ - 2, height: SQ - 2, rx: 3, fill: "none", stroke: V("line"), "stroke-dasharray": "3 2" }));
          return;
        }
        const [fill, stroke, ink] = STYLE[S.byId[wid].status];
        scene.append(s("rect", { x: X(i), y, width: SQ, height: SQ, rx: 4, fill: V("bg") }),
          s("rect", { x: X(i), y, width: SQ, height: SQ, rx: 4, fill, stroke, "stroke-width": 1.3 }));
        const t = ctx.text(X(i) + SQ / 2, y + SQ / 2 + 1, String(wid), { size: view.geo.font, mono: true, weight: 600, fill: ink });
        if (wid > 99) ctx.attr(t, { textLength: SQ - 3, lengthAdjust: "spacingAndGlyphs" });
        scene.append(t);
      });
      if (run) ring();
    }

    function drawCaption(id) {
      const n = S.nodes[id], [x, y] = view.geo.cap[id], parts = [];
      const isLead = id === S.leaderId || id === S.oldLeader;
      if (isLead && !n.alive) parts.push([id === S.oldLeader ? "old leader (down)" : "leader down", V("bad"), 700]);
      else if (isLead) {
        const set = syncSet(S.mode), waits = set === null ? "any follower" : set.size ? [...set].join(" + ") : "nobody";
        parts.push([S.oldLeader ? "new leader" : "leader", V("c1"), 700], [" · waits for " + waits, V("muted")]);
      }
      else if (!n.alive) parts.push(["DOWN", V("bad"), 700]);
      else if (S.phase === "electing") parts.push(["no heartbeat…", V("warn"), 600]);
      else if (S.phase === "down") parts.push(["no leader", V("muted")]);
      else if (n.catchup) parts.push(["catching up…", V("info"), 600]);
      else parts.push(isSync(id) ? ["synchronous", V("c1"), 700] : ["async", V("muted")]);
      if (!isLead && up(S.leaderId) && isSlow(S.leaderId, id)) parts.push([" · slow link", V("warn"), 600]);
      const t = ctx.text(x, y, "", { size: view.geo.font, halo: true });
      parts.forEach(([str, fill, weight]) => t.append(s("tspan", { fill, "font-weight": weight || null }, str)));
      view.scene.append(t);
      // Keep long captions ("new leader · waits for any follower") inside the viewBox on phones.
      const w = t.getComputedTextLength ? t.getComputedTextLength() : 0, W = view.geo.W;
      if (w) t.setAttribute("x", Math.min(Math.max(x, 4 + w / 2), W - 4 - w / 2));
    }

    S = fresh();
    build();
    reset();
    // Rebuild with the other layout when the frame crosses the phone breakpoint (state is kept).
    ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    return { state: () => S };
  },
});
