# 📦 365MEO (365ボイス) 本番インフラ構築 ＆ デプロイ手順書

本書は、新システム「365MEO」の本番デプロイ作業（Render.com へのバックエンド＆データベース構築、Vercel へのフロントエンド配置、独立した Google OAuth の認証）を迷わずに完了させるための、365社様向けの公式デプロイ手順書です。

---

## 🧭 全体ロードマップ

```
【ステップ1：Render PostgreSQL DBの作成】（★まずはここから！）
  └ Render.com で PostgreSQL データベースを作成し、DATABASE_URL を取得
     ▼
【ステップ2：GitHub プライベートリポジトリへのプッシュ】
  └ 365MEO のコードを GitHub の新規プライベートリポジトリへ登録（プッシュ）
     ▼
【ステップ3：Render.com でバックエンド (API) の構築】
  └ Web Service を新規作成し、GitHub と連携して環境変数をセット
     ▼
【ステップ4：Vercel でフロントエンドの構築】
  └ Vercel プロジェクトを新規作成し、GitHub と連携してビルド
     ▼
【ステップ5：365MEO専用 Google リフレッシュトークンの取得】
  └ 認証アシスタントを動かし、admin@365voice.jp でログインして専用トークンを取得・適用
     ▼
【ステップ6：データベースの初期化 ＆ 初回デプロイ完了！】
  └ 本番用DBにマイグレーション（テーブル作成）と初期シードデータの投入を実行
```

---

## 🛠️ 各ステップの詳細手順

