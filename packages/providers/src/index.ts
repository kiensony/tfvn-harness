import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
  type ModelMessage,
  ProviderError,
  type ToolCall,
} from "../../core/src/model.js";
import { type Usage, type Provider } from "../../core/src/contracts.js";
import { sse } from "./sse.js";
export interface AdapterOptions {
  baseUrl: string;
  apiKey: string;
  inputPerMillion?: number;
  outputPerMillion?: number;
  fetch?: typeof fetch;
}
function args(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ProviderError("Invalid tool arguments JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ProviderError("Tool arguments must be an object");
  return parsed as Record<string, unknown>;
}
abstract class BaseAdapter implements ModelAdapter {
  constructor(protected options: AdapterOptions) {}
  capabilities() {
    return {
      streaming: true,
      tools: true,
      images: false,
      structuredOutput: false,
    };
  }
  estimateUsage(req: ModelRequest): Usage {
    if (
      this.options.inputPerMillion === undefined ||
      this.options.outputPerMillion === undefined
    )
      throw new ProviderError(
        "Configure verified input/output pricing in trusted settings before live admission",
      );
    const input = Math.ceil(
      Buffer.byteLength(
        JSON.stringify({
          system: req.system,
          messages: req.messages,
          tools: req.tools,
        }),
      ) / 4,
    );
    return { ...this.usage(input, req.maxOutputTokens), estimated: true };
  }
  protected usage(input: number, output: number, requestId?: string): Usage {
    if (
      !Number.isFinite(input) ||
      !Number.isFinite(output) ||
      input < 0 ||
      output < 0
    )
      throw new ProviderError("Invalid provider usage");
    return {
      inputTokens: input,
      outputTokens: output,
      cost:
        (input * (this.options.inputPerMillion ?? 0) +
          output * (this.options.outputPerMillion ?? 0)) /
        1e6,
      ...(requestId ? { requestId } : {}),
    };
  }
  protected async request(
    path: string,
    body: unknown,
    signal: AbortSignal,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    signal.throwIfAborted();
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.baseUrl.replace(/\/$/, "")}/${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          ...headers,
        },
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(
        `Provider HTTP ${response.status}`,
        response.status === 429 || response.status === 503,
        response.status,
      );
    }
    return response;
  }
  abstract stream(req: ModelRequest): AsyncIterable<ModelEvent>;
}
function chatMessage(m: ModelMessage): any {
  if (m.role === "tool")
    return { role: "tool", tool_call_id: m.callId, content: m.content };
  if (m.role === "assistant" && m.native?.provider === "qwen")
    return m.native.content;
  return {
    role: m.role,
    content: m.content,
    ...(m.calls?.length
      ? {
          tool_calls: m.calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        }
      : {}),
  };
}
export class QwenAdapter extends BaseAdapter {
  async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
    const response = await this.request(
      "chat/completions",
      {
        model: req.model.id,
        messages: [
          { role: "system", content: req.system },
          ...req.messages.map(chatMessage),
        ],
        ...(req.tools.length
          ? { tools: req.tools.map((t) => ({ type: "function", function: t })) }
          : {}),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: req.maxOutputTokens,
        enable_thinking: true,
        reasoning_effort: req.model.effort,
      },
      req.signal,
    );
    const calls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let content = "",
      reasoning = "",
      finish = "",
      ended = false,
      usage: Usage | undefined,
      id: string | undefined;
    for await (const e of sse(response, req.signal)) {
      if (e.error) throw new ProviderError("Provider returned a stream error");
      if (e.type === "sse.done") {
        ended = true;
        break;
      }
      id = e.id ?? id;
      if (e.usage)
        usage = this.usage(
          e.usage.prompt_tokens,
          e.usage.completion_tokens,
          id,
        );
      const choice = e.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (typeof d.content === "string") {
        content += d.content;
        yield { type: "text", delta: d.content };
      }
      if (typeof d.reasoning_content === "string")
        reasoning += d.reasoning_content;
      for (const tc of d.tool_calls ?? []) {
        if (!Number.isInteger(tc.index))
          throw new ProviderError("Invalid tool index");
        const call = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
        call.id += tc.id ?? "";
        call.name += tc.function?.name ?? "";
        call.arguments += tc.function?.arguments ?? "";
        calls.set(tc.index, call);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (!ended || !finish)
      throw new ProviderError(
        "Interrupted provider stream: missing terminal event",
      );
    if (!["stop", "tool_calls"].includes(finish))
      throw new ProviderError(`Provider stopped without completion: ${finish}`);
    if (!usage)
      throw new ProviderError(
        "Provider omitted usage; retain admission reservation",
      );
    yield { type: "usage", usage };
    for (const call of calls.values()) {
      if (!call.id || !call.name)
        throw new ProviderError("Incomplete tool call");
      yield {
        type: "tool_call",
        call: { id: call.id, name: call.name, arguments: args(call.arguments) },
      };
    }
    if (finish === "tool_calls" && !calls.size)
      throw new ProviderError("Empty tool-call response");
    yield {
      type: "finish",
      reason: calls.size ? "tool_calls" : "stop",
      native: {
        provider: "qwen",
        content: {
          role: "assistant",
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(calls.size
            ? {
                tool_calls: [...calls.values()].map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        },
      },
    };
  }
}
function responsesInput(messages: ModelMessage[]): any[] {
  return messages.flatMap((m) => {
    if (m.role === "assistant" && m.native?.provider === "openai")
      return m.native.content as any[];
    if (m.role === "tool")
      return [
        { type: "function_call_output", call_id: m.callId, output: m.content },
      ];
    return [{ role: m.role, content: m.content }];
  });
}
export class OpenAIAdapter extends BaseAdapter {
  async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
    const response = await this.request(
      "responses",
      {
        model: req.model.id,
        instructions: req.system,
        input: responsesInput(req.messages),
        tools: req.tools.map((t) => ({
          type: "function",
          ...t,
          strict: false,
        })),
        reasoning: { effort: req.model.effort },
        include: ["reasoning.encrypted_content"],
        store: false,
        stream: true,
        max_output_tokens: req.maxOutputTokens,
      },
      req.signal,
    );
    const items: any[] = [];
    let terminal: any;
    for await (const e of sse(response, req.signal)) {
      if (
        e.type === "error" ||
        e.type === "response.failed" ||
        e.type === "response.incomplete"
      )
        throw new ProviderError("Responses request failed or was incomplete");
      if (e.type === "response.output_text.delta")
        yield { type: "text", delta: e.delta };
      if (e.type === "response.refusal.delta")
        throw new ProviderError("Provider refused the request");
      if (e.type === "response.output_item.done") items.push(e.item);
      if (e.type === "response.completed") {
        terminal = e.response;
        break;
      }
    }
    if (!terminal?.usage)
      throw new ProviderError("Interrupted Responses stream or missing usage");
    yield {
      type: "usage",
      usage: this.usage(
        terminal.usage.input_tokens,
        terminal.usage.output_tokens,
        terminal.id,
      ),
    };
    const calls = items.filter((i) => i.type === "function_call");
    for (const c of calls) {
      if (!c.call_id || !c.name)
        throw new ProviderError("Incomplete tool call");
      yield {
        type: "tool_call",
        call: { id: c.call_id, name: c.name, arguments: args(c.arguments) },
      };
    }
    yield {
      type: "finish",
      reason: calls.length ? "tool_calls" : "stop",
      native: { provider: "openai", content: items },
    };
  }
}
function anthropicMessages(messages: ModelMessage[]): any[] {
  const result: any[] = [];
  for (const m of messages) {
    let content: any[];
    if (m.role === "tool")
      content = [
        { type: "tool_result", tool_use_id: m.callId, content: m.content },
      ];
    else if (m.role === "assistant" && m.native?.provider === "anthropic")
      content = m.native.content as any[];
    else content = [{ type: "text", text: m.content || "(empty)" }];
    const role = m.role === "tool" ? "user" : m.role;
    if (result.at(-1)?.role === role) result.at(-1).content.push(...content);
    else result.push({ role, content });
  }
  return result;
}
export class AnthropicAdapter extends BaseAdapter {
  async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
    const response = await this.request(
      "messages",
      {
        model: req.model.id,
        system: req.system,
        messages: anthropicMessages(req.messages),
        ...(req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
        max_tokens: req.maxOutputTokens,
        stream: true,
        thinking: { type: "adaptive" },
        output_config: { effort: req.model.effort },
      },
      req.signal,
      { "x-api-key": this.options.apiKey, "anthropic-version": "2023-06-01" },
    );
    const blocks: any[] = [];
    const json = new Map<number, string>();
    let ended = false,
      stop = "",
      id: string | undefined,
      input = 0,
      output = 0,
      hasUsage = false;
    for await (const e of sse(response, req.signal)) {
      if (e.type === "error") throw new ProviderError("Messages stream error");
      if (e.type === "message_start") {
        id = e.message.id;
        input = e.message.usage?.input_tokens ?? 0;
        input +=
          (e.message.usage?.cache_creation_input_tokens ?? 0) +
          (e.message.usage?.cache_read_input_tokens ?? 0);
        output = e.message.usage?.output_tokens ?? 0;
        hasUsage = !!e.message.usage;
      }
      if (e.type === "content_block_start")
        blocks[e.index] = structuredClone(e.content_block);
      if (e.type === "content_block_delta") {
        const b = blocks[e.index];
        if (!b) throw new ProviderError("Missing content block");
        const d = e.delta;
        if (d.type === "text_delta") {
          b.text += d.text;
          yield { type: "text", delta: d.text };
        }
        if (d.type === "input_json_delta")
          json.set(e.index, (json.get(e.index) ?? "") + d.partial_json);
        if (d.type === "thinking_delta") b.thinking += d.thinking;
        if (d.type === "signature_delta") b.signature += d.signature;
      }
      if (e.type === "content_block_stop" && json.has(e.index))
        blocks[e.index].input = args(json.get(e.index)!);
      if (e.type === "message_delta") {
        stop = e.delta?.stop_reason ?? stop;
        output = e.usage?.output_tokens ?? output;
      }
      if (e.type === "message_stop") {
        ended = true;
        break;
      }
    }
    if (!ended || !stop || !hasUsage)
      throw new ProviderError("Interrupted Messages stream");
    if (!["end_turn", "tool_use"].includes(stop))
      throw new ProviderError(`Provider stopped without completion: ${stop}`);
    yield { type: "usage", usage: this.usage(input, output, id) };
    const calls = blocks.filter((b) => b?.type === "tool_use");
    for (const b of calls) {
      if (!b.id || !b.name) throw new ProviderError("Incomplete tool call");
      yield {
        type: "tool_call",
        call: {
          id: b.id,
          name: b.name,
          arguments: args(JSON.stringify(b.input)),
        },
      };
    }
    if (stop === "tool_use" && !calls.length)
      throw new ProviderError("Empty tool-call response");
    yield {
      type: "finish",
      reason: calls.length ? "tool_calls" : "stop",
      native: { provider: "anthropic", content: blocks },
    };
  }
}
export class MockAdapter implements ModelAdapter {
  capabilities() {
    return {
      streaming: true,
      tools: false,
      images: false,
      structuredOutput: false,
    };
  }
  estimateUsage(): Usage {
    return { inputTokens: 0, outputTokens: 0, cost: 0, estimated: true };
  }
  async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
    req.signal.throwIfAborted();
    yield {
      type: "text",
      delta:
        "Offline mock session: routing and persistence are available. No model inference or code changes were performed.",
    };
    yield {
      type: "usage",
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    };
    yield { type: "finish", reason: "stop" };
  }
}
export function adapterFor(
  provider: Provider,
  options: AdapterOptions,
): ModelAdapter {
  if (provider === "qwen") return new QwenAdapter(options);
  if (provider === "openai") return new OpenAIAdapter(options);
  if (provider === "anthropic") return new AnthropicAdapter(options);
  return new MockAdapter();
}
