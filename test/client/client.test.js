// Loads src/client/client.js the way the dsh shell does (a plain script calling window.__ModuleLoader__),
// with stand-ins for the shared modules; also checks the package metadata dsh reads for the Plugins page.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const root = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

/**
 * React's hooks, kept in slots: `render` draws a component again with the state its hooks left (one
 * component per fake); a component only called directly gets fresh slots. Effects are collected.
 */
function fakeReact({ openState = false, effects = [] } = {}) {
  const slots = []
  let i = 0
  const slot = (make) => {
    if (!(i in slots)) slots[i] = make()
    return slots[i++]
  }
  return {
    useState: (initial) => {
      const s = slot(() => ({ value: openState || initial }))
      return [s.value, (v) => { s.value = typeof v === 'function' ? v(s.value) : v }]
    },
    useRef: (current) => slot(() => ({ current })),
    useEffect: (fn) => effects.push(fn),
    render: (component, props) => { i = 0; return component(props) }
  }
}

function loadClient({ openState = false, fetch, effects = [], globals = {}, react = fakeReact({ openState, effects }) } = {}) {
  let entry
  const window = { __ModuleLoader__: { load: (e) => { entry = e } } }
  vm.runInNewContext(read('src/client/client.js'), { window, document: undefined, fetch, URLSearchParams, Promise, Map, Number, Math, String, ...globals })
  assert.equal(entry.id, 'dsh-context-graph', 'id must equal the package name')
  const element = (type, props, key) => ({ type, props, key })
  const shared = {
    react,
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

test('registers the command card, the savings page in Plugins, and Memory tree in the sidebar with its page (#85)', () => {
  const calls = []
  const labels = []
  loadClient().apply({
    effect: (fn) => fn(),
    locale: { register: (ns, dict) => calls.push(['locale', ns, Object.keys(dict)]), bind: (ns) => (key) => `${ns}:${key}` },
    slots: { inject: (name, fn) => { calls.push(['inject', name]); fn() }, register: (options, component) => { if (options.label) labels.push(options.label()); calls.push(['register', options, component.name]) } }
  })
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['locale', 'dsh-context-graph', ['en', 'zh']],
    ['inject', 'conversation.chat.commandview'],
    ['register', { name: 'conversation.chat.commandview', key: 'context-graph', locale: 'dsh-context-graph' }, 'ContextGraphCard'],
    ['inject', 'plugins.bundle.config'],
    ['register', { name: 'plugins.bundle.config', key: 'dsh-context-graph', locale: 'dsh-context-graph' }, 'SavingsPage'],
    // The entry and its page share one id, as dsh's own Automation tasks do.
    ['inject', 'main'],
    ['register', { name: 'main', key: 'dsh-context-graph', locale: 'dsh-context-graph' }, 'TreePage'],
    ['inject', 'sidebar.panellist'],
    ['register', { name: 'sidebar.panellist', id: 'dsh-context-graph', order: 30, locale: 'dsh-context-graph' }, 'TreeIcon']
  ])
  assert.deepEqual(labels, ['dsh-context-graph:panel'], 'the label is read through the app\'s locale, so it follows the language')
})

test('the sidebar icon takes the size the row asks for (#85)', () => {
  const client = loadClient()
  assert.equal(client.TreeIcon({ size: 16, active: false }).props.width, 16)
  assert.equal(client.TreeIcon({}).props.width, 20)
})

test('the plugin page keeps the savings and says where the tree is; it asks for no map (#85)', async () => {
  const effects = []
  const react = fakeReact({ effects })
  const { fetch, answer } = lateFetch()
  const asked = []
  const client = loadClient({ fetch: (url) => { asked.push(url); return fetch(url) }, react })
  const page = () => react.render(client.SavingsPage, { t })
  page()
  for (const run of effects.splice(0)) run()
  await answer('api/context-graph.overview', { workspaces: [{ key: 'a', title: 'A', indexed: 1, topics: 1, savings: { saved: 5, cost: 2, net: 3 } }] })
  assert.ok(find(page(), (e) => e.type?.name === 'Savings'))
  assert.ok(find(page(), (e) => e.props?.children === 't:treeHint'))
  assert.equal(find(page(), (e) => e.type === client.MemoryMap), undefined)
  assert.deepEqual(asked, ['api/context-graph.overview'])
})

