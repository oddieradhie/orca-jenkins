import { defineCheck } from 'orca/testing'

const mockJobs = [
  {
    fullName: 'core/api-gateway',
    name: 'api-gateway',
    folder: 'core',
    color: 'blue_anime',
    status: 'building' as const,
    building: true,
    url: 'https://jenkins.example.dev/job/core/job/api-gateway/',
    buildable: true,
    inQueue: false,
    isFavorite: true,
    lastBuild: {
      number: 128,
      result: null,
      building: true,
      timestamp: Date.now() - 25000,
      duration: 0,
      estimatedDuration: 60000,
      url: 'https://jenkins.example.dev/job/core/job/api-gateway/128/'
    }
  },
  {
    fullName: 'core/billing-service',
    name: 'billing-service',
    folder: 'core',
    color: 'red',
    status: 'failed' as const,
    building: false,
    url: 'https://jenkins.example.dev/job/core/job/billing-service/',
    buildable: true,
    inQueue: false,
    isFavorite: false,
    lastBuild: {
      number: 54,
      result: 'FAILURE',
      building: false,
      timestamp: Date.now() - 300000,
      duration: 42000,
      url: 'https://jenkins.example.dev/job/core/job/billing-service/54/'
    }
  },
  {
    fullName: 'mobile/android-release',
    name: 'android-release',
    folder: 'mobile',
    color: 'blue',
    status: 'success' as const,
    building: false,
    url: 'https://jenkins.example.dev/job/mobile/job/android-release/',
    buildable: true,
    inQueue: false,
    isFavorite: false,
    lastBuild: {
      number: 19,
      result: 'SUCCESS',
      building: false,
      timestamp: Date.now() - 3600000,
      duration: 185000,
      url: 'https://jenkins.example.dev/job/mobile/job/android-release/19/'
    }
  }
]

const mockQueue = [
  {
    id: 77,
    jobName: 'core/auth-service',
    buildNumber: 129,
    why: 'Waiting for next available executor',
    stuck: false,
    blocked: false,
    buildable: true,
    inQueueSince: Date.now() - 15000
  }
]

export default defineCheck({
  setupRequired: {
    requests: {
      'jenkins.dashboard': {
        jobs: [],
        queue: [],
        activeBuilds: [],
        executors: { busy: 0, total: 0 },
        counts: { building: 0, failed: 0, unstable: 0, success: 0, total: 0, queue: 0 },
        fetchedAt: 0,
        needsSetup: true,
        config: {
          jenkinsUrl: '',
          username: '',
          hasToken: false,
          tokenPreview: '',
          pollIntervalSec: 30,
          viewName: ''
        }
      }
    }
  },
  dashboardLoaded: {
    requests: {
      'jenkins.dashboard': {
        jobs: mockJobs,
        queue: mockQueue,
        activeBuilds: [
          {
            jobFullName: 'core/api-gateway',
            displayName: 'core/api-gateway #128',
            number: 128,
            building: true,
            result: null,
            timestamp: Date.now() - 25000,
            duration: 25000,
            estimatedDuration: 60000,
            url: 'https://jenkins.example.dev/job/core/job/api-gateway/128/',
            executor: 'Built-In Node'
          }
        ],
        executors: { busy: 1, total: 4 },
        counts: { building: 1, failed: 1, unstable: 0, success: 1, total: 3, queue: 1 },
        fetchedAt: Date.now(),
        needsSetup: false,
        config: {
          jenkinsUrl: 'https://jenkins.example.dev',
          username: 'demo',
          hasToken: true,
          tokenPreview: 'tok_••••3456',
          pollIntervalSec: 30,
          viewName: ''
        }
      }
    }
  }
})
