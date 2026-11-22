// The browser side of dsh-context-graph, hand-written in dsh's client-bundle format (no build step).
// The shell loads this file as a plain script; `require` reaches only the shell's shared modules.
// Three contributions:
//   - the chat card for `/context-graph`: dsh's own DisclosureRow, a one-line summary that opens
//     to the details;
//   - the plugin's page in Plugins (`plugins.bundle.config`, #35): what memory saved and cost in
//     each workspace;
//   - Memory tree, an entry of its own in the sidebar's panel list with a page in the main column
//     (#85): what the memory holds. Data comes from the host's owner-only routes (src/host/page.js).
window.__ModuleLoader__.load({
  id: 'dsh-context-graph',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { useState } = React
    const { jsx, jsxs } = require('react/jsx-runtime')
    const { DisclosureRow } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NAMESPACE = 'dsh-context-graph'
    const en = {
      stats: 'Context graph',
      on: 'Memory on',
      off: 'Memory off',
      share: 'Share with workspace',
      unshare: 'Stop sharing',
      build: 'Index this chat',
      map: 'Memory map',
      find: 'Find topics',
      running: 'Working…',
      failed: 'Failed',
      pageIntro: 'What memory saved and cost in each workspace. Numbers marked as estimates follow the rule shown under them.',
      treeHint: 'What the memory holds is drawn as a tree: Memory tree in the left sidebar.',
      panel: 'Memory tree',
      treeIntro: 'Each workspace\'s memory: its chats, their topics, and the messages each topic came from.',
      loading: 'Loading…',
      loadFailed: 'Could not read the memory. Try again in a moment.',
      retry: 'Retry',
      noWorkspaces: 'No memory yet. Chats index themselves every 4 turns; /context-graph build indexes one now.',
      chats: 'chats',
      topics: 'topics',
      saved: 'Saved (estimate)',
      cost: 'Memory cost',
      net: 'Net',
      savingsRule: 'Saved: for each topic the model used (it recalled it, or its answer says two of the topic\'s words your message did not), its newest messages as stored, each counted once per chat. Cost: notes and recalls sent, their cached re-sends (x0.1), the recall tool, and indexing (output x4). In input tokens.',
      topicFailed: 'Could not read this topic.',
      savingsUnavailable: 'Savings: unavailable for now (the ledger could not be read).',
      search: 'Search topics',
      allKinds: 'All',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      resetView: 'Reset view',
      map_label: 'Map of the memory: chats as circles, topics inside them',
      close: 'Close',
      copyId: 'Copy id',
      copied: 'Copied',
      fromChat: 'From chat',
      links: 'Linked topics',
      sources: 'Source messages',
      private: 'private',
      memoryOff: 'memory off',
      more: 'more not drawn',
      decision: 'Decision',
      fact: 'Fact',
      task: 'Task',
      artifact: 'Artifact',
      'open-question': 'Open question'
    }
    const zh = {
      stats: '上下文图谱',
      on: '开启记忆',
      off: '关闭记忆',
      share: '共享到工作区',
      unshare: '取消共享',
      build: '索引当前对话',
      map: '记忆地图',
      find: '查找主题',
      running: '处理中…',
      failed: '失败',
      pageIntro: '每个工作区里记忆节省和花费了多少。标为估算的数字按下面写明的规则计算。',
      treeHint: '记忆里有什么画成了一棵树：左侧边栏的“记忆树”。',
      panel: '记忆树',
      treeIntro: '每个工作区的记忆：它的对话、对话里的主题，以及每个主题来自哪些消息。',
      loading: '正在读取…',
      loadFailed: '无法读取记忆，请稍后再试。',
      retry: '重试',
      noWorkspaces: '还没有记忆。对话每 4 轮会自动索引；/context-graph build 可以立即索引当前对话。',
      chats: '个对话',
      topics: '个主题',
      saved: '节省（估算）',
      cost: '记忆开销',
      net: '净值',
      savingsRule: '节省：模型用到的每个主题（被取回，或回答里出现了它的两个词而你的消息里没有）最新的几条消息，按保存的长度计，同一条消息在一个对话里只算一次。开销：发送的笔记和取回内容、它们作为缓存再次发送的部分（×0.1）、recall 工具、以及索引（输出 ×4）。单位为输入 token。',
      topicFailed: '无法读取这个主题。',
      savingsUnavailable: '节省：暂时无法读取（账本文件读不到）。',
      search: '搜索主题',
      allKinds: '全部',
      zoomIn: '放大',
      zoomOut: '缩小',
      resetView: '还原视图',
      map_label: '记忆地图：圆圈是对话，圆圈里的点是主题',
      close: '关闭',
      copyId: '复制编号',
      copied: '已复制',
      fromChat: '来自对话',
      links: '相关主题',
      sources: '来源消息',
      private: '私有',
      memoryOff: '记忆已关闭',
      more: '个未画出',
      decision: '决定',
      fact: '事实',
      task: '任务',
      artifact: '产物',
      'open-question': '待定问题'
    }
    const KINDS = ['decision', 'fact', 'task', 'artifact', 'open-question']
    const COLORS = { decision: '#4A65E8', fact: '#2BA471', task: '#E5973C', artifact: '#8E5BE8', 'open-question': '#E5484D' }

    const CSS = [
      '.dshcg-root{margin:2px 0}',
      '.dshcg-summary{margin-left:8px;font-size:13px;opacity:.72}',
      '.dshcg-summary[data-error]{color:var(--dsw-alias-state-error-primary,#d64545);opacity:1}',
      '.dshcg-body{padding:6px 0 6px 24px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}',
      '.dshcg-page{display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      // The Memory tree page, laid out like dsh's own first-level pages (Plugins, Automation tasks):
      // a 20px title row 28px from the top, a centred column with responsive side insets.
      '.dshcg-main{width:100%;height:100%;min-width:0;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dshcg-column{max-width:1280px;margin:0 auto;padding:28px clamp(24px,4vw,48px) 48px;box-sizing:border-box}',
      '[data-platform="darwin"] .dshcg-column{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}',
      '.dshcg-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}',
      '.dshcg-heading h1{margin:0;font-size:20px;line-height:28px;font-weight:500}',
      '.dshcg-muted{color:var(--dsw-alias-label-secondary)}',
      '.dshcg-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.dshcg-btn{border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:inherit;border-radius:var(--dsw-radius-md,8px);padding:4px 10px;cursor:pointer;font:inherit}',
      '.dshcg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshcg-btn[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary,#4A65E8)}',
      '.dshcg-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}',
      '.dshcg-card{border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,10px);padding:10px;background:var(--dsw-alias-bg-layer-2)}',
      '.dshcg-big{font-size:18px;font-weight:600}',
      '.dshcg-good{color:var(--dsw-alias-state-success-primary,#2BA471)}',
      '.dshcg-bad{color:var(--dsw-alias-state-error-primary,#E5484D)}',
      '.dshcg-mapbox{position:relative;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.dshcg-map{display:block;width:100%;height:460px;touch-action:none;cursor:grab}',
      '.dshcg-chat{fill:none;stroke:var(--dsw-alias-border-l2)}',
      '.dshcg-chat-label{font-size:11px;fill:var(--dsw-alias-label-secondary)}',
      '.dshcg-edge{stroke:var(--dsw-alias-border-l2);stroke-width:1}',
      '.dshcg-topic{cursor:pointer;stroke:var(--dsw-alias-bg-layer-1);stroke-width:1}',
      '.dshcg-topic[data-dim="true"]{opacity:.15}',
      '.dshcg-panel{border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,10px);padding:12px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:8px}',
      '.dshcg-pre{white-space:pre-wrap;word-break:break-word;font-family:var(--dsw-font-mono,monospace);font-size:12px;margin:0;padding:8px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1)}',
      '.dshcg-input{border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:inherit;border-radius:var(--dsw-radius-md,8px);padding:4px 8px;font:inherit;min-width:180px}',
      '.dshcg-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:4px}'
    ].join('')
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-context-graph"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = NAMESPACE
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // Three linked nodes: the same mark as the plugin icon, drawn in the current text colour.
    const ICON = jsxs('svg', {
      width: 14,
      height: 14,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      'aria-hidden': true,
      children: [
        jsx('path', { d: 'M7 7l10 3M7 7l3 10M17 10l-7 7' }),
        jsx('circle', { cx: 7, cy: 7, r: 2.5, fill: 'currentColor' }),
        jsx('circle', { cx: 17, cy: 10, r: 2, fill: 'currentColor' }),
        jsx('circle', { cx: 10, cy: 17, r: 2, fill: 'currentColor' })
      ]
    })

    /** The sidebar's Memory tree entry: a root and two branches, at the size and colour the row asks for. */
    function TreeIcon({ size }) {
      const edge = typeof size === 'number' ? size : 20
      return jsxs('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        'aria-hidden': true,
        children: [
          jsx('path', { d: 'M6 10C10 10 10 5 14 5M6 10C10 10 10 15 14 15' }),
          jsx('circle', { cx: 4, cy: 10, r: 2 }),
          jsx('circle', { cx: 16, cy: 5, r: 2 }),
          jsx('circle', { cx: 16, cy: 15, r: 2 })
        ]
      })
    }

    const SUBCOMMANDS = ['stats', 'on', 'off', 'share', 'unshare', 'build', 'map', 'find']

    /** Title key from the typed arguments (`/context-graph on` -> on); no argument means stats. */
    function subcommandOf(args) {
      const first = String(args ?? '').trim().split(/\s+/)[0] || 'stats'
      return SUBCOMMANDS.includes(first) ? first : 'stats'
    }

    /** Host text: line 1 is the summary, later lines are the details shown when expanded. */
    function splitText(text) {
      const lines = String(text ?? '').split('\n')
      return { summary: lines[0] ?? '', body: lines.slice(1).join('\n').trim() }
    }

    function ContextGraphCard({ node, t }) {
      const [open, setOpen] = useState(false)
      const outcome = node.outcome
      const running = outcome === null
      const failed = outcome?.kind === 'error'
      const { summary, body } = splitText(outcome?.text)
      const shown = running ? t('running') : summary || (failed ? t('failed') : '')
      const hasBody = !running && body.length > 0
      return jsx('div', {
        className: 'dshcg-root',
        'data-state': running ? 'running' : failed ? 'error' : 'ok',
        children: jsx(DisclosureRow, {
          icon: ICON,
          title: t(subcommandOf(node.args)),
          running,
          open: open && hasBody,
          expandable: hasBody,
          expandOnRowClick: true,
          keepContentWhenOpen: true,
          onToggle: () => setOpen((value) => !value),
          collapsedContent: shown ? jsx('span', { className: 'dshcg-summary', 'data-error': failed || undefined, children: shown }) : undefined,
          children: open && hasBody ? jsx('div', { className: 'dshcg-body', children: body }) : undefined
        })
      })
    }

    // ---- the plugin's page -------------------------------------------------------------------

    /** The host's owner-only routes, document-relative like dsh's own (session export). */
    async function getJson(name, query) {
      const response = await fetch(`api/context-graph.${name}${query ? `?${new URLSearchParams(query)}` : ''}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    const number = (n) => Number(n ?? 0).toLocaleString()
    const translator = (t) => (typeof t === 'function' ? (key) => { const s = t(key); return s && s !== key ? s : en[key] ?? key } : (key) => en[key] ?? key)

    // East Asian wide characters (CJK, kana, Hangul, full-width forms) and symbols such as \ud83d\udd12 \u23f8:
    // about two Latin letters wide.
    const WIDE = /[\u2300-\u23ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f000}-\u{1faff}]/u

    /** How many Latin letters wide `text` is: a wide character counts two. */
    const letters = (text) => [...text].reduce((sum, ch) => sum + (WIDE.test(ch) ? 2 : 1), 0)

    /** `text` cut to about `room` Latin letters, ending in … if cut. */
    function fit(text, room) {
      const chars = [...text]
      let used = letters(text)
      if (used <= room) return text
      let end = chars.length
      while (end > 0 && used + 2 > room) used -= letters(chars[--end]) // 2: the ellipsis
      return `${chars.slice(0, end).join('')}…`
    }

    /**
     * A chat's number, marks and hidden-topic count, whole (a cut 'memory off' reads as on), then as much
     * of its summary as `room` letters leave. A slot too small for the marks in words gets them as
     * symbols, 🔒 private and ⏸ memory off; hover shows the full label (review).
     */
    function chatLabel(c, t, room = Infinity) {
      let head = [`c${c.cid}`, c.shared ? '' : t('private'), c.memory ? '' : t('memoryOff'), c.total > c.shown ? `+${c.total - c.shown} ${t('more')}` : ''].filter(Boolean).join(' · ')
      if (letters(head) > room) head = [`c${c.cid}`, `${c.shared ? '' : '🔒'}${c.memory ? '' : '⏸'}`, c.total > c.shown ? `+${c.total - c.shown}` : ''].filter(Boolean).join(' · ')
      const rest = room - letters(head) - 3 // 3: the ' · ' before the summary
      return c.summary && rest >= 6 ? `${head} · ${fit(c.summary, rest)}` : head // 6: four letters and the …
    }

    function Savings({ s, t }) {
      // null: the ledger cannot be read right now (a sync tool holding it), not zero.
      if (s === null) return jsx('div', { className: 'dshcg-muted', children: t('savingsUnavailable') })
      const net = s?.net ?? 0
      return jsxs('div', {
        className: 'dshcg-cards',
        children: [
          jsxs('div', { className: 'dshcg-card', children: [jsx('div', { className: 'dshcg-muted', children: t('saved') }), jsx('div', { className: 'dshcg-big', children: number(s?.saved) })] }),
          jsxs('div', { className: 'dshcg-card', children: [jsx('div', { className: 'dshcg-muted', children: t('cost') }), jsx('div', { className: 'dshcg-big', children: number(s?.cost) })] }),
          jsxs('div', { className: 'dshcg-card', children: [jsx('div', { className: 'dshcg-muted', children: t('net') }), jsx('div', { className: `dshcg-big ${net >= 0 ? 'dshcg-good' : 'dshcg-bad'}`, children: `${net >= 0 ? '+' : '−'}${number(Math.abs(net))}` })] })
        ]
      })
    }

    /** One topic, opened from the map: its gist, chat, links, sources and the id to paste. */
    function TopicPanel({ detail, t, onOpen, onClose }) {
      const [copied, setCopied] = useState(false)
      const copy = () => {
        // No clipboard on plain-http remote access: nothing is copied, so nothing says Copied.
        globalThis.navigator?.clipboard?.writeText?.(detail.id).then(() => setCopied(true), () => {})
      }
      return jsxs('div', {
        className: 'dshcg-panel',
        role: 'region',
        'aria-label': detail.label,
        children: [
          jsxs('div', {
            className: 'dshcg-row',
            children: [
              jsx('span', { className: 'dshcg-dot', style: { background: COLORS[detail.kind] ?? '#888' } }),
              jsx('strong', { children: detail.label }),
              jsx('span', { className: 'dshcg-muted', children: `${detail.id} · ${t(detail.kind)}` }),
              jsx('button', { type: 'button', className: 'dshcg-btn', onClick: copy, children: copied ? t('copied') : t('copyId') }),
              jsx('button', { type: 'button', className: 'dshcg-btn', onClick: onClose, children: t('close') })
            ]
          }),
          jsx('div', { children: detail.gist }),
          jsx('div', { className: 'dshcg-muted', children: `${t('fromChat')} c${detail.chat.cid}: ${detail.chat.summary}` }),
          // One topic can be linked twice (n1 uses n2, n2 part-of n1), so the key is the whole link.
          detail.links.length > 0
            ? jsxs('div', { children: [jsx('div', { className: 'dshcg-muted', children: t('links') }), jsx('div', { className: 'dshcg-row', children: detail.links.map((l) => jsx('button', { type: 'button', className: 'dshcg-btn', onClick: () => onOpen(l.id), children: `${l.label} (${l.relation})` }, `${l.id} ${l.relation} ${l.direction}`)) })] })
            : null,
          detail.sources.length > 0
            ? jsxs('div', { children: [jsx('div', { className: 'dshcg-muted', children: t('sources') }), ...detail.sources.map((s, i) => jsx('pre', { className: 'dshcg-pre', children: `${s.role}${s.turn ? ` (t${s.turn})` : ''}:\n${s.text}` }, i))] })
            : null
        ]
      })
    }

    /** The map: drawn from the host's layout; drag to move, buttons to zoom, click a topic to open it. */
    function MemoryMap({ map, t, onOpen }) {
      const [query, setQuery] = useState('')
      const [kind, setKind] = useState('')
      const [view, setView] = useState({ x: 0, y: 0, scale: 1 })
      const [drag, setDrag] = useState(null)
      // The map box's height / width (460 px by the page's width), so the view has its proportions:
      // scale 1 is the layout's whole width, from its top row (the newest chats).
      const [aspect, setAspect] = useState(460 / 1000)
      const box = React.useRef(null)
      React.useEffect(() => {
        const observer = new ResizeObserver(([entry]) => {
          const { width: w, height: h } = entry.contentRect
          if (w > 0) setAspect(h / w) // 0 while the page is hidden
        })
        observer.observe(box.current)
        return () => observer.disconnect()
      }, [])
      const width = map.width / view.scale
      const height = width * aspect
      const q = query.trim().toLowerCase()
      const zoom = (factor) => setView((v) => ({ ...v, scale: Math.min(8, Math.max(0.5, v.scale * factor)) }))
      const pointer = {
        onPointerDown: (e) => setDrag({ x: e.clientX, y: e.clientY, view }),
        onPointerUp: () => setDrag(null),
        onPointerLeave: () => setDrag(null),
        onPointerMove: (e) => {
          if (!drag) return
          // Units per pixel: the box fits the view by its tighter side (either, once measured).
          const k = Math.max(width / (e.currentTarget.clientWidth || 1), height / (e.currentTarget.clientHeight || 1))
          setView({ ...drag.view, x: drag.view.x - (e.clientX - drag.x) * k, y: drag.view.y - (e.clientY - drag.y) * k })
        }
      }
      const at = new Map(map.topics.map((p) => [`${p[0]}${p[1]}`, p]))
      return jsxs('div', {
        className: 'dshcg-page',
        children: [
          jsxs('div', {
            className: 'dshcg-row',
            children: [
              jsx('input', { className: 'dshcg-input', type: 'search', placeholder: t('search'), 'aria-label': t('search'), value: query, onChange: (e) => setQuery(e.target.value) }),
              jsx('button', { type: 'button', className: 'dshcg-btn', 'aria-pressed': kind === '' ? 'true' : 'false', onClick: () => setKind(''), children: t('allKinds') }),
              ...KINDS.map((k) => jsxs('button', { type: 'button', className: 'dshcg-btn', 'aria-pressed': kind === k ? 'true' : 'false', onClick: () => setKind(kind === k ? '' : k), children: [jsx('span', { className: 'dshcg-dot', style: { background: COLORS[k] } }), t(k)] }, k)),
              jsx('button', { type: 'button', className: 'dshcg-btn', 'aria-label': t('zoomIn'), onClick: () => zoom(1.4), children: '+' }),
              jsx('button', { type: 'button', className: 'dshcg-btn', 'aria-label': t('zoomOut'), onClick: () => zoom(1 / 1.4), children: '−' }),
              jsx('button', { type: 'button', className: 'dshcg-btn', onClick: () => setView({ x: 0, y: 0, scale: 1 }), children: t('resetView') })
            ]
          }),
          jsx('div', {
            className: 'dshcg-mapbox',
            ref: box,
            children: jsxs('svg', {
              className: 'dshcg-map',
              role: 'img',
              'aria-label': t('map_label'),
              viewBox: `${view.x} ${view.y} ${width} ${height}`,
              ...pointer,
              children: [
                ...map.edges.map(([cid, from, to], i) => {
                  const a = at.get(`${cid}${from}`)
                  const b = at.get(`${cid}${to}`)
                  return a && b ? jsx('line', { className: 'dshcg-edge', x1: a[4], y1: a[5], x2: b[4], y2: b[5] }, `e${i}`) : null
                }),
                ...map.chats.map((c) => jsxs('g', {
                  children: [
                    jsx('title', { children: chatLabel(c, t) }),
                    jsx('circle', { className: 'dshcg-chat', cx: c.x, cy: c.y, r: c.r }),
                    // Cut to the chat's slot in its row (2r + 24 units, layout.js), about 6 units a letter at 11px.
                    jsx('text', { className: 'dshcg-chat-label', x: c.x - c.r, y: c.y - c.r - 4, children: chatLabel(c, t, (2 * c.r + 24) / 6) })
                  ]
                }, `c${c.cid}`)),
                ...map.topics.map(([cid, id, label, k, x, y, degree]) => {
                  const dim = (kind && k !== kind) || (q && !String(label).toLowerCase().includes(q))
                  return jsx('circle', {
                    className: 'dshcg-topic',
                    cx: x,
                    cy: y,
                    r: 4 + Math.min(5, degree),
                    fill: COLORS[k] ?? '#888',
                    'data-dim': dim ? 'true' : 'false',
                    tabIndex: 0,
                    onClick: () => onOpen(`c${cid}${id}`),
                    onKeyDown: (e) => { if (e.key === 'Enter') onOpen(`c${cid}${id}`) },
                    children: jsx('title', { children: `c${cid}${id} ${label}` })
                  }, `t${cid}${id}`)
                })
              ]
            })
          })
        ]
      })
    }

    /**
     * The workspaces with memory, and the one shown: both pages start from the overview. `onChoose`
     * runs when a workspace is chosen, the first one included.
     */
    function useWorkspaces(onChoose) {
      const [state, setState] = useState({ status: 'loading' })
      const [key, setKey] = useState(null)
      const choose = (next) => {
        setKey(next)
        onChoose?.(next)
      }
      const load = () => {
        setState({ status: 'loading' })
        getJson('overview').then((value) => {
          setState({ status: 'ready', workspaces: value.workspaces })
          const first = value.workspaces.find((w) => w.indexed > 0) ?? value.workspaces[0]
          if (first) choose(first.key)
        }, () => setState({ status: 'error' }))
      }
      React.useEffect(load, [])
      return { state, key, load, choose }
    }

    /** Loading, failed or empty overview: what a page shows instead of its body, or null once ready. */
    function overviewNotice(ws, t) {
      if (ws.state.status === 'loading') return jsx('div', { className: 'dshcg-muted', children: t('loading') })
      if (ws.state.status === 'error') {
        return jsxs('div', { className: 'dshcg-row', children: [jsx('div', { className: 'dshcg-bad', children: t('loadFailed') }), jsx('button', { type: 'button', className: 'dshcg-btn', onClick: ws.load, children: t('retry') })] })
      }
      if (ws.state.workspaces.length === 0) return jsx('div', { className: 'dshcg-muted', children: t('noWorkspaces') })
      return null
    }

    /** One button per workspace, shown only when there is more than one. */
    function workspaceButtons(ws, t) {
      if (ws.state.workspaces.length < 2) return null
      return jsx('div', { className: 'dshcg-row', children: ws.state.workspaces.map((w) => jsx('button', { type: 'button', className: 'dshcg-btn', 'aria-pressed': w.key === ws.key ? 'true' : 'false', onClick: () => ws.choose(w.key), children: `${w.title} · ${w.indexed} ${t('chats')} · ${w.topics} ${t('topics')}` }, w.key)) })
    }

    /** The plugin's page in Plugins: one workspace at a time and its savings; the tree has its own page (#85). */
    function SavingsPage(props) {
      const t = translator(props.t)
      const ws = useWorkspaces()
      const notice = overviewNotice(ws, t)
      if (notice) return jsx('div', { className: 'dshcg-page', children: notice })
      const current = ws.state.workspaces.find((w) => w.key === ws.key)
      return jsxs('div', {
        className: 'dshcg-page',
        children: [
          jsx('div', { className: 'dshcg-muted', children: t('pageIntro') }),
          workspaceButtons(ws, t),
          current ? jsx(Savings, { s: current.savings, t }) : null,
          jsx('div', { className: 'dshcg-muted', children: t('savingsRule') }),
          jsx('div', { children: t('treeHint') })
        ]
      })
    }

    /** Memory tree, the page the sidebar entry opens in the main column (#85). */
    function TreePage(props) {
      const t = translator(props.t)
      const [map, setMap] = useState(null)
      const [detail, setDetail] = useState(null)
      // Answers can come back out of order (a slow map, then a quick one): requests of each kind are
      // numbered, and only the latest one's answer is taken.
      const asked = React.useRef({ map: 0, topic: 0 })
      const ask = (kind) => {
        const n = ++asked.current[kind]
        return (take) => (value) => { if (asked.current[kind] === n) take(value) }
      }
      const show = (next) => {
        const latest = ask('map')
        ask('topic') // a topic still on its way was asked in the workspace being left
        setMap(null)
        setDetail(null)
        getJson('map', { w: next }).then(latest(setMap), latest(() => setMap({ error: true })))
      }
      const ws = useWorkspaces(show)
      const open = (id) => {
        const latest = ask('topic')
        // A topic that cannot be read says so instead of leaving the last one open (review).
        getJson('topic', { w: ws.key, id }).then(latest(setDetail), latest(() => setDetail({ id, error: true })))
      }
      // Close also drops a topic still on its way, so a late answer cannot reopen the panel.
      const close = () => { ask('topic'); setDetail(null) }
      const notice = overviewNotice(ws, t)
      const body = notice ? [notice] : [
        workspaceButtons(ws, t),
        !map ? jsx('div', { className: 'dshcg-muted', children: t('loading') })
          : map.error ? jsxs('div', { className: 'dshcg-row', children: [jsx('div', { className: 'dshcg-bad', children: t('loadFailed') }), jsx('button', { type: 'button', className: 'dshcg-btn', onClick: () => show(ws.key), children: t('retry') })] })
            : jsx(MemoryMap, { map, t, onOpen: open }),
        // Keyed by topic: another topic gets a new panel, not this one's buttons and Copied.
        detail?.error ? jsxs('div', { className: 'dshcg-row', children: [jsx('div', { className: 'dshcg-bad', children: t('topicFailed') }), jsx('button', { type: 'button', className: 'dshcg-btn', onClick: close, children: t('close') })] })
          : detail ? jsx(TopicPanel, { detail, t, onOpen: open, onClose: close }, detail.id) : null
      ]
      return jsx('div', {
        className: 'dshcg-main',
        children: jsxs('div', {
          className: 'dshcg-column dshcg-page',
          children: [
            jsx('div', { className: 'dshcg-heading', children: jsx('h1', { children: t('panel') }) }),
            jsx('div', { className: 'dshcg-muted', children: t('treeIntro') }),
            ...body
          ]
        })
      })
    }

    // The sidebar entry and the page it opens share this id, as dsh's own Automation tasks do.
    const PANEL = 'dsh-context-graph'

    const inject = ['slots', 'locale']
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NAMESPACE, { en, zh }), 'dsh-context-graph: dictionaries')
      ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register({ name: 'conversation.chat.commandview', key: 'context-graph', locale: NAMESPACE }, ContextGraphCard)
      )
      // The plugin's own page in Plugins, keyed by the package name (rc.5 renders it with { view: 'page' }).
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-context-graph', locale: NAMESPACE }, SavingsPage)
      )
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: NAMESPACE }, TreePage))
      // The label is read again at every projection, so it follows the app's language.
      const label = translator(typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NAMESPACE) : undefined)
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 30, locale: NAMESPACE, label: () => label('panel') }, TreeIcon)
      )
    }

    exports.inject = inject
    exports.apply = apply
    exports.ContextGraphCard = ContextGraphCard
    exports.SavingsPage = SavingsPage
    exports.TreePage = TreePage
    exports.TreeIcon = TreeIcon
    exports.MemoryMap = MemoryMap
    exports.TopicPanel = TopicPanel
    exports.subcommandOf = subcommandOf
    exports.splitText = splitText
    return module.exports
  }
})
