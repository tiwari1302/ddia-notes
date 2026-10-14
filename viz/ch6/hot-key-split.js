// Hot keys (DDIA ch6, "hot spots"): a hash partitioner can only spread *distinct* keys, so every
// write to one viral key lands on one partition. Splitting the key into k sub-keys spreads its
// writes over up to k partitions, but every read must now fan out k ways and merge. Combining
// writes in the app is the other fix: no read fan-out, but counts lag and a crash loses increments.
(function () {
  "use strict";

  const N = 8, LIMIT = 1000, BASE = 500, HOME = 3, LIKES = 1284903;
  const COMBINED_MAX = 200;     // 20 app servers x one "+n" flush per 100 ms
  const Y0 = 230, YMAX = 2000;  // chart: y 230 is 0/s, y 30 is 2,000/s
  const Y = v => Y0 - Math.min(v, YMAX) * 0.1;
  const DEFAULTS = { H: 2500, k: 1, saltAll: false, combine: false };

  const num = v => Math.round(v).toLocaleString("en-US");
  const rate = v => (v >= 1000 || Number.isInteger(v) ? num(v) : v.toFixed(1));
  const pct = L => Math.round((L / LIMIT) * 100) + "%";
  const latencyOf = L => { const u = L / LIMIT; return u >= 1 ? 50 : Math.min(50, Math.round(2 / (1 - u))); };
  const order = p => (p - HOME + N) % N;   // sub-key order: P3, P4, ..., P7, P0, P1, P2
  const cap1 = t => t[0].toUpperCase() + t.slice(1);
  const listP = ps => {
    const n = ps.map(p => "P" + p);
    return n.length < 3 ? n.join(" and ") : n.slice(0, -1).join(", ") + " and " + n[n.length - 1];
  };

  // ---------------- Pure model (no DOM) ----------------
  function model({ H, k, combine }) {
    const E = combine ? Math.min(H, COMBINED_MAX) : H;   // post:42 writes that reach the database
    const per = E / k;
    const subkeys = Array.from({ length: N }, () => []);
    for (let j = 0; j < k; j++) subkeys[(HOME + j) % N].push(j);
    const load = subkeys.map(js => Math.round((BASE + js.length * per) * 1e6) / 1e6);
    const maxL = Math.max(...load);
    const hot = load.map((L, p) => p).filter(p => load[p] === maxL).sort((a, b) => order(a) - order(b));
    return {
      E, per, subkeys, load, maxL, hot,
      throttled: load.reduce((a, L) => a + Math.max(0, L - LIMIT), 0),
      latency: load.map(latencyOf),
    };
  }

  /** A like-count read asks every sub-key; it is as slow as the slowest partition plus a merge. */
  function readResult(m, k) {
    const parts = m.subkeys.map((js, p) => p).filter(p => m.subkeys[p].length).sort((a, b) => order(a) - order(b));
    const slowMs = Math.max(...parts.map(p => m.latency[p]));
    const slowest = parts.find(p => m.latency[p] === slowMs);
    const counts = Array.from({ length: k }, (_, j) => Math.floor(LIKES / k) + (j === 0 ? LIKES % k : 0));
    return {
      k, parts, slowest, slowMs, ms: slowMs + (k - 1), counts,
      tie: parts.length > 1 && parts.every(p => m.latency[p] === slowMs),
      saturated: m.load[slowest] >= LIMIT,
    };
  }

  // Who is hottest, as a sentence subject: "P3 runs", "all 8 partitions run", "P3 and P4 each run".
  function hottest(m, verb) {
    if (m.hot.length === N) return `all ${N} partitions ${verb}`;
    if (m.hot.length === 1) return `P${m.hot[0]} ${verb}s`;
    return `${listP(m.hot)} each ${verb}`;
  }

  function ruleNote(m, st) {
    const { H, k, combine } = st, over = m.maxL > LIMIT, atLimit = m.maxL === LIMIT;
    if (H === 0) {
      return ["No hot key right now: plain hashing keeps every partition at 50%. Splitting cold keys would only add read cost" +
        (k > 1 ? `: every like-count read still pays <b>${k} requests</b> for nothing.` : "."), "info"];
    }
    if (combine && !over) {
      return [`<b>Batching:</b> 20 app servers each send one "+n" write per 100 ms, so post:42 costs the database at most ` +
        `<b>200 writes/s</b> (instead of ${num(H)}) however viral it gets, with no read fan-out needed. ` +
        "The price: the count lags by up to 100 ms, and increments buffered in a server that crashes are lost " +
        "(fine for likes, not for payments)." +
        (k > 1 ? ` The ${k}-way split is now pure cost: every like-count read still pays ${k} requests.` : ""), "ok"];
    }
    if (k === 1 && over) {
      return [`All <b>${num(m.E)}</b> writes/s for post:42 carry the same key, so they hash to the same partition: ` +
        `<b>P3 runs at ${pct(m.load[HOME])}</b> of its limit and throttles <b>${num(m.throttled)}</b> writes/s ` +
        "while the other seven sit at 50%. More partitions would not help: one key never spans two partitions. " +
        "Drag <b>Split into k sub-keys</b> up.", "bad"];
    }
    if (k === 1) {
      return [`post:42 adds ${num(m.E)} writes/s to P3, which runs at <b>${pct(m.load[HOME])}</b>: ` +
        (atLimit ? "exactly at its limit, with no headroom left. " : "busier than the rest, but within its limit. ") +
        "One partition can still absorb it, so splitting would only make reads cost more.", atLimit ? "warn" : "ok"];
    }
    if (over) {
      const p = m.hot[0];
      const cause = k > N
        ? `Split ${k} ways, but there are only ${N} partitions, so ` + (m.hot.length === N
          ? `each holds two sub-keys and all ${N} run at <b>${pct(m.maxL)}</b>.`
          : m.hot.length === 1
            ? `some must share: P${p} holds ${m.subkeys[p].map(j => "#" + j).join(" and ")} and runs at <b>${pct(m.maxL)}</b>.`
            : `some must share: ${listP(m.hot)} hold two sub-keys each and run at <b>${pct(m.maxL)}</b>.`)
        : `Split ${k} ways, each sub-key still receives <b>${rate(m.per)}</b> writes/s, which overloads its partition: ` +
          `${hottest(m, "run")} at <b>${pct(m.maxL)}</b>.`;
      const cap = BASE * N + m.E > LIMIT * N;
      return [cause + (cap
        ? ` Splitting alone cannot fix this: ${num(BASE * N)} + ${num(m.E)} writes/s is more than the ` +
          `${num(LIMIT * N)} writes/s all ${N} partitions can absorb` +
          (k >= N ? " (now that the key is split, more partitions would help)" : "") + ". Or combine writes in the app."
        : " Split further, or combine writes before they reach the database."), "warn"];
    }
    if (k <= N) {
      return [`Writes to post:42 now spread over <b>${k} partitions</b> (post:42#0 … #${k - 1}), ${rate(m.per)} writes/s each.` +
        (atLimit ? ` ${cap1(hottest(m, "sit"))} exactly at the limit: nothing is throttled yet, but there is no headroom.` : "") +
        ` The bill arrives on reads: counting likes takes <b>${k} requests</b> plus a merge, and the app must remember ` +
        "that this key is split. (Sub-keys are drawn on consecutive partitions for clarity; real hashing scatters them " +
        "and can collide.)", atLimit ? "warn" : "ok"];
    }
    return [`More sub-keys than partitions: writes cannot spread any further (there are only ${N} partitions), ` +
      `but every read still pays <b>${k} requests</b>.` +
      (k % N ? ` And ${k} sub-keys do not divide evenly over ${N} partitions, so those holding two get twice the share.` : "") +
      " Split only as far as you need.", "warn"];
  }

  function noteFor(m, st, read) {
    let [html, tone] = ruleNote(m, st);
    if (st.saltAll) {
      html += st.k > 1
        ? ` <b>Salting every key</b> multiplies the cost of every ordinary read by ${st.k} too; split only the few keys that are hot and keep a registry of them.`
        : " <b>Salting every key</b> would make every ordinary read fan out k ways too (k = 1 splits nothing yet); split only the few keys that are hot and keep a registry of them.";
      tone = "warn";
    }
    if (read) {
      const prefix = read.k === 1
        ? `<b>Read:</b> one request to P3, answered in <b>${read.ms} ms</b>` +
          (read.saturated ? "; P3 is saturated, so every key that lives on it gets slow reads too. " : ". ")
        : `<b>Read fan-out:</b> ${read.k} requests plus ${read.k - 1} ms to merge them; ` +
          (read.tie ? `${read.parts.length === 2 ? "both" : "all " + read.parts.length} partitions answered in ${read.slowMs} ms. `
            : `the slowest partition (<b>P${read.slowest}</b>, ${read.slowMs} ms) set the latency. `);
      html = prefix + html;
    }
    return [html, tone];
  }

  Viz.register("ch6/hot-key-split", {
    title: "Splitting a celebrity key",
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      // State lives outside build() so a phone <-> desktop rebuild keeps it.
      const st = { ...DEFAULTS };
      let lastRead = null, running = false, epoch = 0, tweenToken = 0;
      let shown = null;   // loads currently drawn (tweened toward the model)
      let compact = ctx.compact, view = null;

      const geometry = c => c
        ? { c, W: 360, fs: 11, axisX: 30, x0: 38, slot: 40, barW: 28, app: [24, 303], appR: 13, textX: 44, r: 5,
            ticks: [[0, "0"], [1000, "1k"], [2000, "2k"]] }
        : { c, W: 640, fs: 12, axisX: 42, x0: 64, slot: 70, barW: 46, app: [40, 300], appR: 15, textX: 70, r: 6,
            ticks: [[0, "0"], [500, "500"], [1000, "1,000"], [1500, "1,500"], [2000, "2,000"]] };
      const cx = (g, p) => g.x0 + g.slot * p + g.slot / 2;

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        epoch++;
        running = false;
        const g = geometry(compact);

        const hSlider = ui.slider({
          label: "Hot key writes/s", min: 0, max: 6000, step: 250, value: st.H,
          format: v => v.toLocaleString("en-US") + "/s", onInput: v => { st.H = v; changed(); },
        });
        const kSlider = ui.slider({
          label: "Split into k sub-keys", min: 1, max: 16, step: 1, value: st.k,
          format: v => (v === 1 ? "1 (no split)" : String(v)), onInput: v => { st.k = v; changed(); },
        });
        // The track's 140px flex-basis would push long labels' values onto their own line on phones.
        if (compact) [hSlider, kSlider].forEach(sl => { sl.input.style.flex = "1 1 50px"; sl.input.style.minWidth = "50px"; });
        const readBtn = ui.button("Read like count", () => read(), { kind: "primary" });
        const saltT = ui.toggle({ label: "Salt every key, not just hot ones", value: st.saltAll, onChange: v => { st.saltAll = v; changed(); } });
        const combT = ui.toggle({ label: "Combine writes in app (flush every 100 ms)", value: st.combine, onChange: v => { st.combine = v; changed(); } });
        const resetBtn = ui.button("Reset", () => reset(), { kind: "ghost" });

        const svg = ctx.svg({ w: g.W, h: 322, label: "Write load per partition, with the hot key's share stacked on ordinary traffic" });
        const layers = {};
        ["axis", "bars", "limit", "labels", "packets"].forEach(n => { layers[n] = s("g"); svg.appendChild(layers[n]); });
        drawAxis(svg, layers, g);
        const bars = Array.from({ length: N }, (_, p) => makeBar(layers, g, p));
        layers.labels.appendChild(ctx.node({
          x: g.app[0], y: g.app[1], r: g.appR, label: "App", size: g.fs, fill: "var(--viz-c6-soft)", stroke: "var(--viz-c6)",
        }));
        const result = ctx.text(g.textX, g.app[1], "", { size: g.fs, anchor: "start" });
        layers.labels.appendChild(result);

        const caption = h("div", { class: "muted", style: "font-size:12.5px;line-height:1.45;margin:-2px 0 10px" },
          `Model: ${N} partitions, each accepting up to 1,000 writes/s (the same figure as DynamoDB's documented ` +
          "per-partition write limit), with 500 writes/s of ordinary keys on each. post:42 is a viral post's like counter; it hashes to P3.");
        const legend = ui.legend([
          { color: "var(--viz-c2)", label: "ordinary keys", shape: "square" },
          { color: "var(--viz-c5)", label: "post:42 (hot key)", shape: "square" },
          { color: "var(--viz-bad)", label: "over the limit (throttled)", shape: "square" },
          { color: "var(--viz-bad)", label: "per-partition limit", shape: "dash" },
        ]);
        const stats = ui.stats([
          { key: "hot", label: "Hottest partition" },
          { key: "thr", label: "Throttled writes" },
          { key: "reqLike", label: "Requests per like-count read" },
          { key: "reqOrd", label: "Requests per ordinary read" },
          { key: "lat", label: "Read latency" },
          { key: "db", label: "post:42 writes reaching the DB" },
        ]);
        // Three columns on desktop keep every label on one line; values sit on a common baseline.
        if (!compact) stats.style.gridTemplateColumns = "repeat(3, 1fr)";
        stats.querySelectorAll(".viz-stat").forEach(c => {
          Object.assign(c.style, { display: "flex", flexDirection: "column", justifyContent: "space-between" });
        });
        const note = ui.note("");
        root.append(ui.bar(hSlider, kSlider), ui.bar(readBtn, saltT, combT, resetBtn), caption, svg, legend, stats, note);
        view = { g, svg, layers, bars, result, stats, note, readBtn, hSlider, kSlider, saltT, combT };
        render(false);
      }

      function drawAxis(svg, L, g) {
        const muted = { size: g.fs, fill: "var(--viz-muted)" };
        [0, 500, 1000, 1500, 2000].forEach(v => {
          if (v !== LIMIT) L.axis.appendChild(s("line", { x1: g.axisX + 6, x2: g.W - 2, y1: Y(v), y2: Y(v), stroke: v ? "var(--viz-grid)" : "var(--viz-line)" }));
        });
        g.ticks.forEach(([v, t]) => L.axis.appendChild(ctx.text(g.axisX, Y(v), t, v === LIMIT
          ? { size: g.fs, anchor: "end", fill: "var(--viz-bad)", weight: 700 } : { ...muted, anchor: "end" })));
        L.axis.appendChild(ctx.text(4, 12, "writes/s", { ...muted, anchor: "start" }));
        // The limit's label sits in the axis gutter, where no bar can ever cover it.
        L.axis.appendChild(ctx.text(g.axisX, Y(LIMIT) - 14, "limit", { size: g.fs, anchor: "end", fill: "var(--viz-bad)", weight: 700 }));
        L.limit.appendChild(s("line", {
          x1: g.axisX + 6, x2: g.W - 2, y1: Y(LIMIT), y2: Y(LIMIT), stroke: "var(--viz-bad)", "stroke-width": 1.6, "stroke-dasharray": "6 4",
        }));
        const id = "hk-hatch-" + ctx.uid;
        svg.defs.appendChild(s("pattern", { id, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
          s("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "var(--viz-bad)", "stroke-width": 2, opacity: 0.45 })));
        g.hatch = `url(#${id})`;
      }

      function makeBar(L, g, p) {
        const x = cx(g, p) - g.barW / 2, w = g.barW;
        const rect = (fill, stroke, sw) => s("rect", { x, y: Y0, width: w, height: 0, fill, stroke: stroke || "none", "stroke-width": sw || 0 });
        const b = {
          under: rect("var(--viz-bg)"),
          ord: rect("var(--viz-c2-soft)", "var(--viz-c2)", 1.2),
          hot: rect("var(--viz-c5-soft)", "var(--viz-c5)", 1.2),
          overSoft: rect("var(--viz-bad-soft)"),
          over: rect(g.hatch),
          outline: rect("none", "var(--viz-bad)", 2),
          // A slanted gap near the top marks a bar that is cut off at 2,000/s.
          brk: s("polygon", { points: `${x - 2},48 ${x + w + 2},41 ${x + w + 2},45 ${x - 2},52`, fill: "var(--viz-bg)" }),
          value: ctx.text(cx(g, p), Y0, "", { size: g.fs, halo: true }),
          tag: ctx.text(cx(g, p), 266, "", { size: g.fs, fill: "var(--viz-c5)", weight: 600 }),
          tag2: ctx.text(cx(g, p), 279, "", { size: g.fs, fill: "var(--viz-c5)", weight: 600 }),
        };
        ctx.attr(b.ord, { y: Y(BASE), height: Y0 - Y(BASE) });
        L.bars.append(b.under, b.ord, b.hot, b.overSoft, b.over, b.outline, b.brk);
        L.labels.append(b.value, ctx.text(cx(g, p), 248, "P" + p, { size: g.fs, weight: 600 }), b.tag, b.tag2);
        return b;
      }

      function paintBar(b, L, exact) {
        const top = Y(L), over = L > LIMIT, clipped = L > YMAX;
        const show = (el, on) => { el.style.display = on ? "" : "none"; };
        ctx.attr(b.under, { y: top, height: Y0 - top });
        ctx.attr(b.hot, { y: top, height: Math.max(0, Y(BASE) - top) });
        show(b.hot, L > BASE + 0.5);
        [b.overSoft, b.over].forEach(el => { show(el, over); if (over) ctx.attr(el, { y: top, height: Y(LIMIT) - top }); });
        ctx.attr(b.outline, { y: top, height: Y0 - top });
        show(b.outline, over);
        show(b.brk, clipped);
        b.value.textContent = clipped ? num(L) + (compact ? "" : "/s") : exact ? rate(L) : num(L);
        // Keep the label off the dashed limit line: nudge it just above the line instead.
        const ly = clipped ? 19 : Math.abs(top - 9 - Y(LIMIT)) < 9 ? Y(LIMIT) - 9 : top - 9;
        ctx.attr(b.value, { y: ly, "font-weight": clipped || over ? 700 : 400 });
        b.value.style.fill = over ? "var(--viz-bad)" : L > 0.8 * LIMIT ? "var(--viz-warn)" : "var(--viz-muted)";
      }

      function paintTags(m) {
        view.bars.forEach((b, p) => {
          const js = m.subkeys[p];
          const tags = st.k === 1 ? js.map(() => "post:42") : js.map(j => "#" + j);
          const twoLines = compact && tags.length > 1;
          b.tag.textContent = twoLines ? tags[0] : tags.join(" ");
          b.tag2.textContent = twoLines ? tags[1] : "";
          ctx.attr(b.tag, { y: twoLines ? 264 : 266 });
        });
      }

      function tweenBars(target, animate) {
        const my = ++tweenToken, from = shown || target;
        const paint = (vals, exact) => { shown = vals; view.bars.forEach((b, p) => paintBar(b, vals[p], exact)); };
        if (!animate) { paint(target.slice(), true); return; }
        ctx.tween({ ms: 400, ease: "inOut", onUpdate: t => {
          if (my === tweenToken) paint(from.map((f, p) => f + (target[p] - f) * t), t >= 1);
        } });
      }

      function resultText() {
        const r = view.result, k = st.k;
        r.style.fill = lastRead ? "var(--viz-ink)" : "var(--viz-muted)";
        r.setAttribute("font-weight", lastRead ? 600 : 400);
        if (running) { r.textContent = `reading ${k === 1 ? "post:42" : k + " sub-keys"}…`; return; }
        if (!lastRead) {
          r.textContent = k === 1 ? "Read like count → 1 request, to P3"
            : `Read like count → ${k} requests (one per sub-key), then a sum`;
          return;
        }
        const { counts, ms, slowMs } = lastRead, total = num(LIKES);
        if (k === 1) r.textContent = `post:42 = ${total} in ${ms} ms`;
        else if (k <= (compact ? 2 : 4)) r.textContent = `${counts.map(num).join(" + ")} = ${total} in ${ms} ms`;
        else r.textContent = `sum of ${k} counters = ${total} in ${ms} ms` +
          (compact ? "" : ` (slowest partition ${slowMs} ms + merge ${k - 1} ms)`);
      }

      function render(animate) {
        if (!view) return;
        const m = model(st), hotPct = (m.maxL / LIMIT) * 100;
        tweenBars(m.load, animate);
        paintTags(m);
        resultText();
        const { stats } = view;
        stats.set("hot", pct(m.maxL), hotPct > 100 ? "bad" : hotPct > 80 ? "warn" : "ok");
        stats.set("thr", num(m.throttled) + "/s", m.throttled > 0 ? "bad" : "ok");
        stats.set("reqLike", String(st.k), st.k === 1 ? "ok" : st.k <= 8 ? "warn" : "bad");
        const ordReq = st.saltAll ? st.k : 1;
        stats.set("reqOrd", String(ordReq), ordReq === 1 ? "ok" : "bad");
        stats.set("lat", lastRead ? lastRead.ms + " ms" : "–", !lastRead ? "" : lastRead.ms >= 50 ? "bad" : lastRead.ms >= 15 ? "warn" : "ok");
        stats.set("db", num(m.E) + "/s", "info");
        view.note.set(...noteFor(m, st, lastRead));
        view.readBtn.disable(running);
      }

      // Any parameter change abandons a read in flight and clears the last result (it described old loads).
      function changed() {
        epoch++;
        running = false;
        lastRead = null;
        view.layers.packets.innerHTML = "";
        render(true);
      }

      function reset() {
        Object.assign(st, DEFAULTS);
        view.hSlider.set(st.H); view.kSlider.set(st.k);
        view.saltT.set(st.saltAll); view.combT.set(st.combine);
        changed();
      }

      async function read() {
        if (running) return;
        const my = ++epoch, m = model(st), k = st.k, g = view.g, layer = view.layers.packets;
        running = true;
        lastRead = null;
        render(false);
        const targets = Array.from({ length: Math.min(k, 16) }, (_, j) => (HOME + j) % N);
        const app = [g.app[0], g.app[1] - g.appR];   // packets leave and return at the top of the App node
        await Promise.all(targets.map(async (p, i) => {
          await ctx.sleep(i * 40);
          if (my !== epoch) return;
          const at = [cx(g, p), Y0 + 2];
          await ctx.fly(layer, { from: app, to: at, ms: 450, r: g.r, fill: "var(--viz-c6)" });
          if (my !== epoch) return;
          await ctx.fly(layer, {
            from: at, to: app, r: g.r, ms: Math.min(1200, 450 + m.latency[p] * 12),
            fill: m.load[p] >= LIMIT ? "var(--viz-warn)" : "var(--viz-ok)",
          });
        }));
        if (my !== epoch || !ctx.alive) return;
        running = false;
        lastRead = readResult(m, k);
        render(false);
      }

      build();
      // Rebuild with the other layout when the frame crosses the phone breakpoint.
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
