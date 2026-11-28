import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  derived,
  EmptyState,
  Heading,
  IconButton,
  Image,
  Input,
  plugin,
  Progress,
  read,
  Row,
  Select,
  Separator,
  set,
  shell,
  Spinner,
  Stack,
  Switch,
  Tab,
  Tabs,
  Text,
  Textarea,
  type PanelContext,
  type Tone
} from 'orca'
import type {
  JenkinsActiveBuild,
  JenkinsBuildSummary,
  JenkinsConsoleLog,
  JenkinsDashboardData,
  JenkinsJob,
  JenkinsJobDetail,
  JenkinsJobStatus,
  JenkinsParameterDef,
  JenkinsQueueItem
} from './protocol'
import { compareJobs } from './protocol'

type FeedbackState = {
  tone: Tone
  title: string
  message: string
} | null

type MainTab = 'builds' | 'queue' | 'jobs'
type StatusFilter = 'all' | 'building' | 'failed' | 'success' | 'favorites'

const dashboardAtom = atom<JenkinsDashboardData | null>(null)
// Keep acknowledged favorites authoritative over stale dashboard and detail snapshots.
const favoritesAtom = atom<ReadonlySet<string> | null>(null)
const favoritePendingAtom = atom(false)
const jobsAtom = derived(() => {
  const jobs = read(dashboardAtom)?.jobs ?? []
  const favorites = read(favoritesAtom)
  if (!favorites) return jobs
  return jobs.map((job) => {
    const isFavorite = favorites.has(job.fullName)
    return job.isFavorite === isFavorite ? job : { ...job, isFavorite }
  }).sort(compareJobs)
})
const loadingAtom = atom<boolean>(true)
const mainTabAtom = atom<MainTab>('defaultViewTab', 'builds', { persist: 'plugin' })
const statusFilterAtom = atom<StatusFilter>('statusFilter', 'all', { persist: 'plugin' })
const currentFolderAtom = atom<string>('')
const searchAtom = atom<string>('')
const visibleLimitAtom = atom<number>(40)
const busyActionAtom = atom<string | null>(null)
const feedbackAtom = atom<FeedbackState>(null)

const showSettingsAtom = atom<boolean>(false)
const configUrlAtom = atom<string>('')
const configUserAtom = atom<string>('')
const configTokenAtom = atom<string>('')
const configPollAtom = atom<string>('30')
const configViewAtom = atom<string>('')

const selectedJobAtom = atom<JenkinsJob | null>(null)
const jobDetailAtom = atom<JenkinsJobDetail | null>(null)
const detailLoadingAtom = atom<boolean>(false)

const showParamsFormAtom = atom<boolean>(false)
const paramValuesAtom = atom<Record<string, string | boolean>>({})

const consoleLogAtom = atom<JenkinsConsoleLog | null>(null)
const consoleLoadingAtom = atom<boolean>(false)

let activeSignal: AbortSignal | null = null

function isAborted(): boolean {
  return Boolean(activeSignal?.aborted)
}

function statusTone(status: JenkinsJobStatus | string | null | undefined): Tone {
  const s = String(status ?? '').toLowerCase()
  if (s === 'building') return 'accent'
  if (s === 'success') return 'success'
  if (s === 'failed' || s === 'failure') return 'danger'
  if (s === 'unstable') return 'warning'
  return 'neutral'
}

