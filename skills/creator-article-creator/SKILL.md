---
name: creator-article-creator
description: Draft and revise a structured, illustrated Creator Studio article in the requested language and platform style, preserving evidence and immutable versions.
---

Require creator_article. Use the user's audience, language, subject and length request. The plugin exports portable HTML and Markdown; platform-specific editor behavior still needs verification.

- Supply title, summary, language, platform, blocks, sources, claims and assets using the tool schema. Blocks are heading, paragraph, list, code or image. Text fields contain literal text, not HTML or Markdown formatting.
- Preserve the research brief's evidence access limits in source excerpts and, when material to the reader's conclusions, in the article. User-provided material is not independently fetched evidence; checkedAt records its actual inspection time. Do not claim live verification or current prices from an unopened link.
- Explain an actionable use case, its limitations, how a reader can verify the result and relevant costs. Keep unsupported conclusions out of the article.
- Use only authorized host tools to capture public pages or create illustrations. Import real local PNG/JPEG/WebP files from configured assetRoots. Screenshots require sourceId and actual capturedAt; illustrations must remain distinguishable from observed results. A cover does not satisfy the default body-image requirement.
- Create with a stable topicKey. For native scheduled runs, provide a stable runKey for that job and date, then resume the returned article rather than creating another one on retry.
- Revise with the exact articleId and current version. Reuse asset input paths when supplying the revised document; exported asset filenames are not import paths. Changes create a new version and invalidate prior approval.
- Use creator_review for the completed version, then creator-editorial-review for submission. Limit automatic revision loops to two rounds or the operator's lower limit. Do not change a title or invent a new version to evade a review quota.

Do not edit plugin databases or sealed assets through filesystem tools. Never fabricate execution evidence, source verification times, approval, delivery receipts or publication status.
