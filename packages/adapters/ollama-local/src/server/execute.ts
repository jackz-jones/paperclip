/**
 * Ollama adapter 执行逻辑
 * 通过 Ollama HTTP API 执行 agent 任务
 * 支持两种模式：Agent Loop（tool calling）和单次文本生成（向后兼容）
 */

import fs from "node:fs/promises";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_TIMEOUT_SEC,
} from "../index.js";
import {
  streamOllamaChat,
  checkOllamaReachable,
  type OllamaChatMessage,
  type OllamaChatRequest,
} from "./ollama-client.js";
import { runAgentLoop } from "./agent-loop.js";
import { getPaperclipToolDefinitions } from "./tools/paperclip-tools.js";
import {
  buildAgentLoopSystemPrompt,
  extractAgentLoopContext,
} from "./tools/system-prompt.js";

// ============ 默认配置 ============

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000;

// ============ 配置解析 ============

/**
 * 从 adapterConfig 中提取 Ollama 配置
 */
function resolveOllamaConfig(config: Record<string, unknown>) {
  const baseUrl =
    typeof config.baseUrl === "string" && config.baseUrl.trim()
      ? config.baseUrl.trim()
      : DEFAULT_OLLAMA_BASE_URL;
  const model =
    typeof config.model === "string" ? config.model.trim() : "";
  const systemPrompt =
    typeof config.systemPrompt === "string" ? config.systemPrompt.trim() : "";
  const temperature =
    typeof config.temperature === "number" ? config.temperature : undefined;
  const contextLength =
    typeof config.contextLength === "number" ? config.contextLength : undefined;
  const timeoutSec =
    typeof config.timeoutSec === "number" && config.timeoutSec > 0
      ? config.timeoutSec
      : DEFAULT_OLLAMA_TIMEOUT_SEC;
  const promptTemplate =
    typeof config.promptTemplate === "string" ? config.promptTemplate.trim() : "";
  const instructionsFilePath =
    typeof config.instructionsFilePath === "string" ? config.instructionsFilePath.trim() : "";

  // Agent Loop 相关配置
  const agentLoopEnabled =
    typeof config.agentLoopEnabled === "boolean" ? config.agentLoopEnabled : true;
  const maxTurns =
    typeof config.maxTurns === "number" && config.maxTurns > 0
      ? config.maxTurns
      : DEFAULT_MAX_TURNS;
  const toolCallTimeout =
    typeof config.toolCallTimeout === "number" && config.toolCallTimeout > 0
      ? config.toolCallTimeout * 1000 // 转换为毫秒
      : DEFAULT_TOOL_CALL_TIMEOUT_MS;

  return {
    baseUrl, model, systemPrompt, temperature, contextLength,
    timeoutSec, promptTemplate, instructionsFilePath,
    agentLoopEnabled, maxTurns, toolCallTimeout,
  };
}

// ============ Prompt 构建 ============

/**
 * 构建发送给 Ollama 的 prompt
 * 从 Paperclip 的 context 中提取任务信息，构建完整的 user prompt
 */
function buildPrompt(
  context: Record<string, unknown>,
  promptTemplate: string,
): string {
  // 如果有自定义 prompt 模板，使用模板
  if (promptTemplate) {
    let prompt = promptTemplate;
    for (const [key, value] of Object.entries(context)) {
      if (typeof value === "string") {
        prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
      }
    }
    return prompt;
  }

  const parts: string[] = [];

  // 1. 从 paperclipTaskMarkdown 中提取任务信息
  if (typeof context.paperclipTaskMarkdown === "string" && context.paperclipTaskMarkdown.trim()) {
    parts.push(context.paperclipTaskMarkdown.trim());
  }

  // 2. 从 paperclipWake 中提取 wake payload
  if (typeof context.paperclipWake === "object" && context.paperclipWake !== null) {
    const wake = context.paperclipWake as Record<string, unknown>;
    if (typeof wake.prompt === "string" && wake.prompt.trim()) {
      parts.push(wake.prompt.trim());
    }
    if (Array.isArray(wake.comments)) {
      for (const comment of wake.comments) {
        if (typeof comment === "object" && comment !== null) {
          const c = comment as Record<string, unknown>;
          if (typeof c.body === "string" && c.body.trim()) {
            parts.push(`Comment: ${c.body.trim()}`);
          }
        }
      }
    }
  }

  // 3. 从 paperclipWakeComment 中提取唤醒评论
  if (typeof context.paperclipWakeComment === "object" && context.paperclipWakeComment !== null) {
    const wakeComment = context.paperclipWakeComment as Record<string, unknown>;
    if (typeof wakeComment.body === "string" && wakeComment.body.trim()) {
      parts.push(`Wake comment: ${wakeComment.body.trim()}`);
    }
  }

  // 4. 从 paperclipContinuationSummary 中提取续接摘要
  if (typeof context.paperclipContinuationSummary === "object" && context.paperclipContinuationSummary !== null) {
    const summary = context.paperclipContinuationSummary as Record<string, unknown>;
    if (typeof summary.body === "string" && summary.body.trim()) {
      parts.push(`Previous work summary:\n${summary.body.trim()}`);
    }
  }

  // 5. 如果有 handoff instruction
  if (typeof context.instruction === "string" && context.instruction.trim()) {
    parts.push(context.instruction.trim());
  }

  // 6. fallback: 直接使用 context.prompt
  if (parts.length === 0 && typeof context.prompt === "string" && context.prompt.trim()) {
    parts.push(context.prompt.trim());
  }

  if (parts.length === 0) {
    return "Please provide a response based on the given context.";
  }

  return parts.join("\n\n");
}

