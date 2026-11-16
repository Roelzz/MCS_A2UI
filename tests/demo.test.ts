import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Activity, ActivityTypes } from "@microsoft/agents-activity";
import { ContractError, parseStrictJson, type Scenario } from "../src/server/contracts.js";
import { A2uiValidationError, validateAgentSurface } from "../src/server/a2ui-validator.js";
import { ChatDemoService, DemoOperationError, parseAgentTurn } from "../src/server/chat-service.js";
import { D2EProtocolError, extractSingleTextActivity, type AgentTransport } from "../src/server/d2e.js";
import { SessionStore, type Session } from "../src/server/session-store.js";

const SKILLS_DIR = resolve(process.cwd(), "agent/MCS_A2UI_GH_CLEAN/behaviors");
const SKILLS: Record<string, Scenario> = {
  "morning-brief-a2ui": "brief",
  "policy-request-a2ui": "policy",
  "credit-case-a2ui": "credit",
  "desk-setup-a2ui": "desk",
};
const DISCLAIMER = "Demo request received — nothing was purchased or submitted.";

function skillTemplates(name: string): Array<Record<string, unknown>[]> {
  const text = readFileSync(resolve(SKILLS_DIR, name, "SKILL.md"), "utf8");
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1] ?? "[]"));
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const deskForm = () => clone(skillTemplates("desk-setup-a2ui")[0]!);

function rejects(scenario: Scenario, messages: unknown[], pattern: RegExp): void {
  assert.throws(
    () => validateAgentSurface(scenario, messages),
    (error: unknown) => error instanceof A2uiValidationError && pattern.test(error.message),
  );
}

function components(messages: Record<string, unknown>[]): Array<Record<string, unknown>> {
  return (messages[1] as { updateComponents: { components: Array<Record<string, unknown>> } }).updateComponents.components;
}

test("strict JSON parser rejects duplicate keys, invalid JSON, and oversized payloads", () => {
  assert.throws(
    () => parseStrictJson('{"version":1,"version":1}'),
    (error: unknown) => error instanceof ContractError && error.code === "DUPLICATE_PROPERTY",
  );
  assert.throws(
    () => parseStrictJson('{"version":1,}'),
    (error: unknown) => error instanceof ContractError && error.code === "INVALID_JSON",
  );
  assert.throws(
    () => parseStrictJson('{"value":"too long"}', 4),
    (error: unknown) => error instanceof ContractError && error.code === "INVALID_CONTRACT",
  );
});


test("D2E adapter accepts one plain-text response with non-message event and typing activities", () => {
  const message = new Activity(ActivityTypes.Message);
  message.text = '{"type":"ui"}';
  assert.equal(extractSingleTextActivity([message]), '{"type":"ui"}');
  const event = new Activity(ActivityTypes.Event);
  event.name = "turn.complete";
  const typing = new Activity(ActivityTypes.Typing);
  assert.equal(extractSingleTextActivity([typing, message, event]), '{"type":"ui"}');
  assert.throws(() => extractSingleTextActivity([event, typing]), D2EProtocolError);

  const extraMessage = new Activity(ActivityTypes.Message);
  extraMessage.text = "A second response";
  assert.throws(
    () => extractSingleTextActivity([message, extraMessage]),
    D2EProtocolError,
  );
  assert.throws(
    () => extractSingleTextActivity([message, extraMessage, event]),
    D2EProtocolError,
  );
  const attachmentMessage = new Activity(ActivityTypes.Message);
  attachmentMessage.text = message.text;
  attachmentMessage.attachments = [{ contentType: "application/json", content: {} }];
  assert.throws(
    () => extractSingleTextActivity([attachmentMessage, event]),
    D2EProtocolError,
  );
  const end = new Activity(ActivityTypes.EndOfConversation);
  end.text = "End";
  assert.throws(
    () => extractSingleTextActivity([end]),
    (error: unknown) =>
      error instanceof D2EProtocolError &&
      error.activitySummary?.messages === 0 &&
      error.activitySummary.ended === 1,
  );
});

test("every SKILL.md template is a valid agent surface under the strict validator", () => {
  const found = readdirSync(SKILLS_DIR).filter((name) => name in SKILLS);
  assert.deepEqual(found.sort(), Object.keys(SKILLS).sort());
  const expectedActions: Record<string, string[]> = {
    brief: ["brief_approve", "brief_delegate", "brief_snooze"],
    policy: ["policy_recheck", "policy_submit"],
    credit: ["credit_decide"],
    desk: ["desk_submit"],
  };
  for (const [name, scenario] of Object.entries(SKILLS)) {
    const templates = skillTemplates(name);
    assert.ok(templates.length >= 1, `${name} has templates`);
    const first = validateAgentSurface(scenario, templates[0]!);
    assert.deepEqual(first.serverActions.sort(), expectedActions[scenario], `${name} actions`);
    for (const template of templates.slice(1)) {
      assert.equal(validateAgentSurface(scenario, template).surfaceId, first.surfaceId, `${name} keeps one surface`);
    }
  }
  const receipt = JSON.stringify(skillTemplates("desk-setup-a2ui")[1]);
  assert.ok(receipt.includes(DISCLAIMER));
});

