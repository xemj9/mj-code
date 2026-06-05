import { MJCodeAgentCore } from "./lib/agent-core.mjs";

import type {
  AgentTerminalUi,
} from "./types/agent-facade.js";
import type {
  ToolRegistrySurface,
} from "./types/contracts.js";
import type { LoadedConfig } from "./config.mjs";

export class MJCodeAgent extends MJCodeAgentCore {
  declare config: LoadedConfig;
  declare ui: AgentTerminalUi;
  declare sessionFilePath: string | null;
  declare toolRegistry: ToolRegistrySurface;
}

export type MJCodeAgentFacade = MJCodeAgent;
export type { AgentBootstrapOptions, AgentTerminalUi } from "./types/agent-facade.js";
