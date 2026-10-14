// Chapter 9: Consistency and Consensus
// Authoring guide: docs/AUTHORING.md
DDIA.registerChapter({
  id: "ch9",
  part: 2,
  number: 9,
  title: "Consistency and Consensus",
  tagline: "Making many machines act like one: linearizability, ordering, and the consensus behind leaders, locks and atomic commit.",
  overview: `<p>Chapter 8 listed everything that goes wrong in a distributed system: lost and delayed messages, unreliable clocks, paused processes. This chapter asks which useful guarantees you can still build on top of that, and what each one costs. The strongest is <strong>linearizability</strong>: many replicas behave as if there were one copy, so once anyone has seen a write, nobody sees the older value again. Locks, leader election and uniqueness constraints depend on it.</p>
<p>The central tension is that one-copy behavior needs coordination. During a network partition, a replica that can't reach the others must refuse requests (the narrow truth inside CAP). Even on a healthy network, a linearizable operation can be no faster than the uncertainty of network delay. Most systems therefore settle for something weaker, and the guarantee most applications actually rely on turns out to be <strong>causality</strong>: effects never appear before their causes. Causality can be preserved without giving up availability.</p>
<p>The ideas build on each other. Lamport timestamps order events consistently with causality, but they can't tell you when that order is final. <strong>Total order broadcast</strong> (one log, delivered identically everywhere) fixes that, and it is equivalent to <strong>consensus</strong>. Two-phase commit agrees on a transaction's outcome but blocks when its coordinator dies; Paxos, Raft and Zab avoid that with numbered epochs and overlapping majorities. ZooKeeper and etcd package consensus so the rest of a system can elect leaders, take locks and track membership without implementing it.</p>`,

  concepts: [
    // ---- linearizability ----
    {
      id: "eventual-consistency",
      term: "Eventual consistency (convergence)",
      def: "If writes stop, all replicas eventually return the same value. Nothing bounds <em>when</em> that happens, and nothing constrains what a read returns in the meantime: it may return a value older than one you, or someone else, already saw. A more honest name is <strong>convergence</strong>.",
      problem: "Asynchronous replication makes replicas disagree temporarily. Eventual consistency names the weakest useful promise, and its vagueness is exactly why stronger, precisely defined models were needed.",
      why: "It is what asynchronous replication gives you for free, and the root of the replication-lag bugs in ch5. Because it promises so little, application code must cope with stale, out-of-order and flip-flopping reads. Stronger models move that burden into the database, at the cost of coordination.",
      ex: "Amazon S3 was only eventually consistent for overwrites, deletes and listings until December 2020; tools such as Hadoop's S3Guard and EMRFS consistent view existed to paper over it. Cassandra at consistency level ONE and DynamoDB's default reads are eventually consistent today.",
      section: "linearizability",
    },
    {
      id: "linearizability",
      term: "Linearizability",
      def: "The system behaves as if there were a single copy of the data, and every operation takes effect atomically at one instant (its linearization point) somewhere between its request and its response. It is a <strong>recency guarantee</strong>: once any read has returned a new value, no read that starts later may return an older one, whichever replica it reaches. Also called atomic, strong or immediate consistency. It concerns single objects (registers), not multi-object transactions.",
      problem: "Replicated data can answer differently depending on which replica you ask. Code written as if there were one copy breaks: two clients both think they hold a lock, or a seat that has already sold out is sold again.",
      why: "It makes a replicated system as easy to reason about as one variable, and it is what locks, leader election and uniqueness constraints need. The price is coordination on every operation: the cut-off side of a partition becomes unavailable, and latency grows with the uncertainty of network delays.",
      ex: "A single-node database without replication is linearizable. A single-leader database is linearizable only if reads go to a leader that has confirmed it is still leader (a lease, or ReadIndex: a heartbeat round to a majority), as etcd does for its default reads. Jepsen tests products by recording real operation histories and checking them with a linearizability checker (Knossos).",
      section: "linearizability",
    },
    {
      id: "serializability-vs-linearizability",
      term: "Serializability vs linearizability",
      def: "<strong>Serializability</strong> is an isolation property of multi-object transactions: the outcome equals <em>some</em> serial order, which is not necessarily consistent with real time. <strong>Linearizability</strong> is a recency guarantee on individual objects: operations take effect in an order that respects real time, but it knows nothing about transactions. A system that provides both is <strong>strictly serializable</strong> (also called strong one-copy serializability).",
      problem: "The two are often confused, yet a serializable database can return stale reads, and a linearizable store can't run multi-object transactions.",
      why: "Two-phase locking and actual serial execution are typically linearizable as well as serializable. Serializable snapshot isolation (SSI) is serializable but deliberately not linearizable, because a transaction reads from a snapshot that excludes writes committed after it began. Plain snapshot isolation is not even serializable (write skew, ch7).",
      ex: "Spanner's 'external consistency' is strict serializability, built on TrueTime and commit wait (ch8); FoundationDB also documents strict serializability. PostgreSQL's SERIALIZABLE level is SSI: serializable, but a long transaction keeps reading the snapshot taken when it started.",
      section: "linearizability",
    },

    // ---- linearizability-in-practice ----
    {
      id: "cross-channel-timing-dependencies",
      term: "Cross-channel timing dependencies",
      def: "When parts of a system communicate through more than one channel (for example replicated file storage and a message queue), a message on the fast channel can arrive before data written through the slow channel is visible, so the receiver acts on stale or missing data.",
      problem: "Without linearizable storage, 'I wrote it, then told you about it' does not imply 'you can read it', which produces permanent inconsistencies such as a thumbnail made from the wrong version of an image.",
      why: "The race exists only because there is a second channel. Linearizable storage closes it: if the write completed before the message was sent, any later read sees it. The alternative is to send the data, or a version identifier the reader waits for, through the fast channel, much like the read-your-writes techniques in ch5. That works but adds complexity.",
      ex: "A web server stores an uploaded photo, then enqueues 'resize photo 42'. The resizer, triggered quickly by the queue, reads from a storage replica that hasn't received the new photo yet and either fails or resizes the old version, leaving the full-size image and thumbnail permanently out of sync.",
      section: "linearizability-in-practice",
    },
    {
      id: "linearizable-replication-methods",
      term: "Which replication methods can be linearizable",
      def: "<strong>Single-leader</strong>: potentially, if reads go to a leader that is certainly still the leader, or to synchronously updated followers. <strong>Consensus algorithms</strong>: yes, by design. <strong>Multi-leader</strong>: no. <strong>Leaderless</strong> (Dynamo-style): probably not, because of last-write-wins clocks, sloppy quorums and quorum races. Synchronous read repair plus writers that read first (the ABD algorithm) fixes reads and writes, but never compare-and-set.",
      problem: "Systems advertise 'strong consistency' loosely; knowing which mechanisms can actually provide linearizability keeps you from relying on a guarantee that isn't there.",
      why: "Linearizability is a property of the whole path a read takes, not of a product name. The weak points recur: a node that thinks it is leader but isn't, asynchronous followers and failover that loses acknowledged writes, clock-based conflict resolution, and quorum members that receive a write at different times.",
      ex: "etcd and Spanner use consensus. Cassandra's QUORUM reads and writes resolve conflicts with last-write-wins timestamps and are not linearizable; its lightweight transactions (INSERT ... IF NOT EXISTS) run Paxos to get compare-and-set. MySQL or PostgreSQL with asynchronous replicas can lose acknowledged writes on failover. Active-active multi-leader setups are never linearizable.",
      section: "linearizability-in-practice",
    },

    // ---- cost-of-linearizability ----
    {
      id: "cap-theorem",
      term: "CAP theorem",
      def: "If some replicas can't communicate with the others (a network <strong>partition</strong>, P), a system can't be both <strong>consistent</strong> (C = linearizable) and <strong>available</strong> (A = every request received by a non-failing node eventually gets a non-error response). Conjectured by Eric Brewer (2000), proved by Gilbert and Lynch (2002). It covers one consistency model and one kind of fault: not crashed nodes, not slow networks, not latency.",
      problem: "Designers moving beyond single-node databases needed to understand what a network partition forces them to give up.",
      why: "The useful content is narrow: when the network splits, a replica that can't reach the others must either refuse (keep C) or answer from possibly stale data (keep A). 'Pick 2 of 3' misleads, because partitions aren't optional and no distributed system can opt out of them to be 'CA'. Most real systems meet neither CAP definition and choose per operation, so CAP is now mostly of historical interest; PACELC adds the everyday latency cost.",
      ex: "Brewer's 2017 note on Spanner calls it technically CP but 'effectively CA', because Google's private network makes partitions rare; when one happens, Spanner chooses consistency. Cassandra lets each query pick ONE, QUORUM or ALL, so one cluster behaves differently per request. etcd refuses writes and linearizable reads on the minority side of a partition.",
      section: "cost-of-linearizability",
    },
    {
      id: "linearizable-systems-their-cost",
      term: "Linearizable systems and their cost",
      def: "Linearizability costs availability during partitions and latency always. If replicas are disconnected, the side that can't reach the leader or a majority must wait or return errors for writes <em>and</em> for linearizable reads, since it can't know whether it missed a write. Even with no faults, Attiya and Welch proved that the response time of linearizable reads and writes is at least proportional to the <strong>uncertainty of network delays</strong>.",
      problem: "Linearizability looks free in a single datacenter, but it costs availability during partitions and latency all the time.",
      why: "Performance, more than fault tolerance, is why most systems drop linearizability. Even RAM on a multi-core CPU isn't linearizable: cores read from caches and store buffers unless memory barriers force otherwise. Weaker models can answer locally and are much faster, so latency-sensitive systems choose them and offer linearizability per operation.",
      ex: "A linearizable write from Frankfurt to a leader in Virginia pays the transatlantic round trip on every request, partition or not. DynamoDB's ConsistentRead flag, Cassandra consistency levels, MongoDB read and write concerns and Cosmos DB's five consistency levels expose the trade-off per request.",
      section: "cost-of-linearizability",
    },

    // ---- causality ----
    {
      id: "consistent-prefix-causal-consistency",
      term: "Causal consistency and consistent prefix",
      def: "<strong>Causal consistency</strong>: operations that are causally related (one could have influenced the other) are seen in the same order by every node, while concurrent operations may be seen in different orders. It is a <strong>partial order</strong>, unlike linearizability's single timeline. <strong>Consistent prefix reads</strong> (ch5) are one instance: you never see an answer without the question it replies to. Causal consistency is the strongest model known that can stay available during network partitions (shown for real-time causal consistency by Mahajan, Alvisi and Dahlin, 2011).",
      problem: "Effects appearing before causes (answers before questions, an update before the row it updates) confuse users and break application logic, yet a full real-time order is too expensive.",
      why: "Many applications that seem to need linearizability only need causality, which never has to wait for a remote node. Linearizability implies causal consistency, but not the reverse. Its limits: it can't enforce uniqueness (two concurrent claims are both allowed), tracking dependencies costs metadata, and it remains rarer in production than eventual or linearizable designs.",
      ex: "MongoDB 3.6 introduced causally consistent sessions, which pass a cluster time between client and servers so a session sees its own writes even on secondaries. COPS (SOSP 2011) makes a write visible in a datacenter only after its dependencies are visible there. Snapshot isolation (ch7) gives causally consistent reads: a snapshot that contains an answer also contains its question.",
      section: "causality",
    },
    {
      id: "sequential-consistency",
      term: "Sequential consistency",
      def: "All clients observe operations in one total order that respects each client's own order of operations, but that order need not match real time: a read may return a value that has since been overwritten, as long as everyone sees the same sequence. Weaker than linearizability, stronger than causal consistency.",
      problem: "Linearizability's real-time requirement forces coordination on every read. Letting replicas lag while still agreeing on one order (for example, by applying the same log) is much cheaper, but you need a name for exactly what you gave up.",
      why: "It describes replicas that apply one shared log in order but may lag behind it: everyone agrees on history, but a lagging reader may be looking at the past. Because it ignores real time, it breaks cross-channel scenarios ('I told you I wrote it, but your replica hasn't applied it'). It still needs an agreed total order, so it can't stay available on both sides of a partition.",
      ex: "ZooKeeper: writes are linearizable, but a read is answered by whichever server the client is connected to and may lag the leader, so reads are sequentially consistent unless the client calls sync() first. History that is sequential but not linearizable: A's write x=1 completes, then B reads x=0 from a lagging follower.",
      section: "causality",
    },
    {
      id: "vector-clocks-vs-version-vectors",
      term: "Vector clocks vs version vectors",
      def: "<strong>Vector clock</strong>: one counter per process, attached to events and messages, so any two events can be compared: one happened before the other, or they are concurrent. <strong>Version vector</strong>: one counter per <em>replica</em> (not per client), attached to versions of a single data item to detect concurrent writes (siblings), and merged entrywise. Both compare the same way (a &le; b on every entry), but they track different things and merge differently. Neither gives a total order.",
      problem: "Lamport timestamps can't tell concurrent events from ordered ones; detecting concurrency needs one counter per participant.",
      why: "Detecting concurrency is what lets a leaderless or multi-leader store keep both conflicting writes instead of silently dropping one, as last-write-wins does. The cost is size, one entry per participant. Even per-replica version vectors can pile up spurious siblings when many clients write one key concurrently ('sibling explosion'), which is why Riak 2.0 introduced <strong>dotted version vectors</strong>.",
      ex: "The Dynamo paper (2007) used vector clocks to detect divergent shopping-cart versions and handed the siblings to the application to merge; the merge could resurrect deleted items. Riak 2.0 and later use dotted version vectors. Git's commit graph is a familiar picture of the same partial order: branches are concurrent, merges join them.",
      section: "causality",
    },

    // ---- lamport-timestamps ----
    {
      id: "sequence-number-ordering",
      term: "Sequence number ordering",
      def: "Ordering events with compact counters or timestamps instead of tracking every dependency. A single leader's log position is consistent with causality. Per-node counters, wall-clock timestamps and preallocated ID blocks are unique but <strong>not</strong> consistent with causality.",
      problem: "Tracking every causal dependency explicitly is too expensive, so systems need cheap numbers that still respect cause and effect, and need to know which generators don't.",
      why: "A single leader gives the ideal numbering but caps throughput and must fail over. The cheap alternatives are fine as identifiers but dangerous as an order: per-node counters (odd/even) advance at different rates, wall clocks drift (ch8), and preallocated blocks (node A gets 1-1000, node B 1001-2000) can number a later operation lower than an earlier one.",
      ex: "Causal: a Kafka offset within one partition, the PostgreSQL WAL position, etcd's revision, ZooKeeper's zxid. Not causal: Twitter's Snowflake IDs (timestamp, worker ID, sequence), MySQL's auto_increment_increment/auto_increment_offset odd/even scheme for multi-primary setups.",
      section: "lamport-timestamps",
    },
    {
      id: "lamport-timestamps",
      term: "Lamport timestamps",
      def: "A logical clock. Each node keeps a counter and stamps each event with the pair <strong>(counter, node ID)</strong>; compare counters first and break ties by node ID, which makes it a total order. Every node <em>and every client</em> remembers the largest counter it has seen and includes it on each request; a node that receives a larger counter jumps its own up to that value. Guarantee: if a happened before b, then L(a) &lt; L(b). The converse is false: L(a) &lt; L(b) also holds for many concurrent events.",
      problem: "We need an order consistent with causality without trusting physical clocks or tracking every dependency.",
      why: "One integer per message buys a total order that respects causality. Two blind spots: it can't detect concurrency (vector clocks can), and the order is only final once you've heard from every node, so a node can't decide 'is this username free?' on the spot. Total order broadcast supplies that missing piece.",
      ex: "Introduced in Lamport's 1978 paper, part of the work recognized by his 2013 Turing Award. Hybrid logical clocks (Kulkarni et al., 2014) combine a physical timestamp with a Lamport-style counter, staying close to wall time while respecting causality; CockroachDB and YugabyteDB use them, and MongoDB's cluster time is a hybrid logical clock.",
      section: "lamport-timestamps",
    },

    // ---- total-order-broadcast ----
    {
      id: "total-order-broadcast",
      term: "Total order broadcast (atomic broadcast)",
      def: "A protocol for delivering messages to all nodes with two safety properties: <strong>reliable delivery</strong> (if one node delivers a message, all do) and <strong>totally ordered delivery</strong> (every node delivers messages in the same order). The order is fixed at delivery: no node ever inserts a message before one it already delivered, and delivery is gapless. It is asynchronous, with no promise about <em>when</em> a message is delivered. It is equivalent to consensus and to a linearizable compare-and-set or increment-and-get register.",
      problem: "Replicas that receive the same writes in different orders diverge, and Lamport ordering can't say when the order is final.",
      why: "It turns replication into a shared log that every replica applies in the same order. Writes become linearizable (append a claim, wait for it to come back, the first claim wins) and log positions make natural fencing tokens. Reads still lag unless they are sequenced through the log or preceded by ReadIndex or sync(), because delivery to each replica is asynchronous.",
      ex: "ZooKeeper broadcasts every write with Zab and stamps it with a zxid; etcd gives every write a cluster-wide revision through Raft. A Kafka partition is a totally ordered log (per partition only), and Kafka's KRaft controllers keep cluster metadata in a Raft log.",
      section: "total-order-broadcast",
    },
    {
      id: "state-machine-replication",
      term: "State machine replication",
      def: "Replicas start in the same state and apply the same deterministic commands in the same order, delivered by total order broadcast (a replicated log), so they remain identical.",
      problem: "Replicas that receive the same writes in different orders diverge; fixing the delivery order once, for everyone, is the general cure.",
      why: "It separates agreeing on the order (consensus) from executing (local, deterministic code), so any deterministic service can be made fault tolerant. Determinism is the catch: random numbers, the current time and iteration over unordered maps must be resolved before a command enters the log, the same pitfall as statement-based replication (ch5).",
      ex: "etcd, Consul and TiKV are state machines over Raft logs; Chubby replicated its database with Paxos. VoltDB and Calvin execute deterministic transactions in an agreed order, so every replica reaches the same result without coordinating at commit time. Lamport's 1978 paper already sketched the idea.",
      section: "total-order-broadcast",
    },

    // ---- two-phase-commit ----
    {
      id: "two-phase-commit",
      term: "Two-phase commit (2PC)",
      def: "An atomic commit protocol across several nodes. The application gets a global transaction ID and does its work on each participant. <strong>Phase 1</strong>: the coordinator sends prepare; each participant writes the transaction durably, checks constraints and votes YES or NO. A YES vote gives up the right to abort. <strong>Phase 2</strong>: the coordinator decides commit only if every vote was YES, writes that decision to its own log (the <strong>commit point</strong>), then sends it to everyone, retrying until each participant acknowledges.",
      problem: "Committing independently on several nodes can leave some committed and others aborted: one hits a constraint violation, one never gets the commit message, one crashes before writing its commit record.",
      why: "Two irrevocable promises make it work: the participant's YES and the coordinator's durable decision. The cost is extra forced disk writes and round trips, locks held across the network, and blocking if the coordinator fails while participants are in doubt. 2PC is not 2PL: two-phase locking is about isolation (ch7).",
      ex: "PostgreSQL exposes the participant side as PREPARE TRANSACTION, COMMIT PREPARED and ROLLBACK PREPARED (off by default). XA/JTA coordinates heterogeneous resources. Spanner runs 2PC across shards where each participant is a Paxos group; Percolator and TiDB use a 2PC variant built around a primary lock.",
      section: "two-phase-commit",
    },
    {
      id: "coordinator-failure-in-2pc",
      term: "Coordinator failure in 2PC",
      def: "After voting YES a participant is <strong>in doubt</strong>: it may not abort on a timeout (others may already have committed), and it may not commit on its own (someone else may have voted NO). If the coordinator crashes before delivering the decision, prepared participants wait, holding their locks, until it recovers and reads its log; transactions with no commit record are then aborted (presumed abort). Before voting, a participant may still abort unilaterally.",
      problem: "Participants that voted YES can't decide on their own, so a coordinator crash leaves them holding locks.",
      why: "This blocking is 2PC's defining weakness: progress depends on one node coming back. Three-phase commit removes it only if network delays are bounded (a perfect failure detector), which real networks don't offer. Modern systems keep 2PC but replicate the coordinator and every participant with consensus (Spanner), so no single machine's crash leaves anyone in doubt.",
      ex: "An application server running an embedded XA transaction manager crashes after the databases have prepared. Their rows stay locked until that server's log is recovered, blocking unrelated requests that touch the same rows. In PostgreSQL such transactions appear in pg_prepared_xacts and keep their locks across database restarts.",
      section: "two-phase-commit",
    },
    {
      id: "three-phase-commit",
      term: "Three-phase commit (3PC)",
      def: "An atomic commit protocol that adds a phase to avoid blocking when the coordinator fails, but is only correct if network delays and response times are bounded, that is, if crashed nodes can be told apart from slow ones (a perfect failure detector).",
      problem: "2PC blocks participants when its coordinator fails; 3PC was the attempt to remove that, but its timing assumptions don't hold in real networks, so 2PC remains in use.",
      why: "It shows why nonblocking atomic commit is hard: a participant can safely decide without the coordinator only if it can tell a crashed node from a slow one. With unbounded delays and process pauses (ch8), 3PC can reach inconsistent decisions. The practical fix for blocking is to replicate the coordinator with consensus, not to add a phase.",
      ex: "3PC is rarely used in production. Spanner runs 2PC over Paxos groups, and CockroachDB and TiDB use 2PC-style commits over consensus-replicated shards.",
      section: "two-phase-commit",
    },

    // ---- distributed-transactions-in-practice ----
    {
      id: "xa-transactions",
      term: "XA transactions",
      def: "The X/Open XA standard (1991) for two-phase commit across heterogeneous systems, such as different databases and message brokers. It defines a C-level programming interface between the application, the transaction coordinator and each resource, not a wire protocol; Java exposes it as JTA. The coordinator usually runs as a library inside the application process and logs to that machine's disk.",
      problem: "Applications needed atomic commit across systems from different vendors, for example acknowledging a message and writing to a database exactly once.",
      why: "XA makes heterogeneous atomic commit possible but inherits every 2PC weakness and adds its own. The coordinator's log lives on the application server, which is no longer stateless, and is often not replicated. XA can't detect deadlocks or provide SSI across systems, and since every participant must respond, it amplifies failures. The book cites a report that distributed transactions in MySQL were over 10 times slower than single-node ones.",
      ex: "Supported by PostgreSQL, MySQL, Oracle, SQL Server and DB2, and by brokers such as ActiveMQ and IBM MQ. Java application servers embed the transaction manager (for example Narayana in WildFly). In microservices, sagas with a transactional outbox usually replace XA.",
      section: "distributed-transactions-in-practice",
    },
    {
      id: "heuristic-decisions",
      term: "Heuristic decisions",
      def: "An emergency option that lets a 2PC participant commit or abort an in-doubt transaction on its own, without the coordinator. It may contradict the coordinator's decision, so it can break atomicity.",
      problem: "When a coordinator's log is lost, in-doubt transactions hold their locks forever; operators need some way out, at the price of possibly inconsistent outcomes.",
      why: "It is the escape hatch for orphaned in-doubt transactions, which a database restart can't clear: a correct participant must keep prepared transactions, and their locks, across crashes. 'Heuristic' really means 'may break atomicity'. One participant may commit while another aborts, leaving humans to reconcile the data. Reserve it for catastrophes.",
      ex: "JTA reports such outcomes as HeuristicMixedException or HeuristicRollbackException. In PostgreSQL an operator resolves an orphaned prepared transaction by hand with COMMIT PREPARED or ROLLBACK PREPARED, ideally after checking what the other participants did.",
      section: "distributed-transactions-in-practice",
    },

    // ---- consensus ----
    {
      id: "consensus",
      term: "Consensus",
      def: "Getting several nodes to decide on one value, with four properties: <strong>uniform agreement</strong> (no two nodes decide differently), <strong>integrity</strong> (no node decides twice), <strong>validity</strong> (the decided value was proposed by some node) and <strong>termination</strong> (every node that doesn't crash eventually decides). The first three are safety properties; termination is liveness and needs a majority of nodes alive and connected. The usual algorithms assume crash faults, not Byzantine ones.",
      problem: "Automatic failover and leader election need nodes to agree despite crashes; a fixed coordinator, as in 2PC, blocks when it fails.",
      why: "Termination rules out a dictator: 2PC satisfies the other three properties but stops when its coordinator dies. Fault-tolerant consensus keeps deciding while a majority can communicate (2f + 1 nodes tolerate f crashes), and never decides wrongly even when more fail. Leader election, locks, uniqueness, atomic commit and total order broadcast all reduce to it.",
      ex: "Automatic failover without split brain needs it: etcd and Consul use Raft, ZooKeeper uses Zab, Chubby and Spanner use Paxos, and DynamoDB elects each partition's leader with Multi-Paxos. GitHub's October 2018 outage shows the boundary: its Raft-based Orchestrator correctly agreed to promote West Coast replicas after a 43-second partition, but asynchronous database replication left both coasts with writes the other lacked, and service was degraded for 24 hours 11 minutes.",
      section: "consensus",
    },
    {
      id: "flp-impossibility",
      term: "FLP impossibility",
      def: "Fischer, Lynch and Paterson (1985): in the asynchronous model (no bound on message delay, no clocks or timeouts), no deterministic algorithm can guarantee that consensus terminates if even one node may crash. Safety is never at stake; termination is.",
      problem: "It explains why every practical algorithm depends on timeouts (or randomness) for progress.",
      why: "Real algorithms escape it by assuming partial synchrony (timeouts used to suspect failures; the network behaves well for long enough, eventually) or by randomization (Ben-Or, 1983, terminates with probability 1). Raft's randomized election timeouts only make split votes unlikely; what lets Raft make progress is relying on timeouts at all. Consensus algorithms are always safe and live whenever the network cooperates.",
      ex: "Duelling Paxos proposers that keep pre-empting each other with higher ballots, or Raft elections that keep splitting, are FLP made concrete. A distinguished proposer, randomized backoff and Raft's PreVote make such livelock rare, never impossible.",
      section: "consensus",
    },
    {
      id: "consensus-equivalence",
      term: "Problems equivalent to consensus",
      def: "Linearizable compare-and-set registers, atomic transaction commit, total order broadcast, locks and leases, membership/coordination services and uniqueness constraints all reduce to consensus and to each other. Plain linearizable read/write registers do <em>not</em>: majority quorums can build them (ABD) without consensus.",
      problem: "Recognizing that many apparently different coordination problems are the same problem tells you when you need a consensus system, and when you can't avoid one.",
      why: "If a design needs any one of these (a unique username, a lock, a single leader, an agreed log, a commit that survives its coordinator), it needs consensus somewhere, and inherits the costs: a majority must be reachable, and every decision costs a quorum round trip.",
      ex: "Cassandra adds Paxos only for compare-and-set (lightweight transactions); its plain QUORUM reads and writes don't use it. Kafka's KRaft log is total order broadcast used for controller election and metadata. Spanner runs atomic commit over Paxos groups.",
      section: "consensus",
    },
    {
      id: "raft-paxos-zab",
      term: "Raft / Paxos / Zab (and Viewstamped Replication)",
      def: "The main fault-tolerant consensus algorithms. <strong>Viewstamped Replication</strong> (Oki and Liskov, 1988). <strong>Paxos</strong> (Lamport; written around 1989-90, published 1998): basic Paxos decides a single value, so practical systems run <strong>Multi-Paxos</strong> with a stable leader. <strong>Zab</strong>, ZooKeeper's atomic broadcast (late 2000s, predating Raft). <strong>Raft</strong> (Ongaro and Ousterhout, 2014), designed for understandability. All of them decide a sequence of values, which means they implement total order broadcast.",
      problem: "Consensus is subtle to implement; these are the proven algorithms.",
      why: "They share one structure: a leader per numbered epoch, and every decision accepted by a majority, so any two quorums overlap and a new leader learns what was decided. Raft's distinctive choices are a strong leader, randomized election timeouts, an election restriction (vote only for a candidate whose log is at least as up to date as yours) and a log without holes. None is inherently faster: with a stable leader, each costs one round trip to a majority per entry.",
      ex: "Raft: etcd, Consul, CockroachDB and TiKV (one Raft group per data range), YugabyteDB, Redpanda and Kafka's KRaft; MongoDB's replication protocol is Raft-like. Paxos: Chubby, Spanner, and DynamoDB (Multi-Paxos per partition). Zab: ZooKeeper.",
      section: "consensus",
    },
    {
      id: "epoch-numbering",
      term: "Epoch numbering (ballot / view / term)",
      def: "A monotonically increasing number identifying each leadership period: ballot (Paxos), view (Viewstamped Replication), term (Raft), epoch (Zab). There is at most one leader per epoch, and a higher epoch overrides a lower one. A leader's proposal counts only if a quorum that knows of no higher epoch accepts it.",
      problem: "Without a way to rank leaders, a paused or partitioned old leader and a newly elected one could both make decisions (split brain).",
      why: "Two rounds of majority voting do the work: one elects a leader for the epoch, the next accepts each proposal. Because the two quorums overlap, a proposal accepted by a majority proves no newer leader has taken over yet. The epoch also makes a natural fencing token (ch8) for downstream storage.",
      ex: "Raft persists the current term and its vote to disk before answering. A Raft leader paused by GC wakes up, sends AppendEntries with its old term, sees a higher term in the reply and steps down. ZooKeeper puts the epoch in the high 32 bits of every zxid.",
      section: "consensus",
    },
    {
      id: "leader-election",
      term: "Leader election",
      def: "Choosing exactly one leader per epoch, safely, even when the old leader is only slow or partitioned. Done with consensus: a node that suspects the leader has failed starts a new epoch and needs votes from a majority, and each node votes at most once per epoch. When a leader fails there are three options: wait for it to recover (what an XA coordinator forces), let a human fail over, or elect automatically through consensus.",
      problem: "Single-leader systems need exactly one leader at a time, even when the old one is merely slow or partitioned (split brain).",
      why: "Without a majority vote, timeout-triggered failover can produce two leaders and divergent data. Even with consensus, the old leader may not know it was replaced, so anything it writes to external systems must carry its term or epoch as a fencing token that the storage checks (ch8).",
      ex: "Raft fails over in roughly an election timeout plus a round trip. Kubernetes controllers elect one active instance with Lease objects in etcd, and client-go warns that this doesn't fence. HDFS NameNode HA uses a ZooKeeper ephemeral lock znode plus fencing. Kafka's KRaft controllers elect the active controller with Raft.",
      section: "consensus",
    },

    // ---- coordination-services ----
    {
      id: "membership-coordination-services",
      term: "Membership and coordination services",
      def: "Small consensus-replicated stores (usually 3 or 5 voting nodes, each holding a full copy of a deliberately small data set) that give many clients four primitives: <strong>linearizable compare-and-set</strong>; <strong>totally ordered operations</strong> (zxid, revision) usable as fencing tokens; <strong>failure detection</strong> through sessions with heartbeats and ephemeral nodes; and <strong>change notifications</strong> (watches). Leader election, locks, membership, partition assignment and configuration are built on top.",
      problem: "Every distributed system needs leader election, locks, membership and configuration, and re-implementing consensus in each is error-prone.",
      why: "They let a system outsource consensus, ordering and failure detection to a proven service. Keep only slow-changing data in them (who leads partition 7, not per-request state). Caveats: ZooKeeper reads aren't linearizable without sync(), though etcd's are by default; locks are leases that still need fencing; and session timeouts trade fast failover against false positives from GC pauses.",
      ex: "Kubernetes keeps all cluster state in etcd and drives its controllers from watches. HBase and HDFS NameNode HA use ZooKeeper; ClickHouse Keeper is a Raft-based, ZooKeeper-compatible replacement; Consul adds service discovery and DNS. Kafka used ZooKeeper until KRaft replaced it (production-ready in 3.3, 2022; ZooKeeper removed in 4.0, 2025).",
      section: "coordination-services",
    },
  ],

  cheatsheet: [
    {
      title: "Consistency models (strongest to weakest)",
      type: "table",
      headers: ["Model", "Guarantee", "Cost", `<span style="overflow-wrap:normal;word-break:normal">Available during a partition?</span>`, "Example"],
      rows: [
        [`<span style="overflow-wrap:normal;word-break:normal">Strict serializability</span>`, "Serializable transactions whose order respects real time", "Consensus plus real-time ordering per transaction (Spanner: commit wait)", "No", "Spanner (external consistency), FoundationDB"],
        [`<span style="overflow-wrap:normal;word-break:normal">Linearizability</span>`, "Each object behaves like one copy; once a read sees a write, every later read does", "Coordination on every operation; latency at least proportional to delay uncertainty", "No", "etcd, ZooKeeper writes, Raft/Paxos stores, Cassandra LWT"],
        [`<span style="overflow-wrap:normal;word-break:normal">Sequential consistency</span>`, "One total order seen by everyone, respecting each client's own order; may lag real time", "An agreed order (a log), but reads can be served locally", "No", "ZooKeeper reads without sync()"],
        [`<span style="overflow-wrap:normal;word-break:normal">Causal consistency</span>`, "Causally related operations in the same order everywhere; concurrent ones in any order", "Dependency metadata; never waits for remote nodes", "Yes", "MongoDB causal sessions, COPS"],
        [`<span style="overflow-wrap:normal;word-break:normal">Eventual consistency</span>`, "Replicas converge if writes stop; no promise before then", "Cheapest", "Yes", "Dynamo-style stores at low consistency levels (Cassandra ONE); DynamoDB's default reads; DNS"],
      ],
      note: "Strict serializability is about multi-object transactions, so this ladder mixes axes; for single-object operations it coincides with linearizability. CockroachDB documents serializable isolation with linearizable single-key operations, not strict serializability across keys, so it doesn't belong in the top row. 'Available' here means CAP availability: every non-failing node keeps answering.",
    },
    {
      title: "Linearizability vs serializability in one line",
      type: "note",
      body: "<p><strong>Serializability</strong> = transactions behave as if run in <em>some</em> serial order. <strong>Linearizability</strong> = single objects behave like one copy in <em>real-time</em> order. Both = <strong>strict serializability</strong>. 2PL and actual serial execution are typically both; SSI is serializable but not linearizable; plain snapshot isolation is neither serializable nor linearizable.</p>",
    },
    {
      title: "Which replication methods can be linearizable?",
      type: "table",
      headers: ["Replication", `<span style="overflow-wrap:normal;word-break:normal">Linearizable?</span>`, "Why"],
      rows: [
        ["Single-leader", `<span style="overflow-wrap:normal;word-break:normal">Potentially</span>`, "Reads must go to a confirmed leader (lease or ReadIndex) or to synchronously updated followers; a deposed leader that keeps serving breaks it, and async failover can lose acknowledged writes"],
        ["Consensus (Raft, Paxos, Zab)", "Yes", "Designed for it: majority commits, epochs against split brain. Reads still need ReadIndex, a lease or sync() (ZooKeeper reads are not linearizable by default)"],
        ["Multi-leader", "No", "Concurrent writes on several nodes, asynchronous replication, conflict resolution after the fact"],
        ["Leaderless (Dynamo-style)", `<span style="overflow-wrap:normal;word-break:normal">Probably not</span>`, "LWW on wall clocks, sloppy quorums, and the quorum race (a later reader can see an older value). ABD (synchronous read repair to a quorum + read-before-write) fixes read/write, never CAS"],
      ],
    },
    {
      title: "Making reads linearizable",
      type: "list",
      items: [
        "<strong>Read through the log</strong>: append the read as an entry and answer when it is applied. Simple, but costs a log write per read.",
        "<strong>ReadIndex</strong>: the leader notes its commit index, confirms leadership with a heartbeat round to a majority, waits until it has applied that index, then reads locally (etcd default). ZooKeeper's analogue is sync() then read.",
        "<strong>Leader lease reads</strong>: skip the heartbeat round while a lease shorter than the election timeout holds. Fast, but <em>depends on bounded clock drift and pauses</em>.",
        "<strong>Follower reads</strong>: a follower gets the current read index from the leader, waits to apply it, and answers locally (TiKV).",
        "<strong>Chain replication</strong>: read from the tail, which only has fully replicated writes (CRAQ spreads reads across the chain).",
      ],
    },
    {
      title: "CAP theorem revisited",
      type: "list",
      items: [
        "<strong>C</strong> = linearizability; <strong>A</strong> = every request to a non-failing node gets a non-error response; <strong>P</strong> = a network partition, and nothing else.",
        "Partitions aren't optional, so 'pick 2 of 3' misleads and no distributed system is 'CA'. While the network works you can have both C and A.",
        "Choose per operation, not per product: <strong>linearizable operations</strong> (etcd reads/writes, ZooKeeper writes, Spanner, Cassandra LWT, DynamoDB strongly consistent reads) become unavailable on the cut-off side; <strong>local/eventual operations</strong> (Cassandra ONE, DynamoDB default reads, ZooKeeper reads without sync()) stay up but may be stale. Cassandra QUORUM is neither: not linearizable, yet it fails on a side that can't reach a quorum.",
        "Reads are operations too: the cut-off side can't serve linearizable reads either.",
        "<strong>PACELC</strong>: if Partitioned, Availability or Consistency; Else, Latency or Consistency. The 'else' half is the cost you pay daily.",
        "Attiya and Welch: linearizable reads/writes take time at least proportional to the uncertainty of network delay, partition or not.",
      ],
    },
    {
      title: "Ordering mechanisms",
      type: "list",
      items: [
        "<strong>Single-leader log position</strong>: the leader's order is the order (while it really is leader); causal and gapless.",
        "<strong>Noncausal generators</strong> (per-node counters, wall clocks, preallocated ID blocks, Snowflake IDs): unique, but not consistent with causality.",
        "<strong>Lamport timestamps</strong>: (counter, node ID); total order consistent with causality. They need the node-ID tie-breaker to be a total order, and can't detect concurrency.",
        "<strong>Vector clocks / version vectors</strong>: partial order; detect concurrency; one entry per participant.",
        "<strong>Hybrid logical clocks</strong>: physical time + Lamport counter (CockroachDB, YugabyteDB, MongoDB cluster time).",
        "<strong>Total order broadcast</strong>: an order that is final at delivery; equivalent to consensus.",
        "<strong>TrueTime</strong> (Spanner): clock uncertainty intervals plus commit wait; see ch8.",
      ],
    },
    {
      title: "Logical clocks compared",
      type: "table",
      headers: ["Mechanism", "Size", "Order", `<span style="overflow-wrap:normal;word-break:normal">Detects concurrency?</span>`, "Order final when you see it?", "Used by"],
      rows: [
        ["Lamport timestamp", "One counter + node ID", "Total, consistent with causality", "No", "No: a smaller timestamp may still arrive", "Tie-breaking, CRDT operation ordering"],
        ["Vector clock / version vector", "One counter per process / replica", "Partial", "Yes", "No", "Dynamo paper, Riak (dotted version vectors)"],
        ["Hybrid logical clock", "Physical time + counter", "Total (with node ID), causal, close to wall time", "No", "No", "CockroachDB, YugabyteDB, MongoDB"],
        ["Snowflake-style ID", "64 bits: time, worker, sequence", "Roughly time-sorted, not causal", "No", "n/a (not causal)", "Twitter, many ID services"],
        ["Log position (total order broadcast)", "One counter", "Total, causal, gapless", "No (everything is ordered)", "Yes", "ZooKeeper zxid, etcd revision, Kafka offset (per partition)"],
      ],
    },
    {
      title: "Problems equivalent to consensus",
      type: "list",
      items: [
        "Linearizable <strong>compare-and-set</strong> / increment-and-get register",
        "<strong>Total order broadcast</strong> (a replicated log)",
        "<strong>Atomic commit</strong> that tolerates coordinator failure",
        "<strong>Locks and leases</strong>; leader election",
        "<strong>Membership / coordination</strong> services",
        "<strong>Uniqueness constraints</strong> (usernames, seats, non-negative balances)",
      ],
    },
    {
      title: "What actually needs consensus",
      type: "note",
      body: "<p>CAS and increment-and-get, locks and leases, uniqueness, total order broadcast, atomic commit that survives coordinator failure, and leader election. <strong>Plain linearizable read/write registers don't</strong>: ABD builds them from majority quorums, even in an asynchronous network. So 'linearizability requires consensus' is wrong as a blanket statement; <em>compare-and-set</em> requires consensus.</p>",
    },
    {
      title: "2PC vs consensus",
      type: "table",
      headers: ["", "2PC", "Consensus (Raft, Paxos, Zab)"],
      rows: [
        ["Purpose", "Atomic commit: every participant commits or all abort", "Agree on one value, or a sequence of values (a log)"],
        ["Who decides", "A fixed coordinator", "An elected leader (one per epoch)"],
        ["Agreement needed from", "All participants vote YES", "A majority accepts"],
        ["Participant crash", "Before voting: the transaction aborts. After YES: it must recover and finish", "Tolerated while a majority is up"],
        ["If the decider crashes", "YES voters block in doubt, holding locks", "A new leader is elected after a timeout"],
        ["Recovery", "Coordinator reads its log; no commit record means abort (presumed abort)", "New leader brings followers' logs into line with its own"],
        ["Failure-free cost", "Two round trips plus forced log writes on every node", "One round trip to a majority per entry (stable leader)"],
        ["Typical use", "Cross-shard or cross-system atomic commit", "Leader election, replicated logs, coordination services"],
        ["Well-known implementations", "XA/JTA, PostgreSQL PREPARE TRANSACTION, Spanner (2PC over Paxos groups)", "Raft (etcd, Consul, CockroachDB, KRaft), Multi-Paxos (Chubby, Spanner, DynamoDB), Zab (ZooKeeper)"],
      ],
    },
    {
      title: "2PC points of no return",
      type: "list",
      items: [
        "<strong>Participant votes YES</strong>: it gives up the right to abort, and stays bound across its own crashes (the prepared state is on disk).",
        "<strong>Coordinator writes the decision to its log</strong>: this is the commit point. After it, the coordinator retries commit/abort forever.",
        "Timeouts are legal only before the promise: an unvoted participant may abort, a NO vote aborts immediately, and the coordinator may abort while collecting votes.",
        "2PC is not 2PL (two-phase locking, ch7).",
      ],
    },
    {
      title: "Paxos in one breath",
      type: "list",
      items: [
        "<strong>Phase 1</strong>: prepare(n) with a fresh, unique ballot n; acceptors promise to ignore ballots below n and report the highest-numbered proposal they have already accepted.",
        "<strong>Phase 2</strong>: with promises from a majority, send accept(n, v), where v = the value of the highest-numbered accepted proposal reported, or your own value only if none was reported.",
        "A value is <strong>chosen</strong> once a majority accepts it in the same ballot.",
        "Duelling proposers can livelock (FLP); real systems elect a distinguished proposer.",
        "<strong>Multi-Paxos</strong> skips phase 1 for later slots under a stable leader: one round trip per value, like Raft's AppendEntries.",
      ],
    },
    {
      title: "Raft in one breath",
      type: "list",
      items: [
        "<strong>Roles</strong>: follower, candidate, leader. Each term has at most one leader; a higher term always wins, and a leader that sees one steps down.",
        "<strong>Election</strong>: a follower that hears nothing for a randomized election timeout starts term t + 1, votes for itself and asks for votes. Each server votes once per term (persisted to disk), and only for a candidate whose log is at least as up to date. A majority wins.",
        "<strong>Replication</strong>: the leader sends AppendEntries carrying the previous entry's index and term; a follower accepts only if its log matches there. On a mismatch the leader backs up and overwrites the follower's conflicting suffix.",
        "<strong>Commit</strong>: an entry from the leader's current term is committed once a majority stores it; earlier entries commit along with it. New leaders append a no-op to get there quickly.",
        "<strong>Guarantee</strong>: committed entries are never lost, because every future leader needs a majority that includes a server holding them.",
        "<strong>Production extras</strong>: PreVote, CheckQuorum, learners (non-voting members), snapshots, and ReadIndex or lease reads for linearizable reads.",
      ],
    },
    {
      title: "Epoch names",
      type: "table",
      headers: ["Algorithm", "Epoch is called", "Year", "Used by"],
      rows: [
        ["Viewstamped Replication", "View number", "1988 (Oki and Liskov)", "Research systems; revisited in 2012"],
        ["Paxos / Multi-Paxos", "Ballot (proposal) number", "Written around 1989-90, published 1998", "Chubby, Spanner, DynamoDB"],
        ["Zab", "Epoch (high 32 bits of the zxid)", "Late 2000s (paper 2011)", "ZooKeeper"],
        ["Raft", "Term", "2014", "etcd, Consul, CockroachDB, TiKV, Kafka KRaft"],
      ],
      note: "Same rule everywhere: at most one leader per epoch, the higher epoch wins, and the epoch doubles as a fencing token.",
    },
    {
      title: "Coordination services (ZooKeeper, etcd)",
      type: "list",
      items: [
        "Primitives: linearizable CAS; total ordering (<strong>zxid / revision</strong> as fencing token); <strong>sessions + ephemeral nodes</strong> for failure detection; <strong>watches</strong> for change notification.",
        "3 or 5 voters serve thousands of clients; scale reads with non-voting members (ZooKeeper observers, etcd learners).",
        "Only slow-changing data (who leads partition 7), not per-request application state.",
        "ZooKeeper reads are served by the connected server and may be stale: sync() first. etcd reads are linearizable by default.",
        "Leader election recipe: ephemeral sequential znodes, lowest wins, each candidate watches only its predecessor.",
        "A lock is a lease: a paused holder may not know it expired, so the resource must check a fencing token.",
        "Kafka moved to KRaft (production-ready in 3.3; ZooKeeper removed in 4.0, 2025). Kubernetes keeps all state in etcd.",
      ],
    },
    {
      title: "Numbers to remember",
      type: "table",
      headers: ["What", "Number", "Why it matters"],
      rows: [
        ["Majority quorum", "floor(n/2) + 1", "Any two majorities overlap in at least one node"],
        ["Crash faults tolerated", "2f + 1 voters tolerate f", "3 tolerate 1, 5 tolerate 2; 4 still tolerate only 1"],
        ["Byzantine faults tolerated", "3f + 1 nodes tolerate f", "More than two-thirds must be honest (ch8)"],
        ["Linearizable latency", "At least proportional to delay uncertainty", "Attiya and Welch: no faster algorithm exists"],
        ["Lamport timestamp", "(counter, node ID)", "Without the node ID it is not a total order"],
        ["ZooKeeper zxid", "64 bits: epoch (high 32) + counter (low 32)", "Totally orders all writes; usable as a fencing token"],
        ["Raft failover", "About one election timeout + a round trip", "Writes are unavailable in the meantime"],
        ["GitHub, October 2018", "43 s partition, 24 h 11 min degraded", "Consensus-based failover worked; async replication left divergent writes"],
        ["Kafka KRaft", "Production-ready in 3.3 (2022); ZooKeeper removed in 4.0 (2025)", "'Kafka uses ZooKeeper' is out of date"],
        ["Amazon S3", "Strong read-after-write consistency since December 2020", "Overwrites and listings used to be eventually consistent"],
      ],
    },
    {
      title: "Which guarantee does this feature need?",
      type: "table",
      headers: ["Requirement", "Minimum guarantee", "How to get it"],
      rows: [
        ["Unique username or email, last seat, balance never negative", "Linearizable compare-and-set (consensus)", "Conditional insert in a consensus-backed store (etcd txn, Spanner, DynamoDB conditional put in one region), Cassandra LWT, or one log partition per key (ch12)"],
        ["Leader election, distributed lock", "Consensus + fencing token", "ZooKeeper/etcd recipes, Kubernetes Lease; storage rejects stale tokens"],
        ["Atomic commit across shards of one database", "2PC over consensus groups", "Spanner, CockroachDB, TiDB"],
        ["Order + payment across microservices", "Saga (no isolation) + idempotency", "Local transactions, compensations, transactional outbox"],
        ["Upload a file, then notify a worker", "Linearizable storage, or pass a version", "Strongly consistent store, or put the version in the message"],
        ["Replies appear after the post", "Causal consistency", "Causal session tokens (MongoDB), consistent prefix reads"],
        ["See your own profile edit", "Read-your-writes (ch5)", "Read your own data from the leader, or track your last write position"],
        ["Like counts, view counters", "Eventual consistency", "Async replication, CRDT counters"],
      ],
    },
  ],

  interview: [
    // ---- linearizability ----
    {
      id: "q01",
      q: "What does linearizability mean and why is it useful?",
      diff: "hard",
      section: "linearizability",
      a: `<p><strong>Linearizability</strong> makes a replicated system behave as if there were exactly one copy of the data. Each operation (read, write, compare-and-set) appears to take effect atomically at a single instant between the moment the client sends the request and the moment it gets the response.</p>
<p>The practical consequence is a <strong>recency guarantee</strong>:</p>
<ul><li>If operation A completes before operation B starts, B sees A's effect.</li><li>A read that overlaps a write may return the old or the new value, but <strong>once any read has returned the new value, every read that starts afterwards must return it too</strong>, even if the write hasn't been acknowledged yet. No going back.</li><li>It applies to single objects. It says nothing about multi-object transactions.</li></ul>
<p><strong>Why it's useful</strong>: some things are only correct if every node agrees on one up-to-date fact.</p>
<ul><li><strong>Locks and leader election</strong>: all nodes must agree who holds the lock (the job of ZooKeeper and etcd).</li><li><strong>Uniqueness and balance constraints</strong>: a username taken once, a seat sold once, a balance that never goes negative.</li><li><strong>Cross-channel timing dependencies</strong>: a worker told through a queue to process a file must be able to read that file; from a lagging replica it reads nothing, or an old version.</li></ul>
<p><strong>Cost</strong>: coordination on every operation. During a partition, the side that can't reach the leader or a majority must refuse writes <em>and</em> linearizable reads (CAP). Even without faults, Attiya and Welch showed that the response time of linearizable reads and writes is at least proportional to the uncertainty of network delays. That latency cost is why most databases, and even multi-core RAM, aren't linearizable by default.</p>`,
      followups: [
        "Is a single-leader database with follower reads linearizable?",
        "How would you test a database for linearizability?",
        "Does linearizability imply read-your-writes and monotonic reads?",
      ],
      pitfalls: [
        "Equating linearizability with serializability",
        "Thinking w + r &gt; n quorums give it",
        "Claiming an in-progress write must be invisible to every read (overlapping reads may see either value, they just can't go back)",
      ],
    },
    {
      id: "q02",
      q: "What's the difference between linearizability and serializability?",
      diff: "hard",
      section: "linearizability",
      a: `<p>They answer different questions, and neither implies the other.</p>
<ul><li><strong>Serializability</strong> is an <em>isolation</em> property of <em>transactions</em>, which may touch many objects: the result equals some serial execution. That order need not match real time, so a transaction can be serialized "in the past" and read stale data.</li><li><strong>Linearizability</strong> is a <em>recency</em> guarantee on <em>individual objects</em>: each read, write or CAS takes effect at one instant, in real-time order. It has no notion of grouping operations into transactions.</li></ul>
<p><strong>Examples that separate them</strong></p>
<ul><li><strong>Serializable snapshot isolation (SSI)</strong>, such as PostgreSQL's SERIALIZABLE level, is serializable but deliberately not linearizable: a transaction reads from the snapshot taken when it began, so it misses writes committed while it runs.</li><li>Plain <strong>snapshot isolation</strong> isn't serializable at all (write skew), so it's the wrong example of "serializable but not linearizable".</li><li><strong>Two-phase locking</strong> and <strong>actual serial execution</strong> are typically linearizable as well as serializable.</li><li>A linearizable key-value store offering only single-key get, put and CAS has no multi-object transactions, so serializability doesn't even apply.</li></ul>
<p>Both together give <strong>strict serializability</strong> (strong one-copy serializability). Spanner calls it <em>external consistency</em> and gets it from TrueTime plus commit wait; FoundationDB also documents it.</p>`,
      followups: [
        "Why is SSI not linearizable, and when would a user notice?",
        "Which of the two is 'stronger'?",
        "What extra machinery does Spanner need to be strictly serializable?",
      ],
      pitfalls: [
        "Assuming serializable implies up-to-date reads",
        "Calling snapshot isolation serializable",
        "Describing linearizability as 'serializability for distributed systems'",
      ],
    },

    // ---- linearizability-in-practice ----
    {
      id: "q-quorum-linearizable",
      q: "Does w + r > n make a Dynamo-style store linearizable?",
      diff: "hard",
      section: "linearizability-in-practice",
      a: `<p><strong>No.</strong> Quorum overlap guarantees that every read quorum includes at least one replica holding the latest <em>completed</em> write. Linearizability needs more: no read may return an older value than a read that finished before it started, including while a write is still in progress.</p>
<p><strong>The race</strong> (n = 3, w = 2, r = 2):</p>
<ol><li>The writer sends x = 1 to R1, R2 and R3. It reaches R1 quickly; R2 and R3 are slow, so the write hasn't completed.</li><li>Reader A queries {R1, R2}, sees 1 on R1 and returns <strong>1</strong>.</li><li>Reader B starts after A has finished, queries {R2, R3}, finds only the old value and returns <strong>0</strong>.</li></ol>
<p>B went back in time relative to A, so the history isn't linearizable, even though w + r &gt; n holds. (The book draws the same race with w = 3.)</p>
<p><strong>Other things that break it</strong></p>
<ul><li><strong>Last-write-wins</strong> on wall-clock timestamps: clock skew can order writes against real time and silently drop the later one (ch8).</li><li><strong>Sloppy quorums</strong> and hinted handoff: the "quorum" may not overlap the home replicas at all.</li><li>A write that failed overall but succeeded on some replicas isn't rolled back, so it can appear and disappear.</li></ul>
<p><strong>The fix</strong> for reads and writes is the <strong>ABD</strong> algorithm: a reader that sees differing versions writes the newest back to a write quorum and waits before returning (synchronous read repair), and a writer first reads the latest version from a quorum so it can pick a higher one. That adds a round trip to some reads, which is why Riak doesn't do it. Cassandra does wait for read repair on QUORUM reads, but its last-write-wins timestamps still break linearizability under concurrent writes.</p>
<p>Even ABD gives only reads and writes. <strong>Compare-and-set needs consensus</strong>, which is why Cassandra runs Paxos for its lightweight transactions.</p>`,
      followups: [
        "Draw a timeline where w + r &gt; n still returns stale data to a later reader.",
        "Why can't ABD give you compare-and-set?",
        "What does synchronous read repair cost on the read path?",
      ],
      pitfalls: [
        "Equating quorum overlap with linearizability",
        "Ignoring clock skew under last-write-wins",
        "Claiming sloppy quorums keep the w + r &gt; n guarantee",
      ],
    },

    // ---- cost-of-linearizability ----
    {
      id: "q03",
      q: "Explain the CAP theorem and what it really says.",
      diff: "medium",
      section: "cost-of-linearizability",
      a: `<p>CAP says that when a <strong>network partition (P)</strong> cuts some replicas off from the others, a system can't be both:</p>
<ul><li><strong>Consistent (C)</strong>, which here means <em>linearizable</em>, not ACID's C or any weaker model; and</li><li><strong>Available (A)</strong>: every request received by a non-failing node eventually gets a non-error response. That is much stricter than everyday "high availability".</li></ul>
<p>So during a partition, a replica that can't reach the others must either refuse or wait (keeping C), or answer from its own possibly stale data (keeping A). Brewer conjectured it in 2000; Gilbert and Lynch proved it in 2002.</p>
<p><strong>What it doesn't say</strong></p>
<ul><li>"Pick 2 of 3" is wrong. A partition is a fault, not a design option, so there is no "CA" distributed system. When the network works, you can have both C and A.</li><li>It says nothing about latency, crashed nodes or slow networks. P means a partition, nothing else.</li><li>"CP" and "AP" labels are too coarse. ZooKeeper's writes are linearizable but its default reads aren't (call sync() first). Cassandra's consistency is chosen per request, and its lightweight transactions give linearizable CAS. Spanner is technically CP, but Brewer describes it as "effectively CA" because Google's network makes partitions very rare.</li></ul>
<p>CAP is now mostly of historical interest; it helped push the industry beyond single-node databases. For design work, <strong>PACELC</strong> is more useful: if Partitioned, choose Availability or Consistency; Else, choose Latency or Consistency. The "else" half is the cost you pay on every request, because linearizable operations can't be faster than the uncertainty of network delay.</p>`,
      followups: [
        "CAP says nothing about latency. What result does, and what does it imply?",
        "Is a single-leader database with async followers CP, AP, or neither?",
        "How would you choose consistency per operation in your system?",
      ],
      pitfalls: [
        "'Pick 2 of 3'",
        "Describing a distributed system as 'CA'",
        "Treating CAP's A as '99.99% uptime'",
      ],
    },
    {
      id: "q-cap-classify",
      q: "A colleague says 'MongoDB is CP and Cassandra is AP, so pick based on that.' How do you respond?",
      diff: "medium",
      section: "cost-of-linearizability",
      a: `<p>I'd push back on the framing, then replace it with something more useful.</p>
<p><strong>By CAP's own definitions, most real systems are neither.</strong> C means linearizable; A means every request to a non-failing node gets a non-error response.</p>
<ul><li>A single-leader "CP" system makes the minority side unavailable, so it isn't A. Depending on configuration (reads from secondaries, weaker read concerns) it can also serve stale reads, so it isn't always C either.</li><li>Cassandra at QUORUM isn't linearizable (it waits for read repair, but concurrent writes are resolved by last-write-wins and writers don't read a quorum first, so it isn't full ABD), and a node cut off from a quorum returns errors, so it isn't A either. At ONE it is available but eventually consistent.</li></ul>
<p><strong>Guarantees are per operation.</strong></p>
<ul><li>Cassandra: consistency level per query; lightweight transactions (Paxos) for linearizable CAS.</li><li>MongoDB: read and write concerns per operation, including a "linearizable" read concern for single-document reads and causally consistent sessions.</li><li>DynamoDB: eventually consistent reads by default, ConsistentRead for strongly consistent ones; conditional writes for CAS.</li></ul>
<p><strong>A better method</strong>: list the operations, then for each one state the guarantee it needs (linearizable, causal, read-your-writes, eventual), what should happen during a partition (error, wait, or serve stale), and what normal-case latency it can afford (PACELC). For example, "claim username" needs linearizable CAS and may fail during a partition; "show follower count" can be eventual and always local.</p>`,
      followups: [
        "What does Spanner claim with respect to CAP?",
        "What is PACELC, and why is it more useful day to day?",
        "Give an operation in your system that needs linearizability and one that doesn't.",
      ],
      pitfalls: [
        "'Pick 2 of 3'",
        "Claiming a distributed system can be 'CA'",
        "Ignoring that the choice is made per operation",
      ],
    },

    // ---- causality ----
    {
      id: "q-consistency-spectrum",
      q: "Rank eventual, causal, sequential, linearizable and strictly serializable consistency, give an example system or mechanism for each, and describe a history that is sequentially consistent but not linearizable.",
      diff: "medium",
      section: "causality",
      a: `<p><strong>Strongest to weakest</strong></p>
<ol><li><strong>Strict serializability</strong>: serializable transactions whose order respects real time. Spanner's external consistency, FoundationDB.</li><li><strong>Linearizability</strong>: each object behaves like one copy in real-time order. etcd, ZooKeeper writes, Raft-based key-value stores.</li><li><strong>Sequential consistency</strong>: one total order seen by everyone, respecting each client's own order but not real time. ZooKeeper reads from a follower without sync().</li><li><strong>Causal consistency</strong>: causally related operations appear in the same order everywhere; concurrent ones in any order. MongoDB causally consistent sessions, COPS.</li><li><strong>Eventual consistency</strong>: replicas converge if writes stop. Dynamo-style stores at consistency level ONE.</li></ol>
<p><strong>Caveat</strong>: strict serializability concerns multi-object transactions, so the ladder mixes two axes. For single-object operations it coincides with linearizability.</p>
<p><strong>Sequential but not linearizable</strong>: client A's write x = 1 completes. Afterwards, client B reads x = 0 from a lagging follower. The order "B's read, then A's write" respects each client's own order, so the history is sequentially consistent, but it contradicts real time (A finished before B started), so it isn't linearizable.</p>
<p><strong>Availability</strong>: only causal consistency and weaker models can stay available on both sides of a partition. Causal is the strongest model known to manage that (shown for real-time causal consistency by Mahajan, Alvisi and Dahlin, 2011), which makes it attractive for geo-replication.</p>`,
      followups: [
        "Which of these can stay available during a partition?",
        "Where does snapshot isolation fit, and why is it a different axis?",
        "Why is causal consistency attractive for geo-replication?",
      ],
      pitfalls: [
        "Calling serializability 'strong consistency'",
        "Placing causal consistency above sequential consistency",
        "Claiming eventual consistency guarantees read-your-writes",
      ],
    },
    {
      id: "q-causal-comments",
      q: "In a comments service replicated across three regions, readers sometimes see a reply before the comment it answers. How would you fix this without sending every write through one region?",
      diff: "medium",
      section: "causality",
      a: `<p>This is a <strong>causality</strong> violation, not a recency problem: the reply was written by someone who had read the parent, so the reply depends on it, yet a replica made the reply visible first. Linearizability would fix it, but at the cost of a cross-region round trip on every write and unavailability during a partition. <strong>Causal consistency</strong> is enough, and it can be served from local replicas.</p>
<p><strong>Why the obvious fix fails</strong>: sorting by wall-clock timestamps doesn't help. A reply written in a region whose clock runs slow can carry an earlier timestamp than its parent, and the real issue is visibility, not sort order: the parent may not have arrived at that replica at all.</p>
<p><strong>Design options</strong></p>
<ul><li><strong>Explicit dependencies</strong>: a reply records the ID and version of its parent (and, more generally, what its author had read). A replica that receives the reply makes it visible only once its dependencies are visible locally, buffering it until then. This is what research systems such as COPS do across datacenters.</li><li><strong>Session tokens</strong>: each response returns a logical timestamp (a Lamport or hybrid logical clock value, or a version vector) that the client sends back on its next request; a replica serves the request only after it has applied everything up to that point. MongoDB's causally consistent sessions work this way. This gives each user read-your-writes and monotonic reads, and a reply's position in the order includes everything its author saw.</li><li><strong>One ordered log per thread</strong>: route all writes for a thread to the thread's home partition, so they share one totally ordered log. Simple and strong, but writes from other regions pay a round trip to the thread's home.</li><li><strong>A client-side safety net</strong>: don't render a reply whose parent hasn't loaded yet.</li></ul>
<p><strong>What you give up</strong>: real-time recency (a reader in another region may not see a new comment for a while), and constraints that need one decision, such as unique handles, still need consensus. Dependency metadata grows with the number of writers or items tracked, so practical systems track only direct dependencies or use compact clocks.</p>
<p><strong>What you keep</strong>: every region can accept writes and serve reads during a partition, and no effect ever appears before its cause.</p>`,
      followups: [
        "Why is the dependency 'what the author had read', not just 'the parent comment'?",
        "What happens to a reply whose parent is stuck in a partitioned region?",
        "How large do version vectors get, and how do real systems keep them small?",
      ],
      pitfalls: [
        "Sorting by wall-clock timestamps and calling it fixed",
        "Reaching for linearizability (a global round trip) when causality is enough",
        "Assuming causal consistency also gives up-to-date reads across regions",
      ],
    },

    // ---- lamport-timestamps ----
    {
      id: "q-lamport-vs-vector",
      q: "Compare Lamport timestamps and vector clocks. When would you use each, and why can't Lamport timestamps alone enforce a uniqueness constraint?",
      diff: "medium",
      section: "lamport-timestamps",
      a: `<p><strong>Lamport timestamps</strong></p>
<ul><li>One counter per node; each timestamp is the pair <strong>(counter, node ID)</strong>, with ties broken by node ID.</li><li>Every node and client sends the largest counter it has seen; a receiver sets its counter to max(own, received) and increments.</li><li>They give a <strong>total order consistent with causality</strong>: if a happened before b, then L(a) &lt; L(b). They're compact: one integer per message.</li><li>They <strong>can't detect concurrency</strong>: L(a) &lt; L(b) doesn't mean a happened before b.</li></ul>
<p><strong>Vector clocks</strong></p>
<ul><li>One counter per participant. Compare entrywise: a &le; b on every entry means a happened before b; otherwise the events are concurrent.</li><li>They give a <strong>partial order</strong> that distinguishes "before" from "concurrent", at a size that grows with the number of participants.</li><li><strong>Version vectors</strong> are the per-replica variant attached to a data item to detect conflicting writes (Dynamo, Riak with dotted version vectors).</li></ul>
<p><strong>When to use which</strong>: Lamport when you need a cheap total order (tie-breaking, ordering operations in a log or CRDT). Vectors when you must <em>detect</em> conflicts and keep siblings rather than silently dropping a write.</p>
<p><strong>Why not uniqueness</strong>: picking the lowest timestamp works after the fact, once you have every claim. But a node handling a sign-up must answer <em>now</em>, and a concurrent claim with a lower timestamp might still be in flight from another node. To be sure, it would have to hear from every node, and if any node is unreachable it can't answer, which isn't fault tolerant. You need an order that is final at delivery: total order broadcast, which is equivalent to consensus.</p>
<p><strong>Modern middle ground</strong>: hybrid logical clocks combine wall time with a Lamport counter, so timestamps stay close to real time and respect causality (CockroachDB, YugabyteDB, MongoDB).</p>`,
      followups: [
        "How do you keep vector clocks from growing without bound?",
        "What do hybrid logical clocks add?",
        "Where does TrueTime fit?",
      ],
      pitfalls: [
        "Saying L(a) &lt; L(b) means a happened before b",
        "Saying vector clocks give a total order",
        "Forgetting the node-ID tie-breaker",
      ],
    },
    {
      id: "q-unique-id-generator",
      q: "Design a service that hands out unique, roughly time-ordered 64-bit IDs at a high rate across many machines. Could those IDs be used to order events causally?",
      diff: "medium",
      section: "lamport-timestamps",
      a: `<p><strong>Options</strong></p>
<ul><li><strong>One central counter</strong>: simple and totally ordered, but a throughput bottleneck and a single point of failure. Replicating it with consensus fixes availability, but then each ID (or each block of IDs) costs a consensus round.</li><li><strong>Preallocated ranges per node</strong> (node A gets 1-1000, node B 1001-2000): fast and unique, but not time-ordered across nodes.</li><li><strong>Snowflake-style</strong> (Twitter, 2010): 1 sign bit, a 41-bit millisecond timestamp, a 10-bit worker ID and a 12-bit per-worker sequence, so each worker can issue 4,096 IDs per millisecond with no coordination per ID. This is the usual answer.</li></ul>
<p><strong>Getting Snowflake right</strong></p>
<ul><li>Uniqueness comes from <strong>unique worker IDs</strong> plus the sequence, not from the clock. Assign worker IDs through a coordination service (for example an ephemeral sequential znode or an etcd lease) or static config, and never reuse one while its old holder might still be running.</li><li>Handle the <strong>clock moving backwards</strong> (an NTP step): refuse to issue IDs, or wait until the clock passes the last timestamp used. Otherwise you can issue duplicates.</li><li>If the sequence overflows within a millisecond, wait for the next millisecond.</li></ul>
<p><strong>Causality: no.</strong> IDs from different workers are ordered by skewed clocks, so an effect created on a worker with a slow clock can get a smaller ID than its cause. Ranges are worse. If you need a causal order, carry a Lamport or hybrid logical clock through requests (max seen + 1). If you need an order that is final when the ID is issued, you need a single log: total order broadcast.</p>`,
      followups: [
        "What do you do when a worker's clock jumps backwards?",
        "How do you assign worker IDs safely?",
        "What would a hybrid logical clock add?",
      ],
      pitfalls: [
        "Claiming timestamp-based IDs respect causality",
        "Ignoring clock rollback (an NTP step) producing duplicate IDs",
        "Relying on a single auto-increment primary with asynchronous failover (a promoted follower can hand out IDs that were already used; see failover in ch5)",
      ],
    },

    // ---- total-order-broadcast ----
    {
      id: "q08",
      q: "What is total order broadcast and how does it relate to consensus?",
      diff: "hard",
      section: "total-order-broadcast",
      a: `<p><strong>Total order broadcast</strong> (atomic broadcast) delivers messages to all nodes with two guarantees that hold despite faults:</p>
<ul><li><strong>Reliable delivery</strong>: if a message is delivered to one node, it is delivered to all. During a partition, delivery waits and retries.</li><li><strong>Totally ordered delivery</strong>: every node delivers messages in the same order.</li></ul>
<p>The crucial detail is that the order is <strong>fixed at delivery</strong> and <strong>gapless</strong>: a node never inserts a message before one it already delivered, and after delivering message 4 it waits for 5 before delivering 6. That is exactly what Lamport timestamps lack; with them, a smaller timestamp might still arrive later.</p>
<p><strong>What you can build on it</strong></p>
<ul><li><strong>State machine replication</strong>: every replica applies the same deterministic commands in log order and stays identical (etcd, ZooKeeper, Consul).</li><li><strong>Linearizable compare-and-set</strong>, for example claiming a username: append "claim kim for user 17", wait until your own message is delivered back, and if it is the first claim for "kim" in the log you've won; otherwise abort. Every node sees the same first claim.</li><li><strong>Fencing tokens</strong>: the log position (ZooKeeper zxid, etcd revision) increases monotonically.</li><li><strong>Serializable transactions</strong>: deterministic stored procedures executed in log order (VoltDB, Calvin).</li></ul>
<p><strong>Reads aren't automatically linearizable</strong>: delivery to each replica is asynchronous, so a replica may lag (sequential consistency). Sequence the read through the log, or obtain the latest log position linearizably and wait until you've applied it (Raft ReadIndex; ZooKeeper sync() then read).</p>
<p><strong>Relation to consensus</strong>: they are equivalent. Running consensus once per log slot gives total order broadcast, which is what Raft, Zab and Multi-Paxos do. Conversely, given total order broadcast, nodes can decide on the first value delivered. Both are also equivalent to a linearizable <em>increment-and-get</em> or <em>compare-and-set</em> register: with such a register you can number messages and deliver them gaplessly. Plain read/write registers are weaker and don't need consensus.</p>
<p>Kafka is a practical example with a caveat: each partition is a totally ordered log, but there is no order across partitions.</p>`,
      followups: [
        "How would you implement a linearizable username claim on top of a log?",
        "Why aren't reads from a replica of the log linearizable?",
        "How do you get a total order across Kafka partitions, and what does it cost?",
      ],
      pitfalls: [
        "Saying Lamport timestamps provide total order broadcast",
        "Forgetting that delivery is asynchronous, so replica reads can be stale",
        "Claiming plain read/write registers need consensus",
      ],
    },
    {
      id: "q-linearizable-reads-raft",
      q: "A Raft-based key-value store must serve linearizable reads. Why isn't 'read from the leader's local state' enough, and what are the options?",
      diff: "hard",
      section: "total-order-broadcast",
      a: `<p>Writes are linearizable because they go through the log and commit on a majority. A read answered from the leader's local state skips that, and the node that <em>thinks</em> it is leader may not be:</p>
<ul><li>It may be partitioned or paused (GC, VM migration) while the majority elects a new leader in a higher term and commits new writes.</li><li>Until it hears about the higher term, it answers from stale state. A client that already saw the new value through the new leader could then read an older one: not linearizable.</li></ul>
<p><strong>Options</strong></p>
<ol><li><strong>Read through the log</strong>: append the read as an entry and answer when it is applied. Obviously correct, but every read costs a log append and a majority round trip. Early etcd versions served quorum reads this way.</li><li><strong>ReadIndex</strong>: the leader records its commit index, confirms it is still leader with a heartbeat round acknowledged by a majority, waits until its state machine has applied up to that index, then reads locally. One round trip, no disk write. etcd's default linearizable reads work this way. (A new leader first commits an entry from its own term, the no-op, so its commit index is current.)</li><li><strong>Lease reads</strong>: after a successful heartbeat round, the leader assumes no one else can be elected for a lease shorter than the election timeout, and serves reads locally until it expires. Saves the round trip but depends on bounded clock drift and pauses. CockroachDB serves reads from a range's leaseholder without a quorum round trip, which is one reason it needs a bounded clock offset.</li><li><strong>Follower reads</strong>: a follower asks the leader for the current read index, waits until it has applied that far, then answers locally. This offloads the leader and keeps data transfer local in multi-region setups, though the small round trip to the leader remains. TiKV's follower read works this way.</li></ol>
<p>ZooKeeper's analogue is calling sync() before a read so the connected server catches up with the leader. Contrast etcd's <em>serializable</em> reads (etcd's name for a local read, unrelated to serializable isolation): any member answers from local state, fast but possibly stale.</p>`,
      followups: [
        "Why does a lease read depend on clocks while ReadIndex doesn't?",
        "How do follower reads help a multi-region deployment?",
        "What is the latency cost of each option?",
      ],
      pitfalls: [
        "Assuming the node that thinks it's leader is the leader",
        "Using wall-clock timestamps to decide freshness",
        "Forgetting to wait for the apply index to reach the read index",
      ],
    },
    {
      id: "q-unique-usernames",
      q: "Design username registration that guarantees no two users ever get the same username, for an app running in three regions.",
      diff: "hard",
      section: "total-order-broadcast",
      a: `<p>Of two concurrent sign-ups for "kim", exactly one may be told yes, and the answer must be final when it is given. That is a <strong>linearizable compare-and-set</strong> on the name ("set owner of kim if unset"), which is a consensus problem. No amount of asynchronous replication or clever timestamps avoids it.</p>
<p><strong>Design options</strong></p>
<ul><li><strong>One home per name</strong>: hash the username to a partition whose replicas form a Raft or Paxos group, and do a conditional insert there. All claims for "kim" go through one log, so the first one wins.</li><li><strong>A store with consensus-backed unique constraints</strong>: a unique index in Spanner or CockroachDB, or a DynamoDB conditional put (attribute_not_exists) on a table in a single region.</li><li><strong>Cassandra lightweight transactions</strong>: INSERT ... IF NOT EXISTS runs Paxos among the key's replicas. Use SERIAL rather than LOCAL_SERIAL if uniqueness must hold across regions.</li></ul>
<p><strong>What you pay</strong></p>
<ul><li>A sign-up whose name's group (or Paxos quorum) is in another region pays at least one cross-region round trip, more for LWT.</li><li>If a majority of that group is unreachable, sign-ups for those names fail or wait. That's the CAP choice, made only for this operation; profile reads and feeds can stay local and eventually consistent.</li></ul>
<p><strong>Why the naive approaches fail</strong></p>
<ul><li>Check-then-insert against a local replica: two regions both see "free" and both insert.</li><li>A multi-region active-active table with last-writer-wins (for example DynamoDB Global Tables in their original mode): both inserts succeed locally and one silently overwrites the other later.</li><li>"The lower timestamp wins, decided later": both users have already been told yes, so one must lose the name.</li><li>w + r &gt; n quorums: they provide no compare-and-set.</li></ul>
<p><strong>AP alternative</strong>: accept locally, detect duplicates asynchronously, and ask one user to rename (a compensation). Fine for low-stakes names; not for login identifiers or email addresses.</p>`,
      followups: [
        "What happens to sign-ups when the region holding the name's partition is partitioned away?",
        "How would you build the same guarantee on top of a replicated log?",
        "Could you reserve names optimistically and still keep the UI responsive?",
      ],
      pitfalls: [
        "Checking availability on a read replica, then inserting",
        "Assuming w + r &gt; n quorums give compare-and-set",
        "Relying on wall-clock timestamps to pick a winner after both users were told yes",
      ],
    },

    // ---- two-phase-commit ----
    {
      id: "q04",
      q: "Explain two-phase commit (2PC) and its weaknesses.",
      diff: "hard",
      section: "two-phase-commit",
      a: `<p>2PC makes a transaction that spans several nodes commit everywhere or nowhere. Roles: a <strong>coordinator</strong> (transaction manager) and the <strong>participants</strong> (databases).</p>
<ol><li>The application gets a global transaction ID and does its reads and writes on each participant. Any participant may still abort.</li><li><strong>Prepare</strong>: the coordinator sends prepare to all. Each participant writes the transaction durably, checks constraints and conflicts, and votes YES or NO. <strong>A YES vote gives up the right to abort</strong>: the participant must commit if told to, even after a crash, and keeps its locks.</li><li><strong>Decision</strong>: the coordinator decides commit only if every vote was YES and writes the decision to its own log. <strong>That write is the commit point.</strong></li><li><strong>Commit/abort</strong>: it sends the decision to every participant, retrying forever until each acknowledges.</li></ol>
<p>On recovery the coordinator reads its log; transactions without a commit record are aborted (<strong>presumed abort</strong>). Timeouts are allowed only before the promise: a participant that hasn't voted may abort, and the coordinator may abort while collecting votes.</p>
<p><strong>Weaknesses</strong></p>
<ul><li><strong>Blocking</strong>: if the coordinator crashes after participants voted YES, they are in doubt and must wait, holding locks, until it recovers. Three-phase commit avoids this only if delays are bounded (a perfect failure detector), which real networks don't offer.</li><li><strong>Cost</strong>: extra forced disk writes and round trips; locks held across the network; one slow or failed participant fails or stalls the whole transaction.</li><li><strong>Operational hazards</strong>: if the coordinator's log is lost, transactions stay in doubt until an administrator makes a <strong>heuristic decision</strong>, which can break atomicity. With XA the coordinator often runs inside the application process, and there's no deadlock detection across systems.</li></ul>
<p><strong>Modern practice</strong>: consensus doesn't replace atomic commit across shards. Systems like Spanner still run 2PC, but make the coordinator and every participant a Paxos group, so one machine's crash doesn't block anyone. Across microservices, sagas are an application-level alternative that gives up isolation.</p>`,
      followups: [
        "What can a participant do if the coordinator is gone after it voted YES?",
        "Why doesn't three-phase commit solve the blocking problem in practice?",
        "How does Spanner keep 2PC from blocking?",
      ],
      pitfalls: [
        "Confusing 2PC with 2PL",
        "Saying participants can time out and abort after voting YES",
        "Saying the commit point is when all participants vote YES (it is the coordinator's durable decision)",
      ],
    },

    // ---- distributed-transactions-in-practice ----
    {
      id: "q-2pc-vs-saga",
      q: "Placing an order must debit a payment service and reserve stock in an inventory service, each with its own database. Would you use 2PC/XA or a saga? Justify.",
      diff: "medium",
      section: "distributed-transactions-in-practice",
      a: `<p><strong>I'd use a saga.</strong> XA is possible in principle, but it fits this setup badly.</p>
<p><strong>Why not XA here</strong></p>
<ul><li>Both databases (and any message broker) must support XA, and the services must expose their databases to a shared transaction manager, which breaks service boundaries.</li><li>The coordinator must be highly available; typically it is a library in one application process. If it dies after prepare, rows stay locked in doubt until it recovers, and stock or account rows may be hot.</li><li>Locks are held across network round trips, and one slow or failed participant fails the whole order.</li></ul>
<p><strong>The saga</strong></p>
<ol><li>Create the order as PENDING (local transaction).</li><li>Reserve stock in the inventory service (local transaction). Compensation: release the reservation.</li><li>Charge payment (local transaction, with an idempotency key). Compensation: refund.</li><li>Mark the order CONFIRMED; if any step fails, run the compensations for completed steps in reverse.</li></ol>
<ul><li><strong>Orchestrated</strong> (a coordinator service drives the steps) or <strong>choreographed</strong> (services react to each other's events).</li><li><strong>Every step and compensation must be idempotent</strong>, because messages are retried.</li><li>Publish each step's event atomically with its local write using a <strong>transactional outbox</strong> (or change data capture, ch11).</li></ul>
<p><strong>What sagas lose</strong>: isolation. Other requests can see intermediate states (stock reserved, payment not yet taken), so use explicit pending states or semantic locks and don't show PENDING as final. Compensations must also be possible: a sent email can't be unsent.</p>
<p><strong>When 2PC is fine</strong>: inside one distributed database that runs it over consensus-replicated participants (Spanner, CockroachDB). If both tables lived there, a single transaction would be simpler.</p>`,
      followups: [
        "What if a compensating action fails?",
        "How do you guarantee the event is published if and only if the local transaction committed?",
        "How do you stop a customer from seeing a 'reserved but not paid' state as final?",
      ],
      pitfalls: [
        "Claiming sagas give the same atomicity and isolation as 2PC",
        "Assuming 2PC is non-blocking",
        "Forgetting idempotency for retried steps",
      ],
    },

    // ---- consensus ----
    {
      id: "q05",
      q: "What is consensus and why does it matter?",
      diff: "hard",
      section: "consensus",
      a: `<p><strong>Consensus</strong> gets several nodes to decide on one value despite failures. Formally:</p>
<ul><li><strong>Uniform agreement</strong>: no two nodes decide differently.</li><li><strong>Integrity</strong>: no node decides twice.</li><li><strong>Validity</strong>: the decided value was proposed by some node (rules out "always decide null").</li><li><strong>Termination</strong>: every node that doesn't crash eventually decides.</li></ul>
<p>The first three are <strong>safety</strong> properties; termination is <strong>liveness</strong>. Termination is what rules out a dictator: 2PC's coordinator satisfies the other three, but nothing happens while it is down.</p>
<p><strong>Fault model</strong>: with 2f + 1 nodes, the algorithm stays live while at most f crash (a majority must be up and connected), and it stays safe even if more fail (it stops deciding, but never decides wrongly). The usual algorithms assume crash faults, not Byzantine ones; tolerating Byzantine nodes needs 3f + 1.</p>
<p><strong>Why it matters</strong>: many problems are equivalent to it, so if you need any of them, you need consensus:</p>
<ul><li>A linearizable compare-and-set register</li><li>Atomic commit that survives coordinator failure</li><li>Total order broadcast (a replicated log)</li><li>Locks, leases and leader election</li><li>Membership and coordination services</li><li>Uniqueness constraints</li></ul>
<p><strong>Implementations</strong>: Paxos (Multi-Paxos), Raft, Zab, Viewstamped Replication, all built on numbered epochs and overlapping majority quorums. In practice you use them through etcd, ZooKeeper, Consul, or a database with Raft built in.</p>`,
      followups: [
        "Why can't 2PC be considered fault-tolerant consensus?",
        "Which property does FLP say you can't always guarantee?",
        "Does consensus survive Byzantine nodes?",
      ],
      pitfalls: [
        "Saying consensus needs every node to respond",
        "Mixing up safety and liveness",
        "Claiming all linearizability needs consensus (plain read/write registers don't)",
      ],
    },
    {
      id: "q09",
      q: "What is the FLP impossibility result?",
      diff: "hard",
      section: "consensus",
      a: `<p><strong>Fischer, Lynch and Paterson (1985)</strong>: in the <strong>asynchronous</strong> system model (no bound on message delays, no clocks, so no timeouts), no <strong>deterministic</strong> consensus algorithm can guarantee <strong>termination</strong> if even <strong>one node may crash</strong>. The intuition: a slow node is indistinguishable from a crashed one, and the adversarial schedule can always keep the system undecided.</p>
<p>What it does <em>not</em> say: that consensus is unsafe, or impossible in practice. Safety is never at stake.</p>
<p><strong>How real systems escape it</strong></p>
<ul><li><strong>Partial synchrony and timeouts</strong>: assume the network is eventually well-behaved for long enough, and use timeouts to suspect crashed leaders. Paxos, Raft and Zab do this: always safe, and live whenever the network cooperates.</li><li><strong>Randomization</strong>: randomized consensus algorithms (Ben-Or, 1983) terminate with probability 1 even in the asynchronous model.</li></ul>
<p><strong>A common confusion</strong>: Raft's <em>randomized election timeouts</em> are not what gets around FLP. They only make split votes unlikely. Raft escapes FLP by relying on timeouts at all, which is the partial-synchrony assumption.</p>
<p>You can see FLP in practice: duelling Paxos proposers that keep pre-empting each other, or Raft elections that keep splitting when timeouts are badly tuned. Engineering makes these rare; nothing makes them impossible.</p>`,
      followups: [
        "What is the difference between the asynchronous and partially synchronous models?",
        "Why don't Raft's random timeouts count as 'randomized consensus'?",
        "Show a schedule in which Paxos never decides.",
      ],
      pitfalls: [
        "'FLP means consensus is impossible in practice'",
        "Saying randomized election timeouts are how Raft circumvents FLP",
        "Thinking FLP threatens safety rather than termination",
      ],
    },
    {
      id: "q06",
      q: "Compare Paxos and Raft.",
      diff: "hard",
      section: "consensus",
      a: `<p>Both are crash-fault-tolerant consensus algorithms with the same core: a leader per numbered epoch (Paxos <em>ballot</em>, Raft <em>term</em>), and decisions accepted by a majority so any two quorums overlap. They tolerate f failures with 2f + 1 nodes.</p>
<p><strong>Paxos</strong> (Lamport; written around 1989-90, published 1998)</p>
<ul><li>Basic Paxos decides <em>one</em> value in two phases (prepare/promise, accept/accepted). Production systems use <strong>Multi-Paxos</strong>: a stable leader skips phase 1 for later log slots.</li><li>Specified minimally; leader election, log management, membership changes and snapshots are left to implementers. "Paxos Made Live" (2007) describes how much extra engineering Chubby needed.</li><li>Used by Chubby, Spanner and DynamoDB (Multi-Paxos per partition).</li></ul>
<p><strong>Raft</strong> (Ongaro and Ousterhout, 2014), designed for understandability:</p>
<ul><li><strong>Strong leader</strong>: entries flow only from leader to followers.</li><li><strong>Randomized election timeouts</strong> make split votes rare.</li><li><strong>Election restriction</strong>: a node votes only for a candidate whose log is at least as up to date, so a new leader already has every committed entry and never needs to fetch missing ones.</li><li><strong>Log without holes</strong>; followers' logs are forced to match the leader's.</li><li>Complete specification including membership changes and snapshotting. Used by etcd, Consul, CockroachDB, TiKV, YugabyteDB, Redpanda and Kafka's KRaft; MongoDB's replication protocol is Raft-like.</li></ul>
<p><strong>History</strong>: Viewstamped Replication (1988) predates Paxos's publication, and Zab (ZooKeeper) predates Raft. All of them implement total order broadcast.</p>
<p><strong>Performance</strong>: neither is inherently faster; with a stable leader, both need one round trip to a majority per entry. Raft became the default for new systems because it is easier to implement and verify correctly.</p>`,
      followups: [
        "What in Raft plays the role of Paxos's 'adopt the highest accepted value' rule?",
        "Why does Raft restrict which nodes can win an election?",
        "How do PreVote and CheckQuorum help a Raft cluster with a flaky link?",
      ],
      pitfalls: [
        "'Raft is faster than Paxos'",
        "Saying basic Paxos replicates a log (it decides a single value)",
        "Claiming Raft was the first leader-based consensus algorithm",
      ],
    },
    {
      id: "q-paxos-basic",
      q: "Walk through single-decree Paxos. Why must a proposer adopt the value of the highest-numbered proposal it hears about?",
      diff: "hard",
      section: "consensus",
      a: `<p><strong>Roles</strong>: proposers, acceptors (2f + 1 of them to tolerate f crashes) and learners.</p>
<p><strong>Phase 1: prepare / promise</strong></p>
<ul><li>A proposer picks a ballot number n that is unique and higher than any it has used, and sends prepare(n) to the acceptors.</li><li>An acceptor that hasn't promised a higher ballot promises to ignore ballots below n, and replies with the highest-numbered proposal it has already accepted, if any.</li></ul>
<p><strong>Phase 2: accept / accepted</strong></p>
<ul><li>With promises from a majority, the proposer sends accept(n, v). The value v is <strong>the value of the highest-numbered accepted proposal among the replies</strong>, or its own value only if none was reported.</li><li>An acceptor accepts unless it has since promised a higher ballot.</li><li>A value is <strong>chosen</strong> once a majority of acceptors accept it in the same ballot.</li></ul>
<p><strong>Why adopt?</strong> A value may already have been chosen by a majority under an older ballot, without this proposer knowing. Any majority of promises intersects that majority, so at least one promise reports the value. By re-proposing it rather than its own, the new proposer can never override a chosen value, which preserves agreement. The ballot number alone doesn't do that; the adopt rule does.</p>
<p><strong>Liveness</strong>: two proposers can keep pre-empting each other with higher ballots forever (FLP in action). Real systems elect a distinguished proposer and use timeouts.</p>
<p><strong>Multi-Paxos</strong> keeps a stable leader that runs phase 1 once and then only phase 2 for each log slot: one round trip per value, like Raft's AppendEntries. In DDIA's terms, ballot = epoch, phase 1 = the vote that establishes the epoch, phase 2 = the vote on a proposal.</p>`,
      followups: [
        "What happens if two proposers keep pre-empting each other?",
        "How does Multi-Paxos avoid running phase 1 for every value?",
        "What in Raft plays the role of 'adopt the highest accepted value'?",
      ],
      pitfalls: [
        "Saying a value is chosen when the proposer decides it, rather than when a majority accepts it",
        "Letting a proposer always use its own value",
        "Thinking Paxos needs every acceptor to respond",
      ],
    },
    {
      id: "q-raft-leader-crash",
      q: "In a 5-node Raft cluster the leader crashes right after a client sends it a write. Walk through what happens next. Did the write happen?",
      diff: "hard",
      section: "consensus",
      a: `<p><strong>Election</strong></p>
<ul><li>Followers stop receiving heartbeats. After a randomized election timeout, one becomes a candidate in term t + 1, votes for itself and requests votes.</li><li>It needs 3 of 5 votes. The <strong>election restriction</strong> (vote only for a candidate whose log is at least as up to date) guarantees the winner holds every committed entry.</li><li>Writes are unavailable for roughly the election timeout plus a round trip.</li></ul>
<p><strong>The write's fate depends on how far it got</strong></p>
<ul><li><strong>Only on the old leader</strong>: lost. No client was told it succeeded.</li><li><strong>Stored on a majority</strong>: committed, even though nobody told the client. The new leader has it and keeps it.</li><li><strong>On a minority of followers</strong>: it may survive (if one of them wins) or be overwritten. Either way it counts as committed only once the new leader commits an entry from its own term on top of it; that's why Raft leaders append a <strong>no-op</strong> at the start of a term.</li></ul>
<p><strong>The client</strong> saw a timeout, which says nothing about the outcome. It must retry against the new leader, and retries must be <strong>idempotent</strong> or the write may be applied twice. The Raft dissertation recommends a client ID plus a request sequence number that the state machine deduplicates.</p>
<p><strong>If the old leader was only paused</strong>: when it wakes it still believes it leads, but any message it sends returns a higher term, so it steps down and its uncommitted entries are overwritten. It couldn't commit anything meanwhile, because it can't reach a majority. Anything it does to external systems must be fenced by term (ch8).</p>`,
      followups: [
        "Why does a new Raft leader append a no-op entry at the start of its term?",
        "How would you make client retries safe?",
        "How do you choose the election timeout relative to network round trips?",
      ],
      pitfalls: [
        "'The write is lost because the leader crashed' (it may already be committed)",
        "Retrying non-idempotent writes blindly",
        "Assuming any follower can win the election (the election restriction excludes followers missing committed entries)",
      ],
    },
    {
      id: "q-raft-log-replication",
      q: "How does Raft replicate its log, keep followers' logs consistent, and decide that an entry is committed?",
      diff: "hard",
      section: "consensus",
      a: `<p><strong>Normal operation</strong></p>
<ol><li>A client sends a command to the leader, which appends it to its own log as an entry tagged with the current term and the next index.</li><li>The leader sends <code>AppendEntries</code> to every follower: the new entries, the index and term of the entry just before them (<em>prevLogIndex</em>, <em>prevLogTerm</em>), and the leader's commit index. Heartbeats are simply empty AppendEntries.</li><li>A follower accepts only if its log holds an entry at prevLogIndex with term prevLogTerm (the <strong>consistency check</strong>). If so, it deletes any conflicting entries after that point, appends the new ones, writes them durably and acknowledges.</li><li>Once an entry from the leader's <em>current term</em> is stored on a majority (the leader counts itself), the leader advances its commit index, applies the entry to its state machine and answers the client. Followers learn the new commit index from the next AppendEntries and apply up to it.</li></ol>
<p><strong>Repairing a follower</strong>: if the consistency check fails, the follower rejects the request. The leader steps that follower's <em>nextIndex</em> back and retries until it finds the last entry they agree on, then overwrites everything after it with its own entries. Leaders never delete or overwrite their own log; logs only converge toward the leader's.</p>
<p><strong>Why the check is enough (Log Matching)</strong>: if two logs contain an entry with the same index and term, they store the same command there and are identical in every earlier entry. The consistency check preserves this inductively, so one successful AppendEntries proves the follower's whole prefix matches the leader's. That is also why Raft logs have no holes.</p>
<p><strong>The commit subtlety</strong>: a leader commits by counting replicas only for entries from its own term. An entry from an older term can sit on a majority and still be overwritten, because a later candidate whose last entry has a higher term can win an election without it (the scenario in Figure 8 of the Raft paper). Older entries become committed indirectly, once a current-term entry above them commits; that is why a new leader appends a no-op at the start of its term.</p>
<p><strong>Across elections</strong>: majority commits plus the election restriction (vote only for a candidate whose log is at least as up to date as yours) guarantee that every future leader already holds every committed entry, so committed entries are never overwritten.</p>
<p><strong>Cost</strong>: one round trip to a majority and a durable write on each of them per batch of entries. Production implementations batch and pipeline AppendEntries to raise throughput, and use snapshots (InstallSnapshot) for followers that have fallen behind the compacted log.</p>`,
      followups: [
        "Why can't a leader commit an earlier-term entry just because a majority stores it?",
        "What does a follower do with extra uncommitted entries left by a deposed leader?",
        "How does a follower that is far behind catch up after the leader has compacted its log?",
      ],
      pitfalls: [
        "Saying an entry is committed as soon as any leader sees it on a majority, regardless of its term",
        "Letting followers accept entries out of order or with gaps",
        "Acknowledging AppendEntries before the entries are durable on disk",
      ],
    },
    {
      id: "q-consensus-cluster-size",
      q: "Why do consensus clusters usually have 3 or 5 voting members rather than 4, or 50? What happens when a 4-node cluster splits 2 | 2?",
      diff: "easy",
      section: "consensus",
      a: `<p><strong>Majority math</strong>: every decision needs floor(n/2) + 1 votes, and to tolerate f crashed nodes you need 2f + 1 voters.</p>
<ul><li><strong>3 nodes</strong>: quorum 2, tolerates 1 failure.</li><li><strong>4 nodes</strong>: quorum 3, still tolerates only 1. You pay for a bigger quorum and get no extra fault tolerance.</li><li><strong>5 nodes</strong>: quorum 3, tolerates 2. The usual choice when you want to survive a failure during maintenance.</li></ul>
<p><strong>Why not 50</strong>: every write waits for a majority, so more voters mean bigger quorums, more messages, and a higher chance that a slow node lands on the critical path. Writes get slower, not faster.</p>
<p><strong>A 2 | 2 split</strong>: neither side has 3 votes, so neither can elect a leader or commit. The whole cluster stops accepting writes: safe, but unavailable. With 5 nodes, a 2 | 3 split leaves the 3-node side working.</p>
<p><strong>Scaling and placement</strong></p>
<ul><li>Scale reads with non-voting members: ZooKeeper observers, etcd learners, or follower reads.</li><li>Across three regions, place 5 voters as 2-2-1 so that losing any single region still leaves a majority of 3.</li></ul>`,
      followups: [
        "How do you add or replace a member safely?",
        "Where would you place 5 voters across 3 regions?",
        "What changes if you need to tolerate Byzantine nodes?",
      ],
      pitfalls: [
        "'More nodes means more fault tolerance and speed'",
        "Using an even number of voters",
        "Forgetting that a partitioned minority must stop accepting writes",
      ],
    },

    // ---- coordination-services ----
    {
      id: "q07",
      q: "Why do systems like ZooKeeper and etcd exist?",
      diff: "medium",
      section: "coordination-services",
      a: `<p>Every distributed system needs reliable answers to a few questions: who is the leader, which node owns partition 7, which nodes are alive, what is the current configuration. Each is a consensus problem, and implementing consensus correctly is famously hard. Coordination services package it once, on a small 3- or 5-node cluster that thousands of clients share.</p>
<p><strong>The four features that matter</strong></p>
<ul><li><strong>Linearizable atomic operations</strong>: compare-and-set, so only one of several concurrent lock attempts succeeds.</li><li><strong>Total ordering</strong>: every write gets a monotonically increasing ID (ZooKeeper zxid, etcd revision), usable as a <strong>fencing token</strong>.</li><li><strong>Failure detection</strong>: clients hold sessions with heartbeats; when a session expires, its <strong>ephemeral nodes</strong> (such as the lock it held) are deleted automatically.</li><li><strong>Change notifications</strong>: watches tell clients when a leader disappears or a node joins, without polling.</li></ul>
<p>Built on these: leader election, locks and leases, partition assignment and rebalancing, membership, configuration, and sometimes service discovery (which doesn't strictly need consensus; DNS has done it for decades).</p>
<p><strong>Design rules</strong></p>
<ul><li>Keep only <strong>slow-changing</strong> data there (who leads partition 7), not per-request application state.</li><li>ZooKeeper writes are linearizable but its <strong>reads may be stale</strong>; call sync() first when you need the latest value. etcd reads are linearizable by default.</li><li>A lock is a lease: a paused holder may not know it expired, so the protected resource must check fencing tokens.</li></ul>
<p><strong>Who uses them today</strong>: Kubernetes keeps all cluster state in etcd and drives controllers from watches. HBase and HDFS NameNode HA use ZooKeeper; ClickHouse Keeper is a Raft-based, ZooKeeper-compatible replacement. Kafka <em>used</em> ZooKeeper for controller election and metadata, but KRaft replaced it (production-ready in 3.3, 2022; ZooKeeper removed in 4.0, 2025).</p>`,
      followups: [
        "How would you implement leader election with it?",
        "Why only 3 or 5 voting nodes when thousands of clients use it?",
        "What would go wrong if you stored high-churn data in ZooKeeper?",
      ],
      pitfalls: [
        "Storing high-churn application data in ZooKeeper",
        "Saying Kafka uses ZooKeeper (present tense)",
        "Assuming ZooKeeper reads are linearizable by default",
      ],
    },
    {
      id: "q-leader-election-coordination",
      q: "Implement leader election for a fleet of worker processes using ZooKeeper or etcd. What can still go wrong?",
      diff: "medium",
      section: "coordination-services",
      a: `<p><strong>ZooKeeper recipe</strong> (Apache Curator's LeaderLatch and LeaderSelector package it):</p>
<ol><li>Each worker opens a session and creates an <em>ephemeral sequential</em> znode, such as /election/n_0000000017.</li><li>It lists the children; the lowest sequence number is the leader.</li><li>Every other worker watches the znode <em>immediately before its own</em>, not the leader's, so a change wakes one process instead of all of them (no herd effect). It must handle the predecessor vanishing between the list and the watch by re-checking.</li><li>When the leader dies or its session expires (no heartbeats within the session timeout), ZooKeeper deletes its ephemeral znode; the next worker's watch fires, it re-checks the children and takes over.</li></ol>
<p><strong>etcd recipe</strong>: grant a lease with a TTL and keep it alive with heartbeats; create a key under the election prefix attached to that lease; the candidate whose key has the lowest create revision leads, and each other candidate waits for the key just before its own to be deleted. The Go client's concurrency package implements this as Election (Campaign, Resign, Observe).</p>
<p><strong>What can still go wrong</strong></p>
<ul><li><strong>The zombie leader</strong>: a leader paused by GC or VM migration doesn't know its session or lease expired. Another worker is elected and both act. ZooKeeper and etcd can't stop the paused process. Fix: the leader attaches a <strong>fencing token</strong> (its znode's zxid, or the key's etcd revision) to every write, and the storage rejects tokens lower than the highest it has seen (ch8).</li><li><strong>Timeout tuning</strong>: a short session timeout means fast failover but false positives from GC pauses and network blips (flapping leadership); a long one means longer outages after a real crash.</li><li><strong>Stale views</strong>: a ZooKeeper server may serve an outdated child list; sync() first when it matters.</li><li><strong>The coordination cluster itself</strong> needs a majority. If it loses quorum, nobody can be elected, and a careful leader should stop acting once it loses its connection.</li></ul>
<p>If the work tolerates brief overlap (as Kubernetes' client-go leader election explicitly assumes), fencing may be unnecessary. For anything that writes to shared storage, it's mandatory.</p>`,
      followups: [
        "How does the storage layer reject a stale leader?",
        "What session timeout would you choose and why?",
        "Why not just use a Redis key with a TTL?",
      ],
      pitfalls: [
        "Treating 'I hold the lock' as proof of exclusive access without fencing",
        "Every candidate watching the leader node (herd effect)",
        "Using a single-node Redis SETNX + TTL lock for correctness-critical work",
      ],
    },
  ],
});
