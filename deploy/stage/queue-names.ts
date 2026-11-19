/** `viz-<stage>-flush` → `viz-flush`: the name stack/src/index.ts compares a batch's queue with. */
export function productionQueueName(queue: string, prefix: string | undefined): string {
  return prefix && prefix.startsWith('viz-') && queue.startsWith(prefix) ? `viz-${queue.slice(prefix.length)}` : queue
}