test("validator rejects unsafe or out-of-contract agent surfaces", () => {
  const withComponent = (component: Record<string, unknown>) => {
    const messages = deskForm();
    components(messages).push(component);
    (components(messages).find((c) => c.id === "col")!.children as string[]).push(String(component.id));
    return messages;
  };
  rejects("desk", withComponent({ id: "img", component: "Image", url: "https://example.com/x.png" }), /Image is not allowed/);
  rejects("brief", deskForm(), /surfaceId must match brief-/);
  rejects("desk", withComponent({ id: "evil", component: "Text", text: "<script>alert(1)</script>" }), /unsafe|script/i);
  rejects("desk", withComponent({ id: "svg", component: "Icon", name: { svgPath: "M0 0" } }), /svgPath/);
  rejects(
    "desk",
    withComponent({ id: "x", component: "Button", child: "submit-t", action: { functionCall: { call: "openUrl", args: { url: "https://x" } } } }),
    /server events|openUrl/,
  );
  rejects(
    "desk",
    withComponent({ id: "x", component: "Button", child: "submit-t", action: { event: { name: "brief_approve" } } }),
    /must start with desk_/,
  );
  rejects(
    "desk",
    withComponent({ id: "x", component: "Button", child: "submit-t", action: { event: { name: "open_x", context: { a: 1 } } } }),
    /local open_ actions/,
  );

  const themed = deskForm();
  (themed[0] as { createSurface: Record<string, unknown> }).createSurface.theme = { primaryColor: "#ff0000" };
  rejects("desk", themed, /createSurface may only set/);

  const dangling = deskForm();
  (components(dangling).find((c) => c.id === "col")!.children as string[]).push("missing");
  rejects("desk", dangling, /processor rejected/);

  const oversize = deskForm();
  (oversize[2] as { updateDataModel: { value: Record<string, unknown> } }).updateDataModel.value.blob = "x".repeat(17_000);
  assert.throws(() => validateAgentSurface("desk", oversize), A2uiValidationError);

  rejects("desk", deskForm().slice(0, 1), /messages must be/);
});

test("parseAgentTurn unwraps one json fence and enforces turnId echo", () => {
  const turnId = "6f2b7c1e-8d3a-4c5b-9e0f-1a2b3c4d5e6f";
  const ui = { version: 2, type: "ui", turnId, scenario: "desk", skill: "desk-setup-a2ui", text: "Here", messages: deskForm() };
  const fenced = "```json\n" + JSON.stringify(ui) + "\n```";
  assert.equal(parseAgentTurn(fenced, turnId).surface?.surfaceId, "desk-setup");
  assert.throws(() => parseAgentTurn(JSON.stringify(ui), "00000000-0000-4000-8000-000000000000"), /turnId/);
  assert.throws(() => parseAgentTurn("Sure! " + JSON.stringify(ui), turnId), ContractError);
  assert.throws(() => parseAgentTurn(JSON.stringify({ ...ui, extra: true }), turnId), /invalid/);
});

interface Sent {
  conversationId: string;
  envelope: Record<string, unknown>;
}

function harness(reply: (envelope: Record<string, unknown>, sent: Sent[]) => string | Promise<string>, timeoutMs = 1_000) {
  const sessions = new SessionStore();
  const session = sessions.create();
  const sent: Sent[] = [];
  let conversations = 0;
  const transport: AgentTransport = {
    async startConversation() {
      conversations += 1;
      return `conv-${conversations}`;
    },
    async sendMessage(conversationId, text) {
      const envelope = parseStrictJson(text) as Record<string, unknown>;
      sent.push({ conversationId, envelope });
      return reply(envelope, sent);
    },
  };
  const service = new ChatDemoService(sessions, async () => "token", () => transport, true, timeoutMs);
  return { service, session, sent };
}

function deskUi(turnId: unknown, receipt = false): string {
  const messages = skillTemplates("desk-setup-a2ui")[receipt ? 1 : 0]!;
  return JSON.stringify({ version: 2, type: "ui", turnId, scenario: "desk", skill: "desk-setup-a2ui", text: receipt ? DISCLAIMER : "Here's a fit", messages });
}

function welcome(turnId: unknown): string {
  return JSON.stringify({ version: 2, type: "text", turnId, text: "Hi! Try: what needs me today?" });
}

