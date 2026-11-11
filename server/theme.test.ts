import { test } from 'node:test'
import assert from 'node:assert/strict'
import { byClock } from '../src/state/theme'

test('Auto is light by day and dark by night', () => {
  const at = (h: number, m = 0) => byClock(new Date(2026, 10, 11, h, m))
  assert.equal(at(6, 59), 'dark')
  assert.equal(at(7), 'light')
  assert.equal(at(13), 'light')
  assert.equal(at(18, 59), 'light')
  assert.equal(at(19), 'dark')
  assert.equal(at(0), 'dark')
})
