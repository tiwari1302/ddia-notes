// Twitter home timelines (DDIA ch1, "describing load"). Every tweet must reach every
// follower's timeline: pull pays on each read, push pays on each write and explodes for
// celebrities, and the hybrid treats the skewed head of the follower distribution apart.
Viz.register("ch1/twitter-fanout", {
  title: "Twitter timelines: fan-out on read vs write",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    // Assumed model parameters (not Twitter figures); stated on screen under the chart.
    const FOLLOWS = 75, CELEBS = 3, CAP = 1e6, GOAL = 5;
    const NAMES = { bob: "Bob", cara: "Cara", dev: "Dev", eve: "Eve", fay: "Fay" };
    // When each drawn follower's copy lands during a celebrity flood (fraction of the flood).
    const ARRIVE = { bob: 0.1, dev: 0.3, cara: 0.55, fay: 0.7, eve: 0.85 };
    const STRATS = [
      { value: "pull", label: "Pull (fan-out on read)", short: "Pull" },
      { value: "push", label: "Push (fan-out on write)", short: "Push" },
      { value: "hybrid", label: "Hybrid", short: "Hybrid" },
    ];
    const HEAD = {
      pull: "Followers' timelines: built on each read",
      push: "Followers' timelines: cached inboxes",
      hybrid: "Followers' timelines: inbox + celeb merge",
    };
    const cfg = { strategy: "pull", T: 4600, F: 75, R: 300000, M: 30e6 };
    let scene = freshScene(), note = null;
    let busy = false, token = 0, compact = ctx.compact, L = null, v = null;

    const trim = x => (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ""));
    const fmt = n => (n >= 1e6 ? trim(n / 1e6) + "M" : n >= 1e3 ? trim(n / 1e3) + "k" : String(Math.round(n)));
    const secs = x => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10) + " s";
    const ratio = () => { const r = cfg.R / cfg.T; return r >= 10 ? String(Math.round(r)) : r.toFixed(1); };
    const col = (c, soft) => `var(--viz-${c}${soft ? "-soft" : ""})`;
    const tint = who => (who === "alice" ? "c5" : "c3");

    function freshScene() {
      const inbox = {};
      Object.keys(NAMES).forEach(n => { inbox[n] = []; });
      // view: Bob's timeline as assembled by his last read (pull / hybrid), else his inbox.
      return { seq: 0, table: [], inbox, view: null, badge: {}, fan: null, tableNote: null, flood: null };
    }

    // Per-second work at scale for each strategy (writes, read work).
    function work(strategy) {
      const { T, F, R } = cfg;
      if (strategy === "pull") return { w: T, r: R * FOLLOWS };
      if (strategy === "push") return { w: T * F, r: R };
      return { w: T * F, r: R * (1 + CELEBS), bound: true }; // celebrity deliveries removed: at most T x F
    }

    // ---------------------------------------------------------------- layout
    const tl = (id, x, y, w, hh) => ({ id, x, y, w, h: hh });
    function layout(phone) {
      if (phone) return {
        phone, W: 360, H: 350, fs: 11, chip: [20, 11], pr: 6,
        alice: { x: 34, y: 38, r: 20 }, celeb: { x: 204, y: 38, r: 22 },
        fan: { x: 14, y: 92, w: 156, h: 48 }, table: { x: 190, y: 92, w: 156, h: 48 },
        bar: { x: 14, y: 148, w: 156, h: 8, ty: 168, gap: 14 },
        head: [14, 204], more: [346, 340, "+71 more followers not drawn"],
        boxes: [tl("bob", 14, 214, 332, 54), tl("cara", 14, 276, 104, 50), tl("dev", 128, 276, 104, 50), tl("eve", 242, 276, 104, 50)],
      };
      return {
        phone, W: 640, H: 232, fs: 12, chip: [22, 12], pr: 7,
        alice: { x: 70, y: 76, r: 24 }, celeb: { x: 70, y: 172, r: 30 },
        fan: { x: 180, y: 28, w: 150, h: 56 }, table: { x: 180, y: 156, w: 150, h: 56 },
        bar: { x: 180, y: 96, w: 150, h: 10, ty: 124, gap: 16 },
        head: [370, 12], more: [630, 222, "+70 more followers not drawn"],
        boxes: [tl("bob", 370, 24, 260, 56), tl("cara", 370, 90, 125, 52), tl("dev", 505, 90, 125, 52),
          tl("eve", 370, 152, 125, 52), tl("fay", 505, 152, 125, 52)],
      };
    }
    // Arrow end on a middle box (Alice's and the celebrity's arrows land side by side).
    function endPt(who, key) {
      const B = L[key], off = who === "alice" ? -1 : 1;
      return L.phone ? [B.x + B.w / 2 + off * 30, B.y - 3] : [B.x - 3, B.y + B.h / 2 + off * 8];
    }
    function startPt(who, end) {
      const a = L[who];
      if (L.phone) return [a.x, a.y + a.r + 3]; // below the node: labels sit to its right
      const dx = end[0] - a.x, dy = end[1] - a.y, len = Math.hypot(dx, dy);
      return [a.x + (dx / len) * (a.r + 3), a.y + (dy / len) * (a.r + 3)];
    }
    const fanOutPt = () => (L.phone ? [L.fan.x + L.fan.w / 2, L.fan.y + L.fan.h + 2] : [L.fan.x + L.fan.w + 2, L.fan.y + L.fan.h / 2]);
    const chipPt = b => [b.x + 22, b.y + b.h - 17];
    const bobGate = () => { const b = L.boxes[0]; return L.phone ? [L.table.x + L.table.w / 2, b.y - 3] : [b.x - 3, b.y + b.h / 2]; };
    const tableGate = () => (L.phone ? [L.table.x + L.table.w / 2, L.table.y + L.table.h + 3] : [L.table.x + L.table.w + 3, L.table.y + 20]);

    // ---------------------------------------------------------------- scene drawing
    function draw() {
      if (!v) return;
      const strat = cfg.strategy;
      const [ta, tc] = { pull: ["table", "table"], push: ["fan", "fan"], hybrid: ["fan", "table"] }[strat];
      v.scene.innerHTML = "";
      v.scene.append(edge("alice", ta), edge("celeb", tc), author("alice"), author("celeb"),
        midBox("fan"), midBox("table"), progress(),
        ctx.text(L.head[0], L.head[1], HEAD[strat], { size: L.fs, anchor: "start", weight: 600, fill: "var(--viz-muted)" }),
        ctx.text(L.more[0], L.more[1], L.more[2], { size: L.fs, anchor: "end", fill: "var(--viz-muted)" }),
        ...L.boxes.map(timeline));
    }

    function edge(who, key) {
      const end = endPt(who, key), start = startPt(who, end);
      const p = ctx.arrow({ x1: start[0], y1: start[1], x2: end[0], y2: end[1], color: col(tint(who)), svg: v.svg, width: 1.6 });
      p.setAttribute("opacity", 0.6);
      return p;
    }

    function author(who) {
      const a = L[who], c = tint(who), alice = who === "alice";
      const g = ctx.node({ x: a.x, y: a.y, r: a.r, label: alice ? "A" : "C", fill: col(c, true), stroke: col(c), size: L.phone ? 13 : 15 });
      const name = alice ? "Alice" : "Celeb", count = (alice ? "75" : fmt(cfg.M)) + " followers";
      if (L.phone) {
        const x = a.x + a.r + 8;
        g.append(ctx.text(x, a.y - 7, name, { size: 12, weight: 700, anchor: "start" }),
          ctx.text(x, a.y + 9, count, { size: 11, anchor: "start", fill: "var(--viz-muted)" }));
      } else {
        g.append(ctx.text(a.x, alice ? a.y - a.r - 14 : a.y + a.r + 16, `${name} · ${count}`, { size: 12, weight: 600 }));
      }
      return g;
    }

    function midBox(key) {
      const B = L[key], fan = key === "fan", n = scene.table.length;
      const idle = fan ? cfg.strategy === "pull" : cfg.strategy === "push";
      let sub = fan ? (L.phone ? "copy to inboxes" : "copy into timelines")
        : n ? `${n} tweet${n > 1 ? "s" : ""} stored` : L.phone ? "all tweets" : "all tweets by author";
      if (idle) sub = fan ? "not used in pull" : "not used for timelines";
      const over = fan ? scene.fan : scene.tableNote;
      if (over) sub = over.text;
      const g = ctx.box({ x: B.x, y: B.y, w: B.w, h: B.h, label: fan ? "Fan-out workers" : "Tweets table", sub, size: L.phone ? 13 : 14 });
      if (over) ctx.attr(g.sub, { fill: col(over.tone), "font-weight": 700 });
      if (idle) g.setAttribute("opacity", 0.4);
      return g;
    }

    // Celebrity delivery progress: full width = max(d, 6) simulated seconds, tick at the 5 s goal.
    function progress() {
      const B = L.bar, f = scene.flood, M = f ? f.M : cfg.M, d = M / CAP, full = Math.max(d, 6);
      const k = f ? f.k : 0, t = k * d, over = t > GOAL, tx = B.x + (B.w * GOAL) / full;
      const g = s("g", { opacity: cfg.strategy === "pull" ? 0.4 : 1 });
      g.append(
        s("rect", { x: B.x, y: B.y, width: B.w, height: B.h, rx: B.h / 2, fill: "var(--viz-grid)" }),
        s("rect", { x: B.x, y: B.y, width: (B.w * t) / full, height: B.h, rx: B.h / 2, fill: over ? "var(--viz-bad)" : "var(--viz-warn)" }),
        s("line", { x1: tx, x2: tx, y1: B.y - 4, y2: B.y + B.h + 4, stroke: "var(--viz-ink)", "stroke-width": 1.5 }),
        ctx.text(B.x, B.ty, `${fmt(k * M)} / ${fmt(M)} inbox writes`, { size: L.fs, anchor: "start" }),
        ctx.text(B.x, B.ty + B.gap, f ? `${t.toFixed(1)} s · ${over ? "past" : "within"} 5 s goal` : "tick = 5 s delivery goal", {
          size: L.fs, anchor: "start", weight: f ? 700 : 400, fill: f ? col(over ? "bad" : "warn") : "var(--viz-muted)",
        }));
      return g;
    }

    function timeline(b) {
      const g = s("g"), bob = b.id === "bob", pull = cfg.strategy === "pull", fs = L.fs;
      const frame = ctx.box({ x: b.x, y: b.y, w: b.w, h: b.h, dashed: pull,
        stroke: bob ? col("c6") : undefined, strokeWidth: bob ? 2.5 : 1.5 });
      if (bob) v.bobRect = frame.rect;
      const ry = b.y + 16, pad = L.phone && !bob ? 7 : 10;
      g.append(frame, ctx.text(b.x + pad, ry, NAMES[b.id], { size: fs, weight: 700, anchor: "start" }));
      if (bob) {
        const px = b.x + pad + fs * 2 + 6, pw = fs * 3.8;
        g.append(s("rect", { x: px, y: ry - 8, width: pw, height: 16, rx: 8, fill: col("c6", true) }),
          ctx.text(px + pw / 2, ry, "reader", { size: fs, weight: 600, fill: col("c6") }));
      }
      const badge = scene.badge[b.id];
      if (badge) g.append(ctx.text(b.x + b.w - pad, ry, badge.text, { size: fs, weight: 700, anchor: "end", fill: col(badge.tone) }));
      const list = (bob && scene.view) || scene.inbox[b.id];
      const [cw, ch] = L.chip, cy = b.y + b.h - ch - 11;
      if (!list.length) {
        const empty = pull ? (bob ? "built when Bob reads" : "built on read") : "empty inbox";
        g.append(ctx.text(b.x + pad, cy + ch / 2, empty, { size: fs, anchor: "start", fill: "var(--viz-muted)" }));
      }
      list.slice(0, bob ? 8 : 4).forEach((c, i) => g.append(chip(b.x + pad + i * (cw + 4), cy, c)));
      return g;
    }

    // Solid chip = stored in the inbox; soft dashed chip = fetched and merged at read time.
    function chip(x, y, c) {
      const t = tint(c.a), [w, hh] = L.chip;
      return s("rect", { x, y, width: w, height: hh, rx: 3, fill: col(t, c.merged),
        stroke: c.merged ? col(t) : "none", "stroke-width": 1.4, "stroke-dasharray": c.merged ? "3 2" : null });
    }

    // ---------------------------------------------------------------- calculator
    function drawChart() {
      const g = v.chart, W = L.W, fs = L.fs, CH = compact ? 200 : 170;
      const x0 = compact ? 52 : 70, x1 = W - 18, top = 4, bot = CH - 26;
      const X = n => x0 + ((Math.log10(Math.max(n, 1e3)) - 3) / 5) * (x1 - x0);
      const rowH = (bot - top) / 3, bh = compact ? 15 : 13;
      g.innerHTML = "";
      STRATS.forEach((st, i) => {
        const y = top + i * rowH, sel = st.value === cfg.strategy;
        if (sel) g.append(s("rect", { x: 0, y: y + 2, width: W, height: rowH - 4, rx: 6, fill: col("c6", true) }));
        g.append(ctx.text(8, y + rowH / 2, st.short, { size: compact ? fs : fs + 1, anchor: "start",
          weight: sel ? 800 : 500, fill: sel ? "var(--viz-ink)" : "var(--viz-muted)" }));
      });
      [1e3, 1e4, 1e5, 1e6, 1e7, 1e8].forEach(t => g.append(
        s("line", { x1: X(t), x2: X(t), y1: top, y2: bot, stroke: "var(--viz-grid)", "stroke-width": 1 }),
        ctx.text(X(t), CH - 12, fmt(t), { size: fs, fill: "var(--viz-muted)" })));
      STRATS.forEach((st, i) => {
        const cy = top + i * rowH + rowH / 2, wk = work(st.value);
        g.append(hbar(X, x0, cy - bh - 2, bh, wk.w, "c1", wk.bound), hbar(X, x0, cy + 2, bh, wk.r, "c2"));
      });
    }

    function hbar(X, x0, y, bh, val, c, bound) {
      const xe = X(val), label = (bound ? "≤ " : "") + fmt(val);
      const inside = xe + 6 + label.length * L.fs * 0.68 > L.W - 2;
      return s("g", null,
        s("rect", { x: x0, y, width: Math.max(2, xe - x0), height: bh, rx: 3, fill: bound ? "none" : col(c, true),
          stroke: col(c), "stroke-width": 1.4, "stroke-dasharray": bound ? "5 3" : null }),
        ctx.text(inside ? xe - 6 : xe + 6, y + bh / 2, label, { size: L.fs, anchor: inside ? "end" : "start", weight: 700 }));
    }

    function updateStats() {
      const strat = cfg.strategy, wk = work(strat), d = cfg.M / CAP;
      const tones = { pull: ["ok", "bad"], push: ["warn", "ok"], hybrid: ["info", "info"] }[strat];
      v.stats.set("w", (wk.bound ? "≤ " : "") + fmt(wk.w), tones[0]);
      v.stats.set("r", fmt(wk.r), tones[1]);
      v.stats.set("ratio", ratio() + " : 1", "info");
      if (strat === "push") {
        v.stats.set("celeb", `${fmt(cfg.M)}<span style="font-size:13px;font-weight:600"> writes ≈ ${secs(d)}</span>`, d > GOAL ? "bad" : "warn");
      } else v.stats.set("celeb", "1 write", "ok");
    }

    // ---------------------------------------------------------------- notes
    function msg(kind) {
      const { T, F, R, M } = cfg, d = M / CAP;
      const pushOps = T * F + R, pullOps = T + R * FOLLOWS;
      switch (kind) {
        case "pull": return ["Twitter's first design: a tweet is one row in a global table, and every timeline read queries everyone you follow and merges the results. Press <b>Bob opens timeline</b> to see the read cost.", "info"];
        case "push": return ["Push (Twitter's second design): every user has a cached home timeline, like a mailbox, and posting copies the tweet into each follower's inbox. Press <b>Alice tweets</b>, then <b>Celebrity tweets</b>.", "info"];
        case "hybrid": return ["Hybrid (where Twitter was heading in 2012): ordinary accounts are pushed, but accounts with huge followings skip fan-out and are merged in at read time. Try <b>Celebrity tweets</b>, then <b>Bob opens timeline</b>.", "info"];
        case "pull-alice": return [`Pull: Alice's tweet is one new row in the tweets table and no timeline is touched. At Twitter scale that is only <b>${fmt(T)}</b> writes/s; the work waits until someone reads.`, "info"];
        case "pull-celeb": return [`Even a <b>${fmt(M)}</b>-follower account's tweet is one write here: pull has no celebrity problem. It pays on every read instead.`, "ok"];
        case "pull-read": return [`One timeline read = <b>${FOLLOWS} lookups</b> (one per followed account) and a merge. At <b>${fmt(R)}</b> reads/s that is about <b>${fmt(R * FOLLOWS)} lookups/s</b>, the load Twitter's first design struggled to keep up with.`, "bad"];
        case "push-alice": return [`Push: Alice's tweet is copied into all 75 followers' cached timelines. At Twitter scale, <b>${fmt(T)}</b> tweets/s × <b>${F}</b> followers = <b>${fmt(T * F)}</b> inbox writes/s. More writes, but…`, "warn"];
        case "push-read": return pushOps <= pullOps
          ? [`…a read is now a single cache lookup. Reads outnumber tweets about <b>${ratio()} to 1</b>, so doing the work at write time is the better deal for most accounts (roughly ${fmt(pushOps)} vs ${fmt(pullOps)} operations/s in total).`, "ok"]
          : [`…a read is a single cache lookup, but with these settings reads outnumber tweets only <b>${ratio()} to 1</b> and push does more total work than pull (roughly ${fmt(pushOps)} vs ${fmt(pullOps)} operations/s). The load parameters decide.`, "warn"];
        case "push-flood": return [`The celebrity's post is stored and returns at once, but the fan-out workers now have to write it into <b>${M.toLocaleString("en-US")}</b> inboxes. Watch the bar against the 5 s tick…`, "warn"];
        case "push-celeb": return d > GOAL
          ? [`One tweet, <b>${M.toLocaleString("en-US")}</b> inbox writes. The post returns at once (fan-out runs in the background), but at the assumed 1M writes/s the last follower gets it after <b>${secs(d)}</b>, far past Twitter's 5-second delivery goal, and the backlog delays everyone else's fan-out too.`, "bad"]
          : [`One tweet, <b>${M.toLocaleString("en-US")}</b> inbox writes: about ${secs(d)} at the assumed rate, inside the 5 s goal, but still a burst that queues ahead of everyone else's deliveries. Try a bigger account.`, "warn"];
        case "hybrid-alice": return ["Hybrid: ordinary accounts like Alice are still fanned out on write (75 inbox inserts), so most of a reader's timeline is precomputed.", "info"];
        case "hybrid-celeb": return ["Hybrid: accounts with huge followings skip fan-out. The celebrity's tweet is <b>one write</b> to the tweets table: no flood, no backlog.", "ok"];
        case "hybrid-read": return [`Bob's cached timeline plus a lookup for each of the <b>${CELEBS} celebrities</b> he follows (assumed), merged at read time: <b>${fmt(R * (1 + CELEBS))}</b> operations/s at ${fmt(R)} reads/s. Push for the many, pull for the few: the design follows the follower distribution.`, "ok"];
        case "T": case "F": return [`Fan-out turns <b>${fmt(T)}</b> tweets/s × <b>${F}</b> followers into <b>${fmt(T * F)}</b> inbox writes/s. Under push, the follower distribution, not the tweet rate, sets the write cost.`, "info"];
        case "R": return [`Reads outnumber tweets <b>${ratio()} : 1</b>. Pull turns every read into ${FOLLOWS} lookups (<b>${fmt(R * FOLLOWS)}</b>/s); push serves each read from a cache (<b>${fmt(R)}</b>/s).`, "info"];
        default: return [`Biggest account: <b>${fmt(M)}</b> followers. Under push one of their tweets is ${fmt(M)} inbox writes, about <b>${secs(d)}</b> at the assumed 1M writes/s (goal: 5 s). The hybrid skips it.`, d > GOAL ? "warn" : "info"];
      }
    }
    function say(kind) { note = msg(kind); v.note.set(note[0], note[1]); }

    // ---------------------------------------------------------------- actions
    const fly = (from, to, c, o = {}) =>
      ctx.fly(v.packets, { from, to, fill: col(c), ms: o.ms || 600, r: L.pr, label: o.label, labelSize: L.fs });

    function addChip(name, t) {
      const c = { a: t.a, id: t.id, merged: false };
      scene.inbox[name] = [c, ...scene.inbox[name]].slice(0, 8);
      if (name === "bob" && scene.view) scene.view = [c, ...scene.view].slice(0, 8);
    }

    function setBusy(on) {
      busy = on;
      v.btns.forEach(b => b.disable(on));
      v.mSeg.querySelectorAll("button").forEach(b => { b.disabled = on; });
    }

    // Runs one animated action; a strategy switch or relayout bumps `token`, which aborts it.
    async function act(fn, tweetAction) {
      if (busy) return;
      const my = ++token, ok = () => ctx.alive && my === token;
      setBusy(true);
      scene.badge = {}; scene.fan = null; scene.tableNote = null;
      if (tweetAction) scene.flood = null;
      draw();
      try { await fn(ok); } finally { if (ok()) setBusy(false); }
    }

    async function tweet(who, ok) {
      const t = { a: who, id: ++scene.seq }, strat = cfg.strategy;
      const toTable = strat === "pull" || (strat === "hybrid" && who === "celeb");
      const end = endPt(who, toTable ? "table" : "fan");
      await fly(startPt(who, end), end, tint(who));
      if (!ok()) return;
      if (toTable) {
        scene.table.push(t);
        scene.tableNote = { text: "+1 row", tone: "ok" };
        if (strat === "hybrid") scene.fan = { text: "celebrity: skip fan-out", tone: "ok" };
        draw();
        say(`${strat}-${who}`);
        await ctx.sleep(700);
        if (ok()) { scene.tableNote = null; draw(); }
      } else if (who === "alice") {
        scene.fan = { text: "+75 inbox writes", tone: "warn" };
        draw();
        await fanOut(t, ok);
        if (ok()) say(`${strat}-alice`);
      } else {
        await flood(t, ok);
        if (ok()) say("push-celeb");
      }
    }

    async function fanOut(t, ok) {
      await Promise.all(L.boxes.map(async (b, i) => {
        await ctx.sleep(i * 60);
        if (!ok()) return;
        await fly(fanOutPt(), chipPt(b), "c5", { ms: 500 });
        if (ok()) { addChip(b.id, t); draw(); }
      }));
      if (!ok()) return;
      Object.keys(NAMES).filter(n => !L.boxes.some(b => b.id === n)).forEach(n => addChip(n, t));
    }

    // Push + celebrity: the progress bar fills in simulated time while drawn followers get their copy.
    async function flood(t, ok) {
      const M = cfg.M, d = M / CAP, full = Math.max(d, 6), landed = [], fired = new Set();
      scene.flood = { k: 0, M };
      scene.fan = { text: `writing ${fmt(M)} inboxes`, tone: "warn" };
      draw();
      say("push-flood");
      await ctx.tween({ ms: (2500 * d) / full, ease: "linear", onUpdate: k => {
        if (!ok()) return;
        scene.flood.k = k;
        Object.keys(NAMES).forEach(n => {
          if (fired.has(n) || k < ARRIVE[n]) return;
          fired.add(n);
          const at = ARRIVE[n] * d, b = L.boxes.find(x => x.id === n);
          const land = () => {
            if (!ok()) return;
            addChip(n, t);
            scene.badge[n] = { text: "+" + secs(at), tone: at > GOAL ? "bad" : "ok" };
            draw();
          };
          landed.push(b ? fly(fanOutPt(), chipPt(b), "c3", { ms: 450 }).then(land) : Promise.resolve().then(land));
        });
        draw();
      } });
      await Promise.all(landed);
      if (!ok()) return;
      scene.fan = { text: `${fmt(M)} inbox writes`, tone: d > GOAL ? "bad" : "warn" };
      draw();
    }

    async function read(ok) {
      const strat = cfg.strategy;
      if (strat !== "pull") {
        const r = v.bobRect;
        await ctx.tween({ ms: 600, onUpdate: k => r.setAttribute("stroke-width", 2.5 + 4 * Math.sin(Math.PI * k)) });
        if (!ok()) return;
        scene.badge.bob = { text: "1 read", tone: "ok" };
        draw();
        if (strat === "push") return say("push-read");
      }
      const pull = strat === "pull", n = pull ? (L.phone ? 4 : 6) : CELEBS, from = bobGate(), to = tableGate();
      const counting = k => (pull ? `${Math.round(k * FOLLOWS)} lookups…` : `1 read + ${Math.round(k * CELEBS)} lookups`);
      await Promise.all([
        ...Array.from({ length: n }, async (_, i) => { await ctx.sleep(i * 80); if (ok()) await fly(from, to, "c6", { ms: 550 }); }),
        ctx.tween({ ms: 550 + (n - 1) * 80, ease: "linear", onUpdate: k => {
          if (ok()) { scene.badge.bob = { text: counting(k), tone: "warn" }; draw(); }
        } }),
      ]);
      if (!ok()) return;
      await fly(to, from, "c6", { ms: 550, label: "merge" });
      if (!ok()) return;
      const fetched = scene.table.filter(t => pull || t.a === "celeb").map(t => ({ a: t.a, id: t.id, merged: true }));
      scene.view = [...(pull ? [] : scene.inbox.bob), ...fetched].sort((x, y) => y.id - x.id).slice(0, 8);
      scene.badge.bob = pull ? { text: "75 lookups + merge", tone: "bad" } : { text: "1 read + 3 lookups", tone: "ok" };
      draw();
      say(`${strat}-read`);
    }

    function setStrategy(value) {
      cfg.strategy = value;
      token++;
      scene = freshScene();
      v.packets.innerHTML = "";
      setBusy(false);
      say(value);
      draw(); drawChart(); updateStats();
    }

    function onParam(key) {
      if (key === "M" && !busy) { scene.flood = null; draw(); }
      updateStats(); drawChart(); say(key);
    }

    // ---------------------------------------------------------------- build
    function build() {
      root.innerHTML = "";
      compact = ctx.compact;
      L = layout(compact);
      token++; busy = false;
      scene.fan = null; scene.tableNote = null;
      if (scene.flood && scene.flood.k < 1) scene.flood = null;

      const stratSeg = ui.segmented({ label: "Strategy", value: cfg.strategy, onChange: setStrategy,
        options: STRATS.map(x => ({ value: x.value, label: compact ? x.short : x.label })) });
      const btns = [
        ui.button("Alice tweets", () => act(ok => tweet("alice", ok), true), { kind: "primary" }),
        ui.button("Celebrity tweets", () => act(ok => tweet("celeb", ok), true), { kind: "primary" }),
        ui.button("Bob opens timeline", () => act(read)),
      ];
      const svg = ctx.svg({ w: L.W, h: L.H, label: "Authors, fan-out workers, tweets table and followers' home timelines" });
      const sceneG = s("g"), packets = s("g");
      svg.append(sceneG, packets);

      const sliders = [
        ui.slider({ label: "Tweets / s", min: 1000, max: 20000, step: 100, value: cfg.T, format: fmt, onInput: x => { cfg.T = x; onParam("T"); } }),
        ui.slider({ label: "Avg followers per tweet", min: 10, max: 500, step: 5, value: cfg.F, onInput: x => { cfg.F = x; onParam("F"); } }),
        ui.slider({ label: "Timeline reads / s", min: 50000, max: 1000000, step: 10000, value: cfg.R, format: fmt, onInput: x => { cfg.R = x; onParam("R"); } }),
      ];
      const mSeg = ui.segmented({ label: "Biggest account", value: cfg.M, onChange: x => { cfg.M = x; onParam("M"); },
        options: [1e6, 1e7, 3e7, 1e8].map(x => ({ value: x, label: fmt(x) })) });
      const chart = ctx.svg({ w: L.W, h: compact ? 200 : 170, label: "Write and read work per second for each strategy, log scale" });
      const chartG = s("g");
      chart.append(chartG);

      note = note || msg(cfg.strategy);
      v = {
        svg, scene: sceneG, packets, chart: chartG, btns, mSeg, note: ui.note(note[0], note[1]),
        stats: ui.stats([
          { key: "w", label: "Write work / s" }, { key: "r", label: "Read work / s" },
          { key: "ratio", label: "Reads per tweet" }, { key: "celeb", label: "Celebrity tweet" },
        ]),
      };
      root.append(
        ui.bar(stratSeg), ui.bar(...btns), svg,
        ui.legend([
          { color: col("c5"), label: "Alice's tweet", shape: "square" },
          { color: col("c3"), label: "celebrity's tweet", shape: "square" },
          { color: "var(--viz-muted)", label: "dashed: fetched and merged at read time", shape: "dash" },
        ]),
        v.note,
        h("div", { class: "viz-panel-title", style: "margin:18px 0 0;padding-top:12px;border-top:1px dashed var(--border)" },
          "At Twitter scale: work per second"),
        v.stats, ui.bar(...sliders, mSeg), chart,
        ui.legend([
          { color: col("c1"), label: "writes / s", shape: "square" },
          { color: col("c2"), label: "read work / s (lookups or inbox reads)", shape: "square" },
          { color: col("c1"), label: "upper bound", shape: "dash" },
        ]),
        h("div", { style: "font-size:12.5px;line-height:1.5;color:var(--viz-muted)" },
          "Defaults are Twitter's November 2012 figures (log scale above). Assumed, not Twitter figures: a reader follows 75 accounts, 3 of them celebrities; the fan-out cluster delivers 1M inbox writes/s; celebrity = 1M+ followers."));
      draw(); drawChart(); updateStats();
    }

    build();
    // Rebuild with the other layout when the frame crosses the phone breakpoint.
    ctx.onResize(() => { if (ctx.compact !== compact) build(); });
  },
});
