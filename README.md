# EN 公式サイト・直接予約システム

京都府福知山市の一棟貸し宿「EN」の公式サイトと、Airbnb非依存の直接予約システムです。
本番: https://en-kyoto.vercel.app

## 構成

| 領域 | 内容 |
|---|---|
| `site/` | 正本。静的サイト（単一ページ + 予約フォーム）+ Vercel Functions（`site/api/`） |
| `site/lib/` | 料金・キャンセル返金計算、データストア、認証、メール送信などの共通ロジック |
| `site/test/` | node:test による自動テスト（料金・返金区分・二重予約防止・API・INSERT文の整合性） |
| `docs/en/` | 仕様書・技術設計・公開チェックリスト（正本ドキュメント） |
| ルート直下のNext.js関連ファイル | 放棄された初期プロトタイプ。`.gitignore` 対象でリポジトリには含まれない |

本番では `site/` 配下のみがデプロイ対象です（`site/vercel.json` で制御）。

## 技術スタック

- フロントエンド: 静的HTML/CSS/JS（フレームワークなし）
- API: Vercel Functions（Node.js ESM）
- データベース: Neon Postgres（@neondatabase/serverless の Pool・pg互換API）
- 決済: Stripe Checkout + Webhook（冪等設計）
- メール: EmailJS REST API（サーバー送信・DB記録と再送機能付き）
- テスト: node:test（`npm test` で実行・件数はテスト実行結果を参照）

## セットアップ

```bash
cd site
npm install
npm test
```

テストは実DB・実Stripe・実メールに依存しない（メモリストア+プレースホルダキー）ため、
シークレットなしで実行できます。

## コードリーディングのポイント

- 料金・キャンセルポリシーは `site/lib/pricing.js` に一元管理
- 二重予約防止はトランザクション内の `pg_advisory_xact_lock` による直列化 + 半開区間 [checkin, checkout) 照合
- 決済は Webhook を正式確定経路とし、verify API と冪等に二重化
- 管理画面（`/admin/`）: 予約一覧・月表示カレンダー・受付停止・手動予約・入金記録・売上分析

## デプロイ

GitHub への push で Vercel が自動デプロイします:
- `main` → 本番（en-kyoto.vercel.app）
- `develop` → Preview デプロイ（Vercel Authentication 保護付きURL）

## 環境変数

運営者向けの手順は `site/BOOKING_SETUP.md` を参照。
秘密値はリポジトリに含めない運用です（`.env*` はgitignore済み・`site/.env.example` はプレースホルダのみ）。
実値は Vercel 環境 DATABASE_URL / STRIPE_* / ADMIN_SEED / ADMIN_KEY / EMAILJS_* / CRON_SECRET で管理。

## 開発フロー

1. `develop` ブランチで実装・検証（`npm test`+実機検証）
2. テスト合格後に `main` へ fast-forward マージ
3. Vercel 本番デプロイを確認

## 文書

- 仕様書: `docs/en/SPECIFICATION.md`
- 技術設計: `docs/en/TECHNICAL_DESIGN.md`
- 公開チェックリスト: `docs/en/LAUNCH_CHECKLIST.md`
- 運営者向け本番化手順: `site/BOOKING_SETUP.md`
- 写真管理: `site/PHOTO_GUIDE.md`
