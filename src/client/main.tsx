import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { A2uiSurface, type ReactCatalogComponent } from "@a2ui/react/v0_9";
import {
  MessageProcessor,
  type A2uiMessage,
  type ActionPayload,
} from "@a2ui/web_core/v0_9";
import { basicCatalog, injectBasicCatalogStyles } from "@a2ui/web_core/v0_9/basic_catalog";
import "./styles.css";

type Status = {
  authenticated: boolean;
  authError: string | null;
  agentReady: boolean;
  workflow: { phase: string; requestId: string | null };
  runtime: "in-memory";
};

type ApiFailure = {
  code: string;
  message: string;
  retryable: boolean;
  fieldErrors?: Record<string, string>;
};

type Diagnostic = {
  label: string;
  requestId?: string;
  submissionId?: string;
  detail?: string;
};

type FormResponse = {
  form: { requestId: string };
  surfaceMessages: A2uiMessage[];
  diagnostics: { requestId: string; protocol: string; messageCount: number };
};

type SubmitResponse = {
  ack: {
    device: string;
    justification: string;
    message: string;
  };
  duplicate: boolean;
  diagnostics: { requestId: string; submissionId: string; duplicate: boolean };
};

const DEMO_DISCLAIMER = "Demo request received — nothing was purchased or submitted.";

