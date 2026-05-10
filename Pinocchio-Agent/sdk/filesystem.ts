import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import * as path from "path";

import type { AgentDefinition, HookCallbackMatcher, McpServerConfig, Options, SdkPluginConfig } from "./types.ts";
import { OPENAI_SUBSCRIPTION_PROTOCOL } from "./openai-subscription-auth.ts";

export const OPENAI_SUBSCRIPTION_DEFAULT_MODEL = "gpt-5.4";
export const OPENAI_SUBSCRIPTION_BASE_URL = "https://api.openai.com/v1/responses";

export interface LoadedToolConfig {
  name: string;
  enabled: boolean;
  description: string;
  input_schema: Record<string, unknown>;
  source?: string;
  sourcePath?: string;
  timeout_ms?: number;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  content: string;
}

export interface ConfigurableToolSummary {
  name: string;
  enabled: boolean;
  description: string;
}

export interface ConfigurableSkillSummary {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
}

export interface RuntimeModeRule {
  allow: string[];
  deny: string[];
}

export interface RuntimeModeDefinition {
  id: string;
  name: string;
  description: string;
  source: "project" | "global";
  filePath: string;
  tools: RuntimeModeRule;
  skills: RuntimeModeRule;
  paths: RuntimeModeRule;
}

export interface SaveRuntimeModeInput {
  id?: string;
  name: string;
  description?: string;
  source: "project" | "global";
  disabledTools: string[];
  disabledSkills: string[];
  paths?: Partial<RuntimeModeRule>;
}

export interface SlashCommandSummary {
  name: string;
  description: string;
  path: string;
  prompt: string;
}

export interface PluginSummary {
  name: string;
  path: string;
}

export interface AgentFileDefinition extends AgentDefinition {
  name: string;
  path: string;
}

export interface LoadedProjectConfig {
  name: string;
  model: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  max_tokens: number;
  system_prompt: string;
  disabled_skills: string[];
  provider: NonNullable<Options["provider"]>;
}

export interface LoadedProjectRuntime {
  runtimeDir: string;
  workspaceDir: string;
  config: LoadedProjectConfig;
  tools: LoadedToolConfig[];
  skills: SkillSummary[];
  slashCommands: SlashCommandSummary[];
  plugins: PluginSummary[];
  agents: Record<string, AgentDefinition>;
  mcpServers: Record<string, McpServerConfig>;
  hooks: Partial<Record<string, HookCallbackMatcher[]>>;
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function normalizeDisabledSkills(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )];
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }

  const result: Record<string, string> = {};
  const frontmatter = match[1] ?? "";
  for (const line of frontmatter.split(/\r?\n/)) {
    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!keyValue) {
      continue;
    }

    const key = keyValue[1];
    const value = keyValue[2];
    if (!key || !value) {
      continue;
    }

    result[key] = stripQuotes(value);
  }

  return result;
}

async function readJSONFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJSONFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function isDirectory(dirPath: string): Promise<boolean> {
  const dirStat = await stat(dirPath).catch(() => null);
  return dirStat?.isDirectory() ?? false;
}

async function isFile(filePath: string): Promise<boolean> {
  const fileStat = await stat(filePath).catch(() => null);
  return fileStat?.isFile() ?? false;
}

function userRuntimeDir(): string {
  return path.resolve(process.env.PINOCCHIO_HOME ?? path.join(homedir(), ".agents"));
}

function slugifyModeId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "mode";
}

