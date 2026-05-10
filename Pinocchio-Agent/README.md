# pinocchio

Pinocchio is a TypeScript-first agent SDK with an Anthropic-style `query()` experience and a project-local `.agents/` runtime model.

It keeps the developer experience close to the Agent SDK shape while centering Pinocchio's core idea:

- tools are transparent
- tools are editable
- tools can be added, removed, and replaced per project
- agent behavior is loaded from your repo, not hidden in a black box

## Install

```bash
bun install
```

## Quickstart

```ts
import { query } from "pinocchio";

const stream = await query("Inspect the project and summarize what you find.", {
  cwd: process.cwd(),
});

for await (const message of stream) {
  if (message.type === "assistant") {
    console.log(message.message.content);
  }

  if (message.type === "result") {
    console.log(message.tool_results);
    console.log(message.result);
  }
}
```

## Stateful Usage

```ts
import { PinocchioSDKClient } from "pinocchio";

const client = new PinocchioSDKClient({
  cwd: process.cwd(),
  permissionMode: "acceptEdits",
});

const first = await client.query("Look through the repository and form a plan.");
for await (const message of first) {
  console.log(message.type);
}

const second = await client.query("Now implement the plan.");
for await (const message of second) {
  console.log(message.type);
}
```

## Steering A Live Run

```ts
import { query } from "pinocchio";

const run = await query("Start a long task.", {
  cwd: process.cwd(),
});

for await (const message of run) {
  if (
    message.type === "system" &&
    message.subtype === "tool_progress" &&
    message.status === "running"
  ) {
    await run.steer("Stop that path and summarize the plan instead.");
  }
}
```

## MCP Tools

```ts
import { createSdkMcpServer, query, tool } from "pinocchio";
import { z } from "zod";

const weatherServer = createSdkMcpServer({
  name: "weather",
  tools: [
    tool("get_weather", {
      description: "Get the weather for a city.",
      inputSchema: z.object({
        city: z.string(),
      }),
      run: async ({ city }) => ({
        content: [{ type: "text", text: `Weather for ${city}` }],
      }),
    }),
  ],
});

const stream = await query("What is the weather in Pune?", {
  cwd: process.cwd(),
  mcpServers: {
    weather: weatherServer,
  },
});
```

## Project Layout

Pinocchio auto-loads from `.agents/`:

```text
.agents/
  config.json
  tools/
    tools.json
    read.ts
    edit.ts
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
      commands/
        audit.md
  mcp.json
```

## Config

Example `.agents/config.json`:

```json
{
  "name": "Pinocchio",
  "model": "claude-sonnet-4-5",
  "max_tokens": 4096,
  "system_prompt": "You are a transparent coding agent.",
  "disabled_skills": ["codebase"],
  "provider": {
    "api_key_env": "ANTHROPIC_API_KEY",
    "base_url": "https://api.anthropic.com/v1/messages",
    "protocol": "anthropic",
    "version": "2023-06-01"
  }
}
```

## Local Tools

Example `.agents/tools/tools.json`:

```json
{
  "tools": [
    {
      "name": "Read",
      "enabled": true,
      "description": "Read a file from the project.",
      "input_schema": {
        "type": "object",
        "properties": {
          "file_path": { "type": "string" }
        },
        "required": ["file_path"]
      },
      "source": "./read.ts"
    }
  ]
}
```

Tool source files export a default function or `execute()`:

```ts
export default async function readTool(input, context) {
  return `reading ${input.file_path} from ${context.cwd}`;
}
```

Pinocchio does not ship a default tool pack. If you want `Read`, `Write`, `Edit`, `Bash`, `TodoWrite`, `AskUserQuestion`, `Agent`, or any other capability, define it in `.agents/tools/tools.json` or provide it through MCP.

Set `"enabled": false` on a tool to hide it from the next agent run. Skills can be disabled per runtime by adding their folder ids to `.agents/config.json` under `disabled_skills`.

## Sessions

Pinocchio persists sessions under the global runtime directory (`$PINOCCHIO_HOME` or `~/.agents`) in `sessions/`, and file checkpoints in `checkpoints/`. Project `.agents/` directories are used for configuration only when they already exist.

```ts
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
  tagSession,
} from "pinocchio";

const sessions = await listSessions({ cwd: process.cwd() });
await renameSession(sessions[0].sessionId, "Main Refactor", { cwd: process.cwd() });
await tagSession(sessions[0].sessionId, "important", { cwd: process.cwd() });

const info = await getSessionInfo(sessions[0].sessionId, { cwd: process.cwd() });
const transcript = await getSessionMessages(sessions[0].sessionId, { cwd: process.cwd() });
```

## What Landed

- `query()` and `PinocchioSDKClient`
- `.agents/` auto-loading for config, tools, skills, commands, agents, plugins, and MCP config
- project-owned tool loading with no built-in fallback tools
- in-process SDK MCP servers via `createSdkMcpServer()` and `tool()`
- session persistence and resume
- permission gating, user questions, hooks, and tool summaries
- file checkpointing and rewind
- structured output retries for JSON schema output

## Verification

```bash
bunx tsc --noEmit
bun test/index.ts
```

Hello, world!
