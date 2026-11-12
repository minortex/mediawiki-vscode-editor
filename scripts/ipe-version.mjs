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

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function latestTagVersion() {
  const versions = git(['tag', '-l', 'ipe-v[0-9]*'])
    .split('\n')
    .map(tag => tag.replace(/^ipe-v/, ''))
    .filter(text => parseVersion(text))
    .sort((a, b) => compareVersions(parseVersion(a), parseVersion(b)))
  return versions.at(-1) || ''
}


/**
 * Version of the in-page plugin, derived from git:
 * - HEAD carries an `ipe-v*` tag: that tag's semver (`ipe-v0.9.13` -> `0.9.13`)
 * - otherwise: `<newest ipe-v tag version>-dev.r<commits since the previous
 *   reachable ipe-v tag>.<short sha>` (`IPE_DEV=1` forces the dev form even on
 *   a tagged HEAD)
 */
export function ipeVersion() {
  if (process.env.IPE_DEV !== '1') {
    const tag = git(['describe', '--tags', '--exact-match', '--match', 'ipe-v*', 'HEAD'])
    if (tag) return tag.replace(/^ipe-v/, '')
  }
  const sha = git(['rev-parse', '--short=8', 'HEAD']) || 'local'
  const base = git(['describe', '--tags', '--abbrev=0', '--match', 'ipe-v[0-9]*', 'HEAD'])
  const run = git(['rev-list', '--count', base ? `${base}..HEAD` : 'HEAD']) || '0'
  return `${latestTagVersion() || '0.0.0'}-dev.r${run}.${sha}`
}
