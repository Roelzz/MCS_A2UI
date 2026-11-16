import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { A2uiSurface, type ReactCatalogComponent } from "@a2ui/react/v0_9";
import { MessageProcessor, type A2uiMessage, type ActionPayload } from "@a2ui/web_core/v0_9";
import { basicCatalog, injectBasicCatalogStyles } from "@a2ui/web_core/v0_9/basic_catalog";
import { bindDeskPreview } from "./desk-model.js";
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

type Ack = { device: string; justification: string; message: string };
type FormResponse = {
  form: { requestId: string };
  surfaceMessages: A2uiMessage[];
  diagnostics: { requestId: string; protocol: string; messageCount: number };
};
type SubmitResponse = {
  ack: Ack;
  duplicate: boolean;
  diagnostics: { requestId: string; submissionId: string; duplicate: boolean };
};
type Workflow = {
  phase: string;
  userText: string;
  form: { requestId: string } | null;
  surfaceMessages: A2uiMessage[];
  ack: Ack | null;
};
type Diagnostic = { label: string; requestId?: string; submissionId?: string };

const STARTERS = [
  { icon: "⌘", title: "Build and code", hint: "Ideas don't stay at one desk.", prompt: "I need a laptop for running local development tools wherever I work." },
  { icon: "▣", title: "More room to think", hint: "See the bigger picture.", prompt: "I need a monitor so I can keep code and debugging tools side by side." },
  { icon: "♫", title: "Meet without distractions", hint: "Find your focus. Be heard.", prompt: "I need a headset for clear calls and focused work in a busy workspace." },
];
const PENDING_PHASES = ["starting", "sending_initial", "submitting"];

