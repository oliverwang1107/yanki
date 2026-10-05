// 讀 ZIP 檔（.apkg 就是 ZIP）：只讀需要的項目，不會把整個檔案載進記憶體（大牌組可能有數百 MB 的媒體）。
// 支援儲存（0）與 deflate（8）兩種壓縮方式；不支援加密與 ZIP64（超過 4GB）。
// source 是任何有 size 與 slice(a, b).arrayBuffer() 的物件（File、Blob）。

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(source) {
  const size = source.size;
  const tailLen = Math.min(size, 65557);
  const tail = new DataView(await source.slice(size - tailLen, size).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("這不是有效的 ZIP 檔（.apkg）");
  const count = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("檔案太大（ZIP64），不支援");

  const cd = new DataView(await source.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const entries = new Map();
  const decoder = new TextDecoder();
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (u32(cd, at) !== 0x02014b50) throw new Error("ZIP 目錄損壞");
    const flags = u16(cd, at + 8);
    const method = u16(cd, at + 10);
    const compSize = u32(cd, at + 20);
    const rawSize = u32(cd, at + 24);
    const nameLen = u16(cd, at + 28);
    const extraLen = u16(cd, at + 30);
    const commentLen = u16(cd, at + 32);
    const offset = u32(cd, at + 42);
    const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + at + 46, nameLen));
    if (flags & 1) throw new Error("這個 ZIP 有加密，不支援");
    entries.set(name, { name, method, compSize, rawSize, offset });
    at += 46 + nameLen + extraLen + commentLen;
  }

  async function read(name) {
    const e = entries.get(name);
    if (!e) throw new Error(`ZIP 裡找不到 ${name}`);
    const head = new DataView(await source.slice(e.offset, e.offset + 30).arrayBuffer());
    if (u32(head, 0) !== 0x04034b50) throw new Error("ZIP 項目損壞");
    const start = e.offset + 30 + u16(head, 26) + u16(head, 28);
    const data = new Uint8Array(await source.slice(start, start + e.compSize).arrayBuffer());
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRaw(data);
    throw new Error(`不支援的壓縮方式（${e.method}）`);
  }

  return { names: [...entries.keys()], has: (n) => entries.has(n), size: (n) => entries.get(n)?.rawSize ?? 0, read };
}
