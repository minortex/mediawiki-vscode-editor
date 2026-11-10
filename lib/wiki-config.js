'use strict';

const fs = require('fs');
const path = require('path');

const USER_AGENT = 'mediawiki-vscode-editor/0.2 (+https://github.com/minortex/mediawiki-vscode-editor)';

function baseConfig() {
  const pkg = require.resolve('wikiparser-node/package.json');
  return JSON.parse(fs.readFileSync(path.join(path.dirname(pkg), 'config', 'default.json'), 'utf8'));
}

function normalizeOrigin(input) {
  const value = String(input || '').trim();
  if (!value) throw new Error('站点地址为空');
  const url = new URL(/^[a-z][\w+.-]*:\/\//iu.test(value) ? value : `https://${value}`);
  if (!/^https?:$/u.test(url.protocol)) throw new Error('只支持 http/https 站点');
  return url.origin;
}

function normalizeWikiKey(input) {
  if (!input) return '';
  try {
    return normalizeOrigin(input);
  } catch {
    return String(input).trim().toLowerCase();
  }
}

async function fetchSiteInfo(origin, fetchImpl = fetch) {
  const base = normalizeOrigin(origin);
  const candidates = [`${base}/api.php`, `${base}/w/api.php`];
  let lastError;
  for (const api of candidates) {
    try {
      const params = new URLSearchParams({
        action: 'query',
        meta: 'siteinfo',
        siprop: 'general|namespaces|namespacealiases|magicwords|functionhooks|extensiontags|variables|interwikimap',
        format: 'json',
        formatversion: '2',
      });
      const response = await fetchImpl(`${api}?${params}`, {
        headers: {'User-Agent': USER_AGENT},
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15000) : undefined,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.error) throw new Error(`${data.error.code}: ${data.error.info}`);
      const query = data.query;
      if (!query?.general || !query.magicwords) throw new Error('站点没有返回完整的 siteinfo');
      return {origin: base, api, query};
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法读取站点信息：${lastError?.message || '未知错误'}`);
}

function buildParserConfig(query, siteOrigin) {
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
  const lower = (s) => s.toLowerCase();
  const uniq = (items) => [...new Set(items)];

  const nsPairs = Object.entries(namespaces).flatMap(([id, ns]) => {
    const pairs = [[Number(id), ns.name]];
    if (ns.canonical && ns.canonical !== ns.name) pairs.push([Number(id), ns.canonical]);
    return pairs;
  });
  const nsid = {...base.nsid};
  for (const [id, name] of nsPairs) nsid[lower(name)] = id;
  for (const {id, alias} of namespacealiases) nsid[lower(alias)] = id;
  nsid[''] = 0;

  const behavior = magicwords.filter((m) => m.aliases.some((a) => /^__.+__$/u.test(a)));
  const hookSet = new Set(functionhooks.map(lower));
  const variableSet = new Set(variables);
  const special = new Set(['msg', 'raw', 'subst', 'safesubst', 'msgnw', 'redirect']);
  const option = /^(?:rawsuffix|timef-.+|.+_option_.+)$/u;
  const isParserFunction = (m) => !variableSet.has(m.name)
    && !special.has(m.name)
    && !m.name.startsWith('img_')
    && !option.test(m.name)
    && !behavior.includes(m);

  const insensitive = {...base.parserFunction[0]};
  const sensitive = {...base.parserFunction[1], '=': '='};
  const functionHook = new Set([...base.functionHook, ...functionhooks.map(lower), 'msgnw']);
  const hashNames = new Set([
    ...Object.entries(base.parserFunction[0]).filter(([key]) => key.startsWith('#')).map(([, name]) => name),
    ...Object.entries(base.parserFunction[1]).filter(([key]) => key.startsWith('#')).map(([, name]) => name),
    'default', 'widget', 'len', 'pos', 'rpos', 'sub', 'count', 'replace', 'explode', 'urldecode',
    'rel2abs', 'titleparts', 'time', 'timel', 'timef', 'timefl', 'lst', 'lstx', 'lsth', 'target',
    'babel', 'coordinates', 'related', 'categorytree', 'noexternallanglinks', 'property', 'statements',
    'commaseparatedlist', 'assessment', 'chart', 'uic', 'mentor', 'seo', 'tag', 'formatdate', 'int',
    'special', 'speciale',
  ]);
  for (const m of magicwords.filter(isParserFunction)) {
    const target = m['case-sensitive'] ? sensitive : insensitive;
    const existing = Object.entries(target).filter(([, canonical]) => canonical === m.name).map(([key]) => key);
    const hash = hashNames.has(m.name)
      || (existing.length > 0
        ? existing.some((key) => key.startsWith('#'))
        : !hookSet.has(lower(m.name)) && !m.aliases.some((a) => a.endsWith(':')));
    for (let alias of m.aliases) {
      if (/^[^#＃].*：$/u.test(alias)) continue;
      alias = alias.replace(/:$/u, '');
      if (hash && !alias.startsWith('#')) alias = `#${alias}`;
      target[m['case-sensitive'] || hash ? alias : lower(alias)] = m.name;
    }
    functionHook.add(lower(m.name));
  }

  const switchesInsensitive = {...base.doubleUnderscore[2]};
  const switchesSensitive = {...base.doubleUnderscore[3]};
  for (const m of behavior) {
    const target = m['case-sensitive'] ? switchesSensitive : switchesInsensitive;
    for (const alias of m.aliases) {
      const key = /^__(.+)__$/u.exec(alias)?.[1] ?? alias;
      if (m['case-sensitive']) {
        target[key] = m.name.toUpperCase();
      } else {
        target[lower(key)] = m.name;
      }
    }
  }

  const aliasesOf = (name) => magicwords.find((m) => m.name === name)?.aliases
    .map((a) => lower(a.replace(/:$/u, ''))) ?? [];
  const imageKeywords = Object.fromEntries(magicwords
    .filter((m) => m.name.startsWith('img_') && m.name !== 'img_lossy')
    .flatMap((m) => {
      const key = m.name.slice(4).replaceAll('_', '-');
      return (key === 'alt' ? m.aliases.filter((a) => a.includes('$1')) : m.aliases)
        .map((a) => [a, key]);
    }));
  const articlePath = new URL(general.articlepath || '/$1', site).href;

  return {
    ...base,
    ext: extensiontags.map((tag) => tag.replace(/^<|>$/gu, '').toLowerCase()),
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
    redirection: aliasesOf('redirect').filter((a) => a.startsWith('#')),
    variants: general.variants?.map(({code}) => code) ?? base.variants,
    articlePath,
    server: site,
  };
}

function sanitizeHost(input) {
  return String(input || '').replace(/[\\/:*?"<>|\r\n]/g, '_');
}

function wikiIdFromOrigin(origin) {
  try {
    return sanitizeHost(new URL(normalizeOrigin(origin)).host).toLowerCase();
  } catch {
    return sanitizeHost(origin).toLowerCase();
  }
}

module.exports = {
  buildParserConfig,
  fetchSiteInfo,
  normalizeOrigin,
  normalizeWikiKey,
  sanitizeHost,
  wikiIdFromOrigin,
};
