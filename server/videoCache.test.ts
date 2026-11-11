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

  it('keeps clips for good, and remembers finding nothing for a week', async () => {
    await db.run('INSERT INTO place_videos (key, name, city, videos, found_at) VALUES (?, ?, ?, ?, ?)', 'old favourite|london', 'Old Favourite', 'London', JSON.stringify(clips), Date.now() - 400 * 86_400_000)
    assert.deepEqual(await cachedVideos({ name: 'Old Favourite', city: 'London' }), clips, 'clips never expire')
    await db.run('INSERT INTO place_videos (key, name, city, videos, found_at) VALUES (?, ?, ?, ?, ?)', 'quiet spot|london', 'Quiet Spot', 'London', JSON.stringify({ videos: [] }), Date.now() - 2 * 86_400_000)
    assert.deepEqual(await cachedVideos({ name: 'Quiet Spot', city: 'London' }), { videos: [] }, 'nothing found, two days ago: still held')
    await db.run('INSERT INTO place_videos (key, name, city, videos, found_at) VALUES (?, ?, ?, ?, ?)', 'nowhere|london', 'Nowhere', 'London', JSON.stringify({ videos: [] }), Date.now() - 8 * 86_400_000)
    assert.equal(await cachedVideos({ name: 'Nowhere', city: 'London' }), undefined, 'a week on, it may be tried again')
  })
})
