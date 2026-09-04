import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { join, dirname } from 'path'

const require = createRequire(import.meta.url)

// Let Node resolve the package properly
let pkgDir
try {
    const entry = require.resolve('wa-sticker-formatter')
    // walk up from the entry file to the package root
    pkgDir = dirname(require.resolve('wa-sticker-formatter/package.json'))
} catch {
    // package not installed, nothing to do
    process.exit(0)
}

const sharpInside = join(pkgDir, 'node_modules', 'sharp')

try {
    execSync('npm install sharp@^0.33.5 --no-save', {
        cwd: pkgDir,
        stdio: 'pipe',
    })
} catch { }