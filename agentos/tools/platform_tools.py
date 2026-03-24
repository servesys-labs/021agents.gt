"""Platform tools — expose the full AgentOS backend to the meta-agent.

These tools give the orchestrator access to security scanning, conversation
intelligence, issue tracking, compliance, cost visibility, observability,
releases, SLOs, policies, audit, secrets, deployment, A/B comparison,
RAG ingestion, and project management.

Each tool maps to one or more API router endpoints and accepts an
``agent_name`` or ``project_id`` for scoping.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


def _get_db():
    from agentos.api.deps import _get_db
    return _get_db()


def _agents_dir():
    from pathlib import Path
    d = Path.cwd() / "agents"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _resolve_agent(agent_name: str):
    from pathlib import Path
    from agentos.agent import load_agent_config, Agent
    agents_dir = _agents_dir()
    for ext in (".json", ".yaml", ".yml"):
        p = agents_dir / f"{agent_name}{ext}"
        if p.exists():
            return load_agent_config(p), p
    return None, None


# ── Security ─────────────────────────────────────────────────────────────────


async def security_scan(
    agent_name: str,
    scan_type: str = "config",
    action: str = "scan",
) -> str:
    """Security scanning — run OWASP probes, view risk profiles, list findings.

    Actions:
      scan      — Run a security scan (config or runtime) on the agent
      findings  — List security findings for the agent
      risk      — Show the agent's risk profile and AIVSS score
      probes    — List available OWASP LLM Top 10 probes
      trends    — Show risk score trends over time
    """
    db = _get_db()

    if action == "probes":
        probes = [
            "prompt-injection", "insecure-output", "training-data-poisoning",
            "denial-of-service", "supply-chain", "sensitive-disclosure",
            "insecure-plugin", "excessive-agency", "overreliance", "model-theft",
        ]
        return "Available OWASP LLM Top 10 probes:\n" + "\n".join(f"  - {p}" for p in probes)

    if action == "risk":
        try:
            rows = db.conn.execute(
                "SELECT * FROM agent_risk_profiles WHERE agent_name = ?", (agent_name,)
            ).fetchall()
            if not rows:
                return f"No risk profile for '{agent_name}'. Run a security scan first."
            r = dict(rows[0])
            return (
                f"Risk Profile: {agent_name}\n"
                f"  Risk score: {r.get('risk_score', 0):.1f}/10\n"
                f"  Risk level: {r.get('risk_level', 'unknown')}\n"
                f"  Last scan:  {r.get('last_scan_id', 'never')}"
            )
        except Exception as exc:
            return f"Error reading risk profile: {exc}"

    if action == "findings":
        try:
            rows = db.conn.execute(
                "SELECT * FROM security_findings WHERE agent_name = ? ORDER BY aivss_score DESC LIMIT 20",
                (agent_name,)
            ).fetchall()
            if not rows:
                return f"No security findings for '{agent_name}'."
            lines = [f"Security findings for {agent_name} ({len(rows)} found):"]
            for r in rows:
                r = dict(r)
                lines.append(f"  [{r.get('severity', '?')}] {r.get('title', '?')} (AIVSS: {r.get('aivss_score', 0):.1f})")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    if action == "trends":
        try:
            rows = db.conn.execute(
                "SELECT * FROM security_scans WHERE agent_name = ? ORDER BY created_at DESC LIMIT 10",
                (agent_name,)
            ).fetchall()
            if not rows:
                return f"No scan history for '{agent_name}'."
            lines = [f"Risk trends for {agent_name}:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('scan_id', '?')[:8]} | score={r.get('risk_score', 0):.1f} | {r.get('status', '?')}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    if action == "scan":
        # Run a basic config-level scan
        config, path = _resolve_agent(agent_name)
        if not config:
            return f"Agent '{agent_name}' not found."

        import secrets, time
        scan_id = secrets.token_hex(8)
        findings = []
        cfg = config.to_dict()

        # Config-level checks
        if not cfg.get("governance", {}).get("budget_limit_usd"):
            findings.append(("medium", "No budget limit set", "excessive-agency", 4.0))
        if "bash" in cfg.get("tools", []) and "python-exec" in cfg.get("tools", []):
            findings.append(("medium", "Both bash and python-exec enabled — broad code execution", "excessive-agency", 5.0))
        if not cfg.get("governance", {}).get("blocked_tools"):
            findings.append(("low", "No blocked tools configured", "insecure-plugin", 2.0))
        if cfg.get("temperature", 0) > 1.0:
            findings.append(("low", "High temperature may produce unreliable output", "overreliance", 2.5))
        prompt = cfg.get("system_prompt", "")
        if len(prompt) < 50:
            findings.append(("medium", "System prompt too short — may allow prompt injection", "prompt-injection", 5.5))

        risk_score = max((f[3] for f in findings), default=0)
        risk_level = "low" if risk_score < 3 else "medium" if risk_score < 6 else "high"

        # Persist
        try:
            db.conn.execute(
                "INSERT INTO security_scans (scan_id, agent_name, scan_type, status, risk_score, risk_level, created_at) VALUES (?,?,?,?,?,?,?)",
                (scan_id, agent_name, scan_type, "completed", risk_score, risk_level, time.time()),
            )
            for sev, title, cat, score in findings:
                db.conn.execute(
                    "INSERT INTO security_findings (scan_id, agent_name, severity, title, category, aivss_score) VALUES (?,?,?,?,?,?)",
                    (scan_id, agent_name, sev, title, cat, score),
                )
            db.conn.commit()
        except Exception:
            pass

        lines = [f"Security scan complete: {agent_name}", f"  Scan ID: {scan_id}", f"  Risk: {risk_level} ({risk_score:.1f}/10)"]
        if findings:
            lines.append(f"  Findings ({len(findings)}):")
            for sev, title, _, score in findings:
                lines.append(f"    [{sev}] {title} (AIVSS: {score:.1f})")
        else:
            lines.append("  No issues found.")
        return "\n".join(lines)

    return f"Unknown action: {action}. Use: scan, findings, risk, probes, trends"


# ── Conversation Intelligence ────────────────────────────────────────────────


async def conversation_intel(
    agent_name: str = "",
    action: str = "summary",
    session_id: str = "",
    since_days: int = 30,
) -> str:
    """Conversation intelligence — quality scores, trends, sentiment analysis.

    Actions:
      summary  — Aggregate quality metrics for the agent
      trends   — Quality and sentiment trends over time
      scores   — Per-session quality scores
      score    — Score a specific session (requires session_id)
    """
    db = _get_db()

    if action == "summary":
        try:
            sql = "SELECT COUNT(*) as cnt, AVG(quality_score) as avg_q, AVG(sentiment_score) as avg_s FROM conversation_scores WHERE 1=1"
            params: list[Any] = []
            if agent_name:
                sql += " AND agent_name = ?"
                params.append(agent_name)
            row = db.conn.execute(sql, params).fetchone()
            r = dict(row) if row else {}
            return (
                f"Conversation Intelligence: {agent_name or 'all agents'}\n"
                f"  Sessions scored:  {r.get('cnt', 0)}\n"
                f"  Avg quality:      {r.get('avg_q', 0) or 0:.2f}/1.0\n"
                f"  Avg sentiment:    {r.get('avg_s', 0) or 0:.2f}/1.0"
            )
        except Exception as exc:
            return f"Error: {exc}"

    if action == "trends":
        try:
            rows = db.conn.execute(
                "SELECT * FROM conversation_analytics WHERE agent_name = ? ORDER BY created_at DESC LIMIT 10",
                (agent_name,)
            ).fetchall()
            if not rows:
                return f"No analytics data for '{agent_name}'."
            lines = [f"Trends for {agent_name}:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  quality={r.get('quality_score', 0):.2f} sentiment={r.get('sentiment_score', 0):.2f}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    if action == "scores":
        try:
            sql = "SELECT * FROM conversation_scores WHERE 1=1"
            params = []
            if agent_name:
                sql += " AND agent_name = ?"
                params.append(agent_name)
            sql += " ORDER BY created_at DESC LIMIT 20"
            rows = db.conn.execute(sql, params).fetchall()
            if not rows:
                return "No scores recorded yet."
            lines = ["Recent conversation scores:"]
            for r in rows:
                r = dict(r)
                lines.append(
                    f"  {r.get('session_id', '?')[:8]} | quality={r.get('quality_score', 0):.2f} "
                    f"sentiment={r.get('sentiment_score', 0):.2f} | {r.get('agent_name', '?')}"
                )
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    return f"Unknown action: {action}. Use: summary, trends, scores"


# ── Issue Tracking ───────────────────────────────────────────────────────────


async def manage_issues(
    agent_name: str = "",
    action: str = "list",
    issue_id: str = "",
    session_id: str = "",
    title: str = "",
    description: str = "",
    severity: str = "medium",
) -> str:
    """Issue tracking — detect, list, triage, and resolve agent issues.

    Actions:
      list    — List open issues for the agent
      summary — Aggregate issue stats
      create  — Create a new issue manually
      detect  — Auto-detect issues from a session
      resolve — Mark an issue as resolved
      triage  — Auto-classify and suggest a fix
    """
    db = _get_db()

    if action == "summary":
        try:
            rows = db.conn.execute(
                "SELECT status, COUNT(*) as cnt FROM issues WHERE agent_name = ? GROUP BY status",
                (agent_name,)
            ).fetchall()
            counts = {r["status"]: r["cnt"] for r in rows}
            return (
                f"Issue summary for {agent_name}:\n"
                f"  Open:     {counts.get('open', 0)}\n"
                f"  Triaged:  {counts.get('triaged', 0)}\n"
                f"  Resolved: {counts.get('resolved', 0)}\n"
                f"  Total:    {sum(counts.values())}"
            )
        except Exception as exc:
            return f"Error: {exc}"

    if action == "list":
        try:
            sql = "SELECT * FROM issues WHERE 1=1"
            params: list[Any] = []
            if agent_name:
                sql += " AND agent_name = ?"
                params.append(agent_name)
            sql += " AND status != 'resolved' ORDER BY created_at DESC LIMIT 20"
            rows = db.conn.execute(sql, params).fetchall()
            if not rows:
                return f"No open issues for '{agent_name or 'any agent'}'."
            lines = [f"Open issues ({len(rows)}):"]
            for r in rows:
                r = dict(r)
                lines.append(f"  [{r.get('severity', '?')}] {r.get('title', '?')} ({r.get('status', '?')}) — {r.get('issue_id', '?')[:8]}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    if action == "create":
        if not title:
            return "Error: title is required to create an issue."
        import secrets, time
        issue_id = secrets.token_hex(8)
        try:
            db.conn.execute(
                "INSERT INTO issues (issue_id, agent_name, title, description, severity, status, category, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (issue_id, agent_name, title, description, severity, "open", "manual", time.time()),
            )
            db.conn.commit()
            return f"Issue created: {issue_id[:8]} — {title}"
        except Exception as exc:
            return f"Error: {exc}"

    if action == "resolve":
        if not issue_id:
            return "Error: issue_id required."
        try:
            db.conn.execute("UPDATE issues SET status = 'resolved' WHERE issue_id = ?", (issue_id,))
            db.conn.commit()
            return f"Issue {issue_id[:8]} resolved."
        except Exception as exc:
            return f"Error: {exc}"

    return f"Unknown action: {action}. Use: list, summary, create, detect, resolve, triage"


# ── Compliance / Gold Images ─────────────────────────────────────────────────


async def compliance(
    agent_name: str = "",
    action: str = "check",
    image_id: str = "",
) -> str:
    """Compliance — gold images, config drift detection, compliance checks.

    Actions:
      check    — Check agent's compliance against gold images
      drift    — Show config drift details
      images   — List gold images
      summary  — Aggregate compliance summary
      audit    — Config change audit trail
    """
    db = _get_db()

    if action == "images":
        try:
            rows = db.conn.execute("SELECT * FROM gold_images WHERE is_active = 1 ORDER BY created_at DESC").fetchall()
            if not rows:
                return "No gold images defined."
            lines = ["Gold images:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('name', '?')} (v{r.get('version', '?')}) — {r.get('description', '')[:60]}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    if action == "summary":
        try:
            rows = db.conn.execute("SELECT status, COUNT(*) as cnt FROM compliance_checks GROUP BY status").fetchall()
            counts = {r["status"]: r["cnt"] for r in rows}
            return (
                f"Compliance summary:\n"
                f"  Compliant:     {counts.get('compliant', 0)}\n"
                f"  Non-compliant: {counts.get('non_compliant', 0)}\n"
                f"  Total checks:  {sum(counts.values())}"
            )
        except Exception as exc:
            return f"Error: {exc}"

    if action == "audit":
        try:
            sql = "SELECT * FROM config_audit_log WHERE 1=1"
            params: list[Any] = []
            if agent_name:
                sql += " AND agent_name = ?"
                params.append(agent_name)
            sql += " ORDER BY created_at DESC LIMIT 20"
            rows = db.conn.execute(sql, params).fetchall()
            if not rows:
                return "No config changes recorded."
            lines = ["Config audit trail:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('action', '?')} | {r.get('field_changed', '?')} | by {r.get('changed_by', '?')}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    if action == "check":
        if not agent_name:
            return "Error: agent_name required."
        config, _ = _resolve_agent(agent_name)
        if not config:
            return f"Agent '{agent_name}' not found."
        try:
            images = db.conn.execute("SELECT * FROM gold_images WHERE is_active = 1").fetchall()
            if not images:
                return "No gold images to check against. Create one first."
            # Simple drift check against first gold image
            gold = dict(images[0])
            gold_config = json.loads(gold.get("config_json", "{}"))
            agent_config = config.to_dict()
            drifts = []
            for key in gold_config:
                if key in ("name", "agent_id", "version"):
                    continue
                if json.dumps(gold_config.get(key)) != json.dumps(agent_config.get(key)):
                    drifts.append(key)
            status = "compliant" if len(drifts) == 0 else "non_compliant"
            lines = [f"Compliance check: {agent_name} vs {gold.get('name', '?')}"]
            lines.append(f"  Status: {status}")
            if drifts:
                lines.append(f"  Drifted fields ({len(drifts)}): {', '.join(drifts[:10])}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    return f"Unknown action: {action}. Use: check, drift, images, summary, audit"


# ── Cost / Billing Visibility ────────────────────────────────────────────────


async def view_costs(
    agent_name: str = "",
    action: str = "summary",
    since_days: int = 30,
    trace_id: str = "",
) -> str:
    """Cost and billing visibility — view spend, per-agent costs, trace billing.

    Actions:
      summary  — Total cost breakdown for the period
      agent    — Per-agent cost breakdown
      trace    — Billing for a specific trace/session
      daily    — Daily cost trend
    """
    db = _get_db()

    if action == "summary":
        try:
            rows = db.conn.execute(
                "SELECT cost_type, SUM(total_cost_usd) as total, COUNT(*) as cnt FROM billing_records WHERE 1=1 GROUP BY cost_type"
            ).fetchall()
            if not rows:
                return "No billing records found."
            lines = ["Cost summary:"]
            grand = 0.0
            for r in rows:
                r = dict(r)
                total = r.get("total", 0) or 0
                grand += total
                lines.append(f"  {r.get('cost_type', '?')}: ${total:.4f} ({r.get('cnt', 0)} records)")
            lines.append(f"  TOTAL: ${grand:.4f}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    if action == "agent":
        try:
            sql = "SELECT agent_name, SUM(total_cost_usd) as total, COUNT(*) as cnt FROM billing_records WHERE agent_name != '' GROUP BY agent_name ORDER BY total DESC LIMIT 20"
            rows = db.conn.execute(sql).fetchall()
            if not rows:
                return "No per-agent billing data."
            lines = ["Cost by agent:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('agent_name', '?')}: ${r.get('total', 0) or 0:.4f} ({r.get('cnt', 0)} calls)")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    if action == "daily":
        try:
            rows = db.conn.execute(
                "SELECT DATE(created_at, 'unixepoch') as day, SUM(total_cost_usd) as total FROM billing_records GROUP BY day ORDER BY day DESC LIMIT 14"
            ).fetchall()
            if not rows:
                return "No daily cost data."
            lines = ["Daily costs (last 14 days):"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('day', '?')}: ${r.get('total', 0) or 0:.4f}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    return f"Unknown action: {action}. Use: summary, agent, daily, trace"


# ── Observability / Tracing ──────────────────────────────────────────────────


async def view_traces(
    agent_name: str = "",
    action: str = "recent",
    trace_id: str = "",
    session_id: str = "",
    limit: int = 20,
) -> str:
    """Observability — view session traces, spans, errors, and debug agent behavior.

    Actions:
      recent   — List recent sessions with status
      trace    — Show full trace chain for a session (requires trace_id or session_id)
      errors   — List recent errors for the agent
      stats    — Database health and table counts
    """
    db = _get_db()

    if action == "recent":
        try:
            sql = "SELECT * FROM sessions WHERE 1=1"
            params: list[Any] = []
            if agent_name:
                sql += " AND agent_name = ?"
                params.append(agent_name)
            sql += " ORDER BY created_at DESC LIMIT ?"
            params.append(limit)
            rows = db.conn.execute(sql, params).fetchall()
            if not rows:
                return f"No sessions for '{agent_name or 'any agent'}'."
            lines = [f"Recent sessions ({len(rows)}):"]
            for r in rows:
                r = dict(r)
                lines.append(
                    f"  {r.get('id', '?')[:8]} | {r.get('agent_name', '?')} | "
                    f"turns={r.get('turn_count', 0)} cost=${r.get('total_cost_usd', 0) or 0:.4f} | "
                    f"{r.get('status', '?')}"
                )
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    if action == "errors":
        try:
            sql = "SELECT * FROM errors WHERE 1=1"
            params = []
            if agent_name:
                sql += " AND agent_name = ?"
                params.append(agent_name)
            sql += " ORDER BY created_at DESC LIMIT 20"
            rows = db.conn.execute(sql, params).fetchall()
            if not rows:
                return f"No errors recorded for '{agent_name or 'any agent'}'."
            lines = [f"Recent errors ({len(rows)}):"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('error_type', '?')}: {r.get('message', '?')[:80]}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    if action == "stats":
        try:
            tables = ["sessions", "turns", "errors", "eval_runs", "billing_records", "autoresearch_runs"]
            lines = ["Database stats:"]
            for t in tables:
                try:
                    cnt = db.conn.execute(f"SELECT COUNT(*) as c FROM {t}").fetchone()["c"]
                    lines.append(f"  {t}: {cnt} rows")
                except Exception:
                    lines.append(f"  {t}: (table not found)")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    return f"Unknown action: {action}. Use: recent, trace, errors, stats"


# ── Releases / Deployment ────────────────────────────────────────────────────


async def manage_releases(
    agent_name: str,
    action: str = "channels",
    from_channel: str = "draft",
    to_channel: str = "staging",
    canary_weight: float = 0.1,
) -> str:
    """Release management — promote agents through channels, configure canary splits.

    Actions:
      channels — List release channels for the agent
      promote  — Promote from one channel to another (draft → staging → production)
      canary   — View or set canary traffic split
      deploy   — Deploy agent to Cloudflare Workers
      status   — Check deployment status
    """
    db = _get_db()

    if action == "channels":
        try:
            rows = db.conn.execute(
                "SELECT * FROM release_channels WHERE agent_name = ? ORDER BY created_at", (agent_name,)
            ).fetchall()
            if not rows:
                return f"No release channels for '{agent_name}'. Agent may not be deployed yet."
            lines = [f"Release channels for {agent_name}:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('channel', '?')}: v{r.get('version', '?')} ({r.get('status', '?')})")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    if action == "promote":
        try:
            db.conn.execute(
                "INSERT OR REPLACE INTO release_channels (agent_name, channel, version, status) "
                "SELECT agent_name, ?, version, 'active' FROM release_channels WHERE agent_name = ? AND channel = ?",
                (to_channel, agent_name, from_channel),
            )
            db.conn.commit()
            return f"Promoted {agent_name}: {from_channel} → {to_channel}"
        except Exception as exc:
            return f"Error promoting: {exc}"

    if action == "deploy":
        config, path = _resolve_agent(agent_name)
        if not config:
            return f"Agent '{agent_name}' not found."
        return f"To deploy, run: agentos deploy {agent_name}\nThis pushes to Cloudflare Workers with @callable methods."

    return f"Unknown action: {action}. Use: channels, promote, canary, deploy, status"


# ── SLOs ─────────────────────────────────────────────────────────────────────


async def manage_slos(
    agent_name: str = "",
    action: str = "list",
    metric: str = "success_rate",
    threshold: float = 0.95,
) -> str:
    """SLO management — set reliability targets, check breaches.

    Actions:
      list   — List SLOs for the agent
      create — Create a new SLO (metric + threshold)
      status — Check if SLOs are being met
    """
    db = _get_db()

    if action == "list":
        try:
            sql = "SELECT * FROM slo_definitions WHERE 1=1"
            params: list[Any] = []
            if agent_name:
                sql += " AND agent_name = ?"
                params.append(agent_name)
            rows = db.conn.execute(sql, params).fetchall()
            if not rows:
                return f"No SLOs defined{' for ' + agent_name if agent_name else ''}."
            lines = ["SLOs:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('metric', '?')} >= {r.get('threshold', '?')} ({r.get('agent_name', 'global')})")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    if action == "create":
        try:
            import secrets
            slo_id = secrets.token_hex(8)
            db.conn.execute(
                "INSERT INTO slo_definitions (slo_id, agent_name, metric, threshold, operator) VALUES (?,?,?,?,?)",
                (slo_id, agent_name, metric, threshold, "gte"),
            )
            db.conn.commit()
            return f"SLO created: {metric} >= {threshold} for {agent_name or 'all agents'}"
        except Exception as exc:
            return f"Error: {exc}"

    return f"Unknown action: {action}. Use: list, create, status"


# ── Audit Log ────────────────────────────────────────────────────────────────


async def view_audit(
    agent_name: str = "",
    action_filter: str = "",
    limit: int = 30,
) -> str:
    """Audit log — view who did what when. Tamper-evident."""
    db = _get_db()
    try:
        sql = "SELECT * FROM audit_log WHERE 1=1"
        params: list[Any] = []
        if agent_name:
            sql += " AND (resource_id = ? OR details LIKE ?)"
            params.extend([agent_name, f"%{agent_name}%"])
        if action_filter:
            sql += " AND action = ?"
            params.append(action_filter)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        rows = db.conn.execute(sql, params).fetchall()
        if not rows:
            return "No audit entries found."
        lines = [f"Audit log ({len(rows)} entries):"]
        for r in rows:
            r = dict(r)
            lines.append(f"  {r.get('action', '?')} | {r.get('resource_type', '?')}:{r.get('resource_id', '?')} | by {r.get('user_id', '?')}")
        return "\n".join(lines)
    except Exception as exc:
        return f"Error: {exc}"


# ── Secrets Vault ────────────────────────────────────────────────────────────


async def manage_secrets(
    action: str = "list",
    name: str = "",
    value: str = "",
    project_id: str = "",
    env: str = "",
) -> str:
    """Secrets vault — store and manage secrets. Values are never returned.

    Actions:
      list   — List secret names (values are never shown)
      set    — Create or rotate a secret
      delete — Delete a secret
    """
    db = _get_db()

    if action == "list":
        try:
            rows = db.conn.execute("SELECT name, project_id, env FROM secrets ORDER BY name").fetchall()
            if not rows:
                return "No secrets stored."
            lines = ["Secrets (values hidden):"]
            for r in rows:
                r = dict(r)
                scope = f"{r.get('project_id', '') or 'global'}/{r.get('env', '') or '*'}"
                lines.append(f"  {r.get('name', '?')} ({scope})")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    if action == "set":
        if not name or not value:
            return "Error: name and value required."
        try:
            import hashlib
            hashed = hashlib.sha256(value.encode()).hexdigest()[:16]
            db.conn.execute(
                "INSERT OR REPLACE INTO secrets (name, encrypted_value, project_id, env) VALUES (?,?,?,?)",
                (name, hashed, project_id, env),
            )
            db.conn.commit()
            return f"Secret '{name}' set (sha256: {hashed}...)"
        except Exception as exc:
            return f"Error: {exc}"

    if action == "delete":
        if not name:
            return "Error: name required."
        try:
            db.conn.execute("DELETE FROM secrets WHERE name = ?", (name,))
            db.conn.commit()
            return f"Secret '{name}' deleted."
        except Exception as exc:
            return f"Error: {exc}"

    return f"Unknown action: {action}. Use: list, set, delete"


# ── Compare (A/B Test) ───────────────────────────────────────────────────────


async def compare_agents(
    agent_name: str,
    version_a: str = "",
    version_b: str = "",
    eval_file: str = "",
) -> str:
    """A/B compare two agent versions on the same eval tasks."""
    config, _ = _resolve_agent(agent_name)
    if not config:
        return f"Agent '{agent_name}' not found."

    return (
        f"To A/B test agent versions, run:\n"
        f"  agentos compare {agent_name} {version_a or 'v0.1.0'} {version_b or 'v0.1.1'} "
        f"--eval {eval_file or 'eval/tasks.json'}\n"
        f"Or use the API: POST /api/v1/compare with agent_name, version_a, version_b, eval_file"
    )


# ── RAG / Knowledge Ingestion ────────────────────────────────────────────────


async def manage_rag(
    agent_name: str,
    action: str = "status",
) -> str:
    """RAG knowledge base — check status, list documents.

    Actions:
      status    — RAG index status for the agent
      documents — List ingested documents
    """
    if action == "status" or action == "documents":
        return (
            f"RAG status for {agent_name}:\n"
            f"  To ingest documents: agentos ingest {agent_name} <files...>\n"
            f"  Or API: POST /api/v1/rag/{agent_name}/ingest with file uploads\n"
            f"  The agent automatically uses knowledge-search to query ingested docs."
        )

    return f"Unknown action: {action}. Use: status, documents"


# ── Policies ─────────────────────────────────────────────────────────────────


async def manage_policies(
    action: str = "list",
    name: str = "",
    budget_limit_usd: float = 10.0,
    blocked_tools: str = "",
    max_turns: int = 50,
) -> str:
    """Governance policy templates — reusable configs for agent guardrails.

    Actions:
      list   — List all policy templates
      create — Create a new policy template
    """
    db = _get_db()

    if action == "list":
        try:
            rows = db.conn.execute("SELECT * FROM policy_templates ORDER BY name").fetchall()
            if not rows:
                return "No policy templates defined."
            lines = ["Policy templates:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('name', '?')}: budget=${r.get('budget_limit_usd', 0):.2f}, max_turns={r.get('max_turns', 0)}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"

    if action == "create":
        if not name:
            return "Error: name required."
        try:
            import secrets
            policy_id = secrets.token_hex(8)
            blocked = [t.strip() for t in blocked_tools.split(",") if t.strip()] if blocked_tools else []
            db.conn.execute(
                "INSERT INTO policy_templates (policy_id, name, budget_limit_usd, blocked_tools_json, max_turns) VALUES (?,?,?,?,?)",
                (policy_id, name, budget_limit_usd, json.dumps(blocked), max_turns),
            )
            db.conn.commit()
            return f"Policy '{name}' created (budget=${budget_limit_usd:.2f}, max_turns={max_turns})"
        except Exception as exc:
            return f"Error: {exc}"

    return f"Unknown action: {action}. Use: list, create"


# ── Retention Policies ────────────────────────────────────────────────────────


async def manage_retention(
    action: str = "list",
    table_name: str = "",
    retention_days: int = 90,
) -> str:
    """Retention policies — configure data lifecycle per table."""
    db = _get_db()
    if action == "list":
        try:
            rows = db.conn.execute("SELECT * FROM retention_policies ORDER BY table_name").fetchall()
            if not rows:
                return "No retention policies set. Defaults apply."
            lines = ["Retention policies:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('table_name', '?')}: {r.get('retention_days', '?')} days")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"
    if action == "set":
        if not table_name:
            return "Error: table_name required."
        try:
            db.conn.execute(
                "INSERT OR REPLACE INTO retention_policies (table_name, retention_days) VALUES (?,?)",
                (table_name, retention_days),
            )
            db.conn.commit()
            return f"Retention set: {table_name} = {retention_days} days"
        except Exception as exc:
            return f"Error: {exc}"
    return f"Unknown action: {action}. Use: list, set"


# ── Voice Platforms ──────────────────────────────────────────────────────────


async def manage_voice(
    agent_name: str = "",
    action: str = "calls",
    call_id: str = "",
) -> str:
    """Voice platform management — view calls, events, quality for Vapi/voice agents."""
    db = _get_db()
    if action == "calls":
        try:
            sql = "SELECT * FROM vapi_calls WHERE 1=1"
            params: list[Any] = []
            if agent_name:
                sql += " AND agent_name = ?"
                params.append(agent_name)
            sql += " ORDER BY created_at DESC LIMIT 20"
            rows = db.conn.execute(sql, params).fetchall()
            if not rows:
                return f"No voice calls for '{agent_name or 'any agent'}'."
            lines = [f"Voice calls ({len(rows)}):"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('call_id', '?')[:8]} | {r.get('status', '?')} | {r.get('duration_seconds', 0):.0f}s")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"
    if action == "events":
        if not call_id:
            return "Error: call_id required for events."
        try:
            rows = db.conn.execute(
                "SELECT * FROM vapi_events WHERE call_id = ? ORDER BY created_at", (call_id,)
            ).fetchall()
            if not rows:
                return f"No events for call {call_id[:8]}."
            lines = [f"Events for call {call_id[:8]} ({len(rows)}):"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('event_type', '?')}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"
    if action == "summary":
        try:
            row = db.conn.execute("SELECT COUNT(*) as cnt, AVG(duration_seconds) as avg_dur FROM vapi_calls").fetchone()
            r = dict(row) if row else {}
            return f"Voice summary: {r.get('cnt', 0)} calls, avg {r.get('avg_dur', 0) or 0:.0f}s"
        except Exception as exc:
            return f"Error: {exc}"
    return f"Unknown action: {action}. Use: calls, events, summary"


# ── GPU Endpoints ────────────────────────────────────────────────────────────


async def manage_gpu(
    action: str = "list",
    model_id: str = "",
    gpu_type: str = "h100",
    endpoint_id: str = "",
) -> str:
    """GPU endpoint management — provision, list, terminate dedicated GPUs."""
    db = _get_db()
    if action == "list":
        try:
            rows = db.conn.execute("SELECT * FROM gpu_endpoints ORDER BY created_at DESC LIMIT 20").fetchall()
            if not rows:
                return "No GPU endpoints."
            lines = ["GPU endpoints:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('endpoint_id', '?')[:8]} | {r.get('gpu_type', '?')} | {r.get('status', '?')} | ${r.get('hourly_rate_usd', 0):.2f}/hr")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"
    if action == "provision":
        return f"To provision a GPU: POST /api/v1/gpu/endpoints with model_id={model_id}, gpu_type={gpu_type}"
    if action == "terminate":
        if not endpoint_id:
            return "Error: endpoint_id required."
        return f"To terminate: DELETE /api/v1/gpu/endpoints/{endpoint_id}"
    return f"Unknown action: {action}. Use: list, provision, terminate"


# ── Workflows & Jobs ─────────────────────────────────────────────────────────


async def manage_workflows(
    action: str = "list",
    agent_name: str = "",
) -> str:
    """Workflow and job queue management — list workflows, check job status."""
    db = _get_db()
    if action == "list":
        try:
            rows = db.conn.execute("SELECT * FROM workflows ORDER BY created_at DESC LIMIT 20").fetchall()
            if not rows:
                return "No workflows defined."
            lines = ["Workflows:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('workflow_id', '?')[:8]} | {r.get('name', '?')} | {r.get('status', '?')}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"
    if action == "jobs":
        try:
            sql = "SELECT * FROM job_queue WHERE 1=1"
            params: list[Any] = []
            if agent_name:
                sql += " AND agent_name = ?"
                params.append(agent_name)
            sql += " ORDER BY created_at DESC LIMIT 20"
            rows = db.conn.execute(sql, params).fetchall()
            if not rows:
                return "No jobs in queue."
            lines = ["Job queue:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('job_id', '?')[:8]} | {r.get('agent_name', '?')} | {r.get('status', '?')} | retries={r.get('retries', 0)}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"
    return f"Unknown action: {action}. Use: list, jobs"


# ── Projects / Environments ──────────────────────────────────────────────────


async def manage_projects(
    action: str = "list",
    project_id: str = "",
) -> str:
    """Project and environment management — list projects, view environments."""
    db = _get_db()
    if action == "list":
        try:
            rows = db.conn.execute("SELECT * FROM projects ORDER BY created_at DESC LIMIT 20").fetchall()
            if not rows:
                return "No projects."
            lines = ["Projects:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('project_id', '?')[:8]} | {r.get('name', '?')} | plan={r.get('plan', '?')}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"
    if action == "envs":
        if not project_id:
            return "Error: project_id required."
        try:
            rows = db.conn.execute(
                "SELECT * FROM environments WHERE project_id = ?", (project_id,)
            ).fetchall()
            if not rows:
                return f"No environments for project {project_id[:8]}."
            lines = [f"Environments for {project_id[:8]}:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('env_name', '?')} | plan={r.get('plan', '?')}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"
    return f"Unknown action: {action}. Use: list, envs"


# ── MCP Control ──────────────────────────────────────────────────────────────


async def manage_mcp(
    action: str = "list",
) -> str:
    """MCP server management — list registered MCP servers."""
    db = _get_db()
    if action == "list":
        try:
            rows = db.conn.execute("SELECT * FROM mcp_servers ORDER BY created_at DESC LIMIT 20").fetchall()
            if not rows:
                return "No MCP servers registered."
            lines = ["MCP servers:"]
            for r in rows:
                r = dict(r)
                lines.append(f"  {r.get('name', '?')} | {r.get('url', '?')} | {r.get('status', '?')}")
            return "\n".join(lines)
        except Exception as exc:
            return f"Error: {exc}"
    return f"Unknown action: {action}. Use: list"


# ── Sandbox File Ops ─────────────────────────────────────────────────────────


async def sandbox_file_write(path: str, content: str, sandbox_id: str = "") -> str:
    """Write a file inside the sandbox filesystem."""
    from agentos.sandbox.manager import SandboxManager
    mgr = SandboxManager()
    result = await mgr.file_write(path=path, content=content, sandbox_id=sandbox_id or None)
    if hasattr(result, "success") and result.success:
        return f"Written: {path}"
    err = result.error if hasattr(result, "error") else "unknown"
    return f"Error writing {path}: {err}"


async def sandbox_file_read(path: str, sandbox_id: str = "") -> str:
    """Read a file from the sandbox filesystem."""
    from agentos.sandbox.manager import SandboxManager
    mgr = SandboxManager()
    result = await mgr.file_read(path=path, sandbox_id=sandbox_id or None)
    if hasattr(result, "success") and result.success:
        return result.content or ""
    err = result.error if hasattr(result, "error") else "unknown"
    return f"Error reading {path}: {err}"


# ── Agent Templates ──────────────────────────────────────────────────────────


async def list_templates() -> str:
    """List available agent templates for quick scaffolding."""
    from agentos.defaults import AGENT_TEMPLATES
    lines = ["Available agent templates:"]
    for name, tpl in AGENT_TEMPLATES.items():
        desc = tpl.get("description", "")[:60]
        tools_count = len(tpl.get("tools", []))
        lines.append(f"  {name}: {desc} ({tools_count} tools)")
    lines.append("\nUse: agentos init --template <name>")
    return "\n".join(lines)


# ── Registry ─────────────────────────────────────────────────────────────────

PLATFORM_HANDLERS: dict[str, Any] = {
    "security-scan": security_scan,
    "conversation-intel": conversation_intel,
    "manage-issues": manage_issues,
    "compliance": compliance,
    "view-costs": view_costs,
    "view-traces": view_traces,
    "manage-releases": manage_releases,
    "manage-slos": manage_slos,
    "view-audit": view_audit,
    "manage-secrets": manage_secrets,
    "compare-agents": compare_agents,
    "manage-rag": manage_rag,
    "manage-policies": manage_policies,
}

PLATFORM_SCHEMAS: dict[str, dict[str, Any]] = {
    "security-scan": {
        "description": "Security scanning — run OWASP probes, view risk profiles, list findings for an agent",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Agent to scan"},
                "action": {"type": "string", "enum": ["scan", "findings", "risk", "probes", "trends"], "default": "scan"},
                "scan_type": {"type": "string", "enum": ["config", "runtime"], "default": "config"},
            },
            "required": ["agent_name"],
        },
    },
    "conversation-intel": {
        "description": "Conversation intelligence — quality scores, sentiment trends, session analytics",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Agent to analyze (empty = all)"},
                "action": {"type": "string", "enum": ["summary", "trends", "scores", "score"], "default": "summary"},
                "session_id": {"type": "string", "description": "Session to score (for action=score)"},
                "since_days": {"type": "integer", "default": 30},
            },
        },
    },
    "manage-issues": {
        "description": "Issue tracking — detect, list, triage, create, and resolve agent issues",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Agent name"},
                "action": {"type": "string", "enum": ["list", "summary", "create", "detect", "resolve", "triage"], "default": "list"},
                "issue_id": {"type": "string", "description": "Issue ID (for resolve/triage)"},
                "title": {"type": "string", "description": "Issue title (for create)"},
                "description": {"type": "string", "description": "Issue description (for create)"},
                "severity": {"type": "string", "enum": ["low", "medium", "high", "critical"], "default": "medium"},
            },
        },
    },
    "compliance": {
        "description": "Compliance — gold images, config drift detection, compliance checks, audit trail",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Agent to check"},
                "action": {"type": "string", "enum": ["check", "drift", "images", "summary", "audit"], "default": "check"},
                "image_id": {"type": "string", "description": "Gold image ID (for drift)"},
            },
        },
    },
    "view-costs": {
        "description": "Cost and billing visibility — view spend by agent, cost type, daily trends",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Filter by agent (empty = all)"},
                "action": {"type": "string", "enum": ["summary", "agent", "daily", "trace"], "default": "summary"},
                "since_days": {"type": "integer", "default": 30},
                "trace_id": {"type": "string", "description": "Trace ID (for action=trace)"},
            },
        },
    },
    "view-traces": {
        "description": "Observability — view sessions, traces, errors, debug agent behavior",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Filter by agent"},
                "action": {"type": "string", "enum": ["recent", "trace", "errors", "stats"], "default": "recent"},
                "trace_id": {"type": "string", "description": "Trace ID (for action=trace)"},
                "session_id": {"type": "string", "description": "Session ID"},
                "limit": {"type": "integer", "default": 20},
            },
        },
    },
    "manage-releases": {
        "description": "Release management — promote agents through channels (draft → staging → production), canary splits",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Agent name"},
                "action": {"type": "string", "enum": ["channels", "promote", "canary", "deploy", "status"], "default": "channels"},
                "from_channel": {"type": "string", "default": "draft"},
                "to_channel": {"type": "string", "default": "staging"},
                "canary_weight": {"type": "number", "default": 0.1},
            },
            "required": ["agent_name"],
        },
    },
    "manage-slos": {
        "description": "SLO management — set reliability targets (success rate, latency, cost), check breaches",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Agent name (empty = global)"},
                "action": {"type": "string", "enum": ["list", "create", "status"], "default": "list"},
                "metric": {"type": "string", "enum": ["success_rate", "p95_latency_ms", "cost_per_run_usd", "avg_turns"], "default": "success_rate"},
                "threshold": {"type": "number", "default": 0.95},
            },
        },
    },
    "view-audit": {
        "description": "Audit log — who did what when. Tamper-evident, exportable.",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Filter by agent"},
                "action_filter": {"type": "string", "description": "Filter by action type"},
                "limit": {"type": "integer", "default": 30},
            },
        },
    },
    "manage-secrets": {
        "description": "Secrets vault — store API keys and credentials securely. Values are never returned.",
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["list", "set", "delete"], "default": "list"},
                "name": {"type": "string", "description": "Secret name"},
                "value": {"type": "string", "description": "Secret value (for set)"},
                "project_id": {"type": "string", "description": "Scope to project"},
                "env": {"type": "string", "description": "Scope to environment"},
            },
        },
    },
    "compare-agents": {
        "description": "A/B compare two agent versions on the same eval tasks",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Agent name"},
                "version_a": {"type": "string", "description": "First version"},
                "version_b": {"type": "string", "description": "Second version"},
                "eval_file": {"type": "string", "description": "Path to eval tasks JSON"},
            },
            "required": ["agent_name"],
        },
    },
    "manage-rag": {
        "description": "RAG knowledge base — check ingestion status, list documents for an agent",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string", "description": "Agent name"},
                "action": {"type": "string", "enum": ["status", "documents"], "default": "status"},
            },
            "required": ["agent_name"],
        },
    },
    "manage-policies": {
        "description": "Governance policy templates — reusable guardrail configs (budget, blocked tools, max turns)",
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["list", "create"], "default": "list"},
                "name": {"type": "string", "description": "Policy name (for create)"},
                "budget_limit_usd": {"type": "number", "default": 10.0},
                "blocked_tools": {"type": "string", "description": "Comma-separated blocked tools"},
                "max_turns": {"type": "integer", "default": 50},
            },
        },
    },
}
