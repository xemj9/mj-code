export async function rememberMemory(input, context) {
  if (!context.memoryStore) {
    throw new Error("Memory store is not available in this runtime.");
  }

  const memory = await context.memoryStore.remember({
    scope: input.scope,
    kind: input.kind,
    key: input.key,
    text: input.text,
    summary: input.summary,
    source: input.source || "tool",
    confidence: input.confidence,
    importance: input.importance,
    sourceCertainty: 0.9,
    tags: input.tags,
    expiresInDays: input.expiresInDays,
  });

  return {
    id: memory.id,
    scope: memory.scope,
    kind: memory.kind,
    summary: memory.summary,
    source: memory.source,
  };
}

export async function searchMemory(input, context) {
  if (!context.memoryStore) {
    throw new Error("Memory store is not available in this runtime.");
  }

  const results = await context.memoryStore.search(input.query, {
    scopes: input.scopes,
    limit: input.limit,
  });

  return {
    query: input.query,
    results: results.map((item) => ({
      id: item.id,
      scope: item.scope,
      kind: item.kind,
      summary: item.summary,
      source: item.source,
      confidence: item.confidence,
      score: item.score,
      updatedAt: item.updatedAt,
    })),
  };
}

export async function forgetMemory(input, context) {
  if (!context.memoryStore) {
    throw new Error("Memory store is not available in this runtime.");
  }

  if (input.key) {
    const count = await context.memoryStore.forgetKey(input.scope, input.key);
    return {
      scope: input.scope,
      key: input.key,
      forgottenCount: count,
      message: count > 0
        ? `Forgot ${count} memory item(s) with key "${input.key}" in ${input.scope} scope.`
        : `No active memories found with key "${input.key}" in ${input.scope} scope.`,
    };
  }

  if (input.id) {
    const success = await context.memoryStore.forget({ scope: input.scope, id: input.id });
    return {
      scope: input.scope,
      id: input.id,
      forgotten: success,
      message: success
        ? `Forgot memory item ${input.id} in ${input.scope} scope.`
        : `Memory item ${input.id} not found in ${input.scope} scope.`,
    };
  }

  throw new Error("forget_memory requires either an 'id' or 'key' parameter.");
}
