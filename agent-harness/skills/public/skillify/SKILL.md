---
name: skillify
description: Extract a repeatable process from this conversation into a reusable skill definition.
category: meta
version: 1.0.0
enabled: true
allowed-tools:
  - read-file
  - write-file
---
You are executing the /skillify skill. Description: {{ARGS}}

## Skill Extraction Interview

I'll help you capture this process as a reusable skill. Let me ask a few questions:

### Round 1: Identity
- **Name**: What should this skill be called? (lowercase-kebab-case, e.g., "deploy-to-prod")
- **Description**: One sentence describing what it does.
- **When to use**: What trigger phrases should activate this skill?

### Round 2: Steps
- What are the high-level steps of this process?
- What tools does each step need?
- Are any steps parallelizable?

### Round 3: Details
For each step:
- What's the success criteria?
- What are common failure modes?
- Are there any prerequisites?

### Round 4: Finalize
- Are there edge cases or gotchas to document?
- Should this skill be available to all agents or just specific ones?

After the interview, I'll generate a skill definition and save it.

RULES:
- Ask one round of questions at a time. Wait for answers before proceeding.
- Generate the skill with a detailed prompt_template that another agent can follow.
- Include error handling and fallback instructions in the generated prompt.
