import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * What a page shows when something in it threw (a component, or the chart's script on a result
 * it cannot draw): the message, and the one thing that helps. Without it React removes the
 * whole page and leaves the document empty. The navigation stays: it is outside.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  /** Another address is another page: the error does not follow the person there. */
  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('viz: the page stopped', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="vz-page">
        <div className="vz-empty" role="alert" data-testid="page-error">
          <p className="vz-empty-title">
            <span className="vz-mark" data-state="critical" />
            This page stopped working
          </p>
          <p>
            Something in the page failed while it was being drawn: <span className="vz-qty">{error.message || String(error)}</span>. Nothing was changed or sent by this. Loading
            the page again asks the API afresh; if it stops again, the address in the address bar is what to report.
          </p>
          <div className="vz-controls">
            <button className="vz-button" data-size="sm" onClick={() => window.location.reload()}>
              Load the page again
            </button>
          </div>
        </div>
      </div>
    )
  }
}
