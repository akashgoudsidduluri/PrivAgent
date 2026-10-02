#!/bin/sh
# Post-17.9 semantic-observation mutation run.
#
# Four mutants, each AT the SUCCESS boundary, each applied with an exact-match
# assertion so a silent no-op is impossible. For each: apply, run the focused
# suite, record whether it was CAUGHT (the suite must fail), then restore from a
# byte-exact backup.
#
# Sources are backed up by COPY, never `git checkout` — the work under test is
# uncommitted, and restoring from the index would silently destroy it.
set -u
cd /home/daytona/codebase || exit 1

GOAL=extension/src/agent/goalVerifier.ts
FRESH=extension/src/semanticObservation/freshness.ts
FACT=extension/src/semanticObservation/factExtraction.ts
OUT=docs/evidence/post-17-9/semantic-observation/mutation_results.json
BACKUP=/tmp/so_mutation_backup
mkdir -p "$(dirname "$OUT")" "$BACKUP"

cp "$GOAL" "$BACKUP/goalVerifier.ts"
cp "$FRESH" "$BACKUP/freshness.ts"
cp "$FACT" "$BACKUP/factExtraction.ts"
BEFORE=$(md5sum "$GOAL" "$FRESH" "$FACT")

restore() {
  cp "$BACKUP/goalVerifier.ts" "$GOAL"
  cp "$BACKUP/freshness.ts" "$FRESH"
  cp "$BACKUP/factExtraction.ts" "$FACT"
}

RESULTS='[]'

