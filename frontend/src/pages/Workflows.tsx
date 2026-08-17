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

import { Autocomplete, Box, Chip, CircularProgress, PageContent, Stack, Tab, Tabs, TextField, Typography } from '@wso2/oxygen-ui';
import { useEffect, useState, type JSX } from 'react';
import { useSearchParams } from 'react-router';
import { useProjectByHandler, useComponentByHandler, useComponents, useEnvironments } from '../api/queries';
import NotFound from '../components/NotFound';
import AdminPortal from '../components/workflow/AdminPortal';
import UserPortal from '../components/workflow/UserPortal';
import { useAccessControl } from '../contexts/AccessControlContext';
import { useLoadComponentPermissions, useLoadProjectPermissions } from '../hooks/usePermissionLoader';
import { Permissions } from '../constants/permissions';
import { resourceUrl, broaden, hasComponent, type ComponentScope, type ProjectScope } from '../nav';
import { usePendingReviewActivityCount, usePendingTaskCount, type WorkflowTarget } from '../api/workflows';
import { gatewayScope } from '../components/workflow/helpers';
import { isWorkflowIntegration } from '../constants/integrationTypes';

/**
 * Tab title with the amount of work waiting behind it. Omitted at zero, and while the count is still
 * loading, so a tab only grows a badge when there is something to act on.
 */
function TabLabel({ title, count, capped }: { title: string; count?: number; capped?: boolean }): JSX.Element {
  return (
    <Stack direction="row" alignItems="center" gap={0.75}>
      <span>{title}</span>
      {count !== undefined && count > 0 && <Chip label={capped ? `${count}+` : count} size="small" color="primary" sx={{ height: 18, fontSize: 11, fontWeight: 600, '& .MuiChip-label': { px: 0.75 } }} />}
    </Stack>
  );
}

type TabKey = 'tasks' | 'reviews' | 'management';
// Tab order, and the order a permitted fallback is picked in.
const TAB_ORDER: TabKey[] = ['tasks', 'reviews', 'management'];

