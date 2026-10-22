import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const SITE_DIRECTORY = resolve(process.cwd(), 'site');
const PORT = Number(process.env.OMNIMEMORY_SITE_PORT || 4173);
const HOST = '127.0.0.1';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export function createSiteServer() {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }

    try {
      const parsedUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
      let pathname = decodeURIComponent(parsedUrl.pathname);

      if (pathname === '/' || pathname === '') {
        pathname = '/index.html';
      }

      // Prevent directory traversal
      const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      const filePath = join(SITE_DIRECTORY, safePath);

      // Verify the resolved path stays strictly inside SITE_DIRECTORY
      if (!filePath.startsWith(SITE_DIRECTORY)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }

      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat || !fileStat.isFile()) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('404 Not Found');
        return;
      }

      const ext = extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      const content = await readFile(filePath);
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', content.byteLength);

      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(content);
      }
    } catch (error) {
      console.error('Preview server error:', error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Internal Server Error');
    }
  });
}

// When executed directly via CLI
if (process.argv[1] && process.argv[1].endsWith('preview-site.ts')) {
  const server = createSiteServer();
  server.listen(PORT, HOST, () => {
    console.log(`\n======================================================`);
    console.log(`  OmniMemory Public Website Preview`);
    console.log(`  URL: http://${HOST}:${PORT}/`);
    console.log(`  Directory: ${SITE_DIRECTORY}`);
    console.log(`======================================================\n`);
  });

  const shutdown = () => {
    server.close(() => {
      console.log('Preview server stopped.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
