# Third-party notices

Original ACMS source has no selected open-source license yet. See `LICENSE`.

`packages/codex-persistent/lib` and its isolated protocol tests are derived from the local persistent Codex
adapter, itself a fork of `@deepseek-ai/dsh-subagent-codex` 0.2.1-rc.5.
Copyright (c) 2026 DeepSeek. MIT license: `packages/codex-persistent/LICENSE`.
ACMS changes the provider identity, default state location and explicit
workspace/reviewer sandbox defaults. No authentication files or live histories
are included.

React (MIT), esbuild (MIT), Playwright (Apache-2.0), the OpenAI Codex package,
and the DSH runtime packages retain their respective package licenses.
Dependencies are installed from their registries and are not vendored into
the repository. The browser plugin uses DSH's shared React module.