export default function Workflows(scope: ComponentScope | ProjectScope): JSX.Element {
  const componentLevel = hasComponent(scope);
  const { data: project, isLoading: loadingProject } = useProjectByHandler(scope.project);
  const projectId = project?.id ?? '';
  const { data: component, isLoading: loadingComponent } = useComponentByHandler(projectId, componentLevel ? scope.component : undefined);
  // At project scope the portals span every integration in the project; at component scope, just one.
  const { data: allComponents = [], isLoading: loadingComponents } = useComponents(scope.org, projectId);
  const { data: environments = [], isLoading: loadingEnvs } = useEnvironments(projectId);
  const componentId = component?.id ?? '';

  // Gate on this component's permissions at component scope, the project's at project scope.
  // Note the project-scope limit: the backend resolves project-scope permissions with
  // `AND grm.integration_uuid IS NULL`, so a user holding workflow permission only on individual
  // integrations does not pass this gate and must use the per-integration page. Note that a project's
  // workflow data is namespace-wide, so this gate is what bounds what a project-scope viewer sees;
  // it is not narrowed further per integration.
  useLoadComponentPermissions(scope.org, projectId, componentLevel ? componentId : '');
  useLoadProjectPermissions(scope.org, projectId);
  const { hasAnyPermission } = useAccessControl();

  // `handler` is what a runtime is configured with as its Temporal task queue, so it is how a
  // record's own taskQueue maps back to the integration that owns it.
  const targets: WorkflowTarget[] = componentLevel
    ? component
      ? [{ componentId: component.id, componentName: component.displayName ?? component.name, handler: component.handler }]
      : []
    : // Every project-scope read goes through targets[0], so integrations typed as Workflow are put
      // first — otherwise whichever integration happened to sort first becomes the gateway, and a
      // runtime with no workflow engine cannot answer for the project. The others are kept rather
      // than filtered out: workflow management is enabled per runtime (the Add Runtime toggle is
      // gated on technology, not on integration type), so a differently-typed integration may still
      // host workflows and must stay in the definitions fan-out and the task-queue lookup. Copied
      // before sorting so the cached component list is not mutated; sort is stable, so integrations
      // keep their relative order within each group.
      [...allComponents].sort((a, b) => Number(isWorkflowIntegration(b.displayType)) - Number(isWorkflowIntegration(a.displayType))).map((c) => ({ componentId: c.id, componentName: c.displayName ?? c.name, handler: c.handler }));
  // The project shares one Temporal namespace, so a listing is narrowed by task queue rather than by
  // which runtime is called: this integration's queue at component scope, the whole namespace at
  // project scope.
  const taskQueue = componentLevel ? component?.handler : undefined;

  // Optional deep-link params (e.g. from the Overview page's "View Workflows" action or the
  // start-workflow success dialog): ?tab=management&type=<workflowType>&workflowId=<id>&env=<environmentId>
  const [searchParams, setSearchParams] = useSearchParams();
  // Held in state rather than read from the URL on every render. The admin view unmounts on a tab
  // switch and re-seeds its filters from these on mount, so leaving them in the URL would reapply a
  // search the user had since cleared. Kept here, above the tabs, so they can be dropped once used.
  const [deepLink, setDeepLink] = useState<{ workflowType?: string; workflowId?: string }>(() => ({
    workflowType: searchParams.get('type') ?? undefined,
    workflowId: searchParams.get('workflowId') ?? undefined,
  }));
  const urlWorkflowType = searchParams.get('type');
  const urlWorkflowId = searchParams.get('workflowId');
  // A deep link can also arrive without remounting this page — "View Instance" from the start
  // dialog navigates to these same params — so pick those up when they appear.
  useEffect(() => {
    if (urlWorkflowType === null && urlWorkflowId === null) return;
    setDeepLink({ workflowType: urlWorkflowType ?? undefined, workflowId: urlWorkflowId ?? undefined });
  }, [urlWorkflowType, urlWorkflowId]);
  // The active tab is driven by the URL, so navigating here from elsewhere (e.g. clicking a
  // workflow ID in a task or review) switches tabs deterministically. `admin` is still accepted so
  // links made before the tabs were flattened keep working.
  const requestedTab = searchParams.get('tab');
  const tabKey: TabKey = requestedTab === 'management' || requestedTab === 'admin' ? 'management' : requestedTab === 'reviews' ? 'reviews' : 'tasks';
  const setTabKey = (v: TabKey) => {
    // Leaving the admin view discards its deep link, in state and in the URL alike: it has already
    // been applied, and re-applying it on the way back would resurrect a cleared filter.
    setDeepLink({});
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', v);
        next.delete('type');
        next.delete('workflowId');
        return next;
      },
      { replace: true },
    );
  };
  const [selectedEnvId, setSelectedEnvId] = useState(searchParams.get('env') ?? '');

  // Remounts the admin portal when the deep link changes, so a new one re-seeds the filters.
  const deepLinkKey = `${deepLink.workflowType ?? ''}:${deepLink.workflowId ?? ''}`;

  const activeEnvId = environments.some((e) => e.id === selectedEnvId) ? selectedEnvId : (environments[0]?.id ?? '');
  const selectedEnv = environments.find((e) => e.id === activeEnvId) ?? null;
  // Each tab is gated by its dedicated workflow permission.
  const permScope = componentLevel ? componentId : undefined;
  const canViewHumanTasks = hasAnyPermission([Permissions.WORKFLOW_VIEW_HUMAN_TASKS, Permissions.WORKFLOW_MANAGE_HUMAN_TASKS], projectId, permScope);
  const canViewWorkflows = hasAnyPermission([Permissions.WORKFLOW_VIEW_WORKFLOWS, Permissions.WORKFLOW_MANAGE_WORKFLOWS], projectId, permScope);
  // Review Activities is gated on the workflow permissions, not the human-task ones: the proxy
  // authorizes /review-activities on that branch, so a Viewer holding only view_human_tasks would
  // otherwise be offered a tab that 403s on load.
  const allowedTabs: Record<TabKey, boolean> = { tasks: canViewHumanTasks, reviews: canViewWorkflows, management: canViewWorkflows };
  // Resolve the requested tab to one the user may see, else the first they may (null = none).
  const activeTab: TabKey | null = allowedTabs[tabKey] ? tabKey : (TAB_ORDER.find((t) => allowedTabs[t]) ?? null);

  // Counts for the tab badges. Both poll, so each is skipped when its tab is not on offer — and both
  // read through the same gateway runtime the views themselves use.
  const gateway = gatewayScope({ targets, environmentId: activeEnvId, taskQueue });
  // Declared above the early returns below, so these hooks run in the same order on every render.
  const { data: pendingTasks } = usePendingTaskCount(gateway, taskQueue, allowedTabs.tasks);
  const { data: pendingReviews } = usePendingReviewActivityCount(gateway, taskQueue, allowedTabs.reviews);

  if (loadingProject || loadingComponent || loadingEnvs || loadingComponents)
    return (
      <PageContent sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress />
      </PageContent>
    );
  if (componentLevel && !component) return <NotFound message="Component not found" backTo={resourceUrl(broaden(scope)!, 'overview')} backLabel="Back to Project" />;

  return (
    <PageContent>
      <Stack component="header" direction="row" alignItems="center" justifyContent="space-between" gap={2} sx={{ mb: 1 }}>
        <Typography variant="h1">Workflows</Typography>
        <Autocomplete
          size="small"
          sx={{ width: 280 }}
          options={environments}
          getOptionLabel={(e) => e.name}
          value={selectedEnv}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          onChange={(_, v) => setSelectedEnvId(v?.id ?? '')}
          renderInput={(params) => <TextField {...params} label="Environment" placeholder="Select environment" />}
        />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {componentLevel ? (
          <>
            Manage workflow executions and human tasks for <strong>{component?.displayName ?? scope.component}</strong>.
          </>
        ) : (
          <>
            Manage workflow executions and human tasks across all integrations in <strong>{project?.name ?? scope.project}</strong>.
          </>
        )}
      </Typography>

      {environments.length === 0 ? (
        <Typography color="text.secondary" sx={{ py: 6, textAlign: 'center' }}>
          {componentLevel ? 'No environments found for this integration.' : 'No environments found for this project.'}
        </Typography>
      ) : activeTab === null ? (
        <Typography color="text.secondary" sx={{ py: 6, textAlign: 'center' }}>
          {componentLevel ? 'You do not have permission to view workflows for this integration.' : 'You do not have permission to view workflows for this project.'}
        </Typography>
      ) : (
        <>
          <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
            <Tabs value={activeTab} onChange={(_, v) => setTabKey(v as TabKey)}>
              {allowedTabs.tasks && <Tab label={<TabLabel title="My Tasks" count={pendingTasks} />} value="tasks" />}
              {allowedTabs.reviews && <Tab label={<TabLabel title="Review Activities" count={pendingReviews?.count} capped={pendingReviews?.capped} />} value="reviews" />}
              {allowedTabs.management && <Tab label="Workflow Executions" value="management" />}
            </Tabs>
          </Box>
          {!activeEnvId ? (
            <Typography color="text.secondary" sx={{ py: 6, textAlign: 'center' }}>
              Select an environment to continue.
            </Typography>
          ) : activeTab === 'management' ? (
            <AdminPortal key={deepLinkKey} targets={targets} environmentId={activeEnvId} taskQueue={taskQueue} initialWorkflowType={deepLink.workflowType} initialWorkflowId={deepLink.workflowId} />
          ) : (
            <UserPortal targets={targets} environmentId={activeEnvId} taskQueue={taskQueue} view={activeTab === 'reviews' ? 'reviews' : 'tasks'} />
          )}
        </>
      )}
    </PageContent>
  );
}
