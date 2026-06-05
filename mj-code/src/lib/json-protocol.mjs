// Source compatibility shim. The typed JSON protocol now lives in ./json-protocol.mts.
export {
  buildSystemPrompt,
  extractAction,
  formatToolFeedback,
} from "./json-protocol.mts";
