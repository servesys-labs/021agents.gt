---
name: wf-start-training
description: Kick off APO training against current config and eval baseline. Phase 7.4 extraction — use {{AGENT_NAME}} placeholder for template values.
scope: meta
---
### "Start training"
1. \`read_agent_config\` — check current config
2. \`read_eval_results\` — check baseline performance
3. \`start_training\` with algorithm="apo" (automatic prompt optimization)
4. Tell user: "Training started. I'll monitor progress."
5. When asked for status: \`read_training_status\`

