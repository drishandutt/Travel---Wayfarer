import { useEffect, useRef } from 'react'
import type { Thought } from '../state/tripStore'

export function ThinkingStream({ thoughts, live, compact }: { thoughts: Thought[]; live: boolean; compact?: boolean }) {
  const ref = useRef<HTMLOListElement>(null)
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' }) }, [thoughts.length])

  return (
    <div className={`thinking ${compact ? 'compact' : ''}`}>
      <div className="thinking-head">
        <span className={`orb ${live ? 'live' : ''}`} />
        <span>{live ? 'Thinking' : 'Log'}</span>
      </div>
      <ol ref={ref}>
        {thoughts.map(t => (
          <li key={t.id} className={t.tone}>{t.text}</li>
        ))}
        {live && <li className="cursor">▍</li>}
      </ol>
    </div>
  )
}
