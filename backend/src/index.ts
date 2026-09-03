import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import * as path from 'path';
import stream from 'stream';
import { google } from 'googleapis';
import { Client } from '@line/bot-sdk';
import { prisma } from './services/db';
import { ReviewHandlerService, ReviewEvent } from './services/review-handler';
import Anthropic from '@anthropic-ai/sdk';

// Load .env
dotenv.config({ path: path.join(__dirname, '../.env') });

const app = express();
const port = process.env.PORT || 3000;

// Initialize LINE Client for webhook and profile lookups
let lineClient: Client | null = null;
const lineAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const lineSecret = process.env.LINE_CHANNEL_SECRET;
if (lineAccessToken && lineSecret) {
  lineClient = new Client({
    channelAccessToken: lineAccessToken,
    channelSecret: lineSecret,
  });
}

// In-memory store for recent LINE senders to allow self-pairing
interface RecentLineSender {
  userId: string;
  displayName: string;
  timestamp: number;
}
const recentLineSenders = new Map<string, RecentLineSender>();

// Enable robust CORS middleware for frontend deployments (Vercel, localhost, etc.)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

// Helper to get Google Auth Client
function getGoogleAuthClient() {
  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectURI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/auth/google/callback';
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientID || !clientSecret || !refreshToken) {
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(clientID, clientSecret, redirectURI);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

// Helper to clean up Google Translation suffixes from review comments
function cleanGoogleComment(comment: string | null): string {
  if (!comment) return '';
  
  // Case 1: Japanese text \n\n(Translated by Google)\n English text
  if (comment.includes('(Translated by Google)')) {
    const parts = comment.split('(Translated by Google)');
    const originalText = parts[0].trim();
    if (originalText) {
      return originalText;
    }
  }
  
  // Case 2: English text \n\n(Original)\n Japanese text
  if (comment.includes('(Original)')) {
    const parts = comment.split('(Original)');
    const originalText = parts[1].trim();
    if (originalText) {
      return originalText;
    }
  }
  
  return comment;
}

// In-memory fallback mock drive files for when Google Drive credentials are not set up
interface MockFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime: string;
  dataUrl?: string;
}

let mockDriveFiles: MockFile[] = [];

// Initialize ReviewHandlerService
const reviewHandler = new ReviewHandlerService();

// ==========================================
// � LINE Messaging API Webhook & Self-Pairing
// ==========================================

// POST /api/line/webhook
app.post('/api/line/webhook', async (req, res) => {
  const events = req.body.events || [];
  console.log(`📡 [LINE Webhook] Received ${events.length} events.`);

  for (const event of events) {
    // We only care about events from users (message, follow, etc.)
    if (event.source && event.source.type === 'user') {
      const userId = event.source.userId;
      console.log(`👤 [LINE Webhook] Event from userId: ${userId}`);

      try {
        let displayName = 'LINEユーザー';
        if (lineClient) {
          // Fetch user profile from LINE API to get their display name
          const profile = await lineClient.getProfile(userId);
          displayName = profile.displayName || 'LINEユーザー';
          console.log(`🌟 [LINE Webhook] Fetched user profile: ${displayName}`);
        } else {
          console.log('⚠️ [LINE Webhook] lineClient is not initialized. Using fallback display name.');
        }

        // Cache the sender with current timestamp
        recentLineSenders.set(userId, {
          userId,
          displayName,
          timestamp: Date.now(),
        });

        // 🌟 UX Enhancement: Auto-reply back to the user on their phone!
        if (lineClient && event.type === 'message') {
          try {
            await lineClient.pushMessage(userId, {
              type: 'text',
              text: `🟢 365MEO連携用のLINEアカウントを検出しました！\n\nニックネーム: 「${displayName}」様\n\n管理画面に戻り、「このアカウントを連携する」ボタンを押して登録を完了してください。`,
            });
          } catch (replyErr: any) {
            console.warn('⚠️ Failed to send auto-reply to user via pushMessage (might be a free tier limit or developer console permissions):', replyErr.message || replyErr);
          }
        }
      } catch (err: any) {
        console.error('❌ [LINE Webhook] Failed to process event:', err.message || err);
      }
    }
  }

  // Always return 200 OK to LINE immediately
  return res.sendStatus(200);
});

// GET /api/line/recent-senders
app.get('/api/line/recent-senders', (req, res) => {
  const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;

  // Clean up senders older than 15 minutes
  for (const [userId, sender] of recentLineSenders.entries()) {
    if (sender.timestamp < fifteenMinutesAgo) {
      recentLineSenders.delete(userId);
    }
  }

  const sendersArray = Array.from(recentLineSenders.values()).sort((a, b) => b.timestamp - a.timestamp);
  return res.json({ success: true, senders: sendersArray });
});

// ==========================================
// � Auth Endpoints
// ==========================================

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password, rememberMe } = req.body;

  try {
    const shop = await prisma.shop.findUnique({
      where: { email },
    });

    if (!shop || shop.password !== password) {
      return res.status(401).json({ error: 'メールアドレスまたはパスワードが正しくありません。' });
    }

    // In a real app we would sign a JWT. Here we return a simple simulated token.
    const token = `simulated_token_${shop.id}_${rememberMe ? 'long' : 'short'}`;

    return res.json({
      token,
      shop: {
        id: shop.id,
        name: shop.name,
        email: shop.email,
        role: shop.role,
        google_location_id: shop.google_location_id,
        google_drive_folder_id: shop.google_drive_folder_id,
        line_user_id: shop.line_user_id,
        reply_active: shop.reply_active,
        post_active: shop.post_active,
        custom_review_prompt: shop.custom_review_prompt,
      }
    });
  } catch (error: any) {
    console.error('❌ Login error:', error);
    return res.status(500).json({ error: 'サーバー内でエラーが発生しました。' });
  }
});

// GET /api/auth/me (Get profile from token)
app.get('/api/auth/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '認証トークンがありません。' });
  }

  const token = authHeader.split(' ')[1];
  let shopId: string | null = null;
  let newToken: string | null = null;

  if (token.startsWith('simulated_token_')) {
    const parts = token.split('_');
    if (parts.length < 3 || parts[0] !== 'simulated' || parts[1] !== 'token') {
      return res.status(401).json({ error: '無効な認証トークンです。' });
    }
    shopId = parts.slice(2, -1).join('_'); // Reconstruct ID if it contains underscores
  } else {
    // Treat as cryptographically secure one-time magic link token
    try {
      const dbToken = await prisma.magicLinkToken.findUnique({
        where: { token: token },
      });

      if (!dbToken) {
        return res.status(401).json({ error: '無効または存在しない認証トークンです。' });
      }

      if (dbToken.is_used) {
        return res.status(401).json({ error: 'このマジックログインリンクは既に使用されています。' });
      }

      if (new Date() > dbToken.expires_at) {
        return res.status(401).json({ error: 'このマジックログインリンクの有効期限（24時間）が切れています。' });
      }

      // Valid magic token! Mark as used immediately to burn it
      await prisma.magicLinkToken.update({
        where: { id: dbToken.id },
        data: { is_used: true }
      });

      shopId = dbToken.shop_id;
      newToken = `simulated_token_${shopId}_long`; // Rotated persistent session token
      console.log(`🔥 [ワンタイムトークン認証成功] マジックリンクを無効化し、セッショントークンを発行しました。店舗ID: ${shopId}`);
    } catch (dbErr: any) {
      console.error('❌ Magic token lookup/use error:', dbErr.message || dbErr);
      return res.status(500).json({ error: '認証処理中にエラーが発生しました。' });
    }
  }

  try {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
    });

    if (!shop) {
      return res.status(404).json({ error: '店舗が見つかりませんでした。' });
    }

    return res.json({
      shop: {
        id: shop.id,
        name: shop.name,
        email: shop.email,
        role: shop.role,
        google_location_id: shop.google_location_id,
        google_drive_folder_id: shop.google_drive_folder_id,
        line_user_id: shop.line_user_id,
        reply_active: shop.reply_active,
        post_active: shop.post_active,
        custom_review_prompt: shop.custom_review_prompt,
      },
      ...(newToken ? { newToken } : {})
    });
  } catch (error) {
    console.error('❌ Auth validation error:', error);
    return res.status(500).json({ error: 'サーバー内でエラーが発生しました。' });
  }
});

// Helper to safely extract shopId from simulated Persistent token
function getShopIdFromToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.split(' ')[1];
  if (token.startsWith('simulated_token_')) {
    const parts = token.split('_');
    if (parts.length < 3 || parts[0] !== 'simulated' || parts[1] !== 'token') {
      return null;
    }
    return parts.slice(2, -1).join('_');
  }
  return null;
}

// GET /api/shops (Get list of all stores - Master / Admin / Agency access)
app.get('/api/shops', async (req, res) => {
  const authHeader = req.headers.authorization;
  const callerShopId = getShopIdFromToken(authHeader);

  if (!callerShopId) {
    return res.status(401).json({ error: '認証トークンが無効または見つかりません。' });
  }

  try {
    const caller = await prisma.shop.findUnique({
      where: { id: callerShopId }
    });

    if (!caller) {
      return res.status(403).json({ error: '呼び出し元のアカウントが見つかりません。' });
    }

    if (caller.role === 'ADMIN') {
      // Master admin: Return all shops (with OWNER role only, exclude AGENCY role)
      const shops = await prisma.shop.findMany({
        where: {
          role: 'OWNER'
        },
        orderBy: { name: 'asc' }
      });
      
      // Fetch all agency accounts so they can be rendered even if they have no stores
      const agencies = await prisma.shop.findMany({
        where: {
          role: 'AGENCY'
        },
        orderBy: { name: 'asc' }
      });
      
      return res.json({ shops, agencies });
    } else if (caller.role === 'AGENCY') {
      // Agency manager: Return only shops where agency_name matches the agency's name or its agency_name
      const agencyName = caller.agency_name || caller.name;
      const shops = await prisma.shop.findMany({
        where: {
          role: 'OWNER',
          agency_name: agencyName
        },
        orderBy: { name: 'asc' }
      });
      return res.json({ shops, agencies: [] });
    } else {
      return res.status(403).json({ error: '店舗一覧を閲覧する権限がありません。' });
    }
  } catch (error) {
    console.error('❌ Failed to fetch shops list:', error);
    return res.status(500).json({ error: '店舗一覧の取得に失敗しました。' });
  }
});

// ==========================================
// 📊 Dashboard & Settings Endpoints
// ==========================================

