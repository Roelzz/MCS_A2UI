import { Activity, ActivityTypes } from "@microsoft/agents-activity";
import {
  CopilotStudioClient,
  type ConnectionSettings,
} from "@microsoft/agents-copilotstudio-client";

export interface AgentTransport {
  startConversation(): Promise<string>;
  sendMessage(conversationId: string, text: string): Promise<string>;
}

export class D2EProtocolError extends Error {
  constructor(
    message: string,
    readonly activitySummary?: {
      messages: number;
      typing: number;
      trace: number;
      events: number;
      ended: number;
      other: number;
    },
  ) {
    super(message);
    this.name = "D2EProtocolError";
  }
}

export function createAgentTransportFactory(settings: ConnectionSettings) {
  return (accessToken: string): AgentTransport =>
    new CopilotStudioTransport(settings, accessToken);
}

export class CopilotStudioTransport implements AgentTransport {
  private readonly client: CopilotStudioClient;

  constructor(settings: ConnectionSettings, accessToken: string) {
    this.client = new CopilotStudioClient(settings, accessToken);
  }

  async startConversation(): Promise<string> {
    const response = await this.client.startConversationWithResponse({
      emitStartConversationEvent: false,
      locale: "en-US",
    });
    if (!response.conversationId) {
      throw new D2EProtocolError("D2E start response omitted conversation metadata.");
    }
    return response.conversationId;
  }

  async sendMessage(conversationId: string, text: string): Promise<string> {
    if (!conversationId) {
      throw new D2EProtocolError("A conversation ID is required for every D2E turn.");
    }
    const activity = new Activity(ActivityTypes.Message);
    activity.text = text;
    const response = await this.client.executeWithResponse(activity, conversationId);
    if (response.conversationId !== conversationId) {
      throw new D2EProtocolError("D2E response conversation did not match the request.");
    }
    return extractSingleTextActivity(response.activities);
  }
}

export function extractSingleTextActivity(
  activities: readonly Activity[],
): string {
  const messages = activities.filter(
    (activity) => activity.type === ActivityTypes.Message,
  );
  const unsupported = activities.filter(
    (activity) =>
      activity.type !== ActivityTypes.Message &&
      activity.type !== ActivityTypes.Typing &&
      activity.type !== ActivityTypes.Trace &&
      activity.type !== ActivityTypes.Event,
  );

  if (unsupported.length > 0 || messages.length !== 1) {
    throw new D2EProtocolError("D2E must return exactly one ordinary text activity.", {
      messages: messages.length,
      typing: activities.filter((activity) => activity.type === ActivityTypes.Typing).length,
      trace: activities.filter((activity) => activity.type === ActivityTypes.Trace).length,
      events: activities.filter((activity) => activity.type === ActivityTypes.Event).length,
      ended: activities.filter((activity) => activity.type === ActivityTypes.EndOfConversation).length,
      other: unsupported.filter(
        (activity) => activity.type !== ActivityTypes.Event && activity.type !== ActivityTypes.EndOfConversation,
      ).length,
    });
  }

  const [message] = messages;
  if (
    !message ||
    typeof message.text !== "string" ||
    message.text.length === 0 ||
    (message.attachments?.length ?? 0) > 0
  ) {
    throw new D2EProtocolError("D2E response did not contain plain message text.");
  }
  return message.text;
}
