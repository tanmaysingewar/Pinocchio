#!/usr/bin/env bun

import {
  cursorTo,
  emitKeypressEvents,
  moveCursor,
} from "node:readline";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import chalk from "chalk";
import {
  type ConfigurableSkillSummary,
  type ConfigurableToolSummary,
  type OpenAISubscriptionModel,
  type OpenAISubscriptionUsage,
  type Options,
  type Query,
  type RuntimeModeDefinition,
  type SaveRuntimeModeInput,
  type SDKMessage,
  type ThinkingBlock,
  type TextBlock,
  type ToolResultContent,
  type ToolUseBlock,
  configureOpenAISubscriptionRuntime,
  connectOpenAISubscriptionWithBrowser,
  createProjectRuntimeScaffold,
  getProjectRuntimeConfigState,
  getOpenAISubscriptionUsage,
  listProjectRuntimeModes,
  listOpenAISubscriptionModels,
  loadOpenAISubscriptionAuth,
  PinocchioSDKClient,
  removeOpenAISubscriptionAuth,
  saveProjectRuntimeMode,
  setProjectRuntimeSkillEnabled,
  setProjectRuntimeToolEnabled,
  setProjectRuntimeModel,
} from "pinocchio";
import { loadProjectRuntime } from "../Pinocchio-Agent/sdk/filesystem.ts";
import {
  buildPromptLines,
  calculatePromptLayout,
  continuePromptAfterBackslash,
  formatAssistantTranscriptBlock,
  formatBashCommandSummary,
  formatBashRunningStatus,
  formatWrappedAssistantTranscriptBlock,
  formatLiveTerminalFrame,
  formatAssistantTranscriptPrefix,
  findActiveMention,
  formatMentionSuggestionLabel,
  formatLimitWindowLabel,
  formatModeSwitchTranscript,
  formatPromptFooter,
  formatSubmittedUserMessageBlock,
  resolveMentionViewport,
  resolveModeEditorItemEnabled,
  formatToolDisplayPath,
  formatToolInputPreview,
  formatToolResultBlockPreview,
  formatToolResultPreview,
  formatToolTranscriptLines,
  isManualRedrawKey,
  formatRunCompleteLine,
  formatRunCompleteTranscriptBlock,
  formatToolSummary,
  formatTodoPanel,
  extractAssistantTextDelta,
  extractAssistantThinkingDelta,
  parseSlashCommand,
  applyBufferedStreamDelta,
  flushBufferedStreamText,
  renderTerminalMarkdown,
  renderThinkingEmphasis,
  resolveDuplicateToolEchoDelta,
  resolveMentionSuggestions,
  resolveCliAppearance,
  rewriteSuccessfulEditAssistantMarkdown,
  rewriteEditToolResultLine,
  shouldSuppressDuplicateToolEcho,
  splitMentionQuery,
  stripAlreadyRenderedToolLines,
  wrapRenderedAnsiText,
  visibleLength,
  type CliAppearance,
  type MentionCandidate,
  type MentionSuggestion,
  type MarkdownStyles,
  type PromptUsageTotals,
  type TodoPanel,
} from "./ui.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ToolCallRecord = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  rendered: boolean;
};

type LiveTerminalTranscriptBlock = {
  kind: "liveTerminal";
  title: string;
  lines: string[];
  height: number;
  elapsedMs: number;
};

type BashRunRecord = {
  headerShown: boolean;
  streamedLines: string[];
  outputStarted: boolean;
  liveTerminalBlock: LiveTerminalTranscriptBlock | null;
  statusRenderedRows: number;
  lastElapsedSecond: number | null;
  statusLineText: string | null;
  startedAt: number | null;
  timeoutMs: number | null;
  timer: ReturnType<typeof setInterval> | null;
  displayTimer: ReturnType<typeof setTimeout> | null;
};

type PreviewLine = {
  text: string;
  variant: "default" | "diffAdd" | "diffRemove";
};

type PromptRenderState = {
  lines: string[];
  inputLineIndex: number;
  cursorColumn: number;
};

type TranscriptBlock =
  | {
      kind: "raw";
      text: string;
    }
  | {
      kind: "assistantPlain";
      text: string;
    }
  | {
      kind: "assistantThinking";
      text: string;
    }
  | LiveTerminalTranscriptBlock;

type ApprovalDecision = "approve" | "approve_for_session" | "deny" | "abort";

type ApprovalPromptState = {
  toolName: string;
  toolSummary: string;
  message: string;
  previewLines: PreviewLine[];
  question: string;
  selectedIndex: number;
  options: Array<{
    label: string;
    decision: ApprovalDecision;
  }>;
  resolve: (decision: ApprovalDecision) => void;
};

type UserQuestionOption = {
  label: string;
  description?: string;
  value: string;
};

type UserQuestionState = {
  id: string;
  header: string;
  question: string;
  options: UserQuestionOption[];
  allowOther: boolean;
  otherPlaceholder: string;
  selectedIndex: number;
  customValue: string;
};

type UserQuestionPromptResponse = {
  status: "submitted" | "aborted";
  answers?: Array<{
    id: string;
    value: string;
    label?: string;
  }>;
  answersById?: Record<string, string>;
};

type UserQuestionPromptState = {
  title: string;
  submitLabel: string;
  questions: UserQuestionState[];
  view: "question" | "review";
  activeQuestionIndex: number;
  reviewSelectedIndex: number;
  statusMessage: string | null;
  resolve: (response: UserQuestionPromptResponse) => void;
};

type ModelPickerState = {
  models: OpenAISubscriptionModel[];
  selectedIndex: number;
  selectedEffort: NonNullable<Options["effort"]>;
  saving: boolean;
};

type ConfigPickerSection = "categories" | "tools" | "skills";

type ConfigPickerState = {
  section: ConfigPickerSection;
  selectedIndex: number;
  saving: boolean;
  dirty: boolean;
  tools: ConfigurableToolSummary[];
  skills: ConfigurableSkillSummary[];
  statusMessage: string | null;
};

type ModePickerState = {
  view: "modes" | "categories" | "tools" | "skills" | "create_name" | "create_scope";
  modes: RuntimeModeDefinition[];
  tools: ConfigurableToolSummary[];
  skills: ConfigurableSkillSummary[];
  selectedIndex: number;
  saving: boolean;
  statusMessage: string | null;
  draft:
    | {
        id?: string;
        name: string;
        description: string;
        source?: "project" | "global";
        modeSource?: "project" | "global";
        filePath?: string;
        tools: ConfigurableToolSummary[];
        skills: ConfigurableSkillSummary[];
        paths: RuntimeModeDefinition["paths"];
        isCreate: boolean;
      }
    | null;
};

function modeRuleAllowsItem(
  itemId: string,
  rule: RuntimeModeDefinition["tools"] | RuntimeModeDefinition["skills"],
): boolean {
  if (rule.allow.length > 0) {
    return rule.allow.includes(itemId);
  }

  return !rule.deny.includes(itemId);
}

function cloneToolSummaries(items: ConfigurableToolSummary[]): ConfigurableToolSummary[] {
  return items.map((item) => ({ ...item }));
}

function cloneSkillSummaries(items: ConfigurableSkillSummary[]): ConfigurableSkillSummary[] {
  return items.map((item) => ({ ...item }));
}

function buildModeDraftFromDefinition(
  mode: RuntimeModeDefinition,
  tools: ConfigurableToolSummary[],
  skills: ConfigurableSkillSummary[],
): NonNullable<ModePickerState["draft"]> {
  return {
    id: mode.id,
    name: mode.name,
    description: mode.description,
    source: mode.source,
    modeSource: mode.source,
    filePath: mode.filePath,
    isCreate: false,
    paths: mode.paths,
    tools: tools.map((tool) => ({
      ...tool,
      enabled: resolveModeEditorItemEnabled({
        runtimeEnabled: tool.enabled,
        allowedInMode: modeRuleAllowsItem(tool.name, mode.tools),
      }),
    })),
    skills: skills.map((skill) => ({
      ...skill,
      enabled: resolveModeEditorItemEnabled({
        runtimeEnabled: skill.enabled,
        allowedInMode: modeRuleAllowsItem(skill.id, mode.skills),
      }),
    })),
  };
}

function buildCreateModeDraft(
  tools: ConfigurableToolSummary[],
  skills: ConfigurableSkillSummary[],
): NonNullable<ModePickerState["draft"]> {
  return {
    name: "",
    description: "",
    isCreate: true,
    paths: { allow: [], deny: [] },
    tools: tools.map((tool) => ({
      ...tool,
      enabled: resolveModeEditorItemEnabled({
        runtimeEnabled: tool.enabled,
        allowedInMode: true,
      }),
    })),
    skills: skills.map((skill) => ({
      ...skill,
      enabled: resolveModeEditorItemEnabled({
        runtimeEnabled: skill.enabled,
        allowedInMode: true,
      }),
    })),
  };
}

function readMacSystemAppearance(): CliAppearance | null {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const value = execFileSync("defaults", ["read", "-g", "AppleInterfaceStyle"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return /^dark$/i.test(value) ? "dark" : "light";
  } catch {
    return "light";
  }
}

function createColors(appearance: CliAppearance) {
  if (appearance === "light") {
    return {
      bullet: chalk.hex("#4c9f38"),
      accent: chalk.hex("#0b84c6"),
      userMessageBackground: chalk.bgHex("#e8edf1").hex("#1b1c1d"),
      body: chalk.hex("#1b1c1d"),
      dim: chalk.hex("#6f7d86"),
      thinking: chalk.hex("#98a4ac"),
      gutter: chalk.hex("#8a98a3"),
      error: chalk.hex("#c84b71"),
      heading: chalk.hex("#9a6a00"),
      code: chalk.hex("#b56619"),
      quote: chalk.hex("#6f63c7"),
      diffAdd: chalk.hex("#317d22"),
      diffRemove: chalk.hex("#b63d57"),
      diffAddBand: chalk.bgHex("#e5f5e1").hex("#317d22"),
      diffRemoveBand: chalk.bgHex("#fde7eb").hex("#b63d57"),
    };
  }

  return {
    bullet: chalk.hex("#9bd47d"),
    accent: chalk.hex("#7dd3fc"),
    userMessageBackground: chalk.bgHex("#242628"),
    body: chalk.hex("#d8dee9"),
    dim: chalk.hex("#7f8c92"),
    thinking: chalk.hex("#a7b3ba"),
    gutter: chalk.hex("#8b9aa0"),
    error: chalk.hex("#ff7aa8"),
    heading: chalk.hex("#f8e07f"),
    code: chalk.hex("#f3b37a"),
    quote: chalk.hex("#b9a7ff"),
    diffAdd: chalk.hex("#9bd47d"),
    diffRemove: chalk.hex("#ff7a90"),
    diffAddBand: chalk.bgHex("#1d3022").hex("#9bd47d"),
    diffRemoveBand: chalk.bgHex("#372026").hex("#ff7a90"),
  };
}

const cliAppearance = resolveCliAppearance({
  env: process.env,
  systemAppearance: readMacSystemAppearance(),
});
const colors = createColors(cliAppearance);

const markdownStyles: MarkdownStyles = {
  heading: (text) => chalk.bold(colors.heading(text)),
  bold: (text) => chalk.bold(colors.body(text)),
  italic: (text) => chalk.italic(colors.body(text)),
  strikethrough: (text) => chalk.strikethrough(colors.body(text)),
  code: (text) => colors.code(text),
  codeBlock: (text) => text
    .split("\n")
    .map((line) => colors.dim("│ ") + colors.code(line))
    .join("\n"),
  quote: (text) => `${colors.quote("│")} ${colors.dim(text)}`,
  bullet: (text) => `${colors.bullet("•")} ${text}`,
  link: (text, href) => `${colors.accent(text)} ${colors.dim(`(${href})`)}`,
  rule: () => colors.dim("———"),
  body: (text) => colors.body(text),
  dim: (text) => colors.dim(text),
};

const thinkingStyles = {
  body: (text: string) => colors.thinking(text),
  bold: (text: string) => chalk.bold(colors.thinking(text)),
};

const INPUT_PLACEHOLDER = "Write tests for @filename";
const MODEL_PLACEHOLDER = "configured by .agents/config.json";
const MODEL_EFFORT_LABELS: Record<NonNullable<Options["effort"]>, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
};
const PERMISSION_MODE = "default" as const;
const SPINNER_FRAMES = ["⡉", "⠉", "⠋", "⠓", "⠒", "⠐", "⠰", "⢠", "⣀", "⣄", "⣆", "⣇", "⣧", "⣷", "⣿", "⡿", "⠿", "⢟", "⠟", "⡛"];
let responseQueue = Promise.resolve();
let promptValue = "";
let promptCursorIndex = 0;
let promptVisible = false;
let promptBlockLines = 0;
let promptCursorLineIndex = 0;
let promptLoopStarted = false;
let approvalPromptActive = false;
let approvalPrompt: ApprovalPromptState | null = null;
let userQuestionPromptActive = false;
let userQuestionPrompt: UserQuestionPromptState | null = null;
let promptIsSubmitting = false;
let liveBlockFrozen = false;
let activeRun: Query | null = null;
let activeTaskId: string | null = null;
let activeSessionId: string | null = null;
let stopRequested = false;
let spinnerFrameIndex = 0;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
const pendingPrompts: string[] = [];
const promptWaiters: Array<(value: string) => void> = [];
const promptHistory: string[] = [];
let promptHistoryIndex: number | null = null;
let promptDraftBeforeHistory = "";
let bracketedPasteEnabled = false;
let liveBlockLines = 0;
let liveBlockText = "";
let activeModel = MODEL_PLACEHOLDER;
let activeModelContextWindow: number | null = null;
let activeEffort: NonNullable<Options["effort"]> = "medium";
let activeBranchName: string | null = null;
let activeModeId = "default";
let activePermissionMode: NonNullable<Options["permissionMode"]> = PERMISSION_MODE;
let requestedPermissionMode: NonNullable<Options["permissionMode"]> = PERMISSION_MODE;
let resizeHandlerAttached = false;
let resizeRedrawTimer: ReturnType<typeof setTimeout> | undefined;
let resizeRedrawInProgress = false;
let promptRenderState: PromptRenderState | null = null;
let pendingSuccessfulEdit:
  | {
      filePath: string;
    }
  | null = null;
let lastVisibleToolOutput: string | null = null;
let pendingToolEchoText = "";
const activeCwd = process.cwd();
const sessionUsageTotals: PromptUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalCostUsd: 0,
  contextWindow: null,
  providerLabel: null,
  effort: activeEffort,
  subscription: false,
  autoCompact: false,
};
const activeProjectName = path.basename(activeCwd);
const toolCalls = new Map<string, ToolCallRecord>();
const bashRuns = new Map<string, BashRunRecord>();
let modelPicker: ModelPickerState | null = null;
let configPicker: ConfigPickerState | null = null;
let modePicker: ModePickerState | null = null;
let streamedAssistantText = "";
let streamedAssistantVisibleText = "";
let pendingAssistantStreamText = "";
let streamedAssistantActive = false;
let streamedThinkingText = "";
let streamedThinkingVisibleText = "";
let pendingThinkingStreamText = "";
let streamedThinkingActive = false;
let completedStreamedThinkingText = "";
let streamRedrawTimer: ReturnType<typeof setTimeout> | undefined;
let trailingNewlineCount = 0;
const transcriptBlocks: TranscriptBlock[] = [];
let transcriptRowCount = 0;
let activeMentionSuggestions: MentionSuggestion[] = [];
let activeMentionSelectionIndex = 0;
let activeTodoPanel: TodoPanel | null = null;

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const MENTION_VISIBLE_ROWS = 6;
const LIVE_TERMINAL_VISIBLE_ROWS = 12;
const STREAM_REDRAW_FRAME_MS = 32;
const MENTION_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  ".cache",
]);

function getEffortOptionsForModel(modelSlug: string): Array<NonNullable<Options["effort"]>> {
  const slug = modelSlug.toLowerCase();

  if (slug.startsWith("gpt-5-pro")) {
    return ["high"];
  }

  if (slug.startsWith("gpt-5.4-pro") || slug.startsWith("gpt-5.2-pro") || slug.startsWith("gpt-5.5-pro")) {
    return ["medium", "high", "xhigh"];
  }

  if (slug.startsWith("gpt-5.2-codex") || slug.startsWith("gpt-5.3-codex")) {
    return ["low", "medium", "high", "xhigh"];
  }

  if (slug.startsWith("gpt-5.1-codex-max")) {
    return ["none", "medium", "high", "xhigh"];
  }

  if (
    slug.startsWith("gpt-5.2") ||
    slug.startsWith("gpt-5.4") ||
    slug.startsWith("gpt-5.5")
  ) {
    return ["none", "low", "medium", "high", "xhigh"];
  }

  if (slug.startsWith("gpt-5.1")) {
    return ["none", "low", "medium", "high"];
  }

  if (slug.startsWith("gpt-5")) {
    return ["minimal", "low", "medium", "high"];
  }

  return ["low", "medium", "high"];
}

function resolvePickerEffort(modelSlug: string, effort: Options["effort"]): NonNullable<Options["effort"]> {
  const supported = getEffortOptionsForModel(modelSlug);
  if (effort && supported.includes(effort)) {
    return effort;
  }

  if (supported.includes(activeEffort)) {
    return activeEffort;
  }

  return supported[0] ?? "medium";
}

function getOpenAIPricePerMillionTokens(modelSlug: string): { input: number; output: number } | null {
  const slug = modelSlug.toLowerCase();

  if (slug.startsWith("gpt-5.5-pro")) {
    return { input: 30, output: 180 };
  }

  if (slug.startsWith("gpt-5.5")) {
    return { input: 5, output: 30 };
  }

  if (slug.startsWith("gpt-5.4-mini")) {
    return { input: 0.75, output: 4.5 };
  }

  if (slug.startsWith("gpt-5.4-nano")) {
    return { input: 0.2, output: 1.25 };
  }

  if (slug.startsWith("gpt-5.4")) {
    return { input: 2.5, output: 15 };
  }

  return null;
}

function estimateOpenAICostUsd(modelSlug: string, usage: { input_tokens: number; output_tokens: number }): number {
  const price = getOpenAIPricePerMillionTokens(modelSlug);
  if (!price) {
    return 0;
  }

  return ((usage.input_tokens * price.input) + (usage.output_tokens * price.output)) / 1_000_000;
}

function formatRunCostUsd(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value < 0.001 ? `$${value.toFixed(4)}` : `$${value.toFixed(3)}`;
}

function applyActiveModelMetadata(models: OpenAISubscriptionModel[]): void {
  const model = models.find((candidate) => candidate.slug === activeModel);
  activeModelContextWindow = model?.maxContextWindow ?? model?.contextWindow ?? activeModelContextWindow;
  sessionUsageTotals.contextWindow = activeModelContextWindow;
  if (model) {
    sessionUsageTotals.providerLabel = "openai-codex";
    sessionUsageTotals.subscription = true;
  }
  sessionUsageTotals.effort = activeEffort;
}

async function refreshActiveModelMetadata(): Promise<void> {
  try {
    applyActiveModelMetadata(await listOpenAISubscriptionModels());
    if (promptLoopStarted) {
      renderPromptLine(promptValue);
    }
  } catch {
    // Context-window metadata is best-effort; token totals still render without it.
  }
}