function statusLabel(status: JenkinsJobStatus | string | null | undefined): string {
  const s = String(status ?? '').toLowerCase()
  if (s === 'building') return 'Building'
  if (s === 'success') return 'Success'
  if (s === 'failed' || s === 'failure') return 'Failed'
  if (s === 'unstable') return 'Unstable'
  if (s === 'aborted') return 'Aborted'
  if (s === 'disabled') return 'Disabled'
  if (s === 'not_built') return 'Not Built'
  return s ? s.toUpperCase() : 'Unknown'
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return '0s'
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`
}

function formatRelativeTime(ts: number | undefined): string {
  if (!ts || ts <= 0) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return 'just now'
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

function buildProgressPercent(build: JenkinsBuildSummary | null | undefined): number {
  if (!build || !build.building || !build.estimatedDuration || build.estimatedDuration <= 0) {
    return 0
  }
  const elapsed = Math.max(0, Date.now() - build.timestamp)
  return Math.min(95, Math.max(5, Math.round((elapsed / build.estimatedDuration) * 100)))
}

function populateSettingsForm(data: JenkinsDashboardData | null): void {
  const cfg = data?.config
  set(configUrlAtom, cfg?.jenkinsUrl ?? '')
  set(configUserAtom, cfg?.username ?? '')
  set(configTokenAtom, '')
  set(configPollAtom, String(cfg?.pollIntervalSec ?? 30))
  set(configViewAtom, cfg?.viewName ?? '')
}

async function loadDashboard(force = false): Promise<void> {
  if (isAborted()) return
  set(loadingAtom, true)
  try {
    const prevData = read(dashboardAtom)
    const data = await plugin.request('jenkins.dashboard', { force })
    if (isAborted()) return
    set(dashboardAtom, data)
    if (data.needsSetup && prevData === null) {
      populateSettingsForm(data)
    }
  } catch (err) {
    if (isAborted()) return
    set(feedbackAtom, {
      tone: 'danger',
      title: 'Failed to load Jenkins',
      message: err instanceof Error ? err.message : String(err)
    })
  } finally {
    if (!isAborted()) {
      set(loadingAtom, false)
    }
  }
}

async function openJobDetail(job: JenkinsJob): Promise<void> {
  set(selectedJobAtom, job)
  set(consoleLogAtom, null)
  set(showParamsFormAtom, false)
  set(detailLoadingAtom, true)
  try {
    const detail = await plugin.request('jenkins.jobDetail', { fullName: job.fullName })
    if (isAborted()) return
    set(jobDetailAtom, detail)

    const initialParams: Record<string, string | boolean> = {}
    for (const p of detail.parameters) {
      if (p.type.includes('Boolean')) {
        initialParams[p.name] = Boolean(p.defaultValue)
      } else if (p.defaultValue !== undefined) {
        initialParams[p.name] = String(p.defaultValue)
      } else if (p.choices && p.choices.length > 0) {
        initialParams[p.name] = p.choices[0] ?? ''
      } else {
        initialParams[p.name] = ''
      }
    }
    set(paramValuesAtom, initialParams)
  } catch (err) {
    if (isAborted()) return
    set(feedbackAtom, {
      tone: 'danger',
      title: 'Failed to load job details',
      message: err instanceof Error ? err.message : String(err)
    })
  } finally {
    if (!isAborted()) {
      set(detailLoadingAtom, false)
    }
  }
}

async function openConsoleLog(fullName: string, buildNumber: number): Promise<void> {
  set(consoleLoadingAtom, true)
  try {
    const log = await plugin.request('jenkins.consoleLog', {
      fullName,
      buildNumber,
      start: 0
    })
    if (isAborted()) return
    set(consoleLogAtom, log)
  } catch (err) {
    if (isAborted()) return
    set(feedbackAtom, {
      tone: 'danger',
      title: 'Failed to load console log',
      message: err instanceof Error ? err.message : String(err)
    })
  } finally {
    if (!isAborted()) {
      set(consoleLoadingAtom, false)
    }
  }
}

async function handleSaveConfig(): Promise<void> {
  const jenkinsUrl = read(configUrlAtom).trim()
  const username = read(configUserAtom).trim()
  const apiToken = read(configTokenAtom).trim()
  const pollIntervalSec = parseInt(read(configPollAtom).trim(), 10) || 30
  const viewName = read(configViewAtom).trim()

  set(busyActionAtom, 'saveConfig')
  try {
    const res = await plugin.request('jenkins.saveConfig', {
      jenkinsUrl,
      username,
      ...(apiToken ? { apiToken } : {}),
      pollIntervalSec,
      viewName
    })
    if (isAborted()) return
    if (!res.ok) {
      set(feedbackAtom, {
        tone: 'danger',
        title: 'Connection Failed',
        message: res.error ?? 'Could not connect to Jenkins.'
      })
      return
    }
    if (res.dashboard) {
      set(dashboardAtom, res.dashboard)
    }
    set(showSettingsAtom, false)
    set(feedbackAtom, {
      tone: 'success',
      title: 'Connected to Jenkins',
      message: `Authenticated as ${res.userDisplayName ?? username}.`
    })
  } catch (err) {
    if (!isAborted()) {
      set(feedbackAtom, {
        tone: 'danger',
        title: 'Error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  } finally {
    if (!isAborted()) set(busyActionAtom, null)
  }
}

async function handleClearConfig(): Promise<void> {
  set(busyActionAtom, 'clearConfig')
  try {
    const res = await plugin.request('jenkins.clearConfig', {})
    if (isAborted()) return
    set(dashboardAtom, res.dashboard)
    set(selectedJobAtom, null)
    set(jobDetailAtom, null)
    set(consoleLogAtom, null)
    set(showSettingsAtom, false)
    populateSettingsForm(res.dashboard)
    set(feedbackAtom, {
      tone: 'neutral',
      title: 'Disconnected',
      message: 'Jenkins credentials cleared.'
    })
  } finally {
    if (!isAborted()) set(busyActionAtom, null)
  }
}

async function handleTriggerBuild(
  fullName: string,
  parameters?: Record<string, string | boolean>
): Promise<void> {
  set(busyActionAtom, `trigger:${fullName}`)
  try {
    const res = await plugin.request('jenkins.triggerBuild', {
      fullName,
      ...(parameters ? { parameters } : {})
    })
    if (isAborted()) return
    if (!res.ok) {
      set(feedbackAtom, {
        tone: 'danger',
        title: 'Trigger Failed',
        message: res.error ?? 'Could not trigger build.'
      })
      return
    }
    set(showParamsFormAtom, false)
    set(feedbackAtom, {
      tone: 'success',
      title: 'Build Triggered',
      message: `${fullName} added to build queue.`
    })
    const currentJob = read(selectedJobAtom)
    if (currentJob && currentJob.fullName === fullName) {
      setTimeout(() => {
        if (!isAborted()) void openJobDetail(currentJob)
      }, 1500)
    }
  } finally {
    if (!isAborted()) set(busyActionAtom, null)
  }
}

async function handleStopBuild(fullName: string, buildNumber: number): Promise<void> {
  set(busyActionAtom, `stop:${fullName}:${buildNumber}`)
  try {
    const res = await plugin.request('jenkins.stopBuild', { fullName, buildNumber })
    if (isAborted()) return
    if (!res.ok) {
      set(feedbackAtom, {
        tone: 'danger',
        title: 'Stop Failed',
        message: res.error ?? 'Could not stop build.'
      })
      return
    }
    set(feedbackAtom, {
      tone: 'warning',
      title: 'Stop Requested',
      message: `Requested stop for ${fullName} #${buildNumber}.`
    })
    const currentJob = read(selectedJobAtom)
    if (currentJob && currentJob.fullName === fullName) {
      setTimeout(() => {
        if (!isAborted()) void openJobDetail(currentJob)
      }, 1000)
    }
  } finally {
    if (!isAborted()) set(busyActionAtom, null)
  }
}

