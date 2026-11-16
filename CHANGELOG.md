# Changelog

All notable changes to dsh-context-graph. Versions follow semver; each minor version from 0.7.0 on
is one development cycle (audit, issues, fixes, independent review), documented in
[docs/cycles](docs/cycles).

## 0.9.0 — 2026-11-17 — see what memory does

Cycle 3. You can now see what memory does without reading code: a savings line on the
`/context-graph` card, and a page in Plugins with each workspace's totals and a map of its memory.
Nothing here adds tokens to a chat or slows a message.

**What memory saved, and what it cost** (#35)
- Every chat keeps a small ledger: notes and recall results sent, their cached re-sends with every
  later request, the recall tool's share of each request, and the indexing calls as dsh reported
  them, against what used topics stood in for (their newest messages as stored, each once per
  chat). A topic counts as used when the model recalled it or its answer says two of the topic's
  words that the prompt did not bring, once per chat. Cached input is weighed at 0.1 and output at 4, in input-token equivalents; a loss
  is shown as a loss.
- The card's second line: `Savings (estimate): saved about 8,500 tokens in this chat · saved about
  41,000 tokens in this workspace`; its body shows every term, so the number can be checked.
- `.context-graph/ledger.json` holds a few counters per chat, written at most once per turn, off
  the critical path; it survives restarts.

**The plugin's page** (#36)
- Plugins → Context Graph: each workspace with memory (from dsh's workspace registry and the
  folders used in this run), its saved / cost / net, and a map: chats as circles, topics as dots
  coloured by kind and sized by links, links as lines; hover for a label, click for the gist, the
  chat, the links, the first lines of the sources and the id to paste; search and kind filters;
  drag and zoom. Light and dark follow dsh's own theme; English and Chinese.
- Data comes from three read-only routes registered through dsh's connection registry, which only
  answers the app's owner; a workspace is named by a key, never a path, so nothing outside the
  known memory folders can be read. The map is laid out by the host (deterministic), so the
  browser only draws; it sends labels only, gists and sources load when a topic is opened.

**Docs** (#37)
- README: the page, how the estimate works and where it errs, the ledger on disk; the cost table
  points at the live numbers, and test/core/docs.test.js fails when the code and the README's
  figures disagree.

**Found by the cycle-3 audit of 0.8.0, and fixed** (2 lenses, 13 findings, 11 confirmed by reproduction; #59-#68)
- What you type while memory is off is never indexed or shared, also after `on`: `off` remembers
  where memory went off, and `on` turns that stretch into a gap the builder never reads and turn
  recall never serves. Turns from before `off` that were not indexed yet still are. (#59)
- A fork of a private or memory-off chat starts private or memory-off, and is titled from its own
  first prompt and its own dsh titles, never the parent's. (#60)
- A topic id the indexing model invents for a new topic can no longer overwrite another new topic
  of the same answer (and take its source). (#61)
- One chat whose topics file cannot be read (locked by a sync tool, no permission) is skipped
  instead of taking memory away from the whole workspace. (#62)
- The read cache holds far more than any workspace needs: at 1,500 chats a message went from about
  1 s to under 150 ms. (#63)
- The `on` card says whether the chat is shared or stays private. (#64)
- A turn that was running when `on` ran is indexed when it ends. (#65)
- Matching uses a word index per chat and counts a topic's evidence only over the words it holds
  (same results): a 16 KB paste at 150 chats takes about 35 ms instead of up to 1.3 s, and an
  ordinary message about 8 ms instead of 15. (#66)
- A topic recall shares its budget: a short prompt leaves its unused share to the long answer, so
  answers that fit are not cut. (#67)
- The recall tool definition is about 80 tokens instead of 106, sent with every request. (#68)

**Found by the independent reviews of this change, and fixed** (first review: 3 angles, 22 findings, 21 confirmed by reproduction and the 22nd fixed as well, plus 3 found while fixing them and 3 by a review of the page fix; second review, of those fixes: 3 angles, 16 findings, 14 confirmed and the other 2 fixed as well; third review, of the second round's fixes: 3 angles, 10 findings, 9 confirmed and the 10th fixed as well; fourth review, of the third round's fixes: 2 angles, 4 findings, 3 confirmed, all minor, and the 4th fixed as well; a last adversarial check of those fixes: 5 findings, all minor, fixed)

Privacy (#59, #60)
- A turn begun while memory was off stays private as a whole, also the part of its answer written
  after `on`. `on` while a turn is still running, or while messages you typed during off are
  still queued in dsh's inbox, takes effect when the chat is idle: at the turn's end, after a
  stopped or failed turn, after an app restart, or when the queued message is removed. A later
  `off`, even one sent as the turn ends, cancels it; dsh's own notices in the inbox do not hold it.
  `off` itself holds at once, also while its write waits for a file another program holds: a
  turn that ends meanwhile is not indexed, and a fork made, a recall asked or an `on` sent
  meanwhile sees memory off; a second `off` keeps it held if the first one cannot write.
- Nothing from an off stretch becomes a chat's title: not a prompt typed there, not a dsh title
  made from one, not after a damaged meta is repaired (it keeps the title it can read back and
  takes none from the log). The first prompt, used only to match forks to their ancestors, is kept
  as a 16-character fingerprint instead of text; metas from 0.8.0 are converted on their next write.
- Memory turned off under 0.8.0 (no off point recorded) or a meta recovered after damage: `on`
  treats everything after the last index as typed while off, and a second `off` no longer moves
  the off point forward. A damaged meta keeps its off stretches or, when they cannot be read back,
  serves none of its turns to other chats, up to where memory is turned on again (forks made and
  turns typed after that are not held back); a second damage keeps what the first one closed. Past 50 off stretches the two oldest merge; none is
  dropped.
- A fork is private from its first message when its parent is, and memory-off when memory was off
  at the fork point: its parent was off then, or the point lies in one of its off stretches (for a
  fork of a fork, also its grandparent's), or the parent's damaged meta lost its stretches. It then
  has no title until `on`. Its parent is the one dsh names, followed up dsh's chain of forks, so a
  look-alike chat (a sibling fork, another chat that starts with "hi") no longer passes its flags
  on. A fork takes no title from its parent: not dsh's "<title> (1)" rename of a new fork, not a
  title made from inherited prompts, and a fork indexed by 0.8.0 or earlier drops the title it got
  then at its next write (keeping the one that write gives it). A fork gets its folder when first seen (a few hundred bytes).
- While memory is off, the card no longer counts the turns typed since as waiting to be indexed,
  and it shows the chat's own flags even when its topics cannot be read.

The savings estimate (#35)
- "Used" means the answer says two of the topic's words that the prompt did not bring, counted as
  matching counts words: one Chinese word once (also when it sits next to the prompt's words), an
  exact identifier of the label twice. An answer that only repeats the question no longer counts,
  and one that states the topic's fact does.
- A used topic stands in for its newest cited messages (three at most) at their stored size (a
  source an older version kept whole counts as if cut the same way), each message once per chat
  however many topics cite it; what memory sent instead (the note, the recall result) is counted
  once, as cost. Counting every cited message at its full length could show one recall as 78,000
  tokens saved.
- A turn is judged by its own answer, also when the next message arrives while it is being
  indexed; a stopped turn's topics are not judged against the next turn's answer; uses survive a
  failed index or an unreadable ledger and are credited at the next turn end. Blocks a compaction
  removed stop being charged as re-sent, also mid-turn and with memory off. A subagent forked from
  a chat is charged to it: the blocks it carries and the recall tool.
- An unreadable ledger.json (a sync tool holding it) costs the savings figures, not the card or
  the page: both say the savings are unavailable for now instead of showing zeros.

The page (#36, #62, #65)
- A late map or topic answer no longer replaces the one you asked for since, and Close drops a
  topic still on its way; each topic opens a fresh panel (no leftover link or "Copied"), "Copied"
  shows only when something was copied, and a topic that cannot be read says so.
- A large workspace's map fills its box (the view takes the box's proportions, from the newest
  row) and drags at the pointer's speed; a map that failed to load can be asked again. Chat labels
  fit their slot: the chat number, marks and hidden-topic count stay whole (the marks as 🔒 private
  and ⏸ memory off where words do not fit) and hover shows the full text. The page states the rule
  the estimate follows.
- The page skips a chat or a whole workspace it cannot read and leaves out chats without a chat
  number (an unreadable meta); a repeated number (a copied folder) reaches the same chat, the one
  with topics, on the map, on a topic and through recall (a copy that cannot be read is skipped,
  and the asking chat never answers in its place);
  a topic whose sources cannot be read still opens.
- A turn-end build that finds the chat busy keeps the running turn for the next one.

Files
- On Windows a write waits up to about 5 s for a file another program holds open (a sync tool, a
  virus scan) instead of failing after 250 ms.

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
