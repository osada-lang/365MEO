import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as readline from 'readline';

// Load .env
dotenv.config({ path: path.join(__dirname, '../../.env') });

const clientID = process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
// Use the exact redirect URI registered in GCP (http://localhost)
const redirectURI = 'http://localhost';

if (!clientID || !clientSecret) {
  console.error('❌ Error: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing in .env');
  process.exit(1);
}

const scopes = [
  'https://www.googleapis.com/auth/business.manage',
  'https://www.googleapis.com/auth/drive.readonly'
];

const oauth2Client = new google.auth.OAuth2(
  clientID,
  clientSecret,
  redirectURI
);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function main() {
  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  console.log('================================================================================');
  console.log('🌐 Google Business Profile & Google Drive OAuth 2.0 手動認証アシスタント');
  console.log('================================================================================\n');
  console.log('1. 下記のURLをブラウザで開いて、Googleアカウントでログインしてください：\n');
  console.log(authorizeUrl);
  console.log('\n--------------------------------------------------------------------------------');
  console.log('2. ログイン完了後、ブラウザのアドレスバーのURLが以下のようになります：');
  console.log('   http://localhost/?code=4/0Adyx...&scope=...');
  console.log('   ※画面は「このサイトにアクセスできません」と表示されますが、問題ありません！');
  console.log('--------------------------------------------------------------------------------\n');
  
  rl.question('3. ブラウザのアドレスバーのURLを丸ごとコピーして、ここに貼り付けてEnterを押してください：\n\n> ', async (inputUrl) => {
    try {
      // Extract the code parameter from the pasted URL
      let code = inputUrl.trim();
      if (code.includes('code=')) {
        const urlParams = new URL(code);
        code = urlParams.searchParams.get('code') || '';
      }

      if (!code) {
        console.error('❌ Error: URLから認可コード(code)を抽出できませんでした。正しいURLを入力してください。');
        rl.close();
        process.exit(1);
      }

      console.log('\n📬 Received authorization code. Exchanging for Refresh Token with Google...');
      const { tokens } = await oauth2Client.getToken(code);

      console.log('\n================================================================================');
      console.log('🟢 Google API 連携成功！トークンを取得しました！');
      console.log('================================================================================');
      console.log('💾 以下の行をコピーして、 `backend/.env` ファイルに貼り付けて保存してください：\n');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log(`GOOGLE_ACCESS_TOKEN=${tokens.access_token}`);
      console.log('\n================================================================================');
      
    } catch (error: any) {
      console.error('❌ Failed to exchange authorization code:', error.message || error);
    } finally {
      rl.close();
    }
  });
}

main();
