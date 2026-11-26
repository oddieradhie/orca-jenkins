import type { Disposable, JsonValue, OrcaWorkerApi, Tone } from 'orca/worker'
import type {
  JenkinsActiveBuild,
  JenkinsBuildSummary,
  JenkinsConfigSummary,
  JenkinsConsoleLog,
  JenkinsDashboardData,
  JenkinsExecutorSummary,
  JenkinsJob,
  JenkinsJobDetail,
  JenkinsJobStatus,
  JenkinsParameterDef,
  JenkinsQueueItem
} from './protocol'
import './protocol'

export const CURRENT_VERSION = '1.0.1'
const CACHE_KEY = 'cachedDashboard'
const CONFIG_STORAGE_KEY = 'jenkinsConfig'
const FAVORITES_STORAGE_KEY = 'jenkinsFavorites'
const SECRET_TOKEN_KEY = 'apiToken'
const DEFAULT_POLL_INTERVAL_SEC = 30
const MIN_POLL_INTERVAL_SEC = 10
const MAX_POLL_INTERVAL_SEC = 3600
const REQUEST_TIMEOUT_MS = 12000

type JenkinsConfig = {
  jenkinsUrl: string
  username: string
  apiToken: string
  pollIntervalSec: number
  viewName: string
}

type RawJenkinsBuild = {
  number?: number
  result?: string | null
  building?: boolean
  timestamp?: number
  duration?: number
  estimatedDuration?: number
  url?: string
  displayName?: string
  actions?: Array<{
    causes?: Array<{ shortDescription?: string }>
  }>
}

type RawJenkinsJob = {
  name?: string
  fullName?: string
  url?: string
  color?: string
  buildable?: boolean
  inQueue?: boolean
  healthReport?: Array<{ score?: number }>
  lastBuild?: RawJenkinsBuild | null
  jobs?: RawJenkinsJob[]
}

type RawJenkinsQueueItem = {
  id?: number
  why?: string
  stuck?: boolean
  blocked?: boolean
  buildable?: boolean
  inQueueSince?: number
  url?: string
  task?: { name?: string; fullName?: string; url?: string; nextBuildNumber?: number }
  executable?: { number?: number }
}

type RawJenkinsParameterDef = {
  name?: string
  type?: string
  description?: string
  defaultParameterValue?: { value?: unknown }
  choices?: string[]
}

let startupTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let activeAbort: AbortController | null = null
let currentPollSec = DEFAULT_POLL_INTERVAL_SEC
let suppressSettingsReload = false
let isDeactivated = false
let hasCompletedInitialPoll = false
const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
const previousBuildStates = new Map<string, { number: number; building: boolean; result: string | null }>()
const disposables: Disposable[] = []

function scheduleTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(() => {
    pendingTimers.delete(t)
    if (!isDeactivated) fn()
  }, ms)
  pendingTimers.add(t)
  return t
}

function cleanJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err)
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function clampPollInterval(sec: unknown): number {
  const num = typeof sec === 'number' ? sec : Number(sec)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_POLL_INTERVAL_SEC
  return Math.max(MIN_POLL_INTERVAL_SEC, Math.min(MAX_POLL_INTERVAL_SEC, Math.round(num)))
}

function maskToken(token: string): string {
  if (!token) return ''
  if (token.length <= 10) return '••••••••'
  return `${token.slice(0, 4)}••••${token.slice(-4)}`
}

function encodeBasicAuth(username: string, token: string): string {
  const raw = `${username}:${token}`
  if (typeof btoa === 'function') {
    const bytes = new TextEncoder().encode(raw)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i] ?? 0)
    }
    return `Basic ${btoa(binary)}`
  }
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
}

export function jobApiPath(fullName: string): string {
  const parts = fullName
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return ''
  return parts.map((p) => `/job/${encodeURIComponent(p)}`).join('')
}

export function mapJobStatus(color: string | undefined, building: boolean | undefined): JenkinsJobStatus {
  const c = (color ?? '').toLowerCase()
  if (building || c.endsWith('_anime')) return 'building'
  if (c === 'blue') return 'success'
  if (c === 'red') return 'failed'
  if (c === 'yellow') return 'unstable'
  if (c === 'aborted') return 'aborted'
  if (c === 'disabled') return 'disabled'
  return 'not_built'
}

