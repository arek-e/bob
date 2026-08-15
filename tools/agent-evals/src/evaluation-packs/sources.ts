const repositoryRoot = new URL("../../../../", import.meta.url)

export const version1Source = {
  suite: new URL("evals/scenarios/v1/golden-cases.json", repositoryRoot),
  candidates: new URL("evals/fixtures/v1/offline-candidates.json", repositoryRoot)
}

export const version2Source = {
  suite: new URL("evals/scenarios/v2/interaction-cases.json", repositoryRoot),
  candidates: new URL("evals/fixtures/v2/offline-candidates.json", repositoryRoot)
}
