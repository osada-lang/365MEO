import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('❌ Error: GEMINI_API_KEY is not defined');
    return;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  try {
    const response = await fetch(url);
    const data = await response.json() as any;
    if (data.models) {
      console.log('🟢 Total models found:', data.models.length);
      const textModels = data.models
        .filter((m: any) => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
        .map((m: any) => m.name);
      
      console.log('🟢 Text Generation Models:');
      console.log(textModels.slice(0, 40)); // Print first 40 models
    } else {
      console.log('❌ No models returned:', data);
    }
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

main();
