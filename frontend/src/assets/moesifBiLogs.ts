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
//                          ID, service name, environment, log dir)

// docker-compose.yaml: runs the Fluent Bit sidecar. Mounts the BI log directory
// (BALLERINA_LOG_DIR) read-only into the container and passes the Moesif app id,
// service name and environment through as environment variables.
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
      - OTEL_SERVICE_NAME=\${OTEL_SERVICE_NAME:-ballerina-service}
      - DEPLOYMENT_ENVIRONMENT=\${DEPLOYMENT_ENVIRONMENT:-prod}
    ports:
      - "2020:2020"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:2020/"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  fluent-bit-otel-bi-db:
`;

// fluent-bit.yaml: tails the BI JSON log file, derives the OTLP severity from
// the JSON "level" field, wraps records in the OpenTelemetry log schema with the
// service.name / deployment.environment resource attributes, and ships them to
// Moesif's OTLP logs endpoint using the Collector Application ID header.
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
// Application ID. The service name, environment and BI log directory are left as
// placeholders for the user to fill in.
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

// ── Minimal ZIP writer (store / no compression) ──
// A tiny self-contained ZIP builder so the Fluent Bit files can be delivered as
// a single archive without pulling in a zip dependency. Uses the STORE method
// (no compression), which keeps the implementation to a CRC32 plus the local
// file headers, central directory and end-of-central-directory record.

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Builds an uncompressed ZIP archive from a map of path -> text contents.
function createZip(files: Record<string, string>): Blob {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(contents);
    const crc = crc32(data);
    const size = data.length;

    const localHeader = concatBytes([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed to extract
      u16(0), // general purpose bit flag
      u16(0), // compression method: 0 = store
      u16(0), // last mod file time
      u16(0), // last mod file date
      u32(crc),
      u32(size), // compressed size
      u32(size), // uncompressed size
      u16(nameBytes.length),
      u16(0), // extra field length
      nameBytes,
      data,
    ]);
    localParts.push(localHeader);

    centralParts.push(
      concatBytes([
        u32(0x02014b50), // central directory header signature
        u16(20), // version made by
        u16(20), // version needed to extract
        u16(0), // general purpose bit flag
        u16(0), // compression method
        u16(0), // last mod file time
        u16(0), // last mod file date
        u32(crc),
        u32(size), // compressed size
        u32(size), // uncompressed size
        u16(nameBytes.length),
        u16(0), // extra field length
        u16(0), // file comment length
        u16(0), // disk number start
        u16(0), // internal file attributes
        u32(0), // external file attributes
        u32(offset), // relative offset of local header
        nameBytes,
      ]),
    );

    offset += localHeader.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const end = concatBytes([
    u32(0x06054b50), // end of central directory signature
    u16(0), // number of this disk
    u16(0), // disk where central directory starts
    u16(centralParts.length), // number of central directory records on this disk
    u16(centralParts.length), // total number of central directory records
    u32(centralDirectory.length), // size of central directory
    u32(offset), // offset of start of central directory
    u16(0), // comment length
  ]);

  const archive = concatBytes([...localParts, centralDirectory, end]);
  return new Blob([archive.buffer as ArrayBuffer], { type: 'application/zip' });
}

// Downloads all Fluent Bit sidecar files (including a .env with the supplied
// Collector Application ID) as a single zip. The user unzips it, fills in the
// .env (Collector Application ID, service name, environment, BI log dir), then
// runs `docker compose up -d`.
export function downloadMoesifBiLogsFluentBitFiles(applicationId: string): void {
  const entries: Record<string, string> = { ...BI_LOGS_FLUENT_BIT_FILES, '.env': biLogsFluentBitEnv(applicationId) };
  // Nest every file under a single folder inside the archive.
  const zipContents: Record<string, string> = {};
  for (const [name, contents] of Object.entries(entries)) {
    zipContents[`${BI_LOGS_FLUENT_BIT_ZIP_FOLDER}/${name}`] = contents;
  }

  const blob = createZip(zipContents);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = BI_LOGS_FLUENT_BIT_ZIP_FILENAME;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
