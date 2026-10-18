/**
 * Week 4b — reading POST /api/ai/ask's server-sent events in the browser.
 * Pure: feed it text as it arrives; it returns whole events and keeps the rest.
 */
export interface SseEvent { event: string; data: unknown }

export function createSseParser() {
  let buffer = "";
  return (chunk: string): SseEvent[] => {
    buffer += chunk;
    const out: SseEvent[] = [];
    let at: number;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      try { out.push({ event, data: JSON.parse(data.join("\n")) }); } catch { out.push({ event, data: data.join("\n") }); }
    }
    return out;
  };
}
