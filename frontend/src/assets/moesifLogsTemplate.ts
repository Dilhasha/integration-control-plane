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

import logsTemplate from './moesifLogsTemplate.json';

// Moesif dashboards import template for the ICP runtime logs view. The user
// downloads this and imports it into Moesif (Dashboard Templates → Import Json
// Template), which creates the "Application Logs" dashboard and its "All logs"
// workspace. The workspace must then be set to Public sharing so the backend can
// mint embed access tokens for it. The JSON payload is kept as a separate asset
// and imported here so the download filename and callers stay consistent with
// the metrics template module.
export const MOESIF_LOGS_TEMPLATE = logsTemplate;

// Suggested filename when the user downloads the template.
export const MOESIF_LOGS_TEMPLATE_FILENAME = 'moesif_logs_dashboard_template.json';

// The name of the dashboard created by importing the template. Shown in the UI
// instructions.
export const MOESIF_LOGS_DASHBOARD_NAME = 'Application Logs';

// The name of the workspace created by importing the template. Shown in the UI
// instructions (the user must set this workspace's sharing to Public) and used
// by the backend to discover the workspace id.
export const MOESIF_LOGS_WORKSPACE_NAME = 'All logs';

// Triggers a browser download of the template as a formatted JSON file.
export function downloadMoesifLogsTemplate(): void {
  const blob = new Blob([JSON.stringify(MOESIF_LOGS_TEMPLATE, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = MOESIF_LOGS_TEMPLATE_FILENAME;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
