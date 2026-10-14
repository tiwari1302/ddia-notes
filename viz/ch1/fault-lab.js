// Fault lab: a small replicated web service under three kinds of fault. Spare servers absorb
// an independent hardware fault, but a correlated software bug or a bad config pushed to every
// replica hits them all at once; those need restarts, staged rollout and fast rollback.
// All timings are illustrative model parameters (1 tick = 1 simulated minute).
Viz.register("ch1/fault-lab", {
  title: "Fault lab: when faults become failures",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const N = 8, STRIP = 60, TICK_MS = 400;
    // A watchdog runs on every server and reboots its own machine once it has been stuck WATCHDOG_AT
    // minutes, so all hung servers reboot together: spare capacity can't shorten that outage.
    const DETECT = 2, REPLACE = 12, WATCHDOG_AT = 3, OPERATOR_AT = 15, REBOOT = 2;
    const CANARY_STAGE2 = 4, CANARY_STAGE3 = 8, HUMAN_ROLLBACK = 10, IDLE_PAUSE = 6;

    const NAME = i => "S" + (i + 1);
    const pct = e => +(e * 100).toFixed(1) + "%";
    const toneOf = e => (e === 0 ? "ok" : e <= 0.15 ? "warn" : "bad");
    const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
    // Sorted ids -> "S1", "S2 and S3", "S1–S4 and S6" (runs of 3+ collapse to a range).
    function names(ids) {
      const parts = [];
      for (let a = 0, b = 0; a < ids.length; a = b) {
        for (b = a + 1; b < ids.length && ids[b] === ids[b - 1] + 1;) b++;
        if (b - a >= 3) parts.push(`${NAME(ids[a])}–${NAME(ids[b - 1])}`);
        else for (let k = a; k < b; k++) parts.push(NAME(ids[k]));
      }
      return parts.length < 2 ? parts.join("") : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
    }

    // Look of each server state: fill/stroke color tokens, dashed outline, sub-label.
    const LOOK = {
      ok: { fill: "c2-soft", stroke: "c2", sub: "ok" },
      down: { fill: "bad-soft", stroke: "bad", dash: true, sub: "down", tone: "bad" },
      hung: { fill: "bad-soft", stroke: "bad", sub: "hung", tone: "bad" },
      badcfg: { fill: "bad-soft", stroke: "bad", width: 3, sub: "bad cfg", tone: "bad" },
      rebooting: { fill: "warn-soft", stroke: "warn", sub: "rebooting", tone: "warn" },
      replacing: { fill: "warn-soft", stroke: "warn", sub: "replacing", tone: "warn" },
    };

    // The LB feeds a bus; each server hangs off it on its own short drop, so no link ever
    // passes behind another server. A drop turns dashed red when the health check removes it.
    const DESK = {
      W: 640, H: 300, users: [[40, 88], [40, 150], [40, 212]], ur: 14, uSize: 12,
      lb: { x: 100, y: 125, w: 90, h: 50, label: "Load", sub: "balancer", size: 14 },
      lbIn: [100, 150], lbOut: [190, 150], busY: 150,
      sx: [290, 380, 470, 560], sy: [88, 212], r: 26, subDy: [-39, 39], subSize: 12,
      need: [10, 20], clock: [630, 20], verdict: [320, 20], txt: 12,
      stripLabel: [10, 272], now: [630, 272], strip: { x0: 110, x1: 596, y: 264, w: 7, h: 16 },
    };
    const PHONE = {
      W: 360, H: 380, users: [[90, 30], [180, 30], [270, 30]], ur: 12, uSize: 11,
      lb: { x: 125, y: 62, w: 110, h: 38, label: "Load balancer", size: 11 },
      lbIn: [180, 62], lbOut: [180, 100], busY: 211,
      sx: [60, 140, 220, 300], sy: [160, 262], r: 22, subDy: [-33, 34], subSize: 11,
      need: [20, 372], clock: [340, 372], verdict: [180, 372], txt: 11,
      stripLabel: [20, 316], now: [340, 316], strip: { x0: 20, x1: 340, y: 328, w: 4.3, h: 14 },
    };

    let st, rnd, pktRnd, view = null, stopClock = null, gen = 0, compact = ctx.compact;

    function fresh() {
      // Faults and packets draw from separate streams so packet timing never changes
      // which server a click kills.
      rnd = ctx.random(42);
      pktRnd = ctx.random(7);
      return {
        t: 0, need: 5, watchdog: false, canary: false, autoRollback: false,
        servers: Array.from({ length: N }, () => ({ state: "ok", routed: true, due: 0 })),
        strip: new Array(STRIP).fill(0),
        faults: 0, errMinutes: 0, episode: 0, idle: 0, inflight: 0,
        prevE: 0, overloaded: false,
        leap: null,         // { at, count } while a leap-second incident is active
        rollout: null,      // { at, canary, stage, spike, rollbackAt, touched, peak }
        lastRollback: null, // summary of the last rollback, for the note
      };
    }

    // ---------------------------------------------------------------- model
    function census() {
      const c = { ok: [], okRouted: 0, routed: 0, down: [], replacing: [], hung: [], rebooting: [], badcfg: [] };
      st.servers.forEach((v, i) => {
        c[v.state].push(i);
        if (v.routed) { c.routed++; if (v.state === "ok") c.okRouted++; }
      });
      return c;
    }
    // Requests on a routed-but-broken server fail (workingShare); each working server can
    // carry only 1/need of the load, so too few of them overflow (capacityShare).
    function errorRate(c) {
      if (!c.routed) return 1;
      return 1 - Math.min(c.okRouted / c.routed, c.okRouted / st.need, 1);
    }
    const steady = c => c.ok.length === N && c.routed === N && !st.rollout && !st.leap;

    // ---------------------------------------------------------------- clock
    function startClock() {
      st.idle = 0;
      if (!stopClock) stopClock = ctx.every(TICK_MS, tick);
    }
    function pauseClock() {
      if (stopClock) { stopClock(); stopClock = null; }
    }

    function tick() {
      // 1) Record the minute that just ended (the state that held during it).
      const e = errorRate(census());
      st.strip.push(e); st.strip.shift();
      if (e > 0) { st.errMinutes++; st.episode++; }
      const R = st.rollout;
      if (R) { R.spike = e > 0.01 ? R.spike + 1 : 0; R.peak = Math.max(R.peak, e); }
      // 2) Advance the clock and apply whatever is due now.
      st.t++;
      advanceServers();
      advanceLeap();
      advanceRollout();
      // 3) Auto-pause once the system has been steady for a while.
      if (steady(census())) {
        if (++st.idle >= IDLE_PAUSE) { pauseClock(); log("steady again: clock paused", "muted"); }
      } else st.idle = 0;
      sendPackets();
      update();
    }

    function advanceServers() {
      const removed = [], replaced = [];
      st.servers.forEach((v, i) => {
        if (v.due > st.t) return;
        if (v.state === "down") {
          Object.assign(v, { state: "replacing", routed: false, due: st.t + REPLACE });
          removed.push(i);
        } else if (v.state === "replacing" || v.state === "rebooting") {
          if (v.state === "replacing") replaced.push(i);
          Object.assign(v, { state: "ok", routed: true });
        }
      });
      if (removed.length) log(`health check removed ${names(removed)}`, "warn");
      if (replaced.length) log(`${names(replaced)} replaced`, "ok");
    }

    function advanceLeap() {
      const L = st.leap;
      if (!L) return;
      const since = st.t - L.at;
      const hung = census().hung;
      if (since === DETECT && hung.length) {
        hung.forEach(i => { st.servers[i].routed = false; });
        log(`health check removed ${plural(hung.length, "hung server")}`, "warn");
      }
      const who = since >= OPERATOR_AT ? "operator reboots" : st.watchdog && since >= WATCHDOG_AT ? "watchdogs reboot" : null;
      if (who && hung.length) {
        hung.forEach(i => Object.assign(st.servers[i], { state: "rebooting", routed: false, due: st.t + REBOOT }));
        log(`${who} ${plural(hung.length, "hung server")}`, "warn");
      }
      const c = census();
      if (!c.hung.length && !c.rebooting.length) { st.leap = null; log("all hung servers rebooted and serving", "ok"); }
    }

    function advanceRollout() {
      const R = st.rollout;
      if (!R) return;
      const since = st.t - R.at;
      if (R.rollbackAt !== null && st.t >= R.rollbackAt) return rollback(true);
      if (since >= HUMAN_ROLLBACK) return rollback(false);
      if (R.canary && since === CANARY_STAGE2) applyStage(2);
      if (R.canary && since === CANARY_STAGE3) applyStage(Infinity);
      if (st.autoRollback && R.spike >= 2 && R.rollbackAt === null) R.rollbackAt = st.t + 1;
    }

    function applyStage(count) {
      const R = st.rollout;
      const ids = census().ok.slice(0, count);
      R.stage++;
      if (!ids.length) return;
      ids.forEach(i => { st.servers[i].state = "badcfg"; R.touched.push(i); });
      const label = !R.canary ? (ids.length === N ? "all 8 servers" : `all ${ids.length} working servers`)
        : names(ids) + (R.stage === 1 ? " (canary)" : "");
      log(`config v2 → ${label}`, "bad");
    }

    function rollback(auto) {
      const R = st.rollout;
      census().badcfg.forEach(i => { st.servers[i].state = "ok"; });
      st.lastRollback = { auto, canary: R.canary, touched: R.touched.slice().sort((a, b) => a - b), minutes: st.t - R.at, peak: R.peak };
      st.rollout = null;
      log(auto ? "monitoring: error spike → automatic rollback" : "a human noticed → config rolled back", "ok");
    }

    // ---------------------------------------------------------------- faults
    function inject(fn) {
      if (!fn(census())) return;
      st.faults++;
      st.lastRollback = null;
      startClock();
      update();
    }
    const killServer = () => inject(c => {
      if (!c.ok.length) return false;
      const i = rnd.pick(c.ok);
      Object.assign(st.servers[i], { state: "down", due: st.t + DETECT });
      log(`${NAME(i)} disk died (hardware fault)`, "bad");
      return true;
    });
    const leapSecond = () => inject(c => {
      if (!c.ok.length || st.leap) return false;
      c.ok.forEach(i => { st.servers[i].state = "hung"; });
      st.leap = { at: st.t, count: c.ok.length };
      log(`leap second: ${c.ok.length === N ? "all 8 servers" : plural(c.ok.length, "server")} hung (software fault)`, "bad");
      return true;
    });
    const pushConfig = () => inject(c => {
      if (!c.ok.length || st.rollout) return false;
      st.rollout = { at: st.t, canary: st.canary, stage: 0, spike: 0, rollbackAt: null, touched: [], peak: 0 };
      applyStage(st.canary ? 1 : Infinity);
      return true;
    });

    // ---------------------------------------------------------------- packets
    function sendPackets() {
      if (ctx.instant || !view) return;
      for (let k = 0; k < 2 && st.inflight < 4; k++) flyOne();
    }
    async function flyOne() {
      const my = gen, v = view, c = census(), e = errorRate(c);
      const routed = st.servers.map((sv, i) => (sv.routed ? i : -1)).filter(i => i >= 0);
      const u = pktRnd.int(0, 2);
      const target = routed.length ? pktRnd.pick(routed) : -1;
      let good = false;
      if (target >= 0 && st.servers[target].state === "ok") {
        // Share of requests to a working server that overflow, chosen so the overall
        // red share equals errorRate().
        good = !pktRnd.chance(1 - Math.min(1, ((1 - e) * routed.length) / c.okRouted));
      }
      const fill = good ? "var(--viz-ok)" : "var(--viz-bad)";
      const r = compact ? 4.5 : 5.5;
      st.inflight++;
      await ctx.fly(v.packets, { from: v.L.users[u], to: v.L.lbIn, ms: 220, r, fill, ease: "linear" });
      // Second hop follows the wiring (LB -> bus -> drop), or bounces back to the user.
      const path = target >= 0 ? wirePath(v.L, v.pos[target]) : [v.L.lbIn, v.L.users[u]];
      const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
      let total = 0;
      for (let k = 1; k < path.length; k++) total += len(path[k - 1], path[k]);
      for (let k = 1; k < path.length && my === gen; k++) {
        const ms = (220 * len(path[k - 1], path[k])) / total;
        if (ms >= 1) await ctx.fly(v.packets, { from: path[k - 1], to: path[k], ms, r, fill, ease: "linear" });
      }
      if (my === gen) st.inflight--;
    }
    // LB output -> along the bus -> down (or up) the server's drop to its center.
    function wirePath(L, p) {
      const pts = [L.lbOut];
      if (L.lbOut[1] !== L.busY) pts.push([L.lbOut[0], L.busY]);
      pts.push([p[0], L.busY], p);
      return pts;
    }

    // ---------------------------------------------------------------- scene
    function build() {
      compact = ctx.compact;
      const L = compact ? PHONE : DESK;
      const svg = ctx.svg({ w: L.W, h: L.H, label: "Users, a load balancer and eight app servers, with a 60-minute health strip" });
      const wires = s("g"), nodes = s("g"), packets = s("g");
      svg.append(wires, nodes, packets);
      const line = (a, b) => wires.appendChild(s("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: "var(--viz-line)", "stroke-width": 1.4 }));

      L.users.forEach(p => {
        line(p, L.lbIn);
        nodes.appendChild(ctx.node({ x: p[0], y: p[1], r: L.ur, label: "U", size: L.uSize, fill: "var(--viz-c6-soft)", stroke: "var(--viz-c6)" }));
      });
      nodes.appendChild(ctx.box({ ...L.lb, fill: "var(--viz-node)", stroke: "var(--viz-node-stroke)" }));

      const pos = st.servers.map((_, i) => [L.sx[i % 4], L.sy[Math.floor(i / 4)]]);
      // Bus: from the LB (straight down to it on phones) across under every server column.
      if (L.lbOut[1] !== L.busY) line(L.lbOut, [L.lbOut[0], L.busY]).setAttribute("stroke-width", 2);
      line([Math.min(L.lbOut[0], L.sx[0]), L.busY], [L.sx[3], L.busY]).setAttribute("stroke-width", 2);
      const links = pos.map(([x, y]) => ctx.attr(line([x, L.busY], [x, y + (y < L.busY ? L.r : -L.r)]), { "stroke-width": 2 }));
      const servers = pos.map(([x, y], i) => {
        const n = ctx.node({ x, y, r: L.r, label: NAME(i), size: 12 });
        n.state = ctx.text(x, y + L.subDy[Math.floor(i / 4)], "", { size: L.subSize, halo: true });
        n.appendChild(n.state);
        nodes.appendChild(n);
        return n;
      });

      const needT = ctx.text(L.need[0], L.need[1], "", { size: L.txt, anchor: "start" });
      const clockT = ctx.text(L.clock[0], L.clock[1], "", { size: L.txt, anchor: "end", mono: true });
      const verdictT = ctx.text(L.verdict[0], L.verdict[1], "", { size: L.txt, weight: 700 });
      const stripT = ctx.text(L.stripLabel[0], L.stripLabel[1], "Last 60 min", { size: L.txt, anchor: "start", fill: "var(--viz-muted)" });
      const nowT = ctx.text(L.now[0], L.now[1], "now", { size: L.txt, anchor: "end", fill: "var(--viz-muted)" });
      svg.append(needT, clockT, verdictT, stripT, nowT);

      const S = L.strip, step = (S.x1 - S.x0) / STRIP;
      const cells = st.strip.map((_, i) => svg.appendChild(s("rect", {
        x: (S.x0 + i * step).toFixed(2), y: S.y, width: S.w, height: S.h, rx: 1.5,
      })));

      svgSlot.replaceChildren(svg);
      view = { L, svg, packets, pos, links, servers, needT, clockT, verdictT, cells };
      update();
    }

    function renderScene(c, e) {
      const v = view;
      st.servers.forEach((sv, i) => {
        const look = LOOK[sv.state], n = v.servers[i];
        ctx.attr(n.circle, {
          fill: `var(--viz-${look.fill})`, stroke: `var(--viz-${look.stroke})`,
          "stroke-width": look.width || 2, "stroke-dasharray": look.dash ? "5 4" : "none",
        });
        n.state.textContent = sv.state === "replacing" || sv.state === "rebooting" ? `${look.sub} ${sv.due - st.t}` : look.sub;
        ctx.attr(n.state, { fill: look.tone ? `var(--viz-${look.tone})` : "var(--viz-muted)" });
        ctx.attr(v.links[i], sv.routed
          ? { stroke: "var(--viz-line)", "stroke-dasharray": "none", opacity: 1 }
          : { stroke: "var(--viz-bad)", "stroke-dasharray": "4 3", opacity: 0.8 });
      });
      v.needT.textContent = compact ? `Need ${st.need} of 8` : `Load needs ${st.need} of 8 servers`;
      v.clockT.textContent = `t = ${st.t} min`;
      v.verdictT.textContent = e === 0 ? "users: all OK" : `users: ${pct(e)} of requests fail`;
      ctx.attr(v.verdictT, { fill: `var(--viz-${toneOf(e)})` });
      v.cells.forEach((r, i) => ctx.attr(r, { fill: `var(--viz-${toneOf(st.strip[i])})` }));
    }

    // ---------------------------------------------------------------- explanation
    function noteFor(c, e) {
      const need = st.need, ok = c.okRouted;
      if (!st.faults) {
        const spares = N - need ? `so you have <b>${plural(N - need, "spare")}</b>` : "so there is <b>no spare</b>";
        return [`Eight servers share the load and the load needs <b>${need}</b>, ${spares}. A <b>fault</b> is one component misbehaving; a <b>failure</b> is users not getting service. Inject a fault and see which one you get.`, "info"];
      }
      if (c.hung.length || c.rebooting.length) {
        const k = st.leap ? st.leap.count : c.hung.length + c.rebooting.length;
        const what = k === N ? "all 8 servers" : `all ${k} working servers`;
        if (st.watchdog) {
          return [`The leap-second bug hung ${what} at once and spare capacity can't help, but each server's watchdog <b>reboots</b> it after ${WATCHDOG_AT} minutes stuck, so service returns in minutes instead of waiting ~${OPERATOR_AT + REBOOT} for an operator. Automatic restart is one of the few generic defenses against software faults; it works here because the trigger moment has passed (a bug re-triggered on every boot would crash-loop instead).`, "warn"];
        }
        const tail = c.hung.length ? "Waiting for an operator…" : `An operator stepped in after ${OPERATOR_AT} minutes and is rebooting them all.`;
        return [`One leap-second bug hung ${what} in the same instant. They run the same kernel, so ${k} copies meant ${k} identical failures: redundancy assumes faults are independent, and this one is <b>correlated</b>. ${tail}`, "bad"];
      }
      if (st.rollout) {
        const R = st.rollout, bad = c.badcfg;
        if (st.autoRollback) {
          const verb = bad.length === 1 ? "has the bad config and fails" : "have the bad config and fail";
          return [`${names(bad)} ${verb} every request it gets (errors now <b>${pct(e)}</b>). Monitoring is watching: after 2 minutes above 1% errors it rolls the config back automatically.`, "warn"];
        }
        if (!R.canary) {
          return [`The bad config reached ${bad.length === N ? "all 8 servers" : `all ${bad.length} working servers`} at once. They are up and pass liveness health checks, so the load balancer keeps routing to them: <b>${pct(e)} errors</b> until a human rolls back. A health check that only asks "is the process up?" can't see wrong behavior.`, "bad"];
        }
        if (R.stage === 1) {
          return [`Canary: only ${names(bad)} has the bad config, so 1 in ${c.routed} requests fails. A canary only helps if something is watching it, and auto-rollback is off…`, "bad"];
        }
        return [`A canary only helps if something is watching it. Nobody was, so the rollout kept going: ${names(bad)} now fail every request (<b>${pct(e)} errors</b>).`, "bad"];
      }
      if (c.down.length) {
        const d = c.down, one = d.length === 1;
        return [`${names(d)}${one ? "'s disk died" : " lost their disks"}. Until the health check notices (${DETECT} min), the load balancer still sends ${one ? "it" : "them"} ${d.length} in ${c.routed} requests, and those fail.`, toneOf(e) === "bad" ? "bad" : "warn"];
      }
      if (ok < need) {
        const lead = ok ? `Only ${plural(ok, "working server")} for a load that needs ${need}: the survivors are overloaded and <b>${pct(e)}</b> of requests fail.`
                        : "No working servers left while the replacements boot: every request fails.";
        return [`${lead} Redundancy only protects you while there is <b>headroom</b>.${ok >= 2 ? " Try lowering the load." : ""}`, "bad"];
      }
      if (c.replacing.length) {
        return [`The health check removed ${names(c.replacing)}; the ${ok} working servers still cover a load that needs ${need}. Users notice nothing: a <b>fault</b>, not a <b>failure</b>.`, "ok"];
      }
      const R = st.lastRollback;
      if (R && R.auto) {
        const n = R.touched.length;
        if (R.canary && n <= 3) {
          return [`The bad config reached only ${names(R.touched)} (${n}/8 of traffic). Monitoring saw the error spike and rolled back within ${R.minutes} minutes. Blast radius: ${n === 1 ? "one server" : plural(n, "server")}, ${plural(R.minutes, "minute")}. That is what staged rollouts buy you.`, "ok"];
        }
        const hint = R.canary ? "Turn auto-rollback on before the push to stop it at the canary." : "Switch Rollout to Canary to shrink the blast radius too.";
        return [`Auto-rollback ended it after ${plural(R.minutes, "minute")}, but the config had already reached ${n === N ? "all 8 servers" : plural(n, "server")} (peak ${pct(R.peak)} errors). ${hint}`, "warn"];
      }
      return [`Back to steady state: ${plural(st.faults, "fault")} so far, ${plural(st.errMinutes, "minute")} with errors. Change a defense and repeat the fault.`, "info"];
    }

    // Log transitions that aren't tied to a single event: overload starts, errors stop.
    function watchErrors(c, e) {
      const overloaded = c.okRouted > 0 && c.okRouted < st.need && c.routed === c.okRouted && !st.leap && !st.rollout;
      if (overloaded && !st.overloaded) log(`overload: ${c.okRouted} working, load needs ${st.need} (${pct(e)} fail)`, "bad");
      st.overloaded = overloaded;
      if (st.prevE > 0 && e === 0) {
        log(st.episode ? `users OK again after ${plural(st.episode, "minute")} of errors` : "users OK again", "ok");
        st.episode = 0;
      }
      st.prevE = e;
    }

    function update() {
      const c = census(), e = errorRate(c);
      if (view) renderScene(c, e);
      watchErrors(c, e);
      stats.set("faults", st.faults);
      stats.set("working", `${c.okRouted} / 8 · need ${st.need}`, c.okRouted >= st.need ? "ok" : "bad");
      stats.set("errors", pct(e), toneOf(e));
      stats.set("minutes", st.errMinutes, st.errMinutes ? "bad" : "ok");
      const avail = 1 - st.strip.reduce((a, b) => a + b, 0) / STRIP;
      stats.set("avail", (avail * 100).toFixed(2) + "%", avail === 1 ? "ok" : avail >= 0.99 ? "warn" : "bad");
      note.set(...noteFor(c, e));
      killBtn.disable(!c.ok.length);
      leapBtn.disable(!c.ok.length || c.hung.length > 0 || c.rebooting.length > 0);
      pushBtn.disable(!c.ok.length || !!st.rollout);
    }

    // Newest first: the toolkit log appends at the bottom, so move each row to the top.
    function log(text, tone) {
      const row = logEl.add(`t=${st.t} ${text}`, tone);
      const list = row.parentNode;
      list.prepend(row);
      while (list.children.length > 80) list.lastChild.remove();
      list.scrollTop = 0;
    }

    function reset() {
      gen++;
      pauseClock();
      st = fresh();
      if (view) view.packets.replaceChildren();
      logEl.clear();
      log("all 8 servers healthy", "muted");
      needSlider.set(st.need);
      watchdogT.set(false);
      rolloutSeg.set("all");
      autoT.set(false);
      update();
    }

    // ---------------------------------------------------------------- controls
    st = fresh();
    const label = text => h("span", { class: "viz-seg-label" }, text);
    const killBtn = ui.button("Kill a server", killServer, { kind: "danger", title: "Hardware fault: one random server's disk dies" });
    const leapBtn = ui.button("Leap-second bug", leapSecond, { kind: "danger", title: "Software fault: a kernel bug hangs every running server at once" });
    const pushBtn = ui.button("Push bad config", pushConfig, { kind: "danger", title: "Human error: roll out a broken configuration" });
    const needSlider = ui.slider({
      label: "Load: servers needed", min: 2, max: 8, step: 1, value: st.need,
      onInput: v => { st.need = v; update(); },
    });
    const watchdogT = ui.toggle({ label: "Watchdog reboots hung servers", value: false, onChange: v => { st.watchdog = v; update(); } });
    const rolloutSeg = ui.segmented({
      label: "Rollout", value: "all",
      options: [{ value: "all", label: "All at once" }, { value: "canary", label: "Canary" }],
      onChange: v => { st.canary = v === "canary"; update(); },
    });
    const autoT = ui.toggle({ label: "Auto-rollback on error spike", value: false, onChange: v => { st.autoRollback = v; update(); } });
    const stats = ui.stats([
      { key: "faults", label: "Faults injected", value: "0" },
      { key: "working", label: "Working servers" },
      { key: "errors", label: "Errors now" },
      { key: "minutes", label: "Minutes with errors" },
      { key: "avail", label: "Availability (last 60 min)" },
    ]);
    const note = ui.note("");
    const logEl = ui.log({ title: "What happened", height: 110, max: 1e9 });
    const svgSlot = h("div");
    const caption = h("span", { style: "font-size:12.5px;line-height:1.5;color:var(--viz-muted);flex:1 1 220px" },
      `Illustrative model: 1 tick = 1 simulated minute. Health check ${DETECT} min, replacement ${REPLACE} min, watchdog ${WATCHDOG_AT} min, operator ${OPERATOR_AT} min, reboot ${REBOOT} min, human rollback ${HUMAN_ROLLBACK} min.`);

    const defenses = ui.bar(label("Defenses"), needSlider, watchdogT, rolloutSeg, autoT);
    defenses.style.marginTop = "12px";
    // Stat labels wrap to two lines at some widths; pin values to the bottom so they align.
    stats.querySelectorAll(".viz-stat").forEach(card =>
      Object.assign(card.style, { display: "flex", flexDirection: "column", justifyContent: "space-between" }));
    log("all 8 servers healthy", "muted");
    root.append(
      ui.bar(label("Inject a fault"), killBtn, leapBtn, pushBtn),
      svgSlot,
      stats,
      note,
      defenses,
      ui.legend([
        { color: "var(--viz-c2)", label: "server ok" },
        { color: "var(--viz-bad)", label: "failing" },
        { color: "var(--viz-warn)", label: "recovering" },
        { color: "var(--viz-c6)", label: "user" },
        { color: "var(--viz-bad)", label: "not routed", shape: "dash" },
        { color: "var(--viz-ok)", label: "healthy minute", shape: "square" },
        { color: "var(--viz-warn)", label: "degraded", shape: "square" },
        { color: "var(--viz-bad)", label: "outage", shape: "square" },
      ]),
      logEl,
      ui.bar(ui.button("Reset", reset, { kind: "ghost", title: "Back to the initial state" }), caption),
    );
    build();
    ctx.onResize(() => { if (ctx.compact !== compact) build(); });
  },
});