// GET /api/shops/:shopId/dashboard
app.get('/api/shops/:shopId/dashboard', async (req, res) => {
  const { shopId } = req.params;

  try {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      include: {
        keywords: true,
        review_logs: true,
      }
    });

    if (!shop) {
      return res.status(404).json({ error: '店舗が見つかりませんでした。' });
    }

    // Determine photo stock count
    let imageCount = mockDriveFiles.length;
    let firstFileId = mockDriveFiles.length > 0 ? mockDriveFiles[0].id : null;
    let driveFileIds: string[] = mockDriveFiles.slice(0, 3).map(f => f.id);
    let driveFilesList: { id: string, name: string }[] = mockDriveFiles;

    const auth = getGoogleAuthClient();
    if (auth) {
      try {
        const drive = google.drive({ version: 'v3', auth });
        const driveRes = await drive.files.list({
          q: `parents in '${shop.google_drive_folder_id || 'root'}' and (mimeType = 'image/jpeg' or mimeType = 'image/png' or mimeType = 'image/jpg') and trashed = false`,
          fields: 'files(id, name)',
          pageSize: 1000,
        });
        if (driveRes.data.files) {
          imageCount = driveRes.data.files.length;
          driveFilesList = driveRes.data.files.map((f: any) => ({ id: f.id || '', name: f.name || '' }));
          if (driveRes.data.files.length > 0) {
            firstFileId = driveRes.data.files[0].id || null;
            driveFileIds = driveRes.data.files.slice(0, 3).map(f => f.id || '');
          } else {
            driveFileIds = [];
          }
        }
      } catch (e) {
        console.log('⚠️ Failed to fetch live Drive images for dashboard, using fallback count.');
      }
    }

    // Determine Posting Mode
    let postingMode = 'TEXT_ONLY';
    let postingModeLabel = '画像ストック0枚: テキストのみ投稿モード';
    if (imageCount >= 10) {
      postingMode = 'ALWAYS_IMAGE';
      postingModeLabel = '画像ストック10枚以上: 画像連続投稿モード';
    } else if (imageCount >= 1) {
      postingMode = 'ALTERNATING';
      postingModeLabel = `画像ストック${imageCount}枚（1〜9枚）: 交互投稿モード (画像とテキストを日替わり)`;
    }

    // Count pending bad reviews (Requires alert & not replied)
    const pendingReviewsCount = await prisma.reviewLogs.count({
      where: {
        shop_id: shopId,
        star_rating: { lte: 2 },
        is_auto_replied: false,
      }
    });

    // Determine 3-day drafts
    let draftPostsArr = [];
    if (shop.keywords) {
      if (shop.keywords.draft_posts) {
        try {
          draftPostsArr = JSON.parse(shop.keywords.draft_posts);
        } catch (pErr) {
          console.error('❌ Failed to parse draft_posts JSON:', pErr);
        }
      }
      
      // Auto-clean old dayIndex === -1 if calendar day in JST has changed!
      const publishedItem = draftPostsArr.find((d: any) => d.dayIndex === -1);
      if (publishedItem) {
        try {
          if (!publishedItem.publishedAt) {
            console.log(`🧹 Found legacy posted draft without publishedAt. Cleaning it up.`);
            draftPostsArr = draftPostsArr.filter((d: any) => d.dayIndex !== -1);
            await prisma.shopKeywords.update({
              where: { shop_id: shopId },
              data: {
                draft_posts: JSON.stringify(draftPostsArr)
              }
            });
          } else {
            const formatter = new Intl.DateTimeFormat('ja-JP', {
              timeZone: 'Asia/Tokyo',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit'
            });
            const todayDateStr = formatter.format(new Date());
            const pubDateStr = formatter.format(new Date(publishedItem.publishedAt));

            if (todayDateStr !== pubDateStr) {
              console.log(`🧹 Calendar day changed in JST! Removing previous day's posted draft (-1) from database. (Today: ${todayDateStr}, Published: ${pubDateStr})`);
              draftPostsArr = draftPostsArr.filter((d: any) => d.dayIndex !== -1);
              
              // Save cleaned array to DB
              await prisma.shopKeywords.update({
                where: { shop_id: shopId },
                data: {
                  draft_posts: JSON.stringify(draftPostsArr)
                }
              });
            }
          }
        } catch (cleanErr: any) {
          console.error('⚠️ Failed to clean up previous day posted draft:', cleanErr.message || cleanErr);
        }
      }
      
      // If empty, auto-generate 3-day drafts using Gemini AI
      if (draftPostsArr.length === 0) {
        console.log(`🤖 First-time auto-generating 3-day drafts for shop: ${shop.name}`);
        try {
          const day0 = await generateSingleDraft(shop, 0, driveFilesList);
          const day1 = await generateSingleDraft(shop, 1, driveFilesList);
          const day2 = await generateSingleDraft(shop, 2, driveFilesList);

          draftPostsArr = [
            { dayIndex: 0, title: '今日投稿予定の下書き (Day 0)', text: day0.text, subKeywords: day0.subKeywords, imageFileId: day0.imageFileId || null },
            { dayIndex: 1, title: '明日投稿予定の下書き (Day 1)', text: day1.text, subKeywords: day1.subKeywords, imageFileId: day1.imageFileId || null },
            { dayIndex: 2, title: '明後日投稿予定の下書き (Day 2)', text: day2.text, subKeywords: day2.subKeywords, imageFileId: day2.imageFileId || null },
          ];

          // Save to database
          await prisma.shopKeywords.update({
            where: { shop_id: shopId },
            data: { draft_posts: JSON.stringify(draftPostsArr) },
          });
        } catch (genError) {
          console.error('❌ Failed to first-time generate drafts:', genError);
          // Fallback static drafts to avoid crashing Dashboard load
          draftPostsArr = [
            { dayIndex: 0, title: '今日投稿予定の下書き (Day 0)', text: `${shop.name}の本日のおしらせ下書きです。`, subKeywords: [] },
            { dayIndex: 1, title: '明日投稿予定の下書き (Day 1)', text: `${shop.name}の明日のおしらせ下書きです。`, subKeywords: [] },
            { dayIndex: 2, title: '明後日投稿予定の下書き (Day 2)', text: `${shop.name}の明後日のおしらせ下書きです。`, subKeywords: [] },
          ];
        }
      }
    }

    // Resolve draft posts strictly using database-stored image assignments
    const resolvedDrafts = draftPostsArr.map((d: any) => {
      return {
        ...d,
        imageFileId: d.imageFileId || null
      };
    });

    // Find the image for today's scheduled post (dayIndex === 0)
    const day0Draft = resolvedDrafts.find((d: any) => d.dayIndex === 0);
    const day0ImageFileId = day0Draft ? day0Draft.imageFileId : null;

    // Dynamic preview image pointing to our proxy stream endpoint!
    const previewImage = day0ImageFileId
      ? `/api/shops/${shopId}/drive-images/${day0ImageFileId}/view`
      : (firstFileId ? `/api/shops/${shopId}/drive-images/${firstFileId}/view` : null);

    return res.json({
      shopName: shop.name,
      replyActive: shop.reply_active,
      postActive: shop.post_active,
      imageCount,
      postingMode,
      postingModeLabel,
      pendingReviewsCount,
      nextPostTime: `本日 ${(shop.keywords as any)?.post_time_hour ?? 12}:00 予定`,
      previewImage,
      googleLocationId: shop.google_location_id,
      gbpActionUrl: shop.keywords?.gbp_action_url || null,
      draftPosts: resolvedDrafts,
    });
  } catch (error) {
    console.error('❌ Dashboard fetch error:', error);
    return res.status(500).json({ error: 'ダッシュボードの取得に失敗しました。' });
  }
});

// POST /api/shops/:shopId/toggle-reply
app.post('/api/shops/:shopId/toggle-reply', async (req, res) => {
  const { shopId } = req.params;
  const { active } = req.body;

  try {
    const updated = await prisma.shop.update({
      where: { id: shopId },
      data: { reply_active: active },
    });

    return res.json({ success: true, replyActive: updated.reply_active });
  } catch (error) {
    console.error('❌ Toggle reply error:', error);
    return res.status(500).json({ error: '自動返信の切り替えに失敗しました。' });
  }
});

// POST /api/shops/:shopId/toggle-post
app.post('/api/shops/:shopId/toggle-post', async (req, res) => {
  const { shopId } = req.params;
  const { active } = req.body;

  try {
    const updated = await prisma.shop.update({
      where: { id: shopId },
      data: { post_active: active },
    });

    return res.json({ success: true, postActive: updated.post_active });
  } catch (error) {
    console.error('❌ Toggle post error:', error);
    return res.status(500).json({ error: '自動投稿の切り替えに失敗しました。' });
  }
});

// GET /api/shops/:shopId/settings
app.get('/api/shops/:shopId/settings', async (req, res) => {
  const { shopId } = req.params;

  try {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      include: {
        keywords: true,
      }
    });

    if (!shop) {
      return res.status(404).json({ error: '店舗が見つかりませんでした。' });
    }

    const mainKeywords = shop.keywords ? JSON.parse(shop.keywords.main_keywords) : [];
    const subKeywords = shop.keywords ? JSON.parse(shop.keywords.sub_keywords) : [];

    return res.json({
      shopId: shop.id,
      shopName: shop.name,
      replyActive: shop.reply_active,
      postActive: shop.post_active,
      customReviewPrompt: shop.custom_review_prompt || '',
      lineUserId: shop.line_user_id || '',
      keywords: {
        mainKeywords,
        subKeywords,
        fixedFooter: shop.keywords?.fixed_footer || '',
        customPrompt: shop.keywords?.custom_prompt || '',
        hpUrl: shop.keywords?.hp_url || '',
        tabelogUrl: shop.keywords?.tabelog_url || '',
        hotpepperUrl: shop.keywords?.hotpepper_url || '',
        gurunaviUrl: shop.keywords?.gurunavi_url || '',
        gbpActionUrl: shop.keywords?.gbp_action_url || '',
        postTimeHour: (shop.keywords as any)?.post_time_hour ?? 12,
      }
    });
  } catch (error) {
    console.error('❌ Settings fetch error:', error);
    return res.status(500).json({ error: '設定情報の取得に失敗しました。' });
  }
});

// POST /api/shops/:shopId/settings
app.post('/api/shops/:shopId/settings', async (req, res) => {
  const { shopId } = req.params;
  const { replyActive, postActive, customReviewPrompt, lineUserId, keywords } = req.body;

  try {
    // 1. Update Shop Profile details
    await prisma.shop.update({
      where: { id: shopId },
      data: {
        custom_review_prompt: customReviewPrompt,
        reply_active: typeof replyActive === 'boolean' ? replyActive : true,
        post_active: typeof postActive === 'boolean' ? postActive : true,
        line_user_id: lineUserId || null,
      }
    });

    // 2. Update/Upsert Keywords
    if (keywords) {
      const mainKeywordsStr = JSON.stringify(keywords.mainKeywords || []);
      const subKeywordsStr = JSON.stringify(keywords.subKeywords || []);

      await prisma.shopKeywords.upsert({
        where: { shop_id: shopId },
        update: {
          main_keywords: mainKeywordsStr,
          sub_keywords: subKeywordsStr,
          fixed_footer: keywords.fixedFooter,
          custom_prompt: keywords.customPrompt,
          hp_url: keywords.hpUrl,
          tabelog_url: keywords.tabelogUrl,
          hotpepper_url: keywords.hotpepperUrl,
          gurunavi_url: keywords.gurunaviUrl,
          gbp_action_url: keywords.gbpActionUrl,
          post_time_hour: typeof keywords.postTimeHour === 'number' ? keywords.postTimeHour : 12,
        },
        create: {
          shop_id: shopId,
          main_keywords: mainKeywordsStr,
          sub_keywords: subKeywordsStr,
          fixed_footer: keywords.fixedFooter,
          custom_prompt: keywords.customPrompt,
          hp_url: keywords.hpUrl,
          tabelog_url: keywords.tabelogUrl,
          hotpepper_url: keywords.hotpepperUrl,
          gurunavi_url: keywords.gurunaviUrl,
          gbp_action_url: keywords.gbpActionUrl,
          post_time_hour: typeof keywords.postTimeHour === 'number' ? keywords.postTimeHour : 12,
        }
      });
    }

    return res.json({ success: true, message: '設定を正常に保存しました。' });
  } catch (error) {
    console.error('❌ Settings save error:', error);
    return res.status(500).json({ error: '設定の保存に失敗しました。' });
  }
});

// ==========================================
// 📁 Google Drive API Endpoints
// ==========================================

