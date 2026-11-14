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
  /** Ask VSCode to re-query while the user keeps typing. */
  incomplete?: boolean;
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
      label: `H${level} heading`,
      body: `${marker} \${1:Heading} ${marker}`,
      detail: `${marker} Heading ${marker}`,
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
    body: `${marker}\${1:text}${marker}`,
    detail: `${marker}text${marker}`,
    filterText: match[0],
    preselect,
  });
  if (run === 1) {
    return {
      id: 'quote-single',
      start,
      end: character,
      items: [
        make('Bold', "'''", true),
        make('Italic', "''"),
        make('Bold italic', "'''''"),
      ],
    };
  }
  if (run === 2) {
    return {id: 'quote-italic', start, end: character, items: [make('Italic', "''", true)]};
  }
  if (run === 3) {
    return {id: 'quote-bold', start, end: character, items: [make('Bold', "'''", true)]};
  }
  if (run === 5) {
    return {id: 'quote-both', start, end: character, items: [make('Bold italic', "'''''", true)]};
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
        label: 'Signature',
        body: '~~~~',
        detail: 'Username + time',
        filterText: match[0],
        preselect: true,
      },
      {
        label: 'Time only',
        body: '~~~~~',
        detail: 'Timestamp only',
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
        label: 'Redirect',
        body: `${text} [[\${1:Page name}]]`,
        detail: 'Redirect to the target page',
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
  const start = prefix.lastIndexOf('<');
  if (start === -1) return undefined;
  const match = /^<([A-Za-z][\w-]*)?$/u.exec(prefix.slice(start));
  if (!match) return undefined;
  const name = match[1];
  const lower = (name ?? '').toLowerCase();
  const generic = (tagName: string): SnippetItem =>
    voidTags.has(tagName)
      ? {
          label: `<${tagName}/>`,
          body: `<${tagName}/>`,
          detail: 'Self-closing tag',
          filterText: `<${tagName}`,
        }
      : {
          label: `<${tagName}>…</${tagName}>`,
          body: `<${tagName}>\${1}</${tagName}>`,
          detail: 'Paired tag',
          filterText: `<${tagName}`,
        };
  if (lower && (tags.has(lower) || voidTags.has(lower))) {
    const display = name ?? lower;
    const filterText = `<${lower}`;
    const items: SnippetItem[] = [];
    const pair = (body: string, label: string, detail: string, preselect = false): void => {
      items.push({label, body, detail, filterText, preselect});
    };
    if (lower === 'ref') {
      pair(
        `<${display} name="\${1:name}">\${2:content}</${display}>`,
        `<${display} name="…">…</${display}>`,
        'Named reference',
        true,
      );
      pair(
        `<${display} name="\${1:name}"/>`,
        `<${display} name="…"/>`,
        'Reuse an existing reference',
      );
    } else if (lower === 'references') {
      pair(`<${display}/>`, `<${display}/>`, 'Reference list', true);
      pair(
        `<${display}>\${1:content}</${display}>`,
        `<${display}>…</${display}>`,
        'Custom reference list',
      );
    } else {
      items.push({...generic(display), preselect: true});
    }
    return {id: 'tag', start, end: character, items};
  }
  const names = [...new Set([...tags, ...voidTags])]
    .filter(tagName => tagName.startsWith(lower))
    .sort();
  if (names.length === 0) return undefined;
  return {
    id: 'tag',
    start,
    end: character,
    items: names.map(generic),
    incomplete: true,
  };
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
    'Template parameter',
    '{{{parameter}}}',
    `{{{\${1:parameter}}}}}`,
  );
  if (argument) return argument;

  const template = opener(
    prefix,
    character,
    afterText,
    'template',
    '{{',
    '}}',
    'Template',
    '{{Template}}',
    `{{\${1:Template}}}`,
  );
  if (template) return template;

  const link = opener(
    prefix,
    character,
    afterText,
    'link',
    '[[',
    ']]',
    'Internal link',
    '[[Page name]]',
    `[[\${1:Page name}]]`,
  );
  if (link) return link;

  const comment = opener(
    prefix,
    character,
    afterText,
    'comment',
    '<!--',
    '-->',
    'Comment',
    '<!-- comment -->',
    `<!-- \${1:comment} -->`,
  );
  if (comment) return comment;

  const variant = opener(
    prefix,
    character,
    afterText,
    'variant',
    '-{',
    '}-',
    'Language variant',
    '-{text}-',
    `-{\${1:text}}-`,
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
          label: 'Table',
          body: '{| ${1:class="wikitable"}\n|+ ${2:Caption}\n|-\n! ${3:Header}\n| ${4:Content}\n|}',
          detail: 'Standard wikitable skeleton',
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
          label: 'Divider',
          body: '----',
          detail: 'Horizontal rule',
          filterText: '----',
          preselect: true,
        },
      ],
    };
  }

  return undefined;
}
