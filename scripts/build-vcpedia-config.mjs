// 生成 config/vcpedia.json：只读站点 API 的 siteinfo，不执行站点下发的脚本。
// 用法：node scripts/build-vcpedia-config.mjs [站点URL] [输出路径]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = (process.argv[2] || 'https://vcpedia.cn').replace(/\/+$/u, '');
const output = path.resolve(process.argv[3] || path.join(root, 'config', 'vcpedia.json'));
const base = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'wikiparser-node', 'config', 'zhwiki.json'), 'utf8'));

const params = {
  action: 'query',
  meta: 'siteinfo',
  siprop: 'general|namespaces|namespacealiases|magicwords|functionhooks|extensiontags|variables|interwikimap',
  format: 'json',
  formatversion: '2',
};
const response = await fetch(`${site}/api.php?${new URLSearchParams(params)}`, {
  headers: {'User-Agent': 'mediawiki-vscode-editor/config-builder (local development)'},
});
if (!response.ok) throw new Error(`siteinfo HTTP ${response.status}`);
const {query, error} = await response.json();
if (error) throw new Error(`siteinfo error: ${error.code}: ${error.info}`);

const {general, namespaces, namespacealiases, magicwords, functionhooks, extensiontags, variables, interwikimap} = query;
const lower = (s) => s.toLowerCase();
const uniq = (items) => [...new Set(items)];

// 命名空间：本地名 + canonical 名，后者用于 [[Project:...]] 这类英文写法。
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

// 以上游 zhwiki 配置为语义基准（它已经区分了 `#if` 与 `ns` 两种写法），
// 只把本站的别名与新增函数合并进来，避免把 R/bcp47 这类选项词误当成解析函数。
const insensitive = {...base.parserFunction[0]};
const sensitive = {...base.parserFunction[1], '=': '='};
const functionHook = new Set([...base.functionHook, ...functionhooks.map(lower), 'msgnw']);
// MediaWiki 的 functionhooks 列表同时包含 `{{ns:}}` 这类冒号钩子和 `{{#if:}}`
// 这类解析函数；`#` 写法不能仅靠别名推断，这里补充常见解析函数。
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
    if (/^[^#＃].*：$/u.test(alias)) continue; // 与上游 cleanAliases 一致
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

const articlePath = new URL(general.articlepath, site).href;
const config = {
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

fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, `${JSON.stringify(config, null, '\t')}\n`);
console.log(`wrote ${output}`);
console.log(`namespaces=${Object.keys(config.namespaces).length} parserFunctions=${Object.keys(insensitive).length + Object.keys(sensitive).length} hooks=${config.functionHook.length} variables=${config.variable.length}`);
