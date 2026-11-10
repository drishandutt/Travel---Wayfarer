import type { City, Hotel, Place, TripBrief } from '../types'
import londonData from './london.json'

// Hand-curated seed data. In production this is replaced by a places provider
// (Google Places / Foursquare / OSM) behind the same `City` shape.

const tokyo: City = {
  id: 'tokyo',
  name: 'Tokyo',
  country: 'Japan',
  center: [139.7454, 35.6812],
  zoom: 11.6,
  aliases: ['tokyo', 'japan', 'shibuya', 'shinjuku'],
  // Tokyo Metro single ride ~¥180-330; taxi flag ~¥500 then ~¥400/km
  transport: { transitName: 'Metro', transitFare: 1.6, taxiBase: 3.3, taxiPerKm: 2.6 },
  essentials: {
    timezone: 'Asia/Tokyo',
    currency: { code: 'JPY', symbol: '¥', perUsd: 150 },
    plugs: 'Type A/B · 100 V (US plugs fit; 3-pin and EU plugs need an adapter)',
    tipping: 'No tipping: great service is the norm, and a tip may be politely refused',
    emergency: 'Police 110 · Ambulance & fire 119',
    transitCard: 'Suica or PASMO: add one to your phone wallet and tap through metro, trains and convenience stores',
    water: 'Tap water is safe to drink',
    etiquette: ['Keep voices low and calls off on trains', 'Many small spots are cash-only — carry yen', 'Shoes off where you see a step up or slippers'],
    phrases: [
      { en: 'Hello', local: 'こんにちは', say: 'kon-nee-chee-wa' },
      { en: 'Thank you', local: 'ありがとう', say: 'a-ree-ga-toh' },
      { en: 'Excuse me / sorry', local: 'すみません', say: 'soo-mee-ma-sen' },
      { en: 'Cheers!', local: '乾杯', say: 'kan-pie' },
    ],
    packing: ['Small coin purse (lots of coins)', 'Pocket tissues & hand towel (few paper towels)'],
  },
  places: [
    { id: 'tk-sensoji', name: 'Sensō-ji Temple', kind: 'sight', coord: [139.7967, 35.7148], tags: ['culture', 'history'], price: 0, minutes: 75, blurb: 'Tokyo’s oldest temple, lantern-lit Nakamise street.', bestAt: 'morning', keywords: ['temple', 'traditional', 'souvenirs', 'old tokyo'] },
    { id: 'tk-skytree', name: 'Tokyo Skytree', kind: 'viewpoint', coord: [139.8107, 35.7101], tags: ['adventure', 'romantic'], price: 2, minutes: 70, blurb: '450 m skydeck over the whole city.', bestAt: 'evening', book: 'Skip-the-queue tickets online, especially at sunset' },
    { id: 'tk-ueno', name: 'Ueno Park & Museums', kind: 'park', coord: [139.7714, 35.7148], tags: ['nature', 'art', 'culture'], price: 1, minutes: 120, blurb: 'Leafy park ringed by the national museums.', bestAt: 'morning' },
    { id: 'tk-ameyoko', name: 'Ameyoko Market', kind: 'market', coord: [139.7745, 35.7103], tags: ['food', 'shopping'], price: 1, minutes: 50, blurb: 'Loud, cheap, glorious street-food alley.', bestAt: 'midday', keywords: ['street food', 'snacks', 'seafood', 'cheap eats', 'local'] },
    { id: 'tk-tsukiji', name: 'Tsukiji Outer Market', kind: 'market', coord: [139.7707, 35.6655], tags: ['food'], price: 1, minutes: 70, blurb: 'Tamagoyaki, uni, and the best breakfast sushi.', bestAt: 'morning', keywords: ['sushi', 'seafood', 'street food', 'breakfast', 'japanese', 'traditional'] },
    { id: 'tk-teamlab', name: 'teamLab Planets', kind: 'museum', coord: [139.7894, 35.6491], tags: ['art', 'adventure', 'romantic'], price: 2, minutes: 100, blurb: 'Walk-through digital art you wade into.', bestAt: 'midday', book: 'Timed tickets sell out — book a slot online' },
    { id: 'tk-hamarikyu', name: 'Hama-rikyū Gardens', kind: 'park', coord: [139.7633, 35.6600], tags: ['nature', 'relaxed', 'history'], price: 1, minutes: 60, blurb: 'Edo-era tea house on a tidal pond.', bestAt: 'midday', keywords: ['tea', 'matcha', 'traditional', 'tea house'] },
    { id: 'tk-ginza', name: 'Ginza', kind: 'sight', coord: [139.7649, 35.6717], tags: ['shopping'], price: 3, minutes: 90, blurb: 'Flagship stores and department-store food halls.', bestAt: 'midday', keywords: ['department store', 'food hall', 'depachika'] },
    { id: 'tk-meiji', name: 'Meiji Jingū', kind: 'sight', coord: [139.6993, 35.6764], tags: ['culture', 'nature', 'relaxed'], price: 0, minutes: 60, blurb: 'Forest shrine minutes from Harajuku chaos.', bestAt: 'morning', keywords: ['shrine', 'traditional'] },
    { id: 'tk-harajuku', name: 'Takeshita & Cat Street', kind: 'sight', coord: [139.7036, 35.6702], tags: ['shopping', 'art'], price: 1, minutes: 70, blurb: 'Street fashion, vintage, crepes.', bestAt: 'midday' },
    { id: 'tk-shibuya', name: 'Shibuya Crossing & Sky', kind: 'viewpoint', coord: [139.7005, 35.6595], tags: ['adventure', 'nightlife'], price: 2, minutes: 60, blurb: 'The scramble, then the rooftop above it.', bestAt: 'evening', book: 'Shibuya Sky sunset slots sell out days ahead' },
    { id: 'tk-nonbei', name: 'Nonbei Yokochō', kind: 'bar', coord: [139.7033, 35.6605], tags: ['nightlife', 'food'], price: 2, minutes: 90, blurb: 'Six-seat bars stacked along a lantern lane.', bestAt: 'night', keywords: ['izakaya', 'drinks', 'japanese', 'traditional', 'tiny bars'] },
    { id: 'tk-golden-gai', name: 'Golden Gai', kind: 'bar', coord: [139.7044, 35.6938], tags: ['nightlife'], price: 2, minutes: 100, blurb: '200 tiny bars across six alleys.', bestAt: 'night', keywords: ['cocktails', 'drinks', 'tiny bars'] },
    { id: 'tk-omoide', name: 'Omoide Yokochō', kind: 'food', coord: [139.6993, 35.6930], tags: ['food', 'nightlife'], price: 1, minutes: 60, blurb: 'Yakitori smoke and salaryman stools.', bestAt: 'evening', keywords: ['yakitori', 'izakaya', 'japanese', 'traditional', 'grilled', 'street food', 'cheap eats'] },
    { id: 'tk-gyoen', name: 'Shinjuku Gyoen', kind: 'park', coord: [139.7101, 35.6852], tags: ['nature', 'relaxed', 'romantic'], price: 1, minutes: 80, blurb: 'Three garden styles, one huge lawn.', bestAt: 'midday' },
    { id: 'tk-nakameguro', name: 'Naka-Meguro Canal', kind: 'cafe', coord: [139.6987, 35.6440], tags: ['relaxed', 'romantic', 'food'], price: 2, minutes: 70, blurb: 'Canal-side cafés under cherry trees.', bestAt: 'midday', keywords: ['coffee', 'brunch', 'modern'] },
    { id: 'tk-yanaka', name: 'Yanaka Ginza', kind: 'sight', coord: [139.7660, 35.7275], tags: ['history', 'relaxed', 'food'], price: 1, minutes: 70, blurb: 'Old-Tokyo shotengai that survived the war.', bestAt: 'midday', keywords: ['street food', 'snacks', 'traditional', 'japanese', 'old tokyo', 'local'] },
    { id: 'tk-akihabara', name: 'Akihabara', kind: 'sight', coord: [139.7731, 35.6984], tags: ['shopping', 'adventure'], price: 1, minutes: 90, blurb: 'Retro games, arcades, electric everything.', bestAt: 'evening' },
    { id: 'tk-ichiran', name: 'Ramen in Shinjuku', kind: 'food', coord: [139.7022, 35.6906], tags: ['food'], price: 1, minutes: 45, blurb: 'Solo-booth tonkotsu, open late.', bestAt: 'night', keywords: ['ramen', 'noodles', 'japanese', 'late night', 'casual', 'cheap eats'] },
    { id: 'tk-sushi-ginza', name: 'Omakase in Ginza', kind: 'food', coord: [139.7630, 35.6700], tags: ['food', 'romantic'], price: 3, minutes: 90, blurb: 'Counter omakase, book weeks ahead.', bestAt: 'evening', book: 'Counter seats: reserve weeks ahead', keywords: ['sushi', 'omakase', 'fine dining', 'japanese', 'traditional', 'seafood'] },
    { id: 'tk-asakusa-tempura', name: 'Tempura in Asakusa', kind: 'food', coord: [139.7948, 35.7118], tags: ['food', 'history'], price: 2, minutes: 60, blurb: 'Century-old tendon counter.', bestAt: 'midday', keywords: ['tempura', 'tendon', 'japanese', 'traditional', 'old tokyo'] },
    { id: 'tk-nezu', name: 'Nezu Shrine', kind: 'sight', coord: [139.7607, 35.7202], tags: ['culture', 'nature', 'history'], price: 0, minutes: 45, blurb: 'Tunnel of red torii, far fewer crowds.', bestAt: 'morning', keywords: ['shrine', 'traditional'] },
    { id: 'tk-kappabashi', name: 'Kappabashi Kitchen Street', kind: 'market', coord: [139.7881, 35.7135], tags: ['shopping', 'food'], price: 1, minutes: 50, blurb: 'Knives, ceramics and plastic food models.', bestAt: 'midday', keywords: ['kitchenware', 'knives', 'souvenirs'] },
    { id: 'tk-odaiba', name: 'Odaiba Seaside', kind: 'viewpoint', coord: [139.7745, 35.6300], tags: ['romantic', 'relaxed'], price: 0, minutes: 70, blurb: 'Rainbow Bridge glowing over the bay.', bestAt: 'evening' },
    { id: 'tk-shimokita', name: 'Shimokitazawa', kind: 'sight', coord: [139.6681, 35.6616], tags: ['shopping', 'art', 'nightlife'], price: 1, minutes: 90, blurb: 'Vintage racks, record shops, live houses.', bestAt: 'midday' },
    { id: 'tk-mori', name: 'Mori Art Museum', kind: 'museum', coord: [139.7292, 35.6604], tags: ['art', 'romantic'], price: 2, minutes: 90, blurb: 'Contemporary art on the 53rd floor.', bestAt: 'evening', book: 'Book timed entry online' },
    { id: 'tk-kagurazaka', name: 'Kagurazaka Lanes', kind: 'food', coord: [139.7408, 35.7019], tags: ['food', 'romantic', 'history'], price: 2, minutes: 80, blurb: 'Stone alleys hiding kappo counters.', bestAt: 'evening', keywords: ['kaiseki', 'izakaya', 'japanese', 'traditional', 'fine dining'] },
    { id: 'tk-jimbocho', name: 'Jimbōchō Kissaten', kind: 'cafe', coord: [139.7577, 35.6960], tags: ['relaxed', 'culture', 'food'], price: 1, minutes: 45, blurb: 'Book town with 1950s coffee houses.', bestAt: 'midday', keywords: ['coffee', 'kissaten', 'retro', 'curry', 'japanese'] },
  ],
  hotels: [
    { id: 'tk-h-shinjuku', name: 'Kōen Hotel Shinjuku', coord: [139.6950, 35.6895], nightly: 210, tier: 'comfort', tags: ['nightlife', 'food'], blurb: 'Above the Shinjuku rail hub.' },
    { id: 'tk-h-ginza', name: 'Ginza Lantern House', coord: [139.7660, 35.6735], nightly: 340, tier: 'luxury', tags: ['shopping', 'food'], blurb: 'Quiet luxe, walk to Tsukiji.' },
    { id: 'tk-h-ueno', name: 'Ueno Pine Stay', coord: [139.7760, 35.7120], nightly: 95, tier: 'shoestring', tags: ['culture', 'history'], blurb: 'Budget pods by the park.' },
    { id: 'tk-h-shibuya', name: 'Shibuya Stream Rooms', coord: [139.7040, 35.6570], nightly: 260, tier: 'comfort', tags: ['nightlife', 'art'], blurb: 'Design hotel over the river.' },
    { id: 'tk-h-tokyo', name: 'Marunouchi Grand', coord: [139.7640, 35.6810], nightly: 520, tier: 'luxury', tags: ['romantic', 'relaxed'], blurb: 'Palace views, Tokyo Station door.' },
    { id: 'tk-h-asakusa', name: 'Asakusa River Inn', coord: [139.7980, 35.7090], nightly: 130, tier: 'comfort', tags: ['culture', 'history'], blurb: 'Skytree from the tatami.' },
  ],
}

