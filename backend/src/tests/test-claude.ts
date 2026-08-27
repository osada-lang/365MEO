import Anthropic from '@anthropic-ai/sdk';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from backend directory
dotenv.config({ path: path.join(__dirname, '../../.env') });

async function main() {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    console.error('❌ Error: CLAUDE_API_KEY is not defined in .env');
    process.exit(1);
  }

  console.log('🤖 Initializing Anthropic Claude SDK...');
  const anthropic = new Anthropic({ apiKey });

  console.log('📡 Sending test prompt to Claude (claude-sonnet-5)...');
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'こんにちは！MEOシステム用のAI文章生成テストです。一言でお礼をお答えください。' }]
    });

    const responseText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    console.log('================================================--');
    console.log('🟢 Claude API Connection SUCCESSFUL!');
    console.log('================================================--');
    console.log(`💬 Response: "${responseText}"`);
    console.log('================================================--');
  } catch (error: any) {
    console.error('❌ Error connecting to Claude API:', error.message || error);
  }
}

main();
