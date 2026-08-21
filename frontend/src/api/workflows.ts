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

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { authenticatedFetch } from '../auth/tokenManager';
import { workflowApiUrl } from '../config/api';

// ── Shared types (runtime-side shapes are loosely typed; known fields declared) ──

export interface WorkflowDefinition {
  workflowType: string;
  inputSchema?: string | null;
  isActive?: boolean;
  workerCount?: number;
}

export interface WorkflowInstance {
  workflowId: string;
  runId?: string;
  workflowType?: string;
  status?: string;
  startTime?: string;
  closeTime?: string;
  /** The project's Temporal namespace, and the task queue of the integration that owns this run. */
  namespace?: string;
  taskQueue?: string;
  [key: string]: unknown;
}

export interface Page<T> {
  items: T[];
  nextPageToken?: string | null;
  hasMore?: boolean;
}

export interface HumanTask {
  taskId: string;
  taskName?: string;
  title?: string;
  description?: string;
  payload?: Record<string, unknown>;
  formSchema?: Record<string, unknown> | string;
  parentWorkflowId?: string;
  parentWorkflowType?: string;
  status?: string;
  startTime?: string;
  closeTime?: string;
  userRoles?: string[];
  eligibleRoles?: string[];
  canComplete?: boolean;
  result?: unknown;
  namespace?: string;
  taskQueue?: string;
  [key: string]: unknown;
}

export interface ReviewActivity {
  taskId: string;
  taskName?: string;
  activityName?: string;
  parentWorkflowId?: string;
  parentWorkflowType?: string;
  status?: string;
  trigger?: string;
  startTime?: string;
  namespace?: string;
  taskQueue?: string;
  [key: string]: unknown;
}

export interface ReviewActivityDetail extends ReviewActivity {
  title?: string;
  description?: string;
  formSchema?: Record<string, unknown> | string;
  // The arguments the gated/failed activity would run with; always conforms to formSchema.
  activityArgs?: Record<string, unknown>;
  userRoles?: string[];
  errorMessage?: string;
  closeTime?: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface HistoryEvent {
  [key: string]: unknown;
}

// ── Execution graph (node-link DAG describing the run's dependency flow) ──

export interface ExecutionGraphNode {
  id: string;
  label: string;
  /** Node kind, e.g. WORKFLOW, ACTIVITY, HUMAN_TASK, SIGNAL, TIMER. */
  type: string;
  /** Same status vocabulary as workflow instances (RUNNING, COMPLETED, FAILED, …). */
  status?: string;
  metadata?: Record<string, unknown> | null;
}

export interface ExecutionGraphEdge {
  source: string;
  target: string;
  label?: string | null;
}

export interface ExecutionGraph {
  nodes: ExecutionGraphNode[];
  edges: ExecutionGraphEdge[];
}

// ── Low-level request helper (mirrors logs.ts: timeout + error extraction) ──

// The workflow API is asynchronous end to end: the ICP holds no request open. A read may
// answer 202 {status: "FETCHING"} while a runtime materializes it (the ICP coalesces
// identical requests, so polling is cheap); a mutation always answers 202 {operationId} and
// its outcome — including "someone else got there first" — arrives on the operation poll.
// This helper absorbs that contract so every hook keeps its synchronous shape.
const WF_ASYNC_DEADLINE_MS = 75_000;
const WF_POLL_FALLBACK_MS = 750;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function wfFetchOnce(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await authenticatedFetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text };
      }
    }
    return { status: res.status, body };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Workflow service is unavailable. Request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// crypto.randomUUID exists only in a secure context — HTTPS, or localhost. A console served
