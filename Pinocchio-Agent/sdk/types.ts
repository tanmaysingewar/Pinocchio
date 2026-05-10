import type { ZodTypeAny } from "zod";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";
export type SettingSource = "project";
export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "SessionStart"
  | "Stop"
  | "SubagentStart"
  | "Setup";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultTextBlock {
  type: "text";
  text: string;
}

export interface ToolResultImageBlock {
  type: "image";
  source: {
    type: "base64";
    data: string;
    media_type: string;
  };
}

export type ToolResultContentBlock =
  | ToolResultTextBlock
  | ToolResultImageBlock
  | Record<string, unknown>;

export type ToolResultContent = string | ToolResultContentBlock[];

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
}

export interface UserContentBlock {
  type: "text";
  text: string;
}

export type Message = {
  role: "user" | "assistant";
  content: string | (TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | UserContentBlock)[];
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export type NonNullableUsage = Usage;

export interface BetaMessage {
  id: string;
  type: string;
  role: "assistant";
  content: (TextBlock | ThinkingBlock | ToolUseBlock)[];
  stop_reason: string | null;
  model: string;
  usage: Usage;
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface SDKPermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

export interface SDKAssistantMessage {
  type: "assistant";
  uuid: string;
  session_id: string;
  message: BetaMessage;
  parent_tool_use_id: string | null;
  error?:
    | "authentication_failed"
    | "billing_error"
    | "rate_limit"
    | "invalid_request"
    | "server_error"
    | "max_output_tokens"
    | "unknown";
}

export interface SDKUserMessage {
  type: "user";
  uuid?: string;
  session_id?: string;
  message: {
    role: "user";
    content: string;
  };
}

export interface SDKUserMessageReplay {
  type: "user_replay";
  uuid: string;
  session_id: string;
  message: {
    role: "user";
    content: string;
  };
}

export interface SDKResultMessage {
  type: "result";
  subtype:
    | "success"
    | "aborted_by_user"
    | "error_max_turns"
    | "error_during_execution"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries";
  uuid: string;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  stop_reason: string | null;
  result?: string;
  total_cost_usd: number;
  usage: NonNullableUsage;
  modelUsage: { [modelName: string]: ModelUsage };
  permission_denials: SDKPermissionDenial[];
  tool_results?: SDKToolResultSummary[];
  structured_output?: unknown;
  errors?: string[];
}

export interface SDKToolResultSummary {
  tool_name: string;
  tool_use_id: string;
  content: ToolResultContent;
  is_error: boolean;
}

export interface SDKSystemMessage {
  type: "system";
  subtype: "init";
  uuid: string;
  session_id: string;
  agents?: string[];
  apiKeySource: "direct" | "env" | "none";
  betas?: string[];
  claude_code_version: string;
  cwd: string;
  tools: string[];
  mcp_servers: {
    name: string;
    status: string;
  }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  output_style: string;
  skills: string[];
  plugins: { name: string; path: string }[];
}

export interface SDKStatusMessage {
  type: "system";
  subtype: "status";
  status: "compacting" | null;
  permissionMode?: PermissionMode;
  uuid: string;
  session_id: string;
}

export interface SDKPartialAssistantMessage {
  type: "stream_event";
  event: unknown;
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}

export interface SDKTaskNotificationMessage {
  type: "system";
  subtype: "task_notification";
  uuid: string;
  session_id: string;
  message: string;
}

export interface SDKTaskStartedMessage {
  type: "system";
  subtype: "task_started";
  uuid: string;
  session_id: string;
  task_id: string;
  title: string;
}

export interface SDKTaskProgressMessage {
  type: "system";
  subtype: "task_progress";
  uuid: string;
  session_id: string;
  task_id: string;
  progress: string;
}

export interface SDKToolProgressMessage {
  type: "system";
  subtype: "tool_progress";
  uuid: string;
  session_id: string;
  tool_name: string;
  tool_use_id: string;
  status: "running" | "completed";
  elapsed_ms?: number;
  timeout_ms?: number;
  output?: string;
  stream?: "stdout" | "stderr";
}

export interface SDKToolResultMessage {
  type: "system";
  subtype: "tool_result";
  uuid: string;
  session_id: string;
  tool_name: string;
  tool_use_id: string;
  content: ToolResultContent;
  is_error: boolean;
}

export interface SDKPromptSuggestionMessage {
  type: "prompt_suggestion";
  uuid: string;
  session_id: string;
  prompt: string;
}

export interface SDKFilesPersistedEvent {
  type: "system";
  subtype: "files_persisted";
  uuid: string;
  session_id: string;
  files: string[];
}

export interface SDKHookStartedMessage {
  type: "system";
  subtype: "hook_started";
  uuid: string;
  session_id: string;
  hook_event_name: HookEvent;
}

export interface SDKHookResponseMessage {
  type: "system";
  subtype: "hook_response";
  uuid: string;
  session_id: string;
  hook_event_name: HookEvent;
  decision?: "approve" | "block";
  reason?: string;
}

export interface SDKToolUseSummaryMessage {
  type: "system";
  subtype: "tool_use_summary";
  uuid: string;
  session_id: string;
  tools: Array<{ name: string; count: number }>;
}

export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKResultMessage
  | SDKSystemMessage
  | SDKStatusMessage
  | SDKPartialAssistantMessage
  | SDKTaskNotificationMessage
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKToolProgressMessage
  | SDKToolResultMessage
  | SDKPromptSuggestionMessage
  | SDKFilesPersistedEvent
  | SDKHookStartedMessage
  | SDKHookResponseMessage
  | SDKToolUseSummaryMessage;

export type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      message?: string;
    }
  | {
      behavior: "deny";
      updatedInput?: Record<string, unknown>;
      message?: string;
    }
  | {
      behavior: "ask";
      updatedInput?: Record<string, unknown>;
      message?: string;
    }
  | {
      behavior: "abort";
      updatedInput?: Record<string, unknown>;
      message?: string;
    };

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  context: { signal: AbortSignal; sessionId: string },
) => Promise<PermissionResult | boolean | void> | PermissionResult | boolean | void;

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface CallToolResult {
  content: ToolResultContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface SdkMcpToolDefinition<Schema = Record<string, ZodTypeAny>> {
  name: string;
  description: string;
  inputSchema: Schema;
  input_schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;
  annotations?: ToolAnnotations;
}

export interface SdkMcpServer {
  type: "sdk";
  name?: string;
  tools: SdkMcpToolDefinition[];
}

export type McpServerConfig =
  | SdkMcpServer
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string | undefined>;
    };

