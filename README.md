# OpenTelementry Grafana Exporter

Welcome to the OpenTelemetry GitHub Grafana Exporter project. This project is designed to collect tracing data from your
GitHub workflows and make it viewable in Grafana Cloud (Tempo)

## Using the Github action

Set up a workflow that runs `on: workflow_run` like below:

```yaml
on:
   workflow_run:
      types:
         - completed


jobs:
   test-action:
      name: GitHub Actions Test
      runs-on: ubuntu-latest

      steps:
         - name: Checkout
           id: checkout
           uses: actions/checkout@v4

         - name: Test Local Action
           id: test-action
           uses: ./
           with:
              grafanaEndpoint: ${{ secrets.GRAFANA_URL }}
              grafanaInstanceID: ${{ secrets.GRAFANA_INSTANCE_ID }}
              grafanaAccessPolicyToken: ${{ secrets.GRAFANA_TOKEN }}
              githubToken: ${{ secrets.GITHUB_TOKEN }}
              otelServiceName: "grafana-exporter-test"
```

This will run for all completed workflows.

## Action parameters:

Please read this guide from grafana
first: [Send Data using OpenTelemetry](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/)

* `grafanaEndpoint` - your OpenTelemetry URL for Grafana
* `grafanaInstanceID` - your Grafana instance ID
* `grafanaAccessPolicyToken` - a token generated to allow you to send OTel data to Grafana
* `githubToken` - github token for the repo, we have to pass it explicitly as the action will pull down details of the
  workflow run using this token
* `otelServiceName` - this is used as the service name in OTel metadata