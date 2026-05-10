import { createServer } from "node:http";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const OPENAI_SUBSCRIPTION_PROTOCOL = "openai-subscription";
export const OPENAI_SUBSCRIPTION_PROVIDER_ID = "openai";
export const OPENAI_SUBSCRIPTION_ISSUER = "https://auth.openai.com";
export const OPENAI_SUBSCRIPTION_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const OPENAI_SUBSCRIPTION_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";
export const OPENAI_SUBSCRIPTION_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_NPM_PACKAGE_ENDPOINT = "https://registry.npmjs.org/@openai%2Fcodex";
const CODEX_MODELS_CATALOG_ENDPOINT = "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
const OAUTH_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const AUTH_FILENAME = "auth.json";

export interface OpenAISubscriptionAuth {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export interface OpenAISubscriptionTokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

export interface OpenAISubscriptionModel {
  slug: string;
  displayName: string;
  description?: string;
  visibility?: string;
  supportedInApi?: boolean;
  priority?: number;
  contextWindow?: number;
  maxContextWindow?: number;
}

export interface OpenAISubscriptionRateLimitWindow {
  usedPercent: number;
  windowSeconds?: number;
  resetAfterSeconds?: number;
  resetAt?: number;
}

export interface OpenAISubscriptionUsage {
  email?: string;
  planType?: string;
  limitReached: boolean;
  primaryWindow: OpenAISubscriptionRateLimitWindow | null;
  secondaryWindow: OpenAISubscriptionRateLimitWindow | null;
  hasCredits?: boolean;
  unlimitedCredits?: boolean;
  creditsBalance?: string | null;
}

interface PkceCodes {
  verifier: string;
  challenge: string;
}

interface PendingOAuth {
  pkce: PkceCodes;
  state: string;
  resolve: (tokens: OpenAISubscriptionTokenResponse) => void;
  reject: (error: Error) => void;
}

let oauthServer: ReturnType<typeof createServer> | undefined;
let pendingOAuth: PendingOAuth | undefined;

function userRuntimeDir(): string {
  return path.resolve(process.env.PINOCCHIO_HOME ?? path.join(homedir(), ".agents"));
}

export function getOpenAISubscriptionAuthFilePath(): string {
  return path.join(userRuntimeDir(), AUTH_FILENAME);
}

function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Buffer.from(bytes).toString("base64url");
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((byte) => chars[byte % chars.length])
    .join("");
}

export async function generateOpenAISubscriptionPKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43);
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return {
    verifier,
    challenge: base64UrlEncode(hash),
  };
}

export function generateOpenAISubscriptionState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractAccountIdFromClaims(claims: Record<string, unknown>): string | undefined {
  const nested = claims["https://api.openai.com/auth"];
  const organizations = claims.organizations;

  if (typeof claims.chatgpt_account_id === "string") {
    return claims.chatgpt_account_id;
  }

  if (
    nested &&
    typeof nested === "object" &&
    !Array.isArray(nested) &&
    typeof (nested as { chatgpt_account_id?: unknown }).chatgpt_account_id === "string"
  ) {
    return (nested as { chatgpt_account_id: string }).chatgpt_account_id;
  }

  if (
    Array.isArray(organizations) &&
    organizations[0] &&
    typeof organizations[0] === "object" &&
    typeof (organizations[0] as { id?: unknown }).id === "string"
  ) {
    return (organizations[0] as { id: string }).id;
  }

  return undefined;
}

export function extractAccountIdFromTokenResponse(tokens: Pick<OpenAISubscriptionTokenResponse, "id_token" | "access_token">): string | undefined {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) {
      continue;
    }

    const claims = parseJwtClaims(token);
    const accountId = claims ? extractAccountIdFromClaims(claims) : undefined;
    if (accountId) {
      return accountId;
    }
  }

  return undefined;
}

function toAuth(tokens: OpenAISubscriptionTokenResponse, fallbackAccountId?: string): OpenAISubscriptionAuth {
  return {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountIdFromTokenResponse(tokens) ?? fallbackAccountId,
  };
}

function isOpenAISubscriptionAuth(value: unknown): value is OpenAISubscriptionAuth {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "oauth" &&
    typeof (value as { access?: unknown }).access === "string" &&
    typeof (value as { refresh?: unknown }).refresh === "string" &&
    typeof (value as { expires?: unknown }).expires === "number"
  );
}

