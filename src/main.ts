import * as core from '@actions/core'
import * as github from '@actions/github'
import { Resource } from '@opentelemetry/resources'
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  SpanExporter
} from '@opentelemetry/sdk-trace-base'
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions'
import {
  WorkflowRunCompletedEvent,
  WorkflowStep
} from '@octokit/webhooks-types'
import { OTLPTraceExporter as OTLPHttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { Endpoints } from '@octokit/types'
import {
  Context,
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  ROOT_CONTEXT,
  Span,
  SpanStatusCode,
  trace,
  Tracer,
  TracerProvider
} from '@opentelemetry/api'

// Type for the list jobs for a workflow run response
type ListJobsForWorkflowRunResponse =
  Endpoints['GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs']['response']
export type Job =
  Endpoints['GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs']['response']['data']['jobs'][number]

export const setSpanStatus = (span: Span, success: boolean): void => {
  if (success) {
    span.setStatus({
      code: SpanStatusCode.OK,
      message: 'OK'
    })
  } else {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: 'ERROR'
    })
  }
}

export async function processSteps(
  steps: WorkflowStep[],
  tracer: Tracer,
  jobCtx: Context
): Promise<void> {
  for (const step of steps) {
    tracer.startActiveSpan(
      step.name,
      {
        startTime: step.started_at ? new Date(step.started_at) : undefined
      },
      jobCtx,
      span => {
        span.setAttributes(
          removeUndefinedProperties({
            'step.number': step.number,
            'step.status': step.status,
            'step.started_at': step.started_at ? step.started_at : undefined,
            'step.conclusion': step.conclusion ? step.conclusion : undefined
          })
        )

        // set status of step
        setSpanStatus(span, step.conclusion === 'success')

        // End the step span
        span.end(step.completed_at ? new Date(step.completed_at) : undefined)
      }
    )
  }
}

export async function processJob(
  job: Job,
  tracer: Tracer,
  parentCtx: Context
): Promise<void> {
  // Using startActiveSpan to ensure context is passed between children
  await tracer.startActiveSpan(
    `Job: ${job.name}`,
    {
      startTime: job.started_at ? new Date(job.started_at) : undefined,
      attributes: {
        'job.id': job.id,
        'job.status': job.status
      }
    },
    parentCtx,
    async (span: Span) => {
      try {
        // set status of job
        setSpanStatus(span, job.conclusion === 'success')
        // If the job has steps, create spans for each step
        if (job.steps && Array.isArray(job.steps)) {
          // span now represents active span
          const jobCtx = trace.setSpan(context.active(), span)
          await processSteps(job.steps as WorkflowStep[], tracer, jobCtx)
        }
      } catch (e) {
        core.setFailed(`Failed to process job ${job.name}`)
      } finally {
        span.end(job.completed_at ? new Date(job.completed_at) : undefined)
      }
    }
  )
}

export async function handleJobsAndSteps(
  tracer: Tracer,
  span: Span,
  jobs: Job[],
  rootAttributes: Record<string, number | string | undefined>,
  processJobFn: (
    jobF: Job,
    tracerF: Tracer,
    parentCtxF: Context
  ) => Promise<void>
): Promise<void> {
  const anyJobError = jobs.some(job => job.conclusion !== 'success')

  span.setStatus({
    code: anyJobError ? SpanStatusCode.ERROR : SpanStatusCode.OK
  })

  span.setAttributes(removeUndefinedProperties(rootAttributes))

  await Promise.all(
    jobs.map(async job => {
      try {
        const ctx = trace.setSpan(ROOT_CONTEXT, span)
        await processJobFn(job, tracer, ctx)
      } catch (error) {
        console.error(`Failed processing job ${job.name} - ${error}`)
      }
    })
  )
}

async function createSpansForJobsAndSteps(
  startTime: string,
  jobs: Job[],
  tracer: Tracer,
  rootAttributes: Record<string, number | string | undefined>
): Promise<void> {
  await tracer.startActiveSpan(
    'root',
    {
      root: true,
      startTime: new Date(startTime)
    },
    ROOT_CONTEXT,
    async (span: Span): Promise<void> => {
      try {
        await handleJobsAndSteps(tracer, span, jobs, rootAttributes, processJob)
      } catch (e) {
        core.setFailed(`Failed to parse jobs and steps: ${e}`)
      } finally {
        // end the span on the last completed jobs time
        const completedJobs = jobs.filter(job => job.status === 'completed')
        const lastCompletedJob = completedJobs.reduce((prev, current) =>
          ((prev.completed_at && Date.parse(prev.completed_at)) || 0) >
          ((current.completed_at && Date.parse(current.completed_at)) || 0)
            ? prev
            : current
        )

        diag.debug(`completed at: ${lastCompletedJob.completed_at}`)

        span.end(
          lastCompletedJob.completed_at
            ? new Date(lastCompletedJob.completed_at)
            : undefined
        )
      }
    }
  )
}

// utilities

export function removeUndefinedProperties(
  obj: Record<string, number | string | undefined>
): Record<string, number | string> {
  return Object.entries(obj).reduce(
    (acc: Record<string, number | string>, [key, value]) => {
      if (value !== undefined) {
        acc[key] = value
      }
      return acc
    },
    {}
  )
}

