import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { City, Place, TripBrief } from '../src/types'
import { CITIES, addCatalogPlaces, cityById, findCity, registerCity, tripCity } from '../src/data/cities'
import { audiencesOf, profileFit, profileLine, profileOf, ruleProfile } from '../src/planner/profile'
import { scorePlace } from '../src/planner/core'
import { converse } from '../src/planner/intake'
import { Db } from './money/db'
import { cityCandidates, moneyFor, roughTimezone, validZone } from './cities/build'
import { profileFrom } from './cities/profile'
import { attachCityDb, learnCity, learnFrom, loadCities, promoteFind, recordSignals, saveCity } from './cities/store'
import { amountsUsd, articleKind, dedupe, districtLinks, geoOf, listingsOf, placeholderHotels, priceOf, shapeCatalog } from './cities/wikivoyage'
import { isVenue } from './places'

// ── reading a guide ──────────────────────────────────────────────────────────

const GUIDE = `{{pagebanner|Porto banner.jpg}}
'''Porto''' is Portugal's second city.
{{geo|41.15|-8.61|zoom=13}}
==Districts==
{{Regionlist
| region1name=[[Porto/Ribeira|Ribeira]]
| region2name=[[Porto/Boavista|Boavista]]
}}
* [[Gaia]] — across the river
* [[File:Map.png]]
==See==
* {{see | name=Livraria Lello | lat=41.1468 | long=-8.6149 | wikidata=Q1241765 | price=€8 | content=A bookshop with a famous staircase. Queues form early.}}
* {{see | name=Clérigos Tower | lat=41.1457 | long=-8.6140 | wikidata=Q1101977 | price=Adults €8, children €4 | content=Baroque bell tower with city views.}}
* {{listing | type=see | name=Jardins do Palácio de Cristal | lat=41.1474 | long=-8.6262 | price=Free | content=Gardens over the river.}}
* {{see | name=São João Festival | lat=41.14 | long=-8.61 | content=A night of hammers.}}
* {{see | name=FC Porto Museum | lat=41.1617 | long=-8.5838 | wikidata=Q140590 | content=The club's museum at the Dragão stadium.}}
==Eat==
===Budget===
* {{eat | name=Casa Guedes | lat=41.1490 | long=-8.6010 | content=The pork sandwich place. Roast pork, serra cheese.}}
===Splurge===
* {{eat | name=The Yeatman | lat=41.1330 | long=-8.6130 | price=€150 | content=Michelin dining with port.}}
==Drink==
* {{drink | name=Café Majestic | lat=41.1478 | long=-8.6066 | content=Belle-époque coffee house.}}
==Sleep==
* {{sleep | name=Pensão Favorita | lat=41.1520 | long=-8.6200 | price=€90-140 | content=Rooms in a townhouse.}}
* {{sleep | name=Hostel Gallery | lat=41.1500 | long=-8.6150 | price=Dorms €25 | content=Bunks and a bar.}}
{{usablecity}}
`

const money = { code: 'EUR', symbol: '€', perUsd: 0.92 }

