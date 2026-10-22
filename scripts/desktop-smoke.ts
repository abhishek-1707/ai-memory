import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

if (process.platform !== 'win32') {
  console.error('DESKTOP_SMOKE_UNAVAILABLE: packaged Windows launch requires Windows');
  process.exitCode = 2;
} else {
  const executable = resolve(
    process.env.OMNIMEMORY_DESKTOP_EXE ?? join('artifacts-v2', 'win-unpacked', 'OmniMemory.exe'),
  );
  if (!existsSync(executable)) {
    throw new Error(`Packaged executable not found: ${executable}`);
  }

  const directory = mkdtempSync(join(tmpdir(), 'omnimemory-desktop-smoke-'));
  const port = process.env.OMNIMEMORY_DESKTOP_SMOKE_PORT ?? '3329';
  const child = spawn(executable, [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      OMNIMEMORY_DB_PATH: join(directory, 'smoke.sqlite'),
      OMNIMEMORY_PORT: port,
      OMNIMEMORY_HOST: '127.0.0.1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    await waitForShell(`http://127.0.0.1:${port}/`);
    console.log(`DESKTOP_SMOKE_OK: ${executable}`);
  } finally {
    child.kill();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function waitForShell(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok && (await response.text()).includes('<title>OmniMemory</title>')) {
        return;
      }
    } catch {
      // The packaged process may still be starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('Packaged Windows application did not serve the PWA shell before the timeout');
}
