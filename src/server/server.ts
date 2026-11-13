import { access, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DelegatedAuthService } from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createAgentTransportFactory } from "./d2e.js";
import { DemoOperationError, EquipmentDemoService } from "./equipment-service.js";
import { parseStrictJson } from "./contracts.js";
import { SessionStore, type Session, type WorkflowState } from "./session-store.js";

const SESSION_COOKIE = "mcs_demo_session";
const COOKIE_MAX_AGE_SECONDS = 30 * 60;
const BODY_MAX_BYTES = 16_384;
const PUBLIC_DIR = resolve(process.cwd(), "dist/public");

export interface DemoServer {
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createDemoServer(config: AppConfig = loadConfig()): DemoServer {
  const sessions = new SessionStore();
  const auth = new DelegatedAuthService(config);
  const equipment = new EquipmentDemoService(
    sessions,
    (session) => auth.getAccessToken(session),
    createAgentTransportFactory(config.connectionSettings),
    config.agentReady,
  );
  const server = createServer((request, response) => {
    void handleRequest(request, response, config, sessions, auth, equipment).catch((error: unknown) => {
      log(config, "request_failed", {
        method: request.method,
        path: safePath(request.url),
        error: error instanceof DemoOperationError ? error.code : error instanceof Error ? error.name : "UnknownError",
      });
      if (!response.headersSent) {
        if (error instanceof DemoOperationError) {
          sendJson(response, error.status, {
            error: {
              code: error.code,
              message: error.message,
              retryable: error.code === "AUTH_REQUIRED",
              ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
            },
          });
        } else {
          sendJson(response, 500, {
            error: {
              code: "INTERNAL_ERROR",
              message: "The request could not be completed.",
              retryable: false,
            },
          });
        }
      } else {
        response.destroy();
      }
    });
  });

  return {
    listen: () =>
      new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(2009, "127.0.0.1", () => {
          server.removeListener("error", reject);
          log(config, "server_started", { origin: config.origin });
          resolveListen();
        });
      }),
    close: () =>
      new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: AppConfig,
  sessions: SessionStore,
  auth: DelegatedAuthService,
  equipment: EquipmentDemoService,
): Promise<void> {
  setSecurityHeaders(response);
  if (request.headers.host !== "localhost:2009") {
    sendJson(response, 421, { error: { code: "INVALID_HOST", message: "Use http://localhost:2009.", retryable: false } });
    return;
  }

  const url = new URL(request.url ?? "/", config.origin);
  if (url.pathname === "/auth/callback" && request.method === "GET") {
    await handleAuthCallback(url, request, response, sessions, auth, config);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (request.method === "POST" && request.headers.origin !== config.origin) {
      sendJson(response, 403, {
        error: { code: "ORIGIN_REJECTED", message: "Request origin was rejected.", retryable: false },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      const { session } = sessions.getOrCreate(readSessionCookie(request));
      setSessionCookie(response, session);
      sendJson(response, 200, statusFor(session, config.agentReady));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth-url") {
      const { session } = sessions.getOrCreate(readSessionCookie(request));
      setSessionCookie(response, session);
      sendJson(response, 200, { url: await auth.createSignInUrl(session) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/equipment/request") {
      const session = requireSession(request, sessions, response);
      if (!session) return;
      const body = await readJsonBody(request);
      const result = await equipment.request(session, body);
      log(config, "equipment_form_ready", { requestId: result.form.requestId });
      sendJson(response, 200, {
        form: result.form,
        surfaceMessages: result.surfaceMessages,
        diagnostics: { requestId: result.form.requestId, protocol: "v0.9", messageCount: result.surfaceMessages.length },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/equipment/submit") {
      const session = requireSession(request, sessions, response);
      if (!session) return;
      const body = await readJsonBody(request);
      const result = await equipment.submit(session, body);
      log(config, "equipment_acknowledged", {
        requestId: result.ack.requestId,
        duplicate: result.duplicate,
      });
      sendJson(response, 200, {
        ack: result.ack,
        duplicate: result.duplicate,
        diagnostics: {
          requestId: result.ack.requestId,
          submissionId: result.ack.submissionId,
          duplicate: result.duplicate,
        },
      });
      return;
    }

    sendJson(response, 404, {
      error: { code: "NOT_FOUND", message: "API route not found.", retryable: false },
    });
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    await serveStatic(url.pathname, request.method, response);
    return;
  }

  sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed.", retryable: false } });
}

function statusFor(session: Session, agentReady: boolean) {
  const workflow = session.workflow;
  return {
    authenticated: Boolean(session.auth && session.auth.expiresOn > Date.now()),
    authError: session.authError ?? null,
    agentReady,
    workflow: {
      phase: workflow.phase,
      requestId: workflowRequestId(workflow),
    },
    runtime: "in-memory",
  };
}

function workflowRequestId(workflow: WorkflowState): string | null {
  return workflow.phase === "new" ? null : workflow.requestId;
}

async function handleAuthCallback(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  sessions: SessionStore,
  auth: DelegatedAuthService,
  config: AppConfig,
): Promise<void> {
  const session = sessions.get(readSessionCookie(request));
  if (!session) {
    sendText(response, 401, "The sign-in session expired. Return to the demo and request a new sign-in link.");
    return;
  }
  setSessionCookie(response, session);
  try {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");
    await auth.completeSignIn(session, {
      ...(code ? { code } : {}),
      ...(state ? { state } : {}),
      ...(error ? { error } : {}),
      ...(errorDescription ? { errorDescription } : {}),
    });
    delete session.authError;
    log(config, "sign_in_succeeded", {});
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "AUTH_FAILED";
    session.authError = code;
    log(config, "sign_in_failed", { code });
  }
  response.statusCode = 302;
  response.setHeader("Location", "/");
  response.end();
}

function requireSession(
  request: IncomingMessage,
  sessions: SessionStore,
  response: ServerResponse,
): Session | undefined {
  const session = sessions.get(readSessionCookie(request));
  if (!session) {
    sendJson(response, 401, {
      error: { code: "SESSION_EXPIRED", message: "The in-memory session expired. Reload the page to restart.", retryable: false },
    });
    return undefined;
  }
  setSessionCookie(response, session);
  return session;
}

function readSessionCookie(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie;
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      const value = valueParts.join("=");
      return /^[A-Za-z0-9_-]{40,64}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}

function setSessionCookie(response: ServerResponse, session: Session): void {
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > BODY_MAX_BYTES) {
      throw new DemoOperationError(413, "BODY_TOO_LARGE", "The request body exceeds the allowed size.");
    }
    chunks.push(buffer);
  }
  const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new DemoOperationError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request as application/json.");
  }
  try {
    return parseStrictJson(Buffer.concat(chunks).toString("utf8"), BODY_MAX_BYTES);
  } catch {
    throw new DemoOperationError(400, "INVALID_JSON", "The request body must be one valid JSON object.");
  }
}

async function serveStatic(pathname: string, method: string, response: ServerResponse): Promise<void> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendText(response, 400, "Invalid path.");
    return;
  }

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const filePath = resolve(PUBLIC_DIR, relativePath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${sep}`)) {
    sendText(response, 404, "Not found.");
    return;
  }

  try {
    await access(filePath);
    const data = await readFile(filePath);
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType(filePath));
    response.setHeader("Cache-Control", filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable");
    response.setHeader("Content-Length", data.length);
    response.end(method === "HEAD" ? undefined : data);
  } catch {
    sendText(response, 404, "Not found.");
  }
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".json": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(body);
}

function log(config: AppConfig, event: string, fields: Record<string, unknown>): void {
  if (config.logLevel === "ERROR" && !event.endsWith("_failed")) return;
  if (config.logLevel === "WARN" && event === "server_started") return;
  console.log(`${new Date().toISOString()} | ${config.logLevel} | ${JSON.stringify({ event, ...fields })}`);
}

function safePath(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const app = createDemoServer();
  void app.listen().catch((error: unknown) => {
    console.error("Server startup failed.", error instanceof Error ? error.name : "UnknownError");
    process.exitCode = 1;
  });
}
