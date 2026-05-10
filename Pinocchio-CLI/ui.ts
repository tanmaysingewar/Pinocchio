import path from "node:path";

export type SlashCommand = {
  name: string;
  args: string;
};

export type CliStatus = {
  projectName: string;
  branchName: string | null;
  model: string;
  permissionMode: string;
  cwd: string;
};

export type ToolSummaryInput = {
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultPreviewLine = {
  text: string;
  variant: "default" | "diffAdd" | "diffRemove";
};

export type ExpansionRecord = {
  title: string;
  hiddenLines: ToolResultPreviewLine[];
};

export type MarkdownStyles = {
  heading: (text: string) => string;
  bold: (text: string) => string;
  italic?: (text: string) => string;
  strikethrough?: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  quote: (text: string) => string;
  bullet: (text: string) => string;
  link?: (text: string, href: string) => string;
  rule?: () => string;
  body: (text: string) => string;
  dim: (text: string) => string;
};

export type CliAppearance = "light" | "dark";

export type PromptLayout = {
  cursorRowIndex: number;
  totalRows: number;
};

export type PromptLayoutInput = {
  columns: number;
  cursorColumn: number;
  inputLineIndex: number;
  lines: string[];
};

export type PromptFrameInput = {
  divider: string;
  inputLines: string[];
  panelLines?: string[];
  suggestionLines?: string[];
  footerLines: string[];
  statusLine?: string | null;
};

export type PromptUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  contextWindow?: number | null;
  providerLabel?: string | null;
  effort?: string | null;
  subscription?: boolean;
  autoCompact?: boolean;
};

export type PromptFrame = {
  lines: string[];
  inputLineIndex: number;
};

export type MentionCandidate = {
  path: string;
  isDirectory: boolean;
};

export type MentionSuggestion = MentionCandidate & {
  replacement: string;
};

export type MentionResolution = {
  query: string;
  replaceStart: number;
  replaceEnd: number;
  suggestions: MentionSuggestion[];
};

export type MentionQueryParts = {
  directory: string;
  fragment: string;
};

export type MentionViewport = {
  startIndex: number;
  endIndex: number;
};

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  text: string;
  status: TodoStatus;
};

export type TodoPanel = {
  title: string;
  items: TodoItem[];
};

export type KeypressLike = {
  ctrl?: boolean;
  name?: string;
  meta?: boolean;
};

const PERMISSION_LABELS: Record<string, string> = {
  bypassPermissions: "bypass",
  acceptEdits: "accept edits",
  default: "ask",
};

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function parseTerminalBackgroundCode(env: Record<string, string | undefined>): number | null {
  const colorFgBg = env.COLORFGBG?.trim();
  if (!colorFgBg) {
    return null;
  }

  const segments = colorFgBg.split(";");
  const backgroundSegment = segments.at(-1)?.trim();
  if (!backgroundSegment || !/^\d+$/.test(backgroundSegment)) {
    return null;
  }

  return Number(backgroundSegment);
}

function appearanceFromTerminalBackground(code: number): CliAppearance | null {
  if (!Number.isFinite(code)) {
    return null;
  }

  if (code <= 6 || code === 8) {
    return "dark";
  }

  if (code === 7 || code === 15) {
    return "light";
  }

  if (code >= 232 && code <= 255) {
    return "dark";
  }

  if (code >= 0 && code <= 255) {
    return code >= 244 ? "light" : "dark";
  }

  return null;
}

export function resolveCliAppearance(input: {
  env: Record<string, string | undefined>;
  systemAppearance: CliAppearance | null;
}): CliAppearance {
  const terminalBackground = parseTerminalBackgroundCode(input.env);
  const terminalAppearance = terminalBackground === null
    ? null
    : appearanceFromTerminalBackground(terminalBackground);

  if (terminalAppearance) {
    return terminalAppearance;
  }

  return input.systemAppearance ?? "dark";
}

export function resolveModeEditorItemEnabled(input: {
  runtimeEnabled: boolean;
  allowedInMode: boolean;
}): boolean {
  return input.allowedInMode;
}

export function visibleLength(text: string): number {
  return text.replace(ANSI_PATTERN, "").length;
}

function visualRowCount(text: string, columns: number): number {
  const safeColumns = Math.max(1, columns);
  return Math.max(1, Math.ceil(visibleLength(text) / safeColumns));
}

export function calculatePromptLayout(input: PromptLayoutInput): PromptLayout {
  const columns = Math.max(1, input.columns);
  const rowsByLine = input.lines.map((line) => visualRowCount(line, columns));
  const rowsBeforeInput = rowsByLine
    .slice(0, input.inputLineIndex)
    .reduce((sum, rows) => sum + rows, 0);
  const cursorRowWithinInput = Math.floor(Math.max(0, input.cursorColumn) / columns);

  return {
    cursorRowIndex: rowsBeforeInput + cursorRowWithinInput,
    totalRows: rowsByLine.reduce((sum, rows) => sum + rows, 0),
  };
}

export function buildPromptLines(input: PromptFrameInput): PromptFrame {
  const panelLines = input.panelLines ?? [];
  const suggestionLines = input.suggestionLines ?? [];
  const prefixLines = input.statusLine ? ["", input.statusLine, ...panelLines] : panelLines;
  const suffixLines = suggestionLines.length > 0 ? suggestionLines : input.footerLines;
  const inputLines = input.inputLines.length > 0 ? input.inputLines : [""];
  const lines = [...prefixLines, input.divider, ...inputLines, input.divider, ...suffixLines];

  return {
    lines,
    inputLineIndex: prefixLines.length + 1,
  };
}

function normalizeTodoStatus(record: Record<string, unknown>): TodoStatus {
  const rawStatus = [record.status, record.state, record.checked, record.completed, record.done, record.active]
    .find((value) => value !== undefined);

  if (typeof rawStatus === "string") {
    const normalized = rawStatus.trim().toLowerCase();
    if (["completed", "complete", "done", "checked"].includes(normalized)) {
      return "completed";
    }

    if (["in_progress", "in-progress", "in progress", "active", "current", "running"].includes(normalized)) {
      return "in_progress";
    }
  }

  if (record.completed === true || record.done === true || record.checked === true) {
    return "completed";
  }

  if (record.active === true || record.current === true || record.in_progress === true) {
    return "in_progress";
  }

  return "pending";
}

function normalizeTodoText(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidate = [
    record.content,
    record.text,
    record.title,
    record.task,
    record.label,
    record.name,
  ].find((entry) => typeof entry === "string" && entry.trim().length > 0);

  return typeof candidate === "string" ? candidate.trim() : null;
}

