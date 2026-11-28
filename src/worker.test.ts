import { afterEach, assert, mockHost, mount, mountWorker, test, type TestWorker } from 'orca/testing'
import * as panel from './panel'
import type { JenkinsDashboardData, JenkinsJobDetail } from './protocol'
import * as main from './worker'

const originalFetch = globalThis.fetch
let activeWorker: TestWorker | undefined

afterEach(async () => {
  globalThis.fetch = originalFetch
  await activeWorker?.deactivate()
  activeWorker = undefined
})

test('jobApiPath and flattenJobs handle nested Jenkins folders and statuses', () => {
  assert.equal(main.jobApiPath('platform/backend/api-gateway'), '/job/platform/job/backend/job/api-gateway')
  assert.equal(main.mapJobStatus('blue_anime', false), 'building')
  assert.equal(main.mapJobStatus('red', false), 'failed')
  assert.equal(main.mapJobStatus('yellow', false), 'unstable')
  assert.equal(main.mapJobStatus('blue', false), 'success')

  const jobs = main.flattenJobs(
    [
      {
        name: 'platform',
        fullName: 'platform',
        jobs: [
          {
            name: 'api-gateway',
            fullName: 'platform/api-gateway',
            color: 'red',
            url: 'https://jenkins.example.dev/job/platform/job/api-gateway/',
            buildable: true,
            inQueue: false,
            lastBuild: {
              number: 42,
              result: 'FAILURE',
              building: false,
              timestamp: 1700000000000,
              duration: 15000,
              url: 'https://jenkins.example.dev/job/platform/job/api-gateway/42/'
            }
          }
        ]
      }
    ],
    new Set(['platform/api-gateway'])
  )

  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]?.fullName, 'platform/api-gateway')
  assert.equal(jobs[0]?.folder, 'platform')
  assert.equal(jobs[0]?.status, 'failed')
  assert.equal(jobs[0]?.isFavorite, true)
})

test('saves config, fetches dashboard, and updates status bar cleanly', async () => {
  const seenUrls: string[] = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    seenUrls.push(u)
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
    assert.ok(auth.startsWith('Basic '), 'Expected Basic auth header')

    if (u.includes('/me/api/json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'demo', fullName: 'Demo User' })
      } as unknown as Response
    }
    if (u.includes('/queue/api/json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: 101,
              why: 'Waiting for next available executor',
              stuck: false,
              blocked: false,
              buildable: true,
              inQueueSince: 1700000000000,
              task: { fullName: 'core/web-app', name: 'web-app' }
            }
          ]
        })
      } as unknown as Response
    }
    if (u.includes('/computer/api/json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ busyExecutors: 1, totalExecutors: 4 })
      } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jobs: [
          {
            name: 'web-app',
            fullName: 'core/web-app',
            color: 'blue_anime',
            url: 'https://jenkins.example.dev/job/core/job/web-app/',
            buildable: true,
            inQueue: true,
            lastBuild: {
              number: 18,
              result: null,
              building: true,
              timestamp: 1700000000000,
              duration: 0,
              estimatedDuration: 60000,
              url: 'https://jenkins.example.dev/job/core/job/web-app/18/'
            }
          },
          {
            name: 'billing-worker',
            fullName: 'core/billing-worker',
            color: 'red',
            url: 'https://jenkins.example.dev/job/core/job/billing-worker/',
            buildable: true,
            inQueue: false,
            lastBuild: {
              number: 9,
              result: 'FAILURE',
              building: false,
              timestamp: 1699999000000,
              duration: 12000,
              url: 'https://jenkins.example.dev/job/core/job/billing-worker/9/'
            }
          }
        ]
      })
    } as unknown as Response
  }) as typeof fetch

  const host = mockHost()
  activeWorker = await mountWorker(main, { host })

  const saved = await activeWorker.request('jenkins.saveConfig', {
    jenkinsUrl: 'https://jenkins.example.dev/',
    username: 'demo',
    apiToken: 'tok_example_123456',
    pollIntervalSec: 30
  })

  assert.equal(saved.ok, true, saved.error)
  assert.equal(saved.userDisplayName, 'Demo User')
  assert.equal(saved.dashboard?.counts.building, 1)
  assert.equal(saved.dashboard?.counts.failed, 1)
  assert.equal(saved.dashboard?.counts.queue, 1)
  assert.equal(saved.dashboard?.executors.busy, 1)
  assert.equal(saved.dashboard?.executors.total, 4)
  assert.ok(seenUrls.some((u) => u.includes('/me/api/json')))
  assert.deepEqual(activeWorker.refusals, [])
})

const favoriteTestSettings = {
  jenkinsUrl: 'https://jenkins.example.invalid',
  username: 'demo',
  apiToken: 'x'.repeat(8)
}

function mockLargeDashboard() {
  const jobs = Array.from({ length: 1040 }, (_, i) => {
    const name = `synthetic-job-${String(i).padStart(4, '0')}`
    const url = `${favoriteTestSettings.jenkinsUrl}/job/${name}/`
    return {
      name, fullName: name, url, color: 'blue',
      lastBuild: {
        number: 42, result: 'SUCCESS', building: false, timestamp: 1700000000000,
        duration: 15000, url: `${url}42/`
      }
    }
  })
  const requests: string[] = []
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    requests.push(path)
    return Response.json(path === '/api/json' ? { jobs } : {})
  }
  return requests
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

