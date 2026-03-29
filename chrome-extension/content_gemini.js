// Gemini 内部 batchexecute API 使用 — 動作確認: 2026-03-29
// NOTE: Google 内部 API のため更新により動作しなくなる可能性があります

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req.type === "PING") {
    sendResponse({ service: "gemini" });
    return;
  }

  if (req.type === "FETCH_CONVERSATIONS") {
    fetchAllConversations(
      (p) => chrome.runtime.sendMessage({ type: "PROGRESS", ...p }).catch(() => {}),
      req.limit || 0, req.since || null, req.settings
    ).then((data) => {
      triggerDownload(data, req.format || "json", "gemini");
      sendResponse({ ok: true, count: data.length });
    }).catch((err) => sendResponse({ ok: false, error: err.message }));
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
    smartSync((p) => {
      _progress = p;
      chrome.runtime.sendMessage({ type: "PROGRESS", ...p }).catch(() => {});
    }, req.settings, req.limit || 0, req.since || null)
      .then((result) => { _running = false; _progress = null; sendResponse({ ok: true, ...result }); })
      .catch((err)   => { _running = false; _progress = null; sendResponse({ ok: false, error: err.message }); });
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
const DEFAULTS = { concurrency: 1, chunkDelay: 2500, retryDelay: 5000 };
let _running = false;
let _cancelled = false;
let _progress = null;

// ── ユーザーインデックス検出 ──────────────────────────────────

function getUserIdx() {
  const m = location.href.match(/gemini\.google\.com\/u\/(\d+)/);
  const idx = m ? m[1] : "0";
  console.log("[GeminiExporter] user index:", idx);
  return idx;
}

// ── MAINワールド (content_gemini_main.js) との通信 ───────────
// MAINワールドが傍受した batchexecute レスポンスをここで受け取る

const _capturedResponses = [];
let _capturedRequests = [];

window.addEventListener("__gemini_batch_resp__", (e) => {
  if (e.detail?.text) _capturedResponses.push(e.detail.text);
});

async function getRequestLogFromMainWorld() {
  return new Promise((resolve) => {
    const h = (e) => resolve(e.detail?.requests || []);
    window.addEventListener("__gemini_log__", h, { once: true });
    window.dispatchEvent(new Event("__gemini_req_log__"));
    setTimeout(() => { window.removeEventListener("__gemini_log__", h); resolve([]); }, 500);
  });
}

// デバッグ用: コンソールから window.__geminiDebug() で呼び出し可能
window.__geminiDebug = async function () {
  console.log("=== [GeminiDebug] captured responses:", _capturedResponses.length, "===");
  const requests = await getRequestLogFromMainWorld();
  console.log("[GeminiDebug] intercepted requests:", requests.length);
  requests.forEach((r, i) => console.log(`  req[${i}] rpcid=${r.rpcid}`, r.payload));

  _capturedResponses.forEach((text, i) => {
    const clean = text.replace(/^\)\]\}'\n?/, "").trim();
    for (const line of clean.split("\n")) {
      const l = line.trim();
      if (!l || /^\d+$/.test(l)) continue;
      try {
        const arr = JSON.parse(l);
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          if (Array.isArray(item) && item[0] === "wrb.fr") {
            const rpcid = item[1];
            const raw = item[2];
            if (typeof raw === "string" && raw.length > 4) {
              try {
                const data = JSON.parse(raw);
                console.log(`  resp[${i}] wrb.fr ${rpcid} (1000 chars):`, JSON.stringify(data).slice(0, 1000));
              } catch {
                console.log(`  resp[${i}] wrb.fr ${rpcid} decode failed, raw (200 chars):`, raw.slice(0, 200));
              }
            } else {
              console.log(`  resp[${i}] wrb.fr ${rpcid} item[2]=`, raw);
            }
          }
        }
      } catch {}
    }
  });
  console.log("=== [GeminiDebug] end ===");
};

