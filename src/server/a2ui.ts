import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import type { A2uiMessage } from "@a2ui/web_core/v0_9";
import type { EquipmentForm } from "./contracts.js";

export const A2UI_PROTOCOL_VERSION = "v0.9" as const;
export const EQUIPMENT_SURFACE_ID = "equipment-request";

export function createEquipmentSurface(form: EquipmentForm): A2uiMessage[] {
  return [
    {
      version: A2UI_PROTOCOL_VERSION,
      createSurface: {
        surfaceId: EQUIPMENT_SURFACE_ID,
        catalogId: basicCatalog.id,
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
              "device",
              "justification",
              "submit",
              "disclaimer",
            ],
          },
          { id: "heading", component: "Text", text: "Equipment request", variant: "h2" },
          {
            id: "intro",
            component: "Text",
            text: "Review and edit the demo request before continuing.",
          },
          {
            id: "device",
            component: "ChoicePicker",
            label: "Device",
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
            label: "Justification",
            variant: "longText",
            value: { path: "/justification" },
          },
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
          { id: "submit-label", component: "Text", text: "Submit demo request" },
          {
            id: "disclaimer",
            component: "Text",
            text: "Demo only. Nothing will be purchased or submitted.",
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
        },
      },
    },
  ];
}
