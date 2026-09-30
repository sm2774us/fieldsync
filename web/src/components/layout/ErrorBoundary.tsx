import * as React from "react";
import { Button } from "@/components/ui/button";

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error("UI crash", error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto mt-24 max-w-md space-y-3 rounded-xl border border-danger/40 bg-card p-6">
        <h1 className="text-lg font-semibold">This screen crashed</h1>
        <p className="text-sm text-muted-foreground">Nothing was changed. The problem has been logged in your browser console. Reload to continue.</p>
        <p className="break-all font-mono text-xs text-muted-foreground">{this.state.error.message}</p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );
  }
}
