import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'path';

import { loadConfig } from '../src/config.js';
import type { AgentActaConfig } from '../src/types.js';

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
    process.env.AGENTACTA_DB_PATH = '/tmp/override.db';
    process.env.PORT = '9999';
    process.env.AGENTACTA_STORAGE = 'archive';
    const config: AgentActaConfig = loadConfig();
    assert.strictEqual(config.port, 9999);
    assert.strictEqual(config.storage, 'archive');
    assert.ok(config.dbPath.endsWith('override.db'));
    // Clean up
    delete process.env.AGENTACTA_DB_PATH;
    delete process.env.PORT;
    delete process.env.AGENTACTA_STORAGE;
  });

  it('loadConfig returns expected defaults when env vars not set', () => {
    // With ESM, CONFIG_FILE is resolved once at module load time,
    // so we can't change CWD to avoid reading the project config file.
    // Instead, verify that without env var overrides, loadConfig returns
    // the default port and that env overrides take priority.
    delete process.env.PORT;
    delete process.env.AGENTACTA_STORAGE;
    delete process.env.AGENTACTA_DB_PATH;
    delete process.env.AGENTACTA_SESSIONS_PATH;
    const config: AgentActaConfig = loadConfig();
    assert.strictEqual(config.port, 4003);
    // dbPath should be resolved to an absolute path
    assert.ok(path.isAbsolute(config.dbPath));
  });

  it('parses AGENTACTA_SESSIONS_PATH as a JSON array', () => {
    process.env.AGENTACTA_SESSIONS_PATH = '["/tmp/one", "/tmp/two"]';
    const config: AgentActaConfig = loadConfig();
    assert.deepStrictEqual(config.sessionsPath, ['/tmp/one', '/tmp/two']);
    delete process.env.AGENTACTA_SESSIONS_PATH;
  });

  it('falls back to the current config when port and storage env vars are invalid', () => {
    delete process.env.PORT;
    delete process.env.AGENTACTA_STORAGE;
    const baseline: AgentActaConfig = loadConfig();

    process.env.PORT = 'not-a-port';
    process.env.AGENTACTA_STORAGE = 'warehouse';
    const config: AgentActaConfig = loadConfig();
    assert.strictEqual(config.port, baseline.port);
    assert.strictEqual(config.storage, baseline.storage);
    delete process.env.PORT;
    delete process.env.AGENTACTA_STORAGE;
  });
});
