// Old clients vs a changing API. The payments server is already on new code (servers deploy
// first); four clients of different ages call it. Each change is judged by each client's real
// decoder: Swift Codable, Jackson with its default settings, and an untouched 2019 Python script.
// Strategies: ship in place, keep /v1 next to /v2, or pin each client to a version date and let
// an edge transform translate (Stripe-style). Additive changes ship to every version either way.
(function () {
  "use strict";

  const CLIENTS = [
    { id: "W", name: "Web checkout", sub: "ships with the server", pin: "latest" },
    { id: "I", name: "iOS app 4.2", sub: "Swift Codable, 18 months old", pin: "2023-02-01" },
    { id: "P", name: "Partner backend", sub: "Java + Jackson defaults, 2021", pin: "2021-08-15" },
    { id: "S", name: "Merchant script", sub: "Python, 2019, never updated", pin: "2019-06-01" },
  ];
  const OLD = [1, 2, 3];   // the clients you can't upgrade

  const ok = d => ({ v: "ok", d }), bad = d => ({ v: "bad", d }), warn = d => ({ v: "warn", d });
  const rej = d => ({ v: "bad", d, rejected: true });   // the server answers 400; nothing to decode
  const DEF = "no description → default ''", R400 = "400: missing param currency";

  // The 2019-06-01 contract: POST /charges.
  const RESP = [["id", '"ch_1"'], ["amount", "1999"], ["status", '"succeeded"'], ["legacy_ref", '"A-17"']];
  const REQ = [["amount", "1999"], ["card", '"tok_123"']];

  // edit: how the contract changes (drawn in the contract panel); tag: what an additive change adds
  // to every version; xf: which direction the edge rewrites; v1/edge: old clients' detail line when
  // a breaking change is versioned. P's model includes legacy_ref: with FAIL_ON_UNKNOWN_PROPERTIES
  // on, it must map every field of the response it was written against.
  const CHANGES = [
    { label: "Add response field currency", kind: "additive", side: "resp", tag: "+ currency",
      edit: { add: ["currency", '"usd"'], tone: "info" }, comment: "new field",
      out: { W: ok("reads currency: 'usd'"), I: ok("ignores unknown key currency"),
        P: bad("UnrecognizedProperty: currency"), S: ok("ignores extra key currency") } },
    { label: "Add optional request param description", kind: "additive", side: "req", tag: "+ description",
      edit: { add: ["description", '"Order 42"'], tone: "info" }, comment: "optional",
      out: { W: ok("sends description: 'Order 42'"), I: ok(DEF), P: ok(DEF), S: ok(DEF) } },
    { label: "Require request param currency", kind: "breaking", side: "req", xf: "req",
      edit: { add: ["currency", '"usd"'], tone: "info" }, comment: "required, no default",
      out: { W: ok("sends currency: 'usd'"), I: rej(R400), P: rej(R400), S: rej(R400) },
      v1: "/v1: currency not required", edge: "edge fills currency = 'usd'" },
    { label: "Add enum value status: pending", kind: "additive", side: "resp", tag: "+ 'pending'",
      edit: { key: "status", value: '"pending"', tone: "info" }, comment: "new enum value",
      out: { W: ok("shows 'payment pending'"), I: bad("dataCorrupted: Status 'pending'"),
        P: bad("InvalidFormat: 'pending'"), S: warn("else branch: shows 'payment failed'") } },
    { label: "Rename amount to amount_cents", kind: "breaking", side: "resp", xf: "resp",
      edit: { key: "amount", rename: "amount_cents", tone: "warn" }, comment: "was amount",
      out: { W: ok("reads amount_cents"), I: bad("keyNotFound: amount"),
        P: bad("UnrecognizedProperty: amount_cents"), S: bad("KeyError: 'amount'") },
      v1: "/v1 still returns amount", edge: "edge: amount_cents → amount" },
    { label: "Make amount a string ('19.99')", kind: "breaking", side: "resp", xf: "resp",
      edit: { key: "amount", value: '"19.99"', tone: "warn" }, comment: "was 1999 (int cents)",
      out: { W: ok("parses '19.99'"), I: bad("typeMismatch: amount"),
        P: bad("InvalidFormat: '19.99' not int"), S: bad("TypeError: int += str") },
      v1: "/v1 still returns 1999 (int)", edge: "edge: '19.99' → 1999" },
    { label: "Remove legacy_ref", kind: "breaking", side: "resp", xf: "resp",
      edit: { key: "legacy_ref", tone: "bad", strike: true }, comment: "removed",
      out: { W: ok("no longer reads legacy_ref"), I: ok("legacy_ref not in its model"),
        P: ok("legacy_ref missing → null, unused"), S: bad("KeyError: 'legacy_ref'") },
      v1: "/v1 still returns legacy_ref", edge: "edge re-adds legacy_ref: 'A-17'" },
  ];

  const STRATS = [
    { value: "inplace", label: "In place", title: "Every client gets the changed contract" },
    { value: "v2", label: "/v2 URL", title: "Breaking changes ship only on /v2; old clients keep calling /v1" },
    { value: "pinned", label: "Pinned dates", title: "Each client is pinned to its integration date; the edge translates" },
  ];

  const ENUM_NOTE = "New enum values are <b>additive under this API's policy</b>, so they reach every version and versioning can't help. " +
    "Swift and Jackson throw on a value they don't know, and the 2019 script falls into its <code>else</code> branch and " +
    "<b>tells the customer the payment failed</b>. Document enums as open-ended and make clients map unknown values to 'unknown'.";
  const NOTES = [
    "Adding a response field is the textbook safe change, and this API's policy calls it additive, so it ships to every version. " +
      "<b>The partner still breaks</b>: Jackson fails on unknown properties by default. Forward-compatible responses only work " +
      "if client decoders ignore unknown fields, so <b>put that rule in your API contract from day one</b>.",
    "Old clients don't send <code>description</code>, and the new server falls back to a default. " +
      "<b>New request parameters must be optional</b>: that's backward compatibility for requests.",
    { inplace: "<b>The new server rejects every request from clients you can't upgrade.</b> Servers deploy first, so requests " +
        "must stay backward compatible: a new parameter needs a default.",
      v2: "Old clients keep calling <b>/v1</b>, which still accepts requests without <code>currency</code>. Everyone works, but " +
        "you now <b>serve two contracts</b> until the last /v1 client migrates, which may be never.",
      pinned: "The edge upgrades requests from older pins by <b>filling currency = 'usd'</b> before the core sees them: " +
        "one contract in the core, one small transform at the edge." },
    { inplace: ENUM_NOTE,
      v2: ENUM_NOTE + " Shipping it only on /v2 wouldn't fully fix it either: /v1 would still have to report a pending " +
        "charge as 'succeeded' or 'failed', and both are wrong.",
      pinned: ENUM_NOTE + " Versioning it wouldn't fully fix it either: an edge transform would have to turn 'pending' " +
        "into 'succeeded' or 'failed' for older pins, and both are wrong." },
    { inplace: "To a client, <b>a rename is a removal plus an addition</b>: every old client either can't find " +
        "<code>amount</code> or chokes on <code>amount_cents</code>.",
      v2: "Old clients never see the rename: <b>/v1 still returns amount</b>.",
      pinned: "The edge <b>renames amount_cents back to amount</b> for older pins." },
    { inplace: "Same name, new type: <b>every old client's decoder or arithmetic breaks</b>. Changing a field's type in place " +
        "is never compatible; add a new field instead.",
      v2: "<b>/v1 still returns integer cents.</b>",
      pinned: "The edge <b>converts '19.99' back to 1999 cents</b> for older pins." },
    { inplace: "Nobody on your team reads <code>legacy_ref</code>, but <b>a 2019 script exports it to accounting</b>. Without " +
        "per-client usage telemetry you can't know who reads a field, so removals need a version and a deprecation window.",
      v2: "<b>/v1 keeps legacy_ref</b>; only clients that move to /v2 lose it.",
      pinned: "The edge <b>re-adds legacy_ref</b> for pins older than the removal." },
  ];

  // ------------------------------------------------------------------ model
  const versioned = (c, st) => CHANGES[c].kind === "breaking" && st !== "inplace";
  const edgeActive = (c, st) => st === "pinned" && CHANGES[c].kind === "breaking";

  // What client i experiences: {v: ok|bad|warn, d: detail line, rejected?}.
  function outcome(c, i, st) {
    const ch = CHANGES[c];
    if (i > 0 && versioned(c, st)) return ok(st === "v2" ? ch.v1 : ch.edge);
    return ch.out[CLIENTS[i].id];
  }

  function summary(c, st) {
    const outs = OLD.map(i => outcome(c, i, st));
    const broken = outs.filter(o => o.v === "bad").length, misread = outs.filter(o => o.v === "warn").length;
    const breaking = CHANGES[c].kind === "breaking";
    const served = st === "v2" ? (breaking ? "2 (/v1 + /v2)" : "1 (/v1 = /v2)")
      : st === "pinned" && breaking ? "1 + 1 transform" : "1";
    const n = NOTES[c];
    return { broken, misread, served, tone: broken ? "bad" : misread ? "warn" : "ok", note: typeof n === "string" ? n : n[st] };
  }

  // The contract the new core speaks, as lines of {t, tone, strike} segments. Desktop puts the
  // entries on two lines with the comment at the end; phone puts one entry per line.
  function contractLines(c, phone) {
    const ch = CHANGES[c], e = ch.edit;
    const entries = (ch.side === "resp" ? RESP : REQ).map(([k, v]) => ({ k, v }));
    let hit;
    if (e.add) entries.push(hit = { k: e.add[0], v: e.add[1] });
    else hit = entries.find(x => x.k === e.key);
    if (e.rename) hit.k = e.rename;
    if (e.value) hit.v = e.value;
    hit.tone = e.tone; hit.strike = !!e.strike;
    const split = ch.side === "resp" ? 3 : 2, last = entries.length - 1, lines = [[]];
    entries.forEach((en, j) => {
      if (j > 0 && (phone || j === split)) lines.push([]);
      const line = lines[lines.length - 1];
      line.push({ t: j === 0 ? "{" : " " }, { t: `"${en.k}": ${en.v}`, tone: en.tone, strike: en.strike },
        { t: j === last ? "}" : "," });
      if (phone ? en === hit : j === last) line.push({ t: "  // " + ch.comment, tone: "muted" });
    });
    return lines;
  }

  Viz.register("ch4/api-evolution", {
    title: "Old clients vs a changing API",
    mount(root, ctx) {
      const { s, ui } = ctx;
      let change = 0, strategy = "inplace", run = 0, compact = ctx.compact, view = null;

      const col = t => `var(--viz-${t})`;
      const MUTED = col("muted");
      const BADGE = { ok: "OK", bad: "BREAKS", warn: "MISREAD" };
      const T = (x, y, str, size, o = {}) => ctx.text(x, y, str, Object.assign({ size, anchor: "start" }, o));
      const rect = (g, x, y, w, ht, o = {}) => g.appendChild(ctx.box({ x, y, w, h: ht, rx: o.rx === undefined ? 8 : o.rx,
        fill: o.fill, stroke: o.stroke, dashed: o.dashed, strokeWidth: o.sw }));
      // Centered lines of text: [str, size, {weight, fill}] around (cx, cy).
      const stack = (g, cx, cy, lines, lh) => lines.filter(Boolean).forEach((ln, k, arr) =>
        g.appendChild(ctx.text(cx, cy + (k - (arr.length - 1) / 2) * lh, ln[0], Object.assign({ size: ln[1], fill: MUTED }, ln[2]))));

      // ---------------------------------------------------------------- geometry
      const G = {
        desk: { W: 640, H: 400, fs: 12, cardX: 352, cardW: 280, cardH: 60, cardY: [16, 92, 168, 244],
          srvR: 132, edgeX: [166, 254], panel: [12, 316, 616, 76] },
        phone: { W: 360, H: 524, fs: 11, cardX: 8, cardW: 344, cardH: 66, cardY: [104, 180, 256, 332],
          panel: [8, 410, 344, 108] },
      };
      const geo = () => (compact ? G.phone : G.desk);
      const viaEdge = i => i > 0 && edgeActive(change, strategy);

      // Packet route for client i, card -> server (dir "req") or back ("resp"), as segments. Through an
      // active edge the packet enters one side and leaves the other, holding longer when the edge
      // rewrites that direction.
      function route(i, dir) {
        const g = geo(), stop = viaEdge(i);
        let segs;
        if (compact) {
          const x = strategy === "v2" ? [268, 48, 100, 152][i] : [60, 110, 160, 210][i], y0 = g.cardY[i];
          segs = stop ? [[[x, y0], [x, 92]], [[x, 64], [x, 56]]] : [[[x, y0], [x, 56]]];
        } else {
          const y = g.cardY[i] + g.cardH / 2 + (dir === "req" ? -8 : 8), [eL, eR] = g.edgeX;
          segs = stop ? [[[g.cardX, y], [eR, y]], [[eL, y], [g.srvR, y]]] : [[[g.cardX, y], [g.srvR, y]]];
        }
        if (dir === "resp") segs = segs.reverse().map(sg => sg.reverse());
        return { segs, hold: CHANGES[change].xf === dir ? 280 : 60 };
      }

      // ---------------------------------------------------------------- static scene
      function drawServers(g) {
        const ch = CHANGES[change], add = ch.kind === "additive", c1 = { fill: col("c1-soft"), stroke: col("c1") };
        const ink = { fill: col("ink"), weight: 700 }, tag = add && [ch.tag, compact ? 11 : 12, { fill: col("info"), weight: 700 }];
        if (compact) {
          if (strategy === "v2") {
            rect(g, 8, 8, 168, 48, c1); rect(g, 184, 8, 168, 48, c1);
            stack(g, 92, 32, [["/v1", 12, ink], add ? tag : ["2019 contract", 11]], 16);
            stack(g, 268, 32, [["/v2", 12, ink], add ? tag : ["new contract", 11]], 16);
          } else {
            rect(g, 8, 8, 344, 48, c1);
            stack(g, 180, 32, [["Payments API (new code)", 12, ink],
              [strategy === "pinned" ? "core speaks one contract" : "deployed first, before any client", 11]], 16);
          }
          return;
        }
        if (strategy === "v2") {
          rect(g, 12, 16, 120, 60, c1); rect(g, 12, 92, 120, 212, c1);
          stack(g, 72, 46, [["/v2", 13, ink], add ? tag : ["new contract", 12]], 18);
          stack(g, 72, 198, [["/v1", 13, ink], ["2019 contract", 12], tag], 18);
        } else {
          rect(g, 12, 16, 120, 288, c1);
          stack(g, 72, 160, [["Payments API", 13, ink], ["new code,", 12],
            [strategy === "pinned" ? "one contract" : "deployed first", 12]], 18);
        }
      }

      // What the arrows (desktop) or the gap under the server (phone) carry.
      function drawKey(g) {
        const m = { fill: MUTED, halo: true };
        if (compact) {
          if (strategy !== "pinned") g.appendChild(ctx.text(180, 79, "↑ POST /charges  ·  ↓ 200 + JSON", Object.assign({ size: 11 }, m)));
          return;
        }
        g.appendChild(ctx.text(296, 28, "POST /charges", Object.assign({ size: 12 }, m)));
        g.appendChild(ctx.text(296, 65, "200 + JSON", Object.assign({ size: 12 }, m)));
      }

      function drawEdge(g) {
        if (strategy !== "pinned") return;
        const act = edgeActive(change, strategy), c3 = { fill: act ? col("c3-soft") : "none", stroke: col("c3"), dashed: !act };
        const n = act ? "1 transform" : "0 transforms";
        if (compact) {
          rect(g, 8, 64, 344, 28, Object.assign({ rx: 6 }, c3));
          g.appendChild(ctx.text(180, 78, act ? "edge: " + n + " for older pins" : "edge: " + n + " (additive)", { size: 12, weight: 600 }));
          return;
        }
        rect(g, 166, 62, 88, 246, c3);
        stack(g, 210, 87.5, [["edge", 12, { fill: col("ink"), weight: 700 }], [n, 12]], 15);
        if (!act) return;
        g.appendChild(s("line", { x1: 176, x2: 244, y1: 108, y2: 108, stroke: col("c3"), "stroke-width": 1 }));
        OLD.forEach(i => {
          const y = G.desk.cardY[i] + 35;
          stack(g, 210, y, [["pinned to", 12], [CLIENTS[i].pin, 12, { fill: col("ink"), mono: true }]], 15);
        });
      }

      function jsonText(x, y, segs, size) {
        const t = ctx.text(x, y, "", { size, anchor: "start", mono: true });
        t.style.whiteSpace = "pre";
        segs.forEach(sg => {
          const hi = sg.tone && sg.tone !== "muted";
          t.appendChild(s("tspan", { fill: sg.tone ? col(sg.tone) : null, "font-weight": hi ? 700 : null,
            "text-decoration": sg.strike ? "line-through" : null }, sg.t));
        });
        return t;
      }

      function drawContract(g) {
        const ch = CHANGES[change], [x, y, w, ht] = geo().panel, fs = geo().fs;
        rect(g, x, y, w, ht, { fill: col("panel"), stroke: col("line") });
        const title = ch.side === "resp" ? "Response the new server sends" : "Request the new server expects";
        g.appendChild(T(x + 12, y + 16, title, compact ? 11 : 12, { fill: MUTED, weight: 600 }));
        if (!compact) {
          const add = ch.kind === "additive";
          const hint = strategy === "inplace" ? "applies to every client"
            : strategy === "v2" ? (add ? "additive: shipped on /v1 too" : "only on /v2; /v1 keeps the 2019 shape")
            : add ? "additive: not versioned, every pin gets it" : "core only; the edge translates for older pins";
          g.appendChild(T(x + w - 12, y + 16, hint, 12, { fill: MUTED, anchor: "end" }));
        }
        contractLines(change, compact).forEach((segs, k) =>
          g.appendChild(jsonText(x + 12, y + (compact ? 34 + k * 15 : 38 + k * 20), segs, fs)));
      }

      // ---------------------------------------------------------------- one client row
      // stage 0: nothing landed yet, 1: request landed, 2: response landed (outcome shown).
      function drawArrows(g, i, o, stage) {
        g.innerHTML = "";
        if (compact) return;
        const d = G.desk, mid = d.cardY[i] + d.cardH / 2, ry = mid - 8, sy = mid + 8, [eL, eR] = d.edgeX;
        const line = (x1, x2, y, color, o2 = {}) => g.appendChild(ctx.arrow(Object.assign({
          x1, y1: y, x2, y2: y, color, svg: view.svg }, o2)));
        // Through an active edge an arrow is two segments; otherwise one.
        const path = (from, to, y, color) => {
          if (!viaEdge(i)) return line(from, to, y, color);
          if (from > to) { line(from, eR, y, color); line(eL, to, y, color); }
          else { line(from, eL, y, color); line(eR, to, y, color); }
        };
        const pending = col("line");
        if (o.rejected && stage >= 1) {
          line(d.cardX, d.srvR + 14, ry, col("bad"), { arrow: false });
          const cx = d.srvR + 8;
          g.appendChild(s("path", { d: `M${cx - 5},${ry - 5}L${cx + 5},${ry + 5}M${cx - 5},${ry + 5}L${cx + 5},${ry - 5}`,
            stroke: col("bad"), "stroke-width": 2.4, "stroke-linecap": "round" }));
          if (stage < 2) return;
          line(d.srvR, d.cardX, sy, col("bad"), { dashed: true });
          g.appendChild(ctx.text((d.srvR + d.cardX) / 2, sy, "400", { size: 12, weight: 700, fill: col("bad"), halo: true }));
          return;
        }
        path(d.cardX, d.srvR, ry, stage >= 1 ? col("ok") : pending);
        path(d.srvR, d.cardX, sy, stage >= 2 ? col(o.v) : pending);
      }

      function chip(g, x, y, label, tone) {
        const muted = tone === "na" || !tone;
        g.appendChild(s("rect", { x, y, width: 36, height: 17, rx: 8.5,
          fill: muted ? col("grid") : col(tone + "-soft"), stroke: muted ? col("line") : col(tone), "stroke-width": 1.2 }));
        g.appendChild(ctx.text(x + 18, y + 9, label, { size: 11, weight: 700, fill: muted ? MUTED : col("ink") }));
      }

      // Returns the elements that fade in when the response lands.
      function drawCard(g, i, o, stage) {
        g.innerHTML = "";
        const d = geo(), x = d.cardX, y = d.cardY[i], cl = CLIENTS[i], shown = stage >= 2;
        const stroke = shown && o.v !== "ok" ? col(o.v) : col("c6");
        rect(g, x, y, d.cardW, d.cardH, { fill: col("c6-soft"), stroke, sw: shown && o.v !== "ok" ? 2.2 : 1.5 });
        const fs = d.fs, right = x + d.cardW - 10;
        g.appendChild(T(x + 12, y + 17, cl.name, compact ? 12 : 13, { weight: 700 }));
        g.appendChild(T(x + 12, y + (compact ? 35 : 34), cl.sub, fs, { fill: MUTED }));
        if (compact) {
          chip(g, right - 78, y + 27, "req", stage >= 1 ? (o.rejected ? "bad" : "ok") : null);
          chip(g, right - 36, y + 27, "resp", shown ? (o.rejected ? "na" : o.v) : null);
        }
        if (!shown) return [];
        const label = BADGE[o.v], bw = label.length * (compact ? 7.4 : 8) + 14, by = y + 17;
        const badge = s("g", null,
          s("rect", { x: right - bw, y: by - 9, width: bw, height: 18, rx: 9, fill: col(o.v + "-soft"), stroke: col(o.v) }),
          ctx.text(right - bw / 2, by, label, { size: compact ? 11 : 12, weight: 800, fill: col(o.v) }));
        const detail = T(x + 12, y + (compact ? 54 : 51), o.d, fs, { mono: true, fill: o.v === "ok" ? MUTED : col(o.v) });
        g.append(badge, detail);
        return [badge, detail];
      }

      function drawRow(i, stage, fade) {
        const o = outcome(change, i, strategy), row = view.rows[i];
        drawArrows(row.arrows, i, o, stage);
        const els = drawCard(row.card, i, o, stage);
        if (fade && els.length) {
          els.forEach(el => el.setAttribute("opacity", 0));
          ctx.tween({ ms: 300, onUpdate: k => els.forEach(el => el.setAttribute("opacity", k)) });
        }
      }

      // ---------------------------------------------------------------- render + stats
      function render(pending) {
        const L = view.L;
        Object.values(L).forEach(g => { g.innerHTML = ""; });
        drawServers(L.base); drawEdge(L.base); drawKey(L.base); drawContract(L.base);
        view.rows = CLIENTS.map(() => {
          const r = { arrows: s("g"), card: s("g") };
          L.arrows.appendChild(r.arrows); L.cards.appendChild(r.card);
          return r;
        });
        CLIENTS.forEach((_, i) => drawRow(i, pending ? 0 : 2));
        const sm = summary(change, strategy), breaking = CHANGES[change].kind === "breaking";
        view.stats.set("broken", sm.broken, sm.broken ? "bad" : "ok");
        view.stats.set("misread", sm.misread, sm.misread ? "warn" : "ok");
        view.stats.set("served", sm.served, "");
        view.stats.set("kind", breaking ? "breaking" : "additive", breaking ? "warn" : "info");
        view.note.set(sm.note, sm.tone);
      }

      // Fly a packet along a route, holding it between segments (inside the edge). Desktop response
      // labels go below the packet, clear of the request arrow; phone packets are unlabelled (the
      // key under the server explains them) because they cross the edge bar and other cards.
      async function flyPath({ segs, hold }, o, my, below) {
        const lens = segs.map(([p, q]) => Math.hypot(q[0] - p[0], q[1] - p[1]));
        const total = lens.reduce((x, y) => x + y, 0), layer = view.L.packets;
        for (let k = 0; k < segs.length; k++) {
          const keep = k < segs.length - 1;
          const f = ctx.fly(layer, { from: segs[k][0], to: segs[k][1], ms: (500 * lens[k]) / total,
            label: compact ? undefined : o.label, fill: o.fill, labelSize: 12, keep });
          const pkt = layer.lastChild, label = pkt.querySelector("text");
          if (below && label) label.setAttribute("y", 16);
          await f;
          if (my !== run) return;
          if (keep) { await ctx.sleep(hold); pkt.remove(); if (my !== run) return; }
        }
      }

      async function sendOne(i, my) {
        await ctx.sleep(i * 150);
        if (my !== run) return;
        const o = outcome(change, i, strategy);
        await flyPath(route(i, "req"), { label: "POST", fill: col("c6") }, my);
        if (my !== run) return;
        drawRow(i, 1);
        const resp = o.rejected ? { label: "400", fill: col("bad") } : { label: "200", fill: col("c1") };
        await flyPath(route(i, "resp"), resp, my, !compact);
        if (my !== run) return;
        drawRow(i, 2, true);
      }

      function send() {
        const my = ++run;
        render(true);
        CLIENTS.forEach((_, i) => sendOne(i, my));
      }

      function changed() { run++; render(false); }

      // ---------------------------------------------------------------- build (per layout)
      function build() {
        run++;
        root.innerHTML = "";
        compact = ctx.compact;
        const d = geo();
        const sel = ui.select({
          label: "Change to ship", value: change,
          options: CHANGES.map((ch, i) => ({ value: i, label: ch.label })),
          onChange: v => { change = Number(v); changed(); },
        });
        sel.style.flexWrap = "wrap"; sel.style.maxWidth = "100%";
        sel.querySelector("select").style.maxWidth = "100%";
        const seg = ui.segmented({ label: "Ship it as", options: STRATS, value: strategy, onChange: v => { strategy = v; changed(); } });
        const sendBtn = ui.button("▶ Send traffic", send, { kind: "primary", title: "Every client calls POST /charges on the new server" });

        const svg = ctx.svg({ w: d.W, h: d.H, label: "Four clients of different ages calling a payments API after a change" });
        const L = { base: s("g"), arrows: s("g"), cards: s("g"), packets: s("g") };
        svg.append(L.base, L.arrows, L.cards, L.packets);
        const legend = ui.legend([
          { color: col("ok"), label: "works" },
          { color: col("bad"), label: "error" },
          { color: col("warn"), label: "silently wrong" },
          { color: col("c3"), label: "edge transform", shape: "square" },
        ]);
        const stats = ui.stats([
          { key: "broken", label: "Old clients broken" },
          { key: "misread", label: "Silently wrong" },
          { key: "served", label: "Contracts served" },
          { key: "kind", label: "Change type" },
        ]);
        const note = ui.note("");
        root.append(ui.bar(sel, seg), ui.bar(sendBtn, legend), svg, stats, note);
        view = { svg, L, stats, note, rows: [] };
        render(false);
      }

      build();
      ctx.onResize(() => { if (ctx.compact !== compact) build(); });
    },
  });
})();
