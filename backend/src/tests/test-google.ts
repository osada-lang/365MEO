import express, { Request, Response } from 'express';
import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env
dotenv.config({ path: path.join(__dirname, '../../.env') });

const clientID = process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const redirectURI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/auth/google/callback';

if (!clientID || !clientSecret) {
  console.error('❌ Error: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not defined in .env');
  process.exit(1);
}

// Scopes required for GBP and Google Drive (Read-only)
const scopes = [
  'https://www.googleapis.com/auth/business.manage', // GBP management
  'https://www.googleapis.com/auth/drive.readonly'  // Google Drive read stock images
];

const oauth2Client = new google.auth.OAuth2(
  clientID,
  clientSecret,
  redirectURI
);

const app = express();
const port = 3000; // Use same port but we will run this test separately or add endpoints

app.get('/api/auth/google/login', (req: Request, res: Response) => {
  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Critical to get the Refresh Token
    scope: scopes,
    prompt: 'consent'       // Force consent screen to guarantee Refresh Token is returned
  });
  
  res.redirect(authorizeUrl);
});

app.get('/api/auth/google/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) {
    return res.status(400).send('❌ Error: No authorization code returned');
  }

  console.log('📬 Received auth code from Google. Exchanging for tokens...');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('\n==================================================');
    console.log('🟢 Google OAuth Tokens Received Successfully!');
    console.log('==================================================');
    console.log('💾 Copy and paste these into your `.env` file:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`GOOGLE_ACCESS_TOKEN=${tokens.access_token}`);
    console.log('==================================================\n');

    res.send(`
      <div style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h1 style="color: #2e7d32;">🎉 Google API 連携成功！</h1>
        <p>認証コードの交換に成功し、リフレッシュトークンを取得しました。</p>
        <p style="background: #f5f5f5; padding: 15px; border-radius: 8px; font-family: monospace; display: inline-block;">
          ターミナル（コンソール）の出力ログにリフレッシュトークンが表示されています。<br>
          それをコピーして <code>.env</code> に貼り付けてください。
        </p>
        <p style="color: #666; margin-top: 20px;">このタブは閉じていただいて構いません。</p>
      </div>
    `);

    // Clean exit after successful authentication in 5 seconds
    setTimeout(() => {
      console.log('👋 OAuth Callback server finished. Exiting...');
      process.exit(0);
    }, 5000);

  } catch (error) {
    console.error('❌ Failed to exchange authorization code:', error);
    res.status(500).send('❌ Failed to exchange authorization code. Check console logs.');
  }
});

function main() {
  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  console.log('================================================================================');
  console.log('🌐 Google Business Profile & Google Drive OAuth 2.0 連携アシスタント');
  console.log('================================================================================\n');
  console.log('1. 下記のURLをブラウザで開いて、Googleアカウントでログインしてください：\n');
  console.log(authorizeUrl);
  console.log('\n2. ログイン完了後、ローカルサーバーが自動で「リフレッシュトークン」を取得します。\n');
  console.log('================================================================================');

  app.listen(port, () => {
    console.log(`📡 Temporary callback server is listening on http://localhost:${port}`);
    console.log(`Waiting for Google redirection...\n`);
  });
}

main();
