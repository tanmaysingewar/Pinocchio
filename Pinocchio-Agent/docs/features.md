## Pinocchio Agent Features

This document gives a high-level tour of everything the Pinocchio agent can do, how it is configured, and how you can extend or restrict it in your own projects.

If you are new to Pinocchio, read `how-it-works.md` first, then come back here for the detailed feature breakdown.

---

## 1. Core Concepts

- **Agent runtime**: a loop that sends messages to a model, handles tool calls, and emits a final result.
- **Project-local runtime**: everything under `.agents/` lives in your repo and defines how the agent behaves.
- **Tools & MCP tools**: executable capabilities the model can call.
- **Skills, commands, agents, plugins**: higher-level building blocks that shape behavior and UX.
- **Sessions & checkpoints**: optional persistence for conversations and file history.

Pinocchio is deliberately minimal at the SDK layer (`query` and `PinocchioSDKClient`) and powerful at the project layer (`.agents/`).

---

## 2. Public SDK Surface

### 2.1 `query(prompt, options)`

**Use case**: one-shot runs and streaming all messages.

Key behaviors:

- **Single entry point** to ask the agent to do work.
- **Streaming API**: you iterate over messages as the agent runs.
- **Project-aware**: when `cwd` points to a directory with `.agents/`, the runtime loads that configuration automatically.

Common options (exact shape may evolve, see README for the latest type definitions):

- **`cwd`**: directory to treat as the project root.
- **`mcpServers` / `tools`**: optional overrides or additions for tools and MCP servers.
- **`onEvent` / callbacks**: hooks for UI integrations (logging, UI updates, telemetry, etc.).

### 2.2 `PinocchioSDKClient`

**Use case**: multi-turn, stateful interactions.

Key behaviors:

- **Session state**: preserves transcript and context between calls to `client.query()`.
- **Config reuse**: reuses the same `.agents/` configuration across multiple turns.
- **Session persistence** (when enabled): ties into the global runtime `sessions/` directory so you can resume work later.

You typically create one client per user session and reuse it for the duration of that session.

---

## 3. Configuration Under `.agents/`

Pinocchio discovers project configuration under `.agents/` at the root of your workspace.

### 3.1 `config.json`

Defines global runtime behavior:

- **Model & provider**: which model to call (Anthropic, OpenAI, etc.) and provider-specific settings.
- **Token limits**: context window, output limits, and retry budgets.
- **System prompt**: the default instructions given to the agent.
- **Safety & approvals**: defaults for auto-approving or requiring user confirmation for tools.
- **Session behavior**: whether to persist sessions and checkpoints.

Changing `config.json` changes how *all* agent runs behave in this project.

### 3.2 `tools/tools.json`

Defines the **local tool registry**:

- **Tool ID**: unique identifier used in tool calls.
- **Implementation file**: path to a TypeScript/JavaScript file exporting a default function or `execute()`.
- **Schema**: JSON-schema-like description of the tool parameters (used for tool calling).
- **Metadata**: human-readable name, description, and categories.
- **Permissions**: default allow/deny behavior and approval flows.

Pinocchio **does not** ship any built-in tools. If you want:

- file access (`Read`, `Write`, `Edit`)
- shell execution (`Bash`)
- task tracking (`TodoWrite`)
- user questions (`AskUserQuestion`)
- subagents (`Agent`)

you define them explicitly here or source them from MCP.

### 3.3 `skills/**/SKILL.md`

**Skills** are markdown files that describe reusable patterns or behaviors. At runtime, they are:

- **Loaded into the system message** so the model can discover them.
- **Used as reusable instructions** the agent can call on (“When doing X, follow these steps…”).

Typical uses:

- Code review checklists.
- Project-specific refactoring rules.
- Style guides and architecture constraints.

### 3.4 `commands/*.md`

**Commands** define slash-style entry points (for CLIs or UIs) such as:

- `/ship`
- `/refactor`
- `/review`

Each command file explains:

- What the command does.
- How the agent should approach the task.
- Any special tools or constraints it should prefer.

### 3.5 `agents/*.md`

**Agents** are preconfigured sub-agents with specialized instructions. Example:

- `reviewer.md` for a code-review-focused agent.
- `fixer.md` for a bug-fixing agent.

Each agent file can define:

- A dedicated system prompt.
- Allowed / disallowed tools.
- Default mode (e.g., read-only vs. editing).

### 3.6 `plugins/*/.agents-plugin/plugin.json`

**Plugins** package behaviors, tools, skills, and commands into reusable units.

Typical uses:

- Organization-wide quality or security packs.
- Reusable tool bundles (e.g., “web app dev tools”, “data science tools”).
- Vendor integrations (monitoring, analytics, ticketing, etc.).

Plugins are discovered automatically when placed under `.agents/plugins/`.

### 3.7 `mcp.json`

Defines **Model Context Protocol (MCP)** servers available to the project.

For each MCP server, you can configure:

- Server ID and connection parameters.
- Available tools and resources.
- Authentication strategy (when applicable).

These tools are then merged into the agent’s tool list alongside local tools.

---

## 4. Tooling Model and Safety

### 4.1 Tool Lifecycle

When the model calls a tool:

