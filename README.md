<p align="center">
  <img src="icon.svg" width="72" height="72" alt="Context Graph icon">
</p>

<h1 align="center">Context Graph for DeepSeek Harness</h1>

<p align="center">
  Memory for your chats, on from the moment you install it.<br>
  Later chats get a few lines that point at what was decided; the model fetches the exact text only when it needs it.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-context-graph"><img alt="npm" src="https://img.shields.io/npm/v/dsh-context-graph?label=npm&color=4A65E8"></a>
  <img alt="dsh" src="https://img.shields.io/badge/dsh-0.2.1-7AC2FF">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey">
  <a href="README.zh.md"><img alt="中文" src="https://img.shields.io/badge/文档-中文-4A65E8"></a>
</p>

---

**The problem.** Every message you send re-sends the whole conversation, and a new chat knows
nothing about the last one. You re-explain, the model re-reads, and you pay input tokens for both.

**What this does.** In every chat (memory is on by default), the plugin indexes what was
decided into a small graph of topics, each stored together with the original messages. Other
chats in the same workspace get, at most, a few lines like this appended to your message:

```
[context-graph] Related past context from yesterday (by chat). Call recall(id) for the verbatim source.
- c3n12 builder timeout: builderMaxTokens raised to 8192 after the 524s (2026-11-01)
- c3n4 publish flow: npm version patch, npm publish (2FA), git push --follow-tags (2026-11-01)
```

The model calls `recall("c3n12")` when a gist is not precise enough and gets the original turns,
word for word. Nothing is summarised away, and nothing is sent that you did not ask for.

> **First principle:** save input tokens without losing quality. A few lines per message; exact
> text on demand.
>
> **Turning it off.** Plugins page → Context Graph → switch it off: no chat is indexed or gets
> anything added. To stop only one chat, run `/context-graph off` in it.

## Quick start

1. **Plugins → Add plugin**, official npm registry, type `dsh-context-graph`, install, then fully
   restart the app (new slash commands need a restart).
2. Chat as usual. Every chat indexes itself every 4 turns and is shared with the other chats of
   its workspace. Type `/context-graph`, pick it from the menu, then `build` to index one right away.
3. Open a new chat in the same workspace and ask about something from the first.
4. To keep one chat out of the others, run `/context-graph unshare` in it.

Command line instead of the Plugins page (the desktop app uses the `desktop` profile):

```sh
dsh plugin --profile desktop add dsh-context-graph
```

## Commands

All commands are `/context-graph <word>`. Type `/context-graph`, pick it from the menu, then type
the word. Results show in dsh's own command card: a one-line summary that expands to the details.
No word means `stats`.

### `on` — resume memory for this chat

Memory is already on in every chat. `on` undoes an earlier `off` and indexes the chat right away.