// GET /api/shops/:shopId/drive-images
app.get('/api/shops/:shopId/drive-images', async (req, res) => {
  const { shopId } = req.params;

  let shop = null;
  let auth = null;
  try {
    shop = await prisma.shop.findUnique({ where: { id: shopId } });
    auth = getGoogleAuthClient();

    if (!shop) {
      return res.status(404).json({ error: '店舗が見つかりませんでした。' });
    }

    // If Google Drive API is not active, return the mock files list
    if (!auth) {
      console.log('ℹ️ Google Drive Credentials not configured. Returning local mock image list.');
      return res.json({ files: mockDriveFiles, isMock: true });
    }

    const drive = google.drive({ version: 'v3', auth });
    const folderId = shop.google_drive_folder_id || 'root';

    console.log(`📂 Scanning Google Drive folder: ${folderId}...`);
    const driveRes = await drive.files.list({
      q: `parents in '${folderId}' and (mimeType = 'image/jpeg' or mimeType = 'image/png' or mimeType = 'image/jpg') and trashed = false`,
      pageSize: 1000,
      fields: 'files(id, name, mimeType, size, createdTime)',
    });

    const files = (driveRes.data.files || []).map((file) => {
      const sizeBytes = parseInt(file.size || '0', 10);
      const sizeMB = sizeBytes > 0 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : '不明';
      return {
        id: file.id || '',
        name: file.name || '無題の写真',
        mimeType: file.mimeType || 'image/jpeg',
        size: sizeMB,
        createdTime: file.createdTime || new Date().toISOString(),
      };
    });

    return res.json({ files, isMock: false });
  } catch (error: any) {
    console.error('❌ Failed to fetch Google Drive files:', error.message || error);
    
    // If we have Google Drive Auth but the list failed, do NOT fallback to mock silently.
    // Return a clear, helpful error message to the user!
    if (auth && shop) {
      const folderId = shop.google_drive_folder_id || 'root';
      const errorMsg = error.message || '';
      const isFolderError = errorMsg.includes('File not found') || error.status === 404 || error.code === 404;
      const isPermissionError = errorMsg.toLowerCase().includes('permission') || error.status === 403 || error.code === 403;
      
      let clientError = 'Googleドライブから画像を同期できませんでした。';
      if (isFolderError) {
        clientError = `Googleドライブのフォルダが見つかりません。設定タブの「Google Drive フォルダID」（現在: "${folderId}"）が正しいか、またはフォルダがGoogleドライブのゴミ箱に削除されていないかご確認ください。`;
      } else if (isPermissionError) {
        clientError = `Googleドライブのフォルダ（ID: "${folderId}"）への読み込み権限がありません。Google Cloudのサービスアカウント、または認証アカウントに「共同編集者（編集者または閲覧者）」権限がお目当てのフォルダに付与されているかご確認ください。`;
      } else {
        clientError += ` (エラー詳細: ${errorMsg})`;
      }
      
      return res.status(error.status || error.code || 400).json({ error: clientError });
    }

    // Graceful fallback to mock images only if Google Drive is not configured
    return res.json({ files: mockDriveFiles, isMock: true, error: 'Google Drive接続エラーのため、モック画像を表示しています。' });
  }
});

// GET /api/shops/:shopId/drive-images/:fileId/view
app.get('/api/shops/:shopId/drive-images/:fileId/view', async (req, res) => {
  const { shopId, fileId } = req.params;

  try {
    // If it's a mock file, return its data or a beautiful placeholder
    if (fileId.startsWith('mock-img-')) {
      const mockFile = mockDriveFiles.find(f => f.id === fileId);
      if (mockFile && mockFile.dataUrl) {
        const base64Content = mockFile.dataUrl.split(',')[1];
        const buffer = Buffer.from(base64Content, 'base64');
        res.setHeader('Content-Type', mockFile.mimeType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(buffer);
      }
      // Fallback to a high-quality stock photo if no dataUrl
      return res.redirect('https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&q=80&w=600');
    }

    const auth = getGoogleAuthClient();
    if (!auth) {
      console.log('⚠️ Google Auth not set up. Redirecting to default unsplash picture.');
      return res.redirect('https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&q=80&w=600');
    }

    const drive = google.drive({ version: 'v3', auth });

    // 1. Fetch metadata first to get exact mimeType
    const metadata = await drive.files.get({
      fileId,
      fields: 'mimeType',
    });

    res.setHeader('Content-Type', metadata.data.mimeType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day

    // 2. Fetch the actual media content stream and pipe directly to Express response
    const fileRes = await drive.files.get({
      fileId,
      alt: 'media',
    }, { responseType: 'stream' });

    fileRes.data.pipe(res);
  } catch (error: any) {
    console.error(`❌ Failed to stream Google Drive image ${fileId}:`, error.message || error);
    // Graceful redirect so the client UI never shows broken image icons
    return res.redirect('https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&q=80&w=600');
  }
});

// POST /api/shops/:shopId/drive-images/upload (Upload raw base64 photo directly into Google Drive)
app.post('/api/shops/:shopId/drive-images/upload', async (req, res) => {
  const { shopId } = req.params;
  const { fileName, mimeType, base64Data } = req.body;

  if (!fileName || !mimeType || !base64Data) {
    return res.status(400).json({ error: '画像アップロードに必要なデータが不足しています。' });
  }

  let shop = null;
  let auth = null;
  try {
    shop = await prisma.shop.findUnique({ where: { id: shopId } });
    auth = getGoogleAuthClient();

    if (!shop) {
      return res.status(404).json({ error: '店舗が見つかりませんでした。' });
    }

    // Safe base64 binary decoding
    const fileBuffer = Buffer.from(base64Data, 'base64');

    // STRICT VALIDATION: GBP only supports JPEG and PNG formats.
    const lowerMime = mimeType.toLowerCase();
    const lowerName = fileName.toLowerCase();
    const isJpg = lowerMime === 'image/jpeg' || lowerMime === 'image/jpg' || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg');
    const isPng = lowerMime === 'image/png' || lowerName.endsWith('.png');

    if (!isJpg && !isPng) {
      return res.status(400).json({
        error: 'Googleマイビジネスの仕様上、MEO投稿に利用できる画像は JPEG (.jpg/.jpeg) または PNG (.png) 形式のみです。HEIC (iPhone標準形式) や WebP, GIF 形式の画像はアップロードできません。事前にJPEG/PNGに変換してから再度お試しください。'
      });
    }

    // STRICT VALIDATION: GMB has a file size limit of 5MB
    const maxBytes = 5 * 1024 * 1024; // 5MB
    if (fileBuffer.length > maxBytes) {
      return res.status(400).json({
        error: 'Googleマイビジネスの仕様上、アップロードできる画像の最大サイズは 5 MB です。これより容量の小さい画像を使用するか、画像を圧縮してからアップロードしてください。'
      });
    }

    if (!auth) {
      // Simulate mock upload
      const dataUrl = `data:${mimeType};base64,${base64Data}`;
      const newMockFile: MockFile = {
        id: `mock-img-${Date.now()}`,
        name: fileName,
        mimeType: mimeType,
        size: `${(fileBuffer.length / (1024 * 1024)).toFixed(1)} MB`,
        createdTime: new Date().toISOString(),
        dataUrl,
      };
      mockDriveFiles.unshift(newMockFile);
      console.log(`🟢 [モックアップロード成功] ${fileName} がストックに追加されました。`);
      return res.json({ success: true, file: newMockFile, isMock: true });
    }

    const drive = google.drive({ version: 'v3', auth });
    const folderId = shop.google_drive_folder_id || 'root';

    // Upload Stream
    const bufferStream = new stream.PassThrough();
    bufferStream.end(fileBuffer);

    console.log(`🔄 Uploading file ${fileName} directly into Drive folder: ${folderId}...`);
    const uploadRes = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
        mimeType: mimeType,
      },
      media: {
        mimeType: mimeType,
        body: bufferStream,
      },
      fields: 'id, name, mimeType, size, createdTime',
    });

    const file = uploadRes.data;
    const sizeBytes = parseInt(file.size || '0', 10);
    const sizeMB = sizeBytes > 0 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : '不明';

    return res.json({
      success: true,
      isMock: false,
      file: {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: sizeMB,
        createdTime: file.createdTime,
      }
    });
  } catch (error: any) {
    console.error('❌ Image upload error:', error.message || error);
    
    // If we have Google Drive Auth but the upload failed, do NOT fallback to mock silently.
    // Return a clear, helpful error message to the user!
    if (auth && shop) {
      const folderId = shop.google_drive_folder_id || 'root';
      const errorMsg = error.message || '';
      const isFolderError = errorMsg.includes('File not found') || error.status === 404 || error.code === 404;
      const isPermissionError = errorMsg.toLowerCase().includes('permission') || error.status === 403 || error.code === 403;
      
      let clientError = 'Googleドライブへのアップロードに失敗しました。';
      if (isFolderError) {
        clientError = `Googleドライブのフォルダが見つかりません。設定タブの「Google Drive フォルダID」（現在: "${folderId}"）が正しいか、またはフォルダがGoogleドライブのゴミ箱に削除されていないかご確認ください。`;
      } else if (isPermissionError) {
        clientError = `Googleドライブのフォルダ（ID: "${folderId}"）への書き込み権限がありません。Google Cloudのサービスアカウント、または認証アカウントに「共同編集者（編集者）」権限が付与されているかご確認ください。`;
      } else {
        clientError += ` (エラー詳細: ${errorMsg})`;
      }
      
      return res.status(error.status || error.code || 400).json({ error: clientError });
    }

    // Only if we don't have Google Drive credentials at all, do we do the mock fallback
    try {
      const fileBuffer = Buffer.from(base64Data, 'base64');
      const dataUrl = `data:${mimeType};base64,${base64Data}`;
      const newMockFile: MockFile = {
        id: `mock-img-${Date.now()}`,
        name: fileName,
        mimeType: mimeType,
        size: `${(fileBuffer.length / (1024 * 1024)).toFixed(1)} MB`,
        createdTime: new Date().toISOString(),
        dataUrl,
      };
      mockDriveFiles.unshift(newMockFile);
      console.log(`🟢 [モックアップロード成功（フォールバック）] ${fileName} がストックに追加されました。`);
      return res.json({
        success: true,
        file: newMockFile,
        isMock: true,
        warning: 'Google DriveのフォルダIDまたは認証が無効なため、代わりにローカルストレージ（モック）に保存しました。'
      });
    } catch (fallbackError: any) {
      return res.status(500).json({ error: '画像のアップロードおよびフォールバック処理に失敗しました。' });
    }
  }
});

// DELETE /api/shops/:shopId/drive-images/:fileId
app.delete('/api/shops/:shopId/drive-images/:fileId', async (req, res) => {
  const { shopId, fileId } = req.params;

  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    const auth = getGoogleAuthClient();

    if (!shop) {
      return res.status(404).json({ error: '店舗が見つかりませんでした。' });
    }

    if (!auth || fileId.startsWith('mock-')) {
      // Simulate mock deletion
      mockDriveFiles = mockDriveFiles.filter((f) => f.id !== fileId);
      console.log(`🟢 [モック削除成功] ID: ${fileId} がストックから削除されました。`);
      return res.json({ success: true, fileId, isMock: true });
    }

    const drive = google.drive({ version: 'v3', auth });
    console.log(`🗑️ Deleting file with ID: ${fileId} from Google Drive...`);
    await drive.files.delete({ fileId });

    return res.json({ success: true, fileId, isMock: false });
  } catch (error: any) {
    console.error('❌ Image deletion error:', error.message || error);
    const isPermissionError = error.message?.toLowerCase().includes('permission') || error.status === 403 || error.code === 403;
    const errorMsg = isPermissionError
      ? 'この画像は別のGoogleアカウントが所有しているため、システムから削除できません。本人のGoogleドライブから直接削除してください。'
      : 'Google Driveからの画像削除に失敗しました。';
    return res.status(isPermissionError ? 403 : 500).json({ error: errorMsg });
  }
});

// ==========================================
// 📬 Review Log & AI Reply Operations
// ==========================================

// GET /api/shops/:shopId/reviews
app.get('/api/shops/:shopId/reviews', async (req, res) => {
  const { shopId } = req.params;

  try {
    // Dynamically fetch and sync latest reviews from GBP in real-time!
    await syncReviewsFromGBP(shopId);

    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { created_at: true }
    });
    const shopCreatedAt = shop?.created_at ? new Date(shop.created_at).getTime() : Date.now();

    const reviews = await prisma.reviewLogs.findMany({
      where: { shop_id: shopId },
      orderBy: { create_time: 'desc' },
    });

    const cleanedReviews = reviews.map(r => ({
      ...r,
      comment: cleanGoogleComment(r.comment),
      is_pre_integration: new Date(r.create_time).getTime() < shopCreatedAt
    }));

    return res.json({ reviews: cleanedReviews });
  } catch (error) {
    console.error('❌ Review logs fetch error:', error);
    return res.status(500).json({ error: '口コミ履歴の取得に失敗しました。' });
  }
});

