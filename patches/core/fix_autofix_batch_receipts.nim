# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Upstream 4.16336.0 starts a drained batch under its first message UUID,
# retaining the other UUIDs in pendingCycle.promptUuids, but emits completion
# for only the first. Auto-fix notices later in the batch remain pending.
# Preserve every upstream health/query/adoption guard. On Linux, confirm only
# additional user messages already echoed, still buffered and not withdrawn,
# and not reserved for the next cycle. Do not confirm all queued messages.
import std/[os, strutils]
import regex

const prefixPattern =
  "([\\w$]+)&&([\\w$]+)\\.query===([\\w$]+)\\.queryObj&&([\\w$]+)!==void 0&&!([\\w$]+)\\.adoptedByStartedCommand&&([\\w$]+)\\.health===[\"`]healthy[\"`]&&"
let originalRe = re2(
  prefixPattern &
    "this\\.deps\\.emit\\([\"`]turnCompleted[\"`],([\\w$]+),([\\w$]+)\\.userMessageUuid\\)"
)
let installedRe = re2(
  prefixPattern &
    "\\(process\\.platform===\"linux\"\\?\\(\\(\\)=>\\{const __cdbBatchReceiptIds="
)

proc replacement(session, cycle, id: string): string =
  let emit = "this.deps.emit(\"turnCompleted\"," & id & ","
  "(process.platform===\"linux\"?(()=>{const __cdbBatchReceiptIds=new Set([" & cycle &
    ".userMessageUuid]);for(const __cdbBatchReceiptId of Array.isArray(" & cycle &
    ".promptUuids)?" & cycle &
    ".promptUuids:[]){if(typeof __cdbBatchReceiptId===\"string\"&&__cdbBatchReceiptId.length>0&&!" &
    session & ".pendingEchoUuids?.has(__cdbBatchReceiptId)&&" & session &
    ".nextCycleUuid!==__cdbBatchReceiptId&&" & session &
    ".messageBuffer?.some(__cdbBatchReceiptMessage=>__cdbBatchReceiptMessage.type===\"user\"&&__cdbBatchReceiptMessage.uuid===__cdbBatchReceiptId&&!__cdbBatchReceiptMessage.isWithdrawn))__cdbBatchReceiptIds.add(__cdbBatchReceiptId)}for(const __cdbBatchReceiptId of __cdbBatchReceiptIds)" &
    emit & "__cdbBatchReceiptId)})():" & emit & cycle & ".userMessageUuid))"

proc apply*(input: string): string =
  result = input
  const EXPECTED_PATCHES = 1
  var patchesApplied = 0
  if "__cdbBatchReceiptIds" in input:
    let hits = input.findAll(installedRe)
    if hits.len != 1 or input.findAll(originalRe).len != 0:
      raise newException(ValueError, "batch receipt end-state count changed; re-audit")
    let m = hits[0]
    if input[m.group(3)] != input[m.group(4)]:
      raise newException(ValueError, "batch receipt cycle guards changed; re-audit")
    # Read the three identifiers from the installed lambda's stable operands.
    let bodyRe = re2"__cdbBatchReceiptIds=new Set\(\[([\w$]+)\.userMessageUuid\]\)"
    let bodies = input.findAll(bodyRe)
    let emitRe =
      re2"""for\(const __cdbBatchReceiptId of __cdbBatchReceiptIds\)this\.deps\.emit\("turnCompleted",([\w$]+),__cdbBatchReceiptId\)"""
    let emits = input.findAll(emitRe)
    if bodies.len != 1 or emits.len != 1 or
        input[bodies[0].group(0)] != input[m.group(3)] or
        input.count(
          replacement(input[m.group(1)], input[m.group(3)], input[emits[0].group(0)])
        ) != 1:
      raise newException(ValueError, "batch receipt injection differs; re-audit")
    inc patchesApplied
  else:
    let hits = input.findAll(originalRe)
    if hits.len != 1:
      raise newException(
        ValueError, "expected one healthy native completion emitter; re-audit"
      )
    let m = hits[0]
    let cycle = input[m.group(3)]
    if cycle != input[m.group(4)] or cycle != input[m.group(7)]:
      raise newException(ValueError, "completion cycle identity changed; re-audit")
    let original = input[m.boundaries]
    let prefix = original[0 ..< original.find("this.deps.emit")]
    result = result.replace(
      original, prefix & replacement(input[m.group(1)], cycle, input[m.group(6)])
    )
    inc patchesApplied
  if patchesApplied != EXPECTED_PATCHES:
    raise newException(ValueError, "incomplete batch receipt patch")
  echo "  [OK] healthy batch completion confirms echoed, non-withdrawn user UUIDs"

when isMainModule:
  if paramCount() != 1:
    quit("Usage: fix_autofix_batch_receipts <bundle.js>", 1)
  let file = paramStr(1)
  writeFile(file, apply(readFile(file)))
