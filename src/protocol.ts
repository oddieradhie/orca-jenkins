export type JenkinsJobStatus =
  | 'building'
  | 'success'
  | 'failed'
  | 'unstable'
  | 'aborted'
  | 'disabled'
  | 'not_built'

export type JenkinsParameterDef = {
  name: string
  type: string
  defaultValue?: string | boolean
  choices?: string[]
  description?: string
}

export type JenkinsBuildSummary = {
  number: number
  result: string | null
  building: boolean
  timestamp: number
  duration: number
  estimatedDuration?: number
  url: string
  displayName?: string
  cause?: string
}

export type JenkinsJob = {
  fullName: string
  name: string
  folder?: string
  color: string
  status: JenkinsJobStatus
  building: boolean
  url: string
  buildable: boolean
  inQueue: boolean
  lastBuild?: JenkinsBuildSummary | null
  healthScore?: number | null
  isFavorite?: boolean
}

export type JenkinsQueueItem = {
  id: number
  jobName: string
  buildNumber?: number | null
  why: string
  stuck: boolean
  blocked: boolean
  buildable: boolean
  inQueueSince: number
  url?: string
}

export type JenkinsExecutorSummary = {
  busy: number
  total: number
}

export type JenkinsActiveBuild = {
  jobFullName: string
  displayName: string
  number: number
  building: boolean
  result: string | null
  timestamp: number
  duration: number
  estimatedDuration?: number
  url: string
  executor?: string
}

export type JenkinsConfigSummary = {
  jenkinsUrl: string
  username: string
  hasToken: boolean
  tokenPreview: string
  pollIntervalSec: number
  viewName: string
}

export type JenkinsDashboardData = {
  jobs: JenkinsJob[]
  queue: JenkinsQueueItem[]
  activeBuilds: JenkinsActiveBuild[]
  executors: JenkinsExecutorSummary
  counts: {
    building: number
    failed: number
    unstable: number
    success: number
    total: number
    queue: number
  }
  fetchedAt: number
  fromCache?: boolean
  needsSetup?: boolean
  config?: JenkinsConfigSummary
  error?: string
  currentVersion?: string
}

export type JenkinsJobDetail = {
  job: JenkinsJob
  builds: JenkinsBuildSummary[]
  parameters: JenkinsParameterDef[]
  error?: string
}

export type JenkinsConsoleLog = {
  fullName: string
  buildNumber: number
  text: string
  hasMore: boolean
  textSize: number
  building: boolean
  result: string | null
  error?: string
}

declare module 'orca' {
  interface PluginRequests {
    'jenkins.dashboard': { input: { force?: boolean } | undefined; output: JenkinsDashboardData }
    'jenkins.saveConfig': {
      input: {
        jenkinsUrl: string
        username: string
        apiToken?: string
        pollIntervalSec?: number
        viewName?: string
      }
      output: {
        ok: boolean
        error?: string
        userDisplayName?: string
        dashboard?: JenkinsDashboardData
      }
    }
    'jenkins.clearConfig': {
      input: Record<string, never> | undefined
      output: { ok: boolean; dashboard: JenkinsDashboardData }
    }
    'jenkins.jobDetail': {
      input: { fullName: string }
      output: JenkinsJobDetail
    }
    'jenkins.consoleLog': {
      input: { fullName: string; buildNumber?: number; start?: number }
      output: JenkinsConsoleLog
    }
    'jenkins.triggerBuild': {
      input: { fullName: string; parameters?: Record<string, string | boolean> }
      output: { ok: boolean; queueUrl?: string; error?: string }
    }
    'jenkins.stopBuild': {
      input: { fullName: string; buildNumber: number }
      output: { ok: boolean; error?: string }
    }
    'jenkins.cancelQueue': {
      input: { id: number }
      output: { ok: boolean; error?: string }
    }
    'jenkins.toggleFavorite': {
      input: { fullName: string }
      output: { ok: boolean; favorites: string[] }
    }
  }

  interface PluginEvents {
    'jenkins.refreshed': JenkinsDashboardData
  }
}