function formatModelPickerName(model: OpenAISubscriptionModel): string {
  return model.displayName && model.displayName.trim().length > 0 ? model.displayName.trim() : model.slug;
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

function renderInterruptedMessage(): void {
  appendTranscript(`${colors.dim("Interrupted.")}\n`);
}

function hydrateEnvFromLaunchctl(variableName: string): void {
  if (process.env[variableName] || process.platform !== "darwin") {
    return;
  }

  try {
    const value = execFileSync("launchctl", ["getenv", variableName], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (value) {
      process.env[variableName] = value;
    }
  } catch {
    // Best-effort bridge for terminals opened before launchctl env updates.
  }
}

hydrateEnvFromLaunchctl("OPENROUTER_API_KEY");

const client = new PinocchioSDKClient({
  cwd: process.cwd(),
  permissionMode: PERMISSION_MODE,
});

async function loadInitialRuntimeSettings(): Promise<void> {
  try {
    const runtime = await loadProjectRuntime(process.cwd());
    if (runtime.config.model) {
      activeModel = runtime.config.model;
    }
    if (runtime.config.effort) {
      activeEffort = runtime.config.effort;
    }
  } catch {
    // The SDK will report configuration errors when a run starts.
  }
}

function loadBranchName(): void {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: activeCwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    activeBranchName = branch.length > 0 ? branch : null;
  } catch {
    activeBranchName = null;
  }
}

function clearPromptBlock(): void {
  if (!promptVisible || !promptRenderState) {
    return;
  }

  const layout = calculatePromptLayout({
    columns: Math.max(1, output.columns ?? 80),
    cursorColumn: promptRenderState.cursorColumn,
    inputLineIndex: promptRenderState.inputLineIndex,
    lines: promptRenderState.lines,
  });
  const linesBelowCursor = layout.totalRows - 1 - layout.cursorRowIndex;

  cursorTo(output, 0);
  if (linesBelowCursor > 0) {
    moveCursor(output, 0, linesBelowCursor);
  }

  for (let index = layout.totalRows - 1; index >= 0; index -= 1) {
    output.write("\x1b[2K");
    if (index > 0) {
      moveCursor(output, 0, -1);
      cursorTo(output, 0);
    }
  }

  promptVisible = false;
  promptBlockLines = 0;
  promptCursorLineIndex = 0;
  promptRenderState = null;
}

function writeTranscript(text = ""): void {
  const shouldRestorePrompt = promptVisible;
  const plainText = text.replace(ANSI_PATTERN, "");

  if (shouldRestorePrompt) {
    clearPromptBlock();
  }

  output.write(text);
  for (const char of plainText) {
    if (char === "\n") {
      trailingNewlineCount += 1;
    } else {
      trailingNewlineCount = 0;
    }
  }

  if (shouldRestorePrompt) {
    renderPromptLine(promptValue);
  }
}

function recordTranscriptRawBlock(text: string): void {
  if (!text) {
    return;
  }

  const lastBlock = transcriptBlocks.at(-1);
  if (lastBlock?.kind === "raw") {
    lastBlock.text += text;
    return;
  }

  transcriptBlocks.push({
    kind: "raw",
    text,
  });
}

function renderAssistantPlainTranscript(text: string, columns = Math.max(1, output.columns ?? 80)): string {
  return formatWrappedAssistantTranscriptBlock(text, columns, colors.body);
}

function renderAssistantThinkingTranscript(text: string, columns = Math.max(1, output.columns ?? 80)): string {
  return formatWrappedAssistantTranscriptBlock(
    text,
    columns,
    (wrapped) => renderThinkingEmphasis(wrapped, thinkingStyles),
  );
}

function liveTerminalWidthForColumns(columns: number): number {
  return Math.max(32, Math.min(120, Math.max(1, columns) - 1));
}

function renderLiveTerminalTranscript(block: LiveTerminalTranscriptBlock, columns: number): string {
  return `${colors.body(formatLiveTerminalFrame({
    title: block.title,
    width: liveTerminalWidthForColumns(columns),
    height: block.height,
    elapsedMs: block.elapsedMs,
    lines: block.lines,
  }))}\n`;
}

function renderTranscriptBlock(block: TranscriptBlock): string {
  if (block.kind === "assistantPlain") {
    return renderAssistantPlainTranscript(block.text);
  }

  if (block.kind === "assistantThinking") {
    return renderAssistantThinkingTranscript(block.text);
  }

  if (block.kind === "liveTerminal") {
    return renderLiveTerminalTranscript(block, Math.max(1, output.columns ?? 80));
  }

  return block.text;
}

function renderTranscriptBlockForWidth(block: TranscriptBlock, columns: number): string {
  if (block.kind === "liveTerminal") {
    return renderLiveTerminalTranscript(block, columns);
  }

  if (block.kind === "assistantPlain") {
    return renderAssistantPlainTranscript(block.text, Math.max(1, columns));
  }

  if (block.kind === "assistantThinking") {
    return renderAssistantThinkingTranscript(block.text, Math.max(1, columns));
  }

  return block.kind === "raw"
    ? wrapRenderedAnsiText(renderTranscriptBlock(block), Math.max(1, columns))
    : renderTranscriptBlock(block);
}

function renderStreamingAssistantLiveBlock(columns: number): string {
  if (streamedThinkingActive && streamedThinkingVisibleText.length > 0) {
    return formatWrappedAssistantTranscriptBlock(
      streamedThinkingVisibleText,
      columns,
      (wrapped) => renderThinkingEmphasis(wrapped, thinkingStyles),
    );
  }

  if (streamedAssistantActive && streamedAssistantVisibleText.length > 0) {
    return formatWrappedAssistantTranscriptBlock(streamedAssistantVisibleText, columns, colors.body);
  }

  return "";
}

function countRenderedRows(text: string, columns: number): number {
  const safeColumns = Math.max(1, columns);
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return 0;
  }

  return lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(visibleLength(line) / safeColumns)), 0);
}

function recomputeTranscriptRowCount(): void {
  const columns = Math.max(1, output.columns ?? 80);
  transcriptRowCount = transcriptBlocks.reduce(
    (sum, block) => sum + countRenderedRows(renderTranscriptBlockForWidth(block, columns), columns),
    0,
  );
}

function appendTranscript(text = ""): void {
  writeTranscript(text);
  recordTranscriptRawBlock(text);
  recomputeTranscriptRowCount();
}

function appendTranscriptWithReplayText(liveText: string, replayText: string): void {
  writeTranscript(liveText);
  recordTranscriptRawBlock(replayText);
  recomputeTranscriptRowCount();
}

function appendRevealLine(message: string): void {
  appendTranscript(`${colors.gutter("⎿")} ${colors.body(message)}\n`);
}

function recordAssistantPlainTranscript(text: string): void {
  if (!text) {
    return;
  }

  transcriptBlocks.push({
    kind: "assistantPlain",
    text,
  });
}

function recordAssistantThinkingTranscript(text: string): void {
  if (!text) {
    return;
  }

  transcriptBlocks.push({
    kind: "assistantThinking",
    text,
  });
}

function persistAssistantPlainTranscript(text: string): void {
  recordAssistantPlainTranscript(text);
  recomputeTranscriptRowCount();
}

function persistAssistantThinkingTranscript(text: string): void {
  recordAssistantThinkingTranscript(text);
  recomputeTranscriptRowCount();
}

function appendAssistantThinkingTranscript(text: string): void {
  if (!text) {
    return;
  }

  const rendered = renderAssistantThinkingTranscript(text);
  writeTranscript(rendered);
  persistAssistantThinkingTranscript(text);
}

function ensureTranscriptGap(): void {
  const neededNewlines = Math.max(0, 2 - trailingNewlineCount);
  if (neededNewlines > 0) {
    appendTranscript("\n".repeat(neededNewlines));
  }
}

function shouldAttachThinkingToPreviousAssistantBlock(): boolean {
  return transcriptBlocks.at(-1)?.kind === "assistantPlain";
}

function renderPromptLine(value: string): void {
  if (!output.isTTY) {
    return;
  }

  const terminalColumns = Math.max(2, output.columns ?? 80);
  if (userQuestionPrompt) {
    const dividerWidth = Math.max(12, terminalColumns - 1);
    const divider = colors.dim("─".repeat(dividerWidth));
    const promptLayout = buildUserQuestionPromptLines(dividerWidth, divider);
    const layout = calculatePromptLayout({
      columns: terminalColumns,
      cursorColumn: promptLayout.cursorColumn,
      inputLineIndex: promptLayout.inputLineIndex,
      lines: promptLayout.lines,
    });

    clearPromptBlock();
    output.write(promptLayout.lines.join("\n"));
    moveCursor(output, 0, -(layout.totalRows - 1 - layout.cursorRowIndex));
    cursorTo(output, promptLayout.cursorColumn % terminalColumns);
    promptVisible = true;
    promptBlockLines = layout.totalRows;
    promptCursorLineIndex = layout.cursorRowIndex;
    promptRenderState = {
      lines: promptLayout.lines,
      inputLineIndex: promptLayout.inputLineIndex,
      cursorColumn: promptLayout.cursorColumn,
    };
    return;
  }

  if (approvalPrompt) {
    const dividerWidth = Math.max(12, terminalColumns - 1);
    const divider = colors.dim("─".repeat(dividerWidth));
    const lines = buildApprovalPromptLines(dividerWidth, divider);
    const selectedIndex = Math.max(0, approvalPrompt.selectedIndex);
    const optionStartIndex = Math.max(0, lines.length - (approvalPrompt.options.length + 2));
    const inputLineIndex = optionStartIndex + selectedIndex;
    const layout = calculatePromptLayout({
      columns: terminalColumns,
      cursorColumn: 0,
      inputLineIndex,
      lines,
    });

    clearPromptBlock();
    output.write(lines.join("\n"));
    moveCursor(output, 0, -(layout.totalRows - 1 - layout.cursorRowIndex));
    cursorTo(output, 0);
    promptVisible = true;
    promptBlockLines = layout.totalRows;
    promptCursorLineIndex = layout.cursorRowIndex;
    promptRenderState = {
      lines,
      inputLineIndex,
      cursorColumn: 0,
    };
    return;
  }

  if (configPicker) {
    const dividerWidth = Math.max(12, terminalColumns - 1);
    const divider = colors.dim("─".repeat(dividerWidth));
    const lines = buildConfigPickerLines(divider);
    const inputLineIndex = Math.max(0, lines.length - 1);
    const layout = calculatePromptLayout({
      columns: terminalColumns,
      cursorColumn: 0,
      inputLineIndex,
      lines,
    });

    clearPromptBlock();
    output.write(lines.join("\n"));
    moveCursor(output, 0, -(layout.totalRows - 1 - layout.cursorRowIndex));
    cursorTo(output, 0);
    promptVisible = true;
    promptBlockLines = layout.totalRows;
    promptCursorLineIndex = layout.cursorRowIndex;
    promptRenderState = {
      lines,
      inputLineIndex,
      cursorColumn: 0,
    };
    return;
  }

  if (modelPicker) {
    const dividerWidth = Math.max(12, terminalColumns - 1);
    const divider = colors.dim("─".repeat(dividerWidth));
    const lines = buildModelPickerLines(divider);
    const inputLineIndex = Math.max(0, lines.length - 1);
    const layout = calculatePromptLayout({
      columns: terminalColumns,
      cursorColumn: 0,
      inputLineIndex,
      lines,
    });

    clearPromptBlock();
    output.write(lines.join("\n"));
    moveCursor(output, 0, -(layout.totalRows - 1 - layout.cursorRowIndex));
    cursorTo(output, 0);
    promptVisible = true;
    promptBlockLines = layout.totalRows;
    promptCursorLineIndex = layout.cursorRowIndex;
    promptRenderState = {
      lines,
      inputLineIndex,
      cursorColumn: 0,
    };
    return;
  }

  if (modePicker) {
    const dividerWidth = Math.max(12, terminalColumns - 1);
    const divider = colors.dim("─".repeat(dividerWidth));
    const lines = buildModePickerLines(divider);
    const inputLineIndex = Math.max(0, lines.length - 1);
    const layout = calculatePromptLayout({
      columns: terminalColumns,
      cursorColumn: 0,
      inputLineIndex,
      lines,
    });

    clearPromptBlock();
    output.write(lines.join("\n"));
    moveCursor(output, 0, -(layout.totalRows - 1 - layout.cursorRowIndex));
    cursorTo(output, 0);
    promptVisible = true;
    promptBlockLines = layout.totalRows;
    promptCursorLineIndex = layout.cursorRowIndex;
    promptRenderState = {
      lines,
      inputLineIndex,
      cursorColumn: 0,
    };
    return;
  }

  const prompt = `${colors.accent("▌")} `;
  const continuationPrompt = "  ";
  const dividerWidth = Math.max(12, terminalColumns - 1);
  const divider = colors.dim("─".repeat(dividerWidth));
  const inputLines = value.length > 0
    ? value.split("\n").map((line, index) => `${index === 0 ? prompt : continuationPrompt}${colors.body(line)}`)
    : [`${prompt}${colors.dim(INPUT_PLACEHOLDER)}`];
  const statusLine = renderRunStatusLine();
  const panelLines = renderTodoPanelLines();
  const mentionViewport = resolveMentionViewport(
    activeMentionSuggestions.length,
    activeMentionSelectionIndex,
    MENTION_VISIBLE_ROWS,
  );
  const suggestionLines = activeMentionSuggestions
    .slice(mentionViewport.startIndex, mentionViewport.endIndex)
    .map((suggestion, visibleIndex) => {
    const index = mentionViewport.startIndex + visibleIndex;
    const label = formatMentionSuggestionLabel(suggestion);
    const selected = index === activeMentionSelectionIndex;
    const pointerPrefix = selected ? `${colors.accent(">")} ` : "  ";
    const text = suggestion.isDirectory ? colors.accent(label) : colors.body(label);
    return `${pointerPrefix}${text}`;
    });
  const footerLines = suggestionLines.length === 0
    ? (() => {
      const plainFooterLines = formatPromptFooter(activeModel, activeCwd, activeModeId, dividerWidth, sessionUsageTotals);
      if (activeModeId === "default") {
        return plainFooterLines.map((line) => colors.dim(line));
      }

      const firstLine = plainFooterLines[0] ?? "";
      const modeSuffix = activeModeId;
      if (!firstLine.endsWith(modeSuffix)) {
        return plainFooterLines.map((line) => colors.dim(line));
      }

      const prefix = firstLine.slice(0, -modeSuffix.length);
      return [
        `${colors.dim(prefix)}${colors.heading(modeSuffix)}`,
        ...plainFooterLines.slice(1).map((line) => colors.dim(line)),
      ];
    })()
    : [];
  const { lines, inputLineIndex } = buildPromptLines({
    divider,
    inputLines,
    panelLines,
    suggestionLines,
    footerLines,
    statusLine,
  });
  const beforeCursorLines = value.slice(0, promptCursorIndex).split("\n");
  const cursorLineOffset = beforeCursorLines.length - 1;
  const cursorPrefix = cursorLineOffset === 0 ? prompt : continuationPrompt;
  const cursorColumn = visibleLength(`${cursorPrefix}${beforeCursorLines.at(-1) ?? ""}`);
  const cursorInputLineIndex = inputLineIndex + cursorLineOffset;
  const layout = calculatePromptLayout({
    columns: terminalColumns,
    cursorColumn,
    inputLineIndex: cursorInputLineIndex,
    lines,
  });

  clearPromptBlock();
  output.write(lines.join("\n"));
  moveCursor(output, 0, -(layout.totalRows - 1 - layout.cursorRowIndex));
  cursorTo(output, cursorColumn % terminalColumns);
  promptVisible = true;
  promptBlockLines = layout.totalRows;
  promptCursorLineIndex = layout.cursorRowIndex;
  promptRenderState = {
    lines,
    inputLineIndex: cursorInputLineIndex,
    cursorColumn,
  };
}

function formatApprovalPreviewLine(line: PreviewLine): string {
  if (line.variant === "diffAdd") {
    return `  ${colors.diffAddBand(` ${line.text}`)}`;
  }

  if (line.variant === "diffRemove") {
    return `  ${colors.diffRemoveBand(` ${line.text}`)}`;
  }

  return `  ${colors.body(line.text)}`;
}

function buildApprovalPromptLines(dividerWidth: number, divider: string): string[] {
  if (!approvalPrompt) {
    return [];
  }

  const toolInput = approvalPrompt.previewLines.map((line) => formatApprovalPreviewLine(line));
  const selectedOption = approvalPrompt.selectedIndex;
  const optionLines = approvalPrompt.options.map((option, index) => {
    const selected = index === selectedOption;
    const prefix = selected ? colors.accent("›") : colors.dim(" ");
    const number = selected ? colors.accent(`${index + 1}.`) : colors.dim(`${index + 1}.`);
    const label = selected ? colors.accent(option.label) : colors.body(option.label);
    return `${prefix} ${number} ${label}`;
  });
  const titleLine = approvalPrompt.toolName === "Edit" || approvalPrompt.toolName === "Write"
    ? chalk.bold(`${colors.heading(`${approvalPrompt.toolName} file`)} ${colors.body(approvalPrompt.message)}`)
    : approvalPrompt.toolName === "Bash"
    ? chalk.bold(colors.heading("Bash command"))
    : null;

  return [
    "",
    `${colors.bullet("●")} ${chalk.bold(colors.body(approvalPrompt.toolSummary))}`,
    ...(titleLine ? ["", titleLine] : []),
    divider,
    ...toolInput,
    divider,
    colors.body(approvalPrompt.question),
    ...optionLines,
    "",
    colors.dim("Esc to cancel"),
  ];
}

