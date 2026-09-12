import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env
dotenv.config({ path: path.join(__dirname, '../../.env') });

const clientID = process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
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

async function main() {
  const args = process.argv.slice(2);
  let rawInput = args[0];

  if (!rawInput) {
    console.error('❌ Error: Please provide the authorization code or redirection URL as an argument.');
    console.log('Usage: npx tsx src/tests/test-google-direct.ts <AUTH_CODE_OR_URL>');
    process.exit(1);
  }

  let code = rawInput.trim();
  // If the user pasted the entire redirect URL, extract the code parameter
  if (code.includes('code=')) {
    try {
      const urlParams = new URL(code);
      code = urlParams.searchParams.get('code') || '';
    } catch {
      // Fallback if URL parsing fails on a raw string that just has code=
      const match = code.match(/code=([^&]+)/);
      if (match) {
        code = match[1];
      }
    }
  }

  if (!code) {
    console.error('❌ Error: Could not extract authorization code. Please verify the URL or code.');
    process.exit(1);
  }

  console.log('📬 Exchanging code with Google for tokens...');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    console.log('\n================================================================================');
    console.log('🟢 Google API Connection Successful!');
    console.log('================================================================================');
    console.log('💾 Copy and paste these into your `backend/.env` file:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`GOOGLE_ACCESS_TOKEN=${tokens.access_token}`);
    console.log('\n================================================================================');
  } catch (error: any) {
    console.error('❌ Failed to exchange authorization code:', error.message || error);
  }
}

main();