describe('reading a Wikivoyage guide', () => {
  it('tells a city guide from a country or region', () => {
    assert.equal(articleKind(GUIDE), 'city')
    assert.equal(articleKind('{{outlineregion}} nothing to see'), 'other')
    assert.equal(articleKind('{{guidecountry}}'), 'other')
    assert.equal(articleKind('{{usabledistrict}}'), 'district')
  })
  it('finds where the guide says the city is', () => {
    assert.deepEqual(geoOf(GUIDE), { center: [-8.61, 41.15], zoom: 13 })
    assert.equal(geoOf('no geo here'), undefined)
  })
  it('lists the district pages, subpages and boroughs alike, never files', () => {
    assert.deepEqual(districtLinks(GUIDE, 'Porto'), ['Porto/Ribeira', 'Porto/Boavista', 'Gaia'])
  })
  it('reads listings with their section, price band and Wikidata id', () => {
    const ls = listingsOf(GUIDE, 'Porto')
    assert.equal(ls.length, 10)
    assert.equal(ls.find(l => l.name === 'Casa Guedes')?.band, 'budget')
    assert.equal(ls.find(l => l.name === 'The Yeatman')?.band, 'splurge')
    assert.equal(ls.find(l => l.name === 'Livraria Lello')?.wikidata, 'Q1241765')
    assert.equal(ls.find(l => l.name === 'Jardins do Palácio de Cristal')?.type, 'see')
  })
  it('reads prices in any money, into dollars', () => {
    assert.deepEqual(amountsUsd('€8', money).map(Math.round), [9])
    assert.deepEqual(amountsUsd('¥1,500', { code: 'JPY', symbol: '¥', perUsd: 150 }), [10])
    assert.deepEqual(amountsUsd('12 €', money).map(Math.round), [13])
    assert.deepEqual(amountsUsd('150 kr', { code: 'SEK', symbol: 'kr', perUsd: 10.5 }).map(Math.round), [14])
    assert.deepEqual(amountsUsd('US$20 or £10', { code: 'INR', symbol: '₹', perUsd: 83 }).map(Math.round), [20, 13])
    assert.equal(priceOf({ price: 'Adults €8, children €4', type: 'see' }, 'sight', money), 1)
    assert.equal(priceOf({ price: '€150', type: 'eat' }, 'food', money), 3)
    assert.equal(priceOf({ price: 'Free', type: 'see' }, 'museum', money), 0)
  })
  it('shapes a catalog: events out, fame ranked, stays with prices, kinds from names', () => {
    const seen = dedupe(listingsOf(GUIDE, 'Porto'), [-8.61, 41.15], 25)
    assert.ok(!seen.some(l => l.name === 'São João Festival'))
    const { places, hotels } = shapeCatalog(seen, { prefix: 'por', center: [-8.61, 41.15], maxKm: 25, money, fame: new Map([['Q1241765', 40], ['Q1101977', 10], ['Q140590', 90]]) })
    // a football club's article is famous in every language; its ground is a niche visit
    assert.equal(places[0].name, 'Livraria Lello')
    assert.ok((places.find(p => p.name === 'FC Porto Museum')?.rank ?? 1) < 0.4)
    assert.ok((places[0].rank ?? 0) > (places.find(p => p.name === 'Clérigos Tower')?.rank ?? 0))
    assert.equal(places.find(p => p.name === 'Jardins do Palácio de Cristal')?.kind, 'park')
    assert.equal(places.find(p => p.name === 'Café Majestic')?.kind, 'cafe')
    assert.equal(places.find(p => p.name === 'Casa Guedes')?.price, 1)
    assert.deepEqual(hotels.map(h => [h.name, h.nightly, h.tier]).sort(), [['Hostel Gallery', 27, 'shoestring'], ['Pensão Favorita', 98, 'shoestring']])
    assert.ok(places.every(p => p.id.startsWith('por-')))
    assert.equal(places.find(p => p.name === 'Clérigos Tower')?.id, 'por-clerigos-tower')
    // a Splurge heading in Eat doesn't price the Drink section after it
    assert.equal(places.find(p => p.name === 'Café Majestic')?.price, 1)
  })
  it('makes placeholder stays where a guide prices none', () => {
    const seen = listingsOf(GUIDE, 'Porto')
    const stays = placeholderHotels('por', seen, [-8.61, 41.15])
    assert.equal(stays.length, 3)
    assert.deepEqual(stays.map(s => s.tier), ['shoestring', 'comfort', 'luxury'])
    assert.ok(stays[0].name.includes('Porto'))
  })
})

