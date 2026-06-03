import type { Command } from 'commander';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveConfig } from '../config.js';
import { createLinearClient } from '../client.js';
import {
  ColumnDefinition,
  emitDetailBlock,
  emitError,
  renderDetailOrJsonRecord,
  renderPaginatedList,
  sanitizeSingleLine,
  truncateMultiline,
} from '../format.js';
import { getGlobalOptions } from '../options.js';
import {
  findProjectByKeyOrId,
  findTeamByKeyOrId,
  findWorkflowStateByNameOrId,
  executeRawGraphQL,
  parseLinearError,
  readTextOrPath,
  resolveAssigneeId,
  resolveIssueByIdOrKey,
  resolveLabelIds,
  isUuid,
} from '../linear.js';
import { getSavedQuery, listSavedQueries, removeQuery, saveQuery, SavedQueryDefinition } from '../queries.js';
import { extractRateLimitInfo, formatRateLimitLine, RateLimitInfo } from '../rateLimit.js';

interface IssueListRow {
  id: string;
  key: string;
  identifier: string;
  title: string;
  state: string;
  priority: string;
  assignee: string;
  labels: string;
  project: string;
  updatedAt: string;
}

interface IssueAssetRow {
  id: string;
  title: string;
  url: string;
  sourceType: string;
  subtitle: string;
  contentType: string;
  isImage: string;
  createdAt: string;
  downloadPath: string;
  downloadStatus: string;
  downloadError: string;
}

interface IssueListCommandOptions {
  team?: string;
  project?: string;
  state?: string | string[];
  assignee?: string;
  label?: string[];
  search?: string;
  saved?: string;
  updatedSince?: string;
  createdSince?: string;
}

type IssueListField = keyof IssueListRow;

const ISSUE_LIST_FIELD_ORDER: IssueListField[] = [
  'id',
  'key',
  'identifier',
  'title',
  'state',
  'priority',
  'assignee',
  'labels',
  'project',
  'updatedAt',
];

const ISSUE_LIST_COLUMNS: ColumnDefinition<IssueListRow>[] = [
  { key: 'id', header: 'id', value: row => row.id },
  { key: 'key', header: 'key', value: row => row.key },
  { key: 'identifier', header: 'identifier', value: row => row.identifier },
  { key: 'title', header: 'title', value: row => row.title },
  { key: 'state', header: 'state', value: row => row.state },
  { key: 'priority', header: 'priority', value: row => row.priority },
  { key: 'assignee', header: 'assignee', value: row => row.assignee },
  { key: 'labels', header: 'labels', value: row => row.labels },
  { key: 'project', header: 'project', value: row => row.project },
  { key: 'updatedAt', header: 'updatedAt', value: row => row.updatedAt },
];

const ISSUE_LIST_SELECTIONS: Record<IssueListField, string[]> = {
  id: ['id'],
  key: ['team { key }'],
  identifier: ['identifier'],
  title: ['title'],
  state: ['state { name }'],
  priority: ['priority'],
  assignee: ['assignee { name }'],
  labels: ['labels(first: 25) { nodes { name } }'],
  project: ['project { name }'],
  updatedAt: ['updatedAt'],
};

