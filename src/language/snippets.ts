/** Structural wikitext snippets. Pure functions so they can be tested without VSCode. */

export interface SnippetItem {
  label: string;
  body: string;
  detail?: string;
  documentation?: string;
  filterText?: string;
  sortText?: string;
  preselect?: boolean;
}

export interface SnippetContext {
  id: string;
  /** Replacement range on the current line, in UTF-16 code units. */
  start: number;
  end: number;
  items: SnippetItem[];
}

export interface SnippetEnvironment {
  /** Tags that accept a matching closing tag. */
  tags?: readonly string[];
  /** Self-closing tags. */
  voidTags?: readonly string[];
  /** Localized #REDIRECT words, including the leading `#`. */
  redirection?: readonly string[];
}

const DEFAULT_REDIRECTION = ['#redirect', '#重定向'];
const DEFAULT_TAGS = [
  'ref',
  'references',
  'nowiki',
  'pre',
  'syntaxhighlight',
  'math',
  'gallery',
  'div',
  'span',
  'code',
  'blockquote',
];
const DEFAULT_VOID_TAGS = ['references', 'br', 'wbr', 'hr', 'meta', 'link'];

function heading(prefix: string, character: number): SnippetContext | undefined {
  const match = /^([ \t]*)(=+)([ \t]*)$/u.exec(prefix);
  if (!match) return undefined;
  const typed = match[2].length;
  if (typed > 6) return undefined;
  const start = match[1].length;
  const items: SnippetItem[] = [];
  for (let level = 1; level <= 6; level++) {
    const marker = '='.repeat(level);
    items.push({
      label: `H${level} 标题`,
      body: `${marker} \${1:标题} ${marker}`,
      detail: `${marker} 标题 ${marker}`,
      filterText: marker,
      sortText: `${Math.abs(level - typed)}${level}`,
      preselect: level === typed,
    });
  }
  return {id: 'heading', start, end: character, items};
}

