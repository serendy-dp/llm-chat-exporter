import sqlite3
import json
from datetime import datetime, timezone
from pathlib import Path
from contextlib import contextmanager

from fastapi import FastAPI, Query, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

DB_PATH = Path(__file__).parent / "chat_history.db"

app = FastAPI(title="Claude Chat History Sync")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    uuid                     TEXT PRIMARY KEY,
    name                     TEXT,
    summary                  TEXT,
    model                    TEXT,
    created_at               TEXT,
    updated_at               TEXT,
    last_fetched_at          TEXT,
    source                   TEXT DEFAULT 'claude',
    -- Claude 公式エクスポート拡張フィールド
    is_starred               INTEGER DEFAULT 0,
    is_temporary             INTEGER DEFAULT 0,
    platform                 TEXT,
    current_leaf_message_uuid TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    uuid                TEXT PRIMARY KEY,
    conversation_uuid   TEXT NOT NULL,
    sender              TEXT,
    text                TEXT,
    idx                 INTEGER,
    created_at          TEXT,
    updated_at          TEXT,
    attachments         TEXT,   -- JSON
    -- 追加フィールド
    parent_message_uuid TEXT,
    truncated           INTEGER DEFAULT 0,
    files               TEXT,   -- JSON (Claude files / ChatGPT multimodal parts)
    FOREIGN KEY (conversation_uuid) REFERENCES conversations(uuid)
);

