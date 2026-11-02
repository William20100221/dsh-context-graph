# context-graph: core design (v0, 2026-11-02)

Working name: `context-graph`. Targets: DeepSeek Harness (dsh) first, then Claude Code.
Goal: cut input tokens, cut thinking time, keep or improve answer quality, by sending the
model a small map of past conversations instead of the past conversations themselves.

Reviewed 2026-11-02 against `vibe-any/dsh-plugin-save-token` v2.4.1 (sections 2b and 2c).

## 1. Your idea, checked

| Your proposal | Verdict | Why |
|---|---|---|
| Keep a network of past conversations | Keep | Correct shape. Graph beats a flat summary because related topics stay linked and the model can walk from a hit to its neighbours. |
| Only key words on the surface | Change slightly | Bare keywords lose *decisions* and *state* ("we chose X because Y"). Surface layer = short label + one-line gist per node. Still tiny (about 15 tokens per node). |
| Model follows the path to the full text | Keep, add a shortcut | A tool call costs one round trip. Add a free pre-step: match the new message against node labels lexically and auto-attach the top hits. The tool is for deliberate deeper digging. |
| Full text lives outside the context | Keep, make it the law | Nodes never *replace* the original. Every node points to the exact original messages (dsh event seqs, Claude Code transcript lines). Expansion returns verbatim text. This is what stops the usual compaction problem: summary drift. |

Biggest risk in the idea: building the graph itself costs output tokens and a model call.
Fix: build it only where a summary is already being paid for (compaction), and incrementally.

## 2. What already exists (reuse, don't rebuild)

- **dsh compaction** (`dsh-compaction-basic`): `summarize()` is the one documented override hook.
  Stock behaviour: LLM writes prose, prose replaces old messages. We swap the prompt, so the
  "summary" the model writes *is* the graph delta. Same cost as stock compaction, zero extra calls.
- **dsh session log**: shadowed events stay in the log; `session.eventAt(seq)` reads them.
  That is the full-text store for free. Our clear plugin already uses it (`clear.js`).
- **dsh `tokenMeter`**: measures saved tokens, like `releasedTokens` in the clear plugin.
- **dsh-hooks-claude-code** (`packages/experimental/hooks-claude-code`): runs Claude Code
  `hooks.json` inside dsh. `UserPromptSubmit` and `SessionStart` can attach context. So the
  "auto-attach hits" part is written once as a Claude Code hook and runs in both harnesses.
- **Claude Code hooks**: `UserPromptSubmit` (stdout becomes context), `SessionStart`,
  `PreCompact` (gets `transcript_path`), `Stop`. Verify exact payload fields at coding time.
- **graphify** (installed skill): same idea for folders of files. Too heavy as a dependency
  (Python pipeline, community detection). Borrow two concepts only: "god nodes" (most-linked
  nodes go first on the surface) and BFS query. No embeddings, no vector DB in v1.
- **dsh-plugin-save-token** (github.com/vibe-any/dsh-plugin-save-token): compresses large
  *tool outputs* at `tools/post-execute`, spills the original to disk, leaves a `[save-token #id]`
  notice, and offers `save_token_expand` to get it back. It does not touch conversation turns,
  decisions or history. Complementary to us, not a competitor: recommend installing both. Do
  not rebuild tool-output compression.

## 2b. What save-token teaches (borrow)

1. **Reversibility is a hard rule, not a feature.** They refuse to compress if the spill write
   fails. Same for us: a node without a verbatim source is not written.
2. **Never-worse gate.** A replacement is adopted only if its estimated tokens are strictly
   smaller than what it replaces. Apply to our surface layer: if the graph summary is not smaller
   than the stock prose summary would be, fall back to stock.
3. **Marker id in text + one retrieval tool.** `[save-token #c1or] ... call save_token_expand`
   is exactly our `[ctx n17] ... call recall`. Keep the same shape so models already trained on
   one pattern follow the other.
4. **Measure cache, not just tokens.** They meter `cacheReadTokens` and `cacheWriteTokens`
   separately from `llm/stream` usage chunks and treat cache-hit rate as a first-class KPI.
5. **Benchmarks lie at n=2.** Their round 2 showed +38% total tokens from one agent that chose a
   different strategy, swamping all compression gains. Our tests must be paired and deterministic
   (dsh ships an `llm-replay` adapter in `packages/test-support`), and success/recall accuracy
   comes before token counts.
6. **Confirmed extension points** (from their `src/index.js`): `ctx.on('tools/post-execute')`,
   `ctx.on('llm/stream')` with `options.messages/system/tools` and usage chunks,
   `ctx.on('agent/pre-step', (payload, next))` with `payload.agent.session.header.id` and
   `payload.signal`, `ctx.get('compaction').compactIfNeeded(agent, 'pressure', signal)`,
   `ctx.get('spillStore').saveText()` returning `{locator, bytes, retrievalHint}`,
   `ctx.tools.register(defineTool(...))`.

