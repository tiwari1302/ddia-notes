// Picking a join strategy (DDIA ch10, map-side joins). One join, 2 TB of events ⋈ users on
// user_id, run four ways. Each map-side shortcut swaps the shuffle for an assumption about the
// inputs, and fails when the assumption is false: loudly (out of memory) when the "small" side
// isn't small, silently (wrong results) when the two tables' buckets don't line up.
// Illustrative cost model only: scan, shuffle and spill costs from fixed aggregate bandwidths.
(function () {
  "use strict";

  // ---------------- Cost model (pure, no DOM) ----------------
  const E = 2000;                        // events, GB
  const MACHINES = 50, NET = 50, DISK = 25;   // aggregate GB/s: 50 × 1 GB/s network, 50 × 0.5 GB/s disk
  const BUCKETS = 32, HASH = 1.5;        // hash table ≈ 1.5 × raw size (optimistic)
  const REDUCE_MEM = 0.01, MERGE_MEM = 0.06;  // GB: one key at a time / two streaming buffers
  const USERS = [0.01, 0.1, 1, 2, 5, 10, 50, 200, 1000];
  const USER_LABELS = ["10 MB", "100 MB", "1 GB", "2 GB", "5 GB", "10 GB", "50 GB", "200 GB", "1 TB"];
  const STRATS = [
    { value: "reduce", label: "Reduce-side" }, { value: "broadcast", label: "Broadcast" },
    { value: "partitioned", label: "Partitioned" }, { value: "merge", label: "Merge" },
  ];
  const LAYOUTS = [
    { value: "none", label: "Not bucketed" }, { value: "bucketed", label: "Bucketed" },
    { value: "sorted", label: "Bucketed + sorted" }, { value: "diffhash", label: "Bucketed, different hash" },
  ];
  const nameOf = st => STRATS.find(o => o.value === st).label;

  /** One strategy under one setup -> {status: ok|oom|wrong|na, time s, network GB, need GB, why}. */
  function evaluate(st, U, mem, layout) {
    const scan = (E + U) / DISK, bucketed = layout !== "none";
    if (st === "reduce") {
      return { status: "ok", time: scan + (E + U) / NET + 2 * (E + U) / DISK, network: E + U, need: REDUCE_MEM };
    }
    if (st === "broadcast") {
      const need = HASH * U;
      return { status: need <= mem ? "ok" : "oom", time: scan + U, network: MACHINES * U, need };
    }
    if (!bucketed) return { status: "na", why: "unbucketed", network: 0 };
    if (st === "partitioned") {
      const need = HASH * U / BUCKETS;
      const status = need > mem ? "oom" : layout === "diffhash" ? "wrong" : "ok";
      return { status, time: scan, network: 0, need };
    }
    if (layout === "bucketed") return { status: "na", why: "unsorted", network: 0 };
    return { status: layout === "diffhash" ? "wrong" : "ok", time: scan, network: 0, need: MERGE_MEM };
  }

  /** Fastest valid, correct strategy. The optimizer reads bucketing metadata, so it treats
   *  buckets written with different hash functions as not bucketed at all. Ties: Merge first. */
  function optimizerPick(U, mem, layout) {
    const seen = layout === "diffhash" ? "none" : layout;
    let best = null;
    for (const st of ["merge", "partitioned", "broadcast", "reduce"]) {
      const r = evaluate(st, U, mem, seen);
      if (r.status === "ok" && (!best || r.time < best.time - 1e-9)) best = { st, time: r.time };
    }
    return best.st;
  }

  const trim = v => (v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v)));
  function fmtSize(gb) {
    if (gb >= 1000) { const t = gb / 1000; return (t < 10 ? t.toFixed(1) : Math.round(t)) + " TB"; }
    if (gb >= 1) return trim(gb) + " GB";
    return gb >= 0.001 ? trim(gb * 1000) + " MB" : "< 1 MB";
  }
  const fmtNet = gb => (gb === 0 ? "0" : fmtSize(gb));
  const fmtTime = t => Math.round(t) + " s";
  const range = i => `${8 * i}–${8 * i + 7}`;

  Viz.register("ch10/join-strategies", {
    title: "Picking a join strategy",
    model: { evaluate, optimizerPick, fmtSize },   // exposed for offline tests
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      // State survives the phone <-> desktop rebuild.
      let strategy = "reduce", userIdx = 2, mem = 4, layout = "none";
      let epoch = 0, running = false, optNote = null, compact = ctx.compact, view = null;
      const U = () => USERS[userIdx];
      const C = name => `var(--viz-${name})`;
      const evalAll = () => STRATS.map(o => ({ st: o.value, label: o.label, r: evaluate(o.value, U(), mem, layout) }));

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        epoch++;           // a run in progress belongs to the old DOM
        running = false;
        const choose = (label, options, value, onChange) => (compact
          ? ui.select({ label, options, value, onChange })
          : ui.segmented({ label, options, value, onChange }));
        const stratCtl = choose("Strategy", STRATS, strategy, v => { strategy = v; changed(); });
        const layoutCtl = choose("Input layout", LAYOUTS, layout, v => { layout = v; changed(); });
        const usersSl = ui.slider({ label: "Users table", min: 0, max: 8, value: userIdx,
          format: i => USER_LABELS[i], onInput: v => { userIdx = v; changed(); } });
        const memSl = ui.slider({ label: "Memory per task", min: 1, max: 16, value: mem,
          format: v => v + " GB", onInput: v => { mem = v; changed(); } });
        if (compact) [usersSl, memSl].forEach(sl => { sl.input.style.flex = "1 1 80px"; });
        const optBtn = ui.button("Let the optimizer pick", () => pick(), { kind: "primary" });
        const runBtn = ui.button("▶ Run", () => run());
        const stats = ui.stats([
          { key: "net", label: "Network", value: "" },
          { key: "mem", label: "Memory per task", value: "" },
          { key: "time", label: "Est. time", value: "" },
          { key: "result", label: "Result", value: "" },
        ]);
        const L = sceneLayout(compact);
        const scene = ctx.svg({ w: L.W, h: L.H, label: "Inputs, workers and the data each join strategy moves between them" });
        const layers = { edges: s("g"), boxes: s("g"), packets: s("g") };
        scene.append(layers.edges, layers.boxes, layers.packets);
        const CL = chartLayout(compact);
        const chart = ctx.svg({ w: CL.W, h: CL.H, label: "Estimated time and memory per task for all four strategies" });
        const chartLayer = s("g");
        chart.appendChild(chartLayer);
        const note = ui.note("");
        const setup = h("div", { class: "muted", style: "font-size:12px;line-height:1.45;margin:-2px 0 10px" },
          "Illustrative cost model: events = 2 TB on 50 machines (4 drawn), each with 1 GB/s network and 0.5 GB/s disk " +
          "(50 GB/s and 25 GB/s in total). Bucketed layouts use 32 buckets. A hash table takes ~1.5× the raw table " +
          "(optimistic: JVM hash tables are often bigger).");
        const legend = ui.legend([
          { color: C("c2"), label: "events", shape: "square" },
          { color: C("c5"), label: "users", shape: "square" },
          { color: C("bad"), label: "failed or wrong", shape: "dash" },
          { color: C("warn"), label: "can't run", shape: "dash" },
          { color: C("ok"), label: "matched (on Run)", shape: "dot" },
        ]);
        const bars = compact
          ? [ui.bar(stratCtl), ui.bar(layoutCtl), ui.bar(usersSl, memSl), ui.bar(optBtn, runBtn)]
          : [ui.bar(stratCtl, optBtn), ui.bar(layoutCtl), ui.bar(usersSl, memSl, runBtn)];
        root.append(setup, ...bars, scene, legend, stats, note, chart);
        view = { L, CL, scene, layers, chartLayer, stats, note, stratCtl, runBtn, workers: [] };
        update();
      }

      // ---------------- Scene geometry ----------------
      function sceneLayout(phone) {
        if (!phone) return {
          phone, W: 640, H: 300, fs: 12, size: 14, badgeY: 278,
          box: (kind, i) => ({ x: { e: 10, w: 250, u: 474 }[kind], y: 40 + 56 * i, w: kind === "w" ? 140 : 156, h: 44 }),
        };
        return {
          phone, W: 360, H: 322, fs: 11, size: 13, badgeY: 306,
          box: (kind, i) => ({ x: 8 + 87 * i, y: { e: 30, w: 124, u: 228 }[kind], w: 83, h: kind === "w" ? 46 : 40 }),
        };
      }
      // Where an edge from input box (kind, i) leaves it, and where it enters worker k. All-to-all
      // edges are spread along both box edges so a fan doesn't read as an arrowhead.
      const isFan = e => strategy === "reduce" || (strategy === "broadcast" && e.kind === "u");
      function ends(L, e) {
        const { kind, i, k } = e, a = L.box(kind, i), b = L.box("w", k);
        const sp = isFan(e) ? (L.phone ? 8 : 7) : 0, oa = (k - 1.5) * sp, ob = (i - 1.5) * sp;
        if (!L.phone) {
          return kind === "e" ? [[a.x + a.w, a.y + a.h / 2 + oa], [b.x - 2, b.y + b.h / 2 + ob]]
            : [[a.x, a.y + a.h / 2 + oa], [b.x + b.w + 2, b.y + b.h / 2 + ob]];
        }
        return kind === "e" ? [[a.x + a.w / 2 + oa, a.y + a.h], [b.x + b.w / 2 + ob, b.y - 2]]
          : [[a.x + a.w / 2 + oa, a.y], [b.x + b.w / 2 + ob, b.y + b.h + 2]];
      }
      function edgeList(st) {
        const out = [];
        for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) {
          if (st === "reduce" || i === k) out.push({ kind: "e", i, k });
          if (st === "reduce" || st === "broadcast" || i === k) out.push({ kind: "u", i, k });
        }
        return out;
      }

      function inputSub(i, hashName, phone) {
        const r = range(i);
        if (layout === "none") return phone ? "any id" : "any user_id";
        if (layout === "bucketed") return phone ? "bkt " + r : "buckets " + r;
        if (layout === "sorted") return phone ? r + " sorted" : `buckets ${r}, sorted`;
        return phone ? `${r} hash ${hashName}` : `buckets ${r} (hash ${hashName})`;
      }
      function workerText(k, phone) {
        const r = range(k), n = k + 1;
        if (phone) return strategy === "reduce" ? ["R" + n, "sort+join"]
          : ["M" + n, { broadcast: "all users", partitioned: "bkt " + r, merge: "merge " + r }[strategy]];
        return strategy === "reduce" ? ["reducer " + n, "sort, then join"]
          : ["mapper " + n, { broadcast: "loads all users", partitioned: "joins buckets " + r, merge: "merges buckets " + r }[strategy]];
      }
      function flowText(r, phone) {
        if (r.status === "na") return r.why === "unsorted" ? "can't run: buckets aren't sorted" : "can't run: inputs aren't bucketed";
        if (r.status === "wrong") return phone ? "user 42: bucket 7 (E1) vs 19 (U3)" : "hashes differ: user 42 is in bucket 7 (E1) but bucket 19 (U3)";
        return {
          reduce: `shuffle: all ${fmtSize(E + U())} ` + (phone ? "move" : "cross the network"),
          broadcast: phone ? "users copied to every machine" : "events stay put · users copied to all 50 machines",
          partitioned: phone ? "no shuffle: bucket i ⋈ bucket i" : "no shuffle: hash-join bucket i with bucket i",
          merge: phone ? "no shuffle: merge bucket i ⋈ i" : "no shuffle: merge sorted bucket i with bucket i",
        }[strategy];
      }
      function badgeFor(r) {
        if (r.status === "ok") return ["✓ correct", "ok"];
        if (r.status === "oom") return [`✕ OOM: needs ${fmtSize(r.need)}, has ${mem} GB`, "bad"];
        if (r.status === "wrong") return ["✕ WRONG: ~97% of events unmatched", "bad"];
        return [r.why === "unsorted" ? "– not applicable: buckets aren't sorted" : "– not applicable: inputs aren't bucketed", "warn"];
      }
      function pill(parent, x, y, str, tone, fs) {
        const w = str.length * fs * 0.6 + 18, hh = fs + 9;
        parent.appendChild(s("rect", { x: x - w / 2, y: y - hh / 2, width: w, height: hh, rx: hh / 2, fill: C("bg") }));
        parent.appendChild(s("rect", { x: x - w / 2, y: y - hh / 2, width: w, height: hh, rx: hh / 2, fill: C(tone + "-soft"), stroke: C(tone), "stroke-width": 1.4 }));
        parent.appendChild(ctx.text(x, y + 0.5, str, { size: fs, weight: 700, fill: C(tone) }));
      }

      function drawScene(r) {
        const { L, scene, layers } = view;
        Object.values(layers).forEach(g => { g.innerHTML = ""; });
        const bad = r.status === "oom" || r.status === "wrong";
        for (const e of edgeList(strategy)) {
          const [[x1, y1], [x2, y2]] = ends(L, e);
          const color = r.status === "na" ? C("warn") : bad ? C("bad")
            : strategy === "reduce" ? C("line") : C(e.kind === "e" ? "c2" : "c5");
          const fan = isFan(e);
          const p = ctx.arrow({ x1, y1, x2, y2, color, svg: scene, width: fan ? 1.2 : 1.8, dashed: bad || r.status === "na" });
          p.setAttribute("opacity", r.status === "na" ? 0.55 : fan && !bad ? 0.7 : 0.9);
          layers.edges.appendChild(p);
        }
        const B = layers.boxes, fs = L.fs;
        // Different hash functions: user 42 lands in bucket 7 of events (E1) but bucket 19 of users (U3).
        const has42 = (kind, i) => r.status === "wrong" && i === (kind === "e" ? 0 : 2);
        const input = (kind, i) => {
          const b = ctx.box({ ...L.box(kind, i), label: (kind === "e" ? "E" : "U") + (i + 1),
            sub: inputSub(i, kind === "e" ? "A" : "B", L.phone), size: L.size,
            fill: C(kind === "e" ? "c2-soft" : "c5-soft"), stroke: C(has42(kind, i) ? "bad" : kind === "e" ? "c2" : "c5"),
            strokeWidth: has42(kind, i) ? 2.5 : 1.5 });
          if (has42(kind, i)) b.label.appendChild(s("tspan", { fill: C("bad") }, L.phone ? " · u42" : " · user 42"));
          return b;
        };
        view.workers = [];
        for (let i = 0; i < 4; i++) {
          B.append(input("e", i), input("u", i));
          const [label, sub] = workerText(i, L.phone);
          const w = ctx.box({ ...L.box("w", i), label, sub, size: L.size, fill: C("node"),
            stroke: r.status === "oom" ? C("bad") : C("node-stroke"), dashed: r.status === "oom" });
          B.appendChild(w);
          view.workers.push(w);
        }
        const head = (x, y, str, color, anchor) => B.appendChild(ctx.text(x, y, str, { size: fs, weight: 700, fill: C(color), anchor }));
        const users = "users · " + USER_LABELS[userIdx];
        if (L.phone) {
          head(8, 16, "events · 2 TB", "c2", "start");
          head(8, 284, users, "c5", "start");
          B.appendChild(ctx.text(352, 16, flowText(r, true), { size: fs, fill: C("muted"), anchor: "end" }));
        } else {
          head(10, 18, "events · 2 TB", "c2", "start");
          head(630, 18, users, "c5", "end");
          B.appendChild(ctx.text(320, 18, flowText(r, false), { size: fs, fill: C("muted") }));
        }
        pill(B, L.W / 2, L.badgeY, ...badgeFor(r), fs);
      }

      // ---------------- Comparison chart (time + memory, all four strategies) ----------------
      function chartLayout(phone) {
        if (!phone) return {
          W: 640, H: 166, fs: 12, lx: 10, band: [4, 636], time: { y0: 26, x0: 112, x1: 300 },
          mem: { y0: 26, x0: 392, x1: 572, val: 634 }, dy: 28, title: 12, axis: 150,
        };
        return {
          W: 360, H: 272, fs: 11, lx: 8, band: [2, 358], time: { y0: 22, x0: 96, x1: 282 },
          mem: { y0: 152, x0: 96, x1: 292, val: 354 }, dy: 24, title: 10, memTitle: 140, axis: 256,
        };
      }
      const LOG_LO = -3, LOG_HI = Math.log10(2000);   // 1 MB .. 2 TB
      function drawChart(rows) {
        const { CL, chartLayer: g } = view, fs = CL.fs, bh = CL.dy - 12;
        g.innerHTML = "";
        const tMax = Math.max(...rows.filter(x => x.r.status === "ok").map(x => x.r.time));
        const mx = gb => CL.mem.x0 + (Math.log10(Math.max(gb, 1e-3)) - LOG_LO) / (LOG_HI - LOG_LO) * (CL.mem.x1 - CL.mem.x0);
        const txt = (x, y, str, o) => g.appendChild(ctx.text(x, y, str, { size: fs, anchor: "start", ...o }));
        const rect = (x, y, w, hh, o) => g.appendChild(s("rect", { x, y, width: Math.max(0, w), height: hh, rx: 4, ...o }));
        const sameRows = CL.mem.y0 === CL.time.y0;
        const rowY = (sec, i) => CL[sec].y0 + i * CL.dy + CL.dy / 2;
        txt(CL.time.x0, CL.title, "Estimated time", { weight: 700, fill: C("muted") });
        txt(CL.mem.x0, sameRows ? CL.title : CL.memTitle, "Memory per task (log scale)", { weight: 700, fill: C("muted") });

        // Memory gridlines + the task-memory limit, behind the bars.
        const top = CL.mem.y0 + 2, bottom = CL.mem.y0 + 4 * CL.dy - 2;
        [0.001, 1, 1000].forEach((gb, j) => {
          g.appendChild(s("line", { x1: mx(gb), x2: mx(gb), y1: top, y2: bottom, stroke: C("grid"), "stroke-width": 1 }));
          if (j !== 1) txt(mx(gb), CL.axis, ["1 MB", "", "1 TB"][j], { fill: C("muted"), anchor: "middle" });
        });
        rows.forEach((row, i) => {
          const sel = row.st === strategy, r = row.r;
          const bandRow = sec => {
            const y = rowY(sec, i);
            if (sel) rect(CL.band[0], y - CL.dy / 2 + 1, CL.band[1] - CL.band[0], CL.dy - 2, { fill: C("c1-soft") });
            const t = txt(CL.lx, y, row.label, { weight: sel ? 700 : 400, fill: sel ? C("c1") : C("ink") });
            t.style.cursor = "pointer";
            t.addEventListener("click", () => { strategy = row.st; view.stratCtl.set(row.st); changed(); });
            return y;
          };
          // Time row
          let y = bandRow("time");
          const tw = (CL.time.x1 - CL.time.x0) * Math.min(1, (r.time || 0) / tMax);
          if (r.status === "ok") {
            rect(CL.time.x0, y - bh / 2, tw, bh, { fill: sel ? C("c1-soft") : C("line"), stroke: sel ? C("c1") : "none", "stroke-width": 2 });
            txt(CL.time.x0 + tw + 6, y, fmtTime(r.time), { weight: sel ? 700 : 400 });
          } else if (r.status === "na") {
            txt(CL.time.x0, y, r.why === "unsorted" ? "– n/a: buckets not sorted" : "– n/a: inputs not bucketed", { fill: C("warn") });
          } else {
            rect(CL.time.x0, y - bh / 2, tw, bh, { fill: "none", stroke: C("muted"), "stroke-dasharray": "4 3", "stroke-width": 1.2 });
            txt(CL.time.x0 + tw + 6, y, r.status === "oom" ? "✕ OOM" : "✕ wrong", { weight: 700, fill: C("bad") });
          }
          // Memory row
          y = sameRows ? y : bandRow("mem");
          if (r.status === "na") {
            txt(CL.mem.val, y, "n/a", { anchor: "end", fill: C("muted") });
            return;
          }
          const fits = r.need <= mem, tone = fits ? "ok" : "bad";
          rect(CL.mem.x0, y - bh / 2, mx(r.need) - CL.mem.x0, bh, { fill: C(tone + "-soft"), stroke: C(tone), "stroke-width": 1.2 });
          const val = row.st === "merge" ? "constant" : row.st === "reduce" ? "few MB" : fmtSize(r.need);
          txt(CL.mem.val, y, val, { anchor: "end", weight: sel ? 700 : 400, fill: fits ? C("ink") : C("bad") });
        });
        const lx = mx(mem);
        g.appendChild(s("line", { x1: lx, x2: lx, y1: top - 4, y2: bottom + 4, stroke: C("ink"), "stroke-width": 1.5, "stroke-dasharray": "4 3" }));
        txt(lx, CL.axis, `${mem} GB limit`, { anchor: "middle", weight: 700, fill: C("ink"), halo: true });
      }

      // ---------------- Stats and notes ----------------
      function setStats(r) {
        const { stats } = view, na = r.status === "na";
        stats.set("net", na ? "–" : fmtNet(r.network), "");
        const memText = na ? "–" : strategy === "merge" ? "constant" : strategy === "reduce" ? "few MB"
          : `${fmtSize(r.need)} of ${mem} GB`;
        stats.set("mem", memText, na ? "" : r.need <= mem ? "ok" : "bad");
        stats.set("time", r.status === "ok" || r.status === "wrong" ? fmtTime(r.time) : "–", r.status === "wrong" ? "bad" : "");
        stats.set("result", { ok: "correct", oom: "OOM", wrong: "wrong", na: "n/a" }[r.status],
          { ok: "ok", oom: "bad", wrong: "bad", na: "warn" }[r.status]);
      }

      function noteFor(r) {
        const u = USER_LABELS[userIdx], m = mem + " GB";
        const all = Object.fromEntries(evalAll().map(x => [x.st, x.r]));
        if (r.status === "wrong") {
          return ["Both tables have 32 buckets but were written with <b>different hash functions</b>, so user 42 can sit in bucket 7 of events " +
            "and bucket 19 of users. Pairing bucket <i>i</i> with bucket <i>i</i> silently drops <b>~97%</b> of matches, and the job still " +
            "finishes on time. Engines check bucketing metadata before taking this shortcut; hand-written jobs must too.", "bad"];
        }
        if (r.status === "na") {
          if (r.why === "unsorted") {
            return ["A merge join needs every bucket <b>sorted by user_id</b> on both sides, and these buckets aren't. " +
              "<b>Partitioned</b> works on this layout: it builds a hash table of one bucket instead.", "warn"];
          }
          return ["This shortcut needs both inputs <b>bucketed by user_id</b> into the same number of buckets with the same hash function" +
            (strategy === "merge" ? " (and, for Merge, sorted)" : "") + ". Without that, the engine has to shuffle first, which is a reduce-side join.", "warn"];
        }
        if (strategy === "reduce") {
          let hint;
          if (all.broadcast.status === "ok") hint = `Try <b>Broadcast</b>: the users table (${u}) fits in memory.`;
          else if (all.merge.status === "ok") hint = "Try <b>Merge</b>: both inputs are bucketed and sorted.";
          else if (all.partitioned.status === "ok") hint = "Try <b>Partitioned</b>: both inputs are bucketed alike.";
          else {
            hint = `Here it is the only safe plan: a ${u} users table is too big to broadcast (${fmtSize(all.broadcast.need)} per task), and ` +
              (layout === "none" ? "the inputs aren't bucketed." : layout === "diffhash" ? "the two tables' buckets don't line up."
                : `even one bucket of it (${fmtSize(all.partitioned.need)}) doesn't fit in ${m}.`);
          }
          return [`<b>Reduce-side join</b>: both inputs are partitioned by user_id and shuffled, so all <b>${fmtSize(r.network)}</b> cross ` +
            `the network and are sorted and spilled to disk (~${fmtTime(r.time)}, ${(r.time / 60).toFixed(1)} min). It works on any inputs. ${hint}`, "info"];
        }
        if (strategy === "broadcast") {
          if (r.status === "oom") {
            return [`The "small" side isn't small: a ${u} users table needs ~<b>${fmtSize(r.need)}</b> of hash table per task, but tasks have ` +
              `<b>${m}</b>, so they are killed. This is why engines broadcast only below a size threshold.`, "bad"];
          }
          return [`Every mapper loads the full users table into a hash table (<b>${fmtSize(r.need)}</b> of ${m}) and streams its block of ` +
            `events past it. Events never leave their machine; only <b>${fmtNet(r.network)}</b> of users copies move (${u} × 50 machines).`, "ok"];
        }
        if (strategy === "partitioned") {
          if (r.status === "oom") {
            return [`Each task hash-loads one bucket of users: 1.5 × ${u} / 32 ≈ <b>${fmtSize(r.need)}</b>, but tasks have <b>${m}</b>, ` +
              "so they are killed. More buckets would help, and so would <b>Merge</b>, which needs sorted buckets but no hash table.", "bad"];
          }
          return [`Each mapper task loads only bucket <i>i</i> of users into a hash table (<b>${fmtSize(r.need)}</b> for a ${u} users table: ` +
            `1.5 × ${u} / 32) and scans bucket <i>i</i> of events. No shuffle, and the users table can be 32× bigger than with Broadcast.`, "ok"];
        }
        return ["Both sides are bucketed and sorted by user_id, so each mapper merges two sorted streams like the last step of merge sort: " +
          "<b>constant memory, no shuffle, any table size</b>.", "ok"];
      }

      function optimizerNote(st) {
        const u = USER_LABELS[userIdx], m = mem + " GB";
        const all = Object.fromEntries(evalAll().map(x => [x.st, x.r]));
        const lead = layout === "diffhash" ? "The metadata shows the two tables were bucketed with <b>different hash functions</b>, " +
          "so the optimizer treats them as not bucketed. " : "";
        if (st === "merge") {
          return ["The optimizer picked <b>Merge</b>: the metadata says both tables are bucketed alike and sorted by user_id, so it merges " +
            "matching buckets with constant memory and no shuffle, whatever the size of the users table.", "ok"];
        }
        if (st === "partitioned") {
          return [`The optimizer picked <b>Partitioned</b>: both tables are bucketed alike and one bucket of users ` +
            `(${fmtSize(all.partitioned.need)}) fits in a ${m} task, so nothing is shuffled. Merge would need sorted buckets.`, "ok"];
        }
        if (st === "broadcast") {
          return [lead + `The optimizer picked <b>Broadcast</b>: users (${u}) fit in task memory, so shipping ${fmtNet(all.broadcast.network)} ` +
            "of copies beats shuffling 2 TB. Real engines use conservative thresholds (Spark broadcasts automatically only below 10 MB " +
            "by default) because size estimates can be badly wrong.", "ok"];
        }
        const why = layout === "none" || layout === "diffhash" ? "and no usable bucketing exists"
          : `and even one bucket needs ${fmtSize(all.partitioned.need)}` + (layout === "bucketed" ? " (unsorted, so no Merge)" : "");
        return [lead + `The optimizer picked <b>Reduce-side</b>: a ${u} users table needs ${fmtSize(all.broadcast.need)} as a hash table ` +
          `but tasks have ${m}, ${why}, so a full shuffle is the only safe plan.`, "info"];
      }

      // ---------------- Updates ----------------
      function update() {
        const rows = evalAll(), r = rows.find(x => x.st === strategy).r;
        drawScene(r);
        drawChart(rows);
        setStats(r);
        view.note.set(...(optNote || noteFor(r)));
        view.runBtn.disable(running || r.status === "na");
        view.runBtn.title = r.status === "na" ? "This strategy can't run on this input layout" : "";
      }
      function changed() {
        epoch++;           // abandons a run in progress
        running = false;
        optNote = null;
        update();
      }
      function pick() {
        const st = optimizerPick(U(), mem, layout);
        strategy = st;
        view.stratCtl.set(st);
        changed();
        optNote = optimizerNote(st);
        view.note.set(...optNote);
      }

      // ▶ Run: packets travel the current edges. OOM -> killed workers; WRONG -> unmatched events.
      async function run() {
        const my = ++epoch, r = evaluate(strategy, U(), mem, layout);
        if (r.status === "na") return;
        update();   // fresh scene (clears a previous run's marks)
        running = true;
        view.runBtn.disable(true);
        const { L, layers } = view, rnd = ctx.random(10);
        let edges = edgeList(strategy);
        while (edges.length < 12) edges = edges.concat(edgeList(strategy));
        edges = edges.map(e => ({ e, key: rnd() })).sort((a, b) => a.key - b.key).map(x => x.e).slice(0, 14);
        let greenLeft = 1;   // WRONG: only a rare event finds its user
        const flights = [];
        for (const e of edges) {
          const [from, to] = ends(L, e);
          const fill = C(e.kind === "e" ? "c2" : "c5");
          const fly = ctx.fly(layers.packets, { from, to, fill, r: L.phone ? 5 : 6, ms: 600 + rnd() * 300, keep: true });
          const pkt = layers.packets.lastChild;
          flights.push(fly.then(() => arrive(my, pkt, e, r, e.kind === "e" && r.status === "wrong" && greenLeft-- > 0)));
          await ctx.sleep(70);
          if (my !== epoch) return;
        }
        await Promise.all(flights);
        if (my !== epoch) return;
        running = false;
        view.runBtn.disable(false);
      }
      async function arrive(my, pkt, e, r, lucky) {
        if (my !== epoch) return;
        const dot = pkt.querySelector("circle"), w = view.workers[e.k];
        let fill = null;
        if (r.status === "oom") {
          fill = C("bad");
          ctx.attr(w.rect, { fill: C("bad-soft"), stroke: C("bad") });
          w.sub.textContent = "killed: OOM";
          w.sub.style.fill = C("bad");
        } else if (e.kind === "e") {
          fill = r.status === "ok" || lucky ? C("ok") : C("muted");
          if (r.status === "wrong") { w.sub.textContent = view.L.phone ? "97% lost" : "~97% unmatched"; w.sub.style.fill = C("bad"); }
        }
        if (fill) dot.style.fill = fill;
        await ctx.sleep(250);
        await ctx.tween({ ms: 350, onUpdate: k => pkt.setAttribute("opacity", 1 - k) });
        pkt.remove();
      }

      build();
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
