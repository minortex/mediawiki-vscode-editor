import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import type {ConfigData} from 'wikiparser-node';

const localRequire = createRequire(__filename);
const USER_AGENT =
  'mediawiki-vscode-editor/0.2 (+https://github.com/minortex/mediawiki-vscode-editor)';

export interface SiteInfoGeneral {
  server?: string;
  articlepath?: string;
  sitename?: string;
  variants?: Array<{code: string}>;
}

export interface SiteInfoNamespace {
  name: string;
  canonical?: string;
}

export interface SiteInfoMagicWord {
  name: string;
  aliases: string[];
  'case-sensitive'?: boolean;
}

export interface SiteInfoQuery {
  general: SiteInfoGeneral;
  namespaces?: Record<string, SiteInfoNamespace>;
  namespacealiases?: Array<{id: number; alias: string}>;
  magicwords?: SiteInfoMagicWord[];
  functionhooks?: string[];
  extensiontags?: string[];
  variables?: string[];
  interwikimap?: Array<{prefix: string}>;
}

interface SiteInfoResponse {
  error?: {code?: string; info?: string};
  query?: SiteInfoQuery;
}

export function defaultConfigPath(): string {
  const pkg = localRequire.resolve('wikiparser-node/package.json');
  return path.join(path.dirname(pkg), 'config', 'default.json');
}

function baseConfig(): ConfigData {
  return JSON.parse(fs.readFileSync(defaultConfigPath(), 'utf8')) as ConfigData;
}

