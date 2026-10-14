// The unfriend race (book's example, names added). Ana unfriends Ben (F1), then posts about him
// (M1). A Notifier keeps a derived copy of each user's friend list and pushes every post to the
// author's friends according to that copy. Through one log it always sees F1 before M1, however
// far behind it is; through two logs M1 can overtake F1 and reach Ben. The fix: M1 names the
// friend-list version Ana saw, and the Notifier holds it until its copy has caught up. Toy timings.
(function () {
  "use strict";

  const LAG = { low: 0.2, high: 2.0 }; // friendships consumer lag (or the shared log's), seconds
  const MSG_LAG = 0.2;                 // the messages consumer is always this far behind
  const T1 = 3;                        // timeline end, seconds
  const r1 = x => Math.round(x * 10) / 10;
  const sec = x => x.toFixed(1) + " s";
  const v = c => `var(--viz-${c})`;
  const tone = (html, t) => `<span style="color:var(--viz-${t})">${html}</span>`;
  const cx = b => b.x + b.w / 2, cy = b => b.y + b.h / 2;
  const EV_COLOR = { F1: "c5", M1: "c6" };
  const LOG_TITLE = { shared: "one shared log", friends: "friendships log", messages: "messages log" };
  const MUTED = { fill: v("muted") };
  const START = { friends: ["Ben", "Cal"], v: 7 };  // Ana's friend list (and its version) at t = 0
  const AFTER_F1 = { friends: ["Cal"], v: 8 };       // ... once the unfriend is applied

  // Pure timeline: write and arrival times, then what the Notifier does with each arrival.
  // The steps, stats, timeline lanes and end note are all derived from this.
  function simulate({ flow, lag, fix }) {
    const one = flow === "one", L = LAG[lag], carry = !one && fix === "carry";
    const F1 = { id: "F1", written: 0, log: one ? "shared" : "friends", needs: 0 };
    const M1 = { id: "M1", written: 0.5, log: one ? "shared" : "messages", needs: carry ? AFTER_F1.v : 0 };
    F1.arrive = r1(F1.written + L);
    M1.arrive = r1(M1.written + (one ? L : MSG_LAG));
    const order = [F1, M1].sort((a, b) => a.arrive - b.arrive || (a.id === "F1" ? -1 : 1));
    let copy = START, held = null;
    const reads = order.map(ev => {
      const rd = { ev, t: ev.arrive, before: copy, effects: [], pushes: [] };
      if (ev.id === "F1") {
        copy = AFTER_F1;
        rd.kind = "apply";
        rd.effects.push("F1");
        if (held && copy.v >= held.ev.needs) {   // the dependency is satisfied: release
          rd.release = held;
          rd.effects.push("M1");
          rd.pushes.push({ t: rd.t, to: copy.friends.slice() });
          held = null;
        }
      } else if (ev.needs > copy.v) {
        rd.kind = "hold";
        held = rd;
      } else {
        rd.kind = "push";
        rd.effects.push("M1");
        rd.pushes.push({ t: rd.t, to: copy.friends.slice() });
      }
      rd.after = copy;
      return rd;
    });
    const pushes = reads.flatMap(rd => rd.pushes);
    const firstPush = name => (pushes.find(p => p.to.includes(name)) || { t: null }).t;
    const rel = reads.find(rd => rd.release);
    const effects = reads.flatMap(rd => rd.effects);
    return {
      one, L, carry, F1, M1, reads, effects,
      ben: firstPush("Ben"), cal: firstPush("Cal"),
      waited: rel ? r1(rel.t - rel.release.t) : 0,
      inverted: effects[0] === "M1",        // the post was acted on before the unfriend
      overtaken: M1.arrive < F1.arrive,     // the post reached the Notifier first
    };
  }

  // Stats after step i (0, 1 = the writes; then one step per read; last = Result).
  function statsAt(sim, i, last) {
    const done = sim.reads.slice(0, Math.max(0, i - 1)), end = i === last;
    const pushes = done.flatMap(rd => rd.pushes), eff = done.flatMap(rd => rd.effects);
    const got = name => pushes.find(p => p.to.includes(name));
    const holding = done.some(rd => rd.kind === "hold") && !done.some(rd => rd.release);
    return {
      ben: got("Ben") ? ["YES", "bad"] : end ? ["no", "ok"] : ["–", ""],
      cal: got("Cal") ? [sec(got("Cal").t), "ok"] : ["–", ""],
      wait: done.some(rd => rd.release) ? [sec(sim.waited), "info"] : holding ? ["waiting…", "warn"]
        : end ? ["0 s", "info"] : ["–", ""],
      order: eff.length < 2 ? ["–", ""] : eff[0] === "F1" ? ["F1 then M1", "ok"] : ["M1 then F1", "bad"],
    };
  }

  const INTRO_NOTE = "Ana unfriends Ben, then posts “Ben is so annoying” to her friends. Pick how the events " +
    "flow and press <b>Play</b>: does Ben get the notification?";
  const RUN_NOTE = "Does Ben get the notification? Watch the <b>notifier</b> lane: what matters is the order in which " +
    "the Notifier reads F1 and M1, not the order Ana wrote them.";

  function endNote(sim) {
    if (sim.one) return ["One log means one order: the Notifier applied the unfriend before the post however far " +
      "behind it was. Lag delayed both events; it could not reorder them. The price is that every service must write " +
      "through one sequencer, which is exactly what partitioning, multiple datacenters and microservices take away.", "ok"];
    if (sim.ben !== null) return ["Ben was notified about a post written after he was unfriended. Each log was in order; " +
      "the order <em>between</em> them was lost. Merging the friend lists later (or a CRDT) can't recall a notification " +
      "that was already pushed.", "bad"];
    const n = sim.M1.needs;
    if (sim.carry && sim.waited > 0) return [`The post named the friend-list version Ana saw (v${n}), so the Notifier ` +
      `held it until its own copy reached v${n}. Correct, at the cost of <b>${sec(sim.waited)}</b> of extra delay: ` +
      "respecting causality cost timeliness, not correctness.", "ok"];
    if (sim.carry) return ["The dependency was already satisfied when the post arrived, so the fix cost nothing here: " +
      "it waits only when it has to.", "ok"];
    return ["Correct, but only by luck: the friendships consumer happened to be fast. Nothing in the design prevents " +
      "the race; set the lag to <b>High</b>.", "warn"];
  }

  function readTitle(rd) {
    const at = `At t = ${rd.t.toFixed(1)} s`;
    if (rd.kind === "hold") {
      return tone(`${at} M1 arrives needing friends v${rd.ev.needs}, but the copy is still v${rd.before.v}: hold it.`, "warn");
    }
    if (rd.kind === "apply") {
      const to = rd.release ? rd.pushes[0].to : [];
      return `${at} the Notifier reads F1 and removes Ben from its copy (now v${rd.after.v}).` +
        (rd.release ? " " + tone(`The held post is released and pushed to ${to.join(" and ")}${to.length > 1 ? "" : " only"}.`, "ok") : "");
    }
    const to = rd.pushes[0].to;
    return `${at} the Notifier reads M1. Its copy says Ana's friends are ${to.join(", ")} (v${rd.before.v}), so ` +
      tone(`it pushes to ${to.length > 1 ? "both" : to[0] + " only"}.`, to.includes("Ben") ? "bad" : "ok");
  }

  function readDetail(sim, rd) {
    const ev = rd.ev;
    if (sim.one) {
      return ev.id === "F1" ? `One consumer reads the shared log in order, ${sec(sim.L)} behind.`
        : "M1 sits behind F1 in the same log, so it can only be read after F1.";
    }
    let d = `${ev.id} spent ${sec(rd.t - ev.written)} in the ${LOG_TITLE[ev.log]} before its consumer got to it.`;
    if (ev.id === "M1" && sim.F1.arrive > rd.t) d += " F1, written earlier, is still unread in the friendships log.";
    if (ev.id === "F1" && sim.inverted) d += " Too late: Ben already has the post.";
    return d;
  }

  function resultDetail(sim) {
    if (sim.ben !== null) return `Ben got the post at ${sec(sim.ben)}, and a pushed notification can't be recalled. Cal got it at ${sec(sim.cal)}.`;
    return `Only Cal was notified, at ${sec(sim.cal)}` + (sim.waited ? `, after waiting ${sec(sim.waited)} for F1.` : ".");
  }

  // Scene geometry. Desktop: flow left to right. Phone: top to bottom, logs side by side.
  function geom(compact, one) {
    if (compact) {
      return {
        W: 360, H: 490, fs: 11, compact, tick: 1, cellW: 88,
        ana: { x: 10, y: 8, w: 340, h: 40 },
        logs: one ? { shared: { x: 10, y: 74, w: 340, h: 40 } }
          : { friends: { x: 10, y: 74, w: 165, h: 40 }, messages: { x: 185, y: 74, w: 165, h: 40 } },
        notifier: { x: 10, y: 136, w: 340, h: 52 },
        phones: { Ben: { x: 10, y: 206, w: 165, h: 44 }, Cal: { x: 185, y: 206, w: 165, h: 44 } },
        tlTitle: { x: 10, y: 276, text: "Timeline (toy timings)" },
        tl: { x: 10, y: 290, w: 340, h: 176, labelWidth: 70 },
      };
    }
    return {
      W: 640, H: 352, fs: 12, compact, tick: 0.5, cellW: one ? 90 : 96,
      ana: { x: 8, y: 44, w: 108, h: 68 },
      logs: one ? { shared: { x: 134, y: 56, w: 196, h: 44 } }
        : { friends: { x: 134, y: 26, w: 196, h: 38 }, messages: { x: 134, y: 90, w: 196, h: 38 } },
      notifier: { x: 352, y: 24, w: 136, h: 104 },
      phones: { Ben: { x: 514, y: 24, w: 114, h: 48 }, Cal: { x: 514, y: 80, w: 114, h: 48 } },
      tlTitle: { x: 12, y: 154, text: "When each event was written, and when the Notifier processed it (toy timings)" },
      tl: { x: 12, y: 166, w: 616, h: 166, labelWidth: 80 },
    };
  }

  function cellRect(g, ev) {
    const log = g.logs[ev.log], slot = ev.log === "shared" && ev.id === "M1" ? 1 : 0;
    return { x: log.x + 6 + slot * (g.cellW + 4), y: log.y + 5, w: g.cellW, h: log.h - 10 };
  }
  // Connector between boxes: "in" Ana -> log, "out" log -> Notifier, "push" Notifier -> phone.
  function wirePts(g, kind, b) {
    const A = g.ana, N = g.notifier;
    if (g.compact) {   // vertical; log wires keep to the right so they miss the log titles
      const x = kind === "push" ? cx(b) : b.x + b.w - 26;
      if (kind === "in") return [x, A.y + A.h, x, b.y];
      if (kind === "out") return [x, b.y + b.h, x, N.y];
      return [x, N.y + N.h, x, b.y];
    }
    if (kind === "in") return [A.x + A.w, cy(A), b.x, cy(b)];
    if (kind === "out") return [b.x + b.w, cy(b), N.x, cy(b)];
    return [N.x + N.w, cy(b), b.x, cy(b)];
  }
  const writePath = (g, ev) => {
    const p = wirePts(g, "in", g.logs[ev.log]), c = cellRect(g, ev);
    return [[p[0], p[1]], [cx(c), cy(c)]];
  };
  const readPath = (g, ev) => {
    const c = cellRect(g, ev), N = g.notifier;
    return [[cx(c), cy(c)], g.compact ? [cx(c), N.y + 12] : [N.x + 14, cy(c)]];
  };
  const pushPath = (g, name) => {
    const b = g.phones[name], N = g.notifier;
    return g.compact ? [[cx(b), N.y + N.h - 8], [cx(b), b.y + 14]] : [[N.x + N.w - 8, cy(b)], [b.x + 18, cy(b)]];
  };

  Viz.register("ch12/unfriend-race", {
    title: "The unfriend race: one log vs two",
    simulate, statsAt, // exposed for tests
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      const cfg = { flow: "two", lag: "high", fix: "none" };  // outside build(): survives layout rebuilds
      let compact = ctx.compact, view = null, player = null, gen = 0;

      // ---------- scene ----------
      // A <text> of tspans ending in [friend list][version]; setList() rewrites those two.
      function listLine(parent, x, y, prefix, size, mono) {
        const t = ctx.text(x, y, "", { size });
        const parts = [...prefix, ["", { mono }], ["", { mono, ...MUTED }]].map(([str, o]) => {
          const sp = s("tspan", { "font-weight": o.weight, fill: o.fill, class: o.mono ? "viz-mono" : null });
          sp.textContent = str;
          t.appendChild(sp);
          return sp;
        });
        parent.appendChild(t);
        setList(parts, START);
        return parts;
      }
      function setList(parts, copy, tn) {
        const n = parts.length;
        parts[n - 2].textContent = copy.friends.join(", ");
        parts[n - 1].textContent = compact ? ` (v${copy.v})` : ` · v${copy.v}`;
        parts[n - 2].style.fill = tn ? v(tn) : "";
      }

      function drawScene(sim) {
        const g = geom(compact, sim.one), fs = g.fs, A = g.ana, N = g.notifier;
        const svg = ctx.svg({ w: g.W, h: g.H, label: "Ana's two events flowing through the logs to the Notifier and her friends' phones, above a timeline" });
        const wires = s("g"), boxes = s("g"), cells = s("g");
        svg.append(wires, boxes, cells);
        const wire = p => wires.appendChild(ctx.arrow({ x1: p[0], y1: p[1], x2: p[2], y2: p[3], color: v("line"), width: 1.4, svg }));
        const st = { g, svg, cells, nRows: [], phones: {} };

        // Ana, with the friend list (and version) her app shows her.
        const ana = ctx.box({ ...A, fill: v("c6-soft"), stroke: v("c6") });
        if (compact) {
          st.ana = listLine(ana, cx(A), cy(A), [["Ana", { weight: 700 }], [" · friends: ", MUTED]], 13);
        } else {
          ana.append(ctx.text(cx(A), A.y + 18, "Ana", { size: 13, weight: 700 }),
            ctx.text(cx(A), A.y + 37, "friends", { size: 12, fill: v("muted") }));
          st.ana = listLine(ana, cx(A), A.y + 54, [], 12, true);
        }
        boxes.appendChild(ana);

        Object.entries(g.logs).forEach(([id, b]) => {
          boxes.appendChild(ctx.box({ ...b, fill: v("c1-soft"), stroke: v("c1") }));
          boxes.appendChild(ctx.text(b.x + 2, b.y - 9, LOG_TITLE[id], { size: fs, anchor: "start", weight: 700, fill: v("c1") }));
          const lag = id === "messages" ? MSG_LAG : sim.L, hi = lag > 1, under = sim.one && !compact;
          boxes.appendChild(ctx.text(under ? cx(b) : b.x + b.w - 8, under ? b.y + b.h + 13 : cy(b),
            (sim.one ? "consumer lag " : "lag ") + sec(lag),
            { size: fs, anchor: under ? "middle" : "end", fill: v(hi ? "warn" : "muted"), weight: hi ? 700 : null }));
          wire(wirePts(g, "in", b));
          wire(wirePts(g, "out", b));
        });

        // Notifier: its derived copy of Ana's friend list, plus anything it is holding back.
        const nb = ctx.box({ ...N, fill: v("c2-soft"), stroke: v("c2") });
        if (compact) {
          const y = sim.carry ? N.y + 17 : cy(N);
          st.copy = listLine(nb, cx(N), y, [["Notifier", { weight: 700 }], [" · copy: ", MUTED]], 13);
          st.held = ctx.text(cx(N), N.y + 37, "", { size: 11, weight: 700 });
        } else {
          const y = N.y + (sim.carry ? 18 : 30);
          nb.append(ctx.text(cx(N), y, "Notifier", { size: 13, weight: 700 }),
            ctx.text(cx(N), y + 22, "Ana's friends (copy)", { size: 12, fill: v("muted") }));
          st.copy = listLine(nb, cx(N), y + 40, [], 12, true);
          st.held = ctx.text(cx(N), N.y + 84, "", { size: 12, weight: 700 });
        }
        nb.appendChild(st.held);
        st.setHeld = (str, tn) => { st.held.textContent = str; st.held.style.fill = v(tn); };
        if (sim.carry) st.setHeld("nothing held", "muted");
        boxes.appendChild(nb);

        Object.entries(g.phones).forEach(([name, b]) => {
          const pb = ctx.box({ ...b, fill: v("c6-soft"), stroke: v("c6") });
          const sub = ctx.text(cx(b), b.y + (compact ? 31 : 34), "no alerts", { size: fs, fill: v("muted") });
          pb.append(ctx.text(cx(b), b.y + (compact ? 15 : 17), name, { size: 13, weight: 700 }), sub);
          boxes.appendChild(pb);
          st.phones[name] = { box: pb, sub };
          wire(wirePts(g, "push", b));
        });

        // Timeline: when each event was written and when the Notifier processed it.
        svg.appendChild(ctx.text(g.tlTitle.x, g.tlTitle.y, g.tlTitle.text, { size: fs, anchor: "start", fill: v("muted") }));
        const tl = ctx.lanes({
          parent: svg, ...g.tl, t0: 0, t1: T1, labelSize: fs,
          lanes: [{ id: "w", label: "written", color: "c6" }, { id: "n", label: "notifier", color: "c2" }],
        });
        const grid = s("g");
        tl.root.insertBefore(grid, tl.content);
        for (let t = 0; t <= T1; t += 0.5) {
          const x = tl.x(t);
          grid.appendChild(s("line", { x1: x, x2: x, y1: g.tl.y, y2: g.tl.y + g.tl.h, stroke: v("grid") }));
          if (Number.isInteger(t / g.tick)) {
            grid.appendChild(ctx.text(x, g.tl.y + g.tl.h + 10, t ? t + " s" : "0", { size: 11, fill: v("muted") }));
          }
        }
        const cur = s("g", { display: "none" });
        const curLine = s("line", { y1: g.tl.y, y2: g.tl.y + g.tl.h, stroke: v("muted"), "stroke-width": 1.2, "stroke-dasharray": "3 3" });
        const curText = ctx.text(0, g.tl.y + 3, "", { size: 11, weight: 700, fill: v("muted"), anchor: "start", baseline: "hanging", halo: true });
        cur.append(curLine, curText);
        // Under the lane content, so haloed labels such as "push Ben, Cal" stay readable where the cursor crosses them.
        tl.root.insertBefore(cur, tl.content);
        st.cursor = t => {
          cur.setAttribute("display", t === null ? "none" : "");
          if (t === null) return;
          ctx.attr(curLine, { x1: tl.x(t), x2: tl.x(t) });
          ctx.attr(curText, { x: tl.x(t) + 4 });
          curText.textContent = "now " + sec(t);
        };
        st.tl = tl;
        st.packets = s("g");
        svg.appendChild(st.packets);
        return st;
      }

      function addCell(st, ev) {
        const c = cellRect(st.g, ev), col = EV_COLOR[ev.id], two = ev.needs > 0;
        const cell = ctx.box({ ...c, rx: 5, fill: v(col + "-soft"), stroke: v(col) });
        cell.appendChild(ctx.text(cx(c), cy(c) - (two ? 6 : 0), ev.id === "F1" ? "F1 unfriend" : "M1 post", { size: st.g.fs, weight: 700 }));
        if (two) cell.appendChild(ctx.text(cx(c), cy(c) + 8, "needs v" + ev.needs, { size: 11, fill: v("muted") }));
        st.cells.appendChild(cell);
      }

      // Label under a notifier-lane mark, moved down a row if it would overlap an earlier one.
      function nLabel(st, t, str, col) {
        const { tl, g } = st, x = tl.x(t), half = (str.length * g.fs * 0.6 + 6) / 2;
        let row = 0;
        while ((st.nRows[row] || []).some(([a, b]) => x - half < b && a < x + half)) row++;
        (st.nRows[row] = st.nRows[row] || []).push([x - half, x + half]);
        const y = tl.y("n") + 20 + row * (g.fs + 3);
        const label = tl.content.appendChild(ctx.text(x, y, str, { size: g.fs, weight: 700, fill: v(col), halo: true }));
        // A background plate, so the "now" cursor and grid lines don't show through between the letters.
        const w = (label.getComputedTextLength && label.getComputedTextLength()) || 2 * half - 6;
        tl.content.insertBefore(s("rect", { x: x - w / 2 - 3, y: y - g.fs / 2 - 2, width: w + 6, height: g.fs + 4, rx: 3, fill: v("bg") }), label);
      }

      // Held bar on the notifier lane: a stub now, grown to the release time later.
      function startHold(st, t) {
        const { tl, g } = st, x = tl.x(t), y = tl.y("n") - 9, w0 = tl.x(t + 0.15) - x;
        const under = s("rect", { x, y, width: w0, height: 18, rx: 5, fill: v("bg") });
        const bar = s("rect", { x, y, width: w0, height: 18, rx: 5, fill: v("warn-soft"), stroke: v("warn"), "stroke-width": 1.4, "stroke-dasharray": "4 3" });
        const label = ctx.text(x + w0 + 5, y + 9, "held", { size: g.fs, weight: 700, anchor: "start", fill: v("warn"), halo: true });
        const grp = s("g");
        grp.append(under, bar, label);
        tl.content.insertBefore(grp, tl.content.firstChild);
        st.hold = async tEnd => {
          const w1 = tl.x(tEnd) - x;
          await ctx.tween({ ms: 500, onUpdate: k => [under, bar].forEach(r => r.setAttribute("width", w0 + (w1 - w0) * k)) });
          bar.removeAttribute("stroke-dasharray");
          ctx.attr(label, { x: x + w1 / 2, "text-anchor": "middle" });
          label.textContent = "held " + sec(tEnd - t);
        };
      }

      // Where the F1 and M1 arrows cross: the post overtook the unfriend.
      function drawCrossing(st, sim) {
        const { tl, g } = st, pad = Math.min(10, tl.laneHeight * 0.25);
        const ya = tl.y("w") + pad, yb = tl.y("n") - pad;
        const a0 = tl.x(sim.F1.written), a1 = tl.x(sim.F1.arrive), b0 = tl.x(sim.M1.written), b1 = tl.x(sim.M1.arrive);
        const k = (b0 - a0) / ((a1 - a0) - (b1 - b0)), x = a0 + k * (a1 - a0), y = ya + k * (yb - ya);
        const tn = sim.inverted ? "bad" : "warn";
        st.ring = s("circle", { cx: x, cy: y, r: 7, fill: "none", stroke: v(tn), "stroke-width": 2 });
        tl.overlay.append(st.ring, s("circle", { cx: x, cy: y, r: 3, fill: v(tn) }),
          ctx.text(x + 11, y - 12, sim.inverted ? "order inverted" : "arrived out of order", { size: g.fs, weight: 700, anchor: "start", fill: v(tn), halo: true }));
      }

      function grow(path, ms) {
        const [x1, y1, x2, y2] = path.getAttribute("d").match(/-?[\d.]+/g).map(Number);
        const set = k => path.setAttribute("d", `M${x1},${y1} L${x1 + (x2 - x1) * k},${y1 + (y2 - y1) * k}`);
        set(0.02);
        return ctx.tween({ ms, onUpdate: set });
      }
      const fly = (st, [from, to], label, fill) => ctx.fly(st.packets, { from, to, label, fill, ms: 650, labelSize: st.g.fs });

      // ---------- steps ----------
      async function writeStep(st, ev) {
        st.cursor(ev.written);
        await fly(st, writePath(st.g, ev), ev.id, v(EV_COLOR[ev.id]));
        addCell(st, ev);
        if (ev.id === "F1") setList(st.ana, AFTER_F1);
        st.tl.mark("w", ev.written, { color: EV_COLOR[ev.id], label: ev.id, size: st.g.fs });
      }

      async function pushAll(st, t, to) {
        await Promise.all(to.map(name => fly(st, pushPath(st.g, name), "push", v(name === "Ben" ? "bad" : "ok"))));
        to.forEach(name => {
          const ph = st.phones[name], tn = name === "Ben" ? "bad" : "ok";
          ctx.attr(ph.box.rect, { fill: v(tn + "-soft"), stroke: v(tn) });
          ctx.attr(ph.sub, { fill: v(tn), "font-weight": 700 });
          ph.sub.textContent = "1 alert from Ana";
        });
        const tn = to.includes("Ben") ? "bad" : "ok";
        st.tl.mark("n", t, { tone: tn });
        nLabel(st, t, "push " + to.join(", "), tn);
      }

      async function readStep(st, sim, rd, i) {
        const { tl, g } = st, ev = rd.ev, col = EV_COLOR[ev.id];
        st.cursor(rd.t);
        const arrow = tl.msg("w", ev.written, "n", rd.t, { color: col });
        arrow.line.setAttribute("stroke-width", 2.2);
        await Promise.all([fly(st, readPath(g, ev), ev.id, v(col)), grow(arrow.line, 650)]);
        if (i === 1 && sim.overtaken) drawCrossing(st, sim);
        if (rd.kind === "hold") {
          st.setHeld(`held: M1 (needs v${ev.needs}` + (compact ? `, copy is v${rd.before.v})` : ")"), "warn");
          startHold(st, rd.t);
          return;
        }
        if (rd.kind === "apply") {
          setList(st.copy, rd.after);
          tl.mark("n", rd.t, { color: "c5" });
          nLabel(st, rd.t, "copy → v" + rd.after.v, "c5");
          if (!rd.release) return;
          st.setHeld("released M1", "ok");
          await st.hold(rd.t);
        } else if (rd.before.v < AFTER_F1.v) {
          setList(st.copy, rd.before, "bad");   // pushing with a copy older than what Ana saw
        }
        await pushAll(st, rd.t, rd.pushes[0].to);
      }

      async function resultStep(st, sim) {
        st.cursor(null);
        if (sim.ben === null) {
          ctx.attr(st.phones.Ben.box.rect, { stroke: v("ok") });
          ctx.attr(st.phones.Ben.sub, { fill: v("ok"), "font-weight": 700 });
        }
        const pulses = Object.values(st.phones).map(ph => ctx.animate(ph.box.rect, { "stroke-width": 3 }, 400));
        if (st.ring) pulses.push(ctx.animate(st.ring, { r: 11, "stroke-width": 2.6 }, 400));
        await Promise.all(pulses);
      }

      function stepsFor(sim) {
        const logOf = ev => (sim.one ? "the shared log" : "the " + LOG_TITLE[ev.log]);
        return [
          { title: `Ana unfriends Ben (t = ${sim.F1.written.toFixed(1)} s).`,
            detail: `F1 is appended to ${logOf(sim.F1)}. Ana's own friend list is now v${AFTER_F1.v}.`,
            run: st => writeStep(st, sim.F1) },
          { title: `Ana posts “Ben is so annoying” to her friends (t = ${sim.M1.written.toFixed(1)} s).`,
            detail: `M1 is appended to ${logOf(sim.M1)}.` + (sim.carry ? ` It records that Ana's app showed friends v${sim.M1.needs}.` : ""),
            run: st => writeStep(st, sim.M1) },
          ...sim.reads.map((rd, i) => ({ title: readTitle(rd), detail: readDetail(sim, rd), run: st => readStep(st, sim, rd, i) })),
          { title: "Result", detail: resultDetail(sim), run: st => resultStep(st, sim) },
        ];
      }

      // ---------- controls ----------
      function refresh(sim, i, last) {
        const st = statsAt(sim, i, last);
        Object.keys(st).forEach(k => view.stats.set(k, ...st[k]));
        view.note.set(...(i === last ? endNote(sim) : i < 0 ? [INTRO_NOTE, "info"] : [RUN_NOTE, "info"]));
      }

      // A fresh stepper for the current configuration; `at` replays to that step (layout rebuilds).
      function newPlayer(at) {
        if (player) player.pause();
        ctx.instant = true;                          // let the old player's running step finish at once
        ctx.after(0, () => { ctx.instant = false; });
        const my = ++gen, sim = simulate(cfg), steps = stepsFor(sim), last = steps.length - 1;
        player = ctx.stepper({
          init() {
            const st = drawScene(sim);
            if (my === gen) view.slot.replaceChildren(st.svg);   // an abandoned player draws off-screen
            return st;
          },
          steps,
          delay: 1300,
          intro: sim.one
            ? "Both services append to <b>one shared log</b>, which the Notifier reads in order. Press <b>Play</b>."
            : "Friendships and messages go to <b>two logs</b>, each read by its own consumer. Press <b>Play</b>.",
          onStep: i => { if (my === gen) refresh(sim, i, last); },
        });
        view.playerSlot.replaceChildren(player.el);
        refresh(sim, -1, last);
        if (at >= 0) player.goto(at);
      }

      function syncControls() {
        const one = cfg.flow === "one";
        view.lagSeg.querySelector(".viz-seg-label").textContent = one ? "Consumer lag" : "Friendships consumer lag";
        view.fixSeg.querySelectorAll("button").forEach(b => { b.disabled = one; b.style.cursor = one ? "not-allowed" : ""; });
        view.fixSeg.style.opacity = one ? 0.45 : "";
        view.fixSeg.title = one ? "Only matters when events flow through two logs" : "";
      }

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const seg = (key, label, options) => ui.segmented({
          label, value: cfg[key], options, onChange: val => { cfg[key] = val; syncControls(); newPlayer(-1); },
        });
        view = {
          flowSeg: seg("flow", "Events flow through", [{ value: "one", label: "One log" }, { value: "two", label: "Two logs" }]),
          lagSeg: seg("lag", "Friendships consumer lag", [{ value: "low", label: "Low (0.2 s)" }, { value: "high", label: "High (2 s)" }]),
          fixSeg: seg("fix", "Fix", [{ value: "none", label: "None" }, { value: "carry", label: "Carry version seen" }]),
          stats: ui.stats([
            { key: "ben", label: "Ben notified?" }, { key: "cal", label: "Cal notified at" },
            { key: "wait", label: "Waited for causality" }, { key: "order", label: "Order at notifier" },
          ]),
          note: ui.note(INTRO_NOTE, "info"),
          slot: h("div"),
          playerSlot: h("div"),
        };
        // The break keeps Fix on its own row, so the lag label changing length never reflows the bar.
        const brk = h("div", { style: "flex-basis:100%;height:0" });
        root.append(ui.bar(view.flowSeg, view.lagSeg, brk, view.fixSeg), view.slot,
          ui.legend([
            { color: v("c6"), label: "user / device", shape: "square" },
            { color: v("c1"), label: "log", shape: "square" },
            { color: v("c2"), label: "derived view (Notifier)", shape: "square" },
            { color: v("c5"), label: "F1 unfriend", shape: "line" },
            { color: v("c6"), label: "M1 post", shape: "line" },
            { color: v("warn"), label: "held for a dependency", shape: "square" },
            { color: v("bad"), label: "causality violated", shape: "dot" },
          ]), view.playerSlot, view.stats, view.note);
        syncControls();
      }

      build();
      newPlayer(-1);
      ctx.onResize(() => {
        if (ctx.compact === compact) return;
        const at = player ? player.index : -1;
        build();
        newPlayer(at);
      });
    },
  });
})();
