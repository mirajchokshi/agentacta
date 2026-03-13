const { describe, it } = require('node:test');
const assert = require('node:assert');

const { attributeSessionEvents, attributeEventDelta, extractProjectFromPath } = require('../project-attribution');

describe('project attribution', () => {
  it('extracts repo names from common absolute paths', () => {
    assert.strictEqual(extractProjectFromPath('/home/dev/Developer/alpha-repo/src/index.js'), 'alpha-repo');
    assert.strictEqual(extractProjectFromPath('/Users/dev/code/beta-repo/app.ts'), 'beta-repo');
    assert.strictEqual(extractProjectFromPath('/tmp/something/random.txt'), null);
  });

  it('extracts repo names from Windows absolute paths', () => {
    assert.strictEqual(extractProjectFromPath('C:\\Users\\dev\\Developer\\win-repo\\src\\index.ts'), 'win-repo');
    assert.strictEqual(extractProjectFromPath('D:\\code\\beta-repo\\app.ts'), 'beta-repo');
  });

  it('attributes tool call and linked tool result from file path signals', () => {
    const session = { projects: JSON.stringify(['proj-a', 'proj-b']) };
    const events = [
      {
        id: 'call-1:result',
        session_id: 'sess-1',
        timestamp: '2026-03-12T10:00:03.000Z',
        type: 'tool_result',
        role: 'tool',
        content: 'ok',
        tool_name: 'Read'
      },
      {
        id: 'call-1:call',
        session_id: 'sess-1',
        timestamp: '2026-03-12T10:00:02.000Z',
        type: 'tool_call',
        role: 'assistant',
        tool_name: 'Read',
        tool_args: JSON.stringify({ file_path: '/home/dev/Developer/proj-a/src/a.js' })
      },
      {
        id: 'msg-1',
        session_id: 'sess-1',
        timestamp: '2026-03-12T10:00:01.000Z',
        type: 'message',
        role: 'assistant',
        content: 'proj-a is the target; proj-a is active for this change'
      }
    ];

    const result = attributeSessionEvents(session, events);
    assert.strictEqual(result.events[1].project, 'proj-a');
    assert.strictEqual(result.events[0].project, 'proj-a');
    assert.strictEqual(result.events[2].project, 'proj-a');
    assert.deepStrictEqual(result.projectFilters[0], { project: 'proj-a', eventCount: 3 });
  });

  it('uses branch name as a project signal when candidates exist', () => {
    const session = { projects: JSON.stringify(['proj-a', 'proj-b']) };
    const events = [
      {
        id: 'call-2:call',
        session_id: 'sess-2',
        timestamp: '2026-03-12T11:00:00.000Z',
        type: 'tool_call',
        role: 'assistant',
        tool_name: 'git_commit',
        tool_args: JSON.stringify({ branch: 'proj-b/feature/project-filtering' })
      }
    ];

    const result = attributeSessionEvents(session, events);
    assert.strictEqual(result.events[0].project, 'proj-b');
    assert.deepStrictEqual(result.projectFilters, [{ project: 'proj-b', eventCount: 1 }]);
  });

  it('keeps unattributed events out of project filters', () => {
    const session = { projects: JSON.stringify(['proj-a', 'proj-b']) };
    const events = [
      {
        id: 'msg-2',
        session_id: 'sess-3',
        timestamp: '2026-03-12T12:00:00.000Z',
        type: 'message',
        role: 'assistant',
        content: 'general status update'
      }
    ];

    const result = attributeSessionEvents(session, events);
    assert.strictEqual(result.events[0].project, null);
    assert.deepStrictEqual(result.projectFilters, []);
  });

  it('attributes delta tool_result from prior context tool_call', () => {
    const session = { projects: JSON.stringify(['proj-a']) };
    const context = [
      {
        id: 'call-3:call',
        session_id: 'sess-4',
        timestamp: '2026-03-12T09:59:59.000Z',
        type: 'tool_call',
        role: 'assistant',
        tool_name: 'Read',
        tool_args: JSON.stringify({ file_path: '/home/dev/Developer/proj-a/src/a.js' })
      }
    ];
    const delta = [
      {
        id: 'call-3:result',
        session_id: 'sess-4',
        timestamp: '2026-03-12T10:00:00.000Z',
        type: 'tool_result',
        role: 'tool',
        content: 'ok',
        tool_name: 'Read'
      }
    ];

    const events = attributeEventDelta(session, delta, context);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].id, 'call-3:result');
    assert.strictEqual(events[0].project, 'proj-a');
  });
});