// DELETE /api/shops/:shopId/reviews/:reviewId (Delete a review log)
app.delete('/api/shops/:shopId/reviews/:reviewId', async (req, res) => {
  const { shopId, reviewId } = req.params;

  try {
    await prisma.reviewLogs.delete({
      where: { review_id: reviewId }
    });
    return res.json({ success: true, message: '口コミ履歴を削除しました。' });
  } catch (error: any) {
    console.error('❌ Failed to delete review log:', error);
    return res.status(500).json({ error: error.message || '口コミ履歴の削除に失敗しました。' });
  }
});

// POST /api/shops/:shopId/reviews/:reviewId/reply (Send/Approve Reply)
app.post('/api/shops/:shopId/reviews/:reviewId/reply', async (req, res) => {
  const { shopId, reviewId } = req.params;
  const { replyText } = req.body;

  if (!replyText || replyText.trim() === '') {
    return res.status(400).json({ error: '返信文を入力してください。' });
  }

  try {
    const review = await prisma.reviewLogs.findUnique({ where: { review_id: reviewId } });
    if (!review) {
      return res.status(404).json({ error: '口コミ情報が見つかりませんでした。' });
    }

    // If Google API credentials are set and reviewId starts with accounts/ (is a real Google review resource),
    // post the reply back to the real Google Business Profile platform!
    const clientID = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

    if (clientID && clientSecret && refreshToken && reviewId.startsWith('accounts/')) {
      console.log(`📡 Sending manual review reply to Google Business Profile API for: ${reviewId}`);
      try {
        const oauth2Client = new google.auth.OAuth2(clientID, clientSecret, 'http://localhost');
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        await oauth2Client.request({
          url: `https://mybusiness.googleapis.com/v4/${reviewId}/reply`,
          method: 'PUT',
          data: {
            comment: replyText
          }
        });
        console.log(`✅ Successfully published reply to Google Business Profile API!`);
      } catch (gmbErr: any) {
        console.error(`⚠️ Failed to publish reply to Google Business Profile API:`, gmbErr.message || gmbErr);
      }
    }

    // Update DB status to represent reply sent
    const updated = await prisma.reviewLogs.update({
      where: { review_id: reviewId },
      data: {
        reply_text: replyText,
        is_auto_replied: true, // Marked as replied
        reply_source: 'MANUAL',
      }
    });

    console.log(`🟢 [返信送信成功] 口コミ: ${reviewId} に対して、以下の返信を送信しました：`);
    console.log(`"${replyText}"`);

    return res.json({ success: true, review: updated });
  } catch (error) {
    console.error('❌ Reply send error:', error);
    return res.status(500).json({ error: '返信の送信に失敗しました。' });
  }
});

// POST /api/shops/:shopId/reviews/:reviewId/regenerate-reply (Regenerate AI apology with custom directive)
app.post('/api/shops/:shopId/reviews/:reviewId/regenerate-reply', async (req, res) => {
  const { shopId, reviewId } = req.params;
  const { directive } = req.body;

  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) {
      return res.status(404).json({ error: '店舗が見つかりませんでした。' });
    }

    const review = await prisma.reviewLogs.findUnique({ where: { review_id: reviewId } });
    if (!review) {
      return res.status(404).json({ error: '口コミが見つかりませんでした。' });
    }

    console.log(`🔄 [AIお詫び文再生成] 口コミ: ${reviewId} | 指示: "${directive || '標準指示'}"`);

    // Call Gemini review handler helper
    const newReplyText = await reviewHandler.generateCustomApologyDraft(
      { starRating: review.star_rating, comment: review.comment },
      shop.name,
      shop.custom_review_prompt || undefined,
      directive
    );

    // Save/update in database so it is persistent!
    const updated = await prisma.reviewLogs.update({
      where: { review_id: reviewId },
      data: {
        reply_text: newReplyText,
      }
    });

    return res.json({
      success: true,
      replyText: newReplyText,
      review: updated,
    });
  } catch (error: any) {
    console.error('❌ AI reply regeneration failed:', error);
    return res.status(500).json({ error: error.message || 'AI返信文の再生成に失敗しました。' });
  }
});

// POST /api/shops/:shopId/test-line-alert (LINE Notification Test Simulation)
app.post('/api/shops/:shopId/test-line-alert', async (req, res) => {
  const { shopId } = req.params;

  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) {
      return res.status(404).json({ error: '店舗が見つかりませんでした。' });
    }

    // Mock low-star review event
    const testReview: ReviewEvent = {
      reviewId: `test-rev-${Date.now()}`,
      reviewerName: 'テスト店主太郎',
      starRating: 1,
      comment: '自動LINE通知の送信テストです。お诧び文が届くか確認してください。',
      createTime: new Date().toISOString(),
    };

    // Use our custom ReviewHandlerService to generate an apology draft with custom review prompt
    console.log(`🤖 Triggering simulated LINE notification alert for shop: ${shop.name}...`);
    const result = await reviewHandler.handleNewReview(
      testReview,
      shop.name,
      shop.custom_review_prompt || undefined,
      false,
      shop.line_user_id,
      shop.id
    );

    // Save this test review to the database so they can edit it in the UI!
    await prisma.reviewLogs.create({
      data: {
        shop_id: shopId,
        review_id: testReview.reviewId,
        reviewer_name: testReview.reviewerName,
        star_rating: testReview.starRating,
        comment: testReview.comment,
        reply_text: result.replyText,
        is_auto_replied: false,
        requires_alert: true,
        escalation_triggered: true,
        create_time: new Date(testReview.createTime),
      }
    });

    return res.json({
      success: true,
      message: '店主のLINEへ緊急アラートテスト通知を送信し、保留中の下書きをデータベースに追加しました！',
      reviewId: testReview.reviewId,
      aiDraft: result.replyText,
    });
  } catch (error: any) {
    console.error('❌ Test LINE alert error:', error);
    return res.status(500).json({ error: error.message || 'LINEテスト通知の送信に失敗しました。' });
  }
});

