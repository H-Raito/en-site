# EN 直接予約システム セットアップ手順（運営者向け）

このドキュメントは、公式サイトの直接予約・決済・空室管理を本番稼働させるために
運営者が実施する設定をまとめたものです。**すべて完了するまで本番決済は有効になりません**
（コード側で安全装置が効いています）。

## システム構成

- 予約フォーム（4ステップ）→ `/api/booking` → 空室確保（30分仮押さえ）→ Stripe Checkout
- 決済結果は **Stripe Webhook** が正式経路（ブラウザが戻らなくても確定）
- 予約データは **Neon Postgres**（`DATABASE_URL`）に保存
- 確認メールは **EmailJS REST**（サーバー送信・ブラウザ非依存）
- 管理画面: `https://<サイト>/admin/`（ユーザー名とパスワードでログイン。アカウントは ADMIN_SEED から初期投入）

## 本番稼働までのチェックリスト

### 1. データベース（Neon Postgres）

1. https://neon.tech でアカウント作成・プロジェクト作成
2. 接続文字列を取得（`postgresql://...`）
3. Vercel の環境変数 `DATABASE_URL` に設定
4. 初回アクセス時にテーブルは自動作成されます（bookings / blocked_dates / settings / email_log / admin_log）

### 2. Stripe

1. Stripe ダッシュボードでアカウント作成・本人確認
2. テストモードで動作確認（テストカード 4242 4242 4242 4242）
3. 本番キー（`sk_live_...` / `pk_live_...`）を取得
4. Webhook エンドポイントを登録: `https://<サイト>/api/stripe-webhook`
   - イベント: `checkout.session.completed` / `checkout.session.expired` / `charge.refunded`
   - 発行された署名シークレット（whsec_...）を `STRIPE_WEBHOOK_SECRET` に設定
5. Vercel 環境変数: `STRIPE_SECRET_KEY`（sk_live_...）, `STRIPE_WEBHOOK_SECRET`

### 3. 予約メール（EmailJS）

1. EmailJS でテンプレートを2つ作成（宿泊者向け / 運営者向け）
2. テンプレート変数: `{{booking_id}} {{guest_name}} {{checkin}} {{checkout}} {{nights}} {{adults}} {{children}} {{total}} {{options}} {{arrival_time}} {{notes}} {{facility_address}} {{facility_tel}} {{to_email}}`
3. Vercel 環境変数: `EMAILJS_SERVICE_ID` `EMAILJS_TEMPLATE_CUSTOMER` `EMAILJS_TEMPLATE_OWNER` `EMAILJS_TEMPLATE_THANKYOU`（チェックアウト翌日のお礼メール用） `EMAILJS_PUBLIC_KEY` `EMAILJS_PRIVATE_KEY` `OWNER_EMAIL`

### 4. 管理・運用

1. `ADMIN_KEY`（32文字以上のランダム文字列・署名鍵として使用）を Vercel に設定
2. `ADMIN_SEED`（`表示名:ユーザー名:パスワード,...` 形式）を Vercel に設定 → `/admin/` にユーザー名とパスワードでログイン
3. 運営者ダッシュボードで: 予約一覧 / カレンダー / 受付停止 / 手動予約 / キャンセル・返金・入金記録 / メール再送
4. `CRON_SECRET`（ランダム文字列）を Vercel に設定 → Vercel Cron が毎日自動実行（期限解放・メール再送・お礼メール）。手動実行は `Authorization: Bearer <CRON_SECRET>` ヘッダ付きで呼ぶ
5. `SITE_URL`（`https://en-kyoto.vercel.app`）を Vercel に設定 → Stripeの決済後の戻り先URLを確定する

### 5. 料金・ポリシーの確定（最重要）

**料金は運営者承認済みの確定値です**（仕様書 docs/en/SPECIFICATION.md と同一）:

- 1泊基本料金（現在の初期値: 48,000円・4名まで）
- 追加人数料金（現在の初期値: 5名目から6,000円/名）
- 最大人数の扱い（16名 / エアコン4部屋のみは13名まで）
- キャンセルポリシー（管理画面「設定」タブから文面を登録すると予約確認画面に表示されます）
- 事業者情報の法定表示（事業者名・所在地・登録番号等）

確定後、`site/lib/pricing.js` の数値を更新してデプロイしてください。

### 6. 本番決済の有効化

すべて確定後、Vercel に環境変数を設定:

```
BOOKING_PAYMENTS_ENABLED=true
```

これが設定されるまで、予約フォームは動作しますが決済ページには進めず、
「準備中です。お電話で…」と表示されます（安全装置）。

## 移行（Airbnb）

- Airbnbの既存予約は、管理画面「受付停止」で該当日程をブロックして二重予約を防いでください
- 電話予約は「手動予約」から確定状態で登録できます
- Airbnb掲載の停止自体は、移行完了を確認してから手動で行ってください（本システムは自動実行しません）

## セキュリティ

- 秘密鍵（STRIPE_SECRET_KEY / ADMIN_KEY / ADMIN_SEED / EMAILJS_PRIVATE_KEY）は Vercel 環境変数でのみ管理。管理画面にはユーザー名とパスワードでログインする（鍵を人に渡さない）
- 管理APIは全操作でサーバー側認証（x-admin-key / 署名付きクッキー）
- 個人情報は自社データベースにのみ保存（Stripe metadataには予約IDのみ）
