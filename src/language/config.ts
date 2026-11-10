'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const {defaultConfigPath} = require('../wiki-config');

function setting(key: string, fallback: any): any {
  const value = vscode.workspace.getConfiguration('mediawikiEditor').get(key);
  return value === undefined ? fallback : value;
}

function createConfigLoader(extensionPath: string) {
  const cache = new Map();

  function resolvePath(wiki: any): string {
    if (wiki?.configPath) return wiki.configPath;
    const configured = String(setting('parserConfig', '') || '').trim();
    if (!configured) return defaultConfigPath();
    if (path.isAbsolute(configured)) return configured;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || extensionPath;
    return path.resolve(folder, configured);
  }

  function load(wiki: any): any {
    const file = resolvePath(wiki);
    if (cache.has(file)) return cache.get(file);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      const fallback = defaultConfigPath();
      if (file !== fallback) {
        vscode.window.showWarningMessage(
          `MediaWiki: 无法读取解析配置 ${file}，改用内置默认解析配置：${error.message}`
        );
        raw = JSON.parse(fs.readFileSync(fallback, 'utf8'));
      } else {
        throw error;
      }
    }
    cache.set(file, raw);
    return raw;
  }

  return {load, clear: () => cache.clear()};
}

module.exports = {setting, createConfigLoader};
