import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusBadge } from "./StatusBadge";

const meta = {
  title: "Common/StatusBadge",
  component: StatusBadge,
  argTypes: {
    status: {
      control: "select",
      options: ["live", "online", "success", "error", "warning", "draft", "running", "active", "cancelled", "unknown", "healthy", "degraded"],
    },
  },
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Live: Story = { args: { status: "live" } };
export const Error: Story = { args: { status: "error" } };
export const Warning: Story = { args: { status: "warning" } };
export const Draft: Story = { args: { status: "draft" } };
export const Running: Story = { args: { status: "running" } };
export const Healthy: Story = { args: { status: "healthy" } };
export const Unknown: Story = { args: { status: "unknown" } };

export const AllStatuses: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 p-4">
      {["live", "online", "success", "error", "warning", "draft", "running", "active", "cancelled", "unknown", "healthy", "degraded"].map((s) => (
        <StatusBadge key={s} status={s} />
      ))}
    </div>
  ),
};
