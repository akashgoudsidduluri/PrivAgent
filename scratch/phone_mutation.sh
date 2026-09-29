#!/bin/sh
# M8 PHONE-DETECTION GAP — mutation run.
#
# Each mutant disables or loosens one real guard at the phone-detection
# boundary. Sources are backed up by COPY (the work under test is uncommitted),
# each edit is applied with an exact-match anchor assertion so a silent no-op
# is impossible, and the restore is verified byte-identical by md5.
#
# Equivalent mutants are reported as equivalent, never as passes.
set -u
cd /home/daytona/codebase || exit 1

PAT=extension/src/privacy/patterns.ts
SCAN=extension/src/privacy/rawValueScanner.ts
DOM=extension/src/privacy/domDetector.ts
OUT=docs/evidence/post-17-9/m8-phone-detection/mutation_results.json
BACKUP=/tmp/phone_mutation_backup
mkdir -p "$(dirname "$OUT")" "$BACKUP"

cp "$PAT" "$BACKUP/patterns.ts"
cp "$SCAN" "$BACKUP/rawValueScanner.ts"
cp "$DOM" "$BACKUP/domDetector.ts"
BEFORE=$(md5sum "$PAT" "$SCAN" "$DOM")

restore() {
  cp "$BACKUP/patterns.ts" "$PAT"
  cp "$BACKUP/rawValueScanner.ts" "$SCAN"
  cp "$BACKUP/domDetector.ts" "$DOM"
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
cur=json.loads(sys.argv[1]); cur.append({'mutant':sys.argv[2],'description':sys.argv[3],'caught':False,'note':'anchor miss'}); print(json.dumps(cur))" "$RESULTS" "$mutant" "$desc")
    return
  fi

  log="/tmp/phone_mutant_$mutant.log"
  npx vitest run tests/m8PhoneDetection.test.ts >"$log" 2>&1; code=$?
  # A mutant that does not COMPILE is not a test result. Counting it as
  # "survived" would silently understate the suite's strength, so it is
  # reported separately as INVALID and excluded from the score.
  if grep -qE "Transform failed|Syntax error|Failed Suites" "$log"; then
    echo "=== $mutant: INVALID MUTANT (does not compile) — not scored"
    RESULTS=$(python3 -c "
import json,sys
cur=json.loads(sys.argv[1]); cur.append({'mutant':sys.argv[2],'description':sys.argv[3],'caught':False,'invalid':True,'note':'mutation produced a compile error; not a behavioural result'}); print(json.dumps(cur))" "$RESULTS" "$mutant" "$desc")
    restore
    return
  fi
  summary=$(grep -E "^ +Tests +" "$log" | head -1)
  failed=$(echo "$summary" | sed -nE 's/.*Tests +([0-9]+) failed.*/\1/p'); [ -z "$failed" ] && failed=0
  passed=$(echo "$summary" | sed -nE 's/.*Tests +[0-9]+ failed.*\| *([0-9]+) passed.*/\1/p'); [ -z "$passed" ] && passed=0
  if [ "$code" -ne 0 ] && [ "$failed" -gt 0 ]; then caught=true; else caught=false; fi
  killed=$(grep -oE "^ +× .*" "$log" | sed -E 's/^ +× //;s/ [0-9]+ms$//' | head -4 | paste -sd ";" -)
  echo "=== $mutant (caught=$caught, failed=$failed) — $desc"
  [ -n "$killed" ] && echo "    killed-by: $killed"
  RESULTS=$(python3 -c "
import json,sys
cur=json.loads(sys.argv[1])
cur.append({'mutant':sys.argv[2],'description':sys.argv[3],'caught':sys.argv[4]=='true','failing_tests':int(sys.argv[5]),'passed_tests':int(sys.argv[6]),'killed_by':sys.argv[7]})
print(json.dumps(cur))" "$RESULTS" "$mutant" "$desc" "$caught" "$failed" "$passed" "$killed")
  restore
}

# ── P1: remove the CONTEXT gate (the core false-positive control) ───────────
run_mutant "P1" "remove the context gate: any bare 10-digit run is a phone" \
  "$PAT" \
  "    if (!PHONE_INTENT_WORD.test(before) && !PHONE_INTENT_WORD.test(after)) continue;" \
  "    if (false) continue;"

# ── P2: remove the NON-PHONE LABEL guard ───────────────────────────────────
run_mutant "P2" "remove the non-phone label guard: 'Product ID 1234567890' becomes a phone" \
  "$PAT" \
  "    if (label && NON_PHONE_LABEL_WORD.test(label)) continue;" \
  "    if (false && label && NON_PHONE_LABEL_WORD.test(label)) continue;"

# ── P3: loosen the digit-length requirement to ANY run ─────────────────────
run_mutant "P3" "loosen the digit-length requirement: match any 7+ digit run" \
  "$PAT" \
  "  for (const match of text.matchAll(/(?<![\\d-])(\\d{10})(?![\\d-])/g)) {" \
  "  for (const match of text.matchAll(/(?<![\\d-])(\\d{7,})(?![\\d-])/g)) {"

# ── P4: remove the digit boundary (split longer tokens) ────────────────────
run_mutant "P4" "remove the digit boundary: a 12-digit serial is split into a phone" \
  "$PAT" \
  "  for (const match of text.matchAll(/(?<![\\d-])(\\d{10})(?![\\d-])/g)) {" \
  "  for (const match of text.matchAll(/(\\d{10})/g)) {"

# ── P5: unwire the rule from the M8 raw-value scanner (egress firewall) ─────
run_mutant "P5" "unwire the contextual rule from the M8 raw-value scanner" \
  "$SCAN" \
  "  if (INDIAN_PHONE_RULE.test(text) || PATTERNS.PHONE.test(text) || hasContextualPhone(text)) {" \
  "  if (INDIAN_PHONE_RULE.test(text) || PATTERNS.PHONE.test(text)) {"

# ── P6: unwire the rule from the DOM detector (detection path) ─────────────
run_mutant "P6" "unwire the contextual rule from the DOM text detector" \
  "$DOM" \
  "      (PATTERNS.PHONE.test(text) || (text.length <= 60 && hasContextualPhone(\`\${context} \${text}\`))) &&" \
  "      PATTERNS.PHONE.test(text) &&"

# ── P7: restore the [6-9]-only behaviour (reintroduce the original gap) ────
run_mutant "P7" "restore the original [6-9]-only rule: the gap comes back" \
  "$PAT" \
  "export function hasContextualPhone(text: string | null | undefined): boolean {" \
  "export function hasContextualPhone(text: string | null | undefined): boolean { return false;"

# ── P8: bypass redaction by leaking the raw value in a violation ───────────
run_mutant "P8" "bypass redaction: record the raw value in the violation record" \
  "$SCAN" \
  "    violations.push({ path, rule });" \
  "    violations.push({ path: path + '=' + text, rule });"

restore
AFTER=$(md5sum "$PAT" "$SCAN" "$DOM")
if [ "$BEFORE" = "$AFTER" ]; then
  RESTORED=true
  echo "=== restore verified: sources byte-identical to pre-run state"
else
  RESTORED=false
  echo "=== RESTORE MISMATCH"
fi

python3 -c "
import json,sys
data=json.loads(sys.argv[1])
data.append({'restored_byte_identical': sys.argv[2]=='true'})
open('$OUT','w').write(json.dumps(data, indent=2) + '\n')
print('wrote $OUT')
" "$RESULTS" "$RESTORED"