function renderRunStatusLine(): string | null {
  if (!activeRun || !spinnerTimer) {
    return null;
  }

  const frame = SPINNER_FRAMES[spinnerFrameIndex % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
  const label = stopRequested ? "Stopping..." : "Streaming...  (Press ESC to stop)";
  return `${colors.accent(frame)} ${colors.dim(label)}`;
}

function startRunSpinner(): void {
  if (!output.isTTY || spinnerTimer) {
    return;
  }

  spinnerTimer = setInterval(() => {
    spinnerFrameIndex = (spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
    renderPromptLine(promptValue);
  }, 80);
}

function stopRunSpinner(): void {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  }

  spinnerFrameIndex = 0;
}

async function stopActiveRun(): Promise<void> {
  if (!activeRun || stopRequested) {
    return;
  }

  stopRequested = true;
  renderPromptLine(promptValue);
  await activeRun.stopTask(activeTaskId ?? "active");
}

function resolveNextPrompt(value: string): void {
  const waiter = promptWaiters.shift();

  if (waiter) {
    waiter(value);
    return;
  }

  pendingPrompts.push(value);
}

function getLiveMentionCandidates(): MentionCandidate[] {
  const mention = findActiveMention(promptValue, promptCursorIndex);
  if (!mention) {
    return [];
  }

  const { directory } = splitMentionQuery(mention.query);
  const searchDirectory = path.resolve(activeCwd, directory || ".");

  try {
    return readdirSync(searchDirectory, { withFileTypes: true })
      .filter((entry) => entry.name !== "." && entry.name !== "..")
      .filter((entry) => !entry.isDirectory() || !MENTION_IGNORED_DIRECTORIES.has(entry.name))
      .map((entry) => ({
        path: `${directory}${entry.name}`.replaceAll("\\", "/"),
        isDirectory: entry.isDirectory(),
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  } catch {
    return [];
  }
}

function updateMentionSuggestions(): void {
  const previousReplacement = activeMentionSuggestions[activeMentionSelectionIndex]?.replacement ?? null;
  const activeMentionResolution = resolveMentionSuggestions(
    getLiveMentionCandidates(),
    promptValue,
    promptCursorIndex,
  );
  activeMentionSuggestions = activeMentionResolution?.suggestions ?? [];

  if (activeMentionSuggestions.length === 0) {
    activeMentionSelectionIndex = 0;
    return;
  }

  const retainedIndex = previousReplacement
    ? activeMentionSuggestions.findIndex((suggestion) => suggestion.replacement === previousReplacement)
    : -1;
  activeMentionSelectionIndex = retainedIndex >= 0 ? retainedIndex : 0;
}

function moveMentionSelection(delta: number): void {
  if (activeMentionSuggestions.length === 0) {
    return;
  }

  const count = activeMentionSuggestions.length;
  activeMentionSelectionIndex = (activeMentionSelectionIndex + delta + count) % count;
  renderPromptLine(promptValue);
}

function applySelectedMention(): void {
  const activeMentionResolution = resolveMentionSuggestions(
    getLiveMentionCandidates(),
    promptValue,
    promptCursorIndex,
  );
  if (!activeMentionResolution) {
    return;
  }

  const suggestion = activeMentionSuggestions[activeMentionSelectionIndex];
  if (!suggestion) {
    return;
  }

  const nextValue =
    promptValue.slice(0, activeMentionResolution.replaceStart) +
    suggestion.replacement +
    promptValue.slice(activeMentionResolution.replaceEnd);
  setPromptValue(nextValue, activeMentionResolution.replaceStart + suggestion.replacement.length);
}

function setPromptValue(value: string, cursorIndex = value.length): void {
  promptValue = value;
  promptCursorIndex = Math.max(0, Math.min(cursorIndex, promptValue.length));
  updateMentionSuggestions();
  renderPromptLine(promptValue);
}

function redrawTranscriptForResize(): void {
  if (resizeRedrawInProgress) {
    return;
  }

  resizeRedrawInProgress = true;
  clearPromptBlock();

  try {
    output.write("\x1b[H\x1b[2J\x1b[3J");
    trailingNewlineCount = 0;
    const columns = Math.max(1, output.columns ?? 80);

    for (const block of transcriptBlocks) {
      writeTranscript(renderTranscriptBlockForWidth(block, columns));
    }

    const resizedLiveBlockText = renderStreamingAssistantLiveBlock(columns) || liveBlockText;
    if (resizedLiveBlockText.length > 0) {
      liveBlockText = resizedLiveBlockText;
      output.write(liveBlockText);
      if (!resizedLiveBlockText.endsWith("\n")) {
        output.write("\n");
      }
      liveBlockLines = countBlockLines(liveBlockText);
    } else {
      liveBlockText = "";
      liveBlockLines = 0;
    }

    renderPromptLine(promptValue);
  } finally {
    resizeRedrawInProgress = false;
  }
}

function redrawCliOnce(): void {
  if (!input.isTTY || !output.isTTY) {
    return;
  }

  redrawTranscriptForResize();
}

function redrawTranscriptInPlace(extraRows = 0): void {
  if (!output.isTTY) {
    return;
  }

  const columns = Math.max(1, output.columns ?? 80);
  const shouldRestorePrompt = promptVisible;
  if (shouldRestorePrompt) {
    clearPromptBlock();
  }

  const rowsToTop = Math.max(0, transcriptRowCount + extraRows);
  if (rowsToTop > 0) {
    moveCursor(output, 0, -rowsToTop);
    cursorTo(output, 0);
  }

  output.write("\x1b[J");
  trailingNewlineCount = 0;

  for (const block of transcriptBlocks) {
    output.write(renderTranscriptBlockForWidth(block, columns));
  }
  recomputeTranscriptRowCount();

  if (shouldRestorePrompt) {
    renderPromptLine(promptValue);
  }
}

function handleTerminalResize(): void {
  if (!input.isTTY || !output.isTTY || !promptLoopStarted || approvalPromptActive || userQuestionPromptActive) {
    return;
  }

  if (transcriptBlocks.length > 0 || liveBlockLines > 0 || streamedAssistantActive || streamedThinkingActive) {
    if (resizeRedrawTimer) {
      clearTimeout(resizeRedrawTimer);
    }

    resizeRedrawTimer = setTimeout(() => {
      resizeRedrawTimer = undefined;
      redrawTranscriptForResize();
    }, 24);
    return;
  }

  renderPromptLine(promptValue);
}

function rememberPrompt(value: string): void {
  if (promptHistory[promptHistory.length - 1] !== value) {
    promptHistory.push(value);
  }

  promptHistoryIndex = null;
  promptDraftBeforeHistory = "";
}

function showPreviousPrompt(): void {
  if (promptHistory.length === 0) {
    return;
  }

  if (promptHistoryIndex === null) {
    promptDraftBeforeHistory = promptValue;
    promptHistoryIndex = promptHistory.length - 1;
  } else {
    promptHistoryIndex = Math.max(0, promptHistoryIndex - 1);
  }

  setPromptValue(promptHistory[promptHistoryIndex] ?? "");
}

function showNextPrompt(): void {
  if (promptHistoryIndex === null) {
    return;
  }

  if (promptHistoryIndex >= promptHistory.length - 1) {
    promptHistoryIndex = null;
    setPromptValue(promptDraftBeforeHistory);
    promptDraftBeforeHistory = "";
    return;
  }

  promptHistoryIndex += 1;
  setPromptValue(promptHistory[promptHistoryIndex] ?? "");
}

function insertPromptText(text: string): void {
  if (!text) {
    return;
  }

  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  promptValue =
    promptValue.slice(0, promptCursorIndex) +
    normalizedText +
    promptValue.slice(promptCursorIndex);
  promptCursorIndex += normalizedText.length;
  promptHistoryIndex = null;
  updateMentionSuggestions();
  renderPromptLine(promptValue);
}

function printHelp(): void {
  appendTranscript([
    `${colors.bullet("●")} ${chalk.bold(colors.body("Commands"))}`,
    `     ${colors.accent("/connect")} ${colors.dim("connect ChatGPT subscription for OpenAI Codex models")}`,
    `     ${colors.accent("/config")} ${colors.dim("enable or disable tools and skills")}`,
    `     ${colors.accent("/disconnect")} ${colors.dim("remove the ChatGPT subscription connection")}`,
    `     ${colors.accent("/help")} ${colors.dim("show commands and keybindings")}`,
    `     ${colors.accent("/init")} ${colors.dim("create a local .agents runtime in the current folder")}`,
    `     ${colors.accent("/status")} ${colors.dim("show workspace, branch, model, mode, and approval mode")}`,
    `     ${colors.accent("/model")} ${colors.dim("open model picker")}`,
    `     ${colors.accent("/mode")} ${colors.dim("open mode editor")}`,
    `     ${colors.accent("/permissions")} ${colors.dim("show the active approval mode")}`,
    `     ${colors.accent("/clear")} ${colors.dim("clear the terminal")}`,
    `     ${colors.accent("/quit")} ${colors.dim("exit Pino")}`,
    "",
    `${colors.bullet("●")} ${chalk.bold(colors.body("Keys"))}`,
    `     ${colors.accent("enter")} ${colors.dim("send prompt")}`,
    `     ${colors.accent("ctrl+j")} ${colors.dim("new line")}`,
    `     ${colors.accent("option/alt+enter")} ${colors.dim("new line when terminal sends Meta")}`,
    `     ${colors.accent("up/down")} ${colors.dim("browse prompt history")}`,
    `     ${colors.accent("shift+tab")} ${colors.dim("cycle between default and saved modes")}`,
    `     ${colors.accent("tab")} ${colors.dim("accept selected @file or @folder mention")}`,
    `     ${colors.accent("left/right")} ${colors.dim("move cursor")}`,
    `     ${colors.accent("ctrl+a/e")} ${colors.dim("jump to start/end")}`,
    `     ${colors.accent("ctrl+u/k")} ${colors.dim("clear before/after cursor")}`,
    `     ${colors.accent("ctrl+r / cmd+r")} ${colors.dim("rerender the terminal")}`,
    `     ${colors.accent("esc")} ${colors.dim("stop active run")}`,
    "\n",
  ].join("\n"));
}

async function openExternalUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

async function connectOpenAISubscription(): Promise<void> {
  try {
    appendTranscript(`${colors.bullet("●")} ${colors.body("Starting ChatGPT subscription connection...")}\n`);
    const auth = await connectOpenAISubscriptionWithBrowser({
      onAuthorize: ({ url, instructions }) => {
        appendTranscript([
          `${colors.bullet("●")} ${colors.body(instructions)}`,
          `     ${colors.accent(url)}`,
          "",
        ].join("\n"));
      },
      openUrl: openExternalUrl,
    });
    const config = await configureOpenAISubscriptionRuntime(activeCwd);
    activeModel = config.model || activeModel;

    appendTranscript(
      `${colors.bullet("●")} ${colors.body(
        `Connected ChatGPT subscription${auth.accountId ? ` (${auth.accountId})` : ""}. Active model: ${activeModel}.`,
      )}\n\n`,
    );
  } catch (error) {
    appendTranscript(`${colors.error("Connection failed:")} ${String(error instanceof Error ? error.message : error)}\n\n`);
  }
}

async function disconnectOpenAISubscription(): Promise<void> {
  try {
    const existing = await loadOpenAISubscriptionAuth();
    await removeOpenAISubscriptionAuth();
    appendTranscript(
      `${colors.bullet("●")} ${colors.body(
        existing ? "Disconnected ChatGPT subscription." : "No ChatGPT subscription connection was stored.",
      )}\n\n`,
    );
  } catch (error) {
    appendTranscript(`${colors.error("Disconnect failed:")} ${String(error instanceof Error ? error.message : error)}\n\n`);
  }
}

async function initializeProjectRuntime(): Promise<void> {
  try {
    const result = await createProjectRuntimeScaffold(activeCwd);
    const label = path.relative(activeCwd, result.runtimeDir) || ".agents";
    appendTranscript(
      `${colors.bullet("●")} ${colors.body(
        result.created
          ? `Created local runtime in ${label}.`
          : `Local runtime already exists in ${label}.`,
      )}\n\n`,
    );
  } catch (error) {
    appendTranscript(`${colors.error("Init failed:")} ${String(error instanceof Error ? error.message : error)}\n\n`);
  }
}

function formatPlanType(planType: string | undefined): string {
  if (!planType) {
    return "Unknown";
  }

  switch (planType) {
    case "prolite":
      return "Pro Lite";
    case "self_serve_business_usage_based":
      return "Business (usage-based)";
    case "enterprise_cbp_usage_based":
      return "Enterprise (usage-based)";
    default:
      return planType
        .split("_")
        .filter((segment) => segment.length > 0)
        .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
        .join(" ");
  }
}

async function printStatus(): Promise<void> {
  const auth = await loadOpenAISubscriptionAuth();
  const usage = auth ? await getOpenAISubscriptionUsage().catch(() => null) : null;

  function formatDirectoryDisplay(directory: string): string {
    const normalized = path.normalize(directory);
    const homeDir = path.normalize(process.env.HOME ?? "");
    if (homeDir && normalized === homeDir) {
      return "~";
    }
    if (homeDir && normalized.startsWith(homeDir + path.sep)) {
      return `~${normalized.slice(homeDir.length).split(path.sep).join("/")}`;
    }
    return normalized.split(path.sep).join("/");
  }

  function formatPermissionsDisplay(permissionMode: string): string {
    if (permissionMode === "bypassPermissions") {
      return "Bypass";
    }
    if (permissionMode === "acceptEdits") {
      return "Custom (auto-edit)";
    }
    return "Custom (read-only, on-request)";
  }

  function buildBar(percentLeft: number): string {
    const segments = 20;
    const clamped = Math.max(0, Math.min(100, percentLeft));
    const filled = Math.round((clamped / 100) * segments);
    return `[${"█".repeat(filled)}${"░".repeat(segments - filled)}]`;
  }

  function formatResetAt(epochSeconds: number | undefined): string | null {
    if (typeof epochSeconds !== "number") {
      return null;
    }

    const resetDate = new Date(epochSeconds * 1000);
    const now = new Date();
    const time = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(resetDate);
    const sameDay = resetDate.getFullYear() === now.getFullYear()
      && resetDate.getMonth() === now.getMonth()
      && resetDate.getDate() === now.getDate();

    if (sameDay) {
      return time;
    }

    const day = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
    }).format(resetDate);
    return `${time} on ${day}`;
  }

  function appendStatusRow(label: string, value: string, continuation?: string): void {
    const labelWidth = 18;
    appendTranscript(`${colors.body(label.padEnd(labelWidth, " "))}${colors.body(value)}\n`);
    if (continuation) {
      appendTranscript(`${" ".repeat(labelWidth)}${colors.dim(continuation)}\n`);
    }
  }

  function appendLimitRow(label: string, window: OpenAISubscriptionUsage["primaryWindow"]): void {
    if (!window) {
      return;
    }

    const left = Math.max(0, Math.min(100, 100 - window.usedPercent));
    const line = `${buildBar(left)} ${left}% left`;
    const resetAt = formatResetAt(window.resetAt);
    const continuation = resetAt ? `(resets ${resetAt})` : undefined;
    appendStatusRow(label, line, continuation);
  }

  function formatModelDisplay(model: string): string {
    if (model.startsWith("gpt-") || model.startsWith("codex")) {
      return `${model} (reasoning medium, summaries auto)`;
    }
    return model;
  }

  appendTranscript("\n");
  const accountValue = usage?.email
    ? `${usage.email} (${formatPlanType(usage.planType)})`
    : auth
    ? formatPlanType(usage?.planType)
    : "Not connected";
  appendStatusRow("Account:", accountValue);
  appendStatusRow("Directory:", formatDirectoryDisplay(activeCwd));
  appendStatusRow("Permissions:", formatPermissionsDisplay(activePermissionMode));
  appendStatusRow("Model:", formatModelDisplay(activeModel));
  appendStatusRow("Mode:", activeModeId);
  appendStatusRow("Session:", activeSessionId ?? "<none>");

  if (usage?.primaryWindow) {
    const primaryLabel = usage.primaryWindow.windowSeconds === 604_800
      ? "Weekly limit:"
      : `${formatLimitWindowLabel(usage.primaryWindow.windowSeconds)} limit:`;
    appendLimitRow(primaryLabel, usage.primaryWindow);
  }

  if (usage?.secondaryWindow) {
    appendLimitRow("Weekly limit:", usage.secondaryWindow);
  }

  if (usage?.limitReached) {
    appendStatusRow("Limits:", "Usage limit reached");
  } else if (!usage && auth) {
    appendStatusRow("Limits:", "Unavailable");
  }

  appendTranscript("\n");
}

function buildModelPickerLines(divider: string): string[] {
  if (!modelPicker) {
    return [];
  }

  const picker = modelPicker;
  const selectedModel = picker.models[picker.selectedIndex];
  const effortOptions = selectedModel ? getEffortOptionsForModel(selectedModel.slug) : [];
  const effortText = effortOptions
    .map((effort) => effort === picker.selectedEffort ? colors.body(MODEL_EFFORT_LABELS[effort]) : colors.dim(MODEL_EFFORT_LABELS[effort]))
    .join(colors.dim("  "));
  const lines = [
    divider,
    "",
    colors.accent("Select model"),
    colors.dim("Switch between available OpenAI models. Saves this selection to runtime config"),
    colors.dim("for this session and the next prompt. Use left/right to set effort."),
    "",
  ];

  picker.models.forEach((model, index) => {
    const selected = index === picker.selectedIndex;
    const pointer = selected ? colors.accent("›") : colors.dim(" ");
    const activeMarker = model.slug === activeModel ? colors.bullet("✓") : colors.dim(" ");
    const label = formatModelPickerName(model);
    const left = `${index + 1}. ${label}`;
    const nameText = model.slug === activeModel
      ? colors.bullet(left)
      : selected
        ? colors.body(left)
        : colors.accent(left);
    lines.push(`${pointer} ${nameText} ${activeMarker}`.trimEnd());
  });

  if (selectedModel) {
    lines.push("");
    lines.push(`  ${colors.accent("◇")} ${colors.body(`${MODEL_EFFORT_LABELS[picker.selectedEffort]} effort`)} ${colors.dim("← → to adjust")}`);
    lines.push(`    ${effortText}`);
  }

  lines.push(divider);
  lines.push(picker.saving
    ? colors.dim("Saving model and effort...")
    : colors.dim("↑/↓ select  ←/→ effort  enter save  esc cancel"));

  return lines;
}

function buildModePickerLines(divider: string): string[] {
  if (!modePicker) {
    return [];
  }

  const picker = modePicker;
  const lines = [
    divider,
  ];

  if (picker.view === "modes") {
    const entries = [
      ...picker.modes.map((mode) => ({
        id: mode.id,
        name: mode.name,
        description: mode.description,
        source: mode.source,
      })),
      {
        id: "__create__",
        name: "Create mode",
        description: "Create a new saved mode with tool and skill toggles.",
        source: undefined,
      },
    ];

    lines.push(`${colors.bullet("●")} ${colors.body("Select a mode to edit")}`);
    entries.forEach((entry, index) => {
      const selected = index === picker.selectedIndex;
      const pointer = selected ? colors.accent(">") : colors.dim(" ");
      const markers = [
        entry.id === activeModeId ? colors.accent("active") : null,
        entry.source ? colors.dim(entry.source) : null,
      ].filter((marker): marker is string => marker !== null);
      const markerText = markers.length > 0
        ? ` ${colors.dim("(")}${markers.join(colors.dim(", "))}${colors.dim(")")}`
        : "";
      lines.push(`${pointer} ${colors.accent(entry.name)}${markerText}`.trimEnd());
    });
    lines.push(divider);
    lines.push(colors.dim("↑/↓ select  enter open  esc cancel"));
    return lines;
  }

  const draft = picker.draft;
  if (!draft) {
    lines.push(divider);
    lines.push(colors.error("Mode editor is missing draft state."));
    return lines;
  }

  const sourceLabel = draft.source
    ? `Saved in ${draft.source === "project" ? "local .agents/modes" : "global .agents/modes"}`
    : "Choose save location";
  lines.push(`${colors.bullet("●")} ${colors.body(`Mode: ${draft.name || "Untitled mode"}`)} ${colors.dim(sourceLabel)}`);

  if (picker.view === "create_name") {
    lines.push(`${colors.bullet("●")} ${colors.body("Name the new mode")}`);
    lines.push(`     ${colors.accent(">")} ${draft.name || colors.dim("Enter mode name")}`);
    lines.push(divider);
    lines.push(colors.dim("type name  enter continue  esc cancel"));
    return lines;
  }

  if (picker.view === "categories") {
    const toolEnabledCount = draft.tools.filter((tool) => tool.enabled).length;
    const skillEnabledCount = draft.skills.filter((skill) => skill.enabled).length;
    const actions = [
      { label: "Tools", count: `${toolEnabledCount}/${draft.tools.length}` },
      { label: "Skills", count: `${skillEnabledCount}/${draft.skills.length}` },
    ];

    if (draft.isCreate) {
      actions.push({ label: "Save mode", count: draft.source ?? draft.modeSource ?? "" });
    }

    lines.push(`${colors.bullet("●")} ${colors.body("Select a section")}`);
    actions.forEach((action, index) => {
      const pointer = index === picker.selectedIndex ? colors.accent(">") : colors.dim(" ");
      const suffix = action.count ? ` ${colors.dim(`(${action.count})`)}` : "";
      lines.push(`${pointer} ${colors.accent(action.label)}${suffix}`.trimEnd());
    });
    lines.push(divider);
    lines.push(colors.dim("↑/↓ select  enter open  esc back"));
    return lines;
  }

  if (picker.view === "tools" || picker.view === "skills") {
    const items = picker.view === "tools" ? draft.tools : draft.skills;
    const title = picker.view === "tools" ? "Toggle tools" : "Toggle skills";
    lines.push(`${colors.bullet("●")} ${colors.body(title)} ${colors.dim(draft.name || "Untitled mode")} ${colors.dim(sourceLabel)}`);
    items.forEach((item, index) => {
      const pointer = index === picker.selectedIndex ? colors.accent(">") : colors.dim(" ");
      const status = item.enabled ? colors.bullet("[on]") : colors.dim("[off]");
      const statusIndent = `${pointer} `;
      lines.push(`${pointer} ${status} ${colors.accent(item.name)}`.trimEnd());
      if (index === picker.selectedIndex && item.description) {
        lines.push(`${statusIndent}${colors.dim(item.description)}`);
      }
    });
    lines.push(divider);
    lines.push(picker.statusMessage ?? colors.dim("↑/↓ select  enter toggle  esc back"));
    return lines;
  }

  if (picker.view === "create_scope") {
    const choices = ["local", "global"];
    lines.push(`${colors.bullet("●")} ${colors.body("Save location")}`);
    choices.forEach((choice, index) => {
      const pointer = index === picker.selectedIndex ? colors.accent(">") : colors.dim(" ");
      const description = choice === "local"
        ? "save into workspace .agents/modes"
        : "save into global .agents/modes";
      lines.push(`     ${pointer} ${colors.accent(choice)}`);
      if (index === picker.selectedIndex) {
        lines.push(`       ${colors.dim(description)}`);
      }
    });
    lines.push(divider);
    lines.push(picker.saving
      ? colors.dim("Saving mode...")
      : (picker.statusMessage ?? colors.dim("↑/↓ select  enter save  esc back")));
    return lines;
  }

  lines.push(divider);
  lines.push(colors.dim("esc cancel"));
  return lines;
}

function buildConfigPickerLines(divider: string): string[] {
  if (!configPicker) {
    return [];
  }

  const picker = configPicker;
  const lines = [
    divider,
    `${colors.bullet("●")} ${colors.body("Configure runtime access")}`,
  ];

  if (picker.section === "categories") {
    const categories: Array<{ key: "tools" | "skills"; label: string; count: number }> = [
      { key: "tools", label: "Tools", count: picker.tools.length },
      { key: "skills", label: "Skills", count: picker.skills.length },
    ];

    categories.forEach((category, index) => {
      const pointer = index === picker.selectedIndex ? colors.accent(">") : colors.dim(" ");
      lines.push(`${pointer} ${colors.accent(category.label)} ${colors.dim(`(${category.count})`)}`);
    });
    lines.push(divider);
    lines.push(colors.dim("↑/↓ select  enter open  esc close"));
    return lines;
  }

  const items = picker.section === "tools" ? picker.tools : picker.skills;
  const title = picker.section === "tools" ? "Toggle tools" : "Toggle skills";
  lines.push(`${colors.bullet("●")} ${colors.body(title)}`);

  items.forEach((item, index) => {
    const pointer = index === picker.selectedIndex ? colors.accent(">") : colors.dim(" ");
    const status = item.enabled ? colors.bullet("[on]") : colors.dim("[off]");
    lines.push(`${pointer} ${status} ${colors.accent(item.name)}`);
    if (index === picker.selectedIndex && item.description) {
      lines.push(`  ${colors.dim(item.description)}`);
    }
  });

  lines.push(divider);
  if (picker.statusMessage) {
    lines.push(colors.dim(picker.statusMessage));
  } else {
    lines.push(picker.saving
      ? colors.dim("Saving selection...")
      : colors.dim("↑/↓ select  enter toggle  esc back"));
  }

  return lines;
}

async function printAvailableModels(): Promise<void> {
  appendTranscript(`${colors.bullet("●")} ${colors.body(`Active model: ${activeModel}`)}\n`);

  try {
    const models = await listOpenAISubscriptionModels();
    applyActiveModelMetadata(models);
    if (models.length === 0) {
      appendTranscript(`     ${colors.dim("No models returned by OpenAI.")}\n\n`);
      return;
    }

    appendTranscript(`${colors.bullet("●")} ${colors.body("Available OpenAI models")}\n`);
    models.forEach((model, index) => {
      const markers = [
        model.slug === activeModel ? colors.accent("active") : null,
        model.visibility && model.visibility !== "list" ? colors.dim(model.visibility) : null,
      ].filter((marker): marker is string => marker !== null);
      const markerText = markers.length > 0 ? ` ${colors.dim("(")}${markers.join(colors.dim(", "))}${colors.dim(")")}` : "";
      appendTranscript(`${colors.dim(`${index + 1}.`)} ${colors.accent(model.slug)}${markerText}\n`);
    });
    appendTranscript("\n");
  } catch (error) {
    appendTranscript(`${colors.error("Could not fetch models:")} ${String(error instanceof Error ? error.message : error)}\n\n`);
  }
}

async function selectModel(model: string): Promise<void> {
  if (/\s/.test(model)) {
    appendTranscript(`${colors.error("Invalid model id:")} ${model}\n\n`);
    return;
  }

  try {
    const selectedEffort = resolvePickerEffort(model, activeEffort);
    const config = await setProjectRuntimeModel(activeCwd, model, selectedEffort);
    activeModel = config.model || model;
    activeEffort = config.effort ?? selectedEffort;
    activeModelContextWindow = null;
    sessionUsageTotals.contextWindow = null;
    sessionUsageTotals.providerLabel = null;
    sessionUsageTotals.subscription = false;
    sessionUsageTotals.effort = activeEffort;
    void refreshActiveModelMetadata();
    appendRevealLine(`model switched to ${activeModel}`);
  } catch (error) {
    appendTranscript(`${colors.error("Could not save model:")} ${String(error instanceof Error ? error.message : error)}\n\n`);
  }
}

async function openModelPicker(): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    await printAvailableModels();
    return;
  }

  try {
    const models = await listOpenAISubscriptionModels();
    applyActiveModelMetadata(models);
    if (models.length === 0) {
      appendTranscript(`     ${colors.dim("No models returned by OpenAI.")}\n\n`);
      return;
    }

    const activeIndex = models.findIndex((model) => model.slug === activeModel);
    modelPicker = {
      models,
      selectedIndex: activeIndex >= 0 ? activeIndex : 0,
      selectedEffort: resolvePickerEffort(models[activeIndex >= 0 ? activeIndex : 0]?.slug ?? activeModel, activeEffort),
      saving: false,
    };
    renderPromptLine(promptValue);
  } catch (error) {
    appendTranscript(`${colors.error("Could not fetch models:")} ${String(error instanceof Error ? error.message : error)}\n\n`);
  }
}