function todoCollectionFromValue(value: unknown): { title: string; items: unknown[] } | null {
  if (Array.isArray(value)) {
    return {
      title: "Update Todos",
      items: value,
    };
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const items = [record.todos, record.items, record.tasks].find(Array.isArray) as unknown[] | undefined;
  if (!items) {
    return null;
  }

  const titleCandidate = [record.title, record.header, record.name, record.label]
    .find((entry) => typeof entry === "string" && entry.trim().length > 0);

  return {
    title: typeof titleCandidate === "string" ? titleCandidate.trim() : "Update Todos",
    items,
  };
}

export function formatTodoPanel(value: unknown): TodoPanel | null {
  const collection = todoCollectionFromValue(value);
  if (!collection) {
    return null;
  }

  return {
    title: collection.title,
    items: collection.items.flatMap((item) => {
      const text = normalizeTodoText(item);
      if (!text) {
        return [];
      }

      return [{
        text,
        status: typeof item === "object" && item && !Array.isArray(item)
          ? normalizeTodoStatus(item as Record<string, unknown>)
          : "pending",
      }];
    }),
  };
}

function normalizeMentionPath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function splitMentionQuery(query: string): MentionQueryParts {
  const normalizedQuery = normalizeMentionPath(query);
  if (normalizedQuery === "." || normalizedQuery === "..") {
    return {
      directory: `${normalizedQuery}/`,
      fragment: "",
    };
  }

  if (normalizedQuery.endsWith("/")) {
    return {
      directory: normalizedQuery,
      fragment: "",
    };
  }

  const lastSlashIndex = normalizedQuery.lastIndexOf("/");
  if (lastSlashIndex < 0) {
    return {
      directory: "",
      fragment: normalizedQuery,
    };
  }

  return {
    directory: normalizedQuery.slice(0, lastSlashIndex + 1),
    fragment: normalizedQuery.slice(lastSlashIndex + 1),
  };
}

function isWhitespace(char: string | undefined): boolean {
  return !char || /\s/.test(char);
}

export function findActiveMention(value: string, cursorIndex: number): {
  query: string;
  replaceStart: number;
  replaceEnd: number;
} | null {
  const safeCursorIndex = Math.max(0, Math.min(cursorIndex, value.length));
  let tokenStart = safeCursorIndex;

  while (tokenStart > 0 && !isWhitespace(value[tokenStart - 1])) {
    tokenStart -= 1;
  }

  let tokenEnd = safeCursorIndex;
  while (tokenEnd < value.length && !isWhitespace(value[tokenEnd])) {
    tokenEnd += 1;
  }

  const token = value.slice(tokenStart, tokenEnd);
  if (!token.startsWith("@")) {
    return null;
  }

  if (token.length > 1 && token.slice(1).includes("@")) {
    return null;
  }

  return {
    query: token.slice(1),
    replaceStart: tokenStart,
    replaceEnd: tokenEnd,
  };
}

function rankMentionCandidate(candidate: MentionCandidate, normalizedQuery: string): number | null {
  if (!normalizedQuery) {
    return 0;
  }

  const normalizedPath = normalizeMentionPath(candidate.path).toLowerCase();
  const baseName = normalizedPath.split("/").at(-1) ?? normalizedPath;
  if (normalizedPath.startsWith(normalizedQuery)) {
    return 0;
  }
  if (baseName.startsWith(normalizedQuery)) {
    return 1;
  }
  if (normalizedPath.includes(`/${normalizedQuery}`)) {
    return 2;
  }
  if (normalizedPath.includes(normalizedQuery)) {
    return 3;
  }
  return null;
}

export function resolveMentionSuggestions(
  candidates: MentionCandidate[],
  value: string,
  cursorIndex: number,
  limit?: number,
): MentionResolution | null {
  const mention = findActiveMention(value, cursorIndex);
  if (!mention) {
    return null;
  }

  const normalizedQuery = normalizeMentionPath(mention.query).toLowerCase();
  const suggestions = candidates
    .map((candidate) => {
      const rank = rankMentionCandidate(candidate, normalizedQuery);
      if (rank === null) {
        return null;
      }

      const normalizedPath = normalizeMentionPath(candidate.path);
      const replacement = `@${normalizedPath}${candidate.isDirectory ? "/" : ""}`;
      return {
        ...candidate,
        path: normalizedPath,
        replacement,
        rank,
      };
    })
    .filter((candidate): candidate is MentionSuggestion & { rank: number } => candidate !== null)
    .sort((left, right) => {
      if (left.rank !== right.rank) {
        return left.rank - right.rank;
      }
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }
      if (left.path.length !== right.path.length) {
        return left.path.length - right.path.length;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, typeof limit === "number" ? Math.max(1, limit) : undefined)
    .map(({ rank: _rank, ...candidate }) => candidate);

  return suggestions.length > 0
    ? {
      ...mention,
      suggestions,
    }
    : null;
}

export function formatMentionSuggestionLabel(suggestion: MentionSuggestion): string {
  return `@${suggestion.path}${suggestion.isDirectory ? "/" : ""}`;
}

export function resolveMentionViewport(
  suggestionCount: number,
  selectedIndex: number,
  visibleRows: number,
): MentionViewport {
  const safeCount = Math.max(0, suggestionCount);
  const safeRows = Math.max(1, visibleRows);
  if (safeCount === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
    };
  }

  const clampedSelection = Math.max(0, Math.min(selectedIndex, safeCount - 1));
  const maxStartIndex = Math.max(0, safeCount - safeRows);
  const startIndex = Math.max(0, Math.min(clampedSelection - safeRows + 1, maxStartIndex));

  return {
    startIndex,
    endIndex: Math.min(safeCount, startIndex + safeRows),
  };
}

export function formatAssistantTranscriptBlock(rendered: string): string {
  return `${formatAssistantTranscriptPrefix()}${rendered}\n`;
}

export function formatAssistantTranscriptPrefix(): string {
  return "\n";
}

export function formatWrappedAssistantTranscriptBlock(
  text: string,
  columns: number,
  renderBody: (wrapped: string) => string = (wrapped) => wrapped,
): string {
  return formatAssistantTranscriptBlock(
    renderBody(wrapPlainTextForTerminal(text, columns).wrapped)
  );
}

export function splitStreamTextAtWordBoundary(text: string): { flushed: string; pending: string } {
  if (!text) {
    return { flushed: "", pending: "" };
  }

  const lastNewlineIndex = text.lastIndexOf("\n");
  if (lastNewlineIndex >= 0) {
    return {
      flushed: text.slice(0, lastNewlineIndex + 1),
      pending: text.slice(lastNewlineIndex + 1),
    };
  }

  const trailingWhitespaceMatch = text.match(/\s+$/);
  if (trailingWhitespaceMatch) {
    return { flushed: text, pending: "" };
  }

  const lastWhitespaceIndex = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\t"));
  if (lastWhitespaceIndex >= 0) {
    return {
      flushed: text.slice(0, lastWhitespaceIndex + 1),
      pending: text.slice(lastWhitespaceIndex + 1),
    };
  }

  return { flushed: "", pending: text };
}

export type StreamTextBufferState = {
  visibleText: string;
  pendingText: string;
};

export function applyBufferedStreamDelta(
  state: StreamTextBufferState,
  delta: string,
): StreamTextBufferState & { didFlush: boolean } {
  if (!delta) {
    return { ...state, didFlush: false };
  }

  const next = splitStreamTextAtWordBoundary(`${state.pendingText}${delta}`);
  return {
    visibleText: `${state.visibleText}${next.flushed}`,
    pendingText: next.pending,
    didFlush: next.flushed.length > 0,
  };
}

export function flushBufferedStreamText(
  state: StreamTextBufferState,
): StreamTextBufferState & { didFlush: boolean } {
  if (!state.pendingText) {
    return { ...state, didFlush: false };
  }

  return {
    visibleText: `${state.visibleText}${state.pendingText}`,
    pendingText: "",
    didFlush: true,
  };
}

function whitespaceWidth(text: string): number {
  return text.replace(/\t/g, "  ").length;
}

export function wrapPlainTextForTerminal(
  text: string,
  columns: number,
  startColumn = 0,
): { wrapped: string; trailingWhitespace: string } {
  if (!text) {
    return { wrapped: "", trailingWhitespace: "" };
  }

  const safeColumns = Math.max(1, columns);
  let currentColumn = Math.max(0, startColumn % safeColumns);
  let pendingWhitespace = "";
  let wrapped = "";

  const appendWord = (value: string) => {
    let remaining = value;
    while (remaining.length > 0) {
      if (currentColumn > 0) {
        const separatorWidth = whitespaceWidth(pendingWhitespace);
        if (separatorWidth > 0) {
          if (currentColumn + separatorWidth + remaining.length > safeColumns) {
            wrapped += "\n";
            currentColumn = 0;
          } else {
            wrapped += pendingWhitespace;
            currentColumn += separatorWidth;
          }
        } else if (currentColumn + remaining.length > safeColumns) {
          wrapped += "\n";
          currentColumn = 0;
        }
      }

      pendingWhitespace = "";
      const remainingColumns = safeColumns - currentColumn;
      const segmentWidth = Math.max(1, remainingColumns);
      if (remaining.length <= segmentWidth) {
        wrapped += remaining;
        currentColumn += remaining.length;
        remaining = "";
        continue;
      }

      wrapped += remaining.slice(0, segmentWidth);
      remaining = remaining.slice(segmentWidth);
      currentColumn += segmentWidth;
      if (remaining.length > 0) {
        wrapped += "\n";
        currentColumn = 0;
      }
    }
  };

  for (const token of text.match(/\n|[^\S\n]+|\S+/g) ?? []) {
    if (token === "\n") {
      wrapped += "\n";
      currentColumn = 0;
      pendingWhitespace = "";
      continue;
    }

    if (/^[^\S\n]+$/.test(token)) {
      pendingWhitespace += token;
      continue;
    }

    appendWord(token);
  }

  return {
    wrapped,
    trailingWhitespace: pendingWhitespace,
  };
}

export function wrapRenderedAnsiText(text: string, columns: number): string {
  if (!text) {
    return "";
  }

  const safeColumns = Math.max(1, columns);
  const segments = text.match(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|[^\x1B]+/g) ?? [text];
  let wrapped = "";
  let currentColumn = 0;
  let pendingWhitespace = "";

  const appendToken = (token: string) => {
    let remaining = token;
    while (remaining.length > 0) {
      if (currentColumn > 0) {
        const separatorWidth = visibleLength(pendingWhitespace);
        if (separatorWidth > 0) {
          if (currentColumn + separatorWidth + visibleLength(remaining) > safeColumns) {
            wrapped += "\n";
            currentColumn = 0;
          } else {
            wrapped += pendingWhitespace;
            currentColumn += separatorWidth;
          }
        } else if (currentColumn + visibleLength(remaining) > safeColumns) {
          wrapped += "\n";
          currentColumn = 0;
        }
      }

      pendingWhitespace = "";
      const available = Math.max(1, safeColumns - currentColumn);
      const chars = Array.from(remaining);
      if (chars.length <= available) {
        wrapped += remaining;
        currentColumn += chars.length;
        remaining = "";
        continue;
      }

      wrapped += chars.slice(0, available).join("");
      remaining = chars.slice(available).join("");
      currentColumn += available;
      if (remaining.length > 0) {
        wrapped += "\n";
        currentColumn = 0;
      }
    }
  };

  for (const segment of segments) {
    ANSI_PATTERN.lastIndex = 0;
    if (ANSI_PATTERN.test(segment)) {
      wrapped += segment;
      continue;
    }

    for (const token of segment.match(/\n|[^\S\n]+|\S+/g) ?? []) {
      if (token === "\n") {
        wrapped += "\n";
        currentColumn = 0;
        pendingWhitespace = "";
        continue;
      }

      if (/^[^\S\n]+$/.test(token)) {
        if (currentColumn === 0) {
          wrapped += token;
          currentColumn += visibleLength(token);
        } else {
          pendingWhitespace += token;
        }
        continue;
      }

      appendToken(token);
    }
  }

  return wrapped;
}

export function formatSubmittedUserMessageBlock(renderedLines: string[], renderedClearToEnd: string): string {
  const lines = renderedLines.length > 0 ? renderedLines : [""];
  return lines.map((line) => `${line}${renderedClearToEnd}`).join("\n") + "\n";
}

export function continuePromptAfterBackslash(value: string, cursorIndex: number): {
  value: string;
  cursorIndex: number;
} | null {
  const safeCursorIndex = Math.max(0, Math.min(cursorIndex, value.length));
  if (value[safeCursorIndex - 1] !== "\\") {
    return null;
  }

  return {
    value: `${value.slice(0, safeCursorIndex - 1)}\n${value.slice(safeCursorIndex)}`,
    cursorIndex: safeCursorIndex,
  };
}

export function formatRunCompleteLine(rendered: string): string {
  return `${rendered}\n`;
}

export function formatRunCompleteTranscriptBlock(rendered: string): string {
  return formatRunCompleteLine(rendered);
}

export function extractAssistantTextDelta(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const record = event as Record<string, unknown>;
  const nestedEvent = typeof record.event === "string" ? record.event : null;
  const payload = (record.payload && typeof record.payload === "object")
    ? record.payload as Record<string, unknown>
    : null;

  if (nestedEvent === "content_block_start") {
    const block = (payload?.content_block && typeof payload.content_block === "object")
      ? payload.content_block as Record<string, unknown>
      : null;
    return block?.type === "text" && typeof block.text === "string" && block.text.length > 0
      ? block.text
      : null;
  }

  if (nestedEvent === "content_block_delta") {
    const delta = (payload?.delta && typeof payload.delta === "object")
      ? payload.delta as Record<string, unknown>
      : null;
    return delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0
      ? delta.text
      : null;
  }

  if (nestedEvent === "response.output_text.delta" && typeof payload?.delta === "string" && payload.delta.length > 0) {
    return payload.delta;
  }

  const choices = Array.isArray(record.choices) ? record.choices : null;
  const delta = choices?.[0] && typeof choices[0] === "object"
    ? (choices[0] as { delta?: { content?: unknown } }).delta
    : undefined;
  if (typeof delta?.content === "string" && delta.content.length > 0) {
    return delta.content;
  }

  return null;
}

export function extractAssistantThinkingDelta(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const record = event as Record<string, unknown>;
  const nestedEvent = typeof record.event === "string" ? record.event : null;
  const payload = (record.payload && typeof record.payload === "object")
    ? record.payload as Record<string, unknown>
    : null;

  if (nestedEvent === "response.reasoning_summary_text.delta" && typeof payload?.delta === "string" && payload.delta.length > 0) {
    return payload.delta;
  }

  return null;
}

export function wasAssistantTextFullyStreamed(streamed: string, finalText: string): boolean {
  return streamed.trim().length > 0 && streamed.trim() === finalText.trim();
}

export function parseSlashCommand(value: string): SlashCommand | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed === "/") {
    return null;
  }

  const withoutSlash = trimmed.slice(1);
  const firstSpaceIndex = withoutSlash.search(/\s/);

  if (firstSpaceIndex === -1) {
    return {
      name: withoutSlash.toLowerCase(),
      args: "",
    };
  }

  return {
    name: withoutSlash.slice(0, firstSpaceIndex).toLowerCase(),
    args: withoutSlash.slice(firstSpaceIndex).trim(),
  };
}

