// Chapter 9 deep dive, part 2 (second half of the sections + takeaways). Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch9", {
  sections: [
    // ───────────────────────────────────────────────────────────── 6
    {
      id: "total-order-broadcast",
      title: "Total order broadcast: if everyone reads the same log, everyone agrees",
      kicker: "Mechanism",
      concepts: ["total-order-broadcast", "state-machine-replication"],
      blocks: [
        {
          type: "problem",
          html: `<p>Ana and Ben both try to sign up as <code>@kim</code>, milliseconds apart, and each claim is broadcast to all three replicas. Every message arrives, but not in the same order everywhere: Ana's claim reaches R1 first, Ben's reaches R3 first. R1 says the name is Ana's, R3 says it's Ben's, and both users were told "it's yours". Plain writes break the same way: <code>set x=1</code> then <code>set x=2</code> leaves a different value than the reverse.</p>
<p>As the previous section showed, Lamport timestamps can't settle this on the spot: a node only knows the final order once it has heard from everyone. One leader that sequences every write fixes the order until it crashes (who takes over, and does it know every write the old leader accepted?) or can't keep up, and splitting the data across several leaders orders operations only within each partition. We need an order that every node sees identically, that is final the moment a message is delivered, and that survives node failures.</p>`,
        },
        {
          type: "idea",
          html: `<p><strong>Total order broadcast</strong> delivers every message to every node in exactly the same order, and once a message is delivered its position never changes. That turns replication into a shared, append-only log that deterministic replicas replay, and it turns out to be exactly as hard as consensus.</p>`,
        },
        {
          type: "text",
          html: `<h3>Two promises, kept even when things break</h3>
<p>Total order broadcast (also called <em>atomic broadcast</em>) is a way for a group of nodes to send each other messages that comes with two safety guarantees, kept even while nodes crash and the network misbehaves:</p>
<ul>
<li><strong>Reliable delivery:</strong> no message is lost. If it is delivered to one node, it is delivered to every node.</li>
<li><strong>Totally ordered delivery:</strong> every node delivers the messages in the same order.</li>
</ul>
<p>Timing is <em>not</em> promised. During a partition nothing new is delivered; a correct algorithm keeps retrying and, once the network heals, delivers whatever was pending, still in the agreed order. A slow node falls behind but never sees a different order than its peers.</p>
<p>A single leader <em>is</em> total order broadcast, for as long as it stays up. The hard parts are failover (a successor must agree with everyone on what was already delivered) and throughput beyond one machine. Partitioned systems, like Chapter 6's per-partition leaders or Kafka's topic partitions (Chapter 11), order messages only <em>within</em> each partition; ordering across partitions needs extra coordination.</p>`,
        },
        {
          type: "diagram",
          title: "Total order broadcast as a pipeline",
          svg: `<svg viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two clients send claims to a consensus layer, which appends them to a numbered log; three replicas apply the log in order and reach identical state">
<defs><marker id="ch9d2-tob-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="8" y="38" width="100" height="44" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="58" y="56" text-anchor="middle" font-size="13" font-weight="700">Ana</text>
<text x="58" y="73" text-anchor="middle" font-size="12">claim @kim</text>
<rect x="8" y="138" width="100" height="44" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="58" y="156" text-anchor="middle" font-size="13" font-weight="700">Ben</text>
<text x="58" y="173" text-anchor="middle" font-size="12">claim @kim</text>
<path d="M108,62 L146,94" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch9d2-tob-arr)"/>
<path d="M108,158 L146,126" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch9d2-tob-arr)"/>
<rect x="150" y="70" width="128" height="80" rx="10" stroke-width="2" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="214" y="96" text-anchor="middle" font-size="13" font-weight="700">Consensus</text>
<text x="214" y="114" text-anchor="middle" font-size="12">leader + quorum</text>
<text x="214" y="132" text-anchor="middle" font-size="12">assigns #1, #2, …</text>
<path d="M278,107 L296,107" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch9d2-tob-arr)"/>
<text x="370" y="82" text-anchor="middle" font-size="12" font-weight="700">the log</text>
<rect x="300" y="92" width="28" height="30" style="fill: var(--viz-panel); stroke: var(--viz-c1)"/>
<rect x="328" y="92" width="28" height="30" style="fill: var(--viz-panel); stroke: var(--viz-c1)"/>
<rect x="356" y="92" width="28" height="30" style="fill: var(--viz-panel); stroke: var(--viz-c1)"/>
<rect x="384" y="92" width="28" height="30" style="fill: var(--viz-panel); stroke: var(--viz-c1)"/>
<rect x="412" y="92" width="28" height="30" style="fill: var(--viz-panel); stroke: var(--viz-c1)"/>
<text x="314" y="112" text-anchor="middle" font-size="12">#1</text>
<text x="342" y="112" text-anchor="middle" font-size="12">#2</text>
<text x="370" y="112" text-anchor="middle" font-size="12">#3</text>
<text x="398" y="112" text-anchor="middle" font-size="12">#4</text>
<text x="426" y="112" text-anchor="middle" font-size="12">#5</text>
<text x="370" y="142" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">order fixed at delivery</text>
<path d="M440,104 L466,42" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch9d2-tob-arr)"/>
<path d="M440,107 L466,110" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch9d2-tob-arr)"/>
<path d="M440,110 L466,178" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch9d2-tob-arr)"/>
<rect x="470" y="8" width="162" height="62" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="551" y="27" text-anchor="middle" font-size="12" font-weight="700">R1 · state machine</text>
<text x="551" y="45" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">kim: Ana · lee: Ben</text>
<text x="551" y="62" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">applied #1–#5</text>
<rect x="470" y="79" width="162" height="62" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="551" y="98" text-anchor="middle" font-size="12" font-weight="700">R2 · state machine</text>
<text x="551" y="116" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">kim: Ana</text>
<text x="551" y="133" text-anchor="middle" font-size="12" style="fill: var(--viz-warn)">applied #1–#3, #5 held</text>
<rect x="470" y="150" width="162" height="62" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="551" y="169" text-anchor="middle" font-size="12" font-weight="700">R3 · state machine</text>
<text x="551" y="187" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">kim: Ana · lee: Ben</text>
<text x="551" y="204" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">applied #1–#5</text>
</svg>`,
          caption: "Claims enter a fault-tolerant consensus layer that gives each one a position in a single log; every replica applies the log strictly in order. Same inputs, same order, deterministic code: same state. R2 received #5 before #4, so it has applied only #1–#3 and holds #5 back; once #4 arrives it applies both and catches up to the same state.",
        },
        {
          type: "text",
          html: `<p>The visualization below lets you cause the difference yourself. In <strong>Plain broadcast</strong> mode, Ana's and Ben's claims for the same username fly straight to all three replicas, and each replica applies whichever arrives first. In <strong>Total order broadcast</strong> mode, every claim first goes to a log leader that stamps it with the next sequence number, and replicas apply messages strictly in number order. The first frame already shows a race that went wrong.</p>`,
        },
        {
          type: "viz",
          id: "ch9/total-order-broadcast",
          title: "Same log, same state",
          caption: "Try racing Ana and Ben for a few names in Plain broadcast mode with high jitter, then switch to Total order broadcast and race again. Notice that plain broadcast can leave replicas disagreeing and tell both clients yes, while the sequenced log keeps every replica identical and holds back any number that arrives early. Then, in Total order broadcast mode, have Ben check a name mid-race, first via his local replica and then via the log. The Log leader stands in for a consensus group: in a real system it is a Raft or Zab leader that gets each entry onto a majority before it is delivered.",
        },
        {
          type: "text",
          html: `<p>In plain mode no message was lost; the replicas diverged purely because they disagreed about <em>order</em>. In total order mode a replica sometimes receives #4 before #3 and <strong>holds it back</strong>. It can do that only because the numbering has no gaps: seeing #4 proves that a #3 exists and hasn't arrived yet. A Lamport timestamp never tells you whether a smaller one is still in flight.</p>
<h3>What a shared log buys you</h3>
<p><strong>State machine replication.</strong> If every message is a write, and every replica runs the same deterministic code over the same writes in the same order, all replicas pass through the same states. That's why Chapter 5's statement-based replication had to forbid nondeterministic functions such as <code>NOW()</code> and <code>RAND()</code>: one nondeterministic step and the replicas drift apart, even with a perfect log.</p>
<p><strong>Serializable transactions without locks.</strong> Make each message a whole transaction, written as a deterministic stored procedure, and run the procedures in delivery order: Chapter 7's actual serial execution, replicated. VoltDB works this way, and the Calvin research system agrees on a transaction order through a replicated log before executing anything.</p>
<p><strong>The order is fixed at delivery.</strong> A node never slips a message in front of one it has already delivered: once you've delivered #17, nothing new can ever appear at positions 1 to 16. Timestamp ordering can't promise that, because a message with a smaller timestamp may still turn up.</p>
<p><strong>It's a log.</strong> Delivering a message is appending it to a log that every node reads in the same order, which is exactly what a database's replication log, a Kafka partition or a consensus group's write-ahead log is.</p>
<p><strong>Fencing tokens for free.</strong> A lock service can append each lock acquisition to the log. Its log position only ever increases, so it works as a fencing token (Chapter 8); ZooKeeper's transaction ID, the <code>zxid</code>, plays exactly this role.</p>`,
        },
        {
          type: "steps",
          title: "A linearizable username claim, built on a log",
          items: [
            "<strong>Append a tentative claim.</strong> Ana's node appends <code>claim @kim for Ana</code> to the log. Nothing is decided yet; the message just receives a position.",
            "<strong>Wait for your own message to come back.</strong> Ana's node keeps delivering log messages in order until it delivers its own claim. By then it has also delivered every message placed before it.",
            "<strong>Check whether you were first.</strong> If the first claim for <code>@kim</code> in the log is Ana's, the claim succeeds: commit it and tell Ana yes. If someone else's claim for <code>@kim</code> came earlier, abort and tell her the name is taken.",
            "<strong>Everyone reaches the same verdict.</strong> Every node sees the claims in the same order, so all of them independently agree on the winner without exchanging any further messages. The write is linearizable: once anyone has been told yes, nobody else can be told yes for that name.",
          ],
        },
        {
          type: "text",
          html: `<h3>Reads need extra care</h3>
<p>That recipe makes <em>writes</em> linearizable, but replicas apply the log asynchronously, so a read from a lagging replica's local state can be stale. Local reads give you <strong>sequential consistency</strong> (sometimes called timeline consistency): every replica passes through the same states in the same order, just not at the same time. Three ways to make reads linearizable too:</p>
<ol>
<li><strong>Send the read through the log.</strong> Append a marker for the read and answer when the marker is delivered back to you. Early versions of etcd served quorum reads through the Raft log like this.</li>
<li><strong>Find the latest position, then catch up.</strong> Learn the current end of the log in a linearizable way, wait until your replica has applied everything up to it, then read locally. Raft's <em>ReadIndex</em> does this rigorously and backs etcd's default linearizable reads. ZooKeeper's <code>sync()</code>, which makes the server you're connected to catch up with the leader before your next read, follows the same idea.</li>
<li><strong>Read from a synchronously updated replica.</strong> If no write is acknowledged until a particular replica has applied it, reading there is safe; chain replication serves reads from the tail of the chain.</li>
</ol>
<p>Each option pays for freshness with latency.</p>
<h3>The other direction: a log from a counter</h3>
<p>The reverse construction works too. Given a linearizable register with an atomic <em>increment-and-get</em> operation, attach the next number to each message as its sequence number, send the message to every node (resending if it's lost), and have every node deliver strictly in sequence-number order. The numbers have <strong>no gaps</strong>: a node that has delivered 4 and then receives 6 knows that 5 exists, and waits for it. After Lamport timestamp 4, by contrast, the next one you see might be 9, and nothing tells you whether 5 to 8 were ever issued.</p>
<p>The catch: that counter is trivial on one machine and hard once it must survive the machine's failure, because the other nodes must agree on who takes over and what the last number was. That is consensus. Total order broadcast, a linearizable compare-and-set (or increment-and-get) register, and consensus are all <strong>equivalent</strong>: solve one and you can build the others, as the consensus section below makes precise.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Apache ZooKeeper",
              tag: "zxid",
              html: "Every state change is broadcast with ZooKeeper's Zab protocol and stamped with a 64-bit <code>zxid</code>. The high 32 bits hold the leader's epoch and the low 32 bits a counter within that epoch, so zxids totally order every write and can double as fencing tokens.",
            },
            {
              org: "etcd",
              tag: "revision",
              html: "Every write increments a single cluster-wide revision number, and each key records the revisions at which it was created and last modified. Revisions work as fencing tokens, and a watch can resume from \"everything after revision N\" after a disconnect.",
            },
            {
              org: "Apache Kafka",
              tag: "per-partition order",
              html: "Guarantees ordering only within a partition: each partition is a log that every consumer reads in the same order, and its offsets are gapless sequence numbers. There is no order across partitions, so all events that must be ordered relative to each other need the same partition key.",
            },
            {
              org: "VoltDB and Calvin",
              tag: "deterministic transactions",
              html: "VoltDB executes deterministic stored procedures one at a time per partition, in an agreed order. Calvin (SIGMOD 2012) first agrees on a global order of transactions through a replicated log, then has every replica execute them deterministically, which avoids two-phase commit.",
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Kafka moved its own metadata onto a log",
          html: `<p>Kafka originally relied on ZooKeeper for controller election and cluster metadata. KIP-500 replaced that with <strong>KRaft</strong>: a quorum of Kafka controller nodes runs Raft over a metadata log, and every broker follows that log. KRaft was declared production-ready in Kafka 3.3 (2022), and Kafka 4.0 (2025) removed ZooKeeper mode entirely. It's total order broadcast applied to the system's own configuration.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Common prompts: "How would you guarantee unique usernames across regions?" and "What's the relationship between a log and consensus?". A strong answer routes every claim for a name through one totally ordered log (a single partition or a consensus group), has the claimant wait until its own claim comes back, and accepts only if it was the first claim for that name. Then it explains why timestamps alone fail (you can't know a smaller one isn't still in flight) and that the log itself must be fault tolerant, which is consensus. Extra credit: point out that reads are not automatically linearizable and need ReadIndex, <code>sync()</code> or a trip through the log.</p>`,
        },
        {
          type: "quiz",
          q: "Why can't a node use Lamport timestamps alone to decide right now whether to grant a username, while total order broadcast lets it?",
          options: [
            "Lamport timestamps can collide, so two concurrent claims might carry the same timestamp and tie",
            "Total order broadcast orders claims by synchronized physical clocks, which Lamport timestamps lack",
            "Total order broadcast delivers gaplessly, so by the time your own claim comes back, every earlier claim is known",
            "Lamport timestamps from different nodes can't be compared, so claims made on different nodes can't be ranked",
          ],
          answer: 2,
          explain: "Lamport timestamps are (counter, node ID) pairs, so they never tie and any two can be compared: options A and D are wrong. Their problem is finality: there is no way to know whether a claim with a smaller timestamp is still on its way. Total order broadcast delivers gaplessly and never inserts a message before one already delivered, so the order up to your own message is final when you see it. Neither technique relies on synchronized physical clocks.",
        },
      ],
    },
    // ───────────────────────────────────────────────────────────── 7
    {
      id: "two-phase-commit",
      title: "Two-phase commit: a protocol of promises",
      kicker: "Atomic commit",
      concepts: ["two-phase-commit", "coordinator-failure-in-2pc", "three-phase-commit"],
      blocks: [
        {
          type: "problem",
          html: `<p>A transfer moves $100 from an account stored on node A to an account stored on node B. The obvious way to commit it is to send "commit" to both nodes and let each one commit on its own. Here's how that goes wrong:</p>
<ul>
<li>Node B finds a constraint violation (say, the destination account was just closed) and aborts, while node A has already committed the debit. The $100 has vanished.</li>
<li>The commit message to B is lost in the network. A commits; B times out and aborts.</li>
<li>B receives the message but crashes before its commit record reaches disk, and rolls the transaction back during recovery.</li>
</ul>
<p>And A can't quietly undo its commit afterwards. Once a transaction commits, its writes become visible to other transactions (under read committed, for example), which may already have acted on them; retracting the commit would make those readers wrong too. A refund is a separate <em>compensating transaction</em>, an application-level business action, not an undo. We need every node to commit, or none, even if some of them crash halfway through.</p>`,
        },
        {
          type: "text",
          html: `<h3>Where single-node commit gets its atomicity</h3>
<p>On one machine, the order of disk writes does the work (Chapter 7). The database first makes the transaction's data durable, typically in a write-ahead log, and then appends a <strong>commit record</strong>. If the machine crashes before that record reaches disk, recovery rolls the transaction back; if it crashes after, the transaction is committed. The moment the record becomes durable is the <strong>commit point</strong>, and it's decided by one disk on one node.</p>
<p>With several nodes there's no single disk to make that decision, so the nodes have to agree. Agreement shows up in two classic places: choosing a leader (the subject of the consensus section) and <strong>atomic commit</strong>, where every participant in a transaction must reach the same outcome. Two-phase commit (2PC) is the classic atomic commit algorithm. It's worth studying closely, because its weaknesses are exactly what consensus algorithms fix.</p>
<p>Despite the similar name, 2PC has nothing to do with <a href="#/ch7/learn/two-phase-locking">two-phase locking (2PL)</a> from Chapter 7. 2PL provides <em>isolation</em>: concurrent transactions can't see each other's half-done work. 2PC provides <em>atomicity</em> across nodes: a transaction commits everywhere or nowhere.</p>`,
        },
        {
          type: "idea",
          html: `<p>Split commit into a <strong>promise</strong> and a <strong>decision</strong>. Every participant first promises that it can commit no matter what happens (it votes YES), and only then does a single coordinator durably record the decision. That record, not any participant's state, is the commit point.</p>`,
        },
        {
          type: "steps",
          title: "The protocol, step by step",
          items: [
            "<strong>Get a transaction ID.</strong> When the application starts a distributed transaction, it asks the <em>coordinator</em> (also called the transaction manager) for a globally unique transaction ID. The coordinator is often a library inside the application process, sometimes a separate service.",
            "<strong>Do the work.</strong> The application begins an ordinary single-node transaction on each <em>participant</em> (each database involved), tagged with that ID, and does its reads and writes there. Until now any participant may still abort, for example on a conflict, which cancels the whole transaction.",
            "<strong>Phase 1: prepare.</strong> When the application is ready to commit, the coordinator sends <code>prepare(txid)</code> to every participant.",
            "<strong>Vote.</strong> Each participant makes sure it can commit under all circumstances: it writes all of the transaction's data durably, checks constraints and conflicts, and only then votes YES. A YES vote gives up the right to abort, but it isn't a commit: the participant still holds the transaction's locks. If it can't guarantee success, it votes NO and aborts.",
            "<strong>Decide, durably.</strong> The coordinator collects the votes. It decides COMMIT only if every participant voted YES, otherwise ABORT, and writes that decision to its own log on disk. <strong>This write is the commit point.</strong>",
            "<strong>Phase 2: commit or abort.</strong> The coordinator sends the decision to every participant. If a request fails or times out, it retries forever; there's no going back. A participant that crashed in the meantime finds its prepare record on recovery and commits as soon as it learns the decision, because it promised.",
          ],
        },
        {
          type: "text",
          html: `<p>So the protocol contains two <strong>points of no return</strong>. The first is each participant's YES vote: from then on it must be able to commit, even after a crash. The second is the coordinator's durable decision: once COMMIT is on disk, it will be carried out even if the coordinator crashes a millisecond later. Those two irreversible steps are what make the outcome atomic.</p>`,
        },
        {
          type: "analogy",
          title: "A wedding",
          html: `<p>At a wedding, the officiant asks each partner whether they take the other. Each "I do" is a promise, but on its own it doesn't create a marriage. The marriage exists once the officiant pronounces it and it's entered in the register. From then on it stands even if someone faints on the way out, and neither partner can quietly undo it alone. If either partner says no, there's no marriage at all.</p>`,
        },
        {
          type: "diagram",
          title: "Two-phase commit and its two points of no return",
          svg: `<svg viewBox="0 0 640 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sequence diagram: the coordinator sends prepare to two participants, both vote yes, the coordinator writes its decision to its log, then sends commit; each participant is in doubt between its yes vote and receiving commit">
<defs>
<marker id="ch9d2-2pc-c1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker>
<marker id="ch9d2-2pc-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ok)"/></marker>
<marker id="ch9d2-2pc-mu" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
</defs>
<text x="8" y="76" font-size="12" font-weight="700">Coordinator</text>
<text x="8" y="162" font-size="12" font-weight="700">Participant A</text>
<text x="8" y="226" font-size="12" font-weight="700">Participant B</text>
<path d="M112,72 L628,72" stroke-width="2" style="fill: none; stroke: var(--viz-line)"/>
<path d="M112,158 L628,158" stroke-width="2" style="fill: none; stroke: var(--viz-line)"/>
<path d="M112,222 L628,222" stroke-width="2" style="fill: none; stroke: var(--viz-line)"/>
<rect x="205" y="149" width="205" height="18" rx="4" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<rect x="215" y="213" width="215" height="18" rx="4" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="318" y="162" text-anchor="middle" font-size="12">in doubt, locks held</text>
<text x="322" y="226" text-anchor="middle" font-size="12">in doubt, locks held</text>
<path d="M205,138 L205,178" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-ink)"/>
<path d="M215,202 L215,242" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-ink)"/>
<path d="M130,72 L189,157" stroke-width="1.6" style="fill: none; stroke: var(--viz-c1)" marker-end="url(#ch9d2-2pc-c1)"/>
<path d="M130,72 L199,221" stroke-width="1.6" style="fill: none; stroke: var(--viz-c1)" marker-end="url(#ch9d2-2pc-c1)"/>
<path d="M205,158 L269,74" stroke-width="1.6" style="fill: none; stroke: var(--viz-ok)" marker-end="url(#ch9d2-2pc-ok)"/>
<path d="M215,222 L277,74" stroke-width="1.6" style="fill: none; stroke: var(--viz-ok)" marker-end="url(#ch9d2-2pc-ok)"/>
<path d="M350,72 L409,157" stroke-width="1.6" style="fill: none; stroke: var(--viz-ok)" marker-end="url(#ch9d2-2pc-ok)"/>
<path d="M350,72 L429,221" stroke-width="1.6" style="fill: none; stroke: var(--viz-ok)" marker-end="url(#ch9d2-2pc-ok)"/>
<path d="M425,158 L484,74" stroke-width="1.4" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch9d2-2pc-mu)"/>
<path d="M445,222 L494,74" stroke-width="1.4" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch9d2-2pc-mu)"/>
<text x="140" y="118" text-anchor="end" font-size="12" class="viz-halo" style="fill: var(--viz-c1)">prepare</text>
<text x="270" y="118" font-size="12" class="viz-halo" style="fill: var(--viz-ok)">yes</text>
<text x="368" y="118" text-anchor="end" font-size="12" class="viz-halo" style="fill: var(--viz-ok)">commit</text>
<text x="490" y="118" font-size="12" class="viz-halo" style="fill: var(--viz-muted)">ok</text>
<path d="M312,50 L312,92" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-ink)"/>
<text x="312" y="80" text-anchor="middle" font-size="20" style="fill: var(--viz-ok)">★</text>
<text x="312" y="26" text-anchor="middle" font-size="12" font-weight="700">decision written to log</text>
<text x="312" y="42" text-anchor="middle" font-size="12">= commit point, now final</text>
<text x="560" y="64" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">done</text>
<text x="209" y="254" font-size="12">↑ YES vote = a promise: can no longer abort alone</text>
</svg>`,
          caption: "Time runs left to right. The dashed ticks mark each participant's YES vote; the star marks the coordinator's durable decision. Between its vote and the arrival of COMMIT, each participant is in doubt (amber): it can neither commit nor abort on its own, and it keeps its locks.",
        },
        {
          type: "text",
          html: `<p>The sandbox below runs 2PC across three participants (Orders, Payments and Inventory) and lets you choose how Payments votes and crash the coordinator at three dangerous moments. Keep an eye on the coordinator's log strip: it lives on disk, so it survives the crash, and it's the only thing that can tell the participants what was decided. A separate transaction, tx99, wants to update the row that Payments has locked.</p>`,
        },
        {
          type: "viz",
          id: "ch9/two-phase-commit",
          title: "Two-phase commit and the in-doubt window",
          caption: "Try one clean run, then set the coordinator to crash after logging the decision, mid-send, and run again. Notice that Orders commits while Payments and Inventory sit in doubt with their lock timers climbing; press tx99 updates acct#7 and it queues behind Payments' lock until you recover the coordinator. Then repeat that crash, press the admin's heuristic abort before recovering, and watch atomicity break. A crash before the decision is logged ends in presumed abort instead.",
        },
        {
          type: "text",
          html: `<h3>When the coordinator dies</h3>
<p>Timeouts are allowed right up to the promise. A participant that hasn't voted may abort on its own (say, the prepare request never arrives); a participant that votes NO aborts at once; the coordinator may abort if a vote is late. In each case nobody has promised anything that a unilateral abort could contradict.</p>
<p>After a YES vote, everything changes. If the coordinator crashes now, the participant is <strong>in doubt</strong> (or <em>uncertain</em>): aborting might contradict a COMMIT that others have already applied, and committing might contradict an ABORT caused by someone else's NO. It can't tell which, so it must wait, holding its locks. If it restarts in the meantime, it comes back still prepared, locks and all, because the prepare record is on disk.</p>
<p>The canonical bad case is the one in the viz: the coordinator logs COMMIT, tells the first participant, and crashes. The first participant commits and releases its locks, so its change may already be visible; the others can neither abort nor commit. In principle participants could ask each other how they voted, but that isn't part of 2PC. The way out is for the coordinator to recover, read its log and resend the decision; any transaction without a commit record in the log is aborted, a rule called <strong>presumed abort</strong>. Because progress depends on one particular node coming back, 2PC is a <strong>blocking</strong> protocol.</p>
<p>That's the real lesson: 2PC reaches agreement only because the coordinator is a dictator. When the dictator disappears, so does progress. Consensus algorithms, coming up shortly, keep the agreement and remove the dictator.</p>`,
        },
        {
          type: "callout",
          tone: "insight",
          title: "Why not just use three-phase commit?",
          html: `<p><strong>Three-phase commit</strong> (3PC) adds a round so that participants can finish a transaction among themselves if the coordinator fails. It's designed to be nonblocking, but only under the assumption that network delays and node response times are bounded. In a real network with unbounded delays and process pauses (Chapter 8), a participant can't distinguish a crashed coordinator from a slow one, and 3PC can then reach inconsistent outcomes. Nonblocking atomic commit needs a <em>perfect failure detector</em>, which an asynchronous network can't provide. That's why systems still use 2PC, blocking and all, and fix the blocking by making the coordinator itself fault tolerant.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "PostgreSQL",
              tag: "participant API",
              html: "Exposes the participant side of 2PC directly. <code>PREPARE TRANSACTION 'id'</code> persists a transaction so it survives a crash, <code>COMMIT PREPARED</code> or <code>ROLLBACK PREPARED</code> finishes it later, and the <code>pg_prepared_xacts</code> view lists the ones still in doubt. The feature is off by default (<code>max_prepared_transactions = 0</code>).",
            },
            {
              org: "X/Open XA",
              year: "1991",
              html: "The standard interface for 2PC between a transaction manager and heterogeneous resource managers such as databases and message brokers. Java's JTA is built on it. The next section looks at how it behaves in production.",
            },
            {
              org: "Google Spanner",
              tag: "2PC over Paxos",
              html: "Runs two-phase commit across shards, but each participant and the coordinator is a Paxos-replicated group rather than a single machine, so one server's crash doesn't leave participants blocked in doubt.",
            },
            {
              org: "Google Percolator and TiDB",
              year: "2010",
              html: "Percolator (OSDI 2010) built cross-row transactions on Bigtable with a 2PC-style protocol that uses a primary lock and a timestamp oracle. TiDB's storage layer, TiKV, implements a transaction model based on Percolator.",
            },
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Walk me through 2PC. What happens if the coordinator crashes?" is a staple. A strong answer hits four points: a participant's YES is a promise that gives up the right to abort; the commit point is the coordinator's durable decision, not the votes; a crash between those two leaves participants in doubt, holding locks, until the coordinator recovers; and the modern fix is to replicate the coordinator and the participants with consensus (as Spanner does), not to add a third phase. Weak answers confuse 2PC with 2PL, or claim that participants can time out and abort after voting YES.</p>`,
        },
        {
          type: "quiz",
          q: "A participant voted YES and then lost contact with the coordinator. Ten minutes later it still hasn't heard the decision. What may it safely do under 2PC?",
          options: [
            "Abort after a timeout, releasing its locks",
            "Commit, since it voted YES",
            "Keep waiting, holding its locks, until it learns the decision",
            "Release its locks but keep the changes pending",
          ],
          answer: 2,
          explain: "By voting YES it promised to commit if told to, so aborting on a timeout (A) could contradict a COMMIT that other participants have already applied. Committing (B) is just as unsafe: another participant may have voted NO, in which case the decision was ABORT. Releasing locks (D) would let other transactions read or overwrite data whose fate is unknown. Timeouts are fine before voting, never after: that is 2PC's blocking problem.",
        },
      ],
    },
    // ───────────────────────────────────────────────────────────── 8
    {
      id: "distributed-transactions-in-practice",
      title: "Why distributed transactions got a bad name",
      kicker: "Reality check",
      concepts: ["xa-transactions", "heuristic-decisions", "coordinator-failure-in-2pc"],
      blocks: [
        {
          type: "problem",
          html: `<p>On paper, 2PC gives you atomicity across any mix of systems: two databases from different vendors, a database and a message queue, three services at once. In production, many teams found the price too high. Every distributed commit adds forced disk writes and network round trips; the book cites a report that distributed transactions in MySQL were more than ten times slower than single-node ones. Worse, one crashed application server could leave rows locked in a database it didn't own until a human stepped in. Several cloud services decided not to offer distributed transactions at all.</p>
<p>The bad reputation is partly deserved and partly a mix-up between two very different things that share a name. To use distributed transactions wisely, you need to know which kind you have, and where its coordinator actually lives.</p>`,
        },
        {
          type: "compare",
          title: "Two kinds of distributed transaction",
          items: [
            {
              title: "Database-internal",
              tone: "ok",
              html: "<p>Every participant runs the same software: the nodes of one distributed database, such as VoltDB, MySQL Cluster's NDB engine, or a modern distributed SQL system. The vendor controls both ends of the protocol, so it can replicate the coordinator, use optimized commit protocols and detect deadlocks across nodes. These can work quite well.</p>",
            },
            {
              title: "Heterogeneous",
              tone: "warn",
              html: "<p>Participants are different technologies: two databases from different vendors, or a database plus a message broker. They can only meet on a lowest-common-denominator protocol (XA), usually with the coordinator inside your application. You get atomicity across systems; the price is fragility.</p>",
            },
          ],
        },
        {
          type: "text",
          html: `<h3>The tempting use case: exactly-once message processing</h3>
<p>Heterogeneous transactions make something genuinely useful possible. Suppose a worker takes a message from a queue and writes the result to a database. If acknowledging the message and writing to the database commit in the same distributed transaction, either both happen or neither does. When anything fails, both abort, the broker redelivers the message, and the work is redone from scratch with no trace of the failed attempt. The message is effectively processed <strong>exactly once</strong>, even if it was attempted several times.</p>
<p>The catch: this works only if every system the processing touches speaks the same atomic commit protocol. If handling the message also sends an email, and the mail server doesn't take part in 2PC, a retry may send the email twice; you can't roll back a message that has already landed in someone's inbox. Chapters 11 and 12 show alternatives that avoid distributed transactions altogether, built on logs and idempotent operations.</p>
<h3>XA, and where the coordinator lives</h3>
<p><strong>XA</strong> (X/Open eXtended Architecture), standardized in 1991, is the standard for 2PC across heterogeneous systems. Support is broad: PostgreSQL, MySQL, DB2, SQL Server and Oracle among databases, and brokers such as ActiveMQ, HornetQ, MSMQ and IBM MQ. Despite being a standard, XA defines no wire format: it is a C-level programming interface between the application, the transaction coordinator and each resource, with bindings for other languages; in Java it appears as JTA, with JDBC and JMS drivers implementing the XA side.</p>
<p>In practice the coordinator is usually a <strong>library inside the application process</strong>. It tracks the participants, collects their votes and logs its decisions to the application server's local disk. That has an uncomfortable consequence. If the application process crashes or its machine dies, the coordinator goes with it, and every participant that voted YES is stuck in doubt. The database servers can't reach the coordinator on their own, since all communication goes through the application's driver connections.</p>
<p>While in doubt, participants keep their <strong>locks</strong>. A database typically holds exclusive row-level locks on every row the transaction modified, and under serializable two-phase locking also shared locks on every row it read, until the outcome is known. If the coordinator takes 20 minutes to restart, the locks are held for 20 minutes. If its log is lost, they're held forever, or until someone intervenes by hand. Meanwhile every other transaction that needs those rows waits, so one dead process can make large parts of an application unavailable.</p>`,
        },
        {
          type: "diagram",
          title: "How one dead process freezes rows it doesn't own",
          svg: `<svg viewBox="0 0 640 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="An application server whose embedded XA coordinator crashed; a database row and a message held in prepared state; three other transactions queue waiting for the locked row">
<defs><marker id="ch9d2-xa-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker></defs>
<rect x="8" y="40" width="170" height="150" rx="10" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="93" y="62" text-anchor="middle" font-size="13" font-weight="700">App server</text>
<rect x="22" y="76" width="142" height="66" rx="8" stroke-dasharray="5 4" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<path d="M30,82 L156,136 M156,82 L30,136" stroke-width="2.5" style="fill: none; stroke: var(--viz-bad); stroke-opacity: 0.75"/>
<text x="93" y="104" text-anchor="middle" font-size="12" font-weight="700" class="viz-halo">XA coordinator</text>
<text x="93" y="124" text-anchor="middle" font-size="12" class="viz-halo">log on local disk</text>
<text x="93" y="172" text-anchor="middle" font-size="12" font-weight="700" style="fill: var(--viz-bad)">process crashed</text>
<path d="M164,98 L232,64" stroke-width="1.5" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-muted)"/>
<path d="M164,122 L232,170" stroke-width="1.5" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-muted)"/>
<rect x="232" y="14" width="190" height="98" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-c2)"/>
<text x="327" y="34" text-anchor="middle" font-size="13" font-weight="700">Database</text>
<rect x="244" y="46" width="166" height="54" rx="6" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="327" y="67" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">row acct#7</text>
<text x="327" y="88" text-anchor="middle" font-size="12">PREPARED · locked 20 min</text>
<rect x="232" y="128" width="190" height="86" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-c2)"/>
<text x="327" y="148" text-anchor="middle" font-size="13" font-weight="700">Message broker</text>
<rect x="244" y="160" width="166" height="40" rx="6" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="327" y="185" text-anchor="middle" font-size="12">PREPARED · message held</text>
<rect x="462" y="14" width="170" height="44" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="547" y="32" text-anchor="middle" font-size="12" font-weight="700">checkout</text>
<text x="547" y="50" text-anchor="middle" font-size="12" style="fill: var(--viz-bad)">waiting for acct#7</text>
<rect x="462" y="68" width="170" height="44" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="547" y="86" text-anchor="middle" font-size="12" font-weight="700">refund</text>
<text x="547" y="104" text-anchor="middle" font-size="12" style="fill: var(--viz-bad)">waiting for acct#7</text>
<rect x="462" y="122" width="170" height="44" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="547" y="140" text-anchor="middle" font-size="12" font-weight="700">balance check</text>
<text x="547" y="158" text-anchor="middle" font-size="12" style="fill: var(--viz-bad)">waiting for acct#7</text>
<path d="M462,36 L425,62" stroke-width="1.6" style="fill: none; stroke: var(--viz-bad)" marker-end="url(#ch9d2-xa-bad)"/>
<path d="M462,90 L425,73" stroke-width="1.6" style="fill: none; stroke: var(--viz-bad)" marker-end="url(#ch9d2-xa-bad)"/>
<path d="M462,144 L425,84" stroke-width="1.6" style="fill: none; stroke: var(--viz-bad)" marker-end="url(#ch9d2-xa-bad)"/>
<text x="547" y="190" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">…and the queue keeps growing</text>
</svg>`,
          caption: "The application server crashed after its participants voted YES. The database and the broker must keep the transaction prepared, so every other transaction that touches acct#7 queues behind a lock that nothing can release automatically. One dead application process has frozen rows in systems it doesn't own.",
        },
        {
          type: "callout",
          tone: "warning",
          title: "Orphans and heuristic decisions",
          html: `<p>Sometimes the coordinator can never work out the outcome: its log was lost or corrupted, or a bug left a transaction unaccounted for. These <strong>orphaned</strong> in-doubt transactions never resolve on their own, and restarting the database doesn't help. A correct 2PC participant must keep prepared transactions, and their locks, across restarts; otherwise it would break its promise. The only fix is an administrator inspecting each participant and committing or rolling back by hand, typically in the middle of an outage.</p>
<p>Many XA implementations offer an emergency hatch called a <strong>heuristic decision</strong>: a participant decides on its own to commit or abort without hearing from the coordinator. The book calls "heuristic" a euphemism for <em>probably breaking atomicity</em>: the decision may contradict what the other participants did. It exists for getting out of catastrophes, not for everyday use. The heuristic-abort button in the previous section's visualization shows exactly what goes wrong.</p>`,
        },
        {
          type: "idea",
          html: `<p>Distributed transactions <strong>inside one database system</strong> can be made fast and fault tolerant, because the vendor controls every piece. <strong>Heterogeneous</strong> XA transactions tie your availability to a coordinator that is often unreplicated, and they hold locks while in doubt, so any one broken piece blocks or fails the whole.</p>`,
        },
        {
          type: "tradeoffs",
          title: "Heterogeneous distributed transactions (XA)",
          prosLabel: "What you get",
          consLabel: "What it costs",
          pros: [
            "Atomic commit across systems that otherwise know nothing about each other: databases from different vendors, or a database plus a message broker.",
            "Exactly-once message processing, provided every side effect takes part in the transaction.",
            "Simple application code: the transaction manager handles prepare, commit and crash recovery.",
          ],
          cons: [
            "The coordinator is itself a kind of database whose log must be durable and replicated, yet many coordinators aren't highly available by default or replicate only in a rudimentary way. It becomes a single point of failure.",
            "An application server that holds coordinator logs is no longer stateless, so you can't freely add, remove or replace servers.",
            "XA can't detect deadlocks across systems or provide serializable snapshot isolation across them; either would need a standard way to exchange lock or conflict information. (Database-internal transactions don't share this limit: distributed SSI is possible.)",
            "2PC needs every participant to respond, so a failure anywhere blocks or fails the whole transaction. It amplifies failures instead of tolerating them.",
            "Extra forced disk writes and network round trips on every commit, and locks held for the whole in-doubt window.",
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "How systems avoid the trap today",
          html: `<p><strong>Make the coordinator and participants fault tolerant.</strong> Spanner-style databases still run 2PC between shards, but each shard and the coordinator are Paxos or Raft groups, so a single machine failure no longer leaves anyone in doubt. CockroachDB's <em>parallel commits</em> protocol (2019) goes further: in the common case it acknowledges a distributed commit after roughly one round of consensus writes instead of two sequential rounds.</p>
<p><strong>Avoid cross-service transactions entirely.</strong> Microservice architectures rarely use XA. Instead they use <em>sagas</em>, a sequence of local transactions in which each step has a compensating action that semantically undoes it, often combined with a <em>transactional outbox</em>: a service writes its state change and the event announcing it in the same local transaction, and a separate process publishes the event. You give up isolation between steps (others can observe the intermediate states) in exchange for independence from any shared coordinator.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "PostgreSQL",
              tag: "docs warning",
              html: "Its documentation warns that prepared transactions left open keep holding their locks and stop VACUUM from reclaiming dead rows, which in extreme cases can force the database to shut down to prevent transaction ID wraparound. It advises against using <code>PREPARE TRANSACTION</code> unless you're writing a transaction manager.",
            },
            {
              org: "Java EE / Jakarta Transactions",
              tag: "JTA",
              html: "Application servers embed the XA transaction manager (for example Narayana in JBoss and WildFly), so the coordinator's log lives on the application server's disk. Losing that server mid-commit leaves database and message-broker participants in doubt.",
            },
            {
              org: "Sagas (Garcia-Molina and Salem)",
              year: "1987",
              html: "The saga pattern splits a long-lived transaction into local transactions, each paired with a compensating transaction. Outcomes are all-or-compensated, with no distributed locks but also no isolation between steps. It's the usual replacement for XA in microservice architectures.",
            },
            {
              org: "CockroachDB",
              year: "2019",
              html: "Introduced parallel commits so that, in the common case, a distributed transaction's commit can be acknowledged after a single round of consensus writes rather than two sequential rounds.",
            },
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>A typical probe: "How do you keep the database and the message queue consistent?" Proposing XA with no caveats is a red flag. A strong answer names the failure mode (the coordinator inside the app server dies, participants stay in doubt, locks pile up) and then offers alternatives: a transactional outbox published by a relay or change data capture, idempotent consumers so redelivery is harmless, and sagas with compensating actions for multi-service workflows. If the interviewer insists on atomic commit across shards, point to database-internal transactions over consensus groups, as in Spanner or CockroachDB.</p>`,
        },
        {
          type: "quiz",
          q: "Why can an orphaned in-doubt XA transaction survive a database restart?",
          options: [
            "A database bug forgets to release locks during shutdown",
            "XA keeps prepared transactions only in memory, so the restart can't see them to clean them up",
            "Restarts automatically commit prepared transactions, which re-acquires their locks",
            "A prepared participant must keep the transaction and its locks across crashes, or it would break its promise to commit",
          ],
          answer: 3,
          explain: "Preparing means \"I can commit under all circumstances, including a crash\", so the prepared state and its locks are written durably and restored on restart. Option B gets this backwards: the prepared state is on disk precisely so that it survives. Option C would be as dangerous as aborting, since the coordinator may have decided ABORT. Only the coordinator's decision, or a human's heuristic decision, ends the transaction.",
        },
      ],
    },
    // ───────────────────────────────────────────────────────────── 9
    {
      id: "consensus",
      title: "Consensus: agreeing despite failures, with epochs and majorities",
      kicker: "The core primitive",
      concepts: ["consensus", "flp-impossibility", "raft-paxos-zab", "leader-election", "epoch-numbering", "consensus-equivalence"],
      blocks: [
        {
          type: "problem",
          html: `<p>Two-phase commit agrees on an outcome only because one coordinator dictates it, so when the coordinator dies, everyone waits. Single-leader replication has the same weakness. When the leader fails, either a human picks a new one, or the nodes pick one automatically, and getting every node to agree on the new leader is itself an agreement problem. It's chicken and egg: you'd need a leader to coordinate the election of a leader.</p>
<p>Get it wrong and you have <strong>split brain</strong>: two nodes both believe they're the leader, both accept writes, and the data diverges into two histories, much like the GitHub outage at the start of this chapter. We need a way for a group of nodes to decide something once and for all, as long as most of them are alive and can talk to each other, without trusting any single node.</p>`,
        },
        {
          type: "text",
          html: `<h3>What "consensus" means, precisely</h3>
<p>In the formal version of the problem, one or more nodes <em>propose</em> values, and the algorithm <em>decides</em> on one of them. For a username, each node proposes the user whose request it received, and the decision is who gets the name. An algorithm solves consensus if it guarantees four properties:</p>
<ul>
<li><strong>Uniform agreement:</strong> no two nodes decide differently.</li>
<li><strong>Integrity:</strong> no node decides twice.</li>
<li><strong>Validity:</strong> if a node decides value <em>v</em>, then <em>v</em> was proposed by some node.</li>
<li><strong>Termination:</strong> every node that doesn't crash eventually decides some value.</li>
</ul>
<p>Agreement and integrity are the heart of it: everyone decides the same thing, and nobody changes their mind later. Validity rules out cheap tricks, such as an algorithm that always decides <code>null</code>. Termination is what makes the problem hard. Without it, you could hard-code one node as a dictator that decides everything. That satisfies the first three properties, and it's exactly what 2PC does, but if the dictator fails, nobody ever decides. Termination demands progress even when some nodes fail, which is to say fault tolerance.</p>`,
        },
        {
          type: "keypoints",
          title: "What consensus algorithms assume and promise",
          items: [
            "Termination is a <strong>liveness</strong> property; agreement, integrity and validity are <strong>safety</strong> properties (Chapter 8).",
            "Progress needs a <strong>majority</strong>: fewer than half the nodes may be crashed or unreachable. Three nodes tolerate one failure; five tolerate two.",
            "Safety holds even if a majority fails or the network partitions: the system stops deciding, but it never decides wrongly.",
            "Most algorithms assume crash faults, not Byzantine ones. Tolerating nodes that lie requires more than two-thirds of the nodes to be honest (Chapter 8).",
          ],
        },
        {
          type: "callout",
          tone: "history",
          title: "FLP: an impossibility result that doesn't stop anyone",
          html: `<p>In 1985, Fischer, Lynch and Paterson proved that in the <strong>asynchronous</strong> model, with no clocks and no timeouts, no deterministic algorithm can always reach consensus if even one node may crash. That sounds fatal, but it depends on the algorithm being unable to use timeouts. Real systems use timeouts to suspect crashed nodes (a partially synchronous model), and randomized algorithms such as Ben-Or's (1983) offer a different escape. The practical result is the shape of every real algorithm: it is <em>always</em> safe, and it makes progress whenever the network behaves well enough for long enough.</p>`,
        },
        {
          type: "text",
          html: `<p>Consensus deserves this much attention because so many problems turn out to be the same problem in disguise. A linearizable compare-and-set register lets nodes agree on one value. Total order broadcast is agreement on what goes in each slot of a log, as the previous section showed. Atomic commit is agreement on commit or abort, with the extra rule that a single NO forces abort. Locks, leases, membership lists and uniqueness constraints all need one contender to win a race and everyone else to accept the result.</p>`,
        },
        {
          type: "diagram",
          title: "Problems equivalent to consensus",
          svg: `<svg viewBox="0 0 640 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Consensus in the centre, connected by double-headed arrows to linearizable compare-and-set, total order broadcast, atomic commit, locks and leases, membership and coordination, and uniqueness constraints">
<defs><marker id="ch9d2-eq-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker></defs>
<path d="M214,40 L277,94" stroke-width="1.8" style="fill: none; stroke: var(--viz-c1)" marker-start="url(#ch9d2-eq-arr)" marker-end="url(#ch9d2-eq-arr)"/>
<path d="M214,130 L264,130" stroke-width="1.8" style="fill: none; stroke: var(--viz-c1)" marker-start="url(#ch9d2-eq-arr)" marker-end="url(#ch9d2-eq-arr)"/>
<path d="M214,220 L277,166" stroke-width="1.8" style="fill: none; stroke: var(--viz-c1)" marker-start="url(#ch9d2-eq-arr)" marker-end="url(#ch9d2-eq-arr)"/>
<path d="M426,40 L363,94" stroke-width="1.8" style="fill: none; stroke: var(--viz-c1)" marker-start="url(#ch9d2-eq-arr)" marker-end="url(#ch9d2-eq-arr)"/>
<path d="M426,130 L376,130" stroke-width="1.8" style="fill: none; stroke: var(--viz-c1)" marker-start="url(#ch9d2-eq-arr)" marker-end="url(#ch9d2-eq-arr)"/>
<path d="M426,220 L363,166" stroke-width="1.8" style="fill: none; stroke: var(--viz-c1)" marker-start="url(#ch9d2-eq-arr)" marker-end="url(#ch9d2-eq-arr)"/>
<circle cx="320" cy="130" r="54" stroke-width="2.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="320" y="135" text-anchor="middle" font-size="15" font-weight="700">Consensus</text>
<text x="320" y="203" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">each arrow:</text>
<text x="320" y="219" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">reducible both ways</text>
<rect x="12" y="18" width="202" height="44" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-node-stroke)"/>
<text x="113" y="44" text-anchor="middle" font-size="12" font-weight="600">Linearizable compare-and-set</text>
<rect x="12" y="108" width="202" height="44" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-node-stroke)"/>
<text x="113" y="134" text-anchor="middle" font-size="12" font-weight="600">Atomic commit</text>
<rect x="12" y="198" width="202" height="44" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-node-stroke)"/>
<text x="113" y="224" text-anchor="middle" font-size="12" font-weight="600">Membership / coordination</text>
<rect x="426" y="18" width="202" height="44" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-node-stroke)"/>
<text x="527" y="44" text-anchor="middle" font-size="12" font-weight="600">Total order broadcast</text>
<rect x="426" y="108" width="202" height="44" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-node-stroke)"/>
<text x="527" y="134" text-anchor="middle" font-size="12" font-weight="600">Locks and leases</text>
<rect x="426" y="198" width="202" height="44" rx="8" style="fill: var(--viz-panel); stroke: var(--viz-node-stroke)"/>
<text x="527" y="224" text-anchor="middle" font-size="12" font-weight="600">Uniqueness constraints</text>
</svg>`,
          caption: "Given a fault-tolerant solution to any one of these, you can build the others. If you can solve one, you can solve them all; if you can't afford consensus, you can't have any of them in a fault-tolerant form.",
        },
        {
          type: "idea",
          html: `<p>Fault-tolerant consensus algorithms elect a leader for each numbered <strong>epoch</strong> and require every decision to be accepted by a <strong>majority</strong>. Because any two majorities overlap, a newer epoch always discovers what an older one decided, so decisions are never contradicted.</p>`,
        },
        {
          type: "text",
          html: `<h3>Four algorithms, one design</h3>
<p>The best-known fault-tolerant consensus algorithms are Viewstamped Replication (Oki and Liskov, 1988), Paxos (Lamport; written around 1989–90, published 1998), Zab (built for ZooKeeper in the late 2000s, described in a 2011 paper) and Raft (Ongaro and Ousterhout, 2014, designed to be understandable). Rather than agreeing on one value at a time, they decide a <em>sequence</em> of values, implementing total order broadcast directly, which is far more efficient.</p>
<p><strong>Epochs.</strong> Each algorithm numbers its periods of leadership: a <strong>ballot number</strong> in Paxos, a <strong>view number</strong> in Viewstamped Replication, a <strong>term</strong> in Raft, an <strong>epoch</strong> in Zab. Each epoch has at most one leader. When nodes suspect the leader is dead (a timeout expires), they vote for a new leader with a higher epoch number, and if two leaders conflict, the higher epoch wins.</p>
<p><strong>Two rounds of majority voting.</strong> A leader can't trust itself, since it might be a zombie from an old epoch, cut off by a partition. So decisions take two votes:</p>
<ol>
<li><strong>Elect:</strong> a candidate becomes leader of epoch <em>e</em> only when a majority votes for it.</li>
<li><strong>Propose:</strong> for each value, the leader sends its proposal, and a node accepts only if it knows of no leader with an epoch higher than <em>e</em>. The value is decided once a majority accepts.</li>
</ol>
<p>Safety comes from overlap: any two majorities share at least one node. If a majority accepted the epoch-5 leader's proposal and none of them had heard of epoch 6, no epoch-6 leader can exist yet, because its electing majority would include one of them. Conversely, any newer leader's voters overlap every majority that accepted an earlier value, so the new leader can learn what was decided.</p>`,
        },
        {
          type: "diagram",
          title: "Any two majorities overlap",
          svg: `<svg viewBox="0 0 400 240" xmlns="http://www.w3.org/2000/svg" style="max-width: 460px; margin: 0 auto" role="img" aria-label="Five nodes in a ring; nodes 1, 2 and 3 form one majority, nodes 3, 4 and 5 another; node 3 belongs to both">
<path d="M200,50 L274,104 L246,191" stroke-width="50" stroke-linecap="round" stroke-linejoin="round" style="fill: none; stroke: var(--viz-c1); stroke-opacity: 0.22"/>
<path d="M246,191 L154,191 L126,104" stroke-width="50" stroke-linecap="round" stroke-linejoin="round" style="fill: none; stroke: var(--viz-c2); stroke-opacity: 0.22"/>
<circle cx="200" cy="50" r="18" stroke-width="2" style="fill: var(--viz-node); stroke: var(--viz-c1)"/>
<circle cx="274" cy="104" r="18" stroke-width="2" style="fill: var(--viz-node); stroke: var(--viz-c1)"/>
<circle cx="246" cy="191" r="18" stroke-width="3.5" style="fill: var(--viz-node); stroke: var(--viz-ok)"/>
<circle cx="154" cy="191" r="18" stroke-width="2" style="fill: var(--viz-node); stroke: var(--viz-c2)"/>
<circle cx="126" cy="104" r="18" stroke-width="2" style="fill: var(--viz-node); stroke: var(--viz-c2)"/>
<text x="200" y="55" text-anchor="middle" font-size="13" font-weight="700">1</text>
<text x="274" y="109" text-anchor="middle" font-size="13" font-weight="700">2</text>
<text x="246" y="196" text-anchor="middle" font-size="13" font-weight="700">3</text>
<text x="154" y="196" text-anchor="middle" font-size="13" font-weight="700">4</text>
<text x="126" y="109" text-anchor="middle" font-size="13" font-weight="700">5</text>
<text x="8" y="24" font-size="12" style="fill: var(--viz-muted)">5 nodes, majority = 3</text>
<text x="214" y="24" font-size="12" style="fill: var(--viz-c1)">voted for the term-5 leader</text>
<text x="8" y="150" font-size="12" style="fill: var(--viz-c2)">an old leader's</text>
<text x="8" y="166" font-size="12" style="fill: var(--viz-c2)">would-be quorum</text>
<text x="274" y="196" font-size="12" font-weight="600" style="fill: var(--viz-ok)">knows about term 5</text>
</svg>`,
          caption: "Nodes 1, 2 and 3 elected the term-5 leader. Any majority that an older leader gathers for a proposal, such as {3, 4, 5}, must include at least one of them, and node 3 knows about term 5, so it refuses. A newer epoch can't go unnoticed, and a decided value can't be forgotten.",
        },
        {
          type: "text",
          html: `<h3>The same idea in Paxos vocabulary</h3>
<ul>
<li><strong>Phase 1, prepare / promise.</strong> A proposer sends <code>prepare(n)</code> with a ballot number <em>n</em>. Each acceptor that hasn't seen a higher ballot promises to ignore lower ones, and reports the highest-numbered proposal it has already accepted, if any.</li>
<li><strong>Phase 2, accept / accepted.</strong> With promises from a majority, the proposer sends <code>accept(n, v)</code>, where <em>v</em> <strong>must</strong> be the value of the highest-numbered accepted proposal reported in those promises; only if none was reported may it propose its own value. A value is <strong>chosen</strong> once a majority accepts it in the same ballot.</li>
</ul>
<p>That rule, not the ballot number alone, preserves agreement. A value that might already be chosen was accepted by a majority, and any majority of promises intersects it, so the new proposer carries the value forward instead of overwriting it. <strong>Multi-Paxos</strong> keeps a stable leader that runs phase 1 once and then skips it for later log slots, so each value costs one round trip, the same shape as Raft's <code>AppendEntries</code>. Raft folds "adopt the highest accepted value" into its elections instead, so whoever wins already holds every committed entry.</p>
<h3>Raft in five rules</h3>
<p>The simulation below runs a simplified five-server Raft cluster with these rules:</p>
<ul>
<li><strong>Randomized election timeouts</strong> make split votes (several candidates dividing the votes so that nobody wins) rare.</li>
<li><strong>One vote per term</strong>, persisted to disk, so a restarted server can't vote twice.</li>
<li><strong>The election restriction:</strong> a server votes only for a candidate whose log is at least as up to date as its own (a higher last term, or the same last term and at least as long).</li>
<li><strong>Commitment:</strong> an entry is committed once the current leader has stored it on a majority. A leader counts replicas only for entries from its own term; older entries commit along with them.</li>
<li><strong>Overwriting:</strong> when a new leader's log disagrees with a follower's, the follower's conflicting entries are overwritten, including a deposed leader's uncommitted ones. That's safe: an uncommitted entry was never acknowledged, so no client was told it succeeded.</li>
</ul>`,
        },
        {
          type: "viz",
          id: "ch9/raft-consensus",
          title: "Raft: terms, votes and majorities",
          caption: "Try Isolate leader, wait until the other four elect a new leader, press Client write a couple of times (each side's client writes to its own leader), then set the network back to Healthy. Notice that the old leader's new entries stay amber (uncommitted) while the majority side's leader, in a higher term, keeps committing, and that on healing the stale entries flash red and are replaced. Then tap three servers to crash them and watch progress stop; tap them again to restart. Simplifications: followers copy the leader's whole log instead of Raft's prefix matching, and there's no PreVote or CheckQuorum, so an isolated leader believes it leads until it hears a higher term (etcd enables both, so leaders step down sooner and rejoining nodes don't force needless elections).",
        },
        {
          type: "text",
          html: `<p>Three lessons carry over to every consensus system. A minority can't commit, however confident its leader is; it can only append entries that will later be discarded. A committed entry is never lost: any future leader needs votes from a majority that includes a server holding it, and the election restriction stops that server from voting for a candidate that lacks it. And without a majority, Raft stops: it gives up availability to stay safe, exactly the trade-off CAP describes in the section on the price of one copy.</p>
<p>Also, <strong>committed is not the same as applied</strong>, and a client whose request timed out can't conclude that its write failed: the entry may have been committed just before the leader crashed, and the new leader will carry it forward. That's why clients retry with request IDs that let the system detect duplicates.</p>
<p>Real Raft doesn't ship whole logs as the simulation does. Each <code>AppendEntries</code> carries the index and term of the entry just before the new ones, and a follower accepts only if its own log matches at that point. On a mismatch the leader steps back one entry at a time (or faster, with hints) until they agree, then overwrites the follower's conflicting suffix. Because every accepted append matched the entry before it, two logs that agree on one entry's index and term agree on everything before it, which is why Raft logs never have holes.</p>`,
        },
        {
          type: "compare",
          title: "Two-phase commit vs consensus",
          items: [
            {
              title: "Two-phase commit",
              tone: "warn",
              html: "<ul><li>The coordinator is fixed in advance (typically the transaction manager in the application), not elected.</li><li>Every participant must vote YES; one NO aborts, one silent node blocks.</li><li>If the coordinator dies after the votes, participants wait in doubt until it recovers.</li><li>Purpose: atomic commit of one transaction across different pieces of data.</li></ul>",
            },
            {
              title: "Consensus (Raft, Paxos, Zab)",
              tone: "ok",
              html: "<ul><li>The leader is elected, and replaced in a higher epoch if it fails.</li><li>A majority is enough; a minority of slow or dead nodes doesn't block progress.</li><li>A recovery procedure brings nodes back into a consistent state after a new leader takes over.</li><li>Purpose: agreement on a value, or a sequence of values, among replicas.</li></ul>",
            },
          ],
        },
        {
          type: "text",
          html: `<h3>What consensus costs</h3>
<ul>
<li><strong>Synchronous replication.</strong> Every decision waits for a vote. Many databases replicate asynchronously for speed and accept that a failover may lose recent writes; consensus refuses that trade.</li>
<li><strong>A strict majority.</strong> Surviving one failure takes three nodes, surviving two takes five, and the minority side of a partition is blocked.</li>
<li><strong>Mostly fixed membership.</strong> Most algorithms assume a fixed set of voters; changing it is possible but much harder to get right.</li>
<li><strong>Timeout sensitivity.</strong> With highly variable network delay, especially across regions, nodes wrongly suspect a healthy leader, and needless elections stall progress.</li>
<li><strong>Bad links.</strong> Raft is known to struggle with one persistently unreliable link: leadership can bounce between two nodes, or the leader keeps being forced out, and little progress is made.</li>
</ul>
<p><strong>Leader election in practice.</strong> The leader is simply the node elected for the current epoch, and the epoch number doubles as a <a href="#/ch8/learn/fencing-tokens">fencing token</a> (Chapter 8) that storage can use to reject a deposed leader. When a leader fails you can wait for it to return (what an XA coordinator does, giving up termination), fail over by hand, or elect a successor through consensus. Only the last stays available without a human in the loop.</p>
<p><strong>Not every system needs it.</strong> Leaderless and multi-leader databases (Chapter 5) deliberately run without global consensus. The write conflicts they have to detect and merge are the direct price of that choice, and for many applications, living with branching version histories is cheaper than a majority round trip on every write.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Google Chubby",
              year: "2006",
              html: "Google's lock service replicates its state with Paxos, typically across five replicas. The companion paper \"Paxos Made Live\" (2007) describes how much engineering went beyond the published algorithm: handling disk corruption, master leases, group membership changes and extensive testing.",
            },
            {
              org: "Raft everywhere",
              tag: "since 2014",
              html: "etcd, Consul, CockroachDB, TiKV, YugabyteDB, Redpanda and Kafka's KRaft controller all use Raft. CockroachDB and TiKV run a separate Raft group for each range of data (\"multi-Raft\"), so one cluster runs many independent consensus groups.",
            },
            {
              org: "Amazon DynamoDB",
              year: "2022",
              html: "The USENIX ATC 2022 paper describes each partition as a replication group of storage replicas spread across availability zones, using Multi-Paxos to elect a leader. Only the leader serves writes and strongly consistent reads.",
            },
            {
              org: "Cloudflare",
              year: "2020",
              tag: "incident",
              html: "The \"one bad link\" case above is what hit Cloudflare in November 2020: a partially failed switch left one etcd node able to reach only one of its two peers, and the cluster kept re-electing instead of making progress (<a href=\"#/ch8/learn/truth-by-majority\">full story in Chapter 8</a>).",
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Raft won, and grew some extensions",
          html: `<p>Since the Raft paper appeared in 2014, Raft has effectively become the default consensus algorithm for new systems, largely because it was designed to be understandable and spells out practical details, such as membership changes and log compaction, that classic Paxos descriptions leave open. Two extensions from Ongaro's PhD thesis matter in production and are implemented in etcd: <strong>PreVote</strong>, in which a would-be candidate first checks that it could win before incrementing its term, so a node rejoining after a partition doesn't depose a healthy leader; and <strong>CheckQuorum</strong>, in which a leader steps down if it hasn't heard from a majority recently. On the theory side, <strong>Flexible Paxos</strong> (2016) showed that only the election quorum and the replication quorum need to intersect, not every pair of quorums, which allows designs with smaller replication quorums.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Expect "How does Raft (or Paxos) avoid split brain?" and "Why an odd number of nodes?". A strong answer: each term has at most one leader, because a node votes once per term and any two majorities overlap; a leader commits only what a majority has stored; a deposed leader can't commit because it can't reach a majority, and its old term number lets storage fence it off. On odd numbers: four nodes tolerate one failure, the same as three, while needing a larger quorum, so the fourth node adds cost without adding fault tolerance. On Paxos versus Raft: they share the same core (epochs plus overlapping quorums) and differ mainly in how a leader is elected and how its log is brought up to date.</p>`,
        },
        {
          type: "quiz",
          q: "A 5-node Raft cluster is split 2 | 3, with the current leader on the 2-node side. Which statement is true?",
          options: [
            "Both sides can commit writes until the partition heals; then the higher term's writes win",
            "Neither side can commit until the partition heals, because the current leader is cut off from the majority",
            "The 3-node side can commit only after an operator revokes the old leader's lease",
            "The old leader can append writes but never commit them; the 3-node side elects a higher-term leader and commits",
          ],
          answer: 3,
          explain: "Committing needs 3 of 5 servers. The old leader can reach only 2, so its new entries stay uncommitted and its clients never get a success response; option A describes exactly the split brain Raft prevents. Option B is too pessimistic: the 3-node side has a majority, so after an election timeout it elects a leader in a higher term and makes progress, with no operator needed (C). On healing, the old leader sees the higher term, steps down, and its uncommitted entries are overwritten.",
        },
      ],
    },
    // ───────────────────────────────────────────────────────────── 10
    {
      id: "coordination-services",
      title: "ZooKeeper and etcd: consensus you don't have to write",
      kicker: "In practice",
      concepts: ["membership-coordination-services", "leader-election"],
      blocks: [
        {
          type: "problem",
          html: `<p>Every distributed system needs trustworthy answers to a handful of questions. Which node is the leader? Which node owns partition 7? Which nodes are alive? What is the current configuration? Each one is a consensus problem in disguise, and consensus is notoriously hard to implement correctly: Google's "Paxos Made Live" paper describes how much engineering it took, beyond the published algorithm, to run Paxos in production. If every database, scheduler and message broker embedded its own implementation, each would get the edge cases wrong in its own way.</p>
<p>There's a scale problem too. A system with 2,000 application servers can't run consensus among all of them: every decision would need votes from 1,001 machines, and with that many machines, some are always slow or failing.</p>`,
        },
        {
          type: "idea",
          html: `<p>Outsource coordination to a small consensus-replicated store, usually 3 or 5 nodes, that offers linearizable compare-and-set, totally ordered operations, session-based failure detection and change notifications. Thousands of clients then build leader election, locks and membership on top of those primitives without running consensus themselves.</p>`,
        },
        {
          type: "text",
          html: `<p>ZooKeeper, etcd and Consul are usually described as distributed key-value stores, or as coordination and configuration services. Their API looks like a small database: you read and write values by key and can list keys under a prefix. Under the hood, every server holds a full copy of a deliberately small data set (ZooKeeper keeps it all in memory, etcd in a memory-mapped file, both persisted to disk), and every write is replicated to every server through fault-tolerant total order broadcast: Zab for ZooKeeper, Raft for etcd and Consul. Consensus runs among a fixed set of 3 or 5 voting servers, while thousands of clients use the service through it. In effect, the clients <strong>outsource</strong> consensus, ordering and failure detection to it.</p>`,
        },
        {
          type: "diagram",
          title: "A ZooKeeper ensemble and its clients",
          svg: `<svg viewBox="0 0 640 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Six clients hold sessions with a five-server ZooKeeper ensemble (one leader, four followers) plus a non-voting observer; a znode tree shows ephemeral sequential election nodes and a configuration entry">
<defs><marker id="ch9d2-zk-mu" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<path d="M112,27 L213,85" stroke-width="1.2" style="fill: none; stroke: var(--viz-line)"/>
<path d="M112,63 L211,90" stroke-width="1.2" style="fill: none; stroke: var(--viz-line)"/>
<path d="M112,99 L210,96" stroke-width="1.2" style="fill: none; stroke: var(--viz-line)"/>
<path d="M112,135 L230,154" stroke-width="1.2" style="fill: none; stroke: var(--viz-line)"/>
<path d="M112,171 L230,159" stroke-width="1.2" style="fill: none; stroke: var(--viz-line)"/>
<path d="M112,207 L231,164" stroke-width="1.2" style="fill: none; stroke: var(--viz-line)"/>
<rect x="8" y="14" width="104" height="26" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="60" y="32" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">scheduler-1</text>
<rect x="8" y="50" width="104" height="26" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="60" y="68" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">scheduler-2</text>
<rect x="8" y="86" width="104" height="26" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="60" y="104" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">worker-a</text>
<rect x="8" y="122" width="104" height="26" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="60" y="140" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">worker-b</text>
<rect x="8" y="158" width="104" height="26" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="60" y="176" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">worker-c</text>
<rect x="8" y="194" width="104" height="26" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="60" y="212" text-anchor="middle" font-size="12" style="font-family: var(--font-mono)">api-7</text>
<text x="8" y="246" font-size="12" style="fill: var(--viz-muted)">sessions + heartbeats</text>
<circle cx="282" cy="112" r="56" stroke-dasharray="3 4" style="fill: none; stroke: var(--viz-line)"/>
<circle cx="282" cy="56" r="19" stroke-width="2.5" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<circle cx="335" cy="95" r="19" stroke-width="2" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<circle cx="315" cy="157" r="19" stroke-width="2" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<circle cx="249" cy="157" r="19" stroke-width="2" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<circle cx="229" cy="95" r="19" stroke-width="2" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="282" y="60" text-anchor="middle" font-size="12" font-weight="700">L</text>
<text x="335" y="99" text-anchor="middle" font-size="12" font-weight="700">F</text>
<text x="315" y="161" text-anchor="middle" font-size="12" font-weight="700">F</text>
<text x="249" y="161" text-anchor="middle" font-size="12" font-weight="700">F</text>
<text x="229" y="99" text-anchor="middle" font-size="12" font-weight="700">F</text>
<text x="282" y="28" text-anchor="middle" font-size="12" font-weight="700" style="fill: var(--viz-c1)">leader</text>
<text x="282" y="200" text-anchor="middle" font-size="12">ensemble: a majority</text>
<text x="282" y="216" text-anchor="middle" font-size="12">votes on every write</text>
<path d="M354,99 L379,108" stroke-width="1.4" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch9d2-zk-mu)"/>
<circle cx="400" cy="112" r="19" stroke-width="2" stroke-dasharray="4 3" style="fill: var(--viz-panel); stroke: var(--viz-c2)"/>
<text x="400" y="116" text-anchor="middle" font-size="12" font-weight="700">O</text>
<text x="400" y="148" text-anchor="middle" font-size="12">observer</text>
<text x="400" y="164" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">non-voting,</text>
<text x="400" y="180" text-anchor="middle" font-size="12" style="fill: var(--viz-muted)">serves reads</text>
<rect x="452" y="8" width="180" height="200" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="466" y="28" font-size="12" font-weight="700">znodes</text>
<text x="466" y="52" font-size="12" style="font-family: var(--font-mono)">/election</text>
<text x="480" y="74" font-size="12" style="font-family: var(--font-mono)">n_0000000007</text>
<text x="490" y="90" font-size="12" style="fill: var(--viz-c1)">ephemeral · leader</text>
<text x="480" y="114" font-size="12" style="font-family: var(--font-mono)">n_0000000008</text>
<text x="490" y="130" font-size="12" style="fill: var(--viz-muted)">ephemeral · watches ↑</text>
<path d="M475,110 C463,104 463,76 475,70" stroke-width="1.4" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#ch9d2-zk-mu)"/>
<text x="466" y="160" font-size="12" style="font-family: var(--font-mono)">/config</text>
<text x="480" y="182" font-size="12" style="font-family: var(--font-mono)">partition-7</text>
<text x="490" y="198" font-size="12" style="font-family: var(--font-mono)">= 10.1.1.23</text>
</svg>`,
          caption: "A few voters, many clients. Each client keeps a session alive with heartbeats; ephemeral znodes, such as the current leader's election node, vanish when their session dies, and a watch wakes the next candidate. The observer receives the log but doesn't vote, so it adds read capacity without enlarging the quorum.",
        },
        {
          type: "text",
          html: `<h3>Why not just use a regular database?</h3>
<p>What makes a coordination service worth running is a specific combination of features. Only the first one strictly requires consensus, but you need all four together to build reliable recipes, which libraries such as Apache Curator package up for ZooKeeper users.</p>`,
        },
        {
          type: "table",
          title: "The four primitives",
          headers: ["Primitive", "What it gives you", "Typical use"],
          rows: [
            ["Linearizable atomic operations", "Compare-and-set and create-if-absent: of several concurrent attempts, exactly one succeeds. Locks are usually <em>leases</em> that expire if the holder disappears.", "Acquiring a lock; claiming a leadership role or a unique name"],
            ["Total ordering of operations", "Every write gets a position in one global order: ZooKeeper's <code>zxid</code> and per-node version numbers such as <code>cversion</code>, or etcd's revision.", "Fencing tokens that storage checks to reject a stale lock holder (Chapter 8)"],
            ["Sessions and ephemeral nodes", "Clients keep a long-lived session alive with heartbeats. If heartbeats stop for longer than the session timeout, the session expires and every ephemeral node it created is deleted.", "Failure detection: a dead leader's lock or a dead worker's registration disappears automatically"],
            ["Change notifications (watches)", "A client asks to be told when a key or a directory changes, instead of polling for it.", "Learning that a node joined, a leader vanished or the configuration changed"],
          ],
        },
        {
          type: "steps",
          title: "Leader election with ephemeral sequential znodes",
          items: [
            "Every candidate creates an <strong>ephemeral sequential</strong> znode under <code>/election</code>. ZooKeeper appends an increasing counter to the name, giving nodes such as <code>n_0000000007</code> and <code>n_0000000008</code>.",
            "Each candidate lists the children of <code>/election</code>. The candidate whose znode has the <strong>lowest sequence number</strong> is the leader.",
            "Every other candidate sets a watch on the znode <strong>immediately before its own</strong>, not on the leader's. When the leader goes away, exactly one candidate wakes up, instead of a thundering herd of clients all rushing to re-read the directory.",
            "If the leader crashes or is cut off, its session expires and its ephemeral znode is deleted. The next candidate's watch fires; it lists the children again and, if its znode is now the lowest, takes over. Otherwise it watches its new predecessor.",
            "The leader attaches a <strong>fencing token</strong>, such as the zxid at which its znode was created or an etcd revision, to every write it makes to shared storage, so a deposed leader waking from a long pause is rejected.",
          ],
        },
        {
          type: "text",
          html: `<h3>What coordination services are good for</h3>
<p><strong>Allocating work to nodes.</strong> Beyond picking one leader among several instances of a process (one active job scheduler, one active HDFS NameNode), coordination services handle partition assignment: deciding which node owns which partition, and rebalancing as nodes join or fail (Chapter 6). With atomic operations, ephemeral nodes and watches, these reassignments happen automatically, with no human in the loop.</p>
<p><strong>Slowly changing data only.</strong> Data in a coordination service should change rarely, say when a node fails or a partition moves: "node 10.1.1.23 leads partition 7". Per-request application state that churns constantly doesn't belong there, because every write goes through consensus. For replicating high-volume state, tools such as Apache BookKeeper exist.</p>
<p><strong>Service discovery</strong>, finding the network address of a service, is often done with ZooKeeper, etcd or Consul, but it doesn't strictly need consensus. DNS has done it for decades with layers of caching, because a slightly stale answer is usually fine. Leader election, on the other hand, does need consensus, so if the coordination service already knows who the leader is, it makes sense for other services to discover the leader there. To serve such reads at scale, ZooKeeper supports <strong>observers</strong>: non-voting replicas that receive the log asynchronously and answer reads that don't need to be linearizable, without enlarging the quorum. Chapter 6 covers request routing in more depth.</p>
<p><strong>Membership services</strong> have a research history going back to the 1980s. Their job is to decide which nodes are currently live members of the cluster. Timeout-based failure detection is unreliable (Chapter 8), so a node will occasionally be declared dead wrongly. But if membership is agreed through consensus, every node at least acts on the <em>same</em> view, so a rule like "the leader is the live member with the lowest ID" gives one answer everywhere.</p>`,
        },
        {
          type: "callout",
          tone: "warning",
          title: "Common ways to misuse a coordination service",
          html: `<p><strong>Stale reads.</strong> ZooKeeper answers reads from whichever server the client is connected to, and that server may lag behind the leader. Its writes are linearizable, but its reads by default are only sequentially consistent. When you need the latest value, call <code>sync()</code> first. etcd, by contrast, serves linearizable reads by default and offers cheaper, possibly stale, serializable reads as an option.</p>
<p><strong>Locks without fences.</strong> A lease from a consensus-backed service doesn't protect your storage on its own. A client can pause for longer than its session timeout (a garbage collection pause, a VM migration), lose its lock without noticing, wake up and write. The storage must check a fencing token. Session timeouts are a trade-off as well: short ones fail over quickly but declare paused-but-healthy clients dead.</p>
<p><strong>Not a coordination service:</strong> a single Redis primary with <code>SETNX</code> and a TTL. It runs no consensus, so if the primary fails over to an asynchronously replicated replica, the same lock can be granted twice, and without a fencing token nothing catches it.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Google Chubby",
              year: "2006",
              html: "The coarse-grained lock service described at OSDI 2006 is used by GFS and Bigtable to elect their masters and store small amounts of metadata, and the paper reports that it also became widely used as a name service. ZooKeeper (Yahoo, USENIX ATC 2010) cites Chubby but deliberately exposes wait-free primitives (znodes, ordering, watches) rather than a blocking lock API, leaving locks to client-side recipes.",
            },
            {
              org: "Kubernetes",
              tag: "etcd",
              html: "All cluster state, from pods and services to leader-election leases, lives in etcd. Only the API server talks to etcd directly, and controllers learn about changes through watch streams built on etcd's watch mechanism. The Kubernetes documentation recommends running etcd as a cluster with an odd number of members.",
            },
            {
              org: "Apache Kafka",
              year: "2025",
              html: "Kafka originally kept controller election and topic metadata in ZooKeeper. KIP-500 replaced this with KRaft, a Raft-replicated metadata log run by Kafka's own controller nodes, and Kafka 4.0 removed ZooKeeper support entirely.",
            },
            {
              org: "Hadoop HDFS",
              tag: "NameNode HA",
              html: "NameNode high availability uses ZooKeeper: a ZKFailoverController beside each NameNode competes for an ephemeral lock znode. When the active NameNode's session expires, the standby takes the lock and becomes active, after fencing the old one so it can't keep writing.",
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "The coordination layer since 2017",
          html: `<p><strong>Kafka dropped ZooKeeper</strong> for its own Raft quorum (KRaft, described in the total order broadcast section). <strong>Kubernetes made etcd ubiquitous</strong>: every cluster's state lives in it, and its controllers are built on watches. <strong>ClickHouse Keeper</strong> is a Raft-based, ZooKeeper-compatible replacement built by the ClickHouse project. And <strong>etcd 3.4</strong> added non-voting <em>learner</em> members, which catch up on the log before being promoted to voters, so adding a node no longer weakens the quorum while the newcomer is still behind.</p>`,
        },
        {
          type: "tradeoffs",
          title: "Using ZooKeeper or etcd",
          prosLabel: "Strengths",
          consLabel: "Costs and limits",
          pros: [
            "Consensus, ordering and failure detection implemented once, by specialists, and battle-tested in production.",
            "A small voting ensemble (3 or 5 servers) serves thousands of clients; observers and followers can absorb read load.",
            "Primitives that compose into leader election, locks with fencing, membership and configuration with change notifications.",
          ],
          cons: [
            "Another critical system to operate: when the coordination service is down, nothing can elect a leader or take a lock.",
            "Every write goes through consensus, so throughput is limited and latency includes a quorum round trip. Suitable only for small, slowly changing data.",
            "The minority side of a partition can't write, and ZooKeeper reads can be stale unless preceded by <code>sync()</code>.",
            "Session timeouts force a choice between fast failover and false alarms from garbage collection pauses.",
            "Locks and leases still need fencing tokens checked by the resource they protect.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Design leader election for a fleet of job schedulers" and "How would you build a distributed lock?" are common prompts. A strong answer reaches for an existing coordination service instead of inventing a protocol: ephemeral sequential znodes (or an etcd lease plus a transaction), each candidate watching only its predecessor, and the zxid or etcd revision used as a fencing token that the storage layer checks. Mention the session-timeout trade-off and that ZooKeeper reads need <code>sync()</code> for freshness. Explaining why <code>SETNX</code> on a single Redis primary isn't equivalent earns real credit.</p>`,
        },
        {
          type: "quiz",
          q: "Why is ZooKeeper typically run on 3 or 5 voting servers even when thousands of clients use it?",
          options: [
            "More voters would increase write throughput, but 3 or 5 is enough for most workloads",
            "Every write must be acknowledged by a majority of voters, so more voters slow writes down; non-voting observers add read capacity instead",
            "Each additional voter must hold a separate shard of the data, which makes recovery more complicated",
            "Clients take part in voting on writes, so the number of servers is kept small to leave room for them",
          ],
          answer: 1,
          explain: "Each write must be acknowledged by a majority of voting servers, so adding voters means larger quorums and more messages per write, not more throughput (A is the tempting wrong answer). Five voters already tolerate two failures. Every voter holds a full copy of the data rather than a shard (C), and clients never vote (D): they connect to any server through a session, and observers scale read throughput without enlarging the quorum.",
        },
      ],
    },
  ],

  takeaways: [
    "<strong>Linearizability is a recency guarantee:</strong> the system behaves as if there were one copy, so once any read sees a write, every later read must too. Locks, leader election and uniqueness constraints all need it.",
    "<strong>It isn't free.</strong> During a partition, the side that can't reach the leader or a majority must refuse requests, and even without faults linearizable operations can't be faster than the uncertainty in network delay. CAP is a narrow statement of the first cost; PACELC adds the second.",
    "<strong>Causality is the order most applications actually rely on.</strong> It's a partial order, cheaper than linearizability, and can stay available during partitions. Vector clocks detect concurrency; Lamport timestamps can't.",
    "<strong>Lamport timestamps</strong> give a total order consistent with causality, but you only know it's final once you've heard from everyone, so they can't answer \"is this username free?\" on the spot.",
    "<strong>Total order broadcast</strong> (one log, delivered gaplessly and identically everywhere) underlies state machine replication, and it is equivalent to consensus and to a linearizable compare-and-set register.",
    "<strong>2PC</strong> gives atomic commit through two points of no return, the participant's YES and the coordinator's durable decision, but blocks when the coordinator fails. Modern distributed databases keep 2PC and make every participant and the coordinator a consensus group; heterogeneous XA transactions inherit all of 2PC's fragility.",
    "<strong>Consensus algorithms</strong> (Paxos, Raft, Zab, Viewstamped Replication) combine epochs with overlapping majority quorums: always safe, and live whenever a majority can communicate and timeouts are reasonable.",
    "<strong>Don't write consensus yourself.</strong> Use ZooKeeper, etcd or a database with built-in Raft for leader election, locks (with fencing), membership and configuration, and keep fast-changing data out of them.",
  ],

  connections: [
    { to: "ch5", html: "Replication-lag guarantees (read-your-writes, monotonic reads, consistent prefix) are weaker relatives of linearizability. Quorums (w + r &gt; n), failover and version vectors from Chapter 5 come back here to show why, on their own, they don't give you linearizability." },
    { to: "ch6", html: "Partitioning limits total ordering to within a partition. Partition assignment and request routing are classic jobs for ZooKeeper and etcd." },
    { to: "ch7", html: "Serializability, 2PL, SSI and single-node atomicity are contrasted with linearizability and extended to distributed atomic commit (2PC). Actual serial execution reappears as deterministic transactions over total order broadcast." },
    { to: "ch8", html: "Unreliable networks, timeouts, clock skew, process pauses, fencing tokens, majority quorums and system models (safety vs liveness, Byzantine faults) are the assumptions every consensus algorithm is built on." },
    { to: "ch11", html: "A partition of a log-based message broker is total order broadcast in practice. Exactly-once processing and change data capture offer alternatives to distributed transactions." },
    { to: "ch12", html: "Chapter 12 argues for avoiding distributed transactions with logs, idempotent operations and end-to-end checks, enforcing constraints such as uniqueness by routing every request for a key through one log partition." },
  ],

  furtherReading: [
    { title: "Herlihy and Wing, \"Linearizability: A Correctness Condition for Concurrent Objects\" (1990)", url: "https://cs.brown.edu/~mph/HerlihyW90/p463-herlihy.pdf", note: "The paper that defined linearizability; short and readable for its core definitions." },
    { title: "Lamport, \"Time, Clocks, and the Ordering of Events in a Distributed System\" (1978)", url: "https://lamport.azurewebsites.net/pubs/time-clocks.pdf", note: "Introduces happened-before and logical clocks, and ends by sketching state machine replication." },
    { title: "Ongaro and Ousterhout, \"In Search of an Understandable Consensus Algorithm\" (Raft, 2014)", url: "https://raft.github.io/raft.pdf", note: "The Raft paper; pair it with the interactive visualization on the Raft website." },
    { title: "The Raft consensus algorithm website", url: "https://raft.github.io/", note: "Visualizations, talks and a list of Raft implementations." },
    { title: "Lamport, \"Paxos Made Simple\" (2001)", url: "https://lamport.azurewebsites.net/pubs/paxos-simple.pdf", note: "Paxos in a few pages, without the parliament allegory." },
    { title: "Chandra, Griesemer and Redstone, \"Paxos Made Live\" (2007)", url: "https://research.google/pubs/paxos-made-live-an-engineering-perspective-2006-invited-talk/", note: "What it took Google to turn Paxos into the production system behind Chubby." },
    { title: "Kleppmann, \"A Critique of the CAP Theorem\" (2015)", url: "https://arxiv.org/abs/1509.05393", note: "Why CAP's definitions don't fit real systems, and a delay-sensitivity framework instead." },
    { title: "Kleppmann, \"How to do distributed locking\" (2016)", url: "https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html", note: "Why locks need fencing tokens, using Redlock as the case study." },
    { title: "Jepsen analyses", url: "https://jepsen.io/analyses", note: "Real-world tests of databases' consistency claims under partitions and clock skew." },
    { title: "Jepsen, \"Consistency Models\"", url: "https://jepsen.io/consistency", note: "A clickable map of consistency models, with precise definitions and which ones stay available during partitions." },
    { title: "Hunt et al., \"ZooKeeper: Wait-free Coordination for Internet-scale Systems\" (USENIX ATC 2010)", url: "https://www.usenix.org/conference/usenix-atc-10/zookeeper-wait-free-coordination-internet-scale-systems", note: "The design rationale behind ZooKeeper's API, ordering guarantees and performance." },
    { title: "Fischer, Lynch and Paterson, \"Impossibility of Distributed Consensus with One Faulty Process\" (1985)", url: "https://groups.csail.mit.edu/tds/papers/Lynch/jacm85.pdf", note: "The FLP result; the proof idea (bivalent states) is worth knowing." },
    { title: "Brewer, \"Spanner, TrueTime and the CAP Theorem\" (2017)", url: "https://research.google/pubs/spanner-truetime-and-the-cap-theorem/", note: "How a CP system can be \"effectively CA\" when partitions are rare." },
    { title: "Attiya, Bar-Noy and Dolev, \"Sharing Memory Robustly in Message-Passing Systems\" (1995)", note: "The ABD algorithm: linearizable read/write registers from majority quorums, without consensus." },
    { title: "Howard and Mortier, \"Paxos vs Raft: Have we reached consensus on distributed consensus?\" (2020)", url: "https://arxiv.org/abs/2004.05074", note: "Shows the two differ mainly in leader election; useful for the Paxos-vs-Raft interview question." },
    { title: "Kulkarni et al., \"Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases\" (2014)", url: "https://cse.buffalo.edu/tech-reports/2014-04.pdf", note: "The hybrid logical clock paper." },
    { title: "GitHub, \"October 21 post-incident analysis\" (2018)", url: "https://github.blog/2018-10-30-oct21-post-incident-analysis/", note: "The outage in this chapter's opening, told by GitHub: Orchestrator's Raft-based failover, the divergent writes, and why they chose data integrity over a fast recovery." },
  ],
});
