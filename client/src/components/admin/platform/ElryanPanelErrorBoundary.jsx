import { Component } from "react";

/**
 * Keeps Elryan admin tabs from blanking the entire admin shell when a child throws.
 */
export default class ElryanPanelErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch() {
    // Intentionally no remote reporting; local recovery only.
  }

  render() {
    const { error } = this.state;
    const t = this.props.t || {};
    if (error) {
      return (
        <div className="space-y-3 rounded-[1.5rem] bg-white p-6 ring-1 ring-brown/10">
          <p className="text-sm font-semibold text-red-700">
            {t.elryanPanelCrashTitle || "Elryan panel failed to render."}
          </p>
          <p className="text-sm text-brown/60">
            {t.elryanPanelCrashHint ||
              "The rest of admin stays available. Reload this tab or refresh the page. The category catalog snapshot was not deleted."}
          </p>
          <p className="text-xs text-brown/45 break-words">{String(error?.message || error)}</p>
          <button
            type="button"
            className="rounded-full bg-brown px-4 py-2.5 text-sm font-semibold text-cream"
            onClick={() => this.setState({ error: null })}
          >
            {t.elryanPanelCrashRetry || "Try again"}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
