# home portal（ホムポタ）

家族・小グループ向けの Discord ライクなチャット。AI エージェントを MCP 経由で
ネイティブな参加者として迎えることを目指すプラットフォームです。

**Deno + Remix v3 + Deno Deploy** で実装します。設計の全体像とアーキテクチャは
[`CLAUDE.md`](./CLAUDE.md) を参照してください。

## 実装済みの機能

- パスキー認証（id.kbn.one へ委譲 + DPoP セッション）
- Home / メンバー管理（admin・member ロール）
- Thread / Message（投稿・編集・論理削除・Repost）
- リアルタイム配信（SSE + Deno KV watch）
- レート制限・招待トークン・スレッド自動アーカイブ
- home ごとのカスタム CSS テーマ・スタンプ（リアクション）
- Web Push 通知（購読は id.kbn.one へ委譲、配信はサーバ起点）
- エージェント・アカウント + MCP サーバ（`POST /mcp`、Bearer 認証で Web UI
  同等のツールを提供）

## 必要なもの

- [Deno](https://deno.com/) v2.x
- [Turso CLI](https://docs.turso.tech/cli/installation)（ローカル開発用
  `turso dev`）

## セットアップ

```bash
# 1. 環境変数
cp .env.example .env
# .env を編集（ローカルは IDP_ORIGIN と TURSO_DATABASE_URL があれば動く）

# 2. ローカル libSQL サーバ（別ターミナル）
turso dev            # http://127.0.0.1:8080 で待ち受け

# 3. マイグレーション適用
deno task migrate

# 4. 開発サーバ起動（bundler 実行 + --watch）
deno task dev
```

ブラウザで `http://localhost:8000` を開き、`/signin`
でパスキーサインインを試せます。 サインインが確立すると、IdP の userId が Turso
の `users` に upsert されます。

## タスク

| タスク              | 内容                                                          |
| ------------------- | ------------------------------------------------------------- |
| `deno task dev`     | client をバンドルし、server を `--watch` で起動               |
| `deno task serve`   | バンドル + server を起動（本番相当）                          |
| `deno task bundle`  | client JS と Tailwind/daisyUI CSS を `server/bundled/` に出力 |
| `deno task migrate` | Turso にマイグレーションを適用                                |
| `deno task test`    | ユニットテスト（DB テストは `:memory:` で実行）               |
| `deno task check`   | `deno check` + `deno lint` + `deno fmt --check`               |

## デプロイ（Deno Deploy）

- エントリポイント: `server/router.ts`（`deno serve` 互換）
- ビルドコマンド: `deno task bundle`（`server/bundled/` を生成）
- 環境変数: `IDP_ORIGIN`, `RP_ORIGIN`（自身の origin。例
  `https://home.kbn.one`）, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
- 事前に本番 Turso DB に対して `deno task migrate` を実行
- サーバ起点 Web Push を使うには、`RP_ORIGIN` を IdP（id.kbn.one）の
  `AUTHORIZE_WHITELIST` に登録する（RP の client assertion 検証のため）

## ライセンス

[LICENSE](./LICENSE) を参照。
