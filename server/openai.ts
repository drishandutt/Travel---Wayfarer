import OpenAI from 'openai'

// OpenAI as a second brain: describing and profiling places, the essentials of a new city,
// finding reels and TikToks, the trip assistant and the dev tools' analyst when there's no
// Anthropic key. Claude is used when both are set.
//
// The key comes from OPENAI_API_KEY, or from the dev tools (server/dev/settings.ts), which
// win when set and take effect at once. `openai` and `openaiEnabled` are live bindings: every
// module that imports them sees a key set later.
export const OPENAI_MODEL = process.env.WAYFARER_OPENAI_MODEL ?? 'gpt-6-astra'

export let openaiEnabled = Boolean(process.env.OPENAI_API_KEY)
export let openai: OpenAI | null = openaiEnabled ? new OpenAI() : null
let source: 'env' | 'dev tools' | null = openaiEnabled ? 'env' : null
let tail: string | null = process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.slice(-4) : null

// A key from the dev tools, or null to fall back to the environment's.
export function setOpenAIKey(key: string | null) {
  const k = key?.trim() || process.env.OPENAI_API_KEY || null
  openai = k ? new OpenAI({ apiKey: k }) : null
  openaiEnabled = Boolean(k)
  source = key?.trim() ? 'dev tools' : k ? 'env' : null
  tail = k ? k.slice(-4) : null
}

// Where the key came from and its last four characters: never the key itself.
export const openaiKeyInfo = () => ({ source, tail, model: OPENAI_MODEL })

// Asks OpenAI whether a key works, without keeping it.
export async function checkOpenAIKey(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await new OpenAI({ apiKey: key.trim() }).models.list({ timeout: 10_000 })
    return { ok: true }
  } catch (err) {
    const status = (err as { status?: number }).status
    return { ok: false, error: status === 401 ? 'OpenAI says that key isn’t valid.' : `OpenAI didn’t accept it: ${(err as Error).message}` }
  }
}
