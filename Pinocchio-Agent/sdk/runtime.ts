import { execFile } from "child_process";
import { EventEmitter } from "events";
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import * as path from "path";
import { pathToFileURL } from "url";
import { promisify } from "util";

import { toJSONSchema, type ZodRawShape, type ZodTypeAny } from "zod";

import {
  getProjectRuntimeMode,
  loadProjectRuntime,
  type LoadedToolConfig,
  type PluginSummary,
  type RuntimeModeDefinition,
  type SkillSummary,
  type SlashCommandSummary,
} from "./filesystem.ts";
import { appendSessionMessage, getFirstPrompt, listStoredSessions, readSessionInfo, readSessionMessages, recordCheckpoint, renameStoredSession, rewindSessionFiles, tagStoredSession, upsertSessionInfo, writeSessionInfo } from "./sessions.ts";
import { runModelInference } from "./transport.ts";
import type {
  AgentDefinition,
  BetaMessage,
  CallToolResult,
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
  McpServerConfig,
  McpSetServersResult,
  Message,
  ModelUsage,
  Options,
  OutputFormat,
  PermissionMode,
  PermissionResult,
  Query,
  RewindFilesResult,
  SDKAssistantMessage,
  SDKFilesPersistedEvent,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKResultMessage,
  SDKSystemMessage,
  SDKToolResultMessage,
  SDKToolProgressMessage,
  SDKUserMessage,
  SdkMcpServer,
  SdkMcpToolDefinition,
  SessionInfo,
  SessionMessageRecord,
  TextBlock,
  ToolAnnotations,
  ToolResultBlock,
  ToolResultContent,
  ToolResultContentBlock,
  ToolUseBlock,
  Usage,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const PINOCCHIO_VERSION = "0.2.0";
const TERMINAL_RESPONSE_FORMAT_PROMPT = [
  "Response format:",
  "Write final assistant responses as plain terminal text, not Markdown.",
  "Do not use Markdown headings, tables, blockquotes, bold or italic markers, or fenced code blocks unless the user explicitly asks for Markdown or code.",
  "Use short paragraphs and simple plain-text lists when structure helps.",
].join("\n");

interface RuntimeProvider {
  api_key?: string;
  api_key_env?: string;
  base_url: string;
  protocol?: "anthropic" | "openai" | "openai-subscription" | "auto";
  version?: string;
  auth_header?: string;
  auth_prefix?: string;
  version_header?: string;
  headers?: Record<string, string>;
}

interface RuntimeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  source: "default" | "project" | "app" | "mcp";
  timeoutMs?: number;
  run: (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResultBlock>;
}

interface ToolExecutionContext {
  cwd: string;
  signal: AbortSignal;
  sessionId: string;
  options: ResolvedOptions;
  query: PinocchioQuery;
  state: QueryState;
  emitToolProgress: (update: {
    status?: "running" | "completed";
    elapsedMs?: number;
    timeoutMs?: number;
    output?: string;
    stream?: "stdout" | "stderr";
  }) => Promise<void>;
}

interface QueryState {
  todos: Array<Record<string, unknown>>;
  toolCounts: Map<string, number>;
  usage: Usage;
  modelUsage: Map<string, ModelUsage>;
  permissionDenials: SDKPermissionDenial[];
  filesPersisted: Set<string>;
  toolResults: NonNullable<SDKResultMessage["tool_results"]>;
}

type InputPriority = "normal" | "high";

interface ResolvedOptions {
  activeMode: RuntimeModeDefinition | null;
  cwd: string;
  runtimeDir: string;
  model: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  maxTokens: number;
  systemPrompt: string;
  provider: RuntimeProvider;
  permissionMode: PermissionMode;
  canUseTool?: CanUseTool;
  allowedTools: string[];
  disallowedTools: string[];
  includePartialMessages: boolean;
  persistSession: boolean;
  enableFileCheckpointing: boolean;
  maxTurns: number;
  outputFormat?: OutputFormat;
  onUserQuestion?: Options["onUserQuestion"];
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  slashCommands: SlashCommandSummary[];
  skills: SkillSummary[];
  plugins: PluginSummary[];
  agents: Record<string, AgentDefinition>;
  mcpServers: Record<string, McpServerConfig>;
  tools: RuntimeTool[];
  promptSuggestions: boolean;
  permissionPromptToolName?: string;
  debug?: boolean;
}

function filterSkillsForMode(skills: SkillSummary[], mode: RuntimeModeDefinition | null): SkillSummary[] {
  if (!mode) {
    return skills;
  }

  let filtered = skills;
  if (mode.skills.allow.length > 0) {
    const allowed = new Set(mode.skills.allow);
    filtered = filtered.filter((skill) => allowed.has(skill.id));
  }

  if (mode.skills.deny.length > 0) {
    const denied = new Set(mode.skills.deny);
    filtered = filtered.filter((skill) => !denied.has(skill.id));
  }

  return filtered;
}

function resolveModeAllowedTools(mode: RuntimeModeDefinition | null, optionAllowedTools: string[]): string[] {
  if (!mode || mode.tools.allow.length === 0) {
    return optionAllowedTools;
  }

  if (optionAllowedTools.length === 0) {
    return [...mode.tools.allow];
  }

  const allowed = new Set(mode.tools.allow);
  return optionAllowedTools.filter((toolName) => allowed.has(toolName));
}

function resolveModeDisallowedTools(mode: RuntimeModeDefinition | null, optionDisallowedTools: string[]): string[] {
  const disallowed = new Set(optionDisallowedTools);

  for (const toolName of mode?.tools.deny ?? []) {
    disallowed.add(toolName);
  }

  if (mode && (mode.paths.allow.length > 0 || mode.paths.deny.length > 0)) {
    disallowed.add("Bash");
  }

  return [...disallowed];
}

function collectModeInputPaths(value: unknown, parentKey = ""): string[] {
  if (typeof value === "string") {
    if (!parentKey) {
      return [];
    }

    const normalizedKey = parentKey.toLowerCase();
    const looksLikePathKey =
      normalizedKey === "path" ||
      normalizedKey === "paths" ||
      normalizedKey === "file_path" ||
      normalizedKey.endsWith("_path") ||
      normalizedKey.endsWith("_paths") ||
      normalizedKey.endsWith("_dir") ||
      normalizedKey.endsWith("_directory") ||
      normalizedKey === "directory" ||
      normalizedKey === "dir" ||
      normalizedKey === "cwd";

    if (!looksLikePathKey || /^[a-z]+:\/\//i.test(value)) {
      return [];
    }

    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectModeInputPaths(entry, parentKey));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => collectModeInputPaths(entry, key));
}