export function runIssuesCommands(program: Command): void {
  const issues = program.command('issues').description('Issue operations');

  issues
    .command('list')
    .description('List issues')
    .option('--team <key-or-id>', 'Team key or id')
    .option('--project <key-or-id>', 'Project key or id')
    .option('--state <name-or-id>', 'State name or id', collect)
    .option('--assignee <me|email|id>', 'Assignee')
    .option('--label <name-or-id>', 'Label', collect, [])
    .option('--search <query>', 'Search query')
    .option('--updated-since <iso>', 'Updated since ISO timestamp')
    .option('--created-since <iso>', 'Created since ISO timestamp')
    .option('--saved <name>', 'Saved query name to apply')
    .action(async options => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(program.opts<{ profile?: string }>().profile);
        const client = createLinearClient(resolved);

        const effectiveOptions = mergeSavedQueryOptions(options);
        const filter = await buildIssueFilter(effectiveOptions);
        const data = await fetchIssueListRows(client, effectiveOptions, {
          fields: globalOpts.fields,
          limit: globalOpts.limit,
          cursor: globalOpts.cursor,
        });

        const out = renderPaginatedList(
          data.rows,
          ISSUE_LIST_COLUMNS,
          {
            next: data.pageInfo?.endCursor ?? null,
            prev: data.pageInfo?.startCursor ?? null,
            count: data.rows.length,
            rateLimit: globalOpts.showRateLimit ? data.rateLimit : undefined,
          },
          {
            format: globalOpts.format,
            fields: globalOpts.fields,
          }
        );
        process.stdout.write(out + '\n');
        if (globalOpts.showRateLimit && globalOpts.format !== 'json' && data.rateLimit) {
          process.stderr.write(formatRateLimitLine(data.rateLimit) + '\n');
        }
      } catch (error) {
        writeError(error);
      }
    });

  issues
    .command('attachments')
    .description('List issue attachments and uploaded file URLs')
    .argument('<id>', 'Issue id or key')
    .option('--only-images', 'Only include image-like entries')
    .option('--download-dir <dir>', 'Download matching entries to this directory')
    .option('--overwrite', 'Overwrite existing files')
    .option('--no-linear-attachments', 'Exclude Linear attachments (issue.attachments)')
    .option('--no-upload-urls', 'Exclude uploads.linear.app URLs extracted from markdown')
    .option('--no-scan-comments', 'Do not scan comments for uploads.linear.app URLs')
    .action(async (ref: string, options) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(program.opts<{ profile?: string }>().profile);
        const client = createLinearClient(resolved);
        const issue = await resolveIssueByIdOrKey(client, ref);
        if (!issue) {
          const out = emitError('not_found', `Issue '${ref}' not found`);
          process.stderr.write(out + '\n');
          process.exitCode = 1;
          return;
        }

        const downloadDir = options.downloadDir ? String(options.downloadDir) : null;
        if (downloadDir && !resolved.apiKey) {
          const out = emitError('auth_missing', 'No API key available for downloads');
          process.stderr.write(out + '\n');
          process.exitCode = 1;
          return;
        }

        const rows = await buildIssueAssetRows(issue, {
          includeLinearAttachments: options.linearAttachments !== false,
          includeUploadUrls: options.uploadUrls !== false,
          scanComments: options.scanComments !== false,
        });

        const filtered = options.onlyImages
          ? rows.filter(row => row.isImage === 'true')
          : rows;

        filtered.sort((a, b) => {
          const timeA = a.createdAt;
          const timeB = b.createdAt;
          if (timeA !== timeB) return timeA > timeB ? -1 : 1;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });

        const paginated = paginateLocalRows(filtered, {
          limit: globalOpts.limit,
          cursor: globalOpts.cursor,
        });

        let downloadFailed = false;
        if (downloadDir) {
          await ensureSafeDownloadDir(downloadDir);
          for (const row of paginated.rows) {
            const result = await downloadToDir(row.url, downloadDir, {
              overwrite: !!options.overwrite,
              apiKey: resolved.apiKey ?? '',
              suggestedBaseName: row.title || issue.identifier || 'asset',
              validateImage: row.isImage === 'true',
            });
            row.downloadPath = result.downloadPath;
            row.downloadStatus = result.downloadStatus;
            row.downloadError = result.downloadError;
            if (result.downloadStatus === 'failed') {
              downloadFailed = true;
            }
          }
        }

        const columns: ColumnDefinition<IssueAssetRow>[] = [
          { key: 'id', header: 'id', value: row => row.id },
          { key: 'title', header: 'title', value: row => row.title },
          { key: 'url', header: 'url', value: row => row.url },
          { key: 'sourceType', header: 'sourceType', value: row => row.sourceType },
          { key: 'subtitle', header: 'subtitle', value: row => row.subtitle },
          { key: 'contentType', header: 'contentType', value: row => row.contentType },
          { key: 'isImage', header: 'isImage', value: row => row.isImage },
          { key: 'createdAt', header: 'createdAt', value: row => row.createdAt },
          { key: 'downloadPath', header: 'downloadPath', value: row => row.downloadPath },
          { key: 'downloadStatus', header: 'downloadStatus', value: row => row.downloadStatus },
          { key: 'downloadError', header: 'downloadError', value: row => row.downloadError },
        ];

        const out = renderPaginatedList(
          paginated.rows,
          columns,
          {
            next: paginated.next,
            prev: paginated.prev,
            count: paginated.rows.length,
          },
          { format: globalOpts.format, fields: globalOpts.fields }
        );
        process.stdout.write(out + '\n');
        if (downloadFailed) {
          process.exitCode = 1;
        }
      } catch (error) {
        writeError(error);
      }
    });

  issues
    .command('view')
    .description('View an issue')
    .argument('<id>', 'Issue id or key')
    .option('--include-comments', 'Include comments')
    .option('--include-history', 'Include history')
    .option('--no-attachment-probe', 'Skip default attachment/comment scan for image guidance')
    .option('--max-description-chars <n>', 'Max description chars', parseNumber, 4000)
    .option('--max-comment-chars <n>', 'Max comment chars', parseNumber, 500)
    .action(async (ref: string, options) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(program.opts<{ profile?: string }>().profile);
        const client = createLinearClient(resolved);
        const issue = await resolveIssueByIdOrKey(client, ref);
        if (!issue) {
          const out = emitError('not_found', `Issue '${ref}' not found`);
          process.stderr.write(out + '\n');
          process.exitCode = 1;
          return;
        }

        const descriptionInfo = truncateMultiline(issue.description ?? '', options.maxDescriptionChars);

        // Await related entities as they are promises in the Linear SDK
        const [state, team, project, assignee] = await Promise.all([
          issue.state ? issue.state : undefined,
          issue.team ? issue.team : undefined,
          issue.project ? issue.project : undefined,
          issue.assignee ? issue.assignee : undefined,
        ]);

        const fields: Record<string, string> = {
          ISSUE: `${issue.identifier ?? ''} (${issue.id ?? ''})`,
          TITLE: issue.title ?? '',
          URL: issue.url ?? '',
          STATE: state?.name ?? '',
          PRIORITY: issue.priority?.toString() ?? '',
          TEAM: team?.key ?? '',
          PROJECT: project?.name ?? '',
          ASSIGNEE: assignee?.name ?? '',
          LABELS: extractLabelNames(issue).join(','),
          CREATED_AT: issue.createdAt?.toISOString?.() ?? '',
          UPDATED_AT: issue.updatedAt?.toISOString?.() ?? '',
        };

        const probe =
          options.attachmentProbe === false
            ? null
            : await probeIssueAssets(issue);
        if (probe) {
          fields.ATTACHMENTS_PRESENT = probe.attachmentsPresent ? 'true' : 'false';
          fields.IMAGE_ATTACHMENTS_PRESENT = probe.imageAttachmentsPresent ? 'true' : 'false';
          if (probe.imageAttachmentsPresent) {
            const issueRef = issue.identifier ?? ref;
            fields.IMAGE_ATTACHMENTS_FETCH_CMD = `ltui --format json issues attachments ${issueRef} --only-images`;
            fields.IMAGE_ATTACHMENTS_DOWNLOAD_CMD = `ltui issues attachments ${issueRef} --only-images --download-dir ./.ltui-attachments/${issueRef}`;
          }
        }

        const jsonPayload: Record<string, unknown> = {
          id: issue.id ?? '',
          key: team?.key ?? '',
          identifier: issue.identifier ?? '',
          title: issue.title ?? '',
          url: issue.url ?? '',
          state: state?.name ?? '',
          priority: issue.priority?.toString() ?? '',
          team: team?.key ?? '',
          project: project?.name ?? '',
          assignee: assignee?.name ?? '',
          labels: extractLabelNames(issue),
          createdAt: issue.createdAt?.toISOString?.() ?? '',
          updatedAt: issue.updatedAt?.toISOString?.() ?? '',
          description: {
            text: descriptionInfo.text,
            truncated: descriptionInfo.truncated,
          },
        };
        if (probe) {
          jsonPayload.attachmentsPresent = probe.attachmentsPresent;
          jsonPayload.imageAttachmentsPresent = probe.imageAttachmentsPresent;
          jsonPayload.imageAttachmentsFetchCmd = probe.imageAttachmentsPresent
            ? fields.IMAGE_ATTACHMENTS_FETCH_CMD
            : '';
          jsonPayload.imageAttachmentsDownloadCmd = probe.imageAttachmentsPresent
            ? fields.IMAGE_ATTACHMENTS_DOWNLOAD_CMD
            : '';
        }

        let comments: any[] = [];
        if (options.includeComments) {
          const commentsConnection = await issue.comments({ first: 50 });
          comments = commentsConnection.nodes ?? [];
          jsonPayload.comments = comments.map((comment: any) => {
            const truncated = truncateMultiline(comment.body ?? '', options.maxCommentChars);
            return {
              id: comment.id ?? '',
              author: comment.user?.name ?? '',
              createdAt: comment.createdAt?.toISOString?.() ?? '',
              body: truncated.text,
              truncated: truncated.truncated,
            };
          });
        }

        let historyEntries: any[] = [];
        if (options.includeHistory) {
          const historyConnection = await issue.history({
            first: 50,
            sort: { createdAt: { order: 'Ascending' } },
          });
          historyEntries = historyConnection.nodes ?? [];
          jsonPayload.history = historyEntries.map((entry: any) => {
            const actor = entry.actor?.name ?? entry.actorId ?? '';
            return {
              createdAt: entry.createdAt?.toISOString?.() ?? '',
              actor: sanitizeSingleLine(actor),
              type: determineHistoryType(entry),
              from: sanitizeSingleLine(historyFromValue(entry)),
              to: sanitizeSingleLine(historyToValue(entry)),
            };
          });
        }

        if (globalOpts.format === 'json') {
          const output = renderDetailOrJsonRecord('ISSUE_DETAIL', fields, jsonPayload, {
            format: globalOpts.format,
            fields: globalOpts.fields,
          });
          process.stdout.write(output + '\n');
          return;
        }

        let output = renderDetailOrJsonRecord('ISSUE_DETAIL', fields, jsonPayload, {
          format: globalOpts.format,
          fields: globalOpts.fields,
        });
        output += `\nDESCRIPTION_START\n${descriptionInfo.text}\nDESCRIPTION_END\n`;
        if (descriptionInfo.truncated) {
          output += 'DESCRIPTION_TRUNCATED: true\n';
        }

        if (options.includeComments) {
          const lines: string[] = ['COMMENTS_START'];
          for (const comment of comments) {
            const truncated = truncateMultiline(comment.body ?? '', options.maxCommentChars);
            const row = [
              comment.id,
              comment.user?.name ?? '',
              comment.createdAt?.toISOString() ?? '',
              sanitizeSingleLine(truncated.text),
            ];
            lines.push(row.join('\t'));
            if (truncated.truncated) {
              lines.push(`COMMENT_TRUNCATED: ${comment.id}`);
            }
          }
          lines.push('COMMENTS_END');
          output += `${lines.join('\n')}\n`;
        }

        if (options.includeHistory) {
          const lines: string[] = ['HISTORY_START'];
          for (const entry of historyEntries) {
            const actor = entry.actor?.name ?? entry.actorId ?? '';
            const changeType = determineHistoryType(entry);
            const fromValue = historyFromValue(entry);
            const toValue = historyToValue(entry);
            const row = [
              entry.createdAt?.toISOString() ?? '',
              sanitizeSingleLine(actor),
              changeType,
              sanitizeSingleLine(fromValue),
              sanitizeSingleLine(toValue),
            ];
            lines.push(row.join('\t'));
          }
          lines.push('HISTORY_END');
          output += `${lines.join('\n')}\n`;
        }

        process.stdout.write(output);
      } catch (error) {
        writeError(error);
      }
    });

  issues
    .command('create')
    .description('Create an issue')
    .option('--team <key>', 'Team key (default from .ltui.json)')
    .option('--project <key-or-id>', 'Project key or id (default from .ltui.json)')
    .requiredOption('--title <title>', 'Issue title')
    .option('--description <text-or-@path>', 'Description text or @path')
    .option('--state <name-or-id>', 'State name or id')
    .option('--label <name-or-id>', 'Label', collect, [])
    .option('--assignee <me|email|id>', 'Assignee')
    .option('--priority <0-4>', 'Priority', parseNumber)
    .action(async options => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(program.opts<{ profile?: string }>().profile);
        const client = createLinearClient(resolved);

        const configDefaults = resolved.projectConfig ?? {};
        const teamRef: string | undefined = options.team ?? configDefaults.teamKey;
        if (!teamRef) {
          const out = emitError(
            'validation_error',
            'Team is required to create an issue (use --team or configure .ltui.json)'
          );
          process.stderr.write(out + '\n');
          process.exitCode = 1;
          return;
        }

        const team = await findTeamByKeyOrId(client, teamRef);
        if (!team) {
          const out = emitError('not_found', `Team '${teamRef}' not found`);
          process.stderr.write(out + '\n');
          process.exitCode = 1;
          return;
        }

        let projectId: string | undefined;
        const projectRef: string | undefined = options.project ?? configDefaults.projectId;
        if (projectRef) {
          const project = await findProjectByKeyOrId(client, projectRef);
          if (!project) {
            const out = emitError('not_found', `Project '${projectRef}' not found`);
            process.stderr.write(out + '\n');
            process.exitCode = 1;
            return;
          }
          projectId = project.id;
        }

        let description: string | undefined;
        if (options.description) {
          description = readTextOrPath(options.description);
        }

        const desiredState = options.state ?? configDefaults.defaultIssueState;
        let stateId: string | undefined;
        if (desiredState) {
          const state = await findWorkflowStateByNameOrId(client, team.id, desiredState);
          if (!state) {
            const out = emitError('not_found', `Workflow state '${desiredState}' not found`);
            process.stderr.write(out + '\n');
            process.exitCode = 1;
            return;
          }
          stateId = state.id;
        }

        const labelNames = [...(configDefaults.defaultLabels ?? []), ...(options.label ?? [])];
        const labelIds = await resolveLabelIds(client, labelNames, team.id);

        const assigneeRef: string | undefined = options.assignee ?? configDefaults.defaultAssignee;
        let assigneeId: string | undefined;
        if (assigneeRef) {
          assigneeId = await resolveAssigneeId(client, assigneeRef);
          if (!assigneeId) {
            const out = emitError('not_found', `Assignee '${assigneeRef}' not found`);
            process.stderr.write(out + '\n');
            process.exitCode = 1;
            return;
          }
        }

        const input: Record<string, unknown> = {
          teamId: team.id,
          title: options.title as string,
        };
        if (projectId) input.projectId = projectId;
        if (description !== undefined) input.description = description;
        if (stateId) input.stateId = stateId;
        if (labelIds.length > 0) input.labelIds = labelIds;
        if (assigneeId) input.assigneeId = assigneeId;
        if (typeof options.priority === 'number' && !Number.isNaN(options.priority)) {
          input.priority = options.priority;
        }

        const payload = await client.createIssue(input as any);
        const issue = payload.issue ? await payload.issue : null;
        if (!issue) {
          const out = emitError('api_error', 'Failed to load created issue');
          process.stderr.write(out + '\n');
          process.exitCode = 1;
          return;
        }
        const block = await formatIssueSummaryBlock('ISSUE_CREATED', issue, {
          format: globalOpts.format,
          fields: globalOpts.fields,
        });
        process.stdout.write(block + '\n');
      } catch (error) {
        writeError(error);
      }
    });

  issues
    .command('update')
    .description('Update an issue')
    .argument('<issue-id-or-key>', 'Issue id or key')
    .option('--team <key>', 'Team key override')
    .option('--project <key-or-id>', 'Project key or id')
    .option('--title <title>', 'Updated title')
    .option('--description <text-or-@path>', 'Description text or @path')
    .option('--state <name-or-id>', 'State name or id')
    .option('--label <name-or-id>', 'Replace labels with these', collect, [])
    .option('--add-label <name-or-id>', 'Labels to add', collect, [])
    .option('--remove-label <name-or-id>', 'Labels to remove', collect, [])
    .option('--assignee <me|email|id>', 'Assignee')
    .option('--priority <0-4>', 'Priority', parseNumber)
    .option('--estimate <number>', 'Estimate', parseNumber)
    .option('--due <iso>', 'Due date ISO string')
    .action(async (ref: string, options) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(program.opts<{ profile?: string }>().profile);
        const client = createLinearClient(resolved);
        const issue = await resolveIssueByIdOrKey(client, ref);
        if (!issue) {
          const out = emitError('not_found', `Issue '${ref}' not found`);
          process.stderr.write(out + '\n');
          process.exitCode = 1;
          return;
        }

        const input: Record<string, unknown> = {};
        let changed = false;

        // Await team as it's a promise in the Linear SDK
        const currentTeam = issue.team ? await issue.team : undefined;
        let effectiveTeamId: string | undefined = currentTeam?.id;
        if (options.team) {
          const team = await findTeamByKeyOrId(client, options.team);
          if (!team) {
            const out = emitError('not_found', `Team '${options.team}' not found`);
            process.stderr.write(out + '\n');
            process.exitCode = 1;
            return;
          }
          input.teamId = team.id;
          effectiveTeamId = team.id;
          changed = true;
        }

        if (options.project) {
          const project = await findProjectByKeyOrId(client, options.project);
          if (!project) {
            const out = emitError('not_found', `Project '${options.project}' not found`);
            process.stderr.write(out + '\n');
            process.exitCode = 1;
            return;
          }
          input.projectId = project.id;
          changed = true;
        }

        if (options.title) {
          input.title = options.title;
          changed = true;
        }

        if (options.description) {
          input.description = readTextOrPath(options.description);
          changed = true;
        }

        if (options.state) {
          if (!effectiveTeamId) {
            const out = emitError('validation_error', 'Cannot change state without team context');
            process.stderr.write(out + '\n');
            process.exitCode = 1;
            return;
          }
          const state = await findWorkflowStateByNameOrId(client, effectiveTeamId, options.state);
          if (!state) {
            const out = emitError('not_found', `Workflow state '${options.state}' not found`);
            process.stderr.write(out + '\n');
            process.exitCode = 1;
            return;
          }
          input.stateId = state.id;
          changed = true;
        }

        if (options.assignee) {
          const assigneeId = await resolveAssigneeId(client, options.assignee);
          if (!assigneeId) {
            const out = emitError('not_found', `Assignee '${options.assignee}' not found`);
            process.stderr.write(out + '\n');
            process.exitCode = 1;
            return;
          }
          input.assigneeId = assigneeId;
          changed = true;
        }

        if (typeof options.priority === 'number' && !Number.isNaN(options.priority)) {
          input.priority = options.priority;
          changed = true;
        }

        if (typeof options.estimate === 'number' && !Number.isNaN(options.estimate)) {
          input.estimate = options.estimate;
          changed = true;
        }

        if (options.due) {
          input.dueDate = options.due;
          changed = true;
        }

        const replaceLabels: string[] = options.label ?? [];
        const addLabels: string[] = options.addLabel ?? [];
        const removeLabels: string[] = options.removeLabel ?? [];
        if (replaceLabels.length || addLabels.length || removeLabels.length) {
          if (!effectiveTeamId) {
            const out = emitError(
              'validation_error',
              'Cannot modify labels without determining the team'
            );
            process.stderr.write(out + '\n');
            process.exitCode = 1;
            return;
          }

          const labelConnection =
            typeof issue.labels === 'function'
              ? await issue.labels({ first: 50 })
              : { nodes: issue.labels ?? [] };
          const currentLabels = labelConnection.nodes ?? [];
          let working: string[] = replaceLabels.length
            ? await resolveLabelIds(client, replaceLabels, effectiveTeamId)
            : (currentLabels.map((label: any) => label.id) ?? []);

          if (removeLabels.length > 0) {
            for (const name of removeLabels) {
              const label = currentLabels.find((item: any) => item.name === name);
              if (!label) {
                const out = emitError('not_found', `Label '${name}' is not on the issue`);
                process.stderr.write(out + '\n');
                process.exitCode = 1;
                return;
              }
              working = working.filter(id => id !== label.id);
            }
          }

          if (addLabels.length > 0) {
            const addIds = await resolveLabelIds(client, addLabels, effectiveTeamId);
            for (const id of addIds) {
              if (!working.includes(id)) working.push(id);
            }
          }

          input.labelIds = working;
          changed = true;
        }

        if (!changed) {
          const out = emitError('validation_error', 'No updates specified');
          process.stderr.write(out + '\n');
          process.exitCode = 1;
          return;
        }

        await client.updateIssue(issue.id, input as any);
        const updatedIssue = await client.issue(issue.id);
        const block = await formatIssueSummaryBlock('ISSUE_UPDATED', updatedIssue, {
          format: globalOpts.format,
          fields: globalOpts.fields,
        });
        process.stdout.write(block + '\n');
      } catch (error) {
        writeError(error);
      }
    });

  issues
    .command('comment')
    .description('Add a comment to an issue')
    .argument('<issue-id-or-key>', 'Issue id or key')
    .requiredOption('--body <text-or-@path>', 'Comment body or @path')
    .action(async (ref: string, options) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(program.opts<{ profile?: string }>().profile);
        const client = createLinearClient(resolved);
        const issue = await resolveIssueByIdOrKey(client, ref);
        if (!issue) {
          const out = emitError('not_found', `Issue '${ref}' not found`);
          process.stderr.write(out + '\n');
          process.exitCode = 1;
          return;
        }

        const body = readTextOrPath(options.body);
        const payload = await client.createComment({ issueId: issue.id, body });
        const comment = payload.comment ? await payload.comment : undefined;
        const author = comment?.user ? await comment.user : undefined;
        const detailFields = {
          COMMENT: `${comment?.id ?? ''}`,
          AUTHOR: author?.name ?? '',
          CREATED_AT: comment?.createdAt?.toISOString?.() ?? '',
          ISSUE: issue.identifier ?? issue.id,
        };
        const block = renderDetailOrJsonRecord(
          'COMMENT_CREATED',
          detailFields,
          {
            comment: comment?.id ?? '',
            author: author?.name ?? '',
            createdAt: comment?.createdAt?.toISOString?.() ?? '',
            issue: issue.identifier ?? issue.id ?? '',
          },
          { format: globalOpts.format, fields: globalOpts.fields }
        );
        process.stdout.write(block + '\n');
      } catch (error) {
        writeError(error);
      }
    });

  issues
    .command('upload')
    .description('Upload a local image to an issue')
    .argument('<issue-id-or-key>', 'Issue id or key')
    .requiredOption('--file <path>', 'Local image file to upload')
    .option('--title <title>', 'Title used in the generated comment')
    .option('--alt <text>', 'Alt text for the markdown image')
    .option('--content-type <type>', 'Override detected image content type')
    .option('--no-comment', 'Upload only; do not add an issue comment')
    .action(async (ref: string, options) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(program.opts<{ profile?: string }>().profile);
        const client = createLinearClient(resolved);
        const issue = await resolveIssueByIdOrKey(client, ref);
        if (!issue) {
          const out = emitError('not_found', `Issue '${ref}' not found`);
          process.stderr.write(out + '\n');
          process.exitCode = 1;
          return;
        }

        const fileInfo = await prepareLocalImageUpload(options.file, options.contentType);
        const assetUrl = await uploadFileToLinear(client, fileInfo);
        const title = sanitizeSingleLine(options.title ?? path.basename(fileInfo.path));
        const alt = sanitizeMarkdownAlt(options.alt ?? title);
        const markdown = `![${alt}](<${assetUrl}>)`;

        let attachment: any | undefined;
        let attachmentError = '';
        try {
          const payload = await client.createAttachment({
            issueId: issue.id,
            url: assetUrl,
            title,
            metadata: {
              contentType: fileInfo.contentType,
              filename: fileInfo.filename,
              size: fileInfo.size,
            },
            subtitle: `file:${fileInfo.filename}`,
          });
          if (!payload?.success) {
            throw new Error('attachment_create_failed');
          }
          attachment = payload.attachment ? await payload.attachment : undefined;
        } catch (error) {
          attachmentError = sanitizeSingleLine(String((error as Error)?.message ?? error));
          process.exitCode = 1;
        }

        let comment: any | undefined;
        let commentError = '';
        if (options.comment !== false) {
          const body = title ? `${title}\n\n${markdown}` : markdown;
          try {
            const payload = await client.createComment({ issueId: issue.id, body });
            if (!payload?.success) {
              throw new Error('comment_create_failed');
            }
            comment = payload.comment ? await payload.comment : undefined;
          } catch (error) {
            commentError = sanitizeSingleLine(String((error as Error)?.message ?? error));
            process.exitCode = 1;
          }
        }

        const detailFields = {
          ISSUE: issue.identifier ?? issue.id,
          FILE: fileInfo.path,
          CONTENT_TYPE: fileInfo.contentType,
          SIZE: String(fileInfo.size),
          URL: assetUrl,
          MARKDOWN: markdown,
          ATTACHMENT: `${attachment?.id ?? ''}`,
          ATTACHMENT_STATUS: attachmentError ? 'failed' : 'created',
          ATTACHMENT_ERROR: attachmentError,
          COMMENT: `${comment?.id ?? ''}`,
          COMMENT_STATUS: commentError ? 'failed' : options.comment === false ? 'skipped' : 'created',
          COMMENT_ERROR: commentError,
        };
        const block = renderDetailOrJsonRecord(
          'IMAGE_UPLOADED',
          detailFields,
          {
            issue: issue.identifier ?? issue.id ?? '',
            file: fileInfo.path,
            contentType: fileInfo.contentType,
            size: fileInfo.size,
            url: assetUrl,
            markdown,
            attachment: attachment?.id ?? '',
            attachmentStatus: attachmentError ? 'failed' : 'created',
            attachmentError,
            comment: comment?.id ?? '',
            commentStatus: commentError ? 'failed' : options.comment === false ? 'skipped' : 'created',
            commentError,
          },
          { format: globalOpts.format, fields: globalOpts.fields }
        );
        process.stdout.write(block + '\n');
      } catch (error) {
        writeError(error);
      }
    });

  issues
    .command('link')
    .description('Attach a link to an issue')
    .argument('<issue-id-or-key>', 'Issue id or key')
    .requiredOption('--url <url>', 'URL to attach')
    .option('--title <title>', 'Title for the attachment')
    .option('--branch <branch>', 'Branch name metadata')
    .option('--commit <sha>', 'Commit SHA metadata')
    .action(async (ref: string, options) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(program.opts<{ profile?: string }>().profile);
        const client = createLinearClient(resolved);
        const issue = await resolveIssueByIdOrKey(client, ref);
        if (!issue) {
          const out = emitError('not_found', `Issue '${ref}' not found`);
          process.stderr.write(out + '\n');
          process.exitCode = 1;
          return;
        }

        const attachmentInput: Record<string, unknown> = {
          issueId: issue.id,
          url: options.url,
          title: options.title ?? options.url,
        };
        const metadata: Record<string, string> = {};
        if (options.branch) metadata.branch = options.branch;
        if (options.commit) metadata.commit = options.commit;
        if (Object.keys(metadata).length > 0) {
          attachmentInput.metadata = metadata;
          const subtitleParts: string[] = [];
          if (options.branch) subtitleParts.push(`branch:${options.branch}`);
          if (options.commit) subtitleParts.push(`commit:${options.commit}`);
          attachmentInput.subtitle = subtitleParts.join(' ');
        }

        const payload = await client.createAttachment(attachmentInput as any);
        const attachment = payload.attachment ? await payload.attachment : undefined;
        const detailFields = {
          ATTACHMENT: `${attachment?.id ?? ''}`,
          TITLE: attachment?.title ?? '',
          URL: attachment?.url ?? '',
          ISSUE: issue.identifier ?? issue.id,
          BRANCH: options.branch ?? '',
          COMMIT: options.commit ?? '',
        };
        const block = renderDetailOrJsonRecord(
          'LINK_ATTACHED',
          detailFields,
          {
            attachment: attachment?.id ?? '',
            title: attachment?.title ?? '',
            url: attachment?.url ?? '',
            issue: issue.identifier ?? issue.id ?? '',
            branch: options.branch ?? '',
            commit: options.commit ?? '',
          },
          { format: globalOpts.format, fields: globalOpts.fields }
        );
        process.stdout.write(block + '\n');
      } catch (error) {
        writeError(error);
      }
    });

  issues
    .command('relate')
    .description('Relate a child issue to a parent')
    .argument('<child-id-or-key>', 'Child issue id or key')
    .requiredOption('--parent <parent-id-or-key>', 'Parent issue id or key')
    .action(async (childRef: string, options) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(program.opts<{ profile?: string }>().profile);
        const client = createLinearClient(resolved);
        const child = await resolveIssueByIdOrKey(client, childRef);
        const parent = await resolveIssueByIdOrKey(client, options.parent);
        if (!child || !parent) {
          const out = emitError('not_found', 'Could not resolve child or parent issue');
          process.stderr.write(out + '\n');
          process.exitCode = 1;
          return;
        }

        await client.updateIssue(child.id, { parentId: parent.id });
        const detailFields = {
          CHILD: `${child.identifier ?? child.id}`,
          PARENT: `${parent.identifier ?? parent.id}`,
          RELATION: 'parent-child',
        };
        const block = renderDetailOrJsonRecord(
          'RELATIONSHIP_UPDATED',
          detailFields,
          {
            child: child.identifier ?? child.id ?? '',
            parent: parent.identifier ?? parent.id ?? '',
            relation: 'parent-child',
          },
          { format: globalOpts.format, fields: globalOpts.fields }
        );
        process.stdout.write(block + '\n');
      } catch (error) {
        writeError(error);
      }
    });

  issues
    .command('block')
    .description('Mark an issue as blocked by another issue')
    .argument('<issue-id-or-key>', 'Issue id or key')
    .requiredOption('--blocked-by <other-id-or-key>', 'Issue causing the block')
    .action(async (issueRef: string, options) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(program.opts<{ profile?: string }>().profile);
        const client = createLinearClient(resolved);
        const issue = await resolveIssueByIdOrKey(client, issueRef);
        const blocker = await resolveIssueByIdOrKey(client, options.blockedBy);
        if (!issue || !blocker) {
          const out = emitError('not_found', 'Could not resolve issue or blocker');
          process.stderr.write(out + '\n');
          process.exitCode = 1;
          return;
        }

        await client.createIssueRelation({
          issueId: blocker.id,
          relatedIssueId: issue.id,
          type: 'blocks' as any,
        });

        const detailFields = {
          ISSUE: `${issue.identifier ?? issue.id}`,
          BLOCKED_BY: `${blocker.identifier ?? blocker.id}`,
          RELATION: 'blocks',
        };
        const block = renderDetailOrJsonRecord(
          'RELATIONSHIP_UPDATED',
          detailFields,
          {
            issue: issue.identifier ?? issue.id ?? '',
            blockedBy: blocker.identifier ?? blocker.id ?? '',
            relation: 'blocks',
          },
          { format: globalOpts.format, fields: globalOpts.fields }
        );
        process.stdout.write(block + '\n');
      } catch (error) {
        writeError(error);
      }
    });

  const saved = issues.command('saved').description('Manage saved issue queries');

  saved
    .command('list')
    .description('List saved issue queries')
    .action(() => {
      const savedQueries = listSavedQueries();
      const globalOpts = getGlobalOptions(program);
      const columns: ColumnDefinition<SavedQueryDefinition>[] = [
        { key: 'name', header: 'name', value: row => row.name },
        { key: 'search', header: 'search', value: row => row.search ?? '' },
        { key: 'team', header: 'team', value: row => row.team ?? '' },
        { key: 'project', header: 'project', value: row => row.project ?? '' },
        { key: 'state', header: 'state', value: row => row.state ?? '' },
        {
          key: 'labels',
          header: 'labels',
          value: row => (row.labels ?? []).join(','),
        },
      ];
       const out = renderPaginatedList(
         savedQueries,
         columns,
         { next: null, prev: null, count: savedQueries.length },
         {
           format: globalOpts.format,
           fields: globalOpts.fields,
         }
       );
       process.stdout.write(out + '\n');
     });

  saved
    .command('add')
    .description('Add or update a saved query')
    .requiredOption('--name <name>', 'Query name')
    .option('--search <query>', 'Search term')
    .option('--team <key-or-id>', 'Team filter')
    .option('--project <key-or-id>', 'Project filter')
    .option('--state <name-or-id>', 'Workflow state')
    .option('--assignee <me|email|id>', 'Assignee filter')
    .option('--label <name-or-id>', 'Label filter', collect, [])
    .option('--updated-since <iso>', 'Updated since ISO timestamp')
    .option('--created-since <iso>', 'Created since ISO timestamp')
    .action(options => {
      const globalOpts = getGlobalOptions(program);
      const definition: SavedQueryDefinition = {
        name: options.name,
        search: options.search,
        team: options.team,
        project: options.project,
        state: options.state,
        assignee: options.assignee,
        labels: options.label && options.label.length > 0 ? options.label : undefined,
        updatedSince: options.updatedSince,
        createdSince: options.createdSince,
      };
      saveQuery(definition);
      const detailFields = {
        NAME: definition.name,
        TEAM: definition.team ?? '',
        PROJECT: definition.project ?? '',
        STATE: definition.state ?? '',
        LABELS: (definition.labels ?? []).join(','),
      };
      const block = renderDetailOrJsonRecord(
        'SAVED_QUERY_ADDED',
        detailFields,
        {
          name: definition.name,
          team: definition.team ?? '',
          project: definition.project ?? '',
          state: definition.state ?? '',
          labels: definition.labels ?? [],
        },
        { format: globalOpts.format, fields: globalOpts.fields }
      );
      process.stdout.write(block + '\n');
    });

  saved
    .command('remove')
    .description('Remove a saved query')
    .requiredOption('--name <name>', 'Query name')
    .action(options => {
      const globalOpts = getGlobalOptions(program);
      removeQuery(options.name);
      const detailFields = {
        NAME: options.name,
      };
      const block = renderDetailOrJsonRecord(
        'SAVED_QUERY_REMOVED',
        detailFields,
        { name: options.name },
        { format: globalOpts.format, fields: globalOpts.fields }
      );
      process.stdout.write(block + '\n');
    });
}