function App() {
  const [processor] = useState(() => new MessageProcessor<ReactCatalogComponent>([basicCatalog]));
  const [surfaces, setSurfaces] = useState(() => Array.from(processor.model.surfacesMap.values()));
  const [status, setStatus] = useState<Status | null>(null);
  const [userText, setUserText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [ack, setAck] = useState<SubmitResponse["ack"] | null>(null);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const requestIdRef = useRef<string | null>(null);
  const busyRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("Status could not be loaded.");
    setStatus((await response.json()) as Status);
  }, []);

  useEffect(() => {
    injectBasicCatalogStyles();
    const sync = () => setSurfaces(Array.from(processor.model.surfacesMap.values()));
    const created = processor.onSurfaceCreated(sync);
    const deleted = processor.onSurfaceDeleted(sync);
    void refreshStatus().catch(() => {
      setError({ code: "APP_UNAVAILABLE", message: "The local demo server is unavailable.", retryable: true });
    });
    return () => {
      created.unsubscribe();
      deleted.unsubscribe();
      processor.dispose();
    };
  }, [processor, refreshStatus]);

  useEffect(() => {
    if (!signInUrl || status?.authenticated) return;
    const timer = window.setInterval(() => {
      void refreshStatus().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refreshStatus, signInUrl, status?.authenticated]);

  useEffect(() => {
    if (status?.authError) setSignInUrl(null);
  }, [status?.authError]);

  const submitForm = useCallback(
    async (context: Record<string, unknown>) => {
      if (busyRef.current || !requestIdRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setAck(null);
      const deviceSelection = context.deviceSelection;
      const device = Array.isArray(deviceSelection) ? deviceSelection[0] : deviceSelection;
      const justification = context.justification;
      try {
        const result = await postJson<SubmitResponse>("/api/equipment/submit", {
          requestId: requestIdRef.current,
          device,
          justification,
        });
        setAck(result.ack);
        setDiagnostics((current) => [
          ...current,
          {
            label: result.duplicate ? "Duplicate submit suppressed" : "Agent acknowledgment validated",
            requestId: result.diagnostics.requestId,
            submissionId: result.diagnostics.submissionId,
          },
        ]);
        if (result.duplicate) {
          setError({
            code: "DUPLICATE_SUPPRESSED",
            message: "This submission was already received; no additional agent turn was sent.",
            retryable: false,
          });
        }
        await refreshStatus();
      } catch (caught) {
        setError(toApiFailure(caught));
        if (caught instanceof ApiRequestError && caught.failure.code === "UPSTREAM_TIMEOUT") {
          setDiagnostics((current) => [
            ...current,
              {
                label: "Submission outcome uncertain; retry disabled",
                ...(requestIdRef.current ? { requestId: requestIdRef.current } : {}),
              },
          ]);
        }
        await refreshStatus().catch(() => undefined);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [refreshStatus],
  );

  useEffect(() => {
    const subscription = processor.model.onAction.subscribe((action: ActionPayload) => {
      if (action.surfaceId !== "equipment-request" || action.name !== "equipment_submit") {
        setError({
          code: "UNSUPPORTED_ACTION",
          message: "The A2UI surface emitted an unsupported action.",
          retryable: false,
        });
        return;
      }
      void submitForm(action.context);
    });
    return () => subscription.unsubscribe();
  }, [processor, submitForm]);

  async function createForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setAck(null);
    setSignInUrl(null);
    requestIdRef.current = null;
    if (!userText.trim()) {
      setError({
        code: "INVALID_REQUEST",
        message: "Describe the equipment you need.",
        retryable: false,
        fieldErrors: { userText: "This field is required." },
      });
      return;
    }

    setBusy(true);
    busyRef.current = true;
    try {
      const result = await postJson<FormResponse>("/api/equipment/request", { userText });
      requestIdRef.current = result.form.requestId;
      processor.processMessages(result.surfaceMessages);
      setDiagnostics((current) => [
        ...current,
        {
          label: `Validated ${result.surfaceMessages.length} A2UI ${result.diagnostics.protocol} messages`,
          requestId: result.diagnostics.requestId,
        },
      ]);
      await refreshStatus();
    } catch (caught) {
      setError(toApiFailure(caught));
      await refreshStatus().catch(() => undefined);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function requestSignInLink() {
    setError(null);
    try {
      const response = await postJson<{ url: string }>("/api/auth-url", {});
      setSignInUrl(response.url);
    } catch (caught) {
      setError(toApiFailure(caught));
    }
  }

  const locked = busy || Boolean(ack) || status?.workflow.phase === "uncertain";

  return (
    <main className="page-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">A</div>
        <div>
          <p className="eyebrow">A2UI × Copilot Studio</p>
          <h1>Equipment request demo</h1>
        </div>
        <div className="status-pill" data-ready={status?.agentReady ? "true" : "false"}>
          <span className="status-dot" />
          {status?.agentReady ? "Agent connection enabled" : "Agent connection gated"}
        </div>
      </header>

      <section className="intro-card">
        <div className="intro-copy">
          <p className="eyebrow">Direct-to-Engine · delegated sign-in</p>
          <h2>Turn a request into an editable, agent-grounded form.</h2>
          <p>
            Copilot Studio interprets your request. Its structured response is validated by the
            backend, then rendered as a native A2UI surface. This demo never buys or submits equipment.
          </p>
        </div>
        <div className="auth-panel">
          <div className={`auth-state ${status?.authenticated ? "is-authenticated" : ""}`}>
            <span className="state-icon">{status?.authenticated ? "✓" : "•"}</span>
            <div>
              <strong>{status?.authenticated ? "Signed in" : "Delegated sign-in"}</strong>
              <small>{status?.authenticated ? "Token held in server memory" : "No browser token storage"}</small>
            </div>
          </div>
          {!status?.authenticated && (
            <button
              className="button button-secondary"
              onClick={requestSignInLink}
              disabled={!status}
              type="button"
            >
              Get sign-in link
            </button>
          )}
          {signInUrl && (
            <a className="sign-in-link" href={signInUrl} target="_blank" rel="noreferrer">
              Open Microsoft sign-in in your browser
            </a>
          )}
          {status?.authError === "CONSENT_REQUIRED" && (
            <p className="inline-notice" role="status">
              An administrator must grant delegated CopilotStudio.Copilots.Invoke consent for this app.
            </p>
          )}
          {status?.authError && status.authError !== "CONSENT_REQUIRED" && (
            <p className="inline-notice" role="status">Sign-in did not complete. Request a new sign-in link.</p>
          )}
        </div>
      </section>

      {!status?.agentReady && (
        <div className="callout callout-warning" role="status">
          <strong>Live agent calls are disabled.</strong> The local agent configuration has not passed
          Copilot Studio validation and publication yet. No request is sent to the current cloud agent.
        </div>
      )}

      <section className="workspace-grid">
        <div className="work-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">01 / Describe</p>
              <h2>What do you need?</h2>
            </div>
            <span className="step-badge">Prompt</span>
          </div>
          <form onSubmit={createForm}>
            <label htmlFor="request-text">Request description</label>
            <textarea
              id="request-text"
              value={userText}
              onChange={(event) => setUserText(event.target.value)}
              placeholder="I need a laptop for running local development tools."
              maxLength={1000}
              rows={4}
              disabled={locked || status?.workflow.phase !== "new"}
            />
            <div className="form-footer">
              <span>{userText.length}/1000 characters</span>
              <button
                className="button button-primary"
                type="submit"
                disabled={locked || status?.workflow.phase !== "new" || !status?.authenticated || !status?.agentReady}
              >
                {busy && !requestIdRef.current ? "Asking Copilot Studio…" : "Create request form"}
                <span aria-hidden="true">→</span>
              </button>
            </div>
          </form>

          <div className="section-heading form-heading">
            <div>
              <p className="eyebrow">02 / Review and submit</p>
              <h2>Agent-generated A2UI form</h2>
            </div>
            {surfaces.length > 0 && <span className="step-badge step-badge-active">A2UI v0.9</span>}
          </div>
          <div className={`a2ui-shell ${locked ? "is-locked" : ""}`} aria-busy={busy}>
            {surfaces.length > 0 ? (
              surfaces.map((surface) => <A2uiSurface key={surface.id} surface={surface} />)
            ) : (
              <div className="empty-surface">
                <div className="empty-icon" aria-hidden="true">▤</div>
                <strong>Your form will appear here</strong>
                <p>The equipment selector and justification are rendered from the validated A2UI message stream.</p>
              </div>
            )}
            {busy && requestIdRef.current && <div className="surface-overlay">Sending to Copilot Studio…</div>}
            {ack && <div className="surface-overlay surface-overlay-done">Request received</div>}
          </div>
          {error && (
            <div className="callout callout-error" role="alert">
              <strong>{error.code.replaceAll("_", " ")}</strong>
              <p>{error.message}</p>
              {error.fieldErrors && (
                <ul>
                  {Object.entries(error.fieldErrors).map(([field, message]) => (
                    <li key={field}><b>{field}:</b> {message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {ack && (
            <div className="ack-card" role="status">
              <div className="ack-icon" aria-hidden="true">✓</div>
              <div>
                <strong>Agent acknowledgment</strong>
                <p>{ack.message}</p>
                <small>Echoed: {ack.device} · {ack.justification}</small>
              </div>
            </div>
          )}
        </div>

        <aside className="details-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">03 / Observe</p>
              <h2>Demo diagnostics</h2>
            </div>
            <span className="live-indicator"><i /> Local</span>
          </div>
          <p className="panel-description">
            Safe correlation details only. Tokens, conversation IDs, and request text are never shown here.
          </p>
          <div className="diagnostic-list">
            <DiagnosticRow label="Runtime" value="In-memory session" />
            <DiagnosticRow label="Workflow" value={status?.workflow.phase ?? "Loading…"} />
            <DiagnosticRow label="D2E transport" value="Microsoft Agents SDK" />
            <DiagnosticRow label="Renderer" value="@a2ui/react · v0.9" />
          </div>
          <div className="event-log" aria-live="polite">
            <div className="event-log-heading">
              <span>Contract events</span>
              <span>{diagnostics.length.toString().padStart(2, "0")}</span>
            </div>
            {diagnostics.length === 0 ? (
              <p className="empty-log">No contract events yet.</p>
            ) : (
              diagnostics.slice(-5).reverse().map((entry, index) => (
                <div className="event-item" key={`${entry.label}-${index}`}>
                  <span className="event-check">✓</span>
                  <div>
                    <strong>{entry.label}</strong>
                    {entry.requestId && <small>Request {entry.requestId.slice(0, 8)}</small>}
                    {entry.submissionId && <small>Submission {entry.submissionId.slice(0, 8)}</small>}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="safety-note">
            <span aria-hidden="true">◎</span>
            <p><strong>Demo-safe by design</strong><br />No tickets, inventory, approvals, or purchases are created.</p>
          </div>
        </aside>
      </section>

      <footer className="page-footer">
        <span>Local POC · one origin · localhost:2009</span>
        <span>Copilot Studio Direct-to-Engine + A2UI</span>
      </footer>
    </main>
  );
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="diagnostic-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

class ApiRequestError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
  }
}

async function postJson<T extends object>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as T | { error: ApiFailure };
  if (!response.ok && "error" in result) {
    throw new ApiRequestError(result.error);
  }
  if (!response.ok) {
    throw new Error("The request could not be completed.");
  }
  return result as T;
}

function toApiFailure(error: unknown): ApiFailure {
  if (error instanceof ApiRequestError) return error.failure;
  return {
    code: "REQUEST_FAILED",
    message: error instanceof Error ? error.message : "The request could not be completed.",
    retryable: false,
  };
}

createRoot(document.getElementById("root")!).render(<App />);
