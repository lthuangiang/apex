# Tasks: Execution Edge (Phase 5)

## Task List

- [x] 1. Add EXEC_* config keys
  - [x] 1.1 Add all EXEC_* keys to config.ts with default values
  - [x] 1.2 Add EXEC_* keys to OverridableConfig in ConfigStore.ts
  - [x] 1.3 Add validation rules for EXEC_* keys in validateOverrides (EXEC_OFFSET_MAX >= EXEC_OFFSET_MIN, EXEC_FILL_RATE_THRESHOLD in [0,1], EXEC_DEPTH_LEVELS >= 1)

- [x] 2. Implement FillTracker
  - [x] 2.1 Create src/modules/FillTracker.ts with FillRecord, FillStats, OrderType types
  - [x] 2.2 Implement ring buffer (two arrays, one per order type) with push/evict logic
  - [x] 2.3 Implement recordFill(type, fillMs) — pushes { filled: true, fillMs, ts }
  - [x] 2.4 Implement recordCancel(type) — pushes { filled: false, fillMs: 0, ts }
  - [x] 2.5 Implement getFillStats(type) — computes fillRate, avgFillMs, sampleSize; returns fillRate=1.0 when buffer empty
  - [x] 2.6 Implement reset() — clears both buffers

- [x] 3. Implement ExecutionEdge
  - [x] 3.1 Create src/modules/ExecutionEdge.ts with OffsetResult type
  - [x] 3.2 Implement spreadBps computation: (best_ask - best_bid) / best_bid × 10000
  - [x] 3.3 Implement spread guard: return spreadOk=false when spreadBps > EXEC_MAX_SPREAD_BPS
  - [x] 3.4 Implement depth score: fetch get_orderbook_depth, sum price×size for top EXEC_DEPTH_LEVELS on relevant side; default to 0 on error
  - [x] 3.5 Implement depth penalty: EXEC_DEPTH_PENALTY when depthScore < EXEC_DEPTH_THIN_THRESHOLD, else 0
  - [x] 3.6 Implement fill rate penalty: EXEC_FILL_RATE_PENALTY when fillRate < EXEC_FILL_RATE_THRESHOLD and sampleSize > 0, else 0
  - [x] 3.7 Implement offset formula and clamp to [EXEC_OFFSET_MIN, EXEC_OFFSET_MAX]
  - [x] 3.8 Log offset result (offset, spreadBps, depthScore, fillRatePenalty, spreadOk) on every call

- [x] 4. Integrate ExecutionEdge into Executor
  - [x] 4.1 Inject ExecutionEdge and FillTracker into Executor constructor
  - [x] 4.2 In placeEntryOrder: call executionEdge.computeOffset() after fetching orderbook
  - [x] 4.3 Return null immediately when spreadOk=false (log spread value and threshold)
  - [x] 4.4 Use edgeResult.offset as effectiveOffset instead of legacy priceOffset parameter
  - [x] 4.5 Keep legacy priceOffset parameter for backward compatibility (ignored when ExecutionEdge is active)

- [x] 5. Integrate FillTracker into Watcher
  - [x] 5.1 Inject FillTracker into Watcher constructor (or instantiate internally)
  - [x] 5.2 On PENDING_ENTRY → IN_POSITION (fill): call fillTracker.recordFill('entry', fillMs)
  - [x] 5.3 On PENDING_ENTRY timeout → cancel: call fillTracker.recordCancel('entry')
  - [x] 5.4 On PENDING_EXIT → IDLE (fill): call fillTracker.recordFill('exit', fillMs)
  - [x] 5.5 On PENDING_EXIT timeout → cancel: call fillTracker.recordCancel('exit')
  - [x] 5.6 In resetSession(): call fillTracker.reset()

- [x] 6. Wire FillTracker into Executor (pass reference)
  - [x] 6.1 Pass the same FillTracker instance from Watcher to Executor so ExecutionEdge reads live stats

- [x] 7. Tests — FillTracker
  - [x] 7.1 Unit: recordFill adds filled=true record; recordCancel adds filled=false record
  - [x] 7.2 Unit: ring buffer evicts oldest when full (length stays <= EXEC_FILL_WINDOW)
  - [x] 7.3 Unit: getFillStats returns fillRate=1.0 and sampleSize=0 for empty buffer
  - [x] 7.4 Unit: getFillStats computes correct fillRate and avgFillMs for known sequences
  - [x] 7.5 Unit: reset() clears both buffers
  - [x] 7.6 Property: buffer.length <= EXEC_FILL_WINDOW after any sequence of record calls
  - [x] 7.7 Property: getFillStats().fillRate ∈ [0, 1] for any record sequence

- [x] 8. Tests — ExecutionEdge
  - [x] 8.1 Unit: spreadBps > EXEC_MAX_SPREAD_BPS → spreadOk=false, offset=0
  - [x] 8.2 Unit: spreadBps <= EXEC_MAX_SPREAD_BPS → spreadOk=true
  - [x] 8.3 Unit: thin book (depthScore < threshold) → depthPenalty applied
  - [x] 8.4 Unit: deep book (depthScore >= threshold) → no depthPenalty
  - [x] 8.5 Unit: low fill rate (< threshold, sampleSize > 0) → fillRatePenalty applied
  - [x] 8.6 Unit: empty buffer (sampleSize=0) → no fillRatePenalty
  - [x] 8.7 Unit: get_orderbook_depth failure → depthScore=0, thin-book penalty applied, no throw
  - [x] 8.8 Property: offset ∈ [EXEC_OFFSET_MIN, EXEC_OFFSET_MAX] for any valid orderbook with spreadOk=true
  - [x] 8.9 Property: wider spread → larger or equal offset (fixed depth and fill stats, before clamp)
  - [x] 8.10 Property: spreadBps > EXEC_MAX_SPREAD_BPS always produces spreadOk=false

- [x] 9. Tests — Executor integration
  - [x] 9.1 Unit: placeEntryOrder returns null when spreadOk=false
  - [x] 9.2 Unit: placeEntryOrder uses edgeResult.offset in price calculation

- [ ] 10. Dashboard / observability (optional)
  - [ ] 10.1 Expose fillTracker.getFillStats() in sharedState or dashboard API endpoint
