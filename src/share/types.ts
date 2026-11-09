// A link shared to Wayfarer, as the server read it (server/share/read.ts).

export type LinkKind = 'maps' | 'video' | 'post' | 'search' | 'page'

export interface FoundPlace {
  name: string
  area: string
  city: string
  country: string
  // what the link says about it
  why: string
  // one of the cities Wayfarer plans, when it's in one
  cityId: string | null
  // a maps link: the place is read from the link itself
  link?: string
}

export interface ShareRead {
  url: string
  site: string
  kind: LinkKind
  title: string
  summary: string
  image: string | null
  places: FoundPlace[]
  // the site showed a login page: its session needs setting in the dev tools
  needsLogin: boolean
  note?: string
}
