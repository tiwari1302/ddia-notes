// Chapter 11 deep dive, part 2 (second half of the sections + takeaways). Authoring guide: docs/AUTHORING.md
DDIA.registerDeepDive("ch11", {
  sections: [
    // ───────────────────────────────────────────────────────────── 6
    {
      id: "state-and-immutability",
      title: "State is the sum of its changes: immutability, many views, and the right to be forgotten",
      kicker: "Databases and streams",
      concepts: ["state-stream-duality", "cqrs"],
      blocks: [
        {
          type: "problem",
          html: `<p>At 14:00 a deploy ships a currency-conversion bug that writes wrong prices into the <code>products</code> table; at 16:00 it is rolled back. Which rows did it touch, and what were their prices at 13:59? With update-in-place storage, nobody knows: each bad write destroyed the value it replaced. The only way back is last night's backup, which also discards every legitimate change made since midnight.</p>
<p>The same mutable table has to serve every read pattern at once (product pages, search, analytics), so the normalization argument of Chapter 2 never ends, and changing its schema means migrating a large table while it's live. Keeping every change instead fixes recovery and lets each reader have its own shape. But it raises two new questions: how big does the history get, and what do you do when the law says a person's data must truly be deleted from a log built never to forget?</p>`,
        },
        {
          type: "idea",
          html: `<p>Mutable state and an append-only log of changes are two views of the same data: current state is what you get by applying every change so far. Keep the log as the record and <strong>derive</strong> tables, caches and indexes from it. You gain recovery from bugs, an audit trail and many read-optimized views; you pay in storage, and deletion gets hard.</p>`,
        },
        {
          type: "text",
          html: `<h3>The duality of state and streams</h3>
<p>Every change to state is an event: a row is inserted, a price is updated, an item leaves a cart. Start from nothing, apply all the events in order, and you arrive at the current state. The book borrows a metaphor from calculus, with a warning not to push it too far: state is the <strong>integral</strong> of the change stream over time, and the change stream is the <strong>derivative</strong> of state with respect to time. A table shows one value of that integral, the one for this instant. The log is the whole function.</p>`,
        },
        {
          type: "diagram",
          title: "State as the integral of the change stream",
          svg: `<style>.dd-diagram-body svg.c11n{display:none}@media (max-width:600px){.dd-diagram-body svg.c11w{display:none}.dd-diagram-body svg.c11n{display:block}}</style><svg class="c11w" viewBox="0 0 640 236" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A change log with five events along a time axis. Snapshots of the table at three points in time are the result of applying every change up to that point.">
<defs><marker id="c11d2-int-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<text x="20" y="18" font-size="12" style="fill: var(--viz-muted)">change log (append-only), offsets 0 to 4</text>
<line x1="20" y1="70" x2="626" y2="70" stroke-width="1.5" style="stroke: var(--viz-muted)" marker-end="url(#c11d2-int-w)"/>
<text x="632" y="60" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">time</text>
<rect x="24" y="30" width="100" height="28" rx="6" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="74" y="49" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">set cat=1</text>
<rect x="140" y="30" width="100" height="28" rx="6" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="190" y="49" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">set dog=5</text>
<rect x="256" y="30" width="100" height="28" rx="6" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="306" y="49" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">set cat=2</text>
<rect x="372" y="30" width="100" height="28" rx="6" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="422" y="49" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">del dog</text>
<rect x="488" y="30" width="100" height="28" rx="6" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="538" y="49" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">set eel=7</text>
<line x1="74" y1="58" x2="74" y2="70" style="stroke: var(--viz-c7)"/><line x1="190" y1="58" x2="190" y2="70" style="stroke: var(--viz-c7)"/><line x1="306" y1="58" x2="306" y2="70" style="stroke: var(--viz-c7)"/><line x1="422" y1="58" x2="422" y2="70" style="stroke: var(--viz-c7)"/><line x1="538" y1="58" x2="538" y2="70" style="stroke: var(--viz-c7)"/>
<circle cx="248" cy="70" r="5" style="fill: var(--viz-c2); stroke: var(--viz-c2)"/><text x="248" y="88" font-size="12" text-anchor="middle" font-weight="700">t1</text>
<circle cx="480" cy="70" r="5" style="fill: var(--viz-c2); stroke: var(--viz-c2)"/><text x="480" y="88" font-size="12" text-anchor="middle" font-weight="700">t2</text>
<circle cx="600" cy="70" r="5" style="fill: var(--viz-c2); stroke: var(--viz-c2)"/><text x="600" y="88" font-size="12" text-anchor="middle" font-weight="700">t3</text>
<path d="M248,94 L205,116" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-c2)" marker-end="url(#c11d2-int-w)"/>
<path d="M480,94 L395,116" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-c2)" marker-end="url(#c11d2-int-w)"/>
<path d="M600,94 L570,116" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-c2)" marker-end="url(#c11d2-int-w)"/>
<text x="20" y="138" font-size="12" style="fill: var(--viz-muted)">apply every</text>
<text x="20" y="154" font-size="12" style="fill: var(--viz-muted)">change up to</text>
<text x="20" y="170" font-size="12" style="fill: var(--viz-muted)">this point</text>
<rect x="120" y="118" width="150" height="74" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="195" y="136" font-size="12" text-anchor="middle" font-weight="700">state at t1</text>
<line x1="130" y1="143" x2="260" y2="143" style="stroke: var(--viz-c2)"/>
<text x="195" y="162" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">cat = 1</text>
<text x="195" y="180" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">dog = 5</text>
<rect x="305" y="118" width="150" height="74" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="380" y="136" font-size="12" text-anchor="middle" font-weight="700">state at t2</text>
<line x1="315" y1="143" x2="445" y2="143" style="stroke: var(--viz-c2)"/>
<text x="380" y="162" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">cat = 2</text>
<text x="380" y="180" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">(dog deleted)</text>
<rect x="480" y="118" width="150" height="74" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="555" y="136" font-size="12" text-anchor="middle" font-weight="700">state at t3 (now)</text>
<line x1="490" y1="143" x2="620" y2="143" style="stroke: var(--viz-c2)"/>
<text x="555" y="162" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">cat = 2</text>
<text x="555" y="180" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">eel = 7</text>
<text x="20" y="224" font-size="12" font-weight="700">state(now) = ∫ changes dt, from 0 to now</text>
<text x="620" y="224" font-size="12" font-weight="700" text-anchor="end">change stream = d(state)/dt</text>
</svg><svg class="c11n" viewBox="0 0 360 336" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A change log with five events down a time axis. Snapshots of the table at three points in time are the result of applying every change up to that point.">
<defs><marker id="c11d2-int-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<text x="14" y="22" font-size="12" style="fill: var(--viz-muted)">change log</text>
<text x="150" y="22" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">time ↓</text>
<text x="268" y="22" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">table snapshots</text>
<line x1="150" y1="30" x2="150" y2="290" stroke-width="1.5" style="stroke: var(--viz-muted)" marker-end="url(#c11d2-int-n)"/>
<rect x="14" y="36" width="118" height="26" rx="6" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="73" y="53" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">set cat=1</text>
<rect x="14" y="70" width="118" height="26" rx="6" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="73" y="87" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">set dog=5</text>
<rect x="14" y="104" width="118" height="26" rx="6" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="73" y="121" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">set cat=2</text>
<rect x="14" y="138" width="118" height="26" rx="6" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="73" y="155" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">del dog</text>
<rect x="14" y="172" width="118" height="26" rx="6" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="73" y="189" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">set eel=7</text>
<line x1="132" y1="49" x2="150" y2="49" style="stroke: var(--viz-c7)"/><line x1="132" y1="83" x2="150" y2="83" style="stroke: var(--viz-c7)"/><line x1="132" y1="117" x2="150" y2="117" style="stroke: var(--viz-c7)"/><line x1="132" y1="151" x2="150" y2="151" style="stroke: var(--viz-c7)"/><line x1="132" y1="185" x2="150" y2="185" style="stroke: var(--viz-c7)"/>
<circle cx="150" cy="100" r="5" style="fill: var(--viz-c2); stroke: var(--viz-c2)"/><text x="162" y="118" font-size="12" font-weight="700">t1</text>
<circle cx="150" cy="168" r="5" style="fill: var(--viz-c2); stroke: var(--viz-c2)"/><text x="162" y="158" font-size="12" font-weight="700">t2</text>
<circle cx="150" cy="208" r="5" style="fill: var(--viz-c2); stroke: var(--viz-c2)"/><text x="162" y="204" font-size="12" font-weight="700">t3</text>
<path d="M156,102 L186,84" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-c2)" marker-end="url(#c11d2-int-n)"/>
<path d="M156,168 L186,165" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-c2)" marker-end="url(#c11d2-int-n)"/>
<path d="M156,210 L186,238" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-c2)" marker-end="url(#c11d2-int-n)"/>
<rect x="190" y="40" width="156" height="70" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="268" y="58" font-size="12" text-anchor="middle" font-weight="700">state at t1</text>
<text x="268" y="80" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">cat = 1</text>
<text x="268" y="98" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">dog = 5</text>
<rect x="190" y="128" width="156" height="70" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="268" y="146" font-size="12" text-anchor="middle" font-weight="700">state at t2</text>
<text x="268" y="168" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">cat = 2</text>
<text x="268" y="186" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">(dog deleted)</text>
<rect x="190" y="214" width="156" height="70" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="268" y="232" font-size="12" text-anchor="middle" font-weight="700">state at t3 (now)</text>
<text x="268" y="254" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">cat = 2</text>
<text x="268" y="272" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">eel = 7</text>
<text x="180" y="312" font-size="12" text-anchor="middle" font-weight="700">state(now) = ∫ changes dt, from 0 to now</text>
<text x="180" y="330" font-size="12" text-anchor="middle" font-weight="700">change stream = d(state)/dt</text>
</svg>`,
          caption: "Each table is the log replayed up to one moment: a cached value of the integral. The log itself is the full history, so any past state can be recomputed from it, but no table can tell you how it got the way it is.",
        },
        {
          type: "text",
          html: `<p>Seen this way, a database's tables are not the primary record but a cache: the log replayed up to its latest position, kept because replaying from scratch for every query would be absurdly slow. Pat Helland put it bluntly in <em>Immutability Changes Everything</em> (CIDR 2015): "The truth is the log." In his framing, the database caches a subset of the log, namely the newest value of each record. That is exactly what a <strong>log-compacted</strong> topic keeps, as the section on change data capture shows. A compacted log is a table written down as a stream; a full log is a table plus its entire history.</p>`,
        },
        {
          type: "analogy",
          title: "Accountants solved this centuries ago",
          html: `<p>A ledger is append-only. A bookkeeper who makes a mistake never erases it; they add a correcting entry, so the books show both the error and the fix. The balance sheet is derived by adding up the ledger, and is simply recomputed if an entry turns out to be wrong. The ledger is the event log, the balance sheet is the current state, and the correcting entry is a compensating event.</p>`,
        },
        {
          type: "text",
          html: `<h3>What keeping the history buys you</h3>
<p><strong>Recovery from bad code.</strong> If prices are derived from an append-only log, the 14:00 bug's events sit in that log with their offsets and timestamps. You can list exactly which products they touched and the price each had at 13:59, then append compensating events, or rebuild the view while skipping the bad range, and keep every legitimate change made since. Nothing was overwritten, so nothing has to be guessed.</p>
<p><strong>More information than the current state.</strong> A customer adds a blender to their cart and removes it ten minutes later. The cart is now identical to one where the blender never appeared, but the log remembers that the customer considered it: a signal a recommendation team wants, and one a mutable table throws away. Audits come for free too, because the log records how every value came to be.</p>`,
        },
        {
          type: "text",
          html: `<h3>One log, many read models (CQRS)</h3>
<p>Once state is derived, nothing forces you to derive only one. The log is shaped for writing: append a self-contained fact, durably. Readers want other shapes: a full-text index, a cache keyed by user, a columnar store, a graph. Separating the form in which data is written from the forms in which it is read is called <strong>command query responsibility segregation</strong> (CQRS). Each read model is another consumer of the log, with its own offset. The book's examples: Druid ingesting straight from Kafka, Pistachio (a key-value store that uses Kafka as its commit log), and Kafka Connect sinks exporting topics into databases and indexes.</p>
<p>The big practical win is schema evolution. To restructure the orders view, don't migrate a large live table in place: start a consumer at offset 0 that builds the new view beside the old one, move readers over once it has caught up, and retire the old view when nobody uses it. If the new view is wrong, readers switch back.</p>
<p>It also defuses the normalization debate. Denormalized copies are risky when application code must keep each in step, but safe when every copy is rebuilt mechanically from the same log. Twitter's home timelines (Chapter 1) are such a denormalized cache.</p>`,
        },
        {
          type: "diagram",
          title: "One log, many read models",
          svg: `<style>.dd-diagram-body svg.c11n{display:none}@media (max-width:600px){.dd-diagram-body svg.c11w{display:none}.dd-diagram-body svg.c11n{display:block}}</style><svg class="c11w" viewBox="0 0 640 244" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="An event log on the left feeds four read models on the right: a search index, a cache keyed by user, a columnar analytics store and a relationship graph. The graph is new and is being built by replaying from offset zero.">
<defs><marker id="c11d2-cqrs-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c2)"/></marker></defs>
<text x="95" y="20" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">write-optimized</text>
<text x="510" y="20" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">read-optimized</text>
<rect x="20" y="74" width="150" height="110" rx="10" stroke-width="1.6" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="95" y="96" font-size="13" text-anchor="middle" font-weight="700">Event log</text>
<text x="95" y="113" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">source of truth</text>
<rect x="32" y="126" width="18" height="20" rx="3" style="fill: var(--viz-c7); stroke: var(--viz-c7)"/><rect x="52" y="126" width="18" height="20" rx="3" style="fill: var(--viz-c7); stroke: var(--viz-c7)"/><rect x="72" y="126" width="18" height="20" rx="3" style="fill: var(--viz-c7); stroke: var(--viz-c7)"/><rect x="92" y="126" width="18" height="20" rx="3" style="fill: var(--viz-c7); stroke: var(--viz-c7)"/><rect x="112" y="126" width="18" height="20" rx="3" style="fill: var(--viz-c7); stroke: var(--viz-c7)"/><rect x="132" y="126" width="18" height="20" rx="3" stroke-dasharray="3 2" style="fill: none; stroke: var(--viz-c7)"/>
<text x="95" y="170" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">append only</text>
<path d="M172,129 L396,51" stroke-width="1.6" style="fill: none; stroke: var(--viz-c2)" marker-end="url(#c11d2-cqrs-w)"/>
<path d="M172,129 L396,101" stroke-width="1.6" style="fill: none; stroke: var(--viz-c2)" marker-end="url(#c11d2-cqrs-w)"/>
<path d="M172,129 L396,151" stroke-width="1.6" style="fill: none; stroke: var(--viz-c2)" marker-end="url(#c11d2-cqrs-w)"/>
<path d="M172,129 L396,201" stroke-width="1.6" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-c2)" marker-end="url(#c11d2-cqrs-w)"/>
<rect x="400" y="32" width="220" height="38" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="510" y="56" font-size="12" text-anchor="middle">Full-text search index</text>
<rect x="400" y="82" width="220" height="38" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="510" y="106" font-size="12" text-anchor="middle">Cache keyed by user</text>
<rect x="400" y="132" width="220" height="38" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="510" y="156" font-size="12" text-anchor="middle">Analytics (columnar)</text>
<rect x="400" y="182" width="220" height="40" rx="8" stroke-width="1.5" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-c2)"/>
<text x="510" y="198" font-size="12" text-anchor="middle">Graph of relationships</text>
<text x="510" y="214" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">new: replaying from offset 0</text>
<text x="285" y="238" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">each view is a consumer with its own offset</text>
</svg><svg class="c11n" viewBox="0 0 360 252" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="An event log on the left feeds four read models on the right: a search index, a cache keyed by user, a columnar analytics store and a relationship graph. The graph is new and is being built by replaying from offset zero.">
<defs><marker id="c11d2-cqrs-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c2)"/></marker></defs>
<text x="59" y="20" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">write-optimized</text>
<text x="248" y="20" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">read-optimized</text>
<rect x="14" y="34" width="90" height="178" rx="10" stroke-width="1.6" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="59" y="56" font-size="13" text-anchor="middle" font-weight="700">Event log</text>
<text x="59" y="73" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">source of</text>
<text x="59" y="88" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">truth</text>
<rect x="34" y="100" width="50" height="14" rx="3" style="fill: var(--viz-c7); stroke: var(--viz-c7)"/><rect x="34" y="116" width="50" height="14" rx="3" style="fill: var(--viz-c7); stroke: var(--viz-c7)"/><rect x="34" y="132" width="50" height="14" rx="3" style="fill: var(--viz-c7); stroke: var(--viz-c7)"/><rect x="34" y="148" width="50" height="14" rx="3" style="fill: var(--viz-c7); stroke: var(--viz-c7)"/><rect x="34" y="164" width="50" height="14" rx="3" style="fill: var(--viz-c7); stroke: var(--viz-c7)"/><rect x="34" y="180" width="50" height="14" rx="3" stroke-dasharray="3 2" style="fill: none; stroke: var(--viz-c7)"/>
<path d="M106,123 L146,54" stroke-width="1.6" style="fill: none; stroke: var(--viz-c2)" marker-end="url(#c11d2-cqrs-n)"/>
<path d="M106,123 L146,100" stroke-width="1.6" style="fill: none; stroke: var(--viz-c2)" marker-end="url(#c11d2-cqrs-n)"/>
<path d="M106,123 L146,146" stroke-width="1.6" style="fill: none; stroke: var(--viz-c2)" marker-end="url(#c11d2-cqrs-n)"/>
<path d="M106,123 L146,192" stroke-width="1.6" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-c2)" marker-end="url(#c11d2-cqrs-n)"/>
<rect x="150" y="34" width="196" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="248" y="58" font-size="12" text-anchor="middle">Full-text search index</text>
<rect x="150" y="80" width="196" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="248" y="104" font-size="12" text-anchor="middle">Cache keyed by user</text>
<rect x="150" y="126" width="196" height="40" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="248" y="150" font-size="12" text-anchor="middle">Analytics (columnar)</text>
<rect x="150" y="172" width="196" height="40" rx="8" stroke-width="1.5" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-c2)"/>
<text x="248" y="188" font-size="12" text-anchor="middle">Graph of relationships</text>
<text x="248" y="204" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">new: replaying from 0</text>
<text x="180" y="238" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">each view is a consumer with its own offset</text>
</svg>`,
          caption: "The CQRS split: one write-optimized log, many read-optimized views. Adding a view means starting another consumer at offset 0; the old views keep serving until the new one has caught up, and are retired once nobody reads them.",
        },
        {
          type: "text",
          html: `<h3>The catch: views lag the log</h3>
<p>The biggest downside of event sourcing and CDC is that log consumers usually run asynchronously. A user who saves a change and immediately reloads may read a view that hasn't seen their event: Chapter 5's read-your-writes problem, now between a log and its views. You can update the view synchronously, in the same transaction as the append; that's easy when both live in one storage system, and otherwise needs a distributed transaction (Chapter 9) or total order broadcast.</p>
<p>In other ways the log simplifies concurrency. An action that would touch several rows, and so need a multi-object transaction (Chapter 7), can be one self-contained event, such as an <code>OrderPlaced</code> carrying every line item, and one append is easy to make atomic. And if the log and the state are partitioned the same way, a single-threaded consumer per partition needs no concurrency control for writes at all: Chapter 7's actual serial execution, applied to a log.</p>`,
        },
        {
          type: "text",
          html: `<h3>The limits of immutability</h3>
<p>Immutability is common even without event sourcing: MVCC keeps old row versions, copy-on-write B-trees never overwrite a page, version control never rewrites a commit. But keeping <em>everything</em> forever suits only some workloads. A small dataset updated and deleted at a high rate, such as a session store, produces a history far larger than its current state; fragmentation sets in, and compaction and garbage collection become essential.</p>
<p>And some data must truly disappear: personal data after a user closes their account, incorrect data that the law says must be removed, a secret leaked into the log by accident. A <code>UserDeleted</code> event changes nothing, since the original events remain. You must rewrite history as if the data had never been written: Datomic calls this <strong>excision</strong>, the Fossil version control system <strong>shunning</strong>. Even then, copies live on in views, caches, replicas and (often deliberately immutable) backups, and filesystems and SSDs tend to write to fresh locations rather than overwrite. In practice, deleting means making the data very hard to get back, not physically impossible to recover.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          title: "Since the book: GDPR and the right to erasure",
          html: `<p>The EU's General Data Protection Regulation took effect on 25 May 2018, and its Article 17 gives people a right to erasure of their personal data. That made the deletion problem concrete for every event-sourced and log-based system. Three responses are common:</p>
<ul>
<li><strong>Keep personal data out of events.</strong> Events carry an opaque user ID; names, emails and addresses live in an ordinary store where a row can be deleted.</li>
<li><strong>Crypto-shredding.</strong> Encrypt each person's data with a per-person key. Deleting the key makes every copy unreadable at once, including copies in backups and replicas.</li>
<li><strong>Tombstones on compacted topics.</strong> For a keyed Kafka topic, writing a null value for the key lets log compaction remove the earlier values, eventually, which may or may not satisfy your deadline.</li>
</ul>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Datomic",
              tag: "excision",
              html: "An immutable database that keeps every past fact, so you can query it as of any point in time. Because history is never rewritten in normal operation, it offers excision as a separate administrative operation that permanently removes data, for cases such as legal deletion requirements.",
            },
            {
              org: "Fossil SCM",
              tag: "shunning",
              html: "Fossil's shunning permanently removes specific artifacts from a repository and stops them from being synced back in from other copies: a deliberate escape hatch in an otherwise append-only history.",
            },
            {
              org: "Apache Druid",
              tag: "read model from a log",
              html: "Druid can ingest directly from Kafka topics through its Kafka indexing service, building queryable analytical segments: one of many read-optimized views that can be fed from the same log.",
            },
          ],
        },
        {
          type: "tradeoffs",
          title: "The immutable log as the record, compared with mutable state as the record",
          prosLabel: "What the log buys",
          consLabel: "What it costs",
          pros: [
            "A bad deploy can be pinpointed and undone: its writes sit in the log with offsets and timestamps",
            "Many read models from one source, each in the shape its readers need",
            "Schema changes become side-by-side rebuilds instead of in-place migrations of a live table",
            "Denormalized copies are safe, because they are rebuilt mechanically rather than kept in step by hand",
          ],
          cons: [
            "History can dwarf current state for high-churn data; compaction and garbage collection become critical",
            "Every view lags the log, so read-your-writes needs extra work",
            "Rebuilding a view from offset 0 can take hours on a large log",
            "True deletion needs excision or crypto-shredding, plus a deletion path for every derived copy",
          ],
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: a deletion request in an event-sourced system",
          html: `<p>Two weak answers come up often: "append a delete event" (the data is still in the log) and "we never delete" (not an option under privacy law). A strong answer layers the fix. Design events to carry an opaque user ID, with personal data in a separate store where it can be deleted. Where personal data must appear in events, encrypt it with a per-user key and delete the key. Then account for the copies: every derived view, cache and search index holds its own, so each needs a deletion path. Backups need an expiry policy, or are covered by shredding keys. Mention that tombstones and compaction work for keyed topics, but only eventually, and only for data stored as the latest value of a key.</p>`,
        },
        {
          type: "quiz",
          q: "Your team wants to restructure the <code>orders</code> read model with new denormalized fields. The source of truth is an event log. What is the lowest-risk way to make the change?",
          options: [
            "Run an in-place <code>ALTER TABLE</code> and backfill the live read model",
            "Build a new read model by replaying the log from the beginning alongside the old one, move readers over once it has caught up, then retire the old one",
            "Delete the event log and start fresh with the new schema",
            "Use log compaction to rewrite old events into the new schema",
          ],
          answer: 1,
          explain: "Because the read model is derived, you can create a second derivation side by side and migrate readers gradually, with an easy rollback: the old view still exists. The in-place migration is the tempting choice, but it is exactly the risky operation on a large live table that derived views let you avoid. Deleting the log destroys the record you derive from, and compaction only keeps the latest value per key; it doesn't transform schemas.",
        },
      ],
    },

    // ───────────────────────────────────────────────────────────── 7
    {
      id: "processing-streams",
      title: "What stream processors do: alerts, analytics, views and search",
      kicker: "Processing streams",
      concepts: ["complex-event-processing", "stream-analytics"],
      blocks: [
        {
          type: "problem",
          html: `<p>The events are flowing through a log. Now what? The tools of Chapter 10 don't carry over unchanged. A stream never ends, so you can't sort it, and the sort-merge join that batch jobs rely on is off the table. "If a task fails, rerun it from the start" is not a recovery plan for a job that has been running for two years.</p>
<p>The questions change too. A batch job answers "scan the stored data and give me the answer once". A fraud team asks "tell me <em>every time</em> a card is used in two countries within an hour". A database is the wrong shape for that: it stores data and runs short-lived queries against it, so watching for a pattern means re-running the same query every few seconds and hoping nothing slips through between runs.</p>`,
        },
        {
          type: "idea",
          html: `<p>Stream processing turns the database relationship inside out: the <strong>queries are long-lived and stored</strong> (patterns, aggregations, view definitions, saved searches) and the <strong>data flows past them</strong>. The operators look like batch operators, but they work incrementally on unbounded input and keep state between events.</p>`,
        },
        {
          type: "compare",
          title: "Three things you can do with a stream",
          items: [
            {
              title: "Write it to a store",
              tone: "info",
              html: "<p>Put the events into a database, cache, search index or warehouse, where other clients query them. This is how a search index or cache stays in sync with the system of record.</p>",
            },
            {
              title: "Push it to people",
              tone: "info",
              html: "<p>Send an email alert or a push notification, or update a live dashboard. Here the consumer is a human being.</p>",
            },
            {
              title: "Turn it into new streams",
              tone: "ok",
              html: "<p>Consume one or more input streams and produce one or more output streams, possibly through a pipeline of stages. This is stream processing proper; the code is called an <strong>operator</strong> or a <strong>job</strong>.</p>",
            },
          ],
        },
        {
          type: "text",
          html: `<h3>What carries over from batch, and what doesn't</h3>
<p>A stream processor follows the same dataflow discipline as Unix pipes and MapReduce jobs (Chapter 10): it reads its input without modifying it and appends its output somewhere else. Partitioning and parallelism work the same way, with a job running as many tasks that each consume some partitions of the input. Stateless operations such as transforming or filtering records are identical to their batch versions.</p>
<p>Two things change fundamentally. <strong>Sorting is meaningless</strong> on unbounded input, so sort-merge joins are out; streaming joins keep indexed state instead, as the section on joins shows. And <strong>fault tolerance</strong> can't mean "restart from the beginning and discard the partial output", because output has to be visible while the job runs; the final section shows what replaces it.</p>
<p>Streams have long been used wherever delay is expensive: fraud detection (has this card's usage pattern changed?), trading (does this price move match a rule?), manufacturing (is a machine on the line malfunctioning?) and military and intelligence systems watching for signs of an attack.</p>`,
        },
        {
          type: "diagram",
          title: "The inverted relationship",
          svg: `<style>.dd-diagram-body svg.c11n{display:none}@media (max-width:600px){.dd-diagram-body svg.c11w{display:none}.dd-diagram-body svg.c11n{display:block}}</style><svg class="c11w" viewBox="0 0 640 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Left: a database stores data and runs a query once. Right: a stream processor stores queries, events flow through them, and a match emits a complex event.">
<defs><marker id="c11d2-inv-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="10" y="10" width="300" height="190" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="24" y="32" font-size="13" font-weight="700">Database</text>
<text x="24" y="50" font-size="12" style="fill: var(--viz-muted)">data is stored; queries come and go</text>
<rect x="24" y="96" width="78" height="32" rx="6" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="63" y="117" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">SELECT …</text>
<path d="M104,112 L126,112" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-inv-w)"/>
<path d="M130,80 L130,144 A40,10 0 0 0 210,144 L210,80" stroke-width="1.6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<ellipse cx="170" cy="80" rx="40" ry="10" stroke-width="1.6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="170" y="112" font-size="12" text-anchor="middle">stored</text>
<text x="170" y="128" font-size="12" text-anchor="middle">data</text>
<path d="M212,112 L232,112" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-inv-w)"/>
<rect x="236" y="96" width="62" height="32" rx="6" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="267" y="117" font-size="12" text-anchor="middle">result</text>
<text x="160" y="182" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">the query runs once, then it's gone</text>
<rect x="330" y="10" width="300" height="190" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="344" y="32" font-size="13" font-weight="700">Stream processor</text>
<text x="344" y="50" font-size="12" style="fill: var(--viz-muted)">queries are stored; data flows past</text>
<text x="380" y="92" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">events</text>
<line x1="340" y1="108" x2="418" y2="108" stroke-width="1.5" style="stroke: var(--viz-c6)"/>
<circle cx="350" cy="108" r="5" style="fill: var(--viz-c6)"/><circle cx="368" cy="108" r="5" style="fill: var(--viz-c6)"/><circle cx="386" cy="108" r="5" style="fill: var(--viz-c6)"/><circle cx="404" cy="108" r="5" style="fill: var(--viz-c6)"/>
<rect x="420" y="66" width="150" height="84" rx="8" stroke-width="1.6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="495" y="84" font-size="12" text-anchor="middle" font-weight="700">stored queries</text>
<text x="495" y="104" font-size="12" text-anchor="middle">Q1: pattern</text>
<text x="495" y="121" font-size="12" text-anchor="middle">Q2: rolling average</text>
<text x="495" y="138" font-size="12" text-anchor="middle">Q3: saved search</text>
<line x1="572" y1="108" x2="624" y2="108" stroke-width="1.5" style="stroke: var(--viz-c6)" marker-end="url(#c11d2-inv-w)"/>
<circle cx="584" cy="108" r="5" style="fill: var(--viz-c6)"/><circle cx="600" cy="108" r="5" style="fill: var(--viz-c6)"/>
<path d="M495,152 L495,164" stroke-width="1.6" style="fill: none; stroke: var(--viz-bad)" marker-end="url(#c11d2-inv-w)"/>
<rect x="407" y="168" width="176" height="24" rx="12" stroke-width="1.5" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="495" y="184" font-size="12" text-anchor="middle">match → emit complex event</text>
</svg><svg class="c11n" viewBox="0 0 360 380" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top: a database stores data and runs a query once. Bottom: a stream processor stores queries, events flow through them, and a match emits a complex event.">
<defs><marker id="c11d2-inv-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="10" y="10" width="340" height="160" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="24" y="32" font-size="13" font-weight="700">Database</text>
<text x="24" y="50" font-size="12" style="fill: var(--viz-muted)">data is stored; queries come and go</text>
<rect x="24" y="90" width="78" height="32" rx="6" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="63" y="111" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">SELECT …</text>
<path d="M104,106 L136,106" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-inv-n)"/>
<path d="M140,76 L140,136 A40,10 0 0 0 220,136 L220,76" stroke-width="1.6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<ellipse cx="180" cy="76" rx="40" ry="10" stroke-width="1.6" style="fill: var(--viz-c1-soft); stroke: var(--viz-c1)"/>
<text x="180" y="106" font-size="12" text-anchor="middle">stored</text>
<text x="180" y="122" font-size="12" text-anchor="middle">data</text>
<path d="M222,106 L254,106" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-inv-n)"/>
<rect x="258" y="90" width="78" height="32" rx="6" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="297" y="111" font-size="12" text-anchor="middle">result</text>
<text x="180" y="162" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">the query runs once, then it's gone</text>
<rect x="10" y="184" width="340" height="186" rx="12" style="fill: var(--viz-panel); stroke: var(--viz-line)"/>
<text x="24" y="206" font-size="13" font-weight="700">Stream processor</text>
<text x="24" y="224" font-size="12" style="fill: var(--viz-muted)">queries are stored; data flows past</text>
<text x="66" y="266" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">events</text>
<line x1="20" y1="280" x2="118" y2="280" stroke-width="1.5" style="stroke: var(--viz-c6)"/>
<circle cx="36" cy="280" r="5" style="fill: var(--viz-c6)"/><circle cx="54" cy="280" r="5" style="fill: var(--viz-c6)"/><circle cx="72" cy="280" r="5" style="fill: var(--viz-c6)"/><circle cx="90" cy="280" r="5" style="fill: var(--viz-c6)"/><circle cx="108" cy="280" r="5" style="fill: var(--viz-c6)"/>
<rect x="120" y="238" width="150" height="84" rx="8" stroke-width="1.6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="195" y="256" font-size="12" text-anchor="middle" font-weight="700">stored queries</text>
<text x="195" y="276" font-size="12" text-anchor="middle">Q1: pattern</text>
<text x="195" y="293" font-size="12" text-anchor="middle">Q2: rolling average</text>
<text x="195" y="310" font-size="12" text-anchor="middle">Q3: saved search</text>
<line x1="272" y1="280" x2="340" y2="280" stroke-width="1.5" style="stroke: var(--viz-c6)" marker-end="url(#c11d2-inv-n)"/>
<circle cx="288" cy="280" r="5" style="fill: var(--viz-c6)"/><circle cx="306" cy="280" r="5" style="fill: var(--viz-c6)"/>
<path d="M195,324 L195,334" stroke-width="1.6" style="fill: none; stroke: var(--viz-bad)" marker-end="url(#c11d2-inv-n)"/>
<rect x="107" y="338" width="176" height="24" rx="12" stroke-width="1.5" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="195" y="354" font-size="12" text-anchor="middle">match → emit complex event</text>
</svg>`,
          caption: "Databases keep the data and let queries pass through once; stream processors keep the queries and let the data run past. CEP engines, analytics jobs, view maintainers and percolators all have the right-hand shape.",
        },
        {
          type: "compare",
          title: "Four kinds of stream processing",
          items: [
            {
              title: "Complex event processing",
              html: "<p><strong>Patterns over sequences</strong>, like a regular expression over events. Example: three failed logins for one account within 60 seconds, then a success from a new country. Engines: Esper, IBM InfoSphere Streams, Apama, TIBCO StreamBase, SQLstream.</p>",
            },
            {
              title: "Stream analytics",
              html: "<p><strong>Aggregates over many events</strong>: errors per minute, a rolling five-minute average latency, today's sign-ups against the same hour last week. Frameworks: Storm, Spark Streaming, Flink, Concord, Samza, Kafka Streams; hosted: Google Cloud Dataflow, Azure Stream Analytics.</p>",
            },
            {
              title: "Materialized views",
              html: "<p><strong>A derived dataset kept up to date</strong>: a cache, a search index, a warehouse table, event-sourced application state. Needs every event since the beginning, not a recent window. Samza and Kafka Streams build this on log compaction.</p>",
            },
            {
              title: "Search on streams",
              html: "<p><strong>Stored searches matched against each new document</strong>: media monitoring for mentions of a company, or alerting a home buyer when a listing matches their saved search. Elasticsearch's percolator does this.</p>",
            },
          ],
        },
        {
          type: "text",
          html: `<h3>How each one works</h3>
<p><strong>Complex event processing</strong> (CEP) dates from the 1990s. You describe a pattern in an SQL-like language or a graphical tool and submit it to the engine, which keeps it indefinitely. As events stream in, the engine tracks partial matches; when one completes, it emits a <em>complex event</em> describing what it found, such as "possible account takeover: user 4411". This is the inverted relationship in its purest form: the queries are the long-lived data, and the events are transient.</p>
<p><strong>Stream analytics</strong> overlaps with CEP but cares less about particular sequences and more about numbers: how often something happens per interval, a rolling average, a comparison with the previous interval to spot a trend or flag an unusual value. These numbers are computed over spans of time called windows, which are subtle enough to get the whole next section.</p>
<p><strong>View maintenance</strong> is the deriving of read models from the section on state and immutability. Its time horizon is the difference: a product search index has to reflect every product ever written, not the last five minutes, so its state reaches back to the start of the log (minus superseded versions that compaction removes).</p>
<p><strong>Search on streams</strong> flips full-text search around. Normally documents are indexed and queries come and go; here the queries are stored and each new document is run against them. With millions of saved searches, testing every document against every query is too slow, so the queries themselves are indexed to narrow down which ones could match.</p>
<h3>Approximation is an optimization, not the point</h3>
<p>Analytics engines sometimes use probabilistic structures: Bloom filters for "have I seen this before?" (Chapter 3), HyperLogLog for counting distinct values, sketches for percentiles. They answer within a known error using a small, fixed amount of memory. That has fed a myth that stream processing is inherently lossy or inexact. It isn't: exact counts, joins and views are the norm, and approximation is a choice you make when memory matters more than the last fraction of a percent.</p>
<h3>Not every message is a stream</h3>
<p>Actor frameworks such as Akka and Erlang/OTP also pass messages (Chapter 4), but they mainly solve concurrency and the distributed execution of communicating modules; stream processing is a data management technique. Actor messages are usually ephemeral and sent to one recipient, while event logs are durable and multi-subscriber. Actors may talk in any pattern, including cycles of requests and responses; stream processors are normally wired into acyclic pipelines in which every stream is the output of one particular job. The line blurs a little: Apache Storm, for instance, has a distributed RPC feature.</p>`,
        },
        {
          type: "callout",
          tone: "insight",
          title: "State is what makes it hard",
          html: `<p>Filters and maps are stateless and trivially parallel. Nearly everything else in this section is not: a CEP engine holds partial matches, analytics holds per-window counters, a view holds the entire derived dataset, and a join holds recent events or a copy of a table. Lose that state in a crash, or apply an event to it twice, and the answers are wrong. The section on fault tolerance is about exactly this.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Esper",
              tag: "CEP",
              html: "An open-source CEP engine whose Event Processing Language (EPL) is SQL-like, with pattern operators and time windows. Statements are registered once and evaluated continuously against incoming events.",
            },
            {
              org: "Redis HyperLogLog",
              tag: "approximate counting",
              html: "<code>PFADD</code> and <code>PFCOUNT</code> estimate the number of distinct elements with a standard error of 0.81% using at most 12 KB per key: counting unique visitors on a stream without storing every visitor ID.",
            },
            {
              org: "Elasticsearch percolator",
              tag: "search on streams",
              html: "Stores queries as documents in an index; a percolate query takes a new document and returns the stored queries that match it. This reverse search powers alerts on new content.",
            },
            {
              org: "Apache Storm and its successors",
              year: "2011–2019",
              html: "Storm was created by Nathan Marz at BackType and open-sourced by Twitter in 2011, after Twitter acquired BackType. Twitter later replaced it internally with Heron (announced 2015). Apache Flink has since become one of the most widely used engines for stateful stream processing; Alibaba acquired data Artisans, the company founded by Flink's creators (now Ververica), in January 2019.",
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Since the book: streaming SQL and incremental views",
          html: `<p>Much stream processing is now written in SQL. Flink SQL, ksqlDB (Confluent's SQL layer over Kafka Streams, announced as KSQL in 2017) and streaming databases such as Materialize and RisingWave let you declare a query and keep its result incrementally up to date as events arrive; in Materialize and RisingWave it is literally <code>CREATE MATERIALIZED VIEW … AS SELECT …</code>. That is the stored-query idea taken to its conclusion. In Spark, Structured Streaming (Spark 2.x) replaced the original DStream API as the recommended way to write streaming jobs, and new projects mostly choose Flink, Kafka Streams or Spark over Storm.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: classify the requirement first",
          html: `<p>When an interviewer says "we need this in real time", ask which of the four shapes it is, because each implies a different design. "Alert when a card is used in two countries within an hour" is a <strong>pattern</strong>: keyed state with a timeout. "Show the error rate per minute" is <strong>analytics</strong>: a windowed aggregate, which means talking about event time and late data. "Keep the search index in sync with the product database" is <strong>view maintenance</strong>: CDC into a consumer that needs the full history and a snapshot to start from. "Notify users when a listing matches their saved search" is <strong>search on streams</strong>: indexed stored queries. Naming the shape, then the state it needs, is what turns a list of technologies into a design.</p>`,
        },
        {
          type: "quiz",
          q: "Which task needs state that reaches back over the whole history of a stream, rather than a recent window?",
          options: [
            "Alert when a sensor's 5-minute rolling average exceeds 90 °C",
            "Count page views per minute",
            "Maintain a search index of all products, updated from the product table's change stream",
            "Detect three failed logins for the same account within 60 seconds",
          ],
          answer: 2,
          explain: "A materialized view must reflect every product ever written (minus superseded versions), so its state covers the entire history, which is why it is built on compacted logs or an initial snapshot. The rolling average, the per-minute count and the login pattern only need events inside their window; the login pattern is tempting because it feels like 'security history', but 60 seconds of state per account is enough.",
        },
      ],
    },

    // ───────────────────────────────────────────────────────────── 8
    {
      id: "reasoning-about-time",
      title: "Whose clock is it? Event time, stragglers and watermarks",
      kicker: "Processing streams",
      concepts: ["event-time-vs-processing-time", "windowing", "watermark"],
      blocks: [
        {
          type: "problem",
          html: `<p>"Orders per minute", "average latency over the last five minutes": stream analytics is full of time. A batch job crunching a year of logs uses the timestamps inside the events; the clock of the machine running it is irrelevant. Many stream frameworks instead read the processing machine's local clock (<strong>processing time</strong>) to pick an event's window. That's fine as long as every event is processed moments after it happens.</p>
<p>Often it isn't. Events wait in queues, networks hiccup, consumers restart, a bug fix means reprocessing last week, and mobile apps hold events for hours while a phone is offline. Count by processing time and a consumer that was down for a minute reports a dip, then a spike that never happened. Switching to <strong>event time</strong> files every event under the minute it really happened, but raises a harder question: if events arrive late and out of order, when can you ever say a minute is finished?</p>`,
        },
        {
          type: "idea",
          html: `<p>Assign events to windows by when they happened (<strong>event time</strong>). Because you can never be sure a window is complete, track a <strong>watermark</strong>, a heuristic claim that no more events older than T are expected, and emit a window when the watermark passes its end. Then decide, explicitly, what happens to stragglers that arrive after that.</p>`,
        },
        {
          type: "analogy",
          title: "Release order and story order",
          html: `<p>The Star Wars films came out as Episodes IV, V and VI (1977, 1980, 1983), then I, II and III (1999, 2002, 2005), then VII (2015). Watching them in release order is processing time; the story unfolds in event time, starting with Episode I. Viewers rebuild the timeline without thinking about it. A stream processor won't: its algorithms have to handle timing and ordering explicitly.</p>`,
        },
        {
          type: "text",
          html: `<h3>Two clocks, drifting apart</h3>
<p>Every event has an event time, when it happened at its source, and a processing time, when a particular operator handles it. The gap between them (buffering, network, broker, backlog) isn't constant, and it doesn't preserve order: a log keeps order within a partition, but events from different partitions or producers have no order relative to each other, so a processor routinely sees an event from 10:00:05 after one from 10:00:09.</p>
<p>Confusing the clocks produces wrong data, not just late data. Take a service handling a steady 1,000 requests per second (illustrative numbers). The job computing the rate restarts and is down for a minute; when it comes back, it races through the backlog. By processing time, the rate shows a minute near zero followed by a minute at roughly double. The real rate never moved, but the dashboard pages someone anyway. Event time also makes reprocessing honest: replaying last month at a hundred times real speed gives the same answers as processing it live only if windows are defined on event time.</p>
<p>The visualization plays six minutes of orders from a mobile app. The top row shows when each order happened, the second when it reached the processor. Most delays are a few seconds, but three stragglers take 90 to 110 seconds, and you can add an offline phone that uploads six orders at once. Below, windows count orders per minute (or, with Window set to Hopping, two-minute windows that start every minute) and change color as they are emitted, miss late events, or are corrected.</p>`,
        },
        {
          type: "viz",
          id: "ch11/event-time-windows",
          title: "Event time, watermarks and late events",
          caption: "Try switching Count by to Processing time and comparing each window with its true count: delayed orders land in the minute they arrived, not the minute they happened. Back in event time, drag Watermark delay from 20 s to 100 s and notice the dropped stragglers disappear while Avg result delay climbs past 100 s. Press Phone was offline: no sensible delay saves those orders, so switch Late events to Update result and watch windows turn blue, correct but emitted more than once. Set the delay to 0 to see even ordinary orders arrive late, and press Play to watch the watermark advance and windows fire.",
        },
        {
          type: "text",
          html: `<h3>Knowing when a window is complete</h3>
<p>In the default run, the three stragglers arrived after their windows had been emitted. That is the core difficulty of event time: you can never be sure you've seen every event for a window, because a straggler held up by a network interruption can always arrive later. So you need a policy, and there are two:</p>
<ol>
<li><strong>Drop it.</strong> Stragglers are usually a small fraction. Count the dropped events as a metric and alert when the count grows: something upstream is delaying data.</li>
<li><strong>Publish a correction.</strong> Emit an updated value for the window, stragglers included. Downstream consumers must cope with a changed result, as an upsert or as a retraction followed by the new value.</li>
</ol>
<p>Rather than guess window by window, systems track a <strong>watermark</strong>. The book's version of the idea is a special message from a producer promising no more messages with a timestamp earlier than t, which consumers use to trigger windows. With many producers, consumers must track each one's threshold separately, which makes adding and removing producers awkward. The name was popularized by Google's MillWheel (its "low watermarks") and the Dataflow model that followed; earlier stream research used similar in-band markers called punctuations.</p>
<h3>How engines compute watermarks</h3>
<p>In Flink and Apache Beam, a common <strong>heuristic watermark</strong> is the largest event time seen so far minus a fixed allowance for out-of-order arrival, say 20 seconds. Watermarks flow through the dataflow with the events, and an operator with several inputs takes the <em>minimum</em> of their watermarks, so one idle or slow partition holds back every window downstream (Flink can mark idle sources to prevent this). A window fires when the watermark passes its end; when a bounded input runs out, the watermark jumps to infinity, flushing every remaining window.</p>
<p>The allowance is a dial between latency and completeness, as the slider showed. Only a <strong>perfect watermark</strong>, built from complete knowledge of the input, never meets late data. Every heuristic watermark is a bet, and the straggler policy is what you do when you lose it.</p>`,
        },
        {
          type: "tradeoffs",
          title: "Choosing the watermark delay",
          prosLabel: "A short delay buys",
          consLabel: "A short delay costs",
          pros: [
            "Results seconds after each window ends, so dashboards and alerts feel live",
            "Little state held open: windows close and are freed quickly",
          ],
          cons: [
            "More events arrive after their window fired and must be dropped or corrected",
            "Corrections ripple downstream as upserts or retractions every consumer must handle",
            "Ordinary jitter, not just real stragglers, starts counting as late",
          ],
        },
        {
          type: "text",
          html: `<h3>Whose clock are you using?</h3>
<p>Event time is only as good as the clock that stamped it. A phone's clock may be off by minutes or years, by accident or on purpose (winding it forward to cheat a game timer), and Chapter 8's warnings about clock skew apply in full to a device you don't control. The book's remedy is to log <strong>three timestamps</strong> per event: when it occurred, by the device clock; when the device sent it, by the device clock; and when the server received it, by the server clock.</p>
<p>The difference between the last two estimates the device clock's offset from the server's, assuming network delay is small compared with the accuracy you need. Add that offset to the first timestamp and you have the event time on the server's clock: the device's error is the same in both of its readings, so measuring it once corrects the other. Batch jobs over the same events face the same problem; it's just easier to ignore.</p>`,
        },
        {
          type: "diagram",
          title: "Correcting a device clock with three timestamps",
          svg: `<style>.dd-diagram-body svg.c11n{display:none}@media (max-width:600px){.dd-diagram-body svg.c11w{display:none}.dd-diagram-body svg.c11n{display:block}}</style><svg class="c11w" viewBox="0 0 640 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Device clock and server clock timelines. The device records the event at 09:00:00 and sends it at 09:40:00 by its own clock; the server receives it at 09:45:02. The offset of about five minutes, added to the event timestamp, gives the true event time of about 09:05:02.">
<defs><marker id="c11d2-ts-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker><marker id="c11d2-ts-w1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker></defs>
<text x="14" y="64" font-size="12" font-weight="700">device clock</text>
<line x1="130" y1="60" x2="620" y2="60" stroke-width="2" style="stroke: var(--viz-c5)"/>
<text x="14" y="154" font-size="12" font-weight="700">server clock</text>
<line x1="130" y1="150" x2="620" y2="150" stroke-width="2" style="stroke: var(--viz-c1)"/>
<circle cx="177" cy="60" r="6" style="fill: var(--viz-c5)"/>
<text x="177" y="28" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">event occurred</text>
<text x="177" y="46" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">t1 = 09:00:00</text>
<circle cx="553" cy="60" r="6" style="fill: var(--viz-c5)"/>
<text x="553" y="28" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">sent</text>
<text x="553" y="46" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">t2 = 09:40:00</text>
<text x="365" y="80" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">buffered offline for 40 minutes (device time)</text>
<path d="M555,66 L564,142" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-ts-w)"/>
<circle cx="566" cy="150" r="6" style="fill: var(--viz-c1)"/>
<text x="566" y="172" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">t3 = 09:45:02</text>
<text x="566" y="188" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">received</text>
<path d="M177,68 L177,141" stroke-width="1.6" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-c1)" marker-end="url(#c11d2-ts-w1)"/>
<circle cx="177" cy="150" r="6" stroke-width="2" style="fill: var(--viz-bg); stroke: var(--viz-c1)"/>
<text x="177" y="172" font-size="12" text-anchor="middle" font-weight="700" style="font-family: var(--font-mono)">≈ 09:05:02</text>
<text x="177" y="188" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">true event time</text>
<text x="365" y="110" font-size="12" text-anchor="middle">offset = t3 − t2 ≈ +5:02 (the device clock is slow)</text>
<text x="365" y="130" font-size="12" text-anchor="middle" font-weight="700">true event time ≈ t1 + offset</text>
</svg><svg class="c11n" viewBox="0 0 360 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Device clock and server clock timelines. The device records the event at 09:00:00 and sends it at 09:40:00 by its own clock; the server receives it at 09:45:02. The offset of about five minutes, added to the event timestamp, gives the true event time of about 09:05:02.">
<defs><marker id="c11d2-ts-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker><marker id="c11d2-ts-n1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-c1)"/></marker></defs>
<text x="175" y="54" font-size="12" text-anchor="middle" font-weight="700">device clock</text>
<line x1="14" y1="70" x2="346" y2="70" stroke-width="2" style="stroke: var(--viz-c5)"/>
<circle cx="60" cy="70" r="6" style="fill: var(--viz-c5)"/>
<text x="60" y="36" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">event occurred</text>
<text x="60" y="54" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">t1 = 09:00:00</text>
<circle cx="290" cy="70" r="6" style="fill: var(--viz-c5)"/>
<text x="290" y="36" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">sent</text>
<text x="290" y="54" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">t2 = 09:40:00</text>
<text x="175" y="90" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">buffered offline 40 min</text>
<path d="M292,76 L299,182" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-ts-n)"/>
<text x="168" y="122" font-size="12" text-anchor="middle">offset = t3 − t2 ≈ +5:02</text>
<text x="168" y="140" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">(the device clock is slow)</text>
<text x="168" y="164" font-size="12" text-anchor="middle" font-weight="700">true time ≈ t1 + offset</text>
<line x1="14" y1="190" x2="346" y2="190" stroke-width="2" style="stroke: var(--viz-c1)"/>
<text x="180" y="212" font-size="12" text-anchor="middle" font-weight="700">server clock</text>
<circle cx="300" cy="190" r="6" style="fill: var(--viz-c1)"/>
<text x="300" y="212" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">t3 = 09:45:02</text>
<text x="300" y="228" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">received</text>
<path d="M60,78 L60,181" stroke-width="1.6" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-c1)" marker-end="url(#c11d2-ts-n1)"/>
<circle cx="60" cy="190" r="6" stroke-width="2" style="fill: var(--viz-bg); stroke: var(--viz-c1)"/>
<text x="60" y="212" font-size="12" text-anchor="middle" font-weight="700" style="font-family: var(--font-mono)">≈ 09:05:02</text>
<text x="60" y="228" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">true event time</text>
</svg>`,
          caption: "Illustrative numbers: the phone's clock runs about five minutes slow. Because the same error affects both device readings, the gap between 'sent' (device) and 'received' (server) measures it, and adding it to the event's own timestamp moves the order from 09:00:00 to about 09:05:02 on the server's clock.",
        },
        {
          type: "text",
          html: `<h3>Four ways to cut time into windows</h3>
<p>With the timestamps settled, you still have to say what "the last five minutes" means. Four window types cover almost everything; the diagram applies each to the same events from two users.</p>`,
        },
        {
          type: "diagram",
          title: "Four window types on one timeline",
          svg: `<style>.dd-diagram-body svg.c11n{display:none}@media (max-width:600px){.dd-diagram-body svg.c11w{display:none}.dd-diagram-body svg.c11n{display:block}}</style><svg class="c11w" viewBox="0 0 640 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Thirteen events from two users on a ten-minute axis, grouped four ways: tumbling one-minute windows, hopping five-minute windows that start every minute, a sliding window spanning two events less than five minutes apart, and per-user session windows separated by inactivity gaps.">
<line x1="160" y1="40" x2="160" y2="250" style="stroke: var(--viz-grid)"/>
<line x1="206" y1="40" x2="206" y2="250" style="stroke: var(--viz-grid)"/>
<line x1="252" y1="40" x2="252" y2="250" style="stroke: var(--viz-grid)"/>
<line x1="298" y1="40" x2="298" y2="250" style="stroke: var(--viz-grid)"/>
<line x1="344" y1="40" x2="344" y2="250" style="stroke: var(--viz-grid)"/>
<line x1="390" y1="40" x2="390" y2="250" style="stroke: var(--viz-grid)"/>
<line x1="436" y1="40" x2="436" y2="250" style="stroke: var(--viz-grid)"/>
<line x1="482" y1="40" x2="482" y2="250" style="stroke: var(--viz-grid)"/>
<line x1="528" y1="40" x2="528" y2="250" style="stroke: var(--viz-grid)"/>
<line x1="574" y1="40" x2="574" y2="250" style="stroke: var(--viz-grid)"/>
<line x1="620" y1="40" x2="620" y2="250" style="stroke: var(--viz-grid)"/>
<text x="160" y="22" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">10:00</text>
<text x="252" y="22" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">10:02</text>
<text x="344" y="22" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">10:04</text>
<text x="436" y="22" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">10:06</text>
<text x="528" y="22" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">10:08</text>
<text x="620" y="22" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">10:10</text>
<line x1="160" y1="28" x2="160" y2="34" style="stroke: var(--viz-muted)"/>
<line x1="206" y1="28" x2="206" y2="34" style="stroke: var(--viz-muted)"/>
<line x1="252" y1="28" x2="252" y2="34" style="stroke: var(--viz-muted)"/>
<line x1="298" y1="28" x2="298" y2="34" style="stroke: var(--viz-muted)"/>
<line x1="344" y1="28" x2="344" y2="34" style="stroke: var(--viz-muted)"/>
<line x1="390" y1="28" x2="390" y2="34" style="stroke: var(--viz-muted)"/>
<line x1="436" y1="28" x2="436" y2="34" style="stroke: var(--viz-muted)"/>
<line x1="482" y1="28" x2="482" y2="34" style="stroke: var(--viz-muted)"/>
<line x1="528" y1="28" x2="528" y2="34" style="stroke: var(--viz-muted)"/>
<line x1="574" y1="28" x2="574" y2="34" style="stroke: var(--viz-muted)"/>
<line x1="620" y1="28" x2="620" y2="34" style="stroke: var(--viz-muted)"/>
<text x="12" y="58" font-size="12" font-weight="700">events</text>
<circle cx="178.4" cy="54" r="5" style="fill: var(--viz-c6)"/>
<circle cx="201.4" cy="54" r="5" style="fill: var(--viz-c6)"/>
<circle cx="233.6" cy="54" r="5" style="fill: var(--viz-c6)"/>
<circle cx="265.8" cy="54" r="5" style="fill: var(--viz-c6)"/>
<circle cx="426.8" cy="54" r="5" style="fill: var(--viz-c6)"/>
<circle cx="449.8" cy="54" r="5" style="fill: var(--viz-c6)"/>
<circle cx="486.6" cy="54" r="5" style="fill: var(--viz-c6)"/>
<rect x="298.1" y="49.5" width="9" height="9" style="fill: var(--viz-c4)"/>
<rect x="323.4" y="49.5" width="9" height="9" style="fill: var(--viz-c4)"/>
<rect x="348.7" y="49.5" width="9" height="9" style="fill: var(--viz-c4)"/>
<rect x="532.7" y="49.5" width="9" height="9" style="fill: var(--viz-c4)"/>
<rect x="560.3" y="49.5" width="9" height="9" style="fill: var(--viz-c4)"/>
<rect x="583.3" y="49.5" width="9" height="9" style="fill: var(--viz-c4)"/>
<text x="12" y="92" font-size="12" font-weight="700">Tumbling</text><text x="12" y="107" font-size="12" style="fill: var(--viz-muted)">1 min</text>
<rect x="161.5" y="82" width="43" height="22" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="207.5" y="82" width="43" height="22" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="253.5" y="82" width="43" height="22" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="299.5" y="82" width="43" height="22" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="345.5" y="82" width="43" height="22" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="391.5" y="82" width="43" height="22" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="437.5" y="82" width="43" height="22" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="483.5" y="82" width="43" height="22" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="529.5" y="82" width="43" height="22" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="575.5" y="82" width="43" height="22" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="12" y="136" font-size="12" font-weight="700">Hopping</text><text x="12" y="151" font-size="12" style="fill: var(--viz-muted)">5 min, every 1 min</text>
<rect x="161.5" y="124" width="227" height="10" rx="3" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="207.5" y="138" width="227" height="10" rx="3" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="253.5" y="152" width="227" height="10" rx="3" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="490" y="162" font-size="12" style="fill: var(--viz-muted)">… one more every minute</text>
<text x="12" y="186" font-size="12" font-weight="700">Sliding</text><text x="12" y="201" font-size="12" style="fill: var(--viz-muted)">5 min</text>
<rect x="327.9" y="178" width="209.3" height="14" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="323.9" y="181" width="8" height="8" style="fill: var(--viz-c4)"/><rect x="533.2" y="181" width="8" height="8" style="fill: var(--viz-c4)"/>
<text x="432.6" y="210" font-size="12" text-anchor="middle" class="viz-halo" style="fill: var(--viz-muted)">10:03:39 and 10:08:12 are under 5 min apart</text>
<text x="12" y="230" font-size="12" font-weight="700">Session</text><text x="12" y="245" font-size="12" style="fill: var(--viz-muted)">gap 2 min, per user</text>
<rect x="178.4" y="222" width="87.4" height="10" rx="3" stroke-width="1.4" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<line x1="265.8" y1="227" x2="357.8" y2="227" stroke-width="1.5" stroke-dasharray="4 3" style="stroke: var(--viz-c6)"/>
<rect x="426.8" y="222" width="59.8" height="10" rx="3" stroke-width="1.4" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<line x1="486.6" y1="227" x2="578.6" y2="227" stroke-width="1.5" stroke-dasharray="4 3" style="stroke: var(--viz-c6)"/>
<rect x="302.6" y="236" width="50.6" height="10" rx="3" stroke-width="1.4" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
<line x1="353.2" y1="241" x2="445.2" y2="241" stroke-width="1.5" stroke-dasharray="4 3" style="stroke: var(--viz-c4)"/>
<rect x="537.2" y="236" width="50.6" height="10" rx="3" stroke-width="1.4" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
<line x1="587.8" y1="241" x2="620" y2="241" stroke-width="1.5" stroke-dasharray="4 3" style="stroke: var(--viz-c4)"/>
<circle cx="165" cy="266" r="5" style="fill: var(--viz-c6)"/><text x="175" y="270" font-size="12">user A</text>
<rect x="232" y="261.5" width="9" height="9" style="fill: var(--viz-c4)"/><text x="247" y="270" font-size="12">user B</text>
<line x1="304" y1="266" x2="328" y2="266" stroke-width="1.5" stroke-dasharray="4 3" style="stroke: var(--viz-muted)"/><text x="334" y="270" font-size="12" style="fill: var(--viz-muted)">waiting out the inactivity gap</text>
</svg><svg class="c11n" viewBox="0 0 360 302" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Thirteen events from two users on a ten-minute axis, grouped four ways: tumbling one-minute windows, hopping five-minute windows that start every minute, a sliding window spanning two events less than five minutes apart, and per-user session windows separated by inactivity gaps.">
<line x1="24" y1="34" x2="24" y2="272" style="stroke: var(--viz-grid)"/>
<line x1="55.2" y1="34" x2="55.2" y2="272" style="stroke: var(--viz-grid)"/>
<line x1="86.4" y1="34" x2="86.4" y2="272" style="stroke: var(--viz-grid)"/>
<line x1="117.6" y1="34" x2="117.6" y2="272" style="stroke: var(--viz-grid)"/>
<line x1="148.8" y1="34" x2="148.8" y2="272" style="stroke: var(--viz-grid)"/>
<line x1="180" y1="34" x2="180" y2="272" style="stroke: var(--viz-grid)"/>
<line x1="211.2" y1="34" x2="211.2" y2="272" style="stroke: var(--viz-grid)"/>
<line x1="242.4" y1="34" x2="242.4" y2="272" style="stroke: var(--viz-grid)"/>
<line x1="273.6" y1="34" x2="273.6" y2="272" style="stroke: var(--viz-grid)"/>
<line x1="304.8" y1="34" x2="304.8" y2="272" style="stroke: var(--viz-grid)"/>
<line x1="336" y1="34" x2="336" y2="272" style="stroke: var(--viz-grid)"/>
<text x="14" y="18" font-size="12" text-anchor="start" style="fill: var(--viz-muted)">10:00</text>
<text x="180" y="18" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">10:05</text>
<text x="346" y="18" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">10:10</text>
<line x1="24" y1="24" x2="24" y2="30" style="stroke: var(--viz-muted)"/>
<line x1="55.2" y1="24" x2="55.2" y2="30" style="stroke: var(--viz-muted)"/>
<line x1="86.4" y1="24" x2="86.4" y2="30" style="stroke: var(--viz-muted)"/>
<line x1="117.6" y1="24" x2="117.6" y2="30" style="stroke: var(--viz-muted)"/>
<line x1="148.8" y1="24" x2="148.8" y2="30" style="stroke: var(--viz-muted)"/>
<line x1="180" y1="24" x2="180" y2="30" style="stroke: var(--viz-muted)"/>
<line x1="211.2" y1="24" x2="211.2" y2="30" style="stroke: var(--viz-muted)"/>
<line x1="242.4" y1="24" x2="242.4" y2="30" style="stroke: var(--viz-muted)"/>
<line x1="273.6" y1="24" x2="273.6" y2="30" style="stroke: var(--viz-muted)"/>
<line x1="304.8" y1="24" x2="304.8" y2="30" style="stroke: var(--viz-muted)"/>
<line x1="336" y1="24" x2="336" y2="30" style="stroke: var(--viz-muted)"/>
<circle cx="36.5" cy="44" r="4.5" style="fill: var(--viz-c6)"/>
<circle cx="52.1" cy="44" r="4.5" style="fill: var(--viz-c6)"/>
<circle cx="73.9" cy="44" r="4.5" style="fill: var(--viz-c6)"/>
<circle cx="95.8" cy="44" r="4.5" style="fill: var(--viz-c6)"/>
<circle cx="205" cy="44" r="4.5" style="fill: var(--viz-c6)"/>
<circle cx="220.6" cy="44" r="4.5" style="fill: var(--viz-c6)"/>
<circle cx="245.5" cy="44" r="4.5" style="fill: var(--viz-c6)"/>
<rect x="116.7" y="40" width="8" height="8" style="fill: var(--viz-c4)"/>
<rect x="133.9" y="40" width="8" height="8" style="fill: var(--viz-c4)"/>
<rect x="151" y="40" width="8" height="8" style="fill: var(--viz-c4)"/>
<rect x="275.8" y="40" width="8" height="8" style="fill: var(--viz-c4)"/>
<rect x="294.6" y="40" width="8" height="8" style="fill: var(--viz-c4)"/>
<rect x="310.2" y="40" width="8" height="8" style="fill: var(--viz-c4)"/>
<text x="14" y="72" font-size="12" class="viz-halo"><tspan font-weight="700">Tumbling</tspan><tspan style="fill: var(--viz-muted)"> · 1 min</tspan></text>
<rect x="25.5" y="78" width="28.2" height="18" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="56.7" y="78" width="28.2" height="18" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="87.9" y="78" width="28.2" height="18" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="119.1" y="78" width="28.2" height="18" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="150.3" y="78" width="28.2" height="18" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="181.5" y="78" width="28.2" height="18" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="212.7" y="78" width="28.2" height="18" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="243.9" y="78" width="28.2" height="18" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="275.1" y="78" width="28.2" height="18" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="306.3" y="78" width="28.2" height="18" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="14" y="118" font-size="12" class="viz-halo"><tspan font-weight="700">Hopping</tspan><tspan style="fill: var(--viz-muted)"> · 5 min, every 1 min</tspan></text>
<rect x="25.5" y="124" width="153" height="9" rx="3" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="56.7" y="136" width="153" height="9" rx="3" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="87.9" y="148" width="153" height="9" rx="3" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="250.4" y="157" font-size="12" style="fill: var(--viz-muted)">…</text>
<text x="14" y="180" font-size="12" class="viz-halo"><tspan font-weight="700">Sliding</tspan><tspan style="fill: var(--viz-muted)"> · 5 min</tspan></text>
<rect x="137.9" y="186" width="141.9" height="12" rx="4" stroke-width="1.4" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<rect x="133.9" y="188" width="8" height="8" style="fill: var(--viz-c4)"/><rect x="275.8" y="188" width="8" height="8" style="fill: var(--viz-c4)"/>
<text x="208.9" y="214" font-size="12" text-anchor="middle" class="viz-halo" style="fill: var(--viz-muted)">10:03:39 and 10:08:12 are under 5 min apart</text>
<text x="14" y="240" font-size="12" class="viz-halo"><tspan font-weight="700">Session</tspan><tspan style="fill: var(--viz-muted)"> · gap 2 min, per user</tspan></text>
<rect x="36.5" y="246" width="59.3" height="9" rx="3" stroke-width="1.4" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<line x1="95.8" y1="250.5" x2="158.2" y2="250.5" stroke-width="1.5" stroke-dasharray="4 3" style="stroke: var(--viz-c6)"/>
<rect x="205" y="246" width="40.5" height="9" rx="3" stroke-width="1.4" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<line x1="245.5" y1="250.5" x2="307.9" y2="250.5" stroke-width="1.5" stroke-dasharray="4 3" style="stroke: var(--viz-c6)"/>
<rect x="120.7" y="260" width="34.3" height="9" rx="3" stroke-width="1.4" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
<line x1="155" y1="264.5" x2="217.4" y2="264.5" stroke-width="1.5" stroke-dasharray="4 3" style="stroke: var(--viz-c4)"/>
<rect x="279.8" y="260" width="34.4" height="9" rx="3" stroke-width="1.4" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
<line x1="314.2" y1="264.5" x2="336" y2="264.5" stroke-width="1.5" stroke-dasharray="4 3" style="stroke: var(--viz-c4)"/>
<circle cx="29" cy="288" r="5" style="fill: var(--viz-c6)"/><text x="39" y="292" font-size="12">user A</text>
<rect x="96" y="283.5" width="9" height="9" style="fill: var(--viz-c4)"/><text x="111" y="292" font-size="12">user B</text>
<line x1="168" y1="288" x2="192" y2="288" stroke-width="1.5" stroke-dasharray="4 3" style="stroke: var(--viz-muted)"/><text x="198" y="292" font-size="12" style="fill: var(--viz-muted)">inactivity gap</text>
</svg>`,
          caption: "Tumbling windows tile the clock; hopping windows overlap so each event counts several times; a sliding window is defined by events being close to each other, not by the clock; session windows are per user and end only after a gap with no activity (dashed), so their length is unknown in advance.",
        },
        {
          type: "table",
          title: "Window types at a glance",
          headers: [`<span style="white-space:nowrap">Window</span>`, "Definition", "Example", "How it's computed", "Typical use"],
          rows: [
            [`<span style="white-space:nowrap">Tumbling</span>`, "Fixed length; every event belongs to exactly one window", "1-minute windows: 10:03:00–10:03:59, 10:04:00–10:04:59, …", "Round each timestamp down to the minute and group by it", "Orders per minute; hourly billing"],
            [`<span style="white-space:nowrap">Hopping</span>`, "Fixed length, overlapping, advancing by a fixed hop", "5 minutes, every minute: 10:03:00–10:07:59, 10:04:00–10:08:59, …", "Compute 1-minute tumbling windows, then combine each run of five", "Smoothed metrics, such as a 5-minute average refreshed every minute"],
            [`<span style="white-space:nowrap">Sliding</span>`, "All events that occur within some interval of each other; not aligned to the clock", "5 minutes: events at 10:03:39 and 10:08:12 share a window", "Keep a time-sorted buffer and evict events as they expire", "Rules like \"more than 3 failures within 5 minutes\""],
            [`<span style="white-space:nowrap">Session</span>`, "No fixed length; one user's events that occur close together, ending after inactivity", "A visit ends after 30 minutes with no activity from that user", "Per key, extend the window with each event; merge windows a late event bridges", "Web and app analytics: pages per visit, visit length"],
          ],
        },
        {
          type: "text",
          html: `<p>Two subtleties. Session windows are kept <strong>per key</strong> and can <strong>merge</strong>. With a 30-minute gap, a user whose last event so far is at 10:20 and who returns at 10:55 has had two visits, until a late event stamped 10:40 arrives and bridges the gap. Now it's one long visit, and any result already emitted for the two short ones must be retracted and replaced. That's why engines implement sessions as mergeable windows.</p>
<p>And microbatching, covered in the final section, cuts the stream into batches by processing time. That doesn't restrict microbatch engines to processing-time windows: Spark Structured Streaming supports event-time windows, and since Spark 2.1 watermarks, by carrying window state from one micro-batch to the next.</p>`,
        },
        {
          type: "realworld",
          items: [
            {
              org: "Google MillWheel and the Dataflow model",
              year: "2013–2016",
              html: "MillWheel (VLDB 2013) introduced low watermarks for Google's internal stream processing. <em>The Dataflow Model</em> (VLDB 2015, Akidau et al.) generalized event-time windowing, watermarks and triggers, and became Apache Beam in 2016.",
            },
            {
              org: "Apache Flink",
              tag: "bounded out-of-orderness",
              html: "Flink's <code>forBoundedOutOfOrderness</code> watermark strategy sets the watermark to the maximum timestamp seen minus the given bound. Windows can set <code>allowedLateness</code> to update results for late records, and late records can go to a side output instead of being dropped silently.",
            },
            {
              org: "Apache Kafka (KIP-32)",
              year: "2016",
              html: "Since Kafka 0.10, every record carries a timestamp, configured per topic as <code>CreateTime</code> (set by the producer) or <code>LogAppendTime</code> (set by the broker): the choice between event time and ingestion time, made at the infrastructure level.",
            },
            {
              org: "Mobile analytics",
              tag: "general practice",
              html: "Mobile analytics libraries commonly queue events on the device and upload them in batches, including once the device is back online, so the time an event happened and the time it reaches the server can differ by hours.",
            },
          ],
        },
        {
          type: "callout",
          tone: "mistake",
          title: "Common misconception: \"sliding window\" means the same thing everywhere",
          html: `<p>It doesn't. Flink and Apache Beam call the book's <em>hopping</em> window a <strong>sliding window</strong>: fixed size, fixed slide (Flink's <code>SlidingEventTimeWindows.of(size, slide)</code>, Beam's <code>SlidingWindows</code>). The book's sliding window, defined by events being close to each other rather than by clock-aligned boundaries, corresponds more closely to Kafka Streams' <code>SlidingWindows</code> (a maximum time difference between records) or to a SQL <code>OVER</code> window with a <code>RANGE</code> interval. Kafka Streams calls its fixed-slide windows hopping windows. When someone says "sliding window" in a design discussion, ask which one they mean.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: real-time metrics from late mobile data",
          html: `<p>"Design a dashboard of purchases per minute from our mobile apps" is really a question about time. A strong answer stamps events on the device and logs the send time, so the server can correct clock offsets with the three-timestamp trick; windows by event time; and sets the watermark delay from measured lateness (say, the 99th percentile of arrival delay) instead of a guess. It states the straggler policy explicitly: drop and count late events, or keep windows open for an allowed lateness and emit corrections the dashboard store upserts. It notes that phones offline for hours will always be late, so finance-grade daily totals should come from a later, complete recomputation. Bonus: point out that one idle partition stalls the watermark, and say how you'd detect that.</p>`,
        },
        {
          type: "quiz",
          q: "Your streaming job counts orders per minute using processing time. It is stopped for 10 minutes for a deploy, then catches up on the backlog. What does the dashboard show?",
          options: [
            "Accurate per-minute counts, merely delayed by 10 minutes",
            "Ten minutes with no counts followed by a huge spike, even though the real order rate was steady",
            "The same as event-time counts, because Kafka preserves order within each partition",
            "Missing data for the final minute only",
          ],
          answer: 1,
          explain: "With processing time, each order is assigned to the minute in which the job sees it. Nothing is processed during the outage, then the whole backlog lands in the first minutes after the restart. Event-time windows would put each order in the minute it was placed. The Kafka option is tempting, but per-partition order says nothing about which clock you window by: the events are in order, they're just counted in the wrong minute.",
        },
      ],
    },

    // ───────────────────────────────────────────────────────────── 9
    {
      id: "stream-joins",
      title: "Joining streams: three kinds of join, and why time makes them nondeterministic",
      kicker: "Processing streams",
      concepts: ["stream-stream-join", "stream-table-join", "table-table-join", "slowly-changing-dimension"],
      blocks: [
        {
          type: "problem",
          html: `<p>Batch joins (Chapter 10) have the complete input in hand. In a stream, new events can appear at any moment, so a join must remember what it has seen, and decide for how long. A search site wants click-through rates, but a click may arrive seconds after its search, ten minutes later, before the search itself, or never, and "never" is half the formula. An activity stream needs user data attached, and querying a remote database per event means 100,000 extra queries per second at 100,000 events per second (illustrative). A home timeline built from tweets and follows must react to changes on <em>both</em> sides. And whenever the joined state changes over time, the answer quietly depends on which event was processed first, so rerunning the same job on the same input can give a different result.</p>`,
        },
        {
          type: "idea",
          html: `<p>Every streaming join keeps state from one or both inputs, indexed by the join key: a <strong>window of recent events</strong> (stream-stream), a <strong>local copy of a table kept current by change data capture</strong> (stream-table), or <strong>both tables</strong> (table-table). Because that state changes over time, you must also decide which version of it each event joins with.</p>`,
        },
        {
          type: "compare",
          title: "Three kinds of streaming join",
          items: [
            {
              title: "Stream-stream (window join)",
              tone: "info",
              html: "<p><strong>State:</strong> recent events from both streams, indexed by key, for a window.</p><p><strong>Example:</strong> searches joined with clicks on session ID.</p><p><strong>Batch analogue:</strong> a join of two event logs by key, limited to a time window.</p>",
            },
            {
              title: "Stream-table (enrichment)",
              tone: "info",
              html: "<p><strong>State:</strong> a local copy of the table, kept fresh by its changelog.</p><p><strong>Example:</strong> add each user's country to their activity events.</p><p><strong>Batch analogue:</strong> a map-side (broadcast or partitioned) hash join.</p>",
            },
            {
              title: "Table-table (view maintenance)",
              tone: "info",
              html: "<p><strong>State:</strong> both tables, each built from its changelog.</p><p><strong>Example:</strong> home timelines from tweets and follows.</p><p><strong>Batch analogue:</strong> recomputing a joined table, except only the change is computed.</p>",
            },
          ],
        },
        {
          type: "text",
          html: `<h3>Stream-stream joins: searches and clicks</h3>
<p>A search site logs a <code>search</code> event with the query and results, and a <code>click</code> event when a result is clicked; both carry the session ID. To pair them, the processor keeps state, for example every event of the last hour indexed by session ID, one index per stream. A search goes into the search index and the processor checks the click index for that session; a click goes into the click index and the processor checks the search index. A match emits "s1 clicked result #2". A search whose hour runs out unmatched emits "s2: not clicked".</p>
<p>Why not copy the search details into each click and skip the join? Because then unclicked searches, the rest of the click-through formula, would be invisible. The join exists to produce the negative result, and can only do so by remembering every search until its window expires. It must also work in both directions, since nothing guarantees a search is processed before its click. And the window length isn't a technical knob: "a click within an hour still counts" is the business definition of a click-through, and also the size of your memory bill.</p>`,
        },
        {
          type: "diagram",
          title: "A window join on session ID",
          svg: `<style>.dd-diagram-body svg.c11n{display:none}@media (max-width:600px){.dd-diagram-body svg.c11w{display:none}.dd-diagram-body svg.c11n{display:block}}</style><svg class="c11w" viewBox="0 0 640 228" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three searches s1, s2 and s3 and two clicks on a sixty-minute axis with a thirty-minute window. The click on s1 five seconds later produces a match. s2 is never clicked. The click on s3 arrives forty minutes later, after s3's window has ended, so s3 is reported as not clicked.">
<defs><marker id="c11d2-wj-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ok)"/></marker></defs>
<rect x="144" y="36" width="255" height="84" rx="6" style="fill: var(--viz-c2-soft); stroke: none"/>
<text x="150" y="30" font-size="12" style="fill: var(--viz-muted)">s1's 30-minute window</text>
<text x="14" y="60" font-size="12" font-weight="700">searches</text>
<text x="14" y="110" font-size="12" font-weight="700">clicks</text>
<text x="14" y="164" font-size="12" font-weight="700">output</text>
<line x1="110" y1="56" x2="620" y2="56" style="stroke: var(--viz-line)"/>
<line x1="110" y1="106" x2="620" y2="106" style="stroke: var(--viz-line)"/>
<line x1="110" y1="160" x2="620" y2="160" style="stroke: var(--viz-line)"/>
<circle cx="144" cy="56" r="6" style="fill: var(--viz-c6)"/><text x="144" y="46" font-size="12" text-anchor="middle" font-weight="700">s1</text>
<circle cx="195" cy="56" r="6" style="fill: var(--viz-c6)"/><text x="195" y="46" font-size="12" text-anchor="middle" font-weight="700">s2</text>
<circle cx="246" cy="56" r="6" style="fill: var(--viz-c6)"/><text x="246" y="46" font-size="12" text-anchor="middle" font-weight="700">s3</text>
<line x1="246" y1="78" x2="501" y2="78" stroke-width="1.5" stroke-dasharray="5 3" style="stroke: var(--viz-warn)"/><line x1="246" y1="73" x2="246" y2="83" stroke-width="1.5" style="stroke: var(--viz-warn)"/><line x1="501" y1="73" x2="501" y2="83" stroke-width="1.5" style="stroke: var(--viz-warn)"/>
<text x="497" y="94" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">s3's window ends at 46 min</text>
<circle cx="145" cy="106" r="6" style="fill: var(--viz-c4)"/><text x="153" y="128" font-size="12">click on s1, 5 s later</text>
<circle cx="586" cy="106" r="6" opacity="0.45" style="fill: var(--viz-c4)"/><text x="586" y="128" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">s3, 40 min later</text>
<path d="M145,113 L145,150" stroke-width="1.6" style="fill: none; stroke: var(--viz-ok)" marker-end="url(#c11d2-wj-w)"/>
<circle cx="145" cy="160" r="6" style="fill: var(--viz-ok)"/><text x="153" y="182" font-size="12">s1: clicked result #2</text>
<circle cx="450" cy="160" r="6" style="fill: var(--viz-muted)"/><text x="450" y="148" font-size="12" text-anchor="middle">s2: not clicked</text>
<circle cx="501" cy="160" r="6" style="fill: var(--viz-warn)"/><text x="501" y="182" font-size="12" text-anchor="middle">s3: not clicked</text>
<text x="501" y="198" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">its click came too late</text>
<text x="110" y="220" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">0</text><text x="195" y="220" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">10</text><text x="280" y="220" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">20</text><text x="365" y="220" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">30</text><text x="450" y="220" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">40</text><text x="535" y="220" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">50</text><text x="626" y="220" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">60 min</text>
</svg><svg class="c11n" viewBox="0 0 360 266" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three searches s1, s2 and s3 and two clicks on a sixty-minute axis with a thirty-minute window. The click on s1 five seconds later produces a match. s2 is never clicked. The click on s3 arrives forty minutes later, after s3's window has ended, so s3 is reported as not clicked.">
<defs><marker id="c11d2-wj-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-ok)"/></marker></defs>
<rect x="88" y="30" width="138" height="86" rx="6" style="fill: var(--viz-c2-soft); stroke: none"/>
<text x="90" y="24" font-size="12" style="fill: var(--viz-muted)">s1's 30-minute window</text>
<text x="10" y="54" font-size="12" font-weight="700">search</text>
<text x="10" y="104" font-size="12" font-weight="700">click</text>
<text x="10" y="154" font-size="12" font-weight="700">output</text>
<line x1="70" y1="50" x2="346" y2="50" style="stroke: var(--viz-line)"/>
<line x1="70" y1="100" x2="346" y2="100" style="stroke: var(--viz-line)"/>
<line x1="70" y1="150" x2="346" y2="150" style="stroke: var(--viz-line)"/>
<circle cx="88" cy="50" r="5" style="fill: var(--viz-c6)"/><text x="88" y="42" font-size="12" text-anchor="middle" font-weight="700">s1</text>
<circle cx="116" cy="50" r="5" style="fill: var(--viz-c6)"/><text x="116" y="42" font-size="12" text-anchor="middle" font-weight="700">s2</text>
<circle cx="144" cy="50" r="5" style="fill: var(--viz-c6)"/><text x="144" y="42" font-size="12" text-anchor="middle" font-weight="700">s3</text>
<line x1="144" y1="72" x2="282" y2="72" stroke-width="1.5" stroke-dasharray="5 3" style="stroke: var(--viz-warn)"/><line x1="144" y1="67" x2="144" y2="77" stroke-width="1.5" style="stroke: var(--viz-warn)"/><line x1="282" y1="67" x2="282" y2="77" stroke-width="1.5" style="stroke: var(--viz-warn)"/>
<text x="232" y="88" font-size="12" text-anchor="middle" class="viz-halo" style="fill: var(--viz-muted)">s3's window</text>
<circle cx="89" cy="100" r="5" style="fill: var(--viz-c4)"/>
<circle cx="328" cy="100" r="5" opacity="0.45" style="fill: var(--viz-c4)"/>
<path d="M89,106 L89,141" stroke-width="1.6" style="fill: none; stroke: var(--viz-ok)" marker-end="url(#c11d2-wj-n)"/>
<circle cx="89" cy="150" r="5" style="fill: var(--viz-ok)"/><text x="98" y="142" font-size="12" font-weight="700">1</text>
<circle cx="254" cy="150" r="5" style="fill: var(--viz-muted)"/><text x="254" y="140" font-size="12" text-anchor="middle" font-weight="700">2</text>
<circle cx="282" cy="150" r="5" style="fill: var(--viz-warn)"/><text x="282" y="140" font-size="12" text-anchor="middle" font-weight="700">3</text>
<text x="70" y="172" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">0</text><text x="208" y="172" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">30</text><text x="350" y="172" font-size="12" text-anchor="end" style="fill: var(--viz-muted)">60 min</text>
<text x="10" y="200" font-size="12"><tspan font-weight="700">1</tspan>  s1: clicked result #2 (5 s after its search)</text>
<text x="10" y="220" font-size="12"><tspan font-weight="700">2</tspan>  s2: not clicked (window ended at 40 min)</text>
<text x="10" y="240" font-size="12"><tspan font-weight="700">3</tspan>  s3: not clicked; its click at 56 min was</text>
<text x="22" y="258" font-size="12">outside the window</text>
</svg>`,
          caption: "Illustrative times with a 30-minute window. The match for s1 is emitted the moment its click arrives; the two 'not clicked' results can only be emitted when each search's window expires, which is why the join must hold every search for the full window.",
        },
        {
          type: "text",
          html: `<h3>Stream-table joins: enrichment</h3>
<p>Instead of querying the profile database per event, keep a <strong>copy of the table inside the processor</strong>: a hash table in memory, or an index on local disk (Kafka Streams and Samza use RocksDB). Lookups become local reads. This is Chapter 10's <a href="#/ch10/learn/map-side-joins">map-side hash join</a>, except that a batch job uses a snapshot frozen at the start, while a stream processor runs for months and must keep its copy current. It does so by also subscribing to the profile table's <strong>change data capture</strong> stream.</p>
<p>So a stream-table join is really a join of two streams with very different windows. The changelog side's window reaches back to the beginning of time, newer versions replacing older ones, exactly what a compacted changelog stores. The activity side has no window: each event is joined once against the table as it stands, then forgotten.</p>
<p>The copy takes one of two shapes, as in Chapter 10. A small table can be <strong>replicated in full</strong> to every task, like a broadcast hash join (Kafka Streams' <code>GlobalKTable</code>), so the stream needn't be partitioned by the join key. A large table is <strong>partitioned by the join key</strong>, and the stream must be <strong>co-partitioned</strong> with it (same key, same partition count) or repartitioned first; Kafka Streams checks this for <code>KStream</code>-<code>KTable</code> joins. Either way, the copy is rebuilt from the changelog after a crash.</p>`,
        },
        {
          type: "diagram",
          title: "Enrichment with a local table kept fresh by CDC",
          svg: `<style>.dd-diagram-body svg.c11n{display:none}@media (max-width:600px){.dd-diagram-body svg.c11w{display:none}.dd-diagram-body svg.c11n{display:block}}</style><svg class="c11w" viewBox="0 0 640 222" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Activity events and the user profile changelog both flow into a stream processor that holds a local table from user ID to country. It emits enriched events and makes no per-event lookups to the remote user database.">
<defs><marker id="c11d2-en-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="10" y="26" width="200" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="110" y="44" font-size="12" text-anchor="middle" font-weight="700">Activity events</text>
<text x="110" y="61" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">(user_id, page)</text>
<rect x="10" y="120" width="200" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="110" y="138" font-size="12" text-anchor="middle" font-weight="700">Profile changelog (CDC)</text>
<text x="110" y="155" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">(user_id → country)</text>
<path d="M212,50 L256,78" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-en-w)"/>
<path d="M212,140 L256,114" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-en-w)"/>
<rect x="260" y="30" width="180" height="130" rx="10" stroke-width="1.6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="350" y="50" font-size="12" text-anchor="middle" font-weight="700">stream processor</text>
<rect x="280" y="62" width="140" height="84" rx="6" stroke-dasharray="4 3" style="fill: var(--viz-bg); stroke: var(--viz-c2)"/>
<text x="350" y="79" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">local table</text>
<text x="350" y="100" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">u1 → DE</text>
<text x="350" y="118" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">u7 → BR</text>
<text x="350" y="136" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">u9 → JP</text>
<path d="M442,95 L466,95" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-en-w)"/>
<rect x="470" y="70" width="160" height="50" rx="8" stroke-width="1.5" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
<text x="550" y="90" font-size="12" text-anchor="middle" font-weight="700">enriched events</text>
<text x="550" y="107" font-size="12" text-anchor="middle">user_id, page, country</text>
<path d="M520,168 L520,194 A40,8 0 0 0 600,194 L600,168" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<ellipse cx="560" cy="168" rx="40" ry="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="560" y="192" font-size="12" text-anchor="middle">User DB</text>
<path d="M442,150 L514,178" stroke-width="1.6" stroke-dasharray="5 4" style="fill: none; stroke: var(--viz-bad)"/>
<line x1="471" y1="155" x2="485" y2="169" stroke-width="2.2" style="stroke: var(--viz-bad)"/><line x1="485" y1="155" x2="471" y2="169" stroke-width="2.2" style="stroke: var(--viz-bad)"/>
<text x="500" y="216" font-size="12" text-anchor="end" style="fill: var(--viz-bad)">no per-event remote lookups</text>
</svg><svg class="c11n" viewBox="0 0 360 306" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Activity events and the user profile changelog both flow into a stream processor that holds a local table from user ID to country. It emits enriched events and makes no per-event lookups to the remote user database.">
<defs><marker id="c11d2-en-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="10" y="14" width="165" height="46" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="92" y="33" font-size="12" text-anchor="middle" font-weight="700">Activity events</text>
<text x="92" y="50" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">(user_id, page)</text>
<rect x="185" y="14" width="165" height="46" rx="8" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="267" y="33" font-size="12" text-anchor="middle" font-weight="700">Profile changelog</text>
<text x="267" y="50" font-size="12" text-anchor="middle">(CDC from user DB)</text>
<path d="M92,62 L138,92" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-en-n)"/>
<path d="M267,62 L222,92" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-en-n)"/>
<rect x="40" y="96" width="280" height="104" rx="10" stroke-width="1.6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="180" y="116" font-size="12" text-anchor="middle" font-weight="700">stream processor</text>
<rect x="90" y="126" width="180" height="64" rx="6" stroke-dasharray="4 3" style="fill: var(--viz-bg); stroke: var(--viz-c2)"/>
<text x="180" y="143" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">local table</text>
<text x="135" y="162" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">u1 → DE</text><text x="225" y="162" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">u7 → BR</text>
<text x="135" y="180" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">u9 → JP</text><text x="225" y="180" font-size="12" text-anchor="middle" style="font-family: var(--font-mono)">u4 → US</text>
<path d="M180,202 L180,222" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-en-n)"/>
<rect x="40" y="226" width="280" height="44" rx="8" stroke-width="1.5" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
<text x="180" y="244" font-size="12" text-anchor="middle" font-weight="700">enriched events</text>
<text x="180" y="261" font-size="12" text-anchor="middle">user_id, page, country</text>
<text x="180" y="294" font-size="12" text-anchor="middle" style="fill: var(--viz-bad)">✕ no per-event remote lookups to the user DB</text>
</svg>`,
          caption: "The processor consumes two streams: the events to enrich, and the table's changelog captured from the user database. Lookups hit the local copy (memory or local disk), so enrichment runs at stream speed and the user database sees only its normal load.",
        },
        {
          type: "text",
          html: `<h3>Table-table joins: maintaining a joined view</h3>
<p>Home timelines (Chapter 1) are the book's example. A new tweet by u goes into the timeline of everyone following u, and a deleted tweet leaves them; when u1 follows u2, u2's recent tweets join u1's timeline, and an unfollow removes them. So the processor keeps two tables built from two changelogs: each user's followers (whose timelines does a tweet touch?) and each user's recent tweets (what does a new follow backfill?). The output is a continuously maintained materialized view of a query joining tweets with follows, grouped by follower.</p>
<p>The book's intuition comes from calculus: the change in a join comes from changes to either input, as in the product rule (u·v)′ = u′v + uv′. For discrete changes the exact rule has a third term, Δ(A ⋈ B) = ΔA ⋈ B + A ⋈ ΔB + ΔA ⋈ ΔB, for a new tweet and a new follow arriving together; calculus drops it as second order. A processor that applies one change at a time, each against the other side's current state, gets it right automatically.</p>`,
        },
        {
          type: "diagram",
          title: "A table-table join: timelines as a materialized view",
          svg: `<style>.dd-diagram-body svg.c11n{display:none}@media (max-width:600px){.dd-diagram-body svg.c11w{display:none}.dd-diagram-body svg.c11n{display:block}}</style><svg class="c11w" viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="The tweets changelog and the follows changelog feed a join operator that keeps followers of each user and recent tweets of each user. It updates home timelines: adding and removing tweets for followers, and adding or removing a followed user's tweets.">
<defs><marker id="c11d2-tt-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="10" y="24" width="170" height="70" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="95" y="44" font-size="12" text-anchor="middle" font-weight="700">tweets changelog</text>
<text x="95" y="64" font-size="12" text-anchor="middle">u2 posts T9</text>
<text x="95" y="82" font-size="12" text-anchor="middle">u2 deletes T4</text>
<rect x="10" y="124" width="170" height="70" rx="8" stroke-width="1.5" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
<text x="95" y="144" font-size="12" text-anchor="middle" font-weight="700">follows changelog</text>
<text x="95" y="164" font-size="12" text-anchor="middle">u1 follows u2</text>
<text x="95" y="182" font-size="12" text-anchor="middle">u1 unfollows u3</text>
<path d="M182,59 L216,88" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-tt-w)"/>
<path d="M182,159 L216,130" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-tt-w)"/>
<rect x="220" y="24" width="170" height="170" rx="10" stroke-width="1.6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="305" y="44" font-size="12" text-anchor="middle" font-weight="700">join operator</text>
<rect x="234" y="58" width="142" height="56" rx="6" stroke-dasharray="4 3" style="fill: var(--viz-bg); stroke: var(--viz-c2)"/>
<text x="305" y="81" font-size="12" text-anchor="middle">followers of</text>
<text x="305" y="99" font-size="12" text-anchor="middle">each user</text>
<rect x="234" y="124" width="142" height="56" rx="6" stroke-dasharray="4 3" style="fill: var(--viz-bg); stroke: var(--viz-c2)"/>
<text x="305" y="147" font-size="12" text-anchor="middle">recent tweets</text>
<text x="305" y="165" font-size="12" text-anchor="middle">of each user</text>
<path d="M392,109 L426,109" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-tt-w)"/>
<rect x="430" y="24" width="200" height="170" rx="10" stroke-width="1.6" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
<text x="530" y="46" font-size="12" text-anchor="middle" font-weight="700">home timelines</text>
<text x="530" y="63" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">(materialized view)</text>
<rect x="442" y="84" width="8" height="8" style="fill: var(--viz-c6)"/><text x="456" y="92" font-size="12">+ T9 for u2's followers</text>
<rect x="442" y="110" width="8" height="8" style="fill: var(--viz-c6)"/><text x="456" y="118" font-size="12">− T4 from those timelines</text>
<rect x="442" y="136" width="8" height="8" style="fill: var(--viz-c4)"/><text x="456" y="144" font-size="12">+ u2's recent tweets to u1</text>
<rect x="442" y="162" width="8" height="8" style="fill: var(--viz-c4)"/><text x="456" y="170" font-size="12">− u3's tweets from u1</text>
<text x="320" y="226" font-size="12" text-anchor="middle">Δ(tweets ⋈ follows) = Δtweets ⋈ follows + tweets ⋈ Δfollows (+ Δtweets ⋈ Δfollows)</text>
</svg><svg class="c11n" viewBox="0 0 360 404" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="The tweets changelog and the follows changelog feed a join operator that keeps followers of each user and recent tweets of each user. It updates home timelines: adding and removing tweets for followers, and adding or removing a followed user's tweets.">
<defs><marker id="c11d2-tt-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="10" y="14" width="165" height="70" rx="8" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="92" y="34" font-size="12" text-anchor="middle" font-weight="700">tweets changelog</text>
<text x="92" y="54" font-size="12" text-anchor="middle">u2 posts T9</text>
<text x="92" y="72" font-size="12" text-anchor="middle">u2 deletes T4</text>
<rect x="185" y="14" width="165" height="70" rx="8" stroke-width="1.5" style="fill: var(--viz-c4-soft); stroke: var(--viz-c4)"/>
<text x="267" y="34" font-size="12" text-anchor="middle" font-weight="700">follows changelog</text>
<text x="267" y="54" font-size="12" text-anchor="middle">u1 follows u2</text>
<text x="267" y="72" font-size="12" text-anchor="middle">u1 unfollows u3</text>
<path d="M92,86 L138,106" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-tt-n)"/>
<path d="M267,86 L222,106" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-tt-n)"/>
<rect x="40" y="110" width="280" height="96" rx="10" stroke-width="1.6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="180" y="130" font-size="12" text-anchor="middle" font-weight="700">join operator</text>
<rect x="54" y="140" width="120" height="54" rx="6" stroke-dasharray="4 3" style="fill: var(--viz-bg); stroke: var(--viz-c2)"/>
<text x="114" y="162" font-size="12" text-anchor="middle">followers of</text>
<text x="114" y="180" font-size="12" text-anchor="middle">each user</text>
<rect x="186" y="140" width="120" height="54" rx="6" stroke-dasharray="4 3" style="fill: var(--viz-bg); stroke: var(--viz-c2)"/>
<text x="246" y="162" font-size="12" text-anchor="middle">recent tweets</text>
<text x="246" y="180" font-size="12" text-anchor="middle">of each user</text>
<path d="M180,208 L180,224" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-tt-n)"/>
<rect x="40" y="228" width="280" height="126" rx="10" stroke-width="1.6" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
<text x="180" y="248" font-size="12" text-anchor="middle"><tspan font-weight="700">home timelines</tspan><tspan style="fill: var(--viz-muted)"> (materialized view)</tspan></text>
<rect x="60" y="266" width="8" height="8" style="fill: var(--viz-c6)"/><text x="74" y="274" font-size="12">+ T9 for u2's followers</text>
<rect x="60" y="288" width="8" height="8" style="fill: var(--viz-c6)"/><text x="74" y="296" font-size="12">− T4 from those timelines</text>
<rect x="60" y="310" width="8" height="8" style="fill: var(--viz-c4)"/><text x="74" y="318" font-size="12">+ u2's recent tweets to u1</text>
<rect x="60" y="332" width="8" height="8" style="fill: var(--viz-c4)"/><text x="74" y="340" font-size="12">− u3's tweets from u1</text>
<text x="180" y="376" font-size="12" text-anchor="middle">Δ(tweets ⋈ follows) = Δtweets ⋈ follows</text>
<text x="180" y="394" font-size="12" text-anchor="middle">+ tweets ⋈ Δfollows (+ Δtweets ⋈ Δfollows)</text>
</svg>`,
          caption: "A table-table join is incremental view maintenance: every change on either side updates the joined result. Each effect is colored by the input that caused it; the bracketed term covers a tweet and a follow that change at the same moment.",
        },
        {
          type: "text",
          html: `<h3>Time makes joins nondeterministic</h3>
<p>All three joins work the same way underneath: they keep state built from one input and query it with events from the other. So the order of events reaching that state matters; follow-then-unfollow isn't unfollow-then-follow. Within one partition the order is fixed, but across streams or partitions there's usually no guarantee. If the state you join against changes over time, which version does each event see?</p>
<p>Take tax. Each invoice needs the rate for its country, product type and <em>date of sale</em>, because rates change. A stream-table join with a tax-rate table uses whatever version the processor holds when it processes each sale. While processing keeps up with real time, that's usually right. But a sale that arrives late, after the rate changed, picks up the new rate, and reprocessing last year's sales picks up today's rates for all of them. If the interleaving of the two streams isn't determined, the join is <strong>nondeterministic</strong>: the same job on the same input can produce different invoices.</p>
<p>The visualization has both joins. In <em>Window join</em>, four searches and three clicks meet a join that holds searches (and optionally clicks) for a window; wrong outputs are red. In <em>Enrichment</em>, four €100 sales are joined with a VAT table whose rate drops from 19% to 16% on 1 July (a hypothetical shop, modelled on the real rate change below).</p>`,
        },
        {
          type: "viz",
          id: "ch11/stream-joins",
          title: "Stream joins: windows, tables and time",
          caption: "Try dragging Window from 8 up to 10 minutes and watch s3 flip from an orphan click to a click-through: the window defines what counts. Back at 8, turn on Searches arrive 3 min late and turn off Buffer clicks too: the early clicks find no search and are thrown away, and CTR falls from 50% to 0%. Switch to Enrichment: sale #2 happened on Jun 30 but was uploaded after the rate change, so it gets 16%. Press Replay in January and notice that the same four sales produce different invoices. Finally choose Rate at sale time, and notice the price in Rate versions kept: the changelog can no longer be compacted.",
        },
        {
          type: "text",
          html: `<p>Both failures have one cause: the join followed processing order, not the data. Data warehouses call this the <strong>slowly changing dimension</strong> (SCD) problem: a dimension table (tax rates, products, addresses) changes occasionally, while the facts referring to it must keep the version that applied at the time. The usual fix gives each version of a record its own identifier: when the tax rate changes, the new rate gets a new ID, and each invoice records the ID of the rate in force at the time of sale. The join becomes deterministic, because it no longer depends on which version is current.</p>
<p>The price is retention: log compaction becomes impossible on the rate changelog, since compaction keeps only the latest version per key and every historical version may still be needed. Modern engines package the fix as a <strong>temporal join</strong> that looks up the version valid at each event's time. To be correct it must wait until the table side has progressed past that time, which ties joins back to the watermarks of the previous section.</p>`,
        },
        {
          type: "diagram",
          title: "Slowly changing dimension: versioned rates",
          svg: `<style>.dd-diagram-body svg.c11n{display:none}@media (max-width:600px){.dd-diagram-body svg.c11w{display:none}.dd-diagram-body svg.c11n{display:block}}</style><svg class="c11w" viewBox="0 16 640 194" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A versioned tax-rate table with rate_v1 at 19 percent until 30 June and rate_v2 at 16 percent from 1 July. Invoice 101 from 15 June records rate_v1; invoice 102 from 3 July records rate_v2. Joining on country alone during a December rerun would give both invoices 16 percent.">
<defs><marker id="c11d2-scd-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="14" y="30" width="300" height="104" rx="10" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="28" y="50" font-size="12" font-weight="700">tax_rates (versioned)</text>
<text x="28" y="72" font-size="12" style="fill: var(--viz-muted)">id</text><text x="112" y="72" font-size="12" style="fill: var(--viz-muted)">country</text><text x="176" y="72" font-size="12" style="fill: var(--viz-muted)">rate</text><text x="222" y="72" font-size="12" style="fill: var(--viz-muted)">valid</text>
<text x="28" y="96" font-size="12" style="font-family: var(--font-mono)">rate_v1</text><text x="112" y="96" font-size="12">DE</text><text x="176" y="96" font-size="12">19%</text><text x="222" y="96" font-size="12">until Jun 30</text>
<text x="28" y="120" font-size="12" style="font-family: var(--font-mono)">rate_v2</text><text x="112" y="120" font-size="12">DE</text><text x="176" y="120" font-size="12">16%</text><text x="222" y="120" font-size="12">from Jul 1</text>
<rect x="344" y="30" width="282" height="104" rx="10" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="358" y="50" font-size="12" font-weight="700">invoices</text>
<text x="358" y="72" font-size="12" style="fill: var(--viz-muted)">invoice</text><text x="424" y="72" font-size="12" style="fill: var(--viz-muted)">sold</text><text x="484" y="72" font-size="12" style="fill: var(--viz-muted)">rate_id</text><text x="578" y="72" font-size="12" style="fill: var(--viz-muted)">tax</text>
<text x="358" y="96" font-size="12" style="font-family: var(--font-mono)">101</text><text x="424" y="96" font-size="12">Jun 15</text><text x="484" y="96" font-size="12" style="font-family: var(--font-mono)">rate_v1</text><text x="578" y="96" font-size="12">19%</text>
<text x="358" y="120" font-size="12" style="font-family: var(--font-mono)">102</text><text x="424" y="120" font-size="12">Jul 3</text><text x="484" y="120" font-size="12" style="font-family: var(--font-mono)">rate_v2</text><text x="578" y="120" font-size="12">16%</text>
<path d="M342,92 L318,92" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-scd-w)"/>
<path d="M342,116 L318,116" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-scd-w)"/>
<rect x="14" y="150" width="612" height="50" rx="10" stroke-width="1.5" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="320" y="170" font-size="12" text-anchor="middle">Joined on country alone during a December rerun, both invoices would get the current 16%.</text>
<text x="320" y="188" font-size="12" text-anchor="middle">Invoice 101 would be wrong, and the answer would depend on when you ran the job.</text>
</svg><svg class="c11n" viewBox="0 0 360 316" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A versioned tax-rate table with rate_v1 at 19 percent until 30 June and rate_v2 at 16 percent from 1 July. Invoice 101 from 15 June records rate_v1; invoice 102 from 3 July records rate_v2. Joining on country alone during a December rerun would give both invoices 16 percent.">
<rect x="10" y="14" width="340" height="92" rx="10" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="24" y="34" font-size="12" font-weight="700">tax_rates (versioned)</text>
<text x="24" y="60" font-size="12" style="font-family: var(--font-mono)">rate_v1</text><text x="104" y="60" font-size="12">DE · 19%</text><text x="196" y="60" font-size="12">until Jun 30</text>
<text x="24" y="86" font-size="12" style="font-family: var(--font-mono)">rate_v2</text><text x="104" y="86" font-size="12">DE · 16%</text><text x="196" y="86" font-size="12">from Jul 1</text>
<text x="180" y="126" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">each invoice stores the rate's version ID</text>
<rect x="10" y="138" width="340" height="92" rx="10" stroke-width="1.5" style="fill: var(--viz-c6-soft); stroke: var(--viz-c6)"/>
<text x="24" y="158" font-size="12" font-weight="700">invoices</text>
<text x="24" y="184" font-size="12" style="font-family: var(--font-mono)">101</text><text x="64" y="184" font-size="12">Jun 15</text><text x="134" y="184" font-size="12" style="font-family: var(--font-mono)">rate_v1</text><text x="230" y="184" font-size="12">→ 19%</text>
<text x="24" y="210" font-size="12" style="font-family: var(--font-mono)">102</text><text x="64" y="210" font-size="12">Jul 3</text><text x="134" y="210" font-size="12" style="font-family: var(--font-mono)">rate_v2</text><text x="230" y="210" font-size="12">→ 16%</text>
<rect x="10" y="244" width="340" height="64" rx="10" stroke-width="1.5" style="fill: var(--viz-bad-soft); stroke: var(--viz-bad)"/>
<text x="180" y="264" font-size="12" text-anchor="middle">Joined on country alone in a December rerun,</text>
<text x="180" y="281" font-size="12" text-anchor="middle">both invoices would get the current 16%,</text>
<text x="180" y="298" font-size="12" text-anchor="middle">and invoice 101 would be wrong.</text>
</svg>`,
          caption: "Version IDs make the join deterministic: the same invoices come out whenever the job runs. The cost is keeping every version of the rate table, so its changelog can't be compacted.",
        },
        {
          type: "realworld",
          items: [
            {
              org: "Google Photon",
              year: "2013",
              tag: "stream-stream join",
              html: "Photon (SIGMOD 2013) joins Google's continuous stream of web search queries with the stream of ad clicks in real time, across data centers, so each click can be attributed to the query that produced it for billing and reporting. Its goals are no duplicate joined events and, eventually, no missing ones: a production window join at very large scale.",
            },
            {
              org: "Twitter home timelines",
              tag: "table-table join",
              html: "Twitter has described building home timelines by fan-out on write: each new tweet is inserted into the cached timelines of the author's followers. That is the tweets-by-follows join maintained incrementally (Chapter 1).",
            },
            {
              org: "Kafka Streams",
              tag: "stream-table join",
              html: "A <code>KStream</code>-<code>KTable</code> join enriches each record from a local state store (RocksDB by default) that holds the table and is restored after a failure from a compacted changelog topic. The two inputs must be co-partitioned on the join key.",
            },
            {
              org: "Flink SQL temporal joins",
              tag: "versioned tables",
              html: "Flink's documentation shows an orders stream joined with a versioned currency-rates table <code>FOR SYSTEM_TIME AS OF</code> the order time, so each order is converted at the rate valid when it was placed, not today's rate.",
            },
            {
              org: "Germany's VAT cut",
              year: "2020",
              tag: "slowly changing dimension",
              html: "Germany temporarily cut its standard VAT rate from 19% to 16%, and the reduced rate from 7% to 5%, from 1 July to 31 December 2020. Every invoice around that period needed the rate valid on its date of supply, and any reprocessing of those sales must join with the historical rate, not the current one.",
            },
          ],
        },
        {
          type: "callout",
          tone: "modern",
          title: "Since the book: joins built into the engines",
          html: `<p>Kafka Streams names all three joins: windowed <code>KStream</code>-<code>KStream</code> joins, <code>KStream</code>-<code>KTable</code> and <code>KStream</code>-<code>GlobalKTable</code> enrichment, and <code>KTable</code>-<code>KTable</code> joins. Foreign-key table joins arrived in Kafka 2.4 (KIP-213), and versioned key-value stores in 3.5, which let a stream-table join look up the table version valid at a record's timestamp. Flink SQL has interval joins for stream-stream cases, regular joins (which keep both inputs in state indefinitely unless you configure a state TTL), and temporal joins with <code>FOR SYSTEM_TIME AS OF</code>: the slowly changing dimension fix built into the engine.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: enrich 100,000 clicks per second with user profiles",
          html: `<p>The trap is "look each user up in the database". A strong answer captures changes from the profile table with CDC into a compacted topic and has each stream task join against a local copy (RocksDB if it doesn't fit in memory). Then it makes the partitioning choice explicit: broadcast a small table to every task and skip repartitioning, or partition the clicks and the changelog by user ID with the same partition count, repartitioning clicks that are keyed differently. It covers startup (load the table before joining, or early clicks see missing users) and finishes with time: if a late click must see the profile as it was when the click happened, you need versioned state or a temporal join, and old versions can't be compacted away.</p>`,
        },
        {
          type: "quiz",
          q: "You reprocess last year's sales through a stream-table join against the tax-rate table, which CDC keeps up to date. What goes wrong, and how do you fix it?",
          options: [
            "Nothing: joins are deterministic as long as Kafka preserves per-partition order",
            "Old sales are joined with today's rates; record the version ID of the rate in force at the time of sale, or use a temporal join as of each sale's event time",
            "The join fails because the table side is too large to keep in memory",
            "Log compaction automatically restores the historical rates during the replay",
          ],
          answer: 1,
          explain: "The table side holds the latest version of each rate, so a replay joins historical sales with current state. Versioned identifiers (or a temporal, versioned table) pin each sale to the right version and make the join repeatable. The first option is tempting, but per-partition order says nothing about how the sales stream and the rate changelog interleave. Compaction does the opposite of keeping history.",
        },
      ],
    },

    // ───────────────────────────────────────────────────────────── 10
    {
      id: "fault-tolerance",
      title: "Exactly-once, really: checkpoints, atomic commits and idempotence",
      kicker: "Fault tolerance",
      concepts: ["exactly-once-semantics", "stateful-stream-processing", "delivery-semantics", "microbatching", "checkpointing"],
      blocks: [
        {
          type: "problem",
          html: `<p>Batch fault tolerance is easy: if a task fails, rerun it on the same immutable input and throw away its partial output, and the result looks as if every record had been processed exactly once (Chapter 10). A stream processor can't wait for its input to end before making output visible, because the input never ends.</p>
<p>The obvious approaches each break. Commit the consumer offset before processing, crash, and the event is never processed: <strong>at-most-once</strong>. Process and write the output first, crash before committing the offset, and after the restart the event is processed again and its effect applied twice: <strong>at-least-once</strong>. A revenue total double-counts; a customer gets the same email twice. And operator state built up over hours (counts, windows, join tables) must survive the crash without being lost or applied twice.</p>`,
        },
        {
          type: "idea",
          html: `<p>"Exactly-once" really means <strong>effectively-once</strong>: an event may be processed more than once, but the visible effect is as if it were processed once. You get there by making state, output and input position change <strong>atomically</strong> (microbatches, checkpoints, transactions), or by making re-application harmless (<strong>idempotence</strong>).</p>`,
        },
        {
          type: "compare",
          title: "When is progress recorded?",
          items: [
            {
              title: "At-most-once",
              tone: "bad",
              html: "<p><strong>Record the offset, then process.</strong> A crash in between skips the event forever. Acceptable for metrics you can afford to lose; wrong for money.</p>",
            },
            {
              title: "At-least-once",
              tone: "warn",
              html: "<p><strong>Process and write, then record the offset.</strong> A crash in between replays the event after the restart and applies its effect again. The default in most systems.</p>",
            },
            {
              title: "Effectively-once",
              tone: "ok",
              html: "<p><strong>Make output, state and offset one atomic step</strong>, or make re-applying harmless. Events may be processed twice, but the visible effect is as if once.</p>",
            },
          ],
        },
        {
          type: "text",
          html: `<p>The book calls the goal <strong>exactly-once semantics</strong> and suggests a more honest name, effectively-once. Nothing can stop a crashed task's events from being processed again; what you can guarantee is that the visible result looks as if each was processed once, the same promise a batch job makes.</p>
<p>In the visualization, a consumer reads ten orders from one partition and adds each amount to a revenue total in a database, committing its offset every few events. The correct total is $215. Pick a strategy, crash the consumer at that strategy's worst moment, and compare the sink's total with the truth.</p>`,
        },
        {
          type: "viz",
          id: "ch11/exactly-once",
          title: "Crash, restart, recount: delivery guarantees",
          caption: "Try At-least-once and press Crash at worst moment: e4 and e5 are written, the crash lands before the next commit, and the replay adds them again ($255). Set Commit every to 1 and only e5 is doubled. Then try At-most-once (e5 is lost, $200), Atomic commit and Idempotent sink (both $215). Finally turn on Email per order and notice that only the sink that passes an idempotency key to the email service avoids duplicate emails: a transaction inside the pipeline can't take back an email.",
        },
        {
          type: "text",
          html: `<p>At-least-once duplicated work and at-most-once lost it. Only two designs reached $215: one made the write and the offset a single transaction, the other let the sink recognize replays. Those are the two families of real solutions, which frameworks package in different ways.</p>
<h3>Microbatching</h3>
<p>Spark Streaming cut the stream into small blocks, typically about a second long, and ran each as a miniature batch job, so batch fault tolerance applied unchanged: a failed micro-batch is recomputed and its partial output discarded. The batch size is a compromise. Smaller batches pay more scheduling and coordination overhead; larger ones delay results. Microbatching implicitly gives you a tumbling window the size of the batch, cut by processing time, and anything larger has to carry state explicitly from one batch to the next.</p>
<h3>Checkpointing with barriers</h3>
<p>Flink periodically writes rolling <strong>checkpoints</strong> of operator state to durable storage. If an operator fails, the job restarts from the latest completed checkpoint and discards any output produced since. Checkpoints are triggered by <strong>barriers</strong> in the stream, like the boundaries between micro-batches but without forcing a window size.</p>
<p>The mechanism is a variant of the Chandy-Lamport distributed snapshot algorithm. Each source records its input offsets and injects barrier <em>n</em> into its streams. An operator that receives barrier <em>n</em> on one input holds back that input's later records until the barrier has arrived on all its inputs; then it snapshots its state (asynchronously, so processing continues) and forwards the barrier. Once every sink has acknowledged barrier <em>n</em>, checkpoint <em>n</em> is complete. Because the offsets are part of the snapshot, state and input position are always restored together.</p>`,
        },
        {
          type: "diagram",
          title: "Checkpoint barriers flowing through a dataflow",
          svg: `<style>.dd-diagram-body svg.c11n{display:none}@media (max-width:600px){.dd-diagram-body svg.c11w{display:none}.dd-diagram-body svg.c11n{display:block}}</style><svg class="c11w" viewBox="0 0 640 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two sources feed a map operator and a window count operator, which feeds a sink. Barrier n has reached the window count from the map side and is still travelling on the input from source B. The window count snapshots its state once barrier n has arrived on both inputs. Source offsets and operator state go to durable storage, and the sink acknowledges the checkpoint.">
<defs><marker id="c11d2-cp-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="10" y="30" width="90" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="55" y="52" font-size="12" text-anchor="middle" font-weight="700">Source A</text>
<rect x="10" y="118" width="90" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="55" y="140" font-size="12" text-anchor="middle" font-weight="700">Source B</text>
<rect x="170" y="30" width="90" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="215" y="52" font-size="12" text-anchor="middle" font-weight="700">Map</text>
<rect x="330" y="56" width="120" height="60" rx="8" stroke-width="1.6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="390" y="82" font-size="12" text-anchor="middle" font-weight="700">Window count</text>
<text x="390" y="100" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">state: counts</text>
<rect x="530" y="68" width="90" height="36" rx="8" stroke-width="1.5" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
<text x="575" y="90" font-size="12" text-anchor="middle" font-weight="700">Sink</text>
<path d="M100,48 L166,48" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-cp-w)"/>
<path d="M260,48 L326,73" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-cp-w)"/>
<path d="M100,136 L326,100" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-cp-w)"/>
<path d="M450,86 L526,86" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-cp-w)"/>
<circle cx="116" cy="48" r="4" style="fill: var(--viz-c6)"/><circle cx="152" cy="48" r="4" style="fill: var(--viz-c6)"/>
<circle cx="287" cy="58" r="4" style="fill: var(--viz-c6)"/>
<circle cx="146" cy="129" r="4" style="fill: var(--viz-c6)"/><circle cx="173" cy="124" r="4" style="fill: var(--viz-c6)"/><circle cx="255" cy="111" r="4" style="fill: var(--viz-c6)"/><circle cx="282" cy="107" r="4" style="fill: var(--viz-c6)"/>
<circle cx="476" cy="86" r="4" style="fill: var(--viz-c6)"/><circle cx="500" cy="86" r="4" style="fill: var(--viz-c6)"/>
<line x1="134" y1="37" x2="134" y2="59" stroke-width="3.5" stroke-linecap="round" style="stroke: var(--viz-c1)"/>
<text x="134" y="26" font-size="12" text-anchor="middle" style="fill: var(--viz-c1)">barrier n+1</text>
<line x1="314" y1="79" x2="321" y2="61" stroke-width="3.5" stroke-linecap="round" style="stroke: var(--viz-c1)"/>
<text x="292" y="93" font-size="12" text-anchor="middle" class="viz-halo" style="fill: var(--viz-c1)">n arrived</text>
<line x1="216" y1="128" x2="212" y2="108" stroke-width="3.5" stroke-linecap="round" style="stroke: var(--viz-c1)"/>
<text x="214" y="148" font-size="12" text-anchor="middle" style="fill: var(--viz-c1)">barrier n, in transit</text>
<text x="400" y="20" font-size="12" text-anchor="middle">snapshots its state when barrier n</text>
<text x="400" y="36" font-size="12" text-anchor="middle">has arrived on both inputs, then forwards it</text>
<path d="M190,180 L190,214 A140,8 0 0 0 470,214 L470,180" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<ellipse cx="330" cy="180" rx="140" ry="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="330" y="202" font-size="12" text-anchor="middle" font-weight="700">checkpoint n in durable storage</text>
<text x="330" y="217" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">source offsets + operator state</text>
<path d="M55,156 L186,194" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-cp-w)"/>
<text x="92" y="190" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">offsets</text>
<path d="M390,118 L372,168" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-cp-w)"/>
<text x="388" y="150" font-size="12" style="fill: var(--viz-muted)">state</text>
<path d="M575,106 L474,190" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-cp-w)"/>
<text x="540" y="156" font-size="12" style="fill: var(--viz-muted)">ack n</text>
</svg><svg class="c11n" viewBox="0 0 360 272" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two sources feed a map operator and a window count operator, which feeds a sink. Barrier n has reached the window count from the map side and is still travelling on the input from source B. The window count snapshots its state once barrier n has arrived on both inputs. Source offsets and operator state go to durable storage, and the sink acknowledges the checkpoint.">
<defs><marker id="c11d2-cp-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--viz-muted)"/></marker></defs>
<rect x="6" y="30" width="64" height="30" rx="7" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="38" y="49" font-size="12" text-anchor="middle" font-weight="700">Source A</text>
<rect x="6" y="120" width="64" height="30" rx="7" stroke-width="1.5" style="fill: var(--viz-c7-soft); stroke: var(--viz-c7)"/>
<text x="38" y="139" font-size="12" text-anchor="middle" font-weight="700">Source B</text>
<rect x="104" y="30" width="56" height="30" rx="7" stroke-width="1.5" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="132" y="49" font-size="12" text-anchor="middle" font-weight="700">Map</text>
<rect x="190" y="60" width="80" height="56" rx="8" stroke-width="1.6" style="fill: var(--viz-c2-soft); stroke: var(--viz-c2)"/>
<text x="230" y="84" font-size="12" text-anchor="middle" font-weight="700">Window</text>
<text x="230" y="100" font-size="12" text-anchor="middle" font-weight="700">count</text>
<rect x="300" y="72" width="52" height="30" rx="7" stroke-width="1.5" style="fill: var(--viz-c8-soft); stroke: var(--viz-c8)"/>
<text x="326" y="91" font-size="12" text-anchor="middle" font-weight="700">Sink</text>
<path d="M70,45 L100,45" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-cp-n)"/>
<path d="M160,45 L186,72" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-cp-n)"/>
<path d="M70,135 L186,103" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-cp-n)"/>
<path d="M270,88 L296,88" stroke-width="1.6" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-cp-n)"/>
<circle cx="78" cy="45" r="3.5" style="fill: var(--viz-c6)"/><circle cx="95" cy="45" r="3.5" style="fill: var(--viz-c6)"/>
<circle cx="168" cy="54" r="3.5" style="fill: var(--viz-c6)"/>
<circle cx="94" cy="128" r="3.5" style="fill: var(--viz-c6)"/><circle cx="106" cy="125" r="3.5" style="fill: var(--viz-c6)"/><circle cx="147" cy="114" r="3.5" style="fill: var(--viz-c6)"/><circle cx="164" cy="109" r="3.5" style="fill: var(--viz-c6)"/>
<line x1="86" y1="36" x2="86" y2="54" stroke-width="3" stroke-linecap="round" style="stroke: var(--viz-c1)"/>
<text x="86" y="24" font-size="12" text-anchor="middle" style="fill: var(--viz-c1)">n+1</text>
<line x1="175" y1="73" x2="187" y2="61" stroke-width="3" stroke-linecap="round" style="stroke: var(--viz-c1)"/>
<text x="180" y="56" font-size="12" text-anchor="end" style="fill: var(--viz-c1)">n</text>
<line x1="125" y1="129" x2="121" y2="111" stroke-width="3" stroke-linecap="round" style="stroke: var(--viz-c1)"/>
<text x="127" y="148" font-size="12" text-anchor="middle" style="fill: var(--viz-c1)">n</text>
<path d="M40,176 L40,212 A140,8 0 0 0 320,212 L320,176" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<ellipse cx="180" cy="176" rx="140" ry="8" stroke-width="1.5" style="fill: var(--viz-node); stroke: var(--viz-node-stroke)"/>
<text x="180" y="198" font-size="12" text-anchor="middle" font-weight="700">checkpoint n (durable storage)</text>
<text x="180" y="213" font-size="12" text-anchor="middle" style="fill: var(--viz-muted)">offsets + operator state</text>
<path d="M38,152 L58,170" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-cp-n)"/>
<path d="M230,118 L224,164" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-cp-n)"/>
<path d="M326,104 L304,168" stroke-width="1.5" stroke-dasharray="4 3" style="fill: none; stroke: var(--viz-muted)" marker-end="url(#c11d2-cp-n)"/>
<text x="321" y="148" font-size="12" style="fill: var(--viz-muted)">ack</text>
<text x="180" y="244" font-size="12" text-anchor="middle">Window count snapshots once barrier n has</text>
<text x="180" y="262" font-size="12" text-anchor="middle">arrived on both inputs, then forwards it</text>
</svg>`,
          caption: "Consistent snapshots without stopping the stream, in the style of Chandy-Lamport. Records ahead of barrier n are in the snapshot; records behind it are replayed after a failure, because the snapshot also holds each source's offset at the moment it injected the barrier.",
        },
        {
          type: "text",
          html: `<h3>Where the guarantee stops</h3>
<p>Both techniques give exactly-once semantics <em>inside</em> the framework. Once output leaves it, as a row written to a database, a message to an external broker or an email, the framework can't discard the output of a failed attempt, and restarting the task repeats the side effect.</p>
<p>The remedy is <strong>atomic commit</strong>: when processing an event succeeds, all of its outputs and side effects take effect, and when it fails, none of them do. That covers messages to downstream operators and external systems (emails and push notifications included), database writes, operator state changes, and the acknowledgment of input, which in a log-based broker means moving the consumer offset. Unlike XA (Chapter 9), these implementations keep the transaction <strong>internal</strong>: the framework manages both the state and the messaging, so it never coordinates heterogeneous technologies, and it amortizes the cost by committing many input messages per transaction. The book cites Google Cloud Dataflow and VoltDB, with support planned for Kafka.</p>
<p>One rule decides what can be made atomic: <strong>the offset must live in the same transactional system as the output</strong>. Kafka transactions make "write these records to Kafka topics and commit these consumer offsets" atomic, because offsets are themselves stored in Kafka. They can't make a PostgreSQL write atomic with anything. For a database sink, either store the consumer offset in the database, in the same local transaction as the output, and seek to it on restart (the visualization's Atomic commit); or use a two-phase-commit sink tied to checkpoints, as Flink does; or make the writes idempotent.</p>
<h3>Idempotence</h3>
<p>An operation is <strong>idempotent</strong> if performing it several times has the same effect as performing it once. Setting a key to a fixed value is idempotent; incrementing a counter is not. A little metadata fixes that: every Kafka message has a persistent, monotonically increasing offset, so the sink can store, next to the value, the offset of the last message applied (per input partition) and skip any update that isn't newer. That is the visualization's Idempotent sink: e4 and e5 were processed twice but applied once. Storm's Trident handles state with a similar idea.</p>
<p>This needs replay in the same order (a log partition guarantees it; a load-balanced queue doesn't), deterministic processing, and no other node concurrently updating the same value. The last one bites during failover, when a task declared dead may still be running (a zombie, <a href="#/ch8/learn/fencing-tokens">Chapter 8</a>) and must be <strong>fenced</strong>. Kafka fences zombie producers using the <code>transactional.id</code> and an epoch: once a new instance registers the same ID, the broker rejects the old one's writes. Chapter 12 extends the idea to end-to-end request IDs.</p>
<h3>Rebuilding state after a failure</h3>
<p>Any operator with state (counters, window aggregates, the tables and indexes behind joins) must get it back after a crash; this is what <strong>stateful stream processing</strong> has to solve. The options trade network, disk and recovery time, and the best one depends on your infrastructure: in some data centers a network round trip is faster than a local disk access, and the network moves data about as fast as a disk does.</p>`,
        },
        {
          type: "table",
          title: "Ways to recover operator state",
          headers: ["Approach", "How it works", "Used by", "Cost"],
          rows: [
            ["Remote datastore", "State lives in a replicated database; every event reads and writes it over the network", "Hand-rolled consumers", "A network round trip per event; the store must absorb the full write rate"],
            ["Local state + snapshots", "State in memory or local RocksDB; periodic snapshots to durable storage (HDFS then, object storage such as S3 today)", "Flink", "Snapshot I/O; recovery restores the last snapshot and replays input since"],
            ["Local state + changelog topic", "Every state change is also written to a log-compacted Kafka topic, like CDC for the operator's own store", "Samza, Kafka Streams", "Extra writes; recovery replays the changelog unless a standby replica is kept warm"],
            ["Redundant processing", "Each input message is processed on several nodes, so a replica already has the state", "VoltDB", "Multiplies compute"],
            ["Recompute from input", "A short window replays its input; a CDC-fed table copy rebuilds from the compacted changelog", "Short-window aggregates, enrichment tables", "Recovery time grows with the window or table size"],
          ],
        },
        {
          type: "realworld",
          items: [
            {
              org: "Apache Flink",
              tag: "checkpoints + 2PC sinks",
              html: "Flink's checkpointing implements asynchronous barrier snapshotting (Carbone et al., 2015), a variant of Chandy-Lamport (1985). Its two-phase-commit sink support, introduced in Flink 1.4 (2017) and expressed through the unified Sink API in newer versions, gives end-to-end exactly-once into Kafka: the sink pre-commits a transaction when a checkpoint is taken and commits it only when the checkpoint completes.",
            },
            {
              org: "Apache Kafka 0.11",
              year: "2017",
              tag: "idempotence + transactions",
              html: "Added the idempotent producer (the broker discards duplicate sends using a producer ID and per-partition sequence numbers) and transactions spanning multiple partitions, including the consumer-offset commit. Consumers with <code>isolation.level=read_committed</code> see only committed messages. Kafka Streams exposes this through its <code>processing.guarantee</code> setting: <code>exactly_once</code>, later <code>exactly_once_v2</code>.",
            },
            {
              org: "Spark Streaming",
              tag: "micro-batches",
              html: "The original Spark Streaming (DStreams) processed micro-batches, typically on the order of a second. Structured Streaming kept micro-batching as its default engine and added an experimental continuous-processing mode in Spark 2.3 (2018) for lower latency.",
            },
            {
              org: "Kafka Streams and Samza",
              tag: "changelog topics",
              html: "Both keep operator state in local stores (RocksDB) and log every state change to a compacted changelog topic in Kafka. After a failure, a new instance rebuilds the store by replaying that changelog; Kafka Streams can keep standby replicas warm to shorten recovery.",
            },
          ],
        },
        {
          type: "callout",
          tone: "warning",
          title: "External side effects are outside the guarantee",
          html: `<p>"Exactly-once" never means the network delivered each message once, and it never covers effects the framework can't roll back: calling a payment API, sending an email or SMS, firing a webhook. After a restore from a checkpoint, whatever those calls did is still done. Protect them by making the external call idempotent, passing a key derived from the event (topic-partition-offset, or an event ID) that the provider uses to ignore repeats, as Stripe's <code>Idempotency-Key</code> header does; or write the request to a transactional output topic and let a separate, idempotent sender perform it. And the guarantee costs latency: output becomes visible only when its checkpoint or transaction commits, so a <code>read_committed</code> consumer downstream waits for the commit interval.</p>`,
        },
        {
          type: "callout",
          tone: "modern",
          title: "Since the book: Kafka transactions and Flink's two-phase-commit sinks",
          html: `<p>The Kafka support the book describes as planned shipped in Kafka 0.11 (June 2017), and Flink's two-phase-commit sinks followed in Flink 1.4 (December 2017), as the cards above describe. Two later changes matter in practice. Since Kafka 3.0 (2021) the producer enables idempotence by default; before that you had to turn it on. And Flink 1.11 (2020) added <strong>unaligned checkpoints</strong>, which let barriers overtake buffered records (storing those records in the checkpoint) so checkpoints stay fast even under heavy backpressure.</p>`,
        },
        {
          type: "callout",
          tone: "interview",
          title: "Interview angle: exactly-once into a database",
          html: `<p>Asked "how do you get exactly-once from Kafka into Postgres?", don't say "turn on Kafka transactions": they stop at Kafka's boundary. A strong answer picks one of three designs and names its requirement. (1) Store the consumer offset in Postgres, in the same transaction as the output rows, and seek to it on startup. (2) Make the writes idempotent: upsert by a natural key, or keep the last applied offset per partition beside each row and skip older ones; this needs ordered replay and fencing of zombie consumers. (3) Use a framework sink with two-phase commit tied to checkpoints, accepting that output is delayed until the checkpoint completes. Then add the caveats: emails and payment calls need idempotency keys of their own, and "exactly-once" means effectively-once.</p>`,
        },
        {
          type: "quiz",
          q: "A Flink job with exactly-once checkpointing sends a welcome email for each <code>UserSignedUp</code> event by calling an email API directly. The job crashes and restores from its last completed checkpoint. What happens?",
          options: [
            "Every user gets exactly one email, because the job runs with exactly-once semantics",
            "Users whose events were processed after the last completed checkpoint may get a second email",
            "Those users get no email at all, because their events are discarded with the failed attempt",
            "Flink rolls back the emails sent since the checkpoint, then sends them again",
          ],
          answer: 1,
          explain: "On restore, Flink rewinds state and input offsets to the checkpoint and replays everything after it, so those events trigger their emails again; nothing already sent to the outside world can be recalled. Exactly-once covers Flink's own state and transactional sinks. For the email, pass an idempotency key derived from the event, or write the request to a transactional sink that feeds an idempotent sender. The first option is the tempting one: it confuses 'state is restored exactly once' with 'side effects happen once'.",
        },
      ],
    },
  ],

  takeaways: [
    "<strong>A stream is just unbounded data.</strong> The hard parts are delivery (who gets each event, and what happens on overload and crashes), time (when is a window complete?) and failure (how do you avoid losing or doubling effects?).",
    "<strong>Queue-style brokers delete on acknowledgment and load-balance message by message; log-based brokers keep an ordered, partitioned log</strong> and let each consumer group move its own offset. Replay and new consumers become free, but parallelism is capped at the partition count.",
    "<strong>Never keep two systems in sync with dual writes:</strong> races and partial failures cause permanent, silent divergence. Make one database the leader and derive everything else from its ordered change log (CDC, or the outbox pattern).",
    "<strong>Event sourcing stores business-level facts instead of current state.</strong> Commands are validated before they become events, and every view, including ones invented later, is a deterministic fold over the log.",
    "<strong>Mutable state is the integral of a change stream.</strong> Keeping the immutable log lets you rebuild, audit and serve many read-optimized views (CQRS), at the cost of storage and of making true deletion hard.",
    "<strong>Window by event time, not processing time.</strong> A watermark is a heuristic about completeness, so decide explicitly whether stragglers are dropped (and counted) or used to correct results.",
    "<strong>Every streaming join keeps state:</strong> a window of both streams, a local copy of a table kept fresh by CDC, or both tables. Because that state changes over time, a join can give different answers on replay unless each event is pinned to the version valid at its event time, which rules out compacting old versions away.",
    "<strong>\"Exactly-once\" means effectively-once:</strong> commit output, state and offsets atomically (checkpoints, transactions) or make writes idempotent, and remember that external side effects such as emails and payment calls are outside the guarantee.",
  ],

  connections: [
    { to: "ch1", html: "Chapter 1's composite data system (a database, a cache and a search index glued together by application code) is exactly what CDC keeps in sync without dual writes, and Twitter's home timelines are a stream-maintained materialized view: the tweets-by-follows join kept up to date incrementally." },
    { to: "ch2", html: "Event sourcing and CQRS defuse Chapter 2's normalization debate: keep one log as the record and derive as many denormalized read views as you need, each rebuilt mechanically rather than kept in step by hand." },
    { to: "ch3", html: "Kafka's partitions are log-structured storage, and log compaction in the broker mirrors SSTable and LSM-tree compaction. Materialized views come back as stream-maintained views." },
    { to: "ch4", html: "Message brokers and actors are Chapter 4's asynchronous dataflow modes. Long-lived event logs make Avro or Protobuf schema evolution, and schema registries, essential." },
    { to: "ch5", html: "CDC is logical (row-based) replication exposed to the outside world. Consumers of a log behave like followers, and derived views suffer the same replication-lag anomalies, such as read-your-writes." },
    { to: "ch6", html: "Partitioning topics by key, hot keys, remapping keys when partitions are added, and co-partitioning inputs for joins all reuse Chapter 6's partitioning ideas." },
    { to: "ch7", html: "The outbox pattern relies on a local ACID transaction; one single-threaded consumer per partition is actual serial execution; event sourcing replaces multi-object transactions with single self-contained events." },
    { to: "ch8", html: "Event time depends on clocks that may be skewed (hence the three-timestamp correction), and zombie stream tasks after a failover need fencing, just like fencing tokens." },
    { to: "ch9", html: "A partitioned log is total order broadcast per partition. Kafka and Flink transactions are an internal, amortized form of atomic commit that avoids XA-style two-phase commit across heterogeneous systems." },
    { to: "ch10", html: "Stream processing is batch processing on unbounded input: the same dataflow operators and immutable inputs. Stream-table joins are map-side hash joins kept fresh by CDC, and microbatching borrows batch fault tolerance." },
    { to: "ch12", html: "Chapter 12 builds on this one: unbundling the database into logs and derived views, lambda versus kappa architectures, enforcing constraints through streams, and end-to-end idempotence with operation IDs." },
  ],

  furtherReading: [
    { title: "Jay Kreps, \"The Log: What every software engineer should know about real-time data's unifying abstraction\" (2013)", url: "https://www.linkedin.com/blog/engineering/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying", note: "The essay behind Kafka's design: why a log is the right primitive for data integration, replication and stream processing." },
    { title: "Kreps, Narkhede and Rao, \"Kafka: a Distributed Messaging System for Log Processing\" (NetDB 2011)", note: "The original Kafka paper: pull-based consumers, offsets instead of per-message acknowledgments, sequential I/O." },
    { title: "Apache Kafka documentation: Design", url: "https://kafka.apache.org/documentation/#design", note: "The official explanation of persistence, consumer position, log compaction and delivery semantics." },
    { title: "Tyler Akidau, \"Streaming 101: The world beyond batch\" (O'Reilly, 2015)", url: "https://www.oreilly.com/radar/the-world-beyond-batch-streaming-101/", note: "The clearest introduction to event time, processing time, windows and watermarks, by an author of MillWheel and Dataflow." },
    { title: "Akidau et al., \"The Dataflow Model\" (VLDB 2015)", note: "Formalizes windowing, watermarks and triggers; the foundation of Apache Beam." },
    { title: "Carbone et al., \"Lightweight Asynchronous Snapshots for Distributed Dataflows\" (2015)", url: "https://arxiv.org/abs/1506.08603", note: "How Flink takes consistent checkpoints with barriers without stopping the stream." },
    { title: "Martin Fowler, \"Event Sourcing\" (2005)", url: "https://martinfowler.com/eaaDev/EventSourcing.html", note: "The classic description of the pattern, with snapshots and replay." },
    { title: "Martin Fowler, \"The LMAX Architecture\" (2011)", url: "https://martinfowler.com/articles/lmax.html", note: "A real exchange built on in-memory state rebuilt from an event journal." },
    { title: "Pat Helland, \"Immutability Changes Everything\" (CIDR 2015)", note: "Why append-only data shows up everywhere, and why the database can be seen as a cache of the log." },
    { title: "Das et al., \"All Aboard the Databus!\" (ACM SoCC 2012)", note: "LinkedIn's production change data capture system, including the bootstrap (snapshot) problem." },
    { title: "Debezium documentation", url: "https://debezium.io/", note: "Practical CDC: snapshots, connectors for the major databases, and the outbox event router." },
    { title: "Martin Kleppmann, \"Making Sense of Stream Processing\" (O'Reilly, 2016)", note: "A short book by DDIA's author that expands this chapter's ideas: logs, CDC, event sourcing and turning the database inside out." },
    { title: "Ananthanarayanan et al., \"Photon: Fault-tolerant and Scalable Joining of Continuous Data Streams\" (SIGMOD 2013)", note: "Google's production stream-stream join of search queries and ad clicks across data centers." },
  ],
});
