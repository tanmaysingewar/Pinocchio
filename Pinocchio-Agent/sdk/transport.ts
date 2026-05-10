import type {
  BetaMessage,
  Message,
  ThinkingBlock,
  TextBlock,
  ToolResultBlock,
  ToolResultContent,
  ToolResultContentBlock,
  ToolUseBlock,
  Usage,
} from "./types.ts";
import {
  getValidOpenAISubscriptionAuth,
  OPENAI_SUBSCRIPTION_ENDPOINT,
  OPENAI_SUBSCRIPTION_PROTOCOL,
} from "./openai-subscription-auth.ts";

interface ApiTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface SSEEvent {
  event: string;
  data: string;
}

interface OpenAIStreamToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

interface OpenAIStreamAccumulator {
  id: string;
  model: string;
  stop_reason: string;
  text: string;
  thinking: string;
  toolCalls: OpenAIStreamToolCall[];
  usage: Usage;
}

interface AnthropicTextBlockState {
  type: "text";
  text: string;
}

interface AnthropicThinkingBlockState {
  type: "thinking";
  thinking: string;
}

interface AnthropicToolUseBlockState {
  type: "tool_use";
  id: string;
  name: string;
  inputText: string;
}

type AnthropicStreamBlockState =
  | AnthropicTextBlockState
  | AnthropicThinkingBlockState
  | AnthropicToolUseBlockState;

export interface ProviderConfig {
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

export interface RunModelInferenceArgs {
  model: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  max_tokens: number;
  messages: Message[];
  provider: ProviderConfig;
  systemPrompt: string;
  tools: ApiTool[];
  onTextDelta?: (text: string) => Promise<void> | void;
  onPartial?: (event: unknown) => Promise<void> | void;
  signal?: AbortSignal;
}

function detectProviderProtocol(baseUrl: string, configuredProtocol?: ProviderConfig["protocol"]): "anthropic" | "openai" {
  if (configuredProtocol === OPENAI_SUBSCRIPTION_PROTOCOL) {
    return "openai";
  }

  if (configuredProtocol && configuredProtocol !== "auto") {
    return configuredProtocol;
  }

  return baseUrl.includes("/chat/completions") ? "openai" : "anthropic";
}

function buildProviderHeaders(
  config: ProviderConfig,
  protocol: "anthropic" | "openai",
  apiKey: string,
): Record<string, string> {
  const authHeader = config.auth_header || (protocol === "openai" ? "Authorization" : "x-api-key");
  const authPrefix = config.auth_prefix ?? (protocol === "openai" ? "Bearer " : "");
  const versionHeader = config.version_header ?? (protocol === "anthropic" ? "anthropic-version" : undefined);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(config.headers ?? {}),
    [authHeader]: `${authPrefix}${apiKey}`,
  };

  if (config.version && versionHeader) {
    headers[versionHeader] = config.version;
  }

  return headers;
}

function normalizeOpenAIMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }

      const item = part as { text?: unknown; type?: unknown };
      if (item.type === "text" && typeof item.text === "string") {
        return [item.text];
      }

      return [];
    })
    .join("\n");
}

function parseToolCallArguments(argumentsText: string, toolName: string): Record<string, unknown> {
  if (!argumentsText.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool arguments must decode to an object");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid tool arguments for ${toolName}: ${message}`);
  }
}

function serializeToolResultContent(content: ToolResultContent): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((item: ToolResultContentBlock) => ("text" in item && item.type === "text" ? item.text : JSON.stringify(item)))
    .join("\n");
}

