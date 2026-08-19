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

import biCanvas from './moesifBiCanvas.json';
import miCanvas from './moesifMiCanvas.json';

// Moesif canvas templates for the ICP runtime metrics view. Unlike the dashboard
// import templates (which the user downloads and imports into their Moesif
// account to persist the charts), these canvas templates are posted to the
// embedded Moesif canvas via the CANVAS_INIT postMessage during the handshake so
// the iframe renders the metrics without the user having to open Moesif. Each
// payload carries the `dashboards` + `workspaces` definitions the canvas renders.

// Canvas template for Ballerina Integration (BI) runtimes.
export const MOESIF_BI_CANVAS_TEMPLATE = biCanvas;

// Canvas template for Micro Integrator (MI) runtimes.
export const MOESIF_MI_CANVAS_TEMPLATE = miCanvas;

// Returns the canvas template payload appropriate for the runtime type. `isMI`
// selects the Micro Integrator canvas; otherwise the Ballerina Integration one.
export function getMoesifCanvasTemplate(isMI: boolean): unknown {
  return isMI ? MOESIF_MI_CANVAS_TEMPLATE : MOESIF_BI_CANVAS_TEMPLATE;
}
