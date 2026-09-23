import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type McpTransport, ExtensionRegistry } from "./extensions.js";
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const p = address.split(".").map(Number);
    return !(
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0]! >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1]! >= 64 && p[1]! <= 127) ||
      (p[0] === 198 && [18, 19].includes(p[1]!))
    );
  }
  // IPv6 global unicast only. Reject mapped IPv4, loopback, link-local and ULA.
  return isIP(address) === 6 && /^2[0-9a-f]{3}:/i.test(address);
}
export class TrustedHttp {
  constructor(readonly origins: string[]) {}
  async request(
    url: string,
    signal: AbortSignal,
    options: {
      method?: "GET" | "POST";
      body?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{
    text: string;
    headers: Record<string, string | string[] | undefined>;
  }> {
    const u = new URL(url);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      !this.origins.includes(u.origin)
    )
      throw new Error("Network destination is not authorized");
    const addresses = await lookup(u.hostname, { all: true });
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      throw new Error("Private or special network destinations are prohibited");
    const target = addresses[0]!;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          hostname: target.address,
          port: u.port || 443,
          servername: u.hostname,
          method: options.method ?? "GET",
          path: u.pathname + u.search,
          headers: { ...options.headers, host: u.host },
          signal,
        },
        (response) => {
          if (
            (response.statusCode ?? 500) < 200 ||
            (response.statusCode ?? 500) >= 300
          ) {
            response.resume();
            reject(
              new Error(
                `HTTP ${response.statusCode}; redirects require separate authorization`,
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2_000_000) {
              request.destroy(new Error("HTTP output limit exceeded"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () =>
            resolve({
              text: Buffer.concat(chunks).toString(),
              headers: response.headers,
            }),
          );
          response.on("error", reject);
        },
      );
      request.setTimeout(30000, () =>
        request.destroy(new Error("HTTP timeout")),
      );
      request.on("error", reject);
      request.end(options.body);
    });
  }
}
export function networkTools(origins: string[]): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  if (origins.length) {
    const http = new TrustedHttp(origins);
    registry.register({
      name: "http_get",
      description:
        "Fetch an HTTPS documentation page from trusted allowed origins.",
      schema: z.object({ url: z.url() }).strict(),
      capability: "network",
      sideEffect: false,
      location: "broker",
      timeoutMs: 30000,
      maxOutputBytes: 2000000,
      execute: async (args, signal) =>
        (await http.request(args.url, signal)).text,
    });
  }
  return registry;
}
export class HttpMcpTransport implements McpTransport {
  private session: string | undefined;
  private initialized = false;
  constructor(
    readonly http: TrustedHttp,
    readonly endpoint: string,
    readonly headers: Record<string, string> = {},
  ) {}
  private async rpc(method: string, params: unknown, signal: AbortSignal) {
    const id = randomUUID();
    const response = await this.http.request(this.endpoint, signal, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      headers: {
        ...this.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        ...(this.session ? { "mcp-session-id": this.session } : {}),
      },
    });
    const session = response.headers["mcp-session-id"];
    if (typeof session === "string") this.session = session;
    let data: any;
    try {
      data = JSON.parse(response.text);
    } catch {
      throw new Error(
        "This MCP transport requires JSON responses; SSE transport is not enabled",
      );
    }
    if (data.id !== id || data.error)
      throw new Error("MCP request failed or response ID mismatch");
    return data.result;
  }
  async call(method: string, params: unknown, signal: AbortSignal) {
    if (!this.initialized) {
      await this.rpc(
        "initialize",
        {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "tfvn", version: "0.1.0" },
        },
        signal,
      );
      await this.http.request(this.endpoint, signal, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
        headers: {
          ...this.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.session ? { "mcp-session-id": this.session } : {}),
        },
      });
      this.initialized = true;
    }
    return this.rpc(method, params, signal);
  }
}
