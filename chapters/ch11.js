// Chapter 11: Stream Processing
// Authoring guide: docs/AUTHORING.md
DDIA.registerChapter({
  id: "ch11",
  part: 3,
  number: 11,
  title: "Stream Processing",
  tagline: "Processing events the moment they happen: logs as brokers, databases as streams, and getting time, joins and failures right.",
  overview: `<p>Batch processing (Chapter 10) assumes its input ends. Real data never does: users keep clicking, payments keep arriving, databases keep changing. This chapter is about processing <strong>unbounded</strong> streams of events shortly after they happen. It has three parts: how events are transmitted (message brokers and partitioned logs), why databases and streams are two views of the same thing (change data capture, event sourcing, immutable logs), and how stream processors compute over them (analytics, windows, joins and fault tolerance).</p>
<p>The central tension is that a stream never lets you see all the data. You cannot sort it, you cannot wait for it to finish before emitting results, and you cannot restart from the beginning after a crash. So most design choices come down to <strong>what to remember and when to commit</strong>: how long a broker keeps messages, how long a window waits for late events, which version of a table an event joins with, and when output and progress are recorded so that a crash neither loses an effect nor applies it twice.</p>
<p>Each idea builds on the one before. Queue-style brokers decouple producers from consumers but delete what they deliver; log-based brokers such as Kafka keep it, which makes replay and many independent consumers cheap. A database's own replication log is already such a stream, so change data capture can keep search indexes and caches in sync without dual writes, and event sourcing goes further by making the log the source of truth and state a fold over it. Processing the streams then needs event time and watermarks to put events in the right windows, local state kept fresh by CDC to join streams, and checkpoints, atomic commits or idempotence to make "exactly-once" mean effectively-once.</p>`,

  concepts: [
    // ---- why-streams ----
    {
      id: "event-stream",
      term: "Event stream",
      def: `An unbounded, append-only sequence of <strong>events</strong>: small, self-contained, immutable records saying that something happened at a point in time, usually carrying a timestamp. A <strong>producer</strong> (publisher) writes each event once and any number of <strong>consumers</strong> (subscribers) process it. Related events are grouped into a <strong>topic</strong> (or stream), the counterpart of a file or directory in batch processing. Events are encoded as text (JSON) or binary (Avro, Protobuf; see Chapter 4).`,
      problem: `Batch processing waits for a bounded input that real data never has, so results are stale by up to a whole batch interval. Shrinking the interval means consumers poll a table or directory for new data, which gets expensive fast: 50 consumers polling once a second make about 4.3 million queries a day, almost all of which find nothing.`,
      why: `Because the input never ends there is no final answer: aggregates need <strong>windows</strong>, joins need retained state, and the system has to <strong>notify</strong> consumers instead of waiting to be asked. Stream processing sits between online services (milliseconds, a user is waiting) and batch jobs (minutes to days): results appear milliseconds to seconds after the event. "Real-time" here means low latency, not hard real-time deadlines as in embedded systems.`,
      ex: `Page views and clicks, card payments, sensor and CPU readings, log lines, and database changes (a write-ahead log is already a stream of change events). Kafka was created at LinkedIn to move activity events and metrics to both Hadoop and real-time consumers; by 2019 LinkedIn reported more than 7 trillion messages a day through it.`,
      section: "why-streams",
    },

    // ---- messaging-systems ----
    {
      id: "messaging-system-broker",
      term: "Messaging system / broker",
      def: `A server that buffers messages between producers and consumers, decoupling them in time and number: a producer waits only for the broker to accept a message, not for anyone to process it. Two families: <strong>queue-style brokers</strong> (AMQP/JMS: RabbitMQ, ActiveMQ, IBM MQ) that delete a message once it is acknowledged, and <strong>log-based brokers</strong> (Kafka, Kinesis) that retain messages and let each consumer track its own offset.`,
      problem: `Direct producer-to-consumer messaging (UDP multicast, ZeroMQ, webhooks) loses data when a consumer is slow or offline, forces every application to handle buffering, retries and crashes itself, and requires every producer to know every consumer's address.`,
      why: `Any publish/subscribe system is classified by two questions. <strong>Overload</strong>: when producers outpace consumers, does it drop messages, buffer them (and what happens as the buffer grows?), or apply backpressure? <strong>Crashes</strong>: are messages made durable (disk writes, replication) at a cost in throughput and latency, or may some be lost? A broker also differs from a database: it usually deletes delivered messages, assumes a small working set, offers topic subscriptions instead of secondary indexes, and pushes new data to clients instead of returning a point-in-time query result.`,
      ex: `Webhooks are brokerless: one HTTP request per event to a registered URL, so an event is lost if the consumer is down and the producer's retries die with the producer. Putting RabbitMQ or SQS in between lets consumers come and go; putting Kafka in between also lets a new consumer read history.`,
      section: "messaging-systems",
    },
    {
      id: "amqp-jms-style-broker",
      term: "AMQP/JMS-style broker",
      def: `A queue-based broker: it delivers each message, waits for the consumer's acknowledgment, then deletes it. It supports both <strong>load balancing</strong> (several consumers share one queue; a JMS shared subscription) and <strong>fan-out</strong> (JMS topic subscriptions, AMQP exchanges bound to several queues). Messages can be persisted to disk; what defines the style is deletion on acknowledgment. JMS is a Java API, AMQP is a wire protocol.`,
      problem: `Teams needed a reliable way to hand units of work to a pool of workers and survive worker crashes, without every application building its own queueing and retry logic.`,
      why: `It fits work that is expensive per message, independent, and parallelizable message by message across any number of workers; a slow message delays only itself. The costs: no replay (acknowledged messages are gone), a new subscriber sees only future messages, the broker tracks per-message state, throughput degrades when a large backlog spills to disk, and load balancing combined with redelivery <strong>reorders</strong> messages. A single consumer on a queue does receive messages in order.`,
      ex: `RabbitMQ (AMQP 0-9-1) and ActiveMQ for job queues. Amazon SQS works similarly, loosely speaking (an HTTP API rather than AMQP/JMS): at-least-once delivery, best-effort ordering, a 30-second default visibility timeout and dead-letter queues, used for background tasks such as sending emails or resizing images.`,
      section: "messaging-systems",
    },
    {
      id: "backpressure",
      term: "Backpressure (flow control)",
      def: `When a consumer cannot keep up, the system blocks or slows the producer instead of dropping messages or buffering without limit. Unix pipes and TCP do this with a small fixed buffer: when it is full, the sender waits. In a dataflow engine, backpressure propagates upstream stage by stage until it reaches the sources.`,
      problem: `A fast producer and a slow consumer must be reconciled somehow. Dropping loses data, and unbounded buffering eventually exhausts memory or degrades performance as the buffer spills to disk.`,
      why: `It is the only overload policy that is both lossless and bounded in memory, but it couples the producer's speed to the slowest consumer. Choose per data type: metrics may be dropped or sampled, payments must never be. A log-based broker removes the coupling: producers are never slowed by consumers, consumers pull at their own pace, and the backlog sits on disk up to the retention limit, so lag becomes the signal to watch.`,
      ex: `A Linux pipe has a 64 KiB buffer by default and the writer blocks when it is full; TCP's receive window does the same across a network. Flink uses credit-based flow control between operators, so a slow sink eventually makes its sources read from Kafka more slowly. RabbitMQ buffers by default but blocks publishing connections when its memory or disk alarm fires. The opposite choice is StatsD, whose clients send metrics over UDP and accept silent loss.`,
      section: "messaging-systems",
    },
    {
      id: "load-balancing-vs-fan-out",
      term: "Load balancing vs fan-out",
      def: `Two ways to deliver to several consumers. <strong>Load balancing</strong> gives each message to one consumer, so they share the work. <strong>Fan-out</strong> gives each message to every consumer, so independent consumers each get their own copy. Consumer groups combine them: fan-out across groups, load balancing within a group.`,
      problem: `Some consumers want to split expensive work between them, while others each need the full stream (a search indexer, an analytics job, an audit log); a broker has to support both.`,
      why: `The choice decides whether consumers compete for messages or each see everything. In a queue broker the unit of load balancing is the message; in a log-based broker it is the <strong>partition</strong>, so a group's parallelism is capped by the partition count, and in exchange each partition's order is preserved.`,
      ex: `An OrderPlaced topic read by three Kafka consumer groups (billing, search, analytics): every group receives every order (fan-out), and within the billing group's four instances each partition, and so each order, goes to exactly one instance (load balancing). In RabbitMQ the same shape is a fanout exchange bound to three queues, each with several competing consumers.`,
      section: "messaging-systems",
    },
    {
      id: "acknowledgment-redelivery",
      term: "Acknowledgment and redelivery",
      def: `A consumer explicitly acknowledges a message once it has processed it. If the connection closes or times out without an ack, the broker assumes the message was not processed and delivers it again, possibly to another consumer. Combined with load balancing, redelivery can reorder messages, and a lost ack causes duplicate processing.`,
      problem: `A consumer can crash halfway through processing a message; without acks the broker would either lose the message or never know when it is safe to delete it.`,
      why: `Acks turn a crash into redelivery instead of loss, which makes delivery <strong>at-least-once</strong>: a message that was fully processed but whose ack was lost is processed again, so consumers must be idempotent. Redelivery also reorders: if consumer B crashes on m3 while A is busy with m4, m3 is redelivered and completes after m4. The JMS and AMQP standards ask brokers to try to preserve order, but load balancing plus redelivery defeats that; use a queue per consumer when order matters. A <strong>poison message</strong> that always crashes its consumer would be redelivered forever, so production systems move it to a <strong>dead-letter queue</strong> after a few attempts.`,
      ex: `RabbitMQ requeues unacknowledged messages when a consumer's channel or connection closes (back to their original position when possible), sets the <code>redelivered</code> flag, and limits unacked messages per consumer with the <code>basic.qos</code> prefetch count. SQS hides a received message for the visibility timeout (30 s by default) and makes it visible again if the consumer does not delete it in time; a redrive policy sends it to a dead-letter queue after a set number of receives.`,
      section: "messaging-systems",
    },

    // ---- log-based-brokers ----
    {
      id: "log-based-broker",
      term: "Log-based broker (Kafka)",
      def: `A broker that stores messages in an append-only log on disk. Producers append to the end; consumers read sequentially and, at the end of the log, wait to be notified of new records, like <code>tail -f</code>. Reading deletes nothing: each consumer group just remembers its position (offset). Old segments are removed by time or size (Kafka's default retention is 7 days) or by log compaction, not kept forever by default. To load-balance, the broker assigns whole partitions to the consumers in a group.`,
      problem: `Queue-style brokers delete messages on acknowledgment, so you cannot replay history, add a new consumer that needs past data, or re-run a fixed consumer. Batch processing's best property, that reading the input never destroys it, was lost.`,
      why: `Non-destructive reads make a stream behave like a batch input: any number of independent consumer groups, replay by moving an offset, and experiments against production data with no effect on other consumers. Throughput stays roughly constant however much history is kept, since every message is written to disk anyway. The costs: a group's parallelism is capped by the partition count, and a slow message holds up everything behind it in its partition (head-of-line blocking). Prefer a log when throughput is high, each message is quick to process, and order matters.`,
      ex: `Apache Kafka (created at LinkedIn, open-sourced in 2011), Amazon Kinesis Data Streams, Apache Pulsar (which offers log-style and queue-style subscriptions on the same topic) and Redpanda (a C++ Kafka-API-compatible broker). KRaft, Kafka's built-in Raft-based metadata quorum, has been production-ready since 3.3 (2022), and Kafka 4.0 (2025) removed ZooKeeper entirely; tiered storage (early access in 3.6, production-ready in 3.9) can move old segments to object storage.`,
      section: "log-based-brokers",
    },
    {
      id: "partitioned-log",
      term: "Partitioned log",
      def: `A topic is split into N <strong>partitions</strong>, each a separate log that can live on a different broker and be replicated. Each record gets a monotonically increasing offset within its partition, and there is <strong>no ordering across partitions</strong>. The partition is chosen as <code>hash(key) mod N</code> (Kafka's default partitioner hashes the key with murmur2), so all records with the same key land in one partition, in order.`,
      problem: `A single log on one machine limits throughput and storage, but splitting it must not destroy the ordering of related events.`,
      why: `Partitioning gives horizontal scale while keeping order where it usually matters: per entity. Two consequences. Adding partitions later remaps most keys, so a key's older events stay in one partition while newer ones go to another, and per-key order breaks across the change (the hash-mod-N problem of <a href="#/ch6/learn/rebalancing">Chapter 6</a>); choose the count up front with headroom. And a hot key overloads one partition, which adding consumers cannot fix.`,
      ex: `All events for user 17 use the key <code>user-17</code> and land in one partition, so one consumer sees that user's events in order. Kinesis calls partitions shards; each shard accepts up to 1 MB/s or 1,000 records/s of writes.`,
      section: "log-based-brokers",
    },
    {
      id: "consumer-group-offsets",
      term: "Consumer group & offsets",
      def: `Consumers that share work form a <strong>group</strong>. The broker assigns each partition to exactly one consumer in the group, which reads it sequentially. Instead of per-message acks, the group commits one <strong>offset</strong> per partition: the offset of the <em>next</em> record to read (not the last one processed), meaning everything before it is done. Kafka stores committed offsets in its internal <code>__consumer_offsets</code> topic.`,
      problem: `Tracking an acknowledgment per message per consumer is expensive and forces deletion semantics; a log needs only one number per partition per group.`,
      why: `Offsets make consumption non-destructive and resumable. A restarted consumer continues from the last committed offset and re-processes anything after it, so delivery is at-least-once, but in order. Resetting the offset replays history. It mirrors single-leader replication (<a href="#/ch5/learn/leaders-and-followers">Chapter 5</a>): the broker is the leader and the consumer a follower tracking a log position. Parallelism is capped by partitions, and a rebalance (a consumer joins or leaves) reassigns partitions: classic eager rebalancing pauses the whole group, which cooperative rebalancing (Kafka 2.4) and the KIP-848 protocol (generally available in 4.0) reduce.`,
      ex: `A consumer processes offsets 100&ndash;149, commits 150, processes 150&ndash;170 and crashes. Its replacement starts at 150 and processes 150&ndash;170 again, in order: duplicates, not reordering. To reprocess since yesterday, start a new group from the offsets for yesterday's timestamp (Kafka can look up offsets by timestamp).`,
      section: "log-based-brokers",
    },
    {
      id: "consumer-lag",
      term: "Consumer lag",
      def: `How far a consumer group is behind the end of a partition: log-end offset minus the group's committed offset (or, more usefully, the age of the oldest unread record). If lag outgrows what the retention period keeps, the consumer misses messages that were deleted before it read them.`,
      problem: `A log buffers for a slow consumer silently and only up to its retention limit; without measuring lag you discover the problem as data loss.`,
      why: `A log neither drops nor applies backpressure: it buffers with a very large, fixed-size buffer, so rising lag is the only symptom of a slow consumer, and retention is the hard deadline. A slow consumer only hurts itself; other groups are unaffected. Alert on lag measured in time against retention, and look at it per partition: one partition far behind points to a hot key or a poison message, all of them behind points to under-capacity.`,
      ex: `LinkedIn open-sourced Burrow (2015), which judges consumer health from how committed offsets move over a sliding window rather than from a fixed lag threshold. With 7-day retention, a consumer 6 days behind is one bad day away from silently skipping data.`,
      section: "log-based-brokers",
    },

    // ---- change-data-capture ----
    {
      id: "dual-writes-problem",
      term: "Dual writes problem",
      def: `Application code writes the same change to two systems itself (a database and a search index, a database and Kafka) with no atomic commit across them. Two failure modes: a <strong>race</strong>, where concurrent writes reach the systems in different orders (client 1 sets X=A, client 2 sets X=B; the database ends with B, the index with A, permanently, and every write returned success); and <strong>partial failure</strong>, where one write succeeds and the other fails, or the process crashes in between.`,
      problem: `Applications naturally try to update every system that holds a copy of the data themselves, because it looks simple and passes every test on the happy path.`,
      why: `There is no single leader ordering the writes, so the copies diverge silently and stay wrong until something happens to overwrite the record. A retry loop does not help if the process dies before retrying, and atomic commit across both systems (2PC, <a href="#/ch9/learn/two-phase-commit">Chapter 9</a>) is expensive and often unsupported. The fixes: write to one system and derive the others from its log (<strong>CDC</strong>), or put the event in the same local transaction (<strong>transactional outbox</strong>).`,
      ex: `An order service inserts into Postgres and then calls <code>producer.send()</code> to Kafka. A crash between the two leaves an order no other service ever hears about; publishing first can announce an order that was never saved.`,
      section: "change-data-capture",
    },
    {
      id: "change-data-capture",
      term: "Change Data Capture (CDC)",
      def: `Observing every change committed to a database and extracting it, in commit order, as a stream that other systems consume. Robust implementations parse the database's replication log (the MySQL binlog, the PostgreSQL WAL through logical decoding, the MongoDB oplog) rather than using triggers, which are fragile and slow down writes. Each change event is keyed by the row's primary key, and a delete becomes a <strong>tombstone</strong> (the key with a null value).`,
      problem: `Keeping a search index, cache and warehouse in sync with dual writes leads to permanent inconsistency from races and partial failures, while periodic full dumps (batch ETL) leave the copies hours stale.`,
      why: `The database becomes the leader and every derived system a follower that applies the same changes in the same order, so they converge (the state machine replication idea of <a href="#/ch5/learn/replication-logs">Chapter 5</a> and <a href="#/ch9/learn/total-order-broadcast">Chapter 9</a>). CDC is usually <strong>asynchronous</strong>: a slow consumer never slows the source, but derived systems lag, so a user who just edited a record may not find it in search yet. A new consumer needs an initial snapshot tied to a log position, or a compacted topic, because the database log is not kept forever. Raw row changes expose the source's internal schema, which couples consumers to it.`,
      ex: `Debezium (built on Kafka Connect, for MySQL, PostgreSQL, MongoDB, SQL Server and Oracle), Maxwell (MySQL binlog), LinkedIn Databus, Facebook Wormhole, Oracle GoldenGate and AWS DMS. Databases now offer change feeds natively: PostgreSQL logical decoding (9.4) and logical replication (10), MongoDB change streams (3.6), and DynamoDB Streams (24-hour retention, often feeding Lambda functions).`,
      section: "change-data-capture",
    },
    {
      id: "cdc-initial-snapshot",
      term: "Initial snapshot (CDC bootstrap)",
      def: `A consistent snapshot of the source database taken at a known position in its change log (an LSN, binlog coordinates). A new consumer loads the snapshot and then applies changes from exactly that position onward.`,
      problem: `The database's log is usually not retained since the beginning of time, so a new derived system cannot rebuild state from changes alone; without a matching log position, changes would be missed or applied twice.`,
      why: `The snapshot and the stream must meet exactly; that handoff is the subtle part of bootstrapping a search index or cache. Large snapshots used to need a long-held lock or a read transaction open for hours. Newer tools interleave chunked table reads with the change stream, so a snapshot can run at any time without pausing replication. A log-compacted topic is the alternative: it already holds the latest value of every key.`,
      ex: `Debezium takes a consistent snapshot by default and then streams from the matching binlog position or LSN; its incremental snapshots, like Netflix's DBLog (2019), read the table in chunks between log events. LinkedIn Databus had a dedicated bootstrap service for new consumers.`,
      section: "change-data-capture",
    },
    {
      id: "log-compaction",
      term: "Log compaction",
      def: `The broker discards older records that have a later record with the same key, keeping at least the most recent value per key; a record with a null value (a <strong>tombstone</strong>) deletes the key, and the tombstone itself is removed later. The log's size then depends on the current data, not on the number of writes ever made.`,
      problem: `A change log kept forever grows without bound, but deleting old segments by age would make it impossible for a new consumer to rebuild the full current state from the log.`,
      why: `It turns a topic into a durable copy of a table: a new consumer (say, a new search index) reads from offset 0 to the end and has the current state without touching the source database. It only works when every record has a key and carries the full new value, which CDC events do and event-sourced events usually do not. Compaction runs in the background, so a reader may still see several values for a key; only the latest is guaranteed to survive. It is not time-based deletion.`,
      ex: `Kafka topics with <code>cleanup.policy=compact</code>: <code>__consumer_offsets</code> is itself compacted, Kafka Streams state-store changelogs are compacted, and CDC topics are often compacted so they hold one record per row. Tombstones are kept for <code>delete.retention.ms</code> so that consumers have time to see the delete.`,
      section: "change-data-capture",
    },
    {
      id: "outbox-pattern",
      term: "Transactional outbox",
      def: `A service writes its state change and the event describing it (as a row in an <code>outbox</code> table) in one local database transaction; change data capture then publishes the outbox rows to the message broker in commit order.`,
      problem: `Updating a database and publishing an event are two writes to two systems (a dual write); the outbox makes them one atomic local write, without distributed transactions.`,
      why: `Atomicity comes from one local ACID transaction (<a href="#/ch7/learn/acid-unpacked">Chapter 7</a>) and ordering from the database log, with no 2PC. Unlike CDC on the business tables, the outbox publishes a stable, deliberately designed domain event instead of exposing internal table schemas. Delivery is still at-least-once, so consumers deduplicate by event ID. A polling publisher can replace CDC, but rows from concurrent transactions can become visible out of commit order, and several pollers need locking.`,
      ex: `An order service inserts the order row and an outbox row (event ID, aggregate ID = order 42, type OrderCreated, payload) in one Postgres transaction; Debezium's outbox event router publishes it to an orders topic keyed by order ID. Because CDC reads the WAL, the outbox row can even be deleted right after it is inserted.`,
      section: "change-data-capture",
    },

    // ---- event-sourcing ----
    {
      id: "event-sourcing",
      term: "Event sourcing",
      def: `Building the application on an append-only log of immutable, application-level events (<code>ItemAddedToCart</code>, <code>EnrollmentCancelled</code>) that is the source of truth. Current state is derived by replaying (folding) the events with deterministic code. Updating or deleting events is discouraged or forbidden. Snapshots of derived state make replay faster but are only an optimization.`,
      problem: `Mutable CRUD storage overwrites history, losing the user intent needed for audit, debugging and new features; CDC events are low-level row changes, not business facts.`,
      why: `Events record intent, so you can audit how state came to be, build new views from old events, and recover from a buggy deploy by fixing the code and recomputing. The difference from CDC: the application writes events deliberately at the business level, while CDC extracts row changes from a mutable database the application may not know is being watched. Log compaction does not apply, because events for the same cart don't supersede each other (a later <code>ItemAdded(pen)</code> doesn't make <code>ItemAdded(book)</code> redundant), so you need the full history or a snapshot. Costs: events must be designed and versioned for years (<a href="#/ch4/learn/why-encoding">Chapter 4</a>), read models are eventually consistent, ad-hoc queries need projections, and commands must be validated before an event is written.`,
      ex: `LMAX, a retail financial exchange described by Martin Fowler (2011): business logic runs single-threaded in memory, every input event is journaled, and after a restart state is rebuilt from a snapshot plus a replay of the journal. Accounting ledgers work the same way. EventStoreDB (renamed KurrentDB in 2025) is a database built for it; many teams use Postgres or Kafka as the event store.`,
      section: "event-sourcing",
    },
    {
      id: "commands-vs-events",
      term: "Commands vs events",
      def: `A <strong>command</strong> is a request that may still be rejected (validation, integrity constraints); once validated and accepted it becomes an <strong>event</strong>, an immutable fact. Later changes of mind are new events, never edits of old ones.`,
      problem: `If unvalidated requests were logged as events, consumers would see "facts" that should never have happened, and they are not allowed to reject events afterwards.`,
      why: `By the time a consumer sees an event, other consumers may already have acted on it, so nobody downstream can reject it. Validation therefore has to happen <strong>synchronously before</strong> the event is appended: a serializable transaction that checks and appends atomically, or routing all commands for one entity (one seat, one username) to a single partition processed serially. The alternative is to split the request into a tentative event and a later confirmation, which allows validation to be asynchronous (<a href="#/ch12/learn/enforcing-constraints">Chapter 12</a>).`,
      ex: `<code>BookSeat(12A)</code> is a command. If the seat is free it becomes the event <code>SeatBooked(12A)</code>; if the user later cancels, that is a new <code>BookingCancelled</code> event, and the original booking stays in the log as something that really happened.`,
      section: "event-sourcing",
    },

    // ---- state-and-immutability ----
    {
      id: "state-stream-duality",
      term: "State and stream duality",
      def: `Current state is the result of applying every change event so far (the integral of the change stream over time); the change stream is how state evolves (its derivative). A table is a cache of the latest value of each key in the log, which is exactly what a compacted log keeps.`,
      problem: `Thinking of the database only as mutable current state hides history, makes recovery from bad writes hard, and makes derived systems look unrelated to the source.`,
      why: `It unifies the chapter: brokers, CDC, event sourcing and materialized views are all logs and folds over logs. Pat Helland summed it up as "The truth is the log." (CIDR 2015). Keeping the log makes bad writes recoverable, like an accounting ledger where mistakes are fixed with compensating entries rather than erased, and it preserves information that current state throws away (an item added to a cart and later removed). The costs: history can grow far beyond the current data for update-heavy workloads, so compaction and garbage collection matter, and truly deleting data from an immutable history is hard.`,
      ex: `A deploy writes wrong prices from 14:00 to 16:00. With an append-only change log you can see exactly which rows changed and restore their 13:59 values; with update-in-place storage you restore last night's backup and lose the day's legitimate changes. MVCC, copy-on-write B-trees and Git rely on the same immutability internally.`,
      section: "state-and-immutability",
    },
    {
      id: "cqrs",
      term: "CQRS (command query responsibility segregation)",
      def: `Separating the form in which data is written (an event log or write model) from the forms in which it is read (one or more read models derived from it), so that each can be optimized independently.`,
      problem: `One schema serving both writes and every read pattern forces painful normalize-vs-denormalize compromises and risky in-place schema migrations.`,
      why: `Each reader gets its own shape (a search index, a per-user cache, a columnar store), and denormalization stops being dangerous because a deterministic process keeps the views consistent with the log. Schema changes become gradual migrations: build a new view by replaying the log beside the old one, move readers over, retire the old one. The cost is that views are usually updated asynchronously, so a user may not read their own write (<a href="#/ch5/learn/replication-lag">Chapter 5</a>); fix it by updating the view in the same transaction when both live in one storage system, or by making the reader wait until the view has reached the log position of its write. CQRS does not require event sourcing or Kafka; event sourcing is just a common way to feed it.`,
      ex: `Twitter's home timelines are a heavily denormalized, read-optimized cache derived from tweets and follows (<a href="#/ch1/learn/describing-load">Chapter 1</a>). Apache Druid ingests directly from Kafka to build analytical segments, while Kafka Connect sinks export the same topics into Elasticsearch, a warehouse and caches.`,
      section: "state-and-immutability",
    },

    // ---- processing-streams ----
    {
      id: "complex-event-processing",
      term: "Complex event processing (CEP)",
      def: `Searching streams for patterns of events described in a declarative, often SQL-like, language. The queries are stored long-term and events flow past them; when a pattern matches, the engine emits a "complex event" describing it. The book's examples: Esper, IBM InfoSphere Streams, Apama, TIBCO StreamBase and SQLstream.`,
      problem: `Detecting patterns as they happen (fraud, equipment failure) with a database would mean re-running queries over stored data again and again.`,
      why: `It inverts the database relationship: a database stores data and runs transient queries, while a CEP engine stores queries and lets the data run past them. Like a regular expression over characters, a CEP query describes a pattern over events, usually with time constraints, and it needs per-key state for partial matches.`,
      ex: `Fraud: three card transactions from different countries within 10 minutes. Manufacturing: temperature and vibration both rising on one machine within a minute. Esper's EPL registers SQL-like statements once and evaluates them continuously against incoming events. Elasticsearch's percolator applies the same inversion to search: it stores queries and matches each new document against them.`,
      section: "processing-streams",
    },
    {
      id: "stream-analytics",
      term: "Stream analytics",
      def: `Continuously computing aggregates and statistics over windows of a stream: event rates, rolling averages, comparisons with earlier periods to spot trends or anomalies, sometimes with probabilistic structures such as HyperLogLog. The book's frameworks: Apache Storm, Spark Streaming, Flink, Concord, Samza and Kafka Streams, plus hosted Google Cloud Dataflow and Azure Stream Analytics.`,
      problem: `Dashboards and alerts need metrics within seconds, not after tomorrow's batch job.`,
      why: `The boundary with CEP is blurry: analytics cares less about specific sequences and more about aggregates over many events, computed over windows. Probabilistic structures (Bloom filters, HyperLogLog, percentile sketches) save memory, but they are an optimization: stream processing is not inherently approximate. Maintaining a materialized view is the related case whose state must cover all of history rather than a window (Kafka Streams and Samza build it on compacted logs).`,
      ex: `A live dashboard of orders per minute with a one-hour rolling average that alerts when the current rate drops far below the same minute last week. Redis HyperLogLog counts unique visitors with a 0.81% standard error in at most 12 KB per key, without storing every visitor ID.`,
      section: "processing-streams",
    },

    // ---- reasoning-about-time ----
    {
      id: "event-time-vs-processing-time",
      term: "Event time vs processing time",
      def: `<strong>Event time</strong>: when the event actually happened, according to the timestamp in it. <strong>Processing time</strong>: when the stream processor handles it, according to the processing machine's clock. They diverge because of queueing, network faults, broker contention, consumer restarts, reprocessing of old events, and devices that buffer events while offline; delays also reorder events across partitions and producers.`,
      problem: `Stream frameworks that window by the processing machine's clock misattribute delayed events and show spikes after restarts.`,
      why: `Processing-time windows put delayed events in the wrong window: a processor that is down for a minute shows a dip and then a spike as it works through its backlog, though the real rate was flat. Event time gives correct and <strong>reproducible</strong> results (replaying last month at high speed gives the same answer as processing it live), but you can never be sure a window is complete, which is what watermarks are for. Device clocks cannot be trusted: log three timestamps (event time and send time by the device clock, receive time by the server clock), estimate the clock offset as receive minus send, and add it to the event time.`,
      ex: `The book's Star Wars analogy: release order (Episodes IV, V, VI in 1977, 1980, 1983; I, II, III in 1999, 2002, 2005; VII in 2015) is processing time, story order is event time. A phone offline all day uploads its events at 20:00, and by processing time they all happened at 20:00. Since Kafka 0.10, every record carries a timestamp: CreateTime (set by the producer) or LogAppendTime (set by the broker).`,
      section: "reasoning-about-time",
    },
    {
      id: "windowing",
      term: "Windowing",
      def: `Grouping events (per key) into finite windows so they can be aggregated. <strong>Tumbling</strong>: fixed length, no overlap; each event in exactly one window. <strong>Hopping</strong>: fixed length, overlapping, aligned to a hop (5-minute windows starting every minute). <strong>Sliding</strong>: all events within some interval of each other, not aligned to the clock. <strong>Session</strong>: no fixed length; per key, ends after a gap of inactivity (e.g. 30 minutes).`,
      problem: `An unbounded stream has no total; aggregates need finite, well-defined slices.`,
      why: `The window defines what the number means, and what it costs: one accumulator per key per window for tumbling; length &divide; hop windows per event for hopping (usually built from hop-sized tumbling panes); a time-sorted buffer of raw events for sliding. Session windows <strong>merge</strong> when a late event bridges two sessions of the same key, so an earlier result may have to be retracted. Terminology trap: Flink and Apache Beam call the book's hopping windows "sliding windows".`,
      ex: `Tumbling 1 minute: orders per minute (round each timestamp down to the minute). Hopping 5 minutes every minute: a smoothed error rate for alerting. Sliding 60 seconds: three failed logins for one account within 60 seconds. Session with a 30-minute gap: website visit analytics.`,
      section: "reasoning-about-time",
    },
    {
      id: "watermark",
      term: "Watermark",
      def: `A marker that flows with the events and asserts "no more events with event time earlier than T are expected", so operators can fire windows that end before T. Except in rare cases with complete knowledge of the input, it is a <strong>heuristic</strong>: commonly the maximum event time seen so far minus an allowed delay (Flink's bounded out-of-orderness). An operator with several inputs uses the <strong>minimum</strong> of its input watermarks.`,
      problem: `With event time you can never know that a window has received all its events, yet results must be emitted at some point.`,
      why: `The delay trades latency for completeness: a small delay gives prompt results and more late events, a large one gives fuller results but every window waits. Events that arrive after the watermark (stragglers) need an explicit policy: drop them but count them (alert if the rate rises), publish corrections that update or retract the earlier result, or route them to a side output. Because of the minimum rule, one idle or slow partition holds back every window downstream (Flink has idleness detection). At the end of a bounded input, engines advance the watermark to infinity, which flushes all windows.`,
      ex: `Google's MillWheel (VLDB 2013) popularized low watermarks, and the Dataflow Model paper (VLDB 2015) generalized event-time windows, watermarks and triggers into what became Apache Beam. In Flink: <code>WatermarkStrategy.forBoundedOutOfOrderness(Duration.ofSeconds(30))</code>, plus <code>allowedLateness</code> and a side output for late records.`,
      section: "reasoning-about-time",
    },

    // ---- stream-joins ----
    {
      id: "stream-stream-join",
      term: "Stream-stream join",
      def: `A window join of two event streams on a key. The processor keeps recent events from <strong>both</strong> sides, indexed by key, because either side may arrive first; each new event is stored and checked against the other side's index, and matches are emitted. When a stored event's window expires without a match, that can be emitted too ("search with no click").`,
      problem: `Related events (a search and a click on one of its results) arrive on different streams at unpredictable times, and some never get a partner.`,
      why: `The window length is both a business definition (how long after a search does a click still count?) and the state size: roughly event rate &times; window length for each side. Embedding the search details in the click event instead would hide the searches nobody clicked, which are half of the click-through rate. Both inputs must be co-partitioned by the join key.`,
      ex: `Searches and clicks joined by session ID within an hour to compute click-through rate. Google's Photon (SIGMOD 2013) joins web search queries with ad clicks in real time, across data centers, for billing. Kafka Streams offers windowed KStream-KStream joins and Flink SQL offers interval joins.`,
      section: "stream-joins",
    },
    {
      id: "stream-table-join",
      term: "Stream-table join",
      def: `Enriching each event with data from a table by looking it up in a <strong>local copy</strong> of the table inside the processor (an in-memory hash table or an on-disk index). The copy is not static: it is kept current by consuming the table's CDC changelog. So it is really a join of two streams with asymmetric windows: the changelog side reaches back to the beginning of time (newer versions overwrite older ones, as in a compacted topic), and each activity event is joined once and forgotten.`,
      problem: `Enriching each event by querying a remote database is slow and can overload it: 100,000 events per second would mean 100,000 extra queries per second against a database sized for the application.`,
      why: `It is the streaming version of a map-side hash join (<a href="#/ch10/learn/map-side-joins">Chapter 10</a>), except the table keeps changing. Two physical shapes: <strong>broadcast</strong>, where every instance holds the whole table (Kafka Streams GlobalKTable; no co-partitioning needed), for small tables; and <strong>partitioned</strong>, where the table is split by key and co-partitioned with the stream (KTable), for large ones. A plain join uses whatever table version has been processed by the time the event is processed, so a late event or a replay joins with the wrong version: the slowly changing dimension problem, fixed by versioned or temporal joins.`,
      ex: `Adding the user's country and signup date to every page-view event. A Kafka Streams KStream-KTable join reads a local RocksDB store that is restored after a crash from a compacted changelog topic; a KStream-GlobalKTable join broadcasts the table instead. Flink SQL temporal joins (<code>FOR SYSTEM_TIME AS OF</code>) convert each order at the currency rate valid when it was placed.`,
      section: "stream-joins",
    },
    {
      id: "table-table-join",
      term: "Table-table join",
      def: `Both inputs are changelogs of tables, and the output is a continuously maintained <strong>materialized view</strong> of their join: any change on either side updates the joined result.`,
      problem: `Caches of joined data (such as home timelines, which combine tweets and follows) must react to changes on both sides.`,
      why: `It is incremental view maintenance. The book's intuition is the product rule (u&middot;v)' = u'v + uv': the change in a join comes from changes on either side. For discrete changes the exact rule has a cross term, &Delta;(A&#8904;B) = &Delta;A&#8904;B + A&#8904;&Delta;B + &Delta;A&#8904;&Delta;B, which the derivative analogy drops. The order of changes matters (follow then unfollow is not unfollow then follow), so per-key order must be preserved and both inputs partitioned (or repartitioned) by the join key.`,
      ex: `Twitter-style home timelines (tweets &#8904; follows, grouped by follower): a new tweet goes into every follower's timeline, a deleted tweet comes out of them, a follow adds the followee's recent tweets and an unfollow removes them. Kafka Streams KTable-KTable joins (including foreign-key joins since 2.4) and streaming SQL engines such as Flink SQL, ksqlDB, Materialize and RisingWave maintain views like this.`,
      section: "stream-joins",
    },
    {
      id: "slowly-changing-dimension",
      term: "Slowly changing dimension (time-dependent join)",
      def: `When the table side of a join changes over time (tax rates, prices, user profiles), an event should usually be joined with the version that was valid at the event's time. The fix: give each version its own ID and store that ID in the event, or use a temporal join. The join becomes deterministic, but all versions must be kept, so log compaction is impossible.`,
      problem: `Stream joins against changing state are nondeterministic: reprocessing old events, or a different interleaving of the inputs, joins them with the wrong version.`,
      why: `There is no ordering guarantee across two input streams, so without versioning the result depends on how they happened to interleave: running the same job on the same input can give a different answer, and a replay of history joins old events with today's values. Temporal joins solve this inside the engine but must wait until the table side has progressed past each event's time, which adds latency.`,
      ex: `Germany cut its VAT rate from 19% to 16% (and the reduced rate from 7% to 5%) from 1 July to 31 December 2020. Reprocessing June sales in December against the current rate table would apply 16% to sales taxed at 19%. Storing the rate version in each invoice, or a temporal join as of the sale time, gets it right; Kafka Streams added versioned state stores in 3.5 for this kind of join.`,
      section: "stream-joins",
    },

    // ---- fault-tolerance ----
    {
      id: "delivery-semantics",
      term: "At-most-once / at-least-once / exactly-once",
      def: `What a crash does to processing. <strong>At-most-once</strong> records progress before processing, so events can be lost. <strong>At-least-once</strong> records progress after processing, so events can be processed twice. <strong>Exactly-once</strong>, better called effectively-once, makes the visible effect as if each event were processed once.`,
      problem: `A consumer can crash between doing the work and recording that it did it; you have to choose which side of that gap to fail on.`,
      why: `Batch gets exactly-once results for free by discarding a failed task's output and rerunning it; a stream processor cannot wait for its input to end before making output visible. Most pipelines run at-least-once with idempotent consumers; at-most-once suits lossy telemetry; effectively-once needs atomic commit of output and offset, or idempotence. The guarantee holds end to end only if every hop provides it.`,
      ex: `A consumer that commits offset 501 and then crashes while processing record 500 never processes it (at-most-once). One that writes its result and crashes before committing processes the record again after restart (at-least-once): a revenue counter double-counts, a welcome email goes out twice.`,
      section: "fault-tolerance",
    },
    {
      id: "exactly-once-semantics",
      term: "Exactly-once semantics",
      def: `<strong>Effectively-once</strong>: an event may be processed more than once internally, but the visible effect (state, outputs, offsets) is as if it were processed exactly once. The book's techniques: <strong>microbatching or checkpointing</strong> (discard and redo a failed unit of work), <strong>atomic commit</strong> of outputs, state changes and input offsets together, and <strong>idempotence</strong> (re-applying a change is harmless).`,
      problem: `Retries after crashes either lose events or apply them twice, corrupting counters, balances and outputs.`,
      why: `Atomic commit needs the output and the offset in the same transactional system: Kafka transactions cover writes to Kafka topics plus the consumer-offset commit; for a database sink, store the offset in the same database transaction, use idempotent upserts, or a two-phase-commit sink. Idempotent replay needs the same replay order, deterministic processing and no concurrent writers, so zombie instances must be fenced (Kafka uses the <code>transactional.id</code> and an epoch). It never covers external side effects such as emails or payment API calls unless they are idempotent (idempotency keys) or transactional. And it costs latency: output becomes visible only when the transaction or checkpoint commits.`,
      ex: `Kafka 0.11 (2017) added the idempotent producer and transactions; consumers with <code>isolation.level=read_committed</code> see only committed output, and Kafka Streams exposes it as <code>processing.guarantee=exactly_once_v2</code>. Since Kafka 3.0 the producer is idempotent by default. Flink checkpoints with two-phase-commit sinks (since Flink 1.4) give end-to-end exactly-once into Kafka.`,
      section: "fault-tolerance",
    },
    {
      id: "microbatching",
      term: "Microbatching",
      def: `Splitting a stream into small batches (about one second in Spark Streaming) and processing each as a tiny batch job, so the batch rule "discard and rerun a failed batch" gives fault tolerance. It implies processing-time tumbling windows of the batch size.`,
      problem: `Batch-style fault tolerance needs a bounded input, but a stream never ends.`,
      why: `Simple and robust, but the batch size is a compromise: smaller batches cost more scheduling and coordination, larger ones delay results. Batch boundaries are processing-time, so jobs that need longer or event-time windows must carry state from one batch to the next. Spark Structured Streaming does exactly that and supports event-time windows and watermarks since 2.1, so microbatching does not rule out event time. Like checkpointing, it only protects state and output inside the framework.`,
      ex: `The original Spark Streaming (DStreams) with batches of about a second. Structured Streaming kept micro-batching as its default engine and added an experimental continuous-processing mode in Spark 2.3 (2018) for lower latency.`,
      section: "fault-tolerance",
    },
    {
      id: "checkpointing",
      term: "Checkpointing (distributed snapshots)",
      def: `Periodically saving a consistent snapshot of all operator state and input offsets to durable storage, triggered by barriers that flow with the data (Flink, based on a variant of the Chandy-Lamport algorithm). After a crash the job restores the last checkpoint and replays from its offsets.`,
      problem: `Stateful operators accumulate hours of state that must survive a crash consistently with the input position, without stopping the stream.`,
      why: `Unlike microbatching it does not force a window size, and barriers make the snapshot consistent without pausing the stream: an operator snapshots its state when the barrier has arrived on all of its inputs, then forwards it, and the checkpoint is complete when every sink has acknowledged it. Output already sent outside (a database write, an email) between the checkpoint and the crash cannot be taken back, so external sinks need transactions tied to checkpoints or idempotence. Under backpressure, aligned barriers queue behind buffered data and checkpoints slow down; Flink 1.11's unaligned checkpoints store the in-flight data instead.`,
      ex: `Flink's asynchronous barrier snapshotting (Carbone et al., 2015) is a variant of Chandy-Lamport (1985); state is written to durable storage such as S3 or HDFS, with incremental RocksDB checkpoints for large state. Two-phase-commit sinks pre-commit a transaction at each checkpoint and commit it when the checkpoint completes.`,
      section: "fault-tolerance",
    },
    {
      id: "stateful-stream-processing",
      term: "Stateful stream processing",
      def: `Operators that remember things between events: counters and window aggregates, join tables, deduplication sets, materialized views. That state must be recovered after a crash, consistently with the input position, so that nothing is lost or applied twice.`,
      problem: `Aggregations, joins and views need memory of past events, and that memory must survive process crashes without being lost or double-applied.`,
      why: `Recovery options: keep state in a remote, replicated database (simple, but a network round trip per event); keep it local and snapshot it periodically to durable storage (Flink); keep it local and log every change to a compacted changelog topic, much like CDC (Kafka Streams, Samza); process every input redundantly on several nodes (VoltDB); or rebuild it from the input (a short window can be recomputed by replaying its events, and a CDC-maintained table from its compacted topic). Which is best depends on whether network or disk is faster in your environment; there is no universal answer.`,
      ex: `Kafka Streams keeps state in RocksDB, rebuilds a failed instance's stores by replaying their changelog topics, and can keep standby replicas warm to shorten failover. Flink restores keyed state from its last completed checkpoint.`,
      section: "fault-tolerance",
    },
  ],

  cheatsheet: [
    {
      title: "Batch vs stream",
      type: "table",
      headers: ["", "Batch (Chapter 10)", "Stream (Chapter 11)"],
      rows: [
        ["Input", "Bounded: files or a snapshot, all known in advance", "Unbounded: events keep arriving"],
        ["Unit", "A file, written once, read by many jobs", "An event, produced once, read by many consumers"],
        ["Grouping", "A directory or table", "A topic (stream), split into partitions"],
        ["Knows when it's done?", "Yes: end of input", "Never: emit per event, or when a window closes"],
        ["Aggregates and joins", "Over the whole input; sort-merge works", "Over windows or retained state; an unbounded input cannot be sorted"],
        ["Fault tolerance", "Rerun the failed task, discard its output", "Checkpoints, atomic commits, idempotence (output is already visible)"],
        ["Latency", "Minutes to days", "Milliseconds to seconds"],
        ["Rerun after a bug fix", "Rerun on the same input", "Replay a retained log; event-time windows make it reproducible"],
      ],
      note: "Notify, don't poll: 50 consumers polling once a second is about 4.3 million queries a day, nearly all of them empty.",
    },
    {
      title: "Overload choices",
      type: "list",
      items: [
        "<strong>Drop</strong>: StatsD metrics over UDP, sampling. Fast and lossy; only for data where loss is tolerable, and count what you drop.",
        "<strong>Buffer</strong>: broker queues (RabbitMQ, SQS), logs up to retention (Kafka). Then ask what happens when the buffer fills: crash, spill to disk and slow down, or lose data.",
        "<strong>Backpressure</strong>: Unix pipes (64 KiB buffer on Linux), TCP flow control, Reactive Streams <code>request(n)</code>, Flink's credit-based flow control. Lossless and bounded, but the producer runs at the slowest consumer's speed.",
        "<strong>Crashes</strong>: durability (disk writes, replication) costs throughput and latency; decide which data may be lost.",
      ],
    },
    {
      title: "Queue-style (AMQP/JMS) vs log-based brokers",
      type: "table",
      headers: ["", "AMQP/JMS (RabbitMQ, ActiveMQ; SQS similar)", "Log-based (Kafka, Kinesis, Pulsar)"],
      rows: [
        ["Storage", "Can be durable, but deleted once acknowledged", "Retained by time/size (Kafka default 7 days) or compacted"],
        ["Replay", "No: acknowledged messages are gone", "Yes: reset the offset"],
        ["New subscriber", "Gets only messages published from now on", "Can start at offset 0 (whatever is retained)"],
        ["Ordering", "Ordered per queue, but load balancing + redelivery reorders", "Strict within a partition only; none across partitions"],
        ["Consumer bookkeeping", "Per-message acks tracked by the broker", "One offset per partition per group"],
        ["Parallelism", "Per message: any number of consumers", "Per partition: max consumers = partitions"],
        ["Slow message", "Only delays itself", "Blocks its partition (head-of-line)"],
        ["Slow consumer", "Queue grows; broker under memory/disk pressure", "Only that group lags; data lost if lag passes retention"],
        ["Throughput", "Degrades when large backlogs spill to disk", "Roughly constant regardless of backlog (sequential disk I/O)"],
        ["Independent consumers", "One queue per consumer type (fanout exchange, topic subscription)", "Natural: one consumer group per application"],
        ["Best for", "Expensive, independent tasks on a worker pool", "High-volume event streams, per-key order, replay"],
      ],
      note: "Converging: RabbitMQ Streams (3.9, 2021) add a replayable log type; Kafka share groups (KIP-932, early access in 4.0, production-ready in 4.2) add queue-style consumption.",
    },
    {
      title: "Queue or log? Decision guide",
      type: "list",
      items: [
        "Need replay, a new consumer that reads history, or several independent consumers &rarr; <strong>log</strong>.",
        "Need per-entity order &rarr; <strong>log keyed by entity ID</strong> (a queue keeps order only with one consumer).",
        "Messages are expensive and independent, and you want per-message parallelism, retries and a dead-letter queue &rarr; <strong>queue</strong>.",
        "Processing time varies widely and one slow message must not block others &rarr; <strong>queue</strong>.",
        "Both needs &rarr; the log as the system of record, plus a consumer that enqueues tasks.",
        "Either way delivery is at-least-once &rarr; make consumers idempotent.",
      ],
    },
    {
      title: "Why Kafka is fast",
      type: "list",
      items: [
        "<strong>Sequential I/O</strong>: appends to segment files and sequential reads; no random seeks, no per-message index updates.",
        "<strong>OS page cache</strong> instead of an in-process cache: consumers near the tail read from memory, and the cache survives a broker process restart.",
        "<strong>Batching end to end</strong>: producers batch per partition and compress per batch; brokers store and serve whole batches; consumers fetch in bulk.",
        "<strong>Zero-copy</strong> <code>sendfile</code> from page cache to socket for plaintext connections; not with TLS, where data must be encrypted in user space.",
        "<strong>Cheap bookkeeping</strong>: one offset per partition per group instead of per-message acks.",
        "<strong>Partitions</strong> spread load across brokers and disks; consumers pull at their own pace.",
        "<strong>Breaks down</strong> when lagging consumers read cold segments and churn the page cache, with tiny unbatched sends, slow followers under <code>acks=all</code>, or very many partitions per broker.",
      ],
    },
    {
      title: "Numbers to know",
      type: "list",
      items: [
        "A 6 TB disk written sequentially at 150 MB/s fills in about 11 h (6&times;10<sup>12</sup> &divide; 1.5&times;10<sup>8</sup> = 40,000 s): the book's illustration that a log can buffer days of data, not a benchmark.",
        "Kafka default retention: 7 days (<code>log.retention.hours=168</code>). Committed offset = next record to read.",
        "Kafka consumer <code>max.poll.interval.ms</code>: 5 min by default; exceed it and the consumer is removed from the group (rebalance).",
        "Kinesis shard: 1 MB/s or 1,000 records/s of writes; retention 24 h by default, up to 7 days, or up to 365 days with long-term retention.",
        "SQS: visibility timeout 30 s by default; retention up to 14 days; FIFO deduplication window 5 min.",
        "DynamoDB Streams: 24 h retention. Linux pipe buffer: 64 KiB.",
        "Spark Streaming microbatches: about 1 s.",
        "HyperLogLog (Redis): 0.81% standard error in at most 12 KB per key.",
        "LinkedIn's Kafka: more than 7 trillion messages a day (2019).",
      ],
    },
    {
      title: "Formulas",
      type: "list",
      items: [
        "<code>partition = hash(key) mod N</code>: adding partitions remaps most keys and breaks per-key order across the change.",
        "<code>max useful consumers per group = number of partitions</code>",
        "<code>lag = log-end offset &minus; committed offset</code>: data is lost once the age of the oldest unread record exceeds retention.",
        "<code>time to fill a disk = capacity &divide; write rate</code> (6 TB &divide; 150 MB/s &asymp; 11 h).",
        "<code>windows per event (hopping) = window length &divide; hop</code>: a 24 h window with a 1 min hop puts each event in 1,440 windows, so combine panes instead of copying events.",
        "<code>stream-stream join state &asymp; event rate &times; window length &times; event size</code>, for each side.",
        "<code>watermark &asymp; max event time seen &minus; allowed delay</code>; an operator's watermark is the minimum of its input watermarks.",
        "<code>&Delta;(A&#8904;B) = &Delta;A&#8904;B + A&#8904;&Delta;B + &Delta;A&#8904;&Delta;B</code>: the book's product rule (u&middot;v)' = u'v + uv' is the intuition; it drops the cross term.",
      ],
    },
    {
      title: "Dual writes vs CDC vs outbox vs 2PC",
      type: "table",
      headers: ["", "Dual writes", "CDC on the tables", "Outbox + CDC", "2PC / XA"],
      rows: [
        [`<span style="white-space:nowrap">Consistency</span>`, "Can diverge permanently, silently", "Derived systems converge", "Converges; state and event commit atomically", "Atomic across systems"],
        [`<span style="white-space:nowrap">Ordering</span>`, "Each system may apply writes in a different order", "Source commit order (per key in the topic)", "Commit order of the outbox", "Decided per transaction by the coordinator"],
        [`<span style="white-space:nowrap">Latency</span>`, "Both writes in the request path", "Asynchronous: derived systems lag", "Asynchronous, like CDC", "Synchronous, extra round trips, locks held while prepared"],
        [`<span style="white-space:nowrap">Complexity</span>`, "Looks simple; failure handling is the hard part", "Run a connector; consumers see the internal schema", "Outbox table + connector; stable domain events", "Coordinator and in-doubt recovery; often unsupported (Kafka has no XA)"],
        [`<span style="white-space:nowrap">Failure behavior</span>`, "Crash between writes = missing update, no error", "Connector restarts from its offset; at-least-once", "Same as CDC; consumers dedupe by event ID", "Coordinator failure leaves participants blocked in doubt"],
        [`<span style="white-space:nowrap">Use when</span>`, "Never for data that must agree", "Syncing caches, search, warehouse", "A service must publish domain events reliably", "Rarely; both sides support it and you accept the cost"],
      ],
    },
    {
      title: "CDC vs event sourcing",
      type: "table",
      headers: ["", "CDC", "Event sourcing"],
      rows: [
        ["Source of truth", "The database (the log is derived from it)", "The event log"],
        ["Who writes the events", "Extracted from the DB's replication log; the app need not know", "The application, deliberately"],
        ["Granularity", "Row-level changes shaped by the schema", "Business-level events (\"OrderPlaced\")"],
        ["Mutability", "The app updates and deletes rows freely", "Append-only; corrections are new events"],
        ["Who validates?", "The database's constraints, at write time", "Commands, validated before the event is appended; consumers cannot reject events"],
        ["Can the log be compacted?", "Yes: the latest value per key is the full row", "No: needs the full history, or snapshots"],
        ["Bootstrapping a consumer", "Snapshot at a log position, or a compacted topic", "Replay all events (from a snapshot to speed up)"],
        ["Typical use", "Keep search, caches and the warehouse in sync", "Audit, domain modeling, new views from old events"],
      ],
    },
    {
      title: "Log compaction in one look",
      type: "list",
      items: [
        "Keeps at least the <strong>latest value per key</strong>; older values for the same key are discarded in the background.",
        "A <strong>tombstone</strong> (key with a null value) deletes the key; tombstones are removed after <code>delete.retention.ms</code>.",
        "Size depends on the current data, not on total writes; a new consumer reads from offset 0 and has a full copy.",
        "Needs keyed records carrying full values (CDC events, state-store changelogs); useless for event-sourced logs.",
        "Not time-based deletion, and not a way to delete one record by offset.",
      ],
    },
    {
      title: "Three timestamps to fix device clocks",
      type: "note",
      body: `<p>Log (1) when the event occurred and (2) when it was sent, both by the <strong>device</strong> clock, and (3) when it was received, by the <strong>server</strong> clock.</p>
<p><span class="formula">offset &asymp; receive time (3) &minus; send time (2)</span></p>
<p><span class="formula">true event time &asymp; event time (1) + offset</span></p>
<p>Assumes network delay is small compared with the accuracy you need.</p>`,
    },
    {
      title: "Windowing types",
      type: "table",
      headers: ["Window", "Definition", "Example", "State / implementation", "Typical use"],
      rows: [
        ["Tumbling", "Fixed length, no overlap; each event in exactly one window", "1 min: 10:03:00&ndash;10:03:59, 10:04:00&ndash;10:04:59", "One accumulator per key per window; round the timestamp down", "Orders per minute, billing buckets"],
        ["Hopping", "Fixed length, overlapping, aligned to a hop", "5 min every 1 min: 10:03:00&ndash;10:07:59, 10:04:00&ndash;10:08:59", "Each event in length &divide; hop windows; combine hop-sized tumbling panes", "Smoothed rates for alerting"],
        ["Sliding (book's sense)", "All events within some interval of each other; not aligned to the clock", "Events at 10:03:39 and 10:08:12 fall in one 5 min window", "Time-sorted buffer per key; evict events as they expire", "3 failed logins within 60 s"],
        ["Session", "Per key, no fixed length; ends after a gap of inactivity", "Close after 30 min with no activity", "Open sessions per key; a late event can merge two sessions", "Website visit analytics"],
      ],
      note: "Naming trap: Flink and Beam call the book's hopping window a \"sliding window\". Define every window on event time and close it with a watermark.",
    },
    {
      title: "Handling late events",
      type: "list",
      items: [
        "<strong>Drop and count</strong>: ignore stragglers, but track the dropped count as a metric and alert if the rate rises.",
        "<strong>Correct</strong>: publish an updated result for the window (upsert keyed by key + window), retracting the old one if needed.",
        "<strong>Allowed lateness and side outputs</strong> (Flink): keep windows updatable for a while; route later events elsewhere.",
        "<strong>Watermark</strong> = max event time seen &minus; allowed delay; an operator's watermark = min of its inputs, so an idle partition stalls everything.",
        "<strong>Session windows</strong> can merge when a late event bridges two sessions: earlier output may be retracted.",
      ],
    },
    {
      title: "Stream join types",
      type: "table",
      headers: ["Type", "Example", "State kept", "Time-dependence", "Batch analogue"],
      rows: [
        [`<span style="white-space:nowrap">Stream-stream</span> <span style="white-space:nowrap">(window)</span>`, "Searches &#8904; clicks by session ID within 1 h", "Both sides, for the window (rate &times; window)", "The window decides matches; a click can arrive before its search", "Reduce-side join restricted to a time window"],
        [`<span style="white-space:nowrap">Stream-table</span> <span style="white-space:nowrap">(enrichment)</span>`, "Page views &#8904; user profiles (add country)", "A local copy of the table, kept current by CDC", "Which table version? Slowly changing dimension: versioned IDs or temporal joins", "Map-side hash join (broadcast = GlobalKTable, partitioned = KTable) whose table keeps changing"],
        [`<span style="white-space:nowrap">Table-table</span> (view <span style="white-space:nowrap">maintenance)</span>`, "Tweets &#8904; follows = home timelines", "Both tables, in full", "Order of changes matters (follow then unfollow &ne; unfollow then follow)", "Incremental maintenance of a materialized join view"],
      ],
      note: "Inputs must be co-partitioned by the join key (same partition count and partitioner), except a broadcast table. Without versioning, joins are nondeterministic on replay.",
    },
    {
      title: "Delivery semantics",
      type: "table",
      headers: ["Guarantee", "When progress is recorded", "A crash causes", "Typical use"],
      rows: [
        ["At-most-once", "Commit offset, then process", "Lost events", "Metrics sampling, telemetry"],
        ["At-least-once", "Process, then commit offset", "Duplicates (everything since the last commit is re-processed)", "Most pipelines, with idempotent consumers"],
        ["Effectively-once (\"exactly-once\")", "Output + offset atomically, or an idempotent sink", "Neither, within the system", "Kafka transactions; Flink checkpoints + 2PC sinks"],
      ],
    },
    {
      title: "Achieving exactly-once",
      type: "list",
      items: [
        "<strong>Microbatching</strong> (Spark, ~1 s batches): rerun a failed batch, discard its output.",
        "<strong>Checkpoint barriers</strong> (Flink, a variant of Chandy-Lamport): snapshot state + offsets; restore and replay.",
        "<strong>Atomic commit</strong>: outputs, state changes and offsets all or nothing (Kafka transactions since 0.11, 2017; <code>read_committed</code> consumers).",
        "<strong>Idempotence</strong>: store the consumer offset with each external write and skip replays at or below it, or upsert by event ID.",
        "<strong>Requirements</strong>: same replay order, deterministic processing, no concurrent writers.",
        "<strong>Fence zombies</strong>: Kafka bumps an epoch per <code>transactional.id</code> and rejects the old instance.",
        "<span class=\"hl-bad\">External side effects (emails, payment APIs) are NOT covered</span>: use idempotency keys or a separate idempotent service.",
      ],
    },
    {
      title: "Where the offset lives",
      type: "note",
      body: `<p>Atomic output + offset requires both in <strong>one transactional system</strong>.</p>
<ul><li><strong>Kafka outputs</strong>: Kafka transactions commit output messages and consumer offsets together.</li><li><strong>Database sink</strong>: store the offset in the sink's own transaction and seek to it on restart.</li><li><strong>Anything else</strong>: make the sink idempotent (store the last applied offset with the value, or upsert by event ID), or use a two-phase-commit sink tied to checkpoints.</li></ul>
<p>Kafka transactions do not make a write to an external database atomic.</p>`,
    },
    {
      title: "Rebuilding operator state",
      type: "table",
      headers: ["Approach", "Systems", "Trade-off"],
      rows: [
        ["Remote replicated store", "Any database or key-value store", "Simple recovery; a network round trip per event"],
        ["Local state + periodic snapshots", "Flink (checkpoints to S3/HDFS)", "Fast local access; restore = load snapshot + replay since it"],
        ["Local state + changelog topic", "Kafka Streams, Samza (compacted topics, standby replicas)", "CDC for operator state; restore by replaying the changelog"],
        ["Redundant processing", "VoltDB", "No restore delay; every message processed several times"],
        ["Recompute from input", "Short windows; CDC-maintained tables", "Nothing to replicate; replay the window or the compacted topic"],
      ],
      note: "No universal winner: it depends on whether network or disk is faster in your environment.",
    },
    {
      title: "Changed since the book (2017)",
      type: "list",
      items: [
        "<strong>Kafka 0.11 (2017)</strong>: idempotent producer and transactions (the book describes them as planned); idempotence on by default since 3.0.",
        "<strong>KRaft</strong> production-ready in Kafka 3.3 (2022); ZooKeeper removed in 4.0 (2025); 4.0 also made the KIP-848 consumer group protocol generally available.",
        "<strong>Tiered storage</strong> (KIP-405, early access in 3.6, production-ready in 3.9): old segments in object storage, so retention is no longer bounded by local disks.",
        "<strong>Share groups</strong> (KIP-932, early access in Kafka 4.0, production-ready in 4.2): queue-style consumption, with per-record acknowledgment and several consumers per partition.",
        "<strong>Cooperative rebalancing</strong> and foreign-key KTable joins (Kafka 2.4); versioned state stores (3.5).",
        "<strong>Native change feeds</strong>: PostgreSQL 10 logical replication and MongoDB 3.6 change streams (2017); outbox pattern with Debezium.",
        "<strong>Flink</strong>: two-phase-commit sinks (1.4, 2017), unaligned checkpoints (1.11, 2020). <strong>Spark</strong>: Structured Streaming, with event-time watermarks since 2.1, superseded DStreams.",
        "<strong>Streaming SQL</strong>: Flink SQL, ksqlDB, Materialize, RisingWave maintain views incrementally.",
        "<strong>GDPR</strong> (May 2018): the right to erasure forces immutable-log systems to plan for real deletion.",
      ],
    },
  ],

  interview: [
    // ---- why-streams ----
    {
      id: "q-why-not-frequent-batch",
      q: "Your nightly batch job makes a dashboard a day stale. Why not just run it every minute instead of adopting stream processing?",
      diff: "easy",
      section: "why-streams",
      a: `<p>Running the batch more often trades staleness for overhead, and it never fully closes the gap.</p>
<ul><li><strong>Fixed cost per run</strong>: every run pays for scheduling, startup and re-reading its inputs; at one-minute intervals that overhead dominates.</li><li><strong>Polling</strong>: each run has to discover new data by querying a table or listing a directory. The more often you poll, the more polls find nothing: 50 consumers polling once a second make about 4.3 million queries a day.</li><li><strong>Still stale</strong>: results are up to one interval plus the run time old, so a stolen card can still be used until the next run.</li><li><strong>Arbitrary boundaries</strong>: activity that spans a boundary (a session, a click shortly after its search) gets split across runs, and late data needs special handling anyway.</li></ul>
<p>Stream processing turns this around: a broker <strong>notifies</strong> consumers when an event arrives, and the processor keeps state (windows, join tables) between events, so each result changes seconds after the event that affects it.</p>
<p><strong>When frequent batch is fine</strong>: if hourly freshness is enough, volumes are modest and the logic is a full recomputation, a scheduled job is simpler to build and reason about. Many teams run both: a stream for fresh numbers and batch for complete, recomputable ones.</p>`,
      followups: [
        "What does a stream processor have to give up because its input never ends?",
        "How would you get both fresh and fully correct numbers?",
        "What does 'real-time' mean for a stream processor?",
      ],
      pitfalls: [
        "'Streaming is always better than batch'",
        "Ignoring the per-run overhead and polling cost of tiny batches",
        "Equating 'real-time' streaming with hard real-time guarantees",
      ],
    },

    // ---- messaging-systems ----
    {
      id: "q01",
      q: "What's the difference between a traditional message broker and Kafka?",
      diff: "medium",
      section: "messaging-systems",
      a: `<p>The difference is what happens after a message is read.</p>
<p><strong>Queue-style broker (AMQP/JMS: RabbitMQ, ActiveMQ; SQS is similar)</strong>: the broker delivers a message, waits for an acknowledgment and then deletes it. Messages can be persisted to disk, but once acknowledged they are gone.</p>
<ul><li>Work is shared message by message: any number of consumers, each message to one of them; a slow message only delays itself.</li><li>No replay, and a new subscriber sees only future messages.</li><li>Ordering: a queue with a single consumer is ordered, but load balancing plus redelivery reorders (consumer B crashes on m3 after A has started m4).</li><li>The broker tracks per-message state and works best with a small backlog; throughput degrades when a large backlog spills to disk.</li></ul>
<p><strong>Log-based broker (Kafka, Kinesis, Pulsar)</strong>: messages are appended to a partitioned, replicated log and kept for a retention period (7 days by default in Kafka) or compacted. Consumers track an offset; reading deletes nothing.</p>
<ul><li>Fan-out is free: many consumer groups read the same topic independently, at their own speed.</li><li>Replay is moving an offset back: reprocess after a bug fix, or bootstrap a new consumer from history.</li><li>Order is strict <strong>within a partition</strong> and absent across partitions; key by entity ID to keep each entity's events in order.</li><li>Throughput stays roughly constant regardless of backlog (sequential disk I/O, one offset per partition per group).</li></ul>
<p><strong>The log's costs</strong>: a group's parallelism is capped at the partition count, and a slow or poison message blocks its partition (head-of-line blocking).</p>
<p><strong>Rule of thumb</strong>: a log for high-volume event streams with several independent consumers, per-key order or replay; a queue for expensive, independent tasks spread over a worker pool. The families are converging: RabbitMQ Streams (3.9, 2021) add a replayable log, and Kafka share groups (KIP-932, early access in 4.0, production-ready in 4.2) add queue-style consumption.</p>`,
      followups: [
        "When would you still choose RabbitMQ or SQS?",
        "What happens with more consumers than partitions?",
        "How do you add a new consumer that needs last month's data?",
      ],
      pitfalls: [
        "Saying Kafka guarantees global order",
        "Saying traditional brokers cannot persist messages",
        "Saying Kafka keeps messages forever by default",
      ],
    },
    {
      id: "q-queue-or-log",
      q: "An 'OrderPlaced' event must be consumed by three independent services (billing, search indexing, analytics), and you also need a pool of workers that render and send invoice PDFs. Would you use Kafka, RabbitMQ/SQS, or both? Why?",
      diff: "medium",
      section: "messaging-systems",
      a: `<p>Reason from the properties each consumer needs, not from brands. There are two different workloads here.</p>
<p><strong>OrderPlaced for billing, search and analytics: a log (Kafka, Kinesis, Pulsar).</strong></p>
<ul><li><strong>Fan-out with independent progress</strong>: one consumer group per service, so a slow analytics job never delays billing.</li><li><strong>Replay</strong>: a fourth service added next year, or a service fixing a bug, can reprocess history (given enough retention, tiered storage or an archive).</li><li><strong>Per-order ordering</strong>: key by order ID so OrderPlaced, OrderPaid and OrderCancelled for one order stay in sequence.</li></ul>
<p><strong>Invoice PDF rendering: a queue (SQS, RabbitMQ).</strong></p>
<ul><li>Each job is expensive and independent, and order does not matter, so you want to parallelize message by message across as many workers as you like.</li><li>Acks or visibility timeouts redeliver a job if its worker dies, and a dead-letter queue catches a PDF that crashes the renderer every time.</li><li>In Kafka, parallelism would stop at the partition count, and one slow PDF would stall every message behind it in its partition.</li></ul>
<p><strong>"Both" is a legitimate answer</strong>: the order log is the system of record, and a small consumer reads it and enqueues render jobs.</p>
<p><strong>In both cases</strong> delivery is at-least-once, so consumers must be idempotent: deduplicate by order or event ID, and make the PDF write an overwrite keyed by order ID. For the log, monitor consumer lag against retention.</p>`,
      followups: [
        "How would a fourth service, added in six months, get historical orders?",
        "What happens to ordering if you later increase the topic's partition count?",
        "How do you handle a PDF job that crashes the worker every time?",
      ],
      pitfalls: [
        "Choosing Kafka 'because it is faster' without discussing replay, ordering or consumer groups",
        "Assuming a queue preserves order with several competing consumers",
        "Forgetting that extra Kafka consumers beyond the partition count are idle",
        "Ignoring duplicate deliveries",
      ],
    },
    {
      id: "q-backpressure",
      q: "A downstream consumer is slower than its producer. What are the options, and how do Kafka-based pipelines and engines like Flink handle it?",
      diff: "medium",
      section: "messaging-systems",
      a: `<p>There are only three options when a producer outpaces its consumer:</p>
<ul><li><strong>Drop</strong> (or sample): fine for metrics and telemetry; StatsD over UDP accepts silent loss. Count what you drop.</li><li><strong>Buffer</strong>: a queue or log absorbs bursts. The question becomes what happens when it fills: crash, spill to disk and slow down, or start dropping.</li><li><strong>Backpressure</strong> (flow control): block or slow the producer. Unix pipes (a 64 KiB buffer on Linux) and TCP windows do this; Reactive Streams makes it explicit with <code>request(n)</code>.</li></ul>
<p><strong>Kafka-based pipelines</strong> decouple the two sides. Producers are never slowed by consumers, consumers pull at their own pace, and the backlog sits on disk. Lag is the signal to scale or alert, and retention is the hard deadline: data older than that is deleted whether or not anyone read it. The producer client blocks <code>send()</code> only when its own local buffer (<code>buffer.memory</code>) is full, for up to <code>max.block.ms</code>; broker quotas are a separate, explicit throttle.</p>
<p><strong>Inside Flink</strong>, operators exchange data through bounded network buffers with credit-based flow control. A slow operator stops granting credits, upstream buffers fill, and eventually the sources simply read from Kafka more slowly, which is safe precisely because Kafka holds the data. RabbitMQ buffers by default and blocks publishing connections when its memory or disk alarm fires.</p>
<p><strong>Choose per data type</strong>: sample metrics, never drop payments, and never put an unbounded in-memory queue inside a consumer. Distinguish backpressure (one slow stage, visible as full buffers upstream of it) from under-provisioning (every stage is busy).</p>`,
      followups: [
        "What happens to Flink's checkpoints under sustained backpressure, and how do unaligned checkpoints help?",
        "Where should buffering live: in the producer, the broker, or the consumer?",
        "How do you tell whether a pipeline is backpressured or just under-provisioned?",
      ],
      pitfalls: [
        "Unbounded in-memory queues in the consumer",
        "Assuming Kafka throttles producers because a consumer is slow (it does not; quotas are a separate mechanism)",
        "Dropping data silently instead of counting what was dropped",
      ],
    },

    // ---- log-based-brokers ----
    {
      id: "q-kafka-throughput",
      q: "Why can Kafka sustain very high throughput on ordinary disks, and where does that break down?",
      diff: "medium",
      section: "log-based-brokers",
      a: `<p><strong>Why it is fast</strong>:</p>
<ul><li><strong>Sequential I/O</strong>: appends to the end of segment files and sequential reads; no random seeks and no per-message index maintenance. Sequential disk access is far faster than random access, especially on spinning disks.</li><li><strong>The OS page cache</strong> instead of an in-process cache: consumers near the tail read from memory, there is no double caching or garbage-collection pressure on the JVM heap, and the cache stays warm across a broker process restart.</li><li><strong>Batching everywhere</strong>: producers accumulate records per partition (<code>linger.ms</code>, <code>batch.size</code>) and compress whole batches; brokers store and serve the batches as they are; consumers fetch in bulk.</li><li><strong>Zero-copy</strong>: for plaintext connections, <code>sendfile</code> moves data from the page cache to the socket without copying it through user space. With TLS the broker must encrypt in user space, so zero-copy does not apply.</li><li><strong>Cheap consumer bookkeeping</strong>: one offset per partition per group, not per-message acknowledgment state.</li><li><strong>Partitions</strong> spread load across brokers and disks, and consumers pull at their own pace.</li></ul>
<p><strong>Where it breaks down</strong>:</p>
<ul><li>A consumer replaying a week-old backlog reads cold segments from disk and evicts the tail from the page cache, slowing everyone reading recent data (tiered storage moves that load elsewhere).</li><li>Tiny messages sent one at a time, synchronously, without batching.</li><li><code>acks=all</code> waits for the in-sync replicas, so a slow follower adds latency: the price of durability.</li><li>Very many partitions per broker: metadata, open files and recovery time grow (KRaft raised the practical ceiling).</li><li>Compaction and tiered-storage fetches add background I/O.</li></ul>
<p>The book's arithmetic shows why long retention is affordable: a 6 TB disk written sequentially at 150 MB/s takes about 11 hours to fill, and real write rates are far lower, so days or weeks of history fit.</p>`,
      followups: [
        "What do acks=0, acks=1 and acks=all trade off?",
        "Why is the OS page cache a better fit for Kafka than an in-process cache?",
        "What happens to throughput when one consumer group is replaying a week-old backlog?",
      ],
      pitfalls: [
        "'Kafka keeps everything in memory'",
        "Assuming disks are inherently too slow, without distinguishing sequential from random I/O",
        "Claiming zero-copy applies to TLS connections",
      ],
    },
    {
      id: "q-ordering-per-user",
      q: "How do you guarantee that all events for a given user are processed in order through a Kafka pipeline, and what can silently break that guarantee?",
      diff: "hard",
      section: "log-based-brokers",
      a: `<p><strong>The mechanism</strong>: use the user ID as the message key. The default partitioner computes hash(key) mod partitions, so all of a user's events go to one partition, where the broker assigns increasing offsets; within a consumer group exactly one consumer reads that partition, sequentially. Order is guaranteed per partition only, never across a topic or across topics.</p>
<p><strong>What silently breaks it</strong>:</p>
<ul><li><strong>Adding partitions</strong>: hash mod N changes, so a user's old events sit in one partition and new ones in another, and a consumer can see them out of order across the change.</li><li><strong>Producer retries</strong> with several in-flight requests and no idempotence: a failed batch retried after a later batch succeeded lands out of order. The idempotent producer (on by default since Kafka 3.0) uses per-partition sequence numbers to keep order with up to 5 in-flight requests.</li><li><strong>Concurrent processing in the consumer</strong>: handing one partition's records to a thread pool without serializing per key.</li><li><strong>Re-keying</strong>: a multi-stage pipeline that repartitions by another field and later back by user loses the original order unless it re-sorts.</li><li><strong>Several producers</strong> writing the same user's events (say, the web and mobile backends): the log records append order, not the order things happened.</li><li><strong>Missing keys</strong>: records without a key are spread across partitions.</li></ul>
<p><strong>Not a reordering</strong>: after a consumer failover, the new owner re-reads from the committed offset, in order. That causes duplicates rather than reordering, but side effects may repeat, so processing must be idempotent.</p>
<p>When order across producers matters, carry a per-user sequence number or version in each event so consumers can detect gaps and reject stale updates. For analytics, event-time windows make results independent of arrival order.</p>`,
      followups: [
        "What if the same user's events come from two different services?",
        "How would you handle a user who generates 30% of all traffic?",
        "Does event-time windowing remove the need for ordering?",
      ],
      pitfalls: [
        "Claiming Kafka guarantees total order across a topic",
        "Forgetting that adding partitions remaps keys",
        "Not mentioning the idempotent producer / in-flight retries",
      ],
    },
    {
      id: "q-lagging-consumer-group",
      q: "Your Kafka consumer group's lag keeps growing. You doubled the number of consumers and nothing improved. What are the likely causes and fixes?",
      diff: "medium",
      section: "log-based-brokers",
      a: `<p><strong>Why doubling did nothing</strong>: a partition is consumed by at most one member of a group. If the group already had as many consumers as partitions, the new ones are idle.</p>
<p><strong>Diagnose with per-partition lag</strong> (log-end offset minus committed offset):</p>
<ul><li><strong>All partitions lagging evenly</strong>: under-capacity. Per-message processing is too slow, often because of synchronous calls to a database or API.</li><li><strong>One partition far behind</strong>: a hot key (one customer, one device, or a default value sending a large share of traffic to one partition), or a slow or poison message blocking it. A consumer handles its partitions on one thread, so its other partitions stall too.</li><li><strong>Sawtooth lag and frequent rebalances</strong>: consumers exceed <code>max.poll.interval.ms</code> (5 minutes by default) while processing a batch, get removed from the group, and each eager rebalance pauses everyone.</li></ul>
<p><strong>Fixes</strong>:</p>
<ul><li><strong>More partitions</strong>, so consumers can scale, knowing that adding them remaps keys and breaks per-key order across the change; size the count up front with headroom.</li><li><strong>Faster processing</strong>: batch writes to the sink, use async I/O with bounded concurrency per partition, replace remote lookups with a local table (a stream-table join).</li><li><strong>Hot keys</strong>: a better key, or salting the key (which gives up per-key order) plus a second aggregation step.</li><li><strong>Poison messages</strong>: retry a bounded number of times, then send to a dead-letter topic and move on.</li><li><strong>Rebalances</strong>: smaller poll batches or a longer poll interval, cooperative rebalancing (Kafka 2.4) or the KIP-848 protocol (Kafka 4.0), and static membership for rolling restarts.</li></ul>
<p><strong>Alert on lag measured in time, against retention</strong>: once lag passes retention, unread data is deleted and the consumer silently skips it.</p>`,
      followups: [
        "How do you tell skew from overall under-capacity using metrics?",
        "What breaks if you process messages from one partition on a thread pool?",
        "How long can lag grow before you lose data?",
      ],
      pitfalls: [
        "'Just add consumers'",
        "Not looking at per-partition lag",
        "Salting keys without noticing it breaks per-key ordering",
        "Ignoring retention as a hard deadline",
      ],
    },
    {
      id: "q-reprocess-after-bug",
      q: "A bug in your streaming job produced wrong aggregates for the last three days. How do you fix the output?",
      diff: "medium",
      section: "log-based-brokers",
      a: `<p>A log-based broker keeps the input, so treat the fix like a batch rerun rather than patching numbers by hand.</p>
<ol><li><strong>Check retention</strong>: you need the three bad days plus margin in Kafka, in tiered storage, or as a raw copy in a data lake.</li><li><strong>Deploy the fixed job as a new consumer group</strong>, starting from the offsets at the start of the bad period (Kafka can look up offsets by timestamp), or earlier if its windows need prior state, and writing to a <strong>new</strong> output table or topic.</li><li><strong>Let it catch up</strong> while the old job keeps serving, throttled so the replay does not overwhelm the sink.</li><li><strong>Compare</strong> old and new outputs for the bad period and for recent windows.</li><li><strong>Switch readers</strong> to the new output, then retire the old job and output. Rolling back is switching back.</li></ol>
<p><strong>What makes this work</strong>:</p>
<ul><li><strong>Event-time windows</strong>: a fast replay must put each event in the same window as live processing would have. Processing-time windows give different answers on replay.</li><li><strong>Deterministic processing</strong>: no wall-clock reads, no calls to services whose answers have changed; join against versioned data.</li><li><strong>Idempotent or versioned sinks</strong>, so rewriting a window overwrites rather than adds.</li><li><strong>Capacity</strong> for catch-up throughput.</li></ul>
<p>If retention has expired, recompute the period in batch from archived raw events. Outputs that already left the system (emails, invoices sent to customers) cannot be replayed away and need compensating actions. This is the derived-view migration of the immutability section and the reprocessing approach <a href="#/ch12/learn/reprocessing">Chapter 12</a> builds on.</p>`,
      followups: [
        "What if some outputs were already sent to customers (emails, invoices)?",
        "How do you make sure the replayed job does not overwhelm the sink?",
        "Why does event time matter for this?",
      ],
      pitfalls: [
        "Resetting the production consumer's offsets in place with no way to compare or roll back",
        "Forgetting retention limits",
        "Using processing-time windows, which make replays produce different answers",
      ],
    },

    // ---- change-data-capture ----
    {
      id: "q02",
      q: "Explain CDC (change data capture) and what problem it solves.",
      diff: "medium",
      section: "change-data-capture",
      a: `<p><strong>Change data capture</strong> observes every change committed to a database and publishes it, in commit order, as a stream (usually a Kafka topic) that other systems consume: search indexes, caches, warehouses, other services.</p>
<p><strong>The problem it solves: dual writes.</strong> If the application writes to the database and then to the search index itself, two things go wrong. Concurrent writes can reach the two systems in different orders (the database ends with B, the index with A, and nothing reports an error), and a failure or crash between the writes leaves one updated and the other not. With CDC the database decides the order and every derived system applies the same changes in the same order, so they converge, like followers in leader-based replication.</p>
<p><strong>How it is built</strong>: by parsing the replication log (the MySQL binlog, the PostgreSQL WAL through logical decoding, the MongoDB oplog) rather than with triggers, which are fragile and slow down writes. Tools: Debezium, Maxwell, LinkedIn Databus, Facebook Wormhole, Oracle GoldenGate; built-in feeds such as MongoDB change streams and DynamoDB Streams.</p>
<p><strong>What to get right</strong>:</p>
<ul><li><strong>Bootstrap</strong>: the log is not kept forever, so a new consumer needs a consistent snapshot tied to a log position (then the changes from exactly there), or a compacted topic holding the latest value per key.</li><li><strong>Ordering</strong>: key change events by primary key so each row's changes stay ordered within one partition.</li><li><strong>Deletes</strong>: emitted as tombstones (the key with a null value), which consumers apply as deletes and compaction uses to drop the key.</li><li><strong>Lag</strong>: CDC is asynchronous, so a user who just saved a change may not see it in search yet.</li><li><strong>Coupling</strong>: raw row changes expose the internal schema; the <strong>outbox pattern</strong> publishes deliberate domain events instead.</li><li><strong>Schema changes</strong>: evolve them with Avro or Protobuf and a schema registry (<a href="#/ch4/learn/merits-of-schemas">Chapter 4</a>).</li></ul>`,
      followups: [
        "How does a new consumer get the existing data?",
        "How are deletes represented?",
        "What happens to search freshness?",
      ],
      pitfalls: [
        "Implementing CDC with triggers by default",
        "Forgetting the snapshot/log-position handoff",
        "Treating CDC as synchronous (derived systems lag)",
      ],
    },
    {
      id: "q-outbox-order-service",
      q: "An order service must save an order in its Postgres database and publish an OrderCreated event for other services. How do you make this reliable?",
      diff: "medium",
      section: "change-data-capture",
      a: `<p><strong>Name the problem</strong>: saving the order and publishing the event are two writes to two systems. Writing to Postgres and then Kafka loses the event if the process crashes or Kafka times out in between; publishing first can announce an order that was never committed; and concurrent orders can be published in a different order than they committed. A retry loop does not help when the process itself dies, and 2PC across Postgres and Kafka is not available in practice (Kafka does not support XA).</p>
<p><strong>Transactional outbox</strong>:</p>
<ol><li>In one local transaction, insert the order row and an outbox row: event ID, aggregate ID (the order ID), type OrderCreated, payload.</li><li>A CDC connector (Debezium reading the WAL through logical decoding, with its outbox event router) publishes each outbox row to Kafka in commit order, keyed by order ID.</li><li>Clean up outbox rows after capture; because CDC reads the log, they can even be deleted right after they are inserted.</li></ol>
<p>Atomicity comes from the local transaction: either the order and its event both exist, or neither does. A <strong>polling publisher</strong> (select unsent rows, publish, mark them sent) also works, but rows from concurrent transactions can become visible out of commit order, so a poller that reads "everything after the last ID" can skip rows, and several pollers need locking.</p>
<p><strong>Alternative</strong>: CDC directly on the <code>orders</code> table, if consumers can live with row-level changes. That couples them to your internal schema; the outbox publishes a stable, versioned domain event.</p>
<p><strong>Consumers</strong>: delivery is at-least-once, so they deduplicate by event ID or use idempotent upserts. They are also eventually consistent: another service may see the order a few seconds after it committed.</p>`,
      followups: [
        "Why not publish to Kafka inside the database transaction?",
        "How do consumers handle duplicates?",
        "How do you evolve the event schema without breaking consumers?",
      ],
      pitfalls: [
        "Write to DB then Kafka with a retry loop and calling it reliable",
        "Proposing XA/2PC as the default",
        "Forgetting consumer idempotence",
      ],
    },
    {
      id: "q08",
      q: "Design a pipeline to keep a search index in sync with a database.",
      diff: "hard",
      section: "change-data-capture",
      a: `<p><strong>Architecture</strong>: Postgres (the source of truth) &rarr; Debezium reading the WAL through logical decoding &rarr; a Kafka topic keyed by primary key &rarr; a sink (the Kafka Connect Elasticsearch sink, or a Kafka Streams or Flink job if documents need joins or enrichment) &rarr; Elasticsearch. The application writes only to Postgres: no dual writes.</p>
<p><strong>Correctness</strong>:</p>
<ul><li><strong>Ordering</strong>: partition the change topic by primary key so each document's updates arrive in commit order.</li><li><strong>Idempotent, monotonic writes</strong>: index full documents keyed by primary key, and use Elasticsearch external versioning with the source log position (LSN) as the version, so a replayed or reordered older change can never overwrite a newer one.</li><li><strong>Deletes</strong>: Debezium emits a delete event followed by a tombstone; the sink turns them into document deletes.</li><li><strong>Bootstrap</strong>: take a consistent snapshot tied to an LSN, index it, then stream from that LSN (Debezium's default behavior; incremental snapshots avoid long-held locks).</li><li><strong>Failures</strong>: the sink commits offsets after Elasticsearch acknowledges; after a crash it replays from the last committed offset, which is safe because the writes are idempotent.</li><li><strong>Denormalized documents</strong>: if a document combines several tables, join their change streams in a stream processor (a table-table join) instead of querying Postgres for every change.</li></ul>
<p><strong>Operations</strong>:</p>
<ul><li>Monitor connector lag. A stuck logical replication slot also makes Postgres retain WAL, which can fill its disk.</li><li>Freshness: the index trails the database by seconds, so a user who just edited a listing may not find it. If that matters, read that user's own recent writes from Postgres, or wait until the index has reached the write's LSN.</li><li>Schema evolution through a schema registry.</li><li><strong>Reindexing with a new mapping</strong>: build a new index from a snapshot or compacted topic, let it catch up from the stream, then switch an index alias atomically.</li></ul>`,
      followups: [
        "How do you reindex with a new mapping without downtime?",
        "What happens if the connector is down for a day?",
        "How would you show a user their own edit immediately?",
      ],
      pitfalls: [
        "Dual writes from the application",
        "Non-idempotent partial updates that break on replay",
        "Forgetting deletes and the snapshot handoff",
      ],
    },
    {
      id: "q-log-compaction",
      q: "What is log compaction in Kafka, and when would you use it instead of time-based retention?",
      diff: "easy",
      section: "change-data-capture",
      a: `<p>Kafka has two cleanup policies, and they answer different questions about what a topic is.</p>
<ul><li><strong>Time- or size-based retention</strong> (<code>cleanup.policy=delete</code>, 7 days by default) drops whole old segments regardless of their contents. Right for a stream of <em>events</em> (clicks, orders, log lines) where consumers only need recent history.</li><li><strong>Log compaction</strong> (<code>cleanup.policy=compact</code>) keeps at least the latest record for every key and discards older records that share a key with a newer one, like compaction in an LSM storage engine (<a href="#/ch3/learn/sstables-and-lsm-trees">Chapter 3</a>). Right for a topic that represents a <em>table</em>.</li></ul>
<p><strong>Mechanics worth knowing</strong>:</p>
<ul><li>A record with a null value is a <strong>tombstone</strong>: it deletes the key, and is itself removed after <code>delete.retention.ms</code> (1 day by default), so consumers that are behind still get to see the delete.</li><li>Offsets never change; compacted-away offsets are simply missing. Order within the partition is preserved.</li><li>Compaction runs in the background and never touches the active segment, so recent duplicates remain for a while. It bounds size; it does not give exact "one record per key" at any instant.</li><li>The two policies combine: <code>compact,delete</code> compacts and also expires old keys.</li></ul>
<p><strong>Typical uses</strong>: CDC topics keyed by primary key, so a new consumer can read from offset 0 and get a full copy of the current data without a database snapshot; changelog topics behind Kafka Streams and Samza state stores; reference data for stream-table joins; and Kafka's own <code>__consumer_offsets</code>. Size then depends on the number of distinct keys, not on how many writes were made.</p>
<p><strong>When it does not fit</strong>: records without keys, and records whose meaning depends on earlier ones (increments, <code>ItemAdded</code>, event-sourced events), because discarding older records changes what a replay produces. It also cannot reconstruct past states, so a join that must use the table as of an older time needs the history kept.</p>`,
      followups: [
        "A consumer was offline for three days and the topic is compacted. What might it miss?",
        "Why can't an event-sourced log be compacted the way a CDC topic can?",
        "How would you remove one user's data from a compacted topic?",
      ],
      pitfalls: [
        "Assuming compaction is immediate or exact (it runs in the background and skips the active segment)",
        "Compacting a topic of increments or deltas, which changes what a replay computes",
        "Forgetting that tombstones themselves expire, so a consumer offline longer than delete.retention.ms can miss a delete",
      ],
    },

    // ---- event-sourcing ----
    {
      id: "q03",
      q: "What is event sourcing and how does it differ from CDC?",
      diff: "hard",
      section: "event-sourcing",
      a: `<p>Both keep a log of changes, but they differ in where the truth lives and in what an event means.</p>
<ul><li><strong>CDC</strong>: the <strong>database remains the source of truth</strong>. The application updates and deletes rows as usual and need not know CDC exists; the change log is extracted from the database's replication log. Events are low-level and shaped by the schema ("row 42 in cart_items deleted").</li><li><strong>Event sourcing</strong>: the <strong>event log is the source of truth</strong>. The application deliberately appends immutable, business-level events ("ItemRemovedFromCart", "EnrollmentCancelled"), and current state is derived by folding the events with deterministic code. Events are never updated or deleted.</li></ul>
<p><strong>Commands vs events</strong>: a request arrives as a command that may still fail (the seat is taken, the username exists). It is validated against current state before anything is written, and only then becomes an event, a fact. Consumers cannot reject events, so validation must be synchronous (a serializable check, or all commands for one entity processed serially in one partition), or split into a tentative event and a confirmation.</p>
<p><strong>Mechanics</strong>: snapshots of derived state avoid replaying years of events, but they are only an optimization. Log compaction does not apply: in CDC the latest record for a key holds the whole row, but in an event-sourced log a later event rarely makes earlier ones redundant.</p>
<p><strong>Benefits</strong>: audit and debugging (you can see why state is what it is), new views built from old events, and recovery from bugs by fixing the code and replaying.</p>
<p><strong>Costs</strong>: events must be designed and versioned for years (<a href="#/ch4/learn/why-encoding">Chapter 4</a>), read models are eventually consistent, ad-hoc queries need projections, and true deletion is hard.</p>
<p><strong>Relation to CQRS</strong>: CQRS separates the write model from one or more read models. Event sourcing is a natural way to feed read models (each is a projection of the log), but they are independent ideas, and neither requires CDC or Kafka.</p>`,
      followups: [
        "How do you enforce uniqueness, e.g. usernames?",
        "How do you rebuild a view after changing its logic?",
        "How do you change the shape of an event that has been stored for three years?",
      ],
      pitfalls: [
        "Equating event sourcing with using Kafka",
        "Validating commands asynchronously after the event is written",
        "Saying that with CDC the log is the source of truth",
      ],
    },

    // ---- state-and-immutability ----
    {
      id: "q-event-sourcing-erasure",
      q: "You run an event-sourced system and receive a GDPR erasure request for a user. The event log is append-only. What do you do?",
      diff: "hard",
      section: "state-and-immutability",
      a: `<p><strong>Appending a UserDeleted event is not enough.</strong> It changes current state, but the personal data is still in the history, in every replica, snapshot and projection built from it, in downstream consumers (search, the warehouse), and in backups. GDPR's right to erasure (Article 17, applicable since May 2018) is about the data itself.</p>
<p><strong>Approaches, best designed in up front</strong>:</p>
<ul><li><strong>Keep personal data out of events</strong>: store it in a separate, mutable store referenced by user ID, so events carry only the ID and erasure deletes one record.</li><li><strong>Crypto-shredding</strong>: encrypt each user's personal fields with a per-user key held in a key store, and delete the key to erase. Old events, copies and backups become unreadable without being rewritten; projections must cope with fields they can no longer decrypt.</li><li><strong>Rewrite history</strong>: actually remove or redact the events, as Datomic's excision or Fossil's shunning do. For Kafka topics keyed by user, compaction with a tombstone removes the old values for that key; on time-retained topics the data ages out at the retention limit. Kafka cannot delete an individual record by offset (deleting records only truncates a partition up to an offset).</li></ul>
<p><strong>Propagate the deletion</strong>: every derived view, cache, search index and warehouse table must honor it, so emit an erasure event that consumers act on, and track that each one has done so.</p>
<p><strong>Be honest about limits</strong>: storage engines, filesystems and SSDs write new copies rather than overwriting in place, and backups are deliberately immutable. Practical deletion means making the data unrecoverable (key deletion, backup expiry) rather than physically erasing every byte.</p>`,
      followups: [
        "How do projections handle events whose payload can no longer be decrypted?",
        "What about copies in a data warehouse fed by the log?",
        "How does Kafka log compaction help, and when does it not?",
      ],
      pitfalls: [
        "'Just append a deletion event'",
        "Forgetting backups and derived views",
        "Assuming deleting a Kafka record by offset is possible (it is not; compaction or retention is required)",
      ],
    },
    {
      id: "q-cqrs-read-your-writes",
      q: "Your writes go to an event log and reads are served from views that consumers build asynchronously (CQRS). A user changes their display name, reloads the page and sees the old name. Why, and what are your options?",
      diff: "medium",
      section: "state-and-immutability",
      a: `<p><strong>Why</strong>: the write is acknowledged once the event is appended to the log, and the view is updated later by a consumer with its own offset. Reading before that consumer has applied the event is <a href="#/ch5/learn/replication-lag">Chapter 5</a>'s <strong>read-your-writes</strong> anomaly, with the log as the leader and each view as an asynchronous follower. Each view lags by a different amount, so two views (the profile page and search) can also disagree with each other for a moment.</p>
<p><strong>Options</strong>, roughly from cheapest to strongest:</p>
<ul><li><strong>Wait for a position</strong>: the append returns the event's log position; the client sends it with its next read, and the read waits briefly (with a timeout) until the view has applied at least that position. Only the writer pays, and only when it reads right after writing.</li><li><strong>Serve the writer's own recent changes from the write side</strong>: for a short time after a write, read that user's own data from the event they just appended or from the source of truth, or update the UI optimistically from the command's result. Everyone else reads the view.</li><li><strong>Update the view synchronously</strong>: append the event and update the view in one transaction. Easy when both live in the same database (an events table plus a projection table in Postgres); across different systems it needs a distributed transaction or total order broadcast (<a href="#/ch9/learn/total-order-broadcast">Chapter 9</a>), which is rarely worth it for a display name.</li><li><strong>Keep reads monotonic</strong>: if a view has several replicas at different positions, pin a user to one replica (or use the position check above) so a new value cannot appear and then vanish on the next reload.</li></ul>
<p><strong>What to avoid</strong>: blocking every write until every view has caught up, which ties write latency to the slowest consumer and lets one broken view stop all writes. Monitor each view's lag, and decide per screen whether a few seconds of staleness is acceptable.</p>
<p><strong>The upside to mention</strong>: the same log makes concurrency simpler elsewhere. One self-contained event replaces a multi-row transaction, and if events are partitioned by user and applied by one consumer per partition, updates to a user's view need no locking.</p>`,
      followups: [
        "How does the client learn which log position to wait for?",
        "Search shows the new name while the profile page shows the old one. Is that acceptable, and how would you detect it?",
        "When is updating the view in the same transaction as the append a reasonable design?",
      ],
      pitfalls: [
        "Blocking every write until all views have caught up",
        "Treating eventual consistency as unavoidable even for the writer's own reads",
        "Forgetting that each view lags independently, so views can disagree with each other",
      ],
    },

    // ---- processing-streams ----
    {
      id: "q-classify-realtime",
      q: "A product team asks for four 'real-time' features: flag card payments that look fraudulent, a live revenue dashboard, product search that reflects price changes within seconds, and alerts when a new listing matches a user's saved search. How would you classify and build each?",
      diff: "medium",
      section: "processing-streams",
      a: `<p>"Real-time" covers different kinds of stream processing. Classify first, because each kind needs different state.</p>
<ul><li><strong>Fraud flags: complex event processing plus per-key state.</strong> Patterns over a card's recent events ("three countries within 10 minutes", "amount far above this card's norm"). Key the stream by card ID, keep a short window and a per-card profile in local state, and score each payment while it is in flight.</li><li><strong>Revenue dashboard: stream analytics.</strong> Aggregates over event-time tumbling windows (revenue per minute), rolling averages and comparisons with last week. State is one accumulator per window per key; late events need a watermark and a correction policy; distinct counts can use HyperLogLog.</li><li><strong>Search reflecting price changes: materialized view maintenance.</strong> CDC from the products database into the search index. The state covers the whole catalog, not a window, so it is bootstrapped from a snapshot or a compacted topic.</li><li><strong>Saved-search alerts: search on streams.</strong> Store the queries and run each new listing against them (Elasticsearch's percolator), the inverse of normal search; with many saved searches, index the queries too.</li></ul>
<p><strong>What they share</strong>: input from a durable, partitioned log; state kept between events that must survive crashes (checkpoints or changelog topics); and idempotent outputs. What differs is the shape and lifetime of the state: a short pattern window, window aggregates, all of history, or a set of stored queries.</p>`,
      followups: [
        "Which of these needs event time, and which can live with processing time?",
        "Which state could you rebuild from the input after a crash, and which must be checkpointed?",
      ],
      pitfalls: [
        "Giving one generic 'real-time pipeline' answer for all four",
        "Polling the database for each feature",
        "Assuming stream analytics must be approximate",
      ],
    },

    // ---- reasoning-about-time ----
    {
      id: "q04",
      q: "Why is event time preferred over processing time for analytics?",
      diff: "medium",
      section: "reasoning-about-time",
      a: `<p><strong>Event time</strong> is when the event happened (a timestamp in the event); <strong>processing time</strong> is when the processor handles it. They differ because of queueing, network delays, broker contention, consumer restarts, reprocessing, and devices that buffer events offline, and delays reorder events across partitions and producers.</p>
<p><strong>Processing-time windows give wrong answers</strong> whenever there is delay:</p>
<ul><li>A job stopped for 10 minutes for a deploy shows 10 empty minutes and then a huge spike as it catches up, although the real rate was steady.</li><li>A phone offline all day uploads at 20:00, so all of its events are counted at 20:00.</li><li>Reprocessing last month at high speed puts a month of events into the last hour.</li></ul>
<p><strong>Event time gives correct, reproducible answers</strong>: each event lands in the window in which it happened, whether it is processed live, late or in a replay. That is what makes reprocessing after a bug fix trustworthy.</p>
<p><strong>The costs</strong>:</p>
<ul><li>You never know when a window is complete, so you need a <strong>watermark</strong> and a policy for stragglers (drop and count, or correct earlier results).</li><li>Device clocks cannot be trusted. Log three timestamps: the event time and the send time by the device clock, and the receive time by the server clock. Receive minus send estimates the device's clock offset (assuming network delay is small); add it to the event time.</li></ul>
<p>Processing time is the right choice for metrics about the pipeline itself (throughput, lag), where "when did we process it?" is the question.</p>`,
      followups: [
        "How do you correct a device clock that is wrong?",
        "What do you do with events that arrive after the watermark?",
        "Which timestamp does a Kafka record carry?",
      ],
      pitfalls: [
        "Assuming device timestamps are trustworthy",
        "Thinking Kafka's per-partition order makes event time unnecessary",
      ],
    },
    {
      id: "q07",
      q: "What is a watermark in stream processing?",
      diff: "medium",
      section: "reasoning-about-time",
      a: `<p>A <strong>watermark</strong> is a marker that flows with the events and asserts "no more events with event time earlier than T are expected". When the watermark passes the end of a window, operators fire that window.</p>
<p><strong>It is usually a heuristic, not a guarantee.</strong> Only with complete knowledge of the input, which is rare, can it be perfect. The common strategy, Flink's bounded out-of-orderness, is the <em>maximum event time seen so far minus an allowed delay</em> (say 30 seconds). Events arriving after it are late.</p>
<p><strong>The trade-off</strong>:</p>
<ul><li>Short delay: prompt results, more late events.</li><li>Long delay: more complete results, but every window waits longer and its state is held longer.</li></ul>
<p><strong>Straggler policies</strong>: drop late events but count them and alert if the rate rises; publish corrections (allowed lateness, with results updated or retracted); or route them to a side output for separate handling.</p>
<p><strong>Propagation</strong>: an operator with several inputs takes the <strong>minimum</strong> of its input watermarks. So one idle or slow partition holds back every window downstream; Flink's idleness detection excludes idle inputs. At the end of a bounded input the watermark jumps to infinity, which flushes all windows.</p>
<p>The term was popularized by Google's MillWheel (low watermarks) and the Dataflow model, which became Apache Beam.</p>`,
      followups: [
        "What happens to the watermark if one partition stops receiving data?",
        "How would you choose the delay from data?",
      ],
      pitfalls: [
        "Calling the watermark a guarantee",
        "Forgetting that an operator's watermark is the minimum of its inputs",
      ],
    },
    {
      id: "q-window-types",
      q: "Explain tumbling, hopping, sliding and session windows, with a use case for each. What state does each need?",
      diff: "easy",
      section: "reasoning-about-time",
      a: `<ul><li><strong>Tumbling</strong>: fixed length, no overlap, so each event is in exactly one window. Use: orders per minute, hourly billing buckets. State: one accumulator per key per open window.</li><li><strong>Hopping</strong>: fixed length with a smaller hop, so windows overlap (5-minute windows starting every minute). Use: a smoothed error rate for alerting. Each event belongs to length &divide; hop windows (5 here); implement it by aggregating hop-sized tumbling panes and combining adjacent ones, rather than copying each event into every window.</li><li><strong>Sliding</strong> (in the book's sense): all events within some interval of each other, not aligned to the clock. Use: "three failed logins for one account within 60 seconds". State: a time-sorted buffer of recent raw events per key, evicted as they age out.</li><li><strong>Session</strong>: per key, no fixed length; closes after a gap of inactivity (e.g. 30 minutes). Use: website visits. State: the open sessions per key. A late event that falls into the gap between two sessions merges them, so a result already emitted may have to be retracted.</li></ul>
<p>All of them should be defined on <strong>event time</strong>, closed by a watermark, and paired with a policy for late events. All are computed per key.</p>
<p><strong>Naming trap</strong>: Flink and Beam call the hopping window a "sliding window". Say which definition you mean.</p>`,
      followups: [
        "How does a late event affect a session window that has already been emitted?",
        "How many windows is each event in for a 24-hour window with a 1-minute hop, and how do you avoid storing it 1,440 times?",
        "Which window would you use to detect card fraud, and why?",
      ],
      pitfalls: [
        "Treating hopping and sliding as the same thing without noting the terminology difference",
        "Forgetting that windows are computed per key",
        "Windowing by processing time",
      ],
    },
    {
      id: "q-realtime-ad-metrics",
      q: "Design a real-time dashboard showing ad clicks per campaign per minute, accurate even though some mobile clients upload events hours late.",
      diff: "hard",
      section: "reasoning-about-time",
      a: `<p><strong>Pipeline</strong>: SDKs and web clients &rarr; ingestion API &rarr; Kafka topic of click events (partitioned by ad or campaign ID, watching for hot campaigns) &rarr; Flink or Kafka Streams job &rarr; serving store keyed by (campaign, minute) &rarr; dashboard. Keep the raw topic, and an archive, so you can recompute.</p>
<p><strong>Time</strong>:</p>
<ul><li>Assign clicks to one-minute <strong>tumbling windows by event time</strong>, never processing time, or late uploads and restarts create fake spikes.</li><li><strong>Fix device clocks</strong>: record event time and send time on the device and receive time on the server; offset &asymp; receive &minus; send. Clamp timestamps that are implausibly far off to the receive time.</li><li>A <strong>watermark</strong> with bounded out-of-orderness of seconds to a few minutes, so the dashboard updates promptly.</li></ul>
<p><strong>Late events</strong>: uploads hours late will always arrive after the watermark, so do not drop them silently. Use allowed lateness or a side output and <strong>upsert</strong> corrected counts keyed by (campaign, minute) into the serving store, so the dashboard simply shows the latest value for each minute. Track the late rate; a rising rate means the watermark or the SDK needs attention.</p>
<p><strong>Correctness</strong>:</p>
<ul><li>Deduplicate by a client-generated click ID, because SDKs retry uploads.</li><li>Checkpointed state plus an idempotent upsert sink gives effectively-once counts.</li><li>For unique users per campaign, HyperLogLog sketches merge across windows.</li></ul>
<p><strong>Billing</strong>: if the numbers drive money, treat the stream as the fast, provisional view, and recompute from the raw log (batch or replay) after the lateness horizon has passed, with fraud filtering, before publishing final figures.</p>`,
      followups: [
        "What watermark delay would you choose, and how would you measure whether it is right?",
        "How does the serving store handle a correction to a minute that is already displayed?",
        "What changes if the numbers are used for billing?",
      ],
      pitfalls: [
        "Windowing by processing time",
        "Assuming device clocks are correct",
        "Treating the watermark as a guarantee",
        "Not deduplicating client retries",
      ],
    },

    // ---- stream-joins ----
    {
      id: "q05",
      q: "Explain the three types of stream joins.",
      diff: "hard",
      section: "stream-joins",
      a: `<p>Every streaming join keeps state from one or both inputs, indexed by the join key. The three kinds differ in what that state is.</p>
<p><strong>Stream-stream (window join)</strong>: join search events and click events by session ID within, say, an hour, to compute click-through rate. Both sides are buffered for the window, because either can arrive first. On a match, emit "result #2 clicked"; when a search expires unmatched, emit "not clicked". Those unclicked searches are half of the click-through formula, which is why you cannot just copy search data into click events. State &asymp; event rate &times; window length per side.</p>
<p><strong>Stream-table (enrichment)</strong>: add the user's country to each page view. Querying a remote database per event is slow and can overload it, so the processor keeps a local copy of the table, kept current by consuming the table's CDC changelog. The table is not static: it is a stream whose window reaches back to the beginning of time. Two physical shapes, mirroring map-side joins in <a href="#/ch10/learn/map-side-joins">Chapter 10</a>: <strong>broadcast</strong> (every instance holds the whole table; Kafka Streams GlobalKTable; no co-partitioning) or <strong>partitioned</strong> (KTable, co-partitioned with the stream by user ID).</p>
<p><strong>Table-table (materialized view maintenance)</strong>: both inputs are table changelogs and the output is a continuously updated join. The book's example is Twitter timelines (tweets &#8904; follows): a new tweet is added to every follower's timeline, a deleted one removed, a follow adds the followee's recent tweets and an unfollow removes them. Intuition: like the product rule (u&middot;v)' = u'v + uv', changes on either side update the result (for discrete changes there is also a &Delta;A&#8904;&Delta;B cross term).</p>
<p><strong>Time makes all three nondeterministic</strong>: there is no ordering across the two inputs, so the result can depend on how they interleave. A plain stream-table join uses whatever table version has been processed when the event is processed, so a late event or a replay joins with the wrong version (the slowly changing dimension problem). Fix it with version IDs stored in the event, or a temporal join (Flink SQL <code>FOR SYSTEM_TIME AS OF</code>, Kafka Streams versioned stores).</p>
<p><strong>Always</strong>: co-partition both inputs by the join key (same partition count and partitioner) or repartition one first.</p>`,
      followups: [
        "What if a click arrives before its search?",
        "How do you make a join reproducible on replay?",
        "How large is the state for a one-hour window at 50,000 events per second?",
      ],
      pitfalls: [
        "Querying a remote DB per event at high volume",
        "Ignoring which version of the table an event should join",
        "Calling the table side of a stream-table join 'static'",
      ],
    },
    {
      id: "q-attribution-join",
      q: "Design a pipeline that attributes each app install to the last ad click from the same device in the previous 7 days.",
      diff: "hard",
      section: "stream-joins",
      a: `<p><strong>Shape</strong>: a stream-stream join of <code>clicks</code> and <code>installs</code> on device ID (or advertising ID), so both topics must be co-partitioned by that key, or one must be repartitioned first.</p>
<p><strong>Naive version</strong>: keep 7 days of clicks per device and, for each install, look for the latest click with event time in [install &minus; 7 days, install]. Correct, but the state is every click for 7 days: at 10,000 clicks per second, about 6 billion clicks (illustrative).</p>
<p><strong>Key insight</strong>: last-click attribution needs only the <strong>most recent</strong> click per device. Collapse the click side into a keyed table, "latest click per device" (or the last few, so an install processed late can still find the click that preceded it), with a 7-day TTL. The stream-stream join becomes a stream-table join, and state shrinks to a record or two per active device. Keep it in an embedded store (RocksDB) with incremental checkpoints.</p>
<p><strong>Disorder</strong>: clicks and installs come from different producers and partitions, so a click can be processed after the install it should be credited to. Either delay attribution until the watermark passes the install time plus a few minutes, or emit "organic" immediately and correct it if a qualifying click arrives (an upsert keyed by install ID). Compare event times when updating the table, so a late, older click never replaces a newer one.</p>
<p><strong>Correctness</strong>: deduplicate retried clicks and installs by ID; use event time throughout so a replay gives the same answers; make the sink an idempotent upsert keyed by install ID; checkpoint state and offsets together.</p>
<p><strong>Beyond the stream</strong>: click flooding (spamming clicks to steal last-click credit) needs fraud filters, and billing-grade attribution is usually recomputed in batch from the raw logs once the lateness horizon has passed, especially when attribution rules change.</p>`,
      followups: [
        "How big is the state with and without the last-click simplification?",
        "What if attribution rules change and you must recompute the last 30 days?",
        "How do you handle a click that arrives after its install was already reported as organic?",
      ],
      pitfalls: [
        "Querying a click database per install at high volume",
        "Forgetting co-partitioning of the two topics",
        "Windowing by processing time, so replays change attribution",
        "Ignoring that installs can be processed before their clicks",
      ],
    },

    // ---- fault-tolerance ----
    {
      id: "q06",
      q: "How do you achieve exactly-once semantics in stream processing?",
      diff: "hard",
      section: "fault-tolerance",
      a: `<p>"Exactly-once" really means <strong>effectively-once</strong>: after a failure an event may be processed more than once, but the visible result is as if it had been processed once. Start from the vocabulary: commit the offset before processing and a crash loses the event (<strong>at-most-once</strong>); process first and commit afterwards, and a crash re-processes it (<strong>at-least-once</strong>). Effectively-once closes that gap in one of three ways.</p>
<ol><li><strong>Microbatching or checkpointing</strong>: Spark Streaming processes microbatches of about a second and reruns a failed one. Flink injects barriers into its input streams and snapshots operator state plus input offsets to durable storage, using asynchronous barrier snapshotting, which is based on Chandy-Lamport; on failure it restores the last checkpoint and replays. On its own this covers only state inside the framework.</li><li><strong>Atomic commit</strong> of outputs, state changes and input offsets: all take effect or none does. Kafka 0.11 (2017) added the idempotent producer and transactions, so a read-process-write job commits its output messages and its consumer offsets in one transaction, and downstream consumers use <code>read_committed</code>. Flink gets the same effect with two-phase-commit sinks: pre-commit at the checkpoint, commit when it completes.</li><li><strong>Idempotence</strong>: make re-applying harmless. Setting a key to a value is idempotent and incrementing a counter is not, but storing the offset of the last applied event next to the value, and skipping anything at or below it, makes the increment safe.</li></ol>
<p><strong>Where the offset lives decides what can be atomic</strong>: Kafka transactions cover Kafka outputs plus offset commits. For a database sink, store the offset in the same database transaction and seek to it on restart, use idempotent upserts keyed by event, or use a two-phase-commit sink.</p>
<p><strong>Requirements and caveats</strong>:</p>
<ul><li>Idempotent replay needs the same replay order (a log provides it), deterministic processing and no concurrent writers, so <strong>fence zombies</strong>: Kafka bumps an epoch per <code>transactional.id</code> and rejects the old instance's writes.</li><li>External side effects (emails, payment APIs, webhooks) are not covered; use idempotency keys or a separate idempotent service.</li><li>It costs latency: output becomes visible only when the transaction or checkpoint commits.</li></ul>`,
      followups: [
        "What does read_committed do?",
        "Why must processing be deterministic for idempotent replay?",
        "How would you get exactly-once results into Postgres?",
      ],
      pitfalls: [
        "Claiming each message is delivered exactly once over the network",
        "Assuming Kafka transactions make writes to an external database atomic",
        "Forgetting external side effects",
      ],
    },
    {
      id: "q-state-recovery",
      q: "A stream processing job keeps a large amount of local state (say 200 GB per machine, in join tables and window aggregates). One machine dies. How is its state recovered, and how do you keep recovery fast?",
      diff: "hard",
      section: "fault-tolerance",
      a: `<p><strong>Why state is the hard part</strong>: windows, join tables and aggregates were built from events that went past long ago, so a replacement task cannot just resume from the latest offset with empty state. Keeping the state in a remote database instead costs a network round trip per event and makes that database absorb the full write rate. So engines keep state <strong>local</strong> (in memory or an embedded store such as RocksDB) and make it recoverable.</p>
<p><strong>Ways to recover it</strong>:</p>
<ul><li><strong>Periodic snapshots</strong> (Flink): checkpoint barriers produce a consistent snapshot of every operator's state together with the input offsets, written to durable storage such as S3 or HDFS. After a failure the tasks restore the last completed checkpoint and the sources rewind to the offsets stored in it.</li><li><strong>Changelog topics</strong> (Kafka Streams, Samza): every update to a local store is also written to a compacted Kafka topic. A replacement instance rebuilds the store by replaying that changelog, then resumes from the committed input offsets.</li><li><strong>Redundant processing</strong> (VoltDB): each input is processed on several nodes, so a replica already holds the state, at the cost of doing the work several times.</li><li><strong>Rebuild from the input</strong>: a short window can re-read its last few minutes of input, and a table copy fed by CDC can be rebuilt from a compacted topic.</li></ul>
<p><strong>Keeping recovery fast</strong>: restoring 200 GB is not instant; at an illustrative 200 MB/s it takes about 17 minutes, during which those partitions are not processed.</p>
<ul><li><strong>Standby replicas</strong> (Kafka Streams <code>num.standby.replicas</code>) keep a warm copy of each store on another instance, so failover replays only the tail of the changelog.</li><li><strong>Incremental checkpoints</strong> (Flink with RocksDB) upload only changed files, so checkpoints can be frequent and the replay after a restore stays short; <strong>local recovery</strong> keeps a copy on the task's own disk for restarts on the same machine.</li><li><strong>More, smaller partitions</strong> (key groups in Flink) let many machines restore in parallel.</li><li><strong>Bound the state</strong>: TTLs on join tables, window retention, and keyed compaction of changelogs.</li></ul>
<p><strong>The trade-offs to name</strong>: the checkpoint interval sets how much input is replayed after a crash and, with transactional sinks, how long committed output is delayed. Whether to replicate state or rebuild it depends on its size and on network versus disk speed: replaying a few minutes of input beats downloading a snapshot when the state is small.</p>`,
      followups: [
        "Why not keep all operator state in Cassandra or Redis instead?",
        "What does a shorter checkpoint interval buy, and what does it cost?",
        "How do standby replicas interact with exactly-once processing?",
      ],
      pitfalls: [
        "Assuming a restarted task can resume from the latest offset with empty state",
        "Doing a remote database round trip per event at high volume",
        "Ignoring how long restoring very large state takes, and that its partitions stall meanwhile",
      ],
    },
    {
      id: "q-exactly-once-side-effects",
      q: "Your stream processor runs with 'exactly-once' enabled and charges a customer's card (via a payment API) for each PaymentRequested event. Is double charging possible? How do you prevent it?",
      diff: "hard",
      section: "fault-tolerance",
      a: `<p><strong>Yes, double charging is possible.</strong> Exactly-once in Flink or Kafka Streams means effectively-once for the framework's own state and for transactional sinks: outputs and offsets commit atomically, and after a crash the job rewinds to its last checkpoint or committed transaction and replays. A call to a payment API is a side effect outside that transaction. If the task crashes after the call but before the checkpoint or transaction commits, the PaymentRequested event is replayed and the card is charged again.</p>
<p><strong>Fixes</strong>:</p>
<ul><li><strong>Idempotency key</strong>: send a key derived deterministically from the event (its event ID, or topic-partition-offset) with each charge. Payment providers such as Stripe accept an idempotency key and return the original result for a repeated request, so a replay does not charge twice. The key must be identical on every attempt; never generate a random one per attempt.</li><li><strong>Separate the effect</strong>: the stream job emits a ChargeRequested record to a transactional output topic; a dedicated payment service consumes it, calls the provider with the idempotency key, and records the outcome (ChargeSucceeded or ChargeFailed) as a new event.</li><li><strong>Treat timeouts as "unknown"</strong>: after a timeout the charge may or may not have happened. Retry with the <em>same</em> key, or look the charge up by it; never retry with a new key.</li></ul>
<p><strong>Also</strong>: processing must be deterministic so the replay derives the same key and amount; zombie instances must be fenced; and the provider must remember keys longer than your longest possible replay. Stripe documents that keys may be pruned once they are at least 24 hours old, so replays of older events need your own record of which event IDs were charged.</p>`,
      followups: [
        "Where does the idempotency key come from, and why must it be deterministic?",
        "How long must the provider remember keys?",
        "What happens if the payment API times out?",
      ],
      pitfalls: [
        "'Exactly-once means no duplicates anywhere'",
        "Generating a random idempotency key per attempt",
        "Ignoring the timeout case where the outcome is unknown",
      ],
    },
  ],
});
