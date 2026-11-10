import type { TripBrief } from '../types'
import type { ChatMessage } from '../state/tripStore'
import { errorText } from './remotePlanner'

export interface BrainStatus { claude: boolean; model: string | null; agent?: boolean }

// Asks the API server whether Claude is configured. No server (or no key)
// means the app runs fully offline on the local MockPlanner + rule-based intake.
export async function detectBrain(): Promise<BrainStatus> {
  try {
    const res = await fetch('/api/health')
    if (!res.ok) return { claude: false, model: null }
    return (await res.json()) as BrainStatus
  } catch {
    return { claude: false, model: null }
  }
}

// `building`: the city they named is being mapped; wait for it (src/data/cityClient.ts).
export interface IntakeReply { reply: string; brief: TripBrief; building?: { id: string; name: string; progress: string } }

export async function claudeIntake(messages: ChatMessage[], brief: TripBrief): Promise<IntakeReply> {
  const res = await fetch('/api/intake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: messages.map(m => ({ role: m.role, text: m.text })), brief }),
  })
  if (!res.ok) throw new Error(await errorText(res))
  return res.json()
}