/** Every element of a rendered tree, depth first. */
function* walk(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) yield* walk(n); return }
  yield node
  yield* walk(node.props?.children)
}

test('the plugin page asks the host for the overview and shows loading meanwhile (#36)', () => {
  const asked = []
  const effects = []
  const client = loadClient({ effects, fetch: (url) => { asked.push(url); return new Promise(() => {}) } })
  const page = client.SavingsPage({ t })
  assert.match(JSON.stringify(page), /t:loading/)
  for (const run of effects) run()
  assert.deepEqual(asked, ['api/context-graph.overview'], 'document-relative, like dsh\'s own routes')
})

test('the map draws every topic from the host layout; search and kind dim the rest (#36)', () => {
  const client = loadClient()
  const map = { width: 1400, height: 300, chats: [{ cid: 1, x: 50, y: 50, r: 40, summary: 'CI setup', shared: true, memory: true, shown: 2, total: 2 }], topics: [[1, 'n1', 'pnpm cache', 'decision', 40, 50, 1], [1, 'n2', 'node matrix', 'fact', 60, 50, 1]], edges: [[1, 'n1', 'n2', 'uses']] }
  const opened = []
  const tree = client.MemoryMap({ map, t, onOpen: (id) => opened.push(id) })
  const circles = [...walk(tree)].filter((e) => e.type === 'circle' && e.props.className === 'dshcg-topic')
  assert.equal(circles.length, 2)
  assert.equal([...walk(tree)].filter((e) => e.type === 'line').length, 1)
  circles[0].props.onClick()
  assert.deepEqual(opened, ['c1n1'])
  assert.ok(circles.every((c) => c.props['data-dim'] === 'false'), 'nothing dimmed without a search')
})

const find = (tree, match) => [...walk(tree)].find(match)
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** A fetch the test answers itself, one URL at a time and in any order. */
function lateFetch() {
  const waiting = new Map()
  return {
    fetch: (url) => new Promise((resolve) => waiting.set(url, resolve)),
    answer: (url, body) => {
      assert.ok(waiting.has(url), `the page asked for ${url}`)
      waiting.get(url)({ ok: true, json: async () => body })
      return settle()
    },
    fail: (url) => {
      assert.ok(waiting.has(url), `the page asked for ${url}`)
      waiting.get(url)({ ok: false, status: 500, json: async () => ({ error: 'failed' }) })
      return settle()
    }
  }
}

const mapOf = (key) => ({ key, width: 1400, height: 100, chats: [], topics: [], edges: [] })
const topicOf = (id, links = []) => ({ id, label: id, gist: '', kind: 'fact', chat: { cid: 1, summary: '' }, links, sources: [] })

/** A page once the overview came back: the tree page has asked for the first workspace's map itself. */
async function openPage(workspaces, component = 'TreePage') {
  const effects = []
  const react = fakeReact({ effects })
  const { fetch, answer, fail } = lateFetch()
  const client = loadClient({ fetch, react })
  const page = () => react.render(client[component], { t })
  page()
  for (const run of effects.splice(0)) run()
  await answer('api/context-graph.overview', { workspaces })
  return { client, page, answer, fail }
}

test('a late map or topic answer does not replace the one asked for since', async () => {
  const { client, page, answer } = await openPage([{ key: 'a', title: 'A', indexed: 1, topics: 1 }, { key: 'b', title: 'B', indexed: 1, topics: 1 }])
  find(page(), (e) => e.type === 'button' && e.key === 'b').props.onClick() // before A's map came back
  await answer('api/context-graph.map?w=b', mapOf('b'))
  await answer('api/context-graph.map?w=a', mapOf('a'))
  const drawn = () => find(page(), (e) => e.type === client.MemoryMap)
  assert.equal(drawn().props.map.key, 'b', 'the map of the workspace picked')
  drawn().props.onOpen('c1n1')
  drawn().props.onOpen('c1n2')
  await answer('api/context-graph.topic?w=b&id=c1n2', topicOf('c1n2'))
  await answer('api/context-graph.topic?w=b&id=c1n1', topicOf('c1n1'))
  assert.equal(find(page(), (e) => e.type === client.TopicPanel)?.props.detail.id, 'c1n2', 'the topic clicked last')
})

