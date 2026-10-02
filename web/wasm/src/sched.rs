//! Anki v3 排程（啟用 FSRS）的狀態機：學習步驟、FSRS 記憶狀態、間隔上下限與 fuzz。
//! 純 Rust、不碰 I/O，所以可以直接用 `cargo test` 對照 Anki 的答案，再編成 WASM。

use fsrs::{FSRS, MemoryState};

const SECS_PER_DAY: u32 = 86_400;

#[derive(Clone, Debug)]
pub struct Config {
    /// 學習／重學步驟（分鐘）。
    pub learn_steps: Vec<f32>,
    pub relearn_steps: Vec<f32>,
    pub max_ivl: u32,
    pub min_lapse_ivl: u32,
    pub desired_retention: f32,
    /// FSRS 參數；空陣列代表使用預設值。
    pub fsrs_params: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    New = 0,
    Learning = 1,
    Review = 2,
    Relearning = 3,
}

#[derive(Clone, Debug)]
pub struct Card {
    pub kind: Kind,
    /// 還剩幾個學習步驟（學習中／重學中）。
    pub remaining: u32,
    /// (stability, difficulty)；新卡為 None。
    pub memory: Option<(f32, f32)>,
    /// 距離上次複習的學習日數。
    pub elapsed_days: u32,
    /// 目前排定的間隔（天），複習卡用來避免 fuzz 把間隔縮短。
    pub ivl: u32,
    /// fuzz 亂數種子（卡片 id 加複習次數）。
    pub seed: u64,
}

/// 按下某個按鈕之後的狀態。`lo`/`hi` 是 fuzz 的可能範圍，`days` 是實際選中的值。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Next {
    Learning { remaining: u32, secs: u32, memory: (f32, f32) },
    Review { days: u32, lo: u32, hi: u32, memory: (f32, f32) },
    /// `days` 是重學完成後回到複習時的間隔（Anki 存在 cards.ivl）。
    Relearning { remaining: u32, secs: u32, days: u32, lo: u32, hi: u32, memory: (f32, f32) },
}

struct Steps<'a>(&'a [f32]);

impl Steps<'_> {
    fn secs_at(&self, i: usize) -> Option<u32> {
        self.0.get(i).map(|m| (m * 60.0) as u32)
    }
    fn index(&self, remaining: u32) -> usize {
        self.0.len().saturating_sub(remaining as usize)
    }
    fn again(&self) -> Option<u32> {
        self.secs_at(0)
    }
    fn hard(&self, remaining: u32) -> Option<u32> {
        let i = self.index(remaining);
        if i > 0 {
            return self.secs_at(i);
        }
        let first = self.secs_at(0)?;
        Some(match self.secs_at(1) {
            Some(second) => (first + second) / 2,
            None => (first * 3 / 2).min(first + SECS_PER_DAY),
        })
    }
    fn good(&self, remaining: u32) -> Option<u32> {
        self.secs_at(self.index(remaining) + 1)
    }
    fn remaining_for_failed(&self) -> u32 {
        self.0.len() as u32
    }
    fn remaining_for_good(&self, remaining: u32) -> u32 {
        (self.0.len() - (self.index(remaining) + 1).min(self.0.len())) as u32
    }
}

fn fuzz_bounds(interval: f32) -> (u32, u32) {
    const RANGES: [(f32, f32, f32); 3] = [(2.5, 7.0, 0.15), (7.0, 20.0, 0.10), (20.0, f32::MAX, 0.05)];
    if interval < 2.5 {
        let r = interval.round() as u32;
        return (r, r);
    }
    let delta = 1.0 + RANGES.iter().map(|&(start, end, f)| f * (interval.min(end) - start).max(0.0)).sum::<f32>();
    ((interval - delta).round() as u32, (interval + delta).round() as u32)
}

fn constrained_fuzz_bounds(interval: f32, minimum: u32, maximum: u32) -> (u32, u32) {
    let minimum = minimum.min(maximum);
    let interval = interval.clamp(minimum as f32, maximum as f32);
    let (lower, upper) = fuzz_bounds(interval);
    let (lower, mut upper) = (lower.clamp(minimum, maximum), upper.clamp(minimum, maximum));
    if upper == lower && upper > 2 && upper < maximum {
        upper = lower + 1;
    }
    (lower, upper)
}

/// 複習卡的 fuzz 下限：新間隔比上次大就至少 +1，沒變大也不讓 fuzz 把它縮短。
fn minimum_review_fuzz_interval(interval: f32, previous: u32, maximum: u32) -> u32 {
    let (_, upper) = constrained_fuzz_bounds(interval, 1, maximum);
    if interval.round() as u32 > previous {
        previous + 1
    } else if previous <= upper {
        previous
    } else {
        0
    }
}

fn unit_random(seed: u64) -> f32 {
    // splitmix64，取高 24 位元，結果落在 [0, 1)。
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    ((z ^ (z >> 31)) >> 40) as f32 / (1u64 << 24) as f32
}

