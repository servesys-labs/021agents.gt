# Agent Harness Investor Competitive Analysis And Strategic Positioning Memo

Prepared from the current `agent-harness` repository state on April 14, 2026. This memo reviews the lightweight Cloudflare-native implementation in [README.md](./README.md), [src/server.ts](./src/server.ts), [gateway/src/server.ts](./gateway/src/server.ts), [wrangler.jsonc](./wrangler.jsonc), and the Svelte UI under [ui/src](./ui/src), rather than the older control-plane/deploy/portal architecture described in the shared workspace instructions.

## Executive Summary

Agent Harness is best understood as a pre-MVP managed agent operating system for small and midsize businesses, not as a consumer assistant and not yet as an enterprise governance platform. The product already demonstrates unusually strong technical depth for its stage: multi-tenant Durable Object isolation, browser tools, sandboxed code execution, MCP connectivity, semantic memory, voice, channels, eval scaffolding, billing primitives, and a marketplace are all present in the codebase ([README.md](./README.md), [wrangler.jsonc](./wrangler.jsonc), [src/server.ts](./src/server.ts), [gateway/src/server.ts](./gateway/src/server.ts)).

The strongest market opening is the segment between consumer AI assistants and heavyweight enterprise agent suites: SMB teams that want one hosted system for customer support, internal operations, and lightweight custom automation. That wedge is materially different from OpenAI and Lindy on the consumer side, and from Microsoft and Salesforce on the enterprise side. The closest market analogs are Relevance AI, Botpress, Intercom Fin, Gorgias, and HubSpot Breeze.

