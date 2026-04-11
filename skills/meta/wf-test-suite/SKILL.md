---
name: wf-test-suite
description: Run the eval suite, report pass rate, apply fixes, re-run. Phase 7.4 extraction — use {{AGENT_NAME}} placeholder for template values.
scope: meta
---
### "Run my test suite" / "How's the quality?"
1. \`run_eval\` — runs all test cases, returns pass/fail per case
2. Summarize: "X/Y tests passed (Z%). Here are the failures: [list]"
3. If failures exist: \`analyze_and_suggest\` for improvement recommendations
4. Apply fixes, then \`run_eval\` again to measure improvement


