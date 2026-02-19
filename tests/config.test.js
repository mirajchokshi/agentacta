const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');

describe('config', () => {
  const origEnv = { ...process.env };

  after(() => {
    // Restore env
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    Object.assign(process.env, origEnv);
  });

  it('env vars override defaults', () => {
    // Clear module cache to get fresh config
    delete require.cache[require.resolve('../config')];
    process.env.AGENTACTA_DB_PATH = '/tmp/override.db';
    process.env.PORT = '9999';
    process.env.AGENTACTA_STORAGE = 'archive';
    const { loadConfig } = require('../config');
    const config = loadConfig();
    assert.strictEqual(config.port, 9999);
    assert.strictEqual(config.storage, 'archive');
    assert.ok(config.dbPath.endsWith('override.db'));
    // Clean up
    delete process.env.AGENTACTA_DB_PATH;
    delete process.env.PORT;
    delete process.env.AGENTACTA_STORAGE;
    delete require.cache[require.resolve('../config')];
  });

  it('loadConfig returns expected defaults', () => {
    delete require.cache[require.resolve('../config')];
    delete process.env.PORT;
    delete process.env.AGENTACTA_STORAGE;
    delete process.env.AGENTACTA_DB_PATH;
    delete process.env.AGENTACTA_SESSIONS_PATH;
    const { loadConfig } = require('../config');
    const config = loadConfig();
    assert.strictEqual(config.port, 4003);
    assert.strictEqual(config.storage, 'reference');
  });
});
