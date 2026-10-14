// Chapter 12 deep dive, part 1 (hook + data integration through the end-to-end argument).
// Part 2 lives in ch12.deep2.js. Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch12", {
  hook: `<p>Go back to the online store from <a href="#/ch11/learn/change-data-capture">Chapter 11</a>'s opening. It has since replaced the dual writes to its search index with change data capture. Now look at every copy of one price at 9:02 a.m., when an admin cuts this week's bestseller from $14 to $9 for a flash sale. The PostgreSQL row says $9 at once; search results still say $14 because the indexer is two minutes behind; the product-page cache says $12, left over from yesterday's edit, because a write to Redis failed silently last night; and the analytics warehouse won't hear about the sale until tomorrow. Meanwhile a customer who double-clicked "Buy" has been charged twice, although every component on the path calls itself transactional or exactly-once.</p>
<p>You have met every one of these failures before: a write that reached one store but not another (<a href="#/ch1/learn/data-systems">Chapter 1</a>, whose bad night began at the same 9:02 on the clock), a search index fed by dual writes that drifted from the database (this same store, in Chapter 11), and a retried request that ran twice (<a href="#/ch7/learn/aborts-and-retries">Chapter 7</a>). Each chapter fixed its own piece. This last one asks what architecture deals with them as a class, instead of patching one copy at a time.</p>
<p>Which copy is the truth, and which of these problems will heal if you wait? This chapter answers in three parts: make one ordered log the source of truth and <strong>derive</strong> every other store from it, so copies may lag but never disagree; get correctness <strong>end to end</strong>, with request IDs, deterministic derivations and verification, instead of trusting each layer's promise; and remember that the same machinery, pointed at people, decides who gets a loan and what becomes known about them.</p>`,
  sections: [
    // ------------------------------------------------------------------
    {
      id: "data-integration",
      title: "No database does everything: integrate by deriving data",
      kicker: "Motivation",
      concepts: ["data-integration", "derived-data", "source-of-truth-immutable-log", "derived-data-vs-distributed-transactions", "limits-of-total-ordering", "capturing-causal-dependencies"],
      blocks: [
        {
          type: "problem",
          html: `<p>The fact "Dune now costs $14" has to live in five places: PostgreSQL (checkout), Elasticsearch (search), Redis (the product-page cache), a warehouse (analytics) and a feature store (recommendations). The obvious approach is for the application to write to each in turn. A crash between the third and fourth write leaves the systems disagreeing with no error anywhere. Worse, two admins editing the price at once can reach PostgreSQL in one order and Elasticsearch in the other, so each store keeps a different "final" price forever (Chapter 11's dual-write problem).</p>
<p>The textbook alternative, one distributed transaction (XA, two-phase commit) spanning all five stores, is slow, blocks everyone when the coordinator fails, and most of these stores don't support it anyway.</p>`,
        },
        {
          type: "text",
          html: `<p>Every storage engine is a bet on an access pattern. PostgreSQL keeps rows in B-trees to update and fetch one order by key in a millisecond; a search engine keeps an inverted index from words to documents; a cache keeps finished answers in memory; a warehouse such as Snowflake or BigQuery stores each column compressed on its own to scan a billion rows for one aggregate. The layout that makes one query fast makes another slow (Chapter 3).</p>
<p>So no product is good at everything, and the broader a tool's claims, the likelier it is that your central requirement is its half-finished feature. Real applications combine several systems, and the design question changes from "which database?" to "<strong>how does data flow between them?</strong>"</p>
<h3>Systems of record and derived data</h3>
<p>Start by classifying every store, using the distinction that opened Part III (<a href="#/ch10/learn/why-batch">Chapter 10</a>): each store is either a <strong>system of record</strong>, where a fact is first written, or holds <strong>derived data</strong> computed from one (an index, a cache, a materialized view). If the two disagree, the derived copy is the one that's wrong.</p>
<p>The test is one question: <em>if you lost this store, could you rebuild it from something else?</em> If yes, it is derived; when it is wrong, throw it away and recompute it. If no, it is a system of record and deserves backups and the strongest durability you can buy. The label is about how a store is used, not which product it is.</p>`,
        },
        {
          type: "diagram",
          title: "One log as the integration backbone",
          svg: `<style>.dd-diagram-body svg.c12d-backbone-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c12d-backbone-w{display:none}.dd-diagram-body svg.c12d-backbone-n{display:block}}</style><svg class="c12d-backbone-w" viewBox="0 0 640 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="An application writes to PostgreSQL, the system of record. Change data capture copies its commits into an ordered log. Four derived stores, a search index, a cache, a warehouse and ML features, consume the log, and a dashed replay arrow from the start of the log rebuilds one of them.">
  <defs>
    <marker id="c12d-backbone-w-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-line)"/></marker>
    <marker id="c12d-backbone-w-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <rect x="8" y="84" width="90" height="52" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="53" y="106" font-size="13" font-weight="700" text-anchor="middle">Application</text>
  <text x="53" y="124" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">writes here</text>
  <line x1="98" y1="110" x2="118" y2="110" stroke-width="1.5" marker-end="url(#c12d-backbone-w-a)" style="stroke: var(--viz-line)"/>
  <rect x="120" y="76" width="116" height="68" rx="8" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="178" y="104" font-size="13" font-weight="700" text-anchor="middle">PostgreSQL</text>
  <text x="178" y="123" font-size="12" text-anchor="middle">system of record</text>
  <line x1="236" y1="110" x2="276" y2="110" stroke-width="1.5" marker-end="url(#c12d-backbone-w-a)" style="stroke: var(--viz-line)"/>
  <text x="256" y="101" font-size="12" text-anchor="middle" class="viz-halo">CDC</text>
  <text x="348" y="82" font-size="12" font-weight="700" text-anchor="middle">ordered log</text>
  <rect x="278" y="92" width="28" height="36" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="306" y="92" width="28" height="36" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="334" y="92" width="28" height="36" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="362" y="92" width="28" height="36" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="390" y="92" width="28" height="36" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <g font-size="12" text-anchor="middle"><text x="292" y="115">41</text><text x="320" y="115">42</text><text x="348" y="115">43</text><text x="376" y="115">44</text><text x="404" y="115">45</text></g>
  <text x="300" y="148" font-size="12" style="fill: var(--viz-muted)">same order everywhere</text>
  <line x1="418" y1="110" x2="486" y2="34" stroke-width="1.5" marker-end="url(#c12d-backbone-w-a)" style="stroke: var(--viz-line)"/>
  <line x1="418" y1="110" x2="486" y2="84" stroke-width="1.5" marker-end="url(#c12d-backbone-w-a)" style="stroke: var(--viz-line)"/>
  <line x1="418" y1="110" x2="486" y2="134" stroke-width="1.5" marker-end="url(#c12d-backbone-w-a)" style="stroke: var(--viz-line)"/>
  <line x1="418" y1="110" x2="486" y2="184" stroke-width="1.5" marker-end="url(#c12d-backbone-w-a)" style="stroke: var(--viz-line)"/>
  <rect x="488" y="16" width="144" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="560" y="39" font-size="13" text-anchor="middle">Search index</text>
  <rect x="488" y="66" width="144" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="560" y="89" font-size="13" text-anchor="middle">Cache</text>
  <rect x="488" y="116" width="144" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="560" y="139" font-size="13" text-anchor="middle">Warehouse</text>
  <rect x="488" y="166" width="144" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="560" y="189" font-size="13" text-anchor="middle">ML features</text>
  <polyline points="292,128 292,196 484,196" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c12d-backbone-w-m)" style="fill: none; stroke: var(--viz-muted)"/>
  <text x="300" y="218" font-size="12" style="fill: var(--viz-muted)">replay from offset 0 to rebuild a view</text>
</svg><svg class="c12d-backbone-n" viewBox="0 0 360 414" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="An application writes to PostgreSQL, the system of record. Change data capture copies its commits into an ordered log. Four derived stores consume the log, and a dashed replay arrow from the start of the log rebuilds one of them.">
  <defs>
    <marker id="c12d-backbone-n-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-line)"/></marker>
    <marker id="c12d-backbone-n-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <rect x="100" y="8" width="160" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="180" y="33" font-size="13" font-weight="700" text-anchor="middle">Application writes</text>
  <line x1="180" y1="48" x2="180" y2="66" stroke-width="1.5" marker-end="url(#c12d-backbone-n-a)" style="stroke: var(--viz-line)"/>
  <rect x="80" y="68" width="200" height="52" rx="8" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="180" y="90" font-size="13" font-weight="700" text-anchor="middle">PostgreSQL</text>
  <text x="180" y="109" font-size="12" text-anchor="middle">system of record</text>
  <line x1="180" y1="120" x2="180" y2="146" stroke-width="1.5" marker-end="url(#c12d-backbone-n-a)" style="stroke: var(--viz-line)"/>
  <text x="190" y="138" font-size="12">CDC</text>
  <text x="228" y="140" font-size="12" font-weight="700">ordered log</text>
  <rect x="80" y="148" width="40" height="34" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="120" y="148" width="40" height="34" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="160" y="148" width="40" height="34" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="200" y="148" width="40" height="34" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="240" y="148" width="40" height="34" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <g font-size="12" text-anchor="middle"><text x="100" y="170">41</text><text x="140" y="170">42</text><text x="180" y="170">43</text><text x="220" y="170">44</text><text x="260" y="170">45</text></g>
  <polyline points="80,165 30,165 30,366" stroke-width="1.5" style="fill: none; stroke: var(--viz-line)"/>
  <line x1="30" y1="222" x2="48" y2="222" stroke-width="1.5" marker-end="url(#c12d-backbone-n-a)" style="stroke: var(--viz-line)"/>
  <line x1="30" y1="270" x2="48" y2="270" stroke-width="1.5" marker-end="url(#c12d-backbone-n-a)" style="stroke: var(--viz-line)"/>
  <line x1="30" y1="318" x2="48" y2="318" stroke-width="1.5" marker-end="url(#c12d-backbone-n-a)" style="stroke: var(--viz-line)"/>
  <line x1="30" y1="366" x2="48" y2="366" stroke-width="1.5" marker-end="url(#c12d-backbone-n-a)" style="stroke: var(--viz-line)"/>
  <rect x="50" y="204" width="230" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="165" y="227" font-size="13" text-anchor="middle">Search index</text>
  <rect x="50" y="252" width="230" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="165" y="275" font-size="13" text-anchor="middle">Cache</text>
  <rect x="50" y="300" width="230" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="165" y="323" font-size="13" text-anchor="middle">Warehouse</text>
  <rect x="50" y="348" width="230" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="165" y="371" font-size="13" text-anchor="middle">ML features</text>
  <polyline points="280,165 334,165 334,366 284,366" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c12d-backbone-n-m)" style="fill: none; stroke: var(--viz-muted)"/>
  <text x="180" y="404" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">dashed: replay from offset 0 rebuilds a view</text>
</svg>`,
          caption: `The database stays the system of record; change data capture turns its commits into one ordered log, and every derived store applies the same writes in the same order. A store that is lost, buggy or brand new is filled by replaying the log from the start.`,
        },
        {
          type: "text",
          html: `<h3>Reasoning about dataflows</h3>
<p>Next, decide how changes travel from the record to everything derived from it. If the database is the system of record, use <a href="#/ch11/learn/change-data-capture">change data capture</a> (Chapter 11) to feed the search index, cache and warehouse in exactly the order the database committed the writes. If you append events to a log first (event sourcing), the database is just one more derived view. Chapter 11 tours the production CDC systems that do this, from LinkedIn's Databus to Debezium and Netflix's DBLog. Jay Kreps's essay <em>The Log</em>, about LinkedIn's move from point-to-point pipelines to one central log, is the blueprint for this section (<a href="#/ch11/learn/why-streams">Kafka's origin, Chapter 11</a>).</p>
<p>Either way, <strong>one component decides the order of all writes</strong> and every consumer applies them in that order. Two concurrent price edits are resolved once, by their position in the log, not separately (and differently) in each store. If each derivation is deterministic, every view reflects some prefix of the same history: a slow view is behind, never contradictory. Chapter 11's <a href="#/viz/ch11/dual-writes">dual-writes visualization</a> shows the divergence and the fix, and Chapter 9's <a href="#/viz/ch9/total-order-broadcast">total order broadcast</a> shows replicas converging because they share one order.</p>
<p>Determinism is a hard requirement. A consumer that reads the wall clock, calls a mutable external service ("today's exchange rate?") or iterates a hash map in arbitrary order builds a different view on replay or on a second replica. Put such inputs into the event instead, so every consumer and every replay computes the same answer.</p>`,
        },
        {
          type: "table",
          title: "Two ways to keep systems in sync",
          headers: ["", "Distributed transactions (XA / 2PC)", "Log-based derived data"],
          rows: [
            ["Who decides the order", "Locks held until commit (two-phase locking, Chapter 7)", "The position of each write in the log, decided once by the log's leader"],
            ["How atomicity is achieved", "Atomic commit: every participant commits or all abort (Chapter 9)", "Deterministic retry plus idempotence: a crashed consumer re-reads from its last offset and reapplies"],
            ["What a reader sees", "Usually linearizable: right after commit, you can read your own write in every participant", "Usually asynchronous: views lag, so there is no read-your-writes across views unless you build it"],
            ["When something fails", "The coordinator is a single point of blocking; in-doubt transactions hold locks; heuristic decisions can break atomicity", "A slow or crashed consumer falls behind and catches up; the producer and other consumers carry on"],
            ["What every store must support", "The same atomic-commit protocol, a lowest common denominator many stores (search engines, caches) lack", "Reading the log and applying each change idempotently"],
          ],
          note: "The book's conclusion: for integrating different kinds of systems, log-based derived data is the more promising approach. Its weakness is timeliness, which the section on timeliness and integrity takes up.",
        },
        {
          type: "text",
          html: `<h3>The limits of total ordering</h3>
<p>A single, totally ordered log is easy while every event fits through one machine. Four things break it:</p>
<ul>
<li><strong>Throughput.</strong> A total order needs one leader to sequence every event. Outgrow one machine and you partition the log (Chapter 6); events in different partitions have no defined order.</li>
<li><strong>Multiple datacenters.</strong> To survive losing a datacenter and keep writes local, each datacenter usually runs its own leader (Chapter 5), so events accepted in Frankfurt and Virginia at the same moment are unordered.</li>
<li><strong>Microservices.</strong> Each service owns its state and they share no durable log, so the orders service and the inventory service have no common order.</li>
<li><strong>Offline-capable clients.</strong> A phone that accepts writes offline applies them before the server sees them, so devices and server see events in different orders.</li>
</ul>
<p>Formally, deciding a total order is <strong>total order broadcast</strong>, which is equivalent to consensus (Chapter 9). Most consensus algorithms assume one node can sequence the whole stream; spreading the work of ordering across machines while keeping one total order was an open research problem when the book was written.</p>
<h3>When order carries meaning</h3>
<p>Losing the total order would be harmless if events were independent. Often they are not. In the book's example (names added), Ana unfriends Ben, then posts a complaint about Ben to her remaining friends: she wrote the post <em>because</em> Ben was no longer in the audience. If friendships and posts live in different services, a notification service that joins each post with the author's friend list may see the post first and push "Ben is so annoying" to Ben's phone.</p>
<p>In the visualization, a Notifier keeps its own copy of each user's friend list (a derived view built from friendship events) and pushes each post to the author's friends according to that copy. Every configuration replays the same two events; only the plumbing changes.</p>`,
        },
        {
          type: "viz",
          id: "ch12/unfriend-race",
          title: "The unfriend race: one log vs two",
          caption: "Try 'Two logs' with high lag and press Play: the post reaches the Notifier at 0.7 s, before the unfriend, and Ben is notified. Switch to 'One log': lag delays both events but can never reorder them. Then go back to two logs and pick 'Carry version seen': the post is held for 1.3 s until the friend list catches up. Notice that the fix costs timeliness, not correctness. Toy timings.",
        },
        {
          type: "text",
          html: `<h3>Capturing causal dependencies</h3>
<p>That is the general problem: each log was in perfect order, but the order <em>between</em> them was lost, and low lag only hid it. There are four tools, each with a limit:</p>
<ol>
<li><strong>Keep causally related events in one log.</strong> When the dependency lives within one entity (one account, one order, one user), give the events the same partition key and the per-partition order does the work. It fails for Ana only because friendships and posts belong to two different services.</li>
<li><strong>Record what the user saw.</strong> When Ana posts, her app has just shown her friend list version 8. Log that with the post ("depends on friends v8"), or log the read itself as an event with an ID later events can reference. Consumers can then wait until their copy reaches that version, which is what "Carry version seen" did. The section on <a href="#/ch12/learn/write-path-read-path">the write and read paths</a> generalizes this: reads can be events too.</li>
<li><strong>Logical timestamps.</strong> Lamport or vector clocks (Chapter 9) order events without coordination, but when a post stamped 42 arrives, the Notifier can't know whether an unfriend stamped 41 is still in flight. It must hold every event until <em>all</em> inputs have passed that timestamp, delaying everything by the slowest input. Wall clocks are worse: they drift (Chapter 8), and no timestamp says anything about events that haven't arrived.</li>
<li><strong>Conflict resolution.</strong> CRDTs and merge functions (Chapter 5) make replicas of <em>state</em> converge whatever order the updates arrive in. They can't help with actions that have external side effects: once the notification reached Ben's phone, no merge can recall it.</li>
</ol>
<p>This is the time-dependence of stream joins (Chapter 11) again: the result depends on which version of the friend list the post is joined with, so a deterministic system has to say which version it means.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Airbnb SpinalTap",
              year: "2018",
              tag: "one change stream for many services",
              html: `As Airbnb split its monolith into services, each with its own data stores, many teams needed to react to the same data changes. It built SpinalTap, a change data capture service that tails source change logs such as the MySQL binlog and publishes each mutation as a standardized event to Kafka, and open-sourced it in 2018. Cache invalidation, search indexing and offline pipelines consume that one stream, so the source databases stay the systems of record and everything downstream is derived.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "mistake",
          title: "\"The log is just a message queue\"",
          html: `<p>A traditional queue deletes a message once a consumer acknowledges it. A log keeps every entry for its retention period, or forever, whether or not anyone has read it. That retention is the whole point of this architecture: it is what lets you add a derived store next year and backfill it, or rebuild a corrupted index, by replaying from offset 0 (Chapter 11's <a href="#/ch11/learn/log-based-brokers">log-based brokers</a>).</p>
<p>A second, related slip: "Kafka guarantees ordering." It does, but only within a partition. Two topics, or two partitions of one topic, are two independent orders, which is exactly how the unfriend race happens.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: keep PostgreSQL, Elasticsearch and Redis in sync",
          html: `<p>A weak answer writes to all three from the service and adds retries. A strong answer names PostgreSQL as the system of record, streams its changes with CDC (for example Debezium into Kafka, keyed by product ID so each product's changes stay in order), and builds the index and the cache as idempotent consumers that can be rebuilt by replay. It states the cost honestly: the index lags by seconds, so a user who edits a product and immediately searches may need a read from the primary. It also explains how a new consumer is backfilled (snapshot plus log, as DBLog does).</p>
<p>A common follow-up: <strong>"Why did the consumer act on the effect before the cause?"</strong> Because the two events traveled through different partitions or services, which have no order between them. Fix it by putting both in one partition when they concern one entity, or by having the effect name the version it depends on so the consumer can wait. Mention that wall-clock timestamps don't solve it.</p>`,
        },
        {
          type: "quiz",
          q: "Ana unfriends Ben, then posts a complaint about him. Friendships and posts live in two services with their own Kafka topics, and a notifier consumes both. Which change guarantees Ben never gets a push notification for that post?",
          options: [
            "Give both topics more partitions so the notifier keeps up",
            "Stamp every event with the producing server's wall-clock time and have the notifier apply events in timestamp order as they arrive",
            "Have the post record the friend-list version Ana's app saw (after the unfriend), and make the notifier hold the post until its own copy of the friend list has reached that version",
            "Enable exactly-once semantics on the notifier's consumer",
          ],
          answer: 2,
          explain: "Only an explicit causal dependency tells the notifier what it has to wait for. Timestamps are the tempting answer, but they can't help with an event that hasn't arrived: when the post shows up, the notifier has no way to know that an earlier-stamped unfriend is still in flight, short of holding every event until all inputs pass that time (and wall clocks drift, Chapter 8). More partitions change throughput, not the order between two topics. Exactly-once prevents duplicates and losses, not reordering.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "reprocessing",
      title: "Reprocessing history: from Lambda to Kappa",
      kicker: "Batch meets stream",
      concepts: ["lambda-architecture", "kappa-architecture", "reprocessing-for-evolution", "unifying-batch-and-stream"],
      blocks: [
        {
          type: "problem",
          html: `<p>A video site counts plays per video with a stream processor. A year in, someone discovers that 30% of the plays come from bots. Fixing the code fixes the future, but a job that only processes new events can't touch the past: a year of dashboards and reports stays wrong. Changing the <em>shape</em> of data has the same problem: migrating a large database's schema in place is slow, risky and often impossible to undo.</p>
<p>Nathan Marz's Lambda architecture answered with two systems: a batch layer that periodically recomputes everything from the immutable raw data, and a speed layer for the most recent events. It works, but every piece of business logic must be written and kept identical in two frameworks, and their outputs stitched together at query time.</p>`,
        },
        {
          type: "text",
          html: `<h3>Derived state is a function of the log</h3>
<p>Batch processing (Chapter 10) has a strongly functional flavor: a job is a deterministic function from immutable inputs to new outputs. Stream processing (Chapter 11) extends the idea to operators that run forever with managed, fault-tolerant state. In both, output is fully determined by input and code, so derived state is reproducible: a broken view is not a mystery to patch by hand but a function to evaluate again.</p>
<p>Deriving views <strong>asynchronously</strong> from a log adds a second property: faults stay local. A crashed search-index consumer falls behind and catches up while everything else carries on, whereas in a distributed transaction one failed participant aborts or blocks all of them. The book's example is a global, term-partitioned <a href="#/ch6/learn/secondary-indexes">secondary index</a> (Chapter 6): updating it synchronously needs a cross-partition transaction on every write, while maintaining it from the log makes it an ordinary consumer.</p>`,
        },
        {
          type: "text",
          html: `<h3>Reprocessing for application evolution</h3>
<p>Stream processing keeps views current with low delay as new events arrive. <strong>Reprocessing</strong> does something different: it runs new code over the <em>entire</em> history to derive a view that never existed before. Without it, schema evolution is limited to compatible tweaks, such as adding an optional field that old records simply lack (Chapter 4). With it, you can restructure freely: split one table into three, key users differently, re-tokenize the whole search corpus with a new analyzer, or fix a year of wrong numbers.</p>
<p>The move that takes the fear out of it is to <strong>never migrate in place</strong>. Derive the new view next to the old one, from the same log, and keep both current. Send a small share of reads to the new view, compare the results, raise the share, and if anything looks wrong, send the reads back. Every stage stays reversible until the day you delete the old view.</p>`,
        },
        {
          type: "analogy",
          title: "Changing a railway's gauge without stopping the trains",
          html: `<p>Nineteenth-century British railways were built to competing track gauges. The Great Western Railway used a broad gauge of 7 ft ¼ in, while most other lines used the 4 ft 8½ in gauge that became standard. Converting everything at once would have halted traffic, so many lines were laid with a third rail (mixed-gauge track) on which trains of both gauges could run during the transition. The GWR finished its conversion in May 1892.</p>
<p>A view migration works the same way. The old and new views both run on the same log (the shared track), readers move across gradually, and the old view is removed only when nobody depends on it.</p>`,
        },
        {
          type: "diagram",
          title: "A gradual, reversible migration",
          svg: `<style>.dd-diagram-body svg.c12d-migrate-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c12d-migrate-w{display:none}.dd-diagram-body svg.c12d-migrate-n{display:block}}</style><svg class="c12d-migrate-w" viewBox="0 0 640 244" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="One event log feeds two views, v1 with the old schema and v2 rebuilt by replay with the new schema. Readers send 90 percent of reads to v1 and 10 percent to v2. Below, the split moves from 90/10 to 50/50 to 0/100, with an arrow back labelled roll back any time.">
  <defs>
    <marker id="c12d-migrate-w-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-line)"/></marker>
    <marker id="c12d-migrate-w-c6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker>
    <marker id="c12d-migrate-w-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <text x="16" y="42" font-size="12" font-weight="700">event log</text>
  <rect x="16" y="52" width="32" height="36" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="48" y="52" width="32" height="36" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="80" y="52" width="32" height="36" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="112" y="52" width="32" height="36" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <g font-size="12" text-anchor="middle"><text x="32" y="75">0</text><text x="64" y="75">1</text><text x="96" y="75">2</text><text x="128" y="75">…</text></g>
  <line x1="144" y1="64" x2="212" y2="46" stroke-width="1.5" marker-end="url(#c12d-migrate-w-a)" style="stroke: var(--viz-line)"/>
  <line x1="144" y1="76" x2="212" y2="130" stroke-width="1.5" marker-end="url(#c12d-migrate-w-a)" style="stroke: var(--viz-line)"/>
  <rect x="214" y="20" width="170" height="52" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="299" y="42" font-size="13" font-weight="700" text-anchor="middle">view v1</text>
  <text x="299" y="61" font-size="12" text-anchor="middle">old schema</text>
  <rect x="214" y="104" width="170" height="52" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="299" y="126" font-size="13" font-weight="700" text-anchor="middle">view v2</text>
  <text x="299" y="145" font-size="12" text-anchor="middle">new schema, from replay</text>
  <rect x="520" y="52" width="104" height="56" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="572" y="85" font-size="13" font-weight="700" text-anchor="middle">Readers</text>
  <line x1="518" y1="70" x2="386" y2="48" stroke-width="2" marker-end="url(#c12d-migrate-w-c6)" style="stroke: var(--viz-c6)"/>
  <line x1="518" y1="90" x2="386" y2="128" stroke-width="1.2" marker-end="url(#c12d-migrate-w-c6)" style="stroke: var(--viz-c6)"/>
  <text x="452" y="52" font-size="12" font-weight="700" text-anchor="middle" class="viz-halo">90%</text>
  <text x="452" y="126" font-size="12" font-weight="700" text-anchor="middle" class="viz-halo">10%</text>
  <text x="16" y="190" font-size="12" style="fill: var(--viz-muted)">share of reads, v1 / v2</text>
  <rect x="214" y="172" width="80" height="26" rx="13" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="254" y="190" font-size="12" text-anchor="middle">90 / 10</text>
  <rect x="324" y="172" width="80" height="26" rx="13" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="364" y="190" font-size="12" text-anchor="middle">50 / 50</text>
  <rect x="434" y="172" width="80" height="26" rx="13" stroke-width="1.5" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <text x="474" y="190" font-size="12" text-anchor="middle">0 / 100</text>
  <line x1="294" y1="185" x2="322" y2="185" stroke-width="1.5" marker-end="url(#c12d-migrate-w-a)" style="stroke: var(--viz-line)"/>
  <line x1="404" y1="185" x2="432" y2="185" stroke-width="1.5" marker-end="url(#c12d-migrate-w-a)" style="stroke: var(--viz-line)"/>
  <path d="M 474 200 C 474 228, 254 228, 254 202" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c12d-migrate-w-m)" style="fill: none; stroke: var(--viz-muted)"/>
  <text x="364" y="238" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">roll back any time: just move reads back</text>
</svg><svg class="c12d-migrate-n" viewBox="0 0 360 342" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="One event log feeds view v1 and view v2. Readers send 90 percent of reads to v1 and 10 percent to v2; the split moves from 90/10 to 50/50 to 0/100 and can roll back.">
  <defs>
    <marker id="c12d-migrate-n-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-line)"/></marker>
    <marker id="c12d-migrate-n-c6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker>
    <marker id="c12d-migrate-n-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <text x="180" y="18" font-size="12" font-weight="700" text-anchor="middle">event log</text>
  <rect x="100" y="26" width="40" height="30" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="140" y="26" width="40" height="30" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="180" y="26" width="40" height="30" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="220" y="26" width="40" height="30" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <g font-size="12" text-anchor="middle"><text x="120" y="46">0</text><text x="160" y="46">1</text><text x="200" y="46">2</text><text x="240" y="46">…</text></g>
  <line x1="150" y1="56" x2="96" y2="98" stroke-width="1.5" marker-end="url(#c12d-migrate-n-a)" style="stroke: var(--viz-line)"/>
  <line x1="210" y1="56" x2="264" y2="98" stroke-width="1.5" marker-end="url(#c12d-migrate-n-a)" style="stroke: var(--viz-line)"/>
  <rect x="12" y="100" width="160" height="50" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="92" y="121" font-size="13" font-weight="700" text-anchor="middle">view v1</text>
  <text x="92" y="140" font-size="12" text-anchor="middle">old schema</text>
  <rect x="188" y="100" width="160" height="50" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="268" y="121" font-size="13" font-weight="700" text-anchor="middle">view v2</text>
  <text x="268" y="140" font-size="12" text-anchor="middle">new, from replay</text>
  <rect x="110" y="196" width="140" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="180" y="221" font-size="13" font-weight="700" text-anchor="middle">Readers</text>
  <line x1="150" y1="196" x2="96" y2="152" stroke-width="2" marker-end="url(#c12d-migrate-n-c6)" style="stroke: var(--viz-c6)"/>
  <line x1="210" y1="196" x2="264" y2="152" stroke-width="1.2" marker-end="url(#c12d-migrate-n-c6)" style="stroke: var(--viz-c6)"/>
  <text x="112" y="182" font-size="12" font-weight="700" text-anchor="end">90%</text>
  <text x="248" y="182" font-size="12" font-weight="700">10%</text>
  <text x="180" y="252" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">share of reads, v1 / v2</text>
  <rect x="16" y="260" width="96" height="26" rx="13" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="64" y="278" font-size="12" text-anchor="middle">90 / 10</text>
  <rect x="132" y="260" width="96" height="26" rx="13" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="180" y="278" font-size="12" text-anchor="middle">50 / 50</text>
  <rect x="248" y="260" width="96" height="26" rx="13" stroke-width="1.5" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <text x="296" y="278" font-size="12" text-anchor="middle">0 / 100</text>
  <line x1="112" y1="273" x2="130" y2="273" stroke-width="1.5" marker-end="url(#c12d-migrate-n-a)" style="stroke: var(--viz-line)"/>
  <line x1="228" y1="273" x2="246" y2="273" stroke-width="1.5" marker-end="url(#c12d-migrate-n-a)" style="stroke: var(--viz-line)"/>
  <path d="M 296 288 C 296 314, 64 314, 64 290" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c12d-migrate-n-m)" style="fill: none; stroke: var(--viz-muted)"/>
  <text x="180" y="334" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">roll back any time</text>
</svg>`,
          caption: `Both views are derived from the same log, so neither is a copy of the other and both stay current. Reads shift a step at a time; because the old view keeps running, every step can be undone until it is finally deleted.`,
        },
        {
          type: "text",
          html: `<h3>The Lambda architecture</h3>
<p>Nathan Marz described the <strong>Lambda architecture</strong> in his 2011 post "How to beat the CAP theorem" and later in the book <em>Big Data</em> (Manning, 2015, with James Warren). Incoming data is recorded as immutable events appended to an ever-growing master dataset. A <strong>batch layer</strong> (originally Hadoop MapReduce) periodically recomputes read-optimized batch views from all of it. A <strong>speed layer</strong> (originally Storm) processes the events that arrived since the last batch run and keeps real-time views of them. A <strong>serving layer</strong> makes the batch views queryable, and each query merges them with the speed layer's real-time views.</p>
<p>Lambda got the most important thing right: keep raw events immutable and treat every view as recomputable. Its split also suited the tools of 2011, when batch jobs were dependable and stream processors fast but far less mature; whatever the speed layer got wrong, the next batch run overwrote.</p>
<p>The visualization puts numbers on it. Over 30 days, video #42 has 29,600 recorded plays, 30% of them bots, so the true human count is 20,720. Fix the count in Lambda's speed layer only, in both codebases, or by Kappa-style replay with full or 7-day log retention.</p>`,
        },
        {
          type: "viz",
          id: "ch12/lambda-vs-kappa",
          title: "Fixing history: Lambda vs Kappa",
          caption: "Try Lambda with 'Speed layer only' and step through midnight: today's plays drop from 600 to 420, then jump back to 600 when they move into the batch view. Then try Kappa with 'Forever' and with '7 days'. Notice that Kappa's fix lives in one codebase, but a replay can only rebuild what the log still holds.",
        },
        {
          type: "text",
          html: `<h3>What Lambda costs</h3>
<p>The biggest problem is the one you just watched: <strong>the same logic lives in two frameworks</strong>, and every fix and edge case must be written twice and kept equivalent forever. Abstraction layers help (Twitter's Summingbird ran one Scala program on Hadoop and on Storm), but you still debug and operate two systems with different failure modes.</p>
<p>Second, <strong>the two outputs must be merged</strong> at query time. Adding a counter "up to midnight" to a counter "since midnight" is easy. Merging the two halves of a join, a sessionization or any output that isn't a simple time-series aggregate is hard, and a mistake at the boundary double-counts or drops events.</p>
<p>Third, <strong>recomputing everything is expensive</strong>. Reprocessing years of data every night stops being affordable at scale, so batch layers drift toward incremental batches (an hour at a time, say). That brings back what the batch layer was supposed to avoid: events straddling batch boundaries, stragglers, and careful reasoning about time. The batch layer is no longer the simple part.</p>
<h3>One engine for both</h3>
<p>The alternative is to drop the second system and make one stream processor good enough to handle both the live stream and the reprocessing of history. Jay Kreps named this the <strong>Kappa architecture</strong> in his 2014 essay "Questioning the Lambda Architecture": keep only the stream path, and when the code changes, replay the retained log through a second copy of the job. It has two preconditions Lambda did not: the log must still hold the full history (a compacted topic is enough only for views that need just the latest value per key), and the processor must replay much faster than real time. The book frames the goal as unifying batch and stream processing in one system. That takes three capabilities; the last two steps below are the reprocessing recipe itself.</p>`,
        },
        {
          type: "steps",
          title: "Unifying batch and stream, then reprocessing",
          items: [
            `<strong>Replay history through the same engine.</strong> The processor must read historical events as easily as live ones: a log-based broker can rewind a consumer to offset 0, and some stream processors can also read bounded input from HDFS or object storage.`,
            `<strong>Exactly-once semantics.</strong> The output must be as if no fault had happened, even if the job crashed and restarted halfway through a replay; otherwise a recomputed view is only roughly right (Chapter 11).`,
            `<strong>Windowing by event time.</strong> When you replay a year of events in an hour, processing time means nothing. Windows must be defined by when each event happened, not when it was processed (Chapter 11).`,
            `<strong>Start the new version beside the old.</strong> Launch a second instance of the job with the new code, reading from the start of the retained log and writing to a new output table. The old job keeps serving reads while the new one catches up to the live head.`,
            `<strong>Compare, switch, clean up.</strong> Check the two tables against each other, move readers to the new one, and only then stop the old job and delete its table. Until that last step, rolling back is just moving readers back.`,
          ],
        },
        {
          type: "text",
          html: `<p>Replay is only safe if the job is deterministic and free of side effects: event-time windows, no wall-clock reads, no calls to mutable external services (record exchange-rate changes as events and join against their history), and versioned or idempotent sinks (<code>plays_v2</code>, not "the" table). Never replay a consumer that sends emails or charges cards; split side effects into their own consumer, or replay in a mode that only rebuilds state.</p>
<p>Batch did not disappear, either. Warehouses and lakehouses still recompute large tables in bulk, and many teams run batch and streaming side by side. The lasting lesson is narrower and more useful: each derivation should have <strong>one definition in one codebase</strong>, whichever engine executes it.</p>`,
        },
        {
          type: "compare",
          title: "Three ways to keep views correct over time",
          items: [
            {
              title: "Lambda",
              tone: "warn",
              html: `<p><strong>Shape:</strong> immutable master dataset; batch layer recomputes everything, speed layer covers recent events; queries merge both.</p><p><strong>Fixing history:</strong> happens at the next batch run, once the fix is in the batch code too.</p><p><strong>Cost:</strong> two implementations to keep equivalent and a merge step that must know the time boundary.</p>`,
            },
            {
              title: "Kappa",
              tone: "ok",
              html: `<p><strong>Shape:</strong> one stream job over a retained log.</p><p><strong>Fixing history:</strong> replay the log into a new table with the new code, then switch reads.</p><p><strong>Cost:</strong> the log must keep full history (compaction suffices only for latest-value-per-key views) and the job must replay far faster than real time.</p>`,
            },
            {
              title: "Unified engine",
              tone: "info",
              html: `<p><strong>Shape:</strong> one program, two execution modes: Flink, Spark Structured Streaming or Apache Beam run the same code over bounded and unbounded inputs.</p><p><strong>Fixing history:</strong> run the program in batch mode over archived data, in streaming mode over the live log.</p><p><strong>Cost:</strong> the program must be written with event-time semantics from the start.</p>`,
            },
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Twitter (Storm, Summingbird)",
              year: "2011–2013",
              tag: "Lambda in production",
              html: `Storm came to Twitter with its 2011 acquisition of BackType, where Marz built it, and was open-sourced that year. Twitter later built Summingbird (open-sourced in 2013) so the same Scala logic could run on Hadoop via Scalding and on Storm: a direct response to Lambda's "write it twice" problem.`,
            },
            {
              org: "Jay Kreps / LinkedIn",
              year: "2014",
              tag: "Kappa",
              html: `In "Questioning the Lambda Architecture" (O'Reilly Radar, July 2014), Kreps argued that reprocessing can be done by replaying a retained Kafka log through a second copy of the stream job writing to a new table, and gave the approach the name Kappa architecture.`,
            },
            {
              org: "Google Dataflow / Apache Beam",
              year: "2015",
              tag: "unified model",
              html: `The Dataflow Model paper (Akidau et al., VLDB 2015) unified batch and streaming around event-time windows, triggers and watermarks. Its SDK became Apache Beam, a top-level Apache project since January 2017, whose pipelines run on Flink, Spark and Google Cloud Dataflow.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Replay has become much cheaper since 2017. Flink's DataStream API gained a batch execution mode in Flink 1.12 (2020), and Spark Structured Streaming (introduced in Spark 2.0 in 2016 and production-ready from 2.2 in 2017) runs the same query over bounded and unbounded inputs. Kafka's tiered storage (KIP-405, early access in Kafka 3.6 and production-ready in 3.9) lets brokers move old log segments to object storage, so keeping months or years of history for replay no longer means buying that much broker disk. Table formats such as Apache Iceberg and Delta Lake let one table act as both a streaming sink and a batch source.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: a metric has been wrong for six months. How do you fix the history?",
          html: `<p>A strong answer starts with whether the raw events still exist: in the log (long retention or tiered storage) or in an archive in object storage. If they do, deploy the fixed job as a <em>new</em> consumer group from the earliest offset, writing to a new versioned table, with event-time windows so the replayed results match what live processing would have produced. Disable side effects during the replay. Estimate replay speed (six months at 50x real time is about four days) and plan capacity so the replay doesn't starve the live job. Validate by comparing the two tables, then switch reads with an alias or view and keep the old table for rollback. If the history is gone, say so: you can only fix what you kept.</p>`,
        },
        {
          type: "quiz",
          q: "A team keeps 3 days of Kafka retention and wants to adopt the Kappa approach to fix a bug in a metric covering the last year. What is the real blocker?",
          options: [
            "Kafka cannot deliver old messages to a new consumer group",
            "The stream job would have to be rewritten in a batch framework",
            "The log no longer contains the events older than 3 days, so replay cannot rebuild the year; they need longer retention, tiered storage or a backfill from an archive",
            "Stream processors cannot produce correct results without processing-time windows",
          ],
          answer: 2,
          explain: "Kappa reprocessing means replaying retained events through the new code, and the events from before the last 3 days are simply gone. A new consumer group can start at the earliest retained offset, so Kafka itself isn't the obstacle, and the point of Kappa is that the same stream code is reused, not rewritten. Correct reprocessing needs event-time windows; processing-time windows would make replayed results depend on when the replay ran.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "unbundling-databases",
      title: "The database, turned inside out",
      kicker: "Architecture",
      concepts: ["unbundling-the-database", "federated-databases", "application-code-as-derivation", "dataflow-vs-rpc"],
      blocks: [
        {
          type: "problem",
          html: `<p>Inside one database, keeping derived structures in sync is solved for you: <code>CREATE INDEX</code> builds the index and keeps it current on every commit, materialized views follow their base tables, followers follow the leader. Move product search to Elasticsearch and all of that vanishes. Instead you get a nightly re-export, a dual write in the request handler that the bulk-import path forgot to call, and a backfill script someone runs by hand after every mapping change.</p>
<p>Application code fares no better. It polls the database, because databases are awkward places to deploy custom code and few can say "this result just changed." And microservices that call each other synchronously for every piece of data add a round trip to each request and fail together.</p>`,
        },
        {
          type: "text",
          html: `<p>Look at what a relational database does when you create an index on a table that is in use. It takes a consistent snapshot of the table, scans it to build the index, then processes the backlog of writes that happened during the build, and from then on updates the index together with every write. (PostgreSQL's <code>CREATE INDEX CONCURRENTLY</code> makes the phases visible: it scans the table twice and waits for older transactions to finish.)</p>
<p>That is exactly <strong>reprocessing plus following</strong>: replay the existing data, then follow the stream of changes. It is also how a new follower is set up (Chapter 5) and how change data capture bootstraps a new consumer (Chapter 11). Inside one database it is invisible; across systems you rebuild it by hand for every store, which is where the bugs above come from.</p>`,
        },
        {
          type: "diagram",
          title: "The same roles, inside one database and unbundled",
          svg: `<style>.dd-diagram-body svg.c12d-inside-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c12d-inside-w{display:none}.dd-diagram-body svg.c12d-inside-n{display:block}}</style><svg class="c12d-inside-w" viewBox="0 0 640 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left: one database containing a replication log, indexes, materialized views and triggers. A dashed arrow labelled unbundle points right, to a Kafka log feeding Elasticsearch for indexes, Redis and a warehouse for materialized views, and stream processors for triggers and application code.">
  <defs>
    <marker id="c12d-inside-w-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-line)"/></marker>
    <marker id="c12d-inside-w-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <text x="10" y="20" font-size="13" font-weight="700">Inside one database</text>
  <rect x="10" y="30" width="250" height="184" rx="10" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="26" y="44" width="218" height="32" rx="6" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="135" y="65" font-size="13" text-anchor="middle">replication log</text>
  <rect x="26" y="86" width="218" height="32" rx="6" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="135" y="107" font-size="13" text-anchor="middle">indexes</text>
  <rect x="26" y="128" width="218" height="32" rx="6" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="135" y="149" font-size="13" text-anchor="middle">materialized views</text>
  <rect x="26" y="170" width="218" height="32" rx="6" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="135" y="191" font-size="13" text-anchor="middle">triggers</text>
  <line x1="266" y1="122" x2="332" y2="122" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c12d-inside-w-m)" style="stroke: var(--viz-muted)"/>
  <text x="298" y="112" font-size="12" font-weight="700" text-anchor="middle" class="viz-halo">unbundle</text>
  <text x="340" y="20" font-size="13" font-weight="700">Unbundled</text>
  <rect x="340" y="96" width="110" height="52" rx="8" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="395" y="118" font-size="13" font-weight="700" text-anchor="middle">Kafka log</text>
  <text x="395" y="136" font-size="12" text-anchor="middle">replication log</text>
  <line x1="450" y1="122" x2="484" y2="52" stroke-width="1.5" marker-end="url(#c12d-inside-w-a)" style="stroke: var(--viz-line)"/>
  <line x1="450" y1="122" x2="484" y2="120" stroke-width="1.5" marker-end="url(#c12d-inside-w-a)" style="stroke: var(--viz-line)"/>
  <line x1="450" y1="122" x2="484" y2="188" stroke-width="1.5" marker-end="url(#c12d-inside-w-a)" style="stroke: var(--viz-line)"/>
  <rect x="486" y="30" width="146" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="559" y="49" font-size="13" text-anchor="middle">Elasticsearch</text>
  <text x="559" y="66" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">indexes</text>
  <rect x="486" y="98" width="146" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="559" y="117" font-size="13" text-anchor="middle">Redis, warehouse</text>
  <text x="559" y="134" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">materialized views</text>
  <rect x="486" y="166" width="146" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="559" y="185" font-size="13" text-anchor="middle">Stream processors</text>
  <text x="559" y="202" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">triggers, app code</text>
</svg><svg class="c12d-inside-n" viewBox="0 0 360 388" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top: one database containing a replication log, indexes, materialized views and triggers. Unbundled below: a Kafka log feeding Elasticsearch, Redis and a warehouse, and stream processors.">
  <defs>
    <marker id="c12d-inside-n-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-line)"/></marker>
    <marker id="c12d-inside-n-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <text x="12" y="20" font-size="13" font-weight="700">Inside one database</text>
  <rect x="12" y="28" width="336" height="94" rx="10" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="24" y="40" width="152" height="32" rx="6" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="100" y="61" font-size="12" text-anchor="middle">replication log</text>
  <rect x="184" y="40" width="152" height="32" rx="6" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="260" y="61" font-size="12" text-anchor="middle">indexes</text>
  <rect x="24" y="80" width="152" height="32" rx="6" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="100" y="101" font-size="12" text-anchor="middle">materialized views</text>
  <rect x="184" y="80" width="152" height="32" rx="6" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="260" y="101" font-size="12" text-anchor="middle">triggers</text>
  <line x1="180" y1="124" x2="180" y2="158" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c12d-inside-n-m)" style="stroke: var(--viz-muted)"/>
  <text x="192" y="146" font-size="12" font-weight="700">unbundle</text>
  <rect x="110" y="160" width="140" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="180" y="180" font-size="13" font-weight="700" text-anchor="middle">Kafka log</text>
  <text x="180" y="197" font-size="12" text-anchor="middle">replication log</text>
  <polyline points="110,182 26,182 26,358" stroke-width="1.5" style="fill: none; stroke: var(--viz-line)"/>
  <line x1="26" y1="250" x2="42" y2="250" stroke-width="1.5" marker-end="url(#c12d-inside-n-a)" style="stroke: var(--viz-line)"/>
  <line x1="26" y1="304" x2="42" y2="304" stroke-width="1.5" marker-end="url(#c12d-inside-n-a)" style="stroke: var(--viz-line)"/>
  <line x1="26" y1="358" x2="42" y2="358" stroke-width="1.5" marker-end="url(#c12d-inside-n-a)" style="stroke: var(--viz-line)"/>
  <rect x="44" y="230" width="300" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="194" y="255" font-size="12" text-anchor="middle">Elasticsearch (indexes)</text>
  <rect x="44" y="284" width="300" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="194" y="309" font-size="12" text-anchor="middle">Redis, warehouse (materialized views)</text>
  <rect x="44" y="338" width="300" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="194" y="363" font-size="12" text-anchor="middle">Stream processors (triggers, app code)</text>
</svg>`,
          caption: `Every role a database plays internally has a counterpart across systems. Unbundling keeps the roles and the guarantees, and makes each one a separate, replaceable component connected by the log.`,
        },
        {
          type: "table",
          title: "How each internal mechanism maps across systems",
          headers: ["Role", "Inside one database", "Unbundled"],
          rows: [
            ["Ordered record of changes", "Write-ahead log / replication log", "A durable log (Kafka), written by the app or fed by CDC"],
            ["Secondary index", "B-tree index, updated in the same transaction as the write", "Elasticsearch or another store, updated by a consumer of the log"],
            ["Materialized view", "Refreshed by the database", "Output table of a stream processor (Kafka Streams, Flink, Materialize)"],
            ["Triggers, stored procedures", "Code run inside the database on each change", "A stream processor running ordinary application code on each event"],
            ["Querying across structures", "The query planner picks indexes", "A federated query engine (Trino, PostgreSQL foreign data wrappers)"],
            ["Recovery", "Replay the write-ahead log after a crash", "A consumer resumes from its last committed offset; a view is rebuilt by replay from offset 0"],
          ],
        },
        {
          type: "text",
          html: `<h3>Two philosophies, two ways to unify</h3>
<p>Unix and relational databases attacked the same problem from opposite ends (Chapter 10). Unix offers small tools that compose through a uniform, low-level interface: bytes through a pipe. A relational database offers a high-level declarative language that hides storage, concurrency and recovery. Unbundling wants both: Unix-style composition of specialized stores, with database-style guarantees that they stay consistent.</p>
<p>Step back and the dataflow across a whole organization looks like one enormous database, with batch jobs, stream processors and ETL pipelines playing the part of index maintenance and view refresh. There are two ways to make such a collection behave like one system:</p>
<ul>
<li><strong>Federated databases unify reads.</strong> One query interface sits over many storage engines and pushes each part of a query to the engine that holds the data: PostgreSQL's foreign data wrappers, or Trino joining Hive, MySQL and Kafka in one SQL statement. Federation is handy for exploration, but it has no answer for keeping the underlying stores consistent when data is written.</li>
<li><strong>Unbundled databases unify writes.</strong> Every change is recorded once, in a log, and propagated reliably to every store that needs it. Synchronizing writes is both the harder problem and the more important one: a federated query over stores that disagree just returns the disagreement faster.</li>
</ul>`,
        },
        {
          type: "compare",
          title: "Integrated, federated or unbundled?",
          items: [
            {
              title: "Integrated database",
              tone: "ok",
              html: `<p>One product handles storage, indexes, views and transactions.</p><p><strong>Best at:</strong> predictable performance and strong consistency for the workload it was designed for.</p><p><strong>Limit:</strong> one storage layout and one vendor's feature set.</p>`,
            },
            {
              title: "Federated (unify reads)",
              tone: "info",
              html: `<p>One SQL interface over many stores: Trino, foreign data wrappers.</p><p><strong>Best at:</strong> ad-hoc analysis across silos without copying data first.</p><p><strong>Limit:</strong> does nothing to keep the stores in sync with each other.</p>`,
            },
            {
              title: "Unbundled (unify writes)",
              tone: "warn",
              html: `<p>One log; many derived stores maintained by consumers.</p><p><strong>Best at:</strong> using the right store for each access pattern while keeping them consistent; faults stay local.</p><p><strong>Limit:</strong> many moving parts, views that lag, and glue you build and operate yourself.</p>`,
            },
          ],
        },
        {
          type: "text",
          html: `<h3>Making unbundling work</h3>
<p>The classic tool here would be a distributed transaction across all the stores. The book argues that an <strong>asynchronous event log with idempotent writes</strong> is far more robust and practical: XA requires every system to speak one atomic-commit protocol, which search engines and caches usually don't, and binds every participant's fate together. A log gives two kinds of loose coupling instead:</p>
<ul>
<li><strong>System level.</strong> If a consumer is slow or down, the log buffers its input; it falls behind and catches up later, and the producer and the other consumers are unaffected. A synchronous distributed transaction turns a local fault (one slow participant) into a large-scale failure (every write blocked or aborted).</li>
<li><strong>Human level.</strong> Different teams can own the producer and each consumer, and develop, deploy and rebuild them independently. The log, and the schema of the events on it, is the contract between them.</li>
</ul>
<p>None of this means replacing databases. Every stage still needs a storage engine, and an integrated system usually performs better and more predictably for the workload it was built for. If one technology does everything you need, use it; unbundling earns its complexity only when no single product meets your requirements.</p>
<p>What was missing when the book was written is the declarative glue: a Unix pipe between storage systems (<code>mysql | elasticsearch</code>), or a <code>CREATE INDEX</code> across systems, where you declare that a MySQL table should be searchable in Elasticsearch and the infrastructure handles snapshot, backlog and ongoing updates. Research on <strong>incremental view maintenance</strong>, notably differential dataflow, pointed toward precomputed results that keep themselves current.</p>`,
        },
        {
          type: "text",
          html: `<h3>Application code as a derivation function</h3>
<p>Once every derived dataset is fed from a log, the code that computes it is a function from input events to output state. Some such functions are standard enough that databases ship them: a secondary index picks a field and sorts by it. Others are custom: a full-text index needs per-language tokenization and stemming, a recommendation model needs feature extraction and training, a cache holds data shaped for the UI. Those need application code, and databases host it poorly: deploying, versioning and scaling stored procedures is clumsy next to ordinary services.</p>
<p>So the dominant pattern became stateless application servers beside a database that acts as one big shared, mutable variable. But most databases offer no <strong>observer pattern</strong>: you can read the variable, not ask to be told when a query's answer changes, so applications poll.</p>`,
        },
        {
          type: "analogy",
          title: "A spreadsheet already works this way",
          html: `<p>Put a formula in cell C1 that adds A1 and B1, then change A1. C1 updates at once, and so does every cell that depends on C1, without anyone re-running anything. VisiCalc did this in 1979. Unbundled data systems want exactly that behavior for derived data, except durable, fault-tolerant, spread over many machines and built from different technologies.</p>`,
        },
        {
          type: "text",
          html: `<h3>Dataflow: state changes drive code</h3>
<p>Unbundling turns the database's internal machinery (index maintenance, materialized views, replication) into application code running in stream processors; Kleppmann called it "turning the database inside out." Two requirements are non-negotiable. <strong>Order matters</strong>: a view must apply changes in the order they happened, and many message brokers reorder on redelivery (Chapter 11). And <strong>nothing may be lost or doubled</strong>: one dropped message leaves the derived dataset permanently out of step, so processing must be effectively exactly-once, or idempotent.</p>
<h3>Stream processors and services</h3>
<p>The same thinking changes how services talk to each other. The book's example: a purchase is priced in one currency and paid in another, so the purchase service needs the current exchange rate. The microservices instinct is a synchronous request to an exchange-rate service for every purchase. The dataflow alternative is for the purchase service to subscribe to the stream of rate updates, keep the latest rates in a local table, and look the rate up locally when a purchase arrives.</p>`,
        },
        {
          type: "diagram",
          title: "Asking on every request vs subscribing to changes",
          svg: `<style>.dd-diagram-body svg.c12d-rpc-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c12d-rpc-w{display:none}.dd-diagram-body svg.c12d-rpc-n{display:block}}</style><svg class="c12d-rpc-w" viewBox="0 0 640 244" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left, request/response: for every purchase the purchase service makes a synchronous request to the exchange-rate service, so if that service is down purchases fail. Right, dataflow: the exchange-rate service publishes rate updates to a log, the purchase service keeps a local rates table, and each purchase does a local lookup.">
  <defs>
    <marker id="c12d-rpc-w-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-line)"/></marker>
    <marker id="c12d-rpc-w-c6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker>
  </defs>
  <text x="12" y="20" font-size="13" font-weight="700">Request/response</text>
  <rect x="20" y="40" width="150" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="95" y="67" font-size="13" text-anchor="middle">Purchase service</text>
  <rect x="210" y="47" width="70" height="30" rx="15" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="245" y="67" font-size="12" text-anchor="middle">buy</text>
  <line x1="210" y1="62" x2="172" y2="62" stroke-width="1.5" marker-end="url(#c12d-rpc-w-c6)" style="stroke: var(--viz-c6)"/>
  <line x1="95" y1="84" x2="95" y2="134" stroke-width="1.5" marker-end="url(#c12d-rpc-w-a)" style="stroke: var(--viz-line)"/>
  <text x="105" y="104" font-size="12">GET rate,</text>
  <text x="105" y="119" font-size="12">every purchase</text>
  <rect x="20" y="136" width="150" height="44" rx="8" stroke-width="1.5" stroke-dasharray="5 3" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
  <text x="95" y="163" font-size="12" text-anchor="middle">Exchange-rate service</text>
  <line x1="170" y1="158" x2="208" y2="158" stroke-width="1.5" marker-end="url(#c12d-rpc-w-a)" style="stroke: var(--viz-line)"/>
  <rect x="210" y="140" width="80" height="36" rx="6" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="250" y="163" font-size="12" text-anchor="middle">rates DB</text>
  <text x="20" y="206" font-size="12" style="fill: var(--viz-bad)">if it is down, purchases fail</text>
  <text x="20" y="224" font-size="12" style="fill: var(--viz-muted)">+1 network round trip per purchase</text>
  <line x1="318" y1="10" x2="318" y2="234" stroke-width="1" style="stroke: var(--viz-grid)"/>
  <text x="340" y="20" font-size="13" font-weight="700">Dataflow (subscribe)</text>
  <rect x="420" y="36" width="212" height="78" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="526" y="56" font-size="13" text-anchor="middle">Purchase service</text>
  <rect x="440" y="68" width="172" height="32" rx="6" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-c1)"/>
  <text x="526" y="89" font-size="12" text-anchor="middle">local rates table</text>
  <rect x="340" y="69" width="60" height="30" rx="15" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="370" y="89" font-size="12" text-anchor="middle">buy</text>
  <line x1="400" y1="84" x2="438" y2="84" stroke-width="1.5" marker-end="url(#c12d-rpc-w-c6)" style="stroke: var(--viz-c6)"/>
  <rect x="340" y="150" width="150" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="415" y="175" font-size="12" text-anchor="middle">Exchange-rate service</text>
  <line x1="490" y1="170" x2="512" y2="170" stroke-width="1.5" marker-end="url(#c12d-rpc-w-a)" style="stroke: var(--viz-line)"/>
  <rect x="514" y="156" width="30" height="28" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="544" y="156" width="30" height="28" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="574" y="156" width="30" height="28" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <line x1="559" y1="156" x2="559" y2="103" stroke-width="1.5" marker-end="url(#c12d-rpc-w-a)" style="stroke: var(--viz-line)"/>
  <text x="559" y="202" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">rate updates log</text>
  <text x="340" y="218" font-size="12" style="fill: var(--viz-ok)">local lookup; survives a rate-service outage</text>
  <text x="340" y="236" font-size="12" style="fill: var(--viz-muted)">uses the rate as of purchase time</text>
</svg><svg class="c12d-rpc-n" viewBox="0 0 360 524" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top, request/response: the purchase service calls the exchange-rate service on every purchase, so an outage fails purchases. Bottom, dataflow: rate updates flow through a log into a local rates table inside the purchase service, which each purchase reads locally.">
  <defs>
    <marker id="c12d-rpc-n-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-line)"/></marker>
    <marker id="c12d-rpc-n-c6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker>
  </defs>
  <text x="12" y="20" font-size="13" font-weight="700">Request/response</text>
  <rect x="20" y="34" width="170" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="105" y="61" font-size="13" text-anchor="middle">Purchase service</text>
  <rect x="250" y="41" width="80" height="30" rx="15" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="290" y="61" font-size="12" text-anchor="middle">buy</text>
  <line x1="250" y1="56" x2="192" y2="56" stroke-width="1.5" marker-end="url(#c12d-rpc-n-c6)" style="stroke: var(--viz-c6)"/>
  <line x1="105" y1="78" x2="105" y2="124" stroke-width="1.5" marker-end="url(#c12d-rpc-n-a)" style="stroke: var(--viz-line)"/>
  <text x="115" y="98" font-size="12">GET rate,</text>
  <text x="115" y="113" font-size="12">every purchase</text>
  <rect x="20" y="126" width="170" height="44" rx="8" stroke-width="1.5" stroke-dasharray="5 3" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
  <text x="105" y="153" font-size="12" text-anchor="middle">Exchange-rate service</text>
  <line x1="190" y1="148" x2="238" y2="148" stroke-width="1.5" marker-end="url(#c12d-rpc-n-a)" style="stroke: var(--viz-line)"/>
  <rect x="240" y="130" width="90" height="36" rx="6" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="285" y="153" font-size="12" text-anchor="middle">rates DB</text>
  <text x="20" y="194" font-size="12" style="fill: var(--viz-bad)">if it is down, purchases fail</text>
  <text x="20" y="212" font-size="12" style="fill: var(--viz-muted)">+1 network round trip per purchase</text>
  <line x1="12" y1="228" x2="348" y2="228" stroke-width="1" style="stroke: var(--viz-grid)"/>
  <text x="12" y="252" font-size="13" font-weight="700">Dataflow (subscribe)</text>
  <rect x="240" y="260" width="90" height="26" rx="13" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="285" y="278" font-size="12" text-anchor="middle">buy</text>
  <rect x="20" y="296" width="320" height="64" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="36" y="333" font-size="13" font-weight="700">Purchase service</text>
  <rect x="190" y="308" width="136" height="40" rx="6" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-c1)"/>
  <text x="258" y="332" font-size="12" text-anchor="middle">local rates table</text>
  <line x1="285" y1="286" x2="285" y2="306" stroke-width="1.5" marker-end="url(#c12d-rpc-n-c6)" style="stroke: var(--viz-c6)"/>
  <rect x="192" y="384" width="44" height="28" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="236" y="384" width="44" height="28" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="280" y="384" width="44" height="28" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="182" y="403" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">rate updates</text>
  <line x1="258" y1="384" x2="258" y2="350" stroke-width="1.5" marker-end="url(#c12d-rpc-n-a)" style="stroke: var(--viz-line)"/>
  <rect x="170" y="436" width="176" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="258" y="459" font-size="12" text-anchor="middle">Exchange-rate service</text>
  <line x1="258" y1="436" x2="258" y2="414" stroke-width="1.5" marker-end="url(#c12d-rpc-n-a)" style="stroke: var(--viz-line)"/>
  <text x="20" y="494" font-size="12" style="fill: var(--viz-ok)">local lookup; survives a rate-service outage</text>
  <text x="20" y="512" font-size="12" style="fill: var(--viz-muted)">uses the rate as of purchase time</text>
</svg>`,
          caption: `With request/response, every purchase depends on the exchange-rate service being up and fast. With a subscription, rate changes are pushed ahead of time, and the purchase reads a local copy.`,
        },
        {
          type: "text",
          html: `<p>The dataflow version is faster, since a local read replaces a network round trip, and more robust: if the exchange-rate service is down, purchases still go through using the latest rate received. No network call is faster or more dependable than one you skip entirely. It is also more honest about time. The purchase is really a stream-table join between purchase events and the rate table as of the moment of purchase (Chapter 11). If you later reprocess last month's purchases, you must join them with the rates that applied then, not today's, which means keeping the rate history rather than only the latest value.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Turning the database inside out",
              year: "2014–2015",
              tag: "the idea",
              html: `Kleppmann presented the idea at Strange Loop 2014 and published it in 2015 as "Turning the database inside-out with Apache Samza" on the Confluent blog: the replication log, indexes and materialized views pulled out of the database and rebuilt as Kafka plus stream processors.`,
            },
            {
              org: "PostgreSQL FDW / Trino",
              tag: "federation",
              html: `PostgreSQL implements SQL/MED foreign data wrappers (such as <code>postgres_fdw</code>) to query external sources as if they were tables, and Trino (formerly PrestoSQL, from Facebook's Presto, open-sourced in 2013) queries many stores through connectors. Both are federated systems: they unify reads, not writes.`,
            },
            {
              org: "Materialize",
              year: "2019",
              tag: "incremental views",
              html: `Materialize, founded in 2019, maintains SQL views incrementally over streaming inputs, built on Timely Dataflow and Differential Dataflow, research systems created by Frank McSherry and colleagues. It comes close to the "CREATE INDEX across systems" the book wished for.`,
            },
            {
              org: "Kafka Streams / ksqlDB",
              year: "2016–2017",
              tag: "app code as derivation",
              html: `Kafka Streams (2016) keeps local state stores backed by changelog topics, so a service's derived state can be rebuilt from Kafka. ksqlDB, announced as KSQL in 2017, lets you declare tables materialized from Kafka topics in SQL.`,
            },
          ],
        },
        {
          type: "tradeoffs",
          title: "What unbundling buys and what it costs",
          pros: [
            "Each store fits its access pattern: search in a search engine, aggregates in a warehouse",
            "Faults stay local: a broken consumer lags behind instead of blocking writes",
            "Teams own the producer and each consumer and deploy independently",
            "New views can be added years later by replaying the log",
            "Fewer synchronous calls between services, so lower latency and fewer cascading failures",
          ],
          cons: [
            "Many moving parts to deploy, monitor and upgrade",
            "Views are eventually consistent; read-your-writes across stores needs extra work",
            "Event schemas on the log become public APIs with compatibility rules (Chapter 4)",
            "Tracing a wrong value means following it through several systems",
            "Much of the glue (connectors, sinks, backfills) is still assembled by hand",
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Since the book, much of this glue has become off-the-shelf. Debezium connectors running on Kafka Connect are a common way to turn database logs into topics, and sink connectors feed Elasticsearch, warehouses and object storage. Streaming databases such as Materialize and RisingWave, along with ksqlDB and Flink SQL, let you write <code>CREATE MATERIALIZED VIEW</code> over Kafka topics and CDC streams and have the result maintained incrementally: a partial answer to the "declarative unbundling" the book was missing. None of it is free, though: each of these is another system to run.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: data architecture for e-commerce search, recommendations and analytics",
          html: `<p>A strong answer names the system of record for each entity, propagates changes through a log (CDC or a transactional outbox) to the derived stores, and has services subscribe to reference data such as prices or exchange rates instead of calling for it on the hot path, while noting staleness and time-correct joins. It keeps synchronous calls where an immediate, authoritative answer is required, such as reserving the last seat. It then names the costs: eventual consistency, schema governance for topics, and the operational load of many systems. Weak answers go to one extreme or the other: put everything on Kafka by default, or declare one database enough without looking at the access patterns.</p>`,
        },
        {
          type: "quiz",
          q: "Why does the book argue that an asynchronous log with idempotent consumers is a better way to keep heterogeneous stores in sync than distributed transactions across them?",
          options: [
            "Because logs give stronger consistency than two-phase commit",
            "Because a slow or failed consumer only falls behind and catches up later, while a distributed transaction makes every participant's failure everyone's failure, and most stores don't support a common transaction protocol anyway",
            "Because logs remove the need for any deduplication",
            "Because distributed transactions cannot preserve the order of writes",
          ],
          answer: 1,
          explain: "The log decouples systems: faults stay local, and teams can evolve consumers independently. It does not give stronger consistency than 2PC; it is usually asynchronous, so views lag, which is the price paid for the decoupling. It increases rather than removes the need for idempotence, because redelivery after a crash is normal. And two-phase locking with atomic commit does order conflicting writes; the problem with 2PC is fragility and lack of support, not ordering.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "write-path-read-path",
      title: "Where the write path meets the read path",
      kicker: "Observing derived state",
      concepts: ["write-path-read-path", "pushing-state-to-clients", "reads-as-events"],
      blocks: [
        {
          type: "problem",
          html: `<p>A product page is read 50,000 times a second, and its data changes a few times an hour, yet the application rebuilds it from five tables on every request. Down the hall, someone proposes making search instant by precomputing the results of every possible query, so each new product would update millions of result lists. Teams make these calls one at a time, adding a cache here and dropping an index there, without noticing they are the same decision: <strong>how much work to do when data is written, and how much when it is read</strong>.</p>
<p>And the last copy in the chain, the customer's browser tab, shows a price that changed ten minutes ago, because request/response hands out a snapshot with no way to learn that it changed.</p>`,
        },
        {
          type: "text",
          html: `<p>Follow one document through a search system. On the <strong>write path</strong>, it is stored, broken into terms, and each term's entry in the inverted index is updated, eagerly, whether or not anyone ever searches for those words. On the <strong>read path</strong>, a query looks up each term in the index, intersects the matching lists and ranks the results, lazily, only when someone asks.</p>
<p>The inverted index is where the two paths meet: everything before it is done once per write, everything after it once per read. Functional programmers will recognize <strong>eager versus lazy evaluation</strong>. The meeting point is a choice, and every index, cache and materialized view moves it.</p>
<h3>Sliding the boundary</h3>
<ol>
<li><strong>No index.</strong> Writes are trivial (append the document), but every query scans every document, like <code>grep</code>. Fine for a few thousand documents, hopeless for a billion.</li>
<li><strong>Inverted index.</strong> Each write does extra work (an entry per term); each query becomes a few index lookups and a merge.</li>
<li><strong>Index plus a cache of popular results.</strong> Answers to common queries are precomputed and refreshed when a matching document changes; rare queries still go through the index.</li>
<li><strong>Precompute every possible query.</strong> Each read is a single lookup, but the set of possible queries is effectively infinite, so each new document would have to update an unbounded number of result lists.</li>
</ol>
<p>Which point is cheapest depends on the read/write ratio and on how concentrated the queries are. The visualization puts a simple cost model on it: pick how much to precompute, set the workload, and compare the work on each path.</p>`,
        },
        {
          type: "viz",
          id: "ch12/write-read-boundary",
          title: "Moving the write/read boundary",
          caption: "Try the two presets: with 100k reads/s and 1 write/s, precomputing every query becomes cheapest; with 1,000 writes/s and almost no reads, doing nothing wins. With 'Index + cache' selected, drag the cache hit rate. Notice that the two kinds of control do different jobs: picking a strategy (or clicking its bar) slides the dashed boundary along the pipeline and highlights that bar, while the workload sliders resize every bar. Each bar is the same search job, split differently between write-path and read-path work.",
        },
        {
          type: "text",
          html: `<p>The model is crude, but its shape is real. At the defaults, a cache on top of the index is cheapest: the index makes each write cost about a hundred units, and the cache turns 80% of reads into one lookup. Make the workload read-heavy and full precomputation wins despite 5,000-unit writes, because writes are now rare; make it write-heavy and even the index is overhead nobody uses. (To stay finite, the model's "every query" means only the 5,050 one- and two-word queries a 100-term document can match. A real query space is unbounded, which is why the extreme is impractical.) Caches, indexes and materialized views are not separate techniques but <strong>positions of one boundary</strong>.</p>
<p>You have met this decision before. Twitter's home timeline (<a href="#/ch1/learn/describing-load">Chapter 1</a>) moved from assembling timelines on read to fan-out on write, then to a hybrid for accounts with huge follower counts: reads vastly outnumbered writes, except for a few writers whose fan-out was too expensive.</p>
<p>Moving work to the write path costs more than CPU: anything precomputed is only <strong>as fresh as the pipeline that updates it</strong>. If the pipeline lags, readers get yesterday's answer very quickly, a question the section on <a href="#/ch12/learn/timeliness-and-integrity">timeliness and integrity</a> takes up.</p>`,
        },
        {
          type: "diagram",
          title: "Extending the write path to the user's screen",
          svg: `<style>.dd-diagram-body svg.c12d-extend-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c12d-extend-w{display:none}.dd-diagram-body svg.c12d-extend-n{display:block}}</style><svg class="c12d-extend-w" viewBox="0 0 640 192" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Device A writes to an event log, which updates derived views, which are pushed over a WebSocket or server-sent events to device B's screen. Everything up to the push is the eager write path; device B only renders. A dashed arrow shows an offline device reconnecting and resuming from offset 1,042.">
  <defs>
    <marker id="c12d-extend-w-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-line)"/></marker>
    <marker id="c12d-extend-w-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <polyline points="8,52 8,44 518,44 518,52" stroke-width="1.5" style="fill: none; stroke: var(--viz-c5)"/>
  <text x="263" y="36" font-size="12" font-weight="700" text-anchor="middle">write path (eager): work done when data changes</text>
  <polyline points="548,52 548,44 632,44 632,52" stroke-width="1.5" style="fill: none; stroke: var(--viz-c6)"/>
  <text x="590" y="22" font-size="12" font-weight="700" text-anchor="middle">read path:</text>
  <text x="590" y="36" font-size="12" text-anchor="middle">just render</text>
  <rect x="8" y="70" width="96" height="50" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="56" y="91" font-size="13" font-weight="700" text-anchor="middle">Device A</text>
  <text x="56" y="109" font-size="12" text-anchor="middle">writes</text>
  <rect x="136" y="70" width="104" height="50" rx="8" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="188" y="91" font-size="13" font-weight="700" text-anchor="middle">Event log</text>
  <text x="188" y="109" font-size="12" text-anchor="middle">ordered</text>
  <rect x="272" y="70" width="110" height="50" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="327" y="91" font-size="13" font-weight="700" text-anchor="middle">Derived views</text>
  <text x="327" y="109" font-size="12" text-anchor="middle">indexes, caches</text>
  <rect x="410" y="70" width="108" height="50" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="464" y="91" font-size="13" font-weight="700" text-anchor="middle">Push</text>
  <text x="464" y="109" font-size="12" text-anchor="middle">WebSocket / SSE</text>
  <rect x="548" y="70" width="84" height="50" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="590" y="91" font-size="13" font-weight="700" text-anchor="middle">Device B</text>
  <text x="590" y="109" font-size="12" text-anchor="middle">screen</text>
  <line x1="104" y1="95" x2="134" y2="95" stroke-width="1.5" marker-end="url(#c12d-extend-w-a)" style="stroke: var(--viz-line)"/>
  <line x1="240" y1="95" x2="270" y2="95" stroke-width="1.5" marker-end="url(#c12d-extend-w-a)" style="stroke: var(--viz-line)"/>
  <line x1="382" y1="95" x2="408" y2="95" stroke-width="1.5" marker-end="url(#c12d-extend-w-a)" style="stroke: var(--viz-line)"/>
  <line x1="518" y1="95" x2="546" y2="95" stroke-width="1.5" marker-end="url(#c12d-extend-w-a)" style="stroke: var(--viz-line)"/>
  <path d="M 590 122 C 590 166, 188 166, 188 124" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c12d-extend-w-m)" style="fill: none; stroke: var(--viz-muted)"/>
  <text x="389" y="184" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">offline? reconnect and resume from offset 1,042</text>
</svg><svg class="c12d-extend-n" viewBox="0 0 360 414" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Device A writes to an event log, which updates derived views, which are pushed to device B's screen. Everything up to the push is the write path; device B only renders. A dashed arrow shows an offline device resuming from offset 1,042.">
  <defs>
    <marker id="c12d-extend-n-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-line)"/></marker>
    <marker id="c12d-extend-n-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <text x="12" y="20" font-size="12" font-weight="700">write path (eager)</text>
  <polyline points="58,30 50,30 50,284 58,284" stroke-width="1.5" style="fill: none; stroke: var(--viz-c5)"/>
  <text x="12" y="306" font-size="12" font-weight="700">read path: just render</text>
  <polyline points="58,318 50,318 50,362 58,362" stroke-width="1.5" style="fill: none; stroke: var(--viz-c6)"/>
  <rect x="70" y="30" width="220" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="180" y="57" font-size="13" text-anchor="middle">Device A writes</text>
  <rect x="70" y="100" width="220" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="180" y="127" font-size="13" text-anchor="middle">Event log</text>
  <rect x="70" y="170" width="220" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="180" y="197" font-size="13" text-anchor="middle">Derived views</text>
  <rect x="70" y="240" width="220" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="180" y="267" font-size="13" text-anchor="middle">Push: WebSocket / SSE</text>
  <rect x="70" y="318" width="220" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="180" y="345" font-size="13" text-anchor="middle">Device B screen</text>
  <line x1="180" y1="74" x2="180" y2="98" stroke-width="1.5" marker-end="url(#c12d-extend-n-a)" style="stroke: var(--viz-line)"/>
  <line x1="180" y1="144" x2="180" y2="168" stroke-width="1.5" marker-end="url(#c12d-extend-n-a)" style="stroke: var(--viz-line)"/>
  <line x1="180" y1="214" x2="180" y2="238" stroke-width="1.5" marker-end="url(#c12d-extend-n-a)" style="stroke: var(--viz-line)"/>
  <line x1="180" y1="284" x2="180" y2="316" stroke-width="1.5" marker-end="url(#c12d-extend-n-a)" style="stroke: var(--viz-line)"/>
  <polyline points="290,340 334,340 334,122 293,122" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c12d-extend-n-m)" style="fill: none; stroke: var(--viz-muted)"/>
  <text x="180" y="390" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">dashed: offline? reconnect and</text>
  <text x="180" y="406" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">resume from offset 1,042</text>
</svg>`,
          caption: `When changes are pushed to clients, the write path runs all the way to the screen and the read path shrinks to rendering. A device that went offline is just a consumer that fell behind: it resumes from the last offset it saw instead of reloading everything.`,
        },
        {
          type: "text",
          html: `<h3>The client is a derived view too</h3>
<p>The boundary doesn't stop at the server. Single-page and mobile apps increasingly keep a local database, render from it and work offline, syncing when the network returns. The device's state is then a <strong>cache of state on the server</strong>, and the pixels on screen are a materialized view of the client's model. Offline writes raise Chapter 5's multi-leader conflict questions, because the device accepts writes the server hasn't seen.</p>
<p>Classic HTTP treats the browser's copy as a snapshot that never changes until the next request, which is why the customer saw a stale price. <strong>Server-sent events</strong> (the EventSource API) and <strong>WebSockets</strong> let the server push messages to an open page. With them, the write path extends to the user's screen, and the read path shrinks to rendering.</p>
<p>A device that drops offline is then just a consumer that fell behind. On reconnect it asks for everything after the last offset it saw, like a log consumer resuming from its committed offset (Chapter 11), instead of reloading the page.</p>
<h3>End-to-end event streams</h3>
<p>Client-side developers already work this way inside the app: Elm, and React with Flux or Redux, derive UI state from a stream of events or actions, much like an event-sourced store. The book proposes stretching that model across the server, so state changes flow through one pipeline from the device where a write happens, through logs and derived views, to every device displaying the affected data.</p>
<p>The obstacle is habit more than technology. Request/response is built into databases, libraries, frameworks and protocols, and few datastores support "subscribe to this query's result" as a first-class operation. Moving to publish/subscribe means rethinking those layers, not just adding a WebSocket.</p>`,
        },
        {
          type: "text",
          html: `<h3>Reads are events too</h3>
<p>So far, writes travel through the log and reads are transient requests to a derived store. You can also send reads through the stream processor: each query becomes an event, and the processor emits the answer on an output stream, in effect a stream-table join between queries and stored state (Chapter 11).</p>
<p>Why bother? A logged read records <strong>what a user saw when they made a decision</strong>, which is exactly the causal dependency the unfriend race needed: if Ana's read of her friend list (version 8) is an event, her post can refer to it and consumers can wait for it. Logged reads also support analysis of what users looked at. The price is storage and I/O for every read, so it is a deliberate trade-off, not a default.</p>
<p>Routing a single-partition read through a stream processor gains nothing, but for queries that gather data from many partitions its routing and joining machinery helps. The book's examples: Storm's distributed RPC computing the <em>reach</em> of a URL on Twitter (the union of the followers of everyone who tweeted it), and fraud scoring that combines the reputations of a purchase's IP address, email, billing and shipping addresses, each in its own partition. MPP databases fan out like this internally; a stream processor can do it across systems.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Elasticsearch / Lucene",
              tag: "near real-time",
              html: `Newly indexed documents become searchable after a <em>refresh</em>, which happens about once a second by default (since 7.0, shards that haven't received a search for 30 seconds skip scheduled refreshes until the next search arrives). The refresh interval is an explicit, tunable point where the write path meets the read path, and the reason Elasticsearch calls itself near real-time.`,
            },
            {
              org: "Apache Storm DRPC",
              tag: "reads as events",
              html: `Storm's documentation used the reach of a URL (how many distinct people on Twitter were exposed to it) as its canonical distributed RPC example: the query fans out to find who tweeted the URL and their followers across partitions, deduplicates and counts, all inside a stream topology.`,
            },
            {
              org: "Firebase / Cloud Firestore",
              tag: "push to clients",
              html: `Firestore clients attach snapshot listeners that receive pushed updates whenever a query's results change, and the SDKs can keep an offline cache (on by default on Android and Apple platforms, opt-in on the web) so the app keeps working and syncs on reconnect: the device holds a cache of server state, and the write path reaches the screen.`,
            },
            {
              org: "Ink & Switch",
              year: "2019",
              tag: "local-first",
              html: `Kleppmann co-authored the 2019 essay "Local-first software: You own your data, in spite of the cloud," which argues for apps whose primary copy of the data lives on the device and syncs with others through CRDTs: a direct continuation of the offline-capable clients described here.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>The "end-to-end event stream" has moved from proposal toward practice. CRDT libraries such as Automerge and Yjs power collaborative editors that sync changes between devices and servers, and a new category of sync engines replicates a subset of a server-side database into the client and keeps it updated live. GraphQL subscriptions give API clients a standard way to ask for pushed changes. The book's barrier still stands, though: most of the data stack is built around request/response, and push requires every layer to cooperate.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: a live orders-per-minute dashboard for 10,000 viewers",
          html: `<p>A strong answer puts the aggregation on the write path: a stream processor consumes order events and maintains per-minute counts by event time, so a viewer never triggers a scan. Changes are pushed over WebSockets or SSE through a pub/sub fan-out tier, with sequence numbers so a reconnecting client resumes from the last one it saw, and falls back to a fresh snapshot if the gap is too large. It coalesces updates (send the latest state once a second, not every event), handles slow clients with backpressure or dropping intermediate states, and shows viewers how fresh the data is. The point to name explicitly: you moved the boundary toward writes because reads (10,000 viewers) vastly outnumber the computation's inputs per second, and you paid for it with a pipeline whose lag you must monitor.</p>`,
        },
        {
          type: "quiz",
          q: "A product page is read 50,000 times per second and its data changes a few times per hour. Where should the write/read boundary sit, and what is the main risk?",
          options: [
            "Far toward the read path: compute the page on every request so it is always fresh",
            "Far toward the write path: precompute (materialize or cache) the rendered data when it changes; the risk is serving a stale copy if the update pipeline lags or fails",
            "It doesn't matter: total work is the same either way",
            "Toward the write path, and there is no risk because precomputed data is always consistent",
          ],
          answer: 1,
          explain: "With such a lopsided read/write ratio, doing the work once per change instead of once per read saves several orders of magnitude, which is exactly why caches and materialized views exist. Total work is very different, not the same. The tempting option D gets the boundary right but ignores the price: precomputed data is only as fresh as the pipeline maintaining it. Computing on every read is always fresh but wastes the same work 50,000 times a second.",
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "end-to-end-argument",
      title: "Exactly once, end to end: only the endpoints can deduplicate",
      kicker: "Correctness",
      concepts: ["end-to-end-argument", "idempotence-via-operation-ids", "duplicate-suppression"],
      blocks: [
        {
          type: "problem",
          html: `<p>Alice pays Bob $11. Her browser sends the request, the server runs a perfectly ACID transaction, the COMMIT succeeds, and then the connection drops before the "OK" gets back. The server's retry logic (or Alice, staring at a spinner) tries again, and a second, equally ACID transaction moves another $11. Nothing was broken: TCP delivered every byte once within its connection, the database made each transaction atomic, and the message broker offered exactly-once processing. Money still moved twice.</p>
<p>Each layer suppresses duplicates only inside its own scope, and the retry came from outside that scope. Teams often believe that "we use transactions" or "we enabled exactly-once in Kafka" makes the whole operation exactly-once. It doesn't.</p>`,
        },
        {
          type: "text",
          html: `<p>When something fails partway through an operation, you have two choices: give up, and possibly lose the operation, or retry, and possibly do it twice. Retrying is usually right, but if the operation is not idempotent, doing it twice is not a harmless glitch. A counter incremented twice reports the wrong number forever; a card charged twice is a customer's real money. Processing something twice is a form of <strong>data corruption</strong>.</p>
<p>So "exactly-once" never means the code ran exactly once; machines crash halfway and messages get resent. It means arranging the computation so that the <strong>final effect is the same as if no fault had occurred</strong>, however many times parts of it were retried. Chapter 11 called this effectively-once. The question for this section is where that arrangement has to live.</p>
<h3>Every layer deduplicates, within its own scope</h3>
<ul>
<li><strong>TCP</strong> numbers every byte it sends, so the receiver can put segments in order and discard retransmitted copies. That only works within one connection. If a request times out and the client opens a new connection and resends, TCP has no idea the bytes repeat an earlier request. Even on the same keep-alive connection, a resubmitted HTTP request is new data as far as TCP is concerned.</li>
<li><strong>Database transactions</strong> are atomic per attempt. Write the $11 transfer as two UPDATEs in one transaction. If the client sends COMMIT, the database commits, and the connection drops before the acknowledgment arrives, the client can't tell whether the transfer happened. If it retries, the database sees a brand-new, perfectly valid transaction and moves another $11.</li>
<li><strong>Two-phase commit</strong> makes a coordinator and its participants agree on one outcome, but it says nothing about the end user's device. A browser that resubmits a POST, the "Confirm Form Resubmission" dialog after a reload, or a user who double-clicks Pay all produce requests that 2PC treats as new.</li>
</ul>
<p>In each case the duplicate was created outside the layer's scope, so the layer had no way to recognize it. The fix is to give the operation an identity that outlives every connection and every attempt.</p>`,
        },
        {
          type: "code",
          lang: "sql",
          title: "Not safe to retry",
          code: `BEGIN;
UPDATE accounts SET balance = balance - 11 WHERE owner = 'alice';
UPDATE accounts SET balance = balance + 11 WHERE owner = 'bob';
COMMIT;
-- If the reply to COMMIT is lost and the client retries,
-- this runs again as a new, valid transaction: $22 moved.`,
        },
        {
          type: "code",
          lang: "sql",
          title: "Safe to retry: the request ID is checked in the same transaction",
          code: `-- Once: the database itself must reject a repeated request ID.
CREATE TABLE requests (
  request_id uuid PRIMARY KEY,    -- minted by the client, once per user intent
  payer      text NOT NULL,
  payee      text NOT NULL,
  amount     numeric NOT NULL
);

BEGIN;
INSERT INTO requests (request_id, payer, payee, amount)
  VALUES ('7f3c2a9e-41b0-4d5e-9a61-0c8e2f5b13d4', 'alice', 'bob', 11);
  -- a retry fails right here with a duplicate-key error and aborts
UPDATE accounts SET balance = balance - 11 WHERE owner = 'alice';
UPDATE accounts SET balance = balance + 11 WHERE owner = 'bob';
COMMIT;`,
          caption: "The same idea as the book's operation-ID example, with names changed. The uniqueness check and the money movement commit or abort together.",
        },
        {
          type: "text",
          html: `<p>The second version makes a retry harmless. The client generates a <strong>request ID</strong> once per logical operation, for example a UUID placed in a hidden field when the payment form is rendered, and sends it with every attempt. The transaction's first statement records that ID in a table where it must be unique. A retry of an already-committed request fails on the duplicate key, the transaction aborts, and no money moves twice.</p>
<p>Two details make or break it. First, the uniqueness check and the effect must be in the <strong>same transaction</strong>. "SELECT to see whether the ID exists, then INSERT and UPDATE" reintroduces a race in which two concurrent attempts both see nothing and both proceed. With a UNIQUE constraint, a concurrent second INSERT of the same ID waits for the first transaction to finish, then fails if it committed (or goes ahead if it aborted), so two duplicates can never both succeed. Second, the ID must come from the <strong>true origin</strong> of the intent. If the server generated it inside its retry loop, a lost reply between browser and server would still produce two IDs for one click.</p>
<p>A side benefit: the requests table is an event log of every transfer anyone asked for (event sourcing, Chapter 11). The balance updates don't even have to happen in the same transaction; they could be derived downstream from the requests log, as long as that consumer uses the request ID to process each event exactly once too.</p>
<p>The visualization follows Alice's payment through five components, from the browser to a ledger service that writes to its own database. Each bracket marks one layer's deduplication scope, and the green one is the request ID. Pick a fault and watch where the retry begins.</p>`,
        },
        {
          type: "viz",
          id: "ch12/end-to-end-dedup",
          title: "Who catches the duplicate?",
          caption: "Try each fault with 'Per-layer only', then with 'End-to-end ID'. Notice where each retry starts: a double-click starts above TCP, a lost reply starts a new transaction, and a consumer crash replays into a database outside Kafka's bracket. Only the request ID minted in the browser spans the whole path, so it is the only protection that catches all three.",
        },
        {
          type: "text",
          html: `<h3>The end-to-end argument</h3>
<p>This pattern has a name. In 1984, Jerome Saltzer, David Reed and David Clark published "End-to-End Arguments in System Design" in <em>ACM Transactions on Computer Systems</em> (an earlier version appeared at a 1981 conference). Their argument, in our words: if getting a function right depends on knowledge that only the applications at the two ends have, the network in between cannot provide that function by itself. A partial version lower down can still pay for itself, but only as a performance optimization.</p>
<p>Their classic example is careful file transfer. A network that checksums every packet still can't guarantee that a file arrives intact. The file may already be corrupt on the sender's disk, the copying program may have a buffer bug, memory may flip a bit, the receiver's disk may fail during the write. Only an end-to-end check, comparing a checksum of the original file with a checksum of the stored copy, catches all of them. Reliability at each hop reduces how often the end-to-end check fails and the transfer has to be repeated; it can never replace the check.</p>`,
        },
        {
          type: "diagram",
          title: "Careful file transfer: where per-hop checks can't see",
          svg: `<style>.dd-diagram-body svg.c12d-e2e-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c12d-e2e-w{display:none}.dd-diagram-body svg.c12d-e2e-n{display:block}}</style><svg class="c12d-e2e-w" viewBox="0 0 640 212" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A file travels from disk A through program A, the network, and program B to disk B. Per-hop checksums cover only the network and catch bit flips on the wire. Faults on disk A, in program A, in program B's memory and on disk B are outside them; only an end-to-end check spanning disk A to disk B covers every fault site.">
  <defs>
    <marker id="c12d-e2e-w-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-line)"/></marker>
  </defs>
  <polyline points="8,52 8,44 632,44 632,52" stroke-width="2" style="fill: none; stroke: var(--viz-ok)"/>
  <text x="320" y="34" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-ok)">end-to-end check: hash of the original vs hash of the stored copy</text>
  <polyline points="258,86 258,78 382,78 382,86" stroke-width="1.5" style="fill: none; stroke: var(--viz-muted)"/>
  <text x="320" y="70" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">per-hop checksums</text>
  <rect x="8" y="96" width="92" height="48" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="54" y="116" font-size="13" font-weight="700" text-anchor="middle">Disk A</text>
  <text x="54" y="134" font-size="12" text-anchor="middle">original file</text>
  <rect x="124" y="96" width="110" height="48" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="179" y="116" font-size="13" font-weight="700" text-anchor="middle">Program A</text>
  <text x="179" y="134" font-size="12" text-anchor="middle">reads, sends</text>
  <rect x="258" y="96" width="124" height="48" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="320" y="116" font-size="13" font-weight="700" text-anchor="middle">Network</text>
  <text x="320" y="134" font-size="12" text-anchor="middle">TCP, Ethernet</text>
  <rect x="406" y="96" width="110" height="48" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="461" y="116" font-size="13" font-weight="700" text-anchor="middle">Program B</text>
  <text x="461" y="134" font-size="12" text-anchor="middle">receives, writes</text>
  <rect x="540" y="96" width="92" height="48" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="586" y="116" font-size="13" font-weight="700" text-anchor="middle">Disk B</text>
  <text x="586" y="134" font-size="12" text-anchor="middle">stored copy</text>
  <line x1="100" y1="120" x2="122" y2="120" stroke-width="1.5" marker-end="url(#c12d-e2e-w-a)" style="stroke: var(--viz-line)"/>
  <line x1="234" y1="120" x2="256" y2="120" stroke-width="1.5" marker-end="url(#c12d-e2e-w-a)" style="stroke: var(--viz-line)"/>
  <line x1="382" y1="120" x2="404" y2="120" stroke-width="1.5" marker-end="url(#c12d-e2e-w-a)" style="stroke: var(--viz-line)"/>
  <line x1="516" y1="120" x2="538" y2="120" stroke-width="1.5" marker-end="url(#c12d-e2e-w-a)" style="stroke: var(--viz-line)"/>
  <g stroke-width="2" style="stroke: var(--viz-bad)"><line x1="54" y1="146" x2="54" y2="156"/><line x1="179" y1="146" x2="179" y2="156"/><line x1="461" y1="146" x2="461" y2="156"/><line x1="586" y1="146" x2="586" y2="156"/></g>
  <line x1="320" y1="146" x2="320" y2="156" stroke-width="2" style="stroke: var(--viz-ok)"/>
  <g font-size="12" text-anchor="middle" style="fill: var(--viz-bad)"><text x="54" y="171">corrupted on disk</text><text x="179" y="171">buffer bug</text><text x="461" y="171">memory error</text><text x="586" y="171">write fails</text></g>
  <text x="320" y="171" font-size="12" text-anchor="middle" style="fill: var(--viz-ok)">wire bit flips: caught</text>
  <text x="320" y="202" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">per-hop checks see only the wire; the end-to-end check sees every fault site</text>
</svg><svg class="c12d-e2e-n" viewBox="0 0 360 416" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A file travels from disk A through program A, the network, and program B to disk B. Per-hop checksums cover only the network; faults at the other four places are seen only by an end-to-end check spanning disk A to disk B.">
  <defs>
    <marker id="c12d-e2e-n-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-line)"/></marker>
  </defs>
  <text x="12" y="22" font-size="12" font-weight="700" style="fill: var(--viz-ok)">end-to-end check: hash vs hash</text>
  <polyline points="44,36 36,36 36,360 44,360" stroke-width="2" style="fill: none; stroke: var(--viz-ok)"/>
  <rect x="56" y="36" width="200" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="156" y="63" font-size="12" text-anchor="middle">Disk A: original file</text>
  <rect x="56" y="106" width="200" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="156" y="133" font-size="12" text-anchor="middle">Program A: reads, sends</text>
  <rect x="56" y="176" width="200" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="156" y="203" font-size="12" text-anchor="middle">Network: TCP, Ethernet</text>
  <rect x="56" y="246" width="200" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="156" y="273" font-size="12" text-anchor="middle">Program B: receives, writes</text>
  <rect x="56" y="316" width="200" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="156" y="343" font-size="12" text-anchor="middle">Disk B: stored copy</text>
  <line x1="156" y1="80" x2="156" y2="104" stroke-width="1.5" marker-end="url(#c12d-e2e-n-a)" style="stroke: var(--viz-line)"/>
  <line x1="156" y1="150" x2="156" y2="174" stroke-width="1.5" marker-end="url(#c12d-e2e-n-a)" style="stroke: var(--viz-line)"/>
  <line x1="156" y1="220" x2="156" y2="244" stroke-width="1.5" marker-end="url(#c12d-e2e-n-a)" style="stroke: var(--viz-line)"/>
  <line x1="156" y1="290" x2="156" y2="314" stroke-width="1.5" marker-end="url(#c12d-e2e-n-a)" style="stroke: var(--viz-line)"/>
  <g font-size="12" style="fill: var(--viz-bad)"><text x="266" y="62">disk rot</text><text x="266" y="132">buffer bug</text><text x="266" y="272">memory error</text><text x="266" y="342">write fails</text></g>
  <text x="266" y="196" font-size="12" style="fill: var(--viz-ok)">per-hop</text>
  <text x="266" y="211" font-size="12" style="fill: var(--viz-ok)">checks</text>
  <text x="180" y="390" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">only the end-to-end check</text>
  <text x="180" y="406" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">sees every fault site</text>
</svg>`,
          caption: `Saltzer, Reed and Clark's example. Network checksums catch bits flipped on the wire, but four of the five places a file can be damaged are outside them. Deduplication has the same shape: TCP, transactions and Kafka each guard one stretch, and only an ID created where the intent starts covers the whole path.`,
        },
        {
          type: "compare",
          title: "What a lower layer gives, and what only the endpoints can give",
          items: [
            {
              title: "Integrity",
              tone: "info",
              html: `<p><strong>Lower layer:</strong> Ethernet and TCP checksums catch bits corrupted on the wire.</p><p><strong>Only the endpoints:</strong> catching corruption on disk, in memory or from a software bug at either end needs a checksum over the data itself, computed and verified end to end.</p>`,
            },
            {
              title: "Confidentiality",
              tone: "info",
              html: `<p><strong>Lower layer:</strong> WPA2 protects the Wi-Fi hop; TLS protects against attackers on the network path.</p><p><strong>Only the endpoints:</strong> end-to-end encryption protects the content even from a compromised or curious server in the middle.</p>`,
            },
            {
              title: "Duplicate suppression",
              tone: "ok",
              html: `<p><strong>Lower layer:</strong> TCP drops retransmitted segments; a transaction is atomic per attempt; Kafka deduplicates within Kafka.</p><p><strong>Only the endpoints:</strong> an operation ID minted where the intent originates and checked where the effect lands.</p>`,
            },
          ],
        },
        {
          type: "text",
          html: `<h3>Applying end-to-end thinking to data systems</h3>
<p>The lesson for data systems is uncomfortable. Using a database with strong safety properties, even serializable transactions, does not by itself make an application free of data loss or corruption. Transactions are an excellent building block, but the application's intent begins before the transaction and its effects can continue after it, so the application needs end-to-end measures of its own, such as duplicate suppression.</p>
<p>That doesn't make the lower layers pointless. TCP's deduplication means far fewer duplicates ever reach your code; transactions mean nobody ever sees half a transfer; Kafka's exactly-once keeps a stream job's state and outputs consistent with each other. They are <strong>optimizations that make the end-to-end mechanism rarely needed</strong>, not substitutes for it. The book's complaint is that every application reimplements the end-to-end part, because nobody has yet found the right abstraction for it. Fault-tolerance mechanisms are hard to get right, and each team rediscovers the same edge cases.</p>`,
        },
        {
          type: "keypoints",
          title: "Designing an idempotent endpoint",
          items: [
            `<strong>Mint the ID at the origin, once per intent</strong> (when the form is rendered or the user taps Pay), and reuse it on every retry. A hash of the request fields can serve as an ID, but it wrongly merges two genuinely separate identical operations, such as paying Bob $11 twice on purpose; use it only where that can't happen.`,
            `<strong>Store the response with the key</strong>, so a retry gets the original result rather than an error or a second execution.`,
            `<strong>Scope keys per client or account, and keep them for a defined window</strong> long enough to cover every retry path, then expire them.`,
            `<strong>Reject a reused key with a different payload</strong>: that is a client bug, not a retry.`,
            `<strong>Pass the ID downstream</strong> to the payment processor, the email provider and every consumer, so each can deduplicate its own side effects.`,
            `<strong>"Idempotent" is a property you design in.</strong> <code>PUT balance = 89</code> or <code>DELETE payment 7</code> are naturally idempotent; "subtract $11" is not until it carries an ID that makes a repeat recognizable.`,
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Stripe",
              tag: "Idempotency-Key",
              html: `Stripe's API accepts an <code>Idempotency-Key</code> header on POST requests. It saves the status code and body of the first request made with a key and returns the same result for any retry with that key; keys may be removed once they are at least 24 hours old.`,
            },
            {
              org: "Amazon EC2 / AWS",
              tag: "ClientToken",
              html: `EC2's RunInstances accepts a <code>ClientToken</code> so that a retried launch request doesn't start a second set of instances. The Amazon Builders' Library article "Making retries safe with idempotent APIs" describes this caller-provided request-identifier pattern.`,
            },
            {
              org: "Apache Kafka",
              year: "2017",
              tag: "scope of exactly-once",
              html: `Kafka 0.11 (KIP-98) added the idempotent producer and transactions, giving exactly-once semantics for read-process-write pipelines whose inputs and outputs are Kafka topics. Side effects in external systems, such as a database write or an email, are outside that scope and still need idempotence at the sink.`,
            },
            {
              org: "Amazon SQS FIFO",
              tag: "bounded dedup window",
              html: `SQS FIFO queues drop a message whose <code>MessageDeduplicationId</code> matches one sent within the previous 5 minutes: real duplicate suppression, with an explicitly limited time scope. A retry that arrives after the window is a new message.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "mistake",
          title: "\"We enabled exactly-once in Kafka, so emails won't be sent twice\"",
          html: `<p>Kafka's exactly-once covers reading from Kafka, updating state and writing back to Kafka as one atomic step. A consumer that calls an email API sits outside that transaction. If it crashes after the API call but before its offsets and outputs commit, the event is processed again on restart and the email goes out again. The fix is end to end: in one local transaction, record the event's ID in a processed-IDs table and queue the email in an outbox table. A relay then sends from the outbox and passes the ID to the email provider as an idempotency key, so even a retried send is harmless if the provider deduplicates on it.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: a money-transfer API that is safe to retry",
          html: `<p>A strong answer has the client generate an idempotency key per user intent; the server, in one database transaction, inserts the key into a table with a unique constraint, applies the transfer, and stores the response; a retry hits the duplicate key and returns the stored response. It covers the details interviewers probe: concurrent retries (the unique constraint makes the second wait and then fail, unlike check-then-insert), a reused key with a different body (reject it), key retention (a window longer than any client retry), and downstream effects (pass the key to the card processor; consumers keep processed-ID tables). Then the principle: TCP, transactions, 2PC and broker-level exactly-once each cover only their own scope, so the guarantee has to be built end to end.</p>`,
        },
        {
          type: "quiz",
          q: "A team enables Kafka transactions (exactly-once) for a consumer that reads 'OrderPlaced' events and sends a confirmation email via an external email API. Under which condition can customers still get two emails?",
          options: [
            "Never: exactly-once guarantees the email is sent once",
            "Only if the Kafka broker loses data",
            "If the consumer crashes after the email API call but before its offset/transaction commits; the event is processed again and the external call repeats unless the email request carries an idempotency key the email service deduplicates",
            "Only if two consumers in the same group read the same partition at once",
          ],
          answer: 2,
          explain: "Kafka's exactly-once makes reading, state updates and writes within Kafka atomic. The email call is outside that transaction, so a crash between the call and the commit means the event is reprocessed and the call repeated. The tempting answer, 'never', confuses the scope of the guarantee with the whole operation. Broker data loss is a different failure and isn't needed for a duplicate to appear, and a healthy consumer group assigns each partition to one consumer at a time. The fix is end to end: record the event ID with an outbox entry in one local transaction, and pass it to the email service as an idempotency key.",
        },
      ],
    },
  ],
});
