import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env
dotenv.config({ path: path.join(__dirname, '../../.env') });

const clientID = process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const redirectURI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost';
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN || '';

async function testGoogleGBP() {
  console.log('================================================================================');
  console.log('📡 Google Business Profile (GBP) API 店舗一覧スキャンテスト');
  console.log('================================================================================\n');

  if (!clientID || !clientSecret || !refreshToken) {
    console.error('❌ Error: Google Client ID, Secret, or Refresh Token is missing in .env');
    process.exit(1);
  }

  console.log('🔄 Initializing Google Auth Client with Refresh Token...');
  const oauth2Client = new google.auth.OAuth2(clientID, clientSecret, redirectURI);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  // Initialize My Business Account Management API
  const mybusiness = google.mybusinessaccountmanagement({
    version: 'v1',
    auth: oauth2Client
  });

  try {
    console.log('⏳ Google マイビジネスの「アカウント（組織）」一覧を取得中...');
    const accountsResponse = await mybusiness.accounts.list();
    const accounts = accountsResponse.data.accounts;

    if (!accounts || accounts.length === 0) {
      console.log('ℹ️ Googleアカウント内にマイビジネス用のアカウント（組織）が見つかりませんでした。');
      console.log('※店舗を管理している正しいGoogleアカウントでOAuth認証を行ったかご確認ください。');
      return;
    }

    console.log(`🟢 Successfully found ${accounts.length} GBP accounts (organizations):\n`);
    
    for (const account of accounts) {
      console.log(`🏢 アカウント名: ${account.name}`);
      console.log(`   └ 表示名: ${account.accountName}`);
      console.log(`   └ タイプ: ${account.type}`);
      console.log(`   └ ステータス: ${account.verificationState || 'VERIFIED'}`);
      console.log('--------------------------------------------------');

      // Initialize My Business Business Information API to scan locations (stores) under this account
      const businessinfo = google.mybusinessbusinessinformation({
        version: 'v1',
        auth: oauth2Client
      });

      console.log(`⏳ アカウント 「${account.accountName}」 配下の店舗一覧を読み込み中...`);
      try {
        const locationsResponse: any = await businessinfo.accounts.locations.list({
          parent: account.name as string,
          readMask: 'name,title,storefrontAddress,metadata,websiteUri'
        });

        const locations = locationsResponse.data.locations;
        if (!locations || locations.length === 0) {
          console.log('   ℹ️ このアカウント内には公開中または登録済みの店舗が見つかりませんでした。');
        } else {
          console.log(`   🟢 登録店舗を ${locations.length} 件検出しました：`);
          locations.forEach((loc: any) => {
            console.log(`     📍 店舗名: ${loc.title}`);
            console.log(`        └ 住所: ${loc.storefrontAddress?.addressLines?.join(', ') || '未設定'}`);
            console.log(`        └ ウェブサイト: ${loc.websiteUri || '未設定'}`);
            console.log(`        └ API参照名: ${loc.name}`);
          });
        }
      } catch (locError: any) {
        console.error(`   ❌ 店舗情報の取得に失敗しました: ${locError.message || locError}`);
        console.log('     ℹ️ 原因: GBP API（My Business Business Information API）がGCP側で有効になっていない可能性があります。');
      }
      console.log('==================================================');
    }

  } catch (error: any) {
    console.error('❌ Failed to fetch GBP accounts:', error.message || error);
    console.log('\n💡 解決のヒント:');
    console.log('1. 都田様のGCPコンソールで、以下のAPIが「有効」になっているかご確認ください：');
    console.log('   - My Business Account Management API');
    console.log('   - My Business Business Information API');
    console.log('2. トークンが正しく設定されているかご確認ください。');
  }
}

testGoogleGBP();
