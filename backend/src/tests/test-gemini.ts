import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from backend directory
dotenv.config({ path: path.join(__dirname, '../../.env') });

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('❌ Error: GEMINI_API_KEY is not defined in .env');
    process.exit(1);
  }

  console.log('🤖 Checking API key validity by fetching model list directly...');
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

  try {
    const response = await fetch(url);
    const data = await response.json() as any;
    
    console.log(`� Response Status: ${response.status} ${response.statusText}`);
    console.log('--------------------------------------------------');
    console.log(JSON.stringify(data, null, 2));
    console.log('--------------------------------------------------');
  } catch (error) {
    console.error('❌ Error fetching models:', error);
  }
}

main();


