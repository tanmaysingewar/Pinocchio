# How Pinocchio Works

Pinocchio is built around a single idea: the agent should be easy to understand, easy to extend, and easy to control.

## End-to-End Flow

1. You create a query with `query()` or a long-lived client with `PinocchioSDKClient`.
2. Pinocchio loads project settings from `.agents/`.
3. It builds the active tool list from project tools and any MCP tools you provide.
4. It sends the prompt to the configured model provider.
5. If the model requests a tool, Pinocchio checks permissions and hooks first.
6. The tool runs, returns a result, and that result is appended back into the transcript.
7. The loop repeats until the model finishes.
8. Pinocchio emits a final `result` message and, when enabled, stores session history and checkpoints on disk.

## Public API

### `query(prompt, options)`

Use this for one-shot runs or when you want to stream the full message sequence.

```ts
import { query } from "pinocchio";

const stream = await query("Summarize this repository", {
  cwd: process.cwd(),
});

for await (const message of stream) {
  console.log(message.type);
}
```

### `PinocchioSDKClient`

Use this when you want to keep session state across multiple turns.

```ts
import { PinocchioSDKClient } from "pinocchio";

const client = new PinocchioSDKClient({ cwd: process.cwd() });

const first = await client.query("Plan the change.");
const second = await client.query("Now implement it.");
```

## What Loads From `.agents/`

Pinocchio looks for a project-local runtime under `.agents/`:

```text
.agents/
  config.json
  tools/
    tools.json
    read.ts
  skills/
    codebase/
      SKILL.md
  commands/
    ship.md
  agents/
    reviewer.md
  plugins/
    quality/
      .agents-plugin/
        plugin.json
  mcp.json
```

### Config

`config.json` defines the default model, token budget, system prompt, and provider settings.

### Tools

`tools/tools.json` lists local tools. Each tool points to a source file that exports a default function or `execute()`.

Pinocchio does not ship a built-in fallback tool pack. If you want `Read`, `Write`, `Edit`, `Bash`, `TodoWrite`, `AskUserQuestion`, `Agent`, or any other capability, you define it yourself in `.agents/tools/tools.json` or provide it through MCP.

### Skills, Commands, Agents, and Plugins

Pinocchio also auto-loads:

- skills from `skills/**/SKILL.md`
- slash commands from `commands/*.md`
- subagents from `agents/*.md`
- plugins from `plugins/*`

These are included in the `system:init` message so the runtime is transparent about what it loaded.

## Tool Execution

When the model calls a tool, Pinocchio does more than just run it:

1. It checks whether the tool is allowed.
2. It applies any configured hooks.
3. It can ask the user for approval or input.
4. It runs the tool.
5. It appends the result back into the conversation.

This is the main control point for safety and transparency.

## Human In The Loop: Implementation Example

This example shows a practical approval loop:

- policy checks in `canUseTool`
- interactive user approval in `onUserQuestion`
- live stream handling for progress and results
- optional human intervention via `steer` and `stopTask`

It also avoids a common confusion: a denied tool call is expected to return `error=true`, and some shell commands return non-zero even in normal cases (for example, `grep` when nothing matches). The example below uses safer command patterns.

```ts
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { query } from "pinocchio";

async function askApproval(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`${prompt} [y/N]: `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const stream = await query("Update docs and run tests.", {
    cwd: process.cwd(),
    permissionMode: "default",

    // First layer: code-driven policy.
    canUseTool: async (toolName, toolInput) => {
      if (toolName === "Bash") {
        const command = String(toolInput?.command ?? "");
        if (command.includes("rm -rf") || command.includes(":(){ :|:& };:")) {
          return { behavior: "deny", message: "Blocked dangerous shell pattern." };
        }
      }

      if (toolName === "Write" || toolName === "Edit" || toolName === "Bash") {
        return { behavior: "ask", message: `Approval required for ${toolName}.` };
      }

      return { behavior: "allow" };
    },

    // Second layer: human decision point.
    onUserQuestion: async (question) => {
      if (question.type !== "permission_request") {
        return "deny";
      }

      const approved = await askApproval(
        [
          "",
          "Permission request:",
          `tool: ${question.tool_name}`,
          `message: ${question.message ?? "(none)"}`,
          `input: ${JSON.stringify(question.tool_input)}`,
        ].join("\n"),
      );

      // Runtime interprets approve/allow/yes as allow; all other values as deny.
      return approved ? "approve" : "deny";
    },
  });

  let activeTaskId: string | null = null;

  // Stream events so you can drive a TUI/CLI/GUI.
  for await (const message of stream) {
    if (message.type === "system" && message.subtype === "task_started") {
      activeTaskId = message.task_id;
      console.log(`[task] started: ${message.title}`);
    }

    if (message.type === "system" && message.subtype === "tool_progress") {
      console.log(`[tool ${message.status}] ${message.tool_name}`);
    }

    if (message.type === "system" && message.subtype === "tool_result") {
      // Denials are reported as errors by design; inspect content to tell why.
      console.log(`[tool result] ${message.tool_name} error=${message.is_error}`);
      if (typeof message.content === "string") {
        console.log(message.content);
      }
    }

    if (message.type === "assistant") {
      const text = message.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text) {
        console.log(`\nassistant:\n${text}`);
      }
    }

    if (message.type === "result") {
      console.log(`\nfinal (${message.subtype}): ${message.result ?? "(empty)"}`);
    }
  }

  // Optional: human intervention while running.
  // await stream.steer("Do not modify source files, docs only.");
  // if (activeTaskId) await stream.stopTask(activeTaskId);
}

void main();
```

When writing prompts that may use shell search tools, prefer commands that do not fail on "no results", for example:

```bash
find . \( -name "*.test.ts" -o -name "*.spec.ts" \) -not -path "*/node_modules/*" 2>/dev/null || true
```

## Sessions And Checkpoints

Pinocchio persists sessions and file checkpoints in the global runtime directory (`$PINOCCHIO_HOME` or `~/.agents`), under `sessions/` and `checkpoints/`. A project `.agents/` directory is used for configuration only when it already exists.

That gives you:

- resumable conversations
- session metadata
- transcript inspection
- file rewind when checkpointing is enabled

## Structured Output

If you provide a JSON schema output format, Pinocchio will retry the model until the response matches the schema or the retry limit is reached.

## Why The Tool Model Matters

Pinocchio treats tooling as the core product, not a hidden implementation detail.

That means:

- tools are visible
- tools are editable
- tools are replaceable
- tools are project-owned

The SDK surface is meant to feel clean and familiar, but the power stays in the user's hands.
