# Tab Manager

Tab Session Manager の使い勝手を踏襲した、ウィンドウ/タブのセッション保存・復元拡張です。
保存したセッションを **Google Drive / Dropbox / pCloud の API**、または **ローカル同期フォルダ**（Google Drive for desktop・pCloud Drive・Dropbox・OneDrive などのデスクトップクライアント）を介して同期し、どのブラウザ・どの PC でも同じセッション一覧を使えます。

Manifest V3 / ビルド不要の素の JavaScript で、Brave・Chrome・Edge・Vivaldi など Chromium 系ブラウザで動作します。
ポップアップと設定ページの UI（レイアウト・配色・アイコン・文言）は Tab Session Manager をそのまま再現しています。

## 機能

- **UI**: Tab Session Manager と同じ 2 カラムのポップアップ（左: フィルター / ソート / 検索 / セッションリスト / 保存欄、右: 選択中セッションの詳細）。右クリックメニュー、名前変更・タグ追加のモーダル、通知バーと取り消し / やり直し、ライト / ダーク / システムのテーマ、ポップアップサイズ・サイドバー幅・日付フォーマットの設定、セッションリストをタブで開く機能を含みます。
- **手動保存**: 全ウィンドウ・全タブ（ピン留め、アクティブタブ、タブグループ、ウィンドウの位置・サイズ・状態、シークレット属性）を保存。ショートカット `Ctrl/Cmd+Shift+S`
- **自動保存**: 定期保存 / ウィンドウを閉じたとき / ブラウザ終了時。それぞれ保持数を設定でき、変更がなければスキップ
- **復元**: 新しいウィンドウで開く / 現在のウィンドウで開く（置き換え） / 現在のウィンドウに追加。ウィンドウ単位・タブ単位でも開ける
- **遅延読み込み**: 非アクティブなタブはプレースホルダで開き、切り替えたときに読み込み。大きなセッションも一瞬で復元
- **整理**: 名前変更、タグ、検索（セッション名・タブタイトル・URL）、セッションからウィンドウ/タブを個別に削除
- **インポート / エクスポート**: JSON。Tab Session Manager のバックアップファイルをそのまま取り込めます
- **クラウド同期**: セッション 1 件 = JSON ファイル 1 つ。最終更新時刻ベースで双方向マージし、削除も墓標ファイルで伝播。複数ブラウザで同時に使っても壊れません

## インストール

1. このリポジトリを取得（`git clone` または ZIP 展開）
2. `brave://extensions`（Chrome なら `chrome://extensions`）を開き、右上の「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選択

`manifest.json` に `key` を含めているため、どのブラウザで読み込んでも拡張 ID は
`emldhjpjcmgncgnpeibeophdfolokloc` に固定されます。OAuth のリダイレクト URI は常に
`https://emldhjpjcmgncgnpeibeophdfolokloc.chromiumapp.org/` です（設定画面にも表示されます）。

## 同期の設定

ツールバーアイコン → ⚙ で設定画面を開き、「クラウド同期」でプロバイダを選びます。どのプロバイダでも、各ブラウザで同じフォルダ / 同じ Client ID を指定してください。

### A. ローカル同期フォルダ（最も簡単、プロバイダを問わない）

Google Drive for desktop、pCloud Drive、Dropbox、OneDrive など、PC にマウントされているクラウドフォルダの中にフォルダを作り、それを選択します。
例: `~/Google Drive/マイドライブ/TabManager`、`~/pCloud Drive/TabManager`、`~/Dropbox/TabManager`

- **Brave の注意**: Brave は既定で File System Access API を無効にしています。`brave://flags/#file-system-access-api` を Enabled にして再起動してください。設定画面で選択ボタンが使えない場合はこの警告が表示されます。
- ブラウザを再起動するとフォルダへのアクセス許可が切れることがあります。その場合はポップアップ上部に「アクセスを許可」バナーが出るので押してください（バックグラウンド同期はその間スキップされます）。

### B. Google Drive（API）

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) でプロジェクトを作り、**Google Drive API を有効化**
2. 「OAuth 同意画面」を設定（テストユーザーに自分のアカウントを追加）
3. 「認証情報」→「OAuth クライアント ID」→ 種類 **ウェブ アプリケーション**
   「承認済みのリダイレクト URI」に `https://emldhjpjcmgncgnpeibeophdfolokloc.chromiumapp.org/` を追加
