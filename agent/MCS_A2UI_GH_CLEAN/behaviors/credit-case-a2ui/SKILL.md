---
name: credit-case-a2ui
description: Use when the user asks to review, open or decide a credit limit increase or credit case for a customer (e.g. "open the credit case for Northwind", "sales wants a higher credit limit"), or when a JSON envelope is a ui_action or correction for a surfaceId starting with credit-. Returns an agent-authored A2UI v0.9 case file with tabs, a limit slider and human decision controls. Fictional data; never changes a credit system.
---
<!-- bic:source=blank -->

# Credit limit case file (A2UI)

## When to use

- A `chat` envelope about reviewing or deciding a customer's credit limit increase.
- A `ui_action` or `correction` envelope for surface `credit-case`.

Do not use for morning briefs, policy questions, desk requests or general chat.

## Story

A sales rep asked for a higher credit limit for Northwind Traders BV (fictional). The credit analyst reviews the case. Your recommendation is fixed at EUR 250,000. The human decides; you never decide for them.

## State rules

- `chat`: return the case-file template with its data model exactly. `text`: "Northwind wants EUR 400,000. I recommend EUR 250,000 — you decide."
- `credit_decide` (`context.decision` is approve, reject or escalate; `context.limit` is a number; `context.reason` is text):
  - If decision is approve, limit is below 250000 and the reason is shorter than 10 characters, or decision is reject/escalate and the reason is shorter than 10 characters: return the case file again with `proposedLimit` set to the limit, `reason` kept, and `status` explaining that a reason is required. Do not record a decision.
  - Otherwise return the result template (same surfaceId `credit-case`):
    - approve: `icon` "check", `title` "Approved: EUR <limit with thousands separators>", `detail` states whether it is above, at or below your EUR 250,000 recommendation.
    - reject: `icon` "close", `title` "Increase rejected", `detail` "Limit stays at EUR 150,000."
    - escalate: `icon` "arrowForward", `title` "Escalated to credit committee", `detail` "Proposed limit EUR <limit> goes to Thursday's committee (simulated)."
    - `reason`: `"Analyst reason: <reason>"` (or `"Analyst reason: none given"`).
    - `text`: one sentence confirming the human decision, e.g. "Recorded your approval at EUR 200,000 — below my recommendation, with your reason."
- `credit_reopen`: return the case-file template with its original data model.

## Protocol (shared by every A2UI skill in this agent)

The demo app sends exactly one JSON envelope per user turn and validates your reply strictly.

Input envelopes (ordinary message text):
- `{"version":2,"type":"chat","turnId":"<uuid>","text":"<what the user typed>"}`
- `{"version":2,"type":"ui_action","turnId":"<uuid>","surfaceId":"<id>","name":"<action>","context":{...}}` — the user clicked a button on a surface you sent earlier.
- `{"version":2,"type":"correction","turnId":"<uuid>","problem":"<reason>"}` — your previous reply for this turnId was rejected. Fix the problem and send the full corrected reply once, with the same turnId.

Your reply is exactly one JSON object and nothing else — no Markdown fences, no prose before or after:

`{"version":2,"type":"ui","turnId":"<echo the input turnId>","scenario":"credit","skill":"credit-case-a2ui","text":"<one short sentence, max 200 characters>","messages":[ <the three A2UI messages> ]}`

Rules for `messages`:
- Copy the `createSurface` and `updateComponents` messages from the template below **exactly** (same ids, components, actions and checks). Do not add, remove or rename components and do not invent component types.
- Only change the `value` of the `updateDataModel` message, following the state rules below. Keep every key; use `""` or `[]` for empty values.
- Use only plain text in strings: no URLs, HTML, Markdown links or scripts. Use JSON escaping so the reply parses with a strict JSON parser.
- If you cannot produce a valid surface, reply `{"version":2,"type":"error","turnId":"<echo>","message":"<short reason>"}` instead.

Safety: this is a demo with fictional data. Nothing is approved, sent, booked or changed anywhere. Never call tools, connectors, knowledge or the web, and never claim a real-world effect.

## Template: surface credit-case (case file)

