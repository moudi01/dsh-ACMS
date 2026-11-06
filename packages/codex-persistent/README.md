# ACMS persistent Codex provider

Optional DSH provider forked from the existing MIT-licensed persistent Codex
adapter and DeepSeek's `dsh-subagent-codex` 0.2.1-rc.5. It uses Codex CLI 0.166.0.

Changes for ACMS:

- Default provider name: `acms-codex`.
- Default `acms-workspace` mode explicitly requests `workspace-write` with
  `approvalPolicy: never`. Reviewers receive a separate verification copy with
  workspace-write permission; the author workspace is not a writable root.
- Thread identity is provided by ACMS's stable, task-specific label.
- Contexts persist between turns; model process lifetime is limited to one run.
- The `stateFile` and optional `env.CODEX_HOME` are installation settings, never
  committed credentials. Authenticate using the Codex CLI normally. Do not copy
  a running Codex SQLite database.

The provider retains its own MIT license. Original permission modes remain
available for compatibility, but production ACMS configuration should use the
default workspace mode. This provider is not an operating-system security
boundary against malicious host plugins; all DSH host plugin code is trusted.
