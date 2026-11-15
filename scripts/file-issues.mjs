#!/usr/bin/env node
/**
 * Files the issues of one development cycle on GitHub (maintainer tooling, not shipped).
 *   node scripts/file-issues.mjs docs/cycles/issues-cycle-1.json
 * Creates missing labels and milestones, opens every entry that has no `number` yet, and writes the
 * issue numbers back into the JSON file, so a second run files nothing twice.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'William20100221/dsh-context-graph'
const LABELS = {
  'data-safety': ['b60205', 'Can lose or corrupt stored memory'],
  security: ['d93f0b', 'Security or privacy'],
  tokens: ['1d76db', 'Costs more tokens than needed'],
  quality: ['0e8a16', 'Memory or answer quality'],
  speed: ['fbca04', 'Latency on the critical path'],
  storage: ['5319e7', 'Disk footprint or layout'],
  compatibility: ['c5def5', 'dsh version support']
}

const file = process.argv[2]
if (!file) throw new Error('usage: node scripts/file-issues.mjs <issues.json>')
const issues = JSON.parse(readFileSync(file, 'utf8'))
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim()

for (const [name, [color, description]] of Object.entries(LABELS)) {
  gh('label', 'create', name, '--repo', REPO, '--color', color, '--description', description, '--force')
}

const milestones = new Map(JSON.parse(gh('api', `repos/${REPO}/milestones?state=all&per_page=100`)).map((m) => [m.title, m.number]))
for (const title of new Set(issues.map((i) => i.milestone).filter(Boolean))) {
  if (!milestones.has(title)) milestones.set(title, JSON.parse(gh('api', `repos/${REPO}/milestones`, '-f', `title=${title}`)).number)
}

const scratch = mkdtempSync(join(tmpdir(), 'issues-'))
try {
  for (const issue of issues) {
    if (issue.number) continue
    const bodyFile = join(scratch, `${issue.key}.md`)
    writeFileSync(bodyFile, issue.body, 'utf8')
    const args = ['issue', 'create', '--repo', REPO, '--title', issue.title, '--body-file', bodyFile]
    for (const label of issue.labels ?? []) args.push('--label', label)
    if (issue.milestone) args.push('--milestone', issue.milestone)
    const url = gh(...args)
    issue.number = Number(url.split('/').pop())
    writeFileSync(file, JSON.stringify(issues, null, 2) + '\n', 'utf8')
    console.log(`${issue.key} -> #${issue.number} ${issue.title}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
