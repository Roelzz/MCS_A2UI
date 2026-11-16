import { getNodeValue, parseTree, type Node, type ParseError } from "jsonc-parser";
import { z } from "zod";

export const SCENARIOS = ["brief", "policy", "credit", "desk"] as const;
export type Scenario = (typeof SCENARIOS)[number];

const turnIdSchema = z.string().uuid();
const boundedText = (max: number) =>
  z.string().min(1).max(max).refine((value) => value.trim().length > 0, "Text must not be blank.");

export const chatInputSchema = z
  .object({
    text: boundedText(1000),
  })
  .strict();

const contextValueSchema = z.union([
  z.string().max(1000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(200), z.number().finite(), z.boolean()])).max(20),
]);

export const actionInputSchema = z
  .object({
    actionId: z.string().uuid(),
    surfaceId: z.string().max(64),
    revision: z.number().int().min(1).max(10_000),
    name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    context: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/), contextValueSchema).default({}),
  })
  .strict()
  .refine((input) => Object.keys(input.context).length <= 20, "Too many context fields.");

export const agentUiSchema = z
  .object({
    version: z.literal(2),
    type: z.literal("ui"),
    turnId: turnIdSchema,
    scenario: z.enum(SCENARIOS),
    skill: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/),
    text: z.string().max(500),
    messages: z.array(z.record(z.unknown())).min(2).max(3),
  })
  .strict();

export const agentTextSchema = z
  .object({
    version: z.literal(2),
    type: z.literal("text"),
    turnId: turnIdSchema,
    text: boundedText(2000),
  })
  .strict();

export const agentErrorSchema = z
  .object({
    version: z.literal(2),
    type: z.literal("error"),
    turnId: turnIdSchema,
    message: boundedText(500),
  })
  .strict();

export const agentResponseSchema = z.discriminatedUnion("type", [
  agentUiSchema,
  agentTextSchema,
  agentErrorSchema,
]);

export type ChatInput = z.infer<typeof chatInputSchema>;
export type ActionInput = z.infer<typeof actionInputSchema>;
export type AgentUi = z.infer<typeof agentUiSchema>;
export type AgentResponse = z.infer<typeof agentResponseSchema>;

export class ContractError extends Error {
  constructor(
    readonly code: "INVALID_JSON" | "DUPLICATE_PROPERTY" | "INVALID_CONTRACT",
    message: string,
  ) {
    super(message);
    this.name = "ContractError";
  }
}

function assertNoDuplicateProperties(node: Node): void {
  if (node.type !== "object") {
    for (const child of node.children ?? []) {
      assertNoDuplicateProperties(child);
    }
    return;
  }

  const keys = new Set<string>();
  for (const property of node.children ?? []) {
    const [keyNode, valueNode] = property.children ?? [];
    if (keyNode?.type !== "string" || typeof keyNode.value !== "string" || !valueNode) {
      throw new ContractError("INVALID_JSON", "Object property is malformed.");
    }
    if (keys.has(keyNode.value)) {
      throw new ContractError("DUPLICATE_PROPERTY", "Duplicate JSON properties are not allowed.");
    }
    keys.add(keyNode.value);
    assertNoDuplicateProperties(valueNode);
  }
}

export function parseStrictJson(raw: string, maxBytes = 16_384): unknown {
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new ContractError("INVALID_CONTRACT", "Request body exceeds the allowed size.");
  }

  const errors: ParseError[] = [];
  const root = parseTree(raw, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (!root || errors.length > 0 || root.type !== "object") {
    throw new ContractError("INVALID_JSON", "Expected one JSON object.");
  }

  assertNoDuplicateProperties(root);
  return getNodeValue(root);
}

export function parseContract<T>(
  raw: string,
  schema: z.ZodType<T>,
  maxBytes = 16_384,
): T {
  let value: unknown;
  try {
    value = parseStrictJson(raw, maxBytes);
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ContractError) {
      throw error;
    }
    throw new ContractError("INVALID_CONTRACT", "JSON does not match the required contract.");
  }
}