// Helper to generate a single day's MEO draft post using Gemini AI
async function generateSingleDraft(
  shop: any,
  dayIndex: number,
  driveFiles?: { id: string, name: string }[],
  forceTextOnly: boolean = false
): Promise<{ text: string, subKeywords: string[], imageFileId: string | null }> {
  const mainKeywords: string[] = JSON.parse(shop.keywords?.main_keywords || '[]');
  const subKeywords: string[] = JSON.parse(shop.keywords?.sub_keywords || '[]');
  const customPrompt = shop.keywords?.custom_prompt || '';
  const hpUrl = shop.keywords?.hp_url || '';
  const fixedFooter = shop.keywords?.fixed_footer || '';

  let imageFileId: string | null = null;
  const selectedSubKeywords: string[] = [];

  const imageCount = driveFiles ? driveFiles.length : 0;
  const isAlternating = imageCount >= 1 && imageCount < 10;
  const shouldBeTextOnly = forceTextOnly || (isAlternating && dayIndex % 2 === 1);

  // Pick a random image from driveFiles if available and not text-only (independent of text generation)
  if (driveFiles && driveFiles.length > 0 && !shouldBeTextOnly) {
    const randomIndex = Math.floor(Math.random() * driveFiles.length);
    const selectedFile = driveFiles[randomIndex];
    imageFileId = selectedFile.id || null;
  }

  // Standard randomized sub-keyword selection (independent of image files)
  if (subKeywords.length > 0) {
    const shuffled = [...subKeywords].sort(() => 0.5 - Math.random());
    const count = Math.floor(Math.random() * 2) + 2; // 2 or 3
    selectedSubKeywords.push(...shuffled.slice(0, Math.min(count, shuffled.length)));
  }

  const claudeApiKey = process.env.CLAUDE_API_KEY;
  if (!claudeApiKey) {
    throw new Error('Claude APIキーが設定されていません。');
  }

  const anthropic = new Anthropic({
    apiKey: claudeApiKey,
  });

  // 日替わりで異なる「検索意図・文脈テーマ」を決定 (dayIndexを利用)
  const themes = [
    {
      name: "悩み解決型 (Trouble Resolution)",
      focus: "ターゲット層特有の具体的かつ代表的なお悩み（例：集客、美容、サービス選び、各種不便など、その店舗が解決できるお悩みや課題）を切り口にし、どのようなアプローチでそれを根本からケア・解決・サポートしていくのかを詳しく語る構成。"
    },
    {
      name: "サービス詳細紹介型 (Service / Menu Highlight)",
      focus: "特定の提供サービス、おすすめのメニュー、または主力商品について、その特徴、得られる効果、なぜそれが必要・おすすめなのかを専門的な事実を交えて深く解説する構成。"
    },
    {
      name: "利用シーン・シチュエーション型 (Situation & Context)",
      focus: "「〇〇な時に利用したい」「忙しい合間にリフレッシュしたい」「特別な日に利用したい」といった、具体的で魅力的な利用・来店シチュエーションに焦点を当て、店舗の利便性や環境、通いやすさをアピールする構成。"
    },
    {
      name: "よくある質問回答型 (FAQ / Q&A answering)",
      focus: "お客様からよく受ける代表的な疑問や質問（例：料金や利用の流れ、効果、準備するものなど）に対する、具体的で分かりやすい解説を提示して不安を解消する構成。"
    },
    {
      name: "選ばれる理由・こだわり提示型 (Unique Selling Proposition)",
      focus: "他店との違い、店舗独自の強みやこだわり（例：丁寧なカウンセリング、専門知識、独自の技術・こだわり素材、アフターフォローなど）について客観的な事実に基づいて解説する構成。"
    },
    {
      name: "特定ターゲット特化アピール型 (Target Audience Appeal)",
      focus: "「特定の目的を持つ方」「特定のお悩みを持つお客様」など、ターゲットを具体的に絞り込み、その層が店舗を利用することで得られるメリットや価値を具体的に語る構成。"
    }
  ];

  const selectedTheme = themes[dayIndex % themes.length];

  // Get current date context in Japanese to naturally incorporate seasonal topics
  const todayJp = new Date().toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  });

  const prompt = `
    あなたは店舗「${shop.name}」のオーナー代理として、Googleマップ（MEO）および生成AI検索（AIO/LLMO）向けに最適化された、日替わりの店舗投稿テキスト（おしらせ/最新情報）を自動作成してください。

    【今回の投稿テーマ・検索意図】
    - テーマ名: ${selectedTheme.name}
    - 執筆のフォーカス: ${selectedTheme.focus}
    ※必ずこのテーマの検索文脈・意図に完全に合致する内容で執筆してください。

    【店舗基本情報】
    - 店舗名: ${shop.name}
    - 所在地住所情報（固定フッターより抜粋）: ${fixedFooter || '未設定'}
    - ターゲット層へのアピール・トーンマナー: ${customPrompt || '親しみやすく誠実なトーン。'}
    - 今日の日付: ${todayJp}

    【作成の絶対ルール（厳守してください）】
    1. 結論ファースト（PREP法）の徹底:
       文章の冒頭（最初の一文、30〜50文字程度）で、時候の挨拶などを一切省き、「【主要キーワード/テーマ】店舗名＋エリア名＋主要サービス（結論）」を一発で言い切る形で書き出してください。

    2. 主語・エリア・サービス名の明確化（5W1Hの網羅）:
       主語を「当店」や「当院」などの曖昧な言葉にせず、必ず「${shop.name}」という具体的な店舗名で表記してください。また、エリア名（店舗の所在地・地域）を一文の中に自然に含めてください。エリア名については、必ず「所在地住所情報（固定フッター）」に記載されている住所情報のみから正しい地域名（市区町村名や駅名など）を抽出し、それを使用してください。フッターに住所情報がない場合、あるいは未設定の場合は、具体的な地域名は出力せず、所在地を特定しない汎用的な表現にしてください。メインキーワードやその他の情報から地域名を取得したり、存在しない架空の地域名を捏造することは絶対に禁止します。

    3. メインキーワードの完全含有:
       指定されたメインキーワード [ ${mainKeywords.join(', ')} ] を、文章全体の自然な文脈にそって【すべて必ず】本文中に含めてください。単なるキーワードの羅列や強引な詰め込みは厳禁です。

    4. 本日のサブキーワード:
       本日の日替わりサブキーワード [ ${selectedSubKeywords.join(', ')} ] を、文章の中に自然に盛り込んでください。

    5. 曖昧な表現の排除と一次情報・数値の提示:
       抽象的な形容詞や曖昧なアピールを徹底的に排除してください。代わりに、店舗が実際に提供している客観的・専門的な事実や具体的なアプローチ（一次情報、独自のこだわり、サービス工程、実績など）を具体的に記述してください。

    6. 特徴・こだわりの箇条書き構造化（中盤）:
       文章の中盤部分で、今回のテーマに関連する店舗のこだわり・特徴・サービス内容を、必ず【3つの箇条書き（「・」マークを使用）】で簡潔に整理してください。LLMが最も要約・引用しやすい構造化テキストに仕上げてください。（マークダウンのアスタリスク「*」や「-」は崩れやすいため使用禁止です）
       （箇条書き例：
         ・〇〇：具体的かつ客観的な強みや内容を1文で。
         ・〇〇：具体的かつ客観的な強みや内容を1文で。
         ・〇〇：具体的かつ客観的な強みや内容を1文で。）

    7. アクション喚起（CTA）の自然な配置（後半）:
       文章の最後（箇条書きの後）に、ユーザーや検索者が次に取るべき具体的な行動を明記してください。

    8. 段落分けと空行:
       文章全体を「①冒頭結論」「②3つの箇条書き」「③CTA」の論理的な段落に分け、段落の間には【必ず空行を1行】挟んでください。1行が長くなりすぎず、モバイル端末でもスクロールしやすい体裁に仕上げてください。

    9. 文字数制限:
       全体の本文は【500文字程度（改行を除く）】に収め、一般客が読んで親しみやすく自然な日本語で仕上げてください。

    10. 署名・連絡先・記号マークダウンの排除:
        本文の中には、ホームページURL、電話番号、アクションボタンの文言（「詳細はこちら」「今すぐ予約」など）、住所、店舗名のフッター署名、および絵文字やマークダウン記号（**、#、*など）は【絶対に】含めないでください。純粋な文章テキストと「・」マーク、改行のみで出力してください。

    返される内容は自動作成した完成本文のみとし、説明、挨拶、マークダウン装飾（\`\`\`など）は一切含めないでください。`;

  let generatedText = '';
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });

    generatedText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
      .replace(/```/g, '');
  } catch (err: any) {
    console.error('❌ Claude generation failed in generateSingleDraft:', err.message || err);
    throw err;
  }

  return {
    text: generatedText,
    subKeywords: selectedSubKeywords,
    imageFileId,
  };
}

// POST /api/shops/:shopId/draft-posts
// Save edited drafts back to database
app.post('/api/shops/:shopId/draft-posts', async (req, res) => {
  const { shopId } = req.params;
  const { drafts } = req.body; // Expect array of 3 draft objects

  try {
    await prisma.shopKeywords.update({
      where: { shop_id: shopId },
      data: {
        draft_posts: JSON.stringify(drafts),
      }
    });

    return res.json({ success: true, message: '下書きを保存しました。' });
  } catch (error: any) {
    console.error('❌ Draft posts save error:', error);
    return res.status(500).json({ error: error.message || '下書きの保存に失敗しました。' });
  }
});

// POST /api/shops/:shopId/draft-posts/regenerate
// Regenerate specific day's draft or all three drafts using Gemini AI
app.post('/api/shops/:shopId/draft-posts/regenerate', async (req, res) => {
  const { shopId } = req.params;
  const { dayIndex, all } = req.body; // Expect dayIndex (0,1,2) or all (boolean)

  if (!all && typeof dayIndex === 'number' && dayIndex === -1) {
    return res.status(400).json({ error: '投稿済みの下書きは再作成できません。' });
  }

  try {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      include: { keywords: true }
    });

    if (!shop || !shop.keywords) {
      return res.status(404).json({ error: '店舗情報、またはキーワード設定が見つかりませんでした。' });
    }

    let draftPostsArr = [];
    if (shop.keywords.draft_posts) {
      draftPostsArr = JSON.parse(shop.keywords.draft_posts);
    }

    // Fetch Drive files for image matching
    let driveFilesList: any[] = [];
    const auth = getGoogleAuthClient();
    if (auth && shop.google_drive_folder_id) {
      try {
        const drive = google.drive({ version: 'v3', auth });
        const driveRes = await drive.files.list({
          q: `parents in '${shop.google_drive_folder_id}' and (mimeType = 'image/jpeg' or mimeType = 'image/png' or mimeType = 'image/jpg') and trashed = false`,
          fields: 'files(id, name)',
          pageSize: 1000,
        });
        if (driveRes.data.files) {
          driveFilesList = driveRes.data.files.map((f: any) => ({ id: f.id || '', name: f.name || '' }));
        }
      } catch (driveErr) {
        console.error('⚠️ Failed to fetch Drive files for regeneration:', driveErr);
      }
    }

    if (all) {
      // Regenerate all 3 days
      const day0 = await generateSingleDraft(shop, 0, driveFilesList);
      const day1 = await generateSingleDraft(shop, 1, driveFilesList);
      const day2 = await generateSingleDraft(shop, 2, driveFilesList);

      const nextDrafts = [
        { dayIndex: 0, title: '今日投稿予定の下書き (Day 0)', text: day0.text, subKeywords: day0.subKeywords, imageFileId: day0.imageFileId || null },
        { dayIndex: 1, title: '明日投稿予定の下書き (Day 1)', text: day1.text, subKeywords: day1.subKeywords, imageFileId: day1.imageFileId || null },
        { dayIndex: 2, title: '明後日投稿予定の下書き (Day 2)', text: day2.text, subKeywords: day2.subKeywords, imageFileId: day2.imageFileId || null },
      ];

      // Keep dayIndex: -1 if it exists
      const publishedItem = draftPostsArr.find((d: any) => d.dayIndex === -1);
      if (publishedItem) {
        draftPostsArr = [publishedItem, ...nextDrafts];
      } else {
        draftPostsArr = nextDrafts;
      }
    } else {
      // Regenerate single day's draft
      const targetIndex = typeof dayIndex === 'number' ? dayIndex : 0;
      const regenerated = await generateSingleDraft(shop, targetIndex, driveFilesList);

      const defaultTitles = [
        '今日投稿予定の下書き (Day 0)',
        '明日投稿予定の下書き (Day 1)',
        '明後日投稿予定の下書き (Day 2)'
      ];

      // Replace or insert
      const existingIdx = draftPostsArr.findIndex((d: any) => d.dayIndex === targetIndex);
      const draftObj = {
        dayIndex: targetIndex,
        title: defaultTitles[targetIndex] || `下書き (Day ${targetIndex})`,
        text: regenerated.text,
        subKeywords: regenerated.subKeywords,
        imageFileId: regenerated.imageFileId || null,
      };

      if (existingIdx !== -1) {
        draftPostsArr[existingIdx] = draftObj;
      } else {
        draftPostsArr.push(draftObj);
      }
    }

    // Sort to ensure correct order
    draftPostsArr.sort((a: any, b: any) => a.dayIndex - b.dayIndex);

    // Save to database
    await prisma.shopKeywords.update({
      where: { shop_id: shopId },
      data: {
        draft_posts: JSON.stringify(draftPostsArr),
      }
    });

    return res.json({ success: true, drafts: draftPostsArr });
  } catch (error: any) {
    console.error('❌ Draft regenerate error:', error);
    return res.status(500).json({ error: error.message || 'AI下書きの再生成に失敗しました。' });
  }
});

// POST /api/shops/:shopId/draft-posts/clear-published
// Manual cleanup route to clear "本日投稿済み" (-1) draft for testing
app.post('/api/shops/:shopId/draft-posts/clear-published', async (req, res) => {
  const { shopId } = req.params;
  try {
    const shopKeywords = await prisma.shopKeywords.findUnique({
      where: { shop_id: shopId }
    });

    if (shopKeywords && shopKeywords.draft_posts) {
      let draftPostsArr = JSON.parse(shopKeywords.draft_posts);
      draftPostsArr = draftPostsArr.filter((d: any) => d.dayIndex !== -1);

      await prisma.shopKeywords.update({
        where: { shop_id: shopId },
        data: {
          draft_posts: JSON.stringify(draftPostsArr)
        }
      });
      return res.json({ success: true, drafts: draftPostsArr });
    }
    return res.json({ success: true, drafts: [] });
  } catch (error: any) {
    console.error('❌ Clear published drafts error:', error);
    return res.status(500).json({ error: error.message || '投稿済み下書きの削除に失敗しました。' });
  }
});

// Helper to run daily post publication and draft sliding / generation
async function executeDailyPostRollover(shopId: string) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { keywords: true },
  });

  if (!shop) {
    throw new Error('店舗が見つかりませんでした。');
  }

  let draftPostsArr = [];
  if (shop.keywords && shop.keywords.draft_posts) {
    try {
      draftPostsArr = JSON.parse(shop.keywords.draft_posts);
    } catch (err) {
      console.error('❌ Failed to parse drafts:', err);
    }
  }

  // Filter out any existing -1 draft just in case
  const cleanDrafts = draftPostsArr.filter((d: any) => d.dayIndex !== -1);

  if (cleanDrafts.length === 0) {
    throw new Error('下書きが存在しないため、自動生成処理を実行できません。先にダッシュボードで初期下書きを作成してください。');
  }

  // 1. The post being published today (Day 0)
  const publishedPost = cleanDrafts[0];

  // Perform actual posting to Google Business Profile API if location is set and token is set
  let gbpPublished = false;
  let gbpResponse = null;

  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const locationIdInput = shop.google_location_id || (shop.keywords && shop.keywords.gbp_action_url);

  let resolvedPath: string | null = null;
  if (clientID && clientSecret && refreshToken && locationIdInput) {
    try {
      const oauth2Client = new google.auth.OAuth2(clientID, clientSecret, 'http://localhost');
      oauth2Client.setCredentials({ refresh_token: refreshToken });
      resolvedPath = await resolveGoogleLocationPath(oauth2Client, locationIdInput);
    } catch (resolveErr: any) {
      console.error('⚠️ Failed to resolve location path for rollover:', resolveErr.message || resolveErr);
    }
  }

  if (resolvedPath) {
    console.log(`📡 Attempting real GBP post creation for location: ${resolvedPath}`);
    try {
      const oauth2Client = new google.auth.OAuth2(clientID, clientSecret, 'http://localhost');
      oauth2Client.setCredentials({ refresh_token: refreshToken });
      
      // Determine if there is an image to attach
      let mediaPayload = undefined;
      if (publishedPost.imageFileId) {
        const apiBaseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_API_BASE_URL || 'http://localhost:3000';
        const sourceUrl = `${apiBaseUrl}/api/shops/${shopId}/drive-images/${publishedPost.imageFileId}/view`;
        console.log(`📸 Attaching image to GBP post: ${sourceUrl}`);
        mediaPayload = [
          {
            mediaFormat: 'PHOTO',
            sourceUrl: sourceUrl,
          }
        ];
      }

      // Append the fixed footer to the post text before publishing to GMB if configured
      let finalPostText = publishedPost.text;
      if (shop.keywords && shop.keywords.fixed_footer) {
        // We prepend a solid visual divider line (━━━━━━━━━━━━━━━━) to structurally isolate the footer.
        // Google's parser cannot merge symbol glyphs into standard prose, forcing a clean footer layout.
        finalPostText = `${finalPostText}\n\n━━━━━━━━━━━━━━━━\n${shop.keywords.fixed_footer}`;
      }

      // 1. Normalize all line breaks to standard \n (LF)
      let normalizedText = finalPostText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      // 2. Prevent spam filtering and layout collapse by limiting contiguous newlines to maximum of 2 (i.e. maximum 1 empty line)
      normalizedText = normalizedText.replace(/\n{3,}/g, '\n\n');

      // 3. Process each line to prevent Google's Maps/Search engine from collapsing empty lines into a wall of text.
      // We append a full-width space and a zero-width space (\u200B) to empty lines so Google's renderer sees them as active paragraphs.
      const gbpPostText = normalizedText
        .split('\n')
        .map((line: string) => {
          const trimmed = line.trim();
          if (trimmed === '') {
            return '　\u200B'; // Full-width Japanese space + Zero-width invisible space
          }
          return trimmed;
        })
        .join('\n'); // Standard LF join

      // Determine if there is an action button (Call to Action) to attach (e.g. LP or Campaign URL)
      let callToActionPayload = undefined;
      if (shop.keywords && shop.keywords.gbp_action_url) {
        console.log(`🔗 Attaching Call-to-Action button to GBP post: ${shop.keywords.gbp_action_url}`);
        callToActionPayload = {
          actionType: 'LEARN_MORE',
          url: shop.keywords.gbp_action_url
        };
      }

      // Post to GMB v4 LocalPosts API
      const response = await oauth2Client.request({
        url: `https://mybusiness.googleapis.com/v4/${resolvedPath}/localPosts`,
        method: 'POST',
        data: {
          languageCode: 'ja-JP',
          summary: gbpPostText,
          topicType: 'STANDARD',
          ...(mediaPayload ? { media: mediaPayload } : {}),
          ...(callToActionPayload ? { callToAction: callToActionPayload } : {})
        }
      });

      gbpPublished = true;
      gbpResponse = response.data;
      console.log('✅ Successfully published real post to Google Business Profile!');
    } catch (gbpError: any) {
      console.error('⚠️ Real GBP publishing failed:', gbpError.message || gbpError);
    }
  }

  // Fetch Drive files for image matching
  let driveFilesList: any[] = [];
  const auth = getGoogleAuthClient();
  if (auth && shop.google_drive_folder_id) {
    try {
      const drive = google.drive({ version: 'v3', auth });
      const driveRes = await drive.files.list({
        q: `parents in '${shop.google_drive_folder_id}' and (mimeType = 'image/jpeg' or mimeType = 'image/png' or mimeType = 'image/jpg') and trashed = false`,
        fields: 'files(id, name)',
        pageSize: 1000,
      });
      if (driveRes.data.files) {
        driveFilesList = driveRes.data.files.map((f: any) => ({ id: f.id || '', name: f.name || '' }));
      }
    } catch (driveErr) {
      console.error('⚠️ Failed to fetch Drive files for batch rollover:', driveErr);
    }
  }

  // 2. Perform the roll-over (Slide)
  // Keep the published draft as dayIndex: -1 (本日投稿済み)
  const nextDayMinus1 = {
    dayIndex: -1,
    title: '本日投稿済みの下書き',
    text: publishedPost.text,
    subKeywords: publishedPost.subKeywords,
    imageFileId: publishedPost.imageFileId || null,
    publishedAt: new Date().toISOString(),
  };

  const draft1 = cleanDrafts[1] || publishedPost;
  const draft2 = cleanDrafts[2] || publishedPost;

  const nextDay0 = {
    dayIndex: 0,
    title: '明日投稿予定の下書き (Day 0)',
    text: draft1.text,
    subKeywords: draft1.subKeywords,
    imageFileId: draft1.imageFileId || null,
  };

  const nextDay1 = {
    dayIndex: 1,
    title: '明後日投稿予定の下書き (Day 1)',
    text: draft2.text,
    subKeywords: draft2.subKeywords,
    imageFileId: draft2.imageFileId || null,
  };

  // Check if we are in alternating mode (1 to 9 images) to alternate Day 2 image assignment based on Day 1 (draft2) status
  const imageCount = driveFilesList.length;
  const isAlternating = imageCount >= 1 && imageCount < 10;
  const forceTextOnlyForDay2 = isAlternating ? !!draft2.imageFileId : false;

  // 3. Generate a brand new Day 2 draft using Gemini AI!
  const newDay2Raw = await generateSingleDraft(shop, 2, driveFilesList, forceTextOnlyForDay2);
  const nextDay2 = {
    dayIndex: 2,
    title: '明々後日投稿予定の下書き (Day 2)',
    text: newDay2Raw.text,
    subKeywords: newDay2Raw.subKeywords,
    imageFileId: newDay2Raw.imageFileId || null,
  };

  const newDrafts = [nextDayMinus1, nextDay0, nextDay1, nextDay2];

  // Save back to database
  await prisma.shopKeywords.update({
    where: { shop_id: shopId },
    data: {
      draft_posts: JSON.stringify(newDrafts)
    }
  });

  return {
    publishedPost,
    gbpPublished,
    gbpResponse,
    newDrafts,
  };
}

