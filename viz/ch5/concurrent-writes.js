// Concurrent writes to one key, with the book's two-client shopping cart. The server has to
// decide whether a write may replace what it stores. Last write wins never asks and drops
// acknowledged writes; a version number says what the writer had seen, so concurrent values
// survive as siblings; hand-written sibling merges get removals wrong in one direction or the
// other; an OR-Set CRDT gets both directions right.
Viz.register("ch5/concurrent-writes", {
  title: "Concurrent writes: LWW, siblings and CRDTs",
  mount(root, ctx) {
    const { s, h, ui } = ctx;
    const ITEMS = ["milk", "eggs", "flour", "ham", "bacon", "jam"];
    const MODES = [
      { value: "lww", label: "LWW" }, { value: "sib", label: "Siblings" },
      { value: "tomb", label: "Siblings + tombstones" }, { value: "or", label: "OR-Set CRDT" },
    ];
    const NAME = ["Client 1", "Client 2"];
    const STEP_MS = 1400;
    const C = n => `var(--viz-${n})`;
    // Panels are [x, y, w, h] in viewBox units; `top` = y offsets of title, status, cart label, chips.
    const DESK = { W: 640, H: 335, cli: [[10, 20, 175, 200], [455, 20, 175, 200]], srv: [230, 20, 180, 270],
      gt: [10, 298, 620, 34], cardW: 160, chipW: 74, chipRows: 4, rowH: 26, orW: 74, orCols: 2, sent: true, top: [18, 40, 60, 72],
      cp: [[137, 208], [502, 208]], sp: [320, 266] };
    const PHONE = { W: 360, H: 485, cli: [[6, 10, 170, 150], [184, 10, 170, 150]], srv: [10, 180, 340, 230],
      gt: [10, 420, 340, 60], cardW: 310, chipW: 72, chipRows: 3, rowH: 24, orW: 96, orCols: 3, sent: false, top: [16, 34, 52, 62],
      cp: [[91, 148], [269, 148]], sp: [250, 197] };

    const CART = [
      [0, "add", "milk", "Client 1 adds milk."],
      [1, "add", "eggs", "Client 2 adds eggs (it has never read the cart)."],
      [0, "add", "flour", "Client 1 adds flour."],
      [1, "add", "ham", "Client 2 adds ham."],
      [0, "add", "bacon", "Client 1 adds bacon."],
    ];
    const BOOK = [
      "Client 1 adds milk. First write, no version: server stores v1 [milk].",
      "Client 2 adds eggs. It never read the cart, so its write carries no version and overwrites nothing: v2 [eggs] is kept next to v1 [milk].",
      "Client 1 adds flour, sending [milk, flour] with version 1. v1 is overwritten; v2 [eggs] is concurrent, so it stays.",
      "Client 2 merges [milk] and [eggs], adds ham and sends version 2. v2 is overwritten; v3 [milk, flour] stays.",
      "Client 1 merges [milk, flour] and [eggs], adds bacon and sends version 3. v3 is overwritten; v4 stays. Two siblings, nothing lost.",
    ];
    const PRESETS = [
      { label: "Play: the book's cart", steps: CART, verbatim: { sib: BOOK, tomb: BOOK }, final: {
        lww: ["Last write wins kept only [milk, flour, bacon]. Eggs and ham were acknowledged and are gone.", "bad"],
        or: ["Five independent adds, five tagged elements, one state: nothing to merge by hand.", "ok"] } },
      { label: "Play: a removal comes back", setup: CART, first: 6, steps: [
        [0, "remove", "milk", "Client 1 removes milk."],
        [1, "add", "jam", "Client 2 adds jam. Its last read was at step 4, before the removal."]], final: {
        sib: ["Union of v6 and v7 brings milk back: Client 2's value still carried it.", "bad"],
        tomb: ["v6 carries a tombstone for milk, so the merge removes it: milk stays deleted.", "ok"],
        or: ["Client 1 removed the milk tag it had seen (c1.1); Client 2 only added jam, so milk stays deleted.", "ok"],
        lww: [() => `Client 2's write replaced everything: ${and(truth().lost)} lost.`, "bad"] } },
      { label: "Play: remove vs re-add", steps: [
        [0, "add", "milk", "Client 1 adds milk."],
        [0, "remove", "milk", "Client 1 removes milk: it has just bought some."],
        [1, "add", "milk", "Client 2, not yet synced, adds milk: it wants more."]], final: {
        sib: ["v2 [] and v3 [milk] are siblings; union keeps milk, which is what Client 2 wanted.", "ok"],
        tomb: ["Client 1's tombstone for milk also deletes Client 2's later, independent add: item tombstones make removals win.", "bad"],
        or: ["Client 1's remove deleted only milk·c1.1, the tag it had seen. Client 2's milk·c2.1 is a different add, so it survives: add wins.", "ok"],
        lww: ["Client 2's write arrived last, so milk is there, by luck of arrival order.", "warn"] },
        summary: "Plain siblings fail <b>a removal comes back</b>, tombstones fail <b>remove vs re-add</b>, the OR-Set passes both. " +
          "Its price is metadata: tags for every add, and remembered removals once there is more than one replica." },
    ];
    const INTRO = {
      lww: "Empty cart, LWW mode: every write replaces the stored value and the newest timestamp wins. Press <b>Play: the book's cart</b> and watch acknowledged items vanish.",
      sib: "Empty cart, Siblings mode. Press <b>Play: the book's cart</b>, then switch the mode and play it again.",
      tomb: "Empty cart, Siblings + tombstones mode: siblings as before, but a removal leaves a tombstone that the merge respects. Compare <b>a removal comes back</b> with <b>remove vs re-add</b>.",
      or: "Empty cart, OR-Set CRDT mode: every add gets a unique tag, and a remove deletes only the tags its client has seen. No version numbers needed.",
    };

    const RULE = {
      lww: "Rule: every write replaces the stored value, stamped with the next timestamp. The highest timestamp wins.",
      sib: "Rule: a write carries the version its client last read. It overwrites stored values with that version or lower; newer ones are concurrent and stay as siblings.",
      tomb: "Rule: as Siblings, but a removal also leaves a tombstone, and the merge drops any item that has a tombstone in some sibling.",
      or: "Rule: an add inserts item·tag with a fresh tag. A remove deletes exactly the tags its client saw. Nothing is overwritten.",
    };

    // ---------- state (outside build() so a phone/desktop switch keeps it) ----------
    let mode = "sib", item = "milk", busy = false, compact = ctx.compact, L, view, st, fx;
    const note = ui.note("");
    const log = ui.log({ title: "What happened", height: 100 });
    const stats = ui.stats([
      { key: "vals", label: "Stored values" }, { key: "ctr", label: "Counter / ts" },
      { key: "lost", label: "Items lost" }, { key: "back", label: "Items that came back" },
    ]);
    const legend = h("div");

    const sorted = set => ITEMS.filter(i => set.has(i));
    const bracket = set => "[" + sorted(set).join(", ") + "]";
    const and = xs => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);
    const vl = vs => and(vs.map(v => "v" + v));
    const pl = (xs, one, many) => (xs.length > 1 ? many : one);
    const sib = () => mode === "sib" || mode === "tomb";
    const assert = (ok, msg) => { if (!ok) console.error("ch5/concurrent-writes: " + msg); };

    function fresh() {
      st = { counter: 0, values: [], pairs: [], intent: new Map(),
        clients: [0, 1].map(() => ({ resp: null, tags: 0, sent: null })) };
      fx = {};
    }

    // Union of values; a tombstone anywhere hides the item everywhere (tombs only exist in tomb mode).
    function merge(values) {
      const items = new Set(), tombs = new Set();
      values.forEach(v => { v.items.forEach(i => items.add(i)); v.tombs.forEach(t => tombs.add(t)); });
      tombs.forEach(t => items.delete(t));
      return { items, tombs };
    }
    const serverView = () => (mode === "or" ? new Set(st.pairs.map(p => p.item)) : merge(st.values).items);

    // Ground truth: an item is intended if the latest add/remove of it (by anyone) was an add.
    function truth() {
      const seen = serverView(), want = [], lost = [], back = [];
      ITEMS.forEach(i => {
        const a = st.intent.get(i);
        if (a === "add") { want.push(i); if (!seen.has(i)) lost.push(i); }
        if (a === "remove" && seen.has(i)) back.push(i);
      });
      return { want, lost, back };
    }

    // ---------- protocol: client request -> server judgement -> apply -> response ----------
    function request(ci, kind, itm) {
      const c = st.clients[ci], req = { ci, kind, item: itm, read: !!c.resp };
      if (kind === "read") return req;
      if (mode === "or") {
        if (kind === "add") req.tag = `c${ci + 1}.${++c.tags}`;
        else req.tags = c.resp ? c.resp.pairs.filter(p => p.item === itm).map(p => p.tag) : [];
        return req;
      }
      const base = merge(c.resp ? c.resp.values : []);
      req.seen = base.items;
      req.items = new Set(base.items);
      req.tombs = new Set(base.tombs);
      if (kind === "add") { req.items.add(itm); req.tombs.delete(itm); }
      else { req.items.delete(itm); if (mode === "tomb") req.tombs.add(itm); }
      req.version = c.resp ? c.resp.version : null;
      return req;
    }

    // What a write will do to the stored state, computed before it is applied.
    function judge(req) {
      if (req.kind === "read") return {};
      if (mode === "or") return { doomed: req.kind === "remove" ? st.pairs.filter(p => req.tags.includes(p.tag)).map(p => p.tag) : [] };
      const old = st.values[0];
      if (mode === "lww") return { old, dropped: old ? sorted(old.items).filter(i => !req.items.has(i) && !req.seen.has(i) && i !== req.item) : [] };
      const covers = v => req.version !== null && v.version <= req.version;
      return { over: st.values.filter(covers).map(v => v.version), kept: st.values.filter(v => !covers(v)).map(v => v.version) };
    }

    function serve(req, j) {
      if (req.kind === "read") return;
      st.intent.set(req.item, req.kind);
      st.clients[req.ci].sent = req;
      if (mode === "or") {
        if (req.kind === "add") st.pairs.push({ item: req.item, tag: req.tag });
        else st.pairs = st.pairs.filter(p => !req.tags.includes(p.tag));
        return;
      }
      const v = { version: ++st.counter, items: req.items, tombs: req.tombs, by: req.ci };
      if (mode === "lww") { st.values = [v]; return; }
      const before = st.values.length;
      st.values = st.values.filter(x => !j.over.includes(x.version)).concat(v);
      // The version-number rule: no version overwrites nothing; version k overwrites exactly the values <= k.
      assert(req.version !== null || j.over.length === 0, "a write without a version overwrote a value");
      assert(st.values.every(x => x === v || req.version === null || x.version > req.version), "a value <= the write's version survived");
      assert(st.values.length === before - j.over.length + 1, "overwrote the wrong number of values");
    }

    const snapshot = () => (mode === "or" ? { pairs: st.pairs.map(p => ({ ...p })) }
      : { version: st.counter, values: st.values.map(v => ({ ...v, items: new Set(v.items), tombs: new Set(v.tombs) })) });

    function act(ci, kind, itm) {           // instant, no animation
      const req = request(ci, kind, itm), j = judge(req);
      serve(req, j);
      st.clients[ci].resp = snapshot();
      return { req, j };
    }

    function reqLabel(req) {
      if (req.kind === "read") return "read";
      let t;
      if (mode === "or") t = req.kind === "add" ? `add ${req.item}·${req.tag}` : `rm ${req.item}{${req.tags.join(",")}}`;
      else {
        const body = "[" + sorted(req.items).concat(sorted(req.tombs).map(x => "✕" + x)).join(",") + "]";
        t = mode === "lww" ? body : (req.version === null ? "no v" : "v" + req.version) + "+" + body;
      }
      return t.length > 14 ? t.slice(0, 12) + ".." : t;
    }

    async function animate(ci, kind, itm) {
      fx = {};
      const req = request(ci, kind, itm);
      render();
      await ctx.fly(view.packets, { from: L.cp[ci], to: L.sp, label: reqLabel(req), fill: C("c6"), ms: 650 });
      const j = judge(req);
      // Hold the judgement on screen: overwrite/keep tags (siblings), or the items/tags about to go.
      const pause = kind === "read" ? 0 : sib() ? 900 : (mode === "lww" ? j.dropped : j.doomed || []).length ? 600 : 0;
      if (pause) { fx = { judging: true, req, j }; render(); await ctx.sleep(pause); }
      serve(req, j);
      fx = { done: true, req, j };
      render();
      const resp = snapshot();
      const label = mode === "or" ? "state" : (mode === "lww" ? "ts " : "v") + st.counter;
      await ctx.fly(view.packets, { from: L.sp, to: L.cp[ci], label, fill: C("c2"), ms: 550 });
      st.clients[ci].resp = resp;
      render();
      return { req, j };
    }

    // One or two sentences on what the server did and why (used by free play and the presets).
    function outcome({ req, j }) {
      const who = NAME[req.ci], n = st.counter, k = req.version;
      let t, tone = "info";
      if (req.kind === "read") {
        const r = st.clients[req.ci].resp;
        if (mode === "or") t = `${who} read the whole state: ${r.pairs.length} tagged element${r.pairs.length === 1 ? "" : "s"}. Its removes now send exactly these tags.`;
        else if (mode === "lww") t = r.values.length ? `${who} read ts ${r.version}: ${bracket(r.values[0].items)}.` : `${who} read an empty cart.`;
        else {
          const vs = r.values.map(v => v.version);
          t = vs.length ? `${who} read ${vl(vs)} (counter ${r.version}). Its next write carries version ${r.version}, so it will overwrite ${pl(vs, "it", "them")}.`
            : `${who} read an empty cart (counter ${r.version}).`;
        }
        return [t, tone];
      }
      if (mode === "or") {
        const tags = ts => and(ts.map(tg => `${req.item}·${tg}`));
        if (req.kind === "add") t = `Added ${req.item}·${req.tag}; nothing to overwrite.`;
        else if (!req.read) { t = `${who} has never read the cart, so its remove carries no tags and deletes nothing.`; tone = "warn"; }
        else if (!req.tags.length) { t = `${who}'s last read had no ${req.item}, so its remove carries no tags and deletes nothing.`; tone = "warn"; }
        else {
          t = j.doomed.length ? `Removed ${tags(j.doomed)}, the ${pl(j.doomed, "tag", "tags")} ${who} had seen.`
            : `The ${pl(req.tags, "tag", "tags")} ${who} had seen ${pl(req.tags, "was", "were")} already gone.`;
          const surv = st.pairs.filter(p => p.item === req.item).map(p => p.tag);
          if (surv.length) t += ` ${tags(surv)} ${pl(surv, "was", "were")} added without ${who} seeing ${pl(surv, "it", "them")}, so ${pl(surv, "it survives", "they survive")}: add wins.`;
        }
      } else if (mode === "lww") {
        const repl = j.old && `ts ${n} replaced ${bracket(j.old.items)} with ${bracket(req.items)}`;
        if (!j.old) t = `Stored ${bracket(req.items)} with ts ${n}.`;
        else if (j.dropped.length) {
          t = `${repl}. ${who} had never seen ${and(j.dropped)}, but last write wins replaced ${pl(j.dropped, "it", "them")} anyway: ${and(j.dropped)} lost.`;
          tone = "bad";
        } else t = `${repl}; ${who} had seen everything it replaced.`;
      } else {
        if (k === null) {
          t = `${who} had never read the cart, so its write carries no version and overwrites nothing` +
            (j.kept.length ? `: ${vl(j.kept)} ${pl(j.kept, "stays as a sibling", "stay as siblings")}.` : ".");
        } else if (!j.over.length && !j.kept.length) {
          t = `The write carried version ${k}; nothing was stored yet, so the server simply stores it as v${n}.`;
        } else {
          t = j.over.length ? `The write carried version ${k}, so ${who} had seen ${vl(j.over)}: ${pl(j.over, "it is", "they are")} overwritten.`
            : `The write carried version ${k}, but every stored value is newer, so it overwrites nothing.`;
          if (j.kept.length) t += ` ${vl(j.kept)} ${pl(j.kept, "was", "were")} written after ${who}'s read, so ${pl(j.kept, "it is", "they are")} concurrent and kept.`;
        }
        if (mode === "tomb" && req.kind === "remove") t += ` The new value v${n} carries a tombstone for ${req.item}.`;
      }
      const { lost, back } = truth(), extra = lost.filter(i => !(j.dropped || []).includes(i));
      const probs = (extra.length ? [`${and(extra)} lost`] : []).concat(back.length ? [`${and(back)} came back`] : []);
      if (probs.length) { t += ` Ground truth: ${probs.join("; ")}.`; tone = "bad"; }
      return [t, tone];
    }

    function say(html, tone) { note.set(html, tone); log.add(html, tone); }

    function setBusy(on) {
      busy = on;
      root.querySelectorAll(".viz-controls button, .viz-controls select").forEach(el => { el.disabled = on; });
    }

    async function freeAct(ci, kind) {
      if (busy) return;
      setBusy(true);
      const r = await animate(ci, kind, item);
      const [t, tone] = outcome(r);
      const verb = { add: "adds " + item, remove: "removes " + item, read: "reads the cart" }[kind];
      say(`<b>${NAME[ci]} ${verb}.</b> ${t}`, tone);
      setBusy(false);
    }

    async function runPreset(p) {
      if (busy) return;
      resetAll();
      setBusy(true);
      if (p.setup) {
        p.setup.forEach(([ci, kind, itm]) => act(ci, kind, itm));
        render();
        say("Steps 1–5 of the book's cart applied instantly.", "info");
        await ctx.sleep(STEP_MS);
      }
      const first = p.first || 1, verb = p.verbatim && p.verbatim[mode];
      for (let i = 0; i < p.steps.length; i++) {
        const [ci, kind, itm, title] = p.steps[i];
        if (i) await ctx.sleep(STEP_MS);
        note.set(`<b>${first + i}.</b> ${title}`, "info");
        const r = await animate(ci, kind, itm);
        const [text, tone] = verb ? [verb[i], i === verb.length - 1 ? "ok" : "info"] : outcome(r);
        say(`<b>${first + i}.</b> ${verb ? text : title + " " + text}`, tone);
      }
      const fin = p.final[mode];
      if (fin) {
        await ctx.sleep(STEP_MS);
        const text = typeof fin[0] === "function" ? fin[0]() : fin[0];
        log.add(text, fin[1]);
        if (p.summary) log.add(p.summary, "info");
        note.set(text + (p.summary ? "<br>" + p.summary : ""), fin[1]);
      }
      setBusy(false);
    }

    function resetAll() {
      fresh();
      log.clear();
      log.add(`Setup: an empty cart on one replica; server keeps: ${MODES.find(m => m.value === mode).label}`, "info");
      note.set(INTRO[mode], "info");
      legend.replaceChildren(ui.legend([
        { color: C("c6"), label: "client: its last read and cart", shape: "square" },
        { color: C("c2"), label: mode === "or" ? "database: one OR-Set state" : sib() ? "database: stored values (siblings)" : "database: one stored value", shape: "square" },
        { color: C("node-stroke"), label: "cart item", shape: "square" },
        ...(sib() ? [{ color: C("ok"), label: "overwritten: the writer had seen it" }, { color: C("warn"), label: "concurrent: kept as a sibling" }] : []),
        ...(mode === "tomb" ? [{ color: C("muted"), label: "tombstone (struck through)", shape: "line" }] : []),
        ...(mode === "or" ? [{ color: C("muted"), label: "·c1.2 = unique tag of one add", shape: "dash" }] : []),
        { color: C("bad"), label: "lost / came back" },
      ]));
      render();
    }

    // ---------- drawing ----------
    const T = (g, x, y, str, o) => g.appendChild(ctx.text(x, y, str, { anchor: "start", ...o }));
    // Conservative text width estimate (measured: sans ≈ 0.45–0.53 em per char, mono 0.60).
    const estW = (str, size, mono, bold) => str.length * size * (mono ? 0.62 : bold ? 0.56 : 0.53);

    // Words [{t, sep, fill, weight, mono, strike, br}] -> lines that fit maxW.
    function wrap(words, maxW, size) {
      const lines = [[]];
      let w = 0;
      words.forEach(wd => {
        const ww = estW(wd.t + (wd.sep || "") + " ", size, wd.mono, wd.weight >= 600);
        if (lines[lines.length - 1].length && (wd.br || w + ww > maxW)) { lines.push([]); w = 0; }
        lines[lines.length - 1].push(wd);
        w += ww;
      });
      return lines;
    }
    function drawLines(g, x, y, lines, size, lh) {
      lines.forEach((ln, i) => {
        const t = s("text", { x, y: y + i * lh, "font-size": size, "dominant-baseline": "middle", fill: C("ink") });
        ln.forEach(wd => {
          const sp = s("tspan", { fill: wd.fill, "font-weight": wd.weight, class: wd.mono ? "viz-mono" : null });
          sp.textContent = wd.t;
          if (wd.strike) sp.style.textDecoration = "line-through";
          t.append(sp, (wd.sep || "") + " ");
        });
        g.appendChild(t);
      });
      return lines.length;
    }
    const flow = (g, x, y, maxW, words, size = 11, lh = 13) => drawLines(g, x, y, wrap(words, maxW, size), size, lh);
    const phrase = (str, fill, weight = 600) => str.split(" ").map(t => ({ t, fill, weight }));

    function valueWords(v, flag = [], gone = []) {
      const ws = sorted(v.items).map(i => (gone.includes(i) ? { t: i, fill: C("bad"), strike: true, weight: 700 }
        : flag.includes(i) ? { t: i, fill: C("bad"), weight: 700 } : { t: i }));
      sorted(v.tombs).forEach(i => ws.push({ t: i, fill: C("muted"), strike: true }));
      ws.forEach((wd, k) => { if (k < ws.length - 1) wd.sep = ","; });
      return ws.length ? ws : [{ t: "(empty)", fill: C("muted") }];
    }

    function chip(g, x, y, w, c) {
      const plain = c.tomb || c.more;
      g.appendChild(s("rect", { x, y, width: w, height: 20, rx: 10, fill: plain ? "none" : C("node"),
        stroke: c.tone ? C(c.tone) : plain ? C("muted") : C("node-stroke"), "stroke-width": c.tone ? 2 : 1, "stroke-dasharray": plain ? "3 2" : null }));
      const t = s("text", { x: x + w / 2, y: y + 10.5, "font-size": 11, "text-anchor": "middle", "dominant-baseline": "middle",
        fill: plain ? C("muted") : c.red || c.tone === "bad" ? C("bad") : C("ink"), "font-weight": c.red ? 700 : null });
      const a = s("tspan");
      a.textContent = c.t;
      if (c.tomb || c.strike) a.style.textDecoration = "line-through";
      t.appendChild(a);
      if (c.tag) { const b = s("tspan", { class: "viz-mono", fill: C("muted") }); b.textContent = "·" + c.tag; t.appendChild(b); }
      g.appendChild(t);
    }
    function chipGrid(g, x, y, chips, cw, cols, maxRows, rowH, gap) {
      const max = cols * maxRows, show = chips.length > max ? chips.slice(0, max - 1) : chips.slice();
      if (show.length < chips.length) show.push({ t: `+${chips.length - show.length} more`, more: true });
      show.forEach((c, k) => chip(g, x + (k % cols) * (cw + gap), y + Math.floor(k / cols) * rowH, cw, c));
      return Math.ceil(show.length / cols) * rowH;
    }

    function drawClient(g, ci) {
      const [x, y, w, hh] = L.cli[ci], c = st.clients[ci], r = c.resp, [t1, t2, t3, t4] = L.top;
      g.appendChild(ctx.box({ x, y, w, h: hh, fill: C("c6-soft"), stroke: C("c6"), rx: 8 }));
      T(g, x + 10, y + t1, NAME[ci], { size: 13, weight: 700 });
      const n = r && mode === "or" ? r.pairs.length : 0;
      const status = !r ? "never read" : mode === "or" ? `saw ${n} tag${n === 1 ? "" : "s"}` : `last read: ${mode === "lww" ? "ts " : "v"}${r.version}`;
      T(g, x + 10, y + t2, status, { size: 12, mono: true, fill: r ? C("ink") : C("muted") });
      const sibs = r && sib() ? r.values.map(v => "v" + v.version) : [];
      T(g, x + 10, y + t3, sibs.length > 1 ? `my cart (${sibs.join(" + ")} merged):` : "my cart:", { size: 11, fill: C("muted") });
      let chips = [];
      if (r && mode === "or") chips = r.pairs.map(p => ({ t: p.item, tag: p.tag }));
      else if (r) { const m = merge(r.values); chips = sorted(m.items).map(t => ({ t })).concat(sorted(m.tombs).map(t => ({ t, tomb: true }))); }
      if (!chips.length) T(g, x + 10, y + t4 + 10, "(empty)", { size: 11, fill: C("muted") });
      chipGrid(g, x + (w - 2 * L.chipW - 6) / 2, y + t4, chips, L.chipW, 2, L.chipRows, L.rowH, 6);
      if (L.sent && c.sent) {
        const q = c.sent;
        const head = mode === "or" ? "last op sent:" : mode === "lww" ? "last write sent, no version:"
          : `last write sent: ${q.version === null ? "no version" : "version " + q.version}`;
        T(g, x + 4, y + hh + 16, head, { size: 11, fill: C("muted") });
        const words = mode !== "or" ? valueWords(q)
          : (q.kind === "add" ? `add ${q.item}·${q.tag}` : `remove ${q.item} {${q.tags.join(", ") || "no tags"}}`).split(" ").map(t => ({ t, mono: true }));
        flow(g, x + 4, y + hh + 31, w - 8, words);
      }
    }

    function card(g, x, y, w, head, tag, words, tone) {
      const rect = g.appendChild(s("rect", { x, y, width: w, height: 10, rx: 6, fill: C("panel"),
        stroke: C(tone || "c2"), "stroke-width": tone ? 2 : 1 }));
      T(g, x + 9, y + 12, head, { size: 12, weight: 700, mono: true });
      T(g, x + w - 8, y + 12, tag.t, { size: 11, anchor: "end", fill: tag.fill, weight: 600 });
      const hh = 37 + (flow(g, x + 9, y + 27, w - 18, words) - 1) * 13;
      rect.setAttribute("height", hh);
      return hh;
    }
    function valueCard(g, x, y, w, v, flag) {
      const j = fx.j || {};
      let tag = { t: `by C${v.by + 1}`, fill: C("muted") }, tone = null;
      if (sib() && j.over) {
        if (fx.judging && j.over.includes(v.version)) { tag = { t: "seen → overwrite", fill: C("ok") }; tone = "ok"; }
        else if (j.kept.includes(v.version)) { tag = { t: fx.judging ? "concurrent → keep" : "concurrent: kept", fill: C("warn") }; tone = "warn"; }
      }
      if (mode === "lww" && fx.judging) { tag = { t: "being replaced", fill: C("bad") }; tone = "bad"; }
      if (fx.done && fx.req.kind !== "read" && v.version === st.counter) { tag = { t: `new, by C${v.by + 1}`, fill: C("c2") }; tone = "c2"; }
      const gone = mode === "lww" && fx.judging ? j.dropped : [];
      return card(g, x, y, w, (mode === "lww" ? "ts " : "v") + v.version, tag, valueWords(v, flag, gone), tone);
    }
    function orCard(g, x, y, w, avail, flag) {
      const cols = L.orCols, gap = (w - cols * L.orW) / (cols + 1), q = fx.req || {}, j = fx.j || {};
      const chips = st.pairs.map(p => {
        const c = { t: p.item, tag: p.tag, red: flag.includes(p.item) };
        if (fx.judging && (j.doomed || []).includes(p.tag)) Object.assign(c, { tone: "bad", strike: true });
        else if (fx.done && q.item === p.item && (q.kind === "remove" || q.tag === p.tag)) c.tone = "ok";
        return c;
      });
      const rect = g.appendChild(s("rect", { x, y, width: w, height: 10, rx: 6, fill: C("panel"), stroke: C("c2"), "stroke-width": 1 }));
      T(g, x + 9, y + 12, "OR-Set state", { size: 12, weight: 700 });
      const maxRows = Math.max(1, Math.floor((avail - 30) / 24));
      const used = chips.length ? chipGrid(g, x + gap, y + 24, chips, L.orW, cols, maxRows, 24, gap)
        : 14 * flow(g, x + 9, y + 32, w - 18, phrase(RULE.or, C("muted"), null), 11, 14) + 4;
      const hh = 24 + Math.max(used, 20) + 4;
      rect.setAttribute("height", hh);
      return hh;
    }

    // Short verdict lines under the server's values: what the last write met and what it did.
    function verdict() {
      if (!fx.done || fx.req.kind === "read") return [];
      const j = fx.j, q = fx.req;
      if (mode === "or") {
        if (q.kind === "add") return [[`+ added ${q.item}·${q.tag}`, "ok"]];
        const surv = st.pairs.filter(p => p.item === q.item).map(p => `${p.item}·${p.tag}`);
        return [j.doomed.length ? [`✕ removed ${j.doomed.map(t => q.item + "·" + t).join(", ")}`, "muted"] : ["nothing removed", "warn"]]
          .concat(surv.length ? [[`✓ ${surv.join(", ")} ${pl(surv, "survives", "survive")}`, "ok"]] : []);
      }
      if (mode === "lww") return j.dropped.length ? [[`✕ dropped unseen ${j.dropped.join(", ")}`, "bad"]]
        : j.old ? [["✓ writer had seen it all", "ok"]] : [];
      return [j.over.length ? [`✓ overwrote ${j.over.map(v => "v" + v).join(", ")} (seen)`, "ok"] : null,
        j.kept.length ? [`≈ kept ${j.kept.map(v => "v" + v).join(", ")} (concurrent)`, "warn"] : null].filter(Boolean);
    }

    function drawServer(g) {
      const [x, y, w, hh] = L.srv, cw = L.cardW, cx = x + (w - cw) / 2;
      g.appendChild(ctx.box({ x, y, w, h: hh, fill: C("c2-soft"), stroke: C("c2"), rx: 8 }));
      T(g, x + 10, y + 18, "Database (1 replica)", { size: 13, weight: 700 });
      T(g, x + 10, y + 38, mode === "or" ? `tagged elements: ${st.pairs.length}` : `${mode === "lww" ? "ts" : "counter"}: ${st.counter}`, { size: 12, mono: true });
      if (st.values.length > 1) {
        const str = `${st.values.length} siblings`, pw = estW(str, 11, false, true) + 12;
        g.appendChild(s("rect", { x: x + w - 8 - pw, y: y + 29, width: pw, height: 18, rx: 9, fill: C("warn-soft"), stroke: C("warn") }));
        T(g, x + w - 8 - pw / 2, y + 38, str, { size: 11, weight: 700, anchor: "middle", fill: C("warn") });
      }
      const { lost, back } = truth(), flag = lost.concat(back);
      let cy = y + 52;
      if (mode === "or") cy += orCard(g, cx, cy, cw, y + hh - 36 - cy, flag) + 8;
      else if (!st.values.length) cy += 14 * flow(g, cx, cy + 8, cw, [{ t: "Empty.", weight: 700 }, ...phrase(RULE[mode], C("muted"), null)], 11, 14);
      else st.values.forEach(v => { cy += valueCard(g, cx, cy, cw, v, flag) + 8; });  // two clients: at most two siblings
      verdict().forEach(([str, tone]) => { cy += 14 * flow(g, cx, cy + 4, cw, phrase(str, C(tone)), 11, 14); });
    }

    function drawTruth(g) {
      const [x, y, w, hh] = L.gt, { want, lost, back } = truth(), size = compact ? 11 : 12, lh = compact ? 14 : 15;
      g.appendChild(s("rect", { x, y, width: w, height: hh, rx: 6, fill: C("panel"), stroke: C("line") }));
      const list = (xs, red = []) => xs.map((i, k) => ({ t: i, sep: k < xs.length - 1 ? "," : "",
        fill: red.includes(i) ? C("bad") : null, weight: red.includes(i) ? 700 : null }));
      const seen = sorted(serverView());
      const words = [{ t: "Intended:", weight: 700 }, ...(want.length ? list(want) : [{ t: st.intent.size ? "(empty cart)" : "(nothing yet)", fill: C("muted") }]),
        { t: "Server view:", weight: 700, br: true }, ...(seen.length ? list(seen, back) : [{ t: "(empty)", fill: C("muted") }])];
      if (lost.length) words.push(...phrase(`✕ ${and(lost)} lost`, C("bad")));
      if (back.length) words.push(...phrase(`↺ ${and(back)} came back`, C("bad")));
      if (!lost.length && !back.length && st.intent.size) words.push(...phrase("✓ matches", C("ok")));
      const lines = wrap(words, w - 20, size);
      drawLines(g, x + 10, y + hh / 2 - ((lines.length - 1) * lh) / 2, lines, size, lh);
    }

    function render() {
      const g = view.scene;
      g.innerHTML = "";
      // Network links; the panels drawn on top hide all but the gap between them.
      L.cp.forEach(([x1, y1]) => g.appendChild(s("line", { x1, y1, x2: L.sp[0], y2: L.sp[1],
        stroke: C("line"), "stroke-width": 1.5, "stroke-dasharray": "4 3" })));
      drawClient(g, 0);
      drawClient(g, 1);
      drawServer(g);
      drawTruth(g);
      const { lost, back } = truth(), n = st.values.length;
      if (sib()) stats.set("vals", n, n > 1 ? "warn" : "");
      else stats.set("vals", (mode === "or" ? st.pairs.length : n) ? "1 state" : "empty", "");
      stats.set("ctr", mode === "or" ? "none (tags)" : (mode === "lww" ? "ts " : "") + st.counter, "");
      stats.set("lost", lost.length, lost.length ? "bad" : "ok");
      stats.set("back", back.length, back.length ? "bad" : "ok");
    }

    function build() {
      compact = ctx.compact;
      L = compact ? PHONE : DESK;
      root.innerHTML = "";
      const seg = ui.segmented({ label: "Server keeps", options: MODES, value: mode, onChange: v => { mode = v; resetAll(); } });
      const sel = ui.select({ label: "Item", options: ITEMS, value: item, onChange: v => { item = v; } });
      const acts = [];
      [0, 1].forEach(ci => ["add", "remove", "read"].forEach(k => acts.push(ui.button(`C${ci + 1} ${k}`, () => freeAct(ci, k)))));
      const presets = PRESETS.map((p, i) => ui.button(p.label, () => runPreset(p), i ? {} : { kind: "primary" }));
      const svg = ctx.svg({ w: L.W, h: L.H, label: "Two clients writing one shopping-cart key to a single database replica" });
      const scene = s("g"), packets = s("g");
      svg.append(scene, packets);
      view = { scene, packets };
      const presetBar = ui.bar(...presets, ui.button("Reset", () => resetAll(), { kind: "ghost" }));
      // Chapter layout: controls, scene, legend, stats, note, log.
      root.append(ui.bar(seg), presetBar, ui.bar(sel, ...acts), svg, legend, stats, note, log);
      setBusy(busy);
      render();
    }

    fresh();
    build();
    resetAll();
    // Rebuild with the other layout when the frame crosses the phone breakpoint.
    ctx.onResize(() => { if (ctx.compact !== compact) build(); });
  },
});
