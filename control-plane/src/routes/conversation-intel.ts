/**
 * Conversation intelligence routes -- scoring, analytics, trends.
 * Ported from agentos/api/routers/conversation_intel.py.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { CurrentUser } from "../auth/types";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDbForOrg } from "../db/client";
import { scoreSession } from "../logic/conversation-analytics";
import { requireScope } from "../middleware/auth";

export const conversationIntelRoutes = createOpenAPIRouter();

// ── GET /summary ─────────────────────────────────────────────────

const summaryRoute = createRoute({
  method: "get",
  path: "/summary",
  tags: ["ConversationIntel"],
  summary: "Get conversation intelligence summary",
  middleware: [requireScope("intelligence:read")],
  request: {
    query: z.object({
      agent_name: z.string().default(""),
      since_days: z.coerce.number().int().min(1).max(365).default(30),
    }),
  },
  responses: {
    200: { description: "Summary", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

conversationIntelRoutes.openapi(summaryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, since_days: sinceDays } = c.req.valid("query");
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName) {
    rows = await sql`
      SELECT
        COUNT(*) as total_scores,
        AVG(quality_overall) as avg_quality,
        AVG(sentiment_score) as avg_sentiment,
        MIN(quality_overall) as min_quality,
        MAX(quality_overall) as max_quality,
        SUM(CASE WHEN has_tool_failure = 1 THEN 1 ELSE 0 END) as tool_failures,
        SUM(CASE WHEN has_hallucination_risk = 1 THEN 1 ELSE 0 END) as hallucination_risks,
        COUNT(DISTINCT session_id) as sessions_scored
      FROM conversation_scores
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND created_at >= ${since}
    `;
  } else {
    rows = await sql`
      SELECT
        COUNT(*) as total_scores,
        AVG(quality_overall) as avg_quality,
        AVG(sentiment_score) as avg_sentiment,
        MIN(quality_overall) as min_quality,
        MAX(quality_overall) as max_quality,
        SUM(CASE WHEN has_tool_failure = 1 THEN 1 ELSE 0 END) as tool_failures,
        SUM(CASE WHEN has_hallucination_risk = 1 THEN 1 ELSE 0 END) as hallucination_risks,
        COUNT(DISTINCT session_id) as sessions_scored
      FROM conversation_scores
      WHERE org_id = ${user.org_id} AND created_at >= ${since}
    `;
  }

  const r = rows[0] ?? {};
  return c.json({
    total_scores: Number(r.total_scores ?? 0),
    avg_quality: Math.round(Number(r.avg_quality ?? 0) * 1000) / 1000,
    avg_sentiment: Math.round(Number(r.avg_sentiment ?? 0) * 1000) / 1000,
    min_quality: Math.round(Number(r.min_quality ?? 0) * 1000) / 1000,
    max_quality: Math.round(Number(r.max_quality ?? 0) * 1000) / 1000,
    tool_failures: Number(r.tool_failures ?? 0),
    hallucination_risks: Number(r.hallucination_risks ?? 0),
    sessions_scored: Number(r.sessions_scored ?? 0),
    since_days: sinceDays,
  });
});

// ── GET /scores ──────────────────────────────────────────────────

const scoresRoute = createRoute({
  method: "get",
  path: "/scores",
  tags: ["ConversationIntel"],
  summary: "List conversation scores",
  middleware: [requireScope("intelligence:read")],
  request: {
    query: z.object({
      session_id: z.string().default(""),
      agent_name: z.string().default(""),
      sentiment: z.string().default(""),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }),
  },
  responses: {
    200: { description: "Scores", content: { "application/json": { schema: z.array(z.record(z.unknown())) } } },
    ...errorResponses(401, 500),
  },
});

conversationIntelRoutes.openapi(scoresRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { session_id: sessionId, agent_name: agentName, sentiment, limit } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (sessionId && sentiment) {
    rows = await sql`
      SELECT * FROM conversation_scores
      WHERE org_id = ${user.org_id} AND session_id = ${sessionId} AND sentiment = ${sentiment}
      ORDER BY turn_number ASC LIMIT ${limit}
    `;
  } else if (sessionId) {
    rows = await sql`
      SELECT * FROM conversation_scores
      WHERE org_id = ${user.org_id} AND session_id = ${sessionId}
      ORDER BY turn_number ASC LIMIT ${limit}
    `;
  } else if (agentName && sentiment) {
    rows = await sql`
      SELECT * FROM conversation_scores
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND sentiment = ${sentiment}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (agentName) {
    rows = await sql`
      SELECT * FROM conversation_scores
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (sentiment) {
    rows = await sql`
      SELECT * FROM conversation_scores
      WHERE org_id = ${user.org_id} AND sentiment = ${sentiment}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM conversation_scores
      WHERE org_id = ${user.org_id}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }

  return c.json(rows);
});

// ── GET /analytics ───────────────────────────────────────────────

const analyticsRoute = createRoute({
  method: "get",
  path: "/analytics",
  tags: ["ConversationIntel"],
  summary: "List conversation analytics",
  middleware: [requireScope("intelligence:read")],
  request: {
    query: z.object({
      agent_name: z.string().default(""),
      since_days: z.coerce.number().int().min(1).max(365).default(30),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: { description: "Analytics", content: { "application/json": { schema: z.array(z.record(z.unknown())) } } },
    ...errorResponses(401, 500),
  },
});

conversationIntelRoutes.openapi(analyticsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, since_days: sinceDays, limit } = c.req.valid("query");
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName) {
    rows = await sql`
      SELECT * FROM conversation_analytics
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM conversation_analytics
      WHERE org_id = ${user.org_id} AND created_at >= ${since}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }

  return c.json(rows);
});

// ── POST /score/:session_id ──────────────────────────────────────

const scoreSessionRoute = createRoute({
  method: "post",
  path: "/score/{session_id}",
  tags: ["ConversationIntel"],
  summary: "Score a session",
  middleware: [requireScope("intelligence:write")],
  request: {
    params: z.object({ session_id: z.string() }),
  },
  responses: {
    200: { description: "Score result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

conversationIntelRoutes.openapi(scoreSessionRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { session_id: sessionId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify session exists
  const sessionRows = await sql`
    SELECT session_id, agent_name, input_text FROM sessions
    WHERE session_id = ${sessionId} LIMIT 1
  `;
  if (!sessionRows.length) {
    return c.json({ error: "Session not found" }, 404);
  }

  const session = sessionRows[0] as Record<string, unknown>;
  const agentName = String(session.agent_name ?? "");
  const inputText = String(session.input_text ?? "");

  // Load turns
  const turns = await sql`
    SELECT * FROM turns WHERE session_id = ${sessionId}
    ORDER BY turn_number ASC
  `;

  if (!turns.length) {
    return c.json({ session_id: sessionId, scored: false, message: "No turns to score" });
  }

  // Run scoring (use Workers AI if available)
  const result = await scoreSession(
    sessionId,
    turns as unknown as Record<string, unknown>[],
    inputText,
    user.org_id,
    agentName,
    c.env.AI,
    c.env.AI_SCORING_MODEL || "@cf/meta/llama-3.1-8b-instruct",
  );

  // Persist per-turn scores
  const now = new Date().toISOString();
  for (const ts of result.turn_scores) {
    try {
      await sql`
        INSERT INTO conversation_scores (
          session_id, turn_number, org_id, agent_name,
          sentiment, sentiment_score, sentiment_confidence,
          relevance_score, coherence_score, helpfulness_score, safety_score,
          quality_overall, topic, intent,
          has_tool_failure, has_hallucination_risk,
          scorer_model, created_at
        ) VALUES (
          ${sessionId}, ${ts.turn_number}, ${user.org_id}, ${agentName},
          ${ts.sentiment.sentiment}, ${ts.sentiment.score}, ${ts.sentiment.confidence},
          ${ts.quality.relevance}, ${ts.quality.coherence},
          ${ts.quality.helpfulness}, ${ts.quality.safety},
          ${ts.quality.overall}, ${ts.quality.topic}, ${ts.quality.intent},
          ${ts.quality.has_tool_failure}, ${ts.quality.has_hallucination_risk},
          ${ts.scorer_model}, ${now}
        )
        ON CONFLICT (session_id, turn_number) DO UPDATE SET
          sentiment = EXCLUDED.sentiment,
          sentiment_score = EXCLUDED.sentiment_score,
          sentiment_confidence = EXCLUDED.sentiment_confidence,
          relevance_score = EXCLUDED.relevance_score,
          coherence_score = EXCLUDED.coherence_score,
          helpfulness_score = EXCLUDED.helpfulness_score,
          safety_score = EXCLUDED.safety_score,
          quality_overall = EXCLUDED.quality_overall,
          topic = EXCLUDED.topic,
          intent = EXCLUDED.intent,
          has_tool_failure = EXCLUDED.has_tool_failure,
          has_hallucination_risk = EXCLUDED.has_hallucination_risk,
          scorer_model = EXCLUDED.scorer_model,
          created_at = EXCLUDED.created_at
      `;
    } catch {
      // Best-effort persistence
    }
  }

  // Persist session analytics
  try {
    await sql`
      INSERT INTO conversation_analytics (
        session_id, org_id, agent_name,
        avg_sentiment_score, dominant_sentiment, sentiment_trend,
        avg_quality, min_quality, max_quality,
        topics, intents, failure_patterns,
        total_turns, tool_failure_count, hallucination_risk_count,
        created_at
      ) VALUES (
        ${sessionId}, ${user.org_id}, ${agentName},
        ${result.avg_sentiment_score}, ${result.dominant_sentiment}, ${result.sentiment_trend},
        ${result.avg_quality}, ${result.min_quality}, ${result.max_quality},
        ${JSON.stringify(result.topics)}, ${JSON.stringify(result.intents)},
        ${JSON.stringify(result.failure_patterns)},
        ${result.total_turns}, ${result.tool_failure_count}, ${result.hallucination_risk_count},
        ${now}
      )
      ON CONFLICT (session_id) DO UPDATE SET
        avg_sentiment_score = EXCLUDED.avg_sentiment_score,
        dominant_sentiment = EXCLUDED.dominant_sentiment,
        sentiment_trend = EXCLUDED.sentiment_trend,
        avg_quality = EXCLUDED.avg_quality,
        min_quality = EXCLUDED.min_quality,
        max_quality = EXCLUDED.max_quality,
        topics = EXCLUDED.topics,
        intents = EXCLUDED.intents,
        failure_patterns = EXCLUDED.failure_patterns,
        total_turns = EXCLUDED.total_turns,
        tool_failure_count = EXCLUDED.tool_failure_count,
        hallucination_risk_count = EXCLUDED.hallucination_risk_count,
        created_at = EXCLUDED.created_at
    `;
  } catch {
    // Best-effort persistence
  }

  return c.json({
    session_id: sessionId,
    scored: true,
    total_turns: result.total_turns,
    avg_quality: result.avg_quality,
    avg_sentiment_score: result.avg_sentiment_score,
    dominant_sentiment: result.dominant_sentiment,
    topics: result.topics,
  });
});

// ── GET /trends ──────────────────────────────────────────────────

const trendsRoute = createRoute({
  method: "get",
  path: "/trends",
  tags: ["ConversationIntel"],
  summary: "Get conversation trends",
  middleware: [requireScope("intelligence:read")],
  request: {
    query: z.object({
      agent_name: z.string().default(""),
      since_days: z.coerce.number().int().min(1).max(365).default(30),
    }),
  },
  responses: {
    200: { description: "Trends", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

conversationIntelRoutes.openapi(trendsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, since_days: sinceDays } = c.req.valid("query");
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Daily quality + sentiment averages
  let dailyRows;
  let sentimentDistRows;
  let intentDistRows;
  let topicDistRows;

  if (agentName) {
    dailyRows = await sql`
      SELECT
        DATE(created_at) as day,
        AVG(quality_overall) as avg_quality,
        AVG(sentiment_score) as avg_sentiment,
        COUNT(*) as turn_count,
        SUM(CASE WHEN has_tool_failure = 1 THEN 1 ELSE 0 END) as tool_failures
      FROM conversation_scores
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND created_at >= ${since}
      GROUP BY day ORDER BY day
    `;
    sentimentDistRows = await sql`
      SELECT sentiment, COUNT(*) as cnt
      FROM conversation_scores
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND created_at >= ${since}
      GROUP BY sentiment
    `;
    intentDistRows = await sql`
      SELECT intent, COUNT(*) as cnt
      FROM conversation_scores
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND created_at >= ${since}
      GROUP BY intent ORDER BY cnt DESC LIMIT 10
    `;
    topicDistRows = await sql`
      SELECT topic, COUNT(*) as cnt
      FROM conversation_scores
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND created_at >= ${since}
        AND topic != ''
      GROUP BY topic ORDER BY cnt DESC LIMIT 10
    `;
  } else {
    dailyRows = await sql`
      SELECT
        DATE(created_at) as day,
        AVG(quality_overall) as avg_quality,
        AVG(sentiment_score) as avg_sentiment,
        COUNT(*) as turn_count,
        SUM(CASE WHEN has_tool_failure = 1 THEN 1 ELSE 0 END) as tool_failures
      FROM conversation_scores
      WHERE org_id = ${user.org_id} AND created_at >= ${since}
      GROUP BY day ORDER BY day
    `;
    sentimentDistRows = await sql`
      SELECT sentiment, COUNT(*) as cnt
      FROM conversation_scores
      WHERE org_id = ${user.org_id} AND created_at >= ${since}
      GROUP BY sentiment
    `;
    intentDistRows = await sql`
      SELECT intent, COUNT(*) as cnt
      FROM conversation_scores
      WHERE org_id = ${user.org_id} AND created_at >= ${since}
      GROUP BY intent ORDER BY cnt DESC LIMIT 10
    `;
    topicDistRows = await sql`
      SELECT topic, COUNT(*) as cnt
      FROM conversation_scores
      WHERE org_id = ${user.org_id} AND created_at >= ${since}
        AND topic != ''
      GROUP BY topic ORDER BY cnt DESC LIMIT 10
    `;
  }

  // Build distributions
  const sentimentDist: Record<string, number> = {};
  for (const r of sentimentDistRows) {
    sentimentDist[String(r.sentiment)] = Number(r.cnt);
  }

  const intentDist: Record<string, number> = {};
  for (const r of intentDistRows) {
    intentDist[String(r.intent)] = Number(r.cnt);
  }

  const topicDist: Record<string, number> = {};
  for (const r of topicDistRows) {
    topicDist[String(r.topic)] = Number(r.cnt);
  }

  return c.json({
    daily: dailyRows.map((r) => ({
      day: r.day,
      avg_quality: Math.round(Number(r.avg_quality ?? 0) * 1000) / 1000,
      avg_sentiment: Math.round(Number(r.avg_sentiment ?? 0) * 1000) / 1000,
      turn_count: Number(r.turn_count ?? 0),
      tool_failures: Number(r.tool_failures ?? 0),
    })),
    sentiment_distribution: sentimentDist,
    intent_distribution: intentDist,
    topic_distribution: topicDist,
  });
});
