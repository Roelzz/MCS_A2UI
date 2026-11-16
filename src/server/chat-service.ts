import { randomUUID } from "node:crypto";
import {
  actionInputSchema,
  agentResponseSchema,
  chatInputSchema,
  ContractError,
  parseStrictJson,
  type AgentResponse,
} from "./contracts.js";
import { A2uiValidationError, validateAgentSurface, type ValidatedSurface } from "./a2ui-validator.js";
import { D2EProtocolError, type AgentTransport } from "./d2e.js";
import {
  newConversation,
  SessionStore,
  type Session,
  type TranscriptEntry,
  type TurnDiagnostics,
} from "./session-store.js";

const TURN_TIMEOUT_MS = 90_000;
const RESPONSE_MAX_BYTES = 65_536;
const TRANSCRIPT_MAX_ENTRIES = 80;

export class DemoOperationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "DemoOperationError";
  }
}

class TurnTimeoutError extends Error {
  constructor() {
    super("The D2E turn exceeded its timeout.");
    this.name = "TurnTimeoutError";
  }
}

class InvalidAgentResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentResponseError";
  }
}

export type TokenProvider = (session: Session) => Promise<string>;
export type AgentTransportFactory = (accessToken: string) => AgentTransport;

interface ParsedTurn {
  response: AgentResponse;
  surface?: ValidatedSurface;
  bytes: number;
}

export class ChatDemoService {
  constructor(
    private readonly sessions: SessionStore,
    private readonly getToken: TokenProvider,
    private readonly createTransport: AgentTransportFactory,
    private readonly agentReady: boolean,
    private readonly timeoutMs = TURN_TIMEOUT_MS,
  ) {}

  snapshot(session: Session) {
    const conversation = session.conversation;
    return {
      started: Boolean(conversation.conversationId),
      status: conversation.status,
      transcript: conversation.transcript,
      surfaces: Object.fromEntries(
        [...conversation.surfaces].map(([id, surface]) => [id, { scenario: surface.scenario, revision: surface.revision }]),
      ),
    };
  }

  async reset(session: Session): Promise<void> {
    if (session.conversation.status === "busy" || session.conversation.status === "starting") {
      throw new DemoOperationError(409, "TURN_IN_FLIGHT", "Wait for the current agent turn to finish before restarting.");
    }
    await this.sessions.runExclusive(session, async () => {
      session.conversation = newConversation();
    });
  }

  async start(session: Session): Promise<TranscriptEntry[]> {
    this.requireReady();
    return this.sessions.runExclusive(session, async () => {
      const conversation = session.conversation;
      if (conversation.conversationId) {
        return [];
      }
      const transport = await this.transportFor(session);
      conversation.status = "starting";
      try {
        const conversationId = await withTimeout(transport.startConversation(), this.timeoutMs);
        conversation.conversationId = conversationId;
        conversation.status = "busy";
        const entry = await this.runTurn(session, transport, { type: "hello" });
        conversation.status = "idle";
        return [entry];
      } catch (error) {
        throw this.recordFailure(session, error, "welcome");
      }
    });
  }

  async chat(session: Session, rawInput: unknown): Promise<TranscriptEntry[]> {
    const input = chatInputSchema.safeParse(rawInput);
    if (!input.success) {
      throw new DemoOperationError(400, "INVALID_MESSAGE", "Enter a nonblank message of at most 1000 characters.", {
        text: "Enter a nonblank message of at most 1000 characters.",
      });
    }
    this.requireReady();
    return this.sessions.runExclusive(session, async () => {
      const conversation = this.requireConversation(session);
      const transport = await this.transportFor(session);
      const userEntry: TranscriptEntry = { kind: "user", text: input.data.text, at: Date.now() };
      this.append(session, userEntry);
      conversation.status = "busy";
      try {
        const entry = await this.runTurn(session, transport, { type: "chat", text: input.data.text });
        conversation.status = "idle";
        return [userEntry, entry];
      } catch (error) {
        throw this.recordFailure(session, error, "chat");
      }
    });
  }