function normalizeOpenAIResponse(payload: unknown): BetaMessage {
  const raw = payload as {
    choices?: Array<{
      finish_reason?: unknown;
      message?: {
        content?: unknown;
        tool_calls?: Array<{
          id?: unknown;
          function?: { arguments?: unknown; name?: unknown };
        }>;
      };
    }>;
    id?: unknown;
    model?: unknown;
    object?: unknown;
    usage?: { completion_tokens?: unknown; prompt_tokens?: unknown };
  };

  const choice = raw.choices?.[0];
  const message = choice?.message;
  if (!message) {
    throw new Error("Provider response missing choices[0].message");
  }

  const content: (TextBlock | ThinkingBlock | ToolUseBlock)[] = [];
  const text = normalizeOpenAIMessageContent(message.content);
  if (text.trim()) {
    content.push({ type: "text", text });
  }

  for (const toolCall of message.tool_calls ?? []) {
    const name = typeof toolCall.function?.name === "string" ? toolCall.function.name : "";
    const id = typeof toolCall.id === "string" ? toolCall.id : "";
    if (!name || !id) {
      continue;
    }

    content.push({
      type: "tool_use",
      id,
      name,
      input: parseToolCallArguments(
        typeof toolCall.function?.arguments === "string" ? toolCall.function.arguments : "{}",
        name,
      ),
    });
  }

  return {
    id: typeof raw.id === "string" ? raw.id : "",
    type: typeof raw.object === "string" ? raw.object : "chat.completion",
    role: "assistant",
    content,
    stop_reason: typeof choice?.finish_reason === "string" ? choice.finish_reason : "stop",
    model: typeof raw.model === "string" ? raw.model : "",
    usage: {
      input_tokens: typeof raw.usage?.prompt_tokens === "number" ? raw.usage.prompt_tokens : 0,
      output_tokens: typeof raw.usage?.completion_tokens === "number" ? raw.usage.completion_tokens : 0,
    },
  };
}

function serializeMessagesForOpenAI(messages: Message[], systemPrompt: string): Array<Record<string, unknown>> {
  const serialized: Array<Record<string, unknown>> = [{ role: "system", content: systemPrompt }];

  for (const message of messages) {
    if (typeof message.content === "string") {
      serialized.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const text = message.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const toolCalls = message.content
        .filter((block): block is ToolUseBlock => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: {
            arguments: JSON.stringify(block.input),
            name: block.name,
          },
        }));

      if (text || toolCalls.length > 0) {
        serialized.push({
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }

      continue;
    }

    const toolResults = message.content.filter((block): block is ToolResultBlock => block.type === "tool_result");
    if (toolResults.length === message.content.length) {
      for (const block of toolResults) {
        serialized.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: serializeToolResultContent(block.content),
        });
      }
      continue;
    }

    serialized.push({
      role: message.role,
      content: message.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    });
  }

  return serialized;
}

function serializeInputForOpenAIResponses(messages: Message[]): Array<Record<string, unknown>> {
  const serialized: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      serialized.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const text = message.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      if (text) {
        serialized.push({ role: "assistant", content: text });
      }

      for (const block of message.content.filter((block): block is ToolUseBlock => block.type === "tool_use")) {
        serialized.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      }

      continue;
    }

    const toolResults = message.content.filter((block): block is ToolResultBlock => block.type === "tool_result");
    if (toolResults.length === message.content.length) {
      for (const block of toolResults) {
        serialized.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: serializeToolResultContent(block.content),
        });
      }
      continue;
    }

    serialized.push({
      role: message.role,
      content: message.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    });
  }

  return serialized;
}

function serializeToolsForOpenAI(tools: ApiTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      description: tool.description,
      name: tool.name,
      parameters: tool.input_schema,
    },
  }));
}

function serializeToolsForOpenAIResponses(tools: ApiTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    description: tool.description,
    name: tool.name,
    parameters: tool.input_schema,
  }));
}

async function processSSEEventBlock(
  rawEvent: string,
  onEvent: (event: SSEEvent) => Promise<void> | void,
): Promise<void> {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of rawEvent.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1).replace(/^ /, "");

    if (field === "event") {
      event = value || "message";
      continue;
    }

    if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return;
  }

  await onEvent({ event, data: dataLines.join("\n") });
}

async function readSSEEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SSEEvent) => Promise<void> | void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processBuffer = async (flush = false): Promise<void> => {
    buffer = buffer.replace(/\r\n/g, "\n");

    for (;;) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      await processSSEEventBlock(rawEvent, onEvent);
    }

    if (flush && buffer.trim()) {
      await processSSEEventBlock(buffer, onEvent);
      buffer = "";
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        await processBuffer(true);
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      await processBuffer(false);
    }
  } finally {
    reader.releaseLock();
  }
}

