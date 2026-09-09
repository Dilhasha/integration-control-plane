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

// Runtime-side configuration for publishing WSO2 Integrator: BI (Ballerina)
// logs to Moesif. BI is configured to write its logs to a file (see the
// [ballerina.log] Config.toml block in the logs setup view); a Fluent Bit
// sidecar then tails that file and forwards the entries to Moesif over OTLP
// (/v1/logs). The bundled files below make up that sidecar:
//   - fluent-bit.yaml    : the Fluent Bit pipeline (tail -> parse/severity ->
//                          OpenTelemetry envelope -> OTLP output to Moesif)
//   - docker-compose.yaml: runs the fluent/fluent-bit container, mounting the
//                          BI log directory and the config above
//   - .env               : the values the user fills in (Collector Application
//                          ID, ICP runtime id, service name, environment,
//                          log dir)
//
// Every shipped record is tagged with the ICP runtime id as an OTLP log
// attribute (icp_runtimeid). Moesif stores log attributes that have no dedicated
// mapping under `metadata`, so the embedded logs canvas can scope itself to an
// integration's runtimes through its `runtimeId` context filter on
// `metadata.icp_runtimeid.raw` (see moesifBiLogsCanvas.json). A sidecar tails a
// single runtime's log directory, so the id is a per-sidecar .env value.

// docker-compose.yaml: runs the Fluent Bit sidecar. Mounts the BI log directory
// (BALLERINA_LOG_DIR) read-only into the container and passes the Moesif app id,
// ICP runtime id, service name and environment through as environment
// variables.
const BI_LOGS_DOCKER_COMPOSE_YAML = `services:
  fluent-bit:
    image: fluent/fluent-bit:3.2
    container_name: fluent-bit-moesif-otel-bi
    volumes:
      - \${BALLERINA_LOG_DIR}:/app/logs:ro
      - ./fluent-bit.yaml:/fluent-bit/etc/fluent-bit.yaml:ro
      - fluent-bit-otel-bi-db:/var/log
    command: ["/fluent-bit/bin/fluent-bit", "-c", "/fluent-bit/etc/fluent-bit.yaml"]
    environment:
      - MOESIF_APPLICATION_ID=\${MOESIF_APPLICATION_ID}
      - LOG_FILE_PATH=\${LOG_FILE_PATH:-/app/logs/app.log}
      - MOESIF_HOST=\${MOESIF_HOST:-api.moesif.net}
      - ICP_RUNTIME_ID=\${ICP_RUNTIME_ID:-}
      - OTEL_SERVICE_NAME=\${OTEL_SERVICE_NAME:-ballerina-service}
      - DEPLOYMENT_ENVIRONMENT=\${DEPLOYMENT_ENVIRONMENT:-prod}
    # Fluent Bit's HTTP server (health endpoint) is exposed on 2020. The
    # fluent/fluent-bit image is distroless and ships no HTTP client (curl/wget),
    # so a container-level healthcheck can't be run inside it. Monitor health
    # externally, e.g. curl -f http://localhost:2020/api/v1/health
    ports:
      - "2020:2020"
    restart: unless-stopped

volumes:
  fluent-bit-otel-bi-db:
`;

