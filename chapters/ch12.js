// Chapter 12: The Future of Data Systems
// Authoring guide: docs/AUTHORING.md
DDIA.registerChapter({
  id: "ch12",
  part: 3,
  number: 12,
  title: "The Future of Data Systems",
  tagline: "Build systems from a log plus derived views, make correctness end to end, and own what your data does to people.",
  overview: `<p>The last chapter steps back from individual tools and asks how to combine them into applications that are reliable, correct and easy to evolve, and what responsibility comes with building them. It is more opinionated than the rest of the book: Kleppmann sets out where he thinks data systems should go, building on logs and change data capture (<a href="#/ch11/learn/change-data-capture">Chapter 11</a>), batch processing (<a href="#/ch10/learn/why-batch">Chapter 10</a>), consensus (<a href="#/ch9/learn/consensus">Chapter 9</a>) and transactions (<a href="#/ch7/learn/why-transactions">Chapter 7</a>).</p>
<p>The central tension is that <strong>no single system does everything</strong>, so the same facts live in a database, a search index, a cache, a warehouse and an ML pipeline that must all agree. The classic tool for agreement, distributed transactions, is slow and fragile, and most heterogeneous stores don't support it. The chapter's answer is to avoid synchronous coordination in most places and stay correct anyway: <strong>integrity</strong> (nothing lost, nothing duplicated or invented) is non-negotiable, while <strong>timeliness</strong> (seeing the latest state right now) is relaxed and paid for only where an apology would cost too much.</p>
<p>The ideas build in order. First, integrate by deriving: one ordered log, with every other store a deterministic view of it, and explicit causal metadata where total order runs out. Retained events make reprocessing possible, which removes the need for the Lambda architecture's two codebases. Seen across a whole organization, this is the database <strong>unbundled</strong>: the log acts as the replication log, stream processors act as index maintenance, application code becomes a derivation function, and derived data is where the write path meets the read path, all the way to the user's screen. Correctness then follows the <strong>end-to-end argument</strong>: request IDs created by the client, constraints enforced by processing a log partition in sequence, integrity kept without 2PC, and audits that verify instead of trusting. Finally, the same pipelines make decisions about people and record their behaviour, so the book closes on bias, feedback loops, accountability, privacy and collecting less.</p>`,

  concepts: [
    // ---- data-integration ----
    {
      id: "data-integration",
      term: "Data integration",
      def: `Making the data an organization keeps in many specialized systems (OLTP database, search index, cache, warehouse, ML feature store) agree with each other. The chapter's prescription is to reason explicitly about <strong>dataflow</strong>: for each kind of data, decide which system is the <strong>system of record</strong>, where every write is recorded first, which representations are derived from which, and in what order changes propagate.`,
      problem: `No single storage technology serves all access patterns, because each one wants a different storage layout (Chapter 3). So organizations run many systems that must agree on the same facts, and the ad-hoc glue between them (dual writes in request handlers, nightly exports, hand-run backfills) quietly diverges.`,
      why: `The more general a tool is, the more likely that one team's core requirement is another's obscure feature, so the useful question shifts from "which database?" to "how does data flow between databases?". Once the dataflow is explicit, the rest of the chapter follows: one ordered log as the integration point, deterministic consumers, reprocessing when the logic changes, and end-to-end checks that the copies still agree.`,
      ex: `A bookshop: PostgreSQL holds orders and the catalog (the system of record); Debezium streams its committed changes into Kafka; consumers update Elasticsearch for product search, Redis for hot product pages and Snowflake or BigQuery for analytics. When the price of <em>Dune</em> changes, one committed row change reaches all four, in commit order.`,
      section: "data-integration",
    },
    {
      id: "derived-data",
      term: "Derived data (vs systems of record)",
      def: `Data produced by transforming other data: secondary and full-text indexes, caches, materialized views, denormalized copies, aggregates, warehouse tables, ML models and feature tables. It is <strong>redundant</strong>: if you lost it, you could rebuild it from the <strong>system of record</strong>, where each fact is written once, usually normalized, and is authoritative. The litmus test: <em>could you rebuild it from something else?</em> If yes, it is derived.`,
      problem: `Each access pattern needs its own representation, so the same facts must exist in many stores. Without a clear rule about which copy is authoritative, nobody knows which one to trust when they disagree, or how to repair the others.`,
      why: `Calling data derived tells you how to operate it. It can be thrown away and recomputed after a bug or a schema change; it must be fed from its source in order, by deterministic code; and it is always somewhat behind its source. A derived view that is a few seconds behind is a <strong>timeliness</strong> issue that heals as the pipeline catches up; a derived view that no longer matches its source is an <strong>integrity</strong> bug that waiting will not fix.`,
      ex: `An Elasticsearch index rebuilt from Postgres through CDC, a Redis cache of rendered product pages, a recommendation model retrained from click logs, a warehouse table recomputed nightly. The orders table itself is not derived, unless orders are event-sourced (<a href="#/ch11/learn/event-sourcing">Chapter 11</a>), in which case the table is a view of the order events.`,
      section: "data-integration",
    },
    {
      id: "source-of-truth-immutable-log",
      term: "Source of truth: one ordered, immutable log",
      def: `Every write is recorded first in one place that gives it a position in a single total order (an append-only log), and every other store is a <strong>derived view</strong> that applies the log in that order with deterministic code. The system of record can be the log itself (event sourcing) or an OLTP database whose change log, exposed through CDC, is the ordered stream: the log does not have to be the first place the application writes. The single order holds <strong>within one log or partition only</strong>; across partitions, services or datacenters there is no order for free (see limits of total ordering and capturing causal dependencies).`,
      problem: `Dual writes let systems apply concurrent writes in different orders and diverge permanently: client 1 sets the price to A, client 2 sets it to B, the database ends with B and the index with A, and every write returned success (<a href="#/ch11/learn/change-data-capture">Chapter 11</a>).`,
      why: `A single source avoids dual-write divergence. With one order and deterministic consumers, each concurrency conflict is decided once, by log position, and every view converges to a state consistent with some prefix of the log: views can lag, but they cannot diverge. Because a log retains its contents (unlike a queue, which deletes what it delivers), replaying it can rebuild any view, and new logic can be added later as a new consumer that starts from the beginning. Derivations must be deterministic for this to hold: put the timestamp or exchange rate into the event instead of having consumers read the clock or call a service.`,
      ex: `Postgres's write-ahead log read by Debezium into a Kafka topic keyed by product ID (CDC), or an event-sourced order service that appends OrderPlaced events to Kafka and builds its own tables from them. Chapter 11's <a href="#/viz/ch11/dual-writes">dual-writes viz</a> shows the divergence, and Chapter 9's <a href="#/viz/ch9/total-order-broadcast">total-order-broadcast viz</a> shows convergence from one order.`,
      section: "data-integration",
    },
    {
      id: "derived-data-vs-distributed-transactions",
      term: "Derived data vs distributed transactions",
      def: `Two ways to keep several systems in sync. Distributed transactions order writes with locks and make them atomic with two-phase commit, giving immediate consistency (e.g., read-your-writes) at the cost of coordination and fragility. Log-based derived data orders writes by their position in a log and makes them effectively atomic through deterministic, idempotent replay; it is usually asynchronous, so views can lag.`,
      problem: `Keeping a database, a search index, a cache and a warehouse in agreement with dual writes leads to permanent divergence, and XA transactions across heterogeneous stores are slow, block on coordinator failure, and are rarely supported.`,
      why: `Both approaches aim at the same goal and pay different prices. Distributed transactions buy timeliness (a reader sees its own write everywhere, immediately) with coordination: an unresponsive participant stalls or aborts every transaction that touches it, a coordinator crash after the prepare phase leaves locks held in doubt, and XA is a lowest-common-denominator protocol (<a href="#/ch9/learn/distributed-transactions-in-practice">Chapter 9</a>). Log-based derivation keeps faults local (a slow consumer just lags) and works with anything that can consume a log, but gives no read-your-writes across views unless you build it, for example by waiting until the consumer has passed your write's offset. The book judges the log the more promising way to integrate different systems, and accepts the weaker timeliness.`,
      ex: `XA across a MySQL database and an ActiveMQ queue, versus Postgres → Debezium → Kafka → Elasticsearch. In the first, a hung broker holds up database commits; in the second, a hung Elasticsearch cluster only makes search stale until it catches up from its committed offset.`,
      section: "data-integration",
    },
    {
      id: "limits-of-total-ordering",
      term: "Limits of total ordering",
      def: `A single totally ordered log needs all events to pass through one leader. Total order breaks down when throughput exceeds one machine (partitioning), across datacenters with their own leaders, across microservices with separate state, and for offline-capable clients. Deciding a total order is total order broadcast, equivalent to consensus (<a href="#/ch9/learn/total-order-broadcast">Chapter 9</a>).`,
      problem: `The log-as-source-of-truth idea assumes one order for everything; real deployments are partitioned, geo-distributed and service-oriented, so causally related events (unfriend, then message) can be seen in the wrong order.`,
      why: `Most consensus algorithms assume that one node can handle the whole stream's throughput and offer no way to share the work of deciding a single order across machines; at the time of the book that was an open research problem. So in practice order exists per partition, per datacenter or per service, and the application has to cope with events whose relative order nobody decided.`,
      ex: `Kafka orders messages only within a partition, so a topic with 64 partitions has 64 independent orders. A multi-region deployment with a leader per region (for low latency and to survive a region outage) has no order between the regions' writes; two microservices with their own topics have no order between them; and a phone that accepts writes offline sees events in a different order from the server.`,
      section: "data-integration",
    },
    {
      id: "capturing-causal-dependencies",
      term: "Capturing causal dependencies across logs",
      def: `When causally related events travel through different logs (partitions, services, datacenters), make the dependency explicit: the later event records the ID or version of the state it was based on (e.g., the friend-list version the user saw), and consumers hold it until they have applied that state. Logical clocks can order events too, but only if consumers wait for every input to pass a timestamp.`,
      problem: `A consumer joining two streams can act on an effect before seeing its cause (a post about Ben is pushed to Ben because the unfriend event is still in flight in another partition), and side effects like notifications can't be undone.`,
      why: `Correctness usually needs causality rather than a total order: the consumer must see a cause before acting on its effect. Wall-clock timestamps don't capture it (clocks skew, Chapter 8, and a timestamp says nothing about an event still in flight). Lamport timestamps (<a href="#/ch9/learn/lamport-timestamps">Chapter 9</a>) give an order, but the consumer must still wait for its slowest input. Conflict resolution such as CRDTs (Chapter 5) converges state but cannot recall a notification already sent. Recording what the user saw costs waiting only when the cause really is late.`,
      ex: `The book's unfriend example: Ana removes Ben as a friend, then posts a complaint about him to her remaining friends. If friendships and posts flow through different partitions, the notifier can join the post with a stale friend list and notify Ben. Fixes: partition both streams by author ID, or have the post carry the friend-list version Ana saw and make the notifier hold it until its own copy reaches that version (the unfriend-race viz).`,
      section: "data-integration",
    },

    // ---- reprocessing ----
    {
      id: "reprocessing-for-evolution",
      term: "Reprocessing for application evolution",
      def: `Deriving a new view from the full history of retained events, side by side with the old view, so a schema or logic change can be rolled out gradually (shift a fraction of reads at a time) and rolled back at any point, like laying a third rail during a railway gauge conversion.`,
      problem: `In-place schema migrations of large datasets are risky and often irreversible, and stream processing alone can only fix future data, not history.`,
      why: `Stream processing keeps views current as their inputs change; reprocessing the whole history is what lets you restructure a view completely, rather than only making simple changes like adding an optional field (Chapter 4). Running old and new views side by side makes every step reversible: move some readers, compare, and retreat if the new view is wrong. That turns large, frightening migrations into routine ones.`,
      ex: `The book's railway analogy: the Great Western Railway's 7 ft &frac14; in broad gauge was converted to standard gauge over decades using mixed-gauge (three-rail) track, so both kinds of train could run during the transition; the last broad-gauge lines were converted in May 1892. In data terms: build a v2 search index from the retained log into a new index, send 5% of queries to it, compare relevance, then switch an Elasticsearch index alias, which changes atomically.`,
      section: "reprocessing",
    },
    {
      id: "lambda-architecture",
      term: "Lambda architecture",
      def: `An architecture proposed by Nathan Marz (2011 blog post "How to beat the CAP theorem"; book <em>Big Data</em>, Manning, 2015, with James Warren). Incoming data is appended as immutable events to an ever-growing <strong>master dataset</strong>. A <strong>batch layer</strong> (originally Hadoop MapReduce) periodically recomputes read-optimized batch views from all of it. A <strong>speed layer</strong> (originally Storm) processes the events that arrived since the last batch run, covering recent data with low latency. A <strong>serving layer</strong> makes the batch views queryable, and queries merge them with the speed layer's real-time views.`,
      problem: `In 2011 stream processors were fast but young and less reliable, while batch was dependable but slow; Marz wanted both correct history and low latency.`,
      why: `It got something important right: immutable raw events plus recomputable views, so a bug in derivation code can be fixed by recomputing. The book's three critiques: (1) the same logic must be written and kept identical in a batch framework and a stream framework; abstractions like Twitter's Summingbird help, but you still debug, tune and operate two systems; (2) the two outputs must be merged at read time, which is easy for simple aggregates over tumbling windows and hard for joins, sessionization or outputs that aren't time series; (3) recomputing everything is expensive, so batch layers drift toward incremental batches (an hour at a time), which brings back stragglers and window-boundary problems, and the batch layer stops being simple. The speed layer may use approximate algorithms, but that is optional, not what defines it.`,
      ex: `Storm (built by Marz at BackType and open-sourced by Twitter in 2011) paired with Hadoop. Twitter's Summingbird (open-sourced in 2013) let one Scala definition run on both Scalding (Hadoop) and Storm: a direct response to "write it twice".`,
      section: "reprocessing",
    },
    {
      id: "unifying-batch-and-stream",
      term: "Unifying batch and stream processing",
      def: `Running the same code over historical and live data in one engine. Requires: replaying historical events through the stream engine, exactly-once (effectively-once) semantics, and windowing by event time rather than processing time. Apache Beam, Flink and Spark Structured Streaming follow this model.`,
      problem: `The Lambda architecture duplicated every piece of logic in a batch framework and a stream framework and had to merge their outputs at read time.`,
      why: `Each requirement removes one reason for Lambda's second codebase. Replay lets the stream engine see history; effectively-once processing (<a href="#/ch11/learn/fault-tolerance">Chapter 11</a>) makes its output as trustworthy as a batch rerun; event-time windows (<a href="#/ch11/learn/reasoning-about-time">Chapter 11</a>) put a replayed year of events into last year's windows instead of today's. Determinism matters too: no wall-clock reads and no calls to mutable services inside the derivation.`,
      ex: `The Dataflow Model paper (Akidau et al., VLDB 2015) underlies Google Cloud Dataflow and Apache Beam (a top-level Apache project since January 2017), whose pipelines run on Flink, Spark and Dataflow. Spark Structured Streaming arrived in Spark 2.0 (2016, experimental) and was declared production-ready in 2.2 (2017); Flink 1.12 (2020) added a batch execution mode for DataStream programs.`,
      section: "reprocessing",
    },
    {
      id: "kappa-architecture",
      term: "Kappa architecture",
      def: `The name Jay Kreps gave, in "Questioning the Lambda Architecture" (O'Reilly Radar, July 2014), to keeping only the stream path. To reprocess, start a second instance of the job from the beginning of the retained log, writing to a <strong>new</strong> output table; when it has caught up, switch readers to the new table, then stop the old job and delete the old table.`,
      problem: `Lambda required writing and operating every computation twice, and the two versions drifted apart.`,
      why: `Preconditions: the log keeps the full history (long retention, tiered storage, or an archive replayed through the same code; a compacted topic is enough only for views that need just the latest value per key); the job uses event-time windows and deterministic code; its sinks are idempotent or versioned; side effects such as emails and payments are switched off during replay; and there is capacity to replay well above real-time speed. DDIA argues for unifying batch and stream processing in one system, which is the idea behind Kappa. Batch engines did not disappear, and the lasting lesson is to have one definition of each derivation.`,
      ex: `Kreps described it with Kafka and Samza at LinkedIn. To fix a metric today: deploy v2 of a Flink or Kafka Streams job as a new consumer group from the earliest offset into <code>metrics_v2</code>, diff it against <code>metrics_v1</code>, then repoint the dashboards. Kafka tiered storage (KIP-405; early access in 3.6, production-ready in 3.9) makes long retention cheaper by moving old segments to object storage.`,
      section: "reprocessing",
    },

    // ---- unbundling-databases ----
    {
      id: "unbundling-the-database",
      term: "Unbundling the database",
      def: `Treating the dataflow across an organization as one big database whose internal machinery has been pulled apart and rebuilt from separate pieces: a durable log plays the replication log, stream processors play triggers, index maintenance and materialized-view refresh, and specialized stores (search index, cache, column store, graph database) play the indexes and views. A database already works this way inside: <code>CREATE INDEX</code> takes a consistent snapshot, builds the index, applies the writes made in the meantime, then maintains it on every commit. Unbundling does the same across systems. Contrast: <strong>federated</strong> systems unify <em>reads</em> (one query interface over many stores); <strong>unbundled</strong> systems unify <em>writes</em>, propagating every change to every store through a log.`,
      problem: `Inside one database, indexes and views stay in sync automatically; once data spans many specialized systems, teams rebuild that machinery by hand with dual writes and ETL.`,
      why: `It aims for Unix-style composability (small tools with a uniform interface) with database-style guarantees. The book argues that an asynchronous log with idempotent consumers is far more robust than distributed transactions across heterogeneous stores: a failed consumer falls behind and catches up instead of failing everyone (loose coupling between systems), and different teams can own the producer and each consumer (loose coupling between people). The costs are many moving parts to operate, no read-your-writes across views by default, schemas on the log that become public contracts, and debugging that spans systems. If one database does everything you need, use it; unbundle only when no single product fits.`,
      ex: `Postgres → Debezium → Kafka → Elasticsearch + Redis + warehouse. Kleppmann presented the idea as "Turning the database inside-out" (Strange Loop 2014; Confluent blog, 2015). The piece he said was missing, a declarative "CREATE INDEX across systems", is what streaming databases such as Materialize (built on Differential Dataflow) and ksqlDB move toward.`,
      section: "unbundling-databases",
    },
    {
      id: "federated-databases",
      term: "Federated databases (unifying reads)",
      def: `A single query interface over many underlying storage engines (polystore), e.g., PostgreSQL foreign data wrappers or Trino connectors. Contrast with unbundled databases, which unify writes by propagating changes through a log.`,
      problem: `Data spread across many specialized stores is hard to query together; federation solves reading across them but does nothing to keep their writes consistent.`,
      why: `Federation is useful for exploration and ad-hoc joins across systems, but it leaves the hard problem untouched: keeping writes consistent between the stores. Queries also inherit the speed and limits of the slowest or least capable source, and how much work can be pushed down to each source varies by connector.`,
      ex: `PostgreSQL's <code>postgres_fdw</code> (an SQL/MED foreign data wrapper) queries a remote Postgres as if its tables were local. Trino (formerly PrestoSQL, from the creators of Facebook's Presto) joins Hive, MySQL, Kafka and Elasticsearch data in one SQL query through connectors.`,
      section: "unbundling-databases",
    },
    {
      id: "application-code-as-derivation",
      term: "Application code as a derivation function",
      def: `Viewing application logic (full-text tokenization, feature extraction, cache rendering) as functions that derive one dataset from another, run by stream processors that subscribe to changes, the way a spreadsheet recomputes dependent cells.`,
      problem: `Databases run custom code poorly and rarely let apps subscribe to changes, so apps poll and hand-maintain derived data.`,
      why: `Some derivation functions are generic (a secondary index just picks a field), and databases ship them. Most are application-specific (language-aware tokenizers, feature extraction, rendering a page) and need custom code, which databases host poorly: deployment, versioning, dependencies and scaling all fight the database. Running that code in stream processors next to the log gives the spreadsheet property: change an input and every dependent result updates, but durably, with fault tolerance, across many machines. It needs ordered input and effectively-once processing, because losing a single message leaves a derived dataset permanently wrong.`,
      ex: `VisiCalc (1979) recomputed dependent cells automatically. The data-system versions: a Kafka Streams app keeping a state store of rendered product pages (backed by a changelog topic), a ksqlDB materialized table, a Flink job computing fraud features from payments, a scheduled job retraining a model from click logs.`,
      section: "unbundling-databases",
    },
    {
      id: "dataflow-vs-rpc",
      term: "Subscribing to streams instead of RPC",
      def: `Instead of synchronously calling another service for data on every request (e.g., the current exchange rate), subscribe to its stream of changes and keep a local copy; the request becomes a local lookup (a stream-table join).`,
      problem: `Synchronous service-to-service calls add latency to every request and make one service's outage another's outage.`,
      why: `The local lookup is faster, survives the upstream's outage, and puts load on the upstream in proportion to how often its data changes rather than how often it is read. Paraphrasing the book: the fastest and most reliable network request is the one you don't make. The costs: the copy lags (record which version you used), a new instance must bootstrap (snapshot plus stream), the stream's schema becomes a public contract, and the join depends on time: reprocessing old purchases must use the rate in force at purchase time (a time-dependent <a href="#/ch11/learn/stream-joins">stream-table join</a>), not today's.`,
      ex: `The book's exchange-rate example: a checkout service subscribes to rate updates and keeps the current rate per currency pair in a local table instead of calling the rates service on every purchase. The same pattern in Kafka Streams: a GlobalKTable built from a compacted topic of catalog prices, joined with the order stream.`,
      section: "unbundling-databases",
    },

    // ---- write-path-read-path ----
    {
      id: "write-path-read-path",
      term: "Write path and read path",
      def: `The write path is the eager work done whenever data is written (updating indexes, caches, materialized views); the read path is the lazy work done when someone queries. Derived data is where they meet; indexes, caches and materialized views move that boundary.`,
      problem: `Teams tune caches and indexes ad hoc without seeing that each one trades work per write against work per read, and that precomputed data is only as fresh as its update pipeline.`,
      why: `The spectrum: no index (writes are trivial and every query scans everything, like grep); an index (some work per write, a few lookups per read); a cache of popular results (common queries precomputed); precomputing the answer to every possible query (reads are a single lookup, but the space of queries is effectively infinite, so writes become impossible). Like eager versus lazy evaluation, the right point depends on the read/write ratio and the distribution of queries, and anything precomputed is only as fresh as the pipeline that maintains it.`,
      ex: `Search: indexing a document tokenizes it and updates the inverted index (write path); a query looks up each term, intersects the postings and ranks the results (read path). Elasticsearch's refresh, about once a second by default, is the tunable point where one meets the other. Twitter's home timeline (<a href="#/ch1/learn/describing-load">Chapter 1</a>) is the same choice: fan-out on write for most accounts, merge on read for accounts with huge follower counts.`,
      section: "write-path-read-path",
    },
    {
      id: "pushing-state-to-clients",
      term: "Pushing state changes to clients",
      def: `Extending the write path to the user's device: servers push changes over WebSockets or server-sent events, clients keep local state (often offline-capable), and a reconnecting client catches up from the last offset it saw.`,
      problem: `Request/response gives users a snapshot that silently goes stale until they reload.`,
      why: `The state on a device is a cache of state on the server, and the pixels on screen are a materialized view of the client's model. Pushing changes keeps both fresh without polling, and resuming from an offset turns "reload the page" into ordinary log consumption. The barrier is that request/response is built into databases, client libraries, frameworks and protocols, and few datastores offer subscribing to changes as a first-class operation.`,
      ex: `Server-sent events (EventSource) and WebSockets carry updates to open pages; client frameworks such as Elm and React with Redux already manage UI state as a stream of events. Cloud Firestore snapshot listeners push changes to query results, with an offline cache that is on by default on Android and Apple platforms and opt-in on the web. Kleppmann's "Local-first software" essay (Ink &amp; Switch, 2019, with co-authors) takes the idea further with CRDT-based sync.`,
      section: "write-path-read-path",
    },
    {
      id: "reads-as-events",
      term: "Reads as events",
      def: `Sending read requests through the same stream processor as writes, so a read is a stream-table join and can be logged; useful for recording what state a user saw before acting (causal dependencies) and for queries spanning many partitions.`,
      problem: `When reads are invisible transient requests, you can't reconstruct what a user knew when they made a decision, and multi-partition queries need ad-hoc fan-out code.`,
      why: `A read routed through the stream processor is a join between a stream of queries and the stored state, so it can be recorded like any other event. That captures exactly what each user saw before acting (the basis for tracking causal dependencies), and it lets the processor's partitioning and message routing answer queries that need data from many partitions. The cost is storage and I/O for every read, so it is a trade-off; for a read served by one partition, routing it through a processor buys nothing.`,
      ex: `Storm's distributed RPC was used to compute the reach of a URL on Twitter (the number of distinct people who saw it: the union of the followers of everyone who tweeted it) across partitions. Fraud scoring joins one purchase with the reputations of its IP address, email address, billing address and shipping address, each stored in its own partition.`,
      section: "write-path-read-path",
    },

    // ---- end-to-end-argument ----
    {
      id: "duplicate-suppression",
      term: "Duplicate suppression (and its scope)",
      def: `Detecting and discarding repeated deliveries of the same operation. TCP deduplicates within one connection, a transaction is atomic per attempt, Kafka exactly-once covers Kafka-to-Kafka processing; only an ID generated at the origin and checked at the final effect deduplicates end to end.`,
      problem: `Retries are unavoidable under faults, and each layer's deduplication stops at its own boundary, so retries from outside it (a reconnecting client, a user double-click) still duplicate effects.`,
      why: `Lower-layer deduplication is still worth having, because fewer duplicates reach your application, but each mechanism covers only its own scope. TCP discards retransmitted copies of the same bytes within one connection, while a resubmitted HTTP request is new data to TCP, even on the same keep-alive connection. So list every retry path in the system (client timeouts, user double-clicks, consumer restarts, producer retries) and check that some mechanism's scope covers each one; usually only an end-to-end ID does.`,
      ex: `SQS FIFO queues drop a repeated MessageDeduplicationId within a 5-minute interval; Kafka's idempotent producer drops duplicate batches within one producer session; Kafka transactions (0.11, KIP-98) make read-process-write within Kafka atomic. None of them stops a user who double-clicks "Pay" or a client that retries after a timeout.`,
      section: "end-to-end-argument",
    },
    {
      id: "idempotence-via-operation-ids",
      term: "Idempotence via operation IDs",
      def: `The client, where the operation originates, generates a unique ID (such as a UUID) <strong>once per logical operation</strong> and sends it with every retry. Where the effect is applied, the same transaction that performs the effect first inserts the ID into a table with a <strong>UNIQUE</strong> constraint, so a retry violates the constraint and aborts instead of applying twice. Store the original response with the ID so a retry gets the same answer.`,
      problem: `Retries after timeouts are unavoidable, and non-idempotent operations (debit $11) double-apply.`,
      why: `It is the foundational pattern for building reliable systems on top of at-least-once delivery. The check and the effect must commit together: a concurrent second INSERT of the same key waits for the first transaction to commit or abort and then fails or proceeds, so two duplicates can't both succeed, whereas check-then-insert in separate steps lets both pass. Generate the ID per user intent (for example when the payment form is rendered), not in the server's retry loop. A hash of the relevant form fields also works as an ID, but it merges two genuinely separate identical operations (paying Bob $11 twice on purpose). Pass the ID on to downstream side effects so they can deduplicate too; the requests table doubles as an event log.`,
      ex: `Stripe's <code>Idempotency-Key</code> header: Stripe saves the status code and body of the first request with a key and returns them for retries, and keys may be removed once they are at least 24 hours old. EC2's RunInstances takes a <code>ClientToken</code> so a retried launch does not start a second set of instances.`,
      section: "end-to-end-argument",
    },
    {
      id: "end-to-end-argument",
      term: "End-to-end argument",
      def: `If doing a function right (duplicate suppression, integrity checking, encryption) depends on knowledge that only the applications at the two ends have, the communication system cannot provide it alone; lower layers can offer partial versions, worth having only as performance optimizations (Saltzer, Reed &amp; Clark, ACM Transactions on Computer Systems, 1984; an earlier version appeared in 1981).`,
      problem: `Each layer's guarantee (TCP dedup, transactions, broker exactly-once) stops at its boundary, so failures and retries from outside it still corrupt data.`,
      why: `Applied to data systems: using a database with strong guarantees, such as serializable transactions, does not by itself make an application free of data loss or corruption; the application needs end-to-end measures such as request IDs and integrity checks. Lower-layer features remain valuable because they make higher-level failures rarer, but they are not sufficient for correctness. The book wishes for abstractions that package these end-to-end mechanisms so that every application doesn't have to reimplement them.`,
      ex: `The paper's careful file transfer: network checksums don't catch a corrupted disk at the sender or a bug in the copy program, so the endpoints must compare a checksum of the whole file. Likewise Ethernet and TCP checksums miss software bugs at either end; WiFi encryption protects one radio hop and TLS the network path, but only end-to-end encryption protects against a compromised server. And Kafka's exactly-once does not make an email-sending consumer idempotent.`,
      section: "end-to-end-argument",
    },

    // ---- enforcing-constraints ----
    {
      id: "uniqueness-requires-consensus",
      term: "Uniqueness constraints require consensus",
      def: `Rejecting a second concurrent claim to the same value needs a single decision point per value (a leader or a log partition), which is consensus; asynchronous multi-leader replication can't enforce it. Partitioning by the constrained value scales it.`,
      problem: `In a distributed, replicated system two nodes can each accept the same username or seat if they decide independently.`,
      why: `If a violating write must be rejected immediately, synchronous coordination is unavoidable: some single authority has to decide which claim came first. Partitioning by the constrained value (username hash, seat ID) scales this, because only claims on the same value need the same decision point. With automatic leader failover, choosing that leader is itself consensus (<a href="#/ch9/learn/consensus">Chapter 9</a>). CRDTs can't help here: they merge concurrent writes, they cannot reject one.`,
      ex: `Two regions with asynchronous multi-leader replication both accept "alice" within 50 ms and discover the conflict only when replication catches up. The alternatives are to route every claim for a username to one log partition processed by a single thread, or to use a linearizable conditional write in a consensus-backed store (<a href="#/ch9/interview/q-unique-usernames">Chapter 9's username question</a> compares options such as Spanner and Cassandra's lightweight transactions).`,
      section: "enforcing-constraints",
    },
    {
      id: "enforcing-constraints-on-streams",
      term: "Enforcing constraints on streams",
      def: `Route every request that could conflict to the same log partition (partition by username, seat or account). The log gives that partition a total order, which is total order broadcast and so equivalent to consensus. A single-threaded processor consumes the partition in order, checks its local state (is this name taken?) and emits an accept or reject event correlated by request ID; the client <strong>waits for that event</strong> before telling the user. Operations that span several partitions are split into request-ID-tagged instructions that each partition applies idempotently (see multi-partition request processing).`,
      problem: `Distributed systems can't use a single database's UNIQUE constraint or transaction, and 2PC across partitions is slow and fragile.`,
      why: `You don't need distributed transactions for many constraints if you can partition the work. This is actual serial execution (<a href="#/ch7/learn/serial-execution">Chapter 7</a>) applied to a log and scaled out by partitioning. Details that matter: normalize the value before hashing ("Alice" and "alice"), checkpoint the processor's state atomically with its input offset so a restart neither forgets nor re-decides a claim, and remember that partitions on their own give order, not transactions: the constraint holds only because one consumer applies a deterministic check in that order and the client waits for its decision.`,
      ex: `Username registration: claims keyed by the lowercased username go to a <code>username-claims</code> topic; a Kafka Streams or Flink job keeps the set of taken names in a state store and writes "accepted" or "rejected" to an outcome topic. The same shape works for seats per event, stock per SKU or a wallet balance per user. LMAX ran its exchange's business logic on a single thread over an event-sourced in-memory model, reported at about 6 million orders per second in Martin Fowler's 2011 article.`,
      section: "enforcing-constraints",
    },
    {
      id: "multi-partition-request-processing",
      term: "Multi-partition request processing",
      def: `Executing an operation that touches several partitions (e.g., a transfer) by appending it once to a log, deterministically splitting it into per-partition instructions tagged with the request ID, and having each partition apply them idempotently, with no atomic commit across partitions.`,
      problem: `Two-phase commit across partitions reintroduces coordinator blocking, locking and coupling.`,
      why: `The single append to the request log is the commit point; everything after it is derived deterministically and deduplicated by request ID, so partitions never coordinate synchronously and recovering from a crash is just replay. What you give up: a reader can briefly see the debit without the credit, money that is late rather than lost. 2PC hides that intermediate state behind locks at the cost of coordination; here it is visible for a moment but can never become permanent. To prevent overdrafts, validate in a processor partitioned by the payer's account before the request enters the log.`,
      ex: `Transfer r-91 moves $50 from account A to account B. (1) r-91 is appended to the request log. (2) A splitter emits "debit A $50 (r-91)" to A's partition and "credit B $50 (r-91)" to B's. (3) Each account processor applies instructions in order, recording applied request IDs atomically with the balance, and drops repeats. If the splitter crashes after emitting the debit, it restarts from its checkpoint and re-emits both instructions, and A's processor ignores the second debit. The Calvin database (SIGMOD 2012) uses a related idea: agree on a log of transactions, then execute it deterministically on each partition.`,
      section: "enforcing-constraints",
    },

    // ---- timeliness-and-integrity ----
    {
      id: "timeliness-vs-integrity",
      term: "Timeliness vs integrity",
      def: `Two different properties that the word "consistency" lumps together. <strong>Timeliness</strong>: users observe the system in an up-to-date state; a violation (a stale read) heals if you wait and try again. <strong>Integrity</strong>: absence of corruption, meaning no lost, duplicated, contradictory or invented data, and every derived dataset is an accurate derivation of its source; a violation is permanent until someone detects and repairs it. Paraphrasing the book: a timeliness violation is eventual consistency, an integrity violation is perpetual inconsistency.`,
      problem: `Calling every anomaly an "inconsistency" leads teams to over-coordinate or to dismiss corruption as eventual consistency.`,
      why: `They are not two settings of one knob. ACID transactions bundle them (linearizable reads plus atomic commit), so the difference rarely mattered; asynchronous dataflow separates them, giving up guaranteed timeliness while keeping integrity central through effectively-once processing. In most applications integrity matters far more: stale is annoying, corrupt can be catastrophic. So protect integrity everywhere, and buy timeliness (synchronous coordination, or waiting for a consumer to acknowledge a write) only where the user really needs the latest state now.`,
      ex: `A card purchase from the last 24 hours missing from your statement is normal (timeliness). A statement balance that doesn't equal the sum of its transactions, or a charge that vanishes, is an integrity failure. In a stream-based transfer, seeing account A debited before B is credited is a timeliness lag; a debit applied twice after a replay is an integrity violation.`,
      section: "timeliness-and-integrity",
    },
    {
      id: "loosely-interpreted-constraints",
      term: "Loosely interpreted constraints (apologies)",
      def: `Allowing a constraint to be violated temporarily and fixing it afterwards with a compensating action (apologize, refund, re-book), when the cost of the apology is acceptable: overbooked flights, back-ordered items, overdrafts, duplicate usernames.`,
      problem: `Enforcing every constraint synchronously before acknowledging a write requires coordination that costs latency and availability, even where the business already handles violations.`,
      why: `Ask two questions about each invariant: what does a user see if it is briefly violated, and what does the apology cost? If both are acceptable, write optimistically and check afterwards. Many businesses need the apology process anyway (warehouse stock gets damaged, passengers miss connections), so a synchronous check buys little. Pat Helland describes business as running on memories, guesses and apologies. A saga (<a href="#/ch9/learn/distributed-transactions-in-practice">Chapter 9</a>) is this pattern across services: local transactions plus compensating actions, without isolation.`,
      ex: `Airlines overbook on purpose and compensate passengers who are denied boarding (US DOT rules set minimum compensation); retailers back-order or refund oversold items; banks allow overdrafts and charge a fee. Amazon's Dynamo shopping cart always accepts "add to cart" and merges divergent versions; the 2007 paper notes that a deleted item can reappear after a merge, a consequence accepted in exchange for never rejecting a customer's write.`,
      section: "timeliness-and-integrity",
    },
    {
      id: "coordination-avoidance",
      term: "Coordination-avoiding data systems",
      def: `Systems that preserve integrity on derived data without atomic commit, linearizability or synchronous cross-partition coordination, and that use loose constraints where acceptable, so they can run multi-leader across datacenters with good performance and availability.`,
      problem: `Synchronous coordination everywhere limits throughput, latency and availability, especially across regions.`,
      why: `Coordination is a cost to minimize, not something to abolish: synchronous coordination reduces how many apologies you have to make but costs latency and availability, so look for the sweet spot. Serializable transactions remain useful at small scope (inside one partition or one service's database); heterogeneous XA transactions are not needed. Bailis et al.'s <strong>invariant confluence</strong> gives a test: if any two valid states that diverged from a common valid state always merge into a valid state, the invariant can be kept without coordination.`,
      ex: `"Coordination Avoidance in Database Systems" (Bailis et al., PVLDB vol. 8, 2014; presented at VLDB 2015): foreign keys under inserts and a lower bound on a counter that is only incremented are invariant-confluent; gap-free sequential IDs, or a balance kept non-negative under concurrent withdrawals, are not. A multi-region system can accept writes in every region and replicate asynchronously, coordinating only for those few invariants.`,
      section: "timeliness-and-integrity",
    },

    // ---- trust-but-verify ----
    {
      id: "trust-but-verify",
      term: "Trust, but verify (auditability)",
      def: `Treating the system model (fsync'd data survives, memory holds what was written, the CPU computes correctly, the database enforces its constraints, our code is right) as usually true rather than always true, and checking it continually and end to end: read data back, reconcile derived data against its source (counts, sums, invariants), scrub replicas, and restore backups regularly.`,
      problem: `Hardware, databases and application code all occasionally violate their assumed guarantees, and silent corruption spreads to replicas, views and backups.`,
      why: `Rare events happen daily at scale, and without checks corruption is silent until months later. Large storage systems such as HDFS and Amazon S3 already distrust disks: they continually read data back, compare replicas and re-replicate. Immutable events and deterministic derivations make such auditing possible, and Merkle trees add tamper evidence. End-to-end integrity checks work like automated tests: they reduce fear of change and let you move faster. The book warns that as systems with weaker guarantees spread without an auditing culture, more problems will go unnoticed.`,
      ex: `GitLab, January 2017: after an engineer accidentally deleted the primary database's data directory, none of its five backup and replication mechanisms turned out to be working as assumed, and it restored from an LVM snapshot about six hours old. Jepsen's 2020 analysis found that PostgreSQL 12.3's SERIALIZABLE level allowed G2-item anomalies, fixed in 12.4. Accountants have reconciled ledgers for centuries for the same reason.`,
      section: "trust-but-verify",
    },
    {
      id: "designing-for-auditability",
      term: "Designing for auditability",
      def: `Structuring a system so its correctness can be checked: immutable input events, deterministic derivations that can be rerun, redundant derivations to compare, and periodic end-to-end reconciliation of derived data against its source.`,
      problem: `When transactions mutate state in place, it's hard to tell afterwards what happened and why, and silent corruption goes undetected.`,
      why: `Event-based systems give provenance: user input is an immutable event and every state update is derived from it deterministically, so you can rerun a derivation and get the same result, explain why a value is what it is, and run a second, independent derivation in parallel to compare. Explicit dataflow also makes debugging easier, because a wrong number can be traced back to the events and code version that produced it.`,
      ex: `A ledger whose balances are derived from immutable transfer events can be audited by checking that debits equal credits and recomputing any account from its events; a revenue table can be recomputed for one day with independent code and diffed. Contrast an <code>UPDATE</code> that overwrites a balance in place and leaves no record of why it changed.`,
      section: "trust-but-verify",
    },
    {
      id: "cryptographic-auditing",
      term: "Cryptographic auditing (Merkle trees, transparency logs)",
      def: `Using hash chains and Merkle trees so that any change to recorded history changes a root hash, enabling efficient proofs that a record is included and that a log was only appended to; used by Certificate Transparency and Git, and by blockchains at much higher cost.`,
      problem: `Without tamper evidence you must trust whoever operates a log not to rewrite history.`,
      why: `Publishing or gossiping root hashes lets outsiders detect rewriting, and inclusion and consistency proofs are logarithmic in the size of the log, so auditors don't need a full copy. The book is cautious about blockchains: they add Byzantine-fault-tolerant consensus (Chapter 8) at a high cost in throughput, and proof-of-work wastes a lot of energy. It expects Merkle trees and similar integrity-checking techniques to spread into ordinary data systems.`,
      ex: `Certificate Transparency (RFC 6962, 2013) records publicly trusted TLS certificates in append-only Merkle-tree logs that anyone can audit, and Chrome requires proof of logging for publicly trusted certificates issued after April 2018 (enforced from Chrome 68, July 2018). Git's object model is a Merkle DAG: a commit's hash covers the whole history before it.`,
      section: "trust-but-verify",
    },

    // ---- predictive-analytics ----
    {
      id: "predictive-analytics",
      term: "Predictive analytics about people",
      def: `Using data to predict an individual's outcome (will they reoffend, repay a loan, make costly insurance claims, do well in a job?) and acting on the prediction automatically. Unlike a weather forecast, these predictions directly shape people's lives, and the models extrapolate from the past, including its discrimination.`,
      problem: `Organizations wanted cheaper, more consistent decisions about people, and assumed data-driven means objective.`,
      why: `Organizations err on the side of caution because a wrong "yes" is visible and a wrong "no" is not, so people are wrongly excluded. When the same data and models are reused across companies, one flag can shut a person out of jobs, air travel, insurance, rented housing and financial services at once, with little recourse; the book adopts the term "algorithmic prison" for this. Removing protected attributes is not enough, because features like postal code or IP address act as proxies for race. "Redlining by algorithm" is a fair analogy, and proxies are the mechanism. A future better than the past takes moral imagination, which only people can supply.`,
      ex: `ProPublica's 2016 analysis of the COMPAS recidivism score found that Black defendants who did not reoffend were labelled higher risk about 45% of the time, against about 23% for white defendants; the vendor, Northpointe, disputed the analysis, arguing the score was equally well calibrated for both groups. Obermeyer et al. (<em>Science</em>, 2019) found that a widely used US healthcare algorithm, which used past spending as a proxy for medical need, underestimated the needs of Black patients.`,
      section: "predictive-analytics",
    },
    {
      id: "algorithmic-accountability",
      term: "Algorithmic accountability",
      def: `Being able to explain, contest and correct automated decisions about people, and to assign responsibility when they're wrong, including transparency about data and models and a path to appeal.`,
      problem: `Automated decisions can exclude people systematically (an 'algorithmic prison') with no one accountable and no recourse.`,
      why: `A human decision can be questioned and appealed; with an algorithm it is unclear who is responsible: the scoring agency, the data broker, the model vendor or the engineer. A traditional credit score asks how you behaved in the past, and in many countries the law lets you see and correct the report behind it; a model built on many signals asks how people like you behaved, which amounts to stereotyping. Statistics can be right on average and wrong about an individual. Accountability means explanations, data people can inspect and correct, a human appeal path, and monitoring for mistakes.`,
      ex: `US lenders must give specific reasons for an adverse action (ECOA and Regulation B). GDPR Article 22 (applicable since May 2018) restricts decisions based solely on automated processing that significantly affect people and requires safeguards such as human intervention; the EU AI Act (in force since August 2024) classes credit scoring and hiring systems as high-risk. In the Dutch childcare-benefits scandal, thousands of families were wrongly accused of fraud, partly through a risk model that used nationality as a factor; the government resigned over it in January 2021.`,
      section: "predictive-analytics",
    },
    {
      id: "feedback-loops-in-data-driven-decisions",
      term: "Feedback loops in data-driven decisions",
      def: `Automated decisions change the data the model will later learn from, so a model can fulfil its own predictions. The book's example: a person in good standing suffers a misfortune beyond their control and misses payments, their credit score drops, employers who check credit scores turn them down, unemployment pushes them toward poverty, and their score drops further. Related effects: <strong>selective labels</strong> (a denied applicant never gets the chance to repay, so the data can never show that the denial was wrong) and recommendation <strong>echo chambers</strong>.`,
      problem: `Models are retrained on data produced by their own decisions.`,
      why: `Systems can reinforce their own biases, which calls for deliberate audits, counterfactual reasoning and humility about model outputs. Systems thinking helps: analyze the whole loop, including the people reacting to it, to see whether it amplifies existing differences or counteracts them. Engineering responses: a small randomized exploration or holdout slice to observe counterfactual outcomes, logged scores for offline evaluation, and outcome monitoring by group. The outcome test (approved members of one group repay more often than approved members of another) suggests a stricter bar for the first group, but it is a warning sign, not proof, because of infra-marginality.`,
      ex: `A fraud model retrained monthly sees outcomes only for the transactions it allowed, so customers it blocks can never prove it wrong. Recommenders that optimize for engagement narrow what people see, and the book notes the part echo chambers played in election campaigns. The feedback-loop viz is a toy model of a lender: equal true ability plus a biased starting score produce a lasting approval gap that the lender's own repayment data cannot reveal.`,
      section: "predictive-analytics",
    },

    // ---- privacy-and-tracking ----
    {
      id: "surveillance-capitalism-privacy",
      term: "Surveillance and privacy",
      def: `When a system stores only what users explicitly enter, it serves them; when it tracks their behaviour as a side effect and the business model depends on that data (advertising), the advertisers become the customers and the users' interests come second. The book's thought experiment: replace "data" with "surveillance" in everyday phrases ("real-time surveillance streams", "our surveillance warehouse") and see how they sound. <strong>Privacy</strong> is not secrecy but the freedom to choose what to reveal to whom, in which context; tracking moves that decision from the person to the company. The term <em>surveillance capitalism</em> is Shoshana Zuboff's (from a 2015 paper, popularized by her 2019 book); DDIA's own framing is simply surveillance.`,
      problem: `Business models based on behavioural advertising turned incidental data into the product.`,
      why: `Behavioural data is called an asset, but it is also a liability and a source of power: it can leak, be stolen, be sold by brokers, or be demanded by a future government with different values. Companies keep their inferences secret because revealing them would feel creepy, so people cannot know who sees what about them. And data about one person reveals others who never agreed: contacts, relatives, people nearby. Bruce Schneier has compared data to the pollution problem of the information age, which the book echoes with its Industrial Revolution analogy: growth first, regulation decades later.`,
      ex: `The 2017 Equifax breach exposed personal data, including Social Security numbers, of about 147 million people who never chose to give it to Equifax. Data on up to 87 million Facebook users was harvested through a personality-quiz app, mostly from friends of the people who installed it; the FTC fined Facebook $5 billion in 2019. Strava's public heatmap of aggregated workouts revealed the layouts of military bases in January 2018.`,
      section: "privacy-and-tracking",
    },
    {
      id: "consent-and-choice",
      term: "Consent and freedom of choice",
      def: `Meaningful consent requires understanding what is collected and how it's used, and a real alternative to declining; opaque policies, one-sided terms and network effects make most consent to tracking nominal.`,
      problem: `Services collect behavioural data under 'consent' that users can't evaluate or practically refuse.`,
      why: `Users cannot consent to what they don't understand: privacy policies obscure more than they reveal, the service sets the terms instead of negotiating them, and data flows one way rather than as part of a reciprocal relationship. Declining is not a real choice for services that have become prerequisites for social and professional life (network effects), so being able to opt out is a privilege of people with enough time and knowledge. And one person's consent can expose other people's data.`,
      ex: `In the Cambridge Analytica case, the people who installed the quiz app agreed to share data, but most of the affected profiles belonged to their friends, who never saw a consent screen. Apple's App Tracking Transparency (iOS 14.5, April 2021) made cross-app tracking require each user's explicit opt-in per app.`,
      section: "privacy-and-tracking",
    },
    {
      id: "data-minimization",
      term: "Data minimization and purpose limitation",
      def: `Collecting only the data needed for a specified, explicit purpose and deleting it when that purpose is served; codified in the 1995 EU Data Protection Directive and in GDPR.`,
      problem: `Data kept 'because it might be useful' becomes a liability: it can leak, be re-identified, be repurposed or be demanded by a future government.`,
      why: `It is in direct tension with the big-data habit of collecting everything and finding uses later, and with this chapter's own architecture: an immutable log kept forever is the opposite of storage limitation. So deletion has to be designed in: per-user encryption keys that are deleted on request (crypto-shredding), log compaction with tombstones, retention limits on raw logs and backups, and deletion events that reach every index, cache and warehouse (<a href="#/ch11/learn/state-and-immutability">Chapter 11</a>). "Anonymizing" is not a substitute: hashed IDs are pseudonyms, and sparse data re-identifies people.`,
      ex: `Latanya Sweeney found that ZIP code, birth date and sex single out most Americans (about 87% in her analysis of 1990 census data; Philippe Golle's 2006 re-estimate was about 63%). Four spatio-temporal points uniquely identified 95% of 1.5 million people in a mobile-phone dataset (de Montjoye et al., 2013), and AOL's 2006 "anonymized" search logs let <em>The New York Times</em> identify user No. 4417749. GDPR (applicable from 25 May 2018) codifies purpose limitation, data minimization, storage limitation and erasure, with fines of up to 4% of global annual turnover.`,
      section: "privacy-and-tracking",
    },
  ],

  cheatsheet: [
    // ---- data-integration ----
    {
      title: "Systems of record vs derived data",
      type: "table",
      headers: ["", "System of record", "Derived data"],
      rows: [
        ["Role", "Authoritative: each fact written once, usually normalized", "Redundant: a transformation of other data, often denormalized"],
        ["Examples", "OLTP tables (orders, accounts); an event-sourced log", "Search indexes, caches, materialized views, warehouse tables, ML models and features"],
        ["If lost or corrupted", "Restore from backup; otherwise the data is gone", "Throw it away and recompute it from the source"],
        ["Freshness", "Defines what \"now\" is", "Behind its source by the pipeline delay (timeliness)"],
        ["When copies disagree", "Wins by definition", "The derivation or pipeline has a bug (integrity)"],
        ["Could you rebuild it from something else?", "No", "Yes"],
      ],
      note: "The integration question: for each kind of data, where is it first written, and in what order do changes reach every derived view?",
    },
    {
      title: "Derived data vs distributed transactions",
      type: "table",
      headers: ["", "Distributed transactions (2PL + 2PC/XA)", "Log-based derived data"],
      rows: [
        ["Ordering of writes", "Locks (two-phase locking, Chapter 7)", "Position in the log"],
        ["Atomicity", "Atomic commit (2PC, Chapter 9)", "Deterministic retry + idempotent consumers (effectively-once)"],
        ["Timeliness", "Immediate: read your own writes everywhere", "Asynchronous: views lag; no cross-view read-your-writes by default"],
        ["Failure behaviour", "A slow participant or a crashed coordinator blocks or aborts everyone; in-doubt locks", "A failed consumer falls behind and catches up from its offset; others are unaffected"],
        ["Heterogeneous systems", "Every store must speak XA (lowest common denominator; many don't)", "Any system that can consume a log"],
        ["Coupling", "Tight: every participant must be up", "Loose, between systems and between teams"],
        ["Typical stack", "Java EE app server + XA datasources + JMS broker", "Postgres → Debezium → Kafka → Elasticsearch, Redis, warehouse"],
      ],
      note: "The book favours the log for integrating different systems and accepts the weaker timeliness; integrity comes from request IDs and deterministic derivations.",
    },
    {
      title: "Ordering across logs",
      type: "list",
      items: [
        "<strong>One log = one order</strong> for every consumer: lag delays events but never reorders them. The price is a single sequencer for all events.",
        "<strong>Kafka orders only within a partition</strong>; there is no order across partitions or topics.",
        "Across partitions, datacenters (a leader per region), microservices and offline clients there is <strong>no order for free</strong>. Deciding a total order is total order broadcast, equivalent to consensus (Chapter 9).",
        "Fix 1: <strong>co-partition</strong> causally related events (same topic, same key) when one key captures the dependency.",
        "Fix 2: <strong>explicit causal metadata</strong>: the later event names the version or event ID the user saw, and the consumer waits until it has applied that (with a timeout and a safe default).",
        "Not a fix: <strong>wall-clock timestamps</strong> (skew, Chapter 8; they say nothing about events still in flight) or a fixed sleep.",
        "<strong>Lamport timestamps</strong> work only if consumers wait until every input has passed the timestamp, so everything waits for the slowest input.",
        "<strong>CRDTs</strong> converge state but can't recall a side effect such as a sent notification.",
      ],
    },

    // ---- reprocessing ----
    {
      title: "Lambda vs Kappa architecture",
      type: "table",
      headers: ["", "Lambda", "Kappa"],
      rows: [
        ["Proposed", "Nathan Marz, 2011 (\"How to beat the CAP theorem\"); book <em>Big Data</em>, 2015", "Jay Kreps, 2014 (\"Questioning the Lambda Architecture\")"],
        ["Paths", "Batch layer + speed layer + serving layer (two codebases)", "One stream job (one codebase)"],
        ["Source of truth", "Immutable, ever-growing master dataset", "Retained log (long retention, tiered storage, or an archive)"],
        ["Latency", "Batch: hours; speed layer covers recent data with low latency (approximation optional)", "One job; replay faster than real time"],
        ["Merging outputs", "Queries merge batch and real-time views (hard for joins and sessions)", "None: one output table per job version"],
        ["Fixing a bug", "Fix both codebases + rerun the batch over history", "Start v2 from offset 0 into a new table, switch reads, delete v1"],
        ["Precondition", "Immutable master dataset", "Log retains full history; event-time windows; deterministic code"],
        ["Operational cost", "Two systems to run, tune and debug; logic drifts between them", "One system, plus replay capacity and long retention"],
        ["Originally built with", "Hadoop (batch) + Storm (speed)", "Kafka + Samza; today Flink, Kafka Streams, Spark Structured Streaming, Beam"],
      ],
      note: "DDIA's position: unify batch and stream in one system (the idea behind Kappa). Batch engines didn't disappear; the goal is one definition of each derivation.",
    },
    {
      title: "Unifying batch and stream: requirements",
      type: "list",
      items: [
        "<strong>Replay</strong> historical events through the same engine that handles live events (a log-based broker, or the stream engine reading from HDFS or object storage).",
        "<strong>Exactly-once (effectively-once)</strong> semantics: output as if no faults had occurred (Chapter 11).",
        "<strong>Event-time windows</strong>: processing time is meaningless when replaying a year of events.",
        "Plus <strong>determinism</strong>: no wall-clock reads and no calls to mutable services inside the derivation (put those inputs into events); side effects off during replay.",
        "Engines: Apache Beam (from the Dataflow Model, VLDB 2015) on Flink, Spark or Google Cloud Dataflow; Flink's batch execution mode (1.12, 2020); Spark Structured Streaming (2.0 in 2016; production-ready in 2.2, 2017).",
      ],
    },
    {
      title: "Gradual migration: the third rail",
      type: "list",
      items: [
        "Derive v2 from the retained log into a <strong>new</strong> store, next to v1.",
        "Let it catch up, then diff v1 against v2 on the same inputs.",
        "Shift reads gradually (5% → 50% → 100%, by dashboard or user cohort).",
        "Keep v1 running for rollback: every step is reversible.",
        "Retire v1 when confident; switch with an atomic pointer change (e.g., an Elasticsearch index alias).",
        "History: the GWR's 7 ft &frac14; in broad gauge was converted using mixed-gauge (three-rail) track; the last lines changed in May 1892.",
      ],
    },

    // ---- unbundling-databases ----
    {
      title: "Inside one database vs unbundled",
      type: "table",
      headers: ["Inside one database", "Unbundled equivalent", "Examples"],
      rows: [
        ["Replication log / WAL", "Durable, partitioned, retained log", "Kafka, Kinesis, Pulsar"],
        ["Getting changes out", "CDC or event sourcing", "Debezium, DynamoDB Streams, MongoDB change streams"],
        ["Secondary or full-text index", "Specialized store fed by the log", "Elasticsearch, OpenSearch"],
        ["Materialized view", "Stream processor writing an output table", "Flink, Kafka Streams, ksqlDB, Materialize"],
        ["Trigger / stored procedure", "Consumer running application code", "Kafka Streams app, Flink job, a function triggered by a stream"],
        ["CREATE INDEX (snapshot + backlog + follow)", "Snapshot at a log position, then follow the log", "Debezium snapshots, Netflix DBLog"],
        ["Crash recovery from the log", "Replay from a committed offset or checkpoint", "Consumer offsets, Flink checkpoints"],
        ["One query interface over everything", "Federation (unifies reads only)", "Trino, PostgreSQL foreign data wrappers"],
      ],
    },
    {
      title: "Federated vs unbundled vs one integrated database",
      type: "table",
      headers: ["", "Federated", "Unbundled", "Single integrated database"],
      rows: [
        ["Unifies", "Reads: one query interface over many stores", "Writes: every change reaches every store through a log", "Both, inside one product"],
        ["Mechanism", "Connectors and query pushdown", "Log + CDC + ordered, idempotent consumers", "Shared storage engine, WAL, transaction manager"],
        ["Consistency across stores", "Not addressed", "Views converge; they lag but don't diverge", "Transactional and immediate"],
        ["Strength", "Ad-hoc joins and exploration across systems", "Best tool per access pattern; faults stay local; teams decouple", "Simplest; predictable performance for its intended workload"],
        ["Weakness", "Limited by the slowest source; no write sync", "Many moving parts; log schemas become contracts; debugging spans systems", "No single product serves every access pattern well"],
        ["Examples", "Trino, postgres_fdw", "Postgres → Debezium → Kafka → Elasticsearch, Redis, warehouse", "PostgreSQL with full-text search and materialized views"],
      ],
      note: "If one database does everything you need, use it; unbundle only when no single product fits.",
    },
    {
      title: "The unbundled database pattern",
      type: "list",
      items: [
        "System of record: an OLTP database whose changes leave through CDC, or the log itself (event sourcing).",
        "A durable, retained log (Kafka) carries every change in order, per partition (key by entity ID).",
        "Search index, cache, warehouse and ML features are derived views maintained by consumers.",
        "Consumers are ordered, deterministic and idempotent; any view can be rebuilt from snapshot + log.",
        "Adding a view = adding a consumer: bootstrap from a snapshot at a log position, then follow the log.",
        "Read-your-writes across views is not automatic: read from the source, or wait until the consumer has passed your write's offset.",
      ],
    },
    {
      title: "Synchronous RPC vs subscribing to a change stream",
      type: "table",
      headers: ["", "RPC on every request", "Subscribe + local copy"],
      rows: [
        ["Latency added", "A network round trip per request", "A local lookup"],
        ["Availability", "Upstream down → your requests fail (or fall back)", "Upstream down → keep serving the last known state"],
        ["Upstream load scales with", "Your read rate", "The upstream's change rate"],
        ["Freshness", "As fresh as the upstream (whose caches and replicas also lag)", "Behind by the stream delay; record which version you used"],
        ["Bootstrapping", "Nothing to do", "Snapshot + stream, or a compacted topic"],
        ["Reprocessing history", "Calls return today's value", "Join with versioned history (a time-dependent stream-table join)"],
        ["Use for", "Authoritative, must-be-current actions (reserve stock, authorize a card)", "Reference data read often and changed rarely (rates, prices, profiles)"],
      ],
    },

    // ---- write-path-read-path ----
    {
      title: "Write path vs read path",
      type: "list",
      items: [
        "<strong>Write path</strong>: eager work on every write (indexes, caches, materialized views). <strong>Read path</strong>: lazy work on every query. Derived data is where they meet.",
        "Spectrum: no index (grep: cheap writes, full scans) → index → cache popular results → precompute all possible queries (one-lookup reads, impossible writes) → push results to the client.",
        "More precomputation = cheaper reads and costlier writes; freshness depends on the pipeline.",
        "Choose by read/write ratio and query distribution: a page read 50,000 times a second and changed hourly → precompute; an open-ended ad-hoc query space → compute on read and cache the popular queries.",
        "Same trade-off as Twitter's home timeline (Chapter 1): fan-out on write vs merge on read.",
        "Push (SSE, WebSockets) extends the write path to the screen; clients resume from the last offset or sequence number they saw.",
        "Reads as events: route queries through the stream processor (a stream-table join) to log what users saw and to answer multi-partition queries (Storm DRPC's URL reach, fraud scores).",
      ],
    },

    // ---- end-to-end-argument ----
    {
      title: "Where dedup happens (and its scope)",
      type: "table",
      headers: ["Mechanism", "Suppresses", "Scope ends at"],
      rows: [
        ["TCP sequence numbers", "Retransmitted copies of the same bytes", "One connection: a resent request is new data, even on a keep-alive connection"],
        ["Database transaction", "Partial effects of one attempt (atomicity)", "One attempt: a retry after a lost COMMIT reply runs again"],
        ["Two-phase commit", "Disagreement between coordinator and participants", "The participants: not the end user's client"],
        ["Kafka idempotent producer", "Duplicate batches from producer retries", "One producer session (producer ID and epoch)"],
        ["Kafka transactions (EOS, 0.11, 2017)", "Duplicates in Kafka-to-Kafka read-process-write", "Kafka: external side effects (emails, HTTP calls) aren't covered"],
        ["Flink checkpoints + transactional or idempotent sinks", "Duplicate output after recovery", "Those sinks: calls to external services from operators aren't covered"],
        ["SQS FIFO deduplication ID", "Repeated sends with the same ID", "A 5-minute deduplication interval"],
        ["Stripe Idempotency-Key", "Retried API requests with the same key", "The key's retention (keys may be pruned after 24 h)"],
        ["Request ID from the client, checked with the effect", "Every retry of one logical operation", "End to end, for as long as the ID is kept"],
      ],
    },
    {
      title: "The request-ID pattern",
      type: "note",
      body: `<p>Generate the ID once per user intent on the client; check it in the <strong>same transaction</strong> as the effect.</p>
<pre><code>-- requests.request_id has a UNIQUE constraint
BEGIN;
INSERT INTO requests (request_id, payer, payee, amount)
     VALUES ('9b2f6c1e-...', 'alice', 'bob', 11.00);
UPDATE accounts SET balance = balance - 11.00 WHERE owner = 'alice';
UPDATE accounts SET balance = balance + 11.00 WHERE owner = 'bob';
COMMIT;</code></pre>
<p>A retry with the same ID fails the INSERT, so the transaction aborts instead of moving $22. A concurrent duplicate waits for the first transaction, then fails; check-then-insert in separate steps would let both through. Store the original response with the ID so retries get the same answer. A hash of the form fields works as an ID only if two separate, identical payments can't happen.</p>`,
    },

    // ---- enforcing-constraints ----
    {
      title: "Enforcing constraints without 2PC",
      type: "list",
      items: [
        "Uniqueness needs <strong>one decision point per value</strong> (consensus); asynchronous multi-leader replication can't enforce it, and CRDTs merge but can't reject.",
        "<strong>Partition by the constrained value</strong> (normalized username, seat ID, account ID).",
        "A <strong>single-threaded processor per partition</strong> decides in log order and emits accept or reject.",
        "The <strong>client waits</strong> for the outcome event matching its request ID before confirming.",
        "Checkpoint processor state <strong>atomically with the input offset</strong>.",
        "<strong>Multi-partition operations</strong>: one log append (the commit point), a deterministic split into request-ID-tagged instructions, idempotent apply in each partition. Readers may briefly see the debit without the credit.",
        "Overdrafts: validate in the payer's partition <strong>before</strong> the request enters the log.",
        "Use <strong>loose constraints + apologies</strong> where the apology is cheap.",
      ],
    },

    // ---- timeliness-and-integrity ----
    {
      title: "Timeliness vs integrity",
      type: "table",
      headers: ["", "Timeliness", "Integrity"],
      rows: [
        ["Definition", "Users observe an up-to-date state", "No corruption: nothing lost, duplicated, contradictory or invented; derived data matches its source"],
        ["A violation looks like", "A stale read, a pending item, a view a few seconds behind", "A wrong total, a double-applied debit, a vanished charge"],
        ["Heals by waiting?", "Yes (eventual consistency)", "No: permanent until detected and repaired (perpetual inconsistency)"],
        ["Example", "A search missing a product added a second ago; yesterday's card purchase not yet on the statement", "A statement balance that isn't the sum of its transactions"],
        ["How much it matters", "Annoying; sometimes must be bounded", "Usually severe: protect it everywhere"],
        ["Mechanisms", "Lag monitoring; read-your-writes waits (wait for the consumer to pass your offset); synchronous coordination where needed", "Request IDs end to end, idempotence, deterministic derivations, immutable events, reprocessing, audits"],
        ["In ACID transactions", "Usually bundled in (e.g., linearizable reads on one node)", "Bundled in (atomic commit)"],
        ["In asynchronous dataflow", "Not guaranteed unless you build it", "Central: effectively-once processing"],
      ],
    },
    {
      title: "Does this invariant need coordination?",
      type: "table",
      headers: ["Invariant", "If briefly violated, users see", "Cost of an apology", "Mechanism"],
      rows: [
        ["Unique username", "Two accounts with one name", "Awkward: ask one user to rename", "Usually coordinate per normalized name (log partition or conditional write)"],
        ["Assigned concert seat", "Two buyers holding tickets for one seat", "High: two people, one seat, at the venue", "Coordinate per seat or per event partition"],
        ["Merchandise stock ≥ 0", "An order for an item that's out of stock", "Low: back-order or refund (needed anyway for damaged stock)", "Loose: accept, reconcile asynchronously, apologize"],
        ["Prepaid wallet ≥ 0", "A negative balance", "Real money lost", "Validate in the payer's partition before accepting"],
        ["Order references an existing customer", "An orphaned order (only if customers are deleted concurrently)", "Low to medium", "None for inserts; order deletes in the same partition, or soft-delete"],
        ["Order total = sum of items", "A wrong total", "An integrity bug", "None: derive it deterministically from one order event"],
        ["Passengers ≤ seats on a flight", "An overbooked flight", "Compensation at the gate (US DOT minimums)", "Loose on purpose: overbook and compensate"],
      ],
      note: "Bailis et al.'s invariant confluence test: if any two valid states that diverged from a common valid state always merge into a valid state, the invariant needs no coordination.",
    },
    {
      title: "Integrity without distributed transactions: four ingredients",
      type: "list",
      items: [
        "Represent each write as <strong>one message</strong> that can be appended atomically (event-sourcing style).",
        "Derive every other state update from it with <strong>deterministic</strong> functions.",
        "Pass a <strong>client-generated request ID</strong> through every stage for end-to-end duplicate suppression.",
        "Keep messages <strong>immutable</strong>, and reprocess derived data to recover from bugs.",
      ],
    },
    {
      title: "Correctness principles",
      type: "list",
      items: [
        "<strong>Idempotence</strong>: retries must be safe; attach an ID generated once per logical operation.",
        "<strong>End-to-end</strong>: lower-layer guarantees are scoped optimizations; the endpoints must close the loop (IDs, checks).",
        "<strong>Integrity over timeliness</strong>: correct-but-stale beats fast-but-wrong; pay for timeliness only where users need it.",
        "<strong>Keep raw immutable events</strong> so any view can be recomputed.",
        "<strong>Deterministic derivations</strong>: put clock readings, exchange rates and random seeds into events, not into consumer code.",
        "<strong>Verify</strong> by reconciling derived data with its source and by restoring backups.",
        "<strong>Make staleness explicit</strong> in the UI or API (\"as of\", \"pending\") where results may lag.",
      ],
    },

    // ---- trust-but-verify ----
    {
      title: "Verification checklist (trust, but verify)",
      type: "list",
      items: [
        "Reconcile counts and sums per partition or per day between the source and every derived store, up to a watermark both have passed.",
        "Compare per-range hashes (Merkle style) to find differing ranges cheaply.",
        "Recompute a random sample of derived records from raw events with independent code, and diff.",
        "Alert on invariants: debits = credits, no negative stock, every derived row has a source.",
        "Scrub replicas and checksums in the background (as HDFS and S3 do).",
        "Restore backups into a test environment on a schedule; a backup you have never restored is a hope, not a backup.",
        "Track lag (timeliness) separately from mismatches (integrity).",
        "Tamper evidence where trust is low: hash chains, Merkle trees, transparency logs (Certificate Transparency, Git).",
      ],
    },

    // ---- predictive-analytics ----
    {
      title: "Bias and feedback loops: what to know",
      type: "list",
      items: [
        "Models <strong>extrapolate the past</strong>, including its discrimination.",
        "<strong>Proxies</strong>: postal code or IP address can predict race; dropping protected attributes isn't enough.",
        "<strong>Selective labels</strong>: denied applicants never produce outcomes, so the data can't show a denial was wrong; use exploration or holdout slices.",
        "<strong>Feedback loops</strong>: decisions shape the next training data (the credit-score-in-hiring spiral; recommendation echo chambers).",
        "<strong>Algorithmic prison</strong>: shared models and data can exclude a person everywhere at once, with little recourse.",
        "<strong>Fairness criteria conflict</strong> when base rates differ: calibration within groups vs equal error rates across them (Kleinberg et al. 2016; Chouldechova 2017).",
        "COMPAS (ProPublica, 2016): Black defendants who didn't reoffend were labelled higher risk about 45% of the time vs about 23% for white defendants; Northpointe disputed the analysis.",
        "<strong>Outcome test</strong>: if approved members of one group repay more often, that group may face a stricter bar; a warning sign, not proof (infra-marginality).",
        "\"Machine learning is like money laundering for bias\" is Maciej Ceglowski's line (2016 talk \"The Moral Economy of Tech\").",
      ],
    },
    {
      title: "Ethical checklist for data systems",
      type: "list",
      items: [
        "What data are we collecting, for what stated purpose, and did users meaningfully consent?",
        "Could our model encode bias? Have we measured error rates across demographic groups?",
        "Could a feature be a proxy for a protected trait (postal code, IP address)?",
        "What happens when predictions are wrong, and to whom?",
        "Can denied people ever prove the model wrong? (selective labels; exploration or holdout)",
        "Are we creating feedback loops that reinforce existing disadvantage?",
        "Is there an explanation and an appeal path, with a human who can override the decision?",
        "What's our plan if the data leaks?",
        "Can we honour deletion in every derived view and backup (crypto-shredding)?",
        "Would this still be OK under a different future government?",
        "Could we solve the problem with less data, coarser data or shorter retention?",
      ],
    },

    // ---- privacy-and-tracking ----
    {
      title: "Privacy engineering",
      type: "list",
      items: [
        "<strong>Pseudonymized ≠ anonymized</strong>: hashed IDs are linkable and can be brute-forced; GDPR still treats pseudonymized data as personal data.",
        "<strong>Quasi-identifiers</strong> re-identify: ZIP code + birth date + sex single out most Americans (Sweeney: about 87% on 1990 census data; Golle, 2006: about 63%).",
        "<strong>Sparse data is a fingerprint</strong>: Netflix Prize ratings matched to IMDb reviews (2008); four location points identified 95% of 1.5 million people (de Montjoye et al., 2013); AOL user No. 4417749 (2006).",
        "<strong>Aggregates can leak</strong>: Strava's 2018 heatmap revealed military bases.",
        "<strong>Minimize</strong>: collect for a stated purpose; coarsen time and location; set retention per field.",
        "<strong>Deletion in a log-centric system</strong>: per-user encryption keys deleted on request (crypto-shredding), compaction with tombstones, bounded retention for raw logs and backups, and deletion events that every index, cache and warehouse obeys.",
        "<strong>Differential privacy</strong> for released statistics: a provable bound on what one person's data reveals, paid for in accuracy and a privacy budget (used for 2020 US Census data products).",
        "<strong>Consent</strong> needs real understanding and a real alternative; one person's data reveals others'.",
      ],
    },

    // ---- reference ----
    {
      title: "Numbers and dates to remember",
      type: "list",
      items: [
        "Lambda: Marz, 2011. Kappa: Kreps, July 2014. \"Turning the database inside-out\": Kleppmann, Strange Loop 2014.",
        "End-to-end argument: Saltzer, Reed and Clark, ACM TOCS, 1984.",
        "Kafka exactly-once (KIP-98): 0.11, 2017. Kafka tiered storage (KIP-405): early access in 3.6, production-ready in 3.9.",
        "SQS FIFO deduplication interval: 5 minutes. Stripe idempotency keys: may be pruned once 24 hours old.",
        "Elasticsearch refresh: about once a second by default (since 7.0, shards idle for 30 s skip scheduled refreshes).",
        "Polling: 1 million clients every 5 s = 200,000 requests/s.",
        "GWR gauge conversion completed May 1892 (7 ft &frac14; in → standard 4 ft 8&frac12; in).",
        "LMAX: about 6 million orders/s on one business-logic thread (Fowler's 2011 article; a 2011 claim, not a benchmark).",
        "GitLab, January 2017: about 6 hours of database data lost; five backup and replication mechanisms not working as assumed.",
        "EU Data Protection Directive: 1995. GDPR: applicable 25 May 2018; fines up to 4% of global annual turnover.",
        "COMPAS (ProPublica, 2016): about 45% vs 23% of non-reoffenders labelled higher risk.",
      ],
    },
    {
      title: "Formulas and rules of thumb",
      type: "note",
      body: `<p><span class="formula">polling load = clients &divide; poll interval</span> 1,000,000 &divide; 5 s = 200,000 requests/s, almost all of them answering "no change".</p>
<p><span class="formula">precompute when R &times; (read cost saved) &gt; W &times; (extra write cost)</span> where R and W are reads and writes per second for that data.</p>
<p><span class="formula">staleness of a derived view &asymp; consumer lag (as time) + the store's own refresh delay</span></p>
<p><span class="formula">delay from waiting on Lamport timestamps &asymp; lag of the slowest input</span></p>
<p><span class="formula">ledger audit: &Sigma; debits = &Sigma; credits, per request ID, once both sides are applied</span></p>`,
    },
  ],

  interview: [
    // ---- data-integration ----
    {
      id: "q-sync-search-cache",
      q: "Design how a product catalog stored in PostgreSQL stays in sync with an Elasticsearch index and a Redis cache. Prices change often and search must never show a deleted product for long.",
      diff: "medium",
      section: "data-integration",
      a: `<p>The core decision: <strong>one system of record and one ordered change stream</strong>, with Elasticsearch and Redis as derived views of it, rather than the application writing to all three.</p>
<p><strong>Why not dual writes</strong>: if the request handler writes Postgres, then Elasticsearch, then Redis, two concurrent price updates can reach the stores in different orders (Postgres ends at $14, the index at $12, permanently), and a crash or timeout between writes leaves one store updated and another not. Nothing reports an error, and the next bulk-import script will forget one of the writes.</p>
<p><strong>Design</strong>:</p>
<ol><li><strong>Postgres is the system of record.</strong> Capture its changes from the WAL with CDC (Debezium on logical decoding), or write a transactional outbox row in the same transaction as the change if you want explicit domain events instead of raw rows.</li>
<li><strong>Publish to Kafka keyed by product ID</strong>, so every change to one product lands in one partition, in commit order. Kafka orders only within a partition, so the key is what preserves per-product order.</li>
<li><strong>Idempotent, version-aware consumers.</strong> The indexer upserts by product ID, using the source LSN or a row version as an external version, so a redelivered or older update is ignored. Deletes arrive as tombstones and become index deletes.</li>
<li><strong>Cache: invalidate rather than update</strong>: delete the key on change and let the next read repopulate it from Postgres, or update with a compare-and-set on the version. Blind sets from two consumers can race.</li>
<li><strong>Bootstrap and rebuild</strong> with snapshot plus stream: take a consistent snapshot at a known LSN, then apply changes from that LSN (Debezium snapshots, or DBLog-style chunked snapshots interleaved with the log). For a new mapping, build a fresh index in parallel and switch an alias atomically.</li></ol>
<p><strong>Staleness</strong>: consumer lag is now the staleness budget. Monitor it in seconds as an SLO (for example, deletes reflected in search within a few seconds at p99), and remember that Elasticsearch itself makes writes searchable at its next refresh, about once a second by default. If even that is too long for removals (a recalled product), filter search hits against the cache or database at read time. For an admin who must see their own edit, read that page from Postgres, or wait until the indexer has passed the write's LSN.</p>
<p><strong>Verification</strong>: run periodic reconciliation (counts and sampled checksums per product range between Postgres and the index), and keep a scripted full reindex, because a derived view you can't rebuild isn't really derived.</p>`,
      followups: [
        "How do you rebuild the index with a new mapping without downtime?",
        "What if two updates for the same product arrive out of order at the indexer?",
        "How would an admin see their own edit in search immediately? (see <a href=\"#/ch12/interview/q-read-your-writes-derived-views\">the read-your-writes question</a>)",
        "Cache: update or invalidate on change, and why?",
      ],
      pitfalls: [
        "Writing to Postgres then Elasticsearch in the request handler",
        "Partitioning the topic randomly so updates for one product reorder",
        "Non-idempotent consumers that break on redelivery",
        "No plan for full reindex or reconciliation",
      ],
    },
    {
      id: "q-cross-service-causality",
      q: "A notification consumer reads posts from one Kafka topic and friendship changes from another. Occasionally someone is notified about a post written after they were removed from the author's audience. Why does this happen, and how do you fix it?",
      diff: "hard",
      section: "data-integration",
      a: `<p><strong>Why it happens</strong>: Kafka orders messages only <strong>within a partition</strong>. Posts and friendship changes are in different topics, so nothing defines their relative order, and the consumer reads each at its own pace. When the friendships partition lags (a rebalance, a slow broker, a backlog), the post is joined with an old friend list that still contains the removed person, and the notification goes out. This is the book's unfriend example, and a sent notification can't be recalled.</p>
<p>A single global log would order everything, but it needs one sequencer for all events, which caps throughput and doesn't fit services that own separate logs: the limits of total ordering. The fixes, roughly from most to least preferred:</p>
<ul><li><strong>Co-locate causally related events</strong>: if the dependency stays within one entity, put both event types in one topic partitioned by the same key (the author's ID), so the consumer sees the unfriend before any later post. Works only when one key captures the dependency.</li>
<li><strong>Make the dependency explicit</strong>: the post carries the friend-list version (or the ID of the last friendship event) that the author's client had when posting. The notifier holds the post until its own copy of that author's friend list has reached that version, then filters recipients. Add a timeout with a safe default (drop or re-check), because the awaited event might never arrive.</li>
<li><strong>Re-check at action time</strong>: read the friendship from the source of truth just before sending. Simple, but it adds latency and coupling to every notification, and it is still racy unless that read is linearizable.</li>
<li><strong>Logical clocks plus waiting</strong>: Lamport timestamps give an order consistent with causality, but when the post arrives the consumer can't know that an earlier-timestamped unfriend is still in flight. It must wait until every input has advanced past the post's timestamp (a watermark per input), which delays everything by the slowest input.</li></ul>
<p><strong>What doesn't work</strong>: wall-clock timestamps (clock skew, Chapter 8, and a timestamp says nothing about events still in transit); a fixed sleep, which is just a bet on lag; and CRDTs or merging state later, which converge state but can't unsend a notification. Side effects need the dependency check <em>before</em> acting.</p>`,
      followups: [
        "What if the event you're waiting for never arrives?",
        "How would you choose partition keys to avoid the problem?",
        "Why don't Lamport timestamps alone solve it?",
      ],
      pitfalls: [
        "Assuming Kafka guarantees order across topics or partitions",
        "Sorting by wall-clock timestamps",
        "Adding a fixed sleep before acting",
        "Proposing a single global log without discussing its throughput limit",
      ],
    },
    {
      id: "q08",
      q: "Tie it all together: what's Kleppmann's big-picture vision for building correct data systems?",
      diff: "hard",
      section: "data-integration",
      a: `<p>The vision is a set of principles rather than a product:</p>
<ol><li><strong>Integrate by deriving</strong>: choose a system of record for each kind of data, record every write in one ordered log (the log itself, or a database's change stream through CDC), and make every other store a deterministic derived view. Views can lag but can't diverge.</li>
<li><strong>Keep raw events and reprocess</strong>: because history is retained, any view can be rebuilt or restructured by running new code from the start of the log next to the old view. One codebase for batch and stream replaces Lambda's two.</li>
<li><strong>Unbundle the database</strong>: the log, stream processors and specialized stores together play the roles of one database's replication log, index maintenance and materialized views. Application code becomes a derivation function, and subscribing to streams replaces many synchronous RPCs.</li>
<li><strong>Move the write/read boundary deliberately</strong>: indexes, caches and materialized views are where the write path meets the read path, and pushing changes to clients extends the write path to the screen.</li>
<li><strong>Correctness end to end</strong>: infrastructure guarantees (TCP, transactions, broker exactly-once) are valuable but scoped; the application closes the loop with request IDs generated by the client and checked atomically with the effect, and with constraints enforced by processing a log partition in sequence.</li>
<li><strong>Integrity always, timeliness where it pays</strong>: avoid coordination by default; use consensus only where an apology would be too expensive (a double-sold seat), and loose constraints with compensation elsewhere.</li>
<li><strong>Trust, but verify</strong>: immutable events and deterministic derivations make audits possible; reconcile derived data with its source and restore backups.</li>
<li><strong>Responsibility</strong>: the same pipelines make decisions about people and record their behaviour, so design for accountability, watch for feedback loops, collect less and delete on time.</li></ol>
<p><strong>Where serializable transactions still belong</strong>: inside one partition or one service's database, where they are cheap and make invariants simple. The argument is against heterogeneous distributed transactions, not against ACID.</p>`,
      followups: [
        "Where would you still use serializable transactions?",
        "What does a user lose compared with a single ACID database?",
        "Which parts of this vision have become easier to build since 2017?",
      ],
      pitfalls: [
        "Saying infrastructure is merely best-effort and can't be trusted at all (its guarantees are real, just scoped)",
        "Presenting \"everything is a Kafka topic\" as the goal regardless of scale",
        "Ignoring the timeliness cost: no read-your-writes across views by default",
      ],
    },

    // ---- reprocessing ----
    {
      id: "q02",
      q: "Compare Lambda and Kappa architectures.",
      diff: "hard",
      section: "reprocessing",
      a: `<p><strong>Lambda</strong> (Nathan Marz, 2011 post "How to beat the CAP theorem"; later the book <em>Big Data</em>): incoming data is appended to an immutable <strong>master dataset</strong>. A <strong>batch layer</strong> (Hadoop) periodically recomputes batch views from all of it; a <strong>speed layer</strong> (Storm) processes events since the last batch run, covering recent data with low latency (it may use approximations, but that's optional); a <strong>serving layer</strong> makes the batch views queryable, and queries merge batch and real-time views.</p>
<ul><li><strong>What it got right</strong>: immutable raw events and recomputable views, so a logic bug is fixed by recomputing.</li>
<li><strong>The book's critiques</strong>: every piece of logic is written and kept identical in two frameworks (Summingbird-style abstractions help, but you still operate two systems); merging outputs is easy for windowed counts and hard for joins and sessions; and full recomputation gets so expensive that batch layers go incremental, bringing back window-boundary and straggler problems.</li></ul>
<p><strong>Kappa</strong> (the name comes from Jay Kreps, "Questioning the Lambda Architecture", 2014): keep only the stream path. To reprocess, run a second instance of the job from the start of the retained log into a new output table, switch readers when it has caught up, then delete the old job and table.</p>
<ul><li><strong>Preconditions</strong>: the log retains full history (or you can replay from an archive), event-time windows, deterministic code, idempotent or versioned sinks, side effects switched off during replay, and capacity to replay much faster than real time.</li></ul>
<p><strong>Today</strong>: unified engines (Flink, Spark Structured Streaming, Beam) and cheaper long retention (Kafka tiered storage, Iceberg and Delta tables) made the single-codebase approach practical, which is what DDIA argues for: unify batch and stream in one system. Batch warehouses and lakehouses are still common for large recomputations, so the goal is one definition of each derivation that can run in either mode, not "never batch".</p>`,
      followups: [
        "How do you reprocess without side effects?",
        "What if retention is short?",
        "How do you switch readers from the old output to the new one safely?",
      ],
      pitfalls: [
        "Fixing only one Lambda layer",
        "Processing-time windows during replay",
        "Defining the speed layer as \"approximate\" (approximation is optional)",
      ],
    },
    {
      id: "q-fix-a-year-of-history",
      q: "Your analytics platform is a Lambda architecture: a nightly Spark batch job and a Flink speed layer, each with its own implementation of the metrics. A metric definition turns out to have been wrong for a year. Walk through fixing it, and argue whether you would move to a single-codebase (Kappa-style) design.",
      diff: "medium",
      section: "reprocessing",
      a: `<p><strong>Fixing it under Lambda</strong> takes both layers:</p>
<ol><li><strong>Fix both implementations and prove they agree</strong>: move the metric definition into a shared library (or a Summingbird-style abstraction), and run golden test datasets through both the Spark and the Flink code, diffing the outputs.</li>
<li><strong>Rerun the batch over the year</strong> from the immutable master dataset (the data lake), writing new batch views rather than overwriting the old ones.</li>
<li><strong>Deploy the speed-layer fix</strong> and check the serving layer's time boundary: the speed layer must cover exactly what the batch views don't, or the merge double-counts or leaves a gap.</li>
<li><strong>Compare and communicate</strong>: diff old against new, explain the changed numbers to stakeholders, and keep the old views until people agree.</li></ol>
<p>Fixing only the speed layer is the classic mistake: the next batch run silently replaces the corrected numbers with the old definition, or the metric jumps when data moves from one layer to the other.</p>
<p><strong>A single-codebase design</strong>: one implementation on an engine that runs over bounded and unbounded inputs (Flink in batch or streaming mode, Beam, Spark Structured Streaming). Replaying a year needs the raw events: Kafka with tiered storage, or an archive in object storage or an Iceberg or Delta table read through the same code.</p>
<ul><li><strong>Event-time windows</strong>, or a year of replayed events lands in today's window.</li>
<li><strong>Deterministic code</strong> and <strong>versioned or idempotent sinks</strong>.</li>
<li><strong>Side effects off</strong> (alerts, emails) during replay.</li>
<li><strong>Roll out like the railway gauge change</strong>: v2 writes new tables side by side, diff v1 against v2, move dashboards over gradually, keep v1 for rollback, then retire it.</li>
<li><strong>Capacity</strong>: replay much faster than real time without starving production jobs.</li></ul>
<p><strong>The argument</strong>: two implementations of one metric just caused a year-long error, which is Lambda's core cost. The counter-arguments are migration effort and that a batch engine can be cheaper for a huge one-off recomputation. So I'd aim for one definition that runs in both modes, keeping batch execution where it's cheaper. (For a short, recent bug in a pure streaming job, see <a href="#/ch11/interview/q-reprocess-after-bug">Chapter 11's reprocessing question</a>.)</p>`,
      followups: [
        "How do you prove the batch and stream implementations compute the same thing?",
        "Raw events older than 90 days were deleted: what now?",
        "How do you avoid re-sending emails or re-charging cards during replay?",
        "How do you roll the corrected numbers out to stakeholders?",
      ],
      pitfalls: [
        "Fixing only the speed layer (the next batch run silently undoes it)",
        "Replaying with processing-time windows, so a year of events lands in today's window",
        "Overwriting the live table in place with no side-by-side comparison or rollback",
      ],
    },

    // ---- unbundling-databases ----
    {
      id: "q01",
      q: "What does Kleppmann mean by 'unbundling the database'?",
      diff: "hard",
      section: "unbundling-databases",
      a: `<p>A database bundles several functions behind one interface (storage, a replication log, secondary indexes, materialized views, triggers, a query planner, a transaction manager) and keeps them consistent for you. <code>CREATE INDEX</code> is the template: take a consistent snapshot, build the index, apply the writes made in the meantime, then maintain it on every commit.</p>
<p><strong>Unbundling</strong> rebuilds that machinery across systems. A durable log (Kafka) plays the replication log, fed by CDC or event sourcing; stream processors play index maintenance and triggers; specialized stores are the indexes and views: Elasticsearch for text, a column store for analytics, Redis for low-latency reads, a graph store for relationships. Adding a capability means adding a consumer that bootstraps from a snapshot and follows the log, not adding another dual write.</p>
<p><strong>Federated vs unbundled</strong>: a federated system (Trino, PostgreSQL foreign data wrappers) unifies <em>reads</em> with one query interface over many stores, but does nothing to keep their writes consistent. Unbundling unifies <em>writes</em>, which is the harder problem.</p>
<p><strong>How the stores stay in sync</strong>: through an asynchronous log with ordered, idempotent consumers, not distributed transactions. A failed consumer falls behind and catches up without affecting the producer or the other consumers, and different teams can own different consumers.</p>
<p><strong>Honest costs</strong>: no read-your-writes across views by default (the index lags the database), more systems to operate and monitor, schemas on the log become public contracts (use a schema registry), and debugging data across many hops. Many companies run exactly this stack, such as Postgres → Debezium → Kafka → Elasticsearch, Redis and Snowflake, but if one database meets all your needs, use it.</p>`,
      followups: [
        "When would you not unbundle?",
        "How do you add a new derived store for existing data?",
        "Why did the consumer act on an effect before its cause? (see <a href=\"#/ch12/interview/q-cross-service-causality\">the cross-service causality question</a>)",
      ],
      pitfalls: [
        "Describing it as dual writes to several stores",
        "Ignoring idempotence and ordering",
        "Claiming a federated query layer keeps the stores' writes consistent",
      ],
    },
    {
      id: "q-rpc-vs-subscribe",
      q: "A checkout service needs current exchange rates and catalog prices for every purchase. Should it call those services synchronously, or subscribe to their change streams and keep local copies? What are the trade-offs?",
      diff: "medium",
      section: "unbundling-databases",
      a: `<p>This is a choice between doing the lookup over the network on the <strong>read path</strong> of every purchase, or moving it onto the <strong>write path</strong> of the rate and catalog data.</p>
<p><strong>Synchronous RPC</strong></p>
<ul><li>Simple, and as fresh as the upstream (which has its own caches and replicas, so it isn't perfectly fresh either).</li>
<li>Adds a network hop to every checkout and couples availability: rates service down means checkout down.</li>
<li>Upstream load scales with checkout traffic. The mitigations (caches, timeouts, circuit breakers, fallbacks) reintroduce staleness anyway.</li></ul>
<p><strong>Subscribe to change streams (the book's dataflow approach)</strong></p>
<ul><li>Consume the rate and catalog streams (domain events or CDC) into a local table; the purchase becomes a local lookup, a stream-table join.</li>
<li>Fast, and it survives upstream outages; upstream load scales with the <em>change</em> rate, not the read rate. Paraphrasing the book: the fastest, most reliable network request is the one you don't make.</li>
<li>Costs: the copy lags, so define acceptable staleness and <strong>record which rate version</strong> each purchase used; new instances must bootstrap (snapshot plus stream, or a compacted topic); storage; the stream's schema becomes a public contract; and lag monitoring becomes essential.</li></ul>
<p><strong>The time-dependence trap</strong>: a purchase joins with the rate <em>as of the purchase time</em>. If you reprocess last month's purchases, join against historical rate versions, not today's table (Chapter 11's time-dependent joins).</p>
<p><strong>Where a price was promised</strong> (a quote shown to the customer), store the quote ID with its rate and expiry and validate it at purchase time, so lag can't change what the customer agreed to. My default: subscribe for reference data such as rates and catalog prices, and keep synchronous calls for actions that must be authoritative at that instant, such as reserving stock or authorizing a card.</p>`,
      followups: [
        "A rate moves sharply while the local copy lags by 3 seconds: what happens?",
        "How does a new instance bootstrap its local copy?",
        "How would you reprocess last month's purchases correctly?",
      ],
      pitfalls: [
        "Ignoring staleness and not recording which version was used",
        "Re-joining historical purchases with today's rates",
        "Assuming RPC means always fresh (the upstream's own caches and replicas lag too)",
      ],
    },

    // ---- write-path-read-path ----
    {
      id: "q-precompute-and-push",
      q: "Design the backend for a live sports scoreboard that millions of fans keep open, plus an endpoint for ad-hoc historical stats. What do you precompute on write, what do you compute on read, and how do updates reach open browsers?",
      diff: "medium",
      section: "write-path-read-path",
      a: `<p>Frame it as choosing where the write path meets the read path for each kind of data.</p>
<p><strong>Live score: precompute and push.</strong> The score is tiny, extremely hot and changes rarely compared with how often it is read, so materialize it on the write path: one small view per match, updated when a scoring event arrives. Polling is the read-path alternative, and it is wasteful: 1 million viewers polling every 5 seconds is 200,000 requests per second for data that changes every few minutes.</p>
<ul><li><strong>Fan-out tier</strong>: score events go into a log partitioned by match ID; stateless gateway servers hold the SSE or WebSocket connections and subscribe to the matches their clients are watching.</li>
<li><strong>Sequence numbers</strong>: every update carries a per-match sequence number, so clients apply deltas in order and ignore duplicates. On reconnect a client sends the last sequence it saw and receives what it missed, or a snapshot plus later deltas if it was away too long: exactly a log consumer resuming from an offset.</li>
<li><strong>Slow clients</strong> get the latest state rather than every intermediate update (conflation), so one slow phone can't build an unbounded queue.</li>
<li><strong>Protocol</strong>: SSE suffices for one-way updates, runs over plain HTTP and reconnects automatically, sending <code>Last-Event-ID</code>; WebSockets if clients also send (chat, predictions); long polling as a fallback.</li></ul>
<p><strong>Ad-hoc historical stats: compute on read.</strong> The query space is huge and most queries are rare, so precomputing them all would make every event update an unbounded number of results. Keep raw events in a columnar store or search index, compute on demand, and cache popular queries: the middle of the spectrum.</p>
<p><strong>Freshness and hot keys</strong>: anything precomputed is only as fresh as its pipeline, so show an "as of" time when the push path lags. A final with 20 times the usual audience is a hot-key problem (Chapter 6): spread its subscribers across many gateway nodes, possibly with a relay tree, instead of pinning a match to one node.</p>`,
      followups: [
        "How does a client that was offline for ten minutes catch up?",
        "SSE, WebSockets or long polling: which and why?",
        "One final has 20x more viewers than any other match: what breaks?",
      ],
      pitfalls: [
        "Millions of clients polling the database",
        "Precomputing every possible ad-hoc query",
        "No sequence numbers, so clients apply out-of-order deltas",
      ],
    },

    // ---- end-to-end-argument ----
    {
      id: "q03",
      q: "What's the end-to-end argument, applied to databases?",
      diff: "hard",
      section: "end-to-end-argument",
      a: `<p>The end-to-end argument (Saltzer, Reed and Clark, ACM TOCS, 1984): when doing a function right depends on knowledge that only the applications at the endpoints have, the layers in between can't provide it on their own. They can offer partial versions, which are useful as performance optimizations but not sufficient for correctness. The paper's example is careful file transfer: network checksums don't catch a disk error at the sender or a bug in the copy program, so the endpoints must verify the whole file.</p>
<p><strong>Applied to duplicate suppression</strong>, the book walks up the stack:</p>
<ul><li><strong>TCP</strong> discards retransmitted copies of the same bytes, but only within one connection; a client that times out, reconnects and resends produces data TCP has never seen.</li>
<li><strong>A database transaction</strong> is atomic per attempt. If the COMMIT succeeds and the reply is lost, the retry runs a second, equally atomic transfer of $11.</li>
<li><strong>Two-phase commit</strong> makes the coordinator and participants agree, but the user's browser isn't a participant: a resubmitted form or a double-click is outside its scope.</li>
<li><strong>Broker exactly-once</strong> (Kafka transactions) covers read-process-write within Kafka; an email or an HTTP call to another service is outside it.</li></ul>
<p><strong>The end-to-end fix</strong>: the client generates a request ID once per logical operation and sends it on every retry. The server, <em>in the same transaction</em> as the effect, inserts the ID into a table with a UNIQUE constraint; a duplicate violates the constraint and aborts, and gets the stored response. Pass the ID on to downstream side effects so they can deduplicate too.</p>
<p>The same reasoning covers checksums (end-to-end checks catch bugs that link-level CRCs can't) and encryption (TLS protects the network path; only end-to-end encryption protects against a compromised server). Lower-level guarantees remain valuable because they make failures rarer; correctness still needs the endpoints.</p>`,
      followups: [
        "Where should the ID be generated?",
        "Does Kafka exactly-once make an email consumer idempotent?",
        "Why is a hash of the request body a risky idempotency key?",
      ],
      pitfalls: [
        "Saying exactly-once infrastructure is enough",
        "Generating the ID server-side per attempt",
        "Checking for the ID and applying the effect in separate transactions",
      ],
    },
    {
      id: "q-idempotent-payments-api",
      q: "Design a payments API so that a client retrying after a timeout never charges the customer twice.",
      diff: "hard",
      section: "end-to-end-argument",
      a: `<p><strong>Principle</strong>: a timeout tells the client nothing about whether the charge happened, so retries are unavoidable, and only an ID that identifies the logical payment end to end can make them safe. TCP, HTTP keep-alive, database transactions and 2PC each deduplicate only within their own scope.</p>
<p><strong>Client</strong>: generate an idempotency key (a UUID) once per logical payment, for example when the checkout is created and before the first attempt, and send it on every retry (Stripe's <code>Idempotency-Key</code> header). Never generate it per attempt.</p>
<p><strong>Server</strong>, in one database transaction:</p>
<ol><li>Insert <code>(merchant_id, key, request_fingerprint, status = 'in_progress')</code> into an idempotency table with a UNIQUE constraint on <code>(merchant_id, key)</code>.</li>
<li>Create the payment record.</li>
<li>Commit; once the outcome is known, store the final status code and response body with the key.</li></ol>
<p><strong>On a duplicate key</strong>: if the original completed, return the stored response; if it is still in progress, return 409 or "retry later" (or block on the row) rather than running it twice; if the fingerprint differs, reject it as a reused key. A concurrent second INSERT waits for the first transaction and then fails, so two duplicates can't both pass, unlike check-then-insert.</p>
<p><strong>The external processor</strong>: the charge on the card network can't be inside your database transaction. Record the intent first, call the processor passing your own idempotency key or reference if it supports one, then record the result. If the server crashes after charging but before recording, a recovery job looks the payment up at the processor by that reference, and settlement reports are reconciled daily against your ledger.</p>
<p><strong>Lifetime and scope</strong>: keep keys for a bounded window (Stripe may remove keys once they are at least 24 hours old) and document that clients must not retry beyond it. Scope keys per merchant or account so different clients can't collide.</p>`,
      followups: [
        "What happens if the server crashes after charging the card network but before recording the result?",
        "How long should keys be kept and what happens after expiry?",
        "How do you handle two concurrent requests with the same key?",
        "Where should the key be generated, client or API gateway?",
      ],
      pitfalls: [
        "Generating the key on the server for each attempt",
        "Checking for the key and inserting the payment in separate transactions (race)",
        "Assuming 'exactly-once' in the message broker makes the API idempotent",
        "Not storing the original response, so retries get a confusing error",
      ],
    },

    // ---- enforcing-constraints ----
    {
      id: "q04",
      q: "How can a stream system enforce uniqueness constraints without distributed transactions?",
      diff: "hard",
      section: "enforcing-constraints",
      a: `<p><strong>Key point first</strong>: rejecting the second of two concurrent claims needs a single decision point per value, which is consensus. Asynchronous multi-leader replication can't provide it (two leaders each accept "alice"). A log partition can: all of its consumers see its messages in the same total order.</p>
<ol><li><strong>Normalize and route</strong>: normalize the username (case, Unicode) and publish a claim event keyed by it, so all claims for one name land in the same partition.</li>
<li><strong>Decide sequentially</strong>: a single-threaded processor for that partition reads claims in log order, checks its local state (the taken names in its partition), and emits <code>accepted</code> or <code>rejected</code> to an outcome topic, tagged with the claim's request ID. The first claim in log order wins.</li>
<li><strong>The client waits</strong> for the outcome event for its request ID (via the API server that submitted it) before showing "Welcome". The check is synchronous from the user's point of view; there just isn't a distributed transaction.</li>
<li><strong>Durable state</strong>: checkpoint the taken-names state atomically with the input offset (Kafka Streams state stores with changelog topics and exactly-once enabled, or Flink checkpoints), so a restart neither forgets a name nor decides one differently.</li></ol>
<p>Scale comes from partitioning by the constrained value, while each partition runs serially, like actual serial execution (Chapter 7). The pattern generalizes to seats per event, stock per SKU and balance per account; operations that touch two partitions, such as a transfer, are split into request-ID-tagged instructions applied idempotently, with no atomic commit.</p>
<p>For the consensus-store alternatives (Spanner, conditional writes, Cassandra lightweight transactions) see <a href="#/ch9/interview/q-unique-usernames">Chapter 9's username question</a>.</p>`,
      followups: [
        "How does the client learn the result?",
        "What about a transfer between two partitions? (see <a href=\"#/ch12/interview/q-transfer-across-shards\">the cross-shard transfer question</a>)",
        "What happens to in-flight claims when the processor crashes?",
      ],
      pitfalls: [
        "Check-then-insert against a replica",
        "Assuming partitions alone give transactions",
        "Thinking a CRDT set can enforce uniqueness (CRDTs merge, they can't reject)",
        "Telling the user \"welcome\" before the processor's decision arrives",
      ],
    },
    {
      id: "q-transfer-across-shards",
      q: "Accounts are sharded across many database partitions. Design money transfers between accounts on different shards without two-phase commit, and explain what users might observe.",
      diff: "hard",
      section: "enforcing-constraints",
      a: `<p>Follow the book's multi-partition recipe: one durable append is the commit point, and everything after it is deterministic and idempotent.</p>
<ol><li><strong>Submit</strong>: the client sends <em>transfer(r-91, A → B, $50)</em> with a unique request ID r-91, generated once per user intent.</li>
<li><strong>Validate (to prevent overdrafts)</strong>: a processor partitioned by payer account holds A's available balance and handles A's requests sequentially; it accepts r-91 only if A can cover it, reserving the amount. Only accepted requests go on.</li>
<li><strong>Record</strong>: the accepted request is appended to a request log. This single append is the atomic commit point: once it is there, the transfer will happen.</li>
<li><strong>Split</strong>: a stream processor reads the request log and emits two instructions, "debit A $50 (r-91)" to A's partition and "credit B $50 (r-91)" to B's. The split must be deterministic (no clock reads, no random numbers) so a replay emits identical instructions.</li>
<li><strong>Apply</strong>: each account processor consumes its partition in order and, in one local transaction, updates the balance and records r-91 in its applied-IDs table; an instruction whose ID is already there is dropped.</li>
<li><strong>Recover</strong>: after a crash, processors resume from their checkpoints and re-emit or re-apply; deduplication by r-91 makes that harmless.</li></ol>
<p><strong>What users can observe</strong>: for a short window, A is debited and B not yet credited (money in flight). That is a timeliness lag; it can never become a permanent loss or duplication, which would be an integrity violation. Show a "pending" state honestly rather than claiming atomic visibility, which this design doesn't provide. 2PC hides the intermediate state behind locks, at the cost of coordination.</p>
<p><strong>Auditing and corrections</strong>: use double-entry bookkeeping. Every request ID must eventually have one debit and one matching credit, so a periodic audit that sums both sides per request ID catches bugs that create or destroy money. Reverse mistakes with compensating transfers, never by editing history. And if both accounts happen to be on the same shard, an ordinary local transaction is simpler.</p>`,
      followups: [
        "How do you prevent the payer from going negative with concurrent transfers?",
        "What does a user see if they check both balances during the transfer?",
        "How would you detect that money was created or destroyed by a bug?",
      ],
      pitfalls: [
        "Applying debit and credit without request IDs, so redelivery double-applies",
        "Non-deterministic splitter logic (reading the clock or a random number) so replay emits different instructions",
        "Claiming the intermediate state is never visible",
      ],
    },

    // ---- timeliness-and-integrity ----
    {
      id: "q05",
      q: "What's the tradeoff between timeliness and integrity, and how should you think about it?",
      diff: "medium",
      section: "timeliness-and-integrity",
      a: `<p>The framing in the question is slightly off: they are <strong>two different properties</strong>, not two ends of one dial.</p>
<ul><li><strong>Timeliness</strong>: users observe the system in an up-to-date state. A violation is a stale read, and it fixes itself if you wait and try again.</li>
<li><strong>Integrity</strong>: absence of corruption: nothing lost, duplicated, contradictory or invented, and every derived view accurately derived from its source. A violation is permanent until someone detects and repairs it.</li></ul>
<p>Paraphrasing the book: a timeliness violation is eventual consistency; an integrity violation is perpetual inconsistency. Its credit card example: a purchase from the last day not yet on your statement is normal; a statement balance that doesn't equal the sum of its transactions is a serious bug.</p>
<p><strong>Why the distinction matters now</strong>: ACID transactions bundle both (linearizable reads and atomic commit), so nobody had to separate them. Asynchronous dataflow decouples them: there is no timeliness guarantee unless you build one (for example, the client waits until a consumer acknowledges its write), while integrity is kept by effectively-once processing, request IDs end to end, deterministic derivations and immutable events you can reprocess.</p>
<p><strong>How to think about it</strong>: in most applications integrity matters far more, so tolerate staleness but never corruption. Pending items on a bank statement are fine, a balance that disagrees with its transactions is not; a dashboard a minute behind or a search index a second behind is fine. Some decisions need both before you acknowledge: assigning a concert seat must be decided synchronously, at that seat's partition. Elsewhere, consider <strong>loosely interpreted constraints</strong>: accept the write, check afterwards, and apologize (overbooking, back-orders) when the apology is cheaper than the coordination.</p>
<p>Make staleness visible where it matters ("updated 40 s ago", "pending"), and monitor integrity with audits rather than assuming it.</p>`,
      followups: [
        "Give an example that needs both.",
        "How do you surface staleness to users?",
        "Which invariants in your system need coordination? (see <a href=\"#/ch12/interview/q-which-constraints-need-coordination\">the invariants question</a>)",
      ],
      pitfalls: [
        "Calling double-counting \"eventual consistency\"",
        "Describing them as one knob to tune between",
        "Buying linearizability everywhere for problems that are only about timeliness",
      ],
    },
    {
      id: "q-which-constraints-need-coordination",
      q: "For a ticketing and merchandise platform, which invariants must be enforced with synchronous coordination before acknowledging the user, and which can be checked afterwards with an apology? (a) unique usernames, (b) an assigned concert seat is sold once, (c) T-shirt stock never below zero, (d) a prepaid wallet never below zero, (e) every order references an existing customer, (f) an order's total equals the sum of its items.",
      diff: "hard",
      section: "timeliness-and-integrity",
      a: `<p><strong>Framework</strong> for each invariant: what does a user see if it is briefly violated, what does the apology cost, and does merging concurrent valid operations always preserve it (Bailis et al.'s invariant confluence)? Coordinate only when the answers are "something bad", "a lot" and "no".</p>
<ul><li><strong>(a) Unique usernames</strong>: not invariant-confluent, since two concurrent claims are each valid alone and invalid together. Either one decision point per normalized name (partition by name: a single-threaded log consumer or a consensus-backed conditional write), or accept and ask one user to rename later. Most products coordinate, because taking a name back is awkward and the cost is small: one partition per name.</li>
<li><strong>(b) Assigned concert seat</strong>: two people turning up for one seat is expensive and public, so coordinate per seat or per event partition (a conditional write or a single-threaded allocator, perhaps with a short hold). Scope it to that partition; no global lock.</li>
<li><strong>(c) T-shirt stock ≥ 0</strong>: a loose constraint. Retailers oversell and back-order or refund anyway (stock gets damaged or miscounted), so accept orders and reconcile asynchronously, with an apology and a refund when needed.</li>
<li><strong>(d) Prepaid wallet ≥ 0</strong>: concurrent withdrawals are not confluent and the money is real, so validate in the payer's partition before accepting the request (the book's transfer recipe): coordination within one partition, never cross-partition 2PC.</li>
<li><strong>(e) Order references an existing customer</strong>: inserts are coordination-free as long as customers aren't deleted concurrently; deletes need ordering (process them in the same partition as the customer's orders, or soft-delete).</li>
<li><strong>(f) Order total = sum of items</strong>: derive the total deterministically from a single order event, so it holds with no coordination at all.</li></ul>
<p><strong>Across all of them</strong>, integrity is non-negotiable: request IDs end to end, deterministic derivations, idempotent consumers, and audits of stock movements and wallet ledgers. A saga (Chapter 9) is the multi-service form of "act, then compensate", and it gives up isolation exactly where an apology is acceptable.</p>`,
      followups: [
        "What is the latency and availability cost of coordinating (b) across regions?",
        "How would you implement the apology for (c)?",
        "Which of these would you monitor with an audit job, and how?",
      ],
      pitfalls: [
        "Coordinating everything with global locks or 2PC",
        "Coordinating nothing and calling a double-sold seat 'eventual consistency'",
        "Confusing timeliness (a stale stock count) with integrity (a lost order)",
      ],
    },
    {
      id: "q-read-your-writes-derived-views",
      q: "A user edits their profile and immediately searches for it, but the search index (fed from the database through CDC and Kafka) hasn't caught up, so the edit seems lost. How do you give users read-your-writes without making every write synchronous?",
      diff: "medium",
      section: "timeliness-and-integrity",
      a: `<p><strong>Diagnose it first</strong>: this is a timeliness problem, not an integrity one. The index will converge; the user simply read it before the pipeline applied their write. Asynchronous derived views give no read-your-writes across stores by default, so buy it only for the reads that need it, and only for the user who wrote.</p>
<ol><li><strong>Read your own data from the system of record.</strong> Pages that show the user's own data (their profile, their recent orders) read from the database, at least for a short window after a write. Simple and cheap, but no help for a query only the index can answer, such as full-text search.</li>
<li><strong>Position tokens: wait until the view has caught up.</strong> The write returns a token for its position in the change stream: the commit's LSN (Debezium copies the source LSN into every change event), or the offset the broker returned if the service appends to Kafka itself. The next read carries the token; the indexer records the last position it has applied, and the read path waits briefly until that passes the token, falling back to the source on timeout. This makes the book's remedy, having the client wait for the consumer, precise, and it is the same trick as read-your-writes on lagging replicas (<a href="#/ch5/interview/q03">Chapter 5</a>).</li>
<li><strong>Wait on the write instead.</strong> The write API returns only after the indexer reports that it has applied the change (indexing with Elasticsearch's <code>refresh=wait_for</code> makes "applied" also mean "searchable"). This slows that write and ties it to the pipeline's health, so use a timeout and show "saving…" rather than failing.</li>
<li><strong>Patch the client.</strong> The app merges its own pending writes into what it displays (an optimistic update) until the server view confirms them. Good for the experience, but it fixes only the device that made the change.</li></ol>
<p><strong>Across devices</strong>, a token held by one browser doesn't help the user's phone, so store each user's latest write position on the server and let any device's read wait for it. Other users still see the change eventually, which is usually fine. Track consumer lag as an SLO, because every one of these techniques gets slower when the pipeline falls behind.</p>
<p>What not to do: also write to the index from the request handler to make it "fresh". That dual write brings back the ordering and partial-failure problems the log was there to remove.</p>`,
      followups: [
        "How does the read path know how far the indexer has got?",
        "What should a read do if the indexer is minutes behind?",
        "Does any of this give read-your-writes to other users?",
      ],
      pitfalls: [
        "Dual-writing to the index from the request handler",
        "Making every write wait for every derived view",
        "Treating lag as data loss and adding retries",
        "Forgetting reads from the user's other devices",
      ],
    },

    // ---- trust-but-verify ----
    {
      id: "q06",
      q: "Why does Kleppmann argue for auditability / 'trust but verify'?",
      diff: "medium",
      section: "trust-but-verify",
      a: `<p>Every guarantee in a data system rests on a system model: fsync'd data survives, memory and CPUs compute correctly, the database enforces its constraints, our code is right. These assumptions are usually true, so it is tempting to treat them as always true. At scale they aren't:</p>
<ul><li><strong>Hardware</strong>: bits flip in memory and on disk; rowhammer showed that repeatedly accessing DRAM rows can flip bits in neighbouring rows (Kim et al., 2014); and in 2021 Google and Meta reported CPUs that silently compute wrong results.</li>
<li><strong>Databases</strong>: mature systems have shipped bugs in uniqueness constraints and isolation levels; Jepsen's 2020 analysis found PostgreSQL 12.3's SERIALIZABLE level allowed G2-item anomalies, fixed in 12.4.</li>
<li><strong>Application code</strong> is far less tested than databases, and often uses foreign keys and unique constraints incorrectly or not at all.</li></ul>
<p>Silent corruption spreads into replicas, derived views and backups. GitLab's 2017 incident is the standard warning: after the primary's data was accidentally deleted, none of its five backup and replication mechanisms turned out to be working as assumed.</p>
<p><strong>What to do</strong>:</p>
<ul><li><strong>Read back and restore-test</strong>: to know data is still there, read it; to know backups work, restore them regularly. HDFS and S3 already scrub replicas in the background.</li>
<li><strong>Reconcile end to end</strong>: compare derived stores with their source (counts, sums, per-range hashes), recompute samples from raw events with independent code, and alert on invariants such as debits = credits.</li>
<li><strong>Design for auditability</strong>: immutable input events and deterministic derivations let you rerun a computation, explain any value and repair by reprocessing.</li>
<li><strong>Tamper evidence</strong> where trust is low: Merkle trees and hash chains (as in Certificate Transparency) prove a log was only ever appended to.</li></ul>
<p>Like tests, these checks reduce fear of change: they turn silent wrongness into a known discrepancy you can investigate.</p>`,
      followups: [
        "How would you compare a huge table cheaply? (see <a href=\"#/ch12/interview/q-detect-silent-divergence\">the silent-divergence question</a>)",
        "Why isn't a database with serializable transactions enough?",
        "How would you make an audit log tamper-evident? (see <a href=\"#/ch12/interview/q-tamper-evident-audit-log\">the audit-log question</a>)",
      ],
      pitfalls: [
        "Monitoring error rates as proof of correctness",
        "Assuming mature databases and hardware never violate their guarantees",
        "Having backups that have never been restored",
      ],
    },
    {
      id: "q-detect-silent-divergence",
      q: "How would you detect that a derived store (a search index, a warehouse table) has silently diverged from its source of truth?",
      diff: "medium",
      section: "trust-but-verify",
      a: `<p>Separate two signals first: <strong>lag</strong> (timeliness: how far behind the derived store is) and <strong>mismatch</strong> (integrity: whether what is there is right). Pipeline dashboards cover the first; you have to build the second.</p>
<ul><li><strong>Aggregate reconciliation</strong>: on a schedule, compare counts and sums per partition or time bucket (per day, per key range) between source and derived store, up to a watermark both sides have passed so lag doesn't look like a mismatch.</li>
<li><strong>Hash comparison to localize</strong>: compute digests per key range on both sides and drill into only the ranges whose hashes differ, Merkle-tree style, as Cassandra's anti-entropy repair does. Comparing a 2 TB table then means moving kilobytes of hashes, not terabytes of rows.</li>
<li><strong>Independent recomputation of samples</strong>: pick random records, recompute them from raw events with separately written code, and diff. This catches logic bugs that a shared code path would reproduce on both sides.</li>
<li><strong>Invariant monitors</strong>: debits = credits, no negative inventory, every warehouse order has a source row.</li>
<li><strong>Restore tests</strong> for backups, on a schedule.</li></ul>
<p><strong>Make it possible by design</strong>: keep immutable raw events, make derivations deterministic, version outputs, and be able to reprocess a range. When a mismatch is found: stop the damage (pause the faulty consumer or route reads to the source), find the cause through provenance (which events and which code version), reprocess the affected range into a new version, and verify again.</p>
<p><strong>Frequency</strong> follows cost and risk: cheap counts hourly or per batch, hash comparisons daily, full recomputation weekly or before major changes. GitLab's 2017 data loss shows what happens when nobody checks that safety mechanisms actually work.</p>`,
      followups: [
        "How do you compare a 2 TB table cheaply?",
        "What do you do when a mismatch is found?",
        "How often should these checks run?",
      ],
      pitfalls: [
        "Relying on error-free job logs as evidence of correctness",
        "Only checking row counts (misses wrong values)",
        "No path to repair once divergence is found",
      ],
    },
    {
      id: "q-tamper-evident-audit-log",
      q: "Design an append-only audit log for a payments platform that auditors can trust, even against an engineer with write access to its database. How would anyone detect that an entry was changed or removed?",
      diff: "hard",
      section: "trust-but-verify",
      a: `<p><strong>Start from the threat.</strong> "Append-only" enforced by permissions or triggers stops honest mistakes, not an insider or attacker with access to the database or its storage, who can rewrite rows and recompute anything stored beside them. The realistic goal is not to make tampering impossible but to make it <strong>detectable by someone who doesn't have to trust the operator</strong>: the book's cryptographic tools for auditable systems.</p>
<ol><li><strong>Chain the entries.</strong> Each entry is an immutable event (who, what, when, the request ID of the money movement) appended in one total order. Either store the hash of the previous entry in each entry (a hash chain), or build a Merkle tree over them as Certificate Transparency does. Changing, inserting or deleting any entry changes every later hash, or the root.</li>
<li><strong>Get the latest hash out of the attacker's reach.</strong> A chain alone fails against someone who recomputes it from the edited entry onward. So sign the current root (the "tree head") with a key held in an HSM or a separate signing service, and publish it regularly where the operator can't rewrite it: to the auditors, to an independent witness, or to write-once storage such as S3 Object Lock in compliance mode. A rewritten log now contradicts roots that other people already hold.</li>
<li><strong>Prove, don't just assert.</strong> With a Merkle tree, an auditor checks that an entry is included with an inclusion proof (about log&#8322; n hashes: 20 for a million entries), and that today's log extends yesterday's unchanged with a consistency proof between the two tree sizes. Quietly truncating the tail or forking history becomes detectable. Google's open-source Trillian implements such verifiable logs and underpins many Certificate Transparency logs.</li>
<li><strong>Verify continuously.</strong> A scheduled job, under different credentials from the writers, recomputes hashes from the stored entries, compares them with the published roots, and reconciles the audit log against the ledger it describes (every money movement has exactly one entry with its request ID). Test the alarm by tampering with an entry in staging.</li></ol>
<p><strong>Privacy and retention</strong>: you can't delete from a chain without breaking it, so keep personal data out of entries (store reference IDs), or encrypt it with per-user keys and let the tree commit to the ciphertext. Deleting a key (crypto-shredding) then erases the content while every proof still verifies.</p>
<p><strong>Limits</strong>: this proves the log hasn't changed since it was written, not that what was written was true, so the write path still needs end-to-end checks. And a blockchain adds nothing here: with one operator and a few auditors, signed and published roots give the same tamper evidence without Byzantine-fault-tolerant consensus (Chapter 8).</p>`,
      followups: [
        "How would an auditor notice that the last 100 entries were deleted?",
        "Why isn't revoking UPDATE and DELETE permissions enough?",
        "How do you honour an erasure request for data in the log?",
        "When would a blockchain actually be justified?",
      ],
      pitfalls: [
        "Relying on database permissions or triggers alone",
        "Keeping the only copy of the latest hash next to the log it protects",
        "Putting personal data directly into immutable entries",
        "Reaching for a blockchain by reflex",
      ],
    },

    // ---- predictive-analytics ----
    {
      id: "q07",
      q: "What ethical concerns does Kleppmann raise about data systems?",
      diff: "medium",
      section: "predictive-analytics",
      a: `<p>The book's ethics discussion has two halves: decisions made about people, and data collected about them.</p>
<p><strong>Predictive analytics</strong>:</p>
<ul><li><strong>Bias</strong>: models extrapolate the past, so if past decisions were discriminatory, the model codifies them. Dropping protected attributes doesn't help while proxies remain: a postal code or IP address can predict race.</li>
<li><strong>The "algorithmic prison"</strong>: organizations err on the side of caution (a wrong "yes" is visible, a wrong "no" isn't), and when models and data are shared across companies, one flag can exclude a person from jobs, travel, insurance, housing and credit with no recourse.</li>
<li><strong>Accountability</strong>: who answers for an algorithm's mistake, and how can a person see, contest and correct the data behind it? A prediction can be right on average and wrong about an individual.</li>
<li><strong>Feedback loops and selective labels</strong>: decisions shape the next training data (the credit-score-in-hiring spiral), and denied applicants never produce outcomes, so the data can't show the model was wrong. Recommendation echo chambers work the same way.</li></ul>
<p><strong>Privacy and tracking</strong> (the privacy section):</p>
<ul><li>Behavioural data collected as a side effect makes advertisers the customer; the book's "replace data with surveillance" thought experiment shows how that sounds.</li>
<li>Privacy is the freedom to choose what to reveal to whom; tracking moves that choice to the company. Consent is rarely meaningful (opaque policies, no real alternative).</li>
<li>"Anonymized" data re-identifies people: Netflix Prize ratings were matched to IMDb reviews, and AOL's search logs identified user No. 4417749.</li>
<li>Data is a liability: it leaks, gets sold, or is demanded by a future government. The 1995 EU Data Protection Directive already required purpose limitation and data that is "not excessive"; GDPR (applicable since 2018) later codified minimization and erasure.</li></ul>
<p><strong>Engineering response</strong>: measure error rates by group, keep exploration slices for counterfactual evidence, provide explanations and an appeal path, collect less, purge on schedule, and make deletion reach every derived view. The book's closing message is that engineers share responsibility for the consequences of what they build.</p>`,
      followups: [
        "How would you implement right to erasure in a log-based system?",
        "How do you audit a model for bias?",
      ],
      pitfalls: [
        "Assuming removing protected attributes removes bias",
        "Treating anonymization as solved by dropping names",
        "Treating ethics as someone else's job (legal, product) rather than an engineering concern",
      ],
    },
    {
      id: "q-model-feedback-loop",
      q: "Your company's fraud model blocks transactions it scores as risky, and it is retrained monthly on outcomes. What could go wrong, and how would you evaluate and design it responsibly?",
      diff: "hard",
      section: "predictive-analytics",
      a: `<p><strong>What goes wrong</strong>:</p>
<ul><li><strong>Selective labels</strong>: blocked transactions never produce an outcome, so retraining only sees what the model allowed. If it wrongly blocks a segment, nothing in the data will ever say so.</li>
<li><strong>Feedback loop</strong>: each month's model learns from the consequences of last month's decisions, so an early bias against customers from certain countries or postal codes (which can be proxies for protected traits) gets entrenched instead of corrected. Fraudsters also adapt, so the data shifts under you.</li>
<li><strong>Asymmetric visibility</strong>: fraud losses are measured; false positives (legitimate customers declined, who then leave) mostly aren't.</li></ul>
<p><strong>Evaluate and design responsibly</strong>:</p>
<ol><li><strong>Exploration or holdout</strong>: send a small random slice of would-be blocks to step-up verification or manual review instead of a hard block (or allow some low-value ones) to get counterfactual labels. Its cost is a budgeted fraud loss, and the risk team should own that budget explicitly.</li>
<li><strong>Log scores, features and decisions</strong> so you can evaluate a new model offline against what actually happened (counterfactual, or off-policy, evaluation).</li>
<li><strong>Measure by segment</strong>: false positive rate, false negative rate, block rate and complaint rate per country, region and other relevant groups, not just overall precision.</li>
<li><strong>Audit features for proxies</strong> and test for disparate impact; removing protected attributes isn't enough.</li>
<li><strong>Recourse</strong>: explanations, a fast appeal path and human review for high-impact decisions; in the EU, GDPR Article 22 restricts solely automated decisions with significant effects.</li>
<li><strong>Monitor drift</strong>, and document the model (data sources, intended use, known limits).</li></ol>
<p><strong>Why it needs a policy decision</strong>: when base rates differ between groups, a score can't be calibrated within each group and also have equal false positive and false negative rates across them (Kleinberg et al. 2016; Chouldechova 2017). Choosing which fairness criterion to meet is a value judgment for the business, legal and affected stakeholders, not something the model can optimize away.</p>`,
      followups: [
        "How big should the exploration slice be and who pays for it?",
        "What metrics would you report by customer segment?",
        "What legal requirements apply in the EU?",
      ],
      pitfalls: [
        "Evaluating only on approved/allowed transactions",
        "Assuming removing protected attributes removes bias",
        "Treating fairness as a single metric to optimize",
      ],
    },

    // ---- privacy-and-tracking ----
    {
      id: "q-anonymized-data-release",
      q: "Your team wants to share an 'anonymized' dataset of user trips with researchers: names removed, user IDs hashed. What could go wrong, and what would you do instead?",
      diff: "medium",
      section: "privacy-and-tracking",
      a: `<p><strong>What goes wrong</strong>: removing names and hashing IDs is <strong>pseudonymization</strong>, not anonymization. Hashed IDs are stable, so the same person stays linkable across rows and releases, and unsalted hashes of IDs, emails or phone numbers can be brute-forced; a secret key stops brute-forcing but not linking. GDPR still treats pseudonymized data as personal data.</p>
<ul><li><strong>Quasi-identifiers</strong>: combinations of ordinary fields single people out when joined with other data; ZIP code, birth date and sex identify most Americans (Sweeney).</li>
<li><strong>Sparse, high-dimensional data is a fingerprint</strong>: Netflix Prize ratings were matched to public IMDb reviews, and four spatio-temporal points uniquely identified 95% of 1.5 million people in a mobile-phone dataset (de Montjoye et al., 2013). Trip data is exactly this kind of data: where trips begin and end reveals a home and a workplace, and that pair alone often singles out one person.</li>
<li><strong>Behaviour logs</strong>: AOL's 2006 release let <em>The New York Times</em> identify user No. 4417749 from her searches.</li>
<li><strong>Even aggregates leak</strong>: Strava's 2018 heatmap revealed military bases. And one person's trips reveal others: who travels with them, who lives at an address.</li></ul>
<p><strong>What to do instead</strong>:</p>
<ol><li>Ask whether researchers need row-level data at all. Often aggregates or an audited query interface (researchers submit approved queries, you return results) are enough.</li>
<li>Minimize fields; coarsen time and location (hours instead of seconds, districts or grid cells instead of GPS points); drop rare trips; enforce minimum group sizes in any aggregate.</li>
<li>Use <strong>differential privacy</strong> for released statistics: calibrated noise with a provable bound on what any one person's data can reveal. It costs accuracy and a privacy budget that limits how many queries can be answered; the US Census Bureau used it for 2020 Census data products.</li>
<li>Add contracts, access control and short retention, check the release against the purpose and consent users actually gave, and plan how deletion requests reach shared copies.</li></ol>
<p>And ask the book's question: would this release still be acceptable under a different future government?</p>`,
      followups: [
        "Is hashing user IDs with a secret salt enough?",
        "What does differential privacy cost the researchers?",
        "How would you handle a deletion request after the data was shared?",
      ],
      pitfalls: [
        "Equating hashed IDs with anonymous data",
        "Assuming aggregates are always safe",
        "Ignoring that the data is about people who never agreed to research use",
      ],
    },
  ],
});