1. Pinocchio validates the tool name and parameters against the registered schema.
2. It checks permissions and any approval policy.
3. It runs pre-tool hooks (logging, auditing, transforms, etc.).
4. It executes the tool and captures the result.
5. It runs post-tool hooks if configured.
6. It appends the tool result back into the transcript and resumes the model loop.

This makes tool usage:

- **Visible** (each call is a message).
- **Controllable** (you can intercept before/after).
- **Auditable** (transcripts can be stored and inspected).

### 4.2 Approval Flows

Projects can define global or per-tool approval policies, including:

- **Auto-approve** low-risk tools.
- **Prompt the user** before running high-impact tools (e.g., `Write`, `Bash`, deployment tools).
- **Deny by default** for restricted environments.

Approval decisions can be surfaced to the UI so the user clearly sees what is happening.

### 4.3 Hooks

Hooks let you inject logic around tool execution and other lifecycle events.

Common patterns:

- Telemetry and analytics.
- Custom logging or auditing.
- Cross-cutting concerns like access control, rate limiting, or secret redaction.

---

## 5. Sessions, Checkpoints, and History

### 5.1 Sessions

When session persistence is enabled, Pinocchio stores conversations in the global runtime directory (`$PINOCCHIO_HOME` or `~/.agents`) under `sessions/`.

Capabilities:

- **Resume**: reload a previous session and continue from the last message.
- **Metadata**: attach labels, timestamps, and other metadata per session.
- **Inspection**: inspect transcripts for debugging, analytics, or demos.

### 5.2 Checkpoints

When checkpoints are enabled, Pinocchio can capture file states in the global runtime directory under `checkpoints/`.

Capabilities:

- **Rewind**: roll back files to a previous checkpoint if a change goes wrong.
- **Diffing**: inspect how a file evolved across checkpoints.
- **Safe experimentation**: empower the agent to make changes with an easy escape hatch.

---

## 6. Structured Output

Pinocchio supports **structured output** via JSON Schema-like definitions.

When you request structured output:

- The model is instructed to return JSON that matches the schema.
- Pinocchio validates the response.
- If validation fails, Pinocchio can retry with an updated prompt until:
  - The response passes validation, or
  - The retry limit is reached.

This enables:

- Strongly-typed responses.
- Safer integrations with downstream code.
- More reliable automation flows.

---

## 7. Extensibility Patterns

### 7.1 Adding New Tools

To add a new tool:

1. Create an implementation file under `.agents/tools/` (TypeScript or JavaScript).
2. Export a default function or `execute()` that implements the tool behavior.
3. Register it in `.agents/tools/tools.json` with:
   - a unique ID
   - parameter schema
   - description and metadata
4. (Optional) Configure permissions and approval behavior.

Once registered, the tool becomes available to all agent runs for this project.

### 7.2 Adding New Skills

To add a skill:

1. Create a new folder under `.agents/skills/` (e.g., `performance/`).
2. Add a `SKILL.md` describing how the agent should approach that domain.
3. The skill will be loaded automatically and included in the system message.

### 7.3 Adding New Agents

To add a new sub-agent:

1. Create a markdown file under `.agents/agents/` (e.g., `tester.md`).
2. Describe:
   - the agent’s purpose,
   - allowed tools,
   - special constraints or style.
3. Wire it into your UI or CLI so users can intentionally invoke that agent.

### 7.4 Adding Plugins

To package behavior as a plugin:

1. Create a folder under `.agents/plugins/<name>/`.
2. Add a `.agents-plugin/plugin.json` file describing:
   - tools the plugin contributes
   - skills and commands it ships
   - any extra configuration knobs
3. Optionally bundle helper code or assets inside the plugin folder.

---

## 8. MCP Integration

Pinocchio can consume **MCP servers** defined in `mcp.json`.

Capabilities:

- **Remote tools**: database access, external APIs, proprietary backends, etc.
- **Resources**: read-only documents that can be retrieved at runtime.
- **Unified tool surface**: MCP tools appear alongside local tools to the model.

You control:

- Which servers are active.
- How they are authenticated.
- Which tools are exposed to which agents.

---

## 9. Typical Workflows

### 9.1 Local Development Assistant

- Define file and shell tools under `.agents/tools/`.
- Add code quality skills and agents.
- Use `query()` for ad-hoc tasks or `PinocchioSDKClient` for long-lived sessions (e.g., coding sessions).

### 9.2 CI / Automation Agent

- Configure tools for:
  - running tests
  - applying codemods
  - posting comments to code review systems
- Run Pinocchio as part of CI to:
  - summarize diffs
  - propose fixes
  - enforce quality rules via plugins.

### 9.3 Product-Embedded Assistant

- Wrap `PinocchioSDKClient` inside your backend.
- Use MCP to connect to your app’s domain APIs.
- Define project-specific skills and agents.
- Expose features to end-users via chat or task-centric UIs.

---

## 10. Where To Go Next

- **`how-it-works.md`**: deep dive on the core runtime loop.
- **Project `.agents/` folder**: explore and modify tools, skills, commands, agents, and plugins.
- **`README.md` at the repo root**: latest usage patterns and examples.

As you evolve your project, treat `.agents/` as first-class application code. The more intentional you are about tools, skills, and agents, the more capable and predictable your Pinocchio agent becomes.