## 2c. Cache economics (this changes the goal)

Their measurement: about 90% of billed input on DeepSeek was **cache reads at roughly 1/30 of
the miss price**. Claude is similar in kind (cache reads about 1/10). Consequences:

- A 100k-token context that is fully cached costs about the same as 3.3k uncached tokens.
  Shrinking it saves far less real money than the token count suggests.
- Any rewrite of early context (compaction, or our graph summary replacing it) **breaks the
  cache prefix**. save-token measured break-even only after about 60 further requests, and
  turned their compaction assist *off by default* for that reason.
- So, within one long session, the honest claim is: "smaller context after compaction, same
  cache behaviour as stock compaction, better recall." Not "big savings per turn."

Where the plugin wins outright:

1. **New session, same project.** There is no cache to lose. Stock harness starts from zero
   memory. We start from a 600-token surface layer plus `recall`. This is the main value.
2. **Recall quality.** Verbatim source beats paraphrased summary, every time.
3. **Shorter summary at compaction.** When compaction happens anyway, ours is 3 to 10x smaller,
   and every later turn replays less.

Design rules that follow:

- The matcher block (section 3, part 2) is appended **at the end, inside the new user message**.
  Never in the system prompt and never prepended: that would change the prefix every turn and
  kill the cache.
- The surface layer changes only when compaction fires, same moment stock dsh would break the
  prefix anyway. No per-turn surface rewrites.
- Report cache-hit rate next to tokens saved. If a change saves tokens and drops the cache-hit
  rate, it costs money; the panel must say so.

## 3. Architecture

```
                 +--------------------------+
 new user msg -->| hook: UserPromptSubmit   |--> "Related past context:" + top-k node gists
                 | (lexical match, no LLM)  |      + "call recall(id) for the full text"
                 +--------------------------+
                               |
                 +--------------------------+
 model asks  --->| tool: recall(node_id)    |--> verbatim original messages for that node
                 | (optional: depth=1 walk) |      + neighbour ids
                 +--------------------------+
                               |
                 +--------------------------+
 compaction  --->| builder                  |--> adds nodes/edges to graph.json,
 or Stop         | (one LLM call, cheap)    |      each node -> source pointers
                 +--------------------------+
                               |
                      graph.json (per project, persistent across sessions)
```

Three parts, one shared pure-JS core (`core/graph.js`, zero deps, testable with `node --test`
like `clear.js`):

1. **Builder** (writes the graph). Input: a span of raw messages. Output: node/edge delta.
   - dsh: subclass `BasicCompactionEngine`, override `summarize()`. The compaction summary
     message placed on the surface is the *surface layer* (section 4). Full extraction result
     goes to `graph.json`.
   - Claude Code: `PreCompact` hook (and `Stop` hook every N turns) reads `transcript_path`,
     calls `claude -p --model haiku` with the extraction prompt on the new span only, merges.
     `PreCompact` cannot replace Claude's own summary, so we also pass `custom_instructions`
     asking the summary to stay short and reference node ids.
2. **Matcher** (reads, no LLM). `UserPromptSubmit` hook: tokenize the new message, score nodes
   by label/alias overlap plus a small boost for recency and degree, emit top-k (default 5) as
   one compact block. Under about 150 tokens. Runs in both harnesses via the bridge.
3. **Recall** (reads, no LLM). One tool `recall(node_id, depth?)`.
   - dsh: native tool via `defineTool`. Same session: reads `session.eventAt(seq)`. Other
     session: reads our own text store (below).
   - Claude Code: a Bash-callable script `recall.mjs <id>` plus a SKILL.md telling the model
     when to use it. Same store.

**Full-text store.** At build time the builder copies each node's source messages verbatim into
`.context-graph/src/<node_id>.md` alongside `graph.json`. Reasons: dsh `spillStore` files are
temp-scoped and swept after 30 days, so they cannot hold cross-session memory; reading another
session's log needs `session-query` and the log may be gone. Our own folder is the one place
`recall` always finds the text. Provenance (session id, seqs) is kept in `src` for audit.

## 4. Data model (graph.json)

```json
{
  "version": 1,
  "nodes": {
    "n17": {
      "label": "clear_conversation tool",
      "gist": "dsh tool; replaces surface range with a marker, like compaction",
      "aliases": ["clear context", "/clear"],
      "kind": "decision | fact | task | artifact | open-question",
      "src": [{"session": "s3", "from": 412, "to": 431}],
      "updated": "2026-11-01T10:20:00Z",
      "hits": 4
    }
  },
  "edges": [["n17", "n9", "uses"], ["n17", "n22", "superseded-by"]]
}
```

Rules:
- `src` is the ground truth pointer. In dsh `from/to` are event seqs; in Claude Code they are
  transcript line numbers plus the file. A node with no `src` is invalid.
- Node ids are stable. Re-extraction *updates* a node (new gist, appended src) instead of making
  `n17b`. Builder gets the current labels in its prompt so it reuses ids.