async function getAtFromMainWorld(timeoutMs = 6000) {
  // すでにキャプチャされているならすぐ返す
  const quick = await new Promise((resolve) => {
    const h = (e) => resolve(e.detail?.at || "");
    window.addEventListener("__gemini_at__", h, { once: true });
    window.dispatchEvent(new Event("__gemini_req_at__"));
    setTimeout(() => { window.removeEventListener("__gemini_at__", h); resolve(""); }, 500);
  });
  if (quick) return quick;

  // まだなければページの最初の batchexecute を待つ
  console.log("[GeminiExporter] AT token 待機中 (最大", timeoutMs / 1000, "秒)...");
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      window.dispatchEvent(new Event("__gemini_req_at__"));
    }, 500);
    const h = (e) => {
      if (e.detail?.at) { clearInterval(poll); resolve(e.detail.at); }
    };
    window.addEventListener("__gemini_at__", h);
    setTimeout(() => {
      clearInterval(poll);
      window.removeEventListener("__gemini_at__", h);
      resolve("");
    }, timeoutMs);
  });
}

// ── ページトークン取得 ────────────────────────────────────────

async function getPageTokens() {
  const idx = getUserIdx();

  // AT token は MAINワールドから取得 (ページ自身のリクエストから抜き出す)
  const at = await getAtFromMainWorld();

  // BL は HTML フェッチから取得 (CSR でも HTML ヘッダーには存在する場合あり)
  let bl = "", fsid = "";
  try {
    const res = await fetch(`https://gemini.google.com/u/${idx}/app`, { credentials: "include" });
    const html = await res.text();
    bl   = html.match(/"cfb2h":"([^"]+)"/)?.[1]
        || html.match(/boq_assistant-bard-web-server_[0-9._p]+/)?.[0]
        || "";
    fsid = html.match(/"FdrFJe":"([^"]+)"/)?.[1] || "";
  } catch {}

  console.log("[GeminiExporter] tokens:", {
    idx,
    at: at ? at.slice(0, 8) + "..." : "(none — ページをリロードしてください)",
    bl: bl || "(none)",
  });

  if (!at) {
    throw new Error(
      "AT token が取得できませんでした。\n" +
      "Gemini のページをリロードして少し待ってから再度 Export してください。"
    );
  }

  return { at, bl, fsid, idx };
}

// ── batchexecute 共通関数 ─────────────────────────────────────

