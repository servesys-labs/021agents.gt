/**
 * Conversation persistence — DB functions for durable chat history.
 *
 * Schema (001_init.sql):
 *   conversations: PK = id (text, gen_random_uuid()::text)
 *   conversation_messages: PK = id (bigserial), FK = conversation_id (text)
 */

export interface Conversation {
  id: string;
  org_id: string;
  user_id: string;
  agent_name: string;
  channel: string;
  title: string;
  status: string;
  message_count: number;
  total_cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: number;
  conversation_id: string;
  role: string;
  content: string;
  model: string | null;
  cost_usd: number;
  session_id: string | null;
  created_at: string;
}

export async function createConversation(
  sql: any,
  opts: { org_id: string; user_id: string; agent_name: string; title?: string; channel?: string },
): Promise<Conversation> {
  const [row] = await sql`
    INSERT INTO conversations (org_id, user_id, agent_name, channel, title)
    VALUES (${opts.org_id}, ${opts.user_id}, ${opts.agent_name}, ${opts.channel || "portal"}, ${opts.title || "New conversation"})
    RETURNING *
  `;
  return row as Conversation;
}

export async function listConversations(
  sql: any,
  org_id: string,
  agent_name: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<Conversation[]> {
  const limit = Math.min(opts.limit || 50, 100);
  if (opts.cursor) {
    return await sql`
      SELECT * FROM conversations
      WHERE org_id = ${org_id} AND agent_name = ${agent_name}
        AND updated_at < (SELECT updated_at FROM conversations WHERE id = ${opts.cursor})
      ORDER BY updated_at DESC LIMIT ${limit}
    ` as Conversation[];
  }
  return await sql`
    SELECT * FROM conversations
    WHERE org_id = ${org_id} AND agent_name = ${agent_name}
    ORDER BY updated_at DESC LIMIT ${limit}
  ` as Conversation[];
}

export async function getConversation(
  sql: any, id: string, org_id: string,
): Promise<Conversation | null> {
  const [row] = await sql`
    SELECT * FROM conversations WHERE id = ${id} AND org_id = ${org_id}
  `;
  return (row as Conversation) ?? null;
}

export async function getConversationMessages(
  sql: any, conversation_id: string, opts: { limit?: number; after_id?: string } = {},
): Promise<ConversationMessage[]> {
  const limit = Math.min(opts.limit || 200, 500);
  if (opts.after_id) {
    return await sql`
      SELECT * FROM conversation_messages
      WHERE conversation_id = ${conversation_id} AND id > ${opts.after_id}
      ORDER BY created_at ASC LIMIT ${limit}
    ` as ConversationMessage[];
  }
  return await sql`
    SELECT * FROM conversation_messages
    WHERE conversation_id = ${conversation_id}
    ORDER BY created_at ASC LIMIT ${limit}
  ` as ConversationMessage[];
}

export async function appendConversationMessage(
  sql: any,
  msg: { conversation_id: string; role: string; content: string; model?: string; cost_usd?: number; session_id?: string },
): Promise<string> {
  const [row] = await sql`
    INSERT INTO conversation_messages (conversation_id, role, content, model, cost_usd, session_id)
    VALUES (${msg.conversation_id}, ${msg.role}, ${msg.content}, ${msg.model || ""}, ${msg.cost_usd || 0}, ${msg.session_id || null})
    RETURNING id
  `;
  await sql`
    UPDATE conversations SET
      message_count = message_count + 1,
      updated_at = NOW(),
      last_message_at = NOW()
    WHERE id = ${msg.conversation_id}
  `.catch(() => {});
  return String(row.id);
}

export async function updateConversationTitle(sql: any, id: string, title: string): Promise<void> {
  await sql`UPDATE conversations SET title = ${title}, updated_at = NOW() WHERE id = ${id}`;
}

export async function deleteConversation(sql: any, id: string, org_id: string): Promise<boolean> {
  const result = await sql`DELETE FROM conversations WHERE id = ${id} AND org_id = ${org_id}`;
  return result.count > 0;
}
