// Rolling upgrade on a shared database. During a rollout, v1 and v2 servers read and write the
// same stored documents. v2 adds an optional photoUrl; a v1 server that decodes a document into
// its model object and saves the whole object back silently erases the field it doesn't know.
Viz.register("ch4/rolling-upgrade", {
  title: "Rolling upgrade on a shared database",
  mount(root, ctx) {
    const { s, ui } = ctx;
    const NAMES = ["A", "B", "C", "D"];
    const BIOS = ["math", "analysis", "poetry", "engines"];
    const VC = { 1: "c2", 2: "c5" };   // color per code version
    const col = c => `var(--viz-${c})`, soft = c => `var(--viz-${c}-soft)`;
    const MUTED = "var(--viz-muted)";
    const INITIAL = ["All four servers run v1. v2 adds an optional <code>photoUrl</code> field. Upgrade a node, " +
      "let v2 set Maya's photo, then let a v1 node edit her bio. Or press <b>Play the story</b>.", "info"];
    const NO_V2 = ["No node runs v2 yet: upgrade one first.", "warn"];

    // Upgrades go A -> D and a rollback undoes the latest one, so the v2 nodes are always a
    // prefix: nodes [0, m.v2) run v2. Writers are the first v2 node, editors the last v1 node.
    let m = fresh(), mode = "drop", busy = false, epoch = 0, compact = ctx.compact, view = null;

    function fresh() {
      return {
        v2: 0, bio: 0, lost: 0, failed: 0, note: INITIAL, log: [],
        docs: [
          { user: "Maya", bio: "math", photo: null, by: 1 },
          { user: "Grace", bio: "COBOL", photo: null, by: 1 },
          { user: "Alan", bio: "codes", photo: null, by: 1 },
        ],
      };
    }
    const firstV2 = () => (m.v2 > 0 ? 0 : -1);
    const lastV1 = () => (m.v2 < 4 ? 3 : -1);
    const list = a => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);

    // ---------------------------------------------------------------- layout
    function layout(phone) {
      if (phone) return {
        W: 360, H: 300, fs: 11, val: 12, nodeFs: 12, capY: 11, nodeY: 46, r: 22, xs: [52, 136, 220, 304],
        verY: 82, chipY: 99, chipH: 20, panel: { x: 8, y: 112, w: 344, h: 182 },
        cap: "app servers (upgrade order A → D)",
        title: "users store: one document per user", sub: "every save rewrites the whole document",
        titleY: 130, subY: 147, headY: 170, lineY: 179, rows: [200, 234, 268], rowH: 28,
        card: { x: 14, w: 264 }, cols: { open: 18, user: 30, bio: 94, photo: 184, close: 270, by: 316 },
      };
      return {
        W: 640, H: 322, fs: 12, val: 13, nodeFs: 13, capY: 12, nodeY: 52, r: 26, xs: [110, 250, 390, 530],
        verY: 92, chipY: 114, chipH: 22, panel: { x: 40, y: 128, w: 560, h: 186 },
        cap: "app servers, all sharing one database (rolling upgrade order A → D)",
        title: "users store: one encoded document per user",
        sub: "every save rewrites the whole document: read it, change the object, write it all back",
        titleY: 148, subY: 166, headY: 190, lineY: 200, rows: [222, 256, 290], rowH: 28,
        card: { x: 56, w: 420 }, cols: { open: 66, user: 80, bio: 190, photo: 320, close: 466, by: 540 },
      };
    }
    const nodeAt = i => [view.L.xs[i], view.L.nodeY];
    const docAt = j => [view.L.card.x + view.L.card.w / 2, view.L.rows[j]];

    // ---------------------------------------------------------------- controls
    const btn = {
      up: ui.button("Upgrade next node", () => run(upgrade), { kind: "primary" }),
      rb: ui.button("Roll back one", () => run(rollback), { kind: "ghost" }),
      play: ui.button("▶ Play the story", () => { reset(); run(story); }, { kind: "ok" }),
      reset: ui.button("Reset", () => reset(), { kind: "ghost" }),
      photo: ui.button("v2 sets Maya's photo", () => run(setPhoto),
        { title: "The first v2 node saves Maya's document with photoUrl set" }),
      edit: ui.button("v1 edits Maya's bio", () => run(editBio),
        { title: "The last v1 node (D first) loads Maya's document, changes her bio and saves it" }),
      grace: ui.button("v2 reads Grace", () => run(readGrace),
        { title: "The first v2 node reads Grace's document, which v1 wrote" }),
    };
    const seg = ui.segmented({
      label: "v1 on unknown fields", value: mode,
      options: [
        { value: "drop", label: "Drop (model object)", title: "Decode into the User object, which has no photoUrl, and save that" },
        { value: "keep", label: "Preserve", title: "Keep unknown fields beside the object and write them back" },
        { value: "reject", label: "Reject", title: "A strict decoder fails on unknown fields" },
      ],
      onChange: v => { mode = v; if (!busy) { m.note = modeNote(); draw(); } },
    });
    const holder = ctx.h("div");
    const legend = ui.legend([
      { color: col("c2"), label: "v1 code: its User object has no photoUrl" },
      { color: col("c5"), label: "v2 code: adds an optional photoUrl" },
    ]);
    const stats = ui.stats([
      { key: "v2", label: "Nodes on v2" },
      { key: "photos", label: "Docs with a photo" },
      { key: "lost", label: "Fields lost" },
      { key: "failed", label: "Failed requests" },
    ]);
    const note = ui.note("");
    // Phone entries wrap to two lines, so give the log room for three of them.
    const logHeight = () => (ctx.compact ? 128 : 96);
    const log = ui.log({ title: "What happened", height: logHeight() });
    root.append(
      ui.bar(btn.up, btn.rb, btn.play, btn.reset),
      ui.bar(btn.photo, btn.edit, btn.grace, seg),
      holder, legend, stats, note, log,
    );

    // ---------------------------------------------------------------- scene
    function buildScene() {
      compact = ctx.compact;
      const L = layout(compact);
      const svg = ctx.svg({ w: L.W, h: L.H, label: "Four app servers on v1 or v2 sharing one document store" });
      const base = s("g"), docsG = s("g"), nodesG = s("g"), fx = s("g"), top = s("g");
      svg.append(base, docsG, nodesG, fx, top);
      view = { L, fx, top, nodes: [], docs: [] };
      drawStatic(base, L);
      L.xs.forEach((x, i) => view.nodes.push(makeNode(nodesG, L, x, i)));
      m.docs.forEach((d, j) => view.docs.push(makeDoc(docsG, L, d, j)));
      holder.replaceChildren(svg);
    }

    function drawStatic(base, L) {
      const t = (x, y, str, o) => base.appendChild(ctx.text(x, y, str, { size: L.fs, fill: MUTED, ...o }));
      t(L.W / 2, L.capY, L.cap);
      L.xs.forEach(x => base.appendChild(s("line", {
        x1: x, x2: x, y1: L.verY + 8, y2: L.panel.y, stroke: "var(--viz-line)", "stroke-dasharray": "3 3",
      })));
      const P = L.panel;
      base.appendChild(s("rect", { x: P.x, y: P.y, width: P.w, height: P.h, rx: 10, fill: "var(--viz-panel)", stroke: "var(--viz-line)" }));
      t(P.x + 14, L.titleY, L.title, { anchor: "start", weight: 700 });
      t(P.x + 14, L.subY, L.sub, { anchor: "start" });
      const C = L.cols;
      [["user", C.user], ["bio", C.bio], ["photoUrl", C.photo]].forEach(([str, x]) => t(x, L.headY, str, { anchor: "start" }));
      t(C.by, L.headY, "written by");
      base.appendChild(s("line", { x1: P.x + 10, x2: P.x + P.w - 10, y1: L.lineY, y2: L.lineY, stroke: "var(--viz-line)", opacity: 0.6 }));
    }

    function makeNode(parent, L, x, i) {
      const y = L.nodeY, r = L.r;
      const disc = c => [s("circle", { cx: x, cy: y, r, fill: "var(--viz-bg)" }),
        s("circle", { cx: x, cy: y, r, fill: soft(c), stroke: col(c), "stroke-width": 2 })];
      const g = s("g", null, ...disc(VC[1]));
      // The v2 look is a second opaque disc on top; upgrades cross-fade its opacity.
      g.v2 = s("g", { opacity: 0 }, ...disc(VC[2]));
      g.ver = ctx.text(x, L.verY, "v1", { size: L.fs, weight: 700 });
      g.append(g.v2, ctx.text(x, y, NAMES[i], { size: L.nodeFs, weight: 700 }), g.ver);
      parent.appendChild(g);
      return g;
    }

    function makeDoc(parent, L, d, j) {
      const y = L.rows[j], C = L.cols, cd = L.card;
      const val = (x, str, fill) => ctx.text(x, y, str, { size: L.val, mono: true, anchor: "start", fill });
      const g = s("g", null,
        s("rect", { x: cd.x, y: y - L.rowH / 2, width: cd.w, height: L.rowH, rx: 6, fill: "var(--viz-bg)", stroke: "var(--viz-line)" }),
        val(C.open, "{", MUTED), val(C.close, "}", MUTED), val(C.user, d.user));
      g.bio = val(C.bio, "");
      g.photo = val(C.photo, "");
      g.strike = s("line", { y1: y, y2: y, stroke: "var(--viz-bad)", "stroke-width": 1.5 });
      g.pill = s("rect", { x: C.by - 16, y: y - 10, width: 32, height: 20, rx: 10, "stroke-width": 1.4 });
      g.by = ctx.text(C.by, y, "", { size: L.fs, weight: 700 });
      g.append(g.bio, g.photo, g.strike, g.pill, g.by);
      parent.appendChild(g);
      return g;
    }

    // ---------------------------------------------------------------- render model
    function draw() {
      view.nodes.forEach((n, i) => {
        const v = i < m.v2 ? 2 : 1;
        n.v2.setAttribute("opacity", v === 2 ? 1 : 0);
        n.ver.textContent = "v" + v;
        ctx.attr(n.ver, { fill: col(VC[v]) });
      });
      m.docs.forEach((d, j) => {
        const g = view.docs[j];
        g.bio.textContent = d.bio;
        // A value a v1 save erased stays visible, struck through, until v2 writes the field again.
        g.photo.textContent = d.photo || d.lost || "(absent)";
        ctx.attr(g.photo, { fill: d.photo ? col("c5") : d.lost ? col("bad") : MUTED });
        const w = d.lost && !d.photo ? g.photo.getComputedTextLength() || d.lost.length * view.L.val * 0.6 : 0;
        ctx.attr(g.strike, { x1: view.L.cols.photo - 2, x2: view.L.cols.photo + w + 2, opacity: w ? 1 : 0 });
        g.by.textContent = "v" + d.by;
        ctx.attr(g.by, { fill: col(VC[d.by]) });
        ctx.attr(g.pill, { fill: soft(VC[d.by]), stroke: col(VC[d.by]) });
      });
      const photos = m.docs.filter(d => d.photo).length;
      stats.set("v2", `${m.v2} / 4`, m.v2 === 4 ? "ok" : "");
      stats.set("photos", `${photos} / 3`, "");
      stats.set("lost", String(m.lost), m.lost ? "bad" : "ok");
      stats.set("failed", String(m.failed), m.failed ? "bad" : "ok");
      note.set(...m.note);
      log.clear();
      if (!m.log.length) log.add("Nothing yet: use the buttons above, or press Play the story.", "muted");
      m.log.slice().reverse().forEach(([html, tone]) => log.add(html, tone));   // newest first
      log.lastChild.scrollTop = 0;
      syncButtons();
    }

    function syncButtons() {
      btn.up.disable(busy || m.v2 === 4).setLabel(m.v2 < 4 ? `Upgrade node ${NAMES[m.v2]}` : "Upgrade next node");
      btn.rb.disable(busy || m.v2 === 0).setLabel(m.v2 > 0 ? `Roll back node ${NAMES[m.v2 - 1]}` : "Roll back one");
      [btn.play, btn.photo, btn.edit, btn.grace].forEach(b => b.disable(busy));
    }

    const record = (html, tone) => { m.log.push([html, tone]); if (m.log.length > 30) m.log.shift(); };

    // ---------------------------------------------------------------- animation helpers
    // A packet with a mono label that stays inside the viewBox (ctx.fly centers labels, which
    // would clip near the edges on phones).
    function fly(from, to, label, ver) {
      const L = view.L, g = s("g");
      const t = ctx.text(0, -17, label, { size: L.fs, weight: 600, mono: true, halo: true });
      g.append(s("circle", { r: 7, fill: col(VC[ver]), stroke: "var(--viz-bg)", "stroke-width": 1.5 }), t);
      view.top.appendChild(g);
      const half = (t.getComputedTextLength() || label.length * L.fs * 0.6) / 2;
      return ctx.tween({ ms: 600, onUpdate: k => {
        const x = ctx.lerp(from[0], to[0], k), y = ctx.lerp(from[1], to[1], k);
        g.setAttribute("transform", `translate(${x},${y})`);
        t.setAttribute("x", ctx.clamp(x, half + 4, L.W - half - 4) - x);
      } }).then(() => g.remove());
    }

    // Status pill under a node; .set(text, tone) restyles it.
    function chip(i, str, tone) {
      const L = view.L, hh = L.chipH, y = L.chipY - hh / 2;
      const bg = s("rect", { y, height: hh, rx: hh / 2, fill: "var(--viz-bg)" });
      const box = s("rect", { y, height: hh, rx: hh / 2, "stroke-width": 1.5 });
      const t = ctx.text(0, L.chipY, "", { size: L.fs, weight: 600 });
      const g = s("g", null, bg, box, t);
      view.fx.appendChild(g);
      g.set = (str2, tone2) => {
        t.textContent = str2;
        const w = (t.getComputedTextLength() || str2.length * L.fs * 0.55) + 18;
        const cx = ctx.clamp(L.xs[i], w / 2 + 4, L.W - w / 2 - 4);
        [bg, box].forEach(r => ctx.attr(r, { x: cx - w / 2, width: w }));
        ctx.attr(box, { fill: soft(tone2), stroke: col(tone2) });
        ctx.attr(t, { x: cx });
      };
      g.set(str, tone);
      return g;
    }

    function fadeOut(el, ms, delay = 0) {
      ctx.after(delay, () => ctx.tween({ ms, onUpdate: k => el.setAttribute("opacity", 1 - k) }).then(() => el.remove()));
    }
    function ring(i, ver) {
      const L = view.L;
      return view.fx.appendChild(s("circle", {
        cx: L.xs[i], cy: L.nodeY, r: L.r + 5, fill: "none", stroke: col(VC[ver]), "stroke-width": 2, "stroke-dasharray": "4 3",
      }));
    }
    // Outline the whole card: a save replaces the entire document, not one field.
    function flashCard(j, ver) {
      const L = view.L, c = L.card, y = L.rows[j] - L.rowH / 2;
      const r = view.fx.appendChild(s("rect", {
        x: c.x - 3, y: y - 3, width: c.w + 6, height: L.rowH + 6, rx: 8, fill: "none", stroke: col(VC[ver]), "stroke-width": 2.5,
      }));
      fadeOut(r, 500, 500);
    }
    function flashBad(i) {
      const L = view.L;
      const c = view.fx.appendChild(s("circle", {
        cx: L.xs[i], cy: L.nodeY, r: L.r, fill: "var(--viz-bad-soft)", stroke: "var(--viz-bad)", "stroke-width": 3,
      }));
      fadeOut(c, 500, 700);
    }
    // Red highlight on the erased cell (the struck-through value is drawn by draw()).
    async function lostFlash(j, value) {
      const L = view.L, w = value.length * L.val * 0.6 + 14;
      const r = view.fx.appendChild(s("rect", {
        x: L.cols.photo - 7, y: L.rows[j] - 12, width: w, height: 24, rx: 5,
        fill: "var(--viz-bad-soft)", stroke: "var(--viz-bad)", "stroke-width": 1.5,
      }));
      await ctx.sleep(900);
      await ctx.tween({ ms: 300, onUpdate: k => r.setAttribute("opacity", 1 - k) });
      r.remove();
    }

    // ---------------------------------------------------------------- actions
    function run(fn) {
      if (busy) return;
      const my = epoch;
      busy = true;
      view.fx.innerHTML = "";
      syncButtons();
      fn(my).finally(() => { if (my === epoch) { busy = false; syncButtons(); } });
    }

    function reset() {
      epoch++;
      busy = false;
      m = fresh();
      view.fx.innerHTML = view.top.innerHTML = "";
      draw();
    }

    function fadeNode(i, a, b, my) {
      const el = view.nodes[i].v2;
      return ctx.tween({ ms: 400, onUpdate: k => { if (my === epoch) el.setAttribute("opacity", ctx.lerp(a, b, k)); } });
    }

    async function upgrade(my) {
      const i = m.v2;
      if (i >= 4) return;
      m.v2++;
      record(`Node ${NAMES[i]} upgraded to v2`, "info");
      m.note = m.v2 === 4 ? allV2Note() : upgradeNote(i);
      draw();
      await fadeNode(i, 0, 1, my);
    }

    async function rollback(my) {
      const i = m.v2 - 1;
      if (i < 0) return;
      m.v2--;
      record(`Node ${NAMES[i]} rolled back to v1`, "warn");
      m.note = m.docs.some(d => d.by === 2)
        ? [`Node ${NAMES[i]} is back on v1, but the documents v2 wrote are still there: a rollback is forward ` +
          "compatibility under pressure. Old code now meets new data.", "warn"]
        : [`Node ${NAMES[i]} is back on v1. v2 hasn't saved any documents yet, so no v1 node can meet a field it doesn't know.`, "info"];
      draw();
      await fadeNode(i, 1, 0, my);
    }

    async function setPhoto(my) {
      const w = firstV2();
      if (w < 0) { m.note = NO_V2; draw(); return; }
      const rg = ring(w, 2);
      await fly(nodeAt(w), docAt(0), "{user, bio, photoUrl:'maya.png'}", 2);
      if (my !== epoch) return;
      const d = m.docs[0];
      d.photo = "maya.png";
      d.lost = null;
      d.by = 2;
      record(`Node ${NAMES[w]} (v2) saved Maya with photoUrl=maya.png`, "info");
      const v1 = NAMES.slice(m.v2);
      m.note = [`Node ${NAMES[w]} (v2) saved Maya's whole document, now with <code>photoUrl</code>. ` + (v1.length
        ? `${v1.length > 1 ? "Nodes" : "Node"} ${list(v1)} still run${v1.length > 1 ? "" : "s"} v1 and will load this document too. Now let a v1 node edit her bio.`
        : "Every node understands <code>photoUrl</code>, so nothing can drop it. Roll a node back to see the risk."), "info"];
      draw();
      flashCard(0, 2);
      rg.remove();
    }

    async function editBio(my) {
      const e = lastV1(), how = mode, d = m.docs[0], N = NAMES[e];
      if (e < 0) {
        m.note = ["Every node runs v2, so nobody can drop the field. Roll one back to see the risk return.", "info"];
        draw();
        return;
      }
      const photo = d.photo, rg = ring(e, 1);
      await fly(docAt(0), nodeAt(e), photo ? "{user, bio, photoUrl}" : "{user, bio}", 1);
      if (my !== epoch) return;
      let c = null;
      if (photo) {
        c = chip(e, "photoUrl: unknown field", "warn");
        await ctx.sleep(500);
        if (my !== epoch) return;
        if (how === "reject") {
          c.set("500: unknown field", "bad");
          flashBad(e);
          m.failed++;
          record(`Node ${N} (v1) → 500: unknown field photoUrl`, "bad");
          m.note = [`Node ${N}'s strict decoder refused Maya's document and the request failed with a 500. Safer than ` +
            "silent loss, but every v1 node now fails on documents v2 has touched, so the rollout must finish fast: " +
            "a rollback would leave every node failing on them.", "warn"];
          draw();
          await ctx.sleep(1200);
          fadeOut(c, 300);
          rg.remove();
          return;
        }
        c.set(how === "drop" ? "photoUrl dropped: no slot in User" : "photoUrl kept as unknown", how === "drop" ? "bad" : "ok");
        await ctx.sleep(600);
        if (my !== epoch) return;
        if (how === "drop") fadeOut(c, 300);
      }
      const bio = BIOS[(m.bio + 1) % BIOS.length], keep = photo && how === "keep";
      await fly(nodeAt(e), docAt(0), keep ? `{user, bio:'${bio}', photoUrl}` : `{user, bio:'${bio}'}`, 1);
      if (my !== epoch) return;
      m.bio++;
      d.bio = bio;
      d.by = 1;
      if (!photo) {
        record(`Node ${N} (v1) set Maya's bio to '${bio}'`, "ok");
        m.note = [`Node ${N} (v1) loaded Maya's document, changed her bio and saved it whole. Nothing was at risk: ` +
          `the document has no field v1 doesn't know. ${m.v2 ? "Let v2 set her photo, then try again." : "Upgrade a node and let v2 set her photo first."}`, "ok"];
      } else if (keep) {
        record(`Node ${N} (v1) set bio='${bio}' and kept photoUrl`, "ok");
        m.note = [`Node ${N} (v1) kept the unknown <code>photoUrl</code> bytes next to its User object and wrote them back ` +
          "untouched. Forward compatibility includes not destroying what you don't understand.", "ok"];
      } else {
        d.lost = photo;
        d.photo = null;
        m.lost++;
        record(`Node ${N} rewrote Maya's document without photoUrl: photo lost`, "bad");
        m.note = [`Node ${N} (v1) decoded Maya's document into its User object, which has no <code>photoUrl</code>, then ` +
          "saved the whole object back. Maya's photo is gone and nothing logged an error. Ignoring an unknown field " +
          "isn't enough: old code must preserve it.", "bad"];
      }
      draw();
      flashCard(0, 1);
      if (c && keep) fadeOut(c, 300, 900);
      if (photo && !keep) await lostFlash(0, photo);
      rg.remove();
    }

    async function readGrace(my) {
      const r = firstV2();
      if (r < 0) { m.note = NO_V2; draw(); return; }
      const rg = ring(r, 2);
      await fly(docAt(1), nodeAt(r), "{user, bio}", 2);
      if (my !== epoch) return;
      const c = chip(r, "photoUrl = null (default)", "info");
      record(`Node ${NAMES[r]} (v2) read Grace: photoUrl = null (default)`, "ok");
      m.note = [`Grace's document was written by v1 and has no <code>photoUrl</code>; Node ${NAMES[r]} (v2) reads it with ` +
        "the default, null. That's backward compatibility, and documents like this can sit untouched for years.", "ok"];
      draw();
      fadeOut(c, 300, 1800);
      rg.remove();
    }

    async function story(my) {
      const steps = [upgrade, setPhoto, editBio], gaps = [700, 600];
      for (let k = 0; k < steps.length; k++) {
        if (k) { view.fx.innerHTML = ""; await ctx.sleep(gaps[k - 1]); }
        if (my !== epoch) return;
        await steps[k](my);
        if (my !== epoch) return;
      }
    }

    // ---------------------------------------------------------------- notes
    function upgradeNote(i) {
      const rest = NAMES.slice(m.v2);
      return [`Node ${NAMES[i]} now runs v2; ${list(rest)} still run${rest.length > 1 ? "" : "s"} v1. Both versions ` +
        "read and write the same documents until the rollout finishes." +
        (m.docs[0].photo ? "" : " Next: let v2 set Maya's photo."), "info"];
    }
    function allV2Note() {
      const old = m.docs.filter(d => d.by === 1).map(d => d.user + "'s");
      if (!old.length) return ["Every node runs v2.", "ok"];
      const many = old.length > 1;
      return [`Every node runs v2, but ${list(old)} document${many ? "s were" : " was"} last written by v1 and ` +
        `${many ? "stay" : "stays"} that way until something rewrites ${many ? "them" : "it"}: data outlives code.` +
        (m.docs[0].lost ? " Upgrading didn't bring Maya's photo back either: the damage is in the data." : ""),
        m.docs[0].lost ? "warn" : "ok"];
    }
    function modeNote() {
      const tail = " Try a v1 edit on a document v2 has touched.";
      if (mode === "keep") return ["<b>Preserve:</b> v1 keeps fields it doesn't know beside its object and writes them " +
        "back untouched, as current Protobuf libraries do on a round trip." + tail, "info"];
      if (mode === "reject") return ["<b>Reject:</b> v1's decoder fails on fields it doesn't know (Jackson's default, " +
        "<code>FAIL_ON_UNKNOWN_PROPERTIES</code>)." + tail, "info"];
      return ["<b>Drop:</b> v1 decodes each document into its User object, ignoring fields it doesn't know (a typed " +
        "JSON mapper set to ignore unknown properties), then saves that object." + tail, "info"];
    }

    buildScene();
    draw();
    // Rebuild the SVG with the other layout when the frame crosses the phone breakpoint. An
    // in-flight action keeps running and draws into the new scene.
    ctx.onResize(() => {
      if (ctx.compact === compact) return;
      log.lastChild.style.maxHeight = logHeight() + "px";
      buildScene();
      draw();
    });
  },
});
