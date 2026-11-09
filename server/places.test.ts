import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { customPlaceRequest, featureCoord, findMapsLink, isFind, parseCoords, parseMapsLink, s2CellCenter, sameSpot } from '../src/planner/customPlaces'
import { cityOfPlace, tripCity } from '../src/data/cities'
import { reducer, initialState, type TripState } from '../src/state/tripStore'
import { buildDay } from '../src/planner/core'
import type { Place, TripBrief } from '../src/types'
import { isKind, mentions, nameVariants, openAIResults, parseYouTube, readPlacePage, shapeOf } from './places'

const tokyo: TripBrief = { destination: 'tokyo', days: 2, vibes: ['food'] }

describe('finding a place by name', () => {
  it('tries a name with a note in brackets each way, and with the city', () => {
    assert.deepEqual(nameVariants('ATOM (Atom Shinjuku)', 'Tokyo'), ['ATOM (Atom Shinjuku)', 'ATOM', 'Atom Shinjuku', 'ATOM Tokyo', 'Atom Shinjuku Tokyo'])
    assert.deepEqual(nameVariants('Fuunji', 'Tokyo'), ['Fuunji', 'Fuunji Tokyo'])
    assert.deepEqual(nameVariants('Atom Tokyo', 'Tokyo'), ['Atom Tokyo'])
  })
  it('tells a nightclub from a hairdresser of the same name', () => {
    assert.ok(isKind({ category: 'amenity', type: 'nightclub' }, 'nightclub'))
    assert.ok(isKind({ category: 'amenity', type: 'nightclub' }, 'clubs'))
    assert.ok(!isKind({ category: 'shop', type: 'hairdresser' }, 'nightclub'))
    assert.ok(!isKind({ category: 'amenity', type: 'nightclub' }, undefined))
  })
})

describe('maps links', () => {
  it('reads the pin from a full Google Maps place link, not where the map was looking', () => {
    const l = parseMapsLink('https://www.google.com/maps/place/Fuunji/@35.6869,139.69,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x1!8m2!3d35.6868901!4d139.6966856!16s')
    assert.deepEqual(l, { from: 'google', name: 'Fuunji', coord: [139.6966856, 35.6868901] })
  })
  it('reads Google query links by name or by coordinates', () => {
    assert.deepEqual(parseMapsLink('https://maps.google.com/?q=35.66,139.70'), { from: 'google', name: undefined, coord: [139.7, 35.66] })
    assert.equal(parseMapsLink('https://www.google.com/maps/search/?api=1&query=Ichiran+Shibuya')?.name, 'Ichiran Shibuya')
  })
  it('reads the spot from a Google feature id, which is where shared short links lead', () => {
    // checked against the s2sphere reference library: S2 cell 0x60188908e728e749 is in Koto, Tokyo
    const [lng, lat] = featureCoord('0x60188908e728e749:0x6de450c94bd3d622')!
    assert.ok(Math.abs(lng - 139.80135029) < 1e-6 && Math.abs(lat - 35.66668610) < 1e-6)
    assert.deepEqual(parseMapsLink('https://maps.google.com/?ftid=0x60188908e728e749:0x6de450c94bd3d622&entry=gps')?.coord, [lng, lat])
    // a leaf cell near (0, 0) on face 0, and nonsense ids
    const [x, y] = s2CellCenter(0x1000000000000001n)!
    assert.ok(Math.abs(x) < 50 && Math.abs(y) < 50)
    assert.equal(featureCoord('0xzz:0x1'), undefined)
    assert.equal(s2CellCenter(0xF000000000000001n), undefined, 'there is no face 7')
  })
  it('knows short links need following', () => {
    assert.deepEqual(parseMapsLink('https://maps.app.goo.gl/AbC123xyz'), { from: 'google', short: true })
    assert.equal(parseMapsLink('https://maps.apple/p/Xyz.abc')?.short, true)
  })
  it('reads Apple Maps links, old and new', () => {
    assert.deepEqual(parseMapsLink('https://maps.apple.com/?address=Yoyogi&ll=35.6869,139.6967&q=Fuunji&t=m'), { from: 'apple', name: 'Fuunji', coord: [139.6967, 35.6869] })
    assert.deepEqual(parseMapsLink('https://maps.apple.com/place?coordinate=38.7139,-9.1334&name=Tasca%20do%20Chico'), { from: 'apple', name: 'Tasca do Chico', coord: [-9.1334, 38.7139] })
  })
  it('reads OpenStreetMap and Waze', () => {
    assert.deepEqual(parseMapsLink('https://www.openstreetmap.org/?mlat=35.6869&mlon=139.6967#map=18/35.6869/139.6967')?.coord, [139.6967, 35.6869])
    assert.deepEqual(parseMapsLink('https://waze.com/ul?ll=38.71,-9.13&navigate=yes')?.coord, [-9.13, 38.71])
  })
  it('ignores links that are not maps', () => {
    assert.equal(findMapsLink('look https://www.google.com/search?q=ramen'), undefined)
    assert.equal(findMapsLink('https://apple.com/maps'), undefined)
    assert.equal(findMapsLink('see https://evil.example/maps/place/x'), undefined)
    assert.equal(findMapsLink('Fuunji https://maps.app.goo.gl/AbC123.'), 'https://maps.app.goo.gl/AbC123')
  })
  it('reads bare coordinates', () => {
    assert.deepEqual(parseCoords('add 35.6869, 139.6967 please'), [139.6967, 35.6869])
    assert.equal(parseCoords('we are 4 people, 3 days'), undefined)
  })
  it('reads a place page that did not redirect', () => {
    const html = '<meta property="og:title" content="Fuunji · Google Maps"><meta property="place:location:latitude" content="35.6869"><meta property="place:location:longitude" content="139.6967">'
    assert.deepEqual(readPlacePage(html), { name: 'Fuunji', coord: [139.6967, 35.6869] })
  })
})

