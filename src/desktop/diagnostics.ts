import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeDesktopDiagnostic(
  filePath: string,
  event: string,
  fields: Readonly<Record<string, string | number | boolean | undefined>> = {},
): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields });
    appendFileSync(filePath, `${redact(line)}\n`, { encoding: 'utf8' });
  } catch {
    // Diagnostics must never prevent startup failure handling.
  }
}

function redact(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^"\s]+/gi, '$1<redacted>')
    .replace(/(omnimemory_startup_token\s*[:=]\s*)[^"\s]+/gi, '$1<redacted>')
    .replace(/\b[a-f0-9]{32,}\b/gi, '<redacted>');
}
