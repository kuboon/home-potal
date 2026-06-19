# セッション引き継ぎメモ (home portal / ホムポタ)

設計（Claude アーティファクト: Discord ライク + MCP で AI
をネイティブ参加者に）を **Deno + Remix v3 + Deno Deploy**
で実装してきた作業の引き継ぎ。設計の全スコープを一巡 した。

## 現状（PR 状況）

main にマージ済み（#1〜#13）:

| PR  | 内容                                                                                       |
| --- | ------------------------------------------------------------------------------------------ |
| #1  | 基盤（Deno workspaces、Turso データ層、パスキー認証=id.kbn.one 委譲+DPoP、CI/デプロイ）    |
| #2  | Home / メンバー管理（admin/member、userId 指定で追加・削除）                               |
| #3  | Thread / Message（作成・一覧・投稿・表示）                                                 |
| #4  | リアルタイム配信（SSE + Deno KV watch、`sync` ping で再取得）                              |
| #5  | メッセージ編集・削除（tombstone、編集マーク）                                              |
| #6  | Repost（引用ピックアップ・リンク平坦化）                                                   |
| #7  | レート制限（投稿 1/秒・20/分、Repost 5/分、KV 固定ウィンドウ）                             |
| #8  | 招待トークン（管理者画面表示中のみ有効・60秒 TTL・コード参加）                             |
| #9  | スレッド自動アーカイブ（7日無投稿で読み取り専用）                                          |
| #10 | CSS テーマ（home admin、url()/@import 等を無効化）                                         |
| #11 | スタンプ（リアクション、1投稿5個まで、LRU 履歴）                                           |
| #12 | Web Push 購読（`/sw.js` + 端末管理、id.kbn.one push API 委譲）                             |
| #13 | サーバ起点 Web Push 配信（`POST /rp/notifications` を private_key_jwt で、指数バックオフ） |

**未マージ（レビュー/マージ待ち、CI は両方 green）**:

- **#14 エージェント・アカウント**（`claude/agents`）— `is_agent` ユーザー作成 +
  Bearer トークン発行、`/agents` UI、`/api/agents`
- **#15 MCP サーバ**（`claude/mcp-server`、#14 の上にスタック）— `POST /mcp`
  JSON-RPC、Bearer 認証、Web UI 同等ツール

> **マージ順は #14 → #15**。#14 を main にマージすると #15 の base は自動で main
> にリターゲットされる。

## デプロイ時の残作業（コード外・要対応）

1. `home.kbn.one` を **Deno Deploy** にデプロイ。entrypoint
   `server/router.ts`、build `deno task bundle`、本番 Turso に
   `deno task migrate`。env: `IDP_ORIGIN` / `RP_ORIGIN=https://home.kbn.one` /
   `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`。
2. `https://home.kbn.one` を **IdP (id.kbn.one) の `AUTHORIZE_WHITELIST`**
   に登録（push のサーバ送信 = RP client assertion 検証のため。IdP は
   `https://home.kbn.one/.well-known/jwks.json` から検証鍵を取得）。
3. **id.kbn.one 側**: `POST /push/notifications` の DPoP
   必須は実装ミス（本人専用向け）。サーバ起点は
   `POST /rp/notifications`（private_key_jwt）を使う方に統一済み。DPoP
   の件は別途修正予定とのこと。

## 既知の古い記述（次に直すと良い）

- **`README.md`** が古い:
  「現状は基盤までの実装です」と書いてあるが、実際は全機能実装済み。タスク表の
  `deno task test` 説明も「DB 必須テストは未設定時 skip」と古い（現在は
  `:memory:` で実行）。`CLAUDE.md` のスコープ節が最新なので README
  を追従させる。
- `CLAUDE.md` のスコープ節は #14/#15 のマージ後に「MCP
  サーバまで実装済み」に更新する（#15 ブランチでは更新済み）。

## 設計判断・注意点（次のセッションで効く文脈）

- **認証**: パスキーは id.kbn.one に委譲。ブラウザは `@kuboon/dpop` の
  `fetchDpop` で IdP を直叩き（`client/session.ts` の `ensureSession`）。home
  portal 側は DPoP セッション middleware で
  thumbprint→userId。`users.id = IdP userId`。
- **エージェント認証は別系統**: home portal 発行の Bearer
  トークン（`hpa_…`、ハッシュのみ保存）。MCP は DPoP ではなくこの
  Bearer。承認フローは v1 では**省略**（エージェントは所属 home
  のロールに従って直接操作。設計の「非管理者は承認待ち」は後続）。
- **ストレージ**: ドメインデータ =
  Turso（libSQL）。セッション/シグナル/レート/バックオフ/招待/RP鍵 = Deno KV。
  - Turso クライアントは URL で実装切替（`packages/db/client.ts`）:
    `:memory:`/`file:` はネイティブ `@libsql/client`、`http(s)`/`libsql`
    はエッジ安全な `@libsql/client/web`。**本番は HTTP**。
- **権限分離（重要）**: `packages/db` の deno.json は `:memory:` ネイティブ
  libSQL のため env/ffi/sys 等を広く許可。`server` は本番 serve を tight
  に保つため許可は最小（env 4個 + net + read）。
  - 帰結: **server メンバーのテストは Turso(:memory:) を触れない**。MCP の
    `server_test.ts` は意図的に DB 非依存（JSON-RPC glue + ToolError→isError
    のみ）。tool の実 DB 挙動は db 層テストで担保。
  - ローカルで `deno serve` に `TURSO_DATABASE_URL=:memory:` を渡すと、DB
    を触る経路（例: `/mcp` の bad-token→`getAgentIdByToken`）が tight
    権限下でネイティブ libSQL を呼べず 500 になる。これは**ローカル probe
    の環境要因**。本番（HTTP Turso）では正しく 401。
- **リアルタイム**: `/api/threads/:id/stream` は SSE。変更ごとに `sync` ping
  を送り、クライアントが再取得（新着/編集/削除/リアクションを一律反映）。EventSource
  は DPoP ヘッダを送れないので `fetchDpop` でボディをストリーム読み。
- **Remix v3**: `@remix-run/fetch-router` + `@remix-run/ui`（clientEntry /
  Frame）。bundler は `Deno.bundle` で client を
  `server/bundled/*.js`、Tailwind/daisyUI を `style.css`、`sw.js` をコピー。

## 検証コマンド

```bash
deno task check   # deno check + lint + fmt --check
deno task test    # ユニットテスト（DB テストは :memory:）
deno task bundle  # client/CSS/sw.js を server/bundled/ へ
deno task dev     # bundle + deno serve --watch（要 turso dev + .env）
```

最終のローカルテストは 48 passed（#15 ブランチ時点）。

## 後続アイデア（未着手）

- MCP の**承認フロー**（非管理者エージェントの操作を管理者承認: pending キュー +
  UI）。
- メッセージ編集の設計挙動（編集はスレッド末尾へ移動 + 後方参照マーカー）—
  現状はその場更新 + 編集マーク。
- スレッドの**アンアーカイブ**、別スレッドを選んでの **Repost
  UI**（現状は現在スレッドへ）。
- エージェントのデモ実装（MCP クライアントから実際に投稿する例）。
- README 更新、サーバ起点 push の本番 E2E 確認。

## ブランチ

- 作業ブランチは機能ごと（`claude/<feature>`）。各 PR は main から分岐（#15 のみ
  #14 にスタック）。
- このメモは `claude/session-handoff` から PR。
