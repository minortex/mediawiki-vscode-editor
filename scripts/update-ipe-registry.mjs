import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = path.join(root, 'ipe-plugin')
const distDir = path.join(pluginDir, 'dist')
const packagePath = path.join(pluginDir, 'package.json')
const registryPath = path.join(pluginDir, 'registry.json')

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
const files = fs
  .readdirSync(distDir)
  .filter(file => /^index\.[^.]+\.mjs$/.test(file))
  .sort()
if (files.length !== 1) {
  throw new Error(`expected one hashed entry in ${distDir}, found: ${files.join(', ') || 'none'}`)
}
const entry = `dist/${files[0]}`

pkg.module = `./${entry}`
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
