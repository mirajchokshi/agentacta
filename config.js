const fs = require('fs');
const path = require('path');
const os = require('os');

const CWD_CONFIG_FILE = path.join(process.cwd(), 'agentacta.config.json');
const XDG_CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'agentacta');
const XDG_CONFIG_FILE = path.join(XDG_CONFIG_DIR, 'config.json');

// Resolve config file: CWD first (backward compat), then XDG default
function resolveConfigFile() {
  if (fs.existsSync(CWD_CONFIG_FILE)) return CWD_CONFIG_FILE;
  return XDG_CONFIG_FILE;
}

const CONFIG_FILE = resolveConfigFile();

const DEFAULTS = {
  port: 4003,
  storage: 'reference',
  sessionsPath: null,
  dbPath: './agentacta.db',
  projectAliases: {}
};

function loadConfig() {
  let fileConfig = {};

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      console.error(`Warning: Could not parse ${CONFIG_FILE}:`, err.message);
    }
  } else {
    // First-run: create default config in XDG location
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n');
    console.log(`Created default config: ${CONFIG_FILE}`);
  }

  const config = { ...DEFAULTS, ...fileConfig };

  // Env var overrides (highest priority)
  if (process.env.PORT) config.port = parseInt(process.env.PORT);
  if (process.env.AGENTACTA_STORAGE) config.storage = process.env.AGENTACTA_STORAGE;
  if (process.env.AGENTACTA_SESSIONS_PATH) config.sessionsPath = process.env.AGENTACTA_SESSIONS_PATH;
  if (process.env.AGENTACTA_DB_PATH) config.dbPath = process.env.AGENTACTA_DB_PATH;
  if (process.env.AGENTACTA_PROJECT_ALIASES_JSON) {
    try {
      config.projectAliases = JSON.parse(process.env.AGENTACTA_PROJECT_ALIASES_JSON);
    } catch (err) {
      console.error('Warning: Could not parse AGENTACTA_PROJECT_ALIASES_JSON:', err.message);
    }
  }

  // Resolve dbPath relative to cwd
  config.dbPath = path.resolve(config.dbPath);
  if (!config.projectAliases || typeof config.projectAliases !== 'object') config.projectAliases = {};

  return config;
}

module.exports = { loadConfig, CONFIG_FILE };
// v1.1.3
