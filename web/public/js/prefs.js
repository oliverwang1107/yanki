// 這台裝置上的個人偏好（字級、發音）。存在 localStorage，不同步；沒有 localStorage 時用預設值。
const KEY = "anki-prefs";
export const DEFAULTS = {
  fontScale: 1, // 卡片文字大小倍率
  tts: true, // 顯示「朗讀」按鈕（瀏覽器內建的語音合成，沒有音檔的單字和例句也能聽）
  ttsRate: 0.9,
  ttsEngine: "auto", // auto｜browser（瀏覽器內建）｜cloud（雲端發音，需要網路）
  autoSpeak: "off", // off｜word（出題時朗讀單字）｜example（翻到答案時朗讀例句）
};

let cache;
export function getPrefs() {
  if (!cache) {
    try {
      cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    } catch {
      cache = { ...DEFAULTS };
    }
  }
  return cache;
}

export function applyPrefs() {
  document.documentElement.style.setProperty("--fs", String(getPrefs().fontScale));
}

export function setPref(key, value) {
  getPrefs()[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch { /* 無痕模式等 */ }
  applyPrefs();
}
