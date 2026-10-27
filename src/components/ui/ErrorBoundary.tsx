/* eslint-disable i18next/no-literal-string -- the crash fallback is intentionally English and must not depend on i18n */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Prevents an uncaught render error from leaving the Tauri webview with a blank
 * screen. Rendering failures are reported through the frontend log bridge and a
 * reload action is offered instead of a hard crash.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-neutral-950 p-8 text-center text-neutral-200">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="max-w-lg text-sm break-words text-neutral-400">{error.message}</p>
        <button
          type="button"
          onClick={this.handleReload}
          className="rounded-md bg-neutral-800 px-4 py-2 text-sm transition-colors hover:bg-neutral-700"
        >
          Reload
        </button>
      </div>
    );
  }
}
