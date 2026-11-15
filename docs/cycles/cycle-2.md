# Cycle 2 prompt: v0.8.0 "lean memory tree"

Written after the cycle-2 audit of v0.7.0 (six lenses: new chat, relevance, indexing call,
drill-down, speed, correctness; 42 findings, 33 confirmed). New issues #38-#56; measured designs
added as comments on #23, #27, #28, #33, #34.

## GOAL
A new chat reads a few cheap lines, finds the right chat and topic, and drills down to the exact
turn only when the question needs it; unrelated messages get nothing. Concretely, on the audit's
own corpora: precision from 40% to over 90% with no lost recall, zero blocks on unrelated
prompts, a first-message list under 200 tokens, no turn recall over about 2,000 tokens, indexing
without paid thinking, and a per-message cost under 20 ms at 150 chats.

## THE MEMORY TREE AFTER THIS CYCLE
| Layer | Shown as | Reached by |
|---|---|---|
| Chat | `c9 <one-line summary>` (builder-written; dsh title + top labels until then) | first message of a chat, ranked by relevance, 200-token budget |
| Topic | `c9n4 label: gist` | lexical match with a relevance floor, near-duplicates collapsed |
| Source | the cited messages, newest 3, capped, naming their turns (`c9t4`) | `recall("c9n4")`; inlined only for one strong, short hit |
| Turn | the prompt, the assistant text, tools as one line, about 2,000 tokens max | `recall("c9t4")` from dsh's own log (or `t4` in this chat) |

## SCOPE (milestone v0.8.0)
- Relevance: #23 (raw-evidence floor, coverage cut, no back-fill, CJK particles), #43 (collapse
  copies), #39 (inline only strong hits, token budget), #24 and #25 (time as a ranking bonus, a
  day digest only for questions about the past, correct parsing, DST, Unicode words).
- Top layer: #27 (summary in the builder JSON, ranked budgeted list), #26 (decide from the surface),
  #38 (only chats with topics), #51 (placeholder ids), #41 (dsh title), #40 (last-active time).
- Indexing call: #28 (cache-friendly layout), #44 (lowest reasoning effort), #45 (pinned retries,
  half span after a cut-off), #46 (keep every prompt), #53 (reset the wait after a skip).
- Drill-down: #34 (`c3t7` via sessionQuery, gated to the indexed span), #47 (lean capped turns,
  t-ids defined and printed), #29 (topic recall caps and turn pointers), #30 (schema about 100
  tokens), #31 (recalled ids count as shown), #48 (no silent cut at 40 topics).
- Speed: #33 (token memo, stat-keyed read cache), #49 (memoized matches, single loads, persisted
  fork parent).
- Correctness: #50 (fail closed on read), #52 (fork chains by content), #54 (repair at the parser's
  position), #55 (fork pending count), #56 (backup after 7 quiet days).

## REQUIREMENTS
- Each change has the smallest test that fails without it; the relevance change is tested on a
  fixed corpus with precision, recall and token assertions, so later cycles cannot regress it.
- Token claims are measured with `estimateTokens` in tests, not estimated in prose.
- Commits grouped by area, each body saying what was wrong and why the fix is right, with
  `Fixes #N`; version 0.8.0 with a CHANGELOG entry; README updated where behaviour changes.

## WHEN TO STOP
All v0.8.0 issues fixed and tested, the suite green in three time zones, an independent review of
the diff finds nothing it can reproduce (or what it finds is fixed), tag pushed.

## DO NOT
- No dependencies, no embeddings, no extra model calls (the summary rides in the existing build).
- Do not change anything that would break the provider prefix cache of a running chat.
- Do not ask the owner questions; choose by: fewer tokens, then speed and quality, then storage.

## RESULT (2026-11-16)
- Released as v0.8.0. Issues #23-#31, #33, #34, #38-#41, #43-#57 closed by the fix commit; #42
  (index chats shorter than 4 turns) and #58 (legacy forks never reopened) stay for cycle 4, #35-#37
  for cycle 3.
- Measured on the audit corpus: precision 40% -> 100% (91% on the held-out set), 20/20 found,
  everyday messages with a block 7/20 -> 0/20, injected tokens 8,235 -> 3,045; first-message
  list under 200 tokens at 50 chats; recall tool about 100 tokens; a turn about 2,000 tokens at
  most; about 19 ms per message at 150 chats / 9,000 topics (was 186 ms).
- The independent review (4 angles, 24 findings, 22 confirmed by reproduction) found real problems
  in the new code: one Chinese word counted as two or three label words, a shown topic hid its
  replacement, a named time could push an exact older match out, the day-digest trigger was too
  loose, recall caps were characters, nested subagents bypassed memory off, and several host
  fixes had no test that failed without them. All were fixed, each with a test. A second review of
  those fixes (2 angles, 11 findings, 9 confirmed) found that a word could still count twice inside a
  longer word, katakana/Hangul words counted as several, a path written first weakened the
  question, copies compared by search tokens ignored digits and "not", ties cut the exact topic, the
  digest trigger still fired on "did we win", cuts could split emoji, and old forks leaked inherited
  topics; all fixed except old forks never reopened (#58). Final check: 124 tests in three zones, and
  each of the 57 fixes, broken on purpose, makes the suite fail.
- Found in my own process: the cycle-1 "three time zones" ran in the local zone twice (Git Bash
  drops TZ with a slash), filed as #57 and fixed with `npm run test:zones`.
- Design changes made because of the reviews: evidence is counted per word of the message (only
  new characters count, katakana/Hangul runs are one word, code after plain words); time orders the
  chosen hits instead of choosing them; the chat list is sent once per chat (first turn or after
  `on`); subjects and gists are compared as text; forks hold back everything before their fork
  point, which a 0.4-0.6 fork learns from dsh.
- Carried forward: #42 (cycle 4), #35-#37 (cycle 3); long pasted logs can still bring one loosely
  related topic (lexical matching), noted in the README's known limits.
