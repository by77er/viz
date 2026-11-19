/**
 * Did-you-mean. Candidates are always supplied by the caller and must come from the
 * caller's own tenant (its metric names, its label names, the static function list):
 * nothing in this module remembers anything between calls.
 */

/** Optimal-string-alignment distance (Damerau–Levenshtein without repeated edits), stopping early past `limit`. */
export function distance(a: string, b: string, limit = Infinity): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  const n = b.length
  let prev2 = new Array<number>(n + 1).fill(0)
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  let cur = new Array<number>(n + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    let rowMin = cur[0]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1)
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > limit) return limit + 1
    ;[prev2, prev, cur] = [prev, cur, prev2]
  }
  return prev[n]!
}

/**
 * Up to `k` candidates close to `word`, closest first. A candidate qualifies when its edit
 * distance is at most max(2, ⌊len/4⌋), or when one contains the other and they share most
 * of their `_`-separated parts (so `http_requests` finds `http_requests_total`).
 */
export function didYouMean(word: string, candidates: Iterable<string>, k = 3): string[] {
  const w = word.toLowerCase()
  const limit = Math.max(2, Math.floor(w.length / 4))
  const parts = new Set(w.split(/[_:.]/).filter(Boolean))
  const scored: { c: string; score: number }[] = []
  for (const c of new Set(candidates)) {
    if (c === word) continue
    const lc = c.toLowerCase()
    const d = distance(w, lc, limit)
    let score = d <= limit ? d : Infinity
    if (score === Infinity && w.length >= 4 && (lc.includes(w) || w.includes(lc))) {
      const cParts = lc.split(/[_:.]/).filter(Boolean)
      const shared = cParts.filter((p) => parts.has(p)).length
      if (shared >= Math.min(parts.size, cParts.length) - 1 && shared > 0) score = limit + 1 + Math.abs(lc.length - w.length) / 100
    }
    if (score !== Infinity) scored.push({ c, score })
  }
  return scored.sort((a, b) => a.score - b.score || a.c.localeCompare(b.c)).slice(0, k).map((x) => x.c)
}