function normalizeBuild(raw: RawJenkinsBuild): JenkinsBuildSummary {
  let cause: string | undefined
  if (Array.isArray(raw.actions)) {
    for (const action of raw.actions) {
      if (Array.isArray(action?.causes) && action.causes.length > 0) {
        const desc = action.causes[0]?.shortDescription
        if (typeof desc === 'string' && desc.trim()) {
          cause = desc.trim()
          break
        }
      }
    }
  }

  return {
    number: Number(raw.number ?? 0),
    result: raw.result ?? null,
    building: Boolean(raw.building),
    timestamp: Number(raw.timestamp ?? 0),
    duration: Number(raw.duration ?? 0),
    ...(typeof raw.estimatedDuration === 'number' ? { estimatedDuration: raw.estimatedDuration } : {}),
    url: String(raw.url ?? ''),
    ...(typeof raw.displayName === 'string' && raw.displayName ? { displayName: raw.displayName } : {}),
    ...(cause ? { cause } : {})
  }
}

export function flattenJobs(
  rawJobs: RawJenkinsJob[],
  favorites: Set<string>,
  parentPath = ''
): JenkinsJob[] {
  const result: JenkinsJob[] = []
  for (const item of rawJobs) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.name ?? '')
    const fullName = String(item.fullName ?? (parentPath ? `${parentPath}/${name}` : name))

    if (Array.isArray(item.jobs) && item.jobs.length > 0 && !item.color) {
      result.push(...flattenJobs(item.jobs, favorites, fullName))
      continue
    }

    if (Array.isArray(item.jobs) && !item.color) {
      // Empty folder
      continue
    }

    const lastBuild = item.lastBuild ? normalizeBuild(item.lastBuild) : null
    const building = Boolean(lastBuild?.building || (item.color ?? '').endsWith('_anime'))
    const status = mapJobStatus(item.color, building)
    const slashIdx = fullName.lastIndexOf('/')
    const folder = slashIdx > 0 ? fullName.slice(0, slashIdx) : undefined
    const healthScore =
      Array.isArray(item.healthReport) && typeof item.healthReport[0]?.score === 'number'
        ? item.healthReport[0].score
        : null

    result.push({
      fullName,
      name: name || fullName,
      ...(folder ? { folder } : {}),
      color: String(item.color ?? 'notbuilt'),
      status,
      building,
      url: String(item.url ?? ''),
      buildable: item.buildable !== false,
      inQueue: Boolean(item.inQueue),
      lastBuild,
      healthScore,
      isFavorite: favorites.has(fullName)
    })
  }
  return result
}

function summarizeConfig(config: JenkinsConfig): JenkinsConfigSummary {
  return {
    jenkinsUrl: config.jenkinsUrl,
    username: config.username,
    hasToken: Boolean(config.apiToken),
    tokenPreview: maskToken(config.apiToken),
    pollIntervalSec: config.pollIntervalSec,
    viewName: config.viewName
  }
}

async function readFavorites(orca: OrcaWorkerApi): Promise<Set<string>> {
  try {
    const raw = await orca.storage.get(FAVORITES_STORAGE_KEY)
    if (Array.isArray(raw)) {
      return new Set(raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))
    }
  } catch {
    // Ignore storage read error
  }
  return new Set()
}

async function readConfig(orca: OrcaWorkerApi): Promise<JenkinsConfig> {
  const [urlSetting, userSetting, tokenSetting, pollSetting, viewSetting, secretToken, storedRaw] =
    await Promise.all([
      orca.settings.get('jenkinsUrl'),
      orca.settings.get('username'),
      orca.settings.get('apiToken'),
      orca.settings.get('pollIntervalSec'),
      orca.settings.get('viewName'),
      orca.secrets.get(SECRET_TOKEN_KEY),
      orca.storage.get(CONFIG_STORAGE_KEY)
    ])

  const stored =
    storedRaw && typeof storedRaw === 'object' && !Array.isArray(storedRaw)
      ? (storedRaw as Record<string, unknown>)
      : {}

  const jenkinsUrl = normalizeUrl(
    String(urlSetting ?? '') || (typeof stored.jenkinsUrl === 'string' ? stored.jenkinsUrl : '')
  )
  const username = (
    String(userSetting ?? '') || (typeof stored.username === 'string' ? stored.username : '')
  ).trim()
  const apiToken = (
    secretToken ||
    String(tokenSetting ?? '') ||
    (typeof stored.apiToken === 'string' ? stored.apiToken : '')
  ).trim()
  const pollIntervalSec = clampPollInterval(pollSetting ?? stored.pollIntervalSec)
  const viewName = (
    String(viewSetting ?? '') || (typeof stored.viewName === 'string' ? stored.viewName : '')
  ).trim()

  return { jenkinsUrl, username, apiToken, pollIntervalSec, viewName }
}

function isConfigured(config: JenkinsConfig): boolean {
  return Boolean(config.jenkinsUrl && config.username && config.apiToken)
}

