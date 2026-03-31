/**
 * TUI Entry Point — renders the Ink app for 'oneshots' interactive mode
 */
import React from "react";
import { render } from "ink";
import App from "./App.js";

export async function launchTUI(agentName: string, options?: { system?: string }): Promise<void> {
  const { waitUntilExit } = render(
    <App agentName={agentName} systemPrompt={options?.system} />
  );
  await waitUntilExit();
}
