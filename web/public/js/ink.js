// 卡片上的手寫標記（Apple Pencil 畫的螢光筆、圈選）：資料格式、壓縮、存檔。沒有任何畫面相關的程式，Node 也能載入測試。
// 一張卡一列，id 就是卡片 id；data 是 JSON：{ s: [筆畫…] }，筆畫 = { k: 筆種, p: [x1, y1, x2, y2, …] }。
// 座標以卡片內容寬度的千分之一為單位（x、y 都除以寬度），所以換裝置或視窗大小時位置仍大致對得上。
import { saveInk, store } from "./core.js";

export const MAX_INK_CHARS = 50000; // 伺服器上限是 60000，留一點空間
export const TOOLS = {
  h: { label: "螢光", color: "rgba(255, 213, 0, 0.38)", width: 18 },
  r: { label: "紅筆", color: "#e5484d", width: 2.6 },
  b: { label: "藍筆", color: "#3b82f6", width: 2.6 },
};

export function strokesOf(cardId) {
  const row = store.ink.get(cardId);
  if (!row) return [];
  try {
    const s = JSON.parse(row.data)?.s;
    return Array.isArray(s) ? s.filter((x) => x && TOOLS[x.k] && Array.isArray(x.p) && x.p.length >= 2) : [];
  } catch {
    return [];
  }
}

// 把一串點（千分之一單位的整數）抽稀：距離上一個保留點太近的丟掉，最後一點一定保留。
export function simplify(points, minDist = 3) {
  if (points.length <= 4) return points.slice();
  const out = [points[0], points[1]];
  let [lx, ly] = out;
  for (let i = 2; i < points.length - 2; i += 2) {
    if (Math.hypot(points[i] - lx, points[i + 1] - ly) >= minDist) {
      out.push(points[i], points[i + 1]);
      [lx, ly] = [points[i], points[i + 1]];
    }
  }
  out.push(points[points.length - 2], points[points.length - 1]);
  return out;
}

export const encode = (strokes) => JSON.stringify({ s: strokes });

export async function saveStrokes(cardId, strokes) {
  const data = encode(strokes);
  if (data.length > MAX_INK_CHARS) throw new Error("這張卡的筆跡太多了，請清除一些再畫");
  const row = store.ink.get(cardId) ?? { id: cardId, mod: 0, deleted: 0 };
  if (row.data === data) return;
  row.data = data;
  row.deleted = 0;
  await saveInk(row); // 清空時也保留一列空資料，才能把「已清除」同步出去
}

// 筆畫上有任何一點離 (x, y) 不到 r 就算碰到（橡皮擦用）
export const hits = (stroke, x, y, r) => {
  for (let i = 0; i < stroke.p.length; i += 2) if (Math.hypot(stroke.p[i] - x, stroke.p[i + 1] - y) <= r) return true;
  return false;
};
