import urllib.parse

# 都田様（THANX社）から共有されたクライアントID
client_id = "1079878924526-k6u43hakqb3bfand5lcmkere5m3evqpg.apps.googleusercontent.com"

# テスト段階の認証コード取得用リダイレクトURI (OOB / localhost)
# 注意: 本番移行時は正しいサーバーURLをGCPに登録します。
redirect_uri = "http://localhost"
scope = "https://www.googleapis.com/auth/business.manage"

params = {
    "client_id": client_id,
    "redirect_uri": redirect_uri,
    "response_type": "code",
    "scope": scope,
    "access_type": "offline",
    "prompt": "consent"
}

# OAuth2.0 ログイン画面への認証URLを生成
auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)

print("=" * 80)
print("Google GBP API OAuth 2.0 接続疎通確認テスト")
print("=" * 80)
print("\n以下のURLをブラウザで開いて、Googleアカウントでの認証テストを行ってください：\n")
print(auth_url)
print("\n" + "=" * 80)
