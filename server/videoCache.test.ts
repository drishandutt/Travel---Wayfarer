import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { Db } from './money/db'
import { attachVideoDb, cachedVideos, placeVideos } from './places'

// Clips found for a place are kept in the database, so a restart doesn't make anyone wait again.
let db: Db
before(async () => {
  db = await Db.local()
  attachVideoDb(db)
})
after(async () => {
  attachVideoDb(null)
  await db.close()
})

const clips = { videos: [{ platform: 'youtube' as const, id: 'abc123def45', title: 'Borough Market food tour', by: 'someone' }] }

describe('kept reels and videos', () => {
  it('serves what the database holds without searching again', async () => {
    await db.run('INSERT INTO place_videos (key, name, city, videos, found_at) VALUES (?, ?, ?, ?, ?)', 'borough market|london', 'Borough Market', 'London', JSON.stringify(clips), Date.now())
    const started = Date.now()
    assert.deepEqual(await placeVideos({ name: 'Borough Market', city: 'London' }), clips)
    assert.ok(Date.now() - started < 500, 'answered from the cache, not a search')
    assert.deepEqual(await cachedVideos({ name: ' borough market ', city: 'LONDON' }), clips)
  })

  it('counts nothing as held once it’s too old', async () => {
    await db.run('INSERT INTO place_videos (key, name, city, videos, found_at) VALUES (?, ?, ?, ?, ?)', 'nowhere|london', 'Nowhere', 'London', JSON.stringify({ videos: [] }), Date.now() - 7 * 3_600_000)
    assert.equal(await cachedVideos({ name: 'Nowhere', city: 'London' }), undefined)
  })
})