async function handleCancelQueue(id: number, jobName: string): Promise<void> {
  set(busyActionAtom, `cancelQueue:${id}`)
  try {
    const res = await plugin.request('jenkins.cancelQueue', { id })
    if (isAborted()) return
    if (!res.ok) {
      set(feedbackAtom, {
        tone: 'danger',
        title: 'Cancel Failed',
        message: res.error ?? 'Could not cancel queue item.'
      })
      return
    }
    set(feedbackAtom, {
      tone: 'neutral',
      title: 'Queue Cancelled',
      message: `Removed ${jobName} from queue.`
    })
  } finally {
    if (!isAborted()) set(busyActionAtom, null)
  }
}

async function handleToggleFavorite(fullName: string): Promise<void> {
  if (isAborted() || read(favoritePendingAtom)) return
  const errorTitle = 'Failed to update favorite'
  set(favoritePendingAtom, true)
  try {
    const res = await plugin.request('jenkins.toggleFavorite', { fullName })
    if (isAborted()) return
    if (!res.ok) throw new Error('The favorite was not saved. Please try again.')
    set(favoritesAtom, new Set(res.favorites))
    if (read(feedbackAtom)?.title === errorTitle) set(feedbackAtom, null)
  } catch (err) {
    if (!isAborted()) {
      set(feedbackAtom, {
        tone: 'danger',
        title: errorTitle,
        message: err instanceof Error ? err.message : String(err)
      })
    }
  } finally {
    if (!isAborted()) set(favoritePendingAtom, false)
  }
}

function SettingsView({ data }: { data: JenkinsDashboardData | null }) {
  const url = read(configUrlAtom)
  const username = read(configUserAtom)
  const token = read(configTokenAtom)
  const pollSec = read(configPollAtom)
  const viewName = read(configViewAtom)
  const busy = read(busyActionAtom)
  const hasExistingToken = Boolean(data?.config?.hasToken)

  return (
    <Card>
      <Stack gap="md">
        <Row justify="between" align="center">
          <Heading level={3}>Jenkins Configuration</Heading>
          {!data?.needsSetup && (
            <Button size="xs" variant="ghost" onPress={() => set(showSettingsAtom, false)}>
              Cancel
            </Button>
          )}
        </Row>

        <Input
          label="Jenkins URL"
          placeholder="https://jenkins.example.com"
          value={url}
          onChange={(v) => set(configUrlAtom, v)}
        />

        <Input
          label="Username"
          placeholder="your-username"
          value={username}
          onChange={(v) => set(configUserAtom, v)}
        />

        <Input
          label="API Token"
          type="password"
          placeholder={
            hasExistingToken
              ? `Configured (${data?.config?.tokenPreview ?? '••••'}) — leave blank to keep`
              : 'Paste Jenkins API Token'
          }
          value={token}
          onChange={(v) => set(configTokenAtom, v)}
        />

        <Row gap="sm">
          <Box grow>
            <Input
              label="Poll Interval (sec)"
              placeholder="30"
              value={pollSec}
              onChange={(v) => set(configPollAtom, v)}
            />
          </Box>
          <Box grow>
            <Input
              label="View Filter (optional)"
              placeholder="All"
              value={viewName}
              onChange={(v) => set(configViewAtom, v)}
            />
          </Box>
        </Row>

        <Row gap="sm" justify="between">
          <Button
            variant="solid"
            tone="accent"
            disabled={busy === 'saveConfig' || !url.trim() || !username.trim()}
            onPress={() => void handleSaveConfig()}
          >
            {busy === 'saveConfig' ? 'Connecting...' : 'Save & Connect'}
          </Button>
          {hasExistingToken && (
            <Button
              variant="outline"
              tone="danger"
              size="sm"
              disabled={busy === 'clearConfig'}
              onPress={() => void handleClearConfig()}
            >
              Disconnect
            </Button>
          )}
        </Row>
      </Stack>
    </Card>
  )
}

function ParameterField({ param }: { param: JenkinsParameterDef }) {
  const values = read(paramValuesAtom)
  const current = values[param.name]
  const updateValue = (val: string | boolean) => {
    set(paramValuesAtom, { ...read(paramValuesAtom), [param.name]: val })
  }

  return (
    <Stack gap="xs">
      {param.type.includes('Boolean') ? (
        <Switch
          label={param.name}
          checked={Boolean(current)}
          onChange={(checked) => updateValue(checked)}
        />
      ) : param.choices && param.choices.length > 0 ? (
        <Select
          label={param.name}
          value={String(current ?? param.choices[0] ?? '')}
          options={param.choices.map((c) => ({ label: c, value: c }))}
          onChange={(v) => updateValue(v)}
        />
      ) : param.type.includes('Text') ? (
        <Textarea
          label={param.name}
          rows={3}
          value={String(current ?? '')}
          onChange={(v) => updateValue(v)}
        />
      ) : (
        <Input
          label={param.name}
          type={param.type.includes('Password') ? 'password' : 'text'}
          value={String(current ?? '')}
          onChange={(v) => updateValue(v)}
        />
      )}
      {param.description && (
        <Text size="xs" tone="secondary">
          {param.description}
        </Text>
      )}
    </Stack>
  )
}