describe('finding the city in a message', () => {
  it('tries capitalised names first, then the message without its filler', () => {
    assert.deepEqual(cityCandidates('3 days in New York for 2 of us'), ['New York'])
    assert.deepEqual(cityCandidates('going to paris with my wife'), ['paris'])
    assert.deepEqual(cityCandidates("let's do Berlin next month"), ['Berlin'])
    assert.deepEqual(cityCandidates('Lisbon'), ['Lisbon'])
    assert.ok(cityCandidates('I want to see Rio de Janeiro').includes('Rio de Janeiro'))
  })
  it('knows a country’s money and a rough time zone', () => {
    assert.deepEqual(moneyFor('pt'), { code: 'EUR', symbol: '€', perUsd: 0.92, known: true })
    assert.equal(moneyFor('jp', c => (c === 'JPY' ? 151.3 : undefined)).perUsd, 151)
    assert.equal(moneyFor('zz').known, false)
    assert.equal(roughTimezone([139.7, 35.7]), 'Etc/GMT-9')
    assert.equal(roughTimezone([-74, 40.7]), 'Etc/GMT+5')
    assert.ok(validZone('Europe/Lisbon') && validZone(roughTimezone([-9, 38])))
    assert.ok(!validZone('Mars/Olympus'))
  })
})

// ── the registry ─────────────────────────────────────────────────────────────

const porto: City = {
  id: 'porto', name: 'Porto', country: 'Portugal', center: [-8.61, 41.15], zoom: 12.4, aliases: ['porto', 'oporto'],
  places: [
    { id: 'por-lello', name: 'Livraria Lello', kind: 'sight', coord: [-8.6149, 41.1468], tags: ['culture', 'history'], price: 1, minutes: 60, blurb: 'A bookshop with a famous staircase.', bestAt: 'midday', rank: 0.9 },
    { id: 'por-guedes', name: 'Casa Guedes', kind: 'food', coord: [-8.601, 41.149], tags: ['food'], price: 1, minutes: 45, blurb: 'The pork sandwich place.', bestAt: 'midday', keywords: ['pork', 'sandwich'], rank: 0.3 },
  ],
  hotels: [{ id: 'por-h-1', name: 'A stay', coord: [-8.62, 41.15], nightly: 100, tier: 'comfort', tags: ['culture'], blurb: 'Rooms.' }],
  transport: { transitName: 'Metro', transitFare: 1.5, taxiBase: 3, taxiPerKm: 1 },
  essentials: { timezone: 'Europe/Lisbon', currency: { code: 'EUR', symbol: '€', perUsd: 0.92 }, plugs: '', tipping: '', emergency: '', transitCard: '', water: '', etiquette: [], phrases: [], packing: [] },
  built: '2026-11-10',
}

describe('the city registry', () => {
  it('registers a built city for the planners, aliases included', () => {
    const before = CITIES.length
    registerCity(porto)
    assert.equal(CITIES.length, before + 1)
    assert.equal(cityById('porto')?.name, 'Porto')
    assert.equal(findCity('a weekend in Oporto')?.id, 'porto')
    // the longest alias wins: "new york" over "york"
    registerCity({ ...porto, id: 'york', name: 'York', aliases: ['york'] })
    registerCity({ ...porto, id: 'new-york-city', name: 'New York City', aliases: ['new york city', 'new york'] })
    assert.equal(findCity('3 days in New York')?.id, 'new-york-city')
    assert.equal(findCity('York minster')?.id, 'york')
  })
  it('replaces a city in place and re-reads the trip’s copy', () => {
    const brief: TripBrief = { destination: 'porto', days: 2, vibes: [], customPlaces: [{ ...porto.places[1], id: 'my-own', name: 'Own find', coord: [-8.6, 41.14], custom: { from: 'name' } }] }
    assert.equal(tripCity(brief)!.places.length, 3)
    assert.equal(addCatalogPlaces('porto', [{ ...porto.places[0], id: 'por-new', name: 'New' }]), 1)
    assert.equal(cityById('porto')!.places.length, 3)
    assert.equal(tripCity(brief)!.places.length, 4)
    // a find the catalog now lists itself is the catalog's copy, not doubled
    addCatalogPlaces('porto', [{ ...brief.customPlaces![0], custom: undefined, found: { at: 1 } }])
    assert.equal(tripCity(brief)!.places.length, 4)
    assert.ok(tripCity(brief)!.places.find(p => p.id === 'my-own')?.found)
  })
  it('asks the server about a city the offline intake doesn’t know', () => {
    const asked = converse('Where to?', { vibes: [] }).brief
    const r = converse('Somewhere like Coimbra', asked)
    assert.equal(r.lookup, 'Somewhere like Coimbra')
    assert.ok(r.reply.includes('Which city'))
    const again = converse('Somewhere like Coimbra', asked, 'coimbra')
    assert.equal(again.brief.destination, 'coimbra')
    assert.equal(again.lookup, undefined)
    assert.equal(converse('5', { vibes: [], destination: 'porto' }).lookup, undefined)
  })
})

