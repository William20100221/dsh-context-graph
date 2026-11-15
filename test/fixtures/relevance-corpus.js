/**
 * The fixed relevance corpus from the cycle-2 audit (#23): 6 chats x 10 topics shaped like builder
 * output (labels of at most 6 words, one-line gists, aliases in the other language), English,
 * Chinese and mixed. TARGETED prompts name the topic ids that answer them; UNRELATED prompts are
 * everyday messages that must get nothing. HELD_T / HELD_U were written after tuning and are never
 * used to pick thresholds. `corpusViews()` builds the plugin's views and stored messages from it.
 */

const T = (label, gist, aliases, kind = 'decision', srcChars = 800) => ({ label, gist, aliases, kind, srcChars })
export const CHATS = [
  { cid: 1, title: 'Set up CI for the monorepo', lang: 'en', topics: [
    T('pnpm store cache in GitHub Actions', 'Cache keyed on pnpm-lock.yaml hash via actions/cache; restore-keys fallback to OS prefix', ['ci cache', 'pnpm cache'], 'decision', 900),
    T('Node version test matrix', 'CI runs Node 18, 20 and 22 on ubuntu-latest; windows only on 20 to save minutes', ['node matrix', 'ci matrix'], 'decision', 600),
    T('Flaky e2e tests quarantine', 'Flaky Playwright specs tagged @flaky and retried twice; tracked in issue #142', ['flaky tests', 'playwright retries'], 'decision', 1400),
    T('Docker image build with buildx', 'buildx with gha cache-to/cache-from; multi-arch amd64+arm64 only on release tags', ['docker build', 'buildx cache'], 'artifact', 2200),
    T('Release workflow on version tags', 'release.yml triggers on v* tags, runs changesets publish and drafts GitHub release notes', ['release.yml', 'changesets'], 'artifact', 1000),
    T('Repository secrets for deploy', 'NPM_TOKEN and DEPLOY_KEY stored as environment secrets on production env with reviewers', ['github secrets', 'npm token'], 'fact', 500),
    T('ESLint flat config', 'Moved to eslint.config.js flat config; lint job fails on warnings in CI only', ['eslint', 'lint job'], 'decision', 700),
    T('Coverage threshold 80 percent', 'vitest coverage with v8 provider; threshold 80% lines, report uploaded to Codecov', ['coverage', 'codecov'], 'decision', 650),
    T('Concurrency cancel in-progress runs', 'concurrency group per ref with cancel-in-progress true for PR workflows', ['cancel in progress', 'concurrency group'], 'fact', 400),
    T('Self-hosted runner open question', 'Whether to add a self-hosted runner for GPU tests; blocked on budget approval', ['self-hosted runner', 'gpu runner'], 'open-question', 450)
  ] },
  { cid: 2, title: 'Postgres schema and performance', lang: 'en', topics: [
    T('Prisma migration workflow', 'prisma migrate dev locally, migrate deploy in CI; never edit applied migrations', ['prisma migrate', 'schema migration', '数据库迁移'], 'decision', 1100),
    T('Composite index on orders', 'Index orders(customer_id, created_at desc) cut the dashboard query from 2.1s to 40ms', ['orders index', 'slow orders query', '索引'], 'decision', 1500),
    T('PgBouncer connection pool', 'PgBouncer in transaction mode, pool size 20 per app instance; prepared statements disabled', ['pgbouncer', 'connection pool', '连接池'], 'decision', 900),
    T('Nightly backups with pg_dump', 'pg_dump nightly to S3 with 14 day retention; restore tested monthly', ['database backup', 'pg_dump', '数据库备份', '备份'], 'decision', 700),
    T('Timestamps stored as timestamptz', 'All time columns are timestamptz in UTC; app converts to user timezone at render', ['timezone column', 'timestamptz'], 'fact', 500),
    T('Slow query log threshold', 'log_min_duration_statement set to 500ms; pg_stat_statements enabled for top queries', ['slow query log', 'pg_stat_statements', '慢查询'], 'fact', 600),
    T('Read replica for reports', 'Reporting queries routed to a read replica via a second Prisma client', ['read replica', 'reporting database'], 'decision', 1300),
    T('Soft delete with deleted_at', 'Soft delete via deleted_at column plus partial unique index where deleted_at is null', ['soft delete', 'deleted_at'], 'decision', 800),
    T('UUID v7 primary keys', 'New tables use uuid v7 primary keys for index locality; old tables keep bigint', ['uuid keys', 'primary key'], 'decision', 550),
    T('Vacuum tuning open question', 'Autovacuum lagging on events table; consider lowering scale factor to 0.02', ['autovacuum', 'vacuum'], 'open-question', 400)
  ] },
  { cid: 3, title: 'React 前端性能优化', lang: 'zh', topics: [
    T('虚拟列表用 react-window', '长列表改用 react-window 的 FixedSizeList，一万行滚动从卡顿到 60fps', ['virtual list', 'react-window', '长列表'], 'decision', 900),
    T('状态管理迁移到 zustand', '从 redux 迁到 zustand，按模块拆 store，减少样板代码', ['zustand', 'state management', 'redux'], 'decision', 1000),
    T('打包体积分析与拆分', '用 rollup-plugin-visualizer 分析，lodash 换成 lodash-es，vendor 拆包后主包从 1.8MB 降到 600KB', ['bundle size', '包体积', 'code splitting'], 'decision', 1600),
    T('路由懒加载', 'React.lazy 加 Suspense 按路由拆分，首页只加载首页代码', ['lazy routes', 'route splitting', '懒加载'], 'decision', 700),
    T('图片压缩与 webp', '构建时用 sharp 转 webp，列表缩略图限制 200px', ['image compression', 'webp', '图片优化'], 'decision', 600),
    T('首屏渲染时间优化', 'LCP 从 3.2s 降到 1.4s：预加载字体、关键 CSS 内联', ['first paint', 'LCP', '首屏'], 'fact', 1200),
    T('事件监听导致内存泄漏', 'useEffect 里 addEventListener 没有清理导致内存泄漏，已补 cleanup', ['memory leak', '内存泄漏'], 'fact', 800),
    T('国际化方案 i18next', '用 react-i18next，语言包按路由懒加载，默认中文', ['i18n', 'react-i18next', '多语言'], 'decision', 650),
    T('暗色模式实现', '用 CSS 变量加 data-theme 属性切换暗色模式，跟随系统偏好', ['dark mode', '主题切换', '深色模式'], 'decision', 500),
    T('表单校验用 zod', 'react-hook-form 配合 zod schema 校验，错误信息中文化', ['form validation', 'zod', '表单验证'], 'decision', 750)
  ] },
  { cid: 4, title: 'Auth service hardening', lang: 'en', topics: [
    T('Refresh token rotation', 'Refresh tokens rotate on every use; reuse of an old token revokes the whole family', ['jwt refresh', 'token rotation', '刷新令牌'], 'decision', 1300),
    T('Google OAuth login', 'OAuth via Google with PKCE; account linked by verified email only', ['oauth', 'google login', 'sso'], 'decision', 1100),
    T('Password hashing with argon2id', 'argon2id with m=64MB t=3 p=1; rehash on login when parameters change', ['argon2', 'password hashing', '密码哈希'], 'decision', 600),
    T('Login rate limiting', '5 failed logins per 15 min per IP+username via Redis sliding window', ['rate limit', 'brute force', '限流'], 'decision', 700),
    T('Session cookie SameSite settings', 'Session cookie is HttpOnly Secure SameSite=Lax; Safari ITP broke None on subdomain', ['session cookie', 'samesite', 'safari cookie'], 'fact', 900),
    T('CORS allowlist', 'CORS allowlist from env var; credentials allowed only for app.example.com', ['cors', 'allowed origins'], 'decision', 450),
    T('TOTP two-factor auth', 'Optional TOTP 2FA with otplib; 10 recovery codes hashed like passwords', ['2fa', 'totp', 'two factor', '双因素认证'], 'decision', 1000),
    T('API keys for integrations', 'API keys prefixed ak_live_, stored as sha256, scoped per workspace', ['api key', 'integration keys'], 'decision', 550),
    T('Audit log table', 'auth_events table records login, logout, password change with ip and user agent', ['audit log', 'auth events'], 'artifact', 500),
    T('RBAC roles model', 'Roles owner, admin, member, viewer; permissions checked in one middleware', ['rbac', 'roles', 'permissions', '权限'], 'decision', 1400)
  ] },
  { cid: 5, title: 'dsh 插件开发 context-graph', lang: 'mix', topics: [
    T('agent/pre-step hook 追加消息', '在 agent/pre-step 里 next() 之后把 user message 追加到 decision.messages 末尾', ['pre-step', 'hook', '钩子'], 'decision', 900),
    T('Prefix cache 保持', '只在请求末尾追加，不改前文，DeepSeek 前缀缓存命中', ['prefix cache', '前缀缓存', 'kv cache'], 'decision', 600),
    T('Token 计费统计', 'llm/stream 里按 usage 分桶统计输入输出 token 和缓存命中', ['token usage', '计费', 'billing'], 'artifact', 700),
    T('recall 工具 schema', 'recall(id) 一个参数，id 支持 c3n12、c3、日期和 t7', ['recall tool', '召回'], 'artifact', 1100),
    T('topics.json 格式 v2', 'nodes 带 label gist aliases kind refs，edges 三元组，nextId 递增', ['topics.json', 'graph format', '图格式'], 'fact', 800),
    T('npm 发布流程', 'npm publish --access public，需要 OTP 二次验证，先跑 npm pack 检查文件', ['npm publish', '发布', 'release'], 'decision', 650),
    T('Windows 路径 bug', 'Windows 下 file URL 和反斜杠混用导致 import 失败，改用 pathToFileURL', ['windows path', '路径问题', 'pathToFileURL'], 'fact', 1000),
    T('node --test 测试', '用 node --test 跑 core 和 store，host 测试需要 DSH_NODE_MODULES', ['node test', '单元测试', 'unit tests'], 'fact', 500),
    T('builder 索引提示词', '每 4 轮人类消息调用一次辅助模型，输出 JSON 节点和边', ['builder prompt', '索引', 'indexing'], 'decision', 1500),
    T('上下文压缩策略', 'dsh 自带 compaction，插件不改写历史，只在末尾追加记忆块', ['compaction', '上下文压缩', 'context compression'], 'decision', 1200)
  ] },
  { cid: 6, title: 'Python data pipeline', lang: 'en', topics: [
    T('Chunked CSV reading in pandas', 'read_csv with chunksize=200k and dtype map keeps memory under 2GB for the 30GB export', ['pandas chunks', 'csv memory', 'out of memory'], 'decision', 1000),
    T('Airflow DAG structure', 'One DAG per source, daily at 02:00 UTC, catchup false, max_active_runs 1', ['airflow dag', 'dag schedule'], 'decision', 1100),
    T('Task retries and backoff', 'retries 3 with exponential backoff starting at 5 minutes; alert to Slack on final failure', ['retries', 'backoff', 'retry policy'], 'decision', 600),
    T('S3 upload with multipart', 'boto3 upload_file with TransferConfig multipart threshold 64MB, server-side encryption on', ['s3 upload', 'boto3'], 'fact', 700),
    T('Row validation with pydantic', 'pydantic v2 models validate each row; invalid rows written to a quarantine file', ['pydantic', 'schema validation', 'row validation'], 'decision', 900),
    T('Parquet output partitioned by date', 'Write parquet with pyarrow partitioned by event_date, snappy compression', ['parquet', 'pyarrow', 'partitioning'], 'decision', 800),
    T('Structured logging with structlog', 'structlog JSON logs with run_id and task_id bound for every pipeline step', ['logging', 'structlog'], 'decision', 500),
    T('Pytest fixtures for pipeline', 'pytest with tmp_path fixtures and small sample CSVs; moto mocks S3', ['pytest', 'pipeline tests', 'moto'], 'fact', 650),
    T('Deduplication by natural key', 'Drop duplicates on (source, external_id) keeping latest updated_at', ['dedupe', 'duplicates'], 'decision', 550),
    T('Late data open question', 'How to handle events arriving more than 2 days late; reprocess window undecided', ['late data', 'late events'], 'open-question', 450)
  ] }
]