describe('reading a find from chat', () => {
  it('takes names, days and shared links', () => {
    assert.deepEqual(customPlaceRequest('add Fuunji ramen to day 2'), { name: 'Fuunji ramen', day: 2, loose: false })
    assert.deepEqual(customPlaceRequest('please add Bar Benfiquista to the last day'), { name: 'Bar Benfiquista', day: -1, loose: false })
    assert.deepEqual(customPlaceRequest('Fuunji\nhttps://maps.app.goo.gl/AbC123'), { link: 'https://maps.app.goo.gl/AbC123', name: 'Fuunji', day: undefined })
    assert.deepEqual(customPlaceRequest('I want to go to Tasca do Chico'), { name: 'Tasca do Chico', day: undefined, loose: true })
  })
  it('leaves plan edits alone', () => {
    for (const t of ['add a day', 'add more food', 'add something near Ginza', 'swap Skytree for something cheaper', 'make it more relaxed', 'add museums']) {
      assert.equal(customPlaceRequest(t), null, t)
    }
  })
  it('is only a find when it names somewhere we do not know', () => {
    const f = (t: string) => { const r = customPlaceRequest(t); return Boolean(r && isFind(r, tokyo)) }
    assert.equal(f('add Fuunji'), true)
    assert.equal(f('add fuunji ramen'), true, 'not our “Ramen in Shinjuku”')
    assert.equal(f('add skytree'), false, 'our Tokyo Skytree')
    assert.equal(f('add golden gai to day 2'), false)
    assert.equal(f('add Golden Gai'), false, 'known place: a normal edit')
    assert.equal(f('add ramen'), false, 'a kind of food: a deck')
    assert.equal(f('I want to try street food'), false)
    assert.equal(f('I want to go to Tokyo'), false)
    assert.equal(f('I want to try fuunji'), false, 'loose and lower case: probably not a name')
    assert.equal(f('I want to try Fuunji'), true)
    assert.equal(f('add 風雲児'), true)
  })
})