// ── profiles ─────────────────────────────────────────────────────────────────

describe('place profiles', () => {
  const bar: Place = { id: 'b', name: 'A bar', kind: 'bar', coord: [0, 0], tags: ['nightlife'], price: 2, minutes: 90, blurb: '', bestAt: 'night', rank: 0.3 }
  const park: Place = { id: 'p', name: 'A park', kind: 'park', coord: [0, 0], tags: ['nature', 'relaxed'], price: 0, minutes: 60, blurb: '', bestAt: 'morning', rank: 0.9 }

  it('gives every place one from the rules', () => {
    const b = ruleProfile(bar)
    assert.ok(b.kids < 0.2 && b.late >= 0.8 && b.lively >= 0.8)
    assert.ok(b.notFor.includes('families') && b.for.includes('night-owls') && b.for.includes('locals'))
    const p = ruleProfile(park)
    assert.ok(p.kids >= 0.9 && p.for.includes('families') && p.for.includes('budget') && p.for.includes('first-timers'))
    assert.ok(p.strengths.includes('free to visit') && p.weaknesses.includes('queues at peak times'))
  })
  it('reads who the trip is from the brief', () => {
    assert.deepEqual(audiencesOf({ vibes: [], travelers: 1, kids: 0, familiarity: 0 }), ['first-timers', 'solo'])
    assert.deepEqual(audiencesOf({ vibes: ['food'], travelers: 2, kids: 1, foodie: 0.8, rhythm: 1, budgetTier: 'shoestring', crowds: 0.75, familiarity: 1 }), ['locals', 'families', 'foodies', 'night-owls', 'budget', 'crowd-averse'])
  })
  it('scores a place for who it suits, and says why when someone knew the place', () => {
    const family: TripBrief = { vibes: [], travelers: 4, kids: 1 }
    assert.ok(scorePlace(park, family).score > scorePlace(bar, family).score)
    assert.equal(profileFit(bar, family).why, undefined, 'the rules alone don’t claim to know')
    const known = profileFrom({ strengths: ['Cheap pints'], weaknesses: ['Packed on Fridays.'], for: ['night-owls', 'budget'], not_for: ['families', 'night-owls'], kids: 0.1, busy: 0.9, lively: 0.9, late: 1, known: true }, bar, 'claude', 5)!
    assert.deepEqual(known.notFor, ['families'], 'a place isn’t both for and not for the same people')
    assert.deepEqual(known.weaknesses, ['Packed on Fridays'])
    const owl: TripBrief = { vibes: [], travelers: 1, rhythm: 1 }
    assert.equal(profileFit({ ...bar, profile: known }, owl).why, 'for a night owl')
    assert.equal(profileFit({ ...bar, profile: known }, family).score, -2.5)
    assert.equal(profileFrom({ strengths: [], weaknesses: [], for: [], not_for: [], kids: 0.5, busy: 0.5, lively: 0.5, late: 0.5, known: false }, bar, 'claude'), undefined)
    assert.equal(profileLine({ ...bar, profile: known }), 'for night-owls, budget; not families')
    assert.equal(profileLine(bar), undefined)
  })
  it('learns from swipes who keeps a place', () => {
    const rows = [
      ...Array.from({ length: 5 }, () => ({ place_id: 'x', kept: 1, audiences: '["families"]' })),
      ...Array.from({ length: 5 }, () => ({ place_id: 'x', kept: 0, audiences: '["night-owls"]' })),
      ...Array.from({ length: 3 }, () => ({ place_id: 'few', kept: 1, audiences: '["families"]' })),
    ]
    const learned = learnFrom(rows)
    assert.deepEqual(learned.get('x'), { signals: 10, for: ['families'], notFor: ['night-owls'] })
    assert.equal(learned.get('few'), undefined, 'a handful teaches nothing')
    const taught = { ...bar, profile: { ...ruleProfile(bar), learned: learned.get('x') } }
    assert.equal(profileFit(taught, { vibes: [], kids: 1 }).why, 'good with little ones')
    assert.equal(profileOf(taught).learned?.signals, 10)
  })
  it('knows a venue from a home by what the map calls it', () => {
    assert.ok(isVenue({ category: 'amenity', type: 'restaurant' }))
    assert.ok(isVenue({ category: 'tourism', type: 'attraction' }))
    assert.ok(isVenue({ category: 'leisure', type: 'park' }))
    assert.ok(!isVenue({ category: 'building', type: 'house' }))
    assert.ok(!isVenue({ category: 'place', type: 'house' }))
    assert.ok(!isVenue({ category: 'tourism', type: 'hotel' }))
    assert.ok(!isVenue({ category: 'amenity', type: 'school' }))
    assert.ok(!isVenue(undefined))
  })
})

