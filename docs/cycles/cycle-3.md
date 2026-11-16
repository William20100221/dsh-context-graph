# Cycle 3 prompt: v0.9.0 "see what memory does"

Written after the cycle-3 research and audit of v0.8.0. The audit's bug and token findings are
filed as issues (numbers below once filed); the design facts were checked against the dsh the
owner runs (0.2.1-rc.5, `research/dsh-run/node_modules`).

## GOAL
The user can see, without reading code, what memory sent, what it cost, what it stood in for, and
what is in it: a savings line on the `/context-graph` card, and a page in Plugins with the
workspace's totals and a visual map of the memory (chats, topics, links). Every number shown is
either measured (from dsh's own usage reports) or labelled as an estimate with its rule, and a
negative balance is shown as such. Nothing here may add tokens to chats or slow a message.

## THE ESTIMATE (#35)
Per chat, from what the plugin already sees:
- sent: tokens of every block it appended (topic lines, sources, the chat list, day digests),
  counted once when sent; and the requests that followed in that chat, which re-send the block as
  cached input (counted at the configured cache-read weight, default 0.1).
- tool: the `recall` definition on every request of the chat, as cached input (weight 0.1).
- recalls: tokens of every recall result, like a block.
- indexing: the builder's real usage for that chat (input, cache-read, output) from `llm/stream`.
- stood in for (estimate): for each topic the chat actually USED, the tokens of the original
  messages it was drawn from (stored source, at its original length), minus its line. USED means
  recalled, or listed in a block and the turn's answer repeats at least two of its label words
  (or one exact identifier). Unused lines count only as cost.
- net = stood in for - (sent + tool + recalls + indexing), in input-token equivalents.
Stored in one small ledger per workspace (`.context-graph/ledger.json`, keyed by session), written
at most once per turn, off the critical path. The workspace total is the sum.

## THE PAGE (#36, #35)
- Host: a nested plugin with `inject: ['connection']` registers owner-only routes with
  `ctx.connection.fetch.register({ path: '/api/context-graph.<name>', methods: ['GET'],
  requestBody: 'buffered', fetch })` (rc.5: dsh-client-connection rpc.d.ts ConnectionFetchRoute;
  non-owner principals get 403). Workspaces come from `ctx.get('workspaceRegistry').list()` (each
  has `path`), plus any memory folder seen in this app run.
- Client: the existing hand-written module also registers `plugins.bundle.config` with
  `key: 'dsh-context-graph'` (rc.5 plugin manager renders it on the plugin's page with
  `{ view: 'page' }`). It fetches `api/context-graph.<name>` (document-relative), draws with
  React and the shell's `--dsw-alias-*` theme variables (light and dark), strings in en and zh.
- Map: chats as clusters (newest first), topics around them coloured by kind, sized by links, with
  links drawn; hover shows the gist, click shows the topic, its chat and the id to paste
  (`c3n12`); search and a kind filter. The overview sends labels only; gists and sources load on
  click. Private and memory-off chats are marked; this is the owner's own view.

## SCOPE (milestone v0.9.0)
- #35 savings estimate, ledger, card line, page totals; #36 the map; #37 README numbers from tests.
- Audit findings filed for v0.9.0 (bugs first).

## REQUIREMENTS
- The estimate is a pure function in src/core with tests on fixed inputs; the ledger has a store
  test; the routes have host tests (owner-only is dsh's job, but the handler must not serve a path
  outside a known workspace); the client renders in a test with a fake React.
- No new dependency, no build step, the client stays one hand-written script.
- Token claims measured in tests; README numbers come from the same tests.

## WHEN TO STOP
All v0.9.0 issues fixed and tested, the suite green in three zones (`npm run test:zones`), an
independent review (and a second one on its fixes) finds nothing it can reproduce, tag pushed.

## DO NOT
- Do not add anything to a chat's context for the display; no extra model calls.
- Do not write on every message; do not block a message on the ledger.
- Do not ask the owner questions; choose by: fewer tokens, then speed and quality, then storage.