function cancelModelPicker(): void {
  modelPicker = null;
  clearPromptBlock();
  renderPromptLine(promptValue);
}

function moveModelPickerSelection(delta: number): void {
  if (!modelPicker || modelPicker.saving) {
    return;
  }

  const count = modelPicker.models.length;
  modelPicker.selectedIndex = (modelPicker.selectedIndex + delta + count) % count;
  const selectedModel = modelPicker.models[modelPicker.selectedIndex];
  if (selectedModel) {
    modelPicker.selectedEffort = resolvePickerEffort(selectedModel.slug, modelPicker.selectedEffort);
  }
  renderPromptLine(promptValue);
}

function adjustModelPickerEffort(delta: number): void {
  if (!modelPicker || modelPicker.saving) {
    return;
  }

  const selectedModel = modelPicker.models[modelPicker.selectedIndex];
  if (!selectedModel) {
    return;
  }

  const supported = getEffortOptionsForModel(selectedModel.slug);
  if (supported.length <= 1) {
    modelPicker.selectedEffort = supported[0] ?? modelPicker.selectedEffort;
    renderPromptLine(promptValue);
    return;
  }

  const currentIndex = Math.max(0, supported.indexOf(modelPicker.selectedEffort));
  modelPicker.selectedEffort = supported[(currentIndex + delta + supported.length) % supported.length] ?? modelPicker.selectedEffort;
  renderPromptLine(promptValue);
}

async function saveModelPickerSelection(): Promise<void> {
  if (!modelPicker || modelPicker.saving) {
    return;
  }

  const selectedModel = modelPicker.models[modelPicker.selectedIndex];
  if (!selectedModel) {
    return;
  }

  modelPicker.saving = true;
  renderPromptLine(promptValue);

  try {
    const config = await setProjectRuntimeModel(activeCwd, selectedModel.slug, modelPicker.selectedEffort);
    activeModel = config.model || selectedModel.slug;
    activeEffort = config.effort ?? modelPicker.selectedEffort;
    activeModelContextWindow = selectedModel.maxContextWindow ?? selectedModel.contextWindow ?? null;
    sessionUsageTotals.contextWindow = activeModelContextWindow;
    sessionUsageTotals.providerLabel = "openai-codex";
    sessionUsageTotals.subscription = true;
    sessionUsageTotals.effort = activeEffort;
    modelPicker = null;
    clearPromptBlock();
    renderPromptLine(promptValue);
    appendRevealLine(`model switched to ${activeModel}`);
  } catch (error) {
    if (modelPicker) {
      modelPicker.saving = false;
    }
    renderPromptLine(promptValue);
    appendTranscript(`${colors.error("Could not save model:")} ${String(error instanceof Error ? error.message : error)}\n\n`);
  }
}

async function printRuntimeConfigState(): Promise<void> {
  try {
    const state = await getProjectRuntimeConfigState(activeCwd);
    appendTranscript(`${colors.bullet("●")} ${colors.body("Tools")}\n`);
    state.tools.forEach((tool, index) => {
      appendTranscript(`     ${colors.dim(`${index + 1}.`)} ${tool.enabled ? colors.bullet("[on]") : colors.dim("[off]")} ${colors.accent(tool.name)}\n`);
    });
    appendTranscript(`\n${colors.bullet("●")} ${colors.body("Skills")}\n`);
    state.skills.forEach((skill, index) => {
      appendTranscript(`     ${colors.dim(`${index + 1}.`)} ${skill.enabled ? colors.bullet("[on]") : colors.dim("[off]")} ${colors.accent(skill.name)}\n`);
    });
    appendTranscript("\n");
  } catch (error) {
    appendTranscript(`${colors.error("Could not load config state:")} ${String(error instanceof Error ? error.message : error)}\n\n`);
  }
}

async function printModeState(): Promise<void> {
  try {
    const modes = await listProjectRuntimeModes(activeCwd);
    appendTranscript(`${colors.bullet("●")} ${colors.body(`Active mode: ${activeModeId}`)}\n`);
    appendTranscript(`${colors.bullet("●")} ${colors.body("Editable saved modes")}\n`);
    modes.forEach((mode, index) => {
      const markers = [
        mode.id === activeModeId ? colors.accent("active") : null,
        colors.dim(mode.source),
      ].filter((marker): marker is string => marker !== null);
      const markerText = markers.length > 0 ? ` ${colors.dim("(")}${markers.join(colors.dim(", "))}${colors.dim(")")}` : "";
      appendTranscript(`${colors.dim(`${index + 1}.`)} ${colors.accent(mode.id)}${markerText}\n`);
    });
    appendTranscript(`     ${colors.dim("+")} ${colors.accent("Create mode")}\n`);
    appendTranscript("\n");
  } catch (error) {
    appendTranscript(`${colors.error("Could not load modes:")} ${String(error instanceof Error ? error.message : error)}\n\n`);
  }
}

async function switchMode(modeId: string): Promise<void> {
  const normalizedModeId = modeId.trim();
  if (!normalizedModeId || normalizedModeId === "default") {
    activeModeId = "default";
    const notice = formatModeSwitchTranscript(activeModeId);
    if (notice) {
      appendRevealLine(notice);
    }
    renderPromptLine(promptValue);
    return;
  }

  const modes = await listProjectRuntimeModes(activeCwd);
  const selected = modes.find((mode) => mode.id === normalizedModeId);
  if (!selected) {
    appendTranscript(`${colors.error("Unknown mode:")} ${normalizedModeId}\n\n`);
    return;
  }

  activeModeId = selected.id;
  const notice = formatModeSwitchTranscript(activeModeId);
  if (notice) {
    appendRevealLine(notice);
  }
  renderPromptLine(promptValue);
}

async function cycleMode(delta: number): Promise<void> {
  const modes = await listProjectRuntimeModes(activeCwd);
  const orderedIds = ["default", ...modes.map((mode) => mode.id)];
  const currentIndex = Math.max(0, orderedIds.indexOf(activeModeId));
  const nextIndex = (currentIndex + delta + orderedIds.length) % orderedIds.length;
  const nextModeId = orderedIds[nextIndex] ?? "default";
  activeModeId = nextModeId;
  renderPromptLine(promptValue);
  const notice = formatModeSwitchTranscript(activeModeId);
  if (notice) {
    appendRevealLine(notice);
  }
}

async function openModePicker(): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    await printModeState();
    return;
  }

  try {
    const modes = await listProjectRuntimeModes(activeCwd);
    const state = await getProjectRuntimeConfigState(activeCwd);
    const selectedIndex = Math.max(0, modes.findIndex((mode) => mode.id === activeModeId));
    modePicker = {
      view: "modes",
      modes,
      tools: state.tools,
      skills: state.skills,
      selectedIndex,
      saving: false,
      statusMessage: null,
      draft: null,
    };
    renderPromptLine(promptValue);
  } catch (error) {
    appendTranscript(`${colors.error("Could not load modes:")} ${String(error instanceof Error ? error.message : error)}\n\n`);
  }
}

function closeModePicker(): void {
  modePicker = null;
  clearPromptBlock();
  renderPromptLine(promptValue);
}

function moveModePickerSelection(delta: number): void {
  if (!modePicker || modePicker.saving) {
    return;
  }

  const itemCount = modePicker.view === "modes"
    ? modePicker.modes.length + 1
    : modePicker.view === "categories"
      ? (modePicker.draft?.isCreate ? 3 : 2)
      : modePicker.view === "create_scope"
        ? 2
        : modePicker.view === "tools"
          ? modePicker.draft?.tools.length ?? 0
          : modePicker.view === "skills"
            ? modePicker.draft?.skills.length ?? 0
            : 0;
  if (itemCount <= 0) {
    return;
  }
  modePicker.selectedIndex = (modePicker.selectedIndex + delta + itemCount) % itemCount;
  modePicker.statusMessage = null;
  renderPromptLine(promptValue);
}

function stepBackModePicker(): void {
  if (!modePicker || modePicker.saving) {
    return;
  }

  if (modePicker.view === "modes") {
    closeModePicker();
    return;
  }

  if (modePicker.view === "create_name") {
    closeModePicker();
    return;
  }

  if (modePicker.view === "tools" || modePicker.view === "skills" || modePicker.view === "create_scope") {
    modePicker.view = "categories";
    modePicker.selectedIndex = 0;
    modePicker.statusMessage = null;
    renderPromptLine(promptValue);
    return;
  }

  modePicker.view = "modes";
  modePicker.selectedIndex = 0;
  modePicker.statusMessage = null;
  modePicker.draft = null;
  renderPromptLine(promptValue);
}

function toggleModeDraftItem(): void {
  if (!modePicker?.draft || modePicker.saving) {
    return;
  }

  const items = modePicker.view === "tools"
    ? modePicker.draft.tools
    : modePicker.view === "skills"
      ? modePicker.draft.skills
      : null;
  if (!items) {
    return;
  }

  const selected = items[modePicker.selectedIndex];
  if (!selected) {
    return;
  }

  selected.enabled = !selected.enabled;
  modePicker.statusMessage = `${selected.name} ${selected.enabled ? "enabled" : "disabled"}.`;
  renderPromptLine(promptValue);
}

async function saveModeDraft(source: SaveRuntimeModeInput["source"]): Promise<void> {
  if (!modePicker?.draft || modePicker.saving) {
    return;
  }

  modePicker.saving = true;
  modePicker.statusMessage = null;
  renderPromptLine(promptValue);

  try {
    const saved = await saveProjectRuntimeMode(activeCwd, {
      id: modePicker.draft.id,
      name: modePicker.draft.name,
      description: modePicker.draft.description,
      source,
      disabledTools: modePicker.draft.tools.filter((tool) => !tool.enabled).map((tool) => tool.name),
      disabledSkills: modePicker.draft.skills.filter((skill) => !skill.enabled).map((skill) => skill.id),
      paths: modePicker.draft.paths,
    });

    const refreshedModes = await listProjectRuntimeModes(activeCwd);
    const refreshedState = await getProjectRuntimeConfigState(activeCwd);
    modePicker = {
      view: "modes",
      modes: refreshedModes,
      tools: refreshedState.tools,
      skills: refreshedState.skills,
      selectedIndex: Math.max(0, refreshedModes.findIndex((mode) => mode.id === saved.id)),
      saving: false,
      statusMessage: null,
      draft: null,
    };
    renderPromptLine(promptValue);
    appendRevealLine(`mode saved to ${saved.source}`);
  } catch (error) {
    if (modePicker) {
      modePicker.saving = false;
      modePicker.statusMessage = `Error: ${String(error instanceof Error ? error.message : error)}`;
    }
    renderPromptLine(promptValue);
  }
}

async function saveModeDraftInPlace(): Promise<void> {
  if (!modePicker?.draft || modePicker.saving || modePicker.draft.isCreate) {
    return;
  }

  const currentView = modePicker.view;
  const currentSelectedIndex = modePicker.selectedIndex;
  const draft = modePicker.draft;

  modePicker.saving = true;
  modePicker.statusMessage = null;
  renderPromptLine(promptValue);

  try {
    const saved = await saveProjectRuntimeMode(activeCwd, {
      id: draft.id,
      name: draft.name,
      description: draft.description,
      source: draft.modeSource ?? draft.source ?? "project",
      disabledTools: draft.tools.filter((tool) => !tool.enabled).map((tool) => tool.name),
      disabledSkills: draft.skills.filter((skill) => !skill.enabled).map((skill) => skill.id),
      paths: draft.paths,
    });

    const refreshedModes = await listProjectRuntimeModes(activeCwd);
    const refreshedState = await getProjectRuntimeConfigState(activeCwd);
    const savedMode = refreshedModes.find((mode) => mode.id === saved.id);
    modePicker = {
      view: currentView,
      modes: refreshedModes,
      tools: refreshedState.tools,
      skills: refreshedState.skills,
      selectedIndex: currentSelectedIndex,
      saving: false,
      statusMessage: null,
      draft: savedMode
        ? buildModeDraftFromDefinition(savedMode, refreshedState.tools, refreshedState.skills)
        : draft,
    };
    renderPromptLine(promptValue);
  } catch (error) {
    if (modePicker) {
      modePicker.saving = false;
      modePicker.statusMessage = `Error: ${String(error instanceof Error ? error.message : error)}`;
    }
    renderPromptLine(promptValue);
  }
}