  async action(session: Session, rawInput: unknown): Promise<TranscriptEntry[]> {
    const input = actionInputSchema.safeParse(rawInput);
    if (!input.success) {
      throw new DemoOperationError(400, "INVALID_ACTION", "The A2UI action payload is invalid.");
    }
    if (Buffer.byteLength(JSON.stringify(input.data.context), "utf8") > 4_096) {
      throw new DemoOperationError(400, "INVALID_ACTION", "The A2UI action context is too large.");
    }
    this.requireReady();
    return this.sessions.runExclusive(session, async () => {
      const conversation = this.requireConversation(session);
      const { actionId, surfaceId, revision, name, context } = input.data;
      if (conversation.seenActionIds.has(actionId)) {
        throw new DemoOperationError(409, "DUPLICATE_ACTION", "This action was already sent. It is never replayed.");
      }
      const surface = conversation.surfaces.get(surfaceId);
      if (!surface) {
        throw new DemoOperationError(409, "UNKNOWN_SURFACE", "This surface does not belong to the current conversation.");
      }
      if (surface.revision !== revision) {
        throw new DemoOperationError(409, "STALE_SURFACE", "This surface was already updated. Use the latest version.");
      }
      if (!surface.serverActions.has(name)) {
        throw new DemoOperationError(409, "UNDECLARED_ACTION", "The agent did not declare this action on the surface.");
      }
      conversation.seenActionIds.add(actionId);
      // Lock the rendered revision before sending so an uncertain turn can never be clicked again.
      surface.revision += 1;
      const transport = await this.transportFor(session);
      const actionEntry: TranscriptEntry = {
        kind: "action",
        surfaceId,
        name,
        summary: summarizeAction(name, context),
        at: Date.now(),
      };
      this.append(session, actionEntry);
      conversation.status = "busy";
      try {
        const entry = await this.runTurn(session, transport, { type: "ui_action", surfaceId, name, context });
        conversation.status = "idle";
        return [actionEntry, entry];
      } catch (error) {
        throw this.recordFailure(session, error, "action");
      }
    });
  }

  private async runTurn(
    session: Session,
    transport: AgentTransport,
    body: Record<string, unknown>,
  ): Promise<TranscriptEntry> {
    const conversation = session.conversation;
    const conversationId = conversation.conversationId;
    if (!conversationId) {
      throw new DemoOperationError(409, "NO_CONVERSATION", "Start the conversation first.");
    }
    const turnId = randomUUID();
    const request = { version: 2, ...body, turnId };
    const startedAt = Date.now();
    const parse = (text: string) => parseAgentTurn(text, turnId);

    let parsed: ParsedTurn;
    let correctionUsed = false;
    const first = await withTimeout(transport.sendMessage(conversationId, JSON.stringify(request)), this.timeoutMs);
    try {
      parsed = parse(first);
    } catch (error) {
      if (!isContractFailure(error)) throw error;
      // One bounded correction only after a received response fails validation; transport failures are never replayed.
      correctionUsed = true;
      const correction = { version: 2, type: "correction", turnId, problem: correctionReason(error) };
      const second = await withTimeout(transport.sendMessage(conversationId, JSON.stringify(correction)), this.timeoutMs);
      parsed = parse(second);
    }

    const diagnostics: TurnDiagnostics = {
      turnId,
      request: { ...request },
      responseType: parsed.response.type,
      responseBytes: parsed.bytes,
      latencyMs: Date.now() - startedAt,
      correctionUsed,
    };

    let entry: TranscriptEntry;
    if (parsed.response.type === "ui" && parsed.surface) {
      const surfaceId = parsed.surface.surfaceId;
      const existing = conversation.surfaces.get(surfaceId);
      if (existing && existing.scenario !== parsed.response.scenario) {
        throw new InvalidAgentResponseError("Surface scenario changed.");
      }
      const revision = (existing?.revision ?? 0) + 1;
      conversation.surfaces.set(surfaceId, {
        scenario: parsed.response.scenario,
        revision,
        serverActions: new Set(parsed.surface.serverActions),
      });
      entry = {
        kind: "agent_ui",
        text: parsed.response.text,
        turnId,
        scenario: parsed.response.scenario,
        skill: parsed.response.skill,
        surfaceId,
        revision,
        messages: parsed.surface.messages,
        diagnostics: {
          ...diagnostics,
          selfReportedSkill: parsed.response.skill,
          surfaceId,
          revision,
          componentCount: parsed.surface.componentCount,
          serverActions: parsed.surface.serverActions,
        },
        at: Date.now(),
      };
    } else if (parsed.response.type === "text") {
      entry = { kind: "agent_text", text: parsed.response.text, turnId, error: false, diagnostics, at: Date.now() };
    } else if (parsed.response.type === "error") {
      entry = { kind: "agent_text", text: parsed.response.message, turnId, error: true, diagnostics, at: Date.now() };
    } else {
      throw new InvalidAgentResponseError("Agent response type is unsupported.");
    }
    this.append(session, entry);
    return entry;
  }

  private requireReady(): void {
    if (!this.agentReady) {
      throw new DemoOperationError(
        503,
        "AGENT_NOT_READY",
        "The connected agent configuration has not been validated and published for this demo.",
      );
    }
  }

  private requireConversation(session: Session) {
    const conversation = session.conversation;
    if (!conversation.conversationId) {
      throw new DemoOperationError(409, "NO_CONVERSATION", "Start the conversation first.");
    }
    return conversation;
  }

  private async transportFor(session: Session): Promise<AgentTransport> {
    try {
      return this.createTransport(await this.getToken(session));
    } catch (error) {
      throw toOperationError(error, "turn");
    }
  }