// 20 targeted prompts with acceptable gold ids, 20 unrelated everyday prompts.
export const TARGETED = [
  ['the github actions cache for pnpm keeps missing, how did we set the key?', ['c1n1']],
  ['which node versions does our test matrix run on?', ['c1n2']],
  ['the dashboard orders query is slow again, what index did we add?', ['c2n2']],
  ['what pool size did we pick for pgbouncer?', ['c2n3']],
  ['列表滚动很卡，之前虚拟列表用的哪个库？', ['c3n1']],
  ['打包体积又变大了，上次是怎么拆分的', ['c3n3']],
  ['how do we handle refresh token reuse?', ['c4n1']],
  ['what rate limit did we put on the login endpoint', ['c4n4']],
  ['safari keeps dropping the session cookie, what samesite value do we use', ['c4n5']],
  ['在 pre-step hook 里怎么追加一条消息', ['c5n1']],
  ['does appending the memory block at the end keep the prefix cache warm?', ['c5n2']],
  ['npm publish asks for an OTP, what was our release process', ['c5n6']],
  ['how many retries does the airflow task get before alerting?', ['c6n3', 'c6n2']],
  ['pandas runs out of memory on the big csv export', ['c6n1']],
  ['how is the parquet output partitioned', ['c6n6']],
  ['what argon2 parameters do we use for password hashing', ['c4n3']],
  ['数据库备份保留多少天', ['c2n4']],
  ['暗色模式是怎么切换的', ['c3n9']],
  ['the windows path bug with import in the plugin again', ['c5n7']],
  ['内存泄漏那个问题最后怎么修的', ['c3n7']]
]
export const UNRELATED = [
  'what should I cook for dinner tonight',
  'my chocolate chip cookie recipe comes out too dry, any tips?',
  'I need a backup plan if it rains during the weekend trip',
  'my phone storage is full, should I clear the photo cache?',
  'how do I test if an egg is still fresh',
  'recommend a good sci-fi book series',
  'write a short poem about autumn leaves',
  'plan a 3 day trip to Kyoto on a small budget',
  'how do I fix a squeaky door hinge',
  'explain how compound interest works with an example',
  '今天晚上吃什么好',
  '帮我写一封请假邮件给老板',
  '推荐几部好看的科幻电影',
  '怎么提高英语口语水平',
  '周末带孩子去哪里玩比较好',
  '最近工作压力很大，怎么缓解',
  '手机内存不够了怎么清理',
  '帮我规划一下下个月的健身计划',
  '怎么做红烧肉',
  '家里的路由器信号不好怎么办'
]

