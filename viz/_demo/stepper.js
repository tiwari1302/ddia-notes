// Reference example for the stepper API (not shown in the book UI; used by tests and
// docs/AUTHORING.md). A write travels client -> leader -> followers, one step at a time.
Viz.register("_demo/stepper", {
  title: "Stepper demo: a replicated write",
  mount(root, ctx) {
    const { s, ui } = ctx;
    const W = ctx.compact ? 360 : 640, H = 230;
    const svg = ctx.svg({ w: W, h: H });
    const scene = s("g");
    const packets = s("g");
    svg.append(scene, packets);

    const pos = ctx.compact
      ? { client: [50, 115], leader: [180, 115], f1: [310, 55], f2: [310, 175] }
      : { client: [80, 115], leader: [300, 115], f1: [540, 55], f2: [540, 175] };
    const log = ui.log({ title: "What happened", height: 110 });

    function nodeAt(key, label, color) {
      const [x, y] = pos[key];
      const n = ctx.node({ x, y, r: 26, label, fill: `var(--viz-${color}-soft)`, stroke: `var(--viz-${color})` });
      n.value = ctx.text(x, y + 42, "x = 0", { size: 12, mono: true, fill: "var(--viz-muted)" });
      n.appendChild(n.value);
      scene.appendChild(n);
      return n;
    }

    const player = ctx.stepper({
      // init() must fully rebuild the scene: "back" calls it and replays steps instantly.
      init() {
        scene.innerHTML = "";
        packets.innerHTML = "";
        log.clear();
        const edge = (a, b) => scene.appendChild(ctx.arrow({ x1: pos[a][0], y1: pos[a][1], x2: pos[b][0], y2: pos[b][1], color: "var(--viz-line)", arrow: false }));
        edge("client", "leader"); edge("leader", "f1"); edge("leader", "f2");
        return {
          client: nodeAt("client", "C", "c6"),
          leader: nodeAt("leader", "L", "c1"),
          f1: nodeAt("f1", "F1", "c2"),
          f2: nodeAt("f2", "F2", "c2"),
        };
      },
      steps: [
        {
          title: "The client sends <b>x = 1</b> to the leader",
          run: async st => {
            await ctx.fly(packets, { from: pos.client, to: pos.leader, label: "x=1", fill: "var(--viz-c6)" });
            st.leader.value.textContent = "x = 1";
            log.add("leader applied x=1", "ok");
          },
        },
        {
          title: "The leader streams the change to both followers",
          detail: "Asynchronous replication: the leader does not wait.",
          run: async st => {
            await Promise.all([
              ctx.fly(packets, { from: pos.leader, to: pos.f1, label: "x=1", fill: "var(--viz-c1)" }),
              ctx.fly(packets, { from: pos.leader, to: pos.f2, label: "x=1", fill: "var(--viz-c1)", ms: 1400 }),
            ]);
            st.f1.value.textContent = "x = 1";
            st.f2.value.textContent = "x = 1";
            log.add("followers caught up", "ok");
          },
        },
        {
          title: "All replicas agree",
          run: async st => {
            [st.leader, st.f1, st.f2].forEach(n => ctx.attr(n.circle, { stroke: "var(--viz-ok)" }));
            log.add("replicas consistent", "info");
          },
        },
      ],
    });

    root.append(svg, player.el, log);
  },
});