export function formatStatusHeader(status: CliStatus): string {
  const branch = status.branchName ?? "no-git";
  const permission = PERMISSION_LABELS[status.permissionMode] ?? status.permissionMode;

  return [
    "Pino",
    status.projectName || path.basename(status.cwd) || "workspace",
    branch,
    status.model,
    `approvals ${permission}`,
    "/help",
  ].join("  ");
}

function formatRightAlignedFooterRow(left: string, right: string, width: number): string[] {
  const safeWidth = Math.max(0, width);
  const leftLength = visibleLength(left);
  const rightLength = visibleLength(right);

  if (safeWidth >= leftLength + rightLength + 2) {
    return [left + " ".repeat(safeWidth - leftLength - rightLength) + right];
  }

  const rightPadding = Math.max(0, safeWidth - rightLength);
  return [left, `${" ".repeat(rightPadding)}${right}`];
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}m`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  }

  return String(Math.round(value));
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "$0.000";
  }

  return `$${value.toFixed(value < 0.001 ? 4 : 3)}`;
}

export function formatPromptUsageTotals(usage: PromptUsageTotals): string {
  const inputTokens = Math.max(0, Math.round(usage.inputTokens));
  const outputTokens = Math.max(0, Math.round(usage.outputTokens));
  const contextWindow = typeof usage.contextWindow === "number" && usage.contextWindow > 0
    ? Math.round(usage.contextWindow)
    : null;
  const totalTokens = inputTokens + outputTokens;
  const contextLabel = contextWindow
    ? `${((totalTokens / contextWindow) * 100).toFixed(1)}%/${formatCompactNumber(contextWindow)}${usage.autoCompact === false ? "" : " (auto)"}`
    : `?${usage.autoCompact === false ? "" : " (auto)"}`;
  const subscriptionLabel = usage.subscription ? " (sub)" : "";

  return `↑${formatCompactNumber(inputTokens)} ↓${formatCompactNumber(outputTokens)} ${formatUsd(usage.totalCostUsd)}${subscriptionLabel} ${contextLabel}`;
}

function formatPromptModelLabels(model: string, usage?: PromptUsageTotals): { full: string; fallback: string } {
  const effort = usage?.effort?.trim();
  const effortSuffix = effort ? ` • ${effort}` : "";
  const fallback = `${model}${effortSuffix}`;
  return {
    full: fallback,
    fallback,
  };
}

function truncatePlainTextToWidth(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (visibleLength(text) <= width) {
    return text;
  }

  return text.slice(0, width);
}

function formatStatsModelFooterRow(stats: string, model: string, fallbackModel: string, width: number): string[] {
  const safeWidth = Math.max(0, width);
  const statsWidth = visibleLength(stats);
  const minPadding = 2;
  const modelWidth = visibleLength(model);

  if (safeWidth >= statsWidth + modelWidth + minPadding) {
    return [stats + " ".repeat(safeWidth - statsWidth - modelWidth) + model];
  }

  const fallbackModelWidth = visibleLength(fallbackModel);
  if (fallbackModel !== model && safeWidth >= statsWidth + fallbackModelWidth + minPadding) {
    return [stats + " ".repeat(safeWidth - statsWidth - fallbackModelWidth) + fallbackModel];
  }

  const availableForModel = safeWidth - statsWidth - minPadding;
  if (availableForModel > 0) {
    const truncatedModel = truncatePlainTextToWidth(fallbackModel, availableForModel);
    const padding = " ".repeat(Math.max(minPadding, safeWidth - statsWidth - visibleLength(truncatedModel)));
    return [stats + padding + truncatedModel];
  }

  if (safeWidth <= 0) {
    return [stats, fallbackModel];
  }

  const modelPadding = " ".repeat(Math.max(0, safeWidth - fallbackModelWidth));
  return [stats, `${modelPadding}${fallbackModel}`];
}

export function formatPromptFooter(
  model: string,
  cwd: string,
  activeMode = "default",
  width = 0,
  usage?: PromptUsageTotals,
): string[] {
  const normalizedCwd = path.normalize(cwd);
  const homeDir = path.normalize(process.env.HOME ?? "");
  const displayDir = homeDir && normalizedCwd.startsWith(homeDir)
    ? `~${normalizeDisplaySeparators(normalizedCwd.slice(homeDir.length) || path.sep)}`
    : normalizeDisplaySeparators(normalizedCwd);
  const usageLine = usage ? formatPromptUsageTotals(usage) : "";
  const modelLabels = formatPromptModelLabels(model, usage);
  const secondRow = usageLine
    ? formatStatsModelFooterRow(usageLine, modelLabels.full, modelLabels.fallback, width)
    : [modelLabels.full];

  if (activeMode === "default") {
    return [displayDir, ...secondRow];
  }

  return [...formatRightAlignedFooterRow(displayDir, activeMode, width), ...secondRow];
}

export function formatModeSwitchTranscript(_activeMode: string): string | null {
  return null;
}

export function formatLimitWindowLabel(windowSeconds: number | null | undefined): string {
  if (typeof windowSeconds !== "number" || windowSeconds <= 0) {
    return "usage";
  }

  if (windowSeconds % 86400 === 0) {
    return `${windowSeconds / 86400}d`;
  }

  if (windowSeconds % 3600 === 0) {
    return `${windowSeconds / 3600}h`;
  }

  if (windowSeconds % 60 === 0) {
    return `${windowSeconds / 60}m`;
  }

  return `${windowSeconds}s`;
}

export function formatResetAfter(resetAfterSeconds: number | null | undefined): string {
  if (typeof resetAfterSeconds !== "number" || resetAfterSeconds <= 0) {
    return "soon";
  }

  const totalMinutes = Math.ceil(resetAfterSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  if (totalHours < 24) {
    return remainingMinutes > 0 ? `${totalHours}h ${remainingMinutes}m` : `${totalHours}h`;
  }

  const totalDays = Math.floor(totalHours / 24);
  const remainingHours = totalHours % 24;
  return remainingHours > 0 ? `${totalDays}d ${remainingHours}h` : `${totalDays}d`;
}

function formatElapsedSecondsLabel(elapsedMs: number): string {
  return `${Math.max(0, Math.floor(elapsedMs / 1000))}s`;
}

function formatPreciseElapsedSecondsLabel(elapsedMs: number): string {
  const seconds = Math.max(0, elapsedMs / 1000);
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

export function formatBashRunningStatus(input: {
  elapsedMs: number;
  timeoutMs?: number | null;
}): string {
  const parts = [`Running... (${formatElapsedSecondsLabel(input.elapsedMs)}`];
  if (typeof input.timeoutMs === "number" && input.timeoutMs > 0) {
    parts.push(`timeout ${formatLimitWindowLabel(Math.ceil(input.timeoutMs / 1000))}`);
  }

  return parts.length === 1
    ? `${parts[0]})`
    : `${parts[0]} · ${parts[1]})`;
}

export function formatLiveTerminalHeader(input: {
  title: string;
  width: number;
  elapsedMs?: number | null;
}): string {
  const width = Math.max(18, input.width);
  const left = `╭─ ${input.title.trim() || "Live terminal"} `;
  const right = typeof input.elapsedMs === "number"
    ? ` ${formatPreciseElapsedSecondsLabel(input.elapsedMs)} ─╮`
    : "─╮";
  const fillerWidth = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return `${left}${"─".repeat(fillerWidth)}${right}`;
}

export function formatLiveTerminalFooter(width: number): string {
  return `╰${"─".repeat(Math.max(0, Math.max(2, width) - 2))}╯`;
}

export function formatLiveTerminalLine(text: string, width: number): string {
  const safeWidth = Math.max(8, width);
  const prefix = "│  ";
  const suffix = " │";
  const available = Math.max(1, safeWidth - visibleLength(prefix) - visibleLength(suffix));
  let rendered = text.replace(/\t/g, "  ").trimEnd();

  if (visibleLength(rendered) > available) {
    const maxBodyLength = Math.max(0, available - 1);
    let cursor = 0;
    let body = "";
    for (const char of rendered) {
      const next = `${body}${char}`;
      if (visibleLength(next) > maxBodyLength) {
        break;
      }
      body = next;
      cursor += char.length;
    }
    rendered = `${body}${cursor < rendered.length ? "…" : ""}`;
  }

  const padding = Math.max(0, available - visibleLength(rendered));
  return `${prefix}${rendered}${" ".repeat(padding)}${suffix}`;
}

export function formatLiveTerminalFrame(input: {
  title: string;
  width: number;
  height: number;
  elapsedMs?: number | null;
  lines: string[];
}): string {
  const height = Math.max(1, input.height);
  const visibleLines = input.lines.slice(-height);
  const paddedLines = [
    ...Array.from({ length: Math.max(0, height - visibleLines.length) }, () => ""),
    ...visibleLines,
  ];

  return [
    formatLiveTerminalHeader(input),
    ...paddedLines.map((line) => formatLiveTerminalLine(line, input.width)),
    formatLiveTerminalFooter(input.width),
  ].join("\n");
}

export function formatBashCommandSummary(command: string): string {
  const trimmed = command.trim();
  const withoutTimeout = trimmed.replace(/^(?:g?timeout)\s+\S+\s+/i, "");
  const shellWrapperMatch = withoutTimeout.match(/^(?:(?:\/bin\/)?(?:bash|sh|zsh))\s+-l?c\s+(['"])([\s\S]*)\1$/i);
  if (shellWrapperMatch) {
    return shellWrapperMatch[2] ?? trimmed;
  }

  return withoutTimeout;
}

export function isManualRedrawKey(key: KeypressLike, char = ""): boolean {
  const name = key.name?.toLowerCase();
  const normalizedChar = char.toLowerCase();
  const isR = name === "r" || normalizedChar === "r" || char === "\u0012";
  return isR && (key.ctrl === true || key.meta === true);
}

export function formatToolTranscriptLines(
  lines: string[],
  options?: { leftPadding?: number },
): string[] {
  if (lines.length === 0) {
    return [];
  }

  const leftPadding = " ".repeat(Math.max(0, options?.leftPadding ?? 2));
  const continuationPrefix = `${leftPadding}   `;

  return lines.map((line, index) => (
    index === 0
      ? `${leftPadding}⎿  ${line}`
      : `${continuationPrefix}${line}`
  ));
}

export function shouldSuppressDuplicateToolEcho(toolOutput: string | null, assistantText: string): boolean {
  if (!toolOutput) {
    return false;
  }

  const normalize = (value: string) =>
    value
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trimEnd());

  const toolLines = normalize(toolOutput);
  const assistantLines = normalize(assistantText);
  if (toolLines.length === 0 || assistantLines.length === 0 || assistantLines.length > toolLines.length) {
    return false;
  }

  return assistantLines.every((line, index) => line === toolLines[index]);
}

export function resolveDuplicateToolEchoDelta(
  toolOutput: string | null,
  bufferedText: string,
  delta: string,
): { shouldBuffer: true; bufferedText: string } | { shouldBuffer: false; text: string } {
  const candidate = `${bufferedText}${delta}`;
  if (!toolOutput || candidate.length === 0) {
    return { shouldBuffer: false, text: candidate };
  }

  const normalizeEchoPrefix = (value: string) =>
    value
      .split(/\r?\n/)
      .filter((line, index, lines) => line.trim().length > 0 || index === lines.length - 1)
      .join("\n")
      .trimStart();

  const comparableCandidate = normalizeEchoPrefix(candidate);
  const comparableOutput = normalizeEchoPrefix(toolOutput);
  if (comparableCandidate.length > 0 && comparableOutput.startsWith(comparableCandidate)) {
    return { shouldBuffer: true, bufferedText: candidate };
  }

  const comparableBuffered = normalizeEchoPrefix(bufferedText);
  if (comparableBuffered.length > 0 && comparableOutput.startsWith(comparableBuffered)) {
    return { shouldBuffer: false, text: delta };
  }

  return { shouldBuffer: false, text: candidate };
}

export function stripAlreadyRenderedToolLines(lines: string[], renderedLines: string[]): string[] {
  let matched = 0;

  while (
    matched < lines.length &&
    matched < renderedLines.length &&
    lines[matched]?.trimEnd() === renderedLines[matched]?.trimEnd()
  ) {
    matched += 1;
  }

  return lines.slice(matched);
}

export function formatToolSummary(tool: ToolSummaryInput): string {
  if (tool.name === "Bash" && typeof tool.input.command === "string") {
    return `Bash ${formatBashCommandSummary(tool.input.command)}`;
  }

  if (
    (tool.name === "Edit" || tool.name === "Write" || tool.name === "Read") &&
    typeof tool.input.file_path === "string"
  ) {
    return `${tool.name} ${tool.input.file_path}`;
  }

  const serialized = JSON.stringify(tool.input);
  if (!serialized || serialized === "{}") {
    return tool.name;
  }

  const compact = serialized.length > 90 ? `${serialized.slice(0, 87)}...` : serialized;
  return `${tool.name} ${compact}`;
}

function normalizeDisplaySeparators(value: string): string {
  return value.split(path.sep).join("/");
}

export function formatToolDisplayPath(filePath: string, cwd: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return filePath;
  }

  const normalizedPath = path.normalize(trimmed);
  if (!path.isAbsolute(normalizedPath)) {
    return normalizeDisplaySeparators(normalizedPath);
  }

  const relativePath = path.relative(cwd, normalizedPath);
  if (!relativePath) {
    return path.basename(normalizedPath);
  }

  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return normalizeDisplaySeparators(relativePath);
  }

  return normalizeDisplaySeparators(normalizedPath);
}

export function rewriteEditToolResultLine(line: string, filePath: string, cwd: string): string {
  const displayPath = formatToolDisplayPath(filePath, cwd);
  const normalizedPath = path.normalize(filePath);
  const absolutePath = path.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.resolve(cwd, normalizedPath);
  const candidates = Array.from(new Set([
    filePath,
    normalizedPath,
    absolutePath,
    normalizeDisplaySeparators(normalizedPath),
    normalizeDisplaySeparators(absolutePath),
  ])).filter((candidate) => candidate.length > 0)
    .sort((left, right) => right.length - left.length);

  let rewritten = line;
  for (const candidate of candidates) {
    rewritten = rewritten.replaceAll(candidate, displayPath);
  }

  return rewritten;
}

export function rewriteSuccessfulEditAssistantMarkdown(markdown: string, filePath: string, cwd: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return markdown;
  }

  const firstParagraphMatch = trimmed.match(/^([^\n]+(?:\n(?!\n)[^\n]+)*)/);
  const firstParagraph = firstParagraphMatch?.[1]?.trim();
  if (!firstParagraphMatch || !firstParagraph || /^all set!/i.test(firstParagraph)) {
    return trimmed;
  }

  const displayPath = formatToolDisplayPath(filePath, cwd);
  const normalizedDisplayPath = displayPath.toLowerCase();
  const normalizedParagraph = firstParagraph.toLowerCase();
  const mentionsEdit =
    normalizedParagraph.includes("updated") ||
    normalizedParagraph.includes("edited") ||
    normalizedParagraph.includes("changed") ||
    normalizedParagraph.includes("modified");
  const mentionsTarget =
    normalizedParagraph.includes(normalizedDisplayPath) ||
    normalizedParagraph.includes(path.basename(normalizedDisplayPath)) ||
    normalizedParagraph.includes("title") ||
    normalizedParagraph.includes("document") ||
    normalizedParagraph.includes("file");

  if (!mentionsEdit || !mentionsTarget) {
    return trimmed;
  }

  return trimmed.replace(firstParagraph, `All set! Updated ${displayPath}:`);
}

export function buildExpansionRecord(args: {
  title: string;
  lines: ToolResultPreviewLine[];
  visibleCount: number;
}): ExpansionRecord | null {
  const hiddenLines = args.lines.slice(args.visibleCount);
  if (hiddenLines.length === 0) {
    return null;
  }

  return {
    title: args.title,
    hiddenLines,
  };
}

function splitPreviewLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

const TOOL_OBJECT_PREVIEW_ENTRY_LIMIT = 6;

function summarizeValue(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "(empty)";
    }

    return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return "{empty object}";
    }

    const preview = keys.slice(0, 3).join(", ");
    return keys.length > 3 ? `{${preview}, ...}` : `{${preview}}`;
  }

  if (value === undefined) {
    return "undefined";
  }

  return String(value);
}

function summarizeObjectEntries(
  record: Record<string, unknown>,
  options?: { hideKeys?: string[] },
): ToolResultPreviewLine[] {
  const hiddenKeys = new Set(options?.hideKeys ?? []);
  const entries = Object.entries(record)
    .filter(([key]) => !hiddenKeys.has(key))
    .slice(0, TOOL_OBJECT_PREVIEW_ENTRY_LIMIT);
  const lines = entries.map(([key, value]) => ({
    text: `${key}: ${summarizeValue(value)}`,
    variant: "default" as const,
  }));

  const hiddenCount = Object.keys(record).filter((key) => !hiddenKeys.has(key)).length - entries.length;
  if (hiddenCount > 0) {
    lines.push({
      text: `… +${hiddenCount} more field${hiddenCount === 1 ? "" : "s"}`,
      variant: "default",
    });
  }

  return lines;
}

function formatWriteContentPreview(filePath: string | null, content: string): ToolResultPreviewLine[] {
  const contentLines = splitPreviewLines(content);
  const numberWidth = Math.max(3, String(contentLines.length).length);
  const target = filePath ?? "file";
  const lineLabel = contentLines.length === 1 ? "line" : "lines";
  const lines: ToolResultPreviewLine[] = [{
    text: `Wrote ${contentLines.length} ${lineLabel} to ${target}`,
    variant: "default",
  }];

  lines.push(...contentLines.map((line, index) => ({
    text: `${String(index + 1).padStart(numberWidth, " ")} ${line}`,
    variant: "default" as const,
  })));

  return lines;
}

export function formatToolInputPreview(tool: ToolSummaryInput): ToolResultPreviewLine[] {
  if (tool.name === "Read" && typeof tool.input.file_path === "string") {
    return [];
  }

  if (tool.name === "Edit") {
    const filePath = typeof tool.input.file_path === "string" ? tool.input.file_path : null;
    const oldText = typeof tool.input.old_text === "string" ? tool.input.old_text : null;
    const newText = typeof tool.input.new_text === "string" ? tool.input.new_text : null;

    if (filePath !== null && oldText !== null && newText !== null) {
      return [
        { text: "{", variant: "default" },
        { text: `  "file_path": ${JSON.stringify(filePath)},`, variant: "default" },
        { text: '  "old_text": ', variant: "default" },
        ...splitPreviewLines(oldText).map((line) => ({
          text: `    - ${line}`,
          variant: "diffRemove" as const,
        })),
        { text: '  "new_text": ', variant: "default" },
        ...splitPreviewLines(newText).map((line) => ({
          text: `    + ${line}`,
          variant: "diffAdd" as const,
        })),
        { text: "}", variant: "default" },
      ];
    }
  }

  if (tool.name === "Write") {
    if (typeof tool.input.content === "string") {
      return formatWriteContentPreview(
        typeof tool.input.file_path === "string" ? tool.input.file_path : null,
        tool.input.content
      );
    }
  }

  return summarizeObjectEntries(tool.input);
}

export function formatToolResultPreview(tool: ToolSummaryInput, content: string): ToolResultPreviewLine[] {
  if (tool.name === "Read" && typeof tool.input.file_path === "string") {
    return [];
  }

  if (tool.name === "Edit") {
    const oldText = typeof tool.input.old_text === "string" ? tool.input.old_text : null;
    const newText = typeof tool.input.new_text === "string" ? tool.input.new_text : null;

    if (oldText !== null && newText !== null && oldText !== newText) {
      return [
        ...splitPreviewLines(oldText).map((line) => ({
          text: `- ${line}`,
          variant: "diffRemove" as const,
        })),
        ...splitPreviewLines(newText).map((line) => ({
          text: `+ ${line}`,
          variant: "diffAdd" as const,
        })),
      ];
    }
  }

  if (tool.name === "Write" && typeof tool.input.content === "string") {
    return [];
  }

  return splitPreviewLines(content)
    .filter((line) => line.trim().length > 0)
    .map((line) => ({
      text: line,
      variant: "default" as const,
    }));
}

export function formatToolResultBlockPreview(block: Record<string, unknown>): ToolResultPreviewLine[] {
  if (block.type === "image") {
    const source = block.source && typeof block.source === "object"
      ? block.source as Record<string, unknown>
      : null;
    const mediaType = typeof source?.media_type === "string" ? source.media_type : null;

    return [{
      text: mediaType ? `image output (${mediaType})` : "image output",
      variant: "default",
    }];
  }

  return summarizeObjectEntries(block, { hideKeys: ["data"] });
}

function renderInlineMarkdown(text: string, styles: MarkdownStyles): string {
  const segments = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);

  return segments.map((segment) => {
    if (segment.startsWith("`") && segment.endsWith("`") && segment.length >= 2) {
      return styles.code(segment.slice(1, -1));
    }

    if (segment.startsWith("**") && segment.endsWith("**") && segment.length >= 4) {
      return styles.bold(segment.slice(2, -2));
    }

    return styles.body(segment);
  }).join("");
}

export function renderThinkingEmphasis(
  text: string,
  styles: { body: (text: string) => string; bold: (text: string) => string },
): string {
  const emphasisPattern = /\*\*([^\n*](?:[^\n]*?[^\n*])?)\*\*/g;
  let rendered = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = emphasisPattern.exec(text)) !== null) {
    rendered += styles.body(text.slice(cursor, match.index));
    rendered += styles.bold(match[1] ?? "");
    cursor = match.index + match[0].length;
  }

  rendered += styles.body(text.slice(cursor));
  return rendered;
}

function parseTableCells(line: string): string[] {
  const trimmed = line.trim();
  const normalized = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutTrailing = normalized.endsWith("|") ? normalized.slice(0, -1) : normalized;

  return withoutTrailing.split("|").map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line: string): boolean {
  if (!line.includes("|")) {
    return false;
  }

  const cells = parseTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed.includes("|");
}

function padRenderedCell(text: string, width: number): string {
  const padding = Math.max(0, width - visibleLength(text));
  return `${text}${" ".repeat(padding)}`;
}

function renderMarkdownTable(lines: string[], styles: MarkdownStyles): string[] {
  const rows = lines.map((line) => parseTableCells(line));
  return renderMarkdownTableRows(rows, styles);
}

function renderMarkdownTableRows(rows: string[][], styles: MarkdownStyles): string[] {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ""));
  const renderedRows = normalizedRows.map((row) => row.map((cell) => renderInlineMarkdown(cell, styles)));
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(...renderedRows.map((row) => visibleLength(row[index] ?? "")))
  );

  const renderBorder = (left: string, middle: string, right: string) =>
    `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
  const renderRow = (row: string[]) =>
    `│ ${row.map((cell, index) => padRenderedCell(cell, widths[index] ?? 0)).join(" │ ")} │`;

  return [
    renderBorder("┌", "┬", "┐"),
    renderRow(renderedRows[0] ?? []),
    renderBorder("├", "┼", "┤"),
    ...renderedRows.slice(1).map(renderRow),
    renderBorder("└", "┴", "┘"),
  ];
}

