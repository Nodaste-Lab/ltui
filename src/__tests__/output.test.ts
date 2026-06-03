import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderList,
  renderPaginatedList,
  emitDetailBlock,
  emitPaginationMeta,
  truncateMultiline,
} from '../format.js';
import { extractRateLimitInfo, formatRateLimitLine } from '../rateLimit.js';
import { createMockLinearClient } from '../test-utils/mockLinearClient.js';

test('auth command emits deterministic list and detail formats', () => {
  const lines = ['id\tworkspace\thasKey', 'default\tworkspace-a\ttrue'];
  const listOutput = lines.join('\n');
  assert.equal(listOutput.split('\n')[0], 'id\tworkspace\thasKey');

  const detail = emitDetailBlock('PROFILE_SAVED', {
    PROFILE: 'default',
    WORKSPACE: 'workspace-a',
    KEY_STORED: 'true',
  });
  assert.match(detail, /^PROFILE_SAVED\nPROFILE: default/m);
});

test('issues list TSV layout matches specification', () => {
  const columns = [
    { key: 'id', header: 'id', value: (row: any) => row.id },
    { key: 'key', header: 'key', value: (row: any) => row.key },
    { key: 'identifier', header: 'identifier', value: (row: any) => row.identifier },
    { key: 'title', header: 'title', value: (row: any) => row.title },
    { key: 'state', header: 'state', value: (row: any) => row.state },
    { key: 'priority', header: 'priority', value: (row: any) => row.priority },
    { key: 'assignee', header: 'assignee', value: (row: any) => row.assignee },
    { key: 'labels', header: 'labels', value: (row: any) => row.labels },
    { key: 'project', header: 'project', value: (row: any) => row.project },
    { key: 'updatedAt', header: 'updatedAt', value: (row: any) => row.updatedAt },
  ];
  const rows = [
    {
      id: '123',
      key: 'ENG',
      identifier: 'ENG-1',
      title: 'Fix bug',
      state: 'Todo',
      priority: '2',
      assignee: 'Alice',
      labels: 'bug,backend',
      project: 'API work',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ];
  const body = renderList(rows, columns, { format: 'tsv' });
  const header = body.split('\n')[0];
  assert.equal(header, 'id\tkey\tidentifier\ttitle\tstate\tpriority\tassignee\tlabels\tproject\tupdatedAt');
});

test('issues detail format emits description markers', () => {
  const detail = emitDetailBlock('ISSUE_DETAIL', {
    ISSUE: 'ENG-1 (123)',
    TITLE: 'Fix bug',
    STATE: 'Todo',
    PRIORITY: '2',
    TEAM: 'ENG',
    PROJECT: 'API work',
    ASSIGNEE: 'Alice',
    LABELS: 'bug,backend',
    CREATED_AT: '2024-01-01',
    UPDATED_AT: '2024-01-02',
  });
  const description = truncateMultiline('Line one\nLine two', 50);
  const combined = `${detail}\nDESCRIPTION_START\n${description.text}\nDESCRIPTION_END`;
  assert.match(combined, /DESCRIPTION_START/);
});

test('issues list JSON output stays compact', () => {
  const columns = [
    { key: 'id', header: 'id', value: (row: any) => row.id },
    { key: 'title', header: 'title', value: (row: any) => row.title },
  ];
  const rows = [{ id: '123', title: 'Fix bug' }];
  const body = renderList(rows, columns, { format: 'json' });
  assert.equal(body, '[{"id":"123","title":"Fix bug"}]');
});

test('teams list columns stay deterministic', () => {
  const columns = [
    { key: 'id', header: 'id', value: (row: any) => row.id },
    { key: 'key', header: 'key', value: (row: any) => row.key },
    { key: 'name', header: 'name', value: (row: any) => row.name },
    { key: 'default_assignee', header: 'default_assignee', value: (row: any) => row.defaultAssignee },
    { key: 'active', header: 'active', value: (row: any) => row.active },
  ];
  const rows = [
    { id: 'T1', key: 'ENG', name: 'Engineering', defaultAssignee: '-', active: 'true' },
  ];
  const body = renderList(rows, columns, { format: 'tsv' });
  assert.equal(body.split('\n')[0], 'id\tkey\tname\tdefault_assignee\tactive');
});

test('projects detail block includes summary markers', () => {
  const detail = emitDetailBlock('PROJECT_DETAIL', {
    PROJECT: 'API (1)',
    STATUS: 'On Track',
    STATE: 'active',
    TARGET_DATE: '2024-02-01',
    URL: 'https://linear.app/project',
    HEALTH: 'green',
  });
  assert.match(detail, /^PROJECT_DETAIL/m);
});

test('cycles, labels, and users list share TSV layout guarantees', () => {
  const cycleColumns = [
    { key: 'id', header: 'id', value: (row: any) => row.id },
    { key: 'number', header: 'number', value: (row: any) => row.number },
    { key: 'name', header: 'name', value: (row: any) => row.name },
    { key: 'startsAt', header: 'startsAt', value: (row: any) => row.startsAt },
    { key: 'endsAt', header: 'endsAt', value: (row: any) => row.endsAt },
    { key: 'status', header: 'status', value: (row: any) => row.status },
  ];
  const labelColumns = [
    { key: 'id', header: 'id', value: (row: any) => row.id },
    { key: 'name', header: 'name', value: (row: any) => row.name },
    { key: 'group', header: 'group', value: (row: any) => row.group },
    { key: 'color', header: 'color', value: (row: any) => row.color },
  ];
  const userColumns = [
    { key: 'id', header: 'id', value: (row: any) => row.id },
    { key: 'name', header: 'name', value: (row: any) => row.name },
    { key: 'email', header: 'email', value: (row: any) => row.email },
    { key: 'displayName', header: 'displayName', value: (row: any) => row.displayName },
  ];

  const cyclesHeader = renderList(
    [{ id: 'C1', number: '10', name: 'Cycle 10', startsAt: '2024-01-01', endsAt: '2024-01-14', status: 'current' }],
    cycleColumns,
    { format: 'tsv' }
  ).split('\n')[0];
  assert.equal(cyclesHeader, 'id\tnumber\tname\tstartsAt\tendsAt\tstatus');

  const labelsHeader = renderList(
    [{ id: 'L1', name: 'bug', group: '', color: '#ff0000' }],
    labelColumns,
    { format: 'tsv' }
  ).split('\n')[0];
  assert.equal(labelsHeader, 'id\tname\tgroup\tcolor');

  const usersHeader = renderList(
    [{ id: 'U1', name: 'Alice', email: 'a@example.com', displayName: 'Alice A.' }],
    userColumns,
    { format: 'tsv' }
  ).split('\n')[0];
  assert.equal(usersHeader, 'id\tname\temail\tdisplayName');
});

test('projects list TSV layout remains stable', () => {
  const columns = [
    { key: 'id', header: 'id', value: (row: any) => row.id },
    { key: 'name', header: 'name', value: (row: any) => row.name },
    { key: 'state', header: 'state', value: (row: any) => row.state },
    { key: 'status', header: 'status', value: (row: any) => row.status },
    { key: 'targetDate', header: 'target_date', value: (row: any) => row.targetDate },
  ];
  const rows = [
    { id: 'P1', name: 'API', state: 'active', status: 'On Track', targetDate: '2024-02-01' },
  ];
  const header = renderList(rows, columns, { format: 'tsv' }).split('\n')[0];
  assert.equal(header, 'id\tname\tstate\tstatus\ttarget_date');
});

test('pagination metadata is emitted ahead of list outputs', () => {
  const meta = emitPaginationMeta('after', 'before', 2);
  const lines = meta.split('\n');
  assert.deepEqual(lines, ['CURSOR_NEXT: after', 'CURSOR_PREV: before', 'COUNT: 2']);
});

test('paginated JSON output is JSON-only envelope', () => {
  const columns = [{ key: 'id', header: 'id', value: (row: any) => row.id }];
  const rows = [{ id: '123' }];
  const out = renderPaginatedList(rows, columns, { next: 'after', prev: 'before', count: 1 }, { format: 'json' });
  assert.equal(out, '{"meta":{"cursorNext":"after","cursorPrev":"before","count":1},"rows":[{"id":"123"}]}');
  assert.ok(!out.includes('CURSOR_NEXT'));
});

test('paginated JSON can include rate-limit metadata', () => {
  const columns = [{ key: 'id', header: 'id', value: (row: any) => row.id }];
  const rows = [{ id: '123' }];
  const rateLimit = {
    requests: { limit: '2500', remaining: '2499', reset: '1714852800' },
    complexity: { limit: '3000000', remaining: '2999000' },
  };
  const out = renderPaginatedList(
    rows,
    columns,
    { next: null, prev: null, count: 1, rateLimit },
    { format: 'json' }
  );
  assert.deepEqual(JSON.parse(out), {
    meta: {
      cursorNext: '',
      cursorPrev: '',
      count: 1,
      rateLimit,
    },
    rows: [{ id: '123' }],
  });
  assert.equal(
    formatRateLimitLine(rateLimit),
    'RATE_LIMIT requestsLimit=2500 requestsRemaining=2499 requestsReset=1714852800 complexityLimit=3000000 complexityRemaining=2999000'
  );
});

test('mock Linear client records request-shape counters and rate-limit headers', async () => {
  const client = createMockLinearClient({} as any);
  const issue = await client.issue('ENG-1');
  await issue.team;
  await issue.state;
  await issue.project;
  await issue.assignee;
  await issue.labels();
  assert.equal(client.__ltuiRequestCounts.issue, 1);
  assert.equal(client.__ltuiRequestCounts.team, 1);
  assert.equal(client.__ltuiRequestCounts.state, 1);
  assert.equal(client.__ltuiRequestCounts.project, 1);
  assert.equal(client.__ltuiRequestCounts.assignee, 1);
  assert.equal(client.__ltuiRequestCounts.labels, 1);

  const response = await client.client.rawRequest('query { issues { nodes { id } } }', { first: 1 });
  const rateLimit = extractRateLimitInfo(response.headers);
  assert.equal(client.__ltuiRequestCounts.rawRequests, 1);
  assert.equal(rateLimit?.requests.limit, '2500');
  assert.equal(rateLimit?.complexity.remaining, '2999000');
});