CREATE INDEX IF NOT EXISTS idx_messages_conv    ON messages(conversation_uuid);
CREATE INDEX IF NOT EXISTS idx_conv_source      ON conversations(source);
CREATE INDEX IF NOT EXISTS idx_conv_updated     ON conversations(updated_at DESC);
"""

# 新規追加カラム (既存DBへのALTER TABLE用)
_ALTER_COLUMNS = [
    ("conversations", "source",                    "TEXT DEFAULT 'claude'"),
    ("conversations", "is_starred",                "INTEGER DEFAULT 0"),
    ("conversations", "is_temporary",              "INTEGER DEFAULT 0"),
    ("conversations", "platform",                  "TEXT"),
    ("conversations", "current_leaf_message_uuid", "TEXT"),
    ("messages",      "parent_message_uuid",       "TEXT"),
    ("messages",      "truncated",                 "INTEGER DEFAULT 0"),
    ("messages",      "files",                     "TEXT"),
]


def normalize_id(uid: str | None) -> str | None:
    """Gemini conversation IDの c_ prefix を除去して統一する"""
    if uid and uid.startswith("c_"):
        return uid[2:]
    return uid


def init_db():
    with get_db() as conn:
        conn.executescript(SCHEMA)
        for table, col, typedef in _ALTER_COLUMNS:
            try:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typedef}")
                conn.commit()
            except Exception:
                pass
    migrate_normalize_ids()


def migrate_normalize_ids():
    """既存DBの c_ prefix付き重複レコードを正規化する"""
    with get_db() as conn:
        conn.execute("PRAGMA foreign_keys=OFF")

        # c_X と X が両方存在 → c_X 側を削除
        dups = conn.execute("""
            SELECT uuid FROM conversations
            WHERE uuid LIKE 'c_%'
              AND SUBSTR(uuid, 3) IN (SELECT uuid FROM conversations)
        """).fetchall()
        for row in dups:
            c_uuid = row["uuid"]
            conn.execute("DELETE FROM messages WHERE conversation_uuid = ?", (c_uuid,))
            conn.execute("DELETE FROM conversations WHERE uuid = ?", (c_uuid,))

        # c_X のみ存在 → uuid を strip
        solo = conn.execute("""
            SELECT uuid FROM conversations
            WHERE uuid LIKE 'c_%'
              AND SUBSTR(uuid, 3) NOT IN (SELECT uuid FROM conversations)
        """).fetchall()
        for row in solo:
            c_uuid = row["uuid"]
            bare = c_uuid[2:]
            conn.execute("UPDATE messages SET conversation_uuid = ? WHERE conversation_uuid = ?", (bare, c_uuid))
            conn.execute("UPDATE conversations SET uuid = ? WHERE uuid = ?", (bare, c_uuid))

        conn.execute("PRAGMA foreign_keys=ON")
        conn.commit()


@contextmanager
def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


@app.on_event("startup")
def on_startup():
    init_db()


# ---------------------------------------------------------------------------
# Chrome拡張 sync エンドポイント
# ---------------------------------------------------------------------------

@app.get("/sync_state")
def sync_state():
    with get_db() as conn:
        # メッセージあり → last_fetched_at で比較（取得後にサービス側でtimestampが
        #   更新されてもループしないよう last_fetched_at を基準にする）
        # メッセージなし → NULL を返す（初回メッセージ取得の対象にする）
        rows = conn.execute("""
            SELECT c.uuid,
                   CASE WHEN COUNT(m.uuid) > 0
                        THEN COALESCE(c.last_fetched_at, c.updated_at)
                        ELSE NULL
                   END as ts
            FROM conversations c
            LEFT JOIN messages m ON c.uuid = m.conversation_uuid
            GROUP BY c.uuid
        """).fetchall()
    return {row["uuid"]: row["ts"] for row in rows}


class UpsertPayload(BaseModel):
    conversations: list[dict]


@app.post("/upsert")
def upsert(payload: UpsertPayload):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    count = 0

    with get_db() as conn:
        for conv in payload.conversations:
            conv_uuid = normalize_id(conv.get("uuid"))

            conn.execute(
                """INSERT INTO conversations
                       (uuid, name, summary, model, created_at, updated_at, last_fetched_at, source)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(uuid) DO UPDATE SET
                     name=excluded.name,
                     summary=excluded.summary,
                     model=excluded.model,
                     created_at=excluded.created_at,
                     updated_at=excluded.updated_at,
                     last_fetched_at=excluded.last_fetched_at,
                     source=excluded.source""",
                (
                    conv_uuid,
                    conv.get("name"),
                    conv.get("summary"),
                    conv.get("model"),
                    conv.get("created_at"),
                    conv.get("updated_at"),
                    now,
                    conv.get("source", "claude"),
                ),
            )

            conn.execute("DELETE FROM messages WHERE conversation_uuid = ?", (conv_uuid,))

            for idx, msg in enumerate(conv.get("chat_messages", [])):
                text = ""
                content = msg.get("content", msg.get("text", ""))
                if isinstance(content, list):
                    text = "\n".join(
                        p.get("text", "") if isinstance(p, dict) else str(p)
                        for p in content
                    )
                else:
                    text = str(content)

                attachments = msg.get("attachments")
                if attachments is not None:
                    attachments = json.dumps(attachments, ensure_ascii=False)

                msg_uuid = msg.get("uuid") or f"{conv_uuid}_{idx}"

                conn.execute(
                    """INSERT INTO messages
                           (uuid, conversation_uuid, sender, text, idx, created_at, updated_at, attachments)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(uuid) DO UPDATE SET
                         sender=excluded.sender,
                         text=excluded.text,
                         idx=excluded.idx,
                         created_at=excluded.created_at,
                         updated_at=excluded.updated_at,
                         attachments=excluded.attachments""",
                    (
                        msg_uuid,
                        conv_uuid,
                        msg.get("sender"),
                        text,
                        idx,
                        msg.get("created_at"),
                        msg.get("updated_at"),
                        attachments,
                    ),
                )

            count += 1

    return {"upserted": count}


# ---------------------------------------------------------------------------
# 公式エクスポート import エンドポイント
# ---------------------------------------------------------------------------

def _ts(unix_float: float | None) -> str | None:
    """Unix timestamp (float) → ISO8601"""
    if unix_float is None:
        return None
    return datetime.fromtimestamp(unix_float, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _upsert_conv(conn, conv_uuid: str, name: str | None, model: str | None,
                 created_at: str | None, updated_at: str | None, source: str,
                 is_starred: int = 0, is_temporary: int = 0,
                 platform: str | None = None,
                 current_leaf_message_uuid: str | None = None) -> None:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn.execute(
        """INSERT INTO conversations
               (uuid, name, model, created_at, updated_at, last_fetched_at, source,
                is_starred, is_temporary, platform, current_leaf_message_uuid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uuid) DO UPDATE SET
             name=excluded.name,
             model=excluded.model,
             created_at=excluded.created_at,
             updated_at=excluded.updated_at,
             last_fetched_at=excluded.last_fetched_at,
             source=excluded.source,
             is_starred=excluded.is_starred,
             is_temporary=excluded.is_temporary,
             platform=excluded.platform,
             current_leaf_message_uuid=excluded.current_leaf_message_uuid""",
        (conv_uuid, name, model, created_at, updated_at, now, source,
         is_starred, is_temporary, platform, current_leaf_message_uuid),
    )


def _upsert_msg(conn, msg_uuid: str, conv_uuid: str, sender: str, text: str,
                idx: int, created_at: str | None, updated_at: str | None,
                attachments: str | None = None, parent_message_uuid: str | None = None,
                truncated: int = 0, files: str | None = None) -> None:
    conn.execute(
        """INSERT INTO messages
               (uuid, conversation_uuid, sender, text, idx, created_at, updated_at,
                attachments, parent_message_uuid, truncated, files)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uuid) DO UPDATE SET
             sender=excluded.sender,
             text=excluded.text,
             idx=excluded.idx,
             created_at=excluded.created_at,
             updated_at=excluded.updated_at,
             attachments=excluded.attachments,
             parent_message_uuid=excluded.parent_message_uuid,
             truncated=excluded.truncated,
             files=excluded.files""",
        (msg_uuid, conv_uuid, sender, text, idx, created_at, updated_at,
         attachments, parent_message_uuid, truncated, files),
    )


@app.post("/import/claude")
async def import_claude(request: Request):
    """Claude 公式エクスポート JSON (配列) を一括インポート"""
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(data, list):
        raise HTTPException(status_code=400, detail="Expected a JSON array")

    imported = skipped = 0
    with get_db() as conn:
        for conv in data:
            conv_uuid = conv.get("uuid")
            if not conv_uuid:
                skipped += 1
                continue

            _upsert_conv(
                conn,
                conv_uuid=conv_uuid,
                name=conv.get("name"),
                model=conv.get("model"),
                created_at=conv.get("created_at"),
                updated_at=conv.get("updated_at"),
                source="claude",
                is_starred=int(bool(conv.get("is_starred", False))),
                is_temporary=int(bool(conv.get("is_temporary", False))),
                platform=conv.get("platform"),
                current_leaf_message_uuid=conv.get("current_leaf_message_uuid"),
            )

            conn.execute("DELETE FROM messages WHERE conversation_uuid = ?", (conv_uuid,))

            for msg in conv.get("chat_messages", []):
                files_raw = msg.get("files")
                attachments_raw = msg.get("attachments")
                _upsert_msg(
                    conn,
                    msg_uuid=msg.get("uuid") or f"{conv_uuid}_{msg.get('index', 0)}",
                    conv_uuid=conv_uuid,
                    sender=msg.get("sender", ""),
                    text=msg.get("text", ""),
                    idx=msg.get("index", 0),
                    created_at=msg.get("created_at"),
                    updated_at=msg.get("updated_at"),
                    attachments=json.dumps(attachments_raw, ensure_ascii=False) if attachments_raw else None,
                    parent_message_uuid=msg.get("parent_message_uuid"),
                    truncated=int(bool(msg.get("truncated", False))),
                    files=json.dumps(files_raw, ensure_ascii=False) if files_raw else None,
                )

            imported += 1

    return {"imported": imported, "skipped": skipped}


def _chatgpt_walk_branch(mapping: dict, current_node: str) -> list[dict]:
    """current_node から親方向へ遡り、アクティブブランチのメッセージを返す (古い順)"""
    branch: list[dict] = []
    node_id: str | None = current_node
    visited: set[str] = set()

    while node_id and node_id not in visited:
        visited.add(node_id)
        node = mapping.get(node_id)
        if not node:
            break

        msg = node.get("message")
        if msg:
            role = (msg.get("author") or {}).get("role", "")
            content = msg.get("content") or {}
            content_type = content.get("content_type", "")

            if role in ("user", "assistant"):
                text = ""
                if content_type == "text":
                    parts = content.get("parts") or []
                    text = "\n".join(str(p) for p in parts if p and isinstance(p, str))
                elif content_type == "multimodal_text":
                    parts = content.get("parts") or []
                    text = "\n".join(str(p) for p in parts if isinstance(p, str) and p)

                if text.strip():
                    create_time = msg.get("create_time")
                    update_time = msg.get("update_time")
                    model_slug = (msg.get("metadata") or {}).get("model_slug")
                    branch.append({
                        "uuid": msg.get("id"),
                        "sender": "human" if role == "user" else "assistant",
                        "text": text.strip(),
                        "created_at": _ts(create_time),
                        "updated_at": _ts(update_time),
                        "parent_message_uuid": node.get("parent"),
                        "model_slug": model_slug,
                    })

        node_id = node.get("parent")

    branch.reverse()  # root → leaf の順に
    return branch


def _parse_gemini_conv(conv: dict) -> dict | None:
    """Gemini Takeout の単一会話オブジェクトを正規化して返す"""
    conv_id = conv.get("id") or conv.get("conversationId")
    if not conv_id:
        return None

    created_raw = conv.get("createdTime") or conv.get("create_time")
    updated_raw = conv.get("lastModifiedTime") or conv.get("update_time")

    def parse_ts(v) -> str | None:
        if not v:
            return None
        if isinstance(v, (int, float)):
            return _ts(v)
        if isinstance(v, str):
            return v  # already ISO
        if isinstance(v, dict):
            sec = v.get("seconds") or v.get("nanos", 0) / 1e9
            return _ts(float(sec)) if sec else None
        return None

    messages_raw = conv.get("messages") or conv.get("turns") or []
    messages = []
    for i, msg in enumerate(messages_raw):
        role = msg.get("role") or msg.get("type", "")
        # "user" → human, "model"/"AI"/"assistant" → assistant
        if role.lower() in ("user", "human"):
            sender = "human"
        elif role.lower() in ("model", "ai", "assistant"):
            sender = "assistant"
        else:
            continue

        text = msg.get("text") or msg.get("content") or ""
        if not text.strip():
            continue

        msg_id = msg.get("id") or f"{conv_id}_{i}"
        msg_ts = parse_ts(msg.get("createTime") or msg.get("timestamp") or msg.get("create_time"))
        messages.append({
            "uuid": msg_id,
            "sender": sender,
            "text": text.strip(),
            "idx": i,
            "created_at": msg_ts,
        })

    return {
        "id": conv_id,
        "title": conv.get("title") or conv.get("name"),
        "created_at": parse_ts(created_raw),
        "updated_at": parse_ts(updated_raw),
        "messages": messages,
    }


@app.post("/import/gemini")
async def import_gemini(request: Request):
    """Google Takeout Gemini エクスポート JSON を一括インポート。

    対応形式:
      - 配列: [ { "id": ..., "messages": [...] }, ... ]
      - オブジェクト: { "conversations": [ ... ] }
      各会話の messages は { "role": "user"|"model", "text": "..." } 形式。
    """
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    # 配列 or { conversations: [...] } に正規化
    if isinstance(data, dict):
        data = data.get("conversations") or []
    if not isinstance(data, list):
        raise HTTPException(status_code=400, detail="Expected JSON array or {conversations:[...]}")

    imported = skipped = 0
    with get_db() as conn:
        for raw_conv in data:
            conv = _parse_gemini_conv(raw_conv)
            if not conv:
                skipped += 1
                continue

            _upsert_conv(
                conn,
                conv_uuid=conv["id"],
                name=conv["title"],
                model=None,
                created_at=conv["created_at"],
                updated_at=conv["updated_at"],
                source="gemini",
            )

            conn.execute("DELETE FROM messages WHERE conversation_uuid = ?", (conv["id"],))

            for msg in conv["messages"]:
                _upsert_msg(
                    conn,
                    msg_uuid=msg["uuid"],
                    conv_uuid=conv["id"],
                    sender=msg["sender"],
                    text=msg["text"],
                    idx=msg["idx"],
                    created_at=msg["created_at"],
                    updated_at=None,
                )

            imported += 1

    return {"imported": imported, "skipped": skipped}


@app.post("/import/chatgpt")
async def import_chatgpt(request: Request):
    """ChatGPT 公式エクスポート conversations.json を一括インポート"""
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(data, list):
        raise HTTPException(status_code=400, detail="Expected a JSON array")

    imported = skipped = 0
    with get_db() as conn:
        for conv in data:
            conv_id = conv.get("id")
            if not conv_id:
                skipped += 1
                continue

            mapping = conv.get("mapping") or {}
            current_node = conv.get("current_node")
            messages = _chatgpt_walk_branch(mapping, current_node) if current_node else []

            # 会話レベルのモデルはアシスタントメッセージの最後のmodel_slugを使う
            model = next(
                (m["model_slug"] for m in reversed(messages)
                 if m.get("model_slug") and m["sender"] == "assistant"),
                None,
            )

            _upsert_conv(
                conn,
                conv_uuid=conv_id,
                name=conv.get("title"),
                model=model,
                created_at=_ts(conv.get("create_time")),
                updated_at=_ts(conv.get("update_time")),
                source="chatgpt",
            )

            conn.execute("DELETE FROM messages WHERE conversation_uuid = ?", (conv_id,))

            for idx, msg in enumerate(messages):
                _upsert_msg(
                    conn,
                    msg_uuid=msg["uuid"] or f"{conv_id}_{idx}",
                    conv_uuid=conv_id,
                    sender=msg["sender"],
                    text=msg["text"],
                    idx=idx,
                    created_at=msg["created_at"],
                    updated_at=msg["updated_at"],
                    parent_message_uuid=msg.get("parent_message_uuid"),
                )

            imported += 1

    return {"imported": imported, "skipped": skipped}


# ---------------------------------------------------------------------------
# 検索・取得エンドポイント
# ---------------------------------------------------------------------------

@app.get("/conversations")
def list_conversations(q: str = Query(default=None), source: str = Query(default=None)):
    with get_db() as conn:
        conditions = []
        params = []
        if q:
            conditions.append("name LIKE ?")
            params.append(f"%{q}%")
        if source:
            conditions.append("source = ?")
            params.append(source)
        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        rows = conn.execute(
            f"SELECT * FROM conversations {where} ORDER BY updated_at DESC",
            params,
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/conversations/{uuid}/messages")
def get_messages(uuid: str):
    normalized = normalize_id(uuid)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_uuid = ? ORDER BY idx",
            (normalized,),
        ).fetchall()
    return [dict(row) for row in rows]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="0.0.0.0", port=8765, reload=True)
