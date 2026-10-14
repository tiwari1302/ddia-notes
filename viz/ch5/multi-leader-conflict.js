// Multi-leader write conflicts. Alice (Europe) and Bob (US) retitle the same wiki page on
// different leaders. The reader picks how replicas resolve the conflict and sees who silently
// loses data, or avoids conflicts by sending every write to one leader and pays for it in
// latency and in availability when the link between datacenters is down.
(function () {
  // ---------- Pure replication model (no DOM; exercised by a node test) ----------
  // value = {id, text, ts, origin: "seed"|"eu"|"us"|"merge", user, anc, parts?}
  // anc = ids of every value this one replaced, transitively (what its writer had seen).
  const RID = { eu: 1, us: 2 };
  const rid = v => RID[v.origin] || 0;
  const cmpKeys = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1; return 0; };
  const maxBy = (arr, key) => arr.reduce((m, x) => (cmpKeys(key(x), key(m)) > 0 ? x : m));
  const byText = (a, b) => (a.text === b.text ? (a.id < b.id ? -1 : 1) : a.text < b.text ? -1 : 1);
  const ancOf = S => Array.from(new Set(S.flatMap(x => [x.id].concat(x.anc))));
  const covers = (S, id) => S.some(x => x.id === id || x.anc.includes(id));
  const textOf = S => S.map(x => x.text).join(" | ");
  const sameState = (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id);

  // Drop duplicates and every value that another one already replaced.
  function frontier(vals) {
    const uniq = Array.from(new Map(vals.map(v => [v.id, v])).values());
    return uniq.filter(v => !uniq.some(w => w.anc.includes(v.id))).sort(byText);
  }
  // id and text depend only on the parts, so every replica computes the same merged value.
  function merged(parts) {
    if (parts.length === 1) return parts[0];
    return {
      id: "m(" + parts.map(p => p.id).sort().join("+") + ")",
      text: Array.from(new Set(parts.map(p => p.text))).sort().join("/"),
      ts: Math.max(...parts.map(p => p.ts)), origin: "merge", parts, anc: ancOf(parts),
    };
  }
  // A local write replaces everything its leader currently holds. Timestamps never go
  // backwards along a chain of edits, so a later edit always has the larger timestamp.
  function write(S, id, text, user, origin, stamp) {
    return { id, text, user, origin, ts: Math.max(stamp, ...S.map(x => x.ts + 1)), anc: ancOf(S) };
  }
  // A replicated value v arrives at a leader that holds S.
  function receive(S, v, strategy) {
    if (S.every(x => v.anc.includes(x.id))) return { S: [v], kind: "apply" }; // writer had seen S
    if (covers(S, v.id)) return { S, kind: "stale" };
    const all = S.concat([v]);
    const out = strategy === "naive" ? [v]
      : strategy === "lww" ? [maxBy(all, x => [x.ts, rid(x)])]
      : strategy === "rid" ? [maxBy(all, x => [rid(x), x.ts])]
      : strategy === "merge" ? [merged(frontier(all.flatMap(x => x.parts || [x])))]
      : frontier(all); // siblings
    return { S: out, kind: "conflict" };
  }

  Viz.register("ch5/multi-leader-conflict", {
    title: "Multi-leader write conflicts",
    model: { write, receive, covers, sameState, textOf },
    mount(root, ctx) {
      const { s, ui } = ctx;
      const USERS = {
        alice: { name: "Alice", dc: "eu", text: "B", pron: "her" },
        bob: { name: "Bob", dc: "us", text: "C", pron: "his" },
      };
      const DC = { eu: "EU", us: "US" };
      const PLACE = { eu: "Europe", us: "the US" };
      const STRATS = [
        { value: "naive", label: "Apply in arrival order (naive)" },
        { value: "lww", label: "Last write wins (timestamp)" },
        { value: "rid", label: "Higher replica ID wins" },
        { value: "merge", label: "Merge values" },
        { value: "siblings", label: "Keep both (siblings)" },
      ];
      const other = dc => (dc === "eu" ? "us" : "eu");
      const col = tone => (tone ? `var(--viz-${tone})` : "var(--viz-ink)");
      const N = w => USERS[w.user].name;
      const fmtMs = n => n.toLocaleString("en-US") + " ms";
      const pad = (n, w) => String(n).padStart(w, "0");
      const fmtTs = ms => {
        const t = 36e6 + ms;
        return `${pad(Math.floor(t / 36e5), 2)}:${pad(Math.floor(t / 6e4) % 60, 2)}:${pad(Math.floor(t / 1e3) % 60, 2)}.${pad(t % 1000, 3)}`;
      };

      // Phone and desktop scenes. [x, y, w, h] rects and [x, y] points.
      const DESK = {
        W: 640, H: 206, fs: 12, vertical: false,
        panel: { eu: [4, 16, 246, 180], us: [390, 16, 246, 180] },
        box: { eu: [84, 62, 160, 90], us: [396, 62, 160, 90] },
        user: { alice: [44, 107], bob: [596, 107] },
        end: { eu: [244, 107], us: [396, 107] },
        linkLabel: [320, 76, "middle"], status: [320, 150, "middle"],
        queue: { eu: [164, 174], us: [476, 174] },
      };
      const PHONE = {
        W: 360, H: 390, fs: 11, vertical: true,
        panel: { eu: [10, 10, 340, 160], us: [10, 220, 340, 160] },
        box: { eu: [110, 50, 220, 80], us: [110, 260, 220, 80] },
        user: { alice: [50, 90], bob: [50, 300] },
        end: { eu: [310, 130], us: [310, 260] }, // off-centre so the link misses the badges
        linkLabel: [282, 188, "end"], status: [282, 205, "end"],
        queue: { eu: [165, 151], us: [220, 362] },
      };

      // ---------- State (kept outside build() so a layout switch preserves it) ----------
      let arch = "multi", strategy = "lww", homeRoute = false, delay = 600, linkDown = false;
      let clock = 0, seq = 0, epoch = 0, inflight = 0, pendingAck = null;
      let st, queue, lastArrive, ep, badge, tags;
      const routed = () => arch === "single" || homeRoute;
      const busy = () => inflight > 0 || queue.eu.length + queue.us.length > 0 || st.eu.length > 1 || st.us.length > 1;

      // ---------- Controls ----------
      const archSeg = ui.segmented({
        label: "Architecture", value: arch,
        options: [{ value: "multi", label: "Multi-leader" }, { value: "single", label: "Single leader (EU)" }],
        onChange: v => { arch = v; syncControls(); resetAll(); },
      });
      const stratSel = ui.select({ label: "On conflict", options: STRATS, value: strategy, onChange: v => { strategy = v; resetAll(); } });
      const routeTg = ui.toggle({ label: "Route this page to its home DC (EU)", value: homeRoute, onChange: v => { homeRoute = v; resetAll(); } });
      const delaySl = ui.slider({
        label: "Inter-DC delay", min: 100, max: 2000, step: 50, value: delay, format: fmtMs,
        onInput: v => { delay = v; refresh(); },
      });
      const linkTg = ui.toggle({ label: "Link down", value: linkDown, onChange: setLink });
      const btnA = ui.button("Alice: title → B", () => { userWrite("alice", clock); refresh(); });
      const btnB = ui.button("Bob: title → C", () => { userWrite("bob", clock); refresh(); });
      // Alice at now + 90 ms, Bob at now + 120 ms: 30 ms apart, far less than the link delay.
      const btnBoth = ui.button("Both edit at once", () => {
        userWrite("alice", clock + 90); userWrite("bob", clock + 120); refresh();
      }, { kind: "primary" });
      const keepBtns = ["B", "C"].map(t => ui.button(`Keep ${t}`, () => keep(t), { kind: "ok", title: `Resolve the siblings by keeping ${t}` }));
      const resetBtn = ui.button("Reset", () => resetAll(), { kind: "ghost" });
      const actions = ui.bar(btnA, btnB, btnBoth, ...keepBtns, resetBtn);
      const note = ui.note("");
      const stats = ui.stats([
        { key: "alice", label: "Alice's write latency" },
        { key: "bob", label: "Bob's write latency" },
        { key: "conflict", label: "Conflict" },
        { key: "replicas", label: "Replicas" },
        { key: "lost", label: "Silently lost" },
      ]);
      const logEl = ui.log({ title: "What happened", height: 120 });
      const log = (html, tone) => logEl.add(html, tone);
      const holder = ctx.h("div");

      function syncControls() {
        const single = arch === "single";
        routeTg.set(single || homeRoute);
        routeTg.querySelector("input").disabled = single;
        stratSel.querySelector("select").disabled = single;
        routeTg.style.opacity = stratSel.style.opacity = single ? "0.5" : "";
      }

      // ---------- Scene ----------
      let V = null, compact = ctx.compact;
      function build() {
        compact = ctx.compact;
        const G = compact ? PHONE : DESK, fs = G.fs;
        const svg = ctx.svg({ w: G.W, h: G.H, label: "Two datacenters, each with a leader, replicating a wiki page title to each other" });
        const scene = s("g"), packets = s("g");
        svg.append(scene, packets);
        const T = (x, y, str, o) => { const t = ctx.text(x, y, str, Object.assign({ size: fs }, o)); scene.appendChild(t); return t; };
        V = { G, packets, box: {}, tag: {}, title: {} };
        for (const dc of ["eu", "us"]) {
          const [x, y, w, h] = G.panel[dc];
          scene.appendChild(ctx.box({ x, y, w, h, rx: 10, dashed: true, fill: "none", stroke: "var(--viz-line)" }));
          V.title[dc] = T(x + 12, y + 15, "United States", { anchor: "start", weight: 700, fill: "var(--viz-muted)" });
        }
        const [a, b] = [G.end.eu, G.end.us];
        V.link = s("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], "stroke-width": 2 });
        scene.appendChild(V.link);
        V.linkLabel = T(G.linkLabel[0], G.linkLabel[1], "", { anchor: G.linkLabel[2], weight: 600, halo: true });
        V.status = T(G.status[0], G.status[1], "", { anchor: G.status[2], weight: 700, halo: true });
        for (const u of ["alice", "bob"]) {
          const [x, y] = G.user[u], bx = G.box[USERS[u].dc];
          const right = bx[0] > x, tip = right ? bx[0] - 2 : bx[0] + bx[2] + 2;
          scene.appendChild(ctx.arrow({ x1: x + (right ? 21 : -21), y1: y, x2: tip, y2: y, color: "var(--viz-c6)", width: 1.5, svg }));
          scene.appendChild(ctx.node({ x, y, r: 20, label: USERS[u].name, size: 11, fill: "var(--viz-c6-soft)", stroke: "var(--viz-c6)" }));
          V.tag[u] = [T(x, y + 36, "", { weight: 700 }), T(x, y + 36 + fs + 5, "")];
        }
        for (const dc of ["eu", "us"]) {
          const [x, y, w, h] = G.box[dc], cx = x + w / 2;
          const g = ctx.box({ x, y, w, h, rx: 10 });
          scene.appendChild(g);
          V.box[dc] = {
            rect: g.rect,
            name: T(cx, y + (compact ? 15 : 17), "", { weight: 600 }),
            value: T(cx, y + h / 2 + 2, "", { size: 18, mono: true, weight: 700 }),
            meta: T(cx, y + h - (compact ? 14 : 16), "", { fill: "var(--viz-muted)" }),
            badge: T(cx, y - 12, "", { weight: 700, halo: true }),
            queue: T(G.queue[dc][0], G.queue[dc][1], "", { weight: 700, fill: "var(--viz-warn)" }),
          };
        }
        holder.replaceChildren(svg);
        refresh();
      }

      function meta(S) {
        if (S.length > 1) return `${S.length} versions, unresolved`;
        const v = S[0];
        if (v.parts) return "merged from " + v.parts.map(p => p.text).join(" + ");
        return `ts ${fmtTs(v.ts)} · ${v.user ? USERS[v.user].name : "original"}`;
      }

      function draw(settled, same) {
        const single = arch === "single";
        for (const dc of ["eu", "us"]) {
          const B = V.box[dc], S = st[dc], c = single && dc === "us" ? "c2" : "c1";
          ctx.attr(B.rect, { fill: `var(--viz-${c}-soft)`, stroke: `var(--viz-${c})` });
          B.name.textContent = c === "c2" ? "US follower (read-only)" : DC[dc] + " leader";
          B.value.textContent = textOf(S);
          ctx.attr(B.value, { fill: settled && !same ? "var(--viz-bad)" : "var(--viz-ink)" });
          B.meta.textContent = meta(S);
          B.badge.textContent = badge[dc] ? badge[dc].text : "";
          ctx.attr(B.badge, { fill: col(badge[dc] && badge[dc].tone) });
          const sends = !(single && dc === "us"); // a read-only follower never originates changes
          B.queue.textContent = (linkDown && sends) || queue[dc].length ? `${queue[dc].length} queued` : "";
        }
        V.title.eu.textContent = "Europe" + (homeRoute && !single ? " · home DC of this page" : "");
        ctx.attr(V.link, { stroke: linkDown ? "var(--viz-bad)" : "var(--viz-line)", "stroke-dasharray": linkDown ? "6 5" : "none" });
        V.linkLabel.textContent = linkDown ? "link down" : `async link · ${fmtMs(delay)}`;
        ctx.attr(V.linkLabel, { fill: linkDown ? "var(--viz-bad)" : "var(--viz-ink)" });
        const [txt, tone] = !settled ? (inflight ? ["replicating…", "info"] : ["waiting for link", "warn"])
          : !same ? ["≠ diverged", "bad"] : st.eu.length > 1 ? ["in sync, unresolved", "warn"] : ["✓ in sync", "ok"];
        V.status.textContent = txt;
        ctx.attr(V.status, { fill: col(tone) });
        for (const u of ["alice", "bob"]) {
          const [l1, l2] = V.tag[u], t = tags[u], S = st[USERS[u].dc];
          const mine = ep && ep.writes.filter(w => w.user === u).pop();
          l1.textContent = t ? t.text : "";
          ctx.attr(l1, { fill: col(t && t.tone) });
          l2.textContent = "sees " + textOf(S);
          ctx.attr(l2, { fill: settled && mine && missing(USERS[u].dc, mine) ? "var(--viz-bad)" : "var(--viz-muted)" });
        }
      }

      function flash(dc) {
        if (!V) return;
        const r = V.box[dc].rect;
        ctx.tween({ ms: 600, ease: "out", onUpdate: k => r.setAttribute("stroke-width", 4 - 2.5 * k) });
      }

      // A packet along the link. Each direction has its own lane and stays FIFO.
      function launch(from, label, fill, onArrive) {
        const my = epoch, now = performance.now();
        const at = Math.max(now + Math.max(400, delay), lastArrive[from] + 40);
        lastArrive[from] = at;
        inflight++;
        fly(from, label, fill, at - now).then(() => {
          if (my !== epoch) return;
          inflight--;
          onArrive();
          refresh();
        });
      }
      function fly(from, label, fill, ms, lost) {
        const G = V.G, d = from === "eu" ? -7 : 7;
        const lane = p => (G.vertical ? [p[0] + d, p[1]] : [p[0], p[1] + d]);
        const done = ctx.fly(V.packets, { from: lane(G.end[from]), to: lane(G.end[other(from)]), label, fill, ms, lost, ease: "linear", labelSize: G.fs });
        const t = V.packets.lastChild.querySelector("text");
        if (G.vertical) ctx.attr(t, { x: d * 1.7, y: 0, "text-anchor": d < 0 ? "end" : "start" });
        else if (d > 0) ctx.attr(t, { y: 19 }); // westbound labels go under their lane
        return done;
      }

      // ---------- Replication logic ----------
      function replicate(from, v) {
        if (!linkDown) return launch(from, v.text, "var(--viz-c1)", () => deliver(other(from), v));
        queue[from].push(v);
        log(`${DC[from]}: link down, ${v.text} queued for ${PLACE[other(from)]}`, "warn");
      }

      // Apply a new write at leader dc, log it (msg), then replicate it to the other leader.
      function commit(dc, u, text, stamp, verb, msg) {
        const v = write(st[dc], "w" + ++seq, text, u, dc, stamp);
        v.base = st[dc];
        st[dc] = [v];
        ep.writes.push(v);
        badge[dc] = { text: `${verb} ${text}`, tone: "muted" };
        flash(dc);
        log(msg(v, textOf(v.base)), "ok");
        replicate(dc, v);
        return v;
      }

      function userWrite(u, stamp) {
        if (!busy()) ep = { writes: [], conflict: false, failed: false, blind: null, resolved: false, bobLatency: 0 };
        const U = USERS[u];
        if (u === "bob" && routed()) return forwardBob();
        commit(U.dc, u, U.text, stamp, `${U.name} wrote`, v => `${DC[U.dc]}: ${U.name} wrote ${U.text} (ts ${fmtTs(v.ts)}), told “saved” after 5 ms`);
        tags[u] = { text: `${U.text} saved ✓`, tone: "ok" };
      }

      // Home-DC routing / single leader: Bob's write must go to the leader in Europe.
      function forwardBob() {
        const saw = st.us.slice();
        if (linkDown) {
          ep.failed = true;
          tags.bob = { text: "C failed ✕", tone: "bad" };
          log("Bob: write failed, cannot reach the leader in Europe", "bad");
          fly("us", "C", "var(--viz-c6)", Math.max(400, delay), 0.5);
          return;
        }
        ep.bobLatency = 5 + 2 * delay;
        tags.bob = { text: "C waiting…", tone: "warn" };
        log(`Bob: write C sent to the leader in Europe (${fmtMs(delay)} away)`, "info");
        launch("us", "C", "var(--viz-c6)", () => {
          const cur = st.eu[0];
          if (!sameState(saw, st.eu) && cur.user === "alice") ep.blind = cur.text;
          pendingAck = commit("eu", "bob", "C", clock, "applied Bob's", (v, prev) => `EU applied Bob's C after ${prev}: one leader, one order`).id;
        });
      }

      function deliver(dc, v) {
        const was = textOf(st[dc]), r = receive(st[dc], v, strategy), D = DC[dc];
        st[dc] = r.S;
        if (r.kind === "stale") return;
        flash(dc);
        const now = textOf(r.S);
        if (r.kind === "apply") {
          badge[dc] = { text: `applied ${v.text}`, tone: "muted" };
          log(`${D} applied ${v.text} (it was based on ${was}, which ${D} had)`, "ok");
        } else {
          ep.conflict = true;
          const [b, tone, why] = {
            naive: [`overwrote ${was} with ${v.text}`, "bad", `${v.text} overwrote it (arrival order)`],
            lww: [`conflict → kept ${now} (later ts)`, "warn", `kept ${now}, ts ${fmtTs(r.S[0].ts)} is later`],
            rid: [`conflict → kept ${now} (${DC[r.S[0].origin]} wins)`, "warn", `kept ${now}, replica ID 2 (US) beats 1 (EU)`],
            merge: [`conflict → merged ${now}`, "warn", `merged into ${now}`],
            siblings: ["conflict: kept both", "warn", `kept both as siblings: ${now}`],
          }[strategy];
          badge[dc] = { text: b, tone };
          log(`${D}: conflict! holds ${was}, received ${v.text} → ${why}`, tone === "bad" ? "bad" : "warn");
        }
        if (v.id === pendingAck && dc === "us") {
          pendingAck = null;
          tags.bob = { text: "C saved ✓", tone: "ok" };
          log(`Bob is told “saved” after ${fmtMs(ep.bobLatency)}`, "warn");
        }
      }

      // Siblings resolved on read: the choice is a new write based on every sibling.
      function keep(text) {
        const dc = st.eu.length > 1 ? "eu" : st.us.length > 1 ? "us" : null;
        if (!dc || strategy !== "siblings") return;
        const u = dc === "eu" ? "alice" : "bob";
        const v = commit(dc, u, text, clock, "resolved →", (v, prev) => `${DC[dc]}: ${USERS[u].name} read ${prev} and kept ${text}, written back as a new value based on both`);
        v.resolve = true;
        ep.resolved = true;
        badge[dc].tone = "ok";
        refresh();
      }

      function setLink(down) {
        linkDown = down;
        if (down) log("Link between the datacenters is down", "bad");
        else {
          const n = queue.eu.length + queue.us.length;
          log("Link restored" + (n ? `: sending ${n} queued change${n > 1 ? "s" : ""}` : ""), "info");
          for (const dc of ["eu", "us"]) queue[dc].splice(0).forEach(v => replicate(dc, v));
        }
        refresh();
      }

      function resetAll() {
        epoch++;
        const v0 = { id: "v0", text: "A", ts: 0, origin: "seed", anc: [] };
        st = { eu: [v0], us: [v0] };
        queue = { eu: [], us: [] };
        lastArrive = { eu: 0, us: 0 };
        clock = 0; inflight = 0; pendingAck = null; ep = null;
        badge = { eu: null, us: null };
        tags = { alice: null, bob: null };
        if (V) V.packets.replaceChildren();
        logEl.clear();
        log(arch === "single" ? "Setup: one leader in Europe, the US is a read-only follower"
          : `Setup: a leader in each datacenter${homeRoute ? ", this page's writes routed to Europe" : ""}; on conflict: ${STRATS.find(o => o.value === strategy).label}`, "muted");
        refresh();
      }

      // ---------- Read-outs ----------
      // A write is missing at a leader if it was neither kept nor superseded there, and its
      // text is not shown there either (Alice always writes B, so another B still counts).
      const missing = (dc, w) => !covers(st[dc], w.id) && !st[dc].some(x => (x.parts || [x]).some(p => p.text === w.text));
      const uniq = arr => Array.from(new Set(arr));
      const lostWrites = () => (ep ? ep.writes.filter(w => missing("eu", w) && missing("us", w)) : []);
      // When replicas disagree, each one has silently dropped different writes.
      const lostPerDc = () => ["eu", "us"].map(dc => {
        const t = uniq(ep.writes.filter(w => missing(dc, w)).map(w => w.text));
        return t.length ? `${DC[dc]}: ${t.join(", ")}` : "";
      }).filter(Boolean).join(" · ");
      const concurrent = ws => ws.some(a => ws.some(b => a.user !== b.user && !a.anc.includes(b.id) && !b.anc.includes(a.id)));

      function refresh() {
        if (!V) return;
        const settled = inflight === 0 && queue.eu.length + queue.us.length === 0;
        const same = sameState(st.eu, st.us);
        // Every deterministic rule must converge; only "apply in arrival order" may diverge.
        if (settled && !same && (strategy !== "naive" || routed())) console.error(`[ch5/multi-leader-conflict] replicas diverged under "${strategy}"`);
        draw(settled, same);
        const sib = st.eu.length > 1 || st.us.length > 1;
        stats.set("alice", "5 ms", "ok");
        if (!routed()) stats.set("bob", "5 ms", "ok");
        else if (linkDown) stats.set("bob", "unavailable", "bad");
        else stats.set("bob", fmtMs(5 + 2 * delay), "warn");
        if (!ep || !ep.conflict) stats.set("conflict", "none", "ok");
        else stats.set("conflict", strategy === "naive" ? "unhandled" : "detected", strategy === "naive" ? "bad" : "warn");
        const small = t => `<span style="font-size:13px;font-weight:600">${t}</span>`;
        const shown = `<span style="white-space:nowrap">${textOf(st.eu)}</span>`; // keep "B | C" on one line
        if (!settled) stats.set("replicas", inflight ? "replicating…" : "out of sync", inflight ? "info" : "warn");
        else if (!same) stats.set("replicas", "DIVERGED", "bad");
        else if (sib) stats.set("replicas", `converged: ${shown} ${small("(unresolved)")}`, "warn");
        else stats.set("replicas", `converged: ${shown}`, "ok");
        const lost = lostWrites();
        if (!ep) stats.set("lost", "nothing", "ok");
        else if (!settled) stats.set("lost", "–", "");
        else if (!same) stats.set("lost", lostPerDc(), "bad");
        else stats.set("lost", lost.length ? uniq(lost.map(w => `${N(w)}'s ${w.text}`)).join(", ") : "nothing", lost.length ? "bad" : "ok");
        note.set(...explain(settled, same));
        keepBtns.forEach(b => { b.style.display = strategy === "siblings" && sib && inflight === 0 ? "" : "none"; });
      }

      function explain(settled, same) {
        const ws = ep ? ep.writes : [];
        if (!ep || (!ws.length && !ep.failed && !inflight)) {
          return [`Both datacenters agree the title is <b>${textOf(st.eu)}</b>. Press <b>Both edit at once</b>.`, "info"];
        }
        if (ep.failed) {
          return ["Bob's write <b>failed</b>: only the leader in Europe accepts writes for this page, and it cannot be reached. " +
            "Alice can still write. Avoiding conflicts with one home leader costs availability during a network partition.", "bad"];
        }
        if (inflight) {
          if (tags.bob && tags.bob.tone === "warn") {
            return [`Bob's write has to reach the leader in Europe before he hears “saved”: ${fmtMs(delay)} there, 5 ms to apply, ${fmtMs(delay)} back.`, "info"];
          }
          if (!routed() && concurrent(ws)) {
            return ["Alice and Bob were each told “saved” after 5 ms. Their changes are now crossing between the datacenters; " +
              "neither leader knows yet that the other accepted a different title.", "info"];
          }
          const w = ws[ws.length - 1];
          return [`${N(w)}'s <b>${w.text}</b> was ${w.resolve ? "written back" : "saved locally in 5 ms"} and is replicating to ${PLACE[other(w.origin)]} in the background.`, "info"];
        }
        if (!settled) {
          return routed() ? ["Europe keeps accepting Alice's writes, but the US copy stays stale until the link returns.", "info"]
            : ["Both datacenters keep accepting writes locally; changes queue up and replicate when the link returns, possibly as conflicts.", "info"];
        }
        if (routed()) {
          if (!ws.some(w => w.user === "bob")) {
            return ["Alice's write went to the leader in Europe, next to her (5 ms), and replicated to the US. Now try Bob's write: it has to go to Europe too.", "info"];
          }
          const both = ws.some(w => w.user === "alice");
          return [`Europe ordered ${both ? "both writes" : "Bob's write"}, so there is nothing to resolve. Price: Bob's write took <b>${fmtMs(ep.bobLatency)}</b> instead of 5 ms, ` +
            "and with the link down he cannot write at all." +
            (ep.blind ? ` Bob never saw Alice's <b>${ep.blind}</b>, yet replaced it: a lost update, which needs transactions (Chapter 7).` : ""), "warn"];
        }
        if (ep.resolved && same && st.eu.length === 1) {
          return ["Resolved: the choice was written back as a new value that replaced both siblings, and it replicated like any other write.", "ok"];
        }
        if (ep.conflict) return conflictNote(same);
        // The value the last write replaced; with no conflict, every replica saw it first.
        const w = ws[ws.length - 1], p = w.base[0];
        if (p.user && p.user !== w.user) {
          return [`No conflict: ${N(w)}'s edit was based on ${N(p)}'s <b>${p.text}</b>, which had already reached ${PLACE[w.origin]}, so every strategy keeps <b>${w.text}</b>. ` +
            `(A store that compares only timestamps would agree too, unless ${N(w)}'s clock ran behind ${N(p)}'s: see Chapter 8.)`, "ok"];
        }
        return [`No conflict: ${PLACE[other(w.origin)]} still had <b>${p.text}</b>, which ${N(w)}'s <b>${w.text}</b> was based on, so it simply applied it. Now press <b>Both edit at once</b>.`, "ok"];
      }

      function conflictNote(same) {
        const val = textOf(st.eu), W = st.eu[0], L = lostWrites()[0];
        if (strategy === "naive") {
          return same ? ["Each leader applied whatever arrived last. This time the arrivals happened to line up, but nothing guarantees it: run it again.", "warn"]
            : [`Each leader applied whatever arrived last: Europe now shows <b>${textOf(st.eu)}</b>, the US shows <b>${textOf(st.us)}</b>, and nothing will ever reconcile them. ` +
              "Replicas must resolve conflicts the same way everywhere.", "bad"];
        }
        if (strategy === "lww") {
          return L ? [`Both leaders kept <b>${val}</b> because its timestamp is ${W.ts - L.ts} ms later. ${N(L)} was told ${USERS[L.user].pron} edit was saved; it has been silently discarded.`, "bad"]
            : [`Both leaders kept <b>${val}</b>, the value with the latest timestamp.`, "warn"];
        }
        if (strategy === "rid") {
          const newer = L && L.ts > W.ts ? `, even though ${N(L)}'s ${L.text} was ${L.ts - W.ts} ms newer` : "";
          return [`The US has the higher replica ID, so <b>${val}</b> wins everywhere. Deterministic, but it means US edits always beat European ones${newer}.` +
            (L ? ` ${N(L)}'s acknowledged <b>${L.text}</b> is silently discarded.` : ""), L ? "bad" : "warn"];
        }
        if (strategy === "merge") {
          return [`Both leaders converged on '<b>${val}</b>'. Nothing is lost, but '${val}' is probably not a title anyone wanted; the application must clean it up.`, "warn"];
        }
        const texts = st.eu.map(x => `<b>${x.text}</b>`);
        return [`Both leaders now store ${texts.slice(0, -1).join(", ")} and ${texts[texts.length - 1]} side by side. ` +
          "No data lost; the next reader (or the user) must choose, as CouchDB does on read.", "warn"];
      }

      // Chapter layout: controls and actions, scene, legend, stats, note, log.
      root.append(
        ui.bar(archSeg, stratSel),
        ui.bar(routeTg, delaySl, linkTg),
        actions, holder,
        ui.legend([
          { color: "var(--viz-c6)", label: "user / forwarded write" },
          { color: "var(--viz-c1)", label: "leader", shape: "square" },
          { color: "var(--viz-c2)", label: "read-only follower", shape: "square" },
          { color: "var(--viz-c1)", label: "replication message" },
          { color: "var(--viz-bad)", label: "lost / diverged / link down", shape: "line" },
        ]),
        stats, note, logEl,
      );
      resetAll();
      build();
      ctx.every(50, () => { clock += 50; }); // shared simulated clock
      // Rebuild one tick later: rebuilding inside the ResizeObserver callback trips its loop warning.
      ctx.onResize(() => ctx.after(0, () => { if (ctx.compact !== compact) build(); }));
    },
  });
})();
