// No network: fetch is replaced with stubs.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fetchLatestVersion, isNewer, startUpdateCheck, updateNotice } from '../update.js'

const reply = (body, ok = true) => async () => ({ ok, json: async () => body })

test('compares versions numerically, not as text', () => {
  assert.equal(isNewer('0.10.0', '0.9.0'), true)
  assert.equal(isNewer('0.2.2', '0.2.2'), false)
  assert.equal(isNewer('0.2.1', '0.2.2'), false)
  assert.equal(isNewer('garbage', '0.2.2'), false)
})

test('only an older copy gets a notice, naming the exact version to install', () => {
  assert.equal(updateNotice('0.2.2', '0.2.2'), undefined)
  assert.equal(updateNotice(undefined, '0.2.2'), undefined)
  assert.match(updateNotice('0.2.3', '0.2.2'), /0\.2\.3 is available \(you have 0\.2\.2\).*Add plugin dsh-context-graph@0\.2\.3/)
})

test('reads the npm registry answer; failures give no version', async () => {
  assert.equal(await fetchLatestVersion({ fetchImpl: reply({ version: '0.3.0' }) }), '0.3.0')
  assert.equal(await fetchLatestVersion({ fetchImpl: reply({}, false) }), undefined)
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => { throw new Error('offline') } }), undefined)
})

test('the opt-out variable skips the network call', async () => {
  let called = false
  const check = startUpdateCheck('0.2.2', { env: { DSH_CONTEXT_GRAPH_NO_UPDATE_CHECK: '1' }, fetchImpl: async () => { called = true } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(called, false)
  assert.equal(check.current(), undefined)
  const live = startUpdateCheck('0.2.2', { env: {}, fetchImpl: reply({ version: '0.2.3' }) })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.match(live.current(), /0\.2\.3 is available/)
})
