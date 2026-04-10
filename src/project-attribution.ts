import type {
  SessionRow,
  EventRow,
  AttributedEvent,
  ProjectFilter,
  AttributionResult,
  ProjectScore,
} from './types.js';

const PATH_KEYS: Set<string> = new Set([
  'path', 'file', 'filename', 'file_path', 'filepath',
  'cwd', 'workdir', 'directory', 'dir', 'root',
  'repository_path', 'repositorypath', 'repo_path', 'repopath'
]);

const PROJECT_KEYS: Set<string> = new Set([
  'project', 'project_name', 'projectname',
  'repo', 'repository', 'repo_name', 'reponame', 'repository_name', 'repositoryname',
  'workspace'
]);

const BRANCH_KEYS: Set<string> = new Set([
  'branch', 'branch_name', 'branchname', 'ref', 'git_ref', 'gitref'
]);

const LOOKAROUND_WINDOW = 6;
const MIN_CONFIDENCE = 2;

function safeParseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeKey(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeProjectKey(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function looksLikeFilesystemPath(value: unknown, options: { allowRelative?: boolean } = {}): boolean {
  const { allowRelative = false } = options;
  if (typeof value !== 'string') return false;

  const raw = value.trim();
  if (!raw) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return false;
  if (/^[\w.-]+@[\w.-]+:.+/.test(raw)) return false;
  if (/^refs\/(heads|tags|remotes)\//i.test(raw)) return false;

  const normalized = raw.replace(/\\/g, '/');
  const isWindowsDriveAbs = /^[a-zA-Z]:\//.test(normalized);
  const isUncAbs = normalized.startsWith('//');
  if (
    normalized.startsWith('/')
    || normalized.startsWith('~/')
    || normalized.startsWith('./')
    || normalized.startsWith('../')
    || isWindowsDriveAbs
    || isUncAbs
  ) {
    return true;
  }

  if (!allowRelative || !normalized.includes('/')) return false;
  if (/^(origin|remotes)\//i.test(normalized)) return false;

  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return false;
  if (parts.length === 2 && !parts[1].includes('.')) return false;

  return parts.length >= 2;
}

function isInternalProjectTag(tag: string): boolean {
  if (!tag) return true;
  return tag.startsWith('agent:') || tag.startsWith('claude:');
}

function toDisplayProject(tag: unknown): string | null {
  if (!tag || typeof tag !== 'string') return null;
  const value = tag.trim();
  if (!value || isInternalProjectTag(value)) return null;
  return value;
}

export function extractProjectFromPath(filePath: string | null): string | null {
  if (!filePath || typeof filePath !== 'string') return null;
  const normalized = filePath.trim().replace(/\\/g, '/');
  if (!looksLikeFilesystemPath(normalized, { allowRelative: true })) return null;
  const isWindowsDriveAbs = /^[a-zA-Z]:\//.test(normalized);
  const isUncAbs = normalized.startsWith('//');
  if (!normalized.startsWith('/') && !normalized.startsWith('~') && !isWindowsDriveAbs && !isUncAbs) return null;

  const rel = normalized
    .replace(/^[a-zA-Z]:\//, '')
    .replace(/^\/\/[^/]+\/[^/]+\//, '')
    .replace(/^\/home\/[^/]+\//, '')
    .replace(/^\/Users\/[^/]+\//, '')
    .replace(/^Users\/[^/]+\//, '')
    .replace(/^~\//, '');

  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) return null;

  if (parts[0] === 'Developer' && parts[1]) return parts[1];
  if (parts[0] === 'dev' && parts[1]) return parts[1];
  if (parts[0] === 'code' && parts[1]) return parts[1];
  if (parts[0] === '.openclaw' && parts[1] === 'workspace') return 'workspace';
  if (parts[0] === '.openclaw' && parts[1] === 'agents' && parts[2]) return `agent:${parts[2]}`;
  if (parts[0] === '.claude' && parts[1] === 'projects' && parts[2]) return `claude:${parts[2]}`;
  if (parts[0] === 'Shared') return 'shared';
  return null;
}

function extractSessionProjects(session: SessionRow): string[] {
  const raw = session && session.projects;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(
    (parsed as unknown[]).map(toDisplayProject).filter((p): p is string => p !== null)
  )];
}

function addCandidate(candidateSet: Set<string>, value: string | null): void {
  const p = toDisplayProject(value);
  if (p) candidateSet.add(p);
}

function visitObject(value: unknown, visitor: (key: string, value: unknown) => void, key: string = ''): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visitObject(item, visitor, key);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    visitor(k, v);
    if (v && typeof v === 'object') visitObject(v, visitor, k);
  }
}

function buildCandidateProjects(session: SessionRow, events: EventRow[]): string[] {
  const candidateSet = new Set<string>(extractSessionProjects(session));

  for (const event of events || []) {
    const args = safeParseJson(event.tool_args);
    if (!args) continue;

    visitObject(args, (key: string, value: unknown) => {
      if (typeof value !== 'string') return;

      const keyNorm = normalizeKey(key);
      if (PATH_KEYS.has(keyNorm)) {
        if (!looksLikeFilesystemPath(value, { allowRelative: true })) return;
        addCandidate(candidateSet, extractProjectFromPath(value));
        return;
      }

      if (looksLikeFilesystemPath(value)) {
        addCandidate(candidateSet, extractProjectFromPath(value));
      }

      if (PROJECT_KEYS.has(keyNorm)) {
        addCandidate(candidateSet, value);
      }
    });
  }

  return [...candidateSet];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countCandidateMentions(text: string, candidate: string): number {
  if (!text || !candidate) return 0;
  const rx = new RegExp(`(^|[^a-z0-9])${escapeRegExp(candidate.toLowerCase())}([^a-z0-9]|$)`, 'gi');
  let matches = 0;
  const haystack = text.toLowerCase();
  while (rx.exec(haystack) !== null) {
    matches += 1;
  }
  return matches;
}

function buildCandidateLookup(candidates: string[]): Map<string, string> {
  const byNorm = new Map<string, string>();
  for (const candidate of candidates) {
    byNorm.set(normalizeProjectKey(candidate), candidate);
  }
  return byNorm;
}

function resolveCandidate(
  value: unknown,
  candidates: string[],
  byNorm: Map<string, string>,
  options: { allowPath?: boolean } = {}
): string | null {
  const { allowPath = true } = options;
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  if (allowPath) {
    const fromPath = toDisplayProject(extractProjectFromPath(raw));
    if (fromPath) {
      const resolved = byNorm.get(normalizeProjectKey(fromPath));
      return resolved || fromPath;
    }
  }

  const direct = byNorm.get(normalizeProjectKey(raw));
  if (direct) return direct;

  const lower = raw.toLowerCase();
  for (const candidate of candidates) {
    const rx = new RegExp(`(^|[^a-z0-9])${escapeRegExp(candidate.toLowerCase())}([^a-z0-9]|$)`, 'i');
    if (rx.test(lower)) return candidate;
  }

  return null;
}

function chooseBestProject(scores: Map<string, number>): ProjectScore {
  let bestProject: string | null = null;
  let bestScore = 0;
  let secondBest = 0;

  for (const [project, score] of scores.entries()) {
    if (score > bestScore) {
      secondBest = bestScore;
      bestScore = score;
      bestProject = project;
      continue;
    }
    if (score > secondBest) secondBest = score;
  }

  if (!bestProject || bestScore < MIN_CONFIDENCE) {
    return { project: null, score: 0 };
  }
  if (bestScore === secondBest) {
    return { project: null, score: 0 };
  }
  return { project: bestProject, score: bestScore };
}

function addScore(scores: Map<string, number>, project: string | null, value: number): void {
  if (!project || value <= 0) return;
  scores.set(project, (scores.get(project) || 0) + value);
}

function extractCallBaseId(id: string | null | undefined): string {
  if (!id) return '';
  return String(id).replace(/:(call|result)$/, '');
}

function scoreEvent(event: AttributedEvent, candidates: string[], byNorm: Map<string, string>): ProjectScore {
  const scores = new Map<string, number>();
  const args = safeParseJson(event.tool_args);

  if (args) {
    visitObject(args, (key: string, value: unknown) => {
      if (typeof value !== 'string') return;
      const keyNorm = normalizeKey(key);
      if (PATH_KEYS.has(keyNorm)) {
        const candidate = resolveCandidate(value, candidates, byNorm, { allowPath: true });
        if (!candidate) return;
        addScore(scores, candidate, 4);
        return;
      }

      if (PROJECT_KEYS.has(keyNorm)) {
        const candidate = resolveCandidate(value, candidates, byNorm, { allowPath: true });
        if (!candidate) return;
        addScore(scores, candidate, 3);
        return;
      }

      if (BRANCH_KEYS.has(keyNorm)) {
        const candidate = resolveCandidate(value, candidates, byNorm, { allowPath: false });
        if (!candidate) return;
        addScore(scores, candidate, 2);
        return;
      }

      if (looksLikeFilesystemPath(value)) {
        const candidate = resolveCandidate(value, candidates, byNorm, { allowPath: true });
        if (!candidate) return;
        addScore(scores, candidate, 3);
        return;
      }

      const candidate = resolveCandidate(value, candidates, byNorm, { allowPath: false });
      if (!candidate) return;
      addScore(scores, candidate, 1);
    });
  }

  if (typeof event.content === 'string' && event.content) {
    for (const candidate of candidates) {
      const count = countCandidateMentions(event.content, candidate);
      if (count > 0) addScore(scores, candidate, Math.min(count, 2));
    }
  }

  if (typeof event.tool_name === 'string' && event.tool_name) {
    const candidate = resolveCandidate(event.tool_name, candidates, byNorm);
    if (candidate) addScore(scores, candidate, 1);
  }

  return chooseBestProject(scores);
}

function findPrevAttributed(events: AttributedEvent[], idx: number): string | null {
  for (let i = idx - 1; i >= 0 && idx - i <= LOOKAROUND_WINDOW; i--) {
    if (events[i].project) return events[i].project;
  }
  return null;
}

function findNextAttributed(events: AttributedEvent[], idx: number): string | null {
  for (let i = idx + 1; i < events.length && i - idx <= LOOKAROUND_WINDOW; i++) {
    if (events[i].project) return events[i].project;
  }
  return null;
}

export function attributeSessionEvents(session: SessionRow, events: EventRow[]): AttributionResult {
  const list: EventRow[] = Array.isArray(events) ? events : [];
  if (!list.length) return { events: [], projectFilters: [] };

  const candidates: string[] = buildCandidateProjects(session, list);
  const byNorm: Map<string, string> = buildCandidateLookup(candidates);
  const withOrder: { idx: number; event: EventRow }[] = list.map((event, idx) => ({ idx, event }));

  withOrder.sort((a, b) => {
    const ta = Date.parse(a.event.timestamp || '') || 0;
    const tb = Date.parse(b.event.timestamp || '') || 0;
    if (ta !== tb) return ta - tb;
    return String(a.event.id || '').localeCompare(String(b.event.id || ''));
  });

  const callProjectByBase = new Map<string, string>();
  const attributedOrdered: { idx: number; event: AttributedEvent }[] = withOrder.map(({ idx, event }) => {
    const base: AttributedEvent = {
      ...event,
      project: null,
      project_confidence: 0
    };

    const scored: ProjectScore = scoreEvent(base, candidates, byNorm);
    if (scored.project) {
      base.project = scored.project;
      base.project_confidence = scored.score;
    }

    if (base.type === 'tool_call' && base.project) {
      const callBaseId: string = extractCallBaseId(base.id);
      if (callBaseId) callProjectByBase.set(callBaseId, base.project);
    }

    return { idx, event: base };
  });

  const orderedEvents: AttributedEvent[] = attributedOrdered.map(entry => entry.event);

  for (let i = 0; i < orderedEvents.length; i++) {
    const current: AttributedEvent = orderedEvents[i];
    if (current.project) continue;

    if (current.type === 'tool_result') {
      const callBaseId: string = extractCallBaseId(current.id);
      const linkedProject: string | undefined = callProjectByBase.get(callBaseId);
      if (linkedProject) {
        current.project = linkedProject;
        current.project_confidence = 3;
        continue;
      }
    }

    if (current.type !== 'message') continue;

    const prevProject: string | null = findPrevAttributed(orderedEvents, i);
    const nextProject: string | null = findNextAttributed(orderedEvents, i);

    if (prevProject && nextProject && prevProject === nextProject) {
      current.project = prevProject;
      current.project_confidence = 2;
      continue;
    }

    if (prevProject && !nextProject) {
      current.project = prevProject;
      current.project_confidence = 2;
    }
  }

  const eventsOut: AttributedEvent[] = new Array<AttributedEvent>(list.length);
  for (const entry of attributedOrdered) {
    eventsOut[entry.idx] = entry.event;
  }

  const counts = new Map<string, number>();
  for (const event of eventsOut) {
    if (!event.project || event.project_confidence < MIN_CONFIDENCE) {
      event.project = null;
      event.project_confidence = 0;
      continue;
    }
    counts.set(event.project, (counts.get(event.project) || 0) + 1);
  }

  const projectFilters: ProjectFilter[] = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([project, eventCount]) => ({ project, eventCount }));

  return { events: eventsOut, projectFilters };
}

export function attributeEventDelta(
  session: SessionRow,
  deltaEvents: EventRow[],
  contextEvents: EventRow[] = []
): AttributedEvent[] {
  const delta: EventRow[] = Array.isArray(deltaEvents) ? deltaEvents : [];
  if (!delta.length) return [];

  const context: EventRow[] = Array.isArray(contextEvents) ? contextEvents : [];
  const merged: EventRow[] = [...context, ...delta];
  const attributed: AttributedEvent[] = attributeSessionEvents(session, merged).events;

  const byId = new Map<string, AttributedEvent>();
  for (const event of attributed) {
    if (!event || !event.id) continue;
    byId.set(event.id, event);
  }

  return delta.map(event =>
    byId.get(event.id) || { ...event, project: null, project_confidence: 0 }
  );
}

export { isInternalProjectTag };
