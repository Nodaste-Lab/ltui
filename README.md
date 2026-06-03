# ltui

`ltui` is a token-efficient command-line interface for Linear, designed for AI coding agents and automation. It favors deterministic, compact output over interactive prompts so agents can list, inspect, create, update, comment on, and link Linear issues without using a browser.

## Install with Homebrew

```bash
brew tap Nodaste-Lab/ltui https://github.com/Nodaste-Lab/ltui
brew install ltui
```

Verify the install:

```bash
ltui --help
```

## Configure Linear authentication

Create a Linear personal API key at [Linear Settings → API](https://linear.app/settings/api), then either export it for the current environment:

```bash
export LINEAR_API_KEY="lin_api_..."
ltui teams list
```

or save it as a named profile:

```bash
ltui auth add --profile work --api-key "lin_api_..."
ltui auth list
ltui teams list --profile work
```

Stored profiles live in `~/.config/ltui/`. API-key files are written with mode `0600`.

## Project defaults

For repositories tied to a Linear team or project, add a `.ltui.json` file at the project root so agents can omit repetitive flags:

```json
{
  "profile": "work",
  "teamKey": "ENG",
  "projectId": "Backend Services",
  "defaultIssueState": "Todo",
  "defaultLabels": ["bug"],
  "defaultAssignee": "me"
}
```

Explicit CLI flags always override `.ltui.json` values.

## Common commands

Global options come before the subcommand:

```bash
ltui --format tsv --limit 10 issues list --team ENG --state Todo
ltui --format json --fields identifier,title,state issues list --search authentication
ltui --format detail issues view ENG-123 --include-comments
ltui issues create --team ENG --title "Fix auth regression" --description @notes.md
ltui issues update ENG-123 --state "In Progress" --assignee me
ltui issues comment ENG-123 --body "Implemented in PR #234"
ltui issues link ENG-123 --url "https://github.com/org/repo/pull/234" --title "PR #234"
```

Supported areas include:

- `auth` — profile management
- `issues` — list, view, create, update, comment, link, upload, attachments, saved queries, relationships
- `teams`, `projects`, `cycles`, `labels`, `users`
- `documents`, `roadmaps`, `milestones`, `notifications`

Run `ltui <command> --help` or see [`SPEC.md`](./SPEC.md) for detailed command contracts.

## Output formats

`ltui` supports `tsv`, `table`, `detail`, and `json` via `--format`.

TSV is the default because it is compact and easy for agents to parse:

```text
ISSUE: id	identifier	title	state	assignee
550e8400-...	ENG-123	Fix login bug	In Progress	alice@example.com
```

Errors are structured and written to stderr:

```text
ERROR: auth_missing No profile configured and LINEAR_API_KEY not set
HINT: Run 'ltui auth add --profile personal --api-key <key>'
```

## Rate-limit-aware usage

Linear API budgets are shared by authenticated user. Prefer narrow queries and field selection when agents are exploring:

```bash
ltui --limit 5 --fields id,identifier,title issues list --team ENG
ltui --format json --show-rate-limit --fields id,identifier,title issues list --team ENG
```

For raw GraphQL-backed list paths, `--show-rate-limit` surfaces Linear response headers in JSON metadata or as a parseable stderr line for TSV/table output.

## Local development

Requirements:

- Node.js 20 or newer
- npm

```bash
npm ci
npm run build
npm test
node bin/ltui --help
```

The test suite uses a mock Linear client and does not call the Linear API.

## Security notes

- Do not commit `~/.config/ltui/`, `.env`, or real Linear API keys.
- `.ltui.json` may be committed when it only contains project/team defaults and no secrets.
- User extensions are opt-in and loaded from paths listed in `~/.config/ltui/extensions.json`; only enable extensions you trust.
- `issues upload` sends selected local files to Linear using Linear's upload flow. Review file paths before running upload commands in automation.

## Homebrew formula development

This repo includes `Formula/ltui.rb`. To test it locally from a checkout:

```bash
brew install --build-from-source ./Formula/ltui.rb
brew test ltui
```

## License

MIT — see [`LICENSE`](./LICENSE).
