import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await derive(password, salt);
  return [
    'scrypt',
    String(SCRYPT_OPTIONS.N),
    String(SCRYPT_OPTIONS.r),
    String(SCRYPT_OPTIONS.p),
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const parts = encodedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, n, r, p, encodedSalt, encodedExpected] = parts;
  const cost = Number(n);
  const blockSize = Number(r);
  const parallelism = Number(p);
  if (
    !Number.isSafeInteger(cost) ||
    !Number.isSafeInteger(blockSize) ||
    !Number.isSafeInteger(parallelism) ||
    cost <= 1 ||
    blockSize <= 0 ||
    parallelism <= 0
  ) {
    return false;
  }
  const salt = Buffer.from(encodedSalt ?? '', 'base64url');
  const expected = Buffer.from(encodedExpected ?? '', 'base64url');
  if (salt.length === 0 || expected.length !== KEY_LENGTH) {
    return false;
  }

  let derived: Buffer;
  try {
    derived = await derive(password, salt, {
      N: cost,
      r: blockSize,
      p: parallelism,
      maxmem: SCRYPT_OPTIONS.maxmem,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function derive(
  password: string,
  salt: Buffer,
  options: {
    readonly N: number;
    readonly r: number;
    readonly p: number;
    readonly maxmem: number;
  } = SCRYPT_OPTIONS,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey as Buffer);
    });
  });
}
