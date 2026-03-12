'use strict';

const PATH_KEYS = new Set([
  'path', 'file', 'filename', 'file_path', 'filepath',
  'cwd', 'workdir', 'directory', 'dir', 'root',
  'repository_path', 'repositorypath', 'repo_path', 'repopath'
]);

const PROJECT_KEYS = new Set([
  'project', 'project_name', 'projectname',
  'repo', 'repository', 'repo_name', 'reponame', 'repository_name', 'repositoryname',
  'workspace'
]);

const BRANCH_KEYS = new Set([
  'branch', 'branch_name', 'branchname', 'ref', 'git_ref', 'gitref'
]);

const LOOKAROUND_WINDOW = 6;
const MIN_CONFIDENCE = 2;

function safeParseJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeProjectKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function looksLikePath(value) {
  if (typeof value !== 'string') return false;
  return value.startsWith('/')
    || value.startsWith('~/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.includes('/')
    || value.includes('\\');
}

function isInternalProjectTag(tag) {
  if (!tag) return true;
  return tag.startsWith('agent:') || tag.startsWith('claude:');
}

function toDisplayProject(tag) {
  if (!tag || typeof tag !== 'string') return null;
  const value = tag.trim();
  if (!value || isInternalProjectTag(value)) return null;
  return value;
}

function extractProjectFromPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const normalized = filePath.replace(/\\/g, '/');
  if (!normalized.startsWith('/') && !normalized.startsWith('~')) return 'workspace';

  const rel = normalized
    .replace(/^\/home\/[^/]+\//, '')
    .replace(/^\/Users\/[^/]+\//, '')
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

function extractSessionProjects(session) {
  const raw = session && session.projects;
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.map(toDisplayProject).filter(Boolean))];
}

function addCandidate(candidateSet, value) {
  const p = toDisplayProject(value);
  if (p) candidateSet.add(p);
}

function visitObject(value, visitor, key = '') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visitObject(item, visitor, key);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    visitor(k, v);
    if (v && typeof v === 'object') visitObject(v, visitor, k);
  }
}

function buildCandidateProjects(session, events) {
  const candidateSet = new Set(extractSessionProjects(session));

  for (const event of events || []) {
    const args = safeParseJson(event.tool_args);
    if (!args) continue;

    visitObject(args, (key, value) => {
      if (typeof value !== 'string') return;

      const keyNorm = normalizeKey(key);
      if (PATH_KEYS.has(keyNorm) || looksLikePath(value)) {
        addCandidate(candidateSet, extractProjectFromPath(value));
      }

      if (PROJECT_KEYS.has(keyNorm)) {
        addCandidate(candidateSet, value);
      }
    });
  }

  return [...candidateSet];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countCandidateMentions(text, candidate) {
  if (!text || !candidate) return 0;
  const rx = new RegExp(`(^|[^a-z0-9])${escapeRegExp(candidate.toLowerCase())}([^a-z0-9]|$)`, 'gi');
  let matches = 0;
  let m;
  const haystack = text.toLowerCase();
  while ((m = rx.exec(haystack)) !== null) {
    matches += 1;
  }
  return matches;
}

function buildCandidateLookup(candidates) {
  const byNorm = new Map();
  for (const candidate of candidates) {
    byNorm.set(normalizeProjectKey(candidate), candidate);
  }
  return byNorm;
}

function resolveCandidate(value, candidates, byNorm, options = {}) {
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

function chooseBestProject(scores) {
  let bestProject = null;
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

function addScore(scores, project, value) {
  if (!project || value <= 0) return;
  scores.set(project, (scores.get(project) || 0) + value);
}

function extractCallBaseId(id) {
  if (!id) return '';
  return String(id).replace(/:(call|result)$/, '');
}

function scoreEvent(event, candidates, byNorm) {
  const scores = new Map();
  const args = safeParseJson(event.tool_args);

  if (args) {
    visitObject(args, (key, value) => {
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

      if (looksLikePath(value)) {
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

function findPrevAttributed(events, idx) {
  for (let i = idx - 1; i >= 0 && idx - i <= LOOKAROUND_WINDOW; i--) {
    if (events[i].project) return events[i].project;
  }
  return null;
}

function findNextAttributed(events, idx) {
  for (let i = idx + 1; i < events.length && i - idx <= LOOKAROUND_WINDOW; i++) {
    if (events[i].project) return events[i].project;
  }
  return null;
}

function attributeSessionEvents(session, events) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return { events: [], projectFilters: [] };

  const candidates = buildCandidateProjects(session, list);
  const byNorm = buildCandidateLookup(candidates);
  const withOrder = list.map((event, idx) => ({ idx, event }));

  withOrder.sort((a, b) => {
    const ta = Date.parse(a.event.timestamp || 0) || 0;
    const tb = Date.parse(b.event.timestamp || 0) || 0;
    if (ta !== tb) return ta - tb;
    return String(a.event.id || '').localeCompare(String(b.event.id || ''));
  });

  const callProjectByBase = new Map();
  const attributedOrdered = withOrder.map(({ idx, event }) => {
    const base = {
      ...event,
      project: null,
      project_confidence: 0
    };

    const scored = scoreEvent(base, candidates, byNorm);
    if (scored.project) {
      base.project = scored.project;
      base.project_confidence = scored.score;
    }

    if (base.type === 'tool_call' && base.project) {
      const callBaseId = extractCallBaseId(base.id);
      if (callBaseId) callProjectByBase.set(callBaseId, base.project);
    }

    return { idx, event: base };
  });

  const orderedEvents = attributedOrdered.map(entry => entry.event);

  for (let i = 0; i < orderedEvents.length; i++) {
    const current = orderedEvents[i];
    if (current.project) continue;

    if (current.type === 'tool_result') {
      const callBaseId = extractCallBaseId(current.id);
      const linkedProject = callProjectByBase.get(callBaseId);
      if (linkedProject) {
        current.project = linkedProject;
        current.project_confidence = 3;
        continue;
      }
    }

    if (current.type !== 'message') continue;

    const prevProject = findPrevAttributed(orderedEvents, i);
    const nextProject = findNextAttributed(orderedEvents, i);

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

  const eventsOut = new Array(list.length);
  for (const entry of attributedOrdered) {
    eventsOut[entry.idx] = entry.event;
  }

  const counts = new Map();
  for (const event of eventsOut) {
    if (!event.project || event.project_confidence < MIN_CONFIDENCE) {
      event.project = null;
      event.project_confidence = 0;
      continue;
    }
    counts.set(event.project, (counts.get(event.project) || 0) + 1);
  }

  const projectFilters = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([project, eventCount]) => ({ project, eventCount }));

  return { events: eventsOut, projectFilters };
}

module.exports = {
  attributeSessionEvents,
  extractProjectFromPath,
  isInternalProjectTag
};
