import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

interface TodoItem {
  content: string;
  status: string;
  priority?: string;
}

export default async function todoWriteTool(
  input: Record<string, unknown>,
  context: { cwd: string },
): Promise<string> {
  const rawTodos = input.todos;
  if (!Array.isArray(rawTodos)) {
    throw new Error("todos is required");
  }

  const todos: TodoItem[] = rawTodos.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`todos[${index}] must be an object`);
    }

    const content = String((item as Record<string, unknown>).content ?? "").trim();
    const status = String((item as Record<string, unknown>).status ?? "").trim();
    const priority = String((item as Record<string, unknown>).priority ?? "").trim();

    if (!content) {
      throw new Error(`todos[${index}].content is required`);
    }

    if (!status) {
      throw new Error(`todos[${index}].status is required`);
    }

    return {
      content,
      status,
      ...(priority ? { priority } : {}),
    };
  });

  const stateDir = path.join(context.cwd, ".pinocchio", "state");
  const outputPath = path.join(stateDir, "todos.json");
  await mkdir(stateDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ todos }, null, 2)}\n`, "utf-8");

  return `Stored ${todos.length} todo item(s) in .pinocchio/state/todos.json`;
}
