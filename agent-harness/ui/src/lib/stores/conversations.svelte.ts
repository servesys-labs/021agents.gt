/**
 * Conversation store — Svelte 5 runes store for persistent chat threads.
 * Supports search, pin, rename, time-grouped display.
 */
import {
  listConversations,
  getConversationMessages,
  deleteConversation as apiDeleteConversation,
  updateConversation as apiUpdateConversation,
  type Conversation,
  type ConversationMessage,
} from "$lib/services/conversations";

class ConversationStore {
  conversations = $state<Conversation[]>([]);
  activeConversationId = $state<string | null>(null);
  loading = $state(false);
  messagesLoading = $state(false);
  searchQuery = $state("");

  /** Loaded messages for the active conversation */
  messages = $state<ConversationMessage[]>([]);

  /** Filtered + sorted conversations (pinned first, then by time) */
  get filtered(): Conversation[] {
    let list = this.conversations;
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      list = list.filter(c =>
        (c.title || "").toLowerCase().includes(q) ||
        c.id.includes(q)
      );
    }
    // Pinned first, then by updated_at descending
    return [...list].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }

  /** Group filtered conversations by time period */
  get grouped(): { label: string; items: Conversation[] }[] {
    const convs = this.filtered;
    const now = Date.now();
    const dayMs = 86400_000;
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const yesterdayStart = todayStart - dayMs;
    const weekStart = todayStart - 7 * dayMs;

    const groups: { label: string; items: Conversation[] }[] = [];
    const pinned: Conversation[] = [];
    const today: Conversation[] = [];
    const yesterday: Conversation[] = [];
    const week: Conversation[] = [];
    const older: Conversation[] = [];

    for (const c of convs) {
      if (c.pinned) { pinned.push(c); continue; }
      const t = new Date(c.updated_at).getTime();
      if (t >= todayStart) today.push(c);
      else if (t >= yesterdayStart) yesterday.push(c);
      else if (t >= weekStart) week.push(c);
      else older.push(c);
    }

    if (pinned.length) groups.push({ label: "Pinned", items: pinned });
    if (today.length) groups.push({ label: "Today", items: today });
    if (yesterday.length) groups.push({ label: "Yesterday", items: yesterday });
    if (week.length) groups.push({ label: "Previous 7 Days", items: week });
    if (older.length) groups.push({ label: "Older", items: older });
    return groups;
  }

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

  async renameConversation(id: string, title: string) {
    try {
      await apiUpdateConversation(id, { title });
      this.conversations = this.conversations.map(c =>
        c.id === id ? { ...c, title } : c
      );
    } catch (err) {
      console.error("Failed to rename conversation:", err);
    }
  }

  async togglePin(id: string) {
    const conv = this.conversations.find(c => c.id === id);
    if (!conv) return;
    const pinned = !conv.pinned;
    try {
      await apiUpdateConversation(id, { pinned });
      this.conversations = this.conversations.map(c =>
        c.id === id ? { ...c, pinned } : c
      );
    } catch (err) {
      console.error("Failed to toggle pin:", err);
    }
  }
}

export const conversationStore = new ConversationStore();
