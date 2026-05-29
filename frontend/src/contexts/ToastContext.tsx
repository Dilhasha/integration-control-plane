import { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import type { ReactNode, JSX } from 'react';

export interface RuntimeResult {
  runtimeId: string;
  runtimeName: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  httpStatus?: number;
  responseTimeMs?: number;
  errorMessage?: string;
}

export type ToastStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'partial_success';
export type OperationType =
  | 'enable'
  | 'disable'
  | 'tracing_enable'
  | 'tracing_disable'
  | 'statistics_enable'
  | 'statistics_disable'
  | 'trigger'
  | 'listener_start'
  | 'listener_stop';

export interface ToastNotification {
  id: string;
  type: 'control-command';
  operationType: OperationType;
  artifactName: string;
  artifactType: string;
  status: ToastStatus;
  runtimeResults: RuntimeResult[];
  totalRuntimes: number;
  successCount: number;
  failedCount: number;
  isExpanded: boolean;
  timestamp: number;
  commandId?: string;
  environmentName?: string;
}

interface ToastContextType {
  toasts: ToastNotification[];
  addToast: (toast: Omit<ToastNotification, 'id' | 'timestamp'>) => string;
  updateToast: (id: string, updates: Partial<ToastNotification>) => void;
  removeToast: (id: string) => void;
  expandToast: (id: string) => void;
  collapseToast: (id: string) => void;
  clearAllToasts: () => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

const MAX_TOASTS = 5;
const AUTO_DISMISS_DELAY = 5000; // 5 seconds

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastNotification[]>([]);

  // Add a new toast
  const addToast = useCallback((toast: Omit<ToastNotification, 'id' | 'timestamp'>): string => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newToast: ToastNotification = {
      ...toast,
      id,
      timestamp: Date.now(),
    };

    setToasts((prev) => {
      const updated = [newToast, ...prev];
      // Keep only the most recent MAX_TOASTS
      return updated.slice(0, MAX_TOASTS);
    });

    return id;
  }, []);

  // Update an existing toast
  const updateToast = useCallback((id: string, updates: Partial<ToastNotification>) => {
    setToasts((prev) =>
      prev.map((toast) =>
        toast.id === id ? { ...toast, ...updates } : toast
      )
    );
  }, []);

  // Remove a toast
  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  // Expand a toast
  const expandToast = useCallback((id: string) => {
    updateToast(id, { isExpanded: true });
  }, [updateToast]);

  // Collapse a toast
  const collapseToast = useCallback((id: string) => {
    updateToast(id, { isExpanded: false });
  }, [updateToast]);

  // Clear all toasts
  const clearAllToasts = useCallback(() => {
    setToasts([]);
  }, []);

  // Auto-dismiss completed toasts after delay
  useEffect(() => {
    const timers: NodeJS.Timeout[] = [];

    toasts.forEach((toast) => {
      // Only auto-dismiss completed toasts that are not expanded
      if (toast.status === 'completed' && !toast.isExpanded) {
        const timer = setTimeout(() => {
          removeToast(toast.id);
        }, AUTO_DISMISS_DELAY);
        timers.push(timer);
      }
    });

    return () => {
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, [toasts, removeToast]);

  const value = useMemo(
    () => ({
      toasts,
      addToast,
      updateToast,
      removeToast,
      expandToast,
      collapseToast,
      clearAllToasts,
    }),
    [toasts, addToast, updateToast, removeToast, expandToast, collapseToast, clearAllToasts]
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastContextType {
  const context = useContext(ToastContext);
  if (context === undefined) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

// Helper function to get operation display text
export function getOperationDisplayText(operationType: OperationType): string {
  const displayMap: Record<OperationType, string> = {
    enable: 'Enabling',
    disable: 'Disabling',
    tracing_enable: 'Enabling tracing for',
    tracing_disable: 'Disabling tracing for',
    statistics_enable: 'Enabling statistics for',
    statistics_disable: 'Disabling statistics for',
    trigger: 'Triggering',
    listener_start: 'Starting listener',
    listener_stop: 'Stopping listener',
  };
  return displayMap[operationType] || 'Processing';
}

// Helper function to get status icon/emoji
export function getStatusIcon(status: ToastStatus): string {
  const iconMap: Record<ToastStatus, string> = {
    pending: '⏳',
    in_progress: '🔄',
    completed: '✅',
    failed: '❌',
    partial_success: '⚠️',
  };
  return iconMap[status] || '•';
}

// Helper function to get status color class
export function getStatusColorClass(status: ToastStatus): string {
  const colorMap: Record<ToastStatus, string> = {
    pending: 'blue',
    in_progress: 'blue',
    completed: 'green',
    failed: 'red',
    partial_success: 'yellow',
  };
  return colorMap[status] || 'gray';
}