const lisbon: City = {
  id: 'lisbon',
  name: 'Lisbon',
  country: 'Portugal',
  center: [-9.1450, 38.7130],
  zoom: 12.6,
  aliases: ['lisbon', 'lisboa', 'portugal'],
  // Metro/tram single ride ~€1.85-3; taxi flag ~€3.25 then ~€0.5-0.9/km
  transport: { transitName: 'Metro / tram', transitFare: 2.0, taxiBase: 3.6, taxiPerKm: 0.9 },
  essentials: {
    timezone: 'Europe/Lisbon',
    currency: { code: 'EUR', symbol: '€', perUsd: 0.92 },
    plugs: 'Type F · 230 V (EU two-pin)',
    tipping: 'Optional: round up, or 5–10% for great table service',
    emergency: 'All emergencies 112',
    transitCard: 'Navegante (Viva Viagem) card: load it for metro, trams, buses and the river ferries',
    water: 'Tap water is safe to drink',
    etiquette: ['Dinner starts late — 8 pm is normal', 'Bread & olives on the table aren’t free (send back if unwanted)', 'Hills and polished cobbles: grippy shoes beat style'],
    phrases: [
      { en: 'Hello', local: 'Olá', say: 'oh-LAH' },
      { en: 'Thank you', local: 'Obrigado / Obrigada', say: 'oh-bree-GAH-doo' },
      { en: 'Excuse me', local: 'Com licença', say: 'kong lee-SEN-sah' },
      { en: 'Cheers!', local: 'Saúde!', say: 'sah-OO-deh' },
    ],
    packing: ['Grippy, broken-in shoes (steep cobbled hills)', 'Light layer for windy miradouros at sunset'],
  },
  places: [
    { id: 'ls-belem-tower', name: 'Torre de Belém', kind: 'sight', coord: [-9.2160, 38.6916], tags: ['history', 'culture'], price: 1, minutes: 50, blurb: 'Manueline watchtower on the Tagus.', bestAt: 'morning', book: 'Timed entry: book a slot' },
    { id: 'ls-jeronimos', name: 'Jerónimos Monastery', kind: 'sight', coord: [-9.2065, 38.6979], tags: ['history', 'culture', 'art'], price: 1, minutes: 75, blurb: 'Lace-carved cloisters, jaw-dropping.', bestAt: 'morning', book: 'Buy tickets online to skip a long queue' },
    { id: 'ls-pasteis', name: 'Pastéis de Belém', kind: 'cafe', coord: [-9.2033, 38.6975], tags: ['food'], price: 1, minutes: 30, blurb: 'The original custard tart, since 1837.', bestAt: 'morning', keywords: ['pastry', 'custard tart', 'pastel de nata', 'dessert', 'portuguese', 'traditional', 'breakfast'] },
    { id: 'ls-maat', name: 'MAAT', kind: 'museum', coord: [-9.1945, 38.6957], tags: ['art'], price: 1, minutes: 70, blurb: 'Wave-roofed art & tech museum.', bestAt: 'midday' },
    { id: 'ls-lxfactory', name: 'LX Factory', kind: 'market', coord: [-9.1785, 38.7034], tags: ['shopping', 'art', 'food'], price: 1, minutes: 90, blurb: 'Old mill turned bookshops & brunch.', bestAt: 'midday', keywords: ['brunch', 'coffee', 'modern', 'books'] },
    { id: 'ls-alfama', name: 'Alfama Lanes', kind: 'sight', coord: [-9.1300, 38.7115], tags: ['history', 'romantic', 'culture'], price: 0, minutes: 90, blurb: 'Tangled medieval quarter, laundry & fado.', bestAt: 'evening', keywords: ['traditional', 'old town', 'fado'] },
    { id: 'ls-castelo', name: 'Castelo de São Jorge', kind: 'viewpoint', coord: [-9.1334, 38.7139], tags: ['history', 'adventure'], price: 1, minutes: 75, blurb: 'Moorish castle with peacocks and views.', bestAt: 'midday', book: 'Tickets online save the queue at the gate' },
    { id: 'ls-graca', name: 'Miradouro da Graça', kind: 'viewpoint', coord: [-9.1314, 38.7166], tags: ['romantic', 'relaxed'], price: 0, minutes: 40, blurb: 'Sunset kiosk over terracotta roofs.', bestAt: 'evening' },
    { id: 'ls-fado', name: 'Fado in Alfama', kind: 'bar', coord: [-9.1290, 38.7108], tags: ['culture', 'romantic', 'nightlife'], price: 2, minutes: 120, blurb: 'Candle-lit tasca, saudade on tap.', bestAt: 'night', book: 'Reserve a table for the evening sets', keywords: ['fado', 'portuguese', 'traditional', 'dinner', 'music'] },
    { id: 'ls-timeout', name: 'Time Out Market', kind: 'food', coord: [-9.1458, 38.7069], tags: ['food'], price: 2, minutes: 60, blurb: 'The city’s best chefs under one roof.', bestAt: 'midday', keywords: ['food hall', 'portuguese', 'modern', 'seafood'] },
    { id: 'ls-pinkstreet', name: 'Pink Street', kind: 'bar', coord: [-9.1441, 38.7077], tags: ['nightlife'], price: 1, minutes: 90, blurb: 'Rua Nova do Carvalho after dark.', bestAt: 'night', keywords: ['cocktails', 'drinks', 'clubs'] },
    { id: 'ls-bairro', name: 'Bairro Alto', kind: 'bar', coord: [-9.1450, 38.7130], tags: ['nightlife', 'food'], price: 1, minutes: 120, blurb: 'Street-party bars spill into lanes.', bestAt: 'night', keywords: ['cocktails', 'drinks', 'bars'] },
    { id: 'ls-chiado', name: 'Chiado', kind: 'sight', coord: [-9.1420, 38.7107], tags: ['shopping', 'culture'], price: 2, minutes: 70, blurb: 'Bookshops, cafés, theatre square.', bestAt: 'midday' },
    { id: 'ls-comercio', name: 'Praça do Comércio', kind: 'sight', coord: [-9.1365, 38.7076], tags: ['history'], price: 0, minutes: 40, blurb: 'Grand riverfront square & arch.', bestAt: 'midday' },
    { id: 'ls-gulbenkian', name: 'Gulbenkian Museum', kind: 'museum', coord: [-9.1545, 38.7375], tags: ['art', 'nature', 'relaxed'], price: 1, minutes: 100, blurb: 'World-class collection in a modernist garden.', bestAt: 'midday' },
    { id: 'ls-estrela', name: 'Jardim da Estrela', kind: 'park', coord: [-9.1600, 38.7140], tags: ['nature', 'relaxed'], price: 0, minutes: 45, blurb: 'Bandstand, ducks, kiosk coffee.', bestAt: 'morning' },
    { id: 'ls-cervejaria', name: 'Cervejaria Ramiro', kind: 'food', coord: [-9.1355, 38.7205], tags: ['food'], price: 2, minutes: 75, blurb: 'Garlic prawns and a prego for dessert.', bestAt: 'evening', keywords: ['seafood', 'prawns', 'portuguese', 'traditional', 'beer', 'local'] },
    { id: 'ls-tram28', name: 'Tram 28 ride', kind: 'sight', coord: [-9.1395, 38.7139], tags: ['adventure', 'history'], price: 1, minutes: 45, blurb: 'Rattle through the hills in a 1930s tram.', bestAt: 'morning' },
    { id: 'ls-principe', name: 'Príncipe Real', kind: 'market', coord: [-9.1490, 38.7170], tags: ['shopping', 'relaxed', 'food'], price: 2, minutes: 70, blurb: 'Concept stores around a cedar-shaded square.', bestAt: 'midday', keywords: ['coffee', 'brunch', 'concept stores'] },
    { id: 'ls-ladra', name: 'Feira da Ladra', kind: 'market', coord: [-9.1250, 38.7155], tags: ['shopping', 'history'], price: 0, minutes: 60, blurb: 'Tuesday & Saturday flea market.', bestAt: 'morning' },
    { id: 'ls-azulejo', name: 'Museu do Azulejo', kind: 'museum', coord: [-9.1136, 38.7253], tags: ['art', 'history'], price: 1, minutes: 80, blurb: 'Five centuries of painted tiles in a convent.', bestAt: 'midday' },
    { id: 'ls-catarina', name: 'Miradouro de Santa Catarina', kind: 'viewpoint', coord: [-9.1475, 38.7096], tags: ['romantic', 'relaxed', 'nightlife'], price: 0, minutes: 45, blurb: 'Sunset beers above the 25 de Abril bridge.', bestAt: 'evening', keywords: ['sunset', 'beer', 'views'] },
    { id: 'ls-ginjinha', name: 'A Ginjinha', kind: 'bar', coord: [-9.1384, 38.7146], tags: ['nightlife', 'history'], price: 0, minutes: 20, blurb: 'Cherry liqueur shots from a hole-in-the-wall.', bestAt: 'evening', keywords: ['ginjinha', 'liqueur', 'traditional', 'portuguese', 'drinks'] },
    { id: 'ls-ourique', name: 'Mercado de Campo de Ourique', kind: 'food', coord: [-9.1655, 38.7170], tags: ['food', 'relaxed'], price: 1, minutes: 60, blurb: 'Neighbourhood market with tasting stalls.', bestAt: 'midday', keywords: ['food hall', 'portuguese', 'local', 'wine'] },
    { id: 'ls-eduardo', name: 'Parque Eduardo VII', kind: 'park', coord: [-9.1530, 38.7290], tags: ['nature', 'relaxed'], price: 0, minutes: 50, blurb: 'Hilltop park with a glasshouse jungle.', bestAt: 'morning' },
  ],
  hotels: [
    { id: 'ls-h-chiado', name: 'Chiado Azulejo Suites', coord: [-9.1415, 38.7100], nightly: 240, tier: 'comfort', tags: ['culture', 'shopping'], blurb: 'Tiled townhouse at the centre of it all.' },
    { id: 'ls-h-alfama', name: 'Alfama Rooftop Inn', coord: [-9.1305, 38.7125], nightly: 150, tier: 'comfort', tags: ['romantic', 'history'], blurb: 'Fado drifts up to the terrace.' },
    { id: 'ls-h-belem', name: 'Belém Riverside', coord: [-9.2010, 38.6965], nightly: 180, tier: 'comfort', tags: ['relaxed', 'history'], blurb: 'Quiet, by the monuments.' },
    { id: 'ls-h-hostel', name: 'Cais Social Hostel', coord: [-9.1460, 38.7065], nightly: 60, tier: 'shoestring', tags: ['nightlife', 'food'], blurb: 'Bunk-beds over Pink Street.' },
    { id: 'ls-h-avenida', name: 'Avenida Palace', coord: [-9.1430, 38.7150], nightly: 410, tier: 'luxury', tags: ['romantic', 'relaxed'], blurb: 'Belle-époque grand dame.' },
  ],
}

