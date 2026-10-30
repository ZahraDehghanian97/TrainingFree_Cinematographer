import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { PipelineCapacityError, PipelineRunManager } from "./run-manager";
import type { PipelineRunEvent } from "./types";

const createRunSchema = z.strictObject({
  environmentId: z.string().trim().min(1).max(160)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  prompt: z.string().trim().min(1).max(4_000),
});

const MAX_REQUEST_BYTES = 32 * 1024;
const RUN_PATH = /^\/api\/pipeline\/runs\/([0-9a-f-]+)(\/events)?$/i;

export type PipelineApiMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new Error("Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

function sendSseEvent(response: ServerResponse, event: PipelineRunEvent): void {
  response.write(`id: ${event.sequence}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function isTerminal(event: PipelineRunEvent): boolean {
  return event.type === "complete" || event.type === "error";
}

function lastEventSequence(request: IncomingMessage): number | undefined {
  const header = request.headers["last-event-id"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : undefined;
}

function openEventStream(
  manager: PipelineRunManager,
  runId: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const existing = manager.events(runId);
  if (!existing) {
    json(response, 404, { error: { code: "run_not_found", message: "Pipeline run not found." } });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write("retry: 1500\n\n");
  const resumeAfter = lastEventSequence(request);
  const replay = resumeAfter === undefined
    ? existing
    : existing.filter((event) => event.sequence > resumeAfter);
  replay.forEach((event) => sendSseEvent(response, event));
  if (existing.some(isTerminal)) {
    response.end();
    return;
  }

  let closed = false;
  let unsubscribe = (): void => {};
  const heartbeat = setInterval(() => {
    if (!closed) response.write(": heartbeat\n\n");
  }, 15_000);
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  const subscription = manager.subscribe(runId, (event) => {
    if (closed) return;
    sendSseEvent(response, event);
    if (isTerminal(event)) {
      close();
      response.end();
    }
  });
  if (!subscription) {
    close();
    response.end();
    return;
  }
  unsubscribe = subscription;
  request.once("close", close);
  response.once("close", close);
}

function validationIssues(error: z.ZodError): unknown[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "$",
    message: issue.message,
  }));
}

export function createPipelineApiMiddleware(
  manager: PipelineRunManager,
): PipelineApiMiddleware {
  return (request, response, next) => {
    const url = new URL(request.url ?? "/", "http://camera.local");
    if (!url.pathname.startsWith("/api/pipeline/")) {
      next();
      return;
    }

    void (async () => {
      if (url.pathname === "/api/pipeline/runs") {
        if (request.method !== "POST") {
          json(response, 405, { error: { code: "method_not_allowed", message: "Use POST." } }, { Allow: "POST" });
          return;
        }
        const parsed = createRunSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          json(response, 400, {
            error: {
              code: "invalid_run_request",
              message: "Environment and prompt are required.",
              issues: validationIssues(parsed.error),
            },
          });
          return;
        }
        let snapshot;
        try {
          snapshot = manager.create(parsed.data);
        } catch (error) {
          if (error instanceof PipelineCapacityError) {
            json(response, 429, {
              error: {
                code: "pipeline_capacity_reached",
                message: error.message,
              },
            }, { "Retry-After": "2" });
            return;
          }
          throw error;
        }
        json(response, 202, { runId: snapshot.runId, status: snapshot.status }, {
          Location: `/api/pipeline/runs/${snapshot.runId}`,
        });
        return;
      }

      const match = RUN_PATH.exec(url.pathname);
      if (!match) {
        json(response, 404, { error: { code: "route_not_found", message: "Pipeline API route not found." } });
        return;
      }
      const runId = match[1]!;
      const eventsRoute = match[2] === "/events";

      if (eventsRoute) {
        if (request.method !== "GET") {
          json(response, 405, { error: { code: "method_not_allowed", message: "Use GET." } }, { Allow: "GET" });
          return;
        }
        openEventStream(manager, runId, request, response);
        return;
      }

      if (request.method === "GET") {
        const snapshot = manager.snapshot(runId);
        if (!snapshot) {
          json(response, 404, { error: { code: "run_not_found", message: "Pipeline run not found." } });
          return;
        }
        json(response, 200, snapshot);
        return;
      }
      if (request.method === "DELETE") {
        const snapshot = manager.cancel(runId);
        if (!snapshot) {
          json(response, 404, { error: { code: "run_not_found", message: "Pipeline run not found." } });
          return;
        }
        json(response, 202, snapshot);
        return;
      }

      json(response, 405, {
        error: { code: "method_not_allowed", message: "Use GET or DELETE." },
      }, { Allow: "GET, DELETE" });
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const message = error instanceof Error ? error.message : "Invalid pipeline request.";
      json(response, 400, { error: { code: "bad_request", message } });
    });
  };
}