const MARKDOWN_ITEM_SENTINEL = "\uE000";
const MARKDOWN_CELL_SENTINEL = "\uE001";
const MARKDOWN_ROW_SENTINEL = "\uE002";
const MARKDOWN_META_SENTINEL = "\uE003";

function styleItalic(text: string, styles: MarkdownStyles): string {
  return styles.italic ? styles.italic(text) : styles.body(text);
}

function styleStrikethrough(text: string, styles: MarkdownStyles): string {
  return styles.strikethrough ? styles.strikethrough(text) : styles.dim(text);
}

function styleLink(text: string, href: string, styles: MarkdownStyles): string {
  return styles.link ? styles.link(text, href) : `${styles.body(text)} ${styles.dim(`(${href})`)}`;
}

function styleRule(styles: MarkdownStyles): string {
  return styles.rule ? styles.rule() : styles.dim("———");
}

function splitMarkdownListItems(children: string): Array<{ checked?: boolean; text: string }> {
  const parts = children.split(MARKDOWN_ITEM_SENTINEL).filter(Boolean);

  return parts.map((part) => {
    const separatorIndex = part.indexOf(MARKDOWN_META_SENTINEL);
    if (separatorIndex === -1) {
      return { text: part };
    }

    const metadata = part.slice(0, separatorIndex);
    const text = part.slice(separatorIndex + 1);
    if (!metadata) {
      return { text };
    }

    try {
      const parsed = JSON.parse(metadata) as { checked?: boolean };
      return { checked: parsed.checked, text };
    } catch {
      return { text: part };
    }
  });
}

