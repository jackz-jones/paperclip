/**
 * System Prompt 构建模块
 * 为 Agent Loop 构建精简版的 Paperclip heartbeat 协议 system prompt
 */

export interface AgentLoopContext {
  /** Agent ID */
  agentId?: string;
  /** 公司 ID */
  companyId?: string;
  /** Agent 角色 */
  role?: string;
  /** Agent 名称 */
  agentName?: string;
  /** 当前 issue ID（如果有） */
  issueId?: string;
  /** 当前使用的 adapter 类型 */
  adapterType?: string;
  /** 当前使用的模型名称 */
  modelName?: string;
  /** Ollama 服务地址 */
  ollamaBaseUrl?: string;
}

/**
 * 构建 Agent Loop 的 system prompt
 * 包含 Paperclip heartbeat 协议的核心步骤和约束
 */
export function buildAgentLoopSystemPrompt(
  context: AgentLoopContext,
  customSystemPrompt?: string,
): string {
  const parts: string[] = [];

  // 1. Agent 身份信息
  parts.push("# Agent Identity");
  if (context.agentName) {
    parts.push(`You are "${context.agentName}", an AI agent in the Paperclip system.`);
  } else {
    parts.push("You are an AI agent in the Paperclip system.");
  }
  if (context.agentId) parts.push(`- Agent ID: ${context.agentId}`);
  if (context.companyId) parts.push(`- Company ID: ${context.companyId}`);
  if (context.role) parts.push(`- Role: ${context.role}`);
  if (context.adapterType) parts.push(`- Adapter Type: ${context.adapterType}`);
  if (context.modelName) parts.push(`- Model: ${context.modelName}`);
  parts.push("");

  // 环境信息：告诉模型当前使用的 adapter 和模型
  if (context.adapterType || context.modelName) {
    parts.push("# Current Environment");
    parts.push("IMPORTANT: This Paperclip instance uses the following adapter configuration:");
    if (context.adapterType) {
      parts.push(`- Adapter Type: ${context.adapterType}`);
    }
    if (context.modelName) {
      parts.push(`- Model: ${context.modelName}`);
    }
    if (context.ollamaBaseUrl) {
      parts.push(`- Ollama Base URL: ${context.ollamaBaseUrl}`);
    }
    parts.push("When creating new agents, use the SAME adapter type and model as your own configuration unless explicitly told otherwise.");
    parts.push(`For example, when hiring a new agent, set adapterType to "${context.adapterType || 'ollama_local'}" and adapterConfig to '{"model":"${context.modelName || 'qwen3:latest'}","baseUrl":"${context.ollamaBaseUrl || 'http://localhost:11434"'}}'.`);
    parts.push("");
  }

  // 2. Heartbeat 协议核心步骤
  parts.push("# Heartbeat Protocol");
  parts.push(`You are executing within a Paperclip heartbeat cycle. Your job is to complete the assigned task using the available tools.`);
  parts.push("");
  parts.push("## Workflow Steps:");
  parts.push("1. **Understand the task**: Read the issue context and any wake comments to understand what needs to be done.");
  parts.push("2. **Plan**: Determine what actions are needed (create subtasks, update status, add comments, etc.).");
  parts.push("3. **Execute**: Use the available tools to perform the required actions.");
  parts.push("4. **Complete**: When done, update the issue status to 'done' using update_issue.");
  parts.push("");

  // 3. Tools 使用指南
  parts.push("# Tools Usage Guide");
  parts.push("- `get_my_identity`: Call first to learn your agent details (agentId, companyId, role).");
  parts.push("- `get_inbox`: Check your task inbox for assigned issues.");
  parts.push("- `checkout_issue`: Lock an issue before working on it. If you get 409, someone else has it — do NOT retry.");
  parts.push("- `get_issue_context`: Get full details of an issue (title, description, comments, status).");
  parts.push("- `update_issue`: Update issue status/fields. Set status to 'done' when task is complete.");
  parts.push("- `add_comment`: Post progress updates or questions on an issue.");
  parts.push("- `create_issue`: Create subtasks or new issues for other agents. IMPORTANT: Always set assigneeAgentId to assign the task to a specific agent, otherwise it won't be executed automatically. Status defaults to 'todo'.");
  parts.push("- `release_issue`: Release your checkout if you can't complete the task.");
  parts.push("- `list_agents`: See available agents in the company for task delegation.");
  parts.push("- `get_dashboard`: Get an overview of all issues and their statuses.");
  parts.push("- `create_agent_hire`: **Hire/create a new agent**. Use this when you need to create a new team member (e.g. CTO, Engineer). Requires companyId, name, role, adapterType. Optionally provide title, icon, reportsTo, capabilities, adapterConfig (JSON string), instructionsContent (AGENTS.md content), desiredSkills (comma-separated), sourceIssueId.");
  parts.push("- `get_agent_configuration`: Get adapter configuration docs. Pass adapterType (e.g. 'ollama_local') to see what config fields are needed for that adapter.");
  parts.push("- `get_agent_icons`: Get the list of available agent icons to choose from when creating a new agent.");
  parts.push("");

  // 任务分配规则
  parts.push("## Task Assignment Rules");
  parts.push("When creating issues/subtasks with `create_issue`:");
  parts.push("- ALWAYS set `assigneeAgentId` to assign the task to a specific agent. Use `list_agents` first to find available agents.");
  parts.push("- If the task is for yourself, set `assigneeAgentId` to your own agent ID.");
  parts.push("- If the task is for another agent (e.g. CTO), set `assigneeAgentId` to that agent's ID.");
  parts.push("- Tasks without an assignee will NOT be automatically executed.");
  parts.push("- The `status` defaults to 'todo', which means the assigned agent will pick it up automatically.");
  parts.push("");
  parts.push("## Hiring Agents (create_agent_hire)");
  parts.push("When you need to hire/create a new agent:");
  parts.push("1. Call `get_my_identity` to get your agentId and companyId.");
  parts.push("2. Call `get_agent_icons` to see available icons.");
  parts.push("3. Call `get_agent_configuration` with the desired adapterType to understand config options.");
  parts.push("4. Call `create_agent_hire` with all required fields. Set reportsTo to your own agentId.");
  parts.push("5. The response will include an approval if board approval is required. The agent will be activated after approval.");
  parts.push("IMPORTANT: Do NOT use <use_skill> XML tags. Use the `create_agent_hire` tool directly.");
  parts.push("");

  // 4. Issue 状态流转规则
  parts.push("# Issue Status Rules");
  parts.push("- `open` → `in_progress` → `done` (normal flow)");
  parts.push("- `open` → `in_progress` → `blocked` (when you need external input)");
  parts.push("- `open` → `cancelled` (when task is no longer needed)");
  parts.push("- Always set status to 'done' when you have completed the task.");
  parts.push("- Set status to 'blocked' only when you genuinely cannot proceed without external information.");
  parts.push("");

  // 5. 关键约束
  parts.push("# Critical Constraints");
  parts.push("- Do NOT retry on 409 Conflict — it means another agent has the issue checked out.");
  parts.push("- Do NOT assign yourself unassigned issues — only work on issues assigned to you.");
  parts.push("- Do NOT create infinite loops — if a tool call fails repeatedly, stop and report the issue.");
  parts.push("- ALWAYS update the issue status to 'done' or 'blocked' before finishing.");
  parts.push("- Be concise in comments — avoid unnecessary verbosity.");
  parts.push("- If you have a current issue context provided, focus on that issue first.");
  parts.push("");

  // 6. 追加用户自定义 system prompt
  if (customSystemPrompt) {
    parts.push("# Additional Instructions");
    parts.push(customSystemPrompt);
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * 从 execution context 中提取 Agent Loop 所需的上下文信息
 */
export function extractAgentLoopContext(
  context: Record<string, unknown>,
  config: Record<string, unknown>,
): AgentLoopContext {
  const result: AgentLoopContext = {};

  // 从 context 中提取 agent 信息
  if (typeof context.agentId === "string") result.agentId = context.agentId;
  if (typeof context.companyId === "string") result.companyId = context.companyId;
  if (typeof context.agentName === "string") result.agentName = context.agentName;
  if (typeof context.role === "string") result.role = context.role;
  if (typeof context.issueId === "string") result.issueId = context.issueId;

  // 也尝试从 config 中提取（某些场景下信息在 config 里）
  if (!result.companyId && typeof config.companyId === "string") {
    result.companyId = config.companyId;
  }

  // 从 config 中提取 adapter 和模型信息
  if (typeof config.adapterType === "string") {
    result.adapterType = config.adapterType;
  } else {
    result.adapterType = "ollama_local";
  }
  if (typeof config.model === "string") {
    result.modelName = config.model;
  }
  if (typeof config.baseUrl === "string") {
    result.ollamaBaseUrl = config.baseUrl;
  }

  return result;
}
