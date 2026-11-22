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
    ['register', { name: 'sidebar.panellist', id: 'dsh-context-graph', order: 30, locale: 'dsh-context-graph' }, 'TreeIcon'],
    // #92: the chip beside dsh's preset label (-10), the session menu row, the dialog in the overlay.
    ['inject', 'conversation.session.header.actions'],
    ['register', { name: 'conversation.session.header.actions', id: 'context-graph-chip', order: -5, locale: 'dsh-context-graph' }, 'MemoryChip'],
    ['inject', 'sidebar.workspaces.session.menu.item'],
    ['register', { name: 'sidebar.workspaces.session.menu.item', id: 'context-graph-archive-forget', order: 900, locale: 'dsh-context-graph' }, 'ForgetMenuItem'],
    ['inject', 'shell.overlay'],
    ['register', { name: 'shell.overlay', id: 'context-graph-dialog', locale: 'dsh-context-graph' }, 'ForgetDialog']
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
  assert.equal(find(page(), (e) => e.type === client.MemoryTree), undefined)
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

const find = (tree, match) => [...walk(tree)].find(match)
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** A fetch the test answers itself, one URL at a time and in any order. */
function lateFetch() {
  const waiting = new Map()
  const asked = []
  return {
    asked,
    fetch: (url) => { asked.push(url); return new Promise((resolve) => waiting.set(url, resolve)) },
    answer: (url, body) => {
      assert.ok(waiting.has(url), `the page asked for ${url}`)
      waiting.get(url)({ ok: true, json: async () => body })
      waiting.delete(url) // answered: asking again must be a new request
      return settle()
    },
    fail: (url) => {
      assert.ok(waiting.has(url), `the page asked for ${url}`)
      waiting.get(url)({ ok: false, status: 500, json: async () => ({ error: 'failed' }) })
      waiting.delete(url)
      return settle()
    }
  }
}

const mapOf = (key) => ({ key, title: key, chats: [{ cid: 1, summary: '', shared: true, memory: true, total: 1, topics: [['n1', 'a topic', 'fact']], links: [] }] })
const topicOf = (id, links = []) => ({ id, label: id, gist: '', kind: 'fact', chat: { cid: 1, summary: '' }, links, sources: [] })

/** A page once the overview came back: the tree page has asked for the first workspace's map itself. */
async function openPage(workspaces, component = 'TreePage') {
  const effects = []
  const react = fakeReact({ effects })
  const { fetch, answer, fail, asked } = lateFetch()
  const client = loadClient({ fetch, react })
  const page = () => react.render(client[component], { t })
  page()
  for (const run of effects.splice(0)) run()
  await answer('api/context-graph.overview', { workspaces })
  return { client, page, answer, fail, asked }
}

test('a late tree or topic answer does not replace the one asked for since', async () => {
  const { client, page, answer } = await openPage([{ key: 'a', title: 'A', indexed: 1, topics: 1 }, { key: 'b', title: 'B', indexed: 1, topics: 1 }])
  find(page(), (e) => e.type === 'button' && e.key === 'b').props.onClick() // before A's map came back
  await answer('api/context-graph.tree?w=b', mapOf('b'))
  await answer('api/context-graph.tree?w=a', mapOf('a'))
  const drawn = () => find(page(), (e) => e.type === client.MemoryTree)
  assert.equal(drawn().props.data.key, 'b', 'the tree of the workspace picked')
  drawn().props.onOpen('c1n1')
  drawn().props.onOpen('c1n2')
  await answer('api/context-graph.topic?w=b&id=c1n2', topicOf('c1n2'))
  await answer('api/context-graph.topic?w=b&id=c1n1', topicOf('c1n1'))
  assert.equal(find(page(), (e) => e.type === client.TopicPanel)?.props.detail.id, 'c1n2', 'the topic clicked last')
})

test('a topic asked in one workspace and answered after switching to another is dropped', async () => {
  const { client, page, answer, asked } = await openPage([{ key: 'a', title: 'A', indexed: 1, topics: 1 }, { key: 'b', title: 'B', indexed: 1, topics: 1 }])
  await answer('api/context-graph.tree?w=a', mapOf('a'))
  find(page(), (e) => e.type === client.MemoryTree).props.onOpen('c1n1') // in A
  find(page(), (e) => e.type === 'button' && e.key === 'b').props.onClick() // before the topic came back
  await answer('api/context-graph.tree?w=b', mapOf('b'))
  await answer('api/context-graph.topic?w=a&id=c1n1', topicOf('c1n1'))
  assert.equal(find(page(), (e) => e.type === client.TopicPanel), undefined, 'A\'s topic is not drawn under B\'s tree, where its links would ask B')
  // B has a c1n1 of its own: opening it asks B, not A's late answer (#87 keeps topics read).
  find(page(), (e) => e.type === client.MemoryTree).props.onOpen('c1n1')
  assert.ok(asked.includes('api/context-graph.topic?w=b&id=c1n1'))
})

