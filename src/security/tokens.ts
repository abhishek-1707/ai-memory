import { createHash, randomBytes } from 'node:crypto';

export function createOpaqueToken(): { readonly raw: string; readonly hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashOpaqueToken(raw) };
}

export function hashOpaqueToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
