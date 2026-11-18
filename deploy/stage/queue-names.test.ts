import { describe, expect, it } from 'vitest'
import { productionQueueName } from './queue-names'

describe('stage queue names', () => {
  it('maps a stage queue to the production name stack/ routes on, and leaves others alone', () => {
    expect(productionQueueName('viz-trial-flush', 'viz-trial-')).toBe('viz-flush')
    expect(productionQueueName('viz-trial-maint', 'viz-trial-')).toBe('viz-maint')
    expect(productionQueueName('viz-trial-flush-dlq', 'viz-trial-')).toBe('viz-flush-dlq')
    expect(productionQueueName('viz-flush', 'viz-trial-')).toBe('viz-flush')
    expect(productionQueueName('viz-trial-flush', undefined)).toBe('viz-trial-flush')
    expect(productionQueueName('other-trial-flush', 'other-trial-')).toBe('other-trial-flush')
  })
})