// ============ Disposition 解析 ============

/**
 * 从模型输出中解析 disposition 标记
 */
function parseDisposition(output: string): { status: string; summary: string } {
  const text = output.trim();
  const lines = text.split("\n");
  const lastLines = lines.slice(-10).join("\n");

  if (/\[BLOCKED\]/i.test(lastLines)) {
    return { status: "blocked", summary: text };
  }
  if (/\[CANCELLED?\]/i.test(lastLines)) {
    return { status: "cancelled", summary: text };
  }

  return { status: "done", summary: text };
}

// ============ 主执行函数 ============

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { config, context, onLog, authToken, runId } = ctx;

  const ollamaConfig = resolveOllamaConfig(config);

  // 验证 model 是否配置
  if (!ollamaConfig.model) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        "Ollama adapter 必须指定 model 配置项。请在 agent 配置中设置 model 字段（例如 'llama3.3'、'codellama'）。",
    };
  }

  // 检查 Ollama 服务可达性
  const reachable = await checkOllamaReachable(ollamaConfig.baseUrl);
  if (!reachable) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Ollama 服务不可达 (${ollamaConfig.baseUrl})。请确保 Ollama 已启动：运行 \`ollama serve\` 或检查服务地址配置。`,
    };
  }

  // 判断是否走 Agent Loop 路径
  // 注意：即使没有 authToken 也可以进入 Agent Loop（tool executor 会尝试无认证调用）
  const shouldUseAgentLoop = ollamaConfig.agentLoopEnabled;

  if (shouldUseAgentLoop) {
    return executeAgentLoop(ctx, ollamaConfig);
  } else {
    return executeTextGeneration(ctx, ollamaConfig);
  }
}

// ============ Agent Loop 执行路径 ============

