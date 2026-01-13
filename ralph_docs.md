Copyright (C) 2026 Zemtu OG

# Ralph Driven Development (RDD) — Candidate → Verify → Done

This repo folder is **`ralph/`**. Everything Ralph needs lives here. The runner executes specs with Codex in a loop, but **a spec is only marked done after an independent verification run passes**.

---

## Directory Layout

```
ralph/
  ralph.py
  SCRATCHPAD.md
  runs/
    <spec_id>/<UTC_TIMESTAMP>/
      impl-attempt-1.log
      verify.log
      ...
  specs/
    0001-seed.md
    area/0002-feature.md
    candidates/
      0001-seed.json
      area/0002-feature.json
    done/
      0001-seed.md
      area/0002-feature.md
  ralph.log
```

### What each folder/file is for

* **`specs/`**
  Your spec backlog. Specs can be nested into subfolders. Only files with names like `0001-*.md` are treated as runnable specs.

* **`specs/candidates/`**
  “Candidate completion” markers produced after the implementer run prints a commit hash + magic phrase. These mirror `specs/` structure as JSON files.

* **`specs/done/`**
  Verified completion markers. These mirror `specs/` structure as Markdown files and include the **candidate commit hash** that was verified.

* **`runs/`**
  Full output logs per attempt (implementation + verification), grouped by `spec_id` and timestamp.

* **`SCRATCHPAD.md`**
  A shared handover / memory file used by both implementer and verifier. The agent is expected to read and update it.

* **`ralph.log`**
  Runner events (text or JSONL depending on flag).

---

## How the Pipeline Works

For each spec, Ralph uses a **two-phase contract**:

### Phase A — Implementer

Codex implements the spec, commits, and outputs:

1. DONE REPORT
2. `<40-char commit hash>` (own line)
3. `I AM HYPER SURE I AM DONE!` (final non-empty line)

When Ralph sees this strict pattern, it writes a **candidate marker** to:

* `specs/candidates/<same path as spec>.json`

### Phase B — Verifier (independent run)

A second Codex run validates the candidate commit:

* reads spec
* selects correct repo
* checks the commit exists and checks out that commit
* runs minimal meaningful verification (agent decides; fast-first)
* **does not modify code and does not commit**

If verification passes, verifier outputs:

1. VERIFICATION REPORT
2. `<same 40-char candidate commit hash>` (own line)
3. `I AM HYPER SURE I AM DONE!` (final non-empty line)

Only then Ralph writes:

* `specs/done/<same path as spec>.md`

…and the spec is now permanently skipped unless forced.

---

## Default Settings

* **Magic phrase**:
  `I AM HYPER SURE I AM DONE!`

* **Max attempts per spec** (any failure counts: impl or verify):
  `10`

* **Codex args default** (YOLO + skip git check):

  * bypass approvals & sandbox
  * skip git repo check

* **Workspace root default**:
  Parent directory of `ralph/` (so your repos can live next to `ralph/`).

---

## Quick Start

From anywhere:

```bash
python ralph/ralph.py
```

Typical workspace:

```
workspace/
  repo-a/
  repo-b/
  ralph/
    ralph.py
    specs/
    ...
```

Ralph runs Codex with `workspace/` as the working directory by default, and the spec itself must tell the agent which repo to work in.

---

## Writing Specs

### Naming

Specs must be named like:

* `0001-setup.md`
* `area/0002-api.md`

Only files matching `^\d{4}-.*\.md$` are executed.

### Recommended spec header

Include a clear repo target to avoid ambiguity in multi-repo workspaces:

```md
# 0007 - Add webhook retries

Repo: repo-a
Workdir: repo-a
```

### Recommended structure

Use a consistent, deterministic format. Avoid conditional branches in specs.