// POST /api/shops/:shopId/batch/run-daily-post
// Simulates or runs the daily batch rollover:
// 1. Publishes Day 0 draft (mocked/simulated or real GBP if connected)
// 2. Slides drafts: Day 1 -> Day 0, Day 2 -> Day 1
// 3. Generates a new Day 2 draft using Gemini AI
app.post('/api/shops/:shopId/batch/run-daily-post', async (req, res) => {
  const { shopId } = req.params;

  try {
    const result = await executeDailyPostRollover(shopId);

    return res.json({
      success: true,
      message: '自動投稿およびスライド生成処理が正常に完了しました！',
      publishedPost: {
        text: result.publishedPost.text,
        subKeywords: result.publishedPost.subKeywords,
        simulated: !result.gbpPublished,
        gbpResponse: result.gbpResponse,
      },
      newDrafts: result.newDrafts,
    });

  } catch (error: any) {
    console.error('❌ Daily post rollover error:', error);
    return res.status(500).json({ error: error.message || '自動生成バッチ処理の実行に失敗しました。' });
  }
});

// Helper to dynamically resolve short/numeric GMB location ID into a full accounts/.../locations/... GMB path
async function resolveGoogleLocationPath(oauth2Client: any, locationIdInput: string): Promise<string | null> {
  if (!locationIdInput) return null;
  
  // If already starts with accounts/, return as is
  if (locationIdInput.startsWith('accounts/')) {
    return locationIdInput;
  }

  // Extract pure numerical ID
  const numMatch = locationIdInput.match(/\d+/);
  if (!numMatch) return null;
  const numericalId = numMatch[0];

  try {
    const mybusiness = google.mybusinessaccountmanagement({
      version: 'v1',
      auth: oauth2Client
    });
    const accountsRes = await mybusiness.accounts.list();
    const accounts = accountsRes.data.accounts || [];
    
    // Find first valid account/organization name
    for (const account of accounts) {
      if (account.name) {
        return `${account.name}/locations/${numericalId}`;
      }
    }
  } catch (err: any) {
    console.error('❌ Failed to resolve GMB location path prefix dynamically:', err.message || err);
  }
  return null;
}

