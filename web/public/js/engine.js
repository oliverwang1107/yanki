// 載入排程用的 WASM（只載入一次）。
import { loadSched } from "./sched.js";

let engine;
export async function initEngine() {
  engine ??= await loadSched(await fetch("/sched.wasm"));
  return engine;
}
export const getEngine = () => {
  if (!engine) throw new Error("排程引擎還沒載入");
  return engine;
};