function pathMatchesScope(rootPath: string, candidatePath: string): boolean {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedCandidate = path.resolve(candidatePath);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function validateModeToolInput(
  mode: RuntimeModeDefinition | null,
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (!mode) {
    return null;
  }

  const hasPathRules = mode.paths.allow.length > 0 || mode.paths.deny.length > 0;
  if (!hasPathRules) {
    return null;
  }

  if (toolName === "Bash") {
    return `Tool ${toolName} is not available when the active mode restricts paths.`;
  }

  const candidatePaths = collectModeInputPaths(input);
  if (candidatePaths.length === 0) {
    return null;
  }

  const allowedRoots = mode.paths.allow.map((entry) => path.resolve(cwd, entry));
  const deniedRoots = mode.paths.deny.map((entry) => path.resolve(cwd, entry));

  for (const candidate of candidatePaths) {
    const resolvedCandidate = path.resolve(cwd, candidate);
    if (deniedRoots.some((root) => pathMatchesScope(root, resolvedCandidate))) {
      return `Path "${candidate}" is outside the active mode paths.`;
    }

    if (allowedRoots.length > 0 && !allowedRoots.some((root) => pathMatchesScope(root, resolvedCandidate))) {
      return `Path "${candidate}" is outside the active mode paths.`;
    }
  }

  return null;
}

function defaultClaudeCodePrompt(): string {
  return [
    "You are Pinocchio, an autonomous coding agent with editable local tools.",
    "Use tools deliberately, explain your actions clearly, and keep the user in control.",
    "Prefer transparent, inspectable work over hidden side effects.",
  ].join("\n");
}

function normalizeToolResultContent(content: unknown): ToolResultContent {
  if (typeof content === "string") {
    return content || "(no output)";
  }

  if (Array.isArray(content)) {
    return content as ToolResultContentBlock[];
  }

  if (content && typeof content === "object" && "type" in content) {
    return [content as ToolResultContentBlock];
  }

  if (content === undefined || content === null) {
    return "(no output)";
  }

  return JSON.stringify(content, null, 2);
}

function toolResultContentToString(content: ToolResultContent): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) => {
      if (block && typeof block === "object" && "type" in block && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }

      return JSON.stringify(block);
    })
    .join("\n")
    .trim();
}

function extractTextFromBlocks(content: BetaMessage["content"]): string {
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function toApiTool(tool: RuntimeTool): { name: string; description: string; input_schema: Record<string, unknown> } {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  };
}

function createLinkedAbortController(signals: AbortSignal[]): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();

  if (signals.some((signal) => signal.aborted)) {
    controller.abort();
    return { controller, cleanup: () => undefined };
  }

  const listeners = signals.map((signal) => {
    const onAbort = () => {
      controller.abort();
    };

    signal.addEventListener("abort", onAbort, { once: true });
    return { signal, onAbort };
  });

  return {
    controller,
    cleanup: () => {
      for (const listener of listeners) {
        listener.signal.removeEventListener("abort", listener.onAbort);
      }
    },
  };
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError" ||
    error.message === "The operation was aborted" ||
    error.message === "The operation was aborted." ||
    error.message === "Prompt interrupted";
}

function isUserActionableSetupError(error: unknown): boolean {
  return error instanceof Error && error.message === "Run /connect to connect your ChatGPT subscription.";
}

function createToolResult(toolUseId: string, content: unknown, isError = false): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: normalizeToolResultContent(content),
    is_error: isError,
  };
}

async function emitToolProgressMessage(args: {
  emit: (message: SDKMessage) => Promise<void>;
  sessionId: string;
  toolName: string;
  toolUseId: string;
  status: "running" | "completed";
  elapsedMs?: number;
  timeoutMs?: number;
  output?: string;
  stream?: "stdout" | "stderr";
}): Promise<void> {
  const toolProgress: SDKToolProgressMessage = {
    type: "system",
    subtype: "tool_progress",
    uuid: uuid(),
    session_id: args.sessionId,
    tool_name: args.toolName,
    tool_use_id: args.toolUseId,
    status: args.status,
    elapsed_ms: args.elapsedMs,
    timeout_ms: args.timeoutMs,
    output: args.output,
    stream: args.stream,
  };
  await args.emit(toolProgress);
}

async function recordToolResult(args: {
  state: QueryState;
  emit: (message: SDKMessage) => Promise<void>;
  sessionId: string;
}, block: ToolUseBlock, result: ToolResultBlock): Promise<void> {
  args.state.toolResults.push({
    tool_name: block.name,
    tool_use_id: block.id,
    content: result.content,
    is_error: Boolean(result.is_error),
  });
  const toolResultMessage: SDKToolResultMessage = {
    type: "system",
    subtype: "tool_result",
    uuid: uuid(),
    session_id: args.sessionId,
    tool_name: block.name,
    tool_use_id: block.id,
    content: result.content,
    is_error: Boolean(result.is_error),
  };
  await args.emit(toolResultMessage);
  await emitToolProgressMessage({
    emit: args.emit,
    sessionId: args.sessionId,
    toolName: block.name,
    toolUseId: block.id,
    status: "completed",
  });
}

function toCallToolResult(value: unknown): CallToolResult {
  if (
    value &&
    typeof value === "object" &&
    "content" in value &&
    Array.isArray((value as { content?: unknown }).content)
  ) {
    return value as CallToolResult;
  }

  return {
    content:
      typeof value === "string"
        ? [{ type: "text", text: value }]
        : Array.isArray(value)
          ? (value as ToolResultContentBlock[])
          : [{ type: "text", text: JSON.stringify(value ?? "(no output)", null, 2) }],
  };
}

function matchesHook(toolNameOrPrompt: string, matcher?: string): boolean {
  if (!matcher) {
    return true;
  }

  try {
    return new RegExp(matcher).test(toolNameOrPrompt);
  } catch {
    return toolNameOrPrompt.includes(matcher);
  }
}

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function readGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function inferApiKeySource(provider: RuntimeProvider): "direct" | "env" | "none" {
  if (provider.api_key) {
    return "direct";
  }

  if (provider.api_key_env && process.env[provider.api_key_env]) {
    return "env";
  }

  return "none";
}

function uuid(): string {
  return crypto.randomUUID();
}

