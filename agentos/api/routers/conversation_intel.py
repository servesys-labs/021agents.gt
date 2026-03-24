"""Conversation Intelligence router — scoring, analytics, trends."""

from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db
from agentos.api.schemas import (
    ConversationScoreResponse,
    ConversationAnalyticsResponse,
    ConversationIntelSummaryResponse,
)

router = APIRouter(prefix="/intelligence", tags=["conversation-intelligence"])


@router.get("/summary", response_model=ConversationIntelSummaryResponse)
async def intel_summary(
    agent_name: str = "",
    since_days: int = 30,
    user: CurrentUser = Depends(get_current_user),
):
    """Get aggregate conversation intelligence summary."""
    since_days = max(1, min(365, since_days))
    since = time.time() - (since_days * 86400)
    db = _get_db()
    summary = db.conversation_intel_summary(
        org_id=user.org_id,
        agent_name=agent_name,
        since=since,
    )
    return ConversationIntelSummaryResponse(**summary)


@router.get("/scores", response_model=list[ConversationScoreResponse])
async def list_scores(
    session_id: str = "",
    agent_name: str = "",
    sentiment: str = "",
    limit: int = 100,
    user: CurrentUser = Depends(get_current_user),
):
    """List per-turn conversation scores with optional filters."""
    limit = max(1, min(200, limit))
    db = _get_db()
    rows = db.query_conversation_scores(
        session_id=session_id or None,
        org_id=user.org_id,
        agent_name=agent_name,
        sentiment=sentiment,
        limit=limit,
    )
    return [ConversationScoreResponse(**r) for r in rows]


@router.get("/analytics", response_model=list[ConversationAnalyticsResponse])
async def list_analytics(
    agent_name: str = "",
    since_days: int = 30,
    limit: int = 50,
    user: CurrentUser = Depends(get_current_user),
):
    """List session-level conversation analytics."""
    since_days = max(1, min(365, since_days))
    limit = max(1, min(200, limit))
    since = time.time() - (since_days * 86400)
    db = _get_db()
    rows = db.query_conversation_analytics(
        org_id=user.org_id,
        agent_name=agent_name,
        since=since,
        limit=limit,
    )
    return [ConversationAnalyticsResponse(**r) for r in rows]


@router.post("/score/{session_id}")
async def score_session(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Score (or re-score) all turns in a session for sentiment and quality."""
    db = _get_db()

    # Verify session exists
    session_row = db.conn.execute(
        "SELECT session_id, agent_name, input_text FROM sessions WHERE session_id = ?",
        (session_id,),
    ).fetchone()
    if not session_row:
        raise HTTPException(status_code=404, detail="Session not found")

    agent_name = session_row["agent_name"] or ""
    input_text = session_row["input_text"] or ""

    # Load turns
    turn_rows = db.conn.execute(
        "SELECT * FROM turns WHERE session_id = ? ORDER BY turn_number",
        (session_id,),
    ).fetchall()
    turns = [dict(r) for r in turn_rows]

    if not turns:
        return {"session_id": session_id, "scored": False, "message": "No turns to score"}

    # Run scoring
    from agentos.observability.analytics import ConversationAnalytics

    analytics = ConversationAnalytics()
    result = analytics.score_session(
        session_id=session_id,
        turns=turns,
        input_text=input_text,
        org_id=user.org_id,
        agent_name=agent_name,
        db=db,
    )

    return {
        "session_id": session_id,
        "scored": True,
        "total_turns": result["total_turns"],
        "avg_quality": result["avg_quality"],
        "avg_sentiment_score": result["avg_sentiment_score"],
        "dominant_sentiment": result["dominant_sentiment"],
        "topics": result["topics"],
    }


@router.get("/trends")
async def quality_trends(
    agent_name: str = "",
    since_days: int = 30,
    user: CurrentUser = Depends(get_current_user),
):
    """Get quality and sentiment trends over time."""
    since_days = max(1, min(365, since_days))
    since = time.time() - (since_days * 86400)
    db = _get_db()

    where_parts = ["created_at >= ?"]
    params: list[Any] = [since]
    if user.org_id:
        where_parts.append("org_id = ?")
        params.append(user.org_id)
    if agent_name:
        where_parts.append("agent_name = ?")
        params.append(agent_name)
    where = " AND ".join(where_parts)

    # Daily quality + sentiment averages
    daily = db.conn.execute(
        f"""SELECT
            DATE(created_at, 'unixepoch') as day,
            AVG(quality_overall) as avg_quality,
            AVG(sentiment_score) as avg_sentiment,
            COUNT(*) as turn_count,
            SUM(has_tool_failure) as tool_failures
        FROM conversation_scores WHERE {where}
        GROUP BY day ORDER BY day""",
        params,
    ).fetchall()

    # Sentiment distribution over time
    sentiment_dist = db.conn.execute(
        f"""SELECT
            sentiment, COUNT(*) as cnt
        FROM conversation_scores WHERE {where}
        GROUP BY sentiment""",
        params,
    ).fetchall()

    # Top intents
    intent_dist = db.conn.execute(
        f"""SELECT
            intent, COUNT(*) as cnt
        FROM conversation_scores WHERE {where}
        GROUP BY intent ORDER BY cnt DESC LIMIT 10""",
        params,
    ).fetchall()

    # Top topics
    topic_dist = db.conn.execute(
        f"""SELECT
            topic, COUNT(*) as cnt
        FROM conversation_scores WHERE {where} AND topic != ''
        GROUP BY topic ORDER BY cnt DESC LIMIT 10""",
        params,
    ).fetchall()

    return {
        "daily": [dict(r) for r in daily],
        "sentiment_distribution": {r["sentiment"]: r["cnt"] for r in sentiment_dist},
        "intent_distribution": {r["intent"]: r["cnt"] for r in intent_dist},
        "topic_distribution": {r["topic"]: r["cnt"] for r in topic_dist},
    }
