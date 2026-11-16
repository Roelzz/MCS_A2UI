import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { A2uiSurface, type ReactCatalogComponent } from "@a2ui/react/v0_9";
import { MessageProcessor, type A2uiMessage, type ActionPayload } from "@a2ui/web_core/v0_9";
import { basicCatalog, injectBasicCatalogStyles } from "@a2ui/web_core/v0_9/basic_catalog";
import "@fontsource/material-icons/400.css";
import "./styles.css";

type Status = {
  authenticated: boolean;
  authError: string | null;
  agentReady: boolean;
  conversation: { started: boolean; status: string };
  runtime: "in-memory";
};

type ApiFailure = { code: string; message: string; retryable: boolean; fieldErrors?: Record<string, string> };

type Diagnostics = {
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
};

type Entry =
  | { kind: "user"; text: string; at: number }
  | { kind: "action"; surfaceId: string; name: string; summary: string; at: number }
  | { kind: "agent_text"; text: string; turnId: string; error: boolean; diagnostics: Diagnostics; at: number }
  | {
      kind: "agent_ui";
      text: string;
      turnId: string;
      scenario: string;
      skill: string;
      surfaceId: string;
      revision: number;
      messages: A2uiMessage[];
      diagnostics: Diagnostics;
      at: number;
    }
  | { kind: "notice"; level: "error" | "warning"; code: string; text: string; at: number };

type Conversation = {
  started: boolean;
  status: string;
  transcript: Entry[];
  surfaces: Record<string, { scenario: string; revision: number }>;
};

const SCENARIO_LABEL: Record<string, string> = {
  brief: "Morning brief",
  policy: "Policy → request",
  credit: "Credit case file",
  desk: "Desk setup",
};

