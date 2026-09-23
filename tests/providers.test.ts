import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QwenAdapter,
  OpenAIAdapter,
  AnthropicAdapter,
} from "../packages/providers/src/index.js";
import {
  type ModelRequest,
  type ModelEvent,
} from "../packages/core/src/model.js";
function fixture(lines: unknown[], sentinel = false) {
  const bytes = new TextEncoder().encode(
    lines.map((x) => `data: ${JSON.stringify(x)}\r\n\r\n`).join("") +
      (sentinel ? "data: [DONE]\r\n\r\n" : ""),
  );
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7)
          c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    }),
  );
}
const req: ModelRequest = {
  model: {
    provider: "qwen",
    id: "qwen3.8-27b",
    effort: "low",
    contextTokens: 64000,
  },
  system: "test",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  maxOutputTokens: 100,
  signal: new AbortController().signal,
};
const ep = {
  baseUrl: "https://provider.test/v1",
  apiKey: "secret",
  inputPerMillion: 1,
  outputPerMillion: 2,
};
async function collect(stream: AsyncIterable<ModelEvent>) {
  const events = [];
  for await (const e of stream) events.push(e);
  return events;
}
test("Qwen accumulates fragmented tool arguments and reports final usage", async () => {
  let body: any;
  const adapter = new QwenAdapter({
    ...ep,
    fetch: async (_url, init) => {
      body = JSON.parse(init!.body as string);
      return fixture(
        [
          {
            id: "q1",
            choices: [
              {
                delta: {
                  content: "héllo",
                  tool_calls: [
                    {
                      index: 0,
                      id: "t1",
                      function: { name: "read", arguments: '{"path":' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: '"a.ts"}' } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
          { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } },
        ],
        true,
      );
    },
  });
  const events = await collect(adapter.stream(req));
  assert.deepEqual(
    events.find((e) => e.type === "tool_call"),
    {
      type: "tool_call",
      call: { id: "t1", name: "read", arguments: { path: "a.ts" } },
    },
  );
  assert.equal(events.find((e) => e.type === "text")?.delta, "héllo");
  assert.equal(events.find((e) => e.type === "usage")?.usage.cost, 0.00004);
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.stream_options.include_usage, true);
});
test("interrupted or malformed streams never finish successfully", async () => {
  const interrupted = new QwenAdapter({
    ...ep,
    fetch: async () =>
      fixture([{ choices: [{ delta: { content: "partial" } }] }]),
  });
  await assert.rejects(collect(interrupted.stream(req)), /interrupt|terminal/i);
  const invalid = new QwenAdapter({
    ...ep,
    fetch: async () =>
      fixture(
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "t",
                      function: { name: "read", arguments: "{" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          },
        ],
        true,
      ),
  });
  await assert.rejects(collect(invalid.stream(req)), /JSON|arguments/i);
});
test("OpenAI uses Responses and preserves provider-specific continuation items", async () => {
  let url = "",
    body: any;
  const adapter = new OpenAIAdapter({
    ...ep,
    fetch: async (u, init) => {
      url = String(u);
      body = JSON.parse(init!.body as string);
      return fixture([
        { type: "response.output_text.delta", delta: "plan" },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs1",
            summary: [],
            encrypted_content: "opaque",
          },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "c1",
            name: "read",
            arguments: '{"path":"x"}',
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp1",
            usage: { input_tokens: 11, output_tokens: 7 },
          },
        },
      ]);
    },
  });
  const events = await collect(
    adapter.stream({
      ...req,
      model: {
        ...req.model,
        provider: "openai",
        id: "gpt-6-astra",
        effort: "high",
      },
    }),
  );
  assert.equal(url, "https://provider.test/v1/responses");
  assert.equal(body.reasoning.effort, "high");
  assert.equal(body.store, false);
  assert.ok(events.some((e) => e.type === "tool_call" && e.call.id === "c1"));
  assert.deepEqual(
    events.find((e) => e.type === "finish")?.native?.provider,
    "openai",
  );
  assert.equal(
    events
      .filter((e) => e.type === "text")
      .map((e) => e.delta)
      .join(""),
    "plan",
  );
});
test("Anthropic keeps signed thinking private and maps tools and effort", async () => {
  let body: any;
  const adapter = new AnthropicAdapter({
    ...ep,
    fetch: async (_u, init) => {
      body = JSON.parse(init!.body as string);
      return fixture([
        {
          type: "message_start",
          message: { id: "m1", usage: { input_tokens: 10, output_tokens: 1 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "private" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "signed" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "t1",
            name: "read",
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"path":"x"}' },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 8 },
        },
        { type: "message_stop" },
      ]);
    },
  });
  const events = await collect(
    adapter.stream({
      ...req,
      model: {
        ...req.model,
        provider: "anthropic",
        id: "claude-opus-5-5",
        effort: "high",
      },
    }),
  );
  assert.equal(body.output_config.effort, "high");
  assert.equal(body.thinking.type, "adaptive");
  assert.ok(!events.some((e) => e.type === "text"));
  const native = events.find((e) => e.type === "finish")?.native;
  assert.equal((native?.content as any[])[0].signature, "signed");
  assert.equal(events.find((e) => e.type === "usage")?.usage.outputTokens, 8);
});
test("missing pricing prevents live admission and aborted requests stay aborted", async () => {
  assert.throws(
    () =>
      new QwenAdapter({ baseUrl: ep.baseUrl, apiKey: "key" }).estimateUsage(
        req,
      ),
    /pricing/i,
  );
  const signal = AbortSignal.abort(new Error("cancelled"));
  await assert.rejects(
    collect(new QwenAdapter(ep).stream({ ...req, signal })),
    /cancelled/,
  );
});
