import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import * as path from 'path';
import stream from 'stream';
import { google } from 'googleapis';
import { Client } from '@line/bot-sdk';
import Anthropic from '@anthropic-ai/sdk';
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
              text: `🟢 MEO SEIHA連携用のLINEアカウントを検出しました！\n\nニックネーム: 「${displayName}」様\n\n管理画面に戻り、「このアカウントを連携する」ボタンを押して登録を完了してください。`,
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

// Helper to safely extract clean Google Drive folder ID
function extractGoogleDriveFolderId(input?: string | null): string {
  if (!input) return 'root';
  const trimmed = input.trim();
  if (!trimmed) return 'root';

  const urlMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }
  const queryMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (queryMatch && queryMatch[1]) {
    return queryMatch[1];
  }
  const segments = trimmed.split(/[\/\\]/);
  const lastSegment = segments[segments.length - 1].trim();
  return lastSegment || 'root';
}

// Interface for Google Drive file with subfolder information
interface DriveFileItem {
  id: string;
  name: string;
  folderName?: string;
  folderId?: string;
  mimeType?: string;
  size?: string;
  createdTime?: string;
  width?: number;
  height?: number;
  isValidForGbp?: boolean;
  invalidReason?: string;
}

// Reusable Helper to fetch all images from root folder AND all subfolders with folder metadata
async function fetchDriveFilesWithSubfolders(auth: any, rawFolderId: string): Promise<DriveFileItem[]> {
  const rootFolderId = extractGoogleDriveFolderId(rawFolderId);
  if (!auth || !rootFolderId || rootFolderId === 'root') {
    return [];
  }

  try {
    const drive = google.drive({ version: 'v3', auth });

    // Step 1: Scan for all subfolders directly inside the root folder
    let subfolders: any[] = [];
    const folderMap = new Map<string, string>(); // folderId -> folderName
    try {
      const subfolderRes = await drive.files.list({
        q: `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      subfolders = subfolderRes.data.files || [];
      subfolders.forEach((f: any) => {
        if (f.id && f.name) {
          folderMap.set(f.id, f.name.trim());
        }
      });
    } catch (subfolderErr: any) {
      console.warn('⚠️ Could not fetch subfolders from Drive, will only scan root folder:', subfolderErr.message || subfolderErr);
    }

    // Step 2: Query for all images in root folder OR in any of the subfolders
    const parentIds = [rootFolderId, ...Array.from(folderMap.keys())];
    const parentQuery = parentIds.map(id => `'${id}' in parents`).join(' or ');

    const imageRes = await drive.files.list({
      q: `(${parentQuery}) and (mimeType = 'image/jpeg' or mimeType = 'image/png' or mimeType = 'image/jpg') and trashed = false`,
      fields: 'files(id, name, mimeType, size, createdTime, parents, imageMediaMetadata)',
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const files = imageRes.data.files || [];
    const result: DriveFileItem[] = files.map((file: any) => {
      let folderName: string | undefined = undefined;
      let folderId: string | undefined = undefined;
      if (file.parents && file.parents.length > 0) {
        for (const p of file.parents) {
          if (folderMap.has(p)) {
            folderName = folderMap.get(p);
            folderId = p;
            break;
          }
        }
      }
      const sizeBytes = parseInt(file.size || '0', 10);
      const sizeMB = sizeBytes > 0 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : '不明';

      const width = file.imageMediaMetadata?.width ? parseInt(file.imageMediaMetadata.width, 10) : undefined;
      const height = file.imageMediaMetadata?.height ? parseInt(file.imageMediaMetadata.height, 10) : undefined;

      let isValidForGbp = true;
      let invalidReason: string | undefined = undefined;

      // Validate resolution (Google Business Profile requires >= 250x250)
      if (width !== undefined && height !== undefined) {
        if (width < 250 || height < 250) {
          isValidForGbp = false;
          invalidReason = `解像度が不足しています (${width}×${height}px)。GoogleマイビジネスのMEO投稿には縦横250px以上の画像が必要です。`;
        }
      } else if (file.name && file.name.match(/[-_](\d+)x(\d+)\.(jpg|jpeg|png)$/i)) {
        const match = file.name.match(/[-_](\d+)x(\d+)\.(jpg|jpeg|png)$/i);
        const w = parseInt(match[1], 10);
        const h = parseInt(match[2], 10);
        if (w < 250 || h < 250) {
          isValidForGbp = false;
          invalidReason = `解像度が不足しています (${w}×${h}px)。GoogleマイビジネスのMEO投稿には縦横250px以上の画像が必要です。`;
        }
      }

      // Validate max size (5MB)
      if (sizeBytes > 5 * 1024 * 1024) {
        isValidForGbp = false;
        invalidReason = 'ファイルサイズが5MBを超えています。Googleマイビジネスの仕様上、5MB以下の画像が必要です。';
      }

      return {
        id: file.id || '',
        name: file.name || '無題の写真',
        folderName,
        folderId,
        mimeType: file.mimeType || 'image/jpeg',
        size: sizeMB,
        createdTime: file.createdTime || new Date().toISOString(),
        width,
        height,
        isValidForGbp,
        invalidReason,
      };
    });

    return result;
  } catch (err: any) {
    console.error('⚠️ Failed to fetch Drive files with subfolders:', err.message || err);
    return [];
  }
}

interface GbpLocationDetails {
  title?: string;
  categoryName?: string;
  locality?: string;
  administrativeArea?: string;
  fullAddress?: string;
  phone?: string;
  websiteUri?: string;
}

// Helper to fetch GBP metadata (category, address, phone, website) from Google API
async function fetchGbpLocationDetails(oauth2Client: any, locationIdInput: string): Promise<GbpLocationDetails | null> {
  if (!oauth2Client || !locationIdInput) return null;
  const numericalId = locationIdInput.match(/\d+/)?.[0];
  if (!numericalId) return null;

  try {
    const mybusiness = google.mybusinessaccountmanagement({
      version: 'v1',
      auth: oauth2Client
    });
    const accountsRes = await mybusiness.accounts.list();
    const accounts = accountsRes.data.accounts || [];
    
    for (const account of accounts) {
      if (account.name) {
        const fullLocationPath = `${account.name}/locations/${numericalId}`;
        try {
          const locRes = await oauth2Client.request({
            url: `https://mybusiness.googleapis.com/v4/${fullLocationPath}`,
            method: 'GET'
          });
          const locData = locRes.data as any;
          if (locData) {
            const addr = locData.address || {};
            const city = addr.locality || addr.sublocality || '';
            const pref = addr.administrativeArea || '';
            const addressLines = (addr.addressLines || []).join(' ');
            const fullAddr = [pref, city, addressLines].filter(Boolean).join(' ');
            
            return {
              title: locData.locationName || locData.title,
              categoryName: locData.primaryCategory?.displayName || locData.primaryCategory?.categoryName || '',
              locality: city || pref,
              administrativeArea: pref,
              fullAddress: fullAddr,
              phone: locData.primaryPhone,
              websiteUri: locData.websiteUrl
            };
          }
        } catch (v4Err: any) {
          // If individual location query fails, continue to next account
        }
      }
    }
  } catch (err: any) {
    console.warn('⚠️ Could not fetch GBP location details:', err.message || err);
  }
  return null;
}

