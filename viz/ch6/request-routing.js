// Request routing through a partition move (Chapter 6, "Request routing").
// One story told in three routing designs: user:77 lives in partition P3, P3 moves from node B
// to the new node C, and a write arrives while some copy of the partition map is still stale.
// With "Old owner checks ownership" on, B refuses or forwards the write; with it off, B
// acknowledges the write into its leftover copy and the write is silently lost.
Viz.register("ch6/request-routing", {
  title: "Routing through a partition move",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const V = n => `var(--viz-${n})`;
    const paint = (el, st) => { for (const k in st) el.style.setProperty(k, st[k]); return el; };

    // ---------- layouts (rows are y offsets inside a node box; rowsG adds the gossip map row) ----------
    const DESK = {
      w: 640, h: 320, fs: 12, ts: 13, bs: 12, cs: 13, pad: 10, col: true, gap: 4,
      coord: { x: 230, y: 10, w: 180, h: 54, ty: 19, ly: 39, title: "Coordinator (ZooKeeper)" },
      router: { x: 250, y: 145, w: 140, h: 50, ty: 17, ly: 35 },
      client: { x: 70, y: 170, r: 24 }, mapAt: [70, 214], keyAt: [12, 22], keyDy: 22, noteAt: [320, 37],
      nodes: [[470, 30], [470, 128], [470, 226]], nw: 160, nh: 84,
      rows: { title: 18, chips: 42, val: 66, chipH: 18 }, rowsG: { title: 15, chips: 35, map: 54, val: 72, chipH: 16 },
      oldTag: "P3: old copy", val: v => `user:77 = ${v}`,
    };
    const PHONE = {
      w: 360, h: 366, fs: 11, ts: 12, bs: 12, cs: 11, pad: 6, col: false, gap: 3,
      coord: { x: 150, y: 8, w: 170, h: 50, ty: 18, ly: 36, title: "Coordinator" },
      router: { x: 150, y: 118, w: 170, h: 46, ty: 15, ly: 32 },
      client: { x: 54, y: 141, r: 20 }, mapAt: [60, 109], keyAt: [6, 20], keyDy: 20, noteAt: [235, 30],
      nodes: [[6, 262], [126, 262], [246, 262]], nw: 108, nh: 96,
      rows: { title: 17, chips: 43, val: 70, chipH: 16 }, rowsG: { title: 15, chips: 36, map: 57, val: 78, chipH: 15 },
      oldTag: "old copy", val: v => `user:77=${v}`,
    };
    const MODES = {
      client: {
        label: "Partition-aware client", holders: ["coord", "client"],
        intro: "<b>Partition-aware client</b>, as in Redis Cluster smart clients, Kafka clients or Cassandra token-aware drivers: the client caches the partition map and talks to the owner directly.",
      },
      router: {
        label: "Routing tier", holders: ["coord", "router"],
        intro: "<b>Routing tier</b>, as in MongoDB's mongos (map kept on config servers) or Vitess's VTGate: clients talk to a partition-aware router that holds no data and follows the partition map in a coordination service.",
      },
      gossip: {
        label: "Any node + gossip", holders: ["A", "B", "C"],
        intro: "<b>Any node can coordinate</b>, as in Cassandra or Riak: a load balancer sends each request to any node, which forwards it to the owner. Nodes learn the map by gossiping with each other instead of asking a coordinator.",
      },
    };
    const NAMES = { coord: "coordinator", client: "client", router: "router", A: "A", B: "B", C: "C" };
    const CHIP = {
      plain: { fill: "panel", stroke: "line" }, p3: { fill: "c3-soft", stroke: "c3" },
      copying: { fill: "c3-soft", stroke: "c3", dash: true }, old: { fill: "c3-soft", stroke: "c3", strike: true },
    };

    // ---------- persistent controls ----------
    let mode = "client", on = true, compact = ctx.compact, player = null, gen = 0;
    const seg = ui.segmented({
      label: "Routing", value: mode,
      options: Object.keys(MODES).map(k => ({ value: k, label: MODES[k].label })),
      onChange: v => { mode = v; restart(); },
    });
    const tog = ui.toggle({ label: "Old owner checks ownership", value: on, onChange: v => { on = v; restart(); } });
    const stage = h("div");
    const stats = ui.stats([
      { key: "hops", label: "Hops (last request)" }, { key: "wrong", label: "Wrong-node requests" },
      { key: "v8", label: "Who has v8" }, { key: "lost", label: "Lost writes" },
    ]);
    const legend = ui.legend([
      { color: V("c6"), label: "request" }, { color: V("ok"), label: "reply from the owner" },
      { color: V("bad"), label: "redirect / rejected / wrong answer" },
      { color: V("warn"), label: "partition data copy or OK from an old copy" }, { color: V("c5"), label: "map update" },
    ]);
    root.append(ui.bar(seg, tog), stage, stats);

    // ---------- geometry ----------
    const ctr = e => (e.r ? [e.x, e.y] : [e.x + e.w / 2, e.y + e.h / 2]);
    // Node boxes dock on the side facing the rest of the scene: left edge (desktop), top edge (phone).
    const dock = (L, e) => (L.col ? [e.x - 4, e.y + e.h / 2] : [e.x + e.w / 2, e.y - 4]);
    function rim(e, [tx, ty]) {
      const [cx, cy] = ctr(e), dx = tx - cx, dy = ty - cy, d = Math.hypot(dx, dy) || 1;
      if (e.r) return [cx + (dx / d) * (e.r + 4), cy + (dy / d) * (e.r + 4)];
      const k = Math.min((e.w / 2 + 4) / (Math.abs(dx) || 1e-6), (e.h / 2 + 4) / (Math.abs(dy) || 1e-6));
      return [cx + dx * k, cy + dy * k];
    }
    // Paths are quadratic curves {p0, c, p1}; a straight line has c on the segment.
    const qpt = (p, t) => {
      const u = 1 - t;
      return [0, 1].map(i => u * u * p.p0[i] + 2 * u * t * p.c[i] + t * t * p.p1[i]);
    };
    const pathD = p => `M${p.p0.join(",")} Q${p.c.join(",")} ${p.p1.join(",")}`;
    function collisions(st, p, skip) {
      let n = 0;
      for (const id in st.el) {
        if (skip.includes(id)) continue;
        const e = st.el[id], pad = 9;
        const box = e.r ? [e.x - e.r - pad, e.y - e.r - pad, e.x + e.r + pad, e.y + e.r + pad]
          : [e.x - pad, e.y - pad, e.x + e.w + pad, e.y + e.h + pad];
        for (let i = 1; i < 24; i++) {
          const [x, y] = qpt(p, i / 24);
          if (x > box[0] && x < box[2] && y > box[1] && y < box[3]) n++;
        }
      }
      return n;
    }
    // Straight where possible, bent around any box in the way; node-to-node hops arc outside the nodes.
    function route(st, a, b) {
      const L = st.L, A = st.el[a], B = st.el[b];
      if (A.node && B.node) {
        const di = B.i - A.i, dir = Math.sign(di), bend = 2 * (26 + 16 * Math.abs(di));
        if (L.col) {
          const x = A.x - 4, y0 = ctr(A)[1] + dir * A.h * 0.22, y1 = ctr(B)[1] - dir * B.h * 0.22;
          return { p0: [x, y0], c: [x - bend, (y0 + y1) / 2], p1: [x, y1] };
        }
        const y = A.y - 4, x0 = ctr(A)[0] + dir * A.w * 0.22, x1 = ctr(B)[0] - dir * B.w * 0.22;
        return { p0: [x0, y], c: [(x0 + x1) / 2, y - bend], p1: [x1, y] };
      }
      const pa = A.node ? dock(L, A) : ctr(A), pb = B.node ? dock(L, B) : ctr(B);
      const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1;
      const nx = -(pb[1] - pa[1]) / len, ny = (pb[0] - pa[0]) / len;
      let best = null;
      for (const off of [0, 50, -50, 100, -100, 150, -150]) {
        const c = [(pa[0] + pb[0]) / 2 + nx * off, (pa[1] + pb[1]) / 2 + ny * off];
        const p = { p0: A.node ? pa : rim(A, c), c, p1: B.node ? pb : rim(B, c) };
        p.n = collisions(st, p, [a, b]);
        if (!best || p.n < best.n) best = p;
        if (!p.n) break;
      }
      return best;
    }

    // ---------- animation (every await goes through guard: a rebuilt scene parks stale steps) ----------
    const guard = (st, p) => p.then(v => (st.gen === gen ? v : new Promise(() => {})));
    const sleep = (st, ms) => guard(st, ctx.sleep(ms));
    function fly(st, a, b, label, color, o = {}) {
      const p = o.path || route(st, a, b), r = o.r || 7, t0 = o.from || 0, t1 = o.to || 1;
      const g = s("g", { class: "viz-packet" });
      const dot = paint(s("circle", { r, "stroke-width": 1.5 }), { fill: V(color), stroke: V("bg") });
      g.label = ctx.text(0, -r - 8, label, { size: st.L.fs, weight: 700, halo: true });
      if (color === "bad") paint(g.label, { fill: V("bad") });
      g.append(dot, g.label);
      // A faint trail shows the whole hop while the packet travels it.
      const trail = paint(s("path", { d: pathD(p), fill: "none", "stroke-width": 2.2, "stroke-linecap": "round", opacity: 0.4 }), { stroke: V(color) });
      st.trail.appendChild(trail);
      st.pk.appendChild(g);
      const place = k => {
        const [x, y] = qpt(p, t0 + (t1 - t0) * k);
        g.setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)})`);
      };
      place(0);
      return guard(st, ctx.tween({ ms: (o.ms || 600) * (t1 - t0), onUpdate: place }))
        .then(() => { trail.remove(); if (!o.keep) g.remove(); g.path = p; return g; });
    }
    // A fading ring that points at what just changed (skipped during instant replay).
    function glow(st, el, tone) {
      if (ctx.instant || !el || !el.isConnected) return;
      let b;
      try { b = el.getBBox(); } catch (e) { return; }
      if (!b.width) return;
      const r = paint(s("rect", { x: b.x - 4, y: b.y - 3, width: b.width + 8, height: b.height + 6, rx: 5, "stroke-width": 2 }),
        { fill: V(tone + "-soft"), stroke: V(tone) });
      st.fx.appendChild(r);
      ctx.tween({ ms: 1600, ease: "in", onUpdate: k => r.setAttribute("opacity", (1 - k).toFixed(3)) }).then(() => r.remove());
    }

    // ---------- scene pieces ----------
    function T(st, x, y, str, o = {}) {
      const t = ctx.text(x, y, str, { size: o.size || st.L.fs, anchor: o.anchor, weight: o.weight, mono: o.mono, halo: o.halo });
      if (o.fill) paint(t, { fill: o.fill });
      (o.layer || st.scene).appendChild(t);
      return t;
    }
    // Partition chip; c.set(label, kind) restyles it in place (kind: plain | p3 | copying | old).
    function chip(st, x, y, label, kind, hh) {
      const L = st.L, c = s("g");
      const rect = s("rect", { y: y - hh / 2, height: hh, rx: 4, "stroke-width": 1.3 });
      const txt = ctx.text(0, y + 0.5, "", { size: L.fs, mono: true, weight: 600 });
      const strike = s("line", { y1: y, y2: y, "stroke-width": 2 });
      c.append(rect, txt, strike);
      c.set = (lab, k) => {
        const w = lab.length * L.fs * 0.6 + 10, sty = CHIP[k];
        c.w = w;
        ctx.attr(rect, { x, width: w });
        ctx.attr(txt, { x: x + w / 2 });
        ctx.attr(strike, { x1: x - 3, x2: x + w + 3 });
        txt.textContent = lab;
        paint(rect, { fill: V(sty.fill), stroke: V(sty.stroke) });
        rect.setAttribute("stroke-dasharray", sty.dash ? "4 3" : "none");
        paint(strike, { stroke: V("ink") });
        strike.style.display = sty.strike ? "" : "none";
        c.setAttribute("opacity", sty.strike ? 0.4 : 1);
        return c;
      };
      st.scene.appendChild(c);
      return c.set(label, kind);
    }
    function drawNode(st, key, i) {
      const L = st.L, [x, y] = L.nodes[i], w = L.nw, R = mode === "gossip" ? L.rowsG : L.rows;
      st.scene.appendChild(ctx.box({ x, y, w, h: L.nh, fill: V("node"), stroke: V("node-stroke") }));
      st.el[key] = { x, y, w, h: L.nh, node: true, i };
      const nd = { val: null };
      T(st, x + L.pad, y + R.title, key === "C" ? "Node C (new)" : "Node " + key, { size: L.ts, weight: 700, anchor: "start" });
      let cx = x + L.pad;
      ({ A: ["P0", "P1", "P2"], B: ["P3", "P4", "P5"], C: ["P3"] })[key].forEach(p => {
        const c = chip(st, cx, y + R.chips, p, p === "P3" ? "p3" : "plain", R.chipH);
        if (p === "P3") nd.p3 = c;
        cx += c.w + L.gap;
      });
      if (key === "C") {
        nd.p3.style.display = "none";
        nd.none = T(st, x + L.pad, y + R.chips, "no partitions yet", { anchor: "start", fill: V("muted") });
      }
      if (mode === "gossip") {
        nd.map = T(st, x + L.pad, y + R.map, "", { mono: true, anchor: "start" });
        // A stale view is flagged in the title row: "(stale)" does not fit beside the map on phones.
        nd.map.tag = T(st, x + w - L.pad, y + R.title, "stale", { anchor: "end", weight: 700, fill: V("bad") });
      }
      nd.val = T(st, x + L.pad, y + R.val, key === "B" ? L.val("free") : "", { mono: true, anchor: "start" });
      if (key === "B") {
        nd.old = T(st, x + w - L.pad, y + R.title, L.oldTag, { anchor: "end", fill: V("muted") });
        nd.old.style.display = "none";
      }
      st.n[key] = nd;
    }
    function guideLine(st, a, b, o = {}) {
      const p = route(st, a, b);
      const el = s("path", { d: pathD(p), fill: "none", "stroke-width": o.dash ? 1.6 : 1.5, "stroke-dasharray": o.dash ? "5 4" : null });
      st.guide.appendChild(paint(el, { stroke: V(o.color || "grid") }));
      return p;
    }
    function drawScene(st) {
      const L = st.L, c = L.coord, [kx, ky] = L.keyAt;
      T(st, kx, ky, "hash(key) → partition", { anchor: "start", fill: V("muted") });
      T(st, kx, ky + L.keyDy, "user:77 →", { anchor: "start", mono: true });
      chip(st, kx + 9 * L.fs * 0.6 + 6, ky + L.keyDy, "P3", "p3", L.rows.chipH);
      if (mode === "gossip") {
        T(st, L.noteAt[0], L.noteAt[1], "no coordinator: nodes gossip", { fill: V("muted") });
      } else {
        st.scene.appendChild(ctx.box({ x: c.x, y: c.y, w: c.w, h: c.h, fill: V("c5-soft"), stroke: V("c5") }));
        T(st, c.x + c.w / 2, c.y + c.ty, c.title, { size: L.bs, weight: 700 });
        st.lines.coord = T(st, c.x + c.w / 2, c.y + c.ly, "", { mono: true });
        st.el.coord = { x: c.x, y: c.y, w: c.w, h: c.h };
      }
      if (mode === "router") {
        const r = L.router;
        st.scene.appendChild(ctx.box({ x: r.x, y: r.y, w: r.w, h: r.h, fill: V("c8-soft"), stroke: V("c8") }));
        T(st, r.x + r.w / 2, r.y + r.ty, "Router", { size: L.bs, weight: 700 });
        st.lines.router = T(st, r.x + r.w / 2, r.y + r.ly, "", { mono: true });
        st.el.router = { x: r.x, y: r.y, w: r.w, h: r.h };
      }
      const cl = L.client;
      st.scene.appendChild(ctx.node({ x: cl.x, y: cl.y, r: cl.r, label: "Client", size: L.cs, fill: V("c6-soft"), stroke: V("c6") }));
      st.el.client = { x: cl.x, y: cl.y, r: cl.r };
      const own = mode === "client";
      const mapLine = T(st, L.mapAt[0], L.mapAt[1], own ? "" : "no map", { mono: own, halo: true, fill: own ? null : V("muted") });
      if (own) st.lines.client = mapLine;
      ["A", "B", "C"].forEach((k, i) => drawNode(st, k, i));
      ["A", "B", "C"].forEach(k => { if (st.n[k].map) st.lines[k] = st.n[k].map; });
      Object.keys(st.lines).forEach(k => setMap(st, k, "B", 7));
      // Faint request paths, plus the router's watch on the coordinator.
      const hub = mode === "router" ? "router" : "client";
      if (mode === "router") {
        guideLine(st, "client", "router");
        // The label sits near the router so the held notification (parked mid-way) never covers it.
        const p = guideLine(st, "router", "coord", { dash: true, color: "c5" }), [mx, my] = qpt(p, 0.25);
        T(st, mx - 10, my, "watch", { anchor: "end", fill: V("c5"), layer: st.guide });
      }
      ["A", "B", "C"].forEach(k => guideLine(st, hub, k));
    }

    // ---------- state changes (synchronous: each step ends in a fully applied state) ----------
    function setMap(st, who, owner, v, tone) {
      const el = st.lines[who];
      st.ver[who] = v;
      const stale = tone === "bad";
      el.textContent = `P3 → ${owner} v${v}` + (stale && !el.tag ? " (stale)" : "");
      paint(el, { fill: V(tone || "ink") });
      if (el.tag) el.tag.style.display = stale ? "" : "none";
      showStats(st);
    }
    function setVal(st, key, v, tone) {
      const el = st.n[key].val;
      el.textContent = st.L.val(v);
      paint(el, { fill: V(tone || "ink") });
      if (tone === "ok" || tone === "bad") glow(st, el, tone);
    }
    const claim = st => { st.n.C.p3.set("P3", "p3"); setVal(st, "C", "free"); };
    function release(st) {
      st.cut = true;
      st.n.B.p3.set("P3", "old");
      st.n.B.old.style.display = "";
      setVal(st, "B", "free", "muted");
    }
    function showStats(st) {
      const hold = MODES[mode].holders, have = hold.filter(k => st.ver[k] === 8);
      const tone = (v, good) => (v === null ? "" : good ? "ok" : "bad");
      stats.set("hops", st.hops === null ? "–" : st.hops, st.hops === null ? "" : st.hops <= 2 ? "ok" : "warn");
      stats.set("wrong", st.wrong, tone(st.wrong, !st.wrong));
      stats.set("v8", have.length ? `<span style="font-size:15px">${have.map(k => NAMES[k]).join(", ")}</span>` : "–",
        !have.length ? "" : have.length === hold.length ? "ok" : "warn");
      stats.set("lost", st.lost === null ? "–" : st.lost, tone(st.lost, !st.lost));
    }

    // ---------- story building blocks ----------
    // Forward legs of one request: counts hops, and arrivals at B after it gave up P3.
    // park: leave the last packet at its destination until the next reply (client mode, step 5 -> 6).
    async function request(st, ids, label, fresh, park) {
      if (fresh) st.hops = 0;
      for (let i = 1; i < ids.length; i++) {
        const g = await fly(st, ids[i - 1], ids[i], label, "c6", { keep: park && i === ids.length - 1 });
        if (park && i === ids.length - 1) st.parked = g;
        st.hops++;
        if (ids[i] === "B" && st.cut) { st.wrong++; glow(st, st.n.B.old, "bad"); }
        showStats(st);
      }
    }
    async function reply(st, ids, label, color) {
      if (st.parked) { st.parked.remove(); st.parked = null; }
      for (let i = 1; i < ids.length; i++) await fly(st, ids[i - 1], ids[i], label, color);
    }
    async function copyP3(st) {
      const C = st.n.C;
      C.none.style.display = "none";
      C.p3.style.display = "";
      C.p3.set("P3 copying…", "copying");
      await fly(st, "B", "C", "P3 data", "warn", { r: 9, ms: 1400 });
      C.p3.set("P3 copied", "copying");
      setVal(st, "C", "free", "muted");
    }
    // Client and router modes: the coordinator flips the map and tells B and C; in router mode the
    // router's notification is held mid-way (st.held) until step 6.
    async function announce(st, holdRouter) {
      setMap(st, "coord", "C", 8, "ok");
      glow(st, st.lines.coord, "ok");
      const flights = [fly(st, "coord", "B", "v8", "c5"), fly(st, "coord", "C", "v8", "c5")];
      if (holdRouter) flights.push(fly(st, "coord", "router", "v8", "c5", { to: 0.5, ms: 1200, keep: true }));
      const done = await Promise.all(flights);
      if (holdRouter) { st.held = done[2]; st.held.label.textContent = "v8 (in flight)"; }
      claim(st);
      release(st);
    }
    async function deliverHeld(st) {
      st.held.remove();
      await fly(st, "coord", "router", "v8", "c5", { path: st.held.path, from: 0.5, ms: 1200 });
      setMap(st, "router", "C", 8, "ok");
      glow(st, st.lines.router, "ok");
    }
    async function orphanWrite(st, back) {
      setVal(st, "B", "pro", "bad");
      await reply(st, back, "ok", "warn");
    }
    async function refreshClient(st) {
      await fly(st, "coord", "client", "v8", "c5");
      setMap(st, "client", "C", 8, "ok");
      glow(st, st.lines.client, "ok");
    }
    async function pointAt(st, els) {
      els.forEach(el => glow(st, el, "c3"));
      await sleep(st, 900);
    }

    function stepsFor(m, on) {
      const entry = { client: ["client"], router: ["client", "router"], gossip: ["client", "A"] }[m];
      const to = k => [...entry, k], from = k => [k, ...[...entry].reverse()];
      const read = async (st, k, val, tone) => {
        await request(st, to(k), "get", true);
        await reply(st, from(k), "plan=" + val, tone);
      };
      const finish = st => { st.lost = on ? 0 : 1; showStats(st); if (!on) glow(st, st.n.B.val, "bad"); };
      const finalRead = path => ({
        title: `<b>get(user:77)</b>: ${path} returns <b>plan=${on ? "pro" : "free"}</b>` + (on ? "." : ": the acknowledged write is lost."),
        detail: on ? "With the ownership check, the stale map cost a retry, not data." : "B's copy of P3 holds plan=pro, but nobody reads it and it will be deleted.",
        run: async st => { await read(st, "C", on ? "pro" : "free", on ? "ok" : "bad"); finish(st); },
      });
      const second = {
        title: m === "client" ? "<b>get(user:77)</b> goes straight to B: one round trip."
          : m === "router" ? "<b>get(user:77)</b>: client → router → B → router → client. Clients stay simple; every request pays an extra hop."
            : "A load balancer sends <b>get(user:77)</b> to node A. A doesn't own P3, so it forwards to B and relays the answer.",
        run: st => read(st, "B", "free", "ok"),
      };
      const copy = {
        title: "Node C joins. P3 is copied from B to C while B keeps serving it.",
        detail: "The old owner stays authoritative until cut-over, so nothing is unavailable during the copy.",
        run: copyP3,
      };
      const writeC = async (st, path, back, fresh) => {
        await request(st, path, "set", fresh);
        setVal(st, "C", "pro", "ok");
        await reply(st, back, "ok", "ok");
      };

      if (m === "client") return [
        { title: "The client has cached the map: <b>user:77</b> hashes to P3, and P3 lives on node B (v7).",
          run: st => pointAt(st, [st.lines.client, st.n.B.p3]) },
        second, copy,
        { title: "Cut-over: the coordinator now says P3 → C (v8), and B stops owning P3. The client's cache still says v7.",
          detail: "Nobody pushed the change to the client; it finds out on its next request.",
          run: async st => { await announce(st); setMap(st, "client", "B", 7, "bad"); glow(st, st.lines.client, "bad"); } },
        { title: "The client writes <b>set(user:77, plan=pro)</b> using its stale map, so the write goes to B.",
          run: st => request(st, ["client", "B"], "set", true, true) },
        on ? { title: "B no longer owns P3, so it refuses with a redirect naming C instead of applying the write.",
          detail: "Redis Cluster answers <code>-MOVED</code> with the new owner; Kafka brokers answer “not leader” and the client refreshes its metadata.",
          run: st => reply(st, ["B", "client"], "MOVED", "bad") }
          : { title: "B does not check whether it still owns P3: it applies plan=pro to its old copy and replies OK.",
            detail: "From the client's point of view, the write succeeded.",
            run: st => orphanWrite(st, ["B", "client"]) },
        on ? { title: "The client refreshes its map (v8) and retries at C, which applies plan=pro. Reading user:77 from C returns <b>plan=pro</b>.",
          detail: "With the ownership check, the stale cache cost one extra round trip, not data.",
          run: async st => {
            await refreshClient(st);
            await writeC(st, ["client", "C"], ["C", "client"]);
            await sleep(st, 250);
            await read(st, "C", "pro", "ok");
            finish(st);
          } }
          : { title: "Later the client refreshes its map (v8) and reads from C: <b>plan=free</b>. The acknowledged write sits in a copy nobody reads and will be deleted: a lost write.",
            detail: "This is why the old owner must check ownership (an epoch or version on every request, like Chapter 8's fencing tokens).",
            run: async st => { await refreshClient(st); await read(st, "C", "free", "bad"); finish(st); } },
      ];

      if (m === "router") return [
        { title: "The router watches the coordinator's partition map (P3 → B, v7). Clients only know the router's address.",
          run: st => pointAt(st, [st.lines.coord, st.lines.router, st.n.B.p3]) },
        second, copy,
        { title: "Cut-over: the coordinator's map becomes P3 → C (v8) and a change notification starts toward the router…",
          detail: "Notifications are asynchronous, so for a moment the router's copy is stale.",
          run: async st => { await announce(st, true); setMap(st, "router", "B", 7, "bad"); glow(st, st.lines.router, "bad"); } },
        on ? { title: "<b>set(user:77, plan=pro)</b> arrives first. The router still uses v7 and forwards it to B, which rejects it: it no longer owns P3.",
          detail: "MongoDB shards reject operations tagged with a stale routing version; the router then refreshes.",
          run: async st => { await request(st, ["client", "router", "B"], "set", true); await reply(st, ["B", "router"], "stale", "bad"); } }
          : { title: "<b>set(user:77, plan=pro)</b> arrives first. The router still uses v7 and forwards it to B, which does not check ownership: it applies the write to its old copy and replies OK.",
            detail: "From the client's point of view, the write succeeded.",
            run: async st => { await request(st, ["client", "router", "B"], "set", true); await orphanWrite(st, ["B", "router", "client"]); } },
        on ? { title: "The router refreshes its map (v8) and retries at C, which applies the write. The client only sees a little extra latency.",
          run: async st => { await deliverHeld(st); await writeC(st, ["router", "C"], ["C", "router", "client"]); } }
          : { title: "The held notification arrives and the router now sends P3 traffic to C. Nobody noticed that B accepted a write for a partition it had handed over.",
            run: deliverHeld },
        finalRead("client → router → C"),
      ];

      return [
        { title: "No coordinator: every node keeps its own copy of the map and swaps updates with peers. Right now all agree: P3 → B (v7).",
          run: st => pointAt(st, [st.lines.A, st.lines.B, st.lines.C]) },
        second, copy,
        { title: "C takes over P3 and gossips “P3 → C (v8)”. B hears first; A has not heard yet.",
          detail: "Each node changes its view when the gossip reaches it, not all at once.",
          run: async st => {
            setMap(st, "C", "C", 8, "ok");
            claim(st);
            await fly(st, "C", "B", "v8", "c5");
            setMap(st, "B", "C", 8, "ok");
            release(st);
            setMap(st, "A", "B", 7, "bad");
            glow(st, st.lines.A, "bad");
          } },
        on ? { title: "<b>set(user:77, plan=pro)</b> lands on A, which forwards it to B using its stale view. B knows it handed P3 to C, so it forwards once more instead of applying the write; C applies it.",
          detail: "An extra hop instead of an error.",
          run: st => writeC(st, ["client", "A", "B", "C"], ["C", "A", "client"], true) }
          : { title: "<b>set(user:77, plan=pro)</b> lands on A, which forwards it to B using its stale view. B does not check ownership: it applies the write to its old copy instead of forwarding it.",
            detail: "From the client's point of view, the write succeeded.",
            run: async st => { await request(st, ["client", "A", "B"], "set", true); await orphanWrite(st, ["B", "A", "client"]); } },
        { title: "Gossip reaches A: every node now has v8. Gossip converges within a few rounds: no extra system to run, but no single instant when everyone is known to agree.",
          run: async st => { await fly(st, "B", "A", "v8", "c5"); setMap(st, "A", "C", 8, "ok"); glow(st, st.lines.A, "ok"); } },
        finalRead("client → A → C"),
      ];
    }

    // ---------- assembly ----------
    function build() {
      compact = ctx.compact;
      const L = compact ? PHONE : DESK, M = MODES[mode], myGen = gen;
      const svg = ctx.svg({ w: L.w, h: L.h, label: "Request routing while partition P3 moves from node B to node C" });
      const layers = {};
      ["guide", "scene", "fx", "trail", "pk"].forEach(k => svg.appendChild((layers[k] = s("g"))));
      const pl = ctx.stepper({
        delay: 1600,
        intro: M.intro + (on ? " Press <b>Play</b>." : " In this run the old owner does <b>not</b> check ownership. Press <b>Play</b>."),
        steps: stepsFor(mode, on),
        // Fully redraws the scene: Back = init() + instant replay.
        init() {
          Object.values(layers).forEach(g => g.replaceChildren());
          const st = { gen: myGen, L, ...layers, el: {}, n: {}, lines: {}, ver: {}, hops: null, wrong: 0, lost: null, cut: false, held: null, parked: null };
          drawScene(st);
          showStats(st);
          return st;
        },
        onStep: () => { if (myGen === gen) showStats(pl.state); },
      });
      player = pl;
      stage.replaceChildren(svg, legend, pl.el);
    }

    function restart(keepStep) {
      const idx = keepStep && player ? player.index : -1;
      gen++;
      if (player) player.pause();
      ctx.instant = true; // finish the old scene's in-flight tweens now; guard() parks its step
      build();
      const p = player;
      ctx.after(0, () => { ctx.instant = false; if (idx >= 0 && p === player) p.goto(idx); });
    }

    build();
    // Rebuild outside the ResizeObserver callback, keeping the current step.
    ctx.onResize(() => ctx.after(0, () => { if (ctx.compact !== compact) restart(true); }));
  },
});
