import { z } from "zod";
import {
  ConnectionSettings,
  ScopeHelper,
} from "@microsoft/agents-copilotstudio-client";

const uuid = z.string().uuid();

const configSchema = z.object({
  tenantId: uuid,
  clientId: uuid,
  environmentId: uuid,
  schemaName: z.string().min(1).max(128),
  authorityUrl: z.string().url(),
  logLevel: z.enum(["ERROR", "WARN", "INFO", "DEBUG"]).default("INFO"),
  agentReady: z.enum(["true", "false"]).default("false"),
});

export interface AppConfig {
  tenantId: string;
  clientId: string;
  environmentId: string;
  schemaName: string;
  authorityUrl: string;
  logLevel: "ERROR" | "WARN" | "INFO" | "DEBUG";
  agentReady: boolean;
  redirectUri: string;
  origin: string;
  tokenScope: string;
  connectionSettings: ConnectionSettings;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse({
    tenantId: env.MCS_TENANT_ID,
    clientId: env.ENTRA_CLIENT_ID,
    environmentId: env.MCS_AGENT_ENVIRONMENT_ID,
    schemaName: env.MCS_AGENT_SCHEMA_NAME,
    authorityUrl: env.AUTHORITY_URL ?? "https://login.microsoftonline.com",
    logLevel: env.LOG_LEVEL ?? "INFO",
    agentReady: env.MCS_AGENT_READY ?? "false",
  });
  const authority = new URL(parsed.authorityUrl);
  if (
    authority.protocol !== "https:" ||
    authority.hostname !== "login.microsoftonline.com" ||
    authority.pathname !== "/"
  ) {
    throw new Error("AUTHORITY_URL must be the Microsoft Entra public-cloud authority.");
  }

  const redirectUri = "http://localhost:2009/auth/callback";
  const origin = "http://localhost:2009";
  const connectionSettings = new ConnectionSettings({
    environmentId: parsed.environmentId,
    schemaName: parsed.schemaName,
    enableDiagnostics: false,
  });

  return {
    tenantId: parsed.tenantId,
    clientId: parsed.clientId,
    environmentId: parsed.environmentId,
    schemaName: parsed.schemaName,
    authorityUrl: authority.origin,
    logLevel: parsed.logLevel,
    agentReady: parsed.agentReady === "true",
    redirectUri,
    origin,
    tokenScope: ScopeHelper.getScopeFromSettings(connectionSettings),
    connectionSettings,
  };
}
