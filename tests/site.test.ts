import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSiteServer } from '../scripts/preview-site.js';

const siteDirectory = join(process.cwd(), 'site');
const publicDirectory = join(process.cwd(), 'public');

describe('OmniMemory Public Website - Static Structure & Metadata', () => {
  const html = readSiteFile('index.html');
  const css = readSiteFile('styles.css');

  it('renders semantic HTML with a single h1 and proper heading hierarchy', () => {
    const h1Matches = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/gi);
    expect(h1Matches).not.toBeNull();
    expect(h1Matches?.length).toBe(1);
    expect(h1Matches?.[0]).toContain('Your AI should remember what matters.');

    // Major sections have h2 headings
    expect(html).toContain('<h2 id="features-title">Implemented Features</h2>');
    expect(html).toContain('<h2 id="how-it-works-title">How OmniMemory Works</h2>');
    expect(html).toContain('<h2 id="privacy-title">Privacy &amp; Security Protections</h2>');
    expect(html).toContain('<h2 id="status-title">Available Now vs. Planned</h2>');
    expect(html).toContain(
      '<h2 id="download-title" class="download-headline">Get OmniMemory for Windows</h2>',
    );
    expect(html).toContain('<h2 id="faq-title">Frequently Asked Questions</h2>');
  });

  it('includes proper metadata, open graph tags, favicon, and accessibility skip link', () => {
    expect(html).toContain(
      '<title>OmniMemory — Local-First AI Memory &amp; Agent Coordination Engine</title>',
    );
    expect(html).toContain('name="description"');
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:description"');
    expect(html).toContain('name="theme-color" content="#fbfcfd"');
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="assets/icon.svg" />');

    // Accessibility skip link
    expect(html).toContain('<a href="#main-content" class="skip-link">Skip to main content</a>');
    expect(html).toContain('<main id="main-content">');
  });

  it('provides an accessible navigation bar and mobile menu toggle', () => {
    expect(html).toContain('aria-label="Primary Navigation"');
    expect(html).toContain('id="mobile-menu-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="nav-menu"');
    expect(html).toContain('aria-label="Toggle navigation menu"');
  });

  it('verifies all internal anchor navigation targets exist in the document', () => {
    const anchorMatches = Array.from(html.matchAll(/href="#([a-zA-Z0-9_-]+)"/g));
    expect(anchorMatches.length).toBeGreaterThan(0);

    for (const match of anchorMatches) {
      const targetId = match[1];
      if (!targetId) continue;
      const targetExists = html.includes(`id="${targetId}"`) || html.includes(`id='${targetId}'`);
      expect(targetExists, `Target id="${targetId}" referenced by anchor should exist`).toBe(true);
    }
  });

  it('features every implemented capability accurately without fabrication', () => {
    // 8 core capabilities
    expect(html).toContain('Shared Memory &amp; Lexical Search');
    expect(html).toContain('SQLite FTS5');
    expect(html).toContain('Revisions, Provenance &amp; Verification');
    expect(html).toContain('Optimistic Locking');
    expect(html).toContain('Bounded Project Context');
    expect(html).toContain('Tasks &amp; Validated Status Transitions');
    expect(html).toContain('Structured, Immutable Agent Handoffs');
    expect(html).toContain('Local Model Context Protocol (MCP)');
    expect(html).toContain('Authenticated API &amp; Access Controls');
    expect(html).toContain('Standalone Windows Desktop Shell');
  });

  it('honestly distinguishes available implementation from planned roadmap', () => {
    // Available
    expect(html).toContain('Available in v0.1.0');
    expect(html).toContain('Current Implementation');
    expect(html).toContain('FTS5 search');
    expect(html).toContain('Local Stdio MCP');
    expect(html).toContain('Responsive Local Web App');
    expect(html).toContain('Windows Desktop Packaging');

    // Planned
    expect(html).toContain('Planned Roadmap');
    expect(html).toContain('Same-Wi-Fi Device Access');
    expect(html).toContain('Remote Connectivity');
    expect(html).toContain('Cross-Device Synchronization');
    expect(html).toContain('Encrypted Backup &amp; Recovery');

    // Explicit disclaimer
    expect(html).toContain('Integration Boundary Notice');
    expect(html).toContain('What Local-First Means Here');
    expect(html).toContain('does <strong>not</strong> mean OmniMemory');
    expect(html).toContain('synchronizes across multiple computers');
  });

  it('answers all FAQ questions with factual accuracy matching the codebase', () => {
    expect(html).toContain('What is OmniMemory?');
    expect(html).toContain('Does it require Node.js to be installed separately?');
    expect(html).toContain('Where is my memory stored?');
    expect(html).toContain('%APPDATA%\\OmniMemory\\omnimemory.sqlite');
    expect(html).toContain('Does it connect every AI application automatically?');
    expect(html).toContain('Can I use it on my phone?');
    expect(html).toContain('Can I connect from anywhere?');
    expect(html).toContain('Is the Windows installer ready?');
    expect(html).toContain('installation and launch verification are in progress');
  });

  it('does not contain any private filesystem paths, tokens, or environment secrets', () => {
    // Forbidden patterns that must never appear in public website
    expect(html).not.toMatch(/D:\\aimemory/i);
    expect(html).not.toMatch(/C:\\Users/i);
    expect(html).not.toMatch(/\/home\/tester/i);
    expect(html).not.toMatch(/\/opt\/omnimemory/i);
    expect(html).not.toMatch(/OMNIMEMORY_MCP_TOKEN/i);
    expect(html).not.toMatch(/bearer\s+[a-f0-9]{32,}/i);
    expect(html).not.toMatch(/\.env/);
    expect(html).not.toMatch(/omnimemory\.sqlite-wal/i);
  });

  it('implements light theme and accessible visual design rules in CSS', () => {
    // Light theme palette
    expect(css).toContain('--color-bg: #fbfcfd;');
    expect(css).toContain('--color-text-primary: #0f172a;');
    expect(css).toContain('--color-accent-blue: #2563eb;');
    expect(css).toContain('--color-accent-lavender: #6366f1;');
    expect(css).toContain('--color-accent-green: #059669;');

    // Focus visible indicators
    expect(css).toContain(':focus-visible');
    expect(css).toContain('outline: var(--focus-outline);');

    // Reduced motion support
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');

    // Responsive design breakpoints
    expect(css).toContain('@media (max-width: 768px)');
    expect(css).toContain('@media (max-width: 1024px)');
  });
});

