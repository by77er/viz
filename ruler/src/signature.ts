/**
 * Outbound webhook authentication.
 *
 *   X-Viz-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<Idempotency-Key>.<body>")>
 *
 * `t` is the time of the attempt, so a receiver can refuse old requests; the idempotency
 * key is inside the signed text, so a captured body cannot be replayed under a new key.
 * The secret is per webhook config and never leaves the Notifier object except as this MAC.
 */
const enc = new TextEncoder()

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function mac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)))
}

export async function signatureHeader(secret: string, atMs: number, idempotencyKey: string, body: string): Promise<string> {
  const t = Math.floor(atMs / 1000)
  return `t=${t},v1=${await mac(secret, `${t}.${idempotencyKey}.${body}`)}`
}

/** What a receiver does: recompute, compare without an early exit, and refuse a stale `t`. */
export async function verifySignature(secret: string, header: string | null, idempotencyKey: string, body: string, nowMs: number, toleranceMs = 5 * 60_000): Promise<boolean> {
  const m = header === null ? null : /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header)
  if (!m) return false
  const t = Number(m[1])
  if (Math.abs(nowMs - t * 1000) > toleranceMs) return false
  const want = await mac(secret, `${t}.${idempotencyKey}.${body}`)
  const got = m[2] as string
  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i)
  return diff === 0
}