function ConsoleLogView({
  job,
  log
}: {
  job: JenkinsJob
  log: JenkinsConsoleLog
}) {
  const loading = read(consoleLoadingAtom)
  const busy = read(busyActionAtom)
  const rawText = log.text || '(No console output yet)'
  const maxChars = 14000
  const truncated = rawText.length > maxChars
  const displayText = truncated ? rawText.slice(rawText.length - maxChars) : rawText

  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Button size="xs" variant="ghost" onPress={() => set(consoleLogAtom, null)}>
          ← Back to Job
        </Button>
        <Row gap="xs" align="center">
          <Badge tone={statusTone(log.building ? 'building' : log.result)}>
            {log.building ? 'Building' : log.result ?? 'Done'}
          </Badge>
          {log.building && (
            <Button
              size="xs"
              variant="outline"
              tone="danger"
              disabled={busy === `stop:${job.fullName}:${log.buildNumber}`}
              onPress={() => void handleStopBuild(job.fullName, log.buildNumber)}
            >
              Stop
            </Button>
          )}
          <IconButton
            icon="refresh"
            label="Refresh Console Log"
            size="xs"
            variant="ghost"
            disabled={loading}
            onPress={() => void openConsoleLog(job.fullName, log.buildNumber)}
          />
        </Row>
      </Row>

      <Row justify="between" align="center">
        <Text size="sm" weight="semibold">
          {job.fullName} #{log.buildNumber}
        </Text>
        {loading && <Spinner size="sm" label="Loading console log" />}
      </Row>

      {log.error && (
        <Callout tone="danger" title="Console Log Error">
          {log.error}
        </Callout>
      )}

      {truncated && (
        <Text size="xs" tone="secondary">
          Showing last {maxChars.toLocaleString()} characters of console output.
        </Text>
      )}

      <Box border={true} background="muted" radius="sm" padding="sm">
        <Code>{displayText}</Code>
      </Box>
    </Stack>
  )
}

