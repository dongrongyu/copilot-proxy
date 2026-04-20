import { getState } from "../auth/state";

/**
 * Build headers for Copilot API requests.
 */
export function getCopilotHeaders(enableVision = false): Record<string, string> {
  const state = getState();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.copilot_token}`,
    "Content-Type": "application/json",
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Version": `vscode/${state.config.vscode_version}`,
    "Editor-Plugin-Version": `copilot-chat/${state.config.copilot_version}`,
    "User-Agent": `GitHubCopilotChat/${state.config.copilot_version}`,
    "OpenAI-Intent": "conversation-panel",
    "X-GitHub-Api-Version": state.config.api_version,
    "X-Request-Id": crypto.randomUUID(),
    "X-VSCode-User-Agent-Library-Version": "electron-fetch",
  };
  if (enableVision) {
    headers["Copilot-Vision-Request"] = "true";
  }
  return headers;
}

/**
 * Build headers for direct Anthropic API path.
 * Adds anthropic-version header on top of standard Copilot headers.
 */
export function getAnthropicHeaders(enableVision = false): Record<string, string> {
  const headers = getCopilotHeaders(enableVision);
  headers["anthropic-version"] = "2023-06-01";
  return headers;
}

/**
 * Detect if messages contain image content blocks.
 */
export function hasVisionContent(messages: any[]): boolean {
  return messages.some(
    (msg: any) =>
      Array.isArray(msg.content) &&
      msg.content.some((p: any) => p.type === "image")
  );
}

/**
 * Detect if this is an agent call (has assistant messages).
 * Used for X-Initiator header.
 */
export function isAgentCall(messages: any[]): boolean {
  return messages.some((msg: any) => msg.role === "assistant");
}
