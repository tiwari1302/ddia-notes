// Chapter 8: The Trouble with Distributed Systems
// Authoring guide: docs/AUTHORING.md
DDIA.registerChapter({
  id: "ch8",
  part: 2,
  number: 8,
  title: "The Trouble with Distributed Systems",
  tagline: "Networks drop and delay messages, clocks drift and jump, processes freeze: how to stay correct when no node can be sure of anything.",
  overview: `<p>Earlier chapters treated faults as tidy events: a replica fails over, a transaction aborts. This chapter looks at what really happens once a system spans several machines. On one computer a hardware fault is deliberately turned into a total crash, so software can assume "works or dead". Across a network you get <strong>partial failure</strong>: some parts work, others don't, and often nobody can tell which, or whether an operation succeeded (<a href="#/ch8/learn/partial-failure">partial failure</a>). The chapter is pessimistic on purpose: it lists what can go wrong so that Chapter 9 can build tools that stay correct anyway.</p>
<p>The central tension is that a node knows the world only through messages and its own clock, and both are unreliable. Silence after a request fits a lost request, a crashed or paused server, or a lost or late reply, and in most of those cases the work may well have been done (<a href="#/ch8/learn/unreliable-networks">a missing reply</a>). Timeouts are the only general failure detector, and because packet networks and shared machines queue everything, every timeout is a bet between false alarms and slow detection (<a href="#/ch8/learn/timeouts-and-delays">timeouts and delays</a>). Clocks don't rescue you: the <strong>time-of-day clock</strong> can jump (<a href="#/ch8/learn/two-clocks">two clocks</a>), and last-write-wins on timestamps from skewed clocks silently discards acknowledged writes, unless, like Spanner, you make the uncertainty explicit and wait it out (<a href="#/ch8/learn/ordering-by-timestamps">ordering by timestamps</a>).</p>
<p>The ideas build toward one conclusion: no node can trust its own view. A process can freeze at any line and wake up still believing it holds a lease (<a href="#/ch8/learn/process-pauses">process pauses</a>), so decisions are made by a <strong>majority quorum</strong> (<a href="#/ch8/learn/truth-by-majority">truth by majority</a>) and resources reject zombie writers with <strong>fencing tokens</strong> (<a href="#/ch8/learn/fencing-tokens">fencing</a>). All of that assumes nodes are mistaken but honest; tolerating liars needs n ≥ 3f + 1 nodes and is rarely worth it inside a datacenter (<a href="#/ch8/learn/byzantine-faults">Byzantine faults</a>). Finally the assumptions are written down as <strong>system models</strong>, usually partial synchrony with crash-recovery nodes, and correctness is split into <strong>safety</strong>, which must always hold, and <strong>liveness</strong>, which may wait for the network to behave (<a href="#/ch8/learn/system-models">system models</a>). Chapter 9's linearizability and consensus are built on exactly these assumptions.</p>`,

  // ------------------------------------------------------------------
  // CONCEPTS (teaching order, grouped by deep-dive section)
  // ------------------------------------------------------------------
  concepts: [
    // --- partial-failure ---
    {
      id: "partial-failure",
      term: "Partial failure",
      def: `Some components of a distributed system are broken while others keep working, and the breakage is <strong>nondeterministic</strong>: the same request may succeed, fail, or end with an outcome nobody can determine. A single computer, by contrast, is built to be either fully working or fully crashed.`,
      problem: `On one machine, hardware faults are turned into total crashes on purpose (a kernel panic rather than a wrong answer), so software can assume "works or dead". Across a network, some parts fail while others work and you may not know whether an operation succeeded; code written with single-machine assumptions hangs, duplicates side effects or corrupts state.`,
      why: `It is the root difference between distributed and single-node programming. Supercomputers dodge it by escalating any node failure into a total one (stop the job, restart from the last checkpoint), but an online service on thousands of commodity machines always has something broken and can't stop for a restart. So fault tolerance has to be built in software from unreliable parts, assuming from the start that anything that can go wrong will. The <strong>fallacies of distributed computing</strong> (L Peter Deutsch and colleagues at Sun, with James Gosling adding the eighth: "the network is reliable", "latency is zero", ...) are the habits this chapter breaks.`,
      ex: `Jeff Dean's LADIS 2009 keynote described a typical first year of a new Google cluster as roughly 1,000 individual machine failures, thousands of disk failures and about 20 rack failures: at that scale partial failure is the steady state. Netflix's Chaos Monkey (introduced around 2010-2011, open-sourced in 2012) kills production instances at random so every service is forced to survive it. The classic victim is a remote call written like a local function call with no timeout: it hangs forever when the peer is half-alive.`,
      section: "partial-failure",
    },
    {
      id: "gray-failure",
      term: "Gray failure",
      def: `A component that is degraded (slow, dropping some requests, failing only for some clients) while still passing its health checks, so different observers disagree about whether it is up. The defining property is <strong>differential observability</strong>: the failure detector sees "healthy" while users see "broken".`,
      problem: `Failure detectors built for clean crashes miss half-working components, and these cause many real cloud incidents and confuse failover logic.`,
      why: `Health checks see the system from a different vantage point than real traffic. A node that answers heartbeats while its disk takes 10 s per write looks fine to the detector and dead to every client, so failover never starts; or one observer's bad link makes it accuse a healthy node. Partial failure is often partial even inside one component. Detect it with request-level signals (latency percentiles and error rates seen by callers) and with several observers, not with a ping.`,
      ex: `Huang et al., "Gray Failure: The Achilles' Heel of Cloud-Scale Systems" (HotOS 2017, Microsoft), named the pattern and argued that such failures, rather than clean crashes, are behind many cloud incidents. Typical cases: a NIC that drops a fraction of packets, a disk with a slow region, a service that fails only for requests arriving from one rack. Service meshes such as Envoy add outlier detection (ejecting hosts with consecutive errors) for exactly this reason.`,
      section: "partial-failure",
    },

    // --- unreliable-networks ---
    {
      id: "unreliable-networks",
      term: "Unreliable networks",
      def: `Shared-nothing nodes communicate only by messages over an <strong>asynchronous packet network</strong> that promises neither delivery nor timing: messages can be lost, delayed, duplicated or reordered. TCP retransmits, deduplicates and orders bytes <em>within one connection</em>, but it puts no bound on delay, and a TCP-level acknowledgment only means the remote kernel received the bytes, not that the application processed the request. When a connection breaks, you don't know how much the peer handled.`,
      problem: `Code written as if a remote call were a local function call treats silence as failure: it retries a charge that already went through, or fails over from a node that was only slow. Without shared memory, a missing reply is the only evidence a sender gets, and it is ambiguous.`,
      why: `When a request gets no reply, the sender can't distinguish six cases: request lost, request queued, node crashed, node paused, reply lost, reply delayed. In most of them the work was done or will be, and even a crash can strike just after the side effect. The only honest state is <strong>outcome unknown</strong>, so retries must be idempotent (<a href="#/ch12/concepts/idempotence-via-operation-ids">Chapter 12</a>) and success must be confirmed by the application, not by the transport (the <a href="#/ch12/concepts/end-to-end-argument">end-to-end argument</a>).`,
      ex: `Network faults are common even inside one company's datacenter: misconfigured switches (human error is a leading cause, and redundant gear doesn't protect against it), NICs that fail in one direction only, switch software upgrades that delay packets for more than a minute while the topology reconverges, and sharks biting undersea cables. Since 2013 Jepsen has shown real databases losing acknowledged writes under injected partitions. Linux keeps retransmitting on an established TCP connection for about 15 minutes by default (<code>tcp_retries2 = 15</code>) before giving up, so applications need their own, much shorter timeouts.`,
      section: "unreliable-networks",
    },
    {
      id: "network-partition",
      term: "Network partition (split)",
      def: `A network fault that cuts the cluster into groups that can't reach each other while nodes inside each group still can; also called a <strong>netsplit</strong>. Partitions can be <strong>partial</strong> (A reaches B and B reaches C, but A can't reach C) or <strong>one-directional</strong> (A's messages reach B, B's replies don't reach A). The term is unrelated to data partitioning or sharding (<a href="#/ch6/concepts/partition">Chapter 6</a>).`,
      problem: `Network faults can cut a cluster into groups that can't talk to each other, and each group may conclude the other is dead.`,
      why: `If each side acts on its own conclusion, for example by electing a leader, you get <strong>split brain</strong> (<a href="#/ch5/concepts/split-brain">Chapter 5</a>). The cure is to let only a side holding a majority make decisions and to fence anything the other side might still do. Partial partitions are the nastiest kind: different nodes see different truths, so the cluster has no single view of who is up, and leader elections can flap indefinitely.`,
      ex: `GitHub, October 21, 2018: 43 seconds of lost connectivity between the US East Coast network hub and the primary East Coast data center led the automated failover tool (Orchestrator) to promote West Coast database primaries; with writes on both coasts that the other side hadn't seen, GitHub ran degraded for 24 hours and 11 minutes. Alquraan et al. (OSDI 2018) studied 136 partition-induced failures in 25 widely used systems: 80% had catastrophic effects (data loss most often), and 29% were triggered by partial partitions.`,
      section: "unreliable-networks",
    },
    {
      id: "two-generals-problem",
      term: "Two Generals problem",
      def: `Two parties that can only communicate over a channel that may lose messages can never both be certain they agree on a plan. Whoever sends the last message can't know it arrived, and acknowledging it just creates a new last message, so no finite number of acknowledgments solves it. Nobody lies here; that is the separate <strong>Byzantine Generals</strong> problem.`,
      problem: `Explains why a sender on an unreliable network can never reach certainty about the outcome by messaging alone, so real systems use retries with idempotency, status queries and later reconciliation instead.`,
      why: `It sets a hard limit on what messaging can achieve: a third or fourth acknowledgment never helps, because the final message is always unconfirmed. Practical systems stop chasing certainty and make the uncertainty harmless instead: at-least-once retries plus idempotent processing or deduplication by request ID, durable "pending" state reconciled later, and timeouts that bound how long anyone waits. Keep it apart from the Byzantine Generals problem (messages arrive, some generals lie) and from FLP (asynchrony plus crashes, <a href="#/ch9/concepts/flp-impossibility">Chapter 9</a>).`,
      ex: `A checkout service whose call to a payment provider times out is in a Two Generals situation. That is why Stripe-style APIs accept an <code>Idempotency-Key</code> header and deduplicate retries, and why the order sits in "payment pending" until a status query or webhook settles it. Two-phase commit (<a href="#/ch9/concepts/two-phase-commit">Chapter 9</a>) doesn't escape the problem either: a participant that voted yes must wait, possibly indefinitely, if the coordinator's decision never reaches it.`,
      section: "unreliable-networks",
    },

    // --- timeouts-and-delays ---
    {
      id: "timeouts",
      term: "Timeouts",
      def: `Since a node can't prove that another is dead, it <em>assumes</em> so when no response arrives within some time. A timeout is the only failure detector that works for every kind of fault, and it is always a guess: <strong>too long</strong> and users wait or see errors while a dead node goes unnoticed; <strong>too short</strong> and healthy but slow nodes get declared dead (false positives).`,
      problem: `Systems must detect dead nodes to fail over or stop routing to them, and the only universal signal is the absence of a reply within some time.`,
      why: `If the network guaranteed a maximum delay d and every server answered within r, a timeout of 2d + r would be exactly right. Real networks and servers have <strong>unbounded delays</strong>, so no timeout is "correct": choose it from measured round-trip-time distributions (including peak load, GC pauses and batch jobs) or adapt it automatically (φ accrual). Beware false positives: the "dead" node may still finish its action, so it happens twice, and shifting its load onto nodes that are already struggling can trigger a <a href="#/ch1/concepts/cascading-failure">cascading failure</a>.`,
      ex: `AWS EBS, April 21, 2011 (US-East): after a network configuration change, many EBS nodes lost contact with their replicas at once and all searched for space to re-mirror; the "re-mirroring storm" exhausted capacity and left some volumes impaired for days. Amazon DynamoDB, September 20, 2015: storage servers timed out fetching their membership data (which had grown large) from a metadata service, took themselves out of service and retried, and the retries kept the metadata service overloaded for hours.`,
      section: "timeouts-and-delays",
    },
    {
      id: "queueing-delays",
      term: "Unbounded delays (queueing)",
      def: `In a packet network, message delay has no fixed upper bound because packets and requests wait in queues: the sender's TCP send buffer, switch output queues, the receiver's OS run queue, the hypervisor, the application's thread pool, plus retransmission after a loss.`,
      problem: `You can't compute a "correct" timeout (like 2d + r) because d isn't bounded, and delays grow exactly when the system is busiest.`,
      why: `Queueing is why "slow" is so often mistaken for "dead", and why it happens at the worst moment: as utilization approaches 100%, queue lengths and latency grow sharply, so heartbeats miss their deadlines exactly when the cluster is busiest. In multi-tenant clouds the queues are shared with <strong>noisy neighbors</strong> (another customer's batch job saturating a link or CPU), so the variability is outside your control. A dropped packet that TCP retransmits shows up to the application as nothing but extra delay.`,
      ex: `When several senders target one switch port, its output queue fills, and once it is full packets are dropped and must be retransmitted. If all cores on the receiver are busy, the OS queues the incoming request; a hypervisor can deschedule a VM for tens of milliseconds while incoming data is buffered. Latency-sensitive apps such as VoIP and video calls use UDP precisely because a retransmitted packet that arrives too late is worthless; they fill the gap (with silence, say) instead of waiting.`,
      section: "timeouts-and-delays",
    },
    {
      id: "phi-accrual-failure-detector",
      term: "φ accrual failure detector",
      def: `Instead of a yes/no timeout, the detector outputs a continuous <strong>suspicion level</strong> φ computed from the observed distribution of heartbeat inter-arrival times. φ is roughly −log<sub>10</sub> of the probability, under that model, that a heartbeat would be this late by chance (φ = 8 means about 10<sup>−8</sup>); the system declares the node down when φ crosses a threshold. Introduced by Hayashibara et al. (2004).`,
      problem: `A fixed timeout is wrong whenever conditions change: too twitchy under load, too slow when the network is quiet.`,
      why: `It makes the timeout follow reality: when the network gets jittery the learned distribution widens and the detector waits longer, and when it is quiet crashes are detected faster. Careful: φ is not the probability that the node is dead, and it is only as good as the assumed distribution (normal in the original paper and Akka, exponential in Cassandra). Real delays are heavy-tailed, so the model is overconfident, which is one reason thresholds of 8 or more are common.`,
      ex: `Apache Cassandra's gossip layer uses it, with <code>phi_convict_threshold</code> defaulting to 8 (operators raise it on jittery networks, such as some cloud environments). Akka Cluster uses the normal-distribution variant. TCP's retransmission timeout is adaptive in the same spirit: a smoothed RTT plus four times the RTT's mean deviation.`,
      section: "timeouts-and-delays",
    },
    {
      id: "circuit-vs-packet-switching",
      term: "Circuit vs. packet switching",
      def: `A <strong>circuit</strong> (the classic telephone network, e.g., ISDN) reserves fixed bandwidth along the whole route for the duration of a call, so delay is bounded and nothing queues. <strong>Packet switching</strong> (Ethernet/IP) shares links dynamically, packet by packet, using capacity efficiently but letting packets queue, so delay varies.`,
      problem: `Explains why datacenter networks can't promise a deadline: bounded latency would require static reservation and wasted capacity for bursty traffic.`,
      why: `Bounded delay is technically available, but it costs utilization. A circuit sized for a burst sits idle most of the time; a small one makes transfers needlessly slow. Bursty traffic (web pages, file transfers, replication streams) has no fixed bandwidth need and just wants to finish fast, and TCP adapts its rate to whatever capacity is free. So <strong>variable delay is the price of high utilization</strong>, a cost decision rather than a law of nature; the same trade-off appears in CPU scheduling and multi-tenancy.`,
      ex: `An ISDN line runs at a fixed 4,000 frames per second, and a call is allocated 16 bits in each frame in each direction: a guaranteed 64 kbit/s with no queueing. Packet networks can approximate circuits with quality of service (prioritization and scheduling) plus admission control, and ATM and InfiniBand (link-level flow control) went part of the way, but no such guarantees are offered in today's multi-tenant datacenters, public clouds or the internet.`,
      section: "timeouts-and-delays",
    },

    // --- two-clocks ---
    {
      id: "monotonic-vs-time-of-day-clocks",
      term: "Monotonic vs time-of-day clocks",
      def: `A <strong>time-of-day clock</strong> (wall clock: Linux <code>CLOCK_REALTIME</code>, Java <code>System.currentTimeMillis()</code>) returns seconds since the Unix epoch, ignoring leap seconds; NTP synchronizes it and may <em>step</em> it backward or forward. A <strong>monotonic clock</strong> (<code>CLOCK_MONOTONIC</code>, <code>System.nanoTime()</code>) never goes backward: NTP may <em>slew</em> its rate by up to 0.05% but never makes it jump, and its absolute value (such as time since boot) means nothing.`,
      problem: `Measuring durations with the wall clock breaks when NTP steps the clock or a leap second repeats; timestamps from the monotonic clock mean nothing to another machine.`,
      why: `The two clocks answer different questions. "How long did this take?" (timeouts, latencies, a lease countdown on one machine) needs the monotonic clock, because a wall-clock step can make an elapsed time negative or huge. "When did this happen?" needs the wall clock, but only to the accuracy of its synchronization. Comparing monotonic readings across machines is meaningless. Linux nuance: <code>CLOCK_MONOTONIC</code> doesn't advance while the system is suspended; <code>CLOCK_BOOTTIME</code> does.`,
      ex: `Cloudflare, January 1, 2017: during the leap second its Go DNS service (RRDNS) computed a duration from wall-clock readings, got a negative value, passed it to <code>rand.Int63n</code> and panicked, so some DNS resolutions failed. Go had no monotonic clock API then, so the patch just kept negative values out. Partly prompted by this incident, Go 1.9 (August 2017) made <code>time.Now()</code> carry a monotonic reading, so <code>time.Since</code> and <code>Sub</code> are immune to wall-clock steps.`,
      section: "two-clocks",
    },
    {
      id: "clock-skew-ntp-drift",
      term: "Clock skew & NTP drift",
      def: `Each machine's clock is a quartz oscillator that runs slightly fast or slow (<strong>drift</strong>, which also varies with temperature), so clocks on different machines disagree (<strong>skew</strong>). NTP periodically corrects them against servers that ultimately get time from GPS or atomic clocks, but it can only be as accurate as the network delay to those servers allows.`,
      problem: `Each machine's quartz clock drifts, and NTP can only correct it as accurately as the network allows, so "now" differs between machines.`,
      why: `Clock errors are silent: a drifting clock crashes nothing, it quietly reorders events and loses data. The book's figures: Google assumes 200 ppm drift, about 6 ms for a clock resynced every 30 s and about 17 s for one resynced once a day; one experiment measured NTP over the internet at a minimum error of about 35 ms with occasional spikes near 1 s. NTP may refuse to sync or step a clock that is too far off, a node accidentally firewalled off from NTP drifts unnoticed, and a VM paused by its hypervisor sees its clock jump forward on resume. Monitor clock offsets on every node and evict nodes that drift too far.`,
      ex: `High accuracy is possible at a price: the EU's MiFID II rules require high-frequency trading firms to keep clocks within 100 microseconds of UTC, which takes GPS receivers, the Precision Time Protocol (PTP) and careful monitoring. Cloud providers now sell similar precision, for example AWS's microsecond-accurate time on supported EC2 instances (2023) and its ClockBound daemon, which reports time with an error bound. Clocks on devices you don't control can be deliberately wrong (users change the date to get around time limits in games), so never trust them for anything important.`,
      section: "two-clocks",
    },
    {
      id: "leap-second-smearing",
      term: "Leap seconds and smearing",
      def: `A <strong>leap second</strong> makes a UTC minute 59 or 61 seconds long so that civil time keeps tracking Earth's rotation. <strong>Smearing</strong> spreads the extra second over many hours by running clocks very slightly slow, so software never sees 23:59:60 or a repeated second. In 2022 the CGPM resolved that by or before 2035 UTC may drift more than a second from Earth-rotation time, which in effect ends new leap seconds.`,
      problem: `Software assuming every minute has 60 seconds, or that time never repeats, failed in the 2012 and 2016/17 leap seconds.`,
      why: `Unix time pretends every day has exactly 86,400 seconds, so during a leap second the wall clock must repeat or stall a second, and code that assumes time never goes backward breaks. Smearing hides the event, but a smearing and a non-smearing NTP server disagree by up to a second during the smear, so a client must not mix them. Leap seconds are being phased out, but the lesson outlives them: the wall clock is not a monotonic counter.`,
      ex: `June 30, 2012: a Linux kernel timer bug triggered by the leap second sent many Java and MySQL processes into high CPU usage; Reddit and Mozilla were among the sites affected. Google smears linearly over 24 hours, noon to noon UTC, and its public NTP service serves smeared time. In November 2022 the General Conference on Weights and Measures (CGPM, Resolution 4) decided that UT1−UTC may exceed one second by or before 2035, which in effect ends new leap seconds.`,
      section: "two-clocks",
    },

    // --- ordering-by-timestamps ---
    {
      id: "physical-vs-logical-clocks",
      term: "Physical vs. logical clocks",
      def: `<strong>Physical clocks</strong> (time-of-day, monotonic) measure elapsed seconds. <strong>Logical clocks</strong> are counters carried on messages that capture only the relative order of events, such as Lamport timestamps and version vectors, and are unaffected by clock skew.`,
      problem: `Ordering events by physical timestamps, as <a href="#/ch5/concepts/last-write-wins">last-write-wins</a> does, silently loses data under skew; logical clocks give a safe order without trusting time.`,
      why: `Ordering only needs "before or after", and a counter that travels with messages respects causality (a cause always gets a smaller value than its effects) without trusting any clock. Know which one does what: <a href="#/ch9/concepts/lamport-timestamps">Lamport timestamps</a> (Chapter 9) give a total order consistent with causality but can't tell you two events were concurrent; <a href="#/ch5/concepts/concurrent-writes-version-vectors">version vectors</a> (Chapter 5) can detect concurrency. <strong>Hybrid logical clocks</strong> (HLC) bridge the two: a physical timestamp that is bumped past any larger timestamp a message carries, so causally later events always get larger timestamps while staying close to wall time.`,
      ex: `Riak tracks concurrent writes with (dotted) version vectors and keeps them as siblings instead of discarding one. CockroachDB and YugabyteDB timestamp transactions with hybrid logical clocks. Twitter's Snowflake IDs (2010) pack a 41-bit millisecond timestamp, a 10-bit worker ID and a 12-bit sequence into 64 bits: roughly time-sortable, but they inherit clock skew and are not consistent with causality, and the original implementation refuses to issue IDs if it sees its clock move backward.`,
      section: "ordering-by-timestamps",
    },
    {
      id: "clock-confidence-interval",
      term: "Clock confidence interval",
      def: `A clock reading really means "now is somewhere between <em>earliest</em> and <em>latest</em>". The width comes from drift since the last sync, the time source's own error and the network round-trip time. Most APIs hide it and return a single, falsely precise number.`,
      problem: `Comparing two timestamps whose uncertainty intervals overlap says nothing about which event came first, yet systems do it routinely.`,
      why: `A timestamp printed with microsecond digits may be off by tens of milliseconds, and two events can be ordered by time only if their intervals don't overlap. The width is computable: for a GPS receiver or atomic clock, from the manufacturer's error range; for an NTP-synced clock, from the quartz drift since the last sync plus the server's own uncertainty plus the round-trip time. Because <code>clock_gettime()</code> and friends return one number, systems silently treat a guess as a fact.`,
      ex: `Google's TrueTime returns the interval explicitly as <code>[earliest, latest]</code>. AWS's open-source ClockBound daemon gives EC2 applications a similar bounded reading. NTP clients such as chrony track their own error estimates (root delay and dispersion appear in <code>chronyc tracking</code>), but ordinary time APIs never return them to the application.`,
      section: "ordering-by-timestamps",
    },
    {
      id: "google-truetime-bounded-uncertainty",
      term: "Google TrueTime / bounded uncertainty",
      def: `Spanner's clock API: <code>TT.now()</code> returns an interval <code>[earliest, latest]</code> that is guaranteed, under its drift assumptions, to contain the true time. Spanner uses it for <strong>commit wait</strong>: after choosing commit timestamp s = <code>TT.now().latest</code>, a read-write transaction waits until <code>TT.now().earliest</code> &gt; s, i.e., until s is guaranteed to be in the past (about 2ε), before making the commit visible.`,
      problem: `Timestamps from imperfect clocks can't safely order events across datacenters, but a global counter doesn't scale; Spanner needed timestamps that respect real-time order.`,
      why: `Making uncertainty explicit turns timestamps into something you can reason with: if two intervals don't overlap, the order is certain. The cost of waiting is proportional to the uncertainty ε, so Google keeps ε small with GPS receivers and atomic clocks ("time masters") in each datacenter plus a time daemon on every machine that polls them; the book says clocks stay within about 7 ms, and the 2012 paper shows ε varying in a sawtooth between roughly 1 and 7 ms between synchronizations. The guarantee depends on an assumed drift bound, so Spanner monitors clocks and evicts machines whose clocks misbehave.`,
      ex: `Spanner (OSDI 2012) uses TrueTime timestamps for lock-free snapshot reads across datacenters and for externally consistent read-write transactions, and Cloud Spanner exposes the same design. The book (2017) called clock-based transaction ordering an area of active research outside Google; CockroachDB and YugabyteDB take a cheaper route with hybrid logical clocks and a configured maximum clock offset (500 ms by default in CockroachDB) instead of special hardware.`,
      section: "ordering-by-timestamps",
    },
    {
      id: "commit-wait",
      term: "Commit wait",
      def: `In Spanner, after choosing commit timestamp s = <code>TT.now().latest</code>, a read-write transaction waits until <code>TT.now().earliest</code> &gt; s (about 2ε) before making its commit visible, so any transaction that starts later, anywhere, gets a larger timestamp.`,
      problem: `Timestamps from imperfect clocks can order a later transaction before an earlier one; waiting out the uncertainty restores real-time order (external consistency).`,
      why: `Commit wait makes timestamp order match real-time order: if T2 starts after T1's commit became visible, T2's timestamp is larger, whatever each machine's clock error within ±ε. That is <strong>external consistency</strong>, i.e., strict serializability (serializable plus real-time order; compare <a href="#/ch9/concepts/linearizability">linearizability</a>). The price is roughly 2ε of extra latency on every read-write commit, partly hidden because it overlaps with Paxos replication; read-only transactions don't commit-wait. And correctness rests on the clock bound: if a clock's real error exceeds ε, the ordering guarantee breaks.`,
      ex: `With ε around 4 ms, a read-write commit waits about 8 ms. With plain NTP (tens of milliseconds of uncertainty and unbounded spikes) the same trick would cost tens of milliseconds per commit and still wouldn't be safe, which is why Spanner needed dedicated time hardware. CockroachDB avoids commit wait: a read that finds a value with a timestamp inside its uncertainty window restarts at a higher timestamp, and a node shuts itself down if its clock drifts too far from the others (the documented figure is roughly 80% of the 500 ms maximum offset). It needs no special hardware but doesn't promise Spanner's full real-time ordering for unrelated transactions.`,
      section: "ordering-by-timestamps",
    },

    // --- process-pauses ---
    {
      id: "lease",
      term: "Lease",
      def: `A lock with a timeout: the holder has exclusive rights until the lease expires, unless it renews it first; if the holder crashes, the lease frees itself and someone else can take over.`,
      problem: `A plain lock held by a crashed node would block everyone forever; but a lease is only safe if the holder notices expiry, which pauses and clock jumps can prevent, hence fencing tokens.`,
      why: `A lease ties exclusivity to time, so it is only as safe as the holder's sense of time. The obvious "check lease, then act" loop has two flaws. First, comparing an absolute expiry time set by another machine depends on synchronized clocks; that one is fixable: the holder starts its own monotonic timer <em>before</em> sending the request and gives up early by a margin, while the grantor counts from the grant and waits the full duration plus a margin before re-granting, which needs only a bound on relative clock rates. Second, the holder can be paused between the check and the action; the holder can't fix that at all, which is why leases need <strong>fencing tokens</strong>.`,
      ex: `Chubby and ZooKeeper sessions are leases: ZooKeeper deletes a dead client's ephemeral znodes when its session times out, which is how its lock and leader-election recipes free up. Kubernetes controllers elect a leader through a Lease object, and client-go's leaderelection package states that it doesn't guarantee only one client acts as leader (there is no fencing). Raft-based systems that serve reads from a leader lease rely on the same bounded clock-drift assumption.`,
      section: "process-pauses",
    },
    {
      id: "process-pauses",
      term: "Process pauses (GC, VM pauses)",
      def: `Any thread can be stopped at any line of code for an arbitrary length of time and won't notice until it next reads a clock. Causes include stop-the-world garbage collection, VM suspend or live migration, hypervisor <strong>steal time</strong>, synchronous disk or network-disk I/O (even a Java classloader lazily loading a class), swapping, <code>SIGSTOP</code>/<code>SIGCONT</code>, and a laptop lid being closed.`,
      problem: `Code that checks a condition (lease valid) and then acts assumes little time passes in between; any thread can be frozen for seconds or minutes at any line.`,
      why: `While the process is frozen, the rest of the cluster carries on: peers time out, declare it dead and hand its lease or leadership to someone else. When it resumes it believes no time passed, so a node that checked at 09:59:55 that its lease runs until 10:00:00 can pause for 15 s and write at 10:00:10 with no lease at all. On one machine, mutexes, semaphores and atomic operations protect against arbitrary context switches; across a network there is no shared memory, so correctness must never depend on "nothing happened between my check and my action".`,
      ex: `HBase's troubleshooting guide warns that a GC pause longer than the ZooKeeper session timeout gets a RegionServer declared dead; when it wakes and reports in, it receives a <code>YouAreDeadException</code> and aborts (the book notes HBase once had exactly the expired-lease bug). Discord (2020) saw latency spikes roughly every two minutes in a Go service because the Go runtime forced a GC at least that often, and rewrote it in Rust. Low-pause collectors (ZGC, production-ready in JDK 15; Shenandoah) cut GC pauses to around a millisecond or less, but VM migration, steal time, page faults and I/O stalls still freeze any process.`,
      section: "process-pauses",
    },
    {
      id: "hard-real-time",
      term: "Hard real-time systems",
      def: `Systems with guaranteed response deadlines (airbag controllers, flight control, rockets), built on real-time operating systems with guaranteed CPU scheduling, documented worst-case execution times, restricted dynamic memory allocation and extensive testing. Real-time does not mean high throughput.`,
      problem: `Shows what it would take to rule out process pauses, and why that is too expensive and restrictive for typical server-side data systems.`,
      why: `It shows what ruling out pauses would actually take: guaranteed CPU time slices, libraries whose worst-case timing is documented, little or no dynamic allocation (or a real-time GC), and enormous measurement and testing. That is affordable for an airbag, not for a database on commodity cloud VMs. Real-time systems often have <em>lower</em> throughput because they put timeliness first. Server software therefore limits pauses rather than eliminating them, and stays correct when they happen anyway.`,
      ex: `Some latency-sensitive trading systems treat GC like a planned outage: the runtime warns that a collection is due, the load balancer stops sending that node new requests, in-flight requests drain, and the node collects with nothing outstanding. A variant uses the GC only for short-lived objects and restarts processes on a rolling schedule (like a rolling upgrade) before a full GC is ever needed. Both shrink pauses; neither makes a protocol safe against them.`,
      section: "process-pauses",
    },

    // --- truth-by-majority ---
    {
      id: "truth-is-defined-by-the-majority",
      term: "Truth is defined by the majority (quorum)",
      def: `A node can't trust its own view of the situation, so decisions are made by a <strong>quorum</strong>, usually a strict majority of the configured voting members: q = ⌊n/2⌋ + 1. Because any two majorities share at least one node, only one majority can exist at a time, so at most one side of a partition can decide; n = 2f + 1 nodes tolerate f failures.`,
      problem: `A node can be wrong about itself (semi-disconnected, paused) and about others, so letting each node act on its own view leads to split brain.`,
      why: `The quorum's verdict overrides every node's own belief: a semi-disconnected node that receives but can't send is declared dead while it feels fine, and a node waking from a long GC pause must accept that it was replaced. Majorities handle crashed, partitioned, slow and confused nodes, but they assume nodes are <strong>honest</strong>; tolerating liars needs 3f + 1 (Byzantine faults). Count the majority over all configured voters, never over the nodes currently reachable: computing it over live nodes is exactly how split brain is built. Even sizes add nothing: 4 nodes need 3 votes and survive only 1 failure, and a 2|2 split leaves nobody able to decide (safe, but not live).`,
      ex: `etcd recommends odd cluster sizes (3 or 5): 5 members tolerate 2 failures, and a 6th raises the quorum to 4 without adding tolerance. A MongoDB primary that can no longer see a majority of voting members steps down, so a partitioned minority stops accepting writes. Before 7.0, Elasticsearch operators had to set <code>discovery.zen.minimum_master_nodes</code> to a majority, and getting it wrong allowed two masters; Elasticsearch 7.0 (2019) replaced it with automatically managed voting configurations.`,
      section: "truth-by-majority",
    },

    // --- fencing-tokens ---
    {
      id: "fencing-token",
      term: "Fencing token",
      def: `A number, increasing with every grant, that the lock service returns along with a lock or lease. The holder sends it with every write; the protected resource remembers the highest token it has seen and <strong>rejects any lower one</strong> (an equal token is the current holder writing again and is accepted). The check must be atomic with the write.`,
      problem: `A lease holder can be paused past expiry and wake up believing it holds the lock; neither the lock service nor the client can prevent its stale write, so the resource must.`,
      why: `It moves the safety check to the only place that can enforce it. Client 1 gets token 33 and pauses; its lease expires; client 2 gets 34 and writes; client 1 wakes and writes with 33, and storage rejects it because it has already seen 34. The lock service can't stop a client it can't reach, and the client doesn't know it slept. Fencing protects against nodes acting <em>in error</em> (zombies), not against malicious ones that forge tokens. Side effects that can't check a token (an email, a charge through a third party) can't be fenced and need idempotency instead.`,
      ex: `With ZooKeeper, the zxid or a znode's cversion serves as the token because both increase monotonically; Chubby hands out <strong>sequencers</strong> (lock name, mode, generation number) and falls back to a lock-delay for servers that can't check them. Kafka rejects a zombie transactional producer with <code>ProducerFencedException</code> once a newer epoch exists, and brokers ignore a controller with a stale epoch; Raft terms play the same role (<a href="#/ch9/concepts/epoch-numbering">Chapter 9</a>). In SQL: <code>UPDATE ... SET fence = :token WHERE id = :id AND fence &lt;= :token</code>.`,
      section: "fencing-tokens",
    },

    // --- byzantine-faults ---
    {
      id: "byzantine-fault",
      term: "Byzantine fault",
      def: `A node that behaves <strong>arbitrarily</strong>: it sends corrupted or contradictory messages, lies about its state, or acts maliciously, rather than just crashing or running slowly. A system is Byzantine fault-tolerant (BFT) if it keeps working correctly despite some such nodes; most BFT algorithms need more than two-thirds of nodes to be honest, n ≥ 3f + 1 (versus 2f + 1 for crash faults).`,
      problem: `Fencing and majorities assume nodes may be wrong but never lie; with untrusted participants or corrupted hardware, a node may send fake tokens or contradictory messages.`,
      why: `Datacenter systems usually don't pay for BFT: one organization controls every node, radiation-induced memory corruption is rare at ground level, and BFT protocols need more nodes and messages (classic PBFT exchanges O(n<sup>2</sup>) messages per decision; newer protocols such as HotStuff are linear in the common case). BFT also doesn't save you from a bug present in every replica (that needs independently written implementations), and an attacker who can break one identical node can probably break them all, so authentication, access control and encryption remain the main defense. Web apps don't need BFT for untrusted browsers either: the server is the authority and validates every input.`,
      ex: `Lamport, Shostak and Pease (1982) showed that with unsigned ("oral") messages, three generals can't tolerate one traitor; signed messages change the bound. The Space Shuttle flew four computers running identical primary flight software that voted (catching hardware faults) plus a fifth running independently developed backup flight software, because identical copies can't out-vote a shared bug. Bitcoin reaches agreement among untrusted parties with proof-of-work, not PBFT; PBFT-style protocols appear in some permissioned and proof-of-stake systems (for example Tendermint, now CometBFT).`,
      section: "byzantine-faults",
    },
    {
      id: "weak-lying",
      term: "Weak forms of lying",
      def: `Non-malicious invalid data: packets corrupted in ways that slip past TCP/UDP checksums, bit flips in memory or on disk, buggy or misconfigured nodes, malformed user input. Defended with application-level checksums, input validation and outlier rejection (for example, NTP clients querying several servers).`,
      problem: `Full Byzantine fault tolerance is too costly for a datacenter, but cheap checks catch the corruption that really happens.`,
      why: `Bits do flip and bugs do produce garbage, and TCP's 16-bit checksum is weak; corruption introduced inside a router, a NIC driver or memory before a checksum is computed passes every link-level check. Cheap end-to-end checks catch most of it: checksums on messages and stored data verified by the application, strict validation of sizes and formats, and voting or outlier rejection wherever several independent sources are available. It is the pragmatic middle ground between "trust everything" and full BFT.`,
      ex: `Amazon S3, July 20, 2008: a single corrupted bit in a few internal gossip messages about server state left them parseable but wrong; the bad state spread through the system and caused a multi-hour outage, and Amazon added checksums to those messages. NTP clients query several servers, check that most agree on a time range, and discard outliers. At hyperscale, Google ("Cores that don't count", HotOS 2021) and Meta ("Silent Data Corruptions at Scale", 2021) found CPUs that occasionally compute wrong results with no error signal, a hardware lie only end-to-end verification catches.`,
      section: "byzantine-faults",
    },

    // --- system-models ---
    {
      id: "synchronous-vs-partially-synchronous-vs-asynchronous-models",
      term: "Synchronous vs partially synchronous vs asynchronous models",
      def: `Three timing models an algorithm may assume. <strong>Synchronous</strong>: network delay, process pauses and clock error all have <em>known upper bounds</em> (bounded, not zero). <strong>Partially synchronous</strong>: the system behaves synchronously most of the time but sometimes exceeds the bounds by arbitrary amounts. <strong>Asynchronous</strong>: no timing assumptions at all, not even a clock, so timeouts are impossible.`,
      problem: `To claim an algorithm is correct you must state what it may assume about timing; assuming bounded delays is unrealistic, assuming nothing makes timeouts impossible.`,
      why: `Partial synchrony is the realistic model for networks with unbounded queueing and GC pauses, and it is what Raft, Paxos and ZooKeeper's Zab are designed for: they keep <strong>safety even under full asynchrony</strong> and need the system to behave synchronously for a while only to make progress (elect a leader, commit entries). An algorithm that is correct only in the synchronous model, such as one that trusts a lease timeout alone for mutual exclusion, breaks on the first long pause. Don't confuse the synchronous <em>model</em> (a set of assumptions) with a synchronous <em>network</em> (bounded-delay circuits): related ideas, different things.`,
      ex: `The 2016 Redlock debate was a disagreement about the system model: Martin Kleppmann argued that Redlock's safety depends on bounded network delay, pauses and clock error (a synchronous model), and Redis author Salvatore Sanfilippo replied that such bounds are reasonable in practice. The Raft paper states the design rule outright: safety must not depend on timing, and timing (an election timeout well above the broadcast time) affects only availability.`,
      section: "system-models",
    },
    {
      id: "crash-stop-vs-crash-recovery-vs-byzantine",
      term: "Crash-stop vs crash-recovery vs Byzantine",
      def: `Node-failure models, from most to least benign. <strong>Crash-stop</strong>: a node fails only by halting and never comes back. <strong>Crash-recovery</strong>: nodes may crash and restart after an unknown time; data on stable storage survives, in-memory state is lost. <strong>Byzantine</strong>: nodes may do anything, including lie.`,
      problem: `Algorithms need an explicit assumption about how nodes fail; protocols built for one model are wrong or wasteful in another.`,
      why: `Each step toward Byzantine makes protocols harder and more expensive: tolerating f crash faults with majorities takes 2f + 1 nodes, tolerating f Byzantine faults typically takes 3f + 1. Crash-recovery with partial synchrony is the workhorse model for real systems. Its weak spot is the "stable storage survives" assumption: disks corrupt data, firmware bugs make drives vanish after a reboot, and a node that forgets data it promised to keep (<strong>amnesia</strong>) breaks quorum-overlap arguments. So real implementations still need code for the "impossible" case, even if it only logs loudly and stops for an operator.`,
      ex: `Ganesan et al., "Redundancy Does Not Imply Fault Tolerance" (FAST 2017), injected a single file-system fault on one node and found data loss or unavailability in widely used systems including Redis, ZooKeeper, Cassandra, Kafka and MongoDB. Raft and Paxos assume crash-recovery (votes and log entries are persisted before a node answers); PBFT-style protocols assume Byzantine nodes; crash-stop is mostly a simplifying abstraction, since real nodes usually restart.`,
      section: "system-models",
    },
    {
      id: "system-model-safety-liveness",
      term: "System model & safety/liveness",
      def: `A <strong>system model</strong> states what an algorithm may assume about timing and faults; correctness is a set of properties that must hold in every situation the model allows. A <strong>safety</strong> property says nothing bad happens: if it is violated you can point at the moment it broke, and the violation can't be undone. A <strong>liveness</strong> property says something good eventually happens: it may not hold at a given moment, but it can always still be satisfied later.`,
      problem: `"Correct" is meaningless until you say which properties must hold and under which faults; separating safety from liveness lets algorithms stall safely instead of returning wrong answers.`,
      why: `Distributed algorithms usually require safety <em>always</em>, even if every node crashes or the whole network fails, and promise liveness only under conditions (a majority of nodes up, the network eventually healing). Properties containing "eventually" are liveness properties: <a href="#/ch5/concepts/eventual-consistency">eventual consistency</a> is one. Proofs establish correctness within the model; testing (Jepsen, fault injection, deterministic simulation, model checking) catches implementation bugs and mismatches between the model and reality.`,
      ex: `For a fencing-token service: <strong>uniqueness</strong> (no two requests get the same token) and <strong>monotonic sequence</strong> (if request x completed before request y began, t<sub>x</sub> &lt; t<sub>y</sub>) are safety; <strong>availability</strong> (a node that requests a token and doesn't crash eventually gets one) is liveness. AWS engineers have used TLA+ since 2011 to model-check designs including S3, DynamoDB and EBS, finding subtle bugs such as a DynamoDB replication bug whose shortest error trace took 35 steps (Newcombe et al., CACM 2015); FoundationDB runs whole clusters in deterministic simulation with injected faults.`,
      section: "system-models",
    },
  ],

  // ------------------------------------------------------------------
  // CHEATSHEET
  // ------------------------------------------------------------------
  cheatsheet: [
    {
      title: "The six fates of an unanswered request",
      type: "table",
      headers: ["What happened", "Was the work done?", "What the client sees"],
      rows: [
        ["Request lost (packet dropped, cable unplugged)", "No", "Timeout"],
        ["Request queued (congested switch, overloaded receiver)", "Yes, late", "Timeout"],
        ["Remote node crashed", "No, if it crashed before processing (a crash just after the side effect looks identical)", "Timeout"],
        ["Remote node paused (GC, VM migration)", "Yes, late", "Timeout"],
        ["Reply lost (e.g., misconfigured switch)", "Yes", "Timeout"],
        ["Reply delayed (network or the client's own machine overloaded)", "Yes", "Timeout, then a late reply"],
      ],
      note: `In four of the six the work happened or will happen, and a real crash can strike after the side effect, so treat every timeout as <strong>outcome unknown</strong>: retries need <a href="#/ch12/concepts/idempotence-via-operation-ids">idempotency</a> (Ch 12).`,
    },
    {
      title: "What can go wrong over the network?",
      type: "list",
      items: [
        "Request lost",
        "Request delayed (arrives after the sender gave up)",
        "Request delivered, reply lost",
        "Reply delayed",
        "Duplicate delivery (a retry, or a resend by a higher layer)",
        "Reordering across connections or retries (TCP orders bytes only within one connection)",
        "Receiver alive but too busy, or paused, to respond",
        "Receiver crashed mid-processing",
        "TCP ACK received, but the application crashed before processing the bytes",
        "Partial / one-way partitions (A reaches B, B reaches C, A can't reach C; or only one direction works)",
      ],
      note: "The sender can't tell these apart: all it observes is silence or a late answer.",
    },
    {
      title: "Fault signals you sometimes get",
      type: "table",
      headers: ["Signal", "What it tells you", "What it doesn't"],
      rows: [
        ["TCP RST / connection refused", "The machine is up but nothing listens on the port (process died)", "Whether earlier requests were processed"],
        ["Crash-notification script (HBase does this)", "The process died while the OS kept running, so others can take over without waiting for a timeout", "Anything, if the whole machine died or is unreachable"],
        ["Switch link-down (management interface)", "A physical link failed", "Needs datacenter access; useless over the internet or if the machine lost power"],
        ["ICMP Destination Unreachable", "A router believes the host is unreachable", "Routers can be wrong, or silent"],
        ["Ping or TCP connect succeeds", "The kernel and the network path work", "That the application is healthy (gray failure)"],
        ["Silence", "Something is wrong or slow, somewhere", "Which of the six fates happened: the most common case"],
      ],
    },
    {
      title: "Timeout too short vs too long",
      type: "table",
      headers: ["", "Too short", "Too long"],
      rows: [
        ["Detecting a real crash", "Fast", "Slow: requests hang or fail meanwhile"],
        ["False alarms", "Many, under load spikes, GC pauses, batch jobs", "Few"],
        ["Side effects", "Duplicate actions (the 'dead' node finishes too), failover churn, cascading failure", "Long user-visible unavailability before failover"],
        ["Lesser evil when", "Recovery is cheap and idempotent (retry a read elsewhere)", "Recovery is expensive or risky (leader failover, re-replicating terabytes)"],
      ],
      note: "There is no correct value: real networks have unbounded delay, so the 2d + r timeout doesn't exist. Measure, or adapt.",
    },
    {
      title: "Choosing and using timeouts: a decision guide",
      type: "list",
      items: [
        "Measure RTT and heartbeat gaps over weeks and many machines, including peak load, GC and batch windows (<a href=\"#/ch1/concepts/percentiles\">percentiles</a>); set the timeout well above the tail you must tolerate",
        "Prefer adaptive detection: φ accrual (Cassandra, Akka) or TCP-style smoothed RTT + 4 × mean deviation",
        "Separate <strong>suspected</strong> from <strong>dead</strong> (hysteresis); require several observers or SWIM-style indirect probes through k other nodes before declaring death",
        "Probe the application (a cheap real request, latency, error rate), not just ICMP ping or TCP connect",
        "Rate-limit automatic recovery: cap concurrent re-replication and failovers; retry with exponential backoff and jitter, under a budget",
        "Pair every single-owner decision with fencing (tokens, epochs), so a node declared dead by mistake can't do damage",
        "Set client timeouts explicitly: OS defaults are far too long (Linux TCP retries an established connection for ~15 min)",
      ],
    },
    {
      title: "Where delay comes from (queues everywhere)",
      type: "table",
      headers: ["Queue", "Why packets or requests wait", "Typical trigger"],
      rows: [
        ["Sender's TCP send buffer", "Flow control and congestion avoidance cap the sending rate", "Slow receiver, congested path"],
        ["Switch output queue", "Several senders target one port; a full queue drops packets", "Bursts, many-to-one traffic, noisy neighbors"],
        ["TCP retransmission", "A lost packet is resent only after a timeout; the app just sees delay", "Drops anywhere on the path"],
        ["Receiver's OS run queue", "All cores busy; the request waits for a CPU", "Load spikes, CPU-heavy neighbors"],
        ["Hypervisor", "VM descheduled for tens of ms while another VM runs; incoming data is buffered", "Multi-tenant hosts (steal time)"],
        ["Application thread pool", "Workers busy or paused", "GC pauses, slow downstream calls"],
      ],
      note: "Latency rises sharply as utilization nears 100%, so timeouts misfire exactly when the system is busiest.",
    },
    {
      title: "Circuit vs packet switching",
      type: "table",
      headers: ["", "Circuit (telephone, ISDN)", "Packet (Ethernet/IP datacenter)"],
      rows: [
        ["Bandwidth", "Reserved per call along the whole route", "Shared dynamically, packet by packet"],
        ["Delay", "Bounded: no queueing", "Unbounded: packets queue at every hop"],
        ["Utilization", "Wasted while the reservation is idle", "High: idle capacity is used by others"],
        ["Fits", "Constant-rate streams (voice: 16 bits × 4,000 frames/s = 64 kbit/s)", "Bursty transfers that just want to finish fast"],
        ["Bounded latency possible?", "Built in", "Only with QoS + admission control (or InfiniBand-style flow control); not offered in multi-tenant clouds or the internet"],
      ],
      note: "Variable delay is the price of high utilization: a cost decision, not a law of nature.",
    },
    {
      title: "Which clock for which job",
      type: "table",
      headers: ["Clock", "Example APIs", "Can it jump?", "Comparable across nodes?", "Use for"],
      rows: [
        ["Time-of-day (wall clock)", "<code>CLOCK_REALTIME</code>, <code>System.currentTimeMillis()</code>", "Yes (NTP step, leap second, VM pause)", "Roughly (ms to s of skew)", "Human-facing timestamps, log times, coarse expiry"],
        ["Monotonic", "<code>CLOCK_MONOTONIC</code>, <code>System.nanoTime()</code>, Go's monotonic reading in <code>time.Time</code>", "No (rate slewed by up to 0.05%)", "No: the absolute value is meaningless", "Timeouts, durations, latency, local lease countdowns"],
        ["Logical (Lamport, version vectors)", "Counters carried on messages", "n/a", "Order only (HLC adds closeness to wall time)", "Causality and ordering (Ch 5, Ch 9)"],
        ["TrueTime interval", "<code>TT.now()</code> = [earliest, latest]", "n/a (the interval widens between syncs)", "Yes, with explicit ±ε", "External consistency via commit wait"],
      ],
      note: "Linux <code>CLOCK_MONOTONIC</code> stops while the system is suspended; <code>CLOCK_BOOTTIME</code> keeps counting.",
    },
    {
      title: "Why you can't trust clocks",
      type: "list",
      items: [
        "Quartz drifts, more with temperature: Google assumes 200 ppm, ~6 ms per 30 s, ~17 s per day without resync (the book's figures)",
        "NTP over the internet: ~35 ms best case in one experiment, with spikes near 1 s",
        "NTP can step the clock backward or forward, or refuse to sync when it is too far off",
        "A node firewalled off from NTP drifts silently; nothing crashes",
        "Leap seconds repeat or stall a second (being phased out by 2035; smearing hides them, but don't mix smeared and unsmeared servers)",
        "Virtualization: a paused VM sees its clock jump forward when it resumes",
        "Client devices may have deliberately wrong clocks: never trust them for anything important",
        "Time-of-day clock ≠ monotonic clock: use monotonic for durations",
        "A reading with microsecond digits can be off by tens of milliseconds: it is an interval, not a point",
      ],
    },
    {
      title: "Last-write-wins on physical timestamps: three failure modes",
      type: "table",
      headers: ["Problem", "What happens", "Fix"],
      rows: [
        ["Lagging clock", "Writes from a node with a slow clock lose to earlier writes from a fast clock until the skew elapses: acknowledged, then silently discarded", "Monitor offsets and evict drifting nodes; HLC for causally dependent writes; avoid LWW for data that must not be lost"],
        ["Sequential vs concurrent", "LWW can't tell writes in quick succession from truly concurrent ones", "Version vectors with siblings or app-level merge (Ch 5); CRDTs"],
        ["Equal timestamps", "Two nodes can generate the same timestamp (especially at ms resolution)", "A tiebreaker (node ID, random number), which may itself violate causality"],
      ],
      note: "Client-generated timestamps don't help. The book's example: 3 ms of skew (node 1 stamps the earlier write 42.004, node 3 stamps the later one 42.003) is enough to lose an increment that depended on the earlier write. Cassandra still resolves conflicts per cell this way.",
    },
    {
      title: "TrueTime and commit wait",
      type: "note",
      body: `<p><span class="formula">s = TT.now().latest → wait until TT.now().earliest &gt; s → make the commit visible</span></p>
<ul>
<li>Wait ≈ 2ε (ε roughly 1 to 7 ms in the 2012 paper), overlapped with Paxos replication.</li>
<li>Guarantee: if T2 starts after T1 is visible, s<sub>2</sub> &gt; s<sub>1</sub>: external consistency (strict serializability).</li>
<li>Applies to read-write transactions; read-only transactions read a snapshot at a timestamp without commit wait.</li>
<li>Rests on GPS and atomic-clock time masters in each datacenter plus an assumed drift bound; if a clock's real error exceeds ε, ordering breaks, so bad clocks are evicted.</li>
<li>HLC alternative (CockroachDB, YugabyteDB): a configured max offset (500 ms default in CockroachDB) plus uncertainty restarts, no special hardware and no commit wait.</li>
</ul>`,
    },
    {
      title: "Sources of process pauses",
      type: "table",
      headers: ["Cause", "Why it's surprising", "Mitigation"],
      rows: [
        ["Stop-the-world GC", "Even 'concurrent' collectors (e.g., HotSpot's CMS) stop the world sometimes; old collectors on big heaps can pause for minutes", "Low-pause GC (ZGC, Shenandoah), heap tuning, drain the node before a planned GC"],
        ["VM suspend / live migration", "Invisible to the guest; its clock just jumps", "Design for it; fencing"],
        ["Hypervisor steal time", "Other tenants' VMs get the CPU", "Dedicated hosts; monitor steal time"],
        ["Synchronous or network-disk I/O", "Hides in class loading, page faults, logging; on EBS-like volumes disk latency is network latency", "Async I/O, preload, keep the hot path off the disk"],
        ["Swapping / paging", "Memory pressure turns memory access into disk I/O (thrashing)", "Disable swap; prefer an OOM kill and restart"],
        ["SIGSTOP / laptop lid closed", "An operator's Ctrl-Z or a suspended device freezes the process until SIGCONT or wake-up", "Fencing; never assume a client device stays awake"],
      ],
      note: "Mitigations shrink pauses; only fencing makes a protocol safe against them.",
    },
    {
      title: "Leases done right",
      type: "list",
      items: [
        "A lease is a lock with a timeout: it frees itself if the holder dies",
        "Never pass an absolute wall-clock expiry time between machines",
        "Holder: read the monotonic clock <strong>before</strong> sending acquire/renew; treat the lease as valid until start + duration − margin",
        "Grantor: count from the grant on its own monotonic clock; re-grant only after duration + margin",
        "Needs only a bound on relative clock rates (Chubby's client lease timeout works this way), not synchronized clocks",
        "Still unsafe against a pause between \"lease valid?\" and the action: pair every lease with a fencing token checked by the resource",
      ],
    },
    {
      title: "Fencing tokens to prevent stale-leader writes",
      type: "list",
      items: [
        "The lock service issues a token that increases with every grant",
        "The holder attaches its token to every write",
        "The resource remembers the highest token seen, rejects lower ones and accepts equal ones (<code>WHERE fence &lt;= :token</code>)",
        "The resource must check the token atomically with the write (conditional update / compare-and-set)",
        "An old (paused) holder waking up can't corrupt state; a zombie write that lands before the new holder's first token-bearing request is accepted, then superseded",
        "Side effects that can't check tokens (emails, third-party charges) need idempotency instead",
        "Protects against mistaken nodes, not malicious ones (Byzantine)",
        "ZooKeeper zxid/cversion, etcd revisions, Chubby sequencers, Kafka epochs and Raft terms all work this way",
      ],
    },
    {
      title: "Efficiency lock vs correctness lock",
      type: "table",
      headers: ["", "Efficiency lock", "Correctness lock"],
      rows: [
        ["Purpose", "Avoid doing the same work twice", "Prevent corruption from concurrent writers"],
        ["If two holders overlap", "Some wasted work or a duplicate notification", "Lost updates, corrupted files, double charges"],
        ["Good enough", "A single Redis <code>SET NX PX</code> lease", "Consensus-backed lock (ZooKeeper, etcd) plus fencing at the resource, or idempotent processing"],
        ["Example", "Two workers occasionally re-render the same thumbnail", "Two workers append to the same ledger or file"],
      ],
      note: "A longer TTL only shrinks the window; it never closes it.",
    },
    {
      title: "Majority quorum math",
      type: "table",
      headers: ["Voting members n", "Majority q = ⌊n/2⌋ + 1", "Failures tolerated f", "Comment"],
      rows: [
        ["1", "1", "0", "No fault tolerance"],
        ["2", "2", "0", "Worse than 1: either failure stops it"],
        ["3", "2", "1", "Smallest useful cluster"],
        ["4", "3", "1", "No better than 3; a 2|2 split stops everyone"],
        ["5", "3", "2", "Common production size (etcd, ZooKeeper)"],
        ["6", "4", "2", "No better than 5, and slower writes"],
        ["7", "4", "3", "Rarely worth the extra write latency"],
      ],
      note: "Count q over all configured voters, never over reachable nodes. Any two majorities overlap, so only one side of a partition can decide. Spread voters over 3 sites (e.g., 2 + 2 + 1); with 2 sites the majority site is a single point of failure. Scale reads with non-voting members (ZooKeeper observers, etcd learners).",
    },
    {
      title: "Fault models and what you get",
      type: "table",
      headers: ["", "Crash-stop", "Crash-recovery", "Byzantine"],
      rows: [
        ["Assumption", "Failed nodes never recover", "Nodes may crash and come back; stable storage survives, memory doesn't", "Nodes may lie, be compromised or disobey the protocol"],
        ["Nodes to tolerate f faults", "2f + 1 (with majorities)", "2f + 1 (with majorities)", "3f + 1 (most protocols)"],
        ["Used by", "A simplifying abstraction; real nodes usually restart", "Raft, Paxos, ZooKeeper, etcd (with partial synchrony)", "PBFT-style protocols, permissioned blockchains; Bitcoin uses proof-of-work instead"],
      ],
      note: "Crash-recovery's weak spot: disks that corrupt or forget data (amnesia) break quorum-overlap arguments.",
    },
    {
      title: "Timing models",
      type: "table",
      headers: ["Model", "Assumes", "Realistic?"],
      rows: [
        ["Synchronous", "Known upper bounds on network delay, process pauses and clock error", "No: queueing and GC make delays unbounded"],
        ["Partially synchronous", "Bounds hold most of the time but are sometimes exceeded by arbitrary amounts", "Yes: the usual choice (Raft, Paxos, Zab)"],
        ["Asynchronous", "No timing assumptions at all: no clocks, no timeouts", "Very restrictive (deterministic consensus can't guarantee termination: FLP, Ch 9)"],
      ],
      note: "Design rule: safety must hold even under asynchrony; use timing assumptions only for liveness. A synchronous model is not the same thing as a synchronous (circuit) network.",
    },
    {
      title: "Safety vs liveness",
      type: "table",
      headers: ["Property", "Examples"],
      rows: [
        ["<strong>Safety</strong>: nothing bad happens", "Token uniqueness, no two leaders in one term, no read of a value that was never written"],
        ["<strong>Liveness</strong>: something good eventually happens", "A requester eventually gets a token, eventual consistency, writes eventually acknowledged"],
      ],
      note: "Safety violations can be pinned to a moment and can't be undone; liveness can always still be satisfied later. Safety always; liveness only when the network behaves.",
    },
    {
      title: "Three famous impossibility-style results: don't mix them up",
      type: "table",
      headers: ["Problem", "Setting", "What can't be done", "Chapter"],
      rows: [
        ["Two Generals", "Lossy messages, honest parties", "Guarantee that both sides know they agree, with any finite number of messages", "Ch 8 (unreliable networks)"],
        ["Byzantine Generals", "Messages delivered, some parties lie", "Agreement with n ≤ 3f nodes using unsigned messages (needs n ≥ 3f + 1)", "Ch 8 (Byzantine faults)"],
        ["FLP", "Asynchronous model, one process may crash", "A deterministic consensus algorithm that always terminates", "Ch 9"],
      ],
      note: "Practical systems escape FLP with timeouts (partial synchrony) or randomization, and the Two Generals problem with retries plus idempotency.",
    },
    {
      title: "Failure toolbox: symptom to tool",
      type: "table",
      headers: ["Symptom", "Tool", "Where"],
      rows: [
        ["Request timed out: did it happen?", "Idempotency keys / request IDs, status query, reconciliation", "Ch&nbsp;8, Ch&nbsp;12"],
        ["Is that node dead or just slow?", "Measured or adaptive timeouts (φ accrual), indirect probes, hysteresis", "Ch 8"],
        ["Healthy to the detector, broken for users", "Request-level health signals, several observers (gray failure)", "Ch 8"],
        ["Two nodes both think they're leader", "Majority quorum for the decision", "Ch&nbsp;8, Ch&nbsp;9"],
        ["Zombie leaseholder writes after expiry", "Fencing tokens / epochs checked by the resource", "Ch 8"],
        ["LWW silently drops writes", "Version vectors, CRDTs, conditional writes, HLC", "Ch&nbsp;5, Ch&nbsp;8"],
        ["Need real-time order across datacenters", "TrueTime + commit wait, or HLC with a max offset and uncertainty restarts", "Ch&nbsp;8, Ch&nbsp;9"],
        ["Corrupted packets or data", "End-to-end checksums, input validation", "Ch&nbsp;8, Ch&nbsp;12"],
        ["Participants may lie", "BFT protocols (n ≥ 3f + 1)", "Ch 8"],
      ],
    },
    {
      title: "Numbers worth remembering",
      type: "list",
      items: [
        "Majority q = ⌊n/2⌋ + 1; crash tolerance n = 2f + 1 (3 nodes → 1 failure, 5 → 2)",
        "BFT: n ≥ 3f + 1 (4 nodes tolerate 1 liar)",
        "Quartz drift at 200 ppm: ~6 ms per 30 s, ~17 s per day",
        "NTP over the internet: ≥ ~35 ms error, spikes near 1 s (one experiment)",
        "Monotonic clock slew: at most 0.05%",
        "Spanner ε ≈ 1 to 7 ms (2012 paper); commit wait ≈ 2ε",
        "CockroachDB default max clock offset: 500 ms",
        "MiFID II HFT clocks: within 100 µs of UTC",
        "Linux TCP gives up on an established connection after ~15 min by default (<code>tcp_retries2 = 15</code>, ~924.6 s)",
        "Cassandra <code>phi_convict_threshold</code> default 8 (φ = 8 ≈ a 10<sup>−8</sup> chance under the model)",
        "ISDN circuit: 16 bits per frame × 4,000 frames/s = 64 kbit/s, bounded delay",
        "GitHub 2018: 43 s of lost connectivity → 24 h 11 min of degraded service",
        "Leap seconds: in effect ended by or before 2035 (CGPM 2022 lets UT1 − UTC exceed 1 s)",
      ],
    },
  ],

  // ------------------------------------------------------------------
  // INTERVIEW (grouped by deep-dive section)
  // ------------------------------------------------------------------
  interview: [
    // --- partial-failure ---
    {
      id: "q-gray-failure-health-checks",
      q: "Health checks say every backend is healthy, yet users' requests to one of them keep timing out. What is going on, and how would you design health checking to catch it?",
      diff: "medium",
      section: "partial-failure",
      a: `<p><strong>This is a gray failure</strong> (Huang et al., HotOS 2017): the component is degraded, not dead, and the failure detector and the users observe it from different places. The health check and real traffic take different paths through the backend, so they disagree. Typical culprits:</p>
<ul>
<li>The <code>/health</code> handler returns 200 from a code path that never touches the slow disk, the exhausted connection pool or the broken downstream dependency that real requests need.</li>
<li>A NIC or switch port drops a small fraction of packets: a tiny health probe usually gets through, while large or numerous real requests hit retransmissions and time out.</li>
<li>The backend fails only for some clients (one rack, one network path, one tenant's data), and the load balancer probes from a vantage point that works.</li>
</ul>
<p><strong>Design health checking around what users experience:</strong></p>
<ul>
<li><strong>Passive checks from real traffic.</strong> Track each backend's error rate and latency percentiles as callers see them and eject outliers. Envoy's outlier detection, for example, ejects hosts after consecutive errors or when their success rate falls well below their peers'.</li>
<li><strong>Active checks that exercise the real work</strong>, such as a cheap request through the same code path, rather than ICMP ping or a TCP connect, which prove only that the kernel answers.</li>
<li><strong>Several observers.</strong> Probe from more than one place, or require agreement before ejecting, so one observer's bad link can't condemn a healthy backend.</li>
<li><strong>Cap the blast radius.</strong> Limit the share of backends that can be ejected at once, and fail open: if every backend looks unhealthy, the checker or a shared dependency is the likelier culprit, so keep routing to all of them. AWS's Application Load Balancer behaves this way when every target in a group is unhealthy, and the Amazon Builders' Library article "Implementing health checks" discusses the trade-off.</li>
<li><strong>Client-side defenses</strong> for what slips through: per-request timeouts, retries to a <em>different</em> backend for idempotent requests, and a retry budget.</li>
</ul>
<p><strong>The trap in the other direction:</strong> a "deep" health check that fails whenever a shared database is slow makes <em>every</em> backend fail at once, and a load balancer that obeys removes the whole fleet, turning a partial problem into a total outage. Deep checks should inform alerts and ejection decisions with caps, not flip the whole fleet off.</p>`,
      followups: [
        "Why can a health check that tests the database cause a complete outage?",
        "How would you detect a backend that is slow only for clients in one rack?",
        "Should an overloaded backend report itself as unhealthy? What happens if all of them do?",
      ],
      pitfalls: [
        "Treating a successful ping or TCP connect as proof the service is healthy",
        "Deep health checks on a shared dependency with no fail-open behavior",
        "Ejecting backends with no cap on how many can be removed at once",
      ],
    },

    // --- unreliable-networks ---
    {
      id: "q01",
      q: "Why can't you distinguish a slow node from a dead node?",
      diff: "medium",
      section: "unreliable-networks",
      a: `<p><strong>Because the only evidence is messages, and silence fits many different realities.</strong> When a request gets no reply, any of six things may have happened:</p>
<ul>
<li><strong>Request lost</strong> (dropped packet, unplugged cable): the work didn't happen.</li>
<li><strong>Request queued</strong> in a congested switch or an overloaded receiver: it will be processed late.</li>
<li><strong>Node crashed</strong>: the work didn't happen, or happened just before the crash.</li>
<li><strong>Node paused</strong> (stop-the-world GC, VM migration): it will process the request when it resumes.</li>
<li><strong>Reply lost</strong>: the work happened.</li>
<li><strong>Reply delayed</strong>: the work happened; the answer arrives after you gave up.</li>
</ul>
<p>In most of these the work may well have been done, so "no reply" must mean <strong>outcome unknown</strong>, not "failed". And "slow" is common rather than exotic: packet networks and shared machines queue everything, delays grow exactly under load, and GC pauses and noisy neighbors add seconds at random.</p>
<p>Partial signals exist but none settles it: a TCP RST says no process is listening on the port, a crash-notification script (HBase does this) can announce a dead process, a switch can report a link down. A successful ping or TCP connect proves only that the kernel and the path work, not that the application is healthy (gray failure). So systems fall back on <strong>timeouts</strong>, treat the verdict as a suspicion, and make every consequential decision (who is leader, who holds a lock) by majority vote with fencing, so a wrong suspicion can't do damage.</p>`,
      followups: [
        "How would you choose the timeout?",
        "What is a φ accrual failure detector?",
        "Why might declaring a node dead too early make an outage worse?",
      ],
      pitfalls: [
        "Using ICMP ping as a liveness check",
        "Assuming a timeout means the request wasn't processed",
        "Saying TCP guarantees delivery (it guarantees ordering and deduplication within a live connection, not delivery or timing)",
      ],
    },
    {
      id: "q-timeout-payment-retry",
      q: "A checkout service calls a payment provider and the call times out. What should the checkout service do?",
      diff: "medium",
      section: "unreliable-networks",
      a: `<p><strong>Treat the outcome as unknown.</strong> The request may have been lost, may still be queued, the provider may be paused, or it may have charged the card and lost the reply. In several of these cases the customer <em>was</em> charged, so both obvious reactions are wrong: showing "payment failed" (the customer may be charged anyway, then pay again) and blindly retrying a non-idempotent call (a second charge).</p>
<p><strong>What to do:</strong></p>
<ul>
<li><strong>Make retries safe with an idempotency key.</strong> Generate a unique key once per payment intent (not per attempt), store it with the order, and send it on every attempt; the provider deduplicates, so a retry returns the original result. Stripe's <code>Idempotency-Key</code> header works this way.</li>
<li><strong>Or ask before retrying.</strong> If the provider supports it, look the payment up by a client-generated reference and retry only if it doesn't exist.</li>
<li><strong>Retry carefully:</strong> exponential backoff with jitter, a bounded retry budget, and a circuit breaker so a struggling provider isn't hammered by every checkout at once.</li>
<li><strong>Be honest and reconcile.</strong> Mark the order "payment pending", show the user "processing", and settle it asynchronously via webhooks or polling; a reconciliation job compares your orders with the provider's records.</li>
<li><strong>Pick the timeout from data</strong> (the provider's latency distribution and SLA): a timeout that is too short manufactures unknown outcomes.</li>
</ul>
<p>The principle underneath is the <a href="#/ch12/concepts/end-to-end-argument">end-to-end argument</a> (Chapter 12): deduplication has to happen at the final recipient. TCP's retransmission and deduplication work only within one connection, and a TCP acknowledgment says nothing about whether the provider processed the charge.</p>`,
      followups: [
        "How long must the provider remember idempotency keys, and what if a retry arrives after that?",
        "What if the provider doesn't support idempotency keys?",
        "How would you pick the timeout value?",
      ],
      pitfalls: [
        "Retrying immediately in a tight loop",
        "Treating a timeout as a decline and showing 'payment failed' (the customer may have been charged)",
        "Relying on TCP to guarantee the request was processed exactly once",
      ],
    },
    {
      id: "q-two-generals",
      q: "Explain the Two Generals problem. What does it imply for a client that needs to know whether its request was processed, and how do real systems cope?",
      diff: "medium",
      section: "unreliable-networks",
      a: `<p><strong>Setup:</strong> two generals on opposite hills must attack at the same time or lose. They communicate by messengers who cross enemy territory and may be captured. Nobody lies; messages can only be lost.</p>
<p><strong>Why no protocol works:</strong> suppose some protocol with a finite number of messages guaranteed that both generals know they agree. Look at its last message. It may be lost and its sender can't tell, so the sender must behave the same whether or not it arrived, which means the protocol must also work without it. Remove it and repeat until no messages remain: a contradiction. Every extra acknowledgment just creates a new unconfirmed last message.</p>
<p><strong>Implication for a client:</strong> if a request or its reply can be lost, no amount of acknowledging gives both sides certainty about the outcome. The client can only ask again.</p>
<p><strong>How real systems cope:</strong></p>
<ul>
<li><strong>At-least-once retries plus idempotency:</strong> the server deduplicates by request ID, so retrying until a reply arrives gives effectively-once results (<a href="#/ch11/concepts/exactly-once-semantics">Chapter 11</a>, <a href="#/ch12/concepts/idempotence-via-operation-ids">Chapter 12</a>).</li>
<li><strong>Durable intent and reconciliation:</strong> record "pending" on both sides and settle later through status queries or webhooks.</li>
<li><strong>Bounded waiting:</strong> timeouts, and accepting practical rather than absolute certainty ("the reply arrived; good enough").</li>
</ul>
<p>Atomic commitment doesn't escape it: <a href="#/ch9/concepts/two-phase-commit">two-phase commit</a> (Chapter 9) can block a participant indefinitely when the coordinator's decision doesn't arrive. Keep the three famous results apart: Two Generals is about <em>lossy channels</em> with honest parties; the <strong>Byzantine Generals</strong> problem is about <em>lying parties</em> whose messages are delivered (it needs n ≥ 3f + 1); <strong>FLP</strong> is about <em>asynchrony plus crashes</em> (<a href="#/ch9/concepts/flp-impossibility">Chapter 9</a>).</p>`,
      followups: [
        "Does exactly-once delivery exist? What do systems that advertise it actually provide?",
        "How is this different from the Byzantine Generals problem?",
        "Why doesn't two-phase commit solve it?",
      ],
      pitfalls: [
        "Adding a third or fourth acknowledgment 'to be sure'",
        "Confusing it with the Byzantine Generals problem (nobody lies here)",
        "Claiming TCP or a message broker guarantees exactly-once processing end to end",
      ],
    },

    // --- timeouts-and-delays ---
    {
      id: "q-design-failure-detector",
      q: "You run a 500-node storage cluster. Design how nodes detect that a peer has failed. How do you choose timeouts, and how do you keep failure detection from making outages worse?",
      diff: "hard",
      section: "timeouts-and-delays",
      a: `<p><strong>Start with the limitation.</strong> A node can't distinguish a dead peer from a slow one or from a broken link, so failure detection is always a probabilistic guess. The design goal is to guess well and, above all, to make wrong guesses cheap.</p>
<p><strong>1. Mechanism.</strong> All-to-all heartbeats among 500 nodes mean about 250,000 sender-receiver pairs per interval, and every node's own network trouble becomes false accusations. Use <strong>SWIM-style gossip membership</strong>: each period a node probes one random peer; if no ack arrives it asks k other nodes to probe the suspect <em>indirectly</em>, which filters out problems on the observer's own link. Membership changes spread by piggybacking on the probes. HashiCorp's memberlist (used by Consul and Serf) implements SWIM with its Lifeguard refinements. Probes should exercise the application (a cheap real request), not just ICMP ping or a TCP connect.</p>
<p><strong>2. Timeouts from data.</strong> Measure RTT and heartbeat inter-arrival distributions over weeks and across many machines, including peak traffic, GC pauses and nightly batch jobs, and set the timeout well above the tail. Better, adapt: a <strong>φ accrual detector</strong> (Cassandra, Akka) learns the gap distribution and raises suspicion continuously, so it tolerates a jittery network without being sluggish on a quiet one.</p>
<p><strong>3. Suspected is not dead.</strong> Add hysteresis: a suspected node gets a grace period to refute the rumor (SWIM's suspicion mechanism, where a node bumps its incarnation number to override stale reports about itself), and declaring death requires several observers to agree.</p>
<p><strong>4. Damage control.</strong> The real danger is the reaction, not the detection. Re-replicating a dead node's data or moving its leaderships is expensive, and doing it for many nodes at once can melt the cluster; AWS EBS's 2011 re-mirroring storm is the canonical example. So:</p>
<ul>
<li>Rate-limit automated recovery and cap concurrent re-replication.</li>
<li>Delay re-replication for nodes that may come back (Elasticsearch, for example, waits a minute by default before reallocating a departed node's shards).</li>
<li>Retry with exponential backoff and jitter.</li>
<li>Add a circuit breaker on the detector itself: if 30% of nodes look dead at once, the network or the detector is the likelier culprit, so pause automatic action and page a human.</li>
</ul>
<p><strong>5. Make false positives harmless.</strong> Anything that needs a single owner (partition leader, lock holder) is decided by a quorum and enforced with <strong>fencing tokens or epochs</strong>, so a node wrongly declared dead that keeps working can't corrupt data.</p>
<p><strong>6. Gray failures.</strong> A node that answers heartbeats but serves real requests slowly passes everything above. Feed request-level signals (per-node latency percentiles and error rates seen by callers) into routing and ejection decisions, as Envoy's outlier detection does.</p>`,
      followups: [
        "How would you handle a node that answers heartbeats but serves real requests very slowly (gray failure)?",
        "What happens if 30% of nodes are declared dead at once? How do you prevent a cascade?",
        "How does SWIM's indirect probing reduce false positives compared with all-to-all heartbeats?",
      ],
      pitfalls: [
        "Picking a small fixed timeout (e.g., 100 ms) 'for fast failover' without measuring tail latency under load",
        "Treating ICMP ping or a successful TCP connect as proof that the service is healthy",
        "Triggering re-replication or failover immediately on first suspicion, with no rate limits",
      ],
    },

    // --- two-clocks ---
    {
      id: "q04",
      q: "What is the difference between monotonic and time-of-day clocks?",
      diff: "easy",
      section: "two-clocks",
      a: `<p>They answer different questions.</p>
<ul>
<li><strong>Time-of-day clock</strong> (Linux <code>CLOCK_REALTIME</code>, Java <code>System.currentTimeMillis()</code>): "what time is it?" Seconds since the Unix epoch, ignoring leap seconds, synchronized by NTP. It can <strong>jump</strong>: NTP steps it backward or forward when it is far off, a leap second may repeat a second, a resumed VM jumps forward. It is comparable across machines only to the accuracy of synchronization (milliseconds at best with NTP).</li>
<li><strong>Monotonic clock</strong> (<code>CLOCK_MONOTONIC</code>, <code>System.nanoTime()</code>): "how much time passed?" It never goes backward; NTP may <strong>slew</strong> its rate by up to 0.05% but never steps it. Its absolute value (often time since boot) is meaningless, so comparing readings from two machines is nonsense. On Linux it stops during system suspend; <code>CLOCK_BOOTTIME</code> doesn't.</li>
</ul>
<p><strong>Rule:</strong> durations, timeouts and latencies use the monotonic clock; timestamps meant for humans or other machines use the wall clock, with its error in mind; neither one safely orders events across nodes on its own.</p>
<p><strong>Why it matters:</strong> on January 1, 2017, Cloudflare's Go DNS service computed a duration from wall-clock readings across the leap second, got a negative value, passed it to <code>rand.Int63n</code> and panicked, so some DNS lookups failed. Go 1.9 then made <code>time.Now()</code> carry a monotonic reading, so <code>time.Since</code> is immune to wall-clock steps.</p>`,
      followups: [
        "How would you measure request latency in Java or Go correctly?",
        "What happens to wall-clock time during a leap second?",
        "Why can't you use the monotonic clock to timestamp events in a distributed log?",
      ],
      pitfalls: [
        "Comparing monotonic readings across machines",
        "Measuring timeouts with System.currentTimeMillis()",
      ],
    },

    // --- ordering-by-timestamps ---
    {
      id: "q02",
      q: "Give an example of why you shouldn't use wall-clock time for distributed ordering.",
      diff: "hard",
      section: "ordering-by-timestamps",
      a: `<p><strong>Last-write-wins (LWW) on wall-clock timestamps</strong> is the classic case; Cassandra still resolves conflicts this way, per cell, and Riak can be configured to. With just 3 ms of skew:</p>
<ol>
<li>Client A writes <code>x = 1</code> via node 1, whose clock reads 42.004 s.</li>
<li>The write replicates to node 3. Client B reads <code>x = 1</code> there and increments it, writing <code>x = 2</code>; node 3's clock is 3 ms behind node 1's, so this later write is stamped 42.003 s.</li>
<li>Every replica applies LWW and keeps the larger timestamp: <code>x = 1</code>. B's write was acknowledged and is now silently gone, even though it causally depended on A's write.</li>
</ol>
<p><strong>Three problems with LWW on physical time:</strong></p>
<ul>
<li>A node with a lagging clock can't overwrite values written by a node with a fast clock until the skew has elapsed: arbitrary data loss, with no error.</li>
<li>It can't tell writes in quick succession from truly concurrent ones.</li>
<li>Two nodes can produce the same timestamp (especially at millisecond resolution), so a tiebreaker is needed, which can itself violate causality.</li>
</ul>
<p>Better NTP doesn't fix it: synchronization error is limited by network delay, and causally related writes can be closer together than that. Client-side timestamps move the problem rather than remove it.</p>
<p><strong>Fixes:</strong></p>
<ul>
<li><strong>Logical clocks:</strong> <a href="#/ch9/concepts/lamport-timestamps">Lamport timestamps</a> (Ch 9) give an order consistent with causality but can't detect concurrency; <a href="#/ch5/concepts/concurrent-writes-version-vectors">version vectors</a> and <a href="#/ch5/concepts/crdts">CRDTs</a> (Ch 5) detect and merge concurrent writes.</li>
<li><strong>Hybrid logical clocks</strong> (CockroachDB, YugabyteDB): timestamps stay close to wall time, but a causally later write always gets a larger one; in the example, node 3 would have moved past 42.004 when it received A's write.</li>
<li><strong>TrueTime with commit wait</strong> (Spanner): timestamp order matches real-time order.</li>
<li>Or avoid timestamp-based conflict resolution: a single leader per key, or conditional writes.</li>
</ul>`,
      followups: [
        "Why doesn't better NTP solve it?",
        "How does Spanner avoid this?",
        "Which logical clock can detect that two writes were concurrent?",
      ],
      pitfalls: [
        "Switching to client-side timestamps",
        "Assuming NTP keeps clocks within microseconds",
        "Saying Cassandra 'used to' use timestamps (it still does)",
      ],
    },
    {
      id: "q-lww-disappearing-writes",
      q: "Your multi-region key-value store resolves conflicts with last-write-wins using server timestamps. Users report that some updates 'didn't save', with no errors. How do you investigate and fix it?",
      diff: "medium",
      section: "ordering-by-timestamps",
      a: `<p><strong>Hypothesis: clock skew plus LWW.</strong> If one node's clock runs fast, its writes carry timestamps from the future; a later write coordinated by a node with a slower clock gets a smaller timestamp, is acknowledged, and is then discarded on every replica. Truly concurrent writes also lose one side by design. No error is ever raised, which matches "didn't save".</p>
<p><strong>Investigate:</strong></p>
<ul>
<li>Find a lost write and the value that beat it, and compare their timestamps with real-world order (request logs, client logs): the loser happened later in real time but carries a smaller timestamp.</li>
<li>Check which node or region coordinated each write and its NTP offset history: look for a node firewalled off from NTP, a stepped clock, clock jumps after VM pauses, or a mix of smeared and non-smeared NTP sources.</li>
<li>Rule out the alternatives: two users writing concurrently (LWW's normal loss), client-supplied timestamps, replication lag that only <em>looks</em> like loss.</li>
</ul>
<p><strong>Fix, depending on the data:</strong></p>
<ul>
<li><strong>Operationally:</strong> alert on clock offset per node and take nodes beyond a threshold out of service.</li>
<li><strong>For data where updates must not be lost:</strong> conditional writes (compare-and-set on a version), version vectors with siblings or an application-level merge (<a href="#/ch5/concepts/concurrent-writes-version-vectors">Ch 5</a>), <a href="#/ch5/concepts/crdts">CRDTs</a> for counters and sets, or route each key's writes through a single leader or home region.</li>
<li><strong>Hybrid logical clocks</strong> guarantee a causally later write a larger timestamp (they fix read-then-write sequences) but don't help with concurrent writes.</li>
</ul>
<p>Don't switch to client-side timestamps: client clocks are worse. LWW remains fine for insert-only data with unique keys, caches, and data where losing one of two concurrent updates is acceptable.</p>`,
      followups: [
        "Why doesn't tighter NTP synchronization fully solve this?",
        "What is a hybrid logical clock and what does it fix?",
        "When is last-write-wins an acceptable choice?",
      ],
      pitfalls: [
        "Blaming replication lag alone",
        "Switching to client-side timestamps",
        "Assuming NTP keeps clocks within microseconds",
      ],
    },
    {
      id: "q-spanner-commit-wait",
      q: "How does Spanner use clocks to give externally consistent transactions, and what does it cost?",
      diff: "hard",
      section: "ordering-by-timestamps",
      a: `<p><strong>TrueTime</strong> replaces a single clock reading with an interval: <code>TT.now()</code> returns <code>[earliest, latest]</code>, guaranteed to contain the true time as long as the assumed drift bound holds. The width 2ε is kept small by GPS receivers and atomic clocks ("time masters") in every datacenter and a daemon on each machine that polls them; the 2012 paper reports ε varying roughly between 1 and 7 ms in a sawtooth between synchronizations.</p>
<p><strong>Commit wait:</strong></p>
<ol>
<li>A read-write transaction holds its locks (two-phase locking) and picks commit timestamp s = <code>TT.now().latest</code>, which is no earlier than the true time.</li>
<li>It waits until <code>TT.now().earliest</code> &gt; s: s is now certainly in the past, everywhere. This takes about 2ε and overlaps with Paxos replication of the commit.</li>
<li>Only then does it make the commit visible: acknowledge the client and release the locks.</li>
</ol>
<p><strong>Why it works:</strong> a transaction T2 that starts after T1's commit is visible reads <code>TT.now().latest</code> at a moment when the true time already exceeds s<sub>1</sub>, so s<sub>2</sub> &gt; s<sub>1</sub>. Timestamp order therefore matches real-time order: <strong>external consistency</strong>, i.e., strict serializability. As a bonus, a read at a chosen timestamp sees a consistent snapshot across all shards and datacenters without taking locks.</p>
<p><strong>Costs:</strong></p>
<ul>
<li>About 2ε added to every read-write commit (around 8 ms with the 2012 paper's typical ε of 4 ms, up to about 14 ms at the top of the sawtooth); read-only transactions don't commit-wait.</li>
<li>Special hardware and the operations to run it.</li>
<li>Correctness rests on the clock assumption: if a machine's real error exceeds ε, the ordering can break, so Spanner monitors clocks and evicts misbehaving machines.</li>
</ul>
<p><strong>Contrast:</strong> CockroachDB and YugabyteDB use hybrid logical clocks with a configured maximum offset (500 ms by default in CockroachDB) and restart reads that hit the uncertainty window, instead of waiting on every commit. No special hardware is needed, but correctness depends on the max-offset assumption (nodes shut down if they detect larger skew), and they don't promise Spanner's full real-time ordering for unrelated transactions.</p>`,
      followups: [
        "Why not do commit wait with plain NTP?",
        "What happens if a server's real clock error exceeds ε?",
        "How do read-only transactions choose a timestamp without locking?",
      ],
      pitfalls: [
        "Claiming atomic clocks make clocks perfectly synchronized",
        "Saying commit wait happens on every read",
        "Confusing TrueTime with logical clocks",
      ],
    },

    // --- process-pauses ---
    {
      id: "q07",
      q: "Explain process pauses and their impact on distributed systems.",
      diff: "hard",
      section: "process-pauses",
      a: `<p>A <strong>process pause</strong> is any stretch during which a thread stops executing without knowing it. Common causes:</p>
<ul>
<li><strong>Stop-the-world garbage collection:</strong> seconds or even minutes on large heaps with older collectors; mostly-concurrent collectors still stop the world briefly.</li>
<li><strong>VM suspend and live migration</strong>, and hypervisor <strong>steal time</strong> when other tenants' VMs get the CPU.</li>
<li><strong>Synchronous disk I/O</strong> in unexpected places (a Java classloader lazily loading a class file, logging), and network-attached disks such as EBS, where disk latency is network latency.</li>
<li><strong>Swapping</strong> under memory pressure, an operator's <code>SIGSTOP</code> (Ctrl-Z) followed later by <code>SIGCONT</code>, or a laptop lid closing.</li>
</ul>
<p><strong>Impact:</strong> the rest of the cluster keeps going. Peers time out, declare the node dead and give its lease or leadership to someone else, while from the paused node's point of view no time passes. Code that checks at 09:59:55 that its lease runs until 10:00:00 can freeze for 15 s and write at 10:00:10 with no lease, while the new holder writes too: corrupted data. The book notes HBase once had exactly this bug.</p>
<p><strong>Can pauses be eliminated?</strong> Hard real-time systems (airbags, flight control) bound response times with a real-time OS, documented worst-case execution times and restricted allocation, at a cost far too high for server software. Low-pause GCs (ZGC, Shenandoah) cut GC pauses to around a millisecond, and some trading systems drain a node before a planned GC, but VM migration, steal time and I/O stalls remain.</p>
<p><strong>So design for unbounded pauses:</strong> never rely on "I still have plenty of lease time left"; make the resource enforce exclusivity with <strong>fencing tokens</strong> (or atomic conditional writes on a version), and make side effects idempotent.</p>`,
      followups: [
        "How do some trading systems limit GC impact?",
        "Why doesn't checking the lease right before writing fix it?",
        "What would it take to rule out pauses entirely?",
      ],
      pitfalls: [
        "Assuming a low-pause GC eliminates all pauses",
        "Relying on 'I still have plenty of lease time left' reasoning",
        "Thinking only garbage-collected languages pause (VMs, I/O and swapping pause C++ and Rust too)",
      ],
    },
    {
      id: "q-gc-pause-leader-timeline",
      q: "Your database leader freezes in a 40-second GC pause. Walk through what happens in the cluster during the pause and after it wakes up, and what makes the outcome safe or unsafe.",
      diff: "hard",
      section: "process-pauses",
      a: `<p><strong>During the pause (0 to 40 s):</strong></p>
<ul>
<li>Followers stop receiving heartbeats. After their election timeout (typically hundreds of milliseconds to a few seconds), one of them starts an election in a higher <strong>term</strong> (epoch) and wins a majority. The cluster has a new leader within seconds.</li>
<li>Clients of the old leader time out and retry, eventually reaching the new one through redirects or rediscovery.</li>
<li>Requests sitting in the old leader's socket buffers and queues are frozen along with it.</li>
</ul>
<p><strong>When it wakes up (40 s):</strong> its view of the world is 40 seconds stale, and from its perspective no time passed. Before it learns anything new it may try to replicate log entries, acknowledge writes or serve reads as leader.</p>
<p><strong>What makes it safe:</strong></p>
<ul>
<li><strong>Every leader action needs a majority, checked against the term.</strong> Followers reject messages carrying the stale term and tell the old leader about the newer one, so it steps down. It can't commit anything, because no majority will accept it.</li>
<li><strong>External resources check fencing tokens or epochs</strong>, so writes it makes outside the replicated log are rejected.</li>
<li><strong>Writes it accepted but hadn't replicated to a majority</strong> were never committed and are discarded when it rejoins as a follower; correct systems never told those clients they succeeded.</li>
</ul>
<p><strong>What makes it unsafe:</strong></p>
<ul>
<li><strong>Local reads on a time-based leader lease</strong> are safe only if the leader's clock actually measured the pause and clock drift stays within the assumed bound. If its clock missed part of the pause or ran slow, it can serve fresh requests with stale data after the new leader has accepted writes.</li>
<li><strong>Time-based leases guarding external resources without fencing:</strong> the zombie leader's writes land.</li>
<li><strong>Unfenceable side effects</strong> (emails, payment API calls) started by the old leader happen twice.</li>
</ul>
<p><strong>Mitigations:</strong> low-pause GC, heap sizing, disabling swap and monitoring pause times make this rarer; quorum checks, terms and fencing make it harmless when it happens anyway.</p>`,
      followups: [
        "How can a leader serve linearizable reads without contacting a majority, and what timing assumption does that add? (Ch 9)",
        "What changes if the paused process was a lock holder rather than a leader?",
      ],
      pitfalls: [
        "'The old leader will notice its lease expired and stop': it can't notice during the pause and may act before checking",
        "Believing the monotonic clock makes lease checks safe against a pause between the check and the action",
      ],
    },
    {
      id: "q-lease-without-synced-clocks",
      q: "A lock service grants 10-second leases. The holder and the lock server have unsynchronized wall clocks. How do you implement lease expiry correctly on both sides, and what can still go wrong?",
      diff: "hard",
      section: "process-pauses",
      a: `<p><strong>Don't ship an absolute expiry time.</strong> The naive design has the server reply "your lease expires at 12:00:10" and the client compare that with its own wall clock. Safety then depends on two machines' clocks agreeing, and it breaks as soon as NTP steps either clock or they drift apart.</p>
<p><strong>Use durations on monotonic clocks, and make each side conservative:</strong></p>
<ul>
<li><strong>Holder:</strong> read its monotonic clock <em>before</em> sending the acquire or renew request (t<sub>0</sub>) and treat the lease as valid until t<sub>0</sub> + 10 s − margin. It can't know how long the request and reply spent in flight, and counting from before the send guarantees its view of the lease ends no later than the server's.</li>
<li><strong>Server:</strong> count from the moment it granted (which is after t<sub>0</sub> in real time) on its own monotonic clock, and don't grant the lease to anyone else until 10 s + margin has passed.</li>
<li><strong>Margin:</strong> sized from a bound on how fast the two clocks can run relative to each other (if each may be off by 200 ppm in opposite directions, about 4 ms per 10 s) plus slack. That is the only timing assumption: bounded relative clock rates, not synchronized time.</li>
</ul>
<p>The Chubby paper describes its client-side lease timeout this way, as a conservative approximation of the master's, and leader-lease optimizations in Raft-style systems rest on the same bounded-drift assumption.</p>
<p><strong>What can still go wrong:</strong></p>
<ul>
<li>The holder can be <strong>paused</strong> (GC, VM migration) between checking "still valid?" and acting, or its request can sit in a network queue, so the action lands after expiry anyway.</li>
<li>The drift bound can be violated: VM clock jumps, a faulty oscillator, or a machine suspend that <code>CLOCK_MONOTONIC</code> doesn't count.</li>
<li>A lost renewal reply: the holder must stop at its own deadline even though the server may have extended the lease.</li>
</ul>
<p><strong>So:</strong> treat the lease as a liveness and efficiency mechanism (it frees the lock when the holder dies) and get safety from <strong>fencing tokens</strong> checked by the resource.</p>`,
      followups: [
        "Why must the client start its timer before sending the request rather than when the reply arrives?",
        "What does a Raft leader lease for local reads assume, and what breaks if that assumption fails? (Ch 9)",
        "How would you add fencing to this design?",
      ],
      pitfalls: [
        "Passing an absolute wall-clock expiry time between machines",
        "Starting the client's countdown when the grant arrives (its view then expires later than the server's)",
        "Believing monotonic clocks make the lease safe against process pauses",
      ],
    },

    // --- truth-by-majority ---
    {
      id: "q06",
      q: "What does 'truth is defined by the majority' mean?",
      diff: "medium",
      section: "truth-by-majority",
      a: `<p>A node can't trust its own judgment of the situation, so the system never lets a single node decide what is true. A decision (who is leader, whether a write is committed, who holds a lock) counts only if a <strong>quorum</strong>, usually a strict majority of the configured voting members, agrees.</p>
<p><strong>Why a node can be wrong about itself:</strong></p>
<ul>
<li>A <strong>semi-disconnected</strong> node receives messages but its outgoing ones are dropped: the others declare it dead while it feels perfectly healthy. Even if it notices its messages go unacknowledged, it can't overturn the verdict.</li>
<li>A node frozen in a <strong>long GC pause</strong> is declared dead and replaced; when it resumes it carries on as if nothing happened, still believing it is the leader.</li>
</ul>
<p><strong>Why majorities work:</strong> with q = ⌊n/2⌋ + 1, any two majorities share at least one node, so two conflicting decisions can't both gather a quorum, and in any partition at most one side can act. n = 2f + 1 nodes tolerate f failures (3 tolerate 1, 5 tolerate 2). Even sizes add nothing: 4 nodes need 3 votes and still tolerate only 1 failure, and a 2|2 split leaves nobody able to decide (safe, but not live).</p>
<p><strong>Concretely, in Raft:</strong> a leader needs votes from a majority in its term, an entry is committed once a majority has stored it, and a partitioned minority can neither elect a competing leader nor commit anything. An old leader stranded in the minority may still <em>believe</em> it leads, which is why the next tool is fencing.</p>
<p><strong>The limit:</strong> majorities handle crashed, slow, partitioned and confused nodes, all assumed honest. They don't handle nodes that lie; that needs Byzantine fault tolerance and n ≥ 3f + 1.</p>`,
      followups: [
        "What happens in a 4-node cluster split 2|2?",
        "Why use three datacenters rather than two?",
        "Why must the majority be counted over all configured members rather than the reachable ones?",
      ],
      pitfalls: [
        "Letting the side with the old leader continue",
        "Even cluster sizes for 'tie-breaking'",
        "Claiming majority quorums protect against Byzantine nodes",
      ],
    },
    {
      id: "q-quorum-placement",
      q: "You run a 5-node etcd (or ZooKeeper) cluster that your services use for leader election. How should you place the nodes across two or three datacenters or availability zones, and what do clients on the minority side experience during a partition?",
      diff: "medium",
      section: "truth-by-majority",
      a: `<p><strong>Basics:</strong> 5 voters need q = 3, counted over all 5 configured members, never over whichever ones are currently reachable. Any two majorities overlap, so only one side of a partition can elect a leader or commit; 5 voters tolerate 2 failures. (Chapter 9's consensus questions cover why 3 or 5 rather than 4.)</p>
<p><strong>Two sites (3 + 2):</strong></p>
<ul>
<li>Lose or isolate the 2-node site: the 3-node side keeps its majority. Harmless.</li>
<li>Lose or isolate the 3-node site: 2 of 5 remain, so no writes, no elections and no linearizable reads until it returns.</li>
<li>With two sites, one of them always holds the majority and is a single point of failure for availability; moving nodes around can't fix that. An even split such as 3 + 3 with six voters is worse: losing the link between the sites leaves neither side a majority.</li>
</ul>
<p><strong>Three sites (2 + 2 + 1):</strong> losing any one site leaves at least 3 voters. The third site can be small, a single voter acting as tiebreaker, but if it lands in the commit quorum its WAN round trip is added to writes, so put it where that latency is tolerable. Even sizes still don't help: 4 voters placed 2 + 1 + 1 lose their majority when the 2-node site fails.</p>
<p><strong>What minority-side clients see:</strong> writes and linearizable reads block or fail with timeouts, and elections can't complete. A leader stranded in the minority can't commit anything, and many Raft implementations (etcd's check-quorum, for one) make it step down once it stops hearing from a majority. Serving possibly stale local reads (etcd's so-called serializable reads, a name that has nothing to do with serializable isolation; ZooKeeper's default reads from any server) is a deliberate availability trade-off; see <a href="#/ch9/concepts/cap-theorem">CAP</a> in Chapter 9.</p>
<p><strong>Scaling reads:</strong> add non-voting members (ZooKeeper observers, etcd learners) rather than more voters, which would make every write wait for more acknowledgments.</p>`,
      followups: [
        "Could an operator force the minority side to continue? What's the risk?",
        "What does a quorum spanning sites cost on each write?",
        "Why not run 9 voting members for extra safety?",
      ],
      pitfalls: [
        "Splitting 3 + 3 (or 2 + 2) across two datacenters",
        "Computing the majority over the nodes that are currently reachable",
        "Assuming the side that still has the old leader keeps working",
      ],
    },

    // --- fencing-tokens ---
    {
      id: "q03",
      q: "What is a fencing token and why is it needed?",
      diff: "hard",
      section: "fencing-tokens",
      a: `<p>A <strong>fencing token</strong> is a number the lock service hands out with every lock or lease grant, strictly increasing from one grant to the next. The holder includes it with every write; the protected resource remembers the highest token it has seen and rejects any request carrying a <em>lower</em> one (an equal token is the current holder writing again).</p>
<p><strong>Why it's needed:</strong> client 1 holds a lease with token 33 and freezes in a long GC pause. The lease expires; client 2 acquires it with token 34 and writes. Client 1 wakes, still believing it holds the lease, and writes with 33. Nobody else can stop that write: the lock service can't reach into client 1, and client 1 doesn't know it slept. Checking the lease right before writing doesn't help, because the pause can fall between the check and the write, and network delay can do the same to a write already sent. Only the resource can reject it, and with tokens it does: having seen 34, it refuses 33.</p>
<p><strong>Requirements:</strong></p>
<ul>
<li>Tokens come from a linearizable, consensus-backed source: ZooKeeper's zxid or a znode's cversion, an etcd revision, Chubby's sequencers. Kafka producer and controller epochs and Raft terms are the same idea.</li>
<li>The resource checks <strong>atomically with the write</strong>, e.g., <code>UPDATE ... WHERE id = :id AND fence &lt;= :token</code> or a compare-and-set on a version; a separate read, check and write reintroduces the race inside the storage.</li>
<li>For a read-modify-write, the new holder should present its token first (a conditional "claim" write), because a zombie write that arrives before the new holder's first token-bearing request is accepted, then superseded.</li>
</ul>
<p><strong>Limits:</strong> fencing protects against nodes acting in error, not malicious ones (a liar can forge a token: that is the Byzantine problem). And it works only for resources that check; emails and third-party payment calls can't be fenced, so they need idempotency.</p>`,
      followups: [
        "What if the storage doesn't support tokens?",
        "Is a longer lease a fix?",
        "How do Kafka epochs relate?",
      ],
      pitfalls: [
        "Checking the lease right before the write is enough",
        "The lock service alone can enforce mutual exclusion on the resource",
        "Rejecting equal tokens (the current holder could then write only once)",
      ],
    },
    {
      id: "q-redis-lock-correctness",
      q: "A teammate implements 'only one worker processes job X' with a Redis lock (SET lock:X &lt;worker-id&gt; NX PX 30000) and then writes the job's output to a database. What can go wrong, and how would you make it safe?",
      diff: "hard",
      section: "fencing-tokens",
      a: `<p><strong>What can go wrong:</strong></p>
<ul>
<li><strong>The holder outlives its lock.</strong> Worker A acquires <code>lock:X</code> and starts. A GC pause, VM migration or I/O stall freezes it for 35 s, or its database write sits in a network queue. The key expires at 30 s, worker B acquires it, and both write output. A has no way to notice.</li>
<li><strong>Failover loses the lock.</strong> Redis replication is asynchronous: if the primary acknowledges the <code>SET</code> and crashes before replicating it, the promoted replica has no key and a second worker gets the lock.</li>
<li><strong>Clock trouble on the Redis server.</strong> Expiry is time-based, so a server clock jump can expire keys early.</li>
</ul>
<p><strong>First ask what the lock is for.</strong> If it is an <strong>efficiency lock</strong> (a duplicate run only wastes work, such as re-rendering a thumbnail), the simple lease is fine. If it is a <strong>correctness lock</strong> (two writers corrupt data or double-charge), no lock on its own can ever be enough.</p>
<p><strong>Making it safe:</strong></p>
<ul>
<li><strong>Fencing tokens:</strong> obtain a monotonically increasing token with the lock from a consensus-backed source (ZooKeeper zxid or cversion, etcd revision, or a counter in a linearizable store), and make the database check it atomically: <code>UPDATE jobs SET output = :out, fence = :token WHERE id = :x AND fence &lt;= :token</code>. Using <code>&lt;=</code> lets the current holder write repeatedly.</li>
<li><strong>Or idempotent processing:</strong> deterministic output keyed by job ID, upserts, deduplication on a unique constraint, so a duplicate run is harmless and the lock becomes a mere optimization.</li>
</ul>
<p><strong>What doesn't fix it:</strong> a longer TTL or a background lock-extender thread shrinks the window but never closes it (the extender pauses too); checking that the lock value still equals my ID right before writing is a check-then-act race. Redlock (acquiring the lock on a majority of 5 independent Redis nodes) targets the single-primary failover problem, but not the pause problem: it issues no fencing tokens and relies on timing assumptions. That was the core of the 2016 exchange between Martin Kleppmann ("How to do distributed locking") and Salvatore Sanfilippo ("Is Redlock safe?"). Whatever you think of the timing bounds, fencing at the resource is what makes correctness independent of them.</p>`,
      followups: [
        "Your sink is an object store: how could you fence writes there?",
        "Does running Redlock across 5 Redis nodes solve the pause problem? The failover problem?",
        "How do Kafka producer epochs implement the same idea?",
      ],
      pitfalls: [
        "Proposing a longer TTL or a background 'lock extender' thread as the fix",
        "Checking that the lock value still equals my ID right before writing (still a check-then-act race)",
        "Assuming the lock service's guarantee automatically extends to the downstream database",
      ],
    },

    // --- byzantine-faults ---
    {
      id: "q05",
      q: "What is a Byzantine fault, and do most systems handle them?",
      diff: "medium",
      section: "byzantine-faults",
      a: `<p>A <strong>Byzantine fault</strong> is a node behaving arbitrarily: sending corrupted or contradictory messages to different peers, lying about its state, or acting maliciously, as opposed to merely crashing or running slowly. The name comes from Lamport, Shostak and Pease's Byzantine Generals Problem (1982), in which some generals are traitors.</p>
<p><strong>The cost of tolerating them:</strong> most BFT protocols need more than two-thirds of nodes to be honest, n ≥ 3f + 1 (4 nodes tolerate 1 liar), versus n ≥ 2f + 1 for crash faults. With unsigned messages, three generals can't tolerate a single traitor, because a loyal general can't tell which of the other two is lying. Message cost is higher too: classic PBFT uses O(n<sup>2</sup>) messages per decision, and newer protocols such as HotStuff bring that down to linear in the common case.</p>
<p><strong>Do most systems handle them? No</strong>, and for good reasons:</p>
<ul>
<li>Inside one organization's datacenter all nodes are trusted, and ground-level radiation rarely corrupts memory, so crash-recovery is the realistic model.</li>
<li>BFT doesn't protect against the failures you actually see. A bug present in every replica makes them all "lie" the same way (you'd need independently developed implementations, like the Space Shuttle's separate backup flight software), and an attacker who compromises one identical node can likely compromise them all. Authentication, access control, encryption and firewalls remain the main defense.</li>
<li>Untrusted web clients don't need BFT either: the server is the authority and validates every input.</li>
</ul>
<p><strong>Where BFT pays off:</strong> aerospace, where radiation can corrupt computation, and systems of mutually distrusting participants with no central authority. Bitcoin uses proof-of-work rather than PBFT; PBFT-style protocols appear in some permissioned and proof-of-stake systems (e.g., Tendermint, now CometBFT).</p>
<p><strong>Cheap defenses against "weak lying"</strong> are worth having everywhere: application-level checksums (a single corrupted bit in unchecksummed internal messages caused Amazon S3's 2008 outage), input validation, and outlier rejection (NTP clients querying several servers).</p>`,
      followups: [
        "Why do web apps not need BFT even though clients are untrusted?",
        "Where does BFT actually pay off?",
        "Why does tolerating f liars take 3f + 1 nodes rather than 2f + 1?",
      ],
      pitfalls: [
        "Claiming BFT protects against software bugs",
        "Saying 'blockchains use PBFT' as a blanket statement (Bitcoin uses proof-of-work; PBFT-style protocols appear in some permissioned and proof-of-stake systems)",
      ],
    },

    // --- system-models ---
    {
      id: "q08",
      q: "What's the difference between safety and liveness?",
      diff: "easy",
      section: "system-models",
      a: `<p><strong>Safety: nothing bad happens.</strong> If a safety property is violated, you can point to the moment it broke, and the damage can't be undone (two clients were granted the same lock token; a committed write was lost). <strong>Liveness: something good eventually happens.</strong> At any given moment it may not hold yet (a request is still awaiting its response), but it can always still be satisfied later. Properties that contain "eventually" are liveness properties: <strong>eventual consistency</strong> is one.</p>
<p><strong>Example, a fencing-token service:</strong> <em>uniqueness</em> (no two requests get the same token) and <em>monotonic sequence</em> (a request that completes before another begins gets a smaller token) are safety; <em>availability</em> (a node that requests a token and doesn't crash eventually gets one) is liveness.</p>
<p><strong>Why the split matters:</strong> distributed algorithms require safety <em>always</em>, in every situation the system model allows, even if all nodes crash or the network fails completely, while liveness is promised only under conditions such as a majority of nodes up and the network eventually behaving. The Raft paper says it outright: safety must not depend on timing; timing affects only availability. So during a partition Raft may stall, which is a liveness problem, never a safety one.</p>
<p><strong>FLP, stated precisely</strong> (<a href="#/ch9/concepts/flp-impossibility">Chapter 9</a>): in the asynchronous model, no deterministic consensus algorithm can guarantee termination if even one process may crash. It doesn't say consensus is impossible in practice: partial synchrony (timeouts) or randomization get around it, which is exactly why practical algorithms confine their timing assumptions to the liveness side.</p>`,
      followups: [
        "Is 'eventual consistency' safety or liveness?",
        "Why do algorithms require safety unconditionally but liveness only under conditions?",
      ],
      pitfalls: [
        "Calling an algorithm that stalls during a partition 'unsafe'",
        "Stating FLP as 'consensus is impossible'",
      ],
    },
    {
      id: "q-system-models",
      q: "What system model do Raft and Paxos assume, and why not a synchronous model or a fully asynchronous one?",
      diff: "medium",
      section: "system-models",
      a: `<p>A system model has two axes: what you assume about <strong>timing</strong> and what you assume about <strong>how nodes fail</strong>. Raft and Paxos assume <strong>partial synchrony</strong> with <strong>crash-recovery</strong> nodes that don't lie.</p>
<p><strong>Timing:</strong></p>
<ul>
<li><strong>Synchronous</strong> (known bounds on delay, pauses and clock error) would make life easy: a timeout of 2d + r would be a perfect failure detector. But queueing, GC pauses and VM migration make real delays unbounded, so an algorithm whose <em>correctness</em> rests on those bounds breaks the first time one is exceeded. A mutual-exclusion scheme that relies on lease timing alone is the classic example.</li>
<li><strong>Asynchronous</strong> (no timing assumptions, no clocks, no timeouts) is safe to assume but too weak: FLP shows that no deterministic consensus algorithm can guarantee termination in it if even one node may crash.</li>
<li><strong>Partially synchronous</strong>: the bounds usually hold but are sometimes exceeded for an arbitrary time. Raft and Paxos keep <strong>safety</strong> (one leader per term, committed entries never lost or changed) even when timing is completely violated, and use timeouts only for <strong>liveness</strong>: electing a leader once the network calms down. A bad network can stall them, but it can't make them diverge.</li>
</ul>
<p><strong>Faults:</strong></p>
<ul>
<li><strong>Crash-recovery</strong>, not crash-stop, because real nodes restart. That is why a Raft node writes its current term, its vote and its log entries to stable storage before answering an RPC: a node that forgot its vote after a restart could vote twice in one term and help elect two leaders.</li>
<li>The model's weak spot is that assumption: a disk that loses or corrupts acknowledged data (<strong>amnesia</strong>) silently breaks the quorum-overlap argument, so implementations add checksums and prefer to halt for an operator rather than continue with damaged state.</li>
<li><strong>Not Byzantine:</strong> nodes are assumed honest, which keeps the cost at 2f + 1 nodes instead of 3f + 1.</li>
</ul>
<p><strong>Using it in an interview:</strong> when you present a design, state the model in one line ("partial synchrony, crash-recovery, no Byzantine nodes; safety never depends on clocks, timeouts only affect availability") and then show where each mechanism relies on it. Point out any place that quietly assumes synchrony, such as leader-lease reads, which depend on bounded clock drift.</p>`,
      followups: [
        "What could go wrong if a Raft node replied to a vote request before persisting its vote?",
        "Where does Redlock sit in this taxonomy, and why did that matter in the 2016 debate?",
        "Name a widely used optimization that reintroduces a timing assumption into a consensus system.",
      ],
      pitfalls: [
        "Saying Raft 'works in the asynchronous model' without separating safety (yes) from liveness (no)",
        "Assuming crash-stop and forgetting that restarted nodes must remember their promises",
        "Treating a timeout as proof of death inside the safety argument",
      ],
    },
  ],
});
