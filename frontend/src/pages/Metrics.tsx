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
import { ToggleButton, ToggleButtonGroup } from '@wso2/oxygen-ui';
import { useCallback, useState, type JSX } from 'react';
import { hasComponent, type ProjectScope, type ComponentScope } from '../nav';
import { useProjectByHandler, useComponentByHandler } from '../api/queries';
import { useObservabilityMetricsConfig } from '../api/metrics';
import MetricsOpenSearch from './MetricsOpenSearch';
import MetricsMoesif from './MetricsMoesif';

type MetricsBackend = 'opensearch' | 'moesif';

/**
 * Metrics dispatcher.
 *
 * Lets the user choose the runtime metrics backend (OpenSearch or Moesif) via
 * an on-page toggle and renders the corresponding runtime metrics page. The
 * toggle control is passed down so each page renders it consistently in its
 * header row.
 *
 * OpenSearch is the primary provider when it is configured and reachable: it
 * stays the default selection and the first toggle option. When OpenSearch is
 * not configured, Moesif becomes the default provider (so its setup
 * instructions render directly on the landing page) and OpenSearch is shown as
 * the secondary option.
 *
 * Moesif metrics are offered for BI and MI runtimes. At component scope the
 * Moesif backend is only exposed when the component's technology is BI or MI; at
 * project scope the toggle stays available and the Moesif page filters its
 * integration picker to BI/MI integrations.
 */
export default function Metrics(scope: ProjectScope | ComponentScope): JSX.Element {
  // Null until the user explicitly picks a backend, so the default can follow
  // the OpenSearch availability check below without overriding a user choice.
  const [selectedBackend, setSelectedBackend] = useState<MetricsBackend | null>(null);

  const isComponent = hasComponent(scope);
  const { data: project } = useProjectByHandler(scope.project);
  const { data: component, isLoading: componentLoading } = useComponentByHandler(project?.id ?? '', isComponent ? scope.component : undefined);

  // One-way latch set when an OpenSearch metrics request reports the backend as
  // unavailable at query time. The config probe can lag behind an outage (it is
  // cached and may pass on a shallow health check while queries still fail), so
  // this ensures we treat OpenSearch as not configured once a real query fails
  // and surface the Moesif setup instructions instead of a dead-end error.
  const [opensearchUnavailable, setOpensearchUnavailable] = useState(false);
  const handleOpenSearchUnavailable = useCallback(() => setOpensearchUnavailable(true), []);

  // Whether OpenSearch is configured/reachable. Assume configured until the
  // check resolves to keep OpenSearch as the default and avoid a flip for the
  // common (configured) case, but treat a query-time unavailability as not
  // configured.
  const { data: observabilityConfig } = useObservabilityMetricsConfig();
  const opensearchConfigured = (observabilityConfig?.configured ?? true) && !opensearchUnavailable;

  // When OpenSearch isn't configured, default to Moesif so its setup
  // instructions surface on the landing page.
  const defaultBackend: MetricsBackend = opensearchConfigured ? 'opensearch' : 'moesif';
  const backend = selectedBackend ?? defaultBackend;

  // While the component query is still resolving we don't yet know its
  // technology, so keep the backend selector mounted to avoid it disappearing
  // during loading.
  const componentResolving = isComponent && componentLoading;
  const moesifAllowed = isComponent ? component?.componentType === 'BI' || component?.componentType === 'MI' : true;

  // Derive the effective backend, falling back to OpenSearch whenever Moesif is
  // unavailable (e.g. an unsupported component technology) so no corrective
  // state update is needed.
  const effectiveBackend: MetricsBackend = moesifAllowed ? backend : 'opensearch';

  // Order the toggle options so the default provider comes first: OpenSearch
  // first when configured, otherwise Moesif first with OpenSearch as secondary.
  // Passed as a keyed array (not a Fragment) so ToggleButtonGroup can clone each
  // ToggleButton to apply its grouped styling. Each page decides whether to
  // actually render this control: it is only shown when BOTH backends are
  // configured for the targeted integration (OpenSearch globally + that
  // integration's Moesif dashboard), so a single-backend setup has no toggle.
  const opensearchOption = (
    <ToggleButton key="opensearch" value="opensearch" aria-label="OpenSearch metrics">
      OpenSearch
    </ToggleButton>
  );
  const moesifOption = (
    <ToggleButton key="moesif" value="moesif" aria-label="Moesif metrics">
      Moesif
    </ToggleButton>
  );

  const backendSelector =
    moesifAllowed || componentResolving ? (
      <ToggleButtonGroup
        value={effectiveBackend}
        exclusive
        size="small"
        onChange={(_e, value: MetricsBackend | null) => {
          if (value) setSelectedBackend(value);
        }}
        aria-label="Metrics backend">
        {opensearchConfigured ? [opensearchOption, moesifOption] : [moesifOption, opensearchOption]}
      </ToggleButtonGroup>
    ) : undefined;

  return effectiveBackend === 'moesif' ? (
    <MetricsMoesif scope={scope} backendSelector={backendSelector} opensearchConfigured={opensearchConfigured} />
  ) : (
    <MetricsOpenSearch scope={scope} backendSelector={backendSelector} opensearchConfigured={opensearchConfigured} onUnavailable={handleOpenSearchUnavailable} />
  );
}
