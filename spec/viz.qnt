// -*- mode: Bluespec; -*-
//
// viz write/read protocol: client -> shard stream -> flush -> ledger (+ R2 change log)
// -> query seam, with compaction, retention, physical deletion, orphan sweeping, shard
// storage loss and ledger storage loss + rebuild.
//
// Sources: design/DESIGN.md §2, §4, §5.2, §5.3, §6.2; contracts/ledger.ts; shard/src/shard.ts.
// Every protocol guard is a field of the constant `G`, so that one guard at a time can be
// switched off (experiments.mjs generates one instance module per experiment).
//
// One tenant is modelled: everything in the protocol is per (shard, tenant, incarnation)
// stream and per tenant ledger, so a second tenant is an independent copy of this model.
module viz {
  // ---------------------------------------------------------------- types

  /// One physical copy of a batch in a stream: (shard, incarnation, sequence) and the
  /// client batch it carries. A batch is the unit of rows; `b` is its fingerprint.
  type Row = { s: int, inc: int, q: int, b: int }

  /// An R2 object / a ledger file entry. `rows` + `comp` (+ `v` under content addressing)
  /// are the key. `v` is the encoding variant: in `obj` it is the bytes that were stored,
  /// in the ledger it is the bytes the metadata (index fragment, size) describes.
  type File = { rows: Set[Row], comp: bool, v: int }

  type Wm = { inc: int, seq: int }

  /// shard/src/shard.ts `Stream` + its tables. seq numbers are 1-based positions in `wal`.
  ///   payload present  <=> seq > disc          (alarm step 2 NULLs payloads <= disc)
  ///   fingerprint held <=> seq > fpg           (alarm step 3 deletes rows; fpg <= disc)
  ///   segment rows     <=> `bounds` (seq_hi of every segment not yet discarded)
  type Shard = {
    reg: bool, inc: int, wal: List[int],
    sealed: int, rec: int, disc: int, fpg: int, bounds: Set[int],
  }

  type WmChange = { s: int, inc: int, seq: int }

  /// One ledger change (contracts/ledger.ts LedgerChange) sitting in the outbox.
  type Entry = { add: Set[File], rem: Set[File], wm: Set[WmChange], exp: Set[Row], logged: bool }

  type Ledger = { files: Set[File], wm: int -> Wm }

  type Job = { s: int, inc: int, lo: int, hi: int, f: File, written: bool }
  type CJob = { ins: Set[File], out: File, written: bool }

  type Query = {
    st: str,              // "idle" | "tails" | "done"
    files: Set[File],     // plan: live files at one ledger version
    wm: int -> Wm,        // plan: watermarks at the same version
    need: Set[int],       // shards whose tail has not been read yet
    tail: Set[Row],       // tail rows collected so far
    must: Set[int],       // ghost: batches acknowledged before the plan was read
    dup: Set[int],        // result: batches returned more than once
    miss: Set[int],       // result: batches in `must`, not exempt, not returned
  }

  type Guards = {
    // --- protocol guards (true / named value = as designed)
    fence: bool,          // tailRead refuses aboveSeq < discardedThrough
    contiguous: bool,     // addUnit requires seqLo == watermark + 1
    recAt: str,           // "logged": shard told `recorded` up to loggedWatermarks; "committed"
    logPrefix: bool,      // the outbox is written to R2 in version order (logged = a prefix)
    dedup: bool,          // append de-duplicates by fingerprint
    fpHorizon: bool,      // clients never retry a batch whose fingerprint has expired (TTL > horizon)
    replaceLive: bool,    // replace() succeeds only if every input is live
    delGrace: bool,       // retired file deleted only when no in-flight plan references it
    delLogged: bool,      // retired file deleted only after its removal is logged (published)
    missingErr: bool,     // a planned file that cannot be read is an error -> re-plan
    keying: str,          // "content" | "inm" (deterministic key, If-None-Match) | "overwrite"
    sweep: str,           // orphan sweeper rule: "off" | "spec" | "spec_comp" | "fixed" | "any"
    regFirst: bool,       // a stream registers with the ledger before it accepts writes
    regLogged: bool,      // ... and accepts writes only once that registration is logged
    unknownStream: str,   // tailRead on a stream the shard does not hold: "refuse" | "empty" (shard.ts today)
    replanWhole: bool,    // a refused tail read re-plans files AND watermarks (not watermark only)
    retain: bool,         // timing assumption: query attempt shorter than retainRecordedMs
    noRetryAcrossLoss: bool, // assumption: no client retry of a batch whose fingerprint died in a storage loss
    // --- bounds
    nb: int, ns: int, maxSend: int, variants: int, maxJobs: int, maxFlush: int,
    maxComp: int, maxExp: int, maxLL: int, maxSL: int, maxQ: int, maxRestarts: int,
    // --- record the action name in the state (readable traces; multiplies states)
    trace: bool,
  }

