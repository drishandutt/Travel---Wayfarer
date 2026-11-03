import { Component, type ReactNode } from 'react'

// Last line of defence: an unexpected error shows a way back instead of a blank
// screen. The trip in progress is autosaved, so reloading picks up where it was.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[wayfarer]', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash">
        <span className="eyebrow">Something went sideways</span>
        <h1>That wasn’t supposed to happen.</h1>
        <p>Your trip is saved on this device. Reload to pick up where you left off.</p>
        <button className="cta" onClick={() => location.reload()}>Reload Wayfarer</button>
        <small>{this.state.error.message}</small>
      </div>
    )
  }
}