// Built from public guides rather than by hand (scripts/build-london.mts): every sight, museum,
// park, market, restaurant and bar Wikivoyage's London districts list, ranked by fame on Wikidata.
const london: City = {
  id: 'london',
  name: 'London',
  country: 'United Kingdom',
  center: [-0.1276, 51.5072],
  zoom: 11.4,
  aliases: ['london', 'england'],
  // Tube single ride ~£2.80 on contactless; black cab ~£3.80 then ~£2.50/km
  transport: { transitName: 'Tube', transitFare: 3.6, taxiBase: 4.8, taxiPerKm: 3.2 },
  essentials: {
    timezone: 'Europe/London',
    currency: { code: 'GBP', symbol: '£', perUsd: 0.79 },
    plugs: 'Type G · 230 V (UK three-pin; US and EU plugs need an adapter)',
    tipping: '10–12.5% is usually added to the bill at restaurants; nothing at the bar in pubs',
    emergency: 'All emergencies 999 (or 112)',
    transitCard: 'Tap a contactless card or phone on Tube, buses and trains: fares cap daily, no Oyster needed',
    water: 'Tap water is safe to drink, and free to ask for in restaurants',
    etiquette: ['Stand on the right on escalators', 'Queue, and don’t jump it', 'In pubs, order and pay at the bar'],
    phrases: [],
    packing: ['Compact umbrella or a light rain jacket', 'Comfortable shoes: London is walked more than you expect'],
  },
  places: londonData.places as Place[],
  hotels: londonData.hotels as Hotel[],
  credit: 'Places from Wikivoyage (CC BY-SA 4.0) and Wikidata',
}

