/**
 * Run the whole suite in three time zones: UTC, Pacific/Auckland (the maintainer's, with
 * daylight saving in the other half of the year) and America/Los_Angeles.
 *
 * The zone is set on the child process from here. In Git Bash on Windows, `TZ=Pacific/Auckland npm test`
 * silently runs in the machine's own zone (MSYS does not pass such a TZ to Windows programs), so
 * each run first prints the zone the child actually uses.
 *   node scripts/test-zones.mjs
 */
import { spawnSync } from 'node:child_process'

const ZONES = ['UTC', 'Pacific/Auckland', 'America/Los_Angeles']
const node = (args, tz, stdio) => spawnSync(process.execPath, args, { env: { ...process.env, TZ: tz }, stdio, encoding: 'utf8' })

for (const tz of ZONES) {
  const seen = node(['-e', 'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)'], tz, 'pipe').stdout
  if (seen !== tz) {
    console.error(`time zone ${tz} was not applied (the child runs in ${seen})`)
    process.exit(1)
  }
  console.log(`\n=== ${tz}`)
  const run = node(['--import', './test/helpers/resolve-dsh.mjs', '--test', 'test/**/*.test.js'], tz, 'inherit')
  if (run.status !== 0) process.exit(run.status ?? 1)
}
