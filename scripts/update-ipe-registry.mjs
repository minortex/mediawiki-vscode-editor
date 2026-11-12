import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {ipeVersion} from './ipe-version.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = path.join(root, 'ipe-plugin')
const modulePath = 'dist/index.mjs'
const templatePath = path.join(pluginDir, 'registry.template.json')
const registryPath = path.join(pluginDir, 'registry.json')

if (!fs.existsSync(path.join(pluginDir, modulePath))) {
  throw new Error(`missing build output: ${path.join(pluginDir, modulePath)}`)
}

const version = ipeVersion()
const entry = `${modulePath}?v=${encodeURIComponent(version)}`

const registry = JSON.parse(fs.readFileSync(templatePath, 'utf8'))
const plugin = registry.packages.find(item => item.id === 'mediawiki-vscode-ipe')
if (!plugin) throw new Error('mediawiki-vscode-ipe missing from registry.template.json')
plugin.version = version
plugin.license = 'GPL-3.0-or-later'
plugin.loader = {
  kind: 'module',
  entry,
  main_export: 'default',
}
fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`)
console.log(`registry entry: ${entry}`)