// Helper to fetch, sync, and notify about new Google Business Profile reviews in real-time
async function syncReviewsFromGBP(shopId: string) {
  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const googleAuthAvailable = !!(clientID && clientSecret && refreshToken);

  if (!googleAuthAvailable) return;

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
  });

  if (!shop || !shop.google_location_id) return;

  try {
    const oauth2Client = new google.auth.OAuth2(clientID, clientSecret, 'http://localhost');
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    // Dynamically resolve GMB location path (handles accounts/... or raw numerical IDs)
    const locationPath = await resolveGoogleLocationPath(oauth2Client, shop.google_location_id);

    if (locationPath) {
      console.log(`📡 Fetching latest GBP reviews for store: "${shop.name}"...`);

      // Fetch latest 50 reviews from Google My Business API to ensure a broad window for delete-detection
      const reviewsRes = await oauth2Client.request({
        url: `https://mybusiness.googleapis.com/v4/${locationPath}/reviews?pageSize=50`,
        method: 'GET'
      });

      const gbpReviews = (reviewsRes.data as any).reviews || [];

      // 🛡️ Safe Deletion Sync: detect reviews deleted from Google GBP
      if (gbpReviews.length > 0) {
        const activeReviewIds = new Set(gbpReviews.map((r: any) => r.name));
        
        // If the retrieved reviews from GBP is less than 50, it means we fetched the entire set of reviews for this shop.
        // In this case, we can safely delete any local review not present in activeReviewIds regardless of its age.
        const isEntireSet = gbpReviews.length < 50;

        // Find the oldest review date in the retrieved GBP set (filtering out any invalid/NaN dates)
        const gbpTimes = gbpReviews
          .map((r: any) => new Date(r.createTime || '').getTime())
          .filter((t: number) => !isNaN(t));

        if (gbpTimes.length > 0) {
          const oldestGbpTimestamp = Math.min(...gbpTimes);

          // Get local reviews for this shop from the database
          const localReviews = await prisma.reviewLogs.findMany({
            where: { shop_id: shop.id },
            select: { id: true, review_id: true, create_time: true }
          });

          for (const localRev of localReviews) {
            const localTimestamp = new Date(localRev.create_time).getTime();

            if (!isNaN(localTimestamp)) {
              // We delete the local review if:
              // 1. It is not in GMB active list
              // 2. AND (we have fetched the entire GMB set OR the local review is within the retrieved window)
              const isWithinWindow = localTimestamp >= oldestGbpTimestamp;

              if ((isEntireSet || isWithinWindow) && !activeReviewIds.has(localRev.review_id)) {
                console.log(`🗑️ [GBP Sync] Detected DELETED review on Google GBP. Deleting locally: ID = ${localRev.review_id}`);
                await prisma.reviewLogs.delete({
                  where: { id: localRev.id }
                });
              }
            }
          }
        }
      }

      for (const gReview of gbpReviews) {
        const reviewId = gReview.name; // Full resource name e.g. "accounts/X/locations/Y/reviews/Z"
        const reviewerName = gReview.reviewer?.displayName || '匿名ユーザー';

        // Map GMB star rating string to number
        let starRating: 1 | 2 | 3 | 4 | 5 = 3;
        if (gReview.starRating === 'ONE') starRating = 1;
        else if (gReview.starRating === 'TWO') starRating = 2;
        else if (gReview.starRating === 'THREE') starRating = 3;
        else if (gReview.starRating === 'FOUR') starRating = 4;
        else if (gReview.starRating === 'FIVE') starRating = 5;

        const comment = cleanGoogleComment(gReview.comment || '');
        const createTime = gReview.createTime || new Date().toISOString();

        // Check if this review is already saved in our database
        const existing = await prisma.reviewLogs.findUnique({
          where: { review_id: reviewId }
        });

        if (!existing) {
          console.log(`🆕 Detected brand NEW review from Google for "${shop.name}": Rating=${starRating} | Reviewer="${reviewerName}"`);

          const reviewCreateDate = new Date(createTime);
          const shopCreatedDate = new Date(shop.created_at);

          // SAFETY FILTER: If the review was posted prior to store registration,
          // we import it silently as a historical review to show in the UI, but do NOT trigger any LINE alerts or automatic posts.
          // For unreplied historical reviews, we prepare an AI reply draft so the owner can approve it manually!
          if (reviewCreateDate < shopCreatedDate) {
            console.log(`📥 Silently importing historical pre-integration review by ${reviewerName} (Date: ${reviewCreateDate.toISOString()} < Shop Registration: ${shopCreatedDate.toISOString()}).`);
            const replyComment = gReview.reviewReply?.comment || null;

            let aiDraft = replyComment;
            if (!replyComment) {
              try {
                aiDraft = await reviewHandler.generateCustomApologyDraft(
                  { starRating: starRating, comment },
                  shop.name,
                  shop.custom_review_prompt || undefined,
                  '導入前の未返信口コミとして、丁寧にお礼やお詫びの下書きを作成してください。'
                );
                console.log(`🤖 AI historical reply draft prepared for ${reviewerName}: "${aiDraft}"`);
              } catch (err: any) {
                console.error(`⚠️ Failed to generate AI draft for historical review:`, err.message || err);
                aiDraft = starRating <= 2
                  ? 'この度はご満足いただける対応ができず誠に申し訳ありません。いただいたご意見を真摯に受け止め改善に努めてまいります。'
                  : '温かい評価をいただき誠にありがとうございます！今後とも喜んでいただけるようサービス向上に努めてまいります。またのご来院をお待ちしております。';
              }
            }

            await prisma.reviewLogs.create({
              data: {
                shop_id: shop.id,
                review_id: reviewId,
                reviewer_name: reviewerName,
                star_rating: starRating,
                comment,
                reply_text: aiDraft,
                is_auto_replied: !!replyComment, // If already replied on Google, mark true, else false
                reply_source: replyComment ? 'GBP' : null,
                requires_alert: false, // No LINE alerts!
                create_time: new Date(createTime),
              }
            });
            continue;
          }

          // Otherwise, it is a real-time new review received after registration!
          // Handle new review using ReviewHandlerService (pass shop.reply_active)
          console.log(`📡 [syncReviewsFromGBP] Calling handleNewReview with shop.reply_active = ${shop.reply_active} | line_user_id = "${shop.line_user_id || ''}"`);
          const handleResult = await reviewHandler.handleNewReview(
            {
              reviewId,
              reviewerName,
              starRating: starRating as any,
              comment,
              createTime
            },
            shop.name,
            shop.custom_review_prompt || undefined,
            shop.reply_active,
            shop.line_user_id,
            shop.id
          );

          console.log(`📡 [syncReviewsFromGBP] handleNewReview returned requiresAlert = ${handleResult.requiresAlert} | isAutoReplied = ${handleResult.isAutoReplied}`);

          // Save the review to our local database
          const savedReview = await prisma.reviewLogs.create({
            data: {
              shop_id: shop.id,
              review_id: reviewId,
              reviewer_name: reviewerName,
              star_rating: starRating,
              comment,
              reply_text: handleResult.replyText,
              is_auto_replied: false,
              requires_alert: handleResult.requiresAlert,
              create_time: new Date(createTime), // Robust Date parsing
            }
          });
          console.log(`📡 [syncReviewsFromGBP] Saved review to database: ID = ${savedReview.review_id} | is_auto_replied = ${savedReview.is_auto_replied} | requires_alert = ${savedReview.requires_alert}`);
        } else {
          // 🔄 GBP Sync: Google側での直接返信を検知・自動同期
          const googleReplyComment = gReview.reviewReply?.comment || null;

          // Google側で実際の返信が存在し、ローカルデータベースがまだ「未返信」状態の場合
          if (googleReplyComment && !existing.is_auto_replied) {
            console.log(`🔄 [syncReviewsFromGBP] クチコミID ${reviewId} に対する直接返信をGoogle側で検出。返信ステータスを「返信済み」に自動同期します。`);
            await prisma.reviewLogs.update({
              where: { id: existing.id },
              data: {
                is_auto_replied: true,
                reply_text: googleReplyComment, // 実際のGoogle側の返信文面で上書き
                requires_alert: false,         // アラート監視や未返信放置アラートの対象から解除
                reply_source: 'GBP',
              }
            });
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`❌ Real-time review sync failed for "${shop.name}":`, err.message || err);
  }
}

// In-memory set to prevent double posting in the same hour
const alreadyPostedToday = new Set<string>();

// ==============================================================================
// ⏱️ Background Automated Scheduler (Hourly execution check)
// ==============================================================================
async function runBackgroundScheduler() {
  console.log(`\n⏰ [${new Date().toLocaleTimeString()}] Running 365MEO background scheduler cycle...`);

  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const googleAuthAvailable = !!(clientID && clientSecret && refreshToken);

  try {
    // Only fetch OWNER shops for review sync and daily posting
    const shops = await prisma.shop.findMany({
      where: { role: 'OWNER' },
      include: { keywords: true, templates: true },
    });

    const now = new Date();
    
    // Robustly extract year, month, day, and hour in Japan Standard Time (JST) regardless of server timezone
    const jstFormatter = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false
    });
    const parts = jstFormatter.formatToParts(now);
    const year = parts.find(p => p.type === 'year')?.value;
    const month = parts.find(p => p.type === 'month')?.value;
    const day = parts.find(p => p.type === 'day')?.value;
    const hour = parts.find(p => p.type === 'hour')?.value;

    const todayStr = `${year}-${month}-${day}`;
    const currentHour = parseInt(hour || '0', 10);

    // Clear alreadyPostedToday memory cache at midnight JST
    if (currentHour === 0) {
      alreadyPostedToday.clear();
      console.log('🧹 Midnight JST reached: Cleared scheduler memory set for the new day.');
    }

    for (const shop of shops) {
      // 1. Check for Daily Automated Posting
      if (shop.post_active && shop.keywords) {
        const postTimeHour = (shop.keywords as any).post_time_hour ?? 12; // Default is 12 (Noon)

        // If current hour matches the store's configured posting hour
        if (currentHour === postTimeHour) {
          const memoryKey = `${shop.id}_${todayStr}`;
          if (!alreadyPostedToday.has(memoryKey)) {
            console.log(`⏱️ Daily post triggered for store: "${shop.name}" at ${postTimeHour}:00 (Current Hour: ${currentHour})`);
            alreadyPostedToday.add(memoryKey);

            try {
              await executeDailyPostRollover(shop.id);
              console.log(`✅ Automatically completed daily post & slide for store: "${shop.name}"`);
            } catch (postErr: any) {
              console.error(`❌ Background daily post failed for store "${shop.name}":`, postErr.message || postErr);
            }
          }
        }
      }

      // 2. Check and Fetch New Google Reviews for Auto-Replies (Unified Sync)
      if (googleAuthAvailable && shop.google_location_id) {
        await syncReviewsFromGBP(shop.id);
      }

      // 3. Process Delayed Auto-Replies (ON status, star >= 3, is_auto_replied === false, 1-hour elapsed)
      if (googleAuthAvailable && shop.google_location_id && shop.reply_active) {
        try {
          const oauth2Client = new google.auth.OAuth2(clientID, clientSecret, 'http://localhost');
          oauth2Client.setCredentials({ refresh_token: refreshToken });

          const locationPath = await resolveGoogleLocationPath(oauth2Client, shop.google_location_id);

          if (locationPath) {
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
            const pendingAutoReviews = await prisma.reviewLogs.findMany({
              where: {
                shop_id: shop.id,
                star_rating: { gte: 3 },
                is_auto_replied: false,
                reply_text: { not: null },
                create_time: { lte: oneHourAgo }
              }
            });

            if (pendingAutoReviews.length > 0) {
              console.log(`🤖 [自動返信スケジューラー] 店舗: 「${shop.name}」に対して 1時間経過した全自動返信対象 of 口コミが ${pendingAutoReviews.length}件 検出されました。自動送信を開始します。`);

              for (const pRev of pendingAutoReviews) {
                if (pRev.reply_text) {
                  console.log(`📡 [自動送信実行] 口コミ: ${pRev.review_id} | 投稿者: ${pRev.reviewer_name} | 返信内容: "${pRev.reply_text}"`);
                  try {
                    // Post to Google GMB API
                    await oauth2Client.request({
                      url: `https://mybusiness.googleapis.com/v4/${pRev.review_id}/reply`,
                      method: 'PUT',
                      data: {
                        comment: pRev.reply_text
                      }
                    });

                    // Mark as replied in database
                    await prisma.reviewLogs.update({
                      where: { id: pRev.id },
                      data: {
                        is_auto_replied: true,
                        reply_source: 'AUTO',
                      }
                    });
                    console.log(`✅ [自動送信成功] 口コミ: ${pRev.review_id} への返信投稿を完了しました。`);
                  } catch (gmbErr: any) {
                    console.error(`❌ [自動送信失敗] 口コミ: ${pRev.review_id} への返信投稿に失敗しました:`, gmbErr.message || gmbErr);
                  }
                }
              }
            }
          }
        } catch (delayErr: any) {
          console.error(`❌ [自動返信スケジューラーエラー] 店舗: 「${shop.name}」の遅延返信処理でエラーが発生しました:`, delayErr.message || delayErr);
        }
      }
    }
  } catch (err) {
    console.error('❌ Scheduler error:', err);
  }
}

// POST /api/batch/trigger-scheduler
// Securely triggers the background scheduler cycle. Protected by CRON_SECRET API Key.
app.post('/api/batch/trigger-scheduler', async (req, res) => {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error('❌ CRON_SECRET environment variable is not set on the server!');
    return res.status(500).json({ error: 'サーバー側でCronセキュリティキーが設定されていません。' });
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '認証キーが提供されていません。' });
  }

  const token = authHeader.split(' ')[1];
  if (token !== cronSecret) {
    return res.status(403).json({ error: '認証キーが一致しません。アクセスが拒否されました。' });
  }

  console.log('📡 [セキュアCronリクエスト受信] バックグラウンドバッチ同期スケジュールを起動します...');
  
  // Non-blocking asynchronous execution to prevent HTTP timeout on the caller
  runBackgroundScheduler()
    .then(() => console.log('✅ Secure background scheduler execution completed successfully.'))
    .catch((err) => console.error('❌ Secure background scheduler execution failed:', err.message || err));

  return res.json({ success: true, message: 'バックグラウンドバッチ処理（自動投稿＆口コミ同期）を正常に起動しました！' });
});