function JobDetailView({ job }: { job: JenkinsJob }) {
  const detail = read(jobDetailAtom)
  const loading = read(detailLoadingAtom)
  const consoleLog = read(consoleLogAtom)
  const showParams = read(showParamsFormAtom)
  const busy = read(busyActionAtom)

  if (consoleLog) {
    return <ConsoleLogView job={job} log={consoleLog} />
  }

  const activeJob = detail?.job ?? job
  const isFavorite = read(favoritesAtom)?.has(activeJob.fullName) ?? activeJob.isFavorite
  const parameters = detail?.parameters ?? []
  const builds = detail?.builds ?? []

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Button
          size="xs"
          variant="ghost"
          onPress={() => {
            set(selectedJobAtom, null)
            set(jobDetailAtom, null)
            set(consoleLogAtom, null)
          }}
        >
          ← Back
        </Button>
        <Row gap="xs" align="center">
          <Button
            size="xs"
            variant="ghost"
            disabled={read(favoritePendingAtom)}
            onPress={() => void handleToggleFavorite(activeJob.fullName)}
          >
            {isFavorite ? '★ Starred' : '☆ Star'}
          </Button>
          {activeJob.url && (
            <IconButton
              icon="open-external"
              label="Open in Jenkins"
              size="xs"
              variant="ghost"
              onPress={() => void shell.openExternal(activeJob.url)}
            />
          )}
          <IconButton
            icon="refresh"
            label="Refresh Job"
            size="xs"
            variant="ghost"
            disabled={loading}
            onPress={() => void openJobDetail(activeJob)}
          />
        </Row>
      </Row>

      <Card>
        <Stack gap="sm">
          <Row justify="between" align="center">
            <Stack gap="xs">
              <Heading level={3}>{activeJob.name}</Heading>
              {activeJob.folder && (
                <Text size="xs" tone="secondary">
                  {activeJob.folder}
                </Text>
              )}
            </Stack>
            <Badge tone={statusTone(activeJob.status)}>{statusLabel(activeJob.status)}</Badge>
          </Row>

          {activeJob.buildable && (
            <Row gap="sm" align="center">
              {parameters.length === 0 ? (
                <Button
                  size="sm"
                  variant="solid"
                  tone="accent"
                  disabled={busy === `trigger:${activeJob.fullName}`}
                  onPress={() => void handleTriggerBuild(activeJob.fullName)}
                >
                  {busy === `trigger:${activeJob.fullName}` ? 'Triggering...' : 'Build Now'}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="solid"
                  tone="accent"
                  onPress={() => set(showParamsFormAtom, !showParams)}
                >
                  {showParams ? 'Hide Parameters' : `Build with Parameters (${parameters.length})`}
                </Button>
              )}
              {activeJob.inQueue && <Badge tone="warning">In Queue</Badge>}
            </Row>
          )}
        </Stack>
      </Card>

      {showParams && parameters.length > 0 && (
        <Card>
          <Stack gap="sm">
            <Heading level={4}>Build Parameters</Heading>
            {parameters.map((p) => (
              <ParameterField key={p.name} param={p} />
            ))}
            <Row justify="end" gap="sm">
              <Button size="xs" variant="ghost" onPress={() => set(showParamsFormAtom, false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="solid"
                tone="accent"
                disabled={busy === `trigger:${activeJob.fullName}`}
                onPress={() => void handleTriggerBuild(activeJob.fullName, read(paramValuesAtom))}
              >
                {busy === `trigger:${activeJob.fullName}` ? 'Starting...' : 'Run Build'}
              </Button>
            </Row>
          </Stack>
        </Card>
      )}

      {detail?.error && (
        <Callout tone="danger" title="Error loading job">
          {detail.error}
        </Callout>
      )}

      <Row justify="between" align="center">
        <Heading level={4}>Recent Builds</Heading>
        {loading && <Spinner size="sm" label="Loading builds" />}
      </Row>

      {!loading && builds.length === 0 ? (
        <EmptyState title="No builds yet" description="Trigger a build to see build history." />
      ) : (
        <Stack gap="xs">
          {builds.map((b) => (
            <Card key={b.number}>
              <Stack gap="xs">
                <Row justify="between" align="center">
                  <Row gap="xs" align="center">
                    <Text size="sm" weight="semibold">
                      #{b.number}
                    </Text>
                    <Badge tone={statusTone(b.building ? 'building' : b.result)}>
                      {b.building ? 'Building' : b.result ?? 'Pending'}
                    </Badge>
                  </Row>
                  <Row gap="xs">
                    {b.building && (
                      <Button
                        size="xs"
                        variant="outline"
                        tone="danger"
                        disabled={busy === `stop:${activeJob.fullName}:${b.number}`}
                        onPress={() => void handleStopBuild(activeJob.fullName, b.number)}
                      >
                        Stop
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="outline"
                      onPress={() => void openConsoleLog(activeJob.fullName, b.number)}
                    >
                      Console
                    </Button>
                  </Row>
                </Row>

                {b.building && b.estimatedDuration && b.estimatedDuration > 0 && (
                  <Progress label={`Build #${b.number} progress`} value={buildProgressPercent(b)} />
                )}

                <Row justify="between" align="center">
                  <Text size="xs" tone="secondary">
                    {b.cause ?? 'Triggered'}
                  </Text>
                  <Text size="xs" tone="secondary">
                    {b.building ? 'Running' : formatDuration(b.duration)} ·{' '}
                    {formatRelativeTime(b.timestamp)}
                  </Text>
                </Row>
              </Stack>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  )
}

function JobCard({ job }: { job: JenkinsJob }) {
  const last = job.lastBuild
  return (
    <Box border={true} background="card" radius="md" padding="sm" gap="xs">
      <Stack gap="xs">
        <Row justify="between" align="center">
          <Row gap="xs" align="center">
            <Button
              size="xs"
              variant="ghost"
              disabled={read(favoritePendingAtom)}
              onPress={() => void handleToggleFavorite(job.fullName)}
            >
              {job.isFavorite ? '★' : '☆'}
            </Button>
            <Button size="xs" variant="ghost" onPress={() => void openJobDetail(job)}>
              {job.name}
            </Button>
          </Row>
          <Row gap="xs" align="center">
            {job.inQueue && <Badge tone="warning">Queued</Badge>}
            <Badge tone={statusTone(job.status)}>{statusLabel(job.status)}</Badge>
          </Row>
        </Row>

        {job.folder && (
          <Text size="xs" tone="secondary">
            {job.folder}
          </Text>
        )}

        {job.building && last?.estimatedDuration && last.estimatedDuration > 0 && (
          <Progress label={`${job.name} progress`} value={buildProgressPercent(last)} />
        )}

        <Row justify="between" align="center">
          <Text size="xs" tone="secondary">
            {last
              ? `#${last.number} · ${last.building ? 'Running' : formatDuration(last.duration)} · ${formatRelativeTime(last.timestamp)}`
              : 'No builds yet'}
          </Text>
          <Row gap="xs">
            {last && (
              <Button
                size="xs"
                variant="ghost"
                onPress={() => {
                  set(selectedJobAtom, job)
                  void openConsoleLog(job.fullName, last.number)
                }}
              >
                Log
              </Button>
            )}
            <Button size="xs" variant="outline" onPress={() => void openJobDetail(job)}>
              Open
            </Button>
          </Row>
        </Row>
      </Stack>
    </Box>
  )
}

function splitJobName(fullName: string): { shortName: string; folder: string } {
  const idx = fullName.lastIndexOf('/')
  if (idx <= 0) return { shortName: fullName, folder: '' }
  return {
    folder: fullName.slice(0, idx),
    shortName: fullName.slice(idx + 1)
  }
}

function compactText(text: string, maxLen = 34): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen - 1)}…`
}

function QueueList({ queue }: { queue: JenkinsQueueItem[] }) {
  const busy = read(busyActionAtom)

  if (queue.length === 0) {
    return (
      <EmptyState
        title="Build Queue Empty"
        description="No builds are currently waiting for an executor."
      />
    )
  }

  return (
    <Stack gap="xs">
      {queue.map((item) => {
        const { shortName, folder } = splitJobName(item.jobName)
        return (
          <Box key={item.id} border={true} background="card" radius="md" padding="sm">
            <Stack gap="xs">
              <Row justify="between" align="center" gap="xs" wrap>
                <Row gap="xs" align="center" wrap>
                  <Badge tone="accent">
                    {item.buildNumber ? `#${item.buildNumber}` : `Q#${item.id}`}
                  </Badge>
                  <Text size="sm" weight="semibold">
                    {compactText(shortName, 32)}
                  </Text>
                </Row>
                <Row gap="xs" align="center">
                  {item.stuck && <Badge tone="danger">Stuck</Badge>}
                  {item.blocked && <Badge tone="warning">Blocked</Badge>}
                  <Button
                    size="xs"
                    variant="outline"
                    tone="danger"
                    disabled={busy === `cancelQueue:${item.id}`}
                    onPress={() => void handleCancelQueue(item.id, item.jobName)}
                  >
                    Cancel
                  </Button>
                </Row>
              </Row>
              {folder && (
                <Text size="xs" tone="secondary">
                  {folder}
                </Text>
              )}
              <Text size="xs" tone="secondary">
                {item.why || 'Waiting for available executor'}
              </Text>
              <Text size="xs" tone="secondary">
                {item.inQueueSince > 0
                  ? `Queue #${item.id} · Queued ${formatRelativeTime(item.inQueueSince)}`
                  : `Queue #${item.id}`}
              </Text>
            </Stack>
          </Box>
        )
      })}
    </Stack>
  )
}

type FolderSummary = {
  fullPath: string
  name: string
  total: number
  building: number
  failed: number
  success: number
}

