# dsh-context-graph

A DeepSeek Harness (dsh) plugin that remembers your past conversations as a small graph.
New sessions start with a one-screen map of what was decided before, each turn gets the few
nodes that match what you just asked, and the model fetches the verbatim original text only
when it needs it. Old messages stop being re-sent; decisions stop getting lost.

Status: v0.1.0, not yet run inside a real dsh. Unit and wiring tests pass against the
published `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools` packages.

## What it does

| Moment | What happens | Cost |
|---|---|---|
| Every 4 human turns (default) | After the turn closes, one small auxiliary model call indexes the new messages into `.context-graph/graph.json` and stores the cited messages verbatim under `.context-graph/src/`. | about the span's tokens in, under 1k out, off the critical path |
| First human turn of a session | A `[context-graph]` block lists the best-connected nodes from earlier sessions: id, label, one-line gist. | about 15 tokens per node, 40 nodes max |
| Every human turn | The prompt is matched against node labels and aliases by word overlap (no model call). Up to 5 hits are appended to the message. One clearly dominant short hit is included verbatim. | under about 150 tokens |
| Model calls `recall(id)` | Returns the node's verbatim source text and its neighbours. | one tool round trip |
| `/context-graph` | `stats` (graph size, builder spend, injected tokens, cache-hit rate), `build` (index now), `find <words>`. | none |

Design rules, in order of importance:

1. **Nothing is written without its source.** A node is stored only together with the verbatim
   messages it was drawn from. The gist is a pointer, never the record.
2. **The provider's prefix cache survives.** Injected blocks ride at the end of the newest user
   message. Stock compaction is untouched; this plugin never rewrites earlier context.
3. **Old decisions resolve to new ones.** A `supersedes` edge makes a hit on the old node show
   the replacement instead.
4. **Matching is lexical.** Labels, aliases and gists; English words, identifiers and Chinese
   bigrams. The builder is asked to write aliases precisely so this works without embeddings.

The full design, including what was borrowed from `dsh-plugin-save-token` and why cache
economics make cross-session memory the main win, is in [docs/core-design.md](docs/core-design.md).

## Install

Desktop app: **Plugins → Add plugin**, official npm registry, enter
`github:William20100221/dsh-context-graph`, install, restart if asked.

Command line:

```sh
dsh plugin --profile web add github:William20100221/dsh-context-graph
```

Or a local checkout:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-context-graph
```

Remove with `dsh plugin --profile web remove dsh-context-graph`.

## Configuration

Defaults live in [cordis.patch.yml](cordis.patch.yml). A patch replaces the row's whole
`config`, so restate every key you keep.

| Key | Default | Meaning |
|---|---|---|
| `dir` | `.context-graph` | Graph folder, relative to the agent workspace or absolute |
| `buildEveryTurns` | `4` | Index after this many new human turns |
| `buildMinChars` | `400` | ...and at least this much new text |
| `maxHits` | `5` | Nodes shown per human turn |
| `inlineMaxChars` | `1200` | A single dominant hit this short is shown verbatim |
| `surfaceMaxNodes` | `40` | Nodes listed at the start of a session |
| `builderMaxTokens` | `2048` | Output cap for the indexing call |
| `provider`, `model` | `''` | Empty: reuse the conversation's routed provider and model |

## Files

```
index.js          dsh plugin: builder, matcher, recall tool, meter, /context-graph command
graph.js          pure core: tokenize, match, merge, render, builder prompt and parser
store.js          graph.json and src/<id>.md read/write
cordis.patch.yml  mounts the plugin at the profile root with default config
test/             node --test; plugin.test.js needs DSH_NODE_MODULES (see below)
docs/             design
```

## Testing

Unit tests need nothing:

```sh
node --test test/graph.test.js
```

The wiring test imports the real dsh packages from an existing dsh install. Point it at that
install's `node_modules`:

```sh
DSH_NODE_MODULES=/path/to/dsh/node_modules npm test
```

Without the variable it is skipped. Nothing here calls a model.

## Known limits

- Builds are indexed per process; after a restart the first build of a resumed session re-reads
  its whole surface. Existing ids are reused, so this costs one larger call, not duplicates.
- Two agents writing the same workspace graph at once: last writer wins.
- Subagent sessions are neither indexed nor given memory blocks.
- Tool outputs are not indexed. For large tool output, use `dsh-plugin-save-token` alongside.
