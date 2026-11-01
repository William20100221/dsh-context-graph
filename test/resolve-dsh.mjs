/**
 * Test-only loader: resolves `@deepseek-ai/*` from the folder named by DSH_NODE_MODULES
 * (a dsh install's node_modules) so index.js can be imported outside a running harness.
 * Usage: DSH_NODE_MODULES=/path/to/node_modules node --import ./test/resolve-dsh.mjs --test test/plugin.test.js
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

const root = process.env.DSH_NODE_MODULES
if (root) {
  register(new URL('data:text/javascript,' + encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier.startsWith('@deepseek-ai/') && !context.parentURL?.includes('/node_modules/')) {
        return next(specifier, { ...context, parentURL: ${JSON.stringify(pathToFileURL(root + '/').href)} })
      }
      return next(specifier, context)
    }
  `)))
}
