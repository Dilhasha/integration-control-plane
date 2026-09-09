/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { downloadConfigBundle } from './moesifConfigBundle';

// Runtime-side configuration for publishing WSO2 Integrator: MI (Micro
// Integrator) logs to Moesif. Unlike BI (which uses a Fluent Bit sidecar), MI
// already writes its server logs to <MI_HOME>/repository/logs/wso2carbon.log by
// default, so no MI-side configuration change is required. An OpenTelemetry
// Collector sidecar tails that file and forwards the entries to Moesif's OTLP
// logs endpoint (/v1/logs). The bundled files below make up that sidecar:
//   - otel-collector-config.yaml : the Collector pipeline (filelog receiver ->
//                                  resource + attributes processors ->
//                                  otlphttp/logs exporter)
//   - docker-compose.yaml        : runs the otel/opentelemetry-collector-contrib
//                                  container, mounting the MI log directory and
//                                  the config above
//   - .env                       : the values the user fills in (Collector
//                                  Application ID, ICP runtime id, MI_HOME)
//
// Every shipped record is tagged with the ICP runtime id as a log attribute
// (icp_runtimeid). Moesif stores log attributes that have no dedicated mapping
// under `metadata`, so the embedded logs canvas (shared with BI) can scope
// itself to an integration's runtimes through its `runtimeId` context filter on
// `metadata.icp_runtimeid.raw` (see moesifBiLogsCanvas.json). A sidecar tails a
// single runtime's log directory, so the id is a per-sidecar .env value.
// Based on the WSO2 MI Moesif logs setup guide:
// https://mi.docs.wso2.com/en/latest/observe-and-manage/classic-observability-logs/moesif-logs/

// otel-collector-config.yaml: tails the MI wso2carbon.log file, tags each record
// with the service.name resource attribute and the ICP runtime id log attribute
// (the field the logs canvas' Runtime filter matches on), and ships them to
// Moesif's OTLP logs endpoint using the Collector Application ID header. The
// Collector Application ID, host and runtime id are read from the container
// environment (see docker-compose.yaml) via ${env:...} expansion so the same
// config works for any application.
const MI_LOGS_OTEL_COLLECTOR_CONFIG_YAML = `receivers:
  filelog:
    include: [ /var/log/wso2mi/wso2carbon.log ]
    start_at: end
    storage: file_storage

processors:
  resource:
    attributes:
    - key: service.name
      value: "WSO2-MI"
      action: upsert

  # Log-record attribute (not a resource attribute): Moesif keeps unmapped log
  # attributes under \`metadata\`, so this lands as metadata.icp_runtimeid — the
  # field the logs canvas' Runtime filter matches on. Must be the runtime id as
  # ICP knows it.
  attributes:
    actions:
    - key: icp_runtimeid
      value: \${env:ICP_RUNTIME_ID}
      action: upsert

exporters:
  otlphttp/logs:
    logs_endpoint: https://\${env:MOESIF_HOST}/v1/logs
    headers:
      X-Moesif-Application-Id: \${env:MOESIF_APPLICATION_ID}

extensions:
  file_storage:
    directory: /etc/otelcol-contrib/.data
    create_directory: true

service:
  extensions: [ file_storage ]
  pipelines:
    logs:
      receivers: [ filelog ]
      processors: [ resource, attributes ]
      exporters: [ otlphttp/logs ]
`;

// docker-compose.yaml: runs the OpenTelemetry Collector sidecar. Mounts the MI
// log directory (MI_HOME/repository/logs) read-only into the container and
// passes the Moesif app id, host and ICP runtime id through as environment
// variables (consumed by the config above). The .data volume persists the
// filelog read offset so the Collector resumes where it left off after a
// restart.
const MI_LOGS_DOCKER_COMPOSE_YAML = `services:
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    container_name: otel-collector-moesif-mi
    volumes:
      - \${MI_HOME}/repository/logs:/var/log/wso2mi:ro
      - ./otel-collector-config.yaml:/etc/otelcol-contrib/config.yaml:ro
      - otel-collector-mi-data:/etc/otelcol-contrib/.data
    command: ["--config", "/etc/otelcol-contrib/config.yaml"]
    environment:
      - MOESIF_APPLICATION_ID=\${MOESIF_APPLICATION_ID}
      - MOESIF_HOST=\${MOESIF_HOST:-api.moesif.net}
      - ICP_RUNTIME_ID=\${ICP_RUNTIME_ID:-}
    restart: unless-stopped

volumes:
  otel-collector-mi-data:
`;

// Builds the .env file, injecting the selected Moesif Collector Application ID.
// MI_HOME must be set by the user to their MI installation path (its
// repository/logs directory is mounted into the Collector), and ICP_RUNTIME_ID
// to the runtime whose logs this sidecar ships.
export function miLogsOtelEnv(applicationId: string): string {
  return `# Moesif Collector Application Id (Account -> API Keys -> Collector Application Id)
# Sent as the X-Moesif-Application-Id header on the OTLP /v1/logs requests.
MOESIF_APPLICATION_ID=${applicationId}

# Absolute path to the MI installation (its repository/logs is mounted into the Collector)
MI_HOME=<MI_HOME>

# The ICP runtime id whose logs this sidecar ships, copied from the runtime's
# details in ICP. Sent on every record as the icp_runtimeid log attribute and
# matched by the Runtime filter on the ICP logs dashboard, so logs stay
# attributed to the right runtime. Run one sidecar per runtime.
ICP_RUNTIME_ID=<RUNTIME_ID>

# Moesif collector host (api.moesif.net for production)
MOESIF_HOST=api.moesif.net
`;
}

// The static Collector files that make up the sidecar, keyed by filename. The
// .env is generated separately since it embeds the Collector Application ID.
export const MI_LOGS_OTEL_FILES: Record<string, string> = {
  'otel-collector-config.yaml': MI_LOGS_OTEL_COLLECTOR_CONFIG_YAML,
  'docker-compose.yaml': MI_LOGS_DOCKER_COMPOSE_YAML,
};

// The folder the zip entries live under, so unzipping produces a single tidy
// directory the user can `cd` into and run `docker compose up -d`.
const MI_LOGS_OTEL_ZIP_FOLDER = 'moesif-otel-collector-logs';

// Suggested filename when the user downloads the Collector config bundle.
export const MI_LOGS_OTEL_ZIP_FILENAME = 'moesif-otel-collector-logs.zip';

// Downloads all OpenTelemetry Collector sidecar files (including a .env with the
// supplied Collector Application ID) as a single zip. The user unzips it, sets
// MI_HOME, the ICP runtime id + the Collector Application ID in the .env, then
// runs `docker compose up -d`.
export function downloadMoesifMiLogsOtelFiles(applicationId: string): void {
  const entries: Record<string, string> = { ...MI_LOGS_OTEL_FILES, '.env': miLogsOtelEnv(applicationId) };
  downloadConfigBundle(entries, MI_LOGS_OTEL_ZIP_FOLDER, MI_LOGS_OTEL_ZIP_FILENAME);
}
