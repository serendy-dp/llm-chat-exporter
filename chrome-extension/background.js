// background.js — レイテント（自動バックグラウンド）Sync
const ALARM_NAME = "llmExporterLatentSync";

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  const { llmExporterSettings } = await chrome.storage.local.get("llmExporterSettings");

  const urlPatterns = [
    "*://claude.ai/*",
    "*://chatgpt.com/*",
    "*://chat.openai.com/*",
    "*://gemini.google.com/*",
  ];

  for (const pattern of urlPatterns) {
    const tabs = await chrome.tabs.query({ url: pattern });
    for (const tab of tabs) {
      try {
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: "SMART_SYNC",
          settings: llmExporterSettings || {},
        });
        if (res?.ok) {
          console.log(`[LatentSync] ${tab.url}: synced ${res.updated}/${res.total}`);
          chrome.storage.local.set({ lastSyncResult: { updated: res.updated, total: res.total, ts: new Date().toISOString() } });
        }
      } catch {}
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.latentSyncEnabled || changes.latentSyncInterval) {
    updateAlarm();
  }
});

chrome.runtime.onInstalled.addListener(updateAlarm);
chrome.runtime.onStartup.addListener(updateAlarm);

async function updateAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  const { latentSyncEnabled, latentSyncInterval } =
    await chrome.storage.local.get(["latentSyncEnabled", "latentSyncInterval"]);

  if (latentSyncEnabled) {
    const minutes = Math.max(1, parseInt(latentSyncInterval) || 30);
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
    console.log(`[LatentSync] alarm set: every ${minutes} min`);
  }
}