// fluent-bit.yaml: tails the BI JSON log file, derives the OTLP severity from
// the JSON "level" field, wraps records in the OpenTelemetry log schema with the
// service.name / deployment.environment resource attributes and the
// icp_runtimeid log attribute (which the logs canvas filters by), and ships them
// to Moesif's OTLP logs endpoint using the Collector Application ID header.
const BI_LOGS_FLUENT_BIT_YAML = `service:
  flush: 5
  log_level: info
  http_server: on
  http_listen: 0.0.0.0
  http_port: 2020

pipeline:
  inputs:
    - name: tail
      path: \${LOG_FILE_PATH}
      tag: ballerina.logs
      read_from_head: false          # == filelog start_at: end
      refresh_interval: 5
      buffer_max_size: 64KB
      skip_long_lines: on
      skip_empty_lines: on
      mem_buf_limit: 10MB
      inotify_watcher: false
      db: /var/log/fluent-bit-otel-bi.db # == file_storage persistence (tracks offset)

      processors:
        logs:
          # Parse the JSON log line so the "level" field is available as a
          # record key for severity mapping (== OTel Collector ParseJSON step).
          - name: parser
            key_name: log
            parser: bi_json
            reserve_data: true

          # Derive the OTLP severity_number from the JSON "level" field,
          # replicating the OTel Collector transform/severity_from_message
          # processor. Defaults to INFO (9) when the level is missing/unknown.
          - name: lua
            call: set_severity
            code: |
              function set_severity(tag, timestamp, record)
                  local level = record["level"]
                  local map = {
                      TRACE = 1,
                      DEBUG = 5,
                      INFO  = 9,
                      WARN  = 13,
                      ERROR = 17,
                      FATAL = 21
                  }
                  local num = map[level]
                  if num == nil then
                      num = 9
                      record["level"] = "INFO"
                  end
                  record["severity_number"] = num
                  return 2, timestamp, record
              end

          # Wrap plain tail records into the OpenTelemetry log schema so the
          # resource attribute below can attach correctly.
          - name: opentelemetry_envelope

          # == OTel Collector \`resource\` processor: service.name
          - name: content_modifier
            action: upsert
            context: otel_resource_attributes
            key: service.name
            value: \${OTEL_SERVICE_NAME}

          # == OTel Collector \`resource\` processor: deployment.environment
          - name: content_modifier
            action: upsert
            context: otel_resource_attributes
            key: deployment.environment
            value: \${DEPLOYMENT_ENVIRONMENT}

          # Tag every record with the ICP runtime id this sidecar ships logs for.
          # Moesif keeps unmapped log attributes under \`metadata\`, so this lands
          # as metadata.icp_runtimeid — the field the logs canvas' Runtime filter
          # matches on. Must be the runtime id as ICP knows it.
          - name: content_modifier
            action: upsert
            context: otel_log_attributes
            key: icp_runtimeid
            value: \${ICP_RUNTIME_ID}

  outputs:
    # == OTel Collector \`otlphttp/logs\` exporter -> https://<host>/v1/logs
    - name: opentelemetry
      match: ballerina.logs
      host: \${MOESIF_HOST}
      port: 443
      tls: true
      tls.verify: on
      logs_uri: /v1/logs
      # Map the JSON "level" -> SeverityText and computed "severity_number"
      # -> SeverityNumber (== OTel Collector severity mapping).
      logs_severity_text_message_key: level
      logs_severity_number_message_key: severity_number
      header:
        - X-Moesif-Application-Id \${MOESIF_APPLICATION_ID}
      log_response_payload: on
      workers: 2
      retry_limit: 3

parsers:
  - name: bi_json
    format: json
    time_key: time
    time_format: "%Y-%m-%dT%H:%M:%S.%L%z"
    time_keep: on
`;

// Builds the Fluent Bit .env file, injecting the selected Moesif Collector
// Application ID. The ICP runtime id, service name, environment and BI log
// directory are left as placeholders for the user to fill in.
export function biLogsFluentBitEnv(applicationId: string): string {
  return `# Moesif Collector Application Id (Account -> API Keys -> Collector Application Id)
# Sent as the X-Moesif-Application-Id header on the OTLP /v1/logs requests.
MOESIF_APPLICATION_ID=${applicationId}

# Absolute path (on the host) to the BI application's log directory.
# Its contents are mounted into Fluent Bit at /app/logs.
BALLERINA_LOG_DIR=<ABSOLUTE_PATH_TO_BI_LOG_DIR>

# Path (inside the container) of the log file to tail
LOG_FILE_PATH=/app/logs/app.log

# Moesif collector host (api.moesif.net for production)
MOESIF_HOST=api.moesif.net

# The ICP runtime id whose logs this sidecar ships, copied from the runtime's
# details in ICP. Sent on every record as the icp_runtimeid log attribute and
# matched by the Runtime filter on the ICP logs dashboard, so logs stay
# attributed to the right runtime. Run one sidecar per runtime.
ICP_RUNTIME_ID=<RUNTIME_ID>

# OTLP resource attribute service.name — set to your integration's service name
OTEL_SERVICE_NAME=<SERVICE_NAME>

# OTLP resource attribute deployment.environment — set to the environment name
DEPLOYMENT_ENVIRONMENT=<ENVIRONMENT>
`;
}

// The static Fluent Bit files that make up the sidecar, keyed by filename. The
// .env is generated separately since it embeds the Collector Application ID.
export const BI_LOGS_FLUENT_BIT_FILES: Record<string, string> = {
  'fluent-bit.yaml': BI_LOGS_FLUENT_BIT_YAML,
  'docker-compose.yaml': BI_LOGS_DOCKER_COMPOSE_YAML,
};

// The folder the zip entries live under, so unzipping produces a single tidy
// directory the user can `cd` into and run `docker compose up -d`.
const BI_LOGS_FLUENT_BIT_ZIP_FOLDER = 'moesif-fluent-bit-logs';

// Suggested filename when the user downloads the Fluent Bit config bundle.
export const BI_LOGS_FLUENT_BIT_ZIP_FILENAME = 'moesif-fluent-bit-logs.zip';

// Downloads all Fluent Bit sidecar files (including a .env with the supplied
// Collector Application ID) as a single zip. The user unzips it, fills in the
// .env (Collector Application ID, ICP runtime id, service name, environment, BI
// log dir), then runs `docker compose up -d`.
export function downloadMoesifBiLogsFluentBitFiles(applicationId: string): void {
  const entries: Record<string, string> = { ...BI_LOGS_FLUENT_BIT_FILES, '.env': biLogsFluentBitEnv(applicationId) };
  downloadConfigBundle(entries, BI_LOGS_FLUENT_BIT_ZIP_FOLDER, BI_LOGS_FLUENT_BIT_ZIP_FILENAME);
}
