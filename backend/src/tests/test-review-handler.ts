import { ReviewHandlerService, ReviewEvent } from '../services/review-handler';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env
dotenv.config({ path: path.join(__dirname, '../../.env') });

async function main() {
  const handler = new ReviewHandlerService();
  const storeName = '炭火焼肉 ジラーチ 名古屋駅前店';

  console.log('================================================================================');
  console.log('🧪 MEO SEIHA - 口コミ仕分け＆お詫びAI生成＆LINE通知シミュレーション');
  console.log('================================================================================\n');

  // 🧪 テスト1: 星5（高評価）のシミュレート
  console.log('🔥 --- 【テスト1】星5高評価口コミの受信自動判定 ---');
  const review5: ReviewEvent = {
    reviewId: 'rev-001',
    reviewerName: '田中 太郎',
    starRating: 5,
    comment: 'お肉がとても柔らかくて美味しかったです！個室の雰囲気も最高で、接客も非常に丁寧で大満足でした。必ずまた来ます！',
    createTime: new Date().toISOString()
  };

  try {
    const result5 = await handler.handleNewReview(review5, storeName);
    console.log('\n✅ [テスト1結果] 正常処理終了:');
    console.log(`  - 自動返信実行: ${result5.isAutoReplied ? '実行済 (YES)' : '保留 (NO)'}`);
    console.log(`  - 返信本文: "${result5.replyText}"`);
  } catch (error) {
    console.error('❌ テスト1でエラーが発生しました:', error);
  }

  console.log('\n--------------------------------------------------------------------------------\n');

  // 🧪 テスト2: 星1（低評価・不満爆発）のシミュレート
  console.log('🔥 --- 【テスト2】星1低評価口コミ受信 ➔ AI謝罪生成 ＆ LINEアラート配信 ---');
  const review1: ReviewEvent = {
    reviewId: 'rev-002',
    reviewerName: '鈴木 一郎',
    starRating: 1,
    comment: '週末に予約して伺いましたが、席に案内されるまで20分も待たされました。さらに最初にお願いしたビールが全然来ず、スタッフに指摘してもまともな謝罪もありませんでした。非常に不快な食事になりました。二度と行きません。',
    createTime: new Date().toISOString()
  };

  try {
    const result1 = await handler.handleNewReview(review1, storeName);
    console.log('\n✅ [テスト2結果] 正常処理終了:');
    console.log(`  - 自動返信実行: ${result1.isAutoReplied ? '実行済 (YES)' : '保留（AIお詫び文下書き作成 & アラート送信済）'}`);
    console.log(`  - AI作成の謝罪文下書き:`);
    console.log(`--------------------------------------------------------------------------------`);
    console.log(result1.replyText);
    console.log(`--------------------------------------------------------------------------------`);
  } catch (error) {
    console.error('❌ テスト2でエラーが発生しました:', error);
  }
}

main();