/// 回傳 (選中的天數, 下限, 上限)。
fn fuzzed(interval: f32, min: u32, max: u32, seed: u64) -> (u32, u32, u32) {
    let min = min.clamp(1, max);
    let (lo, hi) = constrained_fuzz_bounds(interval, min, max);
    let pick = lo + (unit_random(seed) * (hi + 1 - lo) as f32) as u32;
    (pick.min(hi), lo, hi)
}

fn mem(m: MemoryState) -> (f32, f32) {
    (m.stability, m.difficulty)
}

pub fn next_states(card: &Card, cfg: &Config) -> Result<[Next; 4], String> {
    let fsrs = FSRS::new(&cfg.fsrs_params).map_err(|e| format!("FSRS 參數錯誤：{e:?}"))?;
    let current = card.memory.map(|(stability, difficulty)| MemoryState { stability, difficulty });
    let elapsed = if card.kind == Kind::New { 0 } else { card.elapsed_days };
    let ns = fsrs
        .next_states(current, cfg.desired_retention, elapsed)
        .map_err(|e| format!("FSRS 計算錯誤：{e:?}"))?;
    let f = [ns.again, ns.hard, ns.good, ns.easy];
    let max = cfg.max_ivl.max(1);
    let seed = card.seed;

    let learn = Steps(&cfg.learn_steps);
    let relearn = Steps(&cfg.relearn_steps);

    // 畢業（回到複習）時 Good／Easy 的間隔；Easy 至少比 Good 大 1。
    let graduate = |min: u32| {
        let good = fuzzed(f[2].interval, min, max, seed);
        let easy = fuzzed(f[3].interval, (good.0 + 1).min(max).max(min), max, seed.wrapping_add(1));
        (good, easy)
    };
    let review = |t: (u32, u32, u32), m: MemoryState| Next::Review { days: t.0, lo: t.1, hi: t.2, memory: mem(m) };

    let out = match card.kind {
        Kind::New | Kind::Learning => {
            let remaining = if card.kind == Kind::New { learn.remaining_for_failed() } else { card.remaining };
            let (good_iv, easy_iv) = graduate(1);
            let learning = |remaining: u32, secs: u32, m: MemoryState| Next::Learning { remaining, secs, memory: mem(m) };
            let again = match learn.again() {
                Some(secs) => learning(learn.remaining_for_failed(), secs, f[0].memory),
                None => review(fuzzed(f[0].interval, 1, max, seed), f[0].memory),
            };
            let hard = match learn.hard(remaining) {
                Some(secs) => learning(remaining, secs, f[1].memory),
                None => review(fuzzed(f[1].interval, 1, max, seed), f[1].memory),
            };
            let good = match learn.good(remaining) {
                Some(secs) => learning(learn.remaining_for_good(remaining), secs, f[2].memory),
                None => review(good_iv, f[2].memory),
            };
            [again, hard, good, review(easy_iv, f[3].memory)]
        }
        Kind::Review => {
            let floor = |i: usize| minimum_review_fuzz_interval(f[i].interval, card.ivl, max);
            let hard = fuzzed(f[1].interval, floor(1).max(1), max, seed);
            let good = fuzzed(f[2].interval, floor(2).max(hard.0 + 1), max, seed.wrapping_add(1));
            let easy = fuzzed(f[3].interval, floor(3).max(good.0 + 1), max, seed.wrapping_add(2));
            let lapse = fuzzed(f[0].interval, cfg.min_lapse_ivl.max(1), max, seed);
            let again = match relearn.again() {
                Some(secs) => Next::Relearning {
                    remaining: relearn.remaining_for_failed(), secs, days: lapse.0, lo: lapse.1, hi: lapse.2, memory: mem(f[0].memory),
                },
                None => review(lapse, f[0].memory),
            };
            [again, review(hard, f[1].memory), review(good, f[2].memory), review(easy, f[3].memory)]
        }
        Kind::Relearning => {
            let min = cfg.min_lapse_ivl.max(1);
            let (good_iv, easy_iv) = graduate(min);
            let relearning = |remaining: u32, secs: u32, i: usize| {
                let t = fuzzed(f[i].interval, min, max, seed);
                Next::Relearning { remaining, secs, days: t.0, lo: t.1, hi: t.2, memory: mem(f[i].memory) }
            };
            let again = match relearn.again() {
                Some(secs) => relearning(relearn.remaining_for_failed(), secs, 0),
                None => review(fuzzed(f[0].interval, min, max, seed), f[0].memory),
            };
            let hard = match relearn.hard(card.remaining) {
                Some(secs) => relearning(card.remaining, secs, 1),
                None => review(fuzzed(f[1].interval, min, max, seed), f[1].memory),
            };
            let good = match relearn.good(card.remaining) {
                Some(secs) => relearning(relearn.remaining_for_good(card.remaining), secs, 2),
                None => review(good_iv, f[2].memory),
            };
            [again, hard, good, review(easy_iv, f[3].memory)]
        }
    };
    Ok(out)
}
