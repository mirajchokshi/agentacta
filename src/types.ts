import type Database from 'better-sqlite3';

// ─── Config ──────────────────────────────────────────────────────────
export interface AgentActaConfig {
  port: number;
  storage: string;
  sessionsPath: string | string[] | null;
  dbPath: string;
  projectAliases: Record<string, string>;
  authToken?: string | null;
}

// ─── Database row types ──────────────────────────────────────────────
export interface SessionRow {
  id: string;
  start_time: string;
  end_time: string | null;
  message_count: number;
  tool_count: number;
  model: string | null;
  summary: string | null;
  agent: string | null;
  session_type: string | null;
  total_cost: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  initial_prompt: string | null;
  first_message_id: string | null;
  first_message_timestamp: string | null;
  models: string | null;
  projects: string | null;
}

export interface EventRow {
  id: string;
  session_id: string;
  timestamp: string;
  type: string;
  role: string | null;
  content: string | null;
  tool_name: string | null;
  tool_args: string | null;
  tool_result: string | null;
}

export interface FileActivityRow {
  id: number;
  session_id: string;
  file_path: string;
  operation: string;
  timestamp: string | null;
}

export interface IndexStateRow {
  file_path: string;
  last_offset: number;
  last_modified: string | null;
}

export interface ArchiveRow {
  id: number;
  session_id: string;
  line_number: number;
  raw_json: string;
}

export interface SessionInsightRow {
  session_id: string;
  signals: string;
  confusion_score: number;
  flagged: number;
  computed_at: string | null;
}

export interface SessionInsightJoinedRow extends SessionInsightRow {
  summary: string | null;
  model: string | null;
  agent: string | null;
  start_time: string;
  tool_count: number;
  message_count: number;
}

// ─── Prepared statements ─────────────────────────────────────────────
export interface PreparedStatements {
  getState: Database.Statement;
  getSession: Database.Statement;
  deleteEvents: Database.Statement;
  deleteSession: Database.Statement;
  deleteFileActivity: Database.Statement;
  insertEvent: Database.Statement;
  upsertSession: Database.Statement;
  upsertState: Database.Statement;
  insertFileActivity: Database.Statement;
  deleteArchive: Database.Statement;
  insertArchive: Database.Statement;
}

// ─── Indexer types ───────────────────────────────────────────────────
export interface SessionDir {
  path: string;
  agent: string;
  recursive?: boolean;
  sourceType?: string;
}

export interface IndexResult {
  skipped?: boolean;
  sessionId?: string;
  msgCount?: number;
  toolCount?: number;
  synthetic?: boolean;
  preferredTranscript?: boolean;
}

export interface IndexAllResult {
  sessions: number;
  events: number;
  newSessions: number;
}

export interface ExtractedToolCall {
  id: string;
  name: string;
  args: string;
}

export interface ExtractedToolResult {
  toolCallId: string;
  toolName: string;
  content: string;
}

// ─── JSONL parsing types ─────────────────────────────────────────────
export interface JsonlLine {
  type?: string;
  id?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: MessagePayload;
  agent?: string;
  sessionType?: string;
  cwd?: string;
  modelId?: string;
  payload?: Record<string, unknown>;
  content?: unknown;
  role?: string;
}

export interface MessagePayload {
  role?: string;
  content?: string | ContentBlock[];
  model?: string;
  usage?: UsageInfo;
  toolCallId?: string;
  toolName?: string;
}

export interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  toolCallId?: string;
  name?: string;
  input?: Record<string, unknown>;
  arguments?: Record<string, unknown> | string;
  output_text?: string;
  input_text?: string;
}

export interface UsageInfo {
  cost?: { total?: number };
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_tokens?: number;
}

// ─── Insight types ───────────────────────────────────────────────────
export interface ToolRetryLoopSignal {
  type: 'tool_retry_loop';
  tool: string;
  count: number;
}

export interface SessionBailSignal {
  type: 'session_bail';
  tool_calls: number;
}

export interface HighErrorRateSignal {
  type: 'high_error_rate';
  error_count: number;
  total: number;
  rate: number;
}

export interface LongPromptShortSessionSignal {
  type: 'long_prompt_short_session';
  prompt_words: number;
  tool_calls: number;
}

