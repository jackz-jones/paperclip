/**
 * Paperclip Tools 定义模块
 * 将 Paperclip 核心 API 操作封装为 Ollama tool calling 格式的 tools
 */

import type { OllamaToolDefinition } from "../ollama-client.js";

/**
 * 获取所有 Paperclip API tools 定义
 * 返回 Ollama tools 参数格式的数组
 */
export function getPaperclipToolDefinitions(): OllamaToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "get_my_identity",
        description:
          "获取当前 agent 的身份信息，包括 agentId、name、role、companyId 等。在开始工作前调用此工具了解自己的身份。",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_inbox",
        description:
          "获取当前 agent 的任务收件箱，返回分配给你的 issue 列表。用于了解有哪些待处理的任务。",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "checkout_issue",
        description:
          "签出（checkout）一个 issue 开始工作。签出后你将获得该 issue 的独占工作权。如果返回 409 表示已被其他 agent 签出，不要重试。",
        parameters: {
          type: "object",
          properties: {
            issueId: {
              type: "string",
              description: "要签出的 issue ID",
            },
          },
          required: ["issueId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_issue_context",
        description:
          "获取 issue 的详细上下文信息，包括标题、描述、评论、状态等。用于理解任务内容和当前进度。",
        parameters: {
          type: "object",
          properties: {
            issueId: {
              type: "string",
              description: "要获取上下文的 issue ID",
            },
          },
          required: ["issueId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_issue",
        description:
          "更新 issue 的状态或字段。可以更新 status（如 'done'、'blocked'、'in_progress'）、title、description 等。完成任务后必须将 status 设为 'done'。",
        parameters: {
          type: "object",
          properties: {
            issueId: {
              type: "string",
              description: "要更新的 issue ID",
            },
            status: {
              type: "string",
              description: "新的 issue 状态",
              enum: ["open", "in_progress", "done", "blocked", "cancelled"],
            },
            title: {
              type: "string",
              description: "新的 issue 标题（可选）",
            },
            description: {
              type: "string",
              description: "新的 issue 描述（可选）",
            },
          },
          required: ["issueId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_comment",
        description:
          "在 issue 上发表评论。用于记录工作进度、提出问题、或与其他 agent 沟通。",
        parameters: {
          type: "object",
          properties: {
            issueId: {
              type: "string",
              description: "要评论的 issue ID",
            },
            body: {
              type: "string",
              description: "评论内容（支持 Markdown）",
            },
          },
          required: ["issueId", "body"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_issue",
        description:
          "创建新的 issue（子任务）。用于将复杂任务分解为更小的子任务，或创建需要其他 agent 处理的任务。创建后 issue 默认为 'todo' 状态，会被分配的 agent 自动拾取执行。",
        parameters: {
          type: "object",
          properties: {
            companyId: {
              type: "string",
              description: "公司 ID",
            },
            title: {
              type: "string",
              description: "新 issue 的标题",
            },
            description: {
              type: "string",
              description: "新 issue 的描述",
            },
            status: {
              type: "string",
              description: "issue 的初始状态。默认为 'todo'，表示待执行。设为 'backlog' 表示暂不执行。",
              enum: ["backlog", "todo"],
            },
            parentIssueId: {
              type: "string",
              description: "父 issue ID（创建子任务时使用）",
            },
            assigneeAgentId: {
              type: "string",
              description: "指派给哪个 agent。创建任务时应尽量指定负责的 agent，这样任务才会被自动执行。",
            },
          },
          required: ["companyId", "title"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "release_issue",
        description:
          "释放 issue 的签出状态。当你无法完成任务需要让其他 agent 接手时使用。",
        parameters: {
          type: "object",
          properties: {
            issueId: {
              type: "string",
              description: "要释放的 issue ID",
            },
          },
          required: ["issueId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_agents",
        description:
          "列出公司中所有可用的 agent，包括它们的 ID、名称和角色。用于了解团队组成和分配任务。",
        parameters: {
          type: "object",
          properties: {
            companyId: {
              type: "string",
              description: "公司 ID",
            },
          },
          required: ["companyId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_dashboard",
        description:
          "获取公司仪表板概览，包括所有 issue 的状态统计和最近活动。用于了解项目整体进度。",
        parameters: {
          type: "object",
          properties: {
            companyId: {
              type: "string",
              description: "公司 ID",
            },
          },
          required: ["companyId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_agent_hire",
        description:
          "创建新的 agent（招聘请求）。用于 CEO 或有权限的 agent 创建新的团队成员。如果公司开启了审批，会返回 approval 信息，需要等待 board 审批通过后 agent 才会激活。",
        parameters: {
          type: "object",
          properties: {
            companyId: {
              type: "string",
              description: "公司 ID",
            },
            name: {
              type: "string",
              description: "新 agent 的名称（如 'CTO'、'Backend Engineer'）",
            },
            role: {
              type: "string",
              description: "新 agent 的角色标识（如 'cto'、'engineer'、'designer'）",
            },
            title: {
              type: "string",
              description: "新 agent 的职位头衔（如 'Chief Technology Officer'）",
            },
            icon: {
              type: "string",
              description: "新 agent 的图标名称（从 /llms/agent-icons.txt 获取可用图标列表）",
            },
            reportsTo: {
              type: "string",
              description: "上级 agent 的 ID（通常是创建者自己的 agentId）",
            },
            capabilities: {
              type: "string",
              description: "新 agent 的能力描述",
            },
            adapterType: {
              type: "string",
              description: "adapter 类型（如 'ollama_local'、'claude_local'、'codex_local'）",
            },
            adapterConfig: {
              type: "string",
              description: "adapter 配置的 JSON 字符串（如 '{\"model\":\"llama3.3\",\"baseUrl\":\"http://localhost:11434\"}'）",
            },
            instructionsContent: {
              type: "string",
              description: "新 agent 的 AGENTS.md 指令内容，定义 agent 的行为和职责",
            },
            desiredSkills: {
              type: "string",
              description: "期望的 skill 列表，用逗号分隔（如 'paperclip-create-agent,agent-browser'）",
            },
            sourceIssueId: {
              type: "string",
              description: "触发此招聘的源 issue ID（可选）",
            },
          },
          required: ["companyId", "name", "role", "adapterType"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_agent_configuration",
        description:
          "获取指定 adapter 类型的配置说明文档。用于了解创建新 agent 时需要哪些配置参数。",
        parameters: {
          type: "object",
          properties: {
            adapterType: {
              type: "string",
              description: "adapter 类型（如 'ollama_local'、'claude_local'、'codex_local'），不传则获取所有 adapter 的概览",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_agent_icons",
        description:
          "获取可用的 agent 图标列表。创建新 agent 时需要从中选择一个图标。",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
  ];
}

/**
 * 获取 tool 名称到 API endpoint 的映射
 */
export function getToolEndpointMap(): Record<
  string,
  { method: string; pathTemplate: string; bodyFields?: string[] }
> {
  return {
    get_my_identity: {
      method: "GET",
      pathTemplate: "/api/agents/me",
    },
    get_inbox: {
      method: "GET",
      pathTemplate: "/api/agents/me/inbox-lite",
    },
    checkout_issue: {
      method: "POST",
      pathTemplate: "/api/issues/{issueId}/checkout",
    },
    get_issue_context: {
      method: "GET",
      pathTemplate: "/api/issues/{issueId}/heartbeat-context",
    },
    update_issue: {
      method: "PATCH",
      pathTemplate: "/api/issues/{issueId}",
      bodyFields: ["status", "title", "description"],
    },
    add_comment: {
      method: "POST",
      pathTemplate: "/api/issues/{issueId}/comments",
      bodyFields: ["body"],
    },
    create_issue: {
      method: "POST",
      pathTemplate: "/api/companies/{companyId}/issues",
      bodyFields: ["title", "description", "status", "parentIssueId", "assigneeAgentId"],
    },
    release_issue: {
      method: "POST",
      pathTemplate: "/api/issues/{issueId}/release",
    },
    list_agents: {
      method: "GET",
      pathTemplate: "/api/companies/{companyId}/agents",
    },
    get_dashboard: {
      method: "GET",
      pathTemplate: "/api/companies/{companyId}/dashboard",
    },
    create_agent_hire: {
      method: "POST",
      pathTemplate: "/api/companies/{companyId}/agent-hires",
      bodyFields: ["name", "role", "title", "icon", "reportsTo", "capabilities", "adapterType", "adapterConfig", "instructionsBundle", "runtimeConfig", "desiredSkills", "sourceIssueId"],
    },
    get_agent_configuration: {
      method: "GET",
      pathTemplate: "/llms/agent-configuration/{adapterType}.txt",
    },
    get_agent_icons: {
      method: "GET",
      pathTemplate: "/llms/agent-icons.txt",
    },
  };
}