- `superseded-by` edges matter most: when a decision changes, the old node stays but the matcher
  follows the edge and shows the new one. This is the quality win over prose summaries.
- Surface layer sent to the model at compaction = god nodes (top by degree and recency), label +
  gist only, hard cap (default 40 nodes, about 600 tokens). Everything else is reachable via
  the matcher or `recall`.

## 5. Budget targets (how we know it works)

| Measure | Stock compaction | Target |
|---|---|---|
| Summary block on surface | 1,500 to 8,000 tokens | under 600 tokens |
| Per-turn extra input | 0 | under 150 tokens (matcher block) |
| Recall of a decision from 50+ turns ago | often paraphrased or lost | verbatim via `recall` |
| Extra LLM calls | 1 per compaction | 1 per compaction (dsh) / 1 per compaction or N turns (CC) |
| Cache-hit rate | about 90% | not lower than stock, within 1 point |
| New session, same project | model knows nothing | answers five project-fact questions from graph + recall |

Test protocol: scripted sessions with dsh's `llm-replay` adapter so runs are deterministic and
paired. Two scenarios: (a) one long session, five questions about early turns after compaction;
(b) a fresh session on the same project, five questions about the previous session. Compare
recall accuracy first, then billed input split into uncached, cache-read, cache-write from
`llm/stream` usage chunks, stock vs plugin.

## 6. v1 scope (ponytail), dsh first

**Pivot during coding (2026-11-02).** In the dsh desktop/web app the compaction backend is mounted
*inside each agent preset* with `isolate: compaction: true`, so a root plugin cannot swap the
summarizer; the user would have to edit preset child plugins by hand. v1 therefore does not touch
compaction at all. The graph is built by our own auxiliary call on `agent/turn-stopping` (off the
critical path), and the surface layer is injected on the first human turn of a session via
`agent/pre-step`. Benefits: no cache break ever, works in every profile, far less code. The
`summarize()` override becomes an optional v1.1 extra for users who edit their preset.

**v0.2.0 (2026-11-02): in-chat folding, requested by the user.** Old turns of the current chat are
replaced (dsh surface `replace`, same mechanism as dsh-clear-conversation) by one message: this chat's
topics plus one line per human turn (t1..tN). `recall("tN")` reads the turn back from the session log,
which keeps shadowed events, so folding loses nothing. Folds run at the start of a human turn (no open
tool call), only over indexed content, only when the old part costs >= `foldAtTokens` (24k) and the
table of contents is under half of it. Standing context (skill catalog, runtime context) in the folded
part is carried into the fold message. Cost model: one cache restart per fold, then every request is
smaller; batching is what makes that trade positive.

Shipped v1 (see README): `graph.js`, `store.js`, `index.js`, `cordis.patch.yml`, 12 tests.

Original build order, kept for reference:

1. `core/graph.js`: match, merge, recall, surface render. Pure, zero deps, `node --test`.
2. dsh plugin `dsh-context-graph` (same shape as `dsh-clear-conversation`):
   `index.js` exports `name`, `inject = ['tools', 'tokenMeter']`, registers the `recall` tool,
   subclasses `BasicCompactionEngine` overriding `summarize()`, listens on `agent/pre-step` to
   append the matcher block to the claimed user message, and on `llm/stream` to meter cache
   read/write. `cordis.patch.yml` mounts it in place of `dsh-compaction-basic`.
3. Claude Code adapter after dsh works: `hooks.json` + `recall.mjs` + SKILL.md.

One `node --test` file per layer, no frameworks. No web panel in v1; `/context-graph stats`
command prints the numbers as text.

Skip until measured: embeddings or semantic search, community detection, cross-project graphs,
a UI card, automatic pruning of stale nodes. Lexical match with aliases is enough to start; the
builder is told to write aliases precisely so matching works without embeddings.

## 7. Open questions for you

1. Granularity: one node per *topic* (fewer, broader) or per *decision/fact* (more, sharper)?
   Recommendation: per decision/fact, topics emerge as high-degree nodes.
2. Where does graph.json live: per project folder (`.context-graph/`) or per user home?
   Recommendation: per project; the clear plugin already lives per project.
3. Should the matcher be allowed to attach *full text* for a very strong single hit, skipping
   the tool round trip? Recommendation: yes if under 300 tokens, else gist only.
4. Claude Code builder model: `haiku` headless call vs. asking the main model to write nodes
   itself in a `Stop` hook. Recommendation: haiku; keeps the main context clean.

## 8. What to send me before coding

- Any other papers or repos on memory graphs or context compression. save-token's README links
  `pleasedodisturb/awesome-llm-token-optimization`, `headroomlabs-ai/headroom` (CCR pattern) and
  `rtk-ai/rtk`; I will read those at coding time.
- Your answers to section 7, in one line each. Defaults apply if you say "use recommendations".
- Decided 2026-11-02: dsh first.