function renderMarkdownList(children: string, metadata: unknown, styles: MarkdownStyles): string {
  const record = metadata && typeof metadata === "object"
    ? metadata as Record<string, unknown>
    : {};
  const ordered = record.ordered === true;
  const start = typeof record.start === "number" ? record.start : 1;
  const items = splitMarkdownListItems(children);

  return items.map((item, index) => {
    const marker = ordered ? `${start + index}.` : "•";
    const checkbox = typeof item.checked === "boolean" ? `${item.checked ? "[x]" : "[ ]"} ` : "";
    const text = `${checkbox}${item.text.trimEnd()}`;
    const lines = text.split("\n");
    const firstLine = lines[0] ?? "";
    const continuation = lines.slice(1).map((line) => `  ${line}`).join("\n");
    const renderedFirstLine = ordered
      ? `${styles.dim(marker)} ${firstLine}`
      : styles.bullet(firstLine);

    return continuation ? `${renderedFirstLine}\n${continuation}` : renderedFirstLine;
  }).join("\n") + "\n";
}

function parseRenderedTableRows(children: string): string[][] {
  return children
    .split(MARKDOWN_ROW_SENTINEL)
    .filter(Boolean)
    .map((row) => row.split(MARKDOWN_CELL_SENTINEL).filter((cell) => cell.length > 0));
}

