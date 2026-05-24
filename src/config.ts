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
const VALID_STORAGE_MODES: ReadonlySet<string> = new Set(['reference', 'archive']);

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
  projectAliases: {},
  authToken: null
};

function detectSessionDirs(): string[] | null {
  const found: string[] = KNOWN_SESSION_DIRS.filter((d: string) => fs.existsSync(d));
  return found.length > 0 ? found : null;
}

function normalizeSessionsPath(value: unknown): string | string[] | null {
  if (Array.isArray(value)) {
    const paths = value.filter((entry: unknown): entry is string => typeof entry === 'string')
      .map((entry: string) => entry.trim())
      .filter(Boolean);
    return paths.length ? paths : null;
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('[')) {
    try {
      return normalizeSessionsPath(JSON.parse(trimmed));
    } catch (err) {
      console.error('Warning: Could not parse sessionsPath JSON array:', (err as Error).message);
      return null;
    }
  }

  if (trimmed.includes(path.delimiter)) {
    const paths = trimmed.split(path.delimiter).map((entry: string) => entry.trim()).filter(Boolean);
    return paths.length ? paths : null;
  }

  return trimmed;
}

function normalizePort(value: unknown, fallback: number): number {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  console.error(`Warning: Invalid port ${JSON.stringify(value)}. Falling back to ${fallback}.`);
  return fallback;
}

function normalizeStorage(value: unknown, fallback: AgentActaConfig['storage']): AgentActaConfig['storage'] {
  if (typeof value === 'string' && VALID_STORAGE_MODES.has(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    console.error(`Warning: Invalid storage mode ${JSON.stringify(value)}. Falling back to ${fallback}.`);
  }
  return fallback;
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

  config.sessionsPath = normalizeSessionsPath(config.sessionsPath);
  config.port = normalizePort(config.port, DEFAULTS.port);
  config.storage = normalizeStorage(config.storage, DEFAULTS.storage);

  // Env var overrides (highest priority)
  if (process.env.PORT) config.port = normalizePort(process.env.PORT, config.port);
  if (process.env.AGENTACTA_STORAGE) config.storage = normalizeStorage(process.env.AGENTACTA_STORAGE, config.storage);
  if (process.env.AGENTACTA_SESSIONS_PATH) config.sessionsPath = normalizeSessionsPath(process.env.AGENTACTA_SESSIONS_PATH);
  if (process.env.AGENTACTA_DB_PATH) config.dbPath = process.env.AGENTACTA_DB_PATH;
  if (process.env.AGENTACTA_AUTH_TOKEN) config.authToken = process.env.AGENTACTA_AUTH_TOKEN;
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
