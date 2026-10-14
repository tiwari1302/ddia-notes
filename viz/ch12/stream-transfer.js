// A transfer without 2PC (DDIA ch12, enforcing constraints). Request r-91 moves $50 from account
// A (partition P1) to account B (partition P2). One append to the request log is the commit
// point; a splitter derives a debit and a credit from it deterministically; each account
// processor applies its own partition's instructions, skipping request ids it already applied.
// Faults: the splitter crashes mid-request (its replay re-emits the debit), or P2 crashes before
// committing its offset (redelivery). Each step mutates a pure model and redraws, so Back/replay
// is exact. The meter counts money per request id, so a duplicated debit can't pass as "in flight".
Viz.register("ch12/stream-transfer", {
  title: "A transfer without 2PC",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const V = n => `var(--viz-${n})`;
    const paint = (el, st) => { for (const k in st) el.style.setProperty(k, st[k]); return el; };
    const show = (el, on) => { el.style.display = on ? "" : "none"; };
    const usd = v => "$" + v.toLocaleString("en-US");
    const REQ = { id: "r-91", from: "A", to: "B", amount: 50 };
    const START = 500, TOTAL = 2 * START;
    const LO = 850, HI = 1100;   // meter scale: zoomed so a $50 slice is clearly visible

    // ---------- layouts ----------
    const LAYOUTS = {
      desk: {
        W: 640, H: 330, fs: 12, short: false,
        client: { x: 12, y: 34, w: 96, h: 50 },
        req: { x: 130, y: 34, w: 200, h: 50 }, reqTitle: [130, 22], reqChip: { dx: 22, w: 150, h: 34 },
        splitter: { x: 160, y: 146, w: 150, h: 60, badge: "bottom" },
        P1: { x: 360, y: 34, w: 270, h: 46 }, P2: { x: 360, y: 196, w: 270, h: 46 },
        A: { x: 360, y: 110, w: 270, h: 54 }, B: { x: 360, y: 272, w: 270, h: 54 },
        meter: { x: 12, y: 266, w: 330 },
        chip: { w: 124, h: 34, gap: 6, pad: 8 },
        edges: [[108, 59, 128, 59], [227, 84, 227, 144], [310, 160, 358, 58], [310, 192, 358, 218],
          [376, 80, 376, 108], [376, 242, 376, 270]],
      },
      phone: {
        W: 360, H: 408, fs: 11, short: true,
        client: { x: 10, y: 24, w: 96, h: 46 },
        req: { x: 128, y: 24, w: 222, h: 46 }, reqTitle: [128, 12], reqChip: { dx: 22, w: 132, h: 34 },
        splitter: { x: 100, y: 96, w: 160, h: 60, badge: "top" },
        P1: { x: 10, y: 192, w: 165, h: 44 }, P2: { x: 185, y: 192, w: 165, h: 44, titleEnd: true },
        A: { x: 10, y: 266, w: 165, h: 60 }, B: { x: 185, y: 266, w: 165, h: 60 },
        meter: { x: 10, y: 344, w: 340 },
        chip: { w: 74, h: 34, gap: 6, pad: 5 },
        edges: [[106, 47, 126, 47], [216, 70, 216, 94], [150, 156, 120, 190], [210, 156, 240, 190],
          [22, 236, 22, 264], [197, 236, 197, 264]],
      },
    };
    const center = r => [r.x + r.w / 2, r.y + r.h / 2];
    const reqChipRect = L => ({ x: L.req.x + L.reqChip.dx, y: L.req.y + (L.req.h - L.reqChip.h) / 2, w: L.reqChip.w, h: L.reqChip.h });
    function chipRect(L, part, i) {
      const p = L[part], c = L.chip;
      return { x: p.x + c.pad + i * (c.w + c.gap), y: p.y + (p.h - c.h) / 2, w: c.w, h: c.h };
    }
    const chipLines = (msg, short) => [short ? (msg.delta < 0 ? "−" : "+") + usd(Math.abs(msg.delta))
      : `${msg.kind} ${msg.acct} ${usd(Math.abs(msg.delta))}`, msg.id];
    const TAGS = short => ({
      applied: ["✓ applied", "ok"],
      again: [short ? "(again)" : "(again) identical copy", "warn"],
      dropped: [short ? "✓ dropped" : "✓ duplicate dropped", "ok"],
      twice: [short ? "✗ applied 2×" : "✗ applied twice", "bad"],
      unsaved: [short ? "✓ applied, offset unsaved" : "✓ applied, offset not committed", "warn"],
      skipped: [short ? "✓ re-read: skipped" : "✓ re-read: duplicate skipped", "ok"],
    });

    // ---------- model ----------
    const newModel = () => ({
      req: [], ckpt: 0, down: null, restarted: null,
      logs: { P1: [], P2: [] },   // entries: { msg, status, tag }
      acct: { A: { bal: START, ids: [], twice: false }, B: { bal: START, ids: [], twice: false } },
      applied: {},                // request id -> { debit, credit } times applied
    });
    // The splitter's output is a pure function of the request, so a replay emits identical messages.
    const instructionsFor = r => [
      { part: "P1", acct: r.from, kind: "debit", delta: -r.amount, id: r.id },
      { part: "P2", acct: r.to, kind: "credit", delta: r.amount, id: r.id },
    ];
    function apply(m, msg, dedupe) {
      const a = m.acct[msg.acct];
      if (dedupe && a.ids.includes(msg.id)) return "dropped";
      const n = (m.applied[msg.id] = m.applied[msg.id] || { debit: 0, credit: 0 });
      a.bal += msg.delta;
      if (dedupe) a.ids.push(msg.id);   // saved atomically with the balance
      if (++n[msg.kind] > 1) { a.twice = true; return "twice"; }
      return "applied";
    }
    // Per request id, never per message: in flight = debited at least once, credit not yet applied.
    function invariant(m) {
      const sum = m.acct.A.bal + m.acct.B.bal;
      let inFlight = 0;
      m.req.forEach(r => { const n = m.applied[r.id]; if (n && n.debit > 0 && n.credit === 0) inFlight += r.amount; });
      const missing = TOTAL - sum - inFlight;
      return { sum, inFlight, missing, tone: missing ? "bad" : inFlight ? "warn" : "ok" };
    }
    function meterText({ sum, inFlight, missing }) {
      const parts = [];
      if (inFlight) parts.push(`+${usd(inFlight)} in flight`);
      if (missing > 0) parts.push(`${usd(missing)} missing`);
      if (missing < 0) parts.push(`${usd(-missing)} created`);
      return `A + B = ${usd(sum)}` + (parts.length ? ` (${parts.join(", ")})` : " ✓");
    }

    // ---------- controls and panels ----------
    const cfg = { fault: "splitter", dedupe: true };   // survives layout rebuilds
    let compact = ctx.compact, gen = 0, player = null;
    const faultSeg = ui.segmented({
      label: "Fault", value: cfg.fault,
      options: [{ value: "none", label: "None" }, { value: "splitter", label: "Splitter crash" }, { value: "redelivery", label: "Redelivery to P2" }],
      onChange: v => { cfg.fault = v; restart(); },
    });
    const dedupeToggle = ui.toggle({ label: "Deduplicate by request id", value: cfg.dedupe, onChange: v => { cfg.dedupe = v; restart(); } });
    const stage = h("div"), stepSlot = h("div"), nextSlot = h("div");
    const stats = ui.stats([
      { key: "A", label: "A" }, { key: "B", label: "B" }, { key: "sum", label: "A + B" },
      { key: "xpc", label: "Cross-partition commits", value: "0", tone: "info" },
    ]);
    const note = ui.note("");
    const legend = ui.legend([
      { color: V("c6"), label: "client", shape: "square" }, { color: V("c1"), label: "log partition", shape: "square" },
      { color: V("c2"), label: "account processor", shape: "square" }, { color: V("warn"), label: "in flight", shape: "square" },
      { color: V("bad"), label: "integrity violation", shape: "square" },
    ]);
    root.append(ui.bar(faultSeg, dedupeToggle), stage, legend, stepSlot, stats, note, nextSlot);

    // ---------- step helpers ----------
    // Every await goes through live(): once a control changes (gen bumps), a stale step parks
    // forever instead of drawing over the new scene.
    const live = (st, p) => p.then(v => (st.gen === gen ? v : new Promise(() => {})));
    const fly = (st, from, to, o) => live(st, ctx.fly(st.pk, { ms: 650, labelSize: st.L.fs, ...o, from, to }));
    const sleep = (st, ms) => live(st, ctx.sleep(ms));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    async function append(st) {
      const c = st.L.client;
      await fly(st, [c.x + c.w - 8, c.y + c.h / 2], center(reqChipRect(st.L)), { label: REQ.id, fill: V("c6") });
      st.m.req.push(REQ);
      render(st);
    }
    const readRequest = st => fly(st, center(reqChipRect(st.L)), center(st.L.splitter), { label: REQ.id, fill: V("c1") });
    // Emits the request's instructions (indexes into instructionsFor) in parallel.
    async function emit(st, which) {
      const { m, L } = st;
      const msgs = instructionsFor(m.req[m.ckpt]).filter((_, i) => which.includes(i));
      const dup = msg => m.logs[msg.part].some(e => same(e.msg, msg));
      await Promise.all(msgs.map(msg => fly(st, center(L.splitter), center(chipRect(L, msg.part, m.logs[msg.part].length)),
        { label: msg.kind, fill: V(dup(msg) ? "warn" : "c1") })));
      msgs.forEach(msg => {
        const again = dup(msg);
        m.logs[msg.part].push({ msg, status: again ? "dup" : "new", tag: again ? TAGS(L.short).again : null });
      });
      render(st);
    }
    async function consume(st, part, i, o = {}) {
      const e = st.m.logs[part][i], T = TAGS(st.L.short);
      await fly(st, center(chipRect(st.L, part, i)), center(st.L[e.msg.acct]),
        { label: chipLines(e.msg, true)[0], fill: V(e.status === "dup" || o.reread ? "warn" : "c1") });
      const res = apply(st.m, e.msg, st.conf.dedupe);
      if (res === "twice") { e.status = "twice"; e.tag = T.twice; }
      else if (res === "dropped") { e.status = o.reread ? "applied" : "dropped"; e.tag = o.reread ? T.skipped : T.dropped; }
      else { e.status = "applied"; e.tag = o.unsaved ? T.unsaved : T.applied; }
      render(st);
    }
    const crash = (st, who) => { st.m.down = who; render(st); return sleep(st, 450); };
    const recover = (st, who) => { st.m.down = null; st.m.restarted = who; render(st); return sleep(st, 300); };
    async function splitAll(st) {
      await readRequest(st);
      await emit(st, [0, 1]);
      st.m.ckpt = 1;
      render(st);
    }

    // ---------- the scripts ----------
    function makeSteps({ fault, dedupe }) {
      const S = [], step = (title, run, detail) => S.push({ title, run, detail });
      step("The client appends <b>r-91</b> (A→B $50) to the request log. This single durable append is the commit point: from now on the transfer will happen.", append);
      if (fault === "splitter") {
        step("The splitter reads r-91 and emits <b>debit A $50 (r-91)</b> to P1.",
          async st => { await readRequest(st); await emit(st, [0]); });
        step("<b>CRASH</b>: the splitter dies before emitting the credit and before checkpointing its input offset.",
          st => crash(st, "splitter"), "Its checkpoint still says offset 0, so r-91 counts as unprocessed.");
        step("P1's processor applies the debit: A = $450. A reader adding up A + B now sees $950: the credit is owed, not lost.",
          st => consume(st, "P1", 0),
          "Owed by whom? r-91 sits in the request log past the splitter's checkpoint, so the restarted splitter is bound to emit the credit.");
        step("The splitter restarts from its last checkpoint (offset 0) and re-processes r-91 deterministically: it emits the debit again and the credit.",
          async st => { await recover(st, "splitter"); await splitAll(st); },
          "Same input, same code, same output: the repeated debit is identical to the first, request id included. Then it checkpoints offset 1.");
        step(dedupe ? "P1 sees r-91 in its applied ids: the duplicate debit is dropped."
          : "P1 has no record of r-91, so it applies the debit again: A = $400.",
        st => consume(st, "P1", 1), dedupe ? "" : "Without a request id, a replayed instruction looks exactly like a new one.");
        step(dedupe ? "P2 applies the credit: B = $550. A + B = $1,000 again. No 2PC, no locks across partitions."
          : "P2 applies the credit: B = $550. A + B = $950 and nothing in flight: $50 has vanished, and no amount of waiting will bring it back.",
        st => consume(st, "P2", 0));
        return S;
      }
      step("The splitter emits both instructions, each tagged r-91, and checkpoints.", splitAll);
      step("P1 applies the debit first: A = $450 (P2 is a little slower). For a moment, $50 is in flight.", st => consume(st, "P1", 0));
      if (fault === "none") {
        step("P2 applies the credit: B = $550. Balanced.", st => consume(st, "P2", 0));
        return S;
      }
      step("P2 applies the credit (B = $550) but crashes before committing its offset.",
        async st => { await consume(st, "P2", 0, { unsaved: true }); await crash(st, "B"); },
        dedupe ? "The new balance and r-91 in its applied ids were saved together; the input offset was not, so P2 will read this message again."
          : "The new balance was saved, but not the input offset, so P2 will read this message again.");
      step(dedupe ? "On restart P2 re-reads credit r-91; r-91 is already in its applied ids (stored atomically with the balance), so it is skipped."
        : "P2 re-reads credit r-91 and applies it again: B = $600. A + B = $1,050: money was created.",
      async st => { await recover(st, "B"); await consume(st, "P2", 0, { reread: true }); });
      return S;
    }

    const INTRO = "Each partition only ever processes its own log, one message at a time. Press <b>Play</b> to see how a transfer stays correct without any cross-partition transaction.";
    function verdict({ fault, dedupe }) {
      if (fault === "none") return ["No fault: one durable append, two derived instructions, and two partitions that never coordinate. The only cost was a moment with $50 in flight. Now pick a fault.", "ok"];
      if (fault === "splitter") return dedupe
        ? ["Crash, replay, and the books still balance: the request id lets each partition recognize work it already did. The brief $950 was a timeliness lag, not an integrity violation.", "ok"]
        : ["Same crash, no request ids: replay duplicated an instruction and the invariant is broken permanently. That is the difference between late and wrong.", "bad"];
      return dedupe
        ? ["P2 read the credit twice, but r-91 was saved together with the balance, so the second read changed nothing: at-least-once delivery plus deduplication gives an exactly-once effect.", "ok"]
        : ["Same redelivery, no request ids: one credit applied twice created $50. Nothing in flight will cancel it out: this is an integrity violation, not a delay.", "bad"];
    }
    // What the invariant means right now, between the first and the last step.
    function reading(m) {
      const inv = invariant(m);
      if (inv.missing > 0) return [`The debit for r-91 was applied twice: ${usd(inv.missing)} is gone for good, on top of the $50 still in flight to B.`, "bad"];
      if (inv.missing < 0) return [`The credit for r-91 was applied twice: ${usd(-inv.missing)} was created.`, "bad"];
      if (inv.inFlight) return m.logs.P2.length
        ? ["$50 is in flight: the credit for r-91 already sits in P2's log, waiting to be applied.", "warn"]
        : ["$50 is owed, not lost: the credit isn't in any partition yet, but r-91 is durably in the request log and the splitter will re-read it.", "warn"];
      if (m.down === "B") return ["Balanced for now, but P2's committed offset still points at the credit, so it will read it again after restarting.", "info"];
      if (!m.applied[REQ.id]) return ["r-91 is durably in the request log: the transfer is decided, though no balance has changed yet.", "info"];
      return ["A + B = $1,000.", "ok"];
    }
    // The guided path through the idea: [button text, config change].
    const NEXT = {
      "none/true": ["a splitter crash", { fault: "splitter" }], "none/false": ["a splitter crash", { fault: "splitter" }],
      "splitter/true": ["the same crash without deduplication", { dedupe: false }],
      "splitter/false": ["a redelivery to P2", { fault: "redelivery", dedupe: true }],
      "redelivery/true": ["the redelivery without deduplication", { dedupe: false }],
    };
    function stepDone(st, i, n) {
      const last = i === n - 1, nx = last && NEXT[`${st.conf.fault}/${st.conf.dedupe}`];
      note.set(...(i < 0 ? [INTRO, "info"] : last ? verdict(st.conf) : reading(st.m)));
      nextSlot.replaceChildren();
      nextSlot.style.margin = nx ? "10px 0" : "";
      if (nx) nextSlot.appendChild(ui.button(`Try next: ${nx[0]} →`, () => {
        Object.assign(cfg, nx[1]);
        faultSeg.set(cfg.fault);
        dedupeToggle.set(cfg.dedupe);
        restart(false, true);
      }, { kind: "primary" }));
    }

    // ---------- scene ----------
    function badge(parent) {
      const g = s("g"), under = s("rect", { height: 20, rx: 10 }), rect = s("rect", { height: 20, rx: 10, "stroke-width": 1.4 });
      const t = ctx.text(0, 0, "", { size: 12, weight: 700 });
      g.append(paint(under, { fill: V("bg") }), rect, t);
      parent.appendChild(g);
      g.say = (str, tone, cx, cy) => {
        show(g, !!str);
        if (!str) return;
        t.textContent = str;
        const w = ((t.getComputedTextLength && t.getComputedTextLength()) || str.length * 7.5) + 18;
        [under, rect].forEach(r => ctx.attr(r, { x: cx - w / 2, y: cy - 10, width: w }));
        ctx.attr(t, { x: cx, y: cy + 1 });
        paint(rect, { fill: V(tone === "bad" ? "bad" : "info-soft"), stroke: V(tone) });
        paint(t, { fill: V(tone === "bad" ? "bg" : "info") });
      };
      return g;
    }
    function proc(st, r, title, fill, stroke, mono) {
      const g = ctx.box({ ...r, fill, stroke }), [cx, cy] = center(r);
      const dy = r.badge === "bottom" ? 0 : 3;   // clear of a badge sitting on the top edge
      g.label = ctx.text(cx, cy - 9 + dy, title, { size: 13, weight: 700 });
      g.sub = ctx.text(cx, cy + 11 + dy, "", { size: st.L.fs, fill: V("muted"), mono });
      g.append(g.label, g.sub);
      st.bg.appendChild(g);
      g.badge = badge(st.fx);
      g.badgeAt = [cx, r.badge === "bottom" ? r.y + r.h : r.y];
      g.stroke = stroke;
      return g;
    }
    function setProc(g, down, restarted, bad) {
      paint(g.rect, { stroke: down || bad ? V("bad") : g.stroke, "stroke-dasharray": down ? "6 4" : "none", "stroke-width": down || bad ? "2.4" : "1.5" });
      g.badge.say(down ? "CRASH" : restarted ? "restarted" : "", down ? "bad" : "info", ...g.badgeAt);
    }
    // A log partition: title above, "empty" until its first record arrives.
    function strip(st, r, title, at) {
      st.bg.appendChild(ctx.box({ ...r, rx: 6, fill: V("c1-soft"), stroke: V("c1") }));
      st.bg.appendChild(ctx.text(at[0], at[1], title, { size: st.L.fs, weight: 700, anchor: r.titleEnd ? "end" : "start", fill: V("c1") }));
      const empty = ctx.text(r.x + r.w / 2, r.y + r.h / 2 + 1, "empty", { size: st.L.fs, fill: V("muted") });
      st.bg.appendChild(empty);
      return empty;
    }
    // A log record: one or two mono lines.
    function chipEl(parent, r, lines, fs) {
      const g = s("g"), box = { x: r.x, y: r.y, width: r.w, height: r.h, rx: 5 }, [cx, cy] = center(r);
      g.rect = s("rect", { ...box, "stroke-width": 1.5 });
      g.texts = lines.map((str, i) => ctx.text(cx, lines.length > 1 ? cy + (i ? 8 : -7) : cy + 1, str, { size: fs, mono: true, weight: i ? null : 600 }));
      g.append(paint(s("rect", box), { fill: V("bg") }), g.rect, ...g.texts);
      parent.appendChild(g);
      return g;
    }
    const CHIP = {   // status -> [fill, stroke, text, dashed]
      new: ["node", "c1", "ink"], applied: ["ok-soft", "ok", "ink"], dup: ["node", "warn", "ink"],
      dropped: ["node", "ok", "muted", true], twice: ["bad-soft", "bad", "ink"],
    };
    function makeChip(st, part, i, e) {
      const r = chipRect(st.L, part, i), g = chipEl(st.chips, r, chipLines(e.msg, st.L.short), st.L.fs);
      const first = i === 0, P = st.L[part];
      // Verdict under the record; the first one starts right of the partition -> processor arrow.
      g.tag = ctx.text(first ? P.x + (st.L.short ? 18 : 26) : r.x + r.w, P.y + P.h + (st.L.short ? 12 : 10), "",
        { size: st.L.fs, weight: 700, anchor: first ? "start" : "end", halo: true });
      st.chips.appendChild(g.tag);
      return g;
    }
    function paintChip(g, e) {
      const [fill, stroke, ink, dashed] = CHIP[e.status];
      paint(g.rect, { fill: V(fill), stroke: V(stroke), "stroke-dasharray": dashed ? "4 3" : "none", "stroke-width": e.status === "dup" ? "2.2" : "1.5" });
      g.texts.forEach(t => paint(t, { fill: V(ink) }));
      g.tag.textContent = e.tag ? e.tag[0] : "";
      if (e.tag) paint(g.tag, { fill: V(e.tag[1]) });
    }

    function drawMeter(st) {
      const M = st.L.meter, fs = st.L.fs, g = st.bg, by = M.y + 18, bh = 20;
      const X = v => M.x + ((v - LO) / (HI - LO)) * M.w;
      g.appendChild(paint(s("rect", { x: M.x, y: by, width: M.w, height: bh, rx: 4 }), { fill: V("grid") }));
      const segs = [0, 1, 2].map(() => {
        const r = s("rect", { y: by, height: bh, rx: 3, "stroke-width": 1.4 });
        const t = ctx.text(0, by + bh / 2 + 1, "", { size: fs, weight: 600 });
        g.append(r, t);
        return { r, t };
      });
      // Axis break: the bar starts at $850, not at $0.
      g.appendChild(paint(s("path", { d: `M${M.x + 12},${by - 3} l-5,${bh + 6} M${M.x + 18},${by - 3} l-5,${bh + 6}`, fill: "none", "stroke-width": 3 }), { stroke: V("bg") }));
      [900, 950, 1000, 1050].forEach(v => g.appendChild(paint(s("line", { x1: X(v), x2: X(v), y1: by + bh, y2: by + bh + 4 }), { stroke: V("muted") })));
      [900, TOTAL].forEach(v => g.appendChild(ctx.text(X(v), by + bh + 13, usd(v), { size: fs, fill: V(v === TOTAL ? "ink" : "muted"), weight: v === TOTAL ? 700 : null })));
      const tx = X(TOTAL);
      g.appendChild(paint(s("line", { x1: tx, x2: tx, y1: by - 4, y2: by + bh + 4, "stroke-width": 2 }), { stroke: V("ink") }));
      st.meter = { X, segs, label: ctx.text(M.x, M.y + 6, "", { size: 13, weight: 700, anchor: "start" }) };
      g.appendChild(st.meter.label);
    }
    function renderMeter(st, inv) {
      const { X, segs, label } = st.meter, { sum, inFlight, missing } = inv;
      [[LO, Math.min(sum, TOTAL), "ok", "A + B"], [sum, sum + inFlight, "warn", "in flight"],
        missing > 0 ? [sum + inFlight, TOTAL, "bad", "missing"] : [TOTAL, sum, "bad", "created"],
      ].forEach(([a, b, tone, name], i) => {
        const { r, t } = segs[i], w = Math.max(0, X(b) - X(a));
        show(r, w > 0);
        show(t, w >= 44);
        ctx.attr(r, { x: X(a), width: w });
        paint(r, { fill: V(tone + "-soft"), stroke: V(tone), "stroke-dasharray": name === "missing" ? "4 3" : "none" });
        ctx.attr(t, { x: X(a) + w / 2 });
        t.textContent = name;
      });
      label.textContent = meterText(inv);
      paint(label, { fill: V(inv.tone) });
    }

    function drawScene(st) {
      const { L, bg } = st;
      L.edges.forEach(([x1, y1, x2, y2]) => bg.appendChild(ctx.arrow({ x1, y1, x2, y2, color: V("line"), svg: st.svg })));
      const c = L.client, [ccx, ccy] = center(c);
      bg.appendChild(ctx.box({ ...c, fill: V("c6-soft"), stroke: V("c6") }));
      bg.appendChild(ctx.text(ccx, ccy - 8, "Client", { size: 13, weight: 700 }));
      bg.appendChild(ctx.text(ccx, ccy + 10, "A→B $50", { size: L.fs, fill: V("muted") }));
      st.empty = { req: strip(st, L.req, "request log (by request id)", L.reqTitle) };
      st.reqChip = chipEl(bg, reqChipRect(L), [`${REQ.id}: A→B ${usd(REQ.amount)}`], L.fs);
      st.reqChip.appendChild(ctx.text(L.req.x + 11, L.req.y + L.req.h / 2 + 1, "0", { size: L.fs, mono: true, fill: V("muted") }));   // its offset
      paint(st.reqChip.rect, { fill: V("node"), stroke: V("c1") });
      st.split = proc(st, L.splitter, "Splitter", V("node"), V("node-stroke"), false);
      ["P1", "P2"].forEach((p, i) => { st.empty[p] = strip(st, L[p], `${p} (account ${"AB"[i]})`, [L[p].titleEnd ? L[p].x + L[p].w : L[p].x, L[p].y - 12]); });
      st.acct = { A: proc(st, L.A, "", V("c2-soft"), V("c2"), true), B: proc(st, L.B, "", V("c2-soft"), V("c2"), true) };
      drawMeter(st);
    }

    function render(st) {
      const { m, conf } = st, inv = invariant(m);
      show(st.reqChip, m.req.length > 0);
      show(st.empty.req, !m.req.length);
      ["P1", "P2"].forEach(p => show(st.empty[p], !m.logs[p].length));
      st.split.sub.textContent = `checkpoint: offset ${m.ckpt}`;
      setProc(st.split, m.down === "splitter", m.restarted === "splitter", false);
      ["A", "B"].forEach(k => {
        const a = m.acct[k], g = st.acct[k];
        g.label.textContent = `Account ${k}: ${usd(a.bal)}`;
        paint(g.label, { fill: V(a.twice ? "bad" : "ink") });
        g.sub.textContent = conf.dedupe ? `applied ids: {${a.ids.join(", ")}}` : "applied ids: not kept";
        setProc(g, m.down === k, m.restarted === k, a.twice);
        stats.set(k, usd(a.bal), a.twice ? "bad" : "");
      });
      ["P1", "P2"].forEach(p => m.logs[p].forEach((e, i) => paintChip(st.chipEls[p][i] || (st.chipEls[p][i] = makeChip(st, p, i, e)), e)));
      renderMeter(st, inv);
      stats.set("sum", usd(inv.sum), inv.tone);
    }

    // ---------- assembly ----------
    function build() {
      compact = ctx.compact;
      const L = LAYOUTS[compact ? "phone" : "desk"], conf = { ...cfg }, myGen = gen;
      const svg = ctx.svg({ w: L.W, h: L.H, label: "A $50 transfer from account A on partition P1 to account B on partition P2, derived from one request log entry" });
      const layers = {};
      ["bg", "chips", "fx", "pk"].forEach(k => svg.appendChild((layers[k] = s("g"))));
      stage.replaceChildren(svg);   // before init() draws, so badges can measure their text
      const steps = makeSteps(conf).map(({ title, detail, run }) => ({
        title, detail,
        run: async st => { st.m.restarted = null; render(st); await run(st); },   // "restarted" lasts one step
      }));
      const p = ctx.stepper({
        delay: 1400, steps,
        intro: "Move <b>$50</b> from A (partition P1) to B (partition P2) as request <b>r-91</b>. Invariant: A + B = <b>$1,000</b>.",
        // Fully redraws the scene: Back = init() + instant replay.
        init() {
          Object.values(layers).forEach(g => g.replaceChildren());
          const st = { gen: myGen, L, conf, svg, ...layers, m: newModel(), chipEls: { P1: [], P2: [] } };
          drawScene(st);
          render(st);
          stepDone(st, -1, steps.length);
          return st;
        },
        onStep: i => { if (p.state.gen === gen) stepDone(p.state, i, steps.length); },
      });
      player = p;
      stepSlot.replaceChildren(p.el);
    }
    function restart(keepStep, autoplay) {
      const idx = keepStep && player ? player.index : -1;
      gen++;
      if (player) player.pause();
      ctx.instant = true;   // finish the old script's in-flight tweens now; live() parks its step
      build();
      const p = player;
      ctx.after(0, () => {
        ctx.instant = false;
        if (p !== player) return;
        if (idx >= 0) p.goto(idx);
        else if (autoplay) p.play();
      });
    }

    build();
    // Rebuild outside the ResizeObserver callback (avoids "ResizeObserver loop" errors), keeping the step.
    ctx.onResize(() => ctx.after(0, () => { if (ctx.compact !== compact) restart(true); }));
  },
});
