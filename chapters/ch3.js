// Chapter 3: Storage and Retrieval
// Authoring guide: docs/AUTHORING.md
DDIA.registerChapter({
  id: "ch3",
  part: 1,
  number: 3,
  title: "Storage and Retrieval",
  tagline: "How databases lay out bytes: logs vs pages for fast lookups, rows vs columns for analytics, and what each choice costs.",
  overview: `<p>This chapter is about what a database does with your bytes: how it lays them out on disk or in memory, and how it finds them again. You will rarely write a storage engine, but you constantly <strong>choose and tune</strong> one, and that choice sets your write throughput, your p99 latency, your disk bill and the shape your queries should take. For transactional work the chapter compares two families: <strong>log-structured</strong> engines (append-only files merged in the background: Bitcask, LevelDB, RocksDB, Cassandra) and <strong>page-oriented</strong> engines (B-trees updated in place: PostgreSQL, InnoDB, SQL Server). For analytics it adds a third layout, <strong>column-oriented</strong> storage.</p>
<p>The central tension: <strong>every index speeds up reads and slows down writes</strong>. Appending is the cheapest possible write, because sequential I/O is far faster than seeking to scattered pages, but an unindexed log has to scan everything to answer a read. Every design in the chapter buys back read speed with some mix of RAM, background rewriting and extra space, which the chapter frames as <a href="#/ch3/learn/lsm-vs-btree">write, read and space amplification</a>. No engine avoids all three; you pick the one your workload minds least.</p>
<p>The ideas build on each other. A <a href="#/ch3/learn/log-and-hash-index">log with an in-memory hash index</a> gives fast writes and point reads, but it needs every key in RAM and can't serve ranges. <a href="#/ch3/learn/sstables-and-lsm-trees">Sorting the segments</a> fixes both and leads to the LSM-tree, which <a href="#/ch3/learn/bloom-filters-and-compaction">Bloom filters and compaction</a> make practical. <a href="#/ch3/learn/b-trees">B-trees</a> go the other way and overwrite fixed-size pages, which is why they need a <a href="#/ch3/learn/write-ahead-log">write-ahead log</a> to survive crashes. After <a href="#/ch3/learn/other-indexes">secondary, multi-dimensional, full-text and in-memory indexes</a>, the chapter turns to a different workload. <a href="#/ch3/learn/oltp-vs-olap">Analytic queries</a> scan billions of rows but only a few columns, so warehouses use star schemas, <a href="#/ch3/learn/column-storage">column storage and compression</a>, LSM-style <a href="#/ch3/learn/column-writes-and-cubes">write buffering and precomputed aggregates</a>.</p>`,

  // ------------------------------------------------------------------
  // CONCEPTS (teaching order, grouped by deep-dive section)
  // ------------------------------------------------------------------
  concepts: [
    // --- log-and-hash-index ---
    {
      id: "log-structured-storage",
      term: "Log-structured storage",
      def: `A storage engine whose data files are <strong>append-only logs</strong>. Every write, including an update or a delete (written as a tombstone), adds a record at the end, and nothing already written is ever modified. "Log" here means the data's own append-only sequence of records, not human-readable application logs. Because old versions pile up, the engine closes files into segments and <strong>compacts</strong> them in the background to drop overwritten values.`,
      problem: `Update-in-place engines spend their time seeking to scattered disk locations, and a crash mid-overwrite can leave a half-written record. Appending makes every write sequential and leaves old data untouched.`,
      why: `The mechanism is the disk. On an HDD a random write pays a seek plus rotational delay of several milliseconds, which caps one disk at roughly 100–200 random writes per second, while sequential writes stream at 100+ MB/s. SSDs prefer large sequential writes too, because flash erases whole blocks and the drive must garbage-collect small scattered overwrites. Immutability also makes crash recovery simpler (no record is ever half-overwritten) and concurrency simpler (closed segments can be read without locks). The costs are that reads need an index and the disk needs regular compaction.`,
      ex: `Bitcask (Riak), LevelDB, RocksDB, Cassandra, HBase and Lucene's segments are all log-structured. Kafka stores each partition as append-only segment files, and compacted topics (<code>cleanup.policy=compact</code>) keep only the latest record per key. SSD firmware (the flash translation layer) is log-structured internally.`,
      section: "log-and-hash-index",
    },
    {
      id: "database-index",
      term: "Index (and its write cost)",
      def: `An extra structure, <strong>derived from the primary data</strong>, that lets queries locate records without scanning everything. It changes how fast queries run, not what they return. It must also be updated on every write, so <strong>indexes speed up reads and slow down writes</strong>.`,
      problem: `An append-only log makes writes O(1) but reads O(n): a 50 GB log scanned at about 500 MB/s takes about 100 seconds per lookup, and the file only grows.`,
      why: `This is the basic trade-off of the chapter. Every insert and delete, and every update that touches an indexed column, also has to maintain each index (and log that change in the WAL). So databases don't index everything by default. You choose indexes from your actual query patterns. A hash map, an SSTable's sparse index, a B-tree and a column store's sort order are all indexes in this sense.`,
      ex: `In PostgreSQL, <code>CREATE INDEX ON users (email)</code> turns a login from a sequential scan of every row into a descent of 3–4 B-tree pages. <code>pg_stat_user_indexes</code> with <code>idx_scan = 0</code> shows indexes that cost every write and serve no reads.`,
      section: "log-and-hash-index",
    },
    {
      id: "sequential-vs-random-io",
      term: "Sequential vs random I/O",
      def: `Accessing contiguous bytes in order, versus jumping between scattered locations. On an HDD a random access pays a mechanical <strong>seek plus rotation</strong> (several ms), while sequential I/O streams at 100+ MB/s. On SSDs the gap is smaller, but small random writes still cause internal garbage collection and wear.`,
      problem: `Engines that overwrite scattered locations are limited by seeks, about 100–200 random writes per second per HDD. Turning writes into appends unlocked much higher write throughput.`,
      why: `This hardware fact drives the first half of the chapter. Log-structured engines turn random writes into sequential ones. B-trees use pages large enough, and trees shallow enough, that a lookup needs only a few random reads. Even NVMe SSDs that handle hundreds of thousands of random IOPS benefit from large sequential writes: flash can only be erased in big blocks, so scattered small overwrites make the drive copy data around internally (flash-level write amplification) and wear out sooner.`,
      ex: `Kafka's design documentation cites a six-disk 7200 rpm RAID-5 array doing about 600 MB/s of linear writes but only about 100 KB/s of random writes, a gap of over 6000x. That's why Kafka writes partitions as append-only files and leans on the OS page cache.`,
      section: "log-and-hash-index",
    },
    {
      id: "hash-index",
      term: "Hash index",
      def: `An <strong>in-memory hash map from each key to the byte offset</strong> of its newest value in an append-only data file. A write appends a record and updates the map; a read is one hash lookup plus at most one disk read (none if the OS page cache holds the block). Data is split into segments. The book gives each segment its own map, checked newest first; Bitcask keeps one map for all segments (its keydir), whose entries also name the file.`,
      problem: `An append-only log with no index must scan the whole file on every read (O(n)).`,
      why: `It's about as fast as point lookups get, and it fits workloads with many updates to a modest number of keys (key = video URL, value = play count). Making it production-grade takes several pieces: a binary, length-prefixed record format; tombstones for deletes; background merging of closed segments; a CRC per record to detect torn records after a crash; a single writer thread; and <strong>hint files</strong> (on-disk snapshots of a segment's keys and offsets) so a restart doesn't have to read every value. The limits are hard ones. <strong>Every key must fit in RAM</strong>, since an on-disk hash map needs random I/O and is expensive to grow. <strong>Range queries are hopeless</strong>, because hashing scatters neighboring keys: "all keys from user:1000 to user:2000" becomes one lookup per key.`,
      ex: `Bitcask, Riak's default storage backend: an in-memory "keydir" maps every key to file id, offset and value size; merges rewrite only live values and write hint files. Redis's main dictionary and MySQL's MEMORY engine are in-memory hash indexes. PostgreSQL also offers on-disk hash indexes (crash-safe since version 10), but B-trees remain its default.`,
      section: "log-and-hash-index",
    },

    // --- sstables-and-lsm-trees ---
    {
      id: "sstable",
      term: "SSTable (Sorted String Table)",
      def: `An <strong>immutable</strong> segment file whose key-value pairs are <strong>sorted by key</strong>, with each key at most once per file. It is written once, sequentially, and never modified. Records are grouped into blocks of a few KB that can be compressed, and a sparse index points at the block starts.`,
      problem: `Hash-indexed segments need every key in RAM, can't serve range queries, and merging them needs hash lookups. Sorting the segments fixes all three.`,
      why: `Sorting buys three things. (1) <strong>Merging</strong> several SSTables works like the merge step of mergesort: stream the inputs side by side, write the smallest key, and on ties keep the value from the newest segment. Memory use doesn't depend on file size. (2) A <strong>sparse index</strong> is enough, because a key's location is bracketed by its indexed neighbors. (3) <strong>Ranges are contiguous</strong> on disk, and sorted blocks compress well. Immutability means readers need no locks, and a merged file atomically replaces its inputs.`,
      ex: `The name comes from Google's Bigtable paper (2006). LevelDB and RocksDB <code>.sst</code> files, Cassandra SSTables and HBase HFiles belong to the same family, each with a per-file block index and Bloom filter.`,
      section: "sstables-and-lsm-trees",
    },
    {
      id: "sparse-index",
      term: "Sparse index",
      def: `An in-memory index that holds <strong>only one key per block</strong> (every few KB) of a sorted file. A lookup finds the two indexed keys that bracket the target, then reads and scans that one block. For example, "length" must lie in the block that starts at "lemon" (@4096), because the next block starts at "lid" (@8192).`,
      problem: `Keeping every key in RAM, as a hash index must, doesn't scale to billions of keys.`,
      why: `Memory scales with the number of blocks, not keys: with 4 KB blocks of 100-byte records, one entry covers about 40 keys. Because a read scans a whole block anyway, blocks can be compressed, which saves disk space and I/O bandwidth. It only works because the file is sorted. In a hash-ordered file, a missing key could be anywhere.`,
      ex: `ClickHouse's primary index is sparse, with one entry per granule of 8,192 rows by default. Kafka keeps a sparse offset index per log segment (one entry every 4 KB of log by default). Every LevelDB/RocksDB SSTable ends with an index block holding one entry per data block.`,
      section: "sstables-and-lsm-trees",
    },
    {
      id: "memtable",
      term: "Memtable",
      def: `The in-memory, <strong>sorted</strong> structure that absorbs writes in an LSM engine: a skip list in LevelDB and RocksDB, or a balanced tree such as a red-black or AVL tree in the book's description. When it reaches a size threshold it is written out sequentially as an immutable SSTable and replaced by a fresh one. A WAL protects it against crashes.`,
      problem: `Writes arrive in random key order, but SSTables must be sorted, and sorting in place on disk would require random writes.`,
      why: `It turns random-order writes into sequential I/O. Inserting into a sorted in-memory structure is cheap. When it fills (a few MB in the book; RocksDB's default write buffer is 64 MB), it is frozen and flushed as one sequential SSTable write while a new memtable takes incoming writes. It is also the cheapest place to read recent data. RAM is lost in a crash, so every write is first appended to a write-ahead log (commit log), whose only job is to rebuild the memtable. It is discarded once that memtable has been flushed.`,
      ex: `LevelDB and RocksDB use a skip list by default. Cassandra uses a concurrent skip list, and version 5.0 added trie-based memtables. HBase calls its memtable the MemStore. The term itself comes from Bigtable (2006).`,
      section: "sstables-and-lsm-trees",
    },
    {
      id: "lsm-tree",
      term: "LSM-tree (log-structured merge-tree)",
      def: `A storage engine built from a <strong>memtable plus a set of SSTables</strong>. Writes go to a WAL and the memtable; full memtables are flushed as new SSTables; background <strong>compaction</strong> merges SSTables. A point read checks the memtable, then SSTables from newest to oldest, and in key-value engines such as LevelDB and RocksDB it stops at the first version found. A range scan opens an iterator on the memtable and on every SSTable whose key range overlaps, and merges them so that the newest version of each key wins.`,
      problem: `How do you get sorted files on disk when writes arrive in random order, without doing random disk writes? Buffer and sort in memory, flush sequentially, merge in the background.`,
      why: `Writes are sequential and cheap, which gives high write throughput. Data compresses well and is rewritten regularly, so there's little fragmentation. The costs: reads may touch several files (read amplification, which Bloom filters reduce for point lookups only); compaction rewrites data repeatedly (write amplification) and competes with foreground I/O, which shows up in tail latency; and range scans must merge every overlapping sorted run. <strong>Space amplification depends on the compaction strategy</strong>: about 1.1x for leveled in steady state, often 2x or more for size-tiered in the worst case. Cassandra differs from pure key-value LSMs: a row's cells can be spread across SSTables, so a read merges cells from every SSTable that may hold the partition and reconciles them by timestamp.`,
      ex: `Patrick O'Neil et al. described the LSM-tree in 1996; Google's Bigtable (2006) coined memtable and SSTable. LevelDB (Google, 2011) and RocksDB (Facebook's LevelDB fork, open-sourced 2013, used in MyRocks, TiKV, Kafka Streams and Flink) are embeddable engines. Cassandra, ScyllaDB, HBase and CockroachDB's Pebble use the same design, and Lucene's segments follow the same pattern.`,
      section: "sstables-and-lsm-trees",
    },

    // --- bloom-filters-and-compaction ---
    {
      id: "bloom-filter",
      term: "Bloom filter",
      def: `A compact probabilistic set: an <strong>m-bit array and k hash functions</strong>. Adding a key sets k bits; a query checks the same k bits. Any 0 means the key is <strong>definitely absent</strong>; all 1s mean "maybe present". False positives happen, <strong>false negatives never do</strong>. A standard Bloom filter can't delete keys, because clearing a bit could hide another key.`,
      problem: `In an LSM-tree, looking up a key that doesn't exist means checking the memtable and then every SSTable: the worst-case read.`,
      why: `About <strong>10 bits per key with k ≈ 7 gives roughly 1% false positives</strong> (exactly 1% needs ≈ 9.6 bits per key). With a filter per file, most SSTables that don't hold the key are ruled out without touching disk, and a false positive costs one wasted read, never a wrong answer. Each SSTable gets its own filter when it is written (flush or compaction), kept in RAM: 1 billion keys at 1% is about 1.2 GB. <strong>Tombstoned keys go into the filter too</strong>; otherwise a read would skip the file holding the tombstone and return an older, deleted value. Filters do nothing for range scans, apart from prefix filters when the range shares a key prefix.`,
      ex: `Burton Bloom published the idea in 1970, and Bigtable used per-SSTable Bloom filters in 2006. LevelDB's documentation suggests 10 bits per key. Cassandra exposes <code>bloom_filter_fp_chance</code> per table. RocksDB and HBase keep a filter per file too, and RocksDB can optionally build prefix filters that help scans over one key prefix.`,
      section: "bloom-filters-and-compaction",
    },
    {
      id: "compaction",
      term: "Compaction",
      def: `The background process that <strong>merges SSTables (or segments) into new files</strong>, keeping only the newest version of each key and discarding overwritten values and, when it is safe, tombstones. The input files keep serving reads until the output is ready; then the new files atomically replace them.`,
      problem: `Append-only storage accumulates overwritten values and tombstones forever; reads slow as files multiply and the disk fills.`,
      why: `Compaction bounds how many files a read touches (read amplification) and how much dead data sits on disk (space amplification). It pays for that by rewriting data (write amplification), using disk bandwidth that foreground reads and writes also need, which shows up as p99 latency spikes. The strategy (<strong>size-tiered, leveled, time-window</strong>) sets the balance. A tombstone can be dropped only once no older copy of its key can exist below it, for example at the bottom level. If writes outpace compaction, debt builds up. The book notes that SSTable engines typically don't throttle writes; modern RocksDB does, slowing and then stopping writes (a "write stall") when L0 or pending compaction grows too large.`,
      ex: `LevelDB and RocksDB use leveled compaction (RocksDB also offers "universal", a tiered variant). HBase runs minor and major compactions. Cassandra offers SizeTiered, Leveled and TimeWindow strategies and added the Unified Compaction Strategy in 5.0. Bitcask's merge and Kafka's log cleaner for compacted topics are the same idea applied to hash-indexed segments and message logs.`,
      section: "bloom-filters-and-compaction",
    },
    {
      id: "tombstone",
      term: "Tombstone",
      def: `A <strong>deletion marker</strong> appended in place of erasing data. Reads that reach it return "not found"; compaction later drops the marker together with the older values it hides, once no older copy can remain (and, in replicated stores, after a grace period).`,
      problem: `Append-only, immutable files can't erase a value in place, and without a marker an older copy in another file would reappear on reads.`,
      why: `A delete is therefore a write that costs space and read time until compaction: a range scan over heavily deleted data must still step over every tombstone. In a replicated store the tombstone must also outlive the time replicas need to learn about the delete. Otherwise a replica that missed it can bring the value back during repair (Chapter 5).`,
      ex: `Cassandra keeps tombstones for <code>gc_grace_seconds</code> (864,000 s, i.e. 10 days, by default), logs a warning when a query scans 1,000 of them and aborts it at 100,000. Discord (2017) described a channel where nearly all messages had been deleted: reads scanned millions of tombstones and caused long GC pauses, until Discord shortened the tombstone lifespan and changed its queries. In Kafka compacted topics, a record with a null value is the tombstone.`,
      section: "bloom-filters-and-compaction",
    },
    {
      id: "size-tiered-vs-leveled",
      term: "Size-tiered vs leveled compaction",
      def: `<strong>Size-tiered</strong> compaction merges SSTables of similar size into larger ones: fewer rewrites, but more files per read and more space for duplicates. <strong>Leveled</strong> compaction keeps each level (L1, L2, ...) as one sorted run of small non-overlapping files, each level about 10x larger than the one above, and merges incrementally, one file into the overlapping files of the next level: about one file per level per read, less space, more rewriting. Freshly flushed files land in L0, where they may overlap.`,
      problem: `Merging everything after every flush is too expensive; merging too lazily leaves reads checking many files and fills the disk with dead data.`,
      why: `It's a choice of which amplification to pay. <strong>Size-tiered</strong>: lower write amplification, but a point read may check several overlapping runs per tier, space amplification is often 2x or more in the worst case, and a big merge temporarily needs free space about equal to its inputs. <strong>Leveled</strong>: a point read checks every L0 file whose range covers the key, then at most one file per deeper level, and steady-state space amplification is about 1.1x. But data is rewritten on its way down: in the worst case each level costs about the size ratio (~10), and totals of 10–30x are commonly reported. <strong>Time-window</strong> compaction suits append-only time series with TTLs, because whole expired files are dropped without rewriting.`,
      ex: `LevelDB and RocksDB are leveled by default (RocksDB's <code>max_bytes_for_level_multiplier</code> is 10). HBase is size-tiered. Cassandra offers SizeTieredCompactionStrategy (long its default), LeveledCompactionStrategy, TimeWindowCompactionStrategy and, since 5.0, the Unified Compaction Strategy, which can behave like either.`,
      section: "bloom-filters-and-compaction",
    },

    // --- b-trees ---
    {
      id: "b-tree",
      term: "B-tree",
      def: `A balanced tree of <strong>fixed-size pages</strong>: traditionally 4 KB, 8 KB in PostgreSQL and SQL Server, 16 KB by default in InnoDB, 4 KB by default in SQLite. Pages refer to each other by page number. Internal pages hold keys and child references, each child covering a contiguous key range; leaf pages hold keys with their values or row references. A lookup reads one page per level from the root, and updates <strong>overwrite pages in place</strong>. Most databases implement the <strong>B+tree</strong> variant, which keeps values only in the leaves and links each leaf to its siblings for range scans.`,
      problem: `We need an on-disk sorted index with point and range lookups in a small, predictable number of disk reads, for data far larger than RAM, that also supports updates.`,
      why: `With a <strong>branching factor of several hundred</strong>, 3–4 levels cover almost any database. Four levels of 4 KB pages with 500 children each address up to 256 TB. The upper levels stay cached, so a lookup typically costs 1–2 real disk reads, and latency is predictable because no background merge competes for the disk. One structure serves equality, ranges, prefixes and ORDER BY, and each key lives in exactly one place, which makes range locks easy (Chapter 7). The costs: each change rewrites a whole page plus a WAL record; splits leave pages partly empty (about 69% full on average under random inserts); and overwriting in place needs a WAL plus latches.`,
      ex: `Rudolf Bayer and Edward McCreight introduced B-trees in 1970 (published 1972), and Douglas Comer's 1979 survey already called them ubiquitous. PostgreSQL's nbtree (a Lehman–Yao B-link tree with 8 KB pages), InnoDB's clustered tables (16 KB pages), SQL Server, Oracle and MongoDB's WiredTiger engine all use B+tree variants. SQLite uses B+trees for tables and plain B-trees for indexes.`,
      section: "b-trees",
    },
    {
      id: "page-split",
      term: "Page split and branching factor",
      def: `When a B-tree page has no room for a new key, it <strong>splits</strong> into two roughly half-full pages and adds a separator key to the parent, which may split in turn, all the way up to the root. A root split is the only way the tree grows taller. The <strong>branching factor</strong> (child pointers per page, usually several hundred) keeps trees 3–4 levels deep. In a B+tree, a leaf split <em>copies</em> the right leaf's first key into the parent, while an internal split <em>moves</em> its middle key up.`,
      problem: `Fixed-size pages fill up, and the tree must grow without becoming unbalanced so that every lookup stays at a few page reads.`,
      why: `Splits keep every leaf at the same depth, so lookups stay cheap however the data grows. But one logical insert can rewrite three or more pages (old leaf, new leaf, parent, sometimes up to the root), which is why the WAL exists, and split pages are left partly empty. <strong>Insert order matters</strong>. Sequential keys always split the rightmost leaf and leave nearly full pages behind (InnoDB: about 15/16 full). Random keys such as UUIDv4 split pages all over the tree, leave them between 1/2 and 15/16 full, and spread writes over the whole index. Shorter separator keys (key abbreviation) raise the branching factor.`,
      ex: `Random vs sequential primary keys in MySQL InnoDB is the classic case. RFC 9562 (2024) standardized UUIDv7, whose leading timestamp bits make new ids roughly time-ordered, partly for index locality. PostgreSQL B-tree indexes have a <code>fillfactor</code> (default 90%) that leaves room in each leaf for later inserts.`,
      section: "b-trees",
    },

    // --- write-ahead-log ---
    {
      id: "write-ahead-log-redo-log",
      term: "Write-ahead log (WAL) / redo log",
      def: `An append-only file to which every page modification is written <strong>before</strong> it is applied to the pages themselves. The rule has two halves. <strong>Log before data</strong>: no page may reach disk before the log record describing its change. <strong>Commit after log</strong>: a transaction is acknowledged only once its commit record is durable (fsynced). After a crash, the database replays (redoes) the log from the last checkpoint.`,
      problem: `One B-tree insert can overwrite several pages; a crash between those writes corrupts the tree (orphan pages, lost keys), and the lost keys can be old, long-committed data.`,
      why: `It makes multi-page updates, such as a split that touches the old leaf, a new leaf and the parent, all-or-nothing, and it lets dirty pages be flushed lazily in any order. Each log record has a <strong>log sequence number (LSN)</strong>, and each page stores the LSN of the last change applied to it, so redo skips changes a page already has. That makes redo idempotent, so a crash during recovery is harmless. <strong>Checkpoints</strong> bound recovery time and let old log be recycled; <strong>group commit</strong> amortizes one fsync over many transactions. Torn pages need extra protection (full page images or a doublewrite buffer). The same log also serves replication (Chapter 5) and change data capture (Chapter 11).`,
      ex: `PostgreSQL's WAL feeds crash recovery, streaming replication and point-in-time recovery. InnoDB pairs a redo log with a doublewrite buffer. SQLite offers a rollback journal or, since 3.7.0 (2010), WAL mode. LSM engines use one too: RocksDB's WAL and Cassandra's commit log exist only to rebuild the memtable. ARIES (IBM, 1992) is the classic recovery algorithm: redo history, then undo uncommitted transactions (Chapter 7). PostgreSQL's 2018 "fsyncgate" showed that durability also depends on fsync telling the truth.`,
      section: "write-ahead-log",
    },
    {
      id: "torn-page",
      term: "Torn page",
      def: `A page write interrupted by power loss, leaving part of the page new and part old. Database pages (8–16 KB) are larger than the 512 B–4 KB units the hardware writes atomically. Engines defend against this with full page images in the WAL (PostgreSQL <code>full_page_writes</code>) or a doublewrite buffer (InnoDB), and detect it with page checksums.`,
      problem: `Redo records describe changes to an intact page; a half-written page can't be repaired from a small delta.`,
      why: `Checksums alone only <em>detect</em> the damage. To repair it, the engine needs an intact copy of the page from somewhere, then replays the log on top of that copy. That copy costs extra writes: in PostgreSQL, WAL volume spikes right after each checkpoint because the first change to every page logs the whole page.`,
      ex: `PostgreSQL's <code>full_page_writes</code> (on by default) logs a full image of each page the first time it changes after a checkpoint; its documentation notes it may be safe to turn off on file systems that prevent partial page writes, such as ZFS. InnoDB writes each page to the doublewrite area first, then to its real location, and during recovery restores a torn page from the intact copy.`,
      section: "write-ahead-log",
    },
    {
      id: "copy-on-write-btree",
      term: "Copy-on-write B-tree",
      def: `Instead of overwriting a page, write the modified page to a new location, write new copies of its ancestors up to the root, then <strong>atomically switch the root pointer</strong>. The old root still describes a complete, consistent tree.`,
      problem: `Overwriting pages in place needs a WAL for crash safety and latches to keep readers from seeing half-modified pages; never overwriting avoids both.`,
      why: `A crash leaves either the old root or the new one, both consistent, so there's no redo log and no torn-page problem. Readers keep using the root they started with, so they get consistent snapshots without blocking the writer (snapshot isolation, Chapter 7). The costs: every change rewrites the whole path from leaf to root, freed pages need garbage collection, and designs such as LMDB allow only one writer at a time.`,
      ex: `LMDB (used by OpenLDAP) is a copy-on-write B+tree with no WAL and no recovery step. The btrfs file system (named after the B-tree) uses copy-on-write B-trees. CouchDB's append-only B-tree file is another variant and needs periodic compaction to reclaim the old pages.`,
      section: "write-ahead-log",
    },

    // --- lsm-vs-btree ---
    {
      id: "write-amplification",
      term: "Write, read and space amplification",
      def: `<strong>Write amplification</strong>: bytes written to disk per byte the application wrote, over the data's lifetime. <strong>Read amplification</strong>: disk reads (or bytes read) per query. <strong>Space amplification</strong>: bytes on disk per byte of live data. Storage engines trade these against each other.`,
      problem: `"LSM is faster for writes" is too vague to choose or tune an engine; you need to know what each design actually costs in disk bandwidth, SSD wear and space.`,
      why: `In write-heavy systems disk write bandwidth is the bottleneck, and SSDs survive only a finite number of program/erase cycles, so write amplification sets both throughput and hardware lifetime. Illustrative orders of magnitude: a B-tree that rewrites a 16 KB page to change one 100-byte row writes about 164x the logical data in the worst case (one update per page flush), about 165x with the WAL; a leveled LSM commonly writes each byte 10–30 times through compaction; size-tiered writes less but stores more. Caching, batching and configuration move these numbers a lot, so measure your own workload. The <strong>RUM conjecture</strong> (Athanassoulis et al., 2016) says an access method can optimize at most two of read overhead, update overhead and memory (space) overhead.`,
      ex: `RocksDB reports write amplification per level in its compaction statistics. Facebook moved its main MySQL user database (UDB) from compressed InnoDB to MyRocks, and its engineers reported roughly half the storage and lower write amplification. WiscKey (FAST 2016) keeps large values in a separate log so compaction moves only keys; RocksDB BlobDB, TiKV's Titan and Dgraph's Badger use the same idea.`,
      section: "lsm-vs-btree",
    },

    // --- other-indexes ---
    {
      id: "heap-file",
      term: "Heap file",
      def: `Table storage in which rows live <strong>in no particular order</strong>, and every index points to a row's location (page and slot). Several indexes share one copy of each row, but a row that moves requires updating every index or leaving a forwarding pointer.`,
      problem: `With several indexes, storing the full row in each would duplicate data and multiply write costs.`,
      why: `Each index stores only a small pointer, so adding indexes doesn't duplicate rows. The catch is moves: a row that grows beyond its slot has to relocate, and then every index needs fixing or the old slot needs a forwarding pointer. Every index hit also costs one more random read into the heap, unless the index covers the query.`,
      ex: `PostgreSQL tables are heaps, and its indexes point to tuple ids (<code>ctid</code>). PostgreSQL's MVCC never updates a row in place: every UPDATE writes a new row version, usually at a new ctid, so every index normally gets a new entry. The exception is a HOT (heap-only tuple) update, where no indexed column changed and the same page has room. That write amplification was central to Uber's 2016 post on moving from PostgreSQL to MySQL. SQL Server tables without a clustered index are also heaps and use forwarding pointers when rows move.`,
      section: "other-indexes",
    },
    {
      id: "clustered-vs-secondary-index",
      term: "Clustered vs secondary index",
      def: `Two independent questions. <strong>Which key?</strong> A <em>primary</em> index is on the primary key (unique, one per table); a <em>secondary</em> index is on any other column(s), and its keys need not be unique. <strong>Where does the row live?</strong> In a heap-file design every index holds a pointer to the row's location. In a <em>clustered</em> index the row itself is stored in the index's leaves, so the table <em>is</em> the index. A table has at most one clustered index, and its secondary indexes then refer to rows by the clustering key, not by a location.`,
      problem: `Pointing from an index into a heap file costs an extra read per index hit; storing the row inside the index removes that hop but makes secondary indexes heavier.`,
      why: `Clustering makes primary-key lookups and range scans a single tree descent that ends at the row. Secondary indexes stay valid when rows move, because they store the key rather than a location. The price: a secondary lookup takes <strong>two B-tree descents</strong> (secondary index to primary key, then the clustered index), and a wide primary key bloats every secondary index. Covering indexes (INCLUDE) remove the second hop for hot queries.`,
      ex: `InnoDB clusters every table on its primary key (or on the first UNIQUE NOT NULL index, or else on a hidden 6-byte row id), and its secondary indexes store the primary-key value, not a row id. In PostgreSQL every table is a heap and all indexes, the primary key's included, point to tuple ids; its <code>CLUSTER</code> command reorders the heap once but doesn't maintain the order. SQL Server lets you choose one clustered index per table.`,
      section: "other-indexes",
    },
    {
      id: "covering-index",
      term: "Covering index",
      def: `An index that also stores some <strong>non-key columns</strong> (e.g. PostgreSQL or SQL Server <code>INCLUDE</code>), so queries that need only those columns are answered from the index alone: an <strong>index-only scan</strong>.`,
      problem: `Otherwise every secondary-index hit costs an extra random read into the heap file or clustered index.`,
      why: `It sits between a pure pointer index and a clustered index. Hot queries skip the extra hop, at the cost of more storage and more write work, since the copied columns must stay transactionally consistent with the table. In PostgreSQL, index-only scans also depend on the visibility map: rows on pages changed since the last VACUUM still need a heap check.`,
      ex: `SQL Server has had included columns since 2005; PostgreSQL added index-only scans in 9.2 (2012) and <code>CREATE INDEX ... INCLUDE</code> in 11 (2018). <code>CREATE INDEX ON orders (customer_id) INCLUDE (status, total)</code> lists a customer's orders with status and total without touching the table. Every InnoDB secondary index implicitly carries the primary-key columns, so queries needing only those are already covered.`,
      section: "other-indexes",
    },
    {
      id: "multi-dimensional-index",
      term: "Concatenated and multi-dimensional indexes",
      def: `A <strong>concatenated</strong> index sorts by (col1, col2, ...) like a phone book: fast for a leading prefix of the columns, useless for a later column alone. Queries that constrain several dimensions at once (latitude AND longitude ranges) need a <strong>space-filling curve</strong> (geohash, Z-order, Hilbert/S2) over a 1-D index, or a <strong>spatial index</strong> such as an R-tree.`,
      problem: `A 1-D sorted index can range-scan only one dimension at a time: a map rectangle becomes a stripe across the whole planet that must be filtered.`,
      why: `The leftmost-prefix rule decides which queries a composite index can serve: put equality columns first, then the range or sort column. Some engines can <em>skip-scan</em> when the leading column has few distinct values (Oracle, MySQL 8.0.13+, PostgreSQL 18+), but that's a fallback, not a design. For real multi-dimensional ranges, a space-filling curve maps nearby points to mostly nearby keys: an aligned box becomes one key range, a misaligned one a few. Points just across a cell boundary can get very different codes, so a search must include neighboring cells. R-trees index bounding boxes directly.`,
      ex: `PostGIS builds R-trees on PostgreSQL's GiST framework. Redis GEO stores each point's geohash as its score in a sorted set. Google's S2 library uses a Hilbert curve over the faces of a cube projected onto the sphere, and Uber open-sourced H3, a hexagonal hierarchical grid, in 2018. Other multi-dimensional queries: (date, temperature) ranges over weather data, or RGB color ranges.`,
      section: "other-indexes",
    },
    {
      id: "full-text-fuzzy-index",
      term: "Full-text and fuzzy indexes",
      def: `Indexes for approximate matching. <strong>Inverted indexes</strong> map terms to posting lists of documents. Lucene keeps its term dictionary in sorted, SSTable-like files with an in-memory finite-state transducer (FST) as its term index, and can find all terms within an edit distance using <strong>Levenshtein automata</strong>. Vector indexes (HNSW, IVF) extend the idea to similarity search over embeddings.`,
      problem: `Exact-key indexes can't find misspellings, synonyms, grammatical variants or "similar" items.`,
      why: `Text is analyzed into terms (tokenized, lowercased, stemmed, with synonyms added). Each term maps to a sorted postings list of document ids, and a query intersects or unions postings lists. Because the term dictionary is sorted, an automaton can walk it to find every term within edit distance 1 or 2 of a typo without testing each term. Lucene's index is log-structured: immutable segments merged in the background. Vector indexes trade exactness for speed in the same spirit: approximate nearest neighbors, tuned by recall.`,
      ex: `Lucene 4.0 (2012) introduced finite-state transducers for its term index and a Levenshtein-automaton FuzzyQuery, making fuzzy matching far faster than enumerating terms. Elasticsearch, OpenSearch and Solr build on Lucene. PostgreSQL offers GIN indexes for full-text search and <code>pg_trgm</code> for trigram similarity. pgvector added HNSW indexes in 0.5.0 (2023) alongside IVFFlat.`,
      section: "other-indexes",
    },
    {
      id: "in-memory-database",
      term: "In-memory database",
      def: `A database whose primary copy of the data lives <strong>in RAM</strong>. Durability, if any, comes from an append-only log, snapshots, battery-backed RAM or replication. Its speed comes mainly from <strong>not encoding data structures into a disk format</strong>, not from avoiding disk reads, which the OS page cache already avoids.`,
      problem: `Disk-oriented engines pay for buffer management, page layouts and serialization even when the whole dataset fits in memory.`,
      why: `Counterintuitively, skipping disk reads isn't the main win: a disk-based engine with enough RAM serves hot pages from its buffer pool or the page cache anyway. The gains come from dropping page layouts, buffer-pool management and page latches, often plus single-threaded or per-partition execution that avoids most locking. In-memory storage also makes data models practical that are awkward on disk, such as sorted sets and priority queues. The costs: RAM per GB, restarts that take longer as the dataset grows (reload from snapshot plus log, or from a replica), and durability that is only as good as the log and snapshot policy. Anti-caching evicts cold records to disk to go beyond RAM.`,
      ex: `Memcached is a cache only: losing data on restart is acceptable. Redis persists through RDB snapshots and an append-only file; with AOF on, the default <code>appendfsync everysec</code> can lose about a second of writes in a crash. VoltDB, SingleStore (formerly MemSQL), Oracle TimesTen and RAMCloud are durable in-memory databases. The book expected non-volatile memory to reshape storage engines, but Intel announced in 2022 that it was winding down Optane, so that future hasn't reached mainstream hardware.`,
      section: "other-indexes",
    },

    // --- oltp-vs-olap ---
    {
      id: "oltp-vs-olap",
      term: "OLTP vs OLAP",
      def: `<strong>OLTP</strong> (online transaction processing): many small queries that read or write a few records by key, issued by end users through an application and needing low latency; the data is the <em>current state</em>. <strong>OLAP</strong> (online analytic processing): fewer, bigger queries that scan millions to billions of records and aggregate a few columns, issued by analysts and BI tools; the data is a <em>history of events</em>. "Transaction" here just means low-latency reads and writes, not necessarily ACID.`,
      problem: `One database tuned for small keyed transactions struggles when analysts scan years of history, and the reverse.`,
      why: `The bottlenecks are opposite. OLTP is bound by <strong>disk seek time</strong>: indexes find a few rows quickly. OLAP is bound by <strong>disk bandwidth</strong>: indexes don't help when most rows must be read anyway, but reading fewer bytes per row does. So the storage engines diverge: row-oriented B-trees or LSM-trees for OLTP; column-oriented, compressed storage for OLAP, usually in separate systems.`,
      ex: `OLTP: a checkout that reads one cart and writes one order in PostgreSQL, MySQL or DynamoDB. OLAP: "revenue per store per month for the last two years" in BigQuery, Snowflake, Redshift or ClickHouse. HTAP systems (TiDB with TiFlash columnar replicas, SQL Server columnstore indexes, SingleStore) try to serve both.`,
      section: "oltp-vs-olap",
    },
    {
      id: "data-warehouse",
      term: "Data warehouse",
      def: `A separate database, read-only for analysts, holding a copy of the data from all of a company's OLTP systems, organized for analytics, so analysts can query freely without affecting operations. Data arrives via <strong>ETL or ELT</strong>, as periodic dumps or continuous change streams.`,
      problem: `Analytic queries on production OLTP databases scan huge ranges and hurt customer-facing latency, and the data is scattered across dozens of systems.`,
      why: `Separation lets each side be optimized. OLTP databases keep their latency guarantees, and the warehouse uses columnar, compressed storage tuned for scans. It also integrates data from dozens of systems (web shop, point of sale, inventory, HR) into one consistent schema. Warehouses usually speak SQL, because BI tools generate it, but their internals look nothing like an OLTP engine. Modern cloud warehouses separate storage (columnar files in object storage) from elastic compute, and <strong>ELT</strong> (load raw data, transform it inside the warehouse with tools like dbt) has largely replaced transforming before loading. A small company with few systems may be fine with an ordinary SQL database, or even a spreadsheet.`,
      ex: `Teradata and Vertica; Amazon Redshift (2012, based on ParAccel); Google BigQuery (built on Dremel, described in a 2010 paper); Snowflake (SIGMOD 2016: storage in S3, compute in elastic "virtual warehouses"); ClickHouse; and lakehouses on Apache Iceberg, Delta Lake or Hudi tables over Parquet files.`,
      section: "oltp-vs-olap",
    },
    {
      id: "etl",
      term: "ETL (extract–transform–load)",
      def: `A pipeline that pulls data out of OLTP systems (periodic dumps or continuous change streams), cleans and reshapes it into an analysis-friendly schema, and loads it into the warehouse. Cloud warehouses often use <strong>ELT</strong>: load the raw data first, then transform it inside the warehouse.`,
      problem: `Analysts need data from dozens of operational systems in one consistent schema, without loading those systems with analytic queries.`,
      why: `It decouples the warehouse's schema from each operational system's. Transformations clean data, conform keys and reshape it into a star schema. Batch extracts are simple but stale (yesterday's data). <strong>Change data capture</strong> (CDC) from the database's WAL or binlog keeps the warehouse seconds to minutes behind (Chapter 11). Pipelines break when upstream schemas change, so schema evolution matters (Chapter 4).`,
      ex: `Nightly batch jobs scheduled by a tool such as Airflow; Debezium reading the PostgreSQL WAL or MySQL binlog into Kafka; managed loaders such as Fivetran copying raw tables into Snowflake or BigQuery, with dbt models doing the transformation in SQL.`,
      section: "oltp-vs-olap",
    },
    {
      id: "star-snowflake-schema",
      term: "Star and snowflake schema",
      def: `<strong>Star schema</strong> (dimensional modeling): a central <strong>fact table</strong> with one row per event (a sale, a page view, a click) at fine granularity. Its columns are measures (quantity, net price, cost) plus foreign keys to <strong>dimension tables</strong> that describe who, what, where, when, how and why (customer, product, store, promotion, date). <strong>Snowflake schema</strong>: dimensions are normalized further into sub-dimensions (product to brand and category).`,
      problem: `Analysts need a predictable, easy-to-query layout where every business event is recorded once with its who, what, where and when.`,
      why: `Queries become predictable: filter and group by dimension attributes, aggregate fact columns, one join per dimension. Fact tables dominate the size (the book, circa 2017, cites tens of petabytes of transaction history at companies such as Apple, Walmart and eBay) and are <strong>often 100+ columns wide</strong>; dimension tables are smaller but can be wide too. <strong>Date is usually a dimension</strong>, so calendar attributes such as public holidays or fiscal quarters can be queried. Star schemas are deliberately denormalized compared with Chapter 2's normalization advice, and analysts often prefer them to snowflakes because they are simpler.`,
      ex: `Ralph Kimball's <em>The Data Warehouse Toolkit</em> (1996) popularized dimensional modeling. Retail example: <code>fact_sales(date_key, product_sk, store_sk, promotion_sk, customer_sk, quantity, net_price, ...)</code> with <code>dim_date</code>, <code>dim_product</code>, <code>dim_store</code>, <code>dim_promotion</code> and <code>dim_customer</code>. A basket of several products becomes several fact rows.`,
      section: "oltp-vs-olap",
    },

    // --- column-storage ---
    {
      id: "column-oriented-storage",
      term: "Column-oriented storage",
      def: `Store all the values of one column contiguously, in its own file or region, instead of all the fields of one row together. <strong>Every column file keeps the rows in the same order</strong>: position <em>k</em> of every column file together forms row <em>k</em>. A query reads and parses only the columns it uses.`,
      problem: `Row stores must read entire rows of 100+ columns from disk even when a query needs 3 columns.`,
      why: `I/O becomes proportional to the columns a query touches, not to the row width: reading 3 of 100 similar-width columns moves about 33x less data. Same-typed, repetitive values compress well and suit vectorized execution. It works only because the columns share row order, so <strong>you sort whole rows</strong>; sorting one column on its own breaks the alignment. Point lookups of whole rows and single-row writes get worse, because one row is spread over many files.`,
      ex: `Parquet and ORC files; Vertica (from C-Store), Redshift, BigQuery (from Dremel), Snowflake, ClickHouse and DuckDB. <strong>Not columnar</strong>: Cassandra and HBase "column families" (from Bigtable) store all the columns of a row together with its row key, so they are mostly row-oriented despite the name.`,
      section: "column-storage",
    },
    {
      id: "column-compression",
      term: "Column compression",
      def: `Encodings that exploit repetition within a column. <strong>Dictionary encoding</strong> (the most common in practice) replaces values with small integer codes. <strong>Bitmap encoding</strong> keeps one bitmap per distinct value, with one bit per row. <strong>Run-length encoding</strong> (RLE) stores (value, count) runs. Delta, frame-of-reference and bit-packing shrink numbers. Engines combine these and often apply a general-purpose codec (LZ4, Zstd, Snappy) on top.`,
      problem: `Even reading only the needed columns, scanning billions of values is bandwidth-bound; columns are repetitive, so they compress far better than rows.`,
      why: `Savings depend heavily on the data: usually several times over raw, and orders of magnitude only for low-cardinality columns sorted into long runs. Less data means less disk and memory bandwidth and more values per CPU cache line. Bitmaps also evaluate predicates directly: <code>product_sk IN (12, 40, 41)</code> is an OR of three bitmaps, and <code>product_sk = 7 AND store_sk = 3</code> is an AND, which works only because all columns share row order. Bitmaps for high-cardinality columns are sparse, so they are run-length encoded too (Roaring bitmaps are a popular modern format).`,
      ex: `Parquet combines dictionary encoding with an RLE/bit-packing hybrid, and ORC is similar. ClickHouse has <code>LowCardinality</code> (dictionary) columns and codecs such as Delta, DoubleDelta and Gorilla. Apache Druid and Apache Pinot build Roaring bitmap indexes. Abadi et al. survey the techniques.`,
      section: "column-storage",
    },
    {
      id: "sort-order-in-columns",
      term: "Sort order in columns",
      def: `Keep the rows of a column store sorted by one or more chosen columns, as in an SSTable (say date first, then product), instead of in insertion order. You sort <strong>whole rows</strong>, never columns independently, because every column file must stay aligned.`,
      problem: `Without an order, every query scans everything, and repeated values are scattered so run-length encoding can't help.`,
      why: `Sort keys act as an index: a "last month" query reads only that month's range, and per-block min/max statistics (<strong>zone maps</strong>) let the engine skip blocks that can't match. They also help compression. <strong>The first sort key compresses best</strong>, forming long runs that RLE shrinks to almost nothing even over billions of rows; the second compresses less, and later columns look essentially random. Choose sort keys from common query filters. Data is replicated anyway, so C-Store/Vertica stored each replica in a different sort order (projections) and let each query use the best one.`,
      ex: `Vertica projections; Redshift sort keys with min/max metadata per 1 MB block; ClickHouse's ORDER BY key with a sparse index entry per 8,192-row granule; Snowflake pruning micro-partitions by their min/max metadata; Parquet row-group statistics that let readers skip whole row groups.`,
      section: "column-storage",
    },
    {
      id: "vectorized-processing",
      term: "Vectorized processing",
      def: `Running query operators over <strong>batches of column values</strong> (often around a thousand) that fit in the CPU cache, in tight loops with no function call per row, often with SIMD instructions and sometimes directly on compressed data.`,
      problem: `Once columnar layouts cut disk I/O, per-row CPU overhead (function calls, branch mispredictions, cache misses) becomes the bottleneck when scanning billions of rows.`,
      why: `Analytic engines become bound by CPU and memory bandwidth, not by disk. Cache-sized chunks stay in L1/L2, per-row interpretation overhead disappears, the compiler can use SIMD, and compressed data fits more values per cache line. Bitwise AND/OR over bitmaps can run directly on compressed chunks. The main alternative is compiling each query into machine code (HyPer, Spark's whole-stage code generation).`,
      ex: `MonetDB/X100 (CIDR 2005) introduced the model, later commercialized as Vectorwise. DuckDB, ClickHouse and Snowflake execute vectorized, and Meta's Velox is a vectorized execution library. Apache Arrow standardizes the in-memory columnar format these batches use.`,
      section: "column-storage",
    },

    // --- column-writes-and-cubes ---
    {
      id: "column-store-writes",
      term: "Write buffering in column stores",
      def: `Column stores send writes to an <strong>in-memory store</strong> (often row-oriented) and periodically <strong>merge them in bulk</strong> into new compressed, sorted column files, LSM-style. Queries read both and combine the results, so new data is visible right away.`,
      problem: `Compressed, sorted column files can't be updated in place: inserting one row in the middle would mean rewriting every column file consistently.`,
      why: `It's the LSM idea applied to analytics: writes are cheap and visible to the next query, and reads stay fast as long as the merges keep up. Single-row inserts are the anti-pattern, because each one creates a small file or part that has to be merged. Batch inserts (thousands of rows at a time) or use the engine's buffered or asynchronous inserts.`,
      ex: `Vertica's classic design had an in-memory write-optimized store (WOS) and an on-disk read-optimized store (ROS), with a Tuple Mover merging them; later versions load straight into ROS. Each ClickHouse INSERT creates an immutable part that background merges combine, and tiny frequent inserts end in a "too many parts" error. Iceberg and Delta Lake handle row-level changes by rewriting Parquet files (copy-on-write) or by writing delete files that readers merge (merge-on-read), followed by compaction.`,
      section: "column-writes-and-cubes",
    },
    {
      id: "materialized-view-data-cube",
      term: "Materialized view / data cube",
      def: `A <strong>materialized view</strong> stores a query's result on disk (a denormalized copy) and must be refreshed or maintained when the base data changes; a <em>virtual</em> view is just a saved query, expanded at read time. A <strong>data cube</strong> (OLAP cube) is a materialized grid of aggregates grouped by several dimensions, e.g. date x product with SUM(net_price) in each cell and totals along each row and column. Real cubes often have five or more dimensions.`,
      problem: `Dashboards repeatedly run the same expensive aggregations over raw data.`,
      why: `Precomputed answers turn scans into lookups, at the cost of write work, storage and staleness, which is why they suit read-heavy warehouses better than OLTP databases. The limits are concrete. A cube can't answer questions about attributes that aren't dimensions: "what share of sales comes from items over $100?" is impossible if price isn't a dimension. Only <strong>decomposable aggregates</strong> roll up: SUM, COUNT, MIN and MAX (store SUM and COUNT to get AVG). Medians and exact distinct counts don't; sketches such as HyperLogLog approximate them. A d-dimensional cube has 2^d group-by combinations. So keep the raw facts and precompute only the hot paths.`,
      ex: `Gray et al.'s data cube operator (1996) became SQL's <code>GROUP BY CUBE</code> and <code>ROLLUP</code>. PostgreSQL 9.3 added <code>CREATE MATERIALIZED VIEW</code> with explicit <code>REFRESH</code> (<code>CONCURRENTLY</code> since 9.4), which recomputes the whole view. ClickHouse materialized views act as insert triggers feeding aggregating tables; Apache Druid rolls up rows at ingestion; Apache Kylin (from eBay) precomputes cubes on Hadoop; streaming systems such as Materialize and RisingWave maintain views incrementally (Chapters 11–12).`,
      section: "column-writes-and-cubes",
    },
  ],

  // ------------------------------------------------------------------
  // CHEATSHEET
  // ------------------------------------------------------------------
  cheatsheet: [
    {
      title: "LSM-tree vs B-tree",
      type: "table",
      headers: ["", "B-tree", "LSM-tree"],
      rows: [
        [`<span style="overflow-wrap:normal;word-break:normal">Writes</span>`, "In place: find the leaf page, modify it, write it back later; WAL record first", "Append to the WAL and insert into the memtable; flushed sequentially as SSTables"],
        [`<span style="overflow-wrap:normal;word-break:normal">Reads touch</span>`, "One root-to-leaf path (3–4 pages; upper levels cached, so 1–2 disk reads)", "Memtable + every L0 file covering the key + up to one file per deeper level (leveled); Bloom filters skip most files"],
        [`<span style="overflow-wrap:normal;word-break:normal">Range scans</span>`, "Descend once, then walk the linked leaves", "Merge one iterator per overlapping sorted run; Bloom filters don't help"],
        [`<span style="overflow-wrap:normal;word-break:normal">Each key stored</span>`, "Exactly once (range locks attach easily)", "Possibly in several files until compaction"],
        [`<span style="overflow-wrap:normal;word-break:normal">Write amplification</span>`, "WAL + whole-page rewrite (4–16 KB) per change, extra on splits/doublewrite", "Rewritten at each compaction (leveled: high, often 10x+; tiered: lower)"],
        [`<span style="overflow-wrap:normal;word-break:normal">Space amplification</span>`, "Fragmentation (pages ~50–94% full)", "Leveled ≈ 1.1x in steady state; size-tiered often 2x or more in the worst case; tombstones until compaction"],
        [`<span style="overflow-wrap:normal;word-break:normal">Compression</span>`, "Page compression exists (InnoDB, WiredTiger) but fixed pages limit it", "Immutable blocks compress well; no half-empty pages"],
        [`<span style="overflow-wrap:normal;word-break:normal">Latency predictability</span>`, "Smooth; costs paid inline on each write", "Compaction competes for disk bandwidth: p99 spikes, write stalls if it falls behind"],
        [`<span style="overflow-wrap:normal;word-break:normal">Concurrency</span>`, "Latches on pages; careful split protocols (B-link trees)", "Immutable files need no read locks; concurrent memtable (skip list)"],
        [`<span style="overflow-wrap:normal;word-break:normal">Crash safety</span>`, "WAL + LSN-based redo; full page images or doublewrite for torn pages", "WAL replays the memtable; SSTables are immutable"],
        [`<span style="overflow-wrap:normal;word-break:normal">Examples</span>`, "PostgreSQL, MySQL InnoDB, SQL Server, Oracle, SQLite, MongoDB WiredTiger, LMDB (copy-on-write)", "RocksDB, LevelDB, Cassandra, ScyllaDB, HBase, Pebble (CockroachDB), Lucene segments"],
      ],
      note: "Folk wisdom says LSM for writes and B-tree for reads. Benchmark your own workload: value size, cache size and settings change the answer.",
    },
    {
      title: "Read, write and space amplification",
      type: "table",
      headers: ["", "Definition", "B-tree", "Leveled LSM", "Size-tiered LSM", "Hash log (Bitcask)"],
      rows: [
        [`<span style="overflow-wrap:normal;word-break:normal">Write amp</span>`, "Disk bytes written per byte the app wrote", "WAL + full page per change; worst case ≈ page / row size (16 KB / 100 B ≈ 164x)", "Up to ≈ the size ratio (~10) per level; 10–30x total commonly reported", "Lower: about once per tier", "Low: one append, plus merges that copy live values"],
        [`<span style="overflow-wrap:normal;word-break:normal">Read amp</span>`, "Disk reads per query", "One path; 1–2 reads with cached upper levels", "L0 files + at most one per level; ≈ 1 read per point lookup with Bloom filters", "Several overlapping runs per tier", "1 read per lookup; no range scans"],
        [`<span style="overflow-wrap:normal;word-break:normal">Space amp</span>`, "Disk bytes per byte of live data", "Fragmentation; pages ~50–94% full", "≈ 1.1x in steady state", "Often 2x+ worst case; big merges need free space", "Grows with garbage until the next merge"],
        [`<span style="overflow-wrap:normal;word-break:normal">RAM needs</span>`, "What must stay in memory", "Hot pages (upper levels cached)", "Memtable, Bloom filters, index blocks", "Memtable, Bloom filters, index blocks", "Every key (the keydir)"],
      ],
      note: "RUM conjecture (Athanassoulis et al., 2016): an access method can optimize at most two of read, update and memory/space overhead.",
    },
    {
      title: "LSM write path and read path",
      type: "list",
      items: [
        "<strong>Write</strong>: append to the WAL (fsync per policy, often group commit) → insert into the memtable → when full (RocksDB default 64 MB), freeze it and flush an L0 SSTable with its block index and Bloom filter → drop that WAL segment → compaction merges L0 into L1, L1 into L2, and so on.",
        "<strong>Point read</strong>: memtable → frozen memtables → L0 files newest to oldest (every file whose key range covers the key) → at most one file per deeper level. Check the Bloom filter before each file read. The first version found wins; a tombstone ends the search with \"not found\".",
        "<strong>Range scan</strong>: one iterator per sorted run (memtable, each overlapping L0 file, one per level), k-way merged. Newest version wins, tombstones hide keys, per-file min/max keys skip files; Bloom filters don't apply.",
        "<strong>Delete</strong> = write a tombstone. Space comes back only when compaction merges the tombstone with everything it shadows (at the bottom level, and after <code>gc_grace_seconds</code> in Cassandra).",
        "<strong>Cassandra caveat</strong>: a row's cells can be spread across SSTables, so reads merge cells by timestamp from every SSTable that may hold the partition, instead of stopping at the first hit.",
      ],
    },
    {
      title: "Compaction strategies",
      type: "table",
      headers: ["", "Size-tiered", "Leveled", "Time-window"],
      rows: [
        [`<span style="overflow-wrap:normal;word-break:normal">How it merges</span>`, "Merge several SSTables of similar size into one bigger file", "L1+ are each one sorted run of small non-overlapping files, ~10x per level; merge one file into the overlapping files of the next level", "Size-tiered inside the current time window; a closed window is compacted into one file and left alone"],
        [`<span style="overflow-wrap:normal;word-break:normal">Write amp</span>`, "Low", "High: up to ≈ 10x per level (10–30x total reported)", "Very low"],
        [`<span style="overflow-wrap:normal;word-break:normal">Read amp</span>`, "Higher: several overlapping runs per tier", "Low: L0 files + at most one file per level", "Low for time-bounded queries"],
        [`<span style="overflow-wrap:normal;word-break:normal">Space amp</span>`, "High: often 2x+ worst case; a big merge needs free space ≈ its inputs", "Low: ≈ 1.1x", "Low: expired windows dropped whole"],
        [`<span style="overflow-wrap:normal;word-break:normal">Best for</span>`, "Write-heavy, insert-mostly data", "Read-heavy, update-heavy, space-sensitive", "Append-only time series with TTLs"],
        [`<span style="overflow-wrap:normal;word-break:normal">Used by</span>`, "HBase; Cassandra STCS (long the default); RocksDB universal", "LevelDB, RocksDB (default), Cassandra LCS", "Cassandra TWCS"],
      ],
      note: "Cassandra 5.0 added the Unified Compaction Strategy, which can be tuned to behave like tiered or leveled.",
    },
    {
      title: "Bloom filter math",
      type: "note",
      body: `<p><span class="formula">false-positive rate p ≈ (1 − e^(−kn/m))^k</span></p>
<p><span class="formula">best k = (m/n) · ln 2</span></p>
<p><span class="formula">bits per key m/n = −ln p / (ln 2)² ≈ 1.44 · log₂(1/p)</span></p>
<ul>
<li>p = 10% → ≈ 4.8 bits/key, k = 3. p = 1% → ≈ 9.6 bits/key, k = 7. p = 0.1% → ≈ 14.4 bits/key, k = 10.</li>
<li>Rule of thumb: <strong>10 bits/key, k = 7 ≈ 0.8–1%</strong>. Each extra ~4.8 bits per key cuts the rate 10x.</li>
<li>1 billion keys at 1% ≈ 9.6 Gbit ≈ <strong>1.2 GB</strong> of RAM.</li>
<li>Same memory, wrong k hurts: at 4.8 bits/key, k = 3 gives ≈ 10%, k = 7 gives ≈ 16%.</li>
<li>No false negatives; no deletions (counting Bloom or cuckoo filters can delete, at extra cost); no help for range scans.</li>
</ul>`,
    },
    {
      title: "Crash safety in one line each",
      type: "note",
      body: `<ul>
<li><strong>B-tree</strong>: WAL + LSN-based redo from the last checkpoint (+ full page images or a doublewrite buffer for torn pages).</li>
<li><strong>LSM-tree</strong>: WAL rebuilds the memtable; SSTables are immutable, so they can't be half-modified.</li>
<li><strong>Copy-on-write B-tree</strong> (LMDB): write new pages elsewhere, then atomically swap the root pointer; no redo needed.</li>
<li><strong>Bitcask</strong>: per-record CRCs reject torn records; hint files speed up rebuilding the in-memory keydir.</li>
<li>All of them assume fsync really means "on stable storage" (PostgreSQL fsyncgate, 2018).</li>
</ul>`,
    },
    {
      title: "Index types",
      type: "table",
      headers: ["Index", "Good for", "Bad for", "Example"],
      rows: [
        [`<span style="overflow-wrap:normal;word-break:normal">Hash (in-memory keydir)</span>`, "Exact-key lookups in one read", "Ranges, ORDER BY, prefixes; more keys than RAM", "Bitcask, Redis dictionary, PostgreSQL hash index"],
        [`<span style="overflow-wrap:normal;word-break:normal">SSTable / LSM-tree</span>`, "High write throughput, ranges, compression", "Read amplification; compaction tuning", "RocksDB, Cassandra, HBase"],
        [`<span style="overflow-wrap:normal;word-break:normal">B-tree / B+tree</span>`, "Point, range, prefix and ORDER BY with predictable latency", "Page-rewrite write amp; random-key inserts", "PostgreSQL nbtree, InnoDB, SQLite"],
        [`<span style="overflow-wrap:normal;word-break:normal">Heap + secondary indexes</span>`, "Many indexes sharing one copy of each row", "Extra heap hop per hit; moved rows touch every index", "PostgreSQL, SQL Server heaps"],
        [`<span style="overflow-wrap:normal;word-break:normal">Clustered</span>`, "PK lookups and ranges with the row in the leaf", "Secondary lookups take two descents; a wide PK bloats every index", "InnoDB, SQL Server clustered index"],
        [`<span style="overflow-wrap:normal;word-break:normal">Covering (INCLUDE)</span>`, "Hot queries answered from the index alone", "Extra storage and write work", "PostgreSQL 11+ INCLUDE, SQL Server included columns"],
        [`<span style="overflow-wrap:normal;word-break:normal">Concatenated (composite)</span>`, "Leftmost prefix: equality columns, then a range or sort", "A later column alone (unless skip scan)", "INDEX (last_name, first_name)"],
        [`<span style="overflow-wrap:normal;word-break:normal">Spatial / multi-dimensional</span>`, "Several ranges at once: map boxes, nearest neighbors", "Plain 1-D ordering", "PostGIS R-tree (GiST); geohash, S2 or H3 cells in a B-tree; Redis GEO"],
        [`<span style="overflow-wrap:normal;word-break:normal">Full-text (inverted)</span>`, "Terms → postings lists; stemming, synonyms, fuzzy matching", "Frequent single-document updates (segment churn)", "Lucene / Elasticsearch, PostgreSQL GIN"],
        [`<span style="overflow-wrap:normal;word-break:normal">Vector (approximate nearest neighbor)</span>`, "Similarity search over embeddings", "Exact answers; memory-hungry", "pgvector HNSW / IVFFlat"],
        [`<span style="overflow-wrap:normal;word-break:normal">Bitmap (analytics)</span>`, "Low-cardinality columns; AND/OR predicates", "High-churn OLTP updates", "Druid and Pinot (Roaring), Oracle bitmap indexes"],
      ],
    },
    {
      title: "Index rules of thumb",
      type: "list",
      items: [
        "Every index taxes every write that touches its columns; index for real query patterns and drop unused ones (but keep the ones that enforce uniqueness).",
        "Composite indexes follow the <strong>leftmost-prefix rule</strong>: equality columns first, then the range or sort column. A range on the first column stops the second from narrowing the scan.",
        "A <strong>covering index</strong> (INCLUDE) avoids the extra hop to the row; in InnoDB every secondary index already carries the primary key.",
        "Low-cardinality columns (booleans, status) rarely help a B-tree, since the planner prefers a sequential scan, but they are ideal for bitmaps in a column store.",
        "Two independent ranges (geo) need a space-filling curve (search neighboring cells too) or an R-tree.",
        "An LSM range scan merges every overlapping sorted run; <strong>Bloom filters only help point lookups</strong>.",
        "Random primary keys (UUIDv4) scatter B-tree inserts; prefer sequential or time-ordered ids (UUIDv7, ULID) and store UUIDs as 16 bytes, not 36-character strings.",
      ],
    },
    {
      title: "OLTP vs OLAP",
      type: "table",
      headers: ["", "OLTP", "OLAP"],
      rows: [
        [`<span style="overflow-wrap:normal;word-break:normal">Main read pattern</span>`, "Few records per query, fetched by key via an index", "Aggregates over millions to billions of rows, few columns"],
        [`<span style="overflow-wrap:normal;word-break:normal">Main write pattern</span>`, "Random-access, low-latency writes from user input", "Bulk loads (ETL/ELT) or event streams"],
        [`<span style="overflow-wrap:normal;word-break:normal">Used by</span>`, "End users through an application", "Analysts, BI dashboards, data scientists"],
        [`<span style="overflow-wrap:normal;word-break:normal">What data represents</span>`, "Latest state (current point in time)", "History of events over time"],
        [`<span style="overflow-wrap:normal;word-break:normal">Dataset size</span>`, "GB to TB", "TB to PB"],
        [`<span style="overflow-wrap:normal;word-break:normal">Bottleneck</span>`, "Disk seek time (random reads per query)", "Disk and memory bandwidth (bytes scanned)"],
        [`<span style="overflow-wrap:normal;word-break:normal">Storage layout</span>`, "Row-oriented (B-tree or LSM-tree)", "Column-oriented, compressed, sorted"],
        [`<span style="overflow-wrap:normal;word-break:normal">Schema</span>`, "Normalized (Chapter 2)", "Star or snowflake: fact table + dimensions"],
        [`<span style="overflow-wrap:normal;word-break:normal">Examples</span>`, "PostgreSQL, MySQL, Oracle, DynamoDB, Cassandra", "BigQuery, Snowflake, Redshift, ClickHouse, DuckDB"],
      ],
    },
    {
      title: "Row-oriented vs column-oriented",
      type: "list",
      items: [
        "<strong>Row-oriented</strong>: all fields of one record together. Great for \"load this user and all their fields\"; <strong>point lookups of whole rows favor row stores</strong>.",
        "<strong>Column-oriented</strong>: all values of one field together, every column file in the same row order. Great for \"SUM(revenue) over 100 billion rows\".",
        "A column store reads only the columns the query uses: 3 of 100 columns ≈ 33x less I/O.",
        "Compression is often several times over raw, much more for sorted low-cardinality columns; dictionary encoding is the most common technique.",
        "<strong>The first sort key compresses best</strong> (long runs for RLE); later sort keys help less. Sort whole rows, never one column alone.",
        "<strong>Bitmap AND/OR evaluates WHERE clauses</strong> directly on compressed data, because the columns share row order.",
        "Writes are buffered and merged in bulk (Vertica WOS/ROS, ClickHouse parts, lakehouse delete files): batch your inserts.",
        "<strong>Cassandra/HBase column families are NOT column-oriented storage</strong>: a row's columns are stored together with its key.",
      ],
    },
    {
      title: "Column encodings",
      type: "table",
      headers: ["Encoding", "How it works", "Works best on", "Where you see it"],
      rows: [
        [`<span style="overflow-wrap:normal;word-break:normal">Dictionary</span>`, "Replace each value with a small integer code into a per-column or per-chunk dictionary", "Strings with modest cardinality (country, status)", "Parquet, ORC, ClickHouse LowCardinality"],
        [`<span style="overflow-wrap:normal;word-break:normal">Bitmap</span>`, "One bitmap per distinct value, one bit per row", "Low cardinality; WHERE via bitwise AND/OR", "Druid and Pinot (Roaring), Oracle bitmap indexes"],
        [`<span style="overflow-wrap:normal;word-break:normal">Run-length (RLE)</span>`, "Store (value, run length) pairs", "Sorted columns; sparse bitmaps", "Vertica, Parquet's RLE/bit-packing hybrid"],
        [`<span style="overflow-wrap:normal;word-break:normal">Delta / frame-of-reference</span>`, "Store differences from the previous value or from a base", "Timestamps, ids, sorted numbers", "ClickHouse Delta/DoubleDelta, Parquet DELTA_BINARY_PACKED"],
        [`<span style="overflow-wrap:normal;word-break:normal">Bit-packing</span>`, "Use only as many bits as the value range needs", "Small integers, e.g. dictionary codes", "Parquet, ORC"],
        [`<span style="overflow-wrap:normal;word-break:normal">General-purpose codec</span>`, "LZ4, Zstd or Snappy applied on top of the above", "Everything", "Parquet, ORC, ClickHouse"],
      ],
      note: "Ratios depend on the data: usually several times over raw, orders of magnitude only for sorted low-cardinality columns.",
    },
    {
      title: "Precomputing aggregates",
      type: "table",
      headers: [`<span style="overflow-wrap:normal;word-break:normal">Technique</span>`, "What is stored", "Freshness", "Flexibility"],
      rows: [
        [`<span style="overflow-wrap:normal;word-break:normal">Virtual view</span>`, "Only the query text, expanded at read time", "Always current", "Any query, but no speed-up"],
        [`<span style="overflow-wrap:normal;word-break:normal">Materialized view</span>`, "The query's result on disk", "Refreshed (PostgreSQL REFRESH) or maintained incrementally", "Only that query's shape"],
        [`<span style="overflow-wrap:normal;word-break:normal">Data cube</span>`, "Aggregates for every combination of chosen dimensions (2^d group-bys)", "Rebuilt or incrementally updated", "Only those dimensions and decomposable aggregates"],
        [`<span style="overflow-wrap:normal;word-break:normal">Ingest-time rollup</span>`, "Pre-aggregated rows by truncated time + dimensions", "Real time", "Raw detail is gone (e.g. Druid rollup)"],
      ],
      note: "Rolls up: SUM, COUNT, MIN, MAX (AVG = SUM / COUNT). Doesn't: median, percentiles, exact COUNT DISTINCT; use sketches (HyperLogLog, t-digest).",
    },
    {
      title: "Choosing a storage engine",
      type: "list",
      items: [
        "<strong>Transactional OLTP, mostly point reads and short ranges, predictable p99</strong> → B-tree (PostgreSQL, InnoDB).",
        "<strong>Sustained heavy writes, large datasets, compression or SSD endurance matters</strong> → LSM (RocksDB, Cassandra, ScyllaDB). Leveled for read-heavy or space-sensitive data, tiered for write-heavy, time-window for TTL'd time series.",
        "<strong>Large values (KB and up) in an LSM</strong> → key-value separation (RocksDB BlobDB, TiKV Titan, Badger).",
        "<strong>Exact-key lookups, keys fit in RAM</strong> → hash log (Bitcask) or an in-memory store (Redis).",
        "<strong>Analytics: many rows, few columns</strong> → column store (warehouse, ClickHouse, DuckDB, Parquet on object storage).",
        "<strong>Analytics on fresh operational data</strong> → CDC into a warehouse, or HTAP (TiDB + TiFlash, SQL Server columnstore).",
        "Always benchmark with your own data, value sizes, cache sizes and concurrency.",
      ],
    },
    {
      title: "Numbers to remember",
      type: "list",
      items: [
        "HDD random write = seek + rotation, several ms (~100–200/s per disk); sequential 100+ MB/s.",
        "Scanning a 50 GB log at ~500 MB/s ≈ 100 s per read: why logs need indexes.",
        "Page sizes: 4 KB (SQLite default, the traditional size), 8 KB (PostgreSQL, SQL Server), 16 KB (InnoDB default).",
        "B-tree branching factor in the hundreds, depth 3–4; 4 levels × b = 500 × 4 KB pages = 256 TB.",
        "B-tree pages ≈ 69% full on average under random inserts; InnoDB ≈ 15/16 for sequential inserts, 1/2 to 15/16 for random; PostgreSQL B-tree fillfactor 90%.",
        "Bloom filter ≈ 9.6 bits/key and k ≈ 7 for 1%; 1 billion keys ≈ 1.2 GB.",
        "Leveled compaction ≈ 10x size per level; 10–30x total write amplification commonly reported.",
        "RocksDB defaults: 64 MB memtable; L0 compaction at 4 files, slowdown at 20, stop at 36.",
        "Cassandra: <code>gc_grace_seconds</code> = 864,000 (10 days); tombstone warn at 1,000 and abort at 100,000 per query; commit log fsync every 10 s in the default periodic mode.",
        "Elasticsearch refresh every 1 s by default (near real-time search).",
        "Redis AOF with <code>appendfsync everysec</code> (the default): up to ~1 s of writes lost in a crash.",
        "ClickHouse sparse index: one entry per 8,192-row granule.",
        "Columnar I/O: 3 of 100 columns ≈ 33x less data read.",
      ],
    },
    {
      title: "Myths to unlearn",
      type: "list",
      items: [
        "<strong>LSM-trees always write less than B-trees</strong>: leveled compaction can rewrite data 10–30 times; it depends on the workload.",
        "<strong>B-trees can't compress</strong>: InnoDB has page compression, and WiredTiger compresses blocks (snappy by default) and index keys (prefix compression). LSMs just compress better.",
        "<strong>Bloom filters speed up range scans</strong>: they only help point lookups.",
        "<strong>Bloom filters can give false negatives</strong>: never; only false positives.",
        "<strong>DELETE frees space immediately</strong>: in an LSM it writes a tombstone that lives until compaction (and gc_grace).",
        "<strong>Cassandra and HBase are column-oriented</strong>: their column families are stored row by row.",
        "<strong>In-memory databases are fast because RAM is faster than disk</strong>: mostly they skip disk-format encoding and buffer management.",
        "<strong>In-memory means not durable</strong>: logs, snapshots and replication make them durable.",
        "<strong>PostgreSQL updates rows in place</strong>: its MVCC writes a new row version for every UPDATE (HOT updates avoid touching indexes).",
        "<strong>InnoDB secondary indexes point to row locations</strong>: they store the primary key.",
        "<strong>MongoDB uses an LSM engine</strong>: its WiredTiger engine stores collections and indexes as B-trees.",
        "<strong>A data cube can replace the raw data</strong>: it can't answer questions about non-dimension attributes.",
      ],
    },
  ],

  // ------------------------------------------------------------------
  // INTERVIEW (grouped by section order)
  // ------------------------------------------------------------------
  interview: [
    // --- log-and-hash-index ---
    {
      id: "q-why-not-index-everything",
      q: "If indexes make reads faster, why not index every column?",
      diff: "easy",
      section: "log-and-hash-index",
      a: `<p>Because <strong>an index is derived data that writes must maintain</strong>. It speeds up the reads that use it and taxes every write that touches its columns.</p>
<ul>
<li><strong>Write cost</strong>: every insert and delete updates every index, and so does every update that changes an indexed column. In PostgreSQL it's worse: any update that can't be HOT (heap-only tuple) writes the new row version to a new location, so it adds an entry to <em>every</em> index on the table. Each index change also goes through the WAL.</li>
<li><strong>Resources</strong>: more disk, and more buffer-pool memory competing with hot table pages; contention on hot index pages; bigger backups and more replication traffic; more plans for the optimizer to weigh.</li>
<li><strong>Many indexes don't even help</strong>: on a low-selectivity column (a boolean, a three-value status), reading a large share of the table through an index costs a random read per row, which is slower than a sequential scan, so the planner ignores the index. (In a column store, by contrast, low-cardinality columns are exactly what bitmap encoding handles best.)</li>
</ul>
<p><strong>What to do instead</strong>: index for real query patterns. Find the slow queries (slow-query log, <code>pg_stat_statements</code>) and read their <code>EXPLAIN</code> plans. Build composite indexes that match WHERE + ORDER BY, add covering columns (INCLUDE) for the hottest queries, and periodically drop unused indexes, e.g. <code>idx_scan = 0</code> in PostgreSQL's <code>pg_stat_user_indexes</code>. Check replicas before dropping, since usage statistics are per server, and keep indexes that enforce uniqueness even if they are never scanned.</p>`,
      followups: [
        "When will the planner ignore an index you created?",
        "How would you find and safely remove unused indexes?",
      ],
      pitfalls: [
        "'Indexes only cost disk space'",
        "Forgetting that updates and deletes, not just inserts, pay for every index",
      ],
    },
    {
      id: "q-hash-vs-btree-index",
      q: "When would you use a hash index instead of a B-tree?",
      diff: "easy",
      section: "log-and-hash-index",
      a: `<p>A <strong>hash index</strong> finds an exact key in O(1) expected time but throws away ordering. A <strong>B-tree</strong> keeps keys sorted and costs O(log n) page reads, which in practice is 1–2 disk reads because the upper levels are cached. So the asymptotic difference rarely matters; ordering does.</p>
<ul>
<li><strong>What a hash index can't do</strong>: range queries (<code>created_at &gt; ?</code>), ORDER BY, prefix matches (<code>LIKE 'abc%'</code>), MIN/MAX. Hashing scatters neighboring keys, so a range becomes one lookup per possible key. Growing an on-disk hash table means rehashing, and Bitcask-style designs need every key in RAM.</li>
<li><strong>What a B-tree gives you</strong>: one structure that serves equality, ranges, prefixes and sorting with predictable latency, which is why it is the default index almost everywhere.</li>
</ul>
<p><strong>When hash wins</strong>: pure key-value access with keys that fit in memory (Bitcask, Redis's main dictionary, MySQL's MEMORY engine), and inside query execution, where a hash join builds a temporary in-memory hash table. PostgreSQL hash indexes have been crash-safe since version 10 (2017). Because they store only a 4-byte hash code, they can be smaller than a B-tree for long keys such as URLs, but they serve equality only.</p>
<p>To keep the log's cheap writes <em>and</em> get ordering, sort the segments: that is the SSTable and LSM-tree idea.</p>`,
      followups: [
        "Why can't a hash index answer WHERE created_at > ?",
        "What does an SSTable give you that a Bitcask segment doesn't?",
      ],
      pitfalls: [
        "Assuming O(1) beats O(log n) in practice; the real cost is disk reads, and both are about one",
        "Forgetting that a hash index can't serve ORDER BY or ranges",
      ],
    },

    {
      id: "q-design-log-kv",
      q: "Design a durable key-value store for video view counters: tens of thousands of increments per second, a few million distinct keys, reads by key only. Start simple.",
      diff: "medium",
      section: "log-and-hash-index",
      a: `<p>Start from the access pattern: <strong>a very high write rate, a key set small enough for RAM, point reads only</strong>. That is exactly the case an append-only log with an in-memory hash index (Bitcask's design) handles best.</p>
<ul>
<li><strong>Data files</strong>: every write appends a record (key, value, length prefix, CRC) to the active segment file. Nothing is ever overwritten, so writes are sequential however random the keys are.</li>
<li><strong>Index</strong>: a hash map in RAM from key to (file, offset, size) of the newest record. A read is one hash lookup plus at most one disk read, often none thanks to the page cache. An increment reads the current value through the map and appends the new one; a single writer thread serializes increments, so none are lost to races.</li>
<li><strong>Space</strong>: when the active segment reaches a size limit it is closed. A background merge rewrites closed segments keeping only each key's newest record, then switches readers to the new file and deletes the old ones. Deletes append a tombstone.</li>
<li><strong>Durability</strong>: say what an acknowledged increment survives. An fsync per write is safe but slow; group commit, or an fsync every few milliseconds, trades a small loss window for throughput, which is often acceptable for view counts.</li>
<li><strong>Restart</strong>: the map is lost on a crash. Rebuild it by scanning every segment, or much faster from <strong>hint files</strong> (each merged file's keys and offsets) written during merges. A torn final record fails its CRC and is dropped; it was never acknowledged.</li>
</ul>
<p><strong>Back of the envelope</strong>: 50,000 increments/s × ~50 bytes ≈ 2.5 MB/s of appends, trivial for sequential I/O. The live data is a few million keys × ~50 bytes, a few hundred MB, so the map fits in memory easily, and merges keep the garbage bounded.</p>
<p><strong>State the limits</strong>: every key must fit in RAM, and there are no range queries, so "top 100 videos this week" needs another structure (a sorted index or a separate aggregation job). If the key set outgrows memory or ranges matter, sort the segments: SSTables and an LSM-tree.</p>`,
      followups: [
        "How does the store restart quickly after a crash? (hint files instead of scanning every segment)",
        "What would you change to support 'top videos by views'?",
        "How do you avoid an fsync per increment, and what does that risk?",
      ],
      pitfalls: [
        "Overwriting values in place in the data file (random writes, torn records)",
        "Never saying how space is reclaimed or how the index is rebuilt after a restart",
        "Proposing an on-disk hash table without addressing its random I/O and resizing cost",
      ],
    },
    // --- sstables-and-lsm-trees ---
    {
      id: "q06",
      q: "Walk me through what happens when I insert a row into a Cassandra-style LSM database.",
      diff: "hard",
      section: "sstables-and-lsm-trees",
      a: `<p>The client sends the write to a <strong>coordinator</strong> node, which forwards it to every replica of the partition and waits for as many acknowledgments as the consistency level requires (Chapter 5). On each replica the storage engine does this:</p>
<ol>
<li><strong>Append to the commit log</strong> (Cassandra's WAL). It's a sequential append, with no page read and no in-place update.</li>
<li><strong>Insert into the memtable</strong>, a sorted in-memory structure per table (a concurrent skip list; Cassandra 5.0 added trie-based memtables), ordered by partition key and clustering columns.</li>
<li><strong>Acknowledge.</strong> Be precise about durability here. In the default <code>commitlog_sync: periodic</code> mode, the commit log is fsynced every 10 seconds and the replica acknowledges <em>before</em> that sync. A power loss on one node can therefore lose its last few seconds of writes, and durability relies on the other replicas. <code>batch</code> or <code>group</code> mode fsyncs before acknowledging, at a latency cost.</li>
<li><strong>Flush</strong>: when memtable memory crosses a threshold, or the commit log grows too large, the memtable is written sequentially as an immutable <strong>SSTable</strong>: a data file plus a partition index, a Bloom filter, compression metadata and statistics such as min/max timestamps. Commit-log segments whose data has all been flushed are recycled.</li>
<li><strong>Compaction</strong> later merges SSTables using the table's strategy (size-tiered, leveled, time-window, or unified in 5.0). It keeps the newest version of each cell and purges tombstones once they are older than <code>gc_grace_seconds</code> and no older data they shadow remains in other SSTables.</li>
</ol>
<p><strong>The read path</strong> is where Cassandra differs from a pure key-value LSM such as RocksDB. A row's cells can be spread across SSTables written at different times, so a read does <em>not</em> stop at the first SSTable that has the row. It merges cells from the memtable and from every SSTable that may contain the partition (Bloom filters and per-file metadata skip the rest), reconciles them by timestamp (last write wins per cell), and lets tombstones hide older cells. Writes are cheap because nothing is read or overwritten; reads get slower (read amplification) when compaction falls behind and a partition is spread over many files.</p>`,
      followups: [
        "What does the read path look like, and how do Bloom filters and compaction change it?",
        "What are the durability settings for the commit log?",
      ],
      pitfalls: [
        "Claiming every write is fsynced before the ack by default",
        "Saying reads stop at the first SSTable that has the key (true for RocksDB key-value lookups, not for Cassandra rows)",
        "Calling the memtable a balanced tree as if that were the only option (Cassandra, LevelDB and RocksDB use skip lists)",
      ],
    },
    {
      id: "q-search-near-real-time",
      q: "Why doesn't a document you just indexed in Elasticsearch show up in search results immediately, and why is updating a document relatively expensive?",
      diff: "medium",
      section: "sstables-and-lsm-trees",
      a: `<p>Because <strong>Lucene, the engine under Elasticsearch, is log-structured</strong>, much like an LSM-tree.</p>
<ul>
<li><strong>Visibility (refresh)</strong>: new documents are buffered in memory and become searchable only when a <em>refresh</em> writes them into a new immutable segment, every 1 second by default. That gap is why Elasticsearch calls itself "near real-time".</li>
<li><strong>Durability (flush and translog)</strong>: a refreshed segment isn't necessarily fsynced. Making segments durable is a Lucene commit, which Elasticsearch calls a <em>flush</em>. Until then the <strong>translog</strong> plays the role of a WAL; by default it is fsynced before each indexing request is acknowledged. Refresh is about visibility, flush about durability: don't conflate them.</li>
<li><strong>Updates</strong>: segments are never modified. An update marks the old document as deleted in its segment (a tombstone-like bit) and indexes the <em>whole</em> new version into a new segment, even if one field changed.</li>
<li><strong>Merges</strong>: background merges combine small segments and physically drop deleted documents, much like LSM compaction. Each segment has its own sorted term dictionary and postings lists, so a search consults every segment and merges the results; too many small segments slow searches down.</li>
</ul>
<p><strong>Practical consequences</strong>: if a test needs to see a document right away, call refresh explicitly or use <code>refresh=wait_for</code>, and don't tune the interval down globally. For a large bulk reindex, lengthen or disable the refresh interval (and often drop replicas temporarily), then let merges catch up. Avoid modeling hot counters as frequently updated documents.</p>`,
      followups: [
        "How is a Lucene index like an LSM-tree, and how is it different?",
        "What would you tune for a large bulk reindex?",
      ],
      pitfalls: [
        "Thinking documents are updated in place",
        "Confusing refresh (visibility) with flush (durability)",
      ],
    },

    // --- bloom-filters-and-compaction ---
    {
      id: "q03",
      q: "What is a Bloom filter and why do LSM-trees use them?",
      diff: "medium",
      section: "bloom-filters-and-compaction",
      a: `<p>A <strong>Bloom filter</strong> is a compact probabilistic set: an m-bit array plus k hash functions. Adding a key sets k bits; a query checks the same k bits. <strong>Any 0 means "definitely not present"; all 1s mean "maybe present"</strong>. False positives happen; false negatives never do.</p>
<p><strong>Why LSM-trees need them</strong>: a point read checks the memtable, then SSTables from newest to oldest. The worst case is a key that doesn't exist (is this username taken? have I processed this event id?), which costs a disk read in every SSTable. With one filter per SSTable in memory, the engine skips almost every file that can't contain the key, so a lookup costs about one disk read.</p>
<ul>
<li><strong>Sizing</strong>: about 10 bits per key with k ≈ 7 gives roughly 1% false positives (exactly 1% needs ≈ 9.6 bits per key). 1 billion keys at 1% is about 1.2 GB of RAM.</li>
<li><strong>A false positive</strong> costs one wasted read, never a wrong answer.</li>
<li><strong>No deletions</strong>: clearing a bit could clear another key's bit and create a false negative. LSM engines don't need deletes: SSTables are immutable, and compaction builds a fresh filter for each new file.</li>
<li><strong>Tombstoned keys are added to the filter</strong> like live keys. Otherwise a read would skip the file holding the tombstone and return an older, deleted value from a lower level.</li>
<li><strong>Range scans get nothing</strong>: a scan must merge every overlapping sorted run (memtable, L0 files, one file per level). Only per-file min/max keys, or prefix filters when the range shares a key prefix, can rule files out.</li>
</ul>`,
      followups: [
        "Size a filter for 1B keys at 1%",
        "Why can't you delete from it?",
      ],
      pitfalls: [
        "Claiming false negatives are possible",
        "Saying Bloom filters speed up range scans",
        "Forgetting that tombstones must be in the filter",
      ],
    },
    {
      id: "q-bloom-sizing",
      q: "Size a Bloom filter for 1 billion keys with a 1% false-positive rate. How much memory, and how many hash functions? What happens if you only have half that memory?",
      diff: "medium",
      section: "bloom-filters-and-compaction",
      a: `<p>Use the standard formulas, with n keys, m bits, k hash functions and target false-positive rate p:</p>
<ul>
<li><strong>Bits per key</strong>: m/n = −ln p / (ln 2)² = 4.61 / 0.48 ≈ <strong>9.6</strong> for p = 1%.</li>
<li><strong>Memory</strong>: 9.6 bits × 10⁹ keys ≈ 9.6 Gbit ≈ <strong>1.2 GB</strong>.</li>
<li><strong>Hash functions</strong>: optimal k = (m/n) · ln 2 ≈ 9.6 × 0.69 ≈ 6.6, so <strong>7</strong>. In practice engines derive the k probe positions from one or two hash values (double hashing) instead of computing seven independent hashes.</li>
</ul>
<p><strong>With half the memory</strong> (≈ 4.8 bits per key), plug into p ≈ (1 − e^(−kn/m))^k:</p>
<ul>
<li>Re-tune k to ≈ 3: about <strong>10%</strong>. A handy rule: every ~4.8 bits per key buys a 10x lower rate, so halving the budget costs 10x.</li>
<li>Keep k = 7: about <strong>16%</strong>, worse, because more hash functions fill a smaller array faster.</li>
</ul>
<p><strong>What it means in an LSM engine</strong>: a false positive costs one wasted disk read, and false negatives never happen, so even a 10% filter saves 90% of the disk reads for missing keys. There is one filter per SSTable, rebuilt whenever compaction writes a new file, and filters only help while they're in RAM (RocksDB can keep or pin them in its block cache). When memory is tight, spend fewer bits on the bottom level, which holds most of the keys and is the last place a lookup checks. RocksDB's <code>optimize_filters_for_hits</code> drops bottom-level filters entirely for workloads where most looked-up keys exist.</p>`,
      followups: [
        "Why can't you delete keys from a standard Bloom filter?",
        "Why does an LSM engine keep one filter per SSTable instead of one global filter?",
        "When is a Bloom filter useless? (range scans; workloads where nearly every key exists)",
      ],
      pitfalls: [
        "Saying Bloom filters can give false negatives",
        "Forgetting the filter must fit in memory",
        "Using k = 1 'for speed' without noticing the much higher false-positive rate",
      ],
    },
    {
      id: "q-tombstones",
      q: "Users delete lots of data from your Cassandra- or RocksDB-backed service, but disk usage doesn't drop and some reads get slower. Explain what's happening and how you'd fix it.",
      diff: "medium",
      section: "bloom-filters-and-compaction",
      a: `<p><strong>A delete in an LSM-tree is a write.</strong> It appends a tombstone; nothing is erased.</p>
<ul>
<li><strong>Why disk doesn't drop</strong>: the old values and the tombstone both stay on disk until compaction merges the files that hold them. Even then, the tombstone can be dropped only once no older copy of the key can exist below it: at the bottom level, or once every overlapping file has been merged. In Cassandra it must also be older than <code>gc_grace_seconds</code> (10 days by default), so that a replica that missed the delete can't resurrect the data during repair. Note that compaction itself needs temporary free space.</li>
<li><strong>Why reads get slower</strong>: reads must step over tombstones. That's worst for range scans over heavily deleted ranges and for queue-like patterns (insert, read the oldest, delete), where every scan starts by wading through dead entries. Cassandra logs a warning at 1,000 tombstones per query and aborts at 100,000. Discord (2017) hit this with a channel whose messages were nearly all deleted: reads scanned millions of tombstones and caused long GC pauses.</li>
</ul>
<p><strong>Fixes</strong>, roughly in order of preference:</p>
<ul>
<li><strong>Model the data so you don't scan deleted ranges</strong>: time-bucketed partitions, and queries that start after the known-deleted region.</li>
<li><strong>Use TTLs with time-window compaction</strong>, so whole expired files are dropped without rewriting anything.</li>
<li><strong>Prefer range or partition deletes</strong> over millions of single-row tombstones (RocksDB's <code>DeleteRange</code> writes one range tombstone).</li>
<li><strong>Tune carefully</strong>: shorten <code>gc_grace_seconds</code> only if repairs reliably finish within it; trigger compaction on the affected tables or ranges when needed, watching disk headroom and I/O impact.</li>
<li><strong>Monitor</strong> tombstones per read, droppable-tombstone ratios and pending compaction bytes.</li>
</ul>`,
      followups: [
        "Why can't Cassandra drop a tombstone right after compaction? (a replica that missed the delete would resurrect the data; Chapter 5)",
        "How does time-window compaction make expiring data cheap?",
      ],
      pitfalls: [
        "Assuming DELETE frees space immediately",
        "Lowering gc_grace_seconds without making repairs more frequent",
      ],
    },

    {
      id: "q-compaction-strategy",
      q: "Size-tiered or leveled compaction: how would you choose for a given table in Cassandra or RocksDB?",
      diff: "medium",
      section: "bloom-filters-and-compaction",
      a: `<p>Frame it as <strong>which amplification the table can afford</strong>, then match it to the workload.</p>
<ul>
<li><strong>Size-tiered</strong> (Cassandra STCS, RocksDB universal): merge several similar-sized SSTables into one bigger file. Each byte is rewritten only a few times (low write amplification), but a key can sit in several overlapping files, so reads check more files and obsolete versions linger (higher space amplification). A big merge needs temporary free space about the size of its inputs, so in the worst case plan for about as much free disk as data.</li>
<li><strong>Leveled</strong> (LevelDB and RocksDB default, Cassandra LCS): each level below L0 is one sorted run of small non-overlapping files, about 10x larger than the level above. A point read checks at most one file per level and space amplification stays near 1.1x, but each byte is rewritten roughly once per level, along with up to ~10x as much overlapping data, so 10–30x total write amplification is commonly reported.</li>
<li><strong>Time-window</strong> (Cassandra TWCS): group files by time window and leave closed windows alone, so TTL-expired data is dropped as whole files. Ideal for append-only time series; bad when writes arrive out of order or old rows are updated.</li>
</ul>
<p><strong>Choosing</strong>: insert-heavy data that is rarely read or updated (logs, events) → size-tiered. Read-heavy or update-heavy tables with latency targets, or a tight disk budget → leveled, provided the disks have write bandwidth to spare. Time series with a retention TTL → time-window. Cassandra 5.0's Unified Compaction Strategy can be tuned anywhere between tiered and leveled, which turns the choice into a dial rather than a commitment.</p>
<p><strong>Verify in production</strong>: watch SSTables per read (Cassandra's <code>nodetool tablehistograms</code>), pending compaction bytes, write stalls in RocksDB, disk headroom and p99 latency, and benchmark long enough for compaction to reach steady state.</p>`,
      followups: [
        "Why does a size-tiered table need so much free disk?",
        "Why does time-window compaction break down with out-of-order writes?",
        "What happens if leveled compaction can't keep up with the write rate?",
      ],
      pitfalls: [
        "Choosing leveled for a write-heavy ingest table and then fighting compaction debt",
        "Running size-tiered compaction on a nearly full disk",
        "Answering without naming the read, write and space costs of each",
      ],
    },
    // --- b-trees ---
    {
      id: "q-why-btree-not-bst",
      q: "Why do databases index with B-trees rather than binary search trees, and how many disk reads does a lookup in a billion-row table take?",
      diff: "easy",
      section: "b-trees",
      a: `<p>On disk, what a lookup costs is <strong>the number of pages it reads</strong>, not the number of comparisons. Both trees are O(log n); the base of the logarithm is what matters.</p>
<ul>
<li><strong>Binary search tree</strong>: each node holds one key and two children, so a billion keys need about log₂(10⁹) ≈ 30 levels. Each level is a separate random read: about 30 × 10 ms ≈ 0.3 seconds per lookup on a spinning disk, and each read fetches a whole page to use a few bytes of it.</li>
<li><strong>B-tree</strong>: each node is a page holding hundreds of keys. With a branching factor of 500, three levels address 125 million pages and four address 62.5 billion, so a billion rows need about <strong>4 levels</strong>.</li>
<li><strong>Caching does the rest</strong>: with 500 rows per leaf, a billion rows fill 2 million leaves, but everything above them (1 + 8 + 4,000 pages, about 16 MB with 4 KB pages) stays in the buffer pool. A lookup typically costs <strong>1–2 actual disk reads</strong>: the leaf, and perhaps its parent.</li>
</ul>
<p>The structure also keeps itself balanced: pages split when full and the tree only grows at the root, so every leaf stays at the same depth, and leaves linked to their neighbors make range scans cheap. Binary structures are still fine in memory, where there is no per-node I/O: LSM memtables use skip lists or balanced trees.</p>`,
      followups: [
        "What happens to the depth when the table grows 1000×? (about one more level)",
        "Why is a skip list a reasonable choice for an LSM memtable?",
      ],
      pitfalls: [
        "Quoting O(log n) without the base, which is the whole point",
        "Forgetting that the upper levels are cached, so most lookups need only 1–2 disk reads",
      ],
    },
    {
      id: "q-btree-vs-bplustree",
      q: "What's the difference between a B-tree and a B+tree, and why do databases use B+trees?",
      diff: "easy",
      section: "b-trees",
      a: `<p>Both are balanced trees of fixed-size pages with hundreds of children per page. Neither is a binary tree. The difference is <strong>where the values live</strong>.</p>
<ul>
<li><strong>Classic B-tree</strong>: internal pages hold keys <em>together with</em> their values (or row pointers), so some lookups finish at an internal page.</li>
<li><strong>B+tree</strong>: internal pages hold only <strong>separator keys and child pointers</strong>, all values live in the leaves, and <strong>leaves are linked</strong> to their siblings.</li>
</ul>
<p><strong>Why databases prefer B+trees</strong>:</p>
<ul>
<li>More separators fit per page, so the branching factor is higher and the tree shallower.</li>
<li>Every lookup goes to the same depth, so cost is predictable.</li>
<li>Range scans descend once, then walk the leaf chain sideways without climbing back up.</li>
<li>Separators only route searches, so they can be shortened (key abbreviation, suffix truncation), raising the fan-out further.</li>
</ul>
<p>Nearly every database "B-tree" is a B+tree variant: InnoDB, PostgreSQL's nbtree (a Lehman–Yao B-link tree), SQL Server and SQLite's table trees. SQLite's index trees are plain B-trees. When a B+tree leaf splits, the right leaf's first key is <em>copied</em> into the parent; when an internal page splits, its middle key <em>moves</em> up.</p>`,
      followups: [
        "Why does a higher branching factor matter so much on disk?",
        "How does a range scan work in a B+tree?",
      ],
      pitfalls: [
        "Describing either as a binary tree",
        "Saying B+trees store values in internal nodes",
      ],
    },
    {
      id: "q-uuid-primary-key",
      q: "Why can random UUIDv4 primary keys hurt insert throughput in MySQL InnoDB, and what would you change?",
      diff: "medium",
      section: "b-trees",
      a: `<p>InnoDB stores each table as a <strong>B+tree clustered on the primary key</strong>, so the primary key decides where every row physically goes.</p>
<ul>
<li><strong>Locality</strong>: random keys land in random leaf pages, so the write working set becomes the whole index. Once it no longer fits in the buffer pool, inserts need random reads before they can write, and dirty pages are spread everywhere.</li>
<li><strong>Splits and fill</strong>: page splits happen all over the tree and leave pages between 1/2 and 15/16 full, so the index is bigger and more fragmented. Sequential keys always append at the right edge, keep one hot page in cache and leave pages about 15/16 full.</li>
<li><strong>Secondary indexes</strong>: every InnoDB secondary index stores the primary key, so a 16-byte UUID, or worse a 36-character string, makes all of them bigger.</li>
</ul>
<p><strong>What to change</strong>:</p>
<ul>
<li>Use a <code>BIGINT AUTO_INCREMENT</code> primary key and keep the UUID as a secondary unique column for external use, or</li>
<li>use <strong>time-ordered ids</strong>: UUIDv7 (RFC 9562), ULID or Snowflake-style ids, which insert near the right edge like auto-increment keys;</li>
<li>store UUIDs as <code>BINARY(16)</code>, not <code>CHAR(36)</code> (MySQL 8.0's <code>UUID_TO_BIN(uuid, 1)</code> also reorders the time fields of a v1 UUID).</li>
</ul>
<p>PostgreSQL's table is a heap, not clustered, so the table itself doesn't suffer, but a B-tree index on a random UUID still does. Touching many distinct pages after each checkpoint also inflates its WAL through full-page images.</p>`,
      followups: [
        "Does an LSM engine suffer the same way? (much less: writes are buffered and sorted in the memtable; the cost shifts to compaction)",
        "What's the downside of monotonically increasing keys in a range-partitioned distributed database? (a hot spot on the last partition, Chapter 6)",
      ],
      pitfalls: [
        "Blaming slow comparisons instead of locality and page splits",
        "Ignoring the hot-spot trade-off of sequential keys in distributed stores",
      ],
    },

    // --- write-ahead-log ---
    {
      id: "q04",
      q: "Why do B-trees need a write-ahead log?",
      diff: "medium",
      section: "write-ahead-log",
      a: `<p>Because a B-tree <strong>overwrites pages in place, and one logical change can touch several pages</strong>. A split rewrites the old leaf, creates a new leaf and updates the parent, and the disk writes those pages one at a time, in whatever order the buffer manager and OS choose. A crash in between leaves the tree inconsistent: a parent pointing at a leaf that lost half its keys, or an orphan page nobody points to. The keys lost this way can be long-committed data, not just the insert in flight. Even a single page write can be <strong>torn</strong>, because an 8–16 KB page is larger than what the hardware writes atomically.</p>
<p><strong>The WAL protocol</strong>:</p>
<ul>
<li><strong>Log before data</strong>: every modification is appended to the log before the page it changes may reach disk.</li>
<li><strong>Commit after log</strong>: a transaction is acknowledged only once its log records are durable (fsynced). Group commit shares one fsync among many transactions.</li>
<li>Dirty pages are flushed lazily, in any order. On restart the database <strong>redoes</strong> the log from the last checkpoint. Each page stores the <strong>LSN</strong> of the last change applied to it, so redo skips changes a page already has. That makes redo idempotent, so a crash during recovery is fine.</li>
<li><strong>Checkpoints</strong> bound how much log must be replayed and let old log be recycled.</li>
<li><strong>Torn pages</strong> need an intact copy: PostgreSQL logs a full page image on the first change after each checkpoint (<code>full_page_writes</code>); InnoDB writes pages through a doublewrite buffer. Checksums detect damage.</li>
</ul>
<p>Separately, <strong>latches</strong> (short-term locks on in-memory pages) keep concurrent threads from seeing half-modified pages; the WAL handles crashes, not concurrency. The alternative design is a <strong>copy-on-write B-tree</strong> (LMDB): never overwrite a page, write new copies up to the root, and atomically swap the root pointer, so no redo log is needed.</p>`,
      followups: [
        "What is a checkpoint for?",
        "How does LMDB avoid a WAL?",
      ],
      pitfalls: [
        "'fsync every page' as a substitute for the WAL (it doesn't make several pages atomic)",
        "Reducing the rule to 'write a log' without 'log before data' and 'commit after log'",
      ],
    },
    {
      id: "q-crash-recovery",
      q: "Power fails while a B-tree database is halfway through flushing dirty pages. Walk through how it comes back consistent.",
      diff: "hard",
      section: "write-ahead-log",
      a: `<p><strong>Before the crash</strong>, the WAL rule held: every change was logged before any page changed on disk, and each commit was acknowledged only after its log records were fsynced. Dirty pages were flushed lazily, in any order, so at the moment of the crash the data files are a mix: some pages are new, some old, and perhaps one is torn.</p>
<p><strong>On restart</strong>:</p>
<ol>
<li><strong>Start from the last checkpoint.</strong> The checkpoint record says from which log position redo must begin; everything earlier is known to be on disk.</li>
<li><strong>Repair torn pages.</strong> A torn page can't take a delta. InnoDB first restores any torn page from its intact copy in the doublewrite buffer. PostgreSQL needs no separate pass: the first WAL record for each page after the checkpoint carries a full page image, so redo overwrites the torn page before applying later records. Page checksums detect damage that slips past both.</li>
<li><strong>Redo forward.</strong> Read the log and, for each record, compare its LSN with the LSN stored in the target page. If the page's LSN is lower, apply the change; otherwise skip it. Redo is idempotent, so a crash <em>during</em> recovery just restarts it.</li>
<li><strong>Undo uncommitted work</strong>, if the engine needs to. In ARIES-style engines such as InnoDB, transactions with no commit record are rolled back using undo information (Chapter 7). PostgreSQL needs no undo pass: under MVCC, row versions from uncommitted transactions are simply invisible.</li>
</ol>
<p><strong>Trade-offs and caveats</strong>: frequent checkpoints mean short recovery but more page writes (and, in PostgreSQL, more full-page images in the WAL). All of this assumes fsync really means "on stable storage". In 2018 ("fsyncgate"), PostgreSQL developers found that on Linux a failed fsync could drop dirty pages and clear the error, so a retry falsely succeeded; PostgreSQL now panics and recovers from the WAL instead. The alternative is a <strong>copy-on-write B-tree</strong> (LMDB): the old root is always consistent, so recovery is just "use the last committed root".</p>`,
      followups: [
        "Why is redo idempotent?",
        "What does a checkpoint buy you, and what does it cost?",
        "How does an LSM engine recover its memtable?",
      ],
      pitfalls: [
        "Claiming that fsyncing each page solves it (it doesn't make multiple pages atomic)",
        "Forgetting torn pages",
        "Confusing the WAL with application logs or with the replication log format",
      ],
    },

    // --- lsm-vs-btree ---
    {
      id: "q01",
      q: "Explain LSM-trees vs B-trees and when you'd pick each.",
      diff: "hard",
      section: "lsm-vs-btree",
      a: `<p>Rather than "LSM for writes, B-tree for reads", frame it as <strong>which amplification you pay</strong>: write, read or space.</p>
<ul>
<li><strong>B-tree</strong> (InnoDB, PostgreSQL, SQL Server, WiredTiger): fixed-size pages (4–16 KB) updated in place, protected by a WAL.
<ul>
<li><em>Write amp</em>: every change is written at least twice (WAL + page), a whole page is rewritten even if a few bytes changed, and splits and doublewrite add more.</li>
<li><em>Read amp</em>: one root-to-leaf path, usually 1–2 disk reads because upper levels are cached.</li>
<li><em>Space amp</em>: fragmentation, with pages roughly 50–94% full after splits.</li>
</ul></li>
<li><strong>LSM-tree</strong> (RocksDB, Cassandra, HBase, ScyllaDB): WAL + memtable, flushed as immutable SSTables and merged by compaction.
<ul>
<li><em>Write amp</em>: compaction rewrites data. Leveled can cost up to about the size ratio (~10) per level in the worst case, with 10–30x total commonly reported; size-tiered rewrites less.</li>
<li><em>Read amp</em>: memtable plus several files. Bloom filters bring point lookups down to about one read, but range scans must merge every overlapping run.</li>
<li><em>Space amp</em>: <strong>depends on the strategy</strong>, about 1.1x leveled, often 2x+ size-tiered at worst. No half-empty pages, so it compresses better.</li>
</ul></li>
</ul>
<p><strong>Operational differences</strong>:</p>
<ul>
<li><strong>Shared bandwidth</strong>: the WAL, flushes and compaction all compete for the same disk write bandwidth, and compaction needs more of it as the database grows. If it falls behind, files pile up (compaction debt), reads touch more files, space grows, and RocksDB eventually stalls writes. That shows up in p99 latency. A B-tree pays its costs inline, so its latency is smoother.</li>
<li><strong>One copy per key</strong>: in a B-tree each key lives in exactly one place, which makes index-range locks for serializable isolation straightforward (Chapter 7).</li>
<li>Both can compress (InnoDB page compression, WiredTiger block compression); LSMs just do it better.</li>
</ul>
<p><strong>When to pick which</strong>: an LSM for write-heavy ingest, very large datasets where compression saves real money, or SSD endurance concerns. Facebook moved its main MySQL user database from compressed InnoDB to MyRocks and reported roughly half the storage. A B-tree for read-heavy OLTP, predictable latency, range-heavy transactional work and mature tooling (PostgreSQL, MySQL). Then <strong>benchmark your own workload</strong>: published benchmarks disagree because value sizes, cache sizes and settings differ.</p>`,
      followups: [
        "How would you cut LSM write amplification for large values? (key-value separation: WiscKey/BlobDB)",
        "Why can a B-tree still be fine on SSDs?",
        "What do you monitor in production for each?",
      ],
      pitfalls: [
        "'LSM is always faster for writes' (compaction can dominate)",
        "'B-trees can't compress' (InnoDB and WiredTiger support compression; LSMs just compress better)",
        "Calling LSM space amplification good without naming the compaction strategy",
      ],
    },
    {
      id: "q-design-write-heavy-store",
      q: "Design the storage engine for a service that ingests 200,000 small writes per second (sensor readings) and serves point lookups and short time-range scans per device. What structure would you choose, and what would you monitor?",
      diff: "hard",
      section: "lsm-vs-btree",
      a: `<p><strong>Choose an LSM-tree.</strong> Each write becomes a WAL append plus a memtable insert, flushed later as a sorted SSTable, so 200k random-key writes per second turn into sequential I/O.</p>
<ul>
<li><strong>Key design</strong>: <code>(device_id, timestamp)</code>, so one device's readings are contiguous on disk and a time-range scan is one sequential range. Partition across nodes by device (in Cassandra: partition key <code>(device_id, day)</code>, clustering key <code>timestamp</code>) and replicate (Chapters 5–6).</li>
<li><strong>Durability</strong>: WAL with group commit. Decide the fsync policy explicitly: fsync before ack, or ack after a periodic sync and rely on replication. Say what an acknowledged write survives.</li>
<li><strong>Reads</strong>: Bloom filters make point lookups about one read. They don't help range scans, but prefix filters on <code>device_id</code> do, and per-file time ranges let a scan skip old files.</li>
<li><strong>Compaction</strong>: append-mostly data with a retention TTL fits <strong>time-window</strong> (or size-tiered) compaction. Expired files are dropped whole, with almost no rewriting. Use leveled only if there are many updates and read latency matters most.</li>
</ul>
<p><strong>Back of the envelope</strong>: 200k × ~100 B = 20 MB/s logical, about 1.7 TB per day before compression and replication. With leveled write amplification around 10, that's ~200 MB/s, about 17 TB per day of physical writes, which is why you spread it across nodes, prefer time-window compaction, and check SSD endurance (drive writes per day). Compression of repetitive sensor data claws much of it back.</p>
<p><strong>Monitor</strong>: L0 file count and pending compaction bytes (compaction debt), write stalls or slowdowns, p99 read and write latency, space amplification, tombstone counts, WAL fsync latency and disk write bandwidth headroom.</p>`,
      followups: [
        "How would the design change if each value were a 10 KB image instead of a 100-byte reading? (key-value separation: WiscKey, BlobDB, Titan)",
        "How do you delete data older than 30 days cheaply?",
        "When would you still pick PostgreSQL (a B-tree) here?",
      ],
      pitfalls: [
        "Treating LSM writes as free and ignoring compaction write amplification and compaction debt",
        "Never stating what happens to acknowledged writes on a crash (WAL / fsync policy)",
        "Claiming Bloom filters speed up range scans",
      ],
    },

    // --- other-indexes ---
    {
      id: "q05",
      q: "What are clustered vs secondary indexes?",
      diff: "easy",
      section: "other-indexes",
      a: `<p>Separate two questions that people often blur:</p>
<ul>
<li><strong>Which key?</strong> A <em>primary</em> index is on the primary key; a <em>secondary</em> index is on any other column(s), and its keys need not be unique.</li>
<li><strong>Where does the row live?</strong> In a <em>clustered</em> index the full row is stored in the index's leaves, so the table <em>is</em> that index (at most one per table). Otherwise rows live in a <em>heap file</em>, and indexes store a pointer to the row's location.</li>
</ul>
<p><strong>Two real designs</strong>:</p>
<ul>
<li><strong>MySQL InnoDB</strong>: the table is a B+tree clustered on the primary key. Secondary indexes store the <em>primary-key value</em>, not a row location, so a secondary lookup is <strong>two B-tree descents</strong>. In exchange, secondary indexes don't change when rows move or when non-indexed columns are updated.</li>
<li><strong>PostgreSQL</strong>: every table is a heap, and every index, including the primary key's, points to a tuple id (ctid), so each hit costs one extra heap read. Its MVCC writes a new row version on every UPDATE, usually at a new ctid, so every index needs a new entry unless the update is HOT (no indexed column changed and the page has room). That was the core of Uber's 2016 write-amplification complaint when it moved to MySQL.</li>
</ul>
<p><strong>Covering indexes</strong> are the middle ground: store a few extra columns in the index (<code>INCLUDE</code> in PostgreSQL 11+ and SQL Server) so hot queries are answered by an index-only scan without visiting the row.</p>`,
      followups: [
        "Why might updates touch every index in PostgreSQL but not in InnoDB?",
        "What is an index-only scan?",
      ],
      pitfalls: [
        "Calling every non-clustered index 'secondary' and every secondary index 'non-clustered' without distinguishing which key from where the row lives",
        "Saying InnoDB secondary indexes store a row id or physical pointer",
      ],
    },
    {
      id: "q-composite-index-order",
      q: "You have an index on (last_name, first_name). Which of these can use it efficiently: WHERE last_name = ?; WHERE first_name = ?; WHERE last_name = ? AND first_name LIKE 'A%'; ORDER BY last_name, first_name? How do you choose column order?",
      diff: "medium",
      section: "other-indexes",
      a: `<p>A concatenated index is sorted <strong>like a phone book</strong>: by last_name, then by first_name within each last name. Any query that maps to one contiguous range of that order is efficient.</p>
<ul>
<li><code>WHERE last_name = ?</code>: <strong>yes</strong>. One contiguous range (a range on last_name works too).</li>
<li><code>WHERE first_name = ?</code>: <strong>not efficiently</strong>. Matching entries are scattered under every last name, so the engine scans the whole index or the table. Some engines can <em>skip-scan</em> when the leading column has few distinct values (Oracle, MySQL 8.0.13+, PostgreSQL 18+), jumping from one last_name value to the next.</li>
<li><code>WHERE last_name = ? AND first_name LIKE 'A%'</code>: <strong>yes</strong>. Equality on the first column plus a range on the second is still one contiguous key range.</li>
<li><code>ORDER BY last_name, first_name</code>: <strong>yes</strong>, the index already delivers rows in that order, so there's no sort step.</li>
</ul>
<p><strong>The catch with ranges</strong>: a range on the first column stops the second column from narrowing anything. For <code>last_name &gt; 'M' AND first_name = 'Ann'</code>, the scan covers every last name after M; the engine can check first_name inside each index entry, but it can't skip.</p>
<p><strong>Choosing column order</strong>: equality columns first, then the range or sort column, matched to your most important queries. Add covering (INCLUDE) columns for hot queries. And know the limit: two independent ranges, such as latitude and longitude, can't be served by any concatenated index. That needs a space-filling curve or an R-tree.</p>`,
      followups: [
        "Why can't a (lat, lng) index answer a bounding-box query efficiently?",
        "Would two single-column indexes work as well as one composite index?",
      ],
      pitfalls: [
        "Assuming column order doesn't matter",
        "Expecting two single-column indexes to behave like one composite index (engines can combine them with bitmap AND or index merge, but it's slower)",
      ],
    },
    {
      id: "q-covering-index-slow-query",
      q: "A query filters on an indexed column but is still slow. What could be going on, and when does a covering index help?",
      diff: "medium",
      section: "other-indexes",
      a: `<p>"It uses an index" is not the same as "it's cheap". An index lookup is one descent to find the matching entries <strong>plus a fetch of the row for every match</strong>: a heap read in PostgreSQL, a second descent through the clustered index in InnoDB. A filter that matches 50,000 rows can mean 50,000 random reads.</p>
<p><strong>Common causes</strong>:</p>
<ul>
<li><strong>Low selectivity</strong>: the predicate matches a large share of the table, so the per-row fetches cost more than a sequential scan (and the planner may rightly skip the index).</li>
<li><strong>The index doesn't match the query</strong>: the leading column of a composite index isn't constrained; a function or implicit cast is applied to the column (<code>WHERE lower(email) = ?</code> needs an expression index); a leading-wildcard <code>LIKE '%abc'</code>; or an <code>ORDER BY</code> the index can't deliver, forcing a big sort.</li>
<li><strong>Bad estimates</strong>: stale statistics steer the planner to the wrong plan.</li>
</ul>
<p><strong>Covering index</strong>: if the index contains every column the query needs, as key columns or as included columns (<code>INCLUDE</code> in PostgreSQL 11+ and SQL Server), the engine answers from the index alone and never touches the rows: an <strong>index-only scan</strong>. In InnoDB every secondary index already carries the primary key, so a query that needs only the indexed columns plus the key is covered automatically. One PostgreSQL caveat: an index-only scan still visits the heap for pages its visibility map doesn't mark all-visible, so it pays off best on tables that are vacuumed regularly.</p>
<p><strong>How to check</strong>: run <code>EXPLAIN (ANALYZE, BUFFERS)</code>, compare estimated and actual row counts, and look for Index Only Scan vs Index Scan and the heap-fetch count. <strong>The cost</strong>: a bigger index and more work on every write, so cover only the hottest queries.</p>`,
      followups: [
        "Why might PostgreSQL still read the heap during an index-only scan? (the visibility map)",
        "Which columns does every InnoDB secondary index already cover?",
      ],
      pitfalls: [
        "Assuming any query that uses an index is fast",
        "Adding more single-column indexes instead of one index that matches the query",
      ],
    },
    {
      id: "q-geo-proximity",
      q: "Design the index behind 'find restaurants within 2 km of me' for 10 million restaurants.",
      diff: "medium",
      section: "other-indexes",
      a: `<p><strong>The problem</strong>: two independent range conditions defeat one sorted index. A B-tree on <code>(lat, lng)</code> narrows only latitude and returns a band around the whole planet that you then filter.</p>
<p><strong>Option 1: a space-filling curve over an ordinary index.</strong></p>
<ul>
<li>Encode each point as a geohash (Z-order) or an S2 or H3 cell id, and index that 1-D key in a normal B-tree or LSM. Nearby points mostly share a prefix.</li>
<li>Query the cells that cover the circle, then filter candidates by exact distance. Points just across a cell boundary can have very different codes, so <strong>always include neighboring cells</strong>.</li>
<li>Pick the precision so cells are at least as large as the radius and the user's cell plus its 8 neighbors cover the circle: for 2 km, 5-character geohash cells (about 4.9 km × 4.9 km at the equator). A 6-character cell (about 1.2 km × 0.6 km) needs a bigger block of cells. Alternatively, compute a cell covering of the circle (S2's region coverer) and run one range scan per cell.</li>
</ul>
<p><strong>Option 2: a spatial index</strong> such as an R-tree, e.g. PostGIS on PostgreSQL's GiST, which answers bounding-box and nearest-neighbor (<code>ORDER BY location &lt;-&gt; point</code>) queries directly.</p>
<p><strong>Things to discuss</strong>:</p>
<ul>
<li><strong>Density skew</strong>: Manhattan vs countryside. Adaptive cells (quadtrees, multiple S2 levels) or a variable search radius keep the candidate count bounded.</li>
<li><strong>Moving objects</strong> (drivers updating every few seconds): an in-memory cell index such as Redis GEO, which stores geohash scores in a sorted set, absorbs the update rate.</li>
<li><strong>Scale</strong>: 10 million mostly static points (a few hundred bytes each) fit comfortably in one machine's memory; shard by region (Chapter 6) only when the write rate or query rate demands it.</li>
</ul>`,
      followups: [
        "Why must you search neighboring cells, not just the user's cell?",
        "How would you handle drivers whose location changes every few seconds?",
      ],
      pitfalls: [
        "Indexing latitude and longitude separately and intersecting two huge result sets",
        "Ignoring the cell-boundary problem",
      ],
    },
    {
      id: "q-in-memory-why-fast",
      q: "Why is an in-memory database such as Redis or VoltDB fast, and how can it still be durable?",
      diff: "medium",
      section: "other-indexes",
      a: `<p>"RAM is faster than disk" is only part of the answer. A disk-based engine with enough memory also serves hot data from its buffer pool or the OS page cache, without disk reads.</p>
<p><strong>Where the speed really comes from</strong>:</p>
<ul>
<li><strong>No disk-format encoding</strong>: data structures stay as in-memory structures; there are no page layouts or serialization into pages.</li>
<li><strong>No buffer-pool machinery</strong>: no page lookups, pinning, eviction or page latches.</li>
<li><strong>Little or no locking</strong>: single-threaded command execution (Redis) or serial execution per partition (VoltDB) avoids most concurrency control.</li>
<li><strong>Richer data structures</strong>: sorted sets, priority queues and HyperLogLogs are easy in memory and awkward on disk.</li>
</ul>
<p><strong>How it stays durable</strong>:</p>
<ul>
<li>An <strong>append-only log</strong> of operations: Redis AOF with <code>appendfsync always</code> (safest, slowest), <code>everysec</code> (the default, can lose about a second of writes) or <code>no</code> (leave it to the OS).</li>
<li><strong>Periodic snapshots</strong> (Redis RDB) to bound log replay.</li>
<li><strong>Replication</strong> to other nodes, and in some systems battery-backed RAM.</li>
</ul>
<p>Restarts reload from a snapshot plus the log, or from a replica, so <strong>recovery time grows with the dataset</strong>. Anti-caching extends the model past RAM by evicting cold records to disk and loading them back on access. Memcached, by contrast, is a pure cache: losing everything on restart is acceptable.</p>`,
      followups: [
        "What do you trade off between Redis's appendfsync settings?",
        "Why can a disk-based database with a huge buffer pool still be slower?",
      ],
      pitfalls: [
        "Claiming in-memory databases can't be durable",
        "Attributing all of the speed-up to avoiding disk reads",
      ],
    },

    // --- oltp-vs-olap ---
    {
      id: "q07",
      q: "What's a star schema and why is it used in warehouses?",
      diff: "easy",
      section: "oltp-vs-olap",
      a: `<p>A <strong>star schema</strong> puts one large <strong>fact table</strong> in the middle, with one row per business event (an order line, a page view, a click) at the finest useful granularity. Its columns are measures (quantity, net price, cost) plus foreign keys to small <strong>dimension tables</strong> that describe the event's who, what, where, when, how and why: customer, product, store, promotion, date. Drawn out, the dimensions surround the fact table like the points of a star.</p>
<p><strong>Why warehouses use it</strong>:</p>
<ul>
<li>Analytic queries share one shape: filter and group by dimension attributes, aggregate fact columns. That means one big table, a few small joins, and predictable SQL that BI tools can generate.</li>
<li>Fact tables are huge and wide (often 100+ columns) but each query touches a handful of columns, which is exactly what column-oriented storage is good at.</li>
<li><strong>Date is a dimension</strong>, not just a timestamp, so calendar attributes such as public holidays, fiscal quarters and weekdays can be queried directly.</li>
<li>It's <strong>deliberately denormalized</strong> compared with Chapter 2's OLTP advice: dimension attributes are repeated, not normalized, because analysts value simple queries over update efficiency in a read-mostly system.</li>
</ul>
<p><strong>Snowflake schema</strong>: dimensions are normalized further into sub-dimensions (product to brand and category). It's more normalized, with more joins. Analysts usually prefer the simpler star, as popularized by Kimball's dimensional modeling.</p>`,
      followups: [
        "When would you snowflake a dimension?",
        "What grain would you choose for an orders fact table?",
      ],
      pitfalls: [
        "Applying OLTP normalization rules to a warehouse schema by reflex",
        "Storing dates only as timestamps, with no date dimension",
      ],
    },
    {
      id: "q-analytics-on-prod",
      q: "The product team wants dashboards over two years of order history. Why not query the production PostgreSQL database, and what would you build instead?",
      diff: "medium",
      section: "oltp-vs-olap",
      a: `<p><strong>The two workloads don't fit together.</strong> Dashboards scan most of two years of history and aggregate a few columns. Production PostgreSQL is tuned for small keyed transactions. The scans compete for disk bandwidth, buffer pool and CPU with customer-facing queries and evict their hot pages, and because PostgreSQL is a row store, every scan reads whole rows even when it needs three columns. Indexes don't help a query that reads most of the table.</p>
<p><strong>Escalating options</strong>:</p>
<ol>
<li><strong>A read replica</strong>: isolates the load from the primary and is quick to set up. But it's still a row store, so queries stay slow as data grows, and long queries can conflict with replication (query cancellations or replication lag).</li>
<li><strong>A columnar warehouse</strong> (BigQuery, Snowflake, Redshift, ClickHouse) fed by <strong>ETL/ELT</strong>: nightly or hourly batch loads, or <strong>CDC from the WAL</strong> (e.g. Debezium into Kafka) for minute-level freshness (Chapter 11). Model it as a <strong>star schema</strong>: <code>fact_orders</code> (one row per order line) with date, customer, product and region dimensions.</li>
<li><strong>Materialized views or rollups</strong> for the hottest dashboards (daily revenue per region), refreshed on a schedule or maintained incrementally.</li>
</ol>
<p><strong>Requirements to pin down</strong>: how fresh the data must be (that decides batch vs streaming), cost, access control for customer data, and what happens when upstream columns are renamed (schema evolution, Chapter 4). If near-real-time analytics on operational data is a hard requirement, HTAP options (TiDB with TiFlash, SQL Server columnstore indexes) are worth mentioning.</p>`,
      followups: [
        "How fresh does the data need to be, and how does that change the pipeline?",
        "What is the fact table here and what are the dimensions?",
        "How do you handle a column renamed in the OLTP schema?",
      ],
      pitfalls: [
        "'Just add an index' for a query that reads most of the table",
        "Ignoring the operational risk to the OLTP system",
      ],
    },

    // --- column-storage ---
    {
      id: "q02",
      q: "Why is column-oriented storage better for analytics?",
      diff: "medium",
      section: "column-storage",
      a: `<p>Analytic queries scan a huge number of rows but touch only a few columns (<code>SELECT region, SUM(revenue) ... GROUP BY region</code> over a 100-column fact table). In a row store the engine must read, parse and discard whole rows. A column store keeps each column in its own file, <strong>with every file in the same row order</strong>, and gets three wins:</p>
<ol>
<li><strong>Read only the needed columns</strong>: I/O is proportional to the columns touched, not row width. Reading 3 of 100 similar-width columns is about 100/3 ≈ <strong>33x less I/O</strong>.</li>
<li><strong>Compression</strong>: a column holds one type and often few distinct values (about 200 countries, a handful of statuses). Dictionary encoding (the most common), bitmaps and run-length encoding typically shrink data several times over raw, and much more for sorted low-cardinality columns. <strong>Sort order</strong> is what makes RLE effective: the first sort key forms long runs.</li>
<li><strong>Vectorized execution</strong>: operators run over cache-sized batches of values in tight loops, often with SIMD, and bitmap AND/OR can evaluate WHERE clauses directly on compressed data.</li>
</ol>
<p><strong>Where it loses</strong>: fetching one whole row (<code>SELECT * WHERE id = ?</code>) means one read per column file, so a row store wins single-row lookups, and single-row writes are expensive, so column stores buffer writes and merge them in bulk. Also beware the naming trap: Cassandra and HBase "column families" are <em>not</em> column-oriented storage. They store a row's columns together.</p>`,
      followups: [
        "What happens to compression if you sort by a different column?",
        "How do bitmaps evaluate WHERE a AND b?",
      ],
      pitfalls: [
        "Confusing wide-column stores with column-oriented storage",
        "Promising a fixed compression ratio regardless of the data",
      ],
    },
    {
      id: "q-when-not-columnar",
      q: "When would a column-oriented store be the wrong choice?",
      diff: "easy",
      section: "column-storage",
      a: `<p>Column stores win when queries <strong>scan many rows but few columns</strong>. They're the wrong tool when the workload looks like OLTP:</p>
<ul>
<li><strong>Point lookups of whole rows</strong> (<code>SELECT * FROM users WHERE id = ?</code>): a row store reads one contiguous record; a column store does a read per column file and stitches the row together.</li>
<li><strong>Frequent single-row inserts, updates and deletes</strong>: column files are immutable, compressed and sorted, so writes must be buffered and merged. In ClickHouse, row-at-a-time inserts create a part each and end in a "too many parts" error.</li>
<li><strong>Many small concurrent transactions with strict latency targets</strong>, like a checkout or a bank transfer: row stores with B-trees and mature concurrency control are built for exactly that.</li>
<li><strong>Small datasets</strong>, where a row store such as PostgreSQL is simpler and fast enough. Adding a second system and a pipeline has a real cost.</li>
</ul>
<p>If you need both, the usual answer is a row store for transactions plus CDC into a column store, or an HTAP engine that keeps both layouts.</p>`,
      followups: [
        "How do column stores make single-row inserts tolerable? (write buffer + bulk merge)",
        "Are Cassandra's 'column families' columnar? (no)",
      ],
      pitfalls: [
        "Claiming column stores are always faster",
        "Confusing wide-column (Bigtable-style) databases with column-oriented storage",
      ],
    },

    // --- column-writes-and-cubes ---
    {
      id: "q08",
      q: "How do column stores handle updates efficiently?",
      diff: "hard",
      section: "column-writes-and-cubes",
      a: `<p>They can't update in place. Column files are compressed and sorted, and rows are identified by <em>position</em>, so inserting one row into the middle of a sorted table would mean rewriting every column file consistently. The standard answer, pioneered by C-Store and Vertica, is to <strong>borrow the LSM idea</strong>:</p>
<ul>
<li><strong>A write store</strong> in memory (row- or column-oriented, it doesn't matter) absorbs inserts, updates and deletes cheaply.</li>
<li><strong>A read-optimized store</strong> on disk holds sorted, compressed column files.</li>
<li>When enough writes accumulate, a background process <strong>merges them in bulk</strong> into new column files, which is LSM compaction applied column by column. Queries read both stores and combine the results, and the optimizer hides this, so changes are visible to the next query.</li>
</ul>
<p><strong>Modern equivalents</strong>:</p>
<ul>
<li><strong>Vertica</strong>: originally an in-memory WOS plus on-disk ROS with a Tuple Mover; later versions load straight into ROS containers and merge those.</li>
<li><strong>ClickHouse</strong>: each INSERT creates an immutable <em>part</em>, and background merges combine parts. So batch inserts (thousands of rows) or use async inserts; tiny frequent inserts hit "too many parts". Updates and deletes are mutations that rewrite parts, or lightweight deletes that mark rows.</li>
<li><strong>Lakehouses</strong> (Iceberg, Delta Lake) over immutable Parquet: <em>copy-on-write</em> rewrites affected files (expensive writes, fast reads); <em>merge-on-read</em> writes delete files that readers apply (cheap writes, slower reads), followed by compaction.</li>
</ul>`,
      followups: [
        "Why does ClickHouse dislike single-row inserts?",
        "When would you choose merge-on-read over copy-on-write in Iceberg?",
      ],
      pitfalls: [
        "Saying column stores update cells in place",
        "Ignoring that queries must combine the write buffer with the column files",
      ],
    },
    {
      id: "q09",
      q: "Explain the tradeoff of materialized views.",
      diff: "medium",
      section: "column-writes-and-cubes",
      a: `<p>A <strong>virtual view</strong> is a saved query that is expanded every time you query it: always current, no speed-up. A <strong>materialized view</strong> stores the query's result on disk, a denormalized copy, so reads become lookups. The costs:</p>
<ul>
<li><strong>Write cost</strong>: every base-table change must eventually be reflected in the view, by full recomputation (PostgreSQL's <code>REFRESH MATERIALIZED VIEW</code>, with <code>CONCURRENTLY</code> since 9.4) or by incremental maintenance. That's why they're common in read-heavy warehouses and rare in OLTP.</li>
<li><strong>Staleness</strong>: with periodic refresh, the view lags the data by up to one refresh interval.</li>
<li><strong>Inflexibility</strong>: it only answers the questions it was built for. A <strong>data cube</strong>, a grid of aggregates over several dimensions, can't answer "what share of revenue comes from items over $100?" unless price is a dimension.</li>
<li><strong>Aggregate choice</strong>: store <strong>decomposable</strong> aggregates (SUM, COUNT, MIN, MAX) so cells can be rolled up. Store SUM and COUNT, not AVG: averages of averages are wrong. Medians and exact distinct counts don't roll up; use sketches such as HyperLogLog.</li>
</ul>
<p><strong>Modern practice</strong>: ClickHouse materialized views act as insert triggers that feed aggregating tables; Druid rolls up at ingestion; streaming engines (Materialize, RisingWave, Flink) maintain views incrementally as events arrive (Chapters 11–12). Keep the raw facts and materialize only the hot paths.</p>`,
      followups: [
        "Which aggregates can be rolled up from a cube's cells?",
        "How would you keep a view fresh without recomputing it from scratch?",
      ],
      pitfalls: [
        "Storing averages instead of sums and counts",
        "Treating a materialized view as always up to date",
      ],
    },
    {
      id: "q-data-cube-limits",
      q: "Your BI team wants every dashboard query precomputed in an OLAP cube. What will work and what won't?",
      diff: "medium",
      section: "column-writes-and-cubes",
      a: `<p><strong>What works</strong>: group-bys over the cube's chosen dimensions with <strong>decomposable aggregates</strong> are instant lookups. SUM, COUNT, MIN and MAX roll up from cells, and AVG works if you store SUM and COUNT. "Revenue per store per day" or "units per product per month" read a few precomputed cells instead of millions of facts.</p>
<p><strong>What doesn't</strong>:</p>
<ul>
<li><strong>Filters on non-dimension attributes</strong>: "sales of items priced over $100" is impossible if price isn't a dimension, and making every attribute a dimension explodes the cube.</li>
<li><strong>Non-decomposable aggregates</strong>: medians, percentiles and exact distinct counts can't be combined from cells. You need approximate sketches (HyperLogLog, t-digest) stored per cell.</li>
<li><strong>New questions</strong>: a new dimension or a changed definition means a rebuild.</li>
<li><strong>Size</strong>: cells grow with the <em>product</em> of dimension cardinalities, and d dimensions give 2^d group-by combinations (5 dimensions → 32).</li>
<li><strong>Refresh cost and staleness</strong>: someone has to keep it current as facts arrive, and late or corrected facts must update old cells.</li>
</ul>
<p><strong>Recommendation</strong>: keep the raw facts in a columnar warehouse, which handles most ad hoc queries fast enough, and precompute only the hot dashboard paths. Modern options are rollups and materialized views in ClickHouse or Druid, or incremental view maintenance in a streaming system, rather than a classic MOLAP cube for everything.</p>`,
      followups: [
        "How many group-by combinations does a 5-dimension cube have? (2^5 = 32)",
        "How would you keep the cube fresh as new facts arrive?",
      ],
      pitfalls: [
        "Assuming cubes can replace raw data",
        "Precomputing averages instead of sums and counts",
      ],
    },
  ],
});
