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

// The characters TOML gives a short escape to in a basic (double-quoted) string. Every other
// control character has to be written as \uXXXX — see tomlString.
const TOML_ESCAPES: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

/**
 * Escapes a value for interpolation into a double-quoted TOML string. Handlers are free text — the
 * create forms only require "at least one letter or number" — so a name containing a quote would
 * otherwise close the string early and yield a config that fails to parse once pasted. TOML also
 * forbids raw control characters (U+0000–U+001F and U+007F) in a basic string, so any without a
 * short escape are emitted as \uXXXX. Done in one pass so an escaped backslash is not re-escaped.
 */
function tomlString(value: string): string {
  // Matching control characters is the point here: TOML rejects them raw, so they have to be
  // found in order to be escaped.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => TOML_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

/**
 * The `main.bal` imports a BI runtime needs. The ICP bridge is always required; workflow management
 * additionally needs its own module imported, because the `[ballerina.workflow.management]`
 * configuration only takes effect when the module is part of the build. Ordered the way `bal format`
 * sorts imports (by org, then module). Shared by the Add Runtime dialogs.
 */
export function runtimeImports(workflowMgt: boolean): string {
  const bridge = 'import wso2/icp.runtime.bridge as _;';
  return workflowMgt ? `import ballerina/workflow.management as _;\n\n${bridge}` : bridge;
}

/**
 * TOML a workflow-enabled BI runtime carries: the workflow engine block,
 * then the management API block keyed by the org secret. `integration` becomes the workflow task
 * queue and should be whatever the `integration` key of the bridge config above holds, so the two
 * always agree — the real handle on the component runtime page, the same fill-in placeholder on the
 * org page, which is org-scoped and has no integration to resolve. The namespace is not written
 * here; the runtime derives it from the bridge configuration.
 * Shared by the Add Runtime dialogs (org runtimes and component runtime pages).
 */
export function workflowManagementToml(integration: string, secret: string): string {
  return `[ballerina.workflow]
# mode = "LOCAL"
taskQueue = "${tomlString(integration)}"

[ballerina.workflow.management]
enableManagementApi = true
enableApiKey = true
apiKeyValue = "${tomlString(secret)}"
apiKeyHeader = "X-API-Key"
enableBasicAuth = false
# port = 8234`;
}