  private append(session: Session, entry: TranscriptEntry): void {
    const transcript = session.conversation.transcript;
    transcript.push(entry);
    if (transcript.length > TRANSCRIPT_MAX_ENTRIES) {
      transcript.splice(0, transcript.length - TRANSCRIPT_MAX_ENTRIES);
    }
  }

  private recordFailure(session: Session, error: unknown, operation: string): DemoOperationError {
    const operationError = toOperationError(error, operation);
    const uncertain = operationError.code === "UPSTREAM_TIMEOUT" || operationError.code === "UPSTREAM_TRANSPORT";
    session.conversation.status = "idle";
    this.append(session, {
      kind: "notice",
      level: uncertain ? "warning" : "error",
      code: operationError.code,
      text: operationError.message,
      at: Date.now(),
    });
    return operationError;
  }
}

export function parseAgentTurn(responseText: string, turnId: string): ParsedTurn {
  const json = unwrapSingleFence(responseText.trim());
  const decoded = parseStrictJson(json, RESPONSE_MAX_BYTES);
  const result = agentResponseSchema.safeParse(decoded);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new InvalidAgentResponseError(
      `envelope field ${issue?.path.join(".") || "(root)"} is invalid: ${issue?.message ?? "schema mismatch"}`,
    );
  }
  if (result.data.turnId !== turnId) {
    throw new InvalidAgentResponseError("turnId must echo the request turnId");
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (result.data.type === "ui") {
    return { response: result.data, surface: validateAgentSurface(result.data.scenario, result.data.messages), bytes };
  }
  return { response: result.data, bytes };
}

function unwrapSingleFence(text: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(text);
  return fenced?.[1] ?? text;
}

function isContractFailure(error: unknown): boolean {
  return (
    error instanceof ContractError ||
    error instanceof InvalidAgentResponseError ||
    error instanceof A2uiValidationError
  );
}

function correctionReason(error: unknown): string {
  if (error instanceof ContractError) {
    return `Response was not exactly one strict JSON object (${error.code}). Reply with one v2 JSON object only.`;
  }
  return error instanceof Error ? error.message.slice(0, 300) : "Response did not match the v2 contract.";
}

function summarizeAction(name: string, context: Record<string, unknown>): string {
  const parts = Object.entries(context)
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value.slice(0, 60) : JSON.stringify(value)}`);
  return parts.length > 0 ? `${name} (${parts.join(", ")})` : name;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TurnTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function toOperationError(error: unknown, operation: string): DemoOperationError {
  if (error instanceof DemoOperationError) {
    return error;
  }
  if (error instanceof TurnTimeoutError) {
    return new DemoOperationError(
      504,
      "UPSTREAM_TIMEOUT",
      `The ${operation} turn timed out. Its outcome is uncertain; it was not retried.`,
    );
  }
  if (error instanceof Error && error.name === "AuthRequiredError") {
    return new DemoOperationError(401, "AUTH_REQUIRED", "Sign in again before continuing.");
  }
  if (error instanceof Error && "code" in error && typeof error.code === "number") {
    const sdkCode = error.code;
    if (Number.isInteger(sdkCode) && sdkCode <= -140000 && sdkCode >= -140999) {
      const status = sdkCode === -140032
        ? /Copilot Studio request failed with status ([45]\d{2})\b/.exec(error.message)?.[1]
        : undefined;
      return new DemoOperationError(
        502,
        "UPSTREAM_TRANSPORT",
        `The ${operation} turn failed in the D2E SDK (code ${sdkCode}${status ? `, HTTP ${status}` : ""}).`,
      );
    }
  }
  const safeProtocolMessages = new Set([
    "D2E start response omitted conversation metadata.",
    "A conversation ID is required for every D2E turn.",
    "D2E response conversation did not match the request.",
    "D2E must return exactly one ordinary text activity.",
    "D2E response did not contain plain message text.",
  ]);
  if (error instanceof D2EProtocolError && safeProtocolMessages.has(error.message)) {
    return new DemoOperationError(
      502,
      "UPSTREAM_PROTOCOL",
      `The ${operation} turn failed: ${error.message}${error.activitySummary ? ` Activity counts: ${JSON.stringify(error.activitySummary)}.` : ""}`,
    );
  }
  if (error instanceof ContractError) {
    return new DemoOperationError(502, "UPSTREAM_PROTOCOL", `The agent ${operation} response was not strict JSON (${error.code}), even after one correction.`);
  }
  if (error instanceof InvalidAgentResponseError || error instanceof A2uiValidationError) {
    return new DemoOperationError(
      502,
      "UPSTREAM_PROTOCOL",
      `The agent ${operation} response was rejected after one correction: ${error.message.slice(0, 240)}`,
    );
  }
  return new DemoOperationError(502, "UPSTREAM_PROTOCOL", `The ${operation} turn did not return a valid v2 response.`);
}
