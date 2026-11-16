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
