# Architecture

dsh-context-graph gives every DeepSeek Harness (dsh) chat a small memory: a graph of the decisions,
facts and artifacts it settled, plus a one-line summary, readable by the other chats of the same
workspace. A later chat reads a few lines and follows ids to the exact text only when it needs it.
This page explains how the code is organised and the rules every layer keeps.

## Layers

```
index.js            package entry for dsh: re-exports name, inject, apply
src/core/           pure logic: no I/O, no dsh imports, fully testable with node --test
  text.js             tokenize (NFKC, any alphabet, plurals folded, identifiers split, CJK bigrams without particles), estimateTokens, clipTokens
  chat.js             SOURCE_KIND, memoryOn, sharedOn
  graph.js            the per-chat topic graph (v2), mergeDelta, normalizeGraph, caps
  time.js             parseTimeRange (calendar days, real dates, relative days and weeks), asksAboutPast, day
  match.js            the relevance gate (matchAcross, over a word index per graph), chat ranking for the list
  ledger.js           the savings estimate: counters, balance, what counts as used, the card's lines
  tree.js             the memory as the tree the Memory tree page draws: chats newest first, topics by kind
  labels.js           chat types, projects and parts (#94): how a message names them, how they order hits
  subjects.js         the subject layer (#96): which subjects a message names, the layered search, the hint
  render.js           every text the plugin writes into a chat or a card; fence, formatSource
  builder.js          the indexing prompt (fixed rules first), planSpan, the tolerant answer parser
  session.js          reading dsh session events: spans (typed prompts, goal rounds, reminders, answers, approved plans), dsh's turn numbers, titles, lean turns, what was already shown
src/store/          files on disk under <workspace>/.context-graph
  files.js            readJsonCached (stat-keyed, frozen), readJson / readJsonDetailed (repair, quarantine), writeJson (atomic), locked
  chats.js            folder layout, meta reads (fail closed) and updates, chat numbers, root-layout migration
  messages.js         the verbatim messages topics cite, each stored once
  ledger.js           the savings ledger (one small file per chat)
  migrate.js          upgrade of 0.4-0.6 chat folders
src/host/           dsh wiring, one module per job, composed by plugin.js
  runtime.js          agent -> folder, meta, fork points, views of the workspace (all chats, or one by number)
  builder.js          agent/turn-stopping and the quiet timer: the indexing call (lowest effort, pinned retries)
  memory.js           agent/pre-step: the block appended to a human turn
  recall.js           the recall tool (topics, chats, days, turns via sessionQuery)
  command.js          /context-graph
  page.js             owner-only routes for the savings page in Plugins and the Memory tree page (totals, tree, topic)
  meter.js            llm/stream usage buckets
  update.js           npm update check
src/client/         the browser module dsh loads (hand-written, no build step): the command card, the savings page in
                    Plugins, and Memory tree (a sidebar entry and its page; the tree is laid out here, because it
                    changes as branches open and close)
```

Dependencies point downward only: host -> store -> core, host -> core, client stands alone.

## Data on disk

```
<workspace>/.context-graph/
  chats/<sessionId>/meta.json    cid, title (dsh's own), summary, firstKey (first prompt's fingerprint), dates, builtSeq, flags (memoryOff, private), gaps (off stretches), fork info (forkSeq, parent, offsInherited)
  chats/<sessionId>/topics.json  { version: 2, nextId, nodes: { nN: { label, gist, aliases, kind, refs, at, updated } }, edges }
  chats/<sessionId>/msgs.json    { v: 2, m: { "<seq>": { r, t, a, x } } }: each cited message once, t = dsh's turn number (v 1, up to 0.9.0, counted typed prompts: converted from the log at the next build or topic recall, its turn ids shown nowhere until then)
  chats/.cid/<n>                 claim files: chat number n is taken
  ledger/<sessionId>.json        { v: 2, c: counters, used: [ids], chats: ["c3"] }: one chat's savings estimate, zeros and empty lists left out (chats: earlier chats whose history it already counted, each once, #104); kept when the chat's memory is deleted (#107)
  ledger.json                    only from v0.9.0: read, never written; a chat's file starts from its entry there
  chats/<sessionId>/graph.json, src/   only from v0.1-v0.6: unchanged backup, removed 7 quiet days after the last write
```

