# dsh-context-graph

A DeepSeek Harness (dsh) plugin that remembers your past conversations as a small graph.
New sessions start with a one-screen map of what was decided before, each turn gets the few
nodes that match what you just asked, and the model fetches the verbatim original text only
when it needs it. Old messages stop being re-sent; decisions stop getting lost.

**Folding (v0.2.0).** Every chat normally re-sends all earlier messages on every turn. Once the
older part of a chat costs more than `foldAtTokens` per request, the plugin replaces it with one
short table of contents: the topics found in it and a one-line list of what you asked in each
turn (t1, t2, ...). The model follows that table to the exact part it needs with `recall("t7")`
or `recall("n12")`. Your newest turns stay word for word. Nothing is deleted: the full turns stay
in the session log and in the chat window.

**Looks like dsh (v0.3.0).** The Plugins page shows the plugin's own icon in dsh's icon style, a
title and description in English or Chinese (上下文图谱), and a Chinese detail page. In chat,
`/context-graph` results appear in dsh's own command card: a titled row with a one-line summary
that expands to the details.

Status: v0.3.0. Installs and loads in the dsh desktop app (dsh 0.2.1-rc.5); folding and indexing
are not yet verified with a live model. 28 tests pass against the published dsh packages.

Using Claude Code instead? The Claude version is a separate plugin built for Claude's app:
[claude-context-graph](https://github.com/William20100221/claude-context-graph).

## What it does

| Moment | What happens | Cost |
|---|---|---|
| Every 4 human turns (default) | After the turn closes, one small auxiliary model call indexes the new messages into `.context-graph/graph.json` and stores the cited messages verbatim under `.context-graph/src/`. | about the span's tokens in, under 1k out, off the critical path |
| First human turn of a session | A `[context-graph]` block lists the best-connected nodes from earlier sessions: id, label, one-line gist. | about 15 tokens per node, 40 nodes max |
| Every human turn | The prompt is matched against node labels and aliases by word overlap (no model call). Up to 5 hits are appended to the message. One clearly dominant short hit is included verbatim. | under about 150 tokens |
| Older part of this chat costs more than 24k tokens per request | At the start of your next turn it is replaced by a table of contents (topics plus one line per turn). The last 2 turns stay as they are. | breaks the provider cache once per fold, then every later request is smaller |
| Model calls `recall(id)` | `n12`: the topic's verbatim source and neighbours. `t7`: folded turn 7 exactly, including tool calls. | one tool round trip |
| `/context-graph` | `stats`, `build` (index now), `fold` (index and fold now), `find <words>`. | none |

Design rules, in order of importance:

1. **Nothing is written without its source.** A node is stored only together with the verbatim
   messages it was drawn from. The gist is a pointer, never the record.
2. **Fold in batches, not every turn.** DeepSeek bills re-sent cached input at about 1/30 price,
   and any fold restarts that cache. So a fold happens only when the old part is large
   (24k tokens by default) and the table of contents is under half its size. Between folds the
   prefix stays stable and cached. Matcher blocks ride at the end of the newest message.
3. **Old decisions resolve to new ones.** A `supersedes` edge makes a hit on the old node show
   the replacement instead.
4. **Matching is lexical.** Labels, aliases and gists; English words, identifiers and Chinese
   bigrams. The builder is asked to write aliases precisely so this works without embeddings.

The full design, including what was borrowed from `dsh-plugin-save-token` and why cache
economics make cross-session memory the main win, is in [docs/core-design.md](docs/core-design.md).

## Install

Desktop app: **Plugins → Add plugin**, official npm registry, enter `dsh-context-graph`,
install, then fully restart the app so the `/context-graph` command appears.

Command line (use the profile your app runs; the desktop app uses `desktop`):

```sh
dsh plugin --profile desktop add dsh-context-graph
```

**Updates.** dsh 0.2.1 desktop builds have no update check for third-party plugins, so the
plugin checks npm itself once per app start. When a newer version exists, your next chat reply
ends with one line saying so, and `/context-graph stats` shows it on its first line. To update:
Plugins, open dsh-context-graph, **Uninstall**, then **Add plugin** `dsh-context-graph@<new version>`
and restart the app. Name the exact version: dsh's pnpm holds back very new releases otherwise.
Turn the check off with the environment variable `DSH_CONTEXT_GRAPH_NO_UPDATE_CHECK=1`.

Remove with `dsh plugin --profile desktop remove dsh-context-graph`.

## Releasing a new version

```sh
npm test
npm version patch
npm publish
git push --follow-tags
```

`npm version patch` bumps the version, commits and tags it. `npm publish` needs `npm login`
once. Users then see the new version after pressing Refresh on the Plugins page.

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
| `builderMaxTokens` | `8192` | Output cap for the indexing call; thinking models spend part of it reasoning |
| `provider`, `model` | `''` | Empty: reuse the conversation's routed provider and model |
| `fold` | `true` | Fold old turns of the current chat into a table of contents |
| `foldAtTokens` | `24000` | Fold once the foldable part costs this much per request |
| `keepTurns` | `2` | Newest human turns never folded |

## Files

```
index.js          dsh plugin: builder, matcher, recall tool, meter, /context-graph command
graph.js          pure core: tokenize, match, merge, render, builder prompt and parser
store.js          graph.json and src/<id>.md read/write
update.js         once-per-start check of npm for a newer version
lib/client.js     dsh chat card for /context-graph (DisclosureRow, en/zh titles)
icon.svg          Plugins page icon in dsh's built-in icon style
locale/           Plugins page title and description (en, zh); zh links README.zh.md
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
- Tool outputs are not indexed as topics, but they are folded and `recall("tN")` returns them (each capped at 2000 characters).
- Only indexed turns are folded. After an app restart the index position resets, so the first fold waits for one build.
- A skill list or runtime-context message inside the folded part is copied into the fold message so the model keeps it.