function quotes(prefix: string, character: number): SnippetContext | undefined {
  const match = /(?<!')'{1,5}$/u.exec(prefix);
  if (!match) return undefined;
  const run = match[0].length;
  const start = character - run;
  const make = (label: string, marker: string, preselect = false): SnippetItem => ({
    label,
    body: `${marker}\${1:文字}${marker}`,
    detail: `${marker}文字${marker}`,
    filterText: match[0],
    preselect,
  });
  if (run === 1) {
    return {
      id: 'quote-single',
      start,
      end: character,
      items: [
        make('粗体', "'''", true),
        make('斜体', "''"),
        make('粗斜体', "'''''"),
      ],
    };
  }
  if (run === 2) {
    return {id: 'quote-italic', start, end: character, items: [make('斜体', "''", true)]};
  }
  if (run === 3) {
    return {id: 'quote-bold', start, end: character, items: [make('粗体', "'''", true)]};
  }
  if (run === 5) {
    return {id: 'quote-both', start, end: character, items: [make('粗斜体', "'''''", true)]};
  }
  return undefined;
}

function signature(prefix: string, character: number): SnippetContext | undefined {
  const match = /(?<!~)~{3,5}$/u.exec(prefix);
  if (!match || match[0].length === 5) return undefined;
  const start = character - match[0].length;
  return {
    id: 'signature',
    start,
    end: character,
    items: [
      {
        label: '签名',
        body: '~~~~',
        detail: '用户名 + 时间',
        filterText: match[0],
        preselect: true,
      },
      {
        label: '仅时间',
        body: '~~~~~',
        detail: '仅时间戳',
        filterText: match[0],
      },
    ],
  };
}

function redirect(
  prefix: string,
  character: number,
  redirection: readonly string[],
): SnippetContext | undefined {
  const indentation = /^[ \t]*/u.exec(prefix)![0].length;
  const text = prefix.slice(indentation).trim();
  if (!text || !redirection.some(word => word.toLowerCase() === text.toLowerCase())) {
    return undefined;
  }
  return {
    id: 'redirect',
    start: indentation,
    end: character,
    items: [
      {
        label: '重定向',
        body: `${text} [[\${1:页面名}]]`,
        detail: '重定向到目标页面',
        filterText: text,
        preselect: true,
      },
    ],
  };
}

function tag(
  prefix: string,
  character: number,
  tags: Set<string>,
  voidTags: Set<string>,
): SnippetContext | undefined {
  const match = /<([A-Za-z][\w-]*)$/u.exec(prefix);
  if (!match) return undefined;
  const name = match[1];
  const lower = name.toLowerCase();
  if (!tags.has(lower) && !voidTags.has(lower)) return undefined;
  const start = character - match[0].length;
  const items: SnippetItem[] = [];
  const pair = (body: string, label: string, detail: string, preselect = false): void => {
    items.push({
      label,
      body,
      detail,
      filterText: match[0],
      preselect,
    });
  };
  if (lower === 'ref') {
    pair(
      `<ref name="\${1:名称}">\${2:内容}</ref>`,
      '<ref name="…">…</ref>',
      '带名称的引用',
      true,
    );
    pair(`<ref name="\${1:名称}"/>`, '<ref name="…"/>', '复用已有引用');
  } else if (lower === 'references') {
    pair('<references/>', '<references/>', '引用列表', true);
    pair('<references>${1:内容}</references>', '<references>…</references>', '自定义引用列表');
  } else if (voidTags.has(lower)) {
    pair(`<${name}/>`, `<${name}/>`, '自闭合标签', true);
  } else {
    pair(`<${name}>\${1:内容}</${name}>`, `<${name}>…</${name}>`, '成对标签', true);
  }
  return {id: 'tag', start, end: character, items};
}

function opener(
  prefix: string,
  character: number,
  afterText: string,
  id: string,
  marker: string,
  closer: string,
  label: string,
  detail: string,
  body: string,
): SnippetContext | undefined {
  if (!prefix.endsWith(marker) || afterText.startsWith(closer)) return undefined;
  return {
    id,
    start: character - marker.length,
    end: character,
    items: [
      {
        label,
        body,
        detail,
        filterText: marker,
        preselect: true,
      },
    ],
  };
}

export function snippetsAt(
  lineText: string,
  character: number,
  afterText: string,
  env: SnippetEnvironment = {},
): SnippetContext | undefined {
  const prefix = lineText.slice(0, character);

  const quote = quotes(prefix, character);
  if (quote) return quote;

  const head = heading(prefix, character);
  if (head) return head;

  const sig = signature(prefix, character);
  if (sig) return sig;

  const redirection = env.redirection?.length ? env.redirection : DEFAULT_REDIRECTION;
  const redirectMatch = redirect(prefix, character, redirection);
  if (redirectMatch) return redirectMatch;

  const tags = new Set(
    (env.tags?.length ? env.tags : DEFAULT_TAGS).map(value => value.toLowerCase()),
  );
  const voidTags = new Set(
    (env.voidTags?.length ? env.voidTags : DEFAULT_VOID_TAGS).map(value =>
      value.toLowerCase(),
    ),
  );
  for (const name of DEFAULT_VOID_TAGS) voidTags.add(name);
  const tagMatch = tag(prefix, character, tags, voidTags);
  if (tagMatch) return tagMatch;

  const argument = opener(
    prefix,
    character,
    afterText,
    'argument',
    '{{{',
    '}}}',
    '模板参数',
    '{{{参数名}}}',
    `{{{\${1:参数名}}}}}`,
  );
  if (argument) return argument;

  const template = opener(
    prefix,
    character,
    afterText,
    'template',
    '{{',
    '}}',
    '模板',
    '{{模板名}}',
    `{{\${1:模板名}}}`,
  );
  if (template) return template;

  const link = opener(
    prefix,
    character,
    afterText,
    'link',
    '[[',
    ']]',
    '内链',
    '[[页面名]]',
    `[[\${1:页面名}]]`,
  );
  if (link) return link;

  const comment = opener(
    prefix,
    character,
    afterText,
    'comment',
    '<!--',
    '-->',
    '注释',
    '<!-- 注释 -->',
    `<!-- \${1:注释} -->`,
  );
  if (comment) return comment;

  const variant = opener(
    prefix,
    character,
    afterText,
    'variant',
    '-{',
    '}-',
    '语言变体',
    '-{文本}-',
    `-{\${1:文本}}-`,
  );
  if (variant) return variant;

  const table = /^([ \t]*)\{\|[ \t]*$/u.exec(prefix);
  if (table && !afterText.startsWith('|}')) {
    return {
      id: 'table',
      start: table[1].length,
      end: character,
      items: [
        {
          label: '表格',
          body: '{| ${1:class="wikitable"}\n|+ ${2:标题}\n|-\n! ${3:表头}\n| ${4:内容}\n|}',
          detail: '标准 wikitable 骨架',
          filterText: '{|',
          preselect: true,
        },
      ],
    };
  }

  const hr = /^([ \t]*)-{3,}$/u.exec(prefix);
  if (hr) {
    return {
      id: 'hr',
      start: hr[1].length,
      end: character,
      items: [
        {
          label: '分隔线',
          body: '----',
          detail: '水平分隔线',
          filterText: '----',
          preselect: true,
        },
      ],
    };
  }

  return undefined;
}
