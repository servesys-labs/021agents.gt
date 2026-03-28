# AgentOS MVP — product & integration plan

**Status:** planning source of truth for the slim client (`mvp/`) against the full control plane + edge runtime.  
**Audience:** builders aligning UI, API usage, telemetry, and scope.  
**Principle:** thin, intentional UI; full platform underneath; measure everything that matters.

---

## 1. Why this MVP exists

The control plane and runtime expose a **large, deliberate API surface** (many route families). The MVP does **not** showcase every capability. It **does**:

- Deliver **two clear user intents** end-to-end with high polish.
- Call the **same** authenticated APIs the portal and automation use.
- Emit **telemetry** on every critical step so issues and drop-offs are visible.
- Stay **honest** about fallbacks (e.g. LLM unavailable) without pretending the backend is smaller than it is.

---

## 2. Personas (two journeys, one platform)

| Persona | Job to be done | Emotional bar |
|--------|----------------|-----------------|
| **Personal** | A private assistant for day-to-day: research, code help, tasks/reminders framing, mail-style help when connected, chat in Telegram/WhatsApp/Slack. | Trust, privacy, simplicity. |
| **Small business** | A customer-facing assistant: FAQs, leads, orders/handoff, web presence, same chat surfaces where relevant. | Clarity, reliability, “I can ship this.” |

**Implementation rule:** same agents, same routes. Differentiate with **`workspace_mode` / tags** (`workspace:personal` vs `workspace:smb`), onboarding copy, default **creation payload** (seed text for meta-agent), and **telemetry `persona`**.

---

## 3. Scope

### 3.1 In scope (MVP v1)

1. **Auth** — signup/login, session, logout; JWT with required scopes documented per flow.
2. **Onboarding** — explicit fork: personal vs business; persist org preferences (`POST /orgs/settings` or equivalent); no fake data in UI.
3. **Create assistant** — **one** primary user-facing flow:
   - **Personal:** `POST /agents/create-from-description` first (full meta-agent package when `OPENROUTER_API_KEY` is set); **documented** fallback to `POST /agents` with template prompt.
   - **Business:** same engine; **seed description** and tags reflect SMB; optional to prefer explicit `POST /agents` if product decides NL is secondary for SMB v1.
4. **Dashboard** — list agents from `GET /agents`, stats from `GET /dashboard/stats` when scopes allow; graceful degradation.
5. **Test** — exercise agent from UI (`runtime-proxy` / documented run path).
6. **Channels (minimum credible)** — Telegram: `POST /chat/telegram/connect` + `GET /chat/telegram/qr`; WhatsApp/Slack: guided setup + QR/deep link where API does not yet centralize (document gaps).
7. **Settings** — account/org placeholders aligned with real APIs when wired; no fictional billing numbers.
8. **Telemetry** — client events + correlation; see §7.

### 3.2 Explicitly out of scope for MVP v1 (defer without hiding the platform)

- Full graph canvas, eval suite UI, release channels UI, full connector catalog, project meta-agent orchestrator UX.
- Exposing every admin/rbac knob.

These remain **available via API / portal** and should appear in the **internal capability matrix** (§6).

### 3.3 Non-goals

- “MVP = low quality.” Security, authz, and secret handling stay production-grade.
- Duplicating business rules in the client; server remains source of truth.

---

## 4. Canonical user journeys

### 4.1 Personal

1. Sign up → onboarding (personal path) → **Create assistant** (NL/meta path) → **Channels** (Telegram first) → **Test**.
2. Failure paths: LLM down → fallback create + visible message; Telegram token/connect 403 → scope/help copy; stats 403 → dashboard still lists agents.

### 4.2 Small business

1. Sign up → onboarding (business path) → **Create assistant** → dashboard → **Test** → **Channels** / widget snippet as prioritized.
2. Same telemetry and same APIs; different defaults and copy only where specified.

---

## 5. UI principles (keep it light)

- **One primary action** per screen.
- **One mental model** for “create”: wizard steps are **progressive disclosure**, not a second product.
- **Errors** explain what failed and what to do next (scopes, env keys), not raw stack traces for end users.
- **Advanced** = link to **portal** or docs, not 20 new toggles in MVP.

