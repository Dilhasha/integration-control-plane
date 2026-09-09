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

// The user-facing label for a runtime in the Moesif canvas' `runtimeId` filter:
// "integration1 (runtime1)". The owning integration is always named, so a
// runtime reads the same whether the list holds one integration's runtimes
// (integration scope) or every integration's in the project. Falls back to the
// runtime name alone when the owning integration is unknown, and to the runtime
// id when the runtime itself is unnamed.
export function runtimeOptionLabel(runtime: { runtimeId: string; runtimeName?: string; component?: { displayName: string } }): string {
  const runtimeLabel = runtime.runtimeName ?? runtime.runtimeId;
  return runtime.component?.displayName ? `${runtime.component.displayName} (${runtimeLabel})` : runtimeLabel;
}
