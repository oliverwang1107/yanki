//! 給瀏覽器用的 C ABI：JS 把輸入寫進固定的 f64 緩衝區，呼叫 `schedule()`，再從輸出緩衝區讀結果。
//! 不用 wasm-bindgen，產出的 .wasm 沒有任何 import，載入最單純。
//!
//! 輸入（f64 陣列）：
//!   0 kind(0 新卡 1 學習 2 複習 3 重學)  1 剩餘學習步驟  2 目前間隔(天)  3 stability(NaN=無)  4 difficulty
//!   5 距上次複習的學習日數  6 fuzz 種子  7 目標記憶率  8 最長間隔  9 重學最短間隔
//!   10 學習步驟數 n  11 重學步驟數 m  12 FSRS 參數數 p；接著依序是 n 個、m 個、p 個值（步驟單位為分鐘）
//! 輸出：Again、Hard、Good、Easy 各 8 個值
//!   [種類(1 學習 2 複習 3 重學), 剩餘步驟, 等待秒數, 天數, stability, difficulty, fuzz 下限, fuzz 上限]

pub mod sched;

use sched::{Card, Config, Kind, Next, next_states};

const IN_LEN: usize = 160;
const OUT_LEN: usize = 32;
static mut INPUT: [f64; IN_LEN] = [0.0; IN_LEN];
static mut OUTPUT: [f64; OUT_LEN] = [0.0; OUT_LEN];

#[unsafe(no_mangle)]
pub extern "C" fn input_ptr() -> *mut f64 {
    (&raw mut INPUT).cast()
}

#[unsafe(no_mangle)]
pub extern "C" fn output_ptr() -> *mut f64 {
    (&raw mut OUTPUT).cast()
}

fn read(input: &[f64]) -> Option<(Card, Config)> {
    let (n, m, p) = (input[10] as usize, input[11] as usize, input[12] as usize);
    if 13 + n + m + p > input.len() {
        return None;
    }
    let slice = |from: usize, len: usize| input[from..from + len].iter().map(|&x| x as f32).collect::<Vec<f32>>();
    let kind = match input[0] as u8 {
        0 => Kind::New,
        1 => Kind::Learning,
        2 => Kind::Review,
        3 => Kind::Relearning,
        _ => return None,
    };
    let card = Card {
        kind,
        remaining: input[1] as u32,
        memory: (!input[3].is_nan()).then(|| (input[3] as f32, input[4] as f32)),
        elapsed_days: input[5] as u32,
        ivl: input[2] as u32,
        seed: input[6] as u64,
    };
    let cfg = Config {
        learn_steps: slice(13, n),
        relearn_steps: slice(13 + n, m),
        max_ivl: input[8] as u32,
        min_lapse_ivl: input[9] as u32,
        desired_retention: input[7] as f32,
        fsrs_params: slice(13 + n + m, p),
    };
    Some((card, cfg))
}

/// 回傳 0 成功；1 輸入不合法；2 FSRS 計算失敗。
#[unsafe(no_mangle)]
pub extern "C" fn schedule() -> i32 {
    let (input, output) = unsafe { (&*(&raw const INPUT), &mut *(&raw mut OUTPUT)) };
    let Some((card, cfg)) = read(input) else { return 1 };
    let Ok(states) = next_states(&card, &cfg) else { return 2 };

    for (i, next) in states.iter().enumerate() {
        let o = &mut output[i * 8..i * 8 + 8];
        let (kind, remaining, secs, days, memory, lo, hi) = match *next {
            Next::Learning { remaining, secs, memory } => (1.0, remaining, secs, 0, memory, 0, 0),
            Next::Review { days, lo, hi, memory } => (2.0, 0, 0, days, memory, lo, hi),
            Next::Relearning { remaining, secs, days, lo, hi, memory } => (3.0, remaining, secs, days, memory, lo, hi),
        };
        o.copy_from_slice(&[kind, remaining as f64, secs as f64, days as f64, memory.0 as f64, memory.1 as f64, lo as f64, hi as f64]);
    }
    0
}
