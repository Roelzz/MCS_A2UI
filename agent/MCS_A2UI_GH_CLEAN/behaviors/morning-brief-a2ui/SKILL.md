---
name: morning-brief-a2ui
description: Use when the user asks what needs their attention today, for a morning or executive brief, their priorities, inbox or decisions to make (e.g. "what needs me today?"), or when a JSON envelope is a ui_action or correction for a surfaceId starting with brief-. Returns the agent-authored A2UI v0.9 morning brief with Approve, Delegate and Snooze. Fictional demo data; never use for other topics or for real approvals.
---
<!-- bic:source=blank -->

# Executive morning brief (A2UI)

## When to use

- A `chat` envelope whose text asks what needs the user today, for a morning/executive brief, priorities, or decisions waiting on them.
- A `ui_action` or `correction` envelope for surface `brief-main`.

Do not use for policy questions, credit cases, desk or equipment requests, or general chat.

## Story and state rules

Sam is a director opening the assistant at 07:30. Start from the template data model exactly (three decisions ranked by urgency, then two updates) for a `chat` turn, and say in `text` what needs Sam first.

For `ui_action` turns, take the data model you sent last for `brief-main` and apply the action to the item whose `id` equals `context.itemId`:
- `brief_approve`: remove that item from `decisions`.
- `brief_delegate`: requires a nonblank `context.note`; remove the item from `decisions`. If the note is blank, keep the item and say in `text` that a note is needed.
- `brief_snooze`: remove that item from `decisions` or `fyi`.
- Unknown `itemId`: keep the data unchanged and say so in `text`.

After each action, recount: `progress` is `"<handled> of 5 handled"` followed by ` · ` and a short log like `Approved: Q3 campaign budget · Delegated: Board pre-read agenda`. Update `title` to the remaining counts (for example `"2 decisions, 2 updates left"`). When both lists are empty set `title` to `"All clear, Sam. Have a great day."` and `summary` to `"Nothing else needs you this morning."`. `text` confirms what was done in one sentence (for example "Approved the Q3 budget uplift — 4 items left.").

## Protocol (shared by every A2UI skill in this agent)

The demo app sends exactly one JSON envelope per user turn and validates your reply strictly.

Input envelopes (ordinary message text):
- `{"version":2,"type":"chat","turnId":"<uuid>","text":"<what the user typed>"}`
- `{"version":2,"type":"ui_action","turnId":"<uuid>","surfaceId":"<id>","name":"<action>","context":{...}}` — the user clicked a button on a surface you sent earlier.
- `{"version":2,"type":"correction","turnId":"<uuid>","problem":"<reason>"}` — your previous reply for this turnId was rejected. Fix the problem and send the full corrected reply once, with the same turnId.

Your reply is exactly one JSON object and nothing else — no Markdown fences, no prose before or after:

`{"version":2,"type":"ui","turnId":"<echo the input turnId>","scenario":"brief","skill":"morning-brief-a2ui","text":"<one short sentence, max 200 characters>","messages":[ <the three A2UI messages> ]}`

Rules for `messages`:
- Copy the `createSurface` and `updateComponents` messages from the template below **exactly** (same ids, components, actions and checks). Do not add, remove or rename components and do not invent component types.
- Only change the `value` of the `updateDataModel` message, following the state rules below. Keep every key; use `""` or `[]` for empty values.
- Use only plain text in strings: no URLs, HTML, Markdown links or scripts. Use JSON escaping so the reply parses with a strict JSON parser.
- If you cannot produce a valid surface, reply `{"version":2,"type":"error","turnId":"<echo>","message":"<short reason>"}` instead.

Safety: this is a demo with fictional data. Nothing is approved, sent, booked or changed anywhere. Never call tools, connectors, knowledge or the web, and never claim a real-world effect.

## Template: surface brief-main

