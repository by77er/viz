import { describe, expect, it } from 'vitest'
import { numberFormatsMade, shareNumberFormats } from './numberFormats'

describe('one number format per locale and options (M-B1, D-B3 of the fourth review)', () => {
  it('returns the format already made for the same arguments, formats as before, and keeps instanceof and the static methods', () => {
    const before = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234.5)
    shareNumberFormats()
    const a = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const b = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const c = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.format(1234.5)).toBe(before)
    expect(c.format(1234.56)).toBe('1,234.6')
    expect(a instanceof Intl.NumberFormat).toBe(true)
    expect(Intl.NumberFormat.supportedLocalesOf(['en-US'])).toEqual(['en-US'])
    expect(numberFormatsMade()).toBe(2)
  })
})
