import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  /**
   * Which model service Codex talks to.
   *
   * "ark" is the starter kit's BytePlus ModelArk path, and needs the adapter in
   * ark-proxy.ts because Ark rejects Codex's multi-turn requests.
   * "openai" is Codex's own native provider, so it needs no adapter.
   */
  MODEL_PROVIDER: z.enum(["ark", "openai"]).default("ark"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5.1-codex"),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  /** Conforms Codex's requests to Ark's stricter schema. See ark-proxy.ts. */
  ARK_PROXY_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value !== "false" && value !== "0"),
  ARK_PROXY_PORT: z.coerce.number().int().min(0).max(65535).default(8788),
  /** How the Runtime container reaches the host running this proxy. */
  ARK_PROXY_HOST: z.string().min(1).default("host.docker.internal"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    modelProvider: env.MODEL_PROVIDER,
    // The key, the model name, and the environment variable Codex reads the
    // key from, all resolved for whichever provider is selected. Everything
    // downstream uses these rather than provider-specific fields.
    modelApiKey:
      env.MODEL_PROVIDER === "openai"
        ? (env.OPENAI_API_KEY?.trim() ?? "")
        : (env.ARK_API_KEY?.trim() ?? ""),
    modelName:
      env.MODEL_PROVIDER === "openai" ? env.OPENAI_MODEL.trim() : (env.ARK_MODEL?.trim() ?? ""),
    modelApiKeyEnvName: env.MODEL_PROVIDER === "openai" ? "OPENAI_API_KEY" : "ARK_API_KEY",
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    // Only Ark needs the adapter; OpenAI accepts Codex's requests as they are.
    arkProxyEnabled: env.ARK_PROXY_ENABLED && env.MODEL_PROVIDER === "ark",
    arkProxyPort: env.ARK_PROXY_PORT,
    arkProxyHost:
      env.RUNTIME_PROVIDER === "container" ? env.ARK_PROXY_HOST : "127.0.0.1",
    nodeEnv: env.NODE_ENV,
  };
}

export function isModelConfigured(config: AppConfig): boolean {
  return (
    config.modelApiKey.length > 0 &&
    !config.modelApiKey.startsWith("replace-") &&
    config.modelName.length > 0 &&
    !config.modelName.includes("replace-")
  );
}

/**
 * `modelBaseUrl` overrides where Codex sends model traffic. Pass the Ark proxy's
 * URL so multi-turn requests get conformed to Ark's schema; omit it to talk to
 * Ark directly (single-turn only).
 */
export async function writeCodexConfig(
  config: AppConfig,
  modelBaseUrl: string = config.arkBaseUrl,
): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });

  const toml =
    config.modelProvider === "openai"
      ? openAiConfigToml(config)
      : arkConfigToml(config, modelBaseUrl);

  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Declares OpenAI as an explicit provider rather than relying on Codex's
 * built-in one.
 *
 * The built-in provider sets `requires_openai_auth`, which makes Codex look for
 * credentials written by `codex login` rather than reading an environment
 * variable. Inside a disposable container there is no login, so requests go out
 * unauthenticated and fail with 401 Missing bearer. Declaring the provider
 * ourselves points it at OPENAI_API_KEY instead.
 */
function openAiConfigToml(config: AppConfig): string {
  return [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.modelName || "gpt-5.1-codex"),
    'model_provider = "openai_api_key"',
    "",
    "[model_providers.openai_api_key]",
    'name = "OpenAI"',
    'base_url = "https://api.openai.com/v1"',
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
}

function arkConfigToml(config: AppConfig, modelBaseUrl: string): string {
  return [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.modelName || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    // Codex defaults web_search to "cached", which makes it send a tool spec
    // containing `external_web_access`. Ark's Responses API rejects that field
    // outright, so every turn fails with a BadRequest before the model does any
    // work. Disabling web search keeps the tool spec Ark-compatible.
    'web_search = "disabled"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(modelBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
}
