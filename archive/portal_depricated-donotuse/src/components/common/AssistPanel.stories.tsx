import type { Meta, StoryObj } from "@storybook/react-vite";
import { MemoryRouter } from "react-router-dom";
import { AssistPanel, AssistInlineHint } from "./AssistPanel";
import { MetaAgentProvider } from "../../providers/MetaAgentProvider";

/** Wrapper that provides routing + meta-agent context required by AssistPanel */
function ProviderWrap({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/agents"]}>
      <MetaAgentProvider>{children}</MetaAgentProvider>
    </MemoryRouter>
  );
}

const meta = {
  title: "Common/AssistPanel",
  decorators: [(Story) => <ProviderWrap><Story /></ProviderWrap>],
} satisfies Meta;

export default meta;

export const Default: StoryObj = {
  render: () => <AssistPanel />,
};

export const Compact: StoryObj = {
  render: () => <AssistPanel compact />,
};

export const CustomSuggestions: StoryObj = {
  render: () => (
    <AssistPanel
      heading="Try these"
      customSuggestions={[
        { label: "Analyze traces", prompt: "Analyze recent traces" },
        { label: "Run eval", prompt: "Run eval loop" },
        { label: "Check security", prompt: "Security assessment" },
      ]}
    />
  ),
};

export const InlineHint: StoryObj = {
  render: () => (
    <AssistInlineHint
      message="Meta-agent can analyze this trace for patterns and failures"
      actionLabel="Analyze traces"
      prompt="Analyze the recent traces for my-agent"
    />
  ),
};
