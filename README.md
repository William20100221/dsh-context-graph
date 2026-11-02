# dsh-context-graph

A DeepSeek Harness (dsh) plugin that gives each chat a small memory graph you switch on when you
want it. Other chats in the same workspace then get a short pointer to what was decided before, and
the model fetches the exact original text only when it needs it. Old messages are not re-sent;
decisions are not lost.

First principle: save input tokens without losing quality. The plugin adds nothing to a request
unless you turned memory on in that chat, and what it adds is a few lines that point at exact text.

Status: v0.4.0. Loads in the dsh desktop app (dsh 0.2.1-rc.5); not yet verified with a live model.
Tests pass against the published dsh packages.

Using Claude Code instead? The Claude version is a separate plugin built for Claude's app:
[claude-context-graph](https://github.com/William20100221/claude-context-graph).

## How it works

Nothing happens in a chat until you run `/context-graph on`. From then on:

| Moment | What happens | Cost |
|---|---|---|
| `/context-graph on` | The chat is indexed now, then again every 4 human turns: one small auxiliary model call writes topics into `.context-graph/chats/<chat>/graph.json` and stores the cited messages verbatim. | about the new text's tokens in, under 1k out, off the critical path |
| First message after `on` | One block lists the shared chats of this workspace, newest first: chat id, date, title, topic count. | about 15 tokens per chat |
| Every human message | Your words are matched against the topics of the other shared chats by word overlap (no model call). Up to 5 hits are appended to the message. One clearly dominant short hit is included verbatim. | under about 150 tokens |
| Your message names a time | "yesterday", "last week", "11月1日", "2026-11-01" ... that slice is searched first: chats active then, then topics from then, then everything. If nothing matches, the chats from that time are listed instead. | same |
| Model calls `recall(id)` | `c3n12`: the topic's verbatim source and linked topics. `c3`: a chat's topics. `2026-11-01`: every chat and topic from that day. `t7`: turn 7 of this chat word for word. | one tool round trip |
| `/context-graph share` | Lets other chats in the workspace see this chat's graph. Nothing is copied or merged; it is a flag on the chat. | none |

Design rules, in order:

1. **Off until asked.** No surface map, no matches, no indexing in a chat that has not run `on`.
2. **Nothing is written without its source.** A topic is stored only together with the verbatim
   messages it was drawn from. The gist is a pointer, never the record.
3. **Organise, never merge.** Each chat's graph stays in its own folder with its own dates. Sharing
   is a flag. Ids carry the chat number (`c3n12`) so every topic traces back to its chat.
4. **Time is the first filter.** A named day or week narrows the search before anything else.
5. **Append at the end.** Injected blocks ride at the tail of the newest message so the provider's
   prefix cache survives. Hiding or folding old turns is not this plugin's job.

## Commands

Type `/context-graph`, pick it from the menu, then type the word:

| Command | Does |
|---|---|
| `on` / `off` | Start or stop memory for this chat. `off` keeps the graph file. |
| `share` / `unshare` | Let other chats in the workspace use this chat's graph, or stop. |
| `stats` (default) | Memory state, topic counts, shared chats, pending turns, token counters. |
| `build` | Index this chat now. |
| `map` | Every chat in the workspace, newest first, with its top topics. |
| `find <words>` | Search the shared chats; time words narrow it. |

Results show in dsh's own command card: a one-line summary that expands to the details.

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

## Configuration

Defaults live in [cordis.patch.yml](cordis.patch.yml). A patch replaces the row's whole
`config`, so restate every key you keep.

| Key | Default | Meaning |
|---|---|---|
| `dir` | `.context-graph` | Memory folder, relative to the agent workspace or absolute |
| `buildEveryTurns` | `4` | Index after this many new human turns (chats with memory on) |
| `buildMinChars` | `400` | ...and at least this much new text |
| `maxHits` | `5` | Topics shown per human turn |
| `inlineMaxChars` | `1200` | A single dominant hit this short is shown verbatim |
| `surfaceMaxChats` | `20` | Chats listed right after `on` |
| `builderMaxTokens` | `8192` | Output cap for the indexing call; thinking models spend part of it reasoning |
| `provider`, `model` | `''` | Empty: reuse the conversation's routed provider and model |

## Files

```
index.js          dsh plugin: builder, matcher, recall tool, meter, /context-graph command
graph.js          pure core: tokenize, match, time ranges, merge, render, builder prompt and parser
store.js          chats/<chat>/{meta.json, graph.json, src/<id>.md}
update.js         once-per-start check of npm for a newer version
lib/client.js     dsh chat card for /context-graph (DisclosureRow, en/zh titles)
icon.svg          Plugins page icon in dsh's built-in icon style
locale/           Plugins page title and description (en, zh); zh links README.zh.md
cordis.patch.yml  mounts the plugin at the profile root with default config
test/             node --test; plugin.test.js needs DSH_NODE_MODULES (see below)
```

On disk, per workspace:

```
.context-graph/chats/<sessionId>/meta.json    cid, title, startedAt, lastActiveAt, turns, memory, shared
.context-graph/chats/<sessionId>/graph.json   topics and links; every topic has its time
.context-graph/chats/<sessionId>/src/<id>.md  verbatim messages behind each topic
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

- Builds are indexed per process; after a restart the first build of a resumed chat re-reads its
  whole surface. Existing ids are reused, so this costs one larger call, not duplicates.
- Two agents writing the same chat's graph at once: last writer wins.
- Subagent sessions are neither indexed nor given memory blocks.
- Tool outputs are not indexed as topics; `recall("tN")` returns them (each capped at 2000 characters).
- The chat title is the first message, shortened, until dsh exposes its own titles to plugins.
- The graph page (a visual map in the sidebar) is not built yet; `/context-graph map` is the text version.