Public pricing in the current market suggests four distinct pricing bands. Consumer and prosumer assistants cluster around roughly `$20-$200` per seat per month, with ChatGPT Plus at `$20`, ChatGPT Pro at `$100` and `$200`, and Lindy at `$49.99-$199.99` ([OpenAI Help Center](https://help.openai.com/en/articles/6950777-chatgpt-plus), [OpenAI Help Center](https://help.openai.com/en/articles/9793128), [Lindy](https://www.lindy.ai/pricing)). SMB workflow and AI workforce platforms cluster around `$19-$495+` per month before heavy usage or AI spend ([Relevance AI](https://relevanceai.com/pricing), [Botpress](https://botpress.com/pricing)). Customer-support-focused agents are rapidly converging on outcome pricing around `$0.50-$0.99` per resolved conversation ([HubSpot](https://www.hubspot.com/company-news/hubspots-customer-agent-and-prospecting-agent-now-you-pay-when-the-task-is-complete), [Intercom Fin](https://fin.ai/pricing), [Gorgias](https://www.gorgias.com/pricing)). Enterprise internal-agent systems price through credits, conversations, or add-on licenses ([Microsoft Copilot Studio licensing guide](https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/microsoft/bade/documents/products-and-services/en-us/microsoft-365/Microsoft-Copilot-Studio-Licensing-Guide-October-2025-PUB.pdf), [Salesforce Agentforce](https://www.salesforce.com/agentforce/pricing/)).

The main investor-grade positive is product ambition backed by real implementation breadth. The main investor-grade risk is execution discipline: the current repo review surfaced a direct worker authentication gap, schema drift between gateway code and the checked-in migration, and a release path that can ship stale UI assets ([src/server.ts](./src/server.ts), [gateway/src/server.ts](./gateway/src/server.ts), [gateway/migrations/001_init.sql](./gateway/migrations/001_init.sql), [package.json](./package.json), [wrangler.jsonc](./wrangler.jsonc), [README.md](./README.md)).

## What The Product Is Today

### Current Product Thesis In Code

The codebase describes a hosted, multi-tenant managed agent platform built almost entirely on Cloudflare primitives. The runtime combines Workers AI, Durable Objects, browser automation, sandboxed code execution, R2-backed workspaces, Vectorize-backed memory, queue-based telemetry, and a growing control plane for billing, sessions, evals, marketplace, RAG, and org management ([README.md](./README.md), [wrangler.jsonc](./wrangler.jsonc), [src/server.ts](./src/server.ts), [gateway/src/server.ts](./gateway/src/server.ts)).

### Current Capability Snapshot

| Area | What exists now | Evidence |
| --- | --- | --- |
| Core runtime | Multi-tenant chat agent runtime with WebSocket connections, tools, compaction, workspace support, and per-agent model selection | [src/server.ts](./src/server.ts) |
| Model routing | Free Workers AI models plus OpenRouter-style routed premium models through Cloudflare AI Gateway | [src/server.ts](./src/server.ts) |
| Tooling | Web search, browser rendering, browser screenshots, calculator, weather, sandbox exec, persistent code, previews, git clone, deploy helpers, API/database calls | [README.md](./README.md), [src/server.ts](./src/server.ts) |
| Managed agents | Dynamic agent supervisor for CRUD plus configurable agent registry in the gateway | [src/server.ts](./src/server.ts), [gateway/src/server.ts](./gateway/src/server.ts) |
| Channels and voice | Channel adapters for Telegram, WhatsApp, Slack, Messenger, Instagram, Teams, email, and voice-specific runtime support | [src/channels](./src/channels), [src/server.ts](./src/server.ts) |
| Memory | Context blocks, FTS search, semantic memory via Vectorize, memory threat scanning, skill overlays, procedural memory scaffolding | [src/server.ts](./src/server.ts), [test/e2e/skills-memory-signals.test.ts](./test/e2e/skills-memory-signals.test.ts) |
| Billing | Credits, top-ups, Stripe checkout, transaction history, usage summaries, billing UI | [gateway/src/server.ts](./gateway/src/server.ts), [ui/src/routes/settings/billing/+page.svelte](./ui/src/routes/settings/billing/+page.svelte) |
| Evals and marketplace | Eval runs, test cases, publish/install marketplace listings, ratings, RAG document upload | [gateway/src/server.ts](./gateway/src/server.ts) |
| UI | Svelte UI with dashboard, sessions, traces, canvas, skills, billing, marketplace, connectors, workspace, settings, and chat views | [ui/src/routes](./ui/src/routes) |

### What This Means Strategically

This is not a thin chat wrapper. It is also not yet a narrowly optimized single-use application. The platform already spans three product categories at once:

- hosted AI assistants
- managed business agents
- agent-builder infrastructure

That breadth creates optionality, but at the pre-MVP stage it also creates positioning risk. Investors will see a powerful foundation. Buyers will see an unclear first use case unless the message is tightened.

## Market Map

### Category Landscape

| Category | Representative companies | Buyer | Typical buying logic | Pricing architecture |
| --- | --- | --- | --- | --- |
| Consumer and prosumer assistants | ChatGPT, Lindy | Individual professional or very small team | Personal productivity, research, email, scheduling, lightweight assistant use | Mostly seat-based monthly subscriptions |
| SMB AI workforce and automation platforms | Relevance AI, Botpress | Operator, founder, RevOps, support lead, growth team | Build and run several agents and workflows without large internal platform teams | Monthly platform fee plus actions, credits, or AI spend |
| Customer-support managed agents | Intercom Fin, Gorgias AI Agent, HubSpot Breeze Customer Agent | Head of support, CX lead, ecommerce operator | Reduce support cost and increase automated resolution rate | Outcome-based pricing, seat add-ons, or helpdesk-bundled pricing |
| Enterprise internal-agent suites | Microsoft Copilot Studio, Salesforce Agentforce | CIO, enterprise apps team, digital transformation leader | Internal copilots, employee agents, governed enterprise automation | Credits, conversation pricing, or expensive seat add-ons |
| Enterprise design and orchestration platforms | Voiceflow | CX platform owner or design team | Build, test, and govern conversational experiences across environments | Usually sales-led, enterprise-oriented pricing |

### Closest Strategic Peers

The closest strategic peers are not the biggest AI brands overall. The closest peers are the products that try to combine hosted runtime, reusable agents, integrations, and business-user workflows:

- Relevance AI
- Botpress
- Intercom Fin
- Gorgias AI Agent
- HubSpot Breeze Customer Agent

The right investor comparison set should therefore include both horizontal agent platforms and vertical support-agent products. That mix better reflects both the opportunity and the competitive pressure.

## Competitive Comparison

### Competitor Snapshot

| Company / product | Core wedge | Primary buyer | Public pricing snapshot | Strategic read versus Agent Harness |
| --- | --- | --- | --- | --- |
| OpenAI ChatGPT Business / Plus / Pro | Best-in-class general assistant for individuals and teams | Individual professional, small team, knowledge worker | ChatGPT Plus is `$20/month`; ChatGPT Business is `$25/seat/month` monthly or `$20/seat/month` annual; ChatGPT Pro now has `$100` and `$200` tiers ([OpenAI Help Center](https://help.openai.com/en/articles/6950777-chatgpt-plus), [OpenAI Help Center](https://help.openai.com/en/articles/8792536-managing-billing-and-seats-in-chatgpt-business), [OpenAI Help Center](https://help.openai.com/en/articles/9793128)) | Strongest consumer baseline and strongest default AI brand. Hard to beat on trust and usage habit. Weak comp for multi-agent SMB operations unless internal tools and governance are the main story. |
| Lindy | Personal executive assistant and inbox/calendar automation | Founder, executive, individual operator | Plus `$49.99/month`, Pro `$99.99/month`, Max `$199.99/month`, Enterprise custom ([Lindy](https://www.lindy.ai/pricing)) | Closest consumer/prosumer managed-assistant comp. Much clearer positioning, much narrower surface area. |
| Relevance AI | AI workforce and agent automation platform | SMB and mid-market ops teams | Free, Pro `$19/month`, Team `$234/month`, Enterprise custom ([Relevance AI](https://relevanceai.com/pricing)) | One of the best directional comps. Strong overlap with AI workforce, integrations, scheduling, analytics, and evaluations. |
| Botpress | Hosted builder plus production runtime for AI agents | Builders, technical operators, support teams | PAYG `$0`, Plus `$89/month`, Team `$495/month`, Managed `$1,245/month`, Enterprise custom; third-party AI token costs passed through without markup ([Botpress](https://botpress.com/pricing)) | Strong product-design and deployment comp. Better current packaging and builder clarity. Less opinionated around bundled managed-agent use cases. |
| Intercom Fin | AI support agent for customer service | Support leader, CX leader | `$0.99` per outcome, 50 outcomes monthly minimum; with Intercom helpdesk, `+$29` per helpdesk seat per month; add-ons include Pro at `$99` and Copilot at `$35` ([Intercom Fin](https://fin.ai/pricing)) | Strongest direct benchmark for support automation monetization and ROI framing. Narrower than Agent Harness but commercially much sharper. |
| Gorgias AI Agent | Ecommerce-first support and conversion agent | Ecommerce CX and support lead | Helpdesk from `$300/month`; AI Agent pricing is `$0.90` per resolved conversation on annual plans or `$1.00` on monthly plans ([Gorgias](https://www.gorgias.com/pricing)) | Strong ecommerce vertical wedge. Important outcome-pricing benchmark for SMB support buyers. |
| HubSpot Breeze Customer Agent | Support automation inside an SMB CRM and service suite | SMB revenue and service teams already on HubSpot | As of April 14, 2026, Breeze Customer Agent moved to `$0.50` per resolved conversation; Breeze Prospecting Agent moved to `$1` per recommended lead ([HubSpot](https://www.hubspot.com/company-news/hubspots-customer-agent-and-prospecting-agent-now-you-pay-when-the-task-is-complete)) | Potentially the most important SMB pricing signal. HubSpot can underprice because the agent is bundled into a broader system of record. |
| Microsoft Copilot Studio | Internal enterprise agent builder tied to Microsoft stack | Enterprise IT, knowledge and process owners | Microsoft 365 Copilot is `$30/user/month` paid yearly and includes Copilot Studio access for licensed users; Copilot Studio PAYG is `$0.01` per Copilot credit; credit pack is `$200/month` for `25,000` credits ([Microsoft](https://www.microsoft.com/en-us/microsoft-365-copilot/microsoft-copilot-studio), [Microsoft licensing guide](https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/microsoft/bade/documents/products-and-services/en-us/microsoft-365/Microsoft-Copilot-Studio-Licensing-Guide-October-2025-PUB.pdf)) | Powerful enterprise comp, but materially less relevant for SMB wedge selection. Validates credit-based pricing and internal-agent budgets. |
| Salesforce Agentforce | Enterprise digital labor for customer and employee workflows | Large enterprise and complex CRM buyer | Foundations includes `200k` Flex Credits for free; flex pricing is `$500` per `100k` credits; conversation pricing is `$2` per conversation; employee-facing add-ons start at `$125/user/month`; user license starts at `$5/user/month` with required Flex Credits ([Salesforce](https://www.salesforce.com/agentforce/pricing/)) | Enterprise upper bound, not direct SMB competitor. Validates credit and conversation billing, but at price points well above SMB tolerance. |
| Voiceflow | Enterprise conversational design, evaluation, and deployment | CX design and platform teams | Public pricing page is sales-led and enterprise-oriented, without clean self-serve public price points; positioning emphasizes agent builder, observability, and production environments ([Voiceflow](https://www.voiceflow.com/pricing)) | Relevant as a product and workflow reference, especially on testing and environment management, but not a clean public-pricing comp. |

### Pricing Benchmark Bands

| Pricing band | Market range | Representative evidence | Implication for Agent Harness |
| --- | --- | --- | --- |
| Consumer/prosumer seat pricing | `$20-$200` per user per month | ChatGPT Plus / Pro and Lindy pricing ([OpenAI Help Center](https://help.openai.com/en/articles/6950777-chatgpt-plus), [OpenAI Help Center](https://help.openai.com/en/articles/9793128), [Lindy](https://www.lindy.ai/pricing)) | Pure consumer positioning would compete directly with category leaders that already own brand, habit, and distribution. |
| SMB platform subscription | `$19-$495+` per month before heavy usage | Relevance AI and Botpress pricing ([Relevance AI](https://relevanceai.com/pricing), [Botpress](https://botpress.com/pricing)) | The current product breadth fits this band better than the consumer band. |
| Support-agent outcome pricing | `$0.50-$0.99` per resolved conversation | HubSpot, Intercom Fin, Gorgias ([HubSpot](https://www.hubspot.com/company-news/hubspots-customer-agent-and-prospecting-agent-now-you-pay-when-the-task-is-complete), [Intercom Fin](https://fin.ai/pricing), [Gorgias](https://www.gorgias.com/pricing)) | This is the clearest monetization anchor for customer-facing support use cases. |
| Enterprise internal-agent pricing | `$0.01` per credit, `$2` per conversation, or `$125+` per user per month | Microsoft Copilot Studio and Salesforce Agentforce ([Microsoft licensing guide](https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/microsoft/bade/documents/products-and-services/en-us/microsoft-365/Microsoft-Copilot-Studio-Licensing-Guide-October-2025-PUB.pdf), [Salesforce](https://www.salesforce.com/agentforce/pricing/)) | Enterprise pricing is much richer, but selling motion, implementation burden, and trust requirements are also much higher. |

## Where Agent Harness Is Strong

### Technical Depth Relative To Stage

For a pre-MVP codebase, Agent Harness is ahead of most early-stage competitors on runtime ambition. The product already includes multi-tenant isolation, semantic memory, sandboxed code execution, browser tools, channel adapters, voice support, eval scaffolding, billing primitives, and marketplace/RAG surfaces in a single hosted system ([README.md](./README.md), [src/server.ts](./src/server.ts), [gateway/src/server.ts](./gateway/src/server.ts), [wrangler.jsonc](./wrangler.jsonc)).

### Cost-Structure Story

The Cloudflare-native architecture creates a credible cost-structure narrative. If executed well, that story can support lower hosting cost, simpler per-tenant isolation, and attractive margins for lightweight managed agents relative to heavier cloud stacks ([README.md](./README.md), [wrangler.jsonc](./wrangler.jsonc)).

### Product Optionality

The same runtime can plausibly support:

- customer support agents
- internal operations agents
- coding and research agents
- white-labeled or marketplace-distributed agents

That optionality is valuable to investors if paired with a disciplined go-to-market sequence.

## Where Agent Harness Is Weak

### Positioning Is Too Broad

The platform currently presents itself as personal assistant, coding agent, research agent, support agent, marketplace, voice product, and agent-building platform at the same time ([README.md](./README.md), [src/server.ts](./src/server.ts), [ui/src/routes/+page.svelte](./ui/src/routes/+page.svelte)). That breadth is a product asset but a messaging liability.

### Commercial Packaging Is Not Yet Clear

The billing system exists, but the commercial package is not yet narratively simple. Credit packages, model pass-through pricing, and support-style outcome pricing all appear possible, but there is not yet a clean investor-facing or buyer-facing packaging story ([src/server.ts](./src/server.ts), [gateway/src/server.ts](./gateway/src/server.ts), [ui/src/routes/settings/billing/+page.svelte](./ui/src/routes/settings/billing/+page.svelte)).

### Trust And Operational Readiness Need Work

Three issues matter immediately for investor diligence:

- the worker-side auth boundary currently trusts unsigned token-shaped inputs ([src/server.ts](./src/server.ts))
- the gateway and checked-in schema do not align cleanly ([gateway/src/server.ts](./gateway/src/server.ts), [gateway/migrations/001_init.sql](./gateway/migrations/001_init.sql))
- root build and deploy paths can drift from the Svelte UI assets that Wrangler actually serves ([package.json](./package.json), [wrangler.jsonc](./wrangler.jsonc), [README.md](./README.md))

These are fixable execution issues, but they should not be hidden in an investor process.

## Gaps In The Market

### The Most Attractive White Space

The largest white space is the segment that wants more than a single personal assistant, but less than a full enterprise agent transformation program. That segment includes:

- SMB SaaS companies
- ecommerce operators
- small support teams
- founder-led businesses
- agencies running repeated workflows for clients

These buyers often want one system that can power support, back-office automation, research, and content or code tasks. The current market is fragmented:

- consumer AI is strong but not operationally managed
- support agents are strong but narrow
- enterprise platforms are capable but heavy
- horizontal platforms are powerful but often too builder-centric

Agent Harness can fit the middle if the product is packaged as managed business agents, not as an all-purpose AI platform.

### Most Defensible Beachhead

The most defensible beachhead is **managed SMB agents for support plus operations**. That wedge is stronger than:

- pure consumer assistant
- generic agent-builder platform
- direct enterprise internal-agent suite

It aligns with the runtime’s current strengths, the market’s current pricing behavior, and buyer willingness to pay for automation that directly reduces labor cost or improves response times.

## Recommended Positioning

### Suggested Company Narrative

Agent Harness should be positioned as a **managed agent operating system for small and midsize businesses**, starting with customer support and operations automation, then expanding into broader team workflows.

### Suggested Investor One-Liner

Agent Harness is building a Cloudflare-native managed agent platform that gives SMBs the operational leverage of enterprise agent systems without enterprise complexity, starting with support and operations workflows where ROI is easiest to measure.

### What To Avoid

- avoid leading with “personal AI assistant”
- avoid leading with “general AI platform”
- avoid leading with “enterprise governance” before trust controls are fixed
- avoid leading with “marketplace” before a primary wedge is established

## Recommended Pricing Strategy

### Pricing Architecture Recommendation

A hybrid model is the strongest fit:

1. subscription fee for access, seats, and included capabilities
2. included usage allowance measured in credits or resolved conversations
3. overage for premium usage and premium model consumption

This mirrors what the market has validated across SMB and enterprise products while preserving margin discipline ([Relevance AI](https://relevanceai.com/pricing), [Botpress](https://botpress.com/pricing), [HubSpot](https://www.hubspot.com/company-news/hubspots-customer-agent-and-prospecting-agent-now-you-pay-when-the-task-is-complete), [Intercom Fin](https://fin.ai/pricing), [Microsoft licensing guide](https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/microsoft/bade/documents/products-and-services/en-us/microsoft-365/Microsoft-Copilot-Studio-Licensing-Guide-October-2025-PUB.pdf), [Salesforce](https://www.salesforce.com/agentforce/pricing/)).

### Recommended Pre-MVP Packaging

| Plan | Target customer | Suggested monthly price | Included usage | Overage model | Strategic goal |
| --- | --- | --- | --- | --- | --- |
| Starter | Founder-led SMB or small support team | `$199-$299` | 2-3 seats, 3 agents, web chat/email, fixed monthly credit pool | Additional credits or `$0.60-$0.90` per resolved conversation for support flows | Land and validate ROI quickly |
| Growth | SMB with recurring support and ops workflows | `$799-$999` | 5-10 seats, more agents, voice, sandbox, evals, larger included pool | Credits plus premium model pass-through | Become system of record for automation workflows |
| Scale | Multi-team mid-market customer | `$2,000+` or annual commit | Higher seats, advanced observability, SSO, custom connectors, support SLAs | Contracted usage tiers | Introduce sales-led expansion without becoming enterprise-heavy too early |

### Outcome Pricing Recommendation

For customer-support use cases, the market now supports a credible outcome-pricing benchmark of roughly `$0.50-$0.99` per resolved conversation ([HubSpot](https://www.hubspot.com/company-news/hubspots-customer-agent-and-prospecting-agent-now-you-pay-when-the-task-is-complete), [Intercom Fin](https://fin.ai/pricing), [Gorgias](https://www.gorgias.com/pricing)). A product entering that lane should not assume it can price materially above Intercom or Gorgias without a clearly differentiated resolution rate, workflow depth, or vertical specialization.

For internal operations and research/coding flows, a credit model is likely cleaner than outcome pricing because the business outcome is harder to standardize. The existing internal model catalog and billing surfaces already support this direction conceptually ([src/server.ts](./src/server.ts), [gateway/src/server.ts](./gateway/src/server.ts), [ui/src/routes/settings/billing/+page.svelte](./ui/src/routes/settings/billing/+page.svelte)).

## Investor Diligence View

### Green Flags

| Dimension | Assessment | Why it matters |
| --- | --- | --- |
| Runtime ambition | Strong | The platform has more real implementation depth than many pre-MVP agent startups. |
| Architecture coherence | Strong | The Cloudflare-native story is unusually coherent across runtime, storage, and isolation layers. |
| Product optionality | Strong | The same base can power several monetizable products if focus is added. |
| Pricing flexibility | Medium-strong | Credits, subscriptions, and outcome pricing are all plausible from the current foundation. |

### Yellow Flags

| Dimension | Assessment | Why it matters |
| --- | --- | --- |
| Positioning clarity | Yellow | Too many product stories are competing for the front page. |
| Commercial packaging | Yellow | Billing exists, but the productized offer is not yet simple enough for fast buyer comprehension. |
| Observability depth | Yellow | Sessions, traces, and telemetry exist, but some investor-grade operational views are still partial ([gateway/src/server.ts](./gateway/src/server.ts)). |

### Red Flags

| Dimension | Assessment | Why it matters |
| --- | --- | --- |
| Auth boundary | Red | Worker-side auth currently allows unsigned token-shaped inputs ([src/server.ts](./src/server.ts)). |
| Data-model source of truth | Red | Gateway queries and checked-in migration appear out of sync ([gateway/src/server.ts](./gateway/src/server.ts), [gateway/migrations/001_init.sql](./gateway/migrations/001_init.sql)). |
| Release reproducibility | Red | Root build path and served asset path are not aligned cleanly ([package.json](./package.json), [wrangler.jsonc](./wrangler.jsonc), [README.md](./README.md)). |

## Recommended Next 90 Days

### Product Priorities

1. Fix the worker authentication boundary and align schema/code so the repo can survive diligence scrutiny.
2. Collapse the go-to-market story to a single wedge: managed SMB support and operations agents.
3. Productize one clear pricing story with one starter plan and one growth plan.
4. Tighten the UI around activation, ROI visibility, and agent-specific workflows rather than general platform sprawl.
5. Turn evals, traces, and billing into a sharper proof-of-value story for operators.

### Messaging Priorities

1. Lead with business leverage, not infrastructure cleverness.
2. Show labor-saving workflows, not generic agent demos.
3. Frame Cloudflare-native architecture as a cost and isolation advantage, not the product itself.
4. Show the path from support automation into broader operational automation.

## Conclusion

Agent Harness is commercially most promising when treated as a managed business-agent platform for SMBs, with support and operations as the initial wedge. The codebase is already deeper than most pre-MVP peers, which is a genuine asset in investor conversations. The risk is not lack of ambition; the risk is lack of focus and a few avoidable execution issues that can undermine trust.

The market is sending a clear signal. Consumer AI assistants are crowded and brand-dominated. Enterprise agent platforms are powerful but heavy. The most attractive opening is the operational middle: teams that want managed agents with measurable ROI, practical integrations, and pricing they can understand. If Agent Harness tightens its story, fixes its trust gaps, and prices like an SMB operating system rather than a science project, it can occupy a differentiated and credible position in the managed-agent landscape.