test('a topic asked in one workspace and answered after switching to another is dropped', async () => {
  const { client, page, answer } = await openPage([{ key: 'a', title: 'A', indexed: 1, topics: 1 }, { key: 'b', title: 'B', indexed: 1, topics: 1 }])
  await answer('api/context-graph.map?w=a', mapOf('a'))
  find(page(), (e) => e.type === client.MemoryMap).props.onOpen('c1n1') // in A
  find(page(), (e) => e.type === 'button' && e.key === 'b').props.onClick() // before the topic came back
  await answer('api/context-graph.map?w=b', mapOf('b'))
  await answer('api/context-graph.topic?w=a&id=c1n1', topicOf('c1n1'))
  assert.equal(find(page(), (e) => e.type === client.TopicPanel), undefined, 'A\'s topic is not drawn under B\'s map, where its links would ask B')
})

test('each topic gets a new panel, two links to one topic stay two, and Copied means copied', async () => {
  const { client, page, answer } = await openPage([{ key: 'a', title: 'A', indexed: 1, topics: 2 }])
  await answer('api/context-graph.map?w=a', mapOf('a'))
  find(page(), (e) => e.type === client.MemoryMap).props.onOpen('c1n1')
  const links = [{ id: 'c1n2', label: 'node matrix', relation: 'uses', direction: 'out' }, { id: 'c1n2', label: 'node matrix', relation: 'part-of', direction: 'in' }]
  await answer('api/context-graph.topic?w=a&id=c1n1', topicOf('c1n1', links))
  const panel = find(page(), (e) => e.type === client.TopicPanel)
  assert.equal(panel.key, 'c1n1', 'keyed by topic, so c1n2 does not inherit this panel or its Copied')
  const written = []
  const panelWith = (clipboard) => {
    const react = fakeReact()
    const own = loadClient({ react, globals: { navigator: { clipboard } } })
    return () => react.render(own.TopicPanel, panel.props)
  }
  const keys = [...walk(panelWith(undefined)())].filter((e) => e.type === 'button' && e.key !== undefined).map((e) => e.key)
  assert.equal(new Set(keys).size, links.length, 'one button and key per link')
  // No clipboard on plain-http remote access: nothing was copied, so nothing says Copied.
  for (const [clipboard, says] of [[undefined, 't:copyId'], [{ writeText: async (text) => { written.push(text) } }, 't:copied']]) {
    const draw = panelWith(clipboard)
    find(draw(), (e) => e.props?.children === 't:copyId').props.onClick()
    await settle()
    assert.ok(find(draw(), (e) => e.props?.children === says), `${clipboard ? 'with' : 'without'} a clipboard the button says ${says}`)
  }
  assert.deepEqual(written, ['c1n1'])
})

