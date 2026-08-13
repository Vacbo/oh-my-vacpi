Search long-term memory; return raw relevance-ranked matching entries.

Use proactively before questions about past conversations, user preferences, project decisions, or topics where prior context improves accuracy. When in doubt, recall first.

`recall`: specific facts or entries. `reflect`: synthesized answer across many memories.

Optional `tags` narrow results by memory tag. Use `tagsMatch: "all"` when every tag must match; use `"any"` when any supplied tag is sufficient.

Results: content preview. Trailing `…`: truncation (`truncated: true`; `full_length`: original size). Before any `memory_edit update`, MUST fetch full row: `read memory://<id>`.
