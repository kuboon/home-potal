# home portal（ホムポタ）

家族・小グループ向けの Discord ライクなチャットプラットフォーム。AI
エージェントを MCP 経由でネイティブな参加者として統合することを目指す。**Deno +
Remix v3 + Deno Deploy** で実装する。

参考実装: https://github.com/kuboon/deno-remix-reference

## 構成（Deno workspaces）

client / server を分離した Deno workspaces。

- `server/` — Remix v3 (fetch-router) サーバ。`deno serve ./router.ts` で起動。
  - `routes.ts` ルート定義 / `router.ts` 配線 / `controllers/` 各エンドポイント
  - `ui/document.tsx` 永続シェル + `<Frame>` / `utils/render.tsx` レンダリング
  - `middleware/dpop.ts` DPoP セッション middleware の組み立て
- `client/` — ブラウザ実行コード。`hydration.ts`（フレーム遷移 + clientEntry の
  ハイドレーション）、`signin_card.tsx`（パスキーサインイン UI）。
- `bundler/` — `Deno.bundle` で client を `server/bundled/*.js`
  に、Tailwind/daisyUI を `server/bundled/style.css` にビルド。
- `packages/db/` — Turso (libSQL) データ層。`client.ts` / `migrate.ts` /
  `migrations/` / `users.ts` / `homes.ts`（Home・メンバーシップ）/ `threads.ts`
  （Thread・Message）。
- `packages/session-storage-kv/` — `@remix-run/session` の `SessionStorage` を
  `KvRepo` で実装（reference から取り込み）。
- `packages/remix-dpop-session-middleware/` — DPoP セッション
  middleware（reference から取り込み）。

## 認証・ストレージ方針

- 認証: パスキーは **id.kbn.one (IdP) に委譲**。home portal は DPoP セッション
  middleware で thumbprint にユーザーを紐づける。DPoP proof は
  [jsr:@kuboon/dpop](https://jsr.io/@kuboon/dpop) を利用。
- ドメインデータ（`users` ほか後続の home/thread/message…）= **Turso
  (libSQL)**。
- セッション = **Deno KV**（`@kuboon/kv` +
  `session-storage-kv`）。リアルタイム配信は **SSE + Deno KV
  watch**（`server/realtime.ts`）。メッセージは Turso が真実の源で、 KV
  はスレッド単位の変更シグナルにのみ使う。

## 環境変数

- `IDP_ORIGIN` — IdP の origin（既定 `https://id.kbn.one`）
- `TURSO_DATABASE_URL` — libSQL エンドポイント。ローカルは `turso dev`
  （`http://127.0.0.1:8080`）
- `TURSO_AUTH_TOKEN` — 本番の認証トークン（ローカル `turso dev` では不要）

## 開発

```bash
deno task dev       # bundler 実行 + server を --watch 起動
deno task migrate   # Turso にマイグレーション適用（.env 必要）
deno task test      # ユニットテスト（DB テストは :memory: で実行）
deno task check     # deno check + lint + fmt --check
```

## コーディング規約

- Deno ファースト（Web API 優先、Node.js API は必要最小限）
- TypeScript strict mode
- テストは `Deno.test()` + `@std/assert`、ファイル名はスネークケース（例:
  `users_test.ts`）

## スコープ（段階的実装）

**基盤**（雛形・データ層・認証・CI/デプロイ）+ **Home /
メンバー管理**（作成・一覧・ admin/member ロール・メンバー追加(userId
指定)/削除）+ **Thread / Message**（スレッド作成・一覧、メッセージ投稿・表示）+
**リアルタイム配信**（SSE + Deno KV watch
で新着メッセージを即時表示）まで実装済み。後続で Repost / 招待トークン /
エージェント・MCP / Web Push 通知 / モデレーション / アーカイブ / CSS テーマ /
スタンプ を積み上げる。
