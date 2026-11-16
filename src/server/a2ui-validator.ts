import { A2uiMessageSchema, MessageProcessor, STRICT_VALIDATION, type A2uiMessage } from "@a2ui/web_core/v0_9";
import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import type { Scenario } from "./contracts.js";

export const LOCAL_ACTION_PREFIX = "open_";

const MAX_COMPONENTS = 120;
const MAX_TREE_DEPTH = 10;
const MAX_JSON_DEPTH = 14;
const MAX_STRING_LENGTH = 500;
const MAX_DATA_MODEL_BYTES = 16_384;

const SHARED_COMPONENTS = ["Column", "Row", "Card", "Text", "Icon", "Divider", "Button"];
const SCENARIO_COMPONENTS: Record<Scenario, ReadonlySet<string>> = {
  brief: new Set([...SHARED_COMPONENTS, "List", "Modal", "TextField"]),
  policy: new Set([...SHARED_COMPONENTS, "List", "DateTimeInput", "TextField"]),
  credit: new Set([...SHARED_COMPONENTS, "List", "Tabs", "Slider", "Modal", "TextField"]),
  desk: new Set([...SHARED_COMPONENTS, "List", "ChoicePicker", "CheckBox", "Slider", "TextField"]),
};

const ALLOWED_FUNCTIONS = new Set([
  "required", "regex", "length", "numeric", "email",
  "formatString", "formatNumber", "formatCurrency", "formatDate", "pluralize",
  "and", "or", "not",
]);

const UNSAFE_TEXT = /\b(?:javascript|vbscript|data|file|blob):(?!\s)|<\s*\/?\s*(?:script|iframe|img|object|embed|style|link|meta|svg)\b|\bon[a-z]+\s*=\s*["']/i;

const STRICT_CONFIG = {
  ...STRICT_VALIDATION,
  targetVersion: "v0.9" as const,
  allowedMessages: ["createSurface", "updateComponents", "updateDataModel"],
};

export class A2uiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2uiValidationError";
  }
}

export interface ValidatedSurface {
  surfaceId: string;
  messages: A2uiMessage[];
  serverActions: string[];
  componentCount: number;
}

export function surfacePattern(scenario: Scenario): RegExp {
  return new RegExp(`^${scenario}-[a-z0-9-]{1,40}$`);
}

/**
 * Validates one self-contained agent-authored surface: createSurface, updateComponents and an
 * optional updateDataModel, all for the same scenario-scoped surface. Throws A2uiValidationError
 * with a short, agent-safe reason that can be returned as a protocol correction.
 */