// How well known each hand-picked place is (London's comes from Wikidata): what a first-timer
// must see near 1, what only locals go to near 0. Read against the trip's familiarity slider.
const FAME: Record<string, number> = {
  'tk-sensoji': 0.95, 'tk-skytree': 0.9, 'tk-shibuya': 0.95, 'tk-meiji': 0.85, 'tk-tsukiji': 0.85, 'tk-teamlab': 0.85,
  'tk-harajuku': 0.8, 'tk-akihabara': 0.8, 'tk-ginza': 0.75, 'tk-ueno': 0.7, 'tk-golden-gai': 0.7, 'tk-ichiran': 0.7,
  'tk-omoide': 0.6, 'tk-gyoen': 0.6, 'tk-odaiba': 0.6, 'tk-ameyoko': 0.55, 'tk-sushi-ginza': 0.55, 'tk-mori': 0.5,
  'tk-asakusa-tempura': 0.45, 'tk-hamarikyu': 0.4, 'tk-nakameguro': 0.4, 'tk-shimokita': 0.35, 'tk-nonbei': 0.35,
  'tk-kappabashi': 0.25, 'tk-yanaka': 0.2, 'tk-nezu': 0.2, 'tk-kagurazaka': 0.15, 'tk-jimbocho': 0.1,
  'ls-belem-tower': 0.95, 'ls-jeronimos': 0.9, 'ls-pasteis': 0.9, 'ls-tram28': 0.85, 'ls-castelo': 0.85, 'ls-comercio': 0.8,
  'ls-alfama': 0.8, 'ls-timeout': 0.75, 'ls-bairro': 0.7, 'ls-lxfactory': 0.65, 'ls-pinkstreet': 0.65, 'ls-chiado': 0.65,
  'ls-fado': 0.6, 'ls-maat': 0.55, 'ls-graca': 0.5, 'ls-gulbenkian': 0.45, 'ls-azulejo': 0.4, 'ls-ginjinha': 0.4,
  'ls-catarina': 0.35, 'ls-cervejaria': 0.35, 'ls-principe': 0.3, 'ls-eduardo': 0.3, 'ls-ladra': 0.25, 'ls-estrela': 0.2,
  'ls-ourique': 0.15,
}
for (const c of [tokyo, lisbon]) for (const p of c.places) if (FAME[p.id] !== undefined) p.rank = FAME[p.id]