function mergeSavedQueryOptions(options: IssueListCommandOptions): IssueListCommandOptions {
  if (!options.saved) {
    return options;
  }
  const saved = getSavedQuery(options.saved);
  if (!saved) {
    throw new Error(`not_found Saved query '${options.saved}' not found`);
  }
  const labelValues = options.label && options.label.length > 0 ? options.label : saved.labels ?? [];
  const stateValues = Array.isArray(options.state) && options.state.length === 0 ? undefined : options.state;
  return {
    ...options,
    team: options.team ?? saved.team,
    project: options.project ?? saved.project,
    state: stateValues ?? saved.state,
    assignee: options.assignee ?? saved.assignee,
    label: labelValues,
    search: options.search ?? saved.search,
    updatedSince: options.updatedSince ?? saved.updatedSince,
    createdSince: options.createdSince ?? saved.createdSince,
  };
}

async function fetchIssueListRows(
  client: any,
  options: IssueListCommandOptions,
  queryOptions: { fields?: string[]; limit: number; cursor: string | null }
): Promise<{ rows: IssueListRow[]; pageInfo: any; rateLimit?: RateLimitInfo }> {
  const selectedFields = selectIssueListFields(queryOptions.fields);
  const selection = buildIssueListSelection(selectedFields);
  const isSearch = !!options.search;
  const query = isSearch ? buildIssueSearchQuery(selection) : buildIssueListQuery(selection);
  const variables: Record<string, unknown> = {
    first: queryOptions.limit,
    after: queryOptions.cursor,
    filter: await buildIssueFilter(options),
  };
  if (isSearch) {
    variables.term = options.search;
  } else {
    variables.sort = [{ updatedAt: { order: 'Descending' } }];
  }

  const response = await executeRawGraphQL(client, query, variables);
  const connection = isSearch ? response.data?.searchIssues : response.data?.issues;
  const nodes = connection?.nodes ?? [];
  return {
    rows: nodes.map(mapRawIssueToRow),
    pageInfo: connection?.pageInfo ?? {},
    rateLimit: extractRateLimitInfo(response.headers),
  };
}

