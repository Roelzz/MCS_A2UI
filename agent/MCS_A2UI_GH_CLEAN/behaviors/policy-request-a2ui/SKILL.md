---
name: policy-request-a2ui
description: Use when the user asks whether they may work from another country or city, work abroad, or about a remote-work or travel policy (e.g. "can I work from Lisbon for six weeks?"), or when a JSON envelope is a ui_action or correction for a surfaceId starting with policy-. Returns an agent-authored A2UI v0.9 answer with eligibility checks and a prefilled request form. Fictional policy; never submits anything.
---
<!-- bic:source=blank -->

# Policy answer that becomes a request (A2UI)

## When to use

- A `chat` envelope asking about working abroad, working from another city or country, or the remote-work policy.
- A `ui_action` or `correction` envelope for surface `policy-lisbon`.

Do not use for morning briefs, credit cases, desk requests or general chat.

## Fictional policy HR-114 (the only facts you may use)

- Approved countries for short stays: Portugal, Spain, Netherlands, Ireland.
- Maximum 6 weeks (42 days) abroad per calendar year, counted from first to last day.
- Engineering roles are remote-eligible. Manager approval is always required.

## State rules

For a `chat` turn, use the template data model exactly (Lisbon, 2026-12-01 to 2027-01-12, 42 days). If the user names another approved country/city, adapt `answer` and the first check label only.

Length rule: days = last day minus first day. With first day 2026-12-01: last day 2027-01-12 is 42 days (6 weeks, eligible); 2027-01-19 is 49 days (7 weeks, not eligible). Any last day after 2027-01-12 is over the limit. Dates may arrive with a time part; use only the date.

`policy_recheck` and `policy_submit` carry the current form values in `context`. Copy them into `request` and recompute:
- **Eligible** (≤ 42 days): all four checks use icon `check`; second check detail `"Your dates: <weeks> weeks (<days> days)."`; `answer` "Yes — your dates fit the policy."; `verdict` "Eligible. Review the prefilled request and submit when ready."
- **Not eligible** (> 42 days): second check icon `close`, detail `"Your dates: <weeks> weeks (<days> days) — <extra> days over the limit."`; `answer` "Not as entered — that is longer than the policy allows."; `verdict` explains why and how to fix it, e.g. "HR-114 allows at most 6 weeks abroad per year. End on or before 12 Jan 2027, or ask HR about an exception."; `text` says which check flipped and why.
- `policy_submit` while not eligible: return the not-eligible form; do not create the receipt.
- `policy_submit` while eligible with a nonblank manager and reason: return the receipt template instead (same surfaceId `policy-lisbon`), with `summary` like "Lisbon, 1 Dec 2026 – 12 Jan 2027 (6 weeks). Reason: …" and `manager` "Waiting for Ana Ribeiro (simulated)". `text` "Your request is ready — this demo did not submit it anywhere."

## Protocol (shared by every A2UI skill in this agent)

The demo app sends exactly one JSON envelope per user turn and validates your reply strictly.

Input envelopes (ordinary message text):
- `{"version":2,"type":"chat","turnId":"<uuid>","text":"<what the user typed>"}`
- `{"version":2,"type":"ui_action","turnId":"<uuid>","surfaceId":"<id>","name":"<action>","context":{...}}` — the user clicked a button on a surface you sent earlier.
- `{"version":2,"type":"correction","turnId":"<uuid>","problem":"<reason>"}` — your previous reply for this turnId was rejected. Fix the problem and send the full corrected reply once, with the same turnId.

Your reply is exactly one JSON object and nothing else — no Markdown fences, no prose before or after:

`{"version":2,"type":"ui","turnId":"<echo the input turnId>","scenario":"policy","skill":"policy-request-a2ui","text":"<one short sentence, max 200 characters>","messages":[ <the three A2UI messages> ]}`

Rules for `messages`:
- Copy the `createSurface` and `updateComponents` messages from the template below **exactly** (same ids, components, actions and checks). Do not add, remove or rename components and do not invent component types.
- Only change the `value` of the `updateDataModel` message, following the state rules below. Keep every key; use `""` or `[]` for empty values.
- Use only plain text in strings: no URLs, HTML, Markdown links or scripts. Use JSON escaping so the reply parses with a strict JSON parser.
- If you cannot produce a valid surface, reply `{"version":2,"type":"error","turnId":"<echo>","message":"<short reason>"}` instead.

Safety: this is a demo with fictional data. Nothing is approved, sent, booked or changed anywhere. Never call tools, connectors, knowledge or the web, and never claim a real-world effect.

## Template: surface policy-lisbon (answer + form)

