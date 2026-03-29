const btnExport   = document.getElementById("btnExport");
const btnSync     = document.getElementById("btnSync");
const btnStop     = document.getElementById("btnStop");
const btnConfig   = document.getElementById("btnConfig");
const configPanel = document.getElementById("configPanel");
const cfgConcurrency = document.getElementById("cfgConcurrency");
const cfgChunkDelay  = document.getElementById("cfgChunkDelay");
const warnConcurrency = document.getElementById("warnConcurrency");
const warnChunkDelay  = document.getElementById("warnChunkDelay");
const latentEnabled      = document.getElementById("latentEnabled");
const latentInterval     = document.getElementById("latentInterval");
const latentIntervalWrap = document.getElementById("latentIntervalWrap");
const fmtJson    = document.getElementById("fmtJson");
const fmtMd      = document.getElementById("fmtMd");
const limitAll   = document.getElementById("limitAll");
const limitN     = document.getElementById("limitN");
const limitSince = document.getElementById("limitSince");
const limitInput = document.getElementById("limitInput");
const sinceInput = document.getElementById("sinceInput");
const statusEl   = document.getElementById("status");
const progressWrap = document.getElementById("progressWrap");
const progressBar  = document.getElementById("progressBar");
const serviceIndicator = document.getElementById("serviceIndicator");

let selectedFormat = "json";
let rangeMode = "all"; // "all" | "latest" | "since"
let _syncActive = false; // PROGRESS が最終ステータスを上書きするのを防ぐ
let _ownSync    = false; // このポップアップ自身が開始したsyncかどうか

// デフォルトの日付を今日から30日前に設定
const d = new Date();
d.setDate(d.getDate() - 30);
sinceInput.value = d.toISOString().slice(0, 10);

fmtJson.addEventListener("click", () => {
  selectedFormat = "json";
  fmtJson.classList.add("active");
  fmtMd.classList.remove("active");
});
fmtMd.addEventListener("click", () => {
  selectedFormat = "md";
  fmtMd.classList.add("active");
  fmtJson.classList.remove("active");
});

function setRangeMode(mode) {
  rangeMode = mode;
  limitAll.classList.toggle("active",   mode === "all");
  limitN.classList.toggle("active",     mode === "latest");
  limitSince.classList.toggle("active", mode === "since");
  limitInput.classList.toggle("visible", mode === "latest");
  sinceInput.classList.toggle("visible", mode === "since");
  if (mode === "latest") limitInput.focus();
  if (mode === "since")  sinceInput.focus();
}

limitAll.addEventListener("click",   () => setRangeMode("all"));
limitN.addEventListener("click",     () => setRangeMode("latest"));
limitSince.addEventListener("click", () => setRangeMode("since"));

// ── 設定パネル ──────────────────────────────────────────

const DEFAULTS = { concurrency: 2, chunkDelay: 2000 };

function getSettings() {
  return {
    concurrency: parseInt(cfgConcurrency.value, 10) || DEFAULTS.concurrency,
    chunkDelay:  parseInt(cfgChunkDelay.value,  10) || DEFAULTS.chunkDelay,
  };
}

function validateSettings() {
  const s = getSettings();
  warnConcurrency.classList.toggle("visible", s.concurrency >= 4);
  warnChunkDelay.classList.toggle("visible",  s.chunkDelay < 500);
  chrome.storage.local.set({ llmExporterSettings: s });
}

[cfgConcurrency, cfgChunkDelay].forEach(el => {
  el.addEventListener("input", validateSettings);
});

btnConfig.addEventListener("click", () => {
  const open = configPanel.classList.toggle("open");
  btnConfig.classList.toggle("open", open);
});

// 保存済み設定をロード
chrome.storage.local.get(
  ["llmExporterSettings", "latentSyncEnabled", "latentSyncInterval"],
  ({ llmExporterSettings: s, latentSyncEnabled, latentSyncInterval }) => {
    if (s) {
      cfgConcurrency.value = s.concurrency ?? DEFAULTS.concurrency;
      cfgChunkDelay.value  = s.chunkDelay  ?? DEFAULTS.chunkDelay;
      validateSettings();
    }
    if (latentSyncEnabled) {
      latentEnabled.checked = true;
      latentIntervalWrap.style.display = "block";
    }
    if (latentSyncInterval) latentInterval.value = latentSyncInterval;
  }
);

// Auto Sync トグル
latentEnabled.addEventListener("change", () => {
  latentIntervalWrap.style.display = latentEnabled.checked ? "block" : "none";
  saveLatentSettings();
});
latentInterval.addEventListener("input", saveLatentSettings);

function saveLatentSettings() {
  chrome.storage.local.set({
    latentSyncEnabled:  latentEnabled.checked,
    latentSyncInterval: parseInt(latentInterval.value, 10) || 30,
  });
}

function getRangeParams() {
  if (rangeMode === "latest") {
    const n = parseInt(limitInput.value, 10);
    return { limit: n > 0 ? n : 0 };
  }
  if (rangeMode === "since" && sinceInput.value) {
    return { since: sinceInput.value };
  }
  return {};
}

const SERVICE_LABEL = {
  claude:  "// claude.ai",
  chatgpt: "// chatgpt.com",
  gemini:  "// gemini.google.com",
};

