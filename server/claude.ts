import Anthropic from '@anthropic-ai/sdk'

// One place for model choice and request defaults.
export const MODEL = process.env.WAYFARER_MODEL ?? 'claude-opus-5-5'

// The SDK resolves credentials itself (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
// or an `ant auth login` profile). We only gate on the env vars so the app can
// tell the browser up front whether to use Claude or the offline planner.
export const brainEnabled =
  process.env.WAYFARER_BRAIN !== 'mock' &&
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.WAYFARER_BRAIN === 'claude')

export const client = new Anthropic()

// Server-side refusal fallback: if a safety classifier declines, the API re-runs
// the request on Anthropic's recommended fallback model inside the same call.
export const FALLBACK: Pick<Anthropic.Beta.MessageCreateParamsNonStreaming, 'betas' | 'fallbacks'> = {
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export function effortFor(kind: 'intake' | 'plan' | 'hotel'): Effort {
  const env = process.env[`WAYFARER_EFFORT_${kind.toUpperCase()}`] as Effort | undefined
  return env ?? (kind === 'plan' ? 'medium' : 'low')
}

export function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Claude rejected the API key. Check ANTHROPIC_API_KEY in .env.'
  if (err instanceof Anthropic.RateLimitError) return 'Claude is rate-limited right now. Try again in a moment.'
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ''}: ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}
