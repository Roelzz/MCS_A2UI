---
name: desk-setup-a2ui
description: Use when the user asks for a laptop, monitor, headset or other desk or equipment upgrade (e.g. "I need a laptop for local development"), or when a JSON envelope is a ui_action or correction for a surfaceId starting with desk-. Returns an agent-authored A2UI v0.9 desk setup form and a receipt. Demo only; never buys, provisions or submits anything.
---
<!-- bic:source=blank -->

# Build your perfect desk (A2UI)

## When to use

- A `chat` envelope asking for a laptop, monitor, headset or another desk/equipment upgrade.
- A `ui_action` or `correction` envelope for surface `desk-setup`.

Do not use for morning briefs, policy questions, credit cases or general chat.

## State rules

- `chat`: choose the closest device (`laptop`, `monitor` or `headset`; default `laptop`). Set `device` to a one-item array like `["monitor"]`, `title` to "A <device> for you", `intro` to one sentence on why it fits the request, and `justification` to a short first-person reason based on the user's words (max 200 characters). `text`: "Here's a good fit — change anything you like."
- `desk_submit` (`context.device` is an array with one of laptop/monitor/headset, `context.justification` is text):
  - If the device is missing or unknown, or the justification is blank: return the form again with the user's values and `intro` explaining what to fix.
  - Otherwise return the receipt template (same surfaceId `desk-setup`) with `deviceLabel` like "Monitor" and `justification` exactly as submitted. `text` must include: "Demo request received — nothing was purchased or submitted."
- `desk_restart`: return the form again with the last values.

## Protocol (shared by every A2UI skill in this agent)

The demo app sends exactly one JSON envelope per user turn and validates your reply strictly.

Input envelopes (ordinary message text):
- `{"version":2,"type":"chat","turnId":"<uuid>","text":"<what the user typed>"}`
- `{"version":2,"type":"ui_action","turnId":"<uuid>","surfaceId":"<id>","name":"<action>","context":{...}}` — the user clicked a button on a surface you sent earlier.
- `{"version":2,"type":"correction","turnId":"<uuid>","problem":"<reason>"}` — your previous reply for this turnId was rejected. Fix the problem and send the full corrected reply once, with the same turnId.

Your reply is exactly one JSON object and nothing else — no Markdown fences, no prose before or after:

`{"version":2,"type":"ui","turnId":"<echo the input turnId>","scenario":"desk","skill":"desk-setup-a2ui","text":"<one short sentence, max 200 characters>","messages":[ <the three A2UI messages> ]}`

Rules for `messages`:
- Copy the `createSurface` and `updateComponents` messages from the template below **exactly** (same ids, components, actions and checks). Do not add, remove or rename components and do not invent component types.
- Only change the `value` of the `updateDataModel` message, following the state rules below. Keep every key; use `""` or `[]` for empty values.
- Use only plain text in strings: no URLs, HTML, Markdown links or scripts. Use JSON escaping so the reply parses with a strict JSON parser.
- If you cannot produce a valid surface, reply `{"version":2,"type":"error","turnId":"<echo>","message":"<short reason>"}` instead.

Safety: this is a demo with fictional data. Nothing is approved, sent, booked or changed anywhere. Never call tools, connectors, knowledge or the web, and never claim a real-world effect.

## Template: surface desk-setup (form)

```json
[
{"version":"v0.9","createSurface":{"surfaceId":"desk-setup","catalogId":"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"}},
{"version":"v0.9","updateComponents":{"surfaceId":"desk-setup","components":[
{"id":"root","component":"Card","child":"col"},
{"id":"col","component":"Column","children":["title","intro","device","justification","submit","note"]},
{"id":"title","component":"Text","text":{"path":"/title"},"variant":"h3"},
{"id":"intro","component":"Text","text":{"path":"/intro"}},
{"id":"device","component":"ChoicePicker","label":"Device","variant":"mutuallyExclusive","displayStyle":"chips","options":[{"label":"Laptop","value":"laptop"},{"label":"Monitor","value":"monitor"},{"label":"Headset","value":"headset"}],"value":{"path":"/device"}},
{"id":"justification","component":"TextField","label":"How it helps your work","value":{"path":"/justification"},"checks":[{"condition":{"call":"length","args":{"value":{"path":"/justification"},"max":300}},"message":"Keep it under 300 characters."}]},
{"id":"submit","component":"Button","child":"submit-t","action":{"event":{"name":"desk_submit","context":{"device":{"path":"/device"},"justification":{"path":"/justification"}}}},"variant":"primary","checks":[{"condition":{"call":"required","args":{"value":{"path":"/device"}}},"message":"Pick a device."},{"condition":{"call":"required","args":{"value":{"path":"/justification"}}},"message":"Tell us how it helps."}]},
{"id":"submit-t","component":"Text","text":"Send my desk request"},
{"id":"note","component":"Text","text":"Demo only — nothing is purchased or submitted.","variant":"caption"}
]}},
{
 "version": "v0.9",
 "updateDataModel": {
  "surfaceId": "desk-setup",
  "path": "/",
  "value": {
   "title": "A laptop for you",
   "intro": "You want to run local development tools wherever you work.",
   "device": [
    "laptop"
   ],
   "justification": "I run local development tools and need a laptop that can keep up."
  }
 }
}
]
```

## Template: surface desk-setup (receipt)

```json
[
{"version":"v0.9","createSurface":{"surfaceId":"desk-setup","catalogId":"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"}},
{"version":"v0.9","updateComponents":{"surfaceId":"desk-setup","components":[
{"id":"root","component":"Card","child":"col"},
{"id":"col","component":"Column","children":["head","device","justification","disclaimer","again"]},
{"id":"head","component":"Row","children":["icon","title"],"align":"center"},
{"id":"icon","component":"Icon","name":"check"},
{"id":"title","component":"Text","text":"You're set","variant":"h3"},
{"id":"device","component":"Text","text":{"path":"/deviceLabel"},"variant":"h4"},
{"id":"justification","component":"Text","text":{"path":"/justification"}},
{"id":"disclaimer","component":"Text","text":"Demo request received — nothing was purchased or submitted."},
{"id":"again","component":"Button","child":"again-t","action":{"event":{"name":"desk_restart"}},"variant":"borderless"},
{"id":"again-t","component":"Text","text":"Change my setup"}
]}},
{
 "version": "v0.9",
 "updateDataModel": {
  "surfaceId": "desk-setup",
  "path": "/",
  "value": {
   "deviceLabel": "Monitor",
   "justification": "I need more screen space for debugging."
  }
 }
}
]
```
