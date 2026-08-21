import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seeding (safe mode)...');

  // Check if admin shop exists
  const adminExists = await prisma.shop.findUnique({
    where: { id: 'admin-365meo-uuid' }
  });

  if (!adminExists) {
    await prisma.shop.create({
      data: {
        id: 'admin-365meo-uuid',
        name: '365MEOシステム管理運営本部',
        email: 'admin@365meo.com',
        password: 'password',
        role: 'ADMIN',
        google_location_id: null,
        google_drive_folder_id: null,
        line_user_id: null,
        reply_active: false,
        custom_review_prompt: null,
      },
    });
    console.log('👮 Created Admin User.');
  }

  // Check if 365MEO shop exists
  const shop3Exists = await prisma.shop.findUnique({
    where: { id: '365meo-shop-uuid' }
  });

  let shop3 = shop3Exists;
  if (!shop3Exists) {
    shop3 = await prisma.shop.create({
      data: {
        id: '365meo-shop-uuid',
        name: '株式会社３６５',
        email: '365meo@gmail.com',
        password: 'password',
        role: 'OWNER',
        agency_name: '365MEO',
        google_location_id: 'locations/3018418038085555463',
        google_drive_folder_id: '1AIgemm9-fvP-eLwP7p2p8Plja1mbOJtX',
        line_user_id: process.env.LINE_USER_ID || 'U205e0595cff6e3882288962525941500',
        reply_active: true,
        custom_review_prompt: '株式会社３６５のカスタマーサポートとして、極めて真摯にお詫びしてください。店舗様の売上向上に本気で伴走する企業として、サービス改善へ向けて早急に対応する熱い誠意を伝えてください。',
      },
    });
    console.log('🏬 Created 365MEO Shop.');
  } else {
    shop3 = await prisma.shop.update({
      where: { id: '365meo-shop-uuid' },
      data: { agency_name: '365MEO' }
    });
  }

  // Check if mock store under 代理店A exists
  const shopAExists = await prisma.shop.findUnique({
    where: { id: 'mock-shop-a-uuid' }
  });

  if (!shopAExists) {
    const shopA = await prisma.shop.create({
      data: {
        id: 'mock-shop-a-uuid',
        name: 'テストヘアサロン 栄店',
        email: 'salon.sakae@example.com',
        password: 'password',
        role: 'OWNER',
        agency_name: '代理店A',
        google_location_id: null,
        google_drive_folder_id: null,
        reply_active: true,
      }
    });

    await prisma.shopKeywords.create({
      data: {
        shop_id: shopA.id,
        main_keywords: JSON.stringify(['栄 美容室', 'カット', 'カラー']),
        sub_keywords: JSON.stringify(['トリートメント', 'ヘッドスパ']),
        fixed_footer: '店舗名: テストヘアサロン 栄店\n住所: 名古屋市中区栄3丁目',
        custom_prompt: 'アットホームな雰囲気をアピールしてください。',
      }
    });
    console.log('🏬 Created Mock Shop A under 代理店A.');
  }

  // Check if mock store under 代理店B exists
  const shopBExists = await prisma.shop.findUnique({
    where: { id: 'mock-shop-b-uuid' }
  });

  if (!shopBExists) {
    const shopB = await prisma.shop.create({
      data: {
        id: 'mock-shop-b-uuid',
        name: 'テスト居酒屋 錦店',
        email: 'izakaya.nishiki@example.com',
        password: 'password',
        role: 'OWNER',
        agency_name: '代理店B',
        google_location_id: null,
        google_drive_folder_id: null,
        reply_active: true,
      }
    });

    await prisma.shopKeywords.create({
      data: {
        shop_id: shopB.id,
        main_keywords: JSON.stringify(['錦 居酒屋', '焼き鳥', '個室']),
        sub_keywords: JSON.stringify(['飲み放題', '接待']),
        fixed_footer: '店舗名: テスト居酒屋 錦店\n住所: 名古屋市中区錦3丁目',
        custom_prompt: '賑やかで活気のある雰囲気をアピールしてください。',
      }
    });
    console.log('🏬 Created Mock Shop B under 代理店B.');
  }

  // Check if ShopKeywords for 365MEO exists
  const keywordsExists = await prisma.shopKeywords.findUnique({
    where: { shop_id: '365meo-shop-uuid' }
  });

  if (!keywordsExists && shop3) {
    await prisma.shopKeywords.create({
      data: {
        shop_id: shop3.id,
        main_keywords: JSON.stringify(['名古屋 MEO', 'MEO対策', 'Googleマップ集客', 'ローカルSEO', '365MEO']),
        sub_keywords: JSON.stringify(['口コミ対策', 'GBP運用', 'マップ順位', '集客効果', '名古屋マーケティング', '店舗集客', '自動投稿', 'SNS連動', '口コミ返信', 'AI作成']),
        fixed_footer: '店舗名: 株式会社３６５\n住所: 名古屋市中区',
        custom_prompt: '丁寧で自然なトーンで、MEO集客サポートの魅力を訴求してください。',
        hp_url: null,
        tabelog_url: null,
        hotpepper_url: null,
        gurunavi_url: null,
        gbp_action_url: null,
        draft_posts: null,
      },
    });
    console.log('🔑 Created ShopKeywords for 365MEO.');
  }

  // Check if ReplyTemplates for 365MEO exists
  const templatesExists = await prisma.replyTemplates.findFirst({
    where: { shop_id: '365meo-shop-uuid' }
  });

  if (!templatesExists && shop3) {
    const defaultStar3 = [
      'ご来店および貴重なご意見をいただきありがとうございます。ご指摘いただいた点を真摯に受け止め、今後のサービス向上に役立ててまいります。',
      'この度はご来店いただきありがとうございました。至らない点があったことをお詫びするとともに、スタッフ一同、よりご満足いただけるお店づくりに努めてまいります。',
      'ご感想をお寄せいただきありがとうございます。いただいたご意見を店舗全体で共有し、改善を重ね要領よく対応してまいります。またのご来店をお待ちしております。',
      'ご来店ありがとうございました。お褒めいただいた点も、ご指摘いただいた点も大変参考になります。今後ともよろしくお願いいたします。',
      'ご意見ありがとうございます。次回ご来店の際には、より良いサービスを提供できるよう、スタッフ教育や設備改善に取り組んでまいります。'
    ];

    const defaultStar4 = [
      'この度はご来店いただき、また高評価をありがとうございます！ご満足いただけて大変嬉しく思います。またのお越しを心よりお待ちしております。',
      'お忙しい中、嬉しい口コミをご投稿いただき誠にありがとうございます。これからも素敵なお時間を提供できるよう、努力を続けてまいります。',
      'ご来店および素晴らしい評価をありがとうございます。お食事やお店の雰囲気を楽しんでいただけて何よりです。次回のご来店もお待ちしております。',
      '大変嬉しいお声をいただき、スタッフ一同の励みになります！次回はさらにご満足いただけるよう、心を込めておもてなしいたします。',
      'ご投稿ありがとうございます！高評価をいただき感謝申し上げます。今後とも変わらぬご愛顧のほど、よろしくお願い申し上げます。'
    ];

    const defaultStar5 = [
      'この度は最高評価をいただき、誠にありがとうございます！本当に嬉しいお言葉を励みに、これからも最上のサービスを追求してまいります。',
      'ご来店いただき、またお褒めの言葉をいただき大変光栄です！また次回も「来てよかった」と思っていただけるよう、全力を尽くします。',
      '素晴らしい評価をありがとうございます！当店での時間が素敵な思い出となったのであれば幸いです。またのご来店を心よりお待ちしております！',
      'スタッフ全員が笑顔になる最高の口コミをありがとうございます！いただいたエネルギーを糧に、次回も完璧な施術・サービスを提供します。',
      'ご来店ありがとうございました！星5つの満点評価をいただき感謝の極みです。これからもお客様に愛され続けるお店を目指して頑張ります！'
    ];

    await prisma.replyTemplates.create({
      data: {
        shop_id: shop3.id,
        templates_star3: JSON.stringify(defaultStar3),
        templates_star4: JSON.stringify(defaultStar4),
        templates_star5: JSON.stringify(defaultStar5),
      },
    });
    console.log('📝 Seeded default static ReplyTemplates.');
  }

  console.log('🟢 Database seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed with error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
