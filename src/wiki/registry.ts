import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type {WikiIdentity} from '../protocol';
import {
  buildParserConfig,
  isSiteInfoQuery,
  normalizeOrigin,
  sanitizeHost,
  wikiIdFromOrigin,
} from './config';

const STATE_KEY = 'mediawikiEditor.wikis';

export interface WikiRecord extends WikiIdentity {
  url: string;
  host: string;
  api: string;
  articlePath?: string;
  configPath?: string;
  siteinfoHash?: string;
}

export interface WikiPublish {
  origin: string;
  api: string;
  name?: string;
  siteinfo: unknown;
}

export interface WikiRegistry {
  resolve(
    context: vscode.ExtensionContext,
    hint?: string,
    fallbackOrigin?: string,
  ): WikiRecord | undefined;
  upsert(context: vscode.ExtensionContext, payload: WikiPublish): Promise<WikiRecord>;
  directoryFor(root: string, wiki: WikiRecord): string;
}

export function custom(context: vscode.ExtensionContext): WikiRecord[] {
  return context.globalState
    .get<WikiRecord[]>(STATE_KEY, [])
    .filter(wiki => !!wiki && !!wiki.origin);
}

export async function saveCustom(
  context: vscode.ExtensionContext,
  wikis: WikiRecord[],
): Promise<void> {
  await context.globalState.update(
    STATE_KEY,
    wikis.filter(wiki => !!wiki && !!wiki.origin),
  );
}

export function all(context: vscode.ExtensionContext): WikiRecord[] {
  return custom(context);
}

function normalizeHint(hint: string | undefined): string {
  return String(hint || '').trim().replace(/\/+$/u, '').toLowerCase();
}

export function find(
  context: vscode.ExtensionContext,
  hint: string | undefined,
): WikiRecord | undefined {
  const raw = normalizeHint(hint);
  if (!raw) return undefined;
  for (const wiki of all(context)) {
    if (
      [wiki.id, wiki.origin, wiki.url, wiki.host]
        .filter(Boolean)
        .some(value => normalizeHint(value) === raw)
    ) {
      return wiki;
    }
  }
  try {
    const origin = normalizeOrigin(raw);
    return all(context).find(
      wiki => normalizeHint(wiki.origin) === normalizeHint(origin),
    );
  } catch {
    return undefined;
  }
}

export function resolve(
  context: vscode.ExtensionContext,
  hint?: string,
  fallbackOrigin?: string,
): WikiRecord | undefined {
  if (hint) return find(context, hint) || find(context, fallbackOrigin);
  return fallbackOrigin ? find(context, fallbackOrigin) : undefined;
}

export function directoryFor(root: string, wiki: WikiRecord): string {
  const host = wiki.host || (() => {
    try {
      return new URL(wiki.url).host;
    } catch {
      return wiki.id;
    }
  })();
  return path.join(root, sanitizeHost(host));
}

export function configFile(context: vscode.ExtensionContext, id: string): string {
  return path.join(context.globalStorageUri.fsPath, 'wikis', `${id}.json`);
}

export async function upsert(
  context: vscode.ExtensionContext,
  payload: WikiPublish,
): Promise<WikiRecord> {
  const origin = normalizeOrigin(payload.origin);
  const query = payload.siteinfo;
  if (!isSiteInfoQuery(query)) {
    throw new Error('浏览器没有提供完整的 siteinfo');
  }
  const api = new URL(payload.api || `${origin}/api.php`, origin).href;
  if (new URL(api).origin !== origin) {
    throw new Error('API 地址必须与站点同源');
  }
  const config = buildParserConfig(query, origin);
  const existing = find(context, origin);
  const id = existing?.id || wikiIdFromOrigin(origin);
  const host = new URL(origin).host;
  const name = String(payload.name || '').trim() || host;
  const siteinfoHash = crypto.createHash('sha1').update(JSON.stringify(query)).digest('hex');
  const file = configFile(context, id);
  const changed =
    !existing ||
    existing.siteinfoHash !== siteinfoHash ||
    existing.api !== api ||
    existing.articlePath !== config.articlePath ||
    existing.name !== name ||
    !fs.existsSync(file);
  if (changed) {
    await fs.promises.mkdir(path.dirname(file), {recursive: true});
    await fs.promises.writeFile(file, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
  }
  const entry: WikiRecord = {
    id,
    name,
    url: origin,
    origin,
    host,
    api,
    articlePath: config.articlePath,
    configPath: file,
    siteinfoHash,
  };
  if (changed || !existing) {
    const wikis = custom(context).filter(wiki => wiki.id !== id);
    wikis.push(entry);
    await saveCustom(context, wikis);
  }
  return entry;
}

async function promptRemove(
  context: vscode.ExtensionContext,
  onChange: () => void,
): Promise<void> {
  const wikis = custom(context);
  if (!wikis.length) {
    vscode.window.showInformationMessage('MediaWiki: 没有已注册的 wiki。');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    wikis.map(wiki => ({label: wiki.name, description: wiki.origin, wiki})),
    {placeHolder: '选择要删除的 wiki'},
  );
  if (!picked) return;
  const confirm = await vscode.window.showWarningMessage(
    `MediaWiki: 删除 ${picked.wiki.name}？已生成的解析配置也会删除。`,
    {modal: true},
    '删除',
  );
  if (confirm !== '删除') return;
  const wikisLeft = custom(context).filter(wiki => wiki.id !== picked.wiki.id);
  await saveCustom(context, wikisLeft);
  if (picked.wiki.configPath) {
    try {
      await fs.promises.unlink(picked.wiki.configPath);
    } catch {}
  }
  onChange();
  vscode.window.showInformationMessage(`MediaWiki: 已删除 ${picked.wiki.name}`);
}

async function showList(context: vscode.ExtensionContext): Promise<void> {
  const items = all(context).map(wiki => ({
    label: wiki.name,
    description: wiki.origin,
    detail: `API：${wiki.api}\n配置：${wiki.configPath || '（默认）'}`,
    wiki,
  }));
  await vscode.window.showQuickPick(items, {
    placeHolder: '已注册的 wiki（浏览网页时自动注册，Esc 关闭）',
    canPickMany: false,
  });
}

export function register(
  context: vscode.ExtensionContext,
  onChange: () => void,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('mediawikiEditor.removeWiki', () =>
      promptRemove(context, onChange),
    ),
    vscode.commands.registerCommand('mediawikiEditor.listWikis', () => showList(context)),
  ];
}

export const wikiRegistry: WikiRegistry = {resolve, upsert, directoryFor};
