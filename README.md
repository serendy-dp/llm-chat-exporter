# LLM Chat History Exporter

Claude / ChatGPT / Gemini の会話履歴をエクスポート・DB保存するツール。Chrome拡張機能 + ローカルサーバーで構成。

> [!WARNING]
> **動作確認日: 2026-03-29**
> このツールは各サービスの非公式 API（内部エンドポイント）を使用しています。
> API仕様・認証方式・レスポンス形式が変更された場合、予告なく動作しなくなります。
> 動作しなくなった場合は、ブラウザの DevTools（Network タブ）で実際のリクエストを確認し、
> 対応するコンテンツスクリプトのエンドポイントやパラメータを修正してください。
>
> **使用している非公式エンドポイント:**
>
> Claude.ai (`content.js`):
> - `GET /api/organizations`
> - `GET /api/organizations/{orgId}/chat_conversations?limit=50&offset=N`
> - `GET /api/organizations/{orgId}/chat_conversations/{uuid}`
>
> ChatGPT (`content_chatgpt.js`):
> - `GET /backend-api/conversations?offset=N&limit=50&order=updated`
> - `GET /backend-api/conversation/{id}`
>
> Gemini (`content_gemini.js` + `content_gemini_main.js`):
> - `POST /_/BardChatUi/data/batchexecute` (wrb.fr RPC)
>   - `MaZiqc` — 会話リスト取得
>   - `CNgdBe` — Gems リスト取得
>   - `hNvQHb` — 会話メッセージ取得（クリックイベントでキャプチャ）

## 構成

```
save-llm-chathistory/
├── chrome-extension/
│   ├── manifest.json
│   ├── content.js               # claude.ai 用コンテンツスクリプト
│   ├── content_chatgpt.js       # ChatGPT 用コンテンツスクリプト
│   ├── content_gemini.js        # Gemini 用（ISOLATED world）
│   ├── content_gemini_main.js   # Gemini 用（MAIN world・XHR インターセプト）
│   ├── popup.html
│   └── popup.js
├── server/
│   ├── server.py                # FastAPI + SQLite
│   ├── requirements.txt
│   └── chat_history.db          # 同期後に自動生成
└── README.md
```

## セットアップ

### 1. Chrome拡張機能のインストール

1. Chrome で `chrome://extensions/` を開く
2. 右上「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」→ `chrome-extension/` フォルダを選択

### 2. ローカルサーバーの起動

```bash
cd server
uv pip install -r requirements.txt   # または pip install fastapi "uvicorn[standard]"
uv run uvicorn server:app --port 8765 --reload
```

## 使い方

### Chrome拡張機能から同期

各サービスのページを開いてログインした状態で、拡張機能アイコンをクリックしてください。

| サービス | ページ | 機能 |
|----------|--------|------|
| **Claude** | `claude.ai` | JSONエクスポート / Markdownエクスポート / 差分DB同期 |
| **ChatGPT** | `chatgpt.com` | JSONエクスポート / 差分DB同期 |
| **Gemini** | `gemini.google.com` | JSONエクスポート / 差分DB同期 |

### 公式エクスポートからインポート

各サービスの公式エクスポート機能でダウンロードしたファイルをそのままインポートできます。

#### Claude
Settings → Privacy → Export data で入手した JSON ファイル:

```bash
curl -X POST http://localhost:8765/import/claude \
  -H "Content-Type: application/json" \
  -d @claude_export_YYYY-MM-DD.json
```

#### ChatGPT
Settings → Data Controls → Export data で入手した `conversations.json`:

```bash
curl -X POST http://localhost:8765/import/chatgpt \
  -H "Content-Type: application/json" \
  -d @conversations.json
```

#### Gemini
Google Takeout (takeout.google.com) → Gemini でエクスポートした JSON ファイル。
対応形式: 配列 `[{"id": ..., "messages": [...]}]` または `{"conversations": [...]}` 。
各メッセージは `{"role": "user"|"model", "text": "..."}` 形式。

```bash
curl -X POST http://localhost:8765/import/gemini \
  -H "Content-Type: application/json" \
  -d @gemini_export.json
```

## 差分同期の仕組み（Chrome拡張）

```
拡張機能                          ローカルサーバー (SQLite)
  │
  ├─ ① 会話リスト取得（各サービスの内部 API）
  ├─ ② GET /sync_state ──────────→ 保存済みの {uuid: updated_at} を返す
  ├─ ③ updated_at を比較して差分を特定
  ├─ ④ 差分のみメッセージ取得
  └─ ⑤ POST /upsert ────────────→ DB に保存
```

Gemini は内部 RPC をインターセプトする方式のため、サイドバーの会話リンクを順にクリックしてメッセージを取得します。

## サーバー API

サーバー起動後 `http://localhost:8765` で利用可能。インタラクティブドキュメント: `http://localhost:8765/docs`

| エンドポイント | 説明 |
|----------------|------|
| `GET /sync_state` | 保存済み会話の `{uuid: updated_at}` マップ |
| `POST /upsert` | 拡張機能からの会話データ一括保存 |
| `POST /import/claude` | Claude 公式エクスポート JSON のインポート |
| `POST /import/chatgpt` | ChatGPT 公式エクスポート `conversations.json` のインポート |
| `POST /import/gemini` | Google Takeout Gemini エクスポート JSON のインポート |
| `GET /conversations` | 全会話一覧（`?q=キーワード&source=claude\|chatgpt\|gemini` でフィルタ） |
| `GET /conversations/{uuid}/messages` | 特定会話のメッセージ一覧 |

## DB スキーマ

```sql
conversations (
    uuid                      TEXT PRIMARY KEY,
    name                      TEXT,             -- 会話タイトル
    summary                   TEXT,
    model                     TEXT,             -- 使用モデル名
    source                    TEXT,             -- 'claude' | 'chatgpt' | 'gemini'
    created_at                TEXT,
    updated_at                TEXT,
    last_fetched_at           TEXT,
    is_starred                INTEGER,          -- Claude: お気に入り
    is_temporary              INTEGER,          -- Claude: 一時会話
    platform                  TEXT,
    current_leaf_message_uuid TEXT
)

messages (
    uuid                TEXT PRIMARY KEY,
    conversation_uuid   TEXT,
    sender              TEXT,                   -- 'human' | 'assistant'
    text                TEXT,
    idx                 INTEGER,
    created_at          TEXT,
    updated_at          TEXT,
    attachments         TEXT,                   -- JSON
    parent_message_uuid TEXT,                   -- Claude / ChatGPT ツリー構造
    truncated           INTEGER,
    files               TEXT                    -- JSON
)
```

## DB の確認

```bash
# source 別の会話数
sqlite3 server/chat_history.db "SELECT source, COUNT(*) FROM conversations GROUP BY source;"

# 最新の会話一覧
sqlite3 server/chat_history.db "SELECT source, name, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 20;"
```

## 注意事項

- Claude のアーティファクト（コードブロック等）は内部 API の制限により取得不可（`"This block is not supported"` と表示）。完全なアーティファクトを含む場合は Claude 公式エクスポートを使用してください。
- Gemini の差分同期はサイドバーに表示されている会話のみ対象。古い会話はスクロールして読み込む必要があります。
- Google Takeout の Gemini エクスポートはメッセージ内容が省略される場合があります（Google の仕様による）。
