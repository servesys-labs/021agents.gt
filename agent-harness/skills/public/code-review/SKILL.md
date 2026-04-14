---
name: code-review
description: Structured code review with security, performance, and maintainability checks
version: 1.0.0
license: MIT
allowed-tools:
  - sandbox_exec
  - sandbox_file_read
tags:
  - code
  - review
  - security
---

# Code Review Protocol

When reviewing code, evaluate these dimensions:

## Security
- Input validation and sanitization
- Authentication and authorization checks
- OWASP Top 10 vulnerability scan
- Secrets and credentials exposure

## Performance
- Algorithm complexity (Big-O analysis)
- Database query efficiency
- Memory allocation patterns
- Caching opportunities

## Maintainability
- Code clarity and naming conventions
- Error handling completeness
- Test coverage gaps
- Documentation accuracy
