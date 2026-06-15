import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import vm from 'vm';

describe('public app rendering helpers', () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const escHtmlSource = source.match(/function escHtml\(s\) \{[\s\S]*?\n\}/)?.[0];

  it('escapes quotes for values rendered into HTML attributes', () => {
    assert.ok(escHtmlSource, 'escHtml function not found');
    const context: { escHtml?: (value: string) => string } = {};
    vm.createContext(context);
    vm.runInContext(escHtmlSource!, context);

    assert.strictEqual(
      context.escHtml!(`"'><script>alert(1)</script>&`),
      '&quot;&#39;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;'
    );
  });

  it('escapes quick-search suggestions before injecting text and data attributes', () => {
    assert.match(
      source,
      /suggestions\.map\(s => `<span class="suggestion-chip" data-q="\$\{escHtml\(s\)\}">\$\{escHtml\(s\)\}<\/span>`\)/
    );
  });
});
