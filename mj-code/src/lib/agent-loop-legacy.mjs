// Legacy JS base kept only for compatibility-oriented construction and runtime
// bootstrap while the typed surface classes drain the remaining wrapper layer.

import { buildAgentConstructionState } from "./agent-construction.mjs";
import {
  bindAgentRuntimeSession,
  closeAgentRuntime,
  initializeAgentRuntimeStores,
  syncAgentRuntimeContinuity,
} from "./agent-runtime-bootstrap.mjs";
import {
  createAgentSessionEntry,
  inspectAgentSessionEntry,
  resumeAgentSessionEntry,
} from "./agent-session-entry.mjs";

/**
 * @typedef {import("../config.mjs").LoadedConfig} LoadedConfig
 * @typedef {import("../providers/index.mjs").ProviderAdapter} ProviderLike
 * @typedef {import("../types/contracts.js").InstructionPack} ProjectInstructionsLike
 * @typedef {import("./runtime-health.mjs").RuntimeHealth} RuntimeHealthInstance
 */

export class MJCodeAgentCore {
  /**
   * @param {LoadedConfig} config
   * @param {object} ui
   * @param {ProviderLike} provider
   * @param {ProjectInstructionsLike} projectInstructions
   * @param {RuntimeHealthInstance | null} [runtimeHealth]
   */
  constructor(config, ui, provider, projectInstructions, runtimeHealth = null) {
    Object.assign(this, buildAgentConstructionState(this, {
      config,
      ui,
      provider,
      projectInstructions,
      runtimeHealth,
    }));
  }

  static async create(options, ui) {
    return createAgentSessionEntry(this, options, ui);
  }

  static async inspect(options, ui) {
    return inspectAgentSessionEntry(this, options, ui);
  }

  static async resume(options, ui, sessionReference) {
    return resumeAgentSessionEntry(this, options, ui, sessionReference);
  }

  async initializeStores() {
    await initializeAgentRuntimeStores(this);
  }

  async close() {
    await closeAgentRuntime(this);
  }

  async bindRuntimeSession() {
    await bindAgentRuntimeSession(this);
  }

  async syncRuntimeContinuity() {
    await syncAgentRuntimeContinuity(this);
  }
}
