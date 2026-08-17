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
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Mirrors the swagger-pack compiler plugin's uniqueFileName() (icp-runtime-bridge): each packed
// file is named `<module>_<normalizedBasePath>_openapi.json` (or just `<normalizedBasePath>_...`
// for the default module), where normalizedBasePath strips leading slashes and collapses
// `/{}` into `_`. There's no explicit foreign key from a Service artifact to its packed file, so
// matching by this same normalization is the best available correlation.
//
// Kept dependency-free (no swagger-ui-react import) so both OpenApiDefinitionsDrawer.tsx (lazy)
// and TestConsole.tsx (eagerly routed) can use it without pulling swagger-ui-react into the
// main bundle.
export function normalizeBasePath(basePath: string): string {
  const stripped = basePath.replace(/^\/+/, '').replace(/[/{}]+/g, '_');
  return stripped || 'root';
}

export function matchesServiceBasePath(fileName: string, basePath: string): boolean {
  const normalized = normalizeBasePath(basePath);
  const withoutSuffix = fileName.replace(/_openapi\.json$/, '');
  return withoutSuffix === normalized || withoutSuffix.endsWith(`_${normalized}`);
}
