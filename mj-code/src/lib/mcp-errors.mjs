// Source compatibility shim. The typed MCP error surface now lives in ./mcp-errors.mts.
export {
  McpError,
  createMcpCircuitOpenError,
  createMcpProtocolError,
  createMcpServerError,
  createMcpTimeoutError,
  createMcpToolError,
  createMcpTransportError,
  finalizeMcpError,
  isRetryableMcpError,
  normalizeMcpError,
  serializeMcpError,
} from "./mcp-errors.mts";