export function validateAgentSurface(scenario: Scenario, rawMessages: readonly unknown[]): ValidatedSurface {
  if (rawMessages.length < 2 || rawMessages.length > 3) {
    fail("messages must be createSurface, updateComponents and optionally updateDataModel");
  }

  const messages = rawMessages.map((message, index) => {
    const parsed = A2uiMessageSchema.safeParse(message);
    if (!parsed.success) {
      fail(`messages[${index}] is not a valid A2UI v0.9 message`);
    }
    return parsed.data;
  });

  const [create, update, data] = messages;
  if (!create || !("createSurface" in create)) fail("messages[0] must be createSurface");
  if (!update || !("updateComponents" in update)) fail("messages[1] must be updateComponents");
  if (data && !("updateDataModel" in data)) fail("messages[2] must be updateDataModel");

  const createBody = create.createSurface;
  const surfaceId = createBody.surfaceId;
  if (!surfacePattern(scenario).test(surfaceId)) {
    fail(`surfaceId must match ${scenario}-<lowercase id>`);
  }
  if (createBody.catalogId !== basicCatalog.id) fail("catalogId must be the Basic Catalog");
  const createKeys = Object.keys(createBody).filter((key) => key !== "surfaceId" && key !== "catalogId" && key !== "sendDataModel");
  if (createKeys.length > 0) fail("createSurface may only set surfaceId, catalogId and sendDataModel");
  if (update.updateComponents.surfaceId !== surfaceId) fail("updateComponents surfaceId must match createSurface");
  if (data && "updateDataModel" in data) {
    if (data.updateDataModel.surfaceId !== surfaceId) fail("updateDataModel surfaceId must match createSurface");
    if (data.updateDataModel.path !== undefined && data.updateDataModel.path !== "/") {
      fail("updateDataModel must replace the root path");
    }
    if (Buffer.byteLength(JSON.stringify(data.updateDataModel.value ?? null), "utf8") > MAX_DATA_MODEL_BYTES) {
      fail("data model is too large");
    }
  }

  const components = update.updateComponents.components as Array<Record<string, unknown>>;
  if (components.length > MAX_COMPONENTS) fail(`at most ${MAX_COMPONENTS} components are allowed`);

  const allowed = SCENARIO_COMPONENTS[scenario];
  const byId = new Map<string, Record<string, unknown>>();
  const serverActions = new Set<string>();
  for (const component of components) {
    const type = String(component.component);
    if (!allowed.has(type)) fail(`component ${type} is not allowed for ${scenario}`);
    byId.set(String(component.id), component);
    const action = component.action as { event?: { name?: unknown; context?: unknown }; functionCall?: unknown } | undefined;
    if (action) {
      if (!action.event || action.functionCall !== undefined) fail("buttons may only dispatch server events");
      const name = String(action.event.name ?? "");
      if (name.startsWith(LOCAL_ACTION_PREFIX)) {
        if (!/^open_[a-z][a-z0-9_]{0,30}$/.test(name)) fail(`invalid local action name ${name}`);
        if (action.event.context !== undefined && Object.keys(action.event.context as object).length > 0) {
          fail("local open_ actions must not carry context");
        }
      } else if (new RegExp(`^${scenario}_[a-z][a-z0-9_]{0,30}$`).test(name)) {
        serverActions.add(name);
      } else {
        fail(`action ${name} must start with ${scenario}_ or ${LOCAL_ACTION_PREFIX}`);
      }
    }
  }

  inspectValues(messages, 0);
  checkTreeDepth(byId);

  try {
    new MessageProcessor([basicCatalog], undefined, { validationConfig: STRICT_CONFIG }).processMessages(messages);
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 200) : "unknown error";
    fail(`official A2UI processor rejected the surface: ${detail}`);
  }

  return { surfaceId, messages, serverActions: [...serverActions], componentCount: components.length };
}

function inspectValues(value: unknown, depth: number): void {
  if (depth > MAX_JSON_DEPTH) fail("A2UI JSON is nested too deeply");
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) fail(`strings may be at most ${MAX_STRING_LENGTH} characters`);
    if (UNSAFE_TEXT.test(value)) fail("strings must not contain URL schemes, HTML or script");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) inspectValues(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.call === "string" && !ALLOWED_FUNCTIONS.has(record.call)) {
      fail(`function ${record.call} is not allowed`);
    }
    if ("svgPath" in record) fail("custom svgPath icons are not allowed");
    for (const item of Object.values(record)) inspectValues(item, depth + 1);
  }
}

function childIds(component: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of ["child", "trigger", "content"]) {
    if (typeof component[key] === "string") ids.push(component[key] as string);
  }
  const children = component.children;
  if (Array.isArray(children)) ids.push(...children.filter((id): id is string => typeof id === "string"));
  else if (children && typeof children === "object" && typeof (children as { componentId?: unknown }).componentId === "string") {
    ids.push((children as { componentId: string }).componentId);
  }
  if (Array.isArray(component.tabs)) {
    for (const tab of component.tabs as Array<{ child?: unknown }>) {
      if (typeof tab.child === "string") ids.push(tab.child);
    }
  }
  return ids;
}

function checkTreeDepth(byId: Map<string, Record<string, unknown>>): void {
  const visit = (id: string, depth: number, path: Set<string>): void => {
    if (depth > MAX_TREE_DEPTH) fail(`component tree may be at most ${MAX_TREE_DEPTH} levels deep`);
    if (path.has(id)) fail("component tree must not contain cycles");
    const component = byId.get(id);
    if (!component) return;
    path.add(id);
    for (const child of childIds(component)) visit(child, depth + 1, path);
    path.delete(id);
  };
  if (!byId.has("root")) fail("a component with id root is required");
  visit("root", 1, new Set());
}

function fail(message: string): never {
  throw new A2uiValidationError(message);
}