function selectIssueListFields(fields?: string[]): IssueListField[] {
  const selected = fields && fields.length > 0 ? fields : ISSUE_LIST_FIELD_ORDER;
  const available = new Set<string>(ISSUE_LIST_FIELD_ORDER);
  const missing = selected.filter(field => !available.has(field));
  if (missing.length > 0) {
    throw new Error(`validation_error Unknown field(s): ${missing.join(', ')}`);
  }
  return selected as IssueListField[];
}

function buildIssueListSelection(fields: IssueListField[]): string {
  const selections = new Set<string>();
  for (const field of fields) {
    for (const selection of ISSUE_LIST_SELECTIONS[field]) {
      selections.add(selection);
    }
  }
  return Array.from(selections).join('\n');
}

function buildIssueListQuery(selection: string): string {
  return `
    query LtuiIssueList($first: Int, $after: String, $filter: IssueFilter, $sort: [IssueSortInput!]) {
      issues(first: $first, after: $after, filter: $filter, sort: $sort) {
        nodes {
          ${selection}
        }
        pageInfo {
          endCursor
          startCursor
          hasNextPage
          hasPreviousPage
        }
      }
    }
  `;
}

function buildIssueSearchQuery(selection: string): string {
  return `
    query LtuiIssueSearch($term: String!, $first: Int, $after: String, $filter: IssueFilter) {
      searchIssues(term: $term, first: $first, after: $after, filter: $filter) {
        nodes {
          ${selection}
        }
        pageInfo {
          endCursor
          startCursor
          hasNextPage
          hasPreviousPage
        }
      }
    }
  `;
}

