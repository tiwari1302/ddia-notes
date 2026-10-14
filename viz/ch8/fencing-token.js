// Fencing tokens. A lease holder that is paused (or whose write is stuck in the network) past its
// lease expiry still writes as if it held the lock. The same eight steps run with storage ignoring
// tokens (the file is corrupted) or checking them (the zombie write is rejected).
Viz.register("ch8/fencing-token", {
  title: "Fencing off a zombie leaseholder",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const AXIS = 30, T_PAUSE = 5, LEASE_END = 10, C2_LEASE = [11, 21];
    const cfg = { fencing: false, P: 12, cause: "gc" };
    const wake = () => T_PAUSE + cfg.P;
    const isGc = () => cfg.cause === "gc";
    const col = c => `var(--viz-${c})`;
    let view = null, compact = ctx.compact, player = null;

    // [desktop, phone] strings.
    const LOCK = {
      idle: ["holder: none · next token 33", "holder: none · next 33"],
      c1: ["holder: C1 · token 33 · until 10 s", "holder: C1 · 33 · until 10 s"],
      expired: ["holder: none (C1's lease expired)", "holder: none (C1 expired)"],
      c2: ["holder: C2 · token 34 · until 21 s", "holder: C2 · 34 · until 21 s"],
      free: ["holder: none · next token 35", "holder: none · next 35"],
    };
    const THINK = {
      none: ["no lease", "no lease"],
      hold33: ["I hold the lease ✓ (token 33)", "lease ✓ (33)"],
      frozen: ["zzz… (frozen, unaware)", "zzz… frozen"],
      still: ["I still hold the lease!", "I hold it! (33)"],
      waiting: ["sent, waiting for ack…", "sent, waiting…"],
      waiting2: ["(still waiting for the ack)", "still waiting…"],
      rejected: ["rejected → I lost the lease", "rejected → stop"],
      done: ["write done ✓", "write done ✓"],
      hold34: ["I hold the lease ✓ (token 34)", "lease ✓ (34)"],
      wrote34: ["wrote B ✓ (token 34)", "wrote B ✓ (34)"],
      gone: ["my data is gone?!", "my data is gone?!"],
    };
    const pick = pair => pair[compact ? 1 : 0];
    const wlabel = (name, tok) => (compact ? `${name}·${tok}` : `${name} · ${tok}`);

    // The resource's rule. With fencing, a write is accepted iff its token is >= the highest seen
    // (equal = the current holder writing again); the check and the write are one atomic step.
    function storageWrite(st, token) {
      if (st.fencing && st.highest !== null && token < st.highest) return false;
      if (st.fencing) st.highest = token;
      st.accepted++;
      return true;
    }

    // ---------- layout ----------
    function geom(c) {
      const g = c ? {
        W: 360, H: 402, fs: 11, big: 13,
        lock: [70, 8, 220, 52], c1: [42, 124, 24], c2: [318, 124, 24], sto: [100, 200, 160, 72], stoLines: [20, 40, 58],
        lockPorts: [[70, 38], [290, 38]], stoPorts: [[118, 200], [242, 200]], park: [88, 170], rejectAt: 0.55,
        tl: { x0: 40, x1: 345, now: 296, lab: [312, 344], rows: [328, 360], axis: 380, every: 10, bar: 14 },
      } : {
        W: 640, H: 356, fs: 12, big: 14,
        lock: [180, 12, 280, 58], c1: [90, 148, 30], c2: [550, 148, 30], sto: [220, 106, 200, 84], stoLines: [20, 44, 66],
        lockPorts: [[180, 46], [460, 46]], stoPorts: [[220, 148], [420, 148]], park: [170, 148], rejectAt: 0.7,
        tl: { x0: 60, x1: 620, now: 236, lab: [254, 292], rows: [272, 310], axis: 330, every: 5, bar: 16 },
      };
      g.X = t => g.tl.x0 + (t * (g.tl.x1 - g.tl.x0)) / AXIS;
      const rim = ([x, y, r], [tx, ty]) => {
        const dx = tx - x, dy = ty - y, n = Math.hypot(dx, dy);
        return [x + (r * dx) / n, y + (r * dy) / n];
      };
      g.route = {
        c1lock: [rim(g.c1, g.lockPorts[0]), g.lockPorts[0]],
        c2lock: [rim(g.c2, g.lockPorts[1]), g.lockPorts[1]],
        c1sto: [rim(g.c1, g.stoPorts[0]), g.stoPorts[0]],
        c2sto: [rim(g.c2, g.stoPorts[1]), g.stoPorts[1]],
      };
      return g;
    }

    const width = (el, str, size) => (el.getComputedTextLength && el.getComputedTextLength()) || str.length * size * 0.58;
    const add = (parent, el) => { parent.appendChild(el); return el; };
    const textAt = (parent, x, y, str, o) => add(parent, ctx.text(x, y, str, o));

    // A rectangle with an opaque underlay, so translucent fills hide whatever is drawn beneath.
    function card(parent, x, y, w, hh, tone, rx = 8) {
      parent.appendChild(s("rect", { x, y, width: w, height: hh, rx, fill: "var(--viz-bg)" }));
      return add(parent, s("rect", { x, y, width: w, height: hh, rx, fill: col(tone + "-soft"), stroke: col(tone), "stroke-width": 1.5 }));
    }

    // A thought bubble below a client (desktop) or beside it, towards the middle (phone).
    function thought(parent, [nx, ny, r], left) {
      const g = view.g, fs = g.fs, grp = add(parent, s("g"));
      const dots = [0, 1].map(() => add(grp, s("circle", { "stroke-width": 1 })));
      const under = add(grp, s("rect", { rx: 10, fill: "var(--viz-bg)" }));
      const box = add(grp, s("rect", { rx: 10, "stroke-width": 1.3 }));
      const txt = textAt(grp, 0, 0, "", { size: fs });
      txt.style.fontStyle = "italic";
      return {
        set(key, tone = "muted") {
          const str = pick(THINK[key]);
          txt.textContent = str;
          const w = width(txt, str, fs) + 18, hh = fs + 12;
          const side = left ? 1 : -1;
          const cx = compact ? nx + side * (r + 9 + w / 2) : ctx.clamp(nx, 6 + w / 2, g.W - 6 - w / 2);
          const cy = compact ? ny : ny + r + 26;
          // [dx, dy, radius] of the small "thought" circles between the client and its bubble
          const tail = compact ? [[side * (r + 4), 2, 1.8], [0, 0, 0]] : [[3, r + 4, 1.6], [7, r + 10, 2.6]];
          tail.forEach(([dx, dy, rr], i) => ctx.attr(dots[i], { cx: nx + dx, cy: ny + dy, r: rr }));
          [under, box].forEach(b => ctx.attr(b, { x: cx - w / 2, y: cy - hh / 2, width: w, height: hh }));
          ctx.attr(txt, { x: cx, y: cy + 0.5 });
          const muted = tone === "muted";
          const fill = muted ? "var(--viz-panel)" : col(tone + "-soft"), stroke = muted ? "var(--viz-line)" : col(tone);
          [box, ...dots].forEach(b => ctx.attr(b, { fill, stroke }));
          ctx.attr(txt, { fill: muted ? "var(--viz-muted)" : "var(--viz-ink)" });
        },
      };
    }

    function client(parent, geo, name, left) {
      const [x, y, r] = geo, g = view.g;
      const node = add(parent, ctx.node({ x, y, r, label: name, size: g.big + 1, fill: col("c6-soft"), stroke: col("c6") }));
      const gc = textAt(parent, x, y + 10, "❚❚ GC", { size: g.fs, weight: 800, fill: col("bad") });
      gc.style.display = "none";
      const th = thought(parent, geo, left);
      th.set("none");
      return { node, gc, th, x, y };
    }

    function drawScene(st) {
      const g = view.g, L = view.L;
      Object.values(g.route).forEach(([a, b]) => L.edges.appendChild(s("line", {
        x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: "var(--viz-line)", "stroke-width": 1.3, "stroke-dasharray": "4 4",
      })));
      const [lx, ly, lw, lh] = g.lock;
      card(L.scene, lx, ly, lw, lh, "c1");
      textAt(L.scene, lx + lw / 2, ly + lh * 0.37, "Lock service", { size: g.big, weight: 700 });
      st.lockText = textAt(L.scene, lx + lw / 2, ly + lh * 0.73, pick(LOCK.idle), { size: g.fs, mono: true, fill: "var(--viz-muted)" });

      const [sx, sy, sw, sh] = g.sto, [l0, l1, l2] = g.stoLines;
      st.stoRect = card(L.scene, sx, sy, sw, sh, "c2");
      textAt(L.scene, sx + sw / 2, sy + l0, "Storage", { size: g.big, weight: 700 });
      st.fileText = textAt(L.scene, sx + sw / 2, sy + l1, "file: (empty)", { size: g.fs, mono: true });
      st.tokText = textAt(L.scene, sx + sw / 2, sy + l2, "", { size: g.fs, mono: true });
      syncTokenLine(st);

      st.c1 = client(L.scene, g.c1, "C1", true);
      st.c2 = client(L.scene, g.c2, "C2", false);
    }

    function syncTokenLine(st) {
      st.tokText.textContent = !st.fencing ? "no token check" : "highest token: " + (st.highest === null ? "none" : st.highest);
      ctx.attr(st.tokText, { fill: st.fencing ? "var(--viz-ink)" : "var(--viz-muted)" });
    }

    function drawTimeline(st) {
      const g = view.g, tl = g.tl, L = view.L;
      add(L.tl, s("line", { x1: tl.x0, x2: tl.x1, y1: tl.axis, y2: tl.axis, stroke: "var(--viz-line)", "stroke-width": 1.2 }));
      for (let t = 0; t <= AXIS; t += tl.every) {
        add(L.tl, s("line", { x1: g.X(t), x2: g.X(t), y1: tl.axis, y2: tl.axis + 4, stroke: "var(--viz-line)" }));
        textAt(L.tl, g.X(t), tl.axis + 14, t + " s", { size: g.fs, fill: "var(--viz-muted)" });
      }
      ["C1", "C2"].forEach((name, i) => {
        add(L.tl, s("line", { x1: tl.x0, x2: tl.x1, y1: tl.rows[i], y2: tl.rows[i], stroke: "var(--viz-line)", opacity: 0.6 }));
        textAt(L.tl, 8, tl.rows[i], name, { size: g.fs, weight: 700, anchor: "start", fill: col("c6") });
      });
      // The "now" line sits behind the bars and skips the two label rows, so it never cuts through text.
      st.cursor = add(L.tl, s("path", { fill: "none", stroke: "var(--viz-muted)", "stroke-width": 1.5, "stroke-dasharray": "4 3" }));
      st.tlc = add(L.tl, s("g"));
      st.cursorText = textAt(L.tl, 0, tl.now, "", { size: g.fs, weight: 700, fill: "var(--viz-muted)", halo: true });
      st.cursor.style.display = st.cursorText.style.display = "none";
    }

    // ---------- scene updates used by the steps ----------
    function placeNow(st, t) {
      const g = view.g, x = g.X(t), [a, b] = g.tl.lab;
      st.cursor.setAttribute("d", `M${x},${a + 8}V${b - 8}M${x},${b + 8}V${g.tl.axis}`);
      ctx.attr(st.cursorText, { x });
      if (st.delay) {
        const w = Math.max(0, g.X(Math.min(t, st.wake)) - g.X(T_PAUSE));
        st.delay.forEach(r => r.setAttribute("width", w));
      }
    }

    function moveNow(st, t) {
      const from = st.now === null ? t : st.now;
      st.now = t;
      st.cursor.style.display = st.cursorText.style.display = "";
      st.cursorText.textContent = `t = ${t} s`;
      return ctx.tween({ ms: 550, onUpdate: k => placeNow(st, from + (t - from) * k) });
    }

    function bar(st, row, t0, t1, tone) {
      const g = view.g, y = g.tl.rows[row], hh = g.tl.bar;
      card(st.tlc, g.X(t0), y - hh / 2, g.X(t1) - g.X(t0), hh, tone, 4);
    }

    // The pause (or the write's time in the network): a dashed outline for its full length,
    // filled up to "now" as time passes.
    function startDelay(st) {
      const g = view.g, y = g.tl.rows[0], x0 = g.X(T_PAUSE), x1 = g.X(st.wake), hb = 8;
      const tone = st.cause === "gc" ? "bad" : "warn";
      const rect = o => add(st.tlc, s("rect", { x: x0, y: y - hb / 2, width: 0, height: hb, rx: 3, ...o }));
      const outline = rect({ fill: "none", stroke: col(tone), "stroke-width": 1.2, "stroke-dasharray": "3 3" });
      st.delay = [rect({ fill: "var(--viz-bg)" }), rect({ fill: col(tone + "-soft"), stroke: col(tone), "stroke-width": 1.3 })];
      const str = st.cause === "gc" ? (compact ? "pause " : "GC pause ") + st.P + " s" : (compact ? "delay " : "write delayed ") + st.P + " s";
      const label = textAt(st.tlc, 0, g.tl.lab[0], str, { size: g.fs, weight: 700, fill: col(tone), halo: true });
      // Center over the bar, but keep clear of the write labels at t = 3 and t = wake.
      const lw = width(label, str, g.fs), half = s2 => (s2.length * g.fs * 0.6) / 2;
      const lo = g.X(3) + half(wlabel("A", 33)) + 6 + lw / 2, hi = x1 - half(wlabel("A'", 33)) - 6 - lw / 2;
      ctx.attr(label, { x: lo <= hi ? ctx.clamp((x0 + x1) / 2, lo, hi) : (lo + hi) / 2 });
      return ctx.tween({ ms: 600, onUpdate: k => outline.setAttribute("width", (x1 - x0) * k) });
    }

    function marker(st, row, t, str, tone) {
      const g = view.g, x = g.X(t), y = g.tl.rows[row], m = add(st.tlc, s("g"));
      const rejected = tone === "rejected", c = rejected ? "var(--viz-muted)" : col(tone);
      if (rejected) {
        m.append(s("circle", { cx: x, cy: y, r: 6, fill: "var(--viz-bg)", stroke: c, "stroke-width": 1.6 }),
          s("path", { d: `M${x - 3},${y - 3}L${x + 3},${y + 3}M${x + 3},${y - 3}L${x - 3},${y + 3}`, stroke: c, "stroke-width": 1.6 }));
      } else {
        m.appendChild(s("circle", { cx: x, cy: y, r: 5.5, fill: c, stroke: "var(--viz-bg)", "stroke-width": 1.5 }));
      }
      textAt(m, x, g.tl.lab[row], str, { size: g.fs, weight: 700, fill: c, halo: true });
    }

    function expiryMark(st) {
      const g = view.g, x = g.X(LEASE_END), y = g.tl.rows[0], d = 5;
      const p = `M${x - d},${y - d}L${x + d},${y + d}M${x + d},${y - d}L${x - d},${y + d}`;
      add(st.tlc, s("path", { d: p, stroke: "var(--viz-bg)", "stroke-width": 5.5, "stroke-linecap": "round" }));
      add(st.tlc, s("path", { d: p, stroke: col("bad"), "stroke-width": 2.4, "stroke-linecap": "round" }));
    }

    function setPaused(st, on) {
      const c = st.c1;
      c.node.setAttribute("opacity", on ? 0.45 : 1);
      ctx.attr(c.node.circle, { "stroke-dasharray": on ? "5 4" : "none" });
      c.node.label.setAttribute("y", on ? c.y - 7 : c.y);
      c.gc.style.display = on ? "" : "none";
    }

    function lockSays(st, key) { st.lockText.textContent = pick(LOCK[key]); }

    function badge(st, str, tone) {
      const g = view.g, [sx, sy, sw] = g.sto, grp = add(view.L.scene, s("g"));
      const t = textAt(grp, sx + sw / 2, sy, str, { size: g.fs, weight: 800, fill: "var(--viz-bg)" });
      const w = width(t, str, g.fs) + 18, hh = g.fs + 9;
      grp.insertBefore(s("rect", { x: sx + sw / 2 - w / 2, y: sy - hh / 2, width: w, height: hh, rx: hh / 2, fill: col(tone) }), t);
    }

    function flashStorage(st, tone) {
      ctx.attr(st.stoRect, { stroke: col(tone) });
      return ctx.tween({ ms: 600, onUpdate: k => st.stoRect.setAttribute("stroke-width", 5 - 3 * k) });
    }

    function fly(from, to, label, tone, o = {}) {
      return ctx.fly(view.L.packets, {
        from, to, label, fill: col(tone), ms: 650, labelSize: view.g.fs, keep: o.keep, labelFill: o.labelFill,
      });
    }
    const go = (route, label, tone, o) => fly(...view.g.route[route], label, tone, o);
    const back = (route, label, tone, o) => fly(view.g.route[route][1], view.g.route[route][0], label, tone, o);
    // Starts a kept packet and returns [promise, element].
    const keep = (p, ...args) => { const pr = p(...args); return [pr, view.L.packets.lastElementChild]; };
    // On desktop a packet parked at storage's edge moves its label to its left, off the box.
    const labelLeft = pkt => { if (!compact) ctx.attr(pkt.querySelector("text"), { x: -12, y: 0, "text-anchor": "end" }); };

    function write(st, token, content) {
      const ok = storageWrite(st, token);
      if (ok) { st.file = content; st.fileText.textContent = "file: " + content; }
      syncTokenLine(st);
      syncStats(st);
      return ok;
    }

    // ---------- stepper ----------
    function init() {
      const L = view.L;
      Object.values(L).forEach(layer => { layer.innerHTML = ""; });
      const st = {
        fencing: cfg.fencing, P: cfg.P, cause: cfg.cause, wake: wake(), lockToken: 32, highest: null,
        file: "(empty)", accepted: 0, corrupted: false, now: null, delay: null,
      };
      drawScene(st);
      drawTimeline(st);
      syncStats(st);
      return st;
    }

    // Titles and details are getters, so the caption follows the current settings.
    const step = (title, detail, run) => ({ get title() { return title(); }, get detail() { return detail(); }, run });
    const byCause = (gc, net) => () => (isGc() ? gc : net);
    const byFence = (on, off) => () => (cfg.fencing ? on : off);
    const at = (t, str) => () => `t = ${typeof t === "function" ? t() : t} s: ` + (typeof str === "function" ? str() : str);
    const steps = [
      step(at(0, "C1 asks the lock service for the lease"),
        () => "A lease is a lock with a timeout: if C1 dies, the lock frees itself after 10 s.",
        async st => {
          await Promise.all([moveNow(st, 0), go("c1lock", "acquire", "c6")]);
          st.lockToken = 33;
          await back("c1lock", "OK · token 33", "c1");
          lockSays(st, "c1");
          st.c1.th.set("hold33", "ok");
          bar(st, 0, 0, LEASE_END, "ok");
          syncStats(st);
        }),
      step(at(3, "C1 writes its data, attaching token 33"),
        byFence("Storage records 33 as the highest token it has seen.", "Storage doesn't look at the token; it just writes."),
        async st => {
          await Promise.all([moveNow(st, 3), go("c1sto", "write A · 33", "c6")]);
          write(st, 33, "A (C1)");
          marker(st, 0, 3, wlabel("A", 33), "ok");
          await back("c1sto", "ok", "c2");
        }),
      step(at(T_PAUSE, byCause("C1 hits a stop-the-world GC pause",
        "C1 checks its lease (5 s left) and sends write A' · 33 at once, but the packet gets stuck in a congested switch queue")),
        byCause("It had just checked its lease: 5 s left. During the pause none of its code runs, including any lease check.",
          "C1 did everything right: it checked the lease and wrote at once. It isn't paused; it is waiting for an ack."),
        async st => {
          if (st.cause === "gc") {
            setPaused(st, true);
            st.c1.th.set("frozen", "warn");
            await Promise.all([moveNow(st, T_PAUSE), startDelay(st)]);
            return;
          }
          const g = view.g, [flight, pkt] = keep(fly, g.route.c1sto[0], g.park, "write A' · 33", "c6", { keep: true });
          st.parked = pkt;
          await Promise.all([moveNow(st, T_PAUSE), flight, startDelay(st)]);
          ctx.attr(pkt.querySelector("circle"), { fill: col("warn") });
          st.stuck = textAt(view.L.packets, g.park[0], g.park[1] + 20, "stuck in queue", { size: g.fs, weight: 600, fill: col("warn"), halo: true });
          st.c1.th.set("waiting", "warn");
        }),
      step(at(LEASE_END, byCause("The lease expires. C1 can't notice: it's frozen", "The lease expires. C1's write is still stuck in the network")),
        byCause("The lock service frees the lease on its own clock. Nobody tells C1, and C1 isn't running to check.",
          "The write left C1 while the lease was valid; it will arrive after the lease is gone."),
        async st => {
          await moveNow(st, LEASE_END);
          lockSays(st, "expired");
          expiryMark(st);
        }),
      step(at(C2_LEASE[0], "C2 acquires the lease and gets token 34"),
        () => "The lock service did its job: C1's lease had expired. Every grant gets a larger token than the last.",
        async st => {
          await Promise.all([moveNow(st, C2_LEASE[0]), go("c2lock", "acquire", "c6")]);
          st.lockToken = 34;
          await back("c2lock", "OK · token 34", "c1");
          lockSays(st, "c2");
          st.c2.th.set("hold34", "ok");
          bar(st, 1, C2_LEASE[0], C2_LEASE[1], "ok");
          syncStats(st);
        }),
      step(at(12, "C2 writes its data with token 34"),
        byFence("34 ≥ 33, so storage accepts it and now remembers 34 as the highest token.", "Storage replaces A with B. So far, so good."),
        async st => {
          await Promise.all([moveNow(st, 12), go("c2sto", "write B · 34", "c6")]);
          write(st, 34, "B (C2)");
          marker(st, 1, 12, wlabel("B", 34), "ok");
          await back("c2sto", "ok", "c2");
          st.c2.th.set("wrote34", "ok");
        }),
      step(at(wake, byCause("C1 wakes up and finishes what it was doing: a write with token 33", "The delayed write A' · 33 finally reaches storage")),
        byCause("From C1's point of view no time has passed; its lease check happened 'just now'.",
          "C1's lease expired long ago, but nothing on the packet's path knows that."),
        async st => {
          let flight;
          if (st.cause === "gc") {
            await moveNow(st, st.wake);
            setPaused(st, false);
            st.c1.th.set("still", "bad");
            [flight, st.zombie] = keep(go, "c1sto", "write A' · 33", "c6", { keep: true });
          } else {
            st.stuck.remove();
            st.parked.remove();
            [flight, st.zombie] = keep(fly, view.g.park, view.g.route.c1sto[1], "write A' · 33", "warn", { keep: true });
            flight = Promise.all([moveNow(st, st.wake), flight]);
            st.c1.th.set("waiting2", "warn");
          }
          if (st.wake > C2_LEASE[1]) lockSays(st, "free");
          await flight;
          labelLeft(st.zombie);
        }),
      step(byFence("Storage rejects it: 33 is lower than 34, so the zombie write is fenced off",
        "Storage accepts it: C1 overwrites C2's data. The file is corrupted"),
        byFence("Storage can't tell why the write is late, and doesn't need to: a token lower than one it has seen comes from an old leaseholder.",
          "Storage can't tell that C1's lease is gone: without a token check, the last write wins."),
        async st => {
          st.zombie.remove();
          const [a, b] = view.g.route.c1sto;
          if (write(st, 33, "A' over B")) {
            st.corrupted = true;
            ctx.attr(st.fileText, { fill: col("bad") });
            badge(st, "✗ CORRUPTED", "bad");
            marker(st, 0, st.wake, wlabel("A'", 33), "bad");
            st.c2.th.set("gone", "bad");
            await Promise.all([flashStorage(st, "bad"), back("c1sto", "ok", "c2")]);
            st.c1.th.set("done", "bad");
          } else {
            marker(st, 0, st.wake, wlabel("A'", 33), "rejected");
            badge(st, "✓ zombie fenced off", "ok");
            const stop = [ctx.lerp(b[0], a[0], view.g.rejectAt), ctx.lerp(b[1], a[1], view.g.rejectAt)];
            await Promise.all([flashStorage(st, "ok"), fly(b, stop, "✕ 33 < 34", "bad", { keep: true, labelFill: col("bad") })]);
            st.c1.th.set("rejected", "warn");
          }
          syncStats(st);
        }),
    ];

    // ---------- controls, stats, note, legend ----------
    const stats = ui.stats([
      { key: "token", label: "Latest token issued" },
      { key: "highest", label: "Highest token seen by storage" },
      { key: "accepted", label: "Writes accepted" },
      { key: "file", label: "File" },
    ]);
    function syncStats(st) {
      stats.set("token", st.lockToken > 32 ? st.lockToken : "none", "");
      stats.set("highest", !st.fencing ? "not checked" : st.highest === null ? "none" : st.highest, st.fencing && st.highest !== null ? "info" : "");
      stats.set("accepted", st.accepted, st.corrupted ? "bad" : "");
      stats.set("file", st.corrupted ? "CORRUPTED" : st.accepted ? "OK" : "–", st.corrupted ? "bad" : st.accepted ? "ok" : "");
    }

    const note = ui.note("");
    function setNote(final) {
      const gc = isGc(), P = cfg.P, corrupted = final && player && player.state.corrupted;
      const extra = gc ? "" : " Checking the lease right before sending didn't help: the delay happened after the check.";
      if (!final) {
        note.set(gc ? `C1 will pause for <b>${P} s</b>, longer than the 5 s left on its lease. Watch what storage does with C1's late write.`
          : `C1's write will sit in a network queue for <b>${P} s</b>, longer than the 5 s left on its lease. Watch what storage does when it finally arrives.`, "info");
      } else if (corrupted) {
        note.set("Both clients believed they held the lease, and storage believed both. The lock service did its job; the bug is that the " +
          "resource accepted a write from a client that no longer held the lock. Shorter leases don't help: " +
          (gc ? "a pause" : "a delay") + " can always be longer." + extra, "bad");
      } else {
        note.set("Each grant gets a larger token, and storage remembers the largest it has seen, checking and writing in one atomic step. " +
          `However long ${gc ? "C1 sleeps" : "the write is delayed"}, its token 33 is stale once storage has seen 34. ` +
          "The safety check lives in the resource, not in the client's judgment." + extra, "ok");
      }
    }

    const legend = ui.legend([
      { color: col("ok"), label: "lease held", shape: "square" },
      { color: col("bad"), label: "GC pause", shape: "square" },
      { color: col("warn"), label: "write stuck in the network", shape: "square" },
      { color: col("c6"), label: "client request" },
      { color: col("c1"), label: "lock service reply" },
      { color: col("c2"), label: "storage reply" },
      { color: col("bad"), label: "rejection" },
    ]);
    function syncLegend() {
      legend.children[1].style.display = isGc() ? "" : "none";
      legend.children[2].style.display = isGc() ? "none" : "";
    }

    function restart() {
      slider.querySelector(".viz-slider-label").textContent = isGc() ? "GC pause length" : "Network delay";
      syncLegend();
      player.reset();
    }
    const toggle = ui.toggle({ label: "Storage checks fencing tokens", value: cfg.fencing, onChange: v => { cfg.fencing = v; restart(); } });
    const slider = ui.slider({
      label: "GC pause length", min: 8, max: 20, step: 1, value: cfg.P, format: v => v + " s",
      onInput: v => { cfg.P = v; restart(); },
    });
    const stepHolder = h("div");

    function build() {
      compact = ctx.compact;
      const g = geom(compact);
      const svg = ctx.svg({ w: g.W, h: g.H, label: "A lock service, two clients and shared storage, with a timeline of leases, a pause and writes" });
      const L = { edges: s("g"), scene: s("g"), tl: s("g"), packets: s("g") };
      svg.append(L.edges, L.scene, L.tl, L.packets);
      view = { g, svg, L };
      const causeOpts = {
        label: "Why C1 is late", value: cfg.cause,
        options: [{ value: "gc", label: "GC pause" }, { value: "network", label: "Slow network" }],
        onChange: v => { cfg.cause = v; restart(); },
      };
      const cause = compact ? ui.select(causeOpts) : ui.segmented(causeOpts);
      // The track's default flex-basis would push the value onto its own line on phones.
      slider.input.style.flex = compact ? "1 1 80px" : "";
      root.innerHTML = "";
      root.append(ui.bar(toggle, cause, slider), svg, legend, stepHolder, note, stats);
    }

    build();
    player = ctx.stepper({
      init, steps, delay: 1200,
      get intro() {
        return cfg.fencing
          ? "Fencing is <b>ON</b>: storage remembers the highest token it has seen and rejects lower ones. Press <b>Play</b> to run the same story."
          : "Fencing is <b>OFF</b>. Press <b>Play</b> to see why a lease alone can't stop a client that is paused or slowed down. Then turn fencing on and replay.";
      },
      onStep: i => setNote(i === steps.length - 1),
    });
    stepHolder.appendChild(player.el);
    setNote(false);
    syncLegend();
    ctx.onResize(() => {
      if (ctx.compact === compact) return;
      build();
      player.goto(player.index);
    });
  },
});
