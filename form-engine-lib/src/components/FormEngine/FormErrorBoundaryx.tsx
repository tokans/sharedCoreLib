"use client";

import React from "react";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  formId?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class FormErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[FormEngine] Error:", error.message, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-800 p-6 text-center">
        <div className="text-3xl mb-3">⚠️</div>
        <h3 className="font-semibold text-red-700 dark:text-red-400 mb-1">
          Form render error
        </h3>
        <p className="text-sm text-red-600 dark:text-red-300 mb-4">
          {this.state.error?.message ?? "An unexpected error occurred."}
          {this.props.formId && (
            <span className="block mt-1 font-mono text-xs opacity-70">Form: {this.props.formId}</span>
          )}
        </p>
        <button
          onClick={() => this.setState({ hasError: false, error: null })}
          className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm hover:bg-red-700 transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }
}
