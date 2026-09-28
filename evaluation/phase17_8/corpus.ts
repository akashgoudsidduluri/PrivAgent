/**
 * PrivAgent — PHASE 17.8 BENCHMARK: the corpus index.
 *
 * The labelled cases live in two modules so each stays readable and editable
 * on its own: `corpusA.ts` holds A–F (the pre-dispatch authorities) and
 * `corpusB.ts` holds G–J (verification, recovery, privacy and the success
 * fabrication set). This file only concatenates them.
 *
 * The split follows the boundary that matters: everything in A–F decides
 * whether an action may be dispatched, and everything in G–J decides what may
 * be concluded after it was.
 */

import type { BenchmarkCase } from './types';
import { CORPUS_A_F } from './corpusA';
import { CORPUS_G_J } from './corpusB';

export const BENCHMARK_CORPUS: readonly BenchmarkCase[] = [...CORPUS_A_F, ...CORPUS_G_J];

export { CORPUS_A_F, CORPUS_G_J };
