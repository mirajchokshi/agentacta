import path from 'node:path';

export function isPathInside(root: string, candidate: string): boolean {
  const relative: string = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveStaticFile(publicRoot: string, requestUrl: string): string | null {
  const rawPath: string = (requestUrl || '/').split('?')[0] || '/';
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return null;
  }

  const requestedPath: string = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath: string = path.resolve(publicRoot, requestedPath);
  return isPathInside(publicRoot, filePath) ? filePath : null;
}
