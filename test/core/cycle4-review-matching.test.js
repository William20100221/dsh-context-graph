/**
 * Review of cycle 4 (v0.10.0): matching, pure, on small workspaces and the relevance corpus (whose
 * EVERYDAY set now holds the window/Windows messages too). Each test fails without its fix; the
 * review's finding (K6, K7, R2) is in the name.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { emptyGraph, matchAcross, mergeDelta, searchUnits, tokenize } from '../../src/core/index.js'
import { corpusViews } from '../fixtures/relevance-corpus.js'

const ids = (r) => r.hits.map((h) => h.id)
const view = (cid, label, gist, aliases = []) => {
  const graph = emptyGraph()
  mergeDelta(graph, { nodes: [{ label, gist, aliases, msgs: [0] }], edges: [] }, { now: '2026-11-01T00:00:00Z' })
  return { sid: `s${cid}`, cid, meta: { cid }, graph, own: false }
}

test('review K6: Windows, Teams and Sheets are names, not the plurals of window, team and sheet', () => {
  assert.deepEqual(tokenize('Windows Teams Sheets Pages Actions windows'), ['windows', 'teams', 'sheets', 'pages', 'actions'])
  assert.deepEqual(tokenize('tests caches'), ['test', 'cach'], 'other plurals still fold')
  const views = [
    view(1, 'Windows line endings', 'core.autocrlf false plus .gitattributes eol=lf; CRLF broke the shell scripts', ['crlf']),
    view(2, 'MS Teams webhook alerts', 'deploy alerts post to the releases channel through an incoming webhook', ['teams webhook']),
    view(3, 'Google Sheets export', 'nightly export of signups to a shared sheet through a service account', ['sheets export'])
  ]
  for (const q of ['the modal window closes but the line under the title is misaligned', 'my team needs a webhook for the new storefront orders', 'sheet music app: how do I export a sheet as PDF?']) {
    assert.deepEqual(ids(matchAcross(views, q)), [], q)
  }
  // The names still find their topics, however they are cased.
  for (const [q, want] of [['why are windows line endings breaking the scripts', 'c1n1'], ['where do the Teams alerts go', 'c2n1'], ['how often does the sheets export run', 'c3n1']]) {
    assert.deepEqual(ids(matchAcross(views, q)), [want], q)
  }
  assert.deepEqual(ids(matchAcross(corpusViews().views, 'the windows path bug with import in the plugin again')), ['c5n7'])
})

test('review R2: a brand typed in lowerCamel is not code to a topic that names it plainly', () => {
  const views = [
    view(1, 'MacBook dev setup', 'brew bundle from the dotfiles repo; Node through fnm'),
    view(2, 'DeepSeek 前缀缓存计费', '缓存命中按十分之一计费，所以记忆块追加在请求末尾', ['prefix cache']),
    view(3, 'MongoDB connection pooling', 'maxPoolSize 20 per instance'),
    view(4, 'useAuthSession hook', 'one hook owns token refresh and logout across tabs')
  ]
  for (const q of ['my macBook keyboard is sticky', 'is deepSeek down today?', '用deepSeek写周报好用吗', 'should I use mongoDB for my recipe app?']) {
    assert.deepEqual(ids(matchAcross(views, q)), [], q)
  }
  // An identifier the topic writes as code still counts double: alone it finds its topic.
  assert.deepEqual(ids(matchAcross(views, 'why does useAuthSession log me out?')), ['c4n1'])
  assert.deepEqual(ids(matchAcross(views, 'mongoDB connection pool size?')), ['c3n1'])
})

test('review K7: a pasted base64 blob is one plain word, not a lowerCamel identifier of hundreds of humps', () => {
  // A service-account key as a Kubernetes Secret holds it: base64 of its JSON, without + or /.
  const key = Array.from({ length: 26 }, (_, i) => createHash('sha512').update(`0:${i}`).digest('base64').slice(0, 64)).join('\n')
  const blob = Buffer.from(JSON.stringify({ type: 'service_account', project_id: 'acme-prod', private_key: `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----\n` }, null, 2)).toString('base64')
  assert.deepEqual(searchUnits(blob).map((u) => [u.tokens.length, u.code]), [[1, false]])
  const { views } = corpusViews({ code: true })
  for (const q of ['what is wrong with this config for the release?', 'the cache key is rejected, here is the value:']) {
    assert.deepEqual(ids(matchAcross(views, q)), [], q)
    assert.deepEqual(ids(matchAcross(views, `${q}\n${blob}`)), [], `${q} + the blob`)
  }
  // Identifiers are shorter: 40 characters and 6 humps at most. A JWT header has 14.
  for (const word of ['getDerivedStateFromProps', 'isAbsoluteUrlWithoutQueryString']) assert.equal(searchUnits(word)[0].code, true, word)
  for (const word of ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', `${'x'.repeat(40)}Done`]) assert.equal(searchUnits(word)[0].code, false, word)
})
