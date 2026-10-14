// Datalog evaluation as a staircase: rows are places, columns are rounds of semi-naive
// bottom-up evaluation. R1 fills round 1, R2 pushes every place's reach one level further up
// each round, and the first round that derives nothing is the fixpoint. Only then does R3
// (migrated) run on the finished within_recursive, and the query picks out Lucy and Sam.
Viz.register("ch2/datalog-fixpoint", {
  title: "Datalog rules reach a fixpoint",
  mount(root, ctx) {
    const { s, h, ui } = ctx;

    // ---- model ----
    const BASE = [
      ["name", "na", "North America"], ["name", "us", "United States"], ["name", "idaho", "Idaho"],
      ["name", "boise", "Boise"], ["name", "eu", "Europe"], ["name", "uk", "United Kingdom"],
      ["name", "london", "London"], ["name", "lucy", "Lucy"], ["name", "sam", "Sam"],
      ["within", "us", "na"], ["within", "idaho", "us"], ["within", "boise", "idaho"],
      ["within", "uk", "eu"], ["within", "london", "uk"],
      ["born_in", "lucy", "idaho"], ["lives_in", "lucy", "london"],
      ["born_in", "sam", "boise"], ["lives_in", "sam", "uk"],
    ];
    const QUERY = ["United States", "Europe"];   // ?- migrated(Who, 'United States', 'Europe').

    // Ada County inserts a level: within(boise, idaho) becomes boise -> ada -> idaho.
    function dataset(ada) {
      if (!ada) return BASE;
      return BASE.flatMap(f =>
        f[0] === "within" && f[1] === "boise" ? [["within", "boise", "ada"], ["within", "ada", "idaho"]]
          : f[0] === "name" && f[1] === "boise" ? [f, ["name", "ada", "Ada County"]] : [f]);
    }

    // Semi-naive bottom-up evaluation. rounds[i] holds the within_recursive facts first derived in
    // round i + 1; the last entry is the empty round (the fixpoint). Each R2 fact remembers the
    // fact it was joined from. migrated (R3) is evaluated after the fixpoint: dependency order.
    function evaluate(facts) {
      const pick = p => facts.filter(f => f[0] === p).map(f => [f[1], f[2]]);
      const names = pick("name"), within = pick("within"), bornIn = pick("born_in"), livesIn = pick("lives_in");
      const wr = new Map(), rounds = [];
      const add = (out, loc, name, round, from) => {
        const k = loc + "|" + name;
        if (!wr.has(k)) { const f = { loc, name, round, from }; wr.set(k, f); out.push(f); }
      };
      let delta = [];
      names.forEach(([loc, name]) => add(delta, loc, name, 1, null));                      // R1
      rounds.push(delta);
      while (delta.length) {                                                               // R2
        const next = [], r = rounds.length + 1;
        delta.forEach(f => within.forEach(([loc, via]) => { if (via === f.loc) add(next, loc, f.name, r, f); }));
        rounds.push(next);
        delta = next;
      }
      const reach = loc => [...wr.values()].filter(f => f.loc === loc);
      const migrated = [];                                                                 // R3
      names.forEach(([p, who]) => bornIn.filter(b => b[0] === p).forEach(([, bl]) => reach(bl).forEach(b =>
        livesIn.filter(l => l[0] === p).forEach(([, ll]) => reach(ll).forEach(l =>
          migrated.push({ who, person: p, bornIn: b.name, livingIn: l.name, proof: [b, l] }))))));
      return { names, within, bornIn, livesIn, wr, rounds, migrated, reach };
    }

    // Grid rows: one block per hierarchy (in name-fact order of its root), leaf first.
    // Assumes within() is a forest (no cycles), as in both datasets.
    function gridRows(m) {
      const parent = new Map(m.within), places = new Set(m.within.flat());
      const up = loc => (parent.has(loc) ? up(parent.get(loc)) : loc);
      const depth = loc => (parent.has(loc) ? 1 + depth(parent.get(loc)) : 0);
      const order = m.names.map(([loc]) => loc).filter(loc => places.has(loc));
      return [...new Set(order.map(up))].map(top =>
        order.filter(loc => up(loc) === top).sort((a, b) => depth(b) - depth(a) || order.indexOf(a) - order.indexOf(b)));
    }
    // ---- end model ----
    // Expected, checked by a scratch test: default rounds add 9, 5, 3, 1, 0 within_recursive facts
    // (grid columns 7, 5, 3, 1; the other 2 are people), then 17 migrated: 18 + 17 = 35 derived.
    // Ada County: 10, 6, 4, 2, 1, 0 (columns 8, 6, 4, 2, 1), 19 migrated: 23 + 19 = 42.

    const PERSON = ["c6", "c5", "c1", "c8"];
    const MUTED = "var(--viz-muted)";
    const key = f => f.loc + "|" + f.name;
    const wrFact = f => `within_recursive(${f.loc}, '${f.name}')`;
    const migFact = f => `migrated('${f.who}', '${f.bornIn}', '${f.livingIn}')`;
    const baseFact = ([p, a, b]) => `${p}(${a}, ${p === "name" ? `'${b}'` : b})`;
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

    function scenario(ada) {
      const facts = dataset(ada), m = evaluate(facts), blocks = gridRows(m);
      const places = new Set(blocks.flat());
      const find = (rel, p) => (rel.find(r => r[0] === p) || [])[1];
      const people = m.names.filter(([id]) => !places.has(id)).map(([id, who], i) =>
        ({ id, who, color: PERSON[i % PERSON.length], born: find(m.bornIn, id), lives: find(m.livesIn, id) }))
        .filter(p => p.born && p.lives);
      const answers = m.migrated.filter(f => f.bornIn === QUERY[0] && f.livingIn === QUERY[1]);
      const rowIndex = new Map(blocks.flat().map((loc, i) => [loc, i]));
      return { facts, m, blocks, places, people, answers, rowIndex, D: m.rounds.length - 1 };
    }
    const derivedThrough = (S, r) => S.m.rounds.slice(0, r).reduce((n, fs) => n + fs.length, 0);

    // ---- layout ----
    function layout(S) {
      const L = ctx.compact
        ? { W: 360, fs: 11, lh: 12, x0: 2, lx: 5, gx: 49, gx1: 358, sy: 13, hy: 31, top: 40, rowH: 35, chipH: 30,
            inset: 3, gap: 6, fm: 8, fh: 76, fq: 17, fp: [40, 61], pch: 19, fpad: 8 }
        : { W: 640, fs: 12, lh: 13, x0: 8, lx: 14, gx: 76, gx1: 632, sy: 14, hy: 34, top: 44, rowH: 36, chipH: 30,
            inset: 4, gap: 6, fm: 10, fh: 84, fq: 21, fp: [47, 70], pch: 21, fpad: 12 };
      L.colW = (L.gx1 - L.gx) / S.D;
      L.rowY = new Map();
      let y = L.top;
      S.blocks.forEach((b, i) => { if (i) y += L.gap; b.forEach(loc => { L.rowY.set(loc, y); y += L.rowH; }); });
      L.gridBottom = y;
      L.fy = y + L.fm;
      L.H = L.fy + L.fh + 4;
      return L;
    }
    const cellBox = (L, loc, r) => ({
      x: L.gx + (r - 1) * L.colW + L.inset, y: L.rowY.get(loc) + (L.rowH - L.chipH) / 2,
      w: L.colW - 2 * L.inset, h: L.chipH,
    });

    // ---- svg helpers ----
    const T = (L, x, y, str, o = {}) => ctx.text(x, y, str, { size: L.fs, anchor: "start", ...o });
    function textW(t, str, size) {
      let w = 0;
      try { w = t.getComputedTextLength(); } catch (e) { /* not rendered */ }
      return w || str.length * size * 0.56;
    }
    // One line when it fits in maxW, otherwise two lines split at the space nearest the middle.
    function fitText(L, parent, x, y, str, maxW, o) {
      const t = parent.appendChild(ctx.text(x, y, str, { size: L.fs, ...o }));
      const spaces = [...str].map((c, i) => (c === " " ? i : -1)).filter(i => i >= 0);
      if (!spaces.length || textW(t, str, L.fs) <= maxW) return t;
      const sp = spaces.reduce((a, b) => (Math.abs(b - str.length / 2) < Math.abs(a - str.length / 2) ? b : a));
      t.textContent = "";
      [str.slice(0, sp), str.slice(sp + 1)].forEach((line, i) => t.appendChild(s("tspan", { x, dy: i ? L.lh : -L.lh / 2 }, line)));
      return t;
    }
    const TONES = { fact: ["c2-soft", "c2", 1.2], fresh: ["warn-soft", "warn", 2], ok: ["ok-soft", "ok", 1.6] };
    function setTone(g, tone) {
      const [fill, stroke, w] = TONES[tone] || [tone + "-soft", tone, 1.4];
      ctx.attr(g.rect, { fill: `var(--viz-${fill})`, stroke: `var(--viz-${stroke})`, "stroke-width": w });
      return g;
    }
    function chip(L, layer, b, str, tone, o = {}) {
      const g = layer.appendChild(s("g"));
      g.append(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 6, fill: "var(--viz-bg)" }));
      g.rect = g.appendChild(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 6 }));
      fitText(L, g, b.x + b.w / 2, b.y + b.h / 2, str, b.w - 10, o);
      g.box = b;
      g.base = tone;
      return setTone(g, tone);
    }
    function ring(st, g, tone) {
      const b = g.box, p = 2;
      return st.g.marks.appendChild(s("rect", {
        x: b.x - p, y: b.y - p, width: b.w + 2 * p, height: b.h + 2 * p, rx: 8,
        fill: "none", stroke: `var(--viz-${tone})`, "stroke-width": 2.5, opacity: 0,
      }));
    }
    function band(st, loc, color) {
      const L = st.L;
      return st.g.band.appendChild(s("rect", {
        x: L.x0, y: L.rowY.get(loc) + 1, width: L.gx1 - L.x0, height: L.rowH - 2, rx: 6,
        fill: `var(--viz-${color}-soft)`, stroke: `var(--viz-${color})`, "stroke-width": 1, opacity: 0,
      }));
    }
    function setStatus(st, str, tone) {
      ctx.attr(st.status, { fill: tone ? `var(--viz-${tone})` : MUTED, "font-weight": tone ? 700 : 400 });
      st.status.textContent = str;
    }
    // Highlights the round being evaluated (r = 0 clears it).
    function setColumn(st, r) {
      const L = st.L;
      st.g.col.replaceChildren();
      if (r) st.g.col.appendChild(s("rect", { x: L.gx + (r - 1) * L.colW, y: L.top - 2, width: L.colW,
        height: L.gridBottom - L.top + 4, rx: 6, fill: "var(--viz-warn-soft)" }));
      st.heads.forEach((t, i) => ctx.attr(t, { fill: i + 1 === r ? "var(--viz-warn)" : MUTED, "font-weight": i + 1 === r ? 700 : 400 }));
    }
    function setLine(p, str, o = {}) {
      p.line.textContent = str;
      p.line.setAttribute("class", o.mono ? "viz-mono" : "");
      ctx.attr(p.line, { fill: o.fill || "var(--viz-ink)" });
    }

    // ---- controls and panels ----
    let sc = scenario(false), compact = ctx.compact;
    const toggle = ui.toggle({
      label: "Add a level: Ada County (Boise → Ada County → Idaho)", value: false,
      onChange: v => {
        sc = scenario(v);
        steps.length = 0;            // the stepper keeps this array: swap the scenario in place
        steps.push(...buildSteps(sc));
        player.reset();              // fast-forwards any running step, then init() redraws
      },
    });
    const stats = ui.stats([
      { key: "base", label: "Base facts", value: sc.facts.length },
      { key: "derived", label: "Derived facts", value: 0 },
      { key: "round", label: "Round", value: "–" },
      { key: "answer", label: "Answer", value: "–" },
    ]);
    const svgHost = h("div");
    const legend = ui.legend([
      { color: "var(--viz-c2)", label: "derived within_recursive fact", shape: "square" },
      { color: "var(--viz-warn)", label: "new this round", shape: "square" },
      { color: "var(--viz-ok)", label: "proves the answer", shape: "square" },
    ]);

    // [label, head, body atoms, how many atoms share a line on desktop (the first group joins the head)]
    const RULES = [
      ["R1", "within_recursive(Loc, Name)", ["name(Loc, Name)"], [1]],
      ["R2", "within_recursive(Loc, Name)", ["within(Loc, Via)", "within_recursive(Via, Name)"], [0, 2]],
      ["R3", "migrated(Name, BornIn, LivingIn)", ["name(Person, Name)", "born_in(Person, BornLoc)",
        "within_recursive(BornLoc, BornIn)", "lives_in(Person, LivingLoc)", "within_recursive(LivingLoc, LivingIn)"], [1, 2, 2]],
      ["?-", "migrated(Who, 'United States', 'Europe').", [], [0]],
    ];
    const ruleEls = new Map();
    const pre = h("pre", { style: "margin:0;padding:6px 0;font-size:12px;line-height:1.55;white-space:pre-wrap;" +
      "overflow-wrap:anywhere;background:none;border-radius:0" });
    // Desktop groups atoms as in RULES; phones put one atom per line. Wrapped lines hang 2ch deeper.
    function renderRules(phone) {
      ruleEls.clear();
      pre.replaceChildren(...RULES.map(([id, head, body, groups]) => {
        const lines = [], atoms = body.map((a, i) => a + (i === body.length - 1 ? "." : ","));
        (phone ? [0, ...atoms.map(() => 1)] : groups).reduce((at, n, gi) => {
          const part = atoms.slice(at, at + n).join(" ");
          lines.push(gi ? "    " + part : head + (body.length ? " :-" : "") + (part ? " " + part : ""));
          return at + n;
        }, 0);
        const el = h("span", { style: "display:block;padding:2px 12px" }, lines.map((line, i) =>
          h("span", { style: `display:block;padding-left:${i ? 10 : 6}ch;text-indent:-${i ? 10 : 6}ch` },
            h("b", { style: "color:var(--text-muted);display:inline-block;width:4ch;text-indent:0" }, i ? "" : id), line)));
        ruleEls.set(id, el);
        return el;
      }));
    }
    function setRule(id, tone) {
      ruleEls.forEach((el, k) => {
        const on = k === id;
        el.style.background = on ? `var(--viz-${tone}-soft)` : "transparent";
        el.style.boxShadow = on ? `inset 3px 0 0 var(--viz-${tone})` : "none";
      });
    }
    const rules = h("div", { class: "viz-log", style: "margin-top:12px" },
      h("div", { class: "viz-log-title" }, "Rules (highlighted while they run)"), pre);
    const log = ui.log({ title: "Derived this step", height: 142 });   // fits a full step (6 rows)
    log.style.marginTop = "12px";
    const logRows = log.querySelector(".viz-log-list");
    const say = (html, tone) => { log.add(html, tone); logRows.scrollTop = 0; };   // read from the top
    function logList(lines, extra = "") {
      const shown = lines.length > 6 ? lines.slice(0, 5) : lines;
      shown.forEach(l => say(l));
      if (shown.length < lines.length) say(`… and ${lines.length - shown.length} more${extra}`, "muted");
    }
    legend.appendChild(h("span", { class: "muted" }, "Tap a chip to trace how it was derived."));

    root.append(ui.bar(toggle), svgHost, legend);

    // ---- scene (rebuilt by init on reset, back, toggle and layout change) ----
    function init() {
      const S = sc, L = layout(S);
      const svg = ctx.svg({ w: L.W, h: L.H, label: "Derived within_recursive facts: one row per place, one column per evaluation round" });
      svgHost.replaceChildren(svg);
      const g = {};
      ["bg", "col", "band", "lbl", "chips", "marks"].forEach(k => { g[k] = svg.appendChild(s("g")); });
      const st = { S, L, g, chips: new Map(), person: new Map(), fresh: [], heads: [] };
      const parent = new Map(S.m.within), mid = L.rowH / 2;

      S.blocks.flat().forEach((loc, i) => {
        const y = L.rowY.get(loc), sub = parent.get(loc);
        if (i % 2 === 0) g.bg.appendChild(s("rect", { x: L.x0, y, width: L.gx1 - L.x0, height: L.rowH, rx: 4, fill: "var(--viz-grid)", opacity: 0.5 }));
        const dy = sub ? (ctx.compact ? 6.5 : 7) : 0;
        g.lbl.appendChild(T(L, L.lx, y + mid - dy, loc, { weight: 700, mono: true }));
        if (sub) g.lbl.appendChild(T(L, L.lx, y + mid + dy + 1, "in " + sub, { fill: MUTED }));
      });
      for (let r = 1; r < S.D; r++) {
        const x = L.gx + r * L.colW;
        g.bg.appendChild(s("line", { x1: x, x2: x, y1: L.top, y2: L.gridBottom, stroke: "var(--viz-grid)", "stroke-width": 1 }));
      }
      g.lbl.appendChild(T(L, L.lx, L.hy, "location", { fill: MUTED }));
      for (let r = 1; r <= S.D; r++) st.heads.push(g.lbl.appendChild(ctx.text(L.gx + (r - 0.5) * L.colW, L.hy, "round " + r, { size: L.fs, fill: MUTED })));
      st.status = g.lbl.appendChild(T(L, L.lx, L.sy, ""));
      setStatus(st, "Evaluation stops at the first round that derives nothing");

      // Footer: the query, and each person's base facts (later: R3's combinations, then the answer).
      g.lbl.appendChild(s("rect", { x: L.x0, y: L.fy, width: L.gx1 - L.x0, height: L.fh, rx: 8, fill: "var(--viz-panel)", stroke: "var(--viz-line)" }));
      g.lbl.appendChild(T(L, L.x0 + L.fpad, L.fy + L.fq, "?- migrated(Who, 'United States', 'Europe').", { mono: true }));
      S.people.slice(0, L.fp.length).forEach((p, i) => {
        const y = L.fy + L.fp[i], probe = g.lbl.appendChild(T(L, 0, y, p.who, { weight: 600 }));
        const w = textW(probe, p.who, L.fs) + 18;
        probe.remove();
        const pc = chip(L, g.lbl, { x: L.x0 + L.fpad, y: y - L.pch / 2, w, h: L.pch }, p.who, p.color, { weight: 600 });
        pc.line = g.lbl.appendChild(T(L, L.x0 + L.fpad + w + 10, y, ""));
        setLine(pc, `born_in ${p.born} · lives_in ${p.lives}`, { mono: true, fill: MUTED });
        st.person.set(p.id, pc);
      });

      log.clear();
      say("nothing derived yet", "muted");
      stats.set("base", S.facts.length).set("derived", 0).set("round", "–", "").set("answer", "–", "");
      renderRules(ctx.compact);
      setRule(null);
      return st;
    }

    // ---- steps ----
    function showBase(st) {
      const { S } = st, F = S.facts, first = S.blocks[0];
      const pick = (p, a) => F.find(f => f[0] === p && (a === undefined || f[1] === a));
      const sample = [pick("name", first[0]), pick("within", first[0]), pick("within", first[1]), pick("born_in"), pick("lives_in")].filter(Boolean);
      log.clear();
      sample.forEach(f => say(baseFact(f)));
      say(`… and ${F.length - sample.length} more (${F.length} base facts)`, "muted");
    }

    // Tapping a chip traces its derivation back to a name() fact: rings along the diagonal, proof
    // in the log. Tapping it again (or the next step) restores the step's log.
    function trace(st, f) {
      const again = st.trace && st.trace.key === key(f);
      clearTrace(st);
      if (again) return;
      const chain = [], els = [];
      for (let x = f; x; x = x.from) chain.push(x);
      chain.forEach(x => {
        const g = st.chips.get(key(x)), src = x.from && st.chips.get(key(x.from));
        if (!g) return;
        els.push(ctx.attr(ring(st, g, "info"), { opacity: 1 }));
        if (src) els.push(st.g.marks.appendChild(s("line", { x1: src.box.x + src.box.w - 6, y1: src.box.y + 3,
          x2: g.box.x + 6, y2: g.box.y + g.box.h - 3, stroke: "var(--viz-info)", "stroke-width": 2, "stroke-linecap": "round" })));
      });
      st.trace = { key: key(f), els, saved: logRows.innerHTML };
      log.clear();
      say(`why ${wrFact(f)}?`, "info");
      chain.forEach(x => say(x.from
        ? `round ${x.round}, R2: within(${x.loc}, ${x.from.loc}) + ${wrFact(x.from)}`
        : `round 1, R1: name(${x.loc}, '${x.name}')`, x.from ? "" : "muted"));
    }
    function clearTrace(st) {
      if (!st.trace) return;
      st.trace.els.forEach(el => el.remove());
      logRows.innerHTML = st.trace.saved;
      st.trace = null;
    }

    async function runRound(st, r) {
      const { S, L } = st, facts = S.m.rounds[r - 1];
      setRule(r === 1 ? "R1" : "R2", "warn");
      setColumn(st, r);
      const prev = st.fresh, moves = [];
      st.fresh = [];
      facts.forEach(f => {
        if (st.person.has(f.loc)) { st.fresh.push(setTone(st.person.get(f.loc), "fresh")); return; }
        if (!L.rowY.has(f.loc)) return;
        const b = cellBox(L, f.loc, r), g = chip(L, st.g.chips, b, f.name, "fresh");
        g.base = "fact";
        g.style.cursor = "pointer";
        g.addEventListener("click", () => trace(st, f));
        st.chips.set(key(f), g);
        st.fresh.push(g);
        // R1 chips slide in from the row label; R2 chips slide out of the fact they were joined from.
        const src = f.from && st.chips.get(key(f.from));
        moves.push(src ? { g, dx: src.box.x - b.x, dy: src.box.y - b.y } : { g, dx: L.lx - b.x, dy: 0, fade: true });
      });
      await ctx.tween({ ms: r === 1 ? 650 : 850, ease: "inOut", onUpdate: k => moves.forEach(mv => {
        mv.g.setAttribute("transform", `translate(${mv.dx * (1 - k)},${mv.dy * (1 - k)})`);
        if (mv.fade) mv.g.setAttribute("opacity", k);
      }) });
      prev.forEach(g => setTone(g, g.base));

      const people = facts.filter(f => !S.places.has(f.loc)).length;
      const n = facts.length, before = r > 1 ? S.m.rounds[r - 2].length : 0;
      setStatus(st, r === 1
        ? `Round 1: R1 derives ${plural(n, "fact")}` + (people ? ` (${people} about people)` : "")
        : `Round ${r}: R2 joins round ${r - 1}'s ${before} new → ${n} new`, "warn");
      stats.set("derived", derivedThrough(S, r)).set("round", r, "");
      log.clear();
      const order = f => (S.rowIndex.has(f.loc) ? S.rowIndex.get(f.loc) : 1e3);
      const sorted = facts.slice().sort((a, b) => order(a) - order(b));
      const hiddenPeople = sorted.slice(5).filter(f => !S.places.has(f.loc)).length;
      logList(sorted.map(wrFact), hiddenPeople && sorted.length > 6 ? `, incl. ${hiddenPeople} about people` : "");
    }

    async function runFixpoint(st) {
      const { S } = st, last = S.m.rounds[S.D - 1];
      setRule("R2", "ok");
      setColumn(st, 0);
      // The last round's new facts are R2's only input now; nothing comes out of them.
      const rings = st.fresh.filter(g => g.box && g.base === "fact").map(g => ring(st, g, "warn"));
      await ctx.tween({ ms: 900, onUpdate: k => rings.forEach(el => el.setAttribute("opacity", k < 0.3 ? k / 0.3 : (1 - k) / 0.7)) });
      rings.forEach(el => el.remove());
      st.fresh.forEach(g => setTone(g, g.base));
      st.fresh = [];
      setStatus(st, `Round ${S.D + 1}: nothing new → fixpoint ✓`, "ok");
      stats.set("round", "fixpoint", "ok");
      log.clear();
      last.forEach(f => {
        const kids = S.m.within.filter(([, via]) => via === f.loc).map(([loc]) => loc);
        say(kids.length ? `${wrFact(f)}: R2 only re-derives known facts` : `R2 needs within(_, ${f.loc}) to extend ${wrFact(f)}: there is none`, "muted");
      });
      say(`no new facts: within_recursive is complete (${S.m.wr.size} facts)`, "ok");
    }

    async function runMigrated(st) {
      const { S, L } = st, m = S.m;
      setRule("R3", "warn");
      const bands = [];
      S.people.forEach(p => {
        [p.born, p.lives].forEach(loc => { if (L.rowY.has(loc)) bands.push(band(st, loc, p.color)); });
        const pc = st.person.get(p.id), b = m.reach(p.born).length, l = m.reach(p.lives).length;
        if (pc) setLine(pc, `${p.born}: ${b} names × ${p.lives}: ${l} names = ${plural(b * l, "fact")}`);
      });
      await ctx.tween({ ms: 600, onUpdate: k => bands.forEach(el => el.setAttribute("opacity", k)) });
      stats.set("derived", m.wr.size + m.migrated.length);
      log.clear();
      const sample = [];
      S.people.forEach(p => {
        const mine = m.migrated.filter(f => f.person === p.id);
        sample.push(...new Set([mine[0], ...S.answers.filter(a => a.person === p.id)].filter(Boolean)));
      });
      sample.forEach(f => say(migFact(f)));
      say(`… and ${m.migrated.length - sample.length} more (${m.migrated.length} migrated facts)`, "muted");
    }

    async function runQuery(st) {
      const { S } = st;
      setRule("?-", "ok");
      const rings = [], bands = [...st.g.band.children];
      S.answers.forEach(a => a.proof.forEach(f => {
        const g = st.chips.get(key(f));
        if (g) { g.base = "ok"; setTone(g, "ok"); rings.push(ring(st, g, "ok")); }
      }));
      S.people.forEach(p => {
        const pc = st.person.get(p.id), a = S.answers.find(x => x.person === p.id);
        if (!pc) return;
        if (!a) { setLine(pc, "no match", { fill: MUTED }); return; }
        pc.base = "ok";
        setTone(pc, "ok");
        setLine(pc, `✓ ${a.proof[0].loc} → ${a.bornIn}, ${a.proof[1].loc} → ${a.livingIn}`, { fill: "var(--viz-ok)" });
      });
      await ctx.tween({ ms: 600, onUpdate: k => {
        rings.forEach(el => el.setAttribute("opacity", k));
        bands.forEach(el => el.setAttribute("opacity", 1 - 0.6 * k));   // the proofs take over from R3's rows
      } });
      stats.set("answer", S.answers.map(a => a.who).join(", ") || "none", S.answers.length ? "ok" : "bad");
      log.clear();
      say("?- migrated(Who, 'United States', 'Europe').", "muted");
      S.answers.forEach(a => {
        say(`Who = '${a.who}'`, "ok");
        say(`   via ${wrFact(a.proof[0])} and ${wrFact(a.proof[1])}`, "muted");
      });
    }

    // Steps capture their scenario, so a step still finishing after a toggle never reads the new one.
    function buildSteps(S) {
      const m = S.m, D = S.D;
      const people = m.names.filter(([id]) => !S.places.has(id));
      const combos = S.people.map((p, i) => {
        const b = m.reach(p.born).length, l = m.reach(p.lives).length;
        return `${p.who} ${b} × ${l} = ${b * l}${i ? "" : " facts"}`;
      }).join(", ");
      const list = S.answers.map(a => a.who);
      const out = [{
        title: "The database is just facts",
        detail: `${S.facts.length} facts shaped <code>predicate(subject, object)</code>: the graph's vertices and edges as triples.`,
        run: st => showBase(st),
      }];
      for (let r = 1; r <= D; r++) {
        const n = m.rounds[r - 2] ? m.rounds[r - 2].length : 0;
        out.push({
          title: r === 1 ? "Round 1: R1 says every place is within itself"
            : r === 2 ? "Round 2: R2 combines <code>within(L, Via)</code> with what we know about <code>Via</code>"
              : r === 3 ? "Round 3: one level further" : `Round ${r}`,
          detail: r === 1
            ? `R1 also matches ${people.map(([id, w]) => `<code>name(${id}, '${w}')</code>`).join(" and ")}, ` +
              `${people.length} harmless extra facts (their chips below flash too).`
            : r === 2
              ? "Semi-naive evaluation: R2 joins only the facts that were new in the previous round (amber) instead of redoing every earlier join."
              : `Only round ${r - 1}'s ${n} new ${n === 1 ? "fact is" : "facts are"} joined, so each place reaches one level further up.`,
          run: st => runRound(st, r),
        });
      }
      out.push({
        title: `Round ${D + 1} derives nothing new: fixpoint`,
        detail: "The recursion stops because the facts run out, not because of a depth limit. A deeper hierarchy just means more rounds.",
        run: st => runFixpoint(st),
      }, {
        title: "R3 builds on <code>within_recursive</code>: <code>migrated(Name, BornIn, LivingIn)</code>",
        detail: "Engines evaluate predicates in dependency order, so <code>migrated</code> runs only now that <code>within_recursive</code> is complete. " +
          `Bottom-up evaluation derives every combination: ${combos}. Real engines (e.g. with magic-sets rewriting) avoid deriving what the query doesn't need.`,
        run: st => runMigrated(st),
      }, {
        title: `The query matches ${plural(list.length, "fact")}: ${list.join(" and ") || "none"}`,
        detail: "Each answer rests on two <code>within_recursive</code> facts, outlined in green: the birthplace is within the United States and the home is within Europe.",
        run: st => runQuery(st),
      });
      return out.map(step => ({ ...step, run: st => { clearTrace(st); return step.run(st); } }));
    }

    const steps = buildSteps(sc);
    const player = ctx.stepper({
      init, steps, delay: 1300,
      intro: "Press <b>Play</b> to evaluate the rules bottom-up, one round at a time. Watch the staircase: each round pushes knowledge one level up the hierarchy.",
    });
    // Same order as the chapter's other stepper (mapreduce-purity): scene, player, stats, then panels.
    root.append(player.el, stats, rules, log);
    ctx.onResize(() => { if (ctx.compact !== compact) { compact = ctx.compact; player.goto(player.index); } });
  },
});
