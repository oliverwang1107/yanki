//! 瀏覽器內的 FSRS 參數最佳化：包裝 fsrs crate 的 `compute_parameters` 與 `evaluate`。
//! 同樣用 C ABI、沒有任何 import：JS 用 `alloc` 要一塊記憶體，把複習序列寫進去，再呼叫 `optimize` 或 `evaluate`。
//!
//! 輸入（i32 陣列）：
//!   [0] 啟用短期記憶參數 (0/1)　[1] 重學步驟數　[2] 序列（FSRSItem）數量 n
//!   接著 n 組：長度 len，然後 len 對 (評分 1-4, 距上次複習的天數)
//! `optimize` 輸出 21 個 f32 參數；`evaluate` 另外輸入 21 個 f32 參數，輸出 [log loss, RMSE] 兩個 f32。
//! 回傳 0＝成功，1＝輸入格式不對，2＝演算法回報錯誤。

use fsrs::{ComputeParametersInput, FSRS, FSRSItem, FSRSReview};

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(8));
    let ptr = v.as_mut_ptr();
    std::mem::forget(v);
    ptr
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(8)) });
}

fn decode(data: &[i32]) -> Option<(bool, usize, Vec<FSRSItem>)> {
    if data.len() < 3 {
        return None;
    }
    let (short_term, relearn, n) = (data[0] != 0, data[1].max(0) as usize, data[2].max(0) as usize);
    let mut at = 3;
    let mut items = Vec::with_capacity(n);
    for _ in 0..n {
        let len = *data.get(at)? as usize;
        at += 1;
        if len == 0 || at + len * 2 > data.len() {
            return None;
        }
        let reviews = (0..len)
            .map(|i| FSRSReview { rating: data[at + i * 2] as u32, delta_t: data[at + i * 2 + 1].max(0) as u32 })
            .collect();
        at += len * 2;
        items.push(FSRSItem { reviews });
    }
    Some((short_term, relearn, items))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn optimize(input: *const i32, len: usize, out: *mut f32) -> i32 {
    let data = unsafe { std::slice::from_raw_parts(input, len) };
    let Some((enable_short_term, relearn, items)) = decode(data) else { return 1 };
    let result = fsrs::compute_parameters(ComputeParametersInput {
        train_set: items,
        enable_short_term,
        num_relearning_steps: Some(relearn.max(1)),
        ..Default::default()
    });
    match result {
        Ok(params) if params.len() == 21 => {
            unsafe { std::ptr::copy_nonoverlapping(params.as_ptr(), out, 21) };
            0
        }
        _ => 2,
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn evaluate(input: *const i32, len: usize, params: *const f32, out: *mut f32) -> i32 {
    let data = unsafe { std::slice::from_raw_parts(input, len) };
    let Some((_, _, items)) = decode(data) else { return 1 };
    let params = unsafe { std::slice::from_raw_parts(params, 21) };
    let Ok(fsrs) = FSRS::new(params) else { return 2 };
    match fsrs.evaluate(items, |_| true) {
        Ok(e) => {
            unsafe {
                *out = e.log_loss;
                *out.add(1) = e.rmse_bins;
            }
            0
        }
        Err(_) => 2,
    }
}
