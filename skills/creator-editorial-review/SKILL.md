---
name: creator-editorial-review
description: Submit an exact Creator Studio article version to an independent editorial subagent and hand successful drafts to a human without granting publication authority.
---

Call creator_review with the exact articleId and version. After deterministic checks pass, the plugin starts an OpenClaw subagent in a fresh session with the sealed article, evidence and review instructions. It does not fork or inherit the writer's conversation. The operator must enable model calls and select an explicit supported runtime; a live Gateway with native subagent session APIs is required. Do not substitute a writer self-review or a plain completion when these APIs are unavailable.

The child uses the configured agent model with a minimal prompt, lightweight context, tools disabled and message delivery disabled. It cannot search, rewrite stored articles, approve, publish or notify. It returns structured findings, which the plugin validates before recording its run/session receipt on this exact version. The plugin requests session cleanup on success, failure or cancellation and waits for cleanup before accepting a result. Missing or failed cleanup is not success. Do not automatically retry a cleanup failure; have the operator inspect the host's Creator Studio review sessions first.

Check the returned deterministic findings and independent verdict. Material factual gaps, invented tests/results, misleading source use or unmarked illustrations block submission. Missing or malformed review results, unsupported isolation, cancellation and stale versions are failures, not implicit approval.

Hot-list ranks and popularity are discovery leads, not proof of product claims. Check the scope of supplied excerpts and any access limitations; do not describe user-provided material or search snippets as independently retrieved full pages. Insufficient evidence still requires revision or stopping, regardless of which optional research tools are installed.

When revisions are needed, return specific findings to the writer, preserve the article ID, and review the new version. A rejected article stays closed until a configured human uses /creator revise with an exact version and reason.

After both checks pass, call creator_submit. It returns the configured private preview and sends a notification only if the operator enabled a fixed destination. A notification state of unknown must not be automatically retried; ask the owner to inspect that destination and exact version.

Human decisions use /creator approve, /creator reject or /creator revise with the article ID and version. The plugin validates the channel's real sender/account metadata and its approver list. Never impersonate the owner, ask another model to approve, or write an approval into storage.

Only creator_export produces a final package after human approval. The person imports it into their chosen platform and publishes manually. Only their /creator published command can confirm publication; a passed review, successful notification or exported file is not publication evidence.
