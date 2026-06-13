# ①課題名
OshiLog ver3（API連携版・推し活参戦ログアプリ）

## ②課題内容（どんな作品か）
推し活の現地参戦ログを、タイムラインとマップで振り返れる1ページアプリです。

今回の課題テーマであるAPI利用として、以下の2つの外部APIを組み合わせてアプリをアップデートしました。

- Nominatim API: 会場名・都市名から緯度経度を取得するジオコーディング
- Google Cloud Translation API: カタカナ入力の会場名・地名を英語へ翻訳し、Nominatimで検索しやすくする補助

都市名から緯度経度を判定し、Leafletの地図上にピンとして表示します。タイムラインでログを選択すると、対応する地図ピンへズームします。

## ③アプリのデプロイURL
https://zakatsu.github.io/OshiLog3/

## ④アプリのログイン用IDまたはPassword（ある場合）
なし

## ⑤工夫した点・こだわった点
- 機能面
  - Nominatim APIで会場名・都市名から緯度経度を検索し、より正確な場所にピンを表示
  - Google Cloud Translation APIでカタカナ入力を英語へ翻訳し、海外会場名でも座標検索しやすくした
  - 座標検索に失敗した場合は、`cities.json` の都市代表座標へ自動でフォールバック
  - 座標検索と翻訳の結果はブラウザのLocalStorageにキャッシュし、同じ会場でAPIを繰り返し呼ばないようにした

## ⑥難しかった点・次回トライしたいこと（又は機能）
- Nominatim APIは無料で使える一方、公開サーバーは小規模利用向けなので、入力中の自動検索ではなく、登録・更新時に1回だけ呼び出す形にした
- Google Cloud Translation APIのAPIキーはフロントから参照されるため、課題用としてローカルファイルに置き、GitHub Pages上では動かない前提にした
- APIを2段階で使うため、Nominatim検索失敗時だけ翻訳APIを呼び、その翻訳結果で再検索する流れにした
- ログのエクスポート・インポート機能を追加して、バックアップできるようにしたい

## ⑦フリー項目（感想、シェアしたいこと等なんでも）
- ver1のローカル保存型から、ver2ではFirebase保存型へ変更し、ver3で地図の参照データをAPI取得する形で、徐々に進化することが体感できた

## ⑧利用APIと注意点

今回のアップデートでは、Nominatim APIとGoogle Cloud Translation APIの2つを利用しています。通常はNominatim APIだけで座標検索し、見つからない場合のみGoogle Cloud Translation APIで入力文を英語へ翻訳してから再検索します。

### Nominatim API

会場名・都市名から緯度経度を取得するために、OpenStreetMap系のジオコーディングAPIであるNominatim APIを利用しています。登録・更新時に座標を検索し、取得した緯度経度はFirestoreの参戦ログに保存します。地図表示自体はLeafletで行います。

会場名・地名をカタカナで入力した場合は、Nominatimで見つからないことがあります。
そのためローカル環境ではGoogle Cloud Translation APIを任意で利用し、日本語入力を英語へ翻訳してから再検索します。
Nominatimは英語・ローマ字表記の施設名に対応していることが多いため、カタカナのまま検索するより見つかりやすくなる可能性があります。

公式ポリシー: https://operations.osmfoundation.org/policies/nominatim/

利用時の注意点:

- 公開APIは寄付運営のサーバーで、小規模利用向けです。
- 絶対上限は1秒あたり1リクエストです。
- 入力中に自動で検索するオートコンプリート用途は禁止されています。
- 同じ検索を繰り返さないよう、検索結果はアプリ側でキャッシュする必要があります。
- ユーザー操作に直接紐づく検索に限定するのが安全です。このアプリでは登録・更新時だけ呼び出します。
- Nominatimで座標を取得できない場合は、`cities.json` の都市代表座標へフォールバックします。
- 大量利用、商用利用、継続的な一括ジオコーディングには、別の商用ジオコーディングサービスや自前のNominatimサーバーを検討する必要があります。

### Google Cloud Translation API

ローカルで翻訳補助を使う場合は、`translation-config.js` にGoogle Cloud Translation APIキーを設定します。

`translation-config.js` は `.gitignore` に入れているため、GitHub Pagesにアップロードされない想定です。ファイルがない場合やAPIキーが未設定の場合は、翻訳補助をスキップして通常のNominatim検索と `cities.json` フォールバックだけで動作します。

Google Cloud Translation APIは、公式価格表ではCloud Translation BasicのNMT翻訳に月50万文字までの無料枠があります。
公式価格: https://cloud.google.com/translate/pricing
