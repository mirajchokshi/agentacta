import path from 'path';

const DATE_KEY_RE: RegExp = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when `date` is a real calendar day in `YYYY-MM-DD` form.
 * Rejects malformed strings and impossible dates like `2026-02-30`.
 */
export function isValidDateKey(date: string): boolean {
  if (!DATE_KEY_RE.test(date)) return false;
  const year: number = Number(date.slice(0, 4));
  const month: number = Number(date.slice(5, 7));
  const day: number = Number(date.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const parsed: Date = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

/**
 * Resolve a request pathname inside `root`, or null when it escapes.
 *
 * Containment is checked with `path.relative` rather than a prefix match, so
 * sibling directories that share the root's prefix (`public` vs `publicevil`)
 * are rejected along with plain and percent-encoded traversal.
 */
export function resolveStaticPath(root: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath.split('?')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const relativeRequest: string = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (!relativeRequest) return null;

  const resolved: string = path.resolve(root, relativeRequest);
  const rel: string = path.relative(root, resolved);
  if (!rel) return null;
  if (path.isAbsolute(rel)) return null;
  if (rel === '..' || rel.startsWith('..' + path.sep)) return null;
  return resolved;
}
