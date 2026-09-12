import { ReviewHandlerService, ReviewEvent } from '../services/review-handler';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as readline from 'readline';

// Load .env
dotenv.config({ path: path.join(__dirname, '../../.env') });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const handler = new ReviewHandlerService();
const storeName = '合同会社THANX CREATE'; // 安全ホワイトリストに指定されている許可店舗

const mockReviews: { [key: string]: ReviewEvent } = {
  '1': {
    reviewId: 'demo-star-5',
    reviewerName: '田中 太郎',
    starRating: 5,
    comment: '今回初めて伺いました！お料理のクオリティが本当に高くて驚きました。お店の雰囲気もおしゃれで、スタッフの笑顔が素敵でした。絶対にまたリピートします！',
    createTime: new Date().toISOString()
  },
  '2': {
    reviewId: 'demo-star-4',
    reviewerName: '佐藤 花子',
    starRating: 4,
    comment: 'お料理はどれも美味しく、盛り付けも綺麗で楽しめました。少し混み合っていたのか、注文してから届くまで少し時間がかかりましたが、接客が良かったので満足です。',
    createTime: new Date().toISOString()
  },
  '3': {
    reviewId: 'demo-star-3',
    reviewerName: '鈴木 次郎',
    starRating: 3,
    comment: '味は十分に美味しくお腹いっぱいになりました。ただ、週末だったからか店内がかなり賑やかで、落ち着いて会話をするには少し不向きかなと感じました。普段使いには良いと思います。',
    createTime: new Date().toISOString()
  },
  '4': {
    reviewId: 'demo-star-2',
    reviewerName: '渡辺 恵子',
    starRating: 2,
    comment: '味は良かったのですが、お会計の時にスタッフの愛想がかなり悪く、最後の最後にとても残念な気持ちになりました。せっかくお店の雰囲気が良いのにもったいないと思います。改善してほしいです。',
    createTime: new Date().toISOString()
  },
  '5': {
    reviewId: 'demo-star-1',
    reviewerName: '怒り男 (クレーマー役)',
    starRating: 1,
    comment: '週末に事前に予約して楽しみに伺いましたが、お席に案内されるまで25分も放置されました。そのうえ、最初にお願いしたビールが20分以上待っても来ず、スタッフに催促しても謝罪の一言もありませんでした。二度と行きません。最低です。',
    createTime: new Date().toISOString()
  }
};

function printMenu() {
  console.log('\n================================================================================');
  console.log('🤖 MEO SEIHA - 自主テスト用・口コミ自動判定＆LINE実機連動シミュレーター');
  console.log('================================================================================');
  console.log('1. 【星5】田中様の高評価（絶賛コメント） ➔ 即時自動返信（AIコスト0円）');
  console.log('2. 【星4】佐藤様の中高評価（普通に良い） ➔ 即時自動返信（AIコスト0円）');
  console.log('3. 【星3】鈴木様の普通評価（一長一短あり） ➔ 即時自動返信（AIコスト0円・検証用！）');
  console.log('4. 【星2】渡辺様の低評価（接客態度不満） ➔ Gemini謝罪作成 ＆ スマホLINEプッシュ！');
  console.log('5. 【星1】怒り男様の最低評価（予約放置）  ➔ Gemini謝罪作成 ＆ スマホLINEプッシュ！');
  console.log('6. ✍️ 自分で自由に入力する（名前、星数、口コミ文を自分で打ち込んでテスト）');
  console.log('0. シミュレーターを終了する');
  console.log('================================================================================\n');
}

function selectStorePrompt(callback: (customPrompt?: string, selectedStoreName?: string) => void) {
  console.log('\n🏬 【検証用】どの店舗設定（カスタムプロンプト）でテストしますか？');
  console.log('1. 【標準店舗】合同会社THANX CREATE (店舗個別指示なし - 通常の謝罪)');
  console.log('2. 【美容院設定】Avenir Hair (上品・美髪ケア・個室空間のこだわりプロンプト)');
  console.log('3. 【ラーメン設定】頑固一徹ラーメン (元気・職人魂・こだわり濃厚スープのプロンプト)');
  rl.question('👉 選択してください (1-3): ', (ans) => {
    const choice = ans.trim();
    if (choice === '2') {
      const prompt = '美容院にふさわしい上品で落ち着いた言葉遣いで作成してください。お客様の髪の毛に触れるデリケートな施術を行う立場として、お客様のご不安や残念な気持ちに寄り添ってください。技術力と完全個室リラックス空間を誇るサロンとしての誠実さを持って、接客カウンセリング教育の徹底に努める姿勢をアピールしてください。';
      callback(prompt, 'Avenir Hair (美容院)');
    } else if (choice === '3') {
      const prompt = '元気で親しみやすく、かつ極めて誠意のある言葉遣いで作成してください。麺のコシ、スープの一滴にまで魂を込めるラーメン店として、味と接客サービスへの妥協なき職人魂を持ち、スープを一口飲んだ時の感動を再び提供できるよう厨房一同で早急に改善に努める熱い姿勢を伝えてください。';
      callback(prompt, '頑固一徹ラーメン (ラーメン店)');
    } else {
      callback(undefined, '合同会社THANX CREATE');
    }
  });
}

