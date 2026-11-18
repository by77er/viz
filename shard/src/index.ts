export { Shard } from './shard'
export * from './pool'

export default {
  fetch: () => new Response('viz shard'),
} satisfies ExportedHandler
