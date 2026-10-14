// Reference example for ctx.lanes (swimlane timelines). Not shown in the book UI.
Viz.register("_demo/lanes", {
  title: "Lanes demo: reading your own write from a lagging follower",
  mount(root, ctx) {
    const W = ctx.compact ? 360 : 640, H = 210;
    const svg = ctx.svg({ w: W, h: H });
    const tl = ctx.lanes({
      parent: svg, x: 0, y: 6, w: W, h: H - 12, t0: 0, t1: 10,
      lanes: [
        { id: "user", label: "User", color: "c6" },
        { id: "leader", label: "Leader", color: "c1" },
        { id: "follower", label: "Follower", color: "c2" },
      ],
    });
    const lag = ctx.ui.slider({ label: "Replication lag", min: 0, max: 6, step: 0.5, value: 4, format: v => v + "s", onInput: draw });
    const note = ctx.ui.note("");
    function draw() {
      tl.clear();
      const L = lag.get();
      tl.op("user", 0.5, 1.5, { label: "post", tone: "c6" });
      tl.msg("user", 1, "leader", 1.6, { label: "insert" });
      tl.mark("leader", 1.6, { label: "committed", tone: "ok", below: true });
      tl.msg("leader", 1.8, "follower", 1.8 + L, { label: `lag ${L}s`, color: "c1", dashed: true });
      tl.mark("follower", 1.8 + L, { label: "applied", tone: "ok", below: true });
      const stale = 1.8 + L > 3.6;
      tl.msg("user", 3, "follower", 3.6, { label: "reload", color: "c6" });
      tl.op("follower", 3.6, 4.6, { label: stale ? "404!" : "found", tone: stale ? "bad" : "ok" });
      tl.cursor(3.6, { label: "read" });
      note.set(stale ? "The read reached the follower <b>before</b> the write did: the user's own post looks lost."
                     : "The follower caught up before the read arrived, so the user sees their post.", stale ? "bad" : "ok");
    }
    root.append(ctx.ui.bar(lag), svg, note);
    draw();
  },
});