async function resolveRuntimeDir(
  cwd: string,
): Promise<{ projectDir: string; workspaceDir: string; globalDir: string; hasProjectRuntime: boolean }> {
  let currentDir = path.resolve(cwd);
  const globalDir = userRuntimeDir();

  while (true) {
    const candidate = path.join(currentDir, ".agents");
    if (await isDirectory(candidate)) {
      return { projectDir: candidate, workspaceDir: currentDir, globalDir, hasProjectRuntime: true };
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  return { projectDir: globalDir, workspaceDir: cwd, globalDir, hasProjectRuntime: false };
}

function parseModeDefinition(
  filePath: string,
  raw: Record<string, unknown> | null,
  source: "project" | "global",
): RuntimeModeDefinition | null {
  if (!raw) {
    return null;
  }

  const fileName = path.basename(filePath, ".json");
  const id = typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : fileName;
  if (!id) {
    return null;
  }

  const tools = typeof raw.tools === "object" && raw.tools !== null ? raw.tools as Record<string, unknown> : {};
  const skills = typeof raw.skills === "object" && raw.skills !== null ? raw.skills as Record<string, unknown> : {};
  const paths = typeof raw.paths === "object" && raw.paths !== null ? raw.paths as Record<string, unknown> : {};

  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name.trim() : id,
    description:
      typeof raw.description === "string" && raw.description.trim().length > 0
        ? raw.description.trim()
        : "No description provided.",
    source,
    filePath,
    tools: {
      allow: normalizeStringArray(tools.allow),
      deny: normalizeStringArray(tools.deny),
    },
    skills: {
      allow: normalizeStringArray(skills.allow),
      deny: normalizeStringArray(skills.deny),
    },
    paths: {
      allow: normalizeStringArray(paths.allow),
      deny: normalizeStringArray(paths.deny),
    },
  };
}

async function loadModesFromDirectory(
  modesDir: string,
  source: "project" | "global",
): Promise<RuntimeModeDefinition[]> {
  if (!(await isDirectory(modesDir))) {
    return [];
  }

  const entries = await readdir(modesDir, { withFileTypes: true });
  const modes: RuntimeModeDefinition[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(modesDir, entry.name);
    const mode = parseModeDefinition(
      filePath,
      await readJSONFile<Record<string, unknown>>(filePath),
      source,
    );
    if (mode) {
      modes.push(mode);
    }
  }

  return modes;
}

async function discoverConfigurableSkills(
  skillsDir: string,
  disabledSkillIds: Set<string> = new Set(),
): Promise<ConfigurableSkillSummary[]> {
  if (!(await isDirectory(skillsDir))) {
    return [];
  }

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills: ConfigurableSkillSummary[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    const fileStat = await stat(skillFile).catch(() => null);
    if (!fileStat?.isFile()) {
      continue;
    }

    const frontmatter = parseFrontmatter(await readFile(skillFile, "utf-8"));
    skills.push({
      id: entry.name,
      name: frontmatter.name || entry.name,
      description: frontmatter.description || "No description provided.",
      enabled: !disabledSkillIds.has(entry.name),
    });
  }

  return skills;
}

async function discoverSkills(
  skillsDir: string,
  workspaceDir: string,
  disabledSkillIds: Set<string> = new Set(),
): Promise<SkillSummary[]> {
  if (!(await isDirectory(skillsDir))) {
    return [];
  }

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills: SkillSummary[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || disabledSkillIds.has(entry.name)) {
      continue;
    }

    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    const fileStat = await stat(skillFile).catch(() => null);
    if (!fileStat?.isFile()) {
      continue;
    }

    const content = await readFile(skillFile, "utf-8");
    const frontmatter = parseFrontmatter(content);
    skills.push({
      id: entry.name,
      name: frontmatter.name || entry.name,
      description: frontmatter.description || "No description provided.",
      path: path.relative(workspaceDir, skillFile) || "SKILL.md",
      content,
    });
  }

  return skills;
}

async function discoverSlashCommands(commandsDir: string, workspaceDir: string): Promise<SlashCommandSummary[]> {
  if (!(await isDirectory(commandsDir))) {
    return [];
  }

  const entries = await readdir(commandsDir, { withFileTypes: true });
  const commands: SlashCommandSummary[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const commandPath = path.join(commandsDir, entry.name);
    const prompt = await readFile(commandPath, "utf-8");
    const frontmatter = parseFrontmatter(prompt);
    const name = entry.name.replace(/\.md$/i, "");

    commands.push({
      name,
      description: frontmatter.description || `Slash command ${name}`,
      path: path.relative(workspaceDir, commandPath),
      prompt,
    });
  }

  return commands;
}

async function discoverAgents(agentsDir: string, workspaceDir: string): Promise<AgentFileDefinition[]> {
  if (!(await isDirectory(agentsDir))) {
    return [];
  }

  const entries = await readdir(agentsDir, { withFileTypes: true });
  const agents: AgentFileDefinition[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const filePath = path.join(agentsDir, entry.name);
    const raw = await readFile(filePath, "utf-8");
    const frontmatter = parseFrontmatter(raw);
    const prompt = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    const name = frontmatter.name || entry.name.replace(/\.md$/i, "");

    agents.push({
      name,
      path: path.relative(workspaceDir, filePath),
      description: frontmatter.description || `Subagent ${name}`,
      prompt,
      maxTurns: frontmatter.max_turns ? Number(frontmatter.max_turns) : undefined,
      model: frontmatter.model,
      tools: frontmatter.tools ? frontmatter.tools.split(",").map((item) => stripQuotes(item)) : undefined,
      skills: frontmatter.skills ? frontmatter.skills.split(",").map((item) => stripQuotes(item)) : undefined,
    });
  }

  return agents;
}

