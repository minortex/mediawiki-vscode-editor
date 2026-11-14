/** MediaWiki globals and IPE helpers. `mw`/`jQuery` are site globals, so they
 * are declared on `Window` instead of casting a `BrowserWindow` shape. */

interface MwConfig {
  get<T = unknown>(key: string): T | undefined
}

interface MwUtil {
  wikiScript(script: string): string
  getUrl(title: string): string
}

interface MwHook {
  fire(...args: unknown[]): void
}

interface MwHookFactory {
  (name: string): MwHook
}

export interface MediaWiki {
  config?: MwConfig
  util?: MwUtil
  hook?: MwHookFactory
}

declare global {
  interface Window {
    mw?: MediaWiki
    jQuery?: (root: Element) => unknown
  }
}

export const getMw = (): MediaWiki | undefined => window.mw

export const getMwConfig = <T = unknown>(key: string): T | undefined =>
  getMw()?.config?.get<T>(key)

export const getMwUtil = (): MwUtil | undefined => getMw()?.util

export const getJQuery = (): ((root: Element) => unknown) | undefined => window.jQuery

export function apiUrl(): string {
  const util = getMwUtil()
  return util?.wikiScript ? util.wikiScript('api') : new URL('/api.php', location.origin).href
}