export interface NoCompletionSignal {
  type: 'no_completion';
  last_event_type: string;
  last_tool: string | null;
}

export type InsightSignal =
  | ToolRetryLoopSignal
  | SessionBailSignal
  | HighErrorRateSignal
  | LongPromptShortSessionSignal
  | NoCompletionSignal;

export type SignalType = InsightSignal['type'];

export const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  tool_retry_loop: 30,
  session_bail: 25,
  high_error_rate: 20,
  long_prompt_short_session: 15,
  no_completion: 10
};

export interface InsightResult {
  session_id: string;
  signals: InsightSignal[];
  confusion_score: number;
  flagged: boolean;
  computed_at: string;
}

export interface AgentInsights {
  count: number;
  flagged: number;
  total_score: number;
  avg_score?: number;
}

export interface TopFlaggedSession {
  session_id: string;
  summary: string | null;
  model: string | null;
  agent: string | null;
  start_time: string;
  tool_count: number;
  message_count: number;
  confusion_score: number;
  signals: InsightSignal[];
}

export interface InsightsSummary {
  total_sessions: number;
  flagged_count: number;
  flagged_percentage: number;
  avg_confusion_score: number;
  signal_counts: Record<string, number>;
  by_agent: Record<string, AgentInsights>;
  top_flagged: TopFlaggedSession[];
}

// ─── Project attribution types ───────────────────────────────────────
export interface AttributedEvent extends EventRow {
  project: string | null;
  project_confidence: number;
}

export interface ProjectFilter {
  project: string;
  eventCount: number;
}

export interface AttributionResult {
  events: AttributedEvent[];
  projectFilters: ProjectFilter[];
}

export interface ProjectScore {
  project: string | null;
  score: number;
}

// ─── API response types ──────────────────────────────────────────────
export interface DbSize {
  bytes: number;
  display: string;
}

export interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
  sessions: number;
  dbSizeBytes: number;
  node: string;
}

export interface StatsResponse {
  sessions: number;
  events: number;
  messages: number;
  toolCalls: number;
  uniqueTools: number;
  tools: string[];
  dateRange: { earliest: string | null; latest: string | null };
  totalCost: number;
  totalTokens: number;
  agents: string[];
  storageMode: string;
  dbSize: DbSize;
  sessionDirs: Array<{ path: string; agent: string }>;
}

export interface SearchEventRow extends EventRow {
  session_start: string;
  session_summary: string | null;
}

export interface TimelineEventRow extends EventRow {
  session_summary: string | null;
}

export interface ParsedQuery {
  pathname: string;
  query: Record<string, string>;
}

// ─── Cron metadata types ─────────────────────────────────────────────
export interface CronMetadata {
  sessionId?: string;
  ts?: number;
  runAtMs?: number;
  durationMs?: number;
  summary?: string;
  sessionKey?: string;
  model?: string;
  provider?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

// ─── Codex types ─────────────────────────────────────────────────────
export interface CodexSessionMeta {
  id?: string;
  timestamp?: string;
  model?: string;
  model_provider?: string;
  source?: string;
  originator?: string;
  cwd?: string;
}

export interface CodexResponsePayload {
  type?: string;
  name?: string;
  tool_name?: string;
  arguments?: string | Record<string, unknown>;
  call_id?: string;
  id?: string;
  output?: string | unknown;
  role?: string;
  content?: unknown;
  message?: string;
}

export interface CodexEventPayload {
  type?: string;
  message?: string;
}

// ─── File activity query types ───────────────────────────────────────
export interface FileActivityAggRow {
  file_path: string;
  touch_count: number;
  session_count: number;
  last_touched: string | null;
  operations: string;
}

export interface FileSessionRow extends SessionRow {
  operation: string;
  touch_time: string;
}

export interface RelatedFile {
  path: string;
  count: number;
}

export interface ToolCount {
  tool: string;
  count: number;
}

export interface RecentSession {
  id: string;
  summary: string | null;
  agent: string | null;
  timestamp: string;
  status: string;
}

export interface CountRow {
  c: number;
}

export interface PragmaColumnRow {
  name: string;
}

export interface HasEventsRow {
  has_events: number;
}
