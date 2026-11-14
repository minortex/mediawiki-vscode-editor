import type {
  EditResult,
  ParseResponse,
  RevisionInfo,
  RevisionQueryResponse,
  SiteInfoResponse,
} from './types'

export interface ApiOptions {
  apiUrl: string
  translate(message: string, ...args: string[]): string
}

/** Thin wrapper over the wiki API used by the editing session. */
export interface Api {
  request<T = ParseResponse>(params: Record<string, string>): Promise<T>
  queryRevision(by: {revid?: number; title?: string}): Promise<RevisionInfo | undefined>
  readEditResult(value: unknown): EditResult
  savedRevid(
    title: string,
    text: string,
    edit: EditResult,
    baseRevid: number | undefined,
  ): Promise<number | undefined>
  fetchSiteInfo(): Promise<unknown>
}

export function createApi({apiUrl, translate}: ApiOptions): Api {
  function request<T = ParseResponse>(params: Record<string, string>): Promise<T> {
    return fetch(apiUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams(Object.assign({format: 'json', formatversion: '2'}, params)),
    }).then(response => response.json() as Promise<T>)
  }

  /** Fetch a single revision (by id) or the latest one (by title). */
  async function queryRevision(
    by: {revid?: number; title?: string},
  ): Promise<RevisionInfo | undefined> {
    const params: Record<string, string> = {
      action: 'query',
      prop: 'revisions',
      rvprop: 'ids|content',
      rvslots: 'main',
    }
    if (by.revid !== undefined) {
      params.revids = String(by.revid)
    } else if (by.title !== undefined) {
      params.titles = by.title
      params.rvlimit = '1'
    } else {
      return undefined
    }
    const data = await request<RevisionQueryResponse>(params)
    if (data.error) {
      throw new Error(`${data.error.code || 'error'}: ${data.error.info || ''}`)
    }
    const revision = data.query?.pages?.[0]?.revisions?.[0]
    if (!revision || typeof revision.revid !== 'number') return undefined
    return {
      revid: revision.revid,
      parentid: revision.parentid,
      content: revision.content ?? revision.slots?.main?.content,
    }
  }

  /**
   * `newrevid` is part of the API response but missing from the library
   * typings, so narrow the payload field by field instead of asserting.
   */
  function readEditResult(value: unknown): EditResult {
    const edit: EditResult = {}
    if (!value || typeof value !== 'object') return edit
    if ('newrevid' in value) {
      const revid = value.newrevid
      if (typeof revid === 'number' && Number.isInteger(revid) && revid > 0) {
        edit.newrevid = revid
      }
    }
    if ('nochange' in value) edit.nochange = value.nochange === true
    return edit
  }

  /**
   * Cleanup of the temp file must be tied to a revision id that exists on the
   * wiki. The id reported by the edit call is the proof that this submit was
   * stored; when the edit reports no new revision, only accept the latest
   * revision if it already holds exactly the submitted text.
   */
  async function savedRevid(
    title: string,
    text: string,
    edit: EditResult,
    baseRevid: number | undefined,
  ): Promise<number | undefined> {
    const newrevid = edit.newrevid
    if (newrevid !== undefined && newrevid !== baseRevid) {
      try {
        const revision = await queryRevision({revid: newrevid})
        if (revision?.revid === newrevid) return newrevid
      } catch {}
    }
    if (edit.nochange) {
      try {
        const latest = await queryRevision({title})
        if (latest && latest.content === text) return latest.revid
      } catch {}
    }
    return undefined
  }

  function fetchSiteInfo(): Promise<unknown> {
    const params = new URLSearchParams({
      action: 'query',
      meta: 'siteinfo',
      siprop: 'general|namespaces|namespacealiases|magicwords|functionhooks|extensiontags|variables|interwikimap',
      format: 'json',
      formatversion: '2',
    })
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? window.setTimeout(() => controller.abort(), 20000) : undefined
    return fetch(`${apiUrl}?${params}`, {
      credentials: 'include',
      signal: controller?.signal,
    })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<SiteInfoResponse>
      })
      .then(data => {
        if (data.error) throw new Error(`${data.error.code}: ${data.error.info}`)
        if (!data.query) throw new Error(translate('The site did not return siteinfo'))
        return data.query
      })
      .finally(() => {
        clearTimeout(timer)
      })
  }

  return {request, queryRevision, readEditResult, savedRevid, fetchSiteInfo}
}
