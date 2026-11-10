import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = path.join(root, 'ipe-plugin')
const modulePath = 'dist/index.mjs'
const packagePath = path.join(pluginDir, 'package.json')
const registryPath = path.join(pluginDir, 'registry.json')

if (!fs.existsSync(path.join(pluginDir, modulePath))) {
  throw new Error(`missing build output: ${path.join(pluginDir, modulePath)}`)
}

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
const entry = `${modulePath}?v=${encodeURIComponent(pkg.version)}`
pkg.module = `./${modulePath}`
pkg.$ipe.loader.entry = entry
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
const plugin = registry.packages.find(item => item.id === 'mediawiki-vscode-ipe')
if (!plugin) throw new Error('mediawiki-vscode-ipe missing from registry.json')
plugin.version = pkg.version
plugin.license = 'GPL-3.0-or-later'
plugin.loader = {
  kind: 'module',
  entry,
  main_export: 'default',
}
fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`)
console.log(`registry entry: ${entry}`)
