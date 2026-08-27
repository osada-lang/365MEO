import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env
dotenv.config({ path: path.join(__dirname, '../../.env') });

const prisma = new PrismaClient();

async function main() {
  console.log('--- DB Check Draft Posts ---');
  const shopKeywords = await prisma.shopKeywords.findUnique({
    where: { shop_id: 'thanx-create-uuid' }
  });

  if (!shopKeywords) {
    console.error('❌ Shop keywords not found!');
    return;
  }

  console.log('📌 current shopKeywords draft_posts:');
  if (!shopKeywords.draft_posts) {
    console.log('null or empty');
    return;
  }

  const drafts = JSON.parse(shopKeywords.draft_posts);
  console.log(JSON.stringify(drafts, null, 2));

  // Run timezone analysis
  const publishedItem = drafts.find((d: any) => d.dayIndex === -1);
  if (publishedItem) {
    console.log('✅ Found publishedItem with dayIndex === -1');
    console.log('   - publishedAt raw:', publishedItem.publishedAt);
    if (publishedItem.publishedAt) {
      const jstNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
      const todayDateStr = jstNow.getFullYear() + '-' + (jstNow.getMonth() + 1) + '-' + jstNow.getDate();

      const jstPub = new Date(new Date(publishedItem.publishedAt).toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
      const pubDateStr = jstPub.getFullYear() + '-' + (jstPub.getMonth() + 1) + '-' + jstPub.getDate();

      console.log(`   - jstNow: ${jstNow.toISOString()} (Date string: ${todayDateStr})`);
      console.log(`   - jstPub: ${jstPub.toISOString()} (Date string: ${pubDateStr})`);
      console.log(`   - Is different day?: ${todayDateStr !== pubDateStr}`);
    } else {
      console.log('   - ⚠️ publishedAt is missing or falsy!');
    }
  } else {
    console.log('ℹ️ No publishedItem (dayIndex === -1) found.');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
