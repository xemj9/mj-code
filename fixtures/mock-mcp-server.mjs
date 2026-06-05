import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const tools = [
  {
    name: "echo",
    description: "Echo back the provided text.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "slow_echo",
    description: "Echo back the provided text after a delay.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        delayMs: { type: "integer" },
      },
      required: ["text"],
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
];

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  const message = JSON.parse(trimmed);
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: "2025-03-26",
      capabilities: {
        tools: {
          listChanged: true,
        },
      },
      serverInfo: {
        name: process.env.MCP_SERVER_NAME || "mock-mcp-server",
        version: "1.0.0",
      },
    });
    return;
  }

  if (message.method === "notifications/initialized") {
    return;
  }

  if (message.method === "ping") {
    respond(message.id, {});
    return;
  }

  if (message.method === "tools/list") {
    if (!message.params?.cursor) {
      respond(message.id, {
        tools: [tools[0]],
        nextCursor: "page-2",
      });
      return;
    }

    respond(message.id, {
      tools: [tools[1]],
    });
    return;
  }

  if (message.method === "tools/call") {
    if (message.params?.name === "echo") {
      respond(message.id, {
        content: [
          {
            type: "text",
            text: `echo:${message.params.arguments?.text ?? ""}`,
          },
        ],
      });
      return;
    }

    if (message.params?.name === "slow_echo") {
      const delayMs = Number(message.params.arguments?.delayMs ?? 150);
      setTimeout(() => {
        respond(message.id, {
          content: [
            {
              type: "text",
              text: `slow:${message.params.arguments?.text ?? ""}`,
            },
          ],
        });
      }, delayMs);
      return;
    }

    if (message.params?.name === "explode") {
      respond(message.id, {
        content: [
          {
            type: "text",
            text: "explode failed",
          },
        ],
        isError: true,
      });
      return;
    }

    respondError(message.id, -32001, `Unknown tool ${message.params?.name ?? "unknown"}`);
    return;
  }

  respondError(message.id, -32601, `Unknown method ${message.method}`);
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    result,
  })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  })}\n`);
}