async function jenkinsFetch(
  config: JenkinsConfig,
  path: string,
  options: {
    method?: 'GET' | 'POST'
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  } = {}
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort()
    } else {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
  }

  try {
    const url = `${config.jenkinsUrl}${path.startsWith('/') ? path : `/${path}`}`
    const res = await fetch(url, {
      method: options.method ?? 'GET',
      signal: controller.signal,
      headers: {
        Authorization: encodeBasicAuth(config.username, config.apiToken),
        Accept: 'application/json, text/plain, */*',
        ...(options.headers ?? {})
      },
      ...(options.body !== undefined ? { body: options.body } : {})
    })
    return res
  } finally {
    clearTimeout(timer)
  }
}

async function jenkinsJson<T>(
  config: JenkinsConfig,
  path: string,
  signal?: AbortSignal
): Promise<T> {
  const res = await jenkinsFetch(config, path, { signal })
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Authentication failed (${res.status}). Check your username and API token.`)
    }
    const text = await res.text().catch(() => '')
    throw new Error(`Jenkins API error (${res.status}): ${text.slice(0, 160) || res.statusText}`)
  }
  return (await res.json()) as T
}

async function fetchCrumb(
  config: JenkinsConfig,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  try {
    const res = await jenkinsFetch(config, '/crumbIssuer/api/json', { signal })
    if (!res.ok) return {}
    const data = (await res.json()) as { crumbRequestField?: string; crumb?: string }
    if (data.crumbRequestField && data.crumb) {
      return { [data.crumbRequestField]: data.crumb }
    }
  } catch {
    // CSRF protection may be disabled on the Jenkins instance
  }
  return {}
}

function computeCounts(jobs: JenkinsJob[], queue: JenkinsQueueItem[]) {
  let building = 0
  let failed = 0
  let unstable = 0
  let success = 0
  for (const job of jobs) {
    if (job.status === 'building') building += 1
    else if (job.status === 'failed') failed += 1
    else if (job.status === 'unstable') unstable += 1
    else if (job.status === 'success') success += 1
  }
  return {
    building,
    failed,
    unstable,
    success,
    total: jobs.length,
    queue: queue.length
  }
}

type RawJenkinsExecutable = {
  url?: string
  fullDisplayName?: string
  number?: number
  timestamp?: number
  estimatedDuration?: number
}

type RawJenkinsComputerRes = {
  busyExecutors?: number
  totalExecutors?: number
  computer?: Array<{
    displayName?: string
    executors?: Array<{ currentExecutable?: RawJenkinsExecutable | null }>
    oneOffExecutors?: Array<{ currentExecutable?: RawJenkinsExecutable | null }>
  }>
}

function extractJobFullNameFromUrl(url: string): string {
  const matches = Array.from(url.matchAll(/\/job\/([^/]+)/g))
  if (matches.length === 0) return ''
  return matches.map((m) => decodeURIComponent(m[1] ?? '')).filter(Boolean).join('/')
}

function extractActiveBuilds(res: RawJenkinsComputerRes): JenkinsActiveBuild[] {
  const active: JenkinsActiveBuild[] = []
  const seen = new Set<string>()
  for (const node of res.computer ?? []) {
    const executorName = node?.displayName || 'Executor'
    const allExecs = [...(node?.executors ?? []), ...(node?.oneOffExecutors ?? [])]
    for (const ex of allExecs) {
      const cur = ex?.currentExecutable
      if (!cur || !cur.url) continue
      const url = String(cur.url)
      if (seen.has(url)) continue
      seen.add(url)
      const jobFullName = extractJobFullNameFromUrl(url)
      const number = Number(cur.number ?? 0)
      active.push({
        jobFullName: jobFullName || String(cur.fullDisplayName ?? 'Running Build'),
        displayName: String(cur.fullDisplayName ?? (jobFullName ? `${jobFullName} #${number}` : `#${number}`)),
        number,
        building: true,
        result: null,
        timestamp: Number(cur.timestamp ?? Date.now()),
        duration: Math.max(0, Date.now() - Number(cur.timestamp ?? Date.now())),
        ...(typeof cur.estimatedDuration === 'number'
          ? { estimatedDuration: cur.estimatedDuration }
          : {}),
        url,
        executor: executorName
      })
    }
  }
  return active
}

function emptyDashboard(config: JenkinsConfig, extra?: Partial<JenkinsDashboardData>): JenkinsDashboardData {
  return cleanJson({
    jobs: [],
    queue: [],
    activeBuilds: [],
    executors: { busy: 0, total: 0 },
    counts: { building: 0, failed: 0, unstable: 0, success: 0, total: 0, queue: 0 },
    fetchedAt: Date.now(),
    needsSetup: !isConfigured(config),
    config: summarizeConfig(config),
    currentVersion: CURRENT_VERSION,
    ...extra
  })
}

