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

import biLogsCanvas from './moesifBiLogsCanvas.json';

// Moesif canvas template for the ICP runtime application logs view. Unlike the
// dashboard import template (which the user downloads and imports into their
// Moesif account to persist the log charts), this canvas template is posted to
// the embedded Moesif canvas via the CANVAS_INIT postMessage during the handshake
// so the iframe renders the logs without the user having to open Moesif. The
// payload carries the `dashboards` + `workspaces` definitions the canvas renders.

// Canvas template for the application logs canvas.
export const MOESIF_LOGS_CANVAS_TEMPLATE = biLogsCanvas;

// Returns the application logs canvas template payload. Logs share a single
// canvas across runtime types (there is no MI/BI split), so this takes no args.
export function getMoesifLogsCanvasTemplate(): unknown {
  return MOESIF_LOGS_CANVAS_TEMPLATE;
}
