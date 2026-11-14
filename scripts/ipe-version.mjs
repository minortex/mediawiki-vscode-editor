import {execFileSync} from 'node:child_process'

function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}


/**
 * Version of the in-page plugin, derived from git:
 * - HEAD carries an `ipe-v*` tag: that tag's semver (`ipe-v0.9.13` -> `0.9.13`)
 * - otherwise: `<nearest reachable ipe-v tag version>-dev.r<commits since that
 *   tag>.<short sha>` (`IPE_DEV=1` forces the dev form even on a tagged HEAD)
 *
 * Both the prefix and the run count come from the same reachable tag, so a
 * newer tag on another branch can never label this development line.
 */
export function ipeVersion() {
  if (process.env.IPE_DEV !== '1') {
    const tag = git(['describe', '--tags', '--exact-match', '--match', 'ipe-v*', 'HEAD'])
    if (tag) return tag.replace(/^ipe-v/, '')
  }
  const sha = git(['rev-parse', '--short=8', 'HEAD']) || 'local'
  const tag = git(['describe', '--tags', '--abbrev=0', '--match', 'ipe-v[0-9]*', 'HEAD'])
  const base = tag.replace(/^ipe-v/, '')
  const run = git(['rev-list', '--count', tag ? `${tag}..HEAD` : 'HEAD']) || '0'
  return `${parseVersion(base) ? base : '0.0.0'}-dev.r${run}.${sha}`
}
