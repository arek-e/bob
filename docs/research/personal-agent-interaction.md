# Personal agent interaction research

Status: research synthesis
Updated: 2026-08-12

## Purpose

This note records the research basis for Bob's long-term product direction.

It covers interaction, personalization, proactive help, continuous improvement, and evaluation.

[`CONTEXT.md`](../../CONTEXT.md) remains authoritative for product terms and system invariants.

## Product conclusion

Bob should become a general personal continuity agent with bounded authority.

Generality applies to understanding, planning, and approved day-to-day capabilities.

Generality does not grant arbitrary computer access or self-approved permissions.

Bob can expand across calendars, tasks, email, travel, shopping, and other domains through optional
Capability Modules.

Each expansion must add reviewed Tools, an execution Adapter, policy, tests, audit records, and
recovery behavior at the owning Module.

The target is:

> General in understanding and planning. Broad but explicit in capability. Bounded in authority.

The domains used by the cited papers are evaluation environments. They do not define Bob's core
product or its default deployment profile.

## Interaction model

Bob should use a risk-based interaction policy.

1. Bob asks only when missing information can change the result.
2. Bob acts when the owner intent and action target are clear.
3. Bob asks before consequential or hard-to-reverse changes.
4. Bob states the exact result after a confirmed action.
5. Bob makes correction easier than the original request.
6. Bob learns preferences from explicit statements and post-action corrections.
7. Bob avoids irrelevant personalization and repeated personal references.
8. Bob acts proactively only from grounded signals and approved policies.

The private UI complements iMessage.

Use the UI for service setup, exact choices, review, recovery, and consequential approvals.

Do not require the UI for a clear and low-risk message request.

## Connector model

Connectors add capabilities. They do not give the model a generic remote API.

Expose semantic domain tools such as these examples:

- Find calendar events in a bounded time range.
- Read one calendar event.
- Create a local reminder linked to one event.
- Detect that a linked event moved or was deleted.

Do not expose a generic `call_connector` tool.

Bob should copy only required, policy-cleared connector data into source-backed local records.

A reminder linked to an event should keep the event source and the chosen offset.

Bob should create the local reminder before its due time.

Reminder delivery must not depend on a live connector request.

An event change should run a deterministic reconciliation policy.

The policy must state when Bob updates, asks, cancels, or keeps the existing reminder.

Connection revocation must stop new reads and writes.

## Research findings

### Continuous improvement

