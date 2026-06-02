import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';

import { isPathInside, resolveStaticFile } from '../src/static-files.js';

const PUBLIC_ROOT = path.resolve('/tmp/agentacta-public');

describe('static file path containment', () => {
  it('resolves the root route to index.html', () => {
    assert.strictEqual(resolveStaticFile(PUBLIC_ROOT, '/'), path.join(PUBLIC_ROOT, 'index.html'));
  });

  it('resolves normal static asset paths inside the public root', () => {
    assert.strictEqual(resolveStaticFile(PUBLIC_ROOT, '/app.js?cache=1'), path.join(PUBLIC_ROOT, 'app.js'));
  });

  it('rejects dot-dot traversal outside the public root', () => {
    assert.strictEqual(resolveStaticFile(PUBLIC_ROOT, '/../secret.txt'), null);
  });

  it('rejects encoded traversal outside the public root', () => {
    assert.strictEqual(resolveStaticFile(PUBLIC_ROOT, '/%2e%2e/secret.txt'), null);
  });

  it('rejects same-prefix sibling paths', () => {
    const sibling = path.resolve('/tmp/agentacta-publicevil/app.js');
    assert.strictEqual(isPathInside(PUBLIC_ROOT, sibling), false);
  });
});
