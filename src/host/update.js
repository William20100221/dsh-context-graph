/**
 * Update check (same pattern as dsh-clear-conversation/update.js): asks the npm registry once per app
 * start for the latest published version. Never throws and never delays a turn; offline means no notice.
 * Needed because dsh 0.2.1 builds have no update check for third-party plugins on the Plugins page.
 * Opt out with the environment variable DSH_CONTEXT_GRAPH_NO_UPDATE_CHECK=1.
 */

export const PACKAGE = 'dsh-context-graph'
const LATEST_URL = `https://registry.npmjs.org/${PACKAGE}/latest`

const parts = (version) => String(version).replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number)

/** True when `latest` has a higher major.minor.patch than `current`; prerelease tags are ignored. */
export function isNewer(latest, current) {
  const a = parts(latest)
  const b = parts(current)
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

/** The latest published version, or undefined when it cannot be read in time. */
export async function fetchLatestVersion({ fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  try {
    const response = await fetchImpl(LATEST_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return undefined
    const version = (await response.json())?.version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * One line telling the user how to update, or undefined when this copy is current. The exact
 * `name@version` matters: dsh's pnpm holds back very new releases unless the version is named.
 */
export function updateNotice(latest, current) {
  if (!latest || !isNewer(latest, current)) return undefined
  return `${PACKAGE} ${latest} is available (you have ${current}). To update: Plugins, open ${PACKAGE}, Uninstall, then Add plugin ${PACKAGE}@${latest} and restart the app.`
}

/** Start the check now; `current()` returns the notice once the answer has arrived. */
export function startUpdateCheck(version, { env = process.env, ...options } = {}) {
  let notice
  if (!env.DSH_CONTEXT_GRAPH_NO_UPDATE_CHECK) {
    void fetchLatestVersion(options).then((latest) => {
      notice = updateNotice(latest, version)
    })
  }
  return { current: () => notice }
}
