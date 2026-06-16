/**
 * HomesPanel — a @remix-run/ui `clientEntry` for the /homes page.
 *
 * Loads the signed-in user's homes via DPoP-protected `/api/homes`, and lets
 * them create a home and (as an admin) manage members: add by userId, change
 * role, remove. All requests are signed with `fetchDpop` from `ensureSession`.
 */

import {
  clientEntry,
  type Handle,
  on,
  type SerializableValue,
} from "@remix-run/ui";
import { ensureSession, type FetchDpop } from "./session.ts";

export interface HomesPanelProps {
  idpOrigin: string;
  [key: string]: SerializableValue;
}

interface HomeWithRole {
  id: string;
  name: string;
  role: "admin" | "member";
}

interface Member {
  userId: string;
  displayName: string;
  isAgent: boolean;
  role: "admin" | "member";
}

interface Thread {
  id: string;
  title: string;
}

interface Message {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export const HomesPanel = clientEntry(
  "/homes_panel.js#HomesPanel",
  function HomesPanel(handle: Handle<HomesPanelProps>) {
    let ready = false;
    let userId: string | null = null;
    let error = "";
    let homes: HomeWithRole[] = [];
    let selectedId: string | null = null;
    let members: Member[] = [];
    let threads: Thread[] = [];
    let selectedThreadId: string | null = null;
    let messages: Message[] = [];
    let newHomeName = "";
    let addUserId = "";
    let newThreadTitle = "";
    let newMessage = "";
    let fetchDpop: FetchDpop | null = null;
    let streamAbort: AbortController | null = null;

    const selectedRole = () => homes.find((h) => h.id === selectedId)?.role;

    /** Call a DPoP-protected JSON endpoint; throws on non-2xx with its error. */
    const api = async (
      path: string,
      init?: RequestInit,
    ): Promise<unknown> => {
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

    const loadHomes = async () => {
      const data = await api("/api/homes") as { homes: HomeWithRole[] };
      homes = data.homes;
    };

    const loadMembers = async (homeId: string) => {
      const data = await api(`/api/homes/${homeId}/members`) as {
        members: Member[];
      };
      members = data.members;
    };

    const loadThreads = async (homeId: string) => {
      const data = await api(`/api/homes/${homeId}/threads`) as {
        threads: Thread[];
      };
      threads = data.threads;
    };

    const loadMessages = async (threadId: string) => {
      const data = await api(`/api/threads/${threadId}/messages`) as {
        messages: Message[];
      };
      messages = data.messages;
    };

    /**
     * Open the thread's SSE stream and append new messages as they arrive.
     * Read with fetchDpop (EventSource can't send the DPoP header) and parse
     * the `event:`/`data:` frames manually.
     */
    const startStream = (threadId: string) => {
      streamAbort?.abort();
      const ac = new AbortController();
      streamAbort = ac;
      const afterId = messages.length ? messages[messages.length - 1].id : "";
      (async () => {
        const response = await fetchDpop!(
          `/api/threads/${threadId}/stream?after=${
            encodeURIComponent(afterId)
          }`,
          { signal: ac.signal },
        );
        if (!response.ok || !response.body) return;
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const lines = block.split("\n");
            const event = lines.find((l) => l.startsWith("event:"))
              ?.slice(6).trim();
            const data = lines.find((l) => l.startsWith("data:"))
              ?.slice(5).trim();
            if (event !== "message" || !data) continue;
            const msg = JSON.parse(data) as Message;
            if (
              selectedThreadId === threadId &&
              !messages.some((m) => m.id === msg.id)
            ) {
              messages = [...messages, msg];
              handle.update();
            }
          }
        }
      })().catch(() => {});
    };

    const run = async (fn: () => Promise<void>) => {
      error = "";
      try {
        await fn();
      } catch (e) {
        error = (e as Error).message;
      } finally {
        handle.update();
      }
    };

    const onCreate = () =>
      run(async () => {
        const name = newHomeName.trim();
        if (!name) return;
        await api("/api/homes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        newHomeName = "";
        await loadHomes();
      });

    const onSelect = (homeId: string) =>
      run(async () => {
        streamAbort?.abort();
        selectedId = homeId;
        selectedThreadId = null;
        messages = [];
        await loadMembers(homeId);
        await loadThreads(homeId);
      });

    const onCreateThread = () =>
      run(async () => {
        const title = newThreadTitle.trim();
        if (!title || !selectedId) return;
        await api(`/api/homes/${selectedId}/threads`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        newThreadTitle = "";
        await loadThreads(selectedId);
      });

    const onSelectThread = (threadId: string) =>
      run(async () => {
        selectedThreadId = threadId;
        await loadMessages(threadId);
        startStream(threadId);
      });

    const onPostMessage = () =>
      run(async () => {
        const body = newMessage.trim();
        if (!body || !selectedThreadId) return;
        await api(`/api/threads/${selectedThreadId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
        newMessage = "";
        await loadMessages(selectedThreadId);
      });

    const onAddMember = () =>
      run(async () => {
        const uid = addUserId.trim();
        if (!uid || !selectedId) return;
        await api(`/api/homes/${selectedId}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: uid }),
        });
        addUserId = "";
        await loadMembers(selectedId);
      });

