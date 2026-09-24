# Dynamic Codex Model Catalog

## Objective
Make `codex-multi` mirror Pi's effective, refreshed `openai-codex` model catalog instead of the static catalog bundled in `pi-ai`.

## Problem
`src/provider.ts` resolves `openaiCodexProvider().getModels()` at module load time. Pi's refreshed catalog is applied in the runtime model registry, so newly published models can appear under `openai-codex` while remaining absent from `codex-multi`.

## Why
Users expect `codex-multi` to expose the same supported Codex models as Pi's built-in `openai-codex` provider after `pi update --models` and restart.

## Scope
- Resolve default models from Pi's effective `openai-codex` runtime catalog during extension registration.
- Preserve explicit model injection used by tests and consumers.
- Preserve a static bundled-catalog fallback.
- Add regression coverage for runtime catalog mirroring.
- Update user-facing documentation if behavior wording needs clarification.

## Constraints
- Do not query OpenAI's public `/v1/models` endpoint.
- Do not change OAuth, account rotation, failover, or quota behavior.
- Preserve existing uncommitted user changes in `tests/manage.test.ts` and `tests/store.test.ts`.
- Generated technical artifacts remain in English.
- No commit without explicit user authorization.

## Delivery
- Strategy: ask-on-risk
- Forecast: under 120 authored changed lines
- Branch: `fix/dynamic-codex-model-catalog`
- Commit evidence: pending explicit user authorization

## TDD
- Mode: enabled for this regression fix
- Source: task-local decision based on existing Vitest coverage and reproducible catalog mismatch
- Runner: `npm test -- --run tests/provider.test.ts tests/extension.test.ts`

## Tasks
- [x] **ODD-1 — Add failing runtime-catalog regression coverage**
  - Route: delegated (`gentle-ai-worker`), because the implementation requires coordinated non-trivial edits across source and tests.
  - Acceptance: a focused test proves `codex-multi` receives models exposed by Pi's effective `openai-codex` runtime registry.
  - Check: focused Vitest command fails before implementation for the expected missing behavior.
  - Evidence: focused RED failed 2/37 because the runtime-only `gpt-6-luna` model was absent.
- [x] **ODD-2 — Resolve and register the effective catalog**
  - Route: delegated (`gentle-ai-worker`) in the same bounded writer task.
  - Acceptance: runtime models are preferred, explicit injected models still win, and the bundled catalog remains a fallback.
  - Checks: focused tests, full `npm test`, and `npm run typecheck` pass.
  - Evidence: focused suite 38/38; full suite 219/219; TypeScript clean.
- [ ] **ODD-3 — Verify runtime model parity**
  - Route: delegated (`gentle-ai-verify`), required because native assessment was unavailable and therefore treated as high risk.
  - Acceptance: `codex-multi` contains the dynamically refreshed models present under `openai-codex` in the local Pi runtime.
  - Check: independent focused/full verification plus runtime-compatible structural evidence.
  - Evidence: independent focused suite 38/38, full suite 219/219, typecheck clean, and source diagnostics contain only pre-existing style findings. Live interactive parity remains pending because `pi --list-models` exits before `session_start` and therefore cannot exercise this fix.

## Progress
The delegated writer added strict RED/GREEN regression coverage and implemented explicit-model > runtime-catalog > bundled-catalog precedence. `session_start` now re-registers `codex-multi` using effective `openai-codex` models from `ctx.modelRegistry`. README behavior is updated. Independent verification passed; only confirmation from a freshly started interactive Pi session remains. Commit remains pending explicit user authorization.

## Verification Evidence
- Baseline `pi --version`: `0.87.1`.
- Baseline `pi --list-models openai-codex`: includes `gpt-6-luna` and `gpt-6-sol`.
- Baseline `pi --list-models codex-multi`: omits both models.
- RED: focused tests failed 2/37 for missing runtime model propagation.
- GREEN: focused tests passed 38/38.
- Writer full suite: 219/219 tests passed.
- Writer typecheck: passed with no errors.
- Native risk assessment: unavailable because the untracked ODD artifact required explicit declaration; per policy this was treated as high risk and received an independent verifier.
- Independent focused suite: 38/38 tests passed.
- Independent full suite: 219/219 tests passed.
- Independent typecheck: passed with no errors.
- LSP/analyzer diagnostics: no new type errors; reported findings are pre-existing style findings in unchanged lines.
- Live limitation: `pi --list-models` terminates before session lifecycle events, so it cannot validate the `session_start` re-registration.

## Next Step
Restart Pi interactively and confirm `/model` shows `codex-multi/gpt-6-luna` and `codex-multi/gpt-6-sol`; then request a commit if desired.