// ── the store ────────────────────────────────────────────────────────────────

describe('the cities store', () => {
  let db: Db
  before(async () => {
    db = await Db.local()
    attachCityDb(db)
  })
  after(async () => {
    attachCityDb(null)
    await db.close()
  })

  it('keeps a built city and loads it back, with promoted finds and what swipes taught', async () => {
    const braga = { ...porto, id: 'braga', name: 'Braga', aliases: ['braga'], places: porto.places.map(p => ({ ...p, id: p.id.replace('por-', 'bra-') })) }
    await saveCity(braga)
    const found: Place = { id: 'my-taberna-x', name: 'Taberna Belga', kind: 'food', coord: [-8.62, 41.16], tags: ['food'], price: 1, minutes: 60, blurb: 'Your find: a restaurant in Braga.', bestAt: 'evening', custom: { from: 'google', url: 'https://maps.app.goo.gl/x' } }
    // registered already (startBuild does this): promotion goes to the catalog in memory and the database
    registerCity(braga)
    const shared = await promoteFind('braga', found, 'user-1')
    assert.ok(shared?.found?.at)
    assert.equal(shared?.custom, undefined)
    assert.equal(shared?.blurb, 'A restaurant in Braga.'.replace(/^A/, 'a'))
    assert.equal(await promoteFind('braga', { ...found, id: 'my-taberna-again' }, null), undefined, 'the same spot isn’t promoted twice')
    assert.equal(await promoteFind('braga', { ...found, id: 'my-elsewhere', name: 'Elsewhere', coord: [-8.5, 41.2] }, null) !== undefined, true)

    await recordSignals('braga', ['bra-lello'], ['bra-guedes'], { vibes: [], kids: 1 })
    for (let i = 0; i < 6; i++) await recordSignals('braga', ['bra-lello'], [], { vibes: [], kids: 1, travelers: 4 })
    for (let i = 0; i < 4; i++) await recordSignals('braga', [], ['bra-lello'], { vibes: [], rhythm: 1 })
    assert.equal(await learnCity('braga'), 1)
    assert.deepEqual(cityById('braga')!.places.find(p => p.id === 'bra-lello')!.profile!.learned, { signals: 11, for: ['families', 'groups'], notFor: ['night-owls'] })

    // a fresh start: the registry is rebuilt from the database
    const i = CITIES.findIndex(c => c.id === 'braga')
    CITIES.splice(i, 1)
    assert.equal(cityById('braga'), undefined)
    await loadCities()
    const back = cityById('braga')!
    assert.equal(back.places.length, 4)
    assert.ok(back.places.some(p => p.id === 'my-taberna-x' && p.found))
    assert.deepEqual(back.places.find(p => p.id === 'bra-lello')!.profile!.learned?.for, ['families', 'groups'])
  })
})