  type Lbl = { n: str, a: int, b: int }

  type State = {
    sh: int -> Shard,
    sent: int -> int,         // client: how many times each batch has been sent
    jobs: Set[Job],           // flush Workers in flight
    obj: Set[File],           // R2 data objects
    led: Ledger,              // ledger SQLite state (committed)
    base: Ledger,             // ledger state as of the logged prefix of the R2 change log
    out: List[Entry],         // outbox: committed changes not yet part of the logged prefix
    ret: Set[File],           // files whose removal is logged; awaiting physical deletion
    cjobs: Set[CJob],         // compaction in flight
    q: Query,
    nFlush: int, nComp: int, nExp: int, nLL: int, nSL: int, nQ: int, restarts: int,
    // ghosts
    acked: Set[int],          // batches acknowledged to the client
    lost: Set[int],           // batches destroyed by a shard storage loss before being logged in the ledger
    expired: Set[Row],        // rows removed by retention (committed)
    expiredLogged: Set[Row],  // rows removed by retention (logged)
    fpx: Set[int],            // batches whose fingerprint expired by TTL
    wiped: Set[int],          // batches whose fingerprint was destroyed by a storage loss
  }

  const G: Guards

  var st: State
  var act: Lbl

  pure val SHARDS = 0.to(G.ns - 1)
  pure val BATCHES = 0.to(G.nb - 1)

  // ---------------------------------------------------------------- helpers

  pure def lbl(n: str, a: int, b: int): Lbl = if (G.trace) { n: n, a: a, b: b } else { n: "", a: 0, b: 0 }

  pure val freshShard: Shard = { reg: false, inc: 0, wal: [], sealed: 0, rec: 0, disc: 0, fpg: 0, bounds: Set() }
  pure val idleQuery: Query = { st: "idle", files: Set(), wm: Map(), need: Set(), tail: Set(), must: Set(), dup: Set(), miss: Set() }
  pure val noEntry: Entry = { add: Set(), rem: Set(), wm: Set(), exp: Set(), logged: false }

  pure def max2(a: int, b: int): int = if (a > b) a else b

  /// Routing: sender-stable key -> shard (fixed map; the epoch change is not modelled).
  pure def route(b: int): int = b % G.ns

  /// seq_lo of the segment whose seq_hi is `hi`.
  pure def segLo(s: Shard, hi: int): int =
    s.bounds.filter(x => x < hi).fold(s.disc, (a, x) => max2(a, x)) + 1

  pure def segRows(sid: int, s: Shard, lo: int, hi: int): Set[Row] =
    lo.to(hi).map(q => { s: sid, inc: s.inc, q: q, b: s.wal[q - 1] })

  pure def sameKey(a: File, b: File): bool =
    and { a.rows == b.rows, a.comp == b.comp, G.keying == "content" implies a.v == b.v }

  /// R2 PUT.
  pure def r2put(obj: Set[File], f: File): Set[File] =
    if (G.keying == "overwrite") obj.filter(o => not(sameKey(o, f))).union(Set(f))
    else if (obj.exists(o => sameKey(o, f))) obj       // If-None-Match: * -> 412
    else obj.union(Set(f))

  pure def wmSeq(m: int -> Wm, s: int, inc: int): int =
    if (m.keys().contains(s) and m.get(s).inc == inc) m.get(s).seq else 0

  pure def applyEntry(l: Ledger, e: Entry): Ledger = {
    files: l.files.exclude(e.rem).union(e.add),
    wm: e.wm.fold(l.wm, (m, c) => m.put(c.s, { inc: c.inc, seq: c.seq })),
  }

