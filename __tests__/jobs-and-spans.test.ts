import { Context, Span, SpanStatusCode, Tracer } from '@opentelemetry/api'
import {
  handleJobsAndSteps,
  Job,
  processJob,
  processSteps,
  removeUndefinedProperties
} from '../src/main'
import { WorkflowStep } from '@octokit/webhooks-types'

jest.mock('@opentelemetry/api')

const span = {
  end: jest.fn(),
  setStatus: jest.fn(),
  setAttributes: jest.fn()
}

const startActiveSpan = jest
  .fn()
  .mockImplementation((name, options, context, callback) => {
    // Check if the callback is presented and is a function
    const cb = typeof context === 'function' ? context : callback

    if (cb) {
      return cb(span)
    }

    return span
  })

const tracer = {
  startActiveSpan
} as unknown as Tracer

describe('processSteps', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('should create a span for each workflow step', async () => {
    const steps: WorkflowStep[] = [
      {
        name: 'step1',
        number: 1,
        status: 'completed',
        conclusion: 'success',
        started_at: '2023-01-01T00:00:00Z',
        completed_at: '2023-01-01T00:01:00Z'
      },
      {
        name: 'step2',
        number: 2,
        status: 'completed',
        conclusion: 'success',
        started_at: '2023-01-01T00:02:00Z',
        completed_at: '2023-01-01T00:01:00Z'
      }
    ]
    await processSteps(steps, tracer, {} as Context)
    expect(startActiveSpan).toHaveBeenCalledTimes(steps.length)
    expect(span.end).toHaveBeenCalledTimes(steps.length)
  })
})

describe('processJob', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('should start a span for a job and process its steps', async () => {
    const job = {
      id: 123,
      run_id: 456,
      run_url: 'http://example.com/run/',
      node_id: 'node123',
      head_sha: 'abcd1234',
      url: 'http://example.com/url/',
      html_url: 'http://example.com/html/',
      status: 'completed',
      name: 'someJob',
      started_at: '2023-01-01T00:00:00Z',
      completed_at: '2023-01-01T00:10:00Z',
      conclusion: 'success',
      steps: [
        {
          name: 'step1',
          number: 1,
          status: 'completed',
          conclusion: 'success',
          started_at: '2023-01-01T00:01:00Z',
          completed_at: '2023-01-01T00:01:00Z'
        }
      ]
    } as Job
    await processJob(job, tracer, {} as Context)
    expect(startActiveSpan).toHaveBeenCalledTimes(2) // 1 for the job and 1 for its step
    expect(span.end).toHaveBeenCalledTimes(2) // 1 for the job and 1 for its step
  })
})

describe('handleJobsAndSteps', () => {
  // Create a mock Span Object
  const span = {
    end: jest.fn(),
    setStatus: jest.fn(),
    setAttributes: jest.fn()
    // include other functions as needed
  } as unknown as Span

  const startActiveSpan = jest
    .fn()
    .mockImplementation((name, options, context, callback) => {
      // Check if the callback is presented and is a function
      const cb = typeof context === 'function' ? context : callback

      if (cb) {
        return cb(span)
      }

      return span
    })

  const tracer = {
    startActiveSpan
  } as unknown as Tracer

  const jobs: Job[] = [
    {
      id: 123,
      run_id: 456,
      run_url: 'http://example.com/run/',
      node_id: 'node123',
      head_sha: 'abcd1234',
      url: 'http://example.com/url/',
      html_url: 'http://example.com/html/',
      status: 'completed',
      name: 'someJob',
      started_at: '2023-01-01T00:00:00Z',
      completed_at: '2023-01-01T00:10:00Z',
      conclusion: 'success',
      workflow_name: 'test',
      runner_group_name: 'test',
      runner_group_id: 1,
      run_attempt: 1,
      runner_name: 'test',
      labels: [],
      runner_id: 123,
      head_branch: 'main',
      check_run_url: '',
      created_at: '2023-01-01T00:00:00Z',
      steps: <WorkflowStep[]>[
        {
          name: 'step1',
          number: 1,
          status: 'completed',
          conclusion: 'success',
          started_at: '2023-01-01T00:01:00Z',
          completed_at: '2023-01-01T00:01:00Z'
        }
      ]
    }
  ] // Add initialization for Job array
  let rootAttributes: Record<string, number | string | undefined> = {
    'workflow.attempt': 1
  }

  beforeEach(() => {
    const rootAttributes: Record<string, number | string | undefined> = {}
  })

  it('should set span status and attributes', async () => {
    await handleJobsAndSteps(tracer, span, jobs, rootAttributes, jest.fn())

    const isAnyJobError = jobs.some(job => job.conclusion !== 'success')

    expect(span.setStatus).toHaveBeenCalledWith({
      code: isAnyJobError ? SpanStatusCode.ERROR : SpanStatusCode.OK
    })

    expect(span.setAttributes).toHaveBeenCalledWith(
      removeUndefinedProperties(rootAttributes)
    )
  })

  it('should process all jobs', async () => {
    const processJobMock = jest.fn().mockImplementation(() => Promise.resolve())
    await handleJobsAndSteps(tracer, span, jobs, rootAttributes, processJobMock)

    expect(processJobMock).toBeCalledTimes(jobs.length) // here we're not checking context
  })

  it('should end span', async () => {
    await handleJobsAndSteps(tracer, span, jobs, rootAttributes, jest.fn())

    const completedJobs = jobs.filter(job => job.status === 'completed')
    const lastCompletedJob = completedJobs.reduce((prev, current) =>
      prev.completed_at! > current.completed_at! ? prev : current
    )
    const expectedEndTime = lastCompletedJob.completed_at
      ? new Date(lastCompletedJob.completed_at)
      : undefined

    expect(span.end).toHaveBeenCalledWith(expectedEndTime)
  })
})