function getFolderViewData(
  jobs: JenkinsJob[],
  currentFolder: string
): { folders: FolderSummary[]; directJobs: JenkinsJob[] } {
  const folderMap = new Map<string, FolderSummary>()
  const directJobs: JenkinsJob[] = []
  const prefix = currentFolder ? `${currentFolder}/` : ''

  for (const job of jobs) {
    const jobFolder = job.folder ?? ''
    if (jobFolder === currentFolder) {
      directJobs.push(job)
      continue
    }
    if (currentFolder && !jobFolder.startsWith(prefix)) {
      continue
    }
    const rest = currentFolder ? jobFolder.slice(prefix.length) : jobFolder
    const nextSegment = rest.split('/')[0]
    if (!nextSegment) continue
    const childPath = currentFolder ? `${currentFolder}/${nextSegment}` : nextSegment

    let entry = folderMap.get(childPath)
    if (!entry) {
      entry = {
        fullPath: childPath,
        name: nextSegment,
        total: 0,
        building: 0,
        failed: 0,
        success: 0
      }
      folderMap.set(childPath, entry)
    }
    entry.total += 1
    if (job.status === 'building') entry.building += 1
    else if (job.status === 'failed' || job.status === 'unstable') entry.failed += 1
    else if (job.status === 'success') entry.success += 1
  }

  const folders = Array.from(folderMap.values()).sort((a, b) => {
    if (a.building !== b.building) return b.building - a.building
    if (a.failed !== b.failed) return b.failed - a.failed
    return a.name.localeCompare(b.name)
  })

  return { folders, directJobs }
}

function FolderCard({ folder }: { folder: FolderSummary }) {
  return (
    <Box border={true} background="card" radius="md" padding="sm">
      <Row justify="between" align="center">
        <Button
          size="xs"
          variant="ghost"
          onPress={() => {
            set(currentFolderAtom, folder.fullPath)
            set(visibleLimitAtom, 40)
          }}
        >
          {`📁 ${folder.name}`}
        </Button>
        <Row gap="xs" align="center">
          {folder.building > 0 && <Badge tone="accent">{`⚡${folder.building}`}</Badge>}
          {folder.failed > 0 && <Badge tone="danger">{`✕${folder.failed}`}</Badge>}
          <Badge tone="neutral">{`${folder.total} jobs`}</Badge>
          <Button
            size="xs"
            variant="outline"
            onPress={() => {
              set(currentFolderAtom, folder.fullPath)
              set(visibleLimitAtom, 40)
            }}
          >
            Open
          </Button>
        </Row>
      </Row>
    </Box>
  )
}

export function setup(ctx: PanelContext): void {
  activeSignal = ctx.signal
  set(showSettingsAtom, false)
  ctx.subscriptions.push(
    plugin.on('jenkins.refreshed', (data) => {
      if (isAborted()) return
      const prevData = read(dashboardAtom)
      set(dashboardAtom, data)
      set(loadingAtom, false)
      if (data.needsSetup && prevData === null) {
        populateSettingsForm(data)
      }
    })
  )
  void loadDashboard(false)
}

