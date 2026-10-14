// Chapter 5: Replication
// Authoring guide: docs/AUTHORING.md
DDIA.registerChapter({
  id: "ch5",
  part: 2,
  number: 5,
  title: "Replication",
  tagline: "Copies keep data alive and close to users; the real subject is every way those copies can disagree, and what to do about it.",
  overview: `<p><strong>Replication</strong> means keeping a live copy of the same data on several machines, for three reasons: copies near users cut <strong>latency</strong>, copies on separate hardware keep the system <strong>available</strong> when a node or datacenter dies, and more copies serve more <strong>reads</strong>. Copying data that never changes is trivial. The whole chapter is about <em>changes</em>: every replica must apply every write, which is also why replication never scales writes and never replaces a backup (<a href="#/ch5/learn/why-replicate">why replicate</a>).</p>
<p>The central tension is <strong>when to tell the client "OK"</strong>. Waiting for other replicas makes a write durable and the copies agree, but one slow or unreachable node then stalls everyone. Not waiting is fast and always available, but the copies disagree for a while: followers lag, acknowledged writes can vanish in a failover, and two places can accept conflicting writes. Every design in the chapter is a position on that dial, plus a plan for living with the disagreement it allows.</p>
<p>The ideas build in three steps. <strong>Single-leader</strong> replication lets one node order all writes, and then has to deal with sync vs async, <a href="#/ch5/learn/node-outages">failover</a>, log formats and the <a href="#/ch5/learn/replication-lag">replication-lag anomalies</a> (read-your-writes, monotonic reads, consistent prefix). <strong>Multi-leader</strong> relaxes "one writer" for multi-region and offline use and so creates <a href="#/ch5/learn/write-conflicts">write conflicts</a>. <strong>Leaderless</strong> drops the leader entirely in favor of <a href="#/ch5/learn/leaderless-quorums">quorums</a> (w + r &gt; n), then learns their <a href="#/ch5/learn/quorum-limits">limits</a>. The chapter ends with the general tool behind all conflict handling: <a href="#/ch5/learn/concurrent-writes">tracking causality</a> with version vectors, siblings and CRDTs instead of trusting clocks. Partitioning (<a href="#/ch6/learn/why-partition">Chapter 6</a>), unreliable clocks (<a href="#/ch8/learn/ordering-by-timestamps">Chapter 8</a>) and consensus (<a href="#/ch9/learn/consensus">Chapter 9</a>) pick up the threads left here.</p>`,

  // ------------------------------------------------------------------
  // CONCEPTS (teaching order, grouped by deep-dive section)
  // ------------------------------------------------------------------
  concepts: [
    // --- why-replicate ---
    {
      id: "why-replicate",
      term: "Why replicate?",
      def: `Keep a live copy of the same data on several machines and continuously apply every change to each. There are three reasons: (1) <strong>lower latency</strong>, because a replica can sit close to users; (2) <strong>higher availability</strong>, because the system keeps working when a node or a whole datacenter fails; (3) <strong>more read throughput</strong>, because many machines can serve reads. The chapter assumes every node holds the whole dataset. When it doesn't fit, you also partition (Chapter 6) and replicate each partition.`,
      problem: `One machine is one failure domain, one location and one machine's read capacity. When its disk dies the service dies with it, users on another continent pay a cross-ocean round trip on every request, and restoring a nightly backup takes hours and loses up to a day of writes.`,
      why: `Copying static data is easy. The hard part is propagating <em>changes</em>, and single-leader, multi-leader and leaderless replication are three answers to that. <strong>Replication does not scale writes</strong> (every replica applies every write) and <strong>is not a backup</strong>, because a bad <code>DELETE</code> reaches every replica within milliseconds.`,
      ex: `MediaWiki (Wikipedia) sends most reads to MySQL/MariaDB replicas of each primary: classic read scaling. Amazon Aurora keeps six copies of every page across three Availability Zones (write quorum 4/6, read quorum 3/6), so it keeps writing after losing a whole AZ. GitLab (January 2017) lost about six hours of data after a primary's data directory was deleted by mistake. Its replicas couldn't help, and several backup mechanisms turned out not to work.`,
      section: "why-replicate",
    },

    // --- leaders-and-followers ---
    {
      id: "single-leader-replication",
      term: "Single-leader replication",
      def: `One replica, the <strong>leader</strong> (primary, master), accepts all writes and appends them to a replication log. The <strong>followers</strong> (replicas, secondaries, standbys) apply that log in the same order. Clients may read from any replica but write only to the leader.`,
      problem: `If every replica accepted writes on its own, replicas could apply the same updates in different orders and silently diverge. One node has to define the order.`,
      why: `Because the leader serializes all writes, there are no write conflicts and every follower's log is a prefix of the leader's, which keeps reasoning simple. You pay for it in three ways: all writes funnel through one node in one region, followers lag behind, and when the leader dies someone has to fail over safely.`,
      ex: `PostgreSQL streaming replication, MySQL binlog replication, Oracle Data Guard, SQL Server Always On availability groups and MongoDB replica sets all work this way. So does every Kafka partition: one leader broker, and followers fetch from it. Raft-based systems such as etcd, or each range in CockroachDB, are also single-leader; the difference is that a majority vote elects the leader.`,
      section: "leaders-and-followers",
    },
    {
      id: "synchronous-vs-asynchronous-replication",
      term: "Synchronous vs asynchronous replication",
      def: `<strong>Synchronous</strong>: the leader reports success only after a follower confirms it has the write. <strong>Asynchronous</strong>: the leader reports success as soon as the write is durable locally, and followers catch up in the background.`,
      problem: `The leader must decide when to say OK. Waiting for followers costs latency and availability; not waiting risks losing writes the client was told were saved.`,
      why: `With <strong>fully synchronous</strong> replication, one slow follower slows every write and one dead follower stops them all. <strong>Asynchronous</strong> replication is very common, especially with many or remote followers: it is fast and the leader never blocks, but acknowledged writes can be lost on failover. <strong>Semi-synchronous</strong> replication is the usual middle ground. Products differ in the details. PostgreSQL blocks commits when no synchronous standby is available, while MySQL semi-sync silently falls back to async after a timeout. In PostgreSQL, <code>synchronous_commit = on</code> means the standby has <em>flushed</em> the WAL, not that a read there will see the write. Only <code>remote_apply</code> guarantees that.`,
      ex: `PostgreSQL: <code>synchronous_standby_names</code> plus <code>synchronous_commit</code>. MySQL: the semi-sync plugin. Amazon RDS Multi-AZ (classic) replicates synchronously to a standby in another AZ. Kafka's producer <code>acks</code> is the same dial: <code>acks=1</code> is effectively asynchronous replication, <code>acks=all</code> waits for the in-sync replicas.`,
      section: "leaders-and-followers",
    },
    {
      id: "semi-synchronous-replication",
      term: "Semi-synchronous replication",
      def: `One follower is synchronous and the others are asynchronous. If the synchronous follower fails or slows down, another follower is made synchronous, so every acknowledged write exists on at least two nodes. <strong>MySQL's "semi-sync" is different</strong>: it waits for an ack from any replica and falls back to asynchronous after a timeout (10 s by default).`,
      problem: `Fully synchronous replication lets one slow or dead follower stall every write, and fully asynchronous replication can lose acknowledged writes. Semi-sync guarantees two durable copies without depending on any particular follower.`,
      why: `It gets the durability of "two copies before OK" without letting one specific follower hold writes hostage. Always say which semi-sync you mean. MySQL's version bounds latency rather than guaranteeing durability: after its timeout it acknowledges writes that exist only on the leader.`,
      ex: `In PostgreSQL, <code>synchronous_standby_names = 'FIRST 1 (s1, s2)'</code> is the book's semi-sync: s2 becomes synchronous if s1 disappears. <code>'ANY 1 (s1, s2)'</code> (quorum commit, PostgreSQL 10+) waits for whichever standby answers first. MySQL's lossless semi-sync (<code>AFTER_SYNC</code>, the default wait point since 5.7) waits for one replica ack, then reverts to async after <code>rpl_semi_sync_master_timeout</code> (renamed <code>rpl_semi_sync_source_timeout</code> in 8.0.26).`,
      section: "leaders-and-followers",
    },

    // --- node-outages ---
    {
      id: "new-follower-setup",
      term: "Setting up a new follower",
      def: `Take a consistent snapshot of the leader without locking it, and note the exact log position it corresponds to (a PostgreSQL LSN, MySQL binlog coordinates or a GTID set). Restore the snapshot on the new node, then stream every change after that position until the follower has caught up.`,
      problem: `Copying data files while writes continue produces an inconsistent copy, torn across time. Locking the database for the hours a copy takes means downtime.`,
      why: `The snapshot's log position is the seam between the copied data and the streamed changes. The leader must still have its log from that position onward. If it has already discarded that part, the new follower can never catch up and has to be re-seeded. Take the copy from an existing replica, or throttle it, so the leader isn't hurt, and only add the replica to the read pool once its lag is near zero.`,
      ex: `pg_basebackup (PostgreSQL), Percona XtraBackup and the MySQL 8.0.17+ CLONE plugin, MongoDB initial sync. GitLab's January 2017 incident started here. A lagging replica needed WAL the primary had already removed, so engineers had to re-seed it with pg_basebackup, and during that work the primary's data was deleted by mistake.`,
      section: "node-outages",
    },
    {
      id: "catch-up-recovery",
      term: "Catch-up recovery",
      def: `A follower that crashed or was disconnected knows the last log position it applied. On restart it asks the leader for everything after that position. This only works while the leader still retains that part of the log (replication slots, <code>wal_keep_size</code>, the oplog window).`,
      problem: `Followers restart constantly: crashes, reboots, upgrades. Re-copying the whole dataset each time would be slow and expensive.`,
      why: `A follower restart is routine and cheap, but only if the log is retained, and retaining it costs something. A PostgreSQL replication slot pins WAL until the replica consumes it, so a replica that disappears can fill the primary's disk. A short retention window (<code>wal_keep_size</code>, or a small oplog) forces a full re-sync instead.`,
      ex: `PostgreSQL standbys resume streaming from their last replayed LSN, and MySQL replicas from their binlog coordinates or GTID set. A MongoDB secondary that falls off the end of the primary's oplog becomes stale and needs a fresh initial sync.`,
      section: "node-outages",
    },
    {
      id: "failover",
      term: "Failover",
      def: `Replacing a failed leader, manually or automatically, in three steps. (1) <strong>Detect</strong> the failure, almost always by a heartbeat <strong>timeout</strong>, because nothing can tell a crashed leader from a paused or unreachable one (the book's example timeout is 30 s). (2) <strong>Choose</strong> a new leader, ideally the most up-to-date replica, by election or by a controller node; getting every node to agree is a consensus problem (Chapter 9). (3) <strong>Reconfigure</strong> clients to send writes to the new leader, and make sure the old leader becomes a follower if it comes back.`,
      problem: `A dead leader means no writes. Someone must detect it, choose a successor and redirect clients, quickly but without losing data.`,
      why: `What goes wrong, and why some teams prefer manual failover:<ul><li><strong>Lost writes</strong>: with async replication the new leader may lack the old leader's last acknowledged writes, which are usually discarded.</li><li><strong>Disagreeing systems</strong>: anything outside the database that saw those writes no longer matches. In GitHub's 2012 incident, a promoted, out-of-date MySQL follower reissued auto-increment keys that were also used in Redis, and some private data was shown to the wrong users.</li><li><strong>Split brain</strong>: the old leader keeps accepting writes.</li><li><strong>Timeout tuning</strong>: too long means a long outage; too short means needless failovers during load spikes, which make an overloaded system worse.</li></ul>`,
      ex: `Patroni elects a PostgreSQL primary through etcd, Consul, ZooKeeper or Kubernetes, and can refuse to promote a replica lagging more than <code>maximum_lag_on_failover</code>. MongoDB replica sets call an election after <code>electionTimeoutMillis</code> (10 s by default) and roll back unreplicated writes on the old primary. Kafka elects a new partition leader from the in-sync replicas. GitHub (October 2018): a 43-second loss of connectivity led Orchestrator to promote West Coast primaries, and reconciling the writes on both sides cost 24 hours 11 minutes of degraded service.`,
      section: "node-outages",
    },
    {
      id: "split-brain",
      term: "Split brain",
      def: `Two nodes both believe they are the leader and both accept writes. The result is two diverging histories that single-leader replication has no rule to reconcile. It is prevented by fencing (STONITH, fencing tokens) and majority-based leader election.`,
      problem: `Failure detection relies on timeouts, which can't tell a dead leader from a paused or unreachable one. So a follower may be promoted while the old leader is still alive and serving clients.`,
      why: `Majority election (Raft, Paxos, or a coordination service) ensures at most one leader per term, because two majorities always overlap. But a deposed leader can still act until it learns it was replaced, so storage must also reject it: <strong>leases</strong> and <strong>fencing tokens</strong> (Chapter 8). STONITH ("shoot the other node in the head") is a cruder safety catch, and if poorly designed it can shut down both nodes.`,
      ex: `Before 7.0, Elasticsearch needed <code>discovery.zen.minimum_master_nodes</code> set to a majority of master-eligible nodes, or a partition could elect two masters. 7.0 (2019) manages that quorum automatically. In GitHub's October 2018 incident, both coasts ended up holding writes the other lacked. ZooKeeper, etcd and Consul exist largely to provide split-brain-safe leader election.`,
      section: "node-outages",
    },

    // --- replication-logs ---
    {
      id: "replication-log-types",
      term: "Replication log types",
      def: `There are four ways to ship changes. <strong>Statement-based</strong>: followers re-run each INSERT/UPDATE/DELETE. <strong>Write-ahead log (WAL) shipping</strong>: send the storage engine's low-level log of which bytes changed in which pages. <strong>Logical (row-based)</strong>: send per-row change records that don't depend on the storage format. <strong>Trigger-based</strong>: at the application level, triggers or an external tool capture changes and apply them elsewhere.`,
      problem: `Followers must replay exactly what the leader did. The format you choose decides whether replay is deterministic, how tightly versions are coupled, and whether other systems can read the log.`,
      why: `<strong>Statement-based</strong> breaks in three ways. Nondeterministic functions are one (the book uses NOW() and RAND(); MySQL fixes NOW() by logging the statement's timestamp, but <code>UUID()</code>, <code>SYSDATE()</code> and <code>UPDATE … LIMIT</code> without ORDER BY remain unsafe). Statements that depend on existing data or auto-increment are another, because they must run in exactly the same order everywhere. Side effects from triggers and UDFs are the third. <strong>WAL shipping</strong> replays exactly but ties followers to the same storage format and major version. <strong>Logical</strong> logs decouple versions and engines and double as a change feed (CDC, Chapter 11). <strong>Trigger-based</strong> replication is the most flexible and the most prone to overhead and bugs.`,
      ex: `VoltDB uses statement-based replication safely by allowing only deterministic transactions. MySQL offers <code>binlog_format</code> STATEMENT/MIXED/ROW (ROW is the default since 5.7.7). PostgreSQL streaming replication and Oracle redo shipping are physical. PostgreSQL logical replication and the MongoDB oplog are logical. Bucardo, Databus and Slony-I use triggers, and Oracle GoldenGate reads the database log.`,
      section: "replication-logs",
    },
    {
      id: "logical-replication",
      term: "Logical (row-based) replication log",
      def: `A replication log that records changes at row granularity: all column values for an insert, the row's key for a delete, and the key plus new values for an update, followed by a commit record. It doesn't depend on the storage engine's on-disk format. Examples: MySQL ROW binlog, PostgreSQL logical decoding/replication, MongoDB's oplog.`,
      problem: `Replaying SQL statements is nondeterministic, and shipping the physical WAL ties followers to the exact storage format and version. That blocks zero-downtime upgrades and external consumers.`,
      why: `Because the log describes rows rather than bytes, a follower can run a different major version or storage engine, which enables near-zero-downtime upgrades and migrations. Outside systems can consume the same log: warehouses, caches, search indexes and audit trails (change data capture). The costs: a bulk UPDATE becomes one record per row, tables need a primary key (or full old-row images, PostgreSQL <code>REPLICA IDENTITY FULL</code>), and PostgreSQL's built-in logical replication does not replicate DDL, so schema changes are applied separately.`,
      ex: `PostgreSQL added logical decoding in 9.4 and built-in publish/subscribe logical replication in 10, and teams use it for major-version upgrades. MongoDB's oplog entries are idempotent: an <code>$inc</code> is recorded as the resulting <code>$set</code>. Debezium streams MySQL binlog and PostgreSQL logical decoding into Kafka.`,
      section: "replication-logs",
    },

    // --- replication-lag ---
    {
      id: "replication-lag",
      term: "Replication lag",
      def: `The delay between a write being applied on the leader and on a given follower. Normally it is a fraction of a second. It grows to seconds or minutes when the system is near capacity, a follower is recovering, or the network is in trouble. Measure it as the leader's log position minus the follower's replayed position.`,
      problem: `Read scaling requires asynchronous followers, so a read can hit a replica that hasn't applied a recent write yet.`,
      why: `Lag is invisible until a read lands on a follower that is behind the reader's own history. Then users see impossible things: their write is missing, data goes backwards, or an effect appears before its cause. The honest design question is "what if lag reaches minutes?" Pretending async replication is synchronous is how these bugs ship.`,
      ex: `PostgreSQL's <code>pg_stat_replication</code> shows sent/write/flush/replay LSNs and, since version 10, <code>write_lag</code>/<code>flush_lag</code>/<code>replay_lag</code>. MySQL's <code>Seconds_Behind_Source</code> can mislead (0 while the receiver thread is behind, NULL when replication has stopped), so teams measure with a heartbeat table (pt-heartbeat). Load balancers drop replicas beyond a lag bound from the read pool.`,
      section: "replication-lag",
    },
    {
      id: "eventual-consistency",
      term: "Eventual consistency",
      def: `If writes stop, all replicas eventually converge to the same value. It promises nothing about how long that takes or what readers see in the meantime.`,
      problem: `Asynchronous followers are needed for read scaling and availability, so applications needed a name (and a warning) for "replicas may temporarily disagree".`,
      why: `It is a promise with no deadline and no constraint on what readers see in the meantime. That is why the chapter goes on to define stronger guarantees per user (read-your-writes, monotonic reads, consistent prefix). The book credits the term to Douglas Terry et al. and its popularization to Werner Vogels.`,
      ex: `Amazon DynamoDB reads are eventually consistent unless you request a strongly consistent read, which costs twice the read capacity. Amazon S3 became strongly read-after-write consistent in December 2020. Azure Cosmos DB offers "Eventual" as the weakest of its five consistency levels.`,
      section: "replication-lag",
    },
    {
      id: "read-your-writes-consistency",
      term: "Read-your-writes consistency",
      def: `Also called read-after-write consistency: after users submit a write, their own later reads reflect it (or something newer). It promises nothing about other users' writes.`,
      problem: `Users who submit data and can't see it on reload assume it was lost, then resubmit or complain.`,
      why: `Every fix is about routing reads. <ul><li>Read data the user can edit (their own profile) from the leader.</li><li>Read from the leader for a window after the user's last write, longer than p99 lag.</li><li>Have the client remember the <strong>log position</strong> (LSN/GTID) of its last write, and only use replicas that have replayed past it, otherwise waiting or falling back to the leader. Prefer this to wall-clock timestamps, which depend on clock sync.</li><li><strong>Across devices</strong>, a position remembered on the phone doesn't help the laptop, so store the last-write position centrally per user, and route all of a user's devices to the same region if leader reads are needed.</li></ul>`,
      ex: `Rails 6 sends a session's reads to the primary for a configurable delay after it writes (its example uses 2 s). MongoDB causally consistent sessions (3.6) and Cosmos DB Session consistency pass a token with each request. MediaWiki's ChronologyProtector waits for a replica that has caught up to the user's write position. PostgreSQL <code>synchronous_commit = remote_apply</code> makes reads on a synchronous standby include the write, at the cost of write latency. Facebook's memcache "remote markers" are set per key and per region: they send cache misses for a recently written key to the master region.`,
      section: "replication-lag",
    },
    {
      id: "monotonic-reads",
      term: "Monotonic reads",
      def: `Users who have seen data as of some point never later see an older state: successive reads don't go backwards in time. It is weaker than strong consistency and stronger than eventual consistency.`,
      problem: `Successive reads that hit replicas with different amounts of lag make data appear and then vanish.`,
      why: `The usual fix is to send each user's reads to the same replica, chosen by a hash of the user ID rather than at random. If that replica fails, reroute and accept one possible jump. <strong>Pinning gives monotonic reads, not fresh reads</strong>: a user pinned to a lagging follower sees stale data, just never older than before. It is <strong>independent of read-your-writes, not a weaker version of it</strong>: a pinned user may still miss their own write.`,
      ex: `Sticky replica routing by user ID. MongoDB causal sessions and Cosmos DB Session consistency bundle monotonic reads with read-your-writes, following Terry et al.'s 1994 "session guarantees". The replication-lag visualization pins to the slow follower on purpose to show the difference.`,
      section: "replication-lag",
    },
    {
      id: "consistent-prefix-reads",
      term: "Consistent prefix reads",
      def: `If a sequence of writes happens in a certain order, anyone reading them sees them in that order. A reader may be behind and see only a prefix, but never a later write without the earlier writes it depends on.`,
      problem: `In partitioned databases, partitions replicate independently, so causally related writes can become visible out of order.`,
      why: `Kleppmann illustrates it with a <em>fictional</em> exchange between Mr. Poons and Mrs. Cake. He asks how far into the future she can see, and she says about ten seconds, usually. If the answer is stored on a partition that replicates faster than the question's, an observer sees the reply before the question was asked. A single log applied in order gives consistent prefix for free, so this is mainly a <strong>partitioned-database</strong> problem.`,
      ex: `One fix is to write causally related data to the same partition. Kafka guarantees order only within a partition, so related events must share a key. The other is to track causal dependencies explicitly (happens-before here, causal consistency in Chapter 9). Cosmos DB offers "Consistent prefix" as a named consistency level.`,
      section: "replication-lag",
    },

    // --- multi-leader ---
    {
      id: "multi-leader-replication",
      term: "Multi-leader replication",
      def: `More than one node accepts writes. Each leader applies writes locally and forwards them asynchronously to the others, so <strong>each leader is also a follower of the other leaders</strong>. Also called master-master or active/active. The typical setup has one leader per datacenter, with normal single-leader replication inside each.`,
      problem: `A single leader forces every remote write across the inter-datacenter link and needs cross-region failover. It also can't accept writes from offline devices.`,
      why: `What you gain: writes are processed locally, so inter-datacenter latency is hidden; each datacenter keeps working if another fails, with no cross-region failover; and a flaky link between datacenters only delays replication. What you pay: <strong>write conflicts</strong>, plus surprises with auto-increment keys, triggers and constraints in retrofitted implementations. It is rarely worth it within a single datacenter. Offline clients are the extreme case: every device is a leader whose replication lag can be hours or days.`,
      ex: `DynamoDB global tables, Cosmos DB multi-region writes, CouchDB/PouchDB offline sync, BDR / EDB Postgres Distributed, Oracle GoldenGate, Tungsten Replicator (MySQL). Two things that are <em>not</em> multi-leader in this sense: Spanner, CockroachDB and YugabyteDB accept writes in any region but route each one to its range's single consensus leader, and Galera / MySQL Group Replication multi-primary certify each transaction synchronously. Neither reconciles asynchronously.`,
      section: "multi-leader",
    },
    {
      id: "multi-leader-topologies",
      term: "Multi-leader topologies",
      def: `The graph along which leaders forward writes: <strong>circular</strong> (each to the next), <strong>star</strong> (a root forwards to all others) or <strong>all-to-all</strong> (every leader to every other). In circular and star topologies a write passes through intermediate nodes, so it is tagged with the IDs of the nodes it has visited to prevent infinite loops (MySQL uses server IDs). In all-to-all, messages over links of different speeds can overtake each other, for example an update arriving before the insert it modifies. Timestamps can't fix that; causal tracking such as version vectors can.`,
      problem: `With more than two leaders, writes must be forwarded along some graph, and every graph has failure or ordering problems.`,
      why: `In circular and star topologies, one failed node interrupts replication for others until someone reconfigures, often by hand. All-to-all is more fault tolerant but needs causal ordering. Many implementations handle this poorly: the book notes that at the time BDR did not provide causal ordering and Tungsten did not detect conflicts. Read the docs and test with partitions.`,
      ex: `MySQL historically supported only circular topology for multi-leader setups (book). In CouchDB, each replication is a one-way push or pull between two databases, so you can build any graph, including all-to-all.`,
      section: "multi-leader",
    },

    // --- write-conflicts ---
    {
      id: "write-conflicts",
      term: "Write conflicts",
      def: `Two leaders each accept a write to the same record before seeing the other's. Both clients are told the write succeeded, and the conflict is only discovered later, asynchronously, when the replication messages cross.`,
      problem: `Two leaders accept concurrent writes to the same record and each tells its client OK. The conflict only surfaces later, when nobody is around to ask.`,
      why: `With a single leader, the second writer would block or abort. Making multi-leader conflict detection synchronous would throw away the reason for having multiple leaders. Not every conflict is obvious. Two leaders that insert <em>different</em> rows booking the same meeting room for the same time break an invariant without any row-level conflict (write skew, Chapter 7).`,
      ex: `A wiki page is titled A. Alice sets it to B in Europe while Bob sets it to C in the US. If each leader applies whatever arrives last, Europe ends with C and the US with B, permanently. Bayou (Xerox PARC, 1995) used the room-booking example and attached a dependency check and a merge procedure to every write.`,
      section: "write-conflicts",
    },
    {
      id: "conflict-avoidance",
      term: "Conflict avoidance",
      def: `Route all writes for a given record through the same leader, for example the user's home datacenter. That record then behaves as if it were single-leader, and conflicts on it can't occur. It breaks down when the designated leader has to change.`,
      problem: `Resolving conflicts after the fact is hard and often loses data. The simplest conflict to handle is one that never happens.`,
      why: `It is the most commonly recommended strategy because it turns a multi-leader system back into single-leader per record. It breaks when the record's home has to move (datacenter failure, a user relocating). At that point concurrent writes become possible again, so you still need a resolution rule as a fallback.`,
      ex: `Each user has a home region that handles their writes, and other regions forward to it. Uniqueness constraints such as usernames are usually handled this way too: every claim for a name goes to one place.`,
      section: "write-conflicts",
    },
    {
      id: "conflict-resolution-strategies",
      term: "Conflict resolution strategies",
      def: `Ways to make all replicas converge on the same value:<ul><li><strong>Last write wins</strong>: the highest timestamp or ID wins.</li><li><strong>Replica-ID precedence</strong>: writes from the higher-numbered replica win.</li><li><strong>Merge</strong> the values (e.g., "B/C").</li><li><strong>Record the conflict and resolve it later</strong> in application code, or by asking the user.</li><li>Merge automatically with <strong>CRDTs</strong> or <strong>operational transformation</strong>.</li><li>Run a <strong>custom handler</strong> either <strong>on write</strong> (in the background, as soon as a conflict shows up in the replication stream) or <strong>on read</strong> (all versions are stored and returned to the next reader, who writes back a resolution).</li></ul>`,
      problem: `Without a shared deterministic rule, replicas that saw conflicting writes in different orders never converge.`,
      why: `Converging is not the same as keeping data. LWW and replica precedence silently discard acknowledged writes. Resolution usually works per row or document, not per transaction, so a multi-row transaction can end up half kept.`,
      ex: `Bucardo lets you write conflict handlers in Perl, run on write. CouchDB deterministically picks a winning revision but keeps the losers in <code>_conflicts</code> for the application to merge on read. Cosmos DB defaults to LWW on a timestamp or numeric property, or runs a custom merge stored procedure. DynamoDB global tables use LWW in their original multi-Region eventually consistent mode.`,
      section: "write-conflicts",
    },
    {
      id: "operational-transformation",
      term: "Operational transformation (OT)",
      def: `A conflict-resolution technique for concurrent edits to ordered sequences such as text. Each operation is transformed against concurrent ones, for example by shifting an insert's position past another user's insert, so all replicas converge. Used by Google Docs and Etherpad.`,
      problem: `Locking a document per editor is too slow for real-time collaboration, and naively applying index-based edits from different users in different orders corrupts the text.`,
      why: `In practice OT relies on a <strong>central server</strong> that puts operations in one order. Clients apply their own edits immediately, which is why it feels multi-leader, and transform incoming operations against their own unacknowledged ones. Sequence CRDTs (RGA and the types in Automerge and Yjs) solve the same problem without a central ordering server.`,
      ex: `Two users edit "Hello world". One inserts three characters at position 5 while the other concurrently inserts at position 10. On any replica that has already applied the first insert, the second must be transformed to position 13, or its text lands in the wrong place. Google described Docs' OT-based collaboration on its Drive blog in 2010.`,
      section: "write-conflicts",
    },

    // --- leaderless-quorums ---
    {
      id: "leaderless-replication",
      term: "Leaderless replication",
      def: `No node is special. The client, or a coordinator node acting on its behalf, sends each write to several replicas in parallel and each read to several replicas, and version numbers decide which reply is newest. Unlike a leader, a coordinator does not impose an order on writes. Popularized by Amazon's Dynamo paper (2007). "Dynamo-style" stores include Riak, Cassandra and Voldemort.`,
      problem: `Leader failover is a window of unavailability and possible data loss, and some applications must always accept writes. Amazon's shopping cart had to keep "add to cart" working through server and datacenter failures.`,
      why: `There is no failover: a write succeeds if enough replicas acknowledge, whichever ones they are. Waiting only for the fastest w of n hides a slow replica (Dynamo targeted the 99.9th percentile). The price: replicas that were down miss writes and must be repaired, concurrent writes are routine rather than exceptional, and consistency is probabilistic.`,
      ex: `Cassandra lets each query choose a consistency level (ONE, QUORUM, LOCAL_QUORUM, ALL, ANY and others). Riak and Voldemort are also Dynamo-style. <strong>Amazon DynamoDB is not</strong>: despite the name, it elects a leader per partition with Multi-Paxos (2022 USENIX ATC paper). Aurora uses quorum writes (4/6) in its storage layer beneath a single-writer database.`,
      section: "leaderless-quorums",
    },
    {
      id: "quorum",
      term: "Quorum (w + r > n)",
      def: `<em>n</em> is the number of replicas of a given key, placed by partitioning; it is not the cluster size. In the basic Dynamo model, requests go to all n. A write counts as successful after <em>w</em> acknowledgements, and a read waits for <em>r</em> responses. If <strong>w + r &gt; n</strong>, every read set overlaps every write set in at least one node, so at least one response carries the latest successful write.`,
      problem: `With replicas that can be down or behind, a reader needs a rule guaranteeing it contacts at least one replica that has the latest write.`,
      why: `Fault tolerance falls out of the numbers: writes survive n − w unavailable replicas and reads survive n − r. Common choices are n = 3, w = r = 2 (tolerates one down) and n = 5, w = r = 3 (tolerates two). With w = n, r = 1, reads are cheap but any node being down blocks writes. The overlap guarantee holds only <strong>under normal conditions</strong>. See limits of quorum consistency for sloppy quorums, concurrent writes and partial failures. It is not linearizability.`,
      ex: `The Dynamo paper names (N, R, W) = (3, 2, 2) as a common configuration. Cassandra QUORUM writes and reads at replication factor 3 give the same overlap. Aurora's storage uses n = 6, w = 4, r = 3 across three AZs.`,
      section: "leaderless-quorums",
    },
    {
      id: "read-repair-anti-entropy",
      term: "Read repair & anti-entropy",
      def: `Mechanisms that bring stale replicas up to date in a leaderless store. <strong>Read repair</strong>: when a read sees replies that disagree, write the newest value back to the stale replicas. <strong>Anti-entropy</strong>: a background process compares replicas and copies missing data, in no particular order and possibly with significant delay. Dynamo and Cassandra compare <strong>Merkle trees</strong> (hash trees over key ranges) so only the ranges that differ are exchanged.`,
      problem: `In a leaderless store, a replica that was down misses writes and nothing replays them in order, so it would otherwise stay stale.`,
      why: `Read repair only fixes keys that are read, and only on the replicas involved in that read. Rarely read keys need anti-entropy or they stay under-replicated. Repair also has a deadline: it must finish within the tombstone grace period, or deleted data comes back.`,
      ex: `Cassandra repairs disagreeing replicas during reads and through <code>nodetool repair</code> (Merkle trees); Cassandra 4.0 removed the probabilistic <code>read_repair_chance</code> options. Voldemort had no anti-entropy when the book was written. Cassandra operators run repair at least once every <code>gc_grace_seconds</code> (10 days by default).`,
      section: "leaderless-quorums",
    },

    // --- quorum-limits ---
    {
      id: "limits-of-quorum-consistency",
      term: "Limits of quorum consistency",
      def: `Even with w + r &gt; n, stale reads happen. Sloppy quorums, concurrent writes resolved by LWW, writes concurrent with reads, partially failed writes that are not rolled back, and replicas restored from stale copies all break the overlap argument. Quorums tune the <em>probability</em> of staleness; they don't give linearizability.`,
      problem: `Teams treated w + r &gt; n as a strong-consistency guarantee and were surprised by stale and lost data.`,
      why: `Dynamo-style stores are built for workloads that tolerate eventual consistency. Changing w and r changes the odds of a stale read, not the guarantee. You generally don't get read-your-writes, monotonic reads or consistent prefix either. Even Cassandra's synchronous read repair on QUORUM reads is not linearizable when concurrent writes are resolved by LWW. Compare-and-set needs its Paxos-based lightweight transactions.`,
      ex: `Probabilistically Bounded Staleness (Bailis et al., VLDB 2012) modeled how often Dynamo-style reads are stale for given n, r, w and latency distributions, putting a number on "eventual". Jepsen's 2013 analyses showed Riak and Cassandra configured with LWW losing acknowledged writes during partitions, while Riak with siblings or CRDTs kept them.`,
      section: "quorum-limits",
    },
    {
      id: "sloppy-quorum-hinted-handoff",
      term: "Sloppy quorum & hinted handoff",
      def: `A <strong>sloppy quorum</strong> is used when a client can't reach enough of a key's n home nodes. It still requires w acknowledgements (and r replies), but accepts them from reachable nodes outside the home set. In Dynamo, a write meant for an unreachable home node goes to the next healthy node on the key's preference list, which counts toward w and keeps a <strong>hint</strong> naming the intended node. When that node returns, <strong>hinted handoff</strong> delivers the write to it.`,
      problem: `During a partition, a client may reach plenty of nodes but not the key's n home nodes, and strict quorums would reject the writes.`,
      why: `It increases write availability, but w + r &gt; n no longer guarantees overlap, because the stand-ins may not be in the read set. So it assures <strong>durability, not fresh reads</strong>. Hints can be lost if the stand-in dies, so anti-entropy remains the backstop. The book's analogy: locked out of your house, you sleep on the neighbor's couch.`,
      ex: `On by default in Riak (book). Cassandra stores hints for down replicas for up to <code>max_hint_window</code> (3 hours by default), but hints don't count toward consistency levels, except ANY, where a write may be acknowledged with only a hint stored. That is what the book means by sloppy quorums being disabled by default in Cassandra.`,
      section: "quorum-limits",
    },

    // --- concurrent-writes ---
    {
      id: "last-write-wins",
      term: "Last write wins (LWW)",
      def: `Resolve concurrent writes by attaching a timestamp (or unique ID) to each and keeping only the largest. Replicas converge, but every other concurrent write is silently discarded, even if it was acknowledged. Clock skew can discard non-concurrent writes too.`,
      problem: `Replicas that receive concurrent writes in different orders would diverge forever unless they all pick the same winner. LWW is the cheapest deterministic rule.`,
      why: `It buys convergence at the cost of durability: only one of several acknowledged concurrent writes survives, and nobody gets an error. That is fine for caches or data where losing some updates is acceptable. The only safe way to use an LWW store is to write each key once and treat it as immutable. Cassandra recommends a UUID key per write for this reason.`,
      ex: `Cassandra resolves every regular cell by write timestamp and has no siblings. Elements of non-frozen collections are separate cells, and counters use a separate mechanism. Riak makes LWW optional. DynamoDB global tables (original multi-Region eventually consistent mode) and Cosmos DB's default conflict policy use LWW. Jepsen (2013) showed acknowledged writes lost this way under partitions.`,
      section: "concurrent-writes",
    },
    {
      id: "happens-before",
      term: "Happens-before relationship",
      def: `Operation A happens before B if B knew about A, depended on it or built on it. If neither happens before the other, they are <strong>concurrent</strong>, regardless of when they occurred in wall-clock time.`,
      problem: `To decide whether a write may overwrite another or must be kept as a conflict, a database needs causality. Timestamps can't tell "later and aware" from "later but unaware".`,
      why: `There are exactly three cases: A before B (B may overwrite A), B before A, or concurrent (a conflict to keep or merge). Concurrency is about knowledge, not physical time: two writes an hour apart are concurrent if network delays meant neither saw the other. This relation underlies version vectors here, and causal consistency and Lamport timestamps in Chapter 9.`,
      ex: `A client reads a shopping cart and then writes: its write happens after everything it read. Another client that writes without having seen that value is concurrent with it, even if its write arrives later. A reply to a message happens after the message, which is the consistent-prefix example again.`,
      section: "concurrent-writes",
    },
    {
      id: "concurrent-writes-version-vectors",
      term: "Concurrent writes / version vectors",
      def: `To decide whether a write overwrites an existing value or is concurrent with it, the store tracks versions. With <strong>one replica</strong>, a <strong>version number</strong> per key is incremented on each write. Reads return all current values plus the version. A write carries the version it was based on, and the server overwrites values at or below that version and keeps higher ones as siblings. With <strong>several replicas</strong>, a <strong>version vector</strong> holds one counter per replica. If one vector dominates (every entry ≥ and at least one &gt;), it is newer. If neither dominates, the writes are concurrent.`,
      problem: `Replicas receive concurrent writes in different orders. Overwriting on arrival never converges, and timestamps can't tell concurrent writes from sequential ones.`,
      why: `The client must send back, with its write, the version vector it read. Riak calls it the <strong>causal context</strong>. That is what tells the store which values the new write supersedes, and it makes reading from one replica and writing to another safe. Riak 2.0 uses <strong>dotted version vectors</strong> to avoid "sibling explosion". Version vectors (comparing replica state) are not quite the same as vector clocks (ordering events), although the Dynamo paper called its mechanism "vector clocks". See Chapter 9.`,
      ex: `The book's shopping cart: after five interleaved writes from two clients, the server holds siblings v4 [eggs, milk, ham] and v5 [milk, flour, eggs, bacon], and nothing is lost. A comparison: {A:2, B:1} and {A:1, B:2} are concurrent, while {A:2, B:2} dominates both.`,
      section: "concurrent-writes",
    },
    {
      id: "siblings",
      term: "Siblings",
      def: `Concurrently written values for the same key that the database keeps side by side (Riak's term) and returns together on read. The application merges them and writes the result back with the causal context it received.`,
      problem: `Picking one of several concurrent values loses data. Keeping all of them preserves every acknowledged write until a merge can happen.`,
      why: `No acknowledged write is silently dropped, but the burden moves to the application. A union merge works for adds, but removals need tombstones or the removed items reappear. Without dotted version vectors, siblings can pile up.`,
      ex: `Riak with <code>allow_mult = true</code> returns all siblings plus a causal context. CouchDB keeps losing revisions in <code>_conflicts</code>. Dynamo's shopping cart merged siblings by union and accepted that deleted items could come back.`,
      section: "concurrent-writes",
    },
    {
      id: "crdts",
      term: "CRDTs (Conflict-free Replicated Data Types)",
      def: `Data structures that replicas can update independently and merge automatically, with guaranteed convergence. <strong>State-based</strong> CRDTs merge whole states with a function that is commutative, associative and idempotent, so states can be exchanged in any order, any number of times. <strong>Operation-based</strong> CRDTs broadcast operations that commute when concurrent and must be delivered reliably in causal order. Examples: G-Counter, PN-Counter, OR-Set, LWW-Register, and sequence CRDTs (RGA and similar) for text.`,
      problem: `Merging siblings by hand in application code is error-prone: removed items reappear and counters double count. Data types that merge themselves remove that burden.`,
      why: `They are correct by construction for the semantics they encode. An <strong>OR-Set</strong> tags each add uniquely, and a remove deletes only the tags it has observed, so a concurrent add survives (add wins). Item-level tombstones would make the removal win instead. Convergent is not the same as lossless: an LWW-Register is a CRDT that still drops concurrent writes. Costs: metadata (tags, tombstones, per-replica entries) needs garbage collection, and invariants that need coordination (a balance must stay ≥ 0, usernames must be unique) can't be achieved by merging alone.`,
      ex: `Riak 2.0 data types (counters, sets, maps, registers, flags), Redis Enterprise Active-Active, Automerge and Yjs (local-first and collaborative apps), and SoundCloud's Roshi (an LWW-element-set on Redis). Figma is CRDT-<em>inspired</em> but server-authoritative, with LWW per property. It is not a true CRDT system. In the <a href="#/viz/ch5/concurrent-writes">concurrent-writes visualization</a>, set <strong>Server keeps</strong> to <strong>OR-Set CRDT</strong> and play <strong>remove vs re-add</strong>.`,
      section: "concurrent-writes",
    },
    {
      id: "tombstones",
      term: "Tombstones (deletion markers)",
      def: `Instead of simply removing data, a replica records a marker meaning "this key or item was deleted", with a version or timestamp. Merges, read repair and anti-entropy can then tell an intentional deletion from a value that hasn't arrived yet. Tombstones must be kept until every replica has seen them. Cassandra keeps them for <code>gc_grace_seconds</code> (10 days by default), and a replica not repaired within that window can resurrect deleted data.`,
      problem: `In a leaderless or multi-leader store, a replica that missed a delete still holds the value. Without a record of the deletion, a union merge or a repair process treats the other replicas' missing value as "not yet replicated" and copies the deleted data back.`,
      why: `Tombstones turn a deletion into a write that can be versioned and merged. They cost space and read time until they are purged, and purging too early resurrects data, so their lifetime is tied to how often you run repair.`,
      ex: `In Cassandra, a replica that missed a delete and isn't repaired within <code>gc_grace_seconds</code> (864,000 s) can bring deleted rows back as "zombie" data. In a shopping cart stored as siblings, a removed item without a tombstone returns on the next union merge. OR-Sets keep removed tags as tombstones that eventually need garbage collection.`,
      section: "concurrent-writes",
    },
  ],

  // ------------------------------------------------------------------
  // CHEATSHEET
  // ------------------------------------------------------------------
  cheatsheet: [
    {
      title: "Three replication architectures",
      type: "table",
      headers: ["", "Single-leader", "Multi-leader", "Leaderless"],
      rows: [
        ["Writes go to", "The leader only", "Any leader (usually one per region, or every offline device)", "Several replicas in parallel (client or coordinator)"],
        ["Who orders writes", "The leader's log (followers hold a prefix)", "No global order; each leader orders its own", "No order; version numbers/vectors per key"],
        ["Conflict handling", "None needed (writes serialized)", "Required: avoidance, LWW, merge, CRDTs", "Routine: siblings + merge, or LWW"],
        ["Failover", "Needed, and risky (lost tail, split brain)", "Per-DC failover only; no cross-DC failover", "Not needed (no leader)"],
        ["Write latency across regions", "Cross-region round trip to the leader", "Local", "Local quorum (e.g., Cassandra LOCAL_QUORUM)"],
        ["Tolerates DC outage", "Only after failing over to another region", "Yes, each DC keeps accepting writes", "Yes, if enough replicas remain for w and r"],
        ["Read freshness", "Leader reads current; follower reads lag", "Current only for writes made at that leader", "Probabilistic (w + r > n); never linearizable on its own"],
        ["Main risk", "Failover data loss, split brain", "Conflicts; LWW silently loses writes", "Stale reads; LWW data loss; repair debt"],
        ["Typical use", "Most OLTP databases, Kafka", "Multi-region active-active, offline clients, collaboration", "Always-writable, high-availability stores"],
        ["Examples", "PostgreSQL, MySQL, MongoDB, Kafka partitions, Raft stores", "CouchDB, BDR / EDB Postgres Distributed, DynamoDB global tables, Cosmos DB multi-region writes", "Dynamo (2007), Cassandra, Riak, Voldemort. Not DynamoDB (leader per partition)"],
      ],
      note: "Multi-leader in the book's sense means each region commits locally and reconciles later. Spanner, CockroachDB and YugabyteDB accept writes everywhere but route each one to a single consensus leader, so they are leader-based.",
    },
    {
      title: "Choosing a replication approach",
      type: "table",
      headers: ["If you need", "Choose", "And accept"],
      rows: [
        ["Correctness first (ledger, inventory), simple reasoning", "Single leader with majority or semi-sync commit; fenced, majority-elected failover", "Higher write latency; writes pause during an election"],
        ["Massive read scaling with tolerable staleness", "Single leader + async read replicas (+ caches)", "Replication lag; add read-your-writes for the writers"],
        ["Local writes in several regions; survive a region outage", "Multi-leader with a conflict strategy (home region, CRDTs, LWW)", "Conflicts; no cross-region uniqueness without coordination"],
        ["Offline clients or real-time collaboration", "Client-side multi-leader with CRDTs or OT", "Merge semantics to design; metadata growth"],
        ["Always-writable, append-heavy, multi-DC ingestion", "Leaderless (Cassandra, Riak) with tuned w and r", "Eventual consistency; repair operations; LWW only on write-once keys"],
        ["Linearizable compare-and-set or global uniqueness", "Consensus (Raft/Paxos): etcd, Spanner, CockroachDB, Cassandra LWT", "Majority round trips on every write"],
      ],
    },
    {
      title: "Sync vs semi-sync vs async",
      type: "table",
      headers: ["Mode", "Durability on leader loss", "Write latency", "One slow or dead follower", "Example"],
      rows: [
        ["Fully synchronous (all followers)", "No acknowledged write lost", "Leader + slowest follower's round trip", "Slow: every write slows. Dead: all writes block", "Rarely used for every follower"],
        ["Semi-sync (book): one sync, re-designated on failure", "Every acked write on at least 2 nodes", "Leader + one follower's round trip", "Another follower becomes synchronous", "PostgreSQL <code>synchronous_<wbr>standby_<wbr>names = 'FIRST 1 (s1, s2)'</code>"],
        ["Quorum commit: wait for any k followers", "Acked writes on at least k + 1 nodes", "The k-th fastest follower", "Hidden while k others respond", "PostgreSQL 'ANY 1 (s1, s2)'; Raft majority; MongoDB w:majority"],
        ["MySQL semi-sync", "On 2 nodes, until it silently falls back", "Leader + fastest replica's ack", "After <code>rpl_semi_sync_<wbr>master_timeout</code> (10 s) reverts to async", "MySQL lossless semi-sync (AFTER_SYNC)"],
        ["Asynchronous", "Unreplicated tail lost on failover", "Leader only", "No effect on writes; that follower just lags", "PostgreSQL and MySQL defaults; Kafka acks=1"],
      ],
      note: "PostgreSQL never falls back: with synchronous standbys configured and none available, commits wait. Synchronous latency = leader commit + slowest round trip among the followers you wait for, so waiting for all of them exposes you to the tail (Chapter 1).",
    },
    {
      title: "PostgreSQL synchronous_commit ladder",
      type: "table",
      headers: ["Setting", "Client gets OK after", "Lost if leader dies before replication?", "Read on sync standby sees it?"],
      rows: [
        ["off", "Local WAL write, not yet flushed (async commit)", "Yes; even a local crash can lose the last few commits", "Not guaranteed"],
        ["local", "Local WAL flush only", "Yes (standby not awaited)", "Not guaranteed"],
        ["remote_write", "Standby received it and handed it to its OS (not flushed)", "No, unless the standby's OS crashes too", "Not guaranteed"],
        ["on (default)", "Standby flushed the WAL to disk", "No", "Not guaranteed (replayed later)"],
        ["remote_apply (9.6+)", "Standby replayed it", "No", "Yes"],
      ],
      note: "These levels matter only when synchronous_standby_names is set. Otherwise local, remote_write, on and remote_apply all just wait for the local flush.",
    },
    {
      title: "Failover hazards",
      type: "list",
      items: [
        "<strong>Detection is a timeout</strong>: it can't tell dead from paused, overloaded or partitioned. The book's example is 30 s; MongoDB's <code>electionTimeoutMillis</code> defaults to 10 s.",
        "<strong>Lost async tail</strong>: writes the old leader acknowledged but never replicated are discarded (MongoDB rollback, Kafka unclean leader election).",
        "<strong>External systems disagree</strong>: in GitHub's 2012 incident, a lagging follower reused auto-increment keys that were also stored in Redis, and some private data was shown to the wrong users.",
        "<strong>Split brain</strong>: two leaders accept writes. Prevent it with majority election plus fencing tokens or leases. STONITH can shut down both nodes if poorly designed.",
        "<strong>Timeout tuning</strong>: too short causes needless failovers during load spikes, which worsen the overload; too long means a long outage.",
        "<strong>Picking the successor</strong>: choose the most up-to-date replica. Refusing to promote a replica that lags too far (Patroni <code>maximum_lag_on_failover</code>) trades availability for durability.",
        "<strong>The old leader returns</strong>: it must be demoted, and its divergent tail discarded or reconciled (pg_rewind, MongoDB rollback files).",
        "<strong>Clients must move</strong>: DNS, proxies and connection pools must stop sending writes to the old leader.",
      ],
    },
    {
      title: "Replication log formats",
      type: "table",
      headers: ["Format", "What is shipped", "Pros", "Cons", "Examples"],
      rows: [
        ["<span style='white-space:nowrap'>Statement-based</span>", "SQL statements (INSERT/UPDATE/DELETE)", "Compact; human-readable", "Nondeterminism (UUID(), SYSDATE(), the book's NOW()/RAND()); order-dependent statements; trigger/UDF side effects", "VoltDB (deterministic only); MySQL before 5.1 and MIXED mode"],
        ["<span style='white-space:nowrap'>WAL shipping</span> (physical)", "The engine's own log: bytes changed in disk pages", "Exact replay; reuses an existing log", "Tied to storage format and major version (no mixed-version upgrades); unreadable by other systems; high bandwidth", "PostgreSQL streaming replication, Oracle redo"],
        ["Logical <span style='white-space:nowrap'>(row-based)</span>", "Per-row changes (insert values, delete key, update key + new values) plus a commit record", "Version- and engine-independent; feeds CDC consumers", "Bulk updates log every row; needs primary keys or full row images; DDL handled separately (PostgreSQL)", "MySQL ROW binlog (default since 5.7.7), PostgreSQL logical replication (10+), MongoDB oplog"],
        ["<span style='white-space:nowrap'>Trigger-based</span> (application)", "Changes captured by triggers into a change table (or read from the log by a tool) and applied elsewhere", "Replicate subsets, across products, with custom conflict logic", "Higher overhead; more bugs and limitations", "Bucardo, Databus, Slony-I; Oracle GoldenGate reads the log"],
      ],
    },
    {
      title: "Replication-lag anomalies and fixes",
      type: "table",
      headers: ["Guarantee", "Anomaly without it", "Fix", "Real-world implementation"],
      rows: [
        ["<span style='white-space:nowrap'>Read-your-writes</span>", "Users can't see the write they just saved", "Read user-editable data from the leader; leader for a window after a write; log-position (LSN/GTID) tokens", "Rails 6 (2 s example window), MongoDB causal sessions, Cosmos DB session tokens, MediaWiki ChronologyProtector, Facebook remote markers (per key, per region)"],
        ["Cross-device <span style='white-space:nowrap'>read-your-writes</span>", "Saved on phone, missing on laptop", "Store the last-write position per user server-side; route all of a user's devices to one region", "Central session or position store"],
        ["Monotonic reads", "Data appears, then vanishes on refresh", "Pin each user to one replica (hash of user ID); reroute on failure", "Sticky replica routing; session consistency levels"],
        ["Consistent prefix", "An answer is visible before its question", "Keep causally related writes in one partition, or track causal dependencies", "Kafka same-key partitioning; Cosmos DB Consistent prefix level"],
      ],
      note: "Pinning gives monotonic reads, not fresh reads. The guarantees are independent of each other, and products bundle them as session consistency (Terry et al., 1994).",
    },
    {
      title: "Measuring replication lag",
      type: "list",
      items: [
        "Leader-based: lag = the leader's log position minus the replica's replayed position (bytes), or the age of the last replayed commit (time).",
        "PostgreSQL: <code>pg_stat_replication</code> on the primary (sent/write/flush/replay LSN; <code>write_lag</code>, <code>flush_lag</code>, <code>replay_lag</code> since v10). On a standby: <code>pg_last_wal_replay_lsn()</code>, <code>pg_last_xact_replay_timestamp()</code>.",
        "MySQL: <code>Seconds_Behind_Source</code> (<code>Seconds_Behind_Master</code> before 8.0.22) is derived from event timestamps. It reads 0 when the receiver thread is the one behind and NULL when replication has stopped, so prefer a heartbeat row updated every second on the leader (pt-heartbeat).",
        "Bytes behind and seconds behind can disagree: an idle primary makes time-based lag look large, while a burst of big writes makes byte lag spike.",
        "Alert both on a threshold <em>and</em> on replication having stopped. Remove over-lagged replicas from the read pool.",
        "Leaderless stores have no position to subtract. Watch pending hints, read-repair rates and repair completion, and estimate staleness with PBS (Bailis et al.).",
      ],
    },
    {
      title: "Multi-leader topologies",
      type: "table",
      headers: ["Topology", "How writes flow", "If one node fails", "Ordering risk"],
      rows: [
        ["<span style='white-space:nowrap'>Circular</span>", "Each leader forwards to the next in a ring", "The ring breaks until reconfigured (often manually)", "Writes tagged with visited node IDs to stop infinite loops"],
        ["Star (tree)", "A root forwards to every other leader", "Root failure stops propagation between the others", "Same loop prevention; longer paths"],
        ["<span style='white-space:nowrap'>All-to-all</span>", "Every leader sends to every other", "The others keep replicating", "Messages overtake each other (update before insert); needs causal tracking, e.g. version vectors"],
      ],
    },
    {
      title: "Handling concurrent writes",
      type: "table",
      headers: ["Approach", "How it works", "Loses data?", "Cost / limits", "Used by"],
      rows: [
        ["Conflict avoidance", "Route each record's writes to one home leader", "No, while the home is stable", "Breaks on region failover or when a user moves", "Home-region designs"],
        ["Last write wins (LWW)", "Keep the highest timestamp (or ID)", "Yes: silently drops concurrent acked writes; clock skew can drop later ones", "Cheap; safe only for write-once, immutable keys", "Cassandra, DynamoDB global tables (original mode), Cosmos DB default"],
        ["Version vectors + siblings", "Keep concurrent values; the app merges on read and writes back", "No", "Application merge code; tombstones for removals", "Riak (allow_mult), CouchDB _conflicts"],
        ["CRDTs", "Data types with an automatic, convergent merge", "Not for their semantics (an LWW-Register still drops writes)", "Metadata growth and GC; can't enforce global invariants", "Riak data types, Redis Active-Active, Automerge, Yjs"],
        ["<span style='white-space:nowrap'>Operational</span> <span style='white-space:nowrap'>transformation</span>", "Transform concurrent edits (shift positions) in a server-defined order", "No", "Central server; tricky to get right", "Google Docs, Etherpad"],
        ["Custom handler", "Runs on write (background) or on read (app or user decides)", "Depends on the code", "Per row/document, not per transaction", "Bucardo (on write), CouchDB (on read), Cosmos DB stored procedure"],
      ],
    },
    {
      title: "Quorum math",
      type: "list",
      items: [
        "n = replicas of a given key (not the cluster size); w = acks a write needs; r = replies a read waits for.",
        "Requests go to all n; w and r are how many replies you wait for. (Cassandra optimizes reads with one data request plus digest requests.)",
        "<strong>If w + r &gt; n</strong>, read and write sets overlap, so at least one reply has the latest successful write (under normal conditions).",
        "Writes tolerate n − w unavailable replicas; reads tolerate n − r.",
        "Majority quorum: <span class=\"mono\">w = r = ⌊n/2⌋ + 1</span>. n = 3, w = r = 2 tolerates 1 failure; n = 5, w = r = 3 tolerates 2.",
        "w + r ≤ n: faster and more available, but stale reads are likely.",
        "w = n: any single node down blocks writes. r = 1: cheapest reads.",
        "Still stale even with w + r &gt; n:<ul><li>sloppy quorum (the write sits on stand-ins)</li><li>concurrent writes resolved by LWW</li><li>a write concurrent with the read</li><li>a failed write (fewer than w acks) that is not rolled back</li><li>a replica holding the new value restored from a stale copy</li></ul>",
      ],
      note: "Sloppy quorum breaks this guarantee, so use it with care. Quorums alone never give linearizability.",
    },
    {
      title: "Quorum configurations at a glance",
      type: "table",
      headers: ["n / w / r", "w + r > n?", "Writes survive", "Reads survive", "Notes"],
      rows: [
        ["3 / 2 / 2", "Yes (4 > 3)", "1 node down", "1 node down", "Balanced default (Dynamo paper; Cassandra QUORUM at RF 3)"],
        ["3 / 3 / 1", "Yes (4 > 3)", "0 nodes down", "2 nodes down", "Read-heavy; any node down blocks writes"],
        ["3 / 1 / 3", "Yes (4 > 3)", "2 nodes down", "0 nodes down", "Write-heavy; any node down blocks reads"],
        ["3 / 1 / 1", "No (2 ≤ 3)", "2 nodes down", "2 nodes down", "Lowest latency; stale reads likely (Cassandra ONE/ONE)"],
        ["5 / 3 / 3", "Yes (6 > 5)", "2 nodes down", "2 nodes down", "Tolerates two failures"],
        ["6 / 4 / 3", "Yes (7 > 6)", "2 nodes down", "3 nodes down", "Aurora storage: 2 copies in each of 3 AZs"],
      ],
    },
    {
      title: "Leaderless repair mechanisms",
      type: "table",
      headers: ["Mechanism", "What it fixes", "When it runs", "Limits"],
      rows: [
        ["Read repair", "Stale replicas that answered a read", "During reads, when replies disagree", "Only keys that are read, only the replicas involved"],
        ["Hinted handoff", "Writes a node missed while it was down", "When the node comes back", "Hints expire (Cassandra max_hint_window, 3 h) or die with the stand-in"],
        ["Anti-entropy (Merkle trees)", "Any divergence, including keys that are never read", "Background or scheduled (nodetool repair)", "No write order; expensive; must finish within gc_grace_seconds"],
      ],
    },
    {
      title: "Comparing version vectors",
      type: "note",
      body: `<p><span class="formula">A ≤ B  ⇔  A[i] ≤ B[i] for every replica i</span></p>
<ul>
<li><strong>A ≤ B and A ≠ B</strong>: B happened after A, so B may overwrite A.</li>
<li><strong>Neither A ≤ B nor B ≤ A</strong>: the writes are concurrent; keep both as siblings and merge.</li>
<li>Example: {A:2, B:1} vs {A:1, B:2} are concurrent, and {A:2, B:2} dominates both.</li>
<li>The client sends back the vector it read; the store discards exactly the values that vector covers.</li>
<li>With one replica this reduces to the book's per-key <strong>version number</strong>.</li>
</ul>`,
    },
    {
      title: "Defaults and numbers worth knowing",
      type: "list",
      items: [
        "Replication lag: normally a fraction of a second; seconds to minutes under load or network trouble.",
        "PostgreSQL streaming replication is asynchronous by default. With synchronous standbys configured, it blocks commits rather than falling back when none is available.",
        "MySQL semi-sync waits for 1 replica and falls back to async after 10 s (<code>rpl_semi_sync_master_timeout</code> = 10000 ms). AFTER_SYNC has been the default since 5.7; the variables were renamed <code>rpl_semi_sync_source_*</code> in 8.0.26.",
        "MySQL <code>binlog_format = ROW</code> has been the default since 5.7.7.",
        "MongoDB: default write concern w:majority since 5.0; causally consistent sessions since 3.6; <code>electionTimeoutMillis</code> 10 s.",
        "Kafka: producer acks=all (with idempotence) by default since 3.0; <code>unclean.leader.election.enable</code> false since 0.11.",
        "Cassandra: <code>max_hint_window</code> 3 h; <code>gc_grace_seconds</code> 864,000 s (10 days); <code>read_repair_chance</code> removed in 4.0.",
        "DynamoDB: reads are eventually consistent unless requested otherwise; a strongly consistent read costs 2x the read capacity.",
        "Amazon S3: strong read-after-write consistency since December 2020.",
        "Aurora: 6 copies across 3 AZs, write quorum 4/6, read quorum 3/6.",
        "Elasticsearch 7.0 (2019): automatic master quorum replaced <code>minimum_master_nodes</code>.",
      ],
    },
    {
      title: "Myths to unlearn",
      type: "list",
      items: [
        "<strong>Replication scales writes</strong>: no, every replica applies every write. To scale writes, partition (Chapter 6).",
        "<strong>Replicas are backups</strong>: no, they replicate a bad DELETE within milliseconds. Keep point-in-time backups and test restores.",
        "<strong>w + r &gt; n means strong consistency</strong>: no. It isn't linearizable, and several edge cases still return stale data.",
        "<strong>Synchronous replication makes follower reads fresh</strong>: PostgreSQL <code>on</code> means flushed, not applied. Only <code>remote_apply</code> guarantees it.",
        "<strong>Semi-sync guarantees two copies</strong>: MySQL's silently falls back to async after its timeout.",
        "<strong>Monotonic reads is a weaker read-your-writes</strong>: no, the two guarantees are independent.",
        "<strong>Amazon DynamoDB is Dynamo-style</strong>: no, it has one leader per partition, elected with Multi-Paxos.",
        "<strong>Kafka acks=all means all replicas</strong>: it means all <em>current</em> in-sync replicas, which can shrink to the leader alone. min.insync.replicas is what bounds durability.",
        "<strong>A sloppy quorum writes to any n reachable nodes</strong>: it still needs w acks; they may come from stand-ins outside the home set.",
        "<strong>Writes in every region means multi-leader</strong>: Spanner and CockroachDB route each write to one consensus leader.",
        "<strong>Cassandra keeps siblings</strong>: no, it resolves every regular cell by LWW.",
        "<strong>Google Docs and Figma are CRDT systems</strong>: Docs uses OT with a central server; Figma is server-authoritative with LWW per property.",
      ],
    },
  ],

  // ------------------------------------------------------------------
  // INTERVIEW (grouped by section order)
  // ------------------------------------------------------------------
  interview: [
    // --- why-replicate ---
    {
      id: "q01",
      q: "Compare single-leader, multi-leader, and leaderless replication.",
      diff: "medium",
      section: "why-replicate",
      a: `<p>Frame the comparison around one question: <strong>who may accept a write</strong>, and what does that cost?</p>
<ul>
<li><strong>Single-leader</strong>: one node orders all writes and streams its log to followers. There are no write conflicts, reasoning stays simple, and reads scale with replicas. The costs: every write goes through one node in one region, followers lag, and failover is the dangerous moment (lost async writes, split brain). Examples: PostgreSQL, MySQL, MongoDB replica sets, Kafka partitions, Raft-based stores.</li>
<li><strong>Multi-leader</strong>: several nodes, typically one per datacenter or every offline device, accept writes and replicate to each other asynchronously. Writes are local, each region survives the others' outages, and offline work is possible. The cost is <strong>write conflicts</strong>, which need a deterministic resolution (avoidance, LWW, merge, CRDTs). Examples: CouchDB, DynamoDB global tables, Cosmos DB multi-region writes, BDR.</li>
<li><strong>Leaderless</strong>: the client or a coordinator writes to several replicas in parallel and reads from several. If w + r &gt; n, the read and write sets overlap. There is no failover, and a slow node is tolerated. The costs: conflicts are routine (siblings or LWW), repair is needed, and consistency is probabilistic, not linearizable. Examples: Dynamo, Cassandra, Riak, Voldemort. <strong>Amazon DynamoDB is leader-based per partition</strong> despite the name.</li>
</ul>
<p><strong>How to choose</strong>: single-leader for most OLTP, where correctness and simplicity win. Multi-leader when writes must be local in several regions or work offline. Leaderless for always-writable workloads that tolerate eventual consistency. None of them raise write capacity beyond one node's; for that you partition (Chapter 6), and each partition is replicated by one of these schemes.</p>`,
      followups: [
        "Which would you use for multi-region writes, and how would you handle conflicts?",
        "Where does consensus (Raft/Paxos) fit among these three?",
        "Does adding replicas let you handle more writes?",
      ],
      pitfalls: [
        "Saying multi-leader removes the need for conflict handling",
        "Claiming leaderless replication with quorums is strongly consistent",
        "Calling Amazon DynamoDB a Dynamo-style leaderless store",
        "Implying that replication scales writes",
      ],
    },
    {
      id: "q-replica-vs-backup",
      q: "Your team says 'we have three replicas, so we don't need backups'. What do you tell them?",
      diff: "easy",
      section: "why-replicate",
      a: `<p><strong>Replicas and backups protect against different failures.</strong> Replication protects against losing <em>machines</em>: a node or datacenter dies, the data survives and the service stays up. It does nothing against <em>logical</em> damage, because the replication log faithfully ships every change, including the wrong ones.</p>
<ul>
<li>A bad <code>DELETE</code>, or an <code>UPDATE</code> without a <code>WHERE</code>, reaches every replica within milliseconds.</li>
<li>A buggy migration or application bug corrupts data on every copy at once.</li>
<li>An operator can run a destructive command on the wrong host. At GitLab in January 2017, about 300 GB was deleted from the primary while an engineer was trying to re-seed a replica. Several backup mechanisms turned out not to be working, and the restore came from an LVM snapshot about six hours old, losing roughly six hours of data.</li>
</ul>
<p>What they need instead:</p>
<ul>
<li><strong>Point-in-time recovery</strong>: periodic base backups plus continuously archived WAL or binlog, so you can restore to just before the mistake.</li>
<li>Backups stored in a <strong>separate failure domain</strong> (another account or region), and <strong>restores tested regularly</strong>. An untested backup is only a hope.</li>
<li>Optionally a <strong>delayed replica</strong> (PostgreSQL <code>recovery_min_apply_delay</code>, MySQL <code>SOURCE_DELAY</code>) that applies changes, say, an hour late. It gives fast recovery from recent mistakes, but it complements backups and doesn't replace them.</li>
</ul>
<p>Close by stating targets: the <strong>RPO</strong> (how much data you may lose) and <strong>RTO</strong> (how long a restore may take) that the backup design must meet.</p>`,
      followups: [
        "What is a delayed replica and when is it useful?",
        "How do you prove your backups work?",
        "What RPO does point-in-time recovery give you?",
      ],
      pitfalls: [
        "Treating replicas as backups",
        "Never testing restores",
        "Keeping backups in the same failure domain as the primary",
      ],
    },
    {
      id: "q-choose-replication",
      q: "Pick a replication approach for each: (a) a payments ledger, (b) a product catalog read by millions, (c) a collaborative whiteboard, (d) IoT sensor ingestion from many regions. Justify each.",
      diff: "medium",
      section: "why-replicate",
      a: `<p>For each case, name the approach <em>and</em> the failure you are choosing to tolerate.</p>
<ul>
<li><strong>(a) Payments ledger: single leader, majority or synchronous commit.</strong> Use a Raft-based store, or PostgreSQL with quorum commit (<code>ANY 1</code>), so every acknowledged write survives losing the leader. Serve reads that must be current from the leader, elect leaders by majority, fence the old leader, and use idempotency keys on requests. Never use LWW: silently losing a debit is unacceptable. <em>Tolerate</em>: higher write latency, and writes pausing during an election or for a minority partition.</li>
<li><strong>(b) Product catalog: single leader plus many asynchronous read replicas</strong>, with caches or a CDN in front. Lag of a few seconds doesn't matter to shoppers. Give read-your-writes only to the editors, by routing their sessions to the leader or using log-position tokens. <em>Tolerate</em>: stale reads for a few seconds.</li>
<li><strong>(c) Collaborative whiteboard: multi-leader at the client level.</strong> Every client applies its edits locally, and concurrent edits merge through CRDTs (Yjs, Automerge) or OT ordered by a server. A server-authoritative design with LWW per property, as Figma uses, is also defensible because two people rarely edit the same property of the same object at once. <em>Tolerate</em>: an occasionally overwritten property, and merge metadata.</li>
<li><strong>(d) IoT ingestion: leaderless, Dynamo-style</strong>, e.g. Cassandra with <code>LOCAL_ONE</code> or <code>LOCAL_QUORUM</code> writes in each region. Writes are always local and available. The data is append-only, with unique keys (sensor ID + timestamp), so LWW is harmless: no two writes ever target the same key. <em>Tolerate</em>: incomplete reads until repair catches up.</li>
</ul>
<p>The point the interviewer wants: there is no universally best scheme. Each choice buys something specific and gives up something specific. And anything needing global uniqueness or compare-and-set, such as the ledger's leader election, ultimately relies on consensus.</p>`,
      followups: [
        "Which of these needs a consensus system somewhere?",
        "Where would you accept stale reads?",
        "What breaks in (d) if sensors update a 'current value' key instead of appending?",
      ],
      pitfalls: [
        "Giving one-size-fits-all answers",
        "Choosing leaderless for the ledger because it is 'highly available'",
        "Ignoring that (d) is safe only because its keys are write-once",
      ],
    },

    // --- leaders-and-followers ---
    {
      id: "q02",
      q: "What's the tradeoff between synchronous and asynchronous replication?",
      diff: "easy",
      section: "leaders-and-followers",
      a: `<p>The question is <strong>when the leader tells the client "OK"</strong>.</p>
<ul>
<li><strong>Synchronous</strong>: the leader waits until a follower confirms it has the write. That follower is guaranteed an up-to-date copy, so losing the leader loses nothing. The costs: write latency becomes leader commit plus that follower's round trip, and if the follower is slow or dead, writes slow down or block. Making <em>every</em> follower synchronous means any single node outage halts all writes.</li>
<li><strong>Asynchronous</strong>: the leader acknowledges once the write is durable locally. It is fast and the leader never blocks on followers, so it is very common, especially with many followers or remote ones. The cost: if the leader dies before shipping its latest writes, writes the client was told were saved are lost on failover.</li>
</ul>
<p><strong>Middle grounds</strong> (always say which one you mean):</p>
<ul>
<li><strong>Semi-sync, in the book's sense</strong>: one synchronous follower, and if it fails another is made synchronous, so every acknowledged write is on at least two nodes. PostgreSQL <code>synchronous_standby_names = 'FIRST 1 (s1, s2)'</code> behaves this way. PostgreSQL also <strong>never falls back</strong>: if no synchronous standby is available, commits wait.</li>
<li><strong>Quorum commit</strong>: wait for any k followers (PostgreSQL <code>ANY k</code>, Raft majorities, MongoDB <code>w:majority</code>). One slow follower is hidden.</li>
<li><strong>Kafka <code>acks=all</code></strong> waits for <em>every</em> current in-sync replica, a dynamic synchronous set with a <code>min.insync.replicas</code> floor. A slow follower adds latency until it drops out of the ISR.</li>
<li><strong>MySQL semi-sync</strong> waits for an ack from any replica, but after <code>rpl_semi_sync_master_timeout</code> (10 s by default) it silently reverts to async. It is a latency bound, not a durability guarantee.</li>
</ul>
<p>A subtlety worth raising: in PostgreSQL, <code>synchronous_commit = on</code> means the standby has <em>flushed</em> the WAL, not applied it. A read on that standby can still miss the write. Only <code>remote_apply</code> guarantees it is visible there.</p>`,
      followups: [
        "What happens when the synchronous follower dies?",
        "How does quorum commit (ANY n) help with a slow follower?",
        "Does synchronous replication make reads on the follower fresh?",
      ],
      pitfalls: [
        "'Synchronous replication means follower reads are always fresh'",
        "Assuming MySQL semi-sync guarantees durability (it falls back to async)",
        "Proposing that every follower be synchronous",
        "Forgetting that async replication can lose acknowledged writes",
      ],
    },
    {
      id: "q-kafka-isr",
      q: "A Kafka topic has replication factor 3, min.insync.replicas = 2, and producers use acks=all. What happens to writes when one broker fails? When two fail? What does enabling unclean leader election change?",
      diff: "medium",
      section: "leaders-and-followers",
      a: `<p><strong>Each partition uses single-leader replication.</strong> Producers write to the partition leader and followers fetch from it. The <strong>in-sync replica set (ISR)</strong> holds the replicas that have kept up with the leader recently. With <code>acks=all</code>, the leader acknowledges a record once <em>every current ISR member</em> has it. That is a dynamic synchronous set, not a fixed majority.</p>
<ul>
<li><strong>One broker down</strong>: it drops out of the ISR, leaving ISR = 2, which is ≥ <code>min.insync.replicas</code>, so writes continue. If it was the leader, the controller elects a new leader from the ISR, and every acknowledged record survives because every ISR member had it.</li>
<li><strong>Two brokers down</strong>: ISR = 1, which is below 2, so <code>acks=all</code> producers get <code>NotEnoughReplicas</code> errors. The partition stops accepting durable writes (consistency over availability). Consumers can still read records that were already committed.</li>
<li><strong>Unclean leader election</strong> (<code>unclean.leader.election.enable</code>, false by default since 0.11): if no ISR member is alive, an out-of-sync replica may become leader. Availability comes back, but committed records that replica lacked are lost, and the old leader truncates them when it returns.</li>
</ul>
<p>Tie it back to the chapter. <code>acks=all</code> + <code>min.insync.replicas</code> is a dynamic synchronous set with a floor: durability is bounded by the minimum ISR size, not the replication factor. <code>acks=1</code> is asynchronous replication with a lossy failover. Kafka 3.0 made <code>acks=all</code> the producer default. KRaft (a Raft quorum) replaced ZooKeeper for cluster metadata, but partition data still replicates through the ISR protocol.</p>`,
      followups: [
        "Why is min.insync.replicas equal to the replication factor a bad idea?",
        "What does acks=1 risk on leader failover?",
        "What does a consumer see during a leader change (high watermark)?",
      ],
      pitfalls: [
        "'acks=all means all three replicas' (it means all current ISR members, which can shrink to one)",
        "Using acks=all with min.insync.replicas = 1 and assuming durability",
        "Calling the ISR a majority quorum",
      ],
    },

    // --- node-outages ---
    {
      id: "q07",
      q: "What is split brain and how do you prevent it?",
      diff: "hard",
      section: "node-outages",
      a: `<p><strong>Split brain</strong> means two nodes both believe they are the leader and both accept writes. Single-leader replication has no rule for merging two diverging histories, so the result is lost or corrupted data. It happens because failure detection uses timeouts. A leader that is paused (GC, VM migration) or cut off by a partition looks dead, so a follower is promoted. Then the old leader resumes, or the partition heals, and it is still accepting writes.</p>
<p>Prevention works in layers:</p>
<ul>
<li><strong>Majority-based election</strong>: Raft, Paxos or Zab, or an external coordinator such as etcd, Consul or ZooKeeper (Patroni uses one of these). A candidate needs votes from a majority, and two majorities always intersect, so there is at most one leader per term or epoch.</li>
<li><strong>Fencing the deposed leader</strong>: election prevents two leaders in the <em>same</em> term, but an old leader can keep acting on stale belief until it learns otherwise. So use <strong>leases</strong> (the leader stops serving when its lease expires, which assumes bounded clock drift) and <strong>fencing tokens</strong>: each grant of leadership carries a monotonically increasing number, and storage rejects writes with an older one (Chapter 8).</li>
<li><strong>STONITH</strong> ("shoot the other node in the head"): power off or isolate the old leader before promoting a new one. It is crude, and if poorly designed it can shut down both nodes.</li>
<li><strong>Demote on return</strong>: the old leader must rejoin as a follower, with its unreplicated tail discarded or reconciled (MongoDB rollback files, PostgreSQL <code>pg_rewind</code>).</li>
</ul>
<p>Real examples: before 7.0, Elasticsearch required <code>discovery.zen.minimum_master_nodes</code> to be set to a majority, and misconfiguring it allowed two masters; 7.0 manages that quorum automatically. In GitHub's October 2018 incident, a 43-second partition led Orchestrator to promote West Coast primaries while the East Coast held writes the West lacked. GitHub chose 24 hours 11 minutes of degraded service to reconcile rather than discard data.</p>`,
      followups: [
        "How do fencing tokens work, and who checks them?",
        "Why doesn't majority election alone stop an old leader from writing?",
        "What should happen to the old leader's unreplicated writes?",
      ],
      pitfalls: [
        "Relying on timeouts alone and assuming a slow leader is a dead leader",
        "Thinking consensus removes the need for fencing",
        "Running a two-node cluster with no tiebreaker",
        "Forgetting about the old leader when it comes back",
      ],
    },
    {
      id: "q-failover-data-loss",
      q: "Your asynchronously replicated primary database crashes at peak traffic. Walk through automatic failover, what can go wrong, and how you would bound data loss.",
      diff: "hard",
      section: "node-outages",
      a: `<p><strong>The steps</strong>:</p>
<ul>
<li><strong>Detect</strong>: the primary misses heartbeats past a timeout. A timeout can't tell dead from slow or partitioned, and at peak traffic "slow" is plausible.</li>
<li><strong>Elect</strong>: choose the most up-to-date replica, ideally by majority vote. That can be Raft-based replication, or a coordination store such as etcd, Consul or ZooKeeper, which is how Patroni elects.</li>
<li><strong>Reconfigure</strong>: repoint clients (DNS, proxy, service discovery), and make sure the old primary is demoted and fenced so it can't keep accepting writes.</li>
</ul>
<p><strong>What can go wrong</strong>:</p>
<ul>
<li><strong>Lost acknowledged writes</strong>: whatever the old primary committed but hadn't shipped is gone, so RPO &gt; 0. Picking the most up-to-date replica shrinks the loss but doesn't eliminate it.</li>
<li><strong>External systems disagree</strong>: caches, search indexes and other services saw those writes or IDs. In GitHub's 2012 incident, a promoted, lagging follower reissued auto-increment keys that were also used in Redis, and private data was shown to the wrong users.</li>
<li><strong>Split brain</strong> if the old primary keeps serving. Prevent it with STONITH, fencing tokens or epochs.</li>
<li><strong>False positives</strong>: a load spike can trigger a needless failover, which adds reconnection and resync load to an already struggling cluster.</li>
<li><strong>Cascading load</strong>: the new primary, now with one fewer replica, absorbs all writes plus catch-up traffic.</li>
</ul>
<p><strong>Bounding the loss</strong>:</p>
<ul>
<li>Use semi-sync or quorum commit: PostgreSQL <code>synchronous_standby_names = 'ANY 1 (...)'</code>, or MySQL lossless semi-sync (<code>AFTER_SYNC</code>), noting that it falls back to async after its timeout.</li>
<li>Use majority-commit replication: Raft-based databases, MongoDB <code>w:majority</code>. Majority-acknowledged writes survive any single failover.</li>
<li>In Kafka, <code>acks=all</code> is not a majority quorum: it waits for every <em>current</em> in-sync replica, a dynamic synchronous set. Set <code>min.insync.replicas</code> to at least 2 (the floor that actually bounds durability) and keep unclean leader election off, so an acknowledged record survives losing its leader.</li>
<li>Refuse to promote a replica lagging beyond a threshold (Patroni <code>maximum_lag_on_failover</code>). This trades availability for durability.</li>
<li>Keep the old primary's WAL or binlog so its tail can be recovered or reconciled, and use <code>pg_rewind</code> to rejoin it as a follower.</li>
</ul>
<p>State the targets explicitly: the <strong>RPO</strong> (zero only with synchronous or majority commit) and the <strong>RTO</strong> (detection timeout + election + client reconnect).</p>`,
      followups: [
        "What does MySQL do when the semi-sync replica stops acknowledging?",
        "How does Raft guarantee committed writes survive a leader change?",
        "Would you automate failover across regions?",
        "How do you make the old primary safe when it comes back?",
      ],
      pitfalls: [
        "Claiming async failover is lossless if you pick the most up-to-date replica",
        "Assuming a shorter timeout is always better",
        "Ignoring the old leader when it returns",
        "Forgetting caches, search indexes and other systems keyed by database IDs",
      ],
    },
    {
      id: "q-add-follower",
      q: "How do you add a new replica to a busy production database without downtime?",
      diff: "easy",
      section: "node-outages",
      a: `<p>The key is a <strong>snapshot tied to an exact log position</strong>, followed by streaming everything after that position.</p>
<ul>
<li><strong>Snapshot without locking</strong>: pg_basebackup (PostgreSQL), Percona XtraBackup or the MySQL 8.0.17+ CLONE plugin, MongoDB initial sync. The snapshot records its position: an LSN, binlog coordinates or a GTID set.</li>
<li><strong>Restore</strong> it on the new node.</li>
<li><strong>Start replication from that position</strong>. The follower requests every change since the snapshot and applies the backlog until its lag is near zero.</li>
<li><strong>Only then add it to the read pool</strong>. Serving reads earlier hands users very stale data.</li>
</ul>
<p>What makes or breaks it:</p>
<ul>
<li><strong>Log retention</strong>: the leader must keep its log from the snapshot position onward, using replication slots, <code>wal_keep_size</code>, binlog retention or a large enough oplog window. GitLab's 2017 outage started when the WAL a lagging replica needed had already been removed, forcing a full re-seed. Slots have their own risk: a replica that disappears pins WAL until the primary's disk fills.</li>
<li><strong>Protecting the leader</strong>: throttle the copy, or take it from an existing replica, so the backup's I/O doesn't hurt production.</li>
</ul>`,
      followups: [
        "What if the snapshot takes longer than the leader keeps its log?",
        "Why can't you just copy the data directory of a running server?",
        "How can a replication slot hurt the primary?",
      ],
      pitfalls: [
        "Copying data files from a live server without a consistent snapshot",
        "Locking the leader for the duration of the copy",
        "Serving reads from the new replica before it has caught up",
      ],
    },

    // --- replication-logs ---
    {
      id: "q-replication-log-format",
      q: "Compare statement-based, WAL-shipping and logical (row-based) replication. Which would you pick for a new system that also feeds a data warehouse, and why?",
      diff: "medium",
      section: "replication-logs",
      a: `<ul>
<li><strong>Statement-based</strong>: ship the SQL. It is compact and human-readable but fragile. Nondeterministic functions break it: the book uses NOW() and RAND(), and MySQL replays NOW() correctly by logging the statement's timestamp, but <code>UUID()</code>, <code>SYSDATE()</code> and <code>UPDATE … LIMIT</code> without ORDER BY remain unsafe. So do statements whose effect depends on existing data or auto-increment, which must run in exactly the same order everywhere, and side effects from triggers and UDFs. The workaround is for the leader to substitute fixed values. MySQL moved away from it (ROW has been the default since 5.7.7, and MIXED switches to row format for unsafe statements). VoltDB uses it safely by requiring deterministic transactions.</li>
<li><strong>WAL shipping (physical)</strong>: ship the storage engine's own log of byte changes to disk pages. Replay is exact and the log already exists. But it is tightly coupled to the storage format: PostgreSQL streaming replication requires the same major version, so upgrades need downtime or another mechanism. Other systems can't consume it, and it can use a lot of bandwidth (Uber's 2016 post cited both problems).</li>
<li><strong>Logical (row-based)</strong>: ship per-row changes (inserted values, the deleted row's key, the updated row's key plus new values) and a commit record. It is decoupled from storage internals, so different versions or engines can replicate, and external consumers can parse it. The costs: a bulk update produces one record per row, tables need primary keys (or full row images), and schema changes need handling (PostgreSQL logical replication doesn't replicate DDL).</li>
</ul>
<p><strong>Pick logical.</strong> The same stream that keeps replicas current doubles as the <strong>change data capture</strong> feed for the warehouse, caches and search (Debezium reads MySQL binlog and PostgreSQL logical decoding; Chapter 11). It also enables near-zero-downtime major-version upgrades. Plan for schema evolution of the change stream (Chapter 4).</p>`,
      followups: [
        "Why does an UPDATE ... LIMIT without ORDER BY break statement-based replication?",
        "How does PostgreSQL let you upgrade major versions with minimal downtime?",
        "What happens to a logical replica when a table has no primary key?",
      ],
      pitfalls: [
        "Saying the WAL contains SQL",
        "Claiming statement-based replication is obsolete everywhere (VoltDB and MySQL MIXED still use it)",
        "Ignoring schema evolution of the change stream (Chapter 4)",
      ],
    },

    // --- replication-lag ---
    {
      id: "q03",
      q: "Explain read-your-writes consistency and how to implement it.",
      diff: "medium",
      section: "replication-lag",
      a: `<p><strong>Read-your-writes</strong> (read-after-write) consistency: after users submit a write, their own later reads reflect it. It promises nothing about other users' writes. Without it, a user posts a comment, the page reloads from an asynchronous follower that hasn't applied the comment yet, and it looks lost. Users then resubmit or file bugs.</p>
<p><strong>Implementation options</strong>:</p>
<ul>
<li><strong>Read what the user can modify from the leader</strong>: your own profile from the leader, everyone else's from followers. Works when the user-editable data is a small, known set.</li>
<li><strong>Time window</strong>: for a while after the user's last write, longer than p99 lag, route that user's reads to the leader. Also take replicas lagging beyond that window out of the read pool. Rails 6's automatic role switching works this way (its example uses 2 s).</li>
<li><strong>Log-position tokens</strong>: remember the leader's log position (LSN/GTID) after the user's write, and serve the read only from a replica that has replayed past it. Otherwise wait briefly, try another replica, or fall back to the leader. Prefer logical positions to wall-clock timestamps, which depend on synchronized clocks. MongoDB causal sessions and Cosmos DB session tokens use this approach, and MediaWiki's ChronologyProtector does something similar.</li>
<li><strong>At the database level</strong>: PostgreSQL <code>synchronous_commit = remote_apply</code> makes reads on a synchronous standby include the write, at the cost of write latency.</li>
</ul>
<p><strong>Multi-datacenter and cross-device</strong>: any read that must go to the leader has to be routed to the leader's datacenter. If the user writes on a phone and reads on a laptop, a per-device cookie can't help. Store the last-write position server-side per user, and route all of a user's devices to the same region.</p>`,
      followups: [
        "How do you handle cross-device read-your-writes?",
        "How long should the leader-read window be, and what if lag exceeds it?",
        "How does this interact with a cache in front of the database?",
      ],
      pitfalls: [
        "Routing every read to the leader, which defeats read scaling",
        "Using wall-clock timestamps without considering clock skew",
        "Forgetting the user's second device",
        "Confusing it with monotonic reads",
      ],
    },
    {
      id: "q04",
      q: "What is monotonic reads, and how does it differ from read-your-writes?",
      diff: "medium",
      section: "replication-lag",
      a: `<p><strong>Monotonic reads</strong>: users who have seen data as of some point never later see an older state. The classic failure: a user refreshes twice. The first read hits a follower that already has a new comment, the second hits a more-lagged follower, and the comment vanishes.</p>
<p><strong>Fix</strong>: always route a user's reads to the same replica, for example by a hash of the user ID, instead of choosing at random. If that replica fails, reroute to another and accept a possible jump.</p>
<p><strong>How it differs from read-your-writes</strong>: they are <strong>independent session guarantees</strong>, not stronger and weaker versions of each other.</p>
<ul>
<li>A user pinned to a lagging follower has monotonic reads but may not see a comment they just posted. <strong>Pinning gives monotonic reads, not fresh reads.</strong></li>
<li>A read-your-writes rule such as "leader for 60 s after a write" says nothing about the reads that bounce among followers afterwards, so other people's data can still appear and disappear.</li>
</ul>
<p>Where it sits: weaker than strong consistency, stronger than eventual consistency. Products often provide both under the name "session" consistency (MongoDB causal sessions, Cosmos DB's Session level), following Terry et al.'s 1994 session guarantees.</p>`,
      followups: [
        "What happens to monotonic reads when the pinned replica fails?",
        "How would you provide both monotonic reads and read-your-writes at once?",
        "Does pinning by user ID cause load imbalance?",
      ],
      pitfalls: [
        "Calling monotonic reads a weaker form of read-your-writes",
        "Assuming sticky routing also gives fresh reads",
        "Forgetting to handle failure of the pinned replica",
      ],
    },
    {
      id: "q05",
      q: "What is a consistent-prefix read?",
      diff: "medium",
      section: "replication-lag",
      a: `<p><strong>Consistent prefix reads</strong>: if writes happen in a certain order, every reader sees them in that order. A reader may be behind and see only a prefix, but never a later write without the earlier writes it depends on.</p>
<p>Kleppmann illustrates it with a <em>fictional</em> exchange. Mr. Poons asks Mrs. Cake how far into the future she can see, and she replies that it's usually about ten seconds. If the question and the answer are stored on different partitions, and the answer's partition replicates faster, an observer sees the answer before the question. It looks as if she replied before being asked.</p>
<p><strong>Why it happens</strong>: this is mainly a <strong>partitioned-database</strong> problem. Within a single log applied in order, every follower holds a prefix of the leader's log, so you get consistent prefix for free. Across partitions there is no global order, because each partition replicates independently.</p>
<p><strong>Fixes</strong>:</p>
<ul>
<li>Write causally related data to the <strong>same partition</strong>, for example keying all messages of a conversation by conversation ID. Kafka is the textbook case: ordering is guaranteed only within a partition, so related events must share a key.</li>
<li><strong>Track causal dependencies</strong> explicitly (happens-before, version vectors, causal consistency in Chapter 9).</li>
<li>Use a store with a global commit order or cross-partition transactions, paying for coordination.</li>
</ul>`,
      followups: [
        "How would you guarantee it across partitions?",
        "Why does an unpartitioned single-leader database get this for free?",
        "How does this relate to causal consistency?",
      ],
      pitfalls: [
        "Describing the Poons/Cake dialogue as a real incident",
        "Assuming per-partition order implies a global order",
        "Proposing wall-clock timestamps to order events across partitions",
      ],
    },
    {
      id: "q-design-read-your-writes",
      q: "Users of your social app say profile edits 'disappear' right after saving. You have one leader in us-east and read replicas in three regions. Diagnose it and design a fix that also works when a user edits on their phone and checks on their laptop.",
      diff: "medium",
      section: "replication-lag",
      a: `<p><strong>Diagnosis</strong>: the write goes to the leader in us-east, but the next read is served by an asynchronous replica, often in another region, that hasn't applied it yet. This is a <strong>read-your-writes violation caused by replication lag</strong>. It gets worse under load, when lag spikes from milliseconds to seconds. Confirm it by correlating the complaints with replica lag metrics.</p>
<p><strong>Fix options</strong>, roughly in order of preference:</p>
<ul>
<li><strong>Own data from the leader</strong>: a user's own profile is read from the leader (in us-east), and everyone else's from local replicas. Cheap, because users view their own profile far less often than others'.</li>
<li><strong>Time window</strong>: after a user writes, route that user's reads to the leader for longer than p99 lag (Rails 6's example uses 2 s), and pull replicas beyond that lag out of rotation, so the window can't be exceeded silently.</li>
<li><strong>Position tokens</strong>: after the write, capture the leader's log position (LSN/GTID) and carry it with the user. Serve reads only from a replica whose replay position is at least that, waiting briefly or falling back to the leader otherwise. This is the most precise option and keeps most reads local. MongoDB causal sessions and Cosmos DB session tokens work this way.</li>
</ul>
<p><strong>Cross-device</strong>: a token in the phone's cookie doesn't help the laptop. Store the last-write position <strong>per user ID</strong> in a fast central store (or alongside the session data), and check it on every read. Alternatively, route all of a user's devices to the same region and treat that region's reads as leader-routed for the window.</p>
<p><strong>Related real-world designs</strong>: Facebook's memcache remote markers are set per key and per region, sending cache misses for a recently written key to the master region. MediaWiki's ChronologyProtector waits for a replica that has reached the user's write position. Finally, monitor replication lag and alert on it, because every one of these designs assumes lag is usually bounded.</p>`,
      followups: [
        "How do you choose the time window, and what happens when lag exceeds it?",
        "What if the replica that should catch up is stuck?",
        "How would you also provide monotonic reads?",
        "What changes if the system becomes multi-leader across regions?",
      ],
      pitfalls: [
        "'Just make replication synchronous' (kills write latency and availability across regions)",
        "Using wall-clock timestamps without considering clock skew",
        "Forgetting the second device",
        "Routing all reads to the leader, which defeats read scaling",
      ],
    },
    {
      id: "q-monitor-replication-lag",
      q: "How would you measure and alert on replication lag? What is different in a leaderless database?",
      diff: "medium",
      section: "replication-lag",
      a: `<p><strong>Leader-based</strong>: lag is the leader's log position minus the follower's applied position, in bytes, or the age of the last applied commit, in time.</p>
<ul>
<li><strong>PostgreSQL</strong>: <code>pg_stat_replication</code> on the primary shows sent/write/flush/replay LSNs and, since v10, <code>write_lag</code>, <code>flush_lag</code> and <code>replay_lag</code>. On a standby, use <code>pg_last_wal_replay_lsn()</code> and <code>pg_last_xact_replay_timestamp()</code>. Bytes behind and seconds behind can disagree: on an idle primary the time since the last replayed transaction keeps growing with no real lag, while a burst of large writes makes byte lag spike.</li>
<li><strong>MySQL</strong>: <code>Seconds_Behind_Source</code> (<code>Seconds_Behind_Master</code> before 8.0.22) is computed from event timestamps and misleads in documented cases. It shows 0 when the receiver (I/O) thread is the one behind and NULL when replication has stopped. The robust measure is a <strong>heartbeat table</strong>: write a timestamp on the leader every second (pt-heartbeat) and measure its age on each replica.</li>
</ul>
<p><strong>Alerting and routing</strong>: alert on a lag threshold <em>and</em> separately on replication having stopped, because a stopped replica may report no lag at all. Feed lag into routing as well. The book suggests not serving reads from followers more than about a minute behind, so the load balancer should drop such replicas from the pool.</p>
<p><strong>Leaderless</strong>: there is no single write order, so there is no position to subtract. Watch instead:</p>
<ul>
<li>pending hints and hinted-handoff backlog;</li>
<li>read-repair rates (digest mismatches) and whether repair runs complete;</li>
<li>a probabilistic staleness estimate, as in PBS (Bailis et al.).</li>
</ul>
<p>If a store relies on read repair alone, with no anti-entropy, the staleness of rarely read keys is unbounded.</p>`,
      followups: [
        "Why can bytes-behind and seconds-behind disagree?",
        "What should the load balancer do when a replica exceeds the lag bound?",
        "How does a heartbeat table behave across a failover?",
      ],
      pitfalls: [
        "Treating Seconds_Behind_Master as ground truth",
        "Alerting on high lag but not on replication having stopped",
        "Assuming a leaderless store has a follower-style lag metric",
      ],
    },

    // --- multi-leader ---
    {
      id: "q-multi-leader-topology",
      q: "You run multi-leader replication across three regions. Compare circular, star and all-to-all topologies: what happens when one region fails, and why can an update arrive before the insert it modifies?",
      diff: "medium",
      section: "multi-leader",
      a: `<p>With more than two leaders, every write has to be forwarded along some graph:</p>
<ul>
<li><strong>Circular</strong>: each leader forwards to the next. <strong>Star</strong>: a root forwards to everyone else. In both, a write passes through intermediate nodes, so it carries the <strong>IDs of the nodes it has visited</strong> and a node ignores writes already tagged with its own ID. Otherwise a write would loop forever (MySQL uses server IDs for this). Their weakness is a single point of failure: if one node in the ring, or the root of the star, fails, replication between the others stops until someone reconfigures the topology, often by hand.</li>
<li><strong>All-to-all</strong>: every leader sends to every other, so one failure doesn't block anyone else, which makes it more fault tolerant. But links have different speeds, so messages can <strong>overtake</strong> each other. A client inserts row 7 on leader A; another client, having seen it, updates row 7 on leader C; leader B receives C's update before A's insert, so it is asked to update a row that doesn't exist yet.</li>
</ul>
<p><strong>Why timestamps don't fix the ordering</strong>: clocks on different leaders aren't synchronized closely enough (Chapter 8), so a causally later write can carry an earlier timestamp. The fix is causal metadata, such as <strong>version vectors</strong>, that says directly "this update depends on that insert". B can then buffer the update until the insert arrives. This is the same causality problem as consistent prefix reads.</p>
<p>Practical advice: implementations vary a lot. The book notes that at the time BDR did not provide causal ordering and Tungsten did not detect conflicts. Read the docs and test with induced partitions and delays. Also, don't confuse this with Spanner or CockroachDB: they accept writes in every region but route each write to one consensus leader, so there is no asynchronous reconciliation and no overtaking.</p>`,
      followups: [
        "How do you prevent a write from looping forever in a ring?",
        "Why not just order writes by timestamp?",
        "Is CockroachDB with writes in every region multi-leader?",
      ],
      pitfalls: [
        "Assuming every topology preserves causal order",
        "Ignoring that circular and star topologies have single points of failure",
        "Calling consensus-based multi-region databases multi-leader",
      ],
    },

    // --- write-conflicts ---
    {
      id: "q-conflict-resolution",
      q: "In a multi-leader system, what are the ways to handle write conflicts? Compare them, and name the conflicts that no per-record rule can catch.",
      diff: "medium",
      section: "write-conflicts",
      a: `<p><strong>Why it is hard</strong>: with one leader, a second write to the same record waits or is rejected while the user is still there to retry. With several leaders, both writes succeed locally and the conflict is discovered later, asynchronously, when nobody can be asked. Detecting it synchronously (wait for every leader before saying OK) gives up local writes, the reason for multi-leader in the first place. So the options are:</p>
<ul>
<li><strong>Avoid it.</strong> Send every write for a record to one home leader, such as the user's home region. It is the simplest and most recommended approach, but it breaks whenever the home has to change (a datacenter fails, a user moves), so you still need a fallback rule.</li>
<li><strong>Converge with a deterministic rule</strong>, so every replica ends with the same value:
<ul>
<li><em>Last write wins</em> (highest timestamp or unique ID): popular and simple, but it silently discards every other acknowledged write, and clock skew can let an older write win.</li>
<li><em>Highest replica ID wins</em>: equally deterministic, equally lossy, and always favors the same side.</li>
<li><em>Merge the values</em> (union a set, or concatenate titles to "B/C"): nothing is lost, but the result may be something no user wrote.</li>
<li><em>Record the conflict</em>: keep every version in an explicit structure and resolve it later.</li>
</ul></li>
<li><strong>Run custom code.</strong> <em>On write</em>: the database calls your handler as soon as replication reveals a conflict (Bucardo lets you write it in Perl). It runs in the background, so it must be quick and cannot ask anyone. <em>On read</em>: the database keeps all versions and returns them together; the application or the user merges and writes the result back (CouchDB). Either way, resolution is per row or per document, not per transaction.</li>
<li><strong>Use data that merges itself.</strong> CRDTs for counters, sets and maps (Riak data types, Redis Enterprise Active-Active), mergeable persistent data structures with a Git-style three-way merge, and operational transformation for text (Google Docs, Etherpad).</li>
</ul>
<p><strong>The conflicts no rule sees</strong>: invariants that span rows. Two regions each book Room 3 for 10:00 as a new row. No row was written twice, so per-record detection finds nothing, yet the room is double-booked. Unique usernames fail the same way. These need one place of enforcement: route such writes to a single leader, or use a consensus-backed service or a serializable transaction (Chapter 7 calls the anomaly write skew).</p>
<p><strong>Close with a policy</strong>: avoidance by default; LWW only where losing a concurrent write is harmless; CRDTs or merges for sets and counters; surface conflicts to people for documents; a single authority for invariants.</p>`,
      followups: [
        "Why not detect conflicts synchronously?",
        "When is last write wins acceptable?",
        "How would you stop a meeting room from being double-booked across regions?",
      ],
      pitfalls: [
        "Relying on conflict avoidance alone and forgetting that a record's home can change",
        "Presenting last write wins as resolution without saying it discards acknowledged writes",
        "Expecting per-row resolution to catch double bookings or duplicate usernames",
        "Assuming an on-write handler can ask the user",
      ],
    },
    {
      id: "q-active-active-design",
      q: "Design a multi-region active-active store for user profiles and shopping carts. How do you handle write conflicts, deletes and uniqueness constraints?",
      diff: "hard",
      section: "write-conflicts",
      a: `<p><strong>Why active-active</strong>: local write latency in every region, and surviving a region outage without cross-region failover. The price is that concurrent writes in different regions will conflict, so every data type needs an explicit plan.</p>
<p><strong>1. Avoid conflicts first.</strong> Give each user a <strong>home region</strong> that handles their writes, so most of a user's data behaves as single-leader. Be honest that region failover and travelling users break this, so a resolution rule is still needed as a fallback.</p>
<p><strong>2. Profiles: per-field resolution.</strong> Resolve each field independently, so concurrent edits to different fields both survive. For low-value fields (avatar, bio), LWW per field is acceptable if you accept occasional loss. Use server timestamps or hybrid logical clocks, and know the clock-skew risks (Chapter 8). For important fields (email, payout details), detect the conflict and surface it rather than silently picking a winner.</p>
<p><strong>3. Carts: never LWW the whole cart.</strong> Either keep version vectors with siblings and merge them in the application, or model the cart as an <strong>OR-Set CRDT</strong>. In an OR-Set, concurrent adds survive and a remove deletes only the add-tags it observed. Deletes need <strong>tombstones</strong> (or the OR-Set's removed-tag metadata), otherwise a union merge resurrects removed items. Plan garbage collection for that metadata.</p>
<p><strong>4. Uniqueness can't be enforced by async multi-leader.</strong> Two regions can each accept "username = alice". Route such writes to a single authority (one region, or a consensus-backed service or global transaction), and accept the cross-region latency for that rare operation.</p>
<p><strong>Real systems to cite</strong>: DynamoDB global tables (LWW in the multi-Region eventually consistent mode), Cosmos DB multi-region writes (LWW by default, or a custom merge procedure), Redis Enterprise Active-Active (CRDTs).</p>
<p><strong>Operating it</strong>: count and log conflicts, test with induced partitions and clock skew, and define the RPO for losing a region (writes not yet replicated out of it).</p>`,
      followups: [
        "How do you handle a username claimed in two regions at once?",
        "What happens to carts during a long inter-region partition?",
        "How do you test conflict handling before production?",
      ],
      pitfalls: [
        "Using wall-clock LWW for everything and calling it solved",
        "Assuming conflicts are rare enough to ignore",
        "Forgetting deletes and tombstones",
        "Promising strong consistency across regions with async replication",
      ],
    },

    // --- leaderless-quorums ---
    {
      id: "q06",
      q: "Walk through the quorum math w + r > n.",
      diff: "hard",
      section: "leaderless-quorums",
      a: `<p><strong>Setup</strong>: each key has <strong>n</strong> replicas. n is per key (placed by partitioning), not the cluster size. In the Dynamo model, requests go to all n in parallel: a write succeeds after <strong>w</strong> acknowledgements, and a read waits for <strong>r</strong> responses and keeps the value with the newest version.</p>
<p><strong>Why w + r &gt; n works</strong>: the w nodes that took the write and the r nodes that answered the read are both subsets of the same n nodes. If w + r &gt; n, they can't be disjoint (pigeonhole), so at least one reply carries the latest successful write.</p>
<p><strong>Example</strong>: n = 3, w = 2, r = 2. A write lands on A and B while C is down. A later read hears from B and C. B has the new version and C the old one, so the client keeps B's value and read-repairs C.</p>
<p><strong>Tuning</strong>:</p>
<ul>
<li>Writes tolerate n − w unavailable nodes; reads tolerate n − r.</li>
<li>n = 3, w = r = 2 tolerates one down node for both (the Dynamo paper's common configuration). n = 5, w = r = 3 tolerates two.</li>
<li>w = n, r = 1: cheap reads, but <strong>any single node down makes writes fail</strong>. It is not "zero staleness" either: a read concurrent with an in-flight write can return either value, and a partially failed write stays on the replicas that accepted it.</li>
<li>w + r ≤ n (e.g., Cassandra ONE/ONE): lowest latency and highest availability, with stale reads likely. A legitimate choice when staleness is acceptable.</li>
</ul>
<p><strong>Caveats</strong>: stale reads still happen with sloppy quorums, concurrent writes resolved by LWW, a write concurrent with a read, a failed write that isn't rolled back, and a node restored from a stale copy. <strong>Quorums are not linearizable.</strong> Cassandra's QUORUM reads repair synchronously and are still not linearizable when concurrent writes are resolved by LWW. Linearizable compare-and-set needs consensus (Cassandra's Paxos-based lightweight transactions).</p>`,
      followups: [
        "Pick w and r for n = 5 to tolerate two failures for both reads and writes.",
        "Why isn't w + r > n linearizable?",
        "Why doesn't Cassandra literally read full data from all n replicas?",
      ],
      pitfalls: [
        "Saying w + r > n means strong consistency or linearizability",
        "Treating n as the cluster size",
        "Claiming w = n, r = 1 gives zero staleness",
        "Forgetting that the client must pick the newest version among the r replies",
      ],
    },
    {
      id: "q-anti-entropy-merkle",
      q: "In a leaderless store, how do replicas that missed writes get fixed? Compare read repair and anti-entropy, and explain why Merkle trees are used.",
      diff: "medium",
      section: "leaderless-quorums",
      a: `<p>There is no leader log to replay, so three mechanisms work together:</p>
<ul>
<li><strong>Read repair</strong>: when a read sees replies that disagree, the newest value is written back to the stale responders. It is cheap and happens as a side effect of reading. But it only fixes keys that are read, and only on the replicas that answered. Cassandra repairs mismatches synchronously on reads above ONE; its probabilistic background read-repair options were removed in 4.0.</li>
<li><strong>Hinted handoff</strong>: short-term catch-up for writes a node missed while it was down. It is bounded, for example by Cassandra's <code>max_hint_window</code> (3 hours by default).</li>
<li><strong>Anti-entropy</strong>: a background process compares replicas and copies missing data. Unlike a replication log, it applies changes in no particular order and possibly with a long delay.</li>
</ul>
<p><strong>Why Merkle trees</strong>: comparing every key would mean shipping the whole dataset. So Dynamo, and Cassandra's <code>nodetool repair</code>, build a <strong>hash tree over key ranges</strong>: leaves hash small ranges of keys, and each parent hashes its children. Two replicas compare root hashes. If they match, they are done. If not, they descend only into the subtrees whose hashes differ. Two mostly identical replicas exchange a handful of hashes and then just the ranges that actually differ.</p>
<p><strong>Why it matters</strong>: without anti-entropy, rarely read keys stay under-replicated indefinitely (Voldemort had no anti-entropy when the book was written). Repair also has a deadline: it must complete within the tombstone grace period (<code>gc_grace_seconds</code>, 10 days by default in Cassandra). Otherwise a replica that missed a delete can bring the deleted data back after the other replicas purge their tombstones.</p>`,
      followups: [
        "What happens if repair is not run within gc_grace_seconds?",
        "Why not just compare every key?",
        "Why doesn't anti-entropy preserve write order, and does it matter?",
      ],
      pitfalls: [
        "'Read repair alone keeps every replica fresh'",
        "Forgetting that deleted data can come back",
        "Assuming anti-entropy applies writes in order like a replication log",
      ],
    },

    // --- quorum-limits ---
    {
      id: "q-quorum-stale-reads",
      q: "With n = 3, w = 2, r = 2, describe at least three ways a client can still read stale data or observe values going backwards. How would you get stronger guarantees?",
      diff: "hard",
      section: "quorum-limits",
      a: `<p>The overlap argument holds only if both quorums come from the same n home nodes and every write is all-or-nothing. Ordinary events break that:</p>
<ul>
<li><strong>Sloppy quorum</strong>: during a partition, the write was acknowledged by stand-in nodes outside the home set. The read quorum (home nodes) doesn't intersect it until hinted handoff runs.</li>
<li><strong>Concurrent writes resolved by LWW</strong>: one acknowledged write is silently dropped, and with clock skew even a <em>later</em> write can lose.</li>
<li><strong>Write concurrent with reads</strong>: replica A already has the new value, B and C don't yet. Reader 1 hears from A and B and returns the new value. Reader 2 starts <em>after</em> reader 1 finished, hears from B and C, and returns the old one. Values went backwards even though w + r &gt; n. This is the classic proof that quorums are not linearizable.</li>
<li><strong>Partially failed write</strong>: only one replica accepted it (say the others had full disks), so the client was told it failed. It isn't rolled back, and later reads may or may not return it.</li>
<li><strong>Restored from a stale copy</strong>: a replica holding the new value dies and is rebuilt from an older one, leaving fewer than w copies of the new value.</li>
<li><strong>Repair not finished</strong>: hints and anti-entropy still in flight.</li>
</ul>
<p><strong>Getting stronger guarantees</strong>:</p>
<ul>
<li><strong>ABD-style quorums</strong>: readers do <em>synchronous</em> read repair (write back the newest value to a quorum) before returning, and writers read a quorum's latest version before writing. That makes plain reads and writes linearizable, though not compare-and-set.</li>
<li>Disable sloppy quorums for data that needs fresh reads.</li>
<li>Use <strong>consensus</strong> (Paxos/Raft) for compare-and-set, e.g. Cassandra lightweight transactions, or use a leader-based store for that data.</li>
<li>Operate with measurement: estimate staleness probabilistically (PBS) rather than assuming it is zero.</li>
</ul>`,
      followups: [
        "Does w = n, r = 1 remove these problems?",
        "Why doesn't Cassandra QUORUM give linearizability?",
        "How would you measure staleness in production?",
      ],
      pitfalls: [
        "'w + r > n means strong consistency / linearizability'",
        "'Read repair makes it linearizable' (only if done synchronously before returning, and still not with LWW conflicts)",
        "Forgetting that partially failed writes are not rolled back",
      ],
    },
    {
      id: "q-sloppy-quorum",
      q: "What are sloppy quorums and hinted handoff? Why did Dynamo use them, and what do they cost?",
      diff: "medium",
      section: "quorum-limits",
      a: `<p><strong>The problem</strong>: a strict quorum needs w acknowledgements from the key's <em>n home nodes</em>. During a partition, a client may reach many nodes but too few home nodes, and every write would fail. Dynamo's requirement was that "add to cart" always succeeds.</p>
<p><strong>Sloppy quorum</strong>: reads and writes go to the first n <em>healthy</em> nodes on the key's preference list. A write meant for an unreachable home node lands on a stand-in, which still counts toward w and keeps a <strong>hint</strong> naming the intended node. It still needs w acknowledgements; it just accepts them from outside the home set. <strong>Hinted handoff</strong>: when the home node is reachable again, the stand-in delivers the write to it. The book's picture is sleeping on the neighbor's couch when you're locked out of your house.</p>
<p><strong>Costs</strong>:</p>
<ul>
<li>w + r &gt; n <strong>no longer guarantees overlap</strong>. The read quorum (home nodes) may not include the stand-ins, so until handoff completes, reads can be stale. It assures <strong>durability</strong> (w copies somewhere), not freshness.</li>
<li>Hints can be lost if the stand-in dies, so anti-entropy is still the backstop.</li>
</ul>
<p><strong>Product reality</strong>: enabled by default in Riak (book). Cassandra stores hints for down replicas, but hints <strong>don't count toward consistency levels</strong>, except <code>ANY</code>, where a write may be acknowledged with only a hint stored. Hints older than <code>max_hint_window</code> (3 hours by default) aren't kept, so longer outages need a full repair.</p>`,
      followups: [
        "What does Cassandra's consistency level ANY actually guarantee?",
        "How would you bound staleness after a partition heals?",
        "Why is hinted handoff not a substitute for anti-entropy?",
      ],
      pitfalls: [
        "'A sloppy quorum writes to any n reachable nodes' (it still needs w acknowledgements)",
        "Claiming w + r > n still guarantees fresh reads with sloppy quorums",
        "Assuming hints make repair unnecessary",
      ],
    },

    // --- concurrent-writes ---
    {
      id: "q-lww-lost-updates",
      q: "Your Cassandra-backed service occasionally loses updates, even though every write returned success. How does last write wins cause this, and when is it acceptable?",
      diff: "medium",
      section: "concurrent-writes",
      a: `<p><strong>How LWW works</strong>: every write carries a timestamp (in Cassandra, per cell, set by the client driver or the coordinator). Replicas keep the value with the largest timestamp and discard the rest. That makes replicas converge, which is all it promises.</p>
<p><strong>Two ways it drops acknowledged writes</strong>:</p>
<ul>
<li><strong>Concurrent writes.</strong> Two clients update the same cell at about the same time. Each write reaches enough replicas to satisfy its consistency level, so each client hears "success", but only one value survives and nobody is told. For concurrent writes "latest" is an arbitrary choice.</li>
<li><strong>Clock skew, even without concurrency.</strong> Timestamps come from different machines' clocks. If one client's clock runs ahead, its write can beat a write made later, even one made by a client that had already read the first value. The later write disappears (Chapter 8). NTP usually keeps clocks close, but it cannot guarantee it.</li>
</ul>
<p>This is not theoretical: Jepsen's 2013 partition tests found that Dynamo-style stores resolving conflicts by LWW silently lost acknowledged writes.</p>
<p><strong>When LWW is fine</strong>:</p>
<ul>
<li>Each key is written only once. The usual Cassandra advice is to use a UUID as the key, so every write creates a new key instead of overwriting one.</li>
<li>Losing a concurrent update does no harm: caches, "last seen" times, presence, an avatar.</li>
<li>Applied per field rather than per record, which narrows the loss to edits of the same field (Figma does this per property).</li>
</ul>
<p><strong>What to use instead</strong>: counters need a CRDT counter (Cassandra has counter columns); sets and carts need siblings with a merge, or an OR-Set; read-modify-write needs compare-and-set, which Cassandra offers as Paxos-based lightweight transactions. To detect concurrency rather than hide it, track causality with version vectors. Hybrid logical clocks (used by CockroachDB) make timestamps respect causality, so a write never loses to one it had already seen, but truly concurrent writes are still decided arbitrarily.</p>`,
      followups: [
        "How would you build a counter on a store that only offers LWW?",
        "What do hybrid logical clocks fix, and what don't they fix?",
        "How do you do a safe read-modify-write in Cassandra?",
      ],
      pitfalls: [
        "Believing NTP makes LWW safe",
        "Equating 'the write returned success' with 'the value is kept'",
        "Using LWW for counters, carts or other mergeable data",
      ],
    },
    {
      id: "q08",
      q: "How does Dynamo-style leaderless replication detect concurrent writes?",
      diff: "hard",
      section: "concurrent-writes",
      a: `<p>The store has to answer one question: did write B <strong>know about</strong> write A, in which case B may overwrite it, or not, in which case they are concurrent and both must be kept? Wall-clock time can't answer that. Causality metadata can.</p>
<ul>
<li><strong>One replica: version numbers.</strong> The server keeps a version number per key. A read returns all current values plus the version. The client must send that version back with its next write, merged with everything it read. The server then overwrites every value at or below that version, because the client has seen them, and keeps values with higher versions as <strong>siblings</strong>, because they are concurrent. A write without a version overwrites nothing.</li>
<li><strong>Many replicas: version vectors.</strong> Use one counter per replica. Each replica increments its own entry when it accepts a write and tracks the entries it has seen from the others. Compare entry by entry: if one vector is ≥ in every entry and &gt; in at least one, it is newer. If each is bigger somewhere, the writes are concurrent.</li>
<li>The client returns the vector it read (Riak's opaque <strong>causal context</strong>). That is how the store knows exactly which values to discard, and why reading from one replica and writing to another is safe.</li>
</ul>
<p>Concurrent values are returned together on the next read, and the application merges them (union for adds, tombstones for removals) or a CRDT merges them automatically. Riak 2.0 uses <strong>dotted version vectors</strong> to stop siblings from piling up.</p>
<p><strong>Contrasts worth stating</strong>: Cassandra has no siblings. It resolves every regular cell by last-write-wins on timestamps. Version vectors are also not quite the same as vector clocks. The Dynamo paper used the term "vector clocks", but for comparing replica state, version vectors are the right structure (Chapter 9).</p>`,
      followups: [
        "Why can't you just use timestamps?",
        "What happens if a client writes without sending back the version it read?",
        "How do dotted version vectors avoid sibling explosion?",
      ],
      pitfalls: [
        "'Concurrent means at the same wall-clock time'",
        "Saying Cassandra keeps siblings or uses version vectors",
        "Using 'vector clock' and 'version vector' interchangeably without qualification",
        "Forgetting that the client must read before writing",
      ],
    },
    {
      id: "q-cart-concurrent-merge",
      q: "Two devices update the same shopping cart concurrently in a Dynamo-style store. How do you make sure no add is lost and removed items do not come back?",
      diff: "hard",
      section: "concurrent-writes",
      a: `<p><strong>Why LWW fails</strong>: the phone adds eggs while the laptop adds milk. Each write was acknowledged, but LWW keeps only the one with the larger timestamp, so one add vanishes with no error.</p>
<p><strong>Step 1: track causality.</strong></p>
<ul>
<li>The store keeps a version per key (a version vector across replicas). Reads return <strong>all siblings plus the causal context</strong>.</li>
<li>Clients must <strong>read before writing</strong> and send the context back. The store then overwrites exactly what the client saw and keeps anything concurrent as a sibling.</li>
</ul>
<p><strong>Step 2: merge correctly.</strong></p>
<ul>
<li>Merging siblings by <strong>union</strong> keeps every add.</li>
<li>Removals are the trap. If the laptop removed milk while the phone's sibling still has it, union brings milk back. Dynamo's cart accepted that deleted items could resurface. To prevent it, a removal must leave a <strong>tombstone</strong> (a deletion marker with its version) that the merge respects.</li>
<li>Item-level tombstones over-correct in the other direction: a removal then beats a concurrent re-add.</li>
</ul>
<p><strong>Better: an OR-Set CRDT.</strong> Every add gets a unique tag. A remove deletes only the tags it has <em>observed</em>, so a concurrent add (with a new tag) survives: add wins, and a remove that saw the add sticks. The merge is automatic and correct by construction. Quantities can be a PN-Counter per item, or a per-item LWW register if "last setting wins" is the intended meaning.</p>
<p><strong>Costs to mention</strong>: metadata growth (tags, tombstones, version-vector entries) needs garbage collection once all replicas have seen it, and dotted version vectors keep siblings from piling up.</p>`,
      followups: [
        "Why must the client send the version back on write?",
        "How large can version vectors grow, and how is that bounded?",
        "What semantics do you want if one device removes an item while another increases its quantity?",
      ],
      pitfalls: [
        "Relying on timestamps to order writes from two devices",
        "Union merge without tombstones",
        "Confusing version vectors with Lamport timestamps",
      ],
    },
    {
      id: "q09",
      q: "What are CRDTs and when would you use them?",
      diff: "hard",
      section: "concurrent-writes",
      a: `<p><strong>CRDTs</strong> (conflict-free replicated data types) are data structures that replicas can update independently, without coordination, and merge automatically. All replicas that have seen the same updates converge to the same state.</p>
<p><strong>Two flavors</strong>:</p>
<ul>
<li><strong>State-based</strong>: replicas exchange whole states and merge them with a function that is <strong>commutative, associative and idempotent</strong>, so states can arrive in any order, any number of times.</li>
<li><strong>Operation-based</strong>: replicas broadcast operations that <strong>commute when concurrent</strong>. These need reliable delivery in causal order.</li>
</ul>
<p><strong>Common types</strong>:</p>
<ul>
<li><strong>G-Counter</strong>: one counter per replica; merge by element-wise max; value = sum. <strong>PN-Counter</strong>: two G-Counters, for increments and decrements.</li>
<li><strong>OR-Set</strong>: each add gets a unique tag, and a remove deletes only the tags it observed, so a concurrent add wins.</li>
<li><strong>LWW-Register</strong>: a CRDT that still drops concurrent writes. Convergent is not the same as lossless.</li>
<li><strong>Sequence CRDTs</strong> (RGA and the types in Automerge and Yjs) for collaborative text.</li>
</ul>
<p><strong>When to use them</strong>: offline-first and local-first apps, collaborative editing, and multi-region active-active data such as counters, sets, carts and presence. Documented users include Riak 2.0 data types, Redis Enterprise Active-Active, Automerge, Yjs and SoundCloud's Roshi. Be careful with attributions: Google Docs uses operational transformation, and Figma is CRDT-<em>inspired</em> but server-authoritative with LWW per property.</p>
<p><strong>Limits</strong>: metadata (tags, tombstones, per-replica entries) grows and needs garbage collection. Merge semantics must match the product, for example whether add or remove should win. Most importantly, <strong>invariants that need coordination can't be guaranteed by merging</strong>: a balance that must not go negative, or a unique username. Those still need a single leader or consensus.</p>`,
      followups: [
        "Design an add/remove set that never resurrects removed items.",
        "Why must a state-based merge be idempotent?",
        "Which business rules can't be expressed as a CRDT?",
      ],
      pitfalls: [
        "Claiming Google Docs or Figma are CRDT systems",
        "Saying CRDTs never lose data (an LWW-Register does)",
        "Ignoring metadata growth and tombstone garbage collection",
        "Using CRDTs for invariants such as non-negative balances",
      ],
    },
  ],
});
