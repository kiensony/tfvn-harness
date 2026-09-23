import { ProviderError } from "../../core/src/model.js";
export async function* sse(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<any> {
  if (!response.body) throw new ProviderError("Provider returned no stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 8_000_000)
        throw new ProviderError("Provider event exceeds output limit");
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) {
          if (data === "[DONE]") yield { type: "sse.done" };
          else {
            try {
              yield JSON.parse(data);
            } catch {
              throw new ProviderError("Invalid JSON in provider stream");
            }
          }
        }
      }
      if (done) {
        if (buffer.trim())
          throw new ProviderError("Interrupted provider event");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