test('each topic gets a new panel, two links to one topic stay two, and Copied means copied', async () => {
  const { client, page, answer } = await openPage([{ key: 'a', title: 'A', indexed: 1, topics: 2 }])
  await answer('api/context-graph.tree?w=a', mapOf('a'))
  find(page(), (e) => e.type === client.MemoryTree).props.onOpen('c1n1')
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

const branch = (cid, topics, extra = {}) => ({ cid, summary: `chat ${cid}`, shared: true, memory: true, total: topics.length, topics: topics.map((k, i) => [`n${i + 1}`, `topic ${cid}.${i + 1}`, k]), links: [], ...extra })

/** MemoryTree drawn with state kept between renders. */
function mountTree(data, onOpen = () => {}, more = {}) {
  const effects = []
  const react = fakeReact({ effects })
  const client = loadClient({ react })
  const draw = () => react.render(client.MemoryTree, { data, t, onOpen, ...more })
  const nodes = () => [...walk(draw())].filter((e) => e.type === 'g' && e.props.className === 'dshcg-node')
  const node = (id) => nodes().find((g) => g.key === id)
  return { client, draw, nodes, node, ids: () => nodes().map((g) => g.key), settle: () => { draw(); for (const run of effects.splice(0)) run() } }
}

test('the tree draws the workspace, its chats and their topics; a chat opens and closes, a topic opens its details (#86)', () => {
  const opened = []
  const tree = mountTree({ key: 'a', title: 'Workspace', chats: [branch(2, ['decision', 'fact']), branch(1, ['fact'])] }, (id) => opened.push(id))
  assert.deepEqual(tree.ids(), ['w', 'c2', 'c2n1', 'c2n2', 'c1', 'c1n1'], 'tree order: a parent before its children')
  assert.equal([...walk(tree.draw())].filter((e) => e.type === 'path').length, 5, 'one link per node but the root')
  tree.node('c2').props.onClick()
  assert.deepEqual(tree.ids(), ['w', 'c2', 'c1', 'c1n1'], 'closed')
  const count = find(tree.node('c2'), (e) => e.props?.className === 'dshcg-count')
  assert.equal(count.props.children, '2', 'a closed chat says how many topics it holds')
  tree.node('c2').props.onClick()
  assert.deepEqual(tree.ids(), ['w', 'c2', 'c2n1', 'c2n2', 'c1', 'c1n1'], 'open again')
  tree.node('c1n1').props.onClick()
  assert.deepEqual(opened, ['c1n1'])
  assert.equal(find(tree.node('c1n1'), (e) => e.type === 'title').props.children, 'c1n1 topic 1.1', 'the id to recall and the whole label on hover')
})

test('the layout keeps the tidy-tree rules: a column per depth as wide as its widest node, parents centred, other parents\' children half a row further (#86)', () => {
  const client = loadClient()
  const data = { key: 'a', title: 'W', chats: [branch(1, ['fact', 'fact']), branch(2, ['fact']), branch(3, ['fact', 'fact', 'fact'])] }
  const root = client.treeItems(data, t)
  const { nodes, width, height } = client.layoutTree(root, new Set(['w', 'c1', 'c3']))
  const at = Object.fromEntries(nodes.map((n) => [n.id, n]))
  const rows = (a, b) => (at[b].y - at[a].y) / 30
  assert.equal(rows('c1n1', 'c1n2'), 1, 'siblings one row apart')
  assert.equal(rows('c1n2', 'c2'), 1.5, 'another parent\'s child half a row further')
  assert.equal(rows('c2', 'c3n1'), 1.5)
  assert.equal(at.c1.y, (at.c1n1.y + at.c1n2.y) / 2, 'a parent centred on its children')
  assert.equal(at.w.y, (at.c1.y + at.c3.y) / 2)
  for (const depth of [0, 1, 2]) assert.equal(new Set(nodes.filter((n) => n.depth === depth).map((n) => n.x)).size, 1, `one column for depth ${depth}`)
  const widest = Math.max(...nodes.filter((n) => n.depth === 1).map((n) => n.w))
  assert.equal(at.c1n1.x - at.c1.x, widest + 40, 'the next column starts after the widest chat')
  assert.ok(nodes.every((n) => n.x + n.w <= width && n.y + 11 <= height && n.y - 11 >= 0), 'everything inside the drawing')
  assert.equal(client.layoutTree(client.treeItems(data, t), new Set(['w', 'c1', 'c3'])).nodes.map((n) => [n.id, n.x, n.y]).join(), nodes.map((n) => [n.id, n.x, n.y]).join(), 'same tree, same picture')
})

test('the newest chats start open while their topics fit 40 rows, the newest at least (#86)', () => {
  const client = loadClient()
  const many = (n) => Array.from({ length: n }, () => 'fact')
  const ids = (chats) => [...client.initialOpen({ chats })]
  assert.deepEqual(ids([branch(5, many(20)), branch(4, many(15)), branch(3, many(10)), branch(2, many(1))]), ['w', 'c5', 'c4'], 'stops at the first chat that would pass 40, so the open ones stay the newest')
  assert.deepEqual(ids([branch(9, many(120)), branch(8, many(1))]), ['w', 'c9'], 'one big chat still opens')
})

test('search opens the chats with a match and dims the other topics; a kind dims the other kinds (#86)', () => {
  const more = {} // the page's toolbar state, changed between draws
  const tree = mountTree({ key: 'a', title: 'W', chats: [branch(2, many2(40)), branch(1, ['fact', 'decision'])] }, () => {}, more)
  assert.deepEqual(tree.ids().slice(-1), ['c1'], 'c1 starts closed: c2 fills the 40 rows')
  more.query = 'TOPIC 1.2'
  assert.ok(tree.ids().includes('c1n2'), 'its chat opened for the match')
  assert.equal(tree.node('c1n2').props['data-match'], 'true')
  assert.equal(tree.node('c1n1').props['data-dim'], 'true')
  assert.equal(tree.node('c1').props['data-dim'], 'false', 'chats stay readable')
  more.query = ''
  assert.ok(!tree.ids().includes('c1n2'), 'clearing the search leaves what was open as it was')
  more.kind = 'decision'
  assert.equal(tree.node('c2n1').props['data-dim'], 'true')
})

function many2(n) { return Array.from({ length: n }, () => 'fact') }

test('the toolbar sets the search, the kind and the zoom; zoom scales the drawing, not the layout (#86)', () => {
  const client = loadClient()
  const calls = []
  const bar = client.TreeTools({ t, query: '', kind: 'fact', onQuery: (q) => calls.push(['query', q]), onKind: (k) => calls.push(['kind', k]), onScale: (s) => calls.push(['scale', typeof s === 'function' ? s(1) : s]) })
  find(bar, (e) => e.type === 'input').props.onChange({ target: { value: 'cache' } })
  find(bar, (e) => e.type === 'button' && e.key === 'fact').props.onClick() // the kind shown: pressed again, all kinds
  find(bar, (e) => e.type === 'button' && e.key === 'task').props.onClick()
  for (const label of ['+', '−', 't:resetView']) find(bar, (e) => e.props?.children === label).props.onClick()
  assert.deepEqual(calls, [['query', 'cache'], ['kind', ''], ['kind', 'task'], ['scale', 1.25], ['scale', 0.8], ['scale', 1]])
  const more = { scale: 1 }
  const tree = mountTree({ key: 'a', title: 'W', chats: [branch(1, ['fact'])] }, () => {}, more)
  const svg = () => find(tree.draw(), (e) => e.type === 'svg')
  const [, , w, h] = svg().props.viewBox.split(' ').map(Number)
  assert.deepEqual([svg().props.width, svg().props.height], [w, h])
  more.scale = 1.25
  assert.deepEqual([svg().props.width, svg().props.height], [Math.round(w * 1.25), Math.round(h * 1.25)])
  assert.equal(svg().props.viewBox, `0 0 ${w} ${h}`)
})

test('a chat label keeps its number and marks whole, cuts its summary to its room, and shows in full on hover', () => {
  const words = { private: 'private', memoryOff: 'memory off' }
  const tt = (key) => words[key] ?? `t:${key}`
  const client = loadClient()
  const label = (c, room) => client.chatLabel(c, tt, room)
  assert.equal(label({ cid: 12, summary: 'Release checklist and the npm publish steps for v0.8', shared: false, memory: false, shown: 100, total: 100 }, 41), 'c12 · private · memory off · Release ch…')
  assert.equal(label({ cid: 3, summary: '设置持续集成流水线的缓存', shared: true, memory: true, shown: 1, total: 1 }, 14), 'c3 · 设置持…', 'a CJK character counts as two letters')
  // Marks that do not fit in words become symbols, never cut ('c7 · memory…' would read as on).
  assert.equal(label({ cid: 7, summary: 'Release checklist', shared: true, memory: false, shown: 1, total: 1 }, 14), 'c7 · ⏸')
  assert.equal(label({ cid: 8, summary: 'Release checklist', shared: false, memory: false, shown: 7, total: 7 }, 20), 'c8 · 🔒⏸ · Releas…')
  const tree = mountTree({ key: 'a', title: 'W', chats: [branch(12, ['fact'], { summary: 'Release checklist and the npm publish steps for v0.8, with the 2FA prompt and the tag push', shared: false })] })
  assert.match(find(tree.node('c12'), (e) => e.type === 'title').props.children, /the tag push$/)
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

test('a topic that cannot be read says so and can be asked again; a failed tree too; a late topic does not take the panel back (second review, #87)', async () => {
  const { client, page, answer, fail } = await openPage([{ key: 'a', title: 'A', indexed: 1, topics: 3 }])
  await fail('api/context-graph.tree?w=a')
  const retry = () => find(page(), (e) => e.type === 'button' && e.props.children === 't:retry')
  assert.ok(retry(), 'a Retry next to the tree error, also with one workspace')
  retry().props.onClick()
  await answer('api/context-graph.tree?w=a', mapOf('a'))
  const drawn = () => find(page(), (e) => e.type === client.MemoryTree)
  drawn().props.onOpen('c1n1')
  await answer('api/context-graph.topic?w=a&id=c1n1', topicOf('c1n1'))
  drawn().props.onOpen('c1n2')
  await fail('api/context-graph.topic?w=a&id=c1n2')
  assert.equal(find(page(), (e) => e.type === client.TopicPanel), undefined, 'not the last topic, as if it were c1n2')
  assert.ok(find(page(), (e) => e.props?.children === 't:topicFailed'))
  assert.equal(drawn().props.details.c1n2.error, true, 'the tree marks it too')
  drawn().props.onOpen('c1n2') // opened again: asked again
  await fail('api/context-graph.topic?w=a&id=c1n2')
  retry().props.onClick() // and the panel's Retry asks too
  await answer('api/context-graph.topic?w=a&id=c1n2', topicOf('c1n2'))
  assert.equal(find(page(), (e) => e.type === client.TopicPanel).props.detail.id, 'c1n2', 'asked again and shown')
  drawn().props.onOpen('c1n3')
  drawn().props.onChat(1) // before c1n3 came back
  await answer('api/context-graph.topic?w=a&id=c1n3', topicOf('c1n3'))
  assert.equal(find(page(), (e) => e.type === client.TopicPanel), undefined, 'the chat chosen since keeps the panel')
  assert.equal(find(page(), (e) => e.type === client.ChatPanel).props.chat.cid, 1)
  find(page(), (e) => e.type === client.ChatPanel).props.onClose()
  assert.equal(find(page(), (e) => e.type === client.ChatPanel), undefined)
})

test('a topic is read once; its messages become its children in the tree, newest last, and lead back to it (#87)', async () => {
  const { client, page, answer, asked: requests } = await openPage([{ key: 'a', title: 'A', indexed: 1, topics: 1 }])
  await answer('api/context-graph.tree?w=a', mapOf('a'))
  const drawn = () => find(page(), (e) => e.type === client.MemoryTree)
  drawn().props.onOpen('c1n1')
  const sources = [{ role: 'user', turn: 7, text: 'Which cache\nshould we use?' }, { role: 'assistant', text: 'pnpm store' }]
  await answer('api/context-graph.topic?w=a&id=c1n1', { ...topicOf('c1n1'), sources })
  drawn().props.onOpen('c1n1')
  assert.equal(requests.filter((url) => url.includes('id=c1n1')).length, 1, 'read already: nothing is asked')
  assert.equal(find(page(), (e) => e.type === client.TopicPanel).props.detail.id, 'c1n1')
  const asked = []
  // The tree with that answer, the topic open.
  const tree = mountTree(mapOf('a'), (id) => asked.push(id), { details: { c1n1: { ...topicOf('c1n1'), sources } } })
  tree.node('c1n1').props.onClick() // opens it
  assert.deepEqual(tree.ids(), ['w', 'c1', 'c1n1', 'c1n1s0', 'c1n1s1'])
  assert.equal(find(tree.node('c1n1s0'), (e) => e.props?.className === 'dshcg-label').props.children, 'user t7 · Which cache should we use?')
  tree.node('c1n1s1').props.onClick()
  assert.deepEqual(asked, ['c1n1', 'c1n1'], 'a message leads back to its topic')
})

test('a topic on its way shows …, one that failed shows !, a chosen node is marked, and a chat click shows the chat (#87)', () => {
  const chats = []
  const tree = mountTree(mapOf('a'), () => {}, { details: { c1n1: { loading: true } }, selected: { chat: 1 }, onChat: (cid) => chats.push(cid) })
  const badge = (id) => find(tree.node(id), (e) => e.props?.className === 'dshcg-count')?.props.children
  assert.equal(badge('c1n1'), '…')
  assert.equal(tree.node('c1').props['data-selected'], 'true')
  tree.node('c1').props.onClick()
  assert.deepEqual(chats, [1])
  const failed = mountTree(mapOf('a'), () => {}, { details: { c1n1: { error: true } } })
  assert.equal(find(failed.node('c1n1'), (e) => e.props?.className === 'dshcg-count').props.children, '!')
  assert.match(find(failed.node('c1n1'), (e) => e.type === 'title').props.children, /t:topicFailed$/)
})

test('a chat\'s panel shows its marks, dates and savings, or says the savings cannot be read (#87)', () => {
  const client = loadClient()
  const text = (panel) => JSON.stringify(panel)
  const chat = { cid: 4, title: 'NZQA research', summary: 'Earth and Space Science', shared: false, memory: true, total: 9, startedAt: '2026-11-01T00:00:00Z', lastActiveAt: '2026-11-20T00:00:00Z', savings: { saved: 2590, cost: 6838, net: -4248 } }
  const shown = text(client.ChatPanel({ chat, t, onClose: () => {} }))
  assert.match(shown, /t:private/)
  assert.doesNotMatch(shown, /t:memoryOff/)
  assert.match(shown, /9 t:topics/)
  assert.match(shown, /t:saved 2,590 · t:cost 6,838 · t:net −4,248/)
  assert.match(text(client.ChatPanel({ chat: { ...chat, savings: null }, t, onClose: () => {} })), /t:savingsUnavailable/)
})

test('the page states the savings rule the code follows (second review)', () => {
  const dicts = {}
  loadClient().apply({ effect: (fn) => fn(), locale: { register: (ns, dict) => Object.assign(dicts, dict) }, slots: { inject: (name, fn) => fn(), register: () => {} } })
  assert.doesNotMatch(dicts.en.savingsRule, /minus/)
  assert.match(dicts.en.savingsRule, /newest messages as stored, each counted once per chat/)
  assert.doesNotMatch(dicts.zh.savingsRule, /减去/)
})

test('a big chat keeps its hidden-topic count among the symbols (third review)', () => {
  const words = { private: 'private', memoryOff: 'memory off', more: 'more not drawn' }
  const c = { cid: 12, summary: 'Release checklist and the npm publish steps for v0.8', shared: false, memory: false, shown: 120, total: 200 }
  assert.match(loadClient().chatLabel(c, (key) => words[key] ?? `t:${key}`, 41), /^c12 · 🔒⏸ · \+80/)
})

test('the page says the savings are unavailable when the host could not read them, instead of zeros (third review)', async () => {
  const { page } = await openPage([{ key: 'a', title: 'A', indexed: 1, topics: 1, savings: null }], 'SavingsPage')
  const savings = find(page(), (e) => e.type?.name === 'Savings')
  assert.equal(savings.type(savings.props).props.children, 't:savingsUnavailable')
})

// ---- #88: keyboard, family focus, motion ---------------------------------------------------------

/** A stand-in DOM element for a node's ref: records focus and animations. */
const fakeEl = (log = []) => ({ dataset: {}, focus() { log.push(['focus', this.id]) }, animate(frames, options) { log.push(['animate', frames, options]) } })

test('the arrow keys follow the W3C tree view pattern on the visible rows (#88)', () => {
  const client = loadClient()
  const data = { key: 'a', title: 'W', chats: [branch(2, ['fact', 'fact']), branch(1, ['fact'])] }
  const open = new Set(['w', 'c2'])
  const { nodes } = client.layoutTree(client.treeItems(data, t), open)
  const k = (id, key) => JSON.parse(JSON.stringify(client.treeKey(nodes, id, key, (x) => open.has(x)))) // plain objects: the client runs in its own realm
  assert.deepEqual(k('c2', 'ArrowDown'), { focus: 'c2n1' })
  assert.deepEqual(k('c2n2', 'ArrowDown'), { focus: 'c1' }, 'down leaves a branch for the next row')
  assert.deepEqual(k('c1', 'ArrowDown'), null, 'the last row')
  assert.deepEqual(k('c1', 'ArrowUp'), { focus: 'c2n2' })
  assert.deepEqual(k('c2', 'ArrowRight'), { focus: 'c2n1' }, 'an open branch: into its first child')
  assert.deepEqual(k('c1', 'ArrowRight'), { open: 'c1' }, 'a closed one opens')
  assert.deepEqual(k('c2n1', 'ArrowRight'), { open: 'c2n1' }, 'a topic opens into its messages')
  assert.deepEqual(k('c2', 'ArrowLeft'), { close: 'c2' })
  assert.deepEqual(k('c2n1', 'ArrowLeft'), { focus: 'c2' }, 'a closed one: out to its parent')
  assert.deepEqual(k('w', 'ArrowLeft'), { close: 'w' })
  assert.deepEqual([k('c2n2', 'Home'), k('w', 'End')], [{ focus: 'w' }, { focus: 'c1' }])
  assert.deepEqual([k('c1', 'Enter'), k('c1', ' ')], [{ activate: 'c1' }, { activate: 'c1' }])
  assert.equal(k('c1', 'a'), null)
  const read = client.layoutTree(client.treeItems(data, t, { c2n1: { sources: [] } }), open).nodes
  assert.equal(client.treeKey(read, 'c2n1', 'ArrowRight', (x) => open.has(x)), null, 'a topic with no messages has nothing to open')
  const loading = new Set([...open, 'c2n1']) // opened, its messages not here yet
  const waiting = client.layoutTree(client.treeItems(data, t, { c2n1: { loading: true } }), loading).nodes
  assert.equal(client.treeKey(waiting, 'c2n1', 'ArrowRight', (x) => loading.has(x)), null, 'not into the next topic while its own messages load')
})

test('the tree is a WAI-ARIA tree with one tab stop; keys move focus, open and close (#88)', () => {
  const log = []
  const opened = []
  const tree = mountTree({ key: 'a', title: 'W', chats: [branch(2, ['fact', 'fact']), branch(1, ['fact'])] }, (id) => opened.push(id), { selected: { topic: 'c2n2' } })
  const svg = find(tree.draw(), (e) => e.type === 'svg')
  assert.equal(svg.props.role, 'tree')
  const c2n2 = tree.node('c2n2').props
  assert.deepEqual([c2n2.role, c2n2['aria-level'], c2n2['aria-posinset'], c2n2['aria-setsize'], c2n2['aria-selected']], ['treeitem', 3, 2, 2, 'true'])
  assert.equal(tree.node('c2').props['aria-expanded'], 'true')
  assert.equal(tree.node('c2n1').props['aria-expanded'], 'false', 'a topic not read yet can open')
  assert.deepEqual(tree.nodes().filter((g) => g.props.tabIndex === 0).map((g) => g.key), ['w'], 'one tab stop, the workspace at first')
  // Every node's element, as React would hand it over.
  for (const g of tree.nodes()) g.props.ref(Object.assign(fakeEl(log), { id: g.key }))
  const press = (id, key) => tree.node(id).props.onKeyDown({ key, preventDefault() {} })
  press('w', 'ArrowDown')
  assert.deepEqual(log.filter(([what]) => what === 'focus'), [['focus', 'c2']])
  assert.deepEqual(tree.nodes().filter((g) => g.props.tabIndex === 0).map((g) => g.key), ['c2'], 'the tab stop follows')
  press('c1', 'ArrowLeft')
  assert.ok(!tree.ids().includes('c1n1'), 'Left closed c1')
  assert.equal(tree.node('c1').props['aria-expanded'], 'false')
  press('c1', 'ArrowRight')
  assert.ok(tree.ids().includes('c1n1'), 'Right opened it')
  press('c2n1', 'ArrowRight')
  assert.deepEqual(opened, ['c2n1'], 'Right on a topic reads it')
  const stops = () => tree.nodes().filter((g) => g.props.tabIndex === 0).map((g) => g.key)
  press('c2', 'ArrowLeft') // closes c2
  tree.node('c2').props.onClick() // opens it again; the click makes it the tab stop
  assert.deepEqual(stops(), ['c2'])
  tree.node('c2n2').props.onFocus({ currentTarget: { matches: () => false } }) // the stop moves into the branch
  assert.deepEqual(stops(), ['c2n2'])
  tree.node('c2').props.onClick() // closes it, from c2 itself
  assert.deepEqual(stops(), ['c2'])
  // A stop that disappears (its chat was opened by a search, now cleared) goes back to the workspace.
  const more = {}
  const searched = mountTree({ key: 'a', title: 'W', chats: [branch(2, many2(40)), branch(1, ['fact'])] }, () => {}, more)
  more.query = 'topic 1.1'
  searched.node('c1n1').props.onFocus({ currentTarget: { matches: () => false } })
  more.query = ''
  assert.deepEqual(searched.nodes().filter((g) => g.props.tabIndex === 0).map((g) => g.key), ['w'], 'Tab still reaches the tree')
  press('c1', 'Enter')
  assert.ok(!tree.ids().includes('c1n1'), 'Enter does what a click does: c1 closed')
})

test('pointing at a node or focusing it by keyboard shows its family; a click\'s focus does not (#88)', () => {
  const data = { key: 'a', title: 'W', chats: [branch(2, ['fact', 'fact', 'fact'], { links: [['n1', 'n3']] }), branch(1, ['fact'])] }
  const tree = mountTree(data)
  const family = () => Object.fromEntries(tree.nodes().map((g) => [g.key, g.props['data-family']]))
  assert.ok(Object.values(family()).every((v) => v === undefined), 'nothing faded at rest')
  tree.node('c2n1').props.onPointerEnter()
  assert.deepEqual(family(), { w: 'true', c2: 'true', c2n1: 'true', c2n2: 'false', c2n3: 'true', c1: 'false', c1n1: 'false' }, 'ancestors and the linked topic')
  const link = (id) => find(tree.draw(), (e) => e.type === 'path' && e.key === `l${id}`).props['data-family']
  assert.deepEqual([link('c2n1'), link('c2n2'), link('c1')], ['true', 'false', 'false'])
  tree.node('c2n1').props.onPointerLeave()
  assert.ok(Object.values(family()).every((v) => v === undefined))
  tree.node('c2').props.onFocus({ currentTarget: { matches: (sel) => sel === ':focus-visible' } })
  assert.deepEqual(family(), { w: 'true', c2: 'true', c2n1: 'true', c2n2: 'true', c2n3: 'true', c1: 'false', c1n1: 'false' }, 'a chat and all it holds')
  tree.node('c2').props.onBlur()
  tree.node('c1').props.onFocus({ currentTarget: { matches: () => false } }) // focus from a click
  assert.ok(Object.values(family()).every((v) => v === undefined))
})

test('a node or link drawn for the first time grows out of its parent, once, and not at all with reduced motion (#88)', () => {
  const data = { key: 'a', title: 'W', chats: [branch(1, ['fact'])] }
  const log = []
  const tree = mountTree(data)
  const el = fakeEl(log)
  tree.node('c1n1').props.ref(el)
  tree.node('c1n1').props.ref(el) // React hands the same element over again at the next render
  const animations = log.filter(([what]) => what === 'animate')
  assert.equal(animations.length, 1)
  const [, frames, options] = animations[0]
  assert.match(frames[0].transform, /scale\(0\.6\)$/, 'from its parent, small')
  assert.equal(frames[1].transform, tree.node('c1n1').props.style.transform, 'to its place')
  assert.deepEqual({ ...options }, { duration: 300, easing: 'cubic-bezier(0.05, 0.7, 0.1, 1)' }, 'Material 3 emphasized decelerate')
  const path = find(tree.draw(), (e) => e.type === 'path' && e.key === 'lc1n1')
  const pathLog = []
  path.props.ref(fakeEl(pathLog))
  assert.match(pathLog[0][1][0].d, /^path\('M/, 'a link grows from its parent end')
  assert.equal(path.props.style.d, `path('${path.props.d}')`, 'd is a style too, so a moving link is eased')
  // Reduced motion: shown at once.
  const still = []
  const react = fakeReact()
  const quiet = loadClient({ react, globals: { matchMedia: (q) => ({ matches: q === '(prefers-reduced-motion: reduce)' }) } })
  const g = [...walk(react.render(quiet.MemoryTree, { data, t, onOpen() {} }))].find((e) => e.key === 'c1n1')
  g.props.ref(fakeEl(still))
  assert.deepEqual(still, [])
  // A browser that cannot animate the property shows it at once instead of failing.
  assert.doesNotThrow(() => tree.node('c1').props.ref({ dataset: {}, animate() { throw new TypeError('d') }, focus() {} }))
})

test('the motion is eased by Material 3 timings in the CSS and stops with reduced motion (#88)', () => {
  let css = ''
  const document = { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild: (tag) => { css = tag.textContent } } }
  loadClient({ globals: { document } })
  assert.match(css, /\.dshcg-node\{transition:transform 300ms cubic-bezier\(0\.2,0,0,1\)/)
  assert.match(css, /\.dshcg-link\{transition:d 300ms cubic-bezier\(0\.2,0,0,1\)/)
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.dshcg-node,\.dshcg-link\{transition:none\}\}/)
})

test('closing a chat the search opened does not leave it open once the search is cleared (#88)', () => {
  const more = {}
  const tree = mountTree({ key: 'a', title: 'W', chats: [branch(2, many2(40)), branch(1, ['fact', 'decision'])] }, () => {}, more)
  more.query = 'topic 1.1'
  tree.node('c1').props.onClick()
  more.query = ''
  assert.ok(!tree.ids().includes('c1n1'))
})

test('a topic chosen while its chat is closed opens that chat once, and the chat can still be closed (review, #89)', () => {
  const more = {}
  const tree = mountTree({ key: 'a', title: 'W', chats: [branch(2, many2(40)), branch(1, ['fact', 'decision'])] }, () => {}, more)
  assert.ok(!tree.ids().includes('c1n2'), 'c1 starts closed')
  more.selected = { topic: 'c1n2' } // a linked topic opened from the panel
  tree.settle()
  assert.equal(tree.node('c1n2')?.props['data-selected'], 'true', 'drawn and marked')
  tree.node('c1').props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} })
  assert.ok(!tree.ids().includes('c1n2'), 'Left closes it, the topic still chosen')
})

test('a tree showing more than 400 rows draws what enters at once; a small one keeps the motion (review, #90)', () => {
  const more = { query: 'topic' } // opens all five chats: 506 rows
  const tree = mountTree({ key: 'a', title: 'W', chats: [1, 2, 3, 4, 5].map((cid) => branch(cid, many2(100))) }, () => {}, more)
  assert.ok(tree.ids().length > 400)
  const log = []
  tree.node('c3n50').props.ref(fakeEl(log))
  find(tree.draw(), (e) => e.type === 'path' && e.key === 'lc3n50').props.ref(fakeEl(log))
  assert.deepEqual(log, [], 'no animation')
  more.query = '' // the newest chat alone: 106 rows
  tree.node('c1n2').props.ref(fakeEl(log))
  assert.equal(log.filter(([what]) => what === 'animate').length, 1)
})

// ---- v0.12.0: hide, use again, delete memory (#91) ------------------------------------------------

test('hidden chats hang from a closed Hidden branch, greyed; archived and deleted chats are marked (#91)', () => {
  const data = { key: 'a', title: 'W', chats: [branch(3, ['fact']), branch(2, ['fact'], { hidden: true }), branch(1, ['fact'], { gone: true })] }
  const tree = mountTree(data)
  assert.deepEqual(tree.ids(), ['w', 'c3', 'c3n1', 'c1', 'c1n1', 'hidden'], 'the Hidden branch is last and closed')
  assert.match(find(tree.node('hidden'), (e) => e.props?.className === 'dshcg-label').props.children, /^t:hiddenGroup \(1\)$/)
  assert.match(find(tree.node('c1'), (e) => e.type === 'title').props.children, /^c1 · t:deleted/)
  tree.node('hidden').props.onClick()
  assert.equal(tree.node('c2').props['data-hidden'], 'true')
  const client = loadClient()
  assert.deepEqual([...client.initialOpen(data)], ['w', 'c3', 'c1'], 'a hidden chat never starts open')
  assert.match(client.chatLabel({ cid: 4, archived: true, shared: true, memory: true, shown: 1, total: 1, summary: '' }, t), /^c4 · t:archived$/)
})

test('a chat\'s panel hides it or uses it again; Delete memory shows only for an archived or deleted chat and asks first (#91)', async () => {
  const calls = []
  const panel = (chat) => {
    const react = fakeReact()
    const client = loadClient({ react })
    const props = { chat: { cid: 4, total: 9, shared: true, memory: true, savings: null, ...chat }, t, onClose() {}, onHide: async (cid, on) => calls.push(['hide', cid, on]), onForget: async (cid) => calls.push(['forget', cid]) }
    return () => react.render(client.ChatPanel, props)
  }
  const button = (tree, label) => find(tree, (e) => e.type === 'button' && e.props.children === label)
  const live = panel({})
  button(live(), 't:hide').props.onClick()
  assert.equal(button(live(), 't:deleteMemory'), undefined, 'a chat dsh still has can only be hidden')
  const hidden = panel({ hidden: true })
  button(hidden(), 't:useAgain').props.onClick()
  assert.ok(find(hidden(), (e) => e.props?.children === 't:hiddenHint'))
  const gone = panel({ gone: true })
  button(gone(), 't:deleteMemory').props.onClick()
  assert.deepEqual(calls, [['hide', 4, true], ['hide', 4, false]], 'nothing deleted on the first click')
  const dialog = find(gone(), (e) => e.props?.role === 'alertdialog')
  assert.ok(dialog, 'it asks first')
  assert.match(JSON.stringify(dialog), /9 t:topics · t:deleteBody/)
  find(dialog, (e) => e.type === 'button' && e.props.children === 't:cancel').props.onClick()
  assert.equal(find(gone(), (e) => e.props?.role === 'alertdialog'), undefined)
  button(gone(), 't:deleteMemory').props.onClick()
  find(find(gone(), (e) => e.props?.role === 'alertdialog'), (e) => e.type === 'button' && e.props.children === 't:deleteMemory').props.onClick()
  await settle()
  assert.deepEqual(calls.at(-1), ['forget', 4])
  assert.ok(button(panel({ archived: true })(), 't:deleteMemory'), 'an archived chat too')
})

test('the host\'s reason shows when a change fails, and changes are POSTs with the page\'s header (#91)', async () => {
  const sent = []
  const react = fakeReact()
  const client = loadClient({ react, fetch: async (url, init) => { sent.push([url, init]); return { ok: false, status: 409, json: async () => ({ error: 'this chat still exists' }) } } })
  const effects = []
  const page = fakeReact({ effects })
  const own = loadClient({ react: page, fetch: async (url, init) => { sent.push([url, init?.method ?? 'GET', init?.headers?.['x-context-graph']]); return { ok: true, json: async () => (url.includes('overview') ? { workspaces: [{ key: 'a', title: 'A', indexed: 1, topics: 1 }] } : url.includes('tree') ? { key: 'a', title: 'A', chats: [{ cid: 4, summary: '', shared: true, memory: true, total: 1, topics: [['n1', 'x', 'fact']], links: [], gone: true }] } : { forgotten: true }) } } })
  const draw = () => page.render(own.TreePage, { t })
  draw()
  for (const run of effects.splice(0)) run()
  await settle()
  await settle()
  find(draw(), (e) => e.type === own.MemoryTree).props.onChat(4)
  const chatPanel = find(draw(), (e) => e.type === own.ChatPanel)
  await chatPanel.props.onForget(4)
  assert.deepEqual(sent.filter(([, method]) => method === 'POST'), [['api/context-graph.forget?w=a&cid=4', 'POST', '1']])
  assert.equal(sent.at(-1)[0], 'api/context-graph.tree?w=a', 'the tree is read again')
  // A refusal shows the host's reason in the panel.
  const failing = () => react.render(client.ChatPanel, { chat: { cid: 4, total: 1, gone: true, shared: true, memory: true }, t, onClose() {}, onForget: () => Promise.reject(new Error('this chat still exists')) })
  find(failing(), (e) => e.type === 'button' && e.props.children === 't:deleteMemory').props.onClick()
  find(find(failing(), (e) => e.props?.role === 'alertdialog'), (e) => e.type === 'button' && e.props.children === 't:deleteMemory').props.onClick()
  await settle()
  assert.equal(find(failing(), (e) => e.props?.role === 'alert')?.props.children, 'this chat still exists')
})

// ---- v0.12.0: a chat's memory tag and Archive & forget (#92) ---------------------------------------

/** The client with dsh services the test controls, applied so serviceOf reaches them. */
function withServices(services, { fetch, react = fakeReact({ effects: [] }), primitives = {} } = {}) {
  let entry
  const window = { __ModuleLoader__: { load: (e) => { entry = e } } }
  vm.runInNewContext(read('src/client/client.js'), { window, document: undefined, fetch, URLSearchParams, Promise, Map, Set, Number, Math, String, setInterval: () => 0, clearInterval: () => {} })
  const element = (type, props, key) => ({ type, props, key })
  const shared = { react, 'react/jsx-runtime': { jsx: element, jsxs: element }, '@deepseek-ai/dsh-client-ui-primitives': { DisclosureRow: 'DisclosureRow', ...primitives } }
  const client = entry.factory((name) => shared[name])
  client.apply({ effect: (fn) => fn(), get: (name) => services[name], locale: { register() {} }, slots: { inject: (name, fn) => fn(), register: () => {} } })
  return client
}

test('the header chip shows the chat\'s number and opens Memory tree on that chat; nothing before the chat has memory (#92)', async () => {
  const effects = []
  const react = fakeReact({ effects })
  const selected = []
  let answer = { ok: true, json: async () => ({ w: 'k1', cid: 4, topics: 9, shared: true, memory: true, hidden: false }) }
  const client = withServices({ layout: { selectPanel: (id) => selected.push(id) } }, { react, fetch: async () => answer })
  const chip = () => react.render(client.MemoryChip, { sessionId: 'sA', t })
  assert.equal(chip(), null, 'nothing until the host answers')
  for (const run of effects.splice(0)) run()
  await settle()
  const shown = chip()
  assert.deepEqual(shown.props.children[1], 'c4')
  assert.equal(shown.props.title, 't:chipHint · 9 t:topics · t:shared')
  shown.props.onClick()
  assert.deepEqual(selected, ['dsh-context-graph'])
  assert.deepEqual({ ...client.jump.want }, { w: 'k1', cid: 4 }, 'the page takes it from here')
  answer = { ok: false, status: 404, json: async () => ({}) }
  const other = fakeReact({ effects })
  const none = withServices({}, { react: other, fetch: async () => answer })
  other.render(none.MemoryChip, { sessionId: 'sNew', t })
  for (const run of effects.splice(0)) run()
  await settle()
  assert.equal(other.render(none.MemoryChip, { sessionId: 'sNew', t }), null, 'a chat with no memory yet has no chip')
})

test('the tree page opens the workspace and chat the chip asked for (#92)', async () => {
  const effects = []
  const react = fakeReact({ effects })
  const client = withServices({}, { react, fetch: async (url) => ({ ok: true, json: async () => (url.includes('overview') ? { workspaces: [{ key: 'k0', title: 'A', indexed: 1, topics: 1 }, { key: 'k1', title: 'B', indexed: 1, topics: 1 }] } : { key: url.includes('k1') ? 'k1' : 'k0', title: 'B', chats: [branch(4, ['fact'])] }) }) })
  client.jump.want = { w: 'k1', cid: 4 }
  const page = () => react.render(client.TreePage, { t })
  page()
  for (const run of effects.splice(0)) run()
  await settle()
  await settle()
  page()
  // Only the effect that takes the jump: the fake runs every effect on every render, and the
  // overview's load (a mount-only effect in React) would start over.
  effects.splice(0).at(-1)()
  assert.equal(find(page(), (e) => e.type === client.ChatPanel)?.props.chat.cid, 4, 'chat c4 of workspace B is chosen')
  assert.equal(client.jump.want, null, 'taken once')
})

test('Archive & forget: a menu row for a chat with memory, a confirmation, then dsh archives and the host forgets (#92)', async () => {
  const effects = []
  const react = fakeReact({ effects })
  const calls = []
  const uiWorkspace = { archiveSession: async (sid) => calls.push(['archive', sid]) }
  const client = withServices({ uiWorkspace }, {
    react,
    primitives: { MenuItemButton: 'MenuItemButton', IconArchiveOutlineRegular: 'IconArchive' },
    fetch: async (url, init) => {
      if (init?.method === 'POST') calls.push(['post', url, init.headers['x-context-graph']])
      return { ok: true, json: async () => (url.includes('chat?') ? { w: 'k1', cid: 4, topics: 9, shared: true, memory: true, hidden: false } : { forgotten: true }) }
    }
  })
  const menu = []
  const row = () => react.render(client.ForgetMenuItem, { sessionId: 'sA', displayTitle: 'NZQA research', useMenuOpenState: () => [true, (open) => menu.push(open)], t })
  assert.equal(row(), null, 'not before the chat is known to have memory')
  for (const run of effects.splice(0)) run()
  await settle()
  const item = row()
  assert.deepEqual([item.type, item.props.danger, item.props.children], ['MenuItemButton', true, 't:archiveForget'])
  item.props.onSelect()
  assert.deepEqual(menu, [false], 'the menu closes')
  assert.deepEqual(calls, [], 'nothing happens before the confirmation')
  const dialog = fakeReact({ effects })
  const draw = () => dialog.render(client.ForgetDialog, { t })
  const shown = draw()
  assert.equal(shown.props.role, 'dialog', 'no Modal in this shell: the plain dialog')
  assert.match(JSON.stringify(shown), /t:forgetTitle/)
  assert.match(JSON.stringify(shown), /t:forgetBody/)
  find(shown, (e) => e.type === 'button' && e.props.children === 't:archiveForget').props.onClick()
  await settle()
  assert.deepEqual(calls, [['archive', 'sA'], ['post', 'api/context-graph.forget?sid=sA', '1']], 'dsh archives first, then the memory goes')
  assert.equal(draw(), null, 'closed')
})

test('Archive & forget keeps the memory when dsh does not archive, and says why (#92)', async () => {
  const effects = []
  const react = fakeReact({ effects })
  const posts = []
  const client = withServices({ uiWorkspace: { archiveSession: async () => { throw new Error('the chat is running') } } }, { react, fetch: async (url, init) => { if (init?.method === 'POST') posts.push(url); return { ok: true, json: async () => ({}) } } })
  client.askForget({ sessionId: 'sA', title: 'x', cid: 4, topics: 1 })
  const draw = () => react.render(client.ForgetDialog, { t })
  find(draw(), (e) => e.type === 'button' && e.props.children === 't:archiveForget').props.onClick()
  await settle()
  assert.deepEqual(posts, [], 'no memory deleted')
  assert.equal(find(draw(), (e) => e.props?.role === 'alert').props.children, 't:archiveFailed the chat is running')
  find(draw(), (e) => e.type === 'button' && e.props.children === 't:cancel').props.onClick()
  assert.equal(draw(), null)
})

// ---- v0.13.0: whole source messages and whole turns (#93) -----------------------------------------

test('a long source is folded until Show all, and Whole turn reads its turn (#93)', async () => {
  const react = fakeReact()
  const client = loadClient({ react })
  const asked = []
  let answer = Promise.resolve({ cid: 3, turn: 7, messages: [{ role: 'user', text: 'the question' }, { role: 'assistant', text: 'the whole answer' }] })
  const source = { role: 'assistant', turn: 7, text: 'a'.repeat(4000) }
  const draw = () => react.render(client.SourceBlock, { source, t, onTurn: (n) => { asked.push(n); return answer } })
  const pre = () => find(draw(), (e) => e.type === 'pre').props.children
  assert.equal(pre().length, 'assistant (t7):\n'.length + 1500 + 1, 'folded at 1,500 characters')
  find(draw(), (e) => e.type === 'button' && e.props.children === 't:showAll').props.onClick()
  assert.ok(pre().endsWith('a'.repeat(4000)), 'all of it')
  find(draw(), (e) => e.type === 'button' && e.props.children === 't:showLess').props.onClick()
  find(draw(), (e) => e.type === 'button' && e.props.children === 't:wholeTurn').props.onClick()
  await settle()
  assert.deepEqual(asked, [7])
  const turn = find(draw(), (e) => e.props?.className === 'dshcg-turn')
  assert.deepEqual(turn.props.children.map((p) => p.props.children), ['user:\nthe question', 'assistant:\nthe whole answer'])
  assert.equal(find(draw(), (e) => e.type === 'button' && e.props.children === 't:wholeTurn'), undefined, 'read once')
  // A turn that cannot be read says so.
  answer = Promise.reject(new Error('404'))
  const other = fakeReact()
  const second = loadClient({ react: other })
  const failing = () => other.render(second.SourceBlock, { source: { role: 'user', turn: 2, text: 'short' }, t, onTurn: () => answer })
  assert.equal(find(failing(), (e) => e.type === 'button' && e.props.children === 't:showAll'), undefined, 'a short one is not folded')
  find(failing(), (e) => e.type === 'button' && e.props.children === 't:wholeTurn').props.onClick()
  await settle()
  assert.ok(find(failing(), (e) => e.props?.children === 't:turnFailed'))
})

test('the topic panel asks for a turn of the topic\'s own chat, and says when only cited messages were kept (#93)', () => {
  const client = loadClient()
  const asked = []
  const detail = { id: 'c3n2', label: 'x', gist: '', kind: 'fact', chat: { cid: 3, summary: '' }, links: [], sources: [{ role: 'user', turn: 4, text: 'q' }], complete: false }
  const panel = client.TopicPanel({ detail, t, onOpen() {}, onClose() {}, onTurn: (cid, n) => { asked.push([cid, n]); return new Promise(() => {}) } })
  find(panel, (e) => e.type === client.SourceBlock).props.onTurn(4)
  assert.deepEqual(asked, [[3, 4]])
  assert.ok(find(panel, (e) => e.props?.children === 't:notWhole'))
  assert.equal(find(client.TopicPanel({ detail: { ...detail, complete: true }, t, onOpen() {}, onClose() {} }), (e) => e.props?.children === 't:notWhole'), undefined)
})

// ---- v0.14.0: labels (#94) ----------------------------------------------------------------------

test('a chat\'s panel shows its type, project and parts (#94)', () => {
  const client = loadClient()
  const text = JSON.stringify(client.ChatPanel({ chat: { cid: 4, total: 9, shared: true, memory: true, savings: null, type: 'debugging', project: 'dsh-context-graph', parts: [{ turns: [1, 3], type: 'coding', about: 'the tree page' }, { turns: [4, 6], type: 'debugging', about: '' }] }, t, onClose() {} }))
  assert.match(text, /t:type\.debugging/)
  assert.match(text, /dsh-context-graph/)
  assert.match(text, /t1–t3 · t:type\.coding: the tree page/)
  assert.match(text, /t4–t6 · t:type\.debugging"/)
  assert.match(JSON.stringify(client.ChatPanel({ chat: { cid: 5, total: 1, shared: true, memory: true }, t, onClose() {} })), /t:type\.none/, 'a chat indexed before labels says so')
})

// ---- v0.14.0: sort by label, remembered (#95) ----------------------------------------------------

test('sorted by label, chats hang from one open group per type, unlabelled last, hidden chats apart (#95)', () => {
  const data = { key: 'a', title: 'W', chats: [branch(4, ['fact'], { type: 'study' }), branch(3, ['fact'], { type: 'coding' }), branch(2, ['fact']), branch(1, ['fact'], { type: 'study', hidden: true })] }
  const tree = mountTree(data, () => {}, { by: 'label' })
  assert.deepEqual(tree.ids(), ['w', 'g:type:coding', 'c3', 'c3n1', 'g:type:study', 'c4', 'c4n1', 'g:type:none', 'c2', 'c2n1', 'hidden'])
  assert.equal(find(tree.node('g:type:study'), (e) => e.props?.className === 'dshcg-label').props.children, 't:type.study (1)')
  assert.equal(tree.node('g:type:study').props['data-group'], 'set')
  assert.equal(tree.node('hidden').props['data-group'], 'hidden')
  assert.deepEqual(mountTree(data).ids().slice(0, 4), ['w', 'c4', 'c4n1', 'c3'], 'not sorted: no groups')
})

test('sorted by label, a search or a choice opens the group and the chat it needs (#95)', () => {
  const chats = [branch(9, many2(40), { type: 'coding' }), branch(8, ['fact', 'decision'], { type: 'study' })]
  const more = { by: 'label' }
  const tree = mountTree({ key: 'a', title: 'W', chats }, () => {}, more)
  tree.node('g:type:study').props.onClick() // the user closes the group
  assert.ok(!tree.ids().includes('c8'))
  more.query = 'topic 8.2'
  assert.ok(tree.ids().includes('c8n2'), 'the group and the chat open for the match')
  more.query = ''
  more.selected = { topic: 'c8n1' }
  tree.settle()
  assert.ok(tree.ids().includes('c8n1'), 'a chosen topic opens its group too')
})

test('the toolbar toggle sorts by label and back, and the page remembers it across a restart (#95)', async () => {
  const client = loadClient()
  const calls = []
  const bar = (by) => client.TreeTools({ t, query: '', kind: '', by, onQuery() {}, onKind() {}, onScale() {}, onGroup: (v) => calls.push(v) })
  const toggle = (tree) => find(tree, (e) => e.type === 'button' && e.props.children === 't:byLabel')
  assert.equal(toggle(bar(null)).props['aria-pressed'], 'false')
  toggle(bar(null)).props.onClick()
  toggle(bar('label')).props.onClick()
  assert.deepEqual(calls, ['label', null], 'a second click goes back')
  assert.equal(bar(null).props.children.at(-2).props.className, 'dshcg-spacer', 'at the right end of the toolbar')
  // The page keeps the choice in local storage: a new page (after a restart) starts with it.
  const storage = new Map()
  const localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) }
  const open = async () => {
    const effects = []
    const react = fakeReact({ effects })
    const own = loadClient({ react, globals: { localStorage }, fetch: async (url) => ({ ok: true, json: async () => (url.includes('overview') ? { workspaces: [{ key: 'a', title: 'A', indexed: 1, topics: 1 }] } : { key: 'a', title: 'A', chats: [branch(1, ['fact'], { type: 'coding' })] }) }) })
    const page = () => react.render(own.TreePage, { t })
    page()
    for (const run of effects.splice(0)) run()
    await settle()
    await settle()
    return { own, page }
  }
  const first = await open()
  find(first.page(), (e) => e.type === first.own.TreeTools).props.onGroup('label')
  assert.equal(storage.get('dsh-context-graph:tree-group'), 'label')
  assert.equal(find(first.page(), (e) => e.type === first.own.MemoryTree).props.by, 'label')
  const again = await open()
  assert.equal(find(again.page(), (e) => e.type === again.own.MemoryTree).props.by, 'label', 'remembered')
  find(again.page(), (e) => e.type === again.own.TreeTools).props.onGroup(null)
  assert.equal(storage.has('dsh-context-graph:tree-group'), false)
  // Storage that refuses (a private window) costs nothing but the memory of the choice.
  const refusing = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() {} }
  const effects = []
  const react = fakeReact({ effects })
  const own = loadClient({ react, globals: { localStorage: refusing }, fetch: async () => new Promise(() => {}) })
  assert.doesNotThrow(() => react.render(own.TreePage, { t }))
})

