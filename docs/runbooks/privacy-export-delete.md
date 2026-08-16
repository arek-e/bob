# Privacy, export, and deletion runbook

## Journal handling

Keep raw journal text in the Better Auth-protected UI.

Do not send raw journal text through Sendblue or Pi.

Plain exports exclude journal text by default.

## Delete one journal entry

Open the private journal list. Select **Delete entry** and confirm the consequence.

The API replaces encrypted text with a tombstone. It clears tags and approved summaries.

The same Application Storage transaction removes search documents, candidates, and fact evidence.

Verify the entry cannot open. Verify search returns no derived result.

## Export

Export primary tables without FTS virtual tables. Include schema versions and stable identifiers.

Include source identifiers and content hashes in Obsidian-compatible Markdown.

Require a second confirmation before a full encrypted export.

Do not implement reverse import from exported Markdown.

## Delete all owner data

Full owner deletion remains a Milestone 4 gate. Do not claim it is complete.

Delete primary content, Object Storage objects, search data, vectors, candidates, and evidence.

Keep only redacted operational audit data. Set backup expiry for the deleted data.
