/**
 * Ollama adapter server 端入口
 */

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { getConfigSchema } from "./config-schema.js";
export { listOllamaModels, refreshOllamaModels, clearModelCache } from "./models.js";
export type { OllamaModelEntry } from "./models.js";
export {
  checkOllamaReachable,
  fetchOllamaModels,
  streamOllamaChat,
  callOllamaChat,
} from "./ollama-client.js";
export type {
  OllamaModelInfo,
  OllamaTagsResponse,
  OllamaChatMessage,
  OllamaChatRequest,
  OllamaChatStreamChunk,
  OllamaChatResponse,
  OllamaToolDefinition,
  OllamaToolCall,
} from "./ollama-client.js";
export { runAgentLoop } from "./agent-loop.js";
export type { AgentLoopOptions, AgentLoopResult } from "./agent-loop.js";
export { getPaperclipToolDefinitions, getToolEndpointMap } from "./tools/paperclip-tools.js";
export { executeToolCall } from "./tools/tool-executor.js";
export type { ToolExecutionResult, ToolExecutorOptions } from "./tools/tool-executor.js";
export { buildAgentLoopSystemPrompt, extractAgentLoopContext } from "./tools/system-prompt.js";
export type { AgentLoopContext } from "./tools/system-prompt.js";
