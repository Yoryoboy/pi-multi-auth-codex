# pi-multi-auth-codex

Use multiple authorized Codex accounts from Pi with shared account rotation, token refresh, and failover for authentication and quota errors.

> This is an independent community extension. It is not affiliated with or endorsed by OpenAI. You must own or be authorized to use every account and follow OpenAI's terms and service rules. This extension does not increase entitlements or bypass service rules.

## Quick install

```text
pi install git:github.com/Yoryoboy/pi-multi-auth-codex
```

Restart Pi, then:

1. Run `/codex-accounts`.
2. Choose **Add account** and complete the sign-in flow for each account you are authorized to use.
3. Open `/model` and choose `codex-multi/gpt-5.6-sol`.
4. Press `Ctrl+S` if you want to save the model selection.

There is no per-account model configuration. All configured accounts use the one `codex-multi/gpt-5.6-sol` provider model.

## What it does

- Rotates accounts globally across Pi processes using a locked shared store and cross-process round-robin state.
- Refreshes OAuth access tokens when they expire.
- Marks accounts temporarily unavailable after authentication failures or quota/rate-limit responses, then fails over to another available account.
- Provides `/codex-accounts` to add, reauthenticate, enable, disable, remove, refresh, and inspect the store path for accounts.

### Thinking levels

The model exposes these thinking levels:

- `off` / `none`
- `low`
- `medium`
- `high`
- `xhigh`
- `max`

`minimal` is unsupported and hidden by the model mapping.

## Account store and security

The default store is:

```text
~/.pi/agent/pi-multi-auth-codex/accounts.json
```

The extension creates the parent directory with mode `0700` and the account file with mode `0600`. The store contains OAuth credentials, so protect your home directory and do not copy or share this file. Use `/codex-accounts` → **Show store path** to confirm the active path.

## Updating or removing

Update the installed GitHub package with:

```text
pi update git:github.com/Yoryoboy/pi-multi-auth-codex
```

Remove it with:

```text
pi remove git:github.com/Yoryoboy/pi-multi-auth-codex
```

Removing the extension does not automatically remove the account store. Remove accounts first from `/codex-accounts` if you want their stored tokens deleted, then remove the package through Pi.

## Local development

```bash
npm install
npm test
npm run typecheck
```

The optional Pi/Bun smoke check requires a local Pi runtime:

```bash
npm run test:bun
```

The package allowlist publishes only `src`, this README, and the MIT license (plus npm's package metadata). Tests, fixtures, local stores, and development-only files are excluded.

## Verification

The project tests cover account storage and locking, OAuth/token handling, account selection and rotation, provider registration and failover, command/UI behavior, and extension integration. CI runs the Node test suite, TypeScript typecheck, and an npm package dry run. The Pi/Bun smoke check is intentionally not part of generic CI because CI does not install the Pi runtime.

## Limitations

- This is a GitHub-only first release; npm distribution is planned later.
- It requires a compatible Pi runtime and the matching `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` peer packages.
- It cannot create account entitlements, avoid provider limits, or guarantee failover when every account is unavailable.
- Authentication is interactive and depends on the service's current sign-in behavior. Never paste tokens, account identifiers, or private account data into issues or logs.
