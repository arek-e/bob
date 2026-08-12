# Public benchmark tracking

This directory tracks Bob results from official public benchmark protocols.

It does not contain benchmark datasets or copied owner data.

`catalog.json` records availability, official metrics, and adapter status.

`results.json` records reviewed, reproducible milestone runs. It starts empty by design.

Cloudflare stores continuous run data in two private resources:

- D1 database `bob-evals-prod` stores run state, scores, and artifact metadata.
- R2 bucket `bob-eval-artifacts-prod` stores raw and evaluator artifacts.

The production assistant Worker cannot access these resources.

The future evaluation runner will receive private bindings to both resources.

Run the tracker:

```sh
pnpm --filter @bob/agent-evals eval:benchmarks
```

## Recording rules

- Use the official dataset and evaluator without task changes.
- Pin the benchmark repository to a complete Git revision.
- Record Bob's complete Git revision.
- Record the dataset, adapter, model, evaluator, variant, and sample count.
- Store each raw artifact under `runs/<benchmark>/<run>/<sha256>/<file>` in R2.
- Record the manifest key and SHA-256 digest in the reviewed Git ledger.
- Do not overwrite an existing artifact key.
- Mirror an official dataset only when its license permits redistribution.
- Never store credentials, owner messages, or private connector data.
- Mark changed tasks or evaluators as `adapted`.
- Do not compare adapted scores with official leaderboard scores.

No score means `not_run`. Never use a paper baseline as a Bob result.

## Source of truth

- Git owns the catalog and reviewed milestone scores.
- D1 owns continuous run state and metric history.
- R2 owns immutable public or synthetic run artifacts.
- Langfuse can receive redacted traces. It is not authoritative storage.
