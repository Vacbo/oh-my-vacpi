Find a loaded skill by describing the capability you need.

Skills matching `skills.pinnedSkills` stay listed in the system prompt; the remaining {{discoverableSkillCount}} are loaded but unlisted, so this tool is how you find them.

Input:

- `query` — required natural-language or keyword description of the capability
- `limit` — optional maximum number of matches (default `8`)

Behavior:

- Ranks skill name, description, and SKILL.md body text against the query
- Returns matches only — no tool is activated and the toolset never changes
- Each match carries a `skill://<name>` URI; `read` it to load the skill's instructions

Notes:

- Describe the task ("make my writing sound less like an AI wrote it"), not a guessed skill name.
- Start with `limit` 5–10 if unsure.

Not for repository, file, or code search.

Returns JSON with:

- `query`
- `skills` — matches as `{name, description, read}`
- `match_count`
- `total_skills` — unlisted skills searched
