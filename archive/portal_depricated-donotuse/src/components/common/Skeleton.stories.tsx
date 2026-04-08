import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  SkeletonText,
  SkeletonAvatar,
  SkeletonCard,
  SkeletonTable,
  SkeletonDashboard,
  SkeletonKPIGrid,
  SkeletonAgentGrid,
} from "./Skeleton";

const meta = {
  title: "Common/Skeleton",
} satisfies Meta;

export default meta;

export const Text: StoryObj = {
  render: () => <SkeletonText lines={4} />,
};

export const Avatar: StoryObj = {
  render: () => (
    <div className="flex gap-3">
      <SkeletonAvatar size={32} />
      <SkeletonAvatar size={40} />
      <SkeletonAvatar size={48} shape="rounded" />
    </div>
  ),
};

export const Card: StoryObj = {
  render: () => (
    <div className="max-w-sm">
      <SkeletonCard />
    </div>
  ),
};

export const Table: StoryObj = {
  render: () => <SkeletonTable rows={5} cols={4} />,
};

export const KPIGrid: StoryObj = {
  render: () => <SkeletonKPIGrid count={3} />,
};

export const AgentGrid: StoryObj = {
  render: () => <SkeletonAgentGrid count={6} />,
};

export const Dashboard: StoryObj = {
  render: () => <SkeletonDashboard />,
};