async function activateModePickerSelection(): Promise<void> {
  if (!modePicker || modePicker.saving) {
    return;
  }

  if (modePicker.view === "modes") {
    const selectedMode = modePicker.modes[modePicker.selectedIndex];
    if (!selectedMode) {
      modePicker.view = "create_name";
      modePicker.selectedIndex = 0;
      modePicker.statusMessage = null;
      modePicker.draft = buildCreateModeDraft(modePicker.tools, modePicker.skills);
      renderPromptLine(promptValue);
      return;
    }

    modePicker.view = "categories";
    modePicker.selectedIndex = 0;
    modePicker.statusMessage = null;
    modePicker.draft = buildModeDraftFromDefinition(selectedMode, modePicker.tools, modePicker.skills);
    renderPromptLine(promptValue);
    return;
  }

  if (modePicker.view === "create_name") {
    if (!modePicker.draft?.name.trim()) {
      modePicker.statusMessage = "Enter a mode name first.";
      renderPromptLine(promptValue);
      return;
    }

    modePicker.view = "categories";
    modePicker.selectedIndex = 0;
    modePicker.statusMessage = null;
    renderPromptLine(promptValue);
    return;
  }

  if (modePicker.view === "categories") {
    if (modePicker.selectedIndex === 0) {
      modePicker.view = "tools";
      modePicker.selectedIndex = 0;
      modePicker.statusMessage = null;
      renderPromptLine(promptValue);
      return;
    }

    if (modePicker.selectedIndex === 1) {
      modePicker.view = "skills";
      modePicker.selectedIndex = 0;
      modePicker.statusMessage = null;
      renderPromptLine(promptValue);
      return;
    }

    if (modePicker.draft?.isCreate && modePicker.selectedIndex === 2) {
      modePicker.view = "create_scope";
      modePicker.selectedIndex = 0;
      modePicker.statusMessage = null;
      renderPromptLine(promptValue);
      return;
    }
  }

  if (modePicker.view === "tools" || modePicker.view === "skills") {
    toggleModeDraftItem();
    await saveModeDraftInPlace();
    return;
  }

  if (modePicker.view === "create_scope") {
    await saveModeDraft(modePicker.selectedIndex === 0 ? "project" : "global");
  }
}

async function openConfigPicker(): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    await printRuntimeConfigState();
    return;
  }

  try {
    const state = await getProjectRuntimeConfigState(activeCwd);
    configPicker = {
      section: "categories",
      selectedIndex: 0,
      saving: false,
      dirty: false,
      tools: state.tools,
      skills: state.skills,
      statusMessage: null,
    };
    renderPromptLine(promptValue);
  } catch (error) {
    appendTranscript(`${colors.error("Could not load config state:")} ${String(error instanceof Error ? error.message : error)}\n\n`);
  }
}

function closeConfigPicker(): void {
  const shouldReveal = Boolean(configPicker?.dirty);
  configPicker = null;
  clearPromptBlock();
  renderPromptLine(promptValue);
  if (shouldReveal) {
    appendRevealLine("config saved");
  }
}

function moveConfigPickerSelection(delta: number): void {
  if (!configPicker || configPicker.saving) {
    return;
  }

  const itemCount = configPicker.section === "categories"
    ? 2
    : (configPicker.section === "tools" ? configPicker.tools.length : configPicker.skills.length);
  if (itemCount === 0) {
    return;
  }

  configPicker.selectedIndex = (configPicker.selectedIndex + delta + itemCount) % itemCount;
  configPicker.statusMessage = null;
  renderPromptLine(promptValue);
}

async function activateConfigPickerSelection(): Promise<void> {
  if (!configPicker || configPicker.saving) {
    return;
  }

  if (configPicker.section === "categories") {
    configPicker.section = configPicker.selectedIndex === 0 ? "tools" : "skills";
    configPicker.selectedIndex = 0;
    configPicker.statusMessage = null;
    renderPromptLine(promptValue);
    return;
  }

  const items = configPicker.section === "tools" ? configPicker.tools : configPicker.skills;
  const selected = items[configPicker.selectedIndex];
  if (!selected) {
    return;
  }

  configPicker.saving = true;
  configPicker.statusMessage = null;
  renderPromptLine(promptValue);

  try {
    const nextState = configPicker.section === "tools"
      ? await setProjectRuntimeToolEnabled(activeCwd, selected.name, !selected.enabled)
      : await setProjectRuntimeSkillEnabled(
        activeCwd,
        (configPicker.skills[configPicker.selectedIndex] as ConfigurableSkillSummary).id,
        !selected.enabled,
      );
    configPicker = {
      ...configPicker,
      saving: false,
      dirty: true,
      tools: nextState.tools,
      skills: nextState.skills,
      statusMessage: `${selected.name} ${selected.enabled ? "disabled" : "enabled"}.`,
    };
    renderPromptLine(promptValue);
  } catch (error) {
    if (configPicker) {
      configPicker.saving = false;
      configPicker.statusMessage = `Error: ${String(error instanceof Error ? error.message : error)}`;
    }
    renderPromptLine(promptValue);
  }
}

function stepBackConfigPicker(): void {
  if (!configPicker || configPicker.saving) {
    return;
  }

  if (configPicker.section === "categories") {
    closeConfigPicker();
    return;
  }

  configPicker.section = "categories";
  configPicker.selectedIndex = 0;
  configPicker.statusMessage = null;
  renderPromptLine(promptValue);
}

function handleSlashCommand(value: string): boolean {
  const command = parseSlashCommand(value);
  if (!command) {
    return false;
  }

  switch (command.name) {
    case "connect":
      void connectOpenAISubscription();
      return true;
    case "disconnect":
    case "logout":
      void disconnectOpenAISubscription();
      return true;
    case "help":
      printHelp();
      return true;
    case "init":
      void initializeProjectRuntime();
      return true;
    case "status":
      void printStatus();
      return true;
    case "config":
      void openConfigPicker();
      return true;
    case "mode":
      void openModePicker();
      return true;
    case "model":
      if (command.args) {
        void selectModel(command.args);
      } else {
        void openModelPicker();
      }
      return true;
    case "permissions":
      appendTranscript(`${colors.bullet("●")} ${colors.body(`Approval mode: ${activePermissionMode}`)}\n\n`);
      return true;
    case "clear":
      clearPromptBlock();
      output.write("\x1Bc");
      renderPromptLine(promptValue);
      return true;
    case "quit":
    case "exit":
      clearPromptBlock();
      output.write("\n");
      process.exit(0);
    default:
      appendTranscript(`${colors.error("Unknown command:")} /${command.name} ${colors.dim("(try /help)")}\n\n`);
      return true;
  }
}

function submitPrompt(): void {
  const value = promptValue.trim();

  if (!value || promptIsSubmitting) {
    return;
  }

  promptIsSubmitting = true;

  if (liveBlockLines > 0) {
    finishLiveBlock();
    liveBlockFrozen = true;
  }

  clearPromptBlock();
  const submittedPromptLines = promptValue.split("\n").map((line, index) =>
    colors.userMessageBackground(`${index === 0 ? colors.accent("▌") : " "} ${colors.body(line)}`)
  );
  ensureTranscriptGap();
  appendTranscript(
    formatSubmittedUserMessageBlock(
      submittedPromptLines,
      colors.userMessageBackground("\x1b[K"),
    )
  );
  rememberPrompt(promptValue);
  promptValue = "";
  promptCursorIndex = 0;
  activeMentionSuggestions = [];
  activeMentionSelectionIndex = 0;

  if (!handleSlashCommand(value)) {
    resolveNextPrompt(value);
  }

  renderPromptLine(promptValue);
  promptIsSubmitting = false;
}

function buildApprovalPreviewLines(toolName: string, toolInput: Record<string, unknown>): PreviewLine[] {
  if (toolName === "Edit") {
    const editPreview = buildEditDiffPreview({
      id: "approval",
      name: toolName,
      input: toolInput,
      rendered: false,
    });

    if (editPreview.length > 0) {
      return editPreview;
    }
  }

  return formatToolInputPreview({ name: toolName, input: toolInput }).slice(0, 12);
}

function isAskUserQuestionTool(tool: Pick<ToolCallRecord, "name">): boolean {
  return tool.name === "AskUserQuestion";
}

function isTodoWriteTool(tool: Pick<ToolCallRecord, "name">): boolean {
  return tool.name === "TodoWrite";
}

function resolveTodoPanel(tool: Pick<ToolCallRecord, "input">, content?: ToolResultContent): TodoPanel | null {
  return formatTodoPanel(tool.input) ?? formatTodoPanel(content);
}

function renderTodoPanelLines(): string[] {
  if (!activeTodoPanel || activeTodoPanel.items.length === 0) {
    return [];
  }

  return [
    `${colors.bullet("●")} ${chalk.bold(colors.body(activeTodoPanel.title))}`,
    ...activeTodoPanel.items.map((item, index) => {
      const prefix = index === 0 ? `  ${colors.gutter("⎿")}  ` : "     ";
      const icon =
        item.status === "completed"
          ? colors.bullet("☒")
          : item.status === "in_progress"
            ? colors.accent("☐")
            : colors.body("☐");
      const color =
        item.status === "completed"
          ? colors.bullet
          : item.status === "in_progress"
            ? colors.accent
            : colors.body;

      return `${prefix}${icon} ${color(item.text)}`;
    }),
  ];
}

function normalizeUserQuestionOption(option: unknown): UserQuestionOption | null {
  if (typeof option === "string") {
    const label = option.trim();
    return label ? { label, value: label } : null;
  }

  if (!option || typeof option !== "object" || Array.isArray(option)) {
    return null;
  }

  const record = option as Record<string, unknown>;
  const label = String(record.label ?? "").trim();
  if (!label) {
    return null;
  }

  return {
    label,
    description: typeof record.description === "string" && record.description.trim().length > 0
      ? record.description.trim()
      : undefined,
    value: typeof record.value === "string" && record.value.trim().length > 0 ? record.value.trim() : label,
  };
}

function normalizeUserQuestionPrompt(question: Record<string, unknown>): UserQuestionPromptState | null {
  if (question.type !== "ask_user_question") {
    return null;
  }

  const rawQuestions = Array.isArray(question.questions) ? question.questions : [];
  const questions = rawQuestions
    .map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }

      const record = entry as Record<string, unknown>;
      const prompt = String(record.question ?? "").trim();
      if (!prompt) {
        return null;
      }

      const options = Array.isArray(record.options)
        ? record.options.map(normalizeUserQuestionOption).filter((option): option is UserQuestionOption => Boolean(option))
        : [];
      const allowOther = record.allow_other === true || record.isOther === true || options.length === 0;
      const otherPlaceholder =
        typeof record.other_placeholder === "string" && record.other_placeholder.trim().length > 0
          ? record.other_placeholder.trim()
          : typeof record.placeholder === "string" && record.placeholder.trim().length > 0
            ? record.placeholder.trim()
            : "Type something.";

      return {
        id: String(record.id ?? `question_${index + 1}`).trim() || `question_${index + 1}`,
        header: typeof record.header === "string" && record.header.trim().length > 0
          ? record.header.trim()
          : `Question ${index + 1}`,
        question: prompt,
        options,
        allowOther,
        otherPlaceholder,
        selectedIndex: options.length === 0 ? 0 : 0,
        customValue: "",
      } satisfies UserQuestionState;
    })
    .filter((entry): entry is UserQuestionState => Boolean(entry));

  if (questions.length === 0) {
    return null;
  }

  return {
    title: typeof question.title === "string" && question.title.trim().length > 0
      ? question.title.trim()
      : "Answer these questions",
    submitLabel: typeof question.submit_label === "string" && question.submit_label.trim().length > 0
      ? question.submit_label.trim()
      : "Submit",
    questions,
    view: "question",
    activeQuestionIndex: 0,
    reviewSelectedIndex: 0,
    statusMessage: null,
    resolve: () => undefined,
  };
}

function currentUserQuestion(): UserQuestionState | null {
  if (!userQuestionPrompt || userQuestionPrompt.view !== "question") {
    return null;
  }

  return userQuestionPrompt.questions[userQuestionPrompt.activeQuestionIndex] ?? null;
}

function getUserQuestionOptionCount(question: UserQuestionState): number {
  return question.options.length + (question.allowOther ? 1 : 0);
}

function isUserQuestionOtherSelected(question: UserQuestionState): boolean {
  return question.allowOther && question.selectedIndex === question.options.length;
}

function getUserQuestionAnswer(
  question: UserQuestionState,
): { id: string; value: string; label?: string } | null {
  if (question.options.length === 0 && question.allowOther) {
    const value = question.customValue.trim();
    return value ? { id: question.id, value, label: value } : null;
  }

  if (isUserQuestionOtherSelected(question)) {
    const value = question.customValue.trim();
    return value ? { id: question.id, value, label: value } : null;
  }

  const option = question.options[question.selectedIndex];
  if (!option) {
    return null;
  }

  return {
    id: question.id,
    value: option.value,
    label: option.label,
  };
}

function findFirstIncompleteUserQuestionIndex(questions: UserQuestionState[]): number {
  return questions.findIndex((question) => !getUserQuestionAnswer(question));
}

function moveUserQuestionSelection(delta: number): void {
  const current = currentUserQuestion();
  if (!current) {
    return;
  }

  const count = getUserQuestionOptionCount(current);
  if (count <= 0) {
    return;
  }

  current.selectedIndex = (current.selectedIndex + delta + count) % count;
  if (userQuestionPrompt) {
    userQuestionPrompt.statusMessage = null;
  }
  renderPromptLine(promptValue);
}

function moveUserQuestionTab(delta: number): void {
  if (!userQuestionPrompt || userQuestionPrompt.questions.length === 0) {
    return;
  }

  const tabCount = userQuestionPrompt.questions.length + 1;
  const currentTabIndex = userQuestionPrompt.view === "review"
    ? userQuestionPrompt.questions.length
    : userQuestionPrompt.activeQuestionIndex;
  const nextTabIndex = (currentTabIndex + delta + tabCount) % tabCount;
  if (nextTabIndex === userQuestionPrompt.questions.length) {
    userQuestionPrompt.view = "review";
  } else {
    userQuestionPrompt.view = "question";
    userQuestionPrompt.activeQuestionIndex = nextTabIndex;
  }
  userQuestionPrompt.statusMessage = null;
  renderPromptLine(promptValue);
}

function moveUserQuestionReviewSelection(delta: number): void {
  if (!userQuestionPrompt || userQuestionPrompt.view !== "review") {
    return;
  }

  userQuestionPrompt.reviewSelectedIndex =
    (userQuestionPrompt.reviewSelectedIndex + delta + 2) % 2;
  userQuestionPrompt.statusMessage = null;
  renderPromptLine(promptValue);
}

function resolveUserQuestionPrompt(response: UserQuestionPromptResponse): void {
  if (!userQuestionPrompt) {
    return;
  }

  const current = userQuestionPrompt;
  clearPromptBlock();
  userQuestionPrompt = null;
  userQuestionPromptActive = false;
  current.resolve(response);
}

function submitUserQuestionPrompt(): void {
  if (!userQuestionPrompt) {
    return;
  }

  const firstIncomplete = findFirstIncompleteUserQuestionIndex(userQuestionPrompt.questions);
  if (firstIncomplete >= 0) {
    userQuestionPrompt.activeQuestionIndex = firstIncomplete;
    userQuestionPrompt.statusMessage = "Complete the highlighted question before submitting.";
    renderPromptLine(promptValue);
    return;
  }

  const answers = userQuestionPrompt.questions
    .map((question) => getUserQuestionAnswer(question))
    .filter((answer): answer is NonNullable<ReturnType<typeof getUserQuestionAnswer>> => Boolean(answer));

  resolveUserQuestionPrompt({
    status: "submitted",
    answers,
    answersById: Object.fromEntries(answers.map((answer) => [answer.id, answer.value])),
  });
}

function openUserQuestionReview(): void {
  if (!userQuestionPrompt) {
    return;
  }

  const firstIncomplete = findFirstIncompleteUserQuestionIndex(userQuestionPrompt.questions);
  if (firstIncomplete >= 0) {
    userQuestionPrompt.view = "question";
    userQuestionPrompt.activeQuestionIndex = firstIncomplete;
    userQuestionPrompt.statusMessage = "Complete the highlighted question before reviewing.";
    renderPromptLine(promptValue);
    return;
  }

  userQuestionPrompt.view = "review";
  userQuestionPrompt.reviewSelectedIndex = 0;
  userQuestionPrompt.statusMessage = null;
  renderPromptLine(promptValue);
}

function renderSubmittedQuestionAnswers(
  prompt: UserQuestionPromptState,
  response: UserQuestionPromptResponse,
): void {
  if (response.status !== "submitted") {
    return;
  }

  const answerById = new Map(
    (response.answers ?? []).map((answer) => [answer.id, answer] as const),
  );
  const maxWidth = Math.max(20, (output.columns ?? 80) - 10);

  ensureTranscriptGap();
  appendTranscript(`${colors.bullet("◔")} ${colors.body("User answered the questions:")}\n`);

  let wroteAnyAnswer = false;
  for (const question of prompt.questions) {
    const answer = answerById.get(question.id);
    const value = answer?.label?.trim() || answer?.value?.trim();
    if (!value) {
      continue;
    }

    const combined = `${question.question} ${colors.dim("->")} ${colors.body(value)}`;
    const wrapped = wrapRenderedAnsiText(combined, maxWidth);
    const wrappedLines = wrapped.split("\n");
    const firstPrefix = `  ${colors.gutter("└")} `;

    appendTranscript(`${firstPrefix}${wrappedLines[0] ?? combined}\n`);
    for (const continuation of wrappedLines.slice(1)) {
      appendTranscript(`      ${continuation}\n`);
    }
    wroteAnyAnswer = true;
  }

  if (!wroteAnyAnswer) {
    appendTranscript(`  ${colors.gutter("└")} ${colors.dim("No answers submitted.")}\n`);
  }

  appendTranscript("\n");
}

function advanceUserQuestionPrompt(): void {
  if (!userQuestionPrompt) {
    return;
  }

  if (userQuestionPrompt.view === "review") {
    if (userQuestionPrompt.reviewSelectedIndex === 0) {
      submitUserQuestionPrompt();
      return;
    }

    resolveUserQuestionPrompt({ status: "aborted" });
    return;
  }

  const current = currentUserQuestion();
  if (!current || !getUserQuestionAnswer(current)) {
    userQuestionPrompt.statusMessage = "Select or type an answer first.";
    renderPromptLine(promptValue);
    return;
  }

  userQuestionPrompt.statusMessage = null;
  if (userQuestionPrompt.activeQuestionIndex >= userQuestionPrompt.questions.length - 1) {
    openUserQuestionReview();
    return;
  }

  userQuestionPrompt.activeQuestionIndex += 1;
  renderPromptLine(promptValue);
}

