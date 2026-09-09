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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { gql } from './graphql';

// ── Moesif metrics configuration (per environment) ──

// Whether the environment has had its Moesif metrics workspace/dashboard
// created/linked in Moesif. The Management API key + canvas org/app ids are
// stored once per environment and shared by all integrations in it, so this flag
// is environment-wide. It drives the UI (setup flow vs. embedded dashboard):
// once any integration in the environment links the key, all integrations in
// that environment skip the setup flow and render the dashboard.
export interface MoesifMetricsConfigStatus {
  dashboardsCreated: boolean;
}

const MOESIF_METRICS_CONFIG_QUERY = `
  query MoesifMetricsConfig($componentId: String!, $environmentId: String!) {
    moesifMetricsConfig(componentId: $componentId, environmentId: $environmentId) {
      dashboardsCreated
    }
  }`;

// Reads whether the environment has its Moesif metrics dashboard linked. A Moesif
// application maps to a specific environment, so the config is keyed by
// environment and shared by all integrations in it. The componentId is still
// passed so the backend can enforce integration-level permissions.
export function useMoesifMetricsConfig(componentId: string | undefined, environmentId: string | undefined) {
  return useQuery<MoesifMetricsConfigStatus>({
    queryKey: ['moesif-metrics-config', componentId, environmentId],
    queryFn: () => gql<{ moesifMetricsConfig: MoesifMetricsConfigStatus }>(MOESIF_METRICS_CONFIG_QUERY, { componentId, environmentId }).then((d) => d.moesifMetricsConfig),
    enabled: !!componentId && !!environmentId,
    staleTime: 0,
  });
}

const CREATE_MOESIF_DASHBOARDS_MUTATION = `
  mutation CreateMoesifDashboards($componentId: String!, $environmentId: String!, $managementApiKey: String!) {
    createMoesifDashboards(componentId: $componentId, environmentId: $environmentId, managementApiKey: $managementApiKey) {
      dashboardsCreated
    }
  }`;

// Links the integration to its Moesif metrics canvas using the supplied Moesif
// Management API Key. The Management API Key is a Moesif-issued JWT scoped to an
// organization + application, so the backend derives both the Organization ID
// (`org` claim) and the Collector Application ID (`app` claim) from it rather
// than having them entered separately. The canvas auth token is no longer
// supplied here: the backend mints a short-lived, restricted token from this key
// on demand when the embed is rendered. On success the integration's
// `dashboardsCreated` flag (and the canvas org/app ids + Management API Key) are
// persisted so the embed can render the metrics canvas.
export function useCreateMoesifDashboards() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { componentId: string; environmentId: string; managementApiKey: string }) => gql<{ createMoesifDashboards: MoesifMetricsConfigStatus }>(CREATE_MOESIF_DASHBOARDS_MUTATION, input).then((d) => d.createMoesifDashboards),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['moesif-metrics-config', variables.componentId, variables.environmentId] });
      qc.invalidateQueries({ queryKey: ['moesif-dashboard-embed', variables.componentId, variables.environmentId] });
    },
  });
}

// ── Moesif applications (selectable list for the dashboard-linking step) ──

export interface MoesifApplication {
  id: string;
  name: string;
}

const MOESIF_APPLICATIONS_QUERY = `
  query MoesifApplications($componentId: String!, $managementApiKey: String!) {
    moesifApplications(componentId: $componentId, managementApiKey: $managementApiKey) {
      id, name
    }
  }`;

// Fetches the Moesif applications the given Management API Key can access
export function useMoesifApplications() {
  return useMutation({
    mutationFn: (input: { componentId: string; managementApiKey: string }) => gql<{ moesifApplications: MoesifApplication[] }>(MOESIF_APPLICATIONS_QUERY, input).then((d) => d.moesifApplications),
  });
}

// ── Moesif canvas embed (canvas iframe src + postMessage auth token) ──

// A descriptor used to embed the Moesif metrics canvas in an iframe. `embedUrl`
// is the fully-formed canvas iframe src (…/embed/canvas#auth=post)
// and `token` is the short-lived, restricted auth token the backend mints from
// the stored Management API Key and delivers to the canvas over the postMessage
// handshake (SET_TOKEN).
export interface MoesifDashboardEmbed {
  embedUrl: string;
  token: string;
}

const MOESIF_DASHBOARD_EMBED_QUERY = `
  query MoesifDashboardEmbed($componentId: String!, $environmentId: String!) {
    moesifDashboardEmbed(componentId: $componentId, environmentId: $environmentId) {
      embedUrl, token
    }
  }`;

// The embed URL + token are stable per integration, but keep the periodic
// refetch so a re-link (org/app/token change) is picked up without a full reload.
const MOESIF_EMBED_REFETCH_MS = 55 * 60 * 1000; // 55 minutes

// Returns the Moesif canvas embed URL + auth token (via the backend) for the
// integration's metrics canvas. Only enabled once the dashboards have been linked
// for the integration.
export function useMoesifDashboardEmbed(componentId: string | undefined, environmentId: string | undefined, enabled: boolean) {
  return useQuery<MoesifDashboardEmbed>({
    queryKey: ['moesif-dashboard-embed', componentId, environmentId],
    queryFn: () => gql<{ moesifDashboardEmbed: MoesifDashboardEmbed }>(MOESIF_DASHBOARD_EMBED_QUERY, { componentId, environmentId }).then((d) => d.moesifDashboardEmbed),
    enabled: !!componentId && !!environmentId && enabled,
    staleTime: MOESIF_EMBED_REFETCH_MS,
    refetchInterval: MOESIF_EMBED_REFETCH_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
