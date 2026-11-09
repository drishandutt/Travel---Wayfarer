import { z } from 'zod'

// Everything the trip chatbot can do, in one place. This list is the allowlist: the server
// offers the model these tools and nothing else, and the browser runs a call only if it names
// one of these and its arguments pass the schema. A tool that touches money or other people
// is marked `confirm`, and runs only after the traveller taps Confirm.
//
// Plan edits run through the same reducer actions as the app's own buttons, so they follow the
// same rules (a day keeps at least one stop, a normal user can't edit, everything is undoable).

const id = z.string().min(1).max(80)
const day = z.number().int().min(1).max(14)
const nullable = <T extends z.ZodTypeAny>(t: T) => t.nullable()

export const AGENT_TOOLS = {
  // ── read only ──
  find_videos: {
    risk: 'read',
    description: 'Find Instagram reels, TikToks and YouTube videos of a place. Returns titles, creators and links.',
    args: z.strictObject({ place_id: id }),
  },
  money_summary: {
    risk: 'read',
    description: 'The trip’s shared expenses: currency, people (with member ids), who owes whom, total spent, and recent expenses. Only for a trip shared with a group.',
    args: z.strictObject({}),
  },

  // ── the plan (undoable) ──
  add_stop: {
    risk: 'edit',
    description: 'Add a known place (by id from the catalog) to a day. It is placed where it adds the least walking.',
    args: z.strictObject({ place_id: id, day }),
  },
  remove_stop: {
    risk: 'edit',
    description: 'Remove a planned stop. A day must keep at least one stop.',
    args: z.strictObject({ place_id: id }),
  },
  move_stop: {
    risk: 'edit',
    description: 'Move a planned stop to another day.',
    args: z.strictObject({ place_id: id, to_day: day }),
  },
  reorder_stop: {
    risk: 'edit',
    description: 'Move a stop one place earlier or later within its day.',
    args: z.strictObject({ place_id: id, direction: z.enum(['earlier', 'later']) }),
  },
  tidy_day: {
    risk: 'edit',
    description: 'Re-order a day by time of day and walking distance.',
    args: z.strictObject({ day }),
  },
  fill_gap: {
    risk: 'edit',
    description: 'Fill the longest free stretch in a day with something nearby.',
    args: z.strictObject({ day }),
  },
  choose_hotel: {
    risk: 'edit',
    description: 'Make one of the scored hotels (by hotel id) the base for the trip.',
    args: z.strictObject({ hotel_id: id }),
  },
  change_trip: {
    risk: 'edit',
    description: 'Any other change, in plain words, for the planner’s edit engine: number of days, start times, pace, budget, travellers, more or less of a category, cheaper hotel, swapping a place for something cheaper or nearby, or “show me options near X” (opens a swipe deck). One change per call, phrased simply, e.g. “add a day”, “start day 2 at 10am”, “more relaxed”, “swap Skytree for something cheaper”.',
    args: z.strictObject({ instruction: z.string().min(2).max(200) }),
  },
  undo: {
    risk: 'edit',
    description: 'Undo the last change to the plan.',
    args: z.strictObject({}),
  },
  add_own_place: {
    risk: 'edit',
    description: 'Add a real place that is not in the catalog: by its name, or by a Google Maps / Apple Maps / OpenStreetMap / Waze link the traveller shared, or both. Give kind (one or two words, e.g. "nightclub", "ramen", "jazz bar") when you know it: it tells the place apart from others with the same name. Use the name as it is known locally, without notes in brackets. Optionally into a day. If a link alone comes back without a name, ask the traveller what the place is called, then call again with that name and the same link (the link gives the exact spot).',
    args: z.strictObject({ name: nullable(z.string().max(120)), link: nullable(z.string().max(2000)), kind: nullable(z.string().max(40)), day: nullable(day) }),
  },

  // ── money and people (asks first) ──
  log_expense: {
    risk: 'confirm',
    description: 'Log a shared expense in the group’s currency. Amount in normal units (e.g. 3000 for ¥3,000, 12.50 for €12.50). Paid by the traveller unless paid_by names a member id; split equally between everyone unless split_between lists member ids. Call money_summary first if you need member ids.',
    args: z.strictObject({
      title: z.string().min(1).max(80),
      amount: z.number().positive().max(10_000_000),
      paid_by: nullable(id),
      split_between: nullable(z.array(id).min(1).max(50)),
      place_id: nullable(id),
      day: nullable(day),
    }),
  },
  invite_person: {
    risk: 'confirm',
    description: 'Add someone to the trip’s group by email, so they can see the plan, vote and split costs.',
    args: z.strictObject({ email: z.string().email().max(200) }),
  },
  remove_person: {
    risk: 'confirm',
    description: 'Remove someone from the trip’s group by member id (from money_summary). Fails if they still owe or are owed money.',
    args: z.strictObject({ member_id: id }),
  },
} as const

export type ToolName = keyof typeof AGENT_TOOLS
export const isToolName = (n: string): n is ToolName => Object.hasOwn(AGENT_TOOLS, n)

export interface ToolCall { id: string; name: string; args: unknown }
export interface ToolResult { id: string; name: string; output: string }

// JSON Schema for each tool, for the model.
export function toolSchemas(): { name: ToolName; description: string; parameters: Record<string, unknown> }[] {
  return (Object.keys(AGENT_TOOLS) as ToolName[]).map(name => {
    const { $schema: _, ...parameters } = z.toJSONSchema(AGENT_TOOLS[name].args) as Record<string, unknown>
    return { name, description: AGENT_TOOLS[name].description, parameters }
  })
}

// One run (one traveller message) can take at most this many rounds of tool calls.
export const MAX_ROUNDS = 8
