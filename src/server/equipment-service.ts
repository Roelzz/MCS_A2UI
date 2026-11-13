import { randomBytes, randomUUID } from "node:crypto";
import {
  ContractError,
  equipmentAckSchema,
  equipmentErrorSchema,
  equipmentFormSchema,
  initialRequestSchema,
  parseStrictJson,
  submitRequestSchema,
  type EquipmentAck,
  type EquipmentForm,
} from "./contracts.js";
import { createEquipmentSurface } from "./a2ui.js";
import { D2EProtocolError, type AgentTransport } from "./d2e.js";
import { SessionStore, type Session } from "./session-store.js";

const TURN_TIMEOUT_MS = 30_000;
const RESPONSE_MAX_BYTES = 4_096;
const ACK_PREFIX = "Demo request received — nothing was purchased or submitted.";

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

export class EquipmentDemoService {
  constructor(
    private readonly sessions: SessionStore,
    private readonly getToken: TokenProvider,
    private readonly createTransport: AgentTransportFactory,
    private readonly agentReady: boolean,
    private readonly timeoutMs = TURN_TIMEOUT_MS,
  ) {}

  async request(session: Session, rawInput: unknown): Promise<{
    form: EquipmentForm;
    surfaceMessages: ReturnType<typeof createEquipmentSurface>;
  }> {
    const input = initialRequestSchema.safeParse(rawInput);
    if (!input.success) {
      throw new DemoOperationError(400, "INVALID_REQUEST", "Enter a nonblank request of at most 1000 characters.", {
        userText: "Enter a nonblank request of at most 1000 characters.",
      });
    }
    if (!this.agentReady) {
      throw new DemoOperationError(
        503,
        "AGENT_NOT_READY",
        "The connected agent configuration has not been validated and published for this demo.",
      );
    }

    return this.sessions.runExclusive(session, async () => {
      if (session.workflow.phase !== "new") {
        throw new DemoOperationError(
          409,
          "SESSION_ALREADY_USED",
          "This in-memory session already has an equipment request. Restart the app to begin a new demo.",
        );
      }

      const requestId = randomUUID();
      const contextMarker = randomBytes(16).toString("hex");
      let transport: AgentTransport;
      try {
        transport = this.createTransport(await this.getToken(session));
      } catch (error) {
        throw toOperationError(error, "request");
      }
      session.workflow = { phase: "starting", requestId, contextMarker };

      try {
        const conversationId = await withTimeout(
          transport.startConversation(),
          this.timeoutMs,
        );
        if (!conversationId) {
          throw new Error("D2E start omitted conversation ID.");
        }

        session.workflow = {
          phase: "sending_initial",
          requestId,
          contextMarker,
          conversationId,
        };
        const envelope = {
          version: 1,
          type: "equipment_request",
          requestId,
          contextMarker,
          userText: input.data.userText,
        };
        const response = await sendWithOneProtocolCorrection(
          transport,
          conversationId,
          envelope,
          this.timeoutMs,
          (responseText) => parseEquipmentForm(responseText, requestId, contextMarker),
        );
        session.workflow = {
          phase: "form_ready",
          requestId,
          contextMarker,
          conversationId,
          form: response,
        };
        return {
          form: response,
          surfaceMessages: createEquipmentSurface(response),
        };
      } catch (error) {
        session.workflow = {
          phase: "uncertain",
          operation: "request",
          requestId,
          contextMarker,
          ...(session.workflow.phase === "sending_initial"
            ? { conversationId: session.workflow.conversationId }
            : {}),
        };
        throw toOperationError(error, "request");
      }
    });
  }

