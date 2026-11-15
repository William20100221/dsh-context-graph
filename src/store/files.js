/**
 * JSON files on disk: read (missing file -> undefined) and atomic write (temp file + rename).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 1), 'utf8')
  await rename(tmp, path)
}
