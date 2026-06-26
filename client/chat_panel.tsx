/**
 * ChatPanel — the URL-driven chat view for one home (`/home/:homeId` and
 * `/home/:homeId/thread/:threadId`).
 *
 * Layout: a left sidebar listing the main channel + every thread, and a right
 * conversation pane. On desktop the sidebar is always shown (daisyUI
 * `lg:drawer-open`); on mobile it is an overlay drawer opened by the hamburger
 * button or a right-swipe from the screen edge.
 *
 * The "main channel" is the home's thread-less conversation; selecting it or a
 * thread swaps the conversation client-side and updates the URL (pushState)
 * without a full navigation.
 */

import {
  clientEntry,
  type Handle,
  on,
  type SerializableValue,
} from "@remix-run/ui";
import { ensureSession, type FetchDpop } from "./session.ts";

export interface ChatPanelProps {
  idpOrigin: string;
  homeId: string;
  /** Initial thread id from the URL, or "" for the main channel. */
  threadId: string;
  [key: string]: SerializableValue;
}

interface HomeWithRole {
  id: string;
  name: string;
  role: "admin" | "member";
  themeCss: string;
}

interface Thread {
  id: string;
  title: string;
  createdBy: string;
  archivedAt: string | null;
  joined: boolean;
}

interface Member {
  userId: string;
  displayName: string;
  isAgent: boolean;
  role: "admin" | "member";
}

interface Message {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  kind: "normal" | "repost" | "edit";
  deleted: boolean;
  hidden: boolean;
  repost: { authorName: string; body: string; deleted: boolean } | null;
  quotedIn: { threadId: string; title: string }[];
  reactions: { emoji: string; count: number; mine: boolean }[];
}

const DEFAULT_EMOJIS = ["👍", "❤️", "😂", "🎉", "😮", "🙏"];
const DRAWER_ID = "chat-drawer";

