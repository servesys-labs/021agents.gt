import { api } from "$lib/services/api";

export interface Agent {
  name: string;
  description?: string;
  model?: string;
  plan?: string;
  tools?: string[];
  tags?: string[];
  version?: number | string;
  is_active?: boolean | number;
}

class AgentStore {
  agents = $state<Agent[]>([]);
  activeAgent = $state<Agent | null>(null);
  loading = $state(false);

  async fetchAgents() {
    this.loading = true;
    try {
      const data = await api.get<Agent[] | { agents: Agent[] }>("/agents");
      // API returns bare array, not wrapped in { agents: [...] }
      const all = Array.isArray(data) ? data : (data.agents ?? []);
      // meta-agent is ambient (not user-configurable) — hide from sidebar
      this.agents = all.filter(a => a.name !== "meta-agent");
    } catch (err) {
      console.error("Failed to fetch agents:", err);
      this.agents = [];
    } finally {
      this.loading = false;
    }
  }

  setActive(name: string) {
    this.activeAgent = this.agents.find((a) => a.name === name) ?? null;
  }

  async removeAgent(name: string) {
    await api.deleteAgent(name);
    this.agents = this.agents.filter((a) => a.name !== name);
    if (this.activeAgent?.name === name) this.activeAgent = null;
  }
}

export const agentStore = new AgentStore();
