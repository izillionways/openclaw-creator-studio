---
name: creator-editorial-review
description: Submit an exact Creator Studio article version to isolated editorial review and hand successful drafts to a human without granting publication authority.
---

Call creator_review with the exact articleId and version. Its independent completion receives the sealed article and evidence rather than the writer's conversation. The operator must enable model calls and select an explicit supported runtime.

Check the returned deterministic findings and independent verdict. Material factual gaps, invented tests/results, misleading source use or unmarked illustrations block submission. Missing or malformed review results, unsupported isolation, cancellation and stale versions are failures, not implicit approval.

When revisions are needed, return specific findings to the writer, preserve the article ID, and review the new version. A rejected article stays closed until a configured human uses /creator revise with an exact version and reason.

After both checks pass, call creator_submit. It returns the configured private preview and sends a notification only if the operator enabled a fixed destination. A notification state of unknown must not be automatically retried; ask the owner to inspect that destination and exact version.

Human decisions use /creator approve, /creator reject or /creator revise with the article ID and version. The plugin validates the channel's real sender/account metadata and its approver list. Never impersonate the owner, ask another model to approve, or write an approval into storage.

Only creator_export produces a final package after human approval. The person imports it into their chosen platform and publishes manually. Only their /creator published command can confirm publication; a passed review, successful notification or exported file is not publication evidence.