async function parseOpenAIStreamResponse(
  response: Response,
  onTextDelta?: (text: string) => Promise<void> | void,
  onPartial?: (event: unknown) => Promise<void> | void,
): Promise<BetaMessage> {
  if (!response.body) {
    throw new Error("Streaming response missing body");
  }

  const state: OpenAIStreamAccumulator = {
    id: "",
    model: "",
    stop_reason: "stop",
    text: "",
    thinking: "",
    toolCalls: [],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };

  await readSSEEvents(response.body, async ({ data }) => {
    if (data === "[DONE]") {
      return;
    }

    const payload = JSON.parse(data) as {
      choices?: Array<{
        delta?: {
          content?: unknown;
          tool_calls?: Array<{
            function?: { arguments?: unknown; name?: unknown };
            id?: unknown;
            index?: unknown;
          }>;
        };
        finish_reason?: unknown;
      }>;
      id?: unknown;
      model?: unknown;
      usage?: { completion_tokens?: unknown; prompt_tokens?: unknown };
    };

    await onPartial?.(payload);

    if (typeof payload.id === "string" && !state.id) {
      state.id = payload.id;
    }

    if (typeof payload.model === "string" && !state.model) {
      state.model = payload.model;
    }

    if (typeof payload.usage?.prompt_tokens === "number") {
      state.usage.input_tokens = payload.usage.prompt_tokens;
    }

    if (typeof payload.usage?.completion_tokens === "number") {
      state.usage.output_tokens = payload.usage.completion_tokens;
    }

    const choice = payload.choices?.[0];
    if (!choice) {
      return;
    }

    if (typeof choice.finish_reason === "string") {
      state.stop_reason = choice.finish_reason;
    }

    const deltaText = normalizeOpenAIMessageContent(choice.delta?.content);
    if (deltaText) {
      state.text += deltaText;
      await onTextDelta?.(deltaText);
    }

    for (const toolCall of choice.delta?.tool_calls ?? []) {
      const index = typeof toolCall.index === "number" ? toolCall.index : -1;
      if (index < 0) {
        continue;
      }

      const current = state.toolCalls[index] ?? {
        id: "",
        name: "",
        argumentsText: "",
      };

      if (typeof toolCall.id === "string" && !current.id) {
        current.id = toolCall.id;
      }

      if (typeof toolCall.function?.name === "string") {
        current.name += toolCall.function.name;
      }

      if (typeof toolCall.function?.arguments === "string") {
        current.argumentsText += toolCall.function.arguments;
      }

      state.toolCalls[index] = current;
    }
  });

  const content: (TextBlock | ToolUseBlock)[] = [];
  if (state.text.trim()) {
    content.push({ type: "text", text: state.text });
  }

  for (const toolCall of state.toolCalls) {
    if (!toolCall?.id || !toolCall.name) {
      continue;
    }

    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input: parseToolCallArguments(toolCall.argumentsText || "{}", toolCall.name),
    });
  }

  return {
    id: state.id,
    type: "chat.completion.chunk",
    role: "assistant",
    content,
    stop_reason: state.stop_reason,
    model: state.model,
    usage: state.usage,
  };
}