function renderTerminalMarkdownWithBun(markdown: string, styles: MarkdownStyles): string | null {
  const markdownApi = (globalThis as typeof globalThis & {
    Bun?: {
      markdown?: {
        render?: (
          input: string,
          renderers: Record<string, (children: string, metadata?: unknown) => string | null | undefined>,
          options?: Record<string, unknown>,
        ) => string;
      };
    };
  }).Bun?.markdown;

  if (typeof markdownApi?.render !== "function") {
    return null;
  }

  try {
    return markdownApi.render(markdown, {
      heading: (children) => `${styles.heading(children.trim())}\n`,
      paragraph: (children) => `${children.trimEnd()}\n`,
      strong: (children) => styles.bold(children),
      emphasis: (children) => styleItalic(children, styles),
      strikethrough: (children) => styleStrikethrough(children, styles),
      codespan: (children) => styles.code(children),
      code: (children) => styles.codeBlock(children.replace(/\n$/, "")),
      link: (children, metadata) => {
        const record = metadata as { href?: unknown } | undefined;
        const href = typeof record?.href === "string"
          ? record.href
          : "";
        return href ? styleLink(children, href, styles) : children;
      },
      image: (_children, metadata) => {
        const record = metadata as { src?: unknown } | undefined;
        const src = typeof record?.src === "string"
          ? record.src
          : "";
        return src ? styles.dim(`[image: ${src}]`) : "";
      },
      blockquote: (children) => children
        .trimEnd()
        .split("\n")
        .map((line) => styles.quote(line))
        .join("\n") + "\n",
      hr: () => `${styleRule(styles)}\n`,
      listItem: (children, metadata) => {
        const record = metadata as { checked?: unknown } | undefined;
        const checked = typeof record?.checked === "boolean"
          ? record.checked
          : undefined;
        return `${MARKDOWN_ITEM_SENTINEL}${JSON.stringify({ checked })}${MARKDOWN_META_SENTINEL}${children.trim()}`;
      },
      list: (children, metadata) => renderMarkdownList(children, metadata, styles),
      th: (children) => `${MARKDOWN_CELL_SENTINEL}${children.trim()}`,
      td: (children) => `${MARKDOWN_CELL_SENTINEL}${children.trim()}`,
      tr: (children) => `${MARKDOWN_ROW_SENTINEL}${children.split(MARKDOWN_CELL_SENTINEL).filter(Boolean).join(MARKDOWN_CELL_SENTINEL)}`,
      thead: (children) => children,
      tbody: (children) => children,
      table: (children) => `${renderMarkdownTableRows(parseRenderedTableRows(children), styles).join("\n")}\n`,
      html: (children) => styles.dim(children),
    }, {
      tables: true,
      strikethrough: true,
      tasklists: true,
      autolinks: true,
      tagFilter: true,
    }).replace(/\n{3,}/g, "\n\n").trimEnd();
  } catch {
    return null;
  }
}

