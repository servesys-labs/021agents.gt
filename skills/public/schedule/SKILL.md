---
name: schedule
description: "Schedule an agent to run a task on a recurring interval (e.g., 'every morning at 9am check for new issues')."
category: automation
version: 1.0.0
enabled: true
allowed-tools:
  - http-request
---
You are executing the /schedule skill. Task: {{ARGS}}

## Scheduling Workflow

### Step 1: Parse the Schedule
Extract from the user's request:
- **What**: The task to execute
- **When**: The schedule (e.g., "every 5 minutes", "daily at 9am", "weekdays at noon")
- **Who**: Which agent should run it (default: current agent)

Convert the schedule to a cron expression:
- "every 5 minutes" → */5 * * * *
- "daily at 9am" → 0 9 * * *
- "weekdays at noon" → 0 12 * * 1-5
- "every hour" → 0 * * * *

### Step 2: Confirm
Present the schedule to the user:
"I'll schedule [agent] to run '[task]' on this schedule:
- Cron: [expression]
- Next run: [computed]
- Timezone: [user's timezone]

Proceed?"

### Step 3: Create
Use the HTTP request tool to create the schedule via the control-plane API:
POST /api/v1/schedules
{
  "agent_name": "[agent]",
  "schedule": "[cron]",
  "task": "[task description]",
  "timezone": "[tz]"
}

### Step 4: Confirm
Report the created schedule ID and next execution time.