async function callBatchExecute(rpcid, payload, tokens, sourcePath) {
  const idx = tokens.idx ?? "0";
  const sp = sourcePath || `/u/${idx}/app`;
  const params = new URLSearchParams({
    rpcids: rpcid,
    "source-path": sp,
    hl: (navigator.language || "en").split("-")[0],
    rt: "c",
  });
  if (tokens.bl)   params.set("bl",    tokens.bl);
  if (tokens.fsid) params.set("f.sid", tokens.fsid);

  const fReq = JSON.stringify([[[rpcid, JSON.stringify(payload), null, "generic"]]]);
  const formBody = new URLSearchParams({ "f.req": fReq });
  if (tokens.at) formBody.set("at", tokens.at);

  const res = await fetch(
    `https://gemini.google.com/u/${idx}/_/BardChatUi/data/batchexecute?${params}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      credentials: "include",
    }
  );

  if (!res.ok) throw new Error(`batchexecute ${rpcid} エラー (${res.status})`);
  const text = await res.text();
  console.log(`[GeminiExporter] ${rpcid} raw response (2000 chars):\n${text.slice(0, 2000)}`);
  return text;
}

function parseBatchResponse(text, targetRpcid) {
  // )]}'  プレフィックスを除去
  const clean = text.replace(/^\)\]\}'\n?/, "").trim();

  // レスポンス内の全 rpcid を収集 (デバッグ用)
  const foundRpcids = [];

  const tryExtract = (arr) => {
    if (!Array.isArray(arr)) return null;
    for (const item of arr) {
      if (Array.isArray(item) && item[0] === "wrb.fr") {
        foundRpcids.push(item[1]);
        if (item[1] === targetRpcid && item[2]) {
          return JSON.parse(item[2]);
        }
      }
    }
    return null;
  };

  // パターン1: 全体が JSON 配列
  try {
    const outer = JSON.parse(clean);
    const result = tryExtract(outer);
    if (result !== null) return result;
  } catch {}

  // パターン2: 数字のチャンクサイズで区切られた chunked 形式
  // 例: "42\n[...]\n\n38\n[...]\n"
  const chunkPattern = /^\d+\r?\n(\[[\s\S]*?\])\r?\n/gm;
  let cm;
  while ((cm = chunkPattern.exec(clean)) !== null) {
    try {
      const arr = JSON.parse(cm[1]);
      const result = tryExtract(arr);
      if (result !== null) return result;
    } catch {}
  }

  // パターン3: 行ごと
  for (const line of clean.split("\n")) {
    const l = line.trim();
    if (!l || /^\d+$/.test(l)) continue;
    try {
      const arr = JSON.parse(l);
      const result = tryExtract(arr);
      if (result !== null) return result;
    } catch {}
  }

  console.error(`[GeminiExporter] 見つかった rpcids: [${foundRpcids.join(", ")}]`);
  console.error(`[GeminiExporter] clean response (3000 chars):\n${clean.slice(0, 3000)}`);
  throw new Error(`${targetRpcid} の応答データが見つかりません (found: ${foundRpcids.join(", ") || "none"})`);
}

// ── 会話リスト取得 ────────────────────────────────────────────
// 優先順位:
//   1. MAINワールドが傍受したbatchexecuteレスポンスから
//   2. DOMサイドバーのリンクから
//   3. 現在のURLから

async function fetchConversationList(tokens, maxItems = 0, since = null) {
  const sinceTs = since ? new Date(since).getTime() : null;
  const seen = new Set();
  const convList = [];

  const addConv = (id, title, updated_at = null) => {
    if (seen.has(id)) return;
    seen.add(id);
    convList.push({ id, title: title?.slice(0, 200) || null, updated_at });
  };

  // ── 1. キャプチャ済みbatchexecuteレスポンスから会話IDを探す ──
  // batchexecute の "wrb.fr" エントリは item[2] が JSON文字列として二重エンコードされている
  // 会話リストに無関係な既知のrpcidはスキップする
  const SKIP_FOR_CONV = new Set(["otAQ7b", "ESY5D", "aPya6c", "o30O0e", "ku4Jyf", "GPRiHf"]);
  console.log(`[GeminiExporter] キャプチャ済みレスポンス: ${_capturedResponses.length} 件`);
  for (const text of _capturedResponses) {
    const clean = text.replace(/^\)\]\}'\n?/, "").trim();
    for (const line of clean.split("\n")) {
      const l = line.trim();
      if (!l || /^\d+$/.test(l)) continue;
      try {
        const arr = JSON.parse(l);
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          if (Array.isArray(item) && item[0] === "wrb.fr" && typeof item[2] === "string" && item[2].length > 4) {
            if (SKIP_FOR_CONV.has(item[1])) continue;
            try {
              const data = JSON.parse(item[2]);
              console.log(`[GeminiExporter] wrb.fr ${item[1]} decoded (200 chars):`, JSON.stringify(data).slice(0, 200));
              searchConvIds(data, addConv, 0);
            } catch {}
          }
        }
      } catch {}
    }
  }
  console.log(`[GeminiExporter] キャプチャから ${convList.length} 件`);

  // ── 2. DOMサイドバーのリンクから ────────────────────────
  // c_ プレフィックス付き (MaZiqc) と短い hex (CNgdBe/Gems) の両方に対応
  const CONV_ID_RE = /\/app\/(c_[0-9a-f]{12,}|[0-9a-f]{12,32})(?=[^0-9a-f/]|$)/;
  document.querySelectorAll('a[href*="/app/"]').forEach((link) => {
    const m = link.href.match(CONV_ID_RE);
    if (!m) return;
    const raw = link.textContent?.trim() || "";
    const title = raw.split(/\n/)[0].trim() || null;
    addConv(m[1], title);
  });
  console.log(`[GeminiExporter] DOM+キャプチャ合計 ${convList.length} 件`);

  // ── 3. 現在URLから ───────────────────────────────────────
  if (convList.length === 0) {
    const m = location.href.match(CONV_ID_RE);
    if (m) addConv(m[1], document.title || null);
  }

  if (convList.length === 0) {
    throw new Error(
      "会話が見つかりません。gemini.google.com のメインページを開いてください。"
    );
  }

  const filtered = sinceTs
    ? convList.filter((c) => !c.updated_at || new Date(c.updated_at).getTime() >= sinceTs)
    : convList;

  return maxItems > 0 ? filtered.slice(0, maxItems) : filtered;
}


// batchexecute レスポンス内の配列を再帰探索して会話IDを見つける
// 対応フォーマット:
//   CNgdBe (Gems): ["shortHexId", ["title",...], ...]
//   MaZiqc (会話): ["c_hexId", "title", true, null, "", [unix_sec, ns], ...]
function searchConvIds(data, addFn, depth) {
  if (depth > 10 || !Array.isArray(data)) return;
  for (const item of data) {
    if (!Array.isArray(item)) continue;
    const id = item[0];
    if (typeof id === "string" && (/^[0-9a-f]{12,32}$/.test(id) || /^c_[0-9a-f]{12,}$/.test(id))) {
      // otAQ7b の偽陽性を除外: item[1] と item[2] が両方とも文字列 = モード設定
      if (typeof item[1] === "string" && typeof item[2] === "string") continue;

      const title = resolveText(item[1]);
      const updated_at = extractTimestamp(item);
      addFn(id, title, updated_at);
    } else {
      searchConvIds(item, addFn, depth + 1);
    }
  }
}

// アイテムからタイムスタンプを抽出 (MaZiqc: item[5]=[unix_sec,ns], 他: item[2]/item[3] が数値)
function extractTimestamp(item) {
  // MaZiqc フォーマット: item[5] = [unix秒, ナノ秒]
  if (Array.isArray(item[5]) && typeof item[5][0] === "number" && item[5][0] > 1_000_000_000) {
    return new Date(item[5][0] * 1000).toISOString();
  }
  for (let i = 2; i <= 4; i++) {
    const v = item[i];
    if (typeof v === "number" && v > 1_000_000_000) return new Date(v * 1000).toISOString();
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v;
  }
  return null;
}

function resolveText(v) {
  if (typeof v === "string") return v || null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = resolveText(x);
      if (t) return t;
    }
  }
  return null;
}

// ── 個別会話の詳細取得 ────────────────────────────────────────

// キャプチャ済みレスポンスから特定会話のメッセージを探す
const SKIP_FOR_MSG = new Set(["otAQ7b", "ESY5D", "aPya6c", "o30O0e", "ku4Jyf", "MaZiqc", "CNgdBe"]);

function findMessagesInCaptured(convId) {
  // c_ prefix を除いたIDでも検索する (MaZiqc は c_ID 形式)
  const bareId = convId.startsWith("c_") ? convId.slice(2) : convId;
  for (const text of _capturedResponses) {
    const clean = text.replace(/^\)\]\}'\n?/, "").trim();
    for (const line of clean.split("\n")) {
      const l = line.trim();
      if (!l || /^\d+$/.test(l)) continue;
      try {
        const arr = JSON.parse(l);
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          if (Array.isArray(item) && item[0] === "wrb.fr" && typeof item[2] === "string" && item[2].length > 4) {
            if (SKIP_FOR_MSG.has(item[1])) continue;
            if (!item[2].includes(bareId)) continue;
            try {
              const data = JSON.parse(item[2]);
              console.log(`[GeminiExporter] findMessages: wrb.fr ${item[1]} with convId ${convId} (800 chars):`,
                JSON.stringify(data).slice(0, 800));
              // RPC別パーサ
              const msgs = item[1] === "DYBcR"
                ? extractMessagesFromDYBcR(data)
                : item[1] === "hNvQHb"
                  ? extractMessagesFromHNvQHb(data)
                  : extractMessages(data);
              if (msgs.length > 0) return msgs;
              console.log(`[GeminiExporter] extractMessages found 0 from above — check structure`);
            } catch {}
          }
        }
      } catch {}
    }
  }
  return null;
}

// hNvQHb レスポンス専用メッセージ抽出
// 構造: [[ [turn_latest, turn_prev, ...], null, null, [] ]]
//   turn[0] = ["conv_id", "turn_id"]
//   turn[1] = prev_ref (null or array)
//   turn[2] = user input: [["text"], 1, null, order, model_id, ...]
//   turn[3] = model output: [[[resp_id, ["text"], ...]]]
function extractMessagesFromHNvQHb(data) {
  const messages = [];
  try {
    const container = data?.[0];
    if (!Array.isArray(container)) return messages;

    // container の各要素がターンかどうか確認 (item[0] が conv_id 配列)
    const turns = container.filter(item =>
      Array.isArray(item) &&
      Array.isArray(item[0]) &&
      typeof item[0][0] === "string" &&
      (/^c_[0-9a-f]{12,}$/.test(item[0][0]) || /^[0-9a-f]{12,32}$/.test(item[0][0]))
    );

    // 最新ターンが先頭に来るので逆順にして古い順に処理
    for (const turn of turns.slice().reverse()) {
      const userText = turn?.[2]?.[0]?.[0];
      if (typeof userText === "string" && userText.length > 0) {
        messages.push({ sender: "human", text: userText, created_at: null });
      }
      const modelText = turn?.[3]?.[0]?.[0]?.[1]?.[0];
      if (typeof modelText === "string" && modelText.length > 0) {
        messages.push({ sender: "assistant", text: modelText, created_at: null });
      }
    }
  } catch {}
  return messages;
}

// DYBcR レスポンス専用メッセージ抽出
// 構造: [[[user_info_block, turns_block], ...]]
// turns_block[N][0][0][0][0][0] = message text (深くネスト)
function extractMessagesFromDYBcR(data) {
  const messages = [];
  try {
    const outer = Array.isArray(data[0]) ? data[0] : data;
    for (const pair of outer) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const turnsBlock = pair[1];
      if (!Array.isArray(turnsBlock)) continue;
      for (const turn of turnsBlock) {
        if (!Array.isArray(turn)) continue;
        // ユーザー発話: turn[0] が文字列配列に見える
        const userText = findFirstLongString(turn[0], 3);
        if (userText) messages.push({ sender: "human", text: userText, created_at: null });
        // モデル応答: turn[1] に深くネスト
        const modelText = findFirstLongString(turn[1], 3);
        if (modelText) messages.push({ sender: "assistant", text: modelText, created_at: null });
      }
    }
  } catch {}
  return messages;
}

// depth 以上のネストにある最初の長い文字列を返す
function findFirstLongString(v, depth = 0, minLen = 20) {
  if (depth > 10) return null;
  if (typeof v === "string" && v.length >= minLen && !/^https?:\/\//.test(v)) return v;
  if (!Array.isArray(v)) return null;
  for (const x of v) {
    const t = findFirstLongString(x, depth + 1, minLen);
    if (t) return t;
  }
  return null;
}

// DOM から現在表示中の会話のメッセージを取得
function extractMessagesFromDOM() {
  const messages = [];

  // Gemini の DOM 構造 (custom elements)
  // 優先度順に複数のセレクタを試みる
  const turns = document.querySelectorAll("message-turn");
  if (turns.length > 0) {
    for (const turn of turns) {
      // ── ユーザーメッセージ ──
      const userEl = turn.querySelector(
        "user-query-content, user-query-text-bubble, .user-query-content, " +
        "[data-message-author-role='user'], .human-turn-text"
      );
      if (userEl) {
        const text = userEl.innerText?.trim() || userEl.textContent?.trim() || "";
        if (text) messages.push({ sender: "human", text, created_at: null });
      }

      // ── モデルメッセージ ──
      const modelEl = turn.querySelector(
        "model-response, .model-response-text, response-container, " +
        "[data-message-author-role='model'], .assistant-turn-text"
      );
      if (modelEl) {
        // markdown レンダリング後のテキストを段落単位で取得
        const parts = modelEl.querySelectorAll("p, li, pre code, h1, h2, h3, td, .code-block");
        let text = "";
        if (parts.length > 0) {
          text = Array.from(parts).map(el => el.innerText?.trim() || "").filter(Boolean).join("\n\n");
        } else {
          text = modelEl.innerText?.trim() || modelEl.textContent?.trim() || "";
        }
        if (text) messages.push({ sender: "assistant", text, created_at: null });
      }
    }
  }

  if (messages.length === 0) {
    // フォールバック: aria-label 等で探す
    const userMsgs  = document.querySelectorAll('[aria-label*="You said"], [aria-label*="あなた"]');
    const modelMsgs = document.querySelectorAll('[aria-label*="Gemini"], [aria-label*="Response"]');
    for (const el of userMsgs)  messages.push({ sender: "human",     text: el.innerText?.trim() || "", created_at: null });
    for (const el of modelMsgs) messages.push({ sender: "assistant", text: el.innerText?.trim() || "", created_at: null });
  }

  console.log(`[GeminiExporter] DOM message extraction: ${messages.length} messages`);
  return messages.filter(m => m.text.length > 0);
}

// 会話ページで呼ばれる RPC でメッセージ取得を試みる (メインワールドキャプチャ優先)
async function fetchConversationByBatch(conv, tokens) {
  // まずキャプチャ済みレスポンスから探す
  const cached = findMessagesInCaptured(conv.id);
  if (cached) {
    console.log(`[GeminiExporter] ${conv.id}: キャプチャから ${cached.length} メッセージ`);
    return { _messages: cached };
  }

  // サイドバーのリンクをクリックして会話を読み込み、レスポンスをキャプチャ
  const bareId = conv.id.startsWith("c_") ? conv.id.slice(2) : conv.id;
  const link = document.querySelector(`a[href*="/app/${bareId}"], a[href*="/app/${conv.id}"]`);
  if (!link) {
    console.log(`[GeminiExporter] ${conv.id}: サイドバーリンク見つからず`);
    return null;
  }

  const initialLen = _capturedResponses.length;
  link.click();
  console.log(`[GeminiExporter] ${conv.id}: クリックして会話を読み込み中...`);

  // 新しいキャプチャを最大 8 秒待つ
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    for (let i = initialLen; i < _capturedResponses.length; i++) {
      if (!_capturedResponses[i].includes(bareId)) continue;
      const msgs = findMessagesInCaptured(conv.id);
      if (msgs && msgs.length > 0) {
        console.log(`[GeminiExporter] ${conv.id}: ナビゲートキャプチャから ${msgs.length} メッセージ`);
        return { _messages: msgs };
      }
    }
  }
  console.log(`[GeminiExporter] ${conv.id}: ナビゲート後もメッセージ取得できず`);
  return null;
}

// ページ HTML から会話データを抽出 (fallback)
// Gemini は CSR のため通常は空だが念のため試みる
async function fetchConversationByPage(conv, tokens) {
  const idx = tokens?.idx ?? "0";
  const res = await fetch(`https://gemini.google.com/u/${idx}/app/${conv.id}`, { credentials: "include" });
  if (!res.ok) return null;
  const html = await res.text();

  // AF_initDataCallback パターン
  const results = [];
  let pos = 0;
  while (true) {
    const start = html.indexOf("AF_initDataCallback", pos);
    if (start === -1) break;
    const paren = html.indexOf("(", start);
    if (paren === -1 || paren - start > 60) { pos = start + 1; continue; }
    let depth = 0, i = paren;
    for (; i < html.length; i++) {
      const c = html[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) break; }
    }
    try {
      const obj = JSON.parse(html.slice(paren + 1, i));
      if (obj?.data) results.push(obj.data);
    } catch {}
    pos = i;
  }
  return results.length > 0 ? results : null;
}

