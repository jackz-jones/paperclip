import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_TIMEOUT_SEC,
} from "../index.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        default: DEFAULT_OLLAMA_BASE_URL,
        hint: "Ollama API 服务地址，默认 http://localhost:11434",
      },
      {
        key: "systemPrompt",
        label: "System prompt",
        type: "textarea",
        hint: "可选的系统提示词，会作为 system message 发送给模型",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        hint: "生成温度，留空使用模型默认值",
      },
      {
        key: "contextLength",
        label: "Context length",
        type: "number",
        hint: "上下文窗口大小（num_ctx），留空使用模型默认值",
      },
      {
        key: "timeoutSec",
        label: "Timeout (seconds)",
        type: "number",
        default: DEFAULT_OLLAMA_TIMEOUT_SEC,
        hint: "请求超时时间（秒），默认 900（15 分钟，适合本地大模型多轮对话）",
      },
      {
        key: "agentLoopEnabled",
        label: "Agent Loop",
        type: "toggle",
        default: true,
        hint: "启用 Agent Loop（tool calling 多轮对话），需要模型支持 tool calling（如 llama3.1+、qwen2.5+）",
      },
      {
        key: "maxTurns",
        label: "Max turns",
        type: "number",
        default: 20,
        hint: "Agent Loop 最大轮次，默认 20",
      },
      {
        key: "toolCallTimeout",
        label: "Tool call timeout (seconds)",
        type: "number",
        default: 30,
        hint: "单次 tool call 执行超时时间（秒），默认 30",
      },
    ],
  };
}
