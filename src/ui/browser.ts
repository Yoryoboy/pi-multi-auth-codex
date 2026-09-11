import { spawn } from "node:child_process";

export type BrowserSpawn = (command: string, args: readonly string[], options: { stdio: "ignore"; windowsHide: boolean; shell: false }) => {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
};
export type BrowserOpener = (url: string) => Promise<void>;

/** Open an OAuth URL without invoking a shell. The URL contains OAuth state/challenge and must never be logged. */
export function createBrowserOpener(platform = process.platform, spawnImpl: BrowserSpawn = spawn as BrowserSpawn): BrowserOpener {
  return async (url) => {
    const command = platform === "darwin" ? "open" : platform === "win32" ? "rundll32" : "xdg-open";
    const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    await new Promise<void>((resolve, reject) => {
      const child = spawnImpl(command, args, { stdio: "ignore", windowsHide: true, shell: false });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("browser opener failed")));
    });
  };
}
