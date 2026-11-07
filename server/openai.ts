import OpenAI from 'openai'

// OpenAI as a second brain for the travellers'-own-places features only (describing a place,
// finding its Instagram reels and TikToks). Planning stays with Claude or the offline planner.
// Claude is used when both keys are set.
export const OPENAI_MODEL = process.env.WAYFARER_OPENAI_MODEL ?? 'gpt-6-astra'

export const openaiEnabled = Boolean(process.env.OPENAI_API_KEY)

export const openai: OpenAI | null = openaiEnabled ? new OpenAI() : null
