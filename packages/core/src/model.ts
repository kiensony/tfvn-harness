import { type ModelSpec, type Provider, type Usage } from "./contracts.js";
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ProviderData {
  provider: Provider;
  content: unknown;
}
export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  calls?: ToolCall[];
  callId?: string;
  native?: ProviderData;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ModelRequest {
  model: ModelSpec;
  system: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  maxOutputTokens: number;
  signal: AbortSignal;
}
export type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: "stop" | "tool_calls"; native?: ProviderData };
export interface ModelAdapter {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
  capabilities(): {
    streaming: boolean;
    tools: boolean;
    images: boolean;
    structuredOutput: boolean;
  };
  estimateUsage(request: ModelRequest): Usage;
}
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
