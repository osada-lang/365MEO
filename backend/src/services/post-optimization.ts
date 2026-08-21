export type PostingMode = 'TEXT_ONLY' | 'ALTERNATING' | 'ALWAYS_IMAGE';

export interface PostingBehavior {
  mode: PostingMode;
  frequency: 'DAILY';
  hasImageToday: boolean;
  description: string;
}

export interface PostPayload {
  hasImage: boolean;
  selectedImage: string | null;
  textGenerationRequired: boolean;
  reason: string;
}

export class PostOptimizationService {
  /**
   * 1. Google Drive内のストック画像数から、投稿の「基本モード」を自動決定します。
   * 
   * @param imageCount Google Drive内のストック画像数
   * @param dayIndex 連続投稿日数（交互モードでの判定に使用。0始まり、1、2...）
   */
  public determinePostingBehavior(imageCount: number, dayIndex: number = 0): PostingBehavior {
    if (imageCount === 0) {
      return {
        mode: 'TEXT_ONLY',
        frequency: 'DAILY',
        hasImageToday: false,
        description: '【パターンA】画像ストック0枚: 「画像なし（テキストのみ）」で毎日連続投稿します。'
      };
    } else if (imageCount >= 1 && imageCount <= 9) {
      // 偶数日は画像あり、奇数日は画像なし（テキストのみ）
      const hasImageToday = dayIndex % 2 === 0;
      return {
        mode: 'ALTERNATING',
        frequency: 'DAILY',
        hasImageToday,
        description: `【パターンB】画像ストック${imageCount}枚（1〜9枚）: 「画像あり（ローテーション）」と「画像なし」を毎日交互に投稿します。本日は: ${hasImageToday ? '画像あり' : '画像なし'}`
      };
    } else {
      // 10枚以上: 常に画像ありで毎日投稿
      return {
        mode: 'ALWAYS_IMAGE',
        frequency: 'DAILY',
        hasImageToday: true,
        description: `【パターンC】画像ストック${imageCount}枚（10枚以上）: 「常に画像あり」で、画像を順次切り替えながら毎日投稿します。`
      };
    }
  }

  /**
   * 2. 本日投稿すべき最適な「画像」と「挙動」を決定してペイロードを生成します。
   * 
   * @param stockImages Google Drive内の画像ファイルのパスまたはIDの配列
   * @param lastPostedIndex 最後に投稿した画像のインデックス（ローテーション用。履歴DBから取得することを想定）
   * @param dayIndex 投稿開始からの通算日数（0, 1, 2...。交互モードの判定に使用）
   */
  public generatePostPayload(
    stockImages: string[],
    lastPostedIndex: number = -1,
    dayIndex: number = 0
  ): PostPayload {
    const imageCount = stockImages.length;
    const behavior = this.determinePostingBehavior(imageCount, dayIndex);

    // 画像なしの日の場合
    if (!behavior.hasImageToday) {
      return {
        hasImage: false,
        selectedImage: null,
        textGenerationRequired: true,
        reason: `${behavior.mode} モードに基づく「画像なし（テキストのみ）」の投稿日です。`
      };
    }

    // 画像ありの日の場合、ストックから次の画像を選択（ローテーション）
    if (imageCount === 0) {
      return {
        hasImage: false,
        selectedImage: null,
        textGenerationRequired: true,
        reason: '画像ストックが存在しないため、画像なしで投稿します。'
      };
    }

    // 次のインデックスを計算 (0始まり、ストック数を超えたらループ)
    const nextIndex = (lastPostedIndex + 1) % imageCount;
    const selectedImage = stockImages[nextIndex];

    return {
      hasImage: true,
      selectedImage,
      textGenerationRequired: true,
      reason: `${behavior.mode} モードに基づき、ストック${imageCount}枚からインデックス[${nextIndex}]の画像「${selectedImage}」をローテーション選択しました。`
    };
  }
}
