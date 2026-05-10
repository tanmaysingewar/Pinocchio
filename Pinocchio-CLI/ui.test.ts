import { describe, expect, test } from "bun:test";
import {
  buildExpansionRecord,
  buildPromptLines,
  calculatePromptLayout,
  continuePromptAfterBackslash,
  extractAssistantTextDelta,
  extractAssistantThinkingDelta,
  formatTodoPanel,
  formatAssistantTranscriptBlock,
  formatAssistantTranscriptPrefix,
  formatModeSwitchTranscript,
  formatPromptFooter,
  formatPromptUsageTotals,
  formatSubmittedUserMessageBlock,
  formatLimitWindowLabel,
  formatRunCompleteTranscriptBlock,
  findActiveMention,
  formatMentionSuggestionLabel,
  formatResetAfter,
  formatBashRunningStatus,
  formatLiveTerminalFooter,
  formatLiveTerminalFrame,
  formatLiveTerminalHeader,
  formatLiveTerminalLine,
  resolveMentionViewport,
  formatRunCompleteLine,
  formatBashCommandSummary,
  resolveDuplicateToolEchoDelta,
  applyBufferedStreamDelta,
  flushBufferedStreamText,
  formatToolDisplayPath,
  formatToolInputPreview,
  formatToolResultBlockPreview,
  formatToolResultPreview,
  formatStatusHeader,
  formatToolSummary,
  formatToolTranscriptLines,
  formatWrappedAssistantTranscriptBlock,
  isManualRedrawKey,
  shouldSuppressDuplicateToolEcho,
  parseSlashCommand,
  renderTerminalMarkdown,
  renderThinkingEmphasis,
  resolveModeEditorItemEnabled,
  resolveMentionSuggestions,
  resolveCliAppearance,
  type TodoPanel,
  rewriteSuccessfulEditAssistantMarkdown,
  rewriteEditToolResultLine,
  stripAlreadyRenderedToolLines,
  splitMentionQuery,
  splitStreamTextAtWordBoundary,
  wrapPlainTextForTerminal,
  wrapRenderedAnsiText,
  wasAssistantTextFullyStreamed,
  type CliStatus,
  type MarkdownStyles,
} from "./ui.ts";

const testStyles: MarkdownStyles = {
  heading: (text) => `<h>${text}</h>`,
  bold: (text) => `<b>${text}</b>`,
  code: (text) => `<c>${text}</c>`,
  codeBlock: (text) => `<cb>${text}</cb>`,
  quote: (text) => `<q>${text}</q>`,
  bullet: (text) => `<li>${text}</li>`,
  body: (text) => text,
  dim: (text) => `<dim>${text}</dim>`,
};

describe("parseSlashCommand", () => {
  test("parses commands with arguments", () => {
    expect(parseSlashCommand("/model gpt-5.4")).toEqual({
      name: "model",
      args: "gpt-5.4",
    });
  });

  test("ignores normal prompts", () => {
    expect(parseSlashCommand("write tests")).toBeNull();
  });

  test("parses init without arguments", () => {
    expect(parseSlashCommand("/init")).toEqual({
      name: "init",
      args: "",
    });
  });
});

describe("formatStatusHeader", () => {
  test("includes project, branch, model, permission mode, and cwd", () => {
    const status: CliStatus = {
      projectName: "pinocchio",
      branchName: "main",
      model: "gpt-5.4",
      permissionMode: "bypassPermissions",
      cwd: "/Users/example/pinocchio",
    };

    expect(formatStatusHeader(status)).toBe(
      "Pino  pinocchio  main  gpt-5.4  approvals bypass  /help"
    );
  });
});

describe("resolveCliAppearance", () => {
  test("prefers a dark terminal background from COLORFGBG", () => {
    expect(resolveCliAppearance({
      env: {
        COLORFGBG: "15;0",
      },
      systemAppearance: "light",
    })).toBe("dark");
  });

  test("prefers a light terminal background from COLORFGBG", () => {
    expect(resolveCliAppearance({
      env: {
        COLORFGBG: "0;15",
      },
      systemAppearance: "dark",
    })).toBe("light");
  });

  test("falls back to system appearance when terminal hint is unavailable", () => {
    expect(resolveCliAppearance({
      env: {},
      systemAppearance: "light",
    })).toBe("light");
  });

  test("defaults to dark when no terminal or system hint is available", () => {
    expect(resolveCliAppearance({
      env: {},
      systemAppearance: null,
    })).toBe("dark");
  });
});

describe("resolveModeEditorItemEnabled", () => {
  test("shows mode-allowed items as enabled even when runtime config currently disables them", () => {
    expect(resolveModeEditorItemEnabled({
      runtimeEnabled: false,
      allowedInMode: true,
    })).toBe(true);
  });

  test("shows denied items as disabled", () => {
    expect(resolveModeEditorItemEnabled({
      runtimeEnabled: true,
      allowedInMode: false,
    })).toBe(false);
  });
});