  async submit(session: Session, rawInput: unknown): Promise<{
    ack: EquipmentAck;
    duplicate: boolean;
  }> {
    const input = submitRequestSchema.safeParse(rawInput);
    if (!input.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of input.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string") {
          fieldErrors[key] ??= "Choose a supported device and enter a nonblank justification of at most 1000 characters.";
        }
      }
      throw new DemoOperationError(
        400,
        "INVALID_SUBMISSION",
        "The demo submission contains invalid fields.",
        fieldErrors,
      );
    }
    if (!this.agentReady) {
      throw new DemoOperationError(
        503,
        "AGENT_NOT_READY",
        "The connected agent configuration has not been validated and published for this demo.",
      );
    }

    return this.sessions.runExclusive(session, async () => {
      const workflow = session.workflow;
      if (workflow.phase === "completed") {
        if (
          workflow.requestId === input.data.requestId &&
          workflow.device === input.data.device &&
          workflow.justification === input.data.justification
        ) {
          return { ack: workflow.ack, duplicate: true };
        }
        throw new DemoOperationError(409, "SUBMISSION_ALREADY_COMPLETED", "This demo request has already been submitted.");
      }

      if (workflow.phase === "rejected") {
        if (
          workflow.requestId === input.data.requestId &&
          workflow.device === input.data.device &&
          workflow.justification === input.data.justification
        ) {
          throw new DemoOperationError(
            422,
            "AGENT_REJECTED",
            "The agent rejected the demo submission.",
            workflow.fieldErrors,
          );
        }
      } else if (workflow.phase !== "form_ready") {
        throw new DemoOperationError(
          409,
          "SUBMISSION_NOT_AVAILABLE",
          "A confirmed form is required before submitting.",
        );
      }

      if (workflow.requestId !== input.data.requestId) {
        throw new DemoOperationError(409, "REQUEST_MISMATCH", "The request does not match this session.");
      }

      const submissionId = randomUUID();
      let transport: AgentTransport;
      try {
        transport = this.createTransport(await this.getToken(session));
      } catch (error) {
        throw toOperationError(error, "submit");
      }
      const submissionState = {
        phase: "submitting" as const,
        requestId: workflow.requestId,
        contextMarker: workflow.contextMarker,
        conversationId: workflow.conversationId,
        form: workflow.form,
        submissionId,
        device: input.data.device,
        justification: input.data.justification,
      };
      session.workflow = submissionState;

      try {
        const envelope = {
          version: 1,
          type: "equipment_submit",
          requestId: workflow.requestId,
          submissionId,
          device: input.data.device,
          justification: input.data.justification,
        };
        const ack = await sendWithOneProtocolCorrection(
          transport,
          workflow.conversationId,
          envelope,
          this.timeoutMs,
          (responseText) => {
            const decoded = parseResponse(responseText);
            const rejection = equipmentErrorSchema.safeParse(decoded);
            if (rejection.success) {
              if (
                rejection.data.requestId !== workflow.requestId ||
                rejection.data.submissionId !== submissionId
              ) {
                throw new InvalidAgentResponseError("Agent rejection correlation did not match.");
              }
              session.workflow = {
                ...submissionState,
                phase: "rejected",
                fieldErrors: rejection.data.fieldErrors,
              };
              throw new DemoOperationError(
                422,
                "AGENT_REJECTED",
                "The agent rejected the demo submission.",
                rejection.data.fieldErrors,
              );
            }

            const result = equipmentAckSchema.safeParse(decoded);
            if (!result.success) {
              throw new InvalidAgentResponseError("Agent acknowledgment did not match the demo contract.");
            }
            if (
              result.data.requestId !== workflow.requestId ||
              result.data.submissionId !== submissionId ||
              result.data.device !== input.data.device ||
              result.data.justification !== input.data.justification ||
              result.data.message !== `${ACK_PREFIX} Context check: ${workflow.contextMarker}`
            ) {
              throw new InvalidAgentResponseError("Agent acknowledgment did not satisfy the demo contract.");
            }
            return result.data;
          }
        );

        session.workflow = {
          phase: "completed",
          requestId: workflow.requestId,
          contextMarker: workflow.contextMarker,
          conversationId: workflow.conversationId,
          form: workflow.form,
          submissionId,
          device: input.data.device,
          justification: input.data.justification,
          ack,
        };
        return { ack, duplicate: false };
      } catch (error) {
        if (error instanceof DemoOperationError && error.code === "AGENT_REJECTED") {
          throw error;
        }
        session.workflow = {
          phase: "uncertain",
          operation: "submit",
          requestId: workflow.requestId,
          contextMarker: workflow.contextMarker,
          conversationId: workflow.conversationId,
          form: workflow.form,
          submissionId,
          device: input.data.device,
          justification: input.data.justification,
        };
        throw toOperationError(error, "submit");
      }
    });
  }
}

function parseEquipmentForm(
  responseText: string,
  expectedRequestId: string,
  contextMarker: string,
): EquipmentForm {
  const decoded = parseResponse(responseText);
  const form = equipmentFormSchema.safeParse(decoded);
  if (form.success) {
    if (
      form.data.requestId !== expectedRequestId ||
      JSON.stringify(form.data).includes(contextMarker)
    ) {
      throw new InvalidAgentResponseError("Agent form correlation or marker privacy check failed.");
    }
    return form.data;
  }

  const rejection = equipmentErrorSchema.safeParse(decoded);
  if (
    rejection.success &&
    rejection.data.requestId === expectedRequestId &&
    rejection.data.submissionId === ""
  ) {
    throw new DemoOperationError(
      422,
      "AGENT_REJECTED",
      "The agent rejected the demo request.",
      rejection.data.fieldErrors,
    );
  }
  throw new InvalidAgentResponseError("Agent response did not match an equipment form envelope.");
}

function parseResponse(responseText: string): unknown {
  return parseStrictJson(responseText, RESPONSE_MAX_BYTES);
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

async function sendWithOneProtocolCorrection<T>(
  transport: AgentTransport,
  conversationId: string,
  envelope: object,
  timeoutMs: number,
  parse: (responseText: string) => T,
): Promise<T> {
  const requestText = JSON.stringify(envelope);
  const firstResponse = await withTimeout(
    transport.sendMessage(conversationId, requestText),
    timeoutMs,
  );
  try {
    return parse(firstResponse);
  } catch (error) {
    if (error instanceof DemoOperationError) {
      throw error;
    }
    if (!(error instanceof ContractError) && !(error instanceof InvalidAgentResponseError)) {
      throw error;
    }
  }

  // Retry only after a received response fails contract validation; transport failures are uncertain and never replayed.
  const correctedResponse = await withTimeout(
    transport.sendMessage(conversationId, requestText),
    timeoutMs,
  );
  return parse(correctedResponse);
}

function toOperationError(error: unknown, operation: "request" | "submit"): DemoOperationError {
  if (error instanceof DemoOperationError) {
    return error;
  }
  if (error instanceof TurnTimeoutError) {
    return new DemoOperationError(
      504,
      "UPSTREAM_TIMEOUT",
      `The ${operation} turn timed out. Its outcome is uncertain; do not retry it.`,
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
    return new DemoOperationError(
      502,
      "UPSTREAM_PROTOCOL",
      `The ${operation} response failed JSON validation (${error.code}).`,
    );
  }
  if (error instanceof InvalidAgentResponseError) {
    return new DemoOperationError(
      502,
      "UPSTREAM_PROTOCOL",
      `The ${operation} response failed equipment-envelope or correlation validation.`,
    );
  }
  return new DemoOperationError(
    502,
    "UPSTREAM_PROTOCOL",
    `The ${operation} turn did not return a valid equipment protocol response.`,
  );
}