```json
[
{"version":"v0.9","createSurface":{"surfaceId":"credit-case","catalogId":"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"}},
{"version":"v0.9","updateComponents":{"surfaceId":"credit-case","components":[
{"id":"root","component":"Card","child":"col"},
{"id":"col","component":"Column","children":["header","tabs","divider","proposal-head","proposed-value","slider","recommendation","decisions","status"]},
{"id":"header","component":"Row","children":["h-icon","h-col"],"align":"center"},
{"id":"h-icon","component":"Icon","name":"accountCircle"},
{"id":"h-col","component":"Column","children":["h-name","h-meta"]},
{"id":"h-name","component":"Text","text":{"path":"/customer/name"},"variant":"h3"},
{"id":"h-meta","component":"Text","text":{"path":"/customer/summary"},"variant":"caption"},
{"id":"tabs","component":"Tabs","tabs":[{"title":"Financials","child":"t-fin"},{"title":"Payment history","child":"t-pay"},{"title":"Recent news","child":"t-news"}]},
{"id":"t-fin","component":"List","children":{"path":"/financials","componentId":"kv"}},
{"id":"kv","component":"Row","children":["kv-label","kv-value"]},
{"id":"kv-label","component":"Text","text":{"path":"label"},"variant":"caption"},
{"id":"kv-value","component":"Text","text":{"path":"value"}},
{"id":"t-pay","component":"List","children":{"path":"/payments","componentId":"pay"}},
{"id":"pay","component":"Row","children":["pay-icon","pay-text"],"align":"center"},
{"id":"pay-icon","component":"Icon","name":{"path":"icon"}},
{"id":"pay-text","component":"Text","text":{"path":"text"}},
{"id":"t-news","component":"List","children":{"path":"/news","componentId":"news"}},
{"id":"news","component":"Column","children":["news-title","news-note"]},
{"id":"news-title","component":"Text","text":{"path":"title"}},
{"id":"news-note","component":"Text","text":{"path":"note"},"variant":"caption"},
{"id":"divider","component":"Divider"},
{"id":"proposal-head","component":"Text","text":"Proposed limit","variant":"h5"},
{"id":"proposed-value","component":"Text","text":{"call":"formatCurrency","args":{"value":{"path":"/proposedLimit"},"currency":"EUR","decimals":0},"returnType":"string"},"variant":"h3"},
{"id":"slider","component":"Slider","label":"Drag to set the limit (EUR)","min":0,"max":500000,"value":{"path":"/proposedLimit"}},
{"id":"recommendation","component":"Text","text":{"path":"/recommendation"},"variant":"caption"},
{"id":"decisions","component":"Row","children":["m-approve","m-reject","m-escalate"]},
{"id":"m-approve","component":"Modal","trigger":"b-approve","content":"f-approve"},
{"id":"b-approve","component":"Button","child":"b-approve-t","action":{"event":{"name":"open_approve"}},"variant":"primary"},
{"id":"b-approve-t","component":"Text","text":"Approve…"},
{"id":"f-approve","component":"Column","children":["f-approve-title","f-approve-reason","f-approve-confirm"]},
{"id":"f-approve-title","component":"Text","text":"Approve this limit","variant":"h4"},
{"id":"f-approve-reason","component":"TextField","label":"Reason for the record","value":{"path":"/reason"}},
{"id":"f-approve-confirm","component":"Button","child":"f-approve-confirm-t","action":{"event":{"name":"credit_decide","context":{"decision":"approve","limit":{"path":"/proposedLimit"},"reason":{"path":"/reason"}}}},"variant":"primary","checks":[{"condition":{"call":"or","args":{"values":[{"call":"numeric","args":{"value":{"path":"/proposedLimit"},"min":250000}},{"call":"length","args":{"value":{"path":"/reason"},"min":10}}]}},"message":"This is below the agent's recommendation of EUR 250,000. Give a reason of at least 10 characters."}]},
{"id":"f-approve-confirm-t","component":"Text","text":"Confirm decision"},
{"id":"m-reject","component":"Modal","trigger":"b-reject","content":"f-reject"},
{"id":"b-reject","component":"Button","child":"b-reject-t","action":{"event":{"name":"open_reject"}}},
{"id":"b-reject-t","component":"Text","text":"Reject…"},
{"id":"f-reject","component":"Column","children":["f-reject-title","f-reject-reason","f-reject-confirm"]},
{"id":"f-reject-title","component":"Text","text":"Reject the increase","variant":"h4"},
{"id":"f-reject-reason","component":"TextField","label":"Reason for the record","value":{"path":"/reason"}},
{"id":"f-reject-confirm","component":"Button","child":"f-reject-confirm-t","action":{"event":{"name":"credit_decide","context":{"decision":"reject","limit":{"path":"/proposedLimit"},"reason":{"path":"/reason"}}}},"variant":"primary","checks":[{"condition":{"call":"length","args":{"value":{"path":"/reason"},"min":10}},"message":"Give a reason of at least 10 characters."}]},
{"id":"f-reject-confirm-t","component":"Text","text":"Confirm decision"},
{"id":"m-escalate","component":"Modal","trigger":"b-escalate","content":"f-escalate"},
{"id":"b-escalate","component":"Button","child":"b-escalate-t","action":{"event":{"name":"open_escalate"}},"variant":"borderless"},
{"id":"b-escalate-t","component":"Text","text":"Escalate…"},
{"id":"f-escalate","component":"Column","children":["f-escalate-title","f-escalate-reason","f-escalate-confirm"]},
{"id":"f-escalate-title","component":"Text","text":"Escalate to the credit committee","variant":"h4"},
{"id":"f-escalate-reason","component":"TextField","label":"Reason for the record","value":{"path":"/reason"}},
{"id":"f-escalate-confirm","component":"Button","child":"f-escalate-confirm-t","action":{"event":{"name":"credit_decide","context":{"decision":"escalate","limit":{"path":"/proposedLimit"},"reason":{"path":"/reason"}}}},"variant":"primary","checks":[{"condition":{"call":"length","args":{"value":{"path":"/reason"},"min":10}},"message":"Give a reason of at least 10 characters."}]},
{"id":"f-escalate-confirm-t","component":"Text","text":"Confirm decision"},
{"id":"status","component":"Text","text":{"path":"/status"},"variant":"caption"}
]}},
{
 "version": "v0.9",
 "updateDataModel": {
  "surfaceId": "credit-case",
  "path": "/",
  "value": {
   "customer": {
    "name": "Northwind Traders BV",
    "summary": "Current limit EUR 150,000 · Requested EUR 400,000 · Raised by Jordan Lee (Sales)"
   },
   "financials": [
    {
     "label": "Revenue (FY25)",
     "value": "EUR 12.4M, +9% year on year"
    },
    {
     "label": "Operating margin",
     "value": "7.8%"
    },
    {
     "label": "Cash on hand",
     "value": "EUR 1.9M"
    },
    {
     "label": "Debt to equity",
     "value": "0.6"
    }
   ],
   "payments": [
    {
     "icon": "check",
     "text": "9 of 12 invoices paid on time in the last 12 months"
    },
    {
     "icon": "warning",
     "text": "3 late payments, average 11 days late"
    },
    {
     "icon": "check",
     "text": "No defaults or write-offs on record"
    }
   ],
   "news": [
    {
     "title": "Northwind wins regional retail contract",
     "note": "Expected to add about EUR 2M revenue next year."
    },
    {
     "title": "CFO change announced",
     "note": "New CFO starts next quarter."
    }
   ],
   "proposedLimit": 250000,
   "recommendation": "Agent recommendation: EUR 250,000 — strong cash position, but three late payments argue against the full request.",
   "reason": "",
   "status": "Move the slider, then choose a decision. Going below the recommendation requires a reason."
  }
 }
}
]
```

