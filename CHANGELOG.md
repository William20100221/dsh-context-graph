# Changelog

All notable changes to dsh-context-graph. Versions follow semver; each minor version from 0.7.0 on
is one development cycle (audit, issues, fixes, independent review), documented in
[docs/cycles](docs/cycles).

## 0.8.0 — 2026-11-16 — lean memory tree

Cycle 2. A six-angle audit of 0.7.0 (new chat, relevance, indexing call, drill-down, speed,
correctness) found 42 problems; 33 were confirmed and filed as #38-#56, next to the open token and
relevance issues from cycle 1 (#23-#31, #33, #34). This release makes memory a tree a new chat
reads from the top: one line per chat, then only the topics a message is about, then a topic's
source, then the whole turn from dsh's own log. Measured on the audit's fixed corpus (6 chats,
60 topics, English and Chinese, 20 questions and 20 everyday messages):

| | 0.7.0 | 0.8.0 |
|---|---|---|
| hits that answer the question (precision) | 40% | 100% (held-out set: 91%) |
| questions whose topic is found | 20/20 | 20/20 |
| everyday messages that get a block | 7/20 | 0/20 |
| tokens injected over the 40 messages | 8,235 | 3,045 |
| first-message chat list, 50 chats | 632 tokens | under 200 |
| recall tool definition, every request | about 210 tokens | about 100 |
| a turn recall, worst case on real logs | 18,633 tokens | about 2,000 |
| per-message cost, 150 chats / 9,000 topics | 186 ms | about 19 ms (median) |

**Only relevant memory is sent** (#23, #43, #39, #31, #51)
- A topic must earn its place: each prompt word in its label or aliases counts 2, in its gist 0.5,
  and it needs a label word and a score of 3. Rarity only breaks ties. Filler words ("can you
  help", 我们, 的, hiragana endings) no longer count. (#23)
- The same subject in several chats takes one slot; a lower hit stays only if it matches a word
  the higher ones did not; a topic already in the chat's context leaves its slot empty instead of
  pulling in a weaker one. (#23, #43)
- A topic's source is included only for a hit with three label words that is clearly ahead, and
  only up to 300 tokens (budgets are now in tokens, so Chinese no longer costs 3.5x). (#39)
- Topics the model fetched with `recall` count as already shown; ids are read from topic lines
  only, so the example ids in a header can no longer hide a real topic. (#31, #51)

**The top layer** (#27, #26, #38, #41, #40)
- The indexing call also writes a one-line summary of the chat (no extra call). A new chat's
  first message gets one line per earlier chat that has topics, the ones sharing words with the
  message first, within 200 tokens. (#27, #38)
- The list is sent once per chat: not again after an app restart while it is still in the chat's
  context. (#26)
- Chats use dsh's own title (model-made, or your rename) instead of the first prompt. (#41)
- A chat resumed for a few turns counts as active today even before it is indexed again. (#40)
- Quick chats that never reach an index no longer get a folder. (#38)

**Time** (#24, #25)
- A named time ranks topics from then first instead of hiding everything else; an exact older match
  still wins. A day digest is sent only for a question about the past ("what did we do yesterday",
  "上次聊了什么"), not for "today I want to learn rust". Day digests list only topics from that day. (#24)
- 目前天气, 登上月球 and 这周期 are no longer read as dates; years (2025年11月1日) and invalid dates
  (2026-02-31) are handled; ranges are whole calendar days across daylight-saving changes; words in
  any alphabet (café, Привет, full-width ＡＰＩ) are searchable. (#25)

**The indexing call** (#28, #44, #45, #46, #53)
- The prompt starts with fixed rules (identical for every build of every chat), then the chat's
  topics in id order, then the span, so the provider can cache everything but the new text. (#28)
- It runs at the route's lowest reasoning effort, picked the way dsh's own title generator does;
  no effort is sent for routes without one. (#44)
- A failed span is retried as it was, not grown by every turn since; an answer cut off by the
  token cap is retried with its first half; after three unusable answers only that span is
  skipped, and the next build waits the normal 4 turns, not 16. (#45, #53)
- Every human prompt is read: assistant text is shortened (2,000, 800, then 300 characters) before
  anything else, and a span too long for one call is indexed over several, oldest turns first. (#46)

**Drill-down** (#34, #47, #29, #30, #48)
- `recall("c3t7")` reads turn 7 of chat 3 from dsh's own session log, so the deepest layer costs no
  storage. Only inside what that chat shares: turns it has indexed, and never turns a fork
  inherited. (#34)
- A turn is the prompt, the answers and one line of tool use (`[tools: read_file ×3, bash]`), about
  2,000 tokens at most; tool output is left out. (#47)
- A topic recall gives its newest 3 cited messages, 1,200 characters each, each naming its turn,
  and says which older turns hold more. (#29)
- The recall tool definition is half its size (the `depth` option is gone). (#30)
- `recall("c3")` past 40 topics names the rest instead of stopping silently. (#48)

**Speed** (#33, #49)
- Files are read through a cache keyed by their stat, each topic's words are computed once, and
  topics that cannot reach the floor are skipped before their evidence is counted: about 19 ms per
  message at 150 chats and 9,000 topics. Shared cached data is frozen, so no reader can
  change it by accident. (#33)
- A message naming a time is matched once, not three times; `map` loads the workspace once;
  `recall` of a topic or chat loads only that chat; forks are no longer re-detected every turn. (#49)

**Correctness** (#50, #52, #54, #55, #56, #57)
- A chat whose meta became unreadable reads as private with memory off right away, not only after
  its next write. (#50)
- Forks are handled by content: a topic of any chat (parent, grandparent) whose every source is
  word for word in the fork's own log is not sent to it, and a chat the fork holds entirely is not
  listed. (#16, #52)
- A damaged file with any amount of trailing junk is repaired in one pass. (#54)
- `stats` in a new fork counts only the fork's own turns. (#55)
- The v0.1-v0.6 backup is removed 7 days after its last write, not after the first upgrade. (#56)
- `npm run test:zones` really runs the suite in UTC, Pacific/Auckland and Los Angeles; in Git Bash
  `TZ=... npm test` silently kept the local zone. (#57)

**Found by the two independent reviews of this change, and fixed** (first: 4 angles, 24 findings, 22 confirmed by reproduction; second, on those fixes: 2 angles, 11 findings, 9 confirmed)
- Evidence is counted per word of the message, not per token: one Chinese word (数据库) or one
  hyphenated word no longer passes as two or three label words, so Chinese and English prompts need
  the same evidence; a word already counted adds nothing when it shows up again inside a longer word
  (in either order); a katakana or Hangul word is one word however long; an exact identifier counts
  double, while bits of code in a pasted traceback count only as gist words, after the plain words
  of the message, so naming a file first no longer weakens the question; "ci/cd" or "read/write" are
  plain words; very long messages need slightly more evidence.
- A topic already shown no longer hides its replacement: a decision that was superseded, or a
  newer copy of the same subject that says something else, is sent; the newest copy speaks for a
  subject even when it would not pass the gate alone; "same subject" and "says the same" compare the
  text itself, so digits and "not" count ("retries 3" is not "retries 5", "Python 2 support" not
  "Python 3 support"); on equal evidence the topic the message names exactly comes first and is not
  cut by its equal, and a lead must be ahead of every candidate; `/context-graph find` lists every
  copy.
- A named time reorders the topics after they are chosen, so it can never push an exact older match
  out; a day digest answers only questions about shared earlier work, which must name "we" or "you"
  ("before lunch today", "did we win", "the last time I smoked", 今天做了红烧肉, 和朋友聊过 get
  nothing); a fork's digest leaves out the chats it holds word for word.
- `recall` budgets are tokens everywhere: a topic's source is about 1,000 tokens in any language, a
  turn read from stored messages (no dsh log) keeps the 2,000-token turn budget, and cuts are
  placed by adding up each character's cost; no cut leaves half of an emoji or rare character.
- The chat list is sent on a chat's first turn (or after `on`) and never again in that chat, after
  a restart or a compaction.
- A subagent started by a subagent follows the chat that started the task; a chain that cannot be
  followed fails closed.
- A fork compares stored messages only for chats that share its first prompt (its possible
  ancestors), instead of reading every chat's `msgs.json` on its first message.
- `recall` of a chat number shared by two chats (possible in pre-0.7 data) finds the other chat,
  never a private one; two readers of a folder being upgraded from 0.4-0.6 both see its topics; a
  build never moves the index past what it read.
- Forks indexed by 0.4-0.6 (whose topics were drawn from inherited messages) hold those back: a
  fork opened again records its fork point, and `recall` asks dsh for it first, so neither its
  turns nor its topics expose the chat it was forked from. One never opened again keeps offering its
  inherited topic lines to matching until either happens (#58).
- A config block written for 0.7 still applies (`inlineMaxChars`, `surfaceMaxChats`).
- Every fix in this release is mutation-checked: breaking it makes a test fail.

**Changed**
- Config: `inlineMaxChars` and `surfaceMaxChats` are replaced by `inlineMaxTokens` (300),
  `listMaxTokens` (200, with an optional `listMaxChats`), `sourceMaxMessages` (3), `sourceMaxTokens`
  (1000) and `turnMaxTokens` (2000); the old keys in a 0.7 block are still read.
- `/context-graph find` lists every topic with at least one matching label word (up to 10).
- `meta.json` gains `summary` and `firstPrompt`; `turns` is no longer written.
- Tests: 124 (was 62), including the fixed relevance corpus, the three-zone runner, and a mutation
  check: each of the 57 fixes in this release, broken on purpose, makes the suite fail.

## 0.7.0 — 2026-11-15 — safe and structured

Cycle 1. A six-angle audit of 0.6.2 found 59 problems; 55 were confirmed by independent
reproduction and filed as issues #10-#37. This release fixes everything that could lose, corrupt or
mix up stored memory, or let one chat's text act as instructions in another (milestone v0.7.0), plus
the storage duplication (#32). An independent four-angle review of the change then found 23 more
problems in the new code itself; all are fixed here too. Token, relevance and speed work follows in
0.8.0; the savings display and the visual map in 0.9.0.

**Stored memory cannot be lost, mixed up or corrupted**
- Concurrent writes can no longer corrupt files (unique temp names, a retried rename on Windows,
  each chat's writes serialized). (#10)
- A damaged file never takes the workspace down and is never silently overwritten: trailing junk
  (what 0.6 could leave) is repaired; an unreadable file is set aside as `<file>.corrupt-<time>`;
  a chat whose meta was unreadable keeps its number and index position and fails closed (private,
  memory off) because the lost file may have said so. (#10)
- `recall` never writes, which removes a lost update that could drop a chat's newest topics. (#10)
- Chat numbers are claimed with an exclusive create, safe across dsh windows. (#11)
- Each cited message is stored once per chat (`msgs.json`, keyed by seq) instead of once per topic,
  and a build commits text, then topics, then its index position. (#12, #32)
- Turns that dsh compaction hid before they were indexed are still indexed (the builder reads the
  durable log). (#13)
- Answers citing messages as `"m0"`, or mentioning `"nodes": [` before the real JSON, are read
  correctly; an answer whose topics cite nothing usable is retried, an honest empty answer means
  "nothing worth remembering", and after three unusable answers in a row the span is skipped instead
  of being re-sent, larger, every few turns. (#14)
- Graph merges resolve links to earlier topics by label, use only real `nN` ids (a topic labelled
  `constructor` no longer collides with `Object.prototype`), repair `nextId`, and cap labels (80
  chars), gists (200) and aliases (12 x 40, newest first). (#15)

**Older memory comes back, safely**
- Memory written by 0.1-0.3 (one `graph.json` per workspace) is usable again; a graph that covered
  several sessions keeps each session's messages apart. (#17)
- Upgrades never delete or cut anything on the spot: the new data goes to `topics.json` and
  `msgs.json`, migrated text is kept in full, and the old files stay unchanged as a backup for 7
  days. An older copy of the plugin still running elsewhere can no longer wipe upgraded memory; topics
  it adds meanwhile are merged in. An interrupted upgrade simply runs again. On real data the same
  memory takes 3,826 bytes instead of 9,015 once the backup is gone.

**Security**
- Every block carrying text from another chat says once that it is quoted data, not instructions,
  and exact source text sits in a fence it cannot close. (#18)

**Behaviour**
- A forked chat starts its index after the history it inherited (detected from dsh's
  `inheritedEventCount`, whether or not dsh records the parent), and is not sent the parent's topics
  whose sources it already holds; parent topics citing later messages still reach it. (#16)
- `/context-graph on` answers at once and indexes in the background; `build` never takes the
  agent's maintenance slot, never splits a running turn's question from its answer, and stops when
  the command is cancelled. `stats` shows how the last index went. (#19)
- With memory off a chat gets no memory blocks and `recall` reads only its own turns; a subagent
  follows the chat that started it. The update notice is never added to a chat; `stats` shows it. (#20)
- The meter counts only conversation requests as conversation; compaction and title calls have
  their own line. (#21)

**Compatibility**
- Works on every dsh 0.2.1 build from rc.1 on, and on 0.2.2; refuses 0.3 prereleases until tested
  (`engines.dsh >=0.2.1-rc.1 <0.3.0-0`). (#9, #22)

**Structure**
- Code moved into layers: `src/core` (pure), `src/store` (disk), `src/host` (dsh wiring),
  `src/client` (browser). See [docs/architecture.md](docs/architecture.md). Tests mirror the layout:
  62 tests, run in three time zones.

Contributors: William20100221 (author), Claude (Anthropic; audit, fixes, review).

## 0.6.2 — 2026-11-04
- Cap the day list sent with a message that names a time.

## 0.6.1 — 2026-11-04
- Fix seven bugs found in the 0.6.0 review (#1-#7): builds in chats that never ran a command, index
  position lost on restart, retry storms, oversized first builds, repeated topics, wrong texts,
  flags undone by a finishing build.

## 0.6.0 — 2026-11-04
- Chats are shared with the workspace by default; `/context-graph unshare` keeps one private.

## 0.5.0 — 2026-11-04
- Memory on in every chat by default; the plugin switch on the Plugins page turns it off everywhere,
  `/context-graph off` for one chat. Chat dates are local days so recall by date matches.

## 0.4.0 — 2026-11-02
- One graph per chat with a share flag, time-first matching, recall by chat and day; folding removed.

## 0.3.0 — 2026-11-02
- dsh-native look: icon, English and Chinese title and description, Chinese detail page, command card.

## 0.2.x — 2026-11-02
- 0.2.3: update check against npm. 0.2.2: builder survives thinking models. 0.2.1: the command
  declares its arguments. 0.2.0: folding of old turns (removed in 0.4.0).

## 0.1.0 — 2026-11-02
- First version: graph memory of past conversations for DeepSeek Harness.