function buildUserQuestionPromptLines(dividerWidth: number, divider: string): {
  lines: string[];
  inputLineIndex: number;
  cursorColumn: number;
} {
  if (!userQuestionPrompt) {
    return { lines: [], inputLineIndex: 0, cursorColumn: 0 };
  }
  const state = userQuestionPrompt;

  const tabs = state.questions.map((question, index) => {
    const answered = Boolean(getUserQuestionAnswer(question));
    const isActive = state.view === "question" && index === state.activeQuestionIndex;
    const prefix = answered ? "✓ " : "";
    const label = `${prefix}${question.header}`;
    return isActive ? chalk.inverse(` ${label} `) : colors.body(` ${label} `);
  });
  tabs.push(
    state.view === "review"
      ? chalk.inverse(` ${state.submitLabel} `)
      : colors.body(` ${state.submitLabel} `),
  );

  const lines: string[] = [
    `${colors.bullet("●")} ${chalk.bold(colors.body(state.title))}`,
    divider,
    tabs.join(` ${colors.dim("•")} `),
    "",
  ];

  let inputLineIndex = lines.length - 1;
  let cursorColumn = 0;

  if (state.view === "review") {
    lines.push(chalk.bold(colors.heading("Review your answers")));
    lines.push("");
    for (const question of state.questions) {
      const answer = getUserQuestionAnswer(question);
      const value = answer?.label?.trim() || answer?.value?.trim() || "Not answered";
      lines.push(`${colors.body("•")} ${colors.body(question.question)}`);
      lines.push(`  ${colors.accent("→")} ${colors.body(value)}`);
    }
    lines.push("");
    lines.push(colors.body("Ready to submit your answers?"));
    lines.push("");

    const reviewOptions = [
      { label: `${state.submitLabel} answers`, selected: state.reviewSelectedIndex === 0 },
      { label: "Cancel", selected: state.reviewSelectedIndex === 1 },
    ];
    for (let index = 0; index < reviewOptions.length; index += 1) {
      const option = reviewOptions[index]!;
      const pointer = option.selected ? colors.accent("›") : colors.dim(" ");
      const number = option.selected ? colors.accent(`${index + 1}.`) : colors.dim(`${index + 1}.`);
      const label = option.selected ? colors.accent(option.label) : colors.body(option.label);
      lines.push(`${pointer} ${number} ${label}`);
      if (option.selected) {
        inputLineIndex = lines.length - 1;
      }
    }
  } else {
    const current = currentUserQuestion();
    if (!current) {
      return { lines: [], inputLineIndex: 0, cursorColumn: 0 };
    }

    lines.push(chalk.bold(colors.heading(current.question)));

    const optionCount = getUserQuestionOptionCount(current);
    for (let index = 0; index < optionCount; index += 1) {
      const option = current.options[index];
      const isOther = current.allowOther && index === current.options.length;
      const selected = current.selectedIndex === index;
      const pointer = selected ? colors.accent("›") : colors.dim(" ");
      const number = selected ? colors.accent(`${index + 1}.`) : colors.dim(`${index + 1}.`);
      const labelText = isOther
        ? current.customValue.length > 0
          ? current.customValue
          : current.otherPlaceholder
        : option?.label ?? "";
      const label = isOther && current.customValue.length === 0
        ? colors.dim(labelText)
        : selected
          ? colors.accent(labelText)
          : colors.body(labelText);
      lines.push(`${pointer} ${number} ${label}`);
      if (selected) {
        inputLineIndex = lines.length - 1;
        cursorColumn = isOther
          ? visibleLength(`${pointer} ${index + 1}. `) + current.customValue.length
          : 0;
      }

      const description = isOther ? null : option?.description;
      if (description) {
        lines.push(`   ${colors.dim(description)}`);
      }
    }
  }

  if (state.statusMessage) {
    lines.push("");
    lines.push(colors.error(state.statusMessage));
  }

  lines.push("");
  lines.push(
    colors.dim(
      state.view === "review"
        ? "Enter to submit or cancel · Left/Right to switch tabs · Up/Down to navigate · Esc to cancel"
        : "Enter to continue · Left/Right to switch tabs · Tab/Arrow keys to navigate · Esc to cancel",
    ),
  );

  return { lines, inputLineIndex, cursorColumn };
}

function buildApprovalQuestion(toolName: string, toolInput: Record<string, unknown>): string {
  if ((toolName === "Edit" || toolName === "Write") && typeof toolInput.file_path === "string") {
    return `Do you want to make this ${toolName.toLowerCase()} to ${formatToolDisplayPath(toolInput.file_path, activeCwd)}?`;
  }

  if (toolName === "Bash" && typeof toolInput.command === "string") {
    return `Do you want to run this command?`;
  }

  return `Do you want to allow ${toolName}?`;
}

function moveApprovalSelection(delta: number): void {
  if (!approvalPrompt || approvalPrompt.options.length === 0) {
    return;
  }

  approvalPrompt.selectedIndex =
    (approvalPrompt.selectedIndex + delta + approvalPrompt.options.length) % approvalPrompt.options.length;
  renderPromptLine(promptValue);
}

function resolveApprovalDecision(decision: ApprovalDecision): void {
  if (!approvalPrompt) {
    return;
  }

  const current = approvalPrompt;
  clearPromptBlock();
  approvalPrompt = null;
  approvalPromptActive = false;

  if (decision === "approve_for_session") {
    requestedPermissionMode = "acceptEdits";
    activePermissionMode = "acceptEdits";
  }

  current.resolve(decision);
}

function startPromptLoop(): void {
  if (promptLoopStarted || !input.isTTY || !output.isTTY) {
    return;
  }

  promptLoopStarted = true;
  if (!resizeHandlerAttached) {
    output.on("resize", handleTerminalResize);
    resizeHandlerAttached = true;
  }
  const wasRaw = input.isRaw ?? false;
  let suppressKeypressForPaste = false;
  let bracketedPasteBuffer: string | null = null;

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write("\x1b[?2004h");
  bracketedPasteEnabled = true;
  renderPromptLine(promptValue);

  const cleanup = () => {
    if (resizeRedrawTimer) {
      clearTimeout(resizeRedrawTimer);
      resizeRedrawTimer = undefined;
    }
    input.setRawMode(wasRaw);
    if (resizeHandlerAttached) {
      output.off("resize", handleTerminalResize);
      resizeHandlerAttached = false;
    }
    input.off("data", onData);
    input.off("keypress", onKeypress);
    if (bracketedPasteEnabled) {
      output.write("\x1b[?2004l");
      bracketedPasteEnabled = false;
    }
    clearPromptBlock();
    output.write("\n");
  };

  const finishPasteKeypressSuppression = () => {
    setImmediate(() => {
      suppressKeypressForPaste = false;
    });
  };

  const onData = (data: Buffer) => {
    const chunk = data.toString("utf8");
    if (!chunk.includes("\x1b[200~") && bracketedPasteBuffer === null) {
      return;
    }

    suppressKeypressForPaste = true;
    let remaining = chunk;

    if (bracketedPasteBuffer === null) {
      const startIndex = remaining.indexOf("\x1b[200~");
      if (startIndex === -1) {
        finishPasteKeypressSuppression();
        return;
      }
      remaining = remaining.slice(startIndex + "\x1b[200~".length);
      bracketedPasteBuffer = "";
    }

    const endIndex = remaining.indexOf("\x1b[201~");
    if (endIndex === -1) {
      bracketedPasteBuffer += remaining;
      finishPasteKeypressSuppression();
      return;
    }

    bracketedPasteBuffer += remaining.slice(0, endIndex);
    insertPromptText(bracketedPasteBuffer);
    bracketedPasteBuffer = null;
    finishPasteKeypressSuppression();
  };

  const onKeypress = (char: string, key: { ctrl?: boolean; name?: string; meta?: boolean; shift?: boolean }) => {
    if (suppressKeypressForPaste) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      cleanup();
      process.exit(0);
    }

    if (isManualRedrawKey(key, char)) {
      redrawCliOnce();
      return;
    }

    if (userQuestionPromptActive) {
      const state = userQuestionPrompt;
      if (!state) {
        resolveUserQuestionPrompt({ status: "aborted" });
        return;
      }

      if (key.name === "escape") {
        resolveUserQuestionPrompt({ status: "aborted" });
        return;
      }

      if (key.name === "left") {
        moveUserQuestionTab(-1);
        return;
      }

      if (key.name === "right") {
        moveUserQuestionTab(1);
        return;
      }

      if (key.name === "up") {
        if (state.view === "review") {
          moveUserQuestionReviewSelection(-1);
          return;
        }
        moveUserQuestionSelection(-1);
        return;
      }

      if (key.name === "down" || key.name === "tab") {
        if (state.view === "review") {
          moveUserQuestionReviewSelection(1);
          return;
        }
        moveUserQuestionSelection(1);
        return;
      }

      if (key.name === "backspace") {
        const current = currentUserQuestion();
        if (!current) {
          return;
        }
        if ((isUserQuestionOtherSelected(current) || (current.options.length === 0 && current.allowOther)) && current.customValue.length > 0) {
          current.customValue = current.customValue.slice(0, -1);
          if (userQuestionPrompt) {
            userQuestionPrompt.statusMessage = null;
          }
          renderPromptLine(promptValue);
        }
        return;
      }

      if (key.name === "return" || char === "\r" || char === "\n") {
        advanceUserQuestionPrompt();
        return;
      }

      if (!key.ctrl && !key.meta && char) {
        if (state.view === "review") {
          const optionIndex = Number.parseInt(char, 10) - 1;
          if (Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < 2 && userQuestionPrompt) {
            userQuestionPrompt.reviewSelectedIndex = optionIndex;
            userQuestionPrompt.statusMessage = null;
            renderPromptLine(promptValue);
          }
          return;
        }

        const current = currentUserQuestion();
        if (!current) {
          return;
        }
        const optionIndex = Number.parseInt(char, 10) - 1;
        if (Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < getUserQuestionOptionCount(current)) {
          current.selectedIndex = optionIndex;
          if (userQuestionPrompt) {
            userQuestionPrompt.statusMessage = null;
          }
          renderPromptLine(promptValue);
          return;
        }

        if (isUserQuestionOtherSelected(current) || (current.options.length === 0 && current.allowOther)) {
          current.customValue += char;
          if (userQuestionPrompt) {
            userQuestionPrompt.statusMessage = null;
          }
          renderPromptLine(promptValue);
        }
      }
      return;
    }

    if (approvalPromptActive) {
      if (key.name === "escape") {
        resolveApprovalDecision("abort");
        return;
      }

      if (key.name === "up") {
        moveApprovalSelection(-1);
        return;
      }

      if (key.name === "down" || key.name === "tab") {
        moveApprovalSelection(1);
        return;
      }

      if (key.name === "return" || char === "\r" || char === "\n") {
        const selected = approvalPrompt?.options[approvalPrompt.selectedIndex];
        resolveApprovalDecision(selected?.decision ?? "deny");
        return;
      }

      if (key.meta && (key.name === "m" || char.toLowerCase() === "m")) {
        const allowAllOption = approvalPrompt?.options.find((option) => option.decision === "approve_for_session");
        if (allowAllOption) {
          resolveApprovalDecision("approve_for_session");
        }
        return;
      }

      if (!key.ctrl && !key.meta && char) {
        const normalized = char.toLowerCase();
        if (normalized === "y") {
          resolveApprovalDecision("approve");
          return;
        }
        if (normalized === "n") {
          resolveApprovalDecision("deny");
          return;
        }
        if (normalized === "a") {
          resolveApprovalDecision("abort");
          return;
        }

        const optionIndex = Number.parseInt(normalized, 10) - 1;
        if (Number.isInteger(optionIndex) && approvalPrompt?.options[optionIndex]) {
          resolveApprovalDecision(approvalPrompt.options[optionIndex]!.decision);
        }
      }
      return;
    }

    if (configPicker) {
      if (key.name === "escape") {
        stepBackConfigPicker();
        return;
      }

      if (key.name === "up") {
        moveConfigPickerSelection(-1);
        return;
      }

      if (key.name === "down") {
        moveConfigPickerSelection(1);
        return;
      }

      if (key.name === "return" || char === "\r" || char === "\n") {
        void activateConfigPickerSelection();
        return;
      }

      return;
    }

    if (modelPicker) {
      if (key.name === "escape") {
        cancelModelPicker();
        return;
      }

      if (key.name === "up") {
        moveModelPickerSelection(-1);
        return;
      }

      if (key.name === "down") {
        moveModelPickerSelection(1);
        return;
      }

      if (key.name === "left") {
        adjustModelPickerEffort(-1);
        return;
      }

      if (key.name === "right") {
        adjustModelPickerEffort(1);
        return;
      }

      if (key.name === "return" || char === "\r" || char === "\n") {
        void saveModelPickerSelection();
        return;
      }

      return;
    }

    if (modePicker) {
      if (key.name === "escape") {
        stepBackModePicker();
        return;
      }

      if (modePicker.view === "create_name") {
        if (key.name === "backspace") {
          if (modePicker.draft && modePicker.draft.name.length > 0) {
            modePicker.draft.name = modePicker.draft.name.slice(0, -1);
            modePicker.statusMessage = null;
            renderPromptLine(promptValue);
          }
          return;
        }

        if (!key.ctrl && !key.meta && char && char !== "\r" && char !== "\n") {
          if (modePicker.draft) {
            modePicker.draft.name += char;
            modePicker.statusMessage = null;
            renderPromptLine(promptValue);
          }
          return;
        }
      }

      if (key.name === "up") {
        moveModePickerSelection(-1);
        return;
      }

      if (key.name === "down") {
        moveModePickerSelection(1);
        return;
      }

      if (key.name === "return" || char === "\r" || char === "\n") {
        void activateModePickerSelection();
        return;
      }

      return;
    }

    if (key.name === "escape") {
      stopActiveRun().catch((error) => {
        appendTranscript(`${colors.error("Could not stop run:")} ${String(error)}\n`);
      });
      return;
    }

    if (key.ctrl && key.name === "a") {
      promptCursorIndex = 0;
      updateMentionSuggestions();
      renderPromptLine(promptValue);
      return;
    }

    if (key.ctrl && key.name === "e") {
      promptCursorIndex = promptValue.length;
      updateMentionSuggestions();
      renderPromptLine(promptValue);
      return;
    }

    if (key.ctrl && key.name === "u") {
      promptValue = promptValue.slice(promptCursorIndex);
      promptCursorIndex = 0;
      updateMentionSuggestions();
      renderPromptLine(promptValue);
      return;
    }

    if (key.ctrl && key.name === "k") {
      promptValue = promptValue.slice(0, promptCursorIndex);
      updateMentionSuggestions();
      renderPromptLine(promptValue);
      return;
    }

    if (
      (key.ctrl && key.name === "j") ||
      (key.meta && key.name === "return") ||
      char === "\n"
    ) {
      insertPromptText("\n");
      return;
    }

    if (key.name === "return" || char === "\r") {
      const continuedPrompt = continuePromptAfterBackslash(promptValue, promptCursorIndex);
      if (continuedPrompt) {
        promptValue = continuedPrompt.value;
        promptCursorIndex = continuedPrompt.cursorIndex;
        promptHistoryIndex = null;
        updateMentionSuggestions();
        renderPromptLine(promptValue);
        return;
      }

      submitPrompt();
      return;
    }

    if (key.shift && key.name === "tab") {
      void cycleMode(1);
      return;
    }

    if (key.name === "tab") {
      if (activeMentionSuggestions.length > 0) {
        applySelectedMention();
      }
      return;
    }

    if (key.name === "left") {
      promptCursorIndex = Math.max(0, promptCursorIndex - 1);
      updateMentionSuggestions();
      renderPromptLine(promptValue);
      return;
    }

    if (key.name === "right") {
      promptCursorIndex = Math.min(promptValue.length, promptCursorIndex + 1);
      updateMentionSuggestions();
      renderPromptLine(promptValue);
      return;
    }

    if (key.name === "home") {
      promptCursorIndex = 0;
      updateMentionSuggestions();
      renderPromptLine(promptValue);
      return;
    }

    if (key.name === "end") {
      promptCursorIndex = promptValue.length;
      updateMentionSuggestions();
      renderPromptLine(promptValue);
      return;
    }

    if (key.name === "up") {
      if (activeMentionSuggestions.length > 0) {
        moveMentionSelection(-1);
        return;
      }
      showPreviousPrompt();
      return;
    }

    if (key.name === "down") {
      if (activeMentionSuggestions.length > 0) {
        moveMentionSelection(1);
        return;
      }
      showNextPrompt();
      return;
    }

    if (key.name === "backspace") {
      if (promptCursorIndex > 0) {
        promptValue =
          promptValue.slice(0, promptCursorIndex - 1) +
          promptValue.slice(promptCursorIndex);
        promptCursorIndex -= 1;
      }
      updateMentionSuggestions();
      renderPromptLine(promptValue);
      return;
    }

    if (key.name === "delete") {
      if (promptCursorIndex < promptValue.length) {
        promptValue =
          promptValue.slice(0, promptCursorIndex) +
          promptValue.slice(promptCursorIndex + 1);
      }
      updateMentionSuggestions();
      renderPromptLine(promptValue);
      return;
    }

    if (!key.ctrl && !key.meta && char) {
      insertPromptText(char);
    }
  };

  input.prependListener("data", onData);
  input.on("keypress", onKeypress);
}

async function readUserPrompt(): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    const rl = createPromptInterface({ input, output });
    const answer = await rl.question(`${colors.accent("▌")} `);
    rl.close();
    return answer.trim();
  }

  startPromptLoop();

  const pendingPrompt = pendingPrompts.shift();

  if (pendingPrompt) {
    return pendingPrompt;
  }

  return new Promise((resolve) => {
    promptWaiters.push(resolve);
  });
}

async function promptForApproval(question: {
  type?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  message?: unknown;
}): Promise<"approve" | "deny" | "abort"> {
  const toolName = typeof question.tool_name === "string" ? question.tool_name : "Tool";
  const toolInput = question.tool_input && typeof question.tool_input === "object"
    ? question.tool_input as Record<string, unknown>
    : {};
  const message = typeof question.message === "string" && question.message.trim().length > 0
    ? question.message.trim()
    : `Permission required for ${toolName}`;
  const shouldRestorePrompt = input.isTTY && output.isTTY && promptLoopStarted;
  const shouldRestoreSpinner = Boolean(activeRun && spinnerTimer);
  if (!input.isTTY || !output.isTTY) {
    const rl = createPromptInterface({ input, output });
    const answer = (await rl.question(`${message} [y/N]: `)).trim().toLowerCase();
    rl.close();
    if (/^(a|abort|stop|exit)$/i.test(answer)) {
      return "abort";
    }
    if (/^(y|yes|allow|approve)$/i.test(answer)) {
      return "approve";
    }
    return "deny";
  }

  approvalPromptActive = true;
  stopRunSpinner();
  approvalPrompt = {
    toolName,
    toolSummary: toolName === "Write" && typeof toolInput.file_path === "string"
      ? `Write(${formatToolDisplayPath(toolInput.file_path, activeCwd)})`
      : toolName === "Edit" && typeof toolInput.file_path === "string"
      ? `Update(${formatToolDisplayPath(toolInput.file_path, activeCwd)})`
      : toolName === "Bash" && typeof toolInput.command === "string"
      ? `Bash (${formatBashCommandSummary(toolInput.command)})`
      : toolName,
    message: typeof toolInput.file_path === "string" ? formatToolDisplayPath(toolInput.file_path, activeCwd) : message,
    previewLines: buildApprovalPreviewLines(toolName, toolInput),
    question: buildApprovalQuestion(toolName, toolInput),
    selectedIndex: 0,
    options: toolName === "Edit" || toolName === "Write"
      ? [
          { label: "Yes", decision: "approve" },
          { label: "Yes, allow all edits during this session (alt+m)", decision: "approve_for_session" },
          { label: "No", decision: "deny" },
        ]
      : [
          { label: "Yes", decision: "approve" },
          { label: "No", decision: "deny" },
          { label: "Abort run", decision: "abort" },
        ],
    resolve: () => {},
  };

  if (shouldRestorePrompt) {
    renderPromptLine(promptValue);
  }

  try {
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      if (!approvalPrompt) {
        resolve("deny");
        return;
      }
      approvalPrompt.resolve = resolve;
    });

    return decision === "approve_for_session" ? "approve" : decision;
  } finally {
    approvalPrompt = null;
    approvalPromptActive = false;

    if (shouldRestoreSpinner) {
      startRunSpinner();
    }
    if (shouldRestorePrompt) {
      renderPromptLine(promptValue);
    }
  }
}