function buildSystemPrompt(
  options: ResolvedOptions,
  selectedTools: RuntimeTool[],
): string {
  const modeSection = options.activeMode
    ? [`Active mode: ${options.activeMode.name} (${options.activeMode.id})`, options.activeMode.description].join("\n")
    : "";
  const skillsSection =
    options.skills.length === 0
      ? ""
      : [
          "Available skills from .agents/skills:",
          ...options.skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`),
        ].join("\n");

  const commandsSection =
    options.slashCommands.length === 0
      ? ""
      : [
          "Available slash commands from .agents/commands:",
          ...options.slashCommands.map((command) => `- /${command.name}: ${command.description}`),
        ].join("\n");

  const agentsSection =
    Object.keys(options.agents).length === 0
      ? ""
      : [
          "Available subagents from .agents/agents:",
          ...Object.entries(options.agents).map(([name, agent]) => `- ${name}: ${agent.description}`),
        ].join("\n");

  const toolsSection = [
    "Available tools:",
    ...selectedTools.map((tool) => `- ${tool.name}: ${tool.description}`),
  ].join("\n");

  return [options.systemPrompt, TERMINAL_RESPONSE_FORMAT_PROMPT, modeSection, toolsSection, skillsSection, commandsSection, agentsSection]
    .filter(Boolean)
    .join("\n\n");
}

async function executeDiskTool(
  tool: LoadedToolConfig,
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolResultBlock> {
  if (!tool.sourcePath) {
    return createToolResult("missing", `Tool "${tool.name}" does not define a source file.`, true);
  }

  const moduleUrl = `${pathToFileURL(tool.sourcePath).href}?ts=${Date.now()}`;
  const mod = (await import(moduleUrl)) as {
    default?: (input: Record<string, unknown>, context: ToolExecutionContext & { tool?: LoadedToolConfig }) => Promise<unknown>;
    execute?: (input: Record<string, unknown>, context: ToolExecutionContext & { tool?: LoadedToolConfig }) => Promise<unknown>;
  };
  const handler = mod.default ?? mod.execute;
  if (typeof handler !== "function") {
    return createToolResult("missing", `Tool module for "${tool.name}" must export default or execute().`, true);
  }

  const result = await Promise.resolve(handler(input, { ...context, tool }));
  return createToolResult("pending", result, false);
}

function toolNeedsPermission(toolName: string): boolean {
  return ["Write", "Edit", "Bash", "Agent"].includes(toolName);
}

function autoPermissionForMode(mode: PermissionMode, toolName: string): PermissionResult {
  if (mode === "bypassPermissions") {
    return { behavior: "allow" };
  }

  if (!toolNeedsPermission(toolName)) {
    return { behavior: "allow" };
  }

  if (mode === "acceptEdits" && toolName !== "Bash") {
    return { behavior: "allow" };
  }

  return { behavior: "ask", message: `Permission required for ${toolName}` };
}

async function runHooks(
  eventName: HookEvent,
  options: ResolvedOptions,
  query: PinocchioQuery,
  input: HookInput,
  matchTarget: string,
): Promise<HookJSONOutput[]> {
  const hooks = options.hooks[eventName] ?? [];
  const responses: HookJSONOutput[] = [];

  for (const hookMatcher of hooks) {
    if (!matchesHook(matchTarget, hookMatcher.matcher)) {
      continue;
    }

    for (const hook of hookMatcher.hooks) {
      const started: SDKHookStartedMessage = {
        type: "system",
        subtype: "hook_started",
        uuid: uuid(),
        session_id: query.sessionId,
        hook_event_name: eventName,
      };
      await query.push(started);

      const response = await Promise.resolve(hook(input, undefined, { signal: query.controller.signal }));
      responses.push(response);
      const responseMessage: SDKHookResponseMessage = {
        type: "system",
        subtype: "hook_response",
        uuid: uuid(),
        session_id: query.sessionId,
        hook_event_name: eventName,
        decision: isAsyncHookOutput(response) ? undefined : response.decision,
        reason: isAsyncHookOutput(response) ? undefined : response.reason,
      };
      await query.push(responseMessage);
    }
  }

  return responses;
}

function isAsyncHookOutput(output: HookJSONOutput): output is Extract<HookJSONOutput, { async: true }> {
  return "async" in output && output.async === true;
}

function choosePermissionResult(results: HookJSONOutput[], fallback: PermissionResult): PermissionResult {
  let decision = fallback;
  for (const result of results) {
    if (isAsyncHookOutput(result)) {
      continue;
    }

    const hookOutput = result.hookSpecificOutput;
    if (hookOutput && "permissionDecision" in hookOutput && hookOutput.permissionDecision) {
      decision = {
        behavior:
          hookOutput.permissionDecision === "allow"
            ? "allow"
            : hookOutput.permissionDecision === "deny"
              ? "deny"
              : hookOutput.permissionDecision === "abort"
                ? "abort"
                : "ask",
        updatedInput: hookOutput.updatedInput,
        message: hookOutput.permissionDecisionReason ?? result.reason,
      };
    }
  }

  return decision;
}

function normalizePermissionResponse(response: PermissionResult | boolean | void, fallback: PermissionResult): PermissionResult {
  if (response === undefined) {
    return fallback;
  }

  if (typeof response === "boolean") {
    return response ? { behavior: "allow" } : { behavior: "deny" };
  }

  return response;
}

function applySlashCommand(prompt: string, commands: SlashCommandSummary[]): string {
  if (!prompt.startsWith("/")) {
    return prompt;
  }

  const [head, ...rest] = prompt.trim().split(/\s+/);
  if (!head) {
    return prompt;
  }
  const commandName = head.replace(/^\//, "");
  const command = commands.find((item) => item.name === commandName);
  if (!command) {
    return prompt;
  }

  const remainder = rest.join(" ").trim();
  const commandBody = command.prompt.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  return [commandBody, remainder].filter(Boolean).join("\n\n");
}

function buildRuntimeTools(
  loadedTools: LoadedToolConfig[],
  mcpServers: Record<string, McpServerConfig>,
): RuntimeTool[] {
  const registry = new Map<string, RuntimeTool>();

  const add = (tool: RuntimeTool): void => {
    registry.set(tool.name, tool);
  };

  for (const server of Object.values(mcpServers)) {
    if (server.type !== "sdk") {
      continue;
    }

    for (const tool of server.tools) {
      add({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        annotations: tool.annotations,
        source: "mcp",
        run: async (input) => {
          const result = await tool.handler(input, undefined);
          return createToolResult("pending", result.content, Boolean(result.isError));
        },
      });
    }
  }

  for (const tool of loadedTools) {
    if (!tool.enabled) {
      continue;
    }

      add({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        source: "project",
        timeoutMs: tool.timeout_ms,
        run: async (input, context) => {
          const result = await executeDiskTool(tool, input, context);
          return result;
        },
      });
  }

  return [...registry.values()];
}

function resolveSelectedTools(options: ResolvedOptions): RuntimeTool[] {
  let tools = options.tools;

  if (options.allowedTools.length > 0) {
    const allowed = new Set(options.allowedTools);
    tools = tools.filter((tool) => allowed.has(tool.name));
  }

  if (options.disallowedTools.length > 0) {
    const disallowed = new Set(options.disallowedTools);
    tools = tools.filter((tool) => !disallowed.has(tool.name));
  }

  return tools;
}

function mergeHooks(
  projectHooks: Partial<Record<string, HookCallbackMatcher[]>>,
  runtimeHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};

  for (const [key, value] of Object.entries(projectHooks)) {
    merged[key as HookEvent] = [...(value ?? [])];
  }

  for (const [key, value] of Object.entries(runtimeHooks ?? {})) {
    merged[key as HookEvent] = [...(merged[key as HookEvent] ?? []), ...(value ?? [])];
  }

  return merged;
}

async function resolveOptions(options: Options = {}): Promise<ResolvedOptions> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const loaded = await loadProjectRuntime(cwd, options.plugins);
  const activeMode = options.mode ? await getProjectRuntimeMode(cwd, options.mode) : null;
  if (options.mode && options.mode !== "default" && !activeMode) {
    throw new Error(`Mode "${options.mode}" was not found.`);
  }
  const providerBaseUrl = options.provider?.base_url ?? loaded.config.provider.base_url;
  if (!providerBaseUrl) {
    throw new Error("Provider base_url is not configured. Add provider.base_url to .agents/config.json or pass options.provider.base_url.");
  }

  const provider = {
    ...loaded.config.provider,
    ...(options.provider ?? {}),
    headers: {
      ...(loaded.config.provider.headers ?? {}),
      ...(options.provider?.headers ?? {}),
    },
    base_url: providerBaseUrl,
  } satisfies RuntimeProvider;

  const systemPrompt =
    typeof options.systemPrompt === "string"
      ? options.systemPrompt
      : options.systemPrompt?.type === "preset"
        ? [defaultClaudeCodePrompt(), options.systemPrompt.append].filter(Boolean).join("\n\n")
        : loaded.config.system_prompt || defaultClaudeCodePrompt();

  const runtimeTools = buildRuntimeTools(
    loaded.tools,
    {
      ...loaded.mcpServers,
      ...(options.mcpServers ?? {}),
    },
  );
  const allowedTools = resolveModeAllowedTools(activeMode, options.allowedTools ?? []);
  const disallowedTools = resolveModeDisallowedTools(activeMode, options.disallowedTools ?? []);
  const skills = filterSkillsForMode(loaded.skills, activeMode);

  const resolved: ResolvedOptions = {
    activeMode,
    cwd,
    runtimeDir: loaded.runtimeDir,
    model: options.model ?? loaded.config.model,
    effort: options.effort ?? loaded.config.effort,
    maxTokens: loaded.config.max_tokens,
    systemPrompt,
    provider,
     permissionMode: options.permissionMode ?? (options.allowDangerouslySkipPermissions ? "bypassPermissions" : "default"),
    canUseTool: options.canUseTool,
    allowedTools,
    disallowedTools,
    includePartialMessages: options.includePartialMessages ?? false,
    persistSession: options.persistSession !== false,
    enableFileCheckpointing: options.enableFileCheckpointing ?? true,
    maxTurns: options.maxTurns ?? 8,
    outputFormat: options.outputFormat,
    onUserQuestion: options.onUserQuestion,
    hooks: mergeHooks(loaded.hooks, options.hooks),
    slashCommands: loaded.slashCommands,
    skills,
    plugins: loaded.plugins,
    agents: {
      ...loaded.agents,
      ...(options.agents ?? {}),
    },
    mcpServers: {
      ...loaded.mcpServers,
      ...(options.mcpServers ?? {}),
    },
    tools: runtimeTools,
    promptSuggestions: options.promptSuggestions ?? false,
    permissionPromptToolName: options.permissionPromptToolName,
    debug: options.debug,
  };

  resolved.tools = resolveSelectedTools(resolved);
  return resolved;
}

async function persistMessage(
  query: PinocchioQuery,
  message: SDKMessage,
): Promise<void> {
  if (!query.options.persistSession) {
    return;
  }

  const record: SessionMessageRecord = {
    uuid: "uuid" in message && typeof message.uuid === "string" ? message.uuid : uuid(),
    timestamp: Date.now(),
    message,
  };
  await appendSessionMessage(query.options.runtimeDir, query.sessionId, record);

  const info = await upsertSessionInfo(query.options.runtimeDir, query.sessionId, {
    cwd: query.options.cwd,
    firstPrompt: query.firstPrompt,
    gitBranch: query.gitBranch,
  });
  info.messageCount += 1;
  await writeSessionInfo(query.options.runtimeDir, info);
}

function messagesFromSdkTranscript(records: SessionMessageRecord[]): Message[] {
  const transcript: Message[] = [];
  const pendingToolResults = new Map<string, ToolResultBlock>();

  const flushPendingToolResults = () => {
    if (pendingToolResults.size === 0) {
      return;
    }

    transcript.push({
      role: "user",
      content: [...pendingToolResults.values()],
    });
    pendingToolResults.clear();
  };

  for (const record of records) {
    const message = record.message;
    if (message.type === "user") {
      flushPendingToolResults();
      transcript.push({
        role: "user",
        content: message.message.content,
      });
    }

    if (message.type === "assistant") {
      flushPendingToolResults();
      transcript.push({
        role: "assistant",
        content: message.message.content,
      });
    }

    if (message.type === "system" && message.subtype === "tool_result") {
      pendingToolResults.set(message.tool_use_id, {
        type: "tool_result",
        tool_use_id: message.tool_use_id,
        content: message.content,
        is_error: message.is_error,
      });
    }
  }

  flushPendingToolResults();
  return transcript;
}

function isLikelyWriteTool(toolName: string): boolean {
  return ["Write", "Edit"].includes(toolName);
}

async function maybeRecordCheckpointForTool(
  options: ResolvedOptions,
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<void> {
  if (!options.enableFileCheckpointing || !isLikelyWriteTool(toolName)) {
    return;
  }

  const filePathValue = input.file_path;
  if (typeof filePathValue !== "string" || !filePathValue.trim()) {
    return;
  }

  const resolvedFilePath = path.resolve(options.cwd, filePathValue);
  const before = await safeReadFile(resolvedFilePath);
  await recordCheckpoint(options.runtimeDir, sessionId, resolvedFilePath, before);
}

function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): boolean {
  const schemaType = typeof schema.type === "string" ? schema.type : undefined;

  if (schemaType === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }

    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in (value as Record<string, unknown>))) {
        return false;
      }
    }

    const properties =
      schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {};

    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in (value as Record<string, unknown>) && !validateAgainstSchema((value as Record<string, unknown>)[key], childSchema)) {
        return false;
      }
    }

    return true;
  }

  if (schemaType === "array") {
    if (!Array.isArray(value)) {
      return false;
    }

    const itemSchema =
      schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)
        ? (schema.items as Record<string, unknown>)
        : {};
    return value.every((item) => validateAgainstSchema(item, itemSchema));
  }

  if (schemaType === "string") {
    return typeof value === "string";
  }

  if (schemaType === "number" || schemaType === "integer") {
    return typeof value === "number";
  }

  if (schemaType === "boolean") {
    return typeof value === "boolean";
  }

  return true;
}

function parseStructuredOutput(text: string, format?: OutputFormat): unknown {
  if (!format) {
    return undefined;
  }

  const parsed = JSON.parse(text) as unknown;
  if (!validateAgainstSchema(parsed, format.schema)) {
    throw new Error("Structured output did not match the requested schema.");
  }

  return parsed;
}

async function runSinglePrompt(args: {
  query: PinocchioQuery;
  prompt: string;
  options: ResolvedOptions;
  sessionId: string;
  signal: AbortSignal;
  state: QueryState;
  transcriptMessages: Message[];
  emit: (message: SDKMessage) => Promise<void>;
  parentToolUseId: string | null;
  suppressSessionWrites?: boolean;
}): Promise<{ finalMessage?: BetaMessage; text: string; isError: boolean; stopReason: string | null; turns: number; structuredOutput?: unknown }> {
  let prompt = applySlashCommand(args.prompt, args.options.slashCommands);
  const transcript = [...args.transcriptMessages];
  let turns = 0;
  let finalMessage: BetaMessage | undefined;
  let structuredOutput: unknown;
  let structuredOutputRetries = 0;

  for (;;) {
    if (args.signal.aborted) {
      throw new Error("Prompt interrupted");
    }

    if (turns >= args.options.maxTurns) {
      return {
        finalMessage,
        text: extractTextFromBlocks(finalMessage?.content ?? []),
        isError: true,
        stopReason: "max_turns",
        turns,
      };
    }

    if (prompt) {
      transcript.push({ role: "user", content: prompt });
    }

    const response = await runModelInference({
      model: args.options.model,
      effort: args.options.effort,
      max_tokens: args.options.maxTokens,
      messages: transcript,
      provider: args.options.provider,
      systemPrompt: buildSystemPrompt(args.options, args.options.tools),
      tools: args.options.tools.map(toApiTool),
      signal: args.signal,
      onTextDelta: undefined,
      onPartial: args.options.includePartialMessages
        ? async (event) => {
            await args.emit({
              type: "stream_event",
              uuid: uuid(),
              session_id: args.sessionId,
              parent_tool_use_id: args.parentToolUseId,
              event,
            });
          }
        : undefined,
    });

    finalMessage = response;
    transcript.push({ role: "assistant", content: response.content });
    turns += 1;

    const assistantMessage: SDKAssistantMessage = {
      type: "assistant",
      uuid: uuid(),
      session_id: args.sessionId,
      message: response,
      parent_tool_use_id: args.parentToolUseId,
    };
    await args.emit(assistantMessage);

    const toolResults: ToolResultBlock[] = [];
    const responseBlocks = response.content;
    const abortRemainingToolCalls = async (afterIndex: number, reason: string) => {
      for (let pendingIndex = afterIndex + 1; pendingIndex < responseBlocks.length; pendingIndex += 1) {
        const pendingBlock = responseBlocks[pendingIndex];
        if (!pendingBlock || pendingBlock.type !== "tool_use") {
          continue;
        }

        const pendingResult = createToolResult(pendingBlock.id, reason, true);
        toolResults.push(pendingResult);
        await recordToolResult({
          state: args.state,
          emit: args.emit,
          sessionId: args.sessionId,
        }, pendingBlock, pendingResult);
      }
    };

    for (let blockIndex = 0; blockIndex < responseBlocks.length; blockIndex += 1) {
      const block = responseBlocks[blockIndex];
      if (!block || block.type !== "tool_use") {
        continue;
      }

      args.state.toolCounts.set(block.name, (args.state.toolCounts.get(block.name) ?? 0) + 1);
      const tool = args.options.tools.find((candidate) => candidate.name === block.name);
      const toolStartedAt = Date.now();

      const preToolInput: HookInput = {
        hook_event_name: "PreToolUse",
        cwd: args.options.cwd,
        session_id: args.sessionId,
        tool_name: block.name,
        tool_input: block.input,
      };
      const hookResponses = await runHooks("PreToolUse", args.options, args.query, preToolInput, block.name);
      let permission = choosePermissionResult(hookResponses, autoPermissionForMode(args.options.permissionMode, block.name));
      if (args.options.canUseTool) {
        permission = normalizePermissionResponse(
          await Promise.resolve(args.options.canUseTool(block.name, block.input, { signal: args.signal, sessionId: args.sessionId })),
          permission,
        );
      }

      const updatedInput = permission.updatedInput ?? block.input;
      const deniedByAllowlist =
        (args.options.allowedTools.length > 0 && !args.options.allowedTools.includes(block.name)) ||
        args.options.disallowedTools.includes(block.name);
      if (deniedByAllowlist) {
        permission = { behavior: "deny", message: `Tool ${block.name} is not enabled for this run.` };
      }

      const modeValidationError = validateModeToolInput(
        args.options.activeMode,
        args.options.cwd,
        block.name,
        updatedInput,
      );
      if (modeValidationError) {
        permission = { behavior: "deny", message: modeValidationError };
      }

      if (permission.behavior === "ask") {
        if (args.options.onUserQuestion) {
          const answer = await Promise.resolve(
            args.options.onUserQuestion(
              {
                type: "permission_request",
                tool_name: block.name,
                tool_input: updatedInput,
                message: permission.message,
              },
              { signal: args.signal, sessionId: args.sessionId },
            ),
          );
          const normalized = String(typeof answer === "string" ? answer : toolResultContentToString(normalizeToolResultContent(answer)));
          if (/^(abort|stop|exit)$/i.test(normalized)) {
            permission = { behavior: "abort", message: normalized };
          } else {
            permission = /^(yes|allow|approve)$/i.test(normalized) ? { behavior: "allow" } : { behavior: "deny", message: normalized };
          }
        } else {
          permission = { behavior: "deny", message: permission.message ?? `Permission denied for ${block.name}` };
        }
      }

      let result: ToolResultBlock;
      if (permission.behavior === "abort") {
        result = createToolResult(block.id, permission.message ?? `Permission denied for ${block.name}`, true);
        await recordToolResult({
          state: args.state,
          emit: args.emit,
          sessionId: args.sessionId,
        }, block, result);
        await abortRemainingToolCalls(blockIndex, permission.message ?? "abort");
        return {
          finalMessage: undefined,
          text: permission.message ?? "abort",
          isError: false,
          stopReason: "abort",
          turns,
        };
      } else if (permission.behavior === "deny") {
        result = createToolResult(block.id, permission.message ?? `Permission denied for ${block.name}`, true);
        args.state.permissionDenials.push({
          tool_name: block.name,
          tool_use_id: block.id,
          tool_input: updatedInput,
        });
      } else {
        if (!tool) {
          result = createToolResult(block.id, `Unknown tool: ${block.name}`, true);
        } else {
          try {
            await emitToolProgressMessage({
              emit: args.emit,
              sessionId: args.sessionId,
              toolName: block.name,
              toolUseId: block.id,
              status: "running",
              elapsedMs: 0,
              timeoutMs: tool.timeoutMs,
            });
            await maybeRecordCheckpointForTool(args.options, args.sessionId, block.name, updatedInput);
            const executionContext: ToolExecutionContext = {
              cwd: args.options.cwd,
              signal: args.signal,
              sessionId: args.sessionId,
              options: args.options,
              query: args.query,
              state: args.state,
              emitToolProgress: async (update) => {
                await emitToolProgressMessage({
                  emit: args.emit,
                  sessionId: args.sessionId,
                  toolName: block.name,
                  toolUseId: block.id,
                  status: update.status ?? "running",
                  elapsedMs: update.elapsedMs ?? Math.max(0, Date.now() - toolStartedAt),
                  timeoutMs: update.timeoutMs ?? tool.timeoutMs,
                  output: update.output,
                  stream: update.stream,
                });
              },
            };
            const rawResult = await tool.run(updatedInput, executionContext);
            result = {
              ...rawResult,
              tool_use_id: block.id,
            };
          } catch (error) {
            const err = error as { message?: string; stderr?: string };
            result = createToolResult(block.id, err.stderr ?? err.message ?? String(error), true);
          }
        }
      }

      if (isLikelyWriteTool(block.name) && !result.is_error) {
        args.state.filesPersisted.add(String(updatedInput.file_path ?? ""));
      }

      const postHookInput: HookInput = {
        hook_event_name: "PostToolUse",
        cwd: args.options.cwd,
        session_id: args.sessionId,
        tool_name: block.name,
        tool_input: updatedInput,
        tool_response: result,
      };
      await runHooks("PostToolUse", args.options, args.query, postHookInput, block.name);

      toolResults.push(result);
      await recordToolResult({
        state: args.state,
        emit: args.emit,
        sessionId: args.sessionId,
      }, block, result);

      if (args.signal.aborted && args.query.controller.signal.aborted) {
        await abortRemainingToolCalls(blockIndex, "abort");
        return {
          finalMessage: undefined,
          text: "abort",
          isError: false,
          stopReason: "abort",
          turns,
        };
      }
    }

    if (toolResults.length === 0) {
      const finalText = extractTextFromBlocks(response.content);
      if (args.options.outputFormat) {
        try {
          structuredOutput = parseStructuredOutput(finalText, args.options.outputFormat);
          return {
            finalMessage: response,
            text: finalText,
            isError: false,
            stopReason: response.stop_reason,
            turns,
            structuredOutput,
          };
        } catch {
          structuredOutputRetries += 1;
          if (structuredOutputRetries >= 3) {
            return {
              finalMessage: response,
              text: finalText,
              isError: true,
              stopReason: "error_max_structured_output_retries",
              turns,
            };
          }

          prompt = [
            "Return only valid JSON matching the requested schema.",
            "Do not include markdown fences or extra commentary.",
          ].join(" ");
          continue;
        }
      }

      return {
        finalMessage: response,
        text: finalText,
        isError: false,
        stopReason: response.stop_reason,
        turns,
        structuredOutput,
      };
    }

    transcript.push({ role: "user", content: toolResults });
    prompt = "";
  }
}

class PinocchioQuery extends EventEmitter implements Query {
  readonly sessionId: string;
  readonly controller = new AbortController();
  readonly options: ResolvedOptions;
  readonly gitBranch?: string;

  private readonly state: QueryState = {
    todos: [],
    toolCounts: new Map(),
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: new Map(),
    permissionDenials: [],
    filesPersisted: new Set(),
    toolResults: [],
  };
  private readonly queue: SDKMessage[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<SDKMessage>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private readonly initPromise: Promise<SDKSystemMessage>;
  private done = false;
  private error: unknown;
  private running: Promise<void>;
  private sessionTranscript: Message[] = [];
  private pendingInputs: SDKUserMessage[] = [];
  private inputWaiters: Array<(message: SDKUserMessage | null) => void> = [];
  private inputClosed = false;
  private activePromptController?: AbortController;
  private steeringRevision = 0;
  firstPrompt?: string;

  constructor(
    sessionId: string,
    options: ResolvedOptions,
    initialPrompt: string | AsyncIterable<SDKUserMessage>,
    resumeMessages: SessionMessageRecord[],
    gitBranch: string | undefined,
  ) {
    super();
    this.sessionId = sessionId;
    this.options = options;
    this.gitBranch = gitBranch;
    this.sessionTranscript = messagesFromSdkTranscript(resumeMessages);
    this.firstPrompt = getFirstPrompt(resumeMessages.map((item) => item.message)) as string | undefined;
    this.initPromise = this.createInitMessage();
    this.running = this.start(initialPrompt);
  }

  async initializationResult(): Promise<SDKSystemMessage> {
    return this.initPromise;
  }

  async supportedCommands(): Promise<string[]> {
    return this.options.slashCommands.map((command) => command.name);
  }

  async supportedModels(): Promise<Array<{ id: string; display_name: string }>> {
    return [{ id: this.options.model, display_name: this.options.model }];
  }

  async supportedAgents(): Promise<Array<{ name: string; description: string }>> {
    return Object.entries(this.options.agents).map(([name, agent]) => ({ name, description: agent.description }));
  }

  async mcpServerStatus(): Promise<Array<{ name: string; status: string }>> {
    return Object.entries(this.options.mcpServers).map(([name, server]) => ({
      name,
      status: server.type === "sdk" ? "connected" : "configured",
    }));
  }

  async reconnectMcpServer(_serverName: string): Promise<void> {}

  async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
    if (!enabled) {
      delete this.options.mcpServers[serverName];
    }
  }

  async setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult> {
    const before = new Set(Object.keys(this.options.mcpServers));
    const after = new Set(Object.keys(servers));
    this.options.mcpServers = { ...servers };
    this.options.tools = resolveSelectedTools({
      ...this.options,
      tools: buildRuntimeTools([], servers),
    });

    return {
      added: [...after].filter((item) => !before.has(item)),
      removed: [...before].filter((item) => !after.has(item)),
      errors: {},
    };
  }

  async streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const message of stream) {
      this.enqueueInput(message);
    }
  }

  async steer(message: string): Promise<void> {
    this.steeringRevision += 1;
    this.enqueueInput(
      {
        type: "user",
        session_id: this.sessionId,
        uuid: uuid(),
        message: {
          role: "user",
          content: message,
        },
      },
      "high",
    );
    this.activePromptController?.abort();
  }

  async stopTask(_taskId: string): Promise<void> {
    this.controller.abort();
  }

  async rewindFiles(): Promise<RewindFilesResult> {
    return rewindSessionFiles(this.options.runtimeDir, this.sessionId);
  }

  async close(): Promise<void> {
    this.inputClosed = true;
    this.controller.abort();
    this.finish();
    await this.running.catch(() => undefined);
  }

  async return(): Promise<IteratorResult<SDKMessage>> {
    await this.close();
    return { done: true, value: undefined };
  }

  async throw(error: unknown): Promise<IteratorResult<SDKMessage>> {
    await this.close();
    throw error;
  }

  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void, unknown> {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async next(): Promise<IteratorResult<SDKMessage>> {
    if (this.error) {
      return Promise.reject(this.error);
    }

    const item = this.queue.shift();
    if (item) {
      return { done: false, value: item };
    }

    if (this.done) {
      return { done: true, value: undefined };
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async push(message: SDKMessage): Promise<void> {
    if ("message" in message && message.type === "assistant") {
      const usage = message.message.usage;
      this.state.usage.input_tokens += usage.input_tokens;
      this.state.usage.output_tokens += usage.output_tokens;
      const existing = this.state.modelUsage.get(message.message.model) ?? { input_tokens: 0, output_tokens: 0 };
      existing.input_tokens += usage.input_tokens;
      existing.output_tokens += usage.output_tokens;
      this.state.modelUsage.set(message.message.model, existing);
    }

    await persistMessage(this, message);

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }

    this.queue.push(message);
  }

  private enqueueInput(message: SDKUserMessage, priority: InputPriority = "normal"): void {
    const waiter = this.inputWaiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }

    if (priority === "high") {
      this.pendingInputs.unshift(message);
      return;
    }

    this.pendingInputs.push(message);
  }

  private async nextInput(): Promise<SDKUserMessage | null> {
    const next = this.pendingInputs.shift();
    if (next) {
      return next;
    }

    if (this.inputClosed) {
      return null;
    }

    return new Promise((resolve) => {
      this.inputWaiters.push(resolve);
    });
  }

  private finish(): void {
    this.done = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve({ done: true, value: undefined });
    }
  }

  private fail(error: unknown): void {
    this.error = error;
    this.done = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.reject(error);
    }
  }

  private async createInitMessage(): Promise<SDKSystemMessage> {
    const message: SDKSystemMessage = {
      type: "system",
      subtype: "init",
      uuid: uuid(),
      session_id: this.sessionId,
      agents: Object.keys(this.options.agents),
      apiKeySource: inferApiKeySource(this.options.provider),
      betas: [],
      claude_code_version: PINOCCHIO_VERSION,
      cwd: this.options.cwd,
      tools: this.options.tools.map((tool) => tool.name),
      mcp_servers: Object.entries(this.options.mcpServers).map(([name, server]) => ({
        name,
        status: server.type === "sdk" ? "connected" : "configured",
      })),
      model: this.options.model,
      permissionMode: this.options.permissionMode,
      slash_commands: this.options.slashCommands.map((command) => command.name),
      output_style: this.options.outputFormat ? "structured" : "text",
      skills: this.options.skills.map((skill) => skill.name),
      plugins: this.options.plugins.map((plugin) => ({ name: plugin.name, path: plugin.path })),
    };
    await this.push(message);
    return message;
  }

  private async start(initialPrompt: string | AsyncIterable<SDKUserMessage>): Promise<void> {
    try {
      await this.initPromise;
      await runHooks(
        "SessionStart",
        this.options,
        this,
        {
          hook_event_name: "SessionStart",
          session_id: this.sessionId,
          cwd: this.options.cwd,
        },
        this.sessionId,
      );

      if (typeof initialPrompt === "string") {
        this.enqueueInput({
          type: "user",
          session_id: this.sessionId,
          uuid: uuid(),
          message: {
            role: "user",
            content: initialPrompt,
          },
        });
        this.inputClosed = true;
      } else {
        void (async () => {
          for await (const message of initialPrompt) {
            this.enqueueInput(message);
          }
          this.inputClosed = true;
        })();
      }

      const startedAt = Date.now();
      const taskId = uuid();
      await this.push({
        type: "system",
        subtype: "task_started",
        uuid: uuid(),
        session_id: this.sessionId,
        task_id: taskId,
        title: "Running query",
      });

      let turns = 0;
      let lastResult: Awaited<ReturnType<typeof runSinglePrompt>> | undefined;

      for (;;) {
        const input = await this.nextInput();
        if (!input) {
          break;
        }

        this.firstPrompt ||= input.message.content;
        await this.push({
          ...input,
          session_id: this.sessionId,
          uuid: input.uuid ?? uuid(),
        });

        await runHooks(
          "UserPromptSubmit",
          this.options,
          this,
          {
            hook_event_name: "UserPromptSubmit",
            session_id: this.sessionId,
            cwd: this.options.cwd,
            prompt: input.message.content,
          },
          input.message.content,
        );

        await this.push({
          type: "system",
          subtype: "task_progress",
          uuid: uuid(),
          session_id: this.sessionId,
          task_id: taskId,
          progress: `Working on: ${input.message.content.slice(0, 80)}`,
        });

        const steeringRevisionBeforePrompt = this.steeringRevision;
        const { controller, cleanup } = createLinkedAbortController([this.controller.signal]);
        this.activePromptController = controller;

        try {
          lastResult = await runSinglePrompt({
            query: this,
            prompt: input.message.content,
            options: this.options,
            sessionId: this.sessionId,
            signal: controller.signal,
            state: this.state,
            transcriptMessages: this.sessionTranscript,
            emit: async (message) => {
              await this.push(message);
            },
            parentToolUseId: null,
          });
        } catch (error) {
          if (!this.controller.signal.aborted && controller.signal.aborted && this.steeringRevision !== steeringRevisionBeforePrompt) {
            this.sessionTranscript.push({ role: "user", content: input.message.content });
            continue;
          }

          throw error;
        } finally {
          cleanup();
          if (this.activePromptController === controller) {
            this.activePromptController = undefined;
          }
        }

        turns += lastResult.turns;
        if (lastResult.finalMessage) {
          this.sessionTranscript.push({ role: "user", content: input.message.content });
          this.sessionTranscript.push({ role: "assistant", content: lastResult.finalMessage.content });
        }
      }

      if (this.state.filesPersisted.size > 0) {
        const filesMessage: SDKFilesPersistedEvent = {
          type: "system",
          subtype: "files_persisted",
          uuid: uuid(),
          session_id: this.sessionId,
          files: [...this.state.filesPersisted],
        };
        await this.push(filesMessage);
      }

      if (this.state.toolCounts.size > 0) {
        await this.push({
          type: "system",
          subtype: "tool_use_summary",
          uuid: uuid(),
          session_id: this.sessionId,
          tools: [...this.state.toolCounts.entries()].map(([name, count]) => ({ name, count })),
        });
      }

      if (this.options.promptSuggestions) {
        await this.push({
          type: "prompt_suggestion",
          uuid: uuid(),
          session_id: this.sessionId,
          prompt: "Continue with the next concrete step.",
        });
      }

      const resultMessage: SDKResultMessage = {
        type: "result",
        subtype: lastResult?.stopReason === "abort"
          ? "aborted_by_user"
          : lastResult?.stopReason === "max_turns"
          ? "error_max_turns"
          : lastResult?.stopReason === "error_max_structured_output_retries"
            ? "error_max_structured_output_retries"
            : lastResult?.isError
              ? "error_during_execution"
              : "success",
        uuid: uuid(),
        session_id: this.sessionId,
        duration_ms: Date.now() - startedAt,
        duration_api_ms: 0,
        is_error: Boolean(lastResult?.isError),
        num_turns: turns,
        stop_reason: lastResult?.stopReason ?? null,
        result: lastResult?.text,
        total_cost_usd: 0,
        usage: this.state.usage,
        modelUsage: Object.fromEntries(this.state.modelUsage.entries()),
        permission_denials: this.state.permissionDenials,
        tool_results: this.state.toolResults.length > 0 ? this.state.toolResults : undefined,
        structured_output: lastResult?.structuredOutput,
      };

      await this.push(resultMessage);
      await runHooks(
        "Stop",
        this.options,
        this,
        {
          hook_event_name: "Stop",
          session_id: this.sessionId,
          cwd: this.options.cwd,
          stop_reason: resultMessage.stop_reason,
        },
        resultMessage.stop_reason ?? "",
      );
      this.finish();
    } catch (error) {
      if (this.controller.signal.aborted || isAbortError(error)) {
        const resultMessage: SDKResultMessage = {
          type: "result",
          subtype: "aborted_by_user",
          uuid: uuid(),
          session_id: this.sessionId,
          duration_ms: 0,
          duration_api_ms: 0,
          is_error: false,
          num_turns: 0,
          stop_reason: "abort",
          total_cost_usd: 0,
          usage: this.state.usage,
          modelUsage: Object.fromEntries(this.state.modelUsage.entries()),
          permission_denials: this.state.permissionDenials,
          tool_results: this.state.toolResults.length > 0 ? this.state.toolResults : undefined,
        };
        await this.push(resultMessage).catch(() => undefined);
        this.finish();
        return;
      }

      const resultMessage: SDKResultMessage = {
        type: "result",
        subtype: "error_during_execution",
        uuid: uuid(),
        session_id: this.sessionId,
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: true,
        num_turns: 0,
        stop_reason: "error",
        result: error instanceof Error ? error.message : String(error),
        total_cost_usd: 0,
        usage: this.state.usage,
        modelUsage: Object.fromEntries(this.state.modelUsage.entries()),
        permission_denials: this.state.permissionDenials,
        tool_results: this.state.toolResults.length > 0 ? this.state.toolResults : undefined,
        errors: [error instanceof Error ? error.stack || error.message : String(error)],
      };
      await this.push(resultMessage).catch(() => undefined);
      if (isUserActionableSetupError(error)) {
        this.finish();
        return;
      }
      this.fail(error);
    }
  }
}

export async function query(
  prompt: string | AsyncIterable<SDKUserMessage>,
  options: Options = {},
): Promise<Query> {
  const resolved = await resolveOptions(options);
  const gitBranch = await readGitBranch(resolved.cwd);
  const resumeMessages = options.resume ? await readSessionMessages(resolved.runtimeDir, options.resume) : [];
  const sessionId = options.forkSession ? uuid() : options.resume ?? options.sessionId ?? uuid();

  if (options.persistSession !== false) {
    await mkdir(path.join(resolved.runtimeDir, "sessions"), { recursive: true });
    const existing = await readSessionInfo(resolved.runtimeDir, sessionId);
    if (!existing) {
      await upsertSessionInfo(resolved.runtimeDir, sessionId, {
        cwd: resolved.cwd,
        title: `Session ${sessionId.slice(0, 8)}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }

  return new PinocchioQuery(sessionId, resolved, prompt, resumeMessages, gitBranch);
}

