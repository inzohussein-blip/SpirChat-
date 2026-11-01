import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const repo = new URL('..', import.meta.url).pathname;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export interface TestHub {
  url: string;
  port: number;
  proc: ChildProcess;
  info(): Promise<{ count: number; byKind: Record<string, number> }>;
}

/** Starts a real hub serving the built web app (run `npm run build` first). */
export async function startHub(name: string, env: Record<string, string> = {}): Promise<TestHub> {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'spirchat-e2e-'));
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'hub/src/main.ts'], {
    cwd: repo,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', HUB_NAME: name, DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout!.on('data', (d) => (log += d));
  proc.stderr!.on('data', (d) => (log += d));
  // 127.0.0.1 rather than localhost: on some machines localhost resolves to ::1 first.
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${url}/api/info`)).ok) break;
    } catch {
      // not up yet
    }
    if (i > 300 || proc.exitCode !== null) throw new Error(`hub ${name} did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, port, proc, info: async () => (await fetch(`${url}/api/info`)).json() };
}

let browser: Browser | null = null;

export async function phone(url: string): Promise<Page> {
  browser ??= await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(url);
  return page;
}

export async function signUp(page: Page, name: string) {
  await page.fill('input', name);
  await page.click('button.primary');
  await page.waitForSelector('.tabs');
}

export const tab = (page: Page, n: 1 | 2 | 3 | 4 | 5) => page.click(`.tabs button:nth-child(${n})`);

export async function closeAll(hubs: TestHub[]) {
  await browser?.close();
  browser = null;
  hubs.forEach((h) => h.proc.kill());
}