// ---- v0.15.0: the subject layer (#96) -----------------------------------------------------------

test('chats hang from their subjects by default, in the order of each subject\'s newest chat, unsorted last; Sort by label switches (#96)', () => {
  const chats = [
    branch(5, ['fact'], { subject: 'Earth and Space Science', type: 'study' }),
    branch(4, ['fact'], { subject: 'Laptop care', type: 'setup' }),
    branch(3, ['fact']),
    branch(2, ['fact'], { subject: 'earth and  space science', type: 'research' })
  ]
  const tree = mountTree({ key: 'a', title: 'W', chats })
  assert.deepEqual(tree.ids(), ['w', 'g:subject:earth and space science', 'c5', 'c5n1', 'c2', 'c2n1', 'g:subject:laptop care', 'c4', 'c4n1', 'g:subject:', 'c3', 'c3n1'])
  assert.equal(find(tree.node('g:subject:'), (e) => e.props?.className === 'dshcg-label').props.children, 't:unsorted (1)')
  assert.equal(find(tree.node('g:subject:earth and space science'), (e) => e.props?.className === 'dshcg-label').props.children, 'Earth and Space Science (2)', 'the newest chat\'s spelling')
  assert.deepEqual(mountTree({ key: 'a', title: 'W', chats }, () => {}, { by: 'label' }).ids().filter((id) => id.startsWith('g:')), ['g:type:research', 'g:type:study', 'g:type:setup', 'g:type:none'])
  assert.deepEqual(mountTree({ key: 'a', title: 'W', chats: [branch(1, ['fact'])] }).ids(), ['w', 'c1', 'c1n1'], 'no group while no chat has a subject')
  const client = loadClient()
  assert.match(JSON.stringify(client.ChatPanel({ chat: { cid: 5, total: 1, shared: true, memory: true, subject: 'Earth and Space Science', type: 'study' }, t, onClose() {} })), /Earth and Space Science/)
})

