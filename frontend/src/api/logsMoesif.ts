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
import type { MoesifDashboardEmbed } from './metricsMoesif';

// ── Moesif logs configuration (per environment) ──

// Whether the environment has had its Moesif application logs dashboard/canvas
// linked in Moesif. The Management API key + canvas org/app ids are stored once
// per environment (shared with metrics) and shared by all integrations in it, so
// this flag is environment-wide. It drives the UI (setup flow vs. embedded logs
// canvas): once any integration in the environment links the key, all
// integrations in that environment skip the setup flow and render the canvas.
export interface MoesifLogsConfigStatus {
  logsConfigured: boolean;
}

const MOESIF_LOGS_CONFIG_QUERY = `
  query MoesifLogsConfig($componentId: String!, $environmentId: String!) {
    moesifLogsConfig(componentId: $componentId, environmentId: $environmentId) {
      logsConfigured
    }
  }`;

// Reads whether the environment has its Moesif logs canvas linked. A Moesif
// application maps to a specific environment, so the config is keyed by
// environment and shared by all integrations in it. The componentId is still
// passed so the backend can enforce integration-level permissions.
export function useMoesifLogsConfig(componentId: string | undefined, environmentId: string | undefined) {
  return useQuery<MoesifLogsConfigStatus>({
    queryKey: ['moesif-logs-config', componentId, environmentId],
    queryFn: () => gql<{ moesifLogsConfig: MoesifLogsConfigStatus }>(MOESIF_LOGS_CONFIG_QUERY, { componentId, environmentId }).then((d) => d.moesifLogsConfig),
    enabled: !!componentId && !!environmentId,
    staleTime: 0,
  });
}

const CREATE_MOESIF_LOGS_DASHBOARDS_MUTATION = `
  mutation CreateMoesifLogsDashboards($componentId: String!, $environmentId: String!, $managementApiKey: String!) {
    createMoesifLogsDashboards(componentId: $componentId, environmentId: $environmentId, managementApiKey: $managementApiKey) {
      logsConfigured
    }
  }`;

// Links the integration to its Moesif logs canvas using the supplied Moesif
// Management API Key. The Management API Key is a Moesif-issued JWT scoped to an
// organization + application, so the backend derives both the Organization ID
// (`org` claim) and the Collector Application ID (`app` claim) from it rather
// than having them entered separately. The canvas auth token is no longer
// supplied here: the backend mints a short-lived, restricted token from this key
// on demand when the embed is rendered. These credentials are shared with the
// metrics config. On success the integration's `logsConfigured` flag (and the
// shared canvas org/app ids + Management API Key) are persisted so the embed can
// render the logs canvas.
export function useCreateMoesifLogsDashboards() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { componentId: string; environmentId: string; managementApiKey: string }) => gql<{ createMoesifLogsDashboards: MoesifLogsConfigStatus }>(CREATE_MOESIF_LOGS_DASHBOARDS_MUTATION, input).then((d) => d.createMoesifLogsDashboards),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['moesif-logs-config', variables.componentId, variables.environmentId] });
      qc.invalidateQueries({ queryKey: ['moesif-logs-embed', variables.componentId, variables.environmentId] });
    },
  });
}

// ── Moesif logs canvas embed (canvas iframe src + postMessage auth token) ──

const MOESIF_LOGS_EMBED_QUERY = `
  query MoesifLogsEmbed($componentId: String!, $environmentId: String!) {
    moesifLogsEmbed(componentId: $componentId, environmentId: $environmentId) {
      embedUrl, token
    }
  }`;

// The embed URL + token are stable per integration, but keep the periodic
// refetch so a re-link (org/app/token change) is picked up without a full reload.
const MOESIF_LOGS_EMBED_REFETCH_MS = 55 * 60 * 1000; // 55 minutes

// Returns the Moesif canvas embed URL + auth token (via the backend) for the
// integration's logs canvas. Only enabled once the logs canvas has been linked
// for the integration.
export function useMoesifLogsEmbed(componentId: string | undefined, environmentId: string | undefined, enabled: boolean) {
  return useQuery<MoesifDashboardEmbed>({
    queryKey: ['moesif-logs-embed', componentId, environmentId],
    queryFn: () => gql<{ moesifLogsEmbed: MoesifDashboardEmbed }>(MOESIF_LOGS_EMBED_QUERY, { componentId, environmentId }).then((d) => d.moesifLogsEmbed),
    enabled: !!componentId && !!environmentId && enabled,
    staleTime: MOESIF_LOGS_EMBED_REFETCH_MS,
    refetchInterval: MOESIF_LOGS_EMBED_REFETCH_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
