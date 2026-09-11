import { describe, expect, it, vi } from "vitest";
import { createBrowserOpener } from "../src/ui/browser.js";

describe("browser opener", () => {
  it.each([["linux", "xdg-open", ["url"]], ["darwin", "open", ["url"]], ["win32", "rundll32", ["url.dll,FileProtocolHandler", "url"]]] as const)("uses confined argv on %s", async (platform, command, expected) => {
    const once = vi.fn((_event: string, listener: (...args: any[]) => void) => { if (_event === "exit") listener(0); return {}; });
    const spawn = vi.fn(() => ({ once })) as any;
    await createBrowserOpener(platform, spawn)("url");
    expect(spawn).toHaveBeenCalledWith(command, expected, { stdio: "ignore", windowsHide: true, shell: false });
  });
});
