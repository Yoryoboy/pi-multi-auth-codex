import type { LoginOperation } from "../auth/oauth.js";

export interface OAuthWaitUI {
  custom<T>(factory: (tui: any, theme: any, keybindings: OAuthKeybindings, done: (value: T) => void) => any): Promise<T>;
}

export interface OAuthKeybindings {
  matches?: (data: string, action: "tui.select.cancel") => boolean;
}

/** Waits for OAuth while giving TUI users a real cancellation path. */
export function waitForOAuth(ui: OAuthWaitUI, operation: LoginOperation, controller: AbortController): Promise<Awaited<LoginOperation> | null> {
  return ui.custom<Awaited<LoginOperation> | null>((tui, theme, keybindings, done) => {
    let cancelled = false;
    let finished = false;
    const finish = (value: Awaited<LoginOperation> | null) => {
      if (finished) return;
      finished = true;
      done(value);
    };
    void operation.then(
      value => { if (!cancelled) finish(value); },
      () => { finish(null); },
    );
    return {
      render: (width: number) => [theme.fg("accent", "Waiting for OAuth callback..."), theme.fg("dim", "Press Esc to cancel")].map((line: string) => line.slice(0, width)),
      invalidate: () => undefined,
      handleInput: (data: string) => {
        // KeybindingsManager.matches is Pi TUI's matchesKey path: it normalizes
      // plain/enhanced terminal encodings and applies configured bindings.
      const configuredCancel = keybindings.matches?.(data, "tui.select.cancel") ?? false;
      if (configuredCancel) {
          cancelled = true;
          controller.abort();
          // The UI closes only after the OAuth promise has run cleanup.
          void operation.finally(() => finish(null)).catch(() => undefined);
          tui.requestRender();
        }
      },
    };
  });
}