async function parseOpenAIResponsesStreamResponse(
  response: Response,
  onTextDelta?: (text: string) => Promise<void> | void,
  onPartial?: (event: unknown) => Promise<void> | void,
): Promise<BetaMessage> {
  if (!response.body) {
    throw new Error("Streaming response missing body");
  }

  let id = "";
  let model = "";
  let stopReason = "stop";
  let text = "";
  let thinking = "";
  let currentThinkingSummary = "";
  const toolCalls: OpenAIStreamToolCall[] = [];
  const toolCallIndexes = new Map<string, number>();
  const usage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
  };

  await readSSEEvents(response.body, async ({ event, data }) => {
    if (data === "[DONE]") {
      return;
    }

    const payload = JSON.parse(data) as {
      arguments?: unknown;
      delta?: unknown;
      item?: {
        arguments?: unknown;
        call_id?: unknown;
        id?: unknown;
        name?: unknown;
        type?: unknown;
      };
      item_id?: unknown;
      response?: {
        error?: { message?: unknown };
        id?: unknown;
        model?: unknown;
        status?: unknown;
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      };
      text?: unknown;
      type?: unknown;
    };

    await onPartial?.({ event, payload });

    if (typeof payload.response?.id === "string" && !id) {
      id = payload.response.id;
    }

    if (typeof payload.response?.model === "string" && !model) {
      model = payload.response.model;
    }

    if (typeof payload.response?.usage?.input_tokens === "number") {
      usage.input_tokens = payload.response.usage.input_tokens;
    }

    if (typeof payload.response?.usage?.output_tokens === "number") {
      usage.output_tokens = payload.response.usage.output_tokens;
    }

    if (event === "response.failed") {
      stopReason = "error";
      const message = payload.response?.error?.message;
      throw new Error(typeof message === "string" ? message : "OpenAI response failed");
    }

    if (event === "response.output_text.delta" && typeof payload.delta === "string") {
      text += payload.delta;
      await onTextDelta?.(payload.delta);
      return;
    }

    if (event === "response.reasoning_summary_text.delta" && typeof payload.delta === "string") {
      currentThinkingSummary += payload.delta;
      return;
    }

    if (event === "response.reasoning_summary_text.done" && typeof payload.text === "string") {
      const completedSummary = currentThinkingSummary || payload.text;
      const separator = thinking.trim().length > 0 ? "\n\n" : "";
      thinking = `${thinking}${separator}${completedSummary}`;
      currentThinkingSummary = "";
      return;
    }

    if (event === "response.output_item.added" && payload.item?.type === "function_call") {
      const callId = typeof payload.item.call_id === "string" ? payload.item.call_id : "";
      const name = typeof payload.item.name === "string" ? payload.item.name : "";
      if (!callId || !name) {
        return;
      }

      const index = toolCalls.length;
      if (typeof payload.item.id === "string") {
        toolCallIndexes.set(payload.item.id, index);
      }
      toolCallIndexes.set(callId, index);
      toolCalls.push({
        id: callId,
        name,
        argumentsText: typeof payload.item.arguments === "string" ? payload.item.arguments : "",
      });
      return;
    }

    if (event === "response.function_call_arguments.delta") {
      const index = toolCallIndexes.get(String(payload.item_id ?? ""));
      if (index === undefined || typeof payload.delta !== "string") {
        return;
      }

      const toolCall = toolCalls[index];
      if (!toolCall) {
        return;
      }

      toolCall.argumentsText += payload.delta;
      return;
    }

    if (event === "response.function_call_arguments.done") {
      const index = toolCallIndexes.get(String(payload.item_id ?? ""));
      if (index === undefined || typeof payload.arguments !== "string") {
        return;
      }

      const toolCall = toolCalls[index];
      if (!toolCall) {
        return;
      }

      toolCall.argumentsText = payload.arguments;
      return;
    }

    if (event === "response.output_item.done" && payload.item?.type === "function_call") {
      const callId = typeof payload.item.call_id === "string" ? payload.item.call_id : "";
      const name = typeof payload.item.name === "string" ? payload.item.name : "";
      if (!callId || !name) {
        return;
      }

      const itemKey = typeof payload.item.id === "string" ? payload.item.id : callId;
      const existingIndex = toolCallIndexes.get(itemKey);
      const next = {
        id: callId,
        name,
        argumentsText: typeof payload.item.arguments === "string" ? payload.item.arguments : "",
      };

      if (existingIndex === undefined) {
        toolCallIndexes.set(itemKey, toolCalls.length);
        toolCallIndexes.set(callId, toolCalls.length);
        toolCalls.push(next);
      } else {
        toolCalls[existingIndex] = next;
      }
    }
  });

  const trailingThinkingSummary = currentThinkingSummary.trim();
  if (trailingThinkingSummary) {
    const separator = thinking.trim().length > 0 ? "\n\n" : "";
    thinking = `${thinking}${separator}${trailingThinkingSummary}`;
  }

  const content: (TextBlock | ThinkingBlock | ToolUseBlock)[] = [];
  if (thinking.trim()) {
    content.push({ type: "thinking", thinking: thinking.trim() });
  }
  if (text.trim()) {
    content.push({ type: "text", text });
  }

  for (const toolCall of toolCalls) {
    if (!toolCall.id || !toolCall.name) {
      continue;
    }

    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input: parseToolCallArguments(toolCall.argumentsText || "{}", toolCall.name),
    });
  }

  if (content.some((block) => block.type === "tool_use")) {
    stopReason = "tool_calls";
  }

  return {
    id,
    type: "response",
    role: "assistant",
    content,
    stop_reason: stopReason,
    model,
    usage,
  };
}

