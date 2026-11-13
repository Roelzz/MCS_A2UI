import { getNodeValue, parseTree, type Node, type ParseError } from "jsonc-parser";
import { z } from "zod";

export const DEVICES = ["laptop", "monitor", "headset"] as const;
export type Device = (typeof DEVICES)[number];

const requestIdSchema = z.string().uuid();
const nonBlankText = (max: number) =>
  z.string().min(1).max(max).refine((value) => value.trim().length > 0);

export const initialRequestSchema = z
  .object({
    userText: nonBlankText(1000),
  })
  .strict();

export const submitRequestSchema = z
  .object({
    requestId: requestIdSchema,
    device: z.enum(DEVICES),
    justification: nonBlankText(1000),
  })
  .strict();

export const equipmentFormSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("equipment_form"),
    requestId: requestIdSchema,
    device: z.enum(DEVICES),
    justification: nonBlankText(1000),
  })
  .strict();

export const equipmentAckSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("equipment_ack"),
    requestId: requestIdSchema,
    submissionId: requestIdSchema,
    status: z.literal("received_demo"),
    device: z.enum(DEVICES),
    justification: nonBlankText(1000),
    message: nonBlankText(300),
  })
  .strict();

export const equipmentErrorSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("equipment_error"),
    requestId: z.string().max(64),
    submissionId: z.string().max(64),
    fieldErrors: z.record(z.string().min(1).max(64), z.string().min(1).max(300)),
  })
  .strict()
  .refine(
    (error) =>
      Object.keys(error.fieldErrors).every((field) =>
        ["userText", "device", "justification"].includes(field),
      ),
    "Field errors must reference supported form fields.",
  );

export type InitialRequest = z.infer<typeof initialRequestSchema>;
export type SubmitRequest = z.infer<typeof submitRequestSchema>;
export type EquipmentForm = z.infer<typeof equipmentFormSchema>;
export type EquipmentAck = z.infer<typeof equipmentAckSchema>;
export type EquipmentError = z.infer<typeof equipmentErrorSchema>;

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
