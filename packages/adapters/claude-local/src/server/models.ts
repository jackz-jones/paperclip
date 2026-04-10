import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as DIRECT_MODELS } from "../index.js";

/** AWS Bedrock model IDs — region-qualified identifiers required by the Bedrock API. */
const BEDROCK_MODELS: AdapterModel[] = [
  { id: "us.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
  { id: "us.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Bedrock Sonnet 4.5" },
  { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
];

function isBedrockEnv(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (typeof process.env.ANTHROPIC_BEDROCK_BASE_URL === "string" &&
      process.env.ANTHROPIC_BEDROCK_BASE_URL.trim().length > 0)
  );
}

function isCustomModelEnv(): boolean {
  return (
    (typeof process.env.ANTHROPIC_BASE_URL === "string" &&
      process.env.ANTHROPIC_BASE_URL.trim().length > 0) ||
    (typeof process.env.ANTHROPIC_AUTH_TOKEN === "string" &&
      process.env.ANTHROPIC_AUTH_TOKEN.trim().length > 0)
  );
}

function isOfficialModelEnv(): boolean {
  return typeof process.env.ANTHROPIC_API_KEY === "string" &&
    process.env.ANTHROPIC_API_KEY.trim().length > 0;
}

/**
 * Return the model list appropriate for the current auth mode.
 * When Bedrock env vars are detected, returns Bedrock-native model IDs;
 * when custom model env vars are detected, returns custom model IDs;
 * when official API key is set, returns standard Anthropic API model IDs;
 * otherwise returns standard Anthropic API model IDs.
 */
export async function listClaudeModels(): Promise<AdapterModel[]> {
  if (isBedrockEnv()) return BEDROCK_MODELS;
  if (isCustomModelEnv()) {
    // For custom models, return all models including custom ones
    return DIRECT_MODELS;
  }
  if (isOfficialModelEnv()) {
    // For official API, return only standard models (filter out custom models)
    return DIRECT_MODELS.filter(model => !model.id.includes(":") && !model.id.startsWith("ollama:"));
  }
  // Default: return all models
  return DIRECT_MODELS;
}

/** Check whether a model ID is a Bedrock-native identifier (not an Anthropic API short name). */
/** Bedrock model IDs use region-qualified prefixes (e.g. us.anthropic.*, eu.anthropic.*) or ARNs. */
export function isBedrockModelId(model: string): boolean {
  return /^\w+\.anthropic\./.test(model) || model.startsWith("arn:aws:bedrock:");
}