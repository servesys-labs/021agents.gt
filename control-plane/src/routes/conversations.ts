/**
 * Conversations router — CRUD for persistent chat threads.
 *
 * Conversations live in Supabase as the durable store.
 * The DO SQLite remains the hot cache for real-time context during execution.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { errorResponses } from "../schemas/openapi";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import {
  createConversation,
  listConversations,
  getConversation,
  getConversationMessages,
  updateConversationTitle,
  deleteConversation,
} from "../db/conversations";

export const conversationRoutes = createOpenAPIRouter();

// With clean schema, `id` is the PK — no normalization needed

// ── GET /conversations — list conversations ──────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Conversations"],
  summary: "List conversations for an agent",
  middleware: [requireScope("sessions:read")],
  request: {
    query: z.object({
      agent_name: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Conversation list",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 401, 500),
  },
});

conversationRoutes.openapi(listRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name, limit, cursor } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const conversations = await listConversations(sql, user.org_id, agent_name, {
    limit,
    cursor,
  });

  return c.json({
    conversations,
    has_more: conversations.length === limit,
    cursor: conversations.length > 0 ? conversations[conversations.length - 1].id : undefined,
  });
});

// ── GET /conversations/:id — get conversation detail ─────────────────

const getRoute = createRoute({
  method: "get",
  path: "/:id",
  tags: ["Conversations"],
  summary: "Get conversation detail",
  middleware: [requireScope("sessions:read")],
  request: {
    params: z.object({ id: z.string().min(1) }),
  },
  responses: {
    200: {
      description: "Conversation detail",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(401, 404, 500),
  },
});

conversationRoutes.openapi(getRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const conversation = await getConversation(sql, id, user.org_id);
  if (!conversation) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  return c.json(conversation);
});

// ── GET /conversations/:id/messages — get messages with pagination ───

const messagesRoute = createRoute({
  method: "get",
  path: "/:id/messages",
  tags: ["Conversations"],
  summary: "Get conversation messages with cursor pagination",
  middleware: [requireScope("sessions:read")],
  request: {
    params: z.object({ id: z.string().min(1) }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
      after_id: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Message list",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(401, 404, 500),
  },
});

conversationRoutes.openapi(messagesRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { id } = c.req.valid("param") as { id: string };
  const { limit, after_id } = c.req.valid("query") as { limit: number; after_id?: string };
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify conversation belongs to this org
  const conversation = await getConversation(sql, id, user.org_id);
  if (!conversation) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  const messages = await getConversationMessages(sql, id, { limit, after_id });

  return c.json({
    messages,
    has_more: messages.length === limit,
    after_id: messages.length > 0 ? messages[messages.length - 1].id : undefined,
  });
});

// ── POST /conversations — create conversation ───────────────────────

const createRoute2 = createRoute({
  method: "post",
  path: "/",
  tags: ["Conversations"],
  summary: "Create a new conversation",
  middleware: [requireScope("sessions:read")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1),
            channel: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Created conversation",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 401, 500),
  },
});

conversationRoutes.openapi(createRoute2, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const conversation = await createConversation(sql, {
    org_id: user.org_id,
    user_id: user.user_id || "",
    agent_name: body.agent_name,
    channel: body.channel,
  });

  return c.json(conversation, 201);
});

// ── PATCH /conversations/:id — update title ─────────────────────────

const patchRoute = createRoute({
  method: "patch",
  path: "/:id",
  tags: ["Conversations"],
  summary: "Update conversation title",
  middleware: [requireScope("sessions:read")],
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            title: z.string().min(1).max(200),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(401, 404, 500),
  },
});

conversationRoutes.openapi(patchRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { id } = c.req.valid("param") as { id: string };
  const { title } = c.req.valid("json") as { title: string };
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify ownership
  const conversation = await getConversation(sql, id, user.org_id);
  if (!conversation) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  await updateConversationTitle(sql, id, title);

  return c.json({ ok: true, id, title });
});

// ── DELETE /conversations/:id — delete conversation + cascade ────────

const deleteRoute = createRoute({
  method: "delete",
  path: "/:id",
  tags: ["Conversations"],
  summary: "Delete a conversation and all its messages",
  middleware: [requireScope("sessions:read")],
  request: {
    params: z.object({ id: z.string().min(1) }),
  },
  responses: {
    200: {
      description: "Deleted",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(401, 404, 500),
  },
});

conversationRoutes.openapi(deleteRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const deleted = await deleteConversation(sql, id, user.org_id);
  if (!deleted) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  return c.json({ ok: true, deleted: id });
});
