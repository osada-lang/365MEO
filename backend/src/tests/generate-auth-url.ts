import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env
dotenv.config({ path: path.join(__dirname, '../../.env') });

const clientID = process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const redirectURI = 'http://localhost';

const scopes = [
  'https://www.googleapis.com/auth/business.manage',
  'https://www.googleapis.com/auth/drive.readonly'
];

async function main() {
  if (!clientID || !clientSecret) {
    console.error('❌ Error: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing in .env');
    return;
  }

  const oauth2Client = new google.auth.OAuth2(
    clientID,
    clientSecret,
    redirectURI
  );

  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  console.log('\n================================================================================');
  console.log('🔗 Google API Authorization Link');
  console.log('================================================================================');
  console.log('\nBelow is your personalized Google OAuth link. Please open it in your browser,');
  console.log('authorize using the Google Account that manages "合同会社THANX CREATE",');
  console.log('and copy the redirect URL (starting with http://localhost/?code=...) back to me.\n');
  console.log(authorizeUrl);
  console.log('\n================================================================================\n');
}

main();
