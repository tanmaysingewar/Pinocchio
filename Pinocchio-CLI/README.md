# Pino CLI

Terminal interface for running the Pinocchio agent from any workspace.

The CLI uses the local Pinocchio SDK, loads agent configuration from `.agents/config.json` when available, renders assistant responses as terminal-friendly Markdown, and keeps tool calls and tool results visible in the transcript.

## Install

Install dependencies from this package:

```bash
bun install
```

For local development, link the command into your shell:

```bash
bun link
```

After linking, the command is available as:

```bash
pino
```

## Run

Start the CLI in the workspace you want Pinocchio to operate on:

```bash
cd /path/to/your/project
pino
```

You can also run it directly from this repo without linking:

```bash
bun run index.ts
```

## Configuration

Pinocchio reads runtime settings from `.agents/config.json` in the current workspace when that folder already exists. If no local `.agents` folder exists, it falls back to the global runtime configuration under `$PINOCCHIO_HOME` or `~/.agents`.

The active model is shown in the prompt footer and can be checked with:

```text
/model
```

`/model` opens an interactive model picker. Use `↑/↓` to select a model, `←/→` to adjust the reasoning effort supported by that model, and `Enter` to save both values. Pinocchio writes the selection to the workspace `.agents/config.json` when that folder exists, otherwise it writes to the global runtime config under `$PINOCCHIO_HOME` or `~/.agents`.

```text
/config
```

`/config` opens an interactive picker for tools and skills. Use the arrow keys to move through sections and entries, press Enter to toggle the selected item, and press Esc to go back or close the picker. Tool state is written to `.agents/tools/tools.json`; skill state is written to `.agents/config.json` as `disabled_skills`. The next prompt re-loads that state automatically.

```text
/init
```

`/init` creates a local `.agents/` runtime in the current folder with `.agents/config.json`, `.agents/tools/tools.json`, and `.agents/skills/` so you can store project-local tools and skills there.

```text
/mode
```

`/mode` opens an interactive mode editor. It lists saved modes, lets you edit tool and skill toggles for an existing mode, and includes a `Create mode` flow that asks for the mode name and whether to save it into the local workspace `.agents/modes` directory or the global `$PINOCCHIO_HOME/modes` runtime directory. Session mode switching stays on `Shift+Tab`.

The CLI currently runs the SDK with `permissionMode: "bypassPermissions"` so configured tools can execute directly and their calls/results remain visible in the terminal transcript.

## Commands

Inside the interactive prompt, use:

```text
/help         Show commands and keybindings
/init         Create a local .agents runtime in the current folder
/status       Show workspace, branch, model, mode, and approval mode
/config       Enable or disable tools and skills
/model        Open the model picker
/mode         Open the mode editor
/permissions  Show the active approval mode
/clear        Clear the terminal
/quit         Exit the CLI
```

Useful keybindings:

```text
Enter      Submit the prompt
Esc        Stop the active run
Ctrl+C     Stop or exit
Ctrl+A/E   Jump to start/end
Ctrl+U/K   Clear before/after cursor
Ctrl+O     Expand hidden tool output
Up/Down    Navigate prompt history
Up/Down    Select a model while the model picker is open
Up/Down    Select an item while the config picker is open
```

## Development

Run the test suite:

```bash
bun test
```

Type-check the CLI:

```bash
bunx tsc --noEmit
```

Useful smoke test after linking:

```bash
printf 'hello\n' | pino
```
