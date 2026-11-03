# EN 公式予約サイト 本番公開チェックリスト

最終更新: 2026-11-03。すべて完了時に本番決済を有効化できます。

## A. 必須環境変数（Vercel）

| 変数 | 説明 |
|---|---|
| DATABASE_URL | Neon Postgres 接続文字列 |
| STRIPE_SECRET_KEY | Stripe 本番キー（sk_live_...） |
| STRIPE_WEBHOOK_SECRET | Webhook署名シークレット（whsec_...） |
| BOOKING_PAYMENTS_ENABLED | **true**（最後の安全装置。全項目完了まで設定しない） |
| ADMIN_KEY | 32文字以上のランダム値（HMAC鍵） |
| ADMIN_SEED | 管理者2名分: `表示名:ユーザー名:パスワード,表示名:ユーザー名:パスワード` |
| CRON_SECRET | ランダム値（cron保護） |
| EMAILJS_SERVICE_ID / EMAILJS_TEMPLATE_CUSTOMER / EMAILJS_TEMPLATE_OWNER / EMAILJS_TEMPLATE_THANKYOU / EMAILJS_PUBLIC_KEY / EMAILJS_PRIVATE_KEY / OWNER_EMAIL | メール設定 |

## B. 外部サービス設定

1. **Neon**: プロジェクト作成 → 接続文字列設定。テーブルは初回アクセス時に自動作成
2. **Stripe**: 本番アカウント → Webhook `https://<本番URL>/api/stripe-webhook` 登録
   （checkout.session.completed / checkout.session.expired / charge.refunded）
3. **EmailJS**: テンプレート3種（宿泊者向け確認 / 運営者通知 / お礼）
   変数: booking_id, guest_name, guest_kana, checkin, checkout, nights, adults, children,
   arrival_time, notes, options, online_paid, onsite_due, payment_method, total,
   facility_address, facility_tel, to_email ほか

## C. 未確定条件（運営者作業）

- [x] キャンセルポリシー承認済み（2026-11: Airbnb「普通」準拠・5日前15:00まで100%返金/以降1泊目無償+2泊目以降50%/チェックイン後は未宿泊分50%/24時間ルール）
- [ ] 事業者情報の法定表示（事業者名・所在地・電話・登録番号）
- [ ] 28泊以上の長期宿泊規約の承認（現状は27泊まで受付）
- [ ] プライバシーポリシー本文
- [ ] 16名利用時の寝具・空調条件の最終確認
- [ ] 既存Airbnb予約の日程確認 → 管理画面「受付停止」でブロック

## D. テスト状況

| テスト | 状態 |
|---|---|
| 単体・API（node:test） | 29/29 合格 |
| フォームE2E（モックAPI） | 21/21 合格 |
| 管理画面E2E（モックAPI） | 8/8 合格 |
| レスポンシブ（10幅+横向き） | 合格 |
| Stripe テストモード実決済 | **未実施**（キー設定後: 正常/失敗/離脱/重複Webhook/返金） |
| Neon 実DB並列予約 | **未実施**（DATABASE_URL設定後: 同時2リクエスト→1件のみ確定） |
| メール実送信 | **未実施**（EmailJSテンプレート作成後） |

## E. 公開前作業

1. `develop` → `main` マージ（Vercel が Production デプロイ）
2. 本番URLでフォーム表示・カレンダー・管理画面ログインを確認
3. Stripe テストモードキーで1件予約→キャンセル→返金を通す
4. `BOOKING_PAYMENTS_ENABLED=true` を設定（予約受付開始）
5. 公開後も BOOKING_PAYMENTS_ENABLED を外せば受付停止（決済のみ無効化）

## F. ロールバック

- Vercel ダッシュボード → Deployments → 直前の Production デプロイ →「Instant Rollback」
- 受付停止のみなら: `BOOKING_PAYMENTS_ENABLED` を削除（決済APIが503を返す）
- 緊急の日程停止は管理画面「受付停止」または直接 blocked_dates テーブル操作

## G. 監視

- Vercel Functions のログ（/api/stripe-webhook のエラーは再送されるため要監視）
- email_log の failed を管理画面で週次確認
