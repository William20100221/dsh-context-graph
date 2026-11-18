# Cycle 4 prompt: v0.10.0 "memory for the way dsh is used"

Written after the cycle-4 audit of v0.9.0 (3 lenses: real dsh, tokens and quality, bugs; 18
findings, all confirmed by an independent verifier). 16 are filed as #69-#84; two are designs for
the open #42 and #58, posted on those issues. The real-dsh lens loaded the plugin into dsh's own
runtime (0.2.1-rc.5: cordis, dsh-llm, session, agent-loop, commands, goal, plan mode, questions)
with a scripted provider: every contract the plugin relies on held, except the ones below.

## GOAL
Memory works for every way a chat is driven in dsh, not only typed prompts: `/goal` rounds,
scheduled reminders, plan mode, questions the model asks, steering. A new chat pays nothing for
memory it does not need, and a question finds its topic however it is worded (plural or singular,
camelCase, "three days ago", 大前天). What is stored stays small, and a damaged file stays safe on
Windows. Every number shown stays honest.

## SCOPE (milestone v0.10.0)
- Input dsh drives (#69, #70, #71): goal rounds count as prompts (their objective, once per goal
  revision) and as turns; scheduled reminders and question replies too; the plan from
  `exit_plan_mode` and the answers to `ask_user_question` are indexed and part of a recalled turn;
  turn ids follow dsh's own turn numbers. An off stretch still covers all of it.
- Indexing (#42): a chat is indexed when it goes quiet, so short chats and the last turns of long
  ones are not lost (design on #42).
- Tokens (#76, #77, #80, #81, #84): the chat list rides with a chat's first block or a question
  about the past; a day recall has a budget; everyday "what should we do today" gets no digest; a
  day's digest lists the chats worked on that day first; more ways to name a past day.
- Quality (#74, #75, #73): camelCase identifiers and plural/singular forms match; a file the model
  reads cannot hide topics.
- Speed and storage (#72, #78, #82, #83, #58): no full log read on a first recall; the ledger
  stores only what is not zero and one small file per chat; `map` is capped in the session log;
  v0.4-v0.6 forks are found with one header listing per run (design on #58).
- Data safety (#79): a damaged file that cannot be moved aside is never overwritten blind.
- A real-dsh end-to-end test in the suite (skipped where dsh is not installed), built from the
  audit's runtime harness: one chat indexed, a second chat that gets the block, a `/goal` chat.

## REQUIREMENTS
- Each fix comes with a test that fails without it; matching changes are measured on the relevance
  corpus (precision must not drop, every reworded question added to the corpus).
- No new dependency, no build step; the pure core stays pure.
- Token and speed claims measured in tests; README figures from the same tests.

## WHEN TO STOP
All v0.10.0 issues fixed and tested, the suite green in three zones and the end-to-end test green,
two review rounds of the change find nothing high or medium they can reproduce, tag pushed.

## DO NOT
- Do not add to a chat's context anything the chat did not need; no extra model calls.
- Do not read tool output into memory beyond the plan and the user's own answers.
- Do not ask the owner questions; choose by: fewer tokens, then speed and quality, then storage.

## RESULT (2026-11-19)
- Released as v0.10.0. Issues #42, #58 and #69-#84 closed by the release commit. This is the last
  cycle of this run: the owner asked to wrap up after cycle 4.
- What the user sees now: memory for `/goal` rounds, reminders, approved plans and the answers to
  the model's questions, with an off stretch covering all of them; turn ids that are dsh's own;
  short chats indexed once quiet; no chat list for a first message that needs no memory; a day
  recall within 1,000 tokens; plurals, camelCase and many more ways to name a past day (大前天, 上上周,
  two days ago, last Monday) understood;
  one small ledger file per chat; `map` capped at 40 chats.
- The audit of 0.9.0 (3 lenses, real dsh among them; 18 findings, all confirmed) gave #69-#84 and
  designs for #42 and #58, all fixed with tests; the audit's real-dsh harness is now
  test/e2e/cycle4-real-dsh.test.js.
- Three independent review rounds of the change, each finding reproduced before it was fixed:
  15 findings (12 confirmed, the other 3 fixed as well, plus 2 the fixers left open), then 14 on
  those fixes (13 confirmed, 1 high: turn recall of a chat indexed by 0.9.0 could serve a goal set
  while off), then 12 on those (3 medium). Design changes made because of them: turn recall and
  indexing judge privacy from the log with the off stretches, and what dsh drives from one is never
  stored as a gap; forks take their ancestors' off stretches; forks compare what the builder read;
  a quiet index is bounded per regular cycle; one product-plural change was tried and reverted.
- The two-clean-rounds stop rule was not met to the letter: the third round still found 3 medium
  problems (an upcoming date, requests about earlier work, a title from a private steer). All are
  fixed, each with a test checked by undoing its fix; no fourth round was run.
- Mutation check: 168 mutants of cycles 1-3 (166 caught; one equivalent now, one covered by a new
  test), 64 of the cycle-4 fixes (63, then all with one more test), 18 of the second-review fixes
  (17, then all); every third-check fix was checked by undoing it. 304 tests in three time zones.
- Carried forward: telling a question about earlier work from everyday talk is lexical (an
  everyday request about "the curry we tried last night" can still get a short digest); a reminder
  edited in dsh's reminder manager is new input when it fires; old turn ids show no turn until the
  chat is indexed again or a topic of it is recalled.
