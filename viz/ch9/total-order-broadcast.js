// Two clients race to claim the same username on three replicas. With plain broadcast each
// replica applies claims in arrival order, so replicas can diverge and both clients can be told
// yes. With total order broadcast a log leader stamps gapless sequence numbers and every replica
// delivers strictly in that order (holding back early arrivals), so all replicas reach the same
// state and the claim becomes a linearizable compare-and-set built on a log.
Viz.register("ch9/total-order-broadcast", {
  title: "Same log, same state",
  mount(root, ctx) {
    const { s, ui } = ctx;
    const NAMES = ["kim", "lee", "max", "sol", "ivy", "ren", "zoe", "ada"];
    const CLIENTS = ["Ana", "Ben"];
    const HOME = { Ana: 0, Ben: 2 };
    const PRONOUN = { Ana: "hers", Ben: "his" };
    // Fixed delays (ms) to R1, R2, R3 for the opening race, so the first frame always diverges.
    const SCRIPTED = { Ana: [300, 900, 1000], Ben: [1000, 400, 300] };
    const WIDE = {
      W: 640, H: 330, fs: 12, pad: 10,
      clients: { Ana: { x: 60, y: 12, w: 120, h: 36 }, Ben: { x: 460, y: 12, w: 120, h: 36 } },
      ansY: 64, readY: 84,
      lead: { x: 245, y: 92, w: 150, h: 44, inset: 30 },
      reps: [12, 220, 428].map(x => ({ x, w: 200 })), repY: 176, repH: 146,
      titleY: 193, lineY: 214, lineH: 18, maxLines: 4,
      titles: ["R1 · Ana's replica", "R2", "R3 · Ben's replica"],
    };
    const PHONE = {
      W: 360, H: 368, fs: 11, pad: 7,
      clients: { Ana: { x: 8, y: 8, w: 120, h: 32 }, Ben: { x: 232, y: 8, w: 120, h: 32 } },
      ansY: 56, readY: 72,
      lead: { x: 105, y: 86, w: 150, h: 36, inset: 45 },
      reps: [4, 123, 242].map(x => ({ x, w: 114 })), repY: 150, repH: 212,
      titleY: 166, lineY: 186, lineH: 17, maxLines: 5,
      titles: ["R1 (Ana)", "R2", "R3 (Ben)"],
    };
    const PLAIN_INTRO = "Plain broadcast: each client sends its claim straight to all three replicas, and each " +
      "replica keeps the first claim it receives. Press <b>Race</b>.";
    const TOB_INTRO = "Every claim now goes to the <b>log leader</b> first. It stamps the next sequence number and " +
      "broadcasts the entry, and each replica delivers entries strictly in number order. The leader stands in " +
      "for a consensus group: in a real system, a Raft or Zab leader that gets each entry onto a majority " +
      "before it is delivered. Press <b>Race</b>.";

    // Settings survive Reset and layout rebuilds; S holds everything Reset clears.
    let mode = "plain", readVia = "local", jitter = 800;
    let S = null, view = null, compact = ctx.compact;

    function fresh() {
      return {
        rng: ctx.random(9), nameIdx: 0, nextSeq: 1, log: [], races: [], race: null,
        reps: [0, 1, 2].map(() => ({ map: {}, lines: [], held: new Map(), next: 1 })),
        heldBack: 0, read: null, readBusy: false, note: ["", ""],
        clock: 0, queue: [], k: 0, fast: false, pumping: false,
      };
    }
    const current = () => (S.race ? S.race.name : NAMES[Math.min(S.nameIdx, NAMES.length - 1)]);
    const delay = () => Math.round(300 + S.rng() * jitter);
    const racing = () => !!(S.race && S.race.pending > 0);
    const disagrees = name => new Set(S.reps.map(r => r.map[name]).filter(Boolean)).size > 1;
    const tag = (who, name) => (compact ? who : `${who} @${name}`); // packet label; short on phones
    const and = list => (list.length > 1 ? list.slice(0, -1).join(", ") + " and " + list[list.length - 1] : list[0]);

    // ---- Discrete-event scheduler. Effects run in virtual-time order, so outcomes depend only
    // on the drawn delays (deterministic per seed), never on how animation frames land.
    function at(ms, fn) {
      S.queue.push({ t: S.clock + ms, k: S.k++, fn });
      S.queue.sort((a, b) => a.t - b.t || a.k - b.k);
      if (!S.fast) pump();
    }
    async function pump() {
      const my = S;
      if (my.pumping) return;
      my.pumping = true;
      while (my === S && ctx.alive && my.queue.length) {
        const ev = my.queue[0];
        if (ev.t > my.clock && !ctx.instant) {
          const t0 = performance.now();
          await ctx.sleep(Math.min(40, ev.t - my.clock));
          my.clock = Math.min(ev.t, my.clock + Math.max(1, performance.now() - t0));
          continue;
        }
        my.clock = ev.t;
        my.queue.shift();
        ev.fn();
      }
      my.pumping = false;
    }
    function drain() {
      while (S.queue.length) { const ev = S.queue.shift(); S.clock = ev.t; ev.fn(); }
    }
    // Sequenced packets (c1) carry their number inside the dot, so a burst of three leaving the
    // leader doesn't stack three labels on top of its box.
    function send(from, to, label, color, ms, fn) {
      if (!S.fast && view) {
        const inside = color === "c1";
        ctx.fly(view.packets, {
          from: port(from, to), to: port(to, from), ms, ease: "linear", r: inside ? (compact ? 9 : 10) : 7,
          label: inside ? undefined : label, labelSize: view.L.fs, fill: `var(--viz-${color})`,
        });
        if (inside) view.packets.lastChild.appendChild(ctx.text(0, 0.5, label, { size: view.L.fs, weight: 800, fill: "var(--viz-bg)" }));
      }
      at(ms, fn);
    }

    // ---- Protocols
    function startRace(scripted) {
      const name = NAMES[S.nameIdx++];
      const race = { name, t0: S.clock, pending: 6, told: { Ana: null, Ben: null }, order: [], hold: null, readNote: null };
      S.races.push(race);
      S.race = race;
      S.read = null;
      CLIENTS.forEach((who, j) => at(j * 50, () => (mode === "plain" ? plainSend(who, race, scripted) : tobSend(who, race))));
      say(mode === "plain"
        ? `Ana and Ben both claim <b>@${name}</b>, sending straight to all three replicas. Each replica keeps whichever claim reaches it first.`
        : `Both claims for <b>@${name}</b> go to the log leader first. It numbers them in arrival order and broadcasts the numbered entries to every replica.`, "info");
      render();
    }
    function plainSend(who, race, scripted) {
      [0, 1, 2].forEach(i => {
        const ms = scripted ? SCRIPTED[who][i] : delay();
        send(who, i, tag(who, race.name), "c6", ms, () => { plainApply(i, who, race); render(); });
      });
    }
    function plainApply(i, who, race) {
      const rep = S.reps[i], ok = !rep.map[race.name];
      if (ok) rep.map[race.name] = who;
      rep.lines.push({ who, name: race.name, ok, t: Math.round(S.clock - race.t0) });
      if (HOME[who] === i) race.told[who] = ok; // answer = home replica's decision on arrival
      settle(race);
    }
    function tobSend(who, race) {
      send(who, "lead", tag(who, race.name), "c6", delay(), () => sequence({ kind: "claim", who, name: race.name, race }));
    }
    function sequence(msg) {
      msg.seq = S.nextSeq++;
      S.log.push(msg);
      if (msg.race) msg.race.order.push(msg);
      [0, 1, 2].forEach(i => send("lead", i, String(msg.seq), "c1", delay(), () => receive(i, msg)));
      render();
    }
    function receive(i, msg) {
      const rep = S.reps[i];
      if (msg.seq !== rep.next) {
        rep.held.set(msg.seq, msg);
        S.heldBack++;
        const race = msg.race || (racing() ? S.race : null);
        if (race && !race.hold) {
          race.hold = { i, seq: msg.seq, need: rep.next };
          say(`R${i + 1} received #${msg.seq} before #${rep.next}, so it holds #${msg.seq} back until #${rep.next} arrives: delivery never skips a number.`, "info");
        }
      } else {
        deliver(i, msg);
        while (rep.held.has(rep.next)) {
          const m = rep.held.get(rep.next);
          rep.held.delete(m.seq);
          deliver(i, m);
        }
      }
      render();
    }
    function deliver(i, msg) {
      const rep = S.reps[i];
      rep.next++;
      if (msg.kind === "read") {
        rep.lines.push({ seq: msg.seq, read: true, name: msg.name });
        if (i === 2) answerLogRead(msg);
        return;
      }
      const ok = !rep.map[msg.name];
      if (ok) rep.map[msg.name] = msg.who;
      rep.lines.push({ seq: msg.seq, who: msg.who, name: msg.name, ok });
      // Compare-and-set on a log: once my own claim is delivered at home, I won iff it was first.
      if (HOME[msg.who] === i) msg.race.told[msg.who] = rep.map[msg.name] === msg.who;
      settle(msg.race);
    }
    function settle(race) {
      if (--race.pending === 0) finishRace(race);
    }

    function finishRace(race) {
      const { name, told } = race;
      let html, tone;
      if (mode === "tob") {
        const [a, b] = race.order, winner = S.reps[0].map[name];
        html = `The leader fixed one order (#${a.seq} ${a.who}, #${b.seq} ${b.who}). Every replica applies the log in that order, ` +
          `so all agree <b>@${name}</b> belongs to ${winner}, and only ${winner} was told yes.`;
        tone = "ok";
        const h = race.hold;
        if (h) {
          html += ` R${h.i + 1} received #${h.seq} before #${h.need}, so it held #${h.seq} back. Delivery never skips a number, ` +
            "so once an entry is delivered its place in the order is final; Lamport timestamps can't promise that.";
        }
      } else if (disagrees(name)) {
        const answers = told.Ana === told.Ben ? `, and both clients were told ${told.Ana ? "yes" : "no"}` : "";
        html = `Same two messages, different arrival orders: ${ownersSentence(name)}${answers}. ` +
          "Without an agreed order, replicas diverge. Switch <b>Delivery</b> to <b>Total order broadcast</b> and race again.";
        tone = "bad";
      } else if (jitter === 0) {
        html = "With no jitter, Ana's claim (sent 50 ms earlier) reaches every replica first, so they agree. " +
          "Real networks have jitter: raise it and race again.";
        tone = "info";
      } else {
        html = "This time every replica happened to see the same claim first. Nothing guarantees it: raise the jitter and race again.";
        tone = "info";
      }
      if (race.readNote) {
        const rank = { info: 0, ok: 1, warn: 2, bad: 3 };
        html += " " + race.readNote[0];
        if (rank[race.readNote[1]] > rank[tone]) tone = race.readNote[1];
      }
      S.note = [html, tone];
    }
    function ownersSentence(name) {
      const groups = {};
      S.reps.forEach((r, i) => (groups[r.map[name]] = groups[r.map[name]] || []).push("R" + (i + 1)));
      return Object.keys(groups).map((who, j) => {
        const rs = groups[who], verb = rs.length > 1 ? "say" : "says";
        return `${and(rs)} ${verb} ${j === 0 ? "@" + name + " is" : "it's"} ${who}'s`;
      }).join(", ");
    }

    // ---- Reads by Ben
    function check() {
      const name = current();
      if (mode === "tob" && readVia === "log") {
        S.readBusy = true;
        S.read = { name, via: "log", wait: true, tone: "warn" };
        send("Ben", "lead", compact ? "read" : `read @${name}`, "c6", delay(), () => sequence({ kind: "read", name }));
        say(`Ben's read of <b>@${name}</b> is heading to the log leader. R3 answers only when that read marker comes back through the log.`, "info");
      } else {
        localRead(name);
      }
      render();
    }
    // What R3 hasn't applied yet that it should have: a logged claim (TOB) or another replica's decision (plain).
    function behindR3(name) {
      const r3 = S.reps[2];
      if (r3.map[name]) return "";
      if (mode === "tob") {
        const seqs = S.log.filter(m => m.kind === "claim" && m.name === name && m.seq >= r3.next).map(m => "#" + m.seq);
        return seqs.length ? `${and(seqs)} ${seqs.length > 1 ? "aren't" : "isn't"} applied at R3 yet` : "";
      }
      const i = S.reps.findIndex(r => r.map[name]);
      return i < 0 ? "" : `R${i + 1} already has ${S.reps[i].map[name]}'s claim`;
    }
    function localRead(name) {
      const owner = S.reps[2].map[name] || null, behind = behindR3(name);
      const race = S.races.find(r => r.name === name);
      const yes = race && CLIENTS.find(c => race.told[c]);
      if (behind) {
        const tone = yes ? "bad" : "warn";
        S.read = { name, via: "local", owner, tone, stale: true };
        say(yes
          ? `R3 answered from its local copy that <b>@${name}</b> is free, but ${yes} was already told it's ${PRONOUN[yes]} (${behind}). Fast, but not linearizable.`
          : `R3 answered from its local copy while a claim was still in flight (${behind}): fast, but not linearizable.`, tone, true);
        return;
      }
      const other = mode === "plain" && owner ? S.reps.findIndex(r => r.map[name] && r.map[name] !== owner) : -1;
      S.read = { name, via: "local", owner, tone: other >= 0 ? "bad" : "ink" };
      if (other >= 0) {
        say(`R3 says <b>@${name}</b> is ${owner}'s, but R${other + 1} says it's ${S.reps[other].map[name]}'s: without an agreed order, the answer depends on which replica you ask.`, "bad", true);
      } else if (!owner && racing() && S.race.name === name) {
        const none = mode === "tob" ? "the leader hadn't numbered either claim yet" : "no replica had received a claim yet";
        say(`R3 answered from its local copy at once. That's still a valid answer: ${none}. Check again a moment later, once ${mode === "tob" ? "the claims are in the log" : "another replica has decided"} but before R3 catches up.`, "info", true);
      } else {
        say("R3 answered from its local copy straight away. This time it wasn't behind, but nothing guarantees that: try it while a race is in flight.", "info", true);
      }
    }
    function answerLogRead(msg) {
      S.readBusy = false;
      S.read = { name: msg.name, via: "log", owner: S.reps[2].map[msg.name] || null, tone: "ok" };
      say(`Ben's read went through the log as #${msg.seq}, so R3 answered only after applying every earlier entry: ` +
        "linearizable, at the cost of a trip through the leader.", "ok", true);
    }
    // Read results are also attached to a running race so its final note keeps them.
    function say(html, tone, attach) {
      S.note = [html, tone];
      if (attach && racing()) S.race.readNote = [html, tone];
    }

    function reset() {
      if (view) view.packets.innerHTML = "";
      S = fresh();
      say(mode === "tob" ? TOB_INTRO : PLAIN_INTRO, "info");
      render();
    }

    // ---- Drawing
    function port(a, b) {
      const L = view.L, ld = L.lead;
      if (a === "lead") {
        if (b === "Ana" || b === "Ben") return [ld.x + (b === "Ana" ? ld.inset : ld.w - ld.inset), ld.y];
        return [ld.x + ld.w / 2, ld.y + ld.h];
      }
      if (typeof a === "number") return [L.reps[a].x + L.reps[a].w / 2, L.repY];
      const c = L.clients[a];
      if (b === "lead") return [a === "Ana" ? c.x + c.w : c.x, c.y + c.h / 2];
      return [c.x + c.w / 2, L.readY + 10];
    }
    const txt = (g, x, y, str, o) => g.appendChild(ctx.text(x, y, str, { size: view.L.fs, ...o }));

    function drawLeader(L, g) {
      const ld = L.lead, cx = ld.x + ld.w / 2, cy = ld.y + ld.h / 2, tob = mode === "tob";
      const edge = (a, b, dashed) => {
        const [x1, y1] = port(a, b), [x2, y2] = port(b, a);
        g.appendChild(ctx.arrow({ x1, y1, x2, y2, color: "var(--viz-line)", width: 1.4, dashed, svg: view.svg }));
      };
      // Plain: every client talks to every replica. TOB: everything funnels through the leader.
      if (tob) { CLIENTS.forEach(c => edge(c, "lead")); [0, 1, 2].forEach(i => edge("lead", i)); }
      else CLIENTS.forEach(c => [0, 1, 2].forEach(i => edge(c, i, true)));
      g.appendChild(s("rect", { x: ld.x, y: ld.y, width: ld.w, height: ld.h, rx: 8, fill: "var(--viz-bg)" }));
      g.appendChild(s("rect", {
        x: ld.x, y: ld.y, width: ld.w, height: ld.h, rx: 8, "stroke-width": 1.5,
        fill: tob ? "var(--viz-c1-soft)" : "none", stroke: tob ? "var(--viz-c1)" : "var(--viz-muted)", "stroke-dasharray": tob ? null : "5 4",
      }));
      const [main, sub] = tob ? ["Log leader", `consensus · next #${S.nextSeq}`] : ["no ordering", "first arrival wins"];
      txt(g, cx, cy - 8, main, { size: L.fs + 1, weight: 700, fill: tob ? null : "var(--viz-muted)" });
      txt(g, cx, cy + 9, sub, { fill: "var(--viz-muted)" }); // proportional: "consensus · next #17" fits the box
      if (tob && !compact) {
        ["stand-in for a consensus", "group (Raft, Zab)"].forEach((t, j) => txt(g, ld.x - 12, cy - 8 + j * 16, t, { anchor: "end", fill: "var(--viz-muted)" }));
      }
    }

    function drawClient(L, g, who) {
      const c = L.clients[who], cx = c.x + c.w / 2;
      g.appendChild(ctx.box({ x: c.x, y: c.y, w: c.w, h: c.h, label: "Client " + who, size: L.fs + 2, fill: "var(--viz-c6-soft)", stroke: "var(--viz-c6)" }));
      if (S.race) {
        const t = S.race.told[who], n = "@" + S.race.name;
        const [str, tone] = t === true ? [`✓ ${n} is yours`, "ok"] : t === false ? [`✗ ${n} taken`, "bad"] : ["waiting…", "warn"];
        txt(g, cx, L.ansY, str, { weight: 700, fill: `var(--viz-${tone})` });
      }
      const rd = S.read;
      if (who !== "Ben" || !rd) return;
      const val = rd.wait ? "waiting…" : compact ? (rd.owner ? rd.owner + "'s" : "free") : `@${rd.name} is ${rd.owner ? rd.owner + "'s" : "free"}`;
      const label = `${rd.via}${compact ? "" : " read"}: ${val}${rd.stale ? " (stale)" : ""}`;
      txt(g, cx, L.readY, label, { weight: 600, fill: `var(--viz-${rd.tone})` });
    }

    function logLine(x, y, ln, name) {
      const t = ctx.text(x, y, "", { size: view.L.fs, anchor: "start", mono: true });
      if (ln.name !== name) t.setAttribute("opacity", 0.5);
      const add = (str, fill, w) => t.appendChild(s("tspan", { fill, "font-weight": w }, str));
      if (ln.seq) add(`#${ln.seq} `, "var(--viz-muted)");
      if (ln.read) {
        add(`read @${ln.name}`, "var(--viz-info)");
      } else {
        add(ln.ok ? "✓" : "✗", ln.ok ? "var(--viz-ok)" : "var(--viz-bad)", 700);
        add(`${compact ? "" : " "}${ln.who} @${ln.name}`, "var(--viz-ink)");
      }
      return t;
    }

    function drawReplica(L, g, i) {
      const rep = S.reps[i], r = L.reps[i], x = r.x + L.pad, bot = L.repY + L.repH;
      const name = current(), own = rep.map[name], split = !!own && disagrees(name);
      g.appendChild(s("rect", {
        x: r.x, y: L.repY, width: r.w, height: L.repH, rx: 8, "stroke-width": 1.5,
        fill: "var(--viz-panel)", stroke: rep.held.size ? "var(--viz-warn)" : "var(--viz-c2)",
      }));
      txt(g, x, L.titleY, L.titles[i], { anchor: "start", weight: 700 });
      const shown = rep.lines.slice(-L.maxLines);
      shown.forEach((ln, j) => {
        const y = L.lineY + j * L.lineH;
        g.appendChild(logLine(x, y, ln, name));
        if (ln.t === undefined || compact) return;
        const t = txt(g, r.x + r.w - L.pad, y, `at ${ln.t} ms`, { anchor: "end", fill: "var(--viz-muted)" });
        if (ln.name !== name) t.setAttribute("opacity", 0.5);
      });
      if (rep.held.size) {
        const held = [...rep.held.keys()].sort((a, b) => a - b).map(n => "#" + n).join(compact ? " " : ", ");
        const rows = compact ? [`hold ${held}`, `need #${rep.next}`] : [`holding ${held} · waiting for #${rep.next}`];
        const y0 = L.lineY + shown.length * L.lineH; // right under the last delivered entry
        rows.forEach((t, j) => txt(g, x, y0 + j * L.lineH, t, { anchor: "start", weight: 700, mono: compact, fill: "var(--viz-warn)" }));
      }
      const tone = split ? "var(--viz-bad)" : own ? "var(--viz-ink)" : "var(--viz-muted)";
      const who = `${split ? "≠ " : ""}${own || "—"}`;
      const sepY = bot - (compact ? 44 : 26);
      g.appendChild(s("line", { x1: r.x + 6, x2: r.x + r.w - 6, y1: sepY, y2: sepY, stroke: "var(--viz-line)" }));
      if (compact) {
        txt(g, x, bot - 30, `owner @${name}`, { anchor: "start", fill: "var(--viz-muted)" });
        txt(g, x, bot - 13, who, { anchor: "start", weight: 700, size: L.fs + 1, fill: tone });
      } else {
        txt(g, x, bot - 12, `${split ? "≠ " : ""}owner @${name}: ${own || "—"}`, { anchor: "start", weight: 700, fill: tone });
      }
    }

    function render() {
      if (!view) return;
      const { L, scene } = view;
      scene.innerHTML = "";
      drawLeader(L, scene);
      CLIENTS.forEach(who => drawClient(L, scene, who));
      S.reps.forEach((_, i) => drawReplica(L, scene, i));
      updatePanel();
    }

    function updatePanel() {
      const { stats, note, raceBtn, checkBtn, logBtn } = view;
      const split = S.races.filter(r => disagrees(r.name)).length;
      const dbl = S.races.filter(r => r.told.Ana && r.told.Ben).length;
      stats.set("claimed", S.races.length);
      stats.set("split", split, split ? "bad" : "ok");
      stats.set("double", dbl, dbl ? "bad" : "ok");
      stats.set("held", S.heldBack, "info");
      if (note.innerHTML !== S.note[0]) note.set(S.note[0], S.note[1]);
      else note.className = "viz-note tone-" + S.note[1];
      const out = S.nameIdx >= NAMES.length;
      raceBtn.setLabel(racing() ? `Racing for @${S.race.name}…` : out ? "Out of names: Reset" : `Race: Ana and Ben claim @${NAMES[S.nameIdx]}`);
      raceBtn.disable(racing() || out);
      checkBtn.setLabel(`Ben checks @${current()}`).disable(S.readBusy);
      // ui.segmented has no per-option disable, so the log option's button is disabled directly.
      const plain = mode === "plain";
      logBtn.disabled = plain;
      logBtn.style.opacity = plain ? "0.45" : "";
      logBtn.style.cursor = plain ? "not-allowed" : "";
      logBtn.title = plain ? "Plain broadcast has no log to read through" : "";
    }

    function build() {
      root.innerHTML = "";
      compact = ctx.compact;
      const L = compact ? PHONE : WIDE;
      const svg = ctx.svg({ w: L.W, h: L.H, label: "Clients Ana and Ben race to claim a username on three replicas" });
      const scene = s("g"), packets = s("g");
      svg.append(scene, packets);
      const readSeg = ui.segmented({
        label: "Read via", value: readVia,
        options: [{ value: "local", label: "Local replica" }, { value: "log", label: "The log" }],
        onChange: v => { readVia = v; },
      });
      const modeSeg = ui.segmented({
        label: "Delivery", value: mode,
        options: [{ value: "plain", label: "Plain broadcast" }, { value: "tob", label: "Total order broadcast" }],
        onChange: v => {
          if (v === mode) return;
          mode = v;
          if (mode === "plain") { readVia = "local"; readSeg.set("local"); }
          reset();
        },
      });
      const jitterSlider = ui.slider({
        label: "Network jitter", min: 0, max: 1000, step: 50, value: jitter,
        format: v => v + " ms", onInput: v => { jitter = v; },
      });
      const raceBtn = ui.button("Race", () => { if (!racing() && S.nameIdx < NAMES.length) startRace(false); }, { kind: "primary" });
      const checkBtn = ui.button("Ben checks", () => { if (!S.readBusy) check(); });
      const resetBtn = ui.button("Reset", () => reset(), { kind: "ghost" });
      const stats = ui.stats([
        { key: "claimed", label: "Names claimed", value: 0 },
        { key: "split", label: "Replicas disagree", value: 0 },
        { key: "double", label: "Double-granted", value: 0 },
        { key: "held", label: "Held back", value: 0 },
      ]);
      const note = ui.note("");
      root.append(
        ui.bar(modeSeg, jitterSlider),
        svg,
        ui.bar(raceBtn, checkBtn, readSeg, resetBtn),
        stats,
        note,
        ui.legend([
          { color: "var(--viz-c6)", label: "client message" },
          { color: "var(--viz-c1)", label: "sequenced by the log leader" },
          { color: "var(--viz-warn)", label: "held back", shape: "square" },
          { color: "var(--viz-bad)", label: "replicas disagree", shape: "square" },
        ]),
      );
      const logBtn = readSeg.querySelectorAll(".viz-seg-btn")[1];
      view = { L, svg, scene, packets, stats, note, raceBtn, checkBtn, logBtn };
      render();
    }

    // Opening race with fixed delays, applied instantly: R1 sees Ana first, R2 and R3 see Ben first.
    S = fresh();
    S.fast = true;
    startRace(true);
    drain();
    S.fast = false;
    build();
    ctx.onResize(() => { if (ctx.compact !== compact) build(); });
  },
});
