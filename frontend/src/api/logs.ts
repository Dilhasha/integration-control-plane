import { useInfiniteQuery } from '@tanstack/react-query';
import { observabilityLogsApiUrl } from '../paths';
import { authenticatedFetch } from '../auth/tokenManager';

export interface LogsRequest {
  componentIdList: string[];
  environmentId: string;
  environmentList: string[];
  logLevels: string[];
  startTime: string;
  endTime: string;
  limit: number;
  sort: 'asc' | 'desc';
  region: string;
  searchPhrase: string;
}

export interface LogRow {
  timestamp: string;
  level: string;
  logLine: string;
  class: string | null;
  logFilePath: string | null;
  appName: string | null;
  module: string | null;
  serviceType: string | null;
  app: string | null;
  deployment: string | null;
  artifactContainer: string | null;
  product: string | null;
  icpRuntimeId: string | null;
  logContext: unknown;
  componentVersion: string;
  componentVersionId: string;
}

interface Column {
  name: string;
  type: string;
}

const COLUMN_MAP: Record<string, keyof LogRow> = {
  TimeGenerated: 'timestamp',
  LogLevel: 'level',
  LogEntry: 'logLine',
  Class: 'class',
  LogFilePath: 'logFilePath',
  AppName: 'appName',
  Module: 'module',
  ServiceType: 'serviceType',
  App: 'app',
  Deployment: 'deployment',
  ArtifactContainer: 'artifactContainer',
  Product: 'product',
  IcpRuntimeId: 'icpRuntimeId',
  LogContext: 'logContext',
  ComponentVersion: 'componentVersion',
  ComponentVersionId: 'componentVersionId',
};

export async function fetchLogs(req: LogsRequest): Promise<LogRow[]> {
  // Add timeout to fail fast when observability service is unavailable
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  try {
    const res = await authenticatedFetch(observabilityLogsApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const text = await res.text();
      let errorMessage = text;
      try {
        const errorJson = JSON.parse(text);
        errorMessage = errorJson.message || text;
      } catch {
        // If JSON parsing fails, use the raw text
      }
      const error = new Error(errorMessage);
      (error as any).status = res.status;
      throw error;
    }
    const json: { columns: Column[]; rows: (string | null)[][] } = await res.json();
    const indexMap: Record<number, keyof LogRow> = {};
    (json.columns ?? []).forEach((col, i) => {
      const key = COLUMN_MAP[col.name];
      if (key) indexMap[i] = key;
    });
    return (json.rows ?? []).map((row) => {
      const entry = {} as Record<string, unknown>;
      row.forEach((val, i) => {
        const key = indexMap[i];
        if (key) entry[key] = val;
      });
      return entry as unknown as LogRow;
    });
  } catch (error) {
    clearTimeout(timeoutId);
    // Handle abort/timeout errors
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Observability service is unavailable. Request timed out.');
    }
    throw error;
  }
}

export function useInfiniteLogs(req: LogsRequest | null, refetchInterval: number | false = false) {
  return useInfiniteQuery({
    queryKey: ['logs', req],
    queryFn: async ({ pageParam }) => {
      const pageReq = pageParam ? { ...req!, ...(req!.sort === 'desc' ? { endTime: pageParam } : { startTime: pageParam }) } : req!;
      return fetchLogs(pageReq);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => {
      if (!req || lastPage.length < req.limit) return undefined;
      return lastPage[lastPage.length - 1]?.timestamp;
    },
    enabled: !!req,
    refetchInterval,
    retry: false, // Disable retries for faster failure when observability service is unavailable
    staleTime: 0, // Always fetch fresh data
  });
}