async function promptForStructuredQuestion(
  question: Record<string, unknown>,
): Promise<string> {
  const normalized = normalizeUserQuestionPrompt(question);
  if (!normalized) {
    return "abort";
  }

  const shouldRestorePrompt = input.isTTY && output.isTTY && promptLoopStarted;
  const shouldRestoreSpinner = Boolean(activeRun && spinnerTimer);
  if (!input.isTTY || !output.isTTY) {
    const promptText = normalized.questions
      .map((entry, index) => `${index + 1}. ${entry.question}`)
      .join("\n");
    const rl = createPromptInterface({ input, output });
    const answer = await rl.question(`${promptText}\n> `);
    rl.close();
    return JSON.stringify({
      status: "submitted",
      answers: [{ id: normalized.questions[0]?.id ?? "question_1", value: answer }],
      answersById: { [normalized.questions[0]?.id ?? "question_1"]: answer },
    });
  }

  userQuestionPromptActive = true;
  userQuestionPrompt = normalized;
  stopRunSpinner();

  if (shouldRestorePrompt) {
    renderPromptLine(promptValue);
  }

  try {
    const response = await new Promise<UserQuestionPromptResponse>((resolve) => {
      if (!userQuestionPrompt) {
        resolve({ status: "aborted" });
        return;
      }
      userQuestionPrompt.resolve = resolve;
    });
    renderSubmittedQuestionAnswers(normalized, response);
    return JSON.stringify(response);
  } finally {
    userQuestionPrompt = null;
    userQuestionPromptActive = false;

    if (shouldRestoreSpinner) {
      startRunSpinner();
    }
    if (shouldRestorePrompt) {
      renderPromptLine(promptValue);
    }
  }
}

async function promptForUserQuestion(question: Record<string, unknown>): Promise<ToolResultContent | string> {
  if (question.type === "ask_user_question") {
    return promptForStructuredQuestion(question);
  }

  return promptForApproval(question);
}

function countBlockLines(text: string): number {
  return countRenderedRows(text, Math.max(1, output.columns ?? 80));
}

function liveBlockEndColumn(): number {
  const columns = Math.max(1, output.columns ?? 80);
  let column = 0;

  for (const char of liveBlockText.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")) {
    if (char === "\n") {
      column = 0;
      continue;
    }

    column = (column + 1) % columns;
  }

  return column;
}

function moveFromPromptToLiveEnd(): void {
  clearPromptBlock();

  if (liveBlockText.length > 0 && !liveBlockText.endsWith("\n")) {
    moveCursor(output, 0, -1);
    cursorTo(output, liveBlockEndColumn());
  }

  promptVisible = false;
}

function moveFromPromptToLiveStart(): void {
  const rowsToLiveStart = liveBlockLines;
  clearPromptBlock();

  if (rowsToLiveStart > 0) {
    moveCursor(output, 0, -rowsToLiveStart);
    cursorTo(output, 0);
  }

  promptVisible = false;
}

function replaceLiveBlock(renderedText: string): void {
  if (promptVisible) {
    moveFromPromptToLiveStart();
  } else if (liveBlockLines > 0) {
    moveCursor(output, 0, -liveBlockLines);
    cursorTo(output, 0);
  }

  if (liveBlockLines > 0) {
    output.write("\x1b[J");
  }

  liveBlockText = renderedText;
  liveBlockLines = liveBlockText.length > 0 ? countBlockLines(liveBlockText) : 0;

  if (liveBlockText.length > 0) {
    output.write(liveBlockText);
    if (!liveBlockText.endsWith("\n")) {
      output.write("\n");
    }
  }

  renderPromptLine(promptValue);
}

function appendLiveChunk(text: string): void {
  replaceLiveBlock(`${liveBlockText}${text}`);
}

function finishLiveBlock(options?: { persistReplay?: boolean }): void {
  if (liveBlockLines === 0) {
    return;
  }

  if (promptVisible) {
    moveFromPromptToLiveEnd();
  }

  if (options?.persistReplay && liveBlockText.length > 0) {
    recordTranscriptRawBlock(liveBlockText.endsWith("\n") ? liveBlockText : `${liveBlockText}\n`);
    recomputeTranscriptRowCount();
  }

  const finishedLiveBlockText = liveBlockText;
  liveBlockLines = 0;
  liveBlockText = "";
  if (!finishedLiveBlockText.endsWith("\n")) {
    output.write("\n");
  }
  renderPromptLine(promptValue);
}

async function streamText(text: string, delayMs = 220): Promise<void> {
  await sleep(delayMs);

  const chunks = text.match(/\S+\s*|\n/g) ?? [text];
  const chunkDelayMs = chunks.length > 180 ? 6 : 14;
  const livePrefix = "";

  if (!input.isTTY || !output.isTTY) {
    appendTranscript(livePrefix);

    for (const chunk of chunks) {
      appendTranscript(colors.body(chunk));
      await sleep(chunkDelayMs);
    }

    appendTranscript("\n\n");
    return;
  }

  appendLiveChunk(livePrefix);

  for (const chunk of chunks) {
    if (liveBlockFrozen) {
      liveBlockFrozen = false;
    }

    appendLiveChunk(colors.body(chunk));
    await sleep(chunkDelayMs);
  }

  finishLiveBlock();
}

function redrawStreamingLiveBlock(): void {
  replaceLiveBlock(renderStreamingAssistantLiveBlock(Math.max(1, output.columns ?? 80)));
}

function clearStreamingLiveBlockRedrawTimer(): void {
  if (!streamRedrawTimer) {
    return;
  }

  clearTimeout(streamRedrawTimer);
  streamRedrawTimer = undefined;
}

function scheduleStreamingLiveBlockRedraw(): void {
  if (!input.isTTY || !output.isTTY || streamRedrawTimer) {
    return;
  }

  streamRedrawTimer = setTimeout(() => {
    streamRedrawTimer = undefined;
    redrawStreamingLiveBlock();
  }, STREAM_REDRAW_FRAME_MS);
}

function applyAssistantStreamBuffer(delta: string): string {
  const previousVisibleText = streamedAssistantVisibleText;
  const next = applyBufferedStreamDelta({
    visibleText: streamedAssistantVisibleText,
    pendingText: pendingAssistantStreamText,
  }, delta);
  streamedAssistantVisibleText = next.visibleText;
  pendingAssistantStreamText = next.pendingText;
  return next.didFlush ? streamedAssistantVisibleText.slice(previousVisibleText.length) : "";
}

function flushAssistantStreamBuffer(): void {
  const next = flushBufferedStreamText({
    visibleText: streamedAssistantVisibleText,
    pendingText: pendingAssistantStreamText,
  });
  streamedAssistantVisibleText = next.visibleText;
  pendingAssistantStreamText = next.pendingText;
}

function applyThinkingStreamBuffer(delta: string): string {
  const previousVisibleText = streamedThinkingVisibleText;
  const next = applyBufferedStreamDelta({
    visibleText: streamedThinkingVisibleText,
    pendingText: pendingThinkingStreamText,
  }, delta);
  streamedThinkingVisibleText = next.visibleText;
  pendingThinkingStreamText = next.pendingText;
  return next.didFlush ? streamedThinkingVisibleText.slice(previousVisibleText.length) : "";
}

function flushThinkingStreamBuffer(): void {
  const next = flushBufferedStreamText({
    visibleText: streamedThinkingVisibleText,
    pendingText: pendingThinkingStreamText,
  });
  streamedThinkingVisibleText = next.visibleText;
  pendingThinkingStreamText = next.pendingText;
}

function resetAssistantStreamState(): void {
  streamedAssistantActive = false;
  streamedAssistantText = "";
  streamedAssistantVisibleText = "";
  pendingAssistantStreamText = "";
}

function resetThinkingStreamState(): void {
  streamedThinkingActive = false;
  streamedThinkingText = "";
  streamedThinkingVisibleText = "";
  pendingThinkingStreamText = "";
}

function clearLiveStreamDraft(): void {
  clearStreamingLiveBlockRedrawTimer();
  if (input.isTTY && output.isTTY && liveBlockLines > 0) {
    replaceLiveBlock("");
  }
}

function commitRawRenderedTranscriptBlock(renderedText: string): void {
  if (!renderedText) {
    return;
  }

  clearStreamingLiveBlockRedrawTimer();
  if (input.isTTY && output.isTTY) {
    replaceLiveBlock(renderedText);
    finishLiveBlock({ persistReplay: true });
    return;
  }

  appendTranscript(renderedText);
}

function commitAssistantPlainTranscript(text: string): void {
  if (!text) {
    return;
  }

  clearStreamingLiveBlockRedrawTimer();
  const rendered = renderAssistantPlainTranscript(text);
  if (input.isTTY && output.isTTY) {
    replaceLiveBlock(rendered);
    finishLiveBlock();
  } else {
    writeTranscript(rendered);
  }
  persistAssistantPlainTranscript(text);
}

function commitAssistantThinkingTranscript(text: string): void {
  if (!text) {
    return;
  }

  clearStreamingLiveBlockRedrawTimer();
  const rendered = renderAssistantThinkingTranscript(text);
  if (input.isTTY && output.isTTY) {
    replaceLiveBlock(rendered);
    finishLiveBlock();
  } else {
    writeTranscript(rendered);
  }
  persistAssistantThinkingTranscript(text);
}

function appendAssistantMarkdownTranscript(text: string): void {
  if (!text) {
    return;
  }

  commitRawRenderedTranscriptBlock(
    formatAssistantTranscriptBlock(renderTerminalMarkdown(text, markdownStyles))
  );
}

function appendAssistantTextDelta(text: string): void {
  if (!text) {
    return;
  }

  streamedAssistantText += text;
  const flushedText = applyAssistantStreamBuffer(text);

  if (!input.isTTY || !output.isTTY) {
    if (!streamedAssistantActive) {
      appendTranscript(formatAssistantTranscriptPrefix());
      streamedAssistantActive = true;
    }
    if (flushedText) {
      appendTranscript(colors.body(flushedText));
    }
    return;
  }

  if (!streamedAssistantActive) {
    stopRunSpinner();
    streamedAssistantActive = true;
  }

  if (liveBlockFrozen) {
    liveBlockFrozen = false;
  }

  if (flushedText) {
    scheduleStreamingLiveBlockRedraw();
  }
}

function appendAssistantThinkingDelta(text: string): void {
  if (!text) {
    return;
  }

  streamedThinkingText += text;
  const flushedText = applyThinkingStreamBuffer(text);

  if (!input.isTTY || !output.isTTY) {
    if (!streamedThinkingActive) {
      streamedThinkingActive = true;
      appendTranscript(formatAssistantTranscriptPrefix());
    }
    if (flushedText) {
      appendTranscript(renderThinkingEmphasis(flushedText, thinkingStyles));
    }
    return;
  }

  if (!streamedThinkingActive) {
    stopRunSpinner();
    streamedThinkingActive = true;
  }

  if (liveBlockFrozen) {
    liveBlockFrozen = false;
  }

  if (flushedText) {
    scheduleStreamingLiveBlockRedraw();
  }
}

function finishStreamedAssistantText(persistTranscript = true): void {
  const completedAssistantText = streamedAssistantText;
  flushAssistantStreamBuffer();
  if (!persistTranscript) {
    clearLiveStreamDraft();
    if (streamedAssistantActive && (!input.isTTY || !output.isTTY)) {
      appendTranscript("\n\n");
    }

    resetAssistantStreamState();
    return;
  }

  if (!streamedAssistantActive && !completedAssistantText) {
    resetAssistantStreamState();
    return;
  }

  if (completedAssistantText) {
    commitAssistantPlainTranscript(completedAssistantText);
  }
  resetAssistantStreamState();
}

function finishStreamedAssistantThinkingText(persistTranscript = true): void {
  const completedThinkingText = streamedThinkingText;
  flushThinkingStreamBuffer();
  if (!persistTranscript) {
    clearLiveStreamDraft();
    if (streamedThinkingActive && (!input.isTTY || !output.isTTY)) {
      appendTranscript("\n");
    }

    resetThinkingStreamState();
    return;
  }

  if (!streamedThinkingActive && !completedThinkingText) {
    resetThinkingStreamState();
    return;
  }

  if (persistTranscript && completedThinkingText) {
    completedStreamedThinkingText = completedThinkingText;
    commitAssistantThinkingTranscript(completedThinkingText);
  }
  resetThinkingStreamState();
}

function normalizeStreamedBlockText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function printToolHeader(label: string): void {
  ensureTranscriptGap();
  appendTranscript(`${colors.bullet("●")} ${chalk.bold(colors.body(label))}\n\n`);
}

function buildBranchLine(text: string, color = colors.body, options?: { leftPadding?: number }): string {
  const leftPadding = Math.max(0, options?.leftPadding ?? 2);
  return `${" ".repeat(leftPadding)}${colors.gutter("⎿")}  ${color(text)}\n`;
}

function printBranchLine(text: string, color = colors.body, options?: { leftPadding?: number }): void {
  appendTranscript(buildBranchLine(text, color, options));
}

function writeTransientBranchLine(run: BashRunRecord, text: string, color = colors.body): void {
  if (!output.isTTY) {
    return;
  }

  const shouldRestorePrompt = promptVisible;
  if (shouldRestorePrompt) {
    clearPromptBlock();
  }

  const line = buildBranchLine(text, color);
  output.write(line);
  run.statusRenderedRows = countRenderedRows(line, Math.max(1, output.columns ?? 80));

  if (shouldRestorePrompt) {
    renderPromptLine(promptValue);
  }
}

function clearTransientBranchLine(run: BashRunRecord, options?: { restorePrompt?: boolean }): void {
  if (!output.isTTY || !run.statusLineText) {
    return;
  }

  const shouldRestorePrompt = (options?.restorePrompt ?? true) && promptVisible;
  const rowsToClear = Math.max(1, run.statusRenderedRows);
  if (promptVisible) {
    clearPromptBlock();
  }

  moveCursor(output, 0, -rowsToClear);
  cursorTo(output, 0);
  for (let row = 0; row < rowsToClear; row += 1) {
    output.write("\x1b[2K");
    if (row < rowsToClear - 1) {
      moveCursor(output, 0, 1);
      cursorTo(output, 0);
    }
  }
  if (rowsToClear > 1) {
    moveCursor(output, 0, -(rowsToClear - 1));
    cursorTo(output, 0);
  }

  if (shouldRestorePrompt) {
    renderPromptLine(promptValue);
  }
}

function replaceTransientBranchLine(run: BashRunRecord, text: string, color = colors.body): void {
  const shouldRestorePrompt = promptVisible;
  clearTransientBranchLine(run, { restorePrompt: false });
  writeTransientBranchLine(run, text, color);
  if (shouldRestorePrompt && !promptVisible) {
    renderPromptLine(promptValue);
  }
}

function printContentLine(text: string, color = colors.body): void {
  appendTranscript(`     ${color(text)}\n`);
}

function printBashOutputLine(text: string, color = colors.body): void {
  printBranchLine(text, color);
}

function printToolOutputLines(lines: string[], color = colors.body, options?: { leftPadding?: number }): void {
  if (lines.length === 0) {
    return;
  }

  const formattedLines = formatToolTranscriptLines(lines, {
    leftPadding: options?.leftPadding,
  });

  for (const [index, line] of formattedLines.entries()) {
    if (index === 0) {
      const markerIndex = line.indexOf("⎿");
      const prefix = markerIndex >= 0 ? line.slice(0, markerIndex) : "";
      const content = markerIndex >= 0 ? line.slice(markerIndex + 3) : line.trimStart();
      appendTranscript(`${prefix}${colors.gutter("⎿")}  ${color(content)}\n`);
      continue;
    }

    appendTranscript(`${color(line)}\n`);
  }
}

function appendLiveTerminalLines(run: BashRunRecord, lines: string[], elapsedMs: number): void {
  if (lines.length === 0) {
    return;
  }

  if (!run.liveTerminalBlock) {
    run.liveTerminalBlock = {
      kind: "liveTerminal",
      title: "Live terminal",
      lines: [],
      height: LIVE_TERMINAL_VISIBLE_ROWS,
      elapsedMs,
    };
    transcriptBlocks.push(run.liveTerminalBlock);
  }

  run.liveTerminalBlock.elapsedMs = elapsedMs;
  run.liveTerminalBlock.lines.push(...lines);
  if (run.liveTerminalBlock.lines.length > run.liveTerminalBlock.height) {
    run.liveTerminalBlock.lines = run.liveTerminalBlock.lines.slice(-run.liveTerminalBlock.height);
  }

  if (output.isTTY) {
    redrawTranscriptInPlace();
    return;
  }

  writeTranscript(renderLiveTerminalTranscript(run.liveTerminalBlock, Math.max(1, output.columns ?? 80)));
  recomputeTranscriptRowCount();
}

