// Loads lib/client.js the way the dsh shell does (a plain script calling window.__ModuleLoader__),
// with stand-ins for the shared modules; also checks the package metadata dsh reads for the Plugins page.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

function loadClient({ openState = false } = {}) {
  let entry
  const window = { __ModuleLoader__: { load: (e) => { entry = e } } }
  vm.runInNewContext(read('lib/client.js'), { window, document: undefined })
  assert.equal(entry.id, 'dsh-context-graph', 'id must equal the package name')
  const element = (type, props) => ({ type, props })
  const shared = {
    react: { useState: (initial) => [openState || initial, () => {}] },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    '@deepseek-ai/dsh-client-ui-primitives': { DisclosureRow: 'DisclosureRow' }
  }
  return entry.factory((name) => {
    if (!(name in shared)) throw new Error(`unexpected require: ${name}`)
    return shared[name]
  })
}

const t = (key) => `t:${key}`
const row = (card) => card.props.children.props

test('registers one card keyed to the /context-graph command, with en and zh text', () => {
  const calls = []
  loadClient().apply({
    effect: (fn) => fn(),
    locale: { register: (ns, dict) => calls.push(['locale', ns, Object.keys(dict)]) },
    slots: { inject: (name, fn) => { calls.push(['inject', name]); fn() }, register: (options, component) => calls.push(['register', options, component.name]) }
  })
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['locale', 'dsh-context-graph', ['en', 'zh']],
    ['inject', 'conversation.chat.commandview'],
    ['register', { name: 'conversation.chat.commandview', key: 'context-graph', locale: 'dsh-context-graph' }, 'ContextGraphCard']
  ])
})

test('title follows the subcommand; line 1 is the summary; the rest opens on click', () => {
  const client = loadClient()
  assert.equal(client.subcommandOf(' fold'), 'fold')
  assert.equal(client.subcommandOf(''), 'stats')
  assert.equal(client.subcommandOf('nonsense'), 'stats')
  const text = 'Folded t1-t9 · ~30000 → ~900 tokens per request\nThe model now sees a table of contents.'
  const closed = row(client.ContextGraphCard({ node: { args: ' fold', outcome: { kind: 'success', text } }, t }))
  assert.equal(closed.title, 't:fold')
  assert.equal(closed.collapsedContent.props.children, 'Folded t1-t9 · ~30000 → ~900 tokens per request')
  assert.equal(closed.expandable, true)
  assert.equal(closed.children, undefined, 'body hidden until opened')
  const opened = row(loadClient({ openState: true }).ContextGraphCard({ node: { args: ' fold', outcome: { kind: 'success', text } }, t }))
  assert.equal(opened.children.props.children, 'The model now sees a table of contents.')
})

test('running and failed states', () => {
  const client = loadClient()
  const running = row(client.ContextGraphCard({ node: { args: ' build', outcome: null }, t }))
  assert.equal(running.running, true)
  assert.equal(running.collapsedContent.props.children, 't:running')
  const failed = row(client.ContextGraphCard({ node: { args: ' build', outcome: { kind: 'error', text: 'Build failed: timeout' } }, t }))
  assert.equal(failed.collapsedContent.props['data-error'], true)
  assert.equal(failed.expandable, false)
})

test('Plugins page metadata: icon, translated title and description, Chinese detail page', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.icon, './icon.svg')
  assert.ok(statSync(new URL('icon.svg', root)).size < 256 * 1024)
  assert.match(read('icon.svg'), /^<svg width="36" height="36" viewBox="0 0 36 36"/)
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  for (const lang of ['en', 'zh']) {
    const { meta } = JSON.parse(read(`locale/${lang}.json`))
    assert.ok(meta.title && meta.description, `${lang} has title and description`)
    if (meta.detail) assert.ok(existsSync(new URL(meta.detail, root)), `${lang} detail file exists`)
  }
  for (const file of ['icon.svg', 'locale', 'lib/client.js', 'README.zh.md', 'update.js']) assert.ok(pkg.files.includes(file), `${file} is published`)
})
