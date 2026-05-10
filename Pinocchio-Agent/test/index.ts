import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  extractAccountIdFromTokenResponse,
  configureOpenAISubscriptionRuntime,
  createProjectRuntimeScaffold,
  getOpenAISubscriptionUsage,
  getProjectRuntimeConfigState,
  listOpenAISubscriptionModels,
  loadOpenAISubscriptionAuth,
  PinocchioSDKClient,
  refreshOpenAISubscriptionAuth,
  removeOpenAISubscriptionAuth,
  saveProjectRuntimeMode,
  saveOpenAISubscriptionAuth,
  setProjectRuntimeSkillEnabled,
  setProjectRuntimeToolEnabled,
  setProjectRuntimeModel,
  createSdkMcpServer,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  tagSession,
  tool,
  type SDKMessage,
  type SessionInfo,
} from "pinocchio";

type FetchHandler = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>;

async function withMockedFetch<T>(handler: FetchHandler, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function anthropicTextResponse(id: string, text: string): Response {
  return new Response(
    JSON.stringify({
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      model: "demo-model",
      usage: {
        input_tokens: 10,
        output_tokens: 6,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function anthropicToolResponse(id: string, toolName: string, input: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      id,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `toolu_${id}`,
          name: toolName,
          input,
        },
      ],
      stop_reason: "tool_use",
      model: "demo-model",
      usage: {
        input_tokens: 8,
        output_tokens: 4,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function anthropicThinkingResponse(id: string, thinking: string, text: string): Response {
  return new Response(
    JSON.stringify({
      id,
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking },
        { type: "text", text },
      ],
      stop_reason: "end_turn",
      model: "demo-model",
      usage: {
        input_tokens: 10,
        output_tokens: 6,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function createWorkspace(label: string): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `pinocchio-v0-${label}-`));
  const agentsRuntimeDir = path.join(workspace, ".agents");
  const toolsDir = path.join(agentsRuntimeDir, "tools");
  const skillsDir = path.join(agentsRuntimeDir, "skills", "codebase");
  const commandsDir = path.join(agentsRuntimeDir, "commands");
  const agentsDir = path.join(agentsRuntimeDir, "agents");
  const pluginDir = path.join(agentsRuntimeDir, "plugins", "quality");

  await mkdir(toolsDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  await mkdir(commandsDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  await mkdir(path.join(pluginDir, ".agents-plugin"), { recursive: true });
  await mkdir(path.join(pluginDir, "commands"), { recursive: true });

  await writeFile(
    path.join(agentsRuntimeDir, "config.json"),
    JSON.stringify(
      {
        name: "Pinocchio Test",
        model: "demo-model",
        max_tokens: 256,
        system_prompt: "Be concise and use tools when helpful.",
        provider: {
          api_key_env: "TEST_ANTHROPIC_KEY",
          base_url: "https://example.com/provider",
          protocol: "anthropic",
          version: "2023-06-01",
        },
      },
      null,
      2,
    ),
  );

  await writeFile(
    path.join(toolsDir, "tools.json"),
    JSON.stringify(
      {
        tools: [
          {
            name: "Read",
            enabled: true,
            description: "Read a file from the project.",
            input_schema: {
              type: "object",
              properties: {
                file_path: { type: "string" },
              },
              required: ["file_path"],
            },
            source: "./read.ts",
          },
          {
            name: "Write",
            enabled: true,
            description: "Write full contents to a file.",
            input_schema: {
              type: "object",
              properties: {
                file_path: { type: "string" },
                content: { type: "string" },
              },
              required: ["file_path", "content"],
            },
            source: "./write.ts",
          },
          {
            name: "Bash",
            enabled: true,
            description: "Run a shell command.",
            input_schema: {
              type: "object",
              properties: {
                command: { type: "string" },
              },
              required: ["command"],
            },
            source: "./bash.ts",
          },
          {
            name: "shout",
            enabled: true,
            description: "Return uppercase text.",
            input_schema: {
              type: "object",
              properties: {
                text: { type: "string" },
              },
              required: ["text"],
            },
            source: "./shout.ts",
          },
          {
            name: "Delay",
            enabled: true,
            description: "Wait in small interruptible steps.",
            input_schema: {
              type: "object",
              properties: {
                steps: { type: "number" },
                delay_ms: { type: "number" },
              },
            },
            source: "./delay.ts",
          },
        ],
      },
      null,
      2,
    ),
  );

  await writeFile(
    path.join(toolsDir, "read.ts"),
    [
      "import { readFile } from 'fs/promises';",
      "import path from 'node:path';",
      "",
      "export default async function readTool(input, context) {",
      "  const filePath = path.resolve(context.cwd, String(input.file_path ?? ''));",
      "  return await readFile(filePath, 'utf-8');",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    path.join(toolsDir, "write.ts"),
    [
      "import { mkdir, writeFile } from 'fs/promises';",
      "import path from 'node:path';",
      "",
      "export default async function writeTool(input, context) {",
      "  const filePath = path.resolve(context.cwd, String(input.file_path ?? ''));",
      "  await mkdir(path.dirname(filePath), { recursive: true });",
      "  await writeFile(filePath, String(input.content ?? ''), 'utf-8');",
      "  return `Wrote ${filePath}`;",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    path.join(toolsDir, "bash.ts"),
    [
      "export default async function bashTool(input) {",
      "  return `bash:${String(input.command ?? '')}`;",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    path.join(toolsDir, "shout.ts"),
    [
      "export default async function shout(input) {",
      "  return String(input.text ?? '').toUpperCase();",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    path.join(toolsDir, "delay.ts"),
    [
      "function sleep(ms) {",
      "  return new Promise((resolve) => setTimeout(resolve, ms));",
      "}",
      "",
      "export default async function delayTool(input, context) {",
      "  const steps = Number(input.steps ?? 5);",
      "  const delayMs = Number(input.delay_ms ?? 10);",
      "",
      "  for (let index = 0; index < steps; index += 1) {",
      "    if (context.signal.aborted) {",
      "      throw new Error('Delay interrupted');",
      "    }",
      "    await sleep(delayMs);",
      "  }",
      "",
      "  return `Delayed for ${steps} steps`;",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    path.join(skillsDir, "SKILL.md"),
    [
      "---",
      "name: Codebase Search",
      "description: Search the repository before making changes.",
      "---",
      "",
      "Use search tools first.",
      "",
    ].join("\n"),
  );

  await writeFile(
    path.join(commandsDir, "ship.md"),
    [
      "---",
      "description: Prepare a release-minded response.",
      "---",
      "",
      "Respond like a release captain.",
      "",
    ].join("\n"),
  );

  await writeFile(
    path.join(agentsDir, "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Review code for risk.",
      "tools: Read,shout",
      "---",
      "",
      "Focus on concrete bugs and regressions.",
      "",
    ].join("\n"),
  );

  await writeFile(
    path.join(pluginDir, ".agents-plugin", "plugin.json"),
    JSON.stringify({ name: "quality" }, null, 2),
  );

  await writeFile(
    path.join(pluginDir, "commands", "audit.md"),
    [
      "---",
      "description: Audit project quality.",
      "---",
      "",
      "Run a quality audit.",
      "",
    ].join("\n"),
  );

  return workspace;
}

async function withWorkspace<T>(label: string, run: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await createWorkspace(label);
  try {
    return await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function collectMessages(run: Promise<Awaited<ReturnType<typeof query>>>): Promise<SDKMessage[]> {
  const stream = await run;
  const messages: SDKMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

function findResult(messages: SDKMessage[]) {
  return messages.find((message): message is Extract<SDKMessage, { type: "result" }> => message.type === "result");
}

function findInit(messages: SDKMessage[]) {
  return messages.find((message): message is Extract<SDKMessage, { type: "system"; subtype: "init" }> => message.type === "system" && message.subtype === "init");
}

function findToolResults(messages: SDKMessage[]) {
  return messages.filter((message): message is Extract<SDKMessage, { type: "system"; subtype: "tool_result" }> => message.type === "system" && message.subtype === "tool_result");
}

function findToolProgress(messages: SDKMessage[]) {
  return messages.filter((message): message is Extract<SDKMessage, { type: "system"; subtype: "tool_progress" }> => message.type === "system" && message.subtype === "tool_progress");
}

function encodeJwtPayload(payload: Record<string, unknown>): string {
  return [
    "eyJhbGciOiJub25lIn0",
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

async function runOpenAISubscriptionAuthTest(): Promise<void> {
  const previousPinocchioHome = process.env.PINOCCHIO_HOME;
  const authHome = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-openai-auth-"));

  try {
    process.env.PINOCCHIO_HOME = path.join(authHome, ".agents");
    await removeOpenAISubscriptionAuth();

    assert.equal(
      extractAccountIdFromTokenResponse({
        id_token: encodeJwtPayload({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc-nested",
          },
        }),
        access_token: "",
      }),
      "acc-nested",
    );

    await saveOpenAISubscriptionAuth({
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 10,
      accountId: "acc-old",
    });

    const loadedAuth = await loadOpenAISubscriptionAuth();
    assert.equal(loadedAuth?.type, "oauth");
    assert.equal(loadedAuth?.access, "old-access");
    assert.equal(loadedAuth?.refresh, "old-refresh");
    assert.equal(loadedAuth?.accountId, "acc-old");
    assert.ok((loadedAuth?.expires ?? 0) < Date.now());

    await withMockedFetch(async (input, init) => {
      assert.equal(String(input), "https://auth.openai.com/oauth/token");
      assert.match(String(init?.body), /grant_type=refresh_token/);
      assert.match(String(init?.body), /refresh_token=old-refresh/);
      return new Response(
        JSON.stringify({
          id_token: encodeJwtPayload({ chatgpt_account_id: "acc-new" }),
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 120,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }, async () => {
      const refreshed = await refreshOpenAISubscriptionAuth();
      assert.equal(refreshed.access, "new-access");
      assert.equal(refreshed.refresh, "new-refresh");
      assert.equal(refreshed.accountId, "acc-new");
      assert.ok(refreshed.expires > Date.now());
    });

    await removeOpenAISubscriptionAuth();
  assert.equal(await loadOpenAISubscriptionAuth(), null);
  } finally {
    if (previousPinocchioHome === undefined) {
      delete process.env.PINOCCHIO_HOME;
    } else {
      process.env.PINOCCHIO_HOME = previousPinocchioHome;
    }

    await rm(authHome, { recursive: true, force: true });
  }
}

async function runOpenAISubscriptionRuntimeConfigTest(): Promise<void> {
  const previousPinocchioHome = process.env.PINOCCHIO_HOME;
  const configHome = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-openai-config-"));

  try {
    process.env.PINOCCHIO_HOME = path.join(configHome, ".agents");
    await mkdir(process.env.PINOCCHIO_HOME, { recursive: true });
    await writeFile(
      path.join(process.env.PINOCCHIO_HOME, "config.json"),
      JSON.stringify(
        {
          name: "Existing Global",
          model: "minimax/minimax-m2.5:free",
          max_tokens: 256,
          provider: {
            api_key_env: "OPENROUTER_API_KEY",
            base_url: "https://openrouter.ai/api/v1/chat/completions",
            protocol: "openai",
          },
        },
        null,
        2,
      ),
    );

    const cwdWithoutRuntime = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-openai-config-cwd-"));
    try {
      const updated = await configureOpenAISubscriptionRuntime(cwdWithoutRuntime);
      assert.equal(updated.model, "gpt-5.4");
      assert.equal(updated.provider.protocol, "openai-subscription");
      assert.equal(updated.provider.base_url, "https://api.openai.com/v1/responses");

      const raw = JSON.parse(await readFile(path.join(process.env.PINOCCHIO_HOME, "config.json"), "utf-8")) as {
        name?: string;
        model?: string;
        max_tokens?: number;
        provider?: { protocol?: string; base_url?: string; api_key_env?: string };
      };
      assert.equal(raw.name, "Existing Global");
      assert.equal(raw.max_tokens, 256);
      assert.equal(raw.model, "gpt-5.4");
      assert.equal(raw.provider?.protocol, "openai-subscription");
      assert.equal(raw.provider?.base_url, "https://api.openai.com/v1/responses");
      assert.equal(raw.provider?.api_key_env, undefined);

      const globalModelUpdate = await setProjectRuntimeModel(cwdWithoutRuntime, "gpt-5.2");
      assert.equal(globalModelUpdate.model, "gpt-5.2");
      const globalRaw = JSON.parse(await readFile(path.join(process.env.PINOCCHIO_HOME, "config.json"), "utf-8")) as {
        model?: string;
        effort?: string;
        provider?: { protocol?: string };
      };
      assert.equal(globalRaw.model, "gpt-5.2");
      assert.equal(globalRaw.provider?.protocol, "openai-subscription");

      const globalEffortUpdate = await setProjectRuntimeModel(cwdWithoutRuntime, "gpt-5.2", "high");
      assert.equal(globalEffortUpdate.model, "gpt-5.2");
      assert.equal(globalEffortUpdate.effort, "high");
      const globalEffortRaw = JSON.parse(await readFile(path.join(process.env.PINOCCHIO_HOME, "config.json"), "utf-8")) as {
        model?: string;
        effort?: string;
      };
      assert.equal(globalEffortRaw.model, "gpt-5.2");
      assert.equal(globalEffortRaw.effort, "high");
    } finally {
      await rm(cwdWithoutRuntime, { recursive: true, force: true });
    }

    const cwdWithRuntime = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-openai-config-project-"));
    try {
      await mkdir(path.join(cwdWithRuntime, ".agents"), { recursive: true });
      const localModelUpdate = await setProjectRuntimeModel(cwdWithRuntime, "gpt-5.3-codex", "xhigh");
      assert.equal(localModelUpdate.model, "gpt-5.3-codex");
      assert.equal(localModelUpdate.effort, "xhigh");

      const localRaw = JSON.parse(await readFile(path.join(cwdWithRuntime, ".agents", "config.json"), "utf-8")) as {
        model?: string;
        effort?: string;
      };
      const globalRaw = JSON.parse(await readFile(path.join(process.env.PINOCCHIO_HOME, "config.json"), "utf-8")) as {
        model?: string;
      };
      assert.equal(localRaw.model, "gpt-5.3-codex");
      assert.equal(localRaw.effort, "xhigh");
      assert.equal(globalRaw.model, "gpt-5.2");
    } finally {
      await rm(cwdWithRuntime, { recursive: true, force: true });
    }
  } finally {
    if (previousPinocchioHome === undefined) {
      delete process.env.PINOCCHIO_HOME;
    } else {
      process.env.PINOCCHIO_HOME = previousPinocchioHome;
    }

    await rm(configHome, { recursive: true, force: true });
  }
}

async function runRuntimeConfigToggleTest(): Promise<void> {
  process.env.TEST_ANTHROPIC_KEY = "test-key";

  await withWorkspace("runtime-config-toggle", async (workspace) => {
    const initialState = await getProjectRuntimeConfigState(workspace);
    assert.equal(initialState.tools.find((tool) => tool.name === "Write")?.enabled, true);
    assert.equal(initialState.skills.find((skill) => skill.id === "codebase")?.enabled, true);

    await setProjectRuntimeToolEnabled(workspace, "Write", false);
    await setProjectRuntimeSkillEnabled(workspace, "codebase", false);

    const persistedState = await getProjectRuntimeConfigState(workspace);
    assert.equal(persistedState.tools.find((tool) => tool.name === "Write")?.enabled, false);
    assert.equal(persistedState.skills.find((skill) => skill.id === "codebase")?.enabled, false);

    const configRaw = JSON.parse(await readFile(path.join(workspace, ".agents", "config.json"), "utf-8")) as {
      disabled_skills?: string[];
    };
    const toolsRaw = JSON.parse(await readFile(path.join(workspace, ".agents", "tools", "tools.json"), "utf-8")) as {
      tools?: Array<{ name?: string; enabled?: boolean }>;
    };

    assert.deepEqual(configRaw.disabled_skills, ["codebase"]);
    assert.equal(toolsRaw.tools?.find((tool) => tool.name === "Write")?.enabled, false);

    await withMockedFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { system?: string; tools?: Array<Record<string, unknown>> };
      const toolNames = (body.tools ?? []).map((tool) => String((tool as { name?: string }).name ?? ""));
      assert.match(body.system ?? "", /Write final assistant responses as plain terminal text, not Markdown/);
      assert.ok(toolNames.includes("Read"));
      assert.ok(!toolNames.includes("Write"));
      return anthropicTextResponse("msg_runtime_toggle", "respected disabled runtime items");
    }, async () => {
      const messages = await collectMessages(query("Use the updated runtime config.", { cwd: workspace }));
      const init = findInit(messages);
      assert.equal(findResult(messages)?.result, "respected disabled runtime items");
      assert.ok(init);
      assert.ok(!init?.tools.includes("Write"));
      assert.ok(!init?.skills.includes("Codebase Search"));
    });
  });
}

async function runModeRuntimeTest(): Promise<void> {
  process.env.TEST_ANTHROPIC_KEY = "test-key";

  await withWorkspace("mode-runtime", async (workspace) => {
    const modesDir = path.join(workspace, ".agents", "modes");
    await mkdir(modesDir, { recursive: true });
    await mkdir(path.join(workspace, "backend"), { recursive: true });
    await mkdir(path.join(workspace, "frontend"), { recursive: true });
    await writeFile(path.join(workspace, "backend", "allowed.txt"), "backend ok", "utf-8");
    await writeFile(path.join(workspace, "frontend", "blocked.txt"), "frontend blocked", "utf-8");

    await writeFile(
      path.join(modesDir, "plan.json"),
      JSON.stringify(
        {
          id: "plan",
          name: "Plan",
          description: "Read-only planning mode",
          tools: {
            allow: ["Read"],
          },
          skills: {
            allow: ["codebase"],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await writeFile(
      path.join(modesDir, "backend.json"),
      JSON.stringify(
        {
          id: "backend",
          name: "Backend",
          description: "Backend-only file access",
          tools: {
            allow: ["Read", "Write"],
          },
          paths: {
            allow: ["./backend"],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    let callCount = 0;
    await withMockedFetch(async (_input, init) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body)) as { tools?: Array<Record<string, unknown>>; messages?: Array<Record<string, unknown>> };

      if (callCount === 1) {
        const toolNames = (body.tools ?? []).map((tool) => String((tool as { name?: string }).name ?? ""));
        assert.deepEqual(toolNames.sort(), ["Read"]);
        return anthropicTextResponse("msg_mode_plan", "plan mode response");
      }

      if (callCount === 2) {
        return anthropicToolResponse("msg_mode_path", "Read", { file_path: "frontend/blocked.txt" });
      }

      const toolResult = (((body.messages?.at(-1) as { content?: Array<{ content?: unknown }> } | undefined)?.content?.[0]) as { content?: unknown } | undefined)?.content;
      assert.match(String(toolResult), /outside the active mode paths/i);
      return anthropicTextResponse("msg_mode_path_done", "path denial surfaced");
    }, async () => {
      const planMessages = await collectMessages(query("Use planning mode.", { cwd: workspace, mode: "plan" } as never));
      const planInit = findInit(planMessages);
      assert.equal(findResult(planMessages)?.result, "plan mode response");
      assert.deepEqual(planInit?.tools, ["Read"]);
      assert.deepEqual(planInit?.skills, ["Codebase Search"]);

      const pathMessages = await collectMessages(query("Read the frontend file.", { cwd: workspace, mode: "backend" } as never));
      assert.equal(findResult(pathMessages)?.result, "path denial surfaced");
      assert.equal(findToolResults(pathMessages)[0]?.tool_name, "Read");
      assert.match(String(findToolResults(pathMessages)[0]?.content ?? ""), /outside the active mode paths/i);
    });
  });
}

async function runModePersistenceTest(): Promise<void> {
  await withWorkspace("mode-persistence", async (workspace) => {
    const createdLocal = await saveProjectRuntimeMode(workspace, {
      name: "Plan Review",
      source: "project",
      disabledTools: ["Write", "Bash"],
      disabledSkills: ["codebase"],
    });

    assert.equal(createdLocal.source, "project");
    assert.equal(createdLocal.id, "plan-review");

    const localRaw = JSON.parse(
      await readFile(path.join(workspace, ".agents", "modes", "plan-review.json"), "utf-8"),
    ) as {
      tools?: { deny?: string[] };
      skills?: { deny?: string[] };
    };
    assert.deepEqual(localRaw.tools?.deny, ["Bash", "Write"]);
    assert.deepEqual(localRaw.skills?.deny, ["codebase"]);

    const updatedLocal = await saveProjectRuntimeMode(workspace, {
      id: createdLocal.id,
      name: "Plan Review Updated",
      source: "project",
      disabledTools: ["Write"],
      disabledSkills: [],
      paths: { allow: ["./docs"] },
    });

    assert.equal(updatedLocal.id, "plan-review");
    assert.equal(updatedLocal.name, "Plan Review Updated");
    assert.deepEqual(updatedLocal.paths.allow, ["./docs"]);

    const previousPinocchioHome = process.env.PINOCCHIO_HOME;
    const globalHome = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-mode-global-"));

    try {
      process.env.PINOCCHIO_HOME = path.join(globalHome, ".agents");
      const createdGlobal = await saveProjectRuntimeMode(path.join(workspace, "nested"), {
        name: "Global Planning",
        source: "global",
        disabledTools: ["Bash"],
        disabledSkills: [],
      });

      assert.equal(createdGlobal.source, "global");
      const globalModePath = path.join(process.env.PINOCCHIO_HOME, "modes", `${createdGlobal.id}.json`);
      const globalStat = await stat(globalModePath);
      assert.equal(globalStat.isFile(), true);
    } finally {
      if (previousPinocchioHome === undefined) {
        delete process.env.PINOCCHIO_HOME;
      } else {
        process.env.PINOCCHIO_HOME = previousPinocchioHome;
      }

      await rm(globalHome, { recursive: true, force: true });
    }
  });
}

async function runProjectRuntimeInitTest(): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-init-runtime-"));

  try {
    const created = await createProjectRuntimeScaffold(workspace);
    assert.equal(created.created, true);
    assert.equal(created.runtimeDir, path.join(workspace, ".agents"));

    const configRaw = JSON.parse(await readFile(path.join(workspace, ".agents", "config.json"), "utf-8")) as {
      disabled_skills?: string[];
    };
    const toolsRaw = JSON.parse(await readFile(path.join(workspace, ".agents", "tools", "tools.json"), "utf-8")) as {
      tools?: unknown[];
    };

    assert.deepEqual(configRaw.disabled_skills, []);
    assert.deepEqual(toolsRaw.tools, []);
    assert.equal((await stat(path.join(workspace, ".agents", "skills"))).isDirectory(), true);

    const repeated = await createProjectRuntimeScaffold(workspace);
    assert.equal(repeated.created, false);
    assert.equal(repeated.runtimeDir, path.join(workspace, ".agents"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runOpenAISubscriptionModelsTest(): Promise<void> {
  const previousPinocchioHome = process.env.PINOCCHIO_HOME;
  const authHome = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-openai-models-auth-"));

  try {
    process.env.PINOCCHIO_HOME = path.join(authHome, ".agents");
    await saveOpenAISubscriptionAuth({
      type: "oauth",
      access: "subscription-access",
      refresh: "subscription-refresh",
      expires: Date.now() + 60_000,
      accountId: "acc-models",
    });

    const fetchedUrls: string[] = [];
    await withMockedFetch(async (input, init) => {
      const url = new URL(String(input));
      fetchedUrls.push(url.href);

      if (url.href === "https://registry.npmjs.org/@openai%2Fcodex") {
        assert.equal(init?.method, "GET");
        return new Response(JSON.stringify({ "dist-tags": { latest: "0.120.0" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.href === "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json") {
        assert.equal(init?.method, "GET");
        return new Response(
          JSON.stringify({
            models: [
              {
                slug: "gpt-catalog",
                display_name: "GPT Catalog",
                description: "Bundled catalog model.",
                visibility: "list",
                supported_in_api: true,
                priority: 5,
                minimal_client_version: "0.120.0",
              },
              {
                slug: "gpt-later",
                display_name: "GPT Later Catalog",
                description: "Catalog description should be overridden.",
                visibility: "list",
                supported_in_api: false,
                priority: 50,
                minimal_client_version: "0.1.0",
              },
              {
                slug: "gpt-too-new",
                display_name: "GPT Too New",
                priority: 0,
                minimal_client_version: "0.121.0",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      assert.equal(`${url.origin}${url.pathname}`, "https://chatgpt.com/backend-api/codex/models");
      assert.equal(url.searchParams.get("client_version"), "0.120.0");

      const headers = new Headers(init?.headers);
      assert.equal(init?.method, "GET");
      assert.equal(headers.get("authorization"), "Bearer subscription-access");
      assert.equal(headers.get("ChatGPT-Account-Id"), "acc-models");

      return new Response(
        JSON.stringify({
          models: [
            {
              slug: "gpt-later",
              display_name: "GPT Later",
              description: "Second model.",
              visibility: "hidden",
              supported_in_api: true,
              priority: 20,
            },
            {
              slug: "gpt-first",
              display_name: "GPT First",
              description: "First model.",
              visibility: "list",
              supported_in_api: false,
              priority: 1,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }, async () => {
      const models = await listOpenAISubscriptionModels();
      assert.deepEqual(
        models.map((model) => model.slug),
        ["gpt-first", "gpt-catalog", "gpt-later"],
      );
      assert.equal(models[0]?.displayName, "GPT First");
      assert.equal(models[0]?.visibility, "list");
      assert.equal(models[0]?.supportedInApi, false);
      assert.equal(models[1]?.description, "Bundled catalog model.");
      assert.equal(models[2]?.displayName, "GPT Later");
      assert.equal(models[2]?.description, "Second model.");
      assert.equal(models[2]?.supportedInApi, true);
      assert.deepEqual(fetchedUrls, [
        "https://registry.npmjs.org/@openai%2Fcodex",
        "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json",
        "https://chatgpt.com/backend-api/codex/models?client_version=0.120.0",
      ]);
    });
  } finally {
    if (previousPinocchioHome === undefined) {
      delete process.env.PINOCCHIO_HOME;
    } else {
      process.env.PINOCCHIO_HOME = previousPinocchioHome;
    }

    await rm(authHome, { recursive: true, force: true });
  }
}

async function runOpenAISubscriptionUsageTest(): Promise<void> {
  const previousPinocchioHome = process.env.PINOCCHIO_HOME;
  const authHome = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-openai-usage-auth-"));

  try {
    process.env.PINOCCHIO_HOME = path.join(authHome, ".agents");
    await saveOpenAISubscriptionAuth({
      type: "oauth",
      access: "subscription-access",
      refresh: "subscription-refresh",
      expires: Date.now() + 60_000,
      accountId: "acc-usage",
    });

    await withMockedFetch(async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.href, "https://chatgpt.com/backend-api/wham/usage");

      const headers = new Headers(init?.headers);
      assert.equal(init?.method, "GET");
      assert.equal(headers.get("authorization"), "Bearer subscription-access");
      assert.equal(headers.get("ChatGPT-Account-Id"), "acc-usage");

      return new Response(
        JSON.stringify({
          email: "tanmaysingewar@gmail.com",
          plan_type: "plus",
          rate_limit: {
            limit_reached: false,
            primary_window: {
              used_percent: 14,
              limit_window_seconds: 18_000,
              reset_after_seconds: 3_600,
              reset_at: 1_777_600_000,
            },
            secondary_window: {
              used_percent: 34,
              limit_window_seconds: 604_800,
              reset_after_seconds: 86_400,
              reset_at: 1_778_200_000,
            },
          },
          credits: {
            has_credits: true,
            unlimited: false,
            balance: "9.99",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }, async () => {
      const usage = await getOpenAISubscriptionUsage();
      assert.equal(usage.email, "tanmaysingewar@gmail.com");
      assert.equal(usage.planType, "plus");
      assert.equal(usage.limitReached, false);
      assert.deepEqual(usage.primaryWindow, {
        usedPercent: 14,
        windowSeconds: 18_000,
        resetAfterSeconds: 3_600,
        resetAt: 1_777_600_000,
      });
      assert.deepEqual(usage.secondaryWindow, {
        usedPercent: 34,
        windowSeconds: 604_800,
        resetAfterSeconds: 86_400,
        resetAt: 1_778_200_000,
      });
      assert.equal(usage.hasCredits, true);
      assert.equal(usage.unlimitedCredits, false);
      assert.equal(usage.creditsBalance, "9.99");
    });
  } finally {
    if (previousPinocchioHome === undefined) {
      delete process.env.PINOCCHIO_HOME;
    } else {
      process.env.PINOCCHIO_HOME = previousPinocchioHome;
    }

    await rm(authHome, { recursive: true, force: true });
  }
}

async function runOpenAISubscriptionTransportTest(): Promise<void> {
  const previousPinocchioHome = process.env.PINOCCHIO_HOME;
  const authHome = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-openai-transport-auth-"));

  try {
    process.env.PINOCCHIO_HOME = path.join(authHome, ".agents");
    await saveOpenAISubscriptionAuth({
      type: "oauth",
      access: "subscription-access",
      refresh: "subscription-refresh",
      expires: Date.now() + 60_000,
      accountId: "acc-transport",
    });

    await withWorkspace("openai-subscription", async (workspace) => {
      await writeFile(
        path.join(workspace, ".agents", "config.json"),
        JSON.stringify(
          {
            name: "OpenAI Subscription Test",
            model: "gpt-5.4",
            effort: "xhigh",
            max_tokens: 256,
            system_prompt: "Be concise.",
            provider: {
              base_url: "https://api.openai.com/v1/responses",
              protocol: "openai-subscription",
            },
          },
          null,
          2,
        ),
      );

      await withMockedFetch(async (input, init) => {
        assert.equal(String(input), "https://chatgpt.com/backend-api/codex/responses");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "Bearer subscription-access");
        assert.equal(headers.get("ChatGPT-Account-Id"), "acc-transport");
        const body = JSON.parse(String(init?.body)) as {
          instructions?: string;
          input?: Array<Record<string, unknown>>;
          max_tokens?: number;
          messages?: Array<Record<string, unknown>>;
          model?: string;
          reasoning?: { effort?: string; summary?: string };
          store?: boolean;
          stream?: boolean;
          tools?: Array<{ type?: string; name?: string; function?: { name?: string } }>;
        };
        assert.equal(body.model, "gpt-5.4");
        assert.equal(body.max_tokens, undefined);
        assert.match(body.instructions ?? "", /Be concise/);
        assert.match(body.instructions ?? "", /Write final assistant responses as plain terminal text, not Markdown/);
        assert.equal(body.reasoning?.effort, "xhigh");
        assert.equal(body.reasoning?.summary, "auto");
        assert.equal(body.store, false);
        assert.equal(body.stream, true);
        assert.equal(body.messages, undefined);
        assert.ok(body.input?.some((message) => message.role === "user"));
        assert.ok(body.tools?.some((tool) => tool.type === "function" && tool.name === "Read" && !tool.function));
        return new Response(
          [
            `event: response.created\ndata: ${JSON.stringify({
              response: { id: "resp_subscription", model: "gpt-5.4" },
            })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              delta: "subscription response",
            })}\n\n`,
            `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
              delta: "Condensed ",
            })}\n\n`,
            `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
              delta: "reasoning summary",
            })}\n\n`,
            `event: response.reasoning_summary_text.done\ndata: ${JSON.stringify({
              text: "Condensed reasoning summary",
            })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({
              response: {
                id: "resp_subscription",
                model: "gpt-5.4",
                usage: { input_tokens: 4, output_tokens: 2 },
              },
            })}\n\n`,
          ].join(""),
          { status: 200 },
        );
      }, async () => {
        const messages = await collectMessages(query("Use subscription auth.", { cwd: workspace }));
        const assistant = messages.find((message): message is Extract<SDKMessage, { type: "assistant" }> => message.type === "assistant");
        assert.ok(assistant);
        assert.deepEqual(assistant.message.content, [
          { type: "thinking", thinking: "Condensed reasoning summary" },
          { type: "text", text: "subscription response" },
        ]);
        assert.equal(findResult(messages)?.result, "subscription response");
      });
    });

    await removeOpenAISubscriptionAuth();

    await withWorkspace("openai-subscription-missing-auth", async (workspace) => {
      await writeFile(
        path.join(workspace, ".agents", "config.json"),
        JSON.stringify(
          {
            name: "Missing Subscription Auth",
            model: "gpt-5.4",
            max_tokens: 256,
            system_prompt: "Be concise.",
            provider: {
              base_url: "https://api.openai.com/v1/responses",
              protocol: "openai-subscription",
            },
          },
          null,
          2,
        ),
      );

      const messages = await collectMessages(query("No auth yet.", { cwd: workspace }));
      const result = findResult(messages);
      assert.equal(result?.subtype, "error_during_execution");
      assert.match(result?.errors?.join("\n") ?? "", /Run \/connect to connect your ChatGPT subscription/);
    });
  } finally {
    if (previousPinocchioHome === undefined) {
      delete process.env.PINOCCHIO_HOME;
    } else {
      process.env.PINOCCHIO_HOME = previousPinocchioHome;
    }

    await rm(authHome, { recursive: true, force: true });
  }
}

async function runAnthropicThinkingBlockTest(): Promise<void> {
  await withWorkspace("anthropic-thinking", async (workspace) => {
    await withMockedFetch(async () => anthropicThinkingResponse("msg_thinking", "Plan quietly", "Final answer"), async () => {
      const messages = await collectMessages(query("Show your answer.", { cwd: workspace }));
      const assistant = messages.find((message): message is Extract<SDKMessage, { type: "assistant" }> => message.type === "assistant");
      assert.ok(assistant);
      assert.deepEqual(assistant.message.content, [
        { type: "thinking", thinking: "Plan quietly" },
        { type: "text", text: "Final answer" },
      ]);
      assert.equal(findResult(messages)?.result, "Final answer");
    });
  });
}

async function runQuickstartAndFilesystemTest(): Promise<void> {
  process.env.TEST_ANTHROPIC_KEY = "test-key";

  await withWorkspace("quickstart", async (workspace) => {
    await withMockedFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> };
      assert.equal(body.messages?.[0]?.role, "user");
      const toolNames = (body.tools ?? []).map((tool) => String((tool as { name?: string }).name ?? ""));
      assert.deepEqual(toolNames.sort(), ["Bash", "Delay", "Read", "Write", "shout"].sort());
      return anthropicTextResponse("msg_quickstart", "hello from pinocchio");
    }, async () => {
      const messages = await collectMessages(query("Say hello", { cwd: workspace }));
      const init = findInit(messages);
      const result = findResult(messages);
      assert.ok(init);
      assert.ok(result);
      assert.equal(result?.subtype, "success");
      assert.equal(result?.result, "hello from pinocchio");
      assert.ok(init?.skills.includes("Codebase Search"));
      assert.ok(init?.slash_commands.includes("ship"));
      assert.ok(init?.slash_commands.includes("audit"));
      assert.ok(init?.agents?.includes("reviewer"));
      assert.ok(init?.plugins.some((plugin) => plugin.name === "quality"));
      assert.ok(init?.tools.includes("Read"));
      assert.ok(init?.tools.includes("Write"));
      assert.ok(init?.tools.includes("Bash"));
      assert.ok(!init?.tools.includes("Agent"));
    });
  });
}

async function runRuntimeDiscoveryTest(): Promise<void> {
  process.env.TEST_ANTHROPIC_KEY = "test-key";
  const previousPinocchioHome = process.env.PINOCCHIO_HOME;
  const globalWorkspace = await createWorkspace("global-runtime");
  const cwdWithoutRuntime = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-no-runtime-"));

  try {
    process.env.PINOCCHIO_HOME = path.join(globalWorkspace, ".agents");

    await withMockedFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { tools?: Array<Record<string, unknown>> };
      const toolNames = (body.tools ?? []).map((tool) => String((tool as { name?: string }).name ?? ""));
      assert.ok(toolNames.includes("Read"));
      return anthropicTextResponse("msg_global_runtime", "loaded global runtime");
    }, async () => {
      const messages = await collectMessages(query("Use the global runtime.", { cwd: cwdWithoutRuntime }));
      assert.equal(findResult(messages)?.result, "loaded global runtime");
      assert.ok(findInit(messages)?.tools.includes("Read"));
      assert.equal(await stat(path.join(cwdWithoutRuntime, ".agents")).then(() => true, () => false), false);
      assert.equal((await listSessions({ cwd: cwdWithoutRuntime })).length, 1);
      assert.equal(await stat(path.join(globalWorkspace, ".agents", "sessions")).then(() => true, () => false), true);
    });

    const partialWorkspace = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-partial-runtime-"));
    try {
      const partialAgentsDir = path.join(partialWorkspace, ".agents");
      await mkdir(partialAgentsDir, { recursive: true });
      await writeFile(
        path.join(partialAgentsDir, "config.json"),
        JSON.stringify(
          {
            name: "Partial Project",
            model: "project-model",
          },
          null,
          2,
        ),
      );

      await withMockedFetch(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { model?: string; tools?: Array<Record<string, unknown>> };
        const toolNames = (body.tools ?? []).map((tool) => String((tool as { name?: string }).name ?? ""));
        assert.equal(body.model, "project-model");
        assert.ok(toolNames.includes("Read"));
        return anthropicTextResponse("msg_partial_runtime", "merged global defaults");
      }, async () => {
        const messages = await collectMessages(query("Use merged runtime defaults.", { cwd: partialWorkspace }));
        assert.equal(findResult(messages)?.result, "merged global defaults");
        assert.equal(findInit(messages)?.model, "project-model");
      });
    } finally {
      await rm(partialWorkspace, { recursive: true, force: true });
    }

    await writeFile(
      path.join(globalWorkspace, ".agents", "config.json"),
      JSON.stringify(
        {
          name: "Broken Global",
          model: "demo-model",
          provider: {
            api_key_env: "MISSING_GLOBAL_KEY",
            base_url: "https://example.com/provider",
            protocol: "anthropic",
          },
        },
        null,
        2,
      ),
    );

    await withWorkspace("local-runtime", async (workspace) => {
      const nestedCwd = path.join(workspace, "packages", "demo");
      await mkdir(nestedCwd, { recursive: true });

      await withMockedFetch(async () => anthropicTextResponse("msg_local_runtime", "loaded local runtime"), async () => {
        const messages = await collectMessages(query("Use the nearest local runtime.", { cwd: nestedCwd }));
        assert.equal(findResult(messages)?.result, "loaded local runtime");
      });
    });
  } finally {
    if (previousPinocchioHome === undefined) {
      delete process.env.PINOCCHIO_HOME;
    } else {
      process.env.PINOCCHIO_HOME = previousPinocchioHome;
    }

    await rm(globalWorkspace, { recursive: true, force: true });
    await rm(cwdWithoutRuntime, { recursive: true, force: true });
  }
}

async function runSessionLifecycleTest(): Promise<void> {
  process.env.TEST_ANTHROPIC_KEY = "test-key";
  const previousPinocchioHome = process.env.PINOCCHIO_HOME;
  const globalWorkspace = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-session-home-"));

  try {
    process.env.PINOCCHIO_HOME = path.join(globalWorkspace, ".agents");

    await withWorkspace("sessions", async (workspace) => {
      let callCount = 0;
      const client = new PinocchioSDKClient({ cwd: workspace, permissionMode: "bypassPermissions" });

      await withMockedFetch(async (_input, init) => {
        callCount += 1;
        const body = JSON.parse(String(init?.body)) as { messages?: Array<Record<string, unknown>> };
        if (callCount === 1) {
          assert.equal(body.messages?.length, 1);
          return anthropicTextResponse("msg_session_1", "first turn");
        }

        assert.equal(body.messages?.length, 3);
        return anthropicTextResponse("msg_session_2", "second turn");
      }, async () => {
        const first = await collectMessages(client.query("First turn"));
        const second = await collectMessages(client.query("Second turn"));
        const firstResult = findResult(first);
        const secondResult = findResult(second);
        assert.equal(firstResult?.result, "first turn");
        assert.equal(secondResult?.result, "second turn");
      });

      const sessions = await listSessions({ cwd: workspace });
      assert.equal(sessions.length, 1);
      assert.equal(await stat(path.join(workspace, ".agents", "sessions")).then(() => true, () => false), false);
      assert.equal(await stat(path.join(globalWorkspace, ".agents", "sessions")).then(() => true, () => false), true);
      const session = sessions[0] as SessionInfo;
      await renameSession(session.sessionId, "Primary Session", { cwd: workspace });
      await tagSession(session.sessionId, "important", { cwd: workspace });

      const info = await getSessionInfo(session.sessionId, { cwd: workspace });
      const messages = await getSessionMessages(session.sessionId, { cwd: workspace });
      assert.equal(info?.title, "Primary Session");
      assert.equal(info?.tag, "important");
      assert.ok(messages.some((message) => message.type === "assistant"));
    });
  } finally {
    if (previousPinocchioHome === undefined) {
      delete process.env.PINOCCHIO_HOME;
    } else {
      process.env.PINOCCHIO_HOME = previousPinocchioHome;
    }

    await rm(globalWorkspace, { recursive: true, force: true });
  }
}

async function runOpenAISubscriptionSessionResumeWithToolResultsTest(): Promise<void> {
  const previousPinocchioHome = process.env.PINOCCHIO_HOME;
  const authHome = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-openai-resume-home-"));

  try {
    process.env.PINOCCHIO_HOME = path.join(authHome, ".agents");
    await saveOpenAISubscriptionAuth({
      type: "oauth",
      access: "resume-access",
      refresh: "resume-refresh",
      expires: Date.now() + 60_000,
      accountId: "acc-resume",
    });

    await withWorkspace("openai-subscription-resume", async (workspace) => {
      await writeFile(
        path.join(workspace, ".agents", "config.json"),
        JSON.stringify(
          {
            name: "OpenAI Subscription Resume",
            model: "gpt-5.4",
            max_tokens: 256,
            system_prompt: "Be concise and use tools when helpful.",
            provider: {
              base_url: "https://api.openai.com/v1/responses",
              protocol: "openai-subscription",
            },
          },
          null,
          2,
        ),
      );

      let callCount = 0;
      const client = new PinocchioSDKClient({ cwd: workspace });

      await withMockedFetch(async (input, init) => {
        callCount += 1;
        assert.equal(String(input), "https://chatgpt.com/backend-api/codex/responses");
        const body = JSON.parse(String(init?.body)) as { input?: Array<Record<string, unknown>> };

        if (callCount === 1) {
          assert.equal(body.input?.length, 1);
          return new Response(
            [
              `event: response.created\ndata: ${JSON.stringify({
                response: { id: "resp_resume_1", model: "gpt-5.4" },
              })}\n\n`,
              `event: response.output_item.done\ndata: ${JSON.stringify({
                item: {
                  id: "fc_resume_1",
                  type: "function_call",
                  call_id: "call_resume_1",
                  name: "Bash",
                  arguments: "{\"command\":\"ls -la\"}",
                },
              })}\n\n`,
              `event: response.completed\ndata: ${JSON.stringify({
                response: {
                  id: "resp_resume_1",
                  model: "gpt-5.4",
                  usage: { input_tokens: 4, output_tokens: 2 },
                },
              })}\n\n`,
            ].join(""),
            { status: 200 },
          );
        }

        if (callCount === 2) {
          const lastItem = body.input?.at(-1) as { call_id?: string; output?: string; type?: string } | undefined;
          assert.equal(lastItem?.type, "function_call_output");
          assert.equal(lastItem?.call_id, "call_resume_1");
          assert.equal(lastItem?.output, "bash:ls -la");
          return new Response(
            [
              `event: response.created\ndata: ${JSON.stringify({
                response: { id: "resp_resume_2", model: "gpt-5.4" },
              })}\n\n`,
              `event: response.output_text.delta\ndata: ${JSON.stringify({
                delta: "done with ls",
              })}\n\n`,
              `event: response.completed\ndata: ${JSON.stringify({
                response: {
                  id: "resp_resume_2",
                  model: "gpt-5.4",
                  usage: { input_tokens: 6, output_tokens: 3 },
                },
              })}\n\n`,
            ].join(""),
            { status: 200 },
          );
        }

        assert.ok(body.input?.some((item) => item.type === "function_call" && item.call_id === "call_resume_1"));
        assert.ok(body.input?.some((item) => item.type === "function_call_output" && item.call_id === "call_resume_1"));
        assert.ok(body.input?.some((item) => item.role === "user" && item.content === "Second turn"));
        return new Response(
          [
            `event: response.created\ndata: ${JSON.stringify({
              response: { id: "resp_resume_3", model: "gpt-5.4" },
            })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              delta: "second turn ok",
            })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({
              response: {
                id: "resp_resume_3",
                model: "gpt-5.4",
                usage: { input_tokens: 8, output_tokens: 4 },
              },
            })}\n\n`,
          ].join(""),
          { status: 200 },
        );
      }, async () => {
        const first = await collectMessages(client.query("Do ls", { permissionMode: "bypassPermissions" }));
        const second = await collectMessages(client.query("Second turn", { permissionMode: "bypassPermissions" }));
        assert.equal(findResult(first)?.result, "done with ls");
        assert.equal(findResult(second)?.result, "second turn ok");
      });
    });
  } finally {
    if (previousPinocchioHome === undefined) {
      delete process.env.PINOCCHIO_HOME;
    } else {
      process.env.PINOCCHIO_HOME = previousPinocchioHome;
    }

    await removeOpenAISubscriptionAuth();
    await rm(authHome, { recursive: true, force: true });
  }
}

async function runOpenAISubscriptionSessionResumeAfterAbortedPermissionTest(): Promise<void> {
  const previousPinocchioHome = process.env.PINOCCHIO_HOME;
  const authHome = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-openai-subscription-abort-home-"));

  try {
    process.env.PINOCCHIO_HOME = path.join(authHome, ".agents");
    await saveOpenAISubscriptionAuth({
      type: "oauth",
      access: "abort-access",
      refresh: "abort-refresh",
      expires: Date.now() + 60_000,
      accountId: "acct_123",
    });

    await withWorkspace("openai-subscription-resume-abort", async (workspace) => {
      await writeFile(
        path.join(workspace, ".agents", "config.json"),
        JSON.stringify(
          {
            name: "OpenAI Subscription Abort Resume Test",
            model: "gpt-5.4",
            max_tokens: 512,
            system_prompt: "Be concise and use tools when helpful.",
            provider: {
              base_url: "https://api.openai.com/v1/responses",
              protocol: "openai-subscription",
            },
          },
          null,
          2,
        ),
      );

      let callCount = 0;
      const client = new PinocchioSDKClient({ cwd: workspace });

      await withMockedFetch(async (input, init) => {
        callCount += 1;
        assert.equal(String(input), "https://chatgpt.com/backend-api/codex/responses");
        const body = JSON.parse(String(init?.body)) as { input?: Array<Record<string, unknown>> };

        if (callCount === 1) {
          assert.equal(body.input?.length, 1);
          return new Response(
            [
              `event: response.created\ndata: ${JSON.stringify({
                response: { id: "resp_abort_resume_1", model: "gpt-5.4" },
              })}\n\n`,
              `event: response.output_item.done\ndata: ${JSON.stringify({
                item: {
                  id: "fc_abort_resume_1",
                  type: "function_call",
                  call_id: "call_abort_resume_1",
                  name: "Bash",
                  arguments: "{\"command\":\"ls\"}",
                },
              })}\n\n`,
              `event: response.completed\ndata: ${JSON.stringify({
                response: {
                  id: "resp_abort_resume_1",
                  model: "gpt-5.4",
                  usage: { input_tokens: 4, output_tokens: 2 },
                },
              })}\n\n`,
            ].join(""),
            { status: 200 },
          );
        }

        assert.ok(body.input?.some((item) => item.type === "function_call" && item.call_id === "call_abort_resume_1"));
        assert.ok(body.input?.some((item) => item.type === "function_call_output" && item.call_id === "call_abort_resume_1"));
        const abortOutput = body.input?.find((item) => item.type === "function_call_output" && item.call_id === "call_abort_resume_1");
        assert.match(String(abortOutput?.output ?? ""), /abort/i);
        assert.ok(body.input?.some((item) => item.role === "user" && item.content === "Second turn"));

        return new Response(
          [
            `event: response.created\ndata: ${JSON.stringify({
              response: { id: "resp_abort_resume_2", model: "gpt-5.4" },
            })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              delta: "second turn ok after abort",
            })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({
              response: {
                id: "resp_abort_resume_2",
                model: "gpt-5.4",
                usage: { input_tokens: 8, output_tokens: 4 },
              },
            })}\n\n`,
          ].join(""),
          { status: 200 },
        );
      }, async () => {
        const first = await collectMessages(client.query("Do ls", {
          permissionMode: "default",
          onUserQuestion: () => "abort",
        }));
        const second = await collectMessages(client.query("Second turn", {
          permissionMode: "default",
          onUserQuestion: () => "deny",
        }));

        assert.equal(findResult(first)?.subtype, "aborted_by_user");
        assert.equal(findToolResults(first).length, 1);
        assert.equal(findToolResults(first)[0]?.tool_name, "Bash");
        assert.match(String(findToolResults(first)[0]?.content ?? ""), /abort/i);
        assert.equal(findResult(second)?.result, "second turn ok after abort");
      });
    });
  } finally {
    if (previousPinocchioHome === undefined) {
      delete process.env.PINOCCHIO_HOME;
    } else {
      process.env.PINOCCHIO_HOME = previousPinocchioHome;
    }

    await removeOpenAISubscriptionAuth();
    await rm(authHome, { recursive: true, force: true });
  }
}

async function runPermissionsHooksAndStructuredOutputTest(): Promise<void> {
  process.env.TEST_ANTHROPIC_KEY = "test-key";

  await withWorkspace("permissions", async (workspace) => {
    let callCount = 0;

    await withMockedFetch(async (_input, init) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages?: Array<Record<string, unknown>> };

      if (callCount === 1) {
        return anthropicToolResponse("msg_hook_tool", "shout", { text: "hello" });
      }

      if (callCount === 2) {
        const toolResultContent = (((body.messages?.at(-1) as { content?: Array<{ content?: string }> } | undefined)?.content?.[0]) as { content?: string } | undefined)?.content;
        assert.equal(toolResultContent, "HOOKED");
        return anthropicToolResponse("msg_denied_bash", "Bash", { command: "rm -rf /tmp/demo" });
      }

      if (callCount === 3) {
        const deniedContent = (((body.messages?.at(-1) as { content?: Array<{ content?: string }> } | undefined)?.content?.[0]) as { content?: string } | undefined)?.content;
        assert.match(deniedContent ?? "", /Permission denied/);
        return anthropicTextResponse("msg_json_bad", "not json");
      }

      assert.match(JSON.stringify(body.messages), /Return only valid JSON matching the requested schema/);
      return anthropicTextResponse("msg_json_good", "{\"status\":\"done\"}");
    }, async () => {
      const messages = await collectMessages(
        query("Test hooks, permissions, and structured output", {
          cwd: workspace,
          outputFormat: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                status: { type: "string" },
              },
              required: ["status"],
            },
          },
          hooks: {
            PreToolUse: [
              {
                matcher: "^shout$",
                hooks: [
                  async () => ({
                    decision: "approve",
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "allow",
                      updatedInput: { text: "hooked" },
                    },
                  }),
                ],
              },
            ],
          },
          canUseTool: (toolName) => {
            if (toolName === "Bash") {
              return { behavior: "deny", message: "Permission denied for Bash" };
            }
          },
        }),
      );

      const result = findResult(messages);
      const toolProgress = findToolProgress(messages);
      assert.equal(result?.subtype, "success");
      assert.deepEqual(result?.structured_output, { status: "done" });
      assert.equal(result?.permission_denials.length, 1);
      assert.equal(result?.permission_denials[0]?.tool_name, "Bash");
      assert.equal(toolProgress.some((message) => message.tool_name === "Bash" && message.status === "running"), false);
      assert.deepEqual(findToolResults(messages).map((entry) => entry.tool_name), ["shout", "Bash"]);
      assert.equal(findToolResults(messages)[0]?.content, "HOOKED");
      assert.match(String(findToolResults(messages)[1]?.content ?? ""), /Permission denied for Bash/);
      assert.deepEqual(result?.tool_results?.map((entry) => entry.tool_name), ["shout", "Bash"]);
      assert.equal(result?.tool_results?.[0]?.content, "HOOKED");
      assert.match(String(result?.tool_results?.[1]?.content ?? ""), /Permission denied for Bash/);
      assert.ok(messages.some((message) => message.type === "system" && message.subtype === "hook_started"));
    });
  });
}

async function runBashStreamingAndTimeoutTest(): Promise<void> {
  process.env.TEST_ANTHROPIC_KEY = "test-key";
  const realBashToolPath = path.resolve(process.cwd(), ".agents", "tools", "bash.ts");

  await withWorkspace("bash-streaming-timeout", async (workspace) => {
    await writeFile(
      path.join(workspace, ".agents", "tools", "tools.json"),
      JSON.stringify(
        {
          tools: [
            {
              name: "Read",
              enabled: true,
              description: "Read a file from the project.",
              input_schema: {
                type: "object",
                properties: {
                  file_path: { type: "string" },
                },
                required: ["file_path"],
              },
              source: "./read.ts",
            },
            {
              name: "Write",
              enabled: true,
              description: "Write full contents to a file.",
              input_schema: {
                type: "object",
                properties: {
                  file_path: { type: "string" },
                  content: { type: "string" },
                },
                required: ["file_path", "content"],
              },
              source: "./write.ts",
            },
            {
              name: "Bash",
              enabled: true,
              description: "Run a shell command.",
              input_schema: {
                type: "object",
                properties: {
                  command: { type: "string" },
                },
                required: ["command"],
              },
              source: realBashToolPath,
              timeout_ms: 40,
            },
            {
              name: "shout",
              enabled: true,
              description: "Return uppercase text.",
              input_schema: {
                type: "object",
                properties: {
                  text: { type: "string" },
                },
                required: ["text"],
              },
              source: "./shout.ts",
            },
            {
              name: "Delay",
              enabled: true,
              description: "Wait in small interruptible steps.",
              input_schema: {
                type: "object",
                properties: {
                  steps: { type: "number" },
                  delay_ms: { type: "number" },
                },
              },
              source: "./delay.ts",
            },
          ],
        },
        null,
        2,
      ),
    );

    let callCount = 0;
    await withMockedFetch(async (_input, init) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages?: Array<Record<string, unknown>> };

      if (callCount === 1) {
        return anthropicToolResponse(
          "msg_streaming_bash",
          "Bash",
          {
            command: "printf 'booting\\n'; printf 'still working\\n' >&2; sleep 0.2",
          },
        );
      }

      const lastToolResult = (((body.messages?.at(-1) as { content?: Array<{ content?: string }> } | undefined)?.content?.[0]) as { content?: string } | undefined)?.content;
      assert.match(lastToolResult ?? "", /timed out/i);
      return anthropicTextResponse("msg_streaming_bash_done", "handled bash timeout");
    }, async () => {
      const messages = await collectMessages(
        query("Run the long bash command.", {
          cwd: workspace,
          permissionMode: "bypassPermissions",
        }),
      );

      const progressMessages = findToolProgress(messages).filter((message) => message.tool_name === "Bash");
      assert.ok(progressMessages.some((message) => message.status === "running" && message.output?.includes("booting") && message.stream === "stdout"));
      assert.ok(progressMessages.some((message) => message.status === "running" && message.output?.includes("still working") && message.stream === "stderr"));
      assert.ok(progressMessages.some((message) => message.status === "running" && typeof message.elapsed_ms === "number" && message.elapsed_ms >= 0));
      assert.ok(progressMessages.some((message) => message.status === "running" && message.timeout_ms === 40));

      const toolResult = findToolResults(messages).find((message) => message.tool_name === "Bash");
      assert.ok(toolResult);
      assert.match(String(toolResult?.content ?? ""), /timed out/i);
      assert.equal(findResult(messages)?.result, "handled bash timeout");
    });
  });
}

async function runBashWrapperNormalizationTest(): Promise<void> {
  process.env.TEST_ANTHROPIC_KEY = "test-key";
  const realBashToolPath = path.resolve(process.cwd(), ".agents", "tools", "bash.ts");

  await withWorkspace("bash-wrapper-normalization", async (workspace) => {
    await writeFile(
      path.join(workspace, ".agents", "tools", "tools.json"),
      JSON.stringify(
        {
          tools: [
            {
              name: "Bash",
              enabled: true,
              description: "Run a shell command.",
              input_schema: {
                type: "object",
                properties: {
                  command: { type: "string" },
                },
                required: ["command"],
              },
              source: realBashToolPath,
              timeout_ms: 30_000,
            },
          ],
        },
        null,
        2,
      ),
    );

    let callCount = 0;
    await withMockedFetch(async (_input, init) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages?: Array<Record<string, unknown>> };

      if (callCount === 1) {
        return anthropicToolResponse(
          "msg_wrapped_bash",
          "Bash",
          {
            command: "timeout 3m bash -lc 'printf \"Random command running\\n\"; printf \"Done\\n\"'",
          },
        );
      }

      const lastToolResult = (((body.messages?.at(-1) as { content?: Array<{ content?: string }> } | undefined)?.content?.[0]) as { content?: string } | undefined)?.content;
      assert.match(lastToolResult ?? "", /Random command running/);
      assert.doesNotMatch(lastToolResult ?? "", /command not found/i);
      return anthropicTextResponse("msg_wrapped_bash_done", "wrapped bash handled");
    }, async () => {
      const messages = await collectMessages(
        query("Run the wrapped bash command.", {
          cwd: workspace,
          permissionMode: "bypassPermissions",
        }),
      );

      const progressMessages = findToolProgress(messages).filter((message) => message.tool_name === "Bash");
      assert.ok(progressMessages.some((message) => message.status === "running" && message.timeout_ms === 180_000));

      const toolResult = findToolResults(messages).find((message) => message.tool_name === "Bash");
      assert.ok(toolResult);
      assert.match(String(toolResult?.content ?? ""), /Random command running/);
      assert.match(String(toolResult?.content ?? ""), /Done/);
      assert.doesNotMatch(String(toolResult?.content ?? ""), /command not found/i);
      assert.equal(findResult(messages)?.result, "wrapped bash handled");
    });
  });
}

async function runMcpOverrideAndCheckpointTest(): Promise<void> {
  process.env.TEST_ANTHROPIC_KEY = "test-key";

  await withWorkspace("mcp", async (workspace) => {
    const weatherServer = createSdkMcpServer({
      name: "weather",
      tools: [
        tool("get_weather", {
          description: "Get the weather for a city.",
          inputSchema: z.object({
            city: z.string(),
          }),
          run: ({ city }) => ({
            content: [{ type: "text", text: `Weather for ${city}` }],
          }),
        }),
      ],
    });

    let callCount = 0;
    await withMockedFetch(async (_input, init) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> };
      if (callCount === 1) {
        const toolNames = (body.tools ?? []).map((item) => String((item as { name?: string }).name ?? ""));
        assert.ok(toolNames.includes("get_weather"));
        assert.ok(toolNames.includes("Read"));
        assert.ok(!toolNames.includes("Agent"));
        return anthropicToolResponse("msg_mcp", "get_weather", { city: "Pune" });
      }

      const toolResult = (((body.messages?.at(-1) as { content?: Array<{ content?: unknown }> } | undefined)?.content?.[0]) as { content?: unknown } | undefined)?.content;
      assert.deepEqual(toolResult, [{ type: "text", text: "Weather for Pune" }]);
      return anthropicToolResponse("msg_write", "Write", {
        file_path: "notes.txt",
        content: "created by checkpoint test",
      });
    }, async () => {
      const stream = await query("Check weather and then write a note", {
        cwd: workspace,
        permissionMode: "acceptEdits",
        mcpServers: {
          weather: weatherServer,
        },
      });

      const seen: SDKMessage[] = [];
      for await (const message of stream) {
        seen.push(message);
        if (message.type === "assistant" && message.message.stop_reason === "tool_use" && message.message.content.some((block) => block.type === "tool_use" && block.name === "Write")) {
          globalThis.fetch = (async (_input, init) => {
            const body = JSON.parse(String(init?.body)) as { messages?: Array<Record<string, unknown>> };
            const toolResult = (((body.messages?.at(-1) as { content?: Array<{ content?: unknown }> } | undefined)?.content?.[0]) as { content?: unknown } | undefined)?.content;
            assert.equal(toolResult, `Wrote ${path.join(workspace, "notes.txt")}`);
            return anthropicTextResponse("msg_done", "all done");
          }) as typeof fetch;
        }
      }

      const notesPath = path.join(workspace, "notes.txt");
      assert.equal(await readFile(notesPath, "utf-8"), "created by checkpoint test");
      const rewind = await stream.rewindFiles();
      assert.equal(rewind.canRewind, true);
      const exists = await stat(notesPath).catch(() => null);
      assert.equal(exists, null);
      assert.equal(findResult(seen)?.result, "all done");
      assert.deepEqual(findToolResults(seen).map((entry) => entry.tool_name), ["get_weather", "Write"]);
      assert.deepEqual(findResult(seen)?.tool_results?.map((entry) => entry.tool_name), ["get_weather", "Write"]);
    });
  });
}

async function runSteeringTest(): Promise<void> {
  process.env.TEST_ANTHROPIC_KEY = "test-key";

  await withWorkspace("steering", async (workspace) => {
    let callCount = 0;

    await withMockedFetch(async (_input, init) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: unknown }> };

      if (callCount === 1) {
        assert.equal(body.messages?.length, 1);
        return anthropicToolResponse("msg_steer_delay", "Delay", { steps: 50, delay_ms: 5 });
      }

      assert.equal(body.messages?.length, 2);
      assert.equal(body.messages?.[0]?.role, "user");
      assert.equal(body.messages?.[1]?.role, "user");
      assert.equal(body.messages?.[1]?.content, "Stop delaying and summarize the plan instead.");
      return anthropicTextResponse("msg_steer_done", "steered successfully");
    }, async () => {
      const stream = await query("Start a long operation.", { cwd: workspace });
      const messages: SDKMessage[] = [];
      let steered = false;

      for await (const message of stream) {
        messages.push(message);
        if (
          !steered &&
          message.type === "system" &&
          message.subtype === "tool_progress" &&
          message.tool_name === "Delay" &&
          message.status === "running"
        ) {
          steered = true;
          await stream.steer("Stop delaying and summarize the plan instead.");
        }
      }

      assert.equal(steered, true);
      assert.equal(findResult(messages)?.subtype, "success");
      assert.equal(findResult(messages)?.result, "steered successfully");
      assert.equal(callCount, 2);
      assert.ok(messages.some((message) => message.type === "user" && message.message.content === "Start a long operation."));
      assert.ok(messages.some((message) => message.type === "user" && message.message.content === "Stop delaying and summarize the plan instead."));
    });
  });
}

async function runStopTaskAbortTest(): Promise<void> {
  process.env.TEST_ANTHROPIC_KEY = "test-key";

  await withWorkspace("stop-task", async (workspace) => {
    await withMockedFetch(async () => {
      return anthropicToolResponse("msg_stop_delay", "Delay", { steps: 50, delay_ms: 5 });
    }, async () => {
      const stream = await query("Start a cancellable operation.", { cwd: workspace });
      const messages: SDKMessage[] = [];
      let stopped = false;

      for await (const message of stream) {
        messages.push(message);
        if (
          !stopped &&
          message.type === "system" &&
          message.subtype === "tool_progress" &&
          message.tool_name === "Delay" &&
          message.status === "running"
        ) {
          stopped = true;
          await stream.stopTask("active");
        }
      }

      const result = findResult(messages);
      assert.equal(stopped, true);
      assert.equal(result?.subtype, "aborted_by_user");
      assert.equal(result?.is_error, false);
      assert.equal(result?.stop_reason, "abort");
    });
  });
}

async function runOpenAISubscriptionSessionResumeAfterStoppedToolTest(): Promise<void> {
  const previousPinocchioHome = process.env.PINOCCHIO_HOME;
  const authHome = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-openai-subscription-stop-home-"));

  try {
    process.env.PINOCCHIO_HOME = path.join(authHome, ".agents");
    await saveOpenAISubscriptionAuth({
      type: "oauth",
      access: "stop-access",
      refresh: "stop-refresh",
      expires: Date.now() + 60_000,
      accountId: "acct_stop",
    });

    await withWorkspace("openai-subscription-resume-stop", async (workspace) => {
      await writeFile(
        path.join(workspace, ".agents", "config.json"),
        JSON.stringify(
          {
            name: "OpenAI Subscription Stop Resume Test",
            model: "gpt-5.4-mini",
            max_tokens: 512,
            system_prompt: "Be concise and use tools when helpful.",
            provider: {
              base_url: "https://api.openai.com/v1/responses",
              protocol: "openai-subscription",
            },
          },
          null,
          2,
        ),
      );

      let callCount = 0;
      const client = new PinocchioSDKClient({ cwd: workspace });

      await withMockedFetch(async (input, init) => {
        callCount += 1;
        assert.equal(String(input), "https://chatgpt.com/backend-api/codex/responses");
        const body = JSON.parse(String(init?.body)) as { input?: Array<Record<string, unknown>> };

        if (callCount === 1) {
          assert.equal(body.input?.length, 1);
          return new Response(
            [
              `event: response.created\ndata: ${JSON.stringify({
                response: { id: "resp_stop_resume_1", model: "gpt-5.4-mini" },
              })}\n\n`,
              `event: response.output_item.done\ndata: ${JSON.stringify({
                item: {
                  id: "fc_stop_resume_1",
                  type: "function_call",
                  call_id: "call_stop_resume_1",
                  name: "Delay",
                  arguments: "{\"steps\":50,\"delay_ms\":5}",
                },
              })}\n\n`,
              `event: response.completed\ndata: ${JSON.stringify({
                response: {
                  id: "resp_stop_resume_1",
                  model: "gpt-5.4-mini",
                  usage: { input_tokens: 4, output_tokens: 2 },
                },
              })}\n\n`,
            ].join(""),
            { status: 200 },
          );
        }

        assert.ok(body.input?.some((item) => item.type === "function_call" && item.call_id === "call_stop_resume_1"));
        assert.ok(body.input?.some((item) => item.type === "function_call_output" && item.call_id === "call_stop_resume_1"));
        const stopOutput = body.input?.find((item) => item.type === "function_call_output" && item.call_id === "call_stop_resume_1");
        assert.match(String(stopOutput?.output ?? ""), /(interrupt|abort)/i);
        assert.ok(body.input?.some((item) => item.role === "user" && item.content === "Second turn"));

        return new Response(
          [
            `event: response.created\ndata: ${JSON.stringify({
              response: { id: "resp_stop_resume_2", model: "gpt-5.4-mini" },
            })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              delta: "second turn ok after stop",
            })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({
              response: {
                id: "resp_stop_resume_2",
                model: "gpt-5.4-mini",
                usage: { input_tokens: 8, output_tokens: 4 },
              },
            })}\n\n`,
          ].join(""),
          { status: 200 },
        );
      }, async () => {
        const firstRun = await client.query("Start a cancellable operation.", {
          permissionMode: "bypassPermissions",
        });
        const firstMessages: SDKMessage[] = [];
        let stopped = false;

        for await (const message of firstRun) {
          firstMessages.push(message);
          if (
            !stopped &&
            message.type === "system" &&
            message.subtype === "tool_progress" &&
            message.tool_name === "Delay" &&
            message.status === "running"
          ) {
            stopped = true;
            await firstRun.stopTask("active");
          }
        }

        const second = await collectMessages(client.query("Second turn", {
          permissionMode: "bypassPermissions",
        }));

        assert.equal(stopped, true);
        assert.equal(findResult(firstMessages)?.subtype, "aborted_by_user");
        assert.equal(findResult(second)?.result, "second turn ok after stop");
      });
    });
  } finally {
    if (previousPinocchioHome === undefined) {
      delete process.env.PINOCCHIO_HOME;
    } else {
      process.env.PINOCCHIO_HOME = previousPinocchioHome;
    }

    await removeOpenAISubscriptionAuth();
    await rm(authHome, { recursive: true, force: true });
  }
}

async function runOpenAISubscriptionSessionResumeAfterAbortingFirstParallelToolTest(): Promise<void> {
  const previousPinocchioHome = process.env.PINOCCHIO_HOME;
  const authHome = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-openai-subscription-parallel-abort-home-"));

  try {
    process.env.PINOCCHIO_HOME = path.join(authHome, ".agents");
    await saveOpenAISubscriptionAuth({
      type: "oauth",
      access: "parallel-abort-access",
      refresh: "parallel-abort-refresh",
      expires: Date.now() + 60_000,
      accountId: "acct_parallel_abort",
    });

    await withWorkspace("openai-subscription-resume-parallel-abort", async (workspace) => {
      await writeFile(
        path.join(workspace, ".agents", "config.json"),
        JSON.stringify(
          {
            name: "OpenAI Subscription Parallel Abort Resume Test",
            model: "gpt-5.4-mini",
            max_tokens: 512,
            system_prompt: "Be concise and use tools when helpful.",
            provider: {
              base_url: "https://api.openai.com/v1/responses",
              protocol: "openai-subscription",
            },
          },
          null,
          2,
        ),
      );

      let callCount = 0;
      const client = new PinocchioSDKClient({ cwd: workspace });

      await withMockedFetch(async (input, init) => {
        callCount += 1;
        assert.equal(String(input), "https://chatgpt.com/backend-api/codex/responses");
        const body = JSON.parse(String(init?.body)) as { input?: Array<Record<string, unknown>> };

        if (callCount === 1) {
          assert.equal(body.input?.length, 1);
          return new Response(
            [
              `event: response.created\ndata: ${JSON.stringify({
                response: { id: "resp_parallel_abort_1", model: "gpt-5.4-mini" },
              })}\n\n`,
              `event: response.output_item.done\ndata: ${JSON.stringify({
                item: {
                  id: "fc_parallel_abort_1",
                  type: "function_call",
                  call_id: "call_parallel_abort_bash",
                  name: "Bash",
                  arguments: "{\"command\":\"pwd\"}",
                },
              })}\n\n`,
              `event: response.output_item.done\ndata: ${JSON.stringify({
                item: {
                  id: "fc_parallel_abort_2",
                  type: "function_call",
                  call_id: "call_parallel_abort_todo",
                  name: "TodoWrite",
                  arguments: "{\"todos\":[{\"content\":\"Inspect files\",\"status\":\"pending\",\"priority\":\"high\"}]}",
                },
              })}\n\n`,
              `event: response.completed\ndata: ${JSON.stringify({
                response: {
                  id: "resp_parallel_abort_1",
                  model: "gpt-5.4-mini",
                  usage: { input_tokens: 4, output_tokens: 2 },
                },
              })}\n\n`,
            ].join(""),
            { status: 200 },
          );
        }

        assert.ok(body.input?.some((item) => item.type === "function_call" && item.call_id === "call_parallel_abort_bash"));
        assert.ok(body.input?.some((item) => item.type === "function_call_output" && item.call_id === "call_parallel_abort_bash"));
        assert.ok(body.input?.some((item) => item.type === "function_call" && item.call_id === "call_parallel_abort_todo"));
        assert.ok(body.input?.some((item) => item.type === "function_call_output" && item.call_id === "call_parallel_abort_todo"));
        const todoOutput = body.input?.find((item) => item.type === "function_call_output" && item.call_id === "call_parallel_abort_todo");
        assert.match(String(todoOutput?.output ?? ""), /abort/i);
        assert.ok(body.input?.some((item) => item.role === "user" && item.content === "Second turn"));

        return new Response(
          [
            `event: response.created\ndata: ${JSON.stringify({
              response: { id: "resp_parallel_abort_2", model: "gpt-5.4-mini" },
            })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              delta: "second turn ok after parallel abort",
            })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({
              response: {
                id: "resp_parallel_abort_2",
                model: "gpt-5.4-mini",
                usage: { input_tokens: 8, output_tokens: 4 },
              },
            })}\n\n`,
          ].join(""),
          { status: 200 },
        );
      }, async () => {
        const first = await collectMessages(client.query("Create a site.", {
          permissionMode: "default",
          onUserQuestion: () => "abort",
        }));
        const second = await collectMessages(client.query("Second turn", {
          permissionMode: "default",
          onUserQuestion: () => "deny",
        }));

        assert.equal(findResult(first)?.subtype, "aborted_by_user");
        assert.equal(findResult(second)?.result, "second turn ok after parallel abort");
      });
    });
  } finally {
    if (previousPinocchioHome === undefined) {
      delete process.env.PINOCCHIO_HOME;
    } else {
      process.env.PINOCCHIO_HOME = previousPinocchioHome;
    }

    await removeOpenAISubscriptionAuth();
    await rm(authHome, { recursive: true, force: true });
  }
}

const previousPinocchioHome = process.env.PINOCCHIO_HOME;
const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "pinocchio-v0-test-home-"));

try {
  process.env.PINOCCHIO_HOME = path.join(isolatedHome, ".agents");
  await runOpenAISubscriptionAuthTest();
  await runOpenAISubscriptionRuntimeConfigTest();
  await runRuntimeConfigToggleTest();
  await runModeRuntimeTest();
  await runModePersistenceTest();
  await runProjectRuntimeInitTest();
  await runOpenAISubscriptionModelsTest();
  await runOpenAISubscriptionUsageTest();
  await runOpenAISubscriptionTransportTest();
  await runAnthropicThinkingBlockTest();
  await runQuickstartAndFilesystemTest();
  await runRuntimeDiscoveryTest();
  await runSessionLifecycleTest();
  await runOpenAISubscriptionSessionResumeWithToolResultsTest();
  await runOpenAISubscriptionSessionResumeAfterAbortedPermissionTest();
  await runPermissionsHooksAndStructuredOutputTest();
  await runBashStreamingAndTimeoutTest();
  await runBashWrapperNormalizationTest();
  await runMcpOverrideAndCheckpointTest();
  await runSteeringTest();
  await runStopTaskAbortTest();
  await runOpenAISubscriptionSessionResumeAfterStoppedToolTest();
  await runOpenAISubscriptionSessionResumeAfterAbortingFirstParallelToolTest();
  console.log("Pinocchio v0 SDK tests passed.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (previousPinocchioHome === undefined) {
    delete process.env.PINOCCHIO_HOME;
  } else {
    process.env.PINOCCHIO_HOME = previousPinocchioHome;
  }

  await rm(isolatedHome, { recursive: true, force: true });
}
