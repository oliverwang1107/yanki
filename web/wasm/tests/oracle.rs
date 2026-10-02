//! 對照 Anki 後端：tests/oracle.json 由 tools/make_oracle.py 產生，
//! 內容是真實卡片在 Anki 裡按四個按鈕後的狀態。

use anki_sched::sched::{Card, Config, Kind, Next, next_states};
use serde_json::Value;
use std::collections::BTreeMap;

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn floats(v: &Value) -> Vec<f32> {
    v.as_array().map(|a| a.iter().map(|x| num(x) as f32).collect()).unwrap_or_default()
}

fn close(a: f32, b: f64, tol: f64) -> bool {
    (a as f64 - b).abs() <= tol * b.abs().max(1.0)
}

/// Anki 的負載平衡會依當天各日的到期量挑日子，結果和單純的 fuzz 範圍有出入，
/// 所以間隔只要求：不超過最長間隔，且落在 fuzz 範圍附近。
/// 還沒到期就被查看的複習卡（`early`）不比對間隔：Anki 對提早複習另有處理，真實使用也不會發生。
fn days_ok(want: u32, lo: u32, hi: u32, max: u32, early: bool) -> bool {
    let slack = 1 + hi / 8;
    want <= max && (early || (want + slack >= lo && want <= hi + slack))
}

fn memory_ok(got: (f32, f32), want: &Value) -> bool {
    close(got.0, num(&want["stability"]), 2e-4) && close(got.1, num(&want["difficulty"]), 2e-4)
}

#[test]
fn matches_anki() {
    let root: Value = serde_json::from_str(&std::fs::read_to_string("tests/oracle.json").expect("先執行 tools/make_oracle.py")).unwrap();
    let today = root["today"].as_i64().unwrap();
    let (tz, rollover) = (root["tz"].as_i64().unwrap(), root["rollover"].as_i64().unwrap());
    let web_day = |ts: i64| (ts + tz - rollover * 3600).div_euclid(86_400);

    let mut total = 0;
    let mut bad: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for case in root["cases"].as_array().unwrap() {
        let c = &case["card"];
        let cfg_json = &root["configs"][case["config"].to_string()];
        let cfg = Config {
            learn_steps: floats(&cfg_json["learnSteps"]),
            relearn_steps: floats(&cfg_json["relearnSteps"]),
            max_ivl: num(&cfg_json["maxIvl"]) as u32,
            min_lapse_ivl: num(&cfg_json["minLapseIvl"]) as u32,
            desired_retention: num(&cfg_json["desiredRetention"]) as f32,
            fsrs_params: floats(&cfg_json["params"]),
        };
        let kind = match num(&c["type"]) as u8 {
            0 => Kind::New,
            1 => Kind::Learning,
            2 => Kind::Review,
            _ => Kind::Relearning,
        };
        let card = Card {
            kind,
            remaining: (num(&c["left"]) as u32) % 1000,
            memory: c["s"].as_f64().map(|s| (s as f32, num(&c["d"]) as f32)),
            ivl: num(&c["ivl"]) as u32,
            elapsed_days: c["lrt"].as_i64().map_or(0, |t| (today - web_day(t)).max(0) as u32),
            seed: num(&c["id"]) as u64 + num(&c["reps"]) as u64,
        };
        let early = kind == Kind::Review && c["dueDay"].as_i64().is_some_and(|d| d > today);
        let got = next_states(&card, &cfg).expect("排程失敗");

        for (i, name) in ["again", "hard", "good", "easy"].iter().enumerate() {
            total += 1;
            let want = &case["expect"][*name]["normal"];
            let tag = format!("type{} {}", card.kind as u8, name);
            let fail = |why: String| format!("card {} ({why})", c["id"]);
            let result = match (got[i], want) {
                (Next::Learning { remaining, secs, memory }, w) if w.get("learning").is_some() => {
                    let l = &w["learning"];
                    if remaining != num(&l["remainingSteps"]) as u32 || secs != num(&l["scheduledSecs"]) as u32 {
                        Err(fail(format!("學習步驟 got {remaining}/{secs}s want {}/{}s", num(&l["remainingSteps"]), num(&l["scheduledSecs"]))))
                    } else if !memory_ok(memory, &l["memoryState"]) {
                        Err(fail(format!("記憶 got {memory:?} want {}", l["memoryState"])))
                    } else {
                        Ok(())
                    }
                }
                (Next::Review { days, lo, hi, memory }, w) if w.get("review").is_some() => {
                    let r = &w["review"];
                    let want_days = num(&r["scheduledDays"]) as u32;
                    if !days_ok(want_days, lo, hi, cfg.max_ivl, early) {
                        Err(fail(format!("間隔 got {days} [{lo},{hi}] want {want_days}")))
                    } else if !memory_ok(memory, &r["memoryState"]) {
                        Err(fail(format!("記憶 got {memory:?} want {}", r["memoryState"])))
                    } else {
                        Ok(())
                    }
                }
                (Next::Relearning { remaining, secs, days, lo, hi, memory }, w) if w.get("relearning").is_some() => {
                    let (r, l) = (&w["relearning"]["review"], &w["relearning"]["learning"]);
                    let want_days = num(&r["scheduledDays"]) as u32;
                    if remaining != num(&l["remainingSteps"]) as u32 || secs != num(&l["scheduledSecs"]) as u32 {
                        Err(fail(format!("重學步驟 got {remaining}/{secs}s want {}/{}s", num(&l["remainingSteps"]), num(&l["scheduledSecs"]))))
                    } else if !days_ok(want_days, lo, hi, cfg.max_ivl, early) {
                        Err(fail(format!("重學後間隔 got {days} [{lo},{hi}] want {want_days}")))
                    } else if !memory_ok(memory, &l["memoryState"]) {
                        Err(fail(format!("記憶 got {memory:?} want {}", l["memoryState"])))
                    } else {
                        Ok(())
                    }
                }
                (got, w) => Err(fail(format!("狀態種類不同 got {got:?} want {w}"))),
            };
            if let Err(msg) = result {
                bad.entry(tag).or_default().push(msg);
            }
        }
    }

    let failures: usize = bad.values().map(Vec::len).sum();
    println!("比對 {total} 項，不一致 {failures} 項");
    for (tag, msgs) in &bad {
        println!("[{tag}] {} 項", msgs.len());
        for m in msgs.iter().take(3) {
            println!("    {m}");
        }
    }
    assert_eq!(failures, 0, "與 Anki 的結果不一致");
}
