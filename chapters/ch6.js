// Chapter 6: Partitioning
// Authoring guide: docs/AUTHORING.md
DDIA.registerChapter({
  id: "ch6",
  part: 2,
  number: 6,
  title: "Partitioning",
  tagline: "Splitting data across machines so load stays even, your key queries stay on one partition, and growth doesn't mean moving everything.",
  overview: `<p><strong>Partitioning</strong> (also called sharding) splits one dataset into pieces so that every record has exactly one home partition, and different partitions live on different machines. It is how a system grows past one machine's disk and write throughput. Replication (Chapter 5) can't do that, because every replica stores all the data and applies every write; it scales reads and availability, not volume or writes. Real systems need both, so each partition is itself replicated (<a href="#/ch6/learn/why-partition">why partition</a>). None of this has anything to do with a <em>network</em> partition, which is a failure mode covered in Chapter 8.</p>
<p>The central tension lives in the function that decides where a key goes. It has to spread data <em>and</em> load evenly, keep the records your most important queries read together on one partition, and let the cluster change size without moving everything. Those goals pull against each other. Sorted key ranges keep scans cheap but pile sequential writes onto one partition; hashing spreads writes but scatters every range query; and no function can split a single hot key. Whatever the design leaves off the single-partition path (queries by another attribute, cross-entity ranges, multi-key transactions) pays in scatter-gather reads, slower writes or distributed coordination.</p>
<p>The ideas build in order. First come the two placement functions, <a href="#/ch6/learn/key-range">key ranges</a> and <a href="#/ch6/learn/hash-partitioning">hashing</a>, plus the compound keys and co-location that combine them, then <a href="#/ch6/learn/hot-spots">hot spots</a>, the skew no partitioner removes. <a href="#/ch6/learn/secondary-indexes">Secondary indexes</a> force a choice between paying on writes (global, term-partitioned) and paying on reads (local, scatter-gather). Then the cluster changes: <a href="#/ch6/learn/rebalancing">rebalancing</a> shows why hash mod N fails and what consistent hashing fixes, <a href="#/ch6/learn/rebalancing-strategies">three strategies</a> decide how many partitions exist and what moves, <a href="#/ch6/learn/rebalancing-operations">operations</a> asks who should trigger a move, and <a href="#/ch6/learn/request-routing">request routing</a> keeps every client pointed at the current owner, a first taste of the agreement problem that Chapter 9 solves with consensus.</p>`,

  // ------------------------------------------------------------------
  // CONCEPTS (teaching order, grouped by deep-dive section)
  // ------------------------------------------------------------------
  concepts: [
    // --- why-partition ---
    {
      id: "partition",
      term: "Partition (shard)",
      def: `A slice of a dataset. Every record (row, document, key-value pair) belongs to <strong>exactly one partition</strong>, chosen by a deterministic function of its key, and each partition behaves like a small database of its own that can live on its own machine. Some operations still have to span partitions. Not to be confused with a <strong>network partition</strong> (Chapter 8), which is a communication failure between nodes.`,
      problem: `One machine has finite disk, write throughput and CPU, and replication copies everything everywhere, so it cannot raise those limits. An 8 TB database taking 25,000 writes/s gains nothing from read replicas: each replica stores all 8 TB and replays every write.`,
      why: `Partitioning is what scales <strong>data volume and write throughput</strong>: in theory 10 nodes hold 10 times the data and serve 10 times the single-partition queries. That only holds if data and load spread evenly. <strong>Skew</strong> wastes nodes, and a <strong>hot spot</strong> can leave 10 nodes delivering the throughput of one. Placement has to be a function of the key: random placement balances perfectly, but then a lookup must ask every node. Operations that span partitions (secondary-index queries, joins, multi-key transactions) are where the cost and complexity live.`,
      ex: `Every system names it differently: <em>shard</em> (MongoDB, Elasticsearch, SolrCloud), <em>region</em> (HBase), <em>tablet</em> (Bigtable), <em>vnode</em> or token range (Cassandra, Riak), <em>vBucket</em> (Couchbase), <em>split</em> (Spanner); Kafka partitions are partitioned logs. Elasticsearch shards are document-partitioned: each one is a complete Lucene index over its own documents. In Cassandra, <em>partition</em> means something smaller, the rows that share one partition key; the token range is the unit of placement. Notion split its monolithic Postgres into 480 logical shards keyed by workspace ID.`,
      section: "why-partition",
    },
    {
      id: "partitioning-and-replication",
      term: "Partitioning + replication",
      def: `Each partition is copied to several nodes, and each node stores replicas of many partitions. In leader-based systems a node is typically <strong>leader for some partitions and follower for others</strong>; in leaderless systems a partition's replicas are peers.`,
      problem: `Partitioning alone makes every node a single point of failure for its slice of the data; replication alone cannot grow beyond one machine's storage and write capacity. Combining them gives scale and fault tolerance together.`,
      why: `The two choices are mostly independent: any replication scheme (single-leader, multi-leader, leaderless) can be applied per partition. Spreading leaderships evenly spreads write load and the impact of a failure. If one node led every partition, it would take every write, and its death would force a failover for all of them at once.`,
      ex: `A 3-node cluster with 3 partitions, each replicated 3 times: every node leads one partition and follows two. MongoDB runs each shard as a replica set. Kafka spreads partition leaders across brokers and periodically moves leadership back to each partition's preferred replica to keep it balanced. CockroachDB runs one Raft group per range. Cassandra, being leaderless, stores each token range on as many nodes as the replication factor, with no leader.`,
      section: "why-partition",
    },

    // --- key-range ---
    {
      id: "key-range-partitioning",
      term: "Key-range partitioning",
      def: `Each partition owns a <strong>contiguous range of keys</strong>, and keys are kept sorted inside it. Boundaries need not be evenly spaced: they follow where the data actually is, and are set by an administrator or automatically by the database (<a href="#/ch6/concepts/dynamic-partitioning">dynamic partitioning</a>). The sorted list of boundaries is all a router needs to place any key or range.`,
      problem: `Placement must be a function of the key, and many queries scan ranges ("this sensor, last hour", "orders in March"), so you want neighboring keys stored together. Equal-width slices such as A to F, G to L fail immediately, because real keys are not uniform: far more surnames start with S than with X.`,
      why: `A range scan touches only the partitions whose ranges overlap it, and inside each one it is a sequential read of sorted data (SSTables or B-trees, Chapter 3), so the key works like a concatenated index (year, month, day, hour...). The danger is a <strong>moving hot spot</strong>. When a value that grows over time leads the key (a timestamp, auto-increment ID, MongoDB ObjectId, Snowflake ID, UUIDv7 or ULID), every new write lands in the last range while older ranges go cold. The fix is to lead with a well-spread attribute (sensor ID, then timestamp), at the price of one range scan per sensor for an "all sensors, this hour" query. Range partitioning isn't bad; it is dangerous only when access concentrates in one range.`,
      ex: `Bigtable, HBase, RethinkDB, MongoDB ranged sharding (the only option before 2.4), Spanner, CockroachDB, TiKV. Bigtable's Webtable keys pages by reversed hostname (com.cnn.www) so one site's pages are contiguous. HBase's and MongoDB's docs both warn that monotonically increasing keys send every insert to one region or chunk, and Spanner's schema docs recommend UUIDv4 or bit-reversed sequences instead of a sequential first key column.`,
      section: "key-range",
    },

    // --- hash-partitioning ---
    {
      id: "hash-based-partitioning",
      term: "Hash-based partitioning",
      def: `Run the key through a hash function and give each partition a <strong>range of hash values</strong> (evenly spaced or pseudo-randomly chosen boundaries); a key belongs to the partition whose range contains its hash. The hash must be <strong>stable across processes, machines, languages and versions</strong>, but it need not be cryptographically strong. Note that each partition owns a range of hashes: this is not hash mod the number of nodes.`,
      problem: `Key ranges need hand-tuned boundaries and melt under sequential keys. You want any key pattern, including sequential IDs and timestamps, to spread evenly with no tuning.`,
      why: `A well-mixing hash sends similar keys far apart, so sequential and clustered keys stop creating hot spots. The price is <strong>order</strong>: adjacent keys scatter, so a range query on the key becomes a scatter-gather over every partition (MongoDB's hashed sharding broadcasts it; Riak, Couchbase and Voldemort don't support range queries on the primary key at all). Never use a language's built-in hash. Java's <code>Object.hashCode()</code> (identity-based unless a class overrides it), Ruby's <code>Object#hash</code> and Python's <code>hash()</code> on strings (randomized per process since 3.3) can place the same key differently on two app servers. Hashing also cannot fix a single hot key, because identical keys always hash identically.`,
      ex: `Cassandra's Murmur3Partitioner (the default since 1.2; the older RandomPartitioner used MD5), MongoDB hashed sharding (MD5), Voldemort (Fowler-Noll-Vo), Redis Cluster (CRC16 mod 16,384 hash slots), DynamoDB (hashes the partition key), Couchbase (CRC32 into 1,024 vBuckets).`,
      section: "hash-partitioning",
    },
    {
      id: "compound-partition-key",
      term: "Compound partition key",
      def: `A primary key in two parts. The first part, the <strong>partition key</strong>, is hashed to choose the partition; the remaining parts (Cassandra's <strong>clustering columns</strong>, DynamoDB's <strong>sort key</strong>) define the order of rows inside the partition. A query that fixes the partition key can range-scan the rest efficiently.`,
      problem: `Pure hashing kills per-entity range queries; pure ranges create hot spots. You want spread across entities and order within one.`,
      why: `It gives spread <em>across</em> entities and order <em>within</em> one. The design rule: partition key = the entity your most important query is scoped to; clustering key = the order you read in. The limit is that order exists only within one partition-key value, so a cross-entity range ("every user's posts in March") is still a scatter-gather. Per-entity partitions can also grow without bound, so heavy entities usually get a time bucket in the partition key.`,
      ex: `Cassandra <code>PRIMARY KEY ((user_id), posted_at)</code>. DynamoDB partition key + sort key (Query requires equality on the partition key and allows range conditions on the sort key). Discord stored messages under partition key <code>(channel_id, bucket)</code>, with static 10-day buckets, clustered by the time-ordered Snowflake <code>message_id</code>.`,
      section: "hash-partitioning",
    },
    {
      id: "data-colocation",
      term: "Co-location (co-partitioning)",
      def: `Choosing partition keys so that records which are read, joined or updated together <strong>live in the same partition</strong>: every table keyed by <code>tenant_id</code> first, Spanner interleaved child tables, Citus co-located distributed tables, Redis Cluster hash tags.`,
      problem: `Once data is spread across partitions, a join or transaction that touches two partitions needs a scatter-gather or a distributed transaction, which is slower and less available than a single-partition operation.`,
      why: `It is the main design tool for keeping most operations single-partition. Whatever is scoped differently (cross-tenant features, global search, uniqueness of a non-key column) then needs global indexes, derived views or cross-partition transactions, so co-location is a decision about which operations get to be cheap.`,
      ex: `Figma groups tables that share a shard key into "colos" so joins and transactions within a colo stay on one shard. Citus co-locates distributed tables with the same distribution column so joins on it run locally. In Redis Cluster, <code>{user42}.cart</code> and <code>{user42}.profile</code> land in the same slot, because only the substring between the first <code>{</code> and the next <code>}</code> is hashed (if it is non-empty).`,
      section: "hash-partitioning",
    },

    // --- hot-spots ---
    {
      id: "hot-spot",
      term: "Hot spot (skew)",
      def: `A partition that receives a disproportionate share of the load. Causes: one key far more popular than the rest (a celebrity account, a viral post), a range that every write targets (keys that start with "now"), or one entity far bigger than the others. Skew can be in traffic or in size (one huge, ever-growing partition).`,
      problem: `Even perfect hashing sends every request for one key to one partition, so the cluster average looks healthy while that partition throttles or slows everything that shares it.`,
      why: `Neither better hashing nor more nodes helps, because one key never spans two partitions. <strong>Read</strong> hot spots are handled with caches, CDNs, read replicas and request coalescing. <strong>Write</strong> hot spots need the application to split the key (<a href="#/ch6/concepts/key-salting">salting</a>), combine writes before they reach the database, or treat the hot entity specially. Salt only the few keys that are actually hot, and keep a record of which keys are split. Find them with per-key metrics, since per-node averages hide a single hot key.`,
      ex: `A viral post's like counter, a celebrity account, a single giant tenant. DynamoDB caps each partition at 1,000 WCU / 3,000 RCU, so one hot key throttles regardless of the table's total capacity. Discord found that busy channels created hot Cassandra partitions that degraded latency across the cluster, and added data services that coalesce concurrent reads of the same row. Tools for finding hot keys: CloudWatch Contributor Insights (DynamoDB), Key Visualizer (Bigtable, Spanner), <code>redis-cli --hotkeys</code> (needs an LFU eviction policy).`,
      section: "hot-spots",
    },
    {
      id: "key-salting",
      term: "Key salting (write sharding)",
      def: `Splitting one hot key into <strong>k sub-keys</strong> by appending a random or calculated suffix (<code>post:42#0</code> ... <code>post:42#k-1</code>) so its writes spread over up to k partitions; reads must fetch and combine all k sub-keys.`,
      problem: `A single hot key always maps to one partition, so neither better hashing nor more nodes can relieve it.`,
      why: `It spreads a write hot spot that no partitioner can split, at the price of k-way reads (k requests, merge work, and the tail latency of the slowest) plus bookkeeping about which keys are split. A <strong>random suffix</strong> spreads writes most evenly, but any read must ask all k. A <strong>calculated suffix</strong> such as hash(order_id) mod k still spreads writes and lets you find one specific item directly. Apply it only to the few keys that are actually hot.`,
      ex: `DynamoDB documents this as write sharding, with a random or calculated suffix on the partition key. Size k from the hot key's rate: a key taking 3,000 writes/s of items up to 1 KB needs at least 3 suffixes against the 1,000 WCU per-partition limit, and more for headroom. Sharded counters for like and view counts work the same way: increment a random shard, sum all shards to read.`,
      section: "hot-spots",
    },

    // --- secondary-indexes ---
    {
      id: "partitioning-secondary-indexes-local-by-document",
      term: "Partitioning secondary indexes (local/by document)",
      def: `Each partition maintains a secondary index covering only its own documents (a <strong>document-partitioned</strong> index). Adding, updating or deleting a document touches one partition. A query by the indexed value must go to every partition and merge the results (<a href="#/ch6/concepts/scatter-gather">scatter-gather</a>), unless the query also names the partition key.`,
      problem: `Queries by non-key attributes ("all red cars") need an index, and an index that lives with its documents keeps writes local. One unpartitioned index would recreate the single-machine bottleneck.`,
      why: `Writes stay cheap and the index is always consistent with its documents. Reads pay: every query asks every partition, so cost grows with partition count and latency is set by the slowest partition (tail latency amplification, Chapter 1); running the requests in parallel does not remove that. A local index also cannot enforce uniqueness of a column that isn't part of the partition key. Vendors advise designing keys so the busiest secondary-index queries also include the partition key, which isn't always possible, especially with several indexes in one query.`,
      ex: `MongoDB, Riak, Cassandra (including 5.0's Storage-Attached Indexing), Elasticsearch, SolrCloud, VoltDB. An Elasticsearch search goes to one copy of every shard and a coordinating node merges the top hits. DynamoDB local secondary indexes are the managed version: same partition key, different sort key, strongly consistent reads allowed.`,
      section: "secondary-indexes",
    },
    {
      id: "partitioning-secondary-indexes-global-by-term",
      term: "Partitioning secondary indexes (global/by term)",
      def: `One index covering all the data, itself partitioned <strong>by the indexed value</strong> (the "term"): either by the term itself, which keeps range scans over values (price between 1,000 and 2,000), or by a hash of the term, which spreads load more evenly. All entries for <code>color:red</code> sit on one index partition, whichever data partitions the cars live on.`,
      problem: `Local indexes turn every query into a scatter-gather; partitioning the index by value lets a query ask one place.`,
      why: `Reads hit one index partition, plus fetching the documents, unless the index stores the needed attributes as DynamoDB projections do. Writes pay: one document write can touch several remote index partitions; repainting a car from red to silver updates the data partition and both the "red" and "silver" index partitions. Keeping them in sync atomically needs a distributed transaction, so many systems update global indexes <strong>asynchronously</strong> and a read right after a write may miss it. A global index that is updated transactionally is also how you enforce uniqueness of a non-key column.`,
      ex: `DynamoDB global secondary indexes are asynchronous and allow only eventually consistent reads, and an under-provisioned GSI throttles writes to the base table. The book cites Riak Search and Oracle, which lets you choose local or global partitioned indexes. Spanner, CockroachDB, YugabyteDB and TiDB store each index as its own key range and update it in the same transaction as the row: fresh reads, slower writes.`,
      section: "secondary-indexes",
    },
    {
      id: "scatter-gather",
      term: "Scatter-gather query",
      def: `A query sent to every partition (or many of them) in parallel, whose partial results a coordinator merges. Its cost grows with the number of partitions and its latency is that of the <strong>slowest</strong> partition.`,
      problem: `When the data a query needs could be on any partition (a local secondary-index lookup, a range query over hashed keys), there is no way to target a single partition.`,
      why: `It is fine for rare or small queries and costly as the main access path, because every partition does work for every query and the slowest one sets the latency (tail latency amplification, Chapter 1). If each partition is slow 1% of the time, a 100-way query is slow about 63% of the time (1 - 0.99<sup>100</sup>). It is needed only when the query lacks the partition key: a local-index query that names the partition key is routed to one partition.`,
      ex: `Elasticsearch searches every shard (query-then-fetch); MongoDB's mongos broadcasts queries that don't include the shard key; range queries on hash-partitioned keys; Figma's DBProxy runs scatter-gather for queries without the shard key.`,
      section: "secondary-indexes",
    },

    // --- rebalancing ---
    {
      id: "rebalancing",
      term: "Rebalancing",
      def: `Moving partitions (data and load) from one node to another when the cluster changes: more data needs more disks, more queries need more CPUs, and a failed machine's partitions need new homes. A good rebalance meets three requirements: <strong>load is shared fairly afterwards</strong>, the database <strong>keeps serving reads and writes during the move</strong> (the old owner keeps serving until cut-over), and <strong>no more data moves than necessary</strong>.`,
      problem: `Data, load and machines change, so partitions must move without downtime and without moving everything.`,
      why: `Moving data competes with production traffic for network, disk and CPU, and for a cache tier the real damage is the miss storm on the store behind it. So placement must be decoupled from node count: map keys to partitions with a function that never changes, then move whole partitions between nodes. Done badly, or automatically at the wrong moment, rebalancing amplifies failures (<a href="#/ch6/concepts/automatic-rebalancing">automatic vs manual</a>).`,
      ex: `Adding an 11th node to a cluster of 10 with 1,000 fixed partitions moves about 91 partitions (1/11), all to the new node. Notion re-sharded from 32 to 96 Postgres instances by moving whole logical shards, without changing its 480 logical shards. Elasticsearch waits 1 minute by default after a node leaves before reallocating its shards, so a quick restart doesn't trigger a full reshuffle.`,
      section: "rebalancing",
    },
    {
      id: "hash-mod-n",
      term: "Hash mod N (anti-pattern)",
      def: `Placing keys with node = hash(key) mod N, where N is the number of nodes. Changing N to N + 1 remaps about <strong>N/(N+1)</strong> of all keys, most of them between nodes that were already in the cluster. The book's example: a key hashing to 123456 lives on node 6 when N = 10, node 3 when N = 11, and node 0 when N = 12.`,
      problem: `It is the obvious way to turn a hash into a node and works until the cluster changes size; then almost all data (or all cache entries) must move at once.`,
      why: `A key stays put only if hash mod N equals hash mod (N+1), which holds for about 1 key in N+1. Going from 10 to 11 nodes therefore moves about 91% of keys, when the minimum needed is the new node's fair share, about 9%. The lesson is to <strong>decouple placement from node count</strong>: move partitions, not keys. "Mod" itself isn't the problem: hash mod a <em>fixed</em> partition count, like Redis Cluster's CRC16 mod 16,384, is fine.`,
      ex: `Going from 10 to 11 memcached servers with hash % N sends about 91% of lookups to a server that doesn't have the key, so almost the whole read load lands on the database at once. Last.fm released libketama in 2007 to fix exactly this for memcached clients.`,
      section: "rebalancing",
    },
    {
      id: "consistent-hashing",
      term: "Consistent hashing",
      def: `Hash keys and nodes onto the same ring (hash space). Each node owns one or more points (tokens), and a key belongs to the first token clockwise from its hash. Adding a node takes over only the arcs just before its tokens: going from N to N + 1 nodes moves about <strong>1/(N+1)</strong> of the keys on average, all of them to the new node.`,
      problem: `Caches and stores using hash mod N remap nearly every key when a server is added or removed.`,
      why: `It makes membership changes cheap, with two caveats. First, with <strong>one token per node</strong> the arcs are random and very uneven (the largest is often two or more times the fair share; in the rebalancing sandbox one of 4 nodes owns about 55% and another under 2%), and a leaving node dumps its whole load on one neighbor; even load needs many tokens per node (<a href="#/ch6/concepts/virtual-nodes">virtual nodes</a>) or a token allocator, and "moves 1/(N+1)" is an average, not a per-node guarantee. Second, the term is used inconsistently: the book prefers "hash partitioning", and "consistent" has nothing to do with replica consistency or ACID consistency. In the book's taxonomy, random tokens per node (Cassandra, Ketama) are partitioning proportionally to nodes, the closest match to Karger's original definition.`,
      ex: `Karger et al., 1997 (web caches; the basis of Akamai's CDN); Amazon Dynamo (2007, with virtual nodes); Last.fm's libketama for memcached clients; Cassandra tokens. Later alternatives: rendezvous (highest-random-weight) hashing, Google's jump consistent hash (2014, no stored ring, but buckets can only be added or removed at the end) and Maglev hashing for load balancers (2016).`,
      section: "rebalancing",
    },

    // --- rebalancing-strategies ---
    {
      id: "rebalancing-strategies",
      term: "Rebalancing strategies",
      def: `Not hash mod N, which moves almost everything. The three workable schemes: <strong>fixed number of partitions</strong>, many more than nodes, moved whole (Riak, Elasticsearch, Couchbase, Voldemort, Redis Cluster); <strong>dynamic partitioning</strong>, where partitions split when too big and merge when too small (HBase, RethinkDB, MongoDB); and <strong>partitioning proportionally to nodes</strong>, a fixed number of partitions per node that split when a node joins (Cassandra, Ketama).`,
      problem: `You must decide how many partitions exist and when that number changes. Too few and partitions grow huge and cap your node count; too many and per-partition overhead dominates; let them split on their own and a new table starts as one partition.`,
      why: `Each scheme has its own pitfall. <strong>Fixed</strong>: the key-to-partition mapping never changes (only partition-to-node does), which makes moves simple, but the count is chosen up front, caps the number of useful nodes, and is painful to change later. <strong>Dynamic</strong>: no up-front guess, but a new table starts as one partition on one node (so you pre-split), and size-based splits don't cure sequential-key hot spots. <strong>Proportional to nodes</strong>: partition size stays roughly stable as nodes join, but random splits can be unfair (fixed by many tokens or an allocator), and random boundaries require hash partitioning.`,
      ex: `Fixed: Redis Cluster's 16,384 slots, Couchbase's 1,024 vBuckets, Notion's 480 logical shards. Dynamic: HBase regions (split at 10 GB by default), MongoDB chunks, CockroachDB ranges (512 MiB). Proportional: Cassandra's <code>num_tokens</code> (256 historically, 16 since 4.0). The Dynamo paper (section 6.2) describes moving from random tokens per node to equal-sized fixed partitions, which balanced load best and simplified bootstrapping and archival.`,
      section: "rebalancing-strategies",
    },
    {
      id: "dynamic-partitioning",
      term: "Dynamic partitioning",
      def: `Partitions <strong>split</strong> when they exceed a size threshold (HBase: 10 GB by default) and <strong>merge</strong> with a neighbor when they shrink, much like B-tree page splits (Chapter 3), so the number of partitions tracks the data volume. After a split, one half can be moved to another node.`,
      problem: `A fixed partition count must be guessed up front; with unknown or highly variable data sizes partitions end up too large to move cheaply or too small to be worth their overhead, and key-range boundaries would need constant manual tuning.`,
      why: `It adapts to data volume with no up-front guess, and it works for key ranges (HBase, RethinkDB) and for hashed keys (MongoDB since 2.4). Two limits: a new table starts as one partition, so one node takes every write until the first split (<a href="#/ch6/concepts/pre-splitting">pre-splitting</a> fixes that), and with sequential keys only the newest partition grows and splits, so the hot spot just moves along. In HBase, both daughter regions initially stay on the parent's RegionServer and the balancer moves them later; region files live in HDFS, so a move hands over files rather than copying them.`,
      ex: `HBase regions, Bigtable tablets (roughly 100-200 MB in the 2006 paper), MongoDB chunks (ranged or hashed), CockroachDB ranges (512 MiB default, also split by load, merged when small). Modern MongoDB differs from the book's description: since 6.0.3 the balancer distributes data by size and no longer splits chunks automatically (default chunk size was 64 MB, 128 MB from 6.0).`,
      section: "rebalancing-strategies",
    },
    {
      id: "pre-splitting",
      term: "Pre-splitting",
      def: `Creating initial partition boundaries for an empty table (HBase, MongoDB) so that writes spread across nodes from the start.`,
      problem: `With dynamic partitioning a new table begins as a single partition on a single node, which absorbs every write until enough data accumulates to split.`,
      why: `It removes the single-partition start-up bottleneck, but only if you know the key distribution in advance, and it cannot help keys that always increase: they still pile into the last range. Recent HBase split policies also split a table's first regions at much smaller sizes than the 10 GB maximum, which softens the problem without solving it.`,
      ex: `HBase tables created with explicit split keys; bulk loads into a table pre-split at boundaries sampled from the input. Sharding an empty MongoDB collection on a hashed shard key creates initial chunks across the shards automatically.`,
      section: "rebalancing-strategies",
    },
    {
      id: "virtual-nodes",
      term: "Virtual nodes (tokens per node)",
      def: `Each physical node owns many small hash ranges (tokens) instead of one. The number per node is fixed, so ranges shrink as nodes join. In the classic scheme a joining node splits randomly chosen ranges and takes half of each. Cassandra used 256 random tokens per node; since 4.0 it defaults to 16, placed by a token-allocation algorithm.`,
      problem: `With one random range per node, ownership is wildly uneven and a joining or leaving node shifts load onto a single neighbor.`,
      why: `Many small ranges per node average out random range sizes, let bigger machines take more ranges, and spread a joining or failing node's work across many peers. With V random tokens per node, the spread in per-node ownership shrinks roughly as 1/&radic;V: about 6% at 256 tokens, about 25% at 16. That is why Cassandra's lower default relies on the token allocator added in 3.0 rather than on randomness.`,
      ex: `Cassandra <code>num_tokens</code> (256 historically, 16 since 4.0 with the allocator); Dynamo's virtual nodes. Naming trap: Riak also says "vnodes", but its total number (the ring size) is fixed, which makes Riak a fixed-number-of-partitions scheme, whereas Cassandra's vnodes are a fixed number per node.`,
      section: "rebalancing-strategies",
    },

    // --- rebalancing-operations ---
    {
      id: "automatic-rebalancing",
      term: "Automatic vs manual rebalancing",
      def: `Whether the system decides and executes partition moves itself, or proposes a plan that an operator commits. Fully automatic rebalancing is convenient, but combined with automatic failure detection it can turn into a <strong>cascading failure</strong>.`,
      problem: `Moving partitions is expensive and competes with production traffic; triggering it automatically when a node merely looks slow can overload the remaining nodes and the network.`,
      why: `The cascade: an overloaded node responds slowly, peers' timeouts declare it dead (a timeout can't tell slow from dead, Chapter 8), its partitions are streamed to the others, which then get slow and are declared dead in turn. Automation saves toil and reacts quickly, so the safe pattern is <strong>automatic planning with delayed, throttled or human-approved execution</strong>. Keep two jobs separate: re-replicating data after a real failure is urgent; evening out load can wait.`,
      ex: `Per the book, Couchbase, Riak and Voldemort generate a suggested assignment that an administrator commits. Elasticsearch delays reallocating a departed node's shards (1 minute by default) and throttles recovery traffic. Kafka partition reassignment is operator-driven with an optional replication throttle, and LinkedIn's Cruise Control automates it with explicit goals. AWS's April 2011 EBS outage shows the failure mode: after a network change isolated many nodes from their replicas, they all searched for space to re-mirror at once, a "re-mirroring storm" that exhausted capacity in the Availability Zone.`,
      section: "rebalancing-operations",
    },

    // --- request-routing ---
    {
      id: "request-routing",
      term: "Request routing (service discovery)",
      def: `How a request for key k reaches the node that currently owns k's partition. Three patterns: (1) clients contact <strong>any node</strong>, which serves the request or forwards it; (2) a partition-aware <strong>routing tier</strong> that holds no data; (3) <strong>partition-aware clients</strong> that connect to the owner directly. Every approach also needs the old owner to <strong>refuse requests for partitions it no longer owns</strong>; otherwise a stale router can get an OK from a leftover copy and the acknowledged write is lost.`,
      problem: `Partitions move, so clients need a reliable way to find the current owner. Hard-coded addresses break on the first rebalance, asking every node is wasteful, and independent views of the map disagree.`,
      why: `It is service discovery with a stricter requirement: everyone must agree on a map that changes during rebalancing, which is a consensus problem (Chapter 9). Systems keep the map in a coordination service that routers subscribe to (ZooKeeper, etcd, MongoDB's config servers) or spread it by gossip (Cassandra, Riak). Cached copies will be stale sometimes, so maps carry versions, and owners reject or redirect stale requests (Redis <code>MOVED</code>/<code>ASK</code>, MongoDB stale-version errors, Kafka "not leader" errors) so the router refreshes and retries. Kafka itself replaced ZooKeeper with KRaft (production-ready in 3.3, ZooKeeper removed in 4.0). Node IP addresses change rarely, so DNS is enough for those.`,
      ex: `Any node: Cassandra (gossip, usually with token-aware drivers that go straight to a replica), Riak, Elasticsearch coordinating nodes. Routing tier: MongoDB's mongos, Vitess's VTGate (topology in etcd, ZooKeeper or Consul), Couchbase's moxi in the book's era. Partition-aware clients: Redis Cluster clients, Kafka clients. ZooKeeper holds the map for HBase, SolrCloud and pre-KRaft Kafka; LinkedIn's Espresso uses Helix, which builds on ZooKeeper.`,
      section: "request-routing",
    },
    {
      id: "parallel-query-execution",
      term: "Parallel query execution (MPP)",
      def: `Massively parallel processing (MPP) databases split a complex analytic query (joins, filters, aggregations) into stages that run across many partitions at once, then combine the results.`,
      problem: `Routing a request to one partition works for key lookups, but analytic queries touch most of the data; executing them through a single node would not scale.`,
      why: `Partitioning is also how analytic databases get parallelism: each partition scans and aggregates its share, and partial results are combined. The same idea that makes OLTP lookups single-partition makes OLAP scans many-partition, by design.`,
      ex: `MPP data warehouses such as Teradata, Greenplum and Amazon Redshift. Chapter 10 covers the join and aggregation techniques.`,
      section: "request-routing",
    },
  ],

  // ------------------------------------------------------------------
  // CHEATSHEET
  // ------------------------------------------------------------------
  cheatsheet: [
    {
      title: "Three meanings of \"partitioning\" (and one that isn't)",
      type: "table",
      headers: ["Meaning", "What gets split", "Adds capacity?", "Example"],
      rows: [
        ["Horizontal partitioning / sharding (this chapter)", "Rows or documents of one dataset, spread across machines by key", "Yes: storage and write throughput", "MongoDB shards, Cassandra, Spanner, Vitess"],
        ["Vertical partitioning", "Whole tables (or column groups) moved to different databases", "Yes, until one table outgrows its machine", "Figma moved groups of tables to their own databases before sharding rows"],
        ["Single-node table partitioning", "One table split into pieces on ONE server", "No: gives partition pruning and cheap retention (drop a month)", "PostgreSQL declarative partitioning, MySQL partitioned tables"],
        ["Network partition (Chapter 8)", "Nothing: nodes simply can't reach each other", "Not applicable: it is a failure mode", "A switch failure splitting a cluster in two"],
      ],
      note: "Interviewers notice when these get mixed up. Say \"shard\" or \"partition the data by key\" when you mean the first row.",
    },
    {
      title: "What each system calls a partition",
      type: "table",
      headers: ["System", "Name", "Worth knowing"],
      rows: [
        ["MongoDB, Elasticsearch, SolrCloud", "Shard", "Elasticsearch and Solr shards are complete Lucene indexes over their own documents (document-partitioned)"],
        ["HBase", "Region", "Contiguous row-key range; splits at 10 GB by default"],
        ["Bigtable", "Tablet", "Row range, roughly 100-200 MB in the 2006 paper"],
        ["Spanner", "Split", "Key range, split and moved by size and load"],
        ["CockroachDB", "Range", "512 MiB default; one Raft group per range"],
        ["Cassandra", "Vnode / token range", "In CQL, a \"partition\" is the set of rows sharing one partition key"],
        ["Riak", "Vnode", "The ring size is fixed, so it is a fixed-partition scheme"],
        ["Couchbase", "vBucket", "1,024 per bucket, moved whole"],
        ["Redis Cluster", "Hash slot", "16,384 slots: CRC16(key) mod 16384"],
        ["DynamoDB", "Partition", "About 10 GB and 3,000 RCU / 1,000 WCU each"],
        ["Kafka", "Partition", "An ordered log; per-key order holds only within one partition"],
      ],
    },
    {
      title: "Key-range vs hash vs compound partitioning",
      type: "table",
      headers: ["", "Key-range", "Hash", "Compound (hash the entity, sort within)"],
      rows: [
        [`<span style="white-space:nowrap">Placement</span>`, "Contiguous key range; keys sorted inside", "Range of hash values of the whole key", "Hash of the partition key; clustering/sort key orders rows inside"],
        [`<span style="white-space:nowrap">Distribution</span>`, "Can be uneven; boundaries follow the data", "Even for distinct keys", "Even across entities; one big entity = one big partition"],
        ["Range scans on the key", "Efficient: only overlapping partitions", "Scatter-gather to every partition", "Efficient within one entity; cross-entity ranges scatter"],
        ["Hot spots", "Sequential keys: timestamps, auto-increment, ObjectId, Snowflake, UUIDv7", "Single hot key only", "Hot entity only (celebrity, whale tenant)"],
        [`<span style="white-space:nowrap">Boundaries</span>`, "By data: set by an admin or by automatic splits", "Ranges of hash values (even or pseudo-random)", "Hash of the partition key"],
        [`<span style="white-space:nowrap">Examples</span>`, "Bigtable, HBase, MongoDB ranged, Spanner, CockroachDB, TiKV", "Cassandra (Murmur3), MongoDB hashed, Redis Cluster, DynamoDB, Riak", "Cassandra PRIMARY KEY ((a), b), DynamoDB partition + sort key, Discord (channel_id, bucket)"],
        ["Pick it when", "Range scans matter and access is spread over the key space", "Point lookups dominate; keys are sequential or clustered", "Most queries are \"one entity, an ordered range\""],
      ],
      note: "The hash must be stable across processes and versions (Murmur3, MD5, FNV, CRC16), not Java's Object.hashCode(), Ruby's Object#hash or Python's per-process randomized str hash. It need not be cryptographic.",
    },
    {
      title: "Choosing a partition key",
      type: "list",
      items: [
        "<strong>Start from the access pattern</strong>, not the schema: the most frequent, latency-critical queries and transactions should be answerable from one partition, so the key is the entity they are scoped to (user, tenant, device, channel).",
        "<strong>High cardinality</strong>: far more distinct values than partitions. Status, country or a boolean can't spread.",
        "<strong>Even access, not just even key counts</strong>: check the biggest tenant and the most-followed user.",
        "<strong>No monotonically increasing prefix</strong> in a range-partitioned store (timestamp, auto-increment, ObjectId, Snowflake, UUIDv7, ULID): hash it, prefix it with a spread attribute, or bit-reverse it.",
        "<strong>Bounded size per key value</strong>: add a time bucket for entities that grow forever (Discord: channel_id + 10-day bucket).",
        "<strong>Co-locate what is read, joined or updated together</strong>: tenant_id first everywhere, compound keys, Spanner interleaved tables, Redis hash tags <code>{user42}</code>.",
        "<strong>Stability</strong>: changing the key later means moving every row, so get it right early.",
        "<strong>Name the cost</strong>: anything not scoped to the key becomes a scatter-gather or needs a global index.",
      ],
    },
    {
      title: "Hot-spot mitigations",
      type: "list",
      items: [
        "<strong>Salt only the hot keys</strong>: <code>post:42</code> &rarr; <code>post:42#00</code> ... <code>#99</code>. Writes spread over up to k partitions; reads fan out to all k sub-keys and merge. Keep a registry of which keys are split, and into how many.",
        "<strong>Calculated suffix</strong> (hash(item_id) mod k) instead of random: still spreads writes, and you can find one specific item without fanning out.",
        "<strong>Write combining</strong>: buffer increments in app servers and flush \"+n\" periodically. No read fan-out, but counts lag and a crash loses the buffer.",
        "<strong>Cache hot reads</strong> (application cache, Redis, DAX, CDN) and read from replicas; read hotness is the easy kind.",
        "<strong>Request coalescing</strong>: merge concurrent identical reads into one database query (Discord's data services; Facebook memcache leases against thundering herds).",
        "<strong>Compound or time-bucketed keys</strong>: add a high-cardinality field, or a time bucket so one entity's partition stays bounded (Discord: channel_id + 10-day bucket).",
        "<strong>Special-case the hot entity</strong>: e.g. Twitter's hybrid fan-out for celebrities (Chapter 1), or a dedicated shard for a whale tenant.",
        "<strong>Denormalize</strong>: store popular data redundantly across partitions so reads don't all hit one.",
        "<strong>Automatic split-for-heat / load-based splitting</strong> (DynamoDB adaptive capacity, CockroachDB): helps hot ranges, cannot split one key beyond one partition's limit.",
      ],
    },
    {
      title: "Local vs global secondary index",
      type: "table",
      headers: ["", "Local (by document)", "Global (by term)"],
      rows: [
        ["Index lives", "With its documents, one index per partition", "Separately, partitioned by the indexed value (or a hash of it)"],
        ["Writes", "Cheap: one partition", "Data partition + every affected index partition (up to 2 per changed value)"],
        ["Reads", "Scatter-gather to all partitions, unless the query names the partition key", "One index partition, plus fetching the documents"],
        ["Read latency", "Set by the slowest partition (tail amplification)", "One hop"],
        ["Freshness", "Always consistent with its documents", "Async in DynamoDB GSIs (eventual only); synchronous in Spanner/CockroachDB"],
        ["Uniqueness constraints", "Impossible for a non-partition-key column (possible if the key is prefixed by the partition key)", "Possible, if updated synchronously"],
        ["Examples", "MongoDB, Elasticsearch, SolrCloud, Cassandra, Riak, VoltDB, DynamoDB LSI", "DynamoDB GSI, Riak Search, Oracle (choice of either), Spanner/CockroachDB (synchronous)"],
      ],
      note: "DynamoDB LSI: same partition key, strongly consistent reads allowed, must be created with the table, 10 GB limit per partition-key value. DynamoDB GSI: own partition key, eventually consistent reads only, can be added any time, and an under-provisioned GSI throttles base-table writes.",
    },
    {
      title: "Rebalancing strategies",
      type: "table",
      headers: [`<span style="white-space:nowrap">Strategy</span>`, "What stays fixed", "When a node joins", "Examples", "Main pitfall"],
      rows: [
        [`<span style="white-space:nowrap">hash mod N</span> (anti-pattern)`, "Nothing: placement depends on N", "About N/(N+1) of keys move, mostly between existing nodes", "Naive memcached clients", "Near-total reshuffle or cache-miss storm"],
        [`<span style="white-space:nowrap">Fixed number</span> <span style="white-space:nowrap">of partitions</span>`, "The partition count (many more than nodes); key to partition never changes, so partitions grow with the data", "Steals whole partitions from every node: about 1/(N+1) of the data moves", "Riak, Elasticsearch, Couchbase (1,024 vBuckets), Voldemort, Redis Cluster (16,384 slots), Notion (480)", "Choosing the count: it caps the node count; too few makes moves slow, too many adds overhead"],
        [`<span style="white-space:nowrap">Dynamic</span>`, "Size thresholds (HBase 10 GB, CockroachDB 512 MiB), so partition size stays bounded", "Existing partitions move to it; the count follows data volume", "HBase, Bigtable, RethinkDB, MongoDB (ranged and hashed), CockroachDB", "A new table is one partition (pre-split); sequential keys stay hot"],
        [`<span style="white-space:nowrap">Proportional</span> <span style="white-space:nowrap">to nodes</span>`, "Partitions per node (Cassandra num_tokens); size grows with data and shrinks as nodes join", "Splits about num_tokens random ranges and takes half of each", "Cassandra (256, 16 since 4.0), Ketama", "Random splits are unfair without many tokens or an allocator; needs hash partitioning"],
      ],
      note: "In the book's description the old owner keeps serving reads and writes for a partition until the transfer completes. Some systems also send writes to the new owner during the move (Cassandra's pending ranges for a joining node), but don't assume dual writes in general.",
    },
    {
      title: "Request routing",
      type: "table",
      headers: ["Approach", "Hops", "Who keeps the map", "Stale map handled by", "Examples"],
      rows: [
        ["Any node + forward", "Up to 2", "Every node, via gossip", "The receiving node forwards to the current owner", "Cassandra, Riak, Elasticsearch coordinating nodes"],
        ["Routing tier", "2 (client, router, owner)", "Routers, from config servers, ZooKeeper or etcd", "Shard rejects a stale version; router refreshes and retries", "MongoDB mongos, Vitess VTGate, Couchbase moxi (book era)"],
        ["Partition-aware client", "1", "The client library's cache", "MOVED / ASK or \"not leader\" errors trigger a refresh", "Redis Cluster, Kafka, Cassandra token-aware drivers"],
      ],
      note: "All three need one authoritative, versioned map (ZooKeeper for HBase, SolrCloud and pre-KRaft Kafka; Helix for Espresso; MongoDB config servers; KRaft in Kafka 3.3+) and old owners that refuse partitions they no longer own. Redis MOVED = ownership changed, update the map; ASK = one-off redirect during a migration, don't update it.",
    },
    {
      title: "Cross-partition operations",
      type: "note",
      body: `<p><strong>Avoid them by design first</strong>: co-locate by key (tenant_id first everywhere, Spanner interleaved tables, Citus co-located tables, Redis hash tags) or denormalize so the read needs one partition.</p>
<p><strong>Reads</strong> that must span partitions: scatter-gather (cost grows with partition count, latency set by the slowest), a global index, or a derived view maintained from a change stream (Chapters 11-12); heavy joins go to an MPP or analytics store.</p>
<p><strong>Writes</strong> that must span partitions: two-phase commit (Chapter 9; native in Spanner and CockroachDB), paying extra round trips, locks held across the network and blocking if the coordinator fails; or a saga of single-partition steps with compensations and idempotent retries, which exposes intermediate states.</p>`,
    },
    {
      title: "Decision guide",
      type: "table",
      headers: ["If you need", "Do this", "And accept"],
      rows: [
        ["Range scans over the key, access spread across it", "Key-range partitioning", "Hot spots if a sequential value leads the key"],
        ["Even load for point lookups", "Hash the key", "No efficient range scans on the key"],
        ["Per-entity ordered reads at scale (feeds, chat, metrics)", "Compound key: hash the entity, cluster by time, bucket by time", "Cross-entity queries scatter"],
        ["Fast queries by a non-key attribute, few writes", "Global (term-partitioned) index", "Slower or asynchronous index writes; possibly stale reads"],
        ["Write-heavy data with occasional secondary queries", "Local (document-partitioned) index", "Scatter-gather on every index read"],
        ["A unique non-key column (email, username)", "Synchronous global index, or a value-to-owner table written with a conditional write in the same transaction", "A cross-partition write on every change"],
        ["Unpredictable data volume", "Dynamic partitioning, plus pre-splitting", "Single-partition start; split and merge churn"],
        ["Predictable growth, simple operations", "Fixed partitions, several per node at the largest expected scale", "Changing the count later is hard"],
        ["One hot key", "Salt it, combine writes, or cache reads", "k-way reads and bookkeeping, or lag"],
        ["Unique IDs across shards", "Time-ordered IDs (Snowflake, UUIDv7) under hash partitioning, or IDs that embed the logical shard (Instagram)", "A time-ordered ID leading a range-partitioned key is a hot spot"],
        ["\"Newest N\" lists or paging across all shards", "Keyset (cursor) paging over a scatter-gather, or a time-bucketed global view", "A fan-out per page, or a lagging view"],
        ["A different partition key on a live system", "New layout fed by CDC, throttled backfill, shadow-read verification, cut over reads then writes, reverse replication for rollback", "A migration project and double storage for its duration"],
      ],
    },
    {
      title: "Formulas",
      type: "list",
      items: [
        "<strong>hash mod N, going N &rarr; N+1</strong>: about N/(N+1) of keys move (91% for 10 &rarr; 11); the minimum, the new node's fair share, is about 1/(N+1) (9%). Removing a node from N moves about (N-1)/N.",
        "<strong>Book example</strong>: 123456 mod 10 = 6, mod 11 = 3, mod 12 = 0.",
        "<strong>Scatter-gather tail</strong>: P(query is slow) = 1 - (1 - p)<sup>n</sup> for n partitions each slow with probability p. p = 1%, n = 100 gives about 63%.",
        "<strong>Token balance</strong>: with V random tokens per node, per-node ownership varies by roughly 1/&radic;V of the mean (256 tokens: about 6%; 16 tokens: about 25%, hence the allocator).",
        "<strong>Salting</strong>: k sub-keys divide one key's write rate by k; each aggregate read costs k requests (random suffix) or 1 request for one known item (calculated suffix). Minimum k = hot key's rate / per-partition limit.",
        "<strong>Partition count</strong> &ge; max(peak throughput / per-partition throughput, largest expected node count &times; partitions per node).",
        "<strong>Global index write cost</strong>: 1 data partition + up to 2 index partitions per changed indexed value (remove old term, add new).",
        "<strong>Two-phase commit</strong>: 2 parallel rounds whatever the participant count; more participants raise the chance one is slow or fails and hold locks on more machines.",
      ],
    },
    {
      title: "Numbers worth remembering",
      type: "list",
      items: [
        "hash mod N: about 91% of keys move going 10 &rarr; 11 nodes, 90% going 9 &rarr; 10; the fair share is about 1/(N+1).",
        "Redis Cluster: 16,384 hash slots. Couchbase: 1,024 vBuckets per bucket.",
        "Cassandra <code>num_tokens</code>: 256 historically, 16 since 4.0 (token allocator since 3.0); Murmur3 tokens span -2<sup>63</sup> to 2<sup>63</sup>-1.",
        "HBase region split: 10 GB (<code>hbase.hregion.max.filesize</code>). Bigtable tablets: about 100-200 MB (2006 paper). CockroachDB ranges: 512 MiB.",
        "MongoDB chunk size: 64 MB, 128 MB from 6.0; balancing by data size and no auto-splitting from 6.0.3 (version-specific).",
        "DynamoDB per partition: 1,000 WCU / 3,000 RCU and about 10 GB; LSI item collection limit 10 GB per partition-key value.",
        "Elasticsearch: default primary shards 5 &rarr; 1 in 7.0; waits 1 minute after a node leaves before reallocating its shards.",
        "Kafka: KRaft production-ready in 3.3 (2022); ZooKeeper mode removed in 4.0 (2025).",
        "Notion: 480 logical shards on 32, later 96, physical Postgres databases. Instagram IDs: 41 bits of time + 13 bits of logical shard + 10 bits of sequence.",
        "Discord: messages keyed by (channel_id, 10-day bucket); in 2022 moved from 177 Cassandra nodes to 72 ScyllaDB nodes, historical-read p99 from 40-125 ms to about 15 ms.",
      ],
    },
  ],

  // ------------------------------------------------------------------
  // INTERVIEW (grouped by deep-dive section)
  // ------------------------------------------------------------------
  interview: [
    // --- why-partition ---
    {
      id: "q08",
      q: "Why is partitioning usually combined with replication?",
      diff: "easy",
      section: "why-partition",
      a: `<p>They solve different problems. <strong>Partitioning</strong> spreads data and write load, so the system can store more than one machine's disk and accept more writes than one machine can. <strong>Replication</strong> keeps copies, so a dead node loses no data and its partitions stay available; it also adds read capacity. Partitioning alone makes every node a single point of failure for its slice, and replication alone never grows past one machine's storage or write throughput.</p>
<ul>
<li><strong>Layout</strong>: each partition has, say, 3 replicas on different nodes (ideally different racks or zones), and each node holds replicas of many partitions. In leader-based systems a node is <strong>leader for some partitions and follower for others</strong>, so write load and the blast radius of a failure are spread: when a node dies, only the partitions it led need a new leader, and their followers sit on many different nodes.</li>
<li><strong>The two choices are mostly independent</strong>: any replication scheme can run per partition. MongoDB runs each shard as a single-leader replica set; Kafka has one leader broker per partition; CockroachDB runs a Raft group per range; Cassandra, leaderless, writes each token range to as many replicas as the replication factor with no leader.</li>
<li><strong>Request path</strong>: route to the right partition first, then to that partition's leader for writes (or to its replicas in a leaderless system); reads go to the leader or, accepting lag, to a follower.</li>
</ul>
<p>Mention balance explicitly: if leaderships pile up on one node, that node takes every write. Kafka periodically moves leadership back to each partition's preferred replica for exactly this reason.</p>`,
      followups: [
        "If a node dies, which partitions are affected and how fast do they recover?",
        "Why spread leaderships evenly instead of putting all leaders on the biggest machine?",
        "Can different partitions use different replication settings?",
      ],
      pitfalls: [
        "Saying replication scales writes",
        "Letting one node lead every partition",
        "Placing all replicas of a partition in the same rack or availability zone",
      ],
    },
    {
      id: "q-multitenant-sharding",
      q: "Design sharding for a multi-tenant SaaS (Slack/Notion-like) where the largest tenant is 10,000x the median.",
      diff: "hard",
      section: "why-partition",
      a: `<p>Start from the access pattern. Almost every query and transaction in a Slack- or Notion-style product is scoped to one workspace, so <strong>partition by tenant (workspace) ID</strong> and keep all of a tenant's data together. Most reads, joins and transactions then stay on one shard. Slack's original MySQL shards were per workspace, and Notion partitioned its Postgres by workspace ID.</p>
<p><strong>Many logical shards on fewer physical databases.</strong> Map tenants to a fixed number of logical shards and place several logical shards on each physical database. Notion uses 480 logical shards (Postgres schemas), first 15 on each of 32 databases, later 5 on each of 96. Rebalancing then means moving whole logical shards, never re-splitting data. Pick a count with many divisors: 480 divides evenly by 32, 40, 48 and 96. A routing layer (a library, or a proxy such as Vitess's VTGate or Figma's DBProxy) maps tenant to logical shard to host.</p>
<p><strong>IDs that carry the shard.</strong> Embedding the logical shard in every ID lets any service route without a lookup. Instagram's 64-bit IDs pack 41 bits of millisecond time, 13 bits of logical shard ID and a 10-bit sequence.</p>
<p><strong>The whale.</strong> At 10,000x the median, one tenant can outgrow a shard by itself:</p>
<ul>
<li>Use a <strong>directory</strong> (tenant to shard lookup) rather than a pure hash, so a whale can be pinned to a dedicated shard and moved on its own.</li>
<li>If even a dedicated shard is too small, partition the whale by a secondary key (channel, page, project), a compound key <code>(tenant, sub-entity)</code>, and accept scatter-gather for its tenant-wide queries.</li>
<li>Protect everyone else with per-tenant rate limits and quotas (noisy neighbors).</li>
</ul>
<p><strong>Cross-tenant features</strong> (shared channels between workspaces, users who belong to many workspaces, global search, admin analytics) don't fit the tenant key. They need global indexes, a separate service keyed differently, or derived data fed by change streams.</p>
<p><strong>Plan resharding from day one</strong>: snapshot and backfill the tenant onto the target, catch up through CDC or double-writes, verify (row counts, checksums, shadow reads), briefly fence writes, flip the routing entry, and delete the old copy after a grace period.</p>`,
      followups: [
        "How do you move one tenant to another shard with no downtime?",
        "How do you handle a feature that spans two tenants?",
        "How do you choose the logical shard count?",
        "How would you generate globally unique IDs that also tell you the shard (Instagram-style)?",
      ],
      pitfalls: [
        "Hashing by row ID (destroys tenant locality and makes every tenant query a scatter-gather)",
        "One physical database per tenant for millions of small tenants",
        "Ignoring the whale tenant until it melts one shard",
      ],
    },

    // --- key-range ---
    {
      id: "q-timeseries-partitioning",
      q: "Design the partitioning for a metrics store ingesting 1M readings/s from 200,000 devices. Most queries fetch one device over a time range; dashboards also show fleet-wide per-minute aggregates.",
      diff: "hard",
      section: "key-range",
      a: `<p><strong>Do the arithmetic first.</strong> 1M readings/s from 200,000 devices is 5 readings per device per second, about 432,000 rows per device per day. With replication factor 3 the cluster absorbs about 3M replica writes per second, so writes must be spread over every node all the time.</p>
<p><strong>Reject a timestamp-leading key.</strong> In a range-partitioned store, keying by time sends every write to the newest range: one hot partition that moves forward forever while the rest serve only cold reads.</p>
<p><strong>Use a compound key</strong>: partition key <code>(device_id, day)</code>, hashed for spread; clustering (sort) key <code>ts</code>. In Cassandra that is <code>PRIMARY KEY ((device_id, day), ts)</code>.</p>
<ul>
<li><strong>Writes</strong>: 200,000 devices give 200,000 active partitions at any moment, spread evenly by the hash. Cardinality is ample.</li>
<li><strong>The main query</strong> ("device X, last 6 hours") reads one partition, or two across midnight, as a contiguous slice in time order. A week-long query reads 7 partitions in parallel.</li>
<li><strong>The bucket bounds partition size</strong>: 432,000 rows at roughly 50 bytes is about 20 MB per device-day, under the commonly cited guideline of about 100 MB per Cassandra partition. A 10-day bucket (Discord's choice for chat channels, which are far less dense) would be about 200 MB; an hourly bucket would make a week-long query touch 168 partitions. Size the bucket from rows per device per bucket and the typical query span.</li>
<li><strong>Retention is cheap</strong>: data expires in whole buckets (TTL plus time-window compaction, or dropping old buckets), with no scattered deletes.</li>
</ul>
<p><strong>Fleet-wide dashboards</strong> must not scatter-gather raw data on every refresh. Maintain per-minute rollups as derived data with a stream processor (Chapter 11), or load the data into a columnar store (Chapter 3), and serve dashboards from that.</p>
<p><strong>Misbehaving devices</strong>: a device that sends 1,000x more makes one oversized, hot partition. Rate-limit at ingestion, or give known-heavy devices smaller buckets or a suffix.</p>
<p><strong>Growth and other stores</strong>: use many partitions or vnodes per node so adding nodes moves only a fair share. On HBase or Bigtable the same shape is a row key of <code>device_id#ts</code>, with a short hash prefix of the device ID if IDs are sequential, and a pre-split table so ingestion starts on every RegionServer.</p>`,
      followups: [
        "How do you choose the bucket size?",
        "One device suddenly sends 1,000x more data. What happens and what do you do?",
        "How do you delete data older than 90 days cheaply?",
        "How would the design change on HBase/Bigtable instead of Cassandra?",
      ],
      pitfalls: [
        "Partitioning by timestamp 'for efficient time ranges'",
        "Hashing the full (device, timestamp) key, which destroys per-device range scans",
        "Unbounded per-device partitions that grow forever",
        "Answering fleet dashboards with a scatter-gather over raw data",
      ],
    },
    {
      id: "q-sharded-ids",
      q: "How do you generate unique IDs in a sharded database, and how does the ID format interact with partitioning?",
      diff: "medium",
      section: "key-range",
      a: `<p><strong>Per-shard auto-increment collides</strong>: shard 1 and shard 2 both hand out id 1001. The classic patches are an offset and step per shard (MySQL's <code>auto_increment_increment</code> and <code>auto_increment_offset</code>), which is rigid when the shard count changes, or a central ticket server (Flickr ran two MySQL ticket servers, one issuing odd and one even IDs), which is one more service in every insert's path. Most designs instead generate IDs without coordination:</p>
<ul>
<li><strong>Random UUIDv4</strong>: 122 random bits, no coordination, perfect spread. Costs: 128 bits per key, no time order, and random inserts scatter across each shard's B-tree, hurting page and cache locality.</li>
<li><strong>Time-ordered IDs</strong>: Twitter's Snowflake (41-bit millisecond timestamp, 10-bit worker ID, 12-bit sequence, so up to 4,096 IDs per millisecond per worker), UUIDv7, ULID, MongoDB ObjectId. They sort by creation time and append neatly to indexes. The generator must handle a clock that steps backwards (refuse or wait rather than reuse IDs), and each worker needs a unique worker ID.</li>
<li><strong>IDs that carry the shard</strong>: Instagram packs 41 bits of time, 13 bits of logical shard ID and a 10-bit per-shard sequence into 64 bits, generated inside Postgres. Any service can route a request from the ID alone, with no lookup. That works because rows never leave their logical shard; logical shards move between machines instead.</li>
</ul>
<p><strong>The partitioning interaction is the part interviewers want.</strong> A time-ordered ID is a monotonically increasing key: as the leading key in a <em>range</em>-partitioned store (HBase, Bigtable, Spanner, CockroachDB, MongoDB ranged sharding) it sends every insert to the newest range, the moving hot spot. Under <em>hash</em> partitioning (Cassandra, DynamoDB, MongoDB hashed sharding) it spreads fine. So either hash the ID for placement, lead the key with an entity (<code>(user_id, tweet_id)</code>), or use a random ID where only point lookups matter, as Spanner's schema guidance recommends.</p>`,
      followups: [
        "Why is a Snowflake ID a fine Cassandra partition key but a poor HBase row-key prefix?",
        "What should an ID generator do when the clock jumps backwards?",
        "How would you route a request if the ID did not encode its shard?",
      ],
      pitfalls: [
        "Per-shard auto-increment with no offsets (duplicate IDs across shards)",
        "Leading a range-partitioned key with a Snowflake ID, UUIDv7 or ObjectId",
        "Ignoring clock rollback in timestamp-based generators",
        "Treating UUIDv4 as free (it costs index locality and 16 bytes per key)",
      ],
    },

    // --- hash-partitioning ---
    {
      id: "q01",
      q: "When would you use hash-based vs key-range partitioning?",
      diff: "medium",
      section: "hash-partitioning",
      a: `<p>The choice is about which queries must be cheap and which access patterns could pile onto one partition.</p>
<ul>
<li><strong>Key-range</strong>: each partition owns a sorted, contiguous key range. Pick it when range scans over the key matter ("events between A and B", prefix queries) and access is spread across the key space. Failure mode: when a value that grows over time leads the key (timestamp, auto-increment ID, ObjectId, Snowflake ID), every write lands in the newest range, a <strong>moving hot spot</strong>. Examples: Bigtable, HBase, MongoDB ranged sharding, Spanner, CockroachDB.</li>
<li><strong>Hash</strong>: each partition owns a range of hash values. Pick it when point lookups dominate and keys may be sequential or clustered: distinct keys spread evenly with no tuning. Cost: a range query on the key must ask every partition. Examples: Cassandra, MongoDB hashed sharding, Redis Cluster, DynamoDB.</li>
<li><strong>Compound, usually the real answer</strong>: hash the entity, sort within it. Cassandra's <code>PRIMARY KEY ((user_id), ts)</code> or DynamoDB's partition key + sort key gives even spread across users and efficient per-user time ranges; cross-user ranges still scatter.</li>
</ul>
<p>Two things to say explicitly. Hashing removes hot spots caused by the <em>key distribution</em>, not by one popular key: every request for one key still hits one partition. And the hash must be stable across processes (Murmur3, MD5), not Java's <code>Object.hashCode()</code> or Python's <code>hash()</code> on strings.</p>
<p><strong>Worked example</strong>: chat messages. Hashing message IDs scatters a channel's history across the cluster; ranging by time-ordered message ID makes the newest range hot. A compound key, <code>(channel_id, bucket)</code> clustered by <code>message_id</code>, is what Discord used.</p>`,
      followups: [
        "Which would you pick for a chat app's messages?",
        "Does hashing fix a hot user?",
        "How would you run a range query over a hash-partitioned table?",
      ],
      pitfalls: [
        "Saying hashing eliminates hot spots (it cannot split a single hot key)",
        "Range-partitioning with a timestamp or auto-increment ID leading the key",
        "Using a language's built-in, per-process hash as the partitioner",
      ],
    },
    {
      id: "q-choose-partition-key",
      q: "What makes a good partition (shard) key? Walk through how you would pick one.",
      diff: "medium",
      section: "hash-partitioning",
      a: `<p><strong>Start from the access patterns, not the schema.</strong> List the most frequent and latency-critical queries and transactions; the partition key should be the entity they are scoped to (user, tenant, device, channel), so each one is answered by one partition. Then check the candidate against six tests:</p>
<ol>
<li><strong>Cardinality</strong>: far more distinct values than partitions. Status, country or a boolean can never spread over 100 partitions.</li>
<li><strong>Even access, not just even key counts</strong>: one tenant or celebrity can dominate even when keys are evenly spread. Look at the top values by traffic.</li>
<li><strong>No monotonically increasing prefix</strong> in a range-partitioned store: timestamps, auto-increment IDs and ObjectIds put every new write on the newest range. Hash it, prefix it with a spread attribute, or bit-reverse it.</li>
<li><strong>Bounded size per key value</strong>: an entity that grows forever needs a time bucket in the key.</li>
<li><strong>Co-location</strong>: data joined or updated together should share the key (compound keys, Redis hash tags, Figma's colos, tenant_id first in every table), so transactions stay single-partition.</li>
<li><strong>Stability</strong>: changing the key later means moving every row, so it is worth the up-front analysis.</li>
</ol>
<p><strong>Name the cost.</strong> Queries not scoped to the key become scatter-gather or need a global index. If two important queries want different keys, store the data twice under each key (a derived table or global index fed by the write path or CDC) rather than compromising both.</p>
<p><strong>Example</strong>: chat messages. The main query is "recent messages in channel X", so <code>PRIMARY KEY ((channel_id, bucket), message_id)</code>: channel for locality, a time bucket to bound size, and the time-ordered message ID for sorted reads.</p>`,
      followups: [
        "What if two important queries want different keys?",
        "How would you change the shard key of a live system?",
        "Why is a low-cardinality key like country or status a bad choice?",
      ],
      pitfalls: [
        "Choosing by schema convenience (the primary key) instead of the access pattern",
        "Low-cardinality keys (status, country, a boolean)",
        "A timestamp or auto-increment ID leading the key in a range-partitioned store",
        "Ignoring the biggest tenant",
      ],
    },
    {
      id: "q-cross-partition-ops",
      q: "Your sharded database needs a query that joins data living on two shards, or a transaction that updates rows on two shards. What are your options?",
      diff: "hard",
      section: "hash-partitioning",
      a: `<p><strong>First, avoid it by design.</strong> Co-locate data that is joined or updated together under the same partition key: tenant_id first in every table, Spanner interleaved tables, Citus co-located tables, Figma's colos, Redis hash tags. Or denormalize so the read needs only one partition. Most mature sharded systems keep the overwhelming majority of operations single-partition this way.</p>
<p><strong>Reads that must span partitions:</strong></p>
<ul>
<li><strong>Scatter-gather</strong> with a coordinator merging results. Simple, but cost grows with the partition count and latency is set by the slowest shard.</li>
<li><strong>A global secondary index or precomputed view</strong> keyed by the other attribute, maintained from a change stream (Chapters 11-12). Reads become single-partition; the view lags.</li>
<li><strong>Ship the data to an analytics store</strong> (MPP warehouse) for heavy joins rather than running them on the OLTP shards.</li>
</ul>
<p><strong>Writes that must span partitions:</strong></p>
<ul>
<li><strong>A distributed transaction with two-phase commit</strong> (Chapter 9; Spanner and CockroachDB do this natively). You pay extra round trips, locks held across the network, and blocking if the coordinator fails at the wrong moment.</li>
<li><strong>A saga</strong>: a sequence of single-partition steps with compensating actions and idempotent retries. No distributed locks, but readers can see intermediate states (money left account A, not yet in B), so the design must tolerate them.</li>
</ul>
<p>The trade-off to name: co-location keeps most operations cheap, and everything else pays in latency, availability or consistency. If a cross-shard path becomes the hot path, that is a sign the partition key is wrong and re-sharding may be cheaper than more machinery.</p>`,
      followups: [
        "Why does two-phase commit hurt availability?",
        "How would you enforce a uniqueness constraint across shards?",
        "When would you re-shard instead of adding cross-shard machinery?",
      ],
      pitfalls: [
        "Assuming a sharded database still gives cheap joins",
        "Proposing 2PC without naming its blocking and latency costs",
        "Forgetting that a saga exposes intermediate states to readers",
      ],
    },

    // --- hot-spots ---
    {
      id: "q02",
      q: "Describe the hot-key (celebrity) problem and mitigations.",
      diff: "medium",
      section: "hot-spots",
      a: `<p>Hash partitioning spreads <em>distinct</em> keys; every request for the same key still goes to one partition. A celebrity's account, a viral post's like counter, a flash-sale product or one giant tenant can overload that partition while the cluster average looks fine. Adding nodes doesn't help, because one key never spans two partitions, and most databases can't compensate automatically, so the fix falls to the application.</p>
<p><strong>First ask: read-hot or write-hot?</strong></p>
<ul>
<li><strong>Read-hot</strong> is the easy kind: cache (application cache, Redis, CDN), read from replicas, and coalesce identical concurrent requests into one database query. Discord's data services, routed by channel ID, coalesce concurrent requests for the same row; Facebook's memcache leases stop thundering herds on a missing hot key.</li>
<li><strong>Write-hot</strong> needs the key itself to change:
<ul>
<li><strong>Salting</strong>: split the key into k sub-keys (<code>post:42#00</code> ... <code>#99</code>) with a random suffix, so writes spread over up to k partitions. Cost model: every aggregate read fetches all k and merges them, so k requests, merge work, and the tail latency of the slowest. A <strong>calculated suffix</strong> (hash(item) mod k) lets you find one specific item directly.</li>
<li><strong>Write combining</strong>: batch increments in app servers and flush "+n" periodically. No read fan-out, but counts lag and a crash loses buffered increments.</li>
<li><strong>A different data structure</strong>: sharded counters, or CRDT counters (Chapter 5).</li>
</ul></li>
</ul>
<p><strong>Salt only the hot keys.</strong> Salting everything multiplies read cost everywhere. That needs a registry of which keys are split, and into how many, plus a way to move a key between split and unsplit.</p>
<p><strong>Find them before they page you.</strong> Per-node and per-table averages hide one hot key, so measure per key: sample requests and keep top-N counters (heavy-hitter sketches make this cheap at high rates), alert on per-partition utilization rather than cluster averages, and use built-in tools where they exist, such as CloudWatch Contributor Insights for DynamoDB or Bigtable's Key Visualizer heatmaps.</p>
<p><strong>Know the limits.</strong> DynamoDB enforces about 1,000 WCU and 3,000 RCU per partition, whatever the table's total, and documents write sharding as the fix. Modern systems split hot ranges automatically (DynamoDB split for heat, CockroachDB load-based splitting), which helps hot ranges but cannot split one key. Sometimes the cleanest fix is to special-case the entity, as in Twitter's hybrid fan-out for celebrities (Chapter 1).</p>`,
      followups: [
        "Random vs calculated suffix?",
        "How do reads find all the sub-keys?",
        "How do you detect hot keys before they cause an outage?",
      ],
      pitfalls: [
        "Salting every key",
        "Thinking more nodes or a better hash fixes one hot key",
        "Forgetting the read cost of k sub-keys",
      ],
    },
    {
      id: "q-dynamodb-throttling",
      q: "A DynamoDB table throttles writes even though consumed capacity is far below the table's provisioned total. Diagnose and fix.",
      diff: "medium",
      section: "hot-spots",
      a: `<p><strong>Diagnosis: a hot partition.</strong> DynamoDB enforces throughput <em>per partition</em>, about 1,000 WCU and 3,000 RCU each, whatever the table total. If the traffic concentrates on one partition key (a date used as the key, one big tenant, a <code>status=open</code> key, a viral item), that partition throttles while the table-wide average looks healthy. Adaptive capacity and split for heat can isolate busy items onto their own partitions, but a single key can never exceed one partition's limit.</p>
<p><strong>Confirm it</strong>: CloudWatch Contributor Insights for DynamoDB shows the most-accessed and most-throttled keys. Per-table metrics alone will hide it.</p>
<p><strong>Fixes, from cheapest:</strong></p>
<ul>
<li><strong>Check the GSIs.</strong> An under-provisioned or skewed global secondary index applies back-pressure that throttles writes to the base table, so a hot or low-cardinality GSI key (status, date) can be the real culprit.</li>
<li><strong>Batch or aggregate writes</strong> to the hot item (combine increments in the application).</li>
<li><strong>Cache hot reads</strong> (DAX or an application cache), if reads are part of the problem.</li>
<li><strong>Write sharding</strong>: add a random suffix (best spread; reads query every suffix and merge) or a calculated suffix (hash of an attribute mod k, so a known item can be read directly). Size k from the hot key's rate divided by the per-partition limit, with headroom.</li>
<li><strong>Redesign the key</strong> with higher cardinality: for example <code>tenant#day</code> instead of <code>day</code>.</li>
</ul>
<p>Switching to on-demand capacity doesn't remove the problem: per-partition limits still apply.</p>`,
      followups: [
        "How do you read a total when writes are sharded across 10 suffixes?",
        "Random vs calculated suffix?",
        "Why can a GSI throttle writes to the base table?",
        "Does on-demand capacity mode remove the problem?",
      ],
      pitfalls: [
        "'Just raise provisioned capacity'",
        "Assuming on-demand mode has no per-partition limits",
        "Salting every key instead of the few hot ones",
      ],
    },
    {
      id: "q06",
      q: "How would you design the partitioning for Twitter?",
      diff: "hard",
      section: "hot-spots",
      a: `<p>Partition each dataset by the key its main query is scoped to, then deal with the skew that a social graph guarantees.</p>
<ul>
<li><strong>Tweets</strong>: hash-partition by tweet ID. Snowflake-style IDs are time-ordered, so never range-partition by them, or every new tweet lands on the newest range. If "a user's tweets in order" is a main query, keep a separate user-timeline table with a compound key <code>(user_id, bucket)</code> clustered by tweet ID.</li>
<li><strong>Home timelines</strong> (the fan-out cache): partition by the timeline owner's user ID, so reading your timeline is one partition.</li>
<li><strong>Follow graph</strong>: store both directions as two tables, <code>followers(user_id &rarr; follower_ids)</code> and <code>following(user_id &rarr; followee_ids)</code>, each partitioned by its own user ID. Both "who follows X" and "whom does X follow" become single-partition reads; a follow writes to two partitions, usually asynchronously with idempotent retries.</li>
<li><strong>Celebrities</strong>: a few accounts have tens of millions of followers, so fan-out on write for their tweets means tens of millions of timeline writes per tweet. Use the hybrid from Chapter 1: fan out normal users' tweets on write, and merge celebrities' tweets into the timeline at read time. Their followers lists are also oversized partitions; split them into buckets.</li>
<li><strong>Counters on viral tweets</strong>: likes and retweets on one tweet are a single hot key. Use sharded counters (salting) or write combining in front of the store, and cache the reads.</li>
<li><strong>Search and hashtags</strong>: a term-partitioned inverted index makes a hashtag lookup one partition but makes it a hot spot for trending tags; Elasticsearch-style search clusters are document-partitioned and scatter-gather every query. Either way, search is a separate system fed from the tweet stream.</li>
<li><strong>Users and usernames</strong>: profiles by user ID; unique usernames need a global index or a username-to-ID table written with a conditional insert.</li>
</ul>
<p>Close with growth: many partitions per node, so adding capacity moves a fair share, and routing through a partition-aware layer.</p>`,
      followups: [
        "How do you count likes on a viral tweet?",
        "How would you store a celebrity's follower list?",
        "Why not range-partition tweets by their time-ordered IDs?",
      ],
      pitfalls: [
        "Range-partitioning tweets by ID",
        "Storing only one direction of the follow graph",
        "Fan-out on write for every account, including celebrities",
        "Calling Elasticsearch a term-partitioned (global) index",
      ],
    },

    // --- secondary-indexes ---
    {
      id: "q03",
      q: "Explain local vs global secondary indexes on partitioned data.",
      diff: "hard",
      section: "secondary-indexes",
      a: `<p>A secondary index finds records by something other than the partition key ("all red cars"), and "red" appears on every partition. There are two ways to partition the index itself:</p>
<ul>
<li><strong>Local (document-partitioned)</strong>: each partition indexes only its own documents. A write touches one partition, and the index is always consistent with its data. A query by the indexed value must <strong>scatter-gather</strong> to every partition, so its cost grows with the partition count and its latency is that of the slowest partition (tail latency amplification); parallelism doesn't fix that. Exception: if the query also names the partition key, one partition answers. Examples: MongoDB, Elasticsearch, SolrCloud, Cassandra, Riak, VoltDB, and DynamoDB local secondary indexes (LSIs).</li>
<li><strong>Global (term-partitioned)</strong>: one index over all data, partitioned by the indexed value (by term for range scans, or by hash of the term for spread). A query reads one index partition. A write may touch several remote index partitions: repainting a car red to silver updates the data partition plus the "red" and "silver" index partitions. Keeping that atomic needs a distributed transaction, so many systems update it <strong>asynchronously</strong>. DynamoDB global secondary indexes (GSIs) are asynchronous and support only eventually consistent reads. Spanner and CockroachDB instead maintain global indexes inside the same transaction: fresh reads, slower writes.</li>
</ul>
<p><strong>Uniqueness</strong> is a deciding factor. Two partitions with local indexes can each accept the same email, so a unique constraint on a non-partition-key column needs a global index updated synchronously (or a separate uniqueness record written with a conditional write). The exception: a unique key that includes the partition key can be checked locally, which is why MongoDB only allows unique indexes on a sharded collection when they are prefixed by the shard key.</p>
<p><strong>Rule of thumb</strong>: local for write-heavy data with occasional secondary queries; global for read-heavy secondary lookups, accepting slower or stale index writes.</p>`,
      followups: [
        "Which would you use for a unique email?",
        "What happens to a repaint that changes an indexed value?",
        "How would you keep a global index fresh without distributed transactions?",
      ],
      pitfalls: [
        "Assuming GSI reads can be strongly consistent",
        "Calling local indexes 'faster' without saying reads become scatter-gather",
        "Saying all global indexes are eventually consistent (Spanner and CockroachDB are synchronous)",
      ],
    },
    {
      id: "q-gsi-stale-read",
      q: "A user changes their email address, immediately signs in with the new one, and the lookup (a global secondary index on email) says 'no such user'. Explain and design a fix.",
      diff: "medium",
      section: "secondary-indexes",
      a: `<p><strong>What happened.</strong> A global (term-partitioned) index lives on different partitions from the user record. Keeping it in sync atomically would need a distributed transaction, so many systems update it asynchronously; DynamoDB GSIs, for example, support only eventually consistent reads. The sign-in lookup reached the index partition for the new email before the index update did. That is a <strong>read-your-writes violation on the index</strong>: the user's own write isn't visible to them yet. Propagation is usually fast, but there is no bound to rely on.</p>
<p><strong>Fixes:</strong></p>
<ul>
<li><strong>Make the lookup table explicit and transactional.</strong> Maintain an <code>email &rarr; user_id</code> table and update it in the same transaction as the profile change: delete the old email item, insert the new one with a "must not exist" condition, update the user. In DynamoDB that is <code>TransactWriteItems</code>. This also <strong>enforces uniqueness</strong>, which a GSI cannot.</li>
<li><strong>Use a database with transactional global indexes</strong> (Spanner, CockroachDB), accepting a cross-partition commit on every email change.</li>
<li><strong>Patch the flow</strong>: right after a change, keep using the user ID from the session, or retry the lookup briefly. That hides the symptom only for this path.</li>
</ul>
<p>A local index would be fresh, but email isn't the partition key, so every sign-in would become a scatter-gather across all partitions. That is the wrong trade for the hottest read in the system.</p>`,
      followups: [
        "How would you enforce that emails are unique?",
        "What does a synchronous global index cost per write?",
        "How would you detect how far behind the index is?",
      ],
      pitfalls: [
        "Assuming GSIs support strongly consistent reads",
        "Proposing a local index without mentioning scatter-gather on every login",
        "Ignoring uniqueness",
      ],
    },
    {
      id: "q-scatter-gather-topk",
      q: "Orders are sharded by customer ID across 64 shards. An admin page lists the 50 most recent orders across all customers, with paging. How do you serve it, and what breaks at scale?",
      diff: "medium",
      section: "secondary-indexes",
      a: `<p><strong>The direct answer is scatter-gather.</strong> Send <code>ORDER BY created_at DESC LIMIT 50</code> to every shard, merge the 64 sorted lists and keep the top 50. The correctness detail: each shard must return its own top 50, not 50/64, because the newest 50 orders could all live on one shard.</p>
<p><strong>What breaks as it grows:</strong></p>
<ul>
<li><strong>Cost and tail latency.</strong> Every page view is 64 queries, and the page waits for the slowest shard, so one shard in a GC pause or compaction slows every request (tail latency amplification, Chapter 1).</li>
<li><strong>Deep pages.</strong> With OFFSET, page 100 makes every shard produce its first 5,000 rows and the coordinator merge 320,000 to keep 50. Elasticsearch refuses <code>from + size</code> beyond 10,000 by default for this reason. Use <strong>keyset (cursor) paging</strong> instead: pass the last row's <code>(created_at, order_id)</code> and ask each shard for the next 50 after it, so every page costs the same.</li>
<li><strong>Partial failure.</strong> If one shard times out, fail the page or return results explicitly marked partial; silently skipping a shard returns a wrong list.</li>
</ul>
<p><strong>The scalable answer is to stop scattering.</strong> Keep a global view of orders keyed by time: a global secondary index on <code>created_at</code>, or a "recent orders" table fed by a change stream (Chapters 11 and 12). The admin query then reads one place, at the price of a lagging view. Don't key that view by time alone, or every new order lands on one partition: bucket it, for example by <code>(day, hash(order_id) mod 8)</code>, and merge the 8 buckets on read. For heavy ad-hoc reporting, ship orders to an analytics warehouse rather than querying the OLTP shards.</p>`,
      followups: [
        "Why must each shard return the full LIMIT rather than LIMIT divided by the shard count?",
        "How does keyset paging avoid the deep-offset cost?",
        "How would you keep the global recent-orders view from becoming a hot spot?",
      ],
      pitfalls: [
        "Asking each shard for LIMIT / N rows",
        "OFFSET paging over a scatter-gather",
        "Ignoring the slowest shard and partial failures",
        "A global index keyed only by timestamp (a new hot spot)",
      ],
    },

    // --- rebalancing ---
    {
      id: "q07",
      q: "What is consistent hashing and why is it useful?",
      diff: "medium",
      section: "rebalancing",
      a: `<p><strong>The problem it solves</strong>: with node = hash(key) mod N, changing N moves almost every key, about N/(N+1) of them going from N to N+1 nodes, mostly between nodes that were already there. For a cache tier that is a near-total miss storm.</p>
<p><strong>How it works</strong>: hash both keys and nodes onto the same ring (hash space). Each node owns one or more points, called tokens, and a key belongs to the first token clockwise from its hash. A new node takes over only the arcs just before its tokens, so going from N to N+1 nodes moves about <strong>1/(N+1)</strong> of the keys, all of them to the new node. Removing a node hands only its arcs to its successors.</p>
<p><strong>Caveats a strong answer includes:</strong></p>
<ul>
<li><strong>One token per node gives very uneven load</strong>: arcs between random points vary a lot, and a leaving node dumps its whole load on one neighbor. The fix is many tokens per node (<strong>virtual nodes</strong>: Dynamo, Cassandra's <code>num_tokens</code>, ketama-style memcached clients) or a token allocator. "1/(N+1)" is an average, not a per-node guarantee.</li>
<li><strong>Terminology</strong>: the term is used inconsistently. The book prefers "hash partitioning", and the "consistent" has nothing to do with replica consistency or ACID.</li>
<li><strong>Alternatives</strong>: rendezvous (highest-random-weight) hashing ranks nodes by hash(key, node); Google's jump consistent hash needs no stored ring but only adds or removes the last bucket; Maglev hashing builds a lookup table for load balancers; bounded-load variants cap each server at (1 + &epsilon;) times the average.</li>
</ul>
<p>Origins: Karger et al. (1997) for web caches, the basis of Akamai; Amazon's Dynamo (2007) and Last.fm's libketama (2007) brought it to databases and memcached.</p>`,
      followups: [
        "Why virtual nodes?",
        "How does jump hash differ from a ring?",
        "What happens to load when a node with one token leaves?",
      ],
      pitfalls: [
        "Claiming zero keys move",
        "Saying 1/N of keys move when going from N to N+1 nodes",
        "Assuming consistent hashing alone guarantees even load",
        "Confusing 'consistent' with replica consistency",
      ],
    },
    {
      id: "q-mod-n-cache",
      q: "Your memcached tier routes keys with hash(key) % N. You add one server to a pool of 9 and the database falls over. Explain why and how to fix it.",
      diff: "medium",
      section: "rebalancing",
      a: `<p><strong>Why.</strong> A key keeps its server only if hash mod 9 equals hash mod 10, which holds for about 1 key in 10. So adding the 10th server sends about <strong>90% of lookups</strong> to a server that doesn't have the key. A near-total miss storm then lands on the database at once, often as many concurrent misses for the same popular keys (a thundering herd).</p>
<p><strong>Fix the placement</strong> so only about 1/(N+1) of keys move:</p>
<ul>
<li><strong>Consistent hashing with many virtual nodes per server</strong> (ketama-style clients place on the order of 100-200 points per server), so the new server takes a small slice from every existing one.</li>
<li>Or a <strong>fixed set of slots</strong> mapped to servers, like Redis Cluster's 16,384 slots: hash mod a fixed number is fine; it's mod the server count that hurts.</li>
<li>Alternatives: rendezvous hashing, jump consistent hash.</li>
</ul>
<p><strong>Fix the operations</strong>, because even 10% of keys moving is a spike:</p>
<ul>
<li>Add capacity gradually and warm new servers (copy hot keys or shadow traffic before cut-over).</li>
<li>Protect the database: request coalescing so only one miss per key goes through, Facebook-style <strong>leases</strong> (one client refills a missing key while others wait or get slightly stale data), and rate limits or load shedding.</li>
<li>Remove servers the same careful way; a crashed server is an unplanned version of the same event.</li>
</ul>`,
      followups: [
        "How many virtual nodes per server, and why?",
        "Jump hash vs ring: when would you pick each?",
        "How do you remove a server safely?",
        "Even with 10% of keys moving, the DB struggles. What else can you do?",
      ],
      pitfalls: [
        "Claiming consistent hashing moves no keys",
        "Using one token per server (very uneven load)",
        "Ignoring the thundering herd on the database",
      ],
    },

    // --- rebalancing-strategies ---
    {
      id: "q04",
      q: "How does rebalancing work without taking the cluster down?",
      diff: "hard",
      section: "rebalancing-strategies",
      a: `<p><strong>Goals</strong>: fair load afterwards, reads and writes served throughout, and no more data moved than necessary. Rule out <strong>hash mod N</strong> first: it ties placement to the node count, so adding a node moves about N/(N+1) of all keys.</p>
<p><strong>Three workable strategies:</strong></p>
<ol>
<li><strong>Fixed number of partitions</strong>, many more than nodes (say 1,000 for 10 nodes). The key-to-partition mapping never changes; a new node steals a few whole partitions from every existing node. Examples: Riak, Elasticsearch, Couchbase (1,024 vBuckets), Voldemort, Redis Cluster (16,384 slots). Pitfall: the count is chosen up front and caps the node count.</li>
<li><strong>Dynamic partitioning</strong>: a partition splits when it exceeds a size threshold (HBase: 10 GB) and merges when small; one half can move to another node. Examples: HBase, RethinkDB, MongoDB (ranged and hashed). Pitfalls: a new table starts as one partition on one node, so pre-split it, and size-based splits don't fix sequential-key hot spots.</li>
<li><strong>Partitions proportional to nodes</strong>: a fixed number of token ranges per node; a joining node splits randomly chosen ranges and takes half of each. Cassandra used 256 tokens per node; 4.0 lowered the default to 16 with a token-allocation algorithm. Needs hash partitioning.</li>
</ol>
<p><strong>Staying online during a move.</strong> The old owner keeps serving reads and writes for the partition while it is copied. Implementations differ in the cut-over: copy a snapshot, stream the changes made meanwhile from the log, briefly fence writes, switch the routing map (Kafka adds the new replica and moves leadership; Redis Cluster migrates key by key and answers <code>ASK</code> redirects meanwhile; Cassandra treats the joining node's ranges as pending and sends it writes while it streams). Only after cut-over and a grace period is the source copy deleted.</p>
<p><strong>Who triggers it</strong>: fully automatic rebalancing plus automatic failure detection can cascade, so most systems delay, throttle or require an operator to approve large moves.</p>`,
      followups: [
        "Why not hash mod N?",
        "What goes wrong if rebalancing is automatic?",
        "How does the router learn the partition moved?",
      ],
      pitfalls: [
        "Deleting the source copy before cut-over",
        "Claiming every system writes to old and new owners during a move",
        "One partition per node (cannot rebalance without splitting)",
      ],
    },
    {
      id: "q-partition-count",
      q: "How do you choose the number of partitions for a new Kafka topic, Elasticsearch index, or sharded table?",
      diff: "medium",
      section: "rebalancing-strategies",
      a: `<p>In a fixed-partition system the count is a long-term decision: it caps parallelism and the number of nodes you can usefully spread over, and it is hard to change later.</p>
<p><strong>Size from both ends:</strong></p>
<ul>
<li><strong>Throughput floor</strong>: partitions &ge; peak target throughput / measured per-partition throughput (for Kafka, also the maximum consumer parallelism you'll want in a group).</li>
<li><strong>Growth floor</strong>: several partitions per node at the largest cluster you expect, so a new node can take a fair share and failures spread across many peers.</li>
<li><strong>Overhead ceiling</strong>: each partition costs file handles, memory, metadata, leader elections and recovery work. Elasticsearch warns against oversharding; Elastic's sizing guidance suggests shards of roughly 10-50 GB.</li>
</ul>
<p><strong>Too few</strong>: you can't scale out, and each partition is huge, so moves and recoveries are slow. <strong>Too many</strong>: overhead and coordination dominate on a small cluster.</p>
<p><strong>Changing later hurts.</strong> An Elasticsearch index's primary shard count is fixed at creation; changing it needs split, shrink or reindex into a new index. Adding partitions to a Kafka topic changes which partition a key hashes to, which breaks per-key ordering for keyed topics. Sharded databases need a re-shard.</p>
<p><strong>Pick a count with many divisors</strong> so it spreads evenly over many cluster sizes: Notion chose 480 logical shards, which divides evenly over 32, 40, 48 or 96 hosts. If data volume is genuinely unpredictable, prefer a dynamically partitioned system (HBase, CockroachDB, MongoDB) and pre-split.</p>`,
      followups: [
        "What happens to per-key ordering if you add partitions to a Kafka topic?",
        "Why 480 rather than 500?",
        "When would dynamic partitioning be a better choice?",
      ],
      pitfalls: [
        "One partition per node (cannot rebalance without splitting)",
        "Thousands of tiny shards per node",
        "Assuming the count can be changed for free later",
      ],
    },

    // --- rebalancing-operations ---
    {
      id: "q-auto-rebalance",
      q: "Should rebalancing be fully automatic? Argue both sides and say what you would build.",
      diff: "medium",
      section: "rebalancing-operations",
      a: `<p><strong>For automation</strong>: less operational toil, quick reaction to growth and hot spots, and no 3 a.m. pages to move a partition. DynamoDB, Spanner and CockroachDB rebalance continuously and automatically.</p>
<p><strong>Against</strong>: moving data is expensive and unpredictable. It competes with production traffic for network and disk, and combined with automatic failure detection it can cascade: a slow node is declared dead, its load is moved onto the others, they slow down and are declared dead too. A timeout cannot tell slow from dead (Chapter 8). AWS's 2011 EBS outage is the classic example of automated recovery amplifying a failure: many nodes lost their replicas at once and all tried to re-mirror at the same time, a "re-mirroring storm" that exhausted capacity in the Availability Zone.</p>
<p><strong>What I would build</strong>: automatic planning, guarded execution.</p>
<ul>
<li><strong>A delay before reacting to a departure</strong>, so a restart or GC pause doesn't trigger a full move (Elasticsearch waits 1 minute by default).</li>
<li><strong>Throttles</strong> on bytes per second and on concurrent moves per node; balancing windows off-peak.</li>
<li><strong>Hysteresis</strong>: ignore small imbalances, move only when skew exceeds a threshold.</li>
<li><strong>Separate the two jobs</strong>: re-replicating under-replicated data after a real failure is urgent (durability); evening out load is optional and can wait.</li>
<li><strong>Human approval for large plans</strong> (Couchbase, Riak and Voldemort generate a plan that an admin commits); Kafka with Cruise Control is the goal-based automated version.</li>
</ul>`,
      followups: [
        "How do you tell a dead node from a slow one?",
        "How would you size the throttle?",
        "What metrics would page a human before a big move?",
      ],
      pitfalls: [
        "'Automatic is always better'",
        "Treating rebalancing as free",
        "No distinction between re-replication and load balancing",
      ],
    },
    {
      id: "q-live-resharding",
      q: "A single Postgres database (or a sharded one with the wrong shard key) must be re-partitioned without downtime. How do you do it?",
      diff: "hard",
      section: "rebalancing-operations",
      a: `<p><strong>First say what kind of change it is.</strong> If the key → partition function stays the same and you only need more machines, it is an ordinary rebalance: move whole logical shards to new hosts. That is the payoff of creating many logical shards up front. If the function itself changes (first-time sharding, a new partition key, splitting partitions), nearly every row moves, and you run an online migration between two live layouts.</p>
<ol>
<li><strong>Prepare.</strong> Route all data access through one layer (a data-access library, or a proxy such as Vitess's VTGate) so the switch is a configuration change. Make sure every table carries the new key, for example add <code>tenant_id</code> to child tables first. Log queries that lack the new key: they become scatter-gather or cross-shard transactions after the move, so fix them now.</li>
<li><strong>Keep the new layout current.</strong> Prefer consuming the old database's change stream (logical replication, binlog, CDC) over application dual-writes: one source of truth, and no divergence when one of two writes fails.</li>
<li><strong>Backfill</strong> history in throttled batches. Make the apply idempotent and version-aware, so a backfilled row never overwrites a newer change from the stream.</li>
<li><strong>Verify</strong> with counts and checksums per shard, plus shadow reads that query both layouts and log differences, until the mismatch rate is zero.</li>
<li><strong>Cut over</strong> reads first behind a flag. Then fence writes briefly: stop writes on the old layout, wait for replication lag to reach zero, flip routing, resume. The window is seconds because the new layout was already current.</li>
<li><strong>Keep a way back.</strong> Replicate new → old for a period so you can roll back; delete the old copy only after a grace period.</li>
</ol>
<p><strong>Things that bite</strong>: IDs (per-database sequences collide across shards, so switch to globally unique IDs first), uniqueness constraints that no longer fit within one shard, and the backfill's load on production. Real references: Notion's 2021 sharding ran double-write, backfill, verify and switch-over phases; Vitess's Reshard workflow automates copy, binlog catch-up, VDiff verification and traffic switching, with reverse replication for rollback.</p>`,
      followups: [
        "Why prefer change data capture over dual writes from the application?",
        "How do you keep the cut-over window down to seconds?",
        "How would you roll back an hour after cut-over?",
        "Which queries break when the shard key changes?",
      ],
      pitfalls: [
        "Application dual-writes with no plan for one write succeeding and the other failing",
        "Cutting over without verification",
        "Deleting the old copy at cut-over",
        "Letting the backfill overwrite newer writes",
      ],
    },

    // --- request-routing ---
    {
      id: "q05",
      q: "How does a client know which partition to contact?",
      diff: "medium",
      section: "request-routing",
      a: `<p>Three patterns, which differ in hops and in where routing knowledge lives:</p>
<ul>
<li><strong>Any node forwards</strong> (up to 2 hops): the client contacts any node, which serves the request or forwards it to the owner. Cassandra and Riak spread the map by gossip; Cassandra drivers usually add token-aware routing to skip the extra hop; Elasticsearch coordinating nodes work this way.</li>
<li><strong>Routing tier</strong> (2 hops): a partition-aware proxy that holds no data. MongoDB's mongos (routing table from the config servers), Vitess's VTGate (topology in etcd, ZooKeeper or Consul), and Couchbase's moxi in the book's era.</li>
<li><strong>Partition-aware client</strong> (1 hop): the client library caches the map and connects to the owner. Redis Cluster clients cache the slot map; Kafka clients fetch partition-leader metadata from any broker.</li>
</ul>
<p><strong>The hard part is agreeing on the map</strong> while partitions move, which is a consensus problem (Chapter 9). Systems keep it in a coordination service that routers watch (ZooKeeper for HBase, SolrCloud and pre-KRaft Kafka; Helix for LinkedIn's Espresso; MongoDB's config servers) or spread it by gossip. Kafka replaced ZooKeeper with its own Raft-based KRaft quorum: production-ready in 3.3 (2022), ZooKeeper mode removed in 4.0 (2025). Node IP addresses change rarely, so DNS is fine for those.</p>
<p><strong>Caches will be stale</strong>, so the protocol must handle it: the map carries a version, and the old owner rejects or redirects. Redis answers <code>MOVED</code> (ownership changed, update your map) or <code>ASK</code> (one-off redirect mid-migration), MongoDB shards reject stale versions, Kafka returns "not leader". The router refreshes and retries.</p>
<p><strong>The failure mode if the old owner doesn't check ownership</strong>: a stale router sends a write to a leftover copy, gets OK, the new owner never sees it, and the acknowledged write disappears when the old copy is deleted.</p>`,
      followups: [
        "What happens when a client's map is stale?",
        "Why is a coordination service needed?",
        "What stops the old owner from accepting writes after the move?",
      ],
      pitfalls: [
        "Assuming the map is always fresh",
        "Putting the coordination service in the request path",
        "Using DNS to track partition ownership",
      ],
    },
    {
      id: "q-routing-during-move",
      q: "Walk through what happens to reads and writes for a partition while it is moved to a new node. How do routers and clients find out?",
      diff: "hard",
      section: "request-routing",
      a: `<p><strong>The move</strong>, in the common shape (details vary by system):</p>
<ol>
<li><strong>Copy</strong> a snapshot of the partition to the new owner. The old owner keeps serving all reads and writes meanwhile.</li>
<li><strong>Catch up</strong>: stream the changes made during the copy from the old owner's log or replication stream until the new owner is nearly current.</li>
<li><strong>Cut over</strong>: briefly pause or fence writes on the old owner, apply the last changes, then update the <strong>authoritative partition map</strong> with a new version (epoch) in the coordination service (ZooKeeper, etcd, MongoDB config servers or a Raft-based metadata store).</li>
<li><strong>Fence the old owner</strong>: from now on it must refuse writes for that partition, or you have two owners accepting writes (split brain).</li>
<li><strong>Clean up</strong>: the old owner deletes its copy only after a grace period.</li>
</ol>
<p><strong>How routers find out</strong>: eagerly through watch notifications from the coordination service, and lazily through rejections. A request carrying the old map version reaches the old owner, which rejects or redirects it: Redis <code>MOVED</code> (permanent; update the map) or <code>ASK</code> (mid-migration; retry once at the target without updating the map), MongoDB stale-version errors, Kafka "not leader" errors. The router refreshes its map and retries.</p>
<p><strong>Why the checks matter</strong>: without step 4, a stale client writes to the leftover copy, gets an OK, and the write vanishes when the copy is deleted. Epoch checks on every request turn a stale map from silent data loss into a cheap retry. Agreeing on who owns what at any moment is a consensus problem (Chapter 9), which is why the map lives in a linearizable store.</p>`,
      followups: [
        "What if the old owner keeps accepting writes after the map changed?",
        "What's the difference between Redis MOVED and ASK?",
        "Why not let each node decide ownership independently?",
      ],
      pitfalls: [
        "Deleting data on the old owner as soon as copying starts",
        "Assuming every client sees the new map instantly",
        "Forgetting writes that arrive during the copy",
      ],
    },
  ],
});
