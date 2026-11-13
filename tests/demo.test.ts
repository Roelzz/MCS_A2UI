import assert from "node:assert/strict";
import test from "node:test";
import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { Activity, ActivityTypes } from "@microsoft/agents-activity";
import {
  ContractError,
  equipmentFormSchema,
  parseStrictJson,
} from "../src/server/contracts.js";
import { createEquipmentSurface } from "../src/server/a2ui.js";
import { D2EProtocolError, extractSingleTextActivity } from "../src/server/d2e.js";
import { EquipmentDemoService } from "../src/server/equipment-service.js";
import { SessionStore } from "../src/server/session-store.js";

const DISCLAIMER = "Demo request received — nothing was purchased or submitted.";

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
  assert.equal(
    equipmentFormSchema.safeParse({
      version: 1,
      type: "equipment_form",
      requestId: "e0412013-2a7f-4f66-87d7-e0c965cc6a98",
      device: "printer",
      justification: "Need printing",
    }).success,
    false,
  );
});

test("official A2UI processor validates and binds the fixed equipment form", () => {
  const form = {
    version: 1 as const,
    type: "equipment_form" as const,
    requestId: "e0412013-2a7f-4f66-87d7-e0c965cc6a98",
    device: "laptop" as const,
    justification: "Local development",
  };
  const processor = new MessageProcessor([basicCatalog]);
  processor.processMessages(createEquipmentSurface(form));

  const surface = processor.getSurface("equipment-request");
  assert.ok(surface);
  assert.deepEqual(surface.dataModel.get("/deviceSelection"), ["laptop"]);
  assert.equal(surface.dataModel.get("/justification"), "Local development");
  assert.equal(surface.componentsModel.get("device")?.type, "ChoicePicker");
  assert.equal(surface.componentsModel.get("justification")?.type, "TextField");
  assert.equal(surface.componentsModel.get("submit")?.type, "Button");
  assert.deepEqual(surface.componentsModel.get("submit")?.properties.action, {
    event: {
      name: "equipment_submit",
      context: {
        deviceSelection: { path: "/deviceSelection" },
        justification: { path: "/justification" },
      },
    },
  });
  surface.dataModel.set("/deviceSelection", ["monitor"]);
  surface.dataModel.set("/justification", "I need more screen space for debugging");
  assert.deepEqual(surface.dataModel.get("/deviceSelection"), ["monitor"]);
  assert.equal(surface.dataModel.get("/justification"), "I need more screen space for debugging");
  processor.dispose();
});