```md
## Goal

## Dependencies
- 0006-previous-spec.md

## Constraints
- Verification focus: keep code simple, readable, typed; one method/function one responsibility.
- Any project-specific testing or style rules.

## Required reading
- <key files to read before coding>

## Acceptance criteria
- Concrete, testable bullet points.

## Verification (fast-first)
```bash
# Targeted tests or commands
```
```

### Best practices from current spec creation

* **One spec = one logical PR.** Keep specs small and isolated so verification is fast.
* **Deterministic steps only.** Avoid “if you find X, then maybe Y” in the spec body.
* **Required reading helps.** List the key files to read before implementing.
* **Constraints first.** Put code-quality expectations in Constraints.
* **Acceptance criteria are measurable.** Tie each change to a test or observable outcome.
* **Verification is fast-first.** Use targeted tests, then optionally list wider checks.
* **No prep trackers in specs.** Specs should be runnable on their own.
* **Sequence dependencies explicitly.** If a spec is a prerequisite, mark it in Dependencies.
* **Prior implementation references are for context only.** Do not blindly reapply old code.

---

## Seed Spec That Generates the Backlog (pattern)

If you want “one spec that creates the next specs”, do it explicitly.

`specs/0001-seed.md`:

```md
# 0001 - Seed backlog

Repo: (none)  # this spec may only create specs; it should say so explicitly

## Task
1) Inspect the workspace and detect repos.
2) Generate specs 0002..0010 in ralph/specs/ with:
   - Repo: <repo-name>
   - Acceptance criteria
   - Verification guidance (fast-first)
3) Update SCRATCHPAD.md with assumptions and plan.

## Completion
If you changed anything, commit in the appropriate repo (or a dedicated meta repo if you have one).
```

**Important:** The completion contract expects a commit hash line. If you want “seed spec may complete without committing”, you need to define that in your spec and adjust the contract in code accordingly (currently it requires a commit hash).

---

## Resume Behavior

Rerunning the script is safe:

* If a spec has `specs/done/<spec>.md` → it is skipped.
* If a spec has a candidate JSON but no done file → Ralph tries **verification first**.

  * If verification passes → it is marked done.
  * If verification fails → Ralph re-runs implementation using verifier feedback.

---

## Common Commands

### Basic run

```bash
python ralph/ralph.py
```

### Stream agent output live

```bash
python ralph/ralph.py --stream-agent-output
```

### Dry-run (no Codex calls)

```bash
python ralph/ralph.py --dry-run
```

### Force re-run specific spec(s)

Paths are relative to `specs/`:

```bash
python ralph/ralph.py --force 0003-feature.md area/0007-bugfix.md
```

### Override workspace root

```bash
python ralph/ralph.py --workspace-root /path/to/workspace
```

### Override magic phrase

```bash
python ralph/ralph.py --magic-phrase "I AM HYPER SURE I AM DONE!"
```

### Override max attempts

```bash
python ralph/ralph.py --max-attempts-per-spec 20
```

---

## What “Done” Means Here

A spec is considered done only if:

1. Implementer produced a candidate commit and saved it under `specs/candidates/…`
2. Verifier independently confirmed completion at that **exact commit**
3. Ralph wrote `specs/done/<spec>.md` containing that commit hash

This prevents “agent claims done” from becoming permanent without verification.

---

## Troubleshooting

### It keeps retrying the same spec

Common reasons:

* Agent doesn’t print the strict ending:

  * `commit-hash line`
  * `magic phrase` as last non-empty line
* Verifier fails and keeps sending fix feedback
* Codex exits non-zero / rate limiting

Check:

* `runs/<spec_id>/<timestamp>/impl-attempt-*.log`
* `runs/<spec_id>/<timestamp>/verify.log`
* candidate file in `specs/candidates/...`

### Candidate exists but never becomes done

Verifier is failing. See the verify logs and the output tail stored in the done report once it passes.

### Multi-repo confusion

Add `Repo:` / `Workdir:` to specs so the agent consistently `cd` into the right repo before using git.