```json
[
{"version":"v0.9","createSurface":{"surfaceId":"brief-main","catalogId":"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"}},
{"version":"v0.9","updateComponents":{"surfaceId":"brief-main","components":[
{"id":"root","component":"Card","child":"col"},
{"id":"col","component":"Column","children":["title","summary","decisions-head","decisions","divider","fyi-head","fyi","progress"]},
{"id":"title","component":"Text","text":{"path":"/title"},"variant":"h3"},
{"id":"summary","component":"Text","text":{"path":"/summary"},"variant":"caption"},
{"id":"decisions-head","component":"Text","text":"Needs a decision","variant":"h5"},
{"id":"decisions","component":"List","children":{"path":"/decisions","componentId":"d-card"}},
{"id":"d-card","component":"Card","child":"d-col"},
{"id":"d-col","component":"Column","children":["d-top","d-reason","d-actions"]},
{"id":"d-top","component":"Row","children":["d-icon","d-title","d-due"],"align":"center"},
{"id":"d-icon","component":"Icon","name":{"path":"icon"}},
{"id":"d-title","component":"Text","text":{"path":"title"},"variant":"h4"},
{"id":"d-due","component":"Text","text":{"path":"due"},"variant":"caption"},
{"id":"d-reason","component":"Text","text":{"path":"reason"}},
{"id":"d-actions","component":"Row","children":["d-approve","d-delegate-modal","d-snooze"]},
{"id":"d-approve","component":"Button","child":"d-approve-t","action":{"event":{"name":"brief_approve","context":{"itemId":{"path":"id"}}}},"variant":"primary"},
{"id":"d-approve-t","component":"Text","text":"Approve"},
{"id":"d-delegate-modal","component":"Modal","trigger":"d-delegate","content":"d-delegate-form"},
{"id":"d-delegate","component":"Button","child":"d-delegate-t","action":{"event":{"name":"open_delegate"}}},
{"id":"d-delegate-t","component":"Text","text":"Delegate…"},
{"id":"d-delegate-form","component":"Column","children":["d-delegate-title","d-note","d-send"]},
{"id":"d-delegate-title","component":"Text","text":{"path":"delegateHint"},"variant":"h4"},
{"id":"d-note","component":"TextField","label":"Note for your delegate","value":{"path":"note"}},
{"id":"d-send","component":"Button","child":"d-send-t","action":{"event":{"name":"brief_delegate","context":{"itemId":{"path":"id"},"note":{"path":"note"}}}},"variant":"primary","checks":[{"condition":{"call":"required","args":{"value":{"path":"note"}}},"message":"Add a short note for your delegate."}]},
{"id":"d-send-t","component":"Text","text":"Send to delegate"},
{"id":"d-snooze","component":"Button","child":"d-snooze-t","action":{"event":{"name":"brief_snooze","context":{"itemId":{"path":"id"}}}},"variant":"borderless"},
{"id":"d-snooze-t","component":"Text","text":"Snooze"},
{"id":"divider","component":"Divider"},
{"id":"fyi-head","component":"Text","text":"For your information","variant":"h5"},
{"id":"fyi","component":"List","children":{"path":"/fyi","componentId":"f-card"}},
{"id":"f-card","component":"Card","child":"f-row"},
{"id":"f-row","component":"Row","children":["f-icon","f-col","f-snooze"],"align":"center"},
{"id":"f-icon","component":"Icon","name":{"path":"icon"}},
{"id":"f-col","component":"Column","children":["f-title","f-reason"]},
{"id":"f-title","component":"Text","text":{"path":"title"},"variant":"h5"},
{"id":"f-reason","component":"Text","text":{"path":"reason"},"variant":"caption"},
{"id":"f-snooze","component":"Button","child":"f-snooze-t","action":{"event":{"name":"brief_snooze","context":{"itemId":{"path":"id"}}}},"variant":"borderless"},
{"id":"f-snooze-t","component":"Text","text":"Snooze"},
{"id":"progress","component":"Text","text":{"path":"/progress"},"variant":"caption"}
]}},
{
 "version": "v0.9",
 "updateDataModel": {
  "surfaceId": "brief-main",
  "path": "/",
  "value": {
   "title": "Good morning, Sam — 3 decisions, 2 updates",
   "summary": "Ranked by urgency. Approve, delegate or snooze; the list shrinks as you go.",
   "decisions": [
    {
     "id": "d1",
     "icon": "payment",
     "title": "Q3 campaign budget uplift (EUR 48k)",
     "due": "Due 09:00",
     "reason": "Finance closes the forecast at 09:00 and needs your sign-off.",
     "delegateHint": "Delegate to Priya Shah, Chief of Staff",
     "note": ""
    },
    {
     "id": "d2",
     "icon": "person",
     "title": "Offer for Senior PM candidate",
     "due": "Due today",
     "reason": "The candidate holds a competing offer that expires tonight.",
     "delegateHint": "Delegate to Marco Diaz, Head of Talent",
     "note": ""
    },
    {
     "id": "d3",
     "icon": "event",
     "title": "Board pre-read agenda",
     "due": "Due 12:00",
     "reason": "The chair wants the agenda confirmed before lunch.",
     "delegateHint": "Delegate to Priya Shah, Chief of Staff",
     "note": ""
    }
   ],
   "fyi": [
    {
     "id": "f1",
     "icon": "warning",
     "title": "Project Atlas supplier slips two days",
     "reason": "No customer impact yet; the team has a recovery plan."
    },
    {
     "id": "f2",
     "icon": "star",
     "title": "Team NPS up 6 points",
     "reason": "Highest score this year, driven by faster onboarding."
    }
   ],
   "progress": "0 of 5 handled"
  }
 }
}
]
```
