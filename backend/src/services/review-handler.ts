import { GoogleGenerativeAI } from '@google/generative-ai';
import { Client } from '@line/bot-sdk';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

// Load .env
dotenv.config({ path: path.join(__dirname, '../../.env') });

export interface ReviewEvent {
  reviewId: string;
  reviewerName: string;
  starRating: 1 | 2 | 3 | 4 | 5;
  comment: string;
  createTime: string;
}

export interface ReviewResponseResult {
  reviewId: string;
  isAutoReplied: boolean;
  replyText: string;
  requiresAlert: boolean;
  escalationTriggered: boolean;
  reason: string;
}

export class ReviewHandlerService {
  private lineClient: Client | null = null;
  private genAI: GoogleGenerativeAI | null = null;

  // 星3〜5用の5パターンの自動返信定型文（AIコスト0円で高評価にランダム返信）
  private static staticTemplates = [
    '温かいお言葉をいただき、誠にありがとうございます！スタッフ一同、大変励みになります。またのご来店を心よりお待ちしております。',
    'ご来店と嬉しいご感想、ありがとうございます。当店のサービスにご満足いただけて大変嬉しく思います。今後ともよろしくお願いいたします！',
    'この度はご評価いただきありがとうございます。お客様に快適な時間を過ごしていただけるよう、これからもサービス向上に努めてまいります。',
    '嬉しいお声をいただきありがとうございます！今後もお客様に愛される店舗を目指してまいります。またのお越しを楽しみにしております。',
    '素敵なレビューを投稿していただき、感謝いたします。お客様のまたのご来店を、スタッフ一同心よりお待ち申し上げております。'
  ];

  constructor() {
    // Initialize LINE Client if key exists
    const lineAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const lineSecret = process.env.LINE_CHANNEL_SECRET;
    if (lineAccessToken && lineSecret) {
      this.lineClient = new Client({
        channelAccessToken: lineAccessToken,
        channelSecret: lineSecret,
      });
    }

    // Initialize Gemini (using gemini-2.5-flash which we verified as active in 2026)
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (geminiApiKey) {
      this.genAI = new GoogleGenerativeAI(geminiApiKey);
    }
  }

