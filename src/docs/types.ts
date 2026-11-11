// The documents vault's shape, shared by the browser and the server: tickets, bookings,
// passports, visas and insurance, what was read from each, and the alerts they raise.

export const DOC_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const
export type DocMime = typeof DOC_MIMES[number]
export const MAX_DOC_BYTES = 20 * 1024 * 1024

export const DOC_KINDS = ['flight', 'train', 'bus', 'ferry', 'hotel', 'car', 'event', 'insurance', 'passport', 'visa', 'id', 'other'] as const
export type DocKind = typeof DOC_KINDS[number]

export const KIND_LABEL: Record<DocKind, string> = {
  flight: 'Flight', train: 'Train', bus: 'Coach', ferry: 'Ferry', hotel: 'Stay', car: 'Car hire', event: 'Ticket',
  insurance: 'Insurance', passport: 'Passport', visa: 'Visa', id: 'ID', other: 'Document',
}

// A time as printed on the ticket ("2026-12-03T10:30"), with the UTC offset of where it
// happens ("+00:00", "-05:00") when known. Without one, the uploader's own offset is used.
export interface LocalTime { at: string; offset: string | null }

// One leg of a journey: a flight, a train, a coach or a ferry.
export interface Segment {
  carrier: string | null        // "British Airways", "Eurostar"
  number: string | null         // "BA 432", "9014"
  from: string                  // "London Heathrow (LHR)"
  to: string                    // "Lisbon (LIS)"
  depart: LocalTime
  arrive: LocalTime | null
  terminal: string | null
  seat: string | null
}

export interface Extracted {
  kind: DocKind
  title: string                 // "BA 432 London → Lisbon", "Hotel Avenida, 3 nights", "Passport"
  summary: string               // one line
  reference: string | null      // booking or confirmation code
  people: string[]              // travellers named on it
  segments: Segment[]           // flights, trains, coaches, ferries
  place: { name: string; address: string | null } | null // the hotel, venue or rental desk
  start: LocalTime | null       // check-in, the event, the pick-up, cover starts, valid from
  end: LocalTime | null         // check-out, drop-off, cover ends, valid until
  checkinUrl: string | null     // where to check in online, if printed
  holder: string | null         // whose passport, visa or ID
  country: string | null        // issuing country (passport, ID) or the country a visa is for
  numberTail: string | null     // last 4 characters of a document number, never the whole of it
  expires: string | null        // YYYY-MM-DD, for passports, IDs and visas
  notes: string[]               // what's worth knowing: baggage, "bring the card you paid with"
}

export type DocStatus = 'uploading' | 'reading' | 'ready' | 'failed'

export interface DocItem {
  id: string
  fileName: string
  mime: DocMime
  bytes: number
  status: DocStatus
  error: string | null
  kind: DocKind | null
  data: Extracted | null
  tripId: string | null         // the group (trip) it belongs to, if any
  createdAt: number
  alerts: AlertItem[]           // what's coming up from it
}

export type AlertKind = 'checkin' | 'depart' | 'stay-in' | 'stay-out' | 'pickup' | 'event' | 'expires' | 'invalid-for-trip' | 'cover-ends' | 'trip-uncovered'

export interface AlertItem {
  id: string
  docId: string | null
  kind: AlertKind
  title: string
  body: string
  dueAt: number                 // ms
  deliveredAt: number | null
  readAt: number | null
}

export interface UploadTarget { url: string; headers: Record<string, string> }
