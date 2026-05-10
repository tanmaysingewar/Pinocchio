import { readFile } from "node:fs/promises";
import path from "node:path";

function resolveProjectPath(cwd: string, filePath: string): string {
  const absolutePath = path.resolve(cwd, filePath);
  const relativePath = path.relative(cwd, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Path is outside the workspace: ${filePath}`);
  }

  return absolutePath;
}

export default async function readTool(
  input: Record<string, unknown>,
  context: { cwd: string },
): Promise<string> {
  const filePath = String(input.file_path ?? "").trim();
  if (!filePath) {
    throw new Error("file_path is required");
  }

  const absolutePath = resolveProjectPath(context.cwd, filePath);
  return await readFile(absolutePath, "utf-8");
}
