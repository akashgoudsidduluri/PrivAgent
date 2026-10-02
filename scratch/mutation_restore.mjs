/**
 * Recover production source from a mutation run that was killed untrappably.
 *
 * A Step 8 mutation run was killed by a harness timeout mid-edit and left a
 * MUTANT committed to `goalProgressTracker.ts`:
 *
 *     result.kind === 'MATCH' || result.kind === 'MISMATCH'
 *
 * Signal handlers cannot fix that case, because SIGKILL/SIGABRT cannot be
 * trapped. The mutation runners therefore persist a pristine backup to
 * `scratch/.mutation_backup/` BEFORE their first edit, and recover from it
 * automatically on their next start. This tool is the on-demand equivalent:
 *
 *     node scratch/mutation_restore.mjs
 *
 * It is idempotent and safe to run at any time.
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const BACKUP_DIR = path.resolve(process.cwd(), 'scratch/.mutation_backup');
const BACKUP_MANIFEST = path.join(BACKUP_DIR, 'manifest.json');

if (!existsSync(BACKUP_MANIFEST)) {
  console.log('[MUT-RESTORE] no mutation backup found — production source is clean.');
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(BACKUP_MANIFEST, 'utf8'));
const restored = [];
for (const [file, backup] of Object.entries(manifest)) {
  if (!existsSync(backup)) continue;
  writeFileSync(file, readFileSync(backup, 'utf8'));
  restored.push(file);
}
rmSync(BACKUP_DIR, { recursive: true, force: true });

console.log(`[MUT-RESTORE] restored ${restored.length} file(s) from the mutation backup:`);
for (const f of restored) console.log(`  ${path.relative(process.cwd(), f)}`);