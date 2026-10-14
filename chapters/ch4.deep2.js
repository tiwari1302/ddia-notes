// Chapter 4 deep dive, part 2 (second half of the sections + takeaways). Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch4", {
  sections: [
    // ------------------------------------------------------------------ 6
    {
      id: "avro",
      title: "Avro: no tags, two schemas, matched by name",
      kicker: "Schema evolution",
      concepts: ["avro", "writers-schema-vs-readers-schema", "avro-object-container-file"],
      blocks: [
        {
          type: "problem",
          title: "Tags are fine until a machine writes the schema",
          html: `<p>Thrift and Protocol Buffers ask a person to give every field a tag number and guard it forever. That's a small chore for a hand-written RPC message. Now picture Hadoop users around 2009 dumping a relational database with 300 tables into HDFS every night. Every column needs a stable tag; when a DBA adds a column on Tuesday and drops one on Thursday, someone must hand out the new number and retire the old one without ever mixing them up, or a year of archived files decodes into nonsense.</p>
<p>Doug Cutting, Hadoop's creator, started <strong>Avro</strong> in 2009 as a Hadoop subproject because Thrift fit this world poorly. Its bet: put <em>no</em> field identifiers in the bytes at all, only the values in schema order, and get compatibility by comparing the schema that wrote the data with the schema that reads it.</p>`,
        },
        {
          type: "idea",
          html: `<p>Avro bytes mean nothing without the exact <strong>writer's schema</strong>. The reader decodes with the writer's schema, then resolves the result against its own <strong>reader's schema</strong> by field name: fields only the writer has are skipped, and fields only the reader has are filled from defaults.</p>`,
        },
        {
          type: "code",
          lang: "text",
          title: "The same record type in Avro's two schema languages",
          code: `// Avro IDL: meant for humans to edit
record Person {
    string               userName;
    union { null, long } favoriteNumber = null;
    array<string>        interests;
}

// The equivalent JSON schema: easier for machines to generate and parse
{
  "type": "record",
  "name": "Person",
  "fields": [
    {"name": "userName",       "type": "string"},
    {"name": "favoriteNumber", "type": ["null", "long"], "default": null},
    {"name": "interests",      "type": {"type": "array", "items": "string"}}
  ]
}`,
          caption: "There are no tag numbers anywhere. Nullability is spelled out as a union with null, and the default sits next to the field it fills.",
        },
        {
          type: "text",
          html: `<h3>Just the values, in the writer's order</h3>
<p>Encode the chapter's example record (userName "Martin", favoriteNumber 1337, interests ["daydreaming", "hacking"]) and Avro produces <strong>32 bytes</strong>, the smallest of every format in this chapter. JSON needs 81, Thrift's CompactProtocol 34 and Protocol Buffers 33 (as the <a href="#/ch4/learn/thrift-protobuf">section on Thrift and Protobuf</a> shows byte by byte).</p>`,
        },
        {
          type: "code",
          lang: "text",
          title: "All 32 bytes, split by field",
          code: `userName        0c                                   length 6 (zigzag varint)
                4d 61 72 74 69 6e                    "Martin" in UTF-8
favoriteNumber  02                                   union branch 1 = long (zigzag)
                f2 14                                1337 (zigzag varint)
interests       04                                   a block of 2 items (zigzag)
                16 64 61 79 64 72 65 61 6d 69 6e 67  length 11, "daydreaming"
                0e 68 61 63 6b 69 6e 67              length 7, "hacking"
                00                                   a block of 0 items: end of array`,
        },
        {
          type: "text",
          html: `<p>No field names, no tags, no type markers: a string is a length plus UTF-8 bytes, an int or long is a zigzag varint, a union is a branch index followed by the value, and an array is a run of counted blocks ending in a zero count. Nothing in the bytes says "this is a string" or "this is the second field"; only the schema does.</p>
<p>So the decoder simply walks the writer's schema field by field and reads whatever comes next. Use the wrong schema and it won't necessarily fail loudly. A decoder that believed the record began with two long fields would happily return 6 (from <code>0c</code>) and &minus;39 (the letter M, <code>0x4d</code>, read as a zigzag varint) and carry on, or stumble into an error several fields later with nothing pointing at the real cause. That's why the writer's schema must be identified <em>exactly</em>, never guessed.</p>`,
        },
        {
          type: "text",
          html: `<h3>Two schemas, resolved by name</h3>
<p>The <strong>writer's schema</strong> is whatever schema the encoding application used; the <strong>reader's schema</strong> is the shape the decoding application's code expects. They needn't be identical, only compatible. The library compares them side by side and translates the writer's record into the reader's shape:</p>
<ul>
<li>Fields are matched by <strong>name</strong>, so field order doesn't matter.</li>
<li>A field the writer has but the reader doesn't is <strong>skipped</strong>.</li>
<li>A field the reader expects but the writer never wrote is filled with the reader's <strong>default</strong>.</li>
<li>A reader field that's absent from the writer's schema and has no default is an <span class="hl-bad">error</span>.</li>
</ul>
<p>In Avro's terms, <strong>backward compatibility</strong> means an old writer's schema read through a new reader's schema, and <strong>forward compatibility</strong> means a new writer's schema read through an old reader's schema. Both collapse into one rule: <span class="hl">only add or remove fields that have a default</span>. Add a field without a default and new readers have nothing to put there when they decode old data, which breaks backward compatibility. Remove a field that had no default and old readers can't fill it when they decode new data, which breaks forward compatibility.</p>
<p>The visualization lays the two schemas side by side, draws the name matches between them, shows the writer's bytes in writer order and lists the object the reader ends up with. Start with the default scenario, then use Swap to flip who writes and who reads.</p>`,
        },
        {
          type: "viz",
          id: "ch4/avro-resolution",
          title: "Writer's schema meets reader's schema",
          caption: "Try 'Reader adds a field without a default', then press Swap writer and reader; do the same with 'Rename with an alias' and 'Promote int to long'. Notice that the same pair of schemas fails in one direction and works in the other, and that the byte strip always follows the writer's order, even when the reader's fields are shuffled. Switch where the writer's schema travels to see what each record pays to identify it.",
        },
        {
          type: "text",
          html: `<p>Swapping is the experiment that matters. Two schemas aren't "compatible" in the abstract: compatibility belongs to a <em>direction</em>. A reader that adds <code>email</code> without a default chokes on old data, yet the very same schemas work perfectly the other way round, because an old reader just skips <code>email</code>.</p>
<h3>Nulls, type changes and renames</h3>
<p>Avro has no <code>optional</code> or <code>required</code> markers. A field that may be null is declared as a union with null, such as <code>["null", "long"]</code>. Up to Avro 1.11 the specification required a union field's default to match the union's <em>first</em> branch, which is why null comes first when the default is null; the 1.12 specification relaxes this to the first branch that matches, but null-first remains the portable habit. That's wordier than Protobuf's <code>optional</code>, but every nullable field is visible in the schema, and a field that isn't such a union can never be null, which removes a whole class of null-pointer bugs.</p>
<p>Types may change where Avro knows how to convert: <strong>int</strong> promotes to long, float or double; <strong>long</strong> to float or double; <strong>float</strong> to double; and <strong>string</strong> and <strong>bytes</strong> convert into each other. Avro never narrows, so a reader expecting an int can't read a long. Renames work through <strong>aliases</strong> in the reader's schema: a field <code>name</code> can declare <code>"aliases": ["userName"]</code>, and a new reader maps old data across. An old reader knows nothing about aliases in somebody else's schema, so a rename is backward compatible only. Adding a branch to a union behaves the same way, and so do enums: if the writer's symbol isn't in the reader's enum, resolution fails unless the reader's enum declares a default symbol (supported since Avro 1.9).</p>`,
        },
        {
          type: "table",
          title: "Avro schema changes and their direction",
          headers: ["Change", "Backward (new reader, old data)", "Forward (old reader, new data)"],
          rows: [
            ["Add a field with a default", "<span class=\"hl-good\">Yes</span>: default fills it", "<span class=\"hl-good\">Yes</span>: old reader skips it"],
            ["Add a field without a default", "<span class=\"hl-bad\">No</span>: nothing to fill it with", "<span class=\"hl-good\">Yes</span>: old reader skips it"],
            ["Remove a field that had a default", "<span class=\"hl-good\">Yes</span>: new reader skips it", "<span class=\"hl-good\">Yes</span>: old reader uses its default"],
            ["Remove a field without a default", "<span class=\"hl-good\">Yes</span>: new reader skips it", "<span class=\"hl-bad\">No</span>: old reader has no value"],
            ["Reorder fields", "<span class=\"hl-good\">Yes</span>", "<span class=\"hl-good\">Yes</span>: matching is by name"],
            ["Rename, with an alias in the new reader", "<span class=\"hl-good\">Yes</span>: alias maps the old name", "<span class=\"hl-bad\">No</span>: old reader can't find its field"],
            ["Add a branch to a union", "<span class=\"hl-good\">Yes</span>", "<span class=\"hl-bad\">No</span>, once a writer uses the new branch"],
            ["Add an enum symbol", "<span class=\"hl-good\">Yes</span>", "<span class=\"hl-warn\">Only</span> if the old reader's enum has a default symbol"],
            ["int to long", "<span class=\"hl-good\">Yes</span>: promotion", "<span class=\"hl-bad\">No</span>: Avro never narrows"],
          ],
          note: "Compatible in both directions means you can upgrade writers and readers in any order. One direction only forces an order: with backward-only changes, upgrade readers first.",
        },
        {
          type: "text",
          html: `<h3>Where does the reader get the writer's schema?</h3>
<p>Attaching the full schema to every record would often make the schema bigger than the 32-byte payload. Avro leans on context instead:</p>
<ul>
<li><strong>A large file of records.</strong> A Hadoop job writes millions of records with one schema, so an <strong>object container file</strong> stores it once. The file begins with the ASCII letters <code>Obj</code> and the version byte 1, then a metadata map holding <code>avro.schema</code> (the writer's schema as JSON) and <code>avro.codec</code> (such as <code>null</code> or <code>deflate</code>), then a random 16-byte <strong>sync marker</strong>. Records follow in blocks, each ending with the sync marker, so a reader can split the file or resynchronize partway through.</li>
<li><strong>A database of individually written records.</strong> Records written years apart use different schemas, so each one starts with a <strong>schema version number</strong> and the database keeps a table of versions. LinkedIn's Espresso works this way.</li>
<li><strong>A network connection.</strong> Two processes can agree on the schema version when the connection opens and use it for the connection's lifetime, as the Avro RPC protocol does.</li>
<li><strong>A stream of messages.</strong> Each Kafka message carries a small schema ID that points into a <strong>schema registry</strong>, the subject of the next section.</li>
</ul>`,
        },
        {
          type: "diagram",
          title: "Decoding Avro, and three ways the writer's schema travels",
          svg: `<style>.dd-diagram-body svg.c4d2-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c4d2-w{display:none}.dd-diagram-body svg.c4d2-n{display:block}}</style><svg class="c4d2-w" viewBox="0 0 640 252" role="img" aria-label="Bytes and the writer's schema feed a decoder that reads fields in the writer's order; the result is resolved by name against the reader's schema into an object in the reader's shape. Below, three ways the writer's schema reaches the reader: once in a container file header, as a version prefix on each database record, or as a schema ID on each Kafka message."><defs><marker id="c4d2-av-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="8" y="16" width="136" height="44" rx="8" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="76" y="34" font-size="12" font-weight="700" text-anchor="middle">bytes</text><text x="76" y="51" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">0c 4d 61 72 …</text>
<rect x="8" y="76" width="136" height="44" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="76" y="94" font-size="12" font-weight="700" text-anchor="middle">writer's schema</text><text x="76" y="111" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">the exact version</text>
<rect x="184" y="36" width="140" height="64" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="254" y="59" font-size="13" font-weight="700" text-anchor="middle">1. decode</text><text x="254" y="76" font-size="12" text-anchor="middle">in the writer's</text><text x="254" y="91" font-size="12" text-anchor="middle">field order</text>
<rect x="364" y="36" width="120" height="64" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="424" y="59" font-size="13" font-weight="700" text-anchor="middle">2. resolve</text><text x="424" y="76" font-size="12" text-anchor="middle">fields by name,</text><text x="424" y="91" font-size="12" text-anchor="middle">fill defaults</text>
<rect x="364" y="122" width="120" height="36" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="424" y="145" font-size="12" font-weight="700" text-anchor="middle">reader's schema</text>
<rect x="524" y="36" width="108" height="64" rx="8" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/><text x="578" y="62" font-size="12" font-weight="700" text-anchor="middle">object in the</text><text x="578" y="79" font-size="12" font-weight="700" text-anchor="middle">reader's shape</text>
<path d="M144,38 L182,58" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-av-w)"/><path d="M144,98 L182,78" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-av-w)"/><path d="M324,68 L362,68" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-av-w)"/><path d="M424,122 L424,102" style="stroke: var(--viz-c2); fill: none" stroke-width="1.6" marker-end="url(#c4d2-av-w)"/><path d="M484,68 L522,68" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-av-w)"/>
<line x1="8" y1="174" x2="632" y2="174" style="stroke: var(--viz-grid)"/><text x="8" y="194" font-size="13" font-weight="700">How the reader finds the exact writer's schema</text>
<rect x="8" y="204" width="200" height="44" rx="8" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="108" y="222" font-size="12" font-weight="700" text-anchor="middle">Object container file</text><text x="108" y="239" font-size="12" text-anchor="middle">schema once, in the header</text>
<rect x="220" y="204" width="200" height="44" rx="8" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="320" y="222" font-size="12" font-weight="700" text-anchor="middle">Database record (Espresso)</text><text x="320" y="239" font-size="12" text-anchor="middle">schema version number prefix</text>
<rect x="432" y="204" width="200" height="44" rx="8" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="532" y="222" font-size="12" font-weight="700" text-anchor="middle">Kafka message (registry)</text><text x="532" y="239" font-size="12" text-anchor="middle">0x00 + 4-byte schema ID</text>
</svg><svg class="c4d2-n" viewBox="0 0 360 384" role="img" aria-label="Avro decode pipeline: bytes and writer's schema are decoded in the writer's order, resolved by name against the reader's schema, producing an object in the reader's shape. Three ways the writer's schema travels: container file header, database version prefix, Kafka schema ID."><defs><marker id="c4d2-av-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="8" y="8" width="166" height="44" rx="8" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="91" y="26" font-size="12" font-weight="700" text-anchor="middle">bytes</text><text x="91" y="43" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">0c 4d 61 72 …</text>
<rect x="186" y="8" width="166" height="44" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="269" y="26" font-size="12" font-weight="700" text-anchor="middle">writer's schema</text><text x="269" y="43" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">the exact version</text>
<rect x="8" y="76" width="344" height="40" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="180" y="101" font-size="12" font-weight="700" text-anchor="middle">1. decode in the writer's field order</text>
<rect x="8" y="140" width="200" height="40" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="108" y="165" font-size="12" font-weight="700" text-anchor="middle">2. resolve by name</text>
<rect x="228" y="140" width="124" height="40" rx="8" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="290" y="165" font-size="12" font-weight="700" text-anchor="middle">reader's schema</text>
<rect x="8" y="204" width="344" height="36" rx="8" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/><text x="180" y="227" font-size="12" font-weight="700" text-anchor="middle">object in the reader's shape</text>
<path d="M91,52 L91,74" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-av-n)"/><path d="M269,52 L269,74" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-av-n)"/><path d="M108,116 L108,138" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-av-n)"/><path d="M228,160 L210,160" style="stroke: var(--viz-c2); fill: none" stroke-width="1.6" marker-end="url(#c4d2-av-n)"/><path d="M108,180 L108,202" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-av-n)"/>
<line x1="8" y1="256" x2="352" y2="256" style="stroke: var(--viz-grid)"/><text x="8" y="276" font-size="12" font-weight="700">How the reader finds the writer's schema</text>
<rect x="8" y="286" width="344" height="28" rx="6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="18" y="305" font-size="12"><tspan font-weight="700">Container file:</tspan> once, in the header</text>
<rect x="8" y="320" width="344" height="28" rx="6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="18" y="339" font-size="12"><tspan font-weight="700">Database record:</tspan> version prefix (Espresso)</text>
<rect x="8" y="354" width="344" height="28" rx="6" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="18" y="373" font-size="12"><tspan font-weight="700">Kafka message:</tspan> 0x00 + 4-byte schema ID</text>
</svg>`,
          caption: "Step 1 needs the writer's schema because the bytes carry no field names or types; step 2 needs the reader's schema because that's the shape the code wants. However the writer's schema travels, it must be identified exactly.",
        },
        {
          type: "text",
          html: `<h3>Schemas written by machines</h3>
<p>The missing tags pay off when schemas are <strong>generated</strong>. To dump a relational database you can derive one Avro record schema per table, one field per column, entirely mechanically. When a column is added or dropped, you regenerate the schema and export with the new writer's schema. Readers keep working because matching is by name: old readers skip columns they've never seen, and dropped columns fall back to defaults. With Thrift or Protobuf, the generator would have to remember every tag it ever assigned and never reuse a retired one, which in practice means someone maintaining that mapping by hand. Supporting generated schemas was an explicit design goal for Avro.</p>
<p>Code generation is optional too. Generated classes help in Java, C++ or C#, where the compiler checks types, but add little in Python, Ruby or JavaScript. And because an object container file carries its own schema, generic tools such as Apache Pig or Spark can open and analyze one much as you'd open a JSON file, with no generated code at all.</p>`,
        },
        {
          type: "compare",
          title: "Two ways to identify a field",
          items: [
            { title: "Protobuf and Thrift: tags assigned by people", tone: "info", html: `<p>Each field carries its tag in the bytes, so one record is partly readable alone (<code>protoc --decode_raw</code> prints tags and values without any schema). The price is discipline: a human assigns every tag and must never reuse one, which is awkward when schemas are generated from tables.</p>` },
            { title: "Avro: names resolved between two schemas", tone: "ok", html: `<p>The bytes are the smallest of all, and generated schemas evolve painlessly because names do the matching. The price is infrastructure: a record is opaque without its exact writer's schema, so you need container files, version tables or a registry to keep every schema findable.</p>` },
          ],
        },
        {
          type: "realworld",
          items: [
            { org: "Apache Avro and Hadoop", year: "2009", html: `<p>Doug Cutting started Avro as a Hadoop subproject. Object container files, with the schema embedded once in the header, became a standard way to store record data in HDFS.</p>` },
            { org: "LinkedIn Espresso", tag: "Document store", html: `<p>LinkedIn's distributed document store encodes records with Avro and prefixes each with its schema version, using Avro's resolution rules to evolve schemas without rewriting stored data.</p>` },
            { org: "Debezium and Kafka Connect", tag: "Change data capture", html: `<p>With the Avro converter, change-data-capture connectors derive an Avro schema from each table's columns and register a new schema version when a column changes: the machine-generated case Avro was built for.</p>` },
            { org: "Apache Iceberg", tag: "Table format", html: `<p>Iceberg stores its table metadata (manifest lists and manifest files) as Avro files, while the table data itself is usually Parquet.</p>` },
          ],
        },
        {
          type: "callout",
          tone: "interview",
          title: "Explain Avro resolution in one breath",
          html: `<p>A strong answer: "Avro bytes are just values in the writer's field order, so the reader first decodes with the exact writer's schema, then resolves by name into its own reader's schema: extra writer fields are skipped, missing ones take the reader's defaults, and a missing field with no default is an error. So you only add or remove fields that have defaults, and the writer's schema travels in a file header, a version prefix or a registry ID." Expect the follow-up "why not just use Protobuf?" and answer with generated schemas: no tags to assign, so a schema derived from a changing database table evolves for free.</p>`,
        },
        {
          type: "quiz",
          q: "A new Avro reader's schema renames userName to name and lists userName as an alias. Producers are then upgraded to write name. Who can read what?",
          options: [
            "New readers can read both old and new data; old readers fail on new data unless their userName field has a default",
            "Everyone can read everything, because aliases work in both directions",
            "Old readers are fine, but new readers fail on old data",
            "Nobody: Avro forbids renaming fields",
          ],
          answer: 0,
          explain: "Aliases live in the reader's schema, so they only help the reader that declares them: new readers map old userName data onto name, which is backward compatibility. Old readers look for userName, don't find it in data written with the new schema, and fail unless they declared a default, so the rename isn't forward compatible. The tempting answer B assumes aliases are a property of the data; they're a property of one reader's schema.",
        },
      ],
    },
    // ------------------------------------------------------------------ 7
    {
      id: "merits-of-schemas",
      title: "Schemas are documentation that can't go stale",
      kicker: "Schemas",
      concepts: ["schema-registry", "compatibility-modes"],
      blocks: [
        {
          type: "problem",
          title: "The schema never went away; it just hid",
          html: `<p>An illustrative scenario. The orders team renames <code>user_id</code> to <code>userId</code> in the JSON events it publishes to a shared Kafka topic. Their tests pass, because their tests cover their own code. Three consumers owned by other teams keep looking for <code>user_id</code>, find nothing and write nulls into the warehouse. Nobody notices for two days, until a revenue-by-customer dashboard goes blank.</p>
<p>Schemaless JSON promised freedom, but the schema never disappeared: it hid in every consumer's parsing code and in a wiki page that drifted out of date. "Announce changes in Slack" and "keep the docs current" don't scale to dozens of producers and consumers. And the obvious technical fix, shipping the full schema inside every message, would make the schema bigger than the data.</p>`,
        },
        {
          type: "idea",
          html: `<p>A schema that the decoder <em>requires</em> is always up to date. Once every version of it lives in a <strong>registry</strong>, a machine can check a change's backward and forward compatibility before anything ships, and each message needs only a few bytes to say which schema wrote it.</p>`,
        },
        {
          type: "text",
          html: `<h3>An old idea, rediscovered</h3>
<p>Schema-driven binary encodings aren't new. <strong>ASN.1</strong>, a schema definition language first standardized in 1984, already used tag numbers to evolve schemas much as Protobuf and Thrift do. Its DER encoding is still how X.509 certificates are encoded, so every HTTPS handshake parses ASN.1. But ASN.1 is complex and poorly documented, which makes it a poor choice for new applications.</p>
<p>Plenty of systems also speak their own schema-driven binary protocol. The PostgreSQL and MySQL network protocols are each specific to one database, and the vendor's driver decodes the responses into a standard API such as JDBC or ODBC. Nobody hand-parses those bytes; the schema lives in the driver. Schema-based binary formats share four merits:</p>`,
        },
        {
          type: "keypoints",
          title: "Why schema-driven encodings are worth the tooling",
          items: [
            "<strong>Compact.</strong> Field names stay out of the bytes, so records can be much smaller than in binary JSON variants: 32 to 34 bytes for the chapter's example record, against 66 for MessagePack.",
            "<strong>Documentation that can't go stale.</strong> The decoder needs the schema, so the schema always matches the data. A wiki page can drift; the decoder's schema can't.",
            "<strong>Compatibility you can check.</strong> Keep every schema version in one place and a tool can verify that a change is backward and forward compatible before it's deployed.",
            "<strong>Type-checked code.</strong> In statically typed languages, classes generated from the schema let the compiler catch mismatches at build time.",
          ],
        },
        {
          type: "text",
          html: `<p>Together these give you the flexibility people want from schemaless, schema-on-read JSON (see <a href="#/ch2/learn/schema-flexibility">schema flexibility in Chapter 2</a>) with stronger guarantees and better tooling.</p>
<h3>Schema registries: one ID per schema, five bytes per message</h3>
<p>A registry turns "the reader needs the exact writer's schema" into infrastructure. Confluent's Schema Registry for Kafka is the canonical example:</p>
<ol>
<li>Schemas are grouped into <strong>subjects</strong>, usually one per topic (for example <code>orders-value</code> for the values in the orders topic). Each subject holds a list of versions.</li>
<li>When a producer first uses a schema, its serializer registers it under the subject. The registry checks the new version against the subject's <strong>compatibility mode</strong>; if it passes, the registry stores it and returns a <strong>schema ID</strong>.</li>
<li>Every message then starts with a 5-byte prefix, the magic byte <code>0x00</code> and the 4-byte big-endian schema ID, followed by the Avro, Protobuf or JSON Schema payload.</li>
<li>A consumer that meets an ID it hasn't seen fetches that schema from the registry once and caches it. After that, decoding costs nothing extra.</li>
</ol>
<p>So each message pays five bytes instead of carrying a whole schema, and an incompatible schema is refused at registration, before a single bad message reaches the topic.</p>`,
        },
        {
          type: "diagram",
          title: "A schema registry in the write and read path",
          svg: `<style>.dd-diagram-body svg.c4d2-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c4d2-w{display:none}.dd-diagram-body svg.c4d2-n{display:block}}</style><svg class="c4d2-w" viewBox="0 0 640 212" role="img" aria-label="The producer registers its schema with the registry and receives schema id 42; an incompatible schema is rejected. The producer sends messages to the orders topic, each prefixed with magic byte 00 and the 4-byte schema id. The consumer fetches schema 42 from the registry once and caches it."><defs><marker id="c4d2-rg-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker><marker id="c4d2-rg-wb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker></defs>
<rect x="8" y="16" width="118" height="92" rx="10" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="67" y="56" font-size="13" font-weight="700" text-anchor="middle">Producer</text><text x="67" y="74" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">orders service</text>
<rect x="278" y="16" width="176" height="92" rx="10" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="366" y="42" font-size="13" font-weight="700" text-anchor="middle">Schema registry</text><text x="366" y="64" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">orders-value</text><text x="366" y="84" font-size="12" text-anchor="middle">mode: BACKWARD</text>
<path d="M126,38 L276,38" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-rg-w)"/><text x="202" y="32" font-size="12" text-anchor="middle">1. register schema</text>
<path d="M278,64 L128,64" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-rg-w)"/><text x="202" y="58" font-size="12" text-anchor="middle">schema id 42</text>
<path d="M126,94 L264,94" style="stroke: var(--viz-bad); fill: none" stroke-width="1.6" stroke-dasharray="5 4"/><path d="M266,88 L276,100 M276,88 L266,100" style="stroke: var(--viz-bad)" stroke-width="2.2"/><text x="196" y="88" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">incompatible: rejected</text>
<path d="M67,108 L67,166 L148,166" style="stroke: var(--viz-c6); fill: none" stroke-width="1.6" marker-end="url(#c4d2-rg-w)"/><text x="74" y="140" font-size="12">2. send message</text>
<text x="452" y="142" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">one message in topic orders</text>
<rect x="150" y="150" width="36" height="32" rx="4" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="168" y="171" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">00</text>
<rect x="190" y="150" width="108" height="32" rx="4" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="244" y="171" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">00 00 00 2a</text>
<rect x="302" y="150" width="150" height="32" rx="4" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="377" y="171" font-size="12" text-anchor="middle">Avro payload …</text>
<text x="168" y="200" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">magic</text><text x="244" y="200" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">schema id 42</text><text x="377" y="200" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">values only, no names</text>
<rect x="514" y="142" width="118" height="48" rx="10" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="573" y="162" font-size="13" font-weight="700" text-anchor="middle">Consumer</text><text x="573" y="179" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">analytics</text>
<path d="M452,166 L512,166" style="stroke: var(--viz-c2); fill: none" stroke-width="1.6" marker-end="url(#c4d2-rg-w)"/>
<path d="M604,142 L604,62 L456,62" style="stroke: var(--viz-c2); fill: none" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#c4d2-rg-w)"/><text x="596" y="94" font-size="12" text-anchor="end">3. id 42 unknown?</text><text x="596" y="110" font-size="12" text-anchor="end">fetch it once, cache it</text>
</svg><svg class="c4d2-n" viewBox="0 0 360 290" role="img" aria-label="Producer registers its schema and gets id 42, incompatible schemas are rejected; messages carry 00 plus the schema id; the consumer fetches schema 42 once and caches it."><defs><marker id="c4d2-rg-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="8" y="8" width="110" height="96" rx="10" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="63" y="50" font-size="13" font-weight="700" text-anchor="middle">Producer</text><text x="63" y="68" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">orders</text>
<rect x="242" y="8" width="110" height="96" rx="10" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="297" y="36" font-size="13" font-weight="700" text-anchor="middle">Schema</text><text x="297" y="52" font-size="13" font-weight="700" text-anchor="middle">registry</text><text x="297" y="74" font-size="12" text-anchor="middle">mode:</text><text x="297" y="90" font-size="12" text-anchor="middle">BACKWARD</text>
<path d="M118,32 L240,32" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-rg-n)"/><text x="180" y="26" font-size="12" text-anchor="middle">1. register</text>
<path d="M242,60 L120,60" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-rg-n)"/><text x="180" y="54" font-size="12" text-anchor="middle">id 42</text>
<path d="M118,90 L226,90" style="stroke: var(--viz-bad); fill: none" stroke-width="1.6" stroke-dasharray="5 4"/><path d="M228,84 L238,96 M238,84 L228,96" style="stroke: var(--viz-bad)" stroke-width="2.2"/><text x="172" y="84" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">incompatible</text>
<path d="M63,104 L63,138" style="stroke: var(--viz-c6); fill: none" stroke-width="1.6" marker-end="url(#c4d2-rg-n)"/><text x="72" y="126" font-size="12">2. send</text>
<text x="284" y="134" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">topic orders</text>
<rect x="8" y="140" width="36" height="32" rx="4" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="26" y="161" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">00</text>
<rect x="48" y="140" width="104" height="32" rx="4" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="100" y="161" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">00 00 00 2a</text>
<rect x="156" y="140" width="128" height="32" rx="4" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="220" y="161" font-size="12" text-anchor="middle">payload …</text>
<text x="26" y="190" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">magic</text><text x="100" y="190" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">schema id 42</text><text x="210" y="190" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">values only</text>
<path d="M268,172 L268,214" style="stroke: var(--viz-c2); fill: none" stroke-width="1.6" marker-end="url(#c4d2-rg-n)"/>
<rect x="196" y="216" width="156" height="66" rx="10" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="274" y="238" font-size="13" font-weight="700" text-anchor="middle">Consumer</text><text x="274" y="256" font-size="12" text-anchor="middle">3. fetches schema 42</text><text x="274" y="272" font-size="12" text-anchor="middle">once, caches it</text>
<path d="M330,216 L330,106" style="stroke: var(--viz-c2); fill: none" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#c4d2-rg-n)"/>
</svg>`,
          caption: "The registry is consulted when a schema is first registered (where incompatible changes are refused) and when a consumer first meets an ID; every other message pays only five bytes of prefix.",
        },
        {
          type: "table",
          title: "Compatibility modes in Confluent's Schema Registry",
          headers: ["Mode", "Guarantee", "Allowed changes (Avro)", "Checked against", "Upgrade first"],
          rows: [
            ["<strong>BACKWARD</strong> (default)", "Consumers on the new schema read data written with the previous one", "Delete fields; add fields with defaults", "The latest version", "Consumers"],
            ["<strong>FORWARD</strong>", "Consumers on the previous schema read data written with the new one", "Add fields; delete fields with defaults", "The latest version", "Producers"],
            ["<strong>FULL</strong>", "Both of the above", "Add or delete fields with defaults only", "The latest version", "Either, in any order"],
            [`<span style="white-space:nowrap"><strong>*_TRANSITIVE</strong></span>`, "The same guarantee against every earlier version", "As for the base mode", "All earlier versions", "As for the base mode"],
            ["<strong>NONE</strong>", "Nothing", "Anything", "Nothing", "You coordinate by hand"],
          ],
          note: "The modes are named for what the new schema promises, and each implies a deploy order. Pick the mode that matches how your teams actually ship.",
        },
        {
          type: "text",
          html: `<h3>Why "transitive" matters</h3>
<p>Plain BACKWARD compares a new version only with the latest one. That's enough if consumers read only recent messages. But Kafka retains messages, sometimes for weeks or indefinitely, and a consumer replaying a topic from the beginning meets every historical version in turn. Each consecutive pair can pass while the chain fails: version 2 deletes an int field <code>discount</code>, version 3 brings <code>discount</code> back as a string with a default. Each step is backward compatible with its predecessor, yet a v3 consumer replaying v1 messages finds an int where it expects a string, and int doesn't promote to string. The <strong>_TRANSITIVE</strong> modes check a new schema against every earlier version, which is what a replayable log needs.</p>
<h3>What a schema can't tell you</h3>
<p>A schema captures names and types, not meaning. In 1999 NASA lost the Mars Climate Orbiter because ground software reported thruster impulse in pound-force seconds while the interface specification required newton-seconds: the numbers had the right type and the wrong unit. Put units in field names (<code>timeout_ms</code>, <code>amount_cents</code>), write semantics into the schema itself (Avro fields take a <code>doc</code> attribute; Protobuf files take comments), and treat a change of meaning as a breaking change even when the compatibility checker is happy.</p>
<h3>The orders team's rename, replayed with a registry</h3>
<p>Suppose the orders team publishes Avro through a registry in BACKWARD mode. If their new schema has <code>userId</code> with no default, registration fails: a new reader has no way to fill <code>userId</code> from old messages, so the mistake surfaces in CI instead of the warehouse. If they give <code>userId</code> a default, BACKWARD passes, and that's the subtle part. Consumers still on the old schema look for <code>user_id</code>, which has no default, and fail on every new message. BACKWARD is safe only if consumers upgrade first, and here the producer shipped first. FORWARD or FULL would have rejected the change. <span class="hl">The compatibility mode has to match your deploy order.</span> Even in the right order, upgraded consumers reading old messages would see the default, not the real ID: a checker guarantees that bytes decode, not that meaning survives. The clean path for a rename is to add <code>userId</code> alongside <code>user_id</code>, move consumers over, then remove the old field, the expand/contract pattern from the next section.</p>`,
        },
        {
          type: "realworld",
          items: [
            { org: "X.509 and TLS", tag: "ASN.1 in production", html: `<p>The certificates presented on every HTTPS connection are ASN.1 structures encoded with DER, so a schema language from the 1980s is parsed billions of times a day.</p>` },
            { org: "Confluent Schema Registry", tag: "Kafka", html: `<p>Messages carry a 5-byte prefix (magic byte 0 plus a 4-byte schema ID). The default compatibility type is BACKWARD, with FORWARD, FULL, their _TRANSITIVE variants and NONE available. Avro was supported first; Protobuf and JSON Schema arrived in Confluent Platform 5.5 (2020).</p>` },
            { org: "NASA Mars Climate Orbiter", year: "1999", tag: "Units", html: `<p>Ground software produced thruster impulse in pound-force seconds while the interface specification required newton-seconds. The resulting trajectory errors led to the spacecraft's loss: right type, wrong meaning.</p>` },
            { org: "GraphQL", year: "2015", tag: "Versionless schema", html: `<p>Open-sourced by Facebook in 2015. Its best-practice guidance avoids API versions in favor of one continuously evolving schema, in which old fields are marked <code>@deprecated</code> and removed once clients stop using them.</p>` },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Since the book: registries everywhere, checks in CI",
          html: `<p>Registries are no longer an Avro-only idea: Confluent's registry has handled Protobuf and JSON Schema since 2020, and cloud providers offer managed ones such as AWS Glue Schema Registry. Compatibility checking has also moved left into CI. Teams call the registry's compatibility endpoint in a pipeline step before deploying a producer, <code>buf breaking</code> does the same job for <code>.proto</code> files (see the <a href="#/ch4/learn/field-tags-evolution">section on field tags</a>), and OpenAPI diff tools flag breaking REST changes in pull requests.</p>`,
        },
        {
          type: "tradeoffs",
          title: "Schema-driven encodings versus schemaless JSON",
          prosLabel: "Schema-driven encodings give you",
          consLabel: "What they cost",
          pros: [
            "Compact records, because field names stay out of the bytes",
            "Documentation that is always current, because decoding needs it",
            "Compatibility checked at registration or in CI, before deploy",
            "Generated types that catch mismatches at compile time",
          ],
          cons: [
            "Tooling to run: code generators, a registry, CI checks",
            "Bytes you can't read without the schema, so debugging needs tools",
            "A registry that becomes a dependency (consumers cache schemas to soften this)",
            "Friction for quick experiments and for public web APIs, where JSON is the common language",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          title: "How would you govern event schemas across 40 teams?",
          html: `<p>Interviewers want process and mechanism, not "we use JSON and tell people." A strong answer: a registry with one subject per topic and a named owning team; a compatibility mode chosen to match the deploy order (BACKWARD_TRANSITIVE if consumers upgrade first and topics are replayable, FULL_TRANSITIVE if you can't control who ships first); the compatibility check run in CI before merge, not discovered in production; units and semantics documented in the schema; and breaking changes shipped as a new field or a new topic with a migration window. Bonus points for noting that checks prove decodability, not meaning, so renames go through expand/contract.</p>`,
        },
        {
          type: "quiz",
          q: "Your schema registry uses the BACKWARD compatibility type (Confluent's default). In which order should you deploy a schema change?",
          options: [
            "Upgrade consumers first, then producers",
            "Upgrade producers first, then consumers",
            "Any order, because BACKWARD checks both directions",
            "Stop all producers, upgrade everything, then restart",
          ],
          answer: 0,
          explain: "BACKWARD guarantees that the new schema can read data written with the previous one, so upgraded consumers cope with the old-format messages still being produced. It doesn't promise that old consumers can read new messages (the change may have deleted a field they need), so producers go last. Producers-first (B) is the order FORWARD supports, and any order (C) needs FULL. Stopping the world (D) works but throws away the point of compatible schemas.",
        },
      ],
    },
    // ------------------------------------------------------------------ 8
    {
      id: "dataflow-databases",
      title: "Through databases: a message to your future self",
      kicker: "Dataflow",
      concepts: ["dataflow-through-databases", "unknown-field-preservation", "expand-contract"],
      blocks: [
        {
          type: "problem",
          title: "The writer and the reader are years apart, and sometimes on different versions",
          html: `<p>A database decouples writer and reader in time: the process that reads a record may be newer or older than the one that wrote it, and the gap may be five milliseconds or five years. During a rolling upgrade, v2 servers write records that v1 servers read, decode into their model objects, modify and save. When records are stored as encoded documents or blobs and saved whole, v1's model has no slot for v2's new field, so saving the object silently deletes it.</p>
<p>And unlike code, which you can replace in minutes, data stays. Rewriting a billion records into a new shape for every schema change is slow, expensive and risky, so the database ends up holding every historical encoding at once.</p>`,
        },
        {
          type: "idea",
          html: `<p>Treat every stored record as a message to a future reader of unknown version. <strong>Readers</strong> must handle every encoding still on disk, <strong>old writers</strong> must not destroy fields they don't understand, and schema changes roll out in <strong>compatible steps</strong> rather than one big rewrite.</p>`,
        },
        {
          type: "text",
          html: `<h3>Who reads what you wrote</h3>
<p>When a process writes a value and later reads it back, the database is a channel between two versions of the same program: the one that wrote and the one that reads, possibly several deploys later. <strong>Backward compatibility</strong> is clearly needed, or the new version can't read what the old one stored.</p>
<p>Usually several processes share the database, and during a <strong>rolling upgrade</strong> they don't all run the same version. A value written by v2 on one server may be read by v1 on another a moment later, so <strong>forward compatibility</strong> is often needed too. A rollback recreates the situation on a larger scale: after you revert to v1, old code meets every record v2 wrote while it was live.</p>
<p>The visualization recreates the lost photo from this chapter's opening on a document store where every write replaces a user's whole document. Upgrade a node, let v2 set Maya's photo, then let a v1 node edit her bio, and compare the three ways v1 can treat a field it doesn't know.</p>`,
        },
        {
          type: "viz",
          id: "ch4/rolling-upgrade",
          title: "Rolling upgrade on a shared database",
          caption: "Try Play the story with 'Drop (model object)', then again with 'Preserve' and 'Reject'. Notice that under Drop no request fails (Failed requests stays at 0) yet Fields lost ticks up, while under Reject nothing is lost but Failed requests climbs instead. Then upgrade a node, set the photo, roll the node back and edit the bio again: a rollback is old code meeting new data.",
        },
        {
          type: "text",
          html: `<h3>Ignoring a field isn't the same as preserving it</h3>
<p>Under <em>Drop</em>, v1's decoder did exactly what a tolerant reader should: it ignored the field it didn't know. The damage came afterwards, when v1 turned the bytes into a <code>User</code> object with no slot for <code>photoUrl</code>, changed the bio and wrote the <em>whole</em> object back. Forward compatibility in a database has two halves: old code must be able to read new data, and it must not destroy what it doesn't understand. Under <em>Reject</em>, a strict decoder refuses such records instead. Nothing is lost, but every v1 node now fails on records v2 has touched, so the rollout must finish quickly or be rolled back.</p>
<p>Be precise about where the loss happens. It needs a whole-value rewrite of an encoded record:</p>
<ul>
<li>a document replaced in full (MongoDB's <code>replaceOne</code>, or a JSON column overwritten whole);</li>
<li>a Protobuf or JSON blob in a key-value store or cache that is read, modified and put back;</li>
<li>a REST <code>GET</code>, modify, <code>PUT</code> round trip by a client that only knows the old fields;</li>
<li>proto3 libraries before version 3.5 (2017), which discarded unknown fields while parsing.</li>
</ul>
<p>It does <em>not</em> happen with a relational <code>UPDATE users SET bio = ? WHERE id = ?</code>: a column v1 has never heard of is simply left alone. The encoding can help (Protobuf keeps unknown fields and writes them back when the message is re-serialized), but the application layer often throws them away anyway, through DTOs that map only known properties, JSON mappers set to ignore unknown properties, or load-modify-replace document code.</p>
<p>The fixes follow from that. <strong>Preserve unknown fields end to end</strong>: keep the raw message, or capture extras into a map (Jackson's <code>@JsonAnySetter</code> does this) and write them back. <strong>Avoid whole-record rewrites</strong>: update only the changed column, or use MongoDB's <code>$set</code>, a JSON Merge Patch or a field mask that names exactly the fields you mean to change. And <strong>deploy a version that preserves the field before any version writes it</strong>, so that by the time v2 starts writing <code>photoUrl</code>, every node that might rewrite the record already knows to keep it.</p>`,
        },
        {
          type: "diagram",
          title: "Data outlives code: one table, three eras of writers",
          svg: `<style>.dd-diagram-body svg.c4d2-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c4d2-w{display:none}.dd-diagram-body svg.c4d2-n{display:block}}</style><svg class="c4d2-w" viewBox="0 0 640 238" role="img" aria-label="A users table with five rows written by v1 in 2019, v3 in 2022 and v5 in 2026, each with different fields present. Today's v5 code reads every row. Replacing code takes minutes; rewriting data is rare and expensive."><defs><marker id="c4d2-do-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c5)"/></marker></defs>
<text x="8" y="18" font-size="13" font-weight="700">users</text>
<text x="20" y="40" font-size="12" style="fill: var(--viz-muted)">user</text><text x="90" y="40" font-size="12" style="fill: var(--viz-muted)">bio</text><text x="180" y="40" font-size="12" style="fill: var(--viz-muted)">photoUrl</text><text x="280" y="40" font-size="12" style="fill: var(--viz-muted)">email</text><text x="370" y="40" font-size="12" style="fill: var(--viz-muted)">written by</text>
<rect x="8" y="48" width="444" height="26" rx="5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="20" y="66" font-size="12" style="font-family: var(--font-mono)">ada</text><text x="90" y="66" font-size="12" style="font-family: var(--font-mono)">math</text><text x="180" y="66" font-size="12" style="fill: var(--viz-muted)">–</text><text x="280" y="66" font-size="12" style="fill: var(--viz-muted)">–</text><text x="370" y="66" font-size="12" font-weight="700" style="fill: var(--viz-c2)">v1 (2019)</text>
<rect x="8" y="78" width="444" height="26" rx="5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="20" y="96" font-size="12" style="font-family: var(--font-mono)">bob</text><text x="90" y="96" font-size="12" style="font-family: var(--font-mono)">poetry</text><text x="180" y="96" font-size="12" style="fill: var(--viz-muted)">–</text><text x="280" y="96" font-size="12" style="fill: var(--viz-muted)">–</text><text x="370" y="96" font-size="12" font-weight="700" style="fill: var(--viz-c2)">v1 (2019)</text>
<rect x="8" y="108" width="444" height="26" rx="5" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="20" y="126" font-size="12" style="font-family: var(--font-mono)">eve</text><text x="90" y="126" font-size="12" style="font-family: var(--font-mono)">music</text><text x="180" y="126" font-size="12" style="font-family: var(--font-mono)">eve.png</text><text x="280" y="126" font-size="12" style="fill: var(--viz-muted)">–</text><text x="370" y="126" font-size="12" font-weight="700" style="fill: var(--viz-c3)">v3 (2022)</text>
<rect x="8" y="138" width="444" height="26" rx="5" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/><text x="20" y="156" font-size="12" style="font-family: var(--font-mono)">raj</text><text x="90" y="156" font-size="12" style="font-family: var(--font-mono)">chess</text><text x="180" y="156" font-size="12" style="font-family: var(--font-mono)">raj.png</text><text x="280" y="156" font-size="12" style="font-family: var(--font-mono)">raj@x.io</text><text x="370" y="156" font-size="12" font-weight="700" style="fill: var(--viz-c5)">v5 (2026)</text>
<rect x="8" y="168" width="444" height="26" rx="5" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/><text x="20" y="186" font-size="12" style="font-family: var(--font-mono)">kim</text><text x="90" y="186" font-size="12" style="font-family: var(--font-mono)">maps</text><text x="180" y="186" font-size="12" style="fill: var(--viz-muted)">–</text><text x="280" y="186" font-size="12" style="font-family: var(--font-mono)">kim@x.io</text><text x="370" y="186" font-size="12" font-weight="700" style="fill: var(--viz-c5)">v5 (2026)</text>
<path d="M456,61 L518,96" style="stroke: var(--viz-c5); fill: none" stroke-width="1.4" marker-end="url(#c4d2-do-w)"/><path d="M456,91 L518,106" style="stroke: var(--viz-c5); fill: none" stroke-width="1.4" marker-end="url(#c4d2-do-w)"/><path d="M456,121 L518,116" style="stroke: var(--viz-c5); fill: none" stroke-width="1.4" marker-end="url(#c4d2-do-w)"/><path d="M456,151 L518,126" style="stroke: var(--viz-c5); fill: none" stroke-width="1.4" marker-end="url(#c4d2-do-w)"/><path d="M456,181 L518,136" style="stroke: var(--viz-c5); fill: none" stroke-width="1.4" marker-end="url(#c4d2-do-w)"/>
<rect x="520" y="84" width="112" height="64" rx="10" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/><text x="576" y="110" font-size="13" font-weight="700" text-anchor="middle">v5 code</text><text x="576" y="128" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">(today)</text><text x="576" y="72" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">reads every row</text>
<rect x="8" y="206" width="214" height="26" rx="13" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/><text x="115" y="224" font-size="12" font-weight="700" text-anchor="middle">replacing code: minutes</text>
<rect x="232" y="206" width="264" height="26" rx="13" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><text x="364" y="224" font-size="12" font-weight="700" text-anchor="middle">rewriting data: rare and expensive</text>
</svg><svg class="c4d2-n" viewBox="0 0 360 288" role="img" aria-label="A users table with rows written by v1 in 2019, v3 in 2022 and v5 in 2026, with different fields present; today's v5 code reads every row. Replacing code takes minutes; rewriting data is rare and costly."><defs><marker id="c4d2-do-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c5)"/></marker></defs>
<text x="8" y="18" font-size="12" font-weight="700">users</text>
<text x="16" y="38" font-size="12" style="fill: var(--viz-muted)">user</text><text x="70" y="38" font-size="12" style="fill: var(--viz-muted)">photoUrl</text><text x="156" y="38" font-size="12" style="fill: var(--viz-muted)">email</text><text x="262" y="38" font-size="12" style="fill: var(--viz-muted)">written by</text>
<rect x="8" y="46" width="344" height="26" rx="5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="16" y="64" font-size="12" style="font-family: var(--font-mono)">ada</text><text x="70" y="64" font-size="12" style="fill: var(--viz-muted)">–</text><text x="156" y="64" font-size="12" style="fill: var(--viz-muted)">–</text><text x="262" y="64" font-size="12" font-weight="700" style="fill: var(--viz-c2)">v1 (2019)</text>
<rect x="8" y="76" width="344" height="26" rx="5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="16" y="94" font-size="12" style="font-family: var(--font-mono)">bob</text><text x="70" y="94" font-size="12" style="fill: var(--viz-muted)">–</text><text x="156" y="94" font-size="12" style="fill: var(--viz-muted)">–</text><text x="262" y="94" font-size="12" font-weight="700" style="fill: var(--viz-c2)">v1 (2019)</text>
<rect x="8" y="106" width="344" height="26" rx="5" style="fill: var(--viz-c3-soft); stroke: var(--viz-c3)"/><text x="16" y="124" font-size="12" style="font-family: var(--font-mono)">eve</text><text x="70" y="124" font-size="12" style="font-family: var(--font-mono)">eve.png</text><text x="156" y="124" font-size="12" style="fill: var(--viz-muted)">–</text><text x="262" y="124" font-size="12" font-weight="700" style="fill: var(--viz-c3)">v3 (2022)</text>
<rect x="8" y="136" width="344" height="26" rx="5" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/><text x="16" y="154" font-size="12" style="font-family: var(--font-mono)">raj</text><text x="70" y="154" font-size="12" style="font-family: var(--font-mono)">raj.png</text><text x="156" y="154" font-size="12" style="font-family: var(--font-mono)">raj@x.io</text><text x="262" y="154" font-size="12" font-weight="700" style="fill: var(--viz-c5)">v5 (2026)</text>
<rect x="8" y="166" width="344" height="26" rx="5" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/><text x="16" y="184" font-size="12" style="font-family: var(--font-mono)">kim</text><text x="70" y="184" font-size="12" style="fill: var(--viz-muted)">–</text><text x="156" y="184" font-size="12" style="font-family: var(--font-mono)">kim@x.io</text><text x="262" y="184" font-size="12" font-weight="700" style="fill: var(--viz-c5)">v5 (2026)</text>
<path d="M180,214 L180,196" style="stroke: var(--viz-c5); fill: none" stroke-width="1.6" marker-end="url(#c4d2-do-n)"/>
<rect x="8" y="214" width="344" height="32" rx="8" style="fill: var(--viz-c5-soft); stroke: var(--viz-c5)"/><text x="180" y="235" font-size="12" font-weight="700" text-anchor="middle">v5 code (today) reads every row</text>
<rect x="8" y="256" width="166" height="26" rx="13" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/><text x="91" y="274" font-size="12" font-weight="700" text-anchor="middle">code: minutes</text>
<rect x="186" y="256" width="166" height="26" rx="13" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><text x="269" y="274" font-size="12" font-weight="700" text-anchor="middle">data: rarely, costly</text>
</svg>`,
          caption: "Deploying v5 replaced the code everywhere in minutes, but the rows v1 and v3 wrote are still in their original shape. Today's code must read all of them, filling in whatever an older era never wrote.",
        },
        {
          type: "text",
          html: `<h3>Old rows keep their old shape</h3>
<p>Deploying new application code replaces the old version within minutes. Stored data isn't replaced: a five-year-old record keeps its original encoding unless something rewrites it. One table can therefore hold values written five milliseconds ago and five years ago, by a dozen versions of the code.</p>
<p>You can <strong>migrate</strong>, rewriting every record into the new shape, but on a large dataset that's slow, expensive and risky, so most systems avoid it. Relational databases let you make simple changes, such as adding a column whose default is null, without touching existing rows: when an old row is read, the database fills in null for the column it lacks. The database itself supplies backward compatibility for old rows. LinkedIn's Espresso gets the same effect with Avro: stored records keep their writer's schema, and resolution against the current reader's schema makes the whole database look as if it used one schema, even though it holds records written with many.</p>
<p>Archival copies are the exception. A snapshot taken for backup or for loading into a warehouse is written once and never modified, so it's usually encoded consistently with the latest schema even when the source holds a mix of eras. Because the dump is immutable and read in bulk, Avro object container files or a column-oriented format such as Parquet (see <a href="#/ch3/learn/column-storage">column storage in Chapter 3</a>) fit it well.</p>
<h3>Breaking changes, one compatible step at a time</h3>
<p>Some changes can't be made compatible in one move: renaming a column, splitting a field, changing a type. The answer is <strong>expand/contract</strong> (also called parallel change): first widen the schema so old and new shapes coexist, migrate readers and writers, then narrow it again. Here's a column rename from <code>name</code> to <code>full_name</code>:</p>`,
        },
        {
          type: "steps",
          title: "Renaming a column with expand/contract",
          items: [
            "<strong>Expand.</strong> Add a nullable <code>full_name</code> column, which modern databases do as a metadata-only change. Nothing reads or writes it yet.",
            "<strong>Write both.</strong> Deploy code that writes <code>name</code> and <code>full_name</code> on every insert and update, but still reads <code>name</code>.",
            "<strong>Backfill.</strong> Copy <code>name</code> into <code>full_name</code> for old rows, in small batches so the job doesn't swamp the database, and make it safe to rerun.",
            "<strong>Switch reads.</strong> Deploy code that reads <code>full_name</code>. If you can, compare it with <code>name</code> for a while to catch rows the backfill missed.",
            "<strong>Stop writing the old column.</strong> Deploy code that writes only <code>full_name</code>. From now on, rolling back to a version that reads <code>name</code> would see stale values, so take this step only once you're confident.",
            "<strong>Contract.</strong> Drop <code>name</code> once no deployed version, batch job or report reads it.",
          ],
        },
        {
          type: "text",
          html: `<p>Each step is compatible with the one before it, so every deploy can roll out gradually and be rolled back on its own. The price is time: a rename that one <code>ALTER TABLE</code> could express becomes several deploys over days or weeks. That's the normal cost of changing a schema that live code depends on.</p>`,
        },
        {
          type: "realworld",
          items: [
            { org: "PostgreSQL 11", year: "2018", tag: "Instant defaults", html: `<p><code>ALTER TABLE … ADD COLUMN</code> with a non-volatile <code>DEFAULT</code> no longer rewrites the table: the default is stored in the catalog and supplied when old rows are read, so the database provides backward compatibility for old rows itself.</p>` },
            { org: "MySQL 8.0", year: "2018", tag: "Instant DDL", html: `<p>MySQL 8.0.12 added <code>ALGORITHM=INSTANT</code> for <code>ADD COLUMN</code>, a metadata-only change that avoids copying the table (at first only for columns added at the end of the table).</p>` },
            { org: "Stripe", year: "2017", tag: "Dual writes", html: `<p>Stripe's engineering post "Online migrations at scale" describes a four-phase pattern (dual-write, move reads, move writes, remove old data) used to migrate hundreds of millions of objects without downtime.</p>` },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Since the book: instant DDL and online schema-change tools",
          html: `<p>Adding a column used to mean a table rewrite in several databases; in PostgreSQL 11+ and MySQL 8.0.12+ it is now usually a metadata-only change (see above). For changes that still need a copy, online schema-change tools such as GitHub's gh-ost (see <a href="#/ch2/learn/schema-flexibility">Chapter 2</a>) and Percona's pt-online-schema-change build a shadow table, copy rows in the background, keep it in sync with live writes and swap it in. None of this removes the need for expand/contract: it makes each individual step cheap, not the old and new code compatible.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"Add a field during a rolling deploy without losing data\"",
          html: `<p>A strong answer covers both directions and the write path. New code must read old records (make the field optional with a default), and old code must survive new records, which means preserving unknown fields or updating only the columns it owns, never decoding into a fixed object and writing the whole record back. Ship the preserving reader first, then the writer. For renames or type changes, describe expand/contract with a batched, rerunnable backfill, and mention that a rollback puts old code in front of new data. Weak answers say "just run a migration first", which ignores that v1 is still running while v2 writes.</p>`,
        },
        {
          type: "quiz",
          q: "Old v1 code reads a user record that v2 wrote with a new photoUrl field, changes the bio and saves the record. Which design keeps photoUrl intact?",
          options: [
            "Use a forward-compatible format like Protobuf: old code ignores unknown fields, so nothing is lost",
            "Preserve unknown fields when decoding and write them back, or update only the bio instead of rewriting the whole record",
            "Add a NOT NULL constraint on photoUrl",
            "Run a migration that rewrites every record to the v2 schema before the deploy",
          ],
          answer: 1,
          explain: "Ignoring an unknown field (A) only means v1 can read the record; if v1 decodes into its own object and re-encodes the whole document, the field is gone, whatever the format. You need preservation (carry the unknown bytes along) or a narrower write that touches only the bio. A NOT NULL constraint (C) would reject v1's writes and every older record without a photo; it preserves nothing. A migration (D) doesn't help, because v2 starts writing the field while v1 code is still running.",
        },
      ],
    },
    // ------------------------------------------------------------------ 9
    {
      id: "dataflow-services",
      title: "Through services: REST, RPC and clients you can't upgrade",
      kicker: "Dataflow",
      concepts: ["dataflow-through-services", "rpc-location-transparency", "api-versioning"],
      blocks: [
        {
          type: "problem",
          title: "You can redeploy the server, but not its callers",
          html: `<p>You run a payments API. Your web front end ships with every release, but the iOS app on customers' phones is 18 months old, a partner's Java backend dates from 2021, and a merchant's Python script from 2019 has never been touched. You can redeploy your servers in ten minutes; you can't redeploy any of them. "Change the response and tell people to update" breaks integrations you can't even see, and even the change everyone calls safe, adding a response field, breaks a client whose decoder rejects unknown properties.</p>
<p>Meanwhile, decades of RPC frameworks (CORBA, DCOM, Java RMI, Enterprise JavaBeans) made a network request look exactly like a local function call, so client code assumed calls never get lost, never time out with an unknown outcome and never run twice. Both mistakes pretend the other side of the wire is your own code, on your own version, in your own process.</p>`,
        },
        {
          type: "idea",
          html: `<p>Servers upgrade first, so <strong>requests must stay backward compatible and responses forward compatible</strong>. Additive changes are safe only if clients tolerate unknown fields and values; breaking changes need versions, ideally translated at the edge; and a good RPC API makes the network's failure modes explicit instead of hiding them.</p>`,
        },
        {
          type: "text",
          html: `<h3>Clients, servers and the API as a contract</h3>
<p>Most network dataflow is <strong>clients and servers</strong>: a server exposes an API and clients make requests to it, whether the client is a browser, a mobile app, a single-page JavaScript app or another server (checkout calls payments, which calls fraud detection). Splitting an application into services by area of functionality was called service-oriented architecture (SOA) and, more recently and with some refinement, <strong>microservices</strong>.</p>
<p>Unlike a database, which accepts arbitrary queries in its query language, a service exposes an application-specific API whose inputs and outputs are fixed by its business logic. That <strong>encapsulation</strong> leaves the service free to change everything behind the API. The payoff is <strong>independent deployability</strong>: each team ships its own service without coordinating with every caller. That works only if old and new versions of servers and clients can run side by side, so the encoding must stay compatible across API versions.</p>`,
        },
        {
          type: "compare",
          title: "Three families of service APIs",
          items: [
            { title: "REST", tone: "ok", html: `<p>A design philosophy built on HTTP, defined in Roy Fielding's 2000 dissertation, not a protocol. URLs identify resources, and HTTP's own features handle caching, authentication and content-type negotiation. Usually JSON, often described with OpenAPI (formerly Swagger). You can try it with curl or a browser.</p>` },
            { title: "SOAP", tone: "warn", html: `<p>An XML-based protocol that aims to be independent of HTTP, surrounded by the sprawling WS-* standards. APIs are described in WSDL, from which client code is generated, so it depends heavily on tooling, and interoperability between vendors' implementations was often troublesome. Still found in large enterprises, out of favor elsewhere.</p>` },
            { title: "RPC frameworks", tone: "info", html: `<p>Thrift, Avro RPC and gRPC (Protocol Buffers over HTTP/2) generate client and server stubs from an IDL, so a call looks like a method on an object. Compact binary encodings whose evolution follows the format's rules. Mostly used between services inside one organization.</p>` },
          ],
        },
        {
          type: "text",
          html: `<h3>A network call is not a function call</h3>
<p>Remote procedure calls try to make a request to a network service look exactly like calling a function in your own process, an abstraction called <strong>location transparency</strong>. Enterprise JavaBeans and Java RMI (Java only), DCOM (Microsoft only) and CORBA (famously complex, with no backward or forward compatibility) all took this approach. The convenience is real, but the abstraction is fundamentally flawed, because a network request differs from a local call in at least six ways:</p>
<ol>
<li><strong>It's unpredictable.</strong> The request or response may be lost, or the remote machine may be slow or down, for reasons outside your control. A local call's success depends only on your parameters and code.</li>
<li><strong>A timeout is a new kind of outcome.</strong> A local function returns, throws or never returns. A network call can also come back with nothing, leaving you unsure whether the request got through.</li>
<li><strong>Retrying may do the work twice.</strong> If only the response was lost, a retry repeats an action that already happened (a second charge, say) unless the protocol deduplicates requests (<em>idempotence</em>).</li>
<li><strong>Latency is far higher and wildly variable.</strong> A network call may take a millisecond or a second, depending on congestion and load.</li>
<li><strong>There are no pointers.</strong> Every argument must be encoded into bytes and sent, which gets painful for large objects.</li>
<li><strong>The other side may be a different language.</strong> Types must be translated, sometimes lossily: JavaScript numbers lose precision above 2<sup>53</sup>, as the <a href="#/ch4/learn/textual-formats">section on textual formats</a> shows.</li>
</ol>`,
        },
        {
          type: "diagram",
          title: "Local call versus remote call: the outcomes you can observe",
          svg: `<style>.dd-diagram-body svg.c4d2-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c4d2-w{display:none}.dd-diagram-body svg.c4d2-n{display:block}}</style><svg class="c4d2-w" viewBox="0 0 640 236" role="img" aria-label="A local call inside one process either returns, throws or hangs, and you know which. A remote call across the network can see the response arrive, or the request is lost, the server crashes midway, the response is lost or the response is slow; the last four all look the same to the client: a timeout with an unknown outcome."><defs><marker id="c4d2-lr-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker><marker id="c4d2-lr-ww" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-warn)"/></marker></defs>
<rect x="8" y="8" width="232" height="220" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="22" y="32" font-size="13" font-weight="700">Local call</text>
<rect x="20" y="44" width="208" height="64" rx="8" style="fill: none; stroke: var(--viz-line)" stroke-dasharray="5 4"/><text x="30" y="60" font-size="12" style="fill: var(--viz-muted)">one process</text>
<rect x="30" y="68" width="64" height="30" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="62" y="88" font-size="12" text-anchor="middle">caller</text>
<rect x="116" y="68" width="102" height="30" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="167" y="88" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">chargeCard()</text>
<path d="M94,83 L114,83" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-lr-w)"/>
<circle cx="26" cy="128" r="4" style="fill: var(--viz-ok)"/><text x="38" y="132" font-size="12">returns a result</text>
<circle cx="26" cy="152" r="4" style="fill: var(--viz-ok)"/><text x="38" y="156" font-size="12">throws an exception</text>
<circle cx="26" cy="176" r="4" style="fill: var(--viz-ok)"/><text x="38" y="180" font-size="12">hangs (whole process stuck)</text>
<text x="22" y="214" font-size="12" style="fill: var(--viz-muted)">you always know which happened</text>
<rect x="252" y="8" width="380" height="220" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="266" y="32" font-size="13" font-weight="700">Remote call</text>
<rect x="266" y="46" width="84" height="36" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="308" y="69" font-size="13" font-weight="700" text-anchor="middle">client</text>
<rect x="362" y="46" width="160" height="36" rx="8" style="fill: none; stroke: var(--viz-line)" stroke-dasharray="5 4"/><text x="442" y="69" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">network</text>
<rect x="534" y="46" width="84" height="36" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="576" y="69" font-size="13" font-weight="700" text-anchor="middle">server</text>
<circle cx="272" cy="106" r="4" style="fill: var(--viz-ok)"/><text x="282" y="110" font-size="12">response arrives</text>
<circle cx="272" cy="130" r="4" style="fill: var(--viz-bad)"/><text x="282" y="134" font-size="12">request lost</text>
<circle cx="272" cy="152" r="4" style="fill: var(--viz-bad)"/><text x="282" y="156" font-size="12">server crashed midway</text>
<circle cx="272" cy="174" r="4" style="fill: var(--viz-bad)"/><text x="282" y="178" font-size="12">response lost</text>
<circle cx="272" cy="196" r="4" style="fill: var(--viz-warn)"/><text x="282" y="200" font-size="12">response slow</text>
<path d="M366,130 L466,150" style="stroke: var(--viz-warn); fill: none" stroke-width="1.4" marker-end="url(#c4d2-lr-ww)"/><path d="M428,152 L466,160" style="stroke: var(--viz-warn); fill: none" stroke-width="1.4" marker-end="url(#c4d2-lr-ww)"/><path d="M372,174 L466,170" style="stroke: var(--viz-warn); fill: none" stroke-width="1.4" marker-end="url(#c4d2-lr-ww)"/><path d="M372,196 L466,180" style="stroke: var(--viz-warn); fill: none" stroke-width="1.4" marker-end="url(#c4d2-lr-ww)"/>
<rect x="470" y="130" width="150" height="66" rx="10" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><text x="545" y="150" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">client sees only</text><text x="545" y="168" font-size="13" font-weight="700" text-anchor="middle">a timeout:</text><text x="545" y="186" font-size="13" font-weight="700" text-anchor="middle">outcome unknown</text>
<text x="266" y="220" font-size="12" style="fill: var(--viz-muted)">a blind retry may run it twice (see ch8 and ch12)</text>
</svg><svg class="c4d2-n" viewBox="0 0 360 412" role="img" aria-label="Local call: returns, throws or hangs, and you know which. Remote call: response arrives, or request lost, server crashed midway, response lost or response slow, which all look like a timeout with unknown outcome."><defs><marker id="c4d2-lr-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker><marker id="c4d2-lr-nw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-warn)"/></marker></defs>
<rect x="8" y="8" width="344" height="176" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="20" y="30" font-size="13" font-weight="700">Local call</text>
<rect x="20" y="42" width="320" height="46" rx="8" style="fill: none; stroke: var(--viz-line)" stroke-dasharray="5 4"/>
<rect x="30" y="50" width="70" height="30" rx="6" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="65" y="70" font-size="12" text-anchor="middle">caller</text>
<rect x="122" y="50" width="110" height="30" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="177" y="70" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">chargeCard()</text>
<path d="M100,65 L120,65" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-lr-n)"/><text x="330" y="70" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">one process</text>
<circle cx="26" cy="106" r="4" style="fill: var(--viz-ok)"/><text x="38" y="110" font-size="12">returns a result</text>
<circle cx="26" cy="126" r="4" style="fill: var(--viz-ok)"/><text x="38" y="130" font-size="12">throws an exception</text>
<circle cx="26" cy="146" r="4" style="fill: var(--viz-ok)"/><text x="38" y="150" font-size="12">hangs (whole process stuck)</text>
<text x="20" y="170" font-size="12" style="fill: var(--viz-muted)">you always know which happened</text>
<rect x="8" y="190" width="344" height="216" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="20" y="212" font-size="13" font-weight="700">Remote call</text>
<rect x="20" y="224" width="76" height="32" rx="8" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="58" y="245" font-size="12" font-weight="700" text-anchor="middle">client</text>
<rect x="104" y="224" width="152" height="32" rx="8" style="fill: none; stroke: var(--viz-line)" stroke-dasharray="5 4"/><text x="180" y="245" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">network</text>
<rect x="264" y="224" width="76" height="32" rx="8" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="302" y="245" font-size="12" font-weight="700" text-anchor="middle">server</text>
<circle cx="26" cy="278" r="4" style="fill: var(--viz-ok)"/><text x="36" y="282" font-size="12">response arrives</text>
<circle cx="26" cy="300" r="4" style="fill: var(--viz-bad)"/><text x="36" y="304" font-size="12">request lost</text>
<circle cx="26" cy="320" r="4" style="fill: var(--viz-bad)"/><text x="36" y="324" font-size="12">server crashed midway</text>
<circle cx="26" cy="340" r="4" style="fill: var(--viz-bad)"/><text x="36" y="344" font-size="12">response lost</text>
<circle cx="26" cy="360" r="4" style="fill: var(--viz-warn)"/><text x="36" y="364" font-size="12">response slow</text>
<path d="M116,300 L196,318" style="stroke: var(--viz-warn); fill: none" stroke-width="1.4" marker-end="url(#c4d2-lr-nw)"/><path d="M176,320 L196,328" style="stroke: var(--viz-warn); fill: none" stroke-width="1.4" marker-end="url(#c4d2-lr-nw)"/><path d="M124,340 L196,338" style="stroke: var(--viz-warn); fill: none" stroke-width="1.4" marker-end="url(#c4d2-lr-nw)"/><path d="M124,360 L196,348" style="stroke: var(--viz-warn); fill: none" stroke-width="1.4" marker-end="url(#c4d2-lr-nw)"/>
<rect x="200" y="300" width="140" height="66" rx="10" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><text x="270" y="320" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">client sees only</text><text x="270" y="338" font-size="13" font-weight="700" text-anchor="middle">a timeout:</text><text x="270" y="356" font-size="13" font-weight="700" text-anchor="middle">outcome unknown</text>
<text x="20" y="394" font-size="12" style="fill: var(--viz-muted)">a blind retry may run it twice (ch8, ch12)</text>
</svg>`,
          caption: "Four different failures produce one observation. The client can't tell a lost request (nothing happened) from a lost response (the card was charged), which is exactly why blind retries are dangerous.",
        },
        {
          type: "text",
          html: `<p>Seen this way, there's no point making a remote service look too much like a local object. Part of REST's appeal is that it doesn't pretend: a request is visibly a request, and status codes, timeouts and retries show up in the code that makes it.</p>`,
        },
        {
          type: "callout",
          tone: "tip",
          title: "Where to explore the failures hands-on",
          html: `<p>This chapter stops at the list. To inject the faults yourself (lose the request, lose the response, crash the server midway) and see why the client can't tell them apart, use the "What happened to my request?" visualization in <a href="#/ch8/learn/unreliable-networks">Chapter 8</a>. Turning blind retries into safe ones, with operation IDs that survive end to end, is a theme of <a href="#/ch12">Chapter 12</a>.</p>`,
        },
        {
          type: "text",
          html: `<h3>RPC that admits it's remote</h3>
<p>Newer RPC frameworks keep the generated stubs but stop pretending. Finagle (Twitter, over Thrift) and Rest.li (LinkedIn, JSON over HTTP) return <strong>futures</strong> (promises) that make failure an explicit value and let you combine parallel requests. gRPC supports <strong>streams</strong>, where one call carries a series of messages, and <strong>deadlines</strong> that propagate to downstream calls. Most frameworks add <strong>service discovery</strong>, so clients can find services whose instances come and go.</p>
<p>A custom binary RPC protocol can outperform generic JSON over REST, but REST keeps strong advantages for public APIs: you can experiment with curl or a browser, every platform supports it, and a vast ecosystem of caches, load balancers, proxies, firewalls and monitoring tools understands HTTP. So the usual split is REST (or GraphQL) for public APIs and RPC frameworks between services of one organization, typically within one datacenter.</p>
<h3>Who must be compatible with whom</h3>
<p>One assumption makes API evolution tractable: <strong>servers are upgraded before clients</strong>. You roll out your servers in minutes; clients upgrade later, or never.</p>`,
        },
        {
          type: "diagram",
          title: "Servers upgrade first: what each direction of traffic needs",
          svg: `<style>.dd-diagram-body svg.c4d2-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c4d2-w{display:none}.dd-diagram-body svg.c4d2-n{display:block}}</style><svg class="c4d2-w" viewBox="0 0 640 156" role="img" aria-label="An old v1 client talks to a new v2 server that was deployed first. The request travels from old code to new code and needs backward compatibility; the response travels from new code to old code and needs forward compatibility."><defs><marker id="c4d2-do2-w6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker><marker id="c4d2-do2-w1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker></defs>
<rect x="8" y="12" width="150" height="112" rx="12" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="83" y="52" font-size="13" font-weight="700" text-anchor="middle">old client (v1)</text><text x="83" y="72" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">upgrades in weeks,</text><text x="83" y="88" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">months, or never</text>
<rect x="482" y="12" width="150" height="112" rx="12" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="557" y="52" font-size="13" font-weight="700" text-anchor="middle">new server (v2)</text><text x="557" y="72" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">deployed first,</text><text x="557" y="88" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">in minutes</text>
<path d="M158,44 L480,44" style="stroke: var(--viz-c6); fill: none" stroke-width="2" marker-end="url(#c4d2-do2-w6)"/><text x="320" y="34" font-size="13" font-weight="700" text-anchor="middle">request: backward compatible</text><text x="320" y="62" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">new code reads data written by old code</text>
<path d="M482,96 L160,96" style="stroke: var(--viz-c1); fill: none" stroke-width="2" marker-end="url(#c4d2-do2-w1)"/><text x="320" y="86" font-size="13" font-weight="700" text-anchor="middle">response: forward compatible</text><text x="320" y="114" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">old code reads data written by new code</text>
<text x="320" y="148" font-size="12" text-anchor="middle">So: new request parameters need defaults, and clients must ignore unknown response fields.</text>
</svg><svg class="c4d2-n" viewBox="0 0 360 306" role="img" aria-label="A new server deployed first and an old client. The request from old client to new server needs backward compatibility; the response from new server to old client needs forward compatibility."><defs><marker id="c4d2-do2-n6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c6)"/></marker><marker id="c4d2-do2-n1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker></defs>
<rect x="8" y="8" width="344" height="44" rx="10" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="180" y="35" font-size="13" font-weight="700" text-anchor="middle">new server (v2): deployed first</text>
<rect x="8" y="214" width="344" height="44" rx="10" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="180" y="241" font-size="12" font-weight="700" text-anchor="middle">old client (v1): upgrades late, or never</text>
<path d="M40,214 L40,54" style="stroke: var(--viz-c6); fill: none" stroke-width="2" marker-end="url(#c4d2-do2-n6)"/><text x="54" y="98" font-size="13" font-weight="700">request</text><text x="54" y="116" font-size="12">backward compatible</text><text x="54" y="134" font-size="12" style="fill: var(--viz-muted)">new code reads</text><text x="54" y="150" font-size="12" style="fill: var(--viz-muted)">old data</text>
<path d="M200,52 L200,212" style="stroke: var(--viz-c1); fill: none" stroke-width="2" marker-end="url(#c4d2-do2-n1)"/><text x="214" y="98" font-size="13" font-weight="700">response</text><text x="214" y="116" font-size="12">forward compatible</text><text x="214" y="134" font-size="12" style="fill: var(--viz-muted)">old code reads</text><text x="214" y="150" font-size="12" style="fill: var(--viz-muted)">new data</text>
<text x="180" y="282" font-size="12" text-anchor="middle">New request parameters need defaults;</text><text x="180" y="298" font-size="12" text-anchor="middle">clients must ignore unknown fields.</text>
</svg>`,
          caption: "It's one pair of programs, but the two directions of traffic need opposite kinds of compatibility, because the newer code is the reader in one direction and the writer in the other.",
        },
        {
          type: "text",
          html: `<p>So requests need <strong>backward</strong> compatibility and responses need <strong>forward</strong> compatibility. Both are inherited from the encoding: Thrift, gRPC and Avro RPC evolve by their format's rules, SOAP through XML Schema (with some pitfalls), and JSON REST APIs by convention, under which adding optional request parameters and new response fields is usually considered compatible.</p>
<h3>Additive versus breaking</h3>
<p>Most API providers make this an explicit policy. <strong>Additive</strong> changes (new optional request parameters, new response fields, new endpoints and, in many APIs' policies, new enum values) ship to every client at once and rely on clients ignoring what they don't recognize. <strong>Breaking</strong> changes (new required parameters, renames, type changes, removals, changes of meaning) ship only behind a new version.</p>
<p>The weak point: "additive" is only as safe as the client's decoder. Java's Jackson library fails on unknown properties by default, though Spring Boot's auto-configured mapper turns that off, so one model class behaves differently in two projects. Swift's Codable ignores unknown keys but throws when a string-backed enum meets a value it doesn't list. A script's <code>if status == "succeeded" … else</code> silently files a new <code>pending</code> status under failure. So publish the tolerance rules (ignore unknown fields, treat enums as open-ended) in the API contract from day one.</p>
<p>In the visualization the server already runs the new code. Pick a change and a way to ship it, and watch four clients of different ages call it.</p>`,
        },
        {
          type: "viz",
          id: "ch4/api-evolution",
          title: "Old clients vs a changing API",
          caption: "Try the default change (a new response field): it's additive, yet the partner's Jackson client breaks under every strategy. Then pick 'Rename amount to amount_cents' and switch between In place, /v2 URL and Pinned dates, and finish with 'Add enum value status: pending'. Notice that versioning rescues renames, type changes and removals, but can't save clients from additions they refuse to tolerate, and that the 2019 script misreads 'pending' without raising any error.",
        },
        {
          type: "text",
          html: `<p>Two lessons come out of the experiment. The textbook-safe change still broke a client, and versioning couldn't help, because additive changes go to every version by policy; only tolerant decoders fix that. And removals are the change you can least see coming: without per-client usage telemetry you don't know who reads a field, so removals go through a version and a deprecation window.</p>
<h3>Versioning APIs you can't force anyone to upgrade</h3>
<p>Inside one organization you can eventually make every client upgrade. Across organizations you can't, so compatibility must hold for a long time, perhaps forever, and breaking changes mean running several API versions side by side. There's no agreed way to version: common choices put the version in the URL (<code>/v1/charges</code>), in the HTTP <code>Accept</code> header, or store it server-side per API key, set when the client first integrates, changed in an admin console and overridable per request. Stripe works the last way, with versions named by date.</p>
<p>Whatever the scheme, the core code shouldn't fill up with "if version &lt; X" branches. Stripe translates at the edge: the core speaks only the newest contract, and small <strong>version change modules</strong> rewrite requests up and responses down for clients pinned to older versions. Some changes can't be translated back (a new state old clients have no word for), so the additive/breaking line has to be drawn deliberately. And because a timeout leaves the outcome unknown, mutating endpoints should accept an <strong>idempotency key</strong>: the server stores the first result under the key and returns it for any retry carrying the same key (Stripe's <code>Idempotency-Key</code> header is the standard example; see <a href="#/ch12/learn/end-to-end-argument">Chapter 12</a>).</p>`,
        },
        {
          type: "realworld",
          items: [
            { org: "Stripe", tag: "API versioning", html: `<p>Each account is pinned to the API version, a date such as 2017-05-25, that was current at its first API request, and can override it per request with the <code>Stripe-Version</code> header. Stripe's 2017 post "APIs as infrastructure" describes small version-change modules that transform responses back into older shapes.</p>` },
            { org: "GitHub REST API", year: "2022", tag: "Header versions", html: `<p>GitHub selects date-based REST API versions with the <code>X-GitHub-Api-Version</code> header; the first such version is 2022-11-28.</p>` },
            { org: "gRPC", tag: "RPC", html: `<p>Supports unary, server-streaming, client-streaming and bidirectional-streaming calls over HTTP/2, and lets callers set deadlines that propagate to downstream calls, making time limits explicit.</p>` },
            { org: "Sun Microsystems", year: "1994", tag: "Paper", html: `<p>"A Note on Distributed Computing" (Waldo, Wyant, Wollrath and Kendall) argued that hiding the difference between local and remote objects is fundamentally flawed, because of latency, memory access, partial failure and concurrency.</p>` },
            { org: "Jackson", tag: "Java JSON", html: `<p><code>DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES</code> is enabled by default, so a client that deserializes into a fixed class throws <code>UnrecognizedPropertyException</code> when a server adds a response field. Spring Boot's auto-configured <code>ObjectMapper</code> disables the feature.</p>` },
            { org: "Swift Codable", tag: "iOS", html: `<p>Synthesized <code>Decodable</code> conformances ignore keys the type doesn't declare, but decoding a String-backed enum from a value it doesn't list throws <code>DecodingError.dataCorrupted</code>, so one new enum value fails the decode of the whole response.</p>` },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Since the book: gRPC, GraphQL and dated header versions",
          html: `<p>gRPC, open-sourced by Google in 2015 and at 1.0 in 2016, became a common choice for internal service-to-service calls, with deadlines and four call types built in. GraphQL argues against versions altogether: one evolving schema in which fields are marked <code>@deprecated</code> and removed only when usage data shows clients have moved on, which works because clients must name every field they read. And date-based versions selected by a header spread beyond Stripe; GitHub's REST API adopted them in 2022.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"REST or gRPC? And how will this API evolve?\"",
          html: `<p>A strong answer picks by audience: gRPC between your own services (typed contracts, generated code, streaming, deadlines, Protobuf's evolution rules) and REST with JSON at the public edge (debuggable, universal, cacheable). Then it covers evolution: servers deploy first, so requests stay backward compatible and responses forward compatible; an additive-change policy with documented tolerance rules (ignore unknown fields, open-ended enums); breaking changes behind versions translated at the edge; usage telemetry before any removal; and idempotency keys because retries after a timeout are inevitable. Weak answers treat RPC as "just a function call" or claim that a version in the URL means clients never need to tolerate anything.</p>`,
        },
        {
          type: "quiz",
          q: "Your team always upgrades API servers before any clients. Which compatibility does each direction of traffic need?",
          options: [
            "Requests need backward compatibility (the new server reads old clients' requests); responses need forward compatibility (old clients read the new server's responses)",
            "Requests need forward compatibility; responses need backward compatibility",
            "Only backward compatibility, because the server is always the newer side",
            "Neither, as long as the API version is in the URL",
          ],
          answer: 0,
          explain: "The server is the newer code. It reads requests written by older clients: new code reading old data is backward compatibility. Old clients read responses written by newer code: forward compatibility, which is why clients must ignore unknown fields. The tempting answer C forgets that the newer server is also a writer. URL versions (D) cover changes you classify as breaking, but additive changes still reach old clients, so those clients must tolerate them.",
        },
      ],
    },
    // ------------------------------------------------------------------ 10
    {
      id: "dataflow-messages",
      title: "Through messages: brokers and actors decouple sender from receiver",
      kicker: "Dataflow",
      concepts: ["dataflow-async-messaging", "actor-model"],
      blocks: [
        {
          type: "problem",
          title: "RPC needs the other side up, reachable and fast, right now",
          html: `<p>With RPC the caller needs the callee to be running, reachable at a known address and fast enough, at this very moment. Picture a signup service that calls the email service synchronously to send a welcome message. While the email service restarts during a deploy, every signup waits or fails. When a marketing campaign triples traffic, the slower email service is overwhelmed and drags signups down with it. And when the analytics and CRM teams also want to hear about new signups, the signup service has to know about each of them and call each one.</p>
<p>None of these callers needs an answer right away; they just need the message to arrive eventually. <strong>Asynchronous message passing</strong> puts an intermediary in the middle so the sender can hand off the message and move on.</p>`,
        },
        {
          type: "idea",
          html: `<p>A <strong>message broker</strong> stores messages between senders and receivers, decoupling them in time and in space; <strong>actors</strong> bring the same message-passing idea into the programming model. Either way, producers and consumers upgrade independently, so encodings still need backward and forward compatibility.</p>`,
        },
        {
          type: "text",
          html: `<h3>Halfway between RPC and a database</h3>
<p>Asynchronous message-passing systems sit between the two dataflows we've seen. As with RPC, a client's request, here called a <strong>message</strong>, is delivered to another process with low latency. As with a database, it isn't sent over a direct connection: it goes via an intermediary called a <strong>message broker</strong> (also called a message queue or message-oriented middleware), which stores it temporarily.</p>
<p>Communication is usually <strong>one-way</strong>: the sender hands over the message and doesn't wait for it to be processed. If the receiver wants to reply, it sends a separate message, often to a reply queue the sender listens on. That asynchrony is the point, as the picture shows.</p>`,
        },
        {
          type: "diagram",
          title: "Direct call versus a broker in the middle",
          svg: `<style>.dd-diagram-body svg.c4d2-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c4d2-w{display:none}.dd-diagram-body svg.c4d2-n{display:block}}</style><svg class="c4d2-w" viewBox="0 0 640 250" role="img" aria-label="Direct RPC: the signup service calls the email service, which is down, so signup waits or fails. Via a broker: the producer publishes to a topic holding three messages; the email service, which crashed, gets message 1 redelivered, and analytics gets its own copy of every message. The producer only knows the topic name."><defs><marker id="c4d2-bk-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker><marker id="c4d2-bk-wb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker></defs>
<text x="8" y="20" font-size="13" font-weight="700">Direct RPC</text>
<rect x="8" y="30" width="120" height="44" rx="10" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="68" y="49" font-size="13" font-weight="700" text-anchor="middle">Producer</text><text x="68" y="65" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">signup service</text>
<path d="M128,52 L260,52" style="stroke: var(--viz-bad); fill: none" stroke-width="1.6" marker-end="url(#c4d2-bk-wb)"/><text x="194" y="44" font-size="12" text-anchor="middle">call</text>
<rect x="264" y="30" width="132" height="44" rx="10" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/><text x="330" y="49" font-size="13" font-weight="700" text-anchor="middle">email service</text><text x="330" y="65" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">down: restarting</text>
<text x="412" y="49" font-size="12" font-weight="700" style="fill: var(--viz-bad)">signup waits or fails</text><text x="412" y="65" font-size="12" style="fill: var(--viz-muted)">every caller retries on its own</text>
<line x1="8" y1="92" x2="632" y2="92" style="stroke: var(--viz-grid)"/>
<text x="8" y="114" font-size="13" font-weight="700">Via a broker</text>
<rect x="8" y="136" width="120" height="44" rx="10" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="68" y="155" font-size="13" font-weight="700" text-anchor="middle">Producer</text><text x="68" y="171" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">signup service</text>
<path d="M128,158 L164,158" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-bk-w)"/>
<rect x="168" y="124" width="200" height="68" rx="10" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="268" y="142" font-size="12" font-weight="700" text-anchor="middle">broker: topic signups</text>
<rect x="180" y="152" width="56" height="28" rx="4" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><text x="208" y="171" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">msg 3</text>
<rect x="240" y="152" width="56" height="28" rx="4" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><text x="268" y="171" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">msg 2</text>
<rect x="300" y="152" width="56" height="28" rx="4" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><text x="328" y="171" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">msg 1</text>
<path d="M368,150 L428,140" style="stroke: var(--viz-c2); fill: none" stroke-width="1.6" marker-end="url(#c4d2-bk-w)"/><path d="M368,168 L428,194" style="stroke: var(--viz-c2); fill: none" stroke-width="1.6" marker-end="url(#c4d2-bk-w)"/>
<rect x="430" y="118" width="202" height="44" rx="10" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="531" y="137" font-size="13" font-weight="700" text-anchor="middle">email service</text><text x="531" y="153" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">crashed: msg 1 redelivered</text>
<rect x="430" y="174" width="202" height="44" rx="10" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="531" y="193" font-size="13" font-weight="700" text-anchor="middle">analytics</text><text x="531" y="209" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">gets every message too</text>
<text x="320" y="242" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">Buffering, redelivery and fan-out; the producer knows only the topic name.</text>
</svg><svg class="c4d2-n" viewBox="0 0 360 362" role="img" aria-label="Direct RPC to a down email service makes signup wait or fail. Via a broker, the producer publishes to a topic; the crashed email service gets message 1 redelivered and analytics gets every message too."><defs><marker id="c4d2-bk-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker><marker id="c4d2-bk-nb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker></defs>
<text x="8" y="20" font-size="13" font-weight="700">Direct RPC</text>
<rect x="8" y="30" width="120" height="44" rx="10" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="68" y="49" font-size="12" font-weight="700" text-anchor="middle">Producer</text><text x="68" y="65" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">signup</text>
<path d="M128,52 L222,52" style="stroke: var(--viz-bad); fill: none" stroke-width="1.6" marker-end="url(#c4d2-bk-nb)"/><text x="175" y="44" font-size="12" text-anchor="middle">call</text>
<rect x="226" y="30" width="126" height="44" rx="10" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/><text x="289" y="49" font-size="12" font-weight="700" text-anchor="middle">email service</text><text x="289" y="65" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">down</text>
<text x="8" y="96" font-size="12" font-weight="700" style="fill: var(--viz-bad)">signup waits or fails</text>
<line x1="8" y1="110" x2="352" y2="110" style="stroke: var(--viz-grid)"/>
<text x="8" y="132" font-size="13" font-weight="700">Via a broker</text>
<rect x="8" y="142" width="344" height="36" rx="10" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><text x="180" y="165" font-size="12" font-weight="700" text-anchor="middle">Producer (signup service)</text>
<path d="M180,178 L180,192" style="stroke: var(--viz-muted); fill: none" stroke-width="1.6" marker-end="url(#c4d2-bk-n)"/>
<rect x="8" y="194" width="344" height="64" rx="10" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/><text x="180" y="212" font-size="12" font-weight="700" text-anchor="middle">broker: topic signups</text>
<rect x="40" y="222" width="80" height="28" rx="4" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><text x="80" y="241" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">msg 3</text>
<rect x="140" y="222" width="80" height="28" rx="4" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><text x="180" y="241" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">msg 2</text>
<rect x="240" y="222" width="80" height="28" rx="4" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><text x="280" y="241" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">msg 1</text>
<path d="M92,258 L92,278" style="stroke: var(--viz-c2); fill: none" stroke-width="1.6" marker-end="url(#c4d2-bk-n)"/><path d="M268,258 L268,278" style="stroke: var(--viz-c2); fill: none" stroke-width="1.6" marker-end="url(#c4d2-bk-n)"/>
<rect x="8" y="280" width="168" height="50" rx="10" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="92" y="300" font-size="12" font-weight="700" text-anchor="middle">email service</text><text x="92" y="317" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">msg 1 redelivered</text>
<rect x="184" y="280" width="168" height="50" rx="10" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/><text x="268" y="300" font-size="12" font-weight="700" text-anchor="middle">analytics</text><text x="268" y="317" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">gets every message</text>
<text x="180" y="352" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">The producer knows only the topic name.</text>
</svg>`,
          caption: "In the direct call, one restarting service blocks its caller. With a broker, messages wait while the email service restarts, the one it crashed on is redelivered, and a second subscriber was added without touching the producer.",
        },
        {
          type: "keypoints",
          title: "What a broker buys you over direct RPC",
          items: [
            "<strong>Buffering.</strong> If the recipient is down or overloaded, messages wait in the broker instead of failing, which improves reliability.",
            "<strong>Redelivery.</strong> If a consumer crashes while handling a message, the broker can deliver it again, so the message isn't lost.",
            "<strong>No addresses.</strong> The sender needs only a queue or topic name, not the recipient's IP address and port, which matters in clouds where instances come and go.",
            "<strong>Fan-out.</strong> One message can be delivered to several recipients.",
            "<strong>Logical decoupling.</strong> The sender just publishes and doesn't care who consumes; new consumers can be added without changing it.",
          ],
        },
        {
          type: "text",
          html: `<h3>Brokers, topics and the bytes inside</h3>
<p>Message brokers were once dominated by commercial enterprise products such as TIBCO, IBM WebSphere MQ and webMethods; today open-source ones such as RabbitMQ, ActiveMQ, NATS and Apache Kafka are common. The general model: a producer sends a message to a named <strong>queue</strong> or <strong>topic</strong>, and the broker delivers it to one or more <strong>consumers</strong> or subscribers. A topic can have many producers and many consumers. Topics are one-way, but a consumer may publish to another topic, chaining processing steps, or to a reply queue to emulate request and response. Delivery semantics differ a lot between brokers and are the subject of <a href="#/ch11/learn/messaging-systems">Chapter 11's messaging systems section</a>.</p>
<p>A broker doesn't enforce any data model: a message is a sequence of bytes plus some metadata, so any encoding works. If that encoding is backward and forward compatible, publishers and consumers can be changed and deployed independently, in any order. Two traps carry over from the earlier sections:</p>
<ul>
<li><strong>Republishing consumers must preserve unknown fields.</strong> A consumer that reads a message, enriches it and publishes the result to another topic is doing a decode-modify-encode round trip, exactly like the database case. If its model drops fields it doesn't know, every consumer downstream loses them.</li>
<li><strong>Retained history must stay readable.</strong> Log-based brokers such as Kafka keep messages for a configured period, or indefinitely, and a new consumer may replay from the beginning. It then reads every schema version still retained, not just the latest, which is why registries offer transitive compatibility modes.</li>
</ul>
<p>Event payloads are therefore a public contract, with the same additive-versus-breaking discipline as API responses. The difference is time: consumers may read an event months after it was written. A breaking change usually means a new event type or a new topic, with producers writing both during a migration window, rather than an in-place edit.</p>`,
        },
        {
          type: "text",
          html: `<h3>Actors: message passing as a programming model</h3>
<p>The <strong>actor model</strong> is a programming model for concurrency within a single process. Instead of threads that share memory guarded by locks, with the race conditions and deadlocks that brings, logic is split into <strong>actors</strong>. Each actor typically represents one client or entity, holds private state that no other actor can touch, and communicates only by sending and receiving asynchronous messages. An actor processes one message at a time, so it needs no locks, and a scheduler can run many actors on a few threads. Message delivery isn't guaranteed: in some error scenarios, messages are lost.</p>
<p>A <strong>distributed actor framework</strong> stretches this across machines. The same message-passing mechanism is used whether sender and recipient are on the same node or on different ones; a message to a remote actor is transparently encoded into bytes, sent over the network and decoded on the other side. <span class="hl">Location transparency works better here than in RPC</span>: actor code is already written to expect missing messages, even inside one process. A remote hop is slower than a local one, but there's no fundamental mismatch between the two cases. In effect, a distributed actor framework integrates a message broker into the programming model.</p>
<p>The encoding still matters: during a rolling upgrade, an actor on a new node may send messages to an actor on an old node, so those messages need backward and forward compatible encodings.</p>`,
        },
        {
          type: "diagram",
          title: "Distributed actors: the same send, locally or across nodes",
          svg: `<style>.dd-diagram-body svg.c4d2-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c4d2-w{display:none}.dd-diagram-body svg.c4d2-n{display:block}}</style><svg class="c4d2-w" viewBox="0 0 640 230" role="img" aria-label="Two nodes each hold two actors with a mailbox and private state. Actor A sends to B on the same node, B sends to C on the other node with the same send, and a message from C to D on the same node is lost. Cross-node messages are encoded, so rolling upgrades need compatible encodings."><defs><marker id="c4d2-ac-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker></defs>
<rect x="8" y="8" width="282" height="148" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="22" y="30" font-size="13" font-weight="700">Node 1</text>
<rect x="348" y="8" width="284" height="148" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="362" y="30" font-size="13" font-weight="700">Node 2</text>
<text x="38" y="70" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">mailbox</text>
<rect x="30" y="76" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="30" y="88" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="30" y="100" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<rect x="180" y="76" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="180" y="88" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="180" y="100" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<rect x="362" y="76" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="362" y="88" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="362" y="100" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<rect x="512" y="76" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="512" y="88" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="512" y="100" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<circle cx="80" cy="92" r="24" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="80" y="97" font-size="13" font-weight="700" text-anchor="middle">A</text><text x="80" y="136" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">state</text>
<circle cx="230" cy="92" r="24" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="230" y="97" font-size="13" font-weight="700" text-anchor="middle">B</text><text x="230" y="136" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">state</text>
<circle cx="412" cy="92" r="24" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="412" y="97" font-size="13" font-weight="700" text-anchor="middle">C</text><text x="412" y="136" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">state</text>
<circle cx="562" cy="92" r="24" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="562" y="97" font-size="13" font-weight="700" text-anchor="middle">D</text><text x="562" y="136" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">state</text>
<path d="M104,92 L176,92" style="stroke: var(--viz-c1); fill: none" stroke-width="1.8" marker-end="url(#c4d2-ac-w)"/><text x="140" y="82" font-size="12" text-anchor="middle">send</text>
<path d="M254,92 L358,92" style="stroke: var(--viz-c1); fill: none" stroke-width="1.8" stroke-dasharray="6 3" marker-end="url(#c4d2-ac-w)"/><text x="319" y="82" font-size="12" text-anchor="middle">send</text><text x="319" y="112" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">bytes</text>
<path d="M436,92 L464,92" style="stroke: var(--viz-c1); fill: none" stroke-width="1.8"/><path d="M466,86 L478,98 M478,86 L466,98" style="stroke: var(--viz-bad)" stroke-width="2.2"/><text x="474" y="126" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">may be lost,</text><text x="474" y="140" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">even locally</text>
<text x="320" y="190" font-size="12" text-anchor="middle">Local and cross-node sends look identical to the code.</text><text x="320" y="210" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">Cross-node messages are encoded bytes: rolling upgrades need compatible encodings.</text>
</svg><svg class="c4d2-n" viewBox="0 0 360 346" role="img" aria-label="Two nodes each hold two actors with mailboxes and private state. A sends to B locally, B sends to D on the other node with the same send, and a message from C to D is lost even locally."><defs><marker id="c4d2-ac-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker></defs>
<rect x="8" y="8" width="344" height="120" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="20" y="28" font-size="13" font-weight="700">Node 1</text>
<rect x="8" y="160" width="344" height="136" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/><text x="20" y="180" font-size="13" font-weight="700">Node 2</text>
<text x="68" y="48" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">mailbox</text>
<rect x="60" y="54" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="60" y="66" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="60" y="78" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<rect x="220" y="54" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="220" y="66" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="220" y="78" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<rect x="60" y="206" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="60" y="218" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="60" y="230" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<rect x="220" y="206" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="220" y="218" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="220" y="230" width="16" height="9" rx="2" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
<circle cx="110" cy="70" r="24" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="110" y="75" font-size="13" font-weight="700" text-anchor="middle">A</text><text x="110" y="112" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">state</text>
<circle cx="270" cy="70" r="24" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="270" y="75" font-size="13" font-weight="700" text-anchor="middle">B</text><text x="258" y="112" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">state</text>
<circle cx="110" cy="222" r="24" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="110" y="227" font-size="13" font-weight="700" text-anchor="middle">C</text><text x="110" y="264" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">state</text>
<circle cx="270" cy="222" r="24" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><text x="270" y="227" font-size="13" font-weight="700" text-anchor="middle">D</text><text x="258" y="264" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">state</text>
<path d="M134,70 L216,70" style="stroke: var(--viz-c1); fill: none" stroke-width="1.8" marker-end="url(#c4d2-ac-n)"/><text x="175" y="62" font-size="12" text-anchor="middle">send</text>
<path d="M286,88 L286,200" style="stroke: var(--viz-c1); fill: none" stroke-width="1.8" stroke-dasharray="6 3" marker-end="url(#c4d2-ac-n)"/><text x="276" y="148" font-size="12" text-anchor="end">send, as bytes</text>
<path d="M134,222 L172,222" style="stroke: var(--viz-c1); fill: none" stroke-width="1.8"/><path d="M174,216 L186,228 M186,216 L174,228" style="stroke: var(--viz-bad)" stroke-width="2.2"/><text x="184" y="284" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">may be lost, even locally</text>
<text x="180" y="320" font-size="12" text-anchor="middle">Same send() locally and across nodes;</text><text x="180" y="338" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">cross-node messages need compatible encodings.</text>
</svg>`,
          caption: "Each actor owns its state and handles one message from its mailbox at a time. Because code is written expecting any message to vanish, moving an actor to another node breaks no assumption, but the message now crosses the wire as encoded bytes.",
        },
        {
          type: "table",
          title: "Distributed actor frameworks and rolling upgrades",
          headers: ["Framework", "Default encoding (2017)", "Rolling upgrades (2017)", "Since then"],
          rows: [
            [`<span style="white-space:nowrap"><strong>Akka</strong> (JVM)</span>`, "Java's built-in serialization", "No forward or backward compatibility by default; swap in Protocol Buffers to get it", "Akka 2.6 (2019) disabled Java serialization by default and recommends Jackson- or Protobuf-based serializers"],
            [`<span style="white-space:nowrap"><strong>Orleans</strong> (.NET)</span>`, "A custom encoding format", "Not supported: deploy a new cluster, move traffic over, shut the old one down (custom serialization plug-ins possible)", "Orleans 7.0 (2022) introduced a version-tolerant serializer in which types mark members with numeric ids, much like field tags"],
            [`<span style="white-space:nowrap"><strong>Erlang/OTP</strong></span>`, "Erlang's own term format", "Possible, but changing record schemas is surprisingly hard and needs careful planning", "Maps (OTP 17, 2014), which the book expected to make such changes easier"],
          ],
          note: "The pattern is the same as everywhere else in this chapter: a language-specific default encoding is convenient until the day two versions must talk to each other.",
        },
        {
          type: "realworld",
          items: [
            { org: "Apache Kafka", year: "2011", tag: "Log-based broker", html: `<p>Built at LinkedIn and open-sourced in 2011. It retains messages for a configurable period so consumers can replay old events, which means old message formats must stay readable for as long as they are retained.</p>` },
            { org: "Akka", tag: "Actors on the JVM", html: `<p>Akka 2.6 (2019) disabled Java serialization by default in favor of Jackson or Protobuf serializers. In 2022 Lightbend moved Akka to the Business Source License, and the community fork became Apache Pekko.</p>` },
            { org: "Microsoft Orleans", tag: "Virtual actors", html: `<p>The virtual-actor framework that came out of Microsoft Research ran cloud services for the Halo 4 and Halo 5 games.</p>` },
            { org: "Erlang/OTP", tag: "Hot code loading", html: `<p>The runtime can keep two versions of a module (current and old) loaded so running processes can migrate between them; maps arrived in OTP 17 (2014). WhatsApp's backend was famously built on Erlang.</p>` },
            { org: "CloudEvents", year: "2019", tag: "Event envelope", html: `<p>A CNCF specification (1.0 in 2019) that defines common event metadata such as <code>id</code>, <code>source</code>, <code>type</code> and <code>specversion</code>, so producers and consumers can interoperate across brokers.</p>` },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Since the book: safer actor defaults, shared envelopes, registries for streams",
          html: `<p>The actor frameworks the book described have moved toward explicit, evolvable encodings: Akka 2.6 turned off Java serialization by default, and Orleans 7.0 shipped a version-tolerant serializer. Akka's 2022 license change led to the Apache Pekko fork. For events in general, CloudEvents standardizes the envelope (who sent it, what type it is, which spec version) while leaving the payload's encoding to you, and schema registries with transitive compatibility checks have become the usual way to govern payloads on long-retention Kafka topics.</p>`,
        },
        {
          type: "compare",
          title: "Three ways to send data to another process",
          items: [
            { title: "RPC", tone: "warn", html: `<p><strong>Coupling:</strong> caller and callee must both be up, right now, at a known address.<br><strong>Failure:</strong> the caller sees timeouts with unknown outcomes and must retry carefully.<br><strong>Compatibility:</strong> servers deploy first, so requests backward, responses forward.</p>` },
            { title: "Message broker", tone: "ok", html: `<p><strong>Coupling:</strong> decoupled in time and space; the producer knows only a topic name.<br><strong>Failure:</strong> the broker buffers and redelivers, so consumers must cope with duplicates.<br><strong>Compatibility:</strong> both directions, so producers and consumers deploy in any order; retained logs need every historical version.</p>` },
            { title: "Distributed actors", tone: "info", html: `<p><strong>Coupling:</strong> asynchronous messages to an actor that may be local or remote.<br><strong>Failure:</strong> any message may be lost, and code is written for that from the start.<br><strong>Compatibility:</strong> cross-node messages are encoded, so rolling upgrades need compatible encodings.</p>` },
          ],
        },
        {
          type: "callout",
          tone: "interview",
          title: "\"Should this be a synchronous call or a message?\"",
          html: `<p>A strong answer starts with one question: does the caller need the result right now? If not (welcome emails, notifications, analytics, updating other services), a broker absorbs outages and traffic spikes, redelivers after a consumer crash and lets new consumers subscribe without touching the producer. Then it names the price: no immediate answer, at-least-once delivery that consumers must deduplicate, and an event schema that becomes a long-lived public contract (a registry with transitive checks, consumers that preserve unknown fields when they republish). Weak answers put a queue everywhere, or assume the broker makes encoding compatibility someone else's problem.</p>`,
        },
        {
          type: "quiz",
          q: "Why does location transparency (treating remote and local the same) work better in the actor model than in RPC?",
          options: [
            "Actors are faster than RPC calls",
            "The actor model already assumes any message may be lost, even locally, so code is written to cope with it",
            "Actor frameworks always use compact binary encodings",
            "Actors never communicate across machines",
          ],
          answer: 1,
          explain: "RPC tries to make an unreliable network look like a reliable function call, so code written against the illusion breaks when the network misbehaves. Actors start from asynchronous messages that may be lost, so moving an actor to another node doesn't break any assumption the code relied on. Speed (A) is the wrong axis: remote messages are slower than local ones in both models. The encoding (C) is irrelevant to this, and distributed actor frameworks exist precisely to span machines (D).",
        },
      ],
    },
  ],

  takeaways: [
    "Data outlives code: during deploys, rollbacks and for years in storage, old and new versions read each other's bytes, so design for <strong>backward</strong> (new code reads old data) and <strong>forward</strong> (old code reads new data) compatibility from day one.",
    "Built-in language serialization (pickle, Java <code>Serializable</code>) is for transient, trusted, same-language use at most: it locks you into one language, versions poorly and turns untrusted input into remote code execution.",
    "Text formats buy interoperability, not precision: JSON numbers become doubles in many parsers (IDs above 2<sup>53</sup> silently change), binary data needs Base64 (+33%), and without a schema every consumer guesses.",
    "Schemas let the bytes drop field names: Thrift and Protobuf identify fields by tag, Avro by the writer's schema order, which is why the example record shrinks from 81 bytes of JSON to 32&ndash;34.",
    "A tag is a field's identity: add only optional fields with new tags, never reuse or renumber a tag (reserve it instead), and treat <em>required</em> as forever.",
    "Avro resolves the writer's and reader's schemas by name: add or remove only fields with defaults, remember that aliases and new union branches work in one direction only, and make sure every reader can fetch the exact writer's schema.",
    "Each dataflow has its own contract: databases need both directions plus unknown-field preservation on whole-record writes; services upgrade servers first (requests backward, responses forward) and keep old versions alive for clients they can't control; brokers and actors decouple in time but still need compatible encodings.",
    "\"Additive\" is only as safe as the reader: strict decoders reject unknown fields and enum values, so publish tolerance rules, version breaking changes at the edge, and remember that a remote call, unlike a local one, can be lost, time out with an unknown outcome or run twice.",
  ],

  connections: [
    { to: "ch1", html: "Evolvability (Chapter 1) is the goal; this chapter supplies the data-level mechanics, compatible encodings and rolling upgrades, that make frequent change safe." },
    { to: "ch2", html: "Schema-on-read versus schema-on-write (Chapter 2) is the database-side version of schemaless JSON versus schema-driven encodings; document databases store JSON or BSON whose shape depends on when it was written." },
    { to: "ch3", html: "Archival dumps are best written in column-oriented formats such as Parquet (Chapter 3), and storage-engine file formats are encodings that must also stay readable across software versions." },
    { to: "ch5", html: "Replication logs face the same problem: a logical (row-based) log decoupled from the storage engine's internals lets leader and followers run different software versions during a rolling upgrade, while physical WAL shipping usually can't (Chapter 5)." },
    { to: "ch8", html: "The RPC critique (lost messages, timeouts with unknown outcomes, variable latency) is the starting point for Chapter 8's unreliable networks and partial failure; its \"What happened to my request?\" visualization lets you inject those faults yourself." },
    { to: "ch10", html: "Avro container files and Parquet are the standard file formats for batch jobs; self-describing files let generic tools process data written with many schema versions (Chapter 10)." },
    { to: "ch11", html: "Message brokers, log-based brokers like Kafka, change data capture and event sourcing are covered in depth in Chapter 11; retained event logs turn schema compatibility into a long-term commitment." },
    { to: "ch12", html: "Idempotency keys generalize into end-to-end operation IDs for exactly-once effects (Chapter 12), and dataflow between services and stores is the foundation of \"unbundling the database\"." },
  ],

  furtherReading: [
    { title: "Martin Kleppmann, \"Schema evolution in Avro, Protocol Buffers and Thrift\" (2012)", url: "https://martin.kleppmann.com/2012/12/05/schema-evolution-in-avro-protocol-buffers-thrift.html", note: "The blog post the chapter's byte-level comparison grew out of; a quick, concrete read." },
    { title: "Protocol Buffers documentation: Encoding", url: "https://protobuf.dev/programming-guides/encoding/", note: "The official description of keys, wire types, varints and zigzag; pairs with the encoding-bytes visualization." },
    { title: "Protocol Buffers documentation: Language Guide (proto3)", url: "https://protobuf.dev/programming-guides/proto3/", note: "Rules for updating messages, reserved fields and unknown fields, straight from the source." },
    { title: "Apache Avro 1.12 specification, schema resolution section", url: "https://avro.apache.org/docs/1.12.0/specification/", note: "The precise rules for matching writer's and reader's schemas, defaults, aliases and type promotion." },
    { title: "Slee, Agarwal and Kwiatkowski, \"Thrift: Scalable Cross-Language Services Implementation\" (Facebook, 2007)", url: "https://thrift.apache.org/static/files/thrift-20070401.pdf", note: "Why Facebook built Thrift and how its IDL and protocols were designed." },
    { title: "Waldo, Wyant, Wollrath and Kendall, \"A Note on Distributed Computing\" (Sun Microsystems Laboratories, 1994)", note: "The classic argument that remote objects can't be made to look local: latency, memory access, partial failure and concurrency." },
    { title: "Roy Fielding, \"Architectural Styles and the Design of Network-based Software Architectures\", chapter 5 (2000)", url: "https://www.ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm", note: "Where REST was defined, as an architectural style rather than a protocol." },
    { title: "Brandur Leach, \"APIs as infrastructure: future-proofing Stripe with versioning\" (Stripe blog, 2017)", url: "https://stripe.com/blog/api-versioning", note: "How date-pinned API versions and version change modules keep old integrations working while the core evolves; pairs with the api-evolution visualization." },
    { title: "Chris Frohoff and Gabriel Lawrence, \"Marshalling Pickles\" (AppSecCali 2015)", url: "https://frohoff.github.io/appseccali-marshalling-pickles/", note: "The talk that showed how deserializing untrusted objects leads to remote code execution; the page links the slides and video." },
    { title: "Danilo Sato, \"ParallelChange\" (martinfowler.com bliki, 2014)", url: "https://martinfowler.com/bliki/ParallelChange.html", note: "The expand, migrate, contract pattern for making breaking changes in compatible steps." },
    { title: "Confluent documentation: Schema Evolution and Compatibility", url: "https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html", note: "Exact semantics of BACKWARD, FORWARD, FULL and the transitive modes, and the upgrade order each implies." },
  ],
});
