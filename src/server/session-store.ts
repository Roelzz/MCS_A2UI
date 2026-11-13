import { randomBytes } from "node:crypto";
import type { AccountInfo } from "@azure/msal-node";
import type { Device, EquipmentAck, EquipmentForm } from "./contracts.js";

export interface AuthState {
  account: AccountInfo;
  accessToken: string;
  expiresOn: number;
}

export interface PendingAuth {
  state: string;
  codeVerifier: string;
}

export type WorkflowState =
  | { phase: "new" }
  | { phase: "starting"; requestId: string; contextMarker: string }
  | {
      phase: "sending_initial";
      requestId: string;
      contextMarker: string;
      conversationId: string;
    }
  | {
      phase: "form_ready";
      requestId: string;
      contextMarker: string;
      conversationId: string;
      form: EquipmentForm;
    }
  | {
      phase: "submitting";
      requestId: string;
      contextMarker: string;
      conversationId: string;
      form: EquipmentForm;
      submissionId: string;
      device: Device;
      justification: string;
    }
  | {
      phase: "completed";
      requestId: string;
      contextMarker: string;
      conversationId: string;
      form: EquipmentForm;
      submissionId: string;
      device: Device;
      justification: string;
      ack: EquipmentAck;
    }
  | {
      phase: "rejected";
      requestId: string;
      contextMarker: string;
      conversationId: string;
      form: EquipmentForm;
      submissionId: string;
      device: Device;
      justification: string;
      fieldErrors: Record<string, string>;
    }
  | {
      phase: "uncertain";
      operation: "request" | "submit";
      requestId: string;
      contextMarker: string;
      conversationId?: string;
      form?: EquipmentForm;
      submissionId?: string;
      device?: Device;
      justification?: string;
    };

export interface Session {
  readonly id: string;
  expiresAt: number;
  auth?: AuthState;
  pendingAuth?: PendingAuth;
  authError?: string;
  workflow: WorkflowState;
  queue: Promise<void>;
}

const SESSION_TTL_MS = 30 * 60 * 1000;

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(): Session {
    this.pruneExpired();
    const id = randomBytes(32).toString("base64url");
    const session: Session = {
      id,
      expiresAt: Date.now() + SESSION_TTL_MS,
      workflow: { phase: "new" },
      queue: Promise.resolve(),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string | undefined): Session | undefined {
    if (!id) {
      return undefined;
    }
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
  }

  getOrCreate(id: string | undefined): { session: Session; created: boolean } {
    const existing = this.get(id);
    if (existing) {
      return { session: existing, created: false };
    }
    return { session: this.create(), created: true };
  }

  async runExclusive<T>(session: Session, action: () => Promise<T>): Promise<T> {
    const result = session.queue.then(action, action);
    session.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
      }
    }
  }
}
