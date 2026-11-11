import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { FALLBACK, MODEL, brainEnabled, client, effortFor, textOf } from './claude'
import { OPENAI_MODEL, openai } from './openai'

// The planner's brain, whichever is connected: Claude when ANTHROPIC_API_KEY is set, otherwise
// OpenAI (its key from the environment or the dev tools). The intake, the planner and the hotel
// pick go through here, so they work the same on either.

export type Provider = 'claude' | 'openai'

// WAYFARER_BRAIN=mock keeps planning offline whatever keys are set
export const provider = (): Provider | null => (process.env.WAYFARER_BRAIN === 'mock' ? null : brainEnabled ? 'claude' : openai ? 'openai' : null)
export const modelName = (): string | null => {
  const p = provider()
  return p === 'claude' ? MODEL : p === 'openai' ? OPENAI_MODEL : null
}
export const providerName = () => (provider() === 'openai' ? 'OpenAI' : 'Claude')

type Kind = Parameters<typeof effortFor>[0]
const openaiEffort = (kind: Kind): 'low' | 'medium' | 'high' => {
  const e = effortFor(kind)
  return e === 'low' ? 'low' : e === 'medium' ? 'medium' : 'high'
}

export interface Turn { role: 'user' | 'assistant'; content: string }

// One call that answers in JSON matching `schema` (strict: every property required, no extras).
export async function structured(o: { kind: Kind; name: string; system?: string; messages: Turn[]; schema: Record<string, unknown>; signal?: AbortSignal }): Promise<unknown> {
  const p = provider()
  if (p === 'claude') {
    const response = await client.beta.messages.create({
      ...FALLBACK,
      model: MODEL,
      max_tokens: 16000,
      ...(o.system ? { system: o.system } : {}),
      output_config: { effort: effortFor(o.kind), format: { type: 'json_schema', schema: o.schema } },
      messages: o.messages,
    }, { signal: o.signal })
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to answer that.')
    return JSON.parse(textOf(response))
  }
  if (p === 'openai') {
    const response = await openai!.responses.create({
      model: OPENAI_MODEL,
      reasoning: { effort: openaiEffort(o.kind) },
      ...(o.system ? { instructions: o.system } : {}),
      input: o.messages.map(m => ({ role: m.role, content: m.content })),
      text: { format: { type: 'json_schema', name: o.name, strict: true, schema: o.schema } },
      max_output_tokens: 16000,
    }, { signal: o.signal })
    if (response.status !== 'completed') throw new Error('OpenAI didn’t finish its answer.')
    return JSON.parse(response.output_text)
  }
  throw new Error('No model is connected on the server.')
}

// A tool loop. `handle` runs one call and may stream events while it does; what it returns goes
// back to the model. The loop ends when the model stops calling tools, when `handle` says the work
// is finished, or after `maxTurns` rounds.
export interface ToolDef { name: string; description: string; schema: Record<string, unknown> }
export interface ToolOutcome { output: string; error?: boolean; finished?: boolean }

export async function* toolLoop<E>(o: {
  kind: Kind
  system: string
  opening: string
  tools: ToolDef[]
  maxTurns: number
  signal: AbortSignal
  onText?: (text: string) => E | undefined
  handle: (name: string, input: unknown) => AsyncGenerator<E, ToolOutcome>
}): AsyncGenerator<E, void> {
  const p = provider()
  if (p === 'claude') {
    const tools: Anthropic.Beta.BetaTool[] = o.tools.map(t => ({ name: t.name, description: t.description, strict: true, input_schema: t.schema as Anthropic.Beta.BetaTool.InputSchema }))
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: o.opening }]
    for (let turn = 0; turn < o.maxTurns; turn++) {
      const response = await client.beta.messages.create({
        ...FALLBACK, model: MODEL, max_tokens: 16000, system: o.system, tools, output_config: { effort: effortFor(o.kind) }, messages,
      }, { signal: o.signal })
      if (response.stop_reason === 'refusal') throw new Error('Claude declined to carry on.')
      const prose = textOf(response).trim()
      const said = prose ? o.onText?.(prose) : undefined
      if (said) yield said
      const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      if (!calls.length) return
      if (response.stop_reason === 'max_tokens') throw new Error('Claude ran out of room part-way; try a shorter trip.')
      // the assistant turn goes back unchanged, which keeps thinking blocks valid across turns
      messages.push({ role: 'assistant', content: response.content })
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
      let finished = false
      for (const call of calls) {
        const out = yield* o.handle(call.name, call.input)
        results.push({ type: 'tool_result', tool_use_id: call.id, content: out.output, ...(out.error ? { is_error: true } : {}) })
        finished ||= Boolean(out.finished)
      }
      messages.push({ role: 'user', content: results })
      if (finished) return
    }
    return
  }
  if (p === 'openai') {
    const tools: OpenAI.Responses.FunctionTool[] = o.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema, strict: true }))
    let input: OpenAI.Responses.ResponseInput = [{ role: 'user', content: o.opening }]
    let previous: string | undefined
    for (let turn = 0; turn < o.maxTurns; turn++) {
      const response = await openai!.responses.create({
        model: OPENAI_MODEL,
        reasoning: { effort: openaiEffort(o.kind) },
        instructions: o.system,
        tools,
        input,
        ...(previous ? { previous_response_id: previous } : {}),
        store: true, // the next round refers back to this one by id
        max_output_tokens: 16000,
      }, { signal: o.signal })
      const prose = response.output_text?.trim()
      const said = prose ? o.onText?.(prose) : undefined
      if (said) yield said
      const calls = response.output.filter((b): b is OpenAI.Responses.ResponseFunctionToolCall => b.type === 'function_call')
      if (!calls.length) {
        if (response.status === 'incomplete') throw new Error('OpenAI ran out of room part-way; try a shorter trip.')
        return
      }
      const outputs: OpenAI.Responses.ResponseInputItem[] = []
      let finished = false
      for (const call of calls) {
        let args: unknown = null
        try { args = JSON.parse(call.arguments) } catch { /* handled below as bad input */ }
        const out: ToolOutcome = args === null ? { output: 'The arguments weren’t valid JSON.', error: true } : yield* o.handle(call.name, args)
        outputs.push({ type: 'function_call_output', call_id: call.call_id, output: out.error ? `Error: ${out.output}` : out.output })
        finished ||= Boolean(out.finished)
      }
      previous = response.id
      input = outputs
      if (finished) return
    }
    return
  }
  throw new Error('No model is connected on the server.')
}