test('the map view has the box\'s proportions: whole width from the newest row, dragged at pointer speed', () => {
  const box = { clientWidth: 720, clientHeight: 460 } // not the 1000 x 460 the view starts from, so the measuring counts
  /** MemoryMap in that box, measured as ResizeObserver reports it once mounted. */
  const mount = (map) => {
    let report
    const effects = []
    const react = fakeReact({ effects })
    const client = loadClient({ react, globals: { ResizeObserver: class { constructor(fn) { report = fn } observe() {} disconnect() {} } } })
    const draw = () => react.render(client.MemoryMap, { map, t, onOpen: () => {} })
    draw()
    for (const run of effects.splice(0)) run()
    report?.([{ contentRect: { width: box.clientWidth, height: box.clientHeight } }])
    const svg = () => find(draw(), (e) => e.type === 'svg')
    return { draw, svg, viewBox: () => svg().props.viewBox.split(' ').map(Number) }
  }
  const big = mount({ width: 1400, height: 4420, chats: [], topics: [], edges: [] }) // 150 chats of 60 topics
  assert.deepEqual(big.viewBox().map(Math.round), [0, 0, 1400, 894], 'the whole width from the top, as tall as the box allows (1400 x 460 / 720)')
  // Dragging 100 px left and 50 px up moves the drawn map as far (`meet` scales by the tighter side).
  big.svg().props.onPointerDown({ clientX: 500, clientY: 300 })
  big.svg().props.onPointerMove({ clientX: 400, clientY: 250, currentTarget: box })
  const [x, y, w, h] = big.viewBox()
  const unitsPerPixel = Math.max(w / box.clientWidth, h / box.clientHeight)
  assert.deepEqual([x / unitsPerPixel, y / unitsPerPixel].map(Math.round), [100, 50])
  find(big.draw(), (e) => e.props?.children === '+').props.onClick()
  const [, , zw, zh] = big.viewBox()
  assert.ok(Math.abs(zh / zw - 460 / 720) < 1e-9, 'zooming keeps the proportions')
  const [sx, sy, sw, sh] = mount({ width: 1400, height: 200, chats: [], topics: [], edges: [] }).viewBox()
  assert.ok(sx <= 0 && sy <= 0 && sw >= 1400 && sh >= 200, 'one row of chats is shown whole')
})

test('a chat label keeps its number and marks whole, cuts its summary to its slot in the row, and shows in full on hover', () => {
  const words = { private: 'private', memoryOff: 'memory off' }
  const chats = [
    { cid: 12, x: 112, y: 130, r: 112, summary: 'Release checklist and the npm publish steps for v0.8', shared: false, memory: false, shown: 100, total: 100 },
    { cid: 3, x: 280, y: 50, r: 32, summary: '设置持续集成流水线的缓存', shared: true, memory: true, shown: 1, total: 1 },
    // Small chats: marks that do not fit in words become symbols, never cut ('c7 · memory…' would
    // read as on) and never run into the next chat (second review).
    { cid: 7, x: 368, y: 50, r: 32, summary: 'Release checklist', shared: true, memory: false, shown: 1, total: 1 },
    { cid: 8, x: 472, y: 66, r: 48, summary: 'Release checklist', shared: false, memory: false, shown: 7, total: 7 }
  ]
  const tree = loadClient().MemoryMap({ map: { width: 1400, height: 260, chats, topics: [], edges: [] }, t: (key) => words[key] ?? `t:${key}`, onOpen: () => {} })
  const labels = [...walk(tree)].filter((e) => e.type === 'g').map((g) => [find(g, (e) => e.type === 'text')?.props.children, find(g, (e) => e.type === 'title')?.props.children])
  assert.deepEqual(labels, [
    ['c12 · private · memory off · Release ch…', 'c12 · private · memory off · Release checklist and the npm publish steps for v0.8'],
    ['c3 · 设置持…', 'c3 · 设置持续集成流水线的缓存'], // a CJK character counts as two letters
    ['c7 · ⏸', 'c7 · memory off · Release checklist'],
    ['c8 · 🔒⏸ · Releas…', 'c8 · private · memory off · Release checklist']
  ])
})

test('title follows the subcommand; line 1 is the summary; the rest opens on click', () => {
  const client = loadClient()
  assert.equal(client.subcommandOf(' on'), 'on')
  assert.equal(client.subcommandOf(' map'), 'map')
  assert.equal(client.subcommandOf(''), 'stats')
  assert.equal(client.subcommandOf('nonsense'), 'stats')
  const text = 'Memory on · 3 topics in this chat · 2 shared chats to draw on\nThis chat indexes itself every 4 turns.'
  const closed = row(client.ContextGraphCard({ node: { args: ' on', outcome: { kind: 'success', text } }, t }))
  assert.equal(closed.title, 't:on')
  assert.equal(closed.collapsedContent.props.children, 'Memory on · 3 topics in this chat · 2 shared chats to draw on')
  assert.equal(closed.expandable, true)
  assert.equal(closed.children, undefined, 'body hidden until opened')
  const opened = row(loadClient({ openState: true }).ContextGraphCard({ node: { args: ' on', outcome: { kind: 'success', text } }, t }))
  assert.equal(opened.children.props.children, 'This chat indexes itself every 4 turns.')
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
  assert.equal(pkg.exports['./client'], './src/client/client.js')
  for (const lang of ['en', 'zh']) {
    const { meta } = JSON.parse(read(`locale/${lang}.json`))
    assert.ok(meta.title && meta.description, `${lang} has title and description`)
    if (meta.detail) assert.ok(existsSync(new URL(meta.detail, root)), `${lang} detail file exists`)
  }
  for (const file of ['icon.svg', 'locale', 'src', 'README.zh.md']) assert.ok(pkg.files.includes(file), `${file} is published`)
})

