import { spawn } from "node:child_process";

type BashContext = {
  cwd: string;
  signal: AbortSignal;
  tool?: {
    timeout_ms?: number;
  };
  emitToolProgress?: (update: {
    status?: "running" | "completed";
    elapsedMs?: number;
    timeoutMs?: number;
    output?: string;
    stream?: "stdout" | "stderr";
  }) => Promise<void>;
};

function normalizeChunk(chunk: string): string {
  return chunk.replace(/\r\n/g, "\n");
}

function buildOutput(stdout: string, stderr: string, footer?: string): string {
  return [stdout.trimEnd(), stderr.trimEnd(), footer?.trim()].filter((part) => part && part.length > 0).join("\n");
}

function parseTimeoutToken(value: string): number | null {
  const match = value.trim().match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  if (unit === "ms") {
    return amount;
  }

  if (unit === "s") {
    return amount * 1_000;
  }

  if (unit === "m") {
    return amount * 60_000;
  }

  if (unit === "h") {
    return amount * 3_600_000;
  }

  return null;
}

function normalizeCommand(rawCommand: string, defaultTimeoutMs: number): { command: string; timeoutMs: number } {
  let command = rawCommand.trim();
  let timeoutMs = defaultTimeoutMs;

  const timeoutMatch = command.match(/^(?:g?timeout)\s+(\S+)\s+([\s\S]+)$/i);
  if (timeoutMatch) {
    timeoutMs = parseTimeoutToken(timeoutMatch[1] ?? "") ?? timeoutMs;
    command = (timeoutMatch[2] ?? command).trim();
  }

  const shellWrapperMatch = command.match(/^(?:(?:\/bin\/)?(?:bash|sh|zsh))\s+-l?c\s+(['"])([\s\S]*)\1$/i);
  if (shellWrapperMatch) {
    command = (shellWrapperMatch[2] ?? command).trim();
  }

  return { command, timeoutMs };
}

function killProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }

  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }

    child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

export default async function bashTool(
  input: Record<string, unknown>,
  context: BashContext,
): Promise<string> {
  const rawCommand = String(input.command ?? "").trim();
  if (!rawCommand) {
    throw new Error("command is required");
  }

  const defaultTimeoutMs = typeof context.tool?.timeout_ms === "number" ? context.tool.timeout_ms : 180_000;
  const { command, timeoutMs } = normalizeCommand(rawCommand, defaultTimeoutMs);
  const shell = process.env.SHELL || "/bin/bash";
  const startedAt = Date.now();

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(shell, ["-lc", command], {
      cwd: context.cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const emitRunningProgress = async (update: { output?: string; stream?: "stdout" | "stderr" } = {}): Promise<void> => {
      await context.emitToolProgress?.({
        status: "running",
        elapsedMs: Math.max(0, Date.now() - startedAt),
        timeoutMs,
        output: update.output,
        stream: update.stream,
      });
    };

    const settle = (handler: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timeoutHandle);
      context.signal.removeEventListener("abort", handleAbort);
      handler();
    };

    const handleAbort = () => {
      killProcessTree(child, "SIGTERM");
      setTimeout(() => {
        if (!settled) {
          killProcessTree(child, "SIGKILL");
        }
      }, 250).unref();
    };

    const heartbeat = setInterval(() => {
      void emitRunningProgress();
    }, 1_000);

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      setTimeout(() => {
        if (!settled) {
          killProcessTree(child, "SIGKILL");
        }
      }, 250).unref();
    }, timeoutMs);

    context.signal.addEventListener("abort", handleAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      const text = normalizeChunk(chunk);
      stdout += text;
      void emitRunningProgress({ output: text, stream: "stdout" });
    });

    child.stderr.on("data", (chunk: string) => {
      const text = normalizeChunk(chunk);
      stderr += text;
      void emitRunningProgress({ output: text, stream: "stderr" });
    });

    child.on("error", (error) => {
      settle(() => {
        reject(error);
      });
    });

    child.on("close", (code, signal) => {
      settle(() => {
        if (context.signal.aborted && !timedOut) {
          reject(new Error("Prompt interrupted"));
          return;
        }

        if (timedOut) {
          reject(new Error(buildOutput(stdout, stderr, `Command timed out after ${timeoutMs}ms.`)));
          return;
        }

        if (code === 0) {
          resolve(buildOutput(stdout, stderr) || "(command completed with no output)");
          return;
        }

        reject(new Error(buildOutput(stdout, stderr, `Command failed with exit code ${code ?? signal ?? "unknown"}.`)));
      });
    });

    void emitRunningProgress();
  });
}