// Start express server
app.listen(port, () => {
  console.log(`\n================================================================================`);
  console.log(`🚀 365MEO - Express API Server running on: http://localhost:${port}`);
  console.log(`📅 Started on: ${new Date().toLocaleString()}`);
  console.log(`================================================================================\n`);

  // ⏱️ Start Local Background Scheduler Fallback (Every 10 minutes & 15 seconds after startup)
  console.log('⏱️ [Internal Scheduler] Initializing internal fallback scheduler (10-minute intervals)...');
  setInterval(async () => {
    console.log('⏰ [Internal Scheduler] Executing automatic background sync cycle...');
    try {
      await runBackgroundScheduler();
      console.log('✅ [Internal Scheduler] Completed background sync cycle successfully.');
    } catch (err: any) {
      console.error('❌ [Internal Scheduler] Background sync cycle failed:', err.message || err);
    }
  }, 10 * 60 * 1000);

  setTimeout(async () => {
    console.log('⏰ [Internal Scheduler] Executing initial startup background sync...');
    try {
      await runBackgroundScheduler();
      console.log('✅ [Internal Scheduler] Completed initial startup background sync.');
    } catch (err: any) {
      console.error('❌ [Internal Scheduler] Initial startup background sync failed:', err.message || err);
    }
  }, 15 * 1000);

  // Master Account (gbp.suport365@gmail.com) Automatic Initialization / Sync
  setTimeout(async () => {
    try {
      console.log('👤 Checking Master Account (gbp.suport365@gmail.com) initialization...');
      
      // 🛡️ Bug-Free Onboarding: Create 365MEO live account ONLY if it does not exist.
      // This completely prevents data wiping upon server restarts (due to redeploys or password changes)!
      const targetThanxId = '365meo-shop-uuid';
      const liveThanxExists = await prisma.shop.findUnique({
        where: { email: '365meo@gmail.com' }
      });

      if (!liveThanxExists) {
        console.log('✨ Seeding live "株式会社３６５" OWNER account for the first time...');
        const ownerPassword = process.env.MASTER_OWNER_PASSWORD || 'password';
        await prisma.shop.create({
          data: {
            id: targetThanxId,
            name: '株式会社３６５',
            email: '365meo@gmail.com',
            password: ownerPassword,
            role: 'OWNER',
            agency_name: '365MEO',
            google_location_id: 'locations/7613471938029191960',
            google_drive_folder_id: '1AIgemm9-fvP-eLwP7p2p8Plja1mbOJtX',
            line_user_id: process.env.LINE_USER_ID || 'U205e0595cff6e3882288962525941500',
            reply_active: true,
            post_active: true,
            custom_review_prompt: '株式会社３６５のカスタマーサポートとして、極めて真摯にお詫びしてください。店舗様の売上向上に本気で伴走する企業として、サービス改善へ向けて早急に対応する熱い誠意を伝えてください。',
          }
        });

        // Recreate ShopKeywords with clean pristine defaults (draft_posts will be null, so generated fresh!)
        await prisma.shopKeywords.create({
          data: {
            shop_id: targetThanxId,
            main_keywords: JSON.stringify(['名古屋 MEO', 'MEO対策', 'Googleマップ集客', 'ローカルSEO', '365MEO']),
            sub_keywords: JSON.stringify(['口コミ対策', 'GBP運用', 'マップ順位', '集客効果', '名古屋マーケティング', '店舗集客', '自動投稿', 'SNS連動', '口コミ返信', 'AI作成']),
            fixed_footer: '店舗名: 株式会社３６５\n住所: 名古屋市中区\nお問い合わせ: 365meo@gmail.com',
            custom_prompt: '丁寧で自然なトーンで、MEO集客サポートの魅力を訴求してください。',
            post_time_hour: 12,
          }
        });

        // Recreate default templates
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
          'ご来店および素晴らしい評価をありがとうございます。お食事やお店の雰囲いを楽しんでいただけて何よりです。次回のご来店もお待ちしております。',
          '大変嬉しいお声をいただき、スタッフ一同の励みになります！次回はさらにご満足いただけるよう、心を込めておもてなしいたします。',
          'ご投稿ありがとうございます！高評価をいただき感謝申し上げます。今後とも変わらぬご愛顧 of the hood, よろしくお願い申し上げます。'
        ];
        const defaultStar5 = [
          'この度は最高評価をいただき、誠にありがとうございます！本当に嬉しいお言葉を励みに、これからも最上のサービスを追求してまいります。',
          'ご来店いただき、またお褒めの言葉をいただき大変光栄です！また次回も「来てよかった」と思っていただけるよう、全力を尽くします。',
          '素晴らしい評価をありがとうございます！当店での時間が素敵な思い出となったのであれば幸いです。またのご来店を心よりお待ちしております！',
          'スタッフ全員が笑顔になる最高の口コミをありがとうございます！いただいたエネルギーを糧に, 次回も完璧な施術・サービスを提供します。',
          'ご来店ありがとうございました！星5つの満点評価をいただき感謝の極みです。これからもお客様に愛され続けるお店を目指して頑張ります！'
        ];
        await prisma.replyTemplates.create({
          data: {
            shop_id: targetThanxId,
            templates_star3: JSON.stringify(defaultStar3),
            templates_star4: JSON.stringify(defaultStar4),
            templates_star5: JSON.stringify(defaultStar5),
          }
        });

        console.log('✅ Live "合同会社THANX CREATE" account has been successfully seeded for the first time!');
      } else {
        console.log('ℹ️ Live "合同会社THANX CREATE" account already exists. Skipping seed initialization to protect custom settings.');
      }

      // Safe purge existing demo agency and demo store
      const targetAgencyId = 'demo-agency-uuid';
      const targetAvenirId = 'demo-store-uuid';

      console.log('🧹 Purging existing Demo Agency X and Avenir Hair data...');
      await prisma.replyTemplates.deleteMany({ where: { shop_id: targetAgencyId } });
      await prisma.shopKeywords.deleteMany({ where: { shop_id: targetAgencyId } });
      await prisma.reviewLogs.deleteMany({ where: { shop_id: targetAgencyId } });
      await prisma.magicLinkToken.deleteMany({ where: { shop_id: targetAgencyId } });
      await prisma.shop.deleteMany({ where: { id: targetAgencyId } });

      await prisma.replyTemplates.deleteMany({ where: { shop_id: targetAvenirId } });
      await prisma.shopKeywords.deleteMany({ where: { shop_id: targetAvenirId } });
      await prisma.reviewLogs.deleteMany({ where: { shop_id: targetAvenirId } });
      await prisma.magicLinkToken.deleteMany({ where: { shop_id: targetAvenirId } });
      await prisma.shop.deleteMany({ where: { id: targetAvenirId } });

      const agencyByEmail2 = await prisma.shop.findUnique({ where: { email: 'meoseiha@dairiten.x' } });
      if (agencyByEmail2) {
        await prisma.replyTemplates.deleteMany({ where: { shop_id: agencyByEmail2.id } });
        await prisma.shopKeywords.deleteMany({ where: { shop_id: agencyByEmail2.id } });
        await prisma.reviewLogs.deleteMany({ where: { shop_id: agencyByEmail2.id } });
        await prisma.magicLinkToken.deleteMany({ where: { shop_id: agencyByEmail2.id } });
        await prisma.shop.delete({ where: { id: agencyByEmail2.id } });
      }

      const avenirByEmail = await prisma.shop.findUnique({ where: { email: 'meoseiha@avenir' } });
      if (avenirByEmail) {
        await prisma.replyTemplates.deleteMany({ where: { shop_id: avenirByEmail.id } });
        await prisma.shopKeywords.deleteMany({ where: { shop_id: avenirByEmail.id } });
        await prisma.reviewLogs.deleteMany({ where: { shop_id: avenirByEmail.id } });
        await prisma.magicLinkToken.deleteMany({ where: { shop_id: avenirByEmail.id } });
        await prisma.shop.delete({ where: { id: avenirByEmail.id } });
      }
      console.log('🧹 Purge completed successfully.');

      console.log('✨ Issuing brand-new clean AGENCY account for "代理店X"...');
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

      console.log('✨ Issuing brand-new clean OWNER account for "美髪改善サロン Avenir Hair"...');
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

      // Create Keywords for Avenir Hair
      await prisma.shopKeywords.create({
        data: {
          shop_id: targetAvenirId,
          main_keywords: JSON.stringify(['栄 美容室', '名古屋 髪質改善', '栄 カット', '髪質改善 サロン']),
          sub_keywords: JSON.stringify(['完全個室サロン', '縮毛矯正 栄', '白髪染め 名古屋', 'トリートメント 推奨']),
          fixed_footer: '店舗名: 美髪改善サロン Avenir Hair (アヴニールヘア)\n住所: 愛知県名古屋市中区栄3丁目\n営業時間: 10:00〜20:00 (完全予約制)\n定休日: 毎週月曜日\nご予約・お問い合わせはお気軽にどうぞ！',
          custom_prompt: '完全個室のリラックス空間と、髪を傷めない最先端の髪質改善トリートメント、飾りのない温かみのあるトーンでPRしてください。',
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
              text: '【髪質改善】栄駅徒歩5分の完全個室サロン Avenir Hair です。\n当サロンでは、お客様一人ひとりの髪質やクセに徹底的に向き合う「丁寧なカウンセリング技術」を大切にしています。\n\n栄で完全個室だからこそ、周りを気にせず髪のパサつきやダメージについて髪質改善トリートメントのご相談をいただけます。\n\n・オーダーメイドの極上髪質改善メニュー\n・完全個室のリラックスできるサロン空間\n・髪を傷めない最先端トリートメント技術\n\nお客様の髪本来の輝きとサロントリートメントによる感動的な艶を引き出します。\nお体のメンテナンスを兼ねて、ぜひ下記の「詳細」ボタンよりご予約情報をご確認ください。',
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

      // Create default templates for Avenir Hair
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
        }
      });

      // Create Review Logs for Avenir Hair
      await prisma.reviewLogs.create({
        data: {
          shop_id: targetAvenirId,
          review_id: 'review-star-5',
          reviewer_name: '田中 瑞希',
          star_rating: 5,
          comment: 'カウンセリングがとても丁寧で、私の髪質に合わせたオーダーメイドの髪質改善トリートメントをしていただきました。仕上がりは驚くほどサラサラで、完全個室なので周りを気にせずリラックスできました！またお邪魔します。',
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

      console.log('✅ Agency X and Avenir Hair demo data have been successfully seeded!');

      // Load secure master admin password from environment variable with a safe dynamic fallback
      const password = process.env.MASTER_ADMIN_PASSWORD || 'Suport365-MEO-Voice';

      const masterAccount = await prisma.shop.upsert({
        where: { email: 'gbp.suport365@gmail.com' },
        update: {
          password: password,
          role: 'ADMIN',
          post_active: false,
          google_drive_folder_id: '1AIgemm9-fvP-eLwP7p2p8Plja1mbOJtX',
          google_location_id: 'locations/7613471938029191960',
        },
        create: {
          name: '365MEO運営本部',
          email: 'gbp.suport365@gmail.com',
          password: password,
          role: 'ADMIN',
          post_active: false,
          google_drive_folder_id: '1AIgemm9-fvP-eLwP7p2p8Plja1mbOJtX',
          google_location_id: 'locations/7613471938029191960',
        }
      });
      console.log(`✅ Master Account configured successfully! (Email: ${masterAccount.email}, Role: ${masterAccount.role})`);

      // Cascade delete Agency X (osada@jira-chi.net) test account from both code and live database
      console.log('🧹 Running cleanups for deleted Agency accounts...');
      const agencyXEmail = 'osada@jira-chi.net';
      const agencyByEmail = await prisma.shop.findUnique({ where: { email: agencyXEmail } });
      if (agencyByEmail) {
        await prisma.replyTemplates.deleteMany({ where: { shop_id: agencyByEmail.id } });
        await prisma.shopKeywords.deleteMany({ where: { shop_id: agencyByEmail.id } });
        await prisma.reviewLogs.deleteMany({ where: { shop_id: agencyByEmail.id } });
        await prisma.magicLinkToken.deleteMany({ where: { shop_id: agencyByEmail.id } });
        await prisma.shop.delete({ where: { id: agencyByEmail.id } });
        console.log(`🧹 Cleaned up ${agencyXEmail} agency account successfully.`);
      }

      // Cascade delete おちあい・接骨院 test account and all its related records if they exist to keep production database clean
      console.log('🧹 Running cleanups for deleted test accounts...');
      const targetOchiaiId = 'ochiai-sekkotsuin-uuid';
      const deletedTemplates = await prisma.replyTemplates.deleteMany({ where: { shop_id: targetOchiaiId } });
      const deletedKeywords = await prisma.shopKeywords.deleteMany({ where: { shop_id: targetOchiaiId } });
      const deletedReviewLogs = await prisma.reviewLogs.deleteMany({ where: { shop_id: targetOchiaiId } });
      const deletedMagicTokens = await prisma.magicLinkToken.deleteMany({ where: { shop_id: targetOchiaiId } });
      const deletedShop = await prisma.shop.deleteMany({ where: { id: targetOchiaiId } });
      
      // Also delete any shop with email example@ochiai.com just in case it had a different ID
      const ochiaiByEmail = await prisma.shop.findUnique({ where: { email: 'example@ochiai.com' } });
      if (ochiaiByEmail) {
        await prisma.replyTemplates.deleteMany({ where: { shop_id: ochiaiByEmail.id } });
        await prisma.shopKeywords.deleteMany({ where: { shop_id: ochiaiByEmail.id } });
        await prisma.reviewLogs.deleteMany({ where: { shop_id: ochiaiByEmail.id } });
        await prisma.magicLinkToken.deleteMany({ where: { shop_id: ochiaiByEmail.id } });
        await prisma.shop.delete({ where: { id: ochiaiByEmail.id } });
      }
      console.log('🧹 Cleaned up おちあい・接骨院 test account data successfully.');
    } catch (dbErr: any) {
      console.error('❌ Failed to initialize Master Account:', dbErr.message || dbErr);
    }
  }, 2000);
});
