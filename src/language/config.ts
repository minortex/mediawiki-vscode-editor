import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs';
import type {ConfigData} from 'wikiparser-node';
import {defaultConfigPath} from '../wiki/config';
import type {WikiRecord} from '../wiki/registry';

export function setting<T>(key: string, fallback: T): T {
  const value = vscode.workspace.getConfiguration('mediawikiEditor').get<T>(key);
  return value === undefined ? fallback : value;
}

export interface ConfigLoader {
  load(wiki?: WikiRecord): ConfigData;
  clear(): void;
}

export function createConfigLoader(extensionPath: string): ConfigLoader {
  const cache = new Map<string, ConfigData>();

  function resolvePath(wiki?: WikiRecord): string {
    if (wiki?.configPath) return wiki.configPath;
    const configured = String(setting('parserConfig', '') || '').trim();
    if (!configured) return defaultConfigPath();
    if (path.isAbsolute(configured)) return configured;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || extensionPath;
    return path.resolve(folder, configured);
  }

  function load(wiki?: WikiRecord): ConfigData {
    const file = resolvePath(wiki);
    const cached = cache.get(file);
    if (cached) return cached;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      const fallback = defaultConfigPath();
      if (file !== fallback) {
        vscode.window.showWarningMessage(
          vscode.l10n.t(
            'MediaWiki: Unable to read parser config {0}; using the built-in default: {1}',
            file,
            error instanceof Error ? error.message : String(error),
          ),
        );
        raw = JSON.parse(fs.readFileSync(fallback, 'utf8'));
      } else {
        throw error;
      }
    }
    const config = raw as ConfigData;
    cache.set(file, config);
    return config;
  }

  return {load, clear: () => cache.clear()};
}