export interface AgentDefinition {
  description: string;
  prompt?: string;
  tools?: string[];
  skills?: string[];
  maxTurns?: number;
  model?: string;
  mcpServers?: Record<string, McpServerConfig>;
}

export interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number;
}

export interface BaseHookInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
}

export type HookInput =
  | (BaseHookInput & {
      hook_event_name: "PreToolUse";
      tool_name: string;
      tool_input: Record<string, unknown>;
    })
  | (BaseHookInput & {
      hook_event_name: "PostToolUse";
      tool_name: string;
      tool_input: Record<string, unknown>;
      tool_response: ToolResultBlock;
    })
  | (BaseHookInput & {
      hook_event_name: "UserPromptSubmit";
      prompt: string;
    })
  | (BaseHookInput & {
      hook_event_name: "SessionStart";
    })
  | (BaseHookInput & {
      hook_event_name: "Setup";
    })
  | (BaseHookInput & {
      hook_event_name: "SubagentStart";
      agent_name: string;
      prompt: string;
    })
  | (BaseHookInput & {
      hook_event_name: "Stop";
      stop_reason: string | null;
    });

export type HookJSONOutput =
  | {
      async: true;
      asyncTimeout?: number;
    }
  | {
      continue?: boolean;
      suppressOutput?: boolean;
      stopReason?: string;
      decision?: "approve" | "block";
      systemMessage?: string;
      reason?: string;
      hookSpecificOutput?:
        | {
            hookEventName: "PreToolUse";
            permissionDecision?: "allow" | "deny" | "ask" | "abort";
            permissionDecisionReason?: string;
            updatedInput?: Record<string, unknown>;
            additionalContext?: string;
          }
        | {
            hookEventName:
              | "UserPromptSubmit"
              | "SessionStart"
              | "Setup"
              | "SubagentStart"
              | "PostToolUse";
            additionalContext?: string;
          };
    };

