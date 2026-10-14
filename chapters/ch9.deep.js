// Chapter 9 deep dive, part 1 (hook + linearizability through Lamport timestamps).
// Part 2 lives in ch9.deep2.js. Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch9", {
  hook: `<p>Return one last time to GitHub's 43 seconds on 21 October 2018. <a href="#/ch5/learn/node-outages">Chapter 5</a> followed what happened to the data and <a href="#/ch8/learn/unreliable-networks">Chapter 8</a> what each server could know; the part left for this chapter is the agreement itself. GitHub's Raft-based failover tool, Orchestrator, did exactly what it was designed to do: the nodes that could still talk to each other agreed that the East Coast database primaries were unreachable and promoted replicas on the West Coast. Consensus worked, but only on the question it was asked, which was who should lead. The databases underneath replicated asynchronously, so nothing had ever agreed on the order of their writes. The East Coast primaries had accepted a brief window of writes that never reached the West, and the West then accepted writes the East had never seen: two histories of the same database, with no automatic rule for which order was the true one. GitHub chose data integrity over a fast recovery and ran degraded for <strong>24 hours and 11 minutes</strong> while it reconciled them.</p>
<p>Every question in that outage is this chapter's subject. Who is the leader? Has a write really happened? In what order did things happen? Can a group of machines agree on anything at all while messages are lost and nodes pause? The answers come as three tools: <strong>linearizability</strong> (make many copies behave like one), <strong>ordering</strong> (causality, Lamport clocks and total order broadcast) and <strong>consensus</strong> (the limits of two-phase commit, how Raft and Paxos work, and the ZooKeeper and etcd services that package them).</p>`,
  sections: [
    // ------------------------------------------------------------------
    {
      id: "linearizability",
      title: "Linearizability: making many copies behave like one",
      kicker: "Definition",
      concepts: ["linearizability", "serializability-vs-linearizability", "eventual-consistency"],
      blocks: [
        {
          type: "problem",
          html: `<p>You delete an embarrassing photo and the app says <em>Deleted</em>. You text a friend "it's gone"; they refresh, and the photo is still there. Nothing crashed. Their request simply landed on a replica that hadn't applied your delete yet, and the database had only ever promised <strong>eventual consistency</strong>.</p>
<p>Application code is written as if each value lived in one variable in one place, so bugs like this surface only under replication lag, failover or heavy concurrency: exactly when they are hardest to reproduce. The obvious fixes sound stronger than they are. "Always read from the leader" fails when a deposed leader keeps answering. "Use a quorum with w + r &gt; n" can still show a later reader an older value than an earlier reader already saw. Before we can say which designs really behave like a single copy, and what that costs, we need a precise definition of "behaves like a single copy".</p>`,
        },
        {
          type: "text",
          html: `<p>Eventual consistency (<a href="#/ch5/learn/replication-lag">Chapter 5</a>) is really a promise about <strong>convergence</strong>: if writes stop and you wait long enough, every replica ends up with the same value. It says nothing about how long that takes or what reads return in the meantime, including values older than one someone else has already seen. Stronger models make the contract easier to program against, and pay for it with latency, and with availability when the network misbehaves. This chapter climbs that ladder and prices each rung.</p>
<p>One clarification first. Chapter 7's <strong>isolation levels</strong> are about races between concurrent transactions; this chapter's <strong>consistency models</strong> describe what clients may observe while copies of the data drift apart through replication delay and failures. They overlap, but they are mostly independent axes: a store can be linearizable for single keys with no transactions at all, and a database can run serializable transactions without being linearizable.</p>`,
        },
        {
          type: "idea",
          html: `<p><strong>Linearizability</strong> is a recency guarantee. Every operation appears to take effect atomically at a single instant somewhere between the moment its request was sent and the moment its response arrived. The consequence you can observe: once any read has returned a new value, no read that starts later, on any replica and for any client, may return an older one.</p>`,
        },
        {
          type: "text",
          html: `<h3>Registers, intervals and linearization points</h3>
<p>Linearizability also goes by <strong>atomic</strong>, <strong>strong</strong> or <strong>immediate consistency</strong>, and Spanner's <strong>external consistency</strong> extends it to transactions. To define it, model the data as a <strong>register</strong>: one named value, such as a key or a row. Clients perform three kinds of operation on a register x:</p>
<ul>
<li><code>read(x) ⇒ v</code>: returns the current value v.</li>
<li><code>write(x, v) ⇒ ok</code>: sets x to v.</li>
<li><code>cas(x, old, new) ⇒ ok | error</code>: compare-and-set. Sets x to <em>new</em> only if it currently equals <em>old</em>; otherwise it fails and changes nothing.</li>
</ul>
<p>To a client every operation is an <strong>interval</strong>, from sending the request to receiving the response. Somewhere inside it the operation took effect, but the network hides exactly when: 2 ms after the request left, or 2 ms before the reply came back?</p>
<p>A history (a log of operations with their start and end times) is <strong>linearizable</strong> if you can place one point inside each operation's interval, its <strong>linearization point</strong>, such that:</p>
<ol>
<li>the points form one sequence that <strong>respects real time</strong>: if operation A ended before operation B began, A's point comes first; and</li>
<li>replaying the operations in that sequence against one ordinary variable produces the same results: every read returns the value of the most recent write before its point, and every cas succeeds or fails exactly as it did.</li>
</ol>
<p>Operations that overlap in time may land in either order; that freedom is what gives real systems room to replicate. Once the points are placed, though, time only moves forward.</p>`,
        },
        {
          type: "diagram",
          title: "Linearization points",
          svg: `<svg viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three clients' operations as bars on a time axis, with one linearization point per operation joined left to right">
  <text x="12" y="34" font-size="13">register x</text>
  <text x="12" y="78" font-size="13">Client A</text>
  <text x="12" y="123" font-size="13">Client B</text>
  <text x="12" y="168" font-size="13">Client C</text>
  <rect x="100" y="20" width="280.5" height="20" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="240" y="34" font-size="12" text-anchor="middle">x = 0</text>
  <rect x="380.5" y="20" width="229.5" height="20" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <text x="495" y="34" font-size="12" text-anchor="middle">x = 1</text>
  <line x1="380.5" y1="40" x2="380.5" y2="74" stroke-dasharray="3 3" style="stroke: var(--viz-ok)"/>
  <rect x="185" y="67" width="340" height="14" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="300" y="62" font-size="12" text-anchor="middle" class="viz-halo">write(x, 1)</text>
  <rect x="270" y="112" width="85" height="14" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="300" y="107" font-size="12" text-anchor="middle" class="viz-halo">read → 0</text>
  <rect x="440" y="112" width="51" height="14" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="468" y="107" font-size="12" text-anchor="middle" class="viz-halo">read → 1</text>
  <rect x="397.5" y="157" width="59.5" height="14" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="463" y="168" font-size="12" class="viz-halo">read → 1</text>
  <polyline points="312.5,119 380.5,74 423,164 465.5,119" stroke-width="2" style="fill: none; stroke: var(--viz-c1)"/>
  <circle cx="312.5" cy="119" r="5" style="fill: var(--viz-c1); stroke: var(--viz-bg)"/>
  <circle cx="380.5" cy="74" r="5" style="fill: var(--viz-c1); stroke: var(--viz-bg)"/>
  <circle cx="423" cy="164" r="5" style="fill: var(--viz-c1); stroke: var(--viz-bg)"/>
  <circle cx="465.5" cy="119" r="5" style="fill: var(--viz-c1); stroke: var(--viz-bg)"/>
  <line x1="100" y1="188" x2="610" y2="188" style="stroke: var(--viz-muted)"/>
  <g font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">
    <text x="100" y="205">0</text><text x="185" y="205">1</text><text x="270" y="205">2</text><text x="355" y="205">3</text><text x="440" y="205">4</text><text x="525" y="205">5</text><text x="610" y="205">6</text>
  </g>
  <text x="12" y="205" font-size="12" style="fill: var(--viz-muted)">time (s)</text>
</svg>`,
          caption: `Violet dots are linearization points, one inside each operation's interval. Joined in order they only move forward in time, and each read returns the latest write before its dot: B's first read sits before the write's dot, C's read and B's second read after it. A history is linearizable if dots like these can be placed at all.`,
        },
        {
          type: "text",
          html: `<p>Definitions stick once you've broken them. Below, a <strong>Writer</strong> increments x, two readers, <strong>Alice</strong> and <strong>Bob</strong>, read it, and three replicas apply writes at different speeds (the dots on their lanes). Each operation is a bar spanning its interval. A checker tests every completed read against the rules above and draws a red connector for each violation. You choose where reads go.</p>`,
        },
        {
          type: "viz",
          id: "ch9/linearizability-checker",
          title: "Is this history linearizable?",
          caption: `Try the opening scene first: in Followers mode with 2.5 s of lag, Bob's read starts after Alice's has finished, yet returns the older value. Drag the lag to 1.7 s or less and the violation disappears, but only because F2 happened to catch up in time. Then switch to Leader (always linearizable) and to Quorum. Notice that w + r &gt; n still lets Bob go back in time, until you turn on Sync read repair and Alice's read pays an extra round trip.`,
        },
        {
          type: "text",
          html: `<h3>The no-going-back rule</h3>
<p>Look at which reads the checker accepts. A read that overlaps an in-flight write may return the old or the new value, since the write's linearization point could fall on either side of it. A register that promises only that much is a <strong>regular register</strong>, and it allows a flicker: a reader sees the new value, then the old one again while the write is still propagating.</p>
<p>Linearizability forbids the flicker. The moment <em>any</em> read returns the new value, the write's linearization point is pinned before that read, so every operation that starts afterwards must see the new value too, even if the writer hasn't been acknowledged yet. Bob broke exactly this rule in Followers mode.</p>
<p>The same violation happens off-screen. Alice and Bob are on a sofa, refreshing a live-score page during a cup final. Alice's page shows the final whistle and she calls out the result. Bob refreshes <em>after</em> hearing her, hits a lagging replica, and sees the match still in progress. Each page view looks plausible alone; the anomaly shows only because the news travelled through a <strong>side channel</strong>, Alice's voice, faster than replication. The next section shows software side channels doing the same.</p>
<h3>Why compare-and-set matters</h3>
<p>"Read the seat; if it's free, write my name" is two operations, and on even a perfectly linearizable store another client can slip between them: both see the seat free, and one booking silently overwrites the other (Chapter 7's lost update). <code>cas(seat, empty, me)</code> checks and writes in one atomic step, so exactly one of two concurrent attempts succeeds. Locks, leader election and uniqueness constraints are all built on cas or something equally powerful.</p>
<h3>Checking a history, and where linearizability sits</h3>
<p>You can check a recorded history mechanically by searching for a valid placement of linearization points. The checker above is exact only because it has one writer with increasing values; in general the search is expensive, and Jepsen's <strong>Knossos</strong> checker does it for histories of modest size.</p>
<p>Chapter 5's read-after-write, monotonic reads and consistent prefix reads are weaker per-session promises; a linearizable system provides all of them. Roughly from strongest to weakest, this chapter's models run: strict serializability, linearizability, sequential, causal, eventual. Linearizability is the rung that adds <strong>real-time order</strong>; the causality section maps the whole ladder.</p>`,
        },
        {
          type: "compare",
          title: "Serializability, linearizability, strict serializability",
          items: [
            {
              title: "Serializability",
              tone: "info",
              html: `An <strong>isolation</strong> property of <em>transactions</em> that may touch many objects. The outcome equals <em>some</em> serial order of the transactions, and that order need not match real time. Provided by two-phase locking, actual serial execution and serializable snapshot isolation (Chapter 7).`,
            },
            {
              title: "Linearizability",
              tone: "info",
              html: `A <strong>recency</strong> guarantee on <em>individual objects</em>. Each read, write or cas appears to happen at one instant within its interval, in real-time order. It knows nothing about transactions, so on its own it doesn't prevent write skew across two objects.`,
            },
            {
              title: "Strict serializability",
              tone: "ok",
              html: `Both at once: serializable transactions whose serial order respects real time. Also called strong one-copy serializability (strong-1SR); Spanner calls it external consistency. 2PL and actual serial execution typically get there. SSI deliberately does not: it reads from a snapshot taken when the transaction began, so a read can miss a write that has already committed.`,
            },
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Amazon S3",
              year: "2020",
              tag: "eventual → strong",
              html: `In December 2020 S3 began providing strong read-after-write consistency for all GET, PUT and LIST operations, automatically and at no extra cost. Before that, overwrites, deletes and listings were only eventually consistent, and tools such as EMRFS consistent view and Hadoop's S3Guard existed to paper over the gap.`,
            },
            {
              org: "etcd",
              tag: "per-request choice",
              html: `Range (read) requests are linearizable by default. A client can opt into "serializable" reads, which any member answers from its local state: faster, but possibly stale. (That is etcd's own name for a local read; it has nothing to do with serializable isolation.) Same store, two consistency levels, chosen per request.`,
            },
            {
              org: "Jepsen (Kyle Kingsbury)",
              tag: "testing",
              html: `Records the start time, end time and result of real client operations against a database while injecting partitions, crashes and clock skew, then checks the history with a linearizability checker (Knossos; later Elle for transactional histories). Its public analyses have repeatedly found stale or lost data in systems advertised as strongly consistent.`,
            },
            {
              org: "Google Spanner",
              tag: "strict serializability",
              html: `Provides what Google calls external consistency, i.e. strict serializability: transactions are serializable and their order respects real time. It is implemented with TrueTime and commit wait (Chapter 8).`,
            },
          ],
        },
        {
          type: "callout",
          tone: "mistake",
          title: "\"Strong consistency\" is not a precise term",
          html: `<p>Vendors use <em>strong consistency</em> for anything from linearizability to read-your-writes within one session, so ask which guarantee is meant, for which operations, under which failures. The <strong>C in ACID</strong> is unrelated: there it means the application's invariants hold (Chapter 7), a property of the application, not of replication. And linearizability is not "serializability for distributed systems": one is about single objects in real time, the other about multi-object transactions in some order.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Expect "What's the difference between linearizability and serializability?" and "Is a quorum system with w + r &gt; n strongly consistent?" A strong answer defines linearizability by its observable consequence (once any read sees a write, every later read does), names its unit (a single object) and contrasts it with serializability (transactions, some serial order). Then it adds real time: strict serializability is both, Spanner provides it, and SSI is serializable but not linearizable. On quorums, say no, sketch the race (a fast replica in one read quorum, only lagging replicas in the next) and mention synchronous read repair as the fix.</p>`,
        },
        {
          type: "quiz",
          q: "x starts at 0. A client's write x = 1 runs from t = 1 to t = 3. Read A runs from t = 1.5 to t = 2 and returns 1. Read B runs from t = 2.2 to t = 2.6, while the write is still in progress. For the history to be linearizable, what may read B return?",
          options: [
            "Either 0 or 1, because B overlaps the write",
            "Only 1",
            "Only 0, because the write hasn't completed",
            "Anything, because the write hasn't been acknowledged",
          ],
          answer: 1,
          explain: `Read A returned 1, so the write's linearization point lies before A's. A finished before B started, so A's point lies before B's, and therefore B must return 1. Option A is the tempting one: overlapping an in-flight write would, on its own, allow either value. But another read having already seen the new value removes that freedom. That is exactly the no-going-back rule that separates a linearizable register from a merely regular one.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "linearizability-in-practice",
      title: "Who needs one copy, and which replication schemes can provide it",
      kicker: "Use cases and implementations",
      concepts: ["cross-channel-timing-dependencies", "linearizable-replication-methods", "linearizability"],
      blocks: [
        {
          type: "problem",
          html: `<p>Linearizability costs latency and availability (the next section puts numbers on both), so you want to pay for it only where something actually breaks without it. Three bug classes do:</p>
<ul>
<li><strong>Split brain</strong>: a lock or leadership role that two nodes both believe they hold.</li>
<li><strong>Broken constraints</strong>: two concurrent requests that each believe they satisfied a rule, so two users get the same username, the last seat is sold twice, or an account goes negative.</li>
<li><strong>Cross-channel races</strong>: a file written to replicated storage and a message sent through a queue, where the message's consumer reads a replica that hasn't caught up.</li>
</ul>
<p>And once you know you need it, the obvious designs fail in subtle ways: a quorum with w + r &gt; n sounds as if it guarantees fresh reads, yet a later reader can still see an older value than an earlier reader did.</p>`,
        },
        {
          type: "text",
          html: `<h3>Locks and leader election</h3>
<p>A single-leader database must have exactly one leader at a time. A common way to choose it is a lock: each node tries to acquire it at startup, and whoever succeeds leads. That works only if every node agrees who holds the lock, and acquiring it is a linearizable compare-and-set ("set owner to me if it is empty"). If two nodes could each see the lock as free on different replicas, both would lead.</p>
<p>Providing this is the main job of <strong>ZooKeeper</strong> and <strong>etcd</strong>, usually through client libraries such as Apache Curator's ZooKeeper recipes. Chapter 8's warnings still apply: these locks are <strong>leases</strong> that expire, and a holder that pauses can wake up still believing it holds the lock, so the protected resource should check a <strong>fencing token</strong>.</p>
<h3>Uniqueness and other constraints</h3>
<p>A username or email address must belong to one account; two files can't share a path; a balance must not go negative; you can't sell more stock than the warehouse holds or book one seat twice. Each decision needs one up-to-date value that every node agrees on, and claiming a username is really taking a lock on that name: a cas from "unclaimed" to "mine".</p>
<p>Some constraints can be loosened: if occasional overbooking can be compensated later (apologize, refund), Chapter 12 shows how to relax them, and foreign keys don't need linearizability at all. A hard uniqueness constraint, the kind a unique index enforces, does.</p>
<h3>Cross-channel timing dependencies</h3>
<p>The live-score anomaly was noticeable only because news travelled through a second channel. Software has second channels too. A web server stores an uploaded photo in replicated file storage, then puts "resize photo 42" on a message queue for a separate resizer service.</p>`,
        },
        {
          type: "diagram",
          title: "Two channels, one race",
          svg: `<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A web server stores a photo on the storage leader and enqueues a resize job; the resizer gets the job and fetches from a follower that has not received the photo yet">
  <defs>
    <marker id="c9d-xc-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
    <marker id="c9d-xc-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-warn)"/></marker>
    <marker id="c9d-xc-b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker>
  </defs>
  <rect x="296" y="10" width="332" height="112" rx="10" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-line)"/>
  <text x="310" y="28" font-size="12" font-weight="600">File storage (replicated)</text>
  <rect x="310" y="38" width="110" height="40" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="365" y="63" font-size="13" text-anchor="middle">leader</text>
  <rect x="504" y="38" width="110" height="40" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="559" y="63" font-size="13" text-anchor="middle">follower</text>
  <line x1="420" y1="58" x2="501" y2="58" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#c9d-xc-w)" style="stroke: var(--viz-warn)"/>
  <text x="458" y="98" font-size="12" text-anchor="middle" style="fill: var(--viz-warn)">async replication,</text>
  <text x="458" y="113" font-size="12" text-anchor="middle" style="fill: var(--viz-warn)">still in flight</text>
  <rect x="16" y="92" width="134" height="48" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="83" y="121" font-size="13" font-weight="600" text-anchor="middle">Web server</text>
  <line x1="150" y1="104" x2="306" y2="63" stroke-width="1.5" marker-end="url(#c9d-xc-m)" style="stroke: var(--viz-muted)"/>
  <text x="200" y="66" font-size="12" text-anchor="middle" class="viz-halo">1. store photo 42</text>
  <rect x="250" y="172" width="150" height="46" rx="8" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
  <text x="325" y="200" font-size="13" font-weight="600" text-anchor="middle">Message queue</text>
  <line x1="140" y1="140" x2="258" y2="171" stroke-width="1.5" marker-end="url(#c9d-xc-m)" style="stroke: var(--viz-muted)"/>
  <text x="196" y="184" font-size="12" text-anchor="end" class="viz-halo">2. enqueue resize job</text>
  <rect x="486" y="172" width="134" height="46" rx="8" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <text x="553" y="200" font-size="13" font-weight="600" text-anchor="middle">Image resizer</text>
  <line x1="400" y1="195" x2="482" y2="195" stroke-width="1.5" marker-end="url(#c9d-xc-m)" style="stroke: var(--viz-muted)"/>
  <text x="441" y="187" font-size="12" text-anchor="middle">3. deliver</text>
  <line x1="586" y1="172" x2="586" y2="82" stroke-width="2" marker-end="url(#c9d-xc-b)" style="stroke: var(--viz-bad)"/>
  <text x="578" y="138" font-size="12" text-anchor="end" class="viz-halo">4. fetch photo 42</text>
  <text x="578" y="154" font-size="12" font-weight="600" text-anchor="end" class="viz-halo" style="fill: var(--viz-bad)">missing, or an old version</text>
</svg>`,
          caption: `The queue (steps 2 and 3) was faster than replication. Because step 1 completed before step 2 began, linearizable storage would guarantee that step 4 sees the photo; a lagging follower doesn't.`,
        },
        {
          type: "text",
          html: `<p>If the resizer's fetch hits a replica that lacks the photo, it fails or, worse, thumbnails an <em>older</em> version of photo 42, leaving image and thumbnail permanently inconsistent with no error raised. Linearizable storage removes the race. The alternative pushes complexity into the application: put the photo's version in the message and have the resizer retry until a replica has it, Chapter 5's read-your-writes technique stretched across services.</p>`,
        },
        {
          type: "idea",
          html: `<p>You need linearizability wherever several nodes must act on one up-to-date fact: who holds the lock, whether a name is taken, whether a file exists yet. Single-leader replication with careful reads, and consensus-based systems, can provide it; multi-leader replication and Dynamo-style quorums generally can't.</p>`,
        },
        {
          type: "text",
          html: `<h3>Which replication methods can provide it?</h3>
<p>The simplest linearizable system keeps one copy, which isn't fault tolerant. So walk through Chapter 5's replication families.</p>
<p><strong>Single-leader replication</strong> is <em>potentially</em> linearizable if reads go to the leader or to synchronously updated followers. Two caveats: the node must really still be the leader (a deposed leader that hasn't noticed keeps serving stale reads; see Chapter 8 on fencing), and with asynchronous replication a failover can lose acknowledged writes, breaking durability and linearizability at once. That is how GitHub's East Coast writes in the chapter's opening came to be missing from the newly promoted primaries.</p>
<p><strong>Consensus algorithms</strong> such as Raft and Zab resemble single-leader replication but add the safeguards it lacks against split brain and stale replicas. That is how etcd and ZooKeeper offer linearizable operations (ZooKeeper's default reads are a nuance covered in the section on ZooKeeper and etcd). <strong>Multi-leader replication</strong> is not linearizable: several nodes accept writes concurrently and replicate asynchronously, so conflicts are normal. <strong>Leaderless replication</strong> is "probably not": last-write-wins on time-of-day timestamps (as in Cassandra) can't match real order because clocks drift (Chapter 8), <a href="#/ch5/learn/quorum-limits">sloppy quorums</a> lose the overlap that quorum reasoning relies on, and even strict quorums have a race.</p>`,
        },
        {
          type: "table",
          title: "Replication schemes and linearizability",
          headers: ["Scheme", "Linearizable?", "Why"],
          rows: [
            ["Single-leader, reads from leader or synchronous followers", "Potentially", "Only if leadership is fenced and failover never loses acknowledged writes"],
            ["Consensus (Raft, Zab, Paxos-based)", "Yes", "Prevents split brain and stale authorities; supports compare-and-set"],
            ["Multi-leader", "No", "Concurrent writes on several nodes, asynchronous replication, conflicts"],
            ["Leaderless with last-write-wins clocks", "No", "Clock skew orders writes against real time"],
            ["Leaderless, strict quorum (w + r &gt; n)", "Not by itself", "Replicas receive a write at different times, so a later quorum can contain only stale replicas"],
            ["Strict quorum + synchronous read repair (ABD)", "Reads and writes only", "No compare-and-set: that needs consensus"],
          ],
        },
        {
          type: "text",
          html: `<h3>The strict-quorum race, and the fix</h3>
<p>Quorum overlap guarantees that every read quorum contains a replica that has seen every <em>completed</em> write. It says nothing about a write still in flight. Take n = 3, w = 2, r = 2: the writer sends x = 1 to all three replicas, and it reaches R1 quickly but R2 and R3 slowly. Reader A queries {R1, R2}, sees 1 on R1 and returns 1. Reader B starts after A has finished, queries {R2, R3}, finds neither has the write, and returns 0. Each read alone is allowed, since the write hadn't completed; together they send the system back in time. (w = 3, r = 2 races the same way.) Reproduce it in the Quorum mode of the previous section's visualization.</p>`,
        },
        {
          type: "diagram",
          title: "w + r &gt; n is not enough",
          svg: `<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Replica timelines: R1 gets the write early, R2 and R3 late; reader A sees the new value, reader B starts later and sees the old one">
  <text x="110" y="18" font-size="12" style="fill: var(--viz-muted)">time →</text>
  <text x="380" y="18" font-size="14" font-weight="700" text-anchor="middle" style="fill: var(--viz-bad)">w + r &gt; n, and still not linearizable</text>
  <g font-size="13">
    <text x="12" y="44">Writer</text><text x="12" y="80">R1</text><text x="12" y="110">R2</text><text x="12" y="140">R3</text><text x="12" y="176">Reader A</text><text x="12" y="210">Reader B</text>
  </g>
  <rect x="110" y="31" width="380" height="18" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <text x="300" y="44" font-size="12" text-anchor="middle">write x = 1, sent to all three at once</text>
  <rect x="110" y="67" width="30" height="18" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <rect x="140" y="67" width="480" height="18" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <text x="610" y="80" font-size="12" text-anchor="end">x = 1</text>
  <rect x="110" y="97" width="350" height="18" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="120" y="110" font-size="12">x = 0</text>
  <rect x="460" y="97" width="160" height="18" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <text x="610" y="110" font-size="12" text-anchor="end">x = 1</text>
  <rect x="110" y="127" width="450" height="18" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="120" y="140" font-size="12">x = 0</text>
  <rect x="560" y="127" width="60" height="18" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <text x="610" y="140" font-size="12" text-anchor="end">x = 1</text>
  <line x1="255" y1="163" x2="255" y2="76" stroke-width="1.5" stroke-dasharray="2 3" style="stroke: var(--viz-c6)"/>
  <circle cx="255" cy="76" r="5" style="fill: var(--viz-ok); stroke: var(--viz-bg)"/>
  <circle cx="255" cy="106" r="5" style="fill: var(--viz-panel); stroke: var(--viz-muted)"/>
  <rect x="170" y="163" width="170" height="18" rx="3" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <text x="255" y="176" font-size="12" text-anchor="middle">A reads R1, R2 → 1</text>
  <line x1="340" y1="160" x2="340" y2="222" stroke-dasharray="3 3" style="stroke: var(--viz-muted)"/>
  <line x1="445" y1="197" x2="445" y2="106" stroke-width="1.5" stroke-dasharray="2 3" style="stroke: var(--viz-c6)"/>
  <circle cx="445" cy="106" r="5" style="fill: var(--viz-bad); stroke: var(--viz-bg)"/>
  <circle cx="445" cy="136" r="5" style="fill: var(--viz-bad); stroke: var(--viz-bg)"/>
  <rect x="360" y="197" width="170" height="18" rx="3" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
  <text x="445" y="210" font-size="12" text-anchor="middle">B reads R2, R3 → 0</text>
  <text x="348" y="234" font-size="12" style="fill: var(--viz-bad)">B starts after A returned 1, yet reads 0</text>
</svg>`,
          caption: `The write is still in flight during both reads, so either read alone could legally return 0 or 1. What's forbidden is the pair: B started after A had returned 1. Quorum overlap protects only completed writes.`,
        },
        {
          type: "text",
          html: `<p>The fix is known. Readers perform <strong>read repair synchronously</strong>: if the replicas they queried disagree, they write the newest value back to a write quorum and wait for acknowledgments before returning. When there can be several writers, a writer first reads the latest version from a quorum so its write is ordered after it. This is the <strong>ABD algorithm</strong> (Attiya, Bar-Noy and Dolev, 1995), and it makes reads and writes linearizable with any majority alive, even in a fully asynchronous network.</p>
<p>Real systems rarely go all the way. Riak skips synchronous read repair for performance. Cassandra does wait for read repair on quorum reads, but concurrent writes to one key are still resolved by last-write-wins timestamps, so it isn't linearizable either.</p>
<p>The deepest limit is subtle: even ABD gives only linearizable reads and writes, <strong>not compare-and-set</strong>. Plain registers don't need consensus; cas, increment-and-get, locks and uniqueness do (the consensus section explains why these problems are equivalent). That is why the lock and username use cases above can't be served by quorums, however carefully tuned.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Kubernetes",
              tag: "leader election",
              html: `Controllers such as kube-controller-manager and kube-scheduler elect a single active instance using Lease objects (<code>coordination.k8s.io</code>) stored in etcd. The election has no fencing, so controllers must tolerate brief overlap (<a href="#/ch8/learn/fencing-tokens">Chapter 8</a>).`,
            },
            {
              org: "Apache Cassandra",
              tag: "quorum vs Paxos",
              html: `Normal QUORUM reads and writes resolve conflicts with last-write-wins timestamps and are not linearizable. For compare-and-set (<code>INSERT ... IF NOT EXISTS</code>, <code>UPDATE ... IF</code>) Cassandra runs Paxos among the replicas, its "lightweight transactions", at the cost of several extra round trips.`,
            },
            {
              org: "MongoDB",
              year: "2015–2017",
              tag: "Jepsen",
              html: `Jepsen's 2015 analysis showed MongoDB could return stale and even dirty reads. MongoDB 3.4 (2016) added a "linearizable" read concern for single-document reads, which Jepsen's later analysis of 3.4 found to work as described.`,
            },
            {
              org: "Amazon DynamoDB",
              tag: "uniqueness",
              html: `A conditional write (for example PutItem with <code>attribute_not_exists</code>) is an atomic check-and-insert within one table in one region, the usual way to enforce uniqueness. Global Tables in their original multi-Region mode reconcile concurrent writes to the same item with last-writer-wins, so a check in one region doesn't stop a conflicting write in another. AWS previewed a multi-Region strong consistency mode for Global Tables in December 2024 and made it generally available in mid-2025.`,
            },
          ],
        },
        {
          type: "tradeoffs",
          prosLabel: "What linearizable storage buys you",
          consLabel: "What it costs",
          pros: [
            "Correct locks, leader election and uniqueness constraints (given compare-and-set)",
            "No cross-channel races: if a write completed before a message was sent, the message's consumer sees it",
            "Application code can reason as if there were one copy, with no version-passing workarounds",
          ],
          cons: [
            "Every linearizable operation coordinates with the leader or a majority, adding latency, especially across regions",
            "Replicas cut off from the leader or majority must refuse requests (next section)",
            "ABD-style quorums add a round trip to reads that find disagreement, and still can't do compare-and-set",
            "Single-leader setups deliver it only with fencing and failover that never loses acknowledged writes",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Classic prompts: "design username registration across regions" or "make sure this cron job runs on exactly one machine". A strong answer spots that both need a linearizable <strong>compare-and-set</strong>, not merely fresh reads, and therefore consensus: a conditional write in a strongly consistent store, a ZooKeeper or etcd lease, or a unique index on a single leader. It mentions lease expiry and fencing tokens, and that w + r &gt; n doesn't help. If asked how to limit the cost, route every claim for a given name to one partition's leader (Chapter 12's approach) instead of coordinating globally.</p>`,
        },
        {
          type: "quiz",
          q: "A Dynamo-style store uses n = 3, w = 2, r = 2 with strict quorums and resolves conflicts by last-write-wins on client timestamps. Which statement is true?",
          options: [
            "It is linearizable, because w + r &gt; n makes every read quorum overlap every write quorum",
            "It isn't linearizable even with no failures: replicas apply a write at different times, and clock-based last-write-wins can order writes against real time",
            "It is linearizable as long as no node fails and the network doesn't partition",
            "It is linearizable for reads and writes, but it can't do compare-and-set",
          ],
          answer: 1,
          explain: `Quorum overlap only guarantees that a read quorum includes a replica that has seen every <em>completed</em> write. Replicas receive a write at different times, so a later reader can still see an older value than an earlier one even when no node fails, which rules out options A, C and D. Synchronous read repair plus writers that read first (ABD) would close that race for plain reads and writes, but this store orders writes by client clocks, which can rank concurrent writes against real time, and cas can't be built from quorum reads and writes at all.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "cost-of-linearizability",
      title: "The price of one copy: CAP and the latency floor",
      kicker: "Trade-off",
      concepts: ["cap-theorem", "linearizable-systems-their-cost"],
      blocks: [
        {
          type: "problem",
          html: `<p>You run in two datacenters, and the link between them fails while both stay connected to their own users. With a single leader in one datacenter, users attached to the other can't write, and can't even read linearizably, because they can't reach the leader. With a leader in each datacenter, both keep working, but they happily accept conflicting writes: the same seat sold twice. No clever third design keeps both promises during the cut.</p>
<p>And the bill isn't paid only during rare partitions. A linearizable write in Frankfurt that must be confirmed by a leader in Virginia pays the transatlantic round trip on every single request, on the sunniest day of the year.</p>`,
        },
        {
          type: "idea",
          html: `<p>If replicas must behave like one copy, a replica cut off from the others must stop answering or wait. And even when nothing is broken, linearizable operations can be no faster than the <strong>uncertainty of network delay</strong>, which is the real reason most systems give linearizability up.</p>`,
        },
        {
          type: "text",
          html: `<p>The visualization below is a ticket shop with four tickets, two datacenters and three replicas. In <strong>Linearizable</strong> mode there is one leader in East, and a purchase commits once two of the three replicas have it. In <strong>Always available</strong> mode each datacenter has its own leader, sells from its own copy and syncs in the background. You can cut the WAN link, change its round-trip time and turn on automatic traffic.</p>`,
        },
        {
          type: "viz",
          id: "ch9/cap-partition",
          title: "When the link breaks: consistency or availability",
          caption: `Try cutting the link in Linearizable mode, then buying and checking stock from West: both are refused while East keeps selling. Switch to Always available, repeat, then heal the link. Notice the oversold count, and that in Linearizable mode every West purchase pays the full round trip even while the link is healthy. Then, in Always available mode with the link up and one ticket left, press Both buy at once: two leaders can oversell without any partition.`,
        },
        {
          type: "text",
          html: `<h3>The trade-off, stated precisely</h3>
<p>What you just saw generalizes to any design. Promise one-copy behavior, and a replica that has lost touch with the leader (or with a majority) has no safe answer to give: it can only stall or send an error, which makes it <strong>unavailable</strong> to the clients stuck on its side. Drop that promise, and every replica can serve whoever reaches it, staying <strong>available</strong>, at the price of answers that no longer behave like a single copy.</p>
<p>Notice what the cut did <em>not</em> affect: East's users, on the side holding the leader and a majority, kept buying normally. Unavailability is per side, not global. And West could still have served <em>stale</em> reads if the application tolerated them; what it couldn't serve were linearizable ones.</p>
<p>This is the <strong>CAP theorem</strong>. Eric Brewer proposed it as a conjecture in a keynote at the PODC conference in 2000, and Seth Gilbert and Nancy Lynch formalized and proved it in 2002. Its lasting value was cultural more than technical: at a time when many distributed databases aimed for one-copy semantics on clusters with shared storage, it gave engineers permission to explore shared-nothing designs with weaker guarantees, and it became a rallying idea of the NoSQL wave.</p>`,
        },
        {
          type: "callout",
          tone: "mistake",
          title: "\"Pick two out of three\"",
          html: `<p>CAP is often summarized as "Consistency, Availability, Partition tolerance: pick any two". That framing misleads: a partition is a fault that happens to you (Chapter 8), not an option you can decline, so <strong>P isn't something you pick</strong>. A "CA" distributed system is just one whose behavior during a partition nobody has specified. The book's suggested rephrasing is "either Consistent or Available when Partitioned"; while the network works, a system can be both.</p>`,
        },
        {
          type: "text",
          html: `<h3>Why CAP is a poor design tool</h3>
<p>The theorem is narrow because its terms are defined narrowly:</p>
<ul>
<li><strong>C</strong> means linearizability, and only that. Snapshot isolation, causal consistency and read-your-writes are all outside its scope.</li>
<li><strong>A</strong> means every request received by a non-failing node must eventually get a non-error response. That is far stricter than everyday "high availability": a database that answers 99.99% of requests quickly but refuses them on the minority side of a partition is not CAP-available.</li>
<li><strong>P</strong> means a network partition, nothing else: not crashed nodes, not slow networks.</li>
</ul>
<p>So many real systems are neither CAP-consistent nor CAP-available. A single-leader database with asynchronous followers isn't linearizable, and its followers can't take writes during a partition; calling it "CP" or "AP" tells you little. More precise impossibility results have since superseded CAP, and today it is mostly of historical interest.</p>
<h3>The cost you pay every day: latency</h3>
<p>If partitions were the only cost, linearizability would be cheap, since partitions are rare. Yet few systems are actually linearizable, and the usual reason is <strong>performance</strong>, not fault tolerance.</p>
<p>Even the RAM in a multi-core computer isn't linearizable. Each core has its own caches and store buffers, so a value written by a thread on one core may not be visible yet to a thread on another; you get linearizable behavior only where the program asks for it with <strong>memory barriers</strong> (fences), as atomics and locks do. No partition is involved, since a core is never cut off from its own memory. The hardware drops linearizability by default because keeping every access coherent would make everything slower.</p>
<p>Distributed databases face the same pressure, and there's a proof they can't escape it. Hagit Attiya and Jennifer Welch showed in 1994 that for linearizable reads and writes, response time is at least proportional to the <strong>uncertainty of delays</strong> in the network. Real networks have highly variable delays (Chapter 8), so linearizable operations are inevitably slow, and no cleverer algorithm will fix that. Weaker models can answer from local state and be much faster, which is why latency-sensitive systems choose them. West's users in the visualization paid this cost on every purchase, link healthy or not.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          title: "Beyond CAP: PACELC and per-request choices",
          html: `<p>Daniel Abadi's <strong>PACELC</strong> (2012) adds the half CAP leaves out: if there is a <strong>P</strong>artition, choose <strong>A</strong>vailability or <strong>C</strong>onsistency; <strong>E</strong>lse, choose <strong>L</strong>atency or <strong>C</strong>onsistency. Modern databases increasingly let you make that choice per operation rather than per system: DynamoDB's <code>ConsistentRead</code> flag, Cassandra's per-query consistency levels, MongoDB's read and write concerns, and Azure Cosmos DB's five consistency levels.</p>`,
        },
        {
          type: "diagram",
          title: "PACELC as a decision tree",
          svg: `<svg viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision tree: partition yes or no, then need linearizability yes or no, with four outcomes">
  <defs>
    <marker id="c9d-pc-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <rect x="230" y="10" width="180" height="36" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="320" y="33" font-size="13" font-weight="700" text-anchor="middle">Network partition?</text>
  <rect x="77" y="90" width="170" height="36" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="162" y="113" font-size="13" text-anchor="middle">Need linearizability?</text>
  <rect x="400" y="90" width="170" height="36" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="485" y="113" font-size="13" text-anchor="middle">Need linearizability?</text>
  <line x1="290" y1="46" x2="170" y2="88" stroke-width="1.5" marker-end="url(#c9d-pc-m)" style="stroke: var(--viz-muted)"/>
  <line x1="350" y1="46" x2="477" y2="88" stroke-width="1.5" marker-end="url(#c9d-pc-m)" style="stroke: var(--viz-muted)"/>
  <text x="216" y="62" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">yes (CAP)</text>
  <text x="424" y="62" font-size="12" style="fill: var(--viz-muted)">no: the "else" (PACELC)</text>
  <line x1="140" y1="126" x2="92" y2="158" stroke-width="1.5" marker-end="url(#c9d-pc-m)" style="stroke: var(--viz-muted)"/>
  <line x1="184" y1="126" x2="232" y2="158" stroke-width="1.5" marker-end="url(#c9d-pc-m)" style="stroke: var(--viz-muted)"/>
  <line x1="463" y1="126" x2="415" y2="158" stroke-width="1.5" marker-end="url(#c9d-pc-m)" style="stroke: var(--viz-muted)"/>
  <line x1="507" y1="126" x2="555" y2="158" stroke-width="1.5" marker-end="url(#c9d-pc-m)" style="stroke: var(--viz-muted)"/>
  <g font-size="12" style="fill: var(--viz-muted)">
    <text x="104" y="146" text-anchor="end">yes</text><text x="221" y="146">no</text>
    <text x="427" y="146" text-anchor="end">yes</text><text x="544" y="146">no</text>
  </g>
  <rect x="12" y="160" width="145" height="48" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
  <text x="84.5" y="180" font-size="12" text-anchor="middle">Cut-off side errors</text>
  <text x="84.5" y="197" font-size="12" text-anchor="middle">or waits: unavailable</text>
  <rect x="167" y="160" width="145" height="48" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
  <text x="239.5" y="180" font-size="12" text-anchor="middle">Every side answers;</text>
  <text x="239.5" y="197" font-size="12" text-anchor="middle">copies may diverge</text>
  <rect x="335" y="160" width="145" height="48" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
  <text x="407.5" y="180" font-size="12" text-anchor="middle">Pay coordination</text>
  <text x="407.5" y="197" font-size="12" text-anchor="middle">latency on every op</text>
  <rect x="490" y="160" width="145" height="48" rx="8" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <text x="562.5" y="180" font-size="12" text-anchor="middle">Fast local answers</text>
  <text x="562.5" y="197" font-size="12" text-anchor="middle">(possibly stale)</text>
</svg>`,
          caption: `CAP covers only the left half, the rare moments when the network is partitioned. The right half is the trade-off you make on every request the rest of the time.`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Eric Brewer",
              year: "2012",
              title: "\"CAP Twelve Years Later\"",
              html: `In IEEE Computer, Brewer himself wrote that the "2 of 3" formulation is misleading: partitions are rare, and the choice between consistency and availability can be made at fine granularity (per operation, per piece of data) and only while a partition is actually happening.`,
            },
            {
              org: "Google Spanner",
              year: "2017",
              title: "\"Spanner, TrueTime and the CAP Theorem\"",
              html: `Brewer explains that Spanner is technically a CP system: it chooses consistency when a partition occurs. Because Google's private network makes partitions very rare, it is "effectively CA" in practice.`,
            },
            {
              org: "Azure Cosmos DB",
              tag: "five levels",
              html: `Offers five consistency levels, set per account and relaxable per request: strong, bounded staleness, session, consistent prefix and eventual, which turns the latency and availability versus consistency trade-off into an explicit setting.`,
            },
            {
              org: "Martin Kleppmann",
              year: "2015",
              tag: "critique",
              html: `His essay "Please stop calling databases CP or AP" and paper "A Critique of the CAP Theorem" argue that most real systems meet neither CAP definition, and propose reasoning about how sensitive each operation's latency is to network delay instead.`,
            },
          ],
        },
        {
          type: "tradeoffs",
          prosLabel: "Linearizable: what you get",
          consLabel: "Linearizable: what you pay",
          pros: [
            "Constraints hold: no double-sold seats, no duplicate usernames",
            "One answer everywhere, so no merge, refund or apology logic",
            "The side with the leader or a majority keeps working through a partition",
          ],
          cons: [
            "The minority side refuses reads and writes for the duration of a partition",
            "Every operation waits for the leader or a quorum, even when nothing is broken",
            "Cross-region deployments pay a WAN round trip per write and per linearizable read",
            "Latency tracks the network's delay variance, so tail latency suffers most",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Is your design CP or AP?" is a trap. A strong answer declines the label and describes behavior per operation: "Seat reservations go through one leader per event with a conditional write, so during a partition the minority side returns an error. Seat-map browsing reads from local replicas and may be a few seconds stale. Normally a reservation costs one round trip to the event's home region." That shows you understand both costs, unavailability during partitions and latency the rest of the time. Bring up PACELC if they want a framework, and never call a distributed system "CA".</p>`,
        },
        {
          type: "quiz",
          q: "Your service has its leader in us-east and a follower in eu-west. The transatlantic link drops, and EU users want to read their account balance. What must a linearizable system do for them?",
          options: [
            "Serve the follower's last known balance",
            "Refuse or delay the read until it can reach the leader (or a majority)",
            "Immediately promote eu-west to leader so EU users stay served",
            "Nothing special: CAP only constrains writes",
          ],
          answer: 1,
          explain: `Reads are operations too. The follower can't know whether the leader has accepted a newer write since the cut, so a local answer could be stale, which is exactly what linearizability forbids; that rules out options A and D. Promoting eu-west on its own (option C) would create a second leader, because a node can't tell a partition from a dead leader: that's split brain. A linearizable system makes the cut-off side unavailable.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "causality",
      title: "Causality: the order that actually matters",
      kicker: "Ordering",
      concepts: ["consistent-prefix-causal-consistency", "vector-clocks-vs-version-vectors", "sequential-consistency"],
      blocks: [
        {
          type: "problem",
          html: `<p>In a comment thread, Ana asks "Is the venue step-free?" and Ben replies "Yes, there's a ramp at the side door". A reader whose replica received Ben's reply first sees an answer to a question nobody has asked. A replica that receives "update order 42" before "create order 42" drops the update. An on-call doctor goes off shift because her screen still shows a colleague on call, though he has just left too.</p>
<p>None of these is about real-time recency. Each is an <strong>effect seen before its cause</strong>. The naive fix, stamping operations with wall-clock time and sorting, fails because clocks drift (Chapter 8): a reply written on a node with a slow clock sorts before its question. Linearizing everything would fix it, at the costs the previous section described. What is the cheapest guarantee that effects never appear before their causes, and can it keep working during a partition?</p>`,
        },
        {
          type: "text",
          html: `<p>Ordering keeps coming back in this book: the leader's replication log (Chapter 5) is an order of writes, serializability (Chapter 7) is transactions behaving as if run in some order, and Chapter 8's timestamps and clocks are attempts to order events. The thread running through all of them is <strong>causality</strong>. Look back and you'll find it everywhere:</p>
<ul>
<li><strong>Consistent prefix reads</strong> (Chapter 5) exist because an answer depends on its question.</li>
<li>In <strong>multi-leader replication</strong> (Chapter 5) an update depends on the insert that created the row; applied first, it hits a row that doesn't exist yet.</li>
<li><strong>Concurrent writes</strong> (Chapter 5) were defined through happens-before: B depends on A if B knew about A; if neither knew about the other, they are concurrent.</li>
<li><strong>Snapshot isolation</strong> (Chapter 7) reads a snapshot consistent with causality: if it contains the answer, it contains the question.</li>
<li><strong>Write skew</strong> (Chapter 7): the doctor acted on a premise ("someone else is on call") that a concurrent change invalidated.</li>
<li>The <strong>live score</strong>: Bob's refresh was caused by Alice's shout, so it should show at least what hers did.</li>
</ul>
<p>A system that respects this order everywhere is <strong>causally consistent</strong>. Snapshot isolation, for example, gives causal consistency for reads.</p>`,
        },
        {
          type: "idea",
          html: `<p>Causality is a <strong>partial order</strong>: a happened before b if b could have been influenced by a. A causally consistent system preserves that order without forcing one on concurrent operations, which makes it the strongest guarantee known that never has to wait for remote nodes.</p>`,
        },
        {
          type: "diagram",
          title: "Total order versus partial order",
          svg: `<svg viewBox="0 0 640 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left: five events on one line. Right: a branches to b and c, which merge into d">
  <defs>
    <marker id="c9d-po-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <rect x="8" y="8" width="300" height="194" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="158" y="32" font-size="13" font-weight="700" text-anchor="middle">Linearizable: one timeline</text>
  <g stroke-width="1.5" style="stroke: var(--viz-muted)">
    <line x1="55" y1="100" x2="80" y2="100" marker-end="url(#c9d-po-m)"/>
    <line x1="112" y1="100" x2="137" y2="100" marker-end="url(#c9d-po-m)"/>
    <line x1="169" y1="100" x2="194" y2="100" marker-end="url(#c9d-po-m)"/>
    <line x1="226" y1="100" x2="251" y2="100" marker-end="url(#c9d-po-m)"/>
  </g>
  <g style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)">
    <circle cx="40" cy="100" r="15"/><circle cx="97" cy="100" r="15"/><circle cx="154" cy="100" r="15"/><circle cx="211" cy="100" r="15"/><circle cx="268" cy="100" r="15"/>
  </g>
  <g font-size="13" font-weight="600" text-anchor="middle">
    <text x="40" y="105">a</text><text x="97" y="105">b</text><text x="154" y="105">c</text><text x="211" y="105">d</text><text x="268" y="105">e</text>
  </g>
  <text x="158" y="176" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">any two events: one came first;</text>
  <text x="158" y="194" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">no concurrency at all</text>
  <rect x="332" y="8" width="300" height="194" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="482" y="32" font-size="13" font-weight="700" text-anchor="middle">Causal: a partial order</text>
  <g stroke-width="1.5" style="stroke: var(--viz-muted)">
    <line x1="386" y1="95" x2="454" y2="70" marker-end="url(#c9d-po-m)"/>
    <line x1="386" y1="105" x2="454" y2="130" marker-end="url(#c9d-po-m)"/>
    <line x1="486" y1="69" x2="564" y2="94" marker-end="url(#c9d-po-m)"/>
    <line x1="486" y1="131" x2="564" y2="106" marker-end="url(#c9d-po-m)"/>
  </g>
  <g style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)">
    <circle cx="372" cy="100" r="15"/><circle cx="472" cy="64" r="15"/><circle cx="472" cy="136" r="15"/><circle cx="580" cy="100" r="15"/>
  </g>
  <g font-size="13" font-weight="600" text-anchor="middle">
    <text x="372" y="105">a</text><text x="472" y="69">b</text><text x="472" y="141">c</text><text x="580" y="105">d</text>
  </g>
  <text x="472" y="97" font-size="12" font-weight="600" text-anchor="middle" style="fill: var(--viz-warn)">b and c are</text>
  <text x="472" y="112" font-size="12" text-anchor="middle" style="fill: var(--viz-warn)">concurrent</text>
  <text x="482" y="176" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">only cause → effect is ordered;</text>
  <text x="482" y="194" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">like Git: branch, then merge</text>
