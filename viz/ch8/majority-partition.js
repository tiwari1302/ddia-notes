// Majority quorums under network partitions. Tap nodes to split the cluster into islands or crash
// them, then send client writes into every island. With "Require a majority" on, only an island
// holding q = floor(n/2) + 1 of ALL n configured votes can elect a leader and accept writes, and
// two islands can never both reach q. With it off, every island trusts its own judgment: split
// brain, and acknowledged writes are thrown away when the network heals.
Viz.register("ch8/majority-partition", {
  title: "Who gets to decide?",
  mount(root, ctx) {
    const { s, h, ui } = ctx;

    // <model> Pure cluster model, no DOM (a dev check evaluates this block headlessly).
    const ISL = ["A", "B", "C"];
    const quorum = n => Math.floor(n / 2) + 1;
    const PRESET_N = { even: 4 };   // every other preset runs on 5 nodes
    const tolerated = n => Math.floor((n - 1) / 2);
    // Three sites as even as possible, larger first: 3 -> 1+1+1, 4 -> 2+1+1, 5 -> 2+2+1, 7 -> 3+2+2.
    const siteSizes = n => { const b = Math.floor(n / 3), r = n % 3; return [b + (r > 0 ? 1 : 0), b + (r > 1 ? 1 : 0), b]; };
    const voter = nd => !nd.crashed && !nd.semi;   // a node whose votes actually reach someone
    const longest = hists => hists.reduce((best, x) => (x.length > best.length ? x : best), []);

    function presetNodes(key, n) {
      const q = quorum(n);
      const nodes = Array.from({ length: n }, () => ({ island: "A", crashed: false, semi: false, site: null, hist: [] }));
      let next = 0;
      const sites = siteSizes(n).map(size => Array.from({ length: size }, () => next++));
      if (key === "clean") nodes.forEach((nd, i) => { nd.island = i >= 1 && i <= q ? "A" : "B"; });
      if (key === "isolated") nodes[0].island = "B";
      if (key === "three") sites.forEach((g, k) => g.forEach(i => { nodes[i].island = ISL[k]; }));
      if (key === "even") nodes.forEach((nd, i) => { nd.island = i < n / 2 ? "A" : "B"; });
      if (key === "semi") nodes[0].semi = true;
      if (key === "crashed2") nodes.slice(-2).forEach(nd => { nd.crashed = true; });
      if (key === "dc2") nodes.forEach((nd, i) => { nd.crashed = i < Math.ceil(n / 2); nd.site = nd.crashed ? "DC1" : "DC2"; });
      if (key === "dc3") sites.forEach((g, k) => g.forEach(i => { nodes[i].site = "DC" + (k + 1); nodes[i].crashed = k === 0; }));
      return nodes;
    }

    function makeCluster() {
      const c = { n: 5, majority: true, nodes: [], leaders: [], stale: [], deciding: null, acked: [], nextV: 1, rejects: {} };
      const ids = () => c.nodes.map((_, i) => i);
      const believes = i => c.leaders.includes(i) || c.stale.includes(i);
      c.members = isl => ids().filter(i => !c.nodes[i].crashed && c.nodes[i].island === isl);
      c.strength = isl => c.nodes.filter(nd => voter(nd) && nd.island === isl).length;
      c.lost = () => c.acked.filter(v => !c.nodes.some(nd => nd.hist.includes(v)));

      function elect() {
        const nodes = c.nodes, q = quorum(c.n);
        const was = c.leaders.filter(i => !nodes[i].crashed);
        // Acting leaders come first, so a stale ex-leader never outranks the real one.
        const believers = [...new Set([...was, ...c.stale.filter(i => !nodes[i].crashed)])];
        if (c.majority) {
          const dec = ISL.find(isl => c.strength(isl) >= q) || null;
          const inDec = i => !!dec && voter(nodes[i]) && nodes[i].island === dec;
          let L = was.find(inDec);
          if (L === undefined && dec) L = ids().find(inDec);
          c.leaders = L === undefined ? [] : [L];
          c.stale = believers.filter(i => i !== L && !inDec(i)).sort((a, b) => a - b);
          c.deciding = dec;
          return;
        }
        // No rule: each island follows a believer it can hear or elects its lowest node, and an
        // unheard (semi) believer simply keeps believing.
        const leaders = believers.filter(i => nodes[i].semi);
        for (const isl of ISL) {
          const group = ids().filter(i => voter(nodes[i]) && nodes[i].island === isl);
          if (group.length) leaders.push(believers.find(i => group.includes(i)) ?? group[0]);
        }
        c.leaders = leaders.sort((a, b) => a - b);
        c.stale = [];
        c.deciding = null;
      }

      // Followers copy the log of the leader they hear. Under the majority rule the leader first
      // takes the longest log in its majority: every earlier majority shares a node with this one,
      // so that log already holds every acknowledged write.
      function sync() {
        for (const L of c.leaders) {
          const ld = c.nodes[L];
          if (c.majority) ld.hist = longest(c.nodes.filter(nd => voter(nd) && nd.island === ld.island).map(nd => nd.hist)).slice();
          if (ld.semi) continue;   // nobody hears it
          c.nodes.forEach((nd, i) => { if (!nd.crashed && nd.island === ld.island && !believes(i)) nd.hist = ld.hist.slice(); });
        }
      }
      const settle = () => { elect(); sync(); };
      function clearWrites() {
        c.nodes.forEach(nd => { nd.hist = []; });
        c.acked = []; c.nextV = 1; c.rejects = {};
      }

      // Each preset brings its own cluster size (Even split needs an even one); pass n to
      // replay the same preset at another size.
      c.reset = (key, n) => {
        c.n = n || PRESET_N[key] || 5;
        c.nodes = presetNodes(key, c.n);
        c.leaders = [0];   // N1 led the healthy cluster before the fault
        c.stale = [];
        clearWrites();
        settle();
      };
      // Tap cycles A -> B -> C -> crashed -> A. A crashed node forgets that it led.
      c.tap = i => {
        const nd = c.nodes[i];
        if (nd.crashed) { nd.crashed = false; nd.island = "A"; }
        else if (nd.island === "C") nd.crashed = true;
        else nd.island = ISL[ISL.indexOf(nd.island) + 1];
        nd.semi = false;
        c.nodes.forEach(x => { x.site = null; });
        c.rejects = {};
        settle();
      };
      c.setMajority = on => { c.majority = on; clearWrites(); settle(); };
      // One client write per island, sent to the node its clients believe leads (an island's
      // clients may still point at a stale ex-leader), or to its lowest node if nobody claims to.
      c.write = () => {
        const sent = [];
        for (const isl of ISL) {
          const mem = c.members(isl);
          if (!mem.length) continue;
          const claim = mem.filter(believes), targets = claim.length ? claim : [mem[0]], rejected = [];
          targets.forEach((t, k) => {
            const v = c.nextV++, ok = c.leaders.includes(t);
            if (ok) { c.nodes[t].hist.push(v); c.acked.push(v); }
            else rejected.push(`x=${v} to N${t + 1}: rejected, ${c.majority ? "no majority" : "no leader"}`);
            sent.push({ isl, target: t, v, ok, k });
          });
          if (rejected.length) c.rejects[isl] = rejected; else delete c.rejects[isl];
        }
        sync();
        return sent;
      };
      // Everyone alive rejoins island A and one history wins: with the rule, the single (longest)
      // log; without it, the lowest-numbered leader's. Returns how many acked writes this lost.
      c.heal = () => {
        const before = c.lost().length;
        const final = c.majority ? longest(c.nodes.map(nd => nd.hist)) : c.leaders.length ? c.nodes[c.leaders[0]].hist : null;
        let moved = false;
        c.nodes.forEach(nd => {
          if (!nd.crashed && (nd.island !== "A" || nd.semi)) moved = true;
          if (!nd.crashed) nd.island = "A";
          nd.semi = false;
          if (final) nd.hist = final.slice();
        });
        c.rejects = {};
        settle();
        return { lost: c.lost().length - before, moved };
      };
      return c;
    }
    // </model>

    const ISL_COLOR = { A: "c2", B: "c8", C: "c5" };
    const SCENARIOS = [["healthy", "Healthy"], ["clean", "Clean split"], ["isolated", "Leader isolated"],
      ["three", "Three-way split"], ["even", "Even split (4 nodes)"], ["semi", "Node hears but can't speak"],
      ["crashed2", "Two nodes crashed"], ["dc2", "Two datacenters, big one fails"], ["dc3", "Three sites, one fails"],
      ["custom", "Custom"]].map(([value, label]) => ({ value, label }));
    const DESK = { W: 400, H: 300, cx: 200, cy: 150, R: 105, r: 24, fs: 13, small: 12, badge: 9, hit: 30 };
    const PHONE = { W: 360, H: 280, cx: 180, cy: 140, R: 95, r: 21, fs: 12, small: 11, badge: 8, hit: 31 };
    const nm = i => "N" + (i + 1);
    const list = a => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
    const plural = (k, word) => `${k} ${word}${k === 1 ? "" : "s"}`;

    // State lives outside build() so a layout switch (phone <-> desktop) keeps it.
    const cl = makeCluster();
    cl.reset("healthy");
    let scenario = "healthy", healed = null, view = null, compact = ctx.compact;

    function build() {
      root.innerHTML = "";
      compact = ctx.compact;
      const G = compact ? PHONE : DESK;
      const seg = ui.segmented({ label: "Nodes", options: [3, 4, 5, 7], value: cl.n, onChange: v => choose(scenario === "custom" || (scenario === "even" && v % 2) ? "healthy" : scenario, v) });
      const sel = ui.select({ label: "Scenario", options: SCENARIOS, value: scenario, onChange: k => choose(k) });
      const toggle = ui.toggle({ label: "Require a majority", value: cl.majority, onChange: on => { cl.setMajority(on); healed = null; render(); } });
      const svg = ctx.svg({ w: G.W, h: G.H, label: "Cluster nodes in a ring, colored by network island; links join nodes that can talk" });
      const sites = s("g"), links = s("g"), nodesL = s("g"), packets = s("g");
      const cap = ctx.text(12, compact ? 20 : 22, "", { size: G.fs, anchor: "start", weight: 600 });
      const rule = ctx.text(12, G.H - 10, "majority rule: off", { size: G.small, anchor: "start", weight: 700, fill: "var(--viz-bad)" });
      svg.append(sites, links, nodesL, cap, rule, packets);
      const hint = h("div", { class: "muted", style: "font-size:12.5px;line-height:1.4;margin-top:6px" },
        "Tap a node to move it to another island or crash it (A → B → C → crashed → A).");
      const board = h("div");
      const scene = h("div", null, svg, hint, legend());
      const panel = ui.panel("Who can decide?", board);
      if (!compact) { scene.style.flex = "1.35 1 340px"; panel.style.flex = "1 1 260px"; }
      const stats = ui.stats([["maj", "Majority"], ["tol", "Survives"], ["islands", "Islands that can decide"], ["leaders", "Leaders"]]
        .map(([key, label]) => ({ key, label })));
      const note = ui.note("");
      root.append(
        ui.bar(seg, sel),
        ui.bar(toggle, ui.button("Client writes to every island", sendWrites, { kind: "primary" }), ui.button("Heal network", heal, { kind: "ok" })),
        ui.row(scene, panel), stats, note);
      view = { G, seg, sel, svg, sites, links, nodesL, packets, cap, rule, board, stats, note, hits: [] };
      render();
    }

    function legend() {
      const sw = (...kids) => s("svg", { width: 18, height: 14, viewBox: "0 0 18 14", "aria-hidden": "true", style: "flex:none;overflow:visible" }, ...kids);
      const item = (icon, label) => h("span", { class: "viz-legend-item" }, icon, label);
      const ring = (stroke, dash) => s("circle", { cx: 9, cy: 7, r: 5.5, fill: "none", stroke, "stroke-width": 2.2, "stroke-dasharray": dash });
      return h("div", { class: "viz-legend" },
        ...ISL.map(isl => item(sw(s("rect", {
          x: 3, y: 1.5, width: 11, height: 11, rx: 2.5, fill: `var(--viz-${ISL_COLOR[isl]}-soft)`, stroke: `var(--viz-${ISL_COLOR[isl]})`, "stroke-width": 1.5,
        })), "island " + isl)),
        item(sw(ring("var(--viz-c1)")), "leader"),
        item(sw(ring("var(--viz-warn)", "2.6 2")), "stale ex-leader"),
        item(sw(s("circle", { cx: 9, cy: 7, r: 5.5, fill: "var(--viz-grid)", stroke: "var(--viz-muted)", "stroke-width": 1.3 }),
          s("path", { d: "M6.5,4.5L11.5,9.5M11.5,4.5L6.5,9.5", stroke: "var(--viz-muted)", "stroke-width": 1.5 })), "crashed"),
        item(sw(s("path", { d: "M0,7H11", stroke: "var(--viz-warn)", "stroke-width": 1.6, "stroke-dasharray": "3 2" }),
          s("path", { d: "M10,3.5L16,7L10,10.5z", fill: "var(--viz-warn)" })), "one-way link"));
    }

    // ---------------------------------------------------------------- interactions
    // A scenario picks its own node count; the Nodes control replays the current one at size n.
    function choose(key, n) {
      healed = null;
      scenario = key;
      if (key !== "custom") cl.reset(key, n);   // choosing Custom keeps the current arrangement
      if (view) { view.seg.set(cl.n); view.sel.set(key); }
      render();
    }

    function tap(i, byKey) {
      cl.tap(i);
      scenario = "custom";
      healed = null;
      view.sel.set("custom");
      render();
      if (byKey && view.hits[i]) view.hits[i].focus();
    }

    function sendWrites() {
      healed = null;
      const flights = cl.write().map(flyWrite);
      Promise.all(flights).then(() => { if (ctx.alive) render(); });
    }

    function heal() {
      healed = cl.heal();
      if (healed.moved) {
        scenario = cl.nodes.some(nd => nd.crashed) ? "custom" : "healthy";
        view.sel.set(scenario);
      }
      render();
    }

    // ---------------------------------------------------------------- scene
    const angle = i => -Math.PI / 2 + (i * 2 * Math.PI) / cl.n;   // N1 at the top, clockwise
    const at = (a, d) => [view.G.cx + d * Math.cos(a), view.G.cy + d * Math.sin(a)];
    const pos = i => at(angle(i), view.G.R);

    function drawScene() {
      const { G, links, nodesL } = view, nodes = cl.nodes, P = nodes.map((_, i) => pos(i));
      view.sites.innerHTML = links.innerHTML = nodesL.innerHTML = "";
      view.cap.textContent = `majority = ${quorum(cl.n)} of ${cl.n}`;
      view.rule.style.display = cl.majority ? "none" : "";
      drawSites(G);
      for (let i = 0; i < cl.n; i++) {
        for (let j = i + 1; j < cl.n; j++) {
          const a = nodes[i], b = nodes[j];
          if (a.crashed || b.crashed || a.island !== b.island) continue;
          if (a.semi || b.semi) links.appendChild(oneWay(P[a.semi ? j : i], P[a.semi ? i : j]));
          else links.appendChild(s("line", { x1: P[i][0], y1: P[i][1], x2: P[j][0], y2: P[j][1], stroke: "var(--viz-line)", "stroke-width": 1.5 }));
        }
      }
      view.hits = nodes.map((nd, i) => drawNode(nd, i, P[i], G));
    }

    // Datacenter presets: a band behind each site's (adjacent) nodes, labelled outside the ring.
    function drawSites(G) {
      const groups = {};
      cl.nodes.forEach((nd, i) => { if (nd.site) (groups[nd.site] = groups[nd.site] || []).push(i); });
      for (const [site, idx] of Object.entries(groups)) {
        const a0 = angle(idx[0]), a1 = angle(idx[idx.length - 1]), p0 = at(a0, G.R), p1 = at(a1, G.R);
        view.sites.appendChild(s("path", {
          d: idx.length > 1 ? `M${p0}A${G.R},${G.R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p1}` : `M${p0}L${p0}`,
          fill: "none", stroke: "var(--viz-grid)", "stroke-width": 2 * G.r + 18, "stroke-linecap": "round",
        }));
        const [lx, ly] = at((a0 + a1) / 2, G.R + G.r + 20);
        view.sites.appendChild(ctx.text(ctx.clamp(lx, 22, G.W - 22), ctx.clamp(ly, 14, G.H - 8), site,
          { size: G.small, weight: 700, fill: "var(--viz-muted)", halo: true }));
      }
    }

    // Dashed arrow into the semi-connected node: it hears the others, they never hear it.
    function oneWay([x1, y1], [x2, y2]) {
      const { G } = view, d = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / d, uy = (y2 - y1) / d;
      return ctx.arrow({ x1: x1 + ux * (G.r + 3), y1: y1 + uy * (G.r + 3), x2: x2 - ux * (G.r + 9), y2: y2 - uy * (G.r + 9),
        color: "var(--viz-warn)", dashed: true, width: 1.6, svg: view.svg });
    }

    function drawNode(nd, i, [x, y], G) {
      const g = s("g");
      view.nodesL.appendChild(g);
      const lead = cl.leaders.includes(i), stale = cl.stale.includes(i), col = ISL_COLOR[nd.island];
      if (lead || stale) g.appendChild(s("circle", { cx: x, cy: y, r: G.r + 6, fill: "none",
        stroke: lead ? "var(--viz-c1)" : "var(--viz-warn)", "stroke-width": lead ? 3 : 2.5, "stroke-dasharray": stale ? "5 4" : null }));
      const body = ctx.node({ x, y, r: G.r, label: nm(i), size: G.fs, ink: nd.crashed ? "var(--viz-muted)" : null,
        fill: nd.crashed ? "var(--viz-grid)" : `var(--viz-${col}-soft)`, stroke: nd.crashed ? "var(--viz-muted)" : `var(--viz-${col})` });
      if (nd.crashed) {
        const k = G.r * 0.6;
        body.insertBefore(s("path", { d: `M${x - k},${y - k}L${x + k},${y + k}M${x + k},${y - k}L${x - k},${y + k}`,
          stroke: "var(--viz-muted)", "stroke-width": 2.5, opacity: 0.6 }), body.label);
        // A halo in the node's own fill keeps the label readable over the X.
        ctx.attr(body.label, { class: "viz-halo", style: "stroke: var(--viz-grid)" });
      }
      g.appendChild(body);
      if (lead || stale) {
        const bx = x + G.r * 0.74, by = y - G.r * 0.74, tone = lead ? "c1" : "warn";
        g.append(
          s("circle", { cx: bx, cy: by, r: G.badge, fill: "var(--viz-bg)" }),
          s("circle", { cx: bx, cy: by, r: G.badge, fill: `var(--viz-${tone}-soft)`, stroke: `var(--viz-${tone})`, "stroke-width": 1.5 }),
          ctx.text(bx, by + 0.5, "L", { size: G.small, weight: 700 }));
      }
      if (nd.semi && !nd.crashed) {   // only N1 (top) is ever semi, so the right side is free
        g.appendChild(ctx.text(x + G.r + 12, y + 2, "can't be heard", { size: G.small, anchor: "start", weight: 600, fill: "var(--viz-warn)", halo: true }));
      }
      const hit = s("circle", {
        cx: x, cy: y, r: G.hit, fill: "transparent", style: "cursor:pointer", role: "button", tabindex: 0,
        "aria-label": `${nm(i)}, ${nd.crashed ? "crashed" : "island " + nd.island}: tap to move or crash`,
      });
      hit.addEventListener("click", () => tap(i, false));
      hit.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tap(i, true); } });
      g.appendChild(hit);
      return hit;
    }

    // A client's write flies in from outside the island toward the node its clients believe leads.
    function flyWrite(w) {
      const { G, packets } = view;
      const pts = cl.members(w.isl).map(pos);
      let dx = pts.reduce((a, p) => a + p[0], 0) / pts.length - G.cx, dy = pts.reduce((a, p) => a + p[1], 0) / pts.length - G.cy;
      const len = Math.hypot(dx, dy);
      [dx, dy] = len < 12 ? [-0.94, 0.33] : [dx / len, dy / len];
      const d = G.R + 50, off = w.k * 26;   // a second packet into the same island starts beside the first
      const from = [ctx.clamp(G.cx + dx * d - dy * off, 18, G.W - 18), ctx.clamp(G.cy + dy * d + dx * off, 40, G.H - 14)];
      const [tx, ty] = pos(w.target), dd = Math.hypot(tx - from[0], ty - from[1]) || 1;
      const to = [tx - ((tx - from[0]) / dd) * (G.r + 12), ty - ((ty - from[1]) / dd) * (G.r + 12)];
      const label = `x=${w.v}`, r = compact ? 6 : 7;
      const flight = ctx.fly(packets, { from, to, label, fill: "var(--viz-c6)", ms: 600, keep: true, labelSize: G.small, r });
      const g = packets.lastElementChild;
      return flight.then(() => {
        if (!g.isConnected) return;
        const tone = w.ok ? "var(--viz-ok)" : "var(--viz-bad)";
        g.firstChild.style.fill = tone;
        // Put the verdict on the far side of the packet from the node, so it never covers the node.
        const ux = (from[0] - tx) / dd, uy = (from[1] - ty) / dd;
        ctx.attr(g.lastChild, { x: ux * (r + 5), y: uy * (r + 10), "text-anchor": ux < -0.35 ? "end" : ux > 0.35 ? "start" : "middle", style: `fill:${tone}` });
        g.lastChild.textContent = label + (w.ok ? " ✓" : " ✕");
        ctx.sleep(800)
          .then(() => ctx.tween({ ms: 300, onUpdate: t => g.setAttribute("opacity", 1 - t) }))
          .then(() => g.remove());
      });
    }

    // ---------------------------------------------------------------- board
    const fmtHist = hist => (!hist.length ? `<span class="muted">none yet</span>`
      : `<span class="mono" style="color:var(--viz-ok);font-weight:600">${hist.length > 6 ? "…, " : ""}${hist.slice(-6).map(v => "x=" + v).join(", ")}</span>`);

    function islandBadge(votes, nLeaders) {
      if (cl.majority) return votes >= quorum(cl.n) ? ["can decide", "ok"] : ["no majority", "warn"];
      if (!nLeaders) return ["no leader", "muted"];
      if (nLeaders > 1) return [`${nLeaders} leaders`, "bad"];
      if (cl.leaders.length > 1) return ["has its own leader", "bad"];
      return votes >= quorum(cl.n) ? ["can decide", "ok"] : ["decides without a majority", "warn"];
    }

    // n vote cells, the island's voters filled, with a bar after cell q: the majority line.
    function voteBar(votes, c) {
      const q = quorum(cl.n), cells = [];
      for (let k = 0; k < cl.n; k++) {
        if (k === q) cells.push(h("span", { style: "width:2px;height:17px;margin:0 2px;border-radius:1px;background:var(--viz-ink)" }));
        cells.push(h("span", { style: "width:11px;height:11px;border-radius:2px;box-sizing:border-box;" +
          (k < votes ? `background:var(--viz-${c})` : "border:1.5px solid var(--viz-node-stroke)") }));
      }
      return h("span", { style: "display:inline-flex;align-items:center;gap:2px;margin-right:8px", "aria-hidden": "true" }, ...cells);
    }

    function memberHTML(i) {
      if (cl.leaders.includes(i)) return `<b style="color:var(--viz-c1)">${nm(i)}</b> <span class="muted">(leader)</span>`;
      if (cl.stale.includes(i)) return `<b style="color:var(--viz-warn)">${nm(i)}</b> <span class="muted">(stale)</span>`;
      return `<span class="muted">${nm(i)}</span>`;
    }

    function drawBoard() {
      const el = view.board, nodes = cl.nodes, q = quorum(cl.n);
      const line = (html, style) => h("div", { html, style: "font-size:12.5px;line-height:1.45;margin-top:3px;" + (style || "") });
      el.innerHTML = "";
      if (cl.leaders.length > 1) el.appendChild(h("div", { style: "margin-bottom:8px" }, ui.badge(`SPLIT BRAIN: ${cl.leaders.length} leaders`, "bad")));
      if (healed && healed.lost) {
        el.appendChild(line(`Healed: ${plural(healed.lost, "acknowledged write")} from the losing side ${healed.lost > 1 ? "are" : "is"} discarded`,
          "color:var(--viz-bad);font-weight:700;margin:0 0 8px"));
      } else if (healed) el.appendChild(h("div", { style: "margin-bottom:8px" }, ui.badge("healed: nothing lost", "ok")));
      for (const isl of ISL) {
        const mem = cl.members(isl);
        if (!mem.length) continue;
        const votes = cl.strength(isl), c = ISL_COLOR[isl];
        const [text, tone] = islandBadge(votes, mem.filter(i => cl.leaders.includes(i)).length);
        const row = h("div", { style: "padding:8px 0;border-top:1px solid var(--border)" },
          h("div", { style: "display:flex;align-items:center;gap:4px 8px;flex-wrap:wrap;font-size:13px" },
            h("span", { style: `width:12px;height:12px;border-radius:3px;flex:none;background:var(--viz-${c}-soft);border:2px solid var(--viz-${c})` }),
            h("b", null, "Island " + isl), h("span", { html: mem.map(memberHTML).join(" ") })),
          h("div", { style: "display:flex;align-items:center;flex-wrap:wrap;gap:4px 0;margin-top:5px;font-size:12.5px" }, voteBar(votes, c),
            h("span", { html: `<b>${votes} of ${cl.n} votes</b>${cl.majority ? ` <span class="muted">(needs ${q})</span>` : ""}`, style: "margin-right:8px" }),
            h("span", { style: "margin-left:auto" }, ui.badge(text, tone))));
        mem.filter(i => nodes[i].semi).forEach(i => row.appendChild(line(`${nm(i)} can't be heard, so its vote never arrives.`, "color:var(--viz-warn)")));
        // Each island shows the log its leader (or would-be leader) holds.
        const holders = mem.filter(i => cl.leaders.includes(i) || cl.stale.includes(i));
        const logs = holders.length ? holders.map(i => [holders.length > 1 ? nm(i) + " " : "", nodes[i].hist]) : [["", longest(mem.map(i => nodes[i].hist))]];
        logs.forEach(([by, hist]) => row.appendChild(line(`${by}writes: ${fmtHist(hist)}`)));
        (cl.rejects[isl] || []).forEach(t => row.appendChild(line(t, "color:var(--viz-warn)")));
        el.appendChild(row);
      }
      const dead = nodes.map((nd, i) => (nd.crashed ? nm(i) : null)).filter(Boolean);
      const foot = "padding-top:8px;border-top:1px solid var(--border);margin-top:0;";
      if (dead.length) el.appendChild(line(`Crashed: <b>${dead.join(" ")}</b> <span class="muted">(still count toward n = ${cl.n})</span>`, foot));
      const lost = cl.lost();
      if (lost.length) el.appendChild(line(`Acknowledged, then lost: <span class="mono">${lost.map(v => "x=" + v).join(", ")}</span>`, foot + "color:var(--viz-bad);font-weight:600"));
      if (!cl.majority) el.appendChild(line("When the network heals, one side's history must win; here the lowest-numbered leader's.", foot + "color:var(--text-muted)"));
    }

    // ---------------------------------------------------------------- note
    function healNote() {
      const k = healed.lost;
      if (k) return [`Healed: ${plural(k, "acknowledged write")} from the losing side ${k > 1 ? "are" : "is"} discarded. Those clients were told their writes succeeded.`, "bad"];
      if (!cl.majority) return ["Healed: no acknowledged write was lost this time, but only because a single leader accepted writes. Without the majority rule nothing guarantees that.", "warn"];
      const up = cl.nodes.filter(voter).length;
      return cl.leaders.length ? ["Healed: only the majority side ever accepted writes, so there is nothing to reconcile.", "ok"]
        : [`Healed: only the majority side could ever accept writes, so there is nothing to reconcile. But with ${up} of ${cl.n} nodes up there is still no majority.`, "warn"];
    }

    function naiveNote() {
      const n = cl.n, L = cl.leaders, nodes = cl.nodes;
      const tail = " Their histories diverge, and when the network heals one side's acknowledged writes must be thrown away. This is split brain.";
      if (L.length > 1) {
        const semiL = L.filter(i => nodes[i].semi), others = L.filter(i => !nodes[i].semi);
        if (semiL.length) {
          return [`Without the majority rule ${nm(semiL[0])} trusts its own judgment and keeps leading, while the nodes that can't hear it elect ${list(others.map(nm))}. ${L.length > 2 ? "All" : "Both"} accept writes.` + tail, "bad"];
        }
        const isl = others.map(i => nodes[i].island).sort();
        return [`Without the majority rule each island trusts its own judgment: islands ${list(isl)} ${isl.length > 2 ? "each have a leader and all" : "both have a leader and both"} accept writes.` + tail, "bad"];
      }
      if (!L.length) return ["Every node is down, so nobody can decide anything.", "warn"];
      const votes = cl.strength(nodes[L[0]].island);
      if (votes >= quorum(n)) {
        return [`Majority rule off: every node now trusts its own judgment. There is still only one leader, ${nm(L[0])}, so nothing goes wrong yet, but as soon as the network splits each side elects its own. Try Clean split.`, "info"];
      }
      return [`Without the majority rule ${nm(L[0])} leads island ${nodes[L[0]].island} with only ${votes} of ${n} votes. That is safe only if the missing nodes are really dead; if they are merely cut off, they elect a leader of their own and you get split brain.`, "warn"];
    }

    function noteFor() {
      if (healed) return healNote();
      if (!cl.majority) return naiveNote();
      const n = cl.n, q = quorum(n), f = tolerated(n), nodes = cl.nodes, L = cl.leaders.map(nm);
      const islands = ISL.filter(isl => cl.members(isl).length);
      const dead = nodes.filter(nd => nd.crashed).length, semi = nodes.some(nd => nd.semi && !nd.crashed);
      if (scenario === "semi") {
        return [`N1 hears everyone, but nobody hears N1. The others time out, declare it dead and elect ${L[0]}. N1 can notice that nobody acknowledges it, yet it cannot overrule the majority: truth is what the majority decides.`, "warn"];
      }
      if (scenario === "dc2") {
        const k = Math.ceil(n / 2);
        const why = n % 2 ? "With two sites one of them always holds a majority, which makes it a single point of failure for the whole cluster."
          : `With two sites of ${k} the sites tie, so losing either one stops the cluster.`;
        return [`${k} of the ${n} voters lived in DC1, so losing that one datacenter leaves ${n - k}: not a majority, and the cluster stops. ${why} A third site, even one holding just a small tiebreaker node, fixes this.`, "warn"];
      }
      if (scenario === "dc3") {
        if (n === 4) return ["Even across three sites, 4 voters split 2+1+1 lose the majority when the 2-node site fails: another reason to avoid even sizes.", "warn"];
        return [`No site holds a majority, so losing any one site still leaves at least ${n - siteSizes(n)[0]} of ${n} voters and the cluster carries on with leader ${L[0]}.`, "ok"];
      }
      if (islands.length === 1 && !dead && !semi) {
        return [`All ${n} nodes can talk. Every decision needs ${q} votes, so the cluster keeps working with up to ${plural(f, "node")} crashed or cut off. Any two majorities of ${n} nodes share at least one node, so two conflicting decisions can never both win.`, "info"];
      }
      const st = cl.stale.map(nm), one = st.length === 1;
      const pre = !st.length ? "" : one
        ? `${st[0]} is alive and still believes it leads, but it can't collect ${q} acknowledgments, so its belief doesn't count. `
        : `${list(st)} are alive and still believe they lead, but none of them can collect ${q} acknowledgments, so their beliefs don't count. `;
      if (cl.deciding) {
        const k = cl.strength(cl.deciding), many = islands.length > 2;
        if (islands.length > 1) {
          return [pre + `Island ${cl.deciding} has ${k} of ${n} votes and carries on with leader ${L[0]}. The other ${many ? "islands" : "side"} can't reach ${q}, so ${many ? "they refuse" : "it refuses"} writes: ${many ? "their" : "its"} clients see errors, but no conflicting history is created.`, pre ? "warn" : "ok"];
        }
        const gone = nodes.map((nd, i) => (nd.crashed || nd.semi ? nm(i) : null)).filter(Boolean), pl = gone.length > 1;
        const what = semi ? "can't vote right now" : pl ? "have crashed" : "has crashed";
        return [pre + `${list(gone)} ${what}, but ${pl ? "they still count" : "it still counts"} toward n, so every decision still needs ${q} of ${n} votes. The ${k} remaining voters provide ${k === q ? "exactly that" : "enough"}, so leader ${L[0]} carries on.`, pre ? "warn" : "ok"];
      }
      let body = `No island has ${q} votes, so nobody can make decisions: safe, but unavailable until ${islands.length > 1 ? "the network heals" : "enough nodes come back"}.`;
      if (dead) body += ` Crashed nodes still count toward n, so the majority stays ${q} of ${n}.`;
      if (n % 2 === 0) body += ` With ${n} nodes the cluster tolerates only ${plural(f, "failure")}, no better than ${n - 1} nodes.`;
      return [pre + body, "warn"];
    }

    function render() {
      drawScene();
      drawBoard();
      const q = quorum(cl.n), f = tolerated(cl.n), L = cl.leaders;
      const small = t => (t ? ` <span style="font-size:12px;font-weight:600;color:var(--text-muted)">${t}</span>` : "");
      // Without the rule every leader decides; an unheard leader is a group of its own.
      const deciders = cl.majority ? (cl.deciding ? [cl.deciding] : []) : L.map(i => (cl.nodes[i].semi ? nm(i) : cl.nodes[i].island)).sort();
      view.stats.set("maj", `${q} of ${cl.n}`);
      view.stats.set("tol", `any ${plural(f, "failure")}`);
      view.stats.set("islands", deciders.length + small(deciders.join(", ")), deciders.length <= 1 ? "ok" : "bad");
      view.stats.set("leaders", L.length + small(L.map(nm).join(", ")), L.length === 1 ? "ok" : L.length ? "bad" : "warn");
      view.note.set(...noteFor());
    }

    build();
    ctx.onResize(() => { if (ctx.compact !== compact) build(); });
  },
});