A chat gets its folder when it is first indexed; a fork when it is first seen, so the flags it
inherits hold from its first message, and its ancestors' off stretches up to the fork point become
its first gaps. `refs` are seqs of the chat's own dsh session log.
Whole turns stay in dsh's log, which the plugin reads (sessionQuery) but never writes.

## The memory tree

| Layer | What the model sees | How it gets there |
|---|---|---|
| Chat | `c3 <one-line summary>` for each earlier chat with topics | once per chat, with its first block or first question about earlier work, ranked by that message, within 200 tokens |
| Topic | `- c3n12 label: gist` | injected when the prompt passes the relevance gate |
| Source | the newest 3 cited messages, capped, each naming its turn (`c3t7`) | `recall("c3n12")`; inlined only for a clearly leading, short hit |
| Turn | prompt, answers, one line of tool use, about 2,000 tokens | `recall("c3t7")` from dsh's log (or `t7` in this chat) |

Side doors: `recall("c3")` lists a chat's topics, `recall("2026-11-01")` a day's chats; a question
about a time with no topic hit gets a small digest of the chats from then.

## Rules every layer keeps

1. **Nothing is written without its source.** A topic is stored only when it cites a message of the
   indexed span, and that message is stored with it.
2. **Append at the end only.** Memory blocks ride at the end of the newest request, so the
   provider's prefix cache survives. The plugin never rewrites earlier context. The indexing prompt
   is ordered from most to least stable for the same reason.
3. **Evidence before tokens.** A topic is sent only when the message shares enough words with it,
   once per chat, and never as a filler for a slot. The chat list rides only with a block that has
   evidence or a question about earlier work, and a day digest only with a question about that day.
4. **Quoted data, not instructions.** Text from other chats is labelled as data and source text is
   fenced.
5. **One damaged file stays local and is never overwritten blind.** Trailing junk is repaired; an
   unreadable file is set aside (`.corrupt-<time>`); a chat whose meta was lost reads as private
   with memory off until it is written again.
6. **Commit order.** Text first, then the graph that points at it, then the index position.
7. **Opt-out is complete.** With memory off, a chat gets no blocks and cannot recall other chats,
   nor can a subagent it started, at any depth. What it typed while off is a gap that is never
   indexed, served or stored (not as a title, also after a damaged meta is repaired; not as the
   first prompt, which is kept only as a fingerprint), also after `on`; so is a goal set there (all
   its rounds, also in a fork made later), a reminder scheduled there and an answer to a question
   asked there; a turn begun while off is private as a whole, and `on` while a turn runs or typed
   input is queued takes effect when the chat is idle. A fork is private from its first message
   when its parent is, and memory-off when its parent's memory was off at the fork point (its
   parent is the one dsh names, followed up dsh's chain of forks; by content only where dsh names
   none); it takes no title from its parent. A chat's turns are readable by others only up to
   where it was indexed, and only what its log shows was not private, judged from the off
   stretches the way indexing judges them (what dsh drove from one is found there, never stored as
   a gap); a fork never exposes what it inherited: not its turns, nor topics drawn only from them
   (a fork indexed by 0.4-0.6 is left out of matching until its fork point is known, also when
   dsh's session listing fails, #58).
8. **Upgrades are non-destructive.** New data goes to new files; old files stay as a timed backup.

## Tests

```
node --test "test/core/*.test.js" "test/store/*.test.js"     # pure and disk layers
DSH_NODE_MODULES=<dsh>/node_modules npm test                 # everything, host layer included
DSH_NODE_MODULES=<dsh>/node_modules npm run test:zones       # everything, in three time zones
```

`test/e2e/` boots dsh's own runtime (cordis, sessions, agent loop, commands, `/goal`) with a
scripted provider and the plugin, so the contracts the plugin relies on are checked against dsh
itself; it is skipped where `DSH_NODE_MODULES` has no dsh runtime.

`DSH_NODE_MODULES` points at any dsh install's `node_modules`; the host tests import the real
`@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools` from there. `test/fixtures/relevance-corpus.js`
is the fixed corpus the relevance gate is held to (precision, recall and tokens).
