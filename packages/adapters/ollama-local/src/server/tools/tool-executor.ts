/**
 * Tool 执行代理（HTTP Proxy）
 * 将模型的 tool call 转换为实际的 Paperclip API 调用
 */

import { getToolEndpointMap } from "./paperclip-tools.js";

export interface ToolExecutionResult {
  success: boolean;
  data: unknown;
  status?: number;
  duration: number;
}

export interface ToolExecutorOptions {
  authToken: string;
  apiBaseUrl: string;
  runId: string;
  timeoutMs: number;
  /** 当前 agent 的 ID（用于自动注入） */
  agentId?: string;
  /** 当前 agent 的 companyId（用于自动注入，确保使用正确的 UUID） */
  companyId?: string;
}

/**
 * 执行单个 tool call
 * 将 tool name 和参数路由到对应的 Paperclip API endpoint
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  options: ToolExecutorOptions,
): Promise<ToolExecutionResult> {
  const startTime = Date.now();
  const { authToken, apiBaseUrl, runId, timeoutMs } = options;

  // 检查 tool 是否存在
  const endpointMap = getToolEndpointMap();
  const endpoint = endpointMap[toolName];

  if (!endpoint) {
    return {
      success: false,
      data: { error: `Unknown tool: "${toolName}". Available tools: ${Object.keys(endpointMap).join(", ")}` },
      duration: Date.now() - startTime,
    };
  }

  // 自动注入 companyId（如果 tool 需要 companyId 但模型传了无效值）
  const needsCompanyId = ["create_issue", "list_agents", "get_dashboard", "create_agent_hire"];
  if (needsCompanyId.includes(toolName) && options.companyId) {
    // 如果模型传的 companyId 不是有效的 UUID 格式，用正确的值替换
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!args.companyId || typeof args.companyId !== "string" || !uuidRegex.test(args.companyId)) {
      args = { ...args, companyId: options.companyId };
    }
  }

  // 参数验证
  const validationError = validateToolArgs(toolName, args);
  if (validationError) {
    return {
      success: false,
      data: { error: validationError },
      duration: Date.now() - startTime,
    };
  }

  // 对特殊 tool 进行参数预处理
  const processedArgs = preprocessToolArgs(toolName, args);

  // 构建请求 URL（替换路径模板中的参数）
  let path = endpoint.pathTemplate;
  for (const [key, value] of Object.entries(processedArgs)) {
    if (typeof value === "string") {
      path = path.replace(`{${key}}`, encodeURIComponent(value));
    }
  }

  // get_agent_configuration 特殊处理：如果没有 adapterType 参数，使用总览端点
  if (toolName === "get_agent_configuration" && !processedArgs.adapterType) {
    path = "/llms/agent-configuration.txt";
  }

  const url = `${apiBaseUrl}${path}`;

  // 构建请求体（仅对有 bodyFields 的 endpoint）
  let body: string | undefined;
  if (endpoint.bodyFields && endpoint.bodyFields.length > 0) {
    const bodyObj: Record<string, unknown> = {};
    for (const field of endpoint.bodyFields) {
      if (processedArgs[field] !== undefined) {
        bodyObj[field] = processedArgs[field];
      }
    }
    body = JSON.stringify(bodyObj);
  }

  // 设置超时
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: endpoint.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        "X-Paperclip-Run-Id": runId,
      },
      body: endpoint.method !== "GET" ? body : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const duration = Date.now() - startTime;

    if (response.ok) {
      // 尝试解析 JSON 响应
      let data: unknown;
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        data = await response.json();
      } else {
        const text = await response.text();
        data = text || { ok: true };
      }

      return { success: true, data, status: response.status, duration };
    } else {
      // API 调用失败，返回错误信息
      let errorData: unknown;
      try {
        errorData = await response.json();
      } catch {
        errorData = await response.text().catch(() => "Unknown error");
      }

      return {
        success: false,
        data: {
          error: `API returned ${response.status} ${response.statusText}`,
          details: errorData,
        },
        status: response.status,
        duration,
      };
    }
  } catch (error) {
    clearTimeout(timeout);
    const duration = Date.now() - startTime;

    // 判断是否超时
    if (error instanceof Error && (error.name === "AbortError" || error.message.includes("abort"))) {
      return {
        success: false,
        data: { error: `Tool call timed out after ${timeoutMs}ms` },
        duration,
      };
    }

    // 其他网络错误
    return {
      success: false,
      data: {
        error: `Network error: ${error instanceof Error ? error.message : String(error)}`,
      },
      duration,
    };
  }
}

/**
 * 对特殊 tool 的参数进行预处理
 * 将模型输出的简化参数转换为 API 需要的格式
 */
function preprocessToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // create_issue 默认 status 为 "todo"（而非服务端默认的 "backlog"）
  if (toolName === "create_issue") {
    const processed = { ...args };
    if (!processed.status) {
      processed.status = "todo";
    }
    return processed;
  }

  if (toolName !== "create_agent_hire") {
    return args;
  }

  // create_agent_hire 特殊处理
  const processed: Record<string, unknown> = { ...args };

  // 1. adapterConfig: JSON 字符串 → 对象
  if (typeof processed.adapterConfig === "string") {
    try {
      processed.adapterConfig = JSON.parse(processed.adapterConfig as string);
    } catch {
      // 如果解析失败，使用空对象
      processed.adapterConfig = {};
    }
  } else if (!processed.adapterConfig) {
    processed.adapterConfig = {};
  }

  // 2. instructionsContent → instructionsBundle 格式
  if (typeof processed.instructionsContent === "string" && (processed.instructionsContent as string).trim()) {
    processed.instructionsBundle = {
      files: {
        "AGENTS.md": processed.instructionsContent,
      },
    };
    delete processed.instructionsContent;
  }

  // 3. desiredSkills: 逗号分隔字符串 → 数组
  if (typeof processed.desiredSkills === "string") {
    const skills = (processed.desiredSkills as string)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    processed.desiredSkills = skills.length > 0 ? skills : undefined;
  }

  // 4. 添加默认 runtimeConfig（heartbeat 默认启用，支持按需唤醒）
  if (!processed.runtimeConfig) {
    processed.runtimeConfig = {
      heartbeat: {
        enabled: true,
        wakeOnDemand: true,
      },
    };
  }

  return processed;
}

/**
 * 验证 tool call 参数
 * 返回错误信息字符串，如果验证通过返回 null
 */
function validateToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  // 需要 issueId 的 tools
  const needsIssueId = [
    "checkout_issue",
    "get_issue_context",
    "update_issue",
    "add_comment",
    "release_issue",
  ];

  if (needsIssueId.includes(toolName)) {
    if (!args.issueId || typeof args.issueId !== "string" || !args.issueId.trim()) {
      return `Tool "${toolName}" requires a non-empty "issueId" parameter`;
    }
  }

  // 需要 companyId 的 tools
  const needsCompanyId = ["create_issue", "list_agents", "get_dashboard", "create_agent_hire"];

  if (needsCompanyId.includes(toolName)) {
    if (!args.companyId || typeof args.companyId !== "string" || !args.companyId.trim()) {
      return `Tool "${toolName}" requires a non-empty "companyId" parameter`;
    }
  }

  // create_issue 需要 title
  if (toolName === "create_issue") {
    if (!args.title || typeof args.title !== "string" || !args.title.trim()) {
      return `Tool "create_issue" requires a non-empty "title" parameter`;
    }
  }

  // create_agent_hire 需要 name、role、adapterType
  if (toolName === "create_agent_hire") {
    if (!args.name || typeof args.name !== "string" || !args.name.trim()) {
      return `Tool "create_agent_hire" requires a non-empty "name" parameter`;
    }
    if (!args.role || typeof args.role !== "string" || !args.role.trim()) {
      return `Tool "create_agent_hire" requires a non-empty "role" parameter`;
    }
    if (!args.adapterType || typeof args.adapterType !== "string" || !args.adapterType.trim()) {
      return `Tool "create_agent_hire" requires a non-empty "adapterType" parameter`;
    }
  }

  // add_comment 需要 body
  if (toolName === "add_comment") {
    if (!args.body || typeof args.body !== "string" || !args.body.trim()) {
      return `Tool "add_comment" requires a non-empty "body" parameter`;
    }
  }

  return null;
}