async function executeAgentLoop(
  ctx: AdapterExecutionContext,
  ollamaConfig: ReturnType<typeof resolveOllamaConfig>,
): Promise<AdapterExecutionResult> {
  const { config, context, onLog, authToken, runId, agent } = ctx;

  await onLog("stdout", `[ollama] Agent Loop mode (maxTurns: ${ollamaConfig.maxTurns})\n`);
  await onLog("stdout", `[ollama] 使用模型: ${ollamaConfig.model}\n`);
  await onLog("stdout", `[ollama] 服务地址: ${ollamaConfig.baseUrl}\n`);
  await onLog("stdout", `[ollama] Agent: ${agent.name} (${agent.id}), Company: ${agent.companyId}\n`);
  if (!authToken) {
    await onLog("stderr", `[ollama] WARNING: No authToken available. Tool calls to Paperclip API may fail. Set PAPERCLIP_AGENT_JWT_SECRET or BETTER_AUTH_SECRET env var.\n`);
  }

  // 读取 instructions 文件内容
  let instructionsContent = "";
  if (ollamaConfig.instructionsFilePath) {
    try {
      instructionsContent = await fs.readFile(ollamaConfig.instructionsFilePath, "utf8");
    } catch (err) {
      await onLog("stderr", `[ollama] 无法读取 instructions 文件: ${ollamaConfig.instructionsFilePath} (${err instanceof Error ? err.message : String(err)})\n`);
    }
  }

  // 构建 Agent Loop system prompt
  // 将 agent 信息和 ollamaConfig 中的 model 和 baseUrl 信息合并，供 extractAgentLoopContext 使用
  const contextWithAgent = {
    ...context,
    agentId: agent.id,
    companyId: agent.companyId,
    agentName: agent.name,
  };
  const configWithAdapter = {
    ...config,
    adapterType: "ollama_local",
    model: ollamaConfig.model,
    baseUrl: ollamaConfig.baseUrl,
  };
  const agentContext = extractAgentLoopContext(contextWithAgent, configWithAdapter);
  const customPrompt = instructionsContent || ollamaConfig.systemPrompt || undefined;
  const systemPrompt = buildAgentLoopSystemPrompt(agentContext, customPrompt);

  // 构建 user message
  const userPrompt = buildPrompt(context, ollamaConfig.promptTemplate);

  // 构建初始消息列表
  const messages: OllamaChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // 获取 tools 定义
  const tools = getPaperclipToolDefinitions();

  // 确定 API base URL（用于 tool executor 调用 Paperclip API）
  // 从 context 中获取 Paperclip API URL，或使用默认值
  const paperclipApiUrl =
    (typeof context.paperclipApiUrl === "string" && context.paperclipApiUrl.trim())
      ? context.paperclipApiUrl.trim()
      : (typeof config.paperclipApiUrl === "string" && config.paperclipApiUrl.trim())
        ? config.paperclipApiUrl.trim()
        : `http://localhost:${process.env.PORT || "3100"}`;

  // 设置超时
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abortController.abort();
  }, ollamaConfig.timeoutSec * 1000);

  try {
    const loopResult = await runAgentLoop({
      model: ollamaConfig.model,
      baseUrl: ollamaConfig.baseUrl,
      messages,
      tools,
      toolExecutorOptions: {
        authToken: authToken || "",
        apiBaseUrl: paperclipApiUrl,
        runId: runId || "unknown",
        timeoutMs: ollamaConfig.toolCallTimeout,
        agentId: agent.id,
        companyId: agent.companyId,
      },
      maxTurns: ollamaConfig.maxTurns,
      modelOptions: {
        temperature: ollamaConfig.temperature,
        num_ctx: ollamaConfig.contextLength,
      },
      onLog,
      abortSignal: abortController.signal,
    });

    clearTimeout(timeoutHandle);

    // 如果模型不支持 tool calling，退回单次生成模式
    if (loopResult.fallbackToTextMode) {
      await onLog("stdout", `[ollama] Falling back to text generation mode\n`);
      // 使用 Agent Loop 返回的文本输出作为结果
      return buildTextResult(loopResult.output, ollamaConfig.model, loopResult.usage);
    }

    // 确定 disposition
    let disposition = loopResult.inferredDisposition;
    if (!disposition) {
      // 从文本输出中解析
      const parsed = parseDisposition(loopResult.output);
      disposition = parsed.status;
    }

    // 截取摘要
    const summaryText = loopResult.output.length > 500
      ? loopResult.output.slice(0, 497) + "..."
      : loopResult.output;

    const result: AdapterExecutionResult = {
      exitCode: loopResult.error ? 1 : 0,
      signal: null,
      timedOut: false,
      provider: "ollama",
      model: ollamaConfig.model,
      billingType: "unknown",
      costUsd: 0,
      summary: summaryText || null,
      resultJson: {
        stdout: loopResult.output,
        summary: summaryText || undefined,
        issueDisposition: disposition,
        agentLoop: {
          totalTurns: loopResult.totalTurns,
          totalToolCalls: loopResult.totalToolCalls,
          maxTurnsReached: loopResult.maxTurnsReached,
        },
      },
    };

    if (loopResult.usage.inputTokens > 0 || loopResult.usage.outputTokens > 0) {
      result.usage = loopResult.usage;
    }

    if (loopResult.error) {
      result.errorMessage = loopResult.error;
    }

    return result;
  } catch (error) {
    clearTimeout(timeoutHandle);

    if (error instanceof Error && (error.name === "AbortError" || error.message.includes("abort"))) {
      return {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        errorMessage: `Ollama Agent Loop 超时 (${ollamaConfig.timeoutSec}s)`,
        provider: "ollama",
        model: ollamaConfig.model,
        costUsd: 0,
        resultJson: {
          issueDisposition: "done",
        },
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Ollama Agent Loop 错误: ${errorMessage}`,
      provider: "ollama",
      model: ollamaConfig.model,
      costUsd: 0,
      resultJson: {
        issueDisposition: "done",
      },
    };
  }
}

// ============ 单次文本生成执行路径（向后兼容） ============

async function executeTextGeneration(
  ctx: AdapterExecutionContext,
  ollamaConfig: ReturnType<typeof resolveOllamaConfig>,
): Promise<AdapterExecutionResult> {
  const { context, onLog } = ctx;

  // 读取 instructions 文件内容作为 system prompt
  let instructionsContent = "";
  if (ollamaConfig.instructionsFilePath) {
    try {
      instructionsContent = await fs.readFile(ollamaConfig.instructionsFilePath, "utf8");
    } catch (err) {
      await onLog("stderr", `[ollama] 无法读取 instructions 文件: ${ollamaConfig.instructionsFilePath} (${err instanceof Error ? err.message : String(err)})\n`);
    }
  }

  // 构建消息
  const prompt = buildPrompt(context, ollamaConfig.promptTemplate);
  const messages: OllamaChatMessage[] = [];

  let effectiveSystemPrompt = instructionsContent || ollamaConfig.systemPrompt;

  // 添加 disposition 指令
  const dispositionInstruction = [
    "",
    "---",
    "IMPORTANT: You are a text-generation assistant. Complete the task to the best of your ability in a single response.",
    "At the very end of your response, include one of these markers on its own line:",
    "- [DONE] — task completed (default, use this in most cases)",
    "- [BLOCKED] — you cannot proceed without external information or access",
    "If unsure, use [DONE].",
  ].join("\n");

  if (effectiveSystemPrompt) {
    effectiveSystemPrompt += dispositionInstruction;
  } else {
    effectiveSystemPrompt = dispositionInstruction.trim();
  }

  if (effectiveSystemPrompt) {
    messages.push({ role: "system", content: effectiveSystemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  // 构建请求
  const request: OllamaChatRequest = {
    model: ollamaConfig.model,
    messages,
    options: {},
  };

  if (ollamaConfig.temperature !== undefined) {
    request.options!.temperature = ollamaConfig.temperature;
  }
  if (ollamaConfig.contextLength !== undefined) {
    request.options!.num_ctx = ollamaConfig.contextLength;
  }

  // 设置超时
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abortController.abort();
  }, ollamaConfig.timeoutSec * 1000);

  let fullResponse = "";
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    await onLog("stdout", `[ollama] Text generation mode\n`);
    await onLog("stdout", `[ollama] 使用模型: ${ollamaConfig.model}\n`);
    await onLog("stdout", `[ollama] 服务地址: ${ollamaConfig.baseUrl}\n`);

    const stream = streamOllamaChat(
      request,
      ollamaConfig.baseUrl,
      abortController.signal,
    );

    for await (const chunk of stream) {
      if (chunk.message?.content) {
        fullResponse += chunk.message.content;
        await onLog("stdout", chunk.message.content);
      }

      if (chunk.done) {
        if (chunk.prompt_eval_count) {
          inputTokens = chunk.prompt_eval_count;
        }
        if (chunk.eval_count) {
          outputTokens = chunk.eval_count;
        }
      }
    }

    if (fullResponse && !fullResponse.endsWith("\n")) {
      await onLog("stdout", "\n");
    }

    clearTimeout(timeoutHandle);

    return buildTextResult(fullResponse, ollamaConfig.model, { inputTokens, outputTokens });
  } catch (error) {
    clearTimeout(timeoutHandle);

    if (error instanceof Error && (error.name === "AbortError" || error.message.includes("abort"))) {
      return {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        errorMessage: `Ollama 请求超时 (${ollamaConfig.timeoutSec}s)`,
        provider: "ollama",
        model: ollamaConfig.model,
        costUsd: 0,
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Ollama 执行错误: ${errorMessage}`,
      provider: "ollama",
      model: ollamaConfig.model,
      costUsd: 0,
    };
  }
}

// ============ 辅助函数 ============

function buildTextResult(
  fullResponse: string,
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): AdapterExecutionResult {
  const disposition = parseDisposition(fullResponse);
  const summaryText = disposition.summary.length > 500
    ? disposition.summary.slice(0, 497) + "..."
    : disposition.summary;

  const result: AdapterExecutionResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "ollama",
    model,
    billingType: "unknown",
    costUsd: 0,
    summary: summaryText || null,
    resultJson: {
      stdout: fullResponse,
      summary: summaryText || undefined,
      issueDisposition: disposition.status,
    },
  };

  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    result.usage = usage;
  }

  return result;
}