// Automatically initialize default ShopKeywords & settings from GBP info (or store name)
async function initializeShopKeywords(shop: any, driveFilesList: DriveFileItem[] = []) {
  if (shop.keywords) {
    return shop.keywords;
  }

  console.log(`✨ Initializing default ShopKeywords and settings for shop: "${shop.name}"`);

  let gbpDetails: GbpLocationDetails | null = null;
  const auth = getGoogleAuthClient();
  const locationIdInput = shop.google_location_id;

  if (auth && locationIdInput) {
    try {
      gbpDetails = await fetchGbpLocationDetails(auth, locationIdInput);
      if (gbpDetails) {
        console.log(`📍 Successfully fetched GBP metadata for "${shop.name}":`, gbpDetails);
      }
    } catch (e) {
      console.warn('⚠️ Failed to fetch GBP metadata for initial keywords:', e);
    }
  }

  const storeTitle = gbpDetails?.title || shop.name || '店舗';
  const category = gbpDetails?.categoryName || '店舗';
  const locality = gbpDetails?.locality || '';

  // 1. Build tailored main keywords
  const mainKws: string[] = [];
  if (locality && category && category !== '店舗') {
    mainKws.push(`${locality} ${category}`);
  }
  mainKws.push(storeTitle);
  if (category && category !== '店舗') {
    mainKws.push(`${category} おすすめ`);
  }
  if (locality && storeTitle) {
    mainKws.push(`${locality} ${storeTitle}`);
  }
  if (mainKws.length < 3) {
    mainKws.push('最新情報', 'おすすめメニュー');
  }

  // 2. Build tailored sub keywords
  const subKws: string[] = [
    category !== '店舗' ? `${category} メニュー` : 'こだわりメニュー',
    '季節のおすすめ',
    '人気サービス',
    'ご予約受付中',
    'お客様の声',
    'アクセス・店舗情報',
  ];

  // 3. Build fixed footer
  const footerLines = ['━━━━━━━━━━━━━━━━', storeTitle];
  if (gbpDetails?.fullAddress) {
    footerLines.push(`📍 住所: ${gbpDetails.fullAddress}`);
  }
  if (gbpDetails?.phone) {
    footerLines.push(`📞 電話番号: ${gbpDetails.phone}`);
  }
  if (gbpDetails?.websiteUri) {
    footerLines.push(`🌐 公式HP: ${gbpDetails.websiteUri}`);
  }
  footerLines.push('ご来店・お問い合わせを心よりお待ちしております。', '━━━━━━━━━━━━━━━━');
  const fixedFooter = footerLines.join('\n');

  // 4. Custom prompt
  const locationPrefix = locality ? `${locality}の` : '';
  const categoryLabel = category && category !== '店舗' ? `${category}` : '店舗';
  const customPrompt = `親しみやすく誠実なトーンで。${locationPrefix}${categoryLabel}「${storeTitle}」の魅力やこだわり、専門的な強みについて、お客様にとって有益で分かりやすい内容で発信してください。`;

  // 5. Generate 3 initial AI drafts
  let draftPostsArr = [];
  try {
    const dummyShop = {
      ...shop,
      keywords: {
        main_keywords: JSON.stringify(mainKws),
        sub_keywords: JSON.stringify(subKws),
        fixed_footer: fixedFooter,
        custom_prompt: customPrompt,
      }
    };
    const day0 = await generateSingleDraft(dummyShop, 0, driveFilesList);
    const day1 = await generateSingleDraft(dummyShop, 1, driveFilesList);
    const day2 = await generateSingleDraft(dummyShop, 2, driveFilesList);
    draftPostsArr = [
      { dayIndex: 0, title: '今日投稿予定の下書き (Day 0)', text: day0.text, subKeywords: day0.subKeywords, imageFileId: day0.imageFileId || null, promptType: day0.promptType },
      { dayIndex: 1, title: '明日投稿予定の下書き (Day 1)', text: day1.text, subKeywords: day1.subKeywords, imageFileId: day1.imageFileId || null, promptType: day1.promptType },
      { dayIndex: 2, title: '明後日投稿予定の下書き (Day 2)', text: day2.text, subKeywords: day2.subKeywords, imageFileId: day2.imageFileId || null, promptType: day2.promptType },
    ];
  } catch (genErr) {
    console.warn('⚠️ Initial draft generation during setup failed, using placeholder drafts:', genErr);
    draftPostsArr = [
      { dayIndex: 0, title: '今日投稿予定の下書き (Day 0)', text: `${storeTitle}の本日のおしらせ下書きです。`, subKeywords: [] },
      { dayIndex: 1, title: '明日投稿予定の下書き (Day 1)', text: `${storeTitle}の明日のおしらせ下書きです。`, subKeywords: [] },
      { dayIndex: 2, title: '明後日投稿予定の下書き (Day 2)', text: `${storeTitle}の明後日のおしらせ下書きです。`, subKeywords: [] },
    ];
  }

  const createdKeywords = await prisma.shopKeywords.upsert({
    where: { shop_id: shop.id },
    update: {},
    create: {
      shop_id: shop.id,
      main_keywords: JSON.stringify(mainKws),
      sub_keywords: JSON.stringify(subKws),
      fixed_footer: fixedFooter,
      custom_prompt: customPrompt,
      hp_url: gbpDetails?.websiteUri || null,
      draft_posts: JSON.stringify(draftPostsArr),
      post_time_hour: 9,
    }
  });

  return createdKeywords;
}

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
    let driveFilesList: DriveFileItem[] = mockDriveFiles;

    const auth = getGoogleAuthClient();
    if (auth && shop.google_drive_folder_id) {
      try {
        const liveFiles = await fetchDriveFilesWithSubfolders(auth, shop.google_drive_folder_id);
        if (liveFiles.length > 0) {
          driveFilesList = liveFiles;
        } else {
          driveFilesList = [];
        }
      } catch (e) {
        console.log('⚠️ Failed to fetch live Drive images for dashboard, using fallback count.');
      }
    }

    const validDriveFiles = driveFilesList.filter(f => f.isValidForGbp !== false);
    const invalidDriveFiles = driveFilesList.filter(f => f.isValidForGbp === false);
    const validImageCount = validDriveFiles.length;
    const invalidImageCount = invalidDriveFiles.length;
    const totalImageCount = driveFilesList.length;

    let firstFileId = validDriveFiles.length > 0 ? validDriveFiles[0].id : null;

    // Determine Posting Mode based on VALID image stock
    let postingMode = 'TEXT_ONLY';
    let postingModeLabel = '有効画像0枚: テキストのみ投稿モード';
    if (validImageCount >= 10) {
      postingMode = 'ALWAYS_IMAGE';
      postingModeLabel = `画像ストック${validImageCount}枚（10枚以上）: 画像連続投稿モード`;
    } else if (validImageCount >= 1) {
      postingMode = 'ALTERNATING';
      postingModeLabel = `画像ストック${validImageCount}枚（1〜9枚）: 交互投稿モード (画像とテキストを日替わり)`;
    }

    // Count pending bad reviews (Requires alert & not replied)
    const pendingReviewsCount = await prisma.reviewLogs.count({
      where: {
        shop_id: shopId,
        star_rating: { lte: 2 },
        is_auto_replied: false,
      }
    });

    // Auto-initialize ShopKeywords & default tailored settings if missing
    if (!shop.keywords) {
      shop.keywords = await initializeShopKeywords(shop, driveFilesList);
    }

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
            { dayIndex: 0, title: '今日投稿予定の下書き (Day 0)', text: day0.text, subKeywords: day0.subKeywords, imageFileId: day0.imageFileId || null, promptType: day0.promptType },
            { dayIndex: 1, title: '明日投稿予定の下書き (Day 1)', text: day1.text, subKeywords: day1.subKeywords, imageFileId: day1.imageFileId || null, promptType: day1.promptType },
            { dayIndex: 2, title: '明後日投稿予定の下書き (Day 2)', text: day2.text, subKeywords: day2.subKeywords, imageFileId: day2.imageFileId || null, promptType: day2.promptType },
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

    let mapsUrl: string | null = null;
    try {
      const matchedStore: any[] = await prisma.$queryRawUnsafe(
        'SELECT "gbpMapsUri" FROM "Store" WHERE "voiceShopId" = $1 LIMIT 1',
        shopId
      );
      if (matchedStore.length > 0 && matchedStore[0].gbpMapsUri) {
        mapsUrl = matchedStore[0].gbpMapsUri.trim();
      }
    } catch (e) {}

    // Fallback/Override for 株式会社陽向 with verified direct map link
    if (shop.name.includes('陽向')) {
      mapsUrl = 'https://maps.app.goo.gl/9Nm2XpdP4Jht7BJR8';
    }

    return res.json({
      shopName: shop.name,
      replyActive: shop.reply_active,
      postActive: shop.post_active,
      imageCount: validImageCount,
      totalImageCount,
      invalidImageCount,
      invalidImages: invalidDriveFiles.map(f => ({ id: f.id, name: f.name, reason: f.invalidReason, width: f.width, height: f.height })),
      postingMode,
      postingModeLabel,
      pendingReviewsCount,
      nextPostTime: `本日 ${(shop.keywords as any)?.post_time_hour ?? 9}:00 予定`,
      previewImage,
      googleLocationId: shop.google_location_id,
      mapsUrl,
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

    if (!shop.keywords) {
      shop.keywords = await initializeShopKeywords(shop);
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
        postTimeHour: (shop.keywords as any)?.post_time_hour ?? 9,
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
  const { replyActive, postActive, customReviewPrompt, lineUserId, keywords, googleLocationId } = req.body;

  try {
    const updateData: any = {
      custom_review_prompt: customReviewPrompt,
      reply_active: typeof replyActive === 'boolean' ? replyActive : true,
      post_active: typeof postActive === 'boolean' ? postActive : true,
      line_user_id: lineUserId || null,
    };

    if (googleLocationId !== undefined) {
      updateData.google_location_id = googleLocationId
        ? (googleLocationId.startsWith('locations/') ? googleLocationId : `locations/${googleLocationId}`)
        : null;
    }

    // 1. Update Shop Profile details
    await prisma.shop.update({
      where: { id: shopId },
      data: updateData,
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
          post_time_hour: typeof keywords.postTimeHour === 'number' ? keywords.postTimeHour : 9,
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
          post_time_hour: typeof keywords.postTimeHour === 'number' ? keywords.postTimeHour : 9,
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

    const folderId = shop.google_drive_folder_id || 'root';

    console.log(`📂 Scanning Google Drive folder and subfolders: ${folderId}...`);
    const files = await fetchDriveFilesWithSubfolders(auth, folderId);

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
      supportsAllDrives: true,
    });

    res.setHeader('Content-Type', metadata.data.mimeType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day

    // 2. Fetch the actual media content stream and pipe directly to Express response
    const fileRes = await drive.files.get({
      fileId,
      alt: 'media',
      supportsAllDrives: true,
    }, { responseType: 'stream' });

    fileRes.data.pipe(res);
  } catch (error: any) {
    console.error(`❌ Failed to stream Google Drive image ${fileId}:`, error.message || error);
    // Graceful redirect so the client UI never shows broken image icons
    return res.redirect('https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&q=80&w=600');
  }
});

// GET /api/shops/:shopId/drive-folders (Fetch list of subfolders in Google Drive)
app.get('/api/shops/:shopId/drive-folders', async (req, res) => {
  const { shopId } = req.params;

  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    const auth = getGoogleAuthClient();

    if (!shop) {
      return res.status(404).json({ error: '店舗が見つかりませんでした。' });
    }

    const folderId = extractGoogleDriveFolderId(shop.google_drive_folder_id);
    if (!auth || !folderId || folderId === 'root') {
      return res.json({ folders: [] });
    }

    const drive = google.drive({ version: 'v3', auth });
    const subfolderRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const folders = (subfolderRes.data.files || []).map((f: any) => ({
      id: f.id || '',
      name: f.name ? f.name.trim() : '無題のフォルダ',
    }));

    return res.json({ folders });
  } catch (error: any) {
    console.error('❌ Failed to fetch Drive folders:', error.message || error);
    return res.json({ folders: [] });
  }
});

// POST /api/shops/:shopId/drive-images/upload (Upload raw base64 photo directly into Google Drive with target subfolder)
app.post('/api/shops/:shopId/drive-images/upload', async (req, res) => {
  const { shopId } = req.params;
  const { fileName, mimeType, base64Data, targetFolderId, newFolderName } = req.body;

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
    let destinationFolderId = extractGoogleDriveFolderId(shop.google_drive_folder_id) || 'root';
    let targetFolderName: string | undefined = undefined;

    // Handle new folder creation if specified
    if (newFolderName && newFolderName.trim()) {
      try {
        console.log(`📁 Creating new subfolder in Drive: "${newFolderName.trim()}"...`);
        const folderCreateRes = await drive.files.create({
          requestBody: {
            name: newFolderName.trim(),
            mimeType: 'application/vnd.google-apps.folder',
            parents: [destinationFolderId],
          },
          fields: 'id, name',
          supportsAllDrives: true,
        });
        if (folderCreateRes.data.id) {
          destinationFolderId = folderCreateRes.data.id;
          targetFolderName = folderCreateRes.data.name?.trim();
        }
      } catch (fErr: any) {
        console.warn('⚠️ Failed to create new subfolder in Drive, falling back to root folder:', fErr.message || fErr);
      }
    } else if (targetFolderId && targetFolderId !== 'root') {
      destinationFolderId = targetFolderId;
      try {
        const fMeta = await drive.files.get({ fileId: targetFolderId, fields: 'name', supportsAllDrives: true });
        targetFolderName = fMeta.data.name?.trim();
      } catch (e) {}
    }

    // Upload Stream
    const bufferStream = new stream.PassThrough();
    bufferStream.end(fileBuffer);

    console.log(`🔄 Uploading file ${fileName} into Drive folder: ${destinationFolderId} (${targetFolderName || '直下'})...`);
    const uploadRes = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [destinationFolderId],
        mimeType: mimeType,
      },
      media: {
        mimeType: mimeType,
        body: bufferStream,
      },
      fields: 'id, name, mimeType, size, createdTime',
      supportsAllDrives: true,
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
        folderName: targetFolderName,
        folderId: destinationFolderId,
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
    await drive.files.delete({ fileId, supportsAllDrives: true });

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
      where: { shop_id: shopId, is_hidden: false },
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

// DELETE /api/shops/:shopId/reviews/:reviewId (Soft delete a review log to prevent GBP re-sync resurrection)
app.delete('/api/shops/:shopId/reviews/:reviewId', async (req, res) => {
  const { shopId, reviewId } = req.params;

  try {
    await prisma.reviewLogs.update({
      where: { review_id: reviewId },
      data: { is_hidden: true, requires_alert: false }
    });
    return res.json({ success: true, message: '口コミ履歴を削除（非表示）にしました。' });
  } catch (error: any) {
    console.error('❌ Failed to delete review log:', error);
    return res.status(500).json({ error: error.message || '口コミ履歴の削除に失敗しました。' });
  }
});

// DELETE /api/shops/:shopId/reviews (Clear all reviews with soft delete)
app.delete('/api/shops/:shopId/reviews', async (req, res) => {
  const { shopId } = req.params;

  try {
    await prisma.reviewLogs.updateMany({
      where: { shop_id: shopId },
      data: { is_hidden: true, requires_alert: false }
    });
    return res.json({ success: true, message: 'すべての口コミ履歴をクリア（非表示）にしました。' });
  } catch (error: any) {
    console.error('❌ Failed to clear review logs:', error);
    return res.status(500).json({ error: error.message || '口コミ履歴のクリアに失敗しました。' });
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

// Interface for Medical Fact Check result
interface FactCheckResult {
  passed: boolean;
  reason: string;
  issues: string[];
  correctionAdvice: string;
}

// Helper to run fact check using Anthropic Claude (claude-3-5-haiku / claude-3-haiku)
async function factCheckMedicalPost(draftText: string, shopName: string): Promise<FactCheckResult> {
  const claudeApiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!claudeApiKey) {
    console.warn('⚠️ CLAUDE_API_KEY is not set. Defaulting to passed for medical fact check.');
    return { passed: true, reason: 'CLAUDE_API_KEY未設定のためスキップ', issues: [], correctionAdvice: '' };
  }

  const prompt = `あなたは医療法・医療広告ガイドライン・薬機法（医薬品医療機器等法）・柔道整復師法およびGoogleビジネスプロフィールポリシーの専門審査官です。
以下のGoogleマップ（MEO）向け医療・健康関連投稿テキストを厳格にファクトチェックおよびコンプライアンス審査してください。対象店舗: 「${shopName}」

【審査基準（NG判定条件）】
1. 治癒・効果効能の断定・保証:
   「絶対に治る」「必ず改善する」「完全に治す」「100%安全」「副作用がない」「確実に効く」「根本改善を保証」などの断定・保証表現が含まれていないか。
2. 誇大・最高級・比較表現:
   「地域No.1」「最高峰」「唯一」「神の手」「完璧」「他院より優れている」などの客観的根拠のない最上級・比較表現が含まれていないか。
3. 虚偽・未確認の医学的断定:
   特定の症状から病名を勝手に確定させていたり、医学的根拠のない予防・治療効果、虚偽の専門資格や症例実績を創作していないか。
4. 広告ガイドライン・法令抵触:
   医師の診断と施術・服薬指導の混同、処方薬の無断中止勧奨、承認外効能の標榜など、法令やガイドラインに抵触する表現がないか。
5. 形式ルール:
   最後に指定CTA「『詳細』ボタン、またはプロフィールのウェブサイトリンクからお気軽にお問い合わせください。」が含まれており、過度な不安煽りや不適切なマークダウン記号（**や#など）・絵文字がないか。

【審査対象テキスト】
${draftText}

【出力フォーマット】
必ず以下の有効なJSON形式のみを出力してください（マークダウンのコードブロックや余分なテキストは一切含めないでください）。
{
  "passed": true または false,
  "reason": "審査結果の要約（50文字以内）",
  "issues": ["NG判定された具体的な問題箇所や不適切表現（合格の場合は空配列）"],
  "correctionAdvice": "再生成時に修正すべき具体的なアドバイス（合格の場合は空文字）"
}`;

  try {
    const anthropic = new Anthropic({ apiKey: claudeApiKey });
    const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1000,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    });

    const contentText = response.content[0].type === 'text' ? response.content[0].text : '';
    const cleanJson = contentText.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleanJson);

    return {
      passed: typeof parsed.passed === 'boolean' ? parsed.passed : true,
      reason: parsed.reason || '',
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      correctionAdvice: parsed.correctionAdvice || '',
    };
  } catch (err: any) {
    console.error('❌ Claude fact check API error:', err.message || err);
    return { passed: true, reason: '審査API通信エラーのためフォールバック通過', issues: [], correctionAdvice: '' };
  }
}

async function generateTextFromGemini(genAI: any, promptText: string): Promise<string> {
  const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
  try {
    const result = await model.generateContent(promptText);
    const response = await result.response;
    return response.text().trim().replace(/```/g, '');
  } catch (err: any) {
    console.warn('⚠️ gemini-3.6-flash failed or was under heavy load. Falling back to stable gemini-3.5-flash:', err.message || err);
    const fallbackModel = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
    const result = await fallbackModel.generateContent(promptText);
    const response = await result.response;
    return response.text().trim().replace(/```/g, '');
  }
}

async function checkIsMedicalShop(shop: any): Promise<boolean> {
  if (typeof shop.is_medical === 'boolean') {
    return shop.is_medical;
  }
  try {
    const res: any[] = await prisma.$queryRawUnsafe(
      'SELECT is_medical FROM "Shop" WHERE id = $1 LIMIT 1',
      shop.id
    );
    if (res.length > 0 && typeof res[0].is_medical === 'boolean') {
      return res[0].is_medical;
    }
  } catch (e) {}
  return false;
}

// Helper to generate a single day's MEO draft post using Gemini AI
async function generateSingleDraft(
  shop: any,
  dayIndex: number,
  driveFiles?: DriveFileItem[],
  forceTextOnly: boolean = false,
  isTodayPublishedParam?: boolean
): Promise<{ text: string, subKeywords: string[], imageFileId: string | null, promptType: 'MEDICAL' | 'STANDARD' }> {
  const mainKeywords: string[] = JSON.parse(shop.keywords?.main_keywords || '[]');
  const subKeywords: string[] = JSON.parse(shop.keywords?.sub_keywords || '[]');
  const customPrompt = shop.keywords?.custom_prompt || '';
  const hpUrl = shop.keywords?.hp_url || '';
  const fixedFooter = shop.keywords?.fixed_footer || '';
  const isMedicalShop = await checkIsMedicalShop(shop);

  let isTodayPublished = false;
  if (isTodayPublishedParam !== undefined) {
    isTodayPublished = isTodayPublishedParam;
  } else {
    try {
      const existingDrafts: any[] = JSON.parse(shop.keywords?.draft_posts || '[]');
      const publishedItem = existingDrafts.find((d: any) => d.dayIndex === -1);
      if (publishedItem) {
        if (!publishedItem.publishedAt) {
          isTodayPublished = true;
        } else {
          const formatter = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
          const todayJst = formatter.format(new Date());
          const pubDateStr = formatter.format(new Date(publishedItem.publishedAt));
          isTodayPublished = (pubDateStr === todayJst);
        }
      }
    } catch (e) {}
  }

  let imageFileId: string | null = null;
  const selectedSubKeywords: string[] = [];

  const validDriveFiles = (driveFiles || []).filter(f => f.isValidForGbp !== false);
  const imageCount = validDriveFiles.length;
  const isAlternating = imageCount >= 1 && imageCount < 10;
  const shouldBeTextOnly = forceTextOnly || (isAlternating && dayIndex % 2 === 1);

  // 1. First, select the daily randomized sub-keywords
  if (subKeywords.length > 0) {
    const shuffled = [...subKeywords].sort(() => 0.5 - Math.random());
    const count = Math.floor(Math.random() * 2) + 2; // 2 or 3
    selectedSubKeywords.push(...shuffled.slice(0, Math.min(count, shuffled.length)));
  }

  // 2. Intelligent Image Selection with Subfolder Matching & Safe Root Fallback (VALID images only)
  if (validDriveFiles.length > 0 && !shouldBeTextOnly) {
    const subfolderMatchedFiles: DriveFileItem[] = [];

    // Check if any drive file belongs to a subfolder that matches one of the selected sub-keywords
    if (selectedSubKeywords.length > 0) {
      for (const file of validDriveFiles) {
        if (file.folderName) {
          const normalizedFolderName = file.folderName.trim().toLowerCase();
          const isMatched = selectedSubKeywords.some((subKw: string) => {
            const normalizedSubKw = subKw.trim().toLowerCase();
            return normalizedFolderName === normalizedSubKw || normalizedFolderName.includes(normalizedSubKw) || normalizedSubKw.includes(normalizedFolderName);
          });
          if (isMatched) {
            subfolderMatchedFiles.push(file);
          }
        }
      }
    }

    if (subfolderMatchedFiles.length > 0) {
      // Pick randomly from the matching subfolder images!
      const randomIndex = Math.floor(Math.random() * subfolderMatchedFiles.length);
      const selectedFile = subfolderMatchedFiles[randomIndex];
      imageFileId = selectedFile.id || null;
      console.log(`📁 [サブフォルダ連動] サブキーワード [${selectedSubKeywords.join(', ')}] に一致するフォルダ「${selectedFile.folderName}」から画像(${selectedFile.id})を選択しました。`);
    } else {
      // 100% Safe Root Fallback: Pick randomly from the entire valid pool
      const randomIndex = Math.floor(Math.random() * validDriveFiles.length);
      const selectedFile = validDriveFiles[randomIndex];
      imageFileId = selectedFile.id || null;
    }
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new Error('Gemini APIキーが設定されていません。');
  }

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(geminiApiKey);

  // Standard Themes
  const standardThemes = [
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

  // Medical / Healthcare Specific Themes (YMYL Compliant)
  const medicalThemes = [
    {
      name: "症状・健康悩みサポート型 (Health & Symptom Support)",
      focus: "季節の変わり目の体調変化、日常の健康不安、お薬の飲み合わせなどのお悩みに対して、専門知識に基づいて丁寧に寄り添い、相談・受診を案内する構成。"
    },
    {
      name: "診療・調剤サービス紹介型 (Medical & Dispensing Services)",
      focus: "実施している診療案内、処方箋事前受付、一包化調剤、訪問服薬指導、健康相談など、提供しているサービスの特徴や利用メリットを客観的に解説する構成。"
    },
    {
      name: "施設・受診シチュエーション型 (Visit & Consultation Context)",
      focus: "「お仕事帰りに立ち寄りたい」「子育て中で時間が取れない」「急な体調不良の時に」など、具体的な受診・利用場面に焦点を当て、通いやすさや安心できる環境をアピールする構成。"
    },
    {
      name: "医療・お薬よくある質問回答型 (Medical & Pharmacy FAQ)",
      focus: "患者様からよく受ける代表的な疑問（処方箋の有効期限、お薬の保管方法、受診の流れなど）に、わかりやすく客観的に答える構成。"
    },
    {
      name: "専門性・かかりつけのこだわり提示型 (Expertise & Care Commitment)",
      focus: "丁寧な服薬指導、分かりやすい病状説明、プライバシーへの配慮、地域のかかりつけとしての誠実な姿勢について客観的な事実に基づいて解説する構成。"
    },
    {
      name: "年代・お悩み別健康アピール型 (Patient-Centered Care)",
      focus: "ご高齢の方、働くビジネスパーソン、お子様連れの親御様など、対象に合わせた安心の医療・調剤サポートを具体的に語る構成。"
    }
  ];

  // Get current target date and day of week in JST calculated dynamically from dayOffset
  const dayOffset = isTodayPublished ? (dayIndex + 1) : dayIndex;
  const now = new Date();
  const targetDate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  const targetDateJp = targetDate.toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  const targetWeekday = targetDate.toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    weekday: 'long'
  });

  // Prompt Builders
  const buildStandardPrompt = () => {
    const selectedTheme = standardThemes[dayIndex % standardThemes.length];
    return `
    あなたは店舗「${shop.name}」のオーナー代理として、Googleマップ（MEO）および生成AI検索（AIO/LLMO）向けに最適化された、日替わりの店舗投稿テキスト（おしらせ/最新情報）を自動作成してください。

    【今回の投稿テーマ・検索意図】
    - テーマ名: ${selectedTheme.name}
    - 執筆のフォーカス: ${selectedTheme.focus}
    ※必ずこのテーマの検索文脈・意図に完全に合致する内容で執筆してください。

    【店舗基本情報】
    - 店舗名: ${shop.name}
    - 所在地住所情報（固定フッターより抜粋）: ${fixedFooter || '未設定'}
    - ターゲット層へのアピール・トーンマナー: ${customPrompt || '親しみやすく誠実なトーン。'}
    - 本日の下書きの公開予定日: ${targetDateJp}
    - 公開予定曜日: 【${targetWeekday}】
    - 投稿スロット番号: Day ${dayIndex} (${isTodayPublished ? (dayIndex === 0 ? '明日投稿分' : dayIndex === 1 ? '明後日投稿分' : '明々後日投稿分') : (dayIndex === 0 ? '本日投稿分' : dayIndex === 1 ? '明日投稿分' : '明後日投稿分')})

    【言語決定の最重要ルール（最優先・絶対厳守）】
    「ターゲット層へのアピール・トーンマナー」に記載されている曜日別・日毎の言語指定（日本語、英語、韓国語、中国語など）がある場合は、必ず上記の【公開予定曜日】（${targetWeekday}）に厳密に従い、該当する曜日に指定された言語で本文全体・箇条書き・CTA・キーワードのすべてを執筆してください。指定された言語以外の言語で出力することは絶対に禁止します。
    ※特に言語の指定がない場合は、自然な日本語で執筆してください。

    【作成の絶対ルール（厳守してください）】
    1. 結論ファースト（PREP法）の徹底:
       文章の冒頭（最初の一文、30〜50文字程度）で、時候の挨拶などを一切省き、「【主要キーワード/テーマ】店舗名＋エリア名＋主要サービス（結論）」を一発で言い切る形で書き出してください。
       また、この結論を言い切った最初の一文の直後には、必ず【空行を1行】挟んでから、次の文章（最寄り駅や詳細なアクセス情報など）を書き始めてください。（冒頭が1つの重たい段落にまとまるのを物理的に防ぎます）

    2. 主語・エリア・サービス名の明確化（5W1Hの網羅）:
       主語を「当店」や「当院」などの曖昧な言葉にせず、必ず「${shop.name}」という具体的な店舗名で表記してください。また、エリア名（店舗の所在地・地域）を一文の中に自然に含めてください。エリア名については、必ず「所在地住所情報（固定フッター）」に記載されている住所情報のみから正しい地域名（市区町村名や駅名など）を抽出し、それを使用してください。フッターに住所情報がない場合、あるいは未設定の場合は、具体的な地域名は出力せず、所在地を特定しない汎用的な表現にしてください。メインキーワードやその他の情報から地域名を取得したり、存在しない架空の地域名を捏造することは絶対に禁止します。

    3. メインキーワードの完全含有:
       指定されたメインキーワード [ ${mainKeywords.join(', ')} ] を、文章全体の自然な文脈にそって【すべて必ず】本文中に含めてください。単なるキーワードの羅列や強引な詰め込みは厳禁です。（※英語や韓国語等の他言語で執筆する場合は、文脈に合わせてキーワードの意味を正しく自然に翻訳して含めてください）

    4. 本日のサブキーワード:
       本日の日替わりサブキーワード [ ${selectedSubKeywords.join(', ')} ] を、文章の中に自然に盛り込んでください。

    5. 曖昧な表現の排除と一次情報・数値の提示:
       抽象的な形容詞や曖昧なアピールを徹底的に排除してください。代わりに、店舗が実際に提供している客観的・専門的な事実や具体的なアプローチ（一次情報、独自のこだわり、サービス工程、実績など）を具体的に記述してください。

    6. 特徴・こだわりの箇条書き構造化（中盤）:
       文章の中盤部分で、今回のテーマに関連する店舗のこだわり・特徴・サービス内容を、必ず【3つの箇条書き（「・」マークを使用）】で簡潔に整理してください。
       箇条書きに入る直前の説明・移行文（例：「特徴を専門的な視点からご紹介します。」など）の直後には、必ず【空行を1行】挟んでから、箇条書きの1項目目を書き始めてください（移行文と箇条書きが同じ塊に連結するのを防ぎます）。LLMが最も要約・引用しやすい構造化テキストに仕上げてください。（マークダウンのアスタリスク「*」や「-」は崩れやすいため使用禁止です）
       （箇条書き例：
         ・〇〇：具体的かつ客観的な強みや内容を1文で。
         ・〇〇：具体的かつ客観的な強みや内容を1文で。
         ・〇〇：具体的かつ客観的な強みや内容を1文で。）

    7. アクション喚起（CTA）の自然な配置（後半）:
       文章の最後（箇条書きの後）の締めくくりのアクション喚起（CTA）として、必ず次の指定テキストを【一言一句違わずに固定の1文】としてそのまま出力してください。
       ・日本語で執筆する場合：「『詳細』ボタン、またはプロフィールのウェブサイトリンクからお気軽にお問い合わせください。」
       ・英語で執筆する場合：「Please feel free to contact us via the 'Learn more' button or the website link in our profile.」
       ・韓国語で執筆する場合：「'상세' 버튼 또는 프로필의 웹사이트 링크를 통해 편하게 문의해 주세요.」
       ・その他の言語で執筆する場合：上記メッセージを該当言語に自然かつ正確に翻訳した固定の1文を出力してください。
       （※この指定テキスト以外の独自の行動喚起や売り込みの文章、連絡先などを追加することは【絶対に】禁止します）

    8. 段落分けと空行の徹底（スマートフォン可読性の最適化）:
       文章全体が視覚的に詰まって見苦しくなるのを防ぐため、一つの段落は必ず「1文〜最大2文程度（50文字〜100文字程度）」とし、各段落の間には【必ず空行を1行】挟んでください。中盤の説明文、後半のまとめ、最後のアクション喚起（CTA）の各箇所においても、文章が2文以上続く場合は積極的に改行・空行を挟んで複数の短い段落に分割してください。スマートフォン画面でのスクロール時の読みやすさを極限まで高めてください。

    9. 文字数および言語制限:
       全体の本文は【日本語・韓国語等の場合は500文字程度、英語等のアルファベット言語の場合は100〜150単語程度】に収め、一般客が読んで親しみやすく自然な文章（上記【言語決定の最重要ルール】で決定した指定言語）で仕上げてください。

    10. 署名・連絡先・記号マークダウンの排除:
        本文の中には、ホームページURL、電話番号、アクションボタンの文言（「詳細はこちら」「今すぐ予約」など）、住所、店舗名のフッター署名、および絵文字やマークダウン記号（**、#、*など）は【絶対に】含めないでください。純粋な文章テキストと「・」マーク、改行のみで出力してください。

    返される内容は自動作成した完成本文のみとし、説明、挨拶、マークダウン装飾（\`\`\`など）は一切含めないでください。`;
  };

  const buildMedicalPrompt = (feedbackAdvice: string = '') => {
    const selectedTheme = medicalThemes[dayIndex % medicalThemes.length];
    return `
    # GBP最新情報投稿｜YMYL対応マスタープロンプト Ver1.0

    あなたは店舗「${shop.name}」のオーナー代理として、Googleマップ（MEO）および生成AI検索（AIO/LLMO）向けに最適化された、日替わりの店舗投稿テキスト（おしらせ／最新情報）を自動作成してください。

    対象は接骨院・整骨院・クリニック・医院・調剤薬局・薬局などの医療・健康関連事業者です。
    検索ユーザーの悩み・疑問・検索意図に対応しながら、店舗名・地域名・診療内容・施術内容・提供サービスを明確に伝えてください。
    ただし、MEOやAI検索への最適化を目的として、医学的に不正確な情報、誇大広告、根拠のない効果表現、存在しないサービスを作成してはいけません。
    医療・健康分野では、情報の正確性、利用者の安全性、一次情報の信頼性、法令・広告ガイドラインへの適合を最優先としてください。

    ${feedbackAdvice ? `\n【前回の審査指摘事項（厳守）】\n${feedbackAdvice}\n上記の指摘事項を必ず修正し、ガイドラインを厳格に遵守して再作成してください。\n` : ''}

    ## 【今回の投稿テーマ・検索意図】
    - テーマ名: ${selectedTheme.name}
    - 執筆のフォーカス: ${selectedTheme.focus}
    必ず今回のテーマの検索文脈・意図に合致する内容で執筆してください。ただし、テーマに含まれる症状名・疾患名・治療名・施術名などは、店舗の実際の対応範囲と照合し、適切な場合に限り使用してください。医学的な断定や未確認のサービス内容を追加してはいけません。

    ## 【店舗基本情報】
    - 店舗名: ${shop.name}
    - 所在地住所情報（固定フッターより抜粋）: ${fixedFooter || '未設定'}
    - ターゲット層へのアピール・トーンマナー: ${customPrompt || '親しみやすく誠実なトーン。'}
    - 本日の下書きの公開予定日: ${targetDateJp}
    - 公開予定曜日: 【${targetWeekday}】
    - 投稿スロット番号: Day ${dayIndex} (${isTodayPublished ? (dayIndex === 0 ? '明日投稿分' : dayIndex === 1 ? '明後日投稿分' : '明々後日投稿分') : (dayIndex === 0 ? '本日投稿分' : dayIndex === 1 ? '明日投稿分' : '明後日投稿分')})

    ## 【言語決定の最重要ルール（最優先・絶対厳守）】
    「ターゲット層へのアピール・トーンマナー」に記載されている曜日別・日毎の言語指定（日本語、英語、韓国語、中国語など）がある場合は、必ず上記の【公開予定曜日】（${targetWeekday}）に厳密に従い、該当する曜日に指定された言語で本文全体・箇条書き・CTA・キーワードのすべてを執筆してください。指定された言語以外の言語で出力することは絶対に禁止します。
    ※特に言語の指定がない場合は、自然な日本語で執筆してください。

    ## 【YMYL共通の最優先ルール（文章構成や文字数よりも優先します）】
    ### 1. 医療・健康情報の正確性
    - 症状名と疾患名を混同しない。
    - 症状だけから病名や原因を断定しない。
    - 治療や施術による改善・治癒を保証しない。
    - 効果には個人差があることを前提とし、根拠のない効果表現を使用しない。
    - 医学的根拠のない予防効果や治療効果を創作しない。未確認の医学情報を断定的に説明しない。
    - 必要な場合は、適切な医療機関への相談や受診の重要性を簡潔に伝える。

    ### 2. 医療広告・関連法令への配慮（禁止表現）
    対象業種に応じて、医療法に基づく医療広告規制、柔道整復師法などの関係法令、医薬品医療機器等法（薬機法）、関連する広告ガイドラインおよびGoogleビジネスプロフィールのポリシーを考慮してください。
    以下の表現を絶対に禁止します：
    - 絶対に治る
    - 必ず改善する
    - 完全に治す
    - 副作用がない
    - 100％安全
    - 地域No.1、最高、唯一など、根拠や広告上の適法性を確認できない優良性表現
    - 他院・他店より優れていると断定する比較表現
    - 患者・利用者の体験談を創作する表現
    - 不安や恐怖を過度にあおる表現
    - 確認できない症例数、改善率、実績、資格、設備の表現

    ### 3. 一次情報の厳守
    次の情報は、店舗から提供されている場合、または信頼できる店舗情報として確認できる場合のみ使用してください。
    - 医師・薬剤師・柔道整復師などの資格、経歴
    - 診療科目、施術内容、薬局サービス
    - 専門的な取り組みや対応方針
    - 検査、設備、機器
    - 料金、保険適用条件
    - 受付時間、予約方法、訪問対応
    - 実績、数値、患者数
    - 他の医療機関との連携体制
    提供されていない一次情報、患者の声、診療実績、専門家の見解を創作してはいけません。

    ### 4. 検索キーワードの安全性判定
    メインキーワードとサブキーワードは、本文を生成する前に内部で確認してください。次の条件を満たすキーワードを優先して使用します：
    - 今回のテーマと検索意図に関連する。
    - 店舗の実際の対応内容と一致する。
    - 医学的に不正確な意味を持たない。
    - 広告規制上、不適切な効果保証や優良性表現にならない。
    - 読者に誤解を与えない自然な日本語（または指定された言語）として使用できる。
    不適切なキーワードは、必要に応じて正確な表現に置き換えるか、省略してください。

    ### 5. 読者の不安への対応
    検索ユーザーの悩みや不安に寄り添いながら、落ち着いた説明を行ってください。過度な不安をあおって来院や購入を促してはいけません。読者がサービス内容を理解し、相談・受診・利用の必要性を適切に判断できる文章を目指してください。

    ## 【業種別YMYLルール】
    店舗の名称、テーマ、提供情報から業種を判断し、該当するルールを適用してください：
    - A. 接骨院・整骨院: 柔道整復師の業務範囲を超える医療行為を行っているように表現しない。医師による診断・治療と柔道整復師による施術を混同しない。骨折・脱臼・捻挫・打撲・挫傷などは実際の対応内容や適切な条件を確認して記述する。慢性的な肩こり・腰痛などを当然に保険適用される症状として説明しない。骨盤矯正や姿勢改善などについて医学的に確認できない効果を断定しない。
    - B. クリニック・医院: 実際に標榜・提供している診療科目や診療内容のみ記述する。特定の症状から病名を確定させない。治療効果や検査結果を保証しない。医師の専門医資格や実績を推測しない。自由診療について効果・費用・リスク・副作用などの必要な広告情報を欠いた誘引的表現を作成しない。
    - C. 調剤薬局・薬局: 実際に提供している処方箋受付、服薬相談、在宅対応などのサービスのみ記述する。薬剤師による服薬支援と医師による診断・処方を混同しない。医薬品の効能・効果を承認された範囲を超えて説明しない。医薬品の安全性や副作用の不存在を保証しない。個人の判断による処方薬の中止、増減、変更を勧めない。

    ## 【作成の絶対ルール】
    1. 結論ファースト（PREP法）の徹底:
       文章の冒頭（最初の一文、30〜50文字程度）で、時候の挨拶などを省き、今回のテーマに対する結論を明確にしてください。原則として「主要キーワード／テーマ＋店舗名＋エリア名＋主要サービス」を自然な一文にまとめてください。ただし症状の改善、治療効果、予防効果などを断定する結論にはしないでください。最初の一文の直後には必ず空行を1行挟んでください。
    2. 主語・エリア・サービス名の明確化（5W1Hの網羅）:
       主語は必ず「${shop.name}」とし、エリア名は所在地住所情報（固定フッター）からのみ抽出し、住所情報がない場合は架空の地域名を創作せず汎用表現にしてください。
    3. メインキーワードの含有:
       指定メインキーワード [ ${mainKeywords.join(', ')} ] を自然な文脈に沿って含めてください（医学的不正確・誇大になる場合は安全な表現に調整。他言語指定の場合は正しく翻訳して含めてください）。
    4. 本日の日替わりサブキーワード:
       本日のサブキーワード [ ${selectedSubKeywords.join(', ')} ] を自然に盛り込んでください。
    5. 曖昧な表現の排除と一次情報・数値の提示:
       抽象的な形容詞や根拠のないアピールを避け、店舗が実際に提供している客観的・専門的な事実を具体的に記述してください。
    6. 特徴・こだわりの箇条書き構造化（中盤）:
       文章の中盤部分で、今回のテーマに関連する店舗の特徴・対応内容・サービス情報を、原則として3つの箇条書き（「・」マーク）で簡潔に整理してください。直前には説明・移行文を設け、その直後に空行を1行挟んでください。
    7. アクション喚起（CTA）の固定配置（後半）:
       文章の最後（箇条書きの後）の締めくくりのCTAとして、必ず次の指定テキストを一言一句変更せず、固定の1文として出力してください：
       ・日本語で執筆する場合：「『詳細』ボタン、またはプロフィールのウェブサイトリンクからお気軽にお問い合わせください。」
       ・英語で執筆する場合：「Please feel free to contact us via the 'Learn more' button or the website link in our profile.」
       ・韓国語で執筆する場合：「'상세' 버튼 또는 프로필의 웹사이트 링크를 통해 편하게 문의해 주세요.」
       ・その他の言語で執筆する場合：上記メッセージを該当言語に自然かつ正確に翻訳した固定の1文を出力してください。
    8. 段落分けと空行の徹底:
       一つの段落は1文〜最大2文程度（50〜100文字程度）を目安とし、各段落の間には必ず空行を1行挟んでください。
    9. 文字数および言語制限:
       全体の本文は日本語・韓国語等の場合は500文字程度（改行を除く）、英語等のアルファベット言語の場合は100〜150単語程度に収め、上記【言語決定の最重要ルール】で決定した指定言語で仕上げてください。
    10. 署名・連絡先・記号マークダウンの排除:
        本文中にURL、電話番号、住所、店舗名のフッター署名、絵文字、マークダウン記号は含めず、純粋な文章テキストと「・」マーク、改行のみで出力してください。

    返される内容は自動作成した完成本文のみとし、説明、挨拶、マークダウン装飾は一切含めないでください。`;
  };

  // Execution with Medical Fact-Check Loop or Standard Generation
  if (isMedicalShop) {
    console.log(`🩺 [医療モード起動] 店舗「${shop.name}」: 医療専用プロンプト (Gemini) & ファクトチェック審査 (Claude) を開始します...`);
    let finalMedicalText = '';
    let factCheckPassed = false;
    let feedback = '';

    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`📡 [医療プロンプト生成 試行 ${attempt}/2] 店舗「${shop.name}」`);
      const medicalPrompt = buildMedicalPrompt(feedback);
      const candidateText = await generateTextFromGemini(genAI, medicalPrompt);

      console.log(`🔍 [Claude 医療ファクトチェック審査 試行 ${attempt}/2 実行中...]`);
      const checkResult = await factCheckMedicalPost(candidateText, shop.name);

      if (checkResult.passed) {
        console.log(`✅ [医療ファクトチェック合格 (試行 ${attempt}/2)]: ${checkResult.reason || '適合'}`);
        finalMedicalText = candidateText;
        factCheckPassed = true;
        break;
      } else {
        console.warn(`⚠️ [医療ファクトチェックNG (試行 ${attempt}/2)]: ${checkResult.reason} - 指摘: ${checkResult.issues.join(' / ')}`);
        feedback = `【前回の審査で以下のNG指摘がありました。必ず修正しガイドラインを厳格に遵守してください】: ${checkResult.issues.join('、')}${checkResult.correctionAdvice ? ` (改善指示: ${checkResult.correctionAdvice})` : ''}`;
      }
    }

    if (factCheckPassed && finalMedicalText) {
      return {
        text: finalMedicalText,
        subKeywords: selectedSubKeywords,
        imageFileId,
        promptType: 'MEDICAL',
      };
    }

    console.warn(`🔄 [通常プロンプト自動フォールバック (試行 3/3)] 店舗「${shop.name}」: 医療ファクトチェックが2回連続NGとなったため、通常プロンプトにて安全に生成します。`);
  }

  // Standard generation
  const standardPrompt = buildStandardPrompt();
  const standardText = await generateTextFromGemini(genAI, standardPrompt);

  return {
    text: standardText,
    subKeywords: selectedSubKeywords,
    imageFileId,
    promptType: 'STANDARD',
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

    // Fetch Drive files with subfolders for intelligent keyword-folder matching
    let driveFilesList: DriveFileItem[] = [];
    const auth = getGoogleAuthClient();
    if (auth && shop.google_drive_folder_id) {
      driveFilesList = await fetchDriveFilesWithSubfolders(auth, shop.google_drive_folder_id);
    }

    const isTodayPublished = draftPostsArr.some((d: any) => d.dayIndex === -1);

    if (all) {
      // Regenerate all 3 days
      const day0 = await generateSingleDraft(shop, 0, driveFilesList, false, isTodayPublished);
      const day1 = await generateSingleDraft(shop, 1, driveFilesList, false, isTodayPublished);
      const day2 = await generateSingleDraft(shop, 2, driveFilesList, false, isTodayPublished);

      const nextDrafts = [
        { dayIndex: 0, title: isTodayPublished ? '明日投稿予定の下書き (Day 0)' : '今日投稿予定の下書き (Day 0)', text: day0.text, subKeywords: day0.subKeywords, imageFileId: day0.imageFileId || null, promptType: day0.promptType },
        { dayIndex: 1, title: isTodayPublished ? '明後日投稿予定の下書き (Day 1)' : '明日投稿予定の下書き (Day 1)', text: day1.text, subKeywords: day1.subKeywords, imageFileId: day1.imageFileId || null, promptType: day1.promptType },
        { dayIndex: 2, title: isTodayPublished ? '明々後日投稿予定の下書き (Day 2)' : '明後日投稿予定の下書き (Day 2)', text: day2.text, subKeywords: day2.subKeywords, imageFileId: day2.imageFileId || null, promptType: day2.promptType },
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
      const regenerated = await generateSingleDraft(shop, targetIndex, driveFilesList, false, isTodayPublished);

      const defaultTitles = isTodayPublished ? [
        '明日投稿予定の下書き (Day 0)',
        '明後日投稿予定の下書き (Day 1)',
        '明々後日投稿予定の下書き (Day 2)'
      ] : [
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
        promptType: regenerated.promptType,
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
    // 🛡️ Content Validation Safeguard: Prevent error notices or pending placeholders from ever being published to Google Maps
    const isPendingOrInvalid =
      publishedPost.text.includes('【下書き生成保留中】') ||
      publishedPost.text.includes('AI APIクレジット') ||
      publishedPost.text.includes('自動生成を保留') ||
      publishedPost.text.includes('【AI生成保留中】') ||
      publishedPost.text.trim().length < 30;

    if (isPendingOrInvalid) {
      console.warn(`⚠️ [GBP安全遮断] 店舗「${shop.name}」: 本日の下書きはAI生成保留中のため、Googleマップへの一般公開を安全にスキップしました。`);
    } else {
      console.log(`📡 Attempting real GBP post creation for location: ${resolvedPath}`);
      const oauth2Client = new google.auth.OAuth2(clientID, clientSecret, 'http://localhost');
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        
        // Determine if there is an image to attach
        let mediaPayload = undefined;
        if (publishedPost.imageFileId) {
          const apiBaseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_API_BASE_URL || (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : 'http://localhost:3000');
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
        if (shop.keywords && shop.keywords.gbp_action_url && shop.keywords.gbp_action_url.trim()) {
          const actionUrl = shop.keywords.gbp_action_url.trim();
          const isGoogleMapsUrl = 
            actionUrl.includes('maps.app.goo.gl') ||
            actionUrl.includes('goo.gl/maps') ||
            actionUrl.includes('maps.google.') ||
            actionUrl.includes('google.com/maps') ||
            actionUrl.includes('google.co.jp/maps') ||
            actionUrl.includes('share.google') ||
            actionUrl.includes('posts.gle');

          if (isGoogleMapsUrl) {
            console.warn(`⚠️ [GBP規約ガード] 店舗「${shop.name}」: Googleマップ自身のURLが詳細ボタンに設定されていたため、循環リンク違反・スパム判定を防ぐためボタン付与を安全にスキップしました。`);
          } else if (actionUrl.startsWith('http://') || actionUrl.startsWith('https://')) {
            console.log(`🔗 Attaching Call-to-Action button to GBP post: ${actionUrl}`);
            callToActionPayload = {
              actionType: 'LEARN_MORE',
              url: actionUrl
            };
          }
        }

        const postTimeHour = (shop.keywords as any)?.post_time_hour ?? 9;
        const now = new Date();
        const jstHourStr = new Intl.DateTimeFormat('ja-JP', {
          timeZone: 'Asia/Tokyo',
          hour: '2-digit',
          hour12: false
        }).format(now);
        const currentHour = parseInt(jstHourStr || '0', 10);
        const isDelayedCycle = currentHour > postTimeHour;

        let gbpSuccess = false;
        let lastGbpError: any = null;

        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            console.log(`📡 [GBP投稿 試行 ${attempt}/2] Location: ${resolvedPath} (画像添付: ${mediaPayload ? 'あり' : 'なし'})`);
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
            gbpSuccess = true;
            console.log('✅ Successfully published real post to Google Business Profile!');
            break;
          } catch (gbpError: any) {
            lastGbpError = gbpError;
            console.error(`⚠️ [GBP投稿 試行 ${attempt}/2 失敗]:`, gbpError.message || gbpError);
            if (attempt < 2) {
              await new Promise(r => setTimeout(r, 2000));
            }
          }
        }

        // 🛡️ 1時間経過(遅延)時の画像エラー自動フォールバック:
        // 設定時刻から1時間以上経過(例: 13:00以降)しても画像がGoogle側でエラー拒否される場合、テキストのみに切り替えて確実に公開
        if (!gbpSuccess && mediaPayload && isDelayedCycle) {
          console.warn(`🛡️ [GBPテキストフォールバック起動] 設定時刻(${postTimeHour}:00)から1時間以上経過(現在: ${currentHour}:00 JST)し、画像送信がGoogle側で拒否されたため、テキストのみでの投稿に切り替えて再試行します...`);
          try {
            const fallbackRes = await oauth2Client.request({
              url: `https://mybusiness.googleapis.com/v4/${resolvedPath}/localPosts`,
              method: 'POST',
              data: {
                languageCode: 'ja-JP',
                summary: gbpPostText,
                topicType: 'STANDARD',
                ...(callToActionPayload ? { callToAction: callToActionPayload } : {})
              }
            });
            gbpPublished = true;
            gbpResponse = fallbackRes.data;
            gbpSuccess = true;
            console.log('✅ [テキストフォールバック成功] 画像を切り離したテキストのみの投稿がGoogleマップへ正常に公開されました！');
          } catch (fallbackErr: any) {
            lastGbpError = fallbackErr;
            console.error('❌ [テキストフォールバックも失敗]:', fallbackErr.message || fallbackErr);
          }
        }

        if (!gbpSuccess) {
          const isDemoStore = shop.name.includes('Avenir') || shop.name.includes('デモ') || (shop.google_location_id && shop.google_location_id.includes('demo'));
          if (isDemoStore && (lastGbpError?.message?.includes('Requested entity was not found') || lastGbpError?.status === 404)) {
            console.warn(`ℹ️ [デモ店舗判定] デモ用店舗のため、GBP実送信エラーを無視してシミュレーション投稿を継続します。`);
          } else {
            throw new Error(`Googleマップ(GBP)への投稿に失敗しました: ${lastGbpError?.message || lastGbpError}`);
          }
        }
    }
  }

  // Fetch Drive files with subfolders for intelligent keyword-folder matching
  let driveFilesList: DriveFileItem[] = [];
  const auth = getGoogleAuthClient();
  if (auth && shop.google_drive_folder_id) {
    driveFilesList = await fetchDriveFilesWithSubfolders(auth, shop.google_drive_folder_id);
  }

  // 2. Perform the roll-over (Slide)
  // Keep the published draft as dayIndex: -1 (本日投稿済み)
  const nextDayMinus1 = {
    dayIndex: -1,
    title: '本日投稿済みの下書き',
    text: publishedPost.text,
    subKeywords: publishedPost.subKeywords,
    imageFileId: publishedPost.imageFileId || null,
    promptType: publishedPost.promptType || 'STANDARD',
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
    promptType: draft1.promptType || 'STANDARD',
  };

  const nextDay1 = {
    dayIndex: 1,
    title: '明後日投稿予定の下書き (Day 1)',
    text: draft2.text,
    subKeywords: draft2.subKeywords,
    imageFileId: draft2.imageFileId || null,
    promptType: draft2.promptType || 'STANDARD',
  };

  // Check if we are in alternating mode (1 to 9 images) to alternate Day 2 image assignment based on Day 1 (draft2) status
  const imageCount = driveFilesList.length;
  const isAlternating = imageCount >= 1 && imageCount < 10;
  const forceTextOnlyForDay2 = isAlternating ? !!draft2.imageFileId : false;

  // 3. Generate a brand new Day 2 draft using Gemini AI with robust fail-safe error boundary!
  let nextDay2;
  try {
    const newDay2Raw = await generateSingleDraft(shop, 2, driveFilesList, forceTextOnlyForDay2, true);
    nextDay2 = {
      dayIndex: 2,
      title: '明々後日投稿予定の下書き (Day 2)',
      text: newDay2Raw.text,
      subKeywords: newDay2Raw.subKeywords,
      imageFileId: newDay2Raw.imageFileId || null,
      promptType: newDay2Raw.promptType || 'STANDARD',
    };
  } catch (aiErr: any) {
    console.error(`⚠️ [AI下書き生成エラー] 店舗「${shop.name}」のDay 2下書き自動生成に失敗しました（スライド処理は安全に継続します）:`, aiErr.message || aiErr);
    let fallbackSubs: string[] = [];
    try {
      if (shop.keywords?.sub_keywords) {
        fallbackSubs = JSON.parse(shop.keywords.sub_keywords).slice(0, 2);
      }
    } catch (e) {}

    nextDay2 = {
      dayIndex: 2,
      title: '明々後日投稿予定の下書き (Day 2 - AI生成保留中)',
      text: '【下書き生成保留中】Google AI APIのクレジット残高不足、または通信タイムアウトにより自動生成を保留しました。APIクレジット確認後、ダッシュボードの「下書きを再生成」ボタンから再作成してください。',
      subKeywords: fallbackSubs,
      imageFileId: null,
    };
  }

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

        // 🛡️ User Soft Delete Protection: If the review exists and was marked as is_hidden by the user on the dashboard, do NOT resurrect it!
        if (existing && existing.is_hidden) {
          continue;
        }

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

// In-memory set to prevent double posting in the same hour & Mutex Lock to prevent overlapping runs
let isSchedulerRunning = false;
const alreadyPostedToday = new Set<string>();

// ==============================================================================
// ⏱️ Background Automated Scheduler (Hourly execution check & auto-retry)
// ==============================================================================
async function runBackgroundScheduler() {
  if (isSchedulerRunning) {
    console.log('🔒 [排他制御ガード] 現在すでに自動巡回バッチが実行中です。二重投稿・並行実行を防ぐため今回のリクエストを安全にスキップしました。');
    return;
  }
  isSchedulerRunning = true;

  try {
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

    console.log(`\n⏰ [${todayStr} ${hour}:00 JST] 365MEO バックグラウンド自動巡回サイクルを開始します...`);

    const clientID = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    const googleAuthAvailable = !!(clientID && clientSecret && refreshToken);

    const shops = await prisma.shop.findMany({
      include: { keywords: true, templates: true },
    });

    console.log(`🔎 登録店舗数: ${shops.length}件 を確認`);

    // Clear alreadyPostedToday memory cache at midnight JST
    if (currentHour === 0) {
      alreadyPostedToday.clear();
      console.log('🧹 [日付変更検知] 深夜0時(JST)を迎えたため、当日の投稿済みメモリキャッシュをクリアしました。');
    }

    for (const shop of shops) {
      if (!shop.keywords) {
        console.log(`✨ 店舗「${shop.name}」: 初期キーワード設定を自動生成します...`);
        shop.keywords = await initializeShopKeywords(shop);
      }

      // 1. Check for Daily Automated Posting
      if (shop.post_active && shop.keywords) {
        const postTimeHour = (shop.keywords as any)?.post_time_hour ?? 9; // Default is 9 (9:00 AM)

        let isAlreadyPostedTodayInDb = false;
        if (shop.keywords.draft_posts) {
          try {
            const drafts = JSON.parse(shop.keywords.draft_posts);
            const postedItem = drafts.find((d: any) => d.dayIndex === -1);
            if (postedItem && postedItem.publishedAt) {
              const pubDateJst = jstFormatter.formatToParts(new Date(postedItem.publishedAt));
              const pYear = pubDateJst.find(p => p.type === 'year')?.value;
              const pMonth = pubDateJst.find(p => p.type === 'month')?.value;
              const pDay = pubDateJst.find(p => p.type === 'day')?.value;
              const pubDateStr = `${pYear}-${pMonth}-${pDay}`;
              if (pubDateStr === todayStr) {
                isAlreadyPostedTodayInDb = true;
              }
            }
          } catch (e) {}
        }

        const memoryKey = `${shop.id}_${todayStr}`;

        if (currentHour >= postTimeHour) {
          if (isAlreadyPostedTodayInDb || alreadyPostedToday.has(memoryKey)) {
            console.log(`✓ 店舗「${shop.name}」: 本日分（${todayStr}）は既に投稿完了済みです。`);
            alreadyPostedToday.add(memoryKey);
          } else {
            console.log(`🚀 [自動投稿実行] 店舗「${shop.name}」: 設定時刻 ${postTimeHour}:00 (現在: ${currentHour}:00 JST) ➔ 投稿処理を開始します...`);
            // 🛡️ Pre-lock memory key immediately before async communication begins!
            alreadyPostedToday.add(memoryKey);
            try {
              await executeDailyPostRollover(shop.id);
              console.log(`✅ [自動投稿成功] 店舗「${shop.name}」の投稿＆下書きスライドが完了しました！`);
            } catch (postErr: any) {
              console.error(`❌ [自動投稿失敗] 店舗「${shop.name}」の投稿処理でエラーが発生しました（次回のCronで自動再試行します）:`, postErr.message || postErr);
              // Unlock only if rollover completely failed so future retry can happen
              alreadyPostedToday.delete(memoryKey);
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
                is_hidden: false,
                reply_text: { not: null },
                create_time: { lte: oneHourAgo }
              }
            });

            if (pendingAutoReviews.length > 0) {
              console.log(`🤖 [自動返信スケジューラー] 店舗: 「${shop.name}」に対して 1時間経過した全自動返信対象の口コミが ${pendingAutoReviews.length}件 検出されました。自動送信を開始します。`);

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
  } finally {
    isSchedulerRunning = false;
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
  console.log(`🚀 MEO SEIHA - Express API Server running on: http://localhost:${port}`);
  console.log(`📅 Started on: ${new Date().toLocaleString()}`);
  console.log(`================================================================================\n`);

  // Ensure is_medical column exists in database
  prisma.$executeRawUnsafe('ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "is_medical" BOOLEAN DEFAULT false;')
    .then(() => console.log('✅ Verified Shop.is_medical column in database.'))
    .catch((e) => console.warn('⚠️ Could not auto-add is_medical column:', e.message || e));

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

  // Master Account (thanxcreate.gbp@gmail.com) Automatic Initialization / Sync
  setTimeout(async () => {
    try {
      console.log('👤 Checking Master Account (thanxcreate.gbp@gmail.com) initialization...');
      
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
      const password = process.env.MASTER_ADMIN_PASSWORD || 'password';

      const masterAccount = await prisma.shop.upsert({
        where: { email: 'thanxcreate.gbp@gmail.com' },
        update: {
          password: password,
          role: 'ADMIN',
          post_active: false,
          google_drive_folder_id: '1AIgemm9-fvP-eLwP7p2p8Plja1mbOJtX',
          google_location_id: 'locations/7613471938029191960',
        },
        create: {
          name: 'MEO SEIHA運営本部',
          email: 'thanxcreate.gbp@gmail.com',
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
