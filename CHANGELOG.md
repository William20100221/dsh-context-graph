# Changelog

All notable changes to dsh-context-graph. Versions follow semver; each minor version from 0.7.0 on
is one development cycle (audit, issues, fixes, independent review), documented in
[docs/cycles](docs/cycles).

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