4. 拡張の設定画面に Client ID を入力して「サインイン」

スコープは `drive.file`（この拡張が作ったファイルのみ）です。マイドライブ直下に `TabManager` フォルダが作られます。

### C. Dropbox（API）

1. [Dropbox App Console](https://www.dropbox.com/developers/apps) で「Scoped access」「App folder」のアプリを作成
2. Permissions タブで `files.metadata.read` / `files.content.read` / `files.content.write` を有効化
3. Settings タブの Redirect URIs に `https://emldhjpjcmgncgnpeibeophdfolokloc.chromiumapp.org/` を追加
4. 拡張の設定画面に App key を入力して「サインイン」

PKCE + リフレッシュトークンを使うため、App secret は不要です。

### D. pCloud（API）

1. [pCloud My Applications](https://docs.pcloud.com/my_apps/) でアプリを登録し、Redirect URIs に `https://emldhjpjcmgncgnpeibeophdfolokloc.chromiumapp.org/` を追加
2. 拡張の設定画面に Client ID を入力して「サインイン」（US / EU リージョンは自動判別）

### 同期の動作

- 変更の 3 秒後と、設定した間隔（既定 5 分）ごとにバックグラウンドで同期。ポップアップを開いたときにも同期します
- 既定では **手動保存したセッションのみ** 同期します。自動保存も同期したい場合は「自動保存されたセッションも同期する」を ON
- リモートのファイル名は `<セッションID>__<最終更新ms>.json`、削除は `<セッションID>__<削除ms>.tomb`。新しい方のイベントが勝つので、別ブラウザで削除した後に編集すれば復活します

## 開発

```
npm install        # テスト用の fake-indexeddb のみ
npm test           # 同期エンジン・自動保存ポリシーの単体テスト
npm run smoke      # ヘッドレス Brave で実機スモークテスト（BROWSER=... で Chromium を指定可）
npm run icons      # アイコン (icon*.png / icon.svg / logo.svg) を再生成（依存なしの自前ラスタライザ）
npm run zip        # 配布用 ZIP
```

```
background.js        Service Worker: アラーム、スナップショット、ウィンドウ閉鎖/終了検知、復元の仲介
lib/session.js       セッションの取得・復元（TSM 互換フォーマット）
lib/store.js         IndexedDB 上の CRUD、墓標、インポート/エクスポート
lib/autosave.js      定期 / ウィンドウ閉鎖 / ブラウザ終了 の保存ポリシー
lib/sync.js          双方向マージ同期エンジン
lib/providers/       folder (File System Access) / gdrive / dropbox / pcloud
offscreen/           フォルダ同期をバックグラウンドから実行するためのオフスクリーン文書
lib/format.js        日付フォーマット（YYYY.MM.DD HH:mm:ss など）
popup/               ポップアップ（TSM の PopupPage / Header / OptionsArea / SessionsArea / SessionDetailsArea / SaveArea 相当）
options/             設定ページ（TSM の SideBar / CategoryContainer / OptionContainer 相当）
lazy/                遅延読み込みプレースホルダ
_locales/            日本語 / 英語
```

## クレジット

- UI のスタイルシートと文言は [Tab Session Manager](https://github.com/sienori/Tab-Session-Manager)（Sienori, MPL-2.0）から移植しています。対象ファイルは `THIRD_PARTY_NOTICES.md` に列挙しています。ツールバーアイコンは TSM のアイコンのティール部分を白、白部分を透明に変更したもの、favicon / ロゴはそれをスレート背景に乗せたものです（`icons/`）。ポップアップ内のアイコン（`popup/icons.js`）は独自デザインです。

## 既知の制限

- Firefox は未対応です（Service Worker 型バックグラウンドと `chrome.offscreen` に依存）。
- `chrome://` や `file://` のタブは拡張から直接開けない場合があり、その場合はプレースホルダに URL を表示します。
- Google Drive はトークンの寿命が 1 時間で、サイレント更新に失敗した場合はポップアップに「サインインが必要です」と表示されます。
