// Chapter 10: Batch Processing
// Authoring guide: docs/AUTHORING.md
DDIA.registerChapter({
  id: "ch10",
  part: 3,
  number: 10,
  title: "Batch Processing",
  tagline: "Turning a fixed pile of data into derived data with pure, rerunnable jobs: Unix pipes scaled to thousands of unreliable machines.",
  overview: `<p>This chapter opens Part III. Parts I and II treated the database as the one place where data lives; Part III is about systems built from several stores, and it rests on one distinction. A <strong>system of record</strong> holds the authoritative version of the data: each fact is written there first. <strong>Derived data</strong> (indexes, caches, materialized views, trained models) is computed from it, redundant on purpose and rebuildable from the source if lost. Batch jobs are the first way to compute it.</p>
<p>A batch job takes a <strong>bounded</strong>, fixed input (yesterday's logs, a snapshot of a database) and turns it into derived data: a search index, a recommendation table, a training set, a warehouse table. An online service is judged by response time; a batch job is judged by <strong>throughput</strong>. Because its input never changes, you can rerun it whenever its code changes. The chapter starts with a Unix pipeline on one machine and scales the same ideas (small single-purpose stages, a uniform interface, grouping by sorting) out to MapReduce and HDFS on thousands of machines.</p>
<p>The central tension is the cost of moving data when machines keep failing. To spread work across a cluster, the data has to be repartitioned so related records meet (the <a href="#/ch6/learn/hash-partitioning">hash partitioning</a> of Chapter 6), and that shuffle is expensive and exposes hot keys. With hundreds of tasks, some task almost always dies (Chapter 8's <a href="#/ch8/learn/partial-failure">partial failure</a>, now routine), so recovery has to happen one task at a time. MapReduce chose brute force: write everything to disk and rerun failed tasks from immutable input. That made it robust and simple, but slow. Much of the chapter is about two ways out: knowing your data's layout well enough to skip work, and engines that pay for durability only where it earns its keep.</p>
<p>Each idea builds on the one before. The pipeline gives the model. MapReduce distributes it and makes sort-and-shuffle the core primitive. Reduce-side and map-side joins show how that primitive implements relational operations, and when you can avoid it. Batch outputs explain why jobs build immutable files and swap them in whole, which buys <strong>human fault tolerance</strong>. The comparison with MPP databases explains why Hadoop is so disk-heavy: preemption on shared clusters. Dataflow engines (Spark, Tez, Flink) then drop needless materialization and recover by recomputing from <strong>lineage</strong>, which only works with deterministic operators. Pregel handles iteration over graphs. Finally, SQL and DataFrame APIs let an optimizer choose the join algorithms, and batch frameworks and MPP databases start to look alike.</p>`,

  concepts: [
    // ---- why-batch ----
    {
      id: "batch-processing",
      term: "Batch processing",
      def: "A job reads a <strong>bounded</strong> input (a fixed set of files or a snapshot, all of it known in advance), runs to completion and writes an output dataset. It is judged by <strong>throughput</strong>, meaning how long it takes to process an input of a given size, not by response time. Jobs usually run on a schedule (nightly, hourly) and take minutes to days. Compare <em>online services</em>, which answer one request at a time and are judged by response time, and <em>stream processors</em> (ch11), which consume unbounded events shortly after they happen.",
      problem: "Online systems answer one small request quickly, but questions about all the data at once (a search index over a billion pages, yesterday's top pages by age group, features for tonight's model) can't be answered per request or against the production database. A full scan takes hours, takes disk and CPU from live users, and gives a different answer every time because the data keeps changing underneath it.",
      why: "Because the input is bounded, the job knows when it has read everything and is finished. Because the input is immutable and the output is <strong>derived data</strong>, a job can be rerun after a bug fix and produce a corrected result, which makes backfills and experiments cheap. Batch deliberately gives up latency to get throughput, determinism and simplicity. It is not a slow or legacy version of streaming: even streaming-first companies reprocess history with batch jobs.",
      ex: "Google's MapReduce paper (OSDI 2004) reports that the production web-search indexing system was rewritten as a sequence of MapReduce operations. In 2008 Yahoo! announced that its Search Webmap ran as a Hadoop application on more than 10,000 cores. Today's equivalents are nightly Spark or dbt jobs that rebuild warehouse tables, ML training sets and recommendation tables. A quick estimate: one machine reading 2 TB at 200 MB/s needs about 2.8 hours, while 1,000 machines need about 10 seconds each, which is why parallelism, and therefore partial failure, is built into every batch design.",
      section: "why-batch",
    },

    // ---- unix-pipelines ----
    {
      id: "unix-philosophy",
      term: "Unix philosophy",
      def: "A set of design rules written down at Bell Labs (McIlroy, Pinson and Tague, 1978). Make each program do one thing well. Expect every program's output to become another program's input, so avoid extra output and interactive prompts. Build software to be tried early, and throw away clumsy parts. Prefer writing tools to doing repetitive work by hand. Programs are composed with <strong>pipes</strong>, which connect one program's stdout to the next program's stdin.",
      problem: "Monolithic one-off programs can't be reused, combined or inspected stage by stage, so every new question means writing and debugging another big program.",
      why: "It is the template for MapReduce and everything after it: small single-purpose stages, immutable inputs, an explicit dataflow, and the freedom to rerun or inspect any stage. <strong>Separating logic from wiring</strong> (a program reads stdin and writes stdout without knowing what is attached) is what makes a stage reusable. The big limitation is that everything runs on one machine, and that gap is what MapReduce fills.",
      ex: `<code>cat access.log | awk '{print $7}' | sort | uniq -c | sort -rn | head -n 5</code> prints the five most-requested paths. Mapped onto MapReduce: reading lines is input splitting, <code>awk</code> is the map (extract the key), <code>sort</code> is the shuffle's partition-and-sort, and <code>uniq -c</code> is the reduce (count each run of identical keys). The final <code>sort -rn | head</code> would be a second job. In 1986 Jon Bentley asked Donald Knuth for a literate program that finds the most frequent words in a text; Doug McIlroy's review answered Knuth's multi-page program with a six-command pipeline.`,
      section: "unix-pipelines",
    },
    {
      id: "uniform-interface",
      term: "Uniform interface (Unix)",
      def: "Every Unix program reads and writes the same abstraction, a file descriptor carrying a stream of bytes, by convention newline-separated text records, so the output of any program can be the input of any other. It isn't elegant (<code>{print $7}</code> is cryptic, and whitespace parsing breaks on unusual input), but it composes.",
      problem: "Without a shared format, every pair of tools needs custom glue code. Even today, most databases and applications can't be 'piped' into each other without bespoke export and import jobs.",
      why: "A uniform interface is what makes composition possible at all: any program can feed any other without anyone writing an adapter. MapReduce's equivalent is files in a distributed filesystem with an agreed record format. Today it is Parquet or Avro files on object storage for batch, and log topics such as Kafka for streams (ch11). The limits: programs with several inputs or outputs are awkward to wire up, and you can't pipe output straight into a network connection.",
      ex: "<code>grep</code>, <code>sort</code>, <code>awk</code> and <code>uniq</code> were written by different people, yet they chain without glue code because they all speak newline-delimited text over file descriptors. Moving data from a CRM's database into an analytics database, by contrast, usually needs a dedicated export and import pipeline. CSV and JSON Lines are the modern descendants of the text-stream convention.",
      section: "unix-pipelines",
    },
    {
      id: "external-sort",
      term: "External merge sort",
      def: "Sorting data larger than memory: sort memory-sized chunks, write each one to disk as a sorted <strong>run</strong>, then merge the runs in one or more sequential passes. GNU sort works this way, and so does every MapReduce mapper and reducer.",
      problem: "An in-memory sort or hash map fails when the data, or the number of distinct keys, exceeds RAM. Sequential run-and-merge I/O is disk-friendly and scales to any size.",
      why: "Sorting scales where hashing doesn't. Counting with a hash map needs memory proportional to the number of <em>distinct keys</em>; a merge sort needs one buffer and reads and writes runs sequentially, which disks and SSDs handle well. When the distinct keys fit in RAM, the hash map is faster; when they don't, sorting and then grouping still works. The same run-and-merge idea underlies SSTables and LSM-tree compaction (ch3) and the MapReduce shuffle.",
      ex: "GNU <code>sort</code> sorts chunks that fit its buffer (<code style='white-space:nowrap'>-S</code>), writes sorted temporary files and merges them; <code style='white-space:nowrap'>--parallel</code> uses several cores. A log of 2 billion lines over 50,000 URLs counts easily with a hash map. A log with 500 million distinct URLs may exhaust memory, but <code>sort | uniq -c</code> still finishes. Hadoop mappers do the same thing: they buffer output in a 100 MB buffer, spill sorted runs to local disk when it is 80% full, and merge the runs at the end.",
      section: "unix-pipelines",
    },

    // ---- mapreduce-and-hdfs ----
    {
      id: "hdfs-distributed-filesystem",
      term: "HDFS / distributed filesystem",
      def: "A shared-nothing filesystem. Each commodity machine runs a <strong>DataNode</strong> that serves its local disks, and a <strong>NameNode</strong> keeps the metadata (which blocks make up each file and where they are stored) in memory. Files are cut into large blocks: 128 MB by default since Hadoop 2, 64 MB in Hadoop 1 and in GFS. Each block is either replicated (3 copies by default, rack-aware) or, since Hadoop 3, erasure coded with Reed-Solomon codes. Files are write-once (appends allowed, no in-place updates), and the target workload is large sequential reads.",
      problem: "Shared NAS/SAN storage became a bottleneck, and single disks were far too small for web-scale data. Batch jobs needed cheap storage whose capacity and bandwidth grow with the cluster and that keeps working while machines die every day.",
      why: "Spreading blocks across thousands of disks gives aggregate read bandwidth that grows with the cluster, and replicas let a job read any copy and survive the loss of a machine or a whole rack. The costs: every file, directory and block takes NameNode heap (about 150 bytes each, a common rule of thumb), so millions of small files hurt, and there are no random in-place updates. The NameNode was a single point of failure in Hadoop 1; Hadoop 2 added an active/standby pair with ZooKeeper-based failover. In the cloud, object stores (S3, GCS, Azure Blob) have largely replaced HDFS because they scale storage separately from compute. But they are not filesystems: renaming a directory means copying and deleting every object, and it isn't atomic.",
      ex: "HDFS is an open-source reimplementation of the Google File System (SOSP 2003), which had one master, 64 MB chunks and 3 replicas. Default HDFS placement puts replica 1 on the writer's node and replicas 2 and 3 on two different nodes in one remote rack. Hadoop 3.0 (December 2017) added erasure coding: RS(6,3) stores 9 blocks for every 6 blocks of data (1.5&times; storage, and any 3 can be lost), compared with 3&times; storage for replication.",
      section: "mapreduce-and-hdfs",
    },
    {
      id: "mapreduce",
      term: "MapReduce",
      def: "A programming model and framework for batch jobs over files in a distributed filesystem. You write two functions. <strong>Map</strong> is called once per input record, emits zero or more key-value pairs and keeps no state between records. <strong>Reduce</strong> is called once per <em>key</em> with an iterator over all the values for that key. The framework runs one map task per input split (roughly one per HDFS block) and <em>R</em> reduce tasks, a number the job author chooses (Hadoop's default is 1). Each reduce task handles many keys. Between the two phases the framework partitions, sorts and moves the data (the shuffle), and it reruns any task that fails.",
      problem: "Running custom code over petabytes on thousands of unreliable machines forced every team to solve distribution, data movement and machine failures by hand before writing a single line of business logic.",
      why: "It reduced distributed computing to writing two pure functions. The framework owns parallelism, data placement, networking and retries, so application code never deals with partial failure. Recovery is simple because inputs are immutable and a failed task's partial output is thrown away: just run the task again. The model is rigid (one map, one reduce, every output materialized), which is why Spark, Flink and SQL engines have largely replaced it. Their joins, shuffles and recovery still follow its design.",
      ex: "Word count: map emits (word, 1) for each token, and reduce sums the ones for each word. Dean and Ghemawat described MapReduce in their OSDI 2004 paper; Hadoop, split out of the Nutch project and adopted by Yahoo! in 2006, reimplemented it. When Google launched Cloud Dataflow in 2014, it said it had largely moved on from MapReduce internally. Don't confuse it with the mapReduce query feature of MongoDB or CouchDB (ch2), which borrows the idea for queries inside one database.",
      section: "mapreduce-and-hdfs",
    },
    {
      id: "data-locality",
      term: "Data locality (moving computation to the data)",
      def: "Scheduling a task on (or near) a machine that already stores a replica of its input block, so the input is read from local disk instead of over the network. The job's code is shipped to the data instead. Locality is best effort: the scheduler tries node-local first, then rack-local, then falls back to a remote read. Not to be confused with <a href=\"#/ch2/concepts/data-locality\">Chapter 2's data locality</a>, which means storing data that is read together in one place on disk.",
      problem: "Moving terabytes of input to wherever the code runs would saturate the network, while the code itself is only a few megabytes.",
      why: "In early Hadoop clusters, network bandwidth, especially between racks, was the scarcest resource, while every machine had local disks. That is why HDFS and the compute framework shared the same machines. Faster datacenter networks and object storage have weakened the argument: Spark on S3 reads everything remotely and relies on network bandwidth, giving up locality so that storage and compute can scale independently.",
      ex: "For a 128 MB block replicated on nodes A, B and C, the scheduler prefers a free slot on A, B or C, then any node in their racks, and only then a node elsewhere. The MapReduce paper notes that in large jobs at Google most input was read locally and used no network bandwidth. Delay scheduling (Zaharia et al., EuroSys 2010), adopted in Hadoop's Fair Scheduler, waits briefly for a local slot rather than running a task remotely right away.",
      section: "mapreduce-and-hdfs",
    },
    {
      id: "shuffle",
      term: "Shuffle",
      def: "The data movement between map and reduce, and it is entirely deterministic. Each mapper buffers its output in memory, partitions it by <code>hash(key) mod R</code>, sorts each partition by key, and spills the sorted files to its <strong>local disk</strong> (not HDFS). Each reducer fetches its partition from every mapper and merge-sorts the runs, so all values for a key arrive together, in key order. Reducers start copying as soon as individual map tasks finish (Hadoop's slowstart, by default once 5% of maps are done), but no <code>reduce()</code> call can run until every map task has finished, because the last mapper might still emit any key.",
      problem: "Every mapper's output contains values for every key, so the values for a given key are scattered across thousands of machines and must all be brought to one reducer.",
      why: "The shuffle is usually the most expensive part of a job (disk writes, network transfer, sorting, serialization), and it is where skew shows up. Most optimizations therefore try to shrink it or avoid it: combiners, map-side joins, data that is already partitioned (bucketed). Because map output lives only on local disk, losing a machine loses the output of its <em>completed</em> map tasks, so those tasks are rerun; completed reduce tasks are not rerun, because their output is safely in HDFS. 'Shuffle' is a misleading name: nothing is randomized.",
      ex: "Hadoop's map-side sort buffer is 100 MB by default and spills at 80% full. Spark writes shuffle files to local disk in the same way, and every shuffle shows up as a stage boundary in the Spark UI. With R = 200 (Spark SQL's default <code>spark.sql.shuffle.partitions</code>), the key '/checkout' goes to partition hash('/checkout') mod 200 on every mapper, so all its counts meet in one task.",
      section: "mapreduce-and-hdfs",
    },
    {
      id: "combiner",
      term: "Combiner",
      def: "An optional map-side 'mini reducer' applied to a mapper's sorted output before the shuffle, for example pre-summing counts per word. It is valid only for associative and commutative operations, and its output must have the same type the reducer consumes. The framework may run it zero, one or many times, so it must never change the result.",
      problem: "Word count naively shuffles one (word, 1) record per occurrence: billions of tiny records over the network when a few per mapper per key would do.",
      why: "For counts and sums a combiner can cut shuffle volume by orders of magnitude, and it largely neutralizes hot keys in aggregations, because a hot key gets pre-summed on every mapper. It is purely an optimization: the result must be identical whether it runs or not. That rules out averaging averages (carry (sum, count) pairs instead) and rules out exact medians or exact distinct counts (use mergeable sketches such as t-digest or HyperLogLog).",
      ex: "Word count over 1 billion words with 1 million distinct words: without a combiner the shuffle carries 1 billion (word, 1) pairs; with one, each mapper sends at most one partial count per distinct word it saw. In Spark, <code>reduceByKey</code> and <code>aggregateByKey</code> combine on the map side automatically, but <code>groupByKey</code> followed by a sum does not, so it shuffles every record. Pregel uses combiners to pre-sum PageRank messages headed for the same vertex.",
      section: "mapreduce-and-hdfs",
    },

    // ---- reduce-side-joins ----
    {
      id: "reduce-side-join",
      term: "Reduce-side join",
      def: "A join performed by the shuffle itself, also called a sort-merge join. One mapper reads the event log and emits (user_id, event); another reads a <em>snapshot</em> of the users table and emits (user_id, profile). Partitioning by user_id brings every record with the same key to the same reduce call, and a <strong>secondary sort</strong> makes the profile arrive first. The reducer then keeps that one profile in a local variable and streams the user's events past it, with no network calls.",
      problem: "Looking up each event's user in a remote database is slow (one round trip per record), can overload the database, and makes the result nondeterministic, because the database keeps changing while the job runs.",
      why: "It works for inputs of any size and needs no knowledge of how they are laid out, which is why it is the default when nothing better is known (Spark SQL's SortMergeJoin). The price is a full shuffle of both inputs, and the main risk is <strong>skew</strong>: every record for a hot key goes to one reducer. A useful mental model is that mappers send messages to reducers and the key is the address. The framework handles the networking and retries, so the join code never has to deal with partial failure.",
      ex: "Join a day of clickstream (5 TB) with a users snapshot (400 GB) exported from the OLTP database's backup or through CDC, emitting (url, viewer_age) for a later per-URL aggregation. The same mechanism implements GROUP BY: counts, sums, top-k per key, and sessionization (gathering one user's events from the logs of hundreds of web servers).",
      section: "reduce-side-joins",
    },
    {
      id: "secondary-sort",
      term: "Secondary sort",
      def: "Controlling the order of values within one reducer key group by sorting on a composite key while partitioning and grouping on the join key alone. For example, the user's profile record arrives first, then that user's events by timestamp.",
      problem: "Without it, the reducer would have to buffer all of a key's records in memory just to find the one profile record among millions of events.",
      why: "With the profile guaranteed to come first, the reducer needs O(1) memory per key however many events a user has. In Hadoop it is built by hand: a composite key, a custom partitioner on the join key, and a grouping comparator on the join key. Spark's RDD API offers <code>repartitionAndSortWithinPartitions</code>, and SQL engines do the same thing implicitly inside sort-merge joins and window functions. You rarely write it by hand today, but it explains how those engines work.",
      ex: "Sessionization: use key (user_id, timestamp), partitioned and grouped by user_id, so each reduce call sees one user's clicks in time order and can start a new session after a 30-minute gap. For a join, give profile records sort tag 0 and events sort tag 1, so the profile always sorts first.",
      section: "reduce-side-joins",
    },
    {
      id: "hot-key-handling",
      term: "Hot-key handling (skewed join, two-stage aggregation)",
      def: "Spreading the records of a known hot key across several reducers and replicating the matching records of the other join input to each of them, or aggregating in two stages: partial aggregates on randomly chosen reducers, then a combining pass. Also called <strong>salting</strong>.",
      problem: "Hash partitioning sends every record of a celebrity key to one reducer, which becomes a straggler, and the job waits for its slowest task.",
      why: "A stage finishes only when its slowest task does, so one skewed key can stretch a 5-minute stage into hours. Adding reducers doesn't help, because one key still hashes to one reducer. Splitting the key works, at the cost of a sampling pass to find hot keys and of copying the other side's matching records k times. Very often the hot key is a NULL or placeholder value ('unknown', 0, empty string): filter those out or process them separately.",
      ex: "Pig's skewed join samples the input to find hot keys, spreads their records over several reducers, and copies the other input's matching records to each one. Crunch's sharded join is similar, but you name the hot keys yourself. Hive's skewed tables store known hot keys in separate files and join them with a map-side join. Spark 3's adaptive query execution (on by default since 3.2) splits skewed shuffle partitions at runtime. The book's example is celebrities on a social network.",
      section: "reduce-side-joins",
    },
    {
      id: "speculative-execution",
      term: "Speculative execution (backup tasks)",
      def: "Near the end of a stage, the scheduler launches duplicate attempts of unusually slow tasks on other machines, keeps whichever finishes first, and discards the other.",
      problem: "A single slow machine (a failing disk, CPU contention) delays a whole stage, because a stage finishes only when its slowest task does.",
      why: "It fixes slow machines, never data skew or nondeterminism: a backup of a skewed task gets the same oversized partition. Duplicate attempts are harmless only because task output goes through the framework's commit protocol, in which only one attempt per task may commit. A task that writes directly to an external database would write twice. Hadoop MapReduce enables speculation by default; Spark leaves it off (<code>spark.speculation = false</code>).",
      ex: "The MapReduce paper reports that its sort benchmark took 44% longer with backup tasks disabled. A typical case: one node with a failing disk reads at a tenth of normal speed, its tasks get backup copies on healthy nodes, and the backups finish first.",
      section: "reduce-side-joins",
    },

    // ---- map-side-joins ----
    {
      id: "map-side-join-broadcast",
      term: "Map-side join (broadcast)",
      def: "When one input is small enough to fit in memory, every task for the large input loads all of the small input into an in-memory hash table ('broadcast' because every task receives all of it; 'hash' for the hash table), then streams its block of the large input and looks up each key. There is no reducer, no sort, and no shuffle of the large side. Pig calls it a replicated join, Hive a MapJoin, Spark a broadcast hash join.",
      problem: "Shuffling 2 TB of events just so they can meet a 1 GB lookup table moves and sorts the big side for nothing.",
      why: "It avoids shuffling the large side; how much faster that makes the job depends on the size ratio and the cluster. The risk is memory. The small side becomes a hash table in every task, often several times its compressed, columnar size on disk, and a 'small' side whose size was badly estimated causes out-of-memory errors. Spark broadcasts automatically when a side's estimated size is below <code>spark.sql.autoBroadcastJoinThreshold</code> (10 MB by default), accepts a BROADCAST hint, and since 3.0 can let AQE switch a planned sort-merge join to a broadcast join once actual sizes are known. One variant keeps the small side as a read-only index on local disk, with the hot parts in the OS page cache.",
      ex: "Star-schema joins: a 5 TB fact table of page views joined with a 20 MB table of countries or product categories. In Pig: <code>JOIN views BY country_id, countries BY id USING 'replicated'</code>, with the small relation listed last.",
      section: "map-side-joins",
    },
    {
      id: "map-side-join-partitioned",
      term: "Map-side join (partitioned)",
      def: "If both inputs are split into the <strong>same number</strong> of partitions, by the <strong>same key</strong>, using the <strong>same hash function</strong>, then all records for a given key sit in partition i on both sides. Task i loads partition i of the smaller input into a hash table and scans partition i of the larger. Hive calls this a bucketed map join.",
      problem: "The smaller side doesn't fit in memory, but both inputs are already split the same way, so a full shuffle would only recreate a layout that already exists.",
      why: "Each task needs memory for only one bucket of the smaller side, and nothing is shuffled. It works only if you <em>know</em> the physical layout, which is why metadata matters (the Hive metastore or HCatalog, and today table formats such as Iceberg, whose metadata records bucket partitioning). If the partition counts or hash functions differ, a hand-written job silently drops matches; engines check the metadata and fall back to a shuffle. The layout arises naturally when both inputs were written by earlier jobs that grouped by the same key.",
      ex: "Clickstream and users are both written as 256 buckets by hash(user_id) (Hive: <code>CLUSTERED BY (user_id) INTO 256 BUCKETS</code>), so task 17 joins bucket 17 of each. Spark's native bucketing has historically used a different hash function and file layout from Hive's, so a table bucketed by one engine is generally not treated as bucketed by the other: the hash function is part of the layout contract.",
      section: "map-side-joins",
    },
    {
      id: "map-side-merge-join",
      term: "Map-side merge join",
      def: "If both inputs are partitioned the same way <em>and</em> sorted by the join key within each partition, a task reads the matching partitions of both inputs in order and merges them, like the merge step of merge sort. Memory is not a constraint, because both sides are streamed. Hive calls it a sort-merge-bucket (SMB) join.",
      problem: "Even one partition of the smaller side may not fit in memory. If the inputs are already sorted, though, nothing needs to be held in memory at all.",
      why: "Constant memory and no shuffle. But if an earlier job already partitioned and sorted both inputs, it could often have done the join itself in its reduce phase. A separate merge join pays off when those sorted datasets are reused by many jobs. Like the partitioned join, it depends on knowing the layout exactly.",
      ex: "Tables bucketed and sorted on the join key by earlier jobs: declaring <code>CLUSTERED BY (user_id) SORTED BY (user_id) INTO 256 BUCKETS</code> on both sides lets Hive's optimizer choose an SMB join. Pig exposes the same strategy as <code>USING 'merge'</code>.",
      section: "map-side-joins",
    },

    // ---- batch-outputs ----
    {
      id: "output-of-batch-jobs",
      term: "Output of batch jobs",
      def: "Batch jobs rarely produce just a report. Typical outputs are search indexes (Lucene/Solr index files built per partition), ML models and training sets, key-value datasets for serving (recommendations, 'people you may know'), and aggregated tables for the warehouse. The rule: don't write to the live database from inside tasks. Build immutable files, or a whole new database image, in the job's output directory, then bulk-load them and swap them in atomically.",
      problem: "Results must reach users without hurting production, and without exposing half-finished data or duplicates when tasks are retried.",
      why: "Writing row by row from tasks has three problems. It is orders of magnitude slower than the job's own throughput. Hundreds of parallel tasks can overwhelm a database that is serving live traffic. And it breaks the all-or-nothing guarantee: readers see partial results, and retried or speculative tasks write duplicates. Building the output as files keeps the job a pure function of its input, so the output can be validated before it is published and replaced as a whole.",
      ex: "Google rebuilt its production web-search indexing as a sequence of 5 to 10 MapReduce jobs, one of the framework's most significant early uses. LinkedIn's Voldemort read-only stores, Pinterest's Terrapin and ElephantDB serve files built in Hadoop, and HBase bulk load moves job-written HFiles into live regions, bypassing the normal write path. Google later moved web indexing to incremental processing with Percolator (OSDI 2010), which cut the average age of documents in search results by 50%: a case where rebuilding everything was no longer enough.",
      section: "batch-outputs",
    },
    {
      id: "immutable-output-swap",
      term: "Build-and-swap outputs",
      def: "A batch job writes a complete new version of its output (index files, key-value store files, a table snapshot) to a new location. The serving side loads it in the background, switches to it atomically, and keeps the previous version for rollback.",
      problem: "Writing results row by row into a live database from inside tasks is slow, overloads production, exposes half-finished results, duplicates rows on retry, and makes bad runs irreversible.",
      why: "Building the files is a natural batch job (extract a key, sort by it). Serving nodes stay fast because they only read immutable files, and rollback is simply switching back. The switch must be atomic from the readers' point of view: a version pointer, a rename on HDFS, or a table-format commit (Iceberg, Delta Lake, Hudi) that publishes new metadata in one step.",
      ex: "Voldemort (FAST 2012 paper): servers keep serving the old version while they fetch the new files from HDFS in parallel, then swap atomically, and can roll back instantly. LinkedIn used it to serve batch-computed data such as 'People You May Know'. Iceberg and Delta keep earlier snapshots, so readers can 'time travel' back to yesterday's table.",
      section: "batch-outputs",
    },
    {
      id: "human-fault-tolerance",
      term: "Human fault tolerance",
      def: "The ability to recover from buggy code by rolling back the code and rerunning it (or switching back to a previous output). This is possible because inputs are immutable and outputs are derived.",
      problem: "In a read-write database, a buggy deploy that writes bad data stays bad after the code is rolled back, so every human mistake can become permanent damage.",
      why: "Minimizing irreversibility makes teams faster: if a bad deploy only costs a rerun, you can ship and experiment more boldly. It takes discipline. Inputs must be immutable and kept long enough, tasks must be deterministic, outputs must overwrite whole partitions, and jobs must never modify their own inputs. It is the batch version of an idea ch12 builds on: derived data can always be recomputed from the source of truth.",
      ex: "A bug in a feature job corrupts two weeks of a derived table. You fix the code and backfill the 14 date partitions from the raw logs, or first point readers at the last good Iceberg or Delta snapshot. Compare an OLTP table where a buggy UPDATE overwrote rows in place: rolling back the code doesn't bring the old values back, and only restoring a backup can.",
      section: "batch-outputs",
    },
    {
      id: "workflow-engine",
      term: "Workflow engine",
      def: "A scheduler that runs a DAG of batch jobs: it starts each job when its inputs are ready, retries failures, raises alerts, and reruns ranges of past dates (backfills). Underneath, Hadoop chains jobs only by directory name: job 2's input directory is job 1's output directory, and an output counts only once its job has succeeded, which Hadoop marks with a <code>_SUCCESS</code> file.",
      problem: "Real pipelines are dozens of dependent jobs (the book mentions 50 to 100 MapReduce jobs for a recommendation system), and cron plus 'wait until the directory exists' scripts turn into a fragile second system.",
      why: "A workflow is only safe to retry and backfill if each task is <strong>deterministic and idempotent</strong> and <strong>overwrites a whole output partition</strong> (for example <code>dt=2025-01-14</code>) instead of appending to it; then a rerun replaces exactly what that task owns. Higher-level tools (Pig, Hive, Cascading, Crunch, FlumeJava, and today Spark and dbt) can also compile one program into a multi-job workflow automatically.",
      ex: "Oozie (Yahoo!), Azkaban (LinkedIn), Luigi (Spotify), Airflow (started at Airbnb in 2014 by Maxime Beauchemin), Pinball (Pinterest), and newer tools such as Dagster and Prefect. Beauchemin's 2018 essay 'Functional Data Engineering' argues for exactly this style: pure tasks that write immutable partitions.",
      section: "batch-outputs",
    },

    // ---- hadoop-vs-mpp ----
    {
      id: "mpp-database",
      term: "MPP database",
      def: "A massively parallel processing analytic database (Teradata, Vertica, Greenplum, Redshift; research roots in systems such as Gamma in the 1980s) that runs SQL in parallel across a shared-nothing cluster, with tightly integrated storage, planner and executor.",
      problem: "Single-node data warehouses could not scan and join terabytes fast enough for analytics.",
      why: "Because the storage layout, planner, scheduler and executor are designed together, these databases are very fast at the SQL queries they target, and SQL makes them usable by analysts and BI tools. The costs: data must be modeled and loaded into the database's own format first, arbitrary code (ML, image analysis) is awkward to run as UDFs, and a node failure typically aborts and reruns the whole query. That is fine for queries that take minutes, not for six-hour jobs.",
      ex: "In the 2008 to 2010 debate, DeWitt and Stonebraker titled their critique 'MapReduce: A major step backwards' (2008). Pavlo et al. (SIGMOD 2009) found parallel databases faster than Hadoop on most tasks once the data was loaded, but loading took much longer. Dean and Ghemawat replied (CACM 2010) that MapReduce's value lay in flexibility, fault tolerance and working on raw data. The two camps then converged: Impala, Trino and Spark SQL borrowed MPP techniques, and MPP warehouses became more programmable.",
      section: "hadoop-vs-mpp",
    },
    {
      id: "data-lake",
      term: "Data lake",
      def: "A central store (HDFS or object storage) where raw data from across an organization is dumped in whatever format it arrives in, and interpreted later by each consumer (schema-on-read).",
      problem: "Requiring careful up-front modeling and import into a warehouse slowed data collection to a crawl, so many datasets were never brought together and joined at all.",
      why: "Collecting raw data quickly and deciding later how to interpret it beats waiting for a perfect warehouse model. It shifts the work of interpretation from the producer to the consumer (schema-on-read, ch2), and keeping the raw data lets you reinterpret it when you learn more (the 'sushi principle': raw data is better). The risk is a swamp of undocumented, inconsistent files, which is why catalogs and table formats came later. Hadoop often became the ETL stage: dump raw data into HDFS, clean it with batch jobs, then load the result into an MPP warehouse.",
      ex: "Raw clickstream JSON, crawled HTML, images and database exports land in HDFS or S3 as they are, and Hive, Spark, Impala and HBase all run over the same files without copying data between specialized systems. Today's 'lakehouse' adds Iceberg, Delta Lake or Hudi tables on object storage for transactions and schema evolution.",
      section: "hadoop-vs-mpp",
    },
    {
      id: "task-preemption",
      term: "Task preemption and task-level recovery",
      def: "On shared clusters, low-priority batch tasks can be killed at any time to free resources for higher-priority work. MapReduce therefore retries individual tasks and writes intermediate data durably, rather than restarting whole jobs.",
      problem: "With hundreds of tasks and per-task kill rates of a few percent per hour, the probability that some task dies approaches certainty, so a job that restarted from scratch on any failure would rarely finish.",
      why: "This, more than hardware failure, explains why MapReduce writes so eagerly to disk. According to the book, a MapReduce task running for an hour at Google had roughly a 5% chance of being preempted, more than an order of magnitude above the failure rate from hardware problems and reboots. Running batch at low priority in the leftover capacity of production clusters lets the operator overcommit machines and keep utilization high. Where tasks rarely die, durable intermediate data is pure overhead, which dataflow engines exploit. Cheap preemptible cloud capacity has since brought the problem back.",
      ex: "For 10-minute tasks at 5% per hour, p = 1 &minus; 0.95<sup>1/6</sup> &asymp; 0.85% per task, and P(at least one of 100 tasks killed) = 1 &minus; (1 &minus; p)<sup>100</sup> &asymp; 57%. Google's Borg (EuroSys 2015) runs production services and batch on shared machines with priorities and preemption. AWS Spot Instances get a two-minute interruption notice and Google Cloud preemptible VMs get 30 seconds, and batch engines run well on them because they retry at the level of individual tasks.",
      section: "hadoop-vs-mpp",
    },

    // ---- dataflow-engines ----
    {
      id: "materialization-of-intermediate-state",
      term: "Materialization of intermediate state",
      def: "Writing intermediate results out as files. Chained MapReduce jobs fully materialize every job's output in the distributed filesystem (replicated, typically 3&times;) before the next job may start. Dataflow engines avoid this: intermediate data stays in memory or on local disk, and lost partitions are recovered by recomputing them from lineage (Spark) or by restarting from an earlier stage or checkpoint. At shuffle boundaries Spark still writes intermediate data to local disk, just as MapReduce does with map output.",
      problem: "Chained MapReduce jobs rewrite every intermediate result to replicated storage and wait at every job boundary, even when the data will only ever be read once, by the next job of the same team.",
      why: "Materializing is the right choice when the output is a dataset other people will reuse, or when you want to inspect a pipeline midway and restart from there (like saving one stage of a Unix pipeline to a file). For temporary data it costs in three ways. A job can start only when every task of the previous job has finished, so stragglers delay the whole chain. The next job's mappers are often redundant, just rereading what a reducer wrote. And replicating temporary files is overkill. Avoiding materialization is one of the main wins of dataflow engines, though not the only one.",
      ex: "A Hive query compiled to four MapReduce jobs writes three intermediate datasets to HDFS, each with 3 replicas. The same query on Tez or Spark writes only its final output to durable storage, with shuffle files on local disks in between. Unix pipes are the opposite extreme: data streams through a small in-memory buffer.",
      section: "dataflow-engines",
    },
    {
      id: "dataflow-engines",
      term: "Dataflow engines (Spark, Flink, Tez)",
      def: "Engines that run a whole workflow as one job: a DAG of <strong>operators</strong> (map, filter, join, group, sort...) instead of a strict alternation of map and reduce. Like MapReduce, they call user functions one record at a time per partition and move data between operators over the network. Unlike it, they sort only where needed, fuse chains of operators into one task that pipelines records through them, and reuse long-lived executor processes. Operators can be connected in three ways: repartition and sort, repartition without sorting, or broadcast. Spark waits at shuffle (stage) boundaries until the whole parent stage has finished; Flink can pipeline across exchanges.",
      problem: "MapReduce forces every computation into rounds of map, sort and reduce. A five-step workflow becomes five jobs, each sorting whether it needs to or not, each paying start-up costs, and each scheduled with no view of the pipeline as a whole.",
      why: "Because the engine sees the whole DAG, it can skip unnecessary sorts and map stages, place a consumer next to its producer, and choose join strategies. Multi-job workflows usually get substantially faster, and Hive or Pig jobs could switch engines with a configuration change. How much faster depends on the workload: the RDD paper reports up to 20&times; for iterative applications, while single-pass ETL gains much less. The trade-off is that without replicated intermediate data, recovery relies on recomputation, and that requires deterministic operators.",
      ex: "Spark (RDD paper, NSDI 2012); Apache Tez, a thin library on top of YARN's shuffle service used by Hive; and Flink, which grew out of the Stratosphere research project and is built around pipelined execution. Their research ancestors are Microsoft's Dryad and TU Berlin's Nephele. In 2014 Spark sorted 100 TB in 23 minutes on 206 machines, against Hadoop MapReduce's previous record of 72 minutes on 2,100 machines.",
      section: "dataflow-engines",
    },
    {
      id: "narrow-wide-dependencies",
      term: "Narrow vs wide dependencies",
      def: "Spark's terms for how operators connect. In a <strong>narrow</strong> dependency, each output partition reads a bounded set of input partitions (usually one), so the operators are fused and pipelined inside one task. In a <strong>wide</strong> dependency, an output partition needs data from many input partitions, which requires a shuffle and starts a new stage.",
      problem: "An engine that treats every operator boundary as a full shuffle (like MapReduce's map &rarr; reduce) moves and sorts data needlessly. Knowing which boundaries really need a shuffle lets it pipeline the rest and recompute only what a failure actually lost.",
      why: "Counting the wide dependencies in a plan is the quickest way to estimate a Spark job's cost, because each one means disk writes, network transfer and possible skew. You remove them with broadcast joins, co-partitioned or bucketed inputs, or <code>reduceByKey</code> instead of <code>groupByKey</code>. They also set the cost of recovery: a lost narrow partition is recomputed from its single parent, while lost shuffle output raises a FetchFailed error and reruns the missing map tasks of the parent stage.",
      ex: "<code>textFile &rarr; map &rarr; filter</code> runs as one task per partition (narrow, fused); adding <code>reduceByKey</code> adds a shuffle, so the Spark UI shows two stages. A join of two RDDs that already share the same partitioner is narrow; otherwise it is wide. The book's three kinds of edges map onto these terms: repartition (with or without sort) is a shuffle, and broadcast is a broadcast variable or broadcast join.",
      section: "dataflow-engines",
    },
    {
      id: "lineage-recovery",
      term: "Lineage-based recovery",
      def: "Recovering lost intermediate data by rerunning the recorded chain of transformations that produced it, starting from an earlier stage that still exists or from the durable input. This is how Spark's RDDs recover.",
      problem: "Dataflow engines stop materializing intermediate state to replicated storage, so when a machine dies, the partitions in its memory or on its local disk are simply gone.",
      why: "Nothing is replicated on the happy path, so jobs run fast when nothing fails. The cost appears when something does fail: long lineage chains (iterative jobs) make recomputation expensive, and a small result that was expensive to compute is better materialized. Spark's <code>checkpoint()</code> writes an RDD to reliable storage and cuts its lineage, and <code>persist()</code> with a replicated storage level keeps extra in-memory copies. Flink takes a different route: in streaming mode it restores the latest checkpoint of operator state, and in batch mode it materializes data at shuffles and reruns only the stages whose output was lost. With fully pipelined exchanges there is nothing to recompute from, so a failure restarts the whole connected pipelined region.",
      ex: "In an iterative PageRank on Spark, iteration 40's ranks depend on all 39 earlier iterations, so losing an executor may force recomputation through many of them unless the job checkpoints every few iterations. The RDD paper (NSDI 2012) introduced lineage-based recovery. An external shuffle service keeps shuffle files available even when the executor that wrote them dies.",
      section: "dataflow-engines",
    },
    {
      id: "deterministic-operators",
      term: "Deterministic operators",
      def: "Operators that always produce the same output for the same input: no unseeded randomness, and no dependence on hash-table iteration order, wall-clock time or external services.",
      problem: "If a recomputed partition differs from the lost one that downstream tasks already consumed, the results contradict each other. The engine then has to discard and rerun downstream work, or the output is silently corrupted.",
      why: "Lineage recovery, speculative execution and task retries all assume that a rerun reproduces what was lost. Accidental nondeterminism comes from hash-table or set iteration order, unseeded random numbers, the system clock, external lookups, and round-robin partitioning that depends on input order. Fix it by seeding random number generators from the partition id, sorting before order-sensitive steps, and passing 'now' into the job as a parameter. Determinism also makes reruns and backfills reproducible, which human fault tolerance depends on.",
      ex: "Spark issue SPARK-23207: a DataFrame <code>repartition()</code> (round-robin, which depends on input order) followed by a fetch failure and a retry could produce duplicated or missing rows. The fix made the partitioning deterministic, and later versions mark such stages as 'indeterminate' and rerun everything downstream of them. A job that stamps rows with <code>current_timestamp()</code> produces different output every time it is rerun.",
      section: "dataflow-engines",
    },

    // ---- graph-processing ----
    {
      id: "iterative-graph-processing",
      term: "Iterative / graph processing (Pregel, BSP)",
      def: "Batch algorithms over a whole graph (PageRank, connected components, shortest paths) that run until they converge. In the <strong>Pregel</strong>, or bulk synchronous parallel (BSP), model, each superstep calls a function for every active <strong>vertex</strong> with the messages sent to it in the previous superstep. The vertex updates its state (which stays in memory between supersteps), sends messages along its edges, and may vote to halt. A barrier separates supersteps. A halted vertex wakes up if it receives a message, and the job ends when every vertex has halted and no messages are in flight. For fault tolerance, all vertex state is checkpointed every few supersteps, and the whole graph is rolled back to the last checkpoint on failure.",
      problem: "MapReduce has no loops. Each iteration is a separate job that rereads and rewrites the whole graph, driven by an external scheduler that checks for convergence, even when only a few vertices changed.",
      why: "Vertex state stays in memory, and only vertices that received messages do any work, so iterations are cheap. Pregel guarantees that each message is processed exactly once in the next superstep despite an unreliable network, and combiners and aggregators reduce traffic and detect convergence. The costs: the barrier makes every superstep wait for its slowest worker, and hashing vertex ids across machines sends most messages over the network, sometimes more data than the graph itself. If the graph fits on one machine, a single-machine algorithm often wins.",
      ex: "Google's Pregel paper (SIGMOD 2010) builds on Valiant's BSP model (1990); open-source versions include Giraph, Spark GraphX and Flink Gelly. Facebook ran Giraph on graphs with over a trillion edges (VLDB 2015). Twitter's first Who-to-Follow service kept the whole follow graph in memory on one server (WWW 2013), and the COST paper (HotOS 2015) showed single-threaded laptop code matching or beating distributed graph systems on PageRank and connected components. Don't confuse this with dataflow DAGs: there the graph is the job, here the graph is the data.",
      section: "graph-processing",
    },

    // ---- high-level-apis ----
    {
      id: "high-level-apis",
      term: "High-level APIs (Hive, Pig, Spark SQL)",
      def: "Declarative or relational-style interfaces on top of batch engines: SQL (Hive, Spark SQL, Flink SQL), dataflow languages (Pig Latin), and DataFrame or dataset APIs (Spark, Flink, Beam, and FlumeJava-style Java libraries such as Cascading and Crunch). Joins, grouping, filters and aggregates are expressed as operators, so a query optimizer chooses the algorithms, and user-defined functions remain as an escape hatch for arbitrary code. Hive, Pig, Spark SQL and Flink SQL compile to dataflow jobs; Impala, Trino and BigQuery are separate MPP-style query engines that are often used over the same files.",
      problem: "Hand-written MapReduce is verbose (a join is a page of mapper, reducer, partitioner and comparator code) and hides the programmer's intent from the engine, which therefore can't choose a better join or skip data it doesn't need.",
      why: "The optimizer can choose between broadcast, bucketed and sort-merge joins, and pick the join order, from statistics. It can read only the needed columns from Parquet or ORC and push filters down to skip data (column pruning, predicate pushdown), and it can use vectorized execution and code generation. The result usually matches or beats hand-written jobs. The catch is that opaque UDFs block these optimizations, and row-at-a-time Python UDFs in PySpark also serialize every row between the JVM and Python. Overall the systems converge: batch frameworks gain MPP-like performance while keeping arbitrary code, and MPP databases become more programmable.",
      ex: "Pig Latin came from Yahoo! Research (SIGMOD 2008) and Hive from Facebook (open-sourced 2008). Both first compiled to chains of MapReduce jobs and later gained Tez and Spark back ends. Spark SQL's Catalyst optimizer (SIGMOD 2015) was mostly rule-based at launch; a cost-based optimizer arrived in Spark 2.2. <code>EXPLAIN</code> shows whether Spark chose a BroadcastHashJoin or a SortMergeJoin. Libraries of common algorithms run on the same engines: Spark MLlib and Mahout for machine learning, and MADlib inside MPP databases.",
      section: "high-level-apis",
    },
    {
      id: "vectorized-execution",
      term: "Vectorized execution and code generation",
      def: "Processing batches of column values in tight, cache-friendly loops instead of calling a function per record, often with query-specific code compiled at runtime (Spark's whole-stage code generation to JVM bytecode, Impala's LLVM).",
      problem: "Calling an opaque function for every record, row by row, wastes most of the CPU time on overhead rather than on the actual filter or arithmetic.",
      why: "Per-record virtual calls, branches and object allocations defeat CPU caches and pipelining. Tight loops over batches of column values stay in cache and can use SIMD instructions, which often makes scans, filters and aggregations several times faster. It only works when the engine understands the operations, which is another reason to prefer built-in functions over opaque UDFs, and it pairs naturally with columnar storage formats (ch3).",
      ex: "Spark 2.0 (2016) added whole-stage code generation (Project Tungsten), which compiles a chain of operators into one generated JVM function; Impala generates native code with LLVM. Newer vectorized C++ engines include Databricks Photon (SIGMOD 2022) for Spark SQL and Delta, Meta's Velox (2022) inside Presto- and Spark-based systems, and DuckDB on a single machine.",
      section: "high-level-apis",
    },
  ],

  cheatsheet: [
    {
      title: "Three kinds of systems",
      type: "table",
      headers: ["", "Online service", "Batch job", "Stream processor (ch11)"],
      rows: [
        ["Input", "One request at a time", "Bounded: a fixed set of files or a snapshot", "Unbounded events, consumed shortly after they happen"],
        ["Judged by", "Response time, availability", "Throughput: time to process a dataset of a given size", "Event-to-output latency and throughput"],
        ["Typical latency", "Milliseconds", "Minutes to days; usually scheduled (nightly, hourly)", "Milliseconds to seconds"],
        ["Knows it's done?", "Per request", "Yes: it has read all of its input", "Never: the input doesn't end"],
        ["Rerun after a bug fix", "Not possible: the requests are gone", "Easy: rerun on the same immutable input", "Possible if the event log is retained (replay)"],
        ["Examples", "Profile page, checkout API", "Search index build, nightly recommendations, ML training set", "Fraud alerts, live dashboards, cache updates"],
      ],
      note: "Back of the envelope: one machine at 200 MB/s reads 2 TB in about 2.8 hours; 1,000 machines read it in about 10 seconds each. Parallelism is why partial failure is built into every batch design.",
    },
    {
      title: "Unix pipeline &harr; MapReduce &harr; Spark",
      type: "table",
      headers: ["Unix pipeline", "MapReduce", "Spark / modern"],
      rows: [
        ["Read the log line by line", "Input format splits HDFS blocks into records", "Read Parquet/JSON files into partitions"],
        ["<code>awk '{print $7}'</code>", "map: extract a key and value", "map / select / withColumn"],
        ["<code>sort</code>", "Partition by hash(key) mod R, sort, shuffle, merge", "Shuffle exchange (wide dependency)"],
        ["<code>uniq -c</code>", "reduce: one call per key with all its values", "groupBy().count() / reduceByKey"],
        ["<code>sort -rn | head</code>", "A second, chained job", "Another stage of the same DAG"],
        ["Files in a directory", "part-r-00000, part-r-00001, ... in an output directory", "part-*.parquet files in a table directory"],
        ["Temp files you can inspect with <code>less</code>", "Materialized job outputs in HDFS", "Cached or checkpointed datasets"],
        ["One machine", "Thousands of machines; failed tasks retried", "Same, plus lineage-based recovery"],
      ],
    },
    {
      title: "Unix principles that carry over",
      type: "list",
      items: [
        "<strong>Do one thing well</strong>: each stage is one transformation; composing stages beats writing a monolith.",
        "<strong>Uniform interface</strong>: newline-separated text over file descriptors then; files with a known format (Parquet, Avro) in a distributed filesystem now.",
        "<strong>Separate logic from wiring</strong>: stdin/stdout then; input and output directories set by the workflow now.",
        "<strong>Immutable inputs</strong>: rerun as often as you like; the job's only effect is its output.",
        "<strong>Inspect any stage</strong>: pipe into <code>less</code>, or read a job's materialized output.",
        "<strong>No shared state</strong>: map and reduce are pure per-record and per-key functions, trivial to parallelize and retry.",
        "<strong>The limit</strong>: one machine. A hash map needs RAM per distinct key; sort-based grouping (external merge sort) scales past memory.",
      ],
    },
    {
      title: "A MapReduce job, step by step",
      type: "list",
      items: [
        "<strong>Split</strong>: one map task per input split (&asymp; one HDFS block); the scheduler aims for data locality (node-local, then rack-local, then remote).",
        "<strong>Map</strong>: called per record; output buffered in memory (100 MB), partitioned by <code>hash(key) mod R</code>, sorted, optionally combined, spilled to <em>local</em> disk at 80% full, and the spills merged.",
        "<strong>Shuffle</strong>: each of the R reducers fetches its partition from every mapper (starting once 5% of maps are done) and merge-sorts the runs.",
        "<strong>Reduce</strong>: <code>reduce()</code> called once per key, only after <em>all</em> maps have finished; output written to HDFS as <code>part-r-0000N</code> (3 replicas).",
        "<strong>Failure</strong>: rerun the task elsewhere. Completed maps on a dead machine are rerun too (their output was on its local disk); completed reduces are not.",
        "<strong>Commit</strong>: each attempt writes to its own temporary directory; one attempt per task commits; job commit promotes the output and writes <code>_SUCCESS</code>.",
      ],
    },
    {
      title: "Join strategies",
      type: "table",
      headers: ["Strategy", "When to use", "Cost", "Memory per task", "Requires", "Output layout"],
      rows: [
        ["Reduce-side sort-merge", "General case: both sides large, layout unknown", "Full shuffle (partition + sort) of both inputs", "One key's small-side records (secondary sort puts them first); the rest streamed", "Only a common join key", "Partitioned and sorted by the join key"],
        ["Broadcast hash (Hive: MapJoin; Pig: replicated; Spark: broadcast hash join)", "One side fits in each task's memory (star schema: fact &times; dimension)", "Ship the small side to every task; scan the large side once; no shuffle of the large side", "The whole small side as a hash table", "A small input (Spark auto-broadcasts below 10 MB by default)", "Like the large input"],
        ["Partitioned hash (Hive: bucketed map join)", "Both sides already bucketed on the join key by earlier jobs", "Each task hashes one bucket of the smaller side and scans the matching bucket of the larger", "One bucket of the smaller side", "Same partition count, same key, same hash function", "Like the large input"],
        ["Map-side merge (Hive: SMB join)", "Both sides bucketed and sorted on the key, reused by many jobs", "Stream and merge matching buckets; no hash table, no shuffle", "Constant (two streaming cursors)", "Partitioned the same way AND sorted by the key", "Like the large input"],
      ],
      note: "Speedups depend on the size ratio and the cluster: there's no fixed multiplier. SQL engines pick the strategy from statistics and table metadata; check the plan with EXPLAIN.",
    },
    {
      title: "Which aggregates can use a combiner?",
      type: "table",
      headers: ["Aggregate", "Combinable?", "How"],
      rows: [
        ["SUM, COUNT, MIN, MAX", "Yes", "The reducer can usually double as the combiner"],
        ["AVG", "Only as a pair", "Combine (sum, count) and divide in the reducer; never average averages (avg(avg(1, 2), 3) = 2.25, not 2)"],
        ["Exact median, percentiles", "No useful combiner", "Holistic: needs every value. Use mergeable sketches (t-digest) for approximate answers"],
        ["COUNT DISTINCT", "Partially", "A mapper can dedupe its own (key, value) pairs; an exact answer still needs the full set per key. HyperLogLog sketches merge associatively"],
        ["Top-k", "Not on partial counts", "Count fully first (each key in one reducer), then keep a top-k per reducer, then merge the R &times; k candidates"],
      ],
      note: "A combiner may run zero, one or many times and must output the same type the reducer consumes. It may change the cost, never the result.",
    },
    {
      title: "Stragglers: cause &rarr; fix",
      type: "table",
      headers: ["Cause", "How to tell", "Fix"],
      rows: [
        ["Slow machine (failing disk, noisy neighbor, GC)", "The task's input size is normal but it runs long; slow tasks cluster on one host", "Speculative execution (default on in Hadoop MapReduce, off in Spark); exclude the node"],
        ["Hot key (celebrity, bot, 'unknown' country)", "One task's input records or bytes far above the median", "Salting / skewed join (split the hot key, replicate the other side's matching rows), two-stage aggregation, Spark 3 AQE skew join, Hive skewed tables, Pig skewed join"],
        ["NULL or default keys", "A giant partition whose key is NULL, 0 or empty", "Filter them out or process them separately (common in outer joins)"],
        ["Too few partitions", "Every task is large, not just one", "Raise the reducer / shuffle partition count (does NOT fix a single hot key)"],
        ["Many-to-many join explosion", "A task's output rows far exceed its input rows", "Check join keys; deduplicate the dimension side first"],
      ],
      note: "Speculative execution never fixes skew: the backup copy gets the same oversized partition.",
    },
    {
      title: "Rules for batch outputs",
      type: "list",
      items: [
        "<strong>Never mutate inputs</strong>: the job's only effect is its output.",
        "<strong>Write to a new location</strong>: per-attempt temporary directories, then a new version directory or partition.",
        "<strong>Publish atomically</strong>: a rename on HDFS, a version-pointer swap, a table-format commit (Iceberg, Delta, Hudi), a <code>_SUCCESS</code> marker. On S3, use S3A or EMR committers or a table format, never a plain rename.",
        "<strong>Keep the previous version</strong> so rolling back is a switch, not a rebuild.",
        "<strong>Deterministic, idempotent tasks</strong> that overwrite whole partitions; never append.",
        "<strong>Validate before publishing</strong>: row counts, coverage, score distributions compared with yesterday's output.",
        "<strong>Never write to production databases from inside tasks</strong>: bulk-load built files (Voldemort read-only stores, HBase bulk load) instead.",
        "<strong>External side effects</strong> (emails, payments) go in a separate idempotent step after the output is committed.",
        "<strong>Self-describing, evolvable formats</strong> (Avro, Parquet) so consumers survive schema changes.",
      ],
    },
    {
      title: "Hadoop vs MPP databases",
      type: "table",
      headers: ["", "Hadoop (HDFS + MapReduce and friends)", "MPP database"],
      rows: [
        ["Data", "Any bytes, any format; schema-on-read", "Modeled and imported up front into the database's own format"],
        ["Processing", "Arbitrary code, plus SQL engines (Hive, Impala, Spark SQL) over the same files", "SQL; UDFs awkward"],
        ["Coupling", "Many engines share one storage layer", "Storage, planner and executor integrated and tuned together"],
        ["Failure handling", "Retry the failed task", "Abort and rerun the whole query"],
        ["Memory", "Writes eagerly to disk; assumes data won't fit in memory", "In memory where possible (e.g. hash joins)"],
        ["Sweet spot", "Huge, long, heterogeneous jobs on shared, preemptible clusters", "Interactive analytic SQL on modeled data"],
        ["Examples", "Hadoop MapReduce, Hive, Pig, Spark on HDFS or S3", "Teradata, Vertica, Greenplum, Redshift"],
      ],
      note: "They converged: Impala, Trino and Spark SQL adopted columnar, vectorized, pipelined MPP techniques, while warehouses became more programmable.",
    },
    {
      title: "Preemption math",
      type: "note",
      body: `<p><span class="formula">P(at least one of n tasks killed) = 1 &minus; (1 &minus; p)<sup>n</sup></span></p>
<p>The book's figure for Google: a MapReduce task running for an hour had about a 5% chance of being preempted. For a 10-minute task, p = 1 &minus; 0.95<sup>1/6</sup> &asymp; 0.85%. Then n = 10 gives 8%, n = 100 gives 57%, and n = 500 gives 99%. A job that restarted from scratch on any failure would rarely finish, so recovery must work per task. This is the same formula as tail-latency amplification under fan-out (ch1). The 5% figure is specific to Google's shared clusters, not a universal rate.</p>`,
    },
    {
      title: "MapReduce vs dataflow engines",
      type: "table",
      headers: ["", "MapReduce (chained jobs)", "Dataflow engines (Spark, Tez, Flink)"],
      rows: [
        ["Model", "map &rarr; sort &rarr; reduce, chained as separate jobs", "An arbitrary DAG of operators in one job"],
        ["Intermediate state", "Between jobs: written to HDFS &times;3; within a job: map output on local disk", "Memory or local disk; shuffle files on local disk; nothing replicated until the final output"],
        ["Sorting", "Always between map and reduce", "Only where an operator needs it (sort-merge join, ORDER BY)"],
        ["Redundant work", "The next job's mappers often just reread the previous reducer's output", "Fused into the previous operator"],
        ["Task start-up", "A new JVM (container) per task", "Long-lived executors run many tasks"],
        ["Stage start", "Reduce after ALL maps finish; the next job after the whole previous job", "Narrow operators pipelined within a stage; Spark waits for the whole parent stage at a shuffle, Flink can pipeline across exchanges; a sort always waits for all its input"],
        ["Recovery", "Rerun the task from durable input (plus completed maps on a dead node)", "Recompute lost partitions from lineage (needs deterministic operators; checkpoint long lineages); Flink restarts the failed pipelined region (blocking shuffles in batch mode keep that to the affected stages) and restores checkpoints in streaming mode"],
        ["Iterative jobs", "One job per iteration, rereading and rewriting everything", "Cache the working set across iterations (opt-in)"],
        ["API", "Low-level map and reduce callbacks", "SQL, DataFrames, RDDs; an optimizer picks the joins"],
      ],
      note: "Measured gains depend on the workload: up to 20&times; for iterative applications (RDD paper, 2012); 100 TB sorted in 23 min on 206 machines vs Hadoop's 72 min on 2,100 (2014). Single-pass ETL gains far less.",
    },
    {
      title: "Spark vocabulary &harr; the book",
      type: "table",
      headers: ["Spark term", "Book's term / idea", "Notes"],
      rows: [
        ["Narrow dependency", "Operators fused in one task (no exchange)", "map, filter, flatMap, union, a join of co-partitioned inputs"],
        ["Wide dependency / shuffle", "Repartition (+ sort) edge", "groupByKey, reduceByKey, distinct, repartition, a non-co-partitioned join; writes shuffle files to local disk"],
        ["Stage", "A run of narrow operators between shuffles", "A child stage starts when its parent stage has finished"],
        ["Broadcast variable / broadcast hash join", "Broadcast edge / broadcast hash join", "Automatic below 10 MB (spark.sql.autoBroadcastJoinThreshold) or via a hint"],
        ["Lineage (RDD dependencies)", "Recompute lost partitions from their parents", "Requires deterministic operators"],
        ["checkpoint()", "Materialize to reliable storage", "Cuts long lineages in iterative jobs"],
        ["cache() / persist()", "Keep intermediate state in memory", "Opt-in; evicted data spills or is recomputed"],
        ["FetchFailed", "Lost map output", "The parent stage's missing tasks are rerun"],
        ["AQE skew join", "Skewed join / salting", "Splits oversized shuffle partitions at runtime (Spark 3.0+, on by default since 3.2)"],
        ["repartitionAndSortWithinPartitions", "Secondary sort", "SQL engines do it inside sort-merge joins"],
      ],
    },
    {
      title: "Pregel in one breath",
      type: "list",
      items: [
        "Vertex state lives in memory across supersteps; only vertices with incoming messages do work.",
        "Superstep n: each active vertex reads the messages sent in superstep n &minus; 1, updates its state, sends messages along its edges, and may vote to halt.",
        "A barrier separates supersteps: every message sent in superstep n is delivered in n + 1 and processed exactly once, despite an unreliable network.",
        "Voting to halt is local, and any incoming message wakes the vertex. The job ends when all vertices have halted and no messages are in flight; a global convergence test (max change &lt; &epsilon;) needs an aggregator or a fixed number of supersteps.",
        "Combiners pre-sum messages bound for the same vertex (valid for PageRank, because contributions add up).",
        "Fault tolerance: checkpoint vertex state every k supersteps and roll the whole graph back on failure (or recover only the lost partition if the algorithm is deterministic and messages are logged).",
        "Placement by hash(vertex id) sends most messages across machines; total message volume can exceed the size of the graph.",
        "If the graph fits on one machine, a single-machine algorithm often wins (the COST paper, Twitter's Who-to-Follow).",
        "PageRank: <span class=\"mono\">PR(v) = (1 &minus; d)/N + d &middot; &Sigma; PR(u)/outdeg(u)</span> over v's in-neighbors u, with d &asymp; 0.85.",
      ],
    },
    {
      title: "Top-k at scale",
      type: "list",
      items: [
        "Count with a combiner (or <code>reduceByKey</code>), so the shuffle carries partial counts, not one record per log line.",
        "Each reducer owns the complete counts for its keys, keeps a size-k min-heap, and emits its local top k.",
        "One final task merges the R &times; k candidates; the global top k must be among them.",
        "Never take a top-k of partial per-mapper counts: a key's count is split across mappers.",
        "No global sort of all the counts is needed.",
        "If the distinct keys fit in RAM, one machine with a hash map and a heap does it in one pass; otherwise <code>sort | uniq -c | sort -rn | head</code>.",
        "On an unbounded stream, or for an approximate answer: a Count-Min sketch plus a heap, or the Space-Saving algorithm.",
      ],
    },
    {
      title: "Choosing an approach",
      type: "list",
      items: [
        "<strong>Fits on one machine</strong> (or the distinct keys fit in RAM): a single process (DuckDB, Polars, <code>sort | uniq</code>) is usually faster and simpler than a cluster.",
        "<strong>Expressible in SQL</strong>: Spark SQL, Trino, BigQuery or another warehouse; let the optimizer choose the joins, and read the plan.",
        "<strong>Needs arbitrary code</strong> (parsing, ML features, images): DataFrame APIs with built-in functions first, vectorized (Arrow/pandas) UDFs next, row-at-a-time UDFs last.",
        "<strong>Iterating over a graph</strong>: fits in memory on one box &rarr; single machine; otherwise Pregel-style (GraphX, Giraph) with checkpoints.",
        "<strong>Results needed in seconds, not hours</strong>: stream processing (ch11); keep batch for backfills and reprocessing.",
        "<strong>Serving the output</strong>: build files, bulk-load them, swap; never write from tasks into the live database.",
      ],
    },
    {
      title: "Numbers worth knowing",
      type: "list",
      items: [
        "HDFS: 128 MB blocks (64 MB in Hadoop 1 and GFS); replication 3 (one replica on the writer's node, two on one remote rack); RS(6,3) erasure coding = 1.5&times; storage and tolerates 3 losses (Hadoop 3.0, 2017).",
        "NameNode heap: roughly 150 bytes per file, directory or block (rule of thumb), which is why small files hurt.",
        "Hadoop MapReduce: 100 MB map sort buffer, spilling at 80%; 1 reducer by default; reducer slowstart once 5% of maps are complete.",
        "Speculative execution: on by default in Hadoop MapReduce; off by default in Spark (<code>spark.speculation = false</code>).",
        "Spark SQL: 200 shuffle partitions by default; 10 MB auto-broadcast threshold; AQE since 3.0, on by default since 3.2.",
        "MapReduce paper (2004): the sort benchmark took 44% longer without backup tasks.",
        "RDD paper (2012): up to 20&times; faster than Hadoop for iterative applications.",
        "Sort benchmark (2014): Spark sorted 100 TB in 23 min on 206 machines; Hadoop's previous record was 72 min on 2,100.",
        "Preemption (the book's figure for Google): about 5% per hour for a MapReduce task; 100 ten-minute tasks &rarr; about 57% chance at least one is killed.",
        "Scan time: 2 TB at 200 MB/s &asymp; 2.8 hours on one machine.",
        "Pregel paper's PageRank example: 30 supersteps.",
      ],
    },
    {
      title: "Modern landscape (since the book)",
      type: "list",
      items: [
        "<strong>Storage</strong>: object stores (S3, GCS, Azure Blob) instead of HDFS. S3 has been strongly read-after-write consistent since December 2020, but a rename is still copy + delete: not atomic and proportional to data size.",
        "<strong>Tables</strong>: Iceberg, Delta Lake and Hudi add atomic commits, snapshots (time travel) and schema evolution on top of Parquet files.",
        "<strong>Engines</strong>: Spark, Flink, Trino and cloud warehouses (BigQuery, Snowflake, Redshift). MapReduce is legacy: Hive's MR engine is deprecated, and Hive-on-Spark was removed in Hive 4, leaving Tez.",
        "<strong>Orchestration</strong>: Airflow, Dagster, Prefect; dbt for dependency graphs of SQL models.",
        "<strong>Adaptive execution</strong>: Spark 3 AQE switches join strategies at runtime, coalesces small partitions and splits skewed ones.",
        "<strong>Vectorized engines</strong>: Photon, Velox, DuckDB: columnar batches and SIMD loops.",
        "<strong>Clusters</strong>: Kubernetes plus spot/preemptible instances are the new low-priority, preemptible capacity, so task-level retry still matters.",
        "<strong>Unified APIs</strong>: Apache Beam and Flink run the same program in batch or streaming mode (ch11).",
      ],
    },
  ],

  interview: [
    // ---- why-batch ----
    {
      id: "q05",
      q: "When would you pick batch over streaming?",
      diff: "medium",
      section: "why-batch",
      a: `<p>Start from the defining difference. A batch job reads a <strong>bounded</strong> input, so it knows when it has seen everything and is done. A stream processor reads an <strong>unbounded</strong> input that never ends, so it has to decide when to emit results without having seen all the data.</p>
<p><strong>Batch fits when:</strong></p>
<ul><li>Freshness of minutes to hours is acceptable: nightly recommendations, daily finance reports, search index rebuilds.</li><li>The answer needs the complete input: a day's totals, a full join of two snapshots, training a model on all of history.</li><li>You want <strong>deterministic, rerunnable</strong> results. After a bug fix, you rerun on the same immutable input and get a corrected output (a backfill). That is much harder to get right with streaming.</li><li>Throughput and cost matter more than latency: big sequential scans, cheap preemptible capacity, jobs that can wait in a queue.</li></ul>
<p><strong>Streaming fits when:</strong></p>
<ul><li>The value of a result decays within seconds: fraud detection, alerting, live dashboards, keeping a cache or search index in sync as data changes.</li><li>Data arrives continuously, and batching it would force a choice between big batches (stale) and tiny ones (high overhead).</li></ul>
<p><strong>In practice</strong> most companies run both: streams for fresh, approximate or incremental results, and batch for reprocessing history, backfills, and anything that must be exactly right. Ch11 and ch12 discuss architectures that combine the two (lambda) or try to do everything in one stream engine (kappa). Even streaming-first teams reprocess a retained log after a code change, which is a batch-style job.</p>`,
      followups: [
        "What does a bounded input give a batch job that a stream processor lacks?",
        "How would you get the freshness of streaming and the correctness of batch?",
        "How would you reprocess six months of history in a streaming-first system?",
      ],
      pitfalls: [
        "Streaming always supersedes batch",
        "Treating batch as legacy, or slow by accident rather than by design",
        "Ignoring reprocessing and backfills when choosing",
      ],
    },

    // ---- unix-pipelines ----
    {
      id: "q-hash-vs-sort",
      q: "You need to count requests per URL in a 500 GB log on one machine with 16 GB of RAM. Would you use a hash map or sort | uniq -c, and why?",
      diff: "easy",
      section: "unix-pipelines",
      a: `<p><strong>It depends on the number of distinct keys, not the number of lines.</strong></p>
<ul><li><strong>Hash map</strong> (one pass, one counter per URL): memory grows with the number of <em>distinct</em> URLs. Two billion lines over 50,000 URLs need a few megabytes, and the hash map is the fastest option: one sequential read and no temporary files. But 500 million distinct URLs (long query strings, session ids in paths), at tens of bytes each plus per-entry overhead, can need tens of gigabytes and run out of memory.</li><li><strong>Sort-based</strong> (<code>sort | uniq -c</code>): GNU sort is an <strong>external merge sort</strong>. It sorts buffer-sized chunks, writes them as sorted runs to temporary files, then merges the runs with sequential I/O. Memory stays bounded whatever the number of keys, at the cost of extra disk passes. Once sorted, identical URLs are adjacent, so <code>uniq -c</code> counts them in constant memory. (That is also why <code>uniq</code> must come after <code>sort</code>: it only collapses adjacent duplicates.)</li></ul>
<p><strong>How I'd decide</strong>: estimate the distinct keys first, from a sample or a HyperLogLog-style estimate. If they fit comfortably, use the hash map; otherwise sort. You can also combine the two: hash-aggregate each chunk until memory fills, spill the partial counts sorted by key, then merge. That is exactly what MapReduce's combiner plus sort-spill-merge does. Either way, the bottleneck is often just reading 500 GB from disk.</p>
<p><strong>Why it matters beyond one machine</strong>: this is the design choice behind MapReduce. Sorting is the framework's grouping primitive because it scales past memory; hash aggregation is the optimization you use when the data allows it.</p>`,
      followups: [
        "What exactly does sort do when the input is 30 times larger than RAM?",
        "Why must uniq -c come after sort?",
        "At what point does this stop being a single-machine job?",
      ],
      pitfalls: [
        "Assuming memory grows with the number of lines",
        "Forgetting that uniq only collapses adjacent duplicates",
        "Reaching for a cluster for data one machine can stream",
      ],
    },

    // ---- mapreduce-and-hdfs ----
    {
      id: "q01",
      q: "Explain MapReduce at a high level.",
      diff: "easy",
      section: "mapreduce-and-hdfs",
      a: `<p>MapReduce is a programming model plus a framework for batch jobs over files in a distributed filesystem. You write two functions and the framework does everything else.</p>
<ul><li><strong>Map</strong>: called once per input record; emits zero or more (key, value) pairs; keeps no state between records.</li><li><strong>Reduce</strong>: called once per <em>key</em> with an iterator over all the values for that key; emits output records.</li></ul>
<p><strong>How a job runs</strong></p>
<ul><li><strong>Map tasks</strong>: one per input split (roughly one per HDFS block), scheduled where possible on a machine that holds a replica of that block (data locality).</li><li><strong>Partition and sort</strong>: each mapper partitions its output by <code>hash(key) mod R</code>, sorts each partition by key, optionally runs a <strong>combiner</strong> to pre-aggregate, and spills sorted files to its <strong>local disk</strong>, not HDFS.</li><li><strong>Shuffle</strong>: each of the <em>R</em> reduce tasks (R is chosen by the job author) fetches its partition from every mapper and merge-sorts the runs. Reducers start fetching as soon as individual map tasks finish, but <code>reduce()</code> runs only after <em>all</em> maps have finished, because any mapper could still emit any key.</li><li><strong>Reduce</strong>: a reduce task walks its keys in sorted order and calls <code>reduce()</code> once per key, so one task handles many keys. Output goes to HDFS as <code>part-r-0000N</code> files.</li></ul>
<p><strong>Fault tolerance</strong>: inputs are immutable and a failed attempt's output is discarded, so a failed task is simply rerun somewhere else. One subtlety: if a machine dies, even its <em>completed</em> map tasks are rerun, because their output lived on its local disk. Completed reduce tasks are not rerun, because their output is in HDFS.</p>
<p><strong>Example</strong>: word count. Map emits (word, 1) per token, a combiner pre-sums per mapper, and reduce sums per word. Getting the top 10 words from the result needs a second step (see the top-k question).</p>`,
      followups: [
        "What does a combiner do, and when can't you use one?",
        "Where does map output live, and why?",
        "Why can't any reduce() call start before the last map task finishes?",
        "How would you find the 10 most requested URLs with it?",
      ],
      pitfalls: [
        "Saying the shuffle is random",
        "One reducer process per key",
        "Saying mappers write their output to HDFS",
        "Forgetting that completed map tasks are rerun when their machine dies",
      ],
    },
    {
      id: "q04",
      q: "How does HDFS achieve fault tolerance and throughput?",
      diff: "medium",
      section: "mapreduce-and-hdfs",
      a: `<p><strong>Architecture</strong>: shared-nothing. Every machine runs a <strong>DataNode</strong> that serves its local disks, and a <strong>NameNode</strong> holds the namespace and the block map (which blocks make up each file and where they live) in memory. Clients ask the NameNode where the blocks are, then read and write directly to the DataNodes. The design follows the Google File System paper (2003).</p>
<p><strong>Fault tolerance</strong></p>
<ul><li>Files are split into large blocks (128 MB by default since Hadoop 2), and each block is replicated, 3 copies by default, with <strong>rack-aware</strong> placement: one copy on the writer's node, two on different nodes of one remote rack. A block therefore survives the loss of a whole rack.</li><li>DataNodes send heartbeats and block reports. When one dies, the NameNode re-replicates its blocks from the surviving copies. Readers simply use another replica, and checksums catch corrupted blocks.</li><li>Hadoop 3 added <strong>erasure coding</strong>: Reed-Solomon RS(6,3) stores 9 blocks for every 6 blocks of data, a 50% storage overhead instead of replication's 200%, while still tolerating any 3 losses. It costs more CPU and network when data must be reconstructed, so it is typically used for colder data.</li><li>The NameNode <em>was</em> a single point of failure in Hadoop 1. Hadoop 2 added active/standby NameNode high availability with automatic failover coordinated through ZooKeeper (ch9).</li></ul>
<p><strong>Throughput</strong></p>
<ul><li>Big blocks mean long sequential reads and little metadata per byte.</li><li>Aggregate bandwidth grows with the number of disks, and a job reads thousands of blocks in parallel.</li><li><strong>Data locality</strong>: the scheduler runs map tasks on or near nodes that hold a replica, shipping megabytes of code instead of gigabytes of data.</li></ul>
<p><strong>Limits</strong>: files are write-once (appends only, no random in-place updates). Every file, directory and block costs NameNode heap (about 150 bytes each), so millions of small files are a well-known problem; the usual cures are batching writes upstream and periodic compaction jobs that merge small files into large ones (table formats such as Iceberg and Delta ship compaction for exactly this). In the cloud, object stores (S3, GCS) have mostly replaced HDFS because storage scales independently of compute. They are not filesystems, though: there is no atomic directory rename, which is why output committers and table formats exist.</p>`,
      followups: [
        "Why are blocks so large?",
        "What happens when a DataNode dies?",
        "Why do small files hurt HDFS?",
        "What do you lose when moving from HDFS to S3?",
      ],
      pitfalls: [
        "HDFS supports random in-place updates",
        "Calling the NameNode a single point of failure without mentioning HA since Hadoop 2",
        "Placing two replicas in the writer's rack and one remote",
      ],
    },
    {
      id: "q-combiner-when",
      q: "What is a combiner? Can you use one to compute an average, a median, or the number of distinct users per page?",
      diff: "easy",
      section: "mapreduce-and-hdfs",
      a: `<p>A <strong>combiner</strong> is a map-side partial reduce, applied to a mapper's sorted output before the shuffle to cut network traffic. The framework may run it zero, one or several times, so applying it any number of times must not change the final answer. That means the operation must be <strong>associative and commutative</strong>, and the combiner's output type must match the map output type the reducer expects.</p>
<ul><li><strong>Sum, count, min, max</strong>: yes. The reducer can often double as the combiner.</li><li><strong>Average</strong>: not by averaging averages: avg(avg(1, 2), 3) = 2.25, but the true average is 2. Instead, carry (sum, count) pairs, combine them by adding, and divide in the reducer.</li><li><strong>Exact median</strong>: no useful combiner. It is a holistic aggregate that needs all the values. For an approximate answer, use quantile sketches that merge (for example t-digest).</li><li><strong>Distinct users per page</strong>: a combiner can deduplicate (page, user) pairs within one mapper, which helps, but the reducer still needs the full set of users per page for an exact count. At scale, use HyperLogLog sketches: they merge associatively, so they work as combiners, at the cost of a small error.</li></ul>
<p><strong>In Spark</strong>, <code>reduceByKey</code> and <code>aggregateByKey</code> combine on the map side automatically, but <code>groupByKey</code> does not. That is why <code>groupByKey</code> followed by a sum shuffles far more data than <code>reduceByKey</code>.</p>`,
      followups: [
        "Why can't the reducer always be reused as the combiner?",
        "How does HyperLogLog make distinct counts mergeable?",
        "Why is reduceByKey usually cheaper than groupByKey in Spark?",
      ],
      pitfalls: [
        "Averaging averages",
        "Assuming the combiner runs exactly once",
        "Thinking a combiner can change the result rather than only the cost",
      ],
    },
    {
      id: "q-top-k-urls",
      q: "Find the 10 most requested URLs in 10 TB of web server logs. Walk through the job and where its cost goes.",
      diff: "medium",
      section: "mapreduce-and-hdfs",
      a: `<p>Two phases: count every URL exactly, then select the top 10 without sorting everything.</p>
<p><strong>Phase 1: count</strong></p>
<ul><li>Map: parse each log line and emit (url, 1). The 10 TB input becomes about 80,000 map tasks of 128 MB each, which read their blocks locally where possible.</li><li>Combiner (or Spark's map-side partial aggregation in <code>reduceByKey</code> or <code>groupBy().count()</code>): pre-sum within each map task, so the shuffle carries at most one record per distinct URL per map task instead of one per log line. This is where most of the cost is saved.</li><li>Shuffle: partition by <code>hash(url) mod R</code>. Every URL's count therefore ends up complete in exactly one partition.</li><li>Reduce: sum the partial counts per URL.</li></ul>
<p><strong>Phase 2: top-k</strong></p>
<ul><li>Each reducer keeps a size-10 min-heap over its own URLs and emits only its local top 10.</li><li>One final task merges the R &times; 10 candidates. This is correct because each URL's full count lives in one partition, so the global top 10 must appear among the per-partition top-10 lists.</li><li>No global sort of the whole count table is needed.</li></ul>
<p><strong>Where the cost goes</strong>: reading 10 TB (I/O-bound, so scale out), parsing, and the shuffle (much smaller with the combiner). Hot URLs such as <code>/</code> or <code>/health</code> are skewed keys, but the combiner largely neutralizes skew for counting, because each mapper sends one pre-summed record per hot URL.</p>
<p><strong>Alternatives</strong></p>
<ul><li>One machine: if the distinct URLs fit in RAM, a hash map plus a heap in one pass; otherwise <code>sort | uniq -c | sort -rn | head</code>, which uses an external sort.</li><li>Approximate or streaming: a Count-Min sketch plus a heap, or the Space-Saving heavy-hitters algorithm.</li></ul>`,
      followups: [
        "Why is the union of the per-partition top-10 lists guaranteed to contain the global top 10?",
        "What changes if you need the top 10 per country?",
        "How would you do it on one machine with 1 GB of RAM?",
        "How would you approximate it on an unbounded stream?",
      ],
      pitfalls: [
        "Taking a top 10 per mapper on partial counts (a URL's count is split across mappers, so a local top-k before the reduce is wrong)",
        "Sending all counts to a single reducer to sort",
        "Forgetting the combiner",
        "Not asking whether the distinct keys fit in memory",
      ],
    },

    {
      id: "q-global-sort",
      q: "How do you produce one globally sorted output from a MapReduce or Spark job over 10 TB?",
      diff: "medium",
      section: "mapreduce-and-hdfs",
      a: `<p><strong>Hash partitioning isn't enough.</strong> With <code>hash(key) mod R</code>, each reducer's output is sorted, but every reducer holds keys from the whole key space, so the part files concatenated are not in order. A global sort needs <strong>range partitioning</strong> (ch6): reducer <em>i</em> receives every key between split point <em>i</em> &minus; 1 and split point <em>i</em>.</p>
<ul><li><strong>Choose split points by sampling</strong>: read a small random sample of keys, sort it, and take R &minus; 1 evenly spaced quantiles as the boundaries. Hadoop's InputSampler and <code>TotalOrderPartitioner</code> do this, as does the TeraSort benchmark; Spark's <code>sortBy</code> and SQL <code>ORDER BY</code> use a range partitioner that samples first.</li><li><strong>Map</strong>: each record goes to the reducer whose range contains its key, and the shuffle sorts each partition as usual.</li><li><strong>Reduce</strong>: each reducer writes its sorted range. Read in order, part-00000, part-00001, &hellip; form one sorted output, with no final merge on a single machine.</li></ul>
<p><strong>Where it goes wrong</strong></p>
<ul><li>A poor sample, or a skewed key distribution, gives some reducers far bigger ranges than others. Sample more, and if one key value is very common, add a tiebreaker (such as a record id) to the sort key so equal keys can spread over adjacent reducers.</li><li>Sampling costs an extra pass over part of the input.</li><li>Many questions that sound like sorting don't need a total order: a top-k only needs per-partition heaps and a small merge.</li></ul>`,
      followups: [
        "Why not send everything to one reducer for the final sort?",
        "What happens if 30% of the records share one key?",
        "How does this relate to key-range partitioning in a database?",
      ],
      pitfalls: [
        "Concatenating hash-partitioned part files and calling the result sorted",
        "Funnelling all the data through a single reducer",
        "Choosing split points without sampling, for example evenly spaced over the key type's range",
      ],
    },

    // ---- reduce-side-joins ----
    {
      id: "q-sessionization",
      q: "One user's click events are scattered across the logs of 500 web servers. Compute yesterday's user sessions, where a new session starts after 30 minutes of inactivity.",
      diff: "medium",
      section: "reduce-side-joins",
      a: `<p>This is a GROUP BY user_id that also needs the events in order.</p>
<p><strong>MapReduce version</strong></p>
<ul><li>Map: emit each event with key user_id and value (timestamp, url, ...).</li><li>Partition by user_id, so all of one user's events, from all 500 servers, meet in one reduce call.</li><li><strong>Secondary sort</strong>: use a composite key (user_id, timestamp), partitioned and grouped by user_id only. Events then arrive in time order and the reducer needs constant memory.</li><li>Reduce: walk the events, start a new session whenever the gap since the previous event exceeds 30 minutes, and emit (user_id, session_id, start, end, pages, ...).</li></ul>
<p><strong>Spark / SQL version</strong>: repartition by user_id plus <code>sortWithinPartitions</code>, or window functions: compute <code>LAG(ts) OVER (PARTITION BY user_id ORDER BY ts)</code>, flag events where the gap exceeds 30 minutes, and take a running SUM of the flags as the session number.</p>
<p><strong>Edge cases</strong></p>
<ul><li>Sessions that cross midnight: read a small overlap from the previous day, or carry open sessions forward to the next run.</li><li>Late events that arrive after the day's run: rerun the partition, or accept a cut-off.</li><li>Bots with millions of events are hot keys: cap or filter them before the reduce.</li><li>Clock skew between web servers (ch8) can misorder events by a few milliseconds or more; prefer a single clock source where you can.</li></ul>
<p><strong>Why batch fits</strong>: the input is a bounded, immutable day of logs, so a rerun after a bug fix reproduces exactly the same sessions. Streaming sessionization (ch11) needs session windows and watermarks instead.</p>`,
      followups: [
        "How do you handle a session that runs from 23:50 to 00:20?",
        "What breaks if one bot generates 50 million events?",
        "How would you write it in SQL?",
      ],
      pitfalls: [
        "Collecting each user's events into an in-memory list",
        "Forgetting to order events by time within a user",
        "Ignoring sessions that span the day boundary",
      ],
    },
    {
      id: "q-straggler-diagnosis",
      q: "One reducer in your batch job runs for 3 hours while the other 199 finish in 5 minutes. Diagnose and fix it.",
      diff: "medium",
      section: "reduce-side-joins",
      a: `<p><strong>First, tell a slow machine apart from skewed data.</strong> Open the task metrics (the Spark UI or the Hadoop counters) and compare that task's input records and bytes with the median.</p>
<ul><li><strong>Input is normal, but the task is slow</strong>: it's the machine: a bad disk, GC pressure, a noisy neighbor. Check whether slow tasks cluster on one host. Fix: speculative execution (on by default in Hadoop MapReduce, off in Spark), or exclude the node.</li><li><strong>Input is huge</strong>: it's a <strong>hot key</strong>: a celebrity, a bot user, a NULL or default key ('unknown' country, user_id 0), or an empty string. Find it by sampling the key distribution, or by running a quick count per key on the largest partition.</li></ul>
<p><strong>Fixes for a hot key</strong></p>
<ul><li><strong>NULL or default keys</strong>: filter them out or process them separately. They are a very common culprit, especially in outer joins.</li><li><strong>Salting / skewed join</strong>: on the big side, append a random suffix 0..k&minus;1 to the hot key; on the other side, replicate the matching record k times, once per suffix, so every salted key still finds its match. Pig's skewed join does this automatically after a sampling pass; Hive has skewed tables.</li><li><strong>Two-stage aggregation</strong> for GROUP BY: aggregate per salted key first, then strip the salt and combine the partial aggregates. A combiner or <code>reduceByKey</code> already does much of this for sums and counts.</li><li><strong>Spark 3 AQE</strong> (on by default since 3.2) detects skewed shuffle partitions at runtime and splits them, replicating the other side's matching partition.</li></ul>
<p><strong>What doesn't work</strong>: adding more reducers, because one key still hashes to one reducer; and speculative execution, because the backup copy gets the same oversized input. Also check upstream: a many-to-many join that explodes the row count can look like skew.</p>`,
      followups: [
        "Why doesn't speculative execution help here?",
        "How does two-stage aggregation work for COUNT DISTINCT?",
        "How would you find the hot keys cheaply before running the join?",
      ],
      pitfalls: [
        "'Add more reducers' as the whole answer",
        "Not checking per-task input size before deciding",
        "Forgetting NULL join keys",
        "Salting without replicating the other side of the join (losing matches)",
      ],
    },

    // ---- map-side-joins ----
    {
      id: "q02",
      q: "Compare reduce-side and map-side joins.",
      diff: "hard",
      section: "map-side-joins",
      a: `<p>Both produce the same result. They differ in what they assume about the inputs, and therefore in how much data they have to move.</p>
<p><strong>Reduce-side (sort-merge) join</strong>: mappers tag each record with its source and emit it keyed by the join key. The shuffle partitions by that key and sorts, so all records for a key meet in one reduce call. A <strong>secondary sort</strong> makes the small side's record (say, the user profile) arrive first, so the reducer holds one record and streams the rest past it. It assumes nothing about the inputs, but shuffles <em>both</em> sides in full, and its main risk is <strong>skew</strong>: a hot key overloads one reducer.</p>
<p><strong>Map-side joins</strong> skip the shuffle by exploiting what you know about the inputs. There are no reducers:</p>
<ul><li><strong>Broadcast hash join</strong>: one side fits in memory. Every task loads all of it into a hash table and streams its block of the large side. (Hive MapJoin, Pig replicated join, Spark broadcast hash join; Spark broadcasts automatically below 10 MB by default.)</li><li><strong>Partitioned hash join</strong> (Hive's bucketed map join): both sides are partitioned with <em>the same number of partitions, the same key and the same hash function</em>. Task i builds a hash table from bucket i of the smaller side and scans bucket i of the larger.</li><li><strong>Map-side merge join</strong> (Hive's SMB join): both sides are partitioned the same way <em>and</em> sorted by the key. Task i merges two sorted streams in constant memory.</li></ul>
<p><strong>Output layout differs</strong>: reduce-side output is partitioned and sorted by the join key; map-side output is laid out like the large input. A downstream job may depend on that.</p>
<p><strong>How to choose</strong>: use a map-side join when metadata (sizes, bucketing) guarantees its preconditions, and a reduce-side join otherwise. The gain depends on the size ratio and the cluster, so there's no fixed speedup. SQL engines make this choice for you from statistics and table metadata.</p>`,
      followups: [
        "What happens when the broadcast side doesn't fit in memory?",
        "How does an optimizer choose between them?",
        "Why does a map-side join's output layout matter to the next job?",
      ],
      pitfalls: [
        "Broadcasting a large table",
        "Ignoring bucket count or hash-function compatibility",
        "Claiming map-side joins are always some fixed factor faster",
      ],
    },
    {
      id: "q-choose-join",
      q: "You must join a 5 TB clickstream with a 3 GB product table and a 400 GB user table. How will the engine execute it, and how could you make it faster?",
      diff: "medium",
      section: "map-side-joins",
      a: `<p><strong>What Spark SQL will likely do by default</strong></p>
<ul><li><strong>Products (3 GB)</strong>: far above the 10 MB auto-broadcast threshold, so the planner chooses a shuffle sort-merge join unless told otherwise. Broadcasting is attractive but must be checked: 3 GB of compressed columnar data can become several times larger as an in-memory hash table, every executor needs a copy, the driver collects it first, and Spark refuses to broadcast tables above 8 GB.</li><li><strong>Users (400 GB)</strong>: too large to broadcast, so a sort-merge join that shuffles 5 TB plus 400 GB.</li></ul>
<p><strong>Making it faster</strong></p>
<ul><li><strong>Shrink the inputs first</strong>: select only the needed columns (Parquet column pruning) and filter early (a date range, dropping bot traffic). The product table projected to (product_id, category, price) may shrink to a few hundred MB, small enough to broadcast with a hint, or AQE may convert the join at runtime once it sees the real size.</li><li><strong>Order the joins</strong>: run the selective, cheap broadcast join or filters first, so fewer rows reach the expensive shuffle join.</li><li><strong>Bucket for repeated joins</strong>: if clickstream and users are joined on user_id every day, write both bucketed by user_id with the same bucket count and hash function. Later joins become bucketed or SMB joins with no shuffle; you pay the partitioning once at write time.</li><li><strong>Handle skew</strong>: bots and NULL user_ids create hot partitions, especially in a left join. Filter or separate them, and keep AQE's skew-join handling on.</li><li><strong>Verify</strong>: read the physical plan with <code>EXPLAIN</code> (BroadcastHashJoin vs SortMergeJoin, the number of Exchange nodes), and check per-task input sizes in the Spark UI.</li></ul>`,
      followups: [
        "What happens if the product table grows to 30 GB next year?",
        "Why might a table bucketed by Spark not give a bucketed join in Hive?",
        "How would you detect that one shuffle partition is skewed?",
      ],
      pitfalls: [
        "Broadcasting the 400 GB table",
        "Assuming the on-disk size equals the in-memory hash table size",
        "Forgetting that bucketing needs the same count, key and hash function on both sides",
        "Not looking at the query plan",
      ],
    },

    // ---- batch-outputs ----
    {
      id: "q06",
      q: "What is a workflow engine and why do you need one?",
      diff: "easy",
      section: "batch-outputs",
      a: `<p>A workflow engine runs a <strong>DAG of batch jobs</strong> on a schedule. It starts each task when its upstream data is ready, retries failures, alerts on missed SLAs, records run history, and lets you <strong>backfill</strong>, meaning rerun a range of past dates.</p>
<p><strong>Why you need one</strong>: real pipelines are dozens to hundreds of dependent jobs (the book mentions 50 to 100 MapReduce jobs for a recommendation system). Hadoop itself chains jobs only by directory: job 2 reads the directory job 1 writes, and that output counts only once job 1 has succeeded, signaled by a <code>_SUCCESS</code> marker file. Managing that with cron and "wait until the directory exists" scripts turns into a fragile second system.</p>
<p><strong>What it provides</strong></p>
<ul><li>DAGs defined in code or configuration, with dependencies such as "run B for date D after A has succeeded for D".</li><li>Sensors that wait for external inputs (a partition or <code>_SUCCESS</code> file appearing).</li><li>Retries, timeouts, alerting, SLAs, and a UI with run history and logs.</li><li>Backfills: rerun a window of dates after a bug fix, in dependency order.</li></ul>
<p><strong>The design rule that makes it safe</strong>: tasks must be <strong>deterministic and idempotent</strong> and must <strong>overwrite a whole output partition</strong> (for example <code>dt=2025-01-14</code>) rather than append to it. A retry or backfill then replaces exactly what the task owns. Maxime Beauchemin's essay "Functional Data Engineering" (2018) makes this argument.</p>
<p><strong>Examples</strong>: Oozie (Yahoo!), Azkaban (LinkedIn), Luigi (Spotify), Airflow (Airbnb, 2014), Pinball (Pinterest), Dagster and Prefect; dbt manages dependency graphs of SQL models. Higher-level tools (Pig, Hive, Cascading, FlumeJava, Spark) also compile a single program into a multi-job workflow automatically.</p>`,
      followups: [
        "How do you make a task safe to rerun?",
        "How should a task wait for data produced by another team?",
        "How do you backfill a year of data without starving the daily jobs?",
      ],
      pitfalls: [
        "Appending output so that retries duplicate data",
        "Putting business logic in the scheduler instead of in the tasks",
        "Letting downstream tasks read an output before _SUCCESS appears",
      ],
    },
    {
      id: "q-batch-to-db",
      q: "Why shouldn't batch tasks write their results directly into the production database, and what should they do instead?",
      diff: "easy",
      section: "batch-outputs",
      a: `<p><strong>Three reasons, and only the first is about speed:</strong></p>
<ul><li><strong>Throughput</strong>: a network request per record (even batched) is orders of magnitude slower than the rate at which a task can produce output, so the job spends its time waiting on the database.</li><li><strong>Operational coupling</strong>: hundreds of parallel tasks writing at full speed can overload a database that is also serving live traffic, so a batch job becomes a production incident.</li><li><strong>Broken all-or-nothing semantics</strong>: the framework guarantees that a job's output appears completely or not at all, but external writes escape that guarantee. Readers see half-finished results while the job runs, and retried or speculative task attempts write duplicates. Idempotent upserts fix the duplicates but not the partial view. A buggy run also overwrites good rows in place, so you can't simply roll back.</li></ul>
<p><strong>What to do instead</strong></p>
<ul><li>Write a complete, immutable new output to a new location: index files, sorted key-value files, or a new table snapshot. Building these is a natural batch job: extract a key and sort by it.</li><li>Validate it: row counts, coverage, and value distributions compared with the previous version.</li><li>Bulk-load it into the serving store in the background while the old version keeps serving, then switch atomically. Examples: Voldemort read-only stores, HBase bulk load (HFiles), and Iceberg or Delta commits for tables.</li><li>Keep the previous version, so rollback is a switch, not a rebuild.</li></ul>
<p><strong>When direct writes are acceptable</strong>: small outputs written by a single final step (not by hundreds of tasks) into a store sized for it, with idempotent writes and a clear rollback. Even then, writing after the job's output has been committed is safer than writing from inside tasks.</p>`,
      followups: [
        "What if the serving store doesn't support bulk loading?",
        "How do you make the switch atomic across many serving nodes?",
        "When is writing directly acceptable?",
      ],
      pitfalls: [
        "Saying 'just batch the inserts', as if throughput were the only issue",
        "Ignoring retries and speculative execution",
        "No rollback story",
      ],
    },
    {
      id: "q-output-commit",
      q: "Tasks get retried and speculatively duplicated. How does a batch framework make sure the output ends up with exactly one copy of each task's results and never a half-written job? Why was this hard on S3?",
      diff: "hard",
      section: "batch-outputs",
      a: `<p><strong>The commit protocol</strong> (Hadoop's FileOutputCommitter; Spark uses the same committers):</p>
<ul><li><strong>Isolated attempts</strong>: each task attempt writes only to its own attempt directory (for example <code>_temporary/.../attempt_...</code>), so concurrent or failed attempts never collide in the final location.</li><li><strong>One winner per task</strong>: a finished attempt asks the coordinator for permission to commit (Hadoop's application master; Spark's OutputCommitCoordinator on the driver), and only one attempt per task is granted it. The winner's files are promoted into the job's output; losing speculative attempts and failed attempts are deleted.</li><li><strong>Job commit</strong>: once every task has committed, the job finalizes its output and writes an empty <code>_SUCCESS</code> marker.</li><li><strong>Readers wait</strong>: downstream jobs and schedulers only consume outputs that have <code>_SUCCESS</code> (or, with table formats, only committed snapshots).</li></ul>
<p><strong>Why it works on HDFS</strong>: promotion is a rename, which on HDFS is a cheap, atomic metadata operation on the NameNode.</p>
<p><strong>Why it was hard on S3</strong>: S3 is an object store, not a filesystem.</p>
<ul><li>A "rename" is copy plus delete for every object: it takes time proportional to the data size and is not atomic, so a crash midway leaves a partial output, and job commit could take hours for large outputs.</li><li>Before December 2020, S3 listings were only eventually consistent, so a commit that listed the attempt directory could miss files that had just been written.</li><li>Strong read-after-write consistency (since December 2020) fixed the listing problem but not the rename problem.</li></ul>
<p><strong>The fixes</strong>: Hadoop's S3A committers, built on S3 multipart uploads, whose objects become visible only when the upload is completed. The staging committers write task output to local disk and upload it at task commit; the "magic" committer streams it straight to S3. Either way the uploads are left incomplete until the <em>job</em> commits, and only then completed, so nothing becomes visible early and failed attempts are simply aborted. Amazon EMR has an S3-optimized committer built on the same idea. And table formats (Iceberg, Delta Lake, Hudi) avoid renames entirely: data files are written in place, and the commit atomically publishes new table metadata that lists exactly the committed files.</p>`,
      followups: [
        "Why doesn't S3's strong consistency since 2020 make rename atomic?",
        "What would go wrong if two speculative attempts both committed?",
        "How does a table format make a commit atomic on object storage?",
      ],
      pitfalls: [
        "Assuming files appear atomically on object storage",
        "Ignoring speculative duplicates",
        "Letting downstream jobs read a directory before _SUCCESS",
      ],
    },
    {
      id: "q-backfill-bad-data",
      q: "A bug corrupted two weeks of a derived table. How do you recover, and how should the pipeline be designed so this is easy?",
      diff: "medium",
      section: "batch-outputs",
      a: `<p><strong>Recovery</strong></p>
<ul><li><strong>Stop the damage</strong>: if the outputs are versioned (Iceberg or Delta snapshots, versioned directories), first point readers back at the last good version, or roll back the affected partitions.</li><li><strong>Fix and backfill</strong>: fix the code, then rerun the 14 affected date partitions from the immutable raw inputs, each run overwriting exactly its own partition. Run them in parallel within a capacity budget, so the daily jobs aren't starved.</li><li><strong>Repair downstream</strong>: tables derived from the corrupted one are wrong too. Backfill them in dependency order; the workflow engine knows the DAG, and lineage metadata tells you who consumed the bad data.</li><li><strong>Verify</strong>: compare the regenerated partitions with expectations (row counts, distributions), and spot-check that unaffected days come out identical if rerun, which also proves the job is deterministic.</li></ul>
<p><strong>Design rules that make this routine</strong></p>
<ul><li>Raw inputs are immutable and retained for longer than your detection window.</li><li>Tasks are deterministic and idempotent and <strong>overwrite whole partitions</strong> instead of appending.</li><li>Jobs never mutate their inputs; outputs are derived and can always be regenerated.</li><li>Data-quality checks run before publishing, so most bugs are caught before two weeks pass.</li><li>Outputs are versioned, so rollback is a pointer switch.</li></ul>
<p><strong>The contrast</strong>: in an OLTP database where the bug ran UPDATE statements in place, there is nothing to recompute from. You restore backups and replay, or patch by hand. Immutable inputs plus derived outputs are what give batch its <strong>human fault tolerance</strong>.</p>`,
      followups: [
        "How do you backfill without overloading the cluster?",
        "What if the raw input for those days was already deleted?",
        "How do you make sure the backfill produces identical results for unaffected days?",
      ],
      pitfalls: [
        "Patching rows by hand with UPDATE statements",
        "Append-only jobs that double the data on a rerun",
        "Forgetting downstream dependents",
      ],
    },
    {
      id: "q-design-pymk-pipeline",
      q: "Design a nightly pipeline that computes 'people you may know' for 500 million users and serves the results with single-digit-millisecond reads.",
      diff: "hard",
      section: "batch-outputs",
      a: `<p><strong>Shape of the solution</strong>: an offline batch pipeline over immutable snapshots that produces sorted key-value files, which an online read-only store bulk-loads and swaps in atomically. Daily freshness is fine for this product, and users get millisecond lookups by user_id.</p>
<p><strong>1. Inputs</strong>: take a <strong>snapshot</strong> of the friendship graph and profiles from database backups or a CDC feed into object storage, as immutable, date-partitioned tables. Never query the production database from inside the job.</p>
<p><strong>2. Candidate generation (friends of friends)</strong>: self-join the edge table on the middle vertex to get 2-hop pairs (a, c) via b, then count mutual friends per (a, c) with a combiner, dropping existing friends and a itself. Do the arithmetic (illustrative numbers): with an average of 200 friends, naive 2-hop paths are about 40,000 per user, roughly 2&times;10<sup>13</sup> in total, so you must prune. Cap each user's fan-out (sample the friend list of very high-degree users), and keep only the top few hundred candidates per user.</p>
<p><strong>3. Skew</strong>: a celebrity with millions of connections generates a quadratic number of pairs on one reducer. Cap or sample such vertices (they carry little signal for PYMK anyway), salt hot keys, and rely on AQE skew handling.</p>
<p><strong>4. Scoring</strong>: join candidate pairs with features. Broadcast small tables (country, school ids); use bucketed joins on user_id for large ones, so they don't reshuffle every night. Apply the model and keep the top-k per user (say 100).</p>
<p><strong>5. Output</strong>: write files partitioned by user_id range and sorted by key in the serving store's native format (Voldemort read-only store files, RocksDB SST files, HBase HFiles) into a new versioned directory. At 100 candidates &times; about 12 bytes, that is roughly 600 GB, sharded across serving nodes.</p>
<p><strong>6. Validate, then publish</strong>: compare with yesterday's output (row counts, coverage of active users, score distributions, overlap). Block the publish if thresholds fail. Serving nodes fetch the new version in the background while still serving the old one, then swap; a version pointer in a coordination service flips all nodes together. Keep N old versions, so rolling back at 3 a.m. is flipping the pointer back.</p>
<p><strong>7. Orchestration</strong>: an Airflow or Dagster DAG (snapshot &rarr; candidates &rarr; features &rarr; scoring &rarr; build files &rarr; validate &rarr; publish), with idempotent tasks that overwrite their date partition, so retries and backfills are safe.</p>
<p><strong>8. Freshness gaps</strong>: new users have no output until tonight's run. Serve fallbacks (contacts import, popular people in their school or region), and as an extension compute incremental candidates from a stream of new edges (ch11).</p>`,
      followups: [
        "How do you handle a user with 5 million followers?",
        "The job takes 9 hours and must finish in 6: where do you look first?",
        "How do you roll back a bad model output at 3 a.m.?",
        "How would new users get recommendations before tonight's run?",
      ],
      pitfalls: [
        "Querying the production database per user from inside the job",
        "Writing results row by row into the serving database from reducers",
        "Ignoring hot keys in the self-join",
        "No validation step before publishing",
        "Appending instead of overwriting partitions, so reruns duplicate data",
      ],
    },

    // ---- hadoop-vs-mpp ----
    {
      id: "q-why-mapreduce-disk",
      q: "Why does MapReduce write so much intermediate data to disk? Was that a design mistake?",
      diff: "medium",
      section: "hadoop-vs-mpp",
      a: `<p>It was a deliberate trade-off for the environment MapReduce was built for, not a mistake, though it is overkill in many environments today.</p>
<p><strong>The environment</strong>: Google's shared clusters ran batch work at low priority alongside production services, so low-priority tasks were frequently <strong>preempted</strong> to make room for higher-priority work. The book cites roughly a 5% chance per hour that a MapReduce task is preempted, more than an order of magnitude above failure rates from hardware and reboots. Running batch in the leftover capacity is what let Google run its machines at high utilization.</p>
<p><strong>The math</strong>: P(at least one of n tasks killed) = 1 &minus; (1 &minus; p)<sup>n</sup>. For 10-minute tasks, p &asymp; 0.85%, so with 100 tasks there is about a 57% chance that something dies, and with 500 tasks about 99%. If any failure restarted the whole job, big jobs would rarely finish. Recovery has to be <strong>per task</strong>, and per-task recovery needs durable intermediate data: map output on the mapper's local disk, and every job's output in replicated HDFS. MapReduce also assumed the data wouldn't fit in memory anyway.</p>
<p><strong>The contrast</strong>: MPP databases keep data in memory where possible and abort the whole query on a node failure, which is fine for queries that take seconds or minutes.</p>
<p><strong>Where it is less justified</strong>: on dedicated clusters where tasks rarely die, writing every intermediate result to replicated storage is pure overhead. Spark and Flink exploit that: they keep intermediate data in memory or on local disk and recompute from lineage when something is lost.</p>
<p><strong>Modern twist</strong>: spot and preemptible cloud instances (two-minute notice on AWS, 30 seconds on Google Cloud) bring frequent preemption back, so task-level retry, external shuffle services and checkpointing matter again.</p>`,
      followups: [
        "Compute the chance that at least one of 100 ten-minute tasks is killed at 5% per hour",
        "How do Spark jobs on spot instances protect themselves?",
        "Why do MPP databases restart the whole query?",
      ],
      pitfalls: [
        "'Because disks are reliable and memory isn't', with no reasoning",
        "Not knowing that map output goes to local disk, not HDFS",
        "Assuming hardware failure is the main driver",
      ],
    },

    {
      id: "q-lake-vs-warehouse",
      q: "Data lake or MPP data warehouse: how do they differ, when would you use each, and what is a lakehouse?",
      diff: "medium",
      section: "hadoop-vs-mpp",
      a: `<p><strong>The core difference is when a schema is imposed.</strong> An MPP warehouse (Teradata, Vertica, Redshift, Snowflake) requires data to be modeled and loaded into its own storage format before anyone can query it. A data lake (HDFS or object storage) accepts raw files in any format and leaves each consumer to interpret them when reading: schema-on-read (ch2).</p>
<ul><li><strong>Warehouse strengths</strong>: storage layout, planner and executor are designed together, so SQL over modeled data is fast and predictable; analysts and BI tools already speak SQL; data quality is enforced at load time.</li><li><strong>Warehouse costs</strong>: every new source needs modeling and an import pipeline before it is useful; arbitrary code (ML, image processing, custom parsers) is awkward as UDFs; and classically a node failure aborts the whole query, which suits short queries rather than six-hour jobs.</li><li><strong>Lake strengths</strong>: land data immediately and decide later what it means (the "sushi principle": raw data is better); keep raw history so it can be reinterpreted when you learn more; run many engines (Spark, Hive, Trino, ML frameworks) over one copy of the files.</li><li><strong>Lake costs</strong>: every consumer has to cope with messy formats and schema drift; without a catalog, owners and schemas it turns into a "data swamp"; and plain files have no transactions, so concurrent writers and half-written outputs need care.</li></ul>
<p><strong>How they combine</strong>: the classic pattern uses the lake as the staging area. Raw dumps land in it, batch jobs clean and reshape them, and curated tables are loaded into the warehouse for BI. The <strong>lakehouse</strong> merges the two: open table formats (Iceberg, Delta Lake, Hudi) add atomic commits, snapshots and schema evolution to Parquet files on object storage, and SQL engines query those tables in place.</p>
<p><strong>How I'd choose</strong>: mostly structured data feeding dashboards &rarr; a cloud warehouse. Many heterogeneous sources, ML workloads, or several engines over the same data &rarr; a lake with a table format and a catalog, usually with curated SQL tables on top.</p>`,
      followups: [
        "What does schema-on-read cost the consumers of the data?",
        "How does a table format make commits atomic on object storage?",
        "How do you keep a data lake from turning into a swamp?",
      ],
      pitfalls: [
        "Treating the lake as a dumping ground with no catalog, owners or schemas",
        "Claiming that warehouses can't scale or that lakes can't serve fast SQL",
        "Ignoring that most organizations run both in one pipeline",
      ],
    },

    // ---- dataflow-engines ----
    {
      id: "q03",
      q: "Why is Spark typically faster than MapReduce?",
      diff: "medium",
      section: "dataflow-engines",
      a: `<p>Mostly because Spark runs a whole workflow as <strong>one DAG</strong> instead of a chain of separate MapReduce jobs, so it can skip work that MapReduce is forced to do.</p>
<ul><li><strong>No replicated intermediate files</strong>: chained MapReduce writes each job's output to HDFS with 3 replicas before the next job may start. Spark keeps intermediate data in memory or on local disk and writes only the final output durably. It is not "in-memory only": shuffle output still goes to local disk (like MapReduce's map output), caching is opt-in, and data spills to disk when memory is short.</li><li><strong>Operator fusion</strong>: chains of narrow operators (map, filter, a join against a broadcast table) run in one task, pipelined record by record. There are no redundant map stages that just reread a reducer's output.</li><li><strong>Sorting only where needed</strong>: MapReduce always sorts between map and reduce. Spark sorts only for operators that need it (sort-merge join, ORDER BY) and can use hash aggregation otherwise.</li><li><strong>Long-lived executors</strong>: executor JVMs are reused across tasks instead of starting one per task, so tasks launch in milliseconds.</li><li><strong>Caching for iteration</strong>: iterative ML and graph algorithms reuse an in-memory dataset instead of rereading HDFS on every iteration.</li><li><strong>Optimizer and execution</strong>: Spark SQL chooses join strategies, prunes columns, pushes filters into Parquet, and generates code (whole-stage codegen).</li></ul>
<p><strong>Be precise about pipelining</strong>: Spark pipelines within a stage, but across a shuffle (a <strong>wide dependency</strong>) the child stage starts only after the parent stage has written all its shuffle files. Flink can pipeline across exchanges. (See the question on narrow and wide dependencies.)</p>
<p><strong>How much faster</strong>: it depends on the workload. The RDD paper reports up to 20&times; for iterative applications, and in 2014 Spark sorted 100 TB in 23 minutes on 206 machines, against Hadoop's previous record of 72 minutes on 2,100. A single-pass ETL job that reads, maps and writes gains far less.</p>
<p><strong>The cost</strong>: without replicated intermediate data, failures are handled by recomputing from lineage, which is expensive for long lineages and requires deterministic operators.</p>`,
      followups: [
        "How does Spark recover a lost partition?",
        "When would you call checkpoint()?",
        "Where does Spark still write to disk?",
        "Why might a single-pass ETL job see little speedup?",
      ],
      pitfalls: [
        "Spark is in-memory, so it never touches disk",
        "Quoting a blanket 10 to 100 times speedup",
        "Saying Spark streams data between every pair of operators",
      ],
    },
    {
      id: "q-narrow-wide",
      q: "In Spark, what are narrow and wide dependencies, and why do they matter for performance and fault tolerance?",
      diff: "medium",
      section: "dataflow-engines",
      a: `<p><strong>Narrow dependency</strong>: each output partition depends on a bounded set of input partitions, usually exactly one. Examples: map, filter, flatMap, union, and a join of inputs that are already co-partitioned. Spark fuses chains of narrow operators into one task and pipelines records through them, with no data movement.</p>
<p><strong>Wide dependency</strong>: an output partition needs data from many input partitions. Examples: groupByKey, reduceByKey, distinct, repartition, and a join of inputs that aren't co-partitioned. This requires a <strong>shuffle</strong>. Spark cuts the DAG into <strong>stages</strong> at each one: the parent stage writes shuffle files to local disk, and the child stage starts once the parent stage has finished.</p>
<p><strong>Why it matters for performance</strong></p>
<ul><li>Each shuffle costs disk writes, network transfer and serialization, and it is where skew appears. Count the Exchange nodes in <code>EXPLAIN</code>, or the stages in the UI.</li><li>Avoid shuffles with broadcast joins, pre-partitioned or bucketed data, and <code>reduceByKey</code> instead of <code>groupByKey</code> (which also combines on the map side).</li><li>Never treat <code>repartition()</code> as free: it is a full shuffle.</li></ul>
<p><strong>Why it matters for fault tolerance</strong></p>
<ul><li>A lost partition behind narrow dependencies is recomputed from its parent partition only.</li><li>Lost shuffle output raises a FetchFailed error, and the parent stage's missing map tasks are rerun.</li><li>Long chains of wide dependencies (iterative jobs) make recovery expensive, which is where <code>checkpoint()</code> pays off.</li></ul>
<p><strong>Link to the book</strong>: these are the book's three kinds of edges in Spark vocabulary. Repartition and sort, and repartition without sort, are shuffles (wide); broadcast is a broadcast variable or broadcast join; everything else is narrow and fused.</p>`,
      followups: [
        "Is a join always a wide dependency?",
        "Why is reduceByKey cheaper than groupByKey?",
        "What exactly is a stage in the Spark UI?",
      ],
      pitfalls: [
        "Saying Spark streams data between every pair of operators in memory",
        "Treating repartition() as free",
        "Not knowing that stage boundaries are shuffles",
      ],
    },
    {
      id: "q-recovery-mr-vs-spark",
      q: "How do MapReduce and Spark each recover when a machine dies mid-job, and when is Spark's approach worse?",
      diff: "hard",
      section: "dataflow-engines",
      a: `<p><strong>MapReduce</strong>: every job's output is materialized in HDFS with replication, so earlier jobs are never affected. Within the running job:</p>
<ul><li>Tasks that were running on the dead machine are rerun elsewhere from their immutable input.</li><li><strong>Completed map tasks</strong> on that machine are rerun too, because their output lived on its local disk and reducers may still need it.</li><li>Completed reduce tasks are not rerun; their output is already in HDFS.</li></ul>
<p><strong>Spark</strong>: intermediate data lives in executor memory or on local disk (shuffle files), and nothing is replicated by default.</p>
<ul><li>Lost partitions are recomputed from <strong>lineage</strong>: Spark walks back through the recorded transformations to the nearest data that still exists (cached partitions, surviving shuffle output, or the original input) and replays from there.</li><li>If a reducer can't fetch shuffle output, it raises a FetchFailed error, and the scheduler resubmits the parent stage's missing map tasks.</li><li>An external shuffle service (or remote shuffle storage) keeps shuffle files available even when the executor that wrote them dies.</li></ul>
<p><strong>When Spark's approach is worse</strong></p>
<ul><li><strong>Long lineage</strong>: iterative jobs or long chains of transformations make recomputation expensive and can cascade back through many stages.</li><li><strong>Nondeterministic operators</strong>: random sampling without a seed, round-robin <code>repartition()</code>, or hash-iteration order. A recomputed partition can differ from the one downstream tasks already consumed, so Spark must rerun downstream stages too, or results can be wrong (SPARK-23207 was a real bug of this kind).</li><li><strong>Expensive but small intermediate results</strong>: recomputing hours of work to recover a few megabytes is worse than storing them.</li><li><strong>Frequent failures</strong> (preemptible capacity): recomputation without durable checkpoints may keep losing progress.</li></ul>
<p><strong>Pipelined engines pay differently</strong>: Flink can stream records across shuffles, and then nothing sits between operators to recompute from. A failure restarts the whole <strong>pipelined region</strong>, every task connected to the failed one through pipelined exchanges, which with all-to-all shuffles is often the entire job. Flink's batch mode avoids this by making shuffles blocking, so each stage becomes its own region and only lost work is rerun.</p>
<p><strong>Mitigations</strong>: <code>checkpoint()</code> to reliable storage to cut lineage; <code>persist()</code> with a replicated storage level for hot intermediate data; deterministic seeds and sorting before order-sensitive steps; and an external shuffle service, so losing an executor doesn't lose its shuffle files.</p>`,
      followups: [
        "What does Spark do when a shuffle file can't be fetched?",
        "Why does repartition() need special care on retries?",
        "When would you call checkpoint() in an iterative algorithm?",
        "In a job whose shuffles are pipelined (Flink), what restarts when one task fails?",
      ],
      pitfalls: [
        "Claiming Spark keeps everything in memory and never writes to disk",
        "Saying Spark replicates RDDs by default",
        "Ignoring determinism",
      ],
    },

    // ---- graph-processing ----
    {
      id: "q08",
      q: "What is iterative processing and why is MapReduce bad at it?",
      diff: "hard",
      section: "graph-processing",
      a: `<p><strong>Iterative algorithms</strong> repeat the same step until a condition holds: PageRank until the ranks stop changing, connected components until no label changes, k-means until the centroids stabilize, shortest paths until no distance improves. Each iteration needs the full result of the previous one.</p>
<p><strong>Why MapReduce is bad at it</strong>: it has no notion of a loop. An external driver runs one job per iteration and checks for convergence between jobs. Every iteration rereads the whole dataset from HDFS, shuffles it, and writes the whole result back with 3&times; replication, even if only a handful of vertices changed. Job start-up and the wait for all maps before any reduce are paid on every iteration too.</p>
<p><strong>Better approaches</strong></p>
<ul><li><strong>Pregel / bulk synchronous parallel</strong> (Pregel, Giraph, GraphX, Gelly): each <em>vertex</em> keeps its state in memory between supersteps. In each superstep, every active vertex processes the messages sent to it in the previous superstep, updates its state, sends messages along its edges, and may vote to halt. A barrier separates supersteps, and each message is processed exactly once in the next superstep. The job ends when every vertex has halted and no messages are in flight. Vertices with nothing to do cost nothing.</li><li><strong>Fault tolerance</strong>: checkpoint all vertex state every few supersteps; on failure, roll the whole graph back to the checkpoint (or recover only the lost partitions, if the algorithm is deterministic and messages are logged).</li><li><strong>Spark</strong>: cache the working set in memory across iterations, and checkpoint periodically so the lineage doesn't grow without bound.</li></ul>
<p><strong>Caveats</strong>: vertices are placed by hashing their id, so most messages cross the network, and the barrier makes every superstep wait for its slowest worker. If the graph fits in one machine's memory, a single-machine algorithm often beats a cluster (the COST paper).</p>`,
      followups: [
        "Why is there a barrier between supersteps?",
        "How is fault tolerance achieved without replicating every message?",
        "How do you detect global convergence when voting to halt is local?",
      ],
      pitfalls: [
        "Confusing a dataflow DAG with graph processing",
        "Assuming distributed is always faster",
        "Saying the job stops when ranks converge without explaining who checks (an aggregator or a fixed superstep count)",
      ],
    },
    {
      id: "q-pagerank-scale",
      q: "How would you compute PageRank over a web graph with 50 billion edges? Why not just use plain MapReduce?",
      diff: "hard",
      section: "graph-processing",
      a: `<p><strong>First question: does it need a cluster at all?</strong> Stored as compressed adjacency lists at about 4 to 8 bytes per edge, 50 billion edges is roughly 200 to 400 GB. That fits in the memory of a large server, and disk-based single-machine systems (GraphChi-style) handle even more. The COST paper (HotOS 2015) showed single-threaded implementations matching or beating distributed graph systems on PageRank, and Twitter's first Who-to-Follow service kept its whole graph in memory on one server. So benchmark one big machine before building a cluster job.</p>
<p><strong>If it must be distributed: Pregel / BSP</strong> (Giraph, GraphX, Flink Gelly)</p>
<ul><li><strong>Partitioning</strong>: vertices are spread across workers, by default by hashing the vertex id. Better: keep each web domain's pages together to cut cross-machine messages. Each vertex keeps its rank and out-edges in memory.</li><li><strong>Superstep</strong>: each vertex sends rank/outdeg along each out-edge; in the next superstep it sets rank = (1 &minus; d)/N + d &middot; &Sigma;(incoming), with d &asymp; 0.85.</li><li><strong>Combiners</strong>: pre-sum messages bound for the same vertex on the sending worker. This is valid because contributions are added.</li><li><strong>Dangling nodes</strong> (pages with no out-links) leak rank. Collect their total with an aggregator and redistribute it evenly in the next superstep.</li><li><strong>Convergence</strong>: an aggregator computes the global L1 change. Stop when it falls below &epsilon;, or after a fixed number of iterations (often 20 to 50; the Pregel paper's example runs 30). Voting to halt alone doesn't work, because it is local.</li><li><strong>Fault tolerance</strong>: checkpoint vertex state every few supersteps and roll back to the last checkpoint on failure. The interval trades extra I/O when nothing fails against recomputation when something does.</li><li><strong>Stragglers</strong>: the barrier makes every superstep as slow as the slowest worker. High-degree vertices skew the load, so balance partitions by edges, not vertices.</li></ul>
<p><strong>Why not plain MapReduce</strong>: it has no loops. Each iteration is a separate job driven by an external scheduler: read the whole graph and the current ranks from HDFS, join them, shuffle the contributions, and write the full graph and new ranks back with replication. Forty iterations means forty full rewrites of hundreds of gigabytes, plus job start-up and a full barrier each time. It works, but almost all the time goes on I/O that an in-memory model avoids. Spark sits in between: cache the link table, iterate with joins, and checkpoint every few iterations to cut the lineage.</p>`,
      followups: [
        "What is a dangling node, and how do you handle it?",
        "How do you choose the checkpoint interval?",
        "How would you update PageRank incrementally as the graph changes?",
      ],
      pitfalls: [
        "Assuming distributed is always faster",
        "Forgetting the cost of the barrier and stragglers",
        "Ignoring dangling nodes and convergence criteria",
      ],
    },

    // ---- high-level-apis ----
    {
      id: "q07",
      q: "Why are high-level APIs (Hive, Spark SQL) preferred over raw MapReduce/RDDs?",
      diff: "medium",
      section: "high-level-apis",
      a: `<p>Because a declarative description tells the engine <em>what</em> you want, and the engine can then choose <em>how</em> to do it, using information that a hand-written job doesn't have.</p>
<ul><li><strong>Join algorithm and order</strong>: broadcast vs bucketed vs sort-merge, chosen from table statistics and layout metadata. A cost-based optimizer (Hive, Flink, Spark since 2.2) also orders the joins to keep intermediate results small, and Spark 3's AQE revises the plan at runtime from actual shuffle sizes.</li><li><strong>Reading less</strong>: column pruning reads only the needed columns from Parquet or ORC; predicate pushdown skips row groups or whole files using min/max statistics and partition directories.</li><li><strong>Running faster</strong>: vectorized execution over column batches and generated code (Spark's whole-stage codegen, Impala's LLVM) instead of a virtual function call per record.</li><li><strong>Productivity</strong>: a join that takes a page of mapper, reducer, partitioner and comparator code is a few lines of SQL. Analysts and BI tools already speak SQL, and notebooks allow interactive refinement, much like building a Unix pipeline stage by stage.</li></ul>
<p>The result is usually equal or better performance than a hand-written job, because the optimizer applies tricks that most hand-written jobs don't bother with.</p>
<p><strong>Caveats</strong></p>
<ul><li>These systems aren't purely declarative. UDFs are the escape hatch for parsing, ML and image code, but an opaque UDF blocks pushdown, code generation and vectorization. Row-at-a-time Python UDFs in PySpark also serialize every row between the JVM and Python; prefer built-in functions, then Arrow-based pandas UDFs.</li><li>Optimizers make mistakes when statistics are stale or missing: read the plan (<code>EXPLAIN</code>) and use hints when needed.</li><li>Low-level APIs (RDDs) remain useful for custom partitioning or algorithms that SQL can't express.</li></ul>`,
      followups: [
        "How would you find out which join Spark picked?",
        "Why does a Python UDF slow a Spark SQL query down?",
        "When would you still drop down to the RDD API?",
      ],
      pitfalls: [
        "Claiming SQL is always faster than any hand-written job",
        "Ignoring the cost of UDFs",
        "Not reading the physical plan",
      ],
    },
  ],
});
