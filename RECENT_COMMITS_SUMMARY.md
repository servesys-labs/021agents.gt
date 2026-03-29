# Recent Commits Summary

## 1. `521d60b` — Usage billing attribution, voice tenant resolution, MVP and portal fixes
**Date:** 2026-03-29

- Added billing records with `billing_user_id` and `api_key_id` (migration 010); inference rows from edge runtime and proxy; `GET /billing/usage` by billing subject.
- Resolved Vapi webhook org/agent from agent voice config; added telephony billing rows; portal telephony cost card and `UsageResponse` types.
- Runtime forwards `channel_user_id` and `api_key_id` through `runViaAgent`/`streamRun`; `writeBillingRecord` persists subject fields.
- MVP fixes: authenticated playground, flow/knowledge/insights fixes, `ensure-array` normalization, voice and settings updates; CLI/SDK/widget adjustments.

## 2. `b47858c` — Wire MVP to real API, add personal assistant flow + Telegram token integration
**Date:** 2026-03-28

- Removed all mock data (`mock-data.ts` deleted), wired 11 pages to the real control-plane API.
- Added loading/error/empty states to every page.
- Dashboard shows real stats from `/dashboard/stats` and real agent list from `/agents`.
- Agent builder posts to `POST /agents` on create; onboarding posts to `POST /orgs/settings` with business vs personal assistant flow.
- Telegram token-first flow: connect, `setWebhook`, QR from API.
- Personal assistant path: OpenClaw-inspired onboarding, Telegram/WhatsApp/Slack QR channels.
- Added `agent-path.ts`, `chat-connect.ts`, `product.ts`, `wrangler.jsonc` for CF Workers deployment.
- CORS: allow `*.servesys.workers.dev` origins on control-plane.

## 3. `979026e` — Downgrade OpenAPI spec to 3.0.3 for Insomnia/Postman compatibility
**Date:** 2026-03-28

- Insomnia doesn't support OpenAPI 3.1.0; downgraded spec to 3.0.3.
- Adjusted post-processing: `nullable` stays as-is (valid in 3.0), `exclusiveMinimum` converted from number back to boolean (3.0 format).
