import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env
dotenv.config({ path: path.join(__dirname, '../../.env') });

const clientID = process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const redirectURI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/auth/google/callback';
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN || '';

async function testGoogleDrive() {
  console.log('================================================================================');
  console.log('📡 Google Drive API 接続＆ストック画像スキャンテスト');
  console.log('================================================================================\n');

  if (!clientID || !clientSecret) {
    console.error('❌ Error: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing in .env');
    process.exit(1);
  }

  if (!refreshToken) {
    console.log('⚠️ [注意] GOOGLE_REFRESH_TOKEN が .env に設定されていません。');
    console.log('先ほど生成した Google OAuth 認証URLを開いてログインし、取得したトークンを .env に設定してください。');
    console.log('ここでは擬似的にローカルモックのファイルスキャンを実行します...\n');
    
    simulateMockDriveScanning();
    return;
  }

  console.log('🔄 Initializing Google Auth Client with Refresh Token...');
  const oauth2Client = new google.auth.OAuth2(clientID, clientSecret, redirectURI);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  try {
    console.log('📂 Scanning files from Google Drive (Searching for JPEG and PNG images)...');
    // Query Google Drive for JPEG and PNG image files
    const response = await drive.files.list({
      pageSize: 15,
      fields: 'nextPageToken, files(id, name, mimeType)',
      q: "mimeType = 'image/jpeg' or mimeType = 'image/png'",
    });

    const files = response.data.files;
    if (!files || files.length === 0) {
      console.log('ℹ️ No images found in Google Drive root.');
      console.log('Google Drive API 自体は疎通に成功しました！');
    } else {
      console.log(`🟢 Successfully scanned ${files.length} images from Google Drive:\n`);
      files.forEach((file) => {
        console.log(`  📸 [ID: ${file.id}] ${file.name} (${file.mimeType})`);
      });
    }
  } catch (error: any) {
    console.error('❌ Failed to fetch files from Google Drive:', error.message || error);
    console.log('\n💡 解決のヒント:');
    console.log('1. GCPコンソールで Google Drive API が有効になっているか確認してください。');
    console.log('2. トークンが期限切れ、または無効である可能性があります。もう一度 OAuth 認証を行ってください。');
  }
}

function simulateMockDriveScanning() {
  console.log('📦 [モック] Google Drive フォルダスキャンシミュレーションを開始:');
  const mockFiles = [
    { id: 'file-id-101', name: 'shop_exterior_day1.jpg', mimeType: 'image/jpeg' },
    { id: 'file-id-102', name: 'coffee_beans_roasting.png', mimeType: 'image/png' },
    { id: 'file-id-103', name: 'latte_art_sample.jpg', mimeType: 'image/jpeg' },
    { id: 'file-id-104', name: 'interior_seating_vibe.jpg', mimeType: 'image/jpeg' },
    { id: 'file-id-105', name: 'seasonal_menu_board.png', mimeType: 'image/png' },
  ];

  console.log(`🟢 Successfully simulated scan. Found ${mockFiles.length} mock images:\n`);
  mockFiles.forEach((file) => {
    console.log(`  📸 [ID: ${file.id}] ${file.name} (${file.mimeType})`);
  });
  console.log('\n================================================================================');
  console.log('🟢 Google Drive モックテスト完了：ファイル検出とメタデータ抽出に成功しました！');
  console.log('================================================================================');
}

testGoogleDrive();
