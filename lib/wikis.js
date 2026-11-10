'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const {
  buildParserConfig,
  fetchSiteInfo,
  normalizeOrigin,
  normalizeWikiKey,
  sanitizeHost,
  wikiIdFromOrigin,
} = require('./wiki-config');

const STATE_KEY = 'mediawikiEditor.wikis';
const BUILTIN = {
  id: 'vcpedia',
  name: 'VCPedia',
  url: 'https://vcpedia.cn',
  origin: 'https://vcpedia.cn',
  host: 'vcpedia.cn',
  api: 'https://vcpedia.cn/api.php',
  articlePath: 'https://vcpedia.cn/$1',
  configPath: '',
  builtin: true,
};

function builtin() {
  return {...BUILTIN};
}

function custom(context) {
  return context.globalState.get(STATE_KEY, []).filter((wiki) => wiki && !wiki.builtin);
}

function saveCustom(context, wikis) {
  context.globalState.update(STATE_KEY, wikis.filter((wiki) => wiki && !wiki.builtin));
}

function all(context) {
  return [builtin(), ...custom(context)];
}

function normalizeHint(hint) {
  return String(hint || '').trim().replace(/\/+$/u, '').toLowerCase();
}

function find(context, hint) {
  const raw = normalizeHint(hint);
  if (!raw) return undefined;
  for (const wiki of all(context)) {
    if ([wiki.id, wiki.origin, wiki.url, wiki.host].filter(Boolean).some((value) => normalizeHint(value) === raw)) {
      return wiki;
    }
  }
  try {
    const origin = normalizeOrigin(raw);
    return all(context).find((wiki) => normalizeHint(wiki.origin) === normalizeHint(origin));
  } catch {
    return undefined;
  }
}

function resolve(context, hint, fallbackOrigin) {
  if (hint) return find(context, hint) || find(context, fallbackOrigin);
  if (fallbackOrigin) return find(context, fallbackOrigin);
  return builtin();
}

function directoryFor(root, wiki) {
  const host = wiki.host || (() => {
    try {
      return new URL(wiki.url).host;
    } catch {
      return wiki.id;
    }
  })();
  return path.join(root, sanitizeHost(host));
}

function configFile(context, id) {
  return path.join(context.globalStorageUri.fsPath, 'wikis', `${id}.json`);
}

async function promptAdd(context) {
  const name = await vscode.window.showInputBox({
    prompt: 'Wiki 名称（可留空，使用站点主机名）',
    placeHolder: '例如 VCPedia',
  });
  if (name === undefined) return undefined;
  const address = await vscode.window.showInputBox({
    prompt: '站点地址（会自动探测 API 路径并生成解析配置）',
    placeHolder: 'https://vcpedia.cn',
    validateInput(value) {
      try {
        normalizeOrigin(value);
        return undefined;
      } catch (error) {
        return error.message;
      }
    },
  });
  if (address === undefined) return undefined;

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'MediaWiki: 正在读取站点信息…',
      cancellable: false,
    },
    async () => {
      try {
        const {origin, api, query} = await fetchSiteInfo(address);
        const config = buildParserConfig(query, origin);
        const id = wikiIdFromOrigin(origin);
        const host = new URL(origin).host;
        const file = configFile(context, id);
        await fs.promises.mkdir(path.dirname(file), {recursive: true});
        await fs.promises.writeFile(file, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
        const entry = {
          id,
          name: String(name || '').trim() || host,
          url: origin,
          origin,
          host,
          api,
          articlePath: config.articlePath,
          configPath: file,
          builtin: false,
        };
        const wikis = custom(context).filter((wiki) => wiki.id !== id);
        wikis.push(entry);
        await saveCustom(context, wikis);
        vscode.window.showInformationMessage(
          `MediaWiki: 已添加 ${entry.name}（${origin}），配置文件 ${file}`
        );
        return entry;
      } catch (error) {
        vscode.window.showErrorMessage(`MediaWiki: 添加 wiki 失败：${error.message}`);
        return undefined;
      }
    }
  );
}

async function promptRemove(context) {
  const wikis = custom(context);
  if (!wikis.length) {
    vscode.window.showInformationMessage('MediaWiki: 没有可删除的自定义 wiki。');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    wikis.map((wiki) => ({label: wiki.name, description: `${wiki.origin}`, wiki})),
    {placeHolder: '选择要删除的 wiki'}
  );
  if (!picked) return;
  const confirm = await vscode.window.showWarningMessage(
    `MediaWiki: 删除 ${picked.wiki.name}？已生成的解析配置也会删除。`,
    {modal: true},
    '删除'
  );
  if (confirm !== '删除') return;
  const wikisLeft = custom(context).filter((wiki) => wiki.id !== picked.wiki.id);
  await saveCustom(context, wikisLeft);
  if (picked.wiki.configPath) {
    try {
      await fs.promises.unlink(picked.wiki.configPath);
    } catch {}
  }
  vscode.window.showInformationMessage(`MediaWiki: 已删除 ${picked.wiki.name}`);
}

async function showList(context) {
  const items = all(context).map((wiki) => ({
    label: wiki.name,
    description: wiki.origin,
    detail: wiki.builtin
      ? '内置，使用扩展自带配置'
      : `配置：${wiki.configPath || '（默认）'}`,
    wiki,
  }));
  await vscode.window.showQuickPick(items, {
    placeHolder: '已注册的 wiki（Esc 关闭）',
    canPickMany: false,
  });
}

function register(context) {
  return [
    vscode.commands.registerCommand('mediawikiEditor.addWiki', () => promptAdd(context)),
    vscode.commands.registerCommand('mediawikiEditor.removeWiki', () => promptRemove(context)),
    vscode.commands.registerCommand('mediawikiEditor.listWikis', () => showList(context)),
  ];
}

module.exports = {
  all,
  builtin,
  configFile,
  custom,
  directoryFor,
  find,
  register,
  resolve,
  saveCustom,
};