async function parseAnthropicStreamResponse(
  response: Response,
  onTextDelta?: (text: string) => Promise<void> | void,
  onPartial?: (event: unknown) => Promise<void> | void,
): Promise<BetaMessage> {
  if (!response.body) {
    throw new Error("Streaming response missing body");
  }

  let id = "";
  let model = "";
  let stop_reason: string | null = "end_turn";
  const usage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
  };
  const blocks: AnthropicStreamBlockState[] = [];

  await readSSEEvents(response.body, async ({ event, data }) => {
    const payload = JSON.parse(data) as {
      content_block?: {
        id?: unknown;
        input?: unknown;
        name?: unknown;
        thinking?: unknown;
        text?: unknown;
        type?: unknown;
      };
      delta?: {
        partial_json?: unknown;
        stop_reason?: unknown;
        thinking?: unknown;
        text?: unknown;
        type?: unknown;
      };
      index?: unknown;
      message?: {
        id?: unknown;
        model?: unknown;
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      };
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };

    await onPartial?.({ event, payload });

    if (event === "message_start") {
      if (typeof payload.message?.id === "string") {
        id = payload.message.id;
      }

      if (typeof payload.message?.model === "string") {
        model = payload.message.model;
      }

      if (typeof payload.message?.usage?.input_tokens === "number") {
        usage.input_tokens = payload.message.usage.input_tokens;
      }

      if (typeof payload.message?.usage?.output_tokens === "number") {
        usage.output_tokens = payload.message.usage.output_tokens;
      }

      return;
    }

    if (event === "content_block_start") {
      const index = typeof payload.index === "number" ? payload.index : blocks.length;
      const block = payload.content_block;

      if (block?.type === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        blocks[index] = {
          type: "text",
          text,
        };

        if (text) {
          await onTextDelta?.(text);
        }
        return;
      }

      if (block?.type === "thinking") {
        blocks[index] = {
          type: "thinking",
          thinking: typeof block.thinking === "string"
            ? block.thinking
            : typeof block.text === "string"
              ? block.text
              : "",
        };
        return;
      }

      if (block?.type === "tool_use") {
        blocks[index] = {
          type: "tool_use",
          id: typeof block.id === "string" ? block.id : "",
          name: typeof block.name === "string" ? block.name : "",
          inputText:
            block.input && typeof block.input === "object" && !Array.isArray(block.input)
              ? JSON.stringify(block.input)
              : "",
        };
      }

      return;
    }

    if (event === "content_block_delta") {
      const index = typeof payload.index === "number" ? payload.index : -1;
      const block = index >= 0 ? blocks[index] : undefined;
      if (!block) {
        return;
      }

      if (block.type === "text" && payload.delta?.type === "text_delta") {
        const text = typeof payload.delta.text === "string" ? payload.delta.text : "";
        block.text += text;
        await onTextDelta?.(text);
        return;
      }

      if (block.type === "thinking" && payload.delta?.type === "thinking_delta") {
        const thinking = typeof payload.delta.thinking === "string"
          ? payload.delta.thinking
          : typeof payload.delta.text === "string"
            ? payload.delta.text
            : "";
        block.thinking += thinking;
        return;
      }

      if (block.type === "tool_use" && payload.delta?.type === "input_json_delta") {
        const partialJson = typeof payload.delta.partial_json === "string" ? payload.delta.partial_json : "";
        block.inputText += partialJson;
      }

      return;
    }

    if (event === "message_delta") {
      if (typeof payload.delta?.stop_reason === "string") {
        stop_reason = payload.delta.stop_reason;
      }

      if (typeof payload.usage?.input_tokens === "number") {
        usage.input_tokens = payload.usage.input_tokens;
      }

      if (typeof payload.usage?.output_tokens === "number") {
        usage.output_tokens = payload.usage.output_tokens;
      }
    }
  });

  const content: (TextBlock | ThinkingBlock | ToolUseBlock)[] = [];
  for (const block of blocks) {
    if (!block) {
      continue;
    }

    if (block.type === "text") {
      if (block.text.trim()) {
        content.push({ type: "text", text: block.text });
      }
      continue;
    }

    if (block.type === "thinking") {
      if (block.thinking.trim()) {
        content.push({ type: "thinking", thinking: block.thinking });
      }
      continue;
    }

    if (!block.id || !block.name) {
      continue;
    }

    content.push({
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: parseToolCallArguments(block.inputText || "{}", block.name),
    });
  }

  return {
    id,
    type: "message",
    role: "assistant",
    content,
    stop_reason,
    model,
    usage,
  };
}

