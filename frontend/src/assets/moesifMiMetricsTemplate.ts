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

import miMetricsTemplate from './moesifMiMetricsTemplate.json';

// Moesif dashboards import template for the ICP runtime metrics chart when the
// linked integration is a Micro Integrator (MI). Unlike the BI template (a single
// "Application Metrics" dashboard), MI ships the Synapse "Overall" observability
// dashboard whose charts match the analytics MI publishes via the Fluent Bit
// sidecar. The JSON payload is kept as a separate asset and imported here so the
// download filename and callers stay consistent with the BI template module.
export const MOESIF_MI_METRICS_TEMPLATE = miMetricsTemplate;

// Suggested filename when the user downloads the MI template.
export const MOESIF_MI_METRICS_TEMPLATE_FILENAME = 'moesif_mi_metrics_dashboard_template.json';

// The single workspace (chart) ICP embeds for MI integrations. It lives in the
// "Overall" dashboard; the user must set its sharing to Public so the backend can
// mint embed access tokens for it. Kept in sync with MOESIF_MI_WORKSPACE_NAME in
// the backend (icp_server/moesif_client.bal), which discovers it by this name.
export const MOESIF_MI_METRICS_WORKSPACE_NAME = 'Overall Message Count Over Time';

// The dashboards created by importing the MI template. Shown in the UI
// instructions so the user knows what the import produces.
export const MOESIF_MI_DASHBOARD_NAMES = ['Overall'] as const;

// Triggers a browser download of the MI template as a formatted JSON file.
export function downloadMoesifMiMetricsTemplate(): void {
  const blob = new Blob([JSON.stringify(MOESIF_MI_METRICS_TEMPLATE, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = MOESIF_MI_METRICS_TEMPLATE_FILENAME;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