async function loadTools(toolsDir: string): Promise<LoadedToolConfig[]> {
  const toolsFile = path.join(toolsDir, "tools.json");
  const config = await readJSONFile<{ tools?: Array<Record<string, unknown>> }>(toolsFile);
  if (!config?.tools) {
    return [];
  }

  return config.tools.map((tool) => {
    const source = typeof tool.source === "string" ? tool.source : undefined;
    return {
      name: String(tool.name ?? ""),
      enabled: tool.enabled !== false,
      description: String(tool.description ?? ""),
      input_schema:
        tool.input_schema && typeof tool.input_schema === "object" && !Array.isArray(tool.input_schema)
          ? (tool.input_schema as Record<string, unknown>)
          : {},
      source,
      sourcePath: source ? path.resolve(toolsDir, source) : undefined,
      timeout_ms: typeof tool.timeout_ms === "number" ? tool.timeout_ms : 180_000,
    };
  });
}

async function loadPlugins(baseDir: string, pluginConfigs: SdkPluginConfig[] = []): Promise<PluginSummary[]> {
  const fromProjectDir = path.join(baseDir, "plugins");
  const discovered: PluginSummary[] = [];

  if (await isDirectory(fromProjectDir)) {
    const entries = await readdir(fromProjectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      discovered.push({
        name: entry.name,
        path: path.join(fromProjectDir, entry.name),
      });
    }
  }

  for (const plugin of pluginConfigs) {
    discovered.push({
      name: path.basename(plugin.path),
      path: path.resolve(baseDir, plugin.path),
    });
  }

  const deduped = new Map<string, PluginSummary>();
  for (const plugin of discovered) {
    deduped.set(plugin.path, plugin);
  }

  return [...deduped.values()];
}

