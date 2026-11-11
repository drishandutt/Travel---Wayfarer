import { z } from 'zod'
import { DOC_KINDS, type DocMime, type Extracted, type LocalTime } from '../../src/docs/types'
import { FALLBACK, MODEL, brainEnabled, client, textOf } from '../claude'
import { OPENAI_MODEL, openai } from '../openai'
import { asJob } from '../usage'

// Reading a document: one model call (Claude, else OpenAI) on the PDF or photo, returning
// what Wayfarer needs to raise alerts and show it: the kind, each leg's times with the UTC
// offset of where it happens, the stay or event, validity and expiry dates. A document number
// is kept to its last 4 characters.

export class ReadError extends Error {}

const brief = `You read one travel document (a ticket, boarding pass, booking confirmation, passport, visa, ID card or insurance certificate) for a trip planner that reminds the traveller about it. Return only what the document actually says; use null (or an empty list) for anything it doesn't.
- kind: flight, train, bus (coaches too), ferry, hotel (any stay), car (hire), event (tickets to a show, match, museum, tour), insurance, passport, visa, id, or other.
- title: short, like "BA 432 London → Lisbon", "Hotel Avenida, 3 nights", "Passport", "Annual travel insurance".
- summary: one plain line about it.
- segments: every flight/train/coach/ferry leg in order. Times exactly as printed, as YYYY-MM-DDTHH:MM local to that place, and the UTC offset of that place on that date (e.g. "+00:00" for London in December, "+01:00" for Lisbon in summer) if you know the place; null if unsure. from/to: the city and station or airport, with the airport code in brackets if there is one.
- start/end: a stay's check-in and check-out (with times if printed), an event's start, a car's pick-up and drop-off, insurance cover from/to, a visa's valid from/until. Same time format; a date alone is YYYY-MM-DD.
- place: the hotel, venue or rental desk and its address.
- reference: the booking, confirmation or policy number.
- checkin_url: an online check-in or manage-booking link if printed.
- holder: the person a passport, visa or ID belongs to; country: the issuing country (or the country a visa is for).
- number_tail: only the LAST 4 characters of a passport, visa, ID or policy number, never more.
- expires: a passport, ID or visa's expiry date, YYYY-MM-DD.
- people: travellers named on a ticket or booking.
- notes: up to 4 short things worth knowing (baggage allowance, gate closes 30 min before, bring the card you paid with, cancellation deadline).`

const time = { anyOf: [{ type: 'object', additionalProperties: false, required: ['at', 'offset'], properties: { at: { type: 'string' }, offset: { type: ['string', 'null'] } } }, { type: 'null' }] }
const str = { type: ['string', 'null'] }
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'title', 'summary', 'reference', 'people', 'segments', 'place', 'start', 'end', 'checkin_url', 'holder', 'country', 'number_tail', 'expires', 'notes'],
  properties: {
    kind: { type: 'string', enum: DOC_KINDS },
    title: { type: 'string' },
    summary: { type: 'string' },
    reference: str,
    people: { type: 'array', items: { type: 'string' } },
    segments: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['carrier', 'number', 'from', 'to', 'depart', 'arrive', 'terminal', 'seat'],
        properties: { carrier: str, number: str, from: { type: 'string' }, to: { type: 'string' }, depart: { type: 'object', additionalProperties: false, required: ['at', 'offset'], properties: { at: { type: 'string' }, offset: str } }, arrive: time, terminal: str, seat: str },
      },
    },
    place: { anyOf: [{ type: 'object', additionalProperties: false, required: ['name', 'address'], properties: { name: { type: 'string' }, address: str } }, { type: 'null' }] },
    start: time,
    end: time,
    checkin_url: str,
    holder: str,
    country: str,
    number_tail: str,
    expires: str,
    notes: { type: 'array', items: { type: 'string' } },
  },
} as const

const T = z.object({ at: z.string(), offset: z.string().nullable() })
const Out = z.object({
  kind: z.enum(DOC_KINDS),
  title: z.string(),
  summary: z.string(),
  reference: z.string().nullable(),
  people: z.array(z.string()),
  segments: z.array(z.object({ carrier: z.string().nullable(), number: z.string().nullable(), from: z.string(), to: z.string(), depart: T, arrive: T.nullable(), terminal: z.string().nullable(), seat: z.string().nullable() })),
  place: z.object({ name: z.string(), address: z.string().nullable() }).nullable(),
  start: T.nullable(),
  end: T.nullable(),
  checkin_url: z.string().nullable(),
  holder: z.string().nullable(),
  country: z.string().nullable(),
  number_tail: z.string().nullable(),
  expires: z.string().nullable(),
  notes: z.array(z.string()),
})