export class PinocchioSDKClient {
  private readonly defaults: Options;
  private lastSessionId?: string;

  constructor(options: Options = {}) {
    this.defaults = options;
    this.lastSessionId = options.sessionId;
  }

  async query(prompt: string | AsyncIterable<SDKUserMessage>, options: Options = {}): Promise<Query> {
    const merged: Options = {
      ...this.defaults,
      ...options,
      provider: {
        ...(this.defaults.provider ?? {}),
        ...(options.provider ?? {}),
        headers: {
          ...(this.defaults.provider?.headers ?? {}),
          ...(options.provider?.headers ?? {}),
        },
      },
      hooks: {
        ...(this.defaults.hooks ?? {}),
        ...(options.hooks ?? {}),
      },
      agents: {
        ...(this.defaults.agents ?? {}),
        ...(options.agents ?? {}),
      },
      mcpServers: {
        ...(this.defaults.mcpServers ?? {}),
        ...(options.mcpServers ?? {}),
      },
    };

    if (!merged.resume && this.lastSessionId) {
      merged.resume = this.lastSessionId;
    }

    const result = await query(prompt, merged);
    this.lastSessionId = (result as unknown as { sessionId: string }).sessionId;
    return result;
  }
}

export function tool<TShape extends ZodRawShape>(name: string, options: {
  description: string;
  inputSchema: { parse: (value: unknown) => Record<string, unknown> } & ZodTypeAny;
  annotations?: ToolAnnotations;
  run: (args: Record<string, unknown>) => Promise<CallToolResult | string> | CallToolResult | string;
}): SdkMcpToolDefinition<TShape> {
  return {
    name,
    description: options.description,
    inputSchema: {} as TShape,
    input_schema: toJSONSchema(options.inputSchema) as Record<string, unknown>,
    annotations: options.annotations,
    handler: async (args) => {
      const parsed = options.inputSchema.parse(args);
      return toCallToolResult(await Promise.resolve(options.run(parsed)));
    },
  };
}

