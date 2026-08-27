import express, { Request, Response } from 'express';
import { Client, middleware, WebhookEvent, MessageAPIResponseBase } from '@line/bot-sdk';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env
dotenv.config({ path: path.join(__dirname, '../../.env') });

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('❌ Error: LINE credentials are not defined in .env');
  process.exit(1);
}

const client = new Client({
  channelAccessToken: config.channelAccessToken,
  channelSecret: config.channelSecret,
});

const app = express();
const port = process.env.PORT || 3000;

// 1. Webhook Endpoint
app.post('/webhook', middleware({ channelSecret: config.channelSecret }), (req: Request, res: Response) => {
  const events: WebhookEvent[] = req.body.events;
  
  if (events.length === 0) {
    return res.status(200).send('OK');
  }

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const userId = event.source.userId;
      const text = event.message.text;
      
      console.log('\n==================================================');
      console.log('🎉 [LINE Webhook] Received message!');
      console.log(`👤 User ID: ${userId}`);
      console.log(`💬 Text: "${text}"`);
      console.log('==================================================\n');

      // Reply back to user
      client.replyMessage(event.replyToken, {
        type: 'text',
        text: `MEO SEIHAシステムがメッセージを受信しました！\nあなたのユーザーIDは以下です：\n${userId}`
      }).catch(err => {
        console.error('❌ Failed to send reply message:', err);
      });
    }
  }

  res.json({ status: 'success' });
});

// 2. Direct Push Test Route (for manual testing)
app.get('/test-push', async (req: Request, res: Response) => {
  const userId = process.env.LINE_USER_ID || (req.query.userId as string);
  
  if (!userId) {
    return res.status(400).send('❌ Error: LINE_USER_ID is not defined in .env or passed as query ?userId=xxx');
  }

  console.log(`✉️ Sending test push message to user: ${userId}...`);
  
  try {
    const result = await client.pushMessage(userId, {
      type: 'text',
      text: '🔔【MEO SEIHA 連携テスト】\nLINE Messaging API との接続疎通テストに成功しました！このチャネルから店舗オーナーへの緊急アラートが配信されます。'
    });
    
    console.log('🟢 Push message sent successfully!');
    res.json({ status: 'success', message: 'Push message sent!', result });
  } catch (error) {
    console.error('❌ Failed to send push message:', error);
    res.status(500).json({ error: 'Failed to send push message', details: error });
  }
});

// Start Express server
app.listen(port, () => {
  console.log(`📡 LINE Webhook/Test Server is running on http://localhost:${port}`);
  console.log(`👉 Webhook URL to register in LINE Console: [Your-Ngrok-URL]/webhook`);
  console.log(`👉 Test Push URL: http://localhost:${port}/test-push?userId=[Your-User-ID]\n`);
  
  // If LINE_USER_ID is already set, let's trigger a push test automatically on start
  const autoUserId = process.env.LINE_USER_ID;
  if (autoUserId) {
    console.log(`🚀 Found LINE_USER_ID in .env. Attempting automatic push test...`);
    client.pushMessage(autoUserId, {
      type: 'text',
      text: '🔔【MEO SEIHA 連携テスト】\nサーバー起動時の自動疎通テストに成功しました！'
    })
    .then(() => console.log('🟢 Automatic push test succeeded!'))
    .catch(err => console.error('❌ Automatic push test failed:', err));
  } else {
    console.log('ℹ️ Note: LINE_USER_ID is empty in .env. Automatic push test skipped.');
    console.log('You can trigger it using the test push URL or by setting the environment variable.');
  }
});
