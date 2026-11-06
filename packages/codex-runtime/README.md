# ACMS Codex runtime

Internal library for paired Codex app-server execution. It is used by `src/adapters/paired.js`; it is not a separately installed DSH plugin.

- `lib/index.js`: JSON-RPC initialization, thread start/resume, turn execution and steering, approval denials, timeout and child-process cleanup.
- `lib/store.js`: task-scoped thread identities, event records, summaries and cross-process leases.
- `test/`: protocol and process-lifecycle tests using a local simulated app-server.

The caller supplies the executable, model, reasoning effort, workspace and task context key. Work and review have separate contexts. Runtime state is stored in the ACMS data directory; credentials remain managed by the selected Codex installation.

Derived code retains its MIT license; see `LICENSE` and the repository's `THIRD_PARTY_NOTICES.md`.
