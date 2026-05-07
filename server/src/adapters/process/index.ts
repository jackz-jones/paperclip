import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const processAdapter: ServerAdapterModule = {
  type: "process",
  execute,
  testEnvironment,
  models: [],
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  agentConfigurationDoc: `# process agent configuration

Adapter: process

Core fields:
- command (string, REQUIRED): command to execute. This field is mandatory — agent creation will fail without it.
- args (string[] | string, optional): command arguments
- cwd (string, optional): absolute working directory
- env (object, optional): KEY=VALUE environment variables

Instructions fields (auto-managed):
- instructionsFilePath (string, auto-managed): path to the AGENTS.md instructions file. Automatically set when the instructions bundle is materialized. Injected as PAPERCLIP_INSTRUCTIONS_FILE environment variable at runtime.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Example configuration:
{
  "command": "python3 /path/to/agent.py",
  "cwd": "/path/to/workspace",
  "env": { "MY_VAR": "value" },
  "timeoutSec": 300
}

IMPORTANT: The "command" field is required. If omitted, the agent will fail to run.
`,
};