function defaultProjectConfig(): LoadedProjectConfig {
  return {
    name: "",
    model: "",
    effort: undefined,
    max_tokens: 0,
    system_prompt: "",
    disabled_skills: [],
    provider: {},
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function mergeConfigRaw(
  baseConfig: LoadedProjectConfig,
  configRaw: Record<string, unknown> | null,
): LoadedProjectConfig {
  const providerRaw = objectValue(configRaw?.provider);

  return {
    name: typeof configRaw?.name === "string" ? configRaw.name : baseConfig.name,
    model: typeof configRaw?.model === "string" ? configRaw.model : baseConfig.model,
    effort:
      configRaw?.effort === "none" ||
      configRaw?.effort === "minimal" ||
      configRaw?.effort === "low" ||
      configRaw?.effort === "medium" ||
      configRaw?.effort === "high" ||
      configRaw?.effort === "xhigh"
        ? configRaw.effort
        : baseConfig.effort,
    max_tokens: typeof configRaw?.max_tokens === "number" ? configRaw.max_tokens : baseConfig.max_tokens,
    system_prompt:
      typeof configRaw?.system_prompt === "string" ? configRaw.system_prompt : baseConfig.system_prompt,
    disabled_skills:
      Array.isArray(configRaw?.disabled_skills)
        ? normalizeDisabledSkills(configRaw.disabled_skills)
        : baseConfig.disabled_skills,
    provider: {
      ...baseConfig.provider,
      ...providerRaw,
      headers: {
        ...(baseConfig.provider.headers ?? {}),
        ...objectValue(providerRaw.headers),
      },
    } as LoadedProjectConfig["provider"],
  };
}

async function shouldUseProjectLayer(
  hasProjectRuntime: boolean,
  projectDir: string,
  globalDir: string,
  layerPath: string,
): Promise<boolean> {
  return hasProjectRuntime && projectDir !== globalDir && (await isDirectory(path.join(projectDir, layerPath)));
}

export async function loadProjectRuntime(
  cwd: string,
  pluginConfigs: SdkPluginConfig[] = [],
): Promise<LoadedProjectRuntime> {
  const { projectDir, workspaceDir, globalDir, hasProjectRuntime } = await resolveRuntimeDir(cwd);
  const globalConfigRaw = await readJSONFile<Record<string, unknown>>(path.join(globalDir, "config.json"));
  const projectConfigRaw =
    hasProjectRuntime && projectDir !== globalDir
      ? await readJSONFile<Record<string, unknown>>(path.join(projectDir, "config.json"))
      : null;
  const config = mergeConfigRaw(mergeConfigRaw(defaultProjectConfig(), globalConfigRaw), projectConfigRaw);
  const useProjectTools =
    hasProjectRuntime && projectDir !== globalDir
      ? await isFile(path.join(projectDir, "tools", "tools.json"))
      : false;
  const useProjectSkills = await shouldUseProjectLayer(hasProjectRuntime, projectDir, globalDir, "skills");
  const useProjectCommands = await shouldUseProjectLayer(hasProjectRuntime, projectDir, globalDir, "commands");
  const useProjectAgents = await shouldUseProjectLayer(hasProjectRuntime, projectDir, globalDir, "agents");
  const useProjectPlugins = await shouldUseProjectLayer(hasProjectRuntime, projectDir, globalDir, "plugins");
  const disabledSkillIds = new Set(config.disabled_skills);

  const tools = await loadTools(path.join(useProjectTools ? projectDir : globalDir, "tools"));
  const skills = await discoverSkills(path.join(useProjectSkills ? projectDir : globalDir, "skills"), workspaceDir, disabledSkillIds);
  const slashCommands = await discoverSlashCommands(
    path.join(useProjectCommands ? projectDir : globalDir, "commands"),
    workspaceDir,
  );
  const agentFiles = await discoverAgents(path.join(useProjectAgents ? projectDir : globalDir, "agents"), workspaceDir);
  const plugins = await loadPlugins(useProjectPlugins ? projectDir : globalDir, pluginConfigs);
  const mcpServers =
    (await readJSONFile<Record<string, McpServerConfig>>(path.join(globalDir, "mcp.json"))) ?? {};

  if (hasProjectRuntime && projectDir !== globalDir) {
    const projectMcp = await readJSONFile<Record<string, McpServerConfig>>(path.join(projectDir, "mcp.json"));
    if (projectMcp) {
      Object.assign(mcpServers, projectMcp);
    }
  }

  const agents: Record<string, AgentDefinition> = {};
  for (const agent of agentFiles) {
    agents[agent.name] = {
      description: agent.description,
      prompt: agent.prompt,
      tools: agent.tools,
      skills: agent.skills,
      maxTurns: agent.maxTurns,
      model: agent.model,
    };
  }

  for (const plugin of plugins) {
    const pluginConfig = await readJSONFile<{ name?: string }>(path.join(plugin.path, ".agents-plugin", "plugin.json"));
    if (pluginConfig?.name) {
      plugin.name = pluginConfig.name;
    }

    const pluginTools = await loadTools(path.join(plugin.path, "tools"));
    tools.push(...pluginTools);

    const pluginSkills = await discoverSkills(path.join(plugin.path, "skills"), workspaceDir);
    skills.push(...pluginSkills);

    const pluginCommands = await discoverSlashCommands(path.join(plugin.path, "commands"), workspaceDir);
    slashCommands.push(...pluginCommands);

    const pluginAgents = await discoverAgents(path.join(plugin.path, "agents"), workspaceDir);
    for (const agent of pluginAgents) {
      agents[agent.name] = {
        description: agent.description,
        prompt: agent.prompt,
        tools: agent.tools,
        skills: agent.skills,
        maxTurns: agent.maxTurns,
        model: agent.model,
      };
    }

    const pluginMcp = await readJSONFile<Record<string, McpServerConfig>>(path.join(plugin.path, "mcp.json"));
    if (pluginMcp) {
      Object.assign(mcpServers, pluginMcp);
    }
  }

  return {
    runtimeDir: globalDir,
    workspaceDir,
    config,
    tools,
    skills,
    slashCommands,
    plugins,
    agents,
    mcpServers,
    hooks: {},
  };
}

export async function configureOpenAISubscriptionRuntime(
  cwd: string,
  model = OPENAI_SUBSCRIPTION_DEFAULT_MODEL,
): Promise<LoadedProjectConfig> {
  const { projectDir, globalDir, hasProjectRuntime } = await resolveRuntimeDir(cwd);
  const targetDir = hasProjectRuntime ? projectDir : globalDir;
  const configPath = path.join(targetDir, "config.json");
  const raw = (await readJSONFile<Record<string, unknown>>(configPath)) ?? {};
  const providerRaw = objectValue(raw.provider);
  const nextConfig = {
    ...raw,
    model,
    provider: {
      ...providerRaw,
      api_key: undefined,
      api_key_env: undefined,
      auth_header: undefined,
      auth_prefix: undefined,
      base_url: OPENAI_SUBSCRIPTION_BASE_URL,
      protocol: OPENAI_SUBSCRIPTION_PROTOCOL,
    },
  };

  for (const key of ["api_key", "api_key_env", "auth_header", "auth_prefix"]) {
    delete (nextConfig.provider as Record<string, unknown>)[key];
  }

  await writeJSONFile(configPath, nextConfig);
  return mergeConfigRaw(defaultProjectConfig(), nextConfig);
}

export async function setProjectRuntimeModel(
  cwd: string,
  model: string,
  effort?: LoadedProjectConfig["effort"],
): Promise<LoadedProjectConfig> {
  const { projectDir, globalDir, hasProjectRuntime } = await resolveRuntimeDir(cwd);
  const targetDir = hasProjectRuntime ? projectDir : globalDir;
  const configPath = path.join(targetDir, "config.json");
  const raw = (await readJSONFile<Record<string, unknown>>(configPath)) ?? {};

  await writeJSONFile(configPath, {
    ...raw,
    model,
    ...(effort ? { effort } : {}),
  });

  return (await loadProjectRuntime(cwd)).config;
}

export async function createProjectRuntimeScaffold(
  cwd: string,
): Promise<{ runtimeDir: string; created: boolean }> {
  const runtimeDir = path.join(path.resolve(cwd), ".agents");
  const created = !(await isDirectory(runtimeDir));

  await mkdir(path.join(runtimeDir, "tools"), { recursive: true });
  await mkdir(path.join(runtimeDir, "skills"), { recursive: true });

  const configPath = path.join(runtimeDir, "config.json");
  if (!(await isFile(configPath))) {
    await writeJSONFile(configPath, {
      disabled_skills: [],
    });
  }

  const toolsPath = path.join(runtimeDir, "tools", "tools.json");
  if (!(await isFile(toolsPath))) {
    await writeJSONFile(toolsPath, {
      tools: [],
    });
  }

  return { runtimeDir, created };
}

export async function listProjectRuntimeModes(cwd: string): Promise<RuntimeModeDefinition[]> {
  const { projectDir, globalDir, hasProjectRuntime } = await resolveRuntimeDir(cwd);
  const modes = new Map<string, RuntimeModeDefinition>();

  for (const mode of await loadModesFromDirectory(path.join(globalDir, "modes"), "global")) {
    modes.set(mode.id, mode);
  }

  if (hasProjectRuntime && projectDir !== globalDir) {
    for (const mode of await loadModesFromDirectory(path.join(projectDir, "modes"), "project")) {
      modes.set(mode.id, mode);
    }
  }

  return [...modes.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function getProjectRuntimeMode(cwd: string, modeId: string): Promise<RuntimeModeDefinition | null> {
  const normalizedModeId = modeId.trim();
  if (!normalizedModeId || normalizedModeId === "default") {
    return null;
  }

  const modes = await listProjectRuntimeModes(cwd);
  return modes.find((mode) => mode.id === normalizedModeId) ?? null;
}

export async function saveProjectRuntimeMode(cwd: string, input: SaveRuntimeModeInput): Promise<RuntimeModeDefinition> {
  const { projectDir, globalDir, hasProjectRuntime } = await resolveRuntimeDir(cwd);
  const targetRoot = input.source === "global"
    ? globalDir
    : (hasProjectRuntime && projectDir !== globalDir ? projectDir : path.join(path.resolve(cwd), ".agents"));
  const modesDir = path.join(targetRoot, "modes");

  let modeId = input.id?.trim() || "";
  if (!modeId) {
    modeId = slugifyModeId(input.name);
    let suffix = 2;
    while (await isFile(path.join(modesDir, `${modeId}.json`))) {
      modeId = `${slugifyModeId(input.name)}-${suffix}`;
      suffix += 1;
    }
  }

  const filePath = path.join(modesDir, `${modeId}.json`);
  const payload = {
    id: modeId,
    name: input.name.trim() || modeId,
    description: input.description?.trim() || `Custom mode for ${input.name.trim() || modeId}.`,
    tools: {
      deny: normalizeStringArray(input.disabledTools).sort((left, right) => left.localeCompare(right)),
    },
    skills: {
      deny: normalizeStringArray(input.disabledSkills).sort((left, right) => left.localeCompare(right)),
    },
    paths: {
      allow: normalizeStringArray(input.paths?.allow),
      deny: normalizeStringArray(input.paths?.deny),
    },
  };

  await writeJSONFile(filePath, payload);
  const saved = parseModeDefinition(filePath, payload as Record<string, unknown>, input.source);
  if (!saved) {
    throw new Error(`Could not save mode "${modeId}".`);
  }
  return saved;
}

export async function getProjectRuntimeConfigState(
  cwd: string,
): Promise<{ tools: ConfigurableToolSummary[]; skills: ConfigurableSkillSummary[] }> {
  const { projectDir, globalDir, hasProjectRuntime } = await resolveRuntimeDir(cwd);
  const globalConfigRaw = await readJSONFile<Record<string, unknown>>(path.join(globalDir, "config.json"));
  const projectConfigRaw =
    hasProjectRuntime && projectDir !== globalDir
      ? await readJSONFile<Record<string, unknown>>(path.join(projectDir, "config.json"))
      : null;
  const config = mergeConfigRaw(mergeConfigRaw(defaultProjectConfig(), globalConfigRaw), projectConfigRaw);
  const useProjectTools =
    hasProjectRuntime && projectDir !== globalDir
      ? await isFile(path.join(projectDir, "tools", "tools.json"))
      : false;
  const useProjectSkills = await shouldUseProjectLayer(hasProjectRuntime, projectDir, globalDir, "skills");

  const tools = await loadTools(path.join(useProjectTools ? projectDir : globalDir, "tools"));
  const skills = await discoverConfigurableSkills(
    path.join(useProjectSkills ? projectDir : globalDir, "skills"),
    new Set(config.disabled_skills),
  );

  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      enabled: tool.enabled,
      description: tool.description,
    })),
    skills,
  };
}

