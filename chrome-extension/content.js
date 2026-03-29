chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req.type === "PING") {
    sendResponse({ service: "claude" });
    return;
  }

  if (req.type === "FETCH_CONVERSATIONS") {
    fetchAllConversations((progress) => {
      chrome.runtime.sendMessage({ type: "PROGRESS", ...progress }).catch(() => {});
    }, req.limit || 0, req.since || null, req.settings)
      .then((data) => {
        triggerDownload(data, req.format || "json", "claude");
        sendResponse({ ok: true, count: data.length });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (req.type === "SMART_SYNC") {
    smartSync((progress) => {
      chrome.runtime.sendMessage({ type: "PROGRESS", ...progress }).catch(() => {});
    }, req.settings)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

const SYNC_SERVER = "http://localhost:8765";
const DEFAULTS = { concurrency: 5, chunkDelay: 0, retryDelay: 3000 };

async function getOrgId() {
  const res = await fetch("/api/organizations");
  if (!res.ok) throw new Error(`組織情報の取得に失敗 (${res.status})`);
  const orgs = await res.json();
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error("組織が見つかりません");
  return orgs[0].uuid;
}

async function fetchConversationList(orgId, maxItems = 0, since = null) {
  const convList = [];
  let offset = 0;
  const pageSize = 50;
  const sinceTs = since ? new Date(since).getTime() : null;

  while (true) {
    const url = new URL(`/api/organizations/${orgId}/chat_conversations`, location.origin);
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));

    const res = await fetch(url);
    if (!res.ok) throw new Error(`会話リスト取得失敗 (${res.status})`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    if (sinceTs) {
      for (const conv of batch) {
        if (new Date(conv.updated_at).getTime() >= sinceTs) convList.push(conv);
        else return convList; // 以降は古いので打ち切り
      }
    } else {
      convList.push(...batch);
    }

    if (maxItems > 0 && convList.length >= maxItems) break;
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  return maxItems > 0 ? convList.slice(0, maxItems) : convList;
}

function resolveSettings(settings) {
  return {
    concurrency: settings?.concurrency ?? DEFAULTS.concurrency,
    chunkDelay:  settings?.chunkDelay  ?? DEFAULTS.chunkDelay,
    retryDelay:  settings?.retryDelay  ?? DEFAULTS.retryDelay,
  };
}

async function fetchFullConversations(orgId, convList, onProgress, settings) {
  const { concurrency, chunkDelay } = resolveSettings(settings);
  const full = new Array(convList.length);
  let completed = 0;

  for (let i = 0; i < convList.length; i += concurrency) {
    const chunk = convList.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (conv, j) => {
        try {
          const res = await fetch(
            `/api/organizations/${orgId}/chat_conversations/${conv.uuid}`
          );
          full[i + j] = res.ok ? await res.json() : conv;
        } catch {
          full[i + j] = conv;
        }
        completed++;
        onProgress({ current: completed, total: convList.length, title: conv.name || conv.uuid });
      })
    );
    if (chunkDelay > 0 && i + concurrency < convList.length) {
      await new Promise((r) => setTimeout(r, chunkDelay));
    }
  }

  return full;
}

async function fetchAllConversations(onProgress, limit = 0, since = null, settings) {
  const orgId = await getOrgId();
  const convList = await fetchConversationList(orgId, limit, since);
  if (convList.length === 0) return [];
  return fetchFullConversations(orgId, convList, onProgress, settings);
}

async function smartSync(onProgress, settings) {
  const orgId = await getOrgId();
  const convList = await fetchConversationList(orgId);
  if (convList.length === 0) return { total: 0, updated: 0 };

  const syncRes = await fetch(`${SYNC_SERVER}/sync_state`);
  if (!syncRes.ok) throw new Error(`同期サーバーに接続できません (${syncRes.status})`);
  const syncState = await syncRes.json();

  const needUpdate = convList.filter((conv) => {
    const stored = syncState[conv.uuid];
    if (!stored) return true;
    return conv.updated_at > stored;
  });

  if (needUpdate.length === 0) return { total: convList.length, updated: 0 };

  const fullConvs = await fetchFullConversations(orgId, needUpdate, onProgress, settings);

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

function convToMarkdown(conv, assistantLabel = "Claude") {
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
    const role = msg.sender === "human" ? "**User**" : `**${assistantLabel}**`;
    const ts = (msg.created_at || "").slice(0, 19).replace("T", " ");
    const text = typeof msg.text === "string" ? msg.text : (msg.text || "");
    lines.push(`### ${role}  <sub>${ts}</sub>`, "", text.trim(), "", "---", "");
  }
  return lines.join("\n");
}

function triggerDownload(conversations, format, service) {
  const ts = new Date().toISOString().slice(0, 10);
  const label = service === "chatgpt" ? "ChatGPT" : "Claude";
  const prefix = `${service}_export_${ts}`;
  let content, filename, mime;

  if (format === "md") {
    content = conversations.map((c) => convToMarkdown(c, label)).join("\n\n---\n\n");
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
