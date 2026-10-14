// Range vs hash partitioning (DDIA ch6). Eight sensors write one reading a minute, keyed by
// (sensor, time), into four partitions. Partitioning by time range sends every new write to the
// newest range; hashing the key spreads writes but scatters every range query; ranging on the
// sensor first (then time) gets both for per-sensor queries but not for cross-sensor ones.
(function () {
  "use strict";

  const DAY = 24 * 60, WINDOW = 30, NP = 4;   // minutes per day, ticks in the load window, partitions
  const SENSORS = [1, 2, 3, 4, 5, 6, 7, 8];
  const NODES = "ABCD";
  const HASH_RANGES = ["00–3F", "40–7F", "80–BF", "C0–FF"];
  const pad = n => String(n).padStart(2, "0");
  const hhmm = t => pad(Math.floor(t / 60)) + ":" + pad(t % 60);
  const fmtN = n => (n >= 10000 ? (n / 1000).toFixed(1) + "k" : n.toLocaleString("en-US"));
  const keyOf = (s, t, sec) => `S${s} ${hhmm(t)}:${pad(sec)}`;
  const zeros = () => [0, 0, 0, 0];
  const C = k => `var(--viz-${k})`;

  // FNV-1a followed by murmur3's fmix32 finalizer (plain FNV-1a mixes short, similar keys poorly).
  function hash32(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  }

  // ---------------- Pure model (no DOM) ----------------
  /** Seconds within each minute at which sensor s takes a reading (a busy S3 reads every 6 s). */
  const secondsOf = (s, hot) => (s === 3 && hot ? [0, 6, 12, 18, 24, 30, 36, 42, 48, 54] : [0]);
  const totalRate = hot => SENSORS.reduce((a, s) => a + secondsOf(s, hot).length, 0);

  function partitionOf(scheme, s, t, sec) {
    if (scheme === "time") return Math.floor(t / 360);            // today's 6-hour timestamp ranges
    if (scheme === "hash") return hash32(keyOf(s, t, sec)) >>> 30;  // top 2 bits = 4 equal hash ranges
    return (s - 1) >> 1;                                           // S1-S2 | S3-S4 | S5-S6 | S7-S8
  }
  /** Adds the rows that `sensors` write at minute t to the per-partition counts `into`. */
  function countMinute(scheme, hot, t, sensors = SENSORS, into = zeros()) {
    for (const s of sensors) for (const sec of secondsOf(s, hot)) into[partitionOf(scheme, s, t, sec)]++;
    return into;
  }
  function rangeLabel(scheme, p, compact) {
    if (scheme === "time") return hhmm(p * 360) + "–" + hhmm(p * 360 + 359);
    if (scheme === "hash") return "hash " + HASH_RANGES[p];
    return `S${2 * p + 1}–S${2 * p + 2}` + (compact ? " by time" : ", sorted by time");
  }
  /** Q2 asks for one past hour of all sensors: 10:00-11:00, or 00:00-01:00 before 11:00. */
  const q2Start = t => (t >= 11 * 60 ? 10 * 60 : 0);
  const q2Label = t => `Query: all sensors ${hhmm(q2Start(t))}–${hhmm(q2Start(t) + 60)}`;

  /** Which partitions a query must ask, and the rows each reads and returns. */
  function planQuery(which, S) {
    const a = which === "q1" ? S.t - 119 : q2Start(S.t), b = which === "q1" ? S.t : a + 59;
    const sensors = which === "q1" ? [3] : SENSORS;
    const ret = zeros(), overlap = zeros();
    for (let t = a; t <= b; t++) {
      countMinute(S.scheme, S.hot, t, sensors, ret);
      overlap[Math.floor(t / 360)]++;
    }
    const R = totalRate(S.hot);
    const per = ret.map((n, p) => {
      if (S.scheme === "hash") return { asked: true, read: S.rows[p], ret: n, full: true };
      if (S.scheme === "time") return { asked: overlap[p] > 0, read: overlap[p] * R, ret: n, full: false };
      return { asked: n > 0, read: n, ret: n, full: false };
    });
    const sum = k => per.reduce((acc, x) => acc + (x.asked ? x[k] : 0), 0);
    const contacted = per.map((x, p) => (x.asked ? p : -1)).filter(p => p >= 0);
    return { which, scheme: S.scheme, a, b, per, contacted, read: sum("read"), ret: sum("ret"), full: S.scheme === "hash" };
  }

  // ---------------- Layouts ----------------
  const DESK = {
    W: 640, H: 330, fs: 12, title: 13,
    caption: [16, 18], route: [624, 18, "end"],
    sensor: i => [60 + i * 74, 56], sr: 14, badge: [15, -13],
    box: p => ({ x: 16 + p * 156, y: 100, w: 144, h: 136 }),
    app: [320, 300], ar: 16, port: [320, 284],
    dock: p => [320 + (p - 1.5) * 28, 278],   // responses land side by side so their labels don't collide
    writeTo: (bx, s) => [bx.x + bx.w / 2 + (s - 4.5) * 9, bx.y],
    askAt: bx => [bx.x + bx.w / 2, bx.y + bx.h],
  };
  const PHONE = {
    W: 360, H: 360, fs: 11, title: 12,
    caption: [10, 13], route: [10, 29, "start"],
    sensor: i => [22, 42 + (i >> 1) * 80 + 17.5 + (i % 2) * 35], sr: 12, badge: [14, -11],
    box: p => ({ x: 60, y: 42 + p * 80, w: 214, h: 70 }),
    app: [334, 197], ar: 15, port: [319, 197],
    dock: () => [313, 197],
    writeTo: (bx, s) => [bx.x, bx.y + bx.h / 2 + (s - 4.5) * 6],
    askAt: bx => [bx.x + bx.w, bx.y + bx.h / 2],
  };

  Viz.register("ch6/range-vs-hash", {
    title: "Range vs hash partitioning",
    mount(root, ctx) {
      const { s, ui } = ctx;
      // State lives outside build() so a phone <-> desktop rebuild keeps it.
      // t = minute of today's latest readings; window = per-partition writes of the last 30 ticks.
      const S = { scheme: "time", t: 0, ingest: true, hot: false, window: [], rows: zeros(), replaying: false };
      let lastQuery = null, pending = null, running = false, epoch = 0;
      const flash = new Set();
      let view = null, compact = ctx.compact;

      /** Recomputes today's rows and the load window as if the current settings held all day. */
      function prefill(endMinute) {
        S.t = endMinute;
        S.replaying = false;
        S.rows = zeros();
        for (let t = 0; t <= S.t; t++) countMinute(S.scheme, S.hot, t, SENSORS, S.rows);
        S.window = [];
        for (let t = S.t - WINDOW + 1; t <= S.t; t++) S.window.push(countMinute(S.scheme, S.hot, t));
      }
      const setClock = H => prefill(H * 60 + WINDOW - 1);

      function shares() {
        const sums = zeros();
        S.window.forEach(c => c.forEach((n, p) => { sums[p] += n; }));
        const total = sums.reduce((x, y) => x + y, 0) || 1;
        return sums.map(n => n / total);
      }

      function tick() {
        if (!S.ingest) return;
        // After 23:59 the clock replays the last hour; those keys already exist, so rows stay put.
        if (S.t === DAY - 1) { S.t = DAY - 60; S.replaying = true; } else S.t++;
        const c = countMinute(S.scheme, S.hot, S.t);
        S.window.push(c);
        if (S.window.length > WINDOW) S.window.shift();
        if (!S.replaying) c.forEach((n, p) => { S.rows[p] += n; });
        animateWrites();
        render();
      }

      function animateWrites() {
        const v = view;
        if (!v || ctx.instant) return;
        const send = (si, sec) => {
          const p = partitionOf(S.scheme, si, S.t, sec);
          const [x, y] = v.G.sensor(si - 1), from = compact ? [x + v.G.sr, y] : [x, y + v.G.sr];  // leave from the edge
          ctx.fly(v.packets, { from, to: v.G.writeTo(v.G.box(p), si), ms: 600, r: 5, fill: C("c6") });
        };
        SENSORS.forEach(si => send(si, 0));
        // Only S3's first 4 extra readings are animated, to keep the picture readable.
        if (S.hot) [6, 12, 18, 24].forEach((sec, k) => ctx.after(110 * (k + 1), () => { if (view === v) send(3, sec); }));
      }

      // ---------- interactions ----------
      function invalidate() {
        epoch++;
        running = false; pending = null; lastQuery = null;
        flash.clear();
      }
      function changed(endMinute) {
        invalidate();
        prefill(endMinute === undefined ? S.t : endMinute);
        render();
      }
      function resetAll() {
        Object.assign(S, { scheme: "time", ingest: true, hot: false });
        const c = view.controls;
        c.scheme.set("time"); c.clock.set(14); c.ingest.set(true); c.hot.set(false);
        invalidate();
        setClock(14);
        render();
      }

      async function runQuery(which) {
        if (running) return;
        const my = ++epoch, v = view, G = v.G;
        const plan = planQuery(which, S);
        running = true; lastQuery = null; pending = plan;
        render();
        await Promise.all(plan.contacted.map(p => ctx.fly(v.packets, {
          from: G.port, to: G.askAt(G.box(p)), ms: 500, r: 6, fill: C("c6"), label: compact ? undefined : "?", labelSize: G.fs,
        })));
        if (my !== epoch) return;
        plan.contacted.forEach(p => flash.add(p));
        render();
        await ctx.sleep(400);
        if (my !== epoch) return;
        flash.clear();
        render();
        await Promise.all(plan.contacted.map(p => ctx.fly(v.packets, {
          // On phones the App sits beside the boxes, so the per-box text carries the counts instead.
          from: G.askAt(G.box(p)), to: G.dock(p), ms: 500, r: 6, fill: C("ok"), label: compact ? undefined : fmtN(plan.per[p].ret), labelSize: G.fs,
        })));
        if (my !== epoch) return;
        running = false; pending = null; lastQuery = plan;
        render();
      }

      // ---------- build (once per layout) ----------
      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        const G = compact ? PHONE : DESK;
        epoch++; running = false; pending = null; flash.clear();   // abandon an in-flight query

        const controls = {
          scheme: ui.segmented({
            label: "Partition by", value: S.scheme,
            options: [{ value: "time", label: "Time range" }, { value: "hash", label: "Hash of key" }, { value: "sensor", label: "Sensor, then time" }],
            onChange: val => { S.scheme = val; changed(); },
          }),
          clock: ui.slider({
            label: "Clock", min: 2, max: 23, step: 1, value: Math.floor(S.t / 60),
            format: val => pad(val) + ":00", onInput: val => changed(val * 60 + WINDOW - 1),
          }),
          ingest: ui.toggle({ label: "Ingest writes", value: S.ingest, onChange: val => { S.ingest = val; } }),
          hot: ui.toggle({ label: "S3 is 10x busier", value: S.hot, onChange: val => { S.hot = val; changed(); } }),
        };
        const q1 = ui.button("Query: S3, last 2 h", () => runQuery("q1"), { kind: "primary" });
        const q2 = ui.button(q2Label(S.t), () => runQuery("q2"));
        const reset = ui.button("Reset", resetAll, { kind: "ghost" });

        const svg = ctx.svg({ w: G.W, h: G.H, label: "Eight sensors writing into four partitions, and an app querying them" });
        const scene = s("g"), packets = s("g");
        svg.append(scene, packets);

        const caption = ctx.text(G.caption[0], G.caption[1], "", { size: G.fs, anchor: "start", fill: C("muted") });
        const route = ctx.text(G.route[0], G.route[1], "", { size: G.fs, anchor: G.route[2], mono: true, fill: C("muted") });
        scene.append(caption, route);

        // App -> partition links, drawn first so boxes and the App sit on top of them.
        const links = [0, 1, 2, 3].map(p => {
          const [x2, y2] = G.askAt(G.box(p));
          const ln = s("line", { x1: G.port[0], y1: G.port[1], x2, y2 });
          scene.appendChild(ln);
          return ln;
        });

        const boxes = [0, 1, 2, 3].map(p => buildBox(scene, G, p));
        const sensors = SENSORS.map(si => {
          const [x, y] = G.sensor(si - 1);
          const n = ctx.node({ x, y, r: G.sr, label: "S" + si, size: G.fs, fill: C("c6-soft"), stroke: C("c6") });
          scene.appendChild(n);
          return n;
        });
        const [s3x, s3y] = G.sensor(2);
        const badge = ctx.text(s3x + G.badge[0], s3y + G.badge[1], "10x", { size: G.fs, anchor: "start", weight: 700, fill: C("bad") });
        scene.appendChild(badge);
        scene.appendChild(ctx.node({ x: G.app[0], y: G.app[1], r: G.ar, label: "App", size: G.fs, fill: C("c6-soft"), stroke: C("c6") }));

        const stats = ui.stats([
          { key: "busy", label: "Busiest partition", value: "" },
          { key: "ideal", label: "Ideal", value: "25%", tone: "info" },
          { key: "asked", label: "Partitions asked", value: "–" },
          { key: "rows", label: "Rows read / returned", value: "–" },
        ]);
        const note = ui.note("");
        const legend = ui.legend([
          { color: C("c6"), label: "write / request", shape: "dot" },
          { color: C("ok"), label: "response (rows returned)", shape: "dot" },
          { color: C("c6"), label: "partitions the last query asked", shape: "line" },
          { color: C("bad"), label: "hot partition (> 50% of writes)", shape: "square" },
        ]);

        root.append(
          ui.bar(controls.scheme, controls.clock, controls.ingest),
          ui.bar(controls.hot, q1, q2, reset),
          svg, legend, stats, note,
        );
        view = { G, svg, packets, caption, route, links, boxes, sensors, badge, stats, note, q1, q2, controls,
          clockVal: controls.clock.querySelector(".viz-slider-val") };
        render(true);
      }

      function buildBox(scene, G, p) {
        const bx = G.box(p);
        const b = ctx.box({ x: bx.x, y: bx.y, w: bx.w, h: bx.h, rx: 10, fill: C("node"), stroke: C("node-stroke") });
        const t = (x, y, o) => { const el = ctx.text(x, y, "", o); b.appendChild(el); return el; };
        const muted = { size: G.fs, fill: C("muted") };
        let barX, barY, barH;
        if (!compact) {
          const cx = bx.x + bx.w / 2;
          b.title = t(cx, bx.y + 20, { size: G.title, weight: 700 });
          b.sub = t(cx, bx.y + 38, muted);
          [b.barW, barX, barY, barH] = [120, cx - 60, bx.y + 50, 12];
          b.share = t(cx, bx.y + 78, { size: G.fs, weight: 600 });
          b.rowsT = t(cx, bx.y + 96, muted);
          b.qT = t(cx, bx.y + 118, { size: G.fs, weight: 700 });
        } else {
          const x0 = bx.x + 10, x1 = bx.x + bx.w - 10;
          b.title = t(x0, bx.y + 17, { size: G.title, weight: 700, anchor: "start" });
          b.sub = t(x1, bx.y + 17, { ...muted, anchor: "end" });
          [b.barW, barX, barY, barH] = [100, x0, bx.y + 29, 10];
          b.share = t(x1, bx.y + 34, { size: G.fs, weight: 600, anchor: "end" });
          b.rowsT = t(x0, bx.y + 54, { ...muted, anchor: "start" });
          b.qT = t(x1, bx.y + 54, { size: G.fs, weight: 700, anchor: "end" });
        }
        b.title.textContent = `P${p} · node ${NODES[p]}`;
        b.appendChild(s("rect", { x: barX, y: barY, width: b.barW, height: barH, rx: 3, fill: C("line"), opacity: 0.35 }));
        b.bar = s("rect", { x: barX, y: barY, width: 0, height: barH, rx: 3, fill: C("ok") });
        b.appendChild(b.bar);
        b.w = 0;
        scene.appendChild(b);
        return b;
      }

      function setBar(b, w, instant) {
        const from = b.w, tok = (b.tok = (b.tok || 0) + 1);
        const apply = k => { if (b.tok === tok) { b.w = from + (w - from) * k; b.bar.setAttribute("width", b.w.toFixed(1)); } };
        if (instant) apply(1); else ctx.tween({ ms: 300, onUpdate: apply });
      }

      // ---------- render (cheap; runs every tick) ----------
      function render(instant) {
        const v = view;
        if (!v) return;
        const sh = shares(), q = pending || lastQuery;
        const toneOfShare = x => (x <= 0.35 ? "ok" : x <= 0.5 ? "warn" : "bad");
        v.boxes.forEach((b, p) => {
          const hotBox = sh[p] > 0.5, lit = flash.has(p);
          setBar(b, sh[p] * b.barW, instant);
          ctx.attr(b.bar, { fill: C(toneOfShare(sh[p])) });
          ctx.attr(b.rect, {
            fill: hotBox ? C("bad-soft") : C("node"),
            stroke: lit ? C("warn") : hotBox ? C("bad") : C("node-stroke"),
            "stroke-width": lit ? 2.5 : hotBox ? 2 : 1.5,
          });
          b.setAttribute("opacity", q && !q.contacted.includes(p) ? 0.45 : 1);
          b.sub.textContent = rangeLabel(S.scheme, p, compact);
          b.share.textContent = Math.round(sh[p] * 100) + "% of writes";
          b.rowsT.textContent = fmtN(S.rows[p]) + (compact ? " rows" : " rows today");
          const r = lastQuery && lastQuery.per[p];
          b.qT.textContent = r && r.asked ? `read ${r.full ? "all" : fmtN(r.read)} → ${fmtN(r.ret)}` : "";
          ctx.attr(b.qT, { fill: C(!r ? "ink" : r.full ? "bad" : r.read === r.ret ? "ok" : "warn") });
        });
        v.links.forEach((ln, p) => {
          const on = q && q.contacted.includes(p);
          ctx.attr(ln, { stroke: on ? C("c6") : C("line"), "stroke-width": on ? 2 : 1.2, "stroke-dasharray": on ? "none" : "3 4" });
        });
        const s3 = v.sensors[2].circle;
        ctx.attr(s3, { stroke: S.hot ? C("bad") : C("c6"), "stroke-width": S.hot ? 2.5 : 2 });
        v.badge.style.display = S.hot ? "" : "none";

        v.caption.textContent = `Today's sensor writes, now ${hhmm(S.t)}`;
        const p3 = partitionOf(S.scheme, 3, S.t, 0);
        const how = S.scheme === "time" ? "time " + hhmm(S.t)
          : S.scheme === "hash" ? "hash " + hash32(keyOf(3, S.t, 0)).toString(16).toUpperCase().padStart(8, "0").slice(0, 4) + "…"
          : "sensor S3";
        v.route.textContent = `key "${keyOf(3, S.t, 0)}" → ${how} → P${p3}`;
        if (v.controls.clock.get() !== Math.floor(S.t / 60)) v.controls.clock.set(Math.floor(S.t / 60));
        if (v.clockVal) v.clockVal.textContent = hhmm(S.t);
        const label = q2Label(S.t);
        if (v.q2.textContent !== label) v.q2.setLabel(label);
        v.q1.disable(running); v.q2.disable(running);

        const busiest = Math.max(...sh), pct = Math.round(busiest * 100);
        v.stats.set("busy", pct + "%", pct <= 37 ? "ok" : pct <= 50 ? "warn" : "bad");
        // The router knows which partitions to ask up front; the row counts arrive with the replies.
        const k = q ? q.contacted.length : 0;
        v.stats.set("asked", q ? `${k} of ${NP}` : "–", !q ? "" : k === 1 ? "ok" : k === NP ? "bad" : "warn");
        if (lastQuery) {
          v.stats.set("rows", `${fmtN(lastQuery.read)} / ${fmtN(lastQuery.ret)}`,
            lastQuery.full ? "bad" : lastQuery.read === lastQuery.ret ? "ok" : "warn");
        } else v.stats.set("rows", pending ? "…" : "–", "");
        v.note.set(...(lastQuery ? queryNote(lastQuery) : pending ? pendingNote(pending) : loadNote(sh)));
      }

      const names = ps => ps.map(p => "P" + p).join(", ").replace(/, (P\d)$/, " and $1");
      const spanOf = q => `${hhmm(q.a)}–${hhmm(q.b + 1)}`;

      function pendingNote(q) {
        const what = q.which === "q1" ? `S3's readings from ${spanOf(q)}` : `every sensor's readings from ${spanOf(q)}`;
        return [`Asking ${names(q.contacted)} for ${what}…`, "info"];
      }

      function loadNote(sh) {
        if (S.scheme === "time") {
          const p = Math.floor(S.t / 360), H = pad(Math.floor(S.t / 60));
          return [`Every sensor writes the current time, so every key for today's <b>${H}:xx</b> falls in <b>P${p}</b>'s range ` +
            `of today's timestamps (${rangeLabel("time", p)}): one partition takes every new write while three sit idle. ` +
            "Drag the clock: the hot spot just moves with it. With real timestamps it only ever moves forward: " +
            "the newest range is always the hot one.", "bad"];
        }
        if (S.scheme === "hash") {
          return S.hot
            ? ["Even a 10x busier sensor spreads out, because each of its readings has a distinct key that hashes " +
               "independently. Hashing could not split one single hot key, though: identical keys hash identically.", "ok"]
            : ["Hashing (sensor, time) scatters consecutive keys pseudo-randomly, so each partition gets roughly a " +
               "quarter of the writes. Now run a query.", "ok"];
        }
        return S.hot
          ? [`S3 is 10x busier, so <b>P1</b> (S3–S4) takes <b>${Math.round(sh[1] * 100)}%</b> of writes: a key prefix ` +
             "spreads load only as well as the prefix values are balanced. Hashing the full key would still spread it.", "bad"]
          : ["Each partition owns two sensors and keeps each sensor's readings sorted by time; writes split 25% each " +
             "because all sensors are equally busy. Now run a query.", "ok"];
      }

      function queryNote(q) {
        const read = fmtN(q.read), ret = fmtN(q.ret), span = spanOf(q);
        if (q.scheme === "hash") {
          const what = q.which === "q1" ? "S3's last 2 hours" : `the readings from ${span}`;
          return [`Hashing destroyed key order: ${what} are spread over every partition, so the query is a scatter-gather ` +
            "to all 4 and waits for the slowest (tail latency, Chapter 1). With no key order to seek on, each partition " +
            `scans everything it holds: <b>${read}</b> rows read to return <b>${ret}</b>.`, "bad"];
        }
        if (q.which === "q1") {
          return q.scheme === "time"
            ? [`In time order the last 2 hours are one contiguous range (${names(q.contacted)}), but all 8 sensors are ` +
               `interleaved in it: <b>${read}</b> rows read to return S3's <b>${ret}</b>.`, "warn"]
            : ["S3's readings sit next to each other, sorted by time, in one partition: one contiguous scan. This is the " +
               "book's fix: sensor first, then time. Cassandra gets the same shape by hashing the partition key (sensor) " +
               "and sorting rows by a clustering column (time).", "ok"];
        }
        return q.scheme === "time"
          ? [`Time-range partitioning shines here: ${span} is one contiguous slice of ${names(q.contacted)}, ` +
             `so <b>${read}</b> rows read, <b>${ret}</b> returned.`, "ok"]
          : ["The price of sensor-first keys: each sensor lives in its own place, so a cross-sensor time query needs " +
             "<b>8 range scans</b> across all partitions. Pick the key for your most important query.", "warn"];
      }

      setClock(14);
      build();
      ctx.every(900, tick);
      // Rebuild with the other layout when the frame crosses the phone breakpoint.
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