function renderRegexTerminalMarkdown(markdown: string, styles: MarkdownStyles): string {
  const renderedLines: string[] = [];
  const codeLines: string[] = [];
  let inCodeBlock = false;
  const rawLines = markdown.split("\n");

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index] ?? "";
    const fenceMatch = rawLine.match(/^\s*```/);
    if (fenceMatch) {
      if (inCodeBlock) {
        renderedLines.push(styles.codeBlock(codeLines.join("\n")));
        codeLines.length = 0;
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    const nextLine = rawLines[index + 1] ?? "";
    if (isMarkdownTableRow(rawLine) && isMarkdownTableSeparator(nextLine)) {
      const tableLines = [rawLine];
      index += 1;

      while (index + 1 < rawLines.length && isMarkdownTableRow(rawLines[index + 1] ?? "")) {
        index += 1;
        tableLines.push(rawLines[index] ?? "");
      }

      renderedLines.push(...renderMarkdownTable(tableLines, styles));
      continue;
    }

    const headingMatch = rawLine.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch?.[2]) {
      renderedLines.push(styles.heading(headingMatch[2]));
      continue;
    }

    const bulletMatch = rawLine.match(/^(\s*)[-*]\s+(.+)$/);
    if (bulletMatch?.[2]) {
      renderedLines.push(`${bulletMatch[1] ?? ""}${styles.bullet(renderInlineMarkdown(bulletMatch[2], styles))}`);
      continue;
    }

    const numberedMatch = rawLine.match(/^(\s*)\d+[.)]\s+(.+)$/);
    if (numberedMatch?.[2]) {
      renderedLines.push(`${numberedMatch[1] ?? ""}${styles.bullet(renderInlineMarkdown(numberedMatch[2], styles))}`);
      continue;
    }

    const quoteMatch = rawLine.match(/^>\s?(.+)$/);
    if (quoteMatch?.[1]) {
      renderedLines.push(styles.quote(renderInlineMarkdown(quoteMatch[1], styles)));
      continue;
    }

    renderedLines.push(renderInlineMarkdown(rawLine, styles));
  }

  if (inCodeBlock) {
    renderedLines.push(styles.codeBlock(codeLines.join("\n")));
  }

  return renderedLines.join("\n");
}

export function renderTerminalMarkdown(markdown: string, styles: MarkdownStyles): string {
  return renderTerminalMarkdownWithBun(markdown, styles) ?? renderRegexTerminalMarkdown(markdown, styles);
}