// Define the function to fetch workflow jobs details with a specific return type
const fetchWorkflowJobs = async (
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  runId: number
): Promise<ListJobsForWorkflowRunResponse['data']> => {
  const response = await octokit.rest.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: runId
  })

  core.debug(`response: ${JSON.stringify(response)}`)

  return response.data
}

function createProvider(
  otelServiceName: string,
  payload: WorkflowRunCompletedEvent,
  grafanaEndpoint: string,
  grafanaInstanceID: string,
  grafanaAccessToken: string
): TracerProvider {
  const serviceName = otelServiceName || payload.workflow_run.name
  const serviceInstanceId = [
    payload.workflow_run.repository.full_name,
    payload.workflow_run.workflow_id,
    payload.workflow_run.id,
    payload.workflow_run.run_attempt
  ].join('/')
  const serviceNamespace = payload.workflow_run.repository.full_name
  const serviceVersion = payload.workflow_run.head_sha

  const traceProvider = new BasicTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_INSTANCE_ID]: serviceInstanceId,
      [SemanticResourceAttributes.SERVICE_NAMESPACE]: serviceNamespace,
      [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion
    })
  })

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG)

  const credentials = `${grafanaInstanceID}:${grafanaAccessToken}`
  const encodedCredentials = Buffer.from(credentials).toString('base64')
  const authHeader = `Basic ${encodedCredentials}`

  const exporter: SpanExporter = new OTLPHttpTraceExporter({
    url: grafanaEndpoint,
    headers: {
      Authorization: authHeader
    }
  })

  traceProvider.addSpanProcessor(new SimpleSpanProcessor(exporter))
  traceProvider.register()

  return traceProvider
}

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    // inputs
    const grafanaEndpoint: string = core.getInput('grafanaEndpoint')
    const grafanaInstanceID: string = core.getInput('grafanaInstanceID')
    const grafanaAccessToken: string = core.getInput('grafanaAccessPolicyToken')
    const otelServiceName: string = core.getInput('otelServiceName')

    // set up github related things, cast payload to a usable type
    const githubToken =
      core.getInput('githubToken') || process.env.GITHUB_TOKEN || ''
    const githubContext = github.context

    core.debug('checking workflow type')

    if (githubContext.eventName !== 'workflow_run') {
      core.setFailed('This action only works with workflow_run events')
      return
    }

    const payload: WorkflowRunCompletedEvent =
      githubContext.payload as WorkflowRunCompletedEvent
    const runId = githubContext.payload.workflow_run.id

    const octokit = github.getOctokit(githubToken)

    core.debug('creating provider')
    const provider = createProvider(
      otelServiceName,
      payload,
      grafanaEndpoint,
      grafanaInstanceID,
      grafanaAccessToken
    )

    core.debug('fetching workflow jobs')
    // fetch workflow run details
    const workflowJobsDetails = await fetchWorkflowJobs(
      octokit,
      githubContext.repo.owner,
      githubContext.repo.repo,
      runId
    )

    const tracer = provider.getTracer('grafana-exporter')

    const rootAttributes = {
      'jobs.total_count': workflowJobsDetails.total_count,
      'workflow_run.id': payload.workflow_run.id,
      'workflow_run.name': payload.workflow_run.name,
      'workflow_run.head_sha': payload.workflow_run.head_sha,
      'workflow_run.repository': payload.workflow_run.repository.full_name,
      'workflow_run.workflow_id': payload.workflow_run.workflow_id,
      'workflow_run.run_number': payload.workflow_run.run_number,
      'workflow_run.run_attempt': payload.workflow_run.run_attempt,
      'workflow_run.event': payload.workflow_run.event,
      'workflow_run.status': payload.workflow_run.status,
      'workflow_run.conclusion': payload.workflow_run.conclusion,
      'workflow_run.created_at': payload.workflow_run.created_at,
      'workflow_run.updated_at': payload.workflow_run.updated_at,
      'workflow_run.url': payload.workflow_run.url,
      'workflow_run.html_url': payload.workflow_run.html_url,
      'workflow_run.jobs_url': payload.workflow_run.jobs_url,
      'workflow_run.logs_url': payload.workflow_run.logs_url,
      'workflow_run.check_suite_url': payload.workflow_run.check_suite_url,
      'workflow_run.artifacts_url': payload.workflow_run.artifacts_url,
      'workflow_run.cancel_url': payload.workflow_run.cancel_url,
      'workflow_run.rerun_url': payload.workflow_run.rerun_url,
      'workflow_run.workflow_url': payload.workflow_run.workflow_url,
      'workflow_run.head_branch': payload.workflow_run.head_branch,
      'workflow_run.head_repository':
        payload.workflow_run.head_repository.full_name,
      'workflow_run.head_repository_url':
        payload.workflow_run.head_repository.html_url
    }

    const startTime =
      payload.workflow_run.run_started_at || payload.workflow_run.created_at

    await createSpansForJobsAndSteps(
      startTime,
      workflowJobsDetails.jobs,
      tracer,
      rootAttributes
    )
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
