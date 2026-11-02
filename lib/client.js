// Chat card for `/context-graph`, hand-written in dsh's client-bundle format (no build step).
// The shell loads this file as a plain script; `require` reaches only the shell's shared modules.
// Layout follows dsh's own command card: DisclosureRow with a 14px icon, a title, a one-line
// summary, and the remaining lines as an expandable body.
window.__ModuleLoader__.load({
  id: 'dsh-context-graph',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const { useState } = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const { DisclosureRow } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NAMESPACE = 'dsh-context-graph'
    const en = {
      stats: 'Context graph',
      build: 'Index this chat',
      fold: 'Fold old turns',
      find: 'Find topics',
      running: 'Working…',
      failed: 'Failed'
    }
    const zh = {
      stats: '上下文图谱',
      build: '索引当前对话',
      fold: '折叠旧轮次',
      find: '查找主题',
      running: '处理中…',
      failed: '失败'
    }

    const CSS = [
      '.dshcg-root{margin:2px 0}',
      '.dshcg-summary{margin-left:8px;font-size:13px;opacity:.72}',
      '.dshcg-summary[data-error]{color:var(--color-text-danger,#d64545);opacity:1}',
      '.dshcg-body{padding:6px 0 6px 24px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}'
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

    const SUBCOMMANDS = ['stats', 'build', 'fold', 'find']

    /** Title key from the typed arguments (`/context-graph fold` -> fold); no argument means stats. */
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

    const inject = ['slots', 'locale']
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NAMESPACE, { en, zh }), 'dsh-context-graph: dictionaries')
      ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register({ name: 'conversation.chat.commandview', key: 'context-graph', locale: NAMESPACE }, ContextGraphCard)
      )
    }

    exports.inject = inject
    exports.apply = apply
    exports.ContextGraphCard = ContextGraphCard
    exports.subcommandOf = subcommandOf
    exports.splitText = splitText
    return module.exports
  }
})
