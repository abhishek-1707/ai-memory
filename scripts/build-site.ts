import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SITE_SRC = resolve(process.cwd(), 'site');
const SITE_DIST = resolve(process.cwd(), 'dist-site');

const REQUIRED_FILES = ['index.html', 'styles.css', 'site.js', 'site-config.js', 'assets/icon.svg'];

export async function buildSite(): Promise<{
  success: boolean;
  filesBuilt: number;
  distPath: string;
}> {
  console.log('[site:build] Validating public website source assets...');

  // 1. Verify all required files exist and are non-empty
  for (const relativePath of REQUIRED_FILES) {
    const fullPath = join(SITE_SRC, relativePath);
    const fileStat = await stat(fullPath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      throw new Error(`Missing required website asset: ${relativePath} at ${fullPath}`);
    }
    if (fileStat.size === 0) {
      throw new Error(`Asset is empty: ${relativePath}`);
    }
  }

  // 2. Validate index.html content integrity
  const htmlContent = await readFile(join(SITE_SRC, 'index.html'), 'utf8');

  // Verify key headings and sections
  const requiredMarkers = [
    'id="hero"',
    'id="features"',
    'id="how-it-works"',
    'id="privacy"',
    'id="status"',
    'id="download"',
    'id="faq"',
    'id="main-content"',
    'class="skip-link"',
  ];

  for (const marker of requiredMarkers) {
    if (!htmlContent.includes(marker)) {
      throw new Error(`index.html is missing required accessibility/structure marker: ${marker}`);
    }
  }

  // Check for accidental leakage of private absolute paths
  const forbiddenPatterns = [
    /D:\\aimemory/i,
    /C:\\Users/i,
    /\/home\/tester/i,
    /\/opt\/omnimemory/i,
    /OMNIMEMORY_MCP_TOKEN/i,
    /bearer\s+[a-f0-9]{32,}/i,
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(htmlContent)) {
      throw new Error(
        `Security validation failure: index.html contains forbidden pattern matching ${pattern}`,
      );
    }
  }

  // 3. Clean and prepare dist-site directory
  await rm(SITE_DIST, { recursive: true, force: true });
  await mkdir(SITE_DIST, { recursive: true });

  // 4. Copy static site assets to dist-site
  await cp(SITE_SRC, SITE_DIST, { recursive: true });

  console.log(`[site:build] Successfully validated and exported website to: ${SITE_DIST}`);
  return {
    success: true,
    filesBuilt: REQUIRED_FILES.length,
    distPath: SITE_DIST,
  };
}

if (process.argv[1] && process.argv[1].endsWith('build-site.ts')) {
  buildSite()
    .then((result) => {
      console.log(
        `[site:build] Done. Built ${result.filesBuilt} core assets into ${result.distPath}`,
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error('[site:build] Error:', err.message);
      process.exit(1);
    });
}
