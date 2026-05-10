import { readFile } from "node:fs/promises";
import path from "node:path";

export default async function agentTool(
  input: Record<string, unknown>,
  context: { cwd: string },
): Promise<string> {
  const agentName = String(input.agent_name ?? "").trim();
  const task = String(input.task ?? "").trim();

  if (!agentName) {
    throw new Error("agent_name is required");
  }

  if (!task) {
    throw new Error("task is required");
  }

  const agentPath = path.join(context.cwd, ".pinocchio", "agents", `${agentName}.md`);
  const raw = await readFile(agentPath, "utf-8");
  const prompt = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

  return [
    `Delegation target: ${agentName}`,
    `Task: ${task}`,
    "",
    "Agent prompt:",
    prompt,
  ].join("\n");
}