async function readAuthFile(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(getOpenAISubscriptionAuthFilePath(), "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeAuthFile(data: Record<string, unknown>): Promise<void> {
  const filePath = getOpenAISubscriptionAuthFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

export async function loadOpenAISubscriptionAuth(): Promise<OpenAISubscriptionAuth | null> {
  const data = await readAuthFile();
  const auth = data[OPENAI_SUBSCRIPTION_PROVIDER_ID];
  return isOpenAISubscriptionAuth(auth) ? auth : null;
}

export async function saveOpenAISubscriptionAuth(auth: OpenAISubscriptionAuth): Promise<void> {
  const data = await readAuthFile();
  await writeAuthFile({
    ...data,
    [OPENAI_SUBSCRIPTION_PROVIDER_ID]: auth,
  });
}

export async function removeOpenAISubscriptionAuth(): Promise<void> {
  const filePath = getOpenAISubscriptionAuthFilePath();
  const data = await readAuthFile();
  delete data[OPENAI_SUBSCRIPTION_PROVIDER_ID];

  if (Object.keys(data).length === 0) {
    await rm(filePath, { force: true });
    return;
  }

  await writeAuthFile(data);
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<OpenAISubscriptionTokenResponse> {
  const response = await fetch(`${OPENAI_SUBSCRIPTION_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  return response.json() as Promise<OpenAISubscriptionTokenResponse>;
}

async function refreshAccessToken(refreshToken: string): Promise<OpenAISubscriptionTokenResponse> {
  const response = await fetch(`${OPENAI_SUBSCRIPTION_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  return response.json() as Promise<OpenAISubscriptionTokenResponse>;
}

export async function refreshOpenAISubscriptionAuth(auth?: OpenAISubscriptionAuth | null): Promise<OpenAISubscriptionAuth> {
  const current = auth === undefined ? await loadOpenAISubscriptionAuth() : auth;
  if (!current) {
    throw new Error("Run /connect to connect your ChatGPT subscription.");
  }

  const tokens = await refreshAccessToken(current.refresh);
  const refreshed = toAuth(tokens, current.accountId);
  await saveOpenAISubscriptionAuth(refreshed);
  return refreshed;
}

export async function getValidOpenAISubscriptionAuth(): Promise<OpenAISubscriptionAuth> {
  const auth = await loadOpenAISubscriptionAuth();
  if (!auth) {
    throw new Error("Run /connect to connect your ChatGPT subscription.");
  }

  if (!auth.access || auth.expires <= Date.now()) {
    return refreshOpenAISubscriptionAuth(auth);
  }

  return auth;
}

function normalizeOpenAISubscriptionModel(value: unknown): OpenAISubscriptionModel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as {
    slug?: unknown;
    display_name?: unknown;
    description?: unknown;
    visibility?: unknown;
    supported_in_api?: unknown;
    priority?: unknown;
    context_window?: unknown;
    max_context_window?: unknown;
  };

  if (typeof raw.slug !== "string" || raw.slug.length === 0) {
    return null;
  }

  return {
    slug: raw.slug,
    displayName: typeof raw.display_name === "string" && raw.display_name.length > 0 ? raw.display_name : raw.slug,
    description: typeof raw.description === "string" && raw.description.length > 0 ? raw.description : undefined,
    visibility: typeof raw.visibility === "string" ? raw.visibility : undefined,
    supportedInApi: typeof raw.supported_in_api === "boolean" ? raw.supported_in_api : undefined,
    priority: typeof raw.priority === "number" ? raw.priority : undefined,
    contextWindow: typeof raw.context_window === "number" ? raw.context_window : undefined,
    maxContextWindow: typeof raw.max_context_window === "number" ? raw.max_context_window : undefined,
  };
}

function normalizeOpenAISubscriptionRateLimitWindow(value: unknown): OpenAISubscriptionRateLimitWindow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as {
    used_percent?: unknown;
    limit_window_seconds?: unknown;
    reset_after_seconds?: unknown;
    reset_at?: unknown;
  };

  if (typeof raw.used_percent !== "number") {
    return null;
  }

  return {
    usedPercent: raw.used_percent,
    windowSeconds: typeof raw.limit_window_seconds === "number" ? raw.limit_window_seconds : undefined,
    resetAfterSeconds: typeof raw.reset_after_seconds === "number" ? raw.reset_after_seconds : undefined,
    resetAt: typeof raw.reset_at === "number" ? raw.reset_at : undefined,
  };
}

function normalizeCodexClientVersion(version: unknown): string | undefined {
  if (typeof version !== "string") {
    return undefined;
  }

  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

function isClientVersionAtLeast(version: string, minimum: string): boolean {
  const current = version.split(".").map((part) => Number.parseInt(part, 10));
  const required = minimum.split(".").map((part) => Number.parseInt(part, 10));

  for (let index = 0; index < Math.max(current.length, required.length); index += 1) {
    const currentValue = current[index];
    const requiredValue = required[index];
    const currentPart = typeof currentValue === "number" && Number.isFinite(currentValue) ? currentValue : 0;
    const requiredPart = typeof requiredValue === "number" && Number.isFinite(requiredValue) ? requiredValue : 0;
    if (currentPart !== requiredPart) {
      return currentPart > requiredPart;
    }
  }

  return true;
}

async function fetchCodexModelCatalog(clientVersion: string): Promise<OpenAISubscriptionModel[]> {
  try {
    const response = await fetch(CODEX_MODELS_CATALOG_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as { models?: unknown };
    return Array.isArray(payload.models)
      ? payload.models
          .filter((model) => {
            const minimumVersion = (model as { minimal_client_version?: unknown })?.minimal_client_version;
            return typeof minimumVersion !== "string" || isClientVersionAtLeast(clientVersion, minimumVersion);
          })
          .map(normalizeOpenAISubscriptionModel)
          .filter((model): model is OpenAISubscriptionModel => model !== null)
      : [];
  } catch {
    return [];
  }
}

async function fetchLatestCodexClientVersion(): Promise<string> {
  const response = await fetch(CODEX_NPM_PACKAGE_ENDPOINT, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Codex version fetch failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    "dist-tags"?: { latest?: unknown };
    version?: unknown;
  };
  const version = normalizeCodexClientVersion(payload["dist-tags"]?.latest) ?? normalizeCodexClientVersion(payload.version);
  if (!version) {
    throw new Error("Codex version fetch failed: missing latest version");
  }

  return version;
}

function mergeOpenAISubscriptionModels(
  catalogModels: OpenAISubscriptionModel[],
  remoteModels: OpenAISubscriptionModel[],
): OpenAISubscriptionModel[] {
  const modelsBySlug = new Map<string, OpenAISubscriptionModel>();
  for (const model of catalogModels) {
    modelsBySlug.set(model.slug, model);
  }

  for (const model of remoteModels) {
    modelsBySlug.set(model.slug, {
      ...modelsBySlug.get(model.slug),
      ...model,
    });
  }

  return Array.from(modelsBySlug.values());
}

export async function listOpenAISubscriptionModels(): Promise<OpenAISubscriptionModel[]> {
  const auth = await getValidOpenAISubscriptionAuth();
  const clientVersion = await fetchLatestCodexClientVersion();
  const catalogModels = await fetchCodexModelCatalog(clientVersion);
  const url = new URL(OPENAI_SUBSCRIPTION_MODELS_ENDPOINT);
  url.searchParams.set("client_version", clientVersion);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.access}`,
  };
  if (auth.accountId) {
    headers["ChatGPT-Account-Id"] = auth.accountId;
  }

  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Models fetch failed: ${response.status}${body ? ` ${body}` : ""}`);
  }

  const payload = (await response.json()) as { models?: unknown };
  const models = Array.isArray(payload.models)
    ? payload.models
        .map(normalizeOpenAISubscriptionModel)
        .filter((model): model is OpenAISubscriptionModel => model !== null)
    : [];

  return mergeOpenAISubscriptionModels(catalogModels, models).sort((left, right) => {
    const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
    return leftPriority - rightPriority || left.slug.localeCompare(right.slug);
  });
}

export async function getOpenAISubscriptionUsage(): Promise<OpenAISubscriptionUsage> {
  const auth = await getValidOpenAISubscriptionAuth();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.access}`,
  };

  if (auth.accountId) {
    headers["ChatGPT-Account-Id"] = auth.accountId;
  }

  const response = await fetch(OPENAI_SUBSCRIPTION_USAGE_ENDPOINT, {
    method: "GET",
    headers,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Usage fetch failed: ${response.status}${body ? ` ${body}` : ""}`);
  }

  const payload = (await response.json()) as {
    email?: unknown;
    plan_type?: unknown;
    rate_limit?: {
      limit_reached?: unknown;
      primary_window?: unknown;
      secondary_window?: unknown;
    } | null;
    credits?: {
      has_credits?: unknown;
      unlimited?: unknown;
      balance?: unknown;
    } | null;
  };

  return {
    email: typeof payload.email === "string" ? payload.email : undefined,
    planType: typeof payload.plan_type === "string" ? payload.plan_type : undefined,
    limitReached: payload.rate_limit?.limit_reached === true,
    primaryWindow: normalizeOpenAISubscriptionRateLimitWindow(payload.rate_limit?.primary_window),
    secondaryWindow: normalizeOpenAISubscriptionRateLimitWindow(payload.rate_limit?.secondary_window),
    hasCredits: typeof payload.credits?.has_credits === "boolean" ? payload.credits.has_credits : undefined,
    unlimitedCredits: typeof payload.credits?.unlimited === "boolean" ? payload.credits.unlimited : undefined,
    creditsBalance:
      typeof payload.credits?.balance === "string" || payload.credits?.balance === null
        ? payload.credits.balance
        : undefined,
  };
}

export function buildOpenAISubscriptionAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "pinocchio",
  });

  return `${OPENAI_SUBSCRIPTION_ISSUER}/oauth/authorize?${params.toString()}`;
}

const HTML_SUCCESS = `<!doctype html><html><body><h1>Authorization Successful</h1><p>You can close this window and return to Pinocchio.</p><script>setTimeout(() => window.close(), 2000)</script></body></html>`;

const htmlError = (error: string) =>
  `<!doctype html><html><body><h1>Authorization Failed</h1><p>${error}</p></body></html>`;

async function startOAuthServer(): Promise<{ redirectUri: string }> {
  if (oauthServer) {
    return { redirectUri: `http://localhost:${OAUTH_PORT}${CALLBACK_PATH}` };
  }

  oauthServer = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");

    if (error) {
      pendingOAuth?.reject(new Error(error));
      pendingOAuth = undefined;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(htmlError(error));
      return;
    }

    if (!code) {
      pendingOAuth?.reject(new Error("Missing authorization code"));
      pendingOAuth = undefined;
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(htmlError("Missing authorization code"));
      return;
    }

    if (!pendingOAuth || state !== pendingOAuth.state) {
      pendingOAuth?.reject(new Error("Invalid state - potential CSRF attack"));
      pendingOAuth = undefined;
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(htmlError("Invalid state - potential CSRF attack"));
      return;
    }

    const current = pendingOAuth;
    pendingOAuth = undefined;
    exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}${CALLBACK_PATH}`, current.pkce)
      .then(current.resolve)
      .catch(current.reject);

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML_SUCCESS);
  });

  await new Promise<void>((resolve, reject) => {
    oauthServer?.listen(OAUTH_PORT, resolve);
    oauthServer?.once("error", reject);
  });

  return { redirectUri: `http://localhost:${OAUTH_PORT}${CALLBACK_PATH}` };
}

function stopOAuthServer(): void {
  oauthServer?.close();
  oauthServer = undefined;
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<OpenAISubscriptionTokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingOAuth = undefined;
      reject(new Error("OAuth callback timeout - authorization took too long"));
    }, 5 * 60 * 1000);

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout);
        resolve(tokens);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    };
  });
}

export async function connectOpenAISubscriptionWithBrowser(options: {
  onAuthorize?: (input: { url: string; instructions: string }) => Promise<void> | void;
  openUrl?: (url: string) => Promise<void> | void;
} = {}): Promise<OpenAISubscriptionAuth> {
  const { redirectUri } = await startOAuthServer();
  const pkce = await generateOpenAISubscriptionPKCE();
  const state = generateOpenAISubscriptionState();
  const url = buildOpenAISubscriptionAuthorizeUrl(redirectUri, pkce, state);
  const callback = waitForOAuthCallback(pkce, state);

  try {
    await options.onAuthorize?.({
      url,
      instructions: "Complete authorization in your browser. This window will close automatically.",
    });
    await options.openUrl?.(url);
    const tokens = await callback;
    const auth = toAuth(tokens);
    await saveOpenAISubscriptionAuth(auth);
    return auth;
  } finally {
    stopOAuthServer();
  }
}
