export default async function askUserQuestionTool(
  input: Record<string, unknown>,
  _context: { cwd: string },
): Promise<string> {
  const question = String(input.question ?? "").trim();
  if (!question) {
    throw new Error("question is required");
  }

  const context = String(input.context ?? "").trim();
  const options = Array.isArray(input.options)
    ? input.options
        .map((option) => String(option).trim())
        .filter(Boolean)
    : [];

  const lines = [`Question for user: ${question}`];
  if (context) {
    lines.push(`Context: ${context}`);
  }
  if (options.length > 0) {
    lines.push(`Suggested options: ${options.join(" | ")}`);
  }

  return lines.join("\n");
}
