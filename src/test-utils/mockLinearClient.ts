import fs from 'node:fs';
import type { ResolvedConfig } from '../config.js';

interface WorkflowState {
  id: string;
  name: string;
  type: string;
}

interface TeamData {
  id: string;
  key: string;
  name: string;
  description?: string;
  states: WorkflowState[];
}

interface ProjectData {
  id: string;
  name: string;
  slugId: string;
  state: string;
  status: { name: string };
  targetDate: string;
  url: string;
  progress: number;
  issueCountHistory: number[];
  completedIssueCountHistory: number[];
  milestones: Array<{ id: string; name: string; targetDate: string; projectId: string }>;
}

interface LabelData {
  id: string;
  name: string;
  teamId: string;
  color: string;
  isGroup?: boolean;
  parentName?: string;
}

interface UserData {
  id: string;
  name: string;
  email: string;
  displayName: string;
}

interface IssueData {
  id: string;
  identifier: string;
  url: string;
  title: string;
  number: number;
  teamId: string;
  projectId: string;
  stateId: string;
  priority: number;
  assigneeId: string;
  labelIds: string[];
  description: string;
  updatedAt: string;
  createdAt: string;
  attachments?: AttachmentData[];
}

interface AttachmentData {
  id: string;
  title: string;
  url: string;
  createdAt: string;
  sourceType?: string;
  subtitle?: string;
  metadata?: Record<string, unknown>;
}

interface DocumentData {
  id: string;
  title: string;
  content: string;
  projectId: string;
  updatedAt: string;
  url: string;
}

interface RoadmapData {
  id: string;
  name: string;
  url: string;
  ownerId: string;
  projectIds: string[];
}

interface MilestoneData {
  id: string;
  name: string;
  projectId: string;
  targetDate: string;
}

interface NotificationData {
  id: string;
  type: string;
  readAt: string | null;
  createdAt: string;
}