async function notifyStatusTransitions(orca: OrcaWorkerApi, jobs: JenkinsJob[]): Promise<void> {
  if (!hasCompletedInitialPoll) {
    for (const job of jobs) {
      if (job.lastBuild) {
        previousBuildStates.set(job.fullName, {
          number: job.lastBuild.number,
          building: job.lastBuild.building,
          result: job.lastBuild.result
        })
      }
    }
    hasCompletedInitialPoll = true
    return
  }

  for (const job of jobs) {
    const current = job.lastBuild
    if (!current) continue
    const prev = previousBuildStates.get(job.fullName)
    previousBuildStates.set(job.fullName, {
      number: current.number,
      building: current.building,
      result: current.result
    })

    if (!prev) continue
    const finishedNow =
      !current.building &&
      (prev.building || current.number > prev.number) &&
      current.result !== null

    if (!finishedNow) continue

    if (current.result === 'FAILURE' || current.result === 'UNSTABLE') {
      if (orca.host.has('notifications.show')) {
        try {
          await orca.host.call('notifications.show', {
            title: `Jenkins Build ${current.result}`,
            body: `${job.fullName} #${current.number}`
          })
        } catch {
          // Optional notification
        }
      }
    } else if (current.result === 'SUCCESS' && prev.building) {
      if (orca.host.has('notifications.show')) {
        try {
          await orca.host.call('notifications.show', {
            title: 'Jenkins Build Succeeded',
            body: `${job.fullName} #${current.number}`
          })
        } catch {
          // Optional notification
        }
      }
    }
  }
}

function updateStatusBar(orca: OrcaWorkerApi, data: JenkinsDashboardData): void {
  if (!orca.statusBar) return
  if (data.needsSetup) {
    orca.statusBar.set('jenkins-status', {
      text: 'Jenkins: Setup',
      tone: 'neutral',
      tooltip: 'Configure Jenkins URL and API Token'
    })
    return
  }

  if (data.error && data.jobs.length === 0) {
    orca.statusBar.set('jenkins-status', {
      text: 'Jenkins: Error',
      tone: 'warning',
      tooltip: data.error
    })
    return
  }

  const { building, failed, unstable, success, total } = data.counts
  const parts: string[] = []
  if (building > 0) parts.push(`⚡${building}`)
  if (failed > 0) parts.push(`✕${failed}`)
  if (unstable > 0) parts.push(`⚠${unstable}`)
  if (parts.length === 0) {
    parts.push(success > 0 ? `✓${success}` : `${total}`)
  }

  let tone: Tone = 'neutral'
  if (building > 0) tone = 'accent'
  else if (failed > 0) tone = 'danger'
  else if (unstable > 0) tone = 'warning'
  else if (success > 0) tone = 'success'

  orca.statusBar.set('jenkins-status', {
    text: `Jenkins ${parts.join(' ')}`,
    tone,
    tooltip: `${building} building · ${failed} failed · ${unstable} unstable · ${success} success (${total} total)`
  })
}