---

## 6. API integration strategy (respect the full backend)

Do not “integrate 420 endpoints” in the UI. Integrate **named flows**:

| Flow | Primary endpoints | Notes |
|------|-------------------|--------|
| Auth | `/auth/*`, `me` | As implemented in `mvp/src/lib/auth.tsx` |
| Org prefs | `/orgs/settings` | Onboarding; tolerate extra keys if API ignores |
| List agents | `GET /agents` | Sidebar + dashboard |
| Create (explicit) | `POST /agents` | Deterministic; `auto_graph` policy documented |
| Create (NL) | `POST /agents/create-from-description` | Meta-agent; requires OpenRouter; gates documented |
| Dashboard stats | `GET /dashboard/stats` | `observability:read` |
| Telegram | `POST /chat/telegram/connect`, `GET /chat/telegram/qr` | Token server-side; `integrations:read/write` |
| Sessions / activity | `/sessions`, agent detail | As wired on agent pages |
| Run / test | `runtime-proxy` paths | Align with deploy docs |

Maintain an **internal matrix** (extend this table) for: required scopes, env vars, and **owner** (MVP vs portal).

**Default project / meta-agent:** optional **default project** without auto-spawning orchestrator meta-agent on every signup (see prior architecture discussion); add when `project_id` is required everywhere.

---

## 7. Telemetry (required for learning)

Emit structured events from the MVP client (or edge middleware where appropriate):

**Properties on all events:** `persona` (`personal` | `smb`), `org_id` if safe, anonymous `session_id`, `client` (`mvp`).

**Minimum event set:**

| Event | When | Payload hints |
|-------|------|----------------|
| `onboarding_started` | Land on onboarding | `path_chosen` after pick |
| `onboarding_completed` | Save settings success | `workspace_mode` |
| `assistant_create_started` | Submit create | `mode`: `llm` \| `explicit` |
| `assistant_create_succeeded` | 201 | `mode`, agent name hash optional |
| `assistant_create_failed` | Error | `error_class`, `http_status` bucket — **no** tokens |
| `channel_setup_opened` | Open modal | `channel`: telegram \| whatsapp \| slack |
| `telegram_connect_succeeded` / `_failed` | After API | `webhook_registered` bool only on success |
| `test_chat_message_sent` | Playground send | count only or latency bucket |

**PII:** never log raw bot tokens, passwords, or message body in analytics; use hashed IDs or omit.

---

## 8. Success metrics (first 4–6 weeks)

- **Activation:** % users completing onboarding + at least one assistant created.
- **Time-to-first-value:** median time from signup to first successful test message or channel connect.
- **Create path:** % NL creates vs fallback; failure rate by reason bucket.
- **Channel:** Telegram connect success rate; webhook_registered true rate.
- **Retention proxy:** return sessions within 7 days (if identifiable).

---

## 9. Phased delivery

| Phase | Focus |
|-------|--------|
| **P0** | Auth, onboarding fork, create (NL + fallback), dashboard real data, Telegram connect + QR, telemetry P0 events |
| **P1** | SMB copy polish, widget/channel priority, stats scopes documented, reduce user-facing “unknown errors” |
| **P2** | Deeper channel parity, optional default project, portal deep links |

---

## 10. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Scope creep in UI | Lock §3.1; everything else goes to matrix “portal only” |
| LLM path flaky | Documented fallback + metrics on `assistant_create_failed` |
| Scope gaps (403) | Per-flow scope table; friendly copy + link to admin |
| Two products diverging | Single `persona` dimension + shared API client patterns |

---

## 11. Code map

- **MVP UI:** `mvp/src/` (pages, `lib/api.ts`, `lib/product.ts`)
- **Control plane:** `control-plane/src/routes/`, `middleware/auth.ts`, `auth/types.ts` (scopes)
- **Feature registry:** `feature_list.json` (verify E2E before flipping `passes`)

---

## 12. Review cadence

- Revisit this doc when **adding a new MVP screen** or **new API dependency**.
- After each release: compare telemetry to §8; adjust §3 or §9 only with explicit product sign-off.
