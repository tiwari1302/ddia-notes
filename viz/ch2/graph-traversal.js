// "Who was born in the United States and now lives in Europe?" Places nest via WITHIN edges at
// different depths, so the number of hops from a person's place to the target region varies.
// Cypher's -[:WITHIN*0..]-> and SQL's WITH RECURSIVE follow as many hops as it takes; a SQL query
// with k fixed self-joins per side silently misses anyone more than k levels deep.
(function () {
  "use strict";

  const PLACE = {
    na: "North America", us: "United States", idaho: "Idaho", boise: "Boise",
    eu: "Europe", fr: "France", bur: "Burgundy", beaune: "Beaune",
    uk: "United Kingdom", eng: "England", gl: "Greater London", london: "London",
  };
  const SHORT = { na: "N. America", gl: "Gr. London" };   // phone labels
  // Display and evaluation order, left to right. Lucy and Alain sit together for the MARRIED edge,
  // under London; the people whose places are all in the US sit on the left, under that column.
  const PEOPLE = [
    { id: "sam", name: "Sam", born: "boise", lives: "fr" },
    { id: "maya", name: "Maya", born: "us", lives: "beaune" },
    { id: "jon", name: "Jon", born: "idaho", lives: "boise" },
    { id: "lucy", name: "Lucy", born: "idaho", lives: "london" },
    { id: "alain", name: "Alain", born: "beaune", lives: "london" },
  ];
  const SIDES = ["born", "lives"];
  const TARGET = { born: "us", lives: "eu" };

  function parentsOf(extra) {
    const p = { us: "na", idaho: "us", boise: "idaho", fr: "eu", bur: "fr", beaune: "bur", uk: "eu", eng: "uk", london: "eng" };
    if (extra) { p.gl = "eng"; p.london = "gl"; }
    return p;
  }
  // Follow WITHIN edges up from `start` until `target`, the top of the hierarchy, or `limit` hops.
  function climb(start, target, parent, limit = Infinity) {
    const path = [start];
    let cur = start;
    while (cur !== target) {
      const hops = path.length - 1;
      if (!parent[cur]) return { path, hops, ok: false, why: "top" };
      if (hops >= limit) return { path, hops, ok: false, why: "gaveup" };
      cur = parent[cur];
      path.push(cur);
    }
    return { path, hops: path.length - 1, ok: true, why: "match" };
  }
  // Breadth-first waves over incoming WITHIN edges: the rows each recursive-CTE iteration adds.
  function waves(root, parent) {
    const out = [[root]], seen = new Set([root]);
    for (;;) {
      const last = out[out.length - 1];
      const next = Object.keys(parent).filter(c => !seen.has(c) && last.includes(parent[c]));
      if (!next.length) return out;
      next.forEach(c => seen.add(c));
      out.push(next);
    }
  }
  function evaluate(mode, k, extra) {
    const parent = parentsOf(extra);
    const set = root => new Set([].concat(...waves(root, parent)));
    const inUs = set("us"), inEu = set("eu");
    return PEOPLE.map(p => {
      if (mode === "cte") return { id: p.id, matched: inUs.has(p.born) && inEu.has(p.lives) };
      const limit = mode === "fixed" ? k : Infinity;
      const born = climb(p.born, TARGET.born, parent, limit);
      const lives = born.ok ? climb(p.lives, TARGET.lives, parent, limit) : null;
      return { id: p.id, born, lives, matched: born.ok && lives.ok };
    });
  }
  const TRUTH = new Set(evaluate("cypher", 0, false).filter(r => r.matched).map(r => r.id));
  function deepest(extra) {
    const parent = parentsOf(extra);
    const max = side => Math.max(...PEOPLE.map(p => { const c = climb(p[side], TARGET[side], parent); return c.ok ? c.hops : 0; }));
    return `born ${max("born")} · lives ${max("lives")}`;
  }

  const CYPHER = [
    "MATCH (person) -[:BORN_IN]->  () -[:WITHIN*0..]-> (:Location {name: 'United States'}),",
    "      (person) -[:LIVES_IN]-> () -[:WITHIN*0..]-> (:Location {name: 'Europe'})",
    "RETURN person.name",
  ];
  // Complete and runnable on vertices/edges tables (PostgreSQL); UNION also stops cycles.
  const CTE = [
    "WITH RECURSIVE",
    "  in_usa(vertex_id) AS (",
    "      SELECT vertex_id FROM vertices WHERE properties->>'name' = 'United States'",
    "    UNION",
    "      SELECT e.tail_vertex FROM edges e",
    "      JOIN in_usa ON e.head_vertex = in_usa.vertex_id AND e.label = 'within'",
    "  ),",
    "  in_europe(vertex_id) AS (",
    "      SELECT vertex_id FROM vertices WHERE properties->>'name' = 'Europe'",
    "    UNION",
    "      SELECT e.tail_vertex FROM edges e",
    "      JOIN in_europe ON e.head_vertex = in_europe.vertex_id AND e.label = 'within'",
    "  )",
    "SELECT p.properties->>'name' FROM vertices p",
    "JOIN edges b   ON b.tail_vertex = p.vertex_id AND b.label = 'born_in'",
    "JOIN in_usa    ON in_usa.vertex_id = b.head_vertex",
    "JOIN edges l   ON l.tail_vertex = p.vertex_id AND l.label = 'lives_in'",
    "JOIN in_europe ON in_europe.vertex_id = l.head_vertex;",
  ];
  // Lines: comment, SELECT, JOIN b, k LEFT JOINs, JOIN l, k LEFT JOINs, WHERE, AND = 6 + 2k.
  function fixedSql(k) {
    const chain = (pre, first) => Array.from({ length: k }, (_, i) =>
      `LEFT JOIN edges ${pre}${i + 1} ON ${pre}${i + 1}.tail_vertex = ${i ? pre + i : first}.head_vertex AND ${pre}${i + 1}.label = 'within'`);
    const names = (first, pre) => [first].concat(Array.from({ length: k }, (_, i) => pre + (i + 1)))
      .map(a => `name_of(${a}.head_vertex)`).join(", ");
    return [
      "-- schematic: one extra self-join per level; name_of(v) = v's name",
      "SELECT name_of(p.vertex_id) FROM vertices p",
      "JOIN edges b ON b.tail_vertex = p.vertex_id AND b.label = 'born_in'",
      ...chain("bw", "b"),
      "JOIN edges l ON l.tail_vertex = p.vertex_id AND l.label = 'lives_in'",
      ...chain("lw", "l"),
      `WHERE 'United States' IN (${names("b", "bw")})`,
      `  AND 'Europe' IN (${names("l", "lw")});`,
    ];
  }

  // ---- geometry helpers ----
  const hit = (r, x, y, pad) => x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad;
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  // Quadratic curve from the rim of a circle (x0, y0, r) to (x2, y2), bowed sideways by `bend`.
  function quad(x0, y0, r, x2, y2, bend) {
    const dx = x2 - x0, dy = y2 - y0, len = Math.hypot(dx, dy) || 1;
    const qx = (x0 + x2) / 2 - (dy / len) * bend, qy = (y0 + y2) / 2 + (dx / len) * bend;
    const ul = Math.hypot(qx - x0, qy - y0) || 1;
    return { x1: x0 + ((qx - x0) / ul) * r, y1: y0 + ((qy - y0) / ul) * r, qx, qy, x2, y2 };
  }
  const qAt = (q, t) => {
    const a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t;
    return [a * q.x1 + b * q.qx + c * q.x2, a * q.y1 + b * q.qy + c * q.y2];
  };
  // Picks the anchor side and bend for a person -> place edge that stays clear of other boxes and
  // people; prefers the right side for the left column and the bottom elsewhere, and gentle bends.
  function route(g, p, target) {
    const b = g.box[target], x0 = g.px[p.id], bottom = b.y + b.h;
    const pref = b.cx < g.W / 3 ? "right" : "bottom";
    const anchors = [["right", b.x + b.w, b.cy], ["left", b.x, b.cy], ["bottom", b.cx, bottom],
      ["bottom", b.cx - b.w / 3, bottom], ["bottom", b.cx + b.w / 3, bottom]];
    let best = null;
    for (const [side, ax, ay] of anchors) {
      for (let bend = -90; bend <= 90; bend += 10) {
        const q = quad(x0, g.py, g.r + 1, ax, ay, bend);
        let cost = Math.abs(bend) / 30 + (side === pref ? 0 : 1.5) + (side === "bottom" && ax !== b.cx ? 0.5 : 0);
        for (let i = 1; i < 40; i++) {
          const [x, y] = qAt(q, i / 40);
          if (x < 4 || x > g.W - 4 || y < 4) cost += 40;
          // The target box counts too, except right at the anchor, so edges can't hug its border.
          for (const id of g.ids) if (hit(g.box[id], x, y, id === target ? 3 : 5) && (id !== target || Math.hypot(x - ax, y - ay) > 10)) cost += 20;
          for (const o of g.folks) if (o.id !== p.id && hit(o, x, y, 2)) cost += 8;
        }
        if (!best || cost < best.cost) best = Object.assign(q, { cost });
      }
    }
    return best;
  }

  Viz.register("ch2/graph-traversal", {
    title: "Born in the US, living in Europe",
    logic: { parentsOf, climb, waves, evaluate, fixedSql, deepest, PEOPLE, TRUTH, CTE, CYPHER },
    mount(root, ctx) {
      const { s, h, ui } = ctx;
      let mode = "cypher", k = 1, extra = false;
      let compact = ctx.compact, epoch = 0, running = false;
      let res = freshRes(), tr = freshTr();
      let V = null, G = null, noteState = null;

      // res: results that persist until Clear; tr: transient highlights of the current step.
      function freshRes() { return { badges: {}, markers: {}, rings: {}, ringEdges: {}, stats: null }; }
      function freshTr() { return { cursor: null, flash: {}, path: {}, cut: null, focus: null, show: {}, lines: [], tone: "warn" }; }

      const INITIAL = "Who was born in the United States and now lives in Europe? Places are recorded at different " +
        "granularity (Maya's birthplace is a country, Lucy's a state, Sam's a city), so the number of " +
        "<code>WITHIN</code> hops differs per person. Press <b>Run</b>.";
      const FIXED = () => `Fixed joins: the query has one self-join per level it can climb (k = ${k}: ` +
        `${k} <code>LEFT JOIN</code>${k === 1 ? "" : "s"} per side). Pick k and press <b>Run</b>.`;
      const idleNote = () => (mode === "fixed" ? FIXED() : INITIAL);
      const tone = (t, txt) => `<span style="color:var(--viz-${t});font-weight:700">${txt}</span>`;
      const hopsTxt = n => `${n} hop${n === 1 ? "" : "s"}`;
      const list = names => (names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0]);
      function note(html, t = "info") { noteState = [html, t]; V.note.set(html, t); }

      function geometry() {
        const g = compact
          ? { W: 360, H: 366, bw: 96, bh: 26, fs: 11, r: 15, py: 320, ny: 350, by: 296, xs: [34, 98, 162, 242, 322],
            L: 56, M: 196, R: 306, E: 250, rows: [28, 84, 140, 196], deep: [186, 232] }
          : { W: 640, H: 380, bw: 110, bh: 28, fs: 12, r: 17, py: 330, ny: 362, by: 304, xs: [170, 250, 330, 420, 510],
            L: 90, M: 360, R: 545, E: 450, rows: [30, 92, 154, 216], deep: [205, 256] };
        const [r0, r1, r2, r3] = g.rows;
        // The UK branch is the one that grows, so it sits on the right where it has room below.
        const c = { na: [g.L, r0], us: [g.L, r1], idaho: [g.L, r2], boise: [g.L, r3], eu: [g.E, r0],
          fr: [g.M, r1], bur: [g.M, r2], beaune: [g.M, r3], uk: [g.R, r1], eng: [g.R, r2], london: [g.R, extra ? g.deep[1] : r3] };
        if (extra) c.gl = [g.R, g.deep[0]];
        g.parent = parentsOf(extra);
        g.ids = Object.keys(c);
        g.box = {};
        g.ids.forEach(id => { const [x, y] = c[id]; g.box[id] = { x: x - g.bw / 2, y: y - g.bh / 2, w: g.bw, h: g.bh, cx: x, cy: y }; });
        // WITHIN edge: child's top to parent's bottom (nudged toward the child when they're offset).
        g.up = {};
        g.ids.filter(id => g.parent[id]).forEach(id => {
          const a = g.box[id], b = g.box[g.parent[id]], dx = a.cx - b.cx;
          g.up[id] = { x1: a.cx, y1: a.y, x2: b.cx + Math.sign(dx) * Math.min(Math.abs(dx) * 0.3, b.w * 0.3), y2: b.y + b.h };
        });
        g.px = {};
        PEOPLE.forEach((p, i) => { g.px[p.id] = g.xs[i]; });
        // Each person's footprint: badge above, circle, name below.
        g.folks = PEOPLE.map(p => ({ id: p.id, x: g.px[p.id] - 26, y: g.by - 9, w: 52, h: g.ny + 8 - (g.by - 9) }));
        g.avoid = g.ids.map(id => g.box[id]).concat(g.folks);
        g.route = {};
        PEOPLE.forEach(p => SIDES.forEach(side => { g.route[p.id + side] = route(g, p, p[side]); }));
        return g;
      }

      // Fixed-size arrowheads (the toolkit's markers scale with stroke width).
      function head(color) {
        if (!V.heads[color]) {
          const id = `gt${ctx.uid}-${Object.keys(V.heads).length}`;
          V.svg.defs.appendChild(s("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 8, markerHeight: 8,
            markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" }, s("path", { d: "M0,0 L10,5 L0,10 z", fill: color })));
          V.heads[color] = `url(#${id})`;
        }
        return V.heads[color];
      }

      function drawScene() {
        G = geometry();
        if (V.scene) V.scene.remove();
        const L = {};
        ["within", "pedges", "rings", "boxes", "people", "marks"].forEach(n => { L[n] = s("g"); });
        V.scene = s("g", null, L.within, L.pedges, L.rings, L.boxes, L.people, L.marks);
        V.svg.appendChild(V.scene);
        Object.assign(V, { L, within: {}, rings: {}, boxes: {}, pedge: {}, people: {} });
        const f = n => n.toFixed(1);
        for (const id of G.ids) {
          const b = G.box[id], u = G.up[id];
          if (u) V.within[id] = L.within.appendChild(s("path", { d: `M${u.x1},${u.y1} L${f(u.x2)},${u.y2}`, fill: "none" }));
          V.rings[id] = L.rings.appendChild(s("rect", { x: b.x - 4, y: b.y - 4, width: b.w + 8, height: b.h + 8, rx: 11, fill: "none", "stroke-width": 2 }));
          V.boxes[id] = L.boxes.appendChild(ctx.box({ x: b.x, y: b.y, w: b.w, h: b.h, label: (compact && SHORT[id]) || PLACE[id],
            size: G.fs, fill: "var(--viz-c2-soft)", stroke: "var(--viz-c2)" }));
        }
        const xa = G.px.lucy + G.r + 3, xb = G.px.alain - G.r - 3;
        L.people.append(
          s("path", { d: `M${xa},${G.py} L${xb},${G.py}`, fill: "none", stroke: "var(--viz-c5)", "stroke-width": 1.5, "stroke-dasharray": "4 3" }),
          ctx.text((xa + xb) / 2, G.py + G.fs + 3, "married", { size: G.fs, fill: "var(--viz-muted)", halo: true }));
        for (const p of PEOPLE) {
          const x = G.px[p.id];
          V.pedge[p.id] = {};
          SIDES.forEach(side => {
            const q = G.route[p.id + side];
            V.pedge[p.id][side] = L.pedges.appendChild(s("path", {
              d: `M${f(q.x1)},${f(q.y1)} Q${f(q.qx)},${f(q.qy)} ${q.x2},${q.y2}`, fill: "none",
              stroke: `var(--viz-${side === "born" ? "c6" : "c7"})`, "stroke-dasharray": side === "born" ? "5 4" : null,
            }));
          });
          const node = ctx.node({ x, y: G.py, r: G.r, label: p.name[0], size: G.fs, fill: "var(--viz-c5-soft)", stroke: "var(--viz-c5)" });
          const g = s("g", null, node, ctx.text(x, G.ny, p.name, { size: G.fs }));
          const badge = ctx.text(x, G.by, "", { size: G.fs, weight: 700, halo: true });
          L.people.append(g, badge);
          V.people[p.id] = { g, node, badge };
        }
        paint();
      }

      // Applies res + tr to every element; cheap enough to call after each change.
      function paint() {
        for (const id of G.ids) {
          const t = tr.flash[id] || (tr.cursor && tr.cursor.id === id ? "warn" : null);
          ctx.attr(V.boxes[id].rect, { stroke: `var(--viz-${t || "c2"})`, "stroke-width": t ? 2.5 : 1.5 });
          const ring = V.rings[id];
          ring.style.display = res.rings[id] ? "" : "none";
          if (res.rings[id]) ctx.attr(ring, { stroke: `var(--viz-${res.rings[id]})` });
          const w = V.within[id];
          if (!w) continue;
          const c = tr.path[id] || (tr.cut === id ? "bad" : res.ringEdges[id]);
          const col = `var(--viz-${c || "muted"})`;
          ctx.attr(w, { stroke: col, "stroke-width": tr.path[id] ? 2.5 : c ? 1.8 : 1.2,
            "stroke-dasharray": tr.cut === id ? "4 3" : "none", "marker-end": head(col) });
        }
        for (const p of PEOPLE) {
          const P = V.people[p.id], focus = tr.focus === p.id;
          P.g.setAttribute("opacity", tr.focus && !focus ? 0.45 : 1);
          ctx.attr(P.node.circle, { "stroke-width": focus ? 3 : 2 });
          SIDES.forEach(side => {
            const e = V.pedge[p.id][side], on = !!tr.show[p.id + side];
            e.style.display = on || !compact ? "" : "none";
            ctx.attr(e, { opacity: on ? 1 : 0.25, "stroke-width": on ? 2 : 1.4, "marker-end": head(`var(--viz-${side === "born" ? "c6" : "c7"})`) });
          });
          const b = res.badges[p.id];
          P.badge.textContent = { ok: "✓", bad: "✕ missed", muted: "–" }[b] || "";
          ctx.attr(P.badge, { fill: `var(--viz-${b || "muted"})` });
        }
        paintMarks();
        Array.from(V.code.children).forEach((row, i) => {
          const on = tr.lines.includes(i);
          row.style.background = on ? `var(--viz-${tr.tone}-soft)` : "";
          row.style.boxShadow = on ? `inset 3px 0 var(--viz-${tr.tone})` : "";
        });
      }

      // A gave-up marker is a tag on the top border of the node where climbing stopped, where the
      // WITHIN edge the query could not follow begins. The cursor label goes beside the current box.
      function paintMarks() {
        const layer = V.L.marks, placed = [];
        layer.innerHTML = "";
        for (const id in res.markers) placed.push(tag(layer, G.box[id], `✕ gave up after ${res.markers[id]}`));
        if (tr.cursor) {
          const b = G.box[tr.cursor.id];
          label(layer, `hop ${tr.cursor.hops}`, [[b.x + b.w + 6, b.cy, "start"], [b.x - 6, b.cy, "end"],
            [b.x + b.w, b.y - 8, "end"], [b.x + b.w, b.y + b.h + 9, "end"]], "warn", placed);
        }
      }
      // A pill straddling a box's top border; it also covers the start of the edge not followed.
      function tag(layer, b, str) {
        const g = layer.appendChild(s("g"));
        const t = ctx.text(b.cx, b.y - 4, str, { size: G.fs, weight: 700, fill: "var(--viz-bad)" });
        g.appendChild(t);
        const w = (t.getComputedTextLength() || str.length * G.fs * 0.6) + 12, hh = G.fs + 5;
        const r = { x: b.cx - w / 2, y: b.y - 4 - hh / 2, w, h: hh };
        const rect = o => s("rect", Object.assign({ x: r.x, y: r.y, width: w, height: hh, rx: hh / 2 }, o));
        g.insertBefore(rect({ fill: "var(--viz-bg)" }), t);
        g.insertBefore(rect({ fill: "var(--viz-bad-soft)", stroke: "var(--viz-bad)", "stroke-width": 1 }), t);
        return r;
      }
      // Puts a halo label at the first candidate spot that stays inside the scene and clear of boxes,
      // people and `placed` rects (or the least crowded one).
      function label(layer, str, cands, t, placed) {
        const el = layer.appendChild(ctx.text(0, 0, str, { size: G.fs, weight: 700, fill: `var(--viz-${t})`, halo: true }));
        const w = el.getComputedTextLength() || str.length * G.fs * 0.6;
        let best = null;
        for (const [x, y, anchor] of cands) {
          const x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
          const r = { x: x0 - 2, y: y - G.fs / 2 - 1, w: w + 4, h: G.fs + 2 };
          const bad = (r.x < 0 || r.x + r.w > G.W || r.y < 0 ? 10 : 0) + G.avoid.concat(placed).filter(o => overlap(r, o)).length;
          if (!best || bad < best.bad) best = { bad, x, y, anchor };
          if (!bad) break;
        }
        ctx.attr(el, { x: best.x, y: best.y, "text-anchor": best.anchor });
      }

      function renderQuery() {
        const lines = mode === "cypher" ? CYPHER : mode === "fixed" ? fixedSql(k) : CTE;
        V.code.innerHTML = "";
        lines.forEach((ln, i) => V.code.appendChild(h("span", { style: "display:grid;grid-template-columns:2.4em 1fr;border-radius:4px;padding:0 4px 0 0" },
          h("span", { style: "color:var(--text-muted);text-align:right;padding-right:0.9em;user-select:none" }, String(i + 1)),
          h("span", { style: "white-space:pre-wrap;overflow-wrap:anywhere" }, ln))));
        const n = `${lines.length} lines`;
        V.lineBadge.textContent = n;
        V.stats.set("lines", n, "");
        V.title.textContent = { cypher: "Cypher", fixed: `SQL, fixed joins (k = ${k})`, cte: "SQL, WITH RECURSIVE" }[mode];
        V.kSlider.input.disabled = mode !== "fixed";
        V.kSlider.style.opacity = mode === "fixed" ? 1 : 0.5;
        paint();
      }

      function setStats(found, missed) {
        V.stats.set("found", found ? found[0] : "–", found ? found[1] : "");
        V.stats.set("missed", missed ? missed[0] : "–", missed ? missed[1] : "");
        res.stats = found ? [found, missed] : null;
      }
      // Interrupts any run and clears every result and highlight.
      function stop() {
        epoch++;
        running = false;
        res = freshRes();
        tr = freshTr();
        V.run.disable(false);
        setStats(null, null);
        paint();
      }
      const pause = async (ms, my) => { await ctx.sleep(ms); return my === epoch; };

      async function run() {
        stop();
        const my = epoch;
        running = true;
        V.run.disable(true);
        if (!(await (mode === "cte" ? runCte(my) : runClimb(my)))) return;
        running = false;
        V.run.disable(false);
        tr = freshTr();
        finish();
      }

      function tally(final) {
        const by = t => PEOPLE.filter(p => res.badges[p.id] === t).map(p => p.name);
        const found = by("ok"), missed = by("bad");
        setStats([`${found.length} / ${TRUTH.size}`, final ? (found.length === TRUTH.size ? "ok" : "bad") : ""],
          [String(missed.length), final ? (missed.length ? "bad" : "ok") : ""]);
        return { found, missed };
      }

      function finish() {
        const { missed } = tally(true);
        paint();
        if (mode === "cypher") {
          return note("Found Lucy, Sam and Maya. <code>*0..</code> means 'follow zero or more <code>WITHIN</code> edges', " +
            "so the query doesn't care whether a place sits 0, 1 or 4 levels below the target.", "ok");
        }
        if (mode === "cte") {
          return note("<code>WITH RECURSIVE</code> gets it right at any depth: it keeps expanding the set of places inside the US " +
            "(and inside Europe) until no new ones appear, then checks each person. Correct, in several times the lines of the Cypher query.", "ok");
        }
        if (missed.length && extra && k === 3) {
          return note("Someone inserted 'Greater London'. Lucy now lives 4 levels below Europe, and the 3-join query drops her. " +
            "The Cypher and recursive versions are unaffected.", "bad");
        }
        if (missed.length) {
          const reach = k === 0 ? "can't climb any <code>WITHIN</code> level: it only matches places named exactly 'United States' and 'Europe'"
            : `can climb at most ${k} <code>WITHIN</code> level${k === 1 ? "" : "s"} on each side`;
          return note(`With k = ${k} the query ${reach}. ${list(missed)} ${missed.length === 1 ? "is" : "are"} silently missed: ` +
            "no error, just a wrong answer.", "bad");
        }
        note(extra ? "k = 4 covers today's data, until someone adds another level. A fixed-depth query is a bet that the hierarchy never grows."
          : `k = ${k} covers today's data. Now turn on <b>Add a level</b>. The hierarchy grows; the query doesn't.`, "warn");
      }

      // Query-panel lines that do the work for each hop (cypher: the MATCH line; fixed: that hop's join).
      function hopLines(side, i) {
        if (mode === "cypher") return [SIDES.indexOf(side)];
        const base = side === "born" ? 2 : 3 + k;
        return [base + i];
      }
      const checkLine = side => (mode === "cypher" ? SIDES.indexOf(side) : (side === "born" ? 4 : 5) + 2 * k);
      function sideText(side, c, upto) {
        const names = c.path.slice(0, upto).map(id => PLACE[id]).join(" → ");
        const head = `${side === "born" ? "born in" : "lives in"} ${names}`;
        if (upto < c.path.length) return head + " …";
        if (c.why === "match") return `${head} ${tone("ok", "✓ " + hopsTxt(c.hops))}`;
        if (c.why === "top") return `${head} ${tone("muted", "– top reached, not in " + PLACE[TARGET[side]])}`;
        return `${head} ${tone("bad", "✕ gave up after " + hopsTxt(c.hops))}`;
      }

      async function runClimb(my) {
        const limit = mode === "fixed" ? k : Infinity;
        for (const p of PEOPLE) {
          tr = freshTr();
          tr.focus = p.id;
          const done = [];
          let ok = true;
          for (const side of SIDES) {
            const c = climb(p[side], TARGET[side], G.parent, limit);
            tr.show[p.id + side] = true;
            paint();
            if (!(await pause(400, my))) return false;
            for (let i = 0; i < c.path.length; i++) {
              if (i) tr.path[c.path[i - 1]] = side === "born" ? "c6" : "c7";
              tr.cursor = { id: c.path[i], hops: i };
              Object.assign(tr, { lines: hopLines(side, i), tone: "warn" });
              note(`<b>${p.name}</b>: ` + done.concat(sideText(side, c, i + 1)).join("<br>"));
              paint();
              if (!(await pause(350, my))) return false;
            }
            const last = c.path[c.path.length - 1];
            tr.flash[last] = c.ok ? "ok" : c.why === "top" ? "muted" : "bad";
            if (c.why === "gaveup") { tr.cut = last; res.markers[last] = k; }
            Object.assign(tr, { lines: [checkLine(side)], tone: c.ok ? "ok" : "bad" });
            done.push(sideText(side, c, c.path.length));
            note(`<b>${p.name}</b>: ` + done.join("<br>"));
            paint();
            if (!(await pause(350, my))) return false;
            if (!c.ok) { ok = false; break; }
          }
          res.badges[p.id] = ok ? "ok" : mode === "fixed" && TRUTH.has(p.id) ? "bad" : "muted";
          tally(false);
          paint();
          if (!(await pause(250, my))) return false;
        }
        return true;
      }

      async function runCte(my) {
        const sets = {};
        for (const side of SIDES) {
          const col = side === "born" ? "c6" : "c7", name = side === "born" ? "in_usa" : "in_europe", base = side === "born" ? 2 : 8;
          const ws = waves(TARGET[side], G.parent), all = [];
          for (let i = 0; i < ws.length; i++) {
            ws[i].forEach(id => { res.rings[id] = col; if (i) res.ringEdges[id] = col; all.push(id); });
            Object.assign(tr, { lines: i ? [base + 2, base + 3] : [base], tone: "warn" });
            const places = ws[i].map(id => PLACE[id]).join(", ");
            note(`<b>${name}</b> (${side === "born" ? "blue" : "orange"} rings) ` + (i ? `iteration ${i}: + ${places}` : `starts with ${places}`));
            paint();
            if (!(await pause(400, my))) return false;
          }
          note(`<b>${name}</b> iteration ${ws.length}: no new places, so the recursion stops with ${all.length} places.`);
          if (!(await pause(500, my))) return false;
          sets[side] = new Set(all);
        }
        for (const p of PEOPLE) {
          tr = freshTr();
          tr.focus = p.id;
          tr.show[p.id + "born"] = tr.show[p.id + "lives"] = true;
          const inB = sets.born.has(p.born), inL = sets.lives.has(p.lives);
          tr.flash[p.born] = inB ? "ok" : "muted";
          if (p.lives !== p.born) tr.flash[p.lives] = inL ? "ok" : "muted";
          Object.assign(tr, { lines: [14, 15, 16, 17], tone: inB && inL ? "ok" : "warn" });
          const part = (verb, place, inSet, set) => `${verb} ${PLACE[place]} ` + (inSet ? tone("ok", `∈ ${set} ✓`) : tone("muted", `∉ ${set}`));
          note(`<b>${p.name}</b>: ${part("born in", p.born, inB, "in_usa")} · ${part("lives in", p.lives, inL, "in_europe")}`);
          paint();
          if (!(await pause(300, my))) return false;
          res.badges[p.id] = inB && inL ? "ok" : "muted";
          tally(false);
          paint();
          if (!(await pause(300, my))) return false;
        }
        return true;
      }

      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const seg = ui.segmented({
          label: "Query", value: mode,
          options: [{ value: "cypher", label: "Cypher *0.." }, { value: "fixed", label: compact ? "SQL fixed" : "SQL, fixed joins" },
            { value: "cte", label: compact ? "SQL recursive" : "SQL WITH RECURSIVE" }],
          onChange: v => { mode = v; stop(); renderQuery(); note(v === "fixed" ? FIXED() : INITIAL + " (The k slider only applies to fixed joins.)"); },
        });
        const kSlider = ui.slider({
          label: "Joins per hierarchy (k)", min: 0, max: 4, step: 1, value: k, format: v => v + (v === 1 ? " hop" : " hops"),
          onInput: v => { k = v; stop(); renderQuery(); note(FIXED()); },
        });
        const toggle = ui.toggle({
          label: "Add a level: Greater London", value: extra,
          onChange: v => {
            extra = v;
            stop();
            drawScene();
            V.stats.set("depth", deepest(extra), "info");
            note(v ? "Someone added a level: Greater London now sits between England and London, so Lucy and Alain live 4 " +
              "<code>WITHIN</code> hops below Europe. Press <b>Run</b>." : "Back to the original hierarchy: London sits directly inside England. Press <b>Run</b>.");
          },
        });
        const run_ = ui.button("▶ Run query", () => run(), { kind: "primary" });
        const clear = ui.button("Clear", () => { stop(); note(idleNote()); }, { kind: "ghost" });
        const W = compact ? 360 : 640, H = compact ? 366 : 380;
        const svg = ctx.svg({ w: W, h: H, label: "Places nested by WITHIN edges, and five people with BORN_IN and LIVES_IN edges to them" });
        const stats = ui.stats([
          { key: "found", label: "Emigrants found", value: "–" },
          { key: "missed", label: "Silently missed", value: "–" },
          { key: "depth", label: "Deepest path in data", value: deepest(extra), tone: "info" },
          { key: "lines", label: "Query length", value: "" },
        ]);
        const title = h("span", { class: "viz-panel-title", style: "margin:0" });
        const lineBadge = ui.badge("", "info");
        const code = h("pre", { style: `margin:8px 0 0;font-family:var(--font-mono);font-size:${compact ? 11 : 12}px;line-height:1.55;white-space:pre-wrap` });
        const noteEl = ui.note("");
        noteEl.style.minHeight = compact ? "" : "4.9em";
        V = { svg, heads: {}, run: run_, kSlider, stats, note: noteEl, code, lineBadge, title };
        const codePanel = ui.panel(null, h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:8px" }, title, lineBadge), code);
        codePanel.style.marginTop = "12px";   // the note above it has no bottom margin
        root.append(
          ui.bar(seg),
          ui.bar(kSlider, toggle, run_, clear),
          svg,
          ui.legend([
            { color: "var(--viz-c2)", label: "Location", shape: "square" },
            { color: "var(--viz-c5)", label: "Person", shape: "dot" },
            { color: "var(--viz-c6)", label: "BORN_IN", shape: "dash" },
            { color: "var(--viz-c7)", label: "LIVES_IN", shape: "line" },
            { color: "var(--viz-muted)", label: "WITHIN", shape: "line" },
          ]),
          stats,
          noteEl,
          codePanel,
        );
        drawScene();
        renderQuery();
        if (res.stats) setStats(...res.stats);
        note(...(noteState || [INITIAL]));
      }

      build();
      ctx.onResize(() => {
        if (ctx.compact === compact) return;
        if (running) { stop(); noteState = null; }
        build();
      });
    },
  });
})();
