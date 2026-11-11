import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import { Db } from './money/db'
import { addUp, asJob, canSearch, meteredFetch, searchesUsedToday, usageOf, type Usage } from './usage'
import { attachVideoDb, linksOf, placeVideos } from './places'
import { setOpenAIKey } from './openai'

describe('what the models used', () => {
  it('reads tokens and web searches off an OpenAI reply and a Claude one', () => {
    const o = usageOf('openai', { model: 'gpt-x', output: [{ type: 'web_search_call' }, { type: 'web_search_call' }, { type: 'message' }], usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 200 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 } } }, 'videos')
    assert.deepEqual(o, { provider: 'openai', model: 'gpt-x', job: 'videos', input: 1200, cached: 200, output: 300, reasoning: 100, searches: 2 })
    const c = usageOf('claude', { model: 'claude-x', usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20, server_tool_use: { web_search_requests: 3 } } }, 'vibe')
    assert.deepEqual(c, { provider: 'claude', model: 'claude-x', job: 'vibe', input: 150, cached: 50, output: 20, reasoning: 0, searches: 3 })
    assert.equal(usageOf('openai', { data: [] }, 'other'), undefined)
  })

  it('records each call under the job that made it, and counts the day’s searches against the cap', async () => {
    const real = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ model: 'm', output: [{ type: 'web_search_call' }], usage: { input_tokens: 10, output_tokens: 5 } }), { headers: { 'content-type': 'application/json' } })) as typeof fetch
    try {
      const before = searchesUsedToday()
      await asJob('vibe', () => meteredFetch('openai')('https://api.example/v1/responses'))
      await new Promise(r => setTimeout(r, 20))
      assert.equal(searchesUsedToday(), before + 1)
      assert.equal(canSearch(10_000), false)
    } finally { globalThis.fetch = real }
  })

  it('adds it up by job and by model, heaviest first', () => {
    const u = (job: Usage['job'], input: number, searches = 0): Usage => ({ provider: 'openai', model: job === 'plan' ? 'big' : 'small', job, input, cached: 0, output: 0, reasoning: 0, searches })
    const out = addUp([u('videos', 100, 3), u('videos', 100, 2), u('plan', 5000), u('intake', 50)])
    assert.equal(out.byJob[0].job, 'videos', 'web searches weigh the most')
    assert.equal(out.byJob[0].calls, 2)
    assert.equal(out.total.input, 5250)
    assert.deepEqual(out.byModel.map(m => m.model).sort(), ['big', 'small'])
  })
})

describe('reels on request only', () => {
  let db: Db
  const real = globalThis.fetch
  let openaiCalls = 0
  before(async () => {
    db = await Db.local()
    attachVideoDb(db)
    globalThis.fetch = (async (url: string) => {
      const u = String(url)
      if (u.includes('youtube.com')) return new Response('<html></html>', { status: 200 })
      openaiCalls++
      const output = [
        { type: 'web_search_call', id: 'w', status: 'completed', action: { type: 'search', query: 'q', sources: [{ type: 'url', url: 'https://www.instagram.com/reel/ABCdef12345/' }] } },
        { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ clips: [{ url: 'https://www.instagram.com/reel/ABCdef12345/', creator: 'someone', caption: 'Sunset at Test Rooftop' }] }), annotations: [] }] },
      ]
      return new Response(JSON.stringify({ id: 'r', object: 'response', created_at: 0, status: 'completed', model: 'm', output, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    setOpenAIKey('sk-test')
  })
  after(async () => { globalThis.fetch = real; setOpenAIKey(null); attachVideoDb(null); await db.close() })
  afterEach(() => { openaiCalls = 0 })

  it('shows a place without a paid search, searches once when asked, then keeps it', async () => {
    const q = { name: 'Test Rooftop', city: 'Lisbon' }
    const first = await placeVideos(q)
    assert.equal(openaiCalls, 0, 'just showing the place costs nothing')
    assert.ok(!first.social)
    const asked = await placeVideos(q, true)
    assert.equal(openaiCalls, 1)
    assert.equal(asked.social, true)
    assert.equal(asked.videos[0]?.platform, 'instagram')
    await placeVideos(q, true)
    await placeVideos(q)
    assert.equal(openaiCalls, 1, 'kept: never searched again')
  })
})

describe('a place’s own links', () => {
  it('reads accounts and a website from the map’s contact tags', () => {
    assert.deepEqual(linksOf({ 'contact:instagram': '@olivebarmumbai', website: 'olivebarandkitchen.com', 'contact:facebook': 'https://www.facebook.com/olive' }), {
      instagram: 'https://www.instagram.com/olivebarmumbai', facebook: 'https://www.facebook.com/olive', website: 'https://olivebarandkitchen.com',
    })
    assert.equal(linksOf({ cuisine: 'italian' }), undefined)
    assert.equal(linksOf({ instagram: 'https://evil.example/x' }), undefined, 'only real profile pages')
  })
})
