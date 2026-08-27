import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env
dotenv.config({ path: path.join(__dirname, '../../.env') });

async function diagnose() {
  console.log('=========================================');
  console.log('🔍 GBP Reviews Real-time Diagnostics (DB-Free)');
  console.log('=========================================\n');

  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  console.log('1. Checking Environment Variables...');
  console.log(`   - GOOGLE_CLIENT_ID: ${clientID ? '✅ Present' : '❌ MISSING'}`);
  console.log(`   - GOOGLE_CLIENT_SECRET: ${clientSecret ? '✅ Present' : '❌ MISSING'}`);
  console.log(`   - GOOGLE_REFRESH_TOKEN: ${refreshToken ? '✅ Present' : '❌ MISSING'}`);

  if (!clientID || !clientSecret || !refreshToken) {
    console.error('❌ Credentials missing in .env!');
    return;
  }

  // Hardcode THANX CREATE info for testing
  const shop = {
    id: 'thanx-create-uuid',
    name: '合同会社THANX CREATE',
    google_location_id: 'locations/3018418038085555463',
    created_at: new Date('2026-08-11T00:00:00.000Z'),
    reply_active: true
  };

  console.log('\n2. Shop Information (Hardcoded for DB-free diagnostics):');
  console.log(`   - Shop Name: "${shop.name}"`);
  console.log(`     └ ID: ${shop.id}`);
  console.log(`     └ Google Location ID: ${shop.google_location_id}`);
  console.log(`     └ Created At: ${shop.created_at.toISOString()}`);
  console.log(`     └ Reply Active: ${shop.reply_active}`);

  console.log('\n3. Authenticating with Google OAuth...');
  const oauth2Client = new google.auth.OAuth2(clientID, clientSecret, 'http://localhost');
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  try {
    console.log('4. Resolving Location Path...');
    let locationPath = shop.google_location_id;
    if (!locationPath.startsWith('accounts/')) {
      const numMatch = locationPath.match(/\d+/);
      if (numMatch) {
        const numericalId = numMatch[0];
        const mybusiness = google.mybusinessaccountmanagement({
          version: 'v1',
          auth: oauth2Client
        });
        const accountsRes = await mybusiness.accounts.list();
        const accounts = accountsRes.data.accounts || [];
        console.log(`   🟢 Found ${accounts.length} associated Google accounts.`);
        for (const account of accounts) {
          if (account.name) {
            locationPath = `${account.name}/locations/${numericalId}`;
            console.log(`   📍 Selected account: ${account.accountName} (${account.name})`);
            break;
          }
        }
      }
    }

    console.log(`   🟢 Resolved Path: "${locationPath}"`);

    console.log('\n5. Requesting Reviews from Google API...');
    const reviewsRes = await oauth2Client.request({
      url: `https://mybusiness.googleapis.com/v4/${locationPath}/reviews`,
      method: 'GET'
    });

    const reviews = (reviewsRes.data as any).reviews || [];
    console.log(`   🟢 API Response: Received ${reviews.length} reviews.`);

    if (reviews.length === 0) {
      console.log('   ℹ️ No reviews found on Google for this location.');
      return;
    }

    console.log('\n6. Checking Review Details & Safety Filter:');
    reviews.forEach((r: any, idx: number) => {
      console.log(`\n--- Review #${idx + 1} ---`);
      console.log(`   └ ID: ${r.name}`);
      console.log(`   └ Reviewer: ${r.reviewer?.displayName}`);
      console.log(`   └ Rating: ${r.starRating}`);
      console.log(`   └ Comment: "${r.comment || '(No Text)'}"`);
      console.log(`   └ Create Time: ${r.createTime}`);

      const reviewCreateDate = new Date(r.createTime);
      const shopCreatedDate = new Date(shop.created_at);
      const passedFilter = reviewCreateDate >= shopCreatedDate;

      console.log(`   └ Create Time (Parsed): ${reviewCreateDate.toISOString()}`);
      console.log(`   └ Shop Created At:      ${shopCreatedDate.toISOString()}`);
      console.log(`   └ Passed Safety Filter?: ${passedFilter ? '✅ YES' : '❌ NO (Reason: Review is older than shop registration)'}`);
    });

  } catch (err: any) {
    console.error('❌ Failed to fetch reviews or authenticate:', err.message || err);
    if (err.response) {
      console.error('   API Error Data:', JSON.stringify(err.response.data, null, 2));
    }
  }
}

diagnose();