function extractMessages(data, depth = 0) {
  if (depth > 10 || !Array.isArray(data)) return [];
  const messages = [];

  for (const item of data) {
    if (!Array.isArray(item)) continue;

    // ヒューマンターンのパターン: [0, text, ...] or ["human", text, ...]
    if ((item[0] === 0 || item[0] === "human") && typeof item[1] === "string" && item[1].length > 0) {
      messages.push({ sender: "human",     text: item[1], created_at: null });
      continue;
    }
    // アシスタントターンのパターン: [1, text, ...] or ["model"/"assistant", text, ...]
    if ((item[0] === 1 || item[0] === "model" || item[0] === "assistant") && item[1]) {
      const text = resolveText(item[1]);
      if (text) {
        messages.push({ sender: "assistant", text, created_at: null });
        continue;
      }
    }

    // より深い配列を再帰探索
    const sub = extractMessages(item, depth + 1);
    messages.push(...sub);
  }

  return messages;
}

async function fetchConversationDetail(conv, tokens) {
  // 0th: 現在開いているページがこの会話なら DOM から直接取得
  if (location.href.includes(conv.id)) {
    const domMsgs = extractMessagesFromDOM();
    if (domMsgs.length > 0) {
      console.log(`[GeminiExporter] ${conv.id}: DOM から ${domMsgs.length} メッセージ`);
      return buildConv(conv, domMsgs);
    }
  }

  // 1st: キャプチャ済みレスポンス or batchexecute
  try {
    const data = await fetchConversationByBatch(conv, tokens);
    if (data?._messages) return buildConv(conv, data._messages);
    const messages = extractMessages(data);
    if (messages.length > 0) return buildConv(conv, messages);
  } catch (e) {
    console.warn(`[GeminiExporter] batch 失敗 (${conv.id}):`, e.message);
  }

  // 2nd: ページ HTML fallback
  try {
    const pageData = await fetchConversationByPage(conv, tokens);
    if (pageData) {
      for (const d of pageData) {
        const messages = extractMessages(d);
        if (messages.length > 0) return buildConv(conv, messages);
      }
    }
  } catch (e) {
    console.warn(`[GeminiExporter] page fallback 失敗 (${conv.id}):`, e.message);
  }

  // 最終 fallback: メタデータのみ
  console.warn(`[GeminiExporter] ${conv.id}: メッセージ取得できず — 会話ページを開いてから Export してください`);
  return buildConv(conv, []);
}