// The cities the app knows, by hand (above) or built from public guides (server/cities): the
// server registers every city it has built, and the browser registers the one a trip is in as
// it loads (src/data/cityClient.ts). The same array, always: imports see what's added.
export const CITIES: City[] = [tokyo, lisbon, london]

// Bumped whenever a city is registered or its places change, so cached views can tell.
export let cityVersion = 0

// Adds a city, or replaces the one with its id. Returns the registered copy.
export function registerCity(city: City): City {
  const at = CITIES.findIndex(c => c.id === city.id)
  if (at >= 0) CITIES[at] = city
  else CITIES.push(city)
  cityVersion++
  return city
}

// Puts places into a city's catalog (travellers' finds promoted for everyone, or profiles the
// server has learned), replacing any with the same id. Returns how many were new.
export function addCatalogPlaces(cityId: string, places: Place[]): number {
  const at = CITIES.findIndex(c => c.id === cityId)
  if (at < 0 || !places.length) return 0
  const city = CITIES[at]
  const next = [...city.places]
  let added = 0
  for (const p of places) {
    const i = next.findIndex(x => x.id === p.id)
    if (i >= 0) next[i] = p
    else { next.push(p); added++ }
  }
  CITIES[at] = { ...city, places: next }
  cityVersion++
  return added
}

