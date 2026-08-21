import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import * as path from 'path';
import stream from 'stream';
import { google } from 'googleapis';
import { Client } from '@line/bot-sdk';
import { prisma } from './services/db';
import { ReviewHandlerService, ReviewEvent } from './services/review-handler';

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
        custom_review_prompt: shop.custom_review_prompt,
      },
      ...(newToken ? { newToken } : {})
    });
  } catch (error) {
    console.error('❌ Auth validation error:', error);
    return res.status(500).json({ error: 'サーバー内でエラーが発生しました。' });
  }
});

// GET /api/shops (Get list of all stores - Master / Admin access)
app.get('/api/shops', async (req, res) => {
  try {
    const shops = await prisma.shop.findMany({
      where: {
        role: 'OWNER'
      },
      orderBy: { name: 'asc' }
    });
    return res.json({ shops });
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
          pageSize: 30,
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
  const { replyActive, customReviewPrompt, lineUserId, keywords } = req.body;

  try {
    // 1. Update Shop Profile details
    await prisma.shop.update({
      where: { id: shopId },
      data: {
        custom_review_prompt: customReviewPrompt,
        reply_active: typeof replyActive === 'boolean' ? replyActive : true,
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
      pageSize: 30,
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

    const reviews = await prisma.reviewLogs.findMany({
      where: { shop_id: shopId },
      orderBy: { create_time: 'desc' },
    });

    const cleanedReviews = reviews.map(r => ({
      ...r,
      comment: cleanGoogleComment(r.comment)
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

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new Error('Gemini APIキーが設定されていません。');
  }

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

  // Get current date context in Japanese to naturally incorporate seasonal topics
  const todayJp = new Date().toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  });

  const prompt = `
    あなたは店舗「${shop.name}」のオーナー代理として、Googleマップ（MEO）用の日替わり投稿テキスト（おしらせ/最新情報）を自動作成してください。

    【店舗情報】
    - 店舗名: ${shop.name}
    - ターゲット層へのアピール・トーンマナー: ${customPrompt || '親しみやすく誠実なトーン。'}
    - 今日の日付: ${todayJp}

    【作成の絶対ルール（厳守してください）】
    1. 毎回異なる構成・書き出し:
       直近の投稿や前後の下書きと、内容・書き出し（例：「こんにちは」「実は〜」など）・全体の構成が重複しないようにしてください。毎回バリエーション豊かでユニークな構成にしてください。
    2. メインキーワードの完全含有:
       指定されたメインキーワード [ ${mainKeywords.join(', ')} ] を、文章全体の自然な文脈にそって【すべて必ず】本文中に含めてください。単なるキーワードの羅列や強引な詰め込みは厳禁です。
    3. 本日のサブキーワード:
       本日の日替わりサブキーワード [ ${selectedSubKeywords.join(', ')} ] を、文章の中に自然に盛り込んでください。
    4. 宣伝的な「事実文」を必ず1文挿入:
       「誰が、どこで、何を提供しているか」を示す客観的・具体的な宣伝的事実文を、必ず本文の中に1文だけ織り込んでください。この事実文の言い回しやアプローチは毎回変えてください。
    5. 段落分けと適切な改行（読みやすさ重視）:
       文章が読みやすくなるよう、適宜2〜3つの論理的な段落に分け、段落の間に【必ず空行を1行】（改行2回）挟んでください。1行が長くなりすぎず、モバイル端末でも快適にスクロールしながら読めるスマートな体裁（MEOに最も適した配置）に仕上げてください。
    6. 文字数と文章の質:
       本文は【150文字〜250文字程度（改行を除く）】に収め、一般客が読んで「行ってみたい」「相談してみたい」と思える、親しみやすく自然な日本語で仕上げてください。
    7. 連絡先や署名情報の完全排除:
       本文の中には、ホームページURL、電話番号、アクションボタンの文言（「詳細はこちら」「今すぐ予約」など）、住所、会社名や店舗名のフッター署名などは【絶対に】含めないでください。（これらはシステム側でボタンとして登録されるため、テキスト内に記載すると重複して見苦しくなります）
    8. 記号・装飾の完全排除:
       絵文字、マークダウン（**、#、*など）、見出し、箇条書き、目立つ記号（■、★、◆、▲、【】など）は【一切】使わないでください。純粋な文章テキストと改行のみで出力してください。
    9. 季節・時期の話題 of 自然な織り込み:
       今日の日付（${todayJp}）を踏まえ、現在の季節や時期に合う話題（夏、お盆、暑さ対策など）を自然に入れられる場合は織り込んでください（無理に詰め込む必要はありません）。

    返される内容は自動作成した完成本文のみとし、説明、挨拶、マークダウン装飾（\`\`\`など）は一切含めないでください。`;

  let generatedText = '';
  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    generatedText = response.text().trim().replace(/```/g, '');
  } catch (err: any) {
    console.warn('⚠️ gemini-3.6-flash failed or was under heavy load. Falling back to stable gemini-3.5-flash:', err.message || err);
    try {
      const fallbackModel = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
      const result = await fallbackModel.generateContent(prompt);
      const response = await result.response;
      generatedText = response.text().trim().replace(/```/g, '');
    } catch (fallbackErr: any) {
      console.error('❌ Both gemini-3.6-flash and gemini-3.5-flash failed:', fallbackErr.message || fallbackErr);
      throw fallbackErr;
    }
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
          pageSize: 30,
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
        pageSize: 30,
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

      // Fetch latest 10 reviews from Google My Business API
      const reviewsRes = await oauth2Client.request({
        url: `https://mybusiness.googleapis.com/v4/${locationPath}/reviews`,
        method: 'GET'
      });

      const gbpReviews = (reviewsRes.data as any).reviews || [];
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
          // we import it silently as a historical review to show in the UI, but do NOT trigger any LINE alerts or AI reply drafts!
          if (reviewCreateDate < shopCreatedDate) {
            console.log(`📥 Silently importing historical pre-integration review by ${reviewerName} (Date: ${reviewCreateDate.toISOString()} < Shop Registration: ${shopCreatedDate.toISOString()}).`);
            const replyComment = gReview.reviewReply?.comment || null;

            await prisma.reviewLogs.create({
              data: {
                shop_id: shop.id,
                review_id: reviewId,
                reviewer_name: reviewerName,
                star_rating: starRating,
                comment,
                reply_text: replyComment,
                is_auto_replied: !!replyComment, // If already replied on Google, mark true, else false
                requires_alert: false,
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
    const shops = await prisma.shop.findMany({
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
      if (shop.keywords) {
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
                      data: { is_auto_replied: true }
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

  // Master Account (365meo.gbp@gmail.com) Automatic Initialization / Sync
  setTimeout(async () => {
    try {
      console.log('👤 Checking Master Account (365meo.gbp@gmail.com) initialization...');
      const thanxOwner = await prisma.shop.findUnique({
        where: { email: '365meo@gmail.com' }
      });
      const password = thanxOwner ? thanxOwner.password : 'password';

      const masterAccount = await prisma.shop.upsert({
        where: { email: '365meo.gbp@gmail.com' },
        update: {
          password: password,
          role: 'ADMIN',
        },
        create: {
          name: '365MEO運営本部',
          email: '365meo.gbp@gmail.com',
          password: password,
          role: 'ADMIN',
          google_drive_folder_id: thanxOwner ? thanxOwner.google_drive_folder_id : null,
          google_location_id: thanxOwner ? thanxOwner.google_location_id : null,
        }
      });
      console.log(`✅ Master Account configured successfully! (Email: ${masterAccount.email}, Role: ${masterAccount.role})`);

      // Sync existing 365MEO to direct agency
      await prisma.shop.updateMany({
        where: { id: '365meo-shop-uuid' },
        data: { agency_name: '365MEO' }
      });

      // Initialize Mock Shop A (代理店A)
      const shopA = await prisma.shop.upsert({
        where: { email: 'salon.sakae@example.com' },
        update: {
          agency_name: '代理店A'
        },
        create: {
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
      await prisma.shopKeywords.upsert({
        where: { shop_id: shopA.id },
        update: {},
        create: {
          shop_id: shopA.id,
          main_keywords: JSON.stringify(['栄 美容室', 'カット', 'カラー']),
          sub_keywords: JSON.stringify(['トリートメント', 'ヘッドスパ']),
          fixed_footer: '店舗名: テストヘアサロン 栄店\n住所: 名古屋市中区栄3丁目',
          custom_prompt: 'アットホームな雰囲気をアピールしてください。',
        }
      });

      // Initialize Mock Shop B (代理店B)
      const shopB = await prisma.shop.upsert({
        where: { email: 'izakaya.nishiki@example.com' },
        update: {
          agency_name: '代理店B'
        },
        create: {
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
      await prisma.shopKeywords.upsert({
        where: { shop_id: shopB.id },
        update: {},
        create: {
          shop_id: shopB.id,
          main_keywords: JSON.stringify(['錦 居酒屋', '焼き鳥', '個室']),
          sub_keywords: JSON.stringify(['飲み放題', '接待']),
          fixed_footer: '店舗名: テスト居酒屋 錦店\n住所: 名古屋市中区錦3丁目',
          custom_prompt: '賑やかで活気のある雰囲気をアピールしてください。',
        }
      });
      console.log('🏬 Mock testing shops (代理店A, 代理店B) initialized successfully!');
    } catch (dbErr: any) {
      console.error('❌ Failed to initialize Master Account:', dbErr.message || dbErr);
    }
  }, 2000);
});
