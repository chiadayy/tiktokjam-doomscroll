// Provider adapter between Codex and BytePlus ModelArk.
//
// Ark's Responses API is stricter than OpenAI's: it requires `status` on input
// items that carry prior-turn output. Codex omits it. The first turn of a
// thread has no prior items so it succeeds; every turn after that is rejected
// with `MissingParameter: input.status`, which breaks multi-turn conversation
// and every app-server feature that depends on it.
//
// Codex reads its endpoint from `base_url` in config.toml, so pointing that at
// this proxy lets us conform the request to Ark's schema in transit. We cannot
// fix Codex (compiled binary) and we cannot fix Ark, so this is the only seam
// available.

import http from "node:http";
import https from "node:https";
import type { AppConfig } from "./config.js";

/** Input item types Ark validates `status` on. */
const STATUS_REQUIRED = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "local_shell_call",
  "web_search_call",
]);

interface RequestBody {
  input?: unknown;
}

/**
 * Adds the `status` Ark demands, at item level only.
 *
 * Ark is asymmetric here and it is easy to get wrong: it *requires* `status` on
 * the input item, and *rejects* a `status` field inside that item's nested
 * `content` / `summary` parts ("input.content: unknown field \"status\"").
 * Never recurse into them.
 */
export function repairArkInput(body: RequestBody): number {
  if (!Array.isArray(body.input)) return 0;
  let patched = 0;
  for (const entry of body.input) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.type !== "string" || !STATUS_REQUIRED.has(item.type)) continue;
    if (item.status === undefined || item.status === null) {
      item.status = "completed";
      patched += 1;
    }
  }
  return patched;
}

export interface ArkProxy {
  port: number;
  /** Base URL to put in config.toml so Codex reaches this proxy. */
  baseUrlForCodex: string;
  close(): Promise<void>;
}

export async function startArkProxy(config: AppConfig): Promise<ArkProxy> {
  const upstream = new URL(config.arkBaseUrl);
  const upstreamPrefix = upstream.pathname.replace(/\/+$/, "");

  const server = http.createServer((clientRequest, clientResponse) => {
    const chunks: Buffer[] = [];
    clientRequest.on("data", (chunk: Buffer) => chunks.push(chunk));
    clientRequest.on("end", () => {
      const raw = Buffer.concat(chunks);
      let outgoing = raw;

      if (raw.length > 0) {
        try {
          const parsed = JSON.parse(raw.toString("utf8")) as RequestBody;
          if (repairArkInput(parsed) > 0) outgoing = Buffer.from(JSON.stringify(parsed));
        } catch {
          // Not JSON (or malformed): forward untouched rather than guessing.
        }
      }

      const headers: Record<string, string | string[]> = {
        ...(clientRequest.headers as Record<string, string | string[]>),
        host: upstream.host,
        "content-length": String(outgoing.length),
      };
      delete headers["accept-encoding"];

      const upstreamRequest = https.request(
        {
          hostname: upstream.hostname,
          port: upstream.port || 443,
          // Codex appends "/responses" to base_url, so the incoming path
          // already carries the upstream prefix (e.g. /api/v3/responses).
          path: clientRequest.url,
          method: clientRequest.method,
          headers,
        },
        (upstreamResponse) => {
          clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(clientResponse);
        },
      );

      upstreamRequest.on("error", (error) => {
        clientResponse.writeHead(502, { "content-type": "application/json" });
        clientResponse.end(
          JSON.stringify({ error: { message: "ark-proxy upstream error: " + String(error) } }),
        );
      });

      upstreamRequest.end(outgoing);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.arkProxyPort, "0.0.0.0", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.arkProxyPort;

  return {
    port,
    baseUrlForCodex: `http://${config.arkProxyHost}:${port}${upstreamPrefix}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
