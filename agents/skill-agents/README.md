# Skill Agent Seeds

Curated single-purpose skill agents designed for the OneShots marketplace.
These are deployed as the initial marketplace catalog when a new org is created.

## Default Two-Agent Architecture

Every OneShots org gets two agents by default:

1. **personal-assistant** (`agent_role: personal_assistant`) — The user's daily companion.
   Connects to Telegram, WhatsApp, SMS. Handles tasks, reminders, research directly.
   Delegates specialized work to marketplace skill agents via A2A.

2. **orchestrator** (`agent_role: meta_agent`) — The org's meta-agent.
   Manages all agents, creates new ones, monitors performance, handles platform operations.

## Skill Agent Catalog

| Agent | Category | Pricing Model | Price | Description |
|-------|----------|---------------|-------|-------------|
| deep-research | research | cost_plus (20%) | LLM cost + 20% | Multi-source research with citations |
| travel-planner | travel | fixed | $0.25/task | End-to-end trip planning |
| flight-search | travel | fixed | $0.15/task | Flight price comparison |
| meal-planner | health | fixed | $0.10/task | Weekly meal plans + shopping lists |
| fitness-coach | health | fixed | $0.10/task | Personalized workout plans |
| expense-tracker | finance | fixed | $0.05/task | Natural language expense tracking |
| document-generator | creative | fixed | $0.15/task | Invoices, contracts, proposals |
| email-drafter | creative | fixed | $0.05/task | Professional email drafting |
| social-media-manager | marketing | fixed | $0.10/task | Cross-platform content creation |
| news-briefing | research | fixed | $0.10/task | Curated news digests |
| shopping-assistant | shopping | fixed | $0.10/task | Product research + price comparison |
| translator | creative | per_token | $0.005/1k in | 50+ language translation |
| calendar-manager | support | fixed | $0.10/task | Smart scheduling + conflict detection |
| smart-home | other | fixed | $0.05/task | IoT device control + automation |
| app-builder | coding | cost_plus (30%) | LLM cost + 30% | Build apps from descriptions |
| legal-assistant | legal | cost_plus (25%) | LLM cost + 25% | Contract review + legal docs |

## Pricing Models

- **fixed**: Flat rate per task. Simple, predictable.
- **cost_plus**: Actual LLM costs + margin percentage. Fair for variable-complexity tasks.
- **per_token**: Rate per 1k input/output tokens. For throughput-based work like translation.

## A2A Flow

```
User → Personal Assistant → marketplace-search → a2a-send → Skill Agent
                                                                  ↓
User ← Personal Assistant ← response + artifacts ← share-artifact ←
```

The personal assistant handles the user relationship.
Skill agents handle the specialized work and get paid per task.
Platform takes 10% of all A2A payments.
