import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const shopCount = await prisma.shop.count();
  if (shopCount > 0) {
    console.log('ℹ️ Database already has shops configured. Skipping settings initialization to protect custom settings.');
    return;
  }

  console.log('🔄 Updating database settings for 株式会社３６５...');

  const shopId = '365meo-shop-uuid';

  // 1. Update Shop general fields (custom_review_prompt, reply_active, google_drive_folder_id, google_location_id, email)
  const existingShop = await prisma.shop.findUnique({ where: { id: shopId } });
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      email: '365meo@gmail.com',
      reply_active: existingShop ? existingShop.reply_active : true,
      google_drive_folder_id: existingShop?.google_drive_folder_id || '1AIgemm9-fvP-eLwP7p2p8Plja1mbOJtX',
      google_location_id: existingShop?.google_location_id || 'locations/3018418038085555463',
      custom_review_prompt: existingShop ? existingShop.custom_review_prompt : '株式会社３６５のカスタマーサポートとして、極めて真摯にお詫びしてください。店舗様の売上向上に本気で伴走する企業として、サービス改善へ向けて早急に対応する熱い誠意を伝えてください。',
    },
  });

  const existingKeywords = await prisma.shopKeywords.findUnique({ where: { shop_id: shopId } });

  // 2. Upsert ShopKeywords
  await prisma.shopKeywords.upsert({
    where: { shop_id: shopId },
    update: {
      main_keywords: existingKeywords ? existingKeywords.main_keywords : JSON.stringify(['名古屋 MEO', 'MEO対策', 'Googleマップ集客', 'ローカルSEO', '365MEO']),
      sub_keywords: existingKeywords ? existingKeywords.sub_keywords : JSON.stringify(['口コミ対策', 'GBP運用', 'マップ順位', '集客効果', '名古屋マーケティング', '店舗集客', '自動投稿', 'SNS連動', '口コミ返信', 'AI作成']),
      fixed_footer: existingKeywords ? existingKeywords.fixed_footer : null, // Default to blank/null
      custom_prompt: existingKeywords ? existingKeywords.custom_prompt : '親しみやすく誠実なトーンで。中小企業の店舗オーナー様に向けて、Web集客やMEO対策の有益なコツや店舗様の魅力について、専門家としての信頼感を持って発信してください。',
      hp_url: existingKeywords ? existingKeywords.hp_url : null,
      tabelog_url: existingKeywords ? existingKeywords.tabelog_url : null,
      hotpepper_url: existingKeywords ? existingKeywords.hotpepper_url : null,
      gurunavi_url: existingKeywords ? existingKeywords.gurunavi_url : null,
      gbp_action_url: existingKeywords ? existingKeywords.gbp_action_url : null,
    },
    create: {
      shop_id: shopId,
      main_keywords: JSON.stringify(['名古屋 MEO', 'MEO対策', 'Googleマップ集客', 'ローカルSEO', '365MEO']),
      sub_keywords: JSON.stringify(['口コミ対策', 'GBP運用', 'マップ順位', '集客効果', '名古屋マーケティング', '店舗集客', '自動投稿', 'SNS連動', '口コミ返信', 'AI作成']),
      fixed_footer: null, // Default to blank as requested
      custom_prompt: '親しみやすく誠実なトーンで。中小企業の店舗オーナー様に向けて、Web集客やMEO対策の有益なコツや店舗様の魅力について、専門家としての信頼感を持って発信してください。',
      hp_url: null,
      tabelog_url: null,
      hotpepper_url: null,
      gurunavi_url: null,
      gbp_action_url: null,
      draft_posts: null,
    },
  });

  console.log('✅ Successfully configured all settings for 株式会社３６５ inside the database!');
}

main()
  .catch((e) => {
    console.error('❌ Failed to update settings:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