test('toggles favorites on a 1,040-job dashboard without a fetch or push', async () => {
  const requests = mockLargeDashboard()
  const host = mockHost({ settings: favoriteTestSettings })
  activeWorker = await mountWorker(main, { host })
  const dashboard = await activeWorker.request('jenkins.dashboard', { force: true })
  assert.equal(dashboard.jobs.length, 1040)
  assert.ok(jsonBytes(dashboard) > 256 * 1024)

  const fullName = 'synthetic-job-0001'
  requests.length = 0
  const reply = await activeWorker.request('jenkins.toggleFavorite', { fullName })
  assert.deepEqual(reply, { ok: true, favorites: [fullName] })
  assert.ok(jsonBytes(reply) < 1024)
  assert.deepEqual(await activeWorker.request('jenkins.toggleFavorite', { fullName }), {
    ok: true, favorites: []
  })
  assert.deepEqual(requests, [], 'a favorite toggle must not fetch Jenkins')
  assert.deepEqual(activeWorker.posts.map(({ event }) => event), [], 'a toggle must not push a dashboard')
})

test('keeps a 1,040-job panel in sync from favorite replies despite stale data', async (t) => {
  const requests = mockLargeDashboard()
  let dashboard: JenkinsDashboardData
  let finishDashboard!: (data: JenkinsDashboardData) => void
  let finishDetail!: (detail: JenkinsJobDetail) => void
  const staleDashboard = new Promise<JenkinsDashboardData>((resolve) => { finishDashboard = resolve })
  const staleDetail = new Promise<JenkinsJobDetail>((resolve) => { finishDetail = resolve })
  const host = mockHost({
    settings: favoriteTestSettings,
    requests: {
      'jenkins.dashboard': (input) => input?.force ? staleDashboard : dashboard,
      'jenkins.jobDetail': () => staleDetail
    }
  })
  activeWorker = await mountWorker(main, { host })
  dashboard = await activeWorker.request('jenkins.dashboard', { force: true })
  const job = dashboard.jobs.find((job) => job.fullName === 'synthetic-job-0001')!
  const ui = await mount(panel, { host, persisted: { plugin: { defaultViewTab: 'jobs' } } })
  t.after(() => ui.unmount())
  const button = (text: string) => ({ type: 'Button', text })
  const filter = { type: 'Tabs', label: 'Status Filter' }
  const firstStar = ui.findAll(button('☆'))[0]!
  const targetStar = ui.findAll(button('☆'))[1]!
  requests.length = 0
  const callCount = host.callsOf('plugin.request').length
  await Promise.all([ui.press(targetStar), ui.press(targetStar), ui.press(firstStar)])
  assert.ok(ui.find(button('★')), 'the row updates without a dashboard event')
  assert.equal(ui.findAll({ type: 'Button', text: /^synthetic-job-/ })[0]?.text, job.name)
  assert.deepEqual(host.callsOf('plugin.request').slice(callCount), [
    { name: 'jenkins.toggleFavorite', input: { fullName: job.fullName } }
  ])
  assert.deepEqual(requests, [])
  assert.deepEqual(activeWorker.posts.map(({ event }) => event), [])

  await ui.post('jenkins.refreshed', dashboard)
  assert.ok(ui.find(button('★')), 'a stale push must not undo a star')
  await ui.select(filter, 'favorites')
  assert.ok(ui.find(button(job.name)))

  const actions = [
    ui.press({ type: 'IconButton', label: 'Refresh Jenkins' }),
    ui.press(button(job.name))
  ]
  const staleJob = { ...job, isFavorite: true }
  try {
    // Actions wait for all host requests, but another settle pass can render pending state.
    await new Promise<void>(setImmediate)
    actions.push(ui.press(button('★ Starred')), ui.settled())
    await new Promise<void>(setImmediate)
    assert.ok(ui.find(button('☆ Star')), 'the detail star updates before either read completes')
  } finally {
    finishDetail({ job: staleJob, builds: [], parameters: [] })
    finishDashboard({
      ...dashboard, fromCache: true,
      jobs: dashboard.jobs.map((entry) => entry === job ? staleJob : entry)
    })
    await Promise.all(actions)
  }
  assert.ok(ui.find(button('☆ Star')), 'a late detail response must not restore a removed star')
  await ui.press(button('← Back'))
  assert.ok(ui.find({ type: 'Badge', text: 'Cached' }))
  assert.equal(ui.find(button(job.name)), null, 'the late cached dashboard must not restore the favorite')
  assert.deepEqual(ui.errors, [])
})