describe("usage formatting helpers", () => {
  test("formats common Codex limit window durations", () => {
    expect(formatLimitWindowLabel(18_000)).toBe("5h");
    expect(formatLimitWindowLabel(604_800)).toBe("7d");
  });

  test("formats reset timers compactly", () => {
    expect(formatResetAfter(5_400)).toBe("1h 30m");
    expect(formatResetAfter(550_459)).toBe("6d 8h");
  });

  test("formats total prompt usage compactly", () => {
    expect(formatPromptUsageTotals({
      inputTokens: 1700,
      outputTokens: 290,
      totalCostUsd: 0.003,
      contextWindow: 272_000,
      subscription: true,
      autoCompact: false,
    })).toBe("↑1.7k ↓290 $0.003 (sub) 0.7%/272k");
  });
});

describe("calculatePromptLayout", () => {
  test("counts wrapped header rows when locating the input cursor", () => {
    const layout = calculatePromptLayout({
      columns: 10,
      cursorColumn: 3,
      inputLineIndex: 1,
      lines: [
        "Pino  pinocchio  no-git",
        "▌ hi",
        "enter send",
      ],
    });

    expect(layout).toEqual({
      cursorRowIndex: 3,
      totalRows: 5,
    });
  });
});

describe("buildPromptLines", () => {
  test("places sticky todo lines above the input divider", () => {
    expect(
      buildPromptLines({
        divider: "---",
        inputLines: ["▌ hi"],
        panelLines: ["todo-title", "todo-item"],
        footerLines: ["model-line", "dir-line"],
      })
    ).toEqual({
      lines: ["todo-title", "todo-item", "---", "▌ hi", "---", "model-line", "dir-line"],
      inputLineIndex: 3,
    });
  });

  test("places the closing divider above the footer lines", () => {
    expect(
      buildPromptLines({
        divider: "---",
        inputLines: ["▌ hi"],
        footerLines: ["model-line", "dir-line"],
        statusLine: "Streaming...  (Press ESC to stop)",
      })
    ).toEqual({
      lines: ["", "Streaming...  (Press ESC to stop)", "---", "▌ hi", "---", "model-line", "dir-line"],
      inputLineIndex: 3,
    });
  });

  test("places mention suggestions below the closing divider", () => {
    expect(
      buildPromptLines({
        divider: "---",
        inputLines: ["▌ @cl"],
        suggestionLines: ["  @cli/", "  @cli/index.ts"],
        footerLines: ["model-line", "dir-line"],
      })
    ).toEqual({
      lines: ["---", "▌ @cl", "---", "  @cli/", "  @cli/index.ts"],
      inputLineIndex: 1,
    });
  });

  test("keeps multiline composer rows between the dividers", () => {
    expect(
      buildPromptLines({
        divider: "---",
        inputLines: ["▌ first line", "  second line"],
        footerLines: ["model-line"],
      })
    ).toEqual({
      lines: ["---", "▌ first line", "  second line", "---", "model-line"],
      inputLineIndex: 1,
    });
  });
});

describe("findActiveMention", () => {
  test("finds the active @ token around the cursor", () => {
    expect(findActiveMention("Write tests for @cli/ind", "Write tests for @cli/ind".length)).toEqual({
      query: "cli/ind",
      replaceStart: 16,
      replaceEnd: 24,
    });
  });

  test("ignores plain text without a mention token", () => {
    expect(findActiveMention("Write tests for cli", 10)).toBeNull();
  });
});

describe("splitMentionQuery", () => {
  test("keeps top-level matches in the workspace root", () => {
    expect(splitMentionQuery("cl")).toEqual({
      directory: "",
      fragment: "cl",
    });
  });

  test("treats folder paths as a browsable directory prefix", () => {
    expect(splitMentionQuery("cli/src")).toEqual({
      directory: "cli/",
      fragment: "src",
    });
  });

  test("treats parent traversal as a browsable directory prefix", () => {
    expect(splitMentionQuery("..")).toEqual({
      directory: "../",
      fragment: "",
    });
  });
});

describe("resolveMentionSuggestions", () => {
  const candidates = [
    { path: "cli", isDirectory: true },
    { path: "cli/index.ts", isDirectory: false },
    { path: "agent", isDirectory: true },
    { path: "README.md", isDirectory: false },
  ];

  test("prefers prefix matches and preserves folder slash replacements", () => {
    expect(resolveMentionSuggestions(candidates, "Check @cl", "Check @cl".length)).toEqual({
      query: "cl",
      replaceStart: 6,
      replaceEnd: 9,
      suggestions: [
        { path: "cli", isDirectory: true, replacement: "@cli/" },
        { path: "cli/index.ts", isDirectory: false, replacement: "@cli/index.ts" },
      ],
    });
  });

  test("returns all top entries when the user has only typed @", () => {
    expect(resolveMentionSuggestions(candidates, "@", 1)?.suggestions).toEqual([
      { path: "cli", isDirectory: true, replacement: "@cli/" },
      { path: "agent", isDirectory: true, replacement: "@agent/" },
      { path: "README.md", isDirectory: false, replacement: "@README.md" },
      { path: "cli/index.ts", isDirectory: false, replacement: "@cli/index.ts" },
    ]);
  });

  test("does not cap suggestions at six when no limit is provided", () => {
    const manyCandidates = [
      { path: "a.ts", isDirectory: false },
      { path: "b.ts", isDirectory: false },
      { path: "c.ts", isDirectory: false },
      { path: "d.ts", isDirectory: false },
      { path: "e.ts", isDirectory: false },
      { path: "f.ts", isDirectory: false },
      { path: "g.ts", isDirectory: false },
    ];

    expect(resolveMentionSuggestions(manyCandidates, "@", 1)?.suggestions).toHaveLength(7);
  });
});

