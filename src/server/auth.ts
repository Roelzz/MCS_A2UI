import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  PublicClientApplication,
  type AccountInfo,
} from "@azure/msal-node";
import type { AppConfig } from "./config.js";
import type { AuthState, Session } from "./session-store.js";

export class AuthRequiredError extends Error {
  constructor() {
    super("Sign in is required.");
    this.name = "AuthRequiredError";
  }
}

export class AuthCallbackError extends Error {
  constructor(
    readonly code: "STATE_INVALID" | "AUTH_CANCELLED" | "CONSENT_REQUIRED" | "AUTH_FAILED",
  ) {
    super("Sign-in could not be completed.");
    this.name = "AuthCallbackError";
  }
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function isMatchingState(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

export class DelegatedAuthService {
  private readonly application: PublicClientApplication;

  constructor(private readonly config: AppConfig) {
    this.application = new PublicClientApplication({
      auth: {
        clientId: config.clientId,
        authority: `${config.authorityUrl}/${config.tenantId}`,
      },
    });
  }

  async createSignInUrl(session: Session): Promise<string> {
    const state = randomBytes(32).toString("base64url");
    const pkce = createPkcePair();
    session.pendingAuth = { state, codeVerifier: pkce.verifier };
    delete session.authError;

    return this.application.getAuthCodeUrl({
      scopes: [this.config.tokenScope],
      redirectUri: this.config.redirectUri,
      state,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: "S256",
      prompt: "select_account",
    });
  }

  async completeSignIn(
    session: Session,
    parameters: { code?: string; state?: string; error?: string; errorDescription?: string },
  ): Promise<void> {
    const pending = session.pendingAuth;
    delete session.pendingAuth;
    if (!pending || !parameters.state || !isMatchingState(pending.state, parameters.state)) {
      throw new AuthCallbackError("STATE_INVALID");
    }

    if (parameters.error) {
      const description = parameters.errorDescription?.toLowerCase() ?? "";
      if (
        parameters.error === "consent_required" ||
        description.includes("aadsts65001") ||
        description.includes("consent")
      ) {
        throw new AuthCallbackError("CONSENT_REQUIRED");
      }
      if (parameters.error === "access_denied") {
        throw new AuthCallbackError("AUTH_CANCELLED");
      }
      throw new AuthCallbackError("AUTH_FAILED");
    }
    if (!parameters.code || parameters.code.length > 8192) {
      throw new AuthCallbackError("AUTH_FAILED");
    }

    try {
      const result = await this.application.acquireTokenByCode({
        code: parameters.code,
        scopes: [this.config.tokenScope],
        redirectUri: this.config.redirectUri,
        state: pending.state,
        codeVerifier: pending.codeVerifier,
      });
      if (!result.accessToken || !result.account) {
        throw new AuthCallbackError("AUTH_FAILED");
      }
      session.auth = toAuthState(result.account, result.accessToken, result.expiresOn);
      delete session.authError;
    } catch (error) {
      if (error instanceof AuthCallbackError) {
        throw error;
      }
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("aadsts65001") || message.includes("consent_required")) {
        throw new AuthCallbackError("CONSENT_REQUIRED");
      }
      throw new AuthCallbackError("AUTH_FAILED");
    }
  }

  async getAccessToken(session: Session): Promise<string> {
    const auth = session.auth;
    if (!auth) {
      throw new AuthRequiredError();
    }
    if (auth.expiresOn > Date.now() + 60_000) {
      return auth.accessToken;
    }
    try {
      const result = await this.application.acquireTokenSilent({
        account: auth.account,
        scopes: [this.config.tokenScope],
      });
      if (!result.accessToken || !result.account) {
        throw new AuthRequiredError();
      }
      session.auth = toAuthState(result.account, result.accessToken, result.expiresOn);
      return result.accessToken;
    } catch {
      delete session.auth;
      throw new AuthRequiredError();
    }
  }
}

function toAuthState(
  account: AccountInfo,
  accessToken: string,
  expiresOn: Date | null,
): AuthState {
  return {
    account,
    accessToken,
    expiresOn: expiresOn?.getTime() ?? 0,
  };
}
