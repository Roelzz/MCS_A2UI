---
name: desk-setup-a2ui
description: Use when a user message is a version-1 JSON envelope of type equipment_request or equipment_submit from the "Build your perfect desk" demo app, including one exact retry of that same envelope. Returns only the business JSON (equipment_form, equipment_ack or equipment_error) that the app validates and renders as an A2UI form. Do not use for ordinary chat, other UI requests, or anything that would buy, submit, provision or change records.
---
<!-- bic:source=blank -->

# Desk setup v1 protocol

## When to use this skill

Use this procedure only when the current user activity is a version-1 `equipment_request` or `equipment_submit` JSON envelope, or an exact-envelope correction/retry of one of those protocol stages in the same conversation. Do not use it to answer ordinary questions, unrelated requests, or generate arbitrary UI. Do not retrieve information, call tools, or cause external effects.

The host application validates the response strictly. Return only the business JSON described below. The backend owns A2UI component definitions; never return A2UI, UI markup, or any other invented schema.

## Global response and safety constraints

- For each applicable user activity, emit exactly one ordinary text activity containing exactly one valid JSON object. Do not add Markdown fences, prose, explanations, or extra objects.
- This is a demonstration only. Never submit, purchase, provision, create a ticket, request approval, or create or modify any record.
- Preserve identifiers and submitted values exactly when the contract requires it. JSON-escape strings so decoded values remain unchanged.
- Never include, quote, summarize, or otherwise reveal `contextMarker` in an initial response or error response.
- Use conversation history to identify the stage and retrieve `contextMarker` only from the first user activity. Never invent or infer identifiers or context.

## Initial equipment request

The first user activity is expected to be a JSON object with `version: 1`, `type: "equipment_request"`, a UUID `requestId`, an opaque string `contextMarker`, and nonblank `userText`.

The host may repeat the exact same initial request once after a response fails contract validation. Treat the repeated `requestId` and `contextMarker` as a correction of the same request. Return the form again in the required shape; do not reset or replace the original context.

For a valid request:

1. Infer one supported device from `userText`: exactly `laptop`, `monitor`, or `headset`.
2. Write a concise justification grounded in `userText`. It must be nonblank and no more than 1000 characters.
3. Preserve `requestId` exactly.
4. Return exactly this shape, with no additional properties:

   `{"version":1,"type":"equipment_form","requestId":"<same requestId>","device":"laptop|monitor|headset","justification":"<concise justification>"}`

If the JSON is malformed, the envelope is unsupported, `userText` is missing/blank, or a supported device cannot be inferred, return an `equipment_error` object instead. Use `fieldErrors` only for `userText`, `device`, and `justification`, including only fields that need correction. For an invalid/unsupported initial envelope or missing/invalid `requestId`, use `userText` as the `fieldErrors` key and briefly explain that a valid equipment request could not be read. Use the supplied `requestId` exactly when present; use an empty string only when it is absent. Set `submissionId` to the empty string. Initial error shape:

`{"version":1,"type":"equipment_error","requestId":"<same requestId>","submissionId":"","fieldErrors":{"<userText|device|justification>":"<brief error>"}}`

## Follow-up equipment submission

The second user activity in the same conversation is expected to be a JSON object with `version: 1`, `type: "equipment_submit"`, the same `requestId`, a UUID `submissionId`, one supported device, and a nonblank edited `justification`.

The host may repeat the exact same `submissionId` and values once only after receiving an invalid response. Treat it as a correction of the same demo submission; return the acknowledgement again in the required shape with the same IDs and values. Never perform any operation or external effect.

For a valid submission:

1. Preserve the decoded submitted `requestId`, `submissionId`, `device`, and `justification` exactly. Do not trim, rewrite, normalize, or summarize the submitted justification.
2. Retrieve `contextMarker` only from the first user activity in this conversation.
3. Return exactly this shape, with no additional properties:

   `{"version":1,"type":"equipment_ack","requestId":"<same requestId>","submissionId":"<same submissionId>","status":"received_demo","device":"<same device>","justification":"<same justification>","message":"Demo request received — nothing was purchased or submitted. Context check: <exact contextMarker from first turn>"}`

Never invent or infer `contextMarker`; do not expose it before this acknowledgement. JSON-escape string values as required for valid JSON while preserving their decoded values.

If a submission field is invalid, return an `equipment_error` object with `version: 1`, `type: "equipment_error"`, the supplied `requestId` and `submissionId` (use an empty string only for either missing ID), and `fieldErrors` containing only supported keys from `device` and `justification` that need correction. If the IDs or prior context cannot be verified, do not fabricate them or produce an acknowledgement; return a brief `equipment_error` using a supported `fieldErrors` key. Follow-up error shape:

`{"version":1,"type":"equipment_error","requestId":"<same requestId>","submissionId":"<same submissionId>","fieldErrors":{"<device|justification>":"<brief error>"}}`

Keep the protocol stage-specific. Do not answer outside these JSON shapes, and do not emit `contextMarker` in the initial response or any error response.