### 【ステップ1】Render.com で PostgreSQL データベースを作成する
1. [Render.com](https://render.com/) にサインインします。
2. 画面右上の **`＋ New`** ➔ **`PostgreSQL`** をクリックします。
3. 以下の通り設定項目を入力します：
   * **Name**: `365meo-db`
   * **Database**: `meodb`
   * **User**: `meouser`
   * **Region**: `Singapore (ap-southeast-1)` (または `Oregon (us-west)`)
   * **Instance Type**: `Free` (検証用) または `Starter` (本番推奨)
4. 最下部の **`Create Database`** をクリックします。
5. 作成完了後（`Available` になってから）、画面の中ほどにある **`External Connection String`** をコピーして控えておきます。
   * ※ 形式： `postgresql://meouser:password@host/meodb?sslmode=require`
   * **これが `DATABASE_URL` となります。**

---

### 【ステップ2】GitHub のプライベートリポジトリにプッシュする
Vercel や Render は、GitHub にコードが更新されると全自動で公開されるため、GitHub にリポジトリを作成します。

1. GitHubにアクセスし、新規の **Private リポジトリ**（例：`365MEO`）を作成します。
2. ターミナル（365MEOのルートディレクトリ）で以下を実行し、GitHubにコードをプッシュします：
   ```bash
   git remote add origin <作成したGitHubリポジトリのURL>
   git branch -M main
   git push -u origin main
   ```

---

### 【ステップ3】Render.com でバックエンドを構築する
1. Render.com の右上 **`＋ New`** ➔ **`Web Service`** をクリック。
2. 先ほどプッシュした GitHub リポジトリ（`365MEO`）を選択して連携します。
3. 以下の通り設定を行います：
   * **Name**: `365meo-api`
   * **Region**: （データベースと同じリージョンを選択します）
   * **Language**: `Node`
   * **Branch**: `main`
   * **Root Directory**: `backend` (★backendフォルダを指定)
   * **Build Command**: `npm install && npx prisma generate && npm run build`
   * **Start Command**: `npm run start`
   * **Instance Type**: `Free` または `Starter ($7/month)` (本番推奨)
4. **「Environment」タブ** で、[4. 環境変数マッピング一覧] に記載されている変数をすべてセットします。
5. **`Create Web Service`** をクリックして作成を開始します（数分でAPIサーバーが公開され、`https://365meo-api.onrender.com` のような公開URLが発行されます）。

---

### 【ステップ4】Vercel でフロントエンドをデプロイする
1. [Vercel](https://vercel.com/) にサインインし、**`Add New`** ➔ **`Project`** をクリック。
2. GitHubのリポジトリ `365MEO` を選択して **`Import`** をクリックします。
3. 以下の通り設定を行います：
   * **Project Name**: `365meo-app`
   * **Framework Preset**: `Vite` (自動で検知されます)
   * **Root Directory**: `frontend` (★frontendフォルダを指定)
   * **Build Command**: `npm run build`
   * **Output Directory**: `dist`
4. **「Environment Variables」欄** で、以下を設定します：
   * **`VITE_API_BASE_URL`**: ステップ3で Render.com から発行されたバックエンドAPIの公開URL（例：`https://365meo-api.onrender.com`）を設定します。
5. **`Deploy`** ボタンをクリックします。1分ほどでフロントエンド画面が本番公開されます！

---

### 【ステップ5】365MEO専用 Google リフレッシュトークンを取得する
独立した安全な接続を確立するため、365MEO専用の接続トークンを生成します。

1. 新規発行された `Google Client ID` と `Google Client Secret` を、ローカル環境の `/backend/.env` に一時的に設定します。
2. `backend/` ディレクトリで以下のコマンドを実行します：
   ```bash
   npm run test:google-manual
   ```
3. ターミナルに表示される Google ログインURLをブラウザで開き、本番用の Google アカウント（`admin@365voice.jp` など）でログインして認可を与えます。
4. 認可完了後、アドレスバーのURLが `http://localhost/?code=...` に切り替わります（画面はエラー表示になりますが問題ありません）。
5. アドレスバーのURL全体をコピーし、ターミナルの入力欄に貼り付けて Enter を押します。
6. 画面に **`GOOGLE_REFRESH_TOKEN=...`** が表示されますので、それをコピーして **Render.com（バックエンド）の環境変数**に設定します。

---

### 【ステップ6】本番データベースの初期化とシード
Render.com のバックエンドが立ち上がり、`DATABASE_URL`（ステップ1の接続文字列）が環境変数にセットされると、自動的にデータベースへのテーブル反映と365MEO用のシードデータの投入が行われ、本番稼働を開始します。

---

## 🔑 4. 環境変数マッピング一覧

Render.com のバックエンド「Web Service」の設定画面（Environment）に登録する必要がある環境変数の一覧です。

| 環境変数名 (Key) | 推奨する設定値 (Value) | 説明 |
| :--- | :--- | :--- |
| **PORT** | `3000` | サーバーポート番号 |
| **NODE_ENV** | `production` | 本番環境モード |
| **DATABASE_URL** | （ステップ1で取得した接続文字列） | PostgreSQL の接続文字列（最重要） |
| **CLAUDE_API_KEY** | （３６５社様の Anthropic APIキー） | 口コミお礼、お詫び、投稿文生成用のClaude AI接続キー |
| **GOOGLE_CLIENT_ID** | （共同開発者様より発行される Client ID） | 365MEO 専用 Google Cloud クライアントID |
| **GOOGLE_CLIENT_SECRET** | （共同開発者様より発行される Secret） | 365MEO 専用 Google Cloud クライアントシークレット |
| **GOOGLE_REDIRECT_URI** | `http://localhost` | Google認証用のコールバック先 |
| **GOOGLE_REFRESH_TOKEN** | （ステップ5で手動取得したトークン） | 24時間自動運転用の Google 永続接続キー |
| **LINE_CHANNEL_ACCESS_TOKEN** | （３６５社様の LINE チャネルトークン） | 緊急アラートを店主へ配信するLINE Messaging APIキー |
| **LINE_CHANNEL_SECRET** | （３６５社様の LINE チャネルシークレット） | LINE Webhookイベント受信の検証用キー |
| **LINE_USER_ID** | （管理者の LINE ユーザーID） | サーバー起動時・疎通テスト時のテスト通知先ID |
| **FRONTEND_URL** | （ステップ4で Vercel から発行された公開URL） | LINE通知等に記載するマジックログインリンクのベースURL |