function buildConv(conv, messages) {
  return {
    uuid:          conv.id,
    name:          conv.title || conv.id,
    source:        "gemini",
    created_at:    conv.updated_at,
    updated_at:    conv.updated_at,
    chat_messages: messages,
  };
}

// ── 並列フェッチ ─────────────────────────────────────────────

function resolveSettings(s) {
  return {
    concurrency: s?.concurrency ?? DEFAULTS.concurrency,
    chunkDelay:  s?.chunkDelay  ?? DEFAULTS.chunkDelay,
    retryDelay:  s?.retryDelay  ?? DEFAULTS.retryDelay,
  };
}

async function fetchFullConversations(convList, tokens, onProgress, settings) {
  const { concurrency, chunkDelay } = resolveSettings(settings);
  const full = [];
  let completed = 0;

  for (let i = 0; i < convList.length; i += concurrency) {
    if (_cancelled) break;
    const chunk = convList.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (conv) => {
        const result = await fetchConversationDetail(conv, tokens);
        completed++;
        onProgress({ current: completed, total: convList.length, title: conv.title || conv.id });
        return result;
      })
    );
    full.push(...results);
    if (chunkDelay > 0 && i + concurrency < convList.length) {
      await new Promise((r) => setTimeout(r, chunkDelay));
    }
  }

  return full;
}

