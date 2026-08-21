# 365MEO (365ボイス) - プロジェクト開発ガイド (AGENTS.md)

このドキュメントは、「MEO SEIHA」から複製されカスタマイズされた「365MEO」のローカル開発・動作検証用のコマンドや、本番環境移行時の注意点についてまとめた引き継ぎ用の開発ガイドです。

---

## 🛠️ 基本コマンド一覧

### 1. 依存ライブラリのインストール
フロントエンド・バックエンドそれぞれでインストールが必要です。
```bash
# バックエンド
cd backend
npm install

# フロントエンド
cd ../frontend
npm install
```

### 2. データベースのセットアップとシード投入 (Prisma)
ローカルで動作確認を行う際、事前に `.env` を作成した上で以下を実行してください。
```bash
cd backend
# データベーススキーマの反映
npx prisma db push

# 365MEO用初期データの投入
npx prisma db seed
```

### 3. アプリケーションの起動
```bash
# バックエンド開発サーバー起動
cd backend
npm run dev

# フロントエンド開発サーバー起動
cd frontend
npm run dev
```

### 4. ビルド（本番用コンパイルチェック）
本番環境にデプロイする前の型チェックおよびコンパイルが正常に通るか確認するコマンドです。
```bash
# バックエンドビルド
cd backend
npm run build

# フロントエンドビルド
cd frontend
npm run build
```

---

## 🧪 テスト・疎通確認用コマンド一覧
バックエンド (`backend`) ディレクトリで実行します。
* `npm run test:gemini`: Gemini AIによる投稿文・返信文生成の検証
* `npm run test:line`: LINE Messaging APIとの疎通テスト
* `npm run test:review`: クチコミ受信・判定および自動返信・LINEアラートのシミュレーションテスト
* `npm run demo:review`: クチコミの星評価による仕分け＆LINE実機連動のデモ（対話型メニュー）
* `npm run test:optimization`: 自動投稿キーワードローテーション＆被写体特化(Image-First)ロジックのシミュレーションテスト

---

## 🔒 環境変数 (.env) 設定
各環境変数についての詳細は、プロジェクトルートおよび `backend/` 配下にある `.env.example` ファイルを参照してください。
特に以下のキーは３６５社から回収して設定する必要があります。
* `DATABASE_URL`: PostgreSQLデータベース接続文字列
* `GEMINI_API_KEY`: Google AI Studio APIキー
* `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN`: GCP OAuth 2.0 接続情報
* `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET`: LINE Messaging API 接続情報
