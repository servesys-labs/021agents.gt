import type { Meta, StoryObj } from "@storybook/react-vite";
import { EmptyState } from "./EmptyState";
import { Bot, Play, ShieldCheck } from "lucide-react";

const meta = {
  title: "Common/EmptyState",
  component: EmptyState,
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    icon: <Bot size={40} />,
    title: "No agents found",
    description: "Create your first agent to get started",
    actionLabel: "Create Agent",
    onAction: () => {},
  },
};

export const NoSessions: Story = {
  args: {
    icon: <Play size={40} />,
    title: "No sessions found",
    description: "Sessions will appear here when agents are run",
  },
};

export const SecurityClear: Story = {
  args: {
    icon: <ShieldCheck size={40} />,
    title: "No security findings",
    description: "All agents are passing security checks",
  },
};

export const WithCustomAction: Story = {
  args: {
    icon: <Bot size={40} />,
    title: "No agents found",
    description: "Try a different search term",
    action: <button className="btn btn-secondary text-xs">Clear Filters</button>,
  },
};
