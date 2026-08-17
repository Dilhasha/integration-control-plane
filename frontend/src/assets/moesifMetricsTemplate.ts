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

import metricsTemplate from './moesifMetricsTemplate.json';

// Moesif dashboards import template for the ICP runtime metrics chart when the
// linked integration is a Ballerina Integration (BI). The user downloads this and
// imports it into Moesif (Dashboards → Import), which creates the "Application
// Metrics" dashboard and its "Total Request Summary" workspace. The workspace must
// then be set to Public sharing so the backend can mint embed access tokens for it.
// The JSON payload is kept as a separate asset and imported here so the download
// filename and callers stay consistent with the MI template module.
export const MOESIF_METRICS_TEMPLATE = metricsTemplate;

// Suggested filename when the user downloads the template.
export const MOESIF_METRICS_TEMPLATE_FILENAME = 'moesif_metrics_dashboard_template.json';

// The name of the workspace created by importing the template. Shown in the UI
// instructions (the user must set this workspace's sharing to Public) and used
// by the backend to discover the workspace id.
export const MOESIF_METRICS_WORKSPACE_NAME = 'Total Request Summary';

// Triggers a browser download of the template as a formatted JSON file.
export function downloadMoesifMetricsTemplate(): void {
  const blob = new Blob([JSON.stringify(MOESIF_METRICS_TEMPLATE, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = MOESIF_METRICS_TEMPLATE_FILENAME;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
