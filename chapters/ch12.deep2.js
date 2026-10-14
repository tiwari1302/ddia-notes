// Chapter 12 deep dive, part 2 (second half of the sections + takeaways). Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch12", {
  sections: [
    // ───────────────────────────────────────────────────────────── 6
    {
      id: "enforcing-constraints",
      title: "Constraints without distributed transactions",
      kicker: "Correctness",
      concepts: ["enforcing-constraints-on-streams", "uniqueness-requires-consensus", "multi-partition-request-processing"],
      blocks: [
        {
          type: "problem",
          html: `<p>Imagine two people, one in Frankfurt and one in Virginia, signing up for the username <code>alice</code> within the same 50 ms. Each region checks its own replica, finds the name free, shows "Welcome, alice" and sends a confirmation email. An hour later, asynchronous replication carries each region's write to the other, and the system discovers two accounts with one name. One of them now has to be taken away from someone who was told it was theirs.</p>
<p>Some rules can't bend like this: a concert seat is sold once, a prepaid wallet never goes below zero, a transfer neither creates nor destroys money. Inside one database you would reach for a <code>UNIQUE</code> constraint or a transaction. But the architecture of this chapter has no single database. Data lives in partitioned logs and the views derived from them, and a transfer touches two accounts on two partitions. The textbook fix, atomic commit across partitions with two-phase commit (2PC), brings back the blocking coordinator, the cross-partition locks and the tight coupling that the log was supposed to remove.</p>`,
        },
        {
          type: "idea",
          html: `<p>Turn the constraint check into <strong>sequential processing of one log partition</strong>. Route every request that could conflict to the same partition, let a single-threaded processor decide in log order, and break multi-partition operations into deterministic messages tagged with a request ID, which each downstream partition applies <strong>idempotently</strong>.</p>`,
        },
        {
          type: "text",
          html: `<h3>Uniqueness is a consensus problem</h3>
<p>When several requests claim the same username at once, the system has to pick one winner and reject the rest, and every part of the system has to agree on who won. Choosing one value among competing proposals so that everyone agrees is the <strong>consensus</strong> problem of <a href="#/ch9/learn/consensus">Chapter 9</a>. You can't enforce uniqueness without solving it somewhere.</p>
<p>The usual way to solve it is to funnel every request for a given value through one node that makes the decision. A single leader counts (and if that leader fails over automatically, the election that picks its successor is itself consensus). That doesn't mean one machine for the whole system: <strong>partition by the value that must be unique</strong>. Hash the username, the seat ID or the product SKU, and each partition owns a slice of the values. Partitions decide in parallel; within a partition there is exactly one decision point.</p>
<p>What this rules out is asynchronous multi-leader replication, the setup in the Frankfurt and Virginia story. Each leader accepts writes locally and tells the others later, so two leaders can each accept conflicting writes before either hears about the other. If you want to reject a violating write <em>before</em> acknowledging it, some synchronous coordination with the decision point is unavoidable.</p>`,
        },
        {
          type: "diagram",
          title: "Uniqueness: two ways",
          svg: `<style>.dd-diagram-body svg.c12e-uq-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c12e-uq-w{display:none}.dd-diagram-body svg.c12e-uq-n{display:block}}</style><svg class="c12e-uq-w" viewBox="0 0 640 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left: two datacenters each accept the username alice and conflict later. Right: both claims go to one log partition, and a single processor accepts the first and rejects the second.">
<defs><marker id="ch12d2-uq-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<text x="155" y="18" font-size="13" font-weight="700" text-anchor="middle">Async multi-leader</text>
<text x="80" y="36" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">claim "alice"</text>
<text x="230" y="36" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">claim "alice"</text>
<rect x="20" y="42" width="120" height="52" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="80" y="63" font-size="13" font-weight="700" text-anchor="middle">DC Europe</text>
<text x="80" y="82" font-size="12" text-anchor="middle">local copy: free</text>
<rect x="170" y="42" width="120" height="52" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="230" y="63" font-size="13" font-weight="700" text-anchor="middle">DC US</text>
<text x="230" y="82" font-size="12" text-anchor="middle">local copy: free</text>
<rect x="30" y="102" width="100" height="24" rx="12" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="80" y="118" font-size="12" text-anchor="middle">replied "OK"</text>
<rect x="180" y="102" width="100" height="24" rx="12" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="230" y="118" font-size="12" text-anchor="middle">replied "OK"</text>
<line x1="80" y1="126" x2="110" y2="160" style="stroke: var(--viz-muted); stroke-width: 1.5; stroke-dasharray: 5 4" marker-end="url(#ch12d2-uq-arr)"/>
<line x1="230" y1="126" x2="200" y2="160" style="stroke: var(--viz-muted); stroke-width: 1.5; stroke-dasharray: 5 4" marker-end="url(#ch12d2-uq-arr)"/>
<text x="155" y="148" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">replicated later</text>
<rect x="30" y="162" width="250" height="36" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="155" y="185" font-size="13" font-weight="700" text-anchor="middle">conflict: two users named alice</text>
<line x1="320" y1="10" x2="320" y2="200" style="stroke: var(--viz-line); stroke-dasharray: 3 4"/>
<text x="485" y="18" font-size="13" font-weight="700" text-anchor="middle">One log partition decides</text>
<text x="345" y="38" font-size="12" style="fill: var(--viz-muted)">partition for hash("alice")</text>
<rect x="345" y="44" width="280" height="46" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<rect x="355" y="52" width="125" height="30" rx="5" style="fill: var(--viz-bg); stroke: var(--viz-c1)"/>
<text x="417" y="72" font-size="12" text-anchor="middle">1: claim (EU)</text>
<rect x="490" y="52" width="125" height="30" rx="5" style="fill: var(--viz-bg); stroke: var(--viz-c1)"/>
<text x="552" y="72" font-size="12" text-anchor="middle">2: claim (US)</text>
<line x1="485" y1="90" x2="485" y2="110" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch12d2-uq-arr)"/>
<rect x="390" y="112" width="190" height="38" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="485" y="136" font-size="12" text-anchor="middle">single-threaded processor</text>
<line x1="450" y1="150" x2="425" y2="168" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch12d2-uq-arr)"/>
<line x1="520" y1="150" x2="545" y2="168" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch12d2-uq-arr)"/>
<rect x="350" y="170" width="130" height="28" rx="14" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="415" y="189" font-size="12" text-anchor="middle">1: OK, it's yours</text>
<rect x="490" y="170" width="130" height="28" rx="14" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="555" y="189" font-size="12" text-anchor="middle">2: rejected, taken</text>
</svg><svg class="c12e-uq-n" viewBox="0 0 360 432" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top: two datacenters each accept the username alice and conflict later. Bottom: both claims go to one log partition, and a single processor accepts the first and rejects the second.">
<defs><marker id="c12e-uq-n-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<text x="180" y="18" font-size="13" font-weight="700" text-anchor="middle">Async multi-leader</text>
<text x="90" y="38" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">claim "alice"</text>
<text x="270" y="38" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">claim "alice"</text>
<rect x="20" y="44" width="140" height="50" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="90" y="65" font-size="13" font-weight="700" text-anchor="middle">DC Europe</text>
<text x="90" y="84" font-size="12" text-anchor="middle">local copy: free</text>
<rect x="200" y="44" width="140" height="50" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="270" y="65" font-size="13" font-weight="700" text-anchor="middle">DC US</text>
<text x="270" y="84" font-size="12" text-anchor="middle">local copy: free</text>
<rect x="40" y="102" width="100" height="24" rx="12" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="90" y="118" font-size="12" text-anchor="middle">replied "OK"</text>
<rect x="220" y="102" width="100" height="24" rx="12" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="270" y="118" font-size="12" text-anchor="middle">replied "OK"</text>
<line x1="90" y1="126" x2="146" y2="158" style="stroke: var(--viz-muted); stroke-width: 1.5; stroke-dasharray: 5 4" marker-end="url(#c12e-uq-n-arr)"/>
<line x1="270" y1="126" x2="214" y2="158" style="stroke: var(--viz-muted); stroke-width: 1.5; stroke-dasharray: 5 4" marker-end="url(#c12e-uq-n-arr)"/>
<text x="180" y="146" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">replicated later</text>
<rect x="30" y="162" width="300" height="36" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="180" y="185" font-size="13" font-weight="700" text-anchor="middle">conflict: two users named alice</text>
<line x1="12" y1="216" x2="348" y2="216" style="stroke: var(--viz-line); stroke-dasharray: 3 4"/>
<text x="180" y="242" font-size="13" font-weight="700" text-anchor="middle">One log partition decides</text>
<text x="20" y="264" font-size="12" style="fill: var(--viz-muted)">partition for hash("alice")</text>
<rect x="20" y="270" width="320" height="46" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<rect x="30" y="278" width="145" height="30" rx="5" style="fill: var(--viz-bg); stroke: var(--viz-c1)"/>
<text x="102" y="298" font-size="12" text-anchor="middle">1: claim (EU)</text>
<rect x="185" y="278" width="145" height="30" rx="5" style="fill: var(--viz-bg); stroke: var(--viz-c1)"/>
<text x="257" y="298" font-size="12" text-anchor="middle">2: claim (US)</text>
<line x1="180" y1="316" x2="180" y2="336" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#c12e-uq-n-arr)"/>
<rect x="85" y="338" width="190" height="38" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="180" y="362" font-size="12" text-anchor="middle">single-threaded processor</text>
<line x1="150" y1="376" x2="112" y2="394" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#c12e-uq-n-arr)"/>
<line x1="210" y1="376" x2="248" y2="394" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#c12e-uq-n-arr)"/>
<rect x="20" y="396" width="150" height="28" rx="14" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="95" y="415" font-size="12" text-anchor="middle">1: OK, it's yours</text>
<rect x="190" y="396" width="150" height="28" rx="14" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="265" y="415" font-size="12" text-anchor="middle">2: rejected, taken</text>
</svg>`,
          caption: "With async multi-leader replication, each datacenter checks only its own copy, so both accept the name, and the conflict surfaces after both users were told yes. With one log partition, both claims land in the same ordered log, and one processor reading them in order rejects the second before anyone is told anything.",
        },
        {
          type: "text",
          html: `<h3>Uniqueness through a log</h3>
<p>A log partition gives you that single decision point almost for free. Every consumer of a partition sees its messages in the same order: a partitioned log is <strong>total order broadcast</strong> per partition, which <a href="#/ch9/learn/total-order-broadcast">Chapter 9</a> showed is equivalent to consensus. So send each "claim username" request to the partition chosen by hashing the username, and give that partition one stream processor that reads it sequentially, on a single thread.</p>
<p>For each request, the processor checks its local state ("is <code>alice</code> already taken?"), records the claim if the name is free, and emits a <em>success</em> or <em>rejection</em> event to an output stream, tagged with the request's ID. The client that submitted the request waits for the outcome event carrying its ID before it tells the user anything. The second claim for <code>alice</code> is always read after the first, so it is always the one rejected, and nobody is ever welcomed by mistake.</p>
<p>Nothing here is specific to usernames. The pattern works for any constraint whose conflicting writes can be routed to one partition and decided one at a time: seats in a venue partitioned by event, stock levels partitioned by SKU, a wallet balance partitioned by account.</p>
<h3>When one request touches several partitions</h3>
<p>A transfer of $50 from account A to account B is harder. A and B live on different partitions, both must change, and no single partition's processor can decide for both. The book's recipe avoids atomic commit by making exactly one step durable and deriving everything else from it.</p>`,
        },
        {
          type: "steps",
          title: "A transfer across partitions, with no atomic commit",
          items: [
            "<strong>Record the request once.</strong> The client gives the transfer a unique request ID, say <code>r-91</code>, and the request is appended to a request log partitioned by request ID. This single append is the commit point: once it is durable, the transfer will happen.",
            "<strong>Split it deterministically.</strong> A stream processor reads the request log and, for each request, emits two instructions: <em>debit A $50</em> to A's partition and <em>credit B $50</em> to B's partition, both tagged <code>r-91</code>. Its output depends only on its input, so processing the same request again produces identical instructions.",
            "<strong>Apply idempotently.</strong> Processors for the account partitions consume their instructions, skip any request ID they have already applied, and update the balance. Each stores its set of applied IDs atomically with the balance it protects.",
            "<strong>Recover by replaying.</strong> If the splitter crashes, it restarts from its last checkpoint and re-emits the same instructions; the account processors drop the ones they've seen. No partition ever waits for another.",
            "<strong>Optional guard against overdrafts.</strong> In front of step 1, add a processor partitioned by the payer's account that keeps balances and validates each transfer. Only valid transfers are appended to the request log.",
          ],
        },
        {
          type: "text",
          html: `<p>Why does this work without atomic commit? The request is recorded durably <strong>once, in a single message</strong>. Everything after that is a deterministic derivation of that message, and duplicates created by crashes and retries are suppressed by the request ID, end to end. This is the operation-ID idea from <a href="#/ch12/learn/end-to-end-argument">exactly once, end to end</a>, applied inside the pipeline rather than between a user and a server.</p>
<p>The visualization below runs the recipe for <code>r-91</code>: $50 from A (partition P1) to B (partition P2), both starting at $500, with the invariant A + B = $1,000. The meter at the bottom separates money that is <em>in flight</em> (debited, not yet credited) from money that is genuinely <em>missing</em> or that was <em>created</em>. Pick a fault and step through.</p>`,
        },
        {
          type: "viz",
          id: "ch12/stream-transfer",
          title: "A transfer without 2PC",
          caption: "Try the default 'Splitter crash' with deduplication on, then the same crash with it off, then 'Redelivery to P2' both ways. Notice that with deduplication every run returns to $1,000 and the $50 'in flight' only delays the credit, while without it the books end at $950 or $1,050 with nothing in flight: no amount of waiting fixes that. 'Cross-partition commits' stays at 0 throughout.",
        },
        {
          type: "text",
          html: `<p>Three things stand out. First, a crash only ever <strong>delays</strong> the credit. With deduplication on, every script ends balanced, and the dip to $950 is money owed, not money lost. Second, the request ID carries the whole design. Turn deduplication off and the same crash leaves $50 missing, or a redelivered credit creates $50, permanently. Third, the cross-partition commit counter never moves: the partitions never coordinate synchronously.</p>
<p>The price is <strong>visibility</strong>. Between the debit and the credit, a reader who sums both accounts sees $50 missing. Two-phase commit would hide that moment behind locks. The log-based approach exposes it briefly but can't lose it. Whether that brief window is acceptable is the subject of the next section.</p>`,
        },
        {
          type: "compare",
          title: "Moving $50 between two partitions",
          items: [
            {
              title: "Two-phase commit",
              tone: "warn",
              html: `<ul><li><strong>Who coordinates:</strong> a coordinator asks both partitions to prepare, then to commit; locks on A and B are held until the decision arrives.</li><li><strong>What readers see:</strong> before or after, never in between.</li><li><strong>On a crash:</strong> if the coordinator dies after the participants prepare, they wait in doubt, holding locks, until it recovers.</li><li><strong>Coupling:</strong> every participant must speak the protocol and be available at the same moment.</li></ul>`,
            },
            {
              title: "Log-based transfer",
              tone: "ok",
              html: `<ul><li><strong>Who coordinates:</strong> nobody; one durable append to the request log is the commit point.</li><li><strong>What readers see:</strong> briefly, A debited and B not yet credited.</li><li><strong>On a crash:</strong> the failed processor replays from its checkpoint, and duplicates are dropped by request ID.</li><li><strong>Coupling:</strong> each partition reads only its own log; a slow partition delays its own work and nobody else's.</li></ul>`,
            },
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Calvin",
              year: "2012",
              tag: "order first, then execute",
              html: "The Calvin deterministic database (Yale, SIGMOD 2012) first agrees on a global order of transactions in a replicated log; each partition then executes them deterministically in that order, which avoids two-phase commit for distributed transactions. The commercial FaunaDB drew on its design.",
            },
            {
              org: "TigerBeetle",
              tag: "ledger by serial execution",
              html: "An open-source database built specifically for debits and credits. It replicates an ordered log of transfers with consensus and applies it on a single core per replica, so balance limits and unique transfer IDs (a retried transfer with the same ID is not applied twice) are enforced by sequential execution.",
            },
          ],
        },
        {
          type: "callout",
          tone: "insight",
          title: "This is serial execution again",
          html: `<p><a href="#/ch7/learn/serial-execution">Chapter 7</a>'s actual serial execution gets serializability by running one transaction at a time on one thread, and scales out by partitioning so that each thread owns its slice of the data. A log partition with a single consumer is the same idea. What changes is where the work comes from: a durable, replayable log instead of calls to stored procedures. A crashed processor is rebuilt by replaying its input, and every decision is published as an event that other parts of the system can consume. LMAX's single-threaded, event-sourced exchange (<a href="#/ch11/learn/event-sourcing">Chapter 11</a>) keeps its invariants the same way, by applying events in one order.</p>`,
        },
        {
          type: "callout",
          tone: "mistake",
          title: "\"Kafka partitions give us transactions\"",
          html: `<p>A partition gives you a <strong>total order</strong> of messages, and only within that partition. It checks nothing. The constraint holds only because a single consumer applies a deterministic check in that order, and because the client waits for that consumer's decision before telling anyone the request succeeded. Two consumers racing on one partition, a check made against a lagging read model, or a client that acknowledges before the outcome event arrives will all break the guarantee while the log itself works perfectly.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: transfer money between shards without 2PC",
          html: `<p>A strong answer walks through the recipe and names what each part buys. The client mints a transfer ID once per user intent and reuses it on every retry. The request is appended to a log, and that append is the commit point. A deterministic processor emits a debit and a credit, both carrying the ID, to the two account partitions, and each account processor stores applied IDs atomically with the balance, so replays are harmless. Overdrafts are prevented by validating in a processor partitioned by the payer <em>before</em> the request enters the log, so a credit is never issued for a debit that will later be refused.</p>
<p>Then cover the cost: for a short time, the money is visible in neither account. Show the transfer as "pending" in the UI, and run a reconciliation job that checks that balances plus in-flight transfers sum to a constant. Interviewers like to hear when you <em>would</em> still use a transaction: inside a single partition or a single database, where it is cheap.</p>`,
        },
        {
          type: "quiz",
          q: "In the log-based transfer recipe, the splitter crashes after emitting the debit for request <code>r-91</code> but before checkpointing its input offset. What guarantees that account A isn't debited twice after it restarts?",
          options: [
            "The log deletes the first debit message when the splitter crashes",
            "The splitter re-emits identical instructions tagged <code>r-91</code>, and A's partition processor skips IDs it has already applied, which it stores atomically with the balance",
            "A two-phase commit between P1 and P2 rolls back the first debit",
            "The splitter remembers that it already sent the debit and doesn't send it again",
          ],
          answer: 1,
          explain: "Recovery is replay: the splitter deterministically re-emits the same tagged instructions, and idempotent consumers drop duplicates by request ID. Option D is the tempting one, but the splitter's memory of what it sent is exactly what the crash wiped out; it restarts from its last checkpoint, which predates the debit, so it <em>will</em> send it again. Logs don't delete messages because a producer crashed (A), and the whole point of the design is that there is no 2PC (C).",
        },
      ],
    },

    // ───────────────────────────────────────────────────────────── 7
    {
      id: "timeliness-and-integrity",
      title: "Late is fixable, wrong is forever: timeliness vs integrity",
      kicker: "Correctness",
      concepts: ["timeliness-vs-integrity", "loosely-interpreted-constraints", "coordination-avoidance"],
      blocks: [
        {
          type: "problem",
          html: `<p>Imagine an alert at 10:00:00.2: the sum of all account balances is $50 short. It turns out to be a transfer whose debit has landed and whose credit is 300 ms behind. By the time three engineers are awake, the books balance again. The same week, a consumer restart double-counts 2,000 orders in the revenue table. Nobody is paged, because "the pipeline is eventually consistent", and that number will stay wrong forever.</p>
<p>Teams that file both incidents under "inconsistency" make one of two mistakes. They over-react and buy synchronous coordination (distributed transactions, linearizable reads) everywhere, paying for it in latency and availability. Or they under-react and wave real corruption away as lag. The two incidents involve different properties: whether readers see the latest state <em>yet</em>, and whether the state is correct <em>at all</em>.</p>`,
        },
        {
          type: "idea",
          html: `<p>Split "consistency" in two. <strong>Timeliness</strong> means readers see up-to-date state; violations are temporary and heal if you wait. <strong>Integrity</strong> means nothing is corrupted, lost or invented; violations are permanent until someone repairs them. Protect integrity everywhere, and pay for coordination, which is what buys timeliness, only where an immediate answer is truly required.</p>`,
        },
        {
          type: "text",
          html: `<h3>Two properties hiding in one word</h3>
<p><strong>Timeliness</strong> is about freshness: users observe the system in an up-to-date state. A read from a lagging replica, a search index a few seconds behind, a cache entry that hasn't expired yet: all of these are timeliness problems, and all of them resolve themselves if you wait and read again.</p>
<p><strong>Integrity</strong> is about correctness: no lost data, no contradictory or false records. For derived data in particular, integrity means the derived dataset is an accurate derivation of its source. The search index contains exactly the documents in the database; the revenue table sums exactly the orders in the log. When integrity breaks, waiting doesn't help. The wrong value stays wrong until something detects it and repairs it.</p>
<p>Put bluntly, a timeliness violation is what people mean by <em>eventual consistency</em>, while an integrity violation is <em>perpetual</em> inconsistency. In most applications integrity matters far more: a stale read is annoying, a corrupted balance can be catastrophic.</p>`,
        },
        {
          type: "diagram",
          title: "Timeliness and integrity are different axes",
          svg: `<style>.dd-diagram-body svg.c12e-ti-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c12e-ti-w{display:none}.dd-diagram-body svg.c12e-ti-n{display:block}}</style><svg class="c12e-ti-w" viewBox="0 0 520 305" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A two by two grid of fresh or stale against correct or corrupted. Time moves a stale but correct system to fresh and correct; nothing moves a corrupted system back by waiting.">
<defs><marker id="ch12d2-ti-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ok)"/></marker></defs>
<text x="177" y="18" font-size="13" font-weight="700" text-anchor="middle">fresh (timely)</text>
<text x="402" y="18" font-size="13" font-weight="700" text-anchor="middle">stale (late)</text>
<text x="290" y="40" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-ok)">time heals</text>
<line x1="372" y1="50" x2="212" y2="50" style="stroke: var(--viz-ok); stroke-width: 2" marker-end="url(#ch12d2-ti-arr)"/>
<text x="24" y="167" font-size="13" font-weight="700" text-anchor="middle" transform="rotate(-90 24 167)">integrity</text>
<text x="54" y="112" font-size="12" text-anchor="middle" transform="rotate(-90 54 112)" style="fill: var(--viz-muted)">correct</text>
<text x="54" y="222" font-size="12" text-anchor="middle" transform="rotate(-90 54 222)" style="fill: var(--viz-muted)">corrupted</text>
<rect x="70" y="62" width="215" height="100" rx="10" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="177" y="96" font-size="13" font-weight="700" text-anchor="middle">fresh + correct</text>
<text x="177" y="118" font-size="12" text-anchor="middle">ACID transaction</text>
<text x="177" y="136" font-size="12" text-anchor="middle">in one database</text>
<rect x="295" y="62" width="215" height="100" rx="10" style="fill: var(--viz-info-soft); stroke: var(--viz-info)"/>
<text x="402" y="96" font-size="13" font-weight="700" text-anchor="middle">stale but correct</text>
<text x="402" y="118" font-size="12" text-anchor="middle">async dataflow with</text>
<text x="402" y="136" font-size="12" text-anchor="middle">idempotent consumers</text>
<rect x="70" y="172" width="215" height="100" rx="10" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="177" y="206" font-size="13" font-weight="700" text-anchor="middle">fresh but wrong</text>
<text x="177" y="228" font-size="12" text-anchor="middle">a fast pipeline</text>
<text x="177" y="246" font-size="12" text-anchor="middle">that double-counts</text>
<rect x="295" y="172" width="215" height="100" rx="10" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="402" y="206" font-size="13" font-weight="700" text-anchor="middle">stale and wrong</text>
<text x="402" y="228" font-size="12" text-anchor="middle">the worst of both</text>
<text x="290" y="296" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">waiting never fixes the bottom row: it needs detection and repair</text>
</svg><svg class="c12e-ti-n" viewBox="0 0 360 318" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A two by two grid of fresh or stale against correct or corrupted. Time moves a stale but correct system to fresh and correct; nothing moves a corrupted system back by waiting.">
<defs><marker id="c12e-ti-n-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ok)"/></marker></defs>
<text x="124" y="18" font-size="13" font-weight="700" text-anchor="middle">fresh (timely)</text>
<text x="280" y="18" font-size="13" font-weight="700" text-anchor="middle">stale (late)</text>
<text x="202" y="38" font-size="12" font-weight="700" text-anchor="middle" style="fill: var(--viz-ok)">time heals</text>
<line x1="256" y1="48" x2="150" y2="48" style="stroke: var(--viz-ok); stroke-width: 2" marker-end="url(#c12e-ti-n-arr)"/>
<text x="14" y="165" font-size="13" font-weight="700" text-anchor="middle" transform="rotate(-90 14 165)">integrity</text>
<text x="38" y="110" font-size="12" text-anchor="middle" transform="rotate(-90 38 110)" style="fill: var(--viz-muted)">correct</text>
<text x="38" y="220" font-size="12" text-anchor="middle" transform="rotate(-90 38 220)" style="fill: var(--viz-muted)">corrupted</text>
<rect x="50" y="60" width="148" height="100" rx="10" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="124" y="94" font-size="13" font-weight="700" text-anchor="middle">fresh + correct</text>
<text x="124" y="116" font-size="12" text-anchor="middle">ACID transaction</text>
<text x="124" y="134" font-size="12" text-anchor="middle">in one database</text>
<rect x="206" y="60" width="148" height="100" rx="10" style="fill: var(--viz-info-soft); stroke: var(--viz-info)"/>
<text x="280" y="94" font-size="13" font-weight="700" text-anchor="middle">stale but correct</text>
<text x="280" y="116" font-size="12" text-anchor="middle">async dataflow with</text>
<text x="280" y="134" font-size="12" text-anchor="middle">idempotent consumers</text>
<rect x="50" y="170" width="148" height="100" rx="10" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="124" y="204" font-size="13" font-weight="700" text-anchor="middle">fresh but wrong</text>
<text x="124" y="226" font-size="12" text-anchor="middle">a fast pipeline</text>
<text x="124" y="244" font-size="12" text-anchor="middle">that double-counts</text>
<rect x="206" y="170" width="148" height="100" rx="10" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="280" y="204" font-size="13" font-weight="700" text-anchor="middle">stale and wrong</text>
<text x="280" y="226" font-size="12" text-anchor="middle">the worst of both</text>
<text x="202" y="292" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">waiting never fixes the bottom row:</text>
<text x="202" y="308" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">it needs detection and repair</text>
</svg>`,
          caption: "Lag moves a system along the top row, and time moves it back to the left. Nothing moves a system out of the bottom row except finding the corruption and repairing it.",
        },
        {
          type: "text",
          html: `<p>Your credit card statement makes the difference tangible. A purchase you made this morning not appearing until tomorrow is normal; nobody calls the bank about it. That is timeliness. A statement whose balance doesn't equal the sum of the transactions listed on it, or a charge that was made and then silently vanished, is a different matter. That is integrity, and it is what would make you change banks.</p>
<h3>Why the distinction suddenly matters</h3>
<p>Inside a single ACID database you rarely need to tell the two apart, because a transaction delivers both at once. Linearizable or serializable reads give you timeliness; atomic commit gives you integrity. The question "which one do I actually need?" never comes up.</p>
<p>Event-based dataflow pulls them apart. Consumers of a log are asynchronous by design, so there is <strong>no timeliness guarantee</strong> unless you build one explicitly, for example by having the client wait until a particular consumer has acknowledged its message. Integrity, on the other hand, is the central concern, and protecting it is the job of the mechanisms in the previous sections. Exactly-once (more precisely, effectively-once) processing is a tool for preserving integrity, not freshness.</p>
<p>That might sound like a step backwards, until you notice that integrity can be maintained with no distributed transactions at all. The transfer recipe in the previous section used four ingredients:</p>`,
        },
        {
          type: "keypoints",
          title: "Integrity without distributed transactions",
          items: [
            "Represent each write as a <strong>single message</strong> that can be appended atomically, which fits event sourcing naturally.",
            "Derive every other state change from that message with <strong>deterministic</strong> functions, like stored procedures that always produce the same output from the same input.",
            "Pass a <strong>client-generated request ID</strong> through every stage of processing, so each stage can suppress duplicates and the pipeline is idempotent end to end.",
            "Keep messages <strong>immutable</strong> and reprocess derived data from time to time, so that bugs can be found and their damage undone.",
          ],
        },
        {
          type: "text",
          html: `<h3>Constraints you can check afterwards</h3>
<p>The uniqueness processor in the previous section rejects the second <code>alice</code> before anyone is welcomed. That costs coordination: the client has to wait for the partition's decision. It's worth asking how many businesses actually need that.</p>
<p>Fewer than you'd think. If two people grab the same username, you can apologize to one and ask them to choose another: a <strong>compensating transaction</strong>. If customers order more units than the warehouse holds, you back-order and apologize. The business has to handle that anyway, because forklifts run over boxes and stock counts drift from reality. Airlines overbook on purpose and compensate bumped passengers. Banks let accounts go overdrawn and charge a fee.</p>
<p>In all of these, it is acceptable to write optimistically and <strong>check the constraint after the fact</strong>, as long as an apology is cheap enough. These are <strong>loosely interpreted constraints</strong>. Pat Helland describes real business logic as working with memories, guesses and apologies: decisions made on partial knowledge and corrected later when the guess turns out wrong.</p>`,
        },
        {
          type: "table",
          title: "When is an apology good enough?",
          headers: ["Constraint", "If it's briefly violated", "Coordinate before acknowledging?"],
          rows: [
            ["Unique username", "Email one user and ask them to pick another name", "Optional: an apology works, but coordinating on the name's partition is cheap, so most products do"],
            ["Seats on a flight", "Rebook the bumped passenger and pay compensation", "No: airlines overbook on purpose"],
            ["A specific concert seat", "Two ticket holders meet at seat 14C", "Yes: decide at the seat's partition"],
            ["Warehouse stock", "Back-order and apologize, as for damaged stock", "No"],
            ["Bank balance stays positive", "Allow the overdraft and charge a fee", "Often not, within an overdraft limit"],
            ["Maximum medication dose", "A patient is harmed; no apology undoes it", "Yes: check before acting"],
            ["Money paid out to another bank", "The money is gone and may not come back", "Yes: validate before the request is recorded"],
          ],
          note: "The deciding questions: what happens if someone briefly sees the constraint violated, and what does the apology cost?",
        },
        {
          type: "text",
          html: `<h3>Coordination-avoiding data systems</h3>
<p>Put these observations together. Dataflow systems can maintain integrity on derived data <strong>without atomic commit, linearizability or synchronous cross-partition coordination</strong>. And although strict constraints such as uniqueness do need timeliness and coordination, many applications are fine with loose constraints that may be violated briefly and fixed up later, as long as integrity holds throughout. A system built this way can even run across several datacenters in a multi-leader configuration, replicating asynchronously between regions, and keep good performance and availability, because no region waits for another.</p>
<p>Coordination then becomes a setting you choose per operation, not a property of the whole system. More synchronous coordination means fewer apologies but lower throughput and availability; less coordination means more apologies. The goal is the sweet spot, not zero apologies at any price. Integrity is not part of that trade: it is protected everywhere, by the four ingredients above. Serializable transactions still have a place, maintaining derived state within one partition or one service, where they are cheap. Heterogeneous distributed transactions across systems (XA) are not needed.</p>
<p>The <strong>saga</strong>, compared with 2PC in <a href="#/ch9/interview/q-2pc-vs-saga">Chapter 9</a>, is a loosely interpreted constraint in practice: a sequence of local transactions, each with a compensating action to run if a later step fails. It gives up isolation, since others can see the half-finished state, and that is acceptable exactly when the apology is cheap.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Airline overbooking",
              tag: "apology as a process",
              html: "Airlines routinely sell more tickets than there are seats and compensate passengers who are denied boarding. In the US, Department of Transportation rules set minimum denied-boarding compensation: a whole business process built around apologizing for a loosely enforced constraint.",
            },
            {
              org: "Amazon Dynamo",
              year: "2007",
              tag: "never reject a write",
              html: "The Dynamo paper describes a shopping cart that always accepts \"add to cart\" writes and merges divergent versions on read. The merge can make a deleted item reappear, a consequence Amazon accepted in exchange for never refusing a customer's write.",
            },
            {
              org: "Pat Helland",
              year: "2007, 2009",
              tag: "memories, guesses, apologies",
              html: "<em>Memories, Guesses, and Apologies</em> (2007) and <em>Building on Quicksand</em> (with Dave Campbell, CIDR 2009) argue that real businesses act on partial knowledge and use compensation rather than global coordination: the intellectual root of this section.",
            },
            {
              org: "Bailis et al.",
              year: "VLDB 2015",
              tag: "invariant confluence",
              html: "<em>Coordination Avoidance in Database Systems</em> introduced invariant confluence, a formal test of which application invariants can be preserved without coordination (foreign keys under inserts, a lower bound on a counter that is only incremented) and which can't (gap-free sequential IDs, a balance that must stay non-negative under concurrent withdrawals).",
            },
          ],
        },
        {
          type: "callout",
          tone: "insight",
          title: "Most complaints are timeliness; most damage is integrity",
          html: `<p>When a user says "I don't see my change", that's timeliness, and it's fixed by waiting, by the <a href="#/ch5/learn/replication-lag">read-your-writes techniques</a> of Chapter 5, or by having the client wait for the consumer. When finance says "the totals don't match", that's integrity, and it won't fix itself. Monitor them differently: alert on <strong>lag</strong> against a threshold users can tolerate, and alert on <strong>invariant violations that persist after the lag has drained</strong>. The $50 alert at the top of this section should never have paged anyone; the double-counted revenue should have.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: do we need a distributed transaction here?",
          html: `<p>For each invariant, ask two questions out loud. What happens if a reader briefly sees it violated? And what does an apology cost? If both answers are acceptable, avoid coordination: write optimistically, check the constraint asynchronously, and compensate when it fails, as with overbooked flights and back-orders. If they aren't (no concert seat may be confirmed to two buyers, no payment may leave the bank twice), put a consensus-backed decision point at the partition that owns the value and make the client wait for its answer.</p>
<p>Either way, say explicitly that integrity mechanisms stay in place: request IDs, deterministic derivation, an immutable log you can reprocess. Strong candidates also put a price on coordination (cross-region latency, unavailability during partitions) and name the apology, instead of reaching for "strong consistency" by reflex.</p>`,
        },
        {
          type: "quiz",
          q: "A dashboard of today's revenue updates every minute from a stream processor. Which of these is an integrity problem rather than a timeliness problem?",
          options: [
            "The last 40 seconds of orders are not yet included",
            "During a broker failover the dashboard freezes for 3 minutes, then catches up",
            "After a consumer restart, a batch of orders is counted twice and the total stays inflated forever",
            "A user on another continent sees each update 2 seconds later than a local user",
          ],
          answer: 2,
          explain: "Double-counting after a restart produces a wrong value that no amount of waiting fixes; it needs deduplication (idempotent processing) or reprocessing from the log. The 3-minute freeze (B) is the tempting choice because it looks like an outage, but the dashboard catches up afterwards with correct numbers: it's a severe timeliness problem, not an integrity one. A and D also heal by waiting.",
        },
      ],
    },

    // ───────────────────────────────────────────────────────────── 8
    {
      id: "trust-but-verify",
      title: "Trust, but verify: systems that check themselves",
      kicker: "Auditability",
      concepts: ["trust-but-verify", "designing-for-auditability", "cryptographic-auditing"],
      blocks: [
        {
          type: "problem",
          html: `<p>Every guarantee in this book rests on a <strong>system model</strong>, a list of assumptions: data that was fsynced survives a crash, memory holds what was written to it, the CPU multiplies correctly, the database enforces the constraints it promises, and our own code does what we think it does. These assumptions are almost always true, which makes it tempting to treat them as always true.</p>
<p>They aren't. Bits flip in RAM and on disks, CPUs occasionally compute wrong answers, mature databases ship isolation bugs, and application code is buggier still. Without verification, corruption is silent: it flows into replicas, backups and derived views, and surfaces months later, if ever. In January 2017, in the middle of an outage, GitLab discovered that none of the five backup and replication mechanisms it relied on was working as assumed.</p>`,
        },
        {
          type: "idea",
          html: `<p>Treat the system model as a <strong>probability, not a fact</strong>. Check continuously, end to end, that data is what it should be: read it back, reconcile derived data against its source, restore the backups. And prefer designs, such as immutable event logs and deterministic derivations, that make those checks possible.</p>`,
        },
        {
          type: "text",
          html: `<h3>When the hardware breaks its promises</h3>
<p>Chapter 8's system models, such as crash-recovery, assume that nodes may crash and restart but never corrupt data or lie. That is a deliberate simplification. Violations are rare, but across thousands of machines, rare events happen every day.</p>
<p>Memory cells can flip on their own, and <strong>rowhammer</strong> showed they can be flipped on purpose: Kim et al. (ISCA 2014) found that repeatedly activating one row of DRAM could flip bits in physically adjacent rows, and in 2015 Google's Project Zero turned that into working privilege-escalation exploits. Network packets occasionally get corrupted in ways that slip past TCP's 16-bit checksum, and disks sometimes return data that differs from what was written, without reporting an error. One corrupted bit in unchecksummed internal messages was enough to take Amazon S3 down for hours in 2008 (<a href="#/ch8/learn/byzantine-faults">Chapter 8</a>).</p>
<h3>When the software breaks its promises</h3>
<p>Software bugs are the more common case. Even mature, widely used databases have shipped bugs that broke their own guarantees, from uniqueness constraints that failed to hold to serializable isolation that let write skew through. Even a mature SSI implementation shipped a serializability bug that only adversarial testing found (<a href="#/ch7/learn/ssi">Jepsen on PostgreSQL 12.3, Chapter 7</a>). Application code is in a worse position: it is tested far less, and many applications use the database's integrity features (foreign keys, uniqueness constraints) incorrectly or not at all. Remember that the C in ACID is the application's job. If the code is wrong, a perfectly serializable database will faithfully store the wrong answer.</p>
<h3>Don't just trust what they promise</h3>
<p>Mature storage systems already work this way. HDFS and Amazon S3 don't fully trust their disks: background processes continually read stored data back, compare it against checksums and other replicas, and re-replicate it when a copy goes bad. The lesson generalizes. If you want to be sure your data is still there, <strong>read it</strong>. If you want to know your backups work, <strong>restore them</strong>, regularly. A backup that has never been restored is a hope, not a backup.</p>
<p>Some systems are built to be self-validating like this, but the norm is the opposite: assume the system is correct because nothing has gone wrong yet. That habit was survivable when one trusted ACID database held everything. As systems with weaker guarantees, such as eventually consistent stores and asynchronous pipelines, spread without a matching culture of auditing, corruption is more likely to go unnoticed.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "GitLab.com",
              year: "2017",
              tag: "untested backups",
              html: `On 31 January 2017 an engineer trying to re-seed a lagging replica (<a href="#/ch5/learn/node-outages">Chapter 5</a>) ran the deletion on the primary by mistake and wiped the production database directory. GitLab's public postmortem reported that none of its five backup and replication techniques was working reliably or set up as assumed. The regular <code>pg_dump</code> backups had been failing silently, because they ran PostgreSQL 9.2 binaries against a 9.6 database, and the cron emails reporting the failures were rejected by the receiving mail server under DMARC, so nobody saw them. GitLab restored from an LVM snapshot that happened to have been taken about six hours earlier and lost roughly six hours of database data; Git repositories were not affected.`,
            },
            {
              org: "Dropbox Pocket Watch",
              year: "2016",
              tag: "verify stored data continuously",
              html: "Dropbox described Pocket Watch, the set of verifiers that run all the time against Magic Pocket, its exabyte-scale block store. A disk scrubber reads every stored byte and checks it against its checksum, a metadata scanner confirms that every block the index refers to really exists on the storage nodes, and another verifier reads back a sample of newly written blocks at intervals after the write. Durability is measured, not assumed.",
            },
            {
              org: "Amazon S3 ShardStore",
              year: "2021",
              tag: "lightweight formal methods",
              html: "When S3 rewrote the storage engine on its storage nodes in Rust, the team checked it against executable reference models: property-based tests compare the real code with a simple model of what it should do, including after injected crashes, and model checkers explore thread interleavings. The approach caught crash-consistency and concurrency bugs before they reached production (Bornholt et al., SOSP 2021).",
            },
          ],
        },
        {
          type: "text",
          html: `<h3>Designing for auditability</h3>
<p>Verification is much easier in some architectures than in others. When a transaction updates rows in place, the database afterwards holds only the result. Ask "why is this balance $412?" and the answer is hard to reconstruct, because the intent behind each change, and the inputs it was computed from, are gone.</p>
<p>Event-based systems keep better <strong>provenance</strong>. The user's input is recorded as an immutable event, and every state update is derived from it deterministically. That makes three things possible. You can rerun a derivation and confirm you get the same result. You can trace any derived value back to the events that produced it, to find out why something happened. And you can run a second, independent derivation side by side and compare the two, a redundant check that catches bugs in either one. When the dataflow is explicit and every derived store names its inputs, this kind of tracing becomes routine, and debugging gets much easier too.</p>
<p>This is the end-to-end argument once more. Each component's checks, a checksum here and a transaction there, cover only that component. Periodically checking the whole pipeline, from raw events to the value a user sees, is the data-system version of an end-to-end checksum. Like a good test suite, it also changes how a team behaves: when you'll find out quickly that a change corrupted something, you can afford to change things faster.</p>`,
        },
        {
          type: "list",
          title: "A practical verification checklist",
          items: [
            "<strong>Reconcile on a schedule:</strong> compare counts and sums between the source and each derived store (orders in the log vs rows in the warehouse, documents in the database vs the search index).",
            "<strong>Recompute a sample:</strong> rebuild a random sample of derived records from raw events with independent code, and diff.",
            "<strong>Scrub storage:</strong> verify checksums and compare replicas in the background, not only when data happens to be read.",
            "<strong>Restore backups:</strong> regularly, into a test environment, and time how long it takes.",
            "<strong>Keep the raw events:</strong> long enough to recompute any derived view after a bug is found.",
            "<strong>Alert on invariants:</strong> ledger debits equal credits, balances are never negative, every order has exactly one payment, checked after lag has drained.",
          ],
        },
        {
          type: "diagram",
          title: "The audit loop",
          svg: `<style>.dd-diagram-body svg.c12e-au-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c12e-au-w{display:none}.dd-diagram-body svg.c12e-au-n{display:block}}</style><svg class="c12e-au-w" viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Immutable events feed a production job that builds the derived view, and separately an independent sampled recomputation. A compare step either confirms a match or raises an alert and replays to repair the view.">
<defs>
<marker id="ch12d2-au-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
<marker id="ch12d2-au-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker>
</defs>
<rect x="10" y="80" width="110" height="60" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="65" y="106" font-size="13" font-weight="700" text-anchor="middle">immutable</text>
<text x="65" y="124" font-size="13" font-weight="700" text-anchor="middle">events</text>
<rect x="160" y="20" width="160" height="52" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="240" y="42" font-size="13" font-weight="700" text-anchor="middle">production job</text>
<text x="240" y="60" font-size="12" text-anchor="middle">stream processor, v3</text>
<rect x="360" y="20" width="120" height="52" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="420" y="42" font-size="13" font-weight="700" text-anchor="middle">derived view</text>
<text x="420" y="60" font-size="12" text-anchor="middle">what users read</text>
<rect x="160" y="148" width="160" height="52" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-dasharray: 5 4"/>
<text x="240" y="170" font-size="13" font-weight="700" text-anchor="middle">independent check</text>
<text x="240" y="188" font-size="12" text-anchor="middle">nightly batch, sampled</text>
<polygon points="420,148 462,174 420,200 378,174" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<text x="420" y="178" font-size="12" font-weight="700" text-anchor="middle">compare</text>
<line x1="120" y1="98" x2="158" y2="58" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch12d2-au-arr)"/>
<line x1="120" y1="122" x2="158" y2="162" style="stroke: var(--viz-muted); stroke-width: 1.5; stroke-dasharray: 5 4" marker-end="url(#ch12d2-au-arr)"/>
<line x1="320" y1="46" x2="358" y2="46" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch12d2-au-arr)"/>
<line x1="420" y1="72" x2="420" y2="146" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch12d2-au-arr)"/>
<text x="428" y="114" font-size="12" style="fill: var(--viz-muted)">sample</text>
<line x1="320" y1="174" x2="376" y2="174" style="stroke: var(--viz-muted); stroke-width: 1.5; stroke-dasharray: 5 4" marker-end="url(#ch12d2-au-arr)"/>
<line x1="462" y1="174" x2="498" y2="132" style="stroke: var(--viz-bad); stroke-width: 1.5" marker-end="url(#ch12d2-au-bad)"/>
<line x1="462" y1="174" x2="498" y2="184" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#ch12d2-au-arr)"/>
<rect x="500" y="104" width="130" height="46" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="565" y="123" font-size="12" text-anchor="middle">mismatch: alert,</text>
<text x="565" y="141" font-size="12" text-anchor="middle">replay to repair</text>
<rect x="500" y="168" width="130" height="34" rx="8" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="565" y="190" font-size="12" text-anchor="middle">match: confidence</text>
<path d="M565 104 L565 46 L484 46" style="fill: none; stroke: var(--viz-bad); stroke-width: 1.5; stroke-dasharray: 5 4" marker-end="url(#ch12d2-au-bad)"/>
<text x="572" y="80" font-size="12" style="fill: var(--viz-bad)">repair</text>
</svg><svg class="c12e-au-n" viewBox="0 0 360 306" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Immutable events feed a production job that builds the derived view, and separately an independent sampled recomputation. A compare step either confirms a match or raises an alert and replays to repair the view.">
<defs><marker id="c12e-au-n-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker><marker id="c12e-au-n-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker></defs>
<rect x="110" y="8" width="140" height="44" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="180" y="35" font-size="13" font-weight="700" text-anchor="middle">immutable events</text>
<line x1="160" y1="52" x2="104" y2="82" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#c12e-au-n-arr)"/>
<line x1="200" y1="52" x2="256" y2="82" style="stroke: var(--viz-muted); stroke-width: 1.5; stroke-dasharray: 5 4" marker-end="url(#c12e-au-n-arr)"/>
<rect x="12" y="84" width="160" height="50" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="92" y="105" font-size="13" font-weight="700" text-anchor="middle">production job</text>
<text x="92" y="123" font-size="12" text-anchor="middle">stream processor, v3</text>
<rect x="188" y="84" width="160" height="50" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke); stroke-dasharray: 5 4"/>
<text x="268" y="105" font-size="13" font-weight="700" text-anchor="middle">independent check</text>
<text x="268" y="123" font-size="12" text-anchor="middle">nightly batch, sampled</text>
<line x1="92" y1="134" x2="92" y2="164" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#c12e-au-n-arr)"/>
<rect x="12" y="166" width="160" height="50" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="92" y="187" font-size="13" font-weight="700" text-anchor="middle">derived view</text>
<text x="92" y="205" font-size="12" text-anchor="middle">what users read</text>
<line x1="268" y1="134" x2="268" y2="164" style="stroke: var(--viz-muted); stroke-width: 1.5; stroke-dasharray: 5 4" marker-end="url(#c12e-au-n-arr)"/>
<polygon points="268,166 314,192 268,218 222,192" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<text x="268" y="196" font-size="12" font-weight="700" text-anchor="middle">compare</text>
<line x1="172" y1="191" x2="220" y2="191" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#c12e-au-n-arr)"/>
<text x="196" y="182" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">sample</text>
<line x1="245" y1="205" x2="152" y2="248" style="stroke: var(--viz-bad); stroke-width: 1.5" marker-end="url(#c12e-au-n-bad)"/>
<line x1="268" y1="218" x2="268" y2="248" style="stroke: var(--viz-muted); stroke-width: 1.5" marker-end="url(#c12e-au-n-arr)"/>
<rect x="12" y="250" width="160" height="46" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="92" y="269" font-size="12" text-anchor="middle">mismatch: alert,</text>
<text x="92" y="287" font-size="12" text-anchor="middle">replay to repair</text>
<rect x="188" y="250" width="160" height="46" rx="8" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
<text x="268" y="278" font-size="12" text-anchor="middle">match: confidence</text>
<line x1="40" y1="250" x2="40" y2="220" style="stroke: var(--viz-bad); stroke-width: 1.5; stroke-dasharray: 5 4" marker-end="url(#c12e-au-n-bad)"/>
<text x="48" y="240" font-size="12" style="fill: var(--viz-bad)">repair</text>
</svg>`,
          caption: "Two independent paths from the same immutable events. The production job builds what users read; a separate, simpler recomputation checks a sample of it. A mismatch is caught by the comparison, not by a user, and repaired by replaying the log.",
        },
        {
          type: "text",
          html: `<h3>Tools for auditable systems</h3>
<p>Checks run by an operator assume the operator is honest. For data where that isn't enough, such as financial ledgers, certificate issuance or software releases, cryptography can make tampering <strong>detectable by anyone</strong>.</p>
<p>The workhorse is the <strong>Merkle tree</strong>, or hash tree: hash each record, then hash pairs of hashes, and so on up to a single root. The root is a short fingerprint of the entire dataset. Change one record and the root changes, so anyone holding an earlier root can detect that history was rewritten. Proving that one record is included takes only the sibling hashes along its path to the root, a number that grows logarithmically with the size of the dataset. Git's object store uses the same idea: commits, trees and file contents are addressed by their hashes, forming a Merkle DAG, so a single commit hash vouches for the entire history behind it.</p>`,
        },
        {
          type: "diagram",
          title: "A Merkle tree over four events",
          svg: `<style>.dd-diagram-body svg.c12e-mk-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c12e-mk-w{display:none}.dd-diagram-body svg.c12e-mk-n{display:block}}</style><svg class="c12e-mk-w" viewBox="0 0 520 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Four events hashed pairwise into a root. Editing event 3 changes h3, h34 and the root. Proving event 3 is included needs only h4 and h12.">
<line x1="70" y1="196" x2="70" y2="170" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="190" y1="196" x2="190" y2="170" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="330" y1="196" x2="330" y2="170" style="stroke: var(--viz-bad); stroke-width: 2"/>
<line x1="450" y1="196" x2="450" y2="170" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="70" y1="140" x2="110" y2="110" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="190" y1="140" x2="150" y2="110" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="330" y1="140" x2="370" y2="110" style="stroke: var(--viz-bad); stroke-width: 2"/>
<line x1="450" y1="140" x2="410" y2="110" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="130" y1="76" x2="230" y2="46" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="390" y1="76" x2="290" y2="46" style="stroke: var(--viz-bad); stroke-width: 2"/>
<rect x="170" y="12" width="180" height="34" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad); stroke-width: 2"/>
<text x="260" y="34" font-size="13" font-weight="700" text-anchor="middle">root = H(h12, h34)</text>
<rect x="50" y="76" width="160" height="34" rx="8" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<text x="130" y="98" font-size="13" text-anchor="middle">h12 = H(h1, h2)</text>
<rect x="310" y="76" width="160" height="34" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="390" y="98" font-size="13" text-anchor="middle">h34 = H(h3, h4)</text>
<rect x="35" y="140" width="70" height="30" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="70" y="160" font-size="13" text-anchor="middle">h1</text>
<rect x="155" y="140" width="70" height="30" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="190" y="160" font-size="13" text-anchor="middle">h2</text>
<rect x="295" y="140" width="70" height="30" rx="6" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="330" y="160" font-size="13" text-anchor="middle">h3</text>
<rect x="415" y="140" width="70" height="30" rx="6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<text x="450" y="160" font-size="13" text-anchor="middle">h4</text>
<rect x="15" y="196" width="110" height="30" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="70" y="216" font-size="12" text-anchor="middle">event 1</text>
<rect x="135" y="196" width="110" height="30" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="190" y="216" font-size="12" text-anchor="middle">event 2</text>
<rect x="275" y="196" width="110" height="30" rx="6" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="330" y="216" font-size="12" font-weight="700" text-anchor="middle">event 3 (edited)</text>
<rect x="395" y="196" width="110" height="30" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="450" y="216" font-size="12" text-anchor="middle">event 4</text>
<rect x="20" y="238" width="14" height="14" rx="3" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="40" y="250" font-size="12">changes when event 3 is edited</text>
<rect x="280" y="238" width="14" height="14" rx="3" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<text x="300" y="250" font-size="12">proof that event 3 is included</text>
</svg><svg class="c12e-mk-n" viewBox="0 0 360 284" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Four events hashed pairwise into a root. Editing event 3 changes h3, h34 and the root. Proving event 3 is included needs only h4 and h12.">
<line x1="45" y1="184" x2="45" y2="158" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="125" y1="184" x2="125" y2="158" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="235" y1="184" x2="235" y2="158" style="stroke: var(--viz-bad); stroke-width: 2"/>
<line x1="315" y1="184" x2="315" y2="158" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="45" y1="130" x2="70" y2="102" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="125" y1="130" x2="100" y2="102" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="235" y1="130" x2="260" y2="102" style="stroke: var(--viz-bad); stroke-width: 2"/>
<line x1="315" y1="130" x2="290" y2="102" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="85" y1="70" x2="150" y2="42" style="stroke: var(--viz-muted); stroke-width: 1.5"/>
<line x1="275" y1="70" x2="210" y2="42" style="stroke: var(--viz-bad); stroke-width: 2"/>
<rect x="95" y="10" width="170" height="32" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad); stroke-width: 2"/>
<text x="180" y="31" font-size="13" font-weight="700" text-anchor="middle">root = H(h12, h34)</text>
<rect x="10" y="70" width="150" height="32" rx="8" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<text x="85" y="91" font-size="12" text-anchor="middle">h12 = H(h1, h2)</text>
<rect x="200" y="70" width="150" height="32" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="275" y="91" font-size="12" text-anchor="middle">h34 = H(h3, h4)</text>
<rect x="15" y="130" width="60" height="28" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="45" y="149" font-size="12" text-anchor="middle">h1</text>
<rect x="95" y="130" width="60" height="28" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="125" y="149" font-size="12" text-anchor="middle">h2</text>
<rect x="205" y="130" width="60" height="28" rx="6" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="235" y="149" font-size="12" text-anchor="middle">h3</text>
<rect x="285" y="130" width="60" height="28" rx="6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<text x="315" y="149" font-size="12" text-anchor="middle">h4</text>
<rect x="8" y="184" width="74" height="36" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="45" y="206" font-size="12" text-anchor="middle">event 1</text>
<rect x="88" y="184" width="74" height="36" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="125" y="206" font-size="12" text-anchor="middle">event 2</text>
<rect x="198" y="184" width="74" height="36" rx="6" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="235" y="199" font-size="12" font-weight="700" text-anchor="middle">event 3</text>
<text x="235" y="214" font-size="11" text-anchor="middle">(edited)</text>
<rect x="278" y="184" width="74" height="36" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="315" y="206" font-size="12" text-anchor="middle">event 4</text>
<rect x="12" y="238" width="14" height="14" rx="3" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="32" y="250" font-size="12">changes when event 3 is edited</text>
<rect x="12" y="262" width="14" height="14" rx="3" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<text x="32" y="274" font-size="12">proof that event 3 is included</text>
</svg>`,
          caption: "Changing any record changes every hash on its path to the root, so an auditor holding an old root detects a rewritten history. Proving that event 3 is in the tree needs only h4 and h12: two hashes for four records, about 20 for a million.",
        },
        {
          type: "text",
          html: `<p><strong>Certificate Transparency</strong> (RFC 6962, 2013) applies this to the web's certificate authorities. CAs submit the TLS certificates they issue to public, append-only Merkle-tree logs, because Chrome and Safari reject publicly trusted certificates without proof of logging (Chrome requires it for certificates issued after April 2018, enforced from Chrome 68 that July). Log servers publish signed tree roots, and anyone can verify both that a certificate is in a log and that the log has only grown, never been rewritten, so a certificate misissued for your domain can't be quietly hidden. The same transparency-log design now also records software signatures, for example in Sigstore's Rekor.</p>
<p><strong>Blockchains</strong> such as Bitcoin and Ethereum go further: they are distributed databases that replicate a hash-chained log among mutually distrusting parties, using consensus that tolerates Byzantine faults (the nodes that lie, from Chapter 8). The book is cautious about them as general-purpose data systems: their throughput is low, and proof-of-work consensus wastes enormous amounts of energy. (Ethereum has since moved from proof-of-work to proof-of-stake, in September 2022.) The more durable bet is narrower: integrity-checking structures like Merkle trees and transparency logs are likely to find their way into ordinary data systems.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          title: "Since the book: CPUs that silently compute wrong answers",
          html: `<p>In 2021 two hyperscalers reported a failure mode that no component-level guarantee covers. Google's <em>Cores that don't count</em> (HotOS 2021) and Meta's <em>Silent Data Corruptions at Scale</em> (2021) described CPUs, a small fraction of a large fleet, that occasionally return wrong results for particular computations without raising any machine-check error or log entry. Google called them "mercurial cores". At fleet scale, they turned up often enough that both companies built dedicated detection.</p>
<p>No checksum on disk or network catches a multiplication that came out wrong before the data was ever written. Only application-level checks do: recomputing results, comparing redundant derivations, and checking invariants. That is the trust-but-verify argument, made by the hardware itself.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: how would you know a derived store has silently diverged?",
          html: `<p>Weak answers stop at monitoring the job: no errors, low consumer lag. That proves the job is running, not that its output is right. A strong answer defines invariants that can be computed independently from the source and from the derived store (row counts and sums per day or per partition, say), and runs a reconciliation job that compares them once the lag window has passed. It adds sampled, record-level recomputation from the raw events using a separate code path, and range hashes to find <em>where</em> two copies differ cheaply, the same Merkle-tree trick Cassandra and Dynamo use for anti-entropy repair between replicas.</p>
<p>Then close the loop. A persistent mismatch pages someone, the view is repaired by replaying the log, and the check itself is tested by deliberately injecting a corrupt record, so you know the alarm actually rings.</p>`,
        },
        {
          type: "quiz",
          q: "Your team's warehouse table of daily revenue is derived from an event log by a stream job. Which check gives the strongest evidence that the table is correct?",
          options: [
            "Monitoring shows the stream job has had no errors or restarts for 90 days",
            "The warehouse uses a database with serializable transactions",
            "Periodically recomputing the daily totals from the raw events with independent code, and diffing against the table",
            "The stream processor is configured for exactly-once semantics",
          ],
          answer: 2,
          explain: "Only an end-to-end check compares the output with what it should be. Exactly-once (D) is the tempting answer, but it only promises that each event affects the state once; a bug in your aggregation logic is applied exactly once too, and the setting can be misconfigured. A clean error log (A) says nothing about logic bugs or silent corruption, and serializable storage (B) faithfully stores whatever wrong numbers it is given.",
        },
      ],
    },

    // ───────────────────────────────────────────────────────────── 9
    {
      id: "predictive-analytics",
      title: "When the model says no: bias, accountability and feedback loops",
      kicker: "Doing the right thing",
      concepts: ["predictive-analytics", "feedback-loops-in-data-driven-decisions", "algorithmic-accountability"],
      blocks: [
        {
          type: "problem",
          html: `<p>The pipelines in this book increasingly do more than count page views. They decide things about people: who gets a loan, a job interview or an insurance quote, who is granted parole, whose account is frozen for suspected fraud. A wrong weather forecast costs someone an umbrella. A wrong risk prediction about a person can shut them out of credit, housing and work, often with nobody able to explain the decision or overturn it.</p>
<p>The naive assumption is that an algorithm is more objective than a person because it "only looks at the data". But the data is a record of the past, discrimination included, and the model's own decisions shape the data it will learn from next.</p>`,
        },
        {
          type: "idea",
          html: `<p>A predictive model <strong>extrapolates from the past</strong>, and its decisions change the future data. So it can encode bias, escape accountability and even fulfil its own predictions. The engineers who build these pipelines share responsibility for what they do, and must design for <strong>scrutiny, recourse and counterfactual evidence</strong>.</p>`,
        },
        {
          type: "text",
          html: `<h3>Doing the right thing</h3>
<p>The book ends by stepping back from mechanism. Every system is built for a purpose, but its consequences reach beyond it, and many of the systems in this book hold data about people: their behaviour, money, health and relationships. Those people deserve to be treated with humanity and respect, not as rows. Codes such as the ACM's Software Engineering Code of Ethics and Professional Practice exist, but they are rarely discussed and even more rarely applied. "I just built the pipeline" is no defence: whoever decides what is collected, how it is joined and what it is used for shapes the outcome.</p>
<h3>Predictions about individuals</h3>
<p>Forecasting the weather is one thing. Predicting whether a <em>particular person</em> will reoffend, default on a loan, file expensive insurance claims or do well in a job is another, because the prediction becomes a decision that changes that person's life.</p>
<p>The incentives all push one way. A wrong yes shows up as a loss on the books; a wrong no is never seen, because the rejected person simply goes away. So organizations rationally <strong>err on the side of caution</strong>, and people are wrongly excluded. When scores and datasets are shared across companies, someone flagged by one model can find doors closing everywhere at once: jobs, flights, insurance, rental housing, bank accounts. The book adopts the term "algorithmic prison" for this: a sentence without a trial, without a presumption of innocence, and with little chance of appeal.</p>
<h3>Bias and discrimination</h3>
<p>Algorithmic decisions are not automatically better or worse than human ones. People are biased, and a model trained on their past decisions learns their biases. Deleting the protected attribute doesn't fix that, because other features correlate with it: a postal code or an IP address can be an excellent predictor of race. A model with race removed from its inputs can still learn it from <strong>proxies</strong>.</p>
<p>Predictive analytics only <strong>extrapolates the past</strong>. If the past was discriminatory, the model codifies the discrimination and applies it at scale, with an air of mathematical objectivity; Maciej Ceglowski, in his 2016 talk <em>The Moral Economy of Tech</em>, called machine learning "money laundering for bias". Making the future better than the past takes moral imagination, and that has to come from people, not from the training data.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "ProPublica: COMPAS",
              year: "2016",
              tag: "risk scores in court",
              html: "ProPublica's analysis of the COMPAS recidivism score in Broward County, Florida found that among defendants who did not reoffend, Black defendants had been labelled higher risk about 45% of the time, against about 23% for white defendants. The vendor, Northpointe, disputed the analysis, arguing that the score was equally well calibrated for both groups. Both claims can hold at once, as the callout further down explains.",
            },
            {
              org: "Amazon recruiting tool",
              year: "2018",
              tag: "learned from the past",
              html: "Reuters reported that Amazon had scrapped an experimental machine-learning résumé screener after finding that it penalized résumés containing the word \"women's\". It had learned from about a decade of past applications, most of them from men. Amazon said the tool was never used by its recruiters to evaluate candidates.",
            },
            {
              org: "Obermeyer et al., Science",
              year: "2019",
              tag: "proxy variable",
              html: "A widely used US healthcare algorithm predicted future healthcare costs as a proxy for medical need. Because less money had historically been spent on Black patients with the same level of need, it substantially underestimated how sick they were, even though race was not one of its inputs.",
            },
            {
              org: "UK A-level grades",
              year: "2020",
              tag: "a school's past, applied to a student",
              html: "With exams cancelled, England's regulator Ofqual adjusted teacher-assessed grades using a standardization model that leaned on each school's historical results; around 39% of grades came out lower than teachers had assessed. After a public outcry, the government reverted to teacher-assessed grades within days.",
            },
            {
              org: "Dutch childcare benefits",
              year: "2021",
              tag: "no recourse",
              html: "In the toeslagenaffaire, the Dutch tax authority wrongly accused thousands of families of childcare-benefit fraud and demanded repayments that pushed many into debt. A risk-classification model that used nationality as a risk factor was part of the process. The scandal led the Dutch government to resign in January 2021.",
            },
          ],
        },
        {
          type: "text",
          html: `<h3>Who answers for a wrong decision?</h3>
<p>When a person decides wrongly about you, you can ask for their reasons, appeal, or go to court. When an algorithm does, responsibility diffuses: the credit agency, the data broker, the model vendor, the deploying company and the engineer can each point at someone else.</p>
<p>A traditional credit score answers a narrow question, "how have you behaved in the past?", from a record that people can, in many countries, obtain and correct. A model built on hundreds of behavioural signals asks instead "who is similar to you, and how did people like you behave?" That is stereotyping with better statistics. And a model that is right on average is still often wrong about individuals, just as an average life expectancy of 80 says nothing certain about your own. If algorithms decide about people, they must be <strong>accountable and transparent</strong>: decisions explainable, errors correctable, biases measured rather than assumed absent.</p>
<h3>When the output becomes the input</h3>
<p>The book's sharpest example is a spiral. Someone in good standing suffers a misfortune beyond their control and misses payments. Their credit score drops, employers who screen by credit score turn them down, and unemployment pushes the score lower still. Each step looks reasonable; together they let the model's verdict cause the outcome it predicted, behind a veneer of mathematical rigour.</p>`,
        },
        {
          type: "diagram",
          title: "The credit spiral",
          svg: `<style>.dd-diagram-body svg.c12e-cs-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c12e-cs-w{display:none}.dd-diagram-body svg.c12e-cs-n{display:block}}</style><svg class="c12e-cs-w" viewBox="0 0 520 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A misfortune causes missed payments, which lower a credit score; employers using credit checks say no; unemployment lowers income, which lowers the score again, in a loop.">
<defs>
<marker id="ch12d2-cs-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker>
<marker id="ch12d2-cs-warn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-warn)"/></marker>
</defs>
<rect x="10" y="14" width="150" height="50" rx="12" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="85" y="35" font-size="13" font-weight="700" text-anchor="middle">misfortune:</text>
<text x="85" y="53" font-size="12" text-anchor="middle">missed payments</text>
<rect x="220" y="14" width="170" height="50" rx="12" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="305" y="44" font-size="13" font-weight="700" text-anchor="middle">credit score drops</text>
<rect x="330" y="168" width="180" height="56" rx="12" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="420" y="192" font-size="13" text-anchor="middle">employers using</text>
<text x="420" y="211" font-size="13" text-anchor="middle">credit checks say no</text>
<rect x="10" y="168" width="180" height="56" rx="12" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="100" y="192" font-size="13" text-anchor="middle">unemployment,</text>
<text x="100" y="211" font-size="13" text-anchor="middle">less income</text>
<line x1="160" y1="39" x2="216" y2="39" style="stroke: var(--viz-warn); stroke-width: 2" marker-end="url(#ch12d2-cs-warn)"/>
<line x1="360" y1="64" x2="408" y2="164" style="stroke: var(--viz-bad); stroke-width: 2" marker-end="url(#ch12d2-cs-arr)"/>
<line x1="330" y1="196" x2="194" y2="196" style="stroke: var(--viz-bad); stroke-width: 2" marker-end="url(#ch12d2-cs-arr)"/>
<line x1="110" y1="168" x2="248" y2="69" style="stroke: var(--viz-bad); stroke-width: 2" marker-end="url(#ch12d2-cs-arr)"/>
<text x="290" y="104" font-size="13" font-weight="700" text-anchor="middle">feedback loop</text>
<text x="290" y="124" font-size="13" text-anchor="middle">the model's output</text>
<text x="290" y="142" font-size="13" text-anchor="middle">becomes its future input</text>
</svg><svg class="c12e-cs-n" viewBox="0 0 360 216" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A misfortune causes missed payments, which lower a credit score; employers using credit checks say no; unemployment lowers income, which lowers the score again, in a loop.">
<defs><marker id="c12e-cs-n-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker><marker id="c12e-cs-n-warn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-warn)"/></marker></defs>
<rect x="8" y="10" width="150" height="50" rx="12" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<text x="83" y="31" font-size="13" font-weight="700" text-anchor="middle">misfortune:</text>
<text x="83" y="49" font-size="12" text-anchor="middle">missed payments</text>
<rect x="202" y="10" width="150" height="50" rx="12" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="277" y="31" font-size="13" font-weight="700" text-anchor="middle">credit score</text>
<text x="277" y="49" font-size="13" font-weight="700" text-anchor="middle">drops</text>
<rect x="202" y="150" width="150" height="56" rx="12" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="277" y="174" font-size="12" text-anchor="middle">employers using</text>
<text x="277" y="192" font-size="12" text-anchor="middle">credit checks say no</text>
<rect x="8" y="150" width="150" height="56" rx="12" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="83" y="174" font-size="12" text-anchor="middle">unemployment,</text>
<text x="83" y="192" font-size="12" text-anchor="middle">less income</text>
<line x1="158" y1="35" x2="198" y2="35" style="stroke: var(--viz-warn); stroke-width: 2" marker-end="url(#c12e-cs-n-warn)"/>
<line x1="300" y1="60" x2="300" y2="146" style="stroke: var(--viz-bad); stroke-width: 2" marker-end="url(#c12e-cs-n-arr)"/>
<line x1="202" y1="178" x2="162" y2="178" style="stroke: var(--viz-bad); stroke-width: 2" marker-end="url(#c12e-cs-n-arr)"/>
<line x1="140" y1="150" x2="222" y2="64" style="stroke: var(--viz-bad); stroke-width: 2" marker-end="url(#c12e-cs-n-arr)"/>
<text x="70" y="92" font-size="12" font-weight="700" text-anchor="middle">feedback loop</text>
<text x="70" y="108" font-size="12" text-anchor="middle">the model's output</text>
<text x="70" y="124" font-size="12" text-anchor="middle">becomes its input</text>
</svg>`,
          caption: "One misfortune enters the loop; the loop does the rest. No single step is unreasonable, which is why the spiral is hard to see from inside any one system.",
        },
        {
          type: "text",
          html: `<p>The simulation below makes the loop visible in a toy lending market. Two groups of 100 applicants have <strong>exactly the same true ability</strong> to repay; group G2 just starts with scores 12 points lower, as thin credit files tend to. Each round, the lender approves anyone whose score clears the threshold. An approved loan reveals the borrower's real ability and moves their score toward it. A denial reveals nothing; the score even slips a little each round as the file stays thin, and with "Denial harms finances" on, the person's real ability to repay erodes too.</p>`,
        },
        {
          type: "viz",
          id: "ch12/feedback-loop",
          title: "The self-fulfilling model",
          caption: "Try 'Run 10 rounds' twice with the defaults, then Reset and repeat with 'Explore' on, or with the starting gap at 0. Notice that the approval gap persists although both groups start with identical ability, that G2's approved borrowers repay at least as often as G1's (so the lender's own data looks fine), and how many creditworthy G2 applicants end up pushed below the bar.",
        },
        {
          type: "text",
          html: `<h3>Selective labels: the data can't prove the model wrong</h3>
<p>What you just watched is called <strong>selective labels</strong> in machine learning. When the model says no, the outcome that would show whether it was right (would this person have repaid?) is never observed. The lender's data contains only the people it chose to trust, so it can confirm a yes but never refute a no, and the starting bias never washes out.</p>
<p>Notice the repayment rates too. G2's approved borrowers repay at least as often as G1's, which a lender reads as "the model works". It is actually a warning sign: if approved members of one group do better, that group probably faced a stricter effective bar. This <strong>outcome test</strong> isn't proof (economists call its blind spot infra-marginality), but it is worth monitoring, and it is invisible if you only track an overall default rate.</p>
<p>When denial also harms people, the bias becomes <strong>self-fulfilling</strong>: creditworthy people who were turned away become less creditworthy. Recommendation systems show the same dynamic across whole societies, feeding people more of what they already engage with and building echo chambers where stereotypes, misinformation and polarization reinforce themselves.</p>
<p>The engineering responses all add evidence the model can't produce on its own: <strong>exploration</strong> (approving a small random fraction of applicants the model would reject), counterfactual evaluation of new policies against logged decisions, outcome monitoring by group, and human review with a real path to appeal. The book's broader advice is <strong>systems thinking</strong>: analyze the whole system, including the people in it, and ask whether it amplifies existing differences or works against them.</p>`,
        },
        {
          type: "callout",
          tone: "insight",
          title: "Why the COMPAS debate had no technical answer",
          html: `<p>ProPublica measured <strong>error rates</strong>: among people who did not reoffend, how often were they labelled high risk? Northpointe measured <strong>calibration</strong>: among people given the same score, did they reoffend at the same rate regardless of race? Kleinberg, Mullainathan and Raghavan (2016) and Chouldechova (2017) proved that when the base rates differ between groups, a risk score cannot satisfy both at once, unless it predicts perfectly. Choosing a fairness criterion means deciding whose mistakes count more, and that is a value judgment, not something a better algorithm can settle.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          title: "Since the book: the law starts to catch up",
          html: `<ul><li><strong>GDPR Article 22</strong> (applicable since 25 May 2018) gives people the right not to be subject to decisions based solely on automated processing that significantly affect them, with safeguards such as the right to obtain human intervention and to contest the decision.</li><li>The <strong>EU AI Act</strong> (in force since August 2024) classifies AI systems used to assess individuals' creditworthiness or to screen job applicants as high-risk, bringing obligations for risk management, data governance, logging and human oversight that phase in over the following years.</li><li>In the US, the <strong>Equal Credit Opportunity Act</strong> and Regulation B already required lenders to give the specific reasons for turning an applicant down; in 2022 the CFPB stated that using a complex model is no excuse for failing to do so.</li></ul>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: your fraud model blocks users. How do you know it's right?",
          html: `<p>Start by naming the trap: you only observe outcomes for transactions you allowed, so retraining on your own outcomes can entrench whatever the model already believes. A strong answer adds counterfactual evidence. Keep a small, randomized exploration bucket, letting through a capped fraction of would-be blocks or applying the old policy to a slice of traffic, and log the probability of each decision so new models can be evaluated offline against it. Sample blocked cases for manual review and treat appeals as labelled data. Track block rates, error rates and the outcome test per segment, and look for proxy features standing in for protected attributes.</p>
<p>Finish with accountability: log the inputs, model version, score and reason codes for every decision, so any single decision can be explained and reversed. Mention the cost honestly: exploration lets some fraud through, and that loss is the price of finding out what your "no" is costing.</p>`,
        },
        {
          type: "quiz",
          q: "A lender's model denies most applicants from one neighborhood. Its monitoring shows that approved borrowers from that neighborhood repay as often as everyone else. Why doesn't that show the model is fair?",
          options: [
            "Because repayment rates are always too noisy to draw conclusions from",
            "Because it only measures people the model approved; nobody observes whether the denied applicants would have repaid (selective labels), so wrongful denials are invisible in the data",
            "Because the neighborhood is a protected attribute and must be removed from the model",
            "Because the model should apply a higher threshold to that neighborhood to be safe",
          ],
          answer: 1,
          explain: "Outcome data exists only for approved loans, so the cost of a wrongful no never appears; worse, denial can harm people and make the prediction come true, and an equal or higher repayment rate among the few who were approved can even hint at a stricter bar. Learning the truth requires exploration or other counterfactual evidence. Option C is tempting, but a neighborhood isn't itself a protected attribute; it is a possible proxy for one, and deleting it doesn't create the missing outcome data. Noise (A) isn't the issue, and a higher threshold (D) deepens the problem.",
        },
      ],
    },

    // ───────────────────────────────────────────────────────────── 10
    {
      id: "privacy-and-tracking",
      title: "Data is about people: surveillance, consent and keeping less",
      kicker: "Doing the right thing",
      concepts: ["surveillance-capitalism-privacy", "consent-and-choice", "data-minimization"],
      blocks: [
        {
          type: "problem",
          html: `<p>The architecture of this chapter makes it cheap to capture every event forever and derive anything from it later. That is its strength. Pointed at user behaviour, the same strength becomes tracking: every click, location ping and search turns into a permanent, replayable record that can be joined, mined and sold, by the company itself or by whoever later breaches it, buys it or subpoenas it.</p>
<p>The usual safeguards turn out to be weak. "Anonymized" datasets identify people. "Consent" is a click on terms nobody reads. Data collected for one purpose is quietly reused for another. The naive view that more data is always an asset ignores that data is also a liability, and a source of power over the people it describes.</p>`,
        },
        {
          type: "idea",
          html: `<p>Treat behavioural data as <strong>surveillance unless proven otherwise</strong>. Collect only what a purpose users understand requires, give them real control, purge the data when the purpose is served, and remember that every retained event is a future liability.</p>`,
        },
        {
          type: "text",
          html: `<h3>Service or surveillance?</h3>
<p>When a system stores only what users deliberately entered, so that it can do what they asked (keep their documents, deliver their messages), it performs a service for them. Things change when it records their behaviour as a side effect: every page viewed, how long they lingered, where they were. If the business model depends on that behavioural data, typically to sell targeted advertising, the user is no longer really the customer. The advertisers are, and the user's interests come second to theirs.</p>
<p>Shoshana Zuboff calls the economic system built on this <em>surveillance capitalism</em>, a term from her 2015 paper that her 2019 book made widely known. The book makes the same point with a simpler device of its own.</p>`,
        },
        {
          type: "callout",
          tone: "insight",
          title: "Replace \"data\" with \"surveillance\"",
          html: `<p>Take any phrase from a data-platform pitch and swap one word. "We monetize our surveillance assets." "Surveillance-driven product decisions." "Our new chief surveillance officer." "A petabyte-scale surveillance lake." If the sentence now sounds sinister, ask what changed besides the word. The thought experiment makes the book's point: through phones, smart TVs, voice assistants and connected devices, we have built an infrastructure of surveillance more pervasive than any past regime could have imposed, and people installed it voluntarily.</p>`,
        },
        {
          type: "text",
          html: `<h3>Consent and freedom of choice</h3>
<p>The standard defence is that users agreed to it. But consent means little without understanding. Most users have no idea what is collected or how it is combined, privacy policies obscure more than they reveal, and the terms are set by the service, not negotiated. Data flows one way: out of the user.</p>
<p>Declining isn't a real option either. Once a platform is a prerequisite for social life, for finding work or for keeping in touch with family, network effects make "just don't use it" expensive, and opting out becomes a privilege of people with the time, knowledge and alternatives to do it. Consent also stops at the individual: one user's data reveals things about people who never agreed to anything, such as the contacts in an address book or the relatives who share their DNA.</p>
<p><strong>Privacy isn't secrecy.</strong> It is the freedom to decide what to reveal, to whom and in which context: you might tell your doctor and a support group about a diagnosis, but not your employer. Surveillance moves that decision from the individual to the company holding the data. The company can infer things users never disclosed, and it mostly keeps those inferences to itself, because showing people what is known about them would feel creepy. Who sees an inference, and why, is then decided by profit rather than by the person it describes.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "AOL search logs",
              year: "2006",
              tag: "pseudonyms aren't anonymity",
              html: "AOL published about 20 million search queries from roughly 650,000 users, with names replaced by numbers. Within days, The New York Times identified user No. 4417749 from her searches alone. AOL withdrew the data and apologized.",
            },
            {
              org: "Netflix Prize",
              year: "2006–2010",
              tag: "sparse data is a fingerprint",
              html: "Narayanan and Shmatikov showed (preprint 2006, IEEE S&amp;P 2008) that \"anonymized\" Netflix Prize ratings could be re-identified by matching a handful of ratings and dates against public IMDb reviews. Netflix cancelled a planned second contest in 2010 after a lawsuit and an FTC inquiry.",
            },
            {
              org: "Strava Global Heatmap",
              year: "2018",
              tag: "aggregates leak too",
              html: "In January 2018, analysts noticed that Strava's public heatmap of aggregated fitness-tracker activity revealed the layout of military bases and patrol routes in places such as Syria and Afghanistan: aggregated, \"anonymous\" location data exposing sensitive facts.",
            },
            {
              org: "Cambridge Analytica",
              year: "2018–2019",
              tag: "one user's consent, others' data",
              html: "Data on up to 87 million Facebook users was harvested through a personality-quiz app, most of them friends of the people who installed it. In 2019 the FTC fined Facebook $5 billion for privacy violations.",
            },
            {
              org: "Equifax",
              year: "2017",
              tag: "data as liability",
              html: "The 2017 Equifax breach exposed personal data, including Social Security numbers, of about 147 million people, none of whom had chosen to give their data to Equifax.",
            },
          ],
        },
        {
          type: "text",
          html: `<h3>Why "anonymized" rarely is</h3>
<p>Stripping names from a dataset feels like anonymization. Usually it isn't, because the remaining columns act as <strong>quasi-identifiers</strong>: values that are harmless one at a time but unique in combination. Latanya Sweeney estimated, from 1990 US census data, that ZIP code, birth date and sex alone single out about 87% of Americans; Philippe Golle's 2006 re-estimate put it at about 63%, still a clear majority. In 1997 she demonstrated what that means by joining "anonymized" health-insurance records of Massachusetts state employees with a voter roll bought for $20, and picking out the governor's medical records.</p>`,
        },
        {
          type: "diagram",
          title: "Re-identification by join",
          svg: `<style>.dd-diagram-body svg.c12e-rj-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c12e-rj-w{display:none}.dd-diagram-body svg.c12e-rj-n{display:block}}</style><svg class="c12e-rj-w" viewBox="0 0 640 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="An anonymized health table and a public voter roll share ZIP code, birth date and sex. Joining on those columns attaches a name to a diagnosis.">
<defs><marker id="ch12d2-rj-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker></defs>
<text x="8" y="16" font-size="13" font-weight="700">"anonymized" health records</text>
<rect x="8" y="24" width="244" height="24" style="fill: var(--viz-node); stroke: var(--viz-line)"/>
<rect x="8" y="72" width="244" height="24" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<rect x="8" y="24" width="244" height="96" style="fill: none; stroke: var(--viz-line)"/>
<line x1="8" y1="72" x2="252" y2="72" style="stroke: var(--viz-line)"/>
<text x="34" y="41" font-size="12" font-weight="700" text-anchor="middle">ZIP</text>
<text x="101" y="41" font-size="12" font-weight="700" text-anchor="middle">birth date</text>
<text x="159" y="41" font-size="12" font-weight="700" text-anchor="middle">sex</text>
<text x="214" y="41" font-size="12" font-weight="700" text-anchor="middle">diagnosis</text>
<text x="34" y="65" font-size="12" text-anchor="middle">94110</text>
<text x="101" y="65" font-size="12" text-anchor="middle">1971-02-14</text>
<text x="159" y="65" font-size="12" text-anchor="middle">F</text>
<text x="214" y="65" font-size="12" text-anchor="middle">asthma</text>
<text x="34" y="89" font-size="12" text-anchor="middle">94117</text>
<text x="101" y="89" font-size="12" text-anchor="middle">1958-09-30</text>
<text x="159" y="89" font-size="12" text-anchor="middle">M</text>
<text x="214" y="89" font-size="12" font-weight="700" text-anchor="middle">cardiac</text>
<text x="34" y="113" font-size="12" text-anchor="middle">94122</text>
<text x="101" y="113" font-size="12" text-anchor="middle">1990-06-21</text>
<text x="159" y="113" font-size="12" text-anchor="middle">F</text>
<text x="214" y="113" font-size="12" text-anchor="middle">diabetes</text>
<text x="388" y="16" font-size="13" font-weight="700">public voter roll</text>
<rect x="388" y="24" width="238" height="24" style="fill: var(--viz-node); stroke: var(--viz-line)"/>
<rect x="388" y="72" width="238" height="24" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<rect x="388" y="24" width="238" height="96" style="fill: none; stroke: var(--viz-line)"/>
<line x1="388" y1="72" x2="626" y2="72" style="stroke: var(--viz-line)"/>
<text x="423" y="41" font-size="12" font-weight="700" text-anchor="middle">name</text>
<text x="484" y="41" font-size="12" font-weight="700" text-anchor="middle">ZIP</text>
<text x="551" y="41" font-size="12" font-weight="700" text-anchor="middle">birth date</text>
<text x="609" y="41" font-size="12" font-weight="700" text-anchor="middle">sex</text>
<text x="423" y="65" font-size="12" text-anchor="middle">J. Rivera</text>
<text x="484" y="65" font-size="12" text-anchor="middle">94103</text>
<text x="551" y="65" font-size="12" text-anchor="middle">1983-12-01</text>
<text x="609" y="65" font-size="12" text-anchor="middle">M</text>
<text x="423" y="89" font-size="12" font-weight="700" text-anchor="middle">A. Chen</text>
<text x="484" y="89" font-size="12" text-anchor="middle">94117</text>
<text x="551" y="89" font-size="12" text-anchor="middle">1958-09-30</text>
<text x="609" y="89" font-size="12" text-anchor="middle">M</text>
<text x="423" y="113" font-size="12" text-anchor="middle">P. Okafor</text>
<text x="484" y="113" font-size="12" text-anchor="middle">94122</text>
<text x="551" y="113" font-size="12" text-anchor="middle">1979-04-08</text>
<text x="609" y="113" font-size="12" text-anchor="middle">F</text>
<text x="320" y="56" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">join on ZIP,</text>
<text x="320" y="72" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">birth date, sex</text>
<line x1="252" y1="84" x2="388" y2="84" style="stroke: var(--viz-c3); stroke-width: 3"/>
<line x1="320" y1="86" x2="320" y2="144" style="stroke: var(--viz-bad); stroke-width: 2" marker-end="url(#ch12d2-rj-arr)"/>
<rect x="215" y="148" width="210" height="44" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="320" y="167" font-size="13" font-weight="700" text-anchor="middle">A. Chen: cardiac</text>
<text x="320" y="184" font-size="12" text-anchor="middle">name + diagnosis</text>
</svg><svg class="c12e-rj-n" viewBox="0 0 360 336" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="An anonymized health table and a public voter roll share ZIP code, birth date and sex. Joining on those columns attaches a name to a diagnosis.">
<defs><marker id="c12e-rj-n-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker></defs>
<text x="24" y="16" font-size="13" font-weight="700">"anonymized" health records</text>
<rect x="24" y="24" width="328" height="24" style="fill: var(--viz-node); stroke: var(--viz-line)"/>
<rect x="24" y="72" width="328" height="24" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<rect x="24" y="24" width="328" height="96" style="fill: none; stroke: var(--viz-line)"/>
<g font-size="12" text-anchor="middle">
<text x="54" y="41" font-weight="700">ZIP</text><text x="134" y="41" font-weight="700">birth date</text><text x="206" y="41" font-weight="700">sex</text><text x="290" y="41" font-weight="700">diagnosis</text>
<text x="54" y="65">94110</text><text x="134" y="65">1971-02-14</text><text x="206" y="65">F</text><text x="290" y="65">asthma</text>
<text x="54" y="89">94117</text><text x="134" y="89">1958-09-30</text><text x="206" y="89">M</text><text x="290" y="89" font-weight="700">cardiac</text>
<text x="54" y="113">94122</text><text x="134" y="113">1990-06-21</text><text x="206" y="113">F</text><text x="290" y="113">diabetes</text>
</g>
<text x="188" y="140" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">join on ZIP, birth date, sex</text>
<text x="24" y="158" font-size="13" font-weight="700">public voter roll</text>
<rect x="24" y="166" width="328" height="24" style="fill: var(--viz-node); stroke: var(--viz-line)"/>
<rect x="24" y="214" width="328" height="24" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/>
<rect x="24" y="166" width="328" height="96" style="fill: none; stroke: var(--viz-line)"/>
<g font-size="12" text-anchor="middle">
<text x="70" y="183" font-weight="700">name</text><text x="146" y="183" font-weight="700">ZIP</text><text x="226" y="183" font-weight="700">birth date</text><text x="314" y="183" font-weight="700">sex</text>
<text x="70" y="207">J. Rivera</text><text x="146" y="207">94103</text><text x="226" y="207">1983-12-01</text><text x="314" y="207">M</text>
<text x="70" y="231" font-weight="700">A. Chen</text><text x="146" y="231">94117</text><text x="226" y="231">1958-09-30</text><text x="314" y="231">M</text>
<text x="70" y="255">P. Okafor</text><text x="146" y="255">94122</text><text x="226" y="255">1979-04-08</text><text x="314" y="255">F</text>
</g>
<polyline points="24,84 12,84 12,226 24,226" style="fill: none; stroke: var(--viz-c3); stroke-width: 3"/>
<line x1="188" y1="262" x2="188" y2="282" style="stroke: var(--viz-bad); stroke-width: 2" marker-end="url(#c12e-rj-n-arr)"/>
<rect x="88" y="284" width="200" height="44" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="188" y="303" font-size="13" font-weight="700" text-anchor="middle">A. Chen: cardiac</text>
<text x="188" y="320" font-size="12" text-anchor="middle">name + diagnosis</text>
</svg>`,
          caption: "Fictional data. Neither table alone links a name to a diagnosis, but together they do. Removing names is not anonymization while quasi-identifiers remain.",
        },
        {
          type: "text",
          html: `<p>High-dimensional, sparse data is even worse, because it works as a fingerprint: few people share your exact set of movie ratings or your exact daily movements. That is how researchers re-identified Netflix Prize users, and how de Montjoye et al. (2013) found that in a mobile-phone dataset of 1.5 million people, just four points in space and time were enough to single out 95% of them. Hashing a user ID doesn't help either. A hash is <strong>pseudonymization</strong>, not anonymization: it is still a stable identifier that can be joined across datasets, which is why GDPR still treats pseudonymized data as personal data.</p>
<h3>Data as asset, liability and power</h3>
<p>Behavioural data is valuable enough to be called an asset, and an industry of data brokers buys, combines and resells it, largely out of sight of the people it describes. But every stored record is also a <strong>liability</strong>. It can leak in a breach, be taken by an insider, be sold along with the company, or be demanded by a government. The book's advice is to weigh any collection not only against today's political environment, but against every future government and regime that might one day get hold of it.</p>
<p>Knowledge is also power. An organization that can scrutinize millions of people while keeping its own models and inferences opaque holds a kind of power those people can't check, and that asymmetry is why surveillance matters even to people with "nothing to hide".</p>`,
        },
        {
          type: "analogy",
          title: "Remember the Industrial Revolution",
          html: `<p>Industrialization brought enormous economic growth, along with polluted air and rivers, child labour and lethal working conditions. It took decades of regulation (environmental protection, safety rules, labour law) before societies kept the benefits without paying those costs. Bruce Schneier calls data "the pollution problem of the information age", with privacy protection as the matching environmental challenge. Like pollution, the harm is diffuse and delayed, it falls on people who didn't make the decision, and it is far cheaper to prevent at the source than to clean up afterwards.</p>`,
        },
        {
          type: "text",
          html: `<h3>Legislation and self-regulation</h3>
<p>Regulation was already pointing this way when the book was written. The EU's 1995 Data Protection Directive required personal data to be collected for "specified, explicit and legitimate purposes", and to be adequate, relevant and not excessive for them. That clashes directly with the big-data habit of collecting everything and finding uses later. <strong>Purpose limitation</strong> and <strong>data minimization</strong> say the opposite: decide the purpose first, then collect only what it needs.</p>
<p>The book argues that law alone isn't enough; the industry needs a culture shift. Treat users as humans, not as metrics to optimize. Explain how their data is used. Keep data only as long as it is needed, then <strong>purge it</strong>. Consider enforcing access with cryptography, not just policy.</p>
<p>In a log-centric architecture, deletion has to be designed in, because immutable logs resist it (see Chapter 11's <a href="#/ch11/learn/state-and-immutability">limits of immutability</a>). Keep personal data out of events where you can, and encrypt the rest with per-user keys, so that deleting a key makes every copy unreadable (<strong>crypto-shredding</strong>). Deletions must also propagate: an erasure request has to reach every index, cache, warehouse table, feature store and backup derived from the original data.</p>
<p>When data must be shared, release aggregates rather than rows, with minimum group sizes. <strong>Differential privacy</strong> goes further, adding calibrated noise so that the output provably reveals little about any one person; the US Census Bureau used it for its 2020 Census data products, at some cost in accuracy. And keep asking the future-government question: would this dataset be safe with whoever might hold it in ten years?</p>`,
        },
        {
          type: "list",
          title: "An engineer's privacy checklist",
          items: [
            "<strong>Purpose:</strong> write down what each field is for before collecting it. A field without a purpose isn't collected.",
            "<strong>Minimization:</strong> store the coarsest form that serves the purpose: a city rather than a GPS trace, an age band rather than a birth date.",
            "<strong>Retention:</strong> give every topic, table and backup an expiry, and actually purge.",
            "<strong>Deletion in immutable logs:</strong> personal data kept outside events, per-user encryption keys for crypto-shredding, tombstones on compacted topics.",
            "<strong>Propagation:</strong> deletion events that every derived view, cache, index and warehouse consumes, plus a reconciliation check that they did.",
            "<strong>Access logging:</strong> record who read personal data and why, and review it.",
            "<strong>Breach threat model:</strong> assume the store will leak one day. What does an attacker learn, and how can you make it less?",
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Since the book: privacy law with teeth",
          html: `<ul><li><strong>GDPR</strong> (adopted 2016, applicable from 25 May 2018) turned purpose limitation, data minimization, storage limitation and the right to erasure into enforceable obligations, with fines of up to 4% of global annual turnover. In 2023 Meta was fined €1.2 billion under it over transfers of EU users' data to the US.</li><li><strong>California's CCPA</strong> (in effect from 2020) gave Californians the right to know what is collected about them, to have it deleted, and to opt out of its sale.</li><li><strong>Apple's App Tracking Transparency</strong> (iOS 14.5, April 2021) made tracking users across other companies' apps opt-in, by asking each user explicitly.</li></ul>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: right to erasure in a log-centric system",
          html: `<p>The weak answer deletes a row from the main database. A strong answer starts with a question: where are all the copies? Every consumer of the log made its own, so you need a <strong>data inventory</strong> (lineage from each topic to every view, cache, index, warehouse table, feature store and third-party export). Then make deletion a first-class event: append an erasure event for the user, and require every consumer to handle it and confirm.</p>
<p>For the immutable parts (the log itself, old segments, backups), use crypto-shredding: personal fields are encrypted with a per-user key held in a separate, mutable key store, and deleting the key makes every copy unreadable. Remember that the key store has backups too, so give them a short retention. Finish with verification: a job that checks the user ID no longer resolves anywhere, and a deadline (GDPR expects a response without undue delay, normally within a month). Models already trained on the data are the hard edge case; acknowledge it, for example with a retraining schedule.</p>`,
        },
        {
          type: "text",
          html: `<h3>A world worth living in</h3>
<p>The book closes on exactly this note. The techniques in its chapters, replication, partitioning, transactions, logs, derived views and end-to-end checks, are powerful, and that power is the reason their use deserves thought. Engineers are responsible not only for whether a system is technically correct, but for whether it treats the people whose data flows through it with humanity and respect. Build systems you would be comfortable being on the other side of, and help make a world worth living in.</p>`,
        },
        {
          type: "quiz",
          q: "Your system keeps every user event forever in an immutable Kafka log from which all views are derived. A user exercises their right to erasure. What is the most robust design?",
          options: [
            "Delete the user's row from the main database; the log is internal, so it doesn't matter",
            "Append a \"user deleted\" event and let consumers hide the user in their views",
            "Encrypt each user's personal fields with a per-user key and delete the key (crypto-shredding), propagate a deletion event so every derived view, cache and index purges the data, and bound the retention of raw logs and backups",
            "Rewrite the whole log without the user's events once a year",
          ],
          answer: 2,
          explain: "In a log-centric system the data lives in the log and in every view derived from it. Option B is the tempting one because it is how event sourcing usually models change, but hiding is not deleting: the original events, and any view that ignores the new event, still hold the data. Deleting only the primary row (A) leaves copies everywhere, and an annual rewrite (D) leaves the data around for up to a year. Crypto-shredding makes the immutable copies unreadable, and deletion events make derived views forget.",
        },
      ],
    },
  ],

  takeaways: [
    "No database does everything. Decide which system is the record and make every other store a <strong>derived view</strong> that applies one ordered log deterministically, so views can lag but never diverge. Across logs there is no order for free: record <strong>causal dependencies</strong> explicitly.",
    "Keep raw events and deterministic code, and fixing history becomes <strong>replaying</strong> it: run the new version beside the old one, compare, switch reads, roll back if needed. The lesson of the Lambda architecture: never maintain the same logic twice.",
    "Indexes, caches and materialized views are one decision: how much work to do on the <strong>write path</strong> versus the <strong>read path</strong>. Pushing changes to clients extends the write path all the way to the screen.",
    "Each layer's guarantee stops at its own boundary. <strong>Exactly-once is an end-to-end property</strong>, achieved with an operation ID minted at the origin and checked where the effect lands.",
    "Constraints don't need distributed transactions: route conflicting requests to one log partition, decide sequentially, and split multi-partition work into <strong>idempotent, ID-tagged</strong> instructions.",
    "Separate <strong>timeliness</strong> (heals by waiting) from <strong>integrity</strong> (never heals by itself). Protect integrity everywhere, and buy timeliness, through coordination, only where an apology would cost too much.",
    "Assume nothing is perfect: <strong>verify end to end</strong> by reconciling derived data with its source, restoring backups, and designing for auditability.",
    "Data systems make decisions about people. Models extrapolate past bias and can fulfil their own predictions, and every retained event is a liability. <strong>Collect less, keep it for less time, and build in accountability.</strong>",
  ],

  connections: [
    { to: "ch11", html: "Change data capture, event sourcing, log-based brokers, the dual-write problem, stream joins, deletion in immutable logs and exactly-once processing are the building blocks this chapter composes into an architecture." },
    { to: "ch10", html: "Batch jobs as pure functions over immutable inputs, producing derived outputs, is the model this chapter generalizes; reprocessing history is a batch job over the log." },
    { to: "ch9", html: "A total order of events is total order broadcast, which is equivalent to consensus, and uniqueness constraints need consensus too. Two-phase commit (and the saga alternative) is the distributed-transaction route this chapter argues against for integration. Lamport and vector clocks help with causality only if consumers wait for all their inputs." },
    { to: "ch7", html: "Single-threaded processing of each log partition is actual serial execution, scaled out by partitioning. The request-ID pattern complements atomicity to make retries safe, and lost updates and write skew are what constraint enforcement must prevent." },
    { to: "ch5", html: "A derived view is like a follower applying a replication log, and building a new index mirrors setting up a new follower. Offline clients and multi-leader conflicts reappear when state is pushed to devices; CRDTs help with causality but not with side effects." },
    { to: "ch3", html: "Indexes, caches and materialized views are where the write path meets the read path; the inverted index of a search engine is the running example of that boundary." },
    { to: "ch6", html: "Partitioning by the constrained key is what lets stream-based constraint enforcement scale, and global secondary indexes are better maintained asynchronously from a log." },
    { to: "ch2", html: "The normalization debate returns as system of record versus derived data: keep the record normalized and let derived views denormalize deliberately. Using a specialized store for each access pattern (polyglot persistence) creates the problem that data integration solves." },
    { to: "ch4", html: "Reprocessing makes schema evolution possible far beyond adding optional fields, and events on a shared log become contracts that need compatible schemas." },
    { to: "ch8", html: "Trust-but-verify questions the system model itself (crash-recovery with no corruption). Byzantine fault tolerance underlies blockchains, and checksums are the simplest end-to-end check." },
    { to: "ch1", html: "Twitter's choice between fan-out on write and on read is another instance of moving the write/read boundary; evolvability and operability motivate unbundling and reprocessing." },
  ],

  furtherReading: [
    { title: "Saltzer, Reed and Clark, \"End-to-End Arguments in System Design\" (ACM TOCS, 1984)", url: "https://web.mit.edu/Saltzer/www/publications/endtoend/endtoend.pdf", note: "The original argument, with the careful file transfer example; short, and still the clearest statement of why lower layers can't guarantee correctness on their own." },
    { title: "Jay Kreps, \"The Log: What every software engineer should know about real-time data's unifying abstraction\" (2013)", url: "https://www.linkedin.com/blog/engineering/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying", note: "The essay behind the log-as-backbone architecture, from one of Kafka's creators." },
    { title: "Jay Kreps, \"Questioning the Lambda Architecture\" (O'Reilly Radar, 2014)", url: "https://www.oreilly.com/radar/questioning-the-lambda-architecture/", note: "Where the Kappa architecture got its name and its reprocessing recipe." },
    { title: "Martin Kleppmann, \"Turning the database inside-out with Apache Samza\" (2015)", url: "https://www.confluent.io/blog/turning-the-database-inside-out-with-apache-samza/", note: "The talk-turned-article that this chapter's unbundling section grows out of." },
    { title: "Akidau et al., \"The Dataflow Model\" (VLDB 2015)", url: "https://www.vldb.org/pvldb/vol8/p1792-Akidau.pdf", note: "Unifies batch and streaming with event-time windows, triggers and watermarks; the basis of Apache Beam." },
    { title: "Pat Helland and Dave Campbell, \"Building on Quicksand\" (CIDR 2009)", url: "https://arxiv.org/abs/0909.1788", note: "Why real systems act on guesses and fix things with apologies: the foundation of loosely interpreted constraints." },
    { title: "Bailis et al., \"Coordination Avoidance in Database Systems\" (PVLDB 2014, presented at VLDB 2015)", url: "https://www.vldb.org/pvldb/vol8/p185-bailis.pdf", note: "Formalizes which invariants can be maintained without coordination (invariant confluence)." },
    { title: "Kleppmann et al., \"Local-first software: You own your data, in spite of the cloud\" (Ink & Switch, 2019)", url: "https://www.inkandswitch.com/essay/local-first/", note: "Where the offline-capable, push-based clients of this chapter went next." },
    { title: "Jepsen analyses (Kyle Kingsbury)", url: "https://jepsen.io/analyses", note: "Case studies of real databases violating their documented guarantees: the best argument for trust-but-verify." },
    { title: "RFC 6962: Certificate Transparency", url: "https://www.rfc-editor.org/rfc/rfc6962", note: "A production design for append-only, publicly auditable Merkle-tree logs." },
    { title: "Hochschild et al., \"Cores that don't count\" (HotOS 2021)", url: "https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s01-hochschild.pdf", note: "Google's report on CPUs that silently compute wrong results: the modern case for end-to-end verification." },
    { title: "Stripe API documentation: Idempotent requests", url: "https://docs.stripe.com/api/idempotent_requests", note: "A concise, production-grade specification of the operation-ID pattern." },
    { title: "Amazon Builders' Library, \"Making retries safe with idempotent APIs\"", url: "https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/", note: "How AWS uses caller-provided request IDs (such as EC2's ClientToken) so that retries can't create duplicate resources." },
    { title: "Angwin et al., \"Machine Bias\" (ProPublica, 2016)", url: "https://www.propublica.org/article/machine-bias-risk-assessments-in-criminal-sentencing", note: "The COMPAS investigation that set off the modern debate about algorithmic fairness." },
    { title: "Cathy O'Neil, \"Weapons of Math Destruction\" (2016)", note: "A book-length treatment of opaque, unaccountable models and their feedback loops in credit, hiring and policing." },
    { title: "Bruce Schneier, \"Data and Goliath\" (2015)", note: "The case that mass data collection is surveillance, and that data is a liability as much as an asset." },
    { title: "de Montjoye et al., \"Unique in the Crowd: The privacy bounds of human mobility\" (Scientific Reports, 2013)", url: "https://www.nature.com/articles/srep01376", note: "Why location traces are fingerprints: a handful of points identify almost everyone." },
  ],
});
