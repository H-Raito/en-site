# EN サイト 写真ガイド（2026-10-28 更新）

実写真19枚（`EN_19_sharpened_complete.zip` の `website_webp/`）を `site/image/` に配置しています。
対応表は ZIP 同梱の `image_manifest.csv` / `image_manifest.json` が正本です。

## 配置ルール

- 19枚すべて `site/image/` 直下に実ファイル名のまま配置。
- `og-image.jpg` のみ SNS/OGP 用に `16_house_flowers.jpg`（高画質JPEG）の複製。
- **テントサウナの実写真は存在しない**ため、サウナは文字での紹介のみ。仮写真・AI画像は使用禁止。
- 写真の差し替えは、同じ実写真で同じファイル名を上書きする方法で行う（HTML変更不要）。
- 差し替え時は `image_manifest.csv` の内容（何が写っているか）に沿って alt / キャプションを必ず更新する。

## HERO の使い分け

- PC（769px以上）: `16_house_flowers` → `06_living_projector` → `13_rose_garden` → `04_kitchen_island`
- スマホ（768px以下）: `01_entrance` → `09_flower_kitchen` → `02_garden_bench` → `10_bedroom_warm`

切り替えは `style.css` の `.hero__slide--a〜d` とメディアクエリで行う。画像ファイル自体は加工しない。

## GALLERY

19枚を manifest の `gallery_position` 順で掲載。キャプションは写っている内容と一致させること
（トイレ写真を「キッチン」と表示するなどの誤ラベルは禁止）。

## ローカル確認と反映

```bash
cd site && python3 -m http.server 9000
# http://localhost:9000 を開いて確認
```

push 後、Vercel が自動デプロイする。