// Takes places out of a city's catalog again (a find the owner hid). Returns how many went.
export function removeCatalogPlaces(cityId: string, ids: string[]): number {
  const at = CITIES.findIndex(c => c.id === cityId)
  if (at < 0) return 0
  const gone = new Set(ids)
  const city = CITIES[at]
  const places = city.places.filter(p => !gone.has(p.id))
  if (places.length === city.places.length) return 0
  CITIES[at] = { ...city, places }
  cityVersion++
  return city.places.length - places.length
}

export function findCity(text: string): City | undefined {
  const t = text.toLowerCase()
  // the longest alias that fits, so "new york" beats "york"
  let best: { city: City; len: number } | undefined
  for (const c of CITIES) for (const a of c.aliases) if (t.includes(a) && (!best || a.length > best.len)) best = { city: c, len: a.length }
  return best?.city
}

export function cityById(id?: string): City | undefined {
  return CITIES.find(c => c.id === id)
}

// The city as one trip sees it: everything we know there, plus the places its travellers
// added themselves. Same object for the same brief and the same catalog, so it's cheap to call anywhere.
const withCustom = new WeakMap<object, { base: City; out: City }>()
export function tripCity(brief: TripBrief): City | undefined {
  const city = cityById(brief.destination)
  const own = brief.customPlaces
  if (!city || !own?.length) return city
  let held = withCustom.get(own)
  if (held?.base !== city) {
    // a trip that moved city leaves the last city's finds behind; a find the city now lists
    // itself (promoted for everyone) is the catalog's copy
    const here = own.filter(p => !city.places.some(x => x.id === p.id) && roughKm(p.coord, city.center) <= NEARBY_KM)
    held = { base: city, out: { ...city, places: [...city.places, ...here] } }
    withCustom.set(own, held)
  }
  return held.out
}

// How far out a traveller's own place can be and still belong to the city (day trips included).
export const NEARBY_KM = 120
const roughKm = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * 111 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 111)

// The city a place belongs to: the one that lists it, or for a traveller's own find, the one it's in.
export function cityOfPlace(p: Pick<Place, 'id' | 'coord'>): City | undefined {
  return CITIES.find(c => c.places.some(x => x.id === p.id))
    ?? CITIES.map(c => ({ c, km: roughKm(p.coord, c.center) })).filter(x => x.km <= NEARBY_KM).sort((a, b) => a.km - b.km)[0]?.c
}