function agentUi(entries: Awaited<ReturnType<ChatDemoService["chat"]>>) {
  const entry = entries.at(-1);
  assert.equal(entry?.kind, "agent_ui");
  return entry as Extract<typeof entry, { kind: "agent_ui" }>;
}

async function startAndChat(service: ChatDemoService, session: Session) {
  const hello = await service.start(session);
  assert.equal(hello[0]?.kind, "agent_text");
  return agentUi(await service.chat(session, { text: "I need a laptop for local development" }));
}

test("chat renders agent UI and actions return to the same D2E conversation", async () => {
  const { service, session, sent } = harness((envelope) =>
    envelope.type === "hello" ? welcome(envelope.turnId) : deskUi(envelope.turnId, envelope.type === "ui_action"),
  );
  const form = await startAndChat(service, session);
  assert.equal(form.surfaceId, "desk-setup");
  assert.equal(form.skill, "desk-setup-a2ui");
  assert.deepEqual(form.diagnostics.serverActions, ["desk_submit"]);

  const actionId = crypto.randomUUID();
  const action = { actionId, surfaceId: "desk-setup", revision: form.revision, name: "desk_submit", context: { device: ["monitor"], justification: "More screen space for debugging" } };
  const receipt = agentUi(await service.action(session, action));
  assert.ok(receipt.text.includes(DISCLAIMER));
  assert.ok(receipt.revision > form.revision);

  assert.deepEqual(sent.map((item) => item.envelope.type), ["hello", "chat", "ui_action"]);
  assert.ok(sent.every((item) => item.conversationId === "conv-1"));
  assert.deepEqual({ ...(sent[2]?.envelope.context as object) }, action.context);

  await assert.rejects(service.action(session, action), { code: "DUPLICATE_ACTION" });
  await assert.rejects(service.action(session, { ...action, actionId: crypto.randomUUID() }), { code: "STALE_SURFACE" });
  await assert.rejects(
    service.action(session, { ...action, actionId: crypto.randomUUID(), revision: receipt.revision, name: "desk_hack" }),
    { code: "UNDECLARED_ACTION" },
  );
  await assert.rejects(
    service.action(session, { ...action, actionId: crypto.randomUUID(), surfaceId: "credit-case" }),
    { code: "UNKNOWN_SURFACE" },
  );
  assert.equal(sent.length, 3, "rejected actions never reach the agent");
});

test("an invalid agent reply gets exactly one correction, then fails without UI", async () => {
  let attempts = 0;
  const { service, session, sent } = harness((envelope) => {
    if (envelope.type === "hello") return welcome(envelope.turnId);
    attempts += 1;
    return attempts === 2 ? deskUi(envelope.turnId) : "Here is your form!";
  });
  await service.start(session);
  const fixed = agentUi(await service.chat(session, { text: "laptop please" }));
  assert.equal(fixed.diagnostics.correctionUsed, true);
  const correction = sent.at(-1)!.envelope;
  assert.equal(correction.type, "correction");
  assert.equal(correction.turnId, sent.at(-2)!.envelope.turnId);

  attempts = 2;
  await assert.rejects(service.chat(session, { text: "again" }), DemoOperationError);
  assert.equal(sent.filter((item) => item.envelope.type === "correction").length, 2);
  const notice = session.conversation.transcript.at(-1);
  assert.equal(notice?.kind, "notice");
});

test("a timed-out turn is not retried and reset is blocked while busy", async () => {
  let release: (() => void) | undefined;
  const { service, session, sent } = harness((envelope) => {
    if (envelope.type === "hello") return welcome(envelope.turnId);
    return new Promise<string>((resolveReply) => {
      release = () => resolveReply(deskUi(envelope.turnId));
    });
  }, 50);
  await service.start(session);
  const pending = service.chat(session, { text: "laptop" });
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  await assert.rejects(service.reset(session), { code: "TURN_IN_FLIGHT" });
  await assert.rejects(pending, { code: "UPSTREAM_TIMEOUT" });
  release?.();
  assert.equal(sent.filter((item) => item.envelope.type === "chat").length, 1);
  assert.equal(session.conversation.status, "idle");

  await service.reset(session);
  assert.equal(session.conversation.conversationId, undefined);
  await service.start(session);
  assert.equal(sent.at(-1)?.conversationId, "conv-2");
});

test("chat input is bounded before any D2E call", async () => {
  const { service, session, sent } = harness((envelope) => welcome(envelope.turnId));
  await service.start(session);
  await assert.rejects(service.chat(session, { text: "   " }), { code: "INVALID_MESSAGE" });
  await assert.rejects(service.chat(session, { text: "x".repeat(1001) }), { code: "INVALID_MESSAGE" });
  await assert.rejects(service.chat(session, { text: "hi", extra: 1 }), { code: "INVALID_MESSAGE" });
  assert.equal(sent.length, 1);
});
