// When failover goes wrong: three scripted stories about promoting a follower.
//  Lost writes: the old leader's unreplicated tail is discarded (unless B was synchronous).
//  Reused IDs:  a lagging follower's auto-increment counter re-issues ids Redis already uses.
//  Split brain: a partitioned (not dead) leader keeps accepting writes, unless it is fenced.
// Log strips share one window of positions per story, so slot i means the same log
// position on every node and gaps show replication lag at a glance.
Viz.register("ch5/failover", {
  title: "When failover goes wrong",
  mount(root, ctx) {
    const { s, ui } = ctx;
    const V = n => `var(--viz-${n})`;
    // Colors always go through style (CSS variables need it); numeric attributes stay attributes.
    const paint = (el, st) => { for (const k in st) el.style.setProperty(k, st[k]); return el; };

    // ---------- layouts: [desktop, phone] ----------
    const LAYOUTS = {
      lost: [
        { w: 640, h: 266, r: 26, cr: 18, font: 12, slot: [34, 22, 4], slots: 5, ringAt: "top",
          client: [90, 101], A: [320, 101], B: [190, 196], C: [450, 196], side: { A: 1, B: -1, C: 1 } },
        { w: 360, h: 260, r: 22, cr: 16, font: 11, slot: [30, 20, 3], slots: 5, ringAt: "top",
          client: [42, 94], A: [200, 94], B: [95, 199], C: [270, 199], side: { A: 1, B: -1, C: 1 } },
      ],
      ids: [
        { w: 640, h: 284, r: 26, cr: 18, font: 12, slot: [40, 30, 4], slots: 5, first: 1001, roleDy: -9,
          alice: [60, 89], bob: [60, 209], DB1: [215, 89], DB2: [215, 209], side: { DB1: 1, DB2: 1 },
          redis: { x: 400, y: 79, w: 225, h: 140 }, entryY: 152, entryDy: 25,
          toRedis: "M76,96 Q215,174 400,144", toBob: "M400,154 Q215,159 79,204", leakAt: [262, 149] },
        { w: 360, h: 294, r: 22, cr: 16, font: 11, slot: [38, 30, 4], slots: 3, first: 1003, roleDy: -15,
          alice: [34, 96], bob: [34, 221], DB1: [112, 96], DB2: [112, 221], side: { DB1: 1, DB2: 1 },
          redis: { x: 200, y: 71, w: 152, h: 140 }, entryY: 140, entryDy: 22,
          toRedis: "M48,104 Q118,176 200,146", toBob: "M200,158 Q118,166 50,214", leakAt: [150, 152] },
      ],
      split: [
        { w: 640, h: 258, r: 26, cr: 18, font: 12, ringAt: "ne", cut: [320, 130, 228],
          c1: [200, 50], c2: [440, 50], A: [200, 170], B: [440, 170], side: { A: -1, B: 1 } },
        { w: 360, h: 250, r: 22, cr: 16, font: 11, ringAt: "ne", cut: [180, 134, 222],
          c1: [90, 48], c2: [270, 48], A: [90, 165], B: [270, 165], side: { A: -1, B: 1 } },
      ],
    };

    // ---------- persistent controls and panels ----------
    let story = "lost", compact = ctx.compact, player = null, gen = 0;
    const seg = ui.segmented({
      label: "Story", value: story,
      options: [{ value: "lost", label: "Lost writes" }, { value: "ids", label: "Reused IDs" }, { value: "split", label: "Split brain" }],
      onChange: v => { story = v; restart(); },
    });
    const syncT = ui.toggle({ label: "B is a synchronous follower", onChange: () => restart() });
    const fenceT = ui.toggle({ label: "Fencing (STONITH)", onChange: () => restart() });
    const stage = ctx.h("div");
    const stats = ui.stats([{ key: "leaders", label: "Leaders" }, { key: "lost", label: "Acked writes lost" },
      { key: "ext", label: "Outside systems consistent?" }]);
    const log = ui.log({ title: "What happened", height: 110 });
    root.append(ui.bar(seg, syncT, fenceT), stage, stats, log);

    const TONES = { leaders: v => (v === 1 ? "ok" : v === 0 ? "warn" : "bad"), lost: v => (v ? "bad" : "ok"), ext: v => ({ Yes: "ok", No: "bad" }[v] || "") };
    const stat = (key, v) => stats.set(key, v === null ? "—" : v, TONES[key](v));

    // ---------- animation helpers ----------
    // Every await in a step goes through guard(): once the story changes (gen bumps), a stale
    // step never resumes, so the old stepper cannot animate, draw or log over the new story.
    const guard = (st, p) => p.then(v => (st.gen === gen ? v : new Promise(() => {})));
    const at = (st, k) => [st.db[k].x, st.db[k].y];
    const fly = (st, a, b, o = {}) => guard(st, ctx.fly(st.pk, { ms: 650, labelSize: st.L.font, ...o, from: at(st, a), to: at(st, b) }));
    const sleep = (st, ms) => guard(st, ctx.sleep(ms));
    const tween = (st, ms, fn, ease) => guard(st, ctx.tween({ ms, onUpdate: fn, ease }));
    const beat = (st, a, b, lost) => fly(st, a, b, { r: 4, ms: lost ? 700 : 400, fill: V("muted"), lost });
    const tag = (st, x, y, str, tone, anchor) => ctx.text(x, y, str, { size: st.L.font, weight: 700, fill: V(tone), anchor, halo: true });

    // A packet that follows an SVG path (used where a straight flight would cross a node).
    async function along(st, d, o) {
      const path = s("path", { d, fill: "none" });
      const g = s("g", { class: "viz-packet" },
        s("circle", { r: 7, fill: o.fill, stroke: V("bg"), "stroke-width": 1.5 }),
        ctx.text(0, -15, o.label, { size: st.L.font, weight: 600, halo: true }));
      st.pk.append(path, g);
      const len = path.getTotalLength();
      const place = k => { const p = path.getPointAtLength((o.reverse ? 1 - k : k) * len); g.setAttribute("transform", `translate(${p.x},${p.y})`); };
      place(0);
      await tween(st, 900, place);
      path.remove(); g.remove();
    }

    // ---------- scene pieces ----------
    const ROLES = { leader: ["c1-soft", "c1"], follower: ["c2-soft", "c2"], down: ["node", "bad"] };
    function dbNode(st, key, role) {
      const L = st.L, [x, y] = L[key], r = L.r, side = L.side[key];
      const n = ctx.node({ x, y, r, label: key, size: L.font + 2 });
      n.label.classList.add("viz-halo");
      const d = r * 0.55;
      n.cross = paint(s("g", { "stroke-width": 3, "stroke-linecap": "round" },
        s("line", { x1: x - d, y1: y - d, x2: x + d, y2: y + d }), s("line", { x1: x - d, y1: y + d, x2: x + d, y2: y - d })), { stroke: V("bad") });
      n.insertBefore(n.cross, n.label);
      n.roleText = ctx.text(x + side * (r + 12), y + (L.roleDy || 0), "", { size: L.font, weight: 700, anchor: side < 0 ? "end" : "start" });
      n.appendChild(n.roleText);
      addNode(st, key, n, x, y, r);
      setRole(n, role);
      return n;
    }
    function setRole(n, role, text) {
      const [fill, ink] = ROLES[role];
      n.roleName = role;
      paint(n.circle, { fill: V(fill), stroke: V(ink) });
      n.cross.style.display = role === "down" ? "" : "none";
      n.roleText.textContent = text || role;
      paint(n.roleText, { fill: V(ink) });
    }
    function client(st, key, name, above) {
      const [x, y] = st.L[key], r = st.L.cr;
      const n = ctx.node({ x, y, r, fill: V("c6-soft"), stroke: V("c6") });
      n.appendChild(ctx.text(x, y + (above ? -1 : 1) * (r + 12), name, { size: st.L.font, weight: 700, fill: V("c6") }));
      addNode(st, key, n, x, y, r);
    }
    const addNode = (st, key, n, x, y, r) => { Object.assign(n, { x, y, r }); st.nodes.appendChild(n); st.db[key] = n; };
    function link(st, id, a, b, o = {}) {
      unlink(st, id);
      const A = st.db[a], B = st.db[b], len = Math.hypot(B.x - A.x, B.y - A.y);
      const ux = (B.x - A.x) / len, uy = (B.y - A.y) / len;
      const g = s("g");
      g.appendChild(ctx.arrow({ x1: A.x + ux * (A.r + 3), y1: A.y + uy * (A.r + 3), x2: B.x - ux * (B.r + 4), y2: B.y - uy * (B.r + 4),
        color: V(o.color || "line"), dashed: o.dashed, width: o.color ? 2.2 : 1.6, arrow: o.arrow, svg: st.svg }));
      if (o.label) g.appendChild(ctx.text((A.x + B.x) / 2, (A.y + B.y) / 2, o.label, { size: st.L.font, fill: V("muted"), halo: true }));
      st.edges.appendChild(g);
      st.links[id] = g;
    }
    function unlink(st, id) { if (st.links[id]) st.links[id].remove(); delete st.links[id]; }

    // Log strip: L.slots slots for positions first.., drawn above or below the node.
    const KINDS = { empty: [null, "line"], rep: ["c2-soft", "c2"], only: ["warn-soft", "warn"], new: ["c1-soft", "c1"], gone: ["bad", "bad"] };
    function strip(st, key, first, above) {
      const L = st.L, [w, h, gap] = L.slot, n = st.db[key], total = L.slots * w + (L.slots - 1) * gap;
      const y = above ? n.y - n.r - 9 - h : n.y + n.r + 9;
      n.strip = { first, above, y, h, slots: [] };
      for (let i = 0; i < L.slots; i++) {
        const x = n.x - total / 2 + i * (w + gap);
        const rect = s("rect", { x, y, width: w, height: h, rx: 4, "stroke-width": 1.4 });
        const t = ctx.text(x + w / 2, y + h / 2, "", { size: L.font, mono: true, weight: 600 });
        const sub = ctx.text(x + w / 2, y + h * 0.72, "", { size: L.font });
        st.strips.append(rect, t, sub);
        n.strip.slots.push({ x, w, rect, t, sub });
        put(st, key, first + i, "empty");
      }
    }
    function slotOf(st, key, pos) { const sp = st.db[key].strip; return sp.slots[pos - sp.first]; }
    function put(st, key, pos, kind, owner) {
      const sp = st.db[key].strip, sl = slotOf(st, key, pos), [fill, ink] = KINDS[kind];
      paint(sl.rect, { fill: fill ? V(fill) : "none", stroke: V(ink) });
      ctx.attr(sl.rect, { "stroke-dasharray": kind === "empty" ? "3 3" : kind === "only" ? "4 3" : "none", "stroke-width": 1.4 });
      sl.t.textContent = kind === "empty" ? "" : pos;
      sl.t.setAttribute("y", sp.y + sp.h * (owner ? 0.32 : 0.5));
      sl.sub.textContent = owner || "";
      paint(sl.t, { fill: V(kind === "gone" ? "bg" : "ink") });
      paint(sl.sub, { fill: V(kind === "gone" ? "bg" : "muted") });
    }
    // Pop entries out of a log (red, one row further out) and label them "discarded".
    async function eject(st, key, positions) {
      const sp = st.db[key].strip, dy = (sp.above ? -1 : 1) * (sp.h + 10), g = s("g");
      st.overlay.appendChild(g);
      positions.forEach(p => {
        const sl = slotOf(st, key, p);
        g.append(paint(s("rect", { x: sl.x, y: sp.y, width: sl.w, height: sp.h, rx: 4 }), { fill: V("bad"), stroke: V("bad") }),
          ctx.text(sl.x + sl.w / 2, sp.y + sp.h / 2, p, { size: st.L.font, mono: true, weight: 600, fill: V("bg") }));
        put(st, key, p, "empty");
      });
      await tween(st, 500, k => g.setAttribute("transform", `translate(0,${dy * k})`));
      const last = slotOf(st, key, positions[positions.length - 1]);
      g.appendChild(tag(st, last.x + last.w + 7, sp.y + sp.h / 2, "discarded", "bad", "start"));
    }
    // Failure-detector timeout: an amber ring sweeping once around the node.
    function ring(st, key) {
      const n = st.db[key], R = n.r + 7, c = 2 * Math.PI * R, ne = st.L.ringAt === "ne";
      const el = paint(s("circle", { cx: n.x, cy: n.y, r: R, fill: "none", "stroke-width": 3, "stroke-dasharray": c, "stroke-dashoffset": c,
        transform: `rotate(-90 ${n.x} ${n.y})` }), { stroke: V("warn") });
      const t = tag(st, ne ? n.x + R * 0.72 + 4 : n.x, ne ? n.y - R * 0.72 - 6 : n.y - R - 10, "30 s", "warn", ne ? "start" : "middle");
      st.overlay.append(el, t);
      st.rings.push(el, t);
      return tween(st, 900, k => el.setAttribute("stroke-dashoffset", c * (1 - k)), "linear");
    }
    // A labelled bracket over log positions p1..p2 (on the side of the strip away from the node).
    function bracket(st, key, p1, p2, text) {
      const sp = st.db[key].strip, a = slotOf(st, key, p1), b = slotOf(st, key, p2), y = sp.y - 5;
      const g = s("g");
      g.append(paint(s("path", { d: `M${a.x},${y + 4} V${y} H${b.x + b.w} V${y + 4}`, fill: "none", "stroke-width": 1.5 }), { stroke: V("warn") }),
        tag(st, (a.x + b.x + b.w) / 2, y - 9, text, "warn"));
      st.overlay.appendChild(g);
      return g;
    }
    const clearRings = st => { st.rings.forEach(e => e.remove()); st.rings = []; };
    const fade = (st, el, from, to) => tween(st, 350, k => el.setAttribute("opacity", from + (to - from) * k));

    // ---------- story A: lost writes ----------
    const lost = {
      label: "Leader A crashes before its last writes reach the followers; B is promoted",
      legend: "discarded",
      intro: on => `<b>Lost writes.</b> A is the leader; ${on ? "B is a <b>synchronous</b> follower (A waits for it before saying OK) and C is asynchronous" : "B and C follow <b>asynchronously</b> (A says OK without waiting for them)"}. Press <b>Play</b> to crash A and fail over.`,
      init(st, on) {
        const first = on ? 40 : 39;
        client(st, "client", "client");
        dbNode(st, "A", "leader"); dbNode(st, "B", "follower"); dbNode(st, "C", "follower");
        strip(st, "A", first, true); strip(st, "B", first); strip(st, "C", first);
        for (let p = first; p <= 41; p++) ["A", "B", "C"].forEach(k => { if (p <= 40 || k !== "C") put(st, k, p, "rep"); });
        link(st, "cl", "client", "A");
        link(st, "AB", "A", "B", { label: on ? "sync" : "async" });
        link(st, "AC", "A", "C", { label: "async" });
        stat("leaders", 1); stat("lost", 0); stat("ext", null);
      },
      steps: on => [
        { title: "Leader A has acknowledged writes up to #43",
          detail: on ? "B is synchronous, so A waited for B before acknowledging: B has up to #43, C up to #40."
                     : "Replication is asynchronous: B has up to #41, C up to #40, so #42 and #43 exist only on A.",
          run: async st => {
            await fly(st, "client", "A", { label: "#42, #43", fill: V("c6") });
            put(st, "A", 42, "only"); put(st, "A", 43, "only");
            if (!on) st.tail = bracket(st, "A", 42, 43, "unreplicated tail");
            if (on) {
              await fly(st, "A", "B", { label: "#42, #43", fill: V("c1") });
              [42, 43].forEach(p => { put(st, "A", p, "rep"); put(st, "B", p, "rep"); });
              await fly(st, "B", "A", { label: "ack", fill: V("c2"), ms: 450 });
            }
            await fly(st, "A", "client", { label: "OK", fill: V("ok"), ms: 500 });
            log.add(on ? "A acked #42, #43 only after B had them" : "A acked #42, #43; no follower has them yet", on ? "ok" : "warn");
          } },
        { title: "A crashes", detail: "Power loss, kernel panic or a long GC pause all look the same from outside: heartbeats stop.",
          run: async st => {
            setRole(st.db.A, "down", "crashed");
            link(st, "cl", "client", "A", { dashed: true });
            await Promise.all([beat(st, "A", "B", 0.5), beat(st, "A", "C", 0.5)]);
            stat("leaders", 0);
            log.add("A crashed: heartbeats stop and writes to A fail", "warn");
          } },
        { title: "The followers wait out the timeout",
          detail: "No heartbeat for 30 s (the book's example). Shorter means needless failovers under load; longer means more seconds of failed writes.",
          run: async st => {
            await Promise.all([ring(st, "B"), ring(st, "C")]);
            log.add("B and C: no heartbeat for 30 s, so A is declared dead", "warn");
          } },
        { title: "B is promoted because it has the most recent data",
          detail: on ? "B has #43: every acknowledged write." : "Choosing the most up-to-date follower minimizes loss, but B only has up to #41.",
          run: async st => {
            clearRings(st);
            setRole(st.db.B, "leader");
            unlink(st, "AB"); unlink(st, "AC");
            link(st, "BC", "B", "C", { label: "async" });
            link(st, "cl", "client", "B");
            stat("leaders", 1);
            await fly(st, "B", "C", { label: on ? "#41–43" : "#41", fill: V("c1") });
            (on ? [41, 42, 43] : [41]).forEach(p => put(st, "C", p, "rep"));
            log.add(on ? "B promoted with every acked write; C catches up from B" : "B promoted with only up to #41; C catches up from B", on ? "ok" : "warn");
          } },
        { title: "Clients now write to B, which assigns the next number",
          detail: on ? "B assigns #44." : "B calls it #42, but it is a different write from the #42 that A acknowledged.",
          run: async st => {
            const p = on ? 44 : 42;
            await fly(st, "client", "B", { label: "write", fill: V("c6") });
            put(st, "B", p, "new");
            await Promise.all([fly(st, "B", "client", { label: "OK", fill: V("ok"), ms: 500 }), fly(st, "B", "C", { label: "#" + p, fill: V("c1") })]);
            put(st, "C", p, "new");
            log.add(on ? "B assigned #44; no number was reused" : "B's new #42 has the same number as A's old #42 but different data", on ? "ok" : "warn");
          } },
        { title: "A recovers and rejoins as a follower",
          detail: on ? "A has nothing B lacks; it simply catches up."
                     : "A's #42 and #43 conflict with the new leader's history, so they are discarded. The client was told both succeeded.",
          run: async st => {
            setRole(st.db.A, "follower");
            link(st, "BA", "B", "A", { label: "async" });
            if (!on) {
              st.tail.remove();
              put(st, "A", 42, "gone"); put(st, "A", 43, "gone");
              await sleep(st, 450);
              await eject(st, "A", [42, 43]);
            }
            const p = on ? 44 : 42;
            await fly(st, "B", "A", { label: "#" + p, fill: V("c1") });
            put(st, "A", p, "new");
            stat("lost", on ? 0 : 2);
            log.add(on ? "A copied #44 from B: nothing lost" : "A discarded its #42, #43 and copied B's #42: 2 acked writes lost", on ? "ok" : "bad");
          } },
        { title: "Lesson",
          detail: on ? "A synchronous follower costs latency on every write but made this failover lossless (because the synchronous follower is the one that was promoted)."
                     : "Asynchronous failover trades durability for availability. MongoDB saves such writes to rollback files; Kafka calls promoting a lagging replica an <i>unclean leader election</i> and disables it by default.",
          run: async () => { log.add(on ? "lesson: sync follower = lossless failover, slower writes" : "lesson: async failover can silently drop acked writes", "info"); } },
      ],
    };

    // ---------- story B: reused ids (GitHub 2012, simplified) ----------
    function nextId(st, key, v, tone) {
      const t = st.db[key].next;
      t.textContent = compact ? v : `next id: ${v}`;
      paint(t, { fill: V(tone || "ink") });
    }
    function redisEntry(st, id, who) {
      const L = st.L, y = L.entryY + st.redis.length * L.entryDy, x = L.redis.x + 14;
      const g = s("g");
      g.appendChild(paint(s("rect", { x, y: y - 4, width: 8, height: 8, rx: 2 }), { fill: V("c5") }));
      g.t = ctx.text(x + 14, y, `${id} → ${who}${compact ? "" : "'s data"}`, { size: L.font, mono: true, anchor: "start" });
      g.appendChild(g.t);
      st.overlay.appendChild(g);
      st.redis.push(g);
    }
    async function leak(st) {
      const p = paint(s("path", { d: st.L.toBob, fill: "none", "stroke-width": 2.5 }), { stroke: V("bad") });
      st.overlay.appendChild(p);
      const len = p.getTotalLength();
      p.setAttribute("stroke-dasharray", len);
      await tween(st, 700, k => p.setAttribute("stroke-dashoffset", len * (1 - k)));
      p.removeAttribute("stroke-dasharray"); p.removeAttribute("stroke-dashoffset");
      p.setAttribute("marker-end", st.svg.arrow(V("bad")));
      st.overlay.appendChild(tag(st, st.L.leakAt[0], st.L.leakAt[1], "Alice's data!", "bad"));
    }
    const ids = {
      label: "A lagging MySQL follower is promoted and re-issues ids that Redis already uses",
      legend: "lost (only on the failed leader)",
      intro: () => "<b>Reused IDs</b>, a simplified reconstruction of GitHub, 2012, as described in DDIA. MySQL hands out auto-increment row ids, and Redis stores data keyed by those ids. Press <b>Play</b>.",
      init(st) {
        const L = st.L, R = L.redis;
        client(st, "alice", "Alice"); client(st, "bob", "Bob");
        // Redis is pink (c5), not amber: amber means "pending / only on this node" across the chapter.
        st.nodes.append(ctx.box({ ...R, fill: V("c5-soft"), stroke: V("c5") }),
          ctx.text(R.x + R.w / 2, R.y + 22, "Redis", { size: L.font + 2, weight: 700 }),
          ctx.text(R.x + R.w / 2, R.y + 41, "data keyed by row id", { size: L.font, fill: V("muted") }));
        ["DB1", "DB2"].forEach((k, i) => {
          const n = dbNode(st, k, i ? "follower" : "leader"), nx = n.x + n.r + 12;
          if (compact) st.nodes.appendChild(ctx.text(nx, n.y, "next id", { size: L.font, anchor: "start", fill: V("muted") }));
          n.next = ctx.text(nx, n.y + (compact ? 15 : 9), "", { size: L.font + (compact ? 1 : 0), mono: true, weight: 700, anchor: "start" });
          st.nodes.appendChild(n.next);
          strip(st, k, L.first, !i);
          for (let p = L.first; p <= 1003; p++) put(st, k, p, "rep");
          nextId(st, k, 1004);
        });
        link(st, "a1", "alice", "DB1");
        link(st, "rep", "DB1", "DB2", { label: "async" });
        st.redis = [];
        stat("leaders", 1); stat("lost", 0); stat("ext", "Yes");
      },
      steps: () => [
        { title: "DB1 is the leader and hands out auto-increment ids", detail: "DB1 has used ids up to 1005; its asynchronous follower DB2 has only up to 1003.",
          run: async st => {
            await fly(st, "alice", "DB1", { label: "insert ×2", fill: V("c6") });
            put(st, "DB1", 1004, "only", "Alice"); put(st, "DB1", 1005, "only", "Alice");
            nextId(st, "DB1", 1006);
            await fly(st, "DB1", "alice", { label: "1004, 1005", fill: V("ok"), ms: 500 });
            log.add("DB1 gave Alice's new rows ids 1004, 1005; DB2 does not have them yet", "warn");
          } },
        { title: "Another system stores data by those ids", detail: "Redis now holds entries for rows 1004 and 1005, both Alice's private data.",
          run: async st => {
            await along(st, st.L.toRedis, { label: "1004, 1005", fill: V("c5") });
            redisEntry(st, 1004, "Alice"); redisEntry(st, 1005, "Alice");
            log.add("Redis caches Alice's data under keys 1004 and 1005", "info");
          } },
        { title: "DB1 fails and the lagging DB2 is promoted", detail: "DB2's counter is behind: its next id is 1004.",
          run: async st => {
            setRole(st.db.DB1, "down", "failed");
            unlink(st, "rep");
            link(st, "a1", "alice", "DB1", { dashed: true });
            put(st, "DB1", 1004, "gone", "Alice"); put(st, "DB1", 1005, "gone", "Alice");
            const a = slotOf(st, "DB1", 1004), b = slotOf(st, "DB1", 1005), sp = st.db.DB1.strip;
            st.overlay.appendChild(tag(st, (a.x + b.x + b.w) / 2, sp.y - 10, "lost", "bad"));
            await sleep(st, 500);
            setRole(st.db.DB2, "leader");
            nextId(st, "DB2", 1004, "warn");
            stat("lost", 2);
            log.add("DB1 failed; DB2 promoted with next id 1004. Rows 1004, 1005 never reached it", "bad");
          } },
        { title: "New rows reuse ids 1004 and 1005, this time for Bob", detail: "The database believes these ids are fresh; nothing inside MySQL looks wrong.",
          run: async st => {
            link(st, "b2", "bob", "DB2");
            await fly(st, "bob", "DB2", { label: "insert ×2", fill: V("c6") });
            put(st, "DB2", 1004, "new", "Bob"); put(st, "DB2", 1005, "new", "Bob");
            nextId(st, "DB2", 1006);
            await fly(st, "DB2", "bob", { label: "1004, 1005", fill: V("ok"), ms: 500 });
            log.add("DB2 handed out 1004 and 1005 again, now for Bob's rows", "warn");
          } },
        { title: "MySQL and Redis now disagree", detail: "Bob's page looks up row 1004 in Redis and is shown Alice's private data.",
          run: async st => {
            await along(st, st.L.toBob, { label: "get 1004", fill: V("c6"), reverse: true });
            await leak(st);
            paint(st.redis[0].t, { fill: V("bad") }); st.redis[0].t.setAttribute("font-weight", 700);
            const sl = slotOf(st, "DB2", 1004);
            paint(sl.rect, { stroke: V("bad") }); sl.rect.setAttribute("stroke-width", 2.5);
            stat("ext", "No");
            log.add("Bob's page read Redis key 1004 and got Alice's private data", "bad");
          } },
        { title: "Lesson", detail: "Discarding the old leader's writes is never local: anything outside the database that saw those ids now points at the wrong rows.",
          run: async () => { log.add("lesson: lost writes leak into every system that saw them", "info"); } },
      ],
    };

    // ---------- story C: split brain ----------
    function setVal(st, key, v, tone) { const t = st.db[key].val; t.textContent = `x = ${v}`; paint(t, { fill: V(tone || "ink") }); }
    async function pulse(st, key) {
      const n = st.db[key], c = paint(s("circle", { cx: n.x, cy: n.y, r: n.r, fill: "none", "stroke-width": 3 }), { stroke: V("bad") });
      st.overlay.appendChild(c);
      await tween(st, 450, k => { c.setAttribute("r", n.r + 16 * k); c.setAttribute("opacity", 1 - k); });
      c.remove();
    }
    const split = {
      label: "A network partition separates leader A from follower B",
      intro: on => `<b>Split brain.</b> What if the leader is not dead, only unreachable from its follower?${on ? " This time the cluster <b>fences</b> the old leader (STONITH) before promoting B." : ""} Press <b>Play</b>.`,
      init(st) {
        client(st, "c1", "Client 1", true); client(st, "c2", "Client 2", true);
        ["A", "B"].forEach((k, i) => {
          const n = dbNode(st, k, i ? "follower" : "leader");
          n.val = ctx.text(n.x, n.y + n.r + 18, "", { size: st.L.font + 1, mono: true, weight: 600 });
          st.nodes.appendChild(n.val);
          setVal(st, k, 1);
        });
        link(st, "c1", "c1", "A"); link(st, "c2", "c2", "A"); link(st, "AB", "A", "B");
        const [x, y1, y2] = st.L.cut;
        st.cut = s("g", { opacity: 0 },
          paint(s("line", { x1: x, y1, x2: x, y2, "stroke-width": 2.5, "stroke-dasharray": "7 5" }), { stroke: V("bad") }),
          tag(st, x, y2 + 15, "network partition", "bad"));
        st.overlay.appendChild(st.cut);
        stat("leaders", 1); stat("lost", 0); stat("ext", null);
      },
      steps: on => [
        { title: "A is the leader and B follows; both hold x = 1", detail: "A sends B a heartbeat every few seconds, and both clients write to A.",
          run: async st => {
            await beat(st, "A", "B"); await sleep(st, 150); await beat(st, "A", "B");
            log.add("heartbeats from A reach B on time", "info");
          } },
        { title: "The network between A and B fails", detail: "A is healthy and still serving Client 1; B simply stops hearing heartbeats.",
          run: async st => {
            link(st, "AB", "A", "B", { dashed: true });
            await fade(st, st.cut, 0, 1);
            await beat(st, "A", "B", 0.5);
            log.add("link A ↔ B down: heartbeats lost, A still serves Client 1", "warn");
          } },
        { title: on ? "B fences A before taking over" : "B times out and promotes itself",
          detail: on ? "STONITH: the cluster manager powers A off (or storage refuses A's old epoch) before B accepts any write."
                     : "From B's side, a dead leader and an unreachable one look identical.",
          run: async st => {
            await ring(st, "B");
            clearRings(st);
            if (on) { await pulse(st, "A"); setRole(st.db.A, "down", "fenced"); await sleep(st, 300); }
            setRole(st.db.B, "leader");
            link(st, "c2", "c2", "B");
            stat("leaders", on ? 1 : 2);
            log.add(on ? "A powered off (STONITH), then B promoted: one leader" : "B declared A dead and promoted itself: two leaders", on ? "ok" : "bad");
          } },
        { title: on ? "Only one node accepts writes" : "Both leaders accept writes",
          detail: on ? "Client 1's write to A fails, so it retries against B; Client 2 writes x = 3 on B."
                     : "Client 1 writes x = 2 on A; Client 2 writes x = 3 on B. Both are told OK.",
          run: async st => {
            const write = (c, k, v, o) => fly(st, c, k, { label: `x = ${v}`, fill: V("c6"), ...o });
            if (on) {
              await write("c1", "A", 2, { lost: 0.8 });
              link(st, "c1", "c1", "B");
              await write("c1", "B", 2); setVal(st, "B", 2);
              await write("c2", "B", 3); setVal(st, "B", 3);
            } else {
              await Promise.all([write("c1", "A", 2), write("c2", "B", 3)]);
              setVal(st, "A", 2); setVal(st, "B", 3);
            }
            const ok = { label: "OK", fill: V("ok"), ms: 500 };
            await Promise.all([fly(st, on ? "B" : "A", "c1", ok), fly(st, "B", "c2", ok)]);
            log.add(on ? "Client 1's write to A failed; B applied x = 2, then x = 3" : "A acked x = 2 and B acked x = 3: two histories", on ? "ok" : "bad");
          } },
        { title: on ? "One history" : "The partition heals with two histories",
          detail: on ? "Fencing turned split brain into a short outage. If both nodes shoot at once, both can end up down; robust systems combine majority elections (Chapter 9) with fencing tokens (Chapter 8)."
                     : "Single-leader replication has no rule for merging them: one side's acknowledged writes must be thrown away, or data gets corrupted.",
          run: async st => {
            await fade(st, st.cut, 1, 0);
            stat("lost", on ? 0 : 1);
            if (!on) {
              link(st, "AB", "A", "B", { color: "bad", arrow: false });
              ["A", "B"].forEach((k, i) => { paint(st.db[k].circle, { stroke: V("bad") }); st.db[k].circle.setAttribute("stroke-width", 3); setVal(st, k, i ? 3 : 2, "bad"); });
              st.overlay.appendChild(tag(st, (st.db.A.x + st.db.B.x) / 2, st.db.A.y - 14, "conflict", "bad"));
            }
            log.add(on ? "partition healed: only B's history exists, nothing to merge" : "partition healed: x = 2 on A vs x = 3 on B; one acked write must go", on ? "ok" : "bad");
          } },
      ],
    };

    // ---------- assembly ----------
    const STORIES = { lost, ids, split };
    // First log line of each story, so the log is never an empty box before Play.
    const SETUP = {
      lost: on => (on ? "Setup: A has acked up to #41; B (synchronous) has #41, C (asynchronous) has #40"
                      : "Setup: A has acked up to #41; B has #41 and C has #40, both asynchronous"),
      ids: () => "Setup: DB1 leads and DB2 follows asynchronously; both have rows up to id 1003",
      split: on => "Setup: A leads and B follows; both hold x = 1" + (on ? "; fencing (STONITH) is on" : ""),
    };
    function legendFor(S) {
      if (!S.legend) return ui.legend([
        { color: V("muted"), label: "heartbeat" }, { color: V("c6"), label: "client write" },
        { color: V("ok"), label: "OK to client" }, { color: V("bad"), label: "network partition", shape: "dash" },
      ]);
      return ui.legend([
        { color: V("c2"), label: "replicated", shape: "square" }, { color: V("warn"), label: "only on this node", shape: "square" },
        { color: V("c1"), label: "written by the new leader", shape: "square" }, { color: V("bad"), label: S.legend, shape: "square" },
      ]);
    }
    // Acceptance check for the fencing story: never two nodes drawn as leader after a step.
    function oneLeader(st) {
      const n = Object.values(st.db).filter(d => d.roleName === "leader").length;
      if (n > 1) throw new Error(`fencing story drew ${n} leaders at once`);
    }

    function build() {
      compact = ctx.compact;
      const S = STORIES[story], on = story === "lost" ? syncT.get() : story === "split" ? fenceT.get() : false;
      syncT.style.display = story === "lost" ? "" : "none";
      fenceT.style.display = story === "split" ? "" : "none";
      const L = LAYOUTS[story][compact ? 1 : 0], myGen = gen, setupLine = SETUP[story](on);
      const svg = ctx.svg({ w: L.w, h: L.h, label: S.label });
      const layers = {};
      ["edges", "strips", "nodes", "overlay", "pk"].forEach(k => svg.appendChild((layers[k] = s("g"))));
      const steps = S.steps(on).map(step => ({ ...step,
        run: async st => { await step.run(st); if (story === "split" && on) oneLeader(st); } }));
      player = ctx.stepper({
        delay: 1600, intro: S.intro(on), steps,
        // Fully redraws the scene: Back = init() + instant replay.
        init() {
          Object.values(layers).forEach(g => g.replaceChildren());
          log.clear();
          const st = { gen: myGen, L, svg, ...layers, db: {}, links: {}, rings: [] };
          S.init(st, on);
          log.add(setupLine, "info");
          return st;
        },
      });
      stage.replaceChildren(svg, legendFor(S), player.el);
    }

    function restart(keepStep) {
      const idx = keepStep && player ? player.index : -1;
      gen++;
      if (player) player.pause();
      ctx.instant = true; // finish the old story's in-flight tweens now; guard() parks its step
      build();
      const p = player;
      ctx.after(0, () => { ctx.instant = false; if (idx >= 0 && p === player) p.goto(idx); });
    }

    build();
    // Rebuild outside the ResizeObserver callback (avoids "ResizeObserver loop" errors), keeping the step.
    ctx.onResize(() => ctx.after(0, () => { if (ctx.compact !== compact) restart(true); }));
  },
});
