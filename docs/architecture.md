# Architecture

dsh-context-graph gives every DeepSeek Harness (dsh) chat a small memory: a graph of the decisions,
facts and artifacts it settled, readable by the other chats of the same workspace. A later chat
reads a few lines and follows ids to the exact text only when it needs it. This page explains how
the code is organised and the rules every layer keeps.

## Layers

```
index.js            package entry for dsh: re-exports name, inject, apply
src/core/           pure logic: no I/O, no dsh imports, fully testable with node --test
  text.js             tokenize, estimateTokens, textOf
  chat.js             SOURCE_KIND, memoryOn, sharedOn
  graph.js            the per-chat topic graph (v2), mergeDelta, normalizeGraph, caps
  time.js             parseTimeRange, day
  match.js            matchNodes (one graph), matchAcross (a workspace)
  render.js           every text the plugin writes into a chat or a card; fence, formatSource
  builder.js          the indexing prompt and the tolerant answer parser
  session.js          reading dsh session events: spans, turns, titles, what was already shown
src/store/          files on disk under <workspace>/.context-graph
  files.js            readJson (tolerant), writeJson (atomic), locked (per-key serialization)
  chats.js            folder layout, meta updates, chat numbers, root-layout migration
  messages.js         the verbatim messages topics cite, each stored once
  migrate.js          upgrade of 0.4-0.6 chat folders
src/host/           dsh wiring, one module per job, composed by plugin.js
  runtime.js          agent -> folder, meta, views of the workspace
  builder.js          agent/turn-stopping: the indexing call
  memory.js           agent/pre-step: the block appended to a human turn
  recall.js           the recall tool
  command.js          /context-graph
  meter.js            llm/stream usage buckets
  update.js           npm update check
src/client/         the browser module dsh loads (hand-written, no build step)
```

Dependencies point downward only: host -> store -> core, host -> core, client stands alone.

## Data on disk

```
<workspace>/.context-graph/
  chats/<sessionId>/meta.json    cid, title, dates, turns, builtSeq, flags (memoryOff, private), fork info
  chats/<sessionId>/topics.json  { version: 2, nextId, nodes: { nN: { label, gist, aliases, kind, refs, at, updated } }, edges }
  chats/<sessionId>/msgs.json    { v: 1, m: { "<seq>": { r, t, a, x } } }: each cited message once
  chats/.cid/<n>                 claim files: chat number n is taken
  chats/<sessionId>/graph.json, src/   only from v0.1-v0.6: unchanged backup, removed 7 days after the upgrade
```

`refs` are seqs of the chat's own dsh session log. The full turns stay in dsh's own log, which the
plugin never writes.

## The memory tree

| Layer | What the model sees | How it gets there |
|---|---|---|
| Workspace | the list of other chats (first message of a chat) | injected automatically |
| Chat | a chat's topics | `recall("c3")`, or a day: `recall("2026-11-01")` |
| Topic | label + one-line gist (`c3n12 ...: ...`) | injected when the prompt matches |
| Source | the exact messages a topic was drawn from | `recall("c3n12")`, or inlined for one short dominant hit |
| Turn | a whole turn of this chat | `recall("t7")` |

Planned (issues #25-#34, milestone v0.8.0): a one-line summary per chat as the top layer, relevance
weighting, and `recall("c3t7")` for whole turns of other chats read from dsh's own log.

## Rules every layer keeps

1. **Nothing is written without its source.** A topic is stored only when it cites a message of the
   indexed span, and that message is stored with it.
2. **Append at the end only.** Memory blocks ride at the end of the newest request, so the
   provider's prefix cache survives. The plugin never rewrites earlier context.
3. **Quoted data, not instructions.** Text from other chats is labelled as data and source text is
   fenced.
4. **One damaged file stays local and is never overwritten blind.** Trailing junk is repaired; an
   unreadable file is set aside (`.corrupt-<time>`); a chat whose meta was lost fails closed.
5. **Commit order.** Text first, then the graph that points at it, then the index position.
6. **Opt-out is complete.** With memory off, a chat gets no blocks and cannot recall other chats.
7. **Upgrades are non-destructive.** New data goes to new files; old files stay as a timed backup.

## Tests

```
node --test test/core test/store                                   # pure and disk layers
DSH_NODE_MODULES=<dsh>/node_modules npm test                       # everything, host layer included
```

`DSH_NODE_MODULES` points at any dsh install's `node_modules`; the host tests import the real
`@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools` from there.