test('a topic that cannot be read says so; a failed map can be asked again; Close drops a topic on its way (second review)', async () => {
  const { client, page, answer, fail } = await openPage([{ key: 'a', title: 'A', indexed: 1, topics: 2 }])
  await fail('api/context-graph.map?w=a')
  const retry = find(page(), (e) => e.type === 'button' && e.props.children === 't:retry')
  assert.ok(retry, 'a Retry next to the map error, also with one workspace')
  retry.props.onClick()
  await answer('api/context-graph.map?w=a', mapOf('a'))
  const drawn = () => find(page(), (e) => e.type === client.MemoryMap)
  drawn().props.onOpen('c1n1')
  await answer('api/context-graph.topic?w=a&id=c1n1', topicOf('c1n1'))
  drawn().props.onOpen('c1n2')
  await fail('api/context-graph.topic?w=a&id=c1n2')
  assert.equal(find(page(), (e) => e.type === client.TopicPanel), undefined, 'not the last topic, as if it were c1n2')
  assert.ok(find(page(), (e) => e.props?.children === 't:topicFailed'))
  drawn().props.onOpen('c1n1')
  find(page(), (e) => e.type === 'button' && e.props.children === 't:close').props.onClick()
  await answer('api/context-graph.topic?w=a&id=c1n1', topicOf('c1n1'))
  assert.equal(find(page(), (e) => e.type === client.TopicPanel), undefined, 'a late answer does not reopen a closed panel')
})

test('the page states the savings rule the code follows (second review)', () => {
  const dicts = {}
  loadClient().apply({ effect: (fn) => fn(), locale: { register: (ns, dict) => Object.assign(dicts, dict) }, slots: { inject: (name, fn) => fn(), register: () => {} } })
  assert.doesNotMatch(dicts.en.savingsRule, /minus/)
  assert.match(dicts.en.savingsRule, /newest messages as stored, each counted once per chat/)
  assert.doesNotMatch(dicts.zh.savingsRule, /减去/)
})

test('savings the host cannot read say so, and a big chat keeps its hidden-topic count among the symbols (third review)', () => {
  const client = loadClient()
  const words = { private: 'private', memoryOff: 'memory off', more: 'more not drawn', savingsUnavailable: 'unavailable' }
  const tt = (key) => words[key] ?? `t:${key}`
  assert.equal(client.MemoryMap === undefined, false)
  const chats = [{ cid: 12, x: 112, y: 130, r: 112, summary: 'Release checklist and the npm publish steps for v0.8', shared: false, memory: false, shown: 120, total: 200 }]
  const tree = client.MemoryMap({ map: { width: 1400, height: 260, chats, topics: [], edges: [] }, t: tt, onOpen: () => {} })
  const label = find(tree, (e) => e.type === 'text')?.props.children
  assert.match(label, /^c12 · 🔒⏸ · \+80/)
})

test('the page says the savings are unavailable when the host could not read them, instead of zeros (third review)', async () => {
  const { page } = await openPage([{ key: 'a', title: 'A', indexed: 1, topics: 1, savings: null }], 'SavingsPage')
  const savings = find(page(), (e) => e.type?.name === 'Savings')
  assert.equal(savings.type(savings.props).props.children, 't:savingsUnavailable')
})