export function createSdkMcpServer(config: { name?: string; tools: SdkMcpToolDefinition[] }): SdkMcpServer {
  return {
    type: "sdk",
    name: config.name,
    tools: config.tools,
  };
}

export async function listSessions(options: Pick<Options, "cwd"> = {}): Promise<SessionInfo[]> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const loaded = await loadProjectRuntime(cwd);
  return listStoredSessions(loaded.runtimeDir);
}

export async function getSessionMessages(sessionId: string, options: Pick<Options, "cwd"> = {}): Promise<SDKMessage[]> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const loaded = await loadProjectRuntime(cwd);
  const records = await readSessionMessages(loaded.runtimeDir, sessionId);
  return records.map((record) => record.message);
}

export async function getSessionInfo(sessionId: string, options: Pick<Options, "cwd"> = {}): Promise<SessionInfo | null> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const loaded = await loadProjectRuntime(cwd);
  return readSessionInfo(loaded.runtimeDir, sessionId);
}

export async function renameSession(sessionId: string, title: string, options: Pick<Options, "cwd"> = {}): Promise<void> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const loaded = await loadProjectRuntime(cwd);
  await renameStoredSession(loaded.runtimeDir, sessionId, title);
}

export async function tagSession(sessionId: string, tag: string, options: Pick<Options, "cwd"> = {}): Promise<void> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const loaded = await loadProjectRuntime(cwd);
  await tagStoredSession(loaded.runtimeDir, sessionId, tag);
}
