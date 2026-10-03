// 今天要讀哪些卡：各牌組（含上層牌組）的每日新卡／複習上限都要遵守。
import { cfgOf, cfgValue, depth, index, inTree, nextDayAt, store, today } from "./core.js";

// 今天已經讀過的新卡／複習數，依牌組統計（沿用 Anki 的算法：新卡 = 第一次作答，複習 = 型態 1）
export function doneToday() {
  const done = new Map();
  const start = nextDayAt() - 86400;
  for (const r of store.revlog.values()) {
    if (r.id / 1000 < start) continue;
    const card = store.cards.get(r.cid);
    if (!card) continue;
    const e = done.get(card.did) ?? { new: 0, rev: 0 };
    if (r.type === 0 && r.last_ivl === 0) e.new++;
    else if (r.type === 1) e.rev++;
    done.set(card.did, e);
  }
  return done;
}

// 依牌組分組，只含可以讀的狀態（暫停、擱置的不算）。
export function groupCards() {
  const t = today();
  const dayEnd = nextDayAt();
  const groups = new Map(index.decks.map((d) => [d.id, { rev: [], new: [], learn: [] }]));
  for (const c of store.cards.values()) {
    const g = groups.get(c.did);
    if (!g) continue;
    if (c.queue === 1) {
      if (c.due_ts < dayEnd) g.learn.push(c);
    } else if (c.queue === 2) {
      if (c.due_day <= t) g.rev.push(c);
    } else if (c.queue === 0) g.new.push(c);
  }
  return groups;
}

const shuffle = (list) => {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};

// 以 rootId 為起點規劃今天的卡。回傳 { ids, learning, rev, new }。
export function plan(rootId, { done = doneToday(), groups = groupCards() } = {}) {
  const root = index.deckById.get(rootId);
  const subs = index.decks.filter((d) => inTree(d, root));
  const ids = new Set(subs.map((d) => d.id));

  // 每個牌組今天還能讀多少：上限減去它（含子牌組）已經讀過的
  const remaining = new Map(
    subs.map((d) => {
      const c = cfgOf(d.id);
      const used = subs.filter((s) => inTree(s, d)).reduce((a, s) => ({ new: a.new + (done.get(s.id)?.new ?? 0), rev: a.rev + (done.get(s.id)?.rev ?? 0) }), { new: 0, rev: 0 });
      return [d.id, { new: Math.max(0, c.newPerDay - used.new), rev: Math.max(0, c.revPerDay - used.rev) }];
    })
  );
  const chain = (d) => subs.filter((a) => inTree(d, a));
  const take = (list, kind, deck) => {
    const caps = chain(deck).map((a) => remaining.get(a.id));
    const out = [];
    for (const c of list) {
      if (caps.some((cap) => cap[kind] <= 0)) break;
      caps.forEach((cap) => cap[kind]--);
      out.push(c);
    }
    return out;
  };

  const rev = [];
  const newc = [];
  const learning = [];
  for (const d of subs) {
    const g = groups.get(d.id);
    learning.push(...g.learn);
    const reviews = [...g.rev].sort((a, b) => a.due_day - b.due_day || Math.random() - 0.5);
    const news = cfgValue(cfgOf(d.id), "newOrder") === "random" ? shuffle([...g.new]) : [...g.new].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
    rev.push(...take(reviews, "rev", d));
    newc.push(...take(news, "new", d));
  }
  learning.sort((a, b) => a.due_ts - b.due_ts);
  return { ids, learning, rev, new: newc };
}

// 每個牌組（含子牌組）的完成進度：total = 全部卡片，left = 還沒學過的新卡，seen = total - left。
// 和統計頁的「目標進度」同一個算法（只看卡片型態，不管暫停與否）。
export function deckProgress() {
  const own = new Map();
  for (const c of store.cards.values()) {
    const e = own.get(c.did) ?? { total: 0, left: 0 };
    e.total++;
    if (c.type === 0) e.left++;
    own.set(c.did, e);
  }
  return new Map(
    index.decks.map((d) => {
      let total = 0;
      let left = 0;
      for (const [id, e] of own) {
        const sub = index.deckById.get(id);
        if (sub && inTree(sub, d)) {
          total += e.total;
          left += e.left;
        }
      }
      return [d.id, { total, left, seen: total - left }];
    })
  );
}

// 牌組列表用：每個牌組的新卡／學習／複習數量，以及整個子樹的卡片總數與完成進度。
export function deckCounts() {
  const done = doneToday();
  const groups = groupCards();
  const progress = deckProgress();
  return index.decks.map((d) => {
    const { total, left, seen } = progress.get(d.id);
    const p = plan(d.id, { done, groups });
    return { deck: d, depth: depth(d), total, left, seen, new: p.new.length, learn: p.learning.length, due: p.rev.length };
  });
}
