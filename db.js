const Database = require('better-sqlite3');
const path = require('path');
const { loadConfig } = require('./config');

let _config = null;
function getConfig() {
  if (!_config) _config = loadConfig();
  return _config;
}

function open(dbPath) {
  const p = dbPath || getConfig().dbPath;
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function init(dbPath) {
  const db = open(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      start_time TEXT NOT NULL,
      end_time TEXT,
      message_count INTEGER DEFAULT 0,
      tool_count INTEGER DEFAULT 0,
      model TEXT,
      summary TEXT,
      agent TEXT,
      session_type TEXT,
      total_cost REAL DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      initial_prompt TEXT,
      first_message_id TEXT,
      first_message_timestamp TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      role TEXT,
      content TEXT,
      tool_name TEXT,
      tool_args TEXT,
      tool_result TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_tool_name ON events(tool_name);

    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      content, tool_name, tool_args,
      content='events',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, content, tool_name, tool_args)
      VALUES (new.rowid, new.content, new.tool_name, new.tool_args);
    END;

    CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, content, tool_name, tool_args)
      VALUES ('delete', old.rowid, old.content, old.tool_name, old.tool_args);
    END;

    CREATE TABLE IF NOT EXISTS index_state (
      file_path TEXT PRIMARY KEY,
      last_offset INTEGER DEFAULT 0,
      last_modified TEXT
    );

    CREATE TABLE IF NOT EXISTS file_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      operation TEXT NOT NULL,
      timestamp TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_file_activity_path ON file_activity(file_path);
    CREATE INDEX IF NOT EXISTS idx_file_activity_session ON file_activity(session_id);

    CREATE TABLE IF NOT EXISTS archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_archive_session ON archive(session_id);
  `);

  // Add columns if missing (migration)
  const cols = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
  if (!cols.includes('agent')) db.exec("ALTER TABLE sessions ADD COLUMN agent TEXT");
  if (!cols.includes('session_type')) db.exec("ALTER TABLE sessions ADD COLUMN session_type TEXT");
  if (!cols.includes('total_cost')) db.exec("ALTER TABLE sessions ADD COLUMN total_cost REAL DEFAULT 0");
  if (!cols.includes('total_tokens')) db.exec("ALTER TABLE sessions ADD COLUMN total_tokens INTEGER DEFAULT 0");
  if (!cols.includes('input_tokens')) db.exec("ALTER TABLE sessions ADD COLUMN input_tokens INTEGER DEFAULT 0");
  if (!cols.includes('output_tokens')) db.exec("ALTER TABLE sessions ADD COLUMN output_tokens INTEGER DEFAULT 0");
  if (!cols.includes('cache_read_tokens')) db.exec("ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER DEFAULT 0");
  if (!cols.includes('cache_write_tokens')) db.exec("ALTER TABLE sessions ADD COLUMN cache_write_tokens INTEGER DEFAULT 0");
  if (!cols.includes('models')) db.exec("ALTER TABLE sessions ADD COLUMN models TEXT");
  if (!cols.includes('projects')) db.exec("ALTER TABLE sessions ADD COLUMN projects TEXT");

  db.close();
}

function createStmts(db) {
  return {
    getState: db.prepare('SELECT * FROM index_state WHERE file_path = ?'),
    getSession: db.prepare('SELECT id FROM sessions WHERE id = ?'),
    deleteEvents: db.prepare('DELETE FROM events WHERE session_id = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    deleteFileActivity: db.prepare('DELETE FROM file_activity WHERE session_id = ?'),
    insertEvent: db.prepare(`INSERT OR REPLACE INTO events (id, session_id, timestamp, type, role, content, tool_name, tool_args, tool_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    upsertSession: db.prepare(`INSERT OR REPLACE INTO sessions (id, start_time, end_time, message_count, tool_count, model, summary, agent, session_type, total_cost, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, initial_prompt, first_message_id, first_message_timestamp, models, projects) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    upsertState: db.prepare(`INSERT OR REPLACE INTO index_state (file_path, last_offset, last_modified) VALUES (?, ?, ?)`),
    insertFileActivity: db.prepare(`INSERT INTO file_activity (session_id, file_path, operation, timestamp) VALUES (?, ?, ?, ?)`),
    deleteArchive: db.prepare('DELETE FROM archive WHERE session_id = ?'),
    insertArchive: db.prepare('INSERT INTO archive (session_id, line_number, raw_json) VALUES (?, ?, ?)')
  };
}

module.exports = { open, init, createStmts };