const cut = (s: string | null, n: number) => (s ? s.trim().slice(0, n) || null : null)
const isTime = (t: LocalTime | null): LocalTime | null => (t && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(t.at) ? { at: t.at.slice(0, 16), offset: t.offset && /^[+-]\d{2}:?\d{2}$/.test(t.offset.trim()) ? t.offset.trim() : null } : null)

// What the model said, tidied: lengths capped, a document number cut to its tail whatever
// came back, dates that aren't dates dropped.
export function tidy(o: z.infer<typeof Out>): Extracted {
  const https = (u: string | null) => (u && /^https:\/\/[^\s]+$/i.test(u.trim()) ? u.trim().slice(0, 300) : null)
  return {
    kind: o.kind,
    title: cut(o.title, 100) ?? 'Document',
    summary: cut(o.summary, 200) ?? '',
    reference: cut(o.reference, 40),
    people: o.people.map(p => p.trim().slice(0, 80)).filter(Boolean).slice(0, 12),
    segments: o.segments.filter(s => isTime(s.depart)).slice(0, 12).map(s => ({ carrier: cut(s.carrier, 60), number: cut(s.number, 20), from: s.from.trim().slice(0, 80), to: s.to.trim().slice(0, 80), depart: isTime(s.depart)!, arrive: isTime(s.arrive), terminal: cut(s.terminal, 10), seat: cut(s.seat, 10) })),
    place: o.place ? { name: o.place.name.trim().slice(0, 100), address: cut(o.place.address, 200) } : null,
    start: isTime(o.start),
    end: isTime(o.end),
    checkinUrl: https(o.checkin_url),
    holder: cut(o.holder, 80),
    country: cut(o.country, 60),
    numberTail: o.number_tail ? o.number_tail.replace(/\s/g, '').slice(-4) || null : null,
    expires: o.expires && /^\d{4}-\d{2}-\d{2}$/.test(o.expires) ? o.expires : null,
    notes: o.notes.map(n => n.trim().slice(0, 140)).filter(Boolean).slice(0, 4),
  }
}

export async function readDocument(bytes: Buffer, mime: DocMime, fileName: string, signal?: AbortSignal): Promise<Extracted> {
  return asJob('docs', async () => {
    const data = bytes.toString('base64')
    const ask = `The file is “${fileName}”. Read it.`
    let json: string
    if (brainEnabled) {
      const file = mime === 'application/pdf'
        ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data } }
        : { type: 'image' as const, source: { type: 'base64' as const, media_type: mime as 'image/jpeg' | 'image/png' | 'image/webp', data } }
      const response = await client.beta.messages.create({
        ...FALLBACK, model: MODEL, max_tokens: 8000, system: brief,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content: [file, { type: 'text', text: ask }] }],
      }, { signal })
      if (response.stop_reason === 'refusal') throw new ReadError('The model wouldn’t read this one.')
      json = textOf(response)
    } else if (openai) {
      const url = `data:${mime};base64,${data}`
      const file = mime === 'application/pdf'
        ? { type: 'input_file' as const, filename: fileName.replace(/[^\w.\- ]/g, '_').slice(0, 100) || 'document.pdf', file_data: url }
        : { type: 'input_image' as const, image_url: url, detail: 'high' as const }
      const response = await openai.responses.create({
        model: OPENAI_MODEL, reasoning: { effort: 'low' }, instructions: brief,
        input: [{ role: 'user', content: [file, { type: 'input_text', text: ask }] }],
        text: { format: { type: 'json_schema', name: 'document', strict: true, schema: SCHEMA as unknown as Record<string, unknown> } },
      }, { signal })
      if (response.status !== 'completed') throw new ReadError('The model couldn’t finish reading this one.')
      json = response.output_text
    } else throw new ReadError('Reading documents needs Claude or OpenAI connected on the server.')
    return tidy(Out.parse(JSON.parse(json)))
  })
}
