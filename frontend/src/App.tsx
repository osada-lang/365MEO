import React, { useState, useEffect, useRef } from 'react';
import {
  LayoutDashboard,
  Image as ImageIcon,
  Settings,
  MessageSquare,
  LogOut,
  Upload,
  Trash2,
  AlertTriangle,
  CheckCircle,
  ExternalLink,
  Lock,
  Mail,
  RefreshCw,
  Sparkles,
  Send,
  Check,
  Clock,
  ArrowLeft
} from 'lucide-react';

const metaEnv = (import.meta as any).env;
const API_BASE = metaEnv && metaEnv.VITE_API_BASE_URL
  ? (metaEnv.VITE_API_BASE_URL.endsWith('/api') ? metaEnv.VITE_API_BASE_URL : `${metaEnv.VITE_API_BASE_URL}/api`)
  : (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000/api'
    : '/api');

interface ShopProfile {
  id: string;
  name: string;
  email: string;
  role: string;
  agency_name: string | null;
  google_location_id: string | null;
  google_drive_folder_id: string | null;
  line_user_id: string | null;
  reply_active: boolean;
  post_active?: boolean;
  custom_review_prompt: string | null;
}

interface DraftPost {
  dayIndex: number;
  title: string;
  text: string;
  subKeywords: string[];
  imageFileId?: string | null;
}

interface DashboardData {
  shopName: string;
  replyActive: boolean;
  postActive: boolean;
  imageCount: number;
  postingMode: string;
  postingModeLabel: string;
  pendingReviewsCount: number;
  nextPostTime: string;
  previewImage: string | null;
  googleLocationId: string | null;
  gbpActionUrl: string | null;
  draftPosts: DraftPost[];
}

interface DriveImage {
  id: string;
  name: string;
  mimeType: string;
  size: string;
  createdTime: string;
  dataUrl?: string;
}

interface ReviewLog {
  id: string;
  shop_id: string;
  review_id: string;
  reviewer_name: string;
  star_rating: number;
  comment: string | null;
  reply_text: string | null;
  is_auto_replied: boolean;
  requires_alert: boolean;
  escalation_triggered: boolean;
  reply_source?: string | null;
  create_time: string;
  is_pre_integration?: boolean;
}

interface SettingsData {
  shopId: string;
  shopName: string;
  replyActive: boolean;
  postActive: boolean;
  customReviewPrompt: string;
  lineUserId: string;
  keywords: {
    mainKeywords: string[];
    subKeywords: string[];
    fixedFooter: string;
    customPrompt: string;
    hpUrl: string;
    tabelogUrl: string;
    hotpepperUrl: string;
    gurunaviUrl: string;
    gbpActionUrl: string;
    postTimeHour?: number;
  };
}

