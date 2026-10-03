# Fill-First Routing

## Objective
Add a `fill-first` routing strategy that keeps using the last selected account until it becomes ineligible, and make it the default.

## Problem and rationale
`selectAccount` runs on every model request and advances the cursor, so round-robin switches accounts every turn and most-available can oscillate between accounts with similar quota. OpenAI prompt caches are not shared between organizations (each ChatGPT account), so every switch discards the cached prefix, consuming more usage limit and adding latency.

## Scope and constraints
- New `RoutingStrategy` value `"fill-first"`; `effectiveRoutingStrategy` defaults to it when unset; store validation accepts it.
- Selection: reuse `lastSelectedAccountId` while it is enabled, not cooling down for the model, auth-valid, and not excluded; otherwise take the next eligible account in cursor order.
- Rotation on 429/usage-limit keeps working through existing cooldown marking and `excludeAccountKeys`.
- Account manager menu exposes "Fill first".
- Out of scope (later): cache hit/miss observability.

## Acceptance and checks
- Repeated selections under fill-first return the same account; a cooled-down, disabled, auth-invalid, or excluded sticky account rotates to the next eligible one.
- Unset strategy behaves as fill-first; round-robin and most-available unchanged.
- Test-first: observe RED, then GREEN; `npm test` and `npm run typecheck` pass.

## TDD
- Mode: enabled; runner `npm test` (vitest), `npm run typecheck`.

## Delivery
- Branch: `feat/fill-first-routing`. Push/PR are user decisions.

## Tasks
- [x] **ODD-1 — Implement fill-first strategy test-first** (store type/validation/default, selector logic, menu option, tests)
  - Route: delegated `gentle-ai-worker` (multi-file write).
  - Evidence: RED 19 failed/227 passed before source edits; GREEN 246/246; typecheck clean (re-run by parent).
- [x] **ODD-2 — Verify and commit**
  - Evidence: parent re-ran `npm test` 246/246 and `npm run typecheck`; commit recorded in git log of `feat/fill-first-routing` (`feat(routing): add sticky fill-first strategy as default`).
