import { randomBytes } from "node:crypto";
import type { AccountInfo } from "@azure/msal-node";
import type { A2uiMessage } from "@a2ui/web_core/v0_9";
import type { Scenario } from "./contracts.js";

export interface AuthState {
  account: AccountInfo;
  accessToken: string;
  expiresOn: number;
}

export interface PendingAuth {
  state: string;
  codeVerifier: string;
}

export interface TurnDiagnostics {
  turnId: string;
  request: Record<string, unknown>;
  responseType: "ui" | "text" | "error";
  responseBytes: number;
  latencyMs: number;
  correctionUsed: boolean;
  selfReportedSkill?: string;
  surfaceId?: string;
  revision?: number;
  componentCount?: number;
  serverActions?: string[];
}

export type TranscriptEntry =
  | { kind: "user"; text: string; at: number }
  | { kind: "action"; surfaceId: string; name: string; summary: string; at: number }
  | { kind: "agent_text"; text: string; turnId: string; error: boolean; diagnostics: TurnDiagnostics; at: number }
  | {
      kind: "agent_ui";
      text: string;
      turnId: string;
      scenario: Scenario;
      skill: string;
      surfaceId: string;
      revision: number;
      messages: A2uiMessage[];
      diagnostics: TurnDiagnostics;
      at: number;
    }
  | { kind: "notice"; level: "error" | "warning"; code: string; text: string; at: number };

export interface OwnedSurface {
  scenario: Scenario;
  revision: number;
  serverActions: ReadonlySet<string>;
}

export interface ConversationState {
  conversationId?: string;
  status: "idle" | "starting" | "busy";
  transcript: TranscriptEntry[];
  surfaces: Map<string, OwnedSurface>;
  seenActionIds: Set<string>;
}

export interface Session {
  readonly id: string;
  expiresAt: number;
  auth?: AuthState;
  pendingAuth?: PendingAuth;
  authError?: string;
  conversation: ConversationState;
  queue: Promise<void>;
}

export function newConversation(): ConversationState {
  return { status: "idle", transcript: [], surfaces: new Map(), seenActionIds: new Set() };
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
      conversation: newConversation(),
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
