// Source compatibility shim. The typed capability taxonomy now lives in ./capability-types.mts.
export {
  CAPABILITY_TYPES,
  TOOL_CAPABILITY_TYPES,
  isCapabilityType,
  isExternalType,
  isRiskCategoryRisky,
  isToolCapability,
  normalizeCapability,
  normalizeCapabilityType,
  sortCapabilities,
  summarizeCapabilitySurface,
} from "./capability-types.mts";
