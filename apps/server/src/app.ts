import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { redactText } from "./redaction/index.js";
import { traceFilePath } from "./trace.js";
import type { AgentService } from "./agent-service.js";

/**
 * Response bodies the outbound redactor runs over. Anything else — static
 * assets above all — is served byte-for-byte as written.
 */
const REDACTED_CONTENT_TYPES = ["application/json", "application/x-ndjson"];

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const approvalBody = z.object({
  approvalId: z.string().uuid(),
  decision: z.enum(["approve", "deny"]),
});

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  /**
   * Redact credential-shaped values out of every response body on the way out.
   *
   * This is one global hook rather than a patch on the routes that are known to
   * leak, and that choice is the whole point. Per-route redaction is fail-open:
   * it protects exactly the routes someone remembered, and every route added
   * afterwards leaks by default until someone notices. That is not a
   * hypothetical failure mode — it is how `Message.content` and `agent.lastError`
   * were missed in the first pass, when only the trace route looked risky.
   *
   * Scoped by content type, not by URL. `application/json` and
   * `application/x-ndjson` are the two shapes that carry agent-produced text.
   * In production this app also serves the built React UI through
   * `fastifyStatic` below; running a credential regex over JS bundles buys
   * nothing and risks corrupting a bundle whose minified output happens to
   * contain a long base64 run.
   *
   * The payload may be a string, a Buffer, or a stream. Streams pass through
   * untouched: buffering one here to redact it would defeat the point of
   * streaming, and nothing in this app currently streams a response body.
   */
  app.addHook("onSend", async (_request, reply, payload) => {
    const contentType = String(reply.getHeader("content-type") ?? "");
    if (!REDACTED_CONTENT_TYPES.some((type) => contentType.includes(type))) {
      return payload;
    }

    const isBuffer = Buffer.isBuffer(payload);
    if (typeof payload !== "string" && !isBuffer) return payload;

    const original = isBuffer ? payload.toString("utf8") : payload;
    const { text, redactions } = redactText(original);
    if (redactions === 0) return payload;

    // Fastify recomputes content-length from what we return, but only for a
    // body it can measure — set it explicitly so a Buffer response stays
    // consistent after the byte length changes.
    reply.header("x-redactions", String(redactions));
    reply.header("content-length", String(Buffer.byteLength(text, "utf8")));
    return isBuffer ? Buffer.from(text, "utf8") : text;
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  app.post("/api/runs/:id/approval", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const body = approvalBody.parse(request.body);
    return { run: await service.resolveApproval(id, body.approvalId, body.decision) };
  });

  /**
   * The raw trace of a run, as JSON Lines: one protocol message per line, in
   * the order they crossed the wire. Served as text rather than JSON because
   * the whole point is that it is a log, not a document.
   */
  app.get("/api/runs/:id/trace", async (request, reply) => {
    const { id } = runIdParams.parse(request.params);
    service.getRun(id); // 404s if the run does not exist

    // The path is derived from the run id rather than read from the run
    // record, so a trace can be read while the run is still going. The file is
    // appended as events arrive, so polling this shows steps appearing live.
    const path = traceFilePath(config.dataDirectory, id);
    const contents = await readFile(path, "utf8").catch(() => null);

    if (contents === null) {
      return reply.code(404).send({ error: "No trace for this run yet" });
    }

    return reply.type("application/x-ndjson").send(contents);
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