async function buildIssueFilter(options: Record<string, any>): Promise<Record<string, unknown>> {
  const filter: Record<string, unknown> = {};

  if (options.team) {
    const teamValue = String(options.team);
    const teamFilters: any[] = [
      { key: { eq: teamValue.toUpperCase() } },
      { name: { eq: teamValue } },
    ];
    if (isUuid(teamValue)) {
      teamFilters.unshift({ id: { eq: teamValue } });
    }
    filter.team = { or: teamFilters };
  }

  if (options.project) {
    const projectValue = String(options.project);
    const projectFilters: any[] = [
      { slugId: { eq: projectValue } },
      { name: { eq: projectValue } },
    ];
    if (isUuid(projectValue)) {
      projectFilters.unshift({ id: { eq: projectValue } });
    }
    filter.project = { or: projectFilters };
  }

  const stateValues = Array.isArray(options.state)
    ? options.state
    : options.state
      ? [String(options.state)]
      : [];
  if (stateValues.length > 0) {
    const stateFilters: any[] = [];
    for (const stateValue of stateValues) {
      if (isUuid(stateValue)) {
        stateFilters.push({ id: { eq: stateValue } });
      } else {
        stateFilters.push({ name: { eq: stateValue } });
      }
    }
    filter.state = { or: stateFilters };
  }

  if (options.assignee) {
    if (options.assignee === 'me') {
      filter.assignee = { isMe: { eq: true } };
    } else if (options.assignee.includes('@')) {
      filter.assignee = { email: { eq: options.assignee } };
    } else {
      const assigneeFilters: any[] = [{ name: { eq: options.assignee } }];
      if (isUuid(options.assignee)) {
        assigneeFilters.unshift({ id: { eq: options.assignee } });
      }
      filter.assignee = { or: assigneeFilters };
    }
  }

  if (options.label && options.label.length > 0) {
    filter.labels = {
      and: options.label.map((name: string) => ({ some: { name: { eq: name } } })),
    };
  }

  if (options.updatedSince) {
    filter.updatedAt = { gte: options.updatedSince };
  }

  if (options.createdSince) {
    filter.createdAt = { gte: options.createdSince };
  }

  return filter;
}