export async function setProjectRuntimeToolEnabled(
  cwd: string,
  toolName: string,
  enabled: boolean,
): Promise<{ tools: ConfigurableToolSummary[]; skills: ConfigurableSkillSummary[] }> {
  const { projectDir, globalDir, hasProjectRuntime } = await resolveRuntimeDir(cwd);
  const useProjectTools =
    hasProjectRuntime && projectDir !== globalDir
      ? await isFile(path.join(projectDir, "tools", "tools.json"))
      : false;
  const toolsPath = path.join(useProjectTools ? projectDir : globalDir, "tools", "tools.json");
  const raw = (await readJSONFile<{ tools?: Array<Record<string, unknown>> }>(toolsPath)) ?? { tools: [] };
  const tools = Array.isArray(raw.tools) ? raw.tools : [];
  const target = tools.find((tool) => tool.name === toolName);

  if (!target) {
    throw new Error(`Tool "${toolName}" was not found in ${toolsPath}.`);
  }

  target.enabled = enabled;
  await writeJSONFile(toolsPath, {
    ...raw,
    tools,
  });
  return getProjectRuntimeConfigState(cwd);
}

export async function setProjectRuntimeSkillEnabled(
  cwd: string,
  skillId: string,
  enabled: boolean,
): Promise<{ tools: ConfigurableToolSummary[]; skills: ConfigurableSkillSummary[] }> {
  const { projectDir, globalDir, hasProjectRuntime } = await resolveRuntimeDir(cwd);
  const targetDir = hasProjectRuntime ? projectDir : globalDir;
  const configPath = path.join(targetDir, "config.json");
  const raw = (await readJSONFile<Record<string, unknown>>(configPath)) ?? {};
  const disabledSkills = new Set(normalizeDisabledSkills(raw.disabled_skills));

  if (enabled) {
    disabledSkills.delete(skillId);
  } else {
    disabledSkills.add(skillId);
  }

  await writeJSONFile(configPath, {
    ...raw,
    disabled_skills: [...disabledSkills].sort((left, right) => left.localeCompare(right)),
  });

  return getProjectRuntimeConfigState(cwd);
}
