import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: React.ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-screen flex flex-col items-center justify-center bg-surface-0 text-text-primary p-8">
          <div className="w-14 h-14 rounded-2xl bg-danger/10 flex items-center justify-center mb-6">
            <AlertTriangle size={28} className="text-danger" />
          </div>
          <h2 className="text-lg font-semibold mb-2">Something went wrong</h2>
          <p className="text-sm text-text-secondary max-w-md text-center mb-4">
            {this.state.error.message}
          </p>
          <pre className="text-xs text-text-muted bg-surface-1 rounded-lg p-4 max-w-lg overflow-auto max-h-40 border border-border mb-6">
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-2 border border-border text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            <RefreshCw size={14} />
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