// Views + stored messages in the plugin's shapes. Source text: one user + one assistant message, sized srcChars.

// Held-out set, written after tuning, never used to pick thresholds.
export const HELD_T = [
  ['are the db backups restore-tested?', ['c2n4']],
  ['which provider does vitest coverage use', ['c1n8']],
  ['zustand store 怎么按模块拆', ['c3n2']],
  ['how do recovery codes for 2fa get stored', ['c4n7']],
  ['首屏 LCP 现在多少秒', ['c3n6']],
  ['what multipart threshold did we set for the s3 upload', ['c6n4']],
  ['给 recall 工具传什么 id', ['c5n4']],
  ['do we cancel in-progress workflow runs on PRs', ['c1n9']],
  ['which roles exist in rbac', ['c4n10']],
  ['how do we dedupe duplicates from the same source', ['c6n9']]
]
export const HELD_U = [
  'what is a good name for my new puppy',
  'my kid has a coverage gap in his math homework',
  'the session at the gym was too hard today',
  'how do I upload photos from my phone to my laptop',
  'can you recommend a pool cleaning routine',
  '怎么给手机设置暗色主题',
  '这个周末想去爬山，天气怎么样',
  '帮我翻译一下这句话',
  '我的密码老是忘记怎么办',
  'my release date for the novel is next month'
]

