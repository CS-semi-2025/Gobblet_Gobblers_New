基本的には、以下の `1` 〜 `6` を繰り返して開発を進めます。

### [Step 1] 最新の状態にする
作業を始める前に、必ず `main` ブランチを最新にします。
`
git checkout main
'
git pull origin main
`

### [Step 2] 作業用ブランチを作成する
自分の作業専用のコピー（ブランチ）を作ります。
名前は `feature/機能名` や `user/自分の名前/機能名` などわかりやすくします。
例: 3Dボード作成機能の場合
`
git checkout -b feature/board-3d
`

### [Step 3] コードを書く・修正する
ガリガリ開発してください！
こまめに動作確認 (`node server.js`) をしましょう。

### [Step 4] 変更を保存 (Commit) する
作業が一区切りついたら、変更を記録します。
`
git add .
git commit -m "変更内容をわかりやすく書く (例: 3Dボードの初期配置を実装)"
`

### [Step 5] リモートにアップロード (Push) する
自分のブランチをGitHubにアップロードします。
`
git push origin feature/board-3d
`

### [Step 6] Pull Request (プルリク) を送る
1.  GitHubのこのリポジトリのページを開きます。
2.  「Compare & pull request」というボタンが出ているので押します。
3.  内容を確認して「Create pull request」を押します。
4.  チームメンバーに「プルリク出したので確認してください！」と伝えます。
5.  問題なければ `Merge` されます（これで `main` に反映されます）。
