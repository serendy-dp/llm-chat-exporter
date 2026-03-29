// ChatGPT 内部API使用 — 動作確認: 2026-03-29

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req.type === "PING") {
    sendResponse({ service: "chatgpt" });
    return;
  }

  if (req.type === "FETCH_CONVERSATIONS") {
    fetchAllConversations((progress) => {
      chrome.runtime.sendMessage({ type: "PROGRESS", ...progress }).catch(() => {});
    }, req.limit || 0, req.since || null, req.settings)
      .then((data) => {
        triggerDownload(data, req.format || "json", "chatgpt");
        sendResponse({ ok: true, count: data.length });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (req.type === "SMART_SYNC") {
    if (_running) {
      sendResponse({ ok: false, error: "同期が既に実行中です" });
      return;
    }
    _running = true;
    _cancelled = false;
    _progress = null;
    smartSync((progress) => {
      _progress = progress;
      chrome.runtime.sendMessage({ type: "PROGRESS", ...progress }).catch(() => {});
    }, req.settings, req.limit || 0, req.since || null)
      .then((result) => { _running = false; _progress = null; sendResponse({ ok: true, ...result }); chrome.runtime.sendMessage({ type: "SYNC_COMPLETE", ...result }).catch(() => {}); })
      .catch((err) => { _running = false; _progress = null; sendResponse({ ok: false, error: err.message }); });
    return true;
  }

  if (req.type === "GET_STATUS") {
    sendResponse({ running: _running, progress: _progress });
    return;
  }

  if (req.type === "STOP_SYNC") {
    _cancelled = true;
    _running = false;
    _progress = null;
    sendResponse({ ok: true });
    return;
  }
});

const SYNC_SERVER = "http://localhost:8765";
const DEFAULTS = { concurrency: 1, chunkDelay: 2000, retryDelay: 5000 };
let _running = false;
let _cancelled = false;
let _progress = null; // ポップアップが閉じても状態を保持

function toISO(value) {
  if (!value) return null;
  // 文字列の場合はそのまま Date にパース（ISO形式）、数値の場合は Unix 秒として変換
  const d = typeof value === "string" ? new Date(value) : new Date(value * 1000);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function getAccessToken() {
  const res = await fetch("/api/auth/session");
  if (!res.ok) throw new Error(`セッション取得失敗 (${res.status})`);
  const data = await res.json();
  console.log("[GPTExporter] session keys:", Object.keys(data));
  const token = data.accessToken;
  if (!token) throw new Error("accessToken が見つかりません: " + JSON.stringify(data).slice(0, 200));
  return token;
}

async function fetchConversationList(token, maxItems = 0, since = null) {
  const convList = [];
  let offset = 0;
  const pageSize = 50;
  const sinceTs = since ? new Date(since).getTime() : null;

  while (true) {
    if (_cancelled) break;
    const url = new URL("/backend-api/conversations", location.origin);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("order", "updated");

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`会話リスト取得失敗 (${res.status})`);
    const body = await res.json();
    const batch = body.items ?? [];
    if (batch.length === 0) break;

    if (sinceTs) {
      for (const item of batch) {
        if (new Date(item.update_time).getTime() >= sinceTs) convList.push(item);
        else { offset = Infinity; break; } // 以降は古いので打ち切り
      }
      if (offset === Infinity) break;
    } else {
      convList.push(...batch);
    }

    if (maxItems > 0 && convList.length >= maxItems) break;
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  const result = maxItems > 0 ? convList.slice(0, maxItems) : convList;
  console.log("[GPTExporter] 合計:", result.length, "件");
  return result;
}

function extractMessages(conv) {
  const mapping = conv.mapping ?? {};
  const currentNode = conv.current_node;
  if (!currentNode || !mapping[currentNode]) return [];

  const path = [];
  let nodeId = currentNode;
  while (nodeId) {
    path.unshift(nodeId);
    nodeId = mapping[nodeId]?.parent ?? null;
  }

  const messages = [];
  for (const id of path) {
    const node = mapping[id];
    if (!node?.message) continue;

    const { author, content, create_time, update_time } = node.message;
    const role = author?.role;
    if (role === "system" || role === "tool") continue;

    const contentType = content?.content_type;
    let text = "";
    if (contentType === "text") {
      text = (content.parts ?? []).filter((p) => typeof p === "string").join("");
    }

    if (!text) continue;

    const sender = role === "user" ? "human" : "assistant";
    const createdAt = toISO(create_time);
    const updatedAt = toISO(update_time) ?? createdAt;

    messages.push({
      uuid: node.message.id,
      sender,
      text,
      created_at: createdAt,
      updated_at: updatedAt,
    });
  }

  return messages;
}

function normalizeConversation(item, fullConv) {
  const conv = fullConv ?? item;
  const updatedAt = toISO(item.update_time);
  return {
    uuid: item.id,
    name: item.title ?? null,
    model: conv.model_slug ?? null,
    source: "chatgpt",
    created_at: toISO(conv.create_time),
    updated_at: updatedAt,
    chat_messages: extractMessages(conv),
  };
}

function resolveSettings(settings) {
  return {
    concurrency: settings?.concurrency ?? DEFAULTS.concurrency,
    chunkDelay:  settings?.chunkDelay  ?? DEFAULTS.chunkDelay,
    retryDelay:  settings?.retryDelay  ?? DEFAULTS.retryDelay,
  };
}

async function fetchOneConversation(item, token) {
  try {
    const res = await fetch(`/backend-api/conversation/${item.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 429) {
      console.log(`[GPTExporter] 429 rate limit — stopping`);
      _cancelled = true;
      return item;
    }
    return res.ok ? await res.json() : item;
  } catch {
    return item;
  }
}

async function fetchFullConversations(convList, token, onProgress, settings) {
  const { concurrency, chunkDelay } = resolveSettings(settings);
  const full = [];
  let completed = 0;

  for (let i = 0; i < convList.length; i += concurrency) {
    if (_cancelled) break;
    const chunk = convList.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (item) => {
        const conv = await fetchOneConversation(item, token);
        completed++;
        onProgress({ current: completed, total: convList.length, title: item.title || item.id });
        return normalizeConversation(item, conv);
      })
    );
    full.push(...results);
    if (i + concurrency < convList.length) {
      await new Promise((r) => setTimeout(r, chunkDelay));
    }
  }

  return full;
}

async function fetchAllConversations(onProgress, limit = 0, since = null, settings) {
  const token = await getAccessToken();
  const convList = await fetchConversationList(token, limit, since);
  if (convList.length === 0) return [];
  return fetchFullConversations(convList, token, onProgress, settings);
}

async function smartSync(onProgress, settings, limit = 0, since = null) {
  const token = await getAccessToken();
  const convList = await fetchConversationList(token, limit, since);
  if (convList.length === 0) return { total: 0, updated: 0 };

  const syncRes = await fetch(`${SYNC_SERVER}/sync_state`);
  if (!syncRes.ok) throw new Error(`同期サーバーに接続できません (${syncRes.status})`);
  const syncState = await syncRes.json();

  const needUpdate = convList.filter((item) => {
    const itemUpdatedAt = toISO(item.update_time);
    const stored = syncState[item.id];
    if (!stored) return true;
    return itemUpdatedAt > stored;
  });

  if (needUpdate.length === 0) return { total: convList.length, updated: 0 };

  const fullConvs = await fetchFullConversations(needUpdate, token, onProgress, settings);

  if (fullConvs.length === 0) return { total: convList.length, updated: 0 };

  const upsertRes = await fetch(`${SYNC_SERVER}/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversations: fullConvs }),
  });
  if (!upsertRes.ok) throw new Error(`同期サーバーへの保存に失敗 (${upsertRes.status})`);
  const { upserted } = await upsertRes.json();

  return { total: convList.length, updated: upserted };
}

// ── ダウンロード ──────────────────────────────────────────

function convToMarkdown(conv) {
  const title = conv.name || conv.uuid || "untitled";
  const lines = [
    `# ${title}`,
    "",
    `_UUID: ${conv.uuid || ""}  |  Created: ${(conv.created_at || "").slice(0, 10)}_`,
    "",
    "---",
    "",
  ];
  for (const msg of (conv.chat_messages || [])) {
    const role = msg.sender === "human" ? "**User**" : "**ChatGPT**";
    const ts = (msg.created_at || "").slice(0, 19).replace("T", " ");
    lines.push(`### ${role}  <sub>${ts}</sub>`, "", (msg.text || "").trim(), "", "---", "");
  }
  return lines.join("\n");
}

function triggerDownload(conversations, format, service) {
  const ts = new Date().toISOString().slice(0, 10);
  const prefix = `${service}_export_${ts}`;
  let content, filename, mime;

  if (format === "md") {
    content = conversations.map(convToMarkdown).join("\n\n---\n\n");
    filename = `${prefix}.md`;
    mime = "text/markdown";
  } else {
    content = JSON.stringify(conversations, null, 2);
    filename = `${prefix}.json`;
    mime = "application/json";
  }

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
