import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught error:', error);
    console.error('Component stack:', errorInfo.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="w-full h-screen flex flex-col items-center justify-center bg-bg-primary text-text-primary p-8">
          <h1 className="text-2xl font-bold mb-4">应用加载出现问题</h1>
          <p className="text-text-secondary mb-6">请重启应用。如果问题持续，请检查网络连接或重新安装。</p>
          {this.state.error && (
            <details className="text-sm text-text-secondary bg-bg-secondary rounded-lg p-4 max-w-xl">
              <summary className="cursor-pointer font-medium">错误详情</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all text-xs">
                {this.state.error.message}
                {'\n\n'}
                {this.state.error.stack}
              </pre>
            </details>
          )}
          <button
            onClick={() => window.location.reload()}
            className="mt-6 px-6 py-2 bg-accent text-button-text rounded-lg font-medium hover:opacity-90 transition-opacity"
          >
            重新加载
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
