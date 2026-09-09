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

// ── Minimal ZIP writer (store / no compression) ──
// A tiny self-contained ZIP builder so the Collector files can be delivered as a
// single archive without pulling in a zip dependency. Uses the STORE method (no
// compression), which keeps the implementation to a CRC32 plus the local file
// headers, central directory and end-of-central-directory record.

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

// Downloads all OpenTelemetry Collector sidecar files (including a .env with the
// supplied Collector Application ID) as a single zip. The user unzips it, sets
// MI_HOME, the ICP runtime id + the Collector Application ID in the .env, then
// runs `docker compose up -d`.
export function downloadMoesifMiLogsOtelFiles(applicationId: string): void {
  const entries: Record<string, string> = { ...MI_LOGS_OTEL_FILES, '.env': miLogsOtelEnv(applicationId) };
  // Nest every file under a single folder inside the archive.
  const zipContents: Record<string, string> = {};
  for (const [name, contents] of Object.entries(entries)) {
    zipContents[`${MI_LOGS_OTEL_ZIP_FOLDER}/${name}`] = contents;
  }

  const blob = createZip(zipContents);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = MI_LOGS_OTEL_ZIP_FILENAME;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
