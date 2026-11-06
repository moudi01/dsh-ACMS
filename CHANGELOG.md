# Changelog

## Unreleased

- Preserve validated external-runner errors with bounded, redacted messages. Keep failed exits as failures, and require reconciliation when descendant cleanup is unconfirmed instead of automatically retrying or dispatching repair work.
- Prevent managers from delegating more permissions than their effective current/captured grants. Add atomic external management batches with prior-result ID references, durable retry deduplication and automatic result-fed continuation.
- Invalidate obsolete blocker answers after cancellation or contract/workflow changes; answering a paused task preserves its pause.
- Keep temporary personnel while other assigned work or cleanup remains, release unused capacity after permanent deletion, and expose retired-assignee blockers.
- Recompute goal completion after task deletion, restoration and purge. Keep model pairing and role creation usable when the model catalog is empty.

- Add task deletion and recovery with dependency, active-run, and cleanup checks; retain evidence and restore unfinished work as paused.
- Create a new project and its first goal in one transaction. Add native directory selection, in-panel directory browsing, and whole-path clipboard paste.
- Explain unavailable actions beside their buttons. Classify execution routes by internal/external origin, task-context retention, and parent-context inheritance.
- Display provider-reported reasoning settings and pass supported native reasoning selections to actual runs. Add isolated, bounded connectivity checks with per-route results, failure explanations and a 10-minute validity window.

- Select real model IDs from the live DSH catalog; deduplicate executor aliases and expose routes in advanced settings. Fixed-model executors receive no unsupported model override; native executors receive both the model and its LLM route.
- Separate resident/temporary personnel from task-context continuation, and clarify the task option for retaining temporary workers.
- Remove the one-time migration module and close its API after successful import. Preserve imported task history and audit records, with no re-import entry point.
- Publish immutable host bundles for config-driven DSH hot reload, with idle checks and profile backups; retain unrelated plugin configuration byte-for-byte.

## 0.1.0

First runnable ACMS demo for DeepSeek Harness.

- Native company dashboard, task board, dependency graph, organization/workflow editors, artifact evidence, local blocker responses and paused legacy import.
- Persistent autonomous scheduling, bounded temporary agents, independent automatic review, repair/rework loops and durable command/event handling.
- Isolated worktrees, dedicated reviewer verification copies, candidate merge validation and conservative restart reconciliation.
- Optional task-scoped persistent Codex provider with bounded process lifetime and recoverable completion receipts.
- Windows installation/uninstallation scripts, isolated protocol/engine/UI tests and GitHub CI.
