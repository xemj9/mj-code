export async function readSseStream(stream, onEvent) {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = await flushCompleteEvents(buffer, onEvent);
  }

  if (buffer.trim()) {
    await onEvent(parseSseEvent(buffer));
  }
}

async function flushCompleteEvents(buffer, onEvent) {
  let next = buffer;

  while (true) {
    const separatorIndex = next.search(/\r?\n\r?\n/);
    if (separatorIndex === -1) {
      return next;
    }

    const separatorMatch = next.match(/\r?\n\r?\n/);
    const rawEvent = next.slice(0, separatorIndex);
    next = next.slice(separatorIndex + separatorMatch[0].length);

    if (rawEvent.trim()) {
      await onEvent(parseSseEvent(rawEvent));
    }
  }
}

function parseSseEvent(rawEvent) {
  const lines = rawEvent.split(/\r?\n/);
  let event = "message";
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  return {
    event,
    data: dataLines.join("\n"),
  };
}

