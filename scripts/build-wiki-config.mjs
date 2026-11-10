// 生成指定站点的解析配置：只读站点 API 的 siteinfo，不执行站点下发的脚本。
// 用法：node scripts/build-wiki-config.mjs <站点URL> [输出路径]
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {buildParserConfig, fetchSiteInfo} = require('../lib/wiki-config.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = process.argv[2];
if (!site) {
  console.error('用法：node scripts/build-wiki-config.mjs <站点URL> [输出路径]');
  process.exit(1);
}
const output = path.resolve(process.argv[3] || path.join(root, 'config', 'site.json'));

const {origin, api, query} = await fetchSiteInfo(site);
const config = buildParserConfig(query, origin);
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, `${JSON.stringify(config, null, '\t')}\n`);
console.log(`wrote ${output} (${api})`);
console.log(
  `namespaces=${Object.keys(config.namespaces).length} ` +
  `parserFunctions=${Object.keys(config.parserFunction[0]).length + Object.keys(config.parserFunction[1]).length} ` +
  `hooks=${config.functionHook.length} variables=${config.variable.length}`
);
