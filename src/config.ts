import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentActaConfig } from './types.js';

const CWD_CONFIG_FILE: string = path.join(process.cwd(), 'agentacta.config.json');
const XDG_CONFIG_DIR: string = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'agentacta');
const XDG_CONFIG_FILE: string = path.join(XDG_CONFIG_DIR, 'config.json');

// Resolve config file: CWD first (backward compat), then XDG default
function resolveConfigFile(): string {
  if (fs.existsSync(CWD_CONFIG_FILE)) return CWD_CONFIG_FILE;
  return XDG_CONFIG_FILE;
}

const CONFIG_FILE: string = resolveConfigFile();

const KNOWN_SESSION_DIRS: string[] = [
  path.join(os.homedir(), '.claude', 'projects'),    // Claude Code
  path.join(os.homedir(), '.codex', 'sessions'),     // Codex CLI
  path.join(os.homedir(), '.openclaw', 'sessions'),  // OpenClaw
];

const DEFAULTS: AgentActaConfig = {
  port: 4003,
  storage: 'reference',
  sessionsPath: null,
  dbPath: './agentacta.db',
  projectAliases: {}
};

function detectSessionDirs(): string[] | null {
  const found: string[] = KNOWN_SESSION_DIRS.filter((d: string) => fs.existsSync(d));
  return found.length > 0 ? found : null;
}

function loadConfig(): AgentActaConfig {
  let fileConfig: Partial<AgentActaConfig> = {};

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<AgentActaConfig>;
    } catch (err) {
      console.error(`Warning: Could not parse ${CONFIG_FILE}:`, (err as Error).message);
    }
  } else {
    // First-run: create default config with auto-detected session dirs
    const detected: string[] | null = detectSessionDirs();
    const firstRunDefaults: AgentActaConfig = { ...DEFAULTS, sessionsPath: detected };
    const dir: string = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(firstRunDefaults, null, 2) + '\n');
    // Apply to in-memory config so this run also benefits
    fileConfig = firstRunDefaults;
    console.log(`Created default config: ${CONFIG_FILE}`);
    if (detected) {
      console.log(`Auto-detected session directories:\n${detected.map((d: string) => `  - ${d}`).join('\n')}`);
    }
  }

  // In demo mode, ignore file-based sessionsPath so live data doesn't bleed in
  if (process.env.AGENTACTA_DEMO_MODE) delete fileConfig.sessionsPath;
  const config: AgentActaConfig = { ...DEFAULTS, ...fileConfig };

  // Env var overrides (highest priority)
  if (process.env.PORT) config.port = parseInt(process.env.PORT);
  if (process.env.AGENTACTA_STORAGE) config.storage = process.env.AGENTACTA_STORAGE;
  if (process.env.AGENTACTA_SESSIONS_PATH) config.sessionsPath = process.env.AGENTACTA_SESSIONS_PATH;
  if (process.env.AGENTACTA_DB_PATH) config.dbPath = process.env.AGENTACTA_DB_PATH;
  if (process.env.AGENTACTA_PROJECT_ALIASES_JSON) {
    try {
      config.projectAliases = JSON.parse(process.env.AGENTACTA_PROJECT_ALIASES_JSON) as Record<string, string>;
    } catch (err) {
      console.error('Warning: Could not parse AGENTACTA_PROJECT_ALIASES_JSON:', (err as Error).message);
    }
  }

  // Resolve dbPath relative to cwd
  config.dbPath = path.resolve(config.dbPath);
  if (!config.projectAliases || typeof config.projectAliases !== 'object') config.projectAliases = {};

  return config;
}

export { loadConfig, CONFIG_FILE };
// v1.1.3
