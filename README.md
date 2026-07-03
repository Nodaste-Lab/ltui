# ltui — Linear CLI for AI Coding Agents

`ltui` is a token-efficient command-line interface to Linear, purpose-built for AI coding agents like Claude Code, Cursor, Aider, and similar tools. Unlike traditional CLIs designed for human interaction, ltui prioritizes **deterministic output**, **minimal token usage**, and **structured data formats** that LLMs can reliably parse.

## Why ltui Exists

When AI agents work on codebases, they often need to interact with Linear to:
- Find and read issue details
- Update issue status as work progresses
- Add comments linking PRs and commits
- Create new issues for discovered bugs or follow-up work
- Manage labels, assignments, and project membership

Existing Linear tools are designed for humans and produce:
- Colorful, formatted output with ANSI escape codes (wastes tokens)
- Inconsistent output formats (hard for LLMs to parse reliably)
- Interactive prompts (incompatible with non-interactive agent workflows)
- Verbose descriptions and redundant data

**ltui solves this** by providing a deterministic, parseable CLI interface optimized for machine consumption while remaining human-readable enough for you to debug and understand what your agent is doing.

## Key Design Principles

### 1. Token Efficiency
Output defaults to **TSV (tab-separated values)** format, which conveys the same information as JSON or verbose text using 50-70% fewer tokens. Every token counts when working within LLM context windows.

### 2. Deterministic Output
Same command + same Linear state = **identical byte-for-byte output**. No timestamps, no random ordering, no environmental dependencies. Agents can cache and reliably parse results.

### 3. Structured Errors
Errors follow a predictable format with error codes and hints:
```
ERROR: not_found Issue ENG-123 not found
HINT: Check the issue ID or use 'ltui issues list' to find available issues
```

Agents can programmatically detect and handle specific error conditions.

### 4. No Interactivity
All inputs via CLI flags or environment variables. No prompts, no confirmations, no interactive flows. Perfect for scripted agent workflows.

### 5. Multi-Workspace Support
Configure profiles for different Linear workspaces. Agents can work across personal projects, work projects, and client projects by switching profiles.

## Installation

### Prerequisites
- Node.js ≥ 20.0.0 (or Bun)
- A Linear account with API access

### Homebrew Install (Recommended)

```bash
brew tap Nodaste-Lab/ltui https://github.com/Nodaste-Lab/ltui
brew install Nodaste-Lab/ltui/ltui
ltui --help
```

### Manual Install

```bash
# Clone the repository
git clone https://github.com/Nodaste-Lab/ltui.git
cd ltui

# Install dependencies
npm install

# Build the TypeScript source
npm run build

# Link globally for system-wide access
npm link
```

After linking, `ltui` will be available globally. Otherwise, use `./bin/ltui` from the project directory.

## Configuration

### 1. Get Your Linear API Key

