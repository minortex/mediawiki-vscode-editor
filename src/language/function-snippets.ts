import fs from 'node:fs';
import {createRequire} from 'node:module';
import type {Config} from 'wikiparser-node';

interface SignatureParameter {
  label: string;
  const?: boolean;
  rest?: boolean;
}

interface SignatureInfo {
  aliases: string[];
  description: string;
  signatures?: SignatureParameter[][];
}

interface SignatureData {
  parserFunctions: SignatureInfo[];
}

const localRequire = createRequire(__filename);
let signatureIndex: Map<string, SignatureInfo> | undefined;

function parserFunctions(): Map<string, SignatureInfo> {
  if (signatureIndex) return signatureIndex;
  const file = localRequire.resolve('wikiparser-node/data/signatures.json');
  // The file is shipped by wikiparser-node; its shape is part of that package.
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as SignatureData;
  signatureIndex = new Map();
  for (const info of data.parserFunctions) {
    for (const alias of info.aliases) {
      signatureIndex.set(alias.replace(/^#/u, '').toLowerCase(), info);
    }
  }
  return signatureIndex;
}

/**
 * Build a snippet body for a parser function completion item.
 *
 * The caller replaces the typed function name with the returned text. The
 * closing braces are intentionally omitted: they are either auto-closed or
 * already present in the document.
 */
export function functionSnippet(
  label: string,
  config: Pick<Config, 'parserFunction'>,
  colon: ':' | '：' = ':',
): string | undefined {
  const canonical =
    config.parserFunction[0][label] ??
    config.parserFunction[1][label] ??
    label.replace(/^#/u, '');
  const info = parserFunctions().get(canonical.toLowerCase());
  const signature = info?.signatures?.[0];
  if (!signature || signature.length === 0) return undefined;
  const head = /[:：]$/u.test(label) ? label : label + colon;
  if (canonical.toLowerCase() === 'switch') {
    return `${head}\${1:${signature[0].label}}\n|\${2:case}=\${3:result}\n|#default=\${4:default}\n`;
  }
  const params = signature.map(
    (parameter, index) => `\${${index + 1}:${parameter.label}}`,
  );
  return head + params.join('|');
}