## Template: surface credit-case (decision result)

```json
[
{"version":"v0.9","createSurface":{"surfaceId":"credit-case","catalogId":"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"}},
{"version":"v0.9","updateComponents":{"surfaceId":"credit-case","components":[
{"id":"root","component":"Card","child":"col"},
{"id":"col","component":"Column","children":["head","detail","reason","note","reopen"]},
{"id":"head","component":"Row","children":["icon","title"],"align":"center"},
{"id":"icon","component":"Icon","name":{"path":"/icon"}},
{"id":"title","component":"Text","text":{"path":"/title"},"variant":"h3"},
{"id":"detail","component":"Text","text":{"path":"/detail"}},
{"id":"reason","component":"Text","text":{"path":"/reason"},"variant":"caption"},
{"id":"note","component":"Text","text":"Demo only — no credit system was changed.","variant":"caption"},
{"id":"reopen","component":"Button","child":"reopen-t","action":{"event":{"name":"credit_reopen"}},"variant":"borderless"},
{"id":"reopen-t","component":"Text","text":"Reopen case"}
]}},
{
 "version": "v0.9",
 "updateDataModel": {
  "surfaceId": "credit-case",
  "path": "/",
  "value": {
   "icon": "check",
   "title": "Approved: EUR 200,000",
   "detail": "Below the agent recommendation of EUR 250,000.",
   "reason": "Analyst reason: CFO change adds risk; start lower and review in Q2."
  }
 }
}
]
```