describe("formatMentionSuggestionLabel", () => {
  test("renders directory suggestions with a trailing slash", () => {
    expect(
      formatMentionSuggestionLabel({
        path: "cli",
        isDirectory: true,
        replacement: "@cli/",
      })
    ).toBe("@cli/");
  });
});

describe("resolveMentionViewport", () => {
  test("shows the first window while the selection is still within it", () => {
    expect(resolveMentionViewport(10, 3, 6)).toEqual({
      startIndex: 0,
      endIndex: 6,
    });
  });

  test("slides the window down once the selection moves past the visible bottom", () => {
    expect(resolveMentionViewport(10, 6, 6)).toEqual({
      startIndex: 1,
      endIndex: 7,
    });
  });

  test("pins the window to the end near the bottom of the list", () => {
    expect(resolveMentionViewport(10, 9, 6)).toEqual({
      startIndex: 4,
      endIndex: 10,
    });
  });
});

describe("formatPromptFooter", () => {
  test("renders the home-relative dir before the model", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/example";

    try {
      expect(formatPromptFooter("minimax/minimax-m2.5:free", "/Users/example/pinocchio/cli")).toEqual([
        "~/pinocchio/cli",
        "minimax/minimax-m2.5:free",
      ]);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("adds the active mode when a non-default mode is selected", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/example";

    try {
      expect(formatPromptFooter("gpt-5.4", "/Users/example/pinocchio/cli", "plan", 32)).toEqual([
        "~/pinocchio/cli             plan",
        "gpt-5.4",
      ]);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("falls back to a separate right-aligned mode row when the footer is too narrow", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/example";

    try {
      expect(formatPromptFooter("gpt-5.4", "/Users/example/pinocchio/cli", "plan", 20)).toEqual([
        "~/pinocchio/cli",
        "                plan",
        "gpt-5.4",
      ]);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("renders usage totals on the left and model on the right", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/example";

    try {
      expect(formatPromptFooter("gpt-5.4", "/Users/example/pinocchio/cli", "plan", 50, {
        inputTokens: 1700,
        outputTokens: 290,
        totalCostUsd: 0.003,
        contextWindow: 272_000,
        providerLabel: "openai-codex",
        effort: "medium",
        subscription: true,
        autoCompact: false,
      })).toEqual([
        "~/pinocchio/cli                               plan",
        "↑1.7k ↓290 $0.003 (sub) 0.7%/272k  gpt-5.4 • mediu",
      ]);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("right-aligns the full provider model label when the footer is wide enough", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/example";

    try {
      expect(formatPromptFooter("gpt-5.4", "/Users/example/pinocchio/cli", "plan", 96, {
        inputTokens: 1400,
        outputTokens: 13,
        totalCostUsd: 0.001,
        contextWindow: 272_000,
        providerLabel: "openai-codex",
        effort: "medium",
        subscription: true,
        autoCompact: false,
      })).toEqual([
        "~/pinocchio/cli                                                                             plan",
        "↑1.4k ↓13 $0.001 (sub) 0.5%/272k                                                gpt-5.4 • medium",
      ]);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("keeps the full usage totals when the footer is too narrow for the model", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/example";

    try {
      expect(formatPromptFooter("gpt-5.5", "/Users/example/pinocchio/cli", "plan", 30, {
        inputTokens: 2000,
        outputTokens: 123,
        totalCostUsd: 0.01,
        contextWindow: 272_000,
        providerLabel: "openai-codex",
        effort: "xhigh",
        subscription: true,
        autoCompact: false,
      })).toEqual([
        "~/pinocchio/cli           plan",
        "↑2k ↓123 $0.010 (sub) 0.8%/272k",
        "               gpt-5.5 • xhigh",
      ]);
    } finally {
      process.env.HOME = originalHome;
    }
  });
});

describe("formatModeSwitchTranscript", () => {
  test("suppresses mode switch transcript messages", () => {
    expect(formatModeSwitchTranscript("plan")).toBeNull();
    expect(formatModeSwitchTranscript("default")).toBeNull();
  });
});

describe("formatTodoPanel", () => {
  test("normalizes todo payloads from TodoWrite input", () => {
    const panel = formatTodoPanel({
      title: "Ship feature",
      todos: [
        { content: "Trace the prompt renderer", status: "completed" },
        { content: "Add sticky panel support", status: "in_progress" },
        { content: "Verify transcript behavior", status: "pending" },
      ],
    });

    expect(panel).toEqual<TodoPanel>({
      title: "Ship feature",
      items: [
        { text: "Trace the prompt renderer", status: "completed" },
        { text: "Add sticky panel support", status: "in_progress" },
        { text: "Verify transcript behavior", status: "pending" },
      ],
    });
  });

  test("accepts alternate todo keys and empty lists", () => {
    expect(
      formatTodoPanel({
        header: "Update Todos",
        items: [],
      })
    ).toEqual<TodoPanel>({
      title: "Update Todos",
      items: [],
    });
  });
});

describe("formatAssistantTranscriptBlock", () => {
  test("matches the streaming indicator top padding", () => {
    expect(formatAssistantTranscriptBlock("Hi there!")).toBe("\nHi there!\n");
  });
});

describe("formatAssistantTranscriptPrefix", () => {
  test("matches the streaming indicator top padding", () => {
    expect(formatAssistantTranscriptPrefix()).toBe("\n");
  });
});

describe("formatWrappedAssistantTranscriptBlock", () => {
  test("wraps from the full source text for the current terminal width", () => {
    expect(formatWrappedAssistantTranscriptBlock("alpha beta", 8)).toBe("\nalpha\nbeta\n");
    expect(formatWrappedAssistantTranscriptBlock("alpha beta", 20)).toBe("\nalpha beta\n");
  });

  test("renders incomplete streamed words immediately", () => {
    expect(formatWrappedAssistantTranscriptBlock("stream", 20)).toBe("\nstream\n");
  });
});

describe("formatSubmittedUserMessageBlock", () => {
  test("keeps the submitted prompt tight to the following assistant output", () => {
    expect(formatSubmittedUserMessageBlock(["[prompt]"], "[clear]")).toBe("[prompt][clear]\n");
  });

  test("preserves multiple submitted prompt lines", () => {
    expect(formatSubmittedUserMessageBlock(["[prompt-1]", "[prompt-2]"], "[clear]")).toBe(
      "[prompt-1][clear]\n[prompt-2][clear]\n"
    );
  });
});

describe("continuePromptAfterBackslash", () => {
  test("replaces a backslash before the cursor with a newline", () => {
    expect(continuePromptAfterBackslash("first line\\", "first line\\".length)).toEqual({
      value: "first line\n",
      cursorIndex: "first line\n".length,
    });
  });

  test("preserves text after the cursor when continuing a line", () => {
    expect(continuePromptAfterBackslash("first \\second", "first \\".length)).toEqual({
      value: "first \nsecond",
      cursorIndex: "first \n".length,
    });
  });

  test("does not continue when the cursor is not after a backslash", () => {
    expect(continuePromptAfterBackslash("first line", "first line".length)).toBeNull();
  });
});

describe("extractAssistantTextDelta", () => {
  test("extracts anthropic text from content block start", () => {
    expect(
      extractAssistantTextDelta({
        event: "content_block_start",
        payload: {
          content_block: {
            type: "text",
            text: "Hello",
          },
        },
      })
    ).toBe("Hello");
  });

  test("extracts anthropic text delta chunks", () => {
    expect(
      extractAssistantTextDelta({
        event: "content_block_delta",
        payload: {
          delta: {
            type: "text_delta",
            text: " world",
          },
        },
      })
    ).toBe(" world");
  });

  test("extracts openai chat completion deltas", () => {
    expect(
      extractAssistantTextDelta({
        choices: [
          {
            delta: {
              content: "streamed",
            },
          },
        ],
      })
    ).toBe("streamed");
  });

  test("extracts openai responses text deltas", () => {
    expect(
      extractAssistantTextDelta({
        event: "response.output_text.delta",
        payload: {
          delta: " text",
        },
      })
    ).toBe(" text");
  });

  test("extracts openai reasoning summary deltas", () => {
    expect(
      extractAssistantThinkingDelta({
        event: "response.reasoning_summary_text.delta",
        payload: {
          delta: "Planning next step",
        },
      })
    ).toBe("Planning next step");
  });

  test("ignores non-text stream events", () => {
    expect(
      extractAssistantTextDelta({
        event: "response.output_item.added",
        payload: {
          item: {
            type: "function_call",
          },
        },
      })
    ).toBeNull();
  });
});

describe("splitStreamTextAtWordBoundary", () => {
  test("holds a trailing partial word until more text arrives", () => {
    expect(splitStreamTextAtWordBoundary("I s")).toEqual({
      flushed: "I ",
      pending: "s",
    });
  });

  test("flushes complete lines immediately on newline", () => {
    expect(splitStreamTextAtWordBoundary("Hello world\nNext")).toEqual({
      flushed: "Hello world\n",
      pending: "Next",
    });
  });

  test("flushes everything when the chunk ends on whitespace", () => {
    expect(splitStreamTextAtWordBoundary("shall be ")).toEqual({
      flushed: "shall be ",
      pending: "",
    });
  });
});

describe("stream text buffering", () => {
  test("holds incomplete tokens until a word boundary arrives", () => {
    const first = applyBufferedStreamDelta({ visibleText: "", pendingText: "" }, "Consider");
    expect(first).toEqual({
      visibleText: "",
      pendingText: "Consider",
      didFlush: false,
    });

    expect(applyBufferedStreamDelta(first, "ing ")).toEqual({
      visibleText: "Considering ",
      pendingText: "",
      didFlush: true,
    });
  });

  test("flushes complete lines immediately while holding the next partial token", () => {
    expect(applyBufferedStreamDelta({ visibleText: "", pendingText: "" }, "Done\nNext")).toEqual({
      visibleText: "Done\n",
      pendingText: "Next",
      didFlush: true,
    });
  });

  test("flushes the final pending token once at stream completion", () => {
    expect(flushBufferedStreamText({
      visibleText: "Considering ",
      pendingText: "intent",
    })).toEqual({
      visibleText: "Considering intent",
      pendingText: "",
      didFlush: true,
    });
  });
});

describe("wasAssistantTextFullyStreamed", () => {
  test("matches final assistant text after trimming trailing whitespace", () => {
    expect(wasAssistantTextFullyStreamed("Hello world\n", "Hello world")).toBe(true);
  });

  test("does not treat partial output as a full streamed match", () => {
    expect(wasAssistantTextFullyStreamed("Hello", "Hello world")).toBe(false);
  });
});

describe("formatRunCompleteLine", () => {
  test("renders the footer without inserting an extra blank line above it", () => {
    expect(formatRunCompleteLine("● Run complete · 1 turns · 1350 tokens · 2.8s")).toBe(
      "● Run complete · 1 turns · 1350 tokens · 2.8s\n"
    );
  });

  test("preserves an inline per-turn cost segment", () => {
    expect(formatRunCompleteLine("● Run complete · 1 turns · 1350 tokens · $0.003 · 2.8s")).toBe(
      "● Run complete · 1 turns · 1350 tokens · $0.003 · 2.8s\n"
    );
  });
});

describe("formatRunCompleteTranscriptBlock", () => {
  test("matches the live run footer spacing during redraw replay", () => {
    expect(formatRunCompleteTranscriptBlock("● Run complete · 1 turns · 1350 tokens · 2.8s")).toBe(
      "● Run complete · 1 turns · 1350 tokens · 2.8s\n"
    );
  });
});

describe("formatToolSummary", () => {
  test("summarizes bash commands", () => {
    expect(formatToolSummary({ name: "Bash", input: { command: "bun test" } })).toBe(
      "Bash bun test"
    );
  });

  test("summarizes file tools by path", () => {
    expect(formatToolSummary({ name: "Edit", input: { file_path: "/tmp/app.ts" } })).toBe(
      "Edit /tmp/app.ts"
    );
  });
});

describe("formatBashCommandSummary", () => {
  test("strips legacy timeout and bash wrapper noise from the displayed command", () => {
    expect(
      formatBashCommandSummary("timeout 3m bash -lc 'echo \"Random command running\"; date; sleep 1; echo \"Done\"'")
    ).toBe('echo "Random command running"; date; sleep 1; echo "Done"');
  });
});

describe("formatBashRunningStatus", () => {
  test("formats elapsed and timeout labels like the reference UI", () => {
    expect(
      formatBashRunningStatus({
        elapsedMs: 16_000,
        timeoutMs: 180_000,
      })
    ).toBe("Running... (16s · timeout 3m)");
  });

  test("omits timeout when it is unavailable", () => {
    expect(
      formatBashRunningStatus({
        elapsedMs: 4_200,
      })
    ).toBe("Running... (4s)");
  });
});

describe("isManualRedrawKey", () => {
  test("accepts control-r", () => {
    expect(isManualRedrawKey({ ctrl: true, name: "r" }, "\u0012")).toBe(true);
  });

  test("accepts command-r when the terminal reports it as meta-r", () => {
    expect(isManualRedrawKey({ meta: true, name: "r" }, "r")).toBe(true);
  });

  test("ignores plain r", () => {
    expect(isManualRedrawKey({ name: "r" }, "r")).toBe(false);
  });
});

describe("live terminal formatting", () => {
  test("renders a labeled top border with elapsed time", () => {
    expect(
      formatLiveTerminalHeader({
        title: "Live terminal",
        width: 42,
        elapsedMs: 20_900,
      })
    ).toBe("╭─ Live terminal ──────────────── 20.9s ─╮");
  });

  test("renders output lines inside the frame", () => {
    expect(formatLiveTerminalLine("00:12 Link Core.TestProgram", 42)).toBe(
      "│  00:12 Link Core.TestProgram           │"
    );
  });

  test("truncates long output lines to the frame width", () => {
    expect(formatLiveTerminalLine("abcdefghijklmnopqrstuvwxyz", 18)).toBe("│  abcdefghijkl… │");
  });

  test("renders a bottom border", () => {
    expect(formatLiveTerminalFooter(18)).toBe("╰────────────────╯");
  });

  test("renders a fixed-height viewport with only the newest output lines", () => {
    expect(
      formatLiveTerminalFrame({
        title: "Live terminal",
        width: 30,
        height: 3,
        elapsedMs: 4_200,
        lines: ["old one", "old two", "new one", "new two"],
      })
    ).toBe([
      "╭─ Live terminal ───── 4.2s ─╮",
      "│  old two                   │",
      "│  new one                   │",
      "│  new two                   │",
      "╰────────────────────────────╯",
    ].join("\n"));
  });
});

describe("formatToolDisplayPath", () => {
  test("renders absolute workspace paths as relative display paths", () => {
    expect(
      formatToolDisplayPath(
        "/Users/example/pinocchio/docs/global_warming.md",
        "/Users/example/pinocchio"
      )
    ).toBe("docs/global_warming.md");
  });

  test("keeps outside-of-workspace paths absolute", () => {
    expect(
      formatToolDisplayPath(
        "/Users/example/Downloads/global_warming.md",
        "/Users/example/pinocchio"
      )
    ).toBe("/Users/example/Downloads/global_warming.md");
  });
});

describe("buildExpansionRecord", () => {
  test("captures hidden lines after truncation", () => {
    const record = buildExpansionRecord({
      title: "Bash bun test",
      lines: [
        { text: "one", variant: "default" },
        { text: "two", variant: "default" },
        { text: "three", variant: "default" },
      ],
      visibleCount: 2,
    });

    expect(record).toEqual({
      title: "Bash bun test",
      hiddenLines: [{ text: "three", variant: "default" }],
    });
  });

  test("returns null when there are no hidden lines", () => {
    expect(
      buildExpansionRecord({
        title: "Read file",
        lines: [{ text: "one", variant: "default" }],
        visibleCount: 2,
      })
    ).toBeNull();
  });
});

describe("formatToolResultPreview", () => {
  test("formats edit results as diff-style removed and added lines", () => {
    expect(
      formatToolResultPreview(
        {
          name: "Edit",
          input: {
            file_path: "tests/global_warming.md",
            old_text: "# Global Warming",
            new_text: "# Understanding Global Warming",
          },
        },
        "Edited tests/global_warming.md"
      )
    ).toEqual([
      { text: "- # Global Warming", variant: "diffRemove" },
      { text: "+ # Understanding Global Warming", variant: "diffAdd" },
    ]);
  });

  test("falls back to tool result content for non-edit tools", () => {
    expect(
      formatToolResultPreview(
        {
          name: "Write",
          input: { file_path: "tests/global_warming.md" },
        },
        "Wrote tests/global_warming.md"
      )
    ).toEqual([
      { text: "Wrote tests/global_warming.md", variant: "default" },
    ]);
  });
});

describe("formatToolInputPreview", () => {
  test("formats edit input with colored old and new text lines", () => {
    expect(
      formatToolInputPreview({
        name: "Edit",
        input: {
          file_path: "tests/global_warming.md",
          old_text: "# Global Warming",
          new_text: "# Understanding Global Warming",
        },
      })
    ).toEqual([
      { text: "{", variant: "default" },
      { text: '  "file_path": "tests/global_warming.md",', variant: "default" },
      { text: '  "old_text": ', variant: "default" },
      { text: '    - # Global Warming', variant: "diffRemove" },
      { text: '  "new_text": ', variant: "default" },
      { text: '    + # Understanding Global Warming', variant: "diffAdd" },
      { text: "}", variant: "default" },
    ]);
  });

  test("omits read input preview when the summary already includes the file path", () => {
    expect(
      formatToolInputPreview({
        name: "Read",
        input: {
          file_path: "tests/global_warming.md",
        },
      })
    ).toEqual([]);
  });

  test("summarizes write input as a compact written-file preview", () => {
    expect(
      formatToolInputPreview({
        name: "Write",
        input: {
          file_path: "notes.txt",
          content: "alpha\nbeta\ngamma",
          overwrite: true,
        },
      })
    ).toEqual([
      { text: "Wrote 3 lines to notes.txt", variant: "default" },
      { text: "  1 alpha", variant: "default" },
      { text: "  2 beta", variant: "default" },
      { text: "  3 gamma", variant: "default" },
    ]);
  });

  test("summarizes generic tool input as readable key-value lines", () => {
    expect(
      formatToolInputPreview({
        name: "Search",
        input: {
          query: "latest run",
          limit: 5,
          recursive: true,
        },
      })
    ).toEqual([
      { text: "query: latest run", variant: "default" },
      { text: "limit: 5", variant: "default" },
      { text: "recursive: true", variant: "default" },
    ]);
  });
});

describe("formatToolResultPreview", () => {
  test("omits read result preview so the transcript only shows the file summary line", () => {
    expect(
      formatToolResultPreview(
        {
          name: "Read",
          input: { file_path: "tests/global_warming.md" },
        },
        "# Global Warming\nBody"
      )
    ).toEqual([]);
  });

  test("omits successful write result previews because the call already shows the written content", () => {
    const longContent = Array.from({ length: 105 }, (_, index) => `word${index + 1}`).join(" ");

    expect(
      formatToolResultPreview(
        {
          name: "Write",
          input: {
            file_path: "notes.txt",
            content: longContent,
          },
        },
        '{"ok":true,"bytes":1234}'
      )
    ).toEqual([]);
  });
});

describe("formatToolTranscriptLines", () => {
  test("renders one gutter marker followed by aligned continuation lines", () => {
    expect(formatToolTranscriptLines(["a", "god-and-people-article.md", "index.html"])).toEqual([
      "  ⎿  a",
      "     god-and-people-article.md",
      "     index.html",
    ]);
  });

  test("applies left padding while keeping continuation lines aligned", () => {
    expect(formatToolTranscriptLines(["a", "index.html"], { leftPadding: 2 })).toEqual([
      "  ⎿  a",
      "     index.html",
    ]);
  });
});

describe("shouldSuppressDuplicateToolEcho", () => {
  test("suppresses assistant text that exactly repeats a visible tool output", () => {
    expect(shouldSuppressDuplicateToolEcho("a\nindex.html", "a\nindex.html\n")).toBe(true);
  });

  test("suppresses assistant text that repeats tool output with blank lines between entries", () => {
    expect(shouldSuppressDuplicateToolEcho(
      "All Documents\nApplications\nDesktop",
      "All Documents\n\nApplications\n\nDesktop\n",
    )).toBe(true);
  });

  test("suppresses assistant text that repeats a prefix of visible tool output", () => {
    expect(shouldSuppressDuplicateToolEcho(
      "All Documents\nApplications\nDesktop\nDocuments",
      "All Documents\n\nApplications\n\nDesktop\n",
    )).toBe(true);
  });

  test("keeps assistant text when it adds explanation around tool output", () => {
    expect(shouldSuppressDuplicateToolEcho("a\nindex.html", "The files are:\n\na\nindex.html")).toBe(false);
  });
});

describe("resolveDuplicateToolEchoDelta", () => {
  test("buffers streamed assistant text while it can still be a tool-output echo", () => {
    expect(resolveDuplicateToolEchoDelta("a\nindex.html", "", "a\n")).toEqual({
      shouldBuffer: true,
      bufferedText: "a\n",
    });

    expect(resolveDuplicateToolEchoDelta("a\nindex.html", "a\n", "index")).toEqual({
      shouldBuffer: true,
      bufferedText: "a\nindex",
    });
  });

  test("buffers blank-line-separated streamed tool echoes", () => {
    expect(resolveDuplicateToolEchoDelta("All Documents\nApplications", "All Documents\n", "\n")).toEqual({
      shouldBuffer: true,
      bufferedText: "All Documents\n\n",
    });

    expect(resolveDuplicateToolEchoDelta("All Documents\nApplications", "All Documents\n\n", "Applications")).toEqual({
      shouldBuffer: true,
      bufferedText: "All Documents\n\nApplications",
    });
  });

  test("flushes buffered text once the assistant adds non-echo content", () => {
    expect(resolveDuplicateToolEchoDelta("a\nindex.html", "a\n", "The files are listed above.")).toEqual({
      shouldBuffer: false,
      text: "The files are listed above.",
    });
  });
});

describe("stripAlreadyRenderedToolLines", () => {
  test("removes already streamed tool lines with harmless trailing whitespace differences", () => {
    expect(stripAlreadyRenderedToolLines(
      ["All Documents ", "Applications", "bun.lock"],
      ["All Documents", "Applications"],
    )).toEqual(["bun.lock"]);
  });
});

describe("formatToolResultBlockPreview", () => {
  test("summarizes structured tool result blocks without raw JSON", () => {
    expect(
      formatToolResultBlockPreview({
        status: "ok",
        bytes_written: 128,
        meta: { source: "generated" },
      })
    ).toEqual([
      { text: "status: ok", variant: "default" },
      { text: "bytes_written: 128", variant: "default" },
      { text: "meta: {source}", variant: "default" },
    ]);
  });

  test("hides base64 image payloads behind a short summary", () => {
    expect(
      formatToolResultBlockPreview({
        type: "image",
        source: {
          type: "base64",
          data: "abcdef",
          media_type: "image/png",
        },
      })
    ).toEqual([
      { text: "image output (image/png)", variant: "default" },
    ]);
  });
});

describe("rewriteEditToolResultLine", () => {
  test("rewrites absolute edited-file paths to the display path", () => {
    expect(
      rewriteEditToolResultLine(
        "Edited /Users/example/pinocchio/docs/global_warming.md",
        "/Users/example/pinocchio/docs/global_warming.md",
        "/Users/example/pinocchio"
      )
    ).toBe("Edited docs/global_warming.md");
  });
});

describe("wrapPlainTextForTerminal", () => {
  test("moves the next whole word to a new line when it does not fit", () => {
    expect(
      wrapPlainTextForTerminal("learn more ", 9)
    ).toEqual({
      wrapped: "learn\nmore",
      trailingWhitespace: " ",
    });
  });

  test("respects the current cursor column for streaming continuation", () => {
    expect(
      wrapPlainTextForTerminal("learning ", 10, 8)
    ).toEqual({
      wrapped: "\nlearning",
      trailingWhitespace: " ",
    });
  });
});

describe("wrapRenderedAnsiText", () => {
  test("wraps long rendered lines while preserving ANSI styling", () => {
    expect(
      wrapRenderedAnsiText("\u001b[31mhello world\u001b[39m", 9)
    ).toBe("\u001b[31mhello\nworld\u001b[39m");
  });

  test("preserves leading indentation when redrawing transcript lines", () => {
    expect(
      wrapRenderedAnsiText("  ⎿  a\n     index.html\n", 80)
    ).toBe("  ⎿  a\n     index.html\n");
  });
});

describe("rewriteSuccessfulEditAssistantMarkdown", () => {
  test("normalizes short edit follow-up prose to a stable claude-style lead-in", () => {
    expect(
      rewriteSuccessfulEditAssistantMarkdown(
        "The title in global_warming.md has been updated to:\n\n```md\n# Global Warming Warning\n```",
        "/Users/example/pinocchio/global_warming.md",
        "/Users/example/pinocchio"
      )
    ).toBe("All set! Updated global_warming.md:\n\n```md\n# Global Warming Warning\n```");
  });

  test("leaves unrelated assistant markdown unchanged", () => {
    expect(
      rewriteSuccessfulEditAssistantMarkdown(
        "I also adjusted the summary paragraph and the footer copy.",
        "/Users/example/pinocchio/global_warming.md",
        "/Users/example/pinocchio"
      )
    ).toBe("I also adjusted the summary paragraph and the footer copy.");
  });
});

describe("renderTerminalMarkdown", () => {
  test("renders headings, bold, inline code, and bullets", () => {
    const rendered = renderTerminalMarkdown(
      "# Plan\n\n- Use **tests** with `bun test`",
      testStyles
    );

    expect(rendered).toBe("<h>Plan</h>\n<li>Use <b>tests</b> with <c>bun test</c></li>");
  });

  test("renders fenced code blocks without inline formatting", () => {
    const rendered = renderTerminalMarkdown(
      "```ts\nconst value = `raw`;\n```",
      testStyles
    );

    expect(rendered).toBe("<cb>const value = `raw`;</cb>");
  });

  test("renders blockquotes", () => {
    const rendered = renderTerminalMarkdown("> careful now", testStyles);

    expect(rendered).toBe("<q>careful now</q>");
  });

  test("renders markdown tables as aligned terminal tables", () => {
    const rendered = renderTerminalMarkdown(
      "| File | Size |\n| --- | --- |\n| global_warning.md | ~6.9 KB |",
      testStyles
    );

    expect(rendered).toBe(
      "┌───────────────────┬─────────┐\n" +
      "│ File              │ Size    │\n" +
      "├───────────────────┼─────────┤\n" +
      "│ global_warning.md │ ~6.9 KB │\n" +
      "└───────────────────┴─────────┘"
    );
  });

  test("renders GFM task lists, strikethrough, links, and rules", () => {
    const rendered = renderTerminalMarkdown(
      "- [x] ship ~~old~~ [docs](https://example.com)\n\n---",
      {
        ...testStyles,
        strikethrough: (text) => `<s>${text}</s>`,
        link: (text, href) => `<a:${href}>${text}</a>`,
        rule: () => "<hr>",
      }
    );

    expect(rendered).toBe("<li>[x] ship <s>old</s> <a:https://example.com>docs</a></li>\n<hr>");
  });

  test("preserves ordered list numbering", () => {
    const rendered = renderTerminalMarkdown("3. first\n4. second", testStyles);

    expect(rendered).toBe("<dim>3.</dim> first\n<dim>4.</dim> second");
  });
});

describe("renderThinkingEmphasis", () => {
  test("renders only double-star emphasis in thinking text", () => {
    const rendered = renderThinkingEmphasis("**Preparing to write an essay**\n\nUse `plain` text.", {
      body: (text) => `<t>${text}</t>`,
      bold: (text) => `<b>${text}</b>`,
    });

    expect(rendered).toBe("<t></t><b>Preparing to write an essay</b><t>\n\nUse `plain` text.</t>");
  });
});
