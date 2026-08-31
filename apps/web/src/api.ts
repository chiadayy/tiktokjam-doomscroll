import type { AdminOverview, Agent, AgentRun, Message, SystemInfo } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  adminOverview: () => request<AdminOverview>("/api/admin/overview"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  resolveApproval: (runId: string, approvalId: string, decision: "approve" | "deny") =>
    request<{ run: AgentRun }>("/api/runs/" + runId + "/approval", {
      method: "POST",
      body: JSON.stringify({ approvalId, decision }),
    }),
  // The trace is JSON Lines, not JSON, so it bypasses the shared request
  // helper. Returns null while a run has not written anything yet.
  //
  // The server redacts credential-shaped values out of this body on the way
  // out and reports how many in `x-redactions`. That count is read here rather
  // than dropped, because a log that was altered has to say so — silently
  // changed evidence is its own problem, separate from the leak it prevents.
  trace: async (id: string): Promise<{ text: string; redactions: number } | null> => {
    const response = await fetch("/api/runs/" + id + "/trace", {
      headers: authToken ? { Authorization: "Bearer " + authToken } : {},
    });
    if (!response.ok) return null;
    const redactions = Number(response.headers.get("x-redactions") ?? 0);
    return {
      text: await response.text(),
      redactions: Number.isFinite(redactions) ? redactions : 0,
    };
  },
};
