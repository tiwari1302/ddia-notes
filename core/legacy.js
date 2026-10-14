// Frozen snapshot of the v1 (index-based) progress layout.
// v1 stored progress as {conceptsLearned: {0: true}, qaReviewed: {3: true}}; these arrays map
// each old index to the stable id now used. Never edit: it only exists to migrate old saves.
window.DDIA_LEGACY_V1 = {
 "ch1": {
  "c": [
   "reliability",
   "fault-vs-failure",
   "hardware-software-human-faults",
   "scalability",
   "load-parameters",
   "response-time-vs-latency",
   "percentiles",
   "tail-latency-amplification",
   "scaling-up-vs-scaling-out",
   "maintainability",
   "operability",
   "simplicity",
   "evolvability",
   "twitter-home-timeline"
  ],
  "q": [
   "q01",
   "q02",
   "q03",
   "q04",
   "q05",
   "q06",
   "q07",
   "q08"
  ]
 },
 "ch2": {
  "c": [
   "relational-model",
   "document-model",
   "graph-model",
   "object-relational-impedance-mismatch",
   "many-to-one-many-to-many",
   "schema-on-read-vs-schema-on-write",
   "normalization",
   "denormalization",
   "declarative-vs-imperative-query",
   "mapreduce-querying",
   "property-graph",
   "triple-store-rdf-sparql",
   "datalog",
   "codasyl-network-model"
  ],
  "q": [
   "q01",
   "q02",
   "q03",
   "q04",
   "q05",
   "q06",
   "q07",
   "q08"
  ]
 },
 "ch3": {
  "c": [
   "log-structured-storage",
   "hash-index",
   "sstable",
   "lsm-tree",
   "compaction",
   "bloom-filter",
   "b-tree",
   "write-ahead-log-redo-log",
   "clustered-vs-secondary-index",
   "oltp-vs-olap",
   "data-warehouse",
   "star-snowflake-schema",
   "column-oriented-storage",
   "column-compression",
   "sort-order-in-columns",
   "materialized-view-data-cube"
  ],
  "q": [
   "q01",
   "q02",
   "q03",
   "q04",
   "q05",
   "q06",
   "q07",
   "q08",
   "q09"
  ]
 },
 "ch4": {
  "c": [
   "encoding-serialization",
   "language-specific-encoding",
   "json-xml-csv",
   "binary-json-variants",
   "thrift-protocol-buffers",
   "avro",
   "backward-compatibility",
   "forward-compatibility",
   "field-tags",
   "writers-schema-vs-readers-schema",
   "schema-registry",
   "dataflow-through-databases",
   "dataflow-through-services",
   "dataflow-async-messaging",
   "actor-model"
  ],
  "q": [
   "q01",
   "q02",
   "q03",
   "q04",
   "q05",
   "q06",
   "q07",
   "q08"
  ]
 },
 "ch5": {
  "c": [
   "why-replicate",
   "single-leader-replication",
   "synchronous-vs-asynchronous-replication",
   "failover",
   "replication-log-types",
   "replication-lag",
   "read-your-writes-consistency",
   "monotonic-reads",
   "consistent-prefix-reads",
   "multi-leader-replication",
   "write-conflicts",
   "conflict-resolution-strategies",
   "multi-leader-topologies",
   "leaderless-replication",
   "quorum",
   "read-repair-anti-entropy",
   "sloppy-quorum-hinted-handoff",
   "concurrent-writes-version-vectors",
   "crdts"
  ],
  "q": [
   "q01",
   "q02",
   "q03",
   "q04",
   "q05",
   "q06",
   "q07",
   "q08",
   "q09"
  ]
 },
 "ch6": {
  "c": [
   "partition",
   "key-range-partitioning",
   "hash-based-partitioning",
   "hot-spot",
   "compound-partition-key",
   "partitioning-secondary-indexes-local-by-document",
   "partitioning-secondary-indexes-global-by-term",
   "rebalancing",
   "rebalancing-strategies",
   "consistent-hashing",
   "request-routing"
  ],
  "q": [
   "q01",
   "q02",
   "q03",
   "q04",
   "q05",
   "q06",
   "q07",
   "q08"
  ]
 },
 "ch7": {
  "c": [
   "acid",
   "base",
   "atomicity",
   "isolation",
   "dirty-read",
   "dirty-write",
   "non-repeatable-read-read-skew",
   "snapshot-isolation",
   "lost-update",
   "write-skew",
   "phantom",
   "serializable-isolation",
   "actual-serial-execution",
   "two-phase-locking",
   "predicate-locks-index-range-locks",
   "serializable-snapshot-isolation",
   "optimistic-vs-pessimistic-concurrency"
  ],
  "q": [
   "q01",
   "q02",
   "q03",
   "q04",
   "q05",
   "q06",
   "q07",
   "q08",
   "q09"
  ]
 },
 "ch8": {
  "c": [
   "partial-failure",
   "unreliable-networks",
   "timeouts",
   "network-partition",
   "synchronous-vs-partially-synchronous-vs-asynchronous-models",
   "monotonic-vs-time-of-day-clocks",
   "clock-skew-ntp-drift",
   "google-truetime-bounded-uncertainty",
   "process-pauses",
   "fencing-token",
   "truth-is-defined-by-the-majority",
   "byzantine-fault",
   "crash-stop-vs-crash-recovery-vs-byzantine",
   "system-model-safety-liveness"
  ],
  "q": [
   "q01",
   "q02",
   "q03",
   "q04",
   "q05",
   "q06",
   "q07",
   "q08"
  ]
 },
 "ch9": {
  "c": [
   "linearizability",
   "serializability-vs-linearizability",
   "consistent-prefix-causal-consistency",
   "cap-theorem",
   "linearizable-systems-their-cost",
   "total-order-broadcast",
   "lamport-timestamps",
   "vector-clocks-vs-version-vectors",
   "two-phase-commit",
   "coordinator-failure-in-2pc",
   "consensus",
   "raft-paxos-zab",
   "flp-impossibility",
   "leader-election",
   "membership-coordination-services"
  ],
  "q": [
   "q01",
   "q02",
   "q03",
   "q04",
   "q05",
   "q06",
   "q07",
   "q08",
   "q09"
  ]
 },
 "ch10": {
  "c": [
   "batch-processing",
   "unix-philosophy",
   "mapreduce",
   "hdfs-distributed-filesystem",
   "shuffle",
   "reduce-side-join",
   "map-side-join-broadcast",
   "map-side-join-partitioned",
   "map-side-merge-join",
   "workflow-engine",
   "dataflow-engines",
   "materialization-of-intermediate-state",
   "high-level-apis",
   "iterative-graph-processing",
   "output-of-batch-jobs"
  ],
  "q": [
   "q01",
   "q02",
   "q03",
   "q04",
   "q05",
   "q06",
   "q07",
   "q08"
  ]
 },
 "ch11": {
  "c": [
   "event-stream",
   "messaging-system-broker",
   "amqp-jms-style-broker",
   "log-based-broker",
   "partitioned-log",
   "consumer-group-offsets",
   "change-data-capture",
   "event-sourcing",
   "dual-writes-problem",
   "stream-stream-join",
   "stream-table-join",
   "table-table-join",
   "event-time-vs-processing-time",
   "windowing",
   "watermark",
   "exactly-once-semantics",
   "stateful-stream-processing"
  ],
  "q": [
   "q01",
   "q02",
   "q03",
   "q04",
   "q05",
   "q06",
   "q07",
   "q08"
  ]
 },
 "ch12": {
  "c": [
   "unbundling-the-database",
   "source-of-truth-immutable-log",
   "derived-data",
   "lambda-architecture",
   "kappa-architecture",
   "end-to-end-argument",
   "enforcing-constraints-on-streams",
   "timeliness-vs-integrity",
   "idempotence-via-operation-ids",
   "trust-but-verify",
   "predictive-analytics",
   "surveillance-capitalism-privacy",
   "feedback-loops-in-data-driven-decisions",
   "data-integration"
  ],
  "q": [
   "q01",
   "q02",
   "q03",
   "q04",
   "q05",
   "q06",
   "q07",
   "q08"
  ]
 }
};