test('a chip asking for a chat the tree does not draw opens the tree with nothing chosen, and a chosen chat that is gone shows no panel (#99)', async () => {
  const effects = []
  const react = fakeReact({ effects })
  const client = withServices({}, { react, fetch: async (url) => ({ ok: true, json: async () => (url.includes('overview') ? { workspaces: [{ key: 'k1', title: 'A', indexed: 1, topics: 1 }] } : { key: 'k1', title: 'A', chats: [branch(4, ['fact'])] }) }) })
  client.jump.want = { w: 'k1', cid: 7 } // c7 has a number but no topics: not in the tree
  const page = () => react.render(client.TreePage, { t })
  page()
  for (const run of effects.splice(0)) run()
  await settle()
  await settle()
  page()
  effects.splice(0).at(-1)()
  assert.doesNotThrow(() => page())
  assert.equal(find(page(), (e) => e.type === client.ChatPanel), undefined)
  assert.equal(find(page(), (e) => e.type === client.MemoryTree).props.selected, null, 'the tree is drawn, nothing chosen: no stale choice opens later')
  assert.equal(client.jump.want, null)
  // A chat chosen, then gone from the tree (its memory deleted elsewhere): no panel, no failure.
  find(page(), (e) => e.type === client.MemoryTree).props.onChat(9)
  assert.equal(find(page(), (e) => e.type === client.ChatPanel), undefined)
})
