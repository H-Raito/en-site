# EN 予約システム 技術設計

## アーキテクチャ

```
[訪問者] → 静的サイト (site/index.html + js/booking.js)
              │ fetch
              ▼
       Vercel Functions (site/api/*, Node.js ESM)
              │
              ├─ Neon PostgreSQL (DATABASE_URL) ← 正本データ
              │    ※未設定時はメモリストア（開発専用・Vercel上では503）
              ├─ Stripe (Checkout + Webhook)
              └─ EmailJS REST (メール)

[運営者] → /admin/ (静的HTML) → /api/admin.js
```

## ディレクトリ

```
site/
├── index.html          # 予約フォーム含む公式サイト
├── admin/index.html    # 管理画面（認証後ダッシュボード）
├── js/booking.js       # フォームロジック（ESM・ブラウザ）
├── lib/                # サーバー共有ロジック
│   ├── pricing.js      # 料金・期限・返金計算（単一情報源）
│   ├── store.js        # ストアファクトリ（singleton）
│   ├── store-pg.js     # Postgres実装（トランザクション）
│   ├── store-memory.js # メモリ実装（開発・テスト専用）
│   ├── email.js        # EmailJS REST送信
│   ├── admin-auth.js   # 管理者認証・CSRF・試行制限
│   └── confirm.js      # 確定+メール送信の共通経路（冪等）
├── api/                # Vercel Functions
│   ├── availability.js # GET 空室夜・停止日
│   ├── quote.js        # POST サーバー見積り
│   ├── booking.js      # POST 予約作成+Checkout生成
│   ├── booking-status.js # GET 公開状態参照（限定フィールド）
│   ├── verify.js       # GET 決済戻り検証+確定
│   ├── stripe-webhook.js # POST 決済結果反映（正式経路）
│   ├── cron.js         # GET 期限解放・メール再送・お礼メール
│   └── admin.js        # GET/POST 管理ルーター
└── test/booking.test.mjs # node:test 29件
```

## データベーススキーマ

### bookings
| カラム | 型 | 説明 |
|---|---|---|
| id | TEXT PK | 予約番号 EN-XXXXXXXX-XXXX |
| request_id | TEXT UNIQUE | 冪等キー（再送で同一予約を再利用） |
| checkin/checkout | DATE | 半開区間 [in, out) |
| nights | INT | 泊数（サーバー計算） |
| adults | INT | 3歳以上の有料人数 |
| infants | INT | 2歳以下（無料・上限5） |
| guest_* | TEXT | 宿泊者情報（住所は任意） |
| arrival_time | TEXT | 到着予定 |
| notes | TEXT | 要望（500字） |
| options | JSONB | {bbq, sauna, earlyCheckin} |
| price_jpy | INT | オンライン決済額（=Stripe請求額） |
| price_detail | JSONB | 内訳（perNight/stay/options/on-site/人数/泊数） |
| payment_method | TEXT | online / onsite / manual |
| options_online | INT | オンライン決済オプション額 |
| options_onsite | INT | 現地支払予定額 |
| online_total | INT | オンライン決済額（=price_jpy） |
| onsite_amount | INT | 現地支払予定額 |
| status | TEXT | 状態（下記参照） |
| stripe_session_id | TEXT UNIQUE | Checkout Session |
| payment_intent_id | TEXT | 決済Intent |
| refund_id / refund_amount | | 返金記録 |
| email_status | TEXT | pending/sent/failed/skipped |
| thankyou_sent | TEXT | お礼メール状態 |
| admin_memo | TEXT | 管理メモ |
| source | TEXT | web / manual |
| expires_at | TIMESTAMPTZ | 仮予約期限 |

### blocked_dates
date PK / reason

### settings
key PK / value JSONB（cancellationPolicyText など）

### email_log / admin_log
送信記録・管理操作記録

### admin_users
username PK / name / pass_hash（scrypt salt:hash）

## 予約状態遷移

```
pending_payment ──Webhook(paid) or verify(paid)──▶ confirmed ──返金──▶ refunded
       │                                              │
       ├─30分経過/Checkout失効──▶ expired              └─管理キャンセル──▶ cancelled
       └─Stripe生成失敗────────▶ cancelled
```

確定遷移は冪等: confirmBooking は pending_payment からのみ confirmed へ。
返金は updateBookingIfConfirmed（confirmed からのみ）で二重返金を排他。

## API一覧

| 経路 | メソッド | 認証 | 機能 |
|---|---|---|---|
| /api/availability | GET | なし | 空室夜・停止日・paymentsEnabled |
| /api/quote | POST | なし | 料金見積り（空室照合含む） |
| /api/booking | POST | なし | 予約作成+Checkout URL発行 |
| /api/booking-status | GET | なし | 限定フィールドの状態参照 |
| /api/verify | GET | なし | 決済戻り検証+確定 |
| /api/stripe-webhook | POST | 署名検証 | 決済結果反映 |
| /api/cron | GET | CRON_SECRET | 期限解放・メール再送・お礼メール |
| /api/admin.js | GET/POST | 管理者認証 | 管理操作全般 |

## 排他制御（二重予約防止）

createPendingBooking は Postgres トランザクション内で:
1. 対象期間と重複するアクティブ予約を行ロック（`FOR UPDATE`）
2. 期間内の受付停止日を照合
3. 競合があれば 'unavailable' でロールバック
4. 競合なしなら INSERT（pending_payment・expires_at=now()+30分）

アクティブ = confirmed または (pending_payment かつ expires_at > now())。
期限判定はクエリごとに行うため、Cron遅延でも整合する。
メモリストアは直列化ミューテックスで同等の排他を提供（テスト専用）。

## セキュリティ

- 秘密は全て環境変数（STRIPE_SECRET_KEY / ADMIN_KEY / ADMIN_SEED / EMAILJS_* / DATABASE_URL）
- 管理画面: 管理者ごとのユーザー名+scryptパスワード（ADMIN_SEEDからシード）
  - HttpOnly + Secure + SameSite=Lax クッキー（8時間・HMAC署名）
  - ログイン試行制限（5回/15分/ユーザー名）
  - CSRF: 変更系POSTに X-Requested-With ヘッダ必須
  - 監査ログ（login_failed/success、返金、キャンセル等を記録）
- 個人情報はDBのみ。Stripe metadataは予約IDのみ
- 予約状態参照は限定フィールド+名前マスク
- 本番決済は BOOKING_PAYMENTS_ENABLED=true かつ STRIPE_SECRET_KEY 設定時のみ有効

## 外部サービス

| サービス | 用途 | 環境変数 |
|---|---|---|
| Neon Postgres | 予約データ | DATABASE_URL |
| Stripe | 決済・返金 | STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET |
| EmailJS | メール | EMAILJS_SERVICE_ID / EMAILJS_TEMPLATE_CUSTOMER / EMAILJS_TEMPLATE_OWNER / EMAILJS_TEMPLATE_THANKYOU / EMAILJS_PUBLIC_KEY / EMAILJS_PRIVATE_KEY / OWNER_EMAIL |
| Vercel Cron | 定期メンテ | CRON_SECRET |

## 既知の制約

- テストモードでの実決済E2EはStripeキー設定後に実施
- Neon実DBでの並列予約テストはDATABASE_URL設定後に実施（メモリストアで論理検証済み）
