import type { TripBrief } from '../types'
import type { ChatMessage } from '../state/tripStore'
import { errorText } from './remotePlanner'

// `planner`: which model plans on the server (Claude, or OpenAI when there's no Anthropic key).
export interface BrainStatus { claude: boolean; planner?: 'claude' | 'openai' | null; model: string | null; agent?: boolean }

// The server plans with a model (older servers only said whether it was Claude).
export const plansRemotely = (b: BrainStatus | null) => Boolean(b && (b.planner ?? (b.claude ? 'claude' : null)))

// "Claude Opus 5.5", "GPT 6 Astra": the model's id, readable.
export function modelLabel(model: string | null | undefined): string {
  if (!model) return 'the planner'
  if (model.startsWith('claude-')) return model.replace('claude-', 'Claude ').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/\b([a-z])/g, c => c.toUpperCase())
  return model.split('-').map(w => (/^gpt$/i.test(w) ? 'GPT' : w[0].toUpperCase() + w.slice(1))).join(' ')
}

// Asks the API server whether a model is configured. No server (or no key)
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
export interface IntakeReply { reply: string; chips?: string[]; brief: TripBrief; building?: { id: string; name: string; progress: string } }

export async function claudeIntake(messages: ChatMessage[], brief: TripBrief): Promise<IntakeReply> {
  const res = await fetch('/api/intake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: messages.map(m => ({ role: m.role, text: m.text })), brief }),
  })
  if (!res.ok) throw new Error(await errorText(res))
  return res.json()
}

// Where they said they're staying, found on the map.
export async function findStay(name: string, city: string): Promise<{ name: string; coord: [number, number] }> {
  const res = await fetch('/api/places/stay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, city }) })
  if (!res.ok) throw new Error(await errorText(res))
  return res.json()
}
