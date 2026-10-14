// Inside a MapReduce job: `cat | awk | sort | uniq -c` spread over 3 map tasks and R reduce
// tasks. Walks through scheduling, map, partition (hash mod R), map-side sort and spill to
// local disk, the optional combiner, the all-to-all shuffle, the reducer merge and reduce,
// plus task-level fault tolerance, including a FINISHED map task lost with its node.
Viz.register("ch10/mapreduce-shuffle", {
  title: "Inside a MapReduce job",
  mount(root, ctx) {
    const { s, h, ui, lerp } = ctx;

    // ---------- fixed data (illustrative toy log and toy hash) ----------
    const BLOCKS = [
      ["/home", "/docs", "/home", "/cart"],
      ["/docs", "/home", "/blog", "/home"],
      ["/cart", "/home", "/docs", "/home"],
    ];
    const HASH = { "/home": 4, "/docs": 9, "/cart": 7, "/blog": 2 };
    const KEYS = ["/home", "/docs", "/cart", "/blog"];
    const MAP_NODE = ["A", "B", "C"], RED_NODE = ["D", "E", "F"];
    const PCOL = ["c5", "c2", "c8"];
    const FAILS = [["none", "None", "None"], ["mid", "M2 dies mid-map", "Mid-map"], ["after", "Node B dies after map", "After map"]];
    const cfg = { R: 2, combiner: false, failure: "none" };   // survives rebuilds
    let compact = ctx.compact, stage = null, player = null, gen = 0;

    // ---------- model: a chip is one map output record {key, n, p} ----------
    const partOf = key => HASH[key] % cfg.R;
    const byPartKey = (a, b) => a.p - b.p || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    // Combiner over a list sorted by (partition, key): sums adjacent equal keys.
    function combine(list) {
      const kept = [], merges = [];
      list.forEach(c => {
        const last = kept[kept.length - 1];
        if (last && last.p === c.p && last.key === c.key) { last.n += c.n; merges.push([c, last]); }
        else kept.push(c);
      });
      return { kept, merges };
    }
    // A finished map task's output: partitioned, sorted (and combined), as a rerun produces it.
    function finishedOutput(m) {
      const list = BLOCKS[m].map(key => ({ key, n: 1, p: partOf(key) })).sort(byPartKey);
      return cfg.combiner ? combine(list).kept : list;
    }
    const runsOf = list => Array.from({ length: cfg.R }, (_, p) => list.filter(c => c.p === p));
    const chipText = c => (compact ? c.key[1].toUpperCase() : c.key.slice(1)) + (c.n > 1 ? "×" + c.n : "");
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

    // ---------- geometry ----------
    function geo(R) {
      if (!compact) {
        const rowY = [52, 156, 260];
        const red = p => (R === 3 ? { x: 446, y: rowY[p], w: 186, h: 96 } : { x: 446, y: [70, 218][p], w: 186, h: 120 });
        return {
          W: 640, H: 392, fs: 12, cw: 50, ch: 16, gridX: [30, 90], gridY: [34, 56], top: 24, gap: 18,
          Y: { t: 14, sub: 29, line: 46, lh: 14, cap: 9, row: 47, rlh: 15 },
          block: i => ({ x: 8, y: rowY[i], w: 112, h: 96 }),
          map: i => ({ x: 140, y: rowY[i], w: 170, h: 96 }),
          red,
          read: i => [121, rowY[i] + 48, 138, rowY[i] + 48],
          out: i => [310, rowY[i] + 48],
          in: p => [446, red(p).y + red(p).h / 2],
        };
      }
      const bx = [8, 125, 242];
      const red = p => (R === 3 ? { x: bx[p], y: 330, w: 110, h: 124 } : { x: [8, 184][p], y: 330, w: 168, h: 124 });
      return {
        W: 360, H: 538, fs: 11, cw: 30, ch: 16, gridX: [21, 59], gridY: [30, 50], top: 22, gap: 18,
        Y: { t: 13, sub: 27, line: 43, lh: 13, cap: 9, row: 45, rlh: 14 },
        block: i => ({ x: bx[i], y: 42, w: 110, h: 92 }),
        map: i => ({ x: bx[i], y: 150, w: 110, h: 100 }),
        red,
        read: i => [bx[i] + 55, 135, bx[i] + 55, 149],
        out: i => [bx[i] + 55, 250],
        in: p => [red(p).x + red(p).w / 2, 330],
      };
    }

    // ---------- controls ----------
    function controls() {
      const set = key => v => { cfg[key] = v; buildStage(-1); };
      return ui.bar(
        ui.segmented({ label: "Reducers", value: cfg.R, options: [2, 3], onChange: set("R") }),
        ui.toggle({ label: "Combiner", value: cfg.combiner, onChange: set("combiner") }),
        ui.segmented({
          label: "Failure", value: cfg.failure, onChange: set("failure"),
          options: FAILS.map(([value, label, short]) => ({ value, label: compact ? short : label })),
        }),
      );
    }

    function build() {
      const keep = player ? player.index : -1;
      compact = ctx.compact;
      root.innerHTML = "";
      stage = h("div");
      root.append(controls(), stage);
      buildStage(keep);
    }

    // Everything below is local to one stage build, so a replaced stepper can only touch its own
    // (detached) elements.
    async function buildStage(gotoIndex) {
      const my = ++gen;
      if (player) await player.reset();   // let a running step finish instantly before replacing it
      if (my !== gen) return;
      const R = cfg.R, fail = cfg.failure, G = geo(R), fs = G.fs, Y = G.Y;
      const svg = ctx.svg({ w: G.W, h: G.H, label: "MapReduce job: HDFS blocks, map tasks, shuffle and reduce tasks" });
      const scene = s("g"), flyLayer = s("g");
      svg.append(scene, flyLayer);
      const stats = ui.stats([["out", "Map output records"], ["shuf", "Records shuffled"], ["load", "Records per reducer"],
        ["att", "Task attempts"]].map(([key, label]) => ({ key, label })));
      const note = ui.note("");
      const legend = ui.legend([
        ...PCOL.slice(0, R).map((c, p) => ({ color: `var(--viz-${c})`, label: `partition ${p}`, shape: "square" })),
        { color: "var(--viz-node-stroke)", label: "task not started", shape: "dash" },
        ...(fail === "none" ? [] : [{ color: "var(--viz-bad)", label: "failed attempt" }, { color: "var(--viz-ok)", label: "rerun attempt" }]),
      ]);

      const T = (parent, x, y, str, o = {}) => parent.appendChild(ctx.text(x, y, str, { size: fs, anchor: "start", ...o }));
      const fade = (el, to, ms = 300, from = Number(el.getAttribute("opacity") || 1)) =>
        ctx.tween({ ms, onUpdate: k => el.setAttribute("opacity", lerp(from, to, k)) });
      const tone = (el, color, bold) => { ctx.attr(el, { fill: color }); el.setAttribute("font-weight", bold ? 700 : 400); };

      // ----- static scene -----
      function drawStrip(st) {
        const segs = compact
          ? [[14, [["cat", "cat access.log"], [null, " | "], ["awk", "awk '{print $7}'"]]],
             [30, [[null, "| "], ["sort", "sort"], [null, " | "], ["uniq", "uniq -c"]]]]
          : [[16, [["cat", "cat access.log"], [null, " | "], ["awk", "awk '{print $7}'"], [null, " | "],
                   ["sort", "sort"], [null, " | "], ["uniq", "uniq -c"]]]];
        st.strip = {};
        segs.forEach(([y, parts]) => {
          const t = T(scene, 8, y, "", { mono: true, fill: "var(--viz-muted)" });
          t.style.whiteSpace = "pre";
          parts.forEach(([k, str]) => { const sp = s("tspan", null, str); t.appendChild(sp); if (k) st.strip[k] = sp; });
        });
        if (!compact) T(scene, G.W - 8, 16, "← the same job on one machine", { anchor: "end", fill: "var(--viz-muted)" });
      }
      function strip(st, active) {
        for (const k in st.strip) {
          const on = active === "all" || k === active;
          tone(st.strip[k], on ? (active === "all" ? "var(--viz-ok)" : "var(--viz-c1)") : "var(--viz-muted)", on);
        }
      }

      function drawBlocks(st, layer) {
        st.blocks = BLOCKS.map((lines, i) => {
          const b = G.block(i);
          layer.appendChild(ctx.box({ ...b, rx: 6, fill: "var(--viz-panel)", stroke: "var(--viz-line)" }));
          T(layer, b.x + 8, b.y + Y.t, "block " + (i + 1), { weight: 700 });
          const sub = T(layer, b.x + 8, b.y + Y.sub, "", { fill: "var(--viz-muted)" });
          let nodeB = null;
          if (i === 1 && fail !== "none") {   // show the second replica a retry can read locally
            nodeB = s("tspan", null, "B");
            sub.append("replicas on ", nodeB, ", C");
          } else sub.textContent = "replica on " + MAP_NODE[i];
          const texts = lines.map((k, j) => T(layer, b.x + 10, b.y + Y.line + j * Y.lh, k, { mono: true }));
          return { texts, nodeB };
        });
      }
      const mapTitle = (m, node) => `M${m + 1} @ ${compact ? "" : "node "}${node}`;
      function drawMaps(st, layer) {
        st.maps = [0, 1, 2].map(m => {
          const b = G.map(m), box = ctx.box({ ...b, rx: 8, dashed: true });
          const title = T(box, b.x + 8, b.y + Y.t, mapTitle(m, MAP_NODE[m]), { weight: 700 });
          const tag = T(box, b.x + b.w - 8, b.y + Y.t, "", { anchor: "end", fill: "var(--viz-muted)" });
          const hint = T(box, b.x + b.w / 2, b.y + b.h / 2 + 6, compact ? "(url, 1) per line" : "map(line) → (url, 1)",
            { anchor: "middle", fill: "var(--viz-muted)" });
          const caps = s("g", { opacity: 0 });
          for (let p = 0; p < R; p++) {
            T(caps, b.x + ((p + 0.5) * b.w) / R, b.y + b.h - Y.cap, "P" + p, { anchor: "middle", weight: 600, fill: "var(--viz-muted)" });
          }
          box.appendChild(caps);
          layer.appendChild(box);
          return { box, title, tag, hint, caps };
        });
      }
      function drawReducers(st, layer) {
        st.reds = Array.from({ length: R }, (_, p) => {
          const b = G.red(p), box = ctx.box({ ...b, rx: 8, dashed: true });
          box.appendChild(s("rect", { x: b.x + 8, y: b.y + Y.t - 5, width: 10, height: 10, rx: 2, fill: `var(--viz-${PCOL[p]})` }));
          T(box, b.x + 24, b.y + Y.t, `R${p} @ ${compact ? "" : "node "}${RED_NODE[p]}`, { weight: 700 });
          const line2 = T(box, b.x + 8, b.y + Y.sub, compact ? `owns P${p}` : `owns partition P${p}`, { fill: "var(--viz-muted)" });
          const rows = s("g");
          T(rows, b.x + 8, b.y + Y.row, compact ? "reduce(url, …)" : "reduce(url, values)", { mono: true, fill: "var(--viz-muted)" });
          const out = s("g", { opacity: 0 }), file = `part-r-0000${p}`;
          if (compact && R === 3) {
            T(out, b.x + 8, b.y + b.h - 26, file, { mono: true, fill: "var(--viz-muted)" });
            T(out, b.x + 8, b.y + b.h - 12, "→ HDFS ×3", { fill: "var(--viz-muted)" });
          } else T(out, b.x + 8, b.y + b.h - 12, `${file} → HDFS ×3`, { fill: "var(--viz-muted)" });
          box.append(rows, out);
          layer.appendChild(box);
          return { box, line2, rows, out };
        });
      }
      function drawLegendLine() {
        const item = (t, k, lead) => {
          const p = HASH[k] % R;
          t.append(`${lead}${compact ? k[1].toUpperCase() + " " : ""}${k} h=${HASH[k]} → `,
            s("tspan", { fill: `var(--viz-${PCOL[p]})`, "font-weight": 700 }, "P" + p));
        };
        const line = (y, str) => { const t = T(scene, 8, y, str, { fill: "var(--viz-muted)" }); t.style.whiteSpace = "pre"; return t; };
        if (!compact) {
          const t = line(G.H - 14, `toy hash h(url), partition = h mod ${R}:`);
          KEYS.forEach(k => item(t, k, "     "));
        } else {
          line(G.H - 42, `toy hash h(url), partition = h mod ${R}`);
          [[0, 1], [2, 3]].forEach((pair, r) => { const t = line(G.H - 26 + r * 16, ""); pair.forEach((i, j) => item(t, KEYS[i], j ? "     " : "")); });
        }
      }

      // ----- chips (map output records) -----
      const place = (c, x, y) => { c.x = x; c.y = y; c.g.setAttribute("transform", `translate(${x},${y})`); };
      const paint = c => ctx.attr(c.rect, c.p === null
        ? { fill: "var(--viz-node)", stroke: "var(--viz-line)" }
        : { fill: `var(--viz-${PCOL[c.p]}-soft)`, stroke: `var(--viz-${PCOL[c.p]})` });
      function targets(st, m) {
        const b = G.map(m), colW = b.w / R, row = [0, 0, 0];
        return st.chips[m].map((c, i) => (st.partitioned
          ? [b.x + c.p * colW + (colW - G.cw) / 2, b.y + G.top + G.gap * row[c.p]++]
          : [b.x + G.gridX[i % 2], b.y + G.gridY[i >> 1]]));
      }
      function addChip(st, m, key, n = 1, p = null) {
        const c = { key, n, p, g: s("g", { opacity: 0 }) };
        c.rect = s("rect", { width: G.cw, height: G.ch, rx: 4, "stroke-width": 1.2 });
        c.text = ctx.text(G.cw / 2, G.ch / 2 + 1, chipText(c), { size: fs, mono: true });
        c.g.append(c.rect, c.text);
        st.chipLayer.appendChild(c.g);
        paint(c);
        st.chips[m].push(c);
        const t = targets(st, m);
        place(c, ...t[t.length - 1]);
        return c;
      }
      function settle(st, ms) {
        const moves = [];
        st.chips.forEach((list, m) => { const t = targets(st, m); list.forEach((c, i) => moves.push([c, c.x, c.y, ...t[i]])); });
        return ctx.tween({ ms, onUpdate: k => moves.forEach(([c, x0, y0, x1, y1]) => place(c, lerp(x0, x1, k), lerp(y0, y1, k))) });
      }
      async function discard(st, m) {
        const gone = st.chips[m];
        const y = G.ch / 2;
        gone.forEach(c => c.g.appendChild(s("line", { x1: -3, x2: G.cw + 3, y1: y, y2: y, stroke: "var(--viz-bad)", "stroke-width": 2 })));
        await ctx.sleep(350);
        await Promise.all(gone.map(c => fade(c.g, 0, 400)));
        gone.forEach(c => c.g.remove());
        st.mapOut -= gone.length;
        st.chips[m] = [];
        sync(st);
      }
      function lit(st, m, i) {   // highlight the input line a mapper is reading
        st.blocks.forEach((bl, bm) => bl.texts.forEach((t, j) => {
          const on = bm === m && j === i;
          if (on || m === null || bm === m) tone(t, on ? "var(--viz-c1)" : "var(--viz-ink)", on);
        }));
      }
      function emit(st, m, i) {
        lit(st, m, i);
        fade(addChip(st, m, BLOCKS[m][i]).g, 1, 150);
        st.mapOut++;
      }

      // ----- task boxes -----
      const setTag = (mp, str, t) => { mp.tag.textContent = str; tone(mp.tag, t ? `var(--viz-${t})` : "var(--viz-muted)", !!t); };
      function mapState(st, m, state) {   // run | dead | retry
        const mp = st.maps[m], [fill, stroke] = {
          run: ["var(--viz-node)", "var(--viz-node-stroke)"],
          dead: ["var(--viz-bad-soft)", "var(--viz-bad)"],
          retry: ["var(--viz-node)", "var(--viz-ok)"],
        }[state];
        mp.box.rect.removeAttribute("stroke-dasharray");
        ctx.attr(mp.box.rect, { fill, stroke, "stroke-width": state === "run" ? 1.5 : 2 });
        if (state === "dead") {   // node B is gone, and with it block 2's replica on B
          setTag(mp, "✕ died", "bad");
          tone(st.blocks[1].nodeB, "var(--viz-bad)", true);
          st.blocks[1].nodeB.style.textDecoration = "line-through";
        } else if (state === "retry") {
          mp.title.textContent = mapTitle(m, "C");
          setTag(mp, compact ? "try 2" : "attempt 2", "ok");
          st.attempts++;
          st.retried = true;
          sync(st);
        }
      }
      function sync(st) {
        stats.set("out", st.mapOut);
        stats.set("shuf", st.shuffled);
        const lo = Math.min(...st.loads), hi = Math.max(...st.loads);
        stats.set("load", st.reducing ? st.loads.join(" · ") : "–", st.shuffleDone && hi > 2 * lo ? "warn" : "");
        stats.set("att", st.attempts + (st.retried ? " <small>(1 retry)</small>" : ""), st.retried ? "warn" : "");
      }

      // ----- steps -----
      const steps = [];
      const add = (title, run, detail) => steps.push({ title, run, detail });
      const m2Retry = "Same immutable input, same deterministic code, so the retry emits exactly the same pairs. " +
        "Map task attempts: 4 (3 tasks + 1 retry).";

      add("Schedule: one map task per input block, on a node that already stores that block", async st => {
        strip(st, "cat");
        st.attempts = 3;
        sync(st);
        [0, 1, 2].forEach(m => {
          mapState(st, m, "run");
          const [x1, y1, x2, y2] = G.read(m);
          st.arrows.appendChild(ctx.arrow({ x1, y1, x2, y2, svg, dashed: true, width: 1.5, color: "var(--viz-muted)" }));
          st.maps[m].hint.textContent = compact ? "local read" : `reads block ${m + 1} locally`;
        });
        note.set(`Map tasks = number of input blocks (3). Reduce tasks = whatever the job author chose (R = ${R}).`, "info");
        await ctx.sleep(300);
      }, "Shipping a few MB of code beats moving a 128 MB block over the network (data locality).");

      add("Map: each mapper calls your function on every line and emits (url, 1)", async st => {
        strip(st, "awk");
        st.maps.forEach(mp => { mp.hint.textContent = ""; });
        for (let i = 0; i < 4; i++) {
          for (let m = 0; m < 3; m++) if (!(m === 1 && fail === "mid" && i >= 2)) emit(st, m, i);
          sync(st);
          await ctx.sleep(260);
        }
        lit(st, null);
        note.set("Your map function sees one line at a time and keeps no state between lines. It emits (url, 1) " +
          "without knowing which reducer will get the pair." +
          (fail === "mid" ? " M2 is running slowly: it is only halfway through block 2." : ""));
      });

      if (fail === "mid") {
        add("Node B dies while M2 is halfway through block 2", async st => {
          mapState(st, 1, "dead");
          await discard(st, 1);
          note.set("M2's partial output lived only on node B's local disk, so it is gone. Nothing downstream has seen it: " +
            "reducers only fetch from finished map tasks.", "bad");
        });
        add("The scheduler reruns M2 on node C, which holds another replica of block 2", async st => {
          mapState(st, 1, "retry");
          for (let i = 0; i < 4; i++) { emit(st, 1, i); sync(st); await ctx.sleep(220); }
          lit(st, null);
          note.set(m2Retry, "ok");
        });
      }

      add(`Partition: hash(url) mod ${R} decides which reducer owns each key`, async st => {
        strip(st, "sort");
        st.partitioned = true;
        st.chips.flat().forEach(c => { c.p = partOf(c.key); paint(c); });
        st.maps.forEach(mp => fade(mp.caps, 1, 400));
        await settle(st, 500);
        const hp = HASH["/home"] % R;
        note.set(`Every /home record goes to the same reducer, whichever mapper produced it: h(/home) = 4 and ` +
          `4 mod ${R} = ${hp}, so all of them belong to R${hp}. That is the whole trick.`);
      });

      add("Sort: each mapper sorts each partition by key and spills it to its local disk", async st => {
        st.chips.forEach(list => list.sort(byPartKey));
        await settle(st, 500);
        st.maps.forEach(mp => setTag(mp, compact ? "disk" : "on local disk"));
        note.set("Map output goes to local disk, not HDFS: it is temporary, so replicating it would be waste.");
      });

      if (cfg.combiner) {
        add("Combine: while spilling, each mapper sums adjacent equal keys", async st => {
          const moves = [];
          st.chips.forEach((list, m) => {
            const { kept, merges } = combine(list);
            st.chips[m] = kept;
            merges.forEach(([gone, into]) => moves.push([gone, into, gone.x, gone.y, into.x, into.y]));
          });
          await ctx.tween({ ms: 450, onUpdate: k => moves.forEach(([c, , x0, y0, x1, y1]) => place(c, lerp(x0, x1, k), lerp(y0, y1, k))) });
          moves.forEach(([gone, into]) => { gone.g.remove(); into.text.textContent = chipText(into); });
          st.mapOut -= moves.length;
          sync(st);
          await settle(st, 350);
          note.set("4 records per mapper became 3. On real data (say 1 billion log lines, 1,000 map tasks, ~10,000 distinct URLs) " +
            "a combiner caps the shuffle at 1,000 × 10,000 = 10 million records instead of 1 billion. Only valid for " +
            "associative, commutative operations like sum, count, max.", "ok");
        });
      }

      if (fail === "after") {
        add("Node B dies AFTER M2 finished: its sorted output lived only on B's local disk", async st => {
          mapState(st, 1, "dead");
          st.links[1].forEach(l => { ctx.attr(l, { stroke: "var(--viz-bad)" }); l.setAttribute("stroke-dasharray", "5 4"); });
          await discard(st, 1);
          note.set("M2 had already succeeded, but map output is written to the mapper's local disk, not HDFS. " +
            "No reducer has fetched it yet, so the finished work is lost.", "bad");
        });
        add("The scheduler reruns the FINISHED task M2 on node C, which holds another replica of block 2", async st => {
          mapState(st, 1, "retry");
          st.links[1].forEach(l => { ctx.attr(l, { stroke: "var(--viz-line)" }); l.removeAttribute("stroke-dasharray"); });
          for (let i = 0; i < 4; i++) { lit(st, 1, i); await ctx.sleep(110); }
          lit(st, null);
          const fresh = finishedOutput(1).map(c => addChip(st, 1, c.key, c.n, c.p));
          await Promise.all(fresh.map(c => fade(c.g, 1, 600)));
          st.mapOut += fresh.length;
          sync(st);
          note.set("Completed map tasks on a dead machine are rerun; completed REDUCE tasks are not, because their " +
            "output is already replicated in HDFS. " + m2Retry, "ok");
        });
      }

      add("Shuffle: each reducer fetches its partition from every mapper", async st => {
        strip(st, "sort");
        st.reducing = true;
        st.attempts += R;
        sync(st);
        st.reds.forEach(rd => {
          rd.box.rect.removeAttribute("stroke-dasharray");
          rd.rows.innerHTML = "";
          rd.line2.textContent = compact ? "fetching…" : "fetching runs…";
        });
        const runs = st.chips.map(runsOf);
        const jobs = [];
        runs.forEach((rs, m) => rs.forEach((run, p) => {
          const link = st.links[m][p];
          if (run.length) ctx.attr(link, { stroke: `var(--viz-${PCOL[p]})`, "stroke-width": 1.5 });
          else link.setAttribute("stroke-dasharray", "3 4");
          st.fetched[p][m] = run.map(c => ({ key: c.key, n: c.n }));
          jobs.push((async () => {
            await ctx.sleep(m * 220);
            if (run.length) {
              await ctx.fly(flyLayer, { from: G.out(m), to: G.in(p), fill: `var(--viz-${PCOL[p]})`, label: String(run.length), labelSize: fs, ms: 600 });
            } else await ctx.sleep(600);
            arrive(st, m, p, run);
          })());
        }));
        await Promise.all(jobs);
        st.shuffleDone = true;
        st.reds.forEach((rd, p) => {
          rd.line2.textContent = compact ? `3 runs · ${st.loads[p]} rec` : `fetched 3 runs · ${plural(st.loads[p], "record")}`;
        });
        sync(st);
        note.set("This all-to-all copy is why shuffles dominate job cost: every map output record is copied to its reducer, " +
          "almost always over the network. Empty runs still count as fetched.");
      }, "Real reducers start copying as soon as each map task finishes; only reduce() has to wait for all of them.");

      function arrive(st, m, p, run) {
        const b = G.red(p), t = T(st.reds[p].rows, b.x + 8, b.y + Y.row + m * Y.rlh, "", { mono: true });
        t.style.whiteSpace = "pre";
        t.append(s("tspan", { fill: "var(--viz-muted)" }, `M${m + 1}${compact ? " " : ": "}`),
          run.length ? run.map(chipText).join(" ") : s("tspan", { fill: "var(--viz-muted)" }, compact ? "—" : "(empty)"));
        st.shuffled += run.length;
        st.loads[p] += run.length;
        sync(st);
      }

      add("Merge: each reducer merge-sorts the runs it fetched, so all values for a key are adjacent", async st => {
        await Promise.all(st.reds.map(rd => fade(rd.rows, 0, 250)));
        const sep = compact && R === 3 ? "" : " ";
        st.groups = st.reds.map((rd, p) => {
          rd.rows.innerHTML = "";
          rd.rows.setAttribute("opacity", 1);
          rd.line2.textContent = compact ? "merged" : "merged into 1 sorted run";
          const all = st.fetched[p].flat(), b = G.red(p);
          return [...new Set(all.map(c => c.key))].sort().map((key, j) => {
            const vals = all.filter(c => c.key === key).map(c => c.n);
            const t = T(rd.rows, b.x + 8, b.y + Y.row + j * Y.rlh, `${key.slice(1)}: ${vals.join(sep)}`, { mono: true });
            return { key, total: vals.reduce((a, v) => a + v, 0), t };
          });
        });
        await ctx.sleep(300);
        note.set("Each run arrived already sorted, so the reducer only has to merge them, like the last pass of a merge sort. " +
          "Despite the name, nothing about the shuffle is random.");
      });

      add("Reduce: your function is called once per key with all of that key's values", async st => {
        strip(st, "uniq");
        for (let j = 0; j < Math.max(...st.groups.map(g => g.length)); j++) {
          st.groups.forEach(g => { if (g[j]) { g[j].t.textContent = `${g[j].key.slice(1)} → ${g[j].total}`; g[j].t.setAttribute("font-weight", 700); } });
          await ctx.sleep(300);
        }
        st.reds.forEach((rd, p) => {
          const k = st.groups[p].length;
          rd.line2.textContent = compact ? `reduce() ×${k}` : `${plural(k, "key")} → ${plural(k, "reduce() call")}`;
        });
        note.set(`reduce() ran once per key: ${st.groups.flat().length} calls, spread over ${R} reduce tasks. None could start ` +
          "before every map task had finished, because the last mapper might still emit a /home.");
      });

      const every = R === 2 ? "both" : "all 3";
      add(`Output: each reducer writes its own file to HDFS; the job succeeds only when ${every} reducers finish`, async st => {
        strip(st, "all");
        st.reds.forEach(rd => { ctx.attr(rd.box.rect, { stroke: "var(--viz-ok)" }); fade(rd.out, 1, 400); });
        await fade(st.success, 1, 400);
        const counts = st.groups.flat().sort((a, b) => b.total - a.total).map(g => `${g.key} ${g.total}`).join(", ");
        const hot = HASH["/home"] % R;
        note.set(`<b>${counts}.</b> Change R, the combiner or the failure: the answer never changes; only the data moved ` +
          "and the busiest reducer do." + (R === 3 ? ` R${hot} got ${st.loads[hot]} of ${st.shuffled} records because /home is hot: ` +
          "hash partitioning balances keys, not records (more on that in the next section)." : ""), "ok");
      });

      // ----- player -----
      const intro = "Run it once as is. Then change the reducers, turn on the combiner or inject a failure and run it again: " +
        "the final counts never change. Watch what does.";
      const next = ctx.stepper({
        init() {
          scene.innerHTML = "";
          flyLayer.innerHTML = "";
          const st = {
            chips: [[], [], []], fetched: Array.from({ length: R }, () => []), loads: Array(R).fill(0),
            mapOut: 0, shuffled: 0, attempts: 0, retried: false, partitioned: false, reducing: false, shuffleDone: false,
          };
          drawStrip(st);
          if (!compact) {
            [["HDFS blocks", 8], ["Map tasks", 140], ["Shuffle", 316], ["Reduce tasks", 446]]
              .forEach(([str, x]) => T(scene, x, 40, str, { weight: 600, fill: "var(--viz-muted)" }));
          }
          const linkLayer = s("g"), boxLayer = s("g");
          st.arrows = s("g");
          st.chipLayer = s("g");
          scene.append(linkLayer, st.arrows, boxLayer, st.chipLayer);
          st.links = [0, 1, 2].map(m => Array.from({ length: R }, (_, p) => {
            const [x1, y1] = G.out(m), [x2, y2] = G.in(p);
            return linkLayer.appendChild(s("line", { x1, y1, x2, y2, stroke: "var(--viz-line)", "stroke-width": 1.2 }));
          }));
          if (compact) T(scene, G.W / 2, 290, "shuffle", { anchor: "middle", weight: 600, fill: "var(--viz-muted)", halo: true });
          drawBlocks(st, boxLayer);
          drawMaps(st, boxLayer);
          drawReducers(st, boxLayer);
          drawLegendLine();
          st.success = compact
            ? T(scene, G.W / 2, G.H - 64, `✓ _SUCCESS: ${every} reduce tasks finished`, { anchor: "middle", weight: 700, fill: "var(--viz-ok)" })
            : T(scene, G.W - 8, 40, "✓ _SUCCESS", { anchor: "end", weight: 700, fill: "var(--viz-ok)" });
          st.success.setAttribute("opacity", 0);
          sync(st);
          note.set(intro, "info");
          return st;
        },
        steps,
        delay: 1100,
        intro: "A 12-line access log is stored in HDFS as 3 blocks. Press <b>Play</b> to count hits per URL the MapReduce way.",
      });
      player = next;
      stage.innerHTML = "";
      stage.append(svg, legend, next.el, stats, note);
      if (gotoIndex >= 0) next.goto(Math.min(gotoIndex, steps.length - 1));
    }

    build();
    ctx.onResize(() => { if (ctx.compact !== compact) build(); });
  },
});
