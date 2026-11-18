// -*- mode: Bluespec; -*-
// Deterministic scenario tests for viz.qnt (`npm run test:quint`). Each run replays one
// interleaving step by step and checks the state it ends in. They pin down the behaviour
// the model checker's counterexamples rely on, so a change to viz.qnt that silently
// disables an action shows up here.

// The amended protocol (experiments.mjs FIXED).
module fixed_test {
  import viz(G = { fence: true, contiguous: true, recAt: "logged", logPrefix: true, dedup: true, fpHorizon: true,
    replaceLive: true, delGrace: true, delLogged: true, missingErr: true, keying: "content", sweep: "fixed",
    regFirst: true, regLogged: true, unknownStream: "refuse", replanWhole: true, retain: false, noRetryAcrossLoss: true,
    nb: 2, ns: 1, maxSend: 2, variants: 1, maxJobs: 2, maxFlush: 3, maxComp: 1, maxExp: 1, maxLL: 1, maxSL: 1,
    maxQ: 1, maxRestarts: 2, trace: true }).* from "./viz"

  action anyFlushWrite = nondet j = oneOf(st.jobs) flushWrite(j)
  action anyFlushReport = nondet j = oneOf(st.jobs) flushReport(j)

  /// Batch 0 is flushed, recorded and discarded after the query planned: the tail read is refused
  /// (the fence) and the re-planned attempt returns batch 0 from the file.
  run fenceRefusesThenReplans =
    init
      .then(register(0)).then(logWrite(0))
      .then(clientAppend(0)).then(seal(0))
      .then(flushRead(0, 1, 1)).then(anyFlushWrite)
      .then(qPlan)
      .then(anyFlushReport).then(logWrite(0)).then(notify(0)).then(discard(0, 1))
      .then(qTail(0))
      .expect(and { st.restarts == 1, act.n == "qTailStale", st.q.files.size() == 1 })
      .then(qTail(0)).then(qFinish)
      .expect(and { st.q.st == "done", st.q.miss == Set(), st.q.dup == Set(), Safety })

  /// A retried batch is stored once while its fingerprint is held.
  run retryIsDeduplicated =
    init
      .then(register(0)).then(logWrite(0))
      .then(clientAppend(0)).then(clientAppend(0))
      .expect(and { st.sh.get(0).wal == [0], st.sent.get(0) == 2 })

  /// The shard is told `recorded` only at the LOGGED watermark: with the unit committed but not
  /// logged, notify is disabled; a ledger rebuild then rolls the watermark back without harm.
  run recordedWaitsForTheLog =
    init
      .then(register(0)).then(logWrite(0))
      .then(clientAppend(0)).then(seal(0))
      .then(flushRead(0, 1, 1)).then(anyFlushWrite).then(anyFlushReport)
      .expect(st.led.wm.get(0).seq == 1 and st.base.wm.get(0).seq == 0)
      .then(ledgerLoss)
      .expect(and { st.led.wm.get(0).seq == 0, st.sh.get(0).rec == 0, Safety })
}

// The design as written, with shard.ts's answer for a stream the shard no longer holds.
module literal_test {
  import viz(G = { fence: true, contiguous: true, recAt: "logged", logPrefix: true, dedup: true, fpHorizon: true,
    replaceLive: true, delGrace: true, delLogged: true, missingErr: true, keying: "content", sweep: "fixed",
    regFirst: true, regLogged: true, unknownStream: "empty", replanWhole: true, retain: false, noRetryAcrossLoss: true,
    nb: 2, ns: 1, maxSend: 2, variants: 1, maxJobs: 2, maxFlush: 3, maxComp: 1, maxExp: 1, maxLL: 1, maxSL: 1,
    maxQ: 1, maxRestarts: 2, trace: true }).* from "./viz"

  action anyFlushWrite = nondet j = oneOf(st.jobs) flushWrite(j)
  action anyFlushReport = nondet j = oneOf(st.jobs) flushReport(j)

  /// F6: the unit for batch 0 is admitted after the plan, the shard then loses its storage and
  /// answers the tail read "ok, nothing": the query completes without batch 0.
  run f6UnknownStreamReadsEmpty =
    init
      .then(register(0)).then(logWrite(0))
      .then(clientAppend(0)).then(seal(0))
      .then(flushRead(0, 1, 1)).then(anyFlushWrite)
      .then(qPlan)
      .then(anyFlushReport).then(logWrite(0))
      .then(shardLoss(0))
      .then(qTail(0)).then(qFinish)
      .expect(and { st.q.st == "done", st.q.miss == Set(0), not(I4_NoGapAtSeam) })
}