type PageInfo = {
  endCursor: string | null;
  startCursor: string | null;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

interface MockRequestCounts {
  rawRequests: number;
  issues: number;
  searchIssues: number;
  issue: number;
  team: number;
  state: number;
  project: number;
  assignee: number;
  labels: number;
  attachments: number;
  comments: number;
  history: number;
}

const RATE_LIMIT_HEADERS: Record<string, string> = {
  'x-ratelimit-requests-limit': '2500',
  'x-ratelimit-requests-remaining': '2499',
  'x-ratelimit-requests-reset': '1714852800',
  'x-ratelimit-complexity-limit': '3000000',
  'x-ratelimit-complexity-remaining': '2999000',
};

function createCounts(): MockRequestCounts {
  return {
    rawRequests: 0,
    issues: 0,
    searchIssues: 0,
    issue: 0,
    team: 0,
    state: 0,
    project: 0,
    assignee: 0,
    labels: 0,
    attachments: 0,
    comments: 0,
    history: 0,
  };
}

function makeHeaders(values: Record<string, string> = RATE_LIMIT_HEADERS): Headers {
  return new Headers(values);
}

function parseCursor(cursor: string): number | null {
  const match = /^cursor:(\d+)$/.exec(cursor);
  if (!match) return null;
  const parsed = parseInt(match[1] ?? '', 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function connection<T>(
  allNodes: T[],
  variables?: { first?: number; after?: string; last?: number; before?: string }
): { nodes: T[]; edges: Array<{ cursor: string; node: T }>; pageInfo: PageInfo } {
  const first =
    typeof variables?.first === 'number' && !Number.isNaN(variables.first)
      ? variables.first
      : allNodes.length;
  const afterIndex = variables?.after ? parseCursor(variables.after) : null;
  const startIndex = afterIndex !== null ? afterIndex + 1 : 0;
  const nodes = allNodes.slice(startIndex, startIndex + first);
  const endIndex = nodes.length > 0 ? startIndex + nodes.length - 1 : -1;
  const startCursor = nodes.length > 0 ? `cursor:${startIndex}` : null;
  const endCursor = nodes.length > 0 ? `cursor:${endIndex}` : null;
  const hasNextPage = endIndex >= 0 ? endIndex < allNodes.length - 1 : false;
  const hasPreviousPage = startIndex > 0;
  const edges = nodes.map((node, index) => ({
    cursor: `cursor:${startIndex + index}`,
    node,
  }));
  return {
    nodes,
    edges,
    pageInfo: {
      startCursor,
      endCursor,
      hasNextPage,
      hasPreviousPage,
    },
  };
}

export function createMockLinearClient(_resolved: ResolvedConfig): any {
  const data = buildData();
  return new MockLinearClient(data);
}

function buildData() {
  const states: WorkflowState[] = [
    { id: 'state-1', name: 'Todo', type: 'backlog' },
    { id: 'state-2', name: 'In Progress', type: 'started' },
  ];
  const teams: TeamData[] = [
    {
      id: 'team-1',
      key: 'ENG',
      name: 'Engineering',
      description: 'Engineering team',
      states,
    },
  ];
  const projects: ProjectData[] = [
    {
      id: 'proj-1',
      name: 'Project Alpha',
      slugId: 'project-alpha',
      state: 'active',
      status: { name: 'On Track' },
      targetDate: '2024-12-31',
      url: 'https://linear.app/project-alpha',
      progress: 0.5,
      issueCountHistory: [10],
      completedIssueCountHistory: [4],
      milestones: [{ id: 'milestone-1', name: 'Milestone 1', targetDate: '2024-10-01', projectId: 'proj-1' }],
    },
  ];
  const labels: LabelData[] = [
    { id: 'label-1', name: 'bug', teamId: 'team-1', color: '#ff0000' },
    { id: 'label-2', name: 'backend', teamId: 'team-1', color: '#00ff00' },
  ];
  const users: UserData[] = [
    { id: 'user-1', name: 'Alice', email: 'alice@example.com', displayName: 'Alice' },
    { id: 'user-2', name: 'Bob', email: 'bob@example.com', displayName: 'Bob' },
  ];
  const issues: IssueData[] = [
    {
      id: 'issue-1',
      identifier: 'ENG-1',
      url: 'https://linear.app/issue/ENG-1',
      title: 'Fix bug',
      number: 1,
      teamId: 'team-1',
      projectId: 'proj-1',
      stateId: 'state-1',
      priority: 2,
      assigneeId: 'user-1',
      labelIds: ['label-1'],
      description:
        'Issue description\n\nScreenshot: https://uploads.linear.app/6db02bb9-fba2-473b-8f9d-f38188e84813/d20adbea-186d-4643-ad07-004bda7d099d',
      updatedAt: '2024-01-02T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
      attachments: [
        {
          id: 'attachment-1',
          title: 'Screenshot',
          subtitle: 'From Linear upload',
          url: 'https://uploads.linear.app/6db02bb9-fba2-473b-8f9d-f38188e84813/d20adbea-186d-4643-ad07-004bda7d099d',
          createdAt: '2024-01-01T12:00:00Z',
          sourceType: 'linear_upload',
          metadata: { contentType: 'image/png' },
        },
        {
          id: 'attachment-2',
          title: 'Example',
          url: 'https://example.com',
          createdAt: '2024-01-01T13:00:00Z',
          sourceType: 'link',
          metadata: { contentType: 'text/html' },
        },
      ],
    },
    {
      id: 'issue-2',
      identifier: 'ENG-2',
      url: 'https://linear.app/issue/ENG-2',
      title: 'Follow-up',
      number: 2,
      teamId: 'team-1',
      projectId: 'proj-1',
      stateId: 'state-1',
      priority: 1,
      assigneeId: 'user-2',
      labelIds: ['label-2'],
      description: 'Child issue description',
      updatedAt: '2024-01-04T00:00:00Z',
      createdAt: '2024-01-03T00:00:00Z',
    },
  ];
  const documents: DocumentData[] = [
    {
      id: 'doc-1',
      title: 'Design Doc',
      content: 'Document content',
      projectId: 'proj-1',
      updatedAt: '2024-01-05T00:00:00Z',
      url: 'https://linear.app/doc-1',
    },
  ];
  const roadmaps: RoadmapData[] = [
    { id: 'roadmap-1', name: 'Roadmap', url: 'https://linear.app/roadmap', ownerId: 'user-1', projectIds: ['proj-1'] },
  ];
  const milestones: MilestoneData[] = [
    { id: 'milestone-1', name: 'Milestone 1', projectId: 'proj-1', targetDate: '2024-10-01' },
  ];
  const notifications: NotificationData[] = [
    { id: 'notif-1', type: 'issue_created', readAt: '2024-02-01T01:00:00Z', createdAt: '2024-02-01T00:00:00Z' },
    { id: 'notif-2', type: 'issue_updated', readAt: null, createdAt: '2024-02-02T00:00:00Z' },
    { id: 'notif-3', type: 'issue_commented', readAt: null, createdAt: '2024-02-03T00:00:00Z' },
    { id: 'notif-4', type: 'issue_updated', readAt: '2024-02-04T01:00:00Z', createdAt: '2024-02-04T00:00:00Z' },
  ];
  return {
    teams,
    states,
    projects,
    labels,
    users,
    issues,
    documents,
    roadmaps,
    milestones,
    notifications,
  };
}

class MockLinearClient {
  private data: ReturnType<typeof buildData>;
  public viewer: any;
  public client: any;
  public __ltuiRequestCounts: MockRequestCounts;
  public __ltuiRawRequests: Array<{ query: string; variables: Record<string, unknown> }>;

  constructor(data: ReturnType<typeof buildData>) {
    this.data = data;
    this.__ltuiRequestCounts = createCounts();
    this.__ltuiRawRequests = [];
    this.viewer = this.decorateUser(data.users[0]);
    this.client = {
      rawRequest: async (query: string, variables?: Record<string, unknown>) =>
        this.rawRequest(query, variables ?? {}),
    };

    const logPath = process.env.LTUI_MOCK_REQUEST_LOG;
    if (logPath) {
      const writeLog = () => {
        fs.writeFileSync(
          logPath,
          JSON.stringify({
            counts: this.__ltuiRequestCounts,
            rawRequests: this.__ltuiRawRequests,
          })
        );
      };
      process.on('beforeExit', writeLog);
      process.on('exit', writeLog);
    }
  }

  async teams(variables?: any): Promise<any> {
    return connection(this.data.teams.map(team => this.decorateTeam(team)), variables);
  }

  async team(id: string): Promise<any> {
    const match = this.data.teams.find(team => team.id === id || team.key === id);
    return match ? this.decorateTeam(match) : null;
  }

  async workflowStates(variables?: any): Promise<any> {
    return connection(this.data.states.map(state => ({ ...state })), variables);
  }

  async workflowState(id: string): Promise<any> {
    return this.decorateState(id);
  }

  async issues(variables?: any): Promise<any> {
    this.__ltuiRequestCounts.issues += 1;
    return connection(this.data.issues.map(issue => this.decorateIssue(issue)), variables);
  }

  async searchIssues(_term?: string, variables?: any): Promise<any> {
    this.__ltuiRequestCounts.searchIssues += 1;
    return connection(this.data.issues.map(issue => ({ id: issue.id })), variables);
  }

  async issue(ref: string): Promise<any> {
    this.__ltuiRequestCounts.issue += 1;
    const match = this.data.issues.find(issue => issue.id === ref || issue.identifier === ref);
    return match ? this.decorateIssue(match) : null;
  }

  async rawRequest(query: string, variables: Record<string, unknown>): Promise<any> {
    this.__ltuiRequestCounts.rawRequests += 1;
    this.__ltuiRawRequests.push({ query, variables });
    if (process.env.LTUI_MOCK_RAW_RATE_LIMIT === '1') {
      const error = new Error('rate limited') as Error & {
        type?: string;
        raw?: { response: { headers: Headers; status: number; error: string } };
        response?: { headers: Headers; status: number; error: string };
      };
      const response = {
        headers: makeHeaders({ ...RATE_LIMIT_HEADERS, 'x-ratelimit-requests-remaining': '0' }),
        status: 429,
        error: 'rate_limited',
      };
      error.type = 'Ratelimited';
      error.raw = { response };
      error.response = response;
      throw error;
    }

    if (query.includes('notifications')) {
      const nodes = this.data.notifications.map(notification => ({ ...notification }));
      const page = connection(nodes, variables);
      return {
        data: {
          notifications: page,
        },
        headers: makeHeaders(),
      };
    }

    const nodes = this.filterIssues(variables, query).map(issue => this.rawIssue(issue));
    const page = connection(nodes, variables);
    const field = query.includes('searchIssues') ? 'searchIssues' : 'issues';
    return {
      data: {
        [field]: page,
      },
      headers: makeHeaders(),
    };
  }

  async createIssue(input: Record<string, unknown>): Promise<any> {
    const created = this.decorateIssue({
      id: 'issue-created',
      identifier: 'ENG-999',
      url: 'https://linear.app/issue/ENG-999',
      title: String(input.title ?? 'Generated issue'),
      number: 999,
      teamId: 'team-1',
      projectId: 'proj-1',
      stateId: 'state-1',
      priority: 1,
      assigneeId: 'user-1',
      labelIds: ['label-1'],
      description: String(input.description ?? ''),
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    return { issue: created };
  }

  async updateIssue(_id: string, _input: Record<string, unknown>): Promise<void> {
    return;
  }

  async createComment(): Promise<any> {
    if (process.env.LTUI_TEST_FAIL_COMMENT === '1') {
      throw new Error('comment_create_failed');
    }
    return {
      success: true,
      comment: {
        id: 'comment-created',
        body: 'comment body',
        createdAt: new Date().toISOString(),
        user: this.decorateUser(this.data.users[0]),
      },
    };
  }

  async fileUpload(contentType: string, filename: string, size: number): Promise<any> {
    return {
      success: true,
      uploadFile: {
        uploadUrl: process.env.LTUI_TEST_UPLOAD_URL ?? 'https://uploads.linear.app/mock-upload-target',
        assetUrl: `https://uploads.linear.app/mock-workspace/${encodeURIComponent(filename)}`,
        headers: [
          { key: 'x-linear-content-type', value: contentType },
          { key: 'x-linear-content-size', value: String(size) },
        ],
      },
    };
  }

  async createAttachment(): Promise<any> {
    if (process.env.LTUI_TEST_FAIL_ATTACHMENT === '1') {
      throw new Error('attachment_create_failed');
    }
    return {
      success: true,
      attachment: {
        id: 'attachment-1',
        title: 'Attachment',
        url: 'https://example.com',
      },
    };
  }

  async createIssueRelation(): Promise<any> {
    return {};
  }

  async projects(variables?: any): Promise<any> {
    return connection(this.data.projects.map(project => this.decorateProject(project)), variables);
  }

  async project(id: string): Promise<any> {
    const match = this.data.projects.find(project => project.id === id || project.slugId === id);
    return match ? this.decorateProject(match) : null;
  }

  async cycles(variables?: any): Promise<any> {
    return connection(
      [
      {
        id: 'cycle-1',
        number: 1,
        name: 'Cycle 1',
        startsAt: '2024-01-01',
        endsAt: '2024-01-14',
        status: 'current',
      },
      ],
      variables
    );
  }

  async issueLabels(variables?: any): Promise<any> {
    let working = this.data.labels;
    const filter = variables?.filter;
    const andFilters: any[] = Array.isArray(filter?.and) ? filter.and : [];
    for (const clause of andFilters) {
      if (clause?.team?.id?.eq) {
        working = working.filter(label => label.teamId === clause.team.id.eq);
      }
      if (clause?.team?.null === true) {
        working = working.filter(label => !label.teamId);
      }
      if (Array.isArray(clause?.name?.in)) {
        const set = new Set(clause.name.in);
        working = working.filter(label => set.has(label.name));
      }
    }
    if (Array.isArray(filter?.name?.in)) {
      const set = new Set(filter.name.in);
      working = working.filter(label => set.has(label.name));
    }

    return connection(
      working.map(label => ({
        ...label,
        parent: label.parentName ? { name: label.parentName } : undefined,
      })),
      variables
    );
  }

  async users(variables?: any): Promise<any> {
    return connection(this.data.users.map(user => this.decorateUser(user)), variables);
  }

  async documents(variables?: any): Promise<any> {
    return connection(this.data.documents.map(doc => this.decorateDocument(doc)), variables);
  }

  async searchDocuments(): Promise<any> {
    return connection(this.data.documents.map(doc => this.decorateDocument(doc)));
  }

  async document(id: string): Promise<any> {
    const match = this.data.documents.find(doc => doc.id === id);
    return match ? this.decorateDocument(match) : null;
  }

  async roadmaps(variables?: any): Promise<any> {
    return connection(this.data.roadmaps.map(roadmap => this.decorateRoadmap(roadmap)), variables);
  }

  async roadmap(id: string): Promise<any> {
    const match = this.data.roadmaps.find(roadmap => roadmap.id === id);
    return match ? this.decorateRoadmap(match) : null;
  }

  async projectMilestones(variables?: any): Promise<any> {
    return connection(this.data.milestones.map(m => this.decorateMilestone(m)), variables);
  }

  async projectMilestone(id: string): Promise<any> {
    const match = this.data.milestones.find(m => m.id === id);
    return match ? this.decorateMilestone(match) : null;
  }

  async notifications(variables?: any): Promise<any> {
    return connection(
      this.data.notifications.map(n => ({
        ...n,
        createdAt: new Date(n.createdAt),
      })),
      variables
    );
  }

  private filterIssues(variables: Record<string, unknown>, query: string): IssueData[] {
    let working = this.data.issues;
    const filter = variables.filter as any;
    const term = typeof variables.term === 'string' ? variables.term.toLowerCase() : '';
    if (term) {
      working = working.filter(issue =>
        issue.identifier.toLowerCase().includes(term) || issue.title.toLowerCase().includes(term)
      );
    }
    if (query.includes('searchIssues') && !term) {
      return working;
    }
    if (filter?.team?.or) {
      const teamRefs = filter.team.or
        .flatMap((clause: any) => [clause?.id?.eq, clause?.key?.eq, clause?.name?.eq])
        .filter(Boolean);
      working = working.filter(issue => {
        const team = this.data.teams.find(item => item.id === issue.teamId);
        return teamRefs.some((ref: string) => ref === team?.id || ref === team?.key || ref === team?.name);
      });
    }
    if (filter?.project?.or) {
      const projectRefs = filter.project.or
        .flatMap((clause: any) => [clause?.id?.eq, clause?.slugId?.eq, clause?.name?.eq])
        .filter(Boolean);
      working = working.filter(issue => {
        const project = this.data.projects.find(item => item.id === issue.projectId);
        return projectRefs.some((ref: string) => ref === project?.id || ref === project?.slugId || ref === project?.name);
      });
    }
    if (filter?.state?.or) {
      const stateRefs = filter.state.or
        .flatMap((clause: any) => [clause?.id?.eq, clause?.name?.eq])
        .filter(Boolean);
      working = working.filter(issue => {
        const state = this.data.states.find(item => item.id === issue.stateId);
        return stateRefs.some((ref: string) => ref === state?.id || ref === state?.name);
      });
    }
    if (filter?.assignee?.isMe?.eq === true) {
      working = working.filter(issue => issue.assigneeId === this.data.users[0]?.id);
    } else if (filter?.assignee?.email?.eq) {
      working = working.filter(issue => this.data.users.find(user => user.id === issue.assigneeId)?.email === filter.assignee.email.eq);
    } else if (filter?.assignee?.or) {
      const assigneeRefs = filter.assignee.or
        .flatMap((clause: any) => [clause?.id?.eq, clause?.name?.eq])
        .filter(Boolean);
      working = working.filter(issue => {
        const assignee = this.data.users.find(item => item.id === issue.assigneeId);
        return assigneeRefs.some((ref: string) => ref === assignee?.id || ref === assignee?.name);
      });
    }
    if (filter?.labels?.and) {
      const labels = filter.labels.and
        .map((clause: any) => clause?.some?.name?.eq)
        .filter(Boolean);
      working = working.filter(issue => {
        const issueLabels = issue.labelIds
          .map(id => this.data.labels.find(label => label.id === id)?.name)
          .filter(Boolean);
        return labels.every((label: string) => issueLabels.includes(label));
      });
    }
    if (filter?.updatedAt?.gte) {
      working = working.filter(issue => issue.updatedAt >= filter.updatedAt.gte);
    }
    if (filter?.createdAt?.gte) {
      working = working.filter(issue => issue.createdAt >= filter.createdAt.gte);
    }
    return working;
  }

  private rawIssue(issue: IssueData): any {
    const labels = issue.labelIds
      .map(id => this.data.labels.find(label => label.id === id))
      .filter(Boolean) as LabelData[];
    const team = this.data.teams.find(t => t.id === issue.teamId)!;
    const project = this.data.projects.find(p => p.id === issue.projectId)!;
    const state = this.data.states.find(s => s.id === issue.stateId)!;
    const assignee = this.data.users.find(u => u.id === issue.assigneeId)!;
    return {
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      number: issue.number,
      title: issue.title,
      state: { id: state.id, name: state.name, type: state.type },
      team: { id: team.id, key: team.key, name: team.name },
      project: { id: project.id, name: project.name, slugId: project.slugId },
      priority: issue.priority,
      assignee: { id: assignee.id, name: assignee.name, email: assignee.email },
      labels: { nodes: labels.map(label => ({ id: label.id, name: label.name })) },
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    };
  }

  private decorateTeam(team: TeamData) {
    return {
      ...team,
      archivedAt: null,
      states: async () => connection(team.states.map(state => ({ ...state }))),
    };
  }

  private decorateState(stateId: string) {
    const match = this.data.states.find(state => state.id === stateId);
    return match ? { ...match } : undefined;
  }

  private decorateProject(project: ProjectData) {
    const self = this;
    return {
      ...project,
      issueCountHistory: project.issueCountHistory,
      completedIssueCountHistory: project.completedIssueCountHistory,
      teams: async () => connection(self.data.teams.map(team => self.decorateTeam(team))),
      projectMilestones: async () => connection(project.milestones.map(m => self.decorateMilestone(m))),
    };
  }

  private decorateIssue(issue: IssueData) {
    const self = this;
    const labels = issue.labelIds
      .map(id => this.data.labels.find(label => label.id === id))
      .filter(Boolean) as LabelData[];
    const team = this.data.teams.find(t => t.id === issue.teamId)!;
    const project = this.data.projects.find(p => p.id === issue.projectId)!;
    const state = this.data.states.find(s => s.id === issue.stateId)!;
    const assignee = this.data.users.find(u => u.id === issue.assigneeId)!;

    const attachmentNodes = (issue.attachments ?? []).map(item => ({
      id: item.id,
      title: item.title,
      subtitle: item.subtitle ?? null,
      url: item.url,
      sourceType: item.sourceType ?? null,
      metadata: item.metadata ?? {},
      groupBySource: false,
      source: null,
      bodyData: null,
      archivedAt: null,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.createdAt),
    }));

    const commentNodes = [
      {
        id: 'comment-1',
        user: this.decorateUser(this.data.users[1]),
        createdAt: new Date('2024-01-06T00:00:00Z'),
        body:
          'Looks good. Another screenshot: https://uploads.linear.app/6db02bb9-fba2-473b-8f9d-f38188e84813/d20adbea-186d-4643-ad07-004bda7d099d',
      },
    ];
    const decorated: any = {
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      number: issue.number,
      title: issue.title,
      priority: issue.priority,
      labels: async () => {
        self.__ltuiRequestCounts.labels += 1;
        return connection(labels.map(label => ({ ...label })));
      },
      description: issue.description,
      createdAt: new Date(issue.createdAt),
      updatedAt: new Date(issue.updatedAt),
      attachments: async (variables?: any) => {
        self.__ltuiRequestCounts.attachments += 1;
        return connection(attachmentNodes, variables);
      },
      comments: async (variables?: any) => {
        self.__ltuiRequestCounts.comments += 1;
        return connection(commentNodes, variables);
      },
      history: async () => {
        self.__ltuiRequestCounts.history += 1;
        return (
        connection([
          {
            id: 'history-1',
            actor: this.decorateUser(this.data.users[0]),
            createdAt: new Date('2024-01-07T00:00:00Z'),
            toState: this.decorateState('state-2'),
          },
        ])
        );
      },
    };
    Object.defineProperties(decorated, {
      state: {
        get() {
          self.__ltuiRequestCounts.state += 1;
          return { ...state };
        },
      },
      team: {
        get() {
          self.__ltuiRequestCounts.team += 1;
          return self.decorateTeam(team);
        },
      },
      project: {
        get() {
          self.__ltuiRequestCounts.project += 1;
          return self.decorateProject(project);
        },
      },
      assignee: {
        get() {
          self.__ltuiRequestCounts.assignee += 1;
          return self.decorateUser(assignee);
        },
      },
    });
    return decorated;
  }

  private decorateUser(user: UserData) {
    return { ...user };
  }

  private decorateDocument(doc: DocumentData) {
    const project = this.data.projects.find(p => p.id === doc.projectId)!;
    return {
      ...doc,
      updatedAt: new Date(doc.updatedAt),
      project: this.decorateProject(project),
    };
  }

  private decorateRoadmap(roadmap: RoadmapData) {
    const owner = this.data.users.find(u => u.id === roadmap.ownerId)!;
    return {
      ...roadmap,
      owner: this.decorateUser(owner),
      updatedAt: new Date('2024-01-08T00:00:00Z'),
      projects: async () => connection(roadmap.projectIds.map(id => this.decorateProject(this.data.projects.find(p => p.id === id)!))),
    };
  }

  private decorateMilestone(milestone: MilestoneData) {
    return {
      ...milestone,
      project: this.decorateProject(this.data.projects.find(p => p.id === milestone.projectId)!),
    };
  }
}
