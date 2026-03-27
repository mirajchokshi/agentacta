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

const KNOWN_SESSION_DIRS = [
  path.join(os.homedir(), '.claude', 'projects'),    // Claude Code
  path.join(os.homedir(), '.codex', 'sessions'),     // Codex CLI
  path.join(os.homedir(), '.openclaw', 'sessions'),  // OpenClaw
];

const DEFAULTS = {
  port: 4003,
  storage: 'reference',
  sessionsPath: null,
  dbPath: './agentacta.db',
  projectAliases: {}
};

function detectSessionDirs() {
  const found = KNOWN_SESSION_DIRS.filter(d => fs.existsSync(d));
  return found.length > 0 ? found : null;
}

function loadConfig() {
  let fileConfig = {};

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      console.error(`Warning: Could not parse ${CONFIG_FILE}:`, err.message);
    }
  } else {
    // First-run: create default config with auto-detected session dirs
    const detected = detectSessionDirs();
    const firstRunDefaults = { ...DEFAULTS, sessionsPath: detected };
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(firstRunDefaults, null, 2) + '\n');
    // Apply to in-memory config so this run also benefits
    fileConfig = firstRunDefaults;
    console.log(`Created default config: ${CONFIG_FILE}`);
    if (detected) {
      console.log(`Auto-detected session directories:\n${detected.map(d => `  - ${d}`).join('\n')}`);
    }
  }

  // In demo mode, ignore file-based sessionsPath so live data doesn't bleed in
  if (process.env.AGENTACTA_DEMO_MODE) delete fileConfig.sessionsPath;
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
