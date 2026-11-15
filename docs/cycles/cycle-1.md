# Cycle 1 prompt: v0.7.0 "safe and structured"

Written after the cycle-1 audit of v0.6.2 (six lenses, 59 findings, 55 confirmed by independent
reproduction, merged into issues #10-#37). This is the brief I work from for this cycle.

## GOAL
Nothing the plugin stores can be lost, mixed up or corrupted, and nothing it sends to a chat can be
mistaken for an instruction. Every later cycle (token cuts, the memory tree, the savings display,
the map) builds on this, so the code also moves into a layered architecture now, before features
grow it.

## SCOPE (milestone v0.7.0)
| Issue | Fix |
|---|---|
| #9, #22 | `engines.dsh` and peers: `>=0.2.1-rc.1 <0.3.0-0`; a test checks both ends with dsh's semver options |
| #10 | unique temp names, no recall write-back, readers skip a bad file instead of failing the workspace, per-folder write lock |
| #11 | chat numbers claimed under a lock with an exclusive `mkdir`, so two windows cannot share one |
| #12 | build commits graph and meta first, verbatim text last; each message stored once by seq |
| #13 | the builder reads the durable session log, so compacted turns are still indexed |
| #14 | parser normalizes citations, tries every `nodes` array; a build with no usable topic fails and keeps `builtSeq` |
| #15 | own-key lookups, label lookup seeded from the whole graph, `nextId` repaired on load, label/alias caps |
| #16 | a fork starts its index at `inheritedEventCount`; the parent's pre-fork topics are not injected into it |
| #17 | root-layout memory from v0.1-v0.3 migrates into a chat folder on first load |
| #18 | injected blocks say once that they are quoted data; inline source goes in a fence |
| #19 | `on`/`build` run without `runMaintenance`, pass the command's abort signal, `on` answers at once |
| #20 | memory-off chats get no update notice and recall reads only their own turns |
| #21 | only agent-loop requests count as conversation requests in the meter |

## ARCHITECTURE (move first, in its own commit, no behaviour change)
```
index.js            package entry: re-exports name, inject, apply from src/host/plugin.js
src/core/           pure logic, no I/O, no dsh imports (text, graph, match, time, render, builder, session, flags)
src/store/          files on disk (atomic JSON, locks, chat folders, legacy migration)
src/host/           dsh wiring (plugin, runtime context, builder runner, memory injection, recall, command, meter, update)
src/client/         the browser module (command card now; plugin page and map in cycle 3)
test/core|host|...  tests mirror the source layout; one shared fake-harness helper
docs/               architecture and how memory works; docs/cycles holds each cycle's prompt and issues
```

## REQUIREMENTS
- Every fix ships with the smallest test that fails without it.
- Commits: one for the move, then one per issue group, each body explaining what was wrong, why
  the fix is right, and `Fixes #N`. Co-authored by Claude.
- Version 0.7.0 with a CHANGELOG entry; tag pushed; issues closed by the commits.
- Keep the npm package contents tight (`files`), and keep the client a single hand-written script.

## WHEN TO STOP
All v0.7.0 issues fixed and tested, `npm test` green under three time zones, an independent review
of the diff finds nothing it can reproduce, CHANGELOG written, tag pushed.

## DO NOT
- Do not change what gets injected beyond the data framing (#18); token work is cycle 2.
- Do not add dependencies.
- Do not ask the owner questions; choose the option that best serves: fewer tokens, then speed and
  quality, then less storage.

## RESULT (2026-11-15)
- Released as v0.7.0 (tag `v0.7.0`, commits 198221a, 6e15be0, 60b7f2e). Issues #9-#22 and #32 closed.
- The independent review of the change (4 angles, 27 findings, 23 confirmed) found real problems in
  the new code: the v0.1 migration could mix two sessions' text, an interrupted migration could hide
  old memory, unreadable files were overwritten blind, the fork filter used clocks instead of seqs,
  and an honest empty answer would be re-sent forever. All were fixed before the release, each with
  a test (62 tests, three time zones).
- Design changes made because of the review: upgrades write new files (`topics.json`, `msgs.json`) and
  keep the old ones as a 7-day backup; damaged files are repaired or set aside, never overwritten;
  forks are detected from `inheritedEventCount` and filtered by seq.
- Carried to cycle 2: #23-#31, #33, #34 (tokens, relevance, speed, the memory tree).
