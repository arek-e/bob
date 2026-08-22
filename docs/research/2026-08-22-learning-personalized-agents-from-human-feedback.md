# Research note: Learning Personalized Agents from Human Feedback

Date: 2026-08-22  
Status: Research note; not an architecture decision

Primary source: [Liang et al., “Learning Personalized Agents from Human Feedback,” arXiv:2602.16173v1](https://arxiv.org/html/2602.16173v1). The paper was published on 2026-02-18. The paper links to the [public PAHF implementation](https://github.com/facebookresearch/PAHF). The implementation is useful for call sequencing, but it can differ from the paper.

## Summary

PAHF is a continual personalization loop. It combines explicit per-user memory with two feedback channels:

1. Ask a focused question before an action when the agent lacks enough information.
2. Use retrieved preferences to select and execute the action.
3. Use owner feedback after an incorrect action to revise stale memory.

The paper reports that the channels solve different problems. Pre-action clarification reduces initial errors. Post-action feedback corrects confident but stale preferences. PAHF combines both channels and performs best in the paper's simulated tasks.

The paper does not define production response latency, streaming, delivery receipts, or a user-facing acknowledgment protocol. The public implementation is a synchronous command-line study. It waits for each model call and memory update. Bob therefore needs its own durable interaction state and acknowledgment design.

## Interaction and agent design

The logical loop is:

```text
owner turn
  -> retrieve relevant preference memory
  -> if ambiguous, ask one pre-action question and write the answer
  -> select and execute an action
  -> if the outcome is wrong, accept post-action feedback
  -> detect, summarize, and merge or add the preference
  -> next owner turn
```

The paper formalizes the loop as pre-action interaction, action execution, and post-action feedback integration. Pre-action feedback is written before the action. Post-action feedback is used to correct miscalibration after the outcome. If there is no post-action feedback, or the feedback has no personalized information, memory carries forward unchanged. See [§3.2 of the paper](https://arxiv.org/html/2602.16173v1) and the [paper's implementation description](https://arxiv.org/html/2602.16173v1).

The agent uses a ReAct-style model loop. The paper reports GPT-4o as the default agent model. The public prompts require a `Thought` and an `Action`; the action is an option letter or `Ask human`. The paper limits disambiguation to one clarification question per task, and the shopping prompt states the same rule. See [the paper's implementation section](https://arxiv.org/html/2602.16173v1), the [embodied prompt](https://github.com/facebookresearch/PAHF/blob/main/prompts/embodied_prompts.py#L120-L206), and the [shopping prompt](https://github.com/facebookresearch/PAHF/blob/main/prompts/shopping_prompts.py#L98-L111).

The public base agent follows this sequence:

- Retrieve memory and ask a model to summarize the relevant context.
- Generate an action.
- If the action is `Ask human`, generate a short question.
- Add the answer to memory, then generate the action again.
- Generate post-action feedback.
- Ask a model whether the feedback is personalized.
- Summarize salient feedback and update or add a memory entry.

See [the base helper](https://github.com/facebookresearch/PAHF/blob/main/agents/base.py#L40-L132) and the [embodied run loop](https://github.com/facebookresearch/PAHF/blob/main/agents/embodied_agent.py#L174-L305). This is a study harness. It is not a production action-authority model.

## Response timing

### Logical timing

The paper gives ordering rules, not latency targets:

- Retrieval precedes action selection.
- A clarification answer is consumed before action selection.
- Post-action feedback arrives after the user observes the result.
- Under the paper's theoretical assumptions, an immediate post-action update after the first error following a preference switch limits the errors caused by that switch.

The paper's evaluation uses success rate, feedback frequency, and average cumulative personalization error. It does not report time to first response, time to clarification, model latency, streaming behavior, action timeout, delivery delay, or retry budgets. See [§4.2](https://arxiv.org/html/2602.16173v1) and [§3.3](https://arxiv.org/html/2602.16173v1).

### Runtime timing in the public implementation

The public `LLMClient.generate` calls the chat completion API synchronously. It does not request streaming or set an application timeout. It retries up to five times. General errors wait 2, 4, 6, and 8 seconds. Rate-limit errors wait 5, 10, 15, and 20 seconds. These waits are implementation details, not response-time guarantees. See [`utils/llm.py`](https://github.com/facebookresearch/PAHF/blob/main/utils/llm.py#L57-L130).

One task can make several serial model calls. The optional path includes retrieval summarization, initial action selection, question generation, simulated owner answer, second action selection, post-action feedback, salience detection, feedback summarization, update detection, similarity lookup, and note merging. The code has no owner-facing progress event or run deadline around this sequence. See the [embodied run loop](https://github.com/facebookresearch/PAHF/blob/main/agents/embodied_agent.py#L174-L305).

## Acknowledgment UX

PAHF has no distinct acknowledgment UX.

- The pre-action question is an interaction interrupt, not a receipt that the turn was accepted.
- The `Question: ...` and `Human: ...` strings are an internal simulator protocol.
- Post-action feedback evaluates the outcome. It is not a delivery receipt.
- The code records `pre_feedback`, `post_feedback`, and `human_feedback` in test data. It does not send a receipt, progress update, memory-write confirmation, cancellation control, or unknown-result message.

This absence matters for Bob. An owner can wait while a model call, external action, retry, or delivery attempt runs. Bob should expose separate states for:

1. Turn accepted and queued.
2. Clarification required.
3. Action in progress.
4. Action completed, failed, or has an unknown result.
5. Preference feedback received and either recorded or held as a candidate.

These states fit Bob's durable Agent Run and Delivery boundaries. They should not be inferred from a model reply. See [Bob's context](../../CONTEXT.md) and [ADR 0003](../adr/0003-shared-runtime-clusters-and-agent-runs.md).

## Context and memory

The paper deliberately uses a simple memory design so that it can measure feedback channels:

- Each user has an isolated memory.
- Each memory item is a short natural-language note with an embedding.
- Retrieval uses the instruction and observation as the query and returns a small ranked set.
- A lightweight extraction step reduces the retrieved notes to task-relevant cues before action selection.
- Salient feedback is summarized into a note.
- Similarity decides whether to replace an existing note or add a new note.

See [§3.4 of the paper](https://arxiv.org/html/2602.16173v1) and the [public memory interface](https://github.com/facebookresearch/PAHF/blob/main/memory/banks.py#L97-L143). The public implementation has SQLite and FAISS backends. The SQLite schema includes a `person_id`, and the FAISS index keeps person identifiers with the stored documents. See the [SQLite implementation](https://github.com/facebookresearch/PAHF/blob/main/memory/banks.py#L143-L390) and the [project README](https://github.com/facebookresearch/PAHF#memory-system).

The paper explicitly tests context-dependent preferences. A global note can be confidently wrong when time, location, mood, health, or another state changes. Post-action feedback is the correction path for this error. The paper also states that its memory does not solve noisy or contradictory feedback. See [the context-dependent preference discussion](https://arxiv.org/html/2602.16173v1) and [Appendix B](https://arxiv.org/html/2602.16173v1).

For Bob, the important pattern is the read-before-action and explicit-correction loop. The PAHF note store should not become Bob's authoritative memory model. Bob's [context](../../CONTEXT.md) requires owner-scoped data, confirmed owner memory, evidence, bounded Context packs, conflict handling, and no silent promotion of inferred preferences. An LLM salience detector can propose a memory candidate. It cannot by itself confirm a fact or grant action authority.

## Evidence from the evaluation

The paper evaluates 40 embodied users with 30 scenarios per phase and 20 shopping users with 45 scenarios per phase. It separates initial learning from adaptation to a changed persona. The test-phase success rates are:

| Method            | Embodied Phase 2 | Embodied Phase 4 | Shopping Phase 2 | Shopping Phase 4 |
| ----------------- | ---------------: | ---------------: | ---------------: | ---------------: |
| No memory         |            32.3% |            44.8% |            27.8% |            27.0% |
| Pre-action only   |            54.1% |            35.7% |            34.4% |            56.0% |
| Post-action only  |            67.9% |            68.3% |            38.9% |            66.9% |
| PAHF (pre + post) |        **70.5%** |        **68.8%** |        **41.3%** |        **70.3%** |

The pattern supports a two-channel design. Pre-action feedback gives a better initial result. Pre-action alone becomes stale after a preference shift. Post-action feedback adapts after an error, but it makes the owner pay for that error. PAHF has the highest reported success rate in these test phases. See [Table 1 and the results discussion](https://arxiv.org/html/2602.16173v1).

The result is not a production guarantee. The users are simulated, the feedback is sparse, the memory is simple, and the paper limits disambiguation to one question. The authors identify noisy feedback, memory architecture, reasoning quality, and multi-turn clarification as open limitations. See [Appendix B](https://arxiv.org/html/2602.16173v1).

## Implications for Bob Runtime

### Adopt the interaction pattern

- Retrieve a bounded, policy-cleared Context pack before action selection.
- Ask one focused clarification question when owner intent or a preference is ambiguous.
- Resume the same turn revision after the owner answers. Do not create a new unrelated turn.
- After an external action, accept a correction and link it to the action attempt and outcome.
- Use post-action correction to detect stale preferences. Do not rely only on pre-action uncertainty detection.

### Preserve Bob's authority and memory rules

- Treat a preference as context, not as Tool authority. A stored preference cannot approve a consequential or ambiguous action.
- Store explicit clarification answers and corrections with source, owner scope, context, and evidence. Keep inferred notes as candidates until Bob's memory rules confirm them.
- Prefer append-only fact revisions or conflict groups over destructive note replacement. Preserve the old preference so Bob can explain and correct a stale update.
- Let `ContextStore` own retrieval budgets, deduplication, precedence, and final Context pack assembly. Do not let the model or a vector backend choose the complete context.
- Keep one immutable Context pack for each Agent Run. A later feedback update belongs to a later run or an explicit reflection revision.

### Add durable response states

PAHF assumes a synchronous study loop. Bob's channel and shared-cluster design needs durable boundaries:

1. Accept the owner turn and send a short receipt when work is queued.
2. If clarification is needed, persist a waiting state and an expiring short-reply binding.
3. Send a distinct progress or completion message for a consequential external action.
4. Record success, failure, or unknown external result before final delivery.
5. Report a preference update only when the owner gave explicit feedback and the memory write completed. Otherwise state that the feedback is pending review or remains a candidate.

The receipt and final answer are different events. A receipt must not imply that an external action completed. See [Bob's delivery and authority rules](../../CONTEXT.md) and [ADR 0003's submission, execution, and finalization phases](../adr/0003-shared-runtime-clusters-and-agent-runs.md).

### Define Bob-specific timing and evaluation

PAHF supplies no latency target. Bob should define and measure its own content-free timing fields:

- turn accepted and receipt delivered;
- clarification question delivered;
- owner answer accepted;
- Agent Run started and completed;
- external action started and outcome recorded;
- final reply delivered or delivery recovery started.

Use these timings with bounded retries, leases, checkpoints, and outboxes. Evaluate more than task success: measure clarification burden, initial error rate, stale-preference recovery, correction rate, memory conflicts, unknown outcomes, and delivery latency. Keep telemetry content-free as required by Bob's observability rules.

### Keep the owner experience short and correctable

The useful UX lesson is a focused question before a risky guess and a clear correction path after an incorrect result. Bob should avoid exposing the public prompt's detailed `Thought` field. Show the owner the question, action status, result, and correction or undo control that the domain supports. This follows Bob's requirement that the system remain predictable and easy to correct.

## Open questions for a Bob design

- Which preference changes require immediate owner confirmation before they become confirmed memory?
- How should Bob represent a context-specific preference when it conflicts with a global preference?
- What is the maximum owner wait for a clarification run before it expires or is cancelled?
- Which action outcomes can trigger automatic correction, and which require explicit approval?
- How should Bob detect contradictory or mistaken owner feedback without silently choosing one revision?
- Which timing and burden metrics should become deployment-level acceptance criteria?