function printPreviewLine(line: PreviewLine, color = colors.body): void {
  if (line.variant === "diffAdd") {
    appendTranscript(`     ${colors.diffAddBand(` ${line.text}\x1b[K`)}\n`);
    return;
  }

  if (line.variant === "diffRemove") {
    appendTranscript(`     ${colors.diffRemoveBand(` ${line.text}\x1b[K`)}\n`);
    return;
  }

  printBranchLine(line.text, color);
}

function printPreviewLines(lines: PreviewLine[], colorForDefault = colors.body): void {
  const defaultLines: string[] = [];
  const flushDefaultLines = () => {
    if (defaultLines.length > 0) {
      printToolOutputLines(defaultLines, colorForDefault);
      defaultLines.length = 0;
    }
  };

  for (const line of lines) {
    if (line.variant === "default") {
      defaultLines.push(line.text);
      continue;
    }

    flushDefaultLines();
    printPreviewLine(line, resolvePreviewColor(line.variant));
  }

  flushDefaultLines();
}

function resolvePreviewColor(variant: "default" | "diffAdd" | "diffRemove") {
  return variant === "diffAdd"
    ? colors.diffAdd
    : variant === "diffRemove"
    ? colors.diffRemove
    : colors.dim;
}

function isEditTool(tool: ToolCallRecord): boolean {
  return tool.name === "Edit";
}

function shouldDeferToolCallRender(tool: ToolCallRecord): boolean {
  return tool.name === "Edit" || tool.name === "Write" || tool.name === "Bash" || tool.name === "TodoWrite";
}

function isUserRejectedToolResult(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  return normalized === "deny"
    || normalized === "abort"
    || normalized.startsWith("permission denied");
}

function splitPreviewLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function diffCountLabel(count: number): string {
  return `${count} line${count === 1 ? "" : "s"}`;
}

function formatDiffLineNumber(value: number | null, width: number): string {
  return value === null ? " ".repeat(width) : String(value).padStart(width, " ");
}

function formatGitHubStyleDiffLine(args: {
  line: string;
  variant: "diffAdd" | "diffRemove";
  lineNumber: number;
  width: number;
}): PreviewLine {
  const sign = args.variant === "diffAdd" ? "+" : "-";
  const lineNumber = formatDiffLineNumber(args.lineNumber, args.width);

  return {
    text: `${lineNumber} ${sign}${args.line}`,
    variant: args.variant,
  };
}

function buildEditDiffPreview(tool: ToolCallRecord): PreviewLine[] {
  const oldText = typeof tool.input.old_text === "string" ? tool.input.old_text : "";
  const newText = typeof tool.input.new_text === "string" ? tool.input.new_text : "";
  const oldLines = splitPreviewLines(oldText);
  const newLines = splitPreviewLines(newText);
  const lineNumberWidth = String(Math.max(oldLines.length, newLines.length, 1)).length;

  return [
    {
      text: `Added ${diffCountLabel(newLines.length)}, removed ${diffCountLabel(oldLines.length)}`,
      variant: "default",
    },
    ...oldLines.map((line, index) =>
      formatGitHubStyleDiffLine({
        line,
        variant: "diffRemove",
        lineNumber: index + 1,
        width: lineNumberWidth,
      })
    ),
    ...newLines.map((line, index) =>
      formatGitHubStyleDiffLine({
        line,
        variant: "diffAdd",
        lineNumber: index + 1,
        width: lineNumberWidth,
      })
    ),
  ];
}

function summarizeToolInput(tool: ToolCallRecord): string {
  if (isEditTool(tool) && typeof tool.input.file_path === "string") {
    return `Update(${formatToolDisplayPath(tool.input.file_path, activeCwd)})`;
  }

  if (tool.name === "Bash" && typeof tool.input.command === "string") {
    return `Bash (${formatBashCommandSummary(tool.input.command)})`;
  }

  return formatToolSummary(tool);
}

function toolResultContentToLines(content: ToolResultContent): string[] {
  if (typeof content === "string") {
    return content.split("\n");
  }

  return content.flatMap((block) => {
    if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
      return String(block.text).split("\n");
    }

    if (block && typeof block === "object") {
      return formatToolResultBlockPreview(block as Record<string, unknown>).map((line) => line.text);
    }

    return [String(block)];
  });
}

function getOrCreateBashRun(toolUseId: string): BashRunRecord {
  let record = bashRuns.get(toolUseId);
  if (!record) {
    record = {
      headerShown: false,
      streamedLines: [],
      outputStarted: false,
      liveTerminalBlock: null,
      statusRenderedRows: 0,
      lastElapsedSecond: null,
      statusLineText: null,
      startedAt: null,
      timeoutMs: null,
      timer: null,
      displayTimer: null,
    };
    bashRuns.set(toolUseId, record);
  }

  return record;
}

function splitBashProgressOutput(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function stripLeadingStreamedLines(lines: string[], streamedLines: string[]): string[] {
  return stripAlreadyRenderedToolLines(lines, streamedLines);
}

function updateBashRunningStatus(run: BashRunRecord, elapsedMs: number, timeoutMs: number | null): void {
  if (!run.headerShown || run.outputStarted || !run.statusLineText) {
    return;
  }

  const elapsedSecond = Math.max(0, Math.floor(elapsedMs / 1000));
  if (run.lastElapsedSecond === elapsedSecond) {
    return;
  }

  const statusText = formatBashRunningStatus({
    elapsedMs,
    timeoutMs,
  });
  replaceTransientBranchLine(run, statusText, colors.dim);
  run.lastElapsedSecond = elapsedSecond;
  run.statusLineText = statusText;
}

function startBashRunningTimer(run: BashRunRecord): void {
  if (run.timer || run.startedAt === null) {
    return;
  }

  run.timer = setInterval(() => {
    if (run.startedAt === null) {
      return;
    }

    updateBashRunningStatus(run, Date.now() - run.startedAt, run.timeoutMs);
  }, 1_000);
}

function stopBashRunningTimer(run: BashRunRecord): void {
  if (!run.timer) {
    return;
  }

  clearInterval(run.timer);
  run.timer = null;
}

function stopBashRunningDisplayTimer(run: BashRunRecord): void {
  if (!run.displayTimer) {
    return;
  }

  clearTimeout(run.displayTimer);
  run.displayTimer = null;
}

function showBashRunningStatus(run: BashRunRecord, statusText: string): void {
  if (run.statusLineText || run.outputStarted) {
    return;
  }

  writeTransientBranchLine(run, statusText, colors.dim);
  run.statusLineText = statusText;
  run.lastElapsedSecond = run.startedAt === null ? 0 : Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000));
  startBashRunningTimer(run);
}

function finishBashRunningStatus(run: BashRunRecord): void {
  stopBashRunningDisplayTimer(run);
  stopBashRunningTimer(run);
  run.statusRenderedRows = 0;
  run.statusLineText = null;
}

function renderBashProgress(message: Extract<SDKMessage, { type: "system"; subtype: "tool_progress" }>): void {
  if (message.tool_name !== "Bash" || message.status !== "running") {
    return;
  }

  const tool = toolCalls.get(message.tool_use_id);
  if (!tool) {
    return;
  }

  const run = getOrCreateBashRun(message.tool_use_id);
  const elapsedMs = message.elapsed_ms ?? 0;
  const timeoutMs = message.timeout_ms ?? run.timeoutMs;
  const elapsedSecond = Math.max(0, Math.floor(elapsedMs / 1000));
  if (!run.headerShown) {
    renderToolCall(tool);
    run.headerShown = true;
    run.startedAt = Date.now() - elapsedMs;
    run.timeoutMs = timeoutMs ?? null;
    run.lastElapsedSecond = elapsedSecond;
    run.displayTimer = setTimeout(() => {
      run.displayTimer = null;
      const liveElapsedMs = run.startedAt === null ? elapsedMs : Math.max(0, Date.now() - run.startedAt);
      showBashRunningStatus(run, formatBashRunningStatus({
        elapsedMs: liveElapsedMs,
        timeoutMs: run.timeoutMs,
      }));
    }, 150);
  } else if (run.statusLineText) {
    updateBashRunningStatus(run, elapsedMs, timeoutMs ?? null);
  }

  if (!message.output) {
    return;
  }

  run.outputStarted = true;
  const outputLines = splitBashProgressOutput(message.output);
  const newOutputLines = stripLeadingStreamedLines(outputLines, run.streamedLines);
  run.streamedLines.push(...newOutputLines);
  lastVisibleToolOutput = run.streamedLines.join("\n");
  if (run.statusLineText) {
    clearBashRunningStatus(message.tool_use_id);
  } else {
    stopBashRunningDisplayTimer(run);
  }

  stopBashRunningTimer(run);
  if (newOutputLines.length === 0) {
    finishBashRunningStatus(run);
    return;
  }

  appendLiveTerminalLines(run, newOutputLines, elapsedMs);
}

function clearBashRunningStatus(toolUseId: string): void {
  const run = bashRuns.get(toolUseId);
  if (!run?.statusLineText) {
    return;
  }

  if (output.isTTY) {
    redrawTranscriptInPlace(run.statusRenderedRows);
  }
  finishBashRunningStatus(run);
}

function renderToolCall(tool: ToolCallRecord): void {
  if (tool.rendered) {
    return;
  }

  if (isAskUserQuestionTool(tool)) {
    tool.rendered = true;
    return;
  }

  printToolHeader(summarizeToolInput(tool));

  if (tool.name !== "Bash" && Object.keys(tool.input).length > 0) {
    const previewLines = isEditTool(tool)
      ? buildEditDiffPreview(tool)
      : formatToolInputPreview(tool);
    const visibleCount = tool.name === "Write" ? 11 : 12;
    const visibleLines = previewLines.slice(0, visibleCount);
    printPreviewLines(visibleLines, colors.dim);

    if (previewLines.length > visibleLines.length) {
      printContentLine(`… +${previewLines.length - visibleLines.length} lines`, colors.dim);
    }
  }

  tool.rendered = true;
}

async function renderToolResult(message: Extract<SDKMessage, { type: "system"; subtype: "tool_result" }>): Promise<void> {
  const tool = toolCalls.get(message.tool_use_id) ?? {
    id: message.tool_use_id,
    name: message.tool_name,
    input: {},
    rendered: false,
  };

  const content = toolResultContentToLines(message.content).join("\n");
  if (isTodoWriteTool(tool) && !message.is_error) {
    const panel = resolveTodoPanel(tool, message.content);
    activeTodoPanel = panel && panel.items.length > 0 ? panel : null;
    tool.rendered = true;
    renderPromptLine(promptValue);
    return;
  }

  if (isAskUserQuestionTool(tool) && !message.is_error) {
    tool.rendered = true;
    return;
  }

  if (shouldDeferToolCallRender(tool) && message.is_error && isUserRejectedToolResult(content)) {
    tool.rendered = true;
    return;
  }

  renderToolCall(tool);
  if (tool.name === "Bash") {
    clearBashRunningStatus(message.tool_use_id);
  }

  const filePath = typeof tool.input.file_path === "string" ? tool.input.file_path : null;
  const rawPreviewLines = isEditTool(tool) && !message.is_error
    ? toolResultContentToLines(message.content)
        .map((line) => ({
          text: filePath ? rewriteEditToolResultLine(line, filePath, activeCwd) : line,
          variant: "default" as const,
        }))
        .filter((line) => !/^edited\b/i.test(line.text.trim()))
    : formatToolResultPreview(tool, content);
  const previewLines = tool.name === "Bash"
    ? (() => {
        const run = bashRuns.get(message.tool_use_id);
        if (!run) {
          return rawPreviewLines;
        }

        const remainingLines = stripLeadingStreamedLines(
          rawPreviewLines.map((line) => line.text),
          run.streamedLines,
        );
        return remainingLines.map((text) => ({ text, variant: "default" as const }));
      })()
    : rawPreviewLines;
  const filteredPreviewLines = previewLines.filter((line) => line.text.length > 0);
  const visibleLines = tool.name === "Bash"
    ? filteredPreviewLines.slice(-LIVE_TERMINAL_VISIBLE_ROWS)
    : filteredPreviewLines.slice(0, 12);
  if (tool.name === "Bash") {
    clearBashRunningStatus(message.tool_use_id);
    const run = getOrCreateBashRun(message.tool_use_id);
    const elapsedMs = run.startedAt === null ? 0 : Math.max(0, Date.now() - run.startedAt);
    const streamedOutputShown = run.streamedLines.length > 0 && run.liveTerminalBlock;
    if (!streamedOutputShown) {
      const finalLines = visibleLines.map((line) => line.text);
      if (finalLines.length > 0) {
        appendLiveTerminalLines(run, finalLines, elapsedMs);
      }
    } else if (run.liveTerminalBlock) {
      run.liveTerminalBlock.elapsedMs = run.startedAt === null ? run.liveTerminalBlock.elapsedMs : Math.max(0, Date.now() - run.startedAt);
      if (output.isTTY) {
        redrawTranscriptInPlace();
      }
    }
    await sleep(0);
  } else if (message.is_error) {
    printToolOutputLines(
      visibleLines.map((line) => line.text),
      colors.error,
    );
    await sleep(0);
  } else {
    printPreviewLines(visibleLines, colors.body);
    await sleep(0);
  }

  if (tool.name !== "Bash" && filteredPreviewLines.length > visibleLines.length) {
    printContentLine(`… +${filteredPreviewLines.length - visibleLines.length} lines`, colors.dim);
  }

  pendingSuccessfulEdit = isEditTool(tool) && !message.is_error && filePath
    ? { filePath }
    : null;
  lastVisibleToolOutput = tool.name === "Bash" && !message.is_error
    ? content
    : null;

  if (tool.name === "Bash") {
    bashRuns.delete(message.tool_use_id);
  }

  if (tool.name !== "Bash") {
    appendTranscript("\n");
  }
}

async function renderAssistantMessage(message: Extract<SDKMessage, { type: "assistant" }>): Promise<void> {
  const text = message.message.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const thinkingBlocks = message.message.content
    .filter((block): block is ThinkingBlock => block.type === "thinking")
    .map((block) => block.thinking.trim())
    .filter((block) => block.length > 0);

  if (text) {
    finishStreamedAssistantThinkingText();
    if (shouldSuppressDuplicateToolEcho(lastVisibleToolOutput, text)) {
      finishStreamedAssistantText(false);
      pendingToolEchoText = "";
      pendingSuccessfulEdit = null;
      lastVisibleToolOutput = null;
      return;
    }

    const renderedText = pendingSuccessfulEdit
      ? rewriteSuccessfulEditAssistantMarkdown(text, pendingSuccessfulEdit.filePath, activeCwd)
      : text;
    finishStreamedAssistantText(false);
    appendAssistantMarkdownTranscript(renderedText);
  } else {
    finishStreamedAssistantText();
    finishStreamedAssistantThinkingText();
  }

  const completedThinkingComparable = normalizeStreamedBlockText(completedStreamedThinkingText);
  for (const thinking of thinkingBlocks) {
    if (completedThinkingComparable.length > 0) {
      continue;
    }

    if (!shouldAttachThinkingToPreviousAssistantBlock()) {
      ensureTranscriptGap();
    }
    appendAssistantThinkingTranscript(thinking);
  }
  completedStreamedThinkingText = "";

  pendingSuccessfulEdit = null;
  lastVisibleToolOutput = null;
  pendingToolEchoText = "";

  for (const block of message.message.content) {
    if (block.type !== "tool_use") {
      continue;
    }

    const tool: ToolCallRecord = {
      id: block.id,
      name: block.name,
      input: block.input,
      rendered: false,
    };
    toolCalls.set(block.id, tool);
    if (!shouldDeferToolCallRender(tool)) {
      renderToolCall(tool);
    }
  }
}

async function runSdkResponse(userPrompt: string): Promise<void> {
  toolCalls.clear();
  for (const run of bashRuns.values()) {
    stopBashRunningTimer(run);
  }
  bashRuns.clear();
  clearStreamingLiveBlockRedrawTimer();
  resetAssistantStreamState();
  resetThinkingStreamState();
  completedStreamedThinkingText = "";
  pendingToolEchoText = "";
  const run = await client.query(userPrompt, {
    includePartialMessages: true,
    mode: activeModeId === "default" ? undefined : activeModeId,
    permissionMode: requestedPermissionMode,
    onUserQuestion: async (question) => promptForUserQuestion(question),
  });
  activeRun = run;
  activeTaskId = null;
  stopRequested = false;
  startRunSpinner();

  try {
    for await (const message of run) {
      if (message.type === "system" && message.subtype === "init") {
        activeSessionId = message.session_id;
        const nextModel = message.model || activeModel;
        if (nextModel !== activeModel) {
          activeModel = nextModel;
          activeModelContextWindow = null;
          sessionUsageTotals.contextWindow = null;
          sessionUsageTotals.providerLabel = null;
          sessionUsageTotals.subscription = false;
          sessionUsageTotals.effort = activeEffort;
          void refreshActiveModelMetadata();
        } else {
          activeModel = nextModel;
        }
        activePermissionMode = message.permissionMode || activePermissionMode;
        renderPromptLine(promptValue);
        continue;
      }

      if (message.type === "system" && message.subtype === "status") {
        activeSessionId = message.session_id;
        activePermissionMode = message.permissionMode || activePermissionMode;
        continue;
      }

      if (message.type === "system" && message.subtype === "task_started") {
        activeTaskId = message.task_id;
        continue;
      }

      if (message.type === "system" && message.subtype === "task_progress") {
        continue;
      }

      if (message.type === "system" && message.subtype === "tool_progress" && message.status === "running") {
        renderBashProgress(message);
        continue;
      }

      if (message.type === "stream_event") {
        const textDelta = extractAssistantTextDelta(message.event);
        const thinkingDelta = extractAssistantThinkingDelta(message.event);
        if (thinkingDelta) {
          appendAssistantThinkingDelta(thinkingDelta);
        }
        if (textDelta) {
          if (streamedThinkingText.trim().length > 0 || streamedThinkingActive) {
            finishStreamedAssistantThinkingText();
          }
          const echoDecision = resolveDuplicateToolEchoDelta(lastVisibleToolOutput, pendingToolEchoText, textDelta);
          if (echoDecision.shouldBuffer) {
            pendingToolEchoText = echoDecision.bufferedText;
            continue;
          }
          pendingToolEchoText = "";
          appendAssistantTextDelta(echoDecision.text);
        }
        continue;
      }

      if (message.type === "assistant") {
        await renderAssistantMessage(message);
        continue;
      }

      if (message.type === "system" && message.subtype === "tool_result") {
        await renderToolResult(message);
        continue;
      }

      if (message.type === "system" && message.subtype === "task_notification") {
        printBranchLine(message.message, colors.dim);
        continue;
      }

      if (message.type === "result" && message.subtype === "aborted_by_user") {
        renderInterruptedMessage();
        continue;
      }

      if (message.type === "result" && message.subtype === "success") {
        const seconds = (message.duration_ms / 1000).toFixed(1);
        const tokens = message.usage.input_tokens + message.usage.output_tokens;
        const runCostUsd = message.total_cost_usd > 0
          ? message.total_cost_usd
          : estimateOpenAICostUsd(activeModel, message.usage);
        const formattedRunCost = formatRunCostUsd(runCostUsd);
        sessionUsageTotals.inputTokens += message.usage.input_tokens;
        sessionUsageTotals.outputTokens += message.usage.output_tokens;
        sessionUsageTotals.totalCostUsd += runCostUsd;
        sessionUsageTotals.contextWindow = activeModelContextWindow;
        sessionUsageTotals.effort = activeEffort;
        const runCompleteLine = `${colors.bullet("●")} ${colors.dim(
          `Run complete · ${message.num_turns} turns · ${tokens} tokens${formattedRunCost ? ` · ${formattedRunCost}` : ""} · ${seconds}s`
        )}`;
        const replayBlock = formatRunCompleteTranscriptBlock(runCompleteLine);
        if (input.isTTY && output.isTTY) {
          appendTranscriptWithReplayText(formatRunCompleteLine(runCompleteLine), replayBlock);
        } else {
          appendTranscript(replayBlock);
        }
        continue;
      }

      if (message.type === "result" && message.is_error) {
        appendTranscript(`${colors.error("Run ended with an error:")} ${message.result ?? message.subtype}\n`);
      }
    }
  } finally {
    finishStreamedAssistantThinkingText();
    finishStreamedAssistantText();
    stopRunSpinner();
    activeRun = null;
    activeTaskId = null;
    stopRequested = false;
    renderPromptLine(promptValue);
  }
}

process.once("exit", () => {
  clearStreamingLiveBlockRedrawTimer();
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  }
  if (bracketedPasteEnabled) {
    output.write("\x1b[?2004l");
    bracketedPasteEnabled = false;
  }
});

async function queueSdkResponse(userPrompt: string): Promise<void> {
  responseQueue = responseQueue
    .then(async () => {
      await runSdkResponse(userPrompt);
    })
    .catch((error) => {
      if (isAbortError(error)) {
        renderInterruptedMessage();
        return;
      }

      appendTranscript(`${colors.error("Something went wrong:")} ${String(error)}\n`);
    });
  await responseQueue;
}

async function main(): Promise<void> {
  await loadInitialRuntimeSettings();
  void refreshActiveModelMetadata();
  loadBranchName();

  while (true) {
    const userPrompt = await readUserPrompt();

    if (!userPrompt) {
      continue;
    }

    if (handleSlashCommand(userPrompt)) {
      continue;
    }

    queueSdkResponse(userPrompt).catch((error) => {
      if (isAbortError(error)) {
        renderInterruptedMessage();
        return;
      }

      appendTranscript(`${colors.error("Something went wrong:")} ${String(error)}\n`);
    });
  }
}

main().catch((error) => {
  console.error(colors.error("Something went wrong:"), error);
  process.exitCode = 1;
});
