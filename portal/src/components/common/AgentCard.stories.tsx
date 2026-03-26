import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentCard, type AgentCardData } from "./AgentCard";

const meta = {
  title: "Common/AgentCard",
  component: AgentCard,
} satisfies Meta<typeof AgentCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const baseAgent: AgentCardData = {
  name: "support-bot",
  description: "Customer support agent with order lookup and refund capabilities",
  status: "live",
  model: "gpt-4o",
  version: "v1.2.0",
  tags: ["support", "production"],
  last_active: new Date().toISOString(),
};

export const Live: Story = {
  args: {
    agent: baseAgent,
    onSelect: () => {},
  },
};

export const Draft: Story = {
  args: {
    agent: { ...baseAgent, name: "data-analyst", status: "draft", description: "Analyzes sales data and generates reports", tags: ["analytics"], version: undefined },
    onSelect: () => {},
  },
};

export const Error: Story = {
  args: {
    agent: { ...baseAgent, name: "broken-agent", status: "error", description: "This agent has configuration issues", tags: ["needs-fix"] },
    onSelect: () => {},
  },
};

export const Grid: Story = {
  args: { agent: baseAgent, onSelect: () => {} },
  render: () => (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-w-4xl">
      <AgentCard agent={baseAgent} onSelect={() => {}} />
      <AgentCard agent={{ ...baseAgent, name: "data-analyst", status: "draft", model: "claude-sonnet-4-20250514" }} onSelect={() => {}} />
      <AgentCard agent={{ ...baseAgent, name: "code-reviewer", status: "live", model: "gpt-4.1-mini", tags: ["ci", "review"] }} onSelect={() => {}} />
    </div>
  ),
};