    const onSetRole = (uid: string, role: "admin" | "member") =>
      run(async () => {
        await api(`/api/homes/${selectedId}/members/${uid}/role`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        });
        await loadMembers(selectedId!);
        await loadHomes();
      });

    const onRemove = (uid: string) =>
      run(async () => {
        await api(`/api/homes/${selectedId}/members/${uid}`, {
          method: "DELETE",
        });
        await loadMembers(selectedId!);
      });

    if (typeof document !== "undefined") {
      (async () => {
        try {
          const session = await ensureSession(handle.props.idpOrigin);
          fetchDpop = session.fetchDpop;
          userId = session.userId;
          if (userId) await loadHomes();
        } catch (e) {
          error = (e as Error).message;
        } finally {
          ready = true;
          handle.update();
        }
      })();
    }

    const memberRow = (m: Member) => {
      const isAdmin = selectedRole() === "admin";
      const canManage = isAdmin && m.userId !== userId;
      return (
        <tr>
          <td>
            {m.displayName}
            {m.isAgent ? <span class="badge badge-sm ml-1">agent</span> : null}
            <div class="text-xs opacity-60">{m.userId}</div>
          </td>
          <td>
            <span
              class={`badge ${
                m.role === "admin" ? "badge-primary" : "badge-ghost"
              }`}
            >
              {m.role}
            </span>
          </td>
          <td class="text-right">
            {canManage
              ? (
                <div class="join">
                  {m.role === "member"
                    ? (
                      <button
                        type="button"
                        class="btn btn-xs join-item"
                        mix={[on("click", () => onSetRole(m.userId, "admin"))]}
                      >
                        admin に
                      </button>
                    )
                    : (
                      <button
                        type="button"
                        class="btn btn-xs join-item"
                        mix={[on("click", () => onSetRole(m.userId, "member"))]}
                      >
                        member に
                      </button>
                    )}
                  <button
                    type="button"
                    class="btn btn-xs btn-error join-item"
                    mix={[on("click", () => onRemove(m.userId))]}
                  >
                    削除
                  </button>
                </div>
              )
              : null}
          </td>
        </tr>
      );
    };

    return () => {
      if (!ready) {
        return <div class="alert alert-soft">読み込み中…</div>;
      }
      if (!userId) {
        return (
          <div class="alert alert-soft">
            <span>
              Home を使うにはサインインが必要です。{" "}
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
              <h2 class="card-title">Home を作成</h2>
              <div class="join">
                <input
                  class="input input-bordered join-item"
                  placeholder="Home の名前"
                  value={newHomeName}
                  mix={[on<HTMLInputElement>("input", (e) => {
                    newHomeName = (e.target as HTMLInputElement).value;
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
            </div>
          </div>

          <div class="card card-border bg-base-100">
            <div class="card-body">
              <h2 class="card-title">あなたの Home</h2>
              {homes.length === 0
                ? <p class="opacity-70">まだ Home がありません。</p>
                : (
                  <ul class="menu bg-base-200 rounded-box">
                    {homes.map((h) => (
                      <li>
                        <a
                          class={selectedId === h.id ? "active" : ""}
                          mix={[on("click", () => onSelect(h.id))]}
                        >
                          {h.name}
                          <span class="badge badge-sm">{h.role}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          </div>

          {selectedId
            ? (
              <div class="space-y-6">
                <div class="card card-border bg-base-100">
                  <div class="card-body">
                    <h2 class="card-title">メンバー</h2>
                    {selectedRole() === "admin"
                      ? (
                        <div class="join">
                          <input
                            class="input input-bordered input-sm join-item"
                            placeholder="追加するユーザーの userId"
                            value={addUserId}
                            mix={[on<HTMLInputElement>("input", (e) => {
                              addUserId = (e.target as HTMLInputElement).value;
                            })]}
                          />
                          <button
                            type="button"
                            class="btn btn-sm join-item"
                            mix={[on("click", onAddMember)]}
                          >
                            メンバー追加
                          </button>
                        </div>
                      )
                      : null}
                    <table class="table">
                      <thead>
                        <tr>
                          <th>ユーザー</th>
                          <th>ロール</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>{members.map(memberRow)}</tbody>
                    </table>
                  </div>
                </div>

                <div class="card card-border bg-base-100">
                  <div class="card-body">
                    <h2 class="card-title">スレッド</h2>
                    <div class="join">
                      <input
                        class="input input-bordered input-sm join-item"
                        placeholder="新しいスレッドのタイトル"
                        value={newThreadTitle}
                        mix={[on<HTMLInputElement>("input", (e) => {
                          newThreadTitle = (e.target as HTMLInputElement).value;
                        })]}
                      />
                      <button
                        type="button"
                        class="btn btn-sm join-item"
                        mix={[on("click", onCreateThread)]}
                      >
                        作成
                      </button>
                    </div>
                    {threads.length === 0
                      ? <p class="opacity-70">まだスレッドがありません。</p>
                      : (
                        <ul class="menu bg-base-200 rounded-box">
                          {threads.map((t) => (
                            <li>
                              <a
                                class={selectedThreadId === t.id
                                  ? "active"
                                  : ""}
                                mix={[on("click", () => onSelectThread(t.id))]}
                              >
                                {t.title}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                  </div>
                </div>

                {selectedThreadId
                  ? (
                    <div class="card card-border bg-base-100">
                      <div class="card-body">
                        <h2 class="card-title">メッセージ</h2>
                        <div class="space-y-2">
                          {messages.length === 0
                            ? (
                              <p class="opacity-70">
                                まだメッセージがありません。
                              </p>
                            )
                            : messages.map((m) => (
                              <div class="chat chat-start">
                                <div class="chat-header">
                                  {m.authorName}
                                  <time class="text-xs opacity-50 ml-1">
                                    {m.createdAt}
                                  </time>
                                </div>
                                <div class="chat-bubble">{m.body}</div>
                              </div>
                            ))}
                        </div>
                        <div class="join mt-2 w-full">
                          <input
                            class="input input-bordered join-item flex-1"
                            placeholder="メッセージを入力"
                            value={newMessage}
                            mix={[on<HTMLInputElement>("input", (e) => {
                              newMessage = (e.target as HTMLInputElement).value;
                            })]}
                          />
                          <button
                            type="button"
                            class="btn btn-primary join-item"
                            mix={[on("click", onPostMessage)]}
                          >
                            送信
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                  : null}
              </div>
            )
            : null}
        </div>
      );
    };
  },
);
