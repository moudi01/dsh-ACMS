# Iteration 2 release report: planning accepted, execution release blocked

Status: the execution and release loop is NOT complete. PR #23 is open, Windows CI failed, and no merge, backup, upgrade or live agent API acceptance has happened. This file records the real CI failure, the in-scope fix, local evidence and the exact pending handoff.

## 1. Two conclusions

| Acceptance | Conclusion | Basis |
| --- | --- | --- |
| Autonomous planning (#16) | pass for the reviewed candidate only | non-author ACMS review verification_8ef34747-2693-4e9f-8fb5-611851078fc1 approved artifact 73617521... |
| Execution and release loop | NOT complete | PR #23 open, CI run 42383001370 failed, no merge, backup, upgrade or live acceptance |
| CI repair in this delta | fixed locally, re-review pending | explicit foreign ACE regression red/green; tree below |

## 2. PR and CI facts

- PR: https://github.com/moudi01/dsh-ACMS/pull/23
- head: 3aa5c996ad1beb539950397cd32383ee73412508
- tree: 72ced9318a1c1d7a24fdfd9a30300a9a46d6ca4a
- base: 178987ad4337a499f925d4377de44a3b5f11d550
- CI: run 42383001370 / job 128434400990, failure, 315/317 passed
- failing: test/external-onboarding-doc.test.js:32 and :55, guard $other.Count

## 3. Root cause and fix

icacls /inheritance:r removes inherited ACEs only. On the GitHub Windows runner the token file also had explicit ACEs for other identities, so /grant:r for the current user left a foreign ACE and the guard threw.

The published block now keeps icacls, rebuilds the DACL with Get-Acl and Set-Acl, removes every non-inherited foreign ACE, requires exactly one current-user ACE and throws (non-zero) otherwise. No test is skipped and the token guard is not relaxed.

## 4. Local evidence (this workspace)

- commit 6634c677bd629e6c79480a0cacd376cb8ec260b9 reconstructs the exact PR #23 tree 72ced9318a1c1d7a24fdfd9a30300a9a46d6ca4a, so the reviewed content is preserved.
- fix files: docs/external-agent-onboarding.md and test/external-onboarding-doc.test.js.
- red: test-results/iteration-2-release/ci-fix-red.log, exit 1, same $other.Count failure.
- green: test-results/iteration-2-release/ci-fix-green.log, 6/6 pass, exit 0.
- check: test-results/iteration-2-release/check.log, exit 0.
- full suite: test-results/iteration-2-release/full-test.log.

## 5. Pending external actions (release gate)

1. ACMS non-author independent re-review of the fix delta on top of tree 72ced9...; no self-approval.
2. External user agent updates the same PR #23 branch, re-runs Windows CI and merges only when green.
3. Backup, live upgrade, old process tree cleanup, data retention and service availability checks.
4. Live acceptance through the shipped agent API: authorized submit, progress/review/blocker query, interaction answer, incremental events, pause/resume, reconnect/restart recovery, scoped real model call, and manager coordination with independent review.
5. Fill this report with PR/merge commit, CI run, backup/upgrade evidence and review record; then close the issues.

## 6. Limits

No claim of merge, upgrade or live model execution is made here. The reconstruction commit proves content identity, not CI. The local red/green logs are Windows 10 host evidence and must be confirmed by the real GitHub CI run.
The ACL fix uses Get-Acl and Set-Acl; if a host cannot load Microsoft.PowerShell.Security from an inherited PSModulePath, the documented workaround remains Remove-Item Env:PSModulePath in the same window. The test child environment removes it and does not change the host.
- fix commit: tag acms-i2-v9-ci-fix (resolve with git rev-parse acms-i2-v9-ci-fix); parent 6634c67 has the exact PR #23 tree.
- full suite: 318/318 pass, exit 0.