/**
 * Views (`{ sid, cid, meta, graph, own }`) and stored messages (`{ [sid]: { [seq]: { r, t, a, x } } }`)
 * for the corpus. Each topic cites one user and one assistant message, sized srcChars together.
 * `copies` repeats every chat under new chat numbers (cid + 10k): a user returning to the same
 * projects in new chats (#43).
 */
export function corpusViews({ copies = 1 } = {}) {
  const views = [{ sid: 'own', cid: 99, own: true, meta: { title: 'new chat', startedAt: '2026-11-15T09:00:00Z' }, graph: { version: 2, nextId: 1, nodes: {}, edges: [] } }]
  const messages = {}
  for (let k = 0; k < copies; k++) {
    CHATS.forEach((chat, ci) => {
      const cid = chat.cid + 10 * k
      const nodes = {}
      const edges = []
      const m = {}
      chat.topics.forEach((t, i) => {
        const id = `n${i + 1}`
        const seq = 10 + i * 4
        const at = `2026-11-0${1 + ci}T1${i % 10}:00:00Z`
        nodes[id] = { label: t.label, gist: t.gist, aliases: t.aliases, kind: t.kind, refs: [seq, seq + 1], at, updated: at }
        const unit = chat.lang === 'en' ? `${t.label}: ${t.gist}. ` : `${t.label}，${t.gist}。`
        const fill = (n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n)
        m[seq] = { r: 'user', t: i + 1, a: at, x: fill(Math.round(t.srcChars * 0.25)) }
        m[seq + 1] = { r: 'assistant', t: i + 1, a: at, x: fill(Math.round(t.srcChars * 0.75)) }
        if (i > 0 && i % 3 === 0) edges.push([id, `n${i}`, 'uses'])
      })
      const sid = `s${cid}`
      views.push({ sid, cid, own: false, meta: { cid, title: chat.title, startedAt: `2026-11-0${1 + ci}T09:00:00Z`, lastActiveAt: `2026-11-0${1 + ci}T20:00:00Z` }, graph: { version: 2, nextId: 11, nodes, edges } })
      messages[sid] = m
    })
  }
  return { views, messages }
}
