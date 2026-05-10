import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function resolveProjectPath(cwd: string, filePath: string): string {
  const absolutePath = path.resolve(cwd, filePath);
  const relativePath = path.relative(cwd, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Path is outside the workspace: ${filePath}`);
  }

  return absolutePath;
}

export default async function editTool(
  input: Record<string, unknown>,
  context: { cwd: string },
): Promise<string> {
  const filePath = String(input.file_path ?? "").trim();
  const oldText = String(input.old_text ?? "");
  const newText = String(input.new_text ?? "");

  if (!filePath) {
    throw new Error("file_path is required");
  }

  if (!oldText) {
    throw new Error("old_text is required");
  }

  const absolutePath = resolveProjectPath(context.cwd, filePath);
  const current = await readFile(absolutePath, "utf-8");

  if (!current.includes(oldText)) {
    throw new Error(`old_text was not found in ${filePath}`);
  }

  const updated = current.replace(oldText, newText);
  await writeFile(absolutePath, updated, "utf-8");
  return `Edited ${filePath}`;
}
