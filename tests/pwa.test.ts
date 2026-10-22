import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const publicDirectory = join(process.cwd(), 'public');

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
    expect(client).toContain("headers.set('Authorization'");
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
});

function read(file: string): string {
  return readFileSync(join(publicDirectory, file), 'utf8');
}
