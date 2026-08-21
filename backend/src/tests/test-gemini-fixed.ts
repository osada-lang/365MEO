import { GoogleGenerativeAI } from '@google/generative-ai';
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

  console.log('🤖 Initializing Gemini API...');
  const genAI = new GoogleGenerativeAI(apiKey);
  
  // Use gemini-3.5-flash as the latest standard lightweight model in 2026
  const modelName = 'gemini-3.5-flash';
  console.log(`📡 Connecting to model: ${modelName}...`);
  const model = genAI.getGenerativeModel({ model: modelName });

  const testPrompt = `
    MEO対策用の自動投稿文のサンプルを1つ作成してください。
    【条件】
    - 自然な日本語。
    - 100〜150字程度。
    - ターゲットキーワード: 「名古屋 カフェ」, 「自家焙煎」
    - 絵文字や記号（!や?など）は一切使わないこと。
  `;

  try {
    console.log('✉️ Sending test prompt to Gemini...');
    const result = await model.generateContent(testPrompt);
    const response = await result.response;
    const text = response.text();
    
    console.log('\n🟢 Connection Successful! Response from Gemini:');
    console.log('--------------------------------------------------');
    console.log(text.trim());
    console.log('--------------------------------------------------\n');
  } catch (error) {
    console.error('❌ Error communicating with Gemini API:', error);
    process.exit(1);
  }
}

main();
