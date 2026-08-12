# ADR 0011: Evaluation records and artifacts

Status: Accepted
Date: 2026-08-12

## Context

Bob needs continuous evaluation history without depending on one laptop.

Git works well for reviewed benchmark definitions and milestone scores.

Git does not work well for large or frequent run artifacts.

Bob's application database and private object bucket contain owner data.

Evaluation infrastructure must not gain access to that data.

## Decision

Alchemy creates one dedicated D1 database named `bob-evals-prod`.

This database stores run state, score values, and artifact metadata.

Alchemy creates one private R2 bucket named `bob-eval-artifacts-prod`.

This bucket stores content-addressed public or synthetic run artifacts.

Artifact keys use `runs/<benchmark>/<run>/<sha256>/<file>`.

Git remains authoritative for benchmark definitions and reviewed milestone scores.

The production assistant Workers receive no evaluation storage bindings.

A future evaluation runner will receive scoped D1 and R2 bindings.

Langfuse can receive redacted traces for analysis. It is not authoritative storage.

## Consequences

Continuous runs can execute without an open laptop.

Raw artifacts do not increase repository size.

Content hashes make reviewed results verifiable.

The evaluation runner cannot read owner messages or private objects.

Cloudflare deployment creates two additional retained resources.

The storage foundation does not schedule or execute evaluation runs.
