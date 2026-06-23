import { describe, it } from 'node:test';
import assert from 'node:assert';

import { isIsoDate } from '../src/date-utils.js';

describe('date utils', () => {
  it('accepts valid ISO calendar dates', () => {
    assert.strictEqual(isIsoDate('2026-06-23'), true);
    assert.strictEqual(isIsoDate('2024-02-29'), true);
  });

  it('rejects invalid or non-normalized dates', () => {
    assert.strictEqual(isIsoDate('2026-2-3'), false);
    assert.strictEqual(isIsoDate('2026-02-30'), false);
    assert.strictEqual(isIsoDate('not-a-date'), false);
  });
});