export type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput> | HookJSONOutput;

export interface ToolConfig {
  enabled?: boolean;
  readOnly?: boolean;
  allowlist?: string[];
}

export interface ThinkingConfig {
  type: "adaptive" | "disabled";
}

export interface SdkPluginConfig {
  type: "local";
  path: string;
}

export interface OutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

export interface SandboxSettings {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  network?: {
    allowedDomains?: string[];
    allowManagedDomainsOnly?: boolean;
    allowLocalBinding?: boolean;
    allowUnixSockets?: string[];
    allowAllUnixSockets?: boolean;
    httpProxyPort?: number;
    socksProxyPort?: number;
  };
  filesystem?: {
    allowWrite?: string[];
    denyWrite?: string[];
    denyRead?: string[];
  };
}

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

export interface SpawnedProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
}

export interface Options {
  agents?: Record<string, AgentDefinition>;
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  betas?: string[];
  canUseTool?: CanUseTool;
  continue?: boolean;
  cwd?: string;
  debug?: boolean;
  debugFile?: string;
  disallowedTools?: string[];
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  enableFileCheckpointing?: boolean;
  env?: Record<string, string | undefined>;
  fallbackModel?: string;
  forkSession?: boolean;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  includePartialMessages?: boolean;
  maxBudgetUsd?: number;
  maxTurns?: number;
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
  mode?: string;
  onUserQuestion?: (
    input: Record<string, unknown>,
    context: { signal: AbortSignal; sessionId: string },
  ) => Promise<ToolResultContent | string> | ToolResultContent | string;
  outputFormat?: OutputFormat;
  permissionMode?: PermissionMode;
  permissionPromptToolName?: string;
  persistSession?: boolean;
  plugins?: SdkPluginConfig[];
  promptSuggestions?: boolean;
  provider?: {
    api_key?: string;
    api_key_env?: string;
    base_url?: string;
    protocol?: "anthropic" | "openai" | "openai-subscription" | "auto";
    version?: string;
    auth_header?: string;
    auth_prefix?: string;
    version_header?: string;
    headers?: Record<string, string>;
  };
  resume?: string;
  resumeSessionAt?: string;
  sandbox?: SandboxSettings;
  sessionId?: string;
  settingSources?: SettingSource[];
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  stderr?: (data: string) => void;
  strictMcpConfig?: boolean;
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string };
  thinking?: ThinkingConfig;
  toolConfig?: ToolConfig;
  tools?: string[] | { type: "preset"; preset: "claude_code" };
}

export interface SessionMessageRecord {
  uuid: string;
  timestamp: number;
  message: SDKMessage;
}

export interface SessionInfo {
  sessionId: string;
  title?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
  updatedAt?: number;
  messageCount: number;
}

export interface McpSetServersResult {
  added: string[];
  removed: string[];
  errors: Record<string, string>;
}

export interface RewindFilesResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

export interface Query extends AsyncGenerator<SDKMessage, void> {
  initializationResult(): Promise<SDKSystemMessage>;
  supportedCommands(): Promise<string[]>;
  supportedModels(): Promise<Array<{ id: string; display_name: string }>>;
  supportedAgents(): Promise<Array<{ name: string; description: string }>>;
  mcpServerStatus(): Promise<Array<{ name: string; status: string }>>;
  reconnectMcpServer(serverName: string): Promise<void>;
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  steer(message: string): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  rewindFiles(): Promise<RewindFilesResult>;
  close(): Promise<void>;
}
