# EN サイト 写真ガイド（2026-10-31 更新）

サイトの全写真は **`/Users/raito/Downloads/EN_Photo`（実写20枚）由来**です。
`site/image/` に用途別のsemantic名でWebP変換して配置しています。

## ファイル対応表（site/image/）

| ファイル | 元写真 | 内容 | 使用位置 |
|---|---|---|---|
| entrance.webp (941×1672縦) | 8BDFB23A-…PNG | 暖簾の玄関 | HERO(SP)1枚目 / GALLERY#01 |
| living.webp (1440×1080) | IMG_5102 | 明るいリビング・ダイニング | HERO(PC)1枚目 / ROOMS01 / GALLERY#02 |
| bedroom-wide.webp (1086×1448縦) | ADE5F185-…PNG | 明るい寝室 | HERO 2枚目(PC/SP) / ROOMS02 / GALLERY#04 |
| bedroom-warm.webp (1086×1448縦) | 3E08051C-…PNG | 和みの寝室 | GALLERY#05 |
| kitchen.webp (1440×1080) | IMG_6006 | キッチン（冷蔵庫・コンロ） | ROOMS03 / GALLERY#03 |
| bathroom.webp (1440×1080) | IMG_5650 | 浴室 | ROOMS04 / GALLERY#06 |
| vanity.webp (1440×1080) | IMG_5647 | 洗面 | GALLERY#07 |
| toilet.webp (1440×1080) | IMG_5660 | トイレ1（レンガ壁） | GALLERY#08 |
| toilet-warm.webp (1440×1080) | IMG_5659 | トイレ2（間接照明） | GALLERY#09 |
| lounge.webp (1440×1080) | IMG_6026 | ラウンジ | GALLERY#10 |
| garden.webp (2000×2667縦) | IMG_7539 | 庭全体 | ROOMS05 / GALLERY#11 |
| house-flowers.webp (1440×1080) | IMG_7335 | ペルゴラ越しの建物 | CONCEPT |
| og-image.jpg | IMG_5102 | OGP用 | SNSシェアカード |

## 重要な変換ルール

- **EXIF orientation注意**: iPhone写真（特にIMG_7539/7546系の大型JPG）は保存ピクセルと
  表示向きがズレている場合がある。cwebp 1.6はEXIF orientationを適用しないため、
  **変換前に `sips -r 90` などで回転を焼き込むこと**（garden.webpはこの修正を適用済み）。
  変換後は必ず `webpinfo` で実寸法を確認する。
- 変換コマンド例: `cwebp -quiet -q 85 [-resize 2000 0] 元.jpg -o 出力.webp`
- **テントサウナの実写真は存在しない**ため、サウナは文字紹介のみ。
- 差し替えは同じsemantic名での上書き推奨（HTML変更不要）。

## HERO構成

- PC（769px以上）: living → bedroom-wide（落ち着いた背景で文字可読性が高い組み合わせ）
- SP（768px以下）: entrance → bedroom-wide
- 庭・ラウンジ・建物写真は文字可読性の検証で不合格だったためHERO不使用（ギャラリーで見せる）

## GALLERY

11枚。宿泊体験の理解順（玄関→リビング→キッチン→寝室→浴室→洗面→トイレ1→トイレ2→ラウンジ→庭）。
自然比率の横スクロールストリップ。**初期表示は必ず#01から**（scroll-paddingでスナップ位置を
paddingに整合させ、initでscrollLeft=0を強制、bfcache復帰時もリセット）。
トイレは実在2室のため2枚掲載（トイレ1/トイレ2としてラベルで意図を明示）。
