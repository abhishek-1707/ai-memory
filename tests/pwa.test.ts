import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const publicDirectory = join(process.cwd(), 'public');
const originalFetch = globalThis.fetch;
const browserGlobals = globalThis as typeof globalThis & {
  omnimemoryDesktop?: {
    createOwner(input: Record<string, string>): Promise<unknown>;
  };
};
const originalDesktopBridge = browserGlobals.omnimemoryDesktop;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDesktopBridge === undefined) delete browserGlobals.omnimemoryDesktop;
  else browserGlobals.omnimemoryDesktop = originalDesktopBridge;
});

describe('Phase 6 PWA assets', () => {
  it('contains the responsive application shell and existing API workflows', () => {
    const html = read('index.html');
    const app = read('app.js');
    const client = read('api-client.js');

    expect(html).toContain('manifest.webmanifest');
    expect(html).toContain('styles.css');
    expect(app).toContain("['dashboard', 'Dashboard'");
    expect(app).toContain("['handoffs', 'Handoffs'");
    expect(app).toContain('/projects/${state.projectId}/tasks');
    expect(app).toContain('/projects/${state.projectId}/handoffs');
    expect(app).toContain('/projects/${state.projectId}/memories/search');
    expect(app).toContain('Create your OmniMemory account');
    expect(app).toContain('passwordConfirmation');
    expect(app).not.toContain('name="setupCode"');
    expect(client).toContain("headers.set('Authorization'");
    expect(client).toContain('createOwner');
    expect(client).toContain('response.status === 401');
  });

  it('does not persist private API responses or credentials in the service worker', () => {
    const serviceWorker = read('sw.js');
    const manifest = JSON.parse(read('manifest.webmanifest')) as {
      start_url: string;
      icons: unknown[];
    };

    expect(serviceWorker).toContain("url.pathname.startsWith('/api/')");
    expect(serviceWorker).not.toContain('Authorization');
    expect(serviceWorker).not.toContain('localStorage');
    expect(manifest.start_url).toBe('/');
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  it('does not classify an unauthenticated setup-code rejection as an expired session', async () => {
    // @ts-expect-error The browser-only client is intentionally tested from Vitest.
    const { createApiClient } = await import('../public/api-client.js');
    const api = createApiClient('/api/v1');
    let unauthorizedCalls = 0;
    api.onUnauthorized(() => {
      unauthorizedCalls += 1;
    });
    globalThis.fetch = async () =>
      ({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'SETUP_CODE_INVALID' } }),
      }) as unknown as Response;

    await expect(
      api.post('/auth/setup', {
        setupCode: 'invalid',
        password: 'correct horse battery staple',
        deviceName: 'Owner PC',
        deviceType: 'windows',
      }),
    ).rejects.toMatchObject({
      code: 'SETUP_CODE_INVALID',
      message: 'The setup code is invalid, expired, or already used.',
    });
    expect(unauthorizedCalls).toBe(0);
  });

  it('still classifies a protected 401 as an expired authenticated session', async () => {
    // @ts-expect-error The browser-only client is intentionally tested from Vitest.
    const { createApiClient } = await import('../public/api-client.js');
    const api = createApiClient('/api/v1');
    let unauthorizedCalls = 0;
    api.onUnauthorized(() => {
      unauthorizedCalls += 1;
    });
    api.setToken('session-token');
    globalThis.fetch = async () =>
      ({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'UNAUTHORIZED' } }),
      }) as unknown as Response;

    await expect(api.get('/auth/me')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Your session expired. Sign in again.',
    });
    expect(unauthorizedCalls).toBe(1);
  });

  it('uses the trusted desktop bridge for first-owner creation instead of a browser API call', async () => {
    // @ts-expect-error The browser-only client is intentionally tested from Vitest.
    const { createApiClient } = await import('../public/api-client.js');
    const api = createApiClient('/api/v1');
    let submitted;
    browserGlobals.omnimemoryDesktop = {
      createOwner: async (body: Record<string, string>) => {
        submitted = body;
        return { ok: true, data: { token: 'session-token', role: 'owner' } };
      },
    };

    const session = await api.createOwner({
      password: 'correct horse battery staple',
      deviceName: 'Owner PC',
      deviceType: 'windows',
    });

    expect(session).toMatchObject({ role: 'owner' });
    expect(submitted).toEqual({
      password: 'correct horse battery staple',
      deviceName: 'Owner PC',
      deviceType: 'windows',
    });
  });
});

function read(file: string): string {
  return readFileSync(join(publicDirectory, file), 'utf8');
}
