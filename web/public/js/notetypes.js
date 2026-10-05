// 筆記類型的編輯：草稿、驗證、欄位改名時同步版型、算出對筆記與卡片的影響，並套用。
// 沒有任何畫面相關的程式，Node 也能載入測試。
import { kindOf, templatesOf } from "./cards.js";
import { saveCards, saveNotes, saveStatic, store } from "./core.js";
import { deleteCards, syncCards } from "./ops.js";

// 草稿：欄位與版型都記得「原本是第幾個」（orig），新增的是 null，這樣才知道改名、搬移、刪除各對應哪些資料。
export function draftOf(nt) {
  return {
    id: nt.id,
    name: nt.name,
    kind: kindOf(nt),
    css: nt.css ?? "",
    fields: nt.fields.map((name, i) => ({ name, orig: i, committed: name })),
    tmpls: templatesOf(nt).map((t, i) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt, orig: i })),
  };
}

export function buildNoteType(d) {
  const tmpls = d.tmpls.map((t) => ({ name: t.name.trim(), qfmt: t.qfmt, afmt: t.afmt }));
  return { id: d.id, name: d.name.trim(), kind: d.kind, fields: d.fields.map((f) => f.name.trim()), tmpls, qfmt: tmpls[0].qfmt, afmt: tmpls[0].afmt, css: d.css };
}

// 欄位改名：把版型裡 {{欄位}}、{{#欄位}}、{{cloze:欄位}} 等所有引用一起改掉
export function renameInTemplate(text, from, to) {
  if (from === to) return text;
  return text.replace(/\{\{([#^/]?)([^}]*)\}\}/g, (all, mark, expr) => {
    const parts = expr.split(":");
    if (parts[parts.length - 1].trim() !== from) return all;
    parts[parts.length - 1] = to;
    return `{{${mark}${parts.join(":")}}}`;
  });
}

// 回傳錯誤訊息；沒問題回傳 null。others：同一個人的其他筆記類型（名稱不能重複）。
export function validateDraft(d, others = []) {
  if (!d.name.trim()) return "請輸入筆記類型的名稱";
  if (others.some((o) => o.id !== d.id && o.name === d.name.trim())) return "已經有同名的筆記類型了";
  if (!d.fields.length) return "至少要有一個欄位";
  const names = d.fields.map((f) => f.name.trim());
  if (names.some((n) => !n)) return "欄位名稱不能是空的";
  if (names.some((n) => /[{}:#^/]/.test(n))) return "欄位名稱不能包含 { } : # ^ /";
  if (new Set(names).size !== names.length) return "欄位名稱不能重複";
  if (!d.tmpls.length) return "至少要有一個版型";
  for (const t of d.tmpls) {
    if (!t.name.trim()) return "版型名稱不能是空的";
    if (!t.qfmt.trim()) return `版型「${t.name}」的正面不能是空的`;
    for (const side of [t.qfmt, t.afmt]) {
      for (const m of side.matchAll(/\{\{([#^/]?)([^}]*)\}\}/g)) {
        const name = m[2].split(":").pop().trim();
        if (!name || names.includes(name) || ["FrontSide", "Tags", "Deck", "Subdeck", "Card", "Type", "CardFlag"].includes(name)) continue;
        return `版型「${t.name}」用到不存在的欄位「${name}」`;
      }
    }
  }
  if (d.kind === "cloze" && !/\{\{cloze:[^}]+\}\}/.test(d.tmpls[0].qfmt)) return "填空題的正面要用 {{cloze:欄位}}";
  if (d.kind === "occlusion" && !(names.includes("Image") && names.includes("Occlusion"))) return "圖片遮蓋需要 Image 和 Occlusion 兩個欄位";
  return null;
}

// 套用草稿之前，先算出會動到哪些資料（不會改任何東西）
export function planChange(oldNt, d, notes, cards) {
  const noteChanges = [];
  const fieldsChanged = d.fields.length !== oldNt.fields.length || d.fields.some((f, i) => f.orig !== i);
  const droppedFields = oldNt.fields.filter((_, i) => !d.fields.some((f) => f.orig === i));
  if (fieldsChanged) {
    for (const note of notes) noteChanges.push({ note, fields: d.fields.map((f) => (f.orig === null ? "" : note.fields[f.orig] ?? "")) });
  }
  // 版型：orig 對應舊的 ord。沒有被保留的舊版型，卡片要刪除；順序或新增造成 ord 改變的，要改卡片的 ord。
  const oldTmpls = templatesOf(oldNt);
  const kept = new Map(d.tmpls.map((t, i) => [t.orig, i]).filter(([o]) => o !== null));
  const drop = [];
  const remap = [];
  if (kindOf(oldNt) === "standard") {
    for (const c of cards) {
      if (!kept.has(c.ord) && c.ord < oldTmpls.length) drop.push(c);
      else if (kept.has(c.ord) && kept.get(c.ord) !== c.ord) remap.push({ card: c, ord: kept.get(c.ord) });
    }
  }
  const addedTemplates = d.tmpls.some((t) => t.orig === null);
  return { noteChanges, droppedFields, drop, remap, addedTemplates, notes: notes.length };
}

// 套用：先存筆記類型（需要網路，失敗就什麼都還沒動），再更新筆記與卡片。
export async function applyChange(d, plan, onProgress = () => {}) {
  const nt = buildNoteType(d);
  const list = store.static.notetypes.some((n) => n.id === nt.id) ? store.static.notetypes.map((n) => (n.id === nt.id ? nt : n)) : [...store.static.notetypes, nt];
  await saveStatic({ notetypes: list });
  const chunk = 500;
  for (let i = 0; i < plan.noteChanges.length; i += chunk) {
    const part = plan.noteChanges.slice(i, i + chunk);
    part.forEach(({ note, fields }) => (note.fields = fields));
    await saveNotes(part.map((p) => p.note));
    onProgress(`更新筆記 ${Math.min(i + chunk, plan.noteChanges.length)}/${plan.noteChanges.length}`);
  }
  if (plan.drop.length) {
    await deleteCards(plan.drop);
  }
  for (let i = 0; i < plan.remap.length; i += chunk) {
    const part = plan.remap.slice(i, i + chunk);
    part.forEach(({ card, ord }) => (card.ord = ord));
    await saveCards(part.map((p) => p.card));
  }
  if (plan.addedTemplates || d.kind !== "standard") {
    const notes = [...store.notes.values()].filter((n) => n.mid === nt.id);
    for (let i = 0; i < notes.length; i += chunk) {
      await syncCards(notes.slice(i, i + chunk));
      onProgress(`產生卡片 ${Math.min(i + chunk, notes.length)}/${notes.length}`);
    }
  }
}

// 新增筆記類型（不影響任何筆記）
export async function addNoteType(nt) {
  await saveStatic({ notetypes: [...store.static.notetypes, nt] });
}

export const notesOfType = (mid) => [...store.notes.values()].filter((n) => n.mid === mid);

// 預覽用的範例內容：有真實筆記就用第一筆，否則用「欄位名稱」當內容
export function sampleValues(nt) {
  const real = [...store.notes.values()].find((n) => n.mid === nt.id);
  if (real) return real.fields;
  if (kindOf(nt) === "cloze") return nt.fields.map((f, i) => (i === 0 ? "The {{c1::quick}} brown {{c2::fox}} jumps over the lazy dog." : f));
  return nt.fields.map((f) => f);
}