function App() {
  const [processor] = useState(() => new MessageProcessor<ReactCatalogComponent>([basicCatalog]));
  const [surfaces, setSurfaces] = useState(() => Array.from(processor.model.surfacesMap.values()));
  const [status, setStatus] = useState<Status | null>(null);
  const [userText, setUserText] = useState("");
  const [initializing, setInitializing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [ack, setAck] = useState<Ack | null>(null);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const requestIdRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const unbindRef = useRef<(() => void) | null>(null);
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  const receiptRef = useRef<HTMLHeadingElement>(null);

  const replaceSurface = useCallback((messages: A2uiMessage[]) => {
    unbindRef.current?.();
    unbindRef.current = null;
    if (processor.getSurface("equipment-request")) {
      processor.processMessages([{ version: "v0.9", deleteSurface: { surfaceId: "equipment-request" } }]);
    }
    if (messages.length) {
      processor.processMessages(messages);
      const surface = processor.getSurface("equipment-request");
      if (!surface) throw new Error("The equipment surface could not be created.");
      unbindRef.current = bindDeskPreview(surface.dataModel);
    }
    setSurfaces(Array.from(processor.model.surfacesMap.values()));
  }, [processor]);

  const refreshStatus = useCallback(async () => {
    const result = await getJson<Status>("/api/status");
    setStatus(result);
    return result;
  }, []);

  const restoreWorkflow = useCallback(async () => {
    const currentStatus = await getJson<Status>("/api/status");
    const workflow = await getJson<Workflow>("/api/workflow");
    setStatus({ ...currentStatus, workflow: { phase: workflow.phase, requestId: workflow.form?.requestId ?? null } });
    setUserText(workflow.userText);
    requestIdRef.current = workflow.form?.requestId ?? null;
    replaceSurface(workflow.surfaceMessages);
    setAck(workflow.ack);
    if (workflow.form) {
      setDiagnostics([{ label: "Existing workflow restored — no new agent turn", requestId: workflow.form.requestId }]);
    }
  }, [replaceSurface]);

  useEffect(() => {
    injectBasicCatalogStyles();
    void restoreWorkflow().catch((caught: unknown) => setError(toApiFailure(caught))).finally(() => setInitializing(false));
    return () => {
      unbindRef.current?.();
      processor.dispose();
    };
  }, [processor, restoreWorkflow]);

  useEffect(() => {
    if (!signInUrl || status?.authenticated) return;
    const timer = window.setInterval(() => {
      void refreshStatus().catch((caught: unknown) => setError(toApiFailure(caught)));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refreshStatus, signInUrl, status?.authenticated]);

  useEffect(() => {
    if (status?.authError) setSignInUrl(null);
  }, [status?.authError]);

  const recoveringTurn = !busy && PENDING_PHASES.includes(status?.workflow.phase ?? "");
  useEffect(() => {
    if (!recoveringTurn) return;
    const timer = window.setInterval(() => {
      void restoreWorkflow().catch((caught: unknown) => setError(toApiFailure(caught)));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [recoveringTurn, restoreWorkflow]);

  const submitForm = useCallback(async (context: Record<string, unknown>) => {
    if (busyRef.current || !requestIdRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const selection = context.deviceSelection;
    const device = Array.isArray(selection) && selection.length === 1 ? selection[0] : undefined;
    try {
      const result = await postJson<SubmitResponse>("/api/equipment/submit", {
        requestId: requestIdRef.current,
        device,
        justification: context.justification,
      });
      setAck(result.ack);
      setDiagnostics((current) => [...current, {
        label: result.duplicate ? "Duplicate suppressed — no new agent turn" : "Same-conversation acknowledgement validated",
        requestId: result.diagnostics.requestId,
        submissionId: result.diagnostics.submissionId,
      }]);
      await refreshStatus();
    } catch (caught) {
      setError(toApiFailure(caught));
      try { await refreshStatus(); } catch (statusError) { setError(toApiFailure(statusError)); }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [refreshStatus]);

  useEffect(() => {
    const subscription = processor.model.onAction.subscribe((action: ActionPayload) => {
      if (action.surfaceId !== "equipment-request" || action.name !== "equipment_submit") {
        setError({ code: "UNSUPPORTED_ACTION", message: "This action is not part of the desk demo.", retryable: false });
        return;
      }
      void submitForm(action.context);
    });
    return () => subscription.unsubscribe();
  }, [processor, submitForm]);

  useEffect(() => {
    if (ack) receiptRef.current?.focus();
    else if (surfaces.length) formHeadingRef.current?.focus();
  }, [ack, surfaces.length]);

  async function createForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    if (!userText.trim()) {
      setError({ code: "INVALID_REQUEST", message: "Tell us what would make your workday better.", retryable: false });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setSignInUrl(null);
    try {
      const result = await postJson<FormResponse>("/api/equipment/request", { userText });
      requestIdRef.current = result.form.requestId;
      replaceSurface(result.surfaceMessages);
      setDiagnostics([{ label: "Agent business JSON validated → 3 A2UI v0.9 messages", requestId: result.form.requestId }]);
      await refreshStatus();
    } catch (caught) {
      setError(toApiFailure(caught));
      try { await refreshStatus(); } catch (statusError) { setError(toApiFailure(statusError)); }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function signIn() {
    if (busyRef.current) return;
    setError(null);
    setBusy(true);
    busyRef.current = true;
    try {
      const result = await postJson<{ url: string }>("/api/auth-url", {});
      setSignInUrl(result.url);
      window.location.assign(result.url);
    } catch (caught) {
      setError(toApiFailure(caught));
      setBusy(false);
      busyRef.current = false;
    }
  }

  async function tryAnother() {
    if (busyRef.current) return;
    setBusy(true);
    busyRef.current = true;
    setError(null);
    try {
      await postJson("/api/equipment/reset", {});
      replaceSurface([]);
      requestIdRef.current = null;
      setAck(null);
      setUserText("");
      setDiagnostics([]);
      await refreshStatus();
      document.getElementById("request-text")?.focus();
    } catch (caught) { setError(toApiFailure(caught)); }
    finally { setBusy(false); busyRef.current = false; }
  }

  const phase = status?.workflow.phase ?? "new";
  const working = busy || recoveringTurn || initializing;
  const uncertain = phase === "uncertain";
  const hasForm = surfaces.length > 0;
  const step = ack ? 3 : hasForm ? 2 : 1;
  const formLocked = working || Boolean(ack) || uncertain;
  const deviceLabel = ack ? ack.device.charAt(0).toUpperCase() + ack.device.slice(1) : "";

  return (
    <main className="page-shell">
      <header className="topbar">
        <a href="/" className="brand" aria-label="Desk demo home"><span className="brand-mark" aria-hidden="true">d.</span><span>desk<span className="brand-light"> / a little upgrade</span></span></a>
        <span className="demo-badge"><span aria-hidden="true">●</span> Demo only · no purchases</span>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">Copilot Studio intelligence. Your own experience.</p>
          <h1>Build your<br /><span>perfect desk.</span></h1>
          <p className="hero-copy">A little more focus. A lot more possibility.<br />Tell us what you need. Make it yours.</p>
        </div>
        <div className="hero-note">
          <span className="note-icon" aria-hidden="true">✦</span>
          <p>Not another chat window.</p>
          <span>A real agent. An editable A2UI experience.<br />One simple, simulated setup.</span>
        </div>
      </section>

      <ol className="stepper" aria-label="Setup progress">
        {["Tell us", "Make it yours", "You're set"].map((label, index) => (
          <li key={label} data-state={step === index + 1 ? "current" : step > index + 1 ? "done" : "next"} aria-current={step === index + 1 ? "step" : undefined}>
            <span>{step > index + 1 ? "✓" : `0${index + 1}`}</span>{label}
          </li>
        ))}
      </ol>

      <div className="experience-grid">
        <section className="work-panel">
          {!hasForm && (
            <>
              <div className="section-heading"><p className="eyebrow">01 / Start with your workday</p><h2>What could work better?</h2><p>Pick a starting point, or tell us in your own words.</p></div>
              <div className="starter-grid">
                {STARTERS.map((starter) => (
                  <button key={starter.title} className="starter" disabled={working || phase !== "new"} type="button" onClick={() => { setUserText(starter.prompt); document.getElementById("request-text")?.focus(); }}>
                    <span className="starter-icon" aria-hidden="true">{starter.icon}</span><strong>{starter.title}</strong><small>{starter.hint}</small>
                  </button>
                ))}
              </div>
              <form onSubmit={createForm}>
                <label htmlFor="request-text">My workday would be better with…</label>
                <textarea id="request-text" value={userText} onChange={(event) => setUserText(event.target.value)} maxLength={1000} rows={3} placeholder="A laptop for building my next big idea, wherever I work." disabled={working || phase !== "new"} />
                <div className="form-footer"><small>{userText.length}/1000</small><button className="button button-primary" disabled={working || phase !== "new" || !status?.authenticated || !status?.agentReady} type="submit">{busy ? "Finding your fit…" : "Find my desk upgrade"} <span aria-hidden="true">↗</span></button></div>
              </form>
            </>
          )}

          {hasForm && !ack && (
            <div className="section-heading">
              <p className="eyebrow">02 / Recommended by Copilot Studio</p>
              <h2 tabIndex={-1} ref={formHeadingRef}>A good fit. Now make it yours.</h2>
              <p>Change your device or your reason. The preview updates as you do.</p>
              <details className="original-prompt"><summary>Your original request</summary><p>{userText}</p></details>
            </div>
          )}

          {hasForm && (
            <div className={ack ? "completed-form" : "a2ui-shell"} inert={formLocked} aria-busy={working} hidden={Boolean(ack)}>
              {surfaces.map((surface) => <A2uiSurface key={surface.id} surface={surface} />)}
            </div>
          )}

          {working && !initializing && <div className="loading-note" role="status"><span className="spinner" />{recoveringTurn ? "Reconnecting to your current step…" : hasForm ? "Confirming your setup with the same agent…" : signInUrl ? "Preparing sign-in…" : "A little thinking. A better fit."}</div>}
          {initializing && <p className="loading-note" role="status">Opening your workspace…</p>}

          {error && <div className="callout callout-error" role="alert"><strong>{error.code.replaceAll("_", " ")}</strong><p>{error.message}</p>{error.fieldErrors && <ul>{Object.entries(error.fieldErrors).map(([field, message]) => <li key={field}>{field}: {message}</li>)}</ul>}</div>}
          {uncertain && <div className="callout" role="status"><strong>Let's not send that twice.</strong><p>The agent outcome is uncertain. This workflow is locked; do not retry the submission. Restart the local server for a fresh demo session.</p></div>}

          {ack && (
            <section className="receipt" aria-labelledby="receipt-heading">
              <span className="receipt-check" aria-hidden="true">✓</span>
              <p className="eyebrow">03 / A little upgrade, imagined</p>
              <h2 id="receipt-heading" tabIndex={-1} ref={receiptRef}>You're set.</h2>
              <p className="receipt-intro">Your agent heard the changes. Here's your setup.</p>
              <dl className="receipt-values"><div><dt>Your desk upgrade</dt><dd>{deviceLabel}</dd></div><div><dt>What it makes possible</dt><dd>{ack.justification}</dd></div></dl>
              <p className="demo-disclaimer">Demo request received — nothing was purchased or submitted.</p>
              <button className="button button-primary" type="button" disabled={working} onClick={() => void tryAnother()}>Try another setup <span aria-hidden="true">↗</span></button>
              <p className="receipt-footnote">Same sign-in. A fresh conversation. Still just a demo.</p>
            </section>
          )}
        </section>

        <aside className="companion-panel">
          <section className="connection-card">
            <p className="eyebrow">Your connection</p>
            <h2><span className={status?.authenticated ? "connection-dot ready" : "connection-dot"} />{status?.authenticated ? "You're connected." : "One quick sign-in."}</h2>
            <p>{status?.authenticated ? "Your token stays on the server. Your ideas stay in the flow." : "Connect to the real Copilot Studio agent to begin."}</p>
            {!status?.authenticated && <button className="button button-secondary" disabled={!status || working} type="button" onClick={() => void signIn()}>Sign in with Microsoft</button>}
            {status?.authError && <p className="auth-error" role="alert">{status.authError === "CONSENT_REQUIRED" ? "An Entra administrator must grant delegated CopilotStudio.Copilots.Invoke consent." : "Sign-in did not finish. Get a fresh link in this browser."}</p>}
            {status && !status.agentReady && <p className="auth-error" role="status">Agent calls are gated until the published configuration is verified.</p>}
          </section>
          <section className="how-card">
            <span className="note-icon" aria-hidden="true">↔</span>
            <h2>Intelligence meets interaction.</h2>
            <p>Copilot Studio understands the need. A2UI makes it tangible. You make the final edit.</p>
            <div className="mini-flow"><span>MCS</span><i>→</i><span>A2UI</span><i>→</i><span>You</span></div>
            <small>No orders. No tickets. No real-world changes.</small>
          </section>
          <details className="diagnostics">
            <summary>Under the hood <span aria-hidden="true">+</span></summary>
            <dl><div><dt>Workflow</dt><dd>{phase}</dd></div><div><dt>Renderer</dt><dd>Official A2UI v0.9</dd></div><div><dt>Transport</dt><dd>Microsoft Agents D2E</dd></div><div><dt>State</dt><dd>Server memory</dd></div></dl>
            <p>Business JSON → validation → allowlisted A2UI. Access tokens and conversation IDs never reach this page.</p>
            <div className="event-log" aria-live="polite">{diagnostics.length ? diagnostics.map((entry, index) => <div key={`${entry.label}-${index}`}><strong>✓ {entry.label}</strong>{entry.requestId && <small>Request {entry.requestId.slice(0, 8)}</small>}{entry.submissionId && <small>Submission {entry.submissionId.slice(0, 8)}</small>}</div>) : <p>No agent turns yet.</p>}</div>
            {ack && <p className="context-proof">{ack.message}</p>}
          </details>
        </aside>
      </div>
      <footer className="page-footer"><span>Built with Copilot Studio + official A2UI</span><span>Local sample · localhost:2009</span></footer>
    </main>
  );
}

class ApiRequestError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const result = await response.json() as T | { error: ApiFailure };
  if (!response.ok) {
    if (typeof result === "object" && result !== null && "error" in result) throw new ApiRequestError(result.error);
    throw new Error("The local application could not complete this request.");
  }
  return result as T;
}

async function getJson<T>(path: string): Promise<T> {
  return readResponse<T>(await fetch(path, { cache: "no-store", credentials: "same-origin" }));
}

async function postJson<T = object>(path: string, body: unknown): Promise<T> {
  return readResponse<T>(await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  }));
}

function toApiFailure(error: unknown): ApiFailure {
  if (error instanceof ApiRequestError) return error.failure;
  return { code: "REQUEST_FAILED", message: error instanceof Error ? error.message : "The request could not be completed.", retryable: false };
}

createRoot(document.getElementById("root")!).render(<App />);