Indexes the chat right away and then again every 4 human turns (one small auxiliary model call
each time, using the chat's own routed model unless you configure another). Creates
`.context-graph/chats/<chat>/` with the chat's graph, its verbatim sources and a `meta.json`
holding its title, dates and flags. From now on every message you send in this chat is matched
against the other shared chats of the workspace, and the first message of the chat also carries the
list of those chats, newest first.

Card: `Memory on · 7 topics in this chat · 2 shared chats to draw on`

### `off` — stop memory for this chat only

To stop it in every chat, switch the plugin off on the Plugins page instead.

Stops indexing and stops adding anything to your requests. The graph folder stays on disk, so
`on` later resumes where it left off. Other chats keep seeing this chat if it is shared.

### `share` / `unshare` — keep a chat private, or share it again

Every chat is shared by default: other chats with memory on can match and recall its topics.
`unshare` makes this chat private; `share` undoes that. Nothing is copied or merged: the graph stays in its own folder with its own dates, and its
ids carry the chat number (`c3n12`) so every hit traces back to where it came from. Both take
effect at once. A chat shared
before its first index has nothing to offer yet; it fills in every 4 turns or with `build`.

Card: `Shared with the workspace · 7 topics`

### `stats` — where things stand (default)

First line: memory on/off, topics in this chat, shared/private, how many shared chats are
visible, how many of this chat's turns are waiting to be indexed, and `update available` when a
newer version is on npm. The body shows the version, the memory folder, and counters since the app
started: builds and builder tokens, injected blocks and their size, recalls, and the main
conversation's input split into uncached, cache-read and cache-write with the cache-hit rate. A
high cache-hit rate is the sign that memory is saving money rather than spending it.

Card: `Memory on · 7 topics in this chat · shared · 2 shared chats · 3 turns waiting to be indexed`

### `build` — index this chat now

Runs the indexing call immediately instead of waiting for the next 4-turn mark. Useful right
before you switch chats. Needs memory on. If the model's answer cannot be read, the raw output is
saved to `last-builder-output.txt` in the chat's folder and the card tells you why.

Card: `3 topics indexed (2 new) · this chat has 7 topics`

### `map` — every chat in the workspace

Lists all indexed chats newest first: chat id, start date, title, topic count and flags (`this
chat`, `memory on`, `shared`/`private`), each followed by its most connected topics with their ids.
This is the text form of the graph; a visual page is planned.

```
2 chats in C:\Projects\site\.context-graph
c2 2026-11-02 Fix the login redirect loop · 4 topics · this chat, memory on, private
  - c2n1 redirect loop cause: session cookie set with the wrong path (2026-11-02)
c1 2026-11-01 Set up CI for the site · 6 topics · memory on, shared
  - c1n3 deploy step: GitHub Pages from the gh-pages branch (2026-11-01)
```

### `find <words>` — search the shared chats

The same matcher the plugin runs on your messages, so you can see what the model would be shown.
Time words narrow it: `find 524 timeout last week` looks in chats active last week first. Only
shared chats of other conversations are searched; the current chat's own topics are left out
because they are already in its context.

Card: `2 matching topics`, then `c3n12 builder timeout: ...` per line.

## How matching and recall work

**Matching is lexical and free.** Your message is split into words, identifiers (`clear_conversation`
also yields `clear` and `conversation`) and Chinese character pairs. Topic labels and aliases count
double, gists single, well-connected topics get a small boost, and a topic only counts when a label
or alias word matched. Up to 5 hits are shown; when one hit is clearly ahead and its source is
short, the source is included verbatim so no `recall` round trip is needed. A changed decision
links to its replacement with a `supersedes` edge, so a hit on the old one shows the new one.

**Time is the first filter.** If your message names a time, the search runs in that slice first and
widens only if it finds nothing:

| You write | Searched first |
|---|---|
| `yesterday`, `昨天` | chats active yesterday |
| `3 days ago`, `3天前` | that day |
| `last week`, `上周` / `this week`, `本周` | Monday to Monday |
| `last month`, `上个月` | that calendar month |
| `2026-11-01`, `11月1日` | that day |

If nothing matches in the slice and nothing matches anywhere, the chats from that time are listed
instead, so "what did we do yesterday?" still gets a useful answer.

**Recall ids.** The model (or you, in a message) can ask for:

| Id | Returns |
|---|---|
| `c3n12` | Topic 12 of chat 3: label, gist, the original messages word for word, and linked topics |
| `c3` | Chat 3: title, dates, and its topics most connected first |
| `2026-11-01` | Every shared chat active that day, each with its topics from that day first |
| `t7` | Turn 7 of the current chat word for word, including tool calls and results |

## What it costs

| Moment | Added to the request |
|---|---|
| Chats without `on` | nothing |
| First message of a chat | about 15 tokens per shared chat, 20 chats at most |
| Every later message | nothing when no topic matches; under about 150 tokens when some do |
| Indexing | one auxiliary call every 4 turns, off the critical path; roughly the new text in, under 1k tokens out |
| `recall` | one tool round trip with the exact text |

Injected blocks are appended to the end of your newest message, never inserted earlier, so the
provider's prefix cache keeps working. DeepSeek bills cached input at a small fraction of the
uncached price; protecting that cache matters more than shaving a few lines.

## Configuration

Defaults live in [cordis.patch.yml](cordis.patch.yml). A patch replaces the row's whole `config`,
so restate every key you keep.

| Key | Default | Meaning |
|---|---|---|
| `dir` | `.context-graph` | Memory folder, relative to the agent workspace or absolute |
| `buildEveryTurns` | `4` | Index after this many new human turns (chats with memory on) |
| `buildMinChars` | `400` | ...and at least this much new text |
| `maxHits` | `5` | Topics shown per human turn |
| `inlineMaxChars` | `1200` | A single dominant hit this short is shown verbatim |
| `surfaceMaxChats` | `20` | Shared chats listed on the first message of each chat |
| `builderMaxTokens` | `8192` | Output cap for the indexing call; thinking models spend part of it reasoning |
| `builderMaxInputChars` | `60000` | Most text one indexing call reads; a long chat indexed for the first time keeps only its newest messages |
| `rangeMaxChats` | `3` | When a message names a time and no topic matches, at most this many chats from that time are listed |
| `rangeMaxTopics` | `3` | ...with this many topics each. The list names what it left out; `recall("2026-11-01")` shows the full day |
| `provider`, `model` | `''` | Empty: reuse the conversation's routed provider and model. Set both to index with a cheaper or faster model |

## Updating

dsh 0.2.1 desktop builds have no update check for third-party plugins, so the plugin checks npm
itself once per app start. When a newer version exists, your next chat reply ends with one line
saying so, and `/context-graph stats` shows it on its first line. To update: Plugins, open
dsh-context-graph, **Uninstall**, then **Add plugin** `dsh-context-graph@<new version>` and restart.
Name the exact version: dsh's pnpm holds back very new releases otherwise. Turn the check off with
`DSH_CONTEXT_GRAPH_NO_UPDATE_CHECK=1`.

Remove with `dsh plugin --profile desktop remove dsh-context-graph`.

## On disk

```
.context-graph/chats/<sessionId>/meta.json    cid, title, startedAt, lastActiveAt, turns, builtSeq (how far the chat is indexed); memoryOff / private only after off / unshare
.context-graph/chats/<sessionId>/graph.json   topics and links; every topic has its time
.context-graph/chats/<sessionId>/src/<id>.md  verbatim messages behind each topic
```

Delete a chat's folder to forget it. Delete `.context-graph/` to forget the workspace.

## Development

```
index.js          dsh plugin: builder, matcher, recall tool, meter, /context-graph command
graph.js          pure core: tokenize, match, time ranges, merge, render, builder prompt and parser
store.js          chats/<chat>/{meta.json, graph.json, src/<id>.md}
update.js         once-per-start check of npm for a newer version
lib/client.js     dsh chat card for /context-graph (DisclosureRow, en/zh titles)
icon.svg          Plugins page icon in dsh's built-in icon style
locale/           Plugins page title and description (en, zh); zh links README.zh.md
cordis.patch.yml  mounts the plugin at the profile root with default config
test/             node --test
```

Unit tests need nothing: `node --test test/graph.test.js`. The wiring test imports the real dsh
packages from an existing install: `DSH_NODE_MODULES=/path/to/dsh/node_modules npm test`. Nothing
here calls a model.

Release: `npm test`, `npm version patch`, `npm publish`, `git push --follow-tags`.

## Known limits

- Not yet verified with a live model; tests run against the published dsh packages.
- Builds are tracked per process; after a restart the first build of a resumed chat re-reads its
  whole surface. Existing ids are reused, so this costs one larger call, not duplicates.
- Two agents writing the same chat's graph at once: last writer wins.
- Subagent sessions are neither indexed nor given memory blocks.
- Tool outputs are not indexed as topics; `recall("tN")` returns them (each capped at 2000 characters).
- The chat title is the first message, shortened, until dsh exposes its own titles to plugins.
- The visual graph page is not built yet; `map` is the text version.

Using Claude Code? The Claude version is a separate plugin built for Claude's app:
[claude-context-graph](https://github.com/William20100221/claude-context-graph).
