import { describe, expect, it } from 'vitest'
import { restores } from './scrollKeeper'

describe('which loads are put back where the page was scrolled to (design review B3)', () => {
  const kept = { path: '/explore', search: '?q=up', y: 640 }
  it('a reload of the same page, whatever its query string has become since', () => {
    expect(restores(kept, 'reload', '/explore', '?q=up')).toBe(true)
    expect(restores(kept, 'reload', '/explore', '?q=up&view=table')).toBe(true)
  })
  it('a return through the history to the same address only', () => {
    expect(restores(kept, 'back_forward', '/explore', '?q=up')).toBe(true)
    expect(restores(kept, 'back_forward', '/explore', '?q=other')).toBe(false)
  })
  it('never a link opened afresh, another page, the top of the page, or nothing kept', () => {
    expect(restores(kept, 'navigate', '/explore', '?q=up')).toBe(false)
    expect(restores(kept, 'reload', '/help', '')).toBe(false)
    expect(restores({ ...kept, y: 0 }, 'reload', '/explore', '?q=up')).toBe(false)
    expect(restores(null, 'reload', '/explore', '?q=up')).toBe(false)
  })
})
