'use strict'
// CJS bridge for @nexustechpro/baileys (pure ESM package).
// Synchronous require() of an ESM module is not possible in Node.js.
// Use dynamic import() instead:
//   const baileys = await import('@nexustechpro/baileys')
//   const { makeWASocket } = await import('@nexustechpro/baileys')

module.exports = {
    get default() {
        throw new Error(
            '@nexustechpro/baileys is a pure ESM package.\n' +
            'Use: const baileys = await import(\'@nexustechpro/baileys\')\n' +
            'Or set "type": "module" in your package.json and use import syntax.'
        )
    },
    load: () => import('./index.js')
}
