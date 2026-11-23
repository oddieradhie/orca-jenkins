import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
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