// over plain HTTP on any other host would throw here and fail every mutation before it was
// sent, so the key falls back to something unique enough for de-duplicating one submit.
const newIdempotencyKey = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `wf-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * A read that may not be answered yet.
 *
 * The workflow API materializes a read through the integration, so the first request for a
 * view nobody has opened recently is answered `202 {status:"FETCHING"}`. Waiting for it inside
 * the request — which is what this module used to do — makes the page hang with a spinner for
 * as long as it takes, and tells the user nothing. Surfacing the state instead lets the page
 * say so and come back for it.
 */
export type Fetchable<T> =
  | { state: 'ready'; value: T }
  | { state: 'fetching'; retryAfterMs: number };

/** Named to sit beside react-query's own `isFetching` without being mistaken for it: this is
 *  the SERVER still preparing the answer, not the browser having a request in flight. */
export const isPreparing = <T,>(r: Fetchable<T> | undefined): boolean => r?.state === 'fetching';
export const valueOf = <T,>(r: Fetchable<T> | undefined): T | undefined =>
  r?.state === 'ready' ? r.value : undefined;

/** How soon to come back for a read the server is still preparing, when it names no interval. */
const WF_FETCHING_POLL_MS = 900;

/**
 * A read request that reports `fetching` rather than waiting for the answer.
 *
 * Used by the list and detail queries, whose caller is a page that can render the state. The
 * polling belongs to react-query here: it already knows how to come back, and it keeps the
 * previous answer on screen while it does.
 */
async function wfFetchable<T>(componentId: string, environmentId: string, subpath: string): Promise<Fetchable<T>> {
  const { status, body } = await wfFetchOnce(workflowApiUrl(componentId, environmentId, subpath), {});
  if (status === 202) {
    const accepted = (body ?? {}) as { retryAfterMs?: number };
    return { state: 'fetching', retryAfterMs: accepted.retryAfterMs ?? WF_FETCHING_POLL_MS };
  }
  if (status < 200 || status >= 300) {
    const b = body as { error?: { message?: string }; message?: string } | undefined;
    const error = new Error(b?.error?.message || b?.message || `Request failed (${status})`);
    (error as Error & { status?: number }).status = status;
    throw error;
  }
  return { state: 'ready', value: body as T };
}

/** Comes back at the interval the server asked for while a read is still being prepared. */
export const fetchableRefetch = <T,>(data: Fetchable<T> | undefined): number | false =>
  data?.state === 'fetching' ? data.retryAfterMs : false;

/** Applies a projection to a ready value, so a hook can unwrap an envelope or default a
 *  field without losing the `fetching` state. */
const mapFetchable = <A, B>(r: Fetchable<A>, f: (a: A) => B): Fetchable<B> =>
  r.state === 'ready' ? { state: 'ready', value: f(r.value) } : r;

/**
 * A request that waits for its answer. Mutations use this: the caller pressed a button, so a
 * spinner on that button is the honest thing to show, and a queued operation is polled by its
 * id rather than re-sent.
 */
async function wfRequest<T>(componentId: string, environmentId: string, subpath: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  let request = init;
  if (method !== 'GET') {
    // The key makes a browser-level retry or a double submit collapse onto one operation
    // server-side, instead of acting twice.
    request = { ...init, headers: { ...(init.headers ?? {}), 'x-idempotency-key': newIdempotencyKey() } };
  }
  const deadline = Date.now() + WF_ASYNC_DEADLINE_MS;
  let url = workflowApiUrl(componentId, environmentId, subpath);
  for (;;) {
    const { status, body } = await wfFetchOnce(url, request);
    if (status === 202) {
      const accepted = (body ?? {}) as { operationId?: string; retryAfterMs?: number };
      if (accepted.operationId) {
        // A queued mutation: from here on, poll its outcome. Never re-send the POST — the
        // operation row is the request now.
        url = workflowApiUrl(componentId, environmentId, `operations/${encodeURIComponent(accepted.operationId)}`);
        request = {};
      }
      if (Date.now() > deadline) {
        throw new Error('The workflow service is still preparing this data. Try again shortly.');
      }
      await sleep(accepted.retryAfterMs ?? WF_POLL_FALLBACK_MS);
      continue;
    }
    if (status < 200 || status >= 300) {
      const b = body as { error?: { message?: string }; message?: string } | undefined;
      const message = b?.error?.message || b?.message || `Request failed (${status})`;
      const error = new Error(message);
      (error as Error & { status?: number }).status = status;
      throw error;
    }
    return body as T;
  }
}

function jsonBody(init: RequestInit, body: unknown): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== null) usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

// Scope-tuple used in every query key so cached data is isolated per component+env.
type Scope = { componentId: string; environmentId: string };
const enabledFor = (s: Scope) => !!s.componentId && !!s.environmentId;

// ── Definitions ──

function fetchDefinitions(componentId: string, environmentId: string): Promise<Fetchable<WorkflowDefinition[]>> {
  return wfFetchable<{ definitions: WorkflowDefinition[] }>(componentId, environmentId, 'definitions')
    .then((r) => mapFetchable(r, (d) => d.definitions ?? []));
}

// ── Workflow instances ──

export interface WorkflowFilters {
  status?: string;
  /** Restricts results to one integration's task queue; omitted covers the whole namespace. */
  taskQueue?: string;
  workflowType?: string;
  workflowId?: string;
  startTimeFrom?: string;
  startTimeTo?: string;
  limit?: number;
  pageToken?: string;
}


export function useWorkflowInstances(s: Scope, filters: WorkflowFilters) {
  return useQuery({
    queryKey: ['wf', 'instances', s.componentId, s.environmentId, filters],
    // Reports `fetching` on the first request for a view the server has not materialized yet,
    // so the page can say so instead of showing a spinner for however long it takes, and comes
    // back at the interval the server asked for.
    queryFn: () => wfFetchable<Page<WorkflowInstance>>(s.componentId, s.environmentId, `workflows${buildQuery({ ...filters })}`),
    refetchInterval: ({ state }) => fetchableRefetch(state.data),
    enabled: enabledFor(s),
  });
}

export function useWorkflowInfo(s: Scope, workflowId: string | null) {
  return useQuery({
    queryKey: ['wf', 'info', s.componentId, s.environmentId, workflowId],
    queryFn: () => wfFetchable<WorkflowInstance>(s.componentId, s.environmentId, `workflows/${encodeURIComponent(workflowId!)}`),
    refetchInterval: ({ state }) => fetchableRefetch(state.data),
    enabled: enabledFor(s) && !!workflowId,
  });
}

export function useWorkflowHistory(s: Scope, workflowId: string | null) {
  return useQuery({
    queryKey: ['wf', 'history', s.componentId, s.environmentId, workflowId],
    queryFn: () => wfFetchable<{ events: HistoryEvent[] }>(s.componentId, s.environmentId, `workflows/${encodeURIComponent(workflowId!)}/history`)
      .then((r) => mapFetchable(r, (d) => d.events ?? [])),
    refetchInterval: ({ state }) => fetchableRefetch(state.data),
    enabled: enabledFor(s) && !!workflowId,
  });
}

export function useWorkflowExecutionGraph(s: Scope, workflowId: string | null) {
  return useQuery({
    queryKey: ['wf', 'graph', s.componentId, s.environmentId, workflowId],
    queryFn: () => wfFetchable<ExecutionGraph>(s.componentId, s.environmentId, `workflows/${encodeURIComponent(workflowId!)}/execution-graph`),
    refetchInterval: ({ state }) => fetchableRefetch(state.data),
    enabled: enabledFor(s) && !!workflowId,
  });
}

/**
 * Invalidates a workflow resource for an environment whichever component key it was cached under.
 * A project shares one Temporal namespace, so a listing is cached under the runtime that served the
 * read — the gateway — while a mutation is sent to the runtime that owns the row. Keying the
 * invalidation on the component would therefore miss the very list the user is looking at.
 */
function invalidateForEnvironment(qc: ReturnType<typeof useQueryClient>, environmentId: string, ...kinds: string[]): void {
  const wanted = new Set<unknown>(kinds);
  qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'wf' && wanted.has(q.queryKey[1]) && q.queryKey[3] === environmentId });
}

export function useStartWorkflow(s: Scope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { workflowType: string; input?: unknown; workflowId?: string; timeoutSeconds?: number }) => wfRequest<WorkflowInstance>(s.componentId, s.environmentId, 'workflows', jsonBody({ method: 'POST' }, body)),
    onSuccess: () => invalidateForEnvironment(qc, s.environmentId, 'instances'),
  });
}

export type WorkflowLifecycleAction = 'suspend' | 'resume' | 'cancel' | 'terminate';

export function useWorkflowLifecycle(s: Scope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workflowId, action, reason }: { workflowId: string; action: WorkflowLifecycleAction; reason?: string }) => {
      const init = action === 'terminate' ? jsonBody({ method: 'POST' }, { reason: reason ?? '' }) : { method: 'POST' };
      return wfRequest<unknown>(s.componentId, s.environmentId, `workflows/${encodeURIComponent(workflowId)}/${action}`, init);
    },
    onSuccess: () => invalidateForEnvironment(qc, s.environmentId, 'instances', 'info'),
  });
}

// ── Human tasks ──

export interface HumanTaskFilters {
  status?: string;
  parentWorkflowId?: string;
  parentWorkflowType?: string;
  taskName?: string;
  taskQueue?: string;
  limit?: number;
  pageToken?: string;
}

function fetchHumanTasks(componentId: string, environmentId: string, filters: HumanTaskFilters): Promise<Fetchable<Page<HumanTask>>> {
  return wfFetchable<Page<HumanTask>>(componentId, environmentId, `human-tasks${buildQuery({ ...filters })}`);
}

export function useHumanTasks(s: Scope, filters: HumanTaskFilters) {
  return useQuery({
    queryKey: ['wf', 'human-tasks', s.componentId, s.environmentId, filters],
    queryFn: () => fetchHumanTasks(s.componentId, s.environmentId, filters),
    refetchInterval: ({ state }) => fetchableRefetch(state.data),
    enabled: enabledFor(s),
  });
}

function fetchPendingTaskCount(componentId: string, environmentId: string, taskQueue?: string): Promise<Fetchable<number>> {
  return wfFetchable<{ count: number }>(componentId, environmentId, `human-tasks/pending-count${buildQuery({ taskQueue })}`)
    .then((r) => mapFetchable(r, (d) => d.count ?? 0));
}

/** `enabled` lets a caller skip the poll when the count is not being shown. */
export function usePendingTaskCount(s: Scope, taskQueue?: string, enabled = true) {
  return useQuery({
    queryKey: ['wf', 'pending-count', s.componentId, s.environmentId, taskQueue],
    queryFn: () => fetchPendingTaskCount(s.componentId, s.environmentId, taskQueue),
    enabled: enabledFor(s) && enabled,
    refetchInterval: ({ state }) => fetchableRefetch(state.data) || 30000,
  });
}

// Query options for one task's detail; shared by useHumanTask and useQueries-based batch fetches.
export function humanTaskQueryOptions(s: Scope, taskId: string) {
  return {
    queryKey: ['wf', 'human-task', s.componentId, s.environmentId, taskId] as const,
    queryFn: () => wfFetchable<HumanTask>(s.componentId, s.environmentId, `human-tasks/${encodeURIComponent(taskId)}`),
  };
}

export function useHumanTask(s: Scope, taskId: string | null) {
  return useQuery({
    ...humanTaskQueryOptions(s, taskId ?? ''),
    enabled: enabledFor(s) && !!taskId,
  });
}

function invalidateHumanTasks(qc: ReturnType<typeof useQueryClient>, s: Scope) {
  invalidateForEnvironment(qc, s.environmentId, 'human-tasks', 'pending-count');
}

export function useCompleteHumanTask(s: Scope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, result }: { taskId: string; result: unknown }) => wfRequest<unknown>(s.componentId, s.environmentId, `human-tasks/${encodeURIComponent(taskId)}/complete`, jsonBody({ method: 'POST' }, { result })),
    onSuccess: () => invalidateHumanTasks(qc, s),
  });
}

export function useFailHumanTask(s: Scope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, reason, details }: { taskId: string; reason: string; details?: unknown }) => wfRequest<unknown>(s.componentId, s.environmentId, `human-tasks/${encodeURIComponent(taskId)}/fail`, jsonBody({ method: 'POST' }, { reason, details })),
    onSuccess: () => invalidateHumanTasks(qc, s),
  });
}

// ── Review activities ──
// (Replaces the deprecated retry-tasks routes; the runtime still exposes /retry-tasks
// for pre-0.7.0 clients but the UI uses /review-activities.)

export interface ReviewActivityFilters {
  status?: string;
  parentWorkflowId?: string;
  taskName?: string;
  taskQueue?: string;
  startTimeFrom?: string;
  startTimeTo?: string;
  limit?: number;
  pageToken?: string;
}

// Review-activity pages are fetched and combined up to this many pages so client-side
// filters (e.g. by workflow name, which the runtime API cannot filter on) see the
// full set rather than only the first page.
const REVIEW_ACTIVITY_MAX_PAGES = 20;

// Page size the badge count reads; a full page is reported as capped rather than as an exact total.
const PENDING_REVIEW_PAGE = 50;

async function fetchReviewActivities(componentId: string, environmentId: string, filters: ReviewActivityFilters): Promise<Fetchable<Page<ReviewActivity>>> {
  const items: ReviewActivity[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < REVIEW_ACTIVITY_MAX_PAGES; i++) {
    const result = await wfFetchable<Page<ReviewActivity>>(componentId, environmentId, `review-activities${buildQuery({ ...filters, pageToken })}`);
    // Each page is its own cached read, so any of them may still be being prepared. The
    // listing is reported as fetching until every page it needs has arrived: combining the
    // pages that did arrive would present a partial set as the whole.
    if (result.state === 'fetching') return result;
    const page = result.value;
    items.push(...(page.items ?? []));
    if (!page.hasMore || !page.nextPageToken) return { state: 'ready', value: { items, hasMore: false } };
    pageToken = page.nextPageToken;
  }
  return { state: 'ready', value: { items, hasMore: true } };
}

export function useReviewActivities(s: Scope, filters: ReviewActivityFilters) {
  return useQuery({
    queryKey: ['wf', 'review-activities', s.componentId, s.environmentId, filters],
    queryFn: () => fetchReviewActivities(s.componentId, s.environmentId, filters),
    refetchInterval: ({ state }) => fetchableRefetch(state.data),
    enabled: enabledFor(s),
  });
}

/** How many review activities are awaiting a decision, and whether that count hit the page cap. */
export interface PendingReviewCount {
  count: number;
  capped: boolean;
}

/**
 * Count of review activities awaiting a decision, for the tab badge. The runtime has no count
 * endpoint, so this reads a single PENDING page — one request, unlike the listing, which walks up to
 * REVIEW_ACTIVITY_MAX_PAGES so its client-side filters see everything. A full page reports `capped`
 * so the badge can say "50+" rather than claim exactly 50.
 */
export function usePendingReviewActivityCount(s: Scope, taskQueue?: string, enabled = true) {
  return useQuery({
    queryKey: ['wf', 'pending-review-count', s.componentId, s.environmentId, taskQueue],
    queryFn: (): Promise<Fetchable<PendingReviewCount>> =>
      wfFetchable<Page<ReviewActivity>>(s.componentId, s.environmentId, `review-activities${buildQuery({ status: 'PENDING', taskQueue, limit: PENDING_REVIEW_PAGE })}`)
        .then((r) => mapFetchable(r, (p) => ({
          count: p.items?.length ?? 0,
          capped: p.hasMore === true,
        }))),
    enabled: enabledFor(s) && enabled,
    refetchInterval: ({ state }) => fetchableRefetch(state.data) || 30000,
  });
}

export function reviewActivityQueryOptions(s: Scope, taskId: string) {
  return {
    queryKey: ['wf', 'review-activity', s.componentId, s.environmentId, taskId] as const,
    queryFn: () => wfFetchable<ReviewActivityDetail>(s.componentId, s.environmentId, `review-activities/${encodeURIComponent(taskId)}`),
  };
}

export function useReviewActivity(s: Scope, taskId: string | null) {
  return useQuery({
    ...reviewActivityQueryOptions(s, taskId ?? ''),
    enabled: enabledFor(s) && !!taskId,
  });
}

export type ReviewDecision = 'proceed' | 'proceed-with-input' | 'reject';

export function useReviewDecision(s: Scope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, decision, input, feedback }: { taskId: string; decision: ReviewDecision; input?: unknown; feedback?: string }) => {
      let init: RequestInit;
      if (decision === 'proceed-with-input') init = jsonBody({ method: 'POST' }, { input });
      else if (decision === 'reject') init = jsonBody({ method: 'POST' }, { feedback });
      else init = { method: 'POST' };
      return wfRequest<unknown>(s.componentId, s.environmentId, `review-activities/${encodeURIComponent(taskId)}/${decision}`, init);
    },
    onSuccess: () => invalidateForEnvironment(qc, s.environmentId, 'review-activities', 'pending-review-count'),
  });
}

// ── Project-scope workflow management ────────────────────────────────────────
//
// A project shares one Temporal engine. Every runtime in it is bound to the same namespace
// (`namespace = <project>` in the runtime config) and differs only by task queue
// (`taskQueue = <integration>`). The management API relays to that engine, so any one runtime
// answers for the whole project: calling every integration's callback URL is unnecessary and would
// return the same namespace-wide rows once per runtime.
//
// Reads therefore go through a single gateway runtime, and scope is expressed with the `taskQueue`
// query parameter that the listings and pending-count accept:
//   - integration scope - taskQueue is that integration, so only its rows come back;
//   - project scope - taskQueue omitted, covering every task queue in the namespace, and never
//     another namespace, since the client is namespace-bound.
// Each record carries its own namespace/taskQueue, and that is what routes a follow-up operation
// back to the integration that owns it.
//
// `/definitions` is the exception: it takes no taskQueue and reports only what its own runtime
// hosts, so a project-wide list of startable workflows does have to ask every integration.

export interface WorkflowTarget {
  componentId: string;
  componentName: string;
  /** The component handler — what the runtime is configured with as its `taskQueue`. */
  handler: string;
}

/** A value tagged with the integration it came from. */
export type Owned<T> = T & { componentId: string; componentName: string };

/** Resolves a record's `taskQueue` back to the integration that owns it, when it is one we know. */
export function targetForTaskQueue(targets: WorkflowTarget[], taskQueue?: string): WorkflowTarget | undefined {
  return taskQueue ? targets.find((t) => t.handler === taskQueue) : undefined;
}

/**
 * 403/404/503 mean "this integration has nothing to contribute" — no running workflow runtime, or
 * not visible to the caller — rather than a failure worth reporting.
 */
function isAbsent(e: unknown): boolean {
  const status = (e as { status?: number } | null | undefined)?.status;
  return status === 403 || status === 404 || status === 503;
}

export interface DefinitionsAcross {
  /** Every startable workflow, tagged with the integration whose runtime hosts it. */
  items: Owned<WorkflowDefinition>[];
  isLoading: boolean;
  failed: { componentName: string; message: string }[];
}

/**
 * Workflow definitions from every target. This is the one listing that must fan out, because
 * `/definitions` is runtime-local: it backs the project-wide "start a workflow" choice, where the
 * chosen definition also determines which runtime to start it on.
 */
export function useWorkflowDefinitionsAcross(targets: WorkflowTarget[], environmentId: string): DefinitionsAcross {
  const results = useQueries({
    queries: targets.map((t) => ({
      queryKey: ['wf', 'definitions', t.componentId, environmentId],
      queryFn: () => fetchDefinitions(t.componentId, environmentId),
      enabled: !!environmentId && !!t.componentId,
    })),
  });

  const items: Owned<WorkflowDefinition>[] = [];
  const failed: { componentName: string; message: string }[] = [];
  results.forEach((r, i) => {
    const target = targets[i];
    if (!target) return;
    // A target whose definitions are still being prepared contributes nothing yet; the query
    // comes back for it, and `isLoading` below keeps the caller from treating the partial
    // fan-out as complete.
    for (const d of valueOf(r.data) ?? []) {
      items.push({ ...d, componentId: target.componentId, componentName: target.componentName });
    }
    if (r.error && !isAbsent(r.error)) {
      failed.push({ componentName: target.componentName, message: r.error instanceof Error ? r.error.message : 'Request failed' });
    }
  });
  return {
    items,
    // Still "loading" while any target's definitions are being prepared server-side: the list
    // is genuinely incomplete until they arrive.
    isLoading: results.some((r) => r.isLoading || isPreparing(r.data)),
    failed,
  };
}

/**
 * Distinct workflow types, for the workflow-name filter — several integrations in a project may
 * host the same type and the filter only needs one entry per name.
 */
export function distinctWorkflowTypes(definitions: WorkflowDefinition[]): WorkflowDefinition[] {
  const byType = new Map<string, WorkflowDefinition>();
  for (const d of definitions) {
    if (!byType.has(d.workflowType)) byType.set(d.workflowType, d);
  }
  return [...byType.values()];
}
