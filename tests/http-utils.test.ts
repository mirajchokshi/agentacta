import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'path';

import { isValidDateKey, resolveStaticPath } from '../src/http-utils.js';

const PUBLIC = path.resolve('/srv/agentacta/public');

describe('isValidDateKey', () => {
  it('accepts well-formed calendar dates', () => {
    assert.strictEqual(isValidDateKey('2026-01-01'), true);
    assert.strictEqual(isValidDateKey('2024-02-29'), true);
    assert.strictEqual(isValidDateKey('1999-12-31'), true);
  });

  it('rejects malformed strings', () => {
    for (const bad of ['not-a-date', '', '2026-1-1', '2026/01/01', '2026-01-01T00:00:00', ' 2026-01-01', '20260101']) {
      assert.strictEqual(isValidDateKey(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  it('rejects impossible calendar dates', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2025-02-29']) {
      assert.strictEqual(isValidDateKey(bad), false, `expected ${bad} to be rejected`);
    }
  });
});

describe('resolveStaticPath', () => {
  it('maps / to index.html', () => {
    assert.strictEqual(resolveStaticPath(PUBLIC, '/'), path.join(PUBLIC, 'index.html'));
  });

  it('resolves normal assets inside the root', () => {
    assert.strictEqual(resolveStaticPath(PUBLIC, '/app.js'), path.join(PUBLIC, 'app.js'));
    assert.strictEqual(resolveStaticPath(PUBLIC, '/icons/logo.svg'), path.join(PUBLIC, 'icons', 'logo.svg'));
  });

  it('decodes percent-encoded filenames', () => {
    assert.strictEqual(resolveStaticPath(PUBLIC, '/my%20file.css'), path.join(PUBLIC, 'my file.css'));
  });

  it('rejects plain traversal', () => {
    assert.strictEqual(resolveStaticPath(PUBLIC, '/../package.json'), null);
    assert.strictEqual(resolveStaticPath(PUBLIC, '/a/../../secrets.env'), null);
  });

  it('rejects percent-encoded traversal', () => {
    assert.strictEqual(resolveStaticPath(PUBLIC, '/%2e%2e/package.json'), null);
    assert.strictEqual(resolveStaticPath(PUBLIC, '/..%2Fpackage.json'), null);
  });

  it('rejects same-prefix sibling directories', () => {
    assert.strictEqual(resolveStaticPath(PUBLIC, '/../publicevil/app.js'), null);
  });

  it('rejects malformed encoding and null bytes', () => {
    assert.strictEqual(resolveStaticPath(PUBLIC, '/%E0%A4%A'), null);
    assert.strictEqual(resolveStaticPath(PUBLIC, '/app.js%00.png'), null);
  });

  it('rejects the root itself', () => {
    assert.strictEqual(resolveStaticPath(PUBLIC, '/..'), null);
  });
});