```json
[
{"version":"v0.9","createSurface":{"surfaceId":"policy-lisbon","catalogId":"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"}},
{"version":"v0.9","updateComponents":{"surfaceId":"policy-lisbon","components":[
{"id":"root","component":"Card","child":"col"},
{"id":"col","component":"Column","children":["answer","checks-head","checks","policy-ref","divider","form-head","dates","manager","reason","verdict","actions"]},
{"id":"answer","component":"Text","text":{"path":"/answer"},"variant":"h4"},
{"id":"checks-head","component":"Text","text":"Eligibility checks","variant":"h5"},
{"id":"checks","component":"List","children":{"path":"/checks","componentId":"c-row"}},
{"id":"c-row","component":"Row","children":["c-icon","c-col"],"align":"center"},
{"id":"c-icon","component":"Icon","name":{"path":"icon"}},
{"id":"c-col","component":"Column","children":["c-label","c-detail"]},
{"id":"c-label","component":"Text","text":{"path":"label"}},
{"id":"c-detail","component":"Text","text":{"path":"detail"},"variant":"caption"},
{"id":"policy-ref","component":"Row","children":["p-icon","p-text"],"align":"center"},
{"id":"p-icon","component":"Icon","name":"info"},
{"id":"p-text","component":"Text","text":{"path":"/policyRef"},"variant":"caption"},
{"id":"divider","component":"Divider"},
{"id":"form-head","component":"Text","text":"Your request (prefilled)","variant":"h5"},
{"id":"dates","component":"Row","children":["start","end"]},
{"id":"start","component":"DateTimeInput","label":"First day abroad","value":{"path":"/request/start"},"enableDate":true},
{"id":"end","component":"DateTimeInput","label":"Last day abroad","value":{"path":"/request/end"},"enableDate":true},
{"id":"manager","component":"TextField","label":"Approving manager","value":{"path":"/request/manager"}},
{"id":"reason","component":"TextField","label":"Reason","value":{"path":"/request/reason"}},
{"id":"verdict","component":"Text","text":{"path":"/verdict"}},
{"id":"actions","component":"Row","children":["recheck","submit"]},
{"id":"recheck","component":"Button","child":"recheck-t","action":{"event":{"name":"policy_recheck","context":{"start":{"path":"/request/start"},"end":{"path":"/request/end"}}}}},
{"id":"recheck-t","component":"Text","text":"Re-check eligibility"},
{"id":"submit","component":"Button","child":"submit-t","action":{"event":{"name":"policy_submit","context":{"start":{"path":"/request/start"},"end":{"path":"/request/end"},"manager":{"path":"/request/manager"},"reason":{"path":"/request/reason"}}}},"variant":"primary","checks":[{"condition":{"call":"required","args":{"value":{"path":"/request/manager"}}},"message":"Add your approving manager."},{"condition":{"call":"required","args":{"value":{"path":"/request/reason"}}},"message":"Add a short reason."}]},
{"id":"submit-t","component":"Text","text":"Submit request"}
]}},
{
 "version": "v0.9",
 "updateDataModel": {
  "surfaceId": "policy-lisbon",
  "path": "/",
  "value": {
   "answer": "Yes — you can work from Lisbon for up to six weeks. Your dates fit the policy.",
   "checks": [
    {
     "icon": "check",
     "label": "Portugal is an approved country",
     "detail": "EU country with no tax or permanent-establishment risk for short stays."
    },
    {
     "icon": "check",
     "label": "Maximum 6 weeks abroad per calendar year",
     "detail": "Your dates: 6 weeks (42 days)."
    },
    {
     "icon": "check",
     "label": "Your role can be done remotely",
     "detail": "Engineering roles are remote-eligible."
    },
    {
     "icon": "check",
     "label": "Manager approval",
     "detail": "Prefilled: Ana Ribeiro."
    }
   ],
   "policyRef": "Policy HR-114 Working from abroad, section 3 (fictional demo policy)",
   "request": {
    "start": "2026-12-01",
    "end": "2027-01-12",
    "manager": "Ana Ribeiro",
    "reason": "Work from Lisbon while visiting family"
   },
   "verdict": "Eligible. Review the prefilled request and submit when ready."
  }
 }
}
]
```

## Template: surface policy-lisbon (receipt after an eligible submit)

```json
[
{"version":"v0.9","createSurface":{"surfaceId":"policy-lisbon","catalogId":"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"}},
{"version":"v0.9","updateComponents":{"surfaceId":"policy-lisbon","components":[
{"id":"root","component":"Card","child":"col"},
{"id":"col","component":"Column","children":["head","summary","manager","note"]},
{"id":"head","component":"Row","children":["icon","title"],"align":"center"},
{"id":"icon","component":"Icon","name":"check"},
{"id":"title","component":"Text","text":"Request ready for your manager","variant":"h3"},
{"id":"summary","component":"Text","text":{"path":"/summary"}},
{"id":"manager","component":"Text","text":{"path":"/manager"},"variant":"caption"},
{"id":"note","component":"Text","text":"Demo only — nothing was submitted to HR or your manager.","variant":"caption"}
]}},
{
 "version": "v0.9",
 "updateDataModel": {
  "surfaceId": "policy-lisbon",
  "path": "/",
  "value": {
   "summary": "Lisbon, 1 Dec 2026 – 12 Jan 2027 (6 weeks). Reason: Work from Lisbon while visiting family",
   "manager": "Waiting for Ana Ribeiro (simulated)"
  }
 }
}
]
```
