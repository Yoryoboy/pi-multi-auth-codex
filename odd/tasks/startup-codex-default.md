# Startup Codex Default

## Objective
Make fresh Pi 0.87.1 sessions honor configured `codex-multi/gpt-6-sol` without overriding CLI, restored, or later model selection.

## Problem and rationale
Pi resolves the initial model after extension factories but before `session_start`. The extension's factory registers a catalog from its local pi-ai 0.85.1 dependency, which lacks `gpt-6-sol`; the running Pi 0.87.1 bundled catalog contains that model. Changing the selected model in `session_start` would risk overriding explicit CLI selections because provenance is not exposed. Register the host-bundled model before Pi's initial resolution instead, leaving Pi's own precedence in charge.

## Scope and constraints
- First observe a failing regression for factory-time availability of `gpt-6-sol` with a host catalog fixture; cover non-interference with CLI/resume/manual/reload/fork by asserting the extension never sets the model.
- Apply the smallest provider-catalog import/registration change; preserve session_start refresh for dynamic runtime models and explicit model injection.
- Do not change Pi, change the default provider to openai-codex, publish, or create a PR.
- Do not read secrets or add an unlocked models-store.json reader. Models available only via Pi's downloaded overlay remain outside this bounded startup fix.
- The user subsequently authorized a commit and direct push to main, explicitly without a PR.

## Acceptance and checks
- Factory registration includes the host-bundled `gpt-6-sol` before session_start.
- The extension does not select a model itself, preserving Pi's CLI, restoration, scoped, manual, reload, and fork priority.
- Observe RED before implementation, then focused GREEN, `npm test`, and `npm run typecheck`; report failures/skips honestly.
- Explain a fresh-session manual check using `pi --list-models codex-multi` and opening Pi with the configured default.

## TDD
- Mode: enabled; source: user's explicit tests-first instruction.
- Runner: `npm test -- --run tests/startup-model.test.ts tests/extension.test.ts tests/provider.test.ts` (focused); `npm test` (full); `npm run typecheck`.

## Delivery
- Forecast: under 100 authored changed lines; strategy: ask-on-risk; no PR requested.
- Branch: `fix/startup-codex-default` (created from main before source edits).
- Commit evidence: `7993b6f7461c2bf191ea3a7e65280d68afbf356d` (`fix(models): register host Codex catalog before startup`), containing the fix, regression tests, and feature document.

## Tasks
- [x] **ODD-1 — Add startup and non-interference regressions**
  - Route: delegated `gentle-ai-worker` for coordinated source/test changes and test-first verification.
  - Check: focused test fails for absence of a host-bundled `gpt-6-sol` at factory registration, before implementation.
  - Evidence: RED 3 failed/44 passed in focused suite before source edit; fixture catches the missing host model and checks non-selection for startup/reload/new/resume/fork. Delivered in `7993b6f`.
- [x] **ODD-2 — Register the host Codex catalog before selection**
  - Route: same bounded delegated writer, because two non-trivial files are touched across the work unit.
  - Check: focused tests and full suite pass; Pi precedence remains untouched.
  - Evidence: `src/provider.ts` now uses host-aliased `providers/all`; GREEN focused 47/47, full 228/228; no setModel calls added. Delivered in `7993b6f`.
- [x] **ODD-3 — Verify and report**
  - Route: delegated `gentle-ai-verify` because native assess was unassessable with untracked files; parent spot-checked CLI output.
  - Check: `npm run typecheck`, full suite, and documented fresh-session check; report unrun live checks.
  - Evidence: independent focused 47/47, full 228/228, typecheck clean; real Pi 0.87.1 `pi --list-models codex-multi` lists `gpt-6-sol`. User confirmed a fresh interactive session selects the configured default. Explicit CLI override and live resume were not tested.

## Progress
Implementation and independent checks complete on `fix/startup-codex-default`; user confirmed the fresh interactive default works. Scope is the host-bundled catalog; downloaded-only overlay models remain outside this change. Native risk assessment could not inspect the untracked scope, so an independent verifier ran. User authorized committing and pushing directly to main without a PR. Pre-commit verification of the staged snapshot: `npm test` 228/228, `npm run typecheck` clean, `git diff --cached --check` clean. Work-unit commit: `7993b6f`.

## Next step
Fast-forward main and push without a PR. Optional later live checks: explicit CLI override and session resume.
