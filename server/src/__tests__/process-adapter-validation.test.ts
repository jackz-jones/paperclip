import express from "express";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
}

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "company-1",
            requireBoardApprovalForNewAgents: false,
          },
        ]),
      })),
    })),
  };
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Tests: process adapter command validation
// ---------------------------------------------------------------------------

describe("process adapter command validation", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      name: String(input.name ?? "Agent"),
      urlKey: "agent",
      role: String(input.role ?? "general"),
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: String(input.adapterType ?? "process"),
      adapterConfig: (input.adapterConfig as Record<string, unknown> | undefined) ?? {},
      runtimeConfig: (input.runtimeConfig as Record<string, unknown> | undefined) ?? {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(async (agent: any, _files: any, _opts: any) => ({
      bundle: { agentId: agent.id, files: [] },
      adapterConfig: { ...((agent.adapterConfig as Record<string, unknown>) ?? {}), instructionsBundleMode: "managed", instructionsFilePath: "/tmp/instructions/AGENTS.md" },
    }));
    mockAgentService.update.mockImplementation(async (id: string, patch: any) => ({
      id,
      companyId: "company-1",
      name: "Agent",
      urlKey: "agent",
      role: "general",
      adapterType: "process",
      adapterConfig: patch.adapterConfig ?? {},
      runtimeConfig: {},
      status: "idle",
    }));
  });

  it("rejects process adapter agent creation when command is missing", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Process Agent",
          adapterType: "process",
          adapterConfig: {},
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error ?? res.body.message ?? "")).toContain(
      "Process adapter requires a command to execute",
    );
  });

  it("rejects process adapter agent creation when command is empty string", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Process Agent",
          adapterType: "process",
          adapterConfig: { command: "   " },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error ?? res.body.message ?? "")).toContain(
      "Process adapter requires a command to execute",
    );
  });

  it("allows process adapter agent creation when command is provided", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Process Agent",
          adapterType: "process",
          adapterConfig: { command: "python3 agent.py" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("rejects process adapter via agent-hires when command is missing", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agent-hires")
        .send({
          name: "Hired Process Agent",
          adapterType: "process",
          adapterConfig: {},
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error ?? res.body.message ?? "")).toContain(
      "Process adapter requires a command to execute",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: process adapter supportsInstructionsBundle
// ---------------------------------------------------------------------------

describe("process adapter supportsInstructionsBundle", () => {
  it("declares supportsInstructionsBundle: true", async () => {
    const { processAdapter } = await import("../adapters/process/index.js");
    expect(processAdapter.supportsInstructionsBundle).toBe(true);
  });

  it("declares instructionsPathKey: instructionsFilePath", async () => {
    const { processAdapter } = await import("../adapters/process/index.js");
    expect(processAdapter.instructionsPathKey).toBe("instructionsFilePath");
  });
});

// ---------------------------------------------------------------------------
// Tests: process adapter execute - PAPERCLIP_INSTRUCTIONS_FILE injection
// ---------------------------------------------------------------------------

describe("process adapter execute - PAPERCLIP_INSTRUCTIONS_FILE", () => {
  it("throws descriptive error when command is missing", async () => {
    const { execute } = await import("../adapters/process/execute.js");
    const ctx = {
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Test" },
      config: {},
      onLog: vi.fn(),
      onMeta: vi.fn(),
    };

    await expect(execute(ctx as any)).rejects.toThrow(
      "Process adapter requires a 'command' field in adapterConfig",
    );
  });

  it("injects PAPERCLIP_INSTRUCTIONS_FILE when instructionsFilePath exists", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    const { execute } = await import("../adapters/process/execute.js");
    const ctx = {
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Test" },
      config: {
        command: "echo",
        args: ["hello"],
        instructionsFilePath: "/tmp/test-instructions/AGENTS.md",
      },
      onLog: vi.fn(),
      onMeta: vi.fn(),
    };

    // Mock runChildProcess 以捕获传入的 env
    const utils = await import("../adapters/utils.js");
    const runChildProcessSpy = vi.spyOn(utils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    });

    await execute(ctx as any);

    // 验证 runChildProcess 被调用时 env 中包含 PAPERCLIP_INSTRUCTIONS_FILE
    expect(runChildProcessSpy).toHaveBeenCalled();
    const callArgs = runChildProcessSpy.mock.calls[0];
    const passedOptions = callArgs[3] as any;
    expect(passedOptions.env).toHaveProperty(
      "PAPERCLIP_INSTRUCTIONS_FILE",
      "/tmp/test-instructions/AGENTS.md",
    );

    vi.restoreAllMocks();
  });

  it("logs warning when instructionsFilePath does not exist", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const { execute } = await import("../adapters/process/execute.js");
    const logCalls: any[] = [];
    const ctx = {
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Test" },
      config: {
        command: "echo",
        args: ["hello"],
        instructionsFilePath: "/tmp/nonexistent/AGENTS.md",
      },
      onLog: vi.fn(async (...args: any[]) => { logCalls.push(args); }),
      onMeta: vi.fn(),
    };

    const utils = await import("../adapters/utils.js");
    vi.spyOn(utils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    });

    await execute(ctx as any);

    // 验证输出了警告日志
    const warningLog = logCalls.find(
      (entry) => entry[0] === "stderr" && entry[1].includes("[warn]") && entry[1].includes("does not exist"),
    );
    expect(warningLog).toBeDefined();

    vi.restoreAllMocks();
  });
});