async function mapIssueToRow(issue: any): Promise<IssueListRow> {
  // Await related entities as they are promises in the Linear SDK
  const [team, state, project, assignee] = await Promise.all([
    issue.team ? issue.team : undefined,
    issue.state ? issue.state : undefined,
    issue.project ? issue.project : undefined,
    issue.assignee ? issue.assignee : undefined,
  ]);

  let labelNames: string[] = [];
  if (typeof issue.labels === 'function') {
    const connection = await issue.labels({ first: 25 });
    labelNames = connection.nodes.map((label: any) => label.name).filter(Boolean);
  } else {
    labelNames = extractLabelNames(issue);
  }
  const updatedAt =
    typeof issue.updatedAt?.toISOString === 'function'
      ? issue.updatedAt.toISOString()
      : issue.updatedAt ?? '';
  return {
    id: issue.id ?? '',
    key: team?.key ?? '',
    identifier: issue.identifier ?? '',
    title: sanitizeSingleLine(issue.title ?? ''),
    state: state?.name ?? '',
    priority: issue.priority?.toString() ?? '',
    assignee: assignee?.name ?? '-',
    labels: labelNames.join(','),
    project: project?.name ?? '-',
    updatedAt,
  };
}

function mapRawIssueToRow(issue: any): IssueListRow {
  const labels = Array.isArray(issue.labels?.nodes)
    ? issue.labels.nodes.map((label: any) => label.name).filter(Boolean)
    : [];
  const updatedAt =
    typeof issue.updatedAt?.toISOString === 'function'
      ? issue.updatedAt.toISOString()
      : issue.updatedAt ?? '';
  return {
    id: issue.id ?? '',
    key: issue.team?.key ?? '',
    identifier: issue.identifier ?? '',
    title: sanitizeSingleLine(issue.title ?? ''),
    state: issue.state?.name ?? '',
    priority: issue.priority?.toString() ?? '',
    assignee: issue.assignee?.name ?? '-',
    labels: labels.join(','),
    project: issue.project?.name ?? '-',
    updatedAt,
  };
}

function extractLabelNames(issue: any): string[] {
  if (Array.isArray(issue.labels)) {
    return issue.labels.map((label: any) => label.name).filter(Boolean);
  }
  if (issue.labels?.nodes) {
    return issue.labels.nodes.map((label: any) => label.name).filter(Boolean);
  }
  return [];
}

function paginateLocalRows<T>(
  rows: T[],
  options: { limit: number; cursor: string | null }
): { rows: T[]; next: string | null; prev: string | null } {
  const first =
    typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? Math.trunc(options.limit)
      : rows.length;
  const afterIndex = parseLocalCursor(options.cursor);
  const startIndex = afterIndex !== null ? afterIndex + 1 : 0;
  const pageRows = rows.slice(startIndex, startIndex + first);
  const endIndex = pageRows.length > 0 ? startIndex + pageRows.length - 1 : -1;
  const startCursor = pageRows.length > 0 ? `cursor:${startIndex}` : null;
  const endCursor = pageRows.length > 0 ? `cursor:${endIndex}` : null;
  const hasNextPage = endIndex >= 0 ? endIndex < rows.length - 1 : false;
  const hasPreviousPage = startIndex > 0;

  return {
    rows: pageRows,
    next: hasNextPage ? endCursor : null,
    prev: hasPreviousPage ? startCursor : null,
  };
}

