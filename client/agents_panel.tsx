/**
 * AgentsPanel — a @remix-run/ui `clientEntry` for /agents.
 *
 * Lets a signed-in human create AI agents (each an owned `is_agent` user) and
 * issue a bearer token used by the MCP server. The token is shown once at
 * creation. To let an agent act in a home, add it as a member by its agent id.
 */

import {
  clientEntry,
  type Handle,
  on,
  type SerializableValue,
} from "@remix-run/ui";
import { ensureSession, type FetchDpop } from "./session.ts";

export interface AgentsPanelProps {
  idpOrigin: string;
  [key: string]: SerializableValue;
}

interface Agent {
  id: string;
  displayName: string;
  createdAt: string;
}

export const AgentsPanel = clientEntry(
  "/agents_panel.js#AgentsPanel",
  function AgentsPanel(handle: Handle<AgentsPanelProps>) {
    let ready = false;
    let userId: string | null = null;
    let error = "";
    let agents: Agent[] = [];
    let newName = "";
    let issuedToken: string | null = null;
    let issuedAgentId: string | null = null;
    let fetchDpop: FetchDpop | null = null;

    const api = async (path: string, init?: RequestInit): Promise<unknown> => {
      const response = await fetchDpop!(path, init);
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(
          (data as { error?: string }).error ?? response.statusText,
        );
      }
      return data;
    };

    const loadAgents = async () => {
      const data = await api("/api/agents") as { agents: Agent[] };
      agents = data.agents;
    };

    const run = (fn: () => Promise<void>) => async () => {
      error = "";
      try {
        await fn();
      } catch (e) {
        error = (e as Error).message;
      } finally {
        handle.update();
      }
    };

    const onCreate = run(async () => {
      const displayName = newName.trim();
      if (!displayName) return;
      const data = await api("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      }) as { agent: Agent; token: string };
      newName = "";
      issuedToken = data.token;
      issuedAgentId = data.agent.id;
      await loadAgents();
    });

    const onDelete = (agentId: string) =>
      run(async () => {
        if (!globalThis.confirm("このエージェントを無効化しますか？")) return;
        await api(`/api/agents/${agentId}`, { method: "DELETE" });
        if (issuedAgentId === agentId) {
          issuedToken = null;
          issuedAgentId = null;
        }
        await loadAgents();
      })();

    if (typeof document !== "undefined") {
      (async () => {
        try {
          const session = await ensureSession(handle.props.idpOrigin);
          fetchDpop = session.fetchDpop;
          userId = session.userId;
          if (userId) await loadAgents();
        } catch (e) {
          error = (e as Error).message;
        } finally {
          ready = true;
          handle.update();
        }
      })();
    }

    return () => {
      if (!ready) return <div class="alert alert-soft">読み込み中…</div>;
      if (!userId) {
        return (
          <div class="alert alert-soft">
            <span>
              エージェント管理にはサインインが必要です。{" "}
              <a class="link" href="/signin" rmx-target="content">サインイン</a>
            </span>
          </div>
        );
      }
      return (
        <div class="space-y-6">
          {error
            ? (
              <div role="alert" class="alert alert-error alert-soft">
                <span>{error}</span>
              </div>
            )
            : null}

          <div class="card card-border bg-base-100">
            <div class="card-body">
              <h2 class="card-title">エージェントを作成</h2>
              <div class="join">
                <input
                  class="input input-bordered join-item"
                  placeholder="エージェント名"
                  value={newName}
                  mix={[on<HTMLInputElement>("input", (e) => {
                    newName = (e.target as HTMLInputElement).value;
                  })]}
                />
                <button
                  type="button"
                  class="btn btn-primary join-item"
                  mix={[on("click", onCreate)]}
                >
                  作成
                </button>
              </div>
              {issuedToken
                ? (
                  <div role="alert" class="alert alert-success alert-soft mt-3">
                    <div>
                      <p class="font-semibold">
                        トークン（この画面でだけ表示されます）
                      </p>
                      <code class="break-all">{issuedToken}</code>
                      <p class="text-sm mt-1">
                        エージェント id: <code>{issuedAgentId}</code>{" "}
                        — この id を Home に「メンバー追加」すると参加できます。
                      </p>
                    </div>
                  </div>
                )
                : null}
            </div>
          </div>

          <div class="card card-border bg-base-100">
            <div class="card-body">
              <h2 class="card-title">あなたのエージェント</h2>
              {agents.length === 0
                ? <p class="opacity-70">まだエージェントがいません。</p>
                : (
                  <ul class="divide-y divide-base-200">
                    {agents.map((a) => (
                      <li class="flex items-center justify-between py-2">
                        <span>
                          {a.displayName}
                          <span class="badge badge-sm ml-1">agent</span>
                          <div class="text-xs opacity-60">{a.id}</div>
                        </span>
                        <button
                          type="button"
                          class="btn btn-xs btn-error"
                          mix={[on("click", () => onDelete(a.id))]}
                        >
                          無効化
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          </div>
        </div>
      );
    };
  },
);
