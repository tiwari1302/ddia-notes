// CAP in two datacenters, told with a 4-ticket counter. A linearizable (single-leader) design
// refuses requests on the side that can't reach the leader's majority; an always-available
// design (a leader per datacenter) keeps selling and oversells. Even with the link up,
// linearizable operations from the far side pay the inter-datacenter round trip.
Viz.register("ch9/cap-partition", {
  title: "When the link breaks: consistency or availability",
  mount(root, ctx) {
    const { s, ui } = ctx;
    const STOCK = 4;
    const NODES = ["n1", "n2", "n3"];
    const C = k => `var(--viz-${k})`;
    const halt = () => new Promise(() => {}); // abandons an async chain after a reset

    // N1 sits next to the WAN so leader <-> N3 packets never pass through N2.
    const DESK = {
      W: 640, H: 228, fs: 12, r: 26, boxSize: 14,
      dc: { east: { x: 12, y: 34, w: 270, h: 186 }, west: { x: 358, y: 34, w: 270, h: 186 } },
      title: { east: [16, 24], west: [362, 24] },
      n: { n1: [212, 100], n2: [82, 100], n3: [428, 100] },
      role: { n1: [212, 62], n2: [82, 62], n3: [428, 62] },
      stock: { n1: [212, 142], n2: [82, 142], n3: [428, 142] },
      users: { east: { x: 77, y: 156, w: 140, h: 40 }, west: { x: 423, y: 156, w: 140, h: 40 } },
      port: { eu: [164, 156], wu: [476, 156] },
      status: { east: [147, 209], west: [493, 209] },
      link: [282, 100, 358, 100], mid: [320, 100], qAxis: [1, 0], qGap: 7,
      // The 76 px gap between the datacenters is too narrow for "WAN · 200 ms" on one line.
      linkTop: [320, 88], linkLabel: [320, 120, "middle"], qLabel: [320, 138, "middle"],
      pill: { x: 250, y: 162, w: 140, h: 26 },  // bridges both datacenters
    };
    const PHONE = {
      W: 360, H: 392, fs: 11, r: 24, boxSize: 13,
      dc: { east: { x: 8, y: 30, w: 344, h: 176 }, west: { x: 8, y: 272, w: 344, h: 112 } },
      title: { east: [14, 20], west: [14, 262] },
      n: { n1: [280, 90], n2: [80, 90], n3: [280, 324] },
      role: { n1: [280, 54], n2: [80, 54], n3: [252, 292, "end"] },
      stock: { n1: [280, 128], n2: [80, 128], n3: [280, 362] },
      users: { east: { x: 110, y: 142, w: 140, h: 38 }, west: { x: 40, y: 305, w: 140, h: 38 } },
      port: { eu: [207, 142], wu: [180, 324] },
      status: { east: [180, 194], west: [110, 360] },
      link: [280, 206, 280, 272], mid: [280, 239], qAxis: [0, 1], qGap: 6.5,
      linkLabel: [292, 239, "start"], qLabel: [268, 239, "end"],
      pill: { x: 24, y: 220, w: 130, h: 24 },
    };

    // Settings survive resets and layout switches; `run` is the per-scenario state.
    let mode = "cp", linkUp = true, rtt = 80, autoStop = null, autoSide = "east";
    let epoch = 0, drainTok = 0, run = null, view = null, compact = ctx.compact;

    const wanMs = () => Math.min(900, 300 + 3 * rtt);
    const soldTotal = () => run.sold.east + run.sold.west;

    function freshRun() {
      return {
        stock: { n1: STOCK, n2: STOCK, n3: STOCK },
        seq: { n1: 0, n2: 0, n3: 0 },   // cp: last leader log position each replica has applied
        sold: { east: 0, west: 0 }, rejected: 0,
        queue: [],                       // ap: replication messages waiting for the link (target node)
        draining: 0,                     // ap: queued messages crossing after a heal
        busy: { east: false, west: false },
        status: { east: ["", ""], west: ["", ""] },
        last: null,                      // the most recent finished event, drives the note
        oversell: null,                  // ap: "race" (link up) or "partition" (queued messages)
      };
    }
    function resetRun() {
      epoch++; drainTok++;
      if (view) view.packets.innerHTML = "";
      run = freshRun();
    }

    // ---------------------------------------------------------------- packets
    const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const pt = k => (k in view.L.n ? [view.L.n[k], view.L.r] : [view.L.port[k], 0]);
    const toward = (p, q, d) => { const k = d / (dist(p, q) || 1); return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]; };
    // Fly a packet from edge to edge of two named points. A `wan` packet checks the link when it
    // reaches the cut point, so a cut also catches messages already in flight: by default it is
    // dropped there (red); with `queue` it joins the queue at the cut instead. Resolves false then.
    async function hop(a, b, o) {
      const ep = epoch, L = view.L, [pa, ra] = pt(a), [pb, rb] = pt(b);
      const from = toward(pa, pb, ra), to = toward(pb, pa, rb);
      const base = { fill: o.fill, label: o.label, labelSize: L.fs, r: compact ? 6 : 7 };
      if (!o.wan) {
        await ctx.fly(view.packets, { ...base, from, to, ms: o.ms });
        if (ep !== epoch) return halt();
        return true;
      }
      // Two legs (ease in, then out) so the flight looks like one smooth trip through the cut.
      const k = dist(from, L.mid) / (dist(from, to) || 1);
      await ctx.fly(view.packets, { ...base, from, to: L.mid, ms: o.ms * k, ease: "in" });
      if (ep !== epoch) return halt();
      if (linkUp) {
        await ctx.fly(view.packets, { ...base, from: L.mid, to, ms: o.ms * (1 - k), ease: "out" });
        if (ep !== epoch) return halt();
        return true;
      }
      if (o.queue) return false;
      // Dropped at the cut: a red copy fades there (ctx.fly's `lost` can't recolour a var() fill).
      await ctx.fly(view.packets, { ...base, from: L.mid, to: L.mid, lost: 0, fill: C("bad"), labelFill: C("bad") });
      if (ep !== epoch) return halt();
      return false;
    }
    async function wait(ms) {
      const ep = epoch;
      await ctx.sleep(ms);
      if (ep !== epoch) return halt();
    }
    const req = kind => ({ ms: 350, fill: C("c6"), label: kind });
    const reply = (label, tone) => ({ ms: 300, fill: C(tone), label });
    const repl = m => ({ ms: 300, fill: C("c1"), label: `stock ${m.value}` });

    function finish(side, kind, outcome, text, tone) {
      run.status[side] = [text, tone];
      run.busy[side] = false;
      run.last = { side, kind, outcome };
      render();
    }

    // ---------------------------------------------------------------- linearizable (cp)
    // N1 is the only place that decides; it appends a sale, commits once N2 (East) has it.
    function accept() { run.stock.n1--; run.seq.n1++; return leaderState(); }
    const leaderState = () => ({ seq: run.seq.n1, value: run.stock.n1 });
    function applyState(n, m) {
      if (m.seq >= run.seq[n]) { run.stock[n] = m.value; run.seq[n] = m.seq; }
    }
    function toN3(m) {
      hop("n1", "n3", { ...repl(m), ms: wanMs(), wan: true }).then(ok => {
        if (ok) { applyState("n3", m); render(); }
      });
    }

    async function cpEast() {
      await hop("eu", "n1", req("buy"));
      if (run.stock.n1 <= 0) {
        await hop("n1", "eu", reply("sold out", "warn"));
        return finish("east", "buy", "soldout", "sold out", "warn");
      }
      const m = accept(); render();
      await hop("n1", "n2", repl(m));
      applyState("n2", m); run.sold.east++; render();
      toN3(m);
      await hop("n1", "eu", reply("✓", "ok"));
      finish("east", "buy", "ok", "ticket ✓ 2 ms", "ok");
    }

    // West buys and reads both have to be decided by the leader across the WAN.
    async function cpWest(kind) {
      await hop("wu", "n3", req(kind));
      if (!(await hop("n3", "n1", { ...req(kind), ms: wanMs(), wan: true }))) return westTimeout(kind, false);
      let outcome = "ok", label = kind === "read" ? `stock ${run.stock.n1}` : "✓";
      if (kind === "buy" && run.stock.n1 <= 0) { outcome = "soldout"; label = "sold out"; }
      else if (kind === "buy") {
        const m = accept(); render();
        await hop("n1", "n2", repl(m));
        applyState("n2", m); run.sold.west++; render();
      }
      const back = leaderState(), tone = outcome === "ok" ? "ok" : "warn";
      if (!(await hop("n1", "n3", { ...reply(label, tone), ms: wanMs(), wan: true }))) {
        return westTimeout(kind, kind === "buy" && outcome === "ok");
      }
      applyState("n3", back); render();
      await hop("n3", "wu", reply(label, tone));
      const ms = `${rtt + 2} ms`;
      if (outcome === "soldout") finish("west", kind, "soldout", "sold out", "warn");
      else finish("west", kind, "ok", kind === "read" ? `stock ${back.value} · ${ms}` : `ticket ✓ ${ms}`, "ok");
    }
    async function westTimeout(kind, committed) {
      run.status.west = ["no reply, waiting…", "muted"]; render();
      await wait(600);
      if (committed) return finish("west", kind, "unknown", "timeout · outcome unknown", "warn");
      run.rejected++;
      finish("west", kind, "refused", kind === "buy" ? "✕ unavailable" : "✕ read unavailable", "bad");
    }

    // ---------------------------------------------------------------- always available (ap)
    // Each datacenter sells from its own copy and ships "-1" to the other side.
    async function apBuy(side) {
      const [port, me] = side === "east" ? ["eu", "n1"] : ["wu", "n3"];
      await hop(port, me, req("buy"));
      if (run.stock[me] <= 0) {
        await hop(me, port, reply("sold out", "warn"));
        return finish(side, "buy", "soldout", "sold out", "warn");
      }
      run.stock[me]--; run.sold[side]++; render();
      if (me === "n1") mirrorN2();
      const other = me === "n1" ? "n3" : "n1";
      if (linkUp) flyOp(other, false);
      else { run.queue.push(other); render(); }
      await hop(me, port, reply("✓", "ok"));
      finish(side, "buy", "ok", "ticket ✓ 1 ms", "ok");
    }
    // A "-1" that reaches the cut after the link went down waits in the queue like any other.
    function flyOp(to, queued) {
      return hop(to === "n3" ? "n1" : "n3", to, { ms: wanMs(), fill: C("c1"), label: "−1", wan: true, queue: true }).then(ok => {
        if (!ok) { run.queue.push(to); render(); return; }
        run.stock[to]--;
        if (to === "n1") mirrorN2();
        if (!run.oversell && Math.min(run.stock.n1, run.stock.n3) < 0) run.oversell = queued ? "partition" : "race";
        render();
      });
    }
    function mirrorN2() {
      hop("n1", "n2", { ms: 300, fill: C("c1"), label: "−1" }).then(() => { run.stock.n2--; render(); });
    }
    async function apRead() {
      await hop("wu", "n3", req("read"));
      const v = run.stock.n3, stale = v !== STOCK - soldTotal();
      await hop("n3", "wu", reply(`stock ${v}`, stale ? "warn" : "ok"));
      finish("west", "read", stale ? "stale" : "fresh", `stock ${v} · 1 ms${stale ? " (stale?)" : ""}`, stale ? "warn" : "ok");
    }
    // After a heal, queued messages cross one by one, 150 ms apart.
    async function drain() {
      const tok = ++drainTok;
      while (run.queue.length && linkUp && tok === drainTok) {
        const to = run.queue.shift();
        run.draining++; render();
        flyOp(to, true).then(() => {
          run.draining--;
          if (!run.draining && !run.queue.length) run.last = { kind: "merged" };
          render();
        });
        await wait(150);
      }
    }

    // ---------------------------------------------------------------- actions
    function buy(side) {
      if (run.busy[side]) return;
      run.busy[side] = true;
      run.status[side] = ["buying…", "muted"]; render();
      if (mode === "ap") apBuy(side);
      else if (side === "east") cpEast();
      else cpWest("buy");
    }
    function read() {
      if (run.busy.west) return;
      run.busy.west = true;
      run.status.west = ["reading…", "muted"]; render();
      if (mode === "ap") apRead(); else cpWest("read");
    }
    function toggleLink() {
      linkUp = !linkUp;
      run.last = { kind: linkUp ? "heal" : "cut" };
      if (linkUp && mode === "cp") {
        const m = leaderState(); // N3 catches up with one state transfer
        hop("n1", "n3", { ...repl(m), ms: wanMs(), wan: true }).then(ok => { if (ok) { applyState("n3", m); render(); } });
      } else if (linkUp) drain();
      render();
    }
    function setAuto(on) {
      if (on && !autoStop) {
        autoStop = ctx.every(1400, () => {
          const side = autoSide;
          autoSide = side === "east" ? "west" : "east";
          if (!run.busy[side]) buy(side);
        });
      } else if (!on && autoStop) { autoStop(); autoStop = null; }
    }

    // ---------------------------------------------------------------- notes
    function noteFor() {
      const L = run.last || {}, ms = `<b>${rtt + 2} ms</b>`;
      if (mode === "cp") {
        if (L.outcome === "unknown") return ["West timed out without knowing whether it bought a ticket: the sale committed in East, but the reply was lost at the cut. A timeout doesn't mean the write failed.", "warn"];
        if (L.outcome === "soldout") return ["Sold out, and no ticket was sold twice: the constraint held because one place decides.", "ok"];
        if (!linkUp) {
          if (L.side === "west" && L.outcome === "refused" && L.kind === "read") return ["N3 has a copy, but it can't know whether East has sold more since the cut. Answering could return a stale count, so a linearizable system refuses the read too, not just the write.", "bad"];
          if (L.side === "west" && L.outcome === "refused") return ["West can't reach the leader. To keep a single, up-to-date stock count it must refuse (or hang) until the link heals. East keeps selling because it holds the majority. This is choosing C over A.", "bad"];
          return ["Link cut. East still has the leader and 2 of 3 replicas, a majority, so it keeps selling. N3 is cut off from the leader: try buying or checking stock from West.", "warn"];
        }
        if (L.kind === "read") return [`Reads are operations too: N3's own copy might be missing East's latest sale, so a linearizable read from West asks the leader and pays the round trip (${ms}).`, "info"];
        return [`One leader in East. A purchase commits once 2 of 3 replicas have it, and both are in East, so East writes take <b>2 ms</b>. Every West purchase must cross the WAN: ${ms} even when nothing is broken. Linearizability costs latency all the time, not only during partitions.` +
          (run.last ? "" : " <i>Try: cut the link and buy on both sides, then switch to <b>Always available</b> and repeat.</i>"), "info"];
      }
      if (L.kind === "read") {
        if (L.outcome === "fresh") return ["N3 answered instantly from its own copy. It happens to be current, but N3 can't know that: during a cut, or while an update is crossing the WAN, the same read would be stale.", "info"];
        return linkUp
          ? ["N3 answered from its own copy while East's latest sale was still crossing the WAN: a stale read, even though nothing is broken.", "warn"]
          : ["N3 answered instantly from its own copy, but East has sold since: the answer is stale. Available, not linearizable.", "warn"];
      }
      if (!linkUp) {
        return [`Both sides keep selling from copies that can't see each other. East's copy says <b>${run.stock.n1}</b> left, West's says <b>${run.stock.n3}</b>.` +
          (soldTotal() > STOCK ? " Neither side knows it has already oversold. Heal the link to let the copies merge." : " Heal the link to see what really happened."), "warn"];
      }
      if (run.oversell === "race") return ["Oversold without any partition: both sides sold the last ticket while their updates were crossing the WAN. A partition doesn't create this race, it just makes the window unbounded.", "bad"];
      if (run.draining) return ["Link healed: the queued sales cross the WAN one by one, and each side learns what the other sold.", "info"];
      if (run.oversell === "partition") return [`The copies merged: <b>${soldTotal()}</b> tickets sold, but only ${STOCK} existed. Staying available during the cut cost you the constraint; someone now has to refund and apologize. Avoiding that requires linearizability, and accepting its unavailability.`, "bad"];
      if (L.kind === "merged") return ["Merged fine this time: together the two sides stayed within the stock. Cut the link and buy more on both sides.", "info"];
      return ["Each datacenter sells from its own copy and syncs in the background: <b>1 ms</b> everywhere. Usually fine while the link is up, but if both sides sell the last ticket before hearing about each other's sale, both succeed: multi-leader isn't linearizable even without a partition. <i>Try: with 1 ticket left, press <b>Both buy at once</b>.</i>", "info"];
    }

    // ---------------------------------------------------------------- scene
    function line(a, b, o = {}) {
      return s("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: C("line"), "stroke-width": o.width || 1.5, "stroke-linecap": "round" });
    }
    const spaced = el => { el.style.marginTop = "12px"; return el; };
    function build() {
      root.innerHTML = "";
      compact = ctx.compact;
      const L = compact ? PHONE : DESK, fs = L.fs;
      const svg = ctx.svg({ w: L.W, h: L.H, label: "Two datacenters holding three replicas of a ticket counter, joined by a WAN link" });
      const scene = s("g"), packets = s("g");
      svg.append(scene, packets);
      const v = { L, packets, nodes: {}, roles: {}, stocks: {}, users: {}, status: {}, suffix: {} };

      for (const side of ["east", "west"]) {
        const d = L.dc[side];
        scene.appendChild(s("rect", { x: d.x, y: d.y, width: d.w, height: d.h, rx: 12, fill: C("panel"), stroke: C("line"), "stroke-width": 1.5, "stroke-dasharray": "6 5" }));
        const t = ctx.text(L.title[side][0], L.title[side][1], "", { size: 12, anchor: "start" });
        t.appendChild(s("tspan", { "font-weight": 700 }, side === "east" ? "Datacenter East" : "Datacenter West"));
        t.appendChild(v.suffix[side] = s("tspan", { fill: C("muted") }));
        scene.appendChild(t);
      }
      // Topology: the WAN link plus thin in-datacenter connectors (nodes and boxes hide line ends).
      const [x1, y1, x2, y2] = L.link;
      scene.append(line(L.n.n1, L.n.n2), line(L.port.eu, L.n.n1), line(L.port.wu, L.n.n3),
        line(L.n.n1, [x1, y1]), line([x2, y2], L.n.n3));
      v.link = s("line", { x1, y1, x2, y2, "stroke-width": 4, "stroke-linecap": "round" });
      v.linkLabel = ctx.text(L.linkLabel[0], L.linkLabel[1], "", { size: fs, anchor: L.linkLabel[2], weight: 600, halo: true });
      v.linkTop = L.linkTop ? ctx.text(L.linkTop[0], L.linkTop[1], "WAN", { size: fs, weight: 600, fill: C("muted"), halo: true }) : null;
      if (v.linkTop) scene.appendChild(v.linkTop);
      v.cutX = ctx.text(L.mid[0], L.mid[1], "✕", { size: 16, weight: 800, fill: C("bad"), halo: true });
      v.qLabel = ctx.text(L.qLabel[0], L.qLabel[1], "", { size: fs, anchor: L.qLabel[2], weight: 600, fill: C("warn"), halo: true });
      v.qDots = s("g");
      scene.append(v.link, v.qDots, v.cutX, v.linkLabel, v.qLabel);

      for (const n of NODES) {
        const [x, y] = L.n[n];
        scene.appendChild(v.nodes[n] = ctx.node({ x, y, r: L.r, label: n.toUpperCase() }));
        const [rx, ry, anchor] = L.role[n];
        scene.appendChild(v.roles[n] = ctx.text(rx, ry, "", { size: 12, weight: 700, anchor: anchor || "middle" }));
        scene.appendChild(v.stocks[n] = ctx.text(L.stock[n][0], L.stock[n][1], "", { size: 12, mono: true, halo: true }));
      }
      for (const side of ["east", "west"]) {
        scene.appendChild(v.users[side] = ctx.box({
          ...L.users[side], label: side === "east" ? "East users" : "West users", sub: "bought 0",
          size: L.boxSize, fill: C("c6-soft"), stroke: C("c6"),
        }));
        scene.appendChild(v.status[side] = ctx.text(L.status[side][0], L.status[side][1], "", { size: 12, weight: 600 }));
      }
      scene.appendChild(v.pill = ctx.box({ ...L.pill, rx: 12, label: "", size: 13, fill: C("bad-soft"), stroke: C("bad"), ink: C("bad") }));

      // Controls
      const modeSeg = ui.segmented({
        label: "Design", value: mode, onChange: m => { mode = m; resetRun(); render(); },
        options: [{ value: "cp", label: "Linearizable" }, { value: "ap", label: "Always available" }],
      });
      const rttSlider = ui.slider({
        label: "Inter-DC round trip", min: 20, max: 200, step: 10, value: rtt, format: x => x + " ms",
        onInput: x => { rtt = x; render(); },
      });
      v.cutBtn = ui.button("", toggleLink);
      v.eastBtn = ui.button("East: buy ticket", () => buy("east"), { kind: "primary" });
      v.westBtn = ui.button("West: buy ticket", () => buy("west"), { kind: "primary" });
      v.bothBtn = ui.button("Both buy at once", () => { buy("east"); buy("west"); }, { title: "East and West each try to buy a ticket at the same moment" });
      v.readBtn = ui.button("West: check stock", read);
      const autoTog = ui.toggle({ label: "Auto traffic", value: !!autoStop, onChange: setAuto });
      const resetBtn = ui.button("Reset", () => { linkUp = true; resetRun(); render(); }, { kind: "ghost" });
      v.stats = ui.stats([
        { key: "sold", label: "Sold" },
        { key: "left", label: "Tickets left" },
        { key: "rej", label: "Rejected" },
        { key: "ew", label: "East write" },
        { key: "ww", label: "West write" },
      ]);
      v.note = ui.note("");
      root.append(
        ui.bar(modeSeg, v.cutBtn),
        svg,
        spaced(ui.bar(v.eastBtn, v.westBtn, v.bothBtn, v.readBtn)),
        v.stats,
        v.note,
        spaced(ui.bar(rttSlider, autoTog, resetBtn)),
        ui.legend([
          { color: C("c1"), label: "leader" },
          { color: C("c2"), label: "follower" },
          { color: C("c6"), label: "users", shape: "square" },
          { color: C("ok"), label: "success" },
          { color: C("bad"), label: "rejected / oversold" },
          { color: C("warn"), label: "queued / stale copy", shape: "dash" },
        ]),
      );
      view = v;
      render();
    }

    function roleOf(n) {
      if (mode === "cp") return n === "n1" ? ["leader", "c1"] : ["follower", "c2"];
      return n === "n1" ? ["East leader", "c1"] : n === "n3" ? ["West leader", "c1"] : ["follower", "c2"];
    }
    function queueDot(side, i) {
      const L = view.L, d = (side === "east" ? -1 : 1) * (12 + i * L.qGap);
      return s("circle", { cx: L.mid[0] + d * L.qAxis[0], cy: L.mid[1] + d * L.qAxis[1], r: compact ? 3 : 3.5, fill: C("warn"), stroke: C("bg"), "stroke-width": 1 });
    }

    function render() {
      const v = view, r = run, total = soldTotal(), left = STOCK - total;
      for (const n of NODES) {
        const [role, c] = roleOf(n);
        ctx.attr(v.nodes[n].circle, { fill: C(c + "-soft"), stroke: C(c) });
        v.roles[n].textContent = role;
        ctx.attr(v.roles[n], { fill: C(c) });
        const val = r.stock[n], stale = mode === "cp" ? val !== r.stock.n1 : val !== left;
        v.stocks[n].textContent = `stock ${val}`;
        ctx.attr(v.stocks[n], { fill: C(val < 0 ? "bad" : stale ? "warn" : "ink"), "font-weight": val < 0 || stale ? 700 : 400 });
      }
      for (const side of ["east", "west"]) {
        v.users[side].sub.textContent = `bought ${r.sold[side]}`;
        const [text, tone] = r.status[side];
        v.status[side].textContent = text;
        ctx.attr(v.status[side], { fill: C(tone || "muted") });
      }
      v.suffix.east.textContent = mode === "cp" ? " · majority (2 of 3)" : " · own leader";
      v.suffix.west.textContent = mode === "cp" ? " · minority (1 of 3)" : " · own leader";

      ctx.attr(v.link, { stroke: C(linkUp ? "line" : "bad"), "stroke-dasharray": linkUp ? "none" : "7 6" });
      v.cutX.style.display = linkUp ? "none" : "";
      v.linkLabel.textContent = linkUp ? (compact ? `WAN ${rtt} ms` : `${rtt} ms`) : "link cut";
      ctx.attr(v.linkLabel, { fill: C(linkUp ? "muted" : "bad") });
      v.qDots.innerHTML = "";
      const fromEast = r.queue.filter(t => t === "n3").length;
      for (let i = 0; i < Math.min(4, fromEast); i++) v.qDots.appendChild(queueDot("east", i));
      for (let i = 0; i < Math.min(4, r.queue.length - fromEast); i++) v.qDots.appendChild(queueDot("west", i));
      v.qLabel.textContent = r.queue.length ? `queued: ${r.queue.length}` : "";

      const oversold = Math.min(r.stock.n1, r.stock.n2, r.stock.n3) < 0;
      v.pill.style.display = oversold ? "" : "none";
      v.pill.label.textContent = `oversold by ${total - STOCK}`;

      v.stats.set("sold", total);
      v.stats.set("left", left, left < 0 ? "bad" : "");
      v.stats.set("rej", r.rejected, r.rejected ? "warn" : "");
      v.stats.set("ew", mode === "cp" ? "2 ms" : "1 ms");
      if (mode === "ap") v.stats.set("ww", "1 ms", "");
      else v.stats.set("ww", linkUp ? `${rtt + 2} ms` : "✕", linkUp ? "warn" : "bad");
      const [html, tone] = noteFor();
      v.note.set(html, tone);

      v.eastBtn.disable(r.busy.east);
      v.westBtn.disable(r.busy.west);
      v.readBtn.disable(r.busy.west);
      v.bothBtn.disable(r.busy.east || r.busy.west);
      v.cutBtn.setLabel(linkUp ? "✂︎ Cut WAN link" : "Heal link");
      v.cutBtn.className = "viz-btn viz-btn--" + (linkUp ? "danger" : "ok");
    }

    run = freshRun();
    build();
    ctx.onResize(() => { if (ctx.compact !== compact) build(); });
  },
});
