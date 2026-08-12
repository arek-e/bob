import { readFile, stat } from "node:fs/promises"

import type { BenchmarkCatalog, BenchmarkRunLedger } from "./benchmark-tracking.ts"
import type { CandidateSet, EvaluationSuite } from "./gate.ts"

import { decodeBenchmarkCatalog, decodeBenchmarkRunLedger } from "./benchmark-tracking.ts"
import { decodeCandidateSet, decodeEvaluationSuite } from "./schemas.ts"

const MAX_EVALUATION_FILE_BYTES = 1_000_000

async function readJson(path: string | URL): Promise<unknown> {
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new Error("evaluation_input_not_a_file")
  if (metadata.size > MAX_EVALUATION_FILE_BYTES) throw new Error("evaluation_input_too_large")
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("evaluation_input_invalid_json")
    throw error
  }
}

export async function loadEvaluationInputs(
  suitePath: string | URL,
  candidatePath: string | URL
): Promise<{ readonly suite: EvaluationSuite; readonly candidates: CandidateSet }> {
  const [suite, candidates] = await Promise.all([readJson(suitePath), readJson(candidatePath)])
  return {
    suite: decodeEvaluationSuite(suite),
    candidates: decodeCandidateSet(candidates)
  }
}

export async function loadEvaluationSuite(path: string | URL): Promise<EvaluationSuite> {
  return decodeEvaluationSuite(await readJson(path))
}

export async function loadCandidateSet(path: string | URL): Promise<CandidateSet> {
  return decodeCandidateSet(await readJson(path))
}

export async function loadBenchmarkCatalog(path: string | URL): Promise<BenchmarkCatalog> {
  return decodeBenchmarkCatalog(await readJson(path))
}

export async function loadBenchmarkRunLedger(path: string | URL): Promise<BenchmarkRunLedger> {
  return decodeBenchmarkRunLedger(await readJson(path))
}