async function fetchAllConversations(onProgress, limit = 0, since = null, settings) {
  const tokens = await getPageTokens();
  const convList = await fetchConversationList(tokens, limit, since);
  if (convList.length === 0) return [];
  return fetchFullConversations(convList, tokens, onProgress, settings);
}

// ── スマート同期 ──────────────────────────────────────────────

async function smartSync(onProgress, settings, limit = 0, since = null) {
  const tokens = await getPageTokens();
  const convList = await fetchConversationList(tokens, limit, since);
  if (convList.length === 0) return { total: 0, updated: 0 };

  const syncRes = await fetch(`${SYNC_SERVER}/sync_state`);
  if (!syncRes.ok) throw new Error(`同期サーバーに接続できません (${syncRes.status})`);
  const syncState = await syncRes.json();

  const needUpdate = convList.filter((conv) => {
    const stored = syncState[conv.id];
    if (!stored) return true;
    return conv.updated_at ? conv.updated_at > stored : true;
  });

  if (needUpdate.length === 0) return { total: convList.length, updated: 0 };

  const fullConvs = await fetchFullConversations(needUpdate, tokens, onProgress, settings);

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

// ── ダウンロード ──────────────────────────────────────────────

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
    const role = msg.sender === "human" ? "**User**" : "**Gemini**";
    const ts   = (msg.created_at || "").slice(0, 19).replace("T", " ");
    lines.push(`### ${role}  <sub>${ts}</sub>`, "", (msg.text || "").trim(), "", "---", "");
  }
  return lines.join("\n");
}

function triggerDownload(conversations, format, service) {
  const ts     = new Date().toISOString().slice(0, 10);
  const prefix = `${service}_export_${ts}`;
  let content, filename, mime;

  if (format === "md") {
    content  = conversations.map(convToMarkdown).join("\n\n---\n\n");
    filename = `${prefix}.md`;
    mime     = "text/markdown";
  } else {
    content  = JSON.stringify(conversations, null, 2);
    filename = `${prefix}.json`;
    mime     = "application/json";
  }

  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
