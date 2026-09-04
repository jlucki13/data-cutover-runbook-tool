# Sample worksheets

Files to drop into **Imports → New import** on a seeded event, each aimed at one part of
the pipeline. Nothing here reaches the graph until you review and commit it, and a batch
you discard never touched it at all.

Everything below is what these files actually produce against the seeded runbook — run
them and check the numbers rather than taking this table's word for it.

| File | What it exercises | What you should see |
| --- | --- | --- |
| `messy-worksheet.csv` | Header aliases, mixed duration formats, dependency lag | 8 tasks, 8 dependencies, no errors. `45m`, `2h 30m`, `180`, `1.5h` and `30 min` all land as minutes; `TRE-5 FS+30` becomes a finish-to-start edge with 30 minutes of lag. Also 8 warnings — see the open question below. |
| `unresolved-refs.csv` | Reference resolution and the commit guard | Two **errors**: `MIG-ACCOUNTS` is not a task, with `Did you mean "MIG-ACC"?`; `MIG-XYZ` has no suggestion. The third dependency resolves fine. Commit is refused until you fix or drop the two. |
| `second-workstream.csv` | Compiling separate owners' sheets into one runbook | 3 new Cards tasks and 5 dependencies, two of which reach *into* the existing runbook (`FRZ-1 → CRD-1`, `REC-BAL → CRD-3`). No errors: a sheet may depend on work it does not own. |
| `changed-durations.csv` | Re-import diff | 3 tasks come back as **changes**, not duplicates: `MIG-BAL` 150→240, `MIG-STM` 240→300, `REC-BAL` proposes *clearing* its deadline. The three dependencies resolve exactly and propose nothing. Commit the two duration changes on the live event to watch the gate slip further — and read the open question below before accepting all three. |
| `cycle.csv` | Graph validation | One error naming the cycle: `CYC-1 → CYC-2 → CYC-3 → CYC-1`. Commit returns 409 and the committed graph is untouched. |
| `prose-handover.txt` | Free-text parsing (needs `ANTHROPIC_API_KEY`) | Dependencies extracted with a confidence and a verbatim quote from the text. Anything under 0.9 stays unaccepted until you tick it yourself. Without a key the prose format is refused outright. |

`unresolved-refs.csv` and `cycle.csv` are meant to fail — that is the test. Discard them
afterwards.

## Two open questions these samples raise

**An absent column reads as "clear this".** `changed-durations.csv` has no Deadline column,
so re-importing it proposes removing `REC-BAL`'s deadline. The diff compares every field,
and a field the sheet does not carry looks the same as a field the sheet emptied. The
proposal is visible in review, but "treat proposed as accepted" is on by default, so a lead
re-sending a trimmed sheet could quietly drop a compliance deadline. Worth deciding whether
an absent *column* should mean "unchanged" while an empty *cell* in a present column means
"clear".

**Is a Description column a name or a note?** `messy-worksheet.csv` heads its task-name column **Description**, and today the parser
treats `description` as its own field rather than as a name. So all eight tasks import with
their ID as the name and a `missing_name` warning each. Real worksheets use that header
both ways. Worth deciding: should a `Description` column become the task name when there is
no other name-ish column, or stay a separate note as it is now?
