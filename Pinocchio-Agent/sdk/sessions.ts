import { appendFile, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "fs/promises";
import * as path from "path";

import type { RewindFilesResult, SDKMessage, SessionInfo, SessionMessageRecord } from "./types.ts";

function sessionsDir(runtimeDir: string): string {
  return path.join(runtimeDir, "sessions");
}

function checkpointsDir(runtimeDir: string, sessionId: string): string {
  return path.join(runtimeDir, "checkpoints", sessionId);
}

function infoPath(runtimeDir: string, sessionId: string): string {
  return path.join(sessionsDir(runtimeDir), `${sessionId}.info.json`);
}

function transcriptPath(runtimeDir: string, sessionId: string): string {
  return path.join(sessionsDir(runtimeDir), `${sessionId}.jsonl`);
}

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function appendSessionMessage(
  runtimeDir: string,
  sessionId: string,
  record: SessionMessageRecord,
): Promise<void> {
  await ensureDir(sessionsDir(runtimeDir));
  await appendFile(transcriptPath(runtimeDir, sessionId), `${JSON.stringify(record)}\n`, "utf-8");
}

export async function readSessionMessages(runtimeDir: string, sessionId: string): Promise<SessionMessageRecord[]> {
  const filePath = transcriptPath(runtimeDir, sessionId);
  const raw = await readFile(filePath, "utf-8").catch(() => "");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionMessageRecord);
}

export async function writeSessionInfo(runtimeDir: string, info: SessionInfo): Promise<void> {
  await ensureDir(sessionsDir(runtimeDir));
  await writeFile(infoPath(runtimeDir, info.sessionId), JSON.stringify(info, null, 2), "utf-8");
}

export async function readSessionInfo(runtimeDir: string, sessionId: string): Promise<SessionInfo | null> {
  try {
    const raw = await readFile(infoPath(runtimeDir, sessionId), "utf-8");
    return JSON.parse(raw) as SessionInfo;
  } catch {
    return null;
  }
}

export async function listStoredSessions(runtimeDir: string): Promise<SessionInfo[]> {
  const dir = sessionsDir(runtimeDir);
  const dirStat = await stat(dir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    return [];
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const infos: SessionInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".info.json")) {
      continue;
    }

    const info = await readSessionInfo(runtimeDir, entry.name.replace(/\.info\.json$/, ""));
    if (info) {
      infos.push(info);
    }
  }

  return infos.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function renameStoredSession(runtimeDir: string, sessionId: string, title: string): Promise<void> {
  const info = await readSessionInfo(runtimeDir, sessionId);
  if (!info) {
    throw new Error(`Unknown session: ${sessionId}`);
  }

  info.title = title;
  info.updatedAt = Date.now();
  await writeSessionInfo(runtimeDir, info);
}

export async function tagStoredSession(runtimeDir: string, sessionId: string, tag: string): Promise<void> {
  const info = await readSessionInfo(runtimeDir, sessionId);
  if (!info) {
    throw new Error(`Unknown session: ${sessionId}`);
  }

  info.tag = tag;
  info.updatedAt = Date.now();
  await writeSessionInfo(runtimeDir, info);
}

export async function recordCheckpoint(
  runtimeDir: string,
  sessionId: string,
  filePath: string,
  beforeContent: string | null,
): Promise<void> {
  const dir = checkpointsDir(runtimeDir, sessionId);
  await ensureDir(dir);
  const timestamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(
    path.join(dir, `${timestamp}.json`),
    JSON.stringify(
      {
        filePath,
        beforeContent,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

export async function rewindSessionFiles(runtimeDir: string, sessionId: string): Promise<RewindFilesResult> {
  const dir = checkpointsDir(runtimeDir, sessionId);
  const dirStat = await stat(dir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    return {
      canRewind: false,
      error: "No checkpoints recorded for this session.",
    };
  }

  const entries = (await readdir(dir)).filter((entry) => entry.endsWith(".json")).sort().reverse();
  if (entries.length === 0) {
    return {
      canRewind: false,
      error: "No checkpoints recorded for this session.",
    };
  }

  const seen = new Set<string>();
  let insertions = 0;
  let deletions = 0;

  for (const entry of entries) {
    const raw = await readFile(path.join(dir, entry), "utf-8");
    const checkpoint = JSON.parse(raw) as { beforeContent: string | null; filePath: string };
    if (seen.has(checkpoint.filePath)) {
      continue;
    }

    seen.add(checkpoint.filePath);
    const current = await readFile(checkpoint.filePath, "utf-8").catch(() => "");
    insertions += Math.max(0, (checkpoint.beforeContent ?? "").length - current.length);
    deletions += Math.max(0, current.length - (checkpoint.beforeContent ?? "").length);

    if (checkpoint.beforeContent === null) {
      await unlink(checkpoint.filePath).catch(() => undefined);
    } else {
      await ensureDir(path.dirname(checkpoint.filePath));
      await writeFile(checkpoint.filePath, checkpoint.beforeContent, "utf-8");
    }
  }

  await rm(dir, { recursive: true, force: true });

  return {
    canRewind: true,
    filesChanged: [...seen],
    insertions,
    deletions,
  };
}

export async function upsertSessionInfo(
  runtimeDir: string,
  sessionId: string,
  data: Partial<SessionInfo> & Pick<SessionInfo, "cwd">,
): Promise<SessionInfo> {
  const current = (await readSessionInfo(runtimeDir, sessionId)) ?? {
    sessionId,
    cwd: data.cwd,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
  };

  const next: SessionInfo = {
    ...current,
    ...data,
    sessionId,
    updatedAt: Date.now(),
  };

  await writeSessionInfo(runtimeDir, next);
  return next;
}

export function getFirstPrompt(messages: SDKMessage[]): string | undefined {
  return messages.find((message): message is Extract<SDKMessage, { type: "user" }> => message.type === "user")?.message
    .content;
}