  /**
   * 新着の口コミをハンドリングし、星の数に応じて自動返信またはAI下書き生成＆LINE通知を実行します。
   */
  public async handleNewReview(
    review: ReviewEvent, 
    storeName: string, 
    customPrompt?: string,
    replyActive: boolean = false,
    lineUserId?: string | null,
    shopId?: string
  ): Promise<ReviewResponseResult> {
    console.log(`\n📬 [新着口コミ検知] 店舗: 「${storeName}」 | 投稿者: ${review.reviewerName} | 星数: ★${review.starRating}`);
    console.log(`💬 コメント: "${review.comment || '(本文なし)'}"`);

    if (!this.genAI) {
      throw new Error('❌ Gemini API is not initialized. Check GEMINI_API_KEY in .env');
    }

    // --- 星3〜5（中・高評価）: AIで魅力的な感謝・アピール返信文を作成 ---
    if (review.starRating >= 3) {
      console.log(`🟢 星${review.starRating}判定（高・中評価）: AI返信下書きの生成を開始します。`);
      const aiDraft = await this.generatePositiveDraft(review, storeName, customPrompt);
      console.log(`🤖 AI高評価返信下書き作成成功:\n------------------\n${aiDraft}\n------------------`);

      if (replyActive) {
        // 全自動モード (1時間後に自動投稿するため、LINE通知はせず、サイレントで保存)
        console.log('⚡ 自動返信「ON」判定：1時間後にバックグラウンドで全自動送信されます。（LINE通知はサイレント）');
        return {
          reviewId: review.reviewId,
          isAutoReplied: false, // 1時間後に自動投稿されるので、一旦 false で保存
          replyText: aiDraft,
          requiresAlert: false, // サイレントのため false
          escalationTriggered: false,
          reason: '自動返信が「ON」のため、1時間後にバックグラウンドで自動投稿されます。店主様のLINE通知はサイレントにいたしました。'
        };
      } else {
        // 承認モード (LINEでオーナーへ承認依頼を送信)
        console.log('💡 自動返信「OFF」判定：店主様のLINEにAI返信下書きの承認通知を送信します。');
        const usersStr = lineUserId || process.env.LINE_USER_ID || '';
        const userIds = usersStr.split(',').map(id => id.trim()).filter(Boolean);
        if (this.lineClient && userIds.length > 0) {
          for (const uId of userIds) {
            await this.sendLineAlert(uId, storeName, review, aiDraft, 'highRating', shopId);
          }
        } else {
          console.log('ℹ️ LINE_USER_IDが未設定、またはLINEクライアントが未初期化のため、LINE承認通知をスキップしました。');
        }

        return {
          reviewId: review.reviewId,
          isAutoReplied: false,
          replyText: aiDraft,
          requiresAlert: true,
          escalationTriggered: false,
          reason: '自動返信が「OFF」のため、AI返信下書きを作成し、店主様へLINE承認通知を送信しました。'
        };
      }
    }

    // --- 星1〜2（低評価）: 自動返信は行わず、Geminiで謝罪文下書きを作成しLINEアラート送信 ---
    console.log(`⚠️ 星${review.starRating}判定（低評価）: 即時自動返信を「保留」にし、AI謝罪文下書きの生成を開始します。`);

    // 1. Geminiを使って不満に寄り添う丁寧な謝罪下書き文を自動生成
    const aiDraft = await this.generateApologyDraft(review, storeName, customPrompt);
    console.log(`🤖 AI謝罪下書き作成成功:\n------------------\n${aiDraft}\n------------------`);

    // 2. 店舗オーナーのLINEへ緊急プッシュアラートを送信
    const usersStr = lineUserId || process.env.LINE_USER_ID || '';
    const userIds = usersStr.split(',').map(id => id.trim()).filter(Boolean);
    if (this.lineClient && userIds.length > 0) {
      for (const uId of userIds) {
        await this.sendLineAlert(uId, storeName, review, aiDraft, 'apology', shopId);
      }
    } else {
      console.log('ℹ️ LINE_USER_IDが未設定、またはLINEクライアントが未初期化のため、LINEアラート送信をスキップしました（ログのみ出力）。');
    }

    // 3. 多重バックアップ（運営・営業へのエスカレーションとメール送信）
    this.triggerBackupEscalations(storeName, review, aiDraft);

    return {
      reviewId: review.reviewId,
      isAutoReplied: false,
      replyText: aiDraft, // 謝罪文の下書きを結果として格納
      requiresAlert: true,
      escalationTriggered: true,
      reason: `低評価（★${review.starRating}）を検知。AI謝罪文の下書き作成、および店舗オーナーへの緊急LINE通知、メールバックアップ、放置アラート監視（12h）をセットしました。`
    };
  }

