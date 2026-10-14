// Chapter 4: Encoding and Evolution
// Authoring guide: docs/AUTHORING.md
DDIA.registerChapter({
  id: "ch4",
  part: 1,
  number: 4,
  title: "Encoding and Evolution",
  tagline: "Data outlives the code that wrote it: encode it so old and new versions can keep reading each other's bytes.",
  overview: `<p>Whenever data leaves a process (written to a file or database, sent over the network, put on a queue, cached), it has to be turned into bytes, and those bytes are later read by code that may be <strong>older or newer</strong> than the code that wrote them. This chapter compares the ways of doing that: built-in language serialization, textual formats (JSON, XML, CSV), and schema-driven binary formats (Thrift, Protocol Buffers, Avro). It judges them on size, speed, cross-language support and safety, and above all on <strong>evolvability</strong>: how well they let the data's shape change over time.</p>
<p>The central tension is that you want to change code continuously, but you can never change everything at once. Servers are upgraded a few at a time, mobile apps update months later or never, and stored records stay in the shape they were written in for years. So old and new versions always coexist, and you need both <strong>backward compatibility</strong> (new code reads old data) and <strong>forward compatibility</strong> (old code reads new data, without destroying the parts it doesn't understand). A second trade-off runs through the formats: the more the bytes leave out (first field names, then even tags), the smaller they get and the more the reader depends on having exactly the right schema.</p>
<p>The ideas build on each other. <a href="#/ch4/learn/why-encoding">Rolling upgrades and rollbacks</a> make compatibility in both directions a requirement. <a href="#/ch4/learn/language-specific-formats">Language-specific formats</a> fail it, along with being insecure, and <a href="#/ch4/learn/textual-formats">JSON and friends</a> fix portability but are vague about numbers and bulky. A schema lets the bytes drop field names: <a href="#/ch4/learn/thrift-protobuf">Thrift and Protobuf</a> use numeric tags, which brings its own <a href="#/ch4/learn/field-tags-evolution">rules for evolution</a>, while <a href="#/ch4/learn/avro">Avro</a> drops tags too and resolves a writer's schema against a reader's by name. <a href="#/ch4/learn/merits-of-schemas">Schema registries</a> turn compatibility into an automated check. The chapter then applies all of this to the three ways data flows: <a href="#/ch4/learn/dataflow-databases">through databases</a> (data outlives code; preserve unknown fields; expand/contract), <a href="#/ch4/learn/dataflow-services">through services</a> (servers upgrade first; versioning for clients you can't upgrade; why a remote call isn't a local one), and <a href="#/ch4/learn/dataflow-messages">through message brokers and actors</a>.</p>`,

  // ------------------------------------------------------------------
  // CONCEPTS (teaching order, grouped by deep-dive section)
  // ------------------------------------------------------------------
  concepts: [
    // --- why-encoding ---
    {
      id: "encoding-serialization",
      term: "Encoding / serialization",
      def: `Translating data between two representations: the <strong>in-memory</strong> form (objects, structs, lists, hash maps and trees linked by pointers, optimized for CPU access) and a <strong>self-contained sequence of bytes</strong> that another process, another machine or a future run of the same program can understand. Encoding is also called serialization or marshalling; the reverse is decoding, parsing, deserialization or unmarshalling. This "serialization" has nothing to do with <a href="#/ch7/learn/serial-execution">serializable isolation</a> in transactions (ch7), which is why the book prefers "encoding".`,
      problem: `In-memory objects are webs of pointers that mean nothing outside the process that created them. Storing data or sending it anywhere needs a form that stands on its own.`,
      why: `Every process boundary is an encoding boundary: writing a file or a database row, sending a request, publishing to a queue, putting a value in a cache. The format you choose there decides six things at once: whether old and new code can read each other's bytes (compatibility in both directions), which languages can read them, how big they are, how fast they encode and decode, whether a human can read them, and whether decoding untrusted input is safe. Once data is stored or other teams depend on it, the format is very hard to change, so it is an architecture decision, not a library detail.`,
      ex: `A Python service calls <code>json.dumps</code> on a dict and stores it in Redis; a Go service calls <code>proto.Marshal</code> on a struct and sends it as a gRPC request; a Java producer encodes an Avro record and publishes it to Kafka. All three sets of bytes will later be read by code running a different version.`,
      section: "why-encoding",
    },
    {
      id: "rolling-upgrade",
      term: "Rolling upgrade",
      def: `Deploying a new version to a few nodes at a time, checking their health, then continuing, so the service never goes down (also called a staged rollout; a canary release is a variant that starts with a small slice of traffic). For a while old and new versions run side by side and read each other's data.`,
      problem: `Stopping every server to upgrade at once means downtime and big-bang risk. Rolling upgrades remove both, but they make mixed versions the normal state, which is why encodings need backward and forward compatibility.`,
      why: `Rolling upgrades mean no downtime, and they make frequent small releases cheap: a bad release is caught on a few nodes and rolled back early. The price is that <strong>mixed versions are the normal state</strong>: servers for minutes or hours, client apps for months or years (some users never update), stored data for as long as it is kept. Every pair of versions that can coexist must be able to read each other's data in both directions. A rollback brings back old code but never old data, so old code then meets whatever the new code already wrote.`,
      ex: `A Kubernetes Deployment's default strategy is <code>RollingUpdate</code> with <code>maxSurge: 25%</code> and <code>maxUnavailable: 25%</code>, so old and new pods serve traffic together during every routine deploy. Mixed versions can be catastrophic: at Knight Capital in August 2012, new trading code reached 7 of 8 servers, the eighth gave a repurposed flag its old meaning and reactivated retired "Power Peg" code, and the firm lost more than $440 million in about 45 minutes.`,
      section: "why-encoding",
    },
    {
      id: "backward-compatibility",
      term: "Backward compatibility",
      def: `<strong>Newer code can read data written by older code.</strong> Example: v2 adds an optional <code>photo_url</code> field; when v2 reads a record written by v1, it finds no value and fills in the default.`,
      problem: `New code must handle the data that is already stored and the requests from clients that haven't upgraded yet.`,
      why: `This is usually the easier direction, because whoever writes the new code knows the old format and can handle it explicitly (defaults, fallback reads). It is what lets you ship a new reader without first rewriting every stored record. Mnemonic: new code looks <em>back</em> at old data. Typical ways to break it: adding a required field (old records can't contain it), adding an Avro field without a default, or changing a field's type in a way the reader can't convert.`,
      ex: `PostgreSQL 11+ records a non-volatile <code>ADD COLUMN ... DEFAULT</code> in the catalog and returns that default for old rows without rewriting the table. Confluent Schema Registry's default mode, BACKWARD, checks exactly this direction: can the new schema read data written with the previous one?`,
      section: "why-encoding",
    },
    {
      id: "forward-compatibility",
      term: "Forward compatibility",
      def: `<strong>Older code can read data written by newer code</strong>, typically by ignoring fields and values it doesn't know, and ideally by preserving them so they survive if the old code writes the record back.`,
      problem: `During rolling upgrades and after rollbacks, old code meets data from newer code that it couldn't have anticipated.`,
      why: `Needed whenever some nodes already run the new version and write new-format data that not-yet-upgraded (or rolled-back) nodes must read, ideally preserving the fields they don't understand. It is the harder direction: the old code was written before the change existed, so it can only cope generically, by skipping unknown tags using their wire type, ignoring unknown JSON properties, or treating unknown enum values as "unknown". Ignoring is not enough if old code decodes a record into its own model and saves it whole; then it must carry the unknown fields along or it deletes them. Mnemonic: old code copes with data from the <em>future</em>.`,
      ex: `A Protobuf v1 reader that meets tag 4 reads its wire type (LEN), skips that many bytes and keeps them as an unknown field, which it re-emits when it serializes the message. A Java client using Jackson's defaults is <em>not</em> forward compatible: <code>FAIL_ON_UNKNOWN_PROPERTIES</code> is on, so one new response field makes it throw <code>UnrecognizedPropertyException</code>.`,
      section: "why-encoding",
    },

    // --- language-specific-formats ---
    {
      id: "language-specific-encoding",
      term: "Language-specific encoding",
      def: `Serialization built into a language or its ecosystem: Java's <code>java.io.Serializable</code>, Python's <code>pickle</code>, Ruby's <code>Marshal</code>, and third-party libraries such as Kryo for Java. One call turns an arbitrary object graph (cycles included) into bytes. To rebuild it, <strong>the decoder instantiates whatever classes the byte stream names</strong>.`,
      problem: `Developers wanted zero-effort persistence of arbitrary objects. The convenience came with language lock-in, remote-code-execution risk, brittle versioning and bloat.`,
      why: `Four problems, in rising order of danger. <strong>Lock-in</strong>: the bytes encode one language's classes, often one library version's, so other languages and other organizations can't read them. <strong>Versioning</strong> is an afterthought: a changed <code>serialVersionUID</code> raises <code>InvalidClassException</code>, and renaming or moving a class can make old data unreadable. <strong>Efficiency</strong>: Java's built-in format embeds class descriptors and is notoriously bulky and slow. <strong>Security</strong>: because decoding instantiates the classes named in the input, attacker-controlled bytes can pick classes whose deserialization hooks (Java's <code>readObject</code>, or <code>hashCode</code> while a HashMap is being rebuilt; Python's <code>__reduce__</code>) chain together into remote code execution. These "gadget chains" are built from ordinary libraries on the classpath, so no bug in your own code is needed, and a type check after decoding comes too late. Use these formats only for transient, trusted, same-language data.`,
      ex: `Frohoff and Lawrence's "Marshalling Pickles" talk (2015) and their ysoserial tool demonstrated Java gadget chains; in November 2015 FoxGlove Security published working exploits for WebLogic, WebSphere, JBoss, Jenkins and OpenNMS via Apache Commons Collections. Python's documentation warns that pickle is not secure. Java never removed serialization; it added deserialization filters instead (JEP 290 in JDK 9, backported to 8u121). The same risk reached machine learning: Hugging Face created the data-only safetensors format, and PyTorch 2.6 made <code>torch.load</code> default to <code>weights_only=True</code>.`,
      section: "language-specific-formats",
    },

    // --- textual-formats ---
    {
      id: "json-xml-csv",
      term: "JSON, XML, CSV",
      def: `Textual formats that every language can parse and humans can read, with weak typing. <strong>XML and CSV can't tell the number 1337 from the string "1337"</strong> without an external schema. JSON separates strings from numbers but has no integer/float distinction and leaves precision to parsers, so integers above 2^53 lose precision in JavaScript. None of them can carry raw bytes, so binary data is Base64-encoded (+33%). Schemas (XML Schema, JSON Schema) are optional and complex; CSV has no schema at all, and its escaping rules (RFC 4180) are inconsistently implemented.`,
      problem: `Language-specific formats locked data into one language. Organizations needed formats that any language, and any human, could read.`,
      why: `They won because they're readable and universal. For data interchange between organizations, getting everyone to agree on any format is the hard part, and these are good enough. Their weaknesses are traps rather than blockers: the meaning of each field (units, number types, which strings are dates or Base64) ends up hard-coded in every consumer, and big IDs can silently change value. At high volume the verbosity and parsing cost add up: the book's example record takes 81 bytes as JSON versus 32–34 bytes in schema-driven binary formats.`,
      ex: `Twitter's v1.1 API returned every 64-bit ID twice, as a number <code>id</code> and a string <code>id_str</code>, because JavaScript rounds the number; Discord returns snowflake IDs only as strings. With no types at all, spreadsheets guess: Ziemann et al. (2016) found that roughly one in five genomics papers with Excel gene lists had gene names silently turned into dates (SEPT2 became 2-Sep), and in 2020 the HUGO committee renamed the affected genes (SEPT1 → SEPTIN1, MARCH1 → MARCHF1).`,
      section: "textual-formats",
    },
    {
      id: "binary-json-variants",
      term: "Binary JSON variants",
      def: `Binary encodings of the JSON data model: MessagePack, BSON, BJSON, UBJSON, BISON, Smile (and WBXML or Fast Infoset for XML). Some extend JSON's types: MessagePack distinguishes integers from floats and has a binary type; BSON adds dates, int32/int64, Decimal128, ObjectId and binary data. But <strong>none has a schema, so every record still spells out every field name</strong>. The book's example shrinks only from 81 bytes to 66 as MessagePack, and you lose human readability.`,
      problem: `Teams wanted to cut JSON's size and parsing cost at scale without giving up its schemaless flexibility.`,
      why: `Their limitation is the missing schema, not the type system: as long as names travel with the data, you can save on punctuation and number encoding, nothing more. Some don't even aim to be small. BSON adds length prefixes so readers can skip over fields quickly, and it can be larger than the equivalent JSON (an array stores its indexes "0", "1", ... as keys). This modest saving is exactly the observation that motivates schema-driven formats.`,
      ex: `MongoDB stores documents as BSON, with a 16 MB limit per document. Fluentd's forward protocol carries log events as MessagePack. PostgreSQL's <code>jsonb</code> (9.4, 2014) is a decomposed binary form of JSON that is slower to write than the text <code>json</code> type but faster to query, and indexable.`,
      section: "textual-formats",
    },

    // --- thrift-protobuf ---
    {
      id: "thrift-protocol-buffers",
      term: "Thrift & Protocol Buffers",
      def: `Schema-driven binary formats: <strong>Thrift</strong> (Facebook, open-sourced 2007, now an Apache project) and <strong>Protocol Buffers</strong> (Google, open-sourced 2008). You declare the schema in an interface definition language and a code generator produces classes for many languages. On the wire each field is a <strong>numeric tag</strong>, a type and a value, never a name. For the book's example record: Thrift BinaryProtocol 59 bytes, Thrift CompactProtocol 34, Protobuf 33 (JSON: 81). <code>required</code> and <code>optional</code> don't change the encoding at all; <code>required</code> is only a runtime check that the field was set.`,
      problem: `At Google and Facebook scale, bloated self-describing formats and hand-written, multi-version marshalling code were both too expensive. Google's protobuf documentation describes the index server's hand-written request code, full of version checks like "if (version == 3)".`,
      why: `Replacing names with tags and spelling integers as varints cuts the record by more than half and makes parsing cheap, and the schema doubles as a checked contract with generated, typed code. The costs: the bytes are unreadable without the schema (<code>protoc --decode_raw</code> shows only tag numbers and wire types), you need a build step, and code generation is less appealing in dynamically typed languages. One structural difference: Thrift has a real list type (element type plus count, nestable), while a Protobuf <code>repeated</code> field is the same tag appearing several times (numeric ones are packed into one length-delimited run, the default in proto3).`,
      ex: `The book's proto2 schema <code>message Person { required string user_name = 1; optional int64 favorite_number = 2; repeated string interests = 3; }</code> encodes the example as <code>0a 06 "Martin" 10 b9 0a 1a 0b "daydreaming" 1a 07 "hacking"</code>: 33 bytes. gRPC (open-sourced 2015 as the public successor to Google's internal Stubby) uses Protobuf over HTTP/2; Meta maintains its own Thrift fork, fbthrift.`,
      section: "thrift-protobuf",
    },
    {
      id: "interface-definition-language",
      term: "IDL and code generation",
      def: `A language-neutral schema file (<code>.proto</code>, <code>.thrift</code>, <code>.avdl</code>) from which tools generate classes, encoders, decoders and RPC stubs for many languages.`,
      problem: `Hand-written parsers in each language drift apart and fill up with ad hoc version checks. A single machine-readable contract keeps every implementation in sync and documents the data.`,
      why: `The schema becomes a contract that a compiler checks: every language gets identical encoders, and every change shows up as a diff that tools can judge (<code>buf breaking</code> fails CI on incompatible <code>.proto</code> edits). Generated classes give type checking and autocompletion in statically typed languages. The costs are a build step, generated code to manage, and less benefit in dynamically typed languages, which is one reason Avro makes code generation optional.`,
      ex: `<code>protoc --java_out=gen --python_out=gen person.proto</code> generates Java and Python classes from one file; a <code>service</code> block in the same file also produces gRPC client stubs and server interfaces. <code>thrift --gen go</code> does the same for Thrift, and Avro IDL (<code>.avdl</code>) compiles to JSON schemas (<code>.avsc</code>).`,
      section: "thrift-protobuf",
    },
    {
      id: "varint-zigzag",
      term: "Varint and zigzag encoding",
      def: `Variable-length integers use 7 bits per byte, with the high bit meaning "more bytes follow", so small numbers take one byte (1337 becomes <code>b9 0a</code>). <strong>Zigzag</strong> first maps signed to unsigned (0→0, −1→1, 1→2, −2→3) so small negative numbers stay small too. Protobuf also encodes each field's key, <code>(field_number &lt;&lt; 3) | wire_type</code>, as a varint.`,
      problem: `Fixed 4- or 8-byte integers waste space on values that are usually small, and plain varints of two's-complement negative numbers take 10 bytes.`,
      why: `Most integers in real data are small (counts, lengths, enum values, field keys), so variable length saves most of the space, and the same trick encodes string lengths and Protobuf keys. Zigzag matters because two's-complement negatives have their high bits set: Protobuf's plain <code>int64</code> spends 10 bytes on −1, while <code>sint64</code> zigzags it into 1 byte. Thrift's CompactProtocol and Avro zigzag all their integers. The cost is a decode loop and no fixed offsets, which is why Protobuf also offers <code>fixed32</code>/<code>fixed64</code> for values that are usually large, such as hashes.`,
      ex: `1337 is binary 101 0011 1001. Split into 7-bit groups and emitted low group first, with the continuation bit set on every byte but the last, it becomes <code>b9 0a</code>. Zigzag maps 1337 to 2674, which encodes as <code>f2 14</code> in Avro and Thrift Compact. Protobuf's key byte <code>0x0a</code> is field 1, wire type 2 (length-delimited).`,
      section: "thrift-protobuf",
    },

    // --- field-tags-evolution ---
    {
      id: "field-tags",
      term: "Field tags",
      def: `The number assigned to each field in a Thrift or Protobuf schema (<code>user_name = 1</code>). It is the field's <strong>identity on the wire</strong>; names never appear in the binary encoding. Old code skips a tag it doesn't know (the wire type tells it how many bytes to skip), and new code uses the default when a tag it expects is missing.`,
      problem: `Field names are bulky, and renaming one would break stored data. Small numbers make encodings compact and give each field a stable identity.`,
      why: `Tags make evolution mechanical. Add fields with new tag numbers, as optional. Remove only optional fields, and reserve their numbers and names (<code>reserved 2; reserved "favorite_number";</code>) so nobody reuses them: a reused tag with the same wire type silently decodes old data into the new field and new data into the old one. Renaming is free on the wire, but it breaks Protobuf's JSON mapping and text format (which use names) and any code that refers to the old name. Changing a tag number amounts to deleting a field and adding another. Enum numbers follow the same never-reuse rule. Give frequent fields numbers 1–15, which fit in a one-byte key.`,
      ex: `<code>buf breaking --against '.git#branch=main'</code> fails a pull request that deletes a field without reserving it, or changes a field's number or type. Knight Capital's 2012 loss is the operational twin of tag reuse: a repurposed flag meant something different to the one server still running old code.`,
      section: "field-tags-evolution",
    },

    // --- avro ---
    {
      id: "avro",
      term: "Avro",
      def: `A binary format started in 2009 by Doug Cutting as a Hadoop subproject. Schemas are written in Avro IDL (for humans) or JSON (for machines). The encoding contains <strong>no field tags and no type markers</strong>, just values one after another in the writer's schema order: length-prefixed strings, zigzag-varint integers, a branch index for unions. That makes it the most compact of the book's formats (32 bytes for the example record), and it means a reader needs the <strong>exact writer's schema</strong> to decode anything.`,
      problem: `Tag numbers must be assigned and guarded by hand, which is painful for machine-generated schemas such as database dumps into Hadoop, where every column of every table would need a stable tag.`,
      why: `It is friendly to dynamically generated schemas: generate an Avro schema from a table's columns, regenerate it when columns change, and name-based resolution keeps old and new readers working without anyone assigning or guarding tags. Code generation is optional, so dynamically typed languages and generic tools (Spark, Hive, Pig) can use it directly. The writer's schema travels once per file (in the object container file), as a version number per record, or as a registry ID per message. The price is schema-management infrastructure: a single Avro record can't be inspected, or even safely decoded, without its writer's schema, and decoding with the wrong one can produce garbage rather than an error.`,
      ex: `Avro container files became a standard record format in HDFS. LinkedIn's Espresso prefixes each stored record with its schema version. Debezium's Avro converter derives a schema per table and registers a new version when a column is added or dropped. Apache Iceberg stores its manifest lists and manifests as Avro files.`,
      section: "avro",
    },
    {
      id: "writers-schema-vs-readers-schema",
      term: "Writer's schema vs reader's schema (Avro)",
      def: `Avro decodes bytes with the <strong>writer's schema</strong> (exactly the one used to encode them), then translates the result into the <strong>reader's schema</strong> (the shape the application expects). Fields are matched <strong>by name</strong>, so their order doesn't matter. A field only the writer has is ignored. A field only the reader has gets the reader's default; if it has no default, decoding fails.`,
      problem: `Bytes without field identifiers can only be parsed with the exact schema that wrote them, yet readers must be able to evolve independently of writers.`,
      why: `Compatibility becomes a property of a pair of schemas that a machine can check. You may add or remove only fields that have defaults: adding one without a default breaks backward compatibility, and removing one without a default breaks forward compatibility. Aliases live in the reader's schema, so they help only the reader that declares them: a rename with an alias is backward compatible, not forward. Adding a union branch is also backward-only, since an old reader fails on a value written with the new branch. Nullability is a union with null; up to Avro 1.11 the specification required a union field's default to match the union's first branch (1.12 relaxes this to the first branch that matches), so a null default traditionally goes with null listed first. Allowed promotions: int → long, float or double; long → float or double; float → double; string ↔ bytes. A writer's enum symbol that the reader lacks is an error unless the reader's enum declares a default symbol (Avro 1.9+).`,
      ex: `The book's writer schema has <code>union { null, long } favoriteNumber = null;</code>. A reader schema that adds <code>union { null, string } photoUrl = null</code> reads every old record with photoUrl = null; one that adds <code>string email</code> with no default rejects them all.`,
      section: "avro",
    },
    {
      id: "avro-object-container-file",
      term: "Avro object container file",
      def: `Avro's file format: a header with the magic bytes <code>Obj</code> plus version byte 1 and a metadata map that includes the writer's schema (<code>avro.schema</code>) and compression codec (<code>avro.codec</code>), followed by blocks of records separated by a 16-byte sync marker.`,
      problem: `Avro bytes can't be decoded without the writer's schema. Storing it once per file makes large files self-describing at almost no per-record cost, and the sync markers let Hadoop split files for parallel processing.`,
      why: `One schema per file means generic tools can open any file without a registry. Blocks can be compressed with the codec named in the header (deflate, snappy, zstandard and others), and the sync markers let a reader start in the middle of a file and find the next block boundary, which is how Hadoop and Spark split one file across many tasks. Because a dump is written once with one schema, container files (or Parquet for columnar analytics, ch3) are the natural format for database snapshots and data-lake archives.`,
      ex: `<code>avro-tools getschema users.avro</code> prints the schema embedded in a file's header, and <code>avro-tools tojson users.avro</code> dumps its records. Apache Iceberg's manifest lists and manifests are Avro container files.`,
      section: "avro",
    },

    // --- merits-of-schemas ---
    {
      id: "schema-registry",
      term: "Schema registry",
      def: `A service that stores every version of each <strong>subject</strong>'s schema (usually one subject per topic, such as <code>orders-value</code>) and gives each version a numeric ID. Producers register their schema and prefix each message with 5 bytes: a <strong>magic byte 0x00 plus a 4-byte big-endian schema ID</strong>. Consumers fetch the schema for an ID once and cache it. The registry enforces the subject's <strong>compatibility mode</strong> whenever a new version is registered. Confluent's registry supports Avro, Protobuf and JSON Schema.`,
      problem: `Embedding a full schema in each message would dwarf the payload, and nothing stopped teams from shipping incompatible schemas.`,
      why: `It turns "please don't break consumers" into a check that runs before a bad message can be produced, and it makes the schema documentation that can't go stale, because consumers need it to decode. For Avro it answers "where does the writer's schema come from?" for streams, at 5 bytes per message. It is also critical infrastructure: consumers can't decode a schema ID they haven't cached while the registry is down, and the compatibility mode must match the order in which you deploy producers and consumers.`,
      ex: `Confluent Schema Registry (default mode BACKWARD; Protobuf and JSON Schema support since Confluent Platform 5.5, 2020); AWS Glue Schema Registry and Apicurio Registry follow the same model. With Confluent's default naming strategy, a topic's value schemas live under the subject <code>&lt;topic&gt;-value</code>.`,
      section: "merits-of-schemas",
    },
    {
      id: "compatibility-modes",
      term: "Schema compatibility modes",
      def: `Registry rules that check each new schema version before it can be used: <strong>BACKWARD</strong> (new readers can read data written with the previous schema; upgrade consumers first), <strong>FORWARD</strong> (previous readers can read new data; upgrade producers first), <strong>FULL</strong> (both; any order), with <strong>_TRANSITIVE</strong> variants that check against all earlier versions, and NONE to disable checks.`,
      problem: `Without an automated check, an incompatible schema is discovered only when consumers start failing in production.`,
      why: `A mode is really a deploy order. BACKWARD (Confluent's default) lets you delete fields and add optional ones, and requires upgrading consumers first. FORWARD lets you add fields and delete optional ones, and requires upgrading producers first. FULL allows only adding and deleting optional fields, and then any order works. The transitive variants matter because logs retain history: a consumer replaying a topic from the beginning reads every past version, while a plain BACKWARD check compares only against the latest one. NONE turns the safety net off.`,
      ex: `<code>PUT /config/orders-value</code> with <code>{"compatibility": "FULL_TRANSITIVE"}</code> requires every future schema for that subject to read, and be readable by, all earlier versions. CI can call <code>POST /compatibility/subjects/orders-value/versions/latest</code> to test a proposed schema before it is merged.`,
      section: "merits-of-schemas",
    },

    // --- dataflow-databases ---
    {
      id: "dataflow-through-databases",
      term: "Dataflow: through databases",
      def: `One process encodes data and writes it to a database; a later process (perhaps the same code, perhaps a different version) reads and decodes it. Writing is <strong>sending a message to your future self</strong>, so backward compatibility is needed. During a rolling upgrade, old code also reads, and rewrites, values written by new code, so forward compatibility is often needed too.`,
      problem: `The database decouples writer and reader in time, and data outlives the code that wrote it.`,
      why: `One table can hold values written 5 milliseconds and 5 years ago by many code versions, and rewriting all of it for every schema change (a migration) is slow and risky on large datasets. So databases make simple changes cheap: adding a nullable column doesn't rewrite old rows, which simply read as NULL. The subtle hazard is losing data rather than failing to read it. When old code decodes an encoded value into its own model and writes the <em>whole</em> value back (a document replaced in full, a blob in a key-value store or cache, a GET-modify-PUT), fields it doesn't know are silently dropped; a relational UPDATE that names only the columns old code knows leaves new columns alone. Archival dumps are written once with the latest schema, so Avro container files or Parquet suit them.`,
      ex: `PostgreSQL 11 made <code>ADD COLUMN</code> with a non-volatile default a catalog-only change, and MySQL 8.0.12 added <code>ALGORITHM=INSTANT</code> for adding columns. LinkedIn's Espresso stores Avro records tagged with their schema version and uses Avro's resolution rules, so the whole database appears to have one schema. A MongoDB collection routinely holds documents in several historical shapes.`,
      section: "dataflow-databases",
    },
    {
      id: "unknown-field-preservation",
      term: "Unknown-field preservation",
      def: `When code decodes a record containing fields it doesn't know and later re-encodes the whole record, it writes those fields back unchanged. Protobuf libraries do this (proto3 again since 3.5, 2017); typed JSON mappers and hand-written model objects usually don't.`,
      problem: `Old code that decodes an encoded record (a document, a blob, an API response) into its own model object and saves the whole object silently deletes fields added by newer versions, during rolling upgrades and after rollbacks.`,
      why: `It closes the gap between "old code can read new data" and "old code doesn't destroy new data": ignoring a field is not preserving it. Format support is necessary but not sufficient, because application layers (DTOs, ORMs over JSON columns, typed mappers, load-modify-replace document code) often copy only the fields they know. Two fixes: preserve unknown fields end to end, or stop rewriting whole records (update one column, send a JSON merge patch or a field mask). Either way, deploy a version that preserves a field before any version writes it.`,
      ex: `Protobuf message objects carry unknown fields through parse and serialize. In Jackson, <code>@JsonAnySetter</code> and <code>@JsonAnyGetter</code> can capture and re-emit extra properties. Google's APIs take a <code>FieldMask</code> in update requests, and JSON Merge Patch (RFC 7396) sends only the fields that changed.`,
      section: "dataflow-databases",
    },
    {
      id: "expand-contract",
      term: "Expand/contract (parallel change)",
      def: `Making a breaking change as a series of compatible steps: add the new field or column (expand), write both, backfill, move readers over, stop writing the old one, then remove it (contract).`,
      problem: `A one-step rename or type change breaks whichever version is still running during a rolling deploy or after a rollback.`,
      why: `Each deploy is compatible with the version before it and the one after it, so rolling deploys and rollbacks stay safe at every step. It costs several deploys and a backfill, and the contract step must wait until no running version, including the rollback target, still reads the old field. Backfills should run in small, throttled batches to avoid long locks and replication lag.`,
      ex: `Danilo Sato's ParallelChange article on Martin Fowler's site names the three phases expand, migrate, contract. Stripe's 2017 post "Online migrations at scale" describes a dual-writing migration in four phases: dual write, move reads, move writes, remove the old data. For large MySQL tables, online schema-change tools such as GitHub's gh-ost perform the table copies without blocking writes.`,
      section: "dataflow-databases",
    },

    // --- dataflow-services ---
    {
      id: "dataflow-through-services",
      term: "Dataflow: through services (REST/RPC)",
      def: `Clients (browsers, mobile apps, other services) send requests to a server's API and wait for responses. Unlike a database, which accepts arbitrary queries, a service exposes an <strong>application-specific API</strong> whose inputs and outputs are fixed by its business logic (encapsulation). Styles: <strong>REST</strong>, an architectural style (Fielding, 2000) built on HTTP's features (URLs for resources, caching, authentication, content negotiation), not a protocol, often described with OpenAPI; <strong>SOAP</strong>, an XML-based protocol described with WSDL and the WS-* standards; and <strong>RPC frameworks</strong> such as gRPC (HTTP/2), Thrift (often raw TCP), Avro RPC, Finagle and Rest.li. RPC doesn't have to mean HTTP.`,
      problem: `Independently deployed services must tolerate old and new clients, and making network calls look local hides their failures.`,
      why: `Servers are usually upgraded before clients, so <strong>requests need backward compatibility</strong> (the new server reads old clients' requests) and <strong>responses need forward compatibility</strong> (old clients read the new server's responses). Compatibility is inherited from the encoding: gRPC and Thrift follow their tag rules, JSON follows conventions. Adding optional request parameters and new response fields is safe only if client decoders ignore unknown fields and enum values, and Jackson's defaults don't. Across organizations the provider can't force anyone to upgrade, so old API versions must keep working for a long time, perhaps forever.`,
      ex: `Internal microservices commonly use gRPC with Protobuf contracts, while public APIs are usually JSON over HTTP. Stripe pins each account to the API version current at its first request; GitHub selects REST API versions with an <code>X-GitHub-Api-Version</code> header (the first is 2022-11-28).`,
      section: "dataflow-services",
    },
    {
      id: "rpc-location-transparency",
      term: "RPC and location transparency",
      def: `Remote procedure call frameworks make a network request look like a local function call. The abstraction leaks: network calls can be lost, time out with an unknown outcome, run twice when retried, take wildly variable time, and must encode every argument.`,
      problem: `Programmers wanted to call remote services as easily as local methods. Hiding the network also hid its failure modes, so code broke in ways local calls never do.`,
      why: `A network call differs from a local one in six ways: the request or response can be lost and the remote machine can be slow or down; a timeout is a new outcome that tells you nothing about what happened; a retry may perform the action twice if only the response was lost; latency is far higher and wildly variable; every argument must be encoded into bytes (no pointers, and large objects are expensive); and the two sides may use different languages, so types must be translated (think of JavaScript's 2^53 limit). Modern frameworks make the network explicit instead: futures and promises (Finagle, Rest.li), deadlines and cancellation that propagate down call chains, streaming, and service discovery (gRPC). Part of REST's appeal is that it doesn't pretend. Lost requests and timeouts are explored hands-on in <a href="#/ch8/learn/unreliable-networks">ch8</a>, and end-to-end deduplication in <a href="#/ch12/learn/end-to-end-argument">ch12</a>.`,
      ex: `"A Note on Distributed Computing" (Waldo, Wyant, Wollrath and Kendall, Sun Microsystems, 1994) argued that latency, memory access, partial failure and concurrency make remote objects fundamentally different from local ones, a lesson CORBA, DCOM, Java RMI and EJB each learned the hard way. Stripe's <code>Idempotency-Key</code> header makes a retried charge return the first request's result instead of charging twice.`,
      section: "dataflow-services",
    },
    {
      id: "api-versioning",
      term: "Service API versioning",
      def: `Running several incompatible versions of a service API side by side: a version in the URL, in a request header, or pinned per client account (Stripe-style dates), usually translated to one internal model at the edge. Additive changes (new optional parameters, new response fields) normally go to every version, so clients must still tolerate them.`,
      problem: `Providers of public APIs can't force clients to upgrade, so any breaking change without versioning breaks someone's integration.`,
      why: `Versions let you make breaking changes (new required parameters, renames, type changes, removals, changed meanings) without breaking anyone, but every version is a contract you have to keep running. Translating versions at the edge keeps the core on one model instead of version branches everywhere. Some changes can't be translated back (a new state that old clients have no word for), so the line between additive and breaking must be drawn deliberately. Removals need per-client usage telemetry and a deprecation window, because you can't otherwise see who reads a field. And since additive changes reach every version, the contract must tell clients to ignore unknown fields and treat enums as open-ended.`,
      ex: `Stripe pins accounts to dated versions (such as 2017-05-25), allows a per-request <code>Stripe-Version</code> override, and implements old versions as small version-change modules that transform responses back into older shapes. GitHub uses dated versions in the <code>X-GitHub-Api-Version</code> header, many APIs put <code>/v1</code> in the URL, and GraphQL APIs usually avoid versions by marking fields <code>@deprecated</code> and removing them once usage drops.`,
      section: "dataflow-services",
    },

    // --- dataflow-messages ---
    {
      id: "dataflow-async-messaging",
      term: "Dataflow: async messaging",
      def: `Sending a message to another process through an intermediary, a <strong>message broker</strong> (also called a message queue or message-oriented middleware), that stores it temporarily. It sits between RPC (low-latency delivery to another process) and databases (data held by an intermediary). Communication is usually <strong>one-way and asynchronous</strong>: the sender doesn't wait for delivery, and any reply travels on a separate channel such as a reply queue.`,
      problem: `Synchronous calls couple sender and receiver in availability, addressing and speed: if the receiver is down, slow or moved, the sender suffers.`,
      why: `A broker buffers messages while the recipient is down or overloaded, redelivers to a consumer that crashed, spares the sender from knowing the recipient's address (useful when VMs come and go), fans one message out to several consumers, and decouples the sender logically from whoever consumes. Brokers carry bytes plus metadata, so compatibility is still your job: with backward- and forward-compatible encodings, producers and consumers can be deployed in any order. Consumers that republish must preserve unknown fields, and log-based brokers retain history, so a replaying consumer meets every schema version still retained. Broker semantics are covered in <a href="#/ch11/learn/messaging-systems">ch11</a>.`,
      ex: `RabbitMQ, ActiveMQ, NATS and Apache Kafka are open-source brokers; TIBCO and IBM MQ are long-established commercial ones. Kafka, built at LinkedIn and open-sourced in 2011, retains messages for a configurable period, so old formats must stay readable for as long as they're retained. CloudEvents (CNCF, 1.0 in 2019) standardizes envelope metadata such as <code>id</code>, <code>source</code> and <code>type</code>.`,
      section: "dataflow-messages",
    },
    {
      id: "actor-model",
      term: "Actor model",
      def: `A programming model for concurrency: instead of threads, locks and shared memory, logic lives in <strong>actors</strong>, each with private state, which <strong>process one message at a time</strong> from a mailbox and communicate only by sending asynchronous messages. Message delivery is not guaranteed. Distributed actor frameworks use the same mechanism across machines, encoding, sending and decoding messages transparently.`,
      problem: `Threads, locks and shared memory make concurrent code error-prone. Actors encapsulate state and communicate only through messages.`,
      why: `Location transparency works better here than in RPC, because the model already assumes messages can be lost even locally; moving an actor to another node adds latency but breaks no assumption the code relied on. A distributed actor framework is essentially a broker and the actor model in one, so rolling upgrades still need compatible message encodings. In the book's 2017 snapshot, Akka used Java serialization by default (no forward or backward compatibility) unless you plugged in Protocol Buffers, Orleans' default format didn't support rolling upgrades (you deployed a new cluster and moved traffic), and changing Erlang record schemas was hard.`,
      ex: `Akka 2.6 (2019) disabled Java serialization by default in favor of Jackson or Protobuf serializers, and after Akka's 2022 license change the community fork became Apache Pekko; newer Orleans releases ship a serializer designed to tolerate type changes. Orleans ran services for Halo 4 and Halo 5. Erlang/OTP, whose hot code loading keeps two versions of a module in memory at once, underpins WhatsApp's backend; Erlang maps arrived in OTP 17 (2014).`,
      section: "dataflow-messages",
    },
  ],

  // ------------------------------------------------------------------
  // CHEATSHEET
  // ------------------------------------------------------------------
  cheatsheet: [
    {
      title: "Encoding formats compared",
      type: "table",
      headers: ["Format", "How fields are identified", "Self-describing?", "Example size", "Schema evolution", "Best fit"],
      rows: [
        ["Language-specific (pickle, Java Serializable, Ruby Marshal)", "Class and field names of one language's runtime", "Only to the same language (often the same library version)", "Not measured; Java's is notoriously bloated", "Brittle: serialVersionUID mismatches, renamed classes break old data", "Transient, trusted, same-language data only; untrusted input means RCE risk"],
        ["JSON / XML", "Field names in every record", "Names and structure yes; types no (JSON: no int/float split; XML: numbers look like strings)", `<span style="overflow-wrap:normal;word-break:normal">JSON 81 B (no whitespace)</span>`, "By convention: readers ignore unknown fields; optional JSON Schema / XML Schema", "Public APIs, browsers, config, cross-organization interchange"],
        ["CSV", "Column position (optional header row)", "Barely: header names, no types", "Not measured", "Manual; adding a column breaks positional readers", "Spreadsheet exports, simple bulk interchange"],
        ["MessagePack / BSON", "Field names in every record", "Yes, with richer types (int vs float, binary; BSON adds dates, int64, Decimal128, ObjectId)", `<span style="overflow-wrap:normal;word-break:normal">MessagePack 66 B</span>`, "Same as JSON: no schema", "JSON's data model in binary; MongoDB's storage format (BSON)"],
        ["Thrift", "Numeric tags + type", "No: tags, no names; schema needed", "Binary 59 B / Compact 34 B", "New optional fields with new tags; never reuse tags", "Cross-language RPC (Meta's fbthrift)"],
        ["Protocol Buffers", "Numeric tags + wire type", "No: <code>--decode_raw</code> shows tags and wire types, not names", "33 B", "Same tag rules; unknown fields preserved (proto3 since 3.5)", "gRPC services, mobile clients, internal storage"],
        ["Avro", "Position in the writer's schema, resolved by name into the reader's", "Records no; object container files yes (schema in the header)", "32 B", "Add/remove only fields with defaults; reader aliases (backward only)", "Hadoop/data-lake files, Kafka with a registry, machine-generated schemas (DB dumps, CDC)"],
      ],
      note: "Sizes are for the book's example record {userName: 'Martin', favoriteNumber: 1337, interests: ['daydreaming', 'hacking']}, before compression. General-purpose compression narrows the gaps; types and parse cost are what it can't fix.",
    },
    {
      title: "JSON traps",
      type: "note",
      body: `<ul>
<li><strong>Big integers</strong>: JavaScript (and many parsers) decode numbers as IEEE-754 doubles. Integers above 2^53 (9,007,199,254,740,992) aren't all representable: <code>JSON.parse("9007199254740993")</code> returns 9007199254740992, and 1050118621198921728 prints as 1050118621198921700. <strong>Send 64-bit IDs as strings.</strong> The JSON spec sets no precision limit; parsers do.</li>
<li><strong>No binary type</strong>: Base64 turns every 3 bytes into 4 characters (+33%), and the docs must say which strings are Base64.</li>
<li><strong>No int/float distinction</strong> and no standard for dates, decimals or units: name fields with units (<code>timeout_ms</code>) and document types.</li>
<li><strong>Schemas are optional</strong>, so every consumer's parsing code becomes the de facto schema.</li>
<li><strong>Enums are strings in disguise</strong>: strict decoders (Swift Codable enums, Jackson's default) throw on a value they don't know.</li>
</ul>`,
    },
    {
      title: "Where the bytes go (book's example record)",
      type: "table",
      headers: ["Format", `<span style="overflow-wrap:normal;word-break:normal">Bytes</span>`, "Field identity", "favoriteNumber 1337", "Strings and lists"],
      rows: [
        ["JSON", "81", "Quoted names: 31 of the 81 bytes", "4 ASCII digits", "Quoted text; list in [ ]"],
        [`<span style="overflow-wrap:normal;word-break:normal">MessagePack</span>`, "66", "Names as fixstr: still 31 name bytes", "cd 05 39 (uint16)", "1-byte fixstr / fixarray headers"],
        ["Thrift Binary", "59", "Type byte + 2-byte tag per field", "8 fixed bytes", "4-byte lengths; list = element type + 4-byte count"],
        ["Thrift Compact", "34", "1 byte: tag delta (high nibble) + type (low nibble)", "f2 14 (zigzag varint)", "Varint lengths; list header (size &lt;&lt; 4) | type"],
        ["Protobuf", "33", "1-byte key per occurrence: (tag &lt;&lt; 3) | wire type", "b9 0a (plain varint)", "Varint lengths; repeated field = key repeated per element"],
        ["Avro", "32", "None: values in the writer's schema order", "02 f2 14 (union branch 1, then zigzag varint)", "Zigzag-varint lengths; array = block count + items + 00"],
      ],
      note: "The big win over JSON comes from dropping names (81 → 33); dropping tags too (33 → 32) matters far less for size than for how evolution works.",
    },
    {
      title: "Protobuf wire format in one box",
      type: "note",
      body: `<p><span class="formula">key = (field_number &lt;&lt; 3) | wire_type</span></p>
<p><span class="formula">zigzag(n) = (n &lt;&lt; 1) ^ (n &gt;&gt; 63)</span></p>
<ul>
<li>Wire types: <strong>0 VARINT</strong> (int32/64, uint, sint, bool, enum), <strong>1 I64</strong> (fixed64, double), <strong>2 LEN</strong> (string, bytes, messages, packed repeated), <strong>5 I32</strong> (fixed32, float); 3/4 are deprecated groups.</li>
<li>0x0a = field 1, LEN; 0x10 = field 2, VARINT; 0x1a = field 3, LEN.</li>
<li>Field numbers 1–15 take a 1-byte key, 16–2047 two bytes; maximum 2^29 − 1; 19000–19999 are reserved by the implementation.</li>
<li>Varint: 7 bits per byte, least-significant group first, high bit = more bytes follow. 1337 → <code>b9 0a</code>.</li>
<li>Zigzag: 0→0, −1→1, 1→2, −2→3; 1337 → 2674 → <code>f2 14</code> (Avro, Thrift Compact, Protobuf sint).</li>
<li>int64 −1 = 10-byte varint; sint64 −1 = 1 byte.</li>
<li>Thrift Compact field header: (delta &lt;&lt; 4) | type when the delta is 1–15 (0x18 = next field, type 8 binary/string).</li>
</ul>`,
    },
    {
      title: "Schema evolution rules (tag-based formats)",
      type: "list",
      items: [
        "<strong>Adding a field</strong>: give it a new tag and make it optional (or give it a default). Old code skips it, new code defaults it: both directions work.",
        "<strong>Removing a field</strong>: only optional fields; then reserve its number and name (<code>reserved 2; reserved \"favorite_number\";</code>).",
        "<strong>Required fields</strong>: never add one (breaks backward: old data lacks it) and never remove one (breaks forward: old readers insist on it). Changing required → optional is unsafe while old readers that require it exist. proto3 dropped <code>required</code>.",
        "<strong>Renaming</strong>: Thrift/Protobuf free on the wire (breaks the JSON mapping and code); Avro via reader aliases, which are backward-compatible only.",
        "<strong>Changing types</strong>: Protobuf int32 → int64 is readable by new code but truncated by old code (5,000,000,000 → 705,032,704); sint and int are not interchangeable. Avro allows only promotions: int → long/float/double, long → float/double, float → double, string ↔ bytes.",
        "<strong>Never reuse or renumber tags</strong> (or enum numbers); reserve deleted numbers and names.",
        "<strong>Protobuf optional → repeated</strong> is allowed for strings, bytes and messages only (old readers keep the last element; messages merge); not for numeric, bool or enum fields, which are packed by default in proto3.",
        "<strong>Every pair of versions that can coexist</strong> (including stored data and rollback targets) must be compatible, not just the latest pair.",
      ],
    },
    {
      title: "proto2 vs proto3",
      type: "table",
      headers: ["", "proto2", "proto3 (2016)"],
      rows: [
        ["required", "Allowed (a runtime check; doesn't change the bytes)", "Removed"],
        ["Field presence for scalars", "Always tracked (has_ accessors)", "None: unset reads as 0 / '' / false, unless marked optional (3.15+, 2021)"],
        ["Custom defaults", "[default = x]", "Zero values only"],
        ["Unknown fields", "Preserved", "Dropped at first; preserved again since 3.5 (2017)"],
        ["Enums", "Closed: unknown value parked in unknown fields (C++/Java), field reads its default", "Open: raw number kept (Java exposes UNRECOGNIZED); first value must be 0"],
        ["Repeated numerics", "Unpacked unless [packed = true]", "Packed by default"],
      ],
      note: "Protobuf Editions (starting with edition 2023) replace the proto2/proto3 switch with per-feature settings; the wire format is unchanged.",
    },
    {
      title: "Same change, two formats",
      type: "table",
      headers: ["Change", "Protobuf: backward (new reads old)", "Protobuf: forward (old reads new)", "Avro: backward (new reads old)", "Avro: forward (old reads new)"],
      rows: [
        ["Add optional field (new tag / with default)", "OK: default", "OK: skipped, kept as unknown", "OK: reader's default", "OK: ignored"],
        ["Add field without default (proto2 required)", "Breaks: old data lacks it", "OK: skipped", "Breaks: no value, no default", "OK: ignored"],
        ["Remove optional field (with default)", "OK: tag skipped", "OK: old reader sees it unset", "OK: ignored", "OK: old reader uses its default"],
        ["Remove required field (no default)", "OK: tag skipped", "Breaks: old reader requires it", "OK: ignored", "Breaks: old reader has no value, no default"],
        ["Rename", "OK on the wire (JSON mapping, code break)", "OK on the wire", "OK only with an alias in the reader", "Breaks: old reader can't find its name (or silently reads its default)"],
        ["Reuse a tag / name for a new meaning", "Corrupts silently", "Corrupts silently", "Same if a name is reused", "Same if a name is reused"],
        ["int32 → int64 (Avro int → long)", "OK", "Truncates large values silently", "OK: promotion", "Error: no narrowing"],
        ["Add union branch / oneof member", "OK", "Old code sees the oneof as unset", "OK", "Error when the new branch is written"],
        ["Add enum value", "OK", "proto2: reads the default; proto3: keeps the raw number", "OK", "Error unless the reader's enum has a default symbol (1.9+)"],
        ["Single value → repeated / array", "OK (strings, bytes, messages only)", "Last element wins (messages merge); unsafe for numerics", "Error: no conversion", "Error: no conversion"],
      ],
    },
    {
      title: "Avro schema resolution in one breath",
      type: "list",
      items: [
        "Decode with the <strong>writer's</strong> schema, then resolve <strong>by name</strong> into the reader's. Field order is irrelevant.",
        "Writer-only field → ignored. Reader-only field → reader's default. No default → error.",
        "Rule: add or remove only fields with defaults (adding without one breaks backward; removing without one breaks forward).",
        "Null is explicit: <code>union { null, long } x = null</code>. A union's default must match its first branch (Avro 1.12 relaxes this to the first matching branch), so null goes first.",
        "Aliases belong to the reader: backward-compatible only. A new union branch: backward only.",
        "Promotions only: int → long/float/double, long → float/double, float → double, string ↔ bytes.",
        "Unknown enum symbol → error unless the reader's enum declares a default (Avro 1.9+).",
        "Decoding with the wrong writer's schema may not fail loudly: it can yield garbage values. Identify the writer's schema exactly; never guess.",
      ],
    },
    {
      title: "Where Avro's writer schema comes from",
      type: "list",
      items: [
        "<strong>Object container file</strong>: once per file, in the header (<code>Obj</code> + 1, metadata with <code>avro.schema</code> and <code>avro.codec</code>, then blocks separated by a 16-byte sync marker).",
        "<strong>Database of individually written records</strong>: a schema version number prefixed to each record, plus a table of versions (LinkedIn's Espresso).",
        "<strong>Network connection</strong>: negotiated once at connection setup (Avro RPC).",
        "<strong>Message streams</strong>: a registry ID per message (Kafka: 0x00 + 4-byte schema ID).",
      ],
    },
    {
      title: "Schema registry compatibility modes",
      type: "table",
      headers: ["Mode", "Guarantees", "Allowed changes", "Checked against", "Upgrade first"],
      rows: [
        ["BACKWARD (default)", "New schema reads data written with the previous one", "Delete fields, add optional fields", "Latest version", "Consumers"],
        [`<span style="overflow-wrap:normal;word-break:normal">BACKWARD_TRANSITIVE</span>`, "New schema reads data from every earlier version", "Same as BACKWARD", "All versions", "Consumers"],
        ["FORWARD", "Previous schema reads data written with the new one", "Add fields, delete optional fields", "Latest version", "Producers"],
        [`<span style="overflow-wrap:normal;word-break:normal">FORWARD_TRANSITIVE</span>`, "Every earlier schema reads new data", "Same as FORWARD", "All versions", "Producers"],
        ["FULL", "Both directions", "Add or delete optional fields only", "Latest version", "Any order"],
        [`<span style="overflow-wrap:normal;word-break:normal">FULL_TRANSITIVE</span>`, "Both directions with every version", "Add or delete optional fields only", "All versions", "Any order"],
        ["NONE", "Nothing", "Anything", "Nothing", "Coordinate by hand"],
      ],
      note: "Kafka wire format: magic byte 0x00 + 4-byte big-endian schema ID + payload. Use a transitive mode when consumers may replay retained history.",
    },
    {
      title: "Choosing a format",
      type: "table",
      headers: ["Situation", "Reach for", "Why"],
      rows: [
        ["Public web API, browser clients, third parties", "JSON over HTTP + OpenAPI; IDs as strings", "Universal tooling and debuggability; the reader may be anyone"],
        ["Internal service-to-service calls", "Protobuf + gRPC", "Typed contracts, codegen, compact, deadlines and streaming"],
        ["Event streams shared by many teams", "Avro or Protobuf + schema registry (transitive mode)", "Automated compatibility checks; consumers replay history"],
        ["Database dumps, CDC, machine-generated schemas", "Avro", "No hand-assigned tags; regenerate the schema and resolve by name"],
        ["Data-lake files for batch jobs", "Avro container files (row) or Parquet (columnar analytics)", "Self-describing files that generic tools can open"],
        ["Mobile clients on slow networks", "Protobuf (plan for unknown enum values)", "Small payloads; old app versions live for months"],
        ["Zero-copy reads, memory-mapped data", "FlatBuffers, Cap'n Proto", "No separate decode step"],
        ["Cache of your own objects", "Still a language-neutral format", "Deploys change classes, and anyone who can write the cache could otherwise run code"],
      ],
    },
    {
      title: "Dataflow modes",
      type: "table",
      headers: ["Mode", "Coupling", "Compatibility needed", "Common formats", "Examples"],
      rows: [
        [`<span style="overflow-wrap:normal;word-break:normal">Database</span>`, "In time: data outlives the code that wrote it", "Both directions plus unknown-field preservation on whole-record writes", "Engine's own row format; JSON/BSON documents; Avro or Protobuf blobs", "PostgreSQL, MongoDB, Espresso, Redis as a cache"],
        [`<span style="overflow-wrap:normal;word-break:normal">Services (REST/RPC)</span>`, "Synchronous: both sides up at the same time", "Servers first: backward-compatible requests, forward-compatible responses; long-lived versions for external clients", "JSON over HTTP; Protobuf over gRPC; Thrift", "Public REST APIs, gRPC microservices"],
        [`<span style="overflow-wrap:normal;word-break:normal">Async messages (broker)</span>`, "Loose in time and space: broker buffers, sender doesn't know the receiver", "Both directions so producers and consumers deploy in any order, plus replay of retained history", "Avro or Protobuf with a registry; JSON", "Kafka, RabbitMQ, SQS, NATS"],
        [`<span style="overflow-wrap:normal;word-break:normal">Distributed actors</span>`, "Asynchronous messages to actor addresses, local or remote", "Both directions for rolling upgrades", "Framework-specific: Akka (Java serialization by default in 2017; Jackson/Protobuf since 2.6), Orleans (custom), Erlang term format", "Akka / Pekko, Orleans, Erlang/OTP"],
      ],
    },
    {
      title: "Where unknown fields get lost",
      type: "note",
      body: `<p>Fields disappear on <strong>whole-record rewrites of encoded values</strong> by code that doesn't know them: a document replaced in full, a JSON or Protobuf blob in a key-value store or cache, a GET-modify-PUT through an API, a stream processor that consumes, transforms and republishes.</p>
<p>They <strong>don't</strong> disappear on a relational UPDATE that names only the columns the old code knows.</p>
<p><strong>Fix</strong>: preserve unknown fields end to end (Protobuf does by default; configure JSON mappers to keep extra properties), or write only what changed (column UPDATE, JSON merge patch, field masks). Deploy the preserving version before any version writes the field, and remember that a rollback reintroduces old code against new data.</p>`,
    },
    {
      title: "Expand/contract checklist",
      type: "list",
      ordered: true,
      items: [
        "<strong>Expand</strong>: add the new column or field (nullable, or with a default). Instant in PostgreSQL 11+ for non-volatile defaults and MySQL 8.0.12+ with ALGORITHM=INSTANT.",
        "<strong>Dual write</strong>: deploy code that writes both and reads the new one, falling back to the old.",
        "<strong>Backfill</strong> old rows in small, throttled batches (no single giant transaction).",
        "<strong>Switch reads</strong> to the new field; verify the backfill is complete and stays complete.",
        "<strong>Stop writing the old field</strong> once no running version, including the rollback target, reads it.",
        "<strong>Contract</strong>: remove the old field after the rollback window has closed.",
        "Each step must be compatible with its predecessor and successor, because adjacent versions run side by side.",
      ],
    },
    {
      title: "A network call is not a local call",
      type: "list",
      items: [
        "The request or the response can be lost; the remote node can be slow or down.",
        "A timeout is an outcome with no information: it may or may not have happened.",
        "Retries may execute the action twice unless it is idempotent or deduplicated (idempotency keys).",
        "Latency is far higher and wildly variable.",
        "Every argument must be encoded into bytes: no pointers, and big objects are expensive.",
        "The two sides may be in different languages, so types must be translated (JavaScript's 2^53 integers).",
        "Hands-on: <a href=\"#/ch8/learn/unreliable-networks\">ch8</a> (lost requests and timeouts) and <a href=\"#/ch12/learn/end-to-end-argument\">ch12</a> (end-to-end deduplication).",
      ],
    },
    {
      title: "API changes vs old clients",
      type: "list",
      items: [
        "<strong>Servers deploy first</strong>, so requests need backward compatibility and responses need forward compatibility.",
        "<strong>Additive</strong> (optional request parameters, new response fields, new endpoints, often new enum values) ships to every version and is safe only if clients ignore what they don't know. Jackson fails on unknown properties by default; Swift Codable throws on unknown enum values.",
        "<strong>Breaking</strong> (new required parameters, renames, type changes, removals, changed meaning) needs a new version or an edge transform.",
        "<strong>Versioning options</strong>: URL (/v1), request header, or per-account pinned dates with a per-request override (Stripe); translate at the edge so the core keeps one model.",
        "<strong>Removals</strong> need per-client usage telemetry and a deprecation window.",
        "Publish tolerance rules (ignore unknown fields, treat enums as open-ended) in the contract from day one.",
      ],
    },
    {
      title: "Numbers to remember",
      type: "list",
      items: [
        "Book's example record: JSON <strong>81</strong> B, MessagePack <strong>66</strong>, Thrift Binary <strong>59</strong>, Thrift Compact <strong>34</strong>, Protobuf <strong>33</strong>, Avro <strong>32</strong>.",
        "<strong>2^53</strong> = 9,007,199,254,740,992; <code>Number.MAX_SAFE_INTEGER</code> = 2^53 − 1.",
        "Base64: 3 bytes → 4 characters = <strong>+33%</strong>.",
        "Kafka/Confluent prefix: <strong>5 bytes</strong> (magic 0x00 + 4-byte schema ID).",
        "Protobuf field numbers: 1–15 → 1-byte key; max 2^29 − 1; 19000–19999 reserved.",
        "int32 truncation: 5,000,000,000 → <strong>705,032,704</strong>.",
        "Varint: 1337 → b9 0a; zigzag: 1337 → 2674 → f2 14; Protobuf int64 −1 = 10 bytes.",
        "Avro container file: magic <code>Obj</code> + 1; 16-byte sync marker.",
        "BSON document limit: 16 MB.",
        "Knight Capital (2012): 7 of 8 servers updated, about 45 minutes, more than $440 million lost.",
      ],
    },
  ],

  // ------------------------------------------------------------------
  // INTERVIEW (grouped by section order)
  // ------------------------------------------------------------------
  interview: [
    // --- why-encoding ---
    {
      id: "q01",
      q: "What is schema evolution and why does it matter?",
      diff: "medium",
      section: "why-encoding",
      a: `<p><strong>Schema evolution</strong> is changing the shape of your data (adding, removing, renaming or retyping fields) while data in the old shape, and code that expects the old shape, still exist. The goal: every version of the code keeps working with every version of the data it can meet.</p>
<p><strong>Why it can't be avoided</strong>:</p>
<ul>
<li><strong>Rolling deploys</strong>: servers are upgraded a few at a time (a Kubernetes Deployment's default RollingUpdate allows 25% surge and 25% unavailable), so v1 and v2 share the same database, caches and queues for minutes or hours.</li>
<li><strong>Clients you don't control</strong>: mobile apps and partner integrations update months later, or never.</li>
<li><strong>Data outlives code</strong>: rows from 2019, a Kafka topic retained for weeks, an archive of Avro or Parquet files: today's code must read all of them.</li>
<li><strong>Rollbacks</strong>: rolling back code never rolls back the data the new code already wrote.</li>
<li><strong>Team independence</strong>: producers and consumers owned by different teams can't upgrade in lockstep.</li>
</ul>
<p>So you need both directions: <strong>backward compatibility</strong> (new code reads old data) and <strong>forward compatibility</strong> (old code reads new data, ignoring and ideally preserving what it doesn't know).</p>
<p><strong>How it's done in practice</strong>: Protobuf/Thrift add fields as optional with new tags and never reuse tags; Avro adds or removes only fields with defaults and resolves the writer's schema against the reader's by name; JSON relies on conventions (tolerate missing fields, ignore unknown ones). Changes that can't be made compatible in one step (renames, type changes) go through expand/contract. A schema registry or a CI check such as <code>buf breaking</code> enforces the rules before anything ships.</p>`,
      followups: [
        "During a rolling deploy, which compatibility direction does each pair of versions need?",
        "How does a rollback change what you need?",
        "Which changes can't be made compatible in a single step, and how do you make them anyway?",
      ],
      pitfalls: [
        "Saying only backward compatibility matters",
        "Thinking a database migration makes old data disappear instantly",
        "Assuming 'just add a field' is always safe (strict decoders, whole-record rewrites)",
      ],
    },
    {
      id: "q04",
      q: "What's the difference between backward and forward compatibility?",
      diff: "easy",
      section: "why-encoding",
      a: `<p><strong>Backward compatibility: newer code can read data written by older code.</strong> Example: v2 adds an optional <code>photo_url</code>; reading a v1 record, v2 finds no value and uses the default.</p>
<p><strong>Forward compatibility: older code can read data written by newer code.</strong> Example: v1 receives a v2 Protobuf record with tag 4, which it has never seen; it reads the wire type, skips those bytes, keeps them as an unknown field and carries on.</p>
<p>Mnemonic: <em>backward</em> = new code looks back at old data; <em>forward</em> = old code copes with data from the future. Of the four combinations of code and data versions, old/old and new/new are trivial; new code on old data is backward, old code on new data is forward.</p>
<ul>
<li><strong>Forward is the harder one.</strong> The author of new code knows the old format and can handle it explicitly. Old code was written before the change, so it can only cope generically: skip unknown tags, ignore unknown JSON properties (Jackson fails on them by default), map unknown enum values to "unknown".</li>
<li><strong>Reading isn't the whole story.</strong> If old code decodes a record into its own model and writes it back whole, it must <strong>preserve</strong> the unknown fields, or forward compatibility turns into silent data loss.</li>
<li><strong>When each is needed</strong>: rolling deploys need both; rollbacks need forward (old code meets new data); reading archives needs backward; APIs whose servers deploy first need backward-compatible requests and forward-compatible responses.</li>
</ul>`,
      followups: [
        "Which direction does a rollback need?",
        "Give a change that is backward compatible but not forward compatible.",
        "Why is 'ignore unknown fields' not enough when old code also writes records?",
      ],
      pitfalls: [
        "Swapping the definitions",
        "Thinking that ignoring unknown fields is enough when old code rewrites whole records",
      ],
    },

    // --- language-specific-formats ---
    {
      id: "q-pickle-security",
      q: "Why shouldn't services exchange data using Java serialization or Python pickle?",
      diff: "easy",
      section: "language-specific-formats",
      a: `<p>Because they fail on four counts, and the last one is a security hole, not just an inconvenience.</p>
<ul>
<li><strong>Language lock-in</strong>: the bytes encode one language's classes, often tied to a library version. A Go or JavaScript service, or another company, can't read them, and long-lived data commits you to that language.</li>
<li><strong>Brittle versioning</strong>: a changed <code>serialVersionUID</code> throws <code>InvalidClassException</code>; renaming or moving a class can make stored data unreadable; there is no real story for forward or backward compatibility.</li>
<li><strong>Efficiency</strong>: Java's built-in format embeds class descriptors and is bulky and slow.</li>
<li><strong>Remote code execution</strong>: to rebuild objects, the decoder instantiates whatever classes the byte stream names and runs their hooks (<code>readObject</code>, or <code>hashCode</code> while a HashMap is rebuilt; <code>__reduce__</code> in pickle). An attacker who controls the bytes chains such hooks in ordinary libraries on the classpath ("gadget chains") into running commands. Frohoff and Lawrence demonstrated it in 2015 with ysoserial, and the Apache Commons Collections chain then yielded published exploits against Jenkins, WebLogic, WebSphere and JBoss. A type check <em>after</em> decoding is too late, because the damage happens during decoding.</li>
</ul>
<p><strong>What to do instead</strong>: exchange data in a language-neutral, data-only format (Protobuf, Avro or JSON with a schema). If you're stuck with a legacy system: never deserialize untrusted input, apply allow-list filters (JEP 290, JDK 9 and backported to 8u121; context-specific filters in JEP 415, JDK 17), and plan a migration. "Internal only" is not a defense: caches, queues and admin ports become reachable through other bugs.</p>
<p><strong>Bonus</strong>: the same issue hit machine learning. Pickle-based model checkpoints can run code when loaded, which is why Hugging Face created safetensors and PyTorch 2.6 made <code>torch.load</code> default to <code>weights_only=True</code>.</p>`,
      followups: [
        "Is it acceptable for a cache that only your own service reads and writes?",
        "How would you migrate a system that stores pickled blobs in a database without downtime?",
      ],
      pitfalls: [
        "Saying 'we validate the object after deserializing it' (the exploit runs during deserialization)",
        "Thinking TLS or encryption fixes the problem",
        "Only mentioning performance",
      ],
    },

    // --- textual-formats ---
    {
      id: "q03",
      q: "Why is JSON a poor choice for large-scale data exchange?",
      diff: "easy",
      section: "textual-formats",
      a: `<p>JSON isn't wrong at scale, but it charges you in four ways that add up when you move billions of records:</p>
<ul>
<li><strong>Size</strong>: without a schema, every record repeats every field name and spells numbers out in decimal. The book's example record is 81 bytes as JSON versus 32–34 bytes in Avro, Protobuf or Thrift Compact, about 2.4x before compression. The ratio depends on the data (records with many short values and long field names gain the most), and gzip narrows the gap, at a CPU cost.</li>
<li><strong>Parsing cost</strong>: turning text into numbers and strings is slower than reading length-prefixed binary fields.</li>
<li><strong>Weak types</strong>: no integer/float distinction, and many parsers (JavaScript's included) decode numbers as doubles, so integers above 2^53 silently change. There's no binary type, so bytes need Base64 (+33%). There's no standard for dates or decimals.</li>
<li><strong>No enforced schema</strong>: JSON Schema is optional, so the real contract lives in every consumer's parsing code, and nothing checks compatibility before a change ships.</li>
</ul>
<p><strong>Where JSON is still the right call</strong>: public APIs, browsers, config, low-volume or cross-organization interchange, anywhere readability and universal tooling beat efficiency. For high-volume internal pipelines, use Protobuf or Avro with a schema registry, and Parquet for analytic files.</p>`,
      followups: [
        "Would gzip make JSON good enough?",
        "When would you still choose JSON for internal traffic?",
      ],
      pitfalls: [
        "Quoting a universal size ratio",
        "Saying the JSON spec limits integers to 53 bits (the parsers do)",
      ],
    },
    {
      id: "q-big-ids-json",
      q: "Your API returns 64-bit order IDs as JSON numbers, and the web client reports 'order not found' for some orders but not others. What's going on and how do you fix it without breaking existing clients?",
      diff: "medium",
      section: "textual-formats",
      a: `<p><strong>Diagnosis</strong>: JavaScript's <code>JSON.parse</code> decodes every number as an IEEE-754 double, which has a 53-bit significand. Integers up to 2^53 (9,007,199,254,740,992) are exact; above that, not every integer exists as a double, so the parser silently rounds: <code>9007199254740993</code> becomes <code>9007199254740992</code>. Even an ID that happens to be exactly representable can come back different, because JavaScript prints the shortest decimal that maps to the same double: 1050118621198921728 prints as 1050118621198921700. The client builds <code>/orders/&lt;rounded id&gt;</code> and asks for a different order, with no error anywhere.</p>
<p><strong>Why it's intermittent</strong>: only IDs above 2^53 break. Development databases with small sequential IDs never trigger it; production IDs that pack a timestamp into the high bits (Snowflake-style) mostly do. The JSON spec itself sets no precision limit (RFC 8259 leaves it to implementations), and the Go or Java server is fine: the client's parser is the problem.</p>
<p><strong>Fix without breaking anyone</strong> (expand/contract):</p>
<ol>
<li>Add a string copy alongside the number (<code>"id": 1050118621198921728, "id_str": "1050118621198921728"</code>), as Twitter's API did.</li>
<li>Migrate clients to use the string and treat IDs as opaque strings (never parse them as numbers).</li>
<li>Track which clients still read the numeric field; deprecate it, or drop it in a new API version once telemetry shows old clients are gone.</li>
</ol>
<p>For new APIs, return IDs as strings from day one, as Discord does. If a client really needs arithmetic, use a BigInt-aware parser; <code>JSON.parse</code> never produces BigInt. Check the other consumers too: logs, analytics pipelines and spreadsheets round the same way.</p>`,
      followups: [
        "Why didn't this show up in testing?",
        "Would switching the server to float64 or decimal help?",
        "How do you roll the change out to mobile apps that update slowly?",
      ],
      pitfalls: [
        "Blaming the database or caching",
        "Changing the field's type in place (breaks every existing client)",
        "Assuming the JSON spec limits integers to 53 bits (it's the parsers)",
      ],
    },

    // --- thrift-protobuf ---
    {
      id: "q-protobuf-encoding",
      q: "How does Protocol Buffers encode a record, and why is it so much smaller than JSON?",
      diff: "medium",
      section: "thrift-protobuf",
      a: `<p>A Protobuf message is a sequence of fields, each written as a <strong>key</strong> followed by a value. The key is a varint holding <code>(field_number &lt;&lt; 3) | wire_type</code>. <strong>Field names never appear</strong>; the schema maps numbers back to names.</p>
<ul>
<li><strong>Wire types</strong> tell a reader where a value ends, even for a field it doesn't know: VARINT (0), I64 (1, 8 bytes), LEN (2: a varint length, then that many bytes, used for strings, bytes, nested messages and packed repeated numerics), I32 (5, 4 bytes).</li>
<li><strong>Varints</strong>: 7 payload bits per byte, low group first, high bit set when more bytes follow. 1337 → <code>b9 0a</code>.</li>
<li><strong>Repeated fields</strong>: the key repeats for each string or message element; numeric elements are packed into one LEN run (the proto3 default).</li>
<li><strong>Negative numbers</strong>: plain <code>int64</code> encodes −1 as 10 bytes; <code>sint64</code> zigzags it to 1 byte.</li>
</ul>
<p><strong>The book's example</strong>: <code>0a 06 "Martin"</code> (field 1, LEN, length 6), <code>10 b9 0a</code> (field 2, VARINT, 1337), <code>1a 0b "daydreaming" 1a 07 "hacking"</code> (field 3 twice): 33 bytes, versus 81 for JSON. Thrift's CompactProtocol takes 34 bytes and BinaryProtocol 59; Avro, which drops the keys too, takes 32.</p>
<p>Details worth mentioning: <code>required</code>/<code>optional</code> don't change the bytes; unset fields cost nothing; fields 1–15 have one-byte keys, so give them to frequent fields; and <code>protoc --decode_raw</code> can show tags and values without the schema, but not names or meanings.</p>`,
      followups: [
        "How does an old reader skip a field it has never seen?",
        "When would you choose sint64 or fixed64 over int64?",
        "What can you learn from the bytes without the .proto file?",
      ],
      pitfalls: [
        "Saying field names are encoded (that's JSON and MessagePack)",
        "Thinking 'required' or 'optional' changes the bytes",
        "Using int64 for values that are often negative",
      ],
    },

    // --- field-tags-evolution ---
    {
      id: "q08",
      q: "What goes wrong if you deploy code that writes a new required field, before upgrading readers?",
      diff: "hard",
      section: "field-tags-evolution",
      a: `<p>Separate the two directions first, because the danger isn't where most people look.</p>
<ul>
<li><strong>Old readers seeing the new field (forward)</strong>: Protobuf and Thrift skip an unknown tag using its wire type, and Avro ignores a writer's field the reader doesn't have. So reading is fine. The real risks are old code that decodes into its own model and rewrites the whole record (it drops the field unless it preserves unknown fields), and strict JSON decoders that throw on unknown properties (Jackson's default).</li>
<li><strong>New readers seeing old data (backward)</strong>: this is what a <em>required</em> field breaks. Every record written before the change lacks it, so proto2 parsing fails with a missing-required-field error, and an Avro reader field without a default fails resolution. The writers you just deployed are usually readers too, so they start rejecting existing rows, queued messages and requests from old clients. A schema registry in BACKWARD mode would have refused the schema at registration.</li>
<li><strong>It's also permanent</strong>: once a field is required, removing it or making it optional breaks every old reader that still insists on it ("required is forever"), which is why proto3 dropped <code>required</code>. In Avro, removing a default later breaks reading of any data that still lacks the field.</li>
</ul>
<p><strong>The correct rollout (expand/contract)</strong>:</p>
<ol>
<li>Add the field as optional with a sensible default (in proto3, use <code>optional</code> or a wrapper if "absent" must differ from zero).</li>
<li>Deploy readers that tolerate its absence and preserve it when they rewrite records.</li>
<li>Deploy writers that set it.</li>
<li>Backfill old data in throttled batches, if historical records need it.</li>
<li>Enforce presence in application validation (reject requests without it at the API layer), not in the wire schema.</li>
</ol>
<p>Rules of thumb: never add a required field, never remove one, never reuse a tag, and roll readers out before writers.</p>`,
      followups: [
        "What if the field must always be present for business reasons?",
        "How would a schema registry or a CI check have caught this?",
      ],
      pitfalls: [
        "Making the field required in the wire schema",
        "Upgrading writers before readers can preserve the field",
        "Claiming old binary-format readers crash on the unknown field (they skip it)",
      ],
    },
    {
      id: "q-tag-reuse",
      q: "In Protobuf, why must you never reuse a field number, and how do you prevent it?",
      diff: "medium",
      section: "field-tags-evolution",
      a: `<p>Because <strong>the field number is the field's identity on the wire</strong>. The bytes contain only number, wire type and value; names never appear. And old data and old code outlive the deletion: rows in databases, messages in logs and queues, cache entries, backups, servers that haven't been upgraded, mobile apps that never will be.</p>
<ul>
<li><strong>Same wire type</strong>: no error at all. Say <code>int64 favorite_number = 2</code> was deleted and someone adds <code>int64 referrer_id = 2</code>. New code reads old records and gets referrer_id = 1337; old code reads new records and gets favorite_number = 4242. Silent corruption in both directions.</li>
<li><strong>Different wire type</strong>: the parser typically can't use the value and files it under unknown fields, so the field silently reads as unset.</li>
<li><strong>Renumbering</strong> an existing field is the same mistake: to a parser it's a deletion plus a new field, so data under the old number is skipped both ways.</li>
</ul>
<p><strong>Prevention</strong>:</p>
<ul>
<li>When deleting, add <code>reserved 2;</code> and <code>reserved "favorite_number";</code>, which turns reuse into a compile error.</li>
<li>Run a breaking-change check in CI (<code>buf breaking</code> against the main branch).</li>
<li>Require review from the schema's owners for <code>.proto</code> changes; mark fields <code>[deprecated = true]</code> before deleting them.</li>
<li>Apply the same rule to enum numbers.</li>
</ul>
<p>An operational analogy: at Knight Capital in 2012, a repurposed flag meant something different to the one server still running old code, and the firm lost more than $440 million in about 45 minutes.</p>`,
      followups: [
        "Which type changes are safe in place, and which aren't?",
        "What does proto3 do with unknown fields, and why does it matter for proxies?",
        "Why did proto3 remove required fields?",
      ],
      pitfalls: [
        "'We deleted all the old data, so it's fine' (caches, queues, backups, old clients)",
        "Confusing renaming (safe on the wire) with renumbering (breaking)",
        "Assuming the parser will throw an error",
      ],
    },
    {
      id: "q-enum-value-added",
      q: "Is adding a new value to an enum a breaking change?",
      diff: "medium",
      section: "field-tags-evolution",
      a: `<p><strong>It depends on the readers, and that's the point.</strong> On the wire it looks additive, but old code has never seen the value and must do <em>something</em> with it. New code reading old data is always fine; the question is old code reading new data.</p>
<ul>
<li><strong>Protobuf proto2</strong> (closed enums): in C++ and Java, an unrecognized number is moved into the unknown fields and the field reads as its default. Silently wrong: a TEAM plan shows up as FREE.</li>
<li><strong>Protobuf proto3</strong> (open enums): the raw number is kept; Java exposes it as <code>UNRECOGNIZED</code>. Better, but your switch statement still has to handle it.</li>
<li><strong>Avro</strong>: a writer's symbol that isn't in the reader's enum is a resolution error, unless the reader's enum declares a default symbol (Avro 1.9+).</li>
<li><strong>JSON APIs</strong>: strict decoders throw (Swift Codable enums, Jackson's default enum handling), and lenient code falls into an else branch and misbehaves, for example showing a "pending" payment as failed.</li>
</ul>
<p><strong>Practices</strong>:</p>
<ul>
<li>Make value 0 an <code>UNSPECIFIED</code> sentinel (proto3 requires the first value to be 0, and it's the default).</li>
<li>Never reuse or renumber enum values; reserve removed ones.</li>
<li>In every reader, map unknown values to an explicit "unknown" case and never let the default branch mean "failed".</li>
<li>Upgrade readers before writers start emitting the new value.</li>
<li>For public APIs, either declare enums open-ended in the contract from the start, or gate new values behind a version.</li>
</ul>`,
      followups: [
        "How would you roll out a new order status across ten services that all switch on it?",
        "What does an old proto2 reader do if it rewrites a record holding the new value?",
      ],
      pitfalls: [
        "'It's additive, so it's safe'",
        "Using the default case of a switch to mean 'everything else is failed'",
        "Renumbering enum values to keep them sorted",
      ],
    },

    // --- avro ---
    {
      id: "q02",
      q: "Compare Protobuf, Thrift, and Avro.",
      diff: "hard",
      section: "avro",
      a: `<p>All three are schema-driven binary formats with code generation. They differ in <strong>how the bytes identify fields</strong>, and that drives everything else.</p>
<ul>
<li><strong>Protocol Buffers</strong> (Google, 2008): each field is a varint key (field number + wire type) plus a value. 33 bytes for the book's example. Tags are assigned by hand: add optional fields with new tags, never reuse numbers. Unknown fields are skipped and preserved. proto3 dropped <code>required</code>. It's the default encoding for gRPC.</li>
<li><strong>Thrift</strong> (Facebook, 2007): the same tag idea with several encodings, mainly BinaryProtocol (59 bytes: type byte, 2-byte tag, fixed-width integers and lengths) and CompactProtocol (34 bytes: tag delta and type share one byte, zigzag varints). It has a real, nestable list type and its own RPC stack, often over raw TCP.</li>
<li><strong>Avro</strong> (Hadoop, 2009): no tags and no types in the bytes, just values in the writer's schema order. At 32 bytes it is the most compact, because records carry no tags or types and the schema is stored once per file or referenced by an ID. The reader needs the <strong>exact writer's schema</strong> and resolves it against its own reader's schema by field name.</li>
</ul>
<p><strong>Evolution differences</strong>:</p>
<ul>
<li>Adding and removing: Protobuf/Thrift need optional fields and fresh tags; Avro needs fields with defaults.</li>
<li>Renaming: free on the wire in Protobuf/Thrift (it breaks the JSON mapping and code); Avro needs aliases in the reader's schema, which are backward-compatible only.</li>
<li>Code generation: central to Protobuf/Thrift; optional in Avro, which is friendly to dynamically generated schemas and dynamically typed languages.</li>
<li>Decoding a single record: Protobuf/Thrift need only the schema compiled into the reader; Avro needs to know which writer's schema produced it (container file header, version prefix, registry ID).</li>
</ul>
<p><strong>When to pick which</strong>: Protobuf for service contracts (gRPC) and mobile clients; Thrift mostly if you're already in its ecosystem (Meta maintains fbthrift); Avro for Hadoop and data-lake files, Kafka with a schema registry, and schemas generated from databases (dumps, change data capture).</p>`,
      followups: [
        "Where does the Avro reader get the writer's schema?",
        "Why are tag numbers a problem for schemas generated from a database?",
        "Why does the 1-byte difference between Protobuf and Avro not matter, and what does?",
      ],
      pitfalls: [
        "Calling Avro schemaless",
        "Treating the size gap between the binary formats as the deciding factor (dropping names from JSON is the big win)",
      ],
    },
    {
      id: "q05",
      q: "How does Avro handle schema evolution if there are no field tags?",
      diff: "hard",
      section: "avro",
      a: `<p>With <strong>two schemas</strong>. The <strong>writer's schema</strong> is exactly the one used to encode the data; the <strong>reader's schema</strong> is the shape the application wants. Avro decodes the bytes in the writer's field order (they're just values: lengths, zigzag varints, union branch indexes), then resolves the result into the reader's schema by <strong>field name</strong>:</p>
<ul>
<li><strong>Field order is irrelevant</strong>; fields are matched by name.</li>
<li>A field in the writer's schema but not the reader's → <strong>ignored</strong>.</li>
<li>A field in the reader's schema but not the writer's → filled with the <strong>reader's default</strong>; if it has no default, decoding <strong>fails</strong>.</li>
<li>Hence the rule: add or remove only fields with defaults. Adding one without a default breaks backward compatibility; removing one without a default breaks forward compatibility.</li>
<li><strong>Renames</strong> use aliases in the reader's schema, which are backward-compatible only: old readers can't find their field in data written under the new name.</li>
<li><strong>Nullability</strong> is a union with null; a union's default must match its first branch (relaxed in Avro 1.12 to the first matching branch), so a null default goes with null listed first. Adding a branch to a union is backward-compatible only.</li>
<li><strong>Type changes</strong>: only promotions (int → long/float/double, long → float/double, float → double, string ↔ bytes).</li>
</ul>
<p><strong>Where the writer's schema comes from</strong>, since the bytes are useless without it:</p>
<ul>
<li>Object container files: once in the file header.</li>
<li>Databases of individually written records: a schema version number before each record (LinkedIn's Espresso).</li>
<li>Network connections: negotiated at connection setup (Avro RPC).</li>
<li>Kafka: a 5-byte prefix (magic byte 0 + 4-byte schema registry ID).</li>
</ul>
<p>Per-record overhead stays tiny, and because matching is by name, schemas generated from database tables can simply be regenerated when columns change.</p>`,
      followups: [
        "What happens if a reader field has no default?",
        "What happens if you decode with the wrong writer's schema?",
      ],
      pitfalls: [
        "Saying aliases make renames compatible in both directions",
        "Forgetting that the reader needs the exact writer's schema",
      ],
    },
    {
      id: "q-avro-vs-protobuf-evolution",
      q: "Compare how Protobuf and Avro handle adding, removing and renaming fields. When would you choose Avro?",
      diff: "hard",
      section: "avro",
      a: `<p><strong>The root difference</strong>: Protobuf identifies fields by <strong>tag numbers</strong> written into the bytes; Avro writes <strong>no identifiers</strong>, decodes with the writer's schema and resolves by <strong>name</strong> into the reader's schema.</p>
<ul>
<li><strong>Add</strong>. Protobuf: a new optional field with a new tag; old code skips it (and preserves it), new code defaults it. Avro: the new field must have a default; without one, new readers can't read old data (breaks backward).</li>
<li><strong>Remove</strong>. Protobuf: only optional fields, and reserve the tag and name. Avro: only fields with a default; otherwise old readers, which still expect the field, fail on new data (breaks forward).</li>
<li><strong>Rename</strong>. Protobuf: free on the wire, but it breaks the JSON mapping, text format and code. Avro: aliases in the reader's schema; backward-compatible only.</li>
<li><strong>Other differences</strong>: adding a union branch in Avro is backward-only; a null default goes with null listed first in the union; Avro allows only promotions (int → long → float → double, string ↔ bytes), whereas Protobuf int32 → int64 is readable by new code but truncated by old code.</li>
<li><strong>Schema at read time</strong>: Avro needs the exact writer's schema (container file header, version prefix, registry ID); Protobuf can decode with whatever compatible schema the reader has.</li>
</ul>
<p><strong>Choose Avro</strong> for schemas generated by machines (database dumps, CDC: regenerate the schema when columns change, and nobody has to assign tags), for Hadoop and data-lake files (self-describing container files), and for Kafka with a schema registry. <strong>Choose Protobuf</strong> for hand-written RPC contracts with code generation, mobile clients, and anywhere a record must be decoded without a schema service.</p>`,
      followups: [
        "Where does an Avro consumer in Kafka get the writer's schema?",
        "What does BACKWARD_TRANSITIVE add over BACKWARD?",
        "Why is Avro's encoding smaller than Protobuf's?",
      ],
      pitfalls: [
        "Calling Avro 'schemaless'",
        "Saying aliases make renames compatible in both directions",
        "Forgetting that Avro needs the writer's schema at read time",
      ],
    },

    // --- merits-of-schemas ---
    {
      id: "q-choose-format",
      q: "How would you choose an encoding format for a new system? Walk through the criteria and give your picks for a few common cases.",
      diff: "medium",
      section: "merits-of-schemas",
      a: `<p>Start from who writes the bytes, who reads them, in which languages and for how long; the format follows from that. Six questions decide it:</p>
<ul>
<li><strong>Evolution</strong>: old and new versions will coexist, so does the format support both directions, with rules a machine can check? Protobuf and Thrift (optional fields, fresh tags) and Avro (fields with defaults) do; built-in language serialization doesn't.</li>
<li><strong>Who reads it</strong>: browsers, partners and unknown clients favor JSON; services you own can share a <code>.proto</code> file or a schema registry.</li>
<li><strong>Size and speed</strong>: matter at high volume (the book's record is 81 bytes as JSON versus 32 to 34 in Avro, Protobuf and Thrift's CompactProtocol), much less at low volume or after compression.</li>
<li><strong>Readability</strong>: JSON can be read with curl and a text editor; binary formats need tools and the schema.</li>
<li><strong>Type fidelity</strong>: 64-bit integers, decimals, binary data and timestamps are weak spots in JSON.</li>
<li><strong>Safety</strong>: never decode untrusted input with a format that can instantiate arbitrary classes.</li>
</ul>
<p><strong>Typical picks</strong>:</p>
<ul>
<li>Public API or browser clients: JSON over HTTP described with OpenAPI, IDs as strings, published tolerance rules.</li>
<li>Internal service calls: Protobuf with gRPC (typed contracts, generated code, deadlines), with a breaking-change check such as <code>buf breaking</code> in CI.</li>
<li>Event streams shared by many teams: Avro or Protobuf with a schema registry in a transitive compatibility mode.</li>
<li>Database dumps, change data capture and other machine-generated schemas: Avro, because nobody has to assign and guard tags.</li>
<li>Files for analytics: Parquet (columnar), or Avro container files for row-oriented data.</li>
<li>Caches and queues between your own services: still a language-neutral format, never pickle or Java serialization.</li>
</ul>
<p>Mixing is normal: JSON at the edge, Protobuf inside, Avro or Parquet in the data lake. What matters more than the pick is having explicit compatibility rules and an automated check that enforces them.</p>`,
      followups: [
        "Why not use JSON everywhere and gzip it?",
        "When is Avro a better fit than Protobuf?",
        "What would make you consider a zero-copy format such as FlatBuffers or Cap'n Proto?",
      ],
      pitfalls: [
        "Choosing on payload size alone",
        "Using a language-specific format for anything that is stored or shared",
        "Never saying how the schema will evolve or what checks that it stays compatible",
      ],
    },
    {
      id: "q-kafka-schema-governance",
      q: "Design schema evolution for a Kafka platform shared by 50 producer and consumer teams.",
      diff: "hard",
      section: "merits-of-schemas",
      a: `<p><strong>1. A schema registry is mandatory.</strong> One subject per topic (Confluent's default naming is <code>&lt;topic&gt;-value</code>; use record-name subjects if a topic carries several event types). Every message carries the 5-byte prefix (magic byte 0 + 4-byte schema ID); consumers fetch each schema once and cache it. Pick Avro or Protobuf for compactness and strong evolution rules; JSON Schema if teams need human-readable payloads.</p>
<p><strong>2. Choose compatibility modes deliberately</strong>, because each implies a deploy order: BACKWARD → upgrade consumers first; FORWARD → producers first; FULL → any order. With 50 teams you can't coordinate deploy order, and consumers replay retained history, so default to <strong>FULL_TRANSITIVE</strong> (or BACKWARD_TRANSITIVE where consumers reliably upgrade first). Non-transitive checks only compare against the latest version, which isn't enough when months of data are retained.</p>
<p><strong>3. Shift checks left.</strong> Run the registry's compatibility check (or <code>buf breaking</code> for Protobuf) in CI on every schema change, not just at produce time. Disable auto-registration in producers (<code>auto.register.schemas=false</code>) so only CI registers schemas.</p>
<p><strong>4. A path for breaking changes.</strong> Treat them as a new topic or event type: dual-publish old and new for a migration window, move consumers over with lag dashboards, then retire the old topic. Never edit a schema in place to "fix" it.</p>
<p><strong>5. Runtime safety.</strong> Stream processors that consume and republish must preserve unknown fields. Send poison messages to a dead-letter topic instead of blocking a partition.</p>
<p><strong>6. Ownership and semantics.</strong> Every schema has an owning team and reviewers; document units and meaning in the schema itself (<code>amount_cents</code>, not <code>amount</code>), because types don't catch semantic mistakes, as the Mars Climate Orbiter's unit mix-up showed.</p>`,
      followups: [
        "A team must make a breaking change. Walk through the migration.",
        "A consumer reprocesses from offset 0 after a bug fix. What can go wrong?",
        "How do you stop a producer from bypassing the registry?",
      ],
      pitfalls: [
        "Choosing NONE 'for flexibility'",
        "Using non-transitive checks while retaining months of data",
        "Ignoring deploy order",
      ],
    },

    // --- dataflow-databases ---
    {
      id: "q-rolling-upgrade-field-loss",
      q: "During a rolling deploy, a field that the new version writes keeps disappearing from some records. Diagnose and fix it.",
      diff: "medium",
      section: "dataflow-databases",
      a: `<p><strong>Likely cause</strong>: instances still on the old version read records written by the new version, decode them into model objects that have no slot for the field (an ORM entity, a DTO, a typed JSON mapping), change something else and write the <strong>whole object</strong> back. The new field is gone: no error, no log line. The format may be "forward compatible" in that old code can read new data, but ignoring a field isn't preserving it.</p>
<p><strong>Be precise about where this happens</strong>: on whole-record writes of encoded values (a document replaced in full, a JSON or Protobuf blob in a key-value store or cache, a GET-modify-PUT through an API). A relational UPDATE that names only the columns v1 knows leaves a v1-unknown column alone. So the first diagnostic question is "what does the write path look like?"</p>
<p><strong>Confirm it</strong>: correlate the lost values with writes served by old-version instances (version tags in request logs or on the records themselves).</p>
<p><strong>Fix</strong>:</p>
<ul>
<li><strong>Preserve unknown fields end to end</strong>: Protobuf does it by default (proto3 since 3.5); configure JSON mappers to keep extra properties and write them back.</li>
<li><strong>Write only what changed</strong>: a column-level UPDATE, a JSON merge patch, field masks.</li>
<li><strong>Stage the rollout (expand/contract)</strong>: first ship a version that tolerates and preserves the field everywhere, and only then a version that writes it.</li>
<li><strong>Remember rollbacks</strong>: rolling back reintroduces old code against new data, so the preserving version must be your rollback target.</li>
</ul>`,
      followups: [
        "How would you catch this in testing before production?",
        "What changes if the 'old version' is a mobile app that syncs objects back to your API?",
        "How does this interact with optimistic concurrency control?",
      ],
      pitfalls: [
        "Blaming replication lag or caching",
        "Assuming a forward-compatible format means no data loss (ignoring is not preserving)",
        "Proposing a big-bang migration",
      ],
    },
    {
      id: "q-zero-downtime-rename",
      q: "How do you rename a database column (or a field in stored documents) with zero downtime, when servers are deployed in a rolling fashion and a deploy might be rolled back?",
      diff: "medium",
      section: "dataflow-databases",
      a: `<p>Not with <code>ALTER TABLE ... RENAME COLUMN</code> in the same deploy as the code change: the instant it runs, every server still on the old version (and any rollback target) breaks. Use <strong>expand/contract</strong> (parallel change), one compatible step per deploy:</p>
<ol>
<li><strong>Expand</strong>: add the new column as nullable (or the new field as optional with a default).</li>
<li><strong>Dual write</strong>: deploy code that writes both columns and reads the new one, falling back to the old.</li>
<li><strong>Backfill</strong> old rows in small, throttled batches (avoid one giant transaction: locks and replication lag).</li>
<li><strong>Switch reads</strong> to the new column only.</li>
<li><strong>Stop writing the old column</strong>, but only once no running version, including the rollback target, still reads it.</li>
<li><strong>Contract</strong>: drop the old column, ideally after the rollback window has closed.</li>
</ol>
<p>Each deploy must be compatible with the one before and after it, because rolling deploys and rollbacks run adjacent versions side by side.</p>
<p><strong>Tooling notes</strong>: adding a column is metadata-only in PostgreSQL 11+ (with a non-volatile default) and MySQL 8.0.12+ (<code>ALGORITHM=INSTANT</code>). Changes that rewrite large tables go through online schema-change tools such as gh-ost. Stripe's "Online migrations at scale" post describes the same dual-writing pattern for moving data between models.</p>
<p><strong>For encoded records</strong>: an Avro rename via reader aliases is backward-compatible only, so treat it as expand/contract too; a Protobuf rename is free on the wire but breaks the JSON mapping and any code that uses the name.</p>`,
      followups: [
        "How many deploys does this take, and why can't you merge steps 2 and 5?",
        "How do you know the backfill is complete and stays complete?",
        "What changes if mobile clients read this field through your API?",
      ],
      pitfalls: [
        "Running ALTER TABLE ... RENAME COLUMN in the same deploy as the code change",
        "Dropping the old column before the rollback window has closed",
        "Backfilling in one giant transaction (locks, replication lag)",
      ],
    },

    // --- dataflow-services ---
    {
      id: "q06",
      q: "Contrast REST and RPC. When would you pick each?",
      diff: "medium",
      section: "dataflow-services",
      a: `<p><strong>REST</strong> is an architectural style (Fielding, 2000), not a protocol: resources identified by URLs, HTTP's methods and status codes, plus HTTP's caching, authentication and content negotiation; usually JSON, often described with OpenAPI. Strengths: easy to try and debug (curl, a browser), supported by every language, a huge ecosystem of caches, proxies, gateways and monitoring, and it doesn't pretend the network isn't there. Weaknesses: verbose text encodings, optional schemas, chattiness for fine-grained calls.</p>
<p><strong>SOAP</strong>, the third style, is an XML-based protocol with WSDL and the WS-* standards; it depends heavily on code-generation tools, had interoperability problems between vendors, and survives mostly in large enterprises.</p>
<p><strong>RPC frameworks</strong> (gRPC: Protobuf over HTTP/2 with unary and streaming calls and deadlines; Thrift, often over raw TCP; Finagle; Rest.li) give a typed contract with generated stubs and a compact binary encoding. Weaknesses: you need tooling to inspect traffic, browsers need gRPC-Web, and the "it's just a function call" illusion invites bad code.</p>
<p><strong>That illusion is the key caveat</strong>: a remote call can be lost, can time out with an unknown outcome, can run twice when retried, has variable latency, must encode every argument and may cross languages. Good frameworks make this explicit (futures, deadlines, idempotency keys); <a href="#/ch8/learn/unreliable-networks">ch8</a> explores it in depth.</p>
<p><strong>Evolution is the same problem either way</strong>: servers deploy first, so requests must be backward compatible and responses forward compatible. gRPC inherits Protobuf's tag rules; JSON relies on clients ignoring unknown fields and enum values, which strict decoders don't do. The <a href="#/viz/ch4/api-evolution">api-evolution visualization</a> shows a Jackson-based client breaking on a new response field, and versioning saving clients from renames.</p>
<p><strong>Rule of thumb</strong>: REST/JSON for public APIs and browser-facing endpoints, where reach and tooling matter most; gRPC for internal service-to-service calls where you control both sides and efficiency, streaming and strict contracts matter. Many companies use both: gRPC inside, a REST or GraphQL gateway at the edge.</p>`,
      followups: [
        "How do you make retries safe?",
        "How do you version a public REST API?",
      ],
      pitfalls: [
        "Calling REST a protocol",
        "Assuming gRPC removes network failure modes",
      ],
    },
    {
      id: "q-remote-vs-local",
      q: "Why is 'make a remote call look like a local function call' a flawed abstraction, and how do modern RPC frameworks deal with it?",
      diff: "medium",
      section: "dataflow-services",
      a: `<p>Because a network call differs from a local call in ways the caller can't ignore:</p>
<ul>
<li><strong>It can fail in ways a local call can't</strong>: the request or response can be lost, and the remote node can be slow or down, outside your control.</li>
<li><strong>A timeout tells you nothing</strong>: the action may have run, partly run, or not run at all.</li>
<li><strong>Retries can execute it twice</strong> if only the response was lost, unless the operation is idempotent or the protocol deduplicates.</li>
<li><strong>Latency</strong> is orders of magnitude higher and wildly variable.</li>
<li><strong>Arguments must be encoded</strong>: no pointers to shared memory, and large objects are expensive to send.</li>
<li><strong>Types must be translated</strong> across languages (a 64-bit integer becomes a lossy double in JavaScript).</li>
</ul>
<p>This was argued in "A Note on Distributed Computing" (Waldo et al., Sun, 1994) and learned painfully with CORBA, DCOM, Java RMI and EJB. Part of REST's appeal is that it doesn't pretend.</p>
<p><strong>How modern frameworks cope: they make the network explicit.</strong></p>
<ul>
<li>Futures and promises (Finagle, Rest.li) make the asynchronous, failure-prone result visible and let you compose parallel calls.</li>
<li>Deadlines and cancellation propagate across call chains (gRPC), so a slow dependency can't hold every caller hostage.</li>
<li>Streaming, service discovery, retries with backoff, and status codes that distinguish "failed" from "unknown".</li>
<li>Safe retries need idempotent design or idempotency keys (Stripe's <code>Idempotency-Key</code> header returns the first result on a retry).</li>
</ul>
<p>The failure modes are explored hands-on in <a href="#/ch8/learn/unreliable-networks">ch8</a>, and end-to-end deduplication in <a href="#/ch12/learn/end-to-end-argument">ch12</a>.</p>`,
      followups: [
        "How would you make a 'charge card' RPC safe to retry?",
        "What is deadline propagation and why does it matter in a call chain?",
        "When would you still choose RPC over REST?",
      ],
      pitfalls: [
        "'Just retry on timeout'",
        "Claiming exactly-once delivery solves it without explaining deduplication",
        "Treating the timeout as proof the request failed",
      ],
    },
    {
      id: "q-public-api-versioning",
      q: "Design the versioning strategy for a public payments API used by thousands of merchants who rarely update their integrations.",
      diff: "hard",
      section: "dataflow-services",
      a: `<p><strong>1. Prefer additive changes that need no new version</strong>: new optional request parameters, new response fields, new endpoints. They ship to every version, so they are safe only if clients cooperate. Strict decoders turn "additive" into "breaking": Jackson fails on unknown properties by default, and Swift Codable throws on unknown enum values. Publish tolerance rules in the contract from day one (ignore unknown fields, treat enums as open-ended, don't depend on field order).</p>
<p><strong>2. Gate breaking changes behind versions</strong> (required parameters, renames, type changes, removals, new meanings). The options: a URL version (<code>/v1</code>), a header version, or Stripe-style <strong>per-account pinned dates</strong>, where each account stays on the version current at its first request and can override per request. Pinned dates suit merchants who never touch their code.</p>
<p><strong>3. Implement versions as transformations at the edge.</strong> The core speaks only the newest contract; small version-change modules rewrite requests up and responses down for older pins. That avoids <code>if (version &lt; X)</code> branches throughout the codebase. Some changes can't be translated back (a new payment state older clients have no word for), so decide those carefully.</p>
<p><strong>4. Manage the lifecycle</strong>: per-version and per-client usage telemetry (the only way to know who still reads a field), changelogs, upgrade guides, deprecation timelines, and outreach before retiring anything.</p>
<p><strong>5. Don't forget the other channels</strong>: webhook and event payloads need versioning too (per endpoint, as Stripe does); idempotency keys make retried POSTs safe; and never give an existing field a new meaning.</p>`,
      followups: [
        "How do you keep the codebase from filling up with version branches?",
        "How do webhooks complicate versioning?",
        "Is adding a new enum value a breaking change?",
        "A partner's integration broke when you added a response field. Whose bug is it, and what do you change?",
      ],
      pitfalls: [
        "Bumping the major version for every change",
        "Treating new enum values as automatically safe",
        "No plan for retiring old versions",
      ],
    },

    // --- dataflow-messages ---
    {
      id: "q07",
      q: "Why are message brokers useful compared to direct service calls?",
      diff: "medium",
      section: "dataflow-messages",
      a: `<p>A broker sits between sender and receiver and stores messages temporarily, which decouples them <strong>in time</strong> and <strong>in space</strong>. Communication is usually one-way and asynchronous: the sender hands off the message and moves on; replies, if any, come back on a separate queue.</p>
<ul>
<li><strong>Buffering</strong>: if the consumer is down, restarting or overloaded, messages wait instead of failing the sender.</li>
<li><strong>Redelivery</strong>: a message given to a consumer that crashed is delivered again, so it isn't lost.</li>
<li><strong>No addressing</strong>: the sender doesn't need the consumer's IP and port, which matters when VMs and containers come and go.</li>
<li><strong>Fan-out</strong>: one message can go to several consumers.</li>
<li><strong>Logical decoupling</strong>: the producer publishes and doesn't know or care who consumes; consumers scale independently and read at their own rate.</li>
<li><strong>Replay</strong>: log-based brokers such as Kafka retain messages, so a new or fixed consumer can reprocess history.</li>
</ul>
<p><strong>What you give up</strong>: an immediate response and simple error handling. The sender can't know whether processing succeeded, so failures surface later, and "exactly once" processing needs deduplication or transactions (<a href="#/ch11/learn/messaging-systems">ch11</a>).</p>
<p><strong>Encoding still matters</strong>: a broker carries opaque bytes, so with backward- and forward-compatible encodings producers and consumers can deploy in any order. Consumers that republish must preserve unknown fields, and retained history means consumers must read every schema version still in the log, which is why registries offer transitive compatibility.</p>`,
      followups: [
        "What do you lose compared to RPC?",
        "How do you evolve message schemas?",
      ],
      pitfalls: [
        "Claiming brokers guarantee exactly-once processing by default",
        "Forgetting that a broker doesn't remove the need for compatible encodings",
      ],
    },
    {
      id: "q-actor-model",
      q: "What is the actor model, and what changes when actors are distributed across machines?",
      diff: "medium",
      section: "dataflow-messages",
      a: `<p>The <strong>actor model</strong> is a model for concurrency. Instead of threads sharing memory under locks, logic lives in <strong>actors</strong>: each owns private state that nothing else can touch, has a mailbox, handles one message at a time (so it needs no locks) and talks to other actors only by sending asynchronous messages. A scheduler runs many actors on a few threads. Delivery isn't guaranteed, so actor code is written from the start to cope with lost messages.</p>
<p>A <strong>distributed actor framework</strong> (Akka and its fork Apache Pekko, Microsoft Orleans, Erlang/OTP) uses the same send whether the recipient is on this node or another: a remote message is encoded, sent over the network and decoded. Two consequences:</p>
<ul>
<li><strong>Location transparency works better than in RPC.</strong> RPC pretends an unreliable network call is a reliable function call. Actors never assumed reliability, so moving one to another node adds latency but breaks no assumption the code relied on. In effect the framework is a message broker built into the programming model.</li>
<li><strong>The message encoding becomes a compatibility contract.</strong> During a rolling upgrade, actors on new nodes send messages to actors on old nodes, so the encoding must be backward and forward compatible. In the book's 2017 snapshot this was the weak spot: Akka defaulted to Java serialization (swap in Protobuf to get compatibility), Orleans' default format didn't support rolling upgrades (you deployed a new cluster and moved traffic over), and changing Erlang record schemas was hard. Since then, Akka 2.6 (2019) disabled Java serialization by default and Orleans 7.0 (2022) introduced a version-tolerant serializer.</li>
</ul>
<p>In practice: give actor messages an explicit, evolvable schema (Protobuf, or JSON with tolerant decoding), make handlers idempotent or deduplicate because a lost message may be resent, and apply the same additive-versus-breaking discipline as for any API.</p>`,
      followups: [
        "How is a distributed actor framework different from a log-based broker like Kafka?",
        "Why can a single actor do without locks?",
        "How would you change a message type exchanged between actors on different nodes during a rolling upgrade?",
      ],
      pitfalls: [
        "Assuming actor messages are delivered exactly once",
        "Thinking location transparency removes network latency or failures",
        "Keeping the framework's default language-specific serializer for a long-lived cluster",
      ],
    },
  ],
});