  /// LedgerRpc.loggedWatermarks(): what the ledger believes is committed AND logged.
  /// With `logPrefix` every logged entry is already folded into `base`, so this is base.wm.
  /// Without it, an entry may be on R2 while an earlier version is not.
  pure def loggedWm(s: State): int -> Wm =
    s.out.foldl(s.base.wm, (m, e) => if (e.logged) applyEntry({ files: Set(), wm: m }, e).wm else m)

  pure def commit(s: State, l: Ledger, e: Entry): State = { ...s, led: l, out: s.out.append(e) }

  pure def count(fs: Set[File], tl: Set[Row], b: int): int =
    fs.fold(0, (n, f) => n + f.rows.filter(r => r.b == b).size()) + tl.filter(r => r.b == b).size()

  pure def plan(s: State): Query =
    { st: "tails", files: s.led.files, wm: s.led.wm, need: s.led.wm.keys(), tail: Set(), must: s.acked, dup: Set(), miss: Set() }

  pure def restart(s: State): State = { ...s, q: plan(s), restarts: s.restarts + 1 }

  // ---------------------------------------------------------------- client + shard

  action init = all {
    st' = {
      sh: SHARDS.mapBy(_ => freshShard), sent: BATCHES.mapBy(_ => 0), jobs: Set(), obj: Set(),
      led: { files: Set(), wm: Map() }, base: { files: Set(), wm: Map() }, out: [], ret: Set(),
      cjobs: Set(), q: idleQuery,
      nFlush: 0, nComp: 0, nExp: 0, nLL: 0, nSL: 0, nQ: 0, restarts: 0,
      acked: Set(), lost: Set(), expired: Set(), expiredLogged: Set(), fpx: Set(), wiped: Set(),
    },
    act' = lbl("init", 0, 0),
  }

  /// Shard.stream() creating a stream + (design) registerStream with the ledger.
  /// Used on first use and after a storage loss.
  action register(sid: int): bool = {
    val s = st.sh.get(sid)
    val inc = s.inc + 1
    all {
      G.regFirst, not(s.reg),
      st' = commit({ ...st, sh: st.sh.put(sid, { ...s, reg: true, inc: inc }) },
                   { ...st.led, wm: st.led.wm.put(sid, { inc: inc, seq: 0 }) },
                   { ...noEntry, wm: Set({ s: sid, inc: inc, seq: 0 }) }),
      act' = lbl("register", sid, inc),
    }
  }

  /// Shard.append(). Sending and (re)sending by the client, the durable append and the
  /// acknowledgement are one step; a lost acknowledgement is covered because the client
  /// may resend any batch it has sent before.
  action clientAppend(b: int): bool = {
    val sid = route(b)
    val s0 = st.sh.get(sid)
    // implementation behaviour when the design's handshake is off: create the stream locally
    val s = if (s0.reg) s0 else { ...s0, reg: true, inc: s0.inc + 1 }
    val held = s.wal.indices().exists(i => i + 1 > s.fpg and s.wal[i] == b)
    val n = st.sent.get(b)
    all {
      n < G.maxSend,
      n > 0 or st.sent.get(max2(b - 1, 0)) > 0 or b == 0,           // symmetry: first sends in order
      s0.reg or not(G.regFirst),
      G.regLogged implies (st.base.wm.keys().contains(sid) and st.base.wm.get(sid).inc == s0.inc),
      (n > 0 and G.fpHorizon) implies not(st.fpx.contains(b)),
      (n > 0 and G.noRetryAcrossLoss) implies not(st.wiped.contains(b)),
      st' = {
        ...st,
        sh: st.sh.put(sid, if (G.dedup and held) s else { ...s, wal: s.wal.append(b) }),
        sent: st.sent.put(b, n + 1),
        acked: st.acked.union(Set(b)),
      },
      act' = lbl("append", b, sid),
    }
  }

  /// Shard.seal() / sealStream().
  action seal(sid: int): bool = {
    val s = st.sh.get(sid)
    val hi = s.wal.length()
    all {
      s.reg, hi > s.sealed,
      st' = { ...st, sh: st.sh.put(sid, { ...s, sealed: hi, bounds: s.bounds.union(Set(hi)) }) },
      act' = lbl("seal", sid, hi),
    }
  }

  /// Ledger -> shard: Shard.recorded(incarnation, throughSeq), with throughSeq read from the
  /// ledger (loggedWatermarks, or the committed watermark when the guard is off).
  action notify(sid: int): bool = {
    val s = st.sh.get(sid)
    val w = wmSeq(if (G.recAt == "logged") loggedWm(st) else st.led.wm, sid, s.inc)
    all {
      s.reg, w > s.rec, s.bounds.contains(w),               // next contiguous segment boundary
      st' = { ...st, sh: st.sh.put(sid, { ...s, rec: w }) },
      act' = lbl("recorded", sid, w),
    }
  }

  /// Shard.alarm() step 2: discard recorded segments through boundary `h`; the fence moves.
  action discard(sid: int, h: int): bool = {
    val s = st.sh.get(sid)
    all {
      s.reg, s.bounds.contains(h), h <= s.rec,
      // timing assumption (optional): a segment outlives every query attempt that was
      // planned before it was recorded, i.e. attempt duration < retainRecordedMs
      (G.retain and st.q.st == "tails" and st.q.need.contains(sid)) implies wmSeq(st.q.wm, sid, s.inc) >= h,
      st' = { ...st, sh: st.sh.put(sid, { ...s, disc: h, bounds: s.bounds.filter(x => x > h) }) },
      act' = lbl("discard", sid, h),
    }
  }

  /// Shard.alarm() step 3: forget fingerprints of discarded batches.
  action fpExpire(sid: int): bool = {
    val s = st.sh.get(sid)
    all {
      s.reg, s.fpg < s.disc,
      st' = {
        ...st,
        sh: st.sh.put(sid, { ...s, fpg: s.disc }),
        fpx: st.fpx.union((s.fpg + 1).to(s.disc).map(q => s.wal[q - 1])),
      },
      act' = lbl("fpExpire", sid, s.disc),
    }
  }

  /// The shard loses its storage. The incarnation number never repeats.
  action shardLoss(sid: int): bool = {
    val s = st.sh.get(sid)
    val n = s.wal.length()
    val safe = wmSeq(st.base.wm, sid, s.inc)
    all {
      s.reg, st.nSL < G.maxSL,
      st' = {
        ...st,
        sh: st.sh.put(sid, { ...freshShard, inc: s.inc }),
        nSL: st.nSL + 1,
        lost: st.lost.union((max2(s.disc, safe) + 1).to(n).map(q => s.wal[q - 1])),
        wiped: st.wiped.union((s.fpg + 1).to(n).map(q => s.wal[q - 1])),
      },
      act' = lbl("shardLoss", sid, 0),
    }
  }

  // ---------------------------------------------------------------- flush Worker

  /// Step 1: readSegment(). May be started for any segment the shard still holds, so the
  /// same segment can be flushed twice (duplicate wake, retry while the first still runs).
  action flushRead(sid: int, h: int, v: int): bool = {
    val s = st.sh.get(sid)
    val lo = segLo(s, h)
    all {
      s.reg, s.bounds.contains(h), st.jobs.size() < G.maxJobs, st.nFlush < G.maxFlush,
      st' = {
        ...st, nFlush: st.nFlush + 1,
        jobs: st.jobs.union(Set({ s: sid, inc: s.inc, lo: lo, hi: h, written: false,
                                  f: { rows: segRows(sid, s, lo, h), comp: false, v: v } })),
      },
      act' = lbl("flushRead", sid, h),
    }
  }

  /// Step 2: PUT the Parquet object.
  action flushWrite(j: Job): bool = all {
    not(j.written),
    st' = { ...st, obj: r2put(st.obj, j.f), jobs: st.jobs.exclude(Set(j)).union(Set({ ...j, written: true })) },
    act' = lbl("flushWrite", j.s, j.hi),
  }

  /// Step 3: ledger.addUnit(). Atomic, contiguous, idempotent on replay.
  action flushReport(j: Job): bool = {
    val l = st.led
    val known = l.wm.keys().contains(j.s) and l.wm.get(j.s).inc == j.inc
    val w = if (known) l.wm.get(j.s).seq else 0
    val admit =
      if (known) j.hi > w and (j.lo == w + 1 or (not(G.contiguous) and j.lo > w))
      else not(G.regFirst) and j.lo == 1     // no handshake: the first unit registers the stream
    val rest = { ...st, jobs: st.jobs.exclude(Set(j)) }
    all {
      j.written,
      st' = if (admit)
              commit(rest, { files: l.files.union(Set(j.f)), wm: l.wm.put(j.s, { inc: j.inc, seq: j.hi }) },
                     { ...noEntry, add: Set(j.f), wm: Set({ s: j.s, inc: j.inc, seq: j.hi }) })
            else rest,
      act' = lbl(if (admit) "addUnit" else "addUnitNoop", j.s, j.hi),
    }
  }

  /// The Worker dies between any two steps.
  action flushCrash(j: Job): bool = all {
    st' = { ...st, jobs: st.jobs.exclude(Set(j)) },
    act' = lbl("flushCrash", j.s, j.hi),
  }

  // ---------------------------------------------------------------- ledger log, loss, rebuild

  /// The outbox writes entry `i` to the R2 change log. Entries of the logged prefix are
  /// folded into `base` (what a rebuild from R2 would produce).
  action logWrite(i: int): bool = {
    val marked = st.out.replaceAt(i, { ...st.out[i], logged: true })
    val f = marked.foldl(
      { base: st.base, rest: [], open: true, ret: st.ret, expL: st.expiredLogged },
      (a, e) => if (a.open and e.logged)
                  { ...a, base: applyEntry(a.base, e), ret: a.ret.union(e.rem), expL: a.expL.union(e.exp) }
                else { ...a, open: false, rest: a.rest.append(e) })
    all {
      not(st.out[i].logged), G.logPrefix implies i == 0,
      st' = { ...st, base: f.base, out: f.rest, ret: f.ret, expiredLogged: f.expL },
      act' = lbl("logWrite", i, 0),
    }
  }

  /// The ledger loses its SQLite storage and is rebuilt from the R2 log (new ledger
  /// incarnation). Everything committed but not in the logged prefix is gone.
  action ledgerLoss: bool = all {
    st.nLL < G.maxLL, st.out.length() > 0,
    st' = { ...st, led: st.base, out: [], nLL: st.nLL + 1, expired: st.expiredLogged },
    act' = lbl("ledgerLossRebuild", 0, 0),
  }

  // ---------------------------------------------------------------- compaction, retention

  action compRead(f1: File, f2: File): bool = all {
    f1 != f2, st.obj.contains(f1), st.obj.contains(f2),
    st.nComp < G.maxComp, st.cjobs.size() == 0,
    st' = { ...st, nComp: st.nComp + 1,
            cjobs: Set({ ins: Set(f1, f2), out: { rows: f1.rows.union(f2.rows), comp: true, v: 1 }, written: false }) },
    act' = lbl("compRead", 0, 0),
  }

  action compWrite(c: CJob): bool = all {
    not(c.written),
    st' = { ...st, obj: r2put(st.obj, c.out), cjobs: Set({ ...c, written: true }) },
    act' = lbl("compWrite", 0, 0),
  }

  /// ledger.replace(): swap inputs for the output iff every input is still live.
  action compCommit(c: CJob): bool = {
    val l = st.led
    val ok = not(G.replaceLive) or c.ins.subseteq(l.files)
    val rest = { ...st, cjobs: Set() }
    all {
      c.written,
      st' = if (ok)
              commit(rest, { ...l, files: l.files.exclude(c.ins).union(Set(c.out)) },
                     { ...noEntry, add: Set(c.out), rem: c.ins.intersect(l.files) })
            else rest,
      act' = lbl(if (ok) "replace" else "replaceConflict", 0, 0),
    }
  }

  action compCrash(c: CJob): bool = all {
    st' = { ...st, cjobs: Set() },
    act' = lbl("compCrash", 0, 0),
  }

  /// ledger.expire(): retention removes a whole file.
  action expire(f: File): bool = {
    val l = st.led
    all {
      st.nExp < G.maxExp,
      st' = { ...commit(st, { ...l, files: l.files.exclude(Set(f)) }, { ...noEntry, rem: Set(f), exp: f.rows }),
              nExp: st.nExp + 1, expired: st.expired.union(f.rows) },
      act' = lbl("expire", 0, 0),
    }
  }

  // ---------------------------------------------------------------- physical deletion

  pure def live(s: State, o: File): bool = s.led.files.exists(f => sameKey(f, o))

  pure def inPlan(s: State, o: File): bool = s.q.st == "tails" and s.q.files.exists(f => sameKey(f, o))

  /// Deletion of a file the ledger removed (compaction input, retention).
  action deleteRetired(o: File): bool = {
    val removedCommitted = st.out.foldl(st.ret, (a, e) => a.union(e.rem))
    all {
      not(live(st, o)),
      if (G.delLogged) st.ret.exists(f => sameKey(f, o)) else removedCommitted.exists(f => sameKey(f, o)),
      G.delGrace implies not(inPlan(st, o)),
      st' = { ...st, obj: st.obj.exclude(Set(o)), ret: st.ret.filter(f => not(sameKey(f, o))) },
      act' = lbl("deleteRetired", 0, 0),
    }
  }

  /// The orphan sweeper.
  ///  "spec"  DESIGN §4.3: unreferenced AND its sequence range is below the stream's logged
  ///          watermark. Compaction outputs have no sequence range: never swept.
  ///  "spec_comp" same, but a compaction output counts as "below" when all its rows are.
  ///  "fixed" spec AND the key is not named anywhere in the ledger's log or outbox
  ///          (never referenced), so retired files are left to deleteRetired.
  ///  "any"   unreferenced.
  action sweepOrphan(o: File): bool = {
    val below = o.rows.forall(r => r.q <= wmSeq(st.base.wm, r.s, r.inc))
    val named = st.out.foldl(st.base.files.union(st.ret), (a, e) => a.union(e.add).union(e.rem))
    all {
      G.sweep != "off", not(live(st, o)),
      or {
        G.sweep == "any",
        G.sweep == "spec" and below and not(o.comp),
        G.sweep == "spec_comp" and below,
        G.sweep == "fixed" and below and not(o.comp) and not(named.exists(f => sameKey(f, o))),
      },
      st' = { ...st, obj: st.obj.exclude(Set(o)), ret: st.ret.filter(f => not(sameKey(f, o))) },
      act' = lbl("sweepOrphan", 0, 0),
    }
  }

  // ---------------------------------------------------------------- query

  /// ledger.plan(): files and watermarks at one ledger version.
  action qPlan: bool = all {
    st.q.st != "tails", st.nQ < G.maxQ,
    st' = { ...st, q: plan(st), nQ: st.nQ + 1 },
    act' = lbl("qPlan", 0, 0),
  }

  /// Shard.tailRead(incarnation, aboveSeq), a separate later step per shard.
  action qTail(sid: int): bool = {
    val s = st.sh.get(sid)
    val w = st.q.wm.get(sid)
    val mism = if (s.reg) s.inc != w.inc else G.unknownStream == "refuse"
    val stale = s.reg and s.inc == w.inc and G.fence and w.seq < s.disc
    val got = if (s.reg) segRows(sid, s, max2(w.seq, s.disc) + 1, s.wal.length()) else Set()
    all {
      st.q.st == "tails", st.q.need.contains(sid),
      (mism or stale) implies st.restarts < G.maxRestarts,
      st' = if (mism or stale)
              if (G.replanWhole or not(st.led.wm.keys().contains(sid))) restart(st)
              // BUG variant: keep the file list, refresh only this shard's watermark
              else { ...st, restarts: st.restarts + 1, q: { ...st.q, wm: st.q.wm.put(sid, st.led.wm.get(sid)) } }
            else { ...st, q: { ...st.q, need: st.q.need.exclude(Set(sid)), tail: st.q.tail.union(got) } },
      act' = lbl(if (mism) "qTailIncarnationMismatch" else if (stale) "qTailStale" else "qTailOk", sid, w.seq),
    }
  }

  /// Read the planned files, merge with the tails, finish.
  action qFinish: bool = {
    val readable = st.q.files.intersect(st.obj)
    val err = G.missingErr and readable != st.q.files
    val exempt = st.lost.union(st.expired.map(r => r.b))
    all {
      st.q.st == "tails", st.q.need.size() == 0,
      err implies st.restarts < G.maxRestarts,
      st' = if (err) restart(st)
            else { ...st, q: { ...idleQuery, st: "done", must: st.q.must,
                               dup: BATCHES.filter(b => count(readable, st.q.tail, b) > 1),
                               miss: st.q.must.exclude(exempt).filter(b => count(readable, st.q.tail, b) == 0) } },
      act' = lbl(if (err) "qFileMissingReplan" else "qDone", 0, 0),
    }
  }

  // ---------------------------------------------------------------- next-state relation

  action step = any {
    nondet b = oneOf(BATCHES)
    clientAppend(b),
    nondet sid = oneOf(SHARDS)
    any { register(sid), seal(sid), notify(sid), fpExpire(sid), shardLoss(sid), qTail(sid) },
    nondet sid = oneOf(SHARDS)
    nondet h = oneOf(st.sh.get(sid).bounds)
    nondet v = oneOf(1.to(G.variants))
    any { discard(sid, h), flushRead(sid, h, v) },
    nondet j = oneOf(st.jobs)
    any { flushWrite(j), flushReport(j), flushCrash(j) },
    nondet i = oneOf(st.out.indices())
    logWrite(i),
    ledgerLoss,
    nondet f1 = oneOf(st.led.files)
    nondet f2 = oneOf(st.led.files)
    any { compRead(f1, f2), expire(f1) },
    nondet c = oneOf(st.cjobs)
    any { compWrite(c), compCommit(c), compCrash(c) },
    nondet o = oneOf(st.obj)
    any { deleteRetired(o), sweepOrphan(o) },
    qPlan,
    qFinish,
  }

  // ---------------------------------------------------------------- properties
  // Numbers refer to design/VERIFICATION.md §2.

  pure def exemptB(s: State): Set[int] = s.lost.union(s.expired.map(r => r.b))

  pure def inShard(s: State, b: int): bool =
    SHARDS.exists(sid => { val x = s.sh.get(sid)  x.wal.indices().exists(i => i + 1 > x.disc and x.wal[i] == b) })

  pure def inLedger(s: State, b: int): bool =
    s.led.files.exists(f => s.obj.contains(f) and f.rows.exists(r => r.b == b))

  /// I1 (+I2, storage half): every acknowledged batch is in durable shard storage or in a
  /// readable file listed in the ledger, unless retention removed it or a shard storage
  /// loss destroyed it before the ledger had logged it.
  val I1_AckedIsDurable = st.acked.exclude(exemptB(st)).forall(b => inShard(st, b) or inLedger(st, b))

  /// I3: a completed query returns no batch more often than it was accepted (once).
  val I3_NoDuplicates = st.q.st == "done" implies st.q.dup == Set()

  /// I4 (+I2, query half): a completed query returns every batch acknowledged before its
  /// plan was read (same exemptions as I1). This is the fence property.
  val I4_NoGapAtSeam = st.q.st == "done" implies st.q.miss == Set()

  /// I5: a shard has recorded/discarded only what the ledger has committed AND logged;
  /// in particular a rebuild from the log never leaves a watermark below a discard mark.
  val I5_DiscardOnlyLogged = SHARDS.forall(sid => {
    val x = st.sh.get(sid)
    x.reg implies and { x.disc <= x.rec, x.rec <= wmSeq(st.base.wm, sid, x.inc), x.rec <= wmSeq(st.led.wm, sid, x.inc) }
  })

  /// I11: the ledger never lists a file whose object is missing or whose stored bytes are
  /// not the bytes its metadata describes.
  val I11_LiveFilesReadable = st.led.files.subseteq(st.obj)

  /// I9/I10: no row removed by retention is live again (compaction must not resurrect).
  val I9_NoResurrection = st.led.files.forall(f => f.rows.intersect(st.expired) == Set())

  /// Liveness proxy L1: the ledger knows every stream that accepts writes, with the right
  /// incarnation. If not, addUnit and every tail read for it are refused for ever.
  val L1_StreamRegistered = SHARDS.forall(sid => {
    val x = st.sh.get(sid)
    x.reg implies (st.led.wm.keys().contains(sid) and st.led.wm.get(sid).inc == x.inc)
  })

  /// Liveness proxy L2: no query attempt is refused (holds only under `retain`).
  val L2_NoRestart = st.restarts == 0

  /// Used to exhibit a trace with three refusals of one query.
  val L2_RestartsBelow3 = st.restarts < 3

  val Safety = and { I1_AckedIsDurable, I3_NoDuplicates, I4_NoGapAtSeam, I5_DiscardOnlyLogged, I11_LiveFilesReadable, I9_NoResurrection }
  val SafetyAndL1 = Safety and L1_StreamRegistered
}
