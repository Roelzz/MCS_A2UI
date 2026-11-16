import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import type { A2uiMessage } from "@a2ui/web_core/v0_9";
import type { EquipmentForm } from "./contracts.js";

export const A2UI_PROTOCOL_VERSION = "v0.9" as const;
export const EQUIPMENT_SURFACE_ID = "equipment-request";

const DEVICE_DETAILS = {
  laptop: {
    title: "Your next big idea starts here.",
    benefit: "Laptop · A workspace that moves with you",
    detail: "For building, coding, and taking your work anywhere. Demo guidance, not a hardware specification.",
    label: "Laptop",
  },
  monitor: {
    title: "Give your ideas more room.",
    benefit: "Monitor · Less switching, more seeing",
    detail: "Keep code, research, and previews side by side. Demo guidance, not a hardware specification.",
    label: "Monitor",
  },
  headset: {
    title: "Find your focus. Be heard.",
    benefit: "Headset · Make room for a clearer conversation",
    detail: "For calls, collaboration, and fewer distractions. Demo guidance, not a hardware specification.",
    label: "Headset",
  },
} as const;

export function createEquipmentSurface(form: EquipmentForm): A2uiMessage[] {
  return [
    {
      version: A2UI_PROTOCOL_VERSION,
      createSurface: {
        surfaceId: EQUIPMENT_SURFACE_ID,
        catalogId: basicCatalog.id,
        theme: { primaryColor: "var(--cp-accent)" },
      },
    },
    {
      version: A2UI_PROTOCOL_VERSION,
      updateComponents: {
        surfaceId: EQUIPMENT_SURFACE_ID,
        components: [
          { id: "root", component: "Card", child: "content" },
          {
            id: "content",
            component: "Column",
            children: [
              "heading",
              "intro",
              "detail",
              "divider",
              "device",
              "justification",
              "summary-heading",
              "summary-device",
              "summary-justification",
              "submit",
              "disclaimer",
            ],
          },
          { id: "heading", component: "Text", text: { path: "/preview/title" }, variant: "h2" },
          {
            id: "intro",
            component: "Text",
            text: { path: "/preview/benefit" },
          },
          { id: "detail", component: "Text", text: { path: "/preview/detail" }, variant: "caption" },
          { id: "divider", component: "Divider" },
          {
            id: "device",
            component: "ChoicePicker",
            label: "Choose your desk upgrade",
            variant: "mutuallyExclusive",
            displayStyle: "chips",
            options: [
              { label: "Laptop", value: "laptop" },
              { label: "Monitor", value: "monitor" },
              { label: "Headset", value: "headset" },
            ],
            value: { path: "/deviceSelection" },
          },
          {
            id: "justification",
            component: "TextField",
            label: "Make it yours — what will this help you do?",
            variant: "longText",
            value: { path: "/justification" },
          },
          { id: "summary-heading", component: "Text", text: "Your setup at a glance", variant: "h4" },
          { id: "summary-device", component: "Text", text: { path: "/preview/label" } },
          { id: "summary-justification", component: "Text", text: { path: "/justification" }, variant: "caption" },
          {
            id: "submit",
            component: "Button",
            child: "submit-label",
            variant: "primary",
            action: {
              event: {
                name: "equipment_submit",
                context: {
                  deviceSelection: { path: "/deviceSelection" },
                  justification: { path: "/justification" },
                },
              },
            },
          },
          { id: "submit-label", component: "Text", text: "Confirm my demo setup" },
          {
            id: "disclaimer",
            component: "Text",
            text: "A little imagination. Zero purchases. This is a simulated setup.",
            variant: "caption",
          },
        ],
      },
    },
    {
      version: A2UI_PROTOCOL_VERSION,
      updateDataModel: {
        surfaceId: EQUIPMENT_SURFACE_ID,
        path: "/",
        value: {
          deviceSelection: [form.device],
          justification: form.justification,
          deviceDetails: DEVICE_DETAILS,
          preview: DEVICE_DETAILS[form.device],
        },
      },
    },
  ];
}