1. Visit [Linear Settings → API](https://linear.app/settings/api)
2. Generate a new Personal API Key
3. Copy the key (starts with `lin_api_`)

### 2. Configure ltui

You have two options:

#### Option A: Environment Variable (Simplest)
```bash
export LINEAR_API_KEY="lin_api_..."
```

Add this to your agent's environment or shell profile. This is the easiest approach for single-workspace setups.

#### Option B: Profile-Based Configuration (Multi-Workspace)
```bash
# Add a named profile
ltui auth add personal

# When prompted, paste your API key
# This stores the key in ~/.config/ltui/profiles.json

# Set as default profile
ltui auth set-default personal
```

For multiple workspaces (e.g., work and personal):
```bash
ltui auth add work
ltui auth add personal
ltui auth set-default work

# Use --profile flag to switch contexts
ltui issues list --profile personal
```

### 3. Test Your Configuration

```bash
# List your Linear teams
ltui teams list

# Expected output (TSV format):
# TEAM: id	key	name
# 550e8400-...	ENG	Engineering
# 550e8401-...	PROD	Product
```

If you see your teams, you're ready to go!

## Per-Project Alignment (Recommended for Agents)

When working on a codebase tied to a specific Linear project, create a `.ltui.json` file in your repository root:

```bash
# From your project directory
ltui projects align

# This prompts for:
# - Which Linear team this repo belongs to
# - Which Linear project to use by default
# - Default labels for new issues (optional)
# - Default assignee (optional)

# Saves to ./.ltui.json
```

**Example `.ltui.json`:**
```json
{
  "profile": "work",
  "team": "ENG",
  "project": "Backend Services",
  "labels": ["backend", "api"],
  "assignee": "me",
  "state": "In Progress"
}
```

Now when your agent runs commands from this directory, it automatically uses these defaults:
```bash
# Without .ltui.json - requires many flags
ltui issues create --team ENG --project "Backend Services" --label backend --label api --title "Fix auth bug"

# With .ltui.json - just provide the unique bits
ltui issues create --title "Fix auth bug"
```

**💡 Commit `.ltui.json` to your repository** so all agents and developers share the same Linear project alignment.

## API Request Budget

Linear rate limits are attached to the authenticated Linear user and are shared across that user's API keys, agents, and scripts. When diagnosing limit pressure, trust Linear's live response headers over stale assumptions:

- `x-ratelimit-requests-limit`
- `x-ratelimit-requests-remaining`
- `x-ratelimit-requests-reset`
- `x-ratelimit-complexity-limit`
- `x-ratelimit-complexity-remaining`

As checked against the Nodaste workspace on 2026-05-03, Linear reported a 2,500 requests/hour request bucket and a 3,000,000 complexity/hour bucket for the current API user. Treat those as live-header facts, not permanent product guarantees.

`ltui` is token-efficient, but API request budget still matters. `issues list` is query-shaped by requested fields, so `--fields id,identifier,title` avoids fetching relation-heavy fields such as team, state, project, assignee, and labels. Other commands may still use SDK convenience paths unless their docs say otherwise.

Use `--show-rate-limit` on raw GraphQL-backed list paths when you need live budget visibility. JSON output includes `meta.rateLimit`; TSV/table output keeps normal stdout parseable and emits a `RATE_LIMIT ...` line on stderr.

Use global options before the subcommand:

```bash
ltui --limit 5 --fields id,identifier,title,state issues list --team ENG
ltui --format json --show-rate-limit --fields id,identifier,title issues list --team ENG
ltui --format detail issues view ENG-123
```

Operational guidance for agents:

- Start exploration with `--limit 5` or `--limit 10`.
- Filter by `--team`, `--project`, `--state`, `--assignee`, label, or saved query before increasing limits.
- Reuse known issue identifiers instead of repeatedly polling broad lists.
- Avoid many-issue operations unless the user explicitly asks for bulk work and the target set is narrow and auditable.
- When the remaining request header is low, pause until the reset time instead of retrying in a tight loop.

## Output Formats

ltui supports four output formats via the `--format` flag:

### TSV (Default for Agents)
```bash
ltui --format tsv issues list
```
```
ISSUE: id	identifier	title	state	assignee
550e8400-...	ENG-123	Fix login bug	In Progress	alice@example.com
550e8401-...	ENG-124	Add logging	Todo	bob@example.com
```

**Best for:** Agent parsing, minimal token usage, grep/awk processing

### Table (Human-Readable)
```bash
ltui --format table issues list
```
```
ID                                    IDENTIFIER  TITLE           STATE         ASSIGNEE
550e8400-e29b-41d4-a716-446655440000  ENG-123     Fix login bug   In Progress   alice@example.com
550e8401-e29b-41d4-a716-446655440001  ENG-124     Add logging     Todo          bob@example.com
```

**Best for:** Human review, debugging agent behavior

### Detail (Full Context)
```bash
ltui --format detail issues view ENG-123
```
```
ISSUE: ENG-123
TITLE: Fix authentication regression in OAuth flow
STATE: In Progress
ASSIGNEE: alice@example.com
LABELS: bug, security, backend
CREATED: 2024-01-15T10:30:00Z
UPDATED: 2024-01-16T14:22:00Z

DESCRIPTION_START
The OAuth callback handler is returning 500 errors for GitHub login attempts.
Error occurs in production but not staging.
DESCRIPTION_END

COMMENTS_START
COMMENT: bob@example.com 2024-01-16T09:15:00Z
Traced to session cookie domain mismatch. Fix in PR #234.

COMMENT: alice@example.com 2024-01-16T14:22:00Z
Confirmed fix works. Deploying to prod.
COMMENTS_END
```

**Best for:** Full issue context, agents needing complete information

### JSON (Machine-Readable)
```bash
ltui --format json issues list
```
```json
{"issues":[{"id":"550e8400-...","identifier":"ENG-123","title":"Fix login bug","state":"In Progress","assignee":"alice@example.com"}]}
```

**Best for:** Structured parsing, integration with other tools

## Common Agent Workflows

### Workflow 1: Creating an Issue from Code Discovery

```bash
# Agent discovers a bug while working on feature X
ltui issues create \
  --title "Memory leak in background worker" \
  --description "Found while implementing feature X. Worker process grows 10MB/hour." \
  --label bug \
  --label performance \
  --priority 2 \
  --state "Backlog"

# Output:
# ISSUE: ENG-456
# URL: https://linear.app/team/issue/ENG-456
```

Agent can store `ENG-456` and reference it in commit messages or PR descriptions.

### Workflow 2: Updating Status as Work Progresses

```bash
# Agent starts work on assigned issue
ltui issues update ENG-123 --state "In Progress"

# Agent completes implementation
ltui issues update ENG-123 --state "In Review"

# Agent adds PR link
ltui issues comment ENG-123 --body "Implementation complete in PR #234"
ltui issues link ENG-123 --url "https://github.com/org/repo/pull/234" --title "PR #234"
```

### Workflow 3: Adding a UI Mockup to an Issue

```bash
# Agent generated a local mockup while planning a UI change.
# This uploads it to Linear, creates an issue attachment, and comments with an inline image.
ltui issues upload ENG-123 \
  --file ./thoughts/mockups/proposed-ui.png \
  --title "Proposed UI mockup" \
  --alt "Proposed UI mockup"

# If the agent needs to link the image from an existing Linear-hosted plan,
# upload only and use the MARKDOWN line from the output.
ltui issues upload ENG-123 --file ./thoughts/mockups/proposed-ui.png --no-comment
```

`issues upload` accepts regular image files inside the current workspace up to 25 MiB.
The returned URL points to Linear private storage and is intended for authenticated Linear surfaces.

### Workflow 4: Finding Relevant Issues

```bash
# Find all "bug" issues in "Todo" state
ltui --limit 10 --format tsv issues list --label bug --state Todo

# Find issues assigned to me that are in progress
ltui --limit 10 --format tsv issues list --assignee me --state "In Progress"

# Search issue titles for specific keywords
ltui --limit 5 --format tsv issues list --search "authentication"
```

### Workflow 5: Reading Full Issue Context

```bash
# Get complete issue details including description and comments
ltui --format detail issues view ENG-123

# Agent parses DESCRIPTION_START...DESCRIPTION_END and COMMENTS_START...COMMENTS_END blocks
```

## Caching and Performance

ltui caches Linear entity lookups to minimize API calls:
- **In-memory cache:** Valid for the command's lifetime
- **Disk cache:** `~/.config/ltui/cache.json`
- **Stable metadata TTL:** teams, projects, workflow states, and labels are cached for 12 hours
- **User TTL:** users are cached for 5 minutes
- **Cache invalidation:** Automatic based on TTL, or explicit via `ltui cache clear`

When agents repeatedly query the same entities (e.g., "What's the ID of the Engineering team?"), the cache prevents redundant API calls, saving time and respecting rate limits.

For large issue lists, prefer smaller pages, field selection, and narrower filters.

To clear the cache manually:
```bash
ltui cache clear
ltui cache clear --bucket labels
```

## Extending ltui for Your Workflow

Place custom commands in `~/.config/ltui/extensions/`:

```javascript
// ~/.config/ltui/extensions/my-workflow.js
export function register(program) {
  program
    .command('my-workflow:standup')
    .description('Generate standup summary for assigned issues')
    .action(async () => {
      // Your custom logic using Linear SDK
    });
}
```

Extensions are auto-loaded at runtime. See `src/extensions.ts` for the extension API.

## Testing and Validation

```bash
# Run full test suite
npm test

# Tests include:
# - CLI argument validation (--help output for all commands)
# - End-to-end regression tests using mock Linear client
# - Output format contract validation
```

Tests use a mock Linear client (`src/test-utils/mockLinearClient.ts`) to ensure deterministic behavior without network calls.

## Troubleshooting

### "ERROR: auth_missing No API key configured"
- Set `LINEAR_API_KEY` environment variable, OR
- Run `ltui auth add <profile-name>` and configure a profile

### "ERROR: not_found Team not found"
- Verify team key/name with `ltui teams list`
- Check that you're using the correct profile (`--profile` flag)

### "ERROR: api_error Rate limit exceeded"
- Linear API has per-user rate limits shared across that user's API keys and tools
- ltui's cache reduces some lookups, but broad issue lists can still spend many requests
- Wait until the reset time reported by Linear's rate-limit headers before retrying
- Rerun with smaller `--limit` values and narrower filters

### Unexpected Output Format
- Verify `--format` flag (defaults to `tsv`)
- Check that `LTUI_AGENT_MODE` is not set to `0` (agent mode is enabled by default)

## Agent Integration Tips

### For Claude Code
Use the main `ai-configs` repo install flow for Claude-specific guidance and skills. `ltui` itself is just the CLI binary; agent-specific usage docs should live in the surrounding agent config system.

### For MCP Servers
If you're setting this up for an MCP server integration:

1. **Set up a dedicated profile** for the agent with appropriate Linear API key permissions
2. **Create `.ltui.json`** in each project repository for automatic context alignment
3. **Use TSV format** in prompts to minimize token usage
4. **Parse structured errors** to handle failure cases gracefully
5. **Cache issue IDs** in agent memory to avoid repeated lookups
6. **Keep pages small** and avoid broad polling loops; Linear request budget is often tighter than LLM context budget

### For Cursor / Aider / Other Agents
Same principles apply:
- Configure authentication once globally
- Use per-project `.ltui.json` for automatic defaults
- Prefer TSV output for parsing
- Handle structured errors programmatically
- Document recommended ltui usage in your agent's own skill or prompt system

## Project Structure

```
ltui/
├── bin/ltui              # CLI entrypoint
├── src/
│   ├── cli.ts            # Command registration and parsing
│   ├── client.ts         # Linear client initialization
│   ├── config.ts         # Profile and config management
│   ├── linear.ts         # Entity resolution (teams, projects, etc.)
│   ├── format.ts         # Output formatting (TSV, table, detail, JSON)
│   ├── cache.ts          # Disk and in-memory caching
│   ├── queries.ts        # Reusable GraphQL fragments
│   ├── extensions.ts     # User extension loader
│   └── commands/         # Command implementations
│       ├── auth.ts       # Profile management
│       ├── issues.ts     # Issue operations
│       ├── teams.ts      # Team listing
│       ├── projects.ts   # Project operations
│       ├── cycles.ts     # Cycle queries
│       ├── labels.ts     # Label management
│       └── users.ts      # User queries
├── Formula/ltui.rb       # Homebrew formula
├── package-lock.json     # npm lockfile
├── SPEC.md               # Full technical specification
├── LICENSE               # MIT license
└── README.md             # This file
```

## Additional Resources

- **[SPEC.md](./SPEC.md)** — Complete technical specification with API contracts
- **[Linear API Documentation](https://developers.linear.app/)** — Official Linear API reference

## License

MIT — see [`LICENSE`](./LICENSE).

## Contributing

Contributions welcome. Use `SPEC.md` plus the package scripts and tests in this repository as the development reference surface.

---

**Built for AI agents, readable by humans.**
