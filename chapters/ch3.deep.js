// Chapter 3 deep dive, part 1 (hook + log-structured storage, SSTables and LSM-trees,
// Bloom filters and compaction, B-trees, the write-ahead log). Part 2 (LSM vs B-tree,
// other indexes, OLTP vs OLAP, column storage) lives in ch3.deep2.js.
// Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch3", {
  hook: `<p>Picture an engineer (a made-up story, with realistic numbers) who ships the world's simplest database: two shell functions that append <code>key,value</code> lines to a file and search it for the last match. Writes are instant forever, but a year later the file is 50 GB and every read scans all of it at about 500 MB/s, roughly <strong>100 seconds per lookup</strong>. An index makes reads instant again at the price of updating it on every write, and that trade-off, with the two engine families built around it (log-structured engines and B-trees), fills the first half of this chapter.</p>
<p>Then, one Monday at 9 a.m., a finance analyst runs "revenue per region per week for the last two years" on the same production database: it scans hundreds of millions of 100-column rows to use three columns, checkout p99 latency spikes, and the DBA kills the query. The same bytes must serve "a few rows by key, right now" and "billions of rows, a few columns", and <strong>how a database lays them out on disk</strong> decides which of the two it is good at.</p>`,
  sections: [
    // ------------------------------------------------------------------
    {
      id: "log-and-hash-index",
      title: "A two-line database, and the index that rescues its reads",
      kicker: "Motivation",
      concepts: ["log-structured-storage", "hash-index", "database-index", "sequential-vs-random-io", "compaction"],
      blocks: [
        {
          type: "problem",
          html: `<p>Suppose all your application needs is <code>set(key, value)</code> and <code>get(key)</code>. The laziest correct implementation appends every write to the end of a file and answers a read by scanning the whole file for the last line with that key. Writes run as fast as the disk can go, because an append never seeks. Reads are <strong>O(n)</strong>: at 50 GB and about 500 MB/s, every lookup takes around <strong>100 seconds</strong>, and the file only grows.</p>
<p>The obvious fix, overwriting each value where it already lives, stops the growth but breaks what made the log good. Every write becomes a random seek, and a crash halfway through an overwrite can leave a record that is half old value, half new. We need to find a key quickly without giving up cheap appends, and stop the log from growing forever.</p>`,
        },
        {
          type: "text",
          html: `<p>You may never write a storage engine, but you will choose one and tune it, and its knobs only make sense once you know what is underneath. This half of the chapter compares the two families behind almost every database: <strong>log-structured</strong> engines, which only append, and <strong>page-oriented</strong> engines (B-trees), which overwrite fixed-size pages in place. The first family starts from a complete key-value store in two shell functions:</p>`,
        },
        {
          type: "code",
          lang: "bash",
          title: "kv.sh: the world's simplest database",
          code: `# put KEY VALUE: append one line, never touch existing lines
put() {
  printf '%s,%s\\n' "$1" "$2" >> store.log
}

# get KEY: read the whole file, keep the last value seen for KEY
get() {
  awk -F, -v k="$1" '$1 == k { v = substr($0, length(k) + 2); hit = 1 }
                     END     { if (hit) print v }' store.log
}

# a session
$ put cat.mp4 1
$ put dog.mp4 1
$ put cat.mp4 2          # an update is just another append
$ get cat.mp4
2
$ cat store.log
cat.mp4,1
dog.mp4,1
cat.mp4,2`,
          caption: `The stale line <code>cat.mp4,1</code> stays in the file forever; <code>get</code> ignores it only because a later line for the same key wins.`,
        },
        {
          type: "text",
          html: `<h3>Cheap writes, hopeless reads</h3>
<p><code>put</code> is <strong>O(1)</strong>: an append costs the same however big the file is. <code>get</code> is <strong>O(n)</strong>: it reads every byte ever written, overwritten values included, so at 50 GB and 500 MB/s each read takes 50,000 ÷ 500 = 100 seconds.</p>
<p>The cure for reads is an <strong>index</strong>: an extra structure, derived from the primary data, that tells you where to look. It changes how fast a query runs, never what it returns, and can be rebuilt from the data at any time. But every write must now update the data <em>and</em> every index on it, so each index speeds up some reads and slows down every write. That is why databases don't index everything by default: you, knowing which queries matter, choose the indexes.</p>
<h3>Why appending is so fast</h3>
<p>Appending works with the hardware. On a spinning disk, a <strong>random</strong> write first moves the head to the right track, then waits for the sector to rotate underneath: several milliseconds, so one disk manages only about 100–200 random writes per second. A <strong>sequential</strong> write streams onto the next sectors at 100 MB/s or more. SSDs narrow the gap, but flash can't be overwritten in place and is erased in large blocks, so their firmware still prefers big sequential writes (less internal garbage collection, less wear).</p>`,
        },
        {
          type: "diagram",
          title: "Random vs sequential writes",
          svg: `<svg viewBox="0 0 640 252" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left: a disk platter where six writes land on scattered blocks, so the head jumps between them. Right: the same six writes land on consecutive blocks along one track. Below: SSDs also prefer large sequential writes.">
  <defs>
    <marker id="c3d-io-ok" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ok)"/></marker>
  </defs>
  <text x="160" y="22" font-size="13" font-weight="600" text-anchor="middle" style="fill: var(--viz-bad)">Random writes</text>
  <text x="480" y="22" font-size="13" font-weight="600" text-anchor="middle" style="fill: var(--viz-ok)">Sequential writes</text>
  <circle cx="160" cy="102" r="66" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <circle cx="160" cy="102" r="50" fill="none" stroke-dasharray="3 4" style="stroke: var(--viz-grid)"/>
  <circle cx="160" cy="102" r="10" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <circle cx="480" cy="102" r="66" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <circle cx="480" cy="102" r="50" fill="none" stroke-dasharray="3 4" style="stroke: var(--viz-grid)"/>
  <circle cx="480" cy="102" r="10" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <polyline points="186,57 128,114 208,130 113,75 151,152 190,97" fill="none" stroke-width="1.5" stroke-dasharray="4 3" style="stroke: var(--viz-bad)"/>
  <g style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)">
    <circle cx="186" cy="57" r="9"/><circle cx="128" cy="114" r="9"/><circle cx="208" cy="130" r="9"/>
    <circle cx="113" cy="75" r="9"/><circle cx="151" cy="152" r="9"/><circle cx="190" cy="97" r="9"/>
  </g>
  <g font-size="12" font-weight="600" text-anchor="middle">
    <text x="186" y="61">1</text><text x="128" y="118">2</text><text x="208" y="134">3</text>
    <text x="113" y="79">4</text><text x="151" y="156">5</text><text x="190" y="101">6</text>
  </g>
  <path d="M454,87 A30,30 0 0 1 506,87" fill="none" stroke-width="2" marker-end="url(#c3d-io-ok)" style="stroke: var(--viz-ok)"/>
  <g style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)">
    <circle cx="436.7" cy="77" r="9"/><circle cx="450.6" cy="61.5" r="9"/><circle cx="469.6" cy="53.1" r="9"/>
    <circle cx="490.4" cy="53.1" r="9"/><circle cx="509.4" cy="61.5" r="9"/><circle cx="523.3" cy="77" r="9"/>
  </g>
  <g font-size="12" font-weight="600" text-anchor="middle">
    <text x="436.7" y="81">1</text><text x="450.6" y="65.5">2</text><text x="469.6" y="57.1">3</text>
    <text x="490.4" y="57.1">4</text><text x="509.4" y="65.5">5</text><text x="523.3" y="81">6</text>
  </g>
  <text x="160" y="190" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">a seek + rotation before each write</text>
  <text x="160" y="207" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">several ms each: ~100–200 writes/s per HDD</text>
  <text x="480" y="190" font-size="12" text-anchor="middle" style="fill: var(--viz-ok)">the next block is already under the head</text>
  <text x="480" y="207" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">no seeks: 100+ MB/s on an HDD</text>
  <rect x="20" y="220" width="600" height="26" rx="6" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="320" y="237" font-size="12" text-anchor="middle">SSD: no head to move, but flash erases big blocks, so large sequential writes still win</text>
</svg>`,
          caption: `The same six writes, placed differently. A log-structured engine turns every write into the right-hand picture, whatever order the keys arrive in.`,
        },
        {
          type: "idea",
          html: `<p>Keep the data as an <strong>append-only log</strong>, and keep a small <strong>in-memory hash map</strong> from every key to the byte offset of its newest value. Writes stay appends; a read becomes one hash lookup and one disk read. Run <strong>compaction</strong> in the background to throw away overwritten values, so the log stops growing forever.</p>`,
        },
        {
          type: "text",
          html: `<h3>A hash index: key → byte offset</h3>
<p>The simplest index for a log is a hash map in RAM that maps each key to the <strong>byte offset</strong> where its latest value starts in the data file. A write appends the record and points the key's entry at the new offset. A read looks up the offset, seeks there and reads one record: at most one disk read per lookup, and often zero, because the operating system's page cache may already hold that part of the file.</p>
<p>This suits a modest number of keys, each updated very often: say, a video site where the key is a video's URL and the value its play count, incremented on every view. Millions of writes an hour, but few enough distinct keys for the whole map to fit in memory.</p>
<h3>Segments, compaction and merging</h3>
<p>Appending forever would still fill the disk with stale play counts. So the log is cut into <strong>segments</strong>: when the active file reaches a size limit, it is closed and writes continue in a fresh one. Closed segments are never written again, so they are safe to process in the background.</p>
<p><strong>Compaction</strong> rewrites closed segments keeping only the newest value of each key: a key updated 10,000 times shrinks to one record. Since compacted segments are small, several are <strong>merged</strong> into one new file in the same pass. A background thread does this while the old segments keep serving reads; when the new file is complete, reads switch to it and the old files are deleted.</p>
<p>How many hash maps? The book's version gives <strong>each segment its own map</strong>: a lookup checks the newest segment's map first, then the next newest, until it finds the key, and merging keeps the number of segments, and so the number of maps to check, small. Bitcask instead keeps <strong>one map for all segments</strong> (its <em>keydir</em>), whose entry for each key names the file as well as the offset, so a lookup is always a single probe. The visualization below shows Bitcask's single map.</p>`,
        },
        {
          type: "viz",
          id: "ch3/log-hash-index",
          title: "Append-only log with a hash index",
          caption: "Try Write on one key a few times, then Read and Read without index, then Compact and merge. Finally press Crash and restart with Hint files off, then on. Notice that an indexed read costs one disk read however many stale records pile up (none for a missing key), that garbage stays on disk until compaction, and that after a crash the RAM index must be rebuilt (slowly by scanning, quickly from hint files) while the torn last record fails its checksum and is dropped.",
        },
        {
          type: "text",
          html: `<p>Read without index is the two-function database, touching every record to answer one read; the indexed read jumps to one offset however long the log gets. What grows instead is <strong>garbage</strong>: overwritten values stay on disk, unreachable, until compaction rewrites the segment without them. Compaction never changes a read's answer; it only reclaims space.</p>
<h3>What it takes to make this real</h3>
<ul>
<li><strong>A binary format.</strong> Comma-separated text breaks as soon as a value contains a comma or a newline. Real engines write a length prefix and then the raw bytes, so a reader always knows where a record ends.</li>
<li><strong>Deletes are appends too.</strong> Deleting a key appends a special <strong>tombstone</strong> record, which tells the next merge to discard every older value of that key.</li>
<li><strong>Crash recovery.</strong> The hash maps live in RAM, so a restart loses them, and rebuilding them means reading every segment end to end. Bitcask stores a <strong>hint file</strong> beside each merged segment: a snapshot of its keys and offsets that loads far faster than the data. (The visualization gives every closed segment one, a simplification; Bitcask writes them during merges.)</li>
<li><strong>Torn records.</strong> The machine can die halfway through an append. A <strong>checksum</strong> on every record lets recovery detect and drop the torn tail; that write was never acknowledged, so nothing promised is lost.</li>
<li><strong>Concurrency.</strong> Writes go to the end of one file in strict order, so there is usually a single writer thread. Closed segments are immutable, so any number of threads can read them without locks.</li>
</ul>
<p>Together these are the case for appending over updating in place: sequential writes are faster, recovery and concurrency are simpler because a written record never changes, and merging rewrites live data compactly instead of leaving the files fragmented.</p>
<h3>Where the hash index stops working</h3>
<p>Two limits remain. <strong>Every key must fit in RAM</strong>: a hash map on disk needs lots of random I/O, is expensive to grow when it fills, and makes collision handling fiddly. And <strong>range queries are hopeless</strong>: hashing scatters neighboring keys, so "every sensor from <code>sensor:0001</code> to <code>sensor:9999</code>" costs 9,999 separate lookups. The next section removes both limits with one change: keep each segment sorted by key.</p>`,
        },
        {
          type: "callout",
          tone: "mistake",
          title: "\"Log\" doesn't mean log messages",
          html: `<p>In storage engines, a <strong>log</strong> is an append-only sequence of records, and it <em>is</em> the data, usually in a binary format that only a program reads. It has nothing to do with the human-readable lines an application prints for debugging. "The database is a log" means every change is appended in order and nothing is overwritten.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Riak / Bitcask (Basho)",
              year: "2010",
              tag: "hash index",
              html: `Bitcask, Riak's default storage backend, is exactly this design. An in-memory <strong>keydir</strong> maps every key to a file id, value size and offset; values live in append-only data files; a background merge rewrites only live values; <strong>hint files</strong> let a restarting node rebuild the keydir without reading every value; each entry carries a CRC. Its documented limitation is the one above: all keys must fit in RAM.`,
            },
            {
              org: "Apache Kafka",
              tag: "log compaction",
              html: `Each partition is stored as append-only segment files, each with a sparse offset index and a time index. Topics with <code>cleanup.policy=compact</code> get log compaction: a background cleaner keeps only the latest record per key, and a record with a null value acts as a tombstone. It is the Bitcask merge applied to a message log.`,
            },
            {
              org: "Kafka design documentation",
              tag: "sequential I/O",
              html: `Kafka's design docs argue for sequential disk access with a striking figure: on a six-disk 7200 rpm RAID-5 array, linear writes ran at about 600 MB/s while random writes managed about 100 KB/s, a gap of more than 6,000×.`,
            },
            {
              org: "SSD firmware",
              tag: "flash translation layer",
              html: `Flash pages can't be overwritten in place, and erasing works only on much larger erase blocks. So the SSD's flash translation layer writes each update to a fresh page, remaps the address and garbage-collects old blocks in the background: the drive is itself a log-structured store.`,
            },
          ],
        },
        {
          type: "tradeoffs",
          prosLabel: "What the log plus hash index gives you",
          consLabel: "What it costs",
          pros: [
            "Writes are sequential appends, the fastest thing a disk does.",
            "A point read is one hash lookup and at most one disk read, at any data size.",
            "Simple crash recovery: records are never modified, and a checksum catches a torn final record.",
            "Immutable segments can be read by many threads without locks; compaction runs in the background.",
          ],
          cons: [
            "Every key must fit in RAM, and the index must be rebuilt (or loaded from hint files) on restart.",
            "No efficient range queries: the hash scatters neighboring keys.",
            "Overwritten values waste disk until compaction, which spends I/O rewriting live data.",
            "A single writer thread caps write concurrency.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Design a store for view counters" or "why are so many databases append-only?" are common openers. A strong answer names the access pattern (huge write rate, modest key count, point reads only), proposes an append-only log with an in-memory key → offset map, and raises the operational questions unprompted: how is space reclaimed (segments plus background compaction), how does a node restart quickly (hint files or index snapshots), and how is a torn write detected (per-record checksums)? Then it states the limits: keys must fit in memory, and range queries need a sorted structure. "Appends are fast because sequential I/O avoids seeks", full stop, is the weak version.</p>`,
        },
        {
          type: "quiz",
          q: "A Bitcask-style store holds 10 million keys, each updated about 1,000 times a day. Compaction runs only once a week. What happens over that week?",
          options: [
            "Reads get slower each day, because a read must walk back through all the stale values of a key",
            "Reads stay at about one disk seek; the stale values cost disk space (and later merge work) until compaction",
            "Writes get slower each day, because each write must first find and invalidate the old value on disk",
            "Reads may return stale values until compaction runs, because the old values are still on disk",
          ],
          answer: 1,
          explain: `The in-memory hash map always points at the newest offset, so a read never looks at stale values, and a write is still a single append that just repoints the map. What grows is garbage on disk, which compaction reclaims. Option A describes a scan without an index. Option D is the tempting one: it confuses "still on disk" with "still reachable"; nothing points at the old records any more.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "sstables-and-lsm-trees",
      title: "Sort the segments: SSTables and the LSM-tree",
      kicker: "Mechanism",
      concepts: ["sstable", "lsm-tree", "memtable", "sparse-index"],
      blocks: [
        {
          type: "problem",
          html: `<p>The hash index has two hard limits. Every key must sit in RAM: a billion keys with their offsets is tens of gigabytes of memory before a single value is stored. And range queries ("all keys from <code>user:1000</code> to <code>user:2000</code>") turn into one lookup per key, because hashing scatters neighbors across the file.</p>
<p>If each segment were <strong>sorted by key</strong>, both limits would vanish: neighbors would sit next to each other on disk, merging would be a simple streaming pass, and you would only need to remember where a few keys are. But writes arrive in whatever order users send them, and keeping a file sorted on disk while inserting into its middle means random writes, which is exactly what the log was built to avoid.</p>`,
        },
        {
          type: "idea",
          html: `<p>Buffer incoming writes in a <strong>sorted in-memory structure</strong> (the memtable). When it fills, write it out in one sequential pass as an immutable, sorted file: an <strong>SSTable</strong>. Merge sorted files in the background. Writes in random key order become sequential I/O, and sorted files give cheap merges, sparse indexes and fast range scans.</p>`,
        },
        {
          type: "text",
          html: `<h3>Sorted string tables</h3>
<p>An <strong>SSTable</strong> (Sorted String Table) is a segment whose key-value pairs are sorted by key, with each key appearing at most once per merged file. Sorting pays off three ways.</p>
<p><strong>1. Merging is a streaming mergesort.</strong> Keep a cursor at the front of every input file; at each step, emit whichever cursor's key is smallest and move that cursor forward. The output comes out sorted, every input is read once from start to end, and the memory needed is a few buffers whatever the file sizes, so files far larger than RAM merge fine. When the same key appears in several inputs, the value from the most recent segment wins and the older copies are dropped.</p>`,
        },
        {
          type: "diagram",
          title: "Merging sorted segments",
          svg: `<svg viewBox="0 0 640 186" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three sorted input segments, newest on the left, merge into one sorted output. Keys present in several inputs keep the newest value; the older copies are struck out.">
  <defs>
    <marker id="c3d-merge-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <g font-size="12" font-weight="600" text-anchor="middle">
    <text x="75" y="20">Seg 3 · newest</text><text x="200" y="20">Seg 2</text><text x="325" y="20">Seg 1 · oldest</text><text x="542.5" y="20">Merged output</text>
  </g>
  <g style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)">
    <rect x="25" y="32" width="100" height="20" rx="4"/><rect x="25" y="56" width="100" height="20" rx="4"/><rect x="25" y="80" width="100" height="20" rx="4"/>
    <rect x="150" y="56" width="100" height="20" rx="4"/><rect x="150" y="80" width="100" height="20" rx="4"/>
    <rect x="275" y="56" width="100" height="20" rx="4"/>
    <rect x="470" y="32" width="145" height="20" rx="4"/><rect x="470" y="56" width="145" height="20" rx="4"/><rect x="470" y="80" width="145" height="20" rx="4"/>
    <rect x="470" y="104" width="145" height="20" rx="4"/><rect x="470" y="128" width="145" height="20" rx="4"/><rect x="470" y="152" width="145" height="20" rx="4"/>
  </g>
  <g style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)">
    <rect x="150" y="32" width="100" height="20" rx="4"/>
    <rect x="275" y="32" width="100" height="20" rx="4"/><rect x="275" y="80" width="100" height="20" rx="4"/><rect x="275" y="104" width="100" height="20" rx="4"/>
  </g>
  <g font-size="13" text-anchor="middle" style="font-family: var(--font-mono)">
    <text x="75" y="46">ant:7</text><text x="75" y="70">cow:5</text><text x="75" y="94">pig:2</text>
    <text x="200" y="70">eel:1</text><text x="200" y="94">yak:3</text>
    <text x="325" y="70">bee:2</text>
    <text x="542.5" y="46">ant:7</text><text x="542.5" y="70">bee:2</text><text x="542.5" y="94">cow:5</text>
    <text x="542.5" y="118">eel:1</text><text x="542.5" y="142">pig:2</text><text x="542.5" y="166">yak:3</text>
  </g>
  <g font-size="13" text-anchor="middle" style="font-family: var(--font-mono); fill: var(--viz-muted)">
    <text x="200" y="46">cow:4</text><text x="325" y="46">ant:1</text><text x="325" y="94">pig:1</text><text x="325" y="118">yak:1</text>
  </g>
  <g stroke-width="1.5" style="stroke: var(--viz-bad)">
    <line x1="178" y1="42" x2="222" y2="42"/><line x1="303" y1="42" x2="347" y2="42"/>
    <line x1="303" y1="90" x2="347" y2="90"/><line x1="303" y1="114" x2="347" y2="114"/>
  </g>
  <line x1="388" y1="100" x2="456" y2="100" stroke-width="2" marker-end="url(#c3d-merge-arrow)" style="stroke: var(--viz-muted)"/>
  <text x="422" y="92" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">merge</text>
  <text x="200" y="150" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">each input is sorted and read once, top to bottom</text>
  <text x="200" y="168" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">struck out: older copy, shadowed by a newer segment</text>
</svg>`,
          caption: `A streaming merge: memory use doesn't depend on file size. <code>cow:4</code> loses to the newer <code>cow:5</code>, and <code>yak:1</code> to <code>yak:3</code>; the output is sorted, with each key once.`,
        },
        {
          type: "text",
          html: `<p><strong>2. The index can be sparse.</strong> You no longer need an entry for every key. Keep one key per block of a few kilobytes, and every other key is bracketed by two indexed neighbors. Looking for <code>length</code>? If the index says <code>lemon</code> starts at byte 4096 and <code>lid</code> at 8192, then <code>length</code>, if it exists, lies between them: one short scan of one block.</p>
<p><strong>3. Blocks compress.</strong> A lookup decodes a whole block anyway, so the engine can compress every block separately before writing it and let the sparse index point at where each compressed block begins. That saves disk space and, just as important, I/O bandwidth.</p>`,
        },
        {
          type: "diagram",
          title: "An SSTable with a sparse index",
          svg: `<svg viewBox="0 0 640 228" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="An in-memory sparse index holds only the first key of each 4 KB block: lamp at 0, lemon at 4096, lid at 8192, lime at 12288. A lookup for length falls between lemon and lid, so only the block at offset 4096 is read.">
  <defs>
    <marker id="c3d-sp-c1" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker>
    <marker id="c3d-sp-ok" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ok)"/></marker>
  </defs>
  <text x="20" y="20" font-size="12" font-weight="600">In memory: sparse index (first key of each block)</text>
  <rect x="20" y="28" width="600" height="46" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="30" y="36" width="136" height="30" rx="5" style="fill: var(--viz-bg); stroke: var(--viz-c1)"/>
  <rect x="178" y="36" width="136" height="30" rx="5" stroke-width="2" style="fill: var(--viz-bg); stroke: var(--viz-ok)"/>
  <rect x="326" y="36" width="136" height="30" rx="5" stroke-width="2" style="fill: var(--viz-bg); stroke: var(--viz-ok)"/>
  <rect x="474" y="36" width="136" height="30" rx="5" style="fill: var(--viz-bg); stroke: var(--viz-c1)"/>
  <g font-size="13" text-anchor="middle" style="font-family: var(--font-mono)">
    <text x="98" y="56">lamp → 0</text><text x="246" y="56">lemon → 4096</text><text x="394" y="56">lid → 8192</text><text x="542" y="56">lime → 12288</text>
  </g>
  <g stroke-width="1.2" stroke-dasharray="4 3" style="stroke: var(--viz-c1)">
    <line x1="98" y1="66" x2="45" y2="122" marker-end="url(#c3d-sp-c1)"/>
    <line x1="394" y1="66" x2="345" y2="122" marker-end="url(#c3d-sp-c1)"/>
    <line x1="542" y1="66" x2="495" y2="122" marker-end="url(#c3d-sp-c1)"/>
  </g>
  <line x1="246" y1="66" x2="195" y2="122" stroke-width="2" marker-end="url(#c3d-sp-ok)" style="stroke: var(--viz-ok)"/>
  <rect x="20" y="126" width="146" height="50" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <rect x="170" y="126" width="146" height="50" rx="6" stroke-width="2.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-ok)"/>
  <rect x="320" y="126" width="146" height="50" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <rect x="470" y="126" width="146" height="50" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <g font-size="12" style="fill: var(--viz-muted)">
    <text x="30" y="144">@0</text><text x="180" y="144">@4096</text><text x="330" y="144">@8192</text><text x="480" y="144">@12288</text>
  </g>
  <g font-size="13" text-anchor="middle" style="font-family: var(--font-mono)">
    <text x="93" y="166">lamp … leaf</text><text x="243" y="166">lemon … lever</text><text x="393" y="166">lid … limb</text><text x="543" y="166">lime … lynx</text>
  </g>
  <text x="20" y="198" font-size="12" font-weight="600">On disk: one SSTable, sorted by key, stored as compressed ~4 KB blocks</text>
  <text x="20" y="218" font-size="12" style="fill: var(--viz-ok)">get(length): lemon ≤ length &lt; lid, so read and decompress only the block at @4096</text>
</svg>`,
          caption: `Sorting is what makes a sparse index possible: the two indexed neighbors bracket the key, so one block of a few kilobytes is all you scan. A hash-ordered file offers no such bracket.`,
        },
        {
          type: "text",
          html: `<h3>Sorted files from random writes: the memtable</h3>
<p>A sorted structure is awkward to maintain on disk but routine in memory. Balanced trees such as red-black or AVL trees accept keys in any order and hand them back sorted. LevelDB and RocksDB use a <strong>skip list</strong> by default, and Cassandra a concurrent skip list (or, since 5.0, a trie). This in-memory structure is the <strong>memtable</strong>, and the engine runs like this:</p>
<ol>
<li><strong>Write:</strong> insert the key and value into the memtable, replacing any older value of that key.</li>
<li><strong>Flush:</strong> when the memtable passes a size threshold (a few megabytes in early designs; LevelDB's default is 4 MB and RocksDB's 64 MB), write it out in key order as a new SSTable: one sequential write. New writes go to a fresh memtable while the old one is flushed.</li>
<li><strong>Read:</strong> check the memtable, then the newest SSTable, then the next older one, and stop at the first version of the key you find.</li>
<li><strong>Compact:</strong> in the background, merge SSTables and drop overwritten or deleted values (strategies in the next section).</li>
</ol>
<p>One gap remains: the memtable lives in RAM, so a crash loses every write not yet flushed. The fix is an old friend. Every write is <em>also</em> appended to an unsorted log on disk (a write-ahead log or commit log) whose only job is to rebuild the memtable after a restart. Once that memtable has been flushed to an SSTable, its log is discarded.</p>
<p>This design is the <strong>LSM-tree</strong> (Log-Structured Merge-tree). Its immutability is a feature: readers need no locks on SSTables, and a merged file replaces its inputs atomically by swapping the list of live files.</p>`,
        },
        {
          type: "viz",
          id: "ch3/lsm-tree",
          title: "LSM-tree write and read paths",
          caption: "Try Get with key e first: a tombstone in SST 3 hides the older e:1 in L1. Then press Put x8 random and watch the memtable flush and L0 compact, and press Scan c–f to see a range read merge every file. Switch Auto-compact off and keep writing until writes stall: Flush is blocked too, and only Compact clears the stall. Finally switch the WAL off, make a few Puts and press Crash. Notice that Last read and Space amp climb while compaction is paused, Write amp climbs when it runs, and only the writes made without the WAL are lost. (Toy thresholds: compaction at 4 L0 files, a stall at 6; RocksDB's defaults are 4, 20 and 36.)",
        },
        {
          type: "text",
          html: `<p>Watch the statistics. A put costs one WAL append plus an in-memory insert, but the same entry is written again by the flush and again by every compaction that carries it down: that repeated rewriting is LSM <strong>write amplification</strong>. Pause compaction and the cost moves to reads (more files to check) and to space (duplicate versions). The section on LSM vs B-trees weighs these amplifications against each other.</p>
<h3>Range scans merge every sorted run</h3>
<p>A point read can stop at the first file that has the key. A range scan can't: any file might hold keys in the range, and only the newest version of each may be returned. So the engine opens an <strong>iterator</strong> on the memtable and on every SSTable whose key range overlaps the request, and merges them on the fly, exactly as compaction does: a k-way merge in which the newest version of a key wins and a tombstone hides it. Each SSTable records its minimum and maximum key, so files that can't overlap are skipped unopened. Bloom filters (next section) can't help, because they answer "is this one key here?", not "is anything in this range here?". A scan's cost grows with the number of sorted runs, one more reason compaction matters.</p>
<h3>Who uses it</h3>
<p>Bigtable (2006) described the full design and named its parts; the embeddable libraries LevelDB and RocksDB, and Cassandra and HBase, all follow it. Lucene, the engine inside Elasticsearch and Solr, stores its term dictionary the same way: the key is a term, the value its postings list (the ids of documents containing it), kept in immutable segments merged in the background.</p>
<p>One caution about "stop at the first version": that is the key-value model of LevelDB and RocksDB. In Cassandra, the columns of one row may have been written at different times and so live in different SSTables, and a read merges that row's cells from several files, keeping the newest timestamp for each cell.</p>`,
        },
        {
          type: "timeline",
          title: "From paper to everywhere",
          items: [
            { year: "1991–92", html: "Rosenblum and Ousterhout's log-structured file system writes all file data to an append-only log on disk." },
            { year: "1996", html: "O'Neil, Cheng, Gawlick and O'Neil publish the <strong>LSM-tree</strong>: batch inserts in memory, then merge sorted runs on disk." },
            { year: "2006", html: "Google's <strong>Bigtable</strong> paper introduces memtables, SSTables, compactions and per-SSTable Bloom filters." },
            { year: "2008", html: "Facebook open-sources <strong>Cassandra</strong>, pairing Bigtable's storage design with Dynamo-style replication." },
            { year: "2011", html: "Google open-sources <strong>LevelDB</strong> (Jeff Dean and Sanjay Ghemawat), a small embeddable LSM library." },
            { year: "2013", html: "Facebook open-sources <strong>RocksDB</strong>, a fork of LevelDB aimed at fast flash storage and server workloads." },
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Google Bigtable",
              year: "2006",
              tag: "origin of the terms",
              html: `The OSDI paper describes tablet servers that append to a commit log, buffer updates in a <strong>memtable</strong>, flush immutable <strong>SSTables</strong> (minor compactions), merge them (merging and major compactions) and use per-SSTable Bloom filters to avoid disk reads. It coined both terms.`,
            },
            {
              org: "LevelDB and RocksDB",
              tag: "embedded engines",
              html: `RocksDB started at Facebook as a fork of LevelDB and is now embedded almost everywhere: MyRocks (MySQL), TiKV, Kafka Streams state stores and Apache Flink's RocksDB state backend. It was CockroachDB's engine until CockroachDB replaced it with Pebble, its own LSM engine in Go.`,
            },
            {
              org: "Apache Cassandra and HBase",
              tag: "Bigtable descendants",
              html: `Cassandra appends each write to a commit log and a memtable and flushes memtables to immutable SSTables. HBase does the same with a WAL, a MemStore and immutable HFiles. Both designs come straight from Bigtable.`,
            },
            {
              org: "Lucene / Elasticsearch",
              tag: "segments",
              html: `A Lucene index is a set of immutable segments merged in the background by a merge policy. Elasticsearch makes new documents searchable with a <strong>refresh</strong>, which writes a new segment, every second by default; durability is a separate matter, covered by its transaction log (translog) until a flush commits the segments.`,
            },
          ],
        },
        {
          type: "tradeoffs",
          prosLabel: "What the LSM-tree buys",
          consLabel: "What it costs",
          pros: [
            "High write throughput: every disk write is sequential (WAL appends, flushes, merges), whatever order keys arrive in.",
            "Data can be far larger than RAM: only a sparse index and Bloom filters stay in memory.",
            "Efficient range scans, because every file is sorted.",
            "Compact files: blocks compress well, and compaction rewrites data without gaps.",
            "Immutable files: lock-free reads, simple recovery, easy snapshots and backups.",
          ],
          cons: [
            "A read may check several files; a lookup for a missing key is the worst case.",
            "Range scans merge every overlapping sorted run, so they slow down when files pile up.",
            "Compaction rewrites data repeatedly (write amplification) and competes with foreground I/O.",
            "Deletes leave tombstones that cost space and read time until compaction removes them.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"Walk me through a write and a read in Cassandra (or RocksDB)" is a classic. A strong answer traces both paths. Write: append to the commit log, insert into the memtable, acknowledge; later, flush the memtable as an immutable SSTable and let compaction merge files. Read: memtable first, then SSTables from newest to oldest, using Bloom filters to skip files and a sparse index to find the right block. Then volunteer the costs: reads touch several files, compaction rewrites data, and a crash is survivable only because of the log. Explaining <em>why</em> sorting enables both the sparse index and the streaming merge, and noting that range scans must merge every overlapping file, separates a memorized answer from an understood one.</p>`,
        },
        {
          type: "quiz",
          q: "Why can an SSTable get by with a sparse in-memory index (one key per few KB), while a Bitcask-style hash index must keep every key in RAM?",
          options: [
            "SSTables compress their keys, so a full index becomes small enough to drop",
            "SSTables never contain the same key twice, so fewer keys need indexing",
            "Because keys are sorted, any key's location is bracketed by its two indexed neighbors, so you scan one small block",
            "Bloom filters replace the index, so only a few keys are needed for range queries",
          ],
          answer: 2,
          explain: `Sorting is what makes the index sparse-able: if <code>lemon</code> starts at 4096 and <code>lid</code> at 8192, then <code>length</code> must be in between. A hash-ordered file has no order, so a key that isn't in the index could be anywhere. Compression (A) and Bloom filters (D) help with space and with skipping whole files, but neither says where a key sits inside a file. Option B is true of merged SSTables but irrelevant: the hash index also has one entry per distinct key.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "bloom-filters-and-compaction",
      title: "Keeping LSM reads fast: Bloom filters and compaction strategies",
      kicker: "Making it practical",
      concepts: ["bloom-filter", "compaction", "tombstone", "size-tiered-vs-leveled"],
      blocks: [
        {
          type: "problem",
          html: `<p>An LSM read stops at the first table that has the key, so the worst case is a key that doesn't exist anywhere: a memtable miss, then a disk read in every SSTable from newest to oldest, all to answer "no". Workloads full of misses are common: is this username taken, have I already processed this event id, does this row exist before I insert it?</p>
<p>Meanwhile every overwrite and delete leaves dead versions behind. If compaction is lazy, files pile up, every read checks more of them and disk usage grows. If it is eager, the engine spends its disk bandwidth rewriting the same data again and again. Both problems need an answer before an LSM-tree is usable in production.</p>`,
        },
        {
          type: "idea",
          html: `<p>Give every SSTable a tiny in-memory <strong>Bloom filter</strong> that can say "definitely not in this file", so most files are ruled out without a disk read. Then pick a <strong>compaction strategy</strong> (size-tiered or leveled) that sets the balance between how much data you rewrite, how many files a read touches and how much dead data you keep.</p>`,
        },
        {
          type: "text",
          html: `<h3>How a Bloom filter works</h3>
<p>A <strong>Bloom filter</strong> (Burton Bloom, 1970) is an array of <em>m</em> bits, all zero to start, plus <em>k</em> hash functions that each map a key to one bit position. To <strong>insert</strong> a key, compute its k positions and set those bits to 1. To <strong>query</strong> a key, compute the same k positions and look:</p>
<ul>
<li>If <strong>any</strong> of those bits is 0, the key was definitely never inserted; inserting it would have set that bit.</li>
<li>If <strong>all</strong> are 1, the key is <em>probably</em> present. Other keys may have set those bits by coincidence, so this answer is only "maybe".</li>
</ul>
<p>So a Bloom filter has <strong>no false negatives</strong>, only <strong>false positives</strong>, and their rate is tunable. With n keys inserted, the chance of a false positive is about</p>
<span class="formula">p ≈ (1 − e<sup>−kn/m</sup>)<sup>k</sup></span>
<p>The best number of hash functions is k ≈ (m/n) × ln 2, and the bits per key needed for a target rate p is −ln p / (ln 2)², about 1.44 × log₂(1/p). The rule of thumb to remember: <strong>about 10 bits per key with k ≈ 7 gives roughly 1% false positives</strong> (0.8% to be exact). A billion keys at 1% need about 9.6 billion bits, roughly 1.2 GB: small enough to keep in memory.</p>`,
        },
        {
          type: "table",
          title: "Bits per key vs false-positive rate (with the best k)",
          headers: ["Bits per key", "Best k", "False positives"],
          rows: [
            ["5", "3–4", "≈ 9%"],
            ["8", "5–6", "≈ 2%"],
            ["10", "7", "≈ 0.8%"],
            ["15", "10", "≈ 0.07%"],
            ["20", "14", "≈ 0.007%"],
          ],
          note: "Every extra ~4.8 bits per key divides the false-positive rate by 10.",
        },
        {
          type: "viz",
          id: "ch3/bloom-filter",
          title: "Bloom filter: definitely not, or maybe",
          caption: "Try querying words that aren't in the set until you hit a false positive, then press Query all keys and compare the observed rate with the predicted one. Insert more keys or drag Bits (m) down to watch the filter saturate, compare k with the Best k stat, and press Try to delete. Notice that an inserted word always answers maybe, and that clearing a key's bits would also clear bits another key needs.",
        },
        {
          type: "text",
          html: `<h3>One filter per SSTable</h3>
<p>An LSM engine builds a Bloom filter for each SSTable when it writes the file (at flush or compaction) and keeps it in memory. A point read consults each file's filter before touching the file: "definitely not" means skip it with no I/O, "maybe" means read it. A false positive costs one wasted read, never a wrong answer, because the read itself then finds the key isn't there.</p>
<p>Two details matter. First, <strong>deleted keys go into the filter too</strong>. The file holding a tombstone must answer "maybe", or the read would skip it and find an older, deleted value in a lower file: a resurrected delete. Second, a standard Bloom filter <strong>can't delete</strong>: clearing a bit might clear it for another key that shares it, creating a false negative. LSM-trees never need to, because SSTables are immutable and each new file gets a fresh filter. (Counting Bloom filters and cuckoo filters support deletion, at extra cost.)</p>
<p>Filters help <strong>point lookups</strong> only. A range scan asks "is anything between c and f here?", which a per-key filter can't answer; prefix Bloom filters help only when the whole range shares a key prefix, such as all keys of one user.</p>
<h3>Tombstones: deletes that have to stick around</h3>
<p>A delete in an LSM-tree is a write: a <strong>tombstone</strong> for the key. A read that reaches the tombstone first returns "not found". It can't be thrown away at the next merge, because an older value may still sit in a file that wasn't part of that merge, and dropping the marker would bring the value back. It can go only once compaction is sure no older copy exists anywhere below, for example when merging into the bottom level.</p>
<p>Replication adds a second clock. In a leaderless system, a replica that was down during the delete never saw the tombstone; if the others purge theirs too soon, anti-entropy (Chapter 5) finds the old value on the stale replica and copies it back. Cassandra therefore keeps tombstones for <code>gc_grace_seconds</code>, 10 days by default, and expects every replica to be repaired within that window.</p>
<h3>Size-tiered vs leveled compaction</h3>
<p><strong>Size-tiered compaction</strong> waits until there are several SSTables of similar size (four, by default, in Cassandra) and merges them into one bigger file, so newer, smaller files are merged into older, larger ones. Each byte is rewritten only a few times, so write amplification is low. The price: a read has several overlapping files per tier to check, the same key can exist in many of them (obsolete versions take up space until the tiers finally merge), and merging the largest tier temporarily needs about as much free space as the data being merged, so the disk may need to hold about 2x the data at that moment.</p>
<p><strong>Leveled compaction</strong> organizes files into levels. L0 holds freshly flushed files, which overlap each other. Every deeper level (L1, L2, ...) is one sorted run split into many small files with non-overlapping key ranges, each level about 10 times larger than the one above (RocksDB's default multiplier). When a level outgrows its target, compaction picks one file and merges it into the overlapping files of the next level, so the work comes in small increments. A point read checks every L0 file whose range covers the key, then <strong>at most one file per deeper level</strong>, and little dead data survives (space amplification about 1.1x in steady state). But each time a file moves down, the overlapping files below it, roughly 10 times as much data, are rewritten along with it. In the worst case every level costs about the size ratio in rewrites, so write amplification is much higher: totals of 10–30x are commonly reported.</p>
<p>LevelDB and RocksDB use leveled compaction by default (hence LevelDB's name; RocksDB also offers a tiered "universal" style), HBase uses size-tiered, and Cassandra offers both plus time-window compaction for time series.</p>`,
        },
        {
          type: "diagram",
          title: "Size-tiered vs leveled compaction",
          svg: `<svg viewBox="0 0 640 244" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left, size-tiered: four small files merge into one new medium file, and medium files later merge into one large file. Right, leveled: L0 holds three overlapping files, L1 four non-overlapping files covering all keys, L2 ten files; one L1 file merges into the three L2 files that overlap it.">
  <defs>
    <marker id="c3d-cmp-warn" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-warn)"/></marker>
  </defs>
  <line x1="320" y1="8" x2="320" y2="236" style="stroke: var(--viz-grid)"/>
  <text x="158" y="20" font-size="13" font-weight="600" text-anchor="middle">Size-tiered</text>
  <text x="482" y="20" font-size="13" font-weight="600" text-anchor="middle">Leveled</text>
  <g font-size="12" font-weight="600" style="fill: var(--viz-muted)">
    <text x="14" y="55">T1</text><text x="14" y="111">T2</text><text x="14" y="167">T3</text>
    <text x="334" y="58">L0</text><text x="334" y="114">L1</text><text x="334" y="169">L2</text>
  </g>
  <g style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)">
    <rect x="44" y="42" width="28" height="18" rx="3"/><rect x="78" y="42" width="28" height="18" rx="3"/>
    <rect x="112" y="42" width="28" height="18" rx="3"/><rect x="146" y="42" width="28" height="18" rx="3"/>
    <rect x="44" y="96" width="56" height="22" rx="3"/><rect x="108" y="96" width="56" height="22" rx="3"/><rect x="172" y="96" width="56" height="22" rx="3"/>
    <rect x="44" y="150" width="248" height="26" rx="3"/>
    <rect x="376" y="34" width="94" height="11" rx="2"/><rect x="420" y="49" width="140" height="11" rx="2"/><rect x="392" y="64" width="220" height="11" rx="2"/>
    <rect x="366" y="100" width="59" height="20" rx="3"/><rect x="496" y="100" width="59" height="20" rx="3"/><rect x="561" y="100" width="59" height="20" rx="3"/>
    <rect x="366" y="152" width="22" height="26" rx="2"/><rect x="391.4" y="152" width="22" height="26" rx="2"/>
    <rect x="493" y="152" width="22" height="26" rx="2"/><rect x="518.4" y="152" width="22" height="26" rx="2"/><rect x="543.8" y="152" width="22" height="26" rx="2"/>
    <rect x="569.2" y="152" width="22" height="26" rx="2"/><rect x="594.6" y="152" width="22" height="26" rx="2"/>
  </g>
  <g stroke-width="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)">
    <rect x="236" y="96" width="56" height="22" rx="3" stroke-dasharray="4 3"/>
    <rect x="431" y="100" width="59" height="20" rx="3"/>
    <rect x="416.8" y="152" width="22" height="26" rx="2"/><rect x="442.2" y="152" width="22" height="26" rx="2"/><rect x="467.6" y="152" width="22" height="26" rx="2"/>
  </g>
  <text x="264" y="111" font-size="12" text-anchor="middle">new</text>
  <text x="168" y="167" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">one large file</text>
  <g fill="none" stroke-width="1.5" style="stroke: var(--viz-warn)">
    <path d="M174,51 Q238,56 258,92" marker-end="url(#c3d-cmp-warn)"/>
    <line x1="140" y1="120" x2="140" y2="146" marker-end="url(#c3d-cmp-warn)"/>
    <line x1="460" y1="121" x2="455" y2="148" marker-end="url(#c3d-cmp-warn)"/>
  </g>
  <text x="158" y="196" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">similar-sized files merge into the next tier</text>
  <text x="158" y="214" font-size="12" text-anchor="middle">few rewrites, but many files per read</text>
  <text x="158" y="232" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">big merges need spare disk space</text>
  <text x="493" y="196" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">keys a → z; each level ~10× the one above</text>
  <text x="482" y="214" font-size="12" text-anchor="middle">reads: L0 files, then ≤ 1 file per level</text>
  <text x="482" y="232" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">up to ~10× rewrites per level</text>
</svg>`,
          caption: `Size-tiered lets similar-sized files pile up and merges them in big batches: little rewriting, but many overlapping files. Leveled keeps each level one sorted run and merges small pieces down: few files per read, but every byte is rewritten, often several times, at each level it passes through.`,
        },
        {
          type: "compare",
          title: "Picking a compaction strategy",
          items: [
            { title: "Size-tiered", html: `<p><strong>Good for:</strong> write-heavy workloads where data is rarely read back or rarely updated.</p><p><strong>Pays with:</strong> more files per read, more duplicate data, and big merges that need spare disk.</p>` },
            { title: "Leveled", html: `<p><strong>Good for:</strong> read-heavy and update-heavy workloads where reads must touch few files and disk space matters.</p><p><strong>Pays with:</strong> higher write amplification; compaction can fall behind during a heavy write burst.</p>` },
            { title: "Time-window", html: `<p><strong>Good for:</strong> time series written in time order and expired by TTL. Files are grouped by time window, so an expired window is dropped as a whole file with no merging.</p><p><strong>Pays with:</strong> works badly with out-of-order writes or updates to old data.</p>` },
          ],
        },
        {
          type: "text",
          html: `<p>Whatever the strategy, compaction shares the disk with foreground traffic. If writes outpace it, unmerged files pile up: reads slow down, disk usage grows and, at worst, the disk fills. Even when it keeps up, a big merge competing for I/O shows up in high latency percentiles (Chapter 1), so watch p99 and pending-compaction metrics on any LSM store.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          title: "Write stalls and unified compaction",
          html: `<p>The book notes that SSTable engines typically don't throttle incoming writes when compaction falls behind, so you have to monitor for it. Modern RocksDB does throttle: when too many L0 files or too many bytes awaiting compaction pile up, it first slows writers down and then stops them (a <strong>write stall</strong>). By default L0 compaction starts at 4 files, writes slow down at 20 and stop at 36. That turns invisible compaction debt into visible write latency, which is easier to alert on. And Cassandra 5.0 (2024) added the <strong>Unified Compaction Strategy</strong>, which can be tuned to behave like tiered compaction, like leveled compaction, or something in between, instead of making you commit to one up front.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "LevelDB / RocksDB",
              tag: "10 bits per key",
              html: `Bloom filters are optional, and LevelDB's documentation recommends a filter policy of <strong>10 bits per key</strong> (about 1% false positives). RocksDB's write throttling is configurable through settings such as <code>level0_slowdown_writes_trigger</code> and <code>level0_stop_writes_trigger</code>, plus limits on pending compaction bytes.`,
            },
            {
              org: "Apache Cassandra",
              tag: "pluggable compaction",
              html: `The false-positive chance is a per-table setting (<code>bloom_filter_fp_chance</code>). Compaction is pluggable per table: SizeTieredCompactionStrategy (long the default), LeveledCompactionStrategy and TimeWindowCompactionStrategy for time series, with the Unified Compaction Strategy added in 5.0.`,
            },
            {
              org: "Cassandra tombstones",
              tag: "gc_grace_seconds",
              html: `Tombstones are kept for <code>gc_grace_seconds</code> (864,000 s, 10 days, by default) so every replica can learn about a delete before it is purged. A query logs a warning after scanning 1,000 tombstones and is aborted after 100,000 (<code>tombstone_warn_threshold</code> and <code>tombstone_failure_threshold</code>).`,
            },
            {
              org: "Discord",
              year: "2017",
              tag: "tombstone trouble",
              html: `In "How Discord Stores Billions of Messages", Discord described a channel in which nearly all messages had been deleted. Reading it meant scanning millions of tombstones, which produced garbage faster than the JVM could collect it and caused long GC pauses. They shortened the tombstone lifespan and changed queries to avoid scanning empty ranges.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Two favorites: "how does the database avoid reading every file?" and "what's the catch with deletes in Cassandra?". For the first, describe Bloom filters precisely: no false negatives, a tunable false-positive rate (about 10 bits per key for 1%), one filter per immutable SSTable, no help for range scans. For the second, explain why a tombstone must outlive every older copy of the key <em>and</em> every replica that missed the delete, and what happens when a workload creates millions of them: slow reads, GC pauses, queries aborted past the tombstone threshold. Finish by matching compaction to workload, size-tiered for write-heavy and leveled for read-heavy, with the reason: you are choosing which amplification to pay.</p>`,
        },
        {
          type: "quiz",
          q: "An LSM store has 8 SSTables, each with a Bloom filter tuned for a 1% false-positive rate. The workload is mostly lookups for keys that don't exist (username-availability checks). About how many SSTable disk reads does each such lookup cost?",
          options: [
            "8",
            "Exactly 1",
            "Exactly 0",
            "About 0.08",
          ],
          answer: 3,
          explain: `Each of the 8 filters wrongly says "maybe" about 1% of the time, so the expected cost is 8 × 0.01 = 0.08 reads per lookup, instead of 8 without filters (option A). "Exactly 0" is the tempting answer, but Bloom filters do have false positives; what they never have is false negatives. "Exactly 1" confuses this with a key that exists, which needs one real read of the file that holds it.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "b-trees",
      title: "B-trees: a shallow tree of fixed-size pages",
      kicker: "The other school",
      concepts: ["b-tree", "page-split"],
      blocks: [
        {
          type: "problem",
          html: `<p>Long before log-structured engines, databases faced a harder version of the problem: keep a sorted index on a spinning disk where every random access costs around 10 milliseconds. A binary search tree on disk is hopeless. A billion keys means about 30 levels, so about 30 random reads, roughly <strong>0.3 seconds to find one key</strong>.</p>
<p>A sorted flat file is easy to binary-search, but inserting into the middle means shifting everything after it. What's needed is a structure where a lookup costs a handful of disk reads however large the data gets, that supports range scans, and where an insert or delete changes a few blocks locally instead of rewriting the world.</p>`,
        },
        {
          type: "idea",
          html: `<p>Split the data into <strong>fixed-size pages</strong> and arrange them as a balanced tree in which every page has <strong>hundreds of children</strong>. A lookup reads one page per level, and 3–4 levels cover terabytes. When a page fills up it <strong>splits</strong> and pushes a separator key into its parent, so the tree only ever grows at the root and stays perfectly balanced.</p>`,
        },
        {
          type: "text",
          html: `<h3>Pages, not segments</h3>
<p>Rudolf Bayer and Edward McCreight introduced the <strong>B-tree</strong> in 1970 (the paper appeared in 1972). By the end of that decade, Douglas Comer's survey already called it "ubiquitous", and it remains the standard index in almost every relational database and in many non-relational ones.</p>
<p>B-trees also keep keys in sorted order, so they too serve point lookups and range scans, but they rest on a different idea. Instead of variable-size segments written once, the database is divided into <strong>fixed-size pages</strong> (or blocks) that are read and overwritten one page at a time. The traditional size is 4 KB; PostgreSQL and SQL Server use 8 KB pages, InnoDB 16 KB by default, and SQLite 4 KB by default. That matches the hardware, which also reads and writes fixed-size blocks.</p>
<p>Every page has an address, its page number, so one page can refer to another: pointers, but on disk. The pages form a tree:</p>
<ul>
<li>The <strong>root</strong> page is where every lookup starts.</li>
<li><strong>Internal pages</strong> hold sorted keys and references to child pages. Each child covers the contiguous range of keys between two neighboring keys in its parent.</li>
<li><strong>Leaf pages</strong> hold the keys themselves, each with its value inline or a reference to where the row is stored.</li>
</ul>
<p>The number of child references in one page is the <strong>branching factor</strong>, typically several hundred depending on page and key size. Internal pages only need to separate ranges, so many engines <strong>abbreviate</strong> their keys, storing just enough of each to tell neighbors apart, which fits even more children in a page.</p>`,
        },
        {
          type: "diagram",
          title: "Anatomy of a B+tree",
          svg: `<svg viewBox="0 0 640 258" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A root page with keys 100, 200 and 300 has four children covering keys below 100, 100 to 199, 200 to 299 and 300 and above. The 100 to 199 page is expanded, with separators 120, 150 and 180 pointing to four leaf pages holding keys and rows. The leaves are linked left to right.">
  <defs>
    <marker id="c3d-bt-c2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c2)"/></marker>
  </defs>
  <g font-size="12" style="fill: var(--viz-muted)">
    <text x="20" y="28">branching factor:</text><text x="20" y="44">hundreds of children/page</text>
    <text x="462" y="28">one page = 4–16 KB,</text><text x="462" y="44">a fixed size on disk</text>
  </g>
  <g stroke-width="1.5" style="stroke: var(--viz-line)">
    <line x1="240" y1="46" x2="85" y2="100"/><line x1="300" y1="46" x2="280" y2="100"/>
    <line x1="360" y1="46" x2="460" y2="100"/><line x1="420" y1="46" x2="572" y2="100"/>
    <line x1="197.5" y1="133" x2="87.5" y2="182"/><line x1="252.5" y1="133" x2="242.5" y2="182"/>
    <line x1="307.5" y1="133" x2="397.5" y2="182"/><line x1="362.5" y1="133" x2="552.5" y2="182"/>
  </g>
  <rect x="210" y="12" width="240" height="42" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="170" y="100" width="220" height="40" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <g stroke-dasharray="4 3" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)">
    <rect x="20" y="100" width="130" height="34" rx="6"/><rect x="410" y="100" width="100" height="34" rx="6"/><rect x="525" y="100" width="95" height="34" rx="6"/>
  </g>
  <g style="fill: var(--viz-c1)">
    <circle cx="240" cy="46" r="3"/><circle cx="300" cy="46" r="3"/><circle cx="360" cy="46" r="3"/><circle cx="420" cy="46" r="3"/>
    <circle cx="197.5" cy="133" r="3"/><circle cx="252.5" cy="133" r="3"/><circle cx="307.5" cy="133" r="3"/><circle cx="362.5" cy="133" r="3"/>
  </g>
  <g font-size="13" font-weight="600" text-anchor="middle" style="font-family: var(--font-mono)">
    <text x="270" y="35">100</text><text x="330" y="35">200</text><text x="390" y="35">300</text>
    <text x="225" y="122">120</text><text x="280" y="122">150</text><text x="335" y="122">180</text>
  </g>
  <g font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">
    <text x="85" y="121">keys &lt; 100</text><text x="460" y="121">keys 200–299</text><text x="572.5" y="121">keys ≥ 300</text>
  </g>
  <text x="170" y="94" font-size="12" style="fill: var(--viz-muted)">keys 100–199</text>
  <g style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)">
    <rect x="20" y="182" width="135" height="46" rx="6"/><rect x="175" y="182" width="135" height="46" rx="6"/>
    <rect x="330" y="182" width="135" height="46" rx="6"/><rect x="485" y="182" width="135" height="46" rx="6"/>
  </g>
  <g font-size="12" style="font-family: var(--font-mono)">
    <text x="34" y="201">104 → row</text><text x="34" y="219">117 → row</text>
    <text x="189" y="201">120 → row</text><text x="189" y="219">142 → row</text>
    <text x="344" y="201">150 → row</text><text x="344" y="219">163 → row</text>
    <text x="499" y="201">180 → row</text><text x="499" y="219">191 → row</text>
  </g>
  <g stroke-width="1.5" stroke-dasharray="3 2" style="stroke: var(--viz-c2)">
    <line x1="155" y1="205" x2="172" y2="205" marker-end="url(#c3d-bt-c2)"/>
    <line x1="310" y1="205" x2="327" y2="205" marker-end="url(#c3d-bt-c2)"/>
    <line x1="465" y1="205" x2="482" y2="205" marker-end="url(#c3d-bt-c2)"/>
  </g>
  <text x="320" y="248" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">leaves are linked, so a range scan descends once and then walks sideways</text>
</svg>`,
          caption: `Internal pages (violet) hold only separator keys; each reference between two keys covers exactly that range. Rows, or references to them, live only in the leaves (cyan). Real pages hold hundreds of keys, so 3–4 levels like these cover most databases.`,
        },
        {
          type: "text",
          html: `<h3>Why three or four levels are enough</h3>
<p>To look up a key, start at the root, find the two keys that bracket the one you want, follow the reference between them, and repeat until you reach a leaf. The cost is the tree's <strong>depth</strong>: O(log n), but with a base of several hundred instead of 2. That huge base is the whole trick.</p>
<p>Take 4 KB pages and a branching factor of 500. One level addresses 500 pages, two levels 250,000, three 125 million and four 62.5 billion: 500<sup>4</sup> pages × 4 KB ≈ <strong>256 TB</strong>. Most databases fit in three or four levels. Better still, the top levels are tiny (the root plus 500 internal pages is about 2 MB) and are read by almost every lookup, so they stay cached. A lookup in an index of terabytes typically costs one or two actual disk reads.</p>`,
        },
        {
          type: "viz",
          id: "ch3/btree",
          title: "B-tree lookups and page splits",
          caption: "Try Insert with the default key 75, which fits, then set the key to 47 and insert again: its leaf is full, so it splits, the root overflows too, and a new root appears on top. Then try Lookup and Range scan 20–60. Notice that every leaf stays at the same depth, that one insert can write several pages (the Write cost stat), and in the At real scale panel how four levels of 500-way pages reach 256 TB.",
        },
        {
          type: "text",
          html: `<h3>Updates, inserts and page splits</h3>
<p>An update to an existing key is the easy case: descend to its leaf, edit the value inside that page, and write the page back over its old copy at the <strong>same location</strong> on disk. Every reference to that page stays valid, which is what lets a B-tree update in place.</p>
<p>Inserting a new key means finding the leaf whose range covers it and adding the key there. If the page has no room, it <strong>splits</strong> into two half-full pages, and the parent gets a new key and reference to separate them. The parent may now be full too and split in turn, all the way up. When the root itself splits, a new root is created above the two halves, and that is the only way the tree gets taller. So <strong>every leaf is always at the same depth</strong>: the tree stays balanced by construction, and with n keys its depth is always O(log n). One precise detail: a leaf split <em>copies</em> the right half's first key into the parent (the key stays in its leaf), while an internal split <em>moves</em> its middle key up.</p>
<h3>B+trees, layout and free space</h3>
<p>Most databases actually implement the <strong>B+tree</strong> variant, though everyone just says "B-tree". Internal pages hold only separator keys, all values or row references live in the leaves, and each leaf links to its neighbor, so a range scan descends once and then walks sideways without going back up. (SQLite, for one, stores tables as B+trees but indexes as plain B-trees.)</p>
<p>Many implementations try to keep leaves in key order on disk so range scans read sequentially, but splits put new pages wherever there is free space, so the order degrades as the tree grows: the index <strong>fragments</strong>. LSM-trees rewrite large segments during compaction, which makes it easier for them to keep sorted data contiguous.</p>
<p>Splits also leave pages partly empty. Under random insertions, B-tree pages end up about 69% full on average (ln 2, from Andrew Yao's 1978 analysis). InnoDB deliberately leaves about 1/16 of each page free; its manual says sequential inserts leave pages about 15/16 full, random ones anywhere from half to 15/16.</p>
<p>Variants keep appearing: <strong>fractal trees</strong> borrow log-structured ideas, buffering changes in internal pages, to cut disk seeks. And B-trees are not just a relational thing: WiredTiger, MongoDB's default engine since version 3.2 (2015), stores collections and indexes as B-trees. One consequence sets up the next section: an insert that splits a page writes three or more pages, and if the machine crashes partway through, the tree on disk is broken.</p>`,
        },
        {
          type: "callout",
          tone: "mistake",
          title: "Random UUIDs as a clustered primary key",
          html: `<p>When a table is clustered on its primary key (as in InnoDB, or a SQL Server clustered index), the key decides where each row physically lives. Random keys such as <strong>UUIDv4</strong> land all over the tree, so each insert touches a different leaf: splits happen everywhere, pages end up half empty, the index grows larger than it needs to and the pages being written no longer fit in the cache. Sequential or time-ordered keys (auto-increment, or <strong>UUIDv7</strong> from RFC 9562, 2024) send new rows to the right edge of the tree, where the same few hot pages absorb them. If you need globally unique ids, prefer a time-ordered format.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "PostgreSQL",
              tag: "nbtree",
              html: `The default index type is a B+tree variant based on Lehman and Yao's 1981 <strong>B-link tree</strong>, designed so that readers don't block while pages split. Pages are 8 KB. PostgreSQL 13 (2020) added B-tree <strong>deduplication</strong>, which stores repeated keys once.`,
            },
            {
              org: "MySQL InnoDB",
              tag: "clustered B+tree",
              html: `Every InnoDB table is a B+tree clustered on its primary key, with 16 KB pages by default (<code>innodb_page_size</code> can be set from 4 KB to 64 KB when the instance is created). Its secondary indexes store the primary key rather than a row location, a design the second half of the chapter returns to.`,
            },
            {
              org: "SQLite",
              tag: "one file, many trees",
              html: `A SQLite database is a single file holding one B-tree per table and per index (tables are B+trees keyed by rowid). The default page size has been 4096 bytes since version 3.12.0 (2016).`,
            },
            {
              org: "UUIDv7",
              year: "2024",
              tag: "RFC 9562",
              html: `RFC 9562 standardized UUID version 7, whose leading bits are a Unix timestamp in milliseconds, so new ids sort roughly by creation time. The RFC motivates it with better database index locality than random UUIDv4.`,
            },
          ],
        },
        {
          type: "tradeoffs",
          prosLabel: "What B-trees are good at",
          consLabel: "What they cost",
          pros: [
            "Predictable reads: one page per level, 3–4 levels for almost any database, with the top levels cached.",
            "Each key lives in exactly one place, so in-place updates and range locks are straightforward.",
            "Efficient range scans: descend once, then follow the leaf links.",
            "No background compaction competing for I/O; costs are paid inline, so latency is steady.",
            "Decades of tuning, tooling and operational experience in every major database.",
          ],
          cons: [
            "Every change rewrites a whole 4–16 KB page, even for a few bytes, plus a log record.",
            "Updates land on pages scattered across the disk: random writes.",
            "Splits leave pages partly empty (about 69% full under random inserts) and fragment the leaf order.",
            "Multi-page changes need a write-ahead log and latches to be crash-safe and concurrent.",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Expect "why do database indexes use B-trees rather than binary trees or hash tables?". The strong answer is arithmetic: a page holds hundreds of keys, so the depth is log base 500, not log base 2; four levels address hundreds of terabytes; the top levels are cached, so a lookup costs one or two disk reads. Against a hash index: B-trees support range scans and don't need all keys in memory. Then explain splits (the tree grows at the root, every leaf stays at the same depth) and their costs: whole-page rewrites, half-empty pages, fragmentation. A frequent follow-up is the random-UUID primary key; mention time-ordered ids such as UUIDv7.</p>`,
        },
        {
          type: "quiz",
          q: "A B-tree index uses 8 KB pages with a branching factor of about 400. The table grows from 1 million rows to 1 billion. How does the cost of a point lookup change?",
          options: [
            "It goes from about 3 page reads to about 4, and the upper levels are usually cached",
            "It grows about 1000×, in line with the data",
            "It doesn't change at all, because B-tree lookups are O(1)",
            "It grows from about 20 to about 30 page reads (log₂ of the row count)",
          ],
          answer: 0,
          explain: `With 400 children per page, three levels address 400³ = 64 million entries, so 1 million rows need 3 levels; four levels address 400⁴ ≈ 25.6 billion, so 1 billion rows need 4. One extra level for 1000× the data. Option D is the tempting one: log base 2 is right for a binary tree, not for a page with hundreds of children. And the cost does grow, slowly, so C is wrong too.`,
        },
      ],
    },
    // ------------------------------------------------------------------
    {
      id: "write-ahead-log",
      title: "Crash in the middle of a page split: the write-ahead log",
      kicker: "Reliability",
      concepts: ["write-ahead-log-redo-log", "torn-page", "copy-on-write-btree"],
      blocks: [
        {
          type: "problem",
          html: `<p>A B-tree overwrites pages in place, and a single insert can change several of them: a split rewrites the old leaf, creates a new leaf and updates the parent. The disk receives those pages one at a time, in whatever order the buffer manager and the operating system choose. If the power fails between them, the tree on disk is inconsistent: the parent may still route keys to a leaf that has lost half its contents, or a new page may hold keys that no parent points to.</p>
<p>The keys lost this way aren't only the one being inserted. They can be <strong>old, long-committed data</strong> that happened to share the page. And even a single page write can be cut off halfway. Without extra machinery, every crash risks silent corruption.</p>`,
        },
        {
          type: "idea",
          html: `<p>Before changing any page on disk, <strong>append a record describing the change to a log</strong> and make it durable. After a crash, <strong>redo</strong> the log to finish every change it describes. A multi-page update becomes all-or-nothing: either its log record is on disk and recovery completes it, or it isn't, and as far as anyone was told, the change never happened.</p>`,
        },
        {
          type: "text",
          html: `<h3>Why overwriting in place is dangerous</h3>
<p>Overwriting a page is a physical act. On a spinning disk, the head moves to the right track, waits for the sector to rotate underneath it and writes over the old bytes. On an SSD it is more involved: flash must erase large blocks before rewriting them, so the firmware quietly writes the new page somewhere else and remaps the address. Either way, the B-tree assumes that after an overwrite the page is still found under the same page number, so every reference to it stays valid. The danger is in operations that need several such writes:</p>
<ul>
<li><strong>Multi-page changes.</strong> A split writes two child pages and the parent. A crash after only some of them leaves a parent pointing at the wrong contents, or an <strong>orphan page</strong> that nothing references.</li>
<li><strong>Torn pages.</strong> A database page (8 or 16 KB) is bigger than the unit the hardware writes atomically (a 512-byte or 4 KB sector), so even one page write can end up part old, part new. PostgreSQL defends against this by writing a <strong>full page image</strong> into its log the first time a page is modified after each checkpoint (<code>full_page_writes</code>); InnoDB writes every page first to a <strong>doublewrite buffer</strong> and only then to its real location. Page checksums let the engine detect a damaged page.</li>
</ul>`,
        },
        {
          type: "viz",
          id: "ch3/wal-crash",
          title: "Crash mid-split: with and without a WAL",
          caption: "Try Play with the write-ahead log Off: the power fails after the first page write of a split, and key 50, committed long before, becomes unreachable. Switch Power fails after to 2 pages written to see an orphan page. Then turn the log On and play again. Notice that the client hears OK only once the log record is durable, and that recovery redoes only the pages whose LSN is older than the record. (The viz logs one record for the whole split; real engines log each page change plus a commit record.)",
        },
        {
          type: "text",
          html: `<p>Note what would <em>not</em> help in the WAL-off run: fsyncing each page. That makes each page durable, but the crash still falls in the gap between them. The fix has to make the <em>group</em> of writes atomic, which is what a log does.</p>
<h3>The write-ahead log protocol</h3>
<p>A <strong>write-ahead log</strong> (WAL, also called a redo log) is an append-only file of records, each describing a change to one or more pages. The protocol has two rules:</p>
<ol>
<li><strong>Log before data.</strong> A modified page may not be written to its place on disk until the log record describing that change is durable.</li>
<li><strong>Commit after log.</strong> A transaction is committed, and the client may be told so, only once its log records, including a commit record, have been forced to stable storage with <code>fsync</code>.</li>
</ol>
<p>Dirty pages are then written back lazily, whenever the buffer manager likes and in any order. After a crash, recovery reads the log from the last checkpoint and <strong>redoes</strong> every logged change that hasn't reached its page.</p>
<p>How does it know? Every log record gets a <strong>log sequence number</strong> (LSN), and every page stores the LSN of the last change applied to it. If a page's LSN is already at or past a record's LSN, the change is in the page and redo skips it. This makes redo <strong>idempotent</strong>: replaying a record twice has the same effect as once, so a crash during recovery is harmless; recovery just runs again.</p>
<p>Two refinements keep the log practical. A <strong>checkpoint</strong> flushes dirty pages and records how far the log has been applied, which bounds recovery time and lets older log segments be recycled. <strong>Group commit</strong> lets many concurrent transactions share one fsync, since an fsync costs about the same whether it covers one commit record or a hundred.</p>`,
        },
        {
          type: "diagram",
          title: "The life of one logged change",
          svg: `<svg viewBox="0 0 640 184" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Timeline: append log record LSN 100, fsync the log, acknowledge the client, then later write dirty pages in any order, take a checkpoint and recycle old log. A crash after the acknowledgement is repaired by redoing LSN 100 from the log.">
  <defs>
    <marker id="c3d-wal-ax" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <g font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">
    <text x="152" y="18">before the client hears OK</text><text x="488" y="18">later, in the background</text>
  </g>
  <g style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)">
    <rect x="10" y="28" width="92" height="46" rx="6"/><rect x="106" y="28" width="92" height="46" rx="6"/><rect x="538" y="28" width="92" height="46" rx="6"/>
  </g>
  <rect x="202" y="28" width="92" height="46" rx="6" stroke-width="2" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <g style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)">
    <rect x="346" y="28" width="92" height="46" rx="6"/><rect x="442" y="28" width="92" height="46" rx="6"/>
  </g>
  <g font-size="12" font-weight="600" text-anchor="middle">
    <text x="56" y="47">1 append</text><text x="152" y="47">2 fsync</text><text x="248" y="47">3 ack client</text>
    <text x="392" y="47">4 write pages</text><text x="488" y="47">5 checkpoint</text><text x="584" y="47">6 recycle</text>
  </g>
  <g font-size="12" text-anchor="middle">
    <text x="56" y="64" style="font-family: var(--font-mono)">LSN 100</text><text x="152" y="64">the log</text><text x="248" y="64">committed</text>
    <text x="392" y="64">any order</text><text x="488" y="64">pages flushed</text><text x="584" y="64">old log</text>
  </g>
  <g stroke-dasharray="2 3" style="stroke: var(--viz-line)">
    <line x1="56" y1="74" x2="56" y2="106"/><line x1="152" y1="74" x2="152" y2="106"/><line x1="248" y1="74" x2="248" y2="106"/>
    <line x1="392" y1="74" x2="392" y2="106"/><line x1="488" y1="74" x2="488" y2="106"/><line x1="584" y1="74" x2="584" y2="106"/>
  </g>
  <line x1="10" y1="110" x2="628" y2="110" stroke-width="1.5" marker-end="url(#c3d-wal-ax)" style="stroke: var(--viz-muted)"/>
  <circle cx="56" cy="110" r="4" style="fill: var(--viz-c5)"/><circle cx="152" cy="110" r="4" style="fill: var(--viz-c5)"/>
  <circle cx="248" cy="110" r="4" style="fill: var(--viz-ok)"/><circle cx="392" cy="110" r="4" style="fill: var(--viz-c2)"/>
  <circle cx="488" cy="110" r="4" style="fill: var(--viz-c2)"/><circle cx="584" cy="110" r="4" style="fill: var(--viz-c5)"/>
  <path d="M326,80 L312,104 L321,104 L310,130 L334,98 L324,98 L332,80 Z" style="fill: var(--viz-bad)"/>
  <text x="628" y="128" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">time →</text>
  <text x="320" y="152" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">crash here: pages may be stale or half-written, but LSN 100 is durable, so redo it</text>
  <text x="320" y="172" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">crash before step 2 completes: the client never heard OK, so nothing promised is lost</text>
</svg>`,
          caption: `Steps 1–3 are on the commit path and cost one sequential log write plus one fsync. Steps 4–6 happen whenever convenient. Wherever the crash falls, the log is enough to finish every acknowledged change.`,
        },
        {
          type: "text",
          html: `<h3>Concurrency: latches</h3>
<p>Crashes aren't the only hazard. When many threads read and modify the same in-memory pages, a reader could see a page halfway through a split. B-trees protect their pages with <strong>latches</strong>: lightweight locks on the data structure itself, held for microseconds and unrelated to the transaction locks of Chapter 7. Log-structured engines avoid most of this: they merge files in the background without touching the ones queries are reading, then atomically swap in the result.</p>
<h3>The alternative: never overwrite</h3>
<p>A <strong>copy-on-write B-tree</strong>, used by LMDB and the btrfs file system, needs no WAL because it never overwrites a live page. To modify a leaf, it writes a changed copy of the leaf somewhere new, then new copies of each ancestor up to the root, each pointing at its new child. Finally it switches a single root pointer to the new root in one atomic write. A crash before the switch leaves the old tree intact; a crash after it leaves the new one. As a bonus, a reader that started from the old root keeps seeing a complete, consistent snapshot, exactly what snapshot isolation needs (Chapter 7).</p>`,
        },
        {
          type: "diagram",
          title: "Copy-on-write: change a leaf without overwriting anything",
          svg: `<svg viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="The root pointer switches from old root R1 to new root R2. R2 shares unchanged leaves A and B with R1 and points to a new copy of the modified leaf; the old leaf stays for readers still using R1.">
  <defs>
    <marker id="c3d-cow-ok" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ok)"/></marker>
    <marker id="c3d-cow-mu" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <rect x="250" y="10" width="140" height="30" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="320" y="30" font-size="13" font-weight="600" text-anchor="middle">root pointer</text>
  <line x1="360" y1="40" x2="497" y2="68" stroke-width="2" marker-end="url(#c3d-cow-ok)" style="stroke: var(--viz-ok)"/>
  <line x1="280" y1="40" x2="143" y2="68" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#c3d-cow-mu)" style="stroke: var(--viz-muted)"/>
  <text x="446" y="48" font-size="12" style="fill: var(--viz-ok)">after: one atomic write</text>
  <text x="194" y="48" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">before</text>
  <g stroke-width="1.5" stroke-dasharray="5 4" style="stroke: var(--viz-muted)">
    <line x1="125" y1="104" x2="75" y2="156"/><line x1="125" y1="104" x2="240" y2="156"/><line x1="125" y1="104" x2="400" y2="156"/>
  </g>
  <g stroke-width="1.5" style="stroke: var(--viz-ok)">
    <line x1="515" y1="104" x2="240" y2="156"/><line x1="515" y1="104" x2="400" y2="156"/><line x1="515" y1="104" x2="565" y2="156"/>
  </g>
  <rect x="75" y="70" width="100" height="34" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <rect x="465" y="70" width="100" height="34" rx="6" stroke-width="2" style="fill: var(--viz-c1-soft); stroke: var(--viz-ok)"/>
  <rect x="20" y="156" width="110" height="34" rx="6" style="fill: var(--viz-grid); stroke: var(--viz-line)"/>
  <g style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)">
    <rect x="185" y="156" width="110" height="34" rx="6"/><rect x="345" y="156" width="110" height="34" rx="6"/>
  </g>
  <rect x="510" y="156" width="110" height="34" rx="6" stroke-width="2" style="fill: var(--viz-c2-soft); stroke: var(--viz-ok)"/>
  <g font-size="13" text-anchor="middle">
    <text x="125" y="92">R1 (old root)</text><text x="515" y="92">R2 (new root)</text>
    <text x="75" y="177" style="fill: var(--viz-muted)">old leaf</text><text x="240" y="177">leaf A</text><text x="400" y="177">leaf B</text><text x="565" y="177">new leaf copy</text>
  </g>
  <text x="20" y="208" font-size="12" style="fill: var(--viz-muted)">kept for old readers</text>
  <text x="320" y="208" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">shared by both trees, unchanged</text>
  <text x="565" y="208" font-size="12" text-anchor="middle" style="fill: var(--viz-ok)">written to a new place</text>
</svg>`,
          caption: `To change one leaf, write a new copy of it and of every page on the path to the root, then flip the root pointer in one atomic write. Readers still holding R1 see a complete, consistent old tree; once none remain, the old pages are freed.`,
        },
        {
          type: "text",
          html: `<p>SQLite shows both approaches in one product. Its classic <strong>rollback journal</strong> saves the original contents of each page before changing it, so an interrupted change can be undone. Since version 3.7.0 (2010) it also offers a <strong>WAL mode</strong>, which appends changes to a log and copies them into the database file at checkpoints.</p>
<p>Log-structured engines need a WAL too, for the memtable, and the rule is the same: the log record is durable before the write is acknowledged. And the log keeps proving useful beyond recovery. Shipping it to other machines is how many databases replicate (Chapter 5); reading it is how change data capture works (Chapter 11); and archiving it next to a base backup gives point-in-time recovery.</p>`,
        },
        {
          type: "callout",
          tone: "history",
          title: "ARIES, 1992",
          html: `<p>The classic recovery algorithm is <strong>ARIES</strong>, published by C. Mohan and colleagues at IBM in 1992. After a crash it first <em>repeats history</em>, redoing every logged change, including those of transactions that never committed, and then <em>undoes</em> the uncommitted transactions using undo information in the log. Its ideas underlie the recovery code of many databases. Undo matters for transactions and returns in Chapter 7; this chapter only needs redo.</p>`,
        },
        {
          type: "callout",
          tone: "warning",
          title: "fsync has to mean durable",
          html: `<p>The whole protocol rests on one assumption: when <code>fsync</code> returns success, the data is on stable storage. In 2018 PostgreSQL developers found that on Linux this could fail in a nasty way: after a failed writeback, the kernel could drop the dirty pages and clear the error, so a <em>retried</em> fsync reported success although the data never reached the disk. PostgreSQL's response to "fsyncgate" was to stop retrying: an fsync failure now makes the server panic and recover from the WAL, which is still trustworthy. Durability is only as strong as the weakest layer underneath: kernel, drive cache and firmware included.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "PostgreSQL",
              tag: "WAL + full page writes",
              html: `Every change goes through the WAL before data files are modified. With <code>full_page_writes</code> (on by default), the first change to each page after a checkpoint logs a full image of the page, which protects against torn pages. The same WAL feeds streaming replication and point-in-time recovery.`,
            },
            {
              org: "MySQL InnoDB",
              tag: "redo log + doublewrite",
              html: `InnoDB pairs a redo log with a <strong>doublewrite buffer</strong>: pages are written to the doublewrite area first and only then to their real location, so a torn page can be restored from an intact copy during recovery.`,
            },
            {
              org: "LMDB",
              tag: "copy-on-write B+tree",
              html: `LMDB (Lightning Memory-Mapped Database, used by OpenLDAP) never overwrites live pages, so it needs no WAL and no recovery step after a crash, and readers see a consistent snapshot without blocking the writer.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"How does a database survive a crash in the middle of a write?" A strong answer states both WAL rules precisely (no page reaches disk before its log record; acknowledge only after the commit record is fsynced), explains that pages are flushed lazily and recovery redoes from the last checkpoint, and names LSNs as what makes redo idempotent. Good candidates add torn pages (full-page images, doublewrite) and group commit for throughput. Strong ones connect outward: the same log drives replication and change data capture, LSM engines use a WAL for the memtable, and copy-on-write B-trees (LMDB) are the WAL-free alternative. The weak answer is "fsync every page", which makes each page durable but leaves the gap between them.</p>`,
        },
        {
          type: "quiz",
          q: "Which ordering makes a B-tree insert that splits a page crash-safe?",
          options: [
            "Write the modified pages to disk, then append a record to the WAL",
            "Write each modified page with its own fsync, in order; then no WAL is needed",
            "Acknowledge the client first, then write the WAL record and the pages in the background",
            "Append a WAL record describing the change and fsync it, then acknowledge; write the pages back later",
          ],
          answer: 3,
          explain: `The log must be durable before any page changes on disk and before the client is told "committed"; then recovery can always redo the whole change. Option B is the tempting one: an fsync per page makes each page durable, but a crash between the second and third page write still leaves the tree inconsistent, because nothing makes the group of writes atomic. A breaks "log before data", and C breaks "commit after log": a crash right after the acknowledgement loses a write the client was promised.`,
        },
      ],
    },
  ],
});