async function detectService() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return null;
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "PING" }, (res) => {
      if (chrome.runtime.lastError || !res?.service) resolve(null);
      else resolve(res.service);
    });
  });
}

async function updateServiceIndicator() {
  const service = await detectService();
  if (service) {
    serviceIndicator.textContent = SERVICE_LABEL[service] || service;
    serviceIndicator.className = service;
  } else {
    serviceIndicator.textContent = "// 未対応のページ";
    serviceIndicator.className = "none";
  }
}

updateServiceIndicator();

// ポップアップ起動時に進行中の同期を復元
async function restoreProgress() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" }, (res) => {
    if (chrome.runtime.lastError || !res?.running || !res?.progress) return;
    const { current, total, title } = res.progress;
    _syncActive = true; // PROGRESS メッセージを受け取れるようにする
    setButtons(true);
    progressWrap.style.display = "block";
    setProgress(total > 0 ? Math.round((current / total) * 100) : 0);
    setStatus(`${current}/${total}  ${title || ""}`.slice(0, 60));
  });
}
restoreProgress();

function setStatus(msg, type = "") {
  statusEl.textContent = msg;
  statusEl.className = type;
}

function setProgress(pct) {
  progressWrap.style.display = "block";
  progressBar.style.width = pct + "%";
}

function setButtons(disabled) {
  btnExport.disabled = disabled;
  btnSync.disabled   = disabled;
  btnStop.classList.toggle("visible", disabled);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PROGRESS" && _syncActive) {
    const pct = Math.round((msg.current / msg.total) * 100);
    setStatus(`${msg.current}/${msg.total}  ${msg.title || ""}`.slice(0, 60));
    setProgress(pct);
  }
  // ポップアップを再度開いた場合の完了通知 (_ownSync=false = 自分が開始していない)
  if (msg.type === "SYNC_COMPLETE" && _syncActive && !_ownSync) {
    _syncActive = false;
    setProgress(100);
    setStatus(`synced ${msg.updated} / ${msg.total}`, "done");
    setButtons(false);
    setTimeout(() => { progressWrap.style.display = "none"; progressBar.style.width = "0%"; }, 3000);
  }
});

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const url = tab?.url ?? "";
  if (!url.includes("claude.ai") && !url.includes("chatgpt.com") && !url.includes("chat.openai.com") && !url.includes("gemini.google.com")) {
    throw new Error("claude.ai / chatgpt.com / gemini.google.com のタブをアクティブにしてください");
  }
  return tab.id;
}

async function fetchConversations(format) {
  const tabId = await getActiveTabId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timeout — F12 > Console でエラーを確認"));
    }, 600_000);

    chrome.tabs.sendMessage(tabId, { type: "FETCH_CONVERSATIONS", format, ...getRangeParams(), settings: getSettings() }, (res) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error("content script と通信できません。ページをリロードしてください。"));
      } else if (!res?.ok) {
        reject(new Error(res?.error || "取得失敗"));
      } else {
        resolve(res.count);
      }
    });
  });
}

async function runSmartSync() {
  const tabId = await getActiveTabId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timeout — F12 > Console でエラーを確認"));
    }, 600_000);

    chrome.tabs.sendMessage(tabId, { type: "SMART_SYNC", settings: getSettings(), ...getRangeParams() }, (res) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error("content script と通信できません。ページをリロードしてください。"));
      } else if (!res?.ok) {
        reject(new Error(res?.error || "同期失敗"));
      } else {
        resolve(res);
      }
    });
  });
}

async function runExport() {
  _ownSync = true;
  _syncActive = true;
  setButtons(true);
  setProgress(0);
  setStatus("fetching conversations...");
  progressWrap.style.display = "block";

  try {
    const count = await fetchConversations(selectedFormat);
    _syncActive = false;
    _ownSync = false;
    setProgress(100);
    setStatus(`exported ${count} conversations`, "done");
  } catch (e) {
    _syncActive = false;
    _ownSync = false;
    setStatus(e.message, "error");
  } finally {
    setButtons(false);
    setTimeout(() => {
      progressWrap.style.display = "none";
      progressBar.style.width = "0%";
    }, 3000);
  }
}

async function runSync() {
  _ownSync = true;
  _syncActive = true;
  setButtons(true);
  setProgress(0);
  setStatus("syncing...");
  progressWrap.style.display = "block";

  try {
    const result = await runSmartSync();
    _syncActive = false;
    _ownSync = false;
    setProgress(100);
    setStatus(`synced ${result.updated} / ${result.total}`, "done");
  } catch (e) {
    _syncActive = false;
    _ownSync = false;
    setStatus(e.message, "error");
  } finally {
    setButtons(false);
    setTimeout(() => {
      progressWrap.style.display = "none";
      progressBar.style.width = "0%";
    }, 3000);
  }
}

btnExport.addEventListener("click", runExport);
btnSync.addEventListener("click", runSync);

btnStop.addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "STOP_SYNC" }, () => {});
  setButtons(false);
  setStatus("stopped", "error");
  setTimeout(() => { progressWrap.style.display = "none"; progressBar.style.width = "0%"; }, 2000);
});
