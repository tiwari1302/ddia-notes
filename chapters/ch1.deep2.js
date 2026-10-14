// Chapter 1 deep dive, part 2 (second half of the sections + takeaways). Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch1", {
  sections: [
    // ------------------------------------------------------------------
    {
      id: "queueing",
      title: "Why the queue, not the work, makes requests slow",
      kicker: "Performance",
      concepts: ["head-of-line-blocking", "coordinated-omission", "littles-law"],
      blocks: [
        {
          type: "problem",
          html: `<p>You profile a request handler and it takes <strong>10 ms</strong>, every time. Yet users report pages that hang for two or three seconds, and the dashboard, fed by that same handler timer, insists everything is fine. The naive mental model is <em>response time = work done</em>. It ignores that a server can only work on a few requests at once. Every other request waits in line, and one slow request at the front holds up all the fast ones behind it.</p>
<p>Worse, the usual tools can't see it. A timer inside the handler starts <em>after</em> the wait. A load generator that waits for each reply before sending its next request never lets a queue form, so the benchmark looks great while production suffers.</p>`,
        },
        {
          type: "idea",
          html: `<p>At high percentiles, response time is mostly <strong>waiting</strong>, not working. Measure it where the client is, and load-test with requests sent on a schedule that doesn't depend on how fast the server answers.</p>`,
        },
        {
          type: "text",
          html: `<h3>Where the time actually goes</h3>
<p>The previous section split response time into network, queue and service time. At the median the waiting is small, but in the tail <strong>queueing delay</strong> often makes up most of the p99, and it is the part a handler timer never sees.</p>
<p>The root cause is limited parallelism. A server makes progress on only as many requests as it has cores, worker threads or database connections; the rest wait in a socket backlog, a thread pool's queue or a connection pool. When the request at the front needs 200 ms instead of 10 ms, everything behind it inherits those 200 ms. This is <strong>head-of-line blocking</strong>: the requests behind are cheap to process, but their clients see them as slow. It takes only a handful of slow requests: on a 4-core server, four expensive queries arriving together occupy every core.</p>`,
        },
        {
          type: "diagram",
          title: "Head-of-line blocking",
          svg: `<svg viewBox="0 0 400 160" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="One slow request occupies the only worker while four fast requests wait behind it">
<defs><marker id="ch1d2-hol-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<text x="12" y="24" font-size="12" style="fill: var(--viz-muted)">Queue (10 ms of work each)</text>
<text x="303" y="24" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">Worker (1 core)</text>
<rect x="214" y="34" width="178" height="70" rx="10" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<rect x="226" y="46" width="154" height="46" rx="6" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="303" y="65" font-size="12" font-weight="700" text-anchor="middle">slow request</text>
<text x="303" y="82" font-size="12" text-anchor="middle">200 ms of work</text>
<rect x="12" y="46" width="40" height="46" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<rect x="60" y="46" width="40" height="46" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<rect x="108" y="46" width="40" height="46" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<rect x="156" y="46" width="40" height="46" rx="6" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="32" y="73" font-size="12" text-anchor="middle">fast</text>
<text x="80" y="73" font-size="12" text-anchor="middle">fast</text>
<text x="128" y="73" font-size="12" text-anchor="middle">fast</text>
<text x="176" y="73" font-size="12" text-anchor="middle">fast</text>
<line x1="198" y1="69" x2="211" y2="69" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch1d2-hol-arr)"/>
<text x="32" y="116" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-bad)">240</text>
<text x="80" y="116" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-bad)">230</text>
<text x="128" y="116" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-bad)">220</text>
<text x="176" y="116" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-bad)">210</text>
<text x="303" y="122" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">busy until t = 200 ms</text>
<text x="12" y="136" font-size="12" style="fill: var(--viz-muted)">client-seen response time (ms)</text>
<text x="12" y="152" font-size="12" style="fill: var(--viz-muted)">= waiting (200 to 230 ms) + work (10 ms)</text>
</svg>`,
          caption: "One slow request at the head of the line makes four cheap requests slow. The server did 10 ms of work for each of them, yet their clients waited 210 to 240 ms.",
        },
        {
          type: "text",
          html: `<h3>Why busy servers get slow all at once</h3>
<p>Queues form even without slow requests, because users don't coordinate their clicks and arrivals bunch up. Standard queueing theory (beyond the book, but interviewers reach for it) quantifies this. For the textbook single-server queue, <strong>M/M/1</strong> (Poisson arrivals, exponentially distributed service times):</p>
<span class="formula">mean response time = service time / (1 − utilization)</span>
<p>That is 2× the service time at 50% busy, 5× at 80%, 10× at 90% and 20× at 95%: a 10 ms request averages 200 ms on a 95%-busy server without any code getting slower. There is <strong>no magic threshold</strong> (the folklore "stay under 70%" is just one point on a smooth hockey stick), and <strong>variability makes it worse</strong>: the average wait grows with the variance of service times, so a few very slow requests lengthen the queue for everyone.</p>
<h3>Little's Law: latency becomes capacity</h3>
<p><strong>Little's Law</strong>, <span class="mono">L = λ × W</span>, says the average number of requests in a system equals the arrival rate times the average time each spends inside. It holds for any stable system, whatever the distributions. At 20,000 requests/s and 40 ms, that is <strong>800 requests in flight</strong>, so you need about 800 threads, connections or async slots plus burst headroom. It also explains cascading failure: if a dependency slows from 40 ms to 400 ms at the same traffic, occupied threads grow tenfold, the pool runs dry and the slowness spreads upstream.</p>
<p>The rare stalls that start queues come from garbage-collection pauses (Chapter 8), background compaction in storage engines (Chapter 3), noisy neighbors on shared hardware, and slow downstream dependencies holding threads.</p>`,
        },
        {
          type: "text",
          html: `<p>The simulation below runs one worker with a first-come, first-served queue for a 10-second test. Each dot is a request, placed at its arrival time and colored by how long it took. You control how busy the server is, how many requests are slow, the load generator, a one-second freeze, and where response time is measured.</p>`,
        },
        {
          type: "viz",
          id: "ch1/queueing",
          title: "Queueing and the lying benchmark",
          caption: "Try the <em>Busy server</em> preset, then <em>Server-side timer</em>, then <em>Benchmark lies</em>. Notice that client p99 explodes as utilization nears 100% while the server-side p99 stays near 12 ms, and that the closed-loop benchmark records just one slow sample during the 1-second freeze; the correction toggle recovers most of what it missed.",
        },
        {
          type: "text",
          html: `<h3>Measure where the client is</h3>
<p>The scatter makes the first lesson plain: server-side timer and client disagree by an order of magnitude, and the client is right. A timer that starts with the handler sees only service time, never the accept queue, the thread pool or the GC pause before it. Measure response time on the <strong>client side</strong> (or at the load balancer), and treat handler timings as a diagnostic.</p>
<h3>Load tests that don't lie</h3>
<p>Many load tools run a fixed set of virtual users that each send a request, wait for the reply, then send the next. This <strong>closed-loop</strong> design cooperates with the server: when it stalls, the client stops sending, so the queue real users would build never forms, and a one-second stall shows up as one slow sample instead of one for every request that real users would have sent during it. Real users are <strong>open-loop</strong>: they keep arriving regardless. A load generator must likewise send on schedule, independent of responses, and time each request from its <em>intended</em> send time. Gil Tene named the closed-loop error <strong>coordinated omission</strong>; the book describes the effect without the name.</p>
<p>Old closed-loop results can be partly repaired: HdrHistogram's expected-interval correction records, for a response r and expected interval I, the extra samples r − I, r − 2I, … down to I that a constant-rate client would have collected while it sat waiting. It approximates an open-loop test; it isn't one.</p>
<h3>Living with queues</h3>
<ul>
<li><strong>Keep headroom</strong>; don't plan to run at 95% busy.</li>
<li><strong>Isolate slow work from fast work</strong> with separate pools or queues (bulkheads), so a 200 ms report can't block a 2 ms lookup.</li>
<li><strong>Bound queues and shed load</strong> instead of turning overload into latency for everyone.</li>
<li><strong>Set timeouts that budget for queueing</strong>, and drop requests whose caller has already given up.</li>
</ul>`,
        },
        {
          type: "callout",
          tone: "mistake",
          title: "Two ways to measure your way into false confidence",
          html: `<p>"Our handler p99 is 15 ms, so latency is fine" and "the benchmark's p99 is fine, so we're ready" are the two classic traps. The first ignores queueing; the second never lets a queue form. If a load tool runs a fixed number of users with no target request rate, assume its tail numbers suffer from coordinated omission until you've checked.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Gil Tene / wrk2",
              title: "Coordinated omission, named and fixed",
              tag: "measurement",
              html: `Tene's talk <em>How NOT to Measure Latency</em> popularized the term coordinated omission and showed how closed-loop benchmarks hide stalls. His tool wrk2, a constant-throughput variant of the wrk HTTP benchmark, schedules requests at a fixed rate, measures latency from each request's intended send time, and records results in HdrHistogram.`,
            },
            {
              org: "Discord",
              title: "Periodic GC, periodic spikes",
              year: "2020",
              tag: "GC pauses",
              html: `Periodic GC pauses turn directly into periodic tail-latency spikes. Discord's Go-to-Rust rewrite of a service that stalled every two minutes is the well-known case, and low-pause collectors such as Java's ZGC attack the same problem (<a href="#/ch8/learn/process-pauses">Chapter 8</a>).`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Head-of-line blocking shaped the web's protocols",
          html: `<p>HTTP/1.1 returns responses on a connection in request order, so one slow response delays the rest; browsers worked around this by opening several connections per host. <strong>HTTP/2</strong> (RFC 7540, 2015) multiplexes many streams over one TCP connection, removing the HTTP-level blocking. But TCP delivers bytes strictly in order, so a single lost packet still stalls every stream behind it. <strong>HTTP/3</strong> (RFC 9114, 2022) runs over QUIC (RFC 9000, 2021), which delivers each stream independently, so a lost packet delays only the stream it belongs to.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Latency questions tend to become queueing questions. A strong answer uses <strong>Little's Law</strong> for quick sizing ("20k req/s at 40 ms is about 800 in flight, so size pools for that plus burst headroom"), explains that p99 is dominated by waiting, so you watch <strong>utilization and queue depth</strong> as well as per-request CPU time, measures on the client, and load-tests open-loop at a target rate. For protection it reaches for bounded queues, load shedding and bulkheads rather than ever-larger buffers. Naming coordinated omission, and explaining why it hides tails, is a strong senior signal.</p>`,
        },
        {
          type: "quiz",
          q: "A timer inside your request handler reports p99 = 15 ms, but clients measure p99 = 900 ms. The network is healthy. What is the most likely explanation?",
          options: [
            "Clock skew between the client and the server",
            "Requests wait in a queue before the handler (and its timer) starts; queueing and head-of-line blocking are invisible to server-side timing",
            "The client is computing percentiles incorrectly",
            "The handler is CPU-bound, so its timer runs slowly",
          ],
          answer: 1,
          explain: "The handler's timer measures only service time. Waiting for a worker, behind a slow request, during a GC pause or simply at high utilization is part of the response time but happens before the timer starts, which is why response time should be measured on the client. Clock skew (A) is tempting but irrelevant: each side measures a duration on its own clock, so an offset between clocks cancels out. A percentile bug (C) wouldn't produce a consistent 60× gap, and a wall-clock timer doesn't slow down when the CPU is busy (D).",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "tail-latency",
      title: "Why the slowest call wins",
      kicker: "Performance",
      concepts: ["tail-latency-amplification", "hedged-requests"],
      blocks: [
        {
          type: "problem",
          html: `<p>Modern pages are assembled from many backend calls. A search query goes to every shard of the index; a product page asks dozens of services for price, stock, reviews and recommendations. If each backend is fast 99% of the time, that feels safe. But the user waits for the <em>slowest</em> call, so a backend's rare slowness is multiplied by the fan-out: with 100 parallel calls, about <strong>63% of page loads</strong> hit at least one slow call.</p>
<p>Making the average call faster barely helps. Shave 2 ms off every backend's median and the slow page loads are just as slow as before, because each is held hostage by whichever call landed in the tail.</p>`,
        },
        {
          type: "idea",
          html: `<p>When one request waits for many calls, the backends' rare tail becomes the user's common case. Either <strong>reduce the fan-out</strong>, or build the system to <strong>tolerate the tail</strong>, for example by hedging slow calls.</p>`,
        },
        {
          type: "diagram",
          title: "The page waits for the slowest call",
          svg: `<svg viewBox="0 0 400 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A web server fans out to five backends in parallel; four answer in under 20 ms, one takes 900 ms, so the user waits 900 ms">
<defs><marker id="ch1d2-fan-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="6" y="104" width="56" height="40" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="34" y="129" font-size="12" font-weight="700" text-anchor="middle">User</text>
<line x1="64" y1="124" x2="83" y2="124" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch1d2-fan-arr)"/>
<rect x="86" y="98" width="72" height="52" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="122" y="120" font-size="12" text-anchor="middle">Web</text>
<text x="122" y="136" font-size="12" text-anchor="middle">server</text>
<line x1="160" y1="124" x2="193" y2="34" style="stroke: var(--viz-muted)" marker-end="url(#ch1d2-fan-arr)"/>
<line x1="160" y1="124" x2="193" y2="76" style="stroke: var(--viz-muted)" marker-end="url(#ch1d2-fan-arr)"/>
<line x1="160" y1="124" x2="193" y2="118" style="stroke: var(--viz-muted)" marker-end="url(#ch1d2-fan-arr)"/>
<line x1="160" y1="124" x2="193" y2="160" style="stroke: var(--viz-muted)" marker-end="url(#ch1d2-fan-arr)"/>
<line x1="160" y1="124" x2="193" y2="202" style="stroke: var(--viz-muted)" marker-end="url(#ch1d2-fan-arr)"/>
<rect x="196" y="20" width="44" height="28" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="196" y="62" width="44" height="28" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="196" y="104" width="44" height="28" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="196" y="146" width="44" height="28" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="196" y="188" width="44" height="28" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="218" y="39" font-size="12" text-anchor="middle">B1</text>
<text x="218" y="81" font-size="12" text-anchor="middle">B2</text>
<text x="218" y="123" font-size="12" text-anchor="middle">B3</text>
<text x="218" y="165" font-size="12" text-anchor="middle">B4</text>
<text x="218" y="207" font-size="12" text-anchor="middle">B5</text>
<text x="248" y="12" font-size="12" style="fill: var(--viz-muted)">latency (not to scale)</text>
<rect x="248" y="28" width="16" height="12" rx="2" style="fill: var(--viz-ok)"/>
<rect x="248" y="70" width="19" height="12" rx="2" style="fill: var(--viz-ok)"/>
<rect x="248" y="112" width="12" height="12" rx="2" style="fill: var(--viz-ok)"/>
<rect x="248" y="154" width="96" height="12" rx="2" style="fill: var(--viz-bad)"/>
<rect x="248" y="196" width="24" height="12" rx="2" style="fill: var(--viz-ok)"/>
<text x="270" y="39" font-size="12">12 ms</text>
<text x="273" y="81" font-size="12">15 ms</text>
<text x="266" y="123" font-size="12">9 ms</text>
<text x="350" y="165" font-size="12" font-weight="700" style="fill: var(--viz-bad)">900 ms</text>
<text x="278" y="207" font-size="12">20 ms</text>
<line x1="344" y1="20" x2="344" y2="224" style="stroke: var(--viz-bad); stroke-dasharray: 4 4"/>
<text x="392" y="243" font-size="12" font-weight="700" text-anchor="end" style="fill: var(--viz-bad)">user waits for the slowest: 900 ms</text>
</svg>`,
          caption: "Five calls run in parallel. Four finish within 20 ms, one takes 900 ms, and the page can't render until the last one returns: end-user latency is the maximum of the parallel calls, not their average.",
        },
        {
          type: "text",
          html: `<h3>The arithmetic of fan-out</h3>
<p>The section on describing performance argued for percentiles over averages. They matter most where one user action triggers many backend calls. Issuing the calls in parallel shortens the typical case, but the user's request can only complete once its last call is back, so one straggler is enough to make the whole page slow.</p>
<p>If each call is independently slow with probability <em>p</em> and the page makes <em>n</em> calls, the page is fast only when every call is fast:</p>
<span class="formula">P(page slow) = 1 − (1 − p)<sup>n</sup></span>
<p>With p = 1% (by definition, the backend's p99 tail) and n = 100, that is 1 − 0.99<sup>100</sup> ≈ <strong>63%</strong>. At n = 69 it is about 50%: <em>the backend's p99 has become the page's median</em>. This is <strong>tail latency amplification</strong>; the book cites Jeff Dean and Luiz André Barroso's 2013 paper "The Tail at Scale" for it. Sequential calls are no better, because their latencies add up and every hop is another chance to land in the tail.</p>
<p>Below, the page on the left fans out to a grid of backend calls, and the curve shows the probability of a slow page as fan-out grows. Each sample marks which calls were slow.</p>`,
        },
        {
          type: "viz",
          id: "ch1/tail-latency",
          title: "Tail latency amplification",
          caption: "Try dragging fan-out to 100 with 1% slow calls, then switch on <em>Hedge slow calls</em>. Notice that 63% of page loads are slow without hedging, and only about 1% with it, for roughly 1% extra backend load. That rests on the model stated under the controls: slowness independent across replicas, and a hedge that fires just above normal latency.",
        },
        {
          type: "text",
          html: `<h3>What it means for latency targets</h3>
<p>Turn the formula around and it tells you how good each backend has to be. For a page making 50 parallel calls to be fast 99% of the time, each call must be fast with probability 0.99<sup>1/50</sup> ≈ <strong>99.98%</strong>. Per-backend targets therefore sit far deeper in the tail than the page target, which is why large services track p99.9 and beyond for internal calls even when no single user would notice one slow request in a thousand. Amazon's Dynamo paper notes that rendering one page can involve requests to over 150 services, which helps explain why its internal SLAs are written at p99.9.</p>
<p>There are two levers. The first is to <strong>reduce fan-out</strong>: batch lookups into one call, cache or precompute results (the precomputed Twitter timelines from the section on describing load are exactly this), or take services off the critical path. The second is to make the system <strong>tail-tolerant</strong>: accept that some calls will be slow and route around them. The techniques below come from "The Tail at Scale", not from the book's own text.</p>`,
        },
        {
          type: "steps",
          title: "How a hedged request works",
          items: [
            "Send the request to one replica, as usual.",
            "Start a timer set just above normal latency. \"The Tail at Scale\" suggests the 95th-percentile latency for that kind of request.",
            "If no reply has arrived when the timer fires, send the same request to a second replica.",
            "Use whichever reply arrives first.",
            "Cancel (or simply ignore) the other copy so it wastes as little work as possible.",
          ],
        },
        {
          type: "text",
          html: `<p>Because the hedge delay sits just above normal latency, only calls that are already in trouble get a backup, and a rescued call costs roughly the delay plus one normal reply, far below the slow tail. With a p95 delay, at most about 5% of calls are duplicated. The p² result in the viz needs one strong assumption: the backup's slowness must be <strong>independent</strong> of the primary's. That holds for a GC pause or a busy disk on one machine, and fails when the cause is shared: if every replica is overloaded or a bad deploy slowed them all, the backup is just as slow and the extra requests deepen the overload. Hedge only idempotent requests, such as reads, and cap the hedge rate.</p>
<p>The same paper describes related techniques. <strong>Tied requests</strong> enqueue a request on two servers that know about each other; whichever starts executing first tells the other to cancel, which targets queueing delay with little duplicated work. Search-style systems can return <strong>good-enough results</strong> once most shards have answered. <strong>Micro-partitioning</strong> (many more partitions than machines) and <strong>selective replication</strong> of hot items let load move in small pieces. <strong>Latency-induced probation</strong> temporarily stops sending traffic to a consistently slow machine while probing it with a trickle of requests.</p>
<p>Batch processing has the same shape: a job finishes only when its slowest task, the <strong>straggler</strong>, finishes. MapReduce's answer, launching backup copies of the last few running tasks, is hedging by another name (Chapter 10).</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Google",
              year: "2013",
              title: "The Tail at Scale",
              html: `Dean and Barroso's example: if a server is slow (one second or more) for 1 in 100 requests, a user request that needs answers from 100 such servers is slow 63% of the time. In a BigTable benchmark reading 1,000 keys spread over 100 servers, hedging after 10 ms cut the 99.9th-percentile latency from 1,800 ms to 74 ms while sending just 2% more requests.`,
            },
            {
              org: "Apache Cassandra",
              title: "Hedged reads inside the database",
              tag: "speculative retry",
              html: `Each table has a <code>speculative_retry</code> setting (default <code>99p</code>): if the replica being read hasn't responded within the table's 99th-percentile read latency, the coordinator sends a redundant read to another replica. Hedging built into a database.`,
            },
            {
              org: "gRPC and Envoy",
              title: "Hedging as configuration",
              tag: "infrastructure",
              html: `gRPC's service config can declare a hedging policy (send several copies of an RPC spaced by a delay, keep the first successful response), and the Envoy proxy can hedge on per-try timeouts. Hedging is available as infrastructure rather than hand-written client code.`,
            },
          ],
        },
        {
          type: "tradeoffs",
          title: "Tail-tolerant techniques: what they buy and what they cost",
          prosLabel: "What you gain",
          consLabel: "What you pay",
          pros: [
            "Hedging removes most independent, single-machine slowness (GC pauses, busy disks) for a few percent extra load.",
            "Tied requests attack queueing delay with very little duplicated work.",
            "Good-enough results put a hard bound on latency, whatever the slowest shard does.",
            "Reducing fan-out (batching, caching, precomputing) removes the cause rather than treating the symptom.",
          ],
          cons: [
            "Duplicate requests add load and can deepen an overload; rate-limit hedging.",
            "Only safe for idempotent requests, such as reads or writes carrying an idempotency key.",
            "Useless when slowness is correlated across replicas (shared overload, bad deploy everywhere).",
            "Partial results trade completeness for speed; not every product can accept that.",
            "Precomputation moves cost to the write path (the Twitter fan-out trade-off).",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>A classic follow-up to "design a search page / feed / product page" is: <em>each backend has a p99 of 100 ms; what is the page's p99?</em> A strong answer computes it (1 − 0.99<sup>n</sup>), notes that with large n the backends' tail sets the page's <em>typical</em> latency, derives the tighter per-backend target (0.99<sup>1/n</sup>), and offers both levers: cut fan-out, and tolerate the tail with hedged requests after the p95. Then it adds the caveats unprompted: hedging needs idempotent requests and independent slowness, and it should be rate-limited so it can't amplify an overload.</p>`,
        },
        {
          type: "quiz",
          q: "Each backend call is slow 1% of the time, independently. A page makes 69 backend calls in parallel and waits for all of them. Roughly what fraction of page loads are slow?",
          options: ["About 1%", "About 0.7%", "About 50%", "About 69%"],
          answer: 2,
          explain: "The page is fast only if all 69 calls are fast: 0.99^69 ≈ 0.50, so about half of all page loads are slow, and the backend's p99 has become the page's median. 69% (D) comes from adding 69 × 1%, which double-counts pages with several slow calls; 1% (A) assumes the page simply inherits the backend's tail and ignores the fan-out; 0.7% (B) has the effect backwards, since parallelism can't make the page less likely to be slow than a single call.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "coping-with-load",
      title: "Scaling up, scaling out, and rethinking every 10x",
      kicker: "Scalability",
      concepts: ["scaling-up-vs-scaling-out", "shared-nothing", "elasticity"],
      blocks: [
        {
          type: "problem",
          html: `<p>Load grows tenfold and the architecture that coped yesterday starts to crack: the single database server pins its CPU, a queue backs up, the nightly job no longer fits in the night. Both reflexes are expensive. Buying ever-bigger machines gets pricier faster than it gets faster, and eventually there is no bigger machine to buy. Distributing everything from day one drags in partitioning, replication and consistency problems you may never have needed.</p>
<p>Capacity planning has the same trap in time: a fleet sized for the daily peak sits mostly idle at 4 a.m., while one sized for the average falls over at the first spike. And there is no off-the-shelf "scalable architecture" to copy, only designs that fit particular load parameters.</p>`,
        },
        {
          type: "idea",
          html: `<p>Architectures are <strong>bets on load</strong>. Scale up while it's cheap, scale out when you must, use elasticity where load is unpredictable, and expect to rethink the design at every order of magnitude.</p>`,
        },
        {
          type: "text",
          html: `<h3>Every order of magnitude is a new problem</h3>
<p>With a load parameter and a percentile target in hand, the question becomes how to keep performance good as the parameter grows. A design that works well at one level of load rarely survives ten times that load, so on a fast-growing service expect to rethink the architecture at roughly every order-of-magnitude increase, sometimes sooner. The bottleneck keeps moving: first web-tier CPU, then database writes, then the size of one table, then cross-datacenter bandwidth.</p>
<p>There are two basic moves. <strong>Scaling up</strong> (vertical scaling) means moving to a more powerful machine. <strong>Scaling out</strong> (horizontal scaling) means spreading the load across many smaller machines, which is also called a <strong>shared-nothing</strong> architecture: each node has its own CPU, memory and disks, and nodes coordinate only by sending messages over the network.</p>`,
        },
        {
          type: "diagram",
          title: "Two directions to grow",
          svg: `<svg viewBox="0 0 400 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Scale up: one big machine approaching a ceiling. Scale out: six independent nodes connected by a network">
<defs><marker id="ch1d2-up-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<line x1="200" y1="8" x2="200" y2="212" style="stroke: var(--viz-grid)"/>
<text x="96" y="20" font-size="12" font-weight="700" text-anchor="middle">Scale up</text>
<text x="96" y="38" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">largest machine you can buy</text>
<line x1="16" y1="46" x2="176" y2="46" style="stroke: var(--viz-bad); stroke-dasharray: 5 4"/>
<rect x="56" y="62" width="80" height="108" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="96" y="112" font-size="12" text-anchor="middle">one big</text>
<text x="96" y="128" font-size="12" text-anchor="middle">machine</text>
<line x1="156" y1="164" x2="156" y2="66" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch1d2-up-arr)"/>
<text x="96" y="192" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">simple, but cost rises</text>
<text x="96" y="208" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">faster than capacity</text>
<text x="305" y="20" font-size="12" font-weight="700" text-anchor="middle">Scale out (shared-nothing)</text>
<line x1="216" y1="103" x2="394" y2="103" style="stroke: var(--viz-c2); stroke-width: 2"/>
<line x1="247" y1="84" x2="247" y2="122" style="stroke: var(--viz-c2)"/>
<line x1="305" y1="84" x2="305" y2="122" style="stroke: var(--viz-c2)"/>
<line x1="363" y1="84" x2="363" y2="122" style="stroke: var(--viz-c2)"/>
<text x="276" y="99" font-size="12" text-anchor="middle" style="fill: var(--viz-c2)">network</text>
<rect x="222" y="50" width="50" height="34" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="280" y="50" width="50" height="34" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="338" y="50" width="50" height="34" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="222" y="122" width="50" height="34" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="280" y="122" width="50" height="34" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="338" y="122" width="50" height="34" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="247" y="72" font-size="12" text-anchor="middle">node</text>
<text x="305" y="72" font-size="12" text-anchor="middle">node</text>
<text x="363" y="72" font-size="12" text-anchor="middle">node</text>
<text x="247" y="144" font-size="12" text-anchor="middle">node</text>
<text x="305" y="144" font-size="12" text-anchor="middle">node</text>
<text x="363" y="144" font-size="12" text-anchor="middle">node</text>
<text x="305" y="174" font-size="12" text-anchor="middle">each: own CPU, RAM, disk</text>
<text x="305" y="192" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">add machines, but you must</text>
<text x="305" y="208" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">partition and replicate state</text>
</svg>`,
          caption: "Scaling up keeps one simple machine and runs into a ceiling. Scaling out has no hard ceiling, but turns your data into a distributed-systems problem.",
        },
        {
          type: "compare",
          title: "Three ways to add capacity",
          items: [
            {
              title: "Scale up",
              tone: "info",
              html: `One more powerful machine. All data in one place, no network between components, single-node transactions. But high-end hardware costs disproportionately more per unit of capacity, there is a ceiling, and one machine is one failure domain.`,
            },
            {
              title: "Scale out (shared-nothing)",
              tone: "warn",
              html: `Many ordinary machines. Capacity grows by adding nodes, and nodes can fail or be taken down one at a time. But state must be partitioned and replicated, and you inherit network faults, consistency questions and harder operations.`,
            },
            {
              title: "Pragmatic mix",
              tone: "ok",
              html: `What most real systems do: a few fairly powerful machines rather than hundreds of tiny VMs, scaling up the stateful core and scaling out the stateless tiers. Often simpler and cheaper than either extreme.`,
            },
          ],
        },
        {
          type: "text",
          html: `<h3>Stateless is easy, state is hard</h3>
<p>A <strong>stateless</strong> web or API tier can be cloned behind a load balancer: any instance can serve any request, so adding instances adds capacity almost for free. A <strong>stateful</strong> data system is different. Once data lives on several nodes you must decide which node owns what (partitioning, Chapter 6), keep copies in sync (replication, Chapter 5), and stay correct when the network misbehaves (Chapters 8 and 9). That is why, at the time of the book (2017), the conventional advice was to scale the database up on one node for as long as possible, and distribute it only when the price of a bigger machine or the need for high availability left no choice. The book also predicted that, as distributed tools and abstractions improved, distributed data systems might become the default even for modest workloads.</p>
<p>Scaling up has a blind spot: it does nothing for fault tolerance. However large, one machine is one failure domain, so even a scaled-up database normally runs with at least one replica, and <strong>availability drives scale-out as often as load does</strong>. Part II of the book starts from three architectures: <em>shared-memory</em> (one big machine), <em>shared-disk</em> (several machines sharing one storage array) and <em>shared-nothing</em> (independent nodes on a network), and focuses on the last.</p>`,
        },
        {
          type: "diagram",
          title: "Same throughput, different systems",
          svg: `<svg viewBox="0 0 400 236" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left: 100,000 one-kilobyte requests per second into many small servers. Right: three two-gigabyte uploads per minute into one storage box. Both are about 100 MB/s">
<defs><marker id="ch1d2-tp-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="120" y="6" width="160" height="26" rx="13" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<text x="200" y="24" font-size="12" font-weight="700" text-anchor="middle">≈ 100 MB/s each</text>
<line x1="200" y1="40" x2="200" y2="228" style="stroke: var(--viz-grid)"/>
<text x="100" y="56" font-size="12" font-weight="700" text-anchor="middle">100,000 req/s × 1 kB</text>
<line x1="20" y1="72" x2="180" y2="72" style="stroke: var(--viz-c6); stroke-width: 5; stroke-dasharray: 8 6"/>
<line x1="26" y1="82" x2="180" y2="82" style="stroke: var(--viz-c6); stroke-width: 5; stroke-dasharray: 8 6"/>
<line x1="20" y1="92" x2="180" y2="92" style="stroke: var(--viz-c6); stroke-width: 5; stroke-dasharray: 8 6"/>
<line x1="26" y1="102" x2="180" y2="102" style="stroke: var(--viz-c6); stroke-width: 5; stroke-dasharray: 8 6"/>
<line x1="100" y1="110" x2="100" y2="124" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch1d2-tp-arr)"/>
<rect x="32" y="128" width="24" height="24" rx="4" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<rect x="60" y="128" width="24" height="24" rx="4" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<rect x="88" y="128" width="24" height="24" rx="4" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<rect x="116" y="128" width="24" height="24" rx="4" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<rect x="144" y="128" width="24" height="24" rx="4" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="100" y="176" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">tiny requests: overhead</text>
<text x="100" y="192" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">and concurrency dominate</text>
<text x="100" y="222" font-size="12" text-anchor="middle">100,000 × 1 kB = 100 MB/s</text>
<text x="300" y="56" font-size="12" font-weight="700" text-anchor="middle">3 req/min × 2 GB</text>
<rect x="238" y="68" width="40" height="34" rx="4" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<rect x="280" y="68" width="40" height="34" rx="4" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<rect x="322" y="68" width="40" height="34" rx="4" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="258" y="90" font-size="12" text-anchor="middle">2 GB</text>
<text x="300" y="90" font-size="12" text-anchor="middle">2 GB</text>
<text x="342" y="90" font-size="12" text-anchor="middle">2 GB</text>
<line x1="300" y1="110" x2="300" y2="124" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch1d2-tp-arr)"/>
<rect x="258" y="128" width="84" height="26" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="300" y="146" font-size="12" text-anchor="middle">storage</text>
<text x="300" y="176" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">huge objects: transfer time</text>
<text x="300" y="192" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">and bandwidth dominate</text>
<text x="300" y="222" font-size="12" text-anchor="middle">3 × 2 GB ÷ 60 s = 100 MB/s</text>
</svg>`,
          caption: "Both systems move about 100 MB/s. One is dominated by per-request overhead and concurrency, the other by long transfers and storage bandwidth: same throughput, completely different architectures.",
        },
        {
          type: "text",
          html: `<h3>There is no magic scaling sauce</h3>
<p>Systems that run at large scale end up shaped by their particular workload. What makes one hard is read volume, another write volume, a third sheer data size; others struggle with data complexity, strict response-time targets or awkward access patterns, and usually it is several at once. The diagram makes the point: 100,000 requests/s of 1 kB and three 2 GB uploads per minute both come to about 100 MB/s, yet one needs cheap handling of huge numbers of tiny concurrent requests and the other needs resumable multi-gigabyte transfers. A design for one is useless for the other.</p>
<p>A scalable architecture is therefore built on <strong>assumptions</strong> about which operations will be common and which rare, which is exactly what load parameters capture. Bet wrong and the scaling work buys nothing, or worse, makes the system harder to adapt: you paid complexity for load that never came and still can't handle the load that did. In an early-stage startup or unproven product, iterating quickly on features usually matters more than scaling for a hypothetical future. The consolation is that bespoke architectures are assembled from general-purpose building blocks (replication, partitioning, caches, logs, batch and stream processing) in familiar patterns, and those are what the rest of the book teaches.</p>
<p>Capacity also has a time dimension. The sandbox below runs a synthetic 24-hour day of demand, measured in servers' worth of load, against either a fixed fleet or an auto-scaler, and shows what fails and what you pay for.</p>`,
        },
        {
          type: "viz",
          id: "ch1/elastic-scaling",
          title: "Fixed fleet vs auto-scaling",
          caption: "Try <em>Flash sale</em> with the manual fleet, then switch to <em>Elastic</em>, then turn on <em>Pre-scale for the 12:00 sale</em>. Notice that the fixed fleet pays for the peak all day yet still fails during the sale, auto-scaling saves server-hours but lags the jump by its scale-up delay, and only planning ahead handles a known spike cleanly. (Synthetic model; units are servers of load.)",
        },
        {
          type: "text",
          html: `<h3>Elastic or manual?</h3>
<p>With <strong>elastic</strong> scaling, the system watches its own load and provisions or releases machines without anyone asking. With manual scaling, a person reviews capacity and decides when to add machines. As the sandbox shows, elasticity shines when load is unpredictable but changes gradually: it follows the daily curve or steady viral growth and stops you paying for peak capacity at 4 a.m. It struggles with sudden jumps, because reacting takes time (detect the load, boot instances, warm caches), and a known event is better handled by scheduling capacity in advance than by reacting to it.</p>
<p>Manual scaling is less clever but more predictable: nothing moves unless someone moves it. That matters most for stateful systems, where adding a node means moving data, and automatic rebalancing in the middle of an overload can make things worse (Chapter 6). Many teams auto-scale the stateless tiers and scale databases deliberately.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "WhatsApp",
              title: "Two million connections on one server",
              year: "2012",
              tag: "scale up first",
              html: `In a January 2012 blog post ("1 million is so 2011"), WhatsApp reported more than 2 million concurrent TCP connections on a single FreeBSD server running its Erlang stack: squeezing a great deal out of each machine before adding more.`,
            },
            {
              org: "Stack Overflow",
              title: "A small fleet of big machines",
              year: "2016",
              tag: "scale up first",
              html: `Nick Craver's 2016 architecture write-up described Stack Overflow serving on the order of 200 million HTTP requests a day from a small fleet of physical servers: about nine web servers and a handful of SQL Server machines. A deliberate scale-up strategy.`,
            },
            {
              org: "Discord",
              title: "Storage redesigned as volume grew",
              year: "2017 → 2023",
              tag: "rethink at 10x",
              html: `Discord moved message storage from MongoDB to Cassandra ("How Discord Stores Billions of Messages", 2017), then to ScyllaDB ("How Discord Stores Trillions of Messages", 2023), reporting the cluster shrinking from 177 Cassandra nodes to 72 ScyllaDB nodes. The storage design was rethought as volume grew by orders of magnitude.`,
            },
            {
              org: "Google",
              title: "Design for 10x, rewrite before 100x",
              tag: "design advice",
              html: `Jeff Dean's design talks from around 2009 advised designing for roughly ten times growth, while expecting that a design right for X will rarely be right for 100 times X, so plan to rethink or rewrite well before then.`,
            },
          ],
        },
        {
          type: "tradeoffs",
          title: "Scale up or scale out?",
          prosLabel: "Scale up wins when…",
          consLabel: "Scale out wins when…",
          pros: [
            "The data and write load still fit comfortably on one large machine.",
            "You want simple transactions and strong consistency without distributed coordination.",
            "The team is small and operational simplicity is worth more than hardware cost.",
            "Load is predictable enough to buy capacity ahead of time.",
          ],
          cons: [
            "Data volume or write throughput exceeds what the largest affordable machine can handle.",
            "You must survive the loss of a machine, rack or datacenter.",
            "Users are spread worldwide and need low latency from nearby regions.",
            "Load is spiky enough that elastic capacity is cheaper than peak-sized hardware.",
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Distributed by default, partly",
          html: `<p>The book's prediction has partly come true, mostly through managed services. Serverless and on-demand capacity (AWS Lambda in 2014, DynamoDB on-demand capacity in 2018, Aurora Serverless) let you pay per request without sizing a fleet. Distributed SQL databases (Google Spanner, CockroachDB, YugabyteDB, and Amazon Aurora DSQL, announced in 2024) offer SQL and transactions over shared-nothing storage and hide much of the partitioning and replication. At the same time single machines kept growing, to hundreds of cores and terabytes of RAM, so scaling up stays viable for far longer than it used to. Both paths got easier; the trade-offs underneath didn't go away.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Interviewers want to see you scale <em>in response to a named bottleneck</em>, not by reflex. A strong answer starts with the simplest design that meets today's load with headroom (often stateless app servers behind a load balancer and one well-provisioned database primary with a replica), names which load parameter will break it first and at roughly what multiple, and then scales in order: more stateless instances, caches and read replicas for read-heavy load, and partitioning only when writes or data volume outgrow one machine. It mentions that elasticity suits the stateless tier and that predictable peaks (launches, sales) should be provisioned in advance. "I'd shard from day one" with no load justification is a common weak signal.</p>`,
        },
        {
          type: "quiz",
          q: "System A handles 100,000 requests/s of 1 kB each; system B handles 3 uploads per minute of 2 GB each. Both move about 100 MB/s. What follows?",
          options: [
            "They can share an architecture, since their throughput is the same",
            "They need very different architectures, because their load parameters (request rate vs object size and duration) differ",
            "B is simpler because it has fewer requests",
            "A must scale up and B must scale out",
          ],
          answer: 1,
          explain: "Throughput alone doesn't determine the design. A is dominated by per-request overhead and concurrency; B by long transfers, resumability and storage bandwidth. Option A is the tempting one because the bytes per second match, but bytes per second is only one load parameter. B's low request count doesn't make it simple (C), and neither scaling direction follows from these numbers alone (D): you design around the load parameters that dominate.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "operability",
      title: "Most of the cost comes after launch",
      kicker: "Maintainability",
      concepts: ["maintainability", "operability"],
      blocks: [
        {
          type: "problem",
          html: `<p>Imagine it is 3 a.m. and the on-call engineer's phone lights up with 40 alerts at once. The runbook links to a dashboard that was deleted last year. The only person who understood the replication setup left in the spring. The one obvious recovery command restarts every node at the same time, because the tool has no "one at a time" mode. None of this is a bug in the code, yet users are down for hours.</p>
<p>The naive view treats operations as somebody else's job once the code is merged. But most of a system's cost arrives after launch, and because human and configuration errors are among the leading causes of outages (see the section on fault types), a system that is hard to operate is, in practice, an unreliable one.</p>`,
        },
        {
          type: "idea",
          html: `<p>Design for the people who will run the system. <strong>Visibility</strong> into what it is doing, <strong>automation with manual override</strong>, <strong>predictable behavior</strong> and sensible defaults are what keep it reliable year after year.</p>`,
        },
        {
          type: "text",
          html: `<h3>The long tail of a system's life</h3>
<p>Writing the first version is the cheap part. The expensive part is the years that follow: bug fixes, keeping it up, failure investigations, ports to new platforms, adaptations to new uses, technical-debt repayment and new features. A system that lives for a decade spends only a small slice of that decade on its first release.</p>
<p>Few engineers enjoy inheriting a legacy system: cleaning up after someone else, coaxing an outdated platform along, forcing the system into jobs it was never designed for. No two legacy systems are miserable in quite the same way, so there is no universal cure. What we can do is design so that maintenance hurts less, and avoid writing tomorrow's legacy software today. The book breaks that goal into three design principles.</p>`,
        },
        {
          type: "keypoints",
          title: "Maintainability in three principles",
          items: [
            "<strong>Operability:</strong> the people running the system in production can keep it healthy with little friction.",
            "<strong>Simplicity:</strong> new engineers can understand the system quickly, because as much complexity as possible has been removed. This concerns the internals, not a minimal user interface.",
            "<strong>Evolvability:</strong> engineers can change the system later for needs nobody foresaw. Also known as extensibility, modifiability or plasticity.",
          ],
        },
        {
          type: "text",
          html: `<h3>Operability: good software needs good operations</h3>
<p>Operators like to point out an asymmetry: a strong operations team can often compensate for weak or unfinished software, while even excellent software won't run reliably if it is operated badly. Operations is not a cleanup crew for the code; it is half of what makes the system work.</p>
<p>Some operational work can and should be automated: failover, scaling, certificate renewal, rolling deploys. But automation doesn't take humans out of the loop, it moves them. People still have to set the automation up, make sure it works correctly, decide what should happen in situations nobody foresaw, and notice when it is quietly doing the wrong thing. A good operations team is typically responsible for the following.</p>`,
        },
        {
          type: "list",
          title: "What an operations team is responsible for",
          items: [
            "Watching the system's health, and getting service back fast when it degrades.",
            "Finding the root causes of failures and performance regressions.",
            "Applying updates and security patches to software and platforms.",
            "Understanding how systems interact, so a harmful change is caught before it ships.",
            "Spotting future problems early, such as capacity running out, and fixing them in advance.",
            "Setting up sound deployment and configuration-management practices and tooling.",
            "Handling complex maintenance, like migrating an application to a new platform.",
            "Keeping things secure while the configuration keeps changing.",
            "Creating processes that make operations predictable and production stable.",
            "Keeping knowledge about the system alive as people join and leave.",
          ],
        },
        {
          type: "text",
          html: `<p>The last item is the one the 3 a.m. scenario failed on, and it is the hardest to automate. For most of the others, the data system itself can make routine work easy or painful. Here is what helping looks like.</p>`,
        },
        {
          type: "table",
          title: "How a data system can make operations easy",
          headers: ["The system should…", "Why it helps operators", "For example"],
          rows: [
            ["Give visibility into its runtime behavior and internals", "You can't fix what you can't see; good metrics point at the cause, not only the symptom", "Per-replica replication lag, queue depth, slow-query logs"],
            ["Support automation and integrate with standard tools", "Routine tasks become reviewed scripts instead of commands typed by hand at 3 a.m.", "Admin APIs, standard metrics endpoints, configuration as code"],
            ["Avoid depending on individual machines", "Any machine can be taken down for patching while the system keeps serving", "Rolling restarts across replicas"],
            ["Document an easy-to-understand operational model", "Operators can predict \"if I do X, Y will happen\" before they act", "A written failover procedure that says what clients see during it"],
            ["Ship good defaults, but let administrators override them", "Safe out of the box without trapping experts", "Sensible timeouts and pool sizes that can be tuned"],
            ["Heal itself where appropriate, but allow manual control", "Automation handles the common case; humans handle what it didn't foresee", "Automatic failover that can be paused during maintenance"],
            ["Behave predictably and minimize surprises", "Surprises during an incident are what make outages long", "No hidden background job that suddenly saturates the disk"],
          ],
        },
        {
          type: "text",
          html: `<p>Much of this is reliability engineering in disguise. Tooling that makes the safe action the easy one, such as a rollout that proceeds one region at a time by default, or a capacity-removal command that refuses to drop below a safe minimum, prevents the next human-error outage more cheaply than any amount of redundancy.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "GitLab",
              title: "Backups nobody had restored",
              year: "Jan 2017",
              tag: "untested backups",
              html: `In January 2017 an engineer deleted GitLab's primary database directory by mistake, and only during recovery did the team find that its regular backups had been failing unnoticed; about six hours of database data was lost. The operability lesson: monitor that backups succeed and rehearse restores, because a backup job fails as quietly as anything else (<a href="#/ch12/learn/trust-but-verify">full story in Chapter 12</a>).`,
            },
            {
              org: "Knight Capital",
              title: "One missed server, 45 minutes",
              year: "Aug 2012",
              tag: "manual deploy",
              html: `Knight Capital's loss of more than $440 million in about 45 minutes began with a manual deploy that missed one of eight servers (<a href="#/ch4/learn/field-tags-evolution">the full story is in Chapter 4</a>). The SEC's $12 million fine cited inadequate deployment controls and reviews: an operability failure as much as a code one.`,
            },
            {
              org: "Amazon S3",
              title: "Tools that refuse unsafe input",
              year: "2017",
              tag: "safer tooling",
              html: `After the February 2017 us-east-1 outage, caused by a mistyped input to a routine command (<a href="#/ch1/learn/fault-types">above</a>), AWS changed the capacity-removal tool to remove capacity more slowly and to refuse any operation that would take a subsystem below its minimum required capacity: making the safe thing the easy thing.`,
            },
            {
              org: "Google SRE",
              title: "A cap on toil",
              year: "2016",
              tag: "toil and error budgets",
              html: `Google's <em>Site Reliability Engineering</em> book says SREs should spend at most 50% of their time on operational "toil" and the rest on engineering that reduces future toil, and introduces error budgets as a shared contract between development speed and reliability.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Operability became a discipline",
          html: `<p>Since 2017 operability has acquired its own vocabulary and tools. <strong>Site Reliability Engineering</strong> made toil budgets and <strong>error budgets</strong> (the unreliability an SLO allows, spent on releases and experiments) mainstream. <strong>Declarative infrastructure</strong> turned "self-healing, with manual control" into a design pattern: Kubernetes controllers continuously reconcile the cluster's actual state with the desired state you declared, while <code>kubectl cordon</code> and <code>kubectl drain</code> let a human take a node out of service deliberately. And <strong>OpenTelemetry</strong>, formed in 2019 by merging OpenTracing and OpenCensus, standardized how services emit traces, metrics and logs, making the visibility row of the table far cheaper to achieve.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Operability is the "how would you run this?" part of a design interview that weak candidates skip. Strong candidates volunteer it: alerts on symptoms users feel (p99, error rate) rather than on every internal counter; deploys that are staged, canaried and quick to roll back; taking a node down for maintenance without downtime; which failure handling is automatic, which needs a human, and how that human overrides the automation; and backups whose restores are actually tested. Citing a real incident to justify a safeguard (GitLab's untested backups, Knight Capital's partial deploy) makes the point stick.</p>`,
        },
        {
          type: "quiz",
          q: "Which property most improves a data system's operability?",
          options: [
            "It heals itself automatically and offers no manual overrides, so operators can't make mistakes",
            "It behaves predictably, exposes its internal state, has good defaults, and lets operators override automation when needed",
            "It runs on one carefully tuned server that nobody is allowed to touch",
            "It alerts on every metric so nothing is missed",
          ],
          answer: 1,
          explain: "Option A is the tempting one: self-healing is valuable, but automation only covers the situations its authors anticipated, and without visibility and manual control operators are helpless in the rest. A single untouchable server (C) can't be patched or maintained without downtime and is one failure away from an outage. Alerting on everything (D) buries the real problems in noise.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "simplicity-evolvability",
      title: "Fight accidental complexity so the system can evolve",
      kicker: "Maintainability",
      concepts: ["simplicity", "evolvability", "accidental-complexity", "abstraction"],
      blocks: [
        {
          type: "problem",
          html: `<p>Small projects can have code that is a pleasure to read: short, direct, obviously correct. As they grow, many drift into what Brian Foote and Joseph Yoder called a <strong>big ball of mud</strong> (1997), where everything depends on everything and every change risks breaking something far away. Much of that complexity isn't demanded by the problem at all. It comes from workarounds, special cases, performance hacks and leaky tools, and it makes change slow and dangerous exactly when change is needed, which is always: new features, new regulations, new scale.</p>
<p>The naive fix is to cut features until the system feels simple again. That aims at the wrong target. What has to go is the complexity the <em>implementation</em> added, not the complexity the <em>problem</em> genuinely has.</p>`,
        },
        {
          type: "idea",
          html: `<p>Remove <strong>accidental complexity</strong>, chiefly with good <strong>abstractions</strong>, and the simpler system becomes one you can keep changing as requirements change.</p>`,
        },
        {
          type: "text",
          html: `<h3>What complexity looks like</h3>
<p>Complexity rarely arrives in one bad decision; it accumulates. Its symptoms are recognizable:</p>
<ul>
<li>an <strong>explosion of the state space</strong>: so many flags, modes and combinations that nobody can say what the system might be doing;</li>
<li><strong>tight coupling</strong> between modules, so changing one forces changes in others;</li>
<li><strong>tangled dependencies</strong>, so nothing can be understood or tested on its own;</li>
<li><strong>inconsistent naming and terminology</strong>, so one idea has three names and one name means three things;</li>
<li><strong>hacks to solve performance problems</strong> that bypass the normal code paths;</li>
<li><strong>special cases</strong> that work around problems elsewhere instead of fixing them.</li>
</ul>
<p>The cost is real. Maintenance gets harder, budgets and schedules overrun, and each change carries more risk, because in a system nobody fully understands it's easy to overlook an implicit assumption, a side effect or a surprising interaction. Reducing complexity improves maintainability directly, which makes simplicity a goal in its own right.</p>
<h3>Essential vs accidental complexity</h3>
<p>Simplicity doesn't have to mean fewer features. The useful distinction goes back to Fred Brooks's essay "No Silver Bullet" (1986): some complexity is <strong>essential</strong>, inherent in the problem; the rest is <strong>accidental</strong>, a product of how we chose to solve it. Moseley and Marks sharpened the idea in "Out of the Tar Pit" (2006): complexity counts as accidental when the users' problem doesn't demand it and it exists only because of how the software was built.</p>
<p>Tax rules that differ across 50 jurisdictions are essential complexity; no design makes them disappear. Code that retries and de-duplicates every read because a home-grown cache occasionally returns stale data is accidental: fix the cache, or use a component that guarantees what you need, and the workaround vanishes without taking any feature with it. The main tool for removing accidental complexity is abstraction. Here is what one familiar abstraction hides.</p>`,
        },
        {
          type: "diagram",
          title: "What a good abstraction hides",
          svg: `<svg viewBox="0 0 400 244" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A one-line SQL query above the abstraction boundary; storage structures, concurrency control, crash recovery and query planning hidden below it">
<text x="16" y="16" font-size="12" style="fill: var(--viz-muted)">what the application writes</text>
<rect x="16" y="24" width="368" height="40" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="200" y="49" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">SELECT * FROM posts WHERE user_id = 42</text>
<text x="200" y="84" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-c1)">SQL: the abstraction boundary</text>
<line x1="8" y1="93" x2="392" y2="93" style="stroke: var(--viz-c1); stroke-width: 3"/>
<text x="16" y="114" font-size="12" style="fill: var(--viz-muted)">hidden beneath it</text>
<rect x="16" y="122" width="178" height="50" rx="8" style="fill: none; stroke: var(--viz-muted); stroke-dasharray: 5 4"/>
<rect x="206" y="122" width="178" height="50" rx="8" style="fill: none; stroke: var(--viz-muted); stroke-dasharray: 5 4"/>
<rect x="16" y="184" width="178" height="50" rx="8" style="fill: none; stroke: var(--viz-muted); stroke-dasharray: 5 4"/>
<rect x="206" y="184" width="178" height="50" rx="8" style="fill: none; stroke: var(--viz-muted); stroke-dasharray: 5 4"/>
<text x="105" y="143" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">B-tree / LSM pages</text>
<text x="105" y="160" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">on disk (ch3)</text>
<text x="295" y="143" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">locks or MVCC for</text>
<text x="295" y="160" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">concurrent clients (ch7)</text>
<text x="105" y="205" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">write-ahead log for</text>
<text x="105" y="222" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">crash recovery (ch3)</text>
<text x="295" y="205" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">query planner</text>
<text x="295" y="222" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">and indexes</text>
</svg>`,
          caption: "One line of SQL stands on storage structures, concurrency control, crash recovery and query planning. You still depend on all of it; you just don't have to think about it.",
        },
        {
          type: "text",
          html: `<h3>Abstraction: the main tool</h3>
<p>A good <strong>abstraction</strong> puts a small, clean interface in front of a large amount of machinery, so you can rely on the machinery without understanding it. That buys three things at once: it can serve a wide range of applications; reusing it is far cheaper than rebuilding similar machinery again and again; and when the component underneath improves, every application using it benefits.</p>
<p>A high-level language spares you machine code, register allocation and raw system calls; the machine code still runs, you just never write it. SQL spares you the on-disk and in-memory data structures, other clients' concurrent requests, and the inconsistent state a crash would otherwise leave. Nobody writing that <code>SELECT</code> reasons about B-tree pages or the write-ahead log, which is precisely what keeps applications on top of databases manageable.</p>
<p>Finding good abstractions is hard, especially in distributed systems. There is no shortage of good distributed algorithms; what's scarce is a way to wrap them into building blocks that keep the overall system understandable. Much of this book is a search for such abstractions: transactions (Chapter 7), consensus and coordination services (Chapter 9), and logs and derived data (Chapters 11 and 12).</p>`,
        },
        {
          type: "callout",
          tone: "warning",
          title: "Abstractions that lie",
          html: `<p>A good abstraction hides details without lying about its properties. Joel Spolsky's "Law of Leaky Abstractions" (2002, beyond the book) observes that every non-trivial abstraction leaks to some degree; the dangerous ones pretend they don't. The classic example is an RPC framework that makes a network call look exactly like a local function call, hiding the timeouts, partial failures and "did my request run or not?" ambiguity that make network calls fundamentally different (Chapters 4 and 8). An abstraction that documents how it leaks is far easier to build on than one that fails in ways its interface said were impossible.</p>`,
        },
        {
          type: "text",
          html: `<h3>Evolvability: requirements will change</h3>
<p>Requirements drift constantly. Some changes come from learning (new facts about the domain, use cases nobody foresaw), some from the business (shifting priorities, feature requests), some from outside (new platforms, new laws and regulations), and some from success itself, when growth forces architectural changes like those in the scaling section.</p>
<p>Agile teams already have habits for change, test-driven development and refactoring among them, but those habits operate on code: a few files inside one application. The book asks the same question one level up, for a whole <strong>data system</strong> made of several applications or services with different characteristics. For instance: how would you "refactor" Twitter's timelines from approach 1 (compute on read) to approach 2 (fan out on write) while the system keeps serving hundreds of thousands of reads per second?</p>`,
        },
        {
          type: "diagram",
          title: "Refactoring a running data system",
          svg: `<svg viewBox="0 0 400 264" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Five illustrative steps for migrating timelines from compute-on-read to fan-out-on-write">
<defs><marker id="ch1d2-mig-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<text x="8" y="16" font-size="12" font-weight="700">Illustrative: migrating timelines from pull to push</text>
<rect x="44" y="28" width="348" height="34" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<rect x="44" y="76" width="348" height="34" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<rect x="44" y="124" width="348" height="34" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<rect x="44" y="172" width="348" height="34" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<rect x="44" y="220" width="348" height="34" rx="8" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<circle cx="22" cy="45" r="13" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<circle cx="22" cy="93" r="13" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<circle cx="22" cy="141" r="13" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<circle cx="22" cy="189" r="13" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<circle cx="22" cy="237" r="13" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="22" y="49" font-size="12" font-weight="700" text-anchor="middle">1</text>
<text x="22" y="97" font-size="12" font-weight="700" text-anchor="middle">2</text>
<text x="22" y="145" font-size="12" font-weight="700" text-anchor="middle">3</text>
<text x="22" y="193" font-size="12" font-weight="700" text-anchor="middle">4</text>
<text x="22" y="241" font-size="12" font-weight="700" text-anchor="middle">5</text>
<line x1="22" y1="59" x2="22" y2="78" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch1d2-mig-arr)"/>
<line x1="22" y1="107" x2="22" y2="126" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch1d2-mig-arr)"/>
<line x1="22" y1="155" x2="22" y2="174" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch1d2-mig-arr)"/>
<line x1="22" y1="203" x2="22" y2="222" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch1d2-mig-arr)"/>
<text x="56" y="50" font-size="12">Approach 1: compute each timeline on read</text>
<text x="56" y="98" font-size="12">Add a fan-out writer: new tweets also fill inboxes</text>
<text x="56" y="146" font-size="12">Backfill inboxes for existing users</text>
<text x="56" y="194" font-size="12">Shadow-compare, then switch reads to inboxes</text>
<text x="56" y="242" font-size="12">Exempt celebrities: hybrid of push and pull</text>
</svg>`,
          caption: "An illustrative plan, not Twitter's documented history. Blue is the old design, amber the transition, green the end state. Each step is reversible, and the old read path keeps serving until the new one is proven: evolvability is refactoring a running data system, not a source file.",
        },
        {
          type: "text",
          html: `<p>Whether such a migration is a project or a nightmare depends mostly on the two earlier ideas: a system built from clear abstractions, with little accidental complexity, is one you can reason about well enough to change. The book gives this system-level agility its own name, <strong>evolvability</strong>. Later chapters supply the tools: encodings that let old and new code read each other's data during a rolling upgrade (Chapter 4), and the ability to rebuild derived data, such as timelines and indexes, by reprocessing the source data (Chapters 10 and 12).</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Amazon S3",
              title: "Stronger guarantees, same API",
              year: "Dec 2020",
              tag: "good abstraction",
              html: `AWS made S3 strongly consistent for read-after-write and list operations automatically, at no extra cost and with no API change. Every application on S3 could drop its workarounds for eventual consistency: one improvement inside an abstraction, and all its users benefited.`,
            },
            {
              org: "Stripe",
              title: "Migrating a live data model",
              year: "2017",
              tag: "evolvability",
              html: `Stripe's four-phase pattern for migrating a live data model without downtime, evolvability at the data-system level, is covered in <a href="#/ch4/learn/dataflow-databases">Chapter 4</a>.`,
            },
            {
              org: "Segment",
              title: "140 services back into one",
              year: "2018",
              tag: "complexity correction",
              html: `Segment's post "Goodbye Microservices" explains how running a separate service and queue for each of more than 140 destinations created so much operational and code complexity that the team consolidated them into a single service and repository.`,
            },
            {
              org: "Amazon Prime Video",
              title: "From distributed to a single process",
              year: "2023",
              tag: "complexity correction",
              html: `Prime Video's tech blog reported moving its audio/video quality-monitoring service from a distributed design built on AWS Step Functions and Lambda to a single-process application running on ECS, cutting infrastructure cost by about 90%.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Complexity correction in public",
          html: `<p>Segment and Prime Video show a post-2017 pattern: teams publicly undoing distribution that cost more complexity than it saved. The lesson isn't "microservices are bad". Service boundaries are abstractions too, and a boundary that doesn't match the problem is accidental complexity. S3's 2020 consistency change shows the opposite payoff: improve what sits behind a good abstraction, and every application on top can delete code.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>This shows up in two ways. In design reviews, strong candidates separate essential from accidental complexity and propose removing the latter (a cache needing manual invalidation everywhere, a bespoke queue, a service boundary that forces distributed transactions) before adding new machinery. In migration questions ("how would you change the data model of a live system?"), a strong answer describes an online migration: dual-write, backfill, verify by comparing old and new, switch reads, switch writes, remove the old path, each step reversible. "Take a maintenance window and run a script" is a weak answer for a system at scale.</p>`,
        },
        {
          type: "quiz",
          q: "Which of these is accidental complexity?",
          options: [
            "Ensuring a bank balance never goes negative",
            "Retrying and de-duplicating reads because a home-grown cache sometimes returns stale data",
            "Supporting different tax rules per country",
            "Showing prices in each user's local currency",
          ],
          answer: 1,
          explain: "Options A, C and D are part of the problem as users see it: essential complexity, however painful (C is the tempting distractor because it's so intricate, but no design makes those rules go away). The retry-and-dedupe logic exists only because of an implementation choice, a cache that can return stale data; a better abstraction, or a correctly invalidated cache, removes it without removing any feature.",
        },
      ],
    },
  ],

  takeaways: [
    "<strong>You are a data-system designer.</strong> Once your code glues a database, cache, index and queue together, the guarantees of the whole are yours to define and defend.",
    "<strong>Faults are normal; failures are what you design against.</strong> Tolerate specific, named faults, recover fast (time to recover counts as much as time between failures), and exercise the machinery by injecting faults on purpose.",
    "<strong>Redundancy only beats independent faults.</strong> Correlated software bugs and human changes need testing, isolation, restarts, staged rollouts, fast rollback and monitoring.",
    "<strong>\"Scalable\" needs a load parameter.</strong> Find the number that dominates the work (for Twitter, followers per author rather than tweets per second) and plan for its growth, including its skew.",
    "<strong>Response time is a distribution.</strong> Use p50 for the typical case and p95/p99/p99.9 for the tail, measure on the client, and merge histograms instead of averaging percentiles.",
    "<strong>Tails come from queues and fan-out.</strong> Busy servers queue, one slow call slows a whole page, and with 100-way fan-out a backend's 1% becomes 63% of page loads.",
    "<strong>Architectures are bets on load.</strong> Scale up while it's cheap, scale out when you must, and expect to rethink the design at every order of magnitude.",
    "<strong>Most of the cost comes after launch.</strong> Operability, simplicity (no accidental complexity) and evolvability decide whether a system can keep changing safely.",
  ],

  connections: [
    { to: "ch2", html: "Evolvability starts with the data model: schema-on-read vs schema-on-write decides how painful a requirement change is, and Twitter's timeline is also a normalization vs denormalization decision." },
    { to: "ch3", html: "Opens the \"database\" box of the composite system: storage engines, indexes, and OLTP vs OLAP workloads, each with very different load parameters." },
    { to: "ch4", html: "Rolling upgrades (the operability win from tolerating machine loss) only work if old and new code can read each other's data: backward and forward compatible encodings are evolvability at the data level." },
    { to: "ch5", html: "Redundancy for data is replication: this chapter's defense against hardware faults becomes leaders, followers, failover and replication lag." },
    { to: "ch6", html: "Scaling out stateful data means partitioning; Twitter's celebrity problem reappears as hot keys and skewed load." },
    { to: "ch7", html: "Transactions are the book's flagship example of a good abstraction: they remove accidental complexity (crash recovery, concurrent clients) from application code, exactly the simplicity argument made here." },
    { to: "ch8", html: "The faults sketched here, in depth: unreliable networks, process pauses (GC) that create latency tails, and clocks whose surprises (leap seconds) break software assumptions." },
    { to: "ch9", html: "Good distributed algorithms are hard to package as abstractions; consensus and coordination services (ZooKeeper, etcd) are the book's answer to that problem." },
    { to: "ch10", html: "Throughput-oriented batch processing; stragglers are the batch-job version of tail latency amplification, and backup tasks are hedging by another name." },
    { to: "ch11", html: "Keeping caches and search indexes in sync with the database without fragile dual writes: change data capture and event logs." },
    { to: "ch12", html: "Twitter's timeline revisited as derived data, a materialized view, and composing specialized systems (\"unbundling the database\") as the book's answer to building data systems." },
  ],

  furtherReading: [
    { title: "The Tail at Scale (Dean and Barroso, Communications of the ACM, 2013)", note: "The source of tail latency amplification and of hedged and tied requests; short and very readable." },
    { title: "Timelines at Scale (Raffi Krikorian, QCon San Francisco 2012)", note: "The talk behind the book's Twitter numbers: fan-out, Redis timelines and the celebrity problem." },
    { title: "Dynamo: Amazon's Highly Available Key-value Store (SOSP 2007)", url: "https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf", note: "Section 2 explains why Amazon writes SLAs at the 99.9th percentile; also the foundation for leaderless replication in Chapter 5." },
    { title: "Why Do Internet Services Fail, and What Can Be Done About It? (Oppenheimer, Ganapathi and Patterson, USITS 2003)", note: "The study behind \"operator configuration errors are a leading cause of outages\"." },
    { title: "Disk Failures in the Real World: What Does an MTTF of 1,000,000 Hours Mean to You? (Schroeder and Gibson, FAST 2007)", note: "Field data showing real disk replacement rates well above datasheet figures." },
    { title: "Site Reliability Engineering (Google, 2016)", url: "https://sre.google/sre-book/table-of-contents/", note: "SLIs, SLOs, error budgets, toil and monitoring: operability as an engineering discipline. Free online." },
    { title: "How NOT to Measure Latency (Gil Tene, conference talk)", note: "Coordinated omission, percentile plots, and why most latency dashboards mislead." },
    { title: "Summary of the Amazon S3 Service Disruption in the Northern Virginia (US-EAST-1) Region (AWS, 2017)", url: "https://aws.amazon.com/message/41926/", note: "A short, honest postmortem of a human-error outage and the tooling changes that followed." },
    { title: "Details of the Cloudflare outage on July 2, 2019 (Cloudflare blog)", url: "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/", note: "A global outage from one regular expression pushed everywhere at once; a model for staged rollouts." },
    { title: "Principles of Chaos Engineering", url: "https://principlesofchaos.org/", note: "The one-page manifesto for deliberately injecting faults." },
    { title: "Out of the Tar Pit (Moseley and Marks, 2006)", note: "The accidental vs essential complexity argument the book uses for simplicity." },
    { title: "Scaling Memcache at Facebook (Nishtala et al., NSDI 2013)", note: "A real composite data system: look-aside caching, invalidation from the commit log, leases against stale sets." },
    { title: "Cores that Don't Count (Hochschild et al., HotOS 2021)", note: "Google's report on CPUs that silently compute wrong results: hardware faults that aren't fail-stop, and why end-to-end checks matter." },
  ],
});
