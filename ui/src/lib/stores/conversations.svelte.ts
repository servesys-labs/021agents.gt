/**
 * Conversation store — Svelte 5 runes store for persistent chat threads.
 */
import {
  listConversations,
  getConversationMessages,
  deleteConversation as apiDeleteConversation,
  type Conversation,
  type ConversationMessage,
} from "$lib/services/conversations";

class ConversationStore {
  conversations = $state<Conversation[]>([]);
  activeConversationId = $state<string | null>(null);
  loading = $state(false);
  messagesLoading = $state(false);

  /** Loaded messages for the active conversation */
  messages = $state<ConversationMessage[]>([]);

  async fetchConversations(agentName: string) {
    this.loading = true;
    try {
      const result = await listConversations(agentName);
      this.conversations = Array.isArray(result?.conversations) ? result.conversations : [];
    } catch (err) {
      console.error("Failed to fetch conversations:", err);
      this.conversations = [];
    } finally {
      this.loading = false;
    }
  }

  async loadConversation(id: string) {
    this.activeConversationId = id;
    this.messagesLoading = true;
    try {
      const result = await getConversationMessages(id);
      this.messages = Array.isArray(result?.messages) ? result.messages : [];
    } catch (err) {
      console.error("Failed to load conversation:", err);
      this.messages = [];
    } finally {
      this.messagesLoading = false;
    }
  }

  startNew() {
    this.activeConversationId = null;
    this.messages = [];
  }

  setActiveId(id: string) {
    this.activeConversationId = id;
  }

  async deleteConversation(id: string) {
    try {
      await apiDeleteConversation(id);
      this.conversations = this.conversations.filter((c) => c.id !== id);
      if (this.activeConversationId === id) {
        this.startNew();
      }
    } catch (err) {
      console.error("Failed to delete conversation:", err);
    }
  }
}

export const conversationStore = new ConversationStore();