async function handleSelection(choice: string) {
  const cleanChoice = choice.trim();

  if (cleanChoice === '0') {
    console.log('👋 シミュレーターを終了します。テストお疲れ様でした！');
    rl.close();
    process.exit(0);
  }

  // 固定テンプレートデモの実行
  if (['1', '2', '3', '4', '5'].includes(cleanChoice)) {
    const review = mockReviews[cleanChoice];
    console.log(`\n⏳ テスト [選択: ${cleanChoice}] の処理を開始します...`);

    // 星1・2（低評価）の場合はプロンプトを選択できるようにする
    if (review.starRating <= 2) {
      selectStorePrompt(async (customPrompt, selectedName) => {
        const activeStoreName = selectedName || storeName;
        try {
          const result = await handler.handleNewReview(review, activeStoreName, customPrompt);
          console.log('\n================================================================================');
          console.log('🟢 判定結果:');
          console.log(`  - 自動返信の実行: ${result.isAutoReplied ? '実行済 (テンプレート即時送信)' : '保留（AIお詫び文作成 ➔ LINE通知完了）'}`);
          console.log(`  - 処理の詳細: ${result.reason}`);
          console.log('================================================================================');
        } catch (err: any) {
          console.error('❌ エラーが発生しました:', err.message || err);
        }
        askNext();
      });
      return;
    }

    // 星3〜5は即時に通常処理
    try {
      const result = await handler.handleNewReview(review, storeName);
      console.log('\n================================================================================');
      console.log('🟢 判定結果:');
      console.log(`  - 自動返信の実行: ${result.isAutoReplied ? '実行済 (テンプレート即時送信)' : '保留（AIお詫び文作成 ➔ LINE通知完了）'}`);
      console.log(`  - 処理の詳細: ${result.reason}`);
      console.log('================================================================================');
    } catch (err: any) {
      console.error('❌ エラーが発生しました:', err.message || err);
    }
    askNext();
    return;
  }

  // 自由入力モードの実行
  if (cleanChoice === '6') {
    console.log('\n✍️ 【オリジナル口コミ入力モード】');
    rl.question('👤 1. 投稿者の名前を入力してください：\n> ', (name) => {
      rl.question('⭐ 2. 星の数を入力してください (1〜5の数字)：\n> ', (stars) => {
        const rating = parseInt(stars.trim(), 10);
        if (isNaN(rating) || rating < 1 || rating > 5) {
          console.error('❌ エラー: 星数は 1 から 5 までの数字で入力してください。');
          askNext();
          return;
        }

        rl.question('💬 3. クチコミ本文を入力してください：\n> ', async (comment) => {
          const customReview: ReviewEvent = {
            reviewId: `custom-${Date.now()}`,
            reviewerName: name.trim() || '匿名ユーザー',
            starRating: rating as 1 | 2 | 3 | 4 | 5,
            comment: comment.trim(),
            createTime: new Date().toISOString()
          };

          // 星1・2（低評価）の場合はプロンプト選択
          if (rating <= 2) {
            selectStorePrompt(async (customPrompt, selectedName) => {
              const activeStoreName = selectedName || storeName;
              console.log(`\n⏳ 自由入力口コミの自動解析を開始します...`);
              try {
                const result = await handler.handleNewReview(customReview, activeStoreName, customPrompt);
                console.log('\n================================================================================');
                console.log('🟢 判定結果:');
                console.log(`  - 自動返信の実行: ${result.isAutoReplied ? '実行済 (テンプレート即時送信)' : '保留（AIお詫び文作成 ➔ LINE通知完了）'}`);
                console.log(`  - 処理の詳細: ${result.reason}`);
                console.log('================================================================================');
              } catch (err: any) {
                console.error('❌ エラーが発生しました:', err.message || err);
              }
              askNext();
            });
            return;
          }

          // 星3〜5は通常通り即時に自動返信
          console.log(`\n⏳ 自由入力口コミの自動解析を開始します...`);
          try {
            const result = await handler.handleNewReview(customReview, storeName);
            console.log('\n================================================================================');
            console.log('🟢 判定結果:');
            console.log(`  - 自動返信の実行: ${result.isAutoReplied ? '実行済 (テンプレート即時送信)' : '保留（AIお詫び文作成 ➔ LINE通知完了）'}`);
            console.log(`  - 処理の詳細: ${result.reason}`);
            console.log('================================================================================');
          } catch (err: any) {
            console.error('❌ エラーが発生しました:', err.message || err);
          }
          askNext();
        });
      });
    });
    return;
  }

  console.log('❌ エラー: 正しいメニュー番号（0〜6）を選択してください。');
  askNext();
}

function askNext() {
  console.log('\n--------------------------------------------------------------------------------');
  rl.question('続行するにはEnterキーを押してください... (メニューに戻ります)', () => {
    main();
  });
}

function main() {
  printMenu();
  rl.question('👉 メニュー番号を選択してください (0-6): ', (choice) => {
    handleSelection(choice);
  });
}

main();
