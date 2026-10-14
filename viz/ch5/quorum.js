// Leaderless quorums (DDIA ch5): writes and reads go to all n home replicas and the client waits
// for w acks / r replies. If w + r > n the two sets must share a replica, so reads see the latest
// acknowledged write. Shrinking w or r, killing replicas, reading during a write, or sloppy
// quorums (stand-ins outside the home set acknowledge writes) break that guarantee.
(function () {
  "use strict";

  const idNum = id => +id.slice(1);
  const byId = (a, b) => idNum(a.id) - idNum(b.id);
  const isFallback = id => id[0] === "X";
  const names = ids => ids.length < 2 ? (ids[0] || "") : ids.slice(0, -1).join(", ") + " and " + ids[ids.length - 1];
  const verb = (ids, one, many) => (ids.length === 1 ? one : many);

  // ---------------- Pure model (no DOM) ----------------
  function shuffle(arr, rnd) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }
  /** The r replicas whose replies the reader uses, or null when fewer than r are reachable.
   *  "worst": the r reachable replicas holding the OLDEST versions answer first (ties by id). */
  function pickResponders(reachable, r, mode, rnd) {
    if (reachable.length < r) return null;
    if (mode === "worst") return reachable.slice().sort((a, b) => a.v - b.v || byId(a, b)).slice(0, r);
    return shuffle(reachable.slice(), rnd).slice(0, r);
  }
  /** Down home replica id -> stand-in fallback: the one already standing in for it, else a free one. */
  function assignFallbacks(downIds, fallbacks) {
    const map = {}, taken = new Set();
    downIds.forEach(id => { const f = fallbacks.find(f => f.standIn === id); if (f) { map[id] = f; taken.add(f); } });
    downIds.forEach(id => {
      const f = !map[id] && fallbacks.find(f => !f.standIn && !taken.has(f));
      if (f) { map[id] = f; taken.add(f); }
    });
    return map;
  }
  /** Recipients of a write: up home replicas plus (sloppy) stand-ins. The first w in seeded order are fast. */
  function planWrite(S, rnd) {
    const downs = S.replicas.filter(x => !x.up).map(x => x.id);
    const map = S.sloppy ? assignFallbacks(downs, S.fallbacks) : {};
    const recips = S.replicas.filter(x => x.up).map(x => ({ id: x.id }))
      .concat(Object.keys(map).map(d => ({ id: map[d].id, forId: d })));
    shuffle(recips, rnd).forEach((rc, i) => { rc.fast = i < S.w; });
    return { recips, downs, lost: downs.filter(id => !map[id]) };
  }
  /** Judge a read against the newest write acknowledged when the read started. */
  function classifyRead(result, ackedAtStart, status) {
    if (result < ackedAtStart) return "stale";
    if (result === ackedAtStart || status === "acked") return "fresh";
    return status === "failed" ? "failedWrite" : "inProgress";
  }
  function replicaStatus(rp, S) {
    if (!rp.up) return "down";
    if (rp.v < S.latestAcked) return "stale";
    if (rp.v === S.latestAcked) return "fresh";
    return S.writes[rp.v].status === "failed" ? "unacked" : "pending";
  }
  /** Anti-entropy: every up replica gets the newest version on any up replica or deliverable hint. */
  function antiEntropyPlan(S) {
    const ups = S.replicas.filter(x => x.up);
    const hints = S.fallbacks.filter(f => f.hint && ups.some(x => x.id === f.standIn));
    const best = Math.max(0, ...ups.map(x => x.v), ...hints.map(f => f.hint.v));
    return { best, hints };
  }
  function initialState() {
    return {
      n: 3, w: 2, r: 2, sloppy: false, repair: true, mode: "worst",
      replicas: [{ id: "R1", up: true, v: 2 }, { id: "R2", up: true, v: 2 }, { id: "R3", up: true, v: 1 }],
      fallbacks: ["X1", "X2"].map(id => ({ id, standIn: null, hint: null, inflight: 0 })),
      ver: 2, latestAcked: 2,
      writes: { 1: { status: "acked", ackers: ["R1", "R2", "R3"], need: 2 }, 2: { status: "acked", ackers: ["R1", "R2"], need: 2 } },
      readIds: [], lastRead: null, logs: [["v2 acknowledged by R1, R2 (w = 2); R3 was briefly down and missed it", "ok"]],
      wCard: ["v2 ✓ acked", "by R1, R2", "ok"],
      rCard: ["no read yet", "press Read", ""],
      note: ["<b>v2</b> was acknowledged by R1 and R2 (w = 2); R3 still has v1. With <b>w + r = 4 &gt; 3</b>, " +
        "any 2 replicas you read include at least one with v2. Press <b>Read</b>.", "info"],
    };
  }

  function geometry(compact, n) {
    const g = compact
      ? { W: 360, H: 312, cx: 180, cy: 175, R: 92, nr: 21, cr: 17, F: 11, F2: 12,
          writer: [30, 24], reader: [330, 24], fb: [[36, 270], [324, 270]], wCard: [4, 46, 146, 38], rCard: [210, 46, 146, 38] }
      : { W: 640, H: 300, cx: 340, cy: 150, R: 105, nr: 24, cr: 20, F: 12, F2: 13,
          writer: [52, 52], reader: [52, 176], fb: [[592, 95], [592, 205]], wCard: [6, 82, 144, 40], rCard: [6, 206, 144, 40] };
    g.angle = i => -Math.PI / 2 + (2 * Math.PI * i) / n;
    g.at = (i, d) => [g.cx + d * Math.cos(g.angle(i)), g.cy + d * Math.sin(g.angle(i))];
    return g;
  }

  Viz.register("ch5/quorum", {
    title: "Quorums, read repair and sloppy quorums",
    model: { pickResponders, assignFallbacks, planWrite, classifyRead, replicaStatus, antiEntropyPlan, initialState },
    mount(root, ctx) {
      const { s, ui } = ctx;
      const V = c => `var(--viz-${c})`;
      const rnd = ctx.random(5);
      const S = initialState();
      const HANDOFF_MS = 3000; // a revived replica gets its hints after this delay
      let G, view, compact, readSeq = 0, sweeping = false;

      const rep = id => S.replicas.find(x => x.id === id);
      const fb = id => S.fallbacks.find(f => f.id === id);
      const ackLabel = ids => (ids.length > 3 ? `${ids.length} nodes`
        : [ids.filter(id => !isFallback(id)), ids.filter(isFallback)].map(l => l.join(", ")).filter(Boolean).join(" + "));

      function say(html, tone) { S.note = [html, tone]; view.note.set(html, tone); }
      function logAdd(html, tone) { if (S.logs.push([html, tone]) > 40) S.logs.shift(); view.log.add(html, tone); }

      // ---------------- Layout ----------------
      function build() {
        root.innerHTML = "";
        compact = ctx.compact;
        G = geometry(compact, S.n);
        const nS = ui.slider({ label: "n (replicas)", min: 3, max: 7, value: S.n, onInput: setN });
        const wS = ui.slider({ label: "w", min: 1, max: S.n, value: S.w, onInput: v => { S.w = v; configChanged(); } });
        const rS = ui.slider({ label: "r", min: 1, max: S.n, value: S.r, onInput: v => { S.r = v; configChanged(); } });
        const aeB = ui.button("Run anti-entropy", antiEntropy).disable(sweeping);
        const options = ui.bar(
          ui.toggle({ label: "Read repair", value: S.repair, onChange: setRepair }),
          ui.toggle({ label: "Sloppy quorum", value: S.sloppy, onChange: setSloppy }),
          ui.segmented({ label: "Read hears from", value: S.mode, onChange: setMode,
            options: [{ value: "random", label: "Random r" }, { value: "worst", label: "Worst case" }] }));
        const actions = ui.bar(ui.button("Write", doWrite, { kind: "primary" }), ui.button("Read", doRead), aeB);
        const svg = ctx.attr(ctx.svg({ w: G.W, h: G.H, label: "Replicas on a ring with writer and reader clients" }), { role: "group" });
        // Clients and their result cards sit above the packets so in-flight labels never cover them.
        const under = s("g"), scene = s("g"), packets = s("g"), top = s("g");
        svg.append(under, scene, packets, top);
        const hint = ctx.h("div", {
          style: "font-size:12.5px;line-height:1.5;color:var(--text-muted);margin-top:6px",
          html: "Tap a replica to take it down or bring it back. <b>W</b>: acknowledged the latest successful write. " +
            "<b>R</b>: answered the last read. Green tags: in both sets, the overlap.",
        });
        const stats = ui.stats([
          { key: "ov", label: "w + r vs n" }, { key: "wt", label: "Writes tolerate" }, { key: "rt", label: "Reads tolerate" },
          { key: "lr", label: "Last read" }, { key: "st", label: "Stale replicas" },
        ]);
        const legend = ui.legend([
          { color: V("c6"), label: "client" }, { color: V("ok"), label: "up to date" }, { color: V("bad"), label: "stale" },
          { color: V("warn"), label: "unacknowledged / slow copy" }, { color: V("muted"), label: "down" },
          { color: V("c5"), label: "fallback node + hint" },
        ]);
        const log = ui.log({ title: "What happened", height: 120 });
        S.logs.forEach(([h, t]) => log.add(h, t));
        const note = ui.note(S.note[0], S.note[1]);
        root.append(ui.bar(nS, wS, rS), options, actions, svg, hint, legend, stats, note, log);
        view = { under, scene, packets, top, note, stats, log, wS, rS, aeB };
        draw();
      }

      const posOf = id => (id === "W" ? G.writer : id === "R" ? G.reader : isFallback(id) ? G.fb[idNum(id) - 1]
        : rep(id) ? G.at(S.replicas.indexOf(rep(id)), G.R) : null);
      function fly(from, to, o) {
        const a = posOf(from), b = posOf(to);
        if (!a || !b) return Promise.resolve(false);
        return ctx.fly(view.packets, Object.assign({ from: a, to: b, labelSize: G.F, r: o.label ? 7 : 5 }, o));
      }

      // ---------------- Drawing ----------------
      function draw() {
        const { scene, top } = view;
        const focused = scene.contains(document.activeElement) && document.activeElement.dataset.id;
        scene.innerHTML = top.innerHTML = "";
        const sets = { W: new Set((S.writes[S.latestAcked] || {}).ackers || []), R: new Set(S.readIds) };
        scene.append(s("circle", { cx: G.cx, cy: G.cy, r: G.R, fill: "none", stroke: V("line"), "stroke-width": 1.2, "stroke-dasharray": "2 5" }));
        drawCenter(scene);
        if (S.sloppy || S.fallbacks.some(f => f.standIn)) S.fallbacks.forEach((f, i) => drawFallback(scene, f, i, sets));
        S.replicas.forEach((rp, i) => drawReplica(scene, rp, i, sets));
        drawClient(top, "W", G.writer, "writer", G.wCard, S.wCard);
        drawClient(top, "R", G.reader, "reader", G.rCard, S.rCard);
        if (focused) { const el = scene.querySelector(`[data-id="${focused}"]`); if (el) el.focus(); }
        updateStats();
      }

      // The quorum condition in the middle of the ring (or the anti-entropy sweep label).
      function drawCenter(g) {
        const { cx, cy, F, F2 } = G, over = S.w + S.r > S.n, c = V(over ? "ok" : "bad");
        const lines = sweeping ? [[-9, "comparing", F, V("c2")], [8, "Merkle trees…", F, V("c2")]]
          : [[-17, `w + r = ${S.w + S.r}`, F2 + 1, c], [0, `${over ? ">" : "≤"} n = ${S.n}`, F2 + 1, c],
            [18, over ? "overlap ✓" : "no overlap", F, over ? V("muted") : c]];
        lines.forEach(([dy, str, size, fill], k) => g.append(ctx.text(cx, cy + dy, str, { size, fill, weight: k < 2 && !sweeping ? 800 : 700 })));
      }

      // Small "W"/"R" pills: who acknowledged the latest write, who answered the last read.
      function tags(g, [x, y], id, sets) {
        const list = ["W", "R"].filter(k => sets[k].has(id));
        const tw = G.F + 8, th = G.F + 4, c = list.length === 2 ? "ok" : "c6";
        list.forEach((t, k) => {
          const tx = x + (k - (list.length - 1) / 2) * (tw + 3);
          g.append(s("rect", { x: tx - tw / 2, y: y - th / 2, width: tw, height: th, rx: 4, fill: V("panel"), stroke: V(c), "stroke-width": 1.3 }),
            ctx.text(tx, y + 0.5, t, { size: G.F, weight: 800, fill: V(c) }));
        });
      }

      function drawReplica(g, rp, i, sets) {
        const [x, y] = G.at(i, G.R), st = replicaStatus(rp, S);
        const col = { down: "muted", stale: "bad", fresh: "ok", unacked: "warn", pending: "warn" }[st];
        const el = s("g", { tabindex: 0, role: "button", style: "cursor:pointer", dataset: { id: rp.id },
          "aria-label": `${rp.id}: ${rp.up ? "up" : "down"}, holds v${rp.v}. Press to take it ${rp.up ? "down" : "up"}.` });
        el.append(s("circle", { cx: x, cy: y, r: G.nr + 6, fill: "transparent" }));
        const nd = ctx.node({ x, y, r: G.nr, fill: V(rp.up ? "c2-soft" : "node"), stroke: V(col), strokeWidth: rp.up ? 2.5 : 1.6 });
        if (!rp.up) ctx.attr(nd.circle, { "stroke-dasharray": "4 3" });
        el.append(nd,
          ctx.text(x, y - 7, rp.id, { size: G.F2, weight: 700, fill: V(rp.up ? "ink" : "muted") }),
          ctx.text(x, y + 8, "v" + rp.v, { size: G.F, weight: 700, mono: true, fill: V(st === "fresh" ? "ink" : col) }));
        const label = { down: "✕ down", stale: "stale", unacked: "unacked", pending: "pending" }[st];
        if (label) {
          // Beside side nodes (anchored away from the node), above/below top and bottom ones.
          const c = Math.cos(G.angle(i)), side = Math.abs(c) > 0.35, d = G.nr + (side ? 6 : 13);
          el.append(ctx.text(x + c * d, y + Math.sin(G.angle(i)) * d, label,
            { size: G.F, weight: 700, fill: V(col), halo: true, anchor: side ? (c > 0 ? "start" : "end") : "middle" }));
        }
        tags(el, G.at(i, G.R - G.nr - 13), rp.id, sets);
        el.addEventListener("click", () => toggleReplica(rp.id));
        el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleReplica(rp.id); } });
        g.append(el);
      }

      function drawFallback(g, f, i, sets) {
        const [x, y] = G.fb[i], r = G.nr - 2;
        const nd = ctx.node({ x, y, r, fill: V("c5-soft"), stroke: V("c5") });
        ctx.attr(nd.circle, { "stroke-dasharray": "4 3" });
        g.append(nd, ctx.text(x, y - 7, f.id, { size: G.F2, weight: 700 }),
          ctx.text(x, y + 8, f.hint ? "v" + f.hint.v : "–", { size: G.F, weight: 700, mono: true, fill: V(f.hint ? "c5" : "muted") }),
          ctx.text(x, y + r + 13, f.hint ? "for " + f.standIn : "fallback", { size: G.F, weight: f.hint ? 700 : 400, fill: V(f.hint ? "c5" : "muted") }));
        tags(g, [x + (x < G.cx ? 1 : -1) * (r + 15), y], f.id, sets);
      }

      function drawClient(g, label, [x, y], role, [bx, by, bw, bh], [l1, l2, tone]) {
        g.append(ctx.node({ x, y, r: G.cr, label, fill: V("c6-soft"), stroke: V("c6") }));
        const side = label === "W" ? 1 : -1;
        g.append(compact
          ? ctx.text(x + side * (G.cr + 5), y, role, { size: G.F, fill: V("muted"), anchor: side > 0 ? "start" : "end" })
          : ctx.text(x, y - G.cr - 10, role, { size: G.F, fill: V("muted") }));
        const c = tone ? V(tone) : V("line");
        // Opaque backing first: the soft tone fills are translucent and packets fly underneath.
        g.append(s("rect", { x: bx, y: by, width: bw, height: bh, rx: 8, fill: V("bg") }),
          s("rect", { x: bx, y: by, width: bw, height: bh, rx: 8, fill: tone ? V(tone + "-soft") : V("panel"), stroke: c, "stroke-width": 1.4 }),
          ctx.text(bx + bw / 2, by + bh / 2 - 8, l1, { size: G.F2, weight: 700, fill: tone ? c : V("ink") }),
          ctx.text(bx + bw / 2, by + bh / 2 + 9, l2, { size: G.F, fill: tone ? c : V("muted") }));
      }

      function updateStats() {
        const st = view.stats, sum = S.w + S.r, over = sum > S.n;
        const down = S.replicas.filter(x => !x.up).length;
        st.set("ov", `${sum} ${over ? ">" : "≤"} ${S.n}`, over ? "ok" : "bad");
        st.set("wt", `${S.n - S.w} down`, S.w === S.n ? "bad" : down > S.n - S.w ? (S.sloppy ? "warn" : "bad") : "ok");
        st.set("rt", `${S.n - S.r} down`, S.r === S.n || down > S.n - S.r ? "bad" : "ok");
        st.set("lr", S.lastRead ? S.lastRead[0] : "—", S.lastRead ? S.lastRead[1] : "");
        const stale = S.replicas.filter(x => x.up && x.v < S.latestAcked).length;
        st.set("st", String(stale), stale ? "warn" : "ok");
      }

      // ---------------- Writes ----------------
      async function doWrite() {
        const v = ++S.ver, plan = planWrite(S, rnd);
        const wr = S.writes[v] = { status: "pending", ackers: [], need: S.w, downs: plan.downs, recips: plan.recips };
        plan.recips.forEach(rc => { if (rc.forId) { const f = fb(rc.id); f.standIn = rc.forId; f.inflight++; } });
        S.wCard = [`writing v${v}…`, `0 of ${S.w} acks`, "warn"];
        draw();
        const lost = plan.lost.map(id => fly("W", id, { fill: V("c6"), label: "v" + v, ms: 600, lost: 0.4 }));
        await Promise.all(lost.concat(plan.recips.map(rc => deliver(v, wr, rc))));
        if (ctx.alive && wr.status === "pending") writeFailed(v, wr);
      }

      async function deliver(v, wr, rc) {
        const f = rc.forId && fb(rc.id);
        const color = !rc.fast ? "warn" : f ? "c5" : "c6";
        await fly("W", rc.id, { fill: V(color), label: "v" + v, ms: rc.fast ? 600 : 4000, ease: rc.fast ? "inOut" : "linear" });
        if (!ctx.alive) return;
        if (f) {
          f.inflight--;
          if (f.standIn !== rc.forId) return; // its home replica was removed meanwhile
          if (!f.hint || f.hint.v < v) f.hint = { v };
          if ((rep(rc.forId) || {}).up) ctx.after(HANDOFF_MS, () => handoff(f));
        } else {
          const rp = rep(rc.id);
          if (!rp || !rp.up) return; // went down while the copy was in flight: no ack
          rp.v = Math.max(rp.v, v);
        }
        draw();
        await fly(rc.id, "W", { fill: V("ok"), ms: 450 });
        if (!ctx.alive || wr.status !== "pending") return;
        wr.ackers.push(rc.id);
        if (wr.ackers.length >= wr.need) writeAcked(v, wr);
        else if (v === S.ver) { S.wCard = [`writing v${v}…`, `${wr.ackers.length} of ${wr.need} acks`, "warn"]; draw(); }
      }

      function writeAcked(v, wr) {
        wr.status = "acked";
        if (v > S.latestAcked) { S.latestAcked = v; S.readIds = []; }
        const fbs = wr.ackers.filter(isFallback), homes = wr.ackers.filter(id => !isFallback(id));
        const forOf = id => wr.recips.find(rc => rc.id === id).forId, hintOf = id => `${id} (hint for ${forOf(id)})`;
        logAdd(fbs.length ? `v${v} acknowledged by ${[...homes, ...fbs.map(hintOf)].join(" + ")}: sloppy quorum`
          : `v${v} acknowledged by ${homes.join(", ")} (w = ${wr.need})`, fbs.length ? "warn" : "ok");
        if (v !== S.ver) return draw();
        S.wCard = [`v${v} ✓ acked${fbs.length ? " (sloppy)" : ""}`, "by " + ackLabel(wr.ackers), fbs.length ? "warn" : "ok"];
        if (fbs.length) {
          say(`Home replica${wr.downs.length > 1 ? "s" : ""} ${names(wr.downs)} ${verb(wr.downs, "is", "are")} unreachable, so ` +
            `${names(fbs.map(hintOf))} accepted v${v} and counted toward w = ${wr.need}. ` +
            `The write succeeded, but reads of R1–R${S.n} can't see ${fbs.length > 1 ? "those copies" : "that copy"} until the hint is handed off.`, "warn");
        } else {
          const slow = wr.recips.filter(rc => !rc.fast && !rc.forId).map(rc => rc.id).sort((a, b) => idNum(a) - idNum(b));
          const stand = wr.recips.filter(rc => rc.forId); // sloppy stand-ins still carrying a slow copy
          const missed = wr.downs.filter(d => !stand.some(rc => rc.forId === d));
          say(`<b>v${v}</b> was acknowledged by ${names(homes)} (w = ${wr.need}), so the client reports success.` +
            (missed.length ? ` ${names(missed)} ${verb(missed, "is", "are")} down and missed it, and will come back stale.`
              : slow.length ? ` ${names(slow)} ${verb(slow, "is", "are")} still receiving it (the slow amber copies).` : "") +
            (stand.length ? ` ${names(stand.map(rc => rc.id))} will hold a copy for ${names(stand.map(rc => rc.forId))} as a hint.` : ""), "ok");
        }
        draw();
      }

      function writeFailed(v, wr) {
        wr.status = "failed";
        const kept = wr.ackers;
        logAdd(`write v${v} FAILED (${kept.length} of ${wr.need} acks)` + (kept.length ? `; ${kept.join(", ")} kept it` : ""), "bad");
        if (v !== S.ver) return draw();
        S.wCard = [`v${v} ✗ failed`, `${kept.length} of ${wr.need} acks`, "bad"];
        say((kept.length
          ? `Only ${kept.length} of the required ${wr.need} replicas acknowledged, so the client got an error. But ${names(kept)} kept v${v}: ` +
            "failed writes are not rolled back, and a later read may still return it."
          : `No replica was reachable, so write v${v} failed and nothing stored it.`) +
          (wr.need === S.n ? " With w = n every replica must acknowledge, so one down node makes every write fail." : ""), "bad");
        draw();
      }

      // ---------------- Reads ----------------
      async function doRead() {
        const id = ++readSeq, r = S.r, acked0 = S.latestAcked, mode = S.mode;
        const inFlight = S.ver > acked0 && S.writes[S.ver].status === "pending" ? S.ver : 0;
        const sentUp = new Set(S.replicas.filter(x => x.up).map(x => x.id));
        S.rCard = ["reading…", `waiting for ${r} repl${r === 1 ? "y" : "ies"}`, "warn"];
        draw();
        await Promise.all(S.replicas.map(x => fly("R", x.id, { fill: V("c6"), ms: 400, lost: sentUp.has(x.id) ? undefined : 0.4 })));
        if (!ctx.alive) return;
        const reach = S.replicas.filter(x => x.up && sentUp.has(x.id));
        const resp = pickResponders(reach, r, mode, rnd);
        const answers = (resp || reach).map(x => ({ id: x.id, v: x.v }));
        const result = Math.max(0, ...answers.map(a => a.v));
        const statusWhenServed = (S.writes[result] || {}).status;
        await Promise.all(answers.map(a => fly(a.id, "R", { fill: V(a.v >= acked0 ? "ok" : "bad"), label: "v" + a.v, ms: 500 })));
        if (!ctx.alive) return;
        const latest = id === readSeq;
        if (!resp) {
          logAdd(`read failed: ${reach.length} of ${r} replicas reachable`, "bad");
          if (!latest) return;
          Object.assign(S, { rCard: ["read failed", `${reach.length} of ${r} reachable`, "bad"], lastRead: ["failed", "bad"], readIds: [] });
          say(`Only ${reach.length} of the ${r} replicas this read needs answered, so the client gets an error. ` +
            (r === S.n ? "With r = n, a single down node makes every read fail." : `Reads tolerate n − r = ${S.n - r} down node${S.n - r === 1 ? "" : "s"}.`), "bad");
          return draw();
        }
        // A write still pending when the replica served it counts as "in progress", even if it is acked by now.
        const kind = classifyRead(result, acked0, S.writes[result].status === "failed" ? "failed" : statusWhenServed);
        checkInvariant(acked0, answers, result);
        const [card2, stat, tone] = {
          fresh: ["fresh", `fresh v${result}`, "ok"], stale: [`stale (latest v${acked0})`, `stale v${result}`, "bad"],
          failedWrite: ["from a FAILED write!", `v${result} unacked`, "warn"], inProgress: ["write still in progress", `v${result} in flight`, "info"],
        }[kind];
        logAdd(`read heard ${answers.map(a => `${a.id}=v${a.v}`).join(", ")} → ${stat}`, tone === "info" ? "" : tone);
        if (!latest) return;
        const mark = { ok: " ✓", bad: " ✗", warn: " ⚠", info: "" }[tone];
        Object.assign(S, { readIds: answers.map(a => a.id), lastRead: [stat, tone], rCard: [`read → v${result}${mark}`, card2, tone] });
        const base = readNote(kind, result, acked0, answers, r, inFlight);
        say(base, tone);
        draw();
        if (S.repair) readRepair(id, result, answers, base, tone);
      }

      // Dev-time assertion of the quorum property: if the home replicas that acknowledged the
      // latest write plus the read's responders outnumber n, they overlap, so the read is fresh.
      function checkInvariant(acked0, answers, result) {
        const home = S.writes[acked0].ackers.filter(id => !isFallback(id) && rep(id));
        if (home.length + answers.length > S.n && result < acked0) console.error(`[ch5/quorum] quorum invariant violated: v${acked0}`);
      }

      function readNote(kind, result, acked0, answers, r, inFlight) {
        const wr = S.writes[acked0], ackers = wr.ackers, heard = answers.map(a => a.id);
        const home = ackers.filter(id => !isFallback(id) && rep(id)), fbs = ackers.filter(isFallback);
        const both = heard.filter(id => home.includes(id));
        const holders = answers.filter(a => a.v === result).map(a => a.id);
        const sum = wr.need + r, cmp = `w + r = ${sum} ${sum > S.n ? ">" : "≤"} ${S.n}`;
        const tail = inFlight && result < inFlight ? ` Write v${inFlight} was still in flight when the read started, so not seeing it is allowed.` : "";
        if (kind === "fresh") {
          if (result > acked0) return `Fresh: v${result} was acknowledged while this read was in flight. A read concurrent with a write may return the old or the new value.`;
          if (home.length + r > S.n) { // pigeonhole: the two sets must share a replica
            return `<b>${cmp}</b>: the ${r} replica${r > 1 ? "s" : ""} that answered must include one of the ${home.length} that acknowledged v${acked0}. ` +
              `Here ${names(both)} ${verb(both, "was", "were")} in both sets, so the read sees it.` + tail;
          }
          const why = S.replicas.every(x => !x.up || x.v >= acked0) ? "every replica has caught up by now"
            : both.length ? `${names(both)} acknowledged it and happened to answer` : `${names(holders)} received it after the write was acknowledged`;
          return `Fresh, but not guaranteed: ${why}. ` + (fbs.length ? "Some of its acknowledgements came from fallback nodes, which reads never ask."
            : `With <b>${cmp}</b> nothing forces the overlap${S.mode === "random" ? "; try Worst case" : ""}.`) + tail;
        }
        if (kind === "stale") {
          if (fbs.length && sum > S.n) {
            return `<b>w + r &gt; n, yet stale</b>: v${acked0} was acknowledged by fallback node${fbs.length > 1 ? "s" : ""} ${names(fbs)}, not ${fbs.length > 1 ? "home replicas" : "a home replica"}, ` +
              "and the read only asks home replicas. Hinted handoff has not happened yet. A sloppy quorum is not a quorum.";
          }
          if (sum <= S.n) {
            return `<b>${cmp}</b>: the write was acknowledged by ${names(ackers)}${ackers.length === 1 ? " alone" : ""}, and this read heard only from ${names(heard)}. ` +
              "Nothing forces the two sets to overlap, so you read stale data.";
          }
          return `Stale: v${acked0} was acknowledged by ${names(home)}, and this read heard from ${names(heard)}. ` +
            "The settings changed after that write, so its acknowledgements no longer overlap every read.";
        }
        if (kind === "failedWrite") {
          return `${names(holders)} still ${verb(holders, "has", "have")} v${result} from a write that returned an error to the client. ` +
            "Failed writes are not rolled back, so a read can return a value the writer was told did not succeed.";
        }
        return `${names(holders)} already ${verb(holders, "has", "have")} v${result}, but that write hasn't collected w acknowledgements yet. ` +
          "A read concurrent with a write may or may not see it; both answers are allowed.";
      }

      async function readRepair(id, result, answers, base, tone) {
        const old = answers.filter(a => a.v < result);
        if (!old.length) return;
        await Promise.all(old.map(a => fly("R", a.id, { fill: V("ok"), label: "repair v" + result, ms: 500 })));
        if (!ctx.alive) return;
        const fixed = old.filter(a => { const x = rep(a.id); return x && x.up && x.v < result && (x.v = result); });
        if (!fixed.length) return;
        logAdd(`read repair: ${fixed.map(a => `${a.id} v${a.v} → v${result}`).join(", ")}`, "ok");
        if (id === readSeq) {
          const others = S.replicas.filter(x => x.up && x.v < result && !answers.some(a => a.id === x.id)).map(x => x.id);
          say(base + ` Read repair then pushed v${result} to ${names(fixed.map(a => a.id))}, which answered with ${names(fixed.map(a => "v" + a.v))}.` +
            (others.length ? ` ${names(others)} didn't answer and ${verb(others, "is", "are")} still behind; anti-entropy fixes that.` : ""), tone);
        }
        draw();
      }

      // ---------------- Background repair ----------------
      async function handoff(f) {
        const h = f.hint, target = f.standIn;
        if (!h || h.sending || !(rep(target) || {}).up) return;
        h.sending = true;
        await fly(f.id, target, { fill: V("c5"), label: "handoff v" + h.v, ms: 700 });
        h.sending = false;
        const t = rep(target), was = t && t.v;
        if (!ctx.alive || !t || !t.up || f.standIn !== target) return; // down again: keep the hint for next time
        t.v = Math.max(t.v, h.v);
        if (f.hint === h) { f.hint = null; if (!f.inflight) f.standIn = null; } else ctx.after(300, () => handoff(f));
        logAdd(`hinted handoff: ${f.id} → ${target} v${h.v}`, "ok");
        say(was < h.v ? `${f.id} handed v${h.v} back to ${target} (hinted handoff). Until now, reads of R1–R${S.n} could not see v${h.v} on ${target}.`
          : `${f.id} handed v${h.v} to ${target}, which already had it, and dropped its hint.`, "ok");
        draw();
      }

      async function antiEntropy() {
        if (sweeping) return;
        view.aeB.disable(sweeping = true);
        draw();
        const { cx, cy, R } = G, arc = s("path", { d: `M${cx},${cy - R} A${R},${R} 0 0 1 ${cx + R * Math.sin(1.3)},${cy - R * Math.cos(1.3)}`,
          fill: "none", stroke: V("c2"), "stroke-width": 3, "stroke-dasharray": "6 5", "stroke-linecap": "round" });
        view.under.append(arc);
        await ctx.tween({ ms: 1200, ease: "inOut", onUpdate: k => arc.setAttribute("transform", `rotate(${k * 360} ${cx} ${cy})`) });
        arc.remove();
        if (!ctx.alive) return;
        view.aeB.disable(sweeping = false);
        const { best, hints } = antiEntropyPlan(S);
        hints.forEach(f => { f.hint = null; if (!f.inflight) f.standIn = null; });
        const changes = S.replicas.filter(x => x.up && x.v < best).map(x => { const from = x.v; x.v = best; return [x.id, from]; });
        const downs = S.replicas.filter(x => !x.up).map(x => x.id);
        const later = downs.length ? ` ${names(downs)} ${verb(downs, "is", "are")} down and will be compared on a later run.` : "";
        if (changes.length) {
          logAdd("anti-entropy: " + changes.map(([id, from]) => `${id} v${from} → v${best}`).join(", "), "ok");
          say(`Anti-entropy compared Merkle trees and copied v${best} to ${names(changes.map(c => c[0]))}. Unlike read repair it also fixes ` +
            "data nobody reads, but it runs in the background, in no particular order and possibly much later." + later, "ok");
        } else {
          logAdd("anti-entropy: no differences", "muted");
          say(`Anti-entropy found no differences: every up replica already has v${best}.` + later, "info");
        }
        draw();
      }

      // ---------------- Controls ----------------
      function toggleReplica(id) {
        const rp = rep(id);
        if (!rp) return;
        rp.up = !rp.up;
        logAdd(rp.up ? `${id} back up with v${rp.v}` : `${id} went down`, rp.up ? "" : "warn");
        const ups = S.replicas.filter(x => x.up).length;
        if (rp.up) {
          const f = S.fallbacks.find(f => f.standIn === id && f.hint);
          if (f) ctx.after(HANDOFF_MS, () => handoff(f));
          say(`${id} is back with v${rp.v}` + (rp.v < S.latestAcked
            ? `, but it missed v${S.latestAcked}, so it is stale. Read repair fixes it when it answers a read; anti-entropy fixes it in the background.`
            : ".") + (f ? ` ${f.id} holds a hint for ${id} and will hand off v${f.hint.v} in a few seconds.` : ""), rp.v < S.latestAcked ? "warn" : "info");
        } else {
          const fails = [ups < S.w && `writes (w = ${S.w})`, ups < S.r && `reads (r = ${S.r})`].filter(Boolean);
          say(!fails.length ? `${id} is down, but ${ups} of ${S.n} replicas are up: enough for w = ${S.w} and r = ${S.r}. No failover needed; ${id} just misses writes.`
            : `${id} is down: only ${ups} of ${S.n} replicas are up, so ${fails.join(" and ")} will fail.` + (ups >= S.w ? ""
              : S.sloppy ? " Sloppy quorum is on, so fallback nodes will stand in for writes." : " Turn on Sloppy quorum to let fallback nodes accept writes."),
          fails.length ? "bad" : "info");
        }
        draw();
      }

      function setN(n) {
        const added = [];
        while (S.replicas.length < n) { const id = "R" + (S.replicas.length + 1); added.push(id); S.replicas.push({ id, up: true, v: S.latestAcked }); }
        const removed = S.replicas.splice(n).map(x => x.id);
        S.n = n;
        // Forget removed replicas everywhere so a re-added namesake starts clean.
        Object.values(S.writes).forEach(wr => { wr.ackers = wr.ackers.filter(id => !removed.includes(id)); });
        S.fallbacks.forEach(f => { if (removed.includes(f.standIn)) { f.standIn = null; f.hint = null; } });
        S.readIds = S.readIds.filter(id => !removed.includes(id));
        S.w = Math.min(S.w, n); S.r = Math.min(S.r, n);
        view.wS.input.max = n; view.wS.set(S.w);
        view.rS.input.max = n; view.rS.set(S.r);
        G = geometry(compact, n);
        configChanged(added.length ? `Added ${names(added)} with a copy of v${S.latestAcked}. ` : "");
      }

      function configChanged(prefix = "") {
        const sum = S.w + S.r, edge = S.w === S.n ? ["w", "acknowledge", "write"] : S.r === S.n ? ["r", "answer", "read"] : null;
        if (edge) say(prefix + `With <b>${edge[0]} = n</b> every replica must ${edge[1]}, so one down node makes every ${edge[2]} fail.`, "warn");
        else if (sum > S.n) {
          say(prefix + `<b>w + r = ${sum} &gt; n = ${S.n}</b>: any ${S.r} replicas you read include at least one of the ${S.w} that acknowledged ` +
            `the latest write. Writes tolerate ${S.n - S.w} down node${S.n - S.w > 1 ? "s" : ""}, reads ${S.n - S.r}.`, "info");
        } else {
          say(prefix + `<b>w + r = ${sum} ≤ n = ${S.n}</b>: a read can hear only from replicas the latest write never reached. ` +
            "Press <b>Write</b>, then <b>Read</b> while the slow amber copies are still in flight.", "warn");
        }
        draw();
      }

      function setRepair(v) {
        S.repair = v;
        say(v ? "Read repair on: after a read, the client writes the newest value back to responders that returned an older one."
          : "Read repair off: stale replicas stay stale until anti-entropy (or a later write) reaches them.", "info");
      }
      function setSloppy(v) {
        S.sloppy = v;
        say(v ? `Sloppy quorum on: when home replicas are down, their copy of a write goes to fallback nodes X1/X2 outside R1–R${S.n}. ` +
          "Fallback acks count toward w, and each fallback keeps a hint to hand the value back."
          : "Sloppy quorum off: only home replicas can acknowledge a write, so writes fail when fewer than w are up.", "info");
        draw();
      }
      function setMode(m) {
        S.mode = m;
        say(m === "worst" ? "Worst case: the r reachable replicas holding the oldest versions answer first. Networks can produce exactly this ordering."
          : "Random r: the first r replies come from a random set of reachable replicas.", "info");
      }

      build();
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
      return { state: () => S }; // read by scripted tests
    },
  });
})();
