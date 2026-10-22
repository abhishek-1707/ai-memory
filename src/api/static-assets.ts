import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { NotFoundError } from '../errors.js';

const STATIC_ASSETS = [
  { route: '/', file: 'index.html', contentType: 'text/html; charset=utf-8' },
  { route: '/app.js', file: 'app.js', contentType: 'application/javascript; charset=utf-8' },
  {
    route: '/api-client.js',
    file: 'api-client.js',
    contentType: 'application/javascript; charset=utf-8',
  },
  { route: '/styles.css', file: 'styles.css', contentType: 'text/css; charset=utf-8' },
  {
    route: '/manifest.webmanifest',
    file: 'manifest.webmanifest',
    contentType: 'application/manifest+json',
  },
  { route: '/sw.js', file: 'sw.js', contentType: 'application/javascript; charset=utf-8' },
  { route: '/icon.svg', file: 'icon.svg', contentType: 'image/svg+xml' },
] as const;

export const STATIC_ASSET_ROUTES: readonly string[] = STATIC_ASSETS.map((asset) => asset.route);

export function registerStaticAssetRoutes(app: FastifyInstance, publicDirectory: string): void {
  for (const asset of STATIC_ASSETS) {
    app.get(asset.route, async (_request, reply) => {
      try {
        const content = await readFile(join(publicDirectory, asset.file));
        return reply.type(asset.contentType).send(content);
      } catch (error) {
        if (isMissingFileError(error)) {
          throw new NotFoundError('Static asset', asset.file);
        }
        throw error;
      }
    });
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
