"""AgentOS Auth — user authentication for both CLI and web.

Authentication flows:
  CLI:  OAuth device flow (GitHub/Google) → JWT stored in ~/.agentos/credentials.json
  Web:  OAuth redirect flow or email/password → JWT in httpOnly cookie or Authorization header
  CF:   Same JWT verification, keys from env.AUTH_JWT_SECRET

JWT tokens:
  - Issued by AgentOS auth endpoints (local or CF)
  - Contain: sub (user_id), email, name, provider, iat, exp
  - Default expiry: 7 days
  - Verified via HMAC-SHA256 (symmetric) — simple and fast
"""