export default function Panel() {
  const data = read(dashboardAtom)
  const loading = read(loadingAtom)
  const mainTab = read(mainTabAtom)
  const statusFilter = read(statusFilterAtom)
  const currentFolder = read(currentFolderAtom)
  const search = read(searchAtom)
  const showSettings = read(showSettingsAtom)
  const selectedJob = read(selectedJobAtom)
  const feedback = read(feedbackAtom)

  const jobs = read(jobsAtom)
  const queue = data?.queue ?? []
  const activeBuilds = data?.activeBuilds ?? []
  const counts = data?.counts ?? {
    building: 0,
    failed: 0,
    unstable: 0,
    success: 0,
    total: 0,
    queue: 0
  }

  const query = search.trim().toLowerCase()
  const scopedJobs = currentFolder
    ? jobs.filter(
        (j) => j.folder === currentFolder || (j.folder ?? '').startsWith(`${currentFolder}/`)
      )
    : jobs

  const filteredJobs = scopedJobs.filter((job) => {
    if (statusFilter === 'building' && job.status !== 'building') return false
    if (statusFilter === 'failed' && job.status !== 'failed' && job.status !== 'unstable') {
      return false
    }
    if (statusFilter === 'success' && job.status !== 'success') return false
    if (statusFilter === 'favorites' && !job.isFavorite) return false
    if (query && !job.fullName.toLowerCase().includes(query)) return false
    return true
  })

  const isBrowsingFolders = statusFilter === 'all' && !query
  const folderView = isBrowsingFolders ? getFolderViewData(jobs, currentFolder) : null
  const parentFolder = currentFolder.includes('/')
    ? currentFolder.slice(0, currentFolder.lastIndexOf('/'))
    : ''

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Box width={22} height={22} shrink={false}>
            <Image src="assets/jenkins-logo.png" alt="Jenkins" size="full" fit="contain" rounded />
          </Box>
          <Heading level={2}>Jenkins</Heading>
          {data && !data.needsSetup && (
            <Badge tone={data.executors.busy > 0 ? 'accent' : 'neutral'}>
              {data.executors.busy}/{data.executors.total} exec
            </Badge>
          )}
          {data?.fromCache && <Badge tone="warning">Cached</Badge>}
        </Row>
        <Row gap="xs" align="center">
          <IconButton
            icon="settings"
            label="Jenkins Settings"
            size="xs"
            variant="ghost"
            onPress={() => {
              populateSettingsForm(data)
              set(showSettingsAtom, !showSettings)
            }}
          />
          <IconButton
            icon="refresh"
            label="Refresh Jenkins"
            size="xs"
            variant="ghost"
            disabled={loading}
            onPress={() => void loadDashboard(true)}
          />
        </Row>
      </Row>

      {feedback && (
        <Callout tone={feedback.tone} title={feedback.title}>
          <Row justify="between" align="center">
            <Text size="sm">{feedback.message}</Text>
            <Button size="xs" variant="ghost" onPress={() => set(feedbackAtom, null)}>
              Dismiss
            </Button>
          </Row>
        </Callout>
      )}

      {data?.error && !showSettings && (
        <Callout tone="warning" title="Sync Warning">
          {data.error}
        </Callout>
      )}

      {showSettings || data?.needsSetup ? (
        <SettingsView data={data} />
      ) : selectedJob ? (
        <JobDetailView job={selectedJob} />
      ) : loading && !data ? (
        <Box padding="lg">
          <Row justify="center">
            <Spinner label="Loading Jenkins" />
          </Row>
        </Box>
      ) : (
        <Stack gap="sm">
          <Row gap="xs" wrap>
            <Badge tone={counts.building > 0 ? 'accent' : 'neutral'}>
              ⚡ {counts.building} Building
            </Badge>
            <Badge tone={counts.failed > 0 ? 'danger' : 'neutral'}>
              ✕ {counts.failed} Failed
            </Badge>
            <Badge tone={counts.unstable > 0 ? 'warning' : 'neutral'}>
              ⚠ {counts.unstable} Unstable
            </Badge>
            <Badge tone="success">✓ {counts.success} Pass</Badge>
          </Row>

          <Tabs
            label="Jenkins Section"
            value={mainTab}
            onChange={(v) => set(mainTabAtom, v as MainTab)}
          >
            <Tab value="builds" label={`Builds (${activeBuilds.length})`}>
              {mainTab === 'builds' ? (
                <BuildsHistoryView activeBuilds={activeBuilds} jobs={jobs} />
              ) : null}
            </Tab>
            <Tab value="queue" label={`Queue (${counts.queue})`}>
              {mainTab === 'queue' ? <QueueList queue={queue} /> : null}
            </Tab>
            <Tab value="jobs" label={`Jobs (${counts.total})`}>
              {mainTab === 'jobs' ? (
                <Stack gap="sm">
                  <Input
                    label="Search jobs"
                    labelHidden
                    type="search"
                    placeholder={
                      currentFolder ? `Search in ${currentFolder}...` : 'Search jobs or folders...'
                    }
                    value={search}
                    onChange={(v) => {
                      set(searchAtom, v)
                      set(visibleLimitAtom, 40)
                    }}
                  />

                  {currentFolder && (
                    <Row justify="between" align="center">
                      <Row gap="xs" align="center">
                        <Button
                          size="xs"
                          variant="ghost"
                          onPress={() => {
                            set(currentFolderAtom, parentFolder)
                            set(visibleLimitAtom, 40)
                          }}
                        >
                          ← Up
                        </Button>
                        <Text size="xs" weight="semibold">
                          {`📁 ${currentFolder}`}
                        </Text>
                      </Row>
                      <Button
                        size="xs"
                        variant="ghost"
                        onPress={() => {
                          set(currentFolderAtom, '')
                          set(visibleLimitAtom, 40)
                        }}
                      >
                        Root
                      </Button>
                    </Row>
                  )}

                  <Tabs
                    label="Status Filter"
                    value={statusFilter}
                    onChange={(v) => {
                      set(statusFilterAtom, v as StatusFilter)
                      set(visibleLimitAtom, 40)
                    }}
                  >
                    <Tab value="all" label="All">
                      {folderView ? (
                        <FolderBrowserView
                          folders={folderView.folders}
                          directJobs={folderView.directJobs}
                          emptyTotal={jobs.length}
                        />
                      ) : (
                        <JobList jobs={filteredJobs} emptyTotal={jobs.length} />
                      )}
                    </Tab>
                    <Tab value="building" label="Building">
                      <JobList jobs={filteredJobs} emptyTotal={jobs.length} />
                    </Tab>
                    <Tab value="failed" label="Failed">
                      <JobList jobs={filteredJobs} emptyTotal={jobs.length} />
                    </Tab>
                    <Tab value="success" label="Pass">
                      <JobList jobs={filteredJobs} emptyTotal={jobs.length} />
                    </Tab>
                    <Tab value="favorites" label="★">
                      <JobList jobs={filteredJobs} emptyTotal={jobs.length} />
                    </Tab>
                  </Tabs>
                </Stack>
              ) : null}
            </Tab>
          </Tabs>
        </Stack>
      )}
    </Stack>
  )
}

