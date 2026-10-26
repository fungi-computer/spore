import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const providerCredentialEnvironment = [
  "AI_GATEWAY_API_KEY",
  "ANT_LING_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONFIG_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_SESSION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AZURE_OPENAI_API_KEY",
  "BASETEN_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GCLOUD_PROJECT",
  "GEMINI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_API_KEY",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "META_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "RADIUS_API_KEY",
  "TOGETHER_API_KEY",
  "TYPESAFE_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
] as const;
const providerCredentialEnvironmentNames = new Set<string>(
  providerCredentialEnvironment,
);

function withoutProviderCredentials(environment: NodeJS.ProcessEnv) {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!providerCredentialEnvironmentNames.has(name)) sanitized[name] = value;
  }
  return sanitized;
}

export async function createIsolatedCliEnvironment() {
  const home = await mkdtemp(join(tmpdir(), "fungi-cli-test-home-"));
  let runtime: string;
  try {
    runtime = await mkdtemp(join(tmpdir(), "fungi-cli-test-runtime-"));
    await chmod(runtime, 0o700);
  } catch (cause) {
    await rm(home, { recursive: true, force: true });
    throw cause;
  }

  const env = withoutProviderCredentials({
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_RUNTIME_DIR: runtime,
  });

  return {
    home,
    runtime,
    env,
    environment(overrides: NodeJS.ProcessEnv = {}) {
      return withoutProviderCredentials({ ...env, ...overrides });
    },
    async cleanup() {
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(runtime, { recursive: true, force: true }),
      ]);
    },
  };
}
