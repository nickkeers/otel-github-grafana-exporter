import * as core from '@actions/core'
import * as github from '@actions/github'
import { Resource } from '@opentelemetry/resources'
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  SpanExporter
} from '@opentelemetry/sdk-trace-base'
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions'
import { WorkflowRunCompletedEvent } from '@octokit/webhooks-types'
import { OTLPTraceExporter as OTLPHttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { Endpoints } from '@octokit/types'
import {
  DiagConsoleLogger,
  DiagLogLevel,
  Span,
  SpanStatusCode,
  Tracer,
  TracerProvider,
  context,
  diag,
  trace
} from '@opentelemetry/api'

// Type for the list jobs for a workflow run response
type ListJobsForWorkflowRunResponse =
  Endpoints['GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs']['response']
type Job =
  Endpoints['GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs']['response']['data']['jobs'][number]

async function createSpansForJobsAndSteps(
  jobs: Job[],
  tracer: Tracer,
  rootSpan: Span
): Promise<void> {
  const parentCtx = trace.setSpan(context.active(), rootSpan)

  await Promise.all(
    jobs.map(async job => {
      // Create a span for the job
      const jobSpan = tracer.startSpan(
        `Job: ${job.name}`,
        {
          attributes: {
            'job.id': job.id,
            'job.status': job.status
          }
        },
        parentCtx
      )

      // If the job has steps, create spans for each step
      if (job.steps) {
        const jobCtx = trace.setSpan(context.active(), jobSpan)

        for (const step of job.steps) {
          const stepSpan = tracer.startSpan(
            `Step: ${step.name}`,
            {
              attributes: {
                'step.number': step.number,
                'step.status': step.status
                // ... other step-specific attributes
              }
            },
            jobCtx
          )

          // End the step span
          stepSpan.end(
            step.completed_at ? new Date(step.completed_at) : undefined
          )
        }
      }

      // End the job span
      jobSpan.end(job.completed_at ? new Date(job.completed_at) : undefined)
    })
  )
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
      throw new Error('This action only works with workflow_run events')
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

    // Start the root span with the given attributes
    const rootSpan = tracer.startSpan('root', {
      attributes: {
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
    })

    if (payload.workflow_run.conclusion === 'success') {
      // set success
      rootSpan.setStatus({
        code: SpanStatusCode.OK,
        message: `conclusion: ${payload.workflow_run.conclusion}`
      })
    } else {
      // set error
      rootSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: `conclusion: ${payload.workflow_run.conclusion}`
      })
    }

    await createSpansForJobsAndSteps(workflowJobsDetails.jobs, tracer, rootSpan)
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
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
  // let exporter: SpanExporter = new ConsoleSpanExporter();

  traceProvider.addSpanProcessor(new SimpleSpanProcessor(exporter))
  traceProvider.register()

  return traceProvider
}
