// Chapter 4 deep dive, part 1 (hook + why encoding matters, language-specific formats,
// JSON/XML/CSV and binary JSON, Thrift and Protocol Buffers, evolving tag-based schemas).
// Part 2 (Avro, the merits of schemas, and the three dataflow modes) lives in ch4.deep2.js.
// Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch4", {
  hook: `<p>Here is a scenario (made up, but every piece of it happens somewhere every day). A social app is halfway through a rolling deploy: 3 of its 12 servers already run v2, which adds an optional <code>photoUrl</code> field to the user profile. Profiles are stored as one JSON document per user. Maya uploads a profile photo; a v2 server writes <code>photoUrl</code> into her document. Ten seconds later she fixes a typo in her bio, and that request lands on a v1 server. It decodes the document into its <code>User</code> class, which has no <code>photoUrl</code> property, changes the bio and writes the whole object back. <strong>Her photo is gone.</strong> No error, no crash, no schema change, nothing in the logs.</p>
<p>That mixed-version state is not an accident of one bad deploy. It is every deploy at every company: servers run two versions for minutes, phones run last year's app for months, and records written five years ago are still in the store. When the versions disagree about what the bytes mean, the damage can be enormous. On 1 August 2012, Knight Capital deployed new trading code to seven of its eight servers; the eighth gave a repurposed flag its old meaning, woke up long-retired code, and the firm lost <strong>more than $440 million in about 45 minutes</strong>.</p>
<p>This chapter's question: <strong>how do you encode data so that old and new code can keep reading, and not destroying, each other's bytes?</strong> First come the formats, from one-line built-in serialization through JSON to schema-driven binary encodings, then the three paths data takes between versions: databases, service calls and messages. In the <a href="#/ch4/learn/dataflow-databases">rolling-upgrade visualization</a> you can recreate Maya's lost photo, then fix it.</p>`,
  sections: [
    // ------------------------------------------------------------------ 1
    {
      id: "why-encoding",
      title: "Data outlives the code that wrote it",
      kicker: "Motivation",
      concepts: ["encoding-serialization", "rolling-upgrade", "backward-compatibility", "forward-compatibility"],
      blocks: [
        {
          type: "problem",
          html: `<p>Version 2 of your app adds a field. The obvious plan: stop every server, rewrite every stored record into the new shape, then start v2 everywhere at once. Each part of that plan fails in practice.</p>
<ul>
<li><strong>Stopping the world</strong> means downtime, which most services can't afford. So servers are upgraded a few at a time, and v1 and v2 run side by side for minutes or hours.</li>
<li><strong>Upgrading every client</strong> is impossible. Mobile and desktop apps update when their users get around to it (some never), and partners' integrations update on their owners' schedule. Last year's app keeps calling today's API.</li>
<li><strong>Migrating all data first</strong> means rewriting terabytes for every new field, slowly and riskily, while new writes keep arriving in both shapes during the migration. So records written years ago stay in their old shape.</li>
</ul>
<p>Mixed versions are not an edge case of deploys; they are the normal state of a running system. If v1 crashes on bytes written by v2, or quietly drops the field it doesn't understand, every deploy (and every rollback) is a gamble.</p>`,
        },
        {
          type: "idea",
          html: `<p>Treat every encoded byte as a <strong>message between different versions of your code</strong>, and pick encodings that keep both directions working: new code reading old data (<strong>backward compatibility</strong>) and old code reading new data (<strong>forward compatibility</strong>).</p>`,
        },
        {
          type: "text",
          html: `<h3>Two representations of the same data</h3>
<p>Inside a running program, data lives in objects, structs, lists, arrays, hash maps and trees. These structures are built for fast CPU access: a <code>User</code> object holds a pointer to its name string and another to a list, which holds pointers to more strings. A pointer is a memory address, and an address means nothing to another process, another machine, or tomorrow's run of the same program.</p>
<p>So whenever data leaves a process, it has to become a <strong>self-contained sequence of bytes</strong> (JSON text, a Protobuf message) from which another program can rebuild its own in-memory structures. Turning memory into bytes is <strong>encoding</strong>, also called serialization or marshalling. The reverse is <strong>decoding</strong>: parsing, deserialization, unmarshalling.</p>
<p>One name clash to defuse early: this kind of "serialization" has nothing to do with <em>serializable isolation</em>, the strongest transaction isolation level (Chapter 7). To avoid the overload, this chapter mostly says encoding.</p>`,
        },
        {
          type: "diagram",
          title: "In memory vs as bytes",
          svg: `<style>.dd-diagram-body svg.c4d-mem-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c4d-mem-w{display:none}.dd-diagram-body svg.c4d-mem-n{display:block}}</style><svg class="c4d-mem-w" viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left: a User object in memory pointing to a name string and to a list, which points to two more strings. Middle: encode turns it into bytes, decode turns bytes back into objects. Right: a strip of hex bytes that can go into a file, a socket, a queue or a cache.">
  <defs>
    <marker id="c4d-mem-w-c2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c2)"/></marker>
    <marker id="c4d-mem-w-ink" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ink)"/></marker>
  </defs>
  <rect x="8" y="8" width="272" height="204" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="144" y="30" font-size="13" font-weight="700" text-anchor="middle">In memory</text>
  <rect x="18" y="44" width="144" height="86" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="90" y="61" font-size="12" font-weight="700" text-anchor="middle">User</text>
  <text x="28" y="81" font-size="12">userName</text>
  <text x="28" y="99" font-size="12">favoriteNumber 1337</text>
  <text x="28" y="117" font-size="12">interests</text>
  <circle cx="152" cy="77" r="3.5" style="fill: var(--viz-c2)"/>
  <circle cx="152" cy="113" r="3.5" style="fill: var(--viz-c2)"/>
  <rect x="186" y="44" width="84" height="26" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="228" y="61" font-size="12" text-anchor="middle">"Martin"</text>
  <rect x="186" y="98" width="84" height="26" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="228" y="115" font-size="12" text-anchor="middle">list of 2</text>
  <rect x="64" y="154" width="104" height="26" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="116" y="171" font-size="12" text-anchor="middle">"daydreaming"</text>
  <rect x="188" y="154" width="80" height="26" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="228" y="171" font-size="12" text-anchor="middle">"hacking"</text>
  <path d="M152,77 L183,60" fill="none" stroke-width="1.6" marker-end="url(#c4d-mem-w-c2)" style="stroke: var(--viz-c2)"/>
  <path d="M152,113 L183,111" fill="none" stroke-width="1.6" marker-end="url(#c4d-mem-w-c2)" style="stroke: var(--viz-c2)"/>
  <path d="M212,124 L148,151" fill="none" stroke-width="1.6" marker-end="url(#c4d-mem-w-c2)" style="stroke: var(--viz-c2)"/>
  <path d="M234,124 L229,151" fill="none" stroke-width="1.6" marker-end="url(#c4d-mem-w-c2)" style="stroke: var(--viz-c2)"/>
  <text x="144" y="202" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">pointers: only valid inside this process</text>
  <line x1="288" y1="96" x2="362" y2="96" stroke-width="2" marker-end="url(#c4d-mem-w-ink)" style="stroke: var(--viz-ink)"/>
  <text x="326" y="86" font-size="12" font-weight="700" text-anchor="middle">encode</text>
  <text x="326" y="112" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">(serialize)</text>
  <line x1="364" y1="140" x2="290" y2="140" stroke-width="2" marker-end="url(#c4d-mem-w-ink)" style="stroke: var(--viz-ink)"/>
  <text x="326" y="158" font-size="12" font-weight="700" text-anchor="middle">decode</text>
  <text x="326" y="174" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">(parse)</text>
  <rect x="372" y="8" width="260" height="204" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="502" y="30" font-size="13" font-weight="700" text-anchor="middle">On disk or on the wire</text>
  <g style="fill: var(--viz-node); stroke: var(--viz-node-stroke)">
    <rect x="414" y="46" width="26" height="26" rx="4"/><rect x="444" y="46" width="26" height="26" rx="4"/><rect x="474" y="46" width="26" height="26" rx="4"/><rect x="504" y="46" width="26" height="26" rx="4"/><rect x="534" y="46" width="26" height="26" rx="4"/><rect x="564" y="46" width="26" height="26" rx="4"/><rect x="594" y="46" width="26" height="26" rx="4"/>
    <rect x="414" y="80" width="26" height="26" rx="4"/><rect x="444" y="80" width="26" height="26" rx="4"/><rect x="504" y="80" width="26" height="26" rx="4"/><rect x="534" y="80" width="26" height="26" rx="4"/><rect x="564" y="80" width="26" height="26" rx="4"/><rect x="594" y="80" width="26" height="26" rx="4"/>
  </g>
  <g style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)">
    <rect x="384" y="46" width="26" height="26" rx="4"/><rect x="384" y="80" width="26" height="26" rx="4"/><rect x="474" y="80" width="26" height="26" rx="4"/>
  </g>
  <g font-size="12" font-family="ui-monospace, Menlo, monospace" text-anchor="middle">
    <text x="397" y="63">0a</text><text x="427" y="63">06</text><text x="457" y="63">4d</text><text x="487" y="63">61</text><text x="517" y="63">72</text><text x="547" y="63">74</text><text x="577" y="63">69</text><text x="607" y="63">6e</text>
    <text x="397" y="97">10</text><text x="427" y="97">b9</text><text x="457" y="97">0a</text><text x="487" y="97">1a</text><text x="517" y="97">0b</text><text x="547" y="97">64</text><text x="577" y="97">61</text><text x="607" y="97">79</text>
  </g>
  <text x="502" y="134" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">… 33 bytes in all (Protocol Buffers)</text>
  <text x="502" y="176" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">self-contained, so it can go into</text>
  <text x="502" y="194" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">a file, a socket, a queue or a cache</text>
</svg><svg class="c4d-mem-n" viewBox="0 0 360 380" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top: a User object in memory pointing to a name string and a list of two strings. Middle: encode and decode arrows. Bottom: the same record as a strip of hex bytes.">
  <defs>
    <marker id="c4d-mem-n-c2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c2)"/></marker>
    <marker id="c4d-mem-n-ink" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ink)"/></marker>
  </defs>
  <rect x="8" y="8" width="344" height="198" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="180" y="30" font-size="13" font-weight="700" text-anchor="middle">In memory</text>
  <rect x="54" y="44" width="144" height="86" rx="6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
  <text x="126" y="61" font-size="12" font-weight="700" text-anchor="middle">User</text>
  <text x="64" y="81" font-size="12">userName</text>
  <text x="64" y="99" font-size="12">favoriteNumber 1337</text>
  <text x="64" y="117" font-size="12">interests</text>
  <circle cx="188" cy="77" r="3.5" style="fill: var(--viz-c2)"/>
  <circle cx="188" cy="113" r="3.5" style="fill: var(--viz-c2)"/>
  <rect x="222" y="44" width="84" height="26" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="264" y="61" font-size="12" text-anchor="middle">"Martin"</text>
  <rect x="222" y="98" width="84" height="26" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="264" y="115" font-size="12" text-anchor="middle">list of 2</text>
  <rect x="100" y="154" width="104" height="26" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="152" y="171" font-size="12" text-anchor="middle">"daydreaming"</text>
  <rect x="224" y="154" width="80" height="26" rx="6" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <text x="264" y="171" font-size="12" text-anchor="middle">"hacking"</text>
  <path d="M188,77 L219,60" fill="none" stroke-width="1.6" marker-end="url(#c4d-mem-n-c2)" style="stroke: var(--viz-c2)"/>
  <path d="M188,113 L219,111" fill="none" stroke-width="1.6" marker-end="url(#c4d-mem-n-c2)" style="stroke: var(--viz-c2)"/>
  <path d="M248,124 L184,151" fill="none" stroke-width="1.6" marker-end="url(#c4d-mem-n-c2)" style="stroke: var(--viz-c2)"/>
  <path d="M270,124 L265,151" fill="none" stroke-width="1.6" marker-end="url(#c4d-mem-n-c2)" style="stroke: var(--viz-c2)"/>
  <text x="180" y="198" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">pointers: only valid inside this process</text>
  <line x1="130" y1="212" x2="130" y2="246" stroke-width="2" marker-end="url(#c4d-mem-n-ink)" style="stroke: var(--viz-ink)"/>
  <text x="120" y="234" font-size="12" font-weight="700" text-anchor="end">encode</text>
  <line x1="230" y1="246" x2="230" y2="212" stroke-width="2" marker-end="url(#c4d-mem-n-ink)" style="stroke: var(--viz-ink)"/>
  <text x="240" y="234" font-size="12" font-weight="700">decode</text>
  <rect x="8" y="252" width="344" height="120" rx="10" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
  <text x="180" y="274" font-size="13" font-weight="700" text-anchor="middle">On disk or on the wire</text>
  <g style="fill: var(--viz-node); stroke: var(--viz-node-stroke)">
    <rect x="63" y="286" width="36" height="26" rx="4"/><rect x="102" y="286" width="36" height="26" rx="4"/><rect x="141" y="286" width="36" height="26" rx="4"/><rect x="180" y="286" width="36" height="26" rx="4"/><rect x="219" y="286" width="36" height="26" rx="4"/><rect x="258" y="286" width="36" height="26" rx="4"/><rect x="297" y="286" width="36" height="26" rx="4"/>
    <rect x="63" y="318" width="36" height="26" rx="4"/><rect x="102" y="318" width="36" height="26" rx="4"/><rect x="180" y="318" width="36" height="26" rx="4"/><rect x="219" y="318" width="36" height="26" rx="4"/><rect x="258" y="318" width="36" height="26" rx="4"/><rect x="297" y="318" width="36" height="26" rx="4"/>
  </g>
  <g style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)">
    <rect x="24" y="286" width="36" height="26" rx="4"/><rect x="24" y="318" width="36" height="26" rx="4"/><rect x="141" y="318" width="36" height="26" rx="4"/>
  </g>
  <g font-size="12" font-family="ui-monospace, Menlo, monospace" text-anchor="middle">
    <text x="42" y="303">0a</text><text x="81" y="303">06</text><text x="120" y="303">4d</text><text x="159" y="303">61</text><text x="198" y="303">72</text><text x="237" y="303">74</text><text x="276" y="303">69</text><text x="315" y="303">6e</text>
    <text x="42" y="335">10</text><text x="81" y="335">b9</text><text x="120" y="335">0a</text><text x="159" y="335">1a</text><text x="198" y="335">0b</text><text x="237" y="335">64</text><text x="276" y="335">61</text><text x="315" y="335">79</text>
  </g>
  <text x="180" y="362" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">… 33 bytes, ready for a file, socket or queue</text>
</svg>`,
          caption: `The same record twice. The object graph on the left only makes sense inside one process's memory; the bytes on the right (the first 16 of its Protocol Buffers encoding; violet bytes carry the field tags) mean the same thing to any program that knows the format.`,
        },
        {
          type: "text",
          html: `<h3>Every process boundary is an encoding boundary</h3>
<p>You encode when you write a file or a database row, send a request over the network, put a message on a queue or store a value in a cache. Each of those byte sequences may later be read by a different program, or by a different <em>version</em> of the same program, and that second case is what this chapter is about.</p>
<p>Chapter 1 argued that systems must be <strong>evolvable</strong>: features change, so the shape of the data changes with them. A relational database enforces one schema at a time, yet after <code>ALTER TABLE ... ADD COLUMN</code> every row written before it is still there. A schema-on-read document store (<a href="#/ch2/learn/schema-flexibility">Chapter 2</a>) holds a mixture of every shape your code has ever written. And a code change never lands everywhere at the same instant:</p>
<ul>
<li><strong>Servers</strong> get a <strong>rolling upgrade</strong> (a staged rollout): deploy the new version to a few nodes, check they are healthy, then continue. There is no downtime, small and frequent releases become cheap, and a bad release is caught while it runs on a few machines and rolled back. The price: old and new versions run side by side, sharing the same data.</li>
<li><strong>Clients</strong> are at the mercy of their users. An installed app may go months or years without an update, so your API keeps serving every client version still in the wild.</li>
<li><strong>Stored data</strong> outlives them all. A record written five years ago is read by code deployed this morning.</li>
</ul>`,
        },
        {
          type: "analogy",
          html: `<p>Writing to a database is leaving a letter for your future self, and the future self who opens it may have learned new words in the meantime. A deploy is a period when two generations share one mailbox: v1 and v2 each read letters the other wrote, and each must be able to put back a letter it only half understood without tearing out the pages it couldn't read.</p>`,
        },
        {
          type: "diagram",
          title: "The compatibility matrix",
          svg: `<svg viewBox="0 0 360 258" xmlns="http://www.w3.org/2000/svg" style="max-width: 440px; margin: 0 auto" role="img" aria-label="A two by two grid. Old code reading old data and new code reading new data are trivial. New code reading old data is backward compatibility. Old code reading new data is forward compatibility, which means ignoring and keeping what it does not know.">
  <text x="152" y="22" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">Data written by</text>
  <text x="152" y="38" font-size="13" font-weight="700" text-anchor="middle">old code</text>
  <text x="287" y="22" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">Data written by</text>
  <text x="287" y="38" font-size="13" font-weight="700" text-anchor="middle">new code</text>
  <text x="46" y="88" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">Read by</text>
  <text x="46" y="104" font-size="13" font-weight="700" text-anchor="middle">old code</text>
  <text x="46" y="178" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">Read by</text>
  <text x="46" y="194" font-size="13" font-weight="700" text-anchor="middle">new code</text>
  <rect x="88" y="50" width="128" height="84" rx="8" style="fill: var(--viz-node); stroke: var(--viz-line)"/>
  <text x="152" y="96" font-size="13" text-anchor="middle" style="fill: var(--viz-muted)">trivial</text>
  <rect x="222" y="50" width="130" height="84" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
  <text x="287" y="78" font-size="13" font-weight="700" text-anchor="middle">FORWARD</text>
  <text x="287" y="98" font-size="12" text-anchor="middle">ignore, and keep,</text>
  <text x="287" y="114" font-size="12" text-anchor="middle">what it doesn't know</text>
  <rect x="88" y="140" width="128" height="84" rx="8" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <text x="152" y="168" font-size="13" font-weight="700" text-anchor="middle">BACKWARD</text>
  <text x="152" y="188" font-size="12" text-anchor="middle">new code knows</text>
  <text x="152" y="204" font-size="12" text-anchor="middle">the old format</text>
  <rect x="222" y="140" width="130" height="84" rx="8" style="fill: var(--viz-node); stroke: var(--viz-line)"/>
  <text x="287" y="186" font-size="13" text-anchor="middle" style="fill: var(--viz-muted)">trivial</text>
  <text x="180" y="248" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">rolling deploys and rollbacks need both</text>
</svg>`,
          caption: `Only the two off-diagonal cells are interesting. Backward compatibility is the one developers remember; forward compatibility is the one that bites during deploys and rollbacks.`,
        },
        {
          type: "text",
          html: `<h3>Backward and forward, precisely</h3>
<p><strong>Backward compatibility</strong>: newer code can read data written by older code. <strong>Forward compatibility</strong>: older code can read data written by newer code. A way to remember it: with backward, the new code looks <em>back</em> at old data; with forward, the old code copes with data from its future.</p>
<p>Backward compatibility is usually the easy one. Whoever writes v2 knows exactly what v1 wrote and can handle it explicitly ("no <code>photoUrl</code>? show the default avatar"). Forward compatibility is harder because v1 was written before v2 existed. It can't anticipate what will be added, so all it can do is follow a general rule: <strong>ignore what you don't recognize</strong>, and ideally <strong>keep it</strong>, so the unknown data survives if v1 writes the record back. Maya's photo was lost because v1 ignored the field without keeping it.</p>
<p>Rollbacks make forward compatibility unavoidable. Rolling back code never rolls back data: whatever v2 wrote before you reverted is still in the database, the caches and the queues, and now only v1 is left to read it. Even a team that "only ever moves forward" needs old code to survive new data.</p>
<h3>How to judge a format</h3>
<p>The chapter has two halves. First the formats: language-specific serialization, textual formats such as JSON, and the schema-driven binary formats Thrift, Protocol Buffers and Avro. Then the three ways data flows between versions (through databases, through service calls, through asynchronous messages), each with its own compatibility contract. Ask six questions of every format: does it support both compatibility directions, can every language you use read it, how big is it, how fast does it encode and decode, can a human read it, and is it safe to decode bytes from someone you don't trust?</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Kubernetes",
              tag: "rolling by default",
              html: `A Deployment's default update strategy is <code>RollingUpdate</code> with <code>maxSurge</code> and <code>maxUnavailable</code> both at 25%. During every routine deploy, old and new pods serve traffic at the same time and read and write the same data.`,
            },
            {
              org: "MySQL",
              tag: "an encoding that outlived its era",
              html: `The <code>TIMESTAMP</code> column type stores seconds since the Unix epoch in 32 bits, so its range ends at <strong>2038-01-19 03:14:07 UTC</strong>. A storage decision made decades ago still limits rows written today: the "year 2038 problem".`,
            },
            {
              org: "Y2K",
              year: "1990s",
              tag: "data outlives code",
              html: `Two-digit years saved scarce bytes in the 1960s to 80s, on the assumption that the programs would be retired long before 2000. The code and its data outlived that assumption, and fixing them took a worldwide remediation effort in the late 1990s.`,
            },
            {
              org: "Google Play",
              tag: "clients you can't upgrade",
              html: `An Android app can't make its users upgrade on its own. Play's in-app updates API offers an "immediate" flow that blocks the app until the user updates, but only apps that build it in get that, and users can switch auto-updates off. Backends keep serving old app versions for a long time.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Since the book was written (2017), the deployment pipeline has made mixed versions permanent. Teams practicing continuous deployment ship many times a day, canary releases route a small slice of traffic to a new version for hours before the rest follows, feature flags switch code paths per user, and Kubernetes rolls pods gradually by default. At any moment part of a fleet runs a different version from the rest, so compatibility is a property you maintain all the time, not a box you tick at release time.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Whenever a design changes a data format (a new field, a renamed column, a new event type), interviewers listen for one question: <em>which versions coexist, and in which direction does the data flow?</em> A strong answer names the writers and the readers, estimates how long versions overlap (minutes for a deploy, months for mobile clients, years for stored data), says which direction each pair needs (backward, forward or both), and explains what happens on rollback. "We'll migrate everything and deploy at once" is the red flag.</p>`,
        },
        {
          type: "quiz",
          q: "A rolling deploy of v2 (which adds a field) is halfway done when you notice a bug and roll every server back to v1. Records written by v2 servers are still in the database. Which property lets v1 read them safely?",
          options: [
            "Backward compatibility, because v1 is the older version",
            "Forward compatibility: older code is reading data written by newer code",
            "Neither: rolling back the deploy also restores the database to its pre-deploy state",
            "Both, because v1 and v2 were reading the same records at the same time",
          ],
          answer: 1,
          explain: `Old code reading newer data is forward compatibility. Option A is the tempting one, but it gets the direction backwards: backward compatibility means new code reading old data, and it is v1 that is doing the reading here. Option C is wrong because rolling back code never rolls back data, which is exactly why forward compatibility matters even if you only ever plan to move forward.`,
        },
      ],
    },
    // ------------------------------------------------------------------ 2
    {
      id: "language-specific-formats",
      title: "Built-in serialization: one line of code, years of regret",
      kicker: "Formats",
      concepts: ["language-specific-encoding"],
      blocks: [
        {
          type: "problem",
          html: `<p>Every mainstream language ships a one-liner that turns any object graph into bytes: Java's <code>java.io.Serializable</code>, Python's <code>pickle</code>, Ruby's <code>Marshal</code>, plus third-party libraries such as Kryo for Java. There's no schema to write, no mapping code, and arbitrary classes just work.</p>
<p>But the bytes encode <em>your language's</em> class names and object internals. Another language can't read them. Renaming or moving a class can make old data unreadable. Worst of all, the decoder must be willing to instantiate whatever classes the bytes name, so whoever controls the bytes can often pick classes whose decoding hooks end up running commands on your server.</p>`,
        },
        {
          type: "idea",
          html: `<p>A decoder that can rebuild <em>any</em> object can be tricked into building a <strong>dangerous</strong> one. For anything that leaves the process or outlives it, use a language-neutral format that encodes <strong>data only</strong>.</p>`,
        },
        {
          type: "text",
          html: `<p>Built-in serialization exists because it is genuinely convenient. Java's <code>ObjectOutputStream.writeObject()</code> walks an object graph, writes each object's class description and field values, and records shared references, so cycles and repeated objects come back intact. <code>ObjectInputStream.readObject()</code> reverses the process. Python's <code>pickle.dumps</code> / <code>pickle.loads</code> and Ruby's <code>Marshal.dump</code> / <code>Marshal.load</code> work the same way. You get persistence or caching in one line, without designing a format.</p>
<p>The catch is in how objects get rebuilt. The byte stream doesn't only hold values; it holds <strong>instructions</strong>: which class to instantiate, which function to call, with which arguments. Python makes this unusually easy to see:</p>`,
        },
        {
          type: "code",
          lang: "python",
          title: "Unpickling calls functions chosen by the data",
          code: `import pickle

class Innocent:
    def __reduce__(self):
        # Tells pickle how to rebuild this object:
        # "call print() with these arguments".
        return (print, ("this ran during unpickling",))

data = pickle.dumps(Innocent())
print(data)
# b'\\x80\\x05\\x957\\x00...\\x8c\\x08builtins\\x94\\x8c\\x05print\\x94...'
# The bytes name builtins.print; the class Innocent isn't in them.

obj = pickle.loads(data)   # prints: this ran during unpickling
print(obj)                 # None, i.e. whatever print() returned`,
          caption: `The receiving process doesn't need the <code>Innocent</code> class at all: the bytes simply say "import <code>builtins.print</code> and call it with this string". An attacker writes bytes that name a more dangerous function instead. This example is deliberately harmless.`,
        },
        {
          type: "text",
          html: `<h3>Four problems, from annoying to dangerous</h3>
<p><strong>1. Language lock-in.</strong> The encoding is tied to one language, often to one library version. A Go service can't read a pickled Python object, and data that lives for years commits every future reader to that language. Integrating with another team's stack, or another company's, turns into a rewrite.</p>
<p><strong>2. Versioning as an afterthought.</strong> These formats were designed to make encoding easy, not evolution. Java writes a <code>serialVersionUID</code> into the stream; if a class doesn't declare one, the JVM derives it from the class's structure, so an innocent edit like adding a field changes it, and old data then fails with <code>InvalidClassException</code>. Streams also record fully qualified class names, so renaming or moving a class (in Python, moving it to another module) strands every object stored under the old name.</p>
<p><strong>3. Efficiency.</strong> Java's built-in serialization is notorious for slow encoding and bloated output, partly because each stream carries class descriptors (class names, field names and types) alongside the data.</p>
<p><strong>4. Security.</strong> To restore objects, the decoder instantiates the classes the stream names and runs their deserialization hooks: in Java, <code>readObject()</code> and <code>readResolve()</code>, and indirectly methods such as <code>hashCode()</code> when a <code>HashMap</code> rebuilds its table; in Python, whatever callable <code>__reduce__</code> named. The attacker doesn't need a bug in your code. They only need ordinary classes on your classpath whose hooks call methods on fields the attacker filled in. Each such class is a <strong>gadget</strong>; wired together by attacker-chosen data, they form a <strong>gadget chain</strong> that ends in something like <code>Runtime.exec()</code>. Every link is legitimate library code.</p>
<p>That's why checking the type after decoding (<code>instanceof OrderRequest</code>, <code>isinstance</code>) doesn't help. The damage happens <em>inside</em> <code>readObject()</code>, before your code ever sees the result.</p>`,
        },
        {
          type: "diagram",
          title: "A deserialization gadget chain",
          svg: `<style>.dd-diagram-body svg.c4d-gad-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c4d-gad-w{display:none}.dd-diagram-body svg.c4d-gad-n{display:block}}</style><svg class="c4d-gad-w" viewBox="0 0 640 172" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Five steps: attacker-chosen bytes arrive; readObject starts decoding; it instantiates the classes the bytes name; their hooks such as readObject and hashCode run; a library gadget calls Runtime.exec. A bracket under all five says your instanceof check runs only after all of this.">
  <defs>
    <marker id="c4d-gad-w-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <rect x="8" y="28" width="108" height="72" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
  <rect x="137" y="28" width="108" height="72" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="266" y="28" width="108" height="72" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="395" y="28" width="108" height="72" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="524" y="28" width="108" height="72" rx="8" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
  <g font-size="12" text-anchor="middle">
    <text x="62" y="58">bytes arrive,</text><text x="62" y="74">attacker-chosen</text>
    <text x="191" y="58" font-family="ui-monospace, Menlo, monospace">readObject()</text><text x="191" y="74">starts decoding</text>
    <text x="320" y="50">instantiates</text><text x="320" y="66">the classes</text><text x="320" y="82">the bytes name</text>
    <text x="449" y="50">their hooks run:</text><text x="449" y="66">readObject(),</text><text x="449" y="82">hashCode()…</text>
    <text x="578" y="50">a library gadget</text><text x="578" y="66">calls</text><text x="578" y="82" font-weight="700" style="fill: var(--viz-bad)">Runtime.exec()</text>
  </g>
  <g fill="none" stroke-width="1.6" style="stroke: var(--viz-muted)">
    <line x1="118" y1="64" x2="134" y2="64" marker-end="url(#c4d-gad-w-a)"/>
    <line x1="247" y1="64" x2="263" y2="64" marker-end="url(#c4d-gad-w-a)"/>
    <line x1="376" y1="64" x2="392" y2="64" marker-end="url(#c4d-gad-w-a)"/>
    <line x1="505" y1="64" x2="521" y2="64" marker-end="url(#c4d-gad-w-a)"/>
  </g>
  <path d="M8,110 L8,120 L632,120 L632,110" fill="none" stroke-width="1.5" stroke-dasharray="5 4" style="stroke: var(--viz-muted)"/>
  <text x="320" y="142" font-size="12" font-weight="700" text-anchor="middle">your instanceof OrderRequest check runs only after all of this</text>
  <text x="320" y="162" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">no bug in your own code is needed: every link is ordinary library code</text>
</svg><svg class="c4d-gad-n" viewBox="0 0 360 328" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Six stacked steps: attacker-chosen bytes arrive; readObject starts decoding; it instantiates the classes the bytes name; their hooks run; a library gadget calls Runtime.exec; only then does your instanceof check run.">
  <defs>
    <marker id="c4d-gad-n-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker>
  </defs>
  <rect x="30" y="12" width="300" height="34" rx="8" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/>
  <rect x="30" y="62" width="300" height="34" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="30" y="112" width="300" height="34" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="30" y="162" width="300" height="34" rx="8" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
  <rect x="30" y="212" width="300" height="34" rx="8" stroke-width="2" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
  <rect x="30" y="262" width="300" height="34" rx="8" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-muted)"/>
  <g font-size="12" text-anchor="middle">
    <text x="180" y="34">bytes arrive, attacker-chosen</text>
    <text x="180" y="84">readObject() starts decoding</text>
    <text x="180" y="134">instantiates the classes the bytes name</text>
    <text x="180" y="184">their hooks run: readObject(), hashCode()…</text>
    <text x="180" y="234">a library gadget calls <tspan font-weight="700" style="fill: var(--viz-bad)">Runtime.exec()</tspan></text>
    <text x="180" y="284" style="fill: var(--viz-muted)">only now: your instanceof check</text>
  </g>
  <g fill="none" stroke-width="1.6" style="stroke: var(--viz-muted)">
    <line x1="180" y1="47" x2="180" y2="59" marker-end="url(#c4d-gad-n-a)"/>
    <line x1="180" y1="97" x2="180" y2="109" marker-end="url(#c4d-gad-n-a)"/>
    <line x1="180" y1="147" x2="180" y2="159" marker-end="url(#c4d-gad-n-a)"/>
    <line x1="180" y1="197" x2="180" y2="209" marker-end="url(#c4d-gad-n-a)"/>
    <line x1="180" y1="247" x2="180" y2="259" marker-end="url(#c4d-gad-n-a)"/>
  </g>
  <text x="180" y="318" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">no bug in your own code is needed</text>
</svg>`,
          caption: `The attacker supplies only data. The code that runs is already on your classpath: collections, logging and utility libraries whose hooks happen to call each other in a useful order.`,
        },
        {
          type: "text",
          html: `<h3>If you're stuck with it</h3>
<p>The book's verdict is blunt: keep built-in serialization to short-lived data, if you use it at all. If legacy code forces it on you, contain it:</p>
<ul>
<li><strong>Never decode untrusted input</strong>, which includes anything a user could have touched: cookies, request bodies, cache entries, uploaded files.</li>
<li><strong>Allow-list classes.</strong> Java's serialization filters (JEP 290, in JDK 9 and backported to JDK 8 updates; context-specific filters in JEP 415, JDK 17) reject any class that isn't on your list <em>before</em> it is instantiated. Python's documentation shows how to restrict the globals an <code>Unpickler</code> may load.</li>
<li><strong>Authenticate the bytes</strong> with a signature or MAC, so only your own services can produce a payload you will decode.</li>
</ul>
<p>The real fix is to migrate to a format that encodes data, not behavior: JSON, Protocol Buffers, Avro. Those are the subject of the rest of this chapter.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Frohoff &amp; Lawrence",
              year: "2015",
              tag: "gadget chains",
              html: `Their AppSecCali talk "Marshalling Pickles" (January 2015) and the <strong>ysoserial</strong> tool showed that deserializing untrusted Java data leads to remote code execution, using gadget chains assembled from common libraries such as Apache Commons Collections.`,
            },
            {
              org: "FoxGlove Security",
              year: "2015",
              tag: "working exploits",
              html: `In November 2015 FoxGlove published working remote-code-execution exploits for WebLogic, WebSphere, JBoss, Jenkins and OpenNMS, all through Java deserialization and the Commons Collections chain. A wave of emergency patches followed.`,
            },
            {
              org: "Ruby on Rails",
              year: "2013",
              tag: "CVE-2013-0156",
              html: `Rails' XML parameter parsing could be made to decode embedded YAML and Symbol types, which gave remote code execution against default Rails applications and sent the whole ecosystem scrambling to patch.`,
            },
            {
              org: "Python documentation",
              tag: "official warning",
              html: `The <code>pickle</code> module's documentation opens with a warning box: "The pickle module is not secure. Only unpickle data you trust."`,
            },
            {
              org: "Oracle / OpenJDK",
              tag: "filters, not removal",
              html: `JEP 290 added filtering of incoming serialization data in JDK 9 and was backported to JDK 8 updates. In 2018 Mark Reinhold, chief architect of Oracle's Java Platform Group, was widely reported calling serialization a "horrible mistake" made in 1997. It was never removed from the JDK; filters remain the supported mitigation.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>The same problem came back with machine learning. PyTorch checkpoints written by <code>torch.save</code> are pickle-based, so loading a model downloaded from the internet could run code chosen by whoever published it. Hugging Face created <strong>safetensors</strong> (2022), a data-only format that stores tensor shapes, types and raw bytes and nothing executable, and PyTorch 2.6 (2025) changed <code>torch.load</code> to default to <code>weights_only=True</code>, which refuses to rebuild arbitrary objects.</p>`,
        },
        {
          type: "tradeoffs",
          prosLabel: "Why it's tempting",
          consLabel: "What it costs",
          pros: [
            "One line of code: no schema, no mapping layer, no format to design.",
            "Restores arbitrary object graphs, including cycles and shared references.",
            "Tolerable for short-lived data that never leaves one trusted process running one version of the code.",
          ],
          cons: [
            "Locked to one language, and often to one library version.",
            "Decoding untrusted bytes can mean remote code execution, with no bug in your own code.",
            "Brittle versioning: a changed <code>serialVersionUID</code> or a renamed or moved class strands old data.",
            "Slow and bloated: Java embeds class descriptors in every stream.",
          ],
        },
        {
          type: "callout",
          tone: "mistake",
          title: "\"It's only used internally\"",
          html: `<p>"We only use it between our own services" is the usual defense, and it rarely holds. A pickled object in a shared cache means anyone who can write one cache key can run code on every reader. A Java object on an internal queue turns the queue into an attack path. Exposed RMI and JMX ports have been deserialization targets for years, and the 2015 Jenkins exploit went through Jenkins' own CLI port, not a public web form. Assume every decoder is eventually reachable by an attacker, and feed it data-only formats.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"<em>Why not just use Java serialization or pickle between our services?</em>" A strong answer leads with security: decoding instantiates whatever classes the bytes name and runs their hooks, so whoever controls the bytes can chain ordinary library classes into code execution, before any type check runs. Then lock-in (one language, often one library version) and brittle versioning (<code>serialVersionUID</code>, renamed classes). The fix is a data-only, language-neutral format; for legacy code, allow-list filters such as JEP 290 and authenticated payloads. Weak answers stop at "it's slow" or "we validate the object afterwards".</p>`,
        },
        {
          type: "quiz",
          q: "A service decodes requests with Java's ObjectInputStream and immediately rejects any object that isn't an OrderRequest. How can an attacker still run code on the server?",
          options: [
            "Decoding already instantiated attacker-chosen classes and ran their deserialization hooks before the type check ran",
            "Java serialization isn't encrypted, so attackers can read the requests in transit",
            "The attacker names a malicious class OrderRequest so that it passes the type check",
            "ObjectInputStream has a buffer overflow in its length fields",
          ],
          answer: 0,
          explain: `The dangerous work happens inside <code>readObject()</code>: the stream names classes, the JVM instantiates them and runs their hooks, and gadget chains in ordinary libraries turn that into command execution. Option C is the tempting one, but no disguise is needed: by the time the type check runs, the payload has already executed. Encryption (B) protects confidentiality, not what the decoder does with the bytes it receives, and the attack needs no memory-safety bug (D).`,
        },
      ],
    },
    // ------------------------------------------------------------------ 3
    {
      id: "textual-formats",
      title: "JSON, XML and CSV: universal, readable and subtly lossy",
      kicker: "Formats",
      concepts: ["json-xml-csv", "binary-json-variants"],
      blocks: [
        {
          type: "problem",
          html: `<p>To escape language lock-in, teams standardize on text formats that every language can parse and every human can read: JSON, XML, CSV. But these formats are vague about what the text <em>means</em>. XML and CSV can't tell the number <code>1337</code> from the string <code>"1337"</code> without an external schema. JSON separates strings from numbers, but it has a single number type, which JavaScript (and many other parsers) decodes as a 64-bit floating-point double, so integers above 2<sup>53</sup> silently change value.</p>
<p>Raw bytes have to travel as text, usually Base64, inflated by a third. And schemas are optional and usually skipped, so every consumer hard-codes its own guess about what each field holds.</p>`,
        },
        {
          type: "idea",
          html: `<p>Text formats buy <strong>interoperability and readability</strong>, not precision or compactness. Use them where "anyone can read it" matters most, and design around their three traps: <strong>big integers, binary data and missing schemas</strong>.</p>`,
        },
        {
          type: "text",
          html: `<h3>Why text won</h3>
<p>JSON is built into every web browser and is simple enough to describe on an index card: objects, arrays, strings, numbers, booleans and null. XML is verbose and more complicated than it needs to be, but it was entrenched first, in SOAP services, office documents and enterprise integration. CSV is the lowest common denominator that every spreadsheet and database can import. All three are human-readable, so you can debug with <code>curl</code> and a text editor, and every language has parsers for them. In a lot of places those properties matter more than efficiency.</p>
<h3>What does this number mean?</h3>
<p>In XML and CSV, <code>1337</code> is just a run of digits; whether it's a number, a zip code or an ID depends on a schema that may not exist. JSON does better and distinguishes strings from numbers, but it has only one number type: no split between integers and floating point, and no specified precision. RFC 8259 leaves precision to implementations and warns that you can only count on interoperability within what IEEE 754 doubles can represent.</p>
<p>That becomes a bug as soon as a number is bigger than a double can hold exactly. A double has a 53-bit significand, so every integer up to 2<sup>53</sup> = 9,007,199,254,740,992 has its own exact representation; JavaScript names the largest safe one <code>Number.MAX_SAFE_INTEGER</code> (2<sup>53</sup> − 1). Above that, the spacing between neighboring doubles doubles at every power of two: 2 just above 2<sup>53</sup>, and 128 around 10<sup>18</sup>, where 19-digit IDs live. An integer that falls between two doubles rounds to the nearest one, silently:</p>`,
        },
        {
          type: "code",
          lang: "js",
          title: "Three ways JSON.parse changes your numbers",
          code: `JSON.parse("9007199254740993")                // 9007199254740992: off by one, no error
JSON.parse('{"id": 1050118621198921728}').id  // prints as 1050118621198921700
typeof JSON.parse("12345678901234567890")     // "number", never "bigint"`,
          caption: `The second line is the subtle one. That ID happens to be exactly representable, so the stored double is right, but JavaScript prints the shortest decimal that maps back to the same double. A client that builds <code>/tweets/1050118621198921700</code> asks for a different record.`,
        },
        {
          type: "text",
          html: `<p>In the visualization below, the true 64-bit ID is computed with exact integer arithmetic, and each row shows what a JavaScript client ends up with. Red digits are the ones that changed. The number line underneath shows the doubles available at the ID's magnitude, and how far apart they are.</p>`,
        },
        {
          type: "viz",
          id: "ch4/json-numbers",
          title: "JSON numbers vs 64-bit IDs",
          caption: `Try the presets, then pick "Largest safe: 2⁵³ − 1" and press +1 twice. Drag the ID-size slider toward 63 bits, and switch "Also send id_str" off and on again. Notice that past 2⁵³ two different IDs decode to the same double, that the tweet-style ID comes back with wrong trailing digits even though it is stored exactly, and that only the string copy survives every case.`,
        },
        {
          type: "text",
          html: `<p>No exception, no warning: the JSON is valid, the parser followed the spec, and the result is the closest double available. That's what makes the bug so expensive to find. The fix used in practice is to <strong>send 64-bit IDs as strings</strong> and treat them as opaque text in clients. If you need arithmetic on big integers, use a parser that produces <code>BigInt</code>: JavaScript has had BigInt since ES2020, but <code>JSON.parse</code> by itself never produces one.</p>
<h3>Bytes, schemas and CSV</h3>
<p><strong>Binary data.</strong> JSON and XML carry Unicode text, not raw bytes. To ship a thumbnail or a cryptographic signature, you encode it as <strong>Base64</strong>, which maps every 3 bytes to 4 ASCII characters: a third bigger, extra CPU on both ends, and the schema or the docs must say which strings are Base64 rather than text.</p>
<p><strong>Optional schemas.</strong> XML Schema and JSON Schema are powerful, and also complicated to learn and implement, so many JSON users skip them. The meaning of each field (number or numeric string? seconds or milliseconds? a date? Base64?) then lives in every consumer's code, and each consumer can guess differently.</p>
<p><strong>CSV</strong> has no schema at all. The application decides what each column means, and adding a column means updating every reader by hand. Escaping commas, quotes and newlines inside values is specified (RFC 4180), but not every tool follows it, so one stray comma in an address can shift every column after it. Spreadsheets that guess types make it worse, as the gene-name story below shows.</p>
<p>Despite all this, text formats are good enough for many purposes, above all <strong>data interchange between organizations</strong>, where the hard part is getting everyone to agree on any format at all.</p>`,
        },
        {
          type: "diagram",
          title: "Base64: 3 bytes become 4 characters",
          svg: `<style>.dd-diagram-body svg.c4d-b64-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c4d-b64-w{display:none}.dd-diagram-body svg.c4d-b64-n{display:block}}</style><svg class="c4d-b64-w" viewBox="0 0 640 146" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="The three bytes of the text Man, 24 bits in all, regrouped into four 6-bit groups with values 19, 22, 5 and 46, which Base64 maps to the characters T, W, F and u: 3 bytes become 4 characters, 33 percent bigger.">
  <g style="fill: var(--viz-c2-soft); stroke: var(--viz-line)"><rect x="64" y="32" width="20" height="26"/><rect x="84" y="32" width="20" height="26"/><rect x="104" y="32" width="20" height="26"/><rect x="124" y="32" width="20" height="26"/><rect x="144" y="32" width="20" height="26"/><rect x="164" y="32" width="20" height="26"/><rect x="184" y="32" width="20" height="26"/><rect x="204" y="32" width="20" height="26"/><rect x="224" y="32" width="20" height="26"/><rect x="244" y="32" width="20" height="26"/><rect x="264" y="32" width="20" height="26"/><rect x="284" y="32" width="20" height="26"/><rect x="304" y="32" width="20" height="26"/><rect x="324" y="32" width="20" height="26"/><rect x="344" y="32" width="20" height="26"/><rect x="364" y="32" width="20" height="26"/><rect x="384" y="32" width="20" height="26"/><rect x="404" y="32" width="20" height="26"/><rect x="424" y="32" width="20" height="26"/><rect x="444" y="32" width="20" height="26"/><rect x="464" y="32" width="20" height="26"/><rect x="484" y="32" width="20" height="26"/><rect x="504" y="32" width="20" height="26"/><rect x="524" y="32" width="20" height="26"/></g>
  <g style="fill: var(--viz-c3-soft); stroke: var(--viz-line)"><rect x="64" y="90" width="20" height="26"/><rect x="84" y="90" width="20" height="26"/><rect x="104" y="90" width="20" height="26"/><rect x="124" y="90" width="20" height="26"/><rect x="144" y="90" width="20" height="26"/><rect x="164" y="90" width="20" height="26"/><rect x="184" y="90" width="20" height="26"/><rect x="204" y="90" width="20" height="26"/><rect x="224" y="90" width="20" height="26"/><rect x="244" y="90" width="20" height="26"/><rect x="264" y="90" width="20" height="26"/><rect x="284" y="90" width="20" height="26"/><rect x="304" y="90" width="20" height="26"/><rect x="324" y="90" width="20" height="26"/><rect x="344" y="90" width="20" height="26"/><rect x="364" y="90" width="20" height="26"/><rect x="384" y="90" width="20" height="26"/><rect x="404" y="90" width="20" height="26"/><rect x="424" y="90" width="20" height="26"/><rect x="444" y="90" width="20" height="26"/><rect x="464" y="90" width="20" height="26"/><rect x="484" y="90" width="20" height="26"/><rect x="504" y="90" width="20" height="26"/><rect x="524" y="90" width="20" height="26"/></g>
  <g font-size="12" font-family="ui-monospace, Menlo, monospace" text-anchor="middle"><text x="74" y="49.32">0</text><text x="94" y="49.32">1</text><text x="114" y="49.32">0</text><text x="134" y="49.32">0</text><text x="154" y="49.32">1</text><text x="174" y="49.32">1</text><text x="194" y="49.32">0</text><text x="214" y="49.32">1</text><text x="234" y="49.32">0</text><text x="254" y="49.32">1</text><text x="274" y="49.32">1</text><text x="294" y="49.32">0</text><text x="314" y="49.32">0</text><text x="334" y="49.32">0</text><text x="354" y="49.32">0</text><text x="374" y="49.32">1</text><text x="394" y="49.32">0</text><text x="414" y="49.32">1</text><text x="434" y="49.32">1</text><text x="454" y="49.32">0</text><text x="474" y="49.32">1</text><text x="494" y="49.32">1</text><text x="514" y="49.32">1</text><text x="534" y="49.32">0</text><text x="74" y="107.32">0</text><text x="94" y="107.32">1</text><text x="114" y="107.32">0</text><text x="134" y="107.32">0</text><text x="154" y="107.32">1</text><text x="174" y="107.32">1</text><text x="194" y="107.32">0</text><text x="214" y="107.32">1</text><text x="234" y="107.32">0</text><text x="254" y="107.32">1</text><text x="274" y="107.32">1</text><text x="294" y="107.32">0</text><text x="314" y="107.32">0</text><text x="334" y="107.32">0</text><text x="354" y="107.32">0</text><text x="374" y="107.32">1</text><text x="394" y="107.32">0</text><text x="414" y="107.32">1</text><text x="434" y="107.32">1</text><text x="454" y="107.32">0</text><text x="474" y="107.32">1</text><text x="494" y="107.32">1</text><text x="514" y="107.32">1</text><text x="534" y="107.32">0</text></g>
  <g fill="none" stroke-width="2" style="stroke: var(--viz-c2)"><rect x="64" y="32" width="160" height="26" rx="2"/><rect x="224" y="32" width="160" height="26" rx="2"/><rect x="384" y="32" width="160" height="26" rx="2"/></g>
  <g fill="none" stroke-width="2" style="stroke: var(--viz-c3)"><rect x="64" y="90" width="120" height="26" rx="2"/><rect x="184" y="90" width="120" height="26" rx="2"/><rect x="304" y="90" width="120" height="26" rx="2"/><rect x="424" y="90" width="120" height="26" rx="2"/></g>
  <text x="144" y="24" font-size="12" text-anchor="middle"><tspan font-weight="700">M</tspan> = 0x4d</text>
  <text x="304" y="24" font-size="12" text-anchor="middle"><tspan font-weight="700">a</tspan> = 0x61</text>
  <text x="464" y="24" font-size="12" text-anchor="middle"><tspan font-weight="700">n</tspan> = 0x6e</text>
  <text x="8" y="50" font-size="12" font-weight="700">bytes</text>
  <text x="8" y="108" font-size="12" font-weight="700">Base64</text>
  <text x="304" y="79" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">the same 24 bits, regrouped 6 at a time</text>
  <text x="594" y="50" font-size="12" text-anchor="middle">3 bytes in</text>
  <text x="594" y="85" font-size="16" font-weight="700" text-anchor="middle" style="fill: var(--viz-bad)">+33%</text>
  <text x="594" y="108" font-size="12" text-anchor="middle">4 chars out</text>
  <text x="124" y="136" font-size="12" text-anchor="middle"><tspan style="fill: var(--viz-muted)">19 →</tspan> <tspan font-weight="700" font-size="13">T</tspan></text>
  <text x="244" y="136" font-size="12" text-anchor="middle"><tspan style="fill: var(--viz-muted)">22 →</tspan> <tspan font-weight="700" font-size="13">W</tspan></text>
  <text x="364" y="136" font-size="12" text-anchor="middle"><tspan style="fill: var(--viz-muted)">5 →</tspan> <tspan font-weight="700" font-size="13">F</tspan></text>
  <text x="484" y="136" font-size="12" text-anchor="middle"><tspan style="fill: var(--viz-muted)">46 →</tspan> <tspan font-weight="700" font-size="13">u</tspan></text>
</svg><svg class="c4d-b64-n" viewBox="0 0 360 224" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="The three bytes of the text Man, 24 bits in all, regrouped into four 6-bit groups with values 19, 22, 5 and 46, which Base64 maps to the characters T, W, F and u: 3 bytes become 4 characters, 33 percent bigger.">
  <g style="fill: var(--viz-c2-soft); stroke: var(--viz-line)"><rect x="24" y="34" width="13" height="22"/><rect x="37" y="34" width="13" height="22"/><rect x="50" y="34" width="13" height="22"/><rect x="63" y="34" width="13" height="22"/><rect x="76" y="34" width="13" height="22"/><rect x="89" y="34" width="13" height="22"/><rect x="102" y="34" width="13" height="22"/><rect x="115" y="34" width="13" height="22"/><rect x="128" y="34" width="13" height="22"/><rect x="141" y="34" width="13" height="22"/><rect x="154" y="34" width="13" height="22"/><rect x="167" y="34" width="13" height="22"/><rect x="180" y="34" width="13" height="22"/><rect x="193" y="34" width="13" height="22"/><rect x="206" y="34" width="13" height="22"/><rect x="219" y="34" width="13" height="22"/><rect x="232" y="34" width="13" height="22"/><rect x="245" y="34" width="13" height="22"/><rect x="258" y="34" width="13" height="22"/><rect x="271" y="34" width="13" height="22"/><rect x="284" y="34" width="13" height="22"/><rect x="297" y="34" width="13" height="22"/><rect x="310" y="34" width="13" height="22"/><rect x="323" y="34" width="13" height="22"/></g>
  <g style="fill: var(--viz-c3-soft); stroke: var(--viz-line)"><rect x="24" y="92" width="13" height="22"/><rect x="37" y="92" width="13" height="22"/><rect x="50" y="92" width="13" height="22"/><rect x="63" y="92" width="13" height="22"/><rect x="76" y="92" width="13" height="22"/><rect x="89" y="92" width="13" height="22"/><rect x="102" y="92" width="13" height="22"/><rect x="115" y="92" width="13" height="22"/><rect x="128" y="92" width="13" height="22"/><rect x="141" y="92" width="13" height="22"/><rect x="154" y="92" width="13" height="22"/><rect x="167" y="92" width="13" height="22"/><rect x="180" y="92" width="13" height="22"/><rect x="193" y="92" width="13" height="22"/><rect x="206" y="92" width="13" height="22"/><rect x="219" y="92" width="13" height="22"/><rect x="232" y="92" width="13" height="22"/><rect x="245" y="92" width="13" height="22"/><rect x="258" y="92" width="13" height="22"/><rect x="271" y="92" width="13" height="22"/><rect x="284" y="92" width="13" height="22"/><rect x="297" y="92" width="13" height="22"/><rect x="310" y="92" width="13" height="22"/><rect x="323" y="92" width="13" height="22"/></g>
  <g font-size="11" font-family="ui-monospace, Menlo, monospace" text-anchor="middle"><text x="30.5" y="48.96">0</text><text x="43.5" y="48.96">1</text><text x="56.5" y="48.96">0</text><text x="69.5" y="48.96">0</text><text x="82.5" y="48.96">1</text><text x="95.5" y="48.96">1</text><text x="108.5" y="48.96">0</text><text x="121.5" y="48.96">1</text><text x="134.5" y="48.96">0</text><text x="147.5" y="48.96">1</text><text x="160.5" y="48.96">1</text><text x="173.5" y="48.96">0</text><text x="186.5" y="48.96">0</text><text x="199.5" y="48.96">0</text><text x="212.5" y="48.96">0</text><text x="225.5" y="48.96">1</text><text x="238.5" y="48.96">0</text><text x="251.5" y="48.96">1</text><text x="264.5" y="48.96">1</text><text x="277.5" y="48.96">0</text><text x="290.5" y="48.96">1</text><text x="303.5" y="48.96">1</text><text x="316.5" y="48.96">1</text><text x="329.5" y="48.96">0</text><text x="30.5" y="106.96">0</text><text x="43.5" y="106.96">1</text><text x="56.5" y="106.96">0</text><text x="69.5" y="106.96">0</text><text x="82.5" y="106.96">1</text><text x="95.5" y="106.96">1</text><text x="108.5" y="106.96">0</text><text x="121.5" y="106.96">1</text><text x="134.5" y="106.96">0</text><text x="147.5" y="106.96">1</text><text x="160.5" y="106.96">1</text><text x="173.5" y="106.96">0</text><text x="186.5" y="106.96">0</text><text x="199.5" y="106.96">0</text><text x="212.5" y="106.96">0</text><text x="225.5" y="106.96">1</text><text x="238.5" y="106.96">0</text><text x="251.5" y="106.96">1</text><text x="264.5" y="106.96">1</text><text x="277.5" y="106.96">0</text><text x="290.5" y="106.96">1</text><text x="303.5" y="106.96">1</text><text x="316.5" y="106.96">1</text><text x="329.5" y="106.96">0</text></g>
  <g fill="none" stroke-width="2" style="stroke: var(--viz-c2)"><rect x="24" y="34" width="104" height="22" rx="2"/><rect x="128" y="34" width="104" height="22" rx="2"/><rect x="232" y="34" width="104" height="22" rx="2"/></g>
  <g fill="none" stroke-width="2" style="stroke: var(--viz-c3)"><rect x="24" y="92" width="78" height="22" rx="2"/><rect x="102" y="92" width="78" height="22" rx="2"/><rect x="180" y="92" width="78" height="22" rx="2"/><rect x="258" y="92" width="78" height="22" rx="2"/></g>
  <text x="76" y="26" font-size="12" text-anchor="middle"><tspan font-weight="700">M</tspan> 0x4d</text>
  <text x="180" y="26" font-size="12" text-anchor="middle"><tspan font-weight="700">a</tspan> 0x61</text>
  <text x="284" y="26" font-size="12" text-anchor="middle"><tspan font-weight="700">n</tspan> 0x6e</text>
  <text x="180" y="80" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">the same 24 bits, 6 at a time</text>
  <text x="180" y="192" font-size="12" text-anchor="middle">3 bytes in, 4 characters out:</text>
  <text x="180" y="213" font-size="14" font-weight="700" text-anchor="middle" style="fill: var(--viz-bad)">+33% size</text>
  <text x="63" y="136" font-size="13" font-weight="700" text-anchor="middle">T</text>
  <text x="63" y="153" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">19</text>
  <text x="141" y="136" font-size="13" font-weight="700" text-anchor="middle">W</text>
  <text x="141" y="153" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">22</text>
  <text x="219" y="136" font-size="13" font-weight="700" text-anchor="middle">F</text>
  <text x="219" y="153" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">5</text>
  <text x="297" y="136" font-size="13" font-weight="700" text-anchor="middle">u</text>
  <text x="297" y="153" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">46</text>
</svg>`,
          caption: `Base64 cuts the 24 bits of "Man" into four 6-bit groups and maps each value (0 to 63) to a printable character, giving "TWFu". Every character carries only 6 bits of data, so the text is 4/3 the size of the bytes, before any line breaks.`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Twitter API",
              tag: "id_str",
              html: `Tweet and user IDs are 64-bit Snowflake IDs well above 2<sup>53</sup>, so the v1.1 API returned every ID twice: as a JSON number <code>id</code> and as a decimal string <code>id_str</code>. JavaScript developers were told to use the string.`,
            },
            {
              org: "Discord API",
              tag: "IDs as strings",
              html: `Discord's API documentation states that snowflake IDs are always returned as strings, to prevent integer overflow in some languages.`,
            },
            {
              org: "Genomics and Excel",
              year: "2016",
              tag: "type guessing",
              html: `Ziemann et al. (<em>Genome Biology</em>, 2016) found that roughly one in five papers with supplementary Excel gene lists contained gene names silently converted to dates (SEPT2 became 2-Sep). In 2020 the HUGO Gene Nomenclature Committee renamed the affected genes instead, for example SEPT1 to SEPTIN1 and MARCH1 to MARCHF1.`,
            },
            {
              org: "MongoDB",
              tag: "BSON",
              html: `Stores documents as BSON, a binary JSON with extra types (ObjectId, Date, Decimal128, int32 and int64, binary data). A single BSON document is limited to 16 MB.`,
            },
            {
              org: "PostgreSQL",
              year: "2014",
              tag: "jsonb",
              html: `The <code>jsonb</code> type (9.4) stores JSON in a decomposed binary form: slower to write than the text-preserving <code>json</code> type, but much faster to query, and indexable.`,
            },
          ],
        },
        {
          type: "text",
          html: `<h3>Binary JSON: smaller, but not by much</h3>
<p>Because JSON is everywhere but bulky, a crop of binary encodings kept its data model: MessagePack, BSON, BJSON, UBJSON, BISON and Smile for JSON; WBXML and Fast Infoset for XML. Some extend the type system. MessagePack distinguishes integers from floats and has a binary type. BSON, MongoDB's format, adds dates, int64, Decimal128 and ObjectId, plus length prefixes so a reader can skip a field without parsing it.</p>
<p>None of them has a schema, though, so every record still spells out every field name. Take the record used throughout this chapter, <code>{"userName":"Martin","favoriteNumber":1337,"interests":["daydreaming","hacking"]}</code>. As JSON without whitespace it is <strong>81 bytes</strong>, 31 of which are the three field names. MessagePack gets it to <strong>66 bytes</strong> by swapping quotes and punctuation for compact type-and-length prefixes and writing 1337 in three bytes, but all 31 bytes of names remain. That's a saving of under a fifth, paid for with human readability. BSON isn't necessarily smaller than JSON at all: it adds length fields and stores array positions <code>"0"</code>, <code>"1"</code>, … as keys.</p>
<p>Size isn't everything, either. General-purpose compression such as gzip squeezes out much of the repetition in field names, which narrows the gap with every binary format, so CPU spent parsing and fidelity of types are often better reasons to switch. To drop the field names entirely, both sides need to agree on a schema, which is the next section.</p>`,
        },
        {
          type: "compare",
          title: "JSON vs MessagePack vs BSON",
          items: [
            {
              title: "JSON",
              tone: "info",
              html: `<p><strong>Readable:</strong> yes.<br><strong>Example record:</strong> 81 bytes.<br><strong>Types:</strong> string, one number type (precision up to the parser), boolean, null, array, object; no binary.<br><strong>Schema:</strong> optional (JSON Schema).<br><strong>Best for:</strong> public APIs, browsers, config, interchange between organizations.</p>`,
            },
            {
              title: "MessagePack",
              html: `<p><strong>Readable:</strong> no.<br><strong>Example record:</strong> 66 bytes, field names included.<br><strong>Types:</strong> JSON's, plus separate integer and float types and a binary type.<br><strong>Schema:</strong> none.<br><strong>Best for:</strong> a compact drop-in for JSON between your own services or in caches.</p>`,
            },
            {
              title: "BSON",
              html: `<p><strong>Readable:</strong> no.<br><strong>Size:</strong> often no smaller than JSON (length prefixes, array indexes stored as keys).<br><strong>Types:</strong> adds int32/int64, Decimal128, Date, ObjectId, binary.<br><strong>Schema:</strong> none.<br><strong>Built for:</strong> fast traversal inside MongoDB.</p>`,
            },
          ],
        },
        {
          type: "callout",
          tone: "tip",
          html: `<ul>
<li><strong>Send 64-bit IDs as strings</strong>, even if every client you have today uses a language with real 64-bit integers.</li>
<li><strong>Document units and number types</strong> for every numeric field: seconds or milliseconds, integer or decimal. Send money as a decimal string or as integer minor units (cents), never as a float.</li>
<li><strong>Treat string enums as a contract.</strong> A field like <code>"status": "pending"</code> whose set of values grows over time is a compatibility promise in disguise. Strict decoders (Swift's <code>Codable</code> enums, Jackson's default enum handling) throw on a value they don't know. Decide on purpose whether clients map unknown values to an explicit "unknown" case or reject them loudly. The <a href="#/ch4/learn/dataflow-services">section on services</a> lets you break a client exactly this way.</li>
</ul>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>Two questions come up. "<em>Why might a 64-bit ID break in a browser?</em>" A strong answer: JavaScript's <code>JSON.parse</code> turns JSON numbers into IEEE 754 doubles, which are exact only up to 2<sup>53</sup>, so bigger IDs round silently; send them as strings, as Twitter's <code>id_str</code> and Discord's snowflakes do. "<em>JSON or a binary format for internal APIs?</em>" A strong answer keeps JSON at the edges (browsers, partners, debugging) and uses a schema-driven binary format inside, justified as much by types and enforced schemas as by bytes, and notes that gzip narrows the size gap.</p>`,
        },
        {
          type: "quiz",
          q: "A Go backend returns {\"orderId\": 9007199254740993}. The browser runs JSON.parse and then requests /orders/ followed by that orderId. What happens?",
          options: [
            "JSON.parse throws a RangeError because the number is too large",
            "The browser requests /orders/9007199254740992: a different order, with no error anywhere",
            "It works, because the JSON specification requires parsers to keep arbitrary precision",
            "JSON.parse automatically returns a BigInt for integers above 2^53",
          ],
          answer: 1,
          explain: `JavaScript numbers are IEEE 754 doubles; above 2<sup>53</sup> not every integer exists as a double, so 9007199254740993 silently rounds to its neighbor 9007199254740992. Option A is the tempting one, but nothing throws: rounding is the defined behavior, which is what makes the bug silent. The JSON specification leaves precision to implementations rather than requiring it (C), and <code>JSON.parse</code> never produces a BigInt on its own (D). That's why APIs like Twitter's also send IDs as strings.`,
        },
      ],
    },
    // ------------------------------------------------------------------ 4
    {
      id: "thrift-protobuf",
      title: "Schemas let you stop shipping field names",
      kicker: "Binary formats",
      concepts: ["thrift-protocol-buffers", "interface-definition-language", "varint-zigzag", "field-tags"],
      blocks: [
        {
          type: "problem",
          html: `<p>At Google or Facebook scale, JSON's costs compound. Every record repeats every field name, numbers are spelled out in decimal, and every team hand-writes parsing code in every language it uses. Google's protobuf documentation describes where that leads: before Protocol Buffers, requests to its index servers were marshalled by hand, the code supported several versions of the protocol at once, and it filled up with branches like <code>if (version == 3)</code>.</p>
<p>Binary JSON doesn't fix this, because without a schema it still carries every field name. The way out is to agree on a schema up front, so that the bytes can say "field 1" instead of "userName", and to let a compiler generate the encoding and decoding code.</p>`,
        },
        {
          type: "idea",
          html: `<p>When both sides share a schema, each field can be identified by a <strong>small number, its tag</strong>, and its value packed in a compact binary form. The schema becomes the contract, and a <strong>code generator</strong> writes the parsers.</p>`,
        },
        {
          type: "text",
          html: `<h3>A schema, a compiler, generated classes</h3>
<p>Apache Thrift was developed at Facebook (open-sourced in 2007, later an Apache project); Protocol Buffers came from Google (open-sourced in 2008). Both start from a schema written in an <strong>interface definition language</strong> (IDL): a small, language-neutral file that lists each record's fields, each with a type and a number. A code generator turns the schema into classes for Java, C++, Go, Python and many other languages, complete with methods to encode and decode. Here is the chapter's example record in both:</p>`,
        },
        {
          type: "code",
          lang: "idl",
          title: "The same record in Thrift and in Protocol Buffers",
          code: `// Thrift IDL
struct Person {
  1: required string       userName,
  2: optional i64          favoriteNumber,
  3: optional list<string> interests
}

// Protocol Buffers (proto2 syntax, which still has "required")
message Person {
  required string user_name       = 1;
  optional int64  favorite_number = 2;
  repeated string interests       = 3;
}`,
          caption: `The numbers 1, 2 and 3 are the <strong>field tags</strong>, and they are what goes on the wire. The names exist only in the schema and in the generated code.`,
        },
        {
          type: "text",
          html: `<h3>Where the bytes go</h3>
<p>Thrift has two main binary encodings, which it calls protocols. In <strong>BinaryProtocol</strong>, each field starts with a 1-byte type and a 2-byte field tag, followed by the value. Strings get a 4-byte length prefix, and the 64-bit integer takes a fixed 8 bytes, even though 1337 needs only 11 bits. No field name appears anywhere. The record is <strong>59 bytes</strong>.</p>
<p><strong>CompactProtocol</strong> squeezes the same information harder. It writes each tag as the <em>difference</em> from the previous one, and when that delta is between 1 and 15 it shares a single byte with the type (<code>0x18</code> = delta 1, type 8 for strings; a bigger jump falls back to writing the tag separately). Lengths and integers become variable-length, and a list's size and element type share one byte. Result: <strong>34 bytes</strong>.</p>
<p><strong>Protocol Buffers</strong> has a single binary encoding, very close to CompactProtocol. Each field starts with a varint <strong>key</strong> equal to <code>(field_number &lt;&lt; 3) | wire_type</code>. The wire type tells a parser how the value is laid out: 0 VARINT, 1 I64 (fixed 8 bytes), 2 LEN (a length, then that many bytes: strings, bytes, nested messages, packed lists), 5 I32 (fixed 4 bytes); 3 and 4 are deprecated group markers. So <code>0x0a</code> means field 1, wire type 2. The record is <strong>33 bytes</strong>.</p>
<p>Below, the record is encoded six ways, one cell per byte. Pink cells spell field names, violet cells are the format's overhead (tags, type markers, lengths and counts), gray cells are structure (JSON's punctuation, end markers, Avro's union branch), and each field's value has its own color; the bars on top compare total sizes.</p>`,
        },
        {
          type: "viz",
          id: "ch4/encoding-bytes",
          title: "One record, six encodings",
          caption: `Try each format and tap single bytes to see what they mean. Then set favoriteNumber to -1, then to absent, and drag the interests slider. Notice that the pink field-name bytes disappear as soon as there is a schema, that Protobuf spends 10 bytes on -1 where Thrift Compact and Avro spend one, and that an unset optional field costs nothing in Protobuf and Thrift but still one byte in Avro.`,
        },
        {
          type: "text",
          html: `<p>For the default record the bars read: JSON 81, MessagePack 66, Thrift Binary 59, Thrift Compact 34, Protocol Buffers 33 and Avro 32 bytes. JSON and MessagePack spend 31 of those bytes on names. Thrift Binary swaps names for fixed-width tags and lengths. Thrift Compact and Protobuf shrink tags, lengths and small integers to a byte or two each. Avro, the smallest, drops even the tags; <a href="#/ch4/learn/avro">the Avro section</a> explains how it gets away with that.</p>`,
        },
        {
          type: "diagram",
          title: "Anatomy of a Protobuf key and a varint",
          svg: `<style>.dd-diagram-body svg.c4d-key-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c4d-key-w{display:none}.dd-diagram-body svg.c4d-key-n{display:block}}</style><svg class="c4d-key-w" viewBox="0 0 640 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top: the key byte 0x0a in bits, 00001 for field number 1 and 010 for wire type 2, length-delimited. Bottom: 1337 as a varint: the low 7 bits go first in a byte whose top bit is 1, meaning more bytes follow, giving 0xb9; the remaining bits go in a byte whose top bit is 0, giving 0x0a.">
  <text x="16" y="53" font-size="13" font-weight="700">Key byte 0x0a</text>
  <rect x="170" y="34" width="24" height="28" rx="3" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><rect x="196" y="34" width="24" height="28" rx="3" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><rect x="222" y="34" width="24" height="28" rx="3" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><rect x="248" y="34" width="24" height="28" rx="3" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><rect x="274" y="34" width="24" height="28" rx="3" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><rect x="300" y="34" width="24" height="28" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><rect x="326" y="34" width="24" height="28" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><rect x="352" y="34" width="24" height="28" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <g font-size="13" font-family="ui-monospace, Menlo, monospace" text-anchor="middle"><text x="182" y="53">0</text><text x="208" y="53">0</text><text x="234" y="53">0</text><text x="260" y="53">0</text><text x="286" y="53">1</text><text x="312" y="53">0</text><text x="338" y="53">1</text><text x="364" y="53">0</text></g>
  <path d="M170,68 L170,74 L296,74 L296,68" fill="none" stroke-width="1.5" style="stroke: var(--viz-c1)"/>
  <path d="M300,68 L300,74 L376,74 L376,68" fill="none" stroke-width="1.5" style="stroke: var(--viz-c6)"/>
  <text x="233" y="90" font-size="12" text-anchor="middle">field number 1</text>
  <text x="338" y="90" font-size="12" text-anchor="middle">type 2 = LEN</text>
  <text x="400" y="53" font-size="12" font-family="ui-monospace, Menlo, monospace">(1 &lt;&lt; 3) | 2 = 0x0a</text>
  <text x="400" y="73" font-size="12" style="fill: var(--viz-muted)">field 2 → 0x10, field 3 → 0x1a</text>
  <text x="16" y="146" font-size="13" font-weight="700">1337 as a varint</text>
  <text x="16" y="164" font-size="12" font-family="ui-monospace, Menlo, monospace" style="fill: var(--viz-muted)">101 0011 1001</text>
  <text x="273" y="121" font-size="12" text-anchor="middle">bits 0–6 go first</text>
  <text x="497" y="121" font-size="12" text-anchor="middle">then bits 7–10</text>
  <rect x="170" y="128" width="24" height="28" rx="3" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="196" y="128" width="24" height="28" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="222" y="128" width="24" height="28" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="248" y="128" width="24" height="28" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="274" y="128" width="24" height="28" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="300" y="128" width="24" height="28" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="326" y="128" width="24" height="28" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="352" y="128" width="24" height="28" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <g font-size="13" font-family="ui-monospace, Menlo, monospace" text-anchor="middle"><text x="182" y="147">1</text><text x="208" y="147">0</text><text x="234" y="147">1</text><text x="260" y="147">1</text><text x="286" y="147">1</text><text x="312" y="147">0</text><text x="338" y="147">0</text><text x="364" y="147">1</text></g>
  <rect x="394" y="128" width="24" height="28" rx="3" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="420" y="128" width="24" height="28" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="446" y="128" width="24" height="28" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="472" y="128" width="24" height="28" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="498" y="128" width="24" height="28" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="524" y="128" width="24" height="28" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="550" y="128" width="24" height="28" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="576" y="128" width="24" height="28" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <g font-size="13" font-family="ui-monospace, Menlo, monospace" text-anchor="middle"><text x="406" y="147">0</text><text x="432" y="147">0</text><text x="458" y="147">0</text><text x="484" y="147">0</text><text x="510" y="147">1</text><text x="536" y="147">0</text><text x="562" y="147">1</text><text x="588" y="147">0</text></g>
  <text x="273" y="176" font-size="13" font-weight="700" text-anchor="middle" font-family="ui-monospace, Menlo, monospace">= 0xb9</text>
  <text x="273" y="193" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">top bit 1: more bytes follow</text>
  <text x="497" y="176" font-size="13" font-weight="700" text-anchor="middle" font-family="ui-monospace, Menlo, monospace">= 0x0a</text>
  <text x="497" y="193" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">top bit 0: last byte</text>
</svg><svg class="c4d-key-n" viewBox="0 0 360 252" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top: the key byte 0x0a in bits, 00001 for field number 1 and 010 for wire type 2, length-delimited. Bottom: 1337 as a varint: the low 7 bits go first in a byte whose top bit is 1, meaning more bytes follow, giving 0xb9; the remaining bits go in a byte whose top bit is 0, giving 0x0a.">
  <text x="12" y="22" font-size="13" font-weight="700">Key byte 0x0a</text>
  <rect x="24" y="32" width="30" height="28" rx="3" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><rect x="56" y="32" width="30" height="28" rx="3" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><rect x="88" y="32" width="30" height="28" rx="3" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><rect x="120" y="32" width="30" height="28" rx="3" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><rect x="152" y="32" width="30" height="28" rx="3" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/><rect x="184" y="32" width="30" height="28" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><rect x="216" y="32" width="30" height="28" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/><rect x="248" y="32" width="30" height="28" rx="3" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
  <g font-size="13" font-family="ui-monospace, Menlo, monospace" text-anchor="middle"><text x="39" y="51">0</text><text x="71" y="51">0</text><text x="103" y="51">0</text><text x="135" y="51">0</text><text x="167" y="51">1</text><text x="199" y="51">0</text><text x="231" y="51">1</text><text x="263" y="51">0</text></g>
  <path d="M24,66 L24,72 L174,72 L174,66" fill="none" stroke-width="1.5" style="stroke: var(--viz-c1)"/>
  <path d="M184,66 L184,72 L278,72 L278,66" fill="none" stroke-width="1.5" style="stroke: var(--viz-c6)"/>
  <text x="99" y="88" font-size="12" text-anchor="middle">field number 1</text>
  <text x="231" y="88" font-size="12" text-anchor="middle">type 2 = LEN</text>
  <text x="12" y="112" font-size="12" font-family="ui-monospace, Menlo, monospace">(1 &lt;&lt; 3) | 2 = 0x0a</text>
  <text x="12" y="148" font-size="13" font-weight="700">1337 as a varint</text>
  <text x="150" y="148" font-size="12" font-family="ui-monospace, Menlo, monospace" style="fill: var(--viz-muted)">= 101 0011 1001</text>
  <rect x="16" y="160" width="18" height="26" rx="3" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="36" y="160" width="18" height="26" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="56" y="160" width="18" height="26" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="76" y="160" width="18" height="26" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="96" y="160" width="18" height="26" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="116" y="160" width="18" height="26" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="136" y="160" width="18" height="26" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="156" y="160" width="18" height="26" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <g font-size="12" font-family="ui-monospace, Menlo, monospace" text-anchor="middle"><text x="25" y="177">1</text><text x="45" y="177">0</text><text x="65" y="177">1</text><text x="85" y="177">1</text><text x="105" y="177">1</text><text x="125" y="177">0</text><text x="145" y="177">0</text><text x="165" y="177">1</text></g>
  <rect x="186" y="160" width="18" height="26" rx="3" style="fill: var(--viz-warn-soft); stroke: var(--viz-warn)"/><rect x="206" y="160" width="18" height="26" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="226" y="160" width="18" height="26" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="246" y="160" width="18" height="26" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="266" y="160" width="18" height="26" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="286" y="160" width="18" height="26" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="306" y="160" width="18" height="26" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/><rect x="326" y="160" width="18" height="26" rx="3" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
  <g font-size="12" font-family="ui-monospace, Menlo, monospace" text-anchor="middle"><text x="195" y="177">0</text><text x="215" y="177">0</text><text x="235" y="177">0</text><text x="255" y="177">0</text><text x="275" y="177">1</text><text x="295" y="177">0</text><text x="315" y="177">1</text><text x="335" y="177">0</text></g>
  <text x="95" y="206" font-size="13" font-weight="700" text-anchor="middle" font-family="ui-monospace, Menlo, monospace">0xb9</text>
  <text x="265" y="206" font-size="13" font-weight="700" text-anchor="middle" font-family="ui-monospace, Menlo, monospace">0x0a</text>
  <text x="95" y="224" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">top bit 1: more follows</text>
  <text x="265" y="224" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">top bit 0: last byte</text>
  <text x="95" y="242" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">bits 0–6</text>
  <text x="265" y="242" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">bits 7–10</text>
</svg>`,
          caption: `Top: one key byte carries both the field number and the wire type, so field 1 costs a single byte where JSON spent 11 on <code>"userName":</code>. Bottom: a varint stores 7 bits per byte, low bits first; the top bit (amber) says whether another byte follows.`,
        },
        {
          type: "text",
          html: `<h3>Varints and zigzag</h3>
<p>A <strong>varint</strong> spends 7 bits of each byte on the number and uses the top bit as a "more bytes follow" flag, least significant group first. Numbers from 0 to 127 take one byte, 1337 takes two (<code>b9 0a</code>), and a full 64-bit value takes up to ten. Most integers in real data are small, so this beats fixed widths easily.</p>
<p>Negative numbers are the catch. In two's complement, −1 is all ones, which read as an unsigned varint is enormous, so Protobuf's plain <code>int32</code> and <code>int64</code> encode every negative value in <strong>10 bytes</strong>. <strong>Zigzag</strong> encoding fixes this by interleaving signs before the varint step (0→0, −1→1, 1→2, −2→3, …), so small magnitudes stay small whatever their sign. Thrift's CompactProtocol and Avro zigzag their integers; Protobuf does it only for fields declared <code>sint32</code> or <code>sint64</code>. In those encodings 1337 becomes 2674 and then <code>f2 14</code>.</p>
<h3>Details that matter later</h3>
<ul>
<li><strong>Tag sizes.</strong> Field numbers 1 to 15 fit in a one-byte key, 16 to 2047 need two, so give 1 to 15 to the most frequent fields. Numbers go up to 2<sup>29</sup> − 1, except 19000 to 19999, which Protobuf reserves for its own implementation.</li>
<li><strong><code>required</code> and <code>optional</code> don't change the encoding.</strong> The bytes are identical either way. <code>required</code> only makes the parser check at runtime that the field is present, which catches bugs and becomes a trap once the schema evolves (next section).</li>
<li><strong>Lists.</strong> Protobuf has no list type: a <code>repeated</code> field is just the same tag appearing again, which is why key <code>1a</code> shows up once per interest. Repeated numeric fields can instead be <em>packed</em> into a single LEN value, the default in proto3. Thrift has a real <code>list</code> type with an element type and a count, which also allows nested lists.</li>
<li><strong>More protocols.</strong> Thrift also has a JSON protocol, and the book mentions an experimental DenseProtocol that only the C++ implementation supported.</li>
</ul>
<p>The costs are real. Without the schema the bytes are unreadable: <code>protoc --decode_raw</code> can list tags, wire types and values, but not names or meanings. You need a build step to run the code generator. And generated classes are a clear win in statically typed languages (type checking, autocompletion) but can feel heavy in dynamic ones, where a plain dictionary would have done.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Google",
              year: "2008",
              tag: "Protocol Buffers",
              html: `Built first for the index server protocol described above, and open-sourced in July 2008. Google's public Cloud APIs are still defined as <code>.proto</code> files, published in the googleapis repository.`,
            },
            {
              org: "Facebook",
              year: "2007",
              tag: "Thrift",
              html: `Described in the 2007 paper "Thrift: Scalable Cross-Language Services Implementation" (Slee, Agarwal, Kwiatkowski), then donated to the Apache Software Foundation. Meta also maintains its own fork, fbthrift.`,
            },
            {
              org: "gRPC",
              year: "2015",
              tag: "Protobuf over HTTP/2",
              html: `Open-sourced by Google in 2015 as the public successor to its internal Stubby RPC system. It uses Protocol Buffers as its default IDL and encoding, carried over HTTP/2.`,
            },
            {
              org: "Cap'n Proto and FlatBuffers",
              tag: "zero-copy",
              html: `Formats with no separate decode step: readers access fields directly in the received buffer. Cap'n Proto (2013) is by Kenton Varda, previously the primary author of Protocol Buffers v2 at Google; Google's FlatBuffers (2014) is the file format of TensorFlow Lite models.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Since the book: <strong>proto3</strong> (2016) simplified the language, with no <code>required</code>, no custom default values, and plain scalar fields that don't record whether they were set (the next section explains why that matters and how Protobuf Editions now replace the proto2/proto3 split). <strong>gRPC</strong> made Protobuf the default encoding for service-to-service calls far beyond Google. And for latency-critical code, the zero-copy formats above skip decoding altogether, usually at the cost of bigger messages, because their fields are fixed-width and aligned.</p>`,
        },
        {
          type: "tradeoffs",
          prosLabel: "What a schema-driven binary format buys",
          consLabel: "What it costs",
          pros: [
            "Compact: no field names and variable-length numbers; the example record shrinks from 81 bytes to 33 or 34.",
            "Fast to encode and decode, with no text to parse.",
            "Typed: the schema says <code>int64</code>, so nobody guesses about numbers, dates or binary data.",
            "Generated code for many languages, all in sync with one contract.",
            "The schema is documentation that the code actually enforces.",
          ],
          cons: [
            "Bytes are unreadable without the schema; debugging needs tools.",
            "A build step for code generation, and generated classes feel heavy in dynamic languages.",
            "Every reader needs access to some version of the schema.",
            "Evolution rules must be learned and followed: tags are forever (next section).",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"<em>Why is Protobuf so much smaller than JSON, and what do you give up?</em>" A strong answer walks through one field: a one-byte key holding the field number and wire type replaces the quoted name, varints shrink small integers, and length prefixes replace quotes and escaping, so the example record drops from 81 bytes to 33. Bonus details: <code>required</code> and <code>optional</code> don't change the bytes, unset fields cost nothing, and negative numbers want <code>sint64</code> (zigzag). Then the costs: bytes unreadable without the schema, a code-generation step, and tag numbers that become a permanent contract.</p>`,
        },
        {
          type: "quiz",
          q: "In a proto2 schema, 'optional int64 favorite_number = 2;' holds -1. How many bytes does this field take on the wire?",
          options: [
            "2 bytes: one key byte and one value byte",
            "3 bytes, the same as 1337",
            "9 bytes: one key byte plus a fixed 8-byte integer",
            "11 bytes: one key byte plus a 10-byte varint",
          ],
          answer: 3,
          explain: `<code>int64</code> encodes the two's-complement value as a plain varint, so −1 looks like an enormous unsigned number and needs 10 varint bytes, plus 1 key byte. Option A is the tempting one: it is what you'd get by declaring the field <code>sint64</code>, where zigzag maps −1 to 1, and it's what Thrift's CompactProtocol and Avro do by default. Option C is what an <code>sfixed64</code> field would take; a varint field never uses a fixed width.`,
        },
      ],
    },
    // ------------------------------------------------------------------ 5
    {
      id: "field-tags-evolution",
      title: "Field tags are forever",
      kicker: "Schema evolution",
      concepts: ["field-tags", "backward-compatibility", "forward-compatibility"],
      blocks: [
        {
          type: "problem",
          html: `<p>Schemas change: you add a field for a new feature, retire an old one, widen a type. With tag-based formats the bytes hold only tag numbers, wire types and values, so two questions decide everything. What does v1 code do with a tag it has never seen? And what does v2 code do when a tag it expects is missing?</p>
<p>Get the rules wrong and you get the hardest failures to notice: new code rejecting old records, old code silently truncating numbers, or, if someone recycles a tag number, old data quietly read as a different field.</p>`,
        },
        {
          type: "idea",
          html: `<p>A field's <strong>tag number is its identity</strong>. Names can change freely, new tags can be added if they are optional, deleted tags must never be reused, and the <strong>wire type</strong> tells old code how many bytes to skip.</p>`,
        },
        {
          type: "text",
          html: `<h3>Forward: old code skips what it doesn't know</h3>
<p>Say v2 adds <code>optional string photo_url = 4;</code>. A v1 parser reading v2's bytes meets the key <code>0x22</code>: field 4, wire type 2. It has no field 4, but the wire type alone says how long the value is: for VARINT it reads until a byte has its top bit clear, for LEN it reads the length and jumps that far, for I64 and I32 it skips 8 or 4 bytes. Then it carries on with the next key.</p>
<p>Modern Protobuf libraries also keep the skipped bytes as <strong>unknown fields</strong> on the decoded message and write them back out when it is re-encoded. That would have saved Maya's photo in the opening story, provided v1 re-encodes the decoded message itself rather than copying its fields into a hand-written class.</p>
<h3>Backward: new code fills in defaults</h3>
<p>In the other direction, v2 reads a record written by v1, finds no tag 4, and leaves <code>photo_url</code> at its default. That only works if a missing value is allowed, so <strong>every field added after the first deployment must be optional or have a default</strong>. A new <code>required</code> field makes v2 reject every older record, since none of them can contain it.</p>
<h3>Removing, renaming, renumbering</h3>
<ul>
<li><strong>Removing</strong> is the mirror image: remove only optional fields, because old code still insists on a required one and would reject every new record. Protobuf's proto2 guide puts it bluntly: <em>required is forever</em>.</li>
<li><strong>Never reuse a deleted tag number.</strong> Data written years ago still carries it. Protobuf turns reuse into a compile error with <code>reserved 2;</code> (and <code>reserved "favorite_number";</code> for the name).</li>
<li><strong>Renaming</strong> is free on the wire, because names never appear in the bytes; <strong>changing a tag number</strong> is not a rename at all but a delete plus an add (more in the misconception box below).</li>
</ul>
<p>Why is reuse so dangerous? If the new field has the same wire type as the old one, nothing fails. A record written in 2019 with <code>favorite_number = 1337</code> under tag 2 decodes as <code>referrer_id = 1337</code>, and old code reads new referrer IDs as favorite numbers: silent corruption in both directions. (If the wire types differ, the value lands among the unknown fields and the field silently reads as unset instead.)</p>
<p>All of this must hold for <strong>every pair of versions that can coexist</strong>, plus every version whose data is still stored, not just the latest pair. In the visualization, the two cards show the v1 and v2 schemas, and two lanes decode a record in each direction: backward (v2 reads v1's bytes) and forward (v1 reads v2's bytes).</p>`,
        },
        {
          type: "viz",
          id: "ch4/tag-evolution",
          title: "Evolving a Protobuf schema",
          caption: `Try every entry in "Schema change" and press Decode to watch the parser walk the chunks. Notice which changes fail loudly (adding or deleting a required field), which corrupt data with no error at all (reusing or renumbering a tag, widening int32 to int64 when old code reads big values), and that old code skips an unknown tag using nothing but its wire type.`,
        },
        {
          type: "text",
          html: `<p>The loud failures are the lucky ones: a parse error shows up in tests or early in a canary. The dangerous changes decode "successfully" into wrong values.</p>
<h3>Changing a field's type</h3>
<p>Here the parser's silence hurts most. <code>int32</code>, <code>uint32</code>, <code>int64</code>, <code>uint64</code> and <code>bool</code> all share the VARINT wire type, so swapping one for another never raises an error, even when the meaning breaks. Widening <code>int32</code> to <code>int64</code> is fine for new code reading old data, but old code reading a large new value truncates it to 32 bits: 5,000,000,000 arrives as 705,032,704. <code>sint32</code> and <code>sint64</code> use zigzag, so they don't mix with <code>int32</code> and <code>int64</code>: an <code>int32</code> 1 decodes as <code>sint32</code> −1.</p>
<p>Turning a single value into a list is allowed in Protobuf only for <code>string</code>, <code>bytes</code> and message fields: new code sees a list of zero or one elements, while old code keeps only the last element (or merges messages). It is <em>not</em> safe for numeric, bool or enum fields, whose repeated form is packed by default in proto3 and won't parse correctly as a single value. Thrift's dedicated list type rules this change out, but in exchange allows nested lists.</p>`,
        },
        {
          type: "table",
          title: "Protobuf schema changes at a glance",
          headers: ["Change", "New code reads old data (backward)", "Old code reads new data (forward)", "What goes wrong"],
          rows: [
            ["Add an optional field with a new tag", `<span class="hl-good">OK</span>: unset, default used`, `<span class="hl-good">OK</span>: skipped, kept as unknown field`, "Nothing; this is the normal way to evolve"],
            ["Add a <code>required</code> field (proto2)", `<span class="hl-bad">BREAKS</span>: old records lack it`, `<span class="hl-good">OK</span>`, "Every record written before the change is rejected"],
            ["Delete an optional field and reserve its tag", `<span class="hl-good">OK</span>: tag skipped`, `<span class="hl-good">OK</span>: field reads as unset`, "Old code must cope with \"unset\""],
            ["Delete a <code>required</code> field", `<span class="hl-good">OK</span>`, `<span class="hl-bad">BREAKS</span>: old code rejects new records`, "Required is forever"],
            ["Rename a field, same tag", `<span class="hl-good">OK</span>`, `<span class="hl-good">OK</span>`, "Breaks the JSON mapping, text format and code using the old name"],
            ["Change a field's tag number", `<span class="hl-bad">CORRUPTS</span>: old data ignored`, `<span class="hl-bad">CORRUPTS</span>: new data ignored`, "The field silently vanishes in both directions"],
            ["Reuse a deleted tag, same wire type", `<span class="hl-bad">CORRUPTS</span>: old values read as the new field`, `<span class="hl-bad">CORRUPTS</span>: new values read as the old field`, "No error anywhere; <code>reserved</code> prevents it"],
            ["<code>int32</code> → <code>int64</code>", `<span class="hl-good">OK</span>`, `<span class="hl-bad">CORRUPTS</span>: values over 32 bits truncated`, "5,000,000,000 becomes 705,032,704"],
            ["<code>int32</code> ↔ <code>sint32</code>", `<span class="hl-bad">CORRUPTS</span>`, `<span class="hl-bad">CORRUPTS</span>`, "Zigzag vs two's complement: 1 reads as −1"],
            ["Optional <code>string</code> → <code>repeated string</code>", `<span class="hl-good">OK</span>: list of 0 or 1`, `<span class="hl-warn">LOSSY</span>: last element wins`, "Earlier elements dropped if old code rewrites the record"],
            ["Optional <code>int32</code> → <code>repeated int32</code> (packed)", `<span class="hl-good">OK</span>`, `<span class="hl-bad">Not safe</span>: packed form not parsed correctly`, "Only strings, bytes and messages may make this change"],
            ["Add an enum value", `<span class="hl-good">OK</span>`, `<span class="hl-warn">MISREAD</span>: proto2 reports the default, proto3 keeps the raw number`, "Old code takes the wrong branch, silently"],
          ],
          note: `Status words match the visualization: BREAKS fails loudly, CORRUPTS returns wrong data with no error, LOSSY drops data on rewrite, MISREAD returns a value the old code can't interpret.`,
        },
        {
          type: "diagram",
          title: "The life of a tag number",
          svg: `<style>.dd-diagram-body svg.c4d-tag-n{display:none}@media (max-width:600px){.dd-diagram-body svg.c4d-tag-w{display:none}.dd-diagram-body svg.c4d-tag-n{display:block}}</style><svg class="c4d-tag-w" viewBox="0 0 640 196" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Schema versions over time. In v1, tag 2 is favorite_number. In v3 the field is deleted and the line becomes reserved 2. In v5 a teammate adds tag 2 as referrer_id. With the reserved statement this is a compile error and the teammate picks tag 4. Without it there is no error, and old favorite numbers silently read as referrer IDs.">
  <defs><marker id="c4d-tag-w-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ok)"/></marker><marker id="c4d-tag-w-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker></defs>
  <line x1="40" y1="46" x2="600" y2="46" stroke-width="2" style="stroke: var(--viz-line)"/>
  <circle cx="100" cy="46" r="6" style="fill: var(--viz-c1)"/><circle cx="310" cy="46" r="6" style="fill: var(--viz-muted)"/><circle cx="520" cy="46" r="6" style="fill: var(--viz-c1)"/>
  <text x="100" y="30" font-size="12" font-weight="700" text-anchor="middle">v1</text>
  <text x="310" y="30" font-size="12" font-weight="700" text-anchor="middle">v3: field deleted</text>
  <text x="520" y="30" font-size="12" font-weight="700" text-anchor="middle">v5: a teammate adds</text>
  <rect x="22" y="58" width="156" height="28" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="100" y="77" font-size="12" font-family="ui-monospace, Menlo, monospace" text-anchor="middle">2 = favorite_number</text>
  <rect x="250" y="58" width="120" height="28" rx="6" stroke-dasharray="4 3" style="fill: var(--viz-node); stroke: var(--viz-muted)"/>
  <text x="310" y="77" font-size="12" font-family="ui-monospace, Menlo, monospace" text-anchor="middle" style="fill: var(--viz-muted)">reserved 2;</text>
  <rect x="450" y="58" width="140" height="28" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="520" y="77" font-size="12" font-family="ui-monospace, Menlo, monospace" text-anchor="middle">2 = referrer_id</text>
  <path d="M490,88 L292,110" fill="none" stroke-width="1.8" marker-end="url(#c4d-tag-w-ok)" style="stroke: var(--viz-ok)"/>
  <path d="M540,88 L532,110" fill="none" stroke-width="1.8" marker-end="url(#c4d-tag-w-bad)" style="stroke: var(--viz-bad)"/>
  <rect x="160" y="112" width="240" height="74" rx="8" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <text x="280" y="133" font-size="12" font-weight="700" text-anchor="middle">with reserved 2;</text>
  <text x="280" y="152" font-size="12" text-anchor="middle">compile error: the teammate</text>
  <text x="280" y="171" font-size="12" text-anchor="middle">picks tag 4 instead</text>
  <rect x="416" y="112" width="216" height="74" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
  <text x="524" y="133" font-size="12" font-weight="700" text-anchor="middle">without it: no error</text>
  <text x="524" y="152" font-size="12" text-anchor="middle">old favorite numbers now</text>
  <text x="524" y="171" font-size="12" text-anchor="middle">read as referrer_id</text>
</svg><svg class="c4d-tag-n" viewBox="0 0 360 298" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Schema versions over time. In v1, tag 2 is favorite_number. In v3 the field is deleted and the line becomes reserved 2. In v5 a teammate adds tag 2 as referrer_id. With the reserved statement this is a compile error and the teammate picks tag 4. Without it there is no error, and old favorite numbers silently read as referrer IDs.">
  <defs><marker id="c4d-tag-n-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ok)"/></marker><marker id="c4d-tag-n-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-bad)"/></marker></defs>
  <line x1="24" y1="22" x2="24" y2="142" stroke-width="2" style="stroke: var(--viz-line)"/>
  <circle cx="24" cy="22" r="6" style="fill: var(--viz-c1)"/><circle cx="24" cy="82" r="6" style="fill: var(--viz-muted)"/><circle cx="24" cy="142" r="6" style="fill: var(--viz-c1)"/>
  <text x="40" y="26" font-size="12" font-weight="700">v1</text>
  <text x="40" y="86" font-size="12" font-weight="700">v3: field deleted</text>
  <text x="40" y="146" font-size="12" font-weight="700">v5: a teammate adds</text>
  <rect x="40" y="34" width="160" height="24" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="120" y="51" font-size="12" font-family="ui-monospace, Menlo, monospace" text-anchor="middle">2 = favorite_number</text>
  <rect x="40" y="94" width="120" height="24" rx="6" stroke-dasharray="4 3" style="fill: var(--viz-node); stroke: var(--viz-muted)"/>
  <text x="100" y="111" font-size="12" font-family="ui-monospace, Menlo, monospace" text-anchor="middle" style="fill: var(--viz-muted)">reserved 2;</text>
  <rect x="40" y="154" width="140" height="24" rx="6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
  <text x="110" y="171" font-size="12" font-family="ui-monospace, Menlo, monospace" text-anchor="middle">2 = referrer_id</text>
  <path d="M80,179 L90,195" fill="none" stroke-width="1.8" marker-end="url(#c4d-tag-n-ok)" style="stroke: var(--viz-ok)"/>
  <path d="M160,179 L250,195" fill="none" stroke-width="1.8" marker-end="url(#c4d-tag-n-bad)" style="stroke: var(--viz-bad)"/>
  <rect x="8" y="198" width="168" height="92" rx="8" style="fill: var(--viz-ok-soft); stroke: var(--viz-ok)"/>
  <text x="92" y="220" font-size="12" font-weight="700" text-anchor="middle">with reserved 2;</text>
  <text x="92" y="239" font-size="12" text-anchor="middle">compile error:</text>
  <text x="92" y="258" font-size="12" text-anchor="middle">teammate picks</text>
  <text x="92" y="277" font-size="12" text-anchor="middle">tag 4 instead</text>
  <rect x="184" y="198" width="168" height="92" rx="8" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
  <text x="268" y="220" font-size="12" font-weight="700" text-anchor="middle">without it:</text>
  <text x="268" y="239" font-size="12" text-anchor="middle">no error at all;</text>
  <text x="268" y="258" font-size="12" text-anchor="middle">old data reads</text>
  <text x="268" y="277" font-size="12" text-anchor="middle">as referrer_id</text>
</svg>`,
          caption: `Deleting a field ends its use, not its tag's existence: years of stored data still carry tag 2. <code>reserved</code> is a note from past you that the compiler enforces.`,
        },
        {
          type: "text",
          html: `<h3>Two traps that pass every compile check</h3>
<p><strong>Adding an enum value</strong> looks additive, but old code has never heard of it. Say v1 has <code>enum Plan { FREE = 0; PRO = 1; }</code> and v2 adds <code>TEAM = 2</code>. What v1 does with a 2 depends on the syntax. proto2 enums are <em>closed</em>: C++ and Java parsers move the unrecognized value into the unknown fields and report the field as unset, so it reads as its default, <code>FREE</code>, and a paying team is treated as a free user. proto3 enums are <em>open</em>: the field keeps the raw number, and Java exposes it as <code>UNRECOGNIZED</code>.</p>
<p>The defenses: make value 0 a sentinel such as <code>PLAN_UNSPECIFIED</code> (proto3 requires the first value to be 0 and uses it as the default, so the unknown plan would at least read as "unspecified" rather than as a real plan), never renumber or reuse enum numbers (reserve them), and make old code handle unknown values explicitly instead of falling into a default branch.</p>
<p><strong>Field presence</strong> is the second trap. In proto3, a plain scalar field can't tell "not set" from its zero value: new code reading a record written before <code>favorite_number</code> existed sees <code>0</code>, just as if someone had really chosen 0. If missing must differ from zero, declare the field with explicit <code>optional</code> (Protobuf 3.15 and later), use a wrapper type such as <code>google.protobuf.Int64Value</code>, or put it in a <code>oneof</code>. proto2 optional fields always track presence, with <code>has_</code> accessors.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Knight Capital",
              year: "2012",
              tag: "a reused flag",
              html: `On 1 August 2012 new trading code was deployed to 7 of 8 servers. The eighth still ran old code, in which a repurposed flag switched on the long-retired "Power Peg" function. It sent millions of unintended orders, and Knight lost more than $440 million in about 45 minutes (SEC order, 2013). Reusing a flag is the operational twin of reusing a field tag.`,
            },
            {
              org: "Protocol Buffers docs",
              tag: "reserved",
              html: `The language guide tells you to list deleted field numbers (and names) in a <code>reserved</code> statement, so that any later edit reusing them fails to compile, and it lists tag reuse among the changes that corrupt data.`,
            },
            {
              org: "Buf",
              tag: "breaking-change checks",
              html: `The Buf CLI's <code>buf breaking</code> compares .proto files against a previous version (for example the main branch) and fails CI on wire- or source-incompatible changes such as deleted or renumbered fields.`,
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          html: `<p>Google's experience with evolution shaped <strong>proto3</strong> (2016), which dropped <code>required</code> altogether. Early proto3 also discarded unknown fields, breaking the pass-through that forward compatibility depends on; preservation came back in version 3.5 (2017), and explicit <code>optional</code> for fields where "unset" must differ from zero returned in 3.15 (2021). <strong>Protobuf Editions</strong> (starting with edition 2023) replace the proto2/proto3 split: each file or field chooses behaviors such as presence tracking and open or closed enums, while the wire format stays the same. And teams increasingly enforce the rules mechanically, with CI checks like the <code>buf breaking</code> one above, so a renumbered or reused tag fails the build instead of corrupting production data.</p>`,
        },
        {
          type: "callout",
          tone: "mistake",
          title: "Renaming is free; renumbering never is",
          html: `<p>Two opposite misconceptions. "Renaming a field breaks compatibility": not on the wire, where only the tag travels, though it does break Protobuf's JSON mapping and text format (which use names) and any code that refers to the old name. "Renumbering is just tidying up": never. Moving <code>interests</code> from tag 3 to tag 5 makes every existing record's interests invisible to new code, and every new record's interests invisible to old code, with no error.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          html: `<p>"<em>A teammate deleted field 2 last quarter and now wants to reuse number 2 for a new field. What do you say?</em>" A strong answer: tags are identity, and stored data still carries tag 2 with the same wire type, so new code would silently read old favorite numbers as the new field, and old code would do the reverse. Reserve the number and the name, pick a fresh tag, and enforce it with <code>reserved</code> plus a breaking-change check in CI. Extra credit for the general rules (new fields optional, never remove a required one, enums with an <code>UNSPECIFIED</code> zero, widen a type only once no old reader can see large values) and for asking which versions, and which stored data, still exist.</p>`,
        },
        {
          type: "quiz",
          q: "You delete 'int64 favorite_number = 2' from a schema. A month later a teammate adds 'int64 referrer_id = 2'. What happens when the new code reads records written before the deletion?",
          options: [
            "Decoding fails with a type error",
            "Old favorite numbers silently show up as referrer IDs",
            "The field is skipped, because the names differ",
            "Protobuf detects the reuse by comparing schema hashes",
          ],
          answer: 1,
          explain: `Only the tag and the wire type travel on the wire. Tag 2 with a varint matches the new field perfectly, so 1337 becomes <code>referrer_id = 1337</code> with no error, and A is wrong because the types agree. Option C is the tempting one, but names never appear in the binary encoding, so a parser can't notice they differ. Protobuf has no schema hash (D). <code>reserved 2;</code> would have turned this mistake into a compile error.`,
        },
      ],
    },
  ],
});