function BuildsHistoryView({
  activeBuilds,
  jobs
}: {
  activeBuilds: JenkinsActiveBuild[]
  jobs: JenkinsJob[]
}) {
  const busy = read(busyActionAtom)

  const recentJobs = jobs
    .filter((j) => j.lastBuild && j.lastBuild.timestamp > 0)
    .slice()
    .sort((a, b) => (b.lastBuild?.timestamp ?? 0) - (a.lastBuild?.timestamp ?? 0))
    .slice(0, 20)

  const makeStubJob = (fullName: string, url: string): JenkinsJob => {
    const existing = jobs.find((j) => j.fullName === fullName)
    if (existing) return existing
    const parts = fullName.split('/')
    const name = parts[parts.length - 1] ?? fullName
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : undefined
    return {
      fullName,
      name,
      ...(folder ? { folder } : {}),
      color: 'blue_anime',
      status: 'building',
      building: true,
      url: url.replace(/\/\d+\/?$/, '/'),
      buildable: true,
      inQueue: false
    }
  }

  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Heading level={3}>{`Running Now (${activeBuilds.length})`}</Heading>
        {activeBuilds.length === 0 ? (
          <Text size="xs" tone="secondary">
            No active builds running on executors right now.
          </Text>
        ) : (
          activeBuilds.map((b) => {
            const { shortName, folder } = splitJobName(b.jobFullName)
            return (
              <Box key={`${b.jobFullName}#${b.number}`} border={true} background="card" radius="md" padding="sm">
                <Stack gap="xs">
                  <Row justify="between" align="center" gap="xs" wrap>
                    <Button
                      size="xs"
                      variant="ghost"
                      tooltip={b.jobFullName}
                      onPress={() => void openJobDetail(makeStubJob(b.jobFullName, b.url))}
                    >
                      {compactText(shortName, 32)}
                    </Button>
                    <Badge tone="accent">{`#${b.number} Building`}</Badge>
                  </Row>
                  {folder && (
                    <Text size="xs" tone="secondary">
                      {folder}
                    </Text>
                  )}

                {b.estimatedDuration && b.estimatedDuration > 0 && (
                  <Progress
                    label={`${b.jobFullName} #${b.number}`}
                    value={buildProgressPercent({
                      number: b.number,
                      result: null,
                      building: true,
                      timestamp: b.timestamp,
                      duration: b.duration,
                      estimatedDuration: b.estimatedDuration,
                      url: b.url
                    })}
                  />
                )}

                <Text size="xs" tone="secondary">
                  {`${b.executor ?? 'Executor'} · started ${formatRelativeTime(b.timestamp)}`}
                </Text>
                <Row justify="end" gap="xs">
                  <Button
                    size="xs"
                    variant="outline"
                    onPress={() => {
                      set(selectedJobAtom, makeStubJob(b.jobFullName, b.url))
                      void openConsoleLog(b.jobFullName, b.number)
                    }}
                  >
                    Console
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    tone="danger"
                    disabled={busy === `stop:${b.jobFullName}:${b.number}`}
                    onPress={() => void handleStopBuild(b.jobFullName, b.number)}
                  >
                    Stop
                  </Button>
                </Row>
              </Stack>
            </Box>
            )
          })
        )}
      </Stack>

      <Separator />

      <Stack gap="xs">
        <Heading level={3}>Recent Builds</Heading>
        {recentJobs.length === 0 ? (
          <EmptyState title="No build history" description="No recent builds found." />
        ) : (
          recentJobs.map((job) => {
            const last = job.lastBuild!
            const { shortName, folder } = splitJobName(job.fullName)
            return (
              <Box key={`${job.fullName}#${last.number}`} border={true} background="card" radius="md" padding="sm">
                <Stack gap="xs">
                  <Row justify="between" align="center" gap="xs" wrap>
                    <Button
                      size="xs"
                      variant="ghost"
                      tooltip={job.fullName}
                      onPress={() => void openJobDetail(job)}
                    >
                      {compactText(shortName, 32)}
                    </Button>
                    <Badge tone={statusTone(job.status)}>{`#${last.number} ${statusLabel(job.status)}`}</Badge>
                  </Row>
                  {folder && (
                    <Text size="xs" tone="secondary">
                      {folder}
                    </Text>
                  )}
                  <Row justify="between" align="center" gap="xs" wrap>
                    <Text size="xs" tone="secondary">
                      {`${last.building ? 'Running' : formatDuration(last.duration)} · ${formatRelativeTime(last.timestamp)}`}
                    </Text>
                    <Row gap="xs">
                      <Button
                        size="xs"
                        variant="ghost"
                        onPress={() => {
                          set(selectedJobAtom, job)
                          void openConsoleLog(job.fullName, last.number)
                        }}
                      >
                        Console
                      </Button>
                      <Button size="xs" variant="outline" onPress={() => void openJobDetail(job)}>
                        Open
                      </Button>
                    </Row>
                  </Row>
                </Stack>
              </Box>
            )
          })
        )}
      </Stack>
    </Stack>
  )
}

function FolderBrowserView({
  folders,
  directJobs,
  emptyTotal
}: {
  folders: FolderSummary[]
  directJobs: JenkinsJob[]
  emptyTotal: number
}) {
  if (folders.length === 0 && directJobs.length === 0) {
    return (
      <EmptyState
        title="No jobs or folders"
        description={
          emptyTotal === 0
            ? 'No jobs found on this Jenkins server.'
            : 'This folder has no jobs.'
        }
      />
    )
  }

  return (
    <Stack gap="xs">
      {folders.map((folder) => (
        <FolderCard key={folder.fullPath} folder={folder} />
      ))}
      {directJobs.length > 0 && <JobList jobs={directJobs} emptyTotal={emptyTotal} />}
    </Stack>
  )
}

function JobList({ jobs, emptyTotal }: { jobs: JenkinsJob[]; emptyTotal: number }) {
  const limit = read(visibleLimitAtom)
  if (jobs.length === 0) {
    return (
      <EmptyState
        title="No matching jobs"
        description={
          emptyTotal === 0
            ? 'No jobs found on this Jenkins server.'
            : 'Try clearing your search or switching status filter.'
        }
      />
    )
  }

  const visibleJobs = jobs.slice(0, limit)
  const remaining = jobs.length - visibleJobs.length

  return (
    <Stack gap="xs">
      {visibleJobs.map((job) => (
        <JobCard key={job.fullName} job={job} />
      ))}
      {remaining > 0 && (
        <Button
          size="xs"
          variant="outline"
          onPress={() => set(visibleLimitAtom, limit + 40)}
        >
          {`Show more (${remaining} remaining)`}
        </Button>
      )}
    </Stack>
  )
}