export async function fetchDashboard(
  orca: OrcaWorkerApi,
  signal?: AbortSignal
): Promise<JenkinsDashboardData> {
  const config = await readConfig(orca)
  if (!isConfigured(config)) {
    const empty = emptyDashboard(config, { needsSetup: true })
    updateStatusBar(orca, empty)
    return empty
  }

  const jobFields =
    'name,fullName,url,color,buildable,inQueue,healthReport[score],lastBuild[number,result,building,timestamp,duration,estimatedDuration,url,displayName]'
  const tree = `jobs[${jobFields},jobs[${jobFields},jobs[${jobFields}]]]`
  const jobsEndpoint = config.viewName
    ? `/view/${encodeURIComponent(config.viewName)}/api/json?tree=${encodeURIComponent(tree)}`
    : `/api/json?tree=${encodeURIComponent(tree)}`

  const startedAt = Date.now()

  try {
    const [jobsRes, queueRes, computerRes, favorites] = await Promise.all([
      jenkinsJson<{ jobs?: RawJenkinsJob[] }>(config, jobsEndpoint, signal),
      jenkinsJson<{ items?: RawJenkinsQueueItem[] }>(
        config,
        '/queue/api/json?tree=items[id,why,stuck,blocked,buildable,inQueueSince,url,task[name,fullName,url,nextBuildNumber],executable[number]]',
        signal
      ).catch(() => ({ items: [] })),
      jenkinsJson<RawJenkinsComputerRes>(
        config,
        '/computer/api/json?tree=busyExecutors,totalExecutors,computer[displayName,executors[currentExecutable[url,fullDisplayName,number,timestamp,estimatedDuration]],oneOffExecutors[currentExecutable[url,fullDisplayName,number,timestamp,estimatedDuration]]]',
        signal
      ).catch(() => ({ busyExecutors: 0, totalExecutors: 0, computer: [] })),
      readFavorites(orca)
    ])

    const jobs = flattenJobs(jobsRes.jobs ?? [], favorites)
    // Sort: favorites first, then building, then failed, then unstable, then alphabetical
    const statusWeight: Record<JenkinsJobStatus, number> = {
      building: 0,
      failed: 1,
      unstable: 2,
      aborted: 3,
      success: 4,
      not_built: 5,
      disabled: 6
    }
    jobs.sort((a, b) => {
      if (Boolean(a.isFavorite) !== Boolean(b.isFavorite)) return a.isFavorite ? -1 : 1
      const wa = statusWeight[a.status] ?? 9
      const wb = statusWeight[b.status] ?? 9
      if (wa !== wb) return wa - wb
      return a.fullName.localeCompare(b.fullName)
    })

    const queue: JenkinsQueueItem[] = (queueRes.items ?? []).map((item) => {
      const rawBuildNum = item.executable?.number ?? item.task?.nextBuildNumber
      const buildNumber = typeof rawBuildNum === 'number' && rawBuildNum > 0 ? rawBuildNum : null
      return {
        id: Number(item.id ?? 0),
        jobName: String(item.task?.fullName ?? item.task?.name ?? 'Unknown Job'),
        ...(buildNumber !== null ? { buildNumber } : {}),
        why: String(item.why ?? ''),
        stuck: Boolean(item.stuck),
        blocked: Boolean(item.blocked),
        buildable: Boolean(item.buildable),
        inQueueSince: Number(item.inQueueSince ?? 0),
        ...(item.url ? { url: String(item.url) } : {})
      }
    })

    const activeBuilds = extractActiveBuilds(computerRes)
    const executors: JenkinsExecutorSummary = {
      busy: Number(computerRes.busyExecutors ?? 0),
      total: Number(computerRes.totalExecutors ?? 0)
    }

    const counts = computeCounts(jobs, queue)
    if (activeBuilds.length > counts.building) {
      counts.building = activeBuilds.length
    }

    const data: JenkinsDashboardData = cleanJson({
      jobs,
      queue,
      activeBuilds,
      executors,
      counts,
      fetchedAt: Date.now(),
      fromCache: false,
      needsSetup: false,
      config: summarizeConfig(config),
      currentVersion: CURRENT_VERSION
    })

    await orca.storage.set(CACHE_KEY, data as unknown as JsonValue)
    await notifyStatusTransitions(orca, jobs)
    updateStatusBar(orca, data)
    void startedAt
    return data
  } catch (err) {
    const message = errorMessage(err)
    orca.log(`Jenkins fetchDashboard failed: ${message}`)

    const cached = (await orca.storage.get(CACHE_KEY)) as JenkinsDashboardData | null
    if (cached && Array.isArray(cached.jobs)) {
      const fallback = cleanJson({
        ...cached,
        fromCache: true,
        needsSetup: false,
        config: summarizeConfig(config),
        error: message,
        currentVersion: CURRENT_VERSION
      })
      updateStatusBar(orca, fallback)
      return fallback
    }

    const failedData = emptyDashboard(config, { needsSetup: false, error: message })
    updateStatusBar(orca, failedData)
    return failedData
  }
}

async function refreshAndBroadcast(orca: OrcaWorkerApi): Promise<JenkinsDashboardData> {
  activeAbort?.abort()
  activeAbort = new AbortController()
  const data = await fetchDashboard(orca, activeAbort.signal)
  orca.panels.post('jenkins.refreshed', data)
  return data
}