export const ChatPanel = clientEntry(
  "/chat_panel.js#ChatPanel",
  function ChatPanel(handle: Handle<ChatPanelProps>) {
    const homeId = handle.props.homeId;
    let ready = false;
    let userId: string | null = null;
    let error = "";
    let homeName = "";
    let role: "admin" | "member" | null = null;
    let threads: Thread[] = [];
    let currentThreadId: string | null = handle.props.threadId || null;
    let messages: Message[] = [];
    let newMessage = "";
    let recentEmojis: string[] = [];
    let paletteFor: string | null = null;
    let quotesFor: string | null = null;
    let fetchDpop: FetchDpop | null = null;
    let streamAbort: AbortController | null = null;
    // Settings overlay + per-home management.
    let themeCss = "";
    let settingsOpen = false;
    let homeSettingsOpen = false;
    let nameDraft = "";
    let members: Member[] = [];
    let addUserId = "";
    let themeDraft = "";
    let inviteToken: string | null = null;
    let inviteTimer: ReturnType<typeof setInterval> | null = null;

    const currentThread = () => threads.find((t) => t.id === currentThreadId);
    const archived = () => !!currentThread()?.archivedAt;
    const channelTitle = () =>
      currentThreadId ? (currentThread()?.title ?? "スレッド") : "# メイン";
    /** API base for the active channel (main channel or a thread). */
    const channelBase = () =>
      currentThreadId
        ? `/api/threads/${currentThreadId}`
        : `/api/homes/${homeId}`;

    const applyTheme = (css: string) => {
      if (typeof document === "undefined") return;
      const id = "home-theme";
      let el = document.getElementById(id) as HTMLStyleElement | null;
      if (!css) {
        el?.remove();
        return;
      }
      if (!el) {
        el = document.createElement("style");
        el.id = id;
        document.head.appendChild(el);
      }
      el.textContent = css;
    };

    const closeDrawer = () => {
      if (typeof document === "undefined") return;
      const cb = document.getElementById(DRAWER_ID) as HTMLInputElement | null;
      if (cb) cb.checked = false;
    };

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

    const loadHome = async () => {
      const data = await api("/api/homes") as { homes: HomeWithRole[] };
      const home = data.homes.find((h) => h.id === homeId);
      if (!home) throw new Error("このホームにアクセスできません");
      homeName = home.name;
      role = home.role;
      themeCss = home.themeCss;
      applyTheme(themeCss);
    };

    const loadThreads = async () => {
      const data = await api(`/api/homes/${homeId}/threads`) as {
        threads: Thread[];
      };
      threads = data.threads;
    };

    const loadMessages = async () => {
      const data = await api(`${channelBase()}/messages`) as {
        messages: Message[];
      };
      messages = data.messages;
    };

    const loadRecentEmojis = async () => {
      const data = await api("/api/reactions/recent") as { emojis: string[] };
      recentEmojis = data.emojis;
    };

    /** Open the active channel's SSE stream; re-fetch messages on each ping. */
    const startStream = (threadId: string | null) => {
      streamAbort?.abort();
      const ac = new AbortController();
      streamAbort = ac;
      const src = threadId
        ? `/api/threads/${threadId}/stream`
        : `/api/homes/${homeId}/stream`;
      (async () => {
        const response = await fetchDpop!(src, { signal: ac.signal });
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
            const event = block.split("\n").find((l) => l.startsWith("event:"))
              ?.slice(6).trim();
            if (event === "sync" && currentThreadId === threadId) {
              await loadMessages();
              handle.update();
            }
          }
        }
      })().catch(() => {});
    };

    const urlFor = (threadId: string | null) =>
      threadId ? `/home/${homeId}/thread/${threadId}` : `/home/${homeId}`;

    const selectChannel = (threadId: string | null) =>
      run(async () => {
        currentThreadId = threadId;
        paletteFor = null;
        if (typeof history !== "undefined") {
          history.pushState({}, "", urlFor(threadId));
        }
        closeDrawer();
        await loadMessages();
        startStream(threadId);
      });

    const onLeave = (threadId: string) =>
      run(async () => {
        await api(`/api/threads/${threadId}/leave`, { method: "POST" });
        await loadThreads();
      });

    const onPickupToNewThread = (messageId: string) =>
      run(async () => {
        const title = globalThis.prompt("返信スレッドのタイトル", "");
        if (title == null || !title.trim()) return;
        const data = await api(`/api/homes/${homeId}/threads`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            sourcePostIds: [messageId],
          }),
        }) as { thread: Thread };
        await loadThreads();
        await selectChannel(data.thread.id);
      });

    const onRenameThread = (threadId: string, current: string) =>
      run(async () => {
        const next = globalThis.prompt("スレッド名を編集", current);
        if (next == null || !next.trim()) return;
        await api(`/api/threads/${threadId}/title`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: next.trim() }),
        });
        await loadThreads();
      });

    const loadMembers = async () => {
      const data = await api(`/api/homes/${homeId}/members`) as {
        members: Member[];
      };
      members = data.members;
    };

    const openSettings = () =>
      run(async () => {
        closeDrawer();
        await loadMembers();
        nameDraft = members.find((m) => m.userId === userId)?.displayName ??
          userId ?? "";
        themeDraft = themeCss;
        settingsOpen = true;
      });

    const closeSettings = () => {
      settingsOpen = false;
      homeSettingsOpen = false;
      stopInviteHeartbeat();
      handle.update();
    };

    const onSaveName = () =>
      run(async () => {
        await api(`/api/homes/${homeId}/name`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: nameDraft }),
        });
        await loadMembers();
        await loadMessages(); // author name reflects the new name
      });

    const onAddMember = () =>
      run(async () => {
        const uid = addUserId.trim();
        if (!uid) return;
        await api(`/api/homes/${homeId}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: uid }),
        });
        addUserId = "";
        await loadMembers();
      });

    const onSetRole = (uid: string, r: "admin" | "member") =>
      run(async () => {
        await api(`/api/homes/${homeId}/members/${uid}/role`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: r }),
        });
        await loadMembers();
        await loadHome(); // my own role may have changed
      });

    const onRemoveMember = (uid: string) =>
      run(async () => {
        await api(`/api/homes/${homeId}/members/${uid}`, { method: "DELETE" });
        await loadMembers();
      });

    const stopInviteHeartbeat = () => {
      if (inviteTimer !== null) {
        clearInterval(inviteTimer);
        inviteTimer = null;
      }
      inviteToken = null;
    };

    const onInvite = () =>
      run(async () => {
        const data = await api(`/api/homes/${homeId}/invite`, {
          method: "POST",
        }) as { token: string };
        inviteToken = data.token;
        if (inviteTimer !== null) clearInterval(inviteTimer);
        inviteTimer = setInterval(() => {
          if (inviteToken && fetchDpop) {
            fetchDpop(`/api/invites/${inviteToken}/heartbeat`, {
              method: "POST",
            }).catch(() => {});
          }
        }, 20_000);
      });

    const onCloseInvite = () =>
      run(async () => {
        const token = inviteToken;
        stopInviteHeartbeat();
        if (token) await api(`/api/invites/${token}`, { method: "DELETE" });
      });

    const onSaveTheme = () =>
      run(async () => {
        const data = await api(`/api/homes/${homeId}/theme`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ css: themeDraft }),
        }) as { themeCss: string };
        themeDraft = data.themeCss;
        themeCss = data.themeCss;
        applyTheme(themeCss);
      });

    const onPost = () =>
      run(async () => {
        const body = newMessage.trim();
        if (!body) return;
        await api(`${channelBase()}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
        newMessage = "";
        await loadMessages();
      });

    const onEdit = (messageId: string, current: string) =>
      run(async () => {
        const next = globalThis.prompt("メッセージを編集", current);
        if (next == null) return;
        const body = next.trim();
        if (!body) return;
        await api(`/api/messages/${messageId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
        await loadMessages();
      });

    const onDelete = (messageId: string) =>
      run(async () => {
        if (!globalThis.confirm("このメッセージを削除しますか？")) return;
        await api(`/api/messages/${messageId}`, { method: "DELETE" });
        await loadMessages();
      });

    const onToggleReaction = (messageId: string, emoji: string) =>
      run(async () => {
        paletteFor = null;
        await api(`/api/messages/${messageId}/reactions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emoji }),
        });
        await loadMessages();
        await loadRecentEmojis();
      });

    if (typeof document !== "undefined") {
      // Right-swipe from the left edge opens the drawer; left-swipe closes it.
      // (No-op on desktop where the drawer is always open via CSS.)
      let sx = 0;
      let sy = 0;
      document.addEventListener("touchstart", (e) => {
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
      }, { passive: true });
      document.addEventListener("touchend", (e) => {
        const t = e.changedTouches[0];
        const dx = t.clientX - sx;
        const dy = t.clientY - sy;
        if (Math.abs(dy) > 50) return;
        const cb = document.getElementById(DRAWER_ID) as
          | HTMLInputElement
          | null;
        if (!cb) return;
        if (sx < 40 && dx > 60) cb.checked = true;
        else if (cb.checked && dx < -60) cb.checked = false;
      }, { passive: true });

      // Keep the view in sync with browser back/forward.
      globalThis.addEventListener("popstate", () => {
        const m = location.pathname.match(/\/home\/[^/]+\/thread\/([^/]+)/);
        const threadId = m ? m[1] : null;
        if (threadId !== currentThreadId) {
          currentThreadId = threadId;
          loadMessages().then(() => {
            startStream(threadId);
            handle.update();
          }).catch(() => {});
        }
      });

      (async () => {
        try {
          const session = await ensureSession(handle.props.idpOrigin);
          fetchDpop = session.fetchDpop;
          userId = session.userId;
          if (userId) {
            await loadHome();
            await loadThreads();
            await loadMessages();
            await loadRecentEmojis();
            startStream(currentThreadId);
          }
        } catch (e) {
          error = (e as Error).message;
        } finally {
          ready = true;
          handle.update();
        }
      })();
    }

    const messageBubble = (m: Message) => {
      if (m.kind === "edit") {
        // Forward marker left where the post used to be; the edited version is
        // re-posted at the tail.
        return (
          <div class="text-xs italic opacity-50 px-2 py-1">
            ✏️ {m.authorName} さんがこの投稿を編集しました（最新版は下）
          </div>
        );
      }
      if (m.deleted) {
        return (
          <div class="chat chat-start">
            <div class="chat-header">{m.authorName}</div>
            <div class="chat-bubble chat-bubble-neutral italic opacity-60">
              削除されました
            </div>
          </div>
        );
      }
      const mine = m.authorId === userId;
      const canDelete = mine || role === "admin";
      return (
        <div class="chat chat-start group relative">
          <div class="chat-header">
            {m.authorName}
            <time class="text-xs opacity-50 ml-1">{m.createdAt}</time>
            {m.editedAt
              ? <span class="text-xs opacity-50 ml-1">(編集済み)</span>
              : null}
            {m.hidden
              ? (
                <span class="badge badge-warning badge-xs ml-1">
                  管理者により非表示
                </span>
              )
              : null}
          </div>
          <div class={`chat-bubble ${m.hidden ? "opacity-60" : ""}`}>
            {m.repost
              ? (
                <div class="border-l-4 border-base-content/20 pl-2 mb-1 text-sm opacity-80">
                  <span class="font-semibold">{m.repost.authorName}</span>:{" "}
                  {m.repost.deleted
                    ? <span class="italic">削除されました</span>
                    : m.repost.body}
                </div>
              )
              : null}
            {m.body}
          </div>
          {/* Slack/Discord-style hover actions in the top-right of the post. */}
          <div class="absolute -top-2 right-2 z-10 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity join border border-base-300 bg-base-100 shadow-sm">
            {archived() ? null : (
              <button
                type="button"
                class="btn btn-ghost btn-xs join-item"
                aria-label="リアクション"
                mix={[on("click", () => {
                  paletteFor = paletteFor === m.id ? null : m.id;
                  handle.update();
                })]}
              >
                😀
              </button>
            )}
            <button
              type="button"
              class="btn btn-ghost btn-xs join-item"
              aria-label="返信"
              mix={[on("click", () => onPickupToNewThread(m.id))]}
            >
              ↩︎
            </button>
            {!archived() && mine
              ? (
                <button
                  type="button"
                  class="btn btn-ghost btn-xs join-item"
                  aria-label="編集"
                  mix={[on("click", () => onEdit(m.id, m.body))]}
                >
                  ✏️
                </button>
              )
              : null}
            {!archived() && canDelete
              ? (
                <button
                  type="button"
                  class="btn btn-ghost btn-xs join-item"
                  aria-label="削除"
                  mix={[on("click", () => onDelete(m.id))]}
                >
                  🗑
                </button>
              )
              : null}
          </div>
          {m.reactions.length > 0 || paletteFor === m.id
            ? (
              <div class="chat-footer flex flex-wrap gap-1 mt-1">
                {m.reactions.map((r) => (
                  <button
                    type="button"
                    class={`badge ${r.mine ? "badge-primary" : "badge-ghost"}`}
                    disabled={archived()}
                    mix={[on("click", () => onToggleReaction(m.id, r.emoji))]}
                  >
                    {r.emoji} {r.count}
                  </button>
                ))}
                {paletteFor === m.id
                  ? [...new Set([...recentEmojis, ...DEFAULT_EMOJIS])].map((
                    e,
                  ) => (
                    <button
                      type="button"
                      class="btn btn-xs"
                      mix={[on("click", () => onToggleReaction(m.id, e))]}
                    >
                      {e}
                    </button>
                  ))
                  : null}
              </div>
            )
            : null}
          {m.quotedIn.length > 0
            ? (
              <div class="chat-footer mt-1">
                <button
                  type="button"
                  class="badge badge-ghost badge-sm gap-1"
                  mix={[on("click", () => {
                    quotesFor = quotesFor === m.id ? null : m.id;
                    handle.update();
                  })]}
                >
                  💬 {m.quotedIn.length} 件のスレッドで引用
                </button>
                {quotesFor === m.id
                  ? (
                    <ul class="menu menu-xs bg-base-200 rounded-box mt-1">
                      {m.quotedIn.map((q) => (
                        <li key={q.threadId}>
                          <a
                            mix={[on("click", () => selectChannel(q.threadId))]}
                          >
                            <span class="truncate">{q.title}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )
                  : null}
              </div>
            )
            : null}
        </div>
      );
    };

    const threadGroup = (label: string, list: Thread[]) =>
      list.length === 0 ? [] : [
        <li key={`title-${label}`} class="menu-title">{label}</li>,
        ...list.map((t) => (
          <li key={t.id}>
            <a
              class={currentThreadId === t.id ? "active" : ""}
              mix={[on("click", () => selectChannel(t.id))]}
            >
              <span class="truncate">{t.title}</span>
            </a>
          </li>
        )),
      ];

    const sidebar = () => (
      <aside class="bg-base-200 w-72 min-h-full flex flex-col">
        <div class="p-3 border-b border-base-300">
          <a class="font-bold text-lg link link-hover" href="/homes">
            {homeName || "ホーム"}
          </a>
        </div>
        <ul class="menu w-full flex-1 overflow-y-auto flex-nowrap">
          <li>
            <a
              class={currentThreadId === null ? "active" : ""}
              mix={[on("click", () => selectChannel(null))]}
            >
              # メイン
            </a>
          </li>
          {threadGroup(
            "参加中",
            threads.filter((t) => !t.archivedAt && t.joined),
          )}
          {threadGroup(
            "未参加",
            threads.filter((t) => !t.archivedAt && !t.joined),
          )}
          {threadGroup("アーカイブ", threads.filter((t) => !!t.archivedAt))}
        </ul>
        <div class="p-2 border-t border-base-300">
          <button
            type="button"
            class="btn btn-ghost btn-sm w-full justify-start"
            aria-label="メニュー"
            mix={[on("click", openSettings)]}
          >
            ⚙ 設定
          </button>
        </div>
      </aside>
    );

    const settingsOverlay = () => (
      <div class="fixed inset-0 z-30 bg-base-100 overflow-y-auto">
        <div class="max-w-2xl mx-auto p-4 space-y-6">
          <div class="flex items-center justify-between">
            <h2 class="text-xl font-bold">設定</h2>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              aria-label="閉じる"
              mix={[on("click", closeSettings)]}
            >
              ✕
            </button>
          </div>

          {error
            ? (
              <div role="alert" class="alert alert-error alert-soft">
                <span>{error}</span>
              </div>
            )
            : null}

          <div class="card card-border bg-base-100">
            <div class="card-body">
              <h3 class="card-title text-base">自分の設定</h3>
              <label class="text-sm opacity-70">このホームでの表示名</label>
              <div class="join">
                <input
                  class="input input-bordered input-sm join-item flex-1"
                  value={nameDraft}
                  mix={[on<HTMLInputElement>("input", (e) => {
                    nameDraft = (e.target as HTMLInputElement).value;
                    handle.update();
                  })]}
                />
                <button
                  type="button"
                  class="btn btn-sm btn-primary join-item"
                  mix={[on("click", onSaveName)]}
                >
                  保存
                </button>
              </div>
              <div class="text-sm opacity-50 mt-2">
                スタンプの設定（未実装）
              </div>
              <div class="text-sm opacity-50">MCP 連携の設定（未実装）</div>
            </div>
          </div>

          {role === "admin"
            ? (
              <div class="card card-border bg-base-100">
                <div class="card-body">
                  <div class="flex items-center justify-between">
                    <h3 class="card-title text-base">ホームの設定</h3>
                    <button
                      type="button"
                      class={`btn btn-sm ${
                        homeSettingsOpen ? "btn-active" : ""
                      }`}
                      mix={[on("click", () => {
                        homeSettingsOpen = !homeSettingsOpen;
                        handle.update();
                      })]}
                    >
                      {homeSettingsOpen ? "閉じる" : "開く"}
                    </button>
                  </div>
                  {homeSettingsOpen ? homeSettings() : null}
                </div>
              </div>
            )
            : null}
        </div>
      </div>
    );

    const homeSettings = () => (
      <div class="space-y-4 mt-2">
        <div>
          <div class="flex items-center gap-2">
            <input
              class="input input-bordered input-sm flex-1"
              placeholder="追加するユーザーの userId"
              value={addUserId}
              mix={[on<HTMLInputElement>("input", (e) => {
                addUserId = (e.target as HTMLInputElement).value;
                handle.update();
              })]}
            />
            <button
              type="button"
              class="btn btn-sm"
              mix={[on("click", onAddMember)]}
            >
              メンバー追加
            </button>
          </div>
          <div class="mt-2">
            {inviteToken
              ? (
                <div class="alert alert-soft items-center gap-2">
                  <span class="text-sm">
                    招待コード（この画面を開いている間有効）:{" "}
                    <code>{inviteToken}</code>
                  </span>
                  <button
                    type="button"
                    class="btn btn-xs"
                    mix={[on("click", onCloseInvite)]}
                  >
                    閉じる
                  </button>
                </div>
              )
              : (
                <button
                  type="button"
                  class="btn btn-sm btn-outline"
                  mix={[on("click", onInvite)]}
                >
                  招待コードを発行
                </button>
              )}
          </div>
        </div>

        <table class="table table-sm">
          <thead>
            <tr>
              <th>ユーザー</th>
              <th>ロール</th>
              <th></th>
            </tr>
          </thead>
          <tbody>{members.map(memberRow)}</tbody>
        </table>

        <div>
          <h4 class="font-semibold text-sm">テーマ（カスタム CSS）</h4>
          <p class="text-xs opacity-60">
            url() や @import などのネットワーク取得は保存時に無効化されます。
          </p>
          <textarea
            class="textarea textarea-bordered font-mono text-sm w-full"
            rows={4}
            placeholder=".chat-bubble { background: #fde; }"
            value={themeDraft}
            mix={[on<HTMLTextAreaElement>("input", (e) => {
              themeDraft = (e.target as HTMLTextAreaElement).value;
              handle.update();
            })]}
          >
          </textarea>
          <button
            type="button"
            class="btn btn-sm btn-primary mt-1"
            mix={[on("click", onSaveTheme)]}
          >
            テーマを保存
          </button>
        </div>
      </div>
    );

    const memberRow = (m: Member) => {
      const canManage = role === "admin" && m.userId !== userId;
      return (
        <tr key={m.userId}>
          <td>
            {m.displayName}
            {m.isAgent ? <span class="badge badge-xs ml-1">agent</span> : null}
            <div class="text-xs opacity-60">{m.userId}</div>
          </td>
          <td>
            <span
              class={`badge badge-sm ${
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
                  <button
                    type="button"
                    class="btn btn-xs join-item"
                    mix={[on("click", () =>
                      onSetRole(
                        m.userId,
                        m.role === "admin" ? "member" : "admin",
                      ))]}
                  >
                    {m.role === "admin" ? "member に" : "admin に"}
                  </button>
                  <button
                    type="button"
                    class="btn btn-xs btn-error join-item"
                    mix={[on("click", () => onRemoveMember(m.userId))]}
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
        return <div class="alert alert-soft m-4">読み込み中…</div>;
      }
      if (!userId) {
        return (
          <div class="alert alert-soft m-4">
            <span>
              チャットを使うにはサインインが必要です。{" "}
              <a class="link" href="/signin">サインイン</a>
            </span>
          </div>
        );
      }
      return (
        <div class="drawer lg:drawer-open h-[100dvh]">
          {settingsOpen ? settingsOverlay() : null}
          <input id={DRAWER_ID} type="checkbox" class="drawer-toggle" />
          <div class="drawer-content flex flex-col min-w-0">
            <div class="flex items-center gap-2 p-2 border-b border-base-300">
              <label
                for={DRAWER_ID}
                class="btn btn-ghost btn-sm drawer-button lg:hidden"
                aria-label="スレッド一覧"
              >
                ☰
              </label>
              <h2 class="font-bold truncate flex-1">{channelTitle()}</h2>
              {currentThreadId &&
                  (currentThread()?.createdBy === userId || role === "admin")
                ? (
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    aria-label="スレッド名を編集"
                    mix={[on("click", () =>
                      onRenameThread(
                        currentThreadId!,
                        currentThread()?.title ?? "",
                      ))]}
                  >
                    ✏️
                  </button>
                )
                : null}
              {archived()
                ? <span class="badge badge-sm">アーカイブ（読み取り専用）</span>
                : null}
              {currentThreadId && currentThread()?.joined && !archived()
                ? (
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    mix={[on("click", () => onLeave(currentThreadId!))]}
                  >
                    退出
                  </button>
                )
                : null}
            </div>

            {error
              ? (
                <div role="alert" class="alert alert-error alert-soft m-2">
                  <span>{error}</span>
                </div>
              )
              : null}

            <div class="flex-1 overflow-y-auto p-4 space-y-2">
              {messages.length === 0
                ? <p class="opacity-60">まだメッセージがありません。</p>
                : messages.map(messageBubble)}
            </div>

            {archived()
              ? (
                <div class="alert alert-soft m-2">
                  <span>
                    このスレッドはアーカイブ済みです（読み取り専用）。
                  </span>
                </div>
              )
              : (
                <div class="join p-2 border-t border-base-300">
                  <input
                    class="input input-bordered join-item flex-1"
                    placeholder={`${channelTitle()} にメッセージを送信`}
                    value={newMessage}
                    mix={[on<HTMLInputElement>("input", (e) => {
                      newMessage = (e.target as HTMLInputElement).value;
                      handle.update();
                    })]}
                  />
                  <button
                    type="button"
                    class="btn btn-primary join-item"
                    mix={[on("click", onPost)]}
                  >
                    送信
                  </button>
                </div>
              )}
          </div>

          <div class="drawer-side z-10">
            <label for={DRAWER_ID} class="drawer-overlay" aria-label="閉じる">
            </label>
            {sidebar()}
          </div>
        </div>
      );
    };
  },
);