describe('kinds and clips', () => {
  it('keeps only OpenAI clips the search actually returned', () => {
    const output = [
      { type: 'web_search_call', action: { type: 'search', sources: [
        { type: 'url', url: 'https://www.instagram.com/reel/AbCdEf123/' },
        { type: 'url', url: 'https://www.tiktok.com/@ramenfan/video/7322560044573248799' },
      ] } },
      { type: 'message', content: [{ type: 'output_text', text: '', annotations: [{ type: 'url_citation', url: 'https://www.instagram.com/reel/XyZ987654/', title: 'Fuunji queue (@tokyoeats) • Instagram reel' }] }] },
    ]
    const text = JSON.stringify({ clips: [
      { url: 'https://www.instagram.com/reel/AbCdEf123/?igsh=x', creator: '@noodlehunter', caption: 'Fuunji tsukemen' },
      { url: 'https://www.tiktok.com/@ramenfan/video/7322560044573248799', creator: 'ramenfan', caption: 'Fuunji!' },
      { url: 'https://www.instagram.com/reel/MadeUp00001/', creator: 'x', caption: 'Fuunji made up' },
    ] })
    const r = openAIResults(output, text)
    assert.equal(r.get('https://www.instagram.com/reel/AbCdEf123/?igsh=x'), 'noodlehunter on Instagram: "Fuunji tsukemen"')
    assert.equal(r.get('https://www.tiktok.com/@ramenfan/video/7322560044573248799'), 'Fuunji!')
    assert.equal(r.get('https://www.instagram.com/reel/XyZ987654/'), 'Fuunji queue (@tokyoeats) • Instagram reel')
    assert.ok(![...r.keys()].some(u => u.includes('MadeUp')), 'a link the model wrote itself is dropped')
  })
  it('maps OpenStreetMap categories to place kinds', () => {
    assert.equal(shapeOf('amenity', 'restaurant', { cuisine: 'ramen' }).label, 'ramen restaurant')
    assert.equal(shapeOf('amenity', 'bar').kind, 'bar')
    assert.equal(shapeOf('tourism', 'viewpoint').kind, 'viewpoint')
    assert.equal(shapeOf('amenity', 'place_of_worship', { religion: 'shinto' }).label, 'shrine')
    assert.equal(shapeOf('shop', 'books').tags[0], 'shopping')
  })
  it('only keeps clips that name the place', () => {
    assert.equal(mentions('FAST ramen chef! Fuunji in Shinjuku', 'Fuunji Ramen'), true)
    assert.equal(mentions('Best ramen in Tokyo', 'Fuunji Ramen'), false)
    assert.equal(mentions('Café A Brasileira at night', 'A Brasileira'), true)
  })
  it('reads videos and Shorts from a YouTube results page', () => {
    const data = { contents: [
      { videoRenderer: { videoId: 'abc123', title: { runs: [{ text: 'Fuunji tsukemen' }] }, ownerText: { runs: [{ text: 'Eater' }] }, shortViewCountText: { simpleText: '69K' } } },
      { shortsLockupViewModel: { onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: 'def456' } } }, overlayMetadata: { primaryText: { content: 'Fuunji in 30s' }, secondaryText: { content: '16K views' } } } },
    ] }
    const html = `<script>var ytInitialData = ${JSON.stringify(data)};</script>`
    assert.deepEqual(parseYouTube(html), [
      { platform: 'youtube', id: 'abc123', title: 'Fuunji tsukemen', by: 'Eater', views: '69K' },
      { platform: 'youtube', id: 'def456', short: true, title: 'Fuunji in 30s', by: '', views: '16K' },
    ])
  })
})

const fuunji: Place = { id: 'my-fuunji-x', name: 'Fuunji', kind: 'food', coord: [139.6967, 35.6869], tags: ['food'], price: 1, minutes: 45, blurb: 'Tsukemen.', bestAt: 'midday', custom: { from: 'google', address: 'Yoyogi, Shibuya' } }

describe('adding a find to the trip', () => {
  it('joins the trip’s places, and only near the trip’s city', () => {
    const brief = { ...tokyo, customPlaces: [fuunji, { ...fuunji, id: 'my-far', coord: [-9.14, 38.71] as [number, number] }] }
    const ids = tripCity(brief)!.places.map(p => p.id)
    assert.ok(ids.includes('my-fuunji-x'))
    assert.ok(!ids.includes('my-far'))
    assert.equal(cityOfPlace(fuunji)?.id, 'tokyo')
    assert.ok(sameSpot(fuunji, { name: 'Fuunji Ramen', coord: [139.6968, 35.6870] }))
  })
  it('is saved while briefing and leads the deck', () => {
    let s: TripState = { ...initialState, brief: tokyo }
    s = reducer(s, { type: 'add-custom-place', place: fuunji })
    assert.equal(s.brief.customPlaces?.length, 1)
    s = reducer(s, { type: 'start-deck' })
    assert.equal(s.deck[0].id, 'my-fuunji-x')
    assert.equal(s.deck[0].why, 'You added this one')
  })
  it('goes straight into the day asked for once there is a plan, and undoes', () => {
    const city = tripCity(tokyo)!
    const pick = (ids: string[]) => ids.map(id => city.places.find(p => p.id === id)!)
    const days = [buildDay(1, pick(['tk-sensoji', 'tk-ueno']), tokyo), buildDay(2, pick(['tk-meiji', 'tk-harajuku']), tokyo)]
    let s: TripState = { ...initialState, phase: 'review', brief: tokyo, days }
    s = reducer(s, { type: 'add-custom-place', place: fuunji, day: 1 })
    assert.ok(s.days[0].stops.some(st => st.place.id === 'my-fuunji-x'))
    assert.match(s.messages.at(-1)!.text, /^Added your find Fuunji \(Yoyogi, Shibuya\) to Day 1\. Open its pin/)
    s = reducer(s, { type: 'undo' })
    assert.ok(!s.days.flatMap(d => d.stops).some(st => st.place.id === 'my-fuunji-x'))
  })
  it('does not add the same spot twice', () => {
    let s: TripState = { ...initialState, brief: tokyo }
    s = reducer(s, { type: 'add-custom-place', place: fuunji })
    s = reducer(s, { type: 'add-custom-place', place: { ...fuunji, id: 'my-fuunji-ramen-y', name: 'Fuunji Ramen', coord: [139.6968, 35.687] } })
    assert.equal(s.brief.customPlaces?.length, 1)
  })
})
