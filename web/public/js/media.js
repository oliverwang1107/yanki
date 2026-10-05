// 使用者自己的媒體：挑選／縮圖／錄音、算雜湊、上傳到 /api/media，並產生要插入欄位的 HTML。
// 純函式（副檔名、標籤、雜湊）沒有用到畫面，Node 也能測試；縮圖與錄音只在瀏覽器裡用得到。

export const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
export const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "ogg", "oga", "wav", "webm"]);

export const extOf = (name) => (/\.([A-Za-z0-9]+)$/.exec(name ?? "")?.[1] ?? "").toLowerCase();
export const kindOf = (name) => (IMAGE_EXT.has(extOf(name)) ? "image" : AUDIO_EXT.has(extOf(name)) ? "audio" : "other");

// 要插進欄位的內容：圖片用 <img>，聲音用 [sound:檔名]（複習時變成播放鈕）
export function mediaTag(name) {
  return kindOf(name) === "image" ? `<img src="/media/${encodeURIComponent(name)}">` : `[sound:${name}]`;
}

// SHA-256 的前 16 個十六進位字元
export async function hashHex16(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

// 把大圖縮到最長邊 maxSide（手機拍的照片動輒 4000 像素、數 MB），小圖與 GIF 原樣上傳。
export async function shrinkImage(file, { maxSide = 1600, quality = 0.86 } = {}) {
  const ext = extOf(file.name) || (file.type.split("/")[1] ?? "");
  if (ext === "gif" || typeof createImageBitmap !== "function") return { blob: file, ext: ext === "jpeg" ? "jpg" : ext };
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return { blob: file, ext: ext === "jpeg" ? "jpg" : ext };
  }
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 400 * 1024) return { blob: file, ext: ext === "jpeg" ? "jpg" : ext };
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const keepAlpha = ext === "png" && file.size < 1.5 * 1024 * 1024 && scale === 1;
  const type = keepAlpha ? "image/png" : "image/webp";
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) return { blob: file, ext };
  // 有些瀏覽器不支援 webp 編碼，會退回 png；這時副檔名要跟著實際類型走
  return { blob, ext: blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : "jpg" };
}

export async function uploadBlob(blob, ext) {
  ext = ext === "jpeg" ? "jpg" : ext.toLowerCase();
  const hash = await hashHex16(await blob.arrayBuffer());
  const res = await fetch(`/api/media?ext=${encodeURIComponent(ext)}&hash=${hash}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/octet-stream" },
    body: blob,
  });
  const out = await res.json().catch(() => null);
  if (!res.ok || !out?.name) throw new Error(out?.error ?? `上傳失敗（${res.status}）`);
  return out.name;
}

// 選好的檔案 → 上傳 → 回傳可插入欄位的 HTML。圖片會先縮圖。
export async function uploadFile(file) {
  const ext = extOf(file.name) || (file.type.split("/")[1] ?? "").replace("mpeg", "mp3").replace("x-m4a", "m4a");
  if (IMAGE_EXT.has(ext) || file.type.startsWith("image/")) {
    const { blob, ext: outExt } = await shrinkImage(file);
    return mediaTag(await uploadBlob(blob, outExt));
  }
  if (AUDIO_EXT.has(ext) || file.type.startsWith("audio/")) return mediaTag(await uploadBlob(file, ext || "mp3"));
  throw new Error("只能加入圖片或音檔");
}

// 錄音：回傳 { stop() → Promise<File> }；呼叫 stop() 結束並取得檔案
export async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("這個瀏覽器不支援錄音");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();
  return {
    stop: () =>
      new Promise((resolve) => {
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          const mime = rec.mimeType || type || "audio/webm";
          resolve(new File(chunks, `recording.${mime.includes("mp4") ? "m4a" : "webm"}`, { type: mime }));
        };
        rec.stop();
      }),
    cancel: () => {
      rec.onstop = null;
      try { rec.stop(); } catch { /* 已經停了 */ }
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

// 匯入牌組時用：把套件裡的檔案（位元組）上傳成這個使用者的媒體。不支援的格式或太大的回傳 null（保留原本的引用）。
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", webm: "audio/webm" };
export async function uploadBytes(name, bytes) {
  const ext = extOf(name);
  const kind = kindOf(name);
  if (kind === "other" || !bytes?.length) return null;
  const file = new File([bytes], name, { type: MIME[ext] ?? "" });
  if (kind === "image") {
    const { blob, ext: outExt } = await shrinkImage(file);
    return blob.size > 6 * 1024 * 1024 ? null : uploadBlob(blob, outExt);
  }
  return bytes.length > 12 * 1024 * 1024 ? null : uploadBlob(file, ext);
}