[Hyperagents](https://arxiv.org/abs/2603.19461) studies self-referential agents that modify their
task agent and improvement process.

[The public implementation](https://github.com/facebookresearch/hyperagents) includes evaluation
domains, experiment logs, performance tracking, and an archive of agent variants.

Bob should borrow the evaluation archive and measured candidate comparison.

Bob should not borrow live self-modification in production.

Production changes require review, safety gates, controlled release, and rollback.

### Personalization and feedback

[Learning Personalized Agents from Human Feedback](https://arxiv.org/abs/2602.16173) defines a
three-part loop:

1. Ask a pre-action question when an important preference is ambiguous.
2. Ground the action in explicit per-user memory.
3. Use post-action feedback to update a stale preference.

[The PAHF repository](https://github.com/facebookresearch/PAHF) provides code, personas, scenarios,
memory baselines, and four evaluation phases.

The four phases learn a preference, test it, change it, and test adaptation.

Bob should adapt this protocol to general preference tasks. A Vertical Module can add domain-specific
preference cases.

### Human control and trust

[Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/)
provides 18 validated design guidelines.

Relevant themes include expectation setting, efficient correction, user control, feedback, and
cautious adaptation.

[Plan-Then-Execute](https://arxiv.org/abs/2502.01390) studies daily assistant tasks with 248
participants.

Its results show that a plausible plan can still create misplaced trust.

User involvement helps with uncertain or risky execution.

Too much involvement adds cognitive load.

[The study repository](https://github.com/RichardHGL/CHI2025_Plan-then-Execute_LLMAgent) provides
the interface, experiment code, and analysis data.

Bob should ask based on risk and ambiguity instead of asking before every action.

### Interaction patterns

[Interaction-Augmented Instruction](https://arxiv.org/abs/2510.26069) defines 12 patterns that
combine language with structured interaction.

[Its public project](https://interaction-augmented-instruction.github.io/) includes the annotated
interface corpus.

Bob can use natural language in iMessage and precise controls in the private UI.

This combination is useful for target selection, connector setup, approval, and recovery.

### Long-term memory

Bob separates Owner memory from Agent experience.

Owner memory contains confirmed facts, preferences, corrections, and personal episodes. Agent
experience contains reviewed evidence about workflows, environment behavior, outcomes, and recurring
failures. They can share retrieval infrastructure, but they do not share promotion or authority rules.

The Retrieval pipeline keeps indexing, candidate retrieval, relevance checking, conflict handling,
and bounded reading as distinct stages.

[LongMemEval](https://arxiv.org/abs/2410.10813) evaluates five memory abilities:

- Information extraction
- Multi-session reasoning
- Knowledge updates
- Temporal reasoning
- Abstention

[The public benchmark](https://github.com/xiaowu0162/longmemeval) includes 500 questions, datasets,
retrieval metrics, and an answer evaluator.

Bob can use it through an adapter that replays synthetic sessions into Bob's memory system.

[LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) is also public.

It contains 451 questions over web and enterprise trajectory histories.

Its leaderboard measures answer accuracy and query latency through LAFS gain.

[OP-Bench](https://arxiv.org/abs/2601.13722) defines three over-personalization failures:

- Irrelevance
- Repetition
- Sycophancy

The paper describes 1,700 reviewed cases.

No official public dataset or runner was found on 2026-08-12.

Bob can use the failure categories now and add the public cases if the authors release them.

### Proactive assistance

[π-Bench](https://arxiv.org/abs/2605.14678) evaluates hidden intent, dependencies, and
cross-session continuity.

[Its public benchmark](https://github.com/Simplified-Reasoning/Pi-Bench) provides 100 multi-turn
tasks, a container environment, scoring, and a leaderboard.

The full benchmark assumes a broad workspace agent.

Bob should adapt its scenario structure instead of copying its full authority model.

[Need Help?](https://www.microsoft.com/en-us/research/publication/need-help-designing-proactive-ai-assistants-for-programming/)
studies the timing and form of proactive suggestions.

[Sensible Agent](https://research.google/pubs/sensible-agent-a-framework-for-unobtrusive-interaction-with-proactive-ar-agent/)
separates what help to offer from how to deliver it.

Bob should evaluate usefulness and interruption cost as separate outcomes.

## Public evaluation use

The research artifacts have different levels of direct value.

| Artifact                          | Public evaluation       | Direct Bob comparison | Intended use                                         |
| --------------------------------- | ----------------------- | --------------------- | ---------------------------------------------------- |
| LongMemEval                       | Yes                     | High                  | Run memory and abstention tests through an adapter.  |
| LongMemEval-V2                    | Yes                     | High                  | Evaluate memory over agent trajectory histories.     |
| PAHF                              | Yes                     | Medium                | Adapt its preference and preference-change protocol. |
| π-Bench                           | Yes                     | Low                   | Reuse its long-horizon scenario structure.           |
| Plan-Then-Execute                 | Study code and data     | Low                   | Reuse its human-control experiment design.           |
| Hyperagents                       | Code, domains, and logs | No                    | Reuse its candidate archive and evaluation loop.     |
| OP-Bench                          | Paper describes cases   | Pending               | Use its failure taxonomy until data is public.       |
| Human-AI Guidelines               | Review framework        | No                    | Use as a qualitative product checklist.              |
| Interaction-Augmented Instruction | Annotated corpus        | No                    | Use as an interaction design vocabulary.             |

Published scores are comparable only when Bob runs the original task and evaluator.

An adapted scenario can guide Bob's design, but it does not produce a comparable leaderboard score.

The benchmark catalog records public availability, official metrics, and adapter status.

The result ledger starts empty and accepts only revision-pinned reproducible runs.

## Bob evaluation plan

### External benchmark adapter

Add a LongMemEval adapter first.

The adapter should use synthetic benchmark content only.

It should measure retrieval and final answer quality separately.

It should report results for all five memory abilities.

### Bob-native longitudinal suite

Use PAHF's four phases for owner preferences:

1. Learn the initial preference.
2. Test the initial preference on new tasks.
3. Receive an explicit preference change.
4. Test adaptation without stale preference use.

Use π-Bench-style episodes for general multi-turn work. Vertical evaluation packs can add reminder
and connection episodes.

Each episode should include an underspecified request, a hidden requirement, and a final task result.

### Core scenario families

- Preference cold start, confirmation, change, conflict, relevance, and abstention
- Retrieval across sessions, temporal updates, source grounding, and invalid premises
- Useful proactive help, missed help, unnecessary interruption, and correct silence
- Action evidence, unknown outcomes, duplicate prevention, correction, and cancellation

### Vertical scenario families

- Reminder ambiguity, daylight saving time, recurrence, correction, and acknowledgment
- Calendar event selection, movement, deletion, stale sync, and revoked access
- Training safety and domain record transitions

### Metrics

- Task completion rate
- Safety pass rate
- Tool selection and argument accuracy
- Retrieval recall and precision
- Clarification precision and recall
- Correction recovery turns
- Preference-change recovery rate
- Stale preference use rate
- Proactive precision and recall
- Unnecessary interruption rate
- Connector-grounded action rate
- Unknown-outcome disclosure rate
- Undo and cancellation success rate

Clarification precision measures whether each question was necessary.

Clarification recall measures whether Bob asked when missing information could change the result.

Proactive precision measures how often an intervention was useful.

Proactive recall measures how often Bob surfaced an approved and useful need.

## Continuous improvement loop

1. Record content-free outcome metrics and private review references.
2. Review failures with explicit owner access.
3. Rewrite each useful failure as a synthetic evaluation case.
4. Compare one candidate change with the current release.
5. Require deterministic safety checks and judged interaction checks.
6. Release one controlled change through a canary.
7. Promote or roll back from measured results.

Do not copy owner messages into the repository or public evaluation data.

Do not let an evaluation candidate change production code or policy without review.

## Implemented agent harness changes

The live Pi harness now applies the research interaction model.

- It asks one question only when a missing detail can change the result.
- It does not retry a tool after `confirmation_required` or `choice_required`.
- It gives the model one tool-free turn to ask for the missing input.
- It discloses an unknown external outcome without retrying the write.
- It treats explicit preference feedback as eligible for a reviewable memory proposal.
- It does not confirm the proposed preference automatically.
- It tells the model to use preferences only when they affect the current result.
- It gives the final owner correction priority over stale context.

Core domain policy still decides whether each action can run.

The model cannot weaken this policy through its prompt or response.

Bob does not use a proactive model run yet.

Proactive work must start with approved signals, quiet hours, and interruption limits.

## Implemented retrieval pipeline

Bob now uses one domain-neutral Retrieval Module.

Source Modules publish policy-cleared, record-level projections. The index stores search text,
source identity, memory class, content identity, occurrence time, validity, and conflict identity.

The pipeline analyzes the query before it reads records. It resolves supported absolute and relative
dates in the owner's time zone. It retrieves a bounded candidate set and applies a minimum relevance
threshold before importance or recency can affect order.

Normal fact correction closes the old validity interval. It does not delete the old projection.
Current retrieval excludes the old value. A supported historical query can still retrieve it.

Overlapping active values for one conflict identity form one conflict group. The reader includes the
complete group or omits it. It never slices a recalled claim.

The pipeline returns typed abstention for missing query signals, missing candidates, policy removal,
low relevance, and exhausted reading budgets. Backend failure remains an error.

## Proactive harness roadmap

Proactive work is an inter-turn agent path.

An owner message starts the current agent path. An approved signal starts the proactive path.

Each signal must contain these fields:

- A stable signal identifier and type
- The approved source and supporting record identifiers
- The observation time and expiry time
- The owner policy that permits evaluation

The proactive harness should use this sequence:

1. Store the signal with an idempotency key.
2. Reject an unapproved, expired, stale, or revoked signal.
3. Apply quiet hours, rate limits, and duplicate suppression.
4. Build a small context pack from approved evidence.
5. Run a bounded model turn to decide what help to offer.
6. Apply domain policy to the proposed intervention.
7. Deliver one short message or record correct silence.
8. Record the receipt, owner response, and interruption outcome.

The model must not choose when it can run or which signals it can inspect.

The model can prepare a message after deterministic policy permits the run.

A proactive message can offer a reversible action. It cannot approve a consequential action.

### Rollout stages

1. Run one signal family in shadow mode without owner delivery.
2. Review usefulness, missed help, and false interruption results.
3. Enable owner opt-in with quiet hours and a strict message limit.
4. Start with calendar changes or conflicts backed by current connector records.
5. Add signal families only after the prior family meets its release checks.

### Release checks

- One signal cannot produce duplicate messages.
- Revoked access stops evaluation and delivery.
- Expired or stale evidence produces correct silence.
- Quiet hours defer delivery.
- The message identifies the event or source that caused it.
- Owner dismissal does not create a durable preference without explicit feedback.
- Consequential follow-up work requires owner confirmation.
- Proactive precision and unnecessary interruption rate meet the release target.

Need Help? guides interruption timing and delivery form.

Sensible Agent guides the separate decisions about what help to offer and how to deliver it.

π-Bench guides multi-session scenarios with hidden needs and changing dependencies.

## Implemented evaluation foundation

Version 1 contains 11 synthetic cases.

It covers reminder dates, memory grounding, stale retrieval, tool selection, prompt injection,
structured output, and training safety.

Version 2 adds 12 synthetic interaction cases.

It covers these outcomes:

- Necessary and unnecessary clarification
- One-turn correction recovery
- Preference changes and stale preference rejection
- Useful proactive help and correct silence
- Connector evidence and revoked access
- Unknown connector outcomes
- Undo, cancellation, and duplicate prevention

The root offline gate runs both suites.

The root gate also validates the public benchmark catalog and result ledger.

Four public benchmarks are ready for score tracking. No Bob score is recorded before an official run.

Remaining work includes longer episodes and real adapters for public benchmarks.

Later cases should cover recurrence, event movement, deletion, stale sync, and preference cold start.
