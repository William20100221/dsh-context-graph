// The browser side of dsh-context-graph, hand-written in dsh's client-bundle format (no build step).
// The shell loads this file as a plain script; `require` reaches only the shell's shared modules.
// Three contributions:
//   - the chat card for `/context-graph`: dsh's own DisclosureRow, a one-line summary that opens
//     to the details;
//   - the plugin's page in Plugins (`plugins.bundle.config`, #35): what memory saved and cost in
//     each workspace;
//   - Memory tree, an entry of its own in the sidebar's panel list with a page in the main column
//     (#85): what the memory holds. Data comes from the host's owner-only routes (src/host/page.js);
//   - a chat's memory number in its header, and Archive & forget in its session menu (#92), with
//     the confirmation in dsh's frame-wide overlay so it outlives the menu.
window.__ModuleLoader__.load({
  id: 'dsh-context-graph',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { useState } = React
    const { jsx, jsxs } = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { DisclosureRow, Modal, Button } = primitives

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
      tree_label: 'The memory as a tree: the workspace, its chats, their topics',
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
      'open-question': 'Open question',
      hide: 'Hide from memory',
      useAgain: 'Use again',
      hiddenGroup: 'Hidden',
      hiddenGroupHint: 'Chats hidden from memory: no other chat uses them',
      hiddenHint: 'Hidden: no other chat uses this chat, and it is not indexed until you use it again.',
      deleteMemory: 'Delete memory',
      deleteTitle: 'Delete the memory of {chat}?',
      deleteBody: 'Its topics and stored messages are removed for good. This cannot be undone.',
      cancel: 'Cancel',
      deleted: 'deleted',
      archived: 'archived',
      goneHint: 'This chat was deleted in DeepSeek Harness; its memory is still here.',
      archivedHint: 'This chat is archived in DeepSeek Harness.',
      archiveForget: 'Archive & forget',
      forgetTitle: 'Archive {chat} and forget its memory?',
      forgetBody: '“{title}” moves to the archive, where it can be restored. Its memory ({n} topics and their stored messages) is deleted for good and cannot be restored.',
      archiveFailed: 'Not archived:',
      forgetFailed: 'Archived, but its memory was not deleted:',
      archiveUnavailable: 'DeepSeek Harness cannot archive chats here.',
      chipHint: 'Memory {chat}',
      shared: 'shared',
      showAll: 'Show all ({n} characters)',
      showLess: 'Show less',
      wholeTurn: 'Whole turn t{n}',
      turnFailed: 'Could not read this turn.',
      notWhole: 'This chat was indexed before whole messages were kept, and its session is gone: only what its topics cite is here.',
      'type.coding': 'Coding',
      'type.debugging': 'Bug fixing',
      'type.research': 'Research',
      'type.study': 'Study',
      'type.writing': 'Writing',
      'type.planning': 'Planning',
      'type.setup': 'Setup',
      'type.data': 'Data',
      'type.creative': 'Creative',
      'type.language': 'Language',
      'type.question': 'Quick question',
      'type.chat': 'Everyday chat',
      'type.none': 'Not labelled yet',
      parts: 'Parts of this chat',
      byLabel: 'Sort by label',
      unsorted: 'Not sorted yet'
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
      tree_label: '记忆树：工作区、它的对话、对话里的主题',
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
      'open-question': '待定问题',
      hide: '从记忆中隐藏',
      useAgain: '重新使用',
      hiddenGroup: '已隐藏',
      hiddenGroupHint: '从记忆中隐藏的对话：其他对话不会用到它们',
      hiddenHint: '已隐藏：其他对话不会用到这个对话，重新使用之前也不会索引它。',
      deleteMemory: '删除记忆',
      deleteTitle: '删除 {chat} 的记忆？',
      deleteBody: '它的主题和保存的消息会被永久删除，无法恢复。',
      cancel: '取消',
      deleted: '已删除',
      archived: '已归档',
      goneHint: '这个对话已在 DeepSeek Harness 中删除，它的记忆还在这里。',
      archivedHint: '这个对话已在 DeepSeek Harness 中归档。',
      archiveForget: '归档并清除记忆',
      forgetTitle: '归档 {chat} 并清除它的记忆？',
      forgetBody: '“{title}”会移到归档中，之后可以恢复；它的记忆（{n} 个主题及保存的消息）会被永久删除，无法恢复。',
      archiveFailed: '未能归档：',
      forgetFailed: '已归档，但记忆未能删除：',
      archiveUnavailable: '这里无法归档对话。',
      chipHint: '记忆 {chat}',
      shared: '共享',
      showAll: '显示全部（{n} 个字符）',
      showLess: '收起',
      wholeTurn: '整轮 t{n}',
      turnFailed: '无法读取这一轮。',
      notWhole: '这个对话是在保存完整消息之前索引的，而且它的会话已不在：这里只有它的主题引用的内容。',
      'type.coding': '编程',
      'type.debugging': '修复问题',
      'type.research': '调研',
      'type.study': '学习',
      'type.writing': '写作',
      'type.planning': '规划',
      'type.setup': '安装配置',
      'type.data': '数据分析',
      'type.creative': '创作',
      'type.language': '语言翻译',
      'type.question': '快速提问',
      'type.chat': '日常聊天',
      'type.none': '尚未标注',
      parts: '对话的几个部分',
      byLabel: '按标签排序',
      unsorted: '尚未分类'
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
      // The tree scrolls natively in its box; zoom only scales the drawing.
      '.dshcg-treebox{overflow:auto;min-height:240px;max-height:calc(100vh - 220px);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1)}',
      '.dshcg-tree{display:block}',
      '.dshcg-link{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:1.25}',
      '.dshcg-node{cursor:pointer}',
      '.dshcg-pill{fill:var(--dsw-alias-bg-layer-2);stroke:var(--dsw-alias-border-l3);stroke-width:1}',
      '.dshcg-node:hover .dshcg-pill,.dshcg-node[data-match="true"] .dshcg-pill{stroke:var(--dsw-alias-brand-primary,#4A65E8)}',
      '.dshcg-label{font-size:12px;fill:var(--dsw-alias-label-primary)}',
      '.dshcg-node[data-kind="workspace"] .dshcg-label{font-weight:600}',
      '.dshcg-count{font-size:11px;fill:var(--dsw-alias-label-secondary)}',
      '.dshcg-node[data-dim="true"],.dshcg-link[data-dim="true"]{opacity:.18}',
      // #91: the Hidden branch and what is in it are greyed; deleting asks first, in the panel.
      '.dshcg-node[data-group="hidden"] .dshcg-label{font-style:italic;fill:var(--dsw-alias-label-secondary)}',
      '.dshcg-node[data-group="set"] .dshcg-label{font-weight:500}',
      // #101: the toolbar's controls wrap within its left part; Sort by label stays at the top right.
      '.dshcg-tools{display:flex;align-items:flex-start;gap:8px}',
      '.dshcg-tools-main{flex:1 1 0;min-width:0}',
      '.dshcg-tools>.dshcg-btn{flex:none}',
      '.dshcg-node[data-hidden="true"]{opacity:.55}',
      '.dshcg-btn-danger{color:var(--dsw-alias-state-error-primary,#E5484D)}',
      // #92: the header chip sits beside dsh's own preset label; the fallback dialog opts into pointer
      // events, as the overlay layer is click-through.
      '.dshcg-chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:11px;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.dshcg-chip:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshcg-chip[data-hidden="true"]{border-style:dashed}',
      '.dshcg-dialog-mask{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);pointer-events:auto;z-index:1000}',
      '.dshcg-dialog{max-width:440px;margin:16px;padding:20px;border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px;font-size:14px}',
      '.dshcg-tag{display:inline-block;padding:0 8px;border-radius:10px;font-size:12px;line-height:20px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3)}',
      '.dshcg-source{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}',
      '.dshcg-turn{display:flex;flex-direction:column;gap:6px;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l3)}',
      '.dshcg-confirm{border:1px solid var(--dsw-alias-state-error-primary,#E5484D);border-radius:var(--dsw-radius-md,8px);padding:10px;display:flex;flex-direction:column;gap:8px}',
      // #88: a moving node or link eases to its new place (Material 3: 300 ms, emphasized); pointing
      // at or focusing a node fades everything outside its family.
      '.dshcg-node{transition:transform 300ms cubic-bezier(0.2,0,0,1),opacity 150ms linear}',
      '.dshcg-link{transition:d 300ms cubic-bezier(0.2,0,0,1),opacity 150ms linear}',
      '.dshcg-node[data-family="false"],.dshcg-link[data-family="false"]{opacity:.25}',
      '.dshcg-node[data-family="true"] .dshcg-pill{stroke:var(--dsw-alias-label-secondary)}',
      '.dshcg-link[data-family="true"]{stroke:var(--dsw-alias-label-secondary)}',
      '.dshcg-node:focus{outline:none}',
      '.dshcg-node:focus-visible .dshcg-pill{stroke:var(--dsw-alias-brand-primary,#4A65E8);stroke-width:2}',
      '@media (prefers-reduced-motion:reduce){.dshcg-node,.dshcg-link{transition:none}}',
      '.dshcg-node[data-selected="true"] .dshcg-pill{stroke:var(--dsw-alias-brand-primary,#4A65E8);stroke-width:2}',
      // The details sit beside the tree, and below it on a narrow window (#87).
      '.dshcg-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,360px);gap:12px;align-items:start}',
      '.dshcg-split>.dshcg-panel{position:sticky;top:12px;max-height:calc(100vh - 220px);overflow:auto}',
      '@media (max-width:900px){.dshcg-split{grid-template-columns:minmax(0,1fr)}}',
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

    /** A change to one chat's memory (#91): POST with the header the host asks for; the host's reason on failure. */
    async function postJson(name, query) {
      const response = await fetch(`api/context-graph.${name}?${new URLSearchParams(query)}`, { method: 'POST', headers: { 'x-context-graph': '1' } })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
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
      const gone = c.gone ? t('deleted') : c.archived ? t('archived') : ''
      let head = [`c${c.cid}`, gone, c.shared ? '' : t('private'), c.memory ? '' : t('memoryOff'), c.total > c.shown ? `+${c.total - c.shown} ${t('more')}` : ''].filter(Boolean).join(' · ')
      if (letters(head) > room) head = [`c${c.cid}`, `${c.gone ? '🗑' : c.archived ? '🗄' : ''}${c.shared ? '' : '🔒'}${c.memory ? '' : '⏸'}`, c.total > c.shown ? `+${c.total - c.shown}` : ''].filter(Boolean).join(' · ')
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
    /** Characters a source shows before Show all (#93). */
    const FOLD = 1500

    /**
     * One source message, whole (#93): a long one is folded until Show all, and Whole turn reads the
     * turn it belongs to from the chat's stored messages.
     */
    function SourceBlock({ source, t, onTurn }) {
      const [all, setAll] = useState(false)
      const [turn, setTurn] = useState(null) // null, { loading }, { error }, or the host's answer
      const text = String(source.text ?? '')
      const long = text.length > FOLD
      const shown = long && !all ? `${text.slice(0, FOLD)}…` : text
      const read = () => {
        setTurn({ loading: true })
        onTurn(source.turn).then(setTurn, () => setTurn({ error: true }))
      }
      return jsxs('div', {
        className: 'dshcg-source',
        children: [
          jsx('pre', { className: 'dshcg-pre', children: `${source.role}${source.turn ? ` (t${source.turn})` : ''}:\n${shown}` }),
          long || (source.turn && onTurn)
            ? jsxs('div', {
              className: 'dshcg-row',
              children: [
                long ? jsx('button', { type: 'button', className: 'dshcg-btn', onClick: () => setAll(!all), children: all ? t('showLess') : t('showAll').replace('{n}', number(text.length)) }) : null,
                source.turn && onTurn && !turn?.messages ? jsx('button', { type: 'button', className: 'dshcg-btn', disabled: turn?.loading === true, onClick: read, children: t('wholeTurn').replace('{n}', String(source.turn)) }) : null
              ]
            })
            : null,
          turn?.error ? jsx('div', { className: 'dshcg-bad', children: t('turnFailed') }) : null,
          turn?.messages
            ? jsx('div', { className: 'dshcg-turn', children: turn.messages.map((m, i) => jsx('pre', { className: 'dshcg-pre', children: `${m.role}:\n${m.text}` }, i)) })
            : null
        ]
      })
    }

    function TopicPanel({ detail, t, onOpen, onClose, onTurn }) {
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
            ? jsxs('div', { children: [jsx('div', { className: 'dshcg-muted', children: t('sources') }), ...detail.sources.map((s, i) => jsx(SourceBlock, { source: s, t, onTurn: onTurn ? (n) => onTurn(detail.chat.cid, n) : undefined }, `${detail.id} ${i}`))] })
            : null,
          detail.complete === false && detail.sources.length > 0 ? jsx('div', { className: 'dshcg-muted', children: t('notWhole') }) : null
        ]
      })
    }

    // ---- the memory tree (#86) ----------------------------------------------------------------
    // A node-link tree, root on the left. The layout keeps d3-hierarchy's tidy-tree rules (one column
    // per depth, a parent centred on its children, a leaf one row from its sibling and half a row more
    // from another parent's child); each column is as wide as its widest node, as in AntV G6's
    // compactBox; links are d3.linkHorizontal's curves. Techniques credited in the README.

    const ROW = 30 // px from one row to the next
    const PILL = 22 // px, a node's height
    const LETTER = 6.6 // px a Latin letter takes at 12px
    const HGAP = 40 // px from a column's widest node to the next column
    const PAD = 16
    const OPEN_ROWS = 40 // the newest chats start open while their topics stay within this many rows
    const ROOM = [32, 48, 44, 52] // letters a label keeps, by depth; the full text shows on hover

    /** A source message in one line: who, its turn, and its text with the line breaks flattened. */
    const sourceLine = (s) => `${s.role}${s.turn ? ` t${s.turn}` : ''} · ${String(s.text ?? '').replace(/\s+/g, ' ').trim()}`

    /**
     * The host's tree as nested items: workspace, chats, topics, and (#87) the messages of each topic
     * read so far. `details` maps a topic id to its answer, `{ loading: true }` or `{ error: true }`;
     * a topic not read yet has no children, a loading one shows …, a failed one !.
     */
    /** Chat types in the order a tree grouped by label lists them (core/labels.js CHAT_TYPES). */
    const TYPES = ['coding', 'debugging', 'research', 'study', 'writing', 'planning', 'setup', 'data', 'creative', 'language', 'question', 'chat']

    /** A subject's key: its words, lower-cased, so spellings that differ only in case or spacing meet. */
    const subjectKeyOf = (subject) => (typeof subject === 'string' ? subject.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '')

    /**
     * How a tree groups the chats under its workspace: by subject (#96), the layer search goes
     * through first, in the order of each subject's newest chat, chats not sorted yet last; or, with
     * `by` 'label' (#95), by type, chats not labelled yet last. Ungrouped (null) while no chat has
     * a subject yet.
     * @returns [{ key, label, chats }] or null
     */
    function groupsOf(chats, by, t) {
      if (by === 'label') {
        const order = [...TYPES, 'none']
        const buckets = new Map(order.map((k) => [k, []]))
        for (const c of chats) buckets.get(TYPES.includes(c.type) ? c.type : 'none').push(c)
        return order.filter((k) => buckets.get(k).length > 0).map((k) => ({ key: `g:type:${k}`, label: t(`type.${k}`), chats: buckets.get(k) }))
      }
      if (!chats.some((c) => c.subjectKey ?? subjectKeyOf(c.subject))) return null
      const groups = new Map()
      for (const c of chats) {
        // The host's key is the one search uses (#98); this one only for an answer without it.
        const key = c.subjectKey ?? subjectKeyOf(c.subject)
        if (!groups.has(key)) groups.set(key, { key: `g:subject:${key}`, label: key ? String(c.subject).trim() : t('unsorted'), chats: [] })
        groups.get(key).chats.push(c)
      }
      const unsorted = groups.get('')
      groups.delete('')
      return [...groups.values(), ...(unsorted ? [unsorted] : [])]
    }

    /** Each node's parent, by id: what a search or a choice opens to show a node. */
    function parentsOf(root) {
      const parents = new Map()
      const walk = (item) => {
        for (const child of item.children ?? []) {
          parents.set(child.id, item.id)
          walk(child)
        }
      }
      walk(root)
      return parents
    }

    function treeItems(data, t, details = {}, by = null) {
      const topic = (cid, [id, label, kind], links) => {
        const tid = `c${cid}${id}`
        const detail = details[tid]
        return {
          id: tid,
          kind: 'topic',
          topicKind: kind,
          label: fit(String(label), ROOM[2]),
          full: detail?.error ? `${tid} ${label}: ${t('topicFailed')}` : `${tid} ${label}`,
          badge: detail?.loading ? '…' : detail?.error ? '!' : undefined,
          linked: links.flatMap(([from, to]) => (from === id ? [`c${cid}${to}`] : to === id ? [`c${cid}${from}`] : [])),
          children: detail?.sources?.map((s, i) => ({ id: `${tid}s${i}`, kind: 'source', topic: tid, label: fit(sourceLine(s), ROOM[3]), full: sourceLine(s) }))
        }
      }
      const chatItem = (c) => {
        const chat = { ...c, shown: c.topics.length }
        return {
          id: `c${c.cid}`,
          kind: 'chat',
          chat: c,
          label: chatLabel(chat, t, ROOM[1]),
          full: chatLabel(chat, t),
          children: c.topics.map((entry) => topic(c.cid, entry, c.links ?? []))
        }
      }
      // Hidden chats (#91) hang from a branch of their own, closed at first, never grouped.
      const hidden = data.chats.filter((c) => c.hidden)
      const visible = data.chats.filter((c) => !c.hidden)
      const groups = groupsOf(visible, by, t)
      return {
        id: 'w',
        kind: 'workspace',
        label: data.title,
        children: [
          ...(groups ? groups.map((g) => ({ id: g.key, kind: 'group', label: `${g.label} (${g.chats.length})`, full: g.label, children: g.chats.map(chatItem) })) : visible.map(chatItem)),
          ...(hidden.length ? [{ id: 'hidden', kind: 'group', label: `${t('hiddenGroup')} (${hidden.length})`, full: t('hiddenGroupHint'), children: hidden.map(chatItem) }] : [])
        ]
      }
    }

    /** Ids open at first: the workspace and the newest chats, while their topics fit OPEN_ROWS (one at least). */
    function initialOpen(data, by = null) {
      // Every group starts open (they are few); the newest chats open as before (#95, #96).
      const open = new Set(['w', ...(groupsOf(data.chats.filter((x) => !x.hidden), by, (k) => k) ?? []).map((g) => g.key)])
      const groups = open.size - 1
      let rows = 0
      for (const c of data.chats.filter((x) => !x.hidden)) {
        if (open.size > 1 + groups && rows + c.topics.length > OPEN_ROWS) break
        open.add(`c${c.cid}`)
        rows += c.topics.length
      }
      return open
    }

    /** What a node shows at its end: a topic's … or !, else how many a closed branch holds. */
    const countOf = (item, open) => item.badge ?? (item.children?.length && !open.has(item.id) ? String(item.children.length) : '')

    /** A node's width: dot, label, and the count of a closed branch. */
    const widthOf = (item, open) => {
      const count = countOf(item, open)
      return Math.round(24 + letters(item.label) * LETTER + (count ? letters(count) * LETTER + 8 : 0) + 10)
    }

    /**
     * Where each visible node goes. `open` holds the ids whose children show.
     * @returns { nodes: [{ id, item, depth, parent, x, y, w }] in tree order, width, height } in px;
     *          x is a node's left edge, y its middle
     */
    function layoutTree(root, open) {
      const nodes = []
      let next = 0
      let lastParent = null
      const place = (item, depth, parent) => {
        const node = { id: item.id, item, depth, parent, x: 0, y: 0, w: widthOf(item, open), pos: 1, size: 1 }
        nodes.push(node)
        const kids = open.has(item.id) ? item.children ?? [] : []
        if (kids.length === 0) {
          if (lastParent !== null && lastParent !== parent) next += 0.5
          node.y = next++
          lastParent = parent
        } else {
          const placed = kids.map((kid, i) => Object.assign(place(kid, depth + 1, node), { pos: i + 1, size: kids.length }))
          node.y = (placed[0].y + placed[placed.length - 1].y) / 2
        }
        return node
      }
      place(root, 0, null)
      const widths = []
      for (const n of nodes) widths[n.depth] = Math.max(widths[n.depth] ?? 0, n.w)
      const left = [PAD]
      for (let d = 1; d < widths.length; d++) left[d] = left[d - 1] + widths[d - 1] + HGAP
      for (const n of nodes) {
        n.x = left[n.depth]
        n.y = PAD + PILL / 2 + n.y * ROW
      }
      const last = widths.length - 1
      return { nodes, width: left[last] + widths[last] + PAD, height: PAD * 2 + PILL + (next - 1) * ROW }
    }

    /** d3.linkHorizontal's curve from the right end of `from` to the left end of `to`. */
    function linkPath(from, to) {
      const x0 = from.x + from.w
      const mid = (x0 + to.x) / 2
      return `M${x0},${from.y}C${mid},${from.y} ${mid},${to.y} ${to.x},${to.y}`
    }

    // Topics are dots in their kind's colour; the workspace and chats, which hold them, are rings; a
    // topic's messages are small grey dots.
    const dotStyle = (item) => (item.kind === 'topic' ? { fill: COLORS[item.topicKind] ?? '#888' } : item.kind === 'source' ? { fill: 'var(--dsw-alias-label-secondary)' } : item.kind === 'group' ? { fill: 'none', stroke: 'var(--dsw-alias-label-secondary)', strokeWidth: 1.5, strokeDasharray: '2 2' } : { fill: 'none', stroke: 'var(--dsw-alias-label-secondary)', strokeWidth: 1.5 })

    /** A node that has children to show, or a topic whose messages are not read yet. */
    const expandable = (item) => (item.children?.length ?? 0) > 0 || (item.kind === 'topic' && item.children === undefined)

    /**
     * The W3C WAI-ARIA tree view keys (#88), on the visible nodes in tree order: Up/Down move, Right
     * opens a closed branch or steps into an open one, Left closes an open one or steps out to the
     * parent, Home/End go to the ends, Enter or Space does what a click does.
     * @returns { focus: id } | { open: id } | { close: id } | { activate: id } | null
     */
    function treeKey(nodes, id, key, isOpen) {
      const i = nodes.findIndex((n) => n.id === id)
      if (i < 0) return null
      const n = nodes[i]
      if (key === 'ArrowDown') return i + 1 < nodes.length ? { focus: nodes[i + 1].id } : null
      if (key === 'ArrowUp') return i > 0 ? { focus: nodes[i - 1].id } : null
      if (key === 'Home') return { focus: nodes[0].id }
      if (key === 'End') return { focus: nodes[nodes.length - 1].id }
      if (key === 'ArrowRight') {
        if (!expandable(n.item)) return null
        if (!isOpen(n.id)) return { open: n.id }
        return nodes[i + 1]?.parent === n ? { focus: nodes[i + 1].id } : null
      }
      if (key === 'ArrowLeft') {
        if (expandable(n.item) && isOpen(n.id)) return { close: n.id }
        return n.parent ? { focus: n.parent.id } : null
      }
      if (key === 'Enter' || key === ' ') return { activate: n.id }
      return null
    }

    /**
     * A node's family (#88, Apache ECharts' emphasis focus 'relative'): its ancestors, its visible
     * descendants and, for a topic, the topics it links to.
     */
    function familyOf(nodes, id) {
      const n = nodes.find((x) => x.id === id)
      if (!n) return null
      const family = new Set([id, ...(n.item.linked ?? [])])
      for (let up = n.parent; up; up = up.parent) family.add(up.id)
      for (const m of nodes) for (let up = m.parent; up; up = up.parent) if (up === n) family.add(m.id)
      return family
    }

    // Material 3 motion (Google, Apache-2.0): 300 ms (medium2); what enters decelerates
    // (emphasized decelerate), what moves uses the emphasized curve (the CSS transitions above).
    const ENTER = { duration: 300, easing: 'cubic-bezier(0.05, 0.7, 0.1, 1)' }
    const stillness = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true

    // A tree showing more rows than this draws what enters at once: a search that opens thousands of
    // topics would start thousands of animations, on SVG transforms the browser cannot hand to the
    // compositor (#90).
    const CALM_ROWS = 400

    /**
     * A node or link drawn for the first time grows out of its parent, as in the D3 collapsible tree
     * (#88); an element already shown is left to the CSS transitions. Nothing moves when the system
     * asks for reduced motion, or when `calm` (a tree too big to follow the motion, #90).
     */
    function grow(el, frames, calm = false) {
      if (!el || el.dataset?.grown) return
      if (el.dataset) el.dataset.grown = '1'
      if (calm || stillness() || typeof el.animate !== 'function') return
      try { el.animate(frames, ENTER) } catch { /* a browser that cannot animate this property: shown at once */ }
    }

    /** Search, kind filter and zoom, above the tree and its panel. */
    function TreeTools({ t, query, kind, by = null, onQuery, onKind, onScale, onGroup = () => {} }) {
      // Two parts (#101): the controls wrap within the left one, however narrow the window; Sort by
      // label is outside it, at the top right above the details. A second click goes back (#95).
      return jsxs('div', {
        className: 'dshcg-tools',
        children: [
          jsxs('div', {
            className: 'dshcg-row dshcg-tools-main',
            children: [
              jsx('input', { className: 'dshcg-input', type: 'search', placeholder: t('search'), 'aria-label': t('search'), value: query, onChange: (e) => onQuery(e.target.value) }),
              jsx('button', { type: 'button', className: 'dshcg-btn', 'aria-pressed': kind === '' ? 'true' : 'false', onClick: () => onKind(''), children: t('allKinds') }),
              ...KINDS.map((k) => jsxs('button', { type: 'button', className: 'dshcg-btn', 'aria-pressed': kind === k ? 'true' : 'false', onClick: () => onKind(kind === k ? '' : k), children: [jsx('span', { className: 'dshcg-dot', style: { background: COLORS[k] } }), t(k)] }, k)),
              jsx('button', { type: 'button', className: 'dshcg-btn', 'aria-label': t('zoomOut'), onClick: () => onScale((s) => Math.max(0.5, s / 1.25)), children: '−' }),
              jsx('button', { type: 'button', className: 'dshcg-btn', 'aria-label': t('zoomIn'), onClick: () => onScale((s) => Math.min(2, s * 1.25)), children: '+' }),
              jsx('button', { type: 'button', className: 'dshcg-btn', onClick: () => onScale(1), children: t('resetView') })
            ]
          }),
          jsx('button', { type: 'button', className: 'dshcg-btn', 'aria-pressed': by === 'label' ? 'true' : 'false', onClick: () => onGroup(by === 'label' ? null : 'label'), children: t('byLabel') })
        ]
      })
    }

    /**
     * The tree: a click opens or closes a branch and shows its details beside the tree (a chat's, or a
     * topic's, which also brings its messages in as its children, #87); search and kinds dim the rest.
     */
    function MemoryTree({ data, t, query = '', kind = '', scale = 1, by = null, details = {}, selected = null, onOpen, onChat = () => {} }) {
      const [open, setOpen] = useState(initialOpen(data, by))
      const [hover, setHover] = useState(null) // the node under the pointer
      const [focused, setFocused] = useState(null) // the node with keyboard focus
      const [active, setActive] = useState('w') // the tree's one tab stop
      const els = React.useRef(new Map())
      // A topic chosen while its chat is closed (a linked topic opened from the panel) opens that chat
      // once, so the selection is drawn; the chat can be closed again as any other (#89).
      const root = treeItems(data, t, details, by)
      const parents = parentsOf(root)
      const ancestors = (id) => {
        const out = []
        for (let up = parents.get(id); up; up = parents.get(up)) out.push(up)
        return out
      }
      // A chosen chat or topic is drawn: its chat, group and the Hidden branch open once (#89, #92, #95).
      const reveal = selected?.topic ? ancestors(selected.topic) : selected?.chat !== undefined ? ancestors(`c${selected.chat}`) : []
      React.useEffect(() => {
        if (reveal.length) setOpen((was) => (reveal.every((id) => was.has(id)) ? was : new Set([...was, ...reveal])))
      }, [selected?.topic, selected?.chat])
      const q = query.trim().toLowerCase()
      const hit = (item) => item.kind === 'topic' && q !== '' && item.full.toLowerCase().includes(q)
      // A search opens every chat (and group) with a match, without changing what is open once it is cleared.
      const shown = new Set(open)
      if (q) {
        const visit = (item) => {
          if (hit(item)) for (const up of ancestors(item.id)) shown.add(up)
          for (const child of item.children ?? []) visit(child)
        }
        visit(root)
      }
      const layout = layoutTree(root, shown)
      // Closes what is shown open (a chat opened by the search stays open until the search is cleared).
      const toggle = (id) => setOpen((was) => {
        const now = new Set(was)
        if (shown.has(id)) now.delete(id)
        else now.add(id)
        return now
      })
      const activate = (item) => {
        if (item.kind === 'source') return onOpen(item.topic)
        toggle(item.id)
        if (item.kind === 'chat') onChat(item.chat.cid)
        if (item.kind === 'topic') onOpen(item.id)
      }
      const chosen = (item) => (item.kind === 'chat' ? selected?.chat === item.chat.cid : item.kind === 'topic' && selected?.topic === item.id)
      const dim = (item) => item.kind === 'topic' && ((kind && item.topicKind !== kind) || (q && !hit(item)))
      const center = hover ?? focused
      const calm = layout.nodes.length > CALM_ROWS
      const family = center ? familyOf(layout.nodes, center) : null
      // A family holds each member's parent, so a link is in it when its child is.
      const kin = (id) => (family ? (family.has(id) ? 'true' : 'false') : undefined)
      // A node collapsed away hands the tab stop to the workspace, so Tab still reaches the tree.
      const stop = layout.nodes.some((n) => n.id === active) ? active : 'w'
      const key = (n, e) => {
        const move = treeKey(layout.nodes, n.id, e.key, (id) => shown.has(id))
        if (!move) return
        e.preventDefault?.()
        if (move.focus) {
          setActive(move.focus)
          els.current.get(move.focus)?.focus?.()
        }
        if (move.open) n.item.kind === 'topic' ? activate(n.item) : toggle(n.id)
        if (move.close) toggle(n.id)
        if (move.activate) activate(n.item)
      }
      return jsx('div', {
        className: 'dshcg-treebox',
        children: jsxs('svg', {
          className: 'dshcg-tree',
          role: 'tree',
          'aria-label': t('tree_label'),
          width: Math.round(layout.width * scale),
          height: Math.round(layout.height * scale),
          viewBox: `0 0 ${layout.width} ${layout.height}`,
          children: [
            ...layout.nodes.filter((n) => n.parent).map((n) => {
              const d = linkPath(n.parent, n)
              const tip = { x: n.parent.x + n.parent.w, y: n.parent.y, w: 0 }
              return jsx('path', {
                className: 'dshcg-link',
                d,
                // As a style too, so a moving link is eased by the CSS transition on d.
                style: { d: `path('${d}')` },
                'data-dim': dim(n.item) ? 'true' : 'false',
                'data-family': kin(n.id),
                ref: (el) => grow(el, [{ d: `path('${linkPath(n.parent, tip)}')`, opacity: 0 }, { d: `path('${d}')`, opacity: 1 }], calm)
              }, `l${n.id}`)
            }),
            ...layout.nodes.map((n) => {
              const count = countOf(n.item, shown)
              const at = `translate(${n.x}px,${n.y}px)`
              const from = n.parent ? `translate(${n.parent.x + n.parent.w - PILL}px,${n.parent.y}px) scale(0.6)` : at
              return jsxs('g', {
                className: 'dshcg-node',
                role: 'treeitem',
                'aria-level': n.depth + 1,
                'aria-posinset': n.pos,
                'aria-setsize': n.size,
                'aria-expanded': expandable(n.item) ? (shown.has(n.id) ? 'true' : 'false') : undefined,
                'aria-selected': chosen(n.item) ? 'true' : 'false',
                tabIndex: n.id === stop ? 0 : -1,
                'data-kind': n.item.kind,
                'data-group': n.item.kind === 'group' ? (n.id === 'hidden' ? 'hidden' : 'set') : undefined,
                'data-hidden': n.item.chat?.hidden ? 'true' : undefined,
                'data-family': kin(n.id),
                'data-dim': dim(n.item) ? 'true' : 'false',
                'data-match': hit(n.item) ? 'true' : 'false',
                'data-selected': chosen(n.item) ? 'true' : 'false',
                style: { transform: at },
                ref: (el) => {
                  if (el) els.current.set(n.id, el)
                  grow(el, [{ transform: from, opacity: 0 }, { transform: at, opacity: 1 }], calm)
                },
                onClick: () => {
                  setActive(n.id)
                  activate(n.item)
                },
                onKeyDown: (e) => key(n, e),
                onFocus: (e) => {
                  setActive(n.id)
                  // Keyboard focus shows the family; a click's focus does not, or every click would dim the tree.
                  if (e.currentTarget?.matches?.(':focus-visible')) setFocused(n.id)
                },
                onBlur: () => setFocused(null),
                onPointerEnter: () => setHover(n.id),
                onPointerLeave: () => setHover(null),
                children: [
                  jsx('title', { children: n.item.full ?? n.item.label }),
                  jsx('rect', { className: 'dshcg-pill', x: 0, y: -PILL / 2, width: n.w, height: PILL, rx: PILL / 2 }),
                  jsx('circle', { cx: 12, cy: 0, r: 4, style: dotStyle(n.item) }),
                  jsx('text', { className: 'dshcg-label', x: 24, y: 4, children: n.item.label }),
                  count ? jsx('text', { className: 'dshcg-count', x: n.w - 10, y: 4, textAnchor: 'end', children: count }) : null
                ]
              }, n.id)
            })
          ]
        })
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
          const first = value.workspaces.find((w) => w.key === jump.want?.w) ?? value.workspaces.find((w) => w.indexed > 0) ?? value.workspaces[0]
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

    /** A chat, selected in the tree: its marks, summary, dates and what memory saved in it (#87). */
    function ChatPanel({ chat, t, onClose, onHide = async () => {}, onForget = async () => {} }) {
      const [confirming, setConfirming] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const act = (run) => {
        setBusy(true)
        setError('')
        run().then(() => setBusy(false), (reason) => { setBusy(false); setError(String(reason?.message ?? reason)) })
      }
      const marks = [chat.hidden ? t('hiddenGroup') : '', chat.gone ? t('deleted') : chat.archived ? t('archived') : '', chat.shared ? '' : t('private'), chat.memory ? '' : t('memoryOff')].filter(Boolean).join(' · ')
      // Memory can be deleted only once dsh archived or deleted the chat (#91); the host checks too.
      const removable = chat.gone || chat.archived
      const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : '?')
      const s = chat.savings
      return jsxs('div', {
        className: 'dshcg-panel',
        role: 'region',
        'aria-label': `c${chat.cid}`,
        children: [
          jsxs('div', {
            className: 'dshcg-row',
            children: [
              jsx('strong', { children: `c${chat.cid}` }),
              marks ? jsx('span', { className: 'dshcg-muted', children: marks }) : null,
              jsx('button', { type: 'button', className: 'dshcg-btn', onClick: onClose, children: t('close') })
            ]
          }),
          chat.title ? jsx('div', { children: chat.title }) : null,
          chat.summary ? jsx('div', { className: 'dshcg-muted', children: chat.summary }) : null,
          // What the chat is for (#94): its type and project, and its parts when it held several conversations.
          jsx('div', { className: 'dshcg-row', children: [chat.subject ? jsx('span', { className: 'dshcg-tag', children: chat.subject }) : null, jsx('span', { className: 'dshcg-tag', children: t(`type.${chat.type ?? 'none'}`) }), chat.project ? jsx('span', { className: 'dshcg-tag', children: chat.project }) : null] }),
          Array.isArray(chat.parts) && chat.parts.length > 0
            ? jsxs('div', { children: [jsx('div', { className: 'dshcg-muted', children: t('parts') }), ...chat.parts.map((p, i) => jsx('div', { children: `t${p.turns?.[0] ?? '?'}–t${p.turns?.[1] ?? '?'} · ${t(`type.${p.type}`)}${p.about ? `: ${p.about}` : ''}` }, i))] })
            : null,
          jsx('div', { className: 'dshcg-muted', children: `${chat.total} ${t('topics')} · ${day(chat.startedAt)} – ${day(chat.lastActiveAt)}` }),
          s === null || s === undefined
            ? jsx('div', { className: 'dshcg-muted', children: t('savingsUnavailable') })
            : jsx('div', { children: `${t('saved')} ${number(s.saved)} · ${t('cost')} ${number(s.cost)} · ${t('net')} ${s.net >= 0 ? '+' : '−'}${number(Math.abs(s.net))}` }),
          chat.hidden ? jsx('div', { className: 'dshcg-muted', children: t('hiddenHint') }) : null,
          chat.gone ? jsx('div', { className: 'dshcg-muted', children: t('goneHint') }) : chat.archived ? jsx('div', { className: 'dshcg-muted', children: t('archivedHint') }) : null,
          jsxs('div', {
            className: 'dshcg-row',
            children: [
              jsx('button', { type: 'button', className: 'dshcg-btn', disabled: busy, onClick: () => act(() => onHide(chat.cid, !chat.hidden)), children: chat.hidden ? t('useAgain') : t('hide') }),
              removable ? jsx('button', { type: 'button', className: 'dshcg-btn dshcg-btn-danger', disabled: busy, onClick: () => setConfirming(true), children: t('deleteMemory') }) : null
            ]
          }),
          confirming && removable
            ? jsxs('div', {
              className: 'dshcg-confirm',
              role: 'alertdialog',
              'aria-label': t('deleteTitle').replace('{chat}', `c${chat.cid}`),
              children: [
                jsx('strong', { children: t('deleteTitle').replace('{chat}', `c${chat.cid}`) }),
                jsx('div', { children: `${chat.total} ${t('topics')} · ${t('deleteBody')}` }),
                jsxs('div', {
                  className: 'dshcg-row',
                  children: [
                    jsx('button', { type: 'button', className: 'dshcg-btn dshcg-btn-danger', disabled: busy, onClick: () => act(() => onForget(chat.cid)), children: t('deleteMemory') }),
                    jsx('button', { type: 'button', className: 'dshcg-btn', disabled: busy, onClick: () => setConfirming(false), children: t('cancel') })
                  ]
                })
              ]
            })
            : null,
          error ? jsx('div', { className: 'dshcg-bad', role: 'alert', children: error }) : null
        ]
      })
    }

    // The tree's grouping, kept in the app's local storage so it outlives a restart (#95).
    const GROUP_KEY = 'dsh-context-graph:tree-group'
    function readGroup() {
      try { return globalThis.localStorage?.getItem(GROUP_KEY) || null } catch { return null }
    }
    function saveGroup(value) {
      try {
        if (value) globalThis.localStorage?.setItem(GROUP_KEY, value)
        else globalThis.localStorage?.removeItem(GROUP_KEY)
      } catch { /* storage refused (a private window): the choice lasts this visit */ }
    }

    /** Memory tree, the page the sidebar entry opens in the main column (#85). */
    function TreePage(props) {
      const t = translator(props.t)
      const [map, setMap] = useState(null)
      // Topics read so far (#87): id -> the host's answer, { loading: true } or { error: true }.
      const [details, setDetails] = useState({})
      const [selected, setSelected] = useState(null) // { topic: id } or { chat: cid }
      const [query, setQuery] = useState('')
      const [kind, setKind] = useState('')
      const [scale, setScale] = useState(1)
      const [by, setBy] = useState(readGroup())
      const group = (next) => {
        setBy(next)
        saveGroup(next)
      }
      // Each workspace shown is a new generation: an answer asked in an older one is dropped, so a
      // late tree or topic cannot land in the workspace chosen since.
      const generation = React.useRef(0)
      const show = (next) => {
        const n = ++generation.current
        setMap(null)
        setDetails({})
        setSelected(null)
        getJson('tree', { w: next }).then((value) => { if (generation.current === n) setMap(value) }, () => { if (generation.current === n) setMap({ error: true }) })
      }
      const ws = useWorkspaces(show)
      // A chat's header chip asks for it (#92): its workspace is shown, then the chat is chosen.
      const [, bump] = useState(0)
      React.useEffect(() => {
        const listener = () => bump((n) => n + 1)
        jump.listeners.add(listener)
        return () => { jump.listeners.delete(listener) }
      }, [])
      React.useEffect(() => {
        const want = jump.want
        if (!want || ws.state.status !== 'ready') return
        if (ws.key !== want.w) {
          if (ws.state.workspaces.some((x) => x.key === want.w)) ws.choose(want.w)
          else jump.want = null
          return
        }
        if (map?.key === want.w && Array.isArray(map.chats)) {
          jump.want = null
          // Only a chat the tree draws: one with a number and no topics yet is not in it (#99).
          if (map.chats.some((c) => c.cid === want.cid)) setSelected({ chat: want.cid })
        }
      })
      const read = (id) => {
        const n = generation.current
        const take = (value) => { if (generation.current === n) setDetails((was) => ({ ...was, [id]: value })) }
        setDetails((was) => ({ ...was, [id]: { loading: true } }))
        getJson('topic', { w: ws.key, id }).then(take, () => take({ id, error: true }))
      }
      // A topic is read once; one that failed is asked again when opened again.
      const open = (id) => {
        setSelected({ topic: id })
        if (!details[id] || details[id].error) read(id)
      }
      const close = () => setSelected(null)
      // After a change the tree is read again in place: what is open and chosen stays (#91).
      const refresh = () => {
        const n = generation.current
        return getJson('tree', { w: ws.key }).then((value) => { if (generation.current === n) setMap(value) })
      }
      const hideChat = (cid, on) => postJson('hide', { w: ws.key, cid, on: on ? '1' : '0' }).then(refresh)
      const forgetChat = (cid) => postJson('forget', { w: ws.key, cid }).then(() => { setSelected(null); return refresh() })
      const detail = selected?.topic ? details[selected.topic] : undefined
      // A chosen chat that is no longer in the tree (deleted, or never drawn) shows no panel (#99).
      const chosenChat = selected?.chat !== undefined ? map?.chats?.find((c) => c.cid === selected.chat) : undefined
      const panel = !selected || !map?.chats || (selected.chat !== undefined && !chosenChat) ? null
        : selected.chat !== undefined ? jsx(ChatPanel, { chat: chosenChat, t, onClose: close, onHide: hideChat, onForget: forgetChat }, `c${selected.chat}`)
          : detail?.error ? jsxs('div', { className: 'dshcg-panel', children: [jsx('div', { className: 'dshcg-bad', children: t('topicFailed') }), jsxs('div', { className: 'dshcg-row', children: [jsx('button', { type: 'button', className: 'dshcg-btn', onClick: () => read(selected.topic), children: t('retry') }), jsx('button', { type: 'button', className: 'dshcg-btn', onClick: close, children: t('close') })] })] })
            : !detail || detail.loading ? jsx('div', { className: 'dshcg-panel dshcg-muted', children: t('loading') })
              // Keyed by topic: another topic gets a new panel, not this one's buttons and Copied.
              : jsx(TopicPanel, { detail, t, onOpen: open, onClose: close, onTurn: (cid, n) => getJson('turn', { w: ws.key, cid, t: n }) }, detail.id)
      const notice = overviewNotice(ws, t)
      const body = notice ? [notice] : [
        workspaceButtons(ws, t),
        !map ? jsx('div', { className: 'dshcg-muted', children: t('loading') })
          : map.error ? jsxs('div', { className: 'dshcg-row', children: [jsx('div', { className: 'dshcg-bad', children: t('loadFailed') }), jsx('button', { type: 'button', className: 'dshcg-btn', onClick: () => show(ws.key), children: t('retry') })] })
            : map.chats.length === 0 ? jsx('div', { className: 'dshcg-muted', children: t('noWorkspaces') })
              : jsxs('div', {
                className: 'dshcg-page',
                children: [
                  jsx(TreeTools, { t, query, kind, by, onQuery: setQuery, onKind: setKind, onScale: setScale, onGroup: group }),
                  jsxs('div', {
                    className: panel ? 'dshcg-split' : undefined,
                    // A new grouping is a new tree: it opens as a fresh one would.
                    children: [jsx(MemoryTree, { data: map, t, query, kind, scale, by, details, selected, onOpen: open, onChat: (cid) => setSelected({ chat: cid }) }, `${map.key}:${by ?? ''}`), panel]
                  })
                ]
              })
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

    // ---- a chat's memory tag and Archive & forget (#92) ---------------------------------------

    /** Where Memory tree opens next: set by a chat's header chip, taken by the page. */
    const jump = { want: null, listeners: new Set() }
    const jumpTo = (w, cid) => {
      jump.want = { w, cid }
      for (const listener of [...jump.listeners]) listener()
    }

    /** The chat Archive & forget asks about, shown by the overlay's dialog. */
    const forgetAsk = { want: null, listeners: new Set() }
    const askForget = (request) => {
      forgetAsk.want = request
      for (const listener of [...forgetAsk.listeners]) listener()
    }

    /** dsh services reached when needed (layout to open the page, uiWorkspace to archive); set by apply. */
    let serviceOf = () => undefined

    /** A chat's memory facts by its dsh session, read again every 30 s; null while it has none. */
    function useChatInfo(sessionId) {
      const [info, setInfo] = useState(undefined)
      React.useEffect(() => {
        if (!sessionId) return undefined
        let live = true
        const read = () => getJson('chat', { sid: sessionId }).then((value) => { if (live) setInfo(value) }, () => { if (live) setInfo(null) })
        read()
        // A chat gets its number at its first index, mid-conversation: the chip appears then.
        const timer = setInterval(read, 30000)
        return () => { live = false; clearInterval(timer) }
      }, [sessionId])
      return info
    }

    /** `c4` beside the chat's title: which memory branch this chat is; a click opens it in Memory tree. */
    function MemoryChip({ sessionId, t: given }) {
      const t = translator(given)
      const info = useChatInfo(sessionId)
      if (!info) return null
      const state = info.hidden ? t('hiddenGroup') : !info.memory ? t('memoryOff') : info.shared ? t('shared') : t('private')
      const hint = `${t('chipHint').replace('{chat}', `c${info.cid}`)} · ${info.topics ?? '?'} ${t('topics')} · ${state}`
      return jsxs('button', {
        type: 'button',
        className: 'dshcg-chip',
        'data-hidden': info.hidden ? 'true' : undefined,
        title: hint,
        'aria-label': hint,
        onClick: () => {
          jumpTo(info.w, info.cid)
          try { serviceOf('layout')?.selectPanel?.(PANEL) } catch (error) { console.error('context-graph: Memory tree could not be opened', error) }
        },
        children: [jsx(TreeIcon, { size: 12 }), `c${info.cid}`]
      })
    }

    /** The icon of Archive & forget: an archive box, like dsh's Archive, crossed (#100). */
    function ForgetIcon({ size }) {
      const edge = typeof size === 'number' ? size : 16
      return jsxs('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        children: [
          jsx('rect', { x: 2.5, y: 3.5, width: 15, height: 4, rx: 1 }),
          jsx('path', { d: 'M4 7.5v7a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-7' }),
          jsx('path', { d: 'M8.25 10.5l3.5 3.5M11.75 10.5l-3.5 3.5' })
        ]
      })
    }

    /**
     * Archive & forget in a chat's session menu, contributed the way dsh's own session actions are
     * (#100): order 650 and after the component rows, so it sits right under Archive session, in its
     * group and colour. Only for a chat with memory (asked when the menu opens) and not for an archived
     * chat, where dsh offers Restore; the confirmation is the overlay's dialog.
     */
    function forgetMenu(label) {
      return {
        id: 'context-graph.archive-forget',
        target: 'session',
        order: 650,
        async resolve(target, signal) {
          const archived = serviceOf('workspaces')?.list?.getSnapshot?.()?.archivedSessionIds
          if (Array.isArray(archived) && archived.includes(target.sessionId)) return []
          const info = await getJson('chat', { sid: target.sessionId }).catch(() => null)
          if (!info || signal?.aborted) return []
          return [{
            id: 'archive-forget',
            label: label('archiveForget'),
            icon: { key: 'context-graph.forget' },
            afterContent: true,
            run: () => askForget({ sessionId: target.sessionId, title: target.displayTitle, cid: info.cid, topics: info.topics })
          }]
        }
      }
    }

    /**
     * The confirmation Archive & forget opens, in dsh's frame-wide overlay so it outlives the menu:
     * dsh archives the chat, then the host deletes its memory (it checks the chat is archived).
     */
    function ForgetDialog({ t: given }) {
      const t = translator(given)
      const [, bump] = useState(0)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      React.useEffect(() => {
        const listener = () => { setError(''); bump((n) => n + 1) }
        forgetAsk.listeners.add(listener)
        return () => { forgetAsk.listeners.delete(listener) }
      }, [])
      const request = forgetAsk.want
      if (!request) return null
      const done = () => {
        forgetAsk.want = null
        setError('')
        bump((n) => n + 1)
      }
      const close = () => { if (!busy) done() }
      const confirm = async () => {
        setBusy(true)
        setError('')
        try {
          const workspace = serviceOf('uiWorkspace')
          if (typeof workspace?.archiveSession !== 'function') throw new Error(t('archiveUnavailable'))
          await workspace.archiveSession(request.sessionId)
        } catch (reason) {
          setBusy(false)
          setError(`${t('archiveFailed')} ${reason?.message ?? reason}`)
          return
        }
        try {
          await postJson('forget', { sid: request.sessionId })
        } catch (reason) {
          setBusy(false)
          setError(`${t('forgetFailed')} ${reason?.message ?? reason}`)
          return
        }
        setBusy(false)
        done()
      }
      const title = t('forgetTitle').replace('{chat}', `c${request.cid}`)
      const body = t('forgetBody').replace('{title}', request.title || `c${request.cid}`).replace('{n}', String(request.topics ?? '?'))
      const alert = error ? jsx('div', { className: 'dshcg-bad', role: 'alert', children: error }) : null
      if (Modal && Button) {
        return jsx(Modal, {
          open: true,
          onClose: close,
          closeLabel: t('close'),
          title,
          description: body,
          footer: [
            jsx(Button, { variant: 'outline', disabled: busy, onClick: close, children: t('cancel') }, 'cancel'),
            jsx(Button, { variant: 'outline', className: 'dshcg-btn-danger', disabled: busy, onClick: confirm, children: t('archiveForget') }, 'confirm')
          ],
          children: alert
        })
      }
      return jsx('div', {
        className: 'dshcg-dialog-mask',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        children: jsxs('div', {
          className: 'dshcg-dialog',
          children: [
            jsx('strong', { children: title }),
            jsx('div', { children: body }),
            alert,
            jsxs('div', {
              className: 'dshcg-row',
              children: [
                jsx('button', { type: 'button', className: 'dshcg-btn', disabled: busy, onClick: close, children: t('cancel') }),
                jsx('button', { type: 'button', className: 'dshcg-btn dshcg-btn-danger', disabled: busy, onClick: confirm, children: t('archiveForget') })
              ]
            })
          ]
        })
      })
    }

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
      // #92: services are looked up when used, so a shell without one still gets everything else.
      serviceOf = (name) => {
        try { return ctx.get?.(name) } catch { return undefined }
      }
      // Right after dsh's preset label (order -10), before its background-work list (20).
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register({ name: 'conversation.session.header.actions', id: 'context-graph-chip', order: -5, locale: NAMESPACE, inject: (sessionId) => ({ sessionId }) }, MemoryChip)
      )
      // #100: a structured contribution, which dsh places under its own Archive session; its icon is
      // drawn by key, as dsh's are.
      ctx.slots.inject('contextMenu.icon', () =>
        ctx.slots.register({ name: 'contextMenu.icon', key: 'context-graph.forget' }, ForgetIcon)
      )
      ctx.plugin?.({
        name: 'dsh-context-graph-menu',
        inject: ['contextMenus'],
        apply: (menus) => {
          menus.effect(() => menus.contextMenus.register(forgetMenu(label)), 'dsh-context-graph: Archive & forget')
        }
      })
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'context-graph-dialog', locale: NAMESPACE }, ForgetDialog)
      )
    }

    exports.inject = inject
    exports.apply = apply
    exports.ContextGraphCard = ContextGraphCard
    exports.SavingsPage = SavingsPage
    exports.TreePage = TreePage
    exports.TreeIcon = TreeIcon
    exports.MemoryChip = MemoryChip
    exports.forgetMenu = forgetMenu
    exports.ForgetIcon = ForgetIcon
    exports.ForgetDialog = ForgetDialog
    exports.askForget = askForget
    exports.jump = jump
    exports.MemoryTree = MemoryTree
    exports.TreeTools = TreeTools
    exports.treeKey = treeKey
    exports.familyOf = familyOf
    exports.layoutTree = layoutTree
    exports.treeItems = treeItems
    exports.initialOpen = initialOpen
    exports.groupsOf = groupsOf
    exports.chatLabel = chatLabel
    exports.TopicPanel = TopicPanel
    exports.ChatPanel = ChatPanel
    exports.SourceBlock = SourceBlock
    exports.subcommandOf = subcommandOf
    exports.splitText = splitText
    return module.exports
  }
})
