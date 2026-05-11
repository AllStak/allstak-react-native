import * as React from 'react';
import { AllStak, AllStakClient } from './client';
import type { AllStakConfig } from './client';
import { installReactNative } from './install';
import type { ReactNativeInstallOptions } from './install';

export interface AllStakProviderProps extends ReactNativeInstallOptions {
  children: React.ReactNode;
  apiKey: string;
  environment?: string;
  release?: string;
  host?: string;
  user?: { id?: string; email?: string };
  tags?: Record<string, string>;
  debug?: boolean;
  enableHttpTracking?: boolean;
  httpTracking?: AllStakConfig['httpTracking'];
  /**
   * Per-console-method capture flags. Defaults: warn + error on, log +
   * info off. Set `{ log: true, info: true }` to opt-in to verbose
   * capture, or `{ warn: false, error: false }` to suppress.
   */
  captureConsole?: AllStakConfig['captureConsole'];
  sampleRate?: number;
  beforeSend?: AllStakConfig['beforeSend'];
  replay?: AllStakConfig['replay'];
  tracesSampleRate?: number;
  service?: string;
  dist?: string;
  /**
   * Tear down the SDK when the provider unmounts. Default `false`.
   *
   * Most apps mount `AllStakProvider` once at the root and never unmount
   * it. Setting this to `true` risks disabling telemetry if the provider
   * re-mounts (Fast Refresh in dev, route key changes, React 18 Strict
   * Mode double-mount, etc.) — there is a brief window between unmount
   * and remount where captures throw.
   *
   * Leave at the default unless you genuinely need to dispose the SDK
   * (e.g. test harness, multi-tenant container that switches projects).
   */
  destroyOnUnmount?: boolean;
  fallback?:
    | React.ReactNode
    | ((props: { error: Error; resetError: () => void }) => React.ReactNode);
  onError?: (error: Error, componentStack?: string) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

const AllStakContext = React.createContext<AllStakClient | null>(null);

// Module-level guard so re-mounts of <AllStakProvider> reuse the existing
// singleton instead of destroying + re-creating it (which would briefly
// break captureException calls and clear breadcrumbs).
let __providerOwnedInstance: AllStakClient | null = null;

class AllStakErrorBoundary extends React.Component<
  {
    children: React.ReactNode;
    fallback?: AllStakProviderProps['fallback'];
    onError?: AllStakProviderProps['onError'];
    debug?: boolean;
  },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      AllStak.addBreadcrumb('ui', 'React error boundary caught error', 'error', {
        componentStack: info.componentStack ?? '',
      });
      AllStak.captureException(error, {
        componentStack: info.componentStack ?? '',
        source: 'AllStakProvider.ErrorBoundary',
      });
      if (this.props.debug) {
        // eslint-disable-next-line no-console
        console.log(`[AllStak] Captured render error: ${error.message}`);
      }
    } catch { /* never break the host app */ }
    try { this.props.onError?.(error, info.componentStack ?? undefined); }
    catch { /* ignore */ }
  }

  private resetError = () => this.setState({ error: null });

  render(): React.ReactNode {
    if (this.state.error) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') {
        return fallback({ error: this.state.error, resetError: this.resetError });
      }
      if (fallback !== undefined) return fallback;
      return null;
    }
    return this.props.children;
  }
}

export function AllStakProvider({
  children,
  apiKey,
  environment,
  release,
  host,
  user,
  tags,
  debug,
  enableHttpTracking,
  httpTracking,
  captureConsole,
  sampleRate,
  beforeSend,
  replay,
  tracesSampleRate,
  service,
  dist,
  destroyOnUnmount = false,
  fallback,
  onError,
  autoErrorHandler,
  autoPromiseRejections,
  autoDeviceTags,
  autoAppStateBreadcrumbs,
  autoNetworkCapture,
  autoFetchBreadcrumbs,
  autoConsoleBreadcrumbs,
  autoNavigationBreadcrumbs,
}: AllStakProviderProps): React.ReactElement {
  const clientRef = React.useRef<AllStakClient | null>(null);

  if (!clientRef.current) {
    // If a previous provider mount left an instance live, reuse it. This
    // covers Fast Refresh in dev and Strict Mode double-mount in React 18
    // — both unmount/remount the provider but should not tear down the SDK.
    const existing = AllStak._getInstance();
    if (existing && __providerOwnedInstance === existing) {
      clientRef.current = existing;
      if (debug) {
        // eslint-disable-next-line no-console
        console.log(`[AllStak] Reusing session ${AllStak.getSessionId()}`);
      }
    } else {
      const config: AllStakConfig = {
        apiKey,
        environment,
        release,
        host,
        user,
        tags,
        enableHttpTracking,
        httpTracking,
        captureConsole,
        sampleRate,
        beforeSend,
        replay,
        tracesSampleRate,
        service,
        dist,
      };
      clientRef.current = AllStak.init(config);
      __providerOwnedInstance = clientRef.current;

      installReactNative({
        autoErrorHandler,
        autoPromiseRejections,
        autoDeviceTags,
        autoAppStateBreadcrumbs,
        autoNetworkCapture,
        autoFetchBreadcrumbs,
        autoConsoleBreadcrumbs,
        autoNavigationBreadcrumbs,
        debugLogs: debug,
      });

      if (debug) {
        // eslint-disable-next-line no-console
        console.log(`[AllStak] Initialized — session ${AllStak.getSessionId()}`);
      }
    }
  }

  React.useEffect(() => {
    return () => {
      if (destroyOnUnmount) {
        AllStak.destroy();
        __providerOwnedInstance = null;
        clientRef.current = null;
        // eslint-disable-next-line no-console
        if (debug) console.log('[AllStak] Destroyed on unmount');
      }
    };
  }, [destroyOnUnmount, debug]);

  return (
    <AllStakContext.Provider value={clientRef.current}>
      <AllStakErrorBoundary fallback={fallback} onError={onError} debug={debug}>
        {children}
      </AllStakErrorBoundary>
    </AllStakContext.Provider>
  );
}

export function useAllStak() {
  return React.useMemo(
    () => ({
      captureException: (error: Error, ctx?: Record<string, unknown>) =>
        AllStak.captureException(error, ctx),
      captureMessage: (
        msg: string,
        level: 'fatal' | 'error' | 'warning' | 'info' = 'info',
      ) => AllStak.captureMessage(msg, level),
      setUser: (user: { id?: string; email?: string }) => AllStak.setUser(user),
      setTag: (key: string, value: string) => AllStak.setTag(key, value),
      addBreadcrumb: (
        type: string,
        message: string,
        level?: string,
        data?: Record<string, unknown>,
      ) => AllStak.addBreadcrumb(type, message, level, data),
    }),
    [],
  );
}

/** @internal — for tests. Resets the module-level remount-guard. */
export function __resetProviderInstanceForTest(): void {
  __providerOwnedInstance = null;
}