export default function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [userRole, setUserRole] = useState<string | null>(localStorage.getItem('userRole'));
  const [currentShop, setCurrentShop] = useState<ShopProfile | null>(null);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'photos' | 'settings' | 'reviews'>('dashboard');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isPageLoading, setIsPageLoading] = useState<boolean>(true);

  // Authentication Form
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [rememberMe, setRememberMe] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // API states
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [photos, setPhotos] = useState<DriveImage[]>([]);
  const [reviews, setReviews] = useState<ReviewLog[]>([]);

  // Sub-actions states
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isToggling, setIsToggling] = useState<boolean>(false);
  const [recentSenders, setRecentSenders] = useState<{ userId: string; displayName: string; timestamp: number }[]>([]);
  const [isDetectingLine, setIsDetectingLine] = useState<boolean>(false);
  const [messageBanner, setMessageBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 3-Day Draft states
  const [editingDraftText, setEditingDraftText] = useState<{ [dayIndex: number]: string }>({});
  const [isEditingDraft, setIsEditingDraft] = useState<{ [dayIndex: number]: boolean }>({});
  const [isSavingDrafts, setIsSavingDrafts] = useState<{ [dayIndex: number]: boolean }>({});
  const [isRegeneratingDraft, setIsRegeneratingDraft] = useState<{ [dayIndex: number]: boolean }>({});
  const [isRegeneratingAll, setIsRegeneratingAll] = useState<boolean>(false);

  // Master Account States
  const [shopsList, setShopsList] = useState<ShopProfile[]>([]);
  const [agenciesList, setAgenciesList] = useState<ShopProfile[]>([]);
  const [isViewingShop, setIsViewingShop] = useState<boolean>(false);
  const [shopSearchQuery, setShopSearchQuery] = useState<string>('');
  const [expandedAgencies, setExpandedAgencies] = useState<{ [key: string]: boolean }>({
    '365MEO（直営店契約）': true
  });

  // Parse URL parameters for magic login token and tab redirection on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get('token');
    const urlTab = urlParams.get('tab');

    if (urlToken) {
      localStorage.setItem('token', urlToken);
      setToken(urlToken);
      // Clean query parameters from URL for a clean address bar
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    if (urlTab === 'reviews') {
      setActiveTab('reviews');
    }
  }, []);

  // Fetch shops list for master/admin/agency accounts
  useEffect(() => {
    if ((userRole === 'ADMIN' || userRole === 'AGENCY') && token) {
      const fetchShops = async () => {
        try {
          const res = await fetch(`${API_BASE}/shops`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (res.ok) {
            const data = await res.json();
            setShopsList(data.shops || []);
            setAgenciesList(data.agencies || []);
          }
        } catch (err) {
          console.error('Failed to fetch shops list:', err);
        }
      };
      fetchShops();
    }
  }, [userRole, token]);

  // Auto-login or initial session verification on reload
  useEffect(() => {
    const verifySession = async () => {
      if (!token) {
        setIsPageLoading(false);
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.ok) {
          const data = await res.json();
          setCurrentShop(data.shop);
          setUserRole(data.shop.role);
          localStorage.setItem('userRole', data.shop.role);
          setIsViewingShop(data.shop.role !== 'ADMIN' && data.shop.role !== 'AGENCY');
          if (data.newToken) {
            console.log('🔄 Magic token successfully exchanged for standard session token.');
            localStorage.setItem('token', data.newToken);
            setToken(data.newToken);
          }
        } else {
          // Token expired or invalid
          localStorage.removeItem('token');
          setToken(null);
        }
      } catch (err) {
        console.error('Session verification failed:', err);
      } finally {
        setIsPageLoading(false);
      }
    };

    verifySession();
  }, [token]);

  // Load active tab data when shop or tab changes
  useEffect(() => {
    if (!currentShop) return;

    // Clear previous shop data to prevent old data ghosting/badges during loading
    setDashboard(null);
    setSettings(null);
    setPhotos([]);
    setReviews([]);

    const fetchTabData = async () => {
      setIsLoading(true);
      try {
        if (activeTab === 'dashboard') {
          const res = await fetch(`${API_BASE}/shops/${currentShop.id}/dashboard`);
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            setDashboard(data);
          } else {
            showBanner('error', data.error || 'ダッシュボードの同期に失敗しました。');
          }
        } else if (activeTab === 'settings') {
          const res = await fetch(`${API_BASE}/shops/${currentShop.id}/settings`);
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            setSettings(data);
          } else {
            showBanner('error', data.error || '設定の同期に失敗しました。');
          }
        } else if (activeTab === 'photos') {
          const res = await fetch(`${API_BASE}/shops/${currentShop.id}/drive-images`);
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            setPhotos(data.files);
          } else {
            showBanner('error', data.error || '画像ストックの同期に失敗しました。');
          }
        } else if (activeTab === 'reviews') {
          const res = await fetch(`${API_BASE}/shops/${currentShop.id}/reviews`);
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            setReviews(data.reviews);
          } else {
            showBanner('error', data.error || '口コミの同期に失敗しました。');
          }
        }
      } catch (err) {
        console.error(`Failed to fetch tab data (${activeTab}):`, err);
        showBanner('error', 'データの同期に失敗しました。');
      } finally {
        setIsLoading(false);
      }
    };

    fetchTabData();
  }, [currentShop, activeTab]);

  // Show status banner helpers
  const showBanner = (type: 'success' | 'error', text: string) => {
    setMessageBanner({ type, text });
    setTimeout(() => setMessageBanner(null), 4000);
  };

  // Handle Login submission
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setIsLoading(true);

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, rememberMe }),
      });

      const data = await res.json();
      if (res.ok) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('userRole', data.shop.role);
        setToken(data.token);
        setUserRole(data.shop.role);
        setCurrentShop(data.shop);
        setActiveTab('dashboard');
        setIsViewingShop(data.shop.role !== 'ADMIN' && data.shop.role !== 'AGENCY');
      } else {
        setAuthError(data.error || 'ログインに失敗しました。');
      }
    } catch (err) {
      setAuthError('バックエンドサーバーに接続できません。Expressサーバーが起動しているか確認してください。');
    } finally {
      setIsLoading(false);
    }
  };

  // Log out helper
  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('userRole');
    setToken(null);
    setUserRole(null);
    setCurrentShop(null);
    setDashboard(null);
    setSettings(null);
    setPhotos([]);
    setReviews([]);
    setIsViewingShop(false);
    setShopSearchQuery('');
  };

  /*
  // Demo Fast Switcher (For easy demo purposes - switch between seeded profiles instantly)
  const handleDemoSwitch = async (emailAddr: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailAddr, password: 'password', rememberMe: true }),
      });

      const data = await res.json();
      if (res.ok) {
        localStorage.setItem('token', data.token);
        // Do NOT overwrite userRole here to maintain ADMIN switcher panel visibility!
        setToken(data.token);
        setCurrentShop(data.shop);
        setActiveTab('dashboard');
        showBanner('success', `「${data.shop.name}」のデモ画面に切り替えました。`);
      }
    } catch (err) {
      showBanner('error', '店舗の切り替えに失敗しました。');
    } finally {
      setIsLoading(false);
    }
  };
  */

  /*
  // Toggle Auto-reply ON/OFF status
  const handleToggleReply = async () => {
    if (!currentShop || !dashboard || isToggling) return;
    setIsToggling(true);

    const nextState = !dashboard.replyActive;

    try {
      const res = await fetch(`${API_BASE}/shops/${currentShop.id}/toggle-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: nextState }),
      });

      if (res.ok) {
        setDashboard({ ...dashboard, replyActive: nextState });
        showBanner('success', `自動返信を「${nextState ? 'ON' : 'OFF'}」に切り替えました。`);
      } else {
        showBanner('error', '自動返信の切り替えに失敗しました。');
      }
    } catch (err) {
      showBanner('error', 'サーバーとの通信に失敗しました。');
    } finally {
      setIsToggling(false);
    }
  };
  */

  // Simulate daily posting and rollover slide
  const handleSimulateRollover = async () => {
    if (!currentShop || !dashboard || isToggling) return;
    setIsToggling(true);

    try {
      const res = await fetch(`${API_BASE}/shops/${currentShop.id}/batch/run-daily-post`, {
        method: 'POST',
      });

      const data = await res.json();
      if (res.ok) {
        setDashboard({
          ...dashboard,
          draftPosts: data.newDrafts,
        });
        showBanner('success', `【成功】${data.publishedPost.simulated ? '（疑似）' : '（本物）'}自動投稿＆下書きを1日スライドしました！`);
      } else {
        showBanner('error', data.error || 'スライドテストに失敗しました。');
      }
    } catch (err) {
      showBanner('error', 'サーバーとの通信に失敗しました。');
    } finally {
      setIsToggling(false);
    }
  };

  // Clear "本日投稿済み" (-1) draft for testing
  const handleClearPublished = async () => {
    if (!currentShop || !dashboard || isToggling) return;
    if (!confirm('「本日投稿済み」カードを強制リセットして、今日最初の自動投稿テスト（Day 0の公開）を行えるようにしますか？')) return;
    setIsToggling(true);

    try {
      const res = await fetch(`${API_BASE}/shops/${currentShop.id}/draft-posts/clear-published`, {
        method: 'POST',
      });

      const data = await res.json();
      if (res.ok) {
        setDashboard({
          ...dashboard,
          draftPosts: data.drafts,
        });
        showBanner('success', '🟢 「本日投稿済み」カードを強制リセットし、3日間の予定表示に戻しました！');
      } else {
        showBanner('error', data.error || 'リセットに失敗しました。');
      }
    } catch (err) {
      showBanner('error', 'サーバーとの通信に失敗しました。');
    } finally {
      setIsToggling(false);
    }
  };

  // Save Settings forms (Keywords, templates, prompts)
  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentShop || !settings) return;
    setIsLoading(true);

    try {
      const res = await fetch(`${API_BASE}/shops/${currentShop.id}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });

      if (res.ok) {
        showBanner('success', '設定をデータベースに正常に保存しました！');
      } else {
        showBanner('error', '設定の保存に失敗しました。');
      }
    } catch (err) {
      showBanner('error', '通信エラー：保存できませんでした。');
    } finally {
      setIsLoading(false);
    }
  };

  // Trigger LINE Notification simulation
  const handleTestLineAlert = async () => {
    if (!currentShop) return;
    setIsLoading(true);

    try {
      const res = await fetch(`${API_BASE}/shops/${currentShop.id}/test-line-alert`, {
        method: 'POST',
      });

      const data = await res.json();
      if (res.ok) {
        showBanner('success', '🔔 スマホLINE宛てに模擬お詫び下書きアラートを即座にプッシュ送信しました！');
      } else {
        showBanner('error', data.error || 'LINE通知の送信に失敗しました。');
      }
    } catch (err) {
      showBanner('error', 'LINEテスト通知の送信に失敗しました。');
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch recent LINE message senders for self-pairing
  const handleDetectLineSenders = async () => {
    setIsDetectingLine(true);
    try {
      const res = await fetch(`${API_BASE}/line/recent-senders`);
      const data = await res.json();
      if (res.ok && data.senders) {
        setRecentSenders(data.senders);
        if (data.senders.length > 0) {
          showBanner('success', `🌟 LINEの送信者を ${data.senders.length}件 検出しました！`);
        } else {
          showBanner('error', '直近15分以内に公式LINEへメッセージを送信したユーザーが見つかりません。');
        }
      } else {
        showBanner('error', 'LINE送信者の検出に失敗しました。');
      }
    } catch (err) {
      showBanner('error', '通信エラー：LINE送信者を検出できませんでした。');
    } finally {
      setIsDetectingLine(false);
    }
  };

  // Direct Image upload to Google Drive
  const handleImageUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentShop) return;

    // Check size limit (e.g. 5MB)
    if (file.size > 5 * 1024 * 1024) {
      showBanner('error', '画像ファイルは5MB以下にしてください。');
      return;
    }

    setIsUploading(true);

    // Convert file to base64
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = async () => {
      const base64String = (reader.result as string).split(',')[1];

      try {
        const res = await fetch(`${API_BASE}/shops/${currentShop.id}/drive-images/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: file.name,
            mimeType: file.type,
            base64Data: base64String,
          }),
        });

        const data = await res.json();
        if (res.ok) {
          setPhotos([data.file, ...photos]);
          showBanner('success', `🎉 「${file.name}」をストックに直接追加しました。`);
        } else {
          showBanner('error', data.error || 'アップロードに失敗しました。');
        }
      } catch (err) {
        showBanner('error', '画像のアップロード中に通信エラーが発生しました。');
      } finally {
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
  };

  // Delete image from Google Drive
  const handleDeleteImage = async (fileId: string, fileName: string) => {
    if (!currentShop) return;
    if (!confirm(`本当にこの写真「${fileName}」をストックから削除しますか？`)) return;

    try {
      const res = await fetch(`${API_BASE}/shops/${currentShop.id}/drive-images/${fileId}`, {
        method: 'DELETE',
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        setPhotos(photos.filter((p: DriveImage) => p.id !== fileId));
        showBanner('success', `🗑️ 写真「${fileName}」をストックから削除しました。`);
      } else {
        showBanner('error', data.error || '写真の削除に失敗しました。');
      }
    } catch (err) {
      showBanner('error', '通信エラー：削除できませんでした。');
    }
  };

  // Submit hand-edited AI generated review apology draft
  const [editingReplyText, setEditingReplyText] = useState<{ [key: string]: string }>({});

  const handleSendApology = async (reviewId: string) => {
    if (!currentShop) return;
    const replyText = editingReplyText[reviewId];

    if (!replyText || replyText.trim() === '') {
      alert('返信文面を入力してください。');
      return;
    }

    // Determine if the review is low rating or positive rating to customize success banner wording
    const matchingReview = reviews.find(r => r.review_id === reviewId);
    const isLowRating = matchingReview ? matchingReview.star_rating <= 2 : true;
    const successMsg = isLowRating
      ? '🟢 AIお詫び文を編集し、Googleマップ（GBP）に返信を送信しました！'
      : '🟢 AIお礼文を編集し、Googleマップ（GBP）に返信を送信しました！';

    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/shops/${currentShop.id}/reviews/${encodeURIComponent(reviewId)}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replyText }),
      });

      if (res.ok) {
        showBanner('success', successMsg);
        // Refresh reviews list
        const revRes = await fetch(`${API_BASE}/shops/${currentShop.id}/reviews`);
        if (revRes.ok) {
          const revData = await revRes.json();
          setReviews(revData.reviews);
        }
        // Refresh dashboard count
        const dashRes = await fetch(`${API_BASE}/shops/${currentShop.id}/dashboard`);
        if (dashRes.ok) {
          const dashData = await dashRes.json();
          setDashboard(dashData);
        }
      } else {
        showBanner('error', '返信の送信に失敗しました。');
      }
    } catch (err) {
      showBanner('error', '通信エラー：返信を送信できませんでした。');
    } finally {
      setIsLoading(false);
    }
  };

  // Save single draft post back to database
  const handleSaveDraft = async (dayIndex: number) => {
    if (!currentShop || !dashboard) return;
    
    setIsSavingDrafts(prev => ({ ...prev, [dayIndex]: true }));
    
    // Update draft array with our edited text
    const updatedDrafts = dashboard.draftPosts.map((d) => {
      if (d.dayIndex === dayIndex) {
        return {
          ...d,
          text: editingDraftText[dayIndex] !== undefined ? editingDraftText[dayIndex] : d.text
        };
      }
      return d;
    });

    try {
      const res = await fetch(`${API_BASE}/shops/${currentShop.id}/draft-posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drafts: updatedDrafts }),
      });

      if (res.ok) {
        setDashboard({
          ...dashboard,
          draftPosts: updatedDrafts
        });
        setIsEditingDraft(prev => ({ ...prev, [dayIndex]: false }));
        showBanner('success', `✨ Day ${dayIndex} の下書きを保存しました。`);
      } else {
        showBanner('error', '下書きの保存に失敗しました。');
      }
    } catch (err) {
      showBanner('error', '通信エラー：下書きを保存できませんでした。');
    } finally {
      setIsSavingDrafts(prev => ({ ...prev, [dayIndex]: false }));
    }
  };

  // Regenerate single or all draft posts via Gemini API
  const handleRegenerateDraft = async (dayIndex: number, all: boolean = false) => {
    if (!currentShop || !dashboard) return;

    if (all) {
      setIsRegeneratingAll(true);
    } else {
      setIsRegeneratingDraft(prev => ({ ...prev, [dayIndex]: true }));
    }

    try {
      const res = await fetch(`${API_BASE}/shops/${currentShop.id}/draft-posts/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dayIndex, all }),
      });

      const data = await res.json();
      if (res.ok && data.drafts) {
        setDashboard({
          ...dashboard,
          draftPosts: data.drafts
        });
        
        // Clear editing states for regenerated items
        if (all) {
          setEditingDraftText({});
          setIsEditingDraft({});
          showBanner('success', '✨ 3日先までのすべての下書きをAIで再生成しました！');
        } else {
          setEditingDraftText(prev => {
            const next = { ...prev };
            delete next[dayIndex];
            return next;
          });
          setIsEditingDraft(prev => ({ ...prev, [dayIndex]: false }));
          showBanner('success', `✨ Day ${dayIndex} の下書きをAIで再生成しました！`);
        }
      } else {
        showBanner('error', data.error || 'AI下書きの再生成に失敗しました。');
      }
    } catch (err) {
      showBanner('error', '通信エラー：AI下書きを再生成できませんでした。');
    } finally {
      if (all) {
        setIsRegeneratingAll(false);
      } else {
        setIsRegeneratingDraft(prev => ({ ...prev, [dayIndex]: false }));
      }
    }
  };

  // Regenerate/rewrite AI apology draft using custom directives
  const handleRegenerateReply = async (reviewId: string, directiveText: string) => {
    if (!currentShop) return;
    setIsLoading(true);

    try {
      const res = await fetch(`${API_BASE}/shops/${currentShop.id}/reviews/${encodeURIComponent(reviewId)}/regenerate-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directive: directiveText }),
      });

      const data = await res.json();
      if (res.ok) {
        setEditingReplyText(prev => ({
          ...prev,
          [reviewId]: data.replyText,
        }));

        const matchingReview = reviews.find(r => r.review_id === reviewId);
        const isLowRating = matchingReview ? matchingReview.star_rating <= 2 : true;
        const successMsg = isLowRating
          ? '🪄 AIが指定された指示に従ってお詫び文を書き直しました！'
          : '🪄 AIが指定された指示に従ってお礼文を書き直しました！';

        showBanner('success', successMsg);
      } else {
        showBanner('error', data.error || '再生成に失敗しました。');
      }
    } catch (err) {
      showBanner('error', '通信エラー：AI再生成をリクエストできませんでした。');
    } finally {
      setIsLoading(false);
    }
  };


  // Delete review log from list
  const handleDeleteReview = async (reviewId: string) => {
    if (!currentShop) return;
    if (!window.confirm('この口コミ履歴をデータベースから削除してもよろしいですか？\n(Googleマイビジネス側の実際の口コミは削除されません)')) return;

    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/shops/${currentShop.id}/reviews/${encodeURIComponent(reviewId)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (res.ok) {
        setReviews(prev => prev.filter(r => r.review_id !== reviewId));
        showBanner('success', '🗑️ 口コミ履歴を削除しました。');
        
        // Refresh dashboard count
        const dashRes = await fetch(`${API_BASE}/shops/${currentShop.id}/dashboard`);
        if (dashRes.ok) {
          const dashData = await dashRes.json();
          setDashboard(dashData.dashboard);
        }
      } else {
        showBanner('error', data.error || '口コミの削除に失敗しました。');
      }
    } catch (err) {
      showBanner('error', '通信エラー：口コミ履歴を削除できませんでした。');
    } finally {
      setIsLoading(false);
    }
  };


  // loading screens
  if (isPageLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
        <RefreshCw className="w-10 h-10 text-indigo-500 animate-spin mb-4" />
        <p className="text-slate-300 font-medium text-sm">セッションを同期中...</p>
      </div>
    );
  }

  // ==========================================
  // 🔓 Login Screen UI
  // ==========================================
  if (!token || !currentShop) {
    return (
      <div className="min-h-screen stripe-mesh flex flex-col justify-center py-12 sm:px-6 lg:px-8">
        <div className="sm:mx-auto sm:w-full sm:max-w-md text-center px-4">
          <div className="flex justify-center mb-4">
            <img src="/logo_365.png" alt="365MEO" className="h-16 w-auto object-contain drop-shadow-md" />
          </div>
          <p className="mt-2 text-xs text-indigo-100 font-bold tracking-widest uppercase opacity-90 drop-shadow-sm">
            全自動投稿＆AI口コミ返信システム
          </p>
        </div>

        <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md px-4">
          <div className="bg-white/95 border border-white/20 py-8 px-6 shadow-2xl rounded-3xl sm:px-10 space-y-6">
            <h2 className="text-xl font-black text-stripeInk text-center border-b border-slate-100 pb-4">
              ログインアカウント
            </h2>

            {authError && (
              <div className="bg-rose-50 border border-rose-200 rounded-xl p-3.5 flex items-start gap-2.5">
                <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
                <span className="text-xs text-rose-800 leading-relaxed font-semibold">{authError}</span>
              </div>
            )}

            <form className="space-y-4.5" onSubmit={handleLogin}>
              <div>
                <label className="block text-xs font-bold text-stripeInk-mute tracking-wider mb-1.5 uppercase">
                  メールアドレス
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                    <Mail className="h-4.5 w-4.5 text-stripeInk-mute" />
                  </div>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="block w-full pl-10 pr-3 py-2.5 border border-slate-200 rounded-xl bg-slate-50/60 placeholder-slate-400 text-sm text-stripeInk focus:outline-none focus:ring-2 focus:ring-stripeIndigo-500 focus:border-transparent transition-all"
                    placeholder="email@example.com"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-stripeInk-mute tracking-wider mb-1.5 uppercase">
                  パスワード
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                    <Lock className="h-4.5 w-4.5 text-stripeInk-mute" />
                  </div>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="block w-full pl-10 pr-3 py-2.5 border border-slate-200 rounded-xl bg-slate-50/60 placeholder-slate-400 text-sm text-stripeInk focus:outline-none focus:ring-2 focus:ring-stripeIndigo-500 focus:border-transparent transition-all"
                    placeholder="••••••••"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <label className="flex items-center cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="w-4.5 h-4.5 rounded text-stripeIndigo-500 focus:ring-stripeIndigo-500 border-slate-200 bg-slate-50"
                  />
                  <span className="ml-2 text-xs text-stripeInk-secondary font-bold">次回から自動ログイン</span>
                </label>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-stripeIndigo-500 hover:bg-stripeIndigo-600 text-white font-extrabold text-sm py-3 px-4 rounded-full shadow-md shadow-stripeIndigo-500/10 transition-all focus:outline-none active:scale-[0.98] flex items-center justify-center gap-1.5"
                >
                  {isLoading ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    'ログインする'
                  )}
                </button>
              </div>
            </form>

            <div className="flex items-center justify-center gap-4 border-t border-slate-100 pt-5 text-center">
              <a href="/terms.html" target="_blank" rel="noopener noreferrer" className="text-[11px] font-bold text-slate-400 hover:text-indigo-500 transition-colors">
                利用規約
              </a>
              <span className="text-[11px] text-slate-300">|</span>
              <a href="/privacy.html" target="_blank" rel="noopener noreferrer" className="text-[11px] font-bold text-slate-400 hover:text-indigo-500 transition-colors">
                プライバシーポリシー
              </a>
            </div>

          </div>
        </div>
      </div>
    );
  }

  // ==========================================
  // 👑 Master / Agency Account Contracted Shops List Screen (ADMIN / AGENCY)
  // ==========================================
  if (token && currentShop && (userRole === 'ADMIN' || userRole === 'AGENCY') && !isViewingShop) {
    // Group shopsList by agency name
    const groupedShops: { [agency: string]: ShopProfile[] } = {};

    // 🌟 Always pre-populate 365MEO (direct contract) at the top of the list so it stays visible even with 0 shops
    if (!shopSearchQuery || '365meo'.includes(shopSearchQuery.toLowerCase()) || '直営店'.includes(shopSearchQuery)) {
      groupedShops['365MEO（直営店契約）'] = [];
    }

    // For ADMIN role, pre-populate all existing agencies so they appear even if they have 0 shops
    if (userRole === 'ADMIN') {
      agenciesList.forEach((agency) => {
        const agencyName = agency.name || '不明な代理店';
        // Only include if empty or matches search query (or if searching for shops, we still keep empty agencies)
        if (!shopSearchQuery || agencyName.toLowerCase().includes(shopSearchQuery.toLowerCase())) {
          if (!groupedShops[agencyName]) {
            groupedShops[agencyName] = [];
          }
        }
      });
    }

    const filteredShops = shopsList.filter(shop =>
      shop.name.toLowerCase().includes(shopSearchQuery.toLowerCase()) ||
      shop.email.toLowerCase().includes(shopSearchQuery.toLowerCase()) ||
      (shop.agency_name && shop.agency_name.toLowerCase().includes(shopSearchQuery.toLowerCase()))
    );

    filteredShops.forEach((shop) => {
      const agency = (!shop.agency_name || shop.agency_name.trim() === '' || shop.agency_name === '365MEO')
        ? '365MEO（直営店契約）'
        : shop.agency_name;
      
      if (!groupedShops[agency]) {
        groupedShops[agency] = [];
      }
      groupedShops[agency].push(shop);
    });

    // Sort agencies so that 365MEO is always first
    const sortedAgencies = Object.keys(groupedShops).sort((a, b) => {
      if (a.startsWith('365MEO')) return -1;
      if (b.startsWith('365MEO')) return 1;
      return a.localeCompare(b, 'ja-JP');
    });

    return (
      <div className="min-h-screen stripe-mesh flex flex-col justify-start py-8 px-4 sm:px-6 lg:px-8 bg-slate-950">
        <div className="max-w-4xl w-full mx-auto space-y-6">
          {/* Header Area */}
          <div className="flex items-center justify-between bg-white/95 border border-white/20 p-5 rounded-3xl shadow-xl">
            <div className="flex items-center gap-3">
              <img src="/logo_365.png" alt="365MEO" className="h-9 w-auto object-contain" />
              <div className="border-l border-slate-200 pl-3">
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-wider leading-none">
                  {userRole === 'ADMIN' ? '365MEO マスターコントロール' : '365MEO 代理店コントロール'}
                </p>
                <h1 className="text-sm font-black text-slate-900 leading-none mt-1.5">
                  {userRole === 'ADMIN' ? '契約店舗・代理店一覧' : '管理顧客店舗一覧'}
                </h1>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
                <p className="text-xs font-black text-slate-800 leading-none">
                  {userRole === 'ADMIN' ? `👑 ${currentShop.name}` : `🏢 ${currentShop.name}`}
                </p>
                <p className="text-[9px] text-slate-400 font-bold mt-1 truncate max-w-[150px]">{currentShop.email}</p>
              </div>
              <button
                onClick={handleLogout}
                className="p-2.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition-all"
                title="ログアウト"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Search bar card */}
          <div className="bg-white/95 border border-white/20 rounded-3xl p-5 shadow-xl space-y-3">
            <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest leading-none">🔎 契約店舗を検索・絞り込み</h2>
            <div className="relative">
              <input
                type="text"
                value={shopSearchQuery}
                onChange={(e) => setShopSearchQuery(e.target.value)}
                placeholder="店舗名、メールアドレス、代理店名で検索..."
                className="block w-full border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold bg-slate-50/50 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brandBlue-500 focus:border-transparent transition-all"
              />
            </div>
          </div>

          {/* Hierarchy list */}
          <div className="space-y-4">
            {sortedAgencies.length === 0 ? (
              <div className="bg-white/95 border border-white/20 rounded-3xl py-12 px-4 text-center space-y-2 shadow-xl">
                <AlertTriangle className="w-8 h-8 text-slate-300 mx-auto" />
                <p className="text-xs font-extrabold text-slate-700">該当する店舗が見つかりませんでした。</p>
              </div>
            ) : (
              sortedAgencies.map((agency) => {
                const shops = groupedShops[agency];
                const isExpanded = expandedAgencies[agency] !== false; // default to expanded

                return (
                  <div key={agency} className="bg-white/95 border border-white/20 rounded-3xl shadow-xl overflow-hidden transition-all">
                    {/* Agency Header row */}
                    <button
                      type="button"
                      onClick={() => setExpandedAgencies({
                        ...expandedAgencies,
                        [agency]: !isExpanded
                      })}
                      className={`w-full px-5 py-4 flex items-center justify-between text-left transition-colors ${
                        agency.startsWith('365MEO') ? 'bg-indigo-50/50' : 'bg-slate-50/50'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span className={`w-2.5 h-2.5 rounded-full ${
                          agency.startsWith('365MEO') ? 'bg-indigo-500' : 'bg-slate-500'
                        }`} />
                        <h2 className={`text-xs font-black uppercase tracking-wider ${
                          agency.startsWith('365MEO') ? 'text-indigo-900' : 'text-slate-800'
                        }`}>
                          {agency.startsWith('365MEO') ? '👑 直営：365MEO' : `🏢 代理店：${agency}`}
                        </h2>
                        <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                          agency.startsWith('365MEO') ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-200 text-slate-700'
                        }`}>
                          {shops.length}店舗
                        </span>
                      </div>
                      <span className="text-xs font-black text-slate-400">
                        {isExpanded ? '閉じる 🔼' : '開く 🔽'}
                      </span>
                    </button>

                    {/* Expandable Shops List */}
                    {isExpanded && (
                      <div className="border-t border-slate-100 divide-y divide-slate-100 bg-white">
                        {shops.length === 0 ? (
                          <div className="p-5 text-center text-slate-400 font-bold text-xs bg-slate-50/20">
                            📭 契約・導入店舗はありません（店舗なし）
                          </div>
                        ) : (
                          shops.map((shop) => (
                            <div key={shop.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 hover:bg-slate-50/50 transition-colors">
                              <div className="space-y-1">
                                <h3 className="text-xs font-black text-slate-900">{shop.name}</h3>
                                <p className="text-[10px] text-slate-400 font-bold">{shop.email}</p>
                              </div>
                              <div className="flex items-center gap-3 self-end sm:self-auto">
                                <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full ${
                                  shop.post_active ? 'bg-indigo-50 text-indigo-700 border border-indigo-100' : 'bg-slate-100 text-slate-500 border border-slate-200'
                                }`}>
                                  {shop.post_active ? '毎日投稿: 作動中' : '毎日投稿: 停止中'}
                                </span>
                                <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full ${
                                  shop.reply_active ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-slate-100 text-slate-500 border border-slate-200'
                                }`}>
                                  {shop.reply_active ? '自動返信: 作動中' : '自動返信: 停止中'}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCurrentShop(shop);
                                    setIsViewingShop(true);
                                  }}
                                  className="bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-[10px] py-1.5 px-3.5 rounded-xl shadow-sm transition-all active:scale-[0.97]"
                                >
                                  管理画面にアクセス ➔
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    );
  }

  // ==========================================
  // 📱 Admin Layout & Navigation (Mobile-first Dashboard)
  // ==========================================
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col pb-20 sm:pb-0">
      {/* 🧭 Global Header */}
      <header className="sticky top-0 z-40 bg-white border-b border-slate-200/80 px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-2">
          <img src="/logo_365.png" alt="365MEO" className="h-7 w-auto object-contain" />
        </div>
        <div className="flex items-center gap-2.5">
          <div className="hidden md:block text-right">
            <p className="text-xs font-black text-slate-900 leading-tight">{currentShop.name}</p>
            <p className="text-[10px] text-slate-500 font-bold">
              {userRole === 'ADMIN' ? '👑 マスター管理者' : (userRole === 'AGENCY' ? '🏢 代理店管理者' : '店舗オーナー')}
            </p>
          </div>
          <button
            onClick={handleLogout}
            className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition-all"
            title="ログアウト"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* 📊 Message Notification Banner */}
      {messageBanner && (
        <div className={`fixed top-16 left-4 right-4 z-50 rounded-2xl border p-4 shadow-xl flex items-start gap-3 animate-bounce max-w-md mx-auto ${
          messageBanner.type === 'success'
            ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
            : 'bg-rose-50 border-rose-200 text-rose-900'
        }`}>
          {messageBanner.type === 'success' ? (
            <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
          )}
          <span className="text-xs font-bold leading-relaxed">{messageBanner.text}</span>
        </div>
      )}

      {/* Wrapper to handle sidebar indentation for desktop/mobile layouts */}
      <div className="flex-1 flex flex-col sm:pl-60">
        {/* 🚀 Active Screen Container */}
        <main className="flex-1 max-w-md lg:max-w-6xl w-full mx-auto px-4 py-5 space-y-5">
          {/* Master / Agency Account Shop back button (Mobile) */}
          {(userRole === 'ADMIN' || userRole === 'AGENCY') && isViewingShop && (
            <button
              onClick={() => {
                setIsViewingShop(false);
                setDashboard(null);
                setSettings(null);
                setPhotos([]);
                setReviews([]);
              }}
              className="bg-indigo-50 border border-indigo-100 rounded-2xl p-3.5 text-xs font-black text-indigo-700 flex items-center justify-center gap-1.5 shadow-sm sm:hidden w-full no-print"
            >
              <ArrowLeft className="w-4.5 h-4.5" />
              店舗一覧に戻る
            </button>
          )}

          {/* Master / Agency Account Shop Switcher (Mobile) */}
          {(userRole === 'ADMIN' || userRole === 'AGENCY') && shopsList.length > 0 && (
            <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-3.5 space-y-2 shadow-sm sm:hidden no-print">
              <label className="block text-[10px] font-black text-indigo-500 uppercase tracking-widest leading-none">
                {userRole === 'ADMIN' ? '👑 マスター店舗切替 (ADMIN)' : '🏢 代理店店舗切替 (AGENCY)'}
              </label>
              <div className="relative mt-1">
                <select
                  value={currentShop?.id || ''}
                  onChange={(e) => {
                    const targetShop = shopsList.find(s => s.id === e.target.value);
                    if (targetShop) {
                      setCurrentShop(targetShop);
                      showBanner('success', `「${targetShop.name}」のデータに切り替えました。`);
                    }
                  }}
                  className="block w-full border border-indigo-200 rounded-xl px-3 py-2 text-xs font-bold bg-white text-indigo-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer appearance-none"
                >
                  {shopsList.map((shop) => (
                    <option key={shop.id} value={shop.id}>
                      {shop.name}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3.5 text-indigo-500">
                  <Clock className="w-3.5 h-3.5 text-indigo-400" />
                </div>
              </div>
            </div>
          )}

        {/* 1️⃣ SCREEN: Dashboard */}
        {activeTab === 'dashboard' && (
          isLoading || !dashboard ? (
            <div className="bg-white border border-slate-200/80 rounded-2xl py-16 px-4 text-center space-y-3 shadow-sm">
              <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin mx-auto" />
              <p className="text-xs font-extrabold text-slate-600">ダッシュボードを読み込み中...</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:space-y-0 space-y-4 items-start">
              {/* Left Panel: Store Info, Status, Switches */}
              <div className="lg:col-span-5 space-y-4">
                {/* Store Title Board */}
                <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-3">
                  <div>
                    <p className="text-[10px] font-bold text-slate-400 tracking-widest uppercase">現在管理中の店舗</p>
                    <h2 className="text-xl font-black text-slate-900 leading-tight mt-0.5">{dashboard.shopName}</h2>
                  </div>

                  {/* 📍 Quick Links */}
                  <div className="pt-1.5">
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dashboard.shopName)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="bg-slate-50 hover:bg-indigo-50 border border-slate-200/80 hover:border-indigo-200 p-3.5 rounded-xl transition-all flex items-center justify-between text-left group w-full"
                    >
                      <div>
                        <span className="text-[10px] font-black text-slate-400 group-hover:text-indigo-500 transition-colors uppercase block">Google Maps</span>
                        <span className="text-xs font-bold text-slate-800 block mt-0.5">店舗を確認</span>
                      </div>
                      <ExternalLink className="w-4 h-4 text-slate-400 group-hover:text-indigo-500 transition-colors" />
                    </a>
                  </div>
                </div>

                {/* CARD 3: Blink Emergency review alert banner */}
                {dashboard.pendingReviewsCount > 0 && (
                  <button
                    onClick={() => setActiveTab('reviews')}
                    className="w-full bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-900 rounded-2xl p-4 shadow-sm flex items-center justify-between text-left group animate-pulse transition-all"
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-9 h-9 rounded-xl bg-rose-500/10 flex items-center justify-center shrink-0">
                        <AlertTriangle className="w-5 h-5 text-rose-600" />
                      </span>
                    <div>
                      <h3 className="text-sm font-extrabold">🚨 緊急お詫び下書きの承認待ち</h3>
                      <p className="text-xs text-rose-700 font-bold mt-0.5">
                        星1・星2の低評価口コミが <span className="underline font-black text-sm">{dashboard.pendingReviewsCount}件</span> 届いています。
                      </p>
                    </div>
                  </div>
                  <span className="text-xs font-black text-rose-700 bg-rose-100 group-hover:bg-rose-200 py-1.5 px-3 rounded-lg shrink-0 transition-all border border-rose-300">
                    今すぐ編集 ➔
                  </span>
                </button>
              )}

              {/* CARD 1: Scheduled Post Card */}
              <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <span className="text-xs font-black text-slate-800 tracking-wider flex items-center gap-1.5 uppercase">
                    <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-pulse"></span>
                    本日の自動投稿ステータス
                  </span>
                  <span className="text-[10px] font-black bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full">
                    予約完了
                  </span>
                </div>

                <div className="space-y-3.5">
                  <div className="flex items-start justify-between gap-4 text-xs font-bold">
                    <span className="text-slate-400 uppercase">次回投稿予定</span>
                    <span className="text-slate-900 text-right">{dashboard.nextPostTime}</span>
                  </div>

                  <div className="flex items-start justify-between gap-4 text-xs font-bold border-t border-slate-50 pt-3">
                    <span className="text-slate-400 uppercase">動作最適化モード</span>
                    <span className="text-brandBlue-600 text-right max-w-[200px] leading-relaxed">
                      {dashboard.postingModeLabel}
                    </span>
                  </div>

                  <div className="flex items-start justify-between gap-4 text-xs font-bold border-t border-slate-50 pt-3">
                    <span className="text-slate-400 uppercase">画像ストック状況</span>
                    <span className={`font-black text-right ${dashboard.imageCount > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {dashboard.imageCount > 0 ? (dashboard.imageCount >= 1000 ? '1000枚（これ以上読み込めません）' : `${dashboard.imageCount}枚（画像自動連携中）`) : '0枚（テキストのみ投稿）'}
                    </span>
                  </div>
                </div>
              </div>

              {/* CARD 2: Toggle Switch Card */}
              <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <span className="text-xs font-black text-slate-800 tracking-wider flex items-center gap-1.5 uppercase">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
                    自動返信ステータス (星3〜★5のみ対象)
                  </span>
                  <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                    dashboard.replyActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                  }`}>
                    {dashboard.replyActive ? '作動中' : '停止中'}
                  </span>
                </div>

                <div className="flex items-center justify-between py-2">
                  <div>
                    <h3 className="text-sm font-extrabold text-slate-900">口コミ自動返信機能</h3>
                    <p className="text-[10px] text-slate-400 font-bold leading-relaxed mt-0.5">
                      ONの場合、星3〜5の高評価に対して、1時間後にGemini AIが自動作成した最適な返信文で自動送信します。<br />
                      OFFの場合、星3〜5の高評価に対しても、低評価同様に店主様のLINEにAI返信下書きを通知し、承認後に送信します。
                    </p>
                  </div>

                  {/* Read-Only Status Toggle (Changeable via Settings Tab) */}
                  <div className="flex flex-col items-end gap-1">
                    <div
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-default rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                        dashboard.replyActive ? 'bg-emerald-500' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          dashboard.replyActive ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </div>
                    <span className="text-[8px] font-bold text-slate-400 whitespace-nowrap">
                      ※設定タブで変更可能
                    </span>
                  </div>
                </div>
              </div>

              {/* CARD 3: Toggle Switch Card (Read-Only) for Auto-Post */}
              <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <span className="text-xs font-black text-slate-800 tracking-wider flex items-center gap-1.5 uppercase">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
                    自動投稿ステータス
                  </span>
                  <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                    dashboard.postActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                  }`}>
                    {dashboard.postActive ? '作動中' : '停止中'}
                  </span>
                </div>

                <div className="flex items-center justify-between py-2">
                  <div>
                    <h3 className="text-sm font-extrabold text-slate-900">最新情報の自動投稿機能</h3>
                    <p className="text-[10px] text-slate-400 font-bold leading-relaxed mt-0.5">
                      ONの場合、毎日設定された時間に、Google Drive内のストック画像とAIが生成したおしらせ文章を自動で公開します。<br />
                      OFFの場合、自動投稿処理は一時停止されます。
                    </p>
                  </div>

                  {/* Read-Only Status Toggle (Changeable via Settings Tab) */}
                  <div className="flex flex-col items-end gap-1">
                    <div
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-default rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                        dashboard.postActive ? 'bg-emerald-500' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          dashboard.postActive ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </div>
                    <span className="text-[8px] font-bold text-slate-400 whitespace-nowrap">
                      ※設定タブで変更可能
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Panel: 3-Day Editable Scheduled Drafts Panel */}
            <div className="lg:col-span-7 bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black text-slate-800 tracking-wider flex items-center gap-1.5 uppercase">
                  <Sparkles className="w-4 h-4 text-indigo-500" />
                  📅 3日先までのAI自動投稿・予約下書き
                </span>
                <button
                  type="button"
                  disabled={isRegeneratingAll}
                  onClick={() => handleRegenerateDraft(0, true)}
                  className="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[10px] font-black py-1.5 px-3 rounded-full transition-all flex items-center gap-1 border border-indigo-100 disabled:opacity-50"
                >
                  {isRegeneratingAll ? (
                    <>
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      一括作成中...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3 h-3" />
                      3日分を一括作成 🪄
                    </>
                  )}
                </button>
              </div>

              <div className="space-y-4">
                    {dashboard.draftPosts && dashboard.draftPosts.length > 0 ? (
                      dashboard.draftPosts.map((d) => {
                        const isEditing = !!isEditingDraft[d.dayIndex];
                        const isSaving = !!isSavingDrafts[d.dayIndex];
                        const isRegenerating = !!isRegeneratingDraft[d.dayIndex];
                        const currentText = editingDraftText[d.dayIndex] !== undefined ? editingDraftText[d.dayIndex] : d.text;

                        return (
                          <div key={d.dayIndex} className="bg-white border border-slate-200/80 rounded-xl p-4 shadow-sm space-y-3">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                                  d.dayIndex === -1
                                    ? 'bg-slate-100 text-slate-600 border border-slate-200'
                                    : d.dayIndex === 0
                                    ? (dashboard.draftPosts.some(x => x.dayIndex === -1)
                                      ? 'bg-indigo-50 text-indigo-700 border border-indigo-100'
                                      : 'bg-rose-50 text-rose-700 border border-rose-100')
                                    : d.dayIndex === 1
                                    ? (dashboard.draftPosts.some(x => x.dayIndex === -1)
                                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                                      : 'bg-indigo-50 text-indigo-700 border border-indigo-100')
                                    : 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                                }`}>
                                  {d.dayIndex === -1
                                    ? '本日投稿済み 🟢'
                                    : d.dayIndex === 0
                                    ? (dashboard.draftPosts.some(x => x.dayIndex === -1) ? '明日投稿予定' : '本日投稿予定')
                                    : d.dayIndex === 1
                                    ? (dashboard.draftPosts.some(x => x.dayIndex === -1) ? '明後日投稿予定' : '明日投稿予定')
                                    : (dashboard.draftPosts.some(x => x.dayIndex === -1) ? '明々後日投稿予定' : '明後日投稿予定')}
                                </span>
                                <h4 className="text-xs font-black text-slate-800 mt-1.5">
                                  {d.dayIndex === -1
                                    ? '本日投稿済みの下書き'
                                    : d.dayIndex === 0
                                    ? (dashboard.draftPosts.some(x => x.dayIndex === -1) ? '明日投稿予定の下書き (Day 0)' : '本日投稿予定の下書き (Day 0)')
                                    : d.dayIndex === 1
                                    ? (dashboard.draftPosts.some(x => x.dayIndex === -1) ? '明後日投稿予定の下書き (Day 1)' : '明日投稿予定の下書き (Day 1)')
                                    : (dashboard.draftPosts.some(x => x.dayIndex === -1) ? '明々後日投稿予定の下書き (Day 2)' : '明後日投稿予定の下書き (Day 2)')}
                                </h4>
                              </div>
                              
                              {d.subKeywords && d.subKeywords.length > 0 && (
                                <div className="text-right shrink-0 bg-indigo-50/50 border border-indigo-100/80 rounded-xl p-2 min-w-[90px] max-w-[120px]">
                                  <span className="text-[8px] font-black text-indigo-500 block border-b border-indigo-100/80 pb-0.5 mb-1 tracking-wider text-center">
                                    🔄 サブKW
                                  </span>
                                  <ul className="text-[8px] font-black text-indigo-600 space-y-0.5 text-left list-none leading-tight">
                                    {d.subKeywords.map((word, sIdx) => (
                                      <li key={sIdx} className="truncate" title={word}>
                                        ・{word}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>

                            <div className="bg-slate-50/50 border border-slate-100 rounded-xl p-3">
                              {isEditing ? (
                                <textarea
                                  className="block w-full border border-slate-200 rounded-lg p-2.5 text-[11px] font-bold text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-brandBlue-500 leading-normal min-h-[120px]"
                                  value={currentText}
                                  onChange={(e) => {
                                    setEditingDraftText({
                                      ...editingDraftText,
                                      [d.dayIndex]: e.target.value
                                    });
                                  }}
                                />
                              ) : (
                                <p className="text-[11px] font-bold text-slate-700 whitespace-pre-wrap leading-relaxed">
                                  {d.text}
                                </p>
                              )}
                            </div>

                            {d.imageFileId && !isEditing && (
                              <div className="flex items-start gap-4 bg-slate-50/50 border border-slate-100 rounded-xl p-3.5">
                                <div className="w-24 h-24 bg-slate-900/5 rounded-xl overflow-hidden border border-slate-200/60 shrink-0 shadow-sm">
                                  <img
                                    src={`${API_BASE.replace('/api', '')}/api/shops/${currentShop?.id}/drive-images/${d.imageFileId}/view`}
                                    alt={d.dayIndex === -1 ? "投稿済みの写真" : "投稿予定の写真"}
                                    className="object-cover w-full h-full hover:scale-105 transition-transform duration-200"
                                  />
                                </div>
                                <div className="text-[10px] text-slate-500 font-bold space-y-1.5 pt-1">
                                  {d.dayIndex === -1 ? (
                                    <>
                                      <span className="text-[9px] bg-emerald-50 text-emerald-700 border border-emerald-100/60 px-2 py-0.5 rounded-full font-black">
                                        📸 投稿済みの写真
                                      </span>
                                      <p className="text-slate-700 font-extrabold text-[11px] leading-relaxed">
                                        この画像と一緒にGoogleマップへ公開されました。
                                      </p>
                                      <p className="text-[10px] text-slate-400 font-normal leading-normal">
                                        店舗オーナー用のGoogle Driveストックから、自動的に最適な画像が使用されました。
                                      </p>
                                    </>
                                  ) : (
                                    <>
                                      <span className="text-[9px] bg-brandBlue-50 text-brandBlue-700 border border-brandBlue-100/60 px-2 py-0.5 rounded-full font-black">
                                        📸 投稿予定の写真
                                      </span>
                                      <p className="text-slate-700 font-extrabold text-[11px] leading-relaxed">
                                        この下書きと一緒にGoogleマップへ投稿されます。
                                      </p>
                                      <p className="text-[10px] text-slate-400 font-normal leading-normal">
                                        店舗オーナー用のGoogle Driveストックから、自動的に最適な画像が割り振られています。
                                      </p>
                                    </>
                                  )}
                                </div>
                              </div>
                            )}

                            <div className="flex items-center justify-end gap-1.5 pt-1 border-t border-slate-100">
                              {isEditing ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setIsEditingDraft(prev => ({ ...prev, [d.dayIndex]: false }));
                                      setEditingDraftText(prev => {
                                        const next = { ...prev };
                                        delete next[d.dayIndex];
                                        return next;
                                      });
                                    }}
                                    className="bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-bold py-1.5 px-3 rounded-lg transition-all"
                                  >
                                    キャンセル
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isSaving}
                                    onClick={() => handleSaveDraft(d.dayIndex)}
                                    className="bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-black py-1.5 px-3.5 rounded-lg transition-all flex items-center gap-1"
                                  >
                                    {isSaving ? (
                                      <RefreshCw className="w-3 h-3 animate-spin" />
                                    ) : (
                                      '下書きを保存'
                                    )}
                                  </button>
                                </>
                              ) : d.dayIndex === -1 ? (
                                <span className="text-[10px] font-black text-emerald-600 bg-emerald-50 border border-emerald-100/80 py-1.5 px-3 rounded-lg">
                                  ✓ Googleマップへ正常に送信・公開されました
                                </span>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    disabled={isRegenerating}
                                    onClick={() => handleRegenerateDraft(d.dayIndex, false)}
                                    className="bg-slate-50 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-200 text-slate-700 text-[10px] font-bold py-1.5 px-3 rounded-lg transition-all flex items-center gap-1"
                                  >
                                    {isRegenerating ? (
                                      <RefreshCw className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <>
                                        <Sparkles className="w-3 h-3 text-indigo-500" />
                                        AI再生成
                                      </>
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingDraftText({
                                        ...editingDraftText,
                                        [d.dayIndex]: d.text
                                      });
                                      setIsEditingDraft(prev => ({ ...prev, [d.dayIndex]: true }));
                                    }}
                                    className="bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-bold py-1.5 px-3.5 rounded-lg transition-all"
                                  >
                                    手動編集
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-5 text-center space-y-1.5">
                        <AlertTriangle className="w-5 h-5 text-indigo-500 mx-auto" />
                        <p className="text-xs font-extrabold text-slate-800">下書きがありません</p>
                        <p className="text-[10px] text-slate-500 font-bold max-w-[240px] mx-auto leading-relaxed">
                          [3日分を一括作成] をタップして、Gemini AIで予約下書きを新規作成してください。
                        </p>
                      </div>
                    )}
                  </div>

                  {/* 🚨 TEST BUTTON FOR ROLL-OVER */}
                  {userRole === 'ADMIN' && dashboard.draftPosts && dashboard.draftPosts.length > 0 && (
                    <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-4 space-y-2 mt-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></span>
                          <h4 className="text-xs font-black text-slate-800">【開発デモ検証】毎日自動投稿シミュレーター</h4>
                        </div>
                        <span className="text-[8px] font-black bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">DEV ONLY</span>
                      </div>
                      <p className="text-[9px] text-slate-500 font-bold leading-normal">
                        このボタンを押すと、「本日（Day 0）」の下書きがGoogleマップへ実際に送信されます（接続前は疑似送信）。その後、下書きが1日分スライドし、新しく空いた明後日分（Day 2）にGemini AIが自動投稿文を新規生成します。
                      </p>
                      <button
                        type="button"
                        disabled={isToggling}
                        onClick={handleSimulateRollover}
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-[10px] py-2 px-3 rounded-lg shadow transition-all active:scale-[0.98] flex items-center justify-center gap-1.5"
                      >
                        {isToggling ? (
                          <RefreshCw className="w-3 h-3 animate-spin" />
                        ) : (
                          <>
                            <Sparkles className="w-3 h-3" />
                            本日分を自動投稿して下書きをスライド（ロールオーバー）する 🚀
                          </>
                        )}
                      </button>

                      {dashboard.draftPosts.some((d: any) => d.dayIndex === -1) && (
                        <button
                          type="button"
                          disabled={isToggling}
                          onClick={handleClearPublished}
                          className="w-full bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 font-extrabold text-[10px] py-2 px-3 rounded-lg shadow-sm transition-all active:scale-[0.98] flex items-center justify-center gap-1.5 mt-2"
                        >
                          {isToggling ? (
                            <RefreshCw className="w-3 h-3 animate-spin" />
                          ) : (
                            <>
                              <RefreshCw className="w-3 h-3" />
                              「本日投稿済み」カードを強制リセット（JST日付変更をシミュレート） 🧹
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  )}
            </div>
          </div>
        )
      )}

        {/* 2️⃣ SCREEN: Photos (Google Drive Image Manager) */}
        {activeTab === 'photos' && (
          <div className="space-y-4">
            {/* Header info */}
            <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-2">
              <h2 className="text-lg font-black text-slate-900 flex items-center gap-2">
                <ImageIcon className="w-5 h-5 text-brandBlue-600" />
                画像ストック管理 (Google Drive)
              </h2>
              <p className="text-[10px] text-slate-500 font-bold leading-relaxed">
                店舗の専用Google Driveフォルダと双方向でリアルタイム同期。
                ここから追加した写真は自動的にストックされ、MEO自動投稿のローテーションで使用されます。
              </p>

              {/* Upload action box */}
              <div className="pt-3">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="image/jpeg,image/png"
                  className="hidden"
                />
                <button
                  onClick={handleImageUploadClick}
                  disabled={isUploading}
                  className="w-full bg-brandBlue-50 hover:bg-brandBlue-100 border border-brandBlue-200 text-brandBlue-700 font-extrabold text-xs py-3 px-4 rounded-xl shadow-sm transition-all active:scale-[0.98] flex items-center justify-center gap-1.5"
                >
                  {isUploading ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Upload className="w-4 h-4" />
                      写真をアップロード追加する (JPEG/PNG)
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Photos Grid */}
            <div className="space-y-2.5">
              <span className="text-xs font-black text-slate-400 block uppercase tracking-wider">
                現在のストック写真一覧 ({photos.length >= 1000 ? '1000枚 - これ以上読み込めません' : `${photos.length}枚`})
              </span>

              {isLoading ? (
                <div className="bg-white border border-slate-200/80 rounded-2xl py-12 px-4 text-center space-y-3">
                  <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin mx-auto" />
                  <p className="text-xs font-extrabold text-slate-600">Google Driveから写真を同期中...</p>
                </div>
              ) : photos.length === 0 ? (
                <div className="bg-white border border-slate-200/80 rounded-2xl py-12 px-4 text-center space-y-2">
                  <ImageIcon className="w-8 h-8 text-slate-300 mx-auto" />
                  <p className="text-xs font-extrabold text-slate-700">写真がありません</p>
                  <p className="text-[10px] text-slate-400 font-bold leading-relaxed max-w-[200px] mx-auto">
                    上のボタンから最初の1枚をアップロードしてください。
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {photos.map((photo) => (
                    <div key={photo.id} className="bg-white border border-slate-200/80 rounded-2xl overflow-hidden shadow-sm flex flex-col group relative">
                      <div className="aspect-square bg-slate-900/5 relative flex items-center justify-center overflow-hidden border-b border-slate-100">
                        <img
                          src={photo.dataUrl || `${API_BASE.replace('/api', '')}/api/shops/${currentShop?.id}/drive-images/${photo.id}/view`}
                          alt={photo.name}
                          className="object-cover w-full h-full"
                        />
                        <button
                          onClick={() => handleDeleteImage(photo.id, photo.name)}
                          className="absolute bottom-2 right-2 p-2 bg-slate-950/80 text-rose-400 hover:text-rose-500 rounded-xl transition-all"
                          title="画像を削除"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="p-2.5 space-y-0.5 text-[10px] leading-tight font-bold">
                        <p className="text-slate-900 truncate" title={photo.name}>{photo.name}</p>
                        <p className="text-slate-400 uppercase">{photo.size || '容量不明'}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 3️⃣ SCREEN: Settings */}
        {activeTab === 'settings' && (
          isLoading || !settings ? (
            <div className="bg-white border border-slate-200/80 rounded-2xl py-16 px-4 text-center space-y-3 shadow-sm">
              <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin mx-auto" />
              <p className="text-xs font-extrabold text-slate-600">自動投稿・返信設定を読み込み中...</p>
            </div>
          ) : (
            <form onSubmit={handleSaveSettings} className="space-y-4">

            {/* CARD: Toggle Switch Card for Auto-reply inside Settings */}
            <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <span className="text-xs font-black text-slate-800 tracking-wider flex items-center gap-1.5 uppercase">
                  <span className={`w-2.5 h-2.5 rounded-full ${settings.replyActive ? 'bg-emerald-500' : 'bg-slate-300'}`}></span>
                  自動返信ステータス (星3〜★5のみ対象)
                </span>
                <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                  settings.replyActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                }`}>
                  {settings.replyActive ? '作動中' : '停止中'}
                </span>
              </div>

              <div className="flex items-center justify-between py-1">
                <div>
                  <h3 className="text-sm font-extrabold text-slate-900">口コミ自動返信機能</h3>
                  <p className="text-[10px] text-slate-400 font-bold leading-relaxed mt-0.5">
                    ONの場合、星3〜5の高評価に対して、1時間後に登録済みの定型文からランダムに自動送信します。
                  </p>
                </div>

                {/* Smooth Animated Toggle */}
                <button
                  type="button"
                  onClick={() => setSettings({ ...settings, replyActive: !settings.replyActive })}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    settings.replyActive ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      settings.replyActive ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* CARD: Toggle Switch Card for Auto-post inside Settings */}
            <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <span className="text-xs font-black text-slate-800 tracking-wider flex items-center gap-1.5 uppercase">
                  <span className={`w-2.5 h-2.5 rounded-full ${settings.postActive ? 'bg-emerald-500' : 'bg-slate-300'}`}></span>
                  自動投稿ステータス
                </span>
                <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                  settings.postActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                }`}>
                  {settings.postActive ? '作動中' : '停止中'}
                </span>
              </div>

              <div className="flex items-center justify-between py-1">
                <div>
                  <h3 className="text-sm font-extrabold text-slate-900">最新情報の自動投稿機能</h3>
                  <p className="text-[10px] text-slate-400 font-bold leading-relaxed mt-0.5">
                    ONの場合、毎日設定された時間に、Google Drive内のストック画像とAIが生成したおしらせ文章を自動で公開します。<br />
                    OFFの場合、自動投稿処理は一時停止されます。
                  </p>
                </div>

                {/* Smooth Animated Toggle */}
                <button
                  type="button"
                  onClick={() => setSettings({ ...settings, postActive: !settings.postActive })}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    settings.postActive ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      settings.postActive ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Auto post settings */}
            <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-4">
              <h2 className="text-base font-black text-slate-900 border-b border-slate-100 pb-2 flex items-center gap-2">
                <LayoutDashboard className="w-5 h-5 text-indigo-600" />
                AI自動投稿・キーワード設定
              </h2>

              {/* Daily Posting Hour Dropdown */}
              <div className="space-y-1.5 border-b border-slate-100/80 pb-4">
                <label className="block text-[11px] font-black text-slate-400 tracking-wider uppercase">
                  毎日自動投稿の時間帯
                </label>
                <p className="text-[9px] text-slate-400 leading-normal font-bold">
                  おしらせがGoogleマップ（GBP）へ自動公開される時間帯を1時間単位で設定できます。（デフォルト：12時）
                </p>
                <div className="relative">
                  <select
                    className="block w-full border border-slate-200 rounded-xl px-3 py-2.5 text-xs font-bold bg-slate-50/50 text-slate-900 focus:outline-none focus:ring-2 focus:ring-brandBlue-500 appearance-none cursor-pointer"
                    value={settings.keywords.postTimeHour !== undefined ? settings.keywords.postTimeHour : 12}
                    onChange={(e) => setSettings({
                      ...settings,
                      keywords: { ...settings.keywords, postTimeHour: parseInt(e.target.value, 10) }
                    })}
                  >
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].map((hour) => (
                      <option key={hour} value={hour}>
                        {hour}:00 頃
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-500">
                    <Clock className="w-4 h-4 text-slate-400" />
                  </div>
                </div>
              </div>

              {/* Main Keywords */}
              <div className="space-y-1.5">
                <label className="block text-[11px] font-black text-slate-400 tracking-wider uppercase">
                  メインキーワード (毎回必ず含める5つ)
                </label>
                <p className="text-[9px] text-slate-400 leading-normal font-bold">
                  MEOの主要KWを登録してください。AIが自然に投稿へ組み込みます。
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {[0, 1, 2, 3, 4].map((idx) => (
                    <input
                      key={`main-${idx}`}
                      type="text"
                      className="border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold bg-slate-50/50 text-slate-900 focus:outline-none focus:ring-2 focus:ring-brandBlue-500"
                      placeholder={`キーワード ${idx + 1}`}
                      value={settings.keywords.mainKeywords[idx] || ''}
                      onChange={(e) => {
                        const updated = [...settings.keywords.mainKeywords];
                        updated[idx] = e.target.value;
                        setSettings({
                          ...settings,
                          keywords: { ...settings.keywords, mainKeywords: updated }
                        });
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* Sub Keywords */}
              <div className="space-y-1.5 border-t border-slate-50 pt-3">
                <label className="block text-[11px] font-black text-slate-400 tracking-wider uppercase">
                  サブキーワード (毎回ランダムに2〜3語含める)
                </label>
                <p className="text-[9px] text-slate-400 leading-normal font-bold">
                  KWのプールから自動で異なる組み合わせをローテーションします。
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((idx) => (
                    <input
                      key={`sub-${idx}`}
                      type="text"
                      className="border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold bg-slate-50/50 text-slate-900 focus:outline-none focus:ring-2 focus:ring-brandBlue-500"
                      placeholder={`サブKW ${idx + 1}`}
                      value={settings.keywords.subKeywords[idx] || ''}
                      onChange={(e) => {
                        const updated = [...settings.keywords.subKeywords];
                        updated[idx] = e.target.value;
                        setSettings({
                          ...settings,
                          keywords: { ...settings.keywords, subKeywords: updated }
                        });
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* Store unique prompt custom_prompt */}
              <div className="space-y-1.5 border-t border-slate-50 pt-3">
                <label className="block text-[11px] font-black text-slate-400 tracking-wider uppercase">
                  店舗固有のAI投稿プロンプト (`custom_prompt`)
                </label>
                <p className="text-[9px] text-slate-400 leading-normal font-bold">
                  自店舗ならではの強み、ターゲット、トーン＆マナーを指定してください。
                </p>
                <textarea
                  className="block w-full border border-slate-200 rounded-xl p-3 text-xs font-bold bg-slate-50/50 text-slate-900 focus:outline-none focus:ring-2 focus:ring-brandBlue-500 leading-relaxed min-h-[90px]"
                  placeholder="例：上品で落ち着いた雰囲気。トリートメント、美髪ケアについて強調してください。"
                  value={settings.keywords.customPrompt}
                  onChange={(e) => setSettings({
                    ...settings,
                    keywords: { ...settings.keywords, customPrompt: e.target.value }
                  })}
                />
              </div>

              {/* Fixed Footer Sign */}
              <div className="space-y-1.5 border-t border-slate-50 pt-3">
                <label className="block text-[11px] font-black text-slate-400 tracking-wider uppercase">
                  固定署名 (フッター文面)
                </label>
                <p className="text-[9px] text-slate-400 leading-normal font-bold">
                  投稿文の最後に自動で付与されます（住所、営業時間等）。
                </p>
                <textarea
                  className="block w-full border border-slate-200 rounded-xl p-3 text-xs font-bold bg-slate-50/50 text-slate-900 focus:outline-none focus:ring-2 focus:ring-brandBlue-500 leading-relaxed min-h-[80px]"
                  placeholder="店舗名: Avenir Hair 栄店&#10;住所: 名古屋市中区錦3丁目&#10;電話: 052-XXX-XXXX"
                  value={settings.keywords.fixedFooter}
                  onChange={(e) => setSettings({
                    ...settings,
                    keywords: { ...settings.keywords, fixedFooter: e.target.value }
                  })}
                />
              </div>

              {/* HP URL and GBP Action Button settings */}
              <div className="grid grid-cols-2 gap-3.5 border-t border-slate-50 pt-3">
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-black text-slate-400 tracking-wider uppercase">
                    店舗ホームページURL (HP)
                  </label>
                  <p className="text-[9px] text-slate-400 leading-normal font-bold">
                    最新サービス情報等をAIが自動参照します。
                  </p>
                  <input
                    type="url"
                    className="block w-full border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold bg-slate-50/50 text-slate-900 focus:outline-none focus:ring-2 focus:ring-brandBlue-500"
                    placeholder="https://thanx-create.com"
                    value={settings.keywords.hpUrl || ''}
                    onChange={(e) => setSettings({
                      ...settings,
                      keywords: { ...settings.keywords, hpUrl: e.target.value }
                    })}
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-[11px] font-black text-slate-400 tracking-wider uppercase">
                    GBP投稿「詳細」ボタンURL
                  </label>
                  <p className="text-[9px] text-slate-400 leading-normal font-bold">
                    投稿ボタンに設定する、LPやキャンペーンのURLです。
                  </p>
                  <input
                    type="url"
                    className="block w-full border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold bg-slate-50/50 text-slate-900 focus:outline-none focus:ring-2 focus:ring-brandBlue-500"
                    placeholder="https://thanx-create.com/lp-meo"
                    value={settings.keywords.gbpActionUrl || ''}
                    onChange={(e) => setSettings({
                      ...settings,
                      keywords: { ...settings.keywords, gbpActionUrl: e.target.value }
                    })}
                  />
                </div>
              </div>

              {/* 3 Major Portals Settings */}
              <div className="border-t border-slate-50 pt-4 space-y-3">
                <label className="block text-[11px] font-black text-slate-400 tracking-wider uppercase">
                  ポータルサイト連携URL (任意)
                </label>
                <p className="text-[9px] text-slate-400 leading-normal font-bold">
                  ホットペッパーや食べログ等のポータルの最新の口コミや掲載メニューをAIに学習させます。
                </p>
                
                <div className="space-y-3">
                  <div className="space-y-1">
                    <span className="block text-[10px] font-bold text-slate-500">ポータルサイトURL①</span>
                    <input
                      type="url"
                      className="block w-full border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold bg-slate-50/50 text-slate-900 focus:outline-none focus:ring-2 focus:ring-brandBlue-500"
                      placeholder="https://tabelog.com/aichi/..."
                      value={settings.keywords.tabelogUrl || ''}
                      onChange={(e) => setSettings({
                        ...settings,
                        keywords: { ...settings.keywords, tabelogUrl: e.target.value }
                      })}
                    />
                  </div>

                  <div className="space-y-1">
                    <span className="block text-[10px] font-bold text-slate-500">ポータルサイトURL②</span>
                    <input
                      type="url"
                      className="block w-full border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold bg-slate-50/50 text-slate-900 focus:outline-none focus:ring-2 focus:ring-brandBlue-500"
                      placeholder="https://beauty.hotpepper.jp/slnH..."
                      value={settings.keywords.hotpepperUrl || ''}
                      onChange={(e) => setSettings({
                        ...settings,
                        keywords: { ...settings.keywords, hotpepperUrl: e.target.value }
                      })}
                    />
                  </div>

                  <div className="space-y-1">
                    <span className="block text-[10px] font-bold text-slate-500">ポータルサイトURL③</span>
                    <input
                      type="url"
                      className="block w-full border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold bg-slate-50/50 text-slate-900 focus:outline-none focus:ring-2 focus:ring-brandBlue-500"
                      placeholder="https://r.gnavi.co.jp/..."
                      value={settings.keywords.gurunaviUrl || ''}
                      onChange={(e) => setSettings({
                        ...settings,
                        keywords: { ...settings.keywords, gurunaviUrl: e.target.value }
                      })}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* CARD: LINE Notification Auto-Pairing */}
            <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-4">
              <h2 className="text-base font-black text-slate-900 border-b border-slate-100 pb-2 flex items-center gap-2">
                <Send className="w-5 h-5 text-indigo-600" />
                低評価アラート通知先 LINE連携
              </h2>

              <div className="space-y-3.5">
                <div className="space-y-2">
                  <label className="block text-[11px] font-black text-slate-400 tracking-wider uppercase">
                    現在の登録LINEユーザーID（最大3名）
                  </label>
                  {(() => {
                    const registeredIds = settings.lineUserId ? settings.lineUserId.split(',').map(id => id.trim()).filter(Boolean) : [];
                    
                    if (registeredIds.length === 0) {
                      return (
                        <div className="bg-rose-50/50 border border-rose-100 rounded-xl p-3 text-center">
                          <p className="text-[10px] text-rose-500 font-extrabold flex items-center justify-center gap-1">
                            <span>●</span> LINE IDが未設定のため、アラートは送信されません。
                          </p>
                        </div>
                      );
                    }

                    return (
                      <div className="space-y-2">
                        {registeredIds.map((id, idx) => (
                          <div key={idx} className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl p-2.5">
                            <div className="flex flex-col">
                              <span className="text-[9px] font-black text-indigo-500 uppercase">
                                連携先 {idx + 1}
                              </span>
                              <span className="text-[11px] font-mono font-bold text-slate-700 mt-0.5">
                                {id}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                const newIds = registeredIds.filter((_, i) => i !== idx);
                                setSettings({
                                  ...settings,
                                  lineUserId: newIds.join(',')
                                });
                                showBanner('success', `連携先 ${idx + 1} を削除しました。設定を保存すると確定します。`);
                              }}
                              className="text-[10px] font-black text-rose-600 hover:text-rose-800 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg py-1 px-2.5 transition-all"
                            >
                              削除
                            </button>
                          </div>
                        ))}
                        <p className="text-[10px] text-emerald-600 font-extrabold flex items-center gap-1 pt-1">
                          <span>●</span> 現在、上記のID宛てに低評価口コミの緊急LINEアラートが届きます。
                        </p>
                      </div>
                    );
                  })()}
                </div>

                <div className="border-t border-slate-100 pt-3.5 space-y-3.5">
                  <span className="block text-[11px] font-black text-slate-700 tracking-wider uppercase">
                    📱 かんたん自動LINE連携 (セルフ登録)
                  </span>

                  <div className="flex md:flex-row flex-col gap-4 items-center bg-slate-50 border border-slate-100 rounded-2xl p-4">
                    {/* QR Code */}
                    <div className="bg-white p-2.5 rounded-xl border border-slate-200/60 shrink-0 shadow-sm flex flex-col items-center justify-center">
                      <img
                        src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=https://lin.ee/uO1XrBT"
                        alt="LINE QR"
                        className="w-[100px] h-[100px]"
                      />
                      <span className="text-[8px] font-black text-slate-400 tracking-widest mt-1.5 uppercase">365MEO 公式</span>
                    </div>

                    <div className="text-[10px] text-slate-500 font-bold space-y-1.5">
                      <p className="text-slate-800 font-extrabold text-[11px] leading-relaxed">
                        【ステップ1】
                      </p>
                      <p className="leading-relaxed">
                        上記のQRコードをスマートフォンでスキャンし、**「365MEO公式LINEアカウント」を友だち追加**してください。
                      </p>
                      <p className="text-slate-800 font-extrabold text-[11px] leading-relaxed pt-0.5">
                        【ステップ2】
                      </p>
                      <p className="leading-relaxed">
                        友だち追加後、その公式LINE宛てに**スタンプまたは適当な一言メッセージを送信**してください。
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-[10px] text-slate-400 font-bold leading-normal">
                      【ステップ3】メッセージ送信後、以下のボタンを押してご自身のアカウントを自動検出してください。
                    </p>
                    <button
                      type="button"
                      disabled={isDetectingLine}
                      onClick={handleDetectLineSenders}
                      className="w-full bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-700 font-extrabold text-xs py-2.5 px-3 rounded-xl transition-all flex items-center justify-center gap-1.5 active:scale-[0.98]"
                    >
                      {isDetectingLine ? (
                        <RefreshCw className="w-3.5 h-3.5 animate-spin text-slate-500" />
                      ) : (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
                          LINE送信者を自動検出する
                        </>
                      )}
                    </button>

                    {recentSenders.length > 0 && (
                      <div className="border border-indigo-100 rounded-xl bg-indigo-50/50 p-3 space-y-2 animate-fadeIn">
                        <label className="block text-[9px] font-black text-indigo-500 uppercase tracking-wider leading-none">
                          🌟 検出された直近の送信者 (15分以内)
                        </label>
                        <p className="text-[9px] text-slate-400 leading-normal font-bold">
                          ご自身のアカウント（ニックネーム）を見つけたら、ボタンを押して連携してください。
                        </p>
                        <div className="divide-y divide-indigo-100/50 max-h-[140px] overflow-y-auto pr-1">
                          {recentSenders.map((sender) => (
                            <div key={sender.userId} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
                              <div>
                                <span className="text-xs font-black text-slate-800 block">
                                  {sender.displayName} 様
                                </span>
                                <span className="text-[9px] text-slate-400 font-mono">
                                  ID: {sender.userId.substring(0, 10)}...
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  const registeredIds = settings.lineUserId ? settings.lineUserId.split(',').map(id => id.trim()).filter(Boolean) : [];
                                  if (registeredIds.includes(sender.userId)) {
                                    showBanner('error', 'このアカウントは既に登録されています。');
                                    return;
                                  }
                                  if (registeredIds.length >= 3) {
                                    showBanner('error', '連携先は最大3名まで登録可能です。不要な連携先を削除してから追加してください。');
                                    return;
                                  }
                                  const newIds = [...registeredIds, sender.userId];
                                  setSettings({
                                    ...settings,
                                    lineUserId: newIds.join(',')
                                  });
                                  showBanner('success', `連携先に「${sender.displayName} 様」を追加しました。設定を保存すると登録が確定します。`);
                                }}
                                className="bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-extrabold py-1.5 px-3 rounded-lg transition-all"
                              >
                                このアカウントで連携する
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Custom Review Apology Guidelines Form */}
            <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <h2 className="text-base font-black text-slate-900 flex items-center gap-2">
                  <MessageSquare className="w-5 h-5 text-emerald-600" />
                  口コミ返信プロンプト・LINEテスト
                </h2>
                <button
                  type="button"
                  onClick={handleTestLineAlert}
                  className="bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 font-extrabold text-[10px] py-1.5 px-3 rounded-lg shrink-0 transition-all flex items-center gap-1 active:scale-[0.98]"
                >
                  <Send className="w-3 h-3" />
                  LINEテスト送信
                </button>
              </div>

              <div className="space-y-1.5">
                <label className="block text-[11px] font-black text-slate-400 tracking-wider uppercase">
                  低評価口コミお詫び文の追加指示プロンプト
                </label>
                <p className="text-[9px] text-slate-400 leading-normal font-bold">
                  星1・2検知時のAI謝罪下書きの文調、アピールしたい店舗特性を指示。
                </p>
                <textarea
                  className="block w-full border border-slate-200 rounded-xl p-3 text-xs font-bold bg-slate-50/50 text-slate-900 focus:outline-none focus:ring-2 focus:ring-brandBlue-500 leading-relaxed min-h-[100px]"
                  placeholder="例：高級サロンにふさわしい最高に上品な言葉遣いで。お叱りには深く寄り添いつつ、カウンセリング教育を徹底する姿勢を誠意を込めてアピールしてください。"
                  value={settings.customReviewPrompt}
                  onChange={(e) => setSettings({
                    ...settings,
                    customReviewPrompt: e.target.value
                  })}
                />
              </div>
            </div>

            {/* Sticky Actions */}
            <div className="pt-2 no-print">
              <button
                type="submit"
                disabled={isLoading}
                className="w-full bg-brandBlue-600 hover:bg-brandBlue-700 text-white font-extrabold text-sm py-3 px-4 rounded-xl shadow-lg transition-all active:scale-[0.98] flex items-center justify-center gap-1.5"
              >
                {isLoading ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Check className="w-4.5 h-4.5" />
                    設定を保存する
                  </>
                )}
              </button>
            </div>
          </form>
        )
      )}

        {/* 4️⃣ SCREEN: Review Logs & AI apology list */}
        {activeTab === 'reviews' && (
          <div className="space-y-4">
            {/* Header info */}
            <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-2">
              <h2 className="text-lg font-black text-slate-900 flex items-center gap-2">
                <MessageSquare className="w-5 h-5 text-brandBlue-600" />
                口コミ・返信下書き管理
              </h2>
              <p className="text-[10px] text-slate-500 font-bold leading-relaxed">
                新着の低評価（★1・★2）は自動送信されず、AIが作成した謝罪文をこの画面で安全に編集・承認して送信できます。高評価（★3〜5）は自動ランダム返信ログが表示されます。
              </p>
            </div>

            {/* List */}
            <div className="space-y-3">
              {isLoading ? (
                <div className="bg-white border border-slate-200/80 rounded-2xl py-12 px-4 text-center space-y-3">
                  <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin mx-auto" />
                  <p className="text-xs font-extrabold text-slate-600">Googleマイビジネスから口コミを同期中...</p>
                </div>
              ) : reviews.length === 0 ? (
                <div className="bg-white border border-slate-200/80 rounded-2xl py-12 px-4 text-center space-y-2">
                  <MessageSquare className="w-8 h-8 text-slate-300 mx-auto" />
                  <p className="text-xs font-extrabold text-slate-700">口コミ履歴がありません</p>
                </div>
              ) : (
                [...reviews]
                  .sort((a, b) => {
                    const aPending = !a.is_auto_replied;
                    const bPending = !b.is_auto_replied;

                    // 1. 未返信（承認待ち）の口コミを最優先で一番上に表示
                    if (aPending && !bPending) return -1;
                    if (!aPending && bPending) return 1;

                    // 2. 両方が未返信（承認待ち）の場合：古いものほど上（昇順 / ASC）
                    if (aPending && bPending) {
                      return new Date(a.create_time).getTime() - new Date(b.create_time).getTime();
                    }

                    // 3. 両方が返信済みの場合：新しいものほど上（降順 / DESC）
                    return new Date(b.create_time).getTime() - new Date(a.create_time).getTime();
                  })
                  .map((review: ReviewLog) => {
                    const isPendingReply = !review.is_auto_replied;

                    // Sync local text input state dynamically
                    if (isPendingReply && editingReplyText[review.review_id] === undefined) {
                      editingReplyText[review.review_id] = review.reply_text || '';
                    }

                  return (
                    <div
                      key={review.id}
                      className={`bg-white border rounded-2xl p-5 shadow-sm space-y-4 transition-all ${
                        isPendingReply 
                          ? (review.star_rating <= 2 ? 'border-rose-200 bg-rose-50/10' : 'border-indigo-200 bg-indigo-50/10') 
                          : 'border-slate-200/80'
                      }`}
                    >
                      {/* Customer post header */}
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-extrabold text-slate-900">{review.reviewer_name}様</span>
                            <span className="text-[9px] text-slate-400 font-bold">{new Date(review.create_time).toLocaleDateString()}</span>
                          </div>
                          {/* Star Ratings representation */}
                          <div className="flex items-center gap-0.5 mt-1">
                            {[1, 2, 3, 4, 5].map((star) => (
                              <span
                                key={`star-${star}`}
                                className={`text-base leading-none select-none ${
                                  star <= review.star_rating ? 'text-amber-400' : 'text-slate-200'
                                }`}
                              >
                                ★
                              </span>
                            ))}
                          </div>
                        </div>

                        {/* Status label tag and action buttons */}
                        <div className="flex items-center gap-2">
                          <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full ${
                            isPendingReply
                              ? (review.is_pre_integration
                                ? 'bg-slate-100 text-slate-700 border border-slate-300 animate-pulse'
                                : (review.star_rating <= 2
                                  ? 'bg-rose-100 text-rose-700 border border-rose-200 animate-pulse'
                                  : (dashboard?.replyActive
                                    ? 'bg-amber-100 text-amber-700 border border-amber-200 animate-pulse'
                                    : 'bg-indigo-100 text-indigo-700 border border-indigo-200 animate-pulse'
                                  )
                                )
                              )
                              : (review.is_pre_integration
                                ? 'bg-slate-100 text-slate-500 border border-slate-200'
                                : (review.reply_source === 'GBP'
                                  ? 'bg-slate-50 text-slate-600 border border-slate-200'
                                  : (review.reply_source === 'AUTO' || (!review.reply_source && review.star_rating >= 3)
                                    ? 'bg-indigo-50 text-indigo-700 border border-indigo-100'
                                    : 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                                  )
                                )
                              )
                          }`}>
                            {isPendingReply
                              ? (review.is_pre_integration
                                ? '導入前未返信'
                                : (review.star_rating <= 2
                                  ? '承認待ち (保留中)'
                                  : (dashboard?.replyActive
                                    ? '自動送信待ち (1時間後)'
                                    : '承認待ち (保留中)'
                                  )
                                )
                              )
                              : (review.is_pre_integration
                                ? '導入前返信済'
                                : (review.reply_source === 'GBP'
                                  ? 'GBPから返信完了'
                                  : (review.reply_source === 'AUTO' || (!review.reply_source && review.star_rating >= 3)
                                    ? '自動送信完了'
                                    : '手動送信完了'
                                  )
                                )
                              )
                            }
                          </span>

                          <button
                            type="button"
                            onClick={() => handleDeleteReview(review.review_id)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                            title="口コミ履歴を削除"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Customer Review comment */}
                      <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-3.5">
                        <p className="text-xs font-bold text-slate-700 leading-relaxed">
                          「{review.comment || '(本文なし。評価のみ)'}」
                        </p>
                      </div>

                      {/* Reply Area */}
                      {isPendingReply ? (
                        /* Manual check + editor (AI draft) */
                        <div className={`space-y-3.5 border-t border-dashed pt-3.5 ${
                          review.star_rating <= 2 ? 'border-rose-200' : 'border-indigo-200'
                        }`}>
                          <div className={`flex items-center gap-1 text-[11px] font-black uppercase ${
                            review.star_rating <= 2 ? 'text-rose-700' : 'text-indigo-700'
                          }`}>
                            <Sparkles className={`w-4 h-4 ${review.star_rating <= 2 ? 'text-rose-500 fill-rose-50' : 'text-indigo-500 fill-indigo-50'}`} />
                            {review.star_rating <= 2 ? 'AI作成されたお詫び文下書き (編集可能)' : 'AI作成された返信文下書き (編集可能)'}
                          </div>
                          <textarea
                            className={`block w-full border rounded-xl p-3.5 text-xs font-bold bg-white text-slate-800 focus:outline-none focus:ring-2 leading-relaxed min-h-[120px] ${
                              review.star_rating <= 2 ? 'border-rose-200 focus:ring-rose-500' : 'border-indigo-200 focus:ring-indigo-500'
                            }`}
                            value={editingReplyText[review.review_id] || ''}
                            onChange={(e) => {
                              setEditingReplyText({
                                ...editingReplyText,
                                [review.review_id]: e.target.value
                              });
                            }}
                          />

                          {/* 🪄 AI Rewrite Presets and custom directive input */}
                          <div className="flex flex-col gap-2.5 bg-slate-50 border border-slate-100 rounded-xl p-3">
                            <span className="text-[10px] font-bold text-slate-500 uppercase flex items-center gap-1">
                              <Sparkles className="w-3.5 h-3.5 text-indigo-500 fill-indigo-50" />
                              🪄 トーンを指定してAIで書き直す
                            </span>
                            <div className="flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleRegenerateReply(review.review_id, review.star_rating <= 2 ? 'より丁寧でフォーマルな謝罪文にしてください。' : 'より丁寧でフォーマルな感謝・アピール返信文にしてください。')}
                                disabled={isLoading}
                                className="bg-white hover:bg-indigo-50 border border-slate-200 text-slate-700 text-[10px] font-bold py-1 px-2.5 rounded-lg transition-all active:scale-[0.97] flex items-center gap-1"
                              >
                                💼 よりフォーマル
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRegenerateReply(review.review_id, review.star_rating <= 2 ? '150文字以内の非常に簡潔なお詫び文にまとめてください。' : '150文字以内の非常に簡潔なお礼文にまとめてください。')}
                                disabled={isLoading}
                                className="bg-white hover:bg-indigo-50 border border-slate-200 text-slate-700 text-[10px] font-bold py-1 px-2.5 rounded-lg transition-all active:scale-[0.97] flex items-center gap-1"
                              >
                                ⚡ 短く簡潔に
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRegenerateReply(review.review_id, review.star_rating <= 2 ? 'お客様への真摯な謝罪に加え、今後の技術指導や接客カウンセリング教育を早急に徹底する改善姿勢を強調してください。' : '店舗のアピールポイント、温かい感謝、そして定期的なメンテナンスのご案内をアピールして書き直してください。')}
                                disabled={isLoading}
                                className="bg-white hover:bg-indigo-50 border border-slate-200 text-slate-700 text-[10px] font-bold py-1 px-2.5 rounded-lg transition-all active:scale-[0.97] flex items-center gap-1"
                              >
                                🔧 改善・魅力アピール
                              </button>
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <input
                                type="text"
                                id={`custom-directive-${review.review_id}`}
                                placeholder={review.star_rating <= 2 ? '例: もっと親しみやすく、技術面についてお詫びして' : '例: メニューの強みをもっと前面に出して明るくお礼して'}
                                className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5 text-[10px] font-bold bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    const target = e.currentTarget;
                                    if (target.value.trim() !== '') {
                                      handleRegenerateReply(review.review_id, target.value);
                                      target.value = '';
                                    }
                                  }
                                }}
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const input = document.getElementById(`custom-directive-${review.review_id}`) as HTMLInputElement;
                                  if (input && input.value.trim() !== '') {
                                    handleRegenerateReply(review.review_id, input.value);
                                    input.value = '';
                                  }
                                }}
                                className="bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all shadow-sm"
                              >
                                指示する
                              </button>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleSendApology(review.review_id)}
                            disabled={isLoading}
                            className={`w-full text-white font-extrabold text-xs py-3 px-4 rounded-xl shadow-md transition-all active:scale-[0.98] flex items-center justify-center gap-1.5 no-print ${
                              review.star_rating <= 2 ? 'bg-rose-600 hover:bg-rose-700' : 'bg-indigo-600 hover:bg-indigo-700'
                            }`}
                          >
                            {isLoading ? (
                              <RefreshCw className="w-4.5 h-4.5 animate-spin" />
                            ) : (
                              <>
                                <Send className="w-4 h-4" />
                                {review.star_rating <= 2 ? 'お詫び文を承認して送信する' : '返信文を承認して送信する'}
                              </>
                            )}
                          </button>
                        </div>
                      ) : (
                        /* Past complete replied logs represent */
                        <div className="space-y-2 border-t border-slate-100 pt-3 text-[11px] leading-relaxed">
                          <span className="font-black text-slate-400 uppercase">返信済みの文面:</span>
                          <p className="bg-slate-50/50 border border-slate-200/40 rounded-xl p-3 font-bold text-slate-600">
                            {review.reply_text || '未返信'}
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </main>
      </div>

      {/* 📱 Mobile Sticky Navigation Bar (Mobile-first Navigation tab switcher) */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-slate-200/80 px-4 py-2 shadow-lg flex items-center justify-around sm:hidden no-print">
        <button
          onClick={() => setActiveTab('dashboard')}
          className={`flex flex-col items-center gap-0.5 py-1 px-3 rounded-xl transition-all ${
            activeTab === 'dashboard' ? 'text-brandBlue-600' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <LayoutDashboard className="w-5.5 h-5.5" />
          <span className="text-[9px] font-bold">ホーム</span>
        </button>

        <button
          onClick={() => setActiveTab('photos')}
          className={`flex flex-col items-center gap-0.5 py-1 px-3 rounded-xl transition-all ${
            activeTab === 'photos' ? 'text-brandBlue-600' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <ImageIcon className="w-5.5 h-5.5" />
          <span className="text-[9px] font-bold">写真管理</span>
        </button>

        <button
          onClick={() => setActiveTab('reviews')}
          className={`flex flex-col items-center gap-0.5 py-1 px-3 rounded-xl transition-all relative ${
            activeTab === 'reviews' ? 'text-brandBlue-600' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <MessageSquare className="w-5.5 h-5.5" />
          <span className="text-[9px] font-bold">口コミ</span>
          {dashboard && dashboard.pendingReviewsCount > 0 && (
            <span className="absolute top-0.5 right-3 w-4 h-4 bg-rose-500 border border-white text-white text-[9px] font-bold rounded-full flex items-center justify-center animate-pulse">
              {dashboard.pendingReviewsCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('settings')}
          className={`flex flex-col items-center gap-0.5 py-1 px-3 rounded-xl transition-all ${
            activeTab === 'settings' ? 'text-brandBlue-600' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <Settings className="w-5.5 h-5.5" />
          <span className="text-[9px] font-bold">設定</span>
        </button>
      </nav>

      {/* 🖥️ Desktop sidebar or global side menu for wide monitors */}
      <aside className="hidden sm:flex fixed top-16 left-0 bottom-0 w-60 bg-white border-r border-slate-200/80 p-4 flex-col justify-between shadow-sm z-30 no-print">
        <div className="space-y-2">
          {/* Master / Agency Account back button */}
          {(userRole === 'ADMIN' || userRole === 'AGENCY') && (
            <button
              onClick={() => {
                setIsViewingShop(false);
                setDashboard(null);
                setSettings(null);
                setPhotos([]);
                setReviews([]);
              }}
              className="w-full py-3 px-4 rounded-xl font-bold text-xs flex items-center gap-3 transition-all bg-indigo-50 border border-indigo-100/60 text-indigo-700 hover:bg-indigo-100 mb-2 shadow-sm"
            >
              <ArrowLeft className="w-4.5 h-4.5" />
              店舗一覧に戻る
            </button>
          )}

          {/* Master / Agency Account Shop Switcher (Desktop) */}
          {(userRole === 'ADMIN' || userRole === 'AGENCY') && shopsList.length > 0 && (
            <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-3.5 space-y-2 mb-4 shadow-sm">
              <label className="block text-[10px] font-black text-indigo-500 uppercase tracking-widest leading-none">
                {userRole === 'ADMIN' ? '👑 マスター店舗切替 (ADMIN)' : '🏢 代理店店舗切替 (AGENCY)'}
              </label>
              <div className="relative mt-1">
                <select
                  value={currentShop?.id || ''}
                  onChange={(e) => {
                    const targetShop = shopsList.find(s => s.id === e.target.value);
                    if (targetShop) {
                      setCurrentShop(targetShop);
                      showBanner('success', `「${targetShop.name}」のデータに切り替えました。`);
                    }
                  }}
                  className="block w-full border border-indigo-200 rounded-xl px-3 py-2 text-xs font-bold bg-white text-indigo-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer appearance-none"
                >
                  {shopsList.map((shop) => (
                    <option key={shop.id} value={shop.id}>
                      {shop.name}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3.5 text-indigo-500">
                  <Clock className="w-3.5 h-3.5 text-indigo-400" />
                </div>
              </div>
            </div>
          )}

          <button
            onClick={() => setActiveTab('dashboard')}
            className={`w-full py-3 px-4 rounded-xl font-bold text-xs flex items-center gap-3 transition-all ${
              activeTab === 'dashboard'
                ? 'bg-brandBlue-500 text-white shadow-md shadow-brandBlue-500/15'
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <LayoutDashboard className="w-4.5 h-4.5" />
            ダッシュボード
          </button>

          <button
            onClick={() => setActiveTab('photos')}
            className={`w-full py-3 px-4 rounded-xl font-bold text-xs flex items-center justify-between transition-all ${
              activeTab === 'photos'
                ? 'bg-brandBlue-500 text-white shadow-md shadow-brandBlue-500/15'
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <div className="flex items-center gap-3">
              <ImageIcon className="w-4.5 h-4.5" />
              画像ストック管理
            </div>
          </button>

          <button
            onClick={() => setActiveTab('reviews')}
            className={`w-full py-3 px-4 rounded-xl font-bold text-xs flex items-center justify-between transition-all ${
              activeTab === 'reviews'
                ? 'bg-brandBlue-500 text-white shadow-md shadow-brandBlue-500/15'
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <div className="flex items-center gap-3">
              <MessageSquare className="w-4.5 h-4.5" />
              口コミ・AIお詫び文
            </div>
            {dashboard && dashboard.pendingReviewsCount > 0 && (
              <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                activeTab === 'reviews' ? 'bg-white text-brandBlue-600' : 'bg-rose-500 text-white animate-pulse'
              }`}>
                {dashboard.pendingReviewsCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('settings')}
            className={`w-full py-3 px-4 rounded-xl font-bold text-xs flex items-center gap-3 transition-all ${
              activeTab === 'settings'
                ? 'bg-brandBlue-500 text-white shadow-md shadow-brandBlue-500/15'
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <Settings className="w-4.5 h-4.5" />
            自動投稿＆返信設定
          </button>
        </div>

        <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-4 space-y-1">
          <p className="text-[10px] font-black text-slate-400 uppercase leading-none">
            {userRole === 'ADMIN' ? '👑 マスターアカウント' : (userRole === 'AGENCY' ? '🏢 代理店アカウント' : 'ログインアカウント')}
          </p>
          <p className="text-xs font-black text-slate-800 leading-tight pt-1 truncate" title={currentShop.name}>{currentShop.name}</p>
          <p className="text-[9px] text-slate-400 font-bold truncate" title={currentShop.email}>{currentShop.email}</p>
        </div>
      </aside>
    </div>
  );
}
