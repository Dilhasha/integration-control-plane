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
import { deleteEnvGroup, getEnvGroup, listEnvGroups, putEnvGroup } from '../api/envGroups';
import type { MiConfig, MiConfigSavePlan } from '../types/envGroups';
import { MI_ENV_VARS_GROUP, miSecretGroup, toMiConfig } from '../utils/miConfigs';

/**
 * The MI configuration (environment variables + secret keys) of one environment.
 * Gate on `enabled` while the component has no deployment there: the groups live
 * on the environment's ReleaseBinding.
 */
export function useMiConfig(projectId: string, componentId: string, envId: string, enabled = true) {
  return useQuery<MiConfig>({
    queryKey: ['miConfig', projectId, componentId, envId],
    queryFn: async () => {
      const groups = await listEnvGroups(projectId, componentId, envId);
      const hasEnvVars = groups.some((g) => g.name === MI_ENV_VARS_GROUP && !g.sensitive);
      const values = hasEnvVars ? (await getEnvGroup(projectId, componentId, envId, MI_ENV_VARS_GROUP)).data : {};
      return toMiConfig(groups, values);
    },
    enabled: enabled && !!projectId && !!componentId && !!envId,
  });
}

/** Applies a save plan from `planMiConfigSave`. */
export function useSaveMiConfig(projectId: string, componentId: string, envId: string) {
  const qc = useQueryClient();
  return useMutation({
    // Sequential on purpose: each write is a read-modify-write of the same
    // ReleaseBinding annotation in the BFF, so parallel writes would race.
    mutationFn: async (plan: MiConfigSavePlan) => {
      if (plan.envVars === null) await deleteEnvGroup(projectId, componentId, envId, MI_ENV_VARS_GROUP);
      else if (plan.envVars) await putEnvGroup(projectId, componentId, envId, MI_ENV_VARS_GROUP, false, plan.envVars);
      for (const s of plan.secretsToPut) await putEnvGroup(projectId, componentId, envId, miSecretGroup(s.key), true, { [s.key]: s.value });
      for (const key of plan.secretsToDelete) await deleteEnvGroup(projectId, componentId, envId, miSecretGroup(key));
    },
    // Settled, not success: a partial failure has still changed some groups.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['miConfig', projectId, componentId, envId] });
      qc.invalidateQueries({ queryKey: ['devopsConfigs'] });
      qc.invalidateQueries({ queryKey: ['componentDeployment'] });
    },
  });
}