export function normalizeOrigin(input: unknown): string {
  const value = String(input || '').trim();
  if (!value) throw new Error('站点地址为空');
  const url = new URL(/^[a-z][\w+.-]*:\/\//iu.test(value) ? value : `https://${value}`);
  if (!/^https?:$/u.test(url.protocol)) throw new Error('只支持 http/https 站点');
  return url.origin;
}

export function normalizeWikiKey(input: unknown): string {
  if (!input) return '';
  try {
    return normalizeOrigin(input);
  } catch {
    return String(input).trim().toLowerCase();
  }
}

export function isSiteInfoQuery(value: unknown): value is SiteInfoQuery {
  if (!value || typeof value !== 'object' || !('general' in value) || !('magicwords' in value)) {
    return false;
  }
  const query = value as Partial<SiteInfoQuery>;
  return !!query.general && typeof query.general === 'object' && Array.isArray(query.magicwords);
}

export async function fetchSiteInfo(
  origin: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<{origin: string; api: string; query: SiteInfoQuery}> {
  const base = normalizeOrigin(origin);
  const candidates = [`${base}/api.php`, `${base}/w/api.php`];
  let lastError: Error | undefined;
  for (const api of candidates) {
    try {
      const params = new URLSearchParams({
        action: 'query',
        meta: 'siteinfo',
        siprop:
          'general|namespaces|namespacealiases|magicwords|functionhooks|extensiontags|variables|interwikimap',
        format: 'json',
        formatversion: '2',
      });
      const response = await fetchImpl(`${api}?${params}`, {
        headers: {'User-Agent': USER_AGENT},
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15000) : undefined,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as SiteInfoResponse;
      if (data.error) throw new Error(`${data.error.code}: ${data.error.info}`);
      if (!isSiteInfoQuery(data.query)) throw new Error('站点没有返回完整的 siteinfo');
      return {origin: base, api, query: data.query};
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new Error(`无法读取站点信息：${lastError?.message || '未知错误'}`);
}

export function buildParserConfig(query: SiteInfoQuery, siteOrigin?: unknown): ConfigData {
  const {
    general,
    namespaces = {},
    namespacealiases = [],
    magicwords = [],
    functionhooks = [],
    extensiontags = [],
    variables = [],
    interwikimap = [],
  } = query;
  const base = baseConfig();
  const site = normalizeOrigin(siteOrigin || general.server);
  const lower = (value: string): string => value.toLowerCase();
  const uniq = (items: string[]): string[] => [...new Set(items)];

  const nsPairs: Array<[number, string]> = Object.entries(namespaces).flatMap(([id, ns]) => {
    const pairs: Array<[number, string]> = [[Number(id), ns.name]];
    if (ns.canonical && ns.canonical !== ns.name) pairs.push([Number(id), ns.canonical]);
    return pairs;
  });
  const nsid: Record<string, number> = {...base.nsid};
  for (const [id, name] of nsPairs) nsid[lower(name)] = id;
  for (const {id, alias} of namespacealiases) nsid[lower(alias)] = id;
  nsid[''] = 0;

  const behavior = magicwords.filter(word =>
    word.aliases.some(alias => /^__.+__$/u.test(alias)),
  );
  const hookSet = new Set(functionhooks.map(lower));
  const variableSet = new Set(variables);
  const special = new Set(['msg', 'raw', 'subst', 'safesubst', 'msgnw', 'redirect']);
  const option = /^(?:rawsuffix|timef-.+|.+_option_.+)$/u;
  const isParserFunction = (word: SiteInfoMagicWord): boolean =>
    !variableSet.has(word.name) &&
    !special.has(word.name) &&
    !word.name.startsWith('img_') &&
    !option.test(word.name) &&
    !behavior.includes(word);

  const insensitive: Record<string, string> = {...base.parserFunction[0]};
  const sensitive: Record<string, string> = {...base.parserFunction[1], '=': '='};
  const functionHook = new Set([...base.functionHook, ...functionhooks.map(lower), 'msgnw']);
  const hashNames = new Set([
    ...Object.entries(base.parserFunction[0])
      .filter(([key]) => key.startsWith('#'))
      .map(([, name]) => name),
    ...Object.entries(base.parserFunction[1])
      .filter(([key]) => key.startsWith('#'))
      .map(([, name]) => name),
    'default',
    'widget',
    'len',
    'pos',
    'rpos',
    'sub',
    'count',
    'replace',
    'explode',
    'urldecode',
    'rel2abs',
    'titleparts',
    'time',
    'timel',
    'timef',
    'timefl',
    'lst',
    'lstx',
    'lsth',
    'target',
    'babel',
    'coordinates',
    'related',
    'categorytree',
    'noexternallanglinks',
    'property',
    'statements',
    'commaseparatedlist',
    'assessment',
    'chart',
    'uic',
    'mentor',
    'seo',
    'tag',
    'formatdate',
    'int',
    'special',
    'speciale',
  ]);
  for (const word of magicwords.filter(isParserFunction)) {
    const target = word['case-sensitive'] ? sensitive : insensitive;
    const existing = Object.entries(target)
      .filter(([, canonical]) => canonical === word.name)
      .map(([key]) => key);
    const hash =
      hashNames.has(word.name) ||
      (existing.length > 0
        ? existing.some(key => key.startsWith('#'))
        : !hookSet.has(lower(word.name)) && !word.aliases.some(alias => alias.endsWith(':')));
    for (let alias of word.aliases) {
      if (/^[^#＃].*：$/u.test(alias)) continue;
      alias = alias.replace(/:$/u, '');
      if (hash && !alias.startsWith('#')) alias = `#${alias}`;
      target[word['case-sensitive'] || hash ? alias : lower(alias)] = word.name;
    }
    functionHook.add(lower(word.name));
  }

  const switchesInsensitive: Record<string, string> = {...base.doubleUnderscore[2]};
  const switchesSensitive: Record<string, string> = {...base.doubleUnderscore[3]};
  for (const word of behavior) {
    const target = word['case-sensitive'] ? switchesSensitive : switchesInsensitive;
    for (const alias of word.aliases) {
      const key = /^__(.+)__$/u.exec(alias)?.[1] ?? alias;
      if (word['case-sensitive']) {
        target[key] = word.name.toUpperCase();
      } else {
        target[lower(key)] = word.name;
      }
    }
  }

  const aliasesOf = (name: string): string[] =>
    magicwords
      .find(word => word.name === name)
      ?.aliases.map(alias => lower(alias.replace(/:$/u, ''))) ?? [];
  const imageKeywords = Object.fromEntries(
    magicwords
      .filter(word => word.name.startsWith('img_') && word.name !== 'img_lossy')
      .flatMap(word => {
        const key = word.name.slice(4).replaceAll('_', '-');
        return (key === 'alt' ? word.aliases.filter(alias => alias.includes('$1')) : word.aliases)
          .map(alias => [alias, key] as const);
      }),
  );
  const articlePath = new URL(general.articlepath || '/$1', site).href;

  return {
    ...base,
    ext: extensiontags.map(tag => tag.replace(/^<|>$/gu, '').toLowerCase()),
    namespaces: Object.fromEntries(nsPairs.map(([id, name]) => [id, name])),
    nsid,
    functionHook: [...functionHook].sort(),
    variable: uniq([...variables, '=']),
    parserFunction: [
      insensitive,
      sensitive,
      aliasesOf('msg').concat(aliasesOf('raw')),
      aliasesOf('subst').concat(aliasesOf('safesubst')),
    ],
    doubleUnderscore: [[], [], switchesInsensitive, switchesSensitive],
    protocol: base.protocol,
    interwiki: interwikimap.map(({prefix}) => prefix),
    img: imageKeywords,
    redirection: aliasesOf('redirect').filter(alias => alias.startsWith('#')),
    variants: general.variants?.map(({code}) => code) ?? base.variants,
    articlePath,
    server: site,
  };
}

export function sanitizeHost(input: unknown): string {
  return String(input || '').replace(/[\\/:*?"<>|\r\n]/g, '_');
}

export function wikiIdFromOrigin(origin: unknown): string {
  try {
    return sanitizeHost(new URL(normalizeOrigin(origin)).host).toLowerCase();
  } catch {
    return sanitizeHost(origin).toLowerCase();
  }
}