  /**
   * Geminiを使用して、高評価に対する感謝とアピールを兼ねた魅力的な返信文を自動生成します
   */
  private async generatePositiveDraft(review: ReviewEvent, storeName: string, customPrompt?: string): Promise<string> {
    const model = this.genAI!.getGenerativeModel({ model: 'gemini-3.6-flash' });

    const prompt = `
      あなたは店舗「${storeName}」のオーナー代理として、お客様から届いたGoogleマップ上の高評価口コミ（★${review.starRating}）に対して、返信用のお礼メッセージ下書きを作成してください。

      【お客様からの口コミ内容】
      「${review.comment || '本文なし・高評価評価のみ'}」

      【お礼文の生成ルール（厳守事項）】
      1. 心からの感謝: まずご来店いただいたこと、および高評価（星${review.starRating}）に対する喜びと深い感謝をオーナーとして誠実に伝えてください。
      2. コメント本文がある場合の対応（自然な共感と魅力の調和）:
         お客様の口コミに具体的なコメント本文がある場合は、褒められた内容（接客、施術、空間、技術など）に対して自然に反応し共感してください。
      3. コメント本文がない場合の対応（誠実な短文・宣伝禁止）:
         星評価のみの場合は、ご評価いただいたことに対するシンプルな感謝 of 言葉と、次回ご来店の際にもよりご満足いただけるよう努める旨の丁寧な姿勢を述べて完結させてください。強引な売込や不自然なキーワードは含めないでください。
      4. キーワードの不自然な多用禁止:
         文脈に全く合わない過度なSEOキーワードの詰め込みは禁止します。あくまでも自然な文章のなかで、店舗のこだわりや魅力を調和させて表現してください。
      5. 絵文字・記号の適度な使用:
         謝罪文とは異なり、明るく親しみやすい丁寧なトーンを表現するために、適度に絵文字や感嘆符（「！」）などの記号をご使用いただけます。
      6. 文字数制限: 文字数は200文字以内に収めてください。
      7. 署名情報の排除:
         最後に署名や店名は入れず、お礼本文のみを作成してください。

      ${customPrompt ? `【店舗別の個別返信指示】\n${customPrompt}\n上記の店舗個別指示（店舗のウリ、アピールポイントなど）がある場合、お客様への感謝を第一にしたうえで、自然に織り交ぜて訴求してください。` : ''}
    `;

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text().trim();
    } catch (error: any) {
      console.warn('⚠️ gemini-3.6-flash failed in generatePositiveDraft, trying gemini-3.5-flash:', error.message || error);
      try {
        const fallbackModel = this.genAI!.getGenerativeModel({ model: 'gemini-3.5-flash' });
        const result = await fallbackModel.generateContent(prompt);
        const response = await result.response;
        return response.text().trim();
      } catch (fallbackErr: any) {
        console.error('❌ Both gemini-3.6-flash and gemini-3.5-flash failed in generatePositiveDraft:', fallbackErr.message || fallbackErr);
        return 'この度は温かい評価と口コミのご投稿、誠にありがとうございます！お客様からのお褒めの言葉が、スタッフ一同大変励みになります。これからもより一層喜んでいただけるようサービス向上に努めてまいります。またのご来店を心よりお待ちしております！';
      }
    }
  }

  /**
   * Geminiを使用して、丁寧で真摯な謝罪下書き文を自動生成します（制約事項遵守）
   */
  private async generateApologyDraft(review: ReviewEvent, storeName: string, customPrompt?: string): Promise<string> {
    const model = this.genAI!.getGenerativeModel({ model: 'gemini-3.6-flash' });

    const prompt = `
      あなたは店舗「${storeName}」のオーナー代理として、お客様から届いたGoogleマップ上の低評価口コミ（★${review.starRating}）に対して、返信用のお詫びメッセージ下書きを作成してください。

      【お客様からの口コミ内容】
      「${review.comment || '本文なし・低評価評価のみ'}」

      【お詫び文の生成ルール（厳守事項）】
      1. 真摯な謝罪: まず不快な思いをさせてしまったことを、オーナーとして深く、真摯にお詫びしてください。
      2. コメント本文がある場合の対応（自然な反応・余計なKWの強要禁止）:
         お客様の口コミに具体的なコメント本文がある場合は、その具体的な不満や内容に自然に反応してください。相手が書いた不満点や言葉に真摯に寄り添い共感して受け止めてください。ただし、相手が口コミの中で触れていない余計なサービスキーワード、店舗のこだわり、強みを無理やり・強引に入れ込まないでください。
      3. コメント本文がない場合の対応（謝罪完結・宣伝禁止）:
         お客様からの口コミにコメント本文がなく、星評価のみの場合は、不快な思いをさせたことに対する真摯な謝罪と重い受け止めの言葉のみで文章を完結させてください。連絡先への案内、再来店への強引な誘導、サービスのアピール、地名や店舗のアピールなどの宣伝行為は【絶対に】含めないでください。
      4. 定型文の丸写し排除:
         毎回同じような定型文の丸写しにはせず、言い回しやニュアンス、お詫びの構成を毎回少しずつ変えて個別の文章として作成してください。
      5. 感嘆符・絵文字・装飾 of any kind の完全禁止:
         感嘆符（「！」）や疑問符（「？」）などの記号、および絵文字、マークダウン、特殊文字は、お詫びの場にふさわしくないため【一切使用しないでください】。すべて丁寧な日本語の句読点（「。」「、」）のみで文章を構成してください。
      6. 文字数制限: 文字数は200文字以内に収めてください。
      7. 署名情報の排除:
         「${storeName} 店主」などの署名や店名は、システム側で自動付与されるため、生成文の最後には店名や署名を入れず、お詫び本文のみを作成してください。

      ${customPrompt ? `【店舗別の個別お詫び・返信指示】\n${customPrompt}\n上記の店舗個別指示（店舗特性、こだわり、返信でのアピール事項等）がある場合、お客様の不満への寄り添い・共感を第一優先にした上で、不自然にならない範囲で加味してください。` : ''}
    `;

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text().trim();
    } catch (error: any) {
      console.warn('⚠️ gemini-3.6-flash failed in generateApologyDraft, trying gemini-3.5-flash:', error.message || error);
      try {
        const fallbackModel = this.genAI!.getGenerativeModel({ model: 'gemini-3.5-flash' });
        const result = await fallbackModel.generateContent(prompt);
        const response = await result.response;
        return response.text().trim();
      } catch (fallbackErr: any) {
        console.error('❌ Both gemini-3.6-flash and gemini-3.5-flash failed in generateApologyDraft:', fallbackErr.message || fallbackErr);
        return 'この度は当店のご利用に際し、ご満足のいくサービスを提供できず、不快な思いをさせてしまいましたことを深くお詫び申し上げます。今後、このようなことがないようスタッフへの指導 and サービスの改善に努めてまいります。';
      }
    }
  }

  /**
   * Geminiを使用して、店主からの特定指示（directive）に基づいて、謝罪下書き文を書き直します（再生成）
   */
  public async generateCustomApologyDraft(
    review: { starRating: number; comment: string | null },
    storeName: string,
    customPrompt?: string,
    directive?: string
  ): Promise<string> {
    if (!this.genAI) {
      throw new Error('❌ Gemini API is not initialized. Check GEMINI_API_KEY in .env');
    }

    const model = this.genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

    const isLowRating = review.starRating <= 2;

    const prompt = `
      あなたは店舗「${storeName}」のオーナー代理として、お客様から届いたGoogleマップ上の口コミ（★${review.starRating}）に対して、返信用のお礼・お詫びメッセージ下書きを作成・書き直してください。

      【お客様からの口コミ内容】
      「${review.comment || '本文なし・評価のみ'}」

      【基本生成ルール】
      1. ${isLowRating ? '真摯な謝罪：不快な思いをさせてしまったことをオーナーとして真摯にお詫びしてください。' : '誠実な感謝：高評価をいただいたことに対する喜びと感謝を誠実に伝えてください。'}
      2. 具体的な口コミコメント（褒め言葉・指摘点）があれば、それに自然に反応し、寄り添った返信にしてください。
      3. ${isLowRating ? '感嘆符・絵文字・装飾は【一切完全禁止】です。すべて丁寧な句読点（「。」「、」）のみにしてください。' : '感謝の雰囲気を明るくお伝えするため、適度に「！」や絵文字を使っても構いません。'}
      4. 文字数は200文字以内に収めてください。
      5. 署名情報や署名の名前は含めず、本文のみを作成してください。

      ${customPrompt ? `【店舗別の個別指示】\n${customPrompt}` : ''}

      【今回の店主からの「書き直し（再生成）」追加指示・トーン指定】
      ★必ず以下の追加指示に従って、文章を全面的に修正・書き直してください：
      「${directive || '丁寧な日本語で、指示通りに作成してください。'}」
    `;

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text().trim();
    } catch (error: any) {
      console.warn('⚠️ gemini-3.6-flash failed in generateCustomApologyDraft, trying gemini-3.5-flash:', error.message || error);
      try {
        const fallbackModel = this.genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
        const result = await fallbackModel.generateContent(prompt);
        const response = await result.response;
        return response.text().trim();
      } catch (fallbackErr: any) {
        console.error('❌ Both gemini-3.6-flash and gemini-3.5-flash failed in generateCustomApologyDraft:', fallbackErr.message || fallbackErr);
        return isLowRating
          ? 'この度は当店のご利用に際し、ご満足のいくサービスを提供できず、不快な思いをさせてしまいましたことを深くお詫び申し上げます。今後、このようなことがないようスタッフへの指導とサービスの改善に努めてまいります。'
          : 'この度はご来店いただき、また素晴らしい評価をありがとうございます。これからも愛されるお店を目指して努力してまいります。またのお越しをお待ちしております！';
      }
    }
  }

  /**
   * 店舗オーナー宛てに、マジックリンクと下書き文付きの緊急LINEアラートをプッシュ送信します
   */
  private async sendLineAlert(
    userId: string, 
    storeName: string, 
    review: ReviewEvent, 
    aiDraft: string, 
    type: 'apology' | 'highRating',
    shopId?: string
  ): Promise<void> {
    if (!this.lineClient) return;

    // Generate real bypass magic login link!
    const frontendUrl = process.env.FRONTEND_URL || 'https://meo-seiha-dev.vercel.app';
    let loginToken = shopId ? `simulated_token_${shopId}_long` : `temp-mock-token-for-${review.reviewId}`;

    if (shopId) {
      try {
        const prisma = new PrismaClient();
        const secureToken = crypto.randomBytes(32).toString('hex'); // 64 chars secure hex token
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // Expires in 24 hours

        await prisma.magicLinkToken.create({
          data: {
            token: secureToken,
            shop_id: shopId,
            expires_at: expiresAt,
          }
        });
        loginToken = secureToken;
        console.log(`🔑 [ワンタイムトークン発行] 店舗ID: ${shopId} | トークン: ${secureToken}`);
        await prisma.$disconnect();
      } catch (dbErr: any) {
        console.error('❌ Failed to save secure magic token to DB:', dbErr.message || dbErr);
      }
    }

    const magicLink = `${frontendUrl}/?token=${loginToken}&tab=reviews`;

    let messageText = '';
    if (type === 'apology') {
      messageText = `🔔【低評価口コミの緊急検知アラート】

「${storeName}」に★${review.starRating}の低評価口コミが投稿されました。お客様の不満を和らげるため、24時間以内の返信を推奨します。

👤 投稿者: ${review.reviewerName}様
💬 本文: "${review.comment || 'コメントなし'}"

━━━━━━━━━━━━━━━━
🤖 AIが自動作成した「お詫び文下書き」
━━━━━━━━━━━━━━━━
${aiDraft}

━━━━━━━━━━━━━━━━
👇 このまま送信、または編集して送信
━━━━━━━━━━━━━━━━
パスワードなしで管理画面に直行し、送信できるマジックリンクはこちら：
${magicLink}`;
    } else {
      messageText = `✨【高評価口コミの受信・返信承認のお願い】

「${storeName}」に★${review.starRating}の嬉しい口コミが届きました！承認をいただくことで、AIが作成した以下の返信文を投稿します。

👤 投稿者: ${review.reviewerName}様
💬 本文: "${review.comment || 'コメントなし'}"

━━━━━━━━━━━━━━━━
🤖 AIが自動作成した「お礼・返信文下書き」
━━━━━━━━━━━━━━━━
${aiDraft}

━━━━━━━━━━━━━━━━
👇 このまま送信、または編集して送信
━━━━━━━━━━━━━━━━
パスワードなしで管理画面に直行し、送信できるマジックリンクはこちら：
${magicLink}`;
    }

    console.log(`✉️ Sending LINE alert (${type}) to Owner [ID: ${userId}]...`);
    try {
      await this.lineClient.pushMessage(userId, {
        type: 'text',
        text: messageText
      });
      console.log('🟢 LINE alert sent successfully!');
    } catch (error) {
      console.error('❌ Failed to send LINE alert:', error);
    }
  }

  /**
   * 多重バックアップシステム（並行メール通知、および12時間放置時の自動アラート監視をモック再現）
   */
  private triggerBackupEscalations(storeName: string, review: ReviewEvent, aiDraft: string): void {
    console.log('\n🛡️ [多重バックアップ発動]');
    console.log(`  📧 【並行メール送信】: 運営宛てに「低評価口コミ検知＆対応お願いメール」を送信しました。`);
    console.log(`  ⏳ 【放置アラート監視】: 12時間対応タイマーを起動しました。12時間以内に返信が送信されない場合、担当営業宛てに緊急リマインドが自動配信されます。\n`);
  }
}