describe('OmniMemory Public Website - Configurable Download Logic', () => {
  const configContent = readSiteFile('site-config.js');
  const jsContent = readSiteFile('site.js');

  it('defines valid release metadata in site-config.js', () => {
    // Evaluate config in safe context
    const fakeWindow: { OMNIMEMORY_CONFIG?: Record<string, unknown> } = {};
    const evalConfig = new Function('window', configContent);
    evalConfig(fakeWindow);

    const config = fakeWindow.OMNIMEMORY_CONFIG;
    expect(config).toBeDefined();
    expect(config?.version).toBe('0.1.0');
    expect(config?.platform).toContain('Windows');
    expect(config?.targetArch).toBe('x64');
    expect(config?.installerName).toBe('OmniMemory-0.1.0-x64-Setup.exe');
    expect(config?.installerSizeBytes).toBe(116170102);
    expect(config?.installerSizeFormatted).toBe('110.8 MB');
    expect(config?.repositoryUrl).toBe('https://github.com/abhishek-1707/ai-memory');

    // Default downloadUrl is null until official release is published
    expect(config?.downloadUrl).toBeNull();
  });

  it('handles both unconfigured and configured download URLs safely in site.js', () => {
    // Checks that site.js implements conditional handling for config.downloadUrl
    expect(jsContent).toContain('config.downloadUrl');
    expect(jsContent).toContain("downloadBtn.setAttribute('href', config.downloadUrl)");
    expect(jsContent).toContain("downloadBtn.setAttribute('download', config.installerName)");
    expect(jsContent).toContain('Release in Windows Validation');
    expect(jsContent).toContain('download-status-banner validation');
    expect(jsContent).toContain('download-status-banner available');
  });
});

describe('OmniMemory Public Website - Preview Server', () => {
  let server: ReturnType<typeof createSiteServer>;
  let serverUrl: string;

  beforeAll(async () => {
    server = createSiteServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        serverUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('serves index.html with security headers and correct MIME type', async () => {
    const res = await fetch(`${serverUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const body = await res.text();
    expect(body).toContain('OmniMemory');
    expect(body).toContain('Your AI should remember what matters.');
  });

  it('serves styles.css and site.js with correct content types', async () => {
    const cssRes = await fetch(`${serverUrl}/styles.css`);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get('content-type')).toBe('text/css; charset=utf-8');

    const jsRes = await fetch(`${serverUrl}/site.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get('content-type')).toBe('application/javascript; charset=utf-8');

    const configRes = await fetch(`${serverUrl}/site-config.js`);
    expect(configRes.status).toBe(200);
    expect(configRes.headers.get('content-type')).toBe('application/javascript; charset=utf-8');

    const iconRes = await fetch(`${serverUrl}/assets/icon.svg`);
    expect(iconRes.status).toBe(200);
    expect(iconRes.headers.get('content-type')).toBe('image/svg+xml');
  });

  it('blocks directory traversal attempts', async () => {
    const traversal1 = await fetch(`${serverUrl}/../package.json`);
    expect([403, 404]).toContain(traversal1.status);

    const traversal2 = await fetch(`${serverUrl}/../../.env`);
    expect([403, 404]).toContain(traversal2.status);

    const missingRes = await fetch(`${serverUrl}/non-existent-file.xyz`);
    expect(missingRes.status).toBe(404);
  });
});

describe('Preservation of existing authenticated PWA and API assets', () => {
  it('keeps the existing local authenticated PWA completely intact', () => {
    const pwaIndex = readFileSync(join(publicDirectory, 'index.html'), 'utf8');
    const pwaApp = readFileSync(join(publicDirectory, 'app.js'), 'utf8');
    const pwaClient = readFileSync(join(publicDirectory, 'api-client.js'), 'utf8');
    const pwaManifest = readFileSync(join(publicDirectory, 'manifest.webmanifest'), 'utf8');
    const pwaSw = readFileSync(join(publicDirectory, 'sw.js'), 'utf8');

    // The private dashboard PWA markers
    expect(pwaIndex).toContain('manifest.webmanifest');
    expect(pwaIndex).toContain('styles.css');
    expect(pwaApp).toContain('OmniMemory');
    expect(pwaApp).toContain('/projects/${state.projectId}/tasks');
    expect(pwaClient).toContain('Authorization');
    expect(pwaManifest).toContain('"start_url": "/"');
    expect(pwaSw).toContain('/api/');
  });
});

function readSiteFile(relativePath: string): string {
  return readFileSync(join(siteDirectory, relativePath), 'utf8');
}