function App() {
  const [processor] = useState(() => new MessageProcessor<ReactCatalogComponent>([basicCatalog]));
  const [status, setStatus] = useState<Status | null>(null);
  const [transcript, setTranscript] = useState<Entry[]>([]);
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const busyRef = useRef(false);
  const revisionsRef = useRef<Record<string, number>>({});
  const renderedTurnRef = useRef<Record<string, string>>({});
  const endRef = useRef<HTMLDivElement>(null);
  const lastAgentRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Each agent UI turn is a self-contained surface; replace any earlier version of the same surface.
  const renderSurfaces = useCallback((entries: Entry[]) => {
    for (const entry of entries) {
      if (entry.kind !== "agent_ui") continue;
      if (renderedTurnRef.current[entry.surfaceId] === entry.turnId) continue;
      if (processor.getSurface(entry.surfaceId)) {
        processor.processMessages([{ version: "v0.9", deleteSurface: { surfaceId: entry.surfaceId } }]);
      }
      processor.processMessages(entry.messages);
      renderedTurnRef.current[entry.surfaceId] = entry.turnId;
    }
  }, [processor]);

  const applyConversation = useCallback((conversation: Conversation) => {
    renderSurfaces(conversation.transcript);
    const nextRevisions = Object.fromEntries(Object.entries(conversation.surfaces).map(([id, surface]) => [id, surface.revision]));
    revisionsRef.current = nextRevisions;
    setRevisions(nextRevisions);
    setTranscript(conversation.transcript);
  }, [renderSurfaces]);

  const runBusy = useCallback(async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(toApiFailure(caught));
      try {
        setStatus(await getJson<Status>("/api/status"));
        applyConversation(await getJson<Conversation>("/api/conversation"));
      } catch { /* status refresh is best effort after a failed turn */ }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [applyConversation]);

  const startConversation = useCallback(async () => {
    await runBusy(async () => {
      applyConversation(await postJson<Conversation>("/api/conversation/start", {}));
    });
  }, [applyConversation, runBusy]);

  useEffect(() => {
    injectBasicCatalogStyles();
    void (async () => {
      try {
        const current = await getJson<Status>("/api/status");
        setStatus(current);
        const conversation = await getJson<Conversation>("/api/conversation");
        applyConversation(conversation);
        setInitializing(false);
        if (current.authenticated && current.agentReady && !conversation.started) {
          await startConversation();
        }
      } catch (caught) {
        setError(toApiFailure(caught));
        setInitializing(false);
      }
    })();
    return () => processor.dispose();
  }, [applyConversation, processor, startConversation]);

  useEffect(() => {
    const subscription = processor.model.onAction.subscribe((action: ActionPayload) => {
      // open_* buttons only open a Modal in the renderer; they never reach the agent.
      if (action.name.startsWith("open_")) return;
      const revision = revisionsRef.current[action.surfaceId];
      if (!revision) {
        setError({ code: "UNKNOWN_SURFACE", message: "This surface is no longer active.", retryable: false });
        return;
      }
      void runBusy(async () => {
        const result = await postJson<Conversation>("/api/action", {
          actionId: crypto.randomUUID(),
          surfaceId: action.surfaceId,
          revision,
          name: action.name,
          context: action.context ?? {},
        });
        applyConversation(result);
      });
    });
    return () => subscription.unsubscribe();
  }, [applyConversation, processor, runBusy]);

  useEffect(() => {
    const last = transcript[transcript.length - 1];
    if (!busy && last && (last.kind === "agent_ui" || last.kind === "agent_text")) {
      // Surfaces finish layout after custom elements upgrade, so wait a frame before aligning the new turn's top.
      const timer = window.setTimeout(() => lastAgentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
      return () => window.clearTimeout(timer);
    }
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript, busy]);

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    await runBusy(async () => {
      setDraft("");
      const result = await postJson<Conversation>("/api/chat", { text });
      applyConversation(result);
    });
    composerRef.current?.focus();
  }

  async function restart() {
    await runBusy(async () => {
      await postJson("/api/reset", {});
      for (const surfaceId of Object.keys(renderedTurnRef.current)) {
        if (processor.getSurface(surfaceId)) {
          processor.processMessages([{ version: "v0.9", deleteSurface: { surfaceId } }]);
        }
      }
      renderedTurnRef.current = {};
      applyConversation({ started: false, status: "idle", transcript: [], surfaces: {} });
      applyConversation(await postJson<Conversation>("/api/conversation/start", {}));
    });
  }

  async function signIn() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await postJson<{ url: string }>("/api/auth-url", {});
      window.location.assign(result.url);
    } catch (caught) {
      setError(toApiFailure(caught));
      busyRef.current = false;
      setBusy(false);
    }
  }

  const ready = Boolean(status?.authenticated && status.agentReady);
  const latestTurn = latestTurnBySurface(transcript);
  const agentTurns = transcript.filter((entry): entry is Extract<Entry, { kind: "agent_text" | "agent_ui" }> => entry.kind === "agent_text" || entry.kind === "agent_ui");

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">A2</span><div><strong>Agent-built UI</strong><small>Copilot Studio skills · official A2UI renderer</small></div></div>
        <div className="topbar-actions">
          <span className="demo-badge"><span aria-hidden="true">●</span> Fictional data · no real-world changes</span>
          <button className="button button-ghost" type="button" onClick={() => setDiagnosticsOpen((open) => !open)} aria-expanded={diagnosticsOpen} aria-controls="diagnostics">Under the hood</button>
          {ready && <button className="button button-ghost" type="button" disabled={busy} onClick={() => void restart()}>Restart</button>}
        </div>
      </header>

      <div className={diagnosticsOpen ? "layout with-drawer" : "layout"}>
        <main className="chat" aria-busy={busy}>
          <div className="transcript" role="log" aria-live="polite">
            {initializing && <p className="system-note">Opening your workspace…</p>}

            {!initializing && !status?.authenticated && (
              <section className="sign-in-card">
                <span className="brand-mark large" aria-hidden="true">A2</span>
                <h1>The agent builds the interface.</h1>
                <p>Every card, form, slider and button in this chat is authored by a Copilot Studio skill as A2UI JSON and drawn by the official renderer. This page only validates and renders it.</p>
                <button className="button button-primary" type="button" disabled={busy} onClick={() => void signIn()}>Sign in with Microsoft</button>
                {status?.authError && <p className="auth-error" role="alert">{status.authError === "CONSENT_REQUIRED" ? "An Entra administrator must grant delegated CopilotStudio.Copilots.Invoke consent." : "Sign-in did not finish. Try again in this browser."}</p>}
              </section>
            )}
            {status?.authenticated && !status.agentReady && <p className="system-note warning">Agent calls are gated until the published configuration is verified (MCS_AGENT_READY).</p>}

            {transcript.map((entry, index) => {
              const key = `${entry.kind}-${entry.at}-${index}`;
              const lastRef = index === transcript.length - 1 ? lastAgentRef : undefined;
              if (entry.kind === "user") return <div key={key} className="bubble-row user"><div className="bubble user">{entry.text}</div></div>;
              if (entry.kind === "action") return <div key={key} className="action-chip"><span aria-hidden="true">↳</span> You clicked <code>{entry.summary}</code> — sent to the same agent conversation</div>;
              if (entry.kind === "notice") return <div key={key} className={`notice ${entry.level}`} role="alert"><strong>{entry.code.replaceAll("_", " ")}</strong> {entry.text}</div>;
              if (entry.kind === "agent_text") return <div key={key} ref={lastRef} className="bubble-row agent"><span className="avatar" aria-hidden="true">✦</span><div className={entry.error ? "bubble agent error" : "bubble agent"}>{entry.text}</div></div>;
              const live = latestTurn[entry.surfaceId] === entry.turnId;
              const surface = live ? processor.getSurface(entry.surfaceId) : undefined;
              return (
                <div key={key} ref={lastRef} className="bubble-row agent">
                  <span className="avatar" aria-hidden="true">✦</span>
                  <div className="agent-ui">
                    <div className="ui-meta"><span className="scenario-tag" data-scenario={entry.scenario}>{SCENARIO_LABEL[entry.scenario] ?? entry.scenario}</span><span>skill (self-reported): <code>{entry.skill}</code></span><span>rev {entry.revision}</span></div>
                    {entry.text && <p className="ui-text">{entry.text}</p>}
                    {surface ? (
                      <div className="surface-frame" inert={busy || revisions[entry.surfaceId] !== entry.revision}><A2uiSurface surface={surface} /></div>
                    ) : (
                      <div className="surface-frame superseded">Earlier version of this surface — the agent updated it below.</div>
                    )}
                  </div>
                </div>
              );
            })}

            {busy && !initializing && <div className="bubble-row agent"><span className="avatar" aria-hidden="true">✦</span><div className="bubble agent typing" role="status"><span /><span /><span /> <em>The agent is composing{transcript.length === 0 ? " its welcome" : ""}…</em></div></div>}
            {error && <div className="notice error" role="alert"><strong>{error.code.replaceAll("_", " ")}</strong> {error.message}</div>}
            {ready && !status?.conversation.started && transcript.length === 0 && !busy && <button className="button button-primary" type="button" onClick={() => void startConversation()}>Start conversation</button>}
            <div ref={endRef} />
          </div>

          <form className="composer" onSubmit={(event) => void send(event)}>
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
              maxLength={1000}
              rows={1}
              placeholder={ready ? "Ask the agent… e.g. “What needs me today?”" : "Sign in to chat with the agent"}
              disabled={!ready || busy || initializing}
              aria-label="Message the agent"
            />
            <button className="button button-primary" type="submit" disabled={!ready || busy || !draft.trim()}>Send</button>
          </form>
        </main>

        {diagnosticsOpen && (
          <aside id="diagnostics" className="drawer" aria-label="Diagnostics">
            <h2>Under the hood</h2>
            <p>Agent output is one v2 JSON envelope per turn. The backend validates it (strict JSON, turnId echo, Basic Catalog allowlists, official MessageProcessor dry run) and never generates UI. Tokens and the conversation ID stay on the server.</p>
            {agentTurns.length === 0 && <p className="system-note">No agent turns yet.</p>}
            {[...agentTurns].reverse().map((entry) => {
              const d = entry.diagnostics;
              return (
                <details key={d.turnId} className="turn-card">
                  <summary><span className={`dot ${d.responseType}`} />{d.responseType === "ui" ? `${d.surfaceId} · rev ${d.revision}` : d.responseType} <small>{d.latencyMs} ms</small></summary>
                  <dl>
                    <div><dt>turnId</dt><dd>{d.turnId.slice(0, 8)}</dd></div>
                    <div><dt>request</dt><dd>{String(d.request.type)}</dd></div>
                    {d.selfReportedSkill && <div><dt>skill (self-reported)</dt><dd>{d.selfReportedSkill}</dd></div>}
                    {d.componentCount !== undefined && <div><dt>components</dt><dd>{d.componentCount}</dd></div>}
                    {d.serverActions && <div><dt>declared actions</dt><dd>{d.serverActions.join(", ") || "none"}</dd></div>}
                    <div><dt>bytes</dt><dd>{d.responseBytes}</dd></div>
                    <div><dt>correction used</dt><dd>{d.correctionUsed ? "yes" : "no"}</dd></div>
                  </dl>
                  <p className="drawer-label">Request envelope</p>
                  <pre>{JSON.stringify(d.request, null, 2)}</pre>
                  {entry.kind === "agent_ui" && (<><p className="drawer-label">A2UI messages from the agent</p><pre>{JSON.stringify(entry.messages, null, 2)}</pre></>)}
                </details>
              );
            })}
          </aside>
        )}
      </div>
    </div>
  );
}

function latestTurnBySurface(transcript: Entry[]): Record<string, string> {
  const latest: Record<string, string> = {};
  for (const entry of transcript) {
    if (entry.kind === "agent_ui") latest[entry.surfaceId] = entry.turnId;
  }
  return latest;
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