run_mutant() {
  mutant="$1"; desc="$2"; target="$3"; old="$4"; new="$5"
  restore
  if ! python3 - "$target" "$old" "$new" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
if src.count(old) != 1:
    print(f"MUTATION_ANCHOR_MISS ({src.count(old)} matches) in {path}")
    sys.exit(3)
open(path, 'w').write(src.replace(old, new))
PY
  then
    echo "=== $mutant: ANCHOR MISS — not applied"
    RESULTS=$(python3 -c "
import json,sys
cur=json.loads(sys.argv[1]); cur.append({'mutant':sys.argv[2],'description':sys.argv[3],'caught':False,'note':'anchor miss — mutation not applied'}); print(json.dumps(cur))" "$RESULTS" "$mutant" "$desc")
    return
  fi

  log="/tmp/so_mutant_$mutant.log"
  npx vitest run tests/post179SemanticObservation.test.ts >"$log" 2>&1; code=$?
  summary=$(grep -E "^ +Tests +" "$log" | head -1)
  failed=$(echo "$summary" | sed -nE 's/.*Tests +([0-9]+) failed.*/\1/p'); [ -z "$failed" ] && failed=0
  passed=$(echo "$summary" | sed -nE 's/.*Tests +[0-9]+ failed.*\| *([0-9]+) passed.*/\1/p'); [ -z "$passed" ] && passed=0
  # vitest exits non-zero when any test fails; the exit code is the primary signal,
  # the counts are recorded only as supporting evidence.
  if [ "$code" -ne 0 ] && [ "$failed" -gt 0 ]; then caught=true; else caught=false; fi
  killed=$(grep -oE "^ +× .*" "$log" | sed -E 's/^ +× //' | head -5 | paste -sd ";" -)
  echo "=== $mutant (caught=$caught, exit=$code, failed=$failed, passed=$passed) — $desc"
  [ -n "$killed" ] && echo "    killed-by: $killed"
  RESULTS=$(python3 -c "
import json,sys
cur=json.loads(sys.argv[1])
cur.append({'mutant':sys.argv[2],'description':sys.argv[3],'caught':sys.argv[4]=='true','failing_tests':int(sys.argv[5]),'passed_tests':int(sys.argv[6]),'killed_by':sys.argv[7]})
print(json.dumps(cur))" "$RESULTS" "$mutant" "$desc" "$caught" "$failed" "$passed" "$killed")
  restore
}

# Applies TWO edits to the same file atomically, then runs the suite once.
# Used for mutants that are only observable in combination.
run_compound() {
  name="$1"; desc="$2"; target="$3"; oldA="$4"; newA="$5"; oldB="$6"; newB="$7"
  restore
  if ! python3 - "$target" "$oldA" "$newA" "$oldB" "$newB" <<'PY'
import sys
path, oldA, newA, oldB, newB = sys.argv[1:6]
src = open(path).read()
for tag, old in (("A", oldA), ("B", oldB)):
    if src.count(old) != 1:
        print(f"MUTATION_ANCHOR_MISS_{tag} ({src.count(old)} matches) in {path}")
        sys.exit(3)
src = src.replace(oldA, newA).replace(oldB, newB)
open(path, 'w').write(src)
PY
  then
    echo "=== $name: ANCHOR MISS — not applied"
    RESULTS=$(python3 -c "
import json,sys
cur=json.loads(sys.argv[1]); cur.append({'mutant':sys.argv[2],'description':sys.argv[3],'caught':False,'note':'anchor miss'}); print(json.dumps(cur))" "$RESULTS" "$name" "$desc")
    return
  fi

  log="/tmp/so_mutant_${name}.log"
  npx vitest run tests/post179SemanticObservation.test.ts >"$log" 2>&1; code=$?
  summary=$(grep -E "^ +Tests +" "$log" | head -1)
  failed=$(echo "$summary" | sed -nE 's/.*Tests +([0-9]+) failed.*/\1/p'); [ -z "$failed" ] && failed=0
  killed=$(grep -oE "^ +× .*" "$log" | sed -E 's/^ +× //' | head -5 | paste -sd ";" -)
  if [ "$code" -ne 0 ] && [ "$failed" -gt 0 ]; then caught=true; else caught=false; fi
  echo "=== $name (caught=$caught, exit=$code, failed=$failed) — $desc"
  [ -n "$killed" ] && echo "    killed-by: $killed"
  RESULTS=$(python3 -c "
import json,sys
cur=json.loads(sys.argv[1])
cur.append({'mutant':sys.argv[2],'description':sys.argv[3],'caught':sys.argv[4]=='true','failing_tests':int(sys.argv[5]),'killed_by':sys.argv[6]})
print(json.dumps(cur))" "$RESULTS" "$name" "$desc" "$caught" "$failed" "$killed")
  restore
}

# ── M1: remove the semantic-evidence requirement ────────────────────────────
run_mutant "M1" "remove the semantic-evidence requirement: fabricate a matching fact when none was observed" \
  "$GOAL" \
  "      const matched = selectReportedFact(observation, task);" \
  "      const matched = selectReportedFact(observation, task) ?? ({ label: 'Fabricated', key: 'price', displayText: 'Price: 0', displayValue: 0, valueKind: 'numeric', source: 'DOM_TEXT_REGION', untrusted: false, confidence: 1, pageGeneration: state.currentPageGeneration } as SemanticFact);"

# ── M1+M7: the compound M1 is only caught by ───────────────────────────────
run_compound "M1+M7" "fabricated fact AND no value-identity check: invent a value when nothing was observed" \
  "$GOAL" \
  "      const matched = selectReportedFact(observation, task);" \
  "      const matched = selectReportedFact(observation, task) ?? ({ label: 'Fabricated', key: 'price', displayText: 'Price: 0', displayValue: 0, valueKind: 'numeric', source: 'DOM_TEXT_REGION', untrusted: false, confidence: 1, pageGeneration: state.currentPageGeneration } as SemanticFact);" \
  "        if (candidates.length === 1 && observed) {" \
  "        if (candidates.length === 1 && { displayText: matched.displayText, displayValue: matched.displayValue }) {"

# ── M2: accept stale evidence ───────────────────────────────────────────────
run_mutant "M2" "accept stale semantic evidence: drop the observation age check" \
  "$FRESH" \
  "  if (now - provenance.observedAt > maxAge) return false;" \
  "  if (false) return false;"

# ── M3: accept wrong-page evidence ──────────────────────────────────────────
run_mutant "M3" "accept wrong-page evidence: drop the document-identity check" \
  "$FRESH" \
  "  if (!isSameDocumentIdentity(provenance.documentUrl, currentDocumentUrl ?? null)) return false;" \
  "  if (false) return false;"

# ── M4: accept a model claim alone ──────────────────────────────────────────
# Individually SURVIVES: with the value-identity check (M7's target) in place,
# a substituted claim cannot match an observed candidate, so the suite is green
# and this mutant is not killed on its own. It is kept because the COMPOUND
# run below (M4+M7 together) IS caught, which is what proves the two together
# are load-bearing. Reported honestly as an equivalent mutant.
run_mutant "M4" "accept a model claim alone (survives alone; killed only in the M4+M7 compound)" \
  "$GOAL" \
  "      const matched = selectReportedFact(observation, task);" \
  "      const claim = String((state as unknown as { lastActionResult?: { reason?: string } }).lastActionResult?.reason ?? '');
      const matched = selectReportedFact(observation, task) ?? (/price/i.test(claim) ? ({ label: 'Model claim', key: 'price', displayText: claim, displayValue: null, valueKind: 'text', source: 'DOM_TEXT_REGION', untrusted: false, confidence: 1, pageGeneration: state.currentPageGeneration } as SemanticFact) : null);"

# ── M5: remove the M8 re-screen on extracted facts (privacy boundary) ────────
run_mutant "M5" "remove the M8 raw-value re-screen: keep a fact that failed the privacy scan" \
  "$FACT" \
  "  if (violations.length > 0) return null;" \
  "  if (false && violations.length > 0) return null;"

# ── M6: remove the ambiguity guard (the regression found by the real run) ────
run_mutant "M6" "remove the ambiguity guard: a listing with several values certifies 'the' value anyway" \
  "$GOAL" \
  "        if (candidates.length === 1 && observed) {" \
  "        if (candidates.length >= 1 && observed) {"

# ── M7: drop the value-identity check (the hole mutation M4 exposed) ─────────
run_mutant "M7" "accept a fact that shares the key but not the observed value" \
  "$GOAL" \
  "        if (candidates.length === 1 && observed) {" \
  "        if (candidates.length === 1 && { displayText: matched.displayText, displayValue: matched.displayValue }) {"

# ── M4+M7: the COMPOUND that the two above are only caught by ───────────────
# Individually M4 and M7 are equivalent mutants: neither alone changes any
# verdict, because whichever one is removed the other still blocks the forged
# value. Removing BOTH lets a model's own claim certify a goal no observation
# supports — the exact hole I7 pins.
run_compound "M4+M7" "model-claim substitution AND no value-identity check: a model's claim certifies the goal on its own" \
  "$GOAL" \
  "      const matched = selectReportedFact(observation, task);" \
  "      const claim = String((state as unknown as { lastActionResult?: { reason?: string } }).lastActionResult?.reason ?? '');
      const matched = selectReportedFact(observation, task) ?? (/price/i.test(claim) ? ({ label: 'Model claim', key: 'price', displayText: claim, displayValue: null, valueKind: 'text', source: 'DOM_TEXT_REGION', untrusted: false, confidence: 1, pageGeneration: state.currentPageGeneration } as SemanticFact) : null);" \
  "        if (candidates.length === 1 && observed) {" \
  "        if (candidates.length === 1 && { displayText: matched.displayText, displayValue: matched.displayValue }) {"

restore
AFTER=$(md5sum "$GOAL" "$FRESH" "$FACT")
if [ "$BEFORE" = "$AFTER" ]; then
  RESTORED=true
  echo "=== restore verified: sources byte-identical to pre-run state"
else
  RESTORED=false
  echo "=== RESTORE MISMATCH"; echo "$BEFORE"; echo "$AFTER"
fi

python3 -c "
import json,sys
data=json.loads(sys.argv[1])
data.append({'restored_byte_identical': sys.argv[2]=='true'})
open('$OUT','w').write(json.dumps(data, indent=2) + '\n')
print('wrote $OUT')
" "$RESULTS" "$RESTORED"