export async function runModelInference(args: RunModelInferenceArgs): Promise<BetaMessage> {
  const usesOpenAISubscription = args.provider.protocol === OPENAI_SUBSCRIPTION_PROTOCOL;
  const apiKey = usesOpenAISubscription
    ? "pinocchio-openai-subscription"
    : args.provider.api_key ?? (args.provider.api_key_env ? process.env[args.provider.api_key_env] : undefined);
  if (!apiKey) {
    const source = args.provider.api_key_env || "provider.api_key";
    throw new Error(`${source} environment variable is not set`);
  }

  const protocol = detectProviderProtocol(args.provider.base_url, args.provider.protocol);
  const headers = buildProviderHeaders(args.provider, protocol, apiKey);
  if (usesOpenAISubscription) {
    const auth = await getValidOpenAISubscriptionAuth();
    delete headers.Authorization;
    delete headers.authorization;
    headers.Authorization = `Bearer ${auth.access}`;
    if (auth.accountId) {
      headers["ChatGPT-Account-Id"] = auth.accountId;
    }
  }
  const streamEnabled = usesOpenAISubscription || Boolean(args.onTextDelta || args.onPartial);

  const body =
    protocol === "openai"
      ? {
          model: args.model,
          ...(usesOpenAISubscription ? {} : { max_tokens: args.max_tokens }),
          ...(usesOpenAISubscription ? { instructions: args.systemPrompt } : {}),
          ...(usesOpenAISubscription ? { store: false } : {}),
          ...(usesOpenAISubscription && args.effort ? { reasoning: { effort: args.effort, summary: "auto" } } : {}),
          ...(usesOpenAISubscription
            ? { input: serializeInputForOpenAIResponses(args.messages) }
            : { messages: serializeMessagesForOpenAI(args.messages, args.systemPrompt) }),
          ...(streamEnabled ? { stream: true } : {}),
          ...(args.tools.length > 0
            ? { tools: usesOpenAISubscription ? serializeToolsForOpenAIResponses(args.tools) : serializeToolsForOpenAI(args.tools) }
            : {}),
        }
      : {
          model: args.model,
          max_tokens: args.max_tokens,
          system: args.systemPrompt,
          messages: args.messages,
          ...(streamEnabled ? { stream: true } : {}),
          ...(args.tools.length > 0 ? { tools: args.tools } : {}),
        };

  const requestUrl = usesOpenAISubscription ? OPENAI_SUBSCRIPTION_ENDPOINT : args.provider.base_url;
  const response = await fetch(requestUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: args.signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API error ${response.status}: ${errorBody}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (usesOpenAISubscription && streamEnabled) {
    return parseOpenAIResponsesStreamResponse(response, args.onTextDelta, args.onPartial);
  }

  if (streamEnabled && contentType.includes("text/event-stream")) {
    return protocol === "openai"
      ? parseOpenAIStreamResponse(response, args.onTextDelta, args.onPartial)
      : parseAnthropicStreamResponse(response, args.onTextDelta, args.onPartial);
  }

  const responseBody = (await response.json()) as unknown;
  return protocol === "openai" ? normalizeOpenAIResponse(responseBody) : (responseBody as BetaMessage);
}