function parseLocalCursor(cursor: string | null): number | null {
  if (!cursor) return null;
  const match = /^cursor:(\d+)$/.exec(cursor);
  if (!match) return null;
  const parsed = parseInt(match[1] ?? '', 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function determineHistoryType(entry: any): string {
  if (entry.toState || entry.fromState) return 'state';
  if (entry.toAssignee || entry.fromAssignee) return 'assignee';
  if (entry.toPriority || entry.fromPriority) return 'priority';
  if (entry.toProject || entry.fromProject) return 'project';
  if (entry.toTitle || entry.fromTitle) return 'title';
  return 'update';
}

function historyFromValue(entry: any): string {
  if (entry.fromState) return entry.fromState.name ?? '';
  if (entry.fromAssignee) return entry.fromAssignee.name ?? '';
  if (entry.fromPriority !== undefined) return String(entry.fromPriority);
  if (entry.fromProject) return entry.fromProject.name ?? '';
  if (entry.fromTitle) return entry.fromTitle;
  return '';
}

function historyToValue(entry: any): string {
  if (entry.toState) return entry.toState.name ?? '';
  if (entry.toAssignee) return entry.toAssignee.name ?? '';
  if (entry.toPriority !== undefined) return String(entry.toPriority);
  if (entry.toProject) return entry.toProject.name ?? '';
  if (entry.toTitle) return entry.toTitle;
  return '';
}

async function formatIssueSummaryBlock(
  header: string,
  issue: any,
  outputOptions: { format: 'tsv' | 'table' | 'detail' | 'json'; fields?: string[] }
): Promise<string> {
  const [state, team, project, assignee, labelsConnection] = await Promise.all([
    issue.state ? issue.state : undefined,
    issue.team ? issue.team : undefined,
    issue.project ? issue.project : undefined,
    issue.assignee ? issue.assignee : undefined,
    typeof issue.labels === 'function' ? issue.labels({ first: 25 }) : undefined,
  ]);

  const labelNames =
    labelsConnection?.nodes?.map((label: any) => label.name).filter(Boolean) ?? extractLabelNames(issue);

  const fields: Record<string, string> = {
    ISSUE: `${issue.identifier ?? ''} (${issue.id ?? ''})`,
    TITLE: issue.title ?? '',
    URL: issue.url ?? '',
    STATE: state?.name ?? '',
    PRIORITY: issue.priority?.toString() ?? '',
    TEAM: team?.key ?? '',
    PROJECT: project?.name ?? '',
    ASSIGNEE: assignee?.name ?? '',
    LABELS: labelNames.join(','),
  };

  const jsonPayload: Record<string, unknown> = {
    id: issue.id ?? '',
    key: team?.key ?? '',
    identifier: issue.identifier ?? '',
    title: issue.title ?? '',
    url: issue.url ?? '',
    state: state?.name ?? '',
    priority: issue.priority?.toString() ?? '',
    team: team?.key ?? '',
    project: project?.name ?? '',
    assignee: assignee?.name ?? '',
    labels: labelNames,
  };

  return renderDetailOrJsonRecord(header, fields, jsonPayload, outputOptions);
}

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const IMAGE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'svg' | 'unknown';

interface LocalImageUpload {
  path: string;
  filename: string;
  contentType: string;
  size: number;
  bytes: Buffer;
}

async function buildIssueAssetRows(
  issue: any,
  options: { includeLinearAttachments: boolean; includeUploadUrls: boolean; scanComments: boolean }
): Promise<IssueAssetRow[]> {
  const rowsById = new Map<string, IssueAssetRow>();

  if (options.includeLinearAttachments) {
    const attachments = await fetchAllIssueAttachments(issue);
    for (const attachment of attachments) {
      const id = attachment.id ?? '';
      if (!id) continue;
      const createdAt = attachment.createdAt?.toISOString?.() ?? '';
      const url = attachment.url ?? '';
      const sourceType = attachment.sourceType ?? '';
      const subtitle = attachment.subtitle ?? '';
      const contentType = String((attachment.metadata as any)?.contentType ?? '');
      const isImage = isImageLike({ url, contentType });
      const row: IssueAssetRow = {
        id,
        title: sanitizeSingleLine(attachment.title ?? ''),
        url,
        sourceType,
        subtitle,
        contentType,
        isImage: isImage ? 'true' : 'false',
        createdAt,
        downloadPath: '',
        downloadStatus: '',
        downloadError: '',
      };
      rowsById.set(id, row);
    }
  }

  if (options.includeUploadUrls) {
    const issueCreatedAt = issue.createdAt?.toISOString?.() ?? '';
    for (const ref of extractUploadRefs(issue.description ?? '')) {
      upsertUploadRow(rowsById, ref.url, issueCreatedAt, 'description', ref.isImage);
    }

    if (options.scanComments) {
      const comments = await fetchAllIssueComments(issue);
      for (const comment of comments) {
        const createdAt = comment.createdAt?.toISOString?.() ?? '';
        const subtitle = `comment:${comment.id ?? ''}`;
        for (const ref of extractUploadRefs(comment.body ?? '')) {
          upsertUploadRow(rowsById, ref.url, createdAt, subtitle, ref.isImage);
        }
      }
    }
  }

  return [...rowsById.values()];
}

function upsertUploadRow(
  rowsById: Map<string, IssueAssetRow>,
  url: string,
  createdAt: string,
  subtitle: string,
  isImage: boolean
): void {
  const id = url;
  const existing = rowsById.get(id);
  const row: IssueAssetRow = {
    id,
    title: '',
    url,
    sourceType: 'linear_upload',
    subtitle,
    contentType: '',
    isImage: isImage ? 'true' : 'false',
    createdAt,
    downloadPath: '',
    downloadStatus: '',
    downloadError: '',
  };

  if (!existing) {
    rowsById.set(id, row);
    return;
  }

  // Prefer the most recent timestamp, and keep any non-empty title/subtitle details.
  const keepCreatedAt = existing.createdAt && existing.createdAt >= createdAt ? existing.createdAt : createdAt;
  rowsById.set(id, {
    ...existing,
    createdAt: keepCreatedAt,
    subtitle: existing.subtitle || subtitle,
  });
}

async function fetchAllIssueAttachments(issue: any): Promise<any[]> {
  const nodes: any[] = [];
  let after: string | undefined;
  for (;;) {
    const connection = await issue.attachments({ first: 50, after });
    nodes.push(...(connection.nodes ?? []));
    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.pageInfo?.endCursor;
    if (!after) break;
  }
  return nodes;
}

async function fetchAllIssueComments(issue: any): Promise<any[]> {
  const nodes: any[] = [];
  let after: string | undefined;
  for (;;) {
    const connection = await issue.comments({ first: 50, after });
    nodes.push(...(connection.nodes ?? []));
    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.pageInfo?.endCursor;
    if (!after) break;
  }
  return nodes;
}

async function probeIssueAssets(issue: any): Promise<{
  attachmentsPresent: boolean;
  imageAttachmentsPresent: boolean;
}> {
  let attachmentsPresent = false;
  let imageAttachmentsPresent = false;

  const descriptionRefs = extractUploadRefs(issue.description ?? '');
  if (descriptionRefs.length > 0) {
    attachmentsPresent = true;
  }
  if (descriptionRefs.some(ref => ref.isImage)) {
    imageAttachmentsPresent = true;
  }

  // Probe Linear attachments.
  let afterAttachment: string | undefined;
  for (;;) {
    const connection = await issue.attachments({ first: 50, after: afterAttachment });
    const nodes = connection.nodes ?? [];
    if (nodes.length > 0) {
      attachmentsPresent = true;
    }
    for (const attachment of nodes) {
      const url = attachment.url ?? '';
      const contentType = String((attachment.metadata as any)?.contentType ?? '');
      if (isImageLike({ url, contentType })) {
        imageAttachmentsPresent = true;
        break;
      }
    }
    if (imageAttachmentsPresent) break;
    if (!connection.pageInfo?.hasNextPage) break;
    afterAttachment = connection.pageInfo?.endCursor;
    if (!afterAttachment) break;
  }

  // Probe uploads in comments. Early-exit once images are found.
  if (!imageAttachmentsPresent) {
    let afterComment: string | undefined;
    for (;;) {
      const connection = await issue.comments({ first: 50, after: afterComment });
      const nodes = connection.nodes ?? [];
      for (const comment of nodes) {
        const refs = extractUploadRefs(comment.body ?? '');
        if (refs.length > 0) {
          attachmentsPresent = true;
        }
        if (refs.some(ref => ref.isImage)) {
          imageAttachmentsPresent = true;
          break;
        }
      }
      if (imageAttachmentsPresent) break;
      if (!connection.pageInfo?.hasNextPage) break;
      afterComment = connection.pageInfo?.endCursor;
      if (!afterComment) break;
    }
  }

  return { attachmentsPresent, imageAttachmentsPresent };
}

function extractUploadUrls(text: string): string[] {
  return extractUploadRefs(text).map(ref => ref.url);
}

function extractUploadRefs(text: string): Array<{ url: string; isImage: boolean }> {
  const all = new Set<string>();
  const image = new Set<string>();

  const clean = (raw: string): string => raw.replace(/[),.\]]+$/g, '');

  // Markdown image embeds: ![alt](url) / ![alt](<url>)
  for (const match of text.matchAll(
    /!\[[^\]]*\]\(\s*<?(https:\/\/uploads\.linear\.app\/[^\s)>\"]+)>?\s*\)/g
  )) {
    const url = clean(match[1] ?? '');
    if (url) image.add(url);
  }

  // Linear also accepts: ![alt]<url>
  for (const match of text.matchAll(
    /!\[[^\]]*\]\s*<\s*(https:\/\/uploads\.linear\.app\/[^\s>\"]+)\s*>/g
  )) {
    const url = clean(match[1] ?? '');
    if (url) image.add(url);
  }

  // Any uploads.linear.app URL reference.
  for (const match of text.matchAll(/https:\/\/uploads\.linear\.app\/[^\s)\]>\"]+/g)) {
    const url = clean(match[0] ?? '');
    if (url) all.add(url);
  }

  const results: Array<{ url: string; isImage: boolean }> = [];
  for (const url of all) {
    let isImageByExt = false;
    try {
      const parsed = new URL(url);
      const ext = path.extname(parsed.pathname).toLowerCase();
      isImageByExt = IMAGE_EXTENSIONS.has(ext);
    } catch {
      // ignore
    }
    results.push({ url, isImage: image.has(url) || isImageByExt });
  }
  return results;
}

function isImageLike(input: { url: string; contentType: string }): boolean {
  const url = input.url ?? '';
  const ct = normalizeContentType(input.contentType ?? '');
  if (ct.startsWith('image/')) return true;
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

function normalizeContentType(contentType: string): string {
  return (contentType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
}

async function ensureSafeDownloadDir(dir: string): Promise<void> {
  const resolved = path.resolve(dir);
  try {
    const st = await fs.lstat(resolved);
    if (st.isSymbolicLink()) {
      throw new Error('validation_error Download directory must not be a symlink');
    }
    if (!st.isDirectory()) {
      throw new Error('validation_error Download path is not a directory');
    }
    return;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await fs.mkdir(resolved, { recursive: true });
  const st = await fs.lstat(resolved);
  if (st.isSymbolicLink()) {
    throw new Error('validation_error Download directory must not be a symlink');
  }
  if (!st.isDirectory()) {
    throw new Error('validation_error Download path is not a directory');
  }
}

async function downloadToDir(
  url: string,
  downloadDir: string,
  options: { overwrite: boolean; apiKey: string; suggestedBaseName: string; validateImage: boolean }
): Promise<{ downloadPath: string; downloadStatus: string; downloadError: string }> {
  if (!url) {
    return { downloadPath: '', downloadStatus: 'failed', downloadError: 'missing_url' };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { downloadPath: '', downloadStatus: 'failed', downloadError: 'invalid_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { downloadPath: '', downloadStatus: 'failed', downloadError: 'unsupported_url_scheme' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_DOWNLOAD_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (parsed.hostname === 'uploads.linear.app' && options.apiKey) {
      headers['Authorization'] = options.apiKey.startsWith('Bearer ')
        ? options.apiKey
        : `Bearer ${options.apiKey}`;
    }

    const response = await fetch(parsed.toString(), { signal: controller.signal, headers });
    if (!response.ok) {
      return {
        downloadPath: '',
        downloadStatus: 'failed',
        downloadError: `http_${response.status}`,
      };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const ext = inferExtension(parsed, contentType);
    const base = sanitizeFileBaseName(options.suggestedBaseName || 'asset');
    const target = await chooseDownloadPath(downloadDir, base, ext, options.overwrite);
    if (target.status === 'exists') {
      return { downloadPath: target.path, downloadStatus: 'exists', downloadError: '' };
    }

    // Refuse to write through symlinks.
    const existing = await safeLstat(target.path);
    if (existing && existing.isSymbolicLink()) {
      return { downloadPath: '', downloadStatus: 'failed', downloadError: 'refuse_symlink' };
    }

    if (!response.body) {
      return { downloadPath: '', downloadStatus: 'failed', downloadError: 'empty_body' };
    }

    const tempPath = `${target.path}.part-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const source = Readable.fromWeb(response.body as any);
    const limiter = new ByteLimitTransform(DEFAULT_MAX_DOWNLOAD_BYTES);
    const sink = createWriteStream(tempPath, { flags: 'wx' });
    try {
      await pipeline(source, limiter, sink);
      await fs.rename(tempPath, target.path);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }

    if (options.validateImage) {
      const imageError = await validateDownloadedImage(target.path, contentType);
      if (imageError) {
        await fs.unlink(target.path).catch(() => undefined);
        return { downloadPath: '', downloadStatus: 'failed', downloadError: imageError };
      }
    }

    return { downloadPath: target.path, downloadStatus: 'downloaded', downloadError: '' };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      return { downloadPath: '', downloadStatus: 'failed', downloadError: 'timeout' };
    }
    return { downloadPath: '', downloadStatus: 'failed', downloadError: sanitizeSingleLine(String(error?.message ?? error)) };
  } finally {
    clearTimeout(timeout);
  }
}

class ByteLimitTransform extends Transform {
  private seen = 0;
  private limit: number;
  constructor(limit: number) {
    super();
    this.limit = limit;
  }
  _transform(chunk: any, _enc: BufferEncoding, cb: (error?: Error | null) => void) {
    const size = chunk?.length ?? 0;
    this.seen += size;
    if (this.seen > this.limit) {
      cb(new Error('max_size_exceeded'));
      return;
    }
    this.push(chunk);
    cb();
  }
}

async function safeLstat(p: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.lstat(p);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function chooseDownloadPath(
  downloadDir: string,
  base: string,
  ext: string,
  overwrite: boolean
): Promise<{ status: 'download' | 'exists'; path: string }> {
  const root = path.resolve(downloadDir);
  if (overwrite) {
    const candidate = path.resolve(root, `${base}${ext}`);
    return { status: 'download', path: candidate };
  }

  for (let i = 0; i < 10_000; i++) {
    const name = i === 0 ? `${base}${ext}` : `${base}-${i}${ext}`;
    const candidate = path.resolve(root, name);
    if (!candidate.startsWith(root + path.sep)) {
      throw new Error('validation_error Invalid download path');
    }
    const st = await safeLstat(candidate);
    if (!st) {
      return { status: 'download', path: candidate };
    }
    if (st.isSymbolicLink()) {
      throw new Error('validation_error Refusing to overwrite symlink');
    }
  }
  throw new Error('validation_error Too many filename collisions');
}

function inferExtension(url: URL, contentType: string): string {
  const ext = path.extname(url.pathname).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return ext;

  const ct = normalizeContentType(contentType);
  switch (ct) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/svg+xml':
      return '.svg';
    default:
      return '';
  }
}

function contentTypeToImageKind(contentType: string): ImageKind {
  switch (normalizeContentType(contentType)) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpeg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    default:
      return 'unknown';
  }
}

function imageKindToContentType(kind: ImageKind): string {
  switch (kind) {
    case 'png':
      return 'image/png';
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    default:
      return '';
  }
}

function sniffImageKind(head: Buffer): ImageKind {
  if (head.length >= 8
    && head[0] === 0x89
    && head[1] === 0x50
    && head[2] === 0x4e
    && head[3] === 0x47
    && head[4] === 0x0d
    && head[5] === 0x0a
    && head[6] === 0x1a
    && head[7] === 0x0a) {
    return 'png';
  }

  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'jpeg';
  }

  if (head.length >= 6) {
    const gifHeader = head.subarray(0, 6).toString('ascii');
    if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
      return 'gif';
    }
  }

  if (head.length >= 12) {
    const riff = head.subarray(0, 4).toString('ascii');
    const webp = head.subarray(8, 12).toString('ascii');
    if (riff === 'RIFF' && webp === 'WEBP') {
      return 'webp';
    }
  }

  if (head.length > 0) {
    const asText = head.toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
    if (asText.startsWith('<svg') || (asText.startsWith('<?xml') && asText.includes('<svg'))) {
      return 'svg';
    }
  }

  return 'unknown';
}

async function prepareLocalImageUpload(
  filePath: string,
  explicitContentType?: string
): Promise<LocalImageUpload> {
  const workspaceRoot = await fs.realpath(process.cwd());
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const stat = await safeLstat(resolvedPath);
  if (!stat) {
    throw new Error(`validation_error File '${filePath}' not found`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error('validation_error Refusing to upload symlink');
  }
  if (!stat.isFile()) {
    throw new Error('validation_error Upload path must be a regular file');
  }
  if (stat.size <= 0) {
    throw new Error('validation_error Upload file is empty');
  }
  if (stat.size > DEFAULT_MAX_UPLOAD_BYTES) {
    throw new Error(`validation_error Upload file exceeds ${DEFAULT_MAX_UPLOAD_BYTES} byte limit`);
  }

  const realPath = await fs.realpath(resolvedPath);
  if (!isPathWithin(realPath, workspaceRoot)) {
    throw new Error('validation_error Upload file must be inside the current workspace');
  }

  const bytes = await fs.readFile(realPath);
  const sniffed = sniffImageKind(bytes.subarray(0, Math.min(512, bytes.length)));
  const normalizedExplicit = normalizeContentType(explicitContentType ?? '');
  let contentType = normalizedExplicit || imageKindToContentType(sniffed) || contentTypeFromExtension(resolvedPath);
  contentType = normalizeContentType(contentType);

  if (!IMAGE_CONTENT_TYPES.has(contentType)) {
    throw new Error(`validation_error Unsupported image content type '${contentType || 'unknown'}'`);
  }

  const expected = contentTypeToImageKind(contentType);
  if (sniffed === 'unknown') {
    throw new Error('validation_error Unable to recognize image file signature');
  }
  if (expected !== 'unknown' && expected !== sniffed) {
    throw new Error(`validation_error Image content type does not match file signature (${expected} vs ${sniffed})`);
  }

  return {
    path: realPath,
    filename: path.basename(realPath),
    contentType,
    size: stat.size,
    bytes,
  };
}

function isPathWithin(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function contentTypeFromExtension(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    default:
      return '';
  }
}

async function uploadFileToLinear(client: any, file: LocalImageUpload): Promise<string> {
  if (typeof client.fileUpload !== 'function') {
    throw new Error('api_error Linear client does not support fileUpload');
  }

  const payload = await client.fileUpload(file.contentType, file.filename, file.size);
  if (!payload?.success || !payload.uploadFile?.uploadUrl || !payload.uploadFile?.assetUrl) {
    throw new Error('api_error Failed to request Linear upload URL');
  }

  const headers = new Headers();
  headers.set('Content-Type', file.contentType);
  for (const header of payload.uploadFile.headers ?? []) {
    if (header?.key && header?.value !== undefined) {
      headers.set(String(header.key), String(header.value));
    }
  }

  const response = await fetch(payload.uploadFile.uploadUrl, {
    method: 'PUT',
    headers,
    body: file.bytes as unknown as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`api_error Linear upload failed with HTTP ${response.status}`);
  }

  return String(payload.uploadFile.assetUrl);
}

function sanitizeMarkdownAlt(input: string): string {
  return sanitizeSingleLine(input).replace(/[\[\]]/g, '').trim() || 'image';
}

async function validateDownloadedImage(filePath: string, contentType: string): Promise<string | null> {
  const stat = await fs.stat(filePath);
  if (stat.size <= 0) {
    return 'invalid_image_empty_file';
  }

  const file = await fs.open(filePath, 'r');
  try {
    const headLength = Math.min(512, stat.size);
    const head = Buffer.alloc(headLength);
    await file.read(head, 0, headLength, 0);

    const tailLength = Math.min(16, stat.size);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, stat.size - tailLength);

    const normalizedContentType = normalizeContentType(contentType);
    const sniffed = sniffImageKind(head);
    if (sniffed === 'unknown' && !normalizedContentType.startsWith('image/')) {
      return 'invalid_image_signature';
    }

    const expected = contentTypeToImageKind(normalizedContentType);
    if (expected !== 'unknown' && expected !== sniffed) {
      return `invalid_image_mismatch_${expected}_vs_${sniffed}`;
    }

    if (sniffed === 'jpeg' && (tailLength < 2 || tail[tailLength - 2] !== 0xff || tail[tailLength - 1] !== 0xd9)) {
      return 'invalid_image_jpeg_missing_eoi';
    }

    return null;
  } finally {
    await file.close();
  }
}

function sanitizeFileBaseName(input: string): string {
  const raw = String(input ?? '');
  const cleaned = raw
    .replace(/https?:\/\//g, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned || 'asset';
  return base.length > 80 ? base.slice(0, 80) : base;
}

function parseNumber(value: string): number {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function writeError(error: unknown): void {
  const parsed = parseLinearError(error);
  const out = emitError(parsed.code, parsed.message);
  process.stderr.write(out + '\n');
  process.exitCode = 1;
}
