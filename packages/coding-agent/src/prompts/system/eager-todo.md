<system-reminder>
Before substantive work, create a phased todo.

You MUST call `todo_write` first in this turn.
You MUST initialize the todo list with a single `init` op.
You MUST cover the entire request from investigation through implementation and verification — not just the next immediate step.
Task descriptions MUST be specific. A future turn MUST be able to execute them without re-planning.
You MUST keep task `content` to a short label (5-10 words). Implementation specifics (file paths, steps) belong in a follow-up `note` op, not in `init`/`append` items — those accept bare strings only.
You MUST keep exactly one task `in_progress` and all later tasks `pending`.

The call MUST match this exact arguments object: `ops` is the single top-level argument and its value is the array shown below (replace the placeholders). Do NOT nest another `ops` inside it.
`{"ops":[{"op":"init","list":[{"phase":"<Phase name>","items":["<task 1>","<task 2>"]}]}]}`
NEVER double-wrap the argument: a value like `{ "ops": { "ops": … } }` is rejected as `ops: expected array, received object`. The `ops` value is the array itself, not an object.

After `todo_write` succeeds, continue the request in the same turn.
NEVER call `todo_write` again unless task state has materially changed.
</system-reminder>