</svg>`,
          caption: `Linearizability orders everything; causality orders only what could have influenced what. On the right, b and c each depend on a, d depends on both, and b and c have no order between them at all.`,
        },
        {
          type: "text",
          html: `<h3>Total order versus partial order</h3>
<p>A <strong>total order</strong> lets you compare any two elements: of two numbers, one is larger. A <strong>partial order</strong> leaves some pairs incomparable: is the set {a, b} bigger than {b, c}? Neither contains the other, so the question has no answer.</p>
<p>Linearizability is a total order on operations: one copy, atomic operations, a single timeline with no concurrency. Causality is a partial order: two operations are ordered if one could have influenced the other, and <strong>concurrent</strong> otherwise. Its history branches and merges like a Git commit graph, where commits on different branches have no inherent order until a merge commit depends on both.</p>
<h3>Stronger than eventual, cheaper than linearizable</h3>
<p>Linearizability <strong>implies</strong> causal consistency: a single timeline that respects real time puts every cause before its effects, including causes that travelled through side channels, with no extra work. The reverse doesn't hold, and that gap is the opportunity.</p>
<p>As far as anyone knows, nothing stronger than causal consistency can both answer without waiting on remote replicas and keep answering when the network splits. A formal version of that claim, for a variant called <em>real-time causal</em> consistency, was proved by Mahajan, Alvisi and Dahlin in 2011. Many systems that seem to need linearizability only need causality, and research systems such as COPS show it can work across datacenters, though production adoption was limited when the book was written. One thing it can't do: enforce <strong>uniqueness</strong>. Two concurrent claims on one username are, by definition, unordered by causality; choosing between them needs consensus.</p>`,
        },
        {
          type: "table",
          title: "The consistency ladder, strongest to weakest",
          headers: ["Model", "Guarantee", "Available on both sides of a partition?", "Example"],
          rows: [
            [`<span style="overflow-wrap:normal;word-break:normal">Strict serializability</span>`, "Transactions over many objects appear to run one at a time, in an order that respects real time", "No", "Spanner (external consistency), FoundationDB"],
            [`<span style="overflow-wrap:normal;word-break:normal">Linearizability</span>`, "Each object behaves like a single copy; operations take effect in real-time order", "No", "etcd (default reads), ZooKeeper writes, Cassandra lightweight transactions"],
            [`<span style="overflow-wrap:normal;word-break:normal">Sequential consistency</span>`, "One total order that every client sees, respecting each client's own order, but possibly lagging real time", "No", "ZooKeeper reads without sync()"],
            [`<span style="overflow-wrap:normal;word-break:normal">Causal consistency</span>`, "Causally related operations appear in the same order everywhere; concurrent ones in any order", "Yes, if each client stays with replicas on its side", "MongoDB causally consistent sessions; COPS (research)"],
            [`<span style="overflow-wrap:normal;word-break:normal">Eventual consistency</span>`, "Replicas converge once writes stop; no ordering promise", "Yes", "Dynamo-style stores with last-write-wins; DNS"],
          ],
          note: `The ladder mixes axes: strict serializability concerns multi-object transactions, the other rows single-object operations. For a single object, strict serializability coincides with linearizability.`,
        },
        {
          type: "text",
          html: `<p>Sequential consistency is the subtle rung. Suppose A's write x = 1 completes, and afterwards B reads x from a lagging follower and gets 0. Ordering the history as "B's read, then A's write" respects each client's own sequence of operations, so it is sequentially consistent. It contradicts real time, though, so it isn't linearizable.</p>
<h3>Capturing causal dependencies</h3>
<p>To preserve causal order, a replica must apply an operation only after everything that happened before it; if something is missing, it waits. So the database must know what each operation depends on, and a write depends on whatever its client had read before writing: if you read the question and then wrote the answer, the answer depends on the question.</p>
<p>Chapter 5 solved a small version of this for one key with <strong>version vectors</strong>. Causal consistency generalizes it to the whole database: reads hand the client version information, and the client passes back the version it read when it writes, much as serializable snapshot isolation tracks the versions a transaction read (Chapter 7). Tracking every read of every client is a lot of metadata, which motivates the more compact sequence numbers of the next section.</p>
<p>Two related tools are often confused. Both compare vectors entry by entry (a is before b if every entry of a is ≤ the matching entry of b), but they track different things and grow with the number of participants:</p>`,
        },
        {
          type: "compare",
          title: "Vector clock vs version vector",
          items: [
            {
              title: "Vector clock",
              tone: "info",
              html: `One counter <strong>per process</strong>, attached to <em>events and messages</em>. A process increments its own entry for every event; on receiving a message it takes the entrywise maximum, then increments. Purpose: compare <em>any two events</em> in the system. If neither vector is ≤ the other, the events are concurrent.`,
            },
            {
              title: "Version vector",
              tone: "info",
              html: `One counter <strong>per replica</strong>, attached to <em>versions of one data item</em>. A replica increments its entry when it accepts a write to that item; merging versions takes the entrywise maximum. Purpose: detect concurrent writes to the same key and keep them as siblings for the application to merge (Chapter 5).`,
            },
          ],
        },
        {
          type: "callout",
          tone: "mistake",
          html: `<p>Causal consistency is <em>not</em> eventual consistency: eventual promises only that replicas converge, while causal also promises that no replica ever shows an effect before its cause. And vector clocks do <em>not</em> give a total order. Their whole point is to say "these two are concurrent" when that's the truth; to get a single sorted sequence you must add an arbitrary tie-break, which is what Lamport timestamps do in the next section.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "MongoDB",
              year: "2017",
              tag: "causal sessions",
              html: `MongoDB 3.6 introduced causally consistent client sessions. With majority read and write concern, a session's operations are ordered by a cluster-wide logical time passed between client and servers, giving read-your-writes and monotonic reads even when reading from secondaries.`,
            },
            {
              org: "COPS",
              year: "2011",
              tag: "research",
              html: `"Don't Settle for Eventual" (Lloyd et al., SOSP 2011) built a geo-replicated key-value store with causal+ consistency: it tracks each write's dependencies and makes a write visible in a datacenter only after its dependencies are visible there.`,
            },
            {
              org: "Riak",
              tag: "dotted version vectors",
              html: `Riak 2.0 introduced dotted version vectors to fix "sibling explosion": with plain per-replica version vectors, many clients writing one key concurrently could pile up spurious siblings. A dot records exactly which write produced each sibling, so only genuinely concurrent values are kept. (Siblings themselves, and the Dynamo shopping cart that made them famous, are in <a href="#/ch5/learn/concurrent-writes">Chapter 5</a>.)`,
            },
          ],
        },
        {
          type: "tradeoffs",
          prosLabel: "Causal consistency gives you",
          consLabel: "It doesn't give you",
          pros: [
            "No effect before its cause: replies after questions, updates after creates",
            "Availability on both sides of a partition, answering from local replicas",
            "No cross-datacenter round trip on the request path",
          ],
          cons: [
            "Real-time recency: a write elsewhere can take arbitrarily long to appear",
            "Freedom from conflicts: concurrent writes still have to be merged",
            "Uniqueness or any constraint that needs one decision (that takes consensus)",
            "Small metadata: dependency vectors grow with clients, replicas or keys",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>When a prompt says "we need strong consistency" for a feed, chat or comments, probe what actually breaks. Usually it's ordering ("a reply must never appear before its message"), which causal consistency, or even per-conversation ordering, solves without a global round trip. A strong answer names the guarantee (causal, or read-your-writes plus consistent prefix), explains how dependencies are tracked (version vectors, or a session token carrying the last-seen logical time) and reserves linearizability for parts that need a single decision, like claiming a handle.</p>`,
        },
        {
          type: "quiz",
          q: "Which statement about causal consistency is correct?",
          options: [
            "It is stronger than linearizability, because it also records which operations caused which",
            "It requires every node to agree on one total order of all operations, like a replicated log",
            "Every linearizable system is causally consistent, and causal consistency can stay available during a partition",
            "It is the same as eventual consistency: replicas converge once writes stop",
          ],
          answer: 2,
          explain: `Linearizability's single real-time timeline includes every cause-before-effect relationship, so it implies causality, not the other way round (option A). Causality orders only related operations, so it needs no global total order (option B), and replicas can keep accepting operations during a partition, ordering concurrent ones arbitrarily. It's stronger than eventual consistency (option D), which promises only convergence and lets effects appear before causes.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "lamport-timestamps",
      title: "Lamport timestamps: a total order without clocks, and its blind spot",
      kicker: "Mechanism",
      concepts: ["lamport-timestamps", "sequence-number-ordering"],
      blocks: [
        {
          type: "problem",
          html: `<p>Tracking every causal dependency (which versions each client read) is too expensive, and physical clocks can't be trusted to put causes before effects (Chapter 8). With a single leader, ordering is easy: number every write in the replication log. But multi-leader and leaderless databases have no single leader, and neither does a partitioned database with a leader per shard.</p>
<p>The popular shortcuts for numbering operations without one each break causality. Per-node counters (odd numbers on one node, even on another) let a busy node race ahead of a quiet one. Wall-clock timestamps are skewed. Preallocated blocks of IDs can number a later operation lower than an earlier one. We want something as compact as a counter that never contradicts cause and effect.</p>`,
        },
        {
          type: "text",
          html: `<p>Instead of tracking dependencies explicitly, use <strong>sequence numbers</strong> or <strong>logical timestamps</strong>: counters, not time-of-day clocks. They are compact (a few bytes) and totally ordered, so any two can be compared. The goal is to generate them <strong>consistently with causality</strong>: if A happened before B, A gets the smaller number. Concurrent operations may come out in either order.</p>
<p>With single-leader replication this is trivial. The leader increments a counter for each write and records it in the replication log; followers apply writes in log order, so their state is always causally consistent, even when it lags. Without a single leader, the obvious generators look like this:</p>`,
        },
        {
          type: "table",
          title: "Noncausal sequence number generators",
          headers: ["Generator", "How it works", "Why it breaks causality"],
          rows: [
            ["Independent per-node counters", "Each node counts on its own; uniqueness comes from odd/even numbers or node-ID bits", "Nodes run at different rates: a busy node's counter races ahead, so a later operation on a quiet node gets a smaller number"],
            ["Time-of-day timestamps", "Stamp each operation with the node's physical clock, perhaps at microsecond resolution", "Clock skew (Chapter 8): a node with a slow clock stamps an effect before its cause, the same flaw that makes last-write-wins lose data"],
            ["Preallocated blocks", "Node A hands out 1 to 1,000, node B 1,001 to 2,000", "B's operation gets 1,001; a later operation on A that depends on it gets, say, 5"],
          ],
          note: `All three produce unique, roughly increasing IDs, which is fine for identifiers. Twitter's Snowflake (timestamp plus worker ID) is a well-known example of the second kind (<a href="#/ch8/learn/ordering-by-timestamps">Chapter 8</a>). None of them tells you which operation could have influenced which.`,
        },
        {
          type: "idea",
          html: `<p>Give every node a counter, stamp each event with the pair <strong>(counter, node ID)</strong>, and make every node jump its counter past any larger value it sees. The result is a total order that always respects causality, for the price of one integer per message. These are <strong>Lamport timestamps</strong> (Leslie Lamport, 1978).</p>`,
        },
        {
          type: "steps",
          title: "The Lamport timestamp algorithm",
          items: [
            `Every node has a unique <strong>node ID</strong> and a <strong>counter</strong> that starts at 0.`,
            `For each event a node handles (processing a write, sending a message), it increments its counter and stamps the event <strong>(counter, node ID)</strong>.`,
            `Every node <em>and every client</em> remembers the <strong>largest counter it has seen</strong> and includes it on every request and response.`,
            `When a node receives a counter larger than its own, it <strong>fast-forwards</strong> its counter to that value, then increments as usual for the new event.`,
            `To order two timestamps, compare counters; if they're equal, the smaller node ID goes first. Every pair of events is now comparable: a <strong>total order</strong>.`,
          ],
        },
        {
          type: "text",
          html: `<p>A worked example with two nodes and one client. Node A has been busy and its counter is at 5; node B has been quiet and is at 1. The client writes to A, which increments to 6 and stamps the write <strong>(6, A)</strong>; the response carries 6, and the client remembers it. The client then writes to B, sending max = 6. B's counter is 1, so it jumps to 6 and increments to 7: <strong>(7, B)</strong>. The client's second write has the larger timestamp, as it should. With plain per-node counters B would have stamped it (2, B), ordering it before its own cause.</p>
<p>The fast-forward is the whole trick. A causal chain is a chain of messages, and each message carries the sender's counter forward, so counters only increase along any chain of cause and effect. Hence the guarantee: <strong>if a happened before b, then L(a) &lt; L(b)</strong>. The node ID matters too: without the tie-break two events could share a timestamp and you'd be back to a partial order.</p>
<p>The visualization below runs Lamport timestamps and vector clocks side by side on three processes. Each dot is an event labelled with its Lamport counter, its vector clock sits underneath, and the strip below lists every event in Lamport order.</p>`,
        },
        {
          type: "viz",
          id: "ch9/logical-clocks",
          title: "Lamport clocks vs vector clocks",
          caption: `Try tapping one event to light up its causal past (green) and future (blue), then tap two events to compare their clocks; the opening scene preselects two concurrent events where L(A) &lt; L(B). Notice the <span class="mono">||</span> marks in the total-order strip: those neighbors are concurrent, so their order is an accident of counter values and tie-breaks, not causality. Add your own local events and messages with the Action menu, then load Username race to see why the order isn't final until you've heard from everyone.`,
        },
        {
          type: "text",
          html: `<h3>What a Lamport timestamp can't tell you</h3>
<p>The guarantee runs one way only. If L(a) &lt; L(b), either a happened before b, or they were concurrent and the order is an accident of counter values and tie-breaks; the timestamps can't say which. That is the price of squeezing causality into one integer. To <em>detect</em> concurrency you need a vector clock, which costs one counter per node on every message.</p>
<p>The second blind spot is more practical. Two users try to claim the username <em>@ana</em> at about the same time on different nodes, and you decide that the lower Lamport timestamp wins. After the fact this works perfectly: collect all claims, sort, and the first one owns the name. But a node handling a sign-up must answer <em>now</em>. To be sure no concurrent claim with a lower timestamp exists, it would have to ask every other node, and if any of them is down or unreachable it can't answer at all. A system that stops whenever one node is unavailable isn't fault tolerant.</p>
<p>The underlying problem: you can only be sure of the Lamport order of a set of operations after every one of them has reached you. Deciding "now" also requires knowing when the order is <strong>final</strong>, that no operation with a smaller timestamp can still arrive. That is precisely what total order broadcast adds, as the next section shows.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          title: "Hybrid logical clocks",
          html: `<p><strong>Hybrid logical clocks</strong> (Kulkarni et al., 2014) combine a physical timestamp with a Lamport-style counter. Timestamps stay close to wall-clock time, so they mean something to humans and work for time-based queries, yet they never run backwards along a causal chain: a node that receives a timestamp ahead of its own clock advances past it, exactly as with Lamport timestamps. CockroachDB and YugabyteDB use hybrid logical clocks for transaction timestamps, and MongoDB's cluster time is one too. Google's TrueTime (Chapter 8) takes a different route: it bounds clock uncertainty with GPS and atomic clocks and waits it out.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Leslie Lamport",
              year: "1978",
              title: "\"Time, Clocks, and the Ordering of Events in a Distributed System\"",
              html: `Published in Communications of the ACM, it introduced logical clocks and the happened-before relation. It is among the most cited papers in computer science and part of the work for which Lamport received the 2013 Turing Award.`,
            },
            {
              org: "CockroachDB",
              tag: "hybrid logical clocks",
              html: `Uses hybrid logical clocks for transaction timestamps together with a configured maximum clock offset (500 ms by default). A node that detects its clock has drifted too far from the rest of the cluster shuts itself down rather than risk consistency anomalies.`,
            },
            {
              org: "Apache Cassandra",
              tag: "wall-clock LWW",
              html: `Orders conflicting writes by wall-clock timestamps supplied by the client or coordinator (last write wins), not by a logical clock, so a node with a fast clock can silently beat writes that actually happened later.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Design a unique ID generator" is a classic, and Snowflake-style IDs (timestamp, worker ID, sequence) are the expected answer. Strong candidates add the caveats: uniqueness comes from the worker-ID bits, not the clock; time-sortability is only approximate because worker clocks are skewed; and causality isn't guaranteed, so a reply generated on a worker whose clock lags can get a smaller ID than the message it answers. If causal order matters, carry a Lamport or hybrid logical clock through requests. If you need an order that is final the moment an ID is created ("who claimed this name first?"), you need a single log: total order broadcast.</p>`,
        },
        {
          type: "quiz",
          q: "Event a has Lamport timestamp (5, node A) and event b has (7, node B). What can you conclude?",
          options: [
            "b did not happen before a",
            "a happened before b",
            "a and b are concurrent",
            "Nothing at all",
          ],
          answer: 0,
          explain: `Lamport timestamps guarantee that if b happened before a, then L(b) &lt; L(a). Since 7 &gt; 5, b can't have happened before a. Option B is the tempting one, but a smaller timestamp doesn't prove a happened before b: they may be concurrent, and option C is equally unprovable. Only vector clocks, or a known chain of messages, can tell those two cases apart.`,
        },
      ],
    },
  ],
});