test('shows favorite failures without changing the saved star and permits retry', async (t) => {
  const job = {
    name: 'synthetic-job', fullName: 'synthetic-job', url: 'https://jenkins.example.invalid/job/synthetic-job/',
    status: 'success' as const, color: 'blue', building: false, buildable: true, inQueue: false
  }
  const host = mockHost({ requests: {
    'jenkins.dashboard': {
      jobs: [job], queue: [], activeBuilds: [], executors: { busy: 0, total: 0 },
      counts: { building: 0, failed: 0, unstable: 0, success: 1, total: 1, queue: 0 }, fetchedAt: 0
    }
  } })
  const ui = await mount(panel, { host, persisted: { plugin: { defaultViewTab: 'jobs' } } })
  t.after(() => ui.unmount())
  const star = { type: 'Button', text: '☆' }
  let failWrite!: (error: Error) => void
  const failedWrite = new Promise<never>((_, reject) => { failWrite = reject })
  host.respond('plugin.request', () => failedWrite)
  const pressing = ui.press(star)
  try {
    await new Promise<void>(setImmediate)
    assert.equal(ui.find(star)?.disabled, true)
  } finally {
    failWrite(new Error('Storage unavailable'))
    await pressing
  }
  assert.ok(ui.find({ type: 'Callout', label: 'Failed to update favorite' }))
  assert.ok(ui.find({ type: 'Text', text: 'Storage unavailable' }))
  assert.equal(ui.find(star)?.disabled, false)

  host.respond('plugin.request', { output: { ok: false, favorites: [job.fullName] } })
  await ui.press(star)
  assert.ok(ui.find({ type: 'Callout', label: 'Failed to update favorite' }))
  assert.equal(ui.find(star)?.disabled, false)

  host.respond('plugin.request', { output: { ok: true, favorites: [job.fullName] } })
  await ui.press(star)
  assert.ok(ui.find({ type: 'Button', text: '★' }))
  assert.equal(ui.find({ type: 'Callout', label: 'Failed to update favorite' }), null)
})

test('fetches jobDetail, triggers parameterized build with crumb, and reads consoleLog', async () => {
  let triggeredBody = ''
  let triggeredCrumb = ''

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/crumbIssuer/api/json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ crumbRequestField: 'Jenkins-Crumb', crumb: 'crumb-abc' })
      } as unknown as Response
    }
    if (u.includes('/buildWithParameters')) {
      triggeredBody = String(init?.body ?? '')
      triggeredCrumb = (init?.headers as Record<string, string>)['Jenkins-Crumb'] ?? ''
      return {
        ok: true,
        status: 201,
        headers: new Headers({ Location: 'https://jenkins.example.dev/queue/item/55/' })
      } as unknown as Response
    }
    if (u.includes('/logText/progressiveText')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'X-Text-Size': '25', 'X-More-Data': 'false' }),
        text: async () => 'Started by user Demo\nOK\n'
      } as unknown as Response
    }
    if (u.includes('/42/api/json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ number: 42, building: false, result: 'SUCCESS' })
      } as unknown as Response
    }
    if (u.includes('/job/deploy-prod/api/json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'deploy-prod',
          fullName: 'deploy-prod',
          color: 'blue',
          url: 'https://jenkins.example.dev/job/deploy-prod/',
          buildable: true,
          inQueue: false,
          property: [
            {
              parameterDefinitions: [
                {
                  name: 'ENV',
                  type: 'ChoiceParameterDefinition',
                  choices: ['staging', 'production'],
                  defaultParameterValue: { value: 'staging' }
                },
                {
                  name: 'DRY_RUN',
                  type: 'BooleanParameterDefinition',
                  defaultParameterValue: { value: true }
                }
              ]
            }
          ],
          builds: [
            {
              number: 42,
              result: 'SUCCESS',
              building: false,
              timestamp: 1700000000000,
              duration: 45000,
              url: 'https://jenkins.example.dev/job/deploy-prod/42/',
              actions: [{ causes: [{ shortDescription: 'Started by user Demo' }] }]
            }
          ]
        })
      } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ jobs: [], items: [], busyExecutors: 0, totalExecutors: 2 })
    } as unknown as Response
  }) as typeof fetch

  const host = mockHost({
    settings: {
      jenkinsUrl: 'https://jenkins.example.dev',
      username: 'demo',
      apiToken: 'tok_example_123456'
    }
  })
  activeWorker = await mountWorker(main, { host })

  const detail = await activeWorker.request('jenkins.jobDetail', { fullName: 'deploy-prod' })
  assert.equal(detail.parameters.length, 2)
  assert.equal(detail.builds[0]?.cause, 'Started by user Demo')

  const trigger = await activeWorker.request('jenkins.triggerBuild', {
    fullName: 'deploy-prod',
    parameters: { ENV: 'production', DRY_RUN: false }
  })
  assert.equal(trigger.ok, true)
  assert.equal(triggeredCrumb, 'crumb-abc')
  assert.ok(triggeredBody.includes('ENV=production'))
  assert.ok(triggeredBody.includes('DRY_RUN=false'))

  const log = await activeWorker.request('jenkins.consoleLog', {
    fullName: 'deploy-prod',
    buildNumber: 42,
    start: 0
  })
  assert.equal(log.buildNumber, 42)
  assert.equal(log.result, 'SUCCESS')
  assert.ok(log.text.includes('Started by user Demo'))
})