test("D2E adapter accepts one plain-text response with non-message event and typing activities", () => {
  const message = new Activity(ActivityTypes.Message);
  message.text = '{"type":"equipment_form"}';
  assert.equal(extractSingleTextActivity([message]), '{"type":"equipment_form"}');
  const event = new Activity(ActivityTypes.Event);
  event.name = "turn.complete";
  const typing = new Activity(ActivityTypes.Typing);
  assert.equal(extractSingleTextActivity([typing, message, event]), '{"type":"equipment_form"}');
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

test("edited A2UI values return through the same D2E conversation and duplicates are suppressed", async () => {
  const sessions = new SessionStore();
  const session = sessions.create();
  const sent: Array<{
    conversationId: string;
    envelope: Record<string, unknown>;
    text: string;
  }> = [];
  let markerFromFirstTurn = "";
  let startCount = 0;
  let submitResponseCount = 0;
  const service = new EquipmentDemoService(
    sessions,
    async () => "test-access-token",
    () => ({
      startConversation: async () => `conversation-${++startCount}`,
      sendMessage: async (conversationId, text) => {
        const envelope = JSON.parse(text) as Record<string, unknown>;
        sent.push({ conversationId, envelope, text });
        if (envelope.type === "equipment_request") {
          markerFromFirstTurn = String(envelope.contextMarker);
          return JSON.stringify({
            version: 1,
            type: "equipment_form",
            requestId: envelope.requestId,
            device: "laptop",
            justification: "Initial request from Copilot Studio",
          });
        }
        assert.equal(envelope.type, "equipment_submit");
        assert.equal("contextMarker" in envelope, false);
        if (submitResponseCount++ === 0) {
          return '{"version":1,"type":"equipment_ack","requestId":';
        }
        return JSON.stringify({
          version: 1,
          type: "equipment_ack",
          requestId: envelope.requestId,
          submissionId: envelope.submissionId,
          status: "received_demo",
          device: envelope.device,
          justification: envelope.justification,
          message: `${DISCLAIMER} Context check: ${markerFromFirstTurn}`,
        });
      },
    }),
    true,
  );

  const initial = await service.request(session, { userText: "I need a laptop for development." });
  assert.equal(initial.form.device, "laptop");
  assert.equal(initial.form.justification, "Initial request from Copilot Studio");
  const edited = {
    requestId: initial.form.requestId,
    device: "monitor",
    justification: "I need more screen space for debugging",
  };
  const submitted = await service.submit(session, edited);
  assert.equal(submitted.ack.device, "monitor");
  assert.equal(submitted.ack.justification, edited.justification);
  assert.equal(submitted.ack.message, `${DISCLAIMER} Context check: ${markerFromFirstTurn}`);
  assert.equal(sent[0]?.conversationId, sent[1]?.conversationId);
  assert.equal(sent[1]?.conversationId, sent[2]?.conversationId);
  assert.equal(sent[1]?.text, sent[2]?.text);
  assert.equal(sent.length, 3);

  const duplicate = await service.submit(session, edited);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.ack.submissionId, submitted.ack.submissionId);
  assert.equal(sent.length, 3);
});

test("invalid inputs and a timeout cannot trigger a duplicate or blind retry", async () => {
  const sessions = new SessionStore();
  const session = sessions.create();
  let sendCount = 0;
  const service = new EquipmentDemoService(
    sessions,
    async () => "test-access-token",
    () => ({
      startConversation: async () => "conversation-timeout",
      sendMessage: async () => {
        sendCount += 1;
        return new Promise<string>(() => undefined);
      },
    }),
    true,
    5,
  );

  await assert.rejects(
    service.request(session, { userText: "   " }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    service.request(session, { userText: "I need a monitor" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "UPSTREAM_TIMEOUT",
  );
  assert.equal(session.workflow.phase, "uncertain");
  await assert.rejects(
    service.request(session, { userText: "Try again" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_ALREADY_USED",
  );
  assert.equal(sendCount, 1);
});

test("blank and unsupported submission fields are rejected before D2E", async () => {
  const sessions = new SessionStore();
  const session = sessions.create();
  let sendCount = 0;
  const service = new EquipmentDemoService(
    sessions,
    async () => "test-access-token",
    () => ({
      startConversation: async () => "conversation-validation",
      sendMessage: async (_conversationId, text) => {
        sendCount += 1;
        const envelope = JSON.parse(text) as Record<string, unknown>;
        return JSON.stringify({
          version: 1,
          type: "equipment_form",
          requestId: envelope.requestId,
          device: "laptop",
          justification: "Initial justification",
        });
      },
    }),
    true,
  );
  const { form } = await service.request(session, { userText: "Need a laptop" });

  for (const invalid of [
    { requestId: form.requestId, device: "printer", justification: "Needs printing" },
    { requestId: form.requestId, device: "monitor", justification: "   " },
  ]) {
    await assert.rejects(
      service.submit(session, invalid),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "INVALID_SUBMISSION",
    );
  }
  assert.equal(sendCount, 1);
});

test("malformed agent JSON gets one bounded correction before blocking replay", async () => {
  const sessions = new SessionStore();
  const session = sessions.create();
  let sendCount = 0;
  const service = new EquipmentDemoService(
    sessions,
    async () => "test-access-token",
    () => ({
      startConversation: async () => "conversation-malformed",
      sendMessage: async () => {
        sendCount += 1;
        return '{"version":1,"type":"equipment_form","type":"equipment_form"}';
      },
    }),
    true,
  );

  await assert.rejects(
    service.request(session, { userText: "Need a monitor" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "UPSTREAM_PROTOCOL",
  );
  assert.equal(session.workflow.phase, "uncertain");
  assert.equal(sendCount, 2);
  await assert.rejects(
    service.request(session, { userText: "Retry the same request" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SESSION_ALREADY_USED",
  );
  assert.equal(sendCount, 2);
});

test("a submission timeout is uncertain and is never retried", async () => {
  const sessions = new SessionStore();
  const session = sessions.create();
  let sendCount = 0;
  const service = new EquipmentDemoService(
    sessions,
    async () => "test-access-token",
    () => ({
      startConversation: async () => "conversation-submit-timeout",
      sendMessage: async (_conversationId, text) => {
        sendCount += 1;
        const envelope = JSON.parse(text) as Record<string, unknown>;
        if (envelope.type === "equipment_submit") {
          return new Promise<string>(() => undefined);
        }
        return JSON.stringify({
          version: 1,
          type: "equipment_form",
          requestId: envelope.requestId,
          device: "laptop",
          justification: "Local development",
        });
      },
    }),
    true,
    5,
  );

  const { form } = await service.request(session, { userText: "Need a laptop" });
  const submission = {
    requestId: form.requestId,
    device: "monitor",
    justification: "More screen space",
  };
  await assert.rejects(
    service.submit(session, submission),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "UPSTREAM_TIMEOUT",
  );
  assert.equal(session.workflow.phase, "uncertain");
  assert.equal(sendCount, 2);
  await assert.rejects(
    service.submit(session, submission),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "SUBMISSION_NOT_AVAILABLE",
  );
  assert.equal(sendCount, 2);
});

test("live D2E failures expose safe diagnostics without raw upstream content or retries", async () => {
  const sdkError = Object.assign(
    new Error("[-140032] - Copilot Studio request failed with status 403 Forbidden secret-upstream-content"),
    { code: -140032 },
  );
  for (const [failure, expectedCode, expectedDetail] of [
    [sdkError, "UPSTREAM_TRANSPORT", "code -140032, HTTP 403"],
    [new D2EProtocolError("D2E must return exactly one ordinary text activity."), "UPSTREAM_PROTOCOL", "exactly one ordinary text activity"],
    [new Error("secret-upstream-content"), "UPSTREAM_PROTOCOL", "valid equipment protocol response"],
  ] as const) {
    const sessions = new SessionStore();
    const session = sessions.create();
    let sendCount = 0;
    const service = new EquipmentDemoService(
      sessions,
      async () => "test-access-token",
      () => ({
        startConversation: async () => "conversation-diagnostic",
        sendMessage: async () => {
          sendCount += 1;
          throw failure;
        },
      }),
      true,
    );
    await assert.rejects(
      service.request(session, { userText: "Need a laptop" }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === expectedCode &&
        error.message.includes(expectedDetail) &&
        !error.message.includes("secret-upstream-content"),
    );
    assert.equal(sendCount, 1);
    assert.equal(session.workflow.phase, "uncertain");
  }
});

test("sessions cannot submit another session's request correlation ID", async () => {
  const sessions = new SessionStore();
  const firstSession = sessions.create();
  const secondSession = sessions.create();
  const conversations: string[] = [];
  let nextConversation = 0;
  const service = new EquipmentDemoService(
    sessions,
    async () => "test-access-token",
    () => ({
      startConversation: async () => `conversation-${++nextConversation}`,
      sendMessage: async (conversationId, text) => {
        conversations.push(conversationId);
        const envelope = JSON.parse(text) as Record<string, unknown>;
        return JSON.stringify({
          version: 1,
          type: "equipment_form",
          requestId: envelope.requestId,
          device: "headset",
          justification: "Remote meetings",
        });
      },
    }),
    true,
  );
  const firstForm = await service.request(firstSession, { userText: "Need a headset" });
  const secondForm = await service.request(secondSession, { userText: "Need another headset" });
  assert.notEqual(firstForm.form.requestId, secondForm.form.requestId);
  assert.deepEqual(conversations, ["conversation-1", "conversation-2"]);

  await assert.rejects(
    service.submit(secondSession, {
      requestId: firstForm.form.requestId,
      device: "headset",
      justification: "Remote meetings",
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "REQUEST_MISMATCH",
  );
  assert.equal(conversations.length, 2);
});