function restartPolling(orca: OrcaWorkerApi, pollIntervalSec: number): void {
  const clamped = clampPollInterval(pollIntervalSec)
  if (pollTimer && currentPollSec === clamped) return
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  currentPollSec = clamped
  pollTimer = setInterval(() => {
    void (async () => {
      const cfg = await readConfig(orca)
      if (!isConfigured(cfg)) return
      await refreshAndBroadcast(orca)
    })()
  }, clamped * 1000)
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  isDeactivated = false
  const initialConfig = await readConfig(orca)
  currentPollSec = initialConfig.pollIntervalSec

  disposables.push(
    orca.commands.register('jenkins.refresh', async () => {
      await refreshAndBroadcast(orca)
    })
  )

  disposables.push(
    orca.settings.onDidChange(async () => {
      if (suppressSettingsReload) return
      const cfg = await readConfig(orca)
      restartPolling(orca, cfg.pollIntervalSec)
      await refreshAndBroadcast(orca)
    })
  )

  orca.panels.handle('jenkins.dashboard', async (input, { signal }) => {
    if (!input?.force) {
      const config = await readConfig(orca)
      if (!isConfigured(config)) {
        return emptyDashboard(config, { needsSetup: true })
      }
      const cached = (await orca.storage.get(CACHE_KEY)) as JenkinsDashboardData | null
      if (cached && Array.isArray(cached.jobs)) {
        if (Date.now() - cached.fetchedAt > 15_000) {
          scheduleTimeout(() => {
            void refreshAndBroadcast(orca)
          }, 50)
        }
        return cleanJson({
          ...cached,
          activeBuilds: Array.isArray(cached.activeBuilds) ? cached.activeBuilds : [],
          fromCache: Date.now() - cached.fetchedAt > 15_000,
          config: summarizeConfig(config),
          currentVersion: CURRENT_VERSION
        })
      }
    }
    const data = await fetchDashboard(orca, signal)
    return data
  })

  orca.panels.handle('jenkins.saveConfig', async (input, { signal }) => {
    const jenkinsUrl = normalizeUrl(input.jenkinsUrl)
    const username = input.username.trim()
    const existing = await readConfig(orca)
    const apiToken = (input.apiToken ?? '').trim() || existing.apiToken
    const pollIntervalSec = clampPollInterval(input.pollIntervalSec ?? existing.pollIntervalSec)
    const viewName = (input.viewName ?? existing.viewName).trim()

    if (!jenkinsUrl || !username || !apiToken) {
      return cleanJson({
        ok: false,
        error: 'Jenkins URL, Username, and API Token are required.'
      })
    }

    const candidate: JenkinsConfig = {
      jenkinsUrl,
      username,
      apiToken,
      pollIntervalSec,
      viewName
    }

    try {
      orca.log(`Jenkins saveConfig: verifying ${jenkinsUrl} as ${username}`)
      const me = await jenkinsJson<{ fullName?: string; id?: string }>(
        candidate,
        '/me/api/json?tree=id,fullName',
        signal
      )
      orca.log(`Jenkins saveConfig: authenticated as ${me.fullName || me.id || username}`)

      let secretsSaved = false
      try {
        if (orca.secrets) {
          await orca.secrets.set(SECRET_TOKEN_KEY, apiToken)
          secretsSaved = true
        }
      } catch {
        // OS keyring may be unavailable in headless or test environments.
      }

      try {
        await orca.storage.set(CONFIG_STORAGE_KEY, {
          jenkinsUrl,
          username,
          pollIntervalSec,
          viewName,
          ...(secretsSaved ? {} : { apiToken })
        })
      } catch {
        // Storage persistence is best-effort.
      }

      suppressSettingsReload = true
      try {
        await Promise.all([
          orca.settings.set('jenkinsUrl', jenkinsUrl),
          orca.settings.set('username', username),
          orca.settings.set('apiToken', ''),
          orca.settings.set('pollIntervalSec', pollIntervalSec),
          orca.settings.set('viewName', viewName)
        ])
      } catch {
        // Optional in mock environments.
      } finally {
        suppressSettingsReload = false
      }

      hasCompletedInitialPoll = false
      previousBuildStates.clear()
      restartPolling(orca, pollIntervalSec)

      const dashboard = await fetchDashboard(orca, signal)

      return cleanJson({
        ok: true,
        userDisplayName: me.fullName || me.id || username,
        dashboard
      })
    } catch (err) {
      const msg = errorMessage(err)
      orca.log(`Jenkins saveConfig failed: ${msg}`)
      return cleanJson({
        ok: false,
        error: msg
      })
    }
  })

  orca.panels.handle('jenkins.clearConfig', async () => {
    suppressSettingsReload = true
    try {
      try {
        await orca.secrets?.delete(SECRET_TOKEN_KEY)
      } catch {
        // Optional in mock environments
      }
      try {
        await orca.storage?.delete(CONFIG_STORAGE_KEY)
        await orca.storage?.delete(CACHE_KEY)
      } catch {
        // Optional in mock environments
      }
      try {
        await orca.settings?.set('jenkinsUrl', '')
        await orca.settings?.set('username', '')
        await orca.settings?.set('apiToken', '')
        await orca.settings?.set('viewName', '')
      } catch {
        // Optional in mock environments
      }
    } finally {
      suppressSettingsReload = false
    }
    hasCompletedInitialPoll = false
    previousBuildStates.clear()
    const cfg = await readConfig(orca)
    const dashboard = emptyDashboard(cfg, { needsSetup: true })
    updateStatusBar(orca, dashboard)
    orca.panels.post('jenkins.refreshed', dashboard)
    return cleanJson({ ok: true, dashboard })
  })

  orca.panels.handle('jenkins.jobDetail', async ({ fullName }, { signal }) => {
    const config = await readConfig(orca)
    const path = jobApiPath(fullName)
    if (!isConfigured(config) || !path) {
      return cleanJson({
        job: {
          fullName,
          name: fullName,
          color: 'notbuilt',
          status: 'not_built' as JenkinsJobStatus,
          building: false,
          url: '',
          buildable: false,
          inQueue: false
        },
        builds: [],
        parameters: [],
        error: 'Jenkins is not configured.'
      } satisfies JenkinsJobDetail)
    }

    try {
      const tree =
        'name,fullName,url,color,buildable,inQueue,healthReport[score],property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]],builds[number,result,building,timestamp,duration,estimatedDuration,url,displayName,actions[causes[shortDescription]]]{0,20}'
      const raw = await jenkinsJson<
        RawJenkinsJob & {
          property?: Array<{ parameterDefinitions?: RawJenkinsParameterDef[] }>
          builds?: RawJenkinsBuild[]
        }
      >(config, `${path}/api/json?tree=${encodeURIComponent(tree)}`, signal)

      const favorites = await readFavorites(orca)
      const builds = (raw.builds ?? []).map(normalizeBuild)
      const lastBuild = builds[0] ?? null
      const building = Boolean(lastBuild?.building || (raw.color ?? '').endsWith('_anime'))
      const slashIdx = fullName.lastIndexOf('/')
      const folder = slashIdx > 0 ? fullName.slice(0, slashIdx) : undefined

      const job: JenkinsJob = {
        fullName: raw.fullName || fullName,
        name: raw.name || fullName,
        ...(folder ? { folder } : {}),
        color: String(raw.color ?? 'notbuilt'),
        status: mapJobStatus(raw.color, building),
        building,
        url: String(raw.url ?? ''),
        buildable: raw.buildable !== false,
        inQueue: Boolean(raw.inQueue),
        lastBuild,
        healthScore:
          Array.isArray(raw.healthReport) && typeof raw.healthReport[0]?.score === 'number'
            ? raw.healthReport[0].score
            : null,
        isFavorite: favorites.has(raw.fullName || fullName)
      }

      const parameters: JenkinsParameterDef[] = []
      for (const prop of raw.property ?? []) {
        for (const p of prop?.parameterDefinitions ?? []) {
          if (!p?.name) continue
          const defVal = p.defaultParameterValue?.value
          parameters.push({
            name: p.name,
            type: String(p.type ?? 'StringParameterDefinition'),
            ...(typeof defVal === 'string' || typeof defVal === 'boolean'
              ? { defaultValue: defVal }
              : defVal !== undefined && defVal !== null
                ? { defaultValue: String(defVal) }
                : {}),
            ...(Array.isArray(p.choices) ? { choices: p.choices.map(String) } : {}),
            ...(typeof p.description === 'string' && p.description ? { description: p.description } : {})
          })
        }
      }

      return cleanJson({ job, builds, parameters })
    } catch (err) {
      return cleanJson({
        job: {
          fullName,
          name: fullName,
          color: 'notbuilt',
          status: 'not_built' as JenkinsJobStatus,
          building: false,
          url: '',
          buildable: false,
          inQueue: false
        },
        builds: [],
        parameters: [],
        error: errorMessage(err)
      })
    }
  })

  orca.panels.handle('jenkins.consoleLog', async ({ fullName, buildNumber, start }, { signal }) => {
    const config = await readConfig(orca)
    const path = jobApiPath(fullName)
    const buildSegment = buildNumber && buildNumber > 0 ? String(buildNumber) : 'lastBuild'
    const startOffset = typeof start === 'number' && start >= 0 ? start : 0

    try {
      const [logRes, metaRes] = await Promise.all([
        jenkinsFetch(
          config,
          `${path}/${buildSegment}/logText/progressiveText?start=${startOffset}`,
          { signal }
        ),
        jenkinsJson<{ number?: number; building?: boolean; result?: string | null }>(
          config,
          `${path}/${buildSegment}/api/json?tree=number,building,result`,
          signal
        ).catch(() => ({ number: buildNumber ?? 0, building: false, result: null }))
      ])

      if (!logRes.ok) {
        throw new Error(`Failed to fetch console log (${logRes.status})`)
      }

      const text = await logRes.text()
      const textSizeHeader = logRes.headers.get('X-Text-Size')
      const moreDataHeader = logRes.headers.get('X-More-Data')
      const textSize = textSizeHeader ? parseInt(textSizeHeader, 10) || startOffset + text.length : startOffset + text.length
      const hasMore = moreDataHeader === 'true'

      return cleanJson({
        fullName,
        buildNumber: Number(metaRes.number ?? buildNumber ?? 0),
        text,
        hasMore,
        textSize,
        building: Boolean(metaRes.building || hasMore),
        result: metaRes.result ?? null
      } satisfies JenkinsConsoleLog)
    } catch (err) {
      return cleanJson({
        fullName,
        buildNumber: buildNumber ?? 0,
        text: '',
        hasMore: false,
        textSize: startOffset,
        building: false,
        result: null,
        error: errorMessage(err)
      })
    }
  })

  orca.panels.handle('jenkins.triggerBuild', async ({ fullName, parameters }, { signal }) => {
    const config = await readConfig(orca)
    const path = jobApiPath(fullName)
    try {
      const crumbHeaders = await fetchCrumb(config, signal)
      const hasParams = parameters && Object.keys(parameters).length > 0
      const endpoint = hasParams ? `${path}/buildWithParameters` : `${path}/build`
      const body = hasParams
        ? new URLSearchParams(
            Object.entries(parameters).map(([k, v]) => [k, String(v)])
          ).toString()
        : undefined

      const res = await jenkinsFetch(config, endpoint, {
        method: 'POST',
        headers: {
          ...crumbHeaders,
          ...(hasParams ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
        },
        body,
        signal
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Trigger build failed (${res.status}): ${text.slice(0, 140) || res.statusText}`)
      }

      const queueUrl = res.headers.get('Location') ?? undefined
      if (orca.host.has('notifications.show')) {
        try {
          await orca.host.call('notifications.show', {
            title: 'Jenkins Build Triggered',
            body: fullName
          })
        } catch {
          // Optional notification
        }
      }
      scheduleTimeout(() => {
        void refreshAndBroadcast(orca)
      }, 1500)

      return cleanJson({ ok: true, ...(queueUrl ? { queueUrl } : {}) })
    } catch (err) {
      return cleanJson({ ok: false, error: errorMessage(err) })
    }
  })

  orca.panels.handle('jenkins.stopBuild', async ({ fullName, buildNumber }, { signal }) => {
    const config = await readConfig(orca)
    const path = jobApiPath(fullName)
    try {
      const crumbHeaders = await fetchCrumb(config, signal)
      const res = await jenkinsFetch(config, `${path}/${buildNumber}/stop`, {
        method: 'POST',
        headers: crumbHeaders,
        signal
      })
      if (!res.ok && res.status !== 302) {
        throw new Error(`Stop build failed (${res.status})`)
      }
      scheduleTimeout(() => {
        void refreshAndBroadcast(orca)
      }, 1000)
      return cleanJson({ ok: true })
    } catch (err) {
      return cleanJson({ ok: false, error: errorMessage(err) })
    }
  })

  orca.panels.handle('jenkins.cancelQueue', async ({ id }, { signal }) => {
    const config = await readConfig(orca)
    try {
      const crumbHeaders = await fetchCrumb(config, signal)
      const res = await jenkinsFetch(config, `/queue/cancelItem?id=${encodeURIComponent(String(id))}`, {
        method: 'POST',
        headers: crumbHeaders,
        signal
      })
      if (!res.ok && res.status !== 204 && res.status !== 302) {
        throw new Error(`Cancel queue failed (${res.status})`)
      }
      const dashboard = await fetchDashboard(orca, signal)
      orca.panels.post('jenkins.refreshed', dashboard)
      return cleanJson({ ok: true })
    } catch (err) {
      return cleanJson({ ok: false, error: errorMessage(err) })
    }
  })

  orca.panels.handle('jenkins.toggleFavorite', async ({ fullName }) => {
    const favorites = await readFavorites(orca)
    if (favorites.has(fullName)) {
      favorites.delete(fullName)
    } else {
      favorites.add(fullName)
    }
    const list = Array.from(favorites)
    await orca.storage.set(FAVORITES_STORAGE_KEY, list)
    const dashboard = await fetchDashboard(orca)
    orca.panels.post('jenkins.refreshed', dashboard)
    return cleanJson({ ok: true, favorites: list })
  })

  startupTimer = scheduleTimeout(() => {
    void refreshAndBroadcast(orca)
  }, 500)

  restartPolling(orca, initialConfig.pollIntervalSec)
}

export async function deactivate(): Promise<void> {
  isDeactivated = true
  if (startupTimer) {
    clearTimeout(startupTimer)
    startupTimer = null
  }
  for (const t of pendingTimers) {
    clearTimeout(t)
  }
  pendingTimers.clear()
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  activeAbort?.abort()
  activeAbort = null
  for (const d of disposables) {
    d.dispose()
  }
  disposables.length = 0
}
