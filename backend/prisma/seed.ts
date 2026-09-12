import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seeding (safe mode)...');

  // Check if admin shop exists
  const adminExists = await prisma.shop.findUnique({
    where: { id: 'admin-seiha-uuid' }
  });

  if (!adminExists) {
    await prisma.shop.create({
      data: {
        id: 'admin-seiha-uuid',
        name: 'MEO SEIHAシステム管理運営本部',
        email: 'admin@meo-seiha.com',
        password: 'password',
        role: 'ADMIN',
        google_location_id: null,
        google_drive_folder_id: null,
        line_user_id: null,
        reply_active: false,
        post_active: false,
        custom_review_prompt: null,
      },
    });
    console.log('👮 Created Admin User.');
  }

  // Seeding Demo Agency X and Avenir Hair demo store
  const targetAgencyId = 'demo-agency-uuid';
  const targetAvenirId = 'demo-store-uuid';

  const agencyExists = await prisma.shop.findUnique({
    where: { id: targetAgencyId }
  });

  if (!agencyExists) {
    console.log('✨ Seeding AGENCY account "代理店X" for the first time...');
    await prisma.shop.create({
      data: {
        id: targetAgencyId,
        name: '代理店X',
        email: 'meoseiha@dairiten.x',
        password: 'meoseiha@dairiten.x',
        role: 'AGENCY',
        agency_name: '代理店X',
        reply_active: false,
        post_active: true,
      }
    });

    await prisma.shop.create({
      data: {
        id: targetAvenirId,
        name: '美髪改善サロン Avenir Hair',
        email: 'meoseiha@avenir',
        password: 'meoseiha@avenir',
        role: 'OWNER',
        agency_name: '代理店X',
        google_location_id: 'locations/demo-loc-365',
        google_drive_folder_id: '10c1rRfqpsdLRz_ZlOgEXJFR7BoVsRjXe',
        line_user_id: 'U205e0595cff6e3882288962525941500',
        reply_active: true,
        post_active: true,
        custom_review_prompt: '完全個室のリラックス空間と、髪を傷めない最先端の髪質改善トリートメント、そして丁寧なカウンセリング技術を上品かつ温かみのあるトーンでPRしてください。不満のお言葉には深くお詫びし、接客改善と誠実なカウンセリング教育を徹底する姿勢を示してください。',
      }
    });

    // Keywords
    await prisma.shopKeywords.create({
      data: {
        shop_id: targetAvenirId,
        main_keywords: JSON.stringify(['栄 美容室', '名古屋 髪質改善', '栄 カット', '髪質改善 サロン']),
        sub_keywords: JSON.stringify(['完全個室サロン', '縮毛矯正 栄', '白髪染め 名古屋', 'トリートメント 推奨']),
        fixed_footer: '店舗名: 美髪改善サロン Avenir Hair (アヴニールヘア)\n住所: 愛知県名古屋市中区栄3丁目\n営業時間: 10:00〜20:00 (完全予約制)\n定休日: 毎週月曜日\nご予約・お問い合わせはお気軽にどうぞ！',
        custom_prompt: '完全個室のリラックス空間と、髪を傷めない最先端の髪質改善トリートメント、そして丁寧なカウンセリング技術を上品かつ温かみのあるトーンでPRしてください。',
        hp_url: 'https://avenir-hair-demo.example.com',
        tabelog_url: '',
        hotpepper_url: 'https://beauty.hotpepper.jp/avenir-hair-demo',
        gurunavi_url: '',
        gbp_action_url: 'https://beauty.hotpepper.jp/avenir-hair-demo/reserve',
        post_time_hour: 12,
        draft_posts: JSON.stringify([
          {
            dayIndex: 0,
            title: '今日投稿予定の下書き (Day 0)',
            text: '【髪質改善】栄駅徒歩5分の完全個室サロン Avenir Hair です。\n当サロンでは、お客様一人ひとりの髪質やクセに徹底的に向き合う「丁寧なカウンセリング技術」を大切にしています。\n\n栄で完全個室だからこそ、周りを気にせず髪のパサつきやダメージについて髪質改善トリートメントのご相談をいただけます。\n\n・オーダーメイド of the hood, 極上髪質改善メニュー\n・完全個室のリラックスできるサロン空間\n・髪を傷めない最先端トリートメント技術\n\nお客様の髪本来の輝きとサロントリートメントによる感動的な艶を引き出します。\nお体のメンテナンスを兼ねて、ぜひ下記の「詳細」ボタンよりご予約情報をご確認ください。',
            subKeywords: ['完全個室サロン', 'トリートメント 推奨'],
            imageFileId: '1ICy4qoD6qjOr-w4vD6T3I_xEAxMY0N4B'
          },
          {
            dayIndex: 1,
            title: '明日投稿予定の下書き (Day 1)',
            text: '【縮毛矯正】うねりやくせ毛でお悩みなら栄の「Avenir Hair」にお任せください。\n当サロンでは、髪を傷めない最先端の薬剤を使用し、髪質改善トリートメントを同時に配合した縮毛矯正をご提供しています。\n\n完全個室のリラックスした極上空間で、仕上がりは驚くほど柔らかく滑らかな艶髪を実現します。\n\n・うねりやクセを自然に抑える縮毛矯正\n・丁寧なカウンセリングでお悩み徹底解消\n・縮毛矯正と髪質改善のダブルアプローチ\n\n毎朝のスタイリングが感動するほど楽になりますよ。\n詳しくは詳細ボタンよりご予約や空き状況をご確認ください。',
            subKeywords: ['縮毛矯正 栄', '完全個室サロン'],
            imageFileId: '1YRczsnYk5_EpPhY3U7N2RjyyOF8629u_'
          },
          {
            dayIndex: 2,
            title: '明後日投稿予定の下書き (Day 2)',
            text: '【白髪染め】頭皮と髪を優しく守る栄の髪質改善カラーなら「Avenir Hair」です。\n「白髪は染めたいけれど髪のパサつきやダメージが気になる」とお悩みではありませんか？\n\n当サロン独自の髪質改善トリートメントを配合した、優しく低刺激なオーガニックカラーをご提案します。\n\n・白髪染めとトリートメントの極上融合\n・完全個室でゆったり過ごせる大人の隠れ家\n・髪質に合わせたオーダーメイド施術\n\n潤いに満ちた、若々しくしっとりまとまる美しい艶髪に仕上げます。\nぜひ下記の詳細ボタンより空き状況をご確認ください。',
            subKeywords: ['白髪染め 名古屋', 'トリートメント 推奨'],
            imageFileId: '1iLC1rMI5az8xd8nK8tOEK9ZuszpDFHwW'
          }
        ])
      }
    });

    const avenirStar3 = [
      'ご来店および貴重なご意見をいただきありがとうございます。ご指摘いただいた点を真摯に受け止め、今後のサービス向上に役立ててまいります。',
      'この度はご来店いただきありがとうございました。至らない点があったことをお詫びするとともに、スタッフ一同、よりご満足いただけるお店づくりに努めてまいります。',
      'ご感想をお寄せいただきありがとうございます。いただいたご意見を店舗全体で共有し、改善を重ね要領よく対応してまいります。またのご来店をお待ちしております。',
      'ご来店ありがとうございました。お褒めいただいた点も、ご指摘いただいた点も大変参考になります。今後ともよろしくお願いいたします。',
      'ご意見ありがとうございます。次回ご来店の際には、より良いサービスを提供できるよう、スタッフ教育や設備改善に取り組んでまいります。'
    ];
    const avenirStar4 = [
      'この度はご来店いただき、また高評価をありがとうございます！ご満足いただけて大変嬉しく思います。またのお越しを心よりお待ちしております。',
      'お忙しい中、嬉しい口コミをご投稿いただき誠にありがとうございます。これからも素敵なお時間を提供できるよう、努力を続けてまいります。',
      'ご来店および素晴らしい評価をありがとうございます。お食事やお店の雰囲いを楽しんでいただけて何よりです。次回のご来店もお待ちしております。',
      '大変嬉しいお声をいただき、スタッフ一同の励みになります！次回はさらにご満足いただけるよう、心を込めておもてなしいたします。',
      'ご投稿ありがとうございます！高評価をいただき感謝申し上げます。今後とも変わらぬご愛顧 of the hood, よろしくお願い申し上げます。'
    ];
    const avenirStar5 = [
      'この度は最高評価をいただき、誠にありがとうございます！本当に嬉しいお言葉を励みに、これからも最上のサービスを追求してまいります。',
      'ご来店いただき、またお褒めの言葉をいただき大変光栄です！また次回も「来てよかった」と思っていただけるよう、全力を尽くします。',
      '素晴らしい評価をありがとうございます！当店での時間が素敵な思い出となったのであれば幸いです。またのご来店を心よりお待ちしております！',
      'スタッフ全員が笑顔になる最高の口コミをありがとうございます！いただいたエネルギーを糧に、次回も完璧な施術・サービスを提供します。',
      'ご来店ありがとうございました！星5つの満点評価をいただき感謝の極みです。これからもお客様に愛され続けるお店を目指して頑張ります！'
    ];
    await prisma.replyTemplates.create({
      data: {
        shop_id: targetAvenirId,
        templates_star3: JSON.stringify(avenirStar3),
        templates_star4: JSON.stringify(avenirStar4),
        templates_star5: JSON.stringify(avenirStar5),
      },
    });

    // Review Logs
    await prisma.reviewLogs.create({
      data: {
        shop_id: targetAvenirId,
        review_id: 'review-star-5',
        reviewer_name: '田中 瑞希',
        star_rating: 5,
        comment: 'カウンセリングがとても丁寧で、私の髪質に合わせたオーダーメイドの髪質改善トメントをしていただきました。仕上がりは驚くほどサラサラで、完全個室なので周りを気にせずリラックスできました！またお邪魔します。',
        reply_text: '瑞希様、ご来店いただき満点評価の素晴らしい口コミをありがとうございます！当サロンの丁寧なカウンセリングとオーダーメイドの髪質改善トリートメントを実感していただけて大変光栄です。完全個室のオアシス空間で日頃のお疲れを癒していただけたようで何よりでございます。今後とも瑞希様の美しい艶髪をキープできるよう、全力を尽くしてサポートさせていただきます。次回のご来店も心よりお待ちしております！',
        is_auto_replied: true,
        requires_alert: false,
        escalation_triggered: false,
        reply_source: 'GBP',
        create_time: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
      }
    });

    await prisma.reviewLogs.create({
      data: {
        shop_id: targetAvenirId,
        review_id: 'review-star-2',
        reviewer_name: '渡辺 直美',
        star_rating: 2,
        comment: 'トリートメントの仕上がりはとても満足で髪がツヤツヤになりました。ですが、予約時間から15分ほど待たされ、その際の説明や謝罪が少し冷たくてそっけなく感じられて悲しかったです。お店の雰囲気が素敵なだけに、接客がもう少し温かいと嬉しいです。',
        reply_text: '直美様、この度はご来店いただき、トリートメントの仕上がりにご満足いただけたにもかかわらず、ご案内まで15分ほどお待たせし、スタッフの対応において冷たく不快な思いをさせてしまいましたことを深くお詫び申し上げます。完全個室で癒やしをご提供するサロンとして、お客様への温かいおもてなしを忘れたご対応となり猛省しております。いただいたご指摘をスタッフ全員で共有し、接客と丁寧なカウンセリングの教育を徹底して改善に努めてまいります。貴重なご意見をありがとうございました。',
        is_auto_replied: false,
        requires_alert: true,
        escalation_triggered: false,
        create_time: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)
      }
    });

    await prisma.reviewLogs.create({
      data: {
        shop_id: targetAvenirId,
        review_id: 'review-star-4',
        reviewer_name: '鈴木 健太',
        star_rating: 4,
        comment: 'メンズカットとスカルプケアで利用しました。美容室は少し緊張するのですが、完全個室なので男性でも周りを気にせずリラックスできました。スタイリングの仕方も丁寧に教えてもらえたので大満足です。栄駅から近いのもいいですね。',
        reply_text: '健太様、この度はご来店いただき高評価をありがとうございます！当サロンは完全個室のプライベート空間ですので、男性のお客様も緊張せずリラックスして施術を受けていただけて大変嬉しく思います。スタイリングについてもお役に立てたようで幸いです。また何か気になる点やヘアスタイルのご要望がございましたら、お気軽にカウンセリングにてご相談くださいね。健太様のまたのご来店を心よりお待ちしております！',
        is_auto_replied: true,
        requires_alert: false,
        escalation_triggered: false,
        reply_source: 'GBP',
        create_time: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
      }
    });

    await prisma.reviewLogs.create({
      data: {
        shop_id: targetAvenirId,
        review_id: 'review-star-1',
        reviewer_name: '佐藤 優一',
        star_rating: 1,
        comment: '記念日の前なので奮発して指名で予約して行きましたが、ダブルブッキングしていたのか別のスタッフがメインで担当され、指名料を払っているのに説明も謝罪もありませんでした。非常に不快で残念な記念日になりました。二度と行きません。',
        reply_text: '優一様、この度は大切な記念日の前に当サロンをご予約いただき、楽しみにお越しいただいたにもかかわらず、当店の予約連携不足により別のスタッフがメインで対応し、かつ指名料に対する十分なご説明や真摯な謝罪を怠るという不手際がありましたことを心より深くお詫び申し上げます。せっかくの記念日の前のお気持ちを台無しにしてしまいましたことを猛省しております。指名管理体制の厳重な見直しと、接客教育の徹底を図り再発防止に努めてまいります。貴重なご指摘をありがとうございました。',
        is_auto_replied: false,
        requires_alert: true,
        escalation_triggered: true,
        create_time: new Date(Date.now() - 12 * 60 * 60 * 1000)
      }
    });

    console.log('📝 Seeded default static ReviewLogs for Avenir Hair.');
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
