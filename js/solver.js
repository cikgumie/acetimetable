// Timetable generator, modelled on the phases of the original engine (own implementation):
//  1. construction with ejection of conflicting cards ("vykop"), most-constrained-first ("min tries"),
//  2. stagnation detection -> scatter part of the timetable ("rozhadzovanie"), optional relaxation ("zlava"),
//  3. points optimisation ("optimalizuj body"): move cards to reduce gaps etc. without new conflicts.
// Pure function; runs inside a Web Worker (generator-worker.js).
//
// A "unit" is what gets placed: normally one card, but cards of lessons linked by a
// "serentak" (start at the same time) relation are bundled and placed together.
import { relationLessonIds, serentakBuckets } from './relations.js';

export function solve(state, opts = {}, onProgress = () => {}) {
  const timeLimit = (opts.seconds || 20) * 1000;
  const keepExisting = opts.keepExisting !== false;
  const spreadDays = opts.spreadDays !== false;
  const rnd = mulberry(opts.seed || Date.now());
  const D = state.days.length, P = state.periods.length;
  const group = Object.fromEntries(state.groups.map(g => [g.id, g]));
  const lessonById = Object.fromEntries(state.lessons.map(l => [l.id, l]));
  const blocked = new Set();
  for (const [k, arr] of Object.entries(state.timeoff || {})) for (const dp of arr) blocked.add(k + '@' + dp);
  const classGroups = {};
  for (const g of state.groups) (classGroups[g.classId] ||= []).push(g);
  const clash = (a, b) => a.classId === b.classId && (a.id === b.id || a.division === 0 || b.division === 0 || a.division !== b.division);
  const len = l => Math.max(1, l.periodsPerCard || 1);
  const lessonsClash = (a, b) => a.subjectId === b.subjectId || a.teacherIds.some(t => b.teacherIds.includes(t)) ||
    a.groupIds.some(x => b.groupIds.some(y => group[x] && group[y] && clash(group[x], group[y])));

  // ---------- relations ----------
  const rels = (state.relations || []).map(r => ({ ...r, lessons: new Set(relationLessonIds(state, r)) }));
  // union-find lessons joined by "serentak"
  const parent = {};
  const find = x => (parent[x] === undefined || parent[x] === x ? (parent[x] = x) : (parent[x] = find(parent[x])));
  for (const r of rels) if (r.type === 'serentak') for (const b of serentakBuckets(state, r, lessonById)) for (let i = 1; i < b.length; i++) parent[find(b[i].id)] = find(b[0].id);
  const relsOfLesson = {};
  for (const r of rels) for (const l of r.lessons) (relsOfLesson[l] ||= []).push(r);

  // ---------- cards & units ----------
  const units = [];
  const kept = keepExisting ? state.cards.filter(c => lessonById[c.lessonId]) : state.cards.filter(c => c.locked && lessonById[c.lessonId]);
  const countByLesson = {};
  for (const c of kept) {
    countByLesson[c.lessonId] = (countByLesson[c.lessonId] || 0) + 1;
    units.push({ members: [{ lesson: lessonById[c.lessonId], room: c.roomId, id: c.id, locked: !!c.locked }], day: c.day, period: c.period, fixed: true });
  }
  const pending = {}; // component -> lessonId -> count
  for (const l of state.lessons) {
    const need = (l.cardsPerWeek || 0) - (countByLesson[l.id] || 0);
    if (need <= 0) continue;
    const comp = find(l.id);
    ((pending[comp] ||= {})[l.id] = need);
  }
  for (const comp of Object.keys(pending)) {
    const per = pending[comp];
    const max = Math.max(...Object.values(per));
    for (let k = 0; k < max; k++) {
      // split into bundles whose members never clash with each other (different teachers & compatible groups)
      const bundles = [];
      for (const [lid, n] of Object.entries(per)) {
        if (n <= k) continue;
        const l = lessonById[lid];
        const home = bundles.find(b => b.every(m => !lessonsClash(m.lesson, l)));
        (home || (bundles[bundles.length] = [])).push({ lesson: l, room: null });
      }
      for (const members of bundles) units.push({ members, day: -1, period: -1, fixed: false });
    }
  }
  const unitsOfLesson = {};
  for (const u of units) for (const m of u.members) (unitsOfLesson[m.lesson.id] ||= []).push(u);

  // ---------- occupancy ----------
  const occ = new Map();
  const occOf = key => { let a = occ.get(key); if (!a) { a = new Array(D * P).fill(null); occ.set(key, a); } return a; };
  const memberKeys = m => {
    const keys = m.lesson.teacherIds.map(t => 't:' + t).concat(m.lesson.groupIds.map(g => 'g:' + g));
    if (m.room) keys.push('r:' + m.room);
    return keys;
  };
  const classKeysFor = l => [...new Set(l.groupIds.map(g => group[g]?.classId).filter(Boolean))].map(c => 'c:' + c);

  function memberAvailable(m, day, period, room) {
    const l = m.lesson, n = len(l);
    if (period + n > P) return false;
    for (let k = 0; k < n; k++) {
      const dp = `${day}-${period + k}`;
      for (const t of l.teacherIds) if (blocked.has('t:' + t + '@' + dp)) return false;
      for (const ck of classKeysFor(l)) if (blocked.has(ck + '@' + dp)) return false;
      if (blocked.has('s:' + l.subjectId + '@' + dp)) return false;
      if (room && blocked.has('r:' + room + '@' + dp)) return false;
    }
    return true;
  }
  function memberConflicts(unit, m, day, period, room, out) {
    const l = m.lesson, n = len(l);
    for (let k = 0; k < n; k++) {
      const i = day * P + period + k;
      for (const t of l.teacherIds) { const c = occ.get('t:' + t)?.[i]; if (c) for (const x of c) if (x !== unit) out.add(x); }
      if (room) { const c = occ.get('r:' + room)?.[i]; if (c) for (const x of c) if (x !== unit) out.add(x); }
      for (const gid of l.groupIds) {
        const g = group[gid]; if (!g) continue;
        for (const og of classGroups[g.classId] || []) {
          if (!clash(g, og)) continue;
          const c = occ.get('g:' + og.id)?.[i]; if (c) for (const x of c) if (x !== unit) out.add(x);
        }
      }
    }
  }
  // relation-driven conflicts (ejectable) for placing unit at day/period
  function relationConflicts(unit, day, period, out) {
    for (const m of unit.members) for (const r of relsOfLesson[m.lesson.id] || []) {
      if (r.type === 'waktuSama') {
        for (const lid of r.lessons) for (const u of unitsOfLesson[lid] || []) if (u !== unit && u.day >= 0 && u.period !== period) out.add(u);
      } else if (r.type === 'tidakHariSama') {
        const mySub = m.lesson.subjectId;
        for (const lid of r.lessons) {
          if (lessonById[lid].subjectId === mySub) continue;
          if (!sharesClass(lessonById[lid], m.lesson)) continue;
          for (const u of unitsOfLesson[lid] || []) if (u !== unit && u.day === day) out.add(u);
        }
      }
    }
  }
  const sharesClass = (a, b) => { const ca = new Set(classKeysFor(a)); return classKeysFor(b).some(x => ca.has(x)); };

  let put = function (u) {
    for (const m of u.members) { const n = len(m.lesson); for (const key of memberKeys(m)) { const a = occOf(key); for (let k = 0; k < n; k++) { const i = u.day * P + u.period + k; (a[i] ||= []).push(u); } } }
  };
  let take = function (u) {
    for (const m of u.members) { const n = len(m.lesson); for (const key of memberKeys(m)) { const a = occOf(key); for (let k = 0; k < n; k++) { const i = u.day * P + u.period + k; if (a[i]) a[i] = a[i].filter(x => x !== u); } } }
    u.day = -1; u.period = -1;
  };

  // ---------- soft score ("body" / points) ----------
  // Penalties mirror the kinds of conditions the original engine weighs: class gaps, teacher gaps,
  // teacher consecutive periods, one card of a lesson per day, relation preferences, early periods.
  const W = {
    classGap: opts.classGaps === false ? 0 : (opts.classGapWeight ?? 3),
    teacherGap: opts.teacherGaps === false ? 0 : 1,
    consec: 6,
    spread: spreadDays ? 4 : 0,
    early: 0.03,
  };
  const maxConsec = opts.maxConsecutive || 0; // 0 = no limit
  const clsCnt = {}, tchCnt = {};
  const cntOf = (o, k) => (o[k] ||= new Int16Array(D * P));
  const classIdsOf = l => [...new Set(l.groupIds.map(g => group[g]?.classId).filter(Boolean))];
  const avail = {}; // class -> per-day bitmask of usable periods
  for (const c of state.classes) {
    avail[c.id] = Array.from({ length: D }, (_, d) => { let m = 0; for (let p = 0; p < P; p++) if (!blocked.has(`c:${c.id}@${d}-${p}`)) m |= 1 << p; return m; });
  }
  const tAvailC = {};
  const tAvail = t => { const a = []; for (let d = 0; d < D; d++) { let m = 0; for (let p = 0; p < P; p++) if (!blocked.has(`t:${t}@${d}-${p}`)) m |= 1 << p; a.push(m); } return a; };
  const maskOf = (arr, d) => { let m = 0; for (let p = 0; p < P; p++) if (arr[d * P + p] > 0) m |= 1 << p; return m; };
  const gaps = (m, a) => { if (!m) return 0; const lo = 31 - Math.clz32(m & -m), hi = 31 - Math.clz32(m); let g = 0; for (let p = lo + 1; p < hi; p++) if ((a >> p & 1) && !(m >> p & 1)) g++; return g; };
  const overflow = (m, lim) => { if (!lim) return 0; let run = 0, o = 0; for (let p = 0; p <= P; p++) { if (p < P && (m >> p & 1)) run++; else { if (run > lim) o += run - lim; run = 0; } } return o; };
  const pop = m => { let c = 0; while (m) { m &= m - 1; c++; } return c; };
  const over = (v, lim) => (lim == null ? 0 : Math.max(0, v - lim));
  // per-entity limits (teacher/class "constraints"), falling back to the global settings
  const tLim = Object.fromEntries((state.teachers || []).map(t => [t.id, t.limits || {}]));
  const cLim = Object.fromEntries((state.classes || []).map(c => [c.id, c.limits || {}]));
  const gLim = { maxConsecutive: maxConsec || null, maxGapsDay: opts.maxGapsDay ?? null, maxGapsWeek: opts.maxGapsWeek ?? null };
  const HARD = 15;
  const span = (p, n) => ((1 << n) - 1) << p;

  function trackPut(u, sign) {
    for (const m of u.members) {
      const n = len(m.lesson);
      for (const c of classIdsOf(m.lesson)) { const a = cntOf(clsCnt, c); for (let k = 0; k < n; k++) a[u.day * P + u.period + k] += sign; }
      for (const t of m.lesson.teacherIds) { const a = cntOf(tchCnt, t); for (let k = 0; k < n; k++) a[u.day * P + u.period + k] += sign; }
    }
  }
  // incremental soft cost of placing unit at (day, period) given the current state (unit itself not placed)
  function soft(unit, day, period) {
    let pen = period * W.early;
    const cAdd = {}, tAdd = {};
    for (const m of unit.members) {
      const add = span(period, len(m.lesson));
      for (const c of classIdsOf(m.lesson)) cAdd[c] = (cAdd[c] || 0) | add;
      for (const t of m.lesson.teacherIds) tAdd[t] = (tAdd[t] || 0) | add;
      if (W.spread) for (const s of unitsOfLesson[m.lesson.id]) if (s !== unit && s.day === day) pen += W.spread;
      for (const r of relsOfLesson[m.lesson.id] || []) {
        if (r.type !== 'berturutan') continue;
        let adjacent = false, partnerToday = false;
        for (const lid of r.lessons) {
          if (lessonById[lid].subjectId === m.lesson.subjectId || !sharesClass(lessonById[lid], m.lesson)) continue;
          for (const u of unitsOfLesson[lid] || []) if (u.day === day) {
            partnerToday = true;
            if (u.period + len(lessonById[lid]) === period || period + len(m.lesson) === u.period) adjacent = true;
          }
        }
        if (partnerToday && !adjacent) pen += 4; else if (adjacent) pen -= 2;
      }
    }
    for (const [c, add] of Object.entries(cAdd)) {
      const arr = cntOf(clsCnt, c), cur = maskOf(arr, day), a = avail[c]?.[day] ?? -1;
      if (W.classGap) pen += W.classGap * (gaps(cur | add, a) - gaps(cur, a));
      const L = cLim[c];
      if (L && L.maxPerDay != null) pen += HARD * (over(pop(cur | add), L.maxPerDay) - over(pop(cur), L.maxPerDay));
    }
    for (const [t, add] of Object.entries(tAdd)) {
      const arr = cntOf(tchCnt, t), cur = maskOf(arr, day), a = (tAvailC[t] ||= tAvail(t))[day];
      const L = tLim[t] || {};
      const g0 = gaps(cur, a), g1 = gaps(cur | add, a);
      if (W.teacherGap) pen += W.teacherGap * (g1 - g0);
      const gd = L.maxGapsDay ?? gLim.maxGapsDay;
      if (gd != null) pen += HARD * (over(g1, gd) - over(g0, gd));
      const gw = L.maxGapsWeek ?? gLim.maxGapsWeek;
      if (gw != null) {
        let wk = 0; for (let d = 0; d < D; d++) wk += gaps(maskOf(arr, d), tAvailC[t][d]);
        pen += HARD * (over(wk - g0 + g1, gw) - over(wk, gw));
      }
      const mc = L.maxConsecutive ?? gLim.maxConsecutive;
      if (mc) pen += W.consec * (overflow(cur | add, mc) - overflow(cur, mc));
      if (L.maxPerDay != null) pen += HARD * (over(pop(cur | add), L.maxPerDay) - over(pop(cur), L.maxPerDay));
      if (L.maxDays != null && !cur) {
        let used = 0; for (let d = 0; d < D; d++) if (maskOf(arr, d)) used++;
        if (used + 1 > L.maxDays) pen += HARD;
      }
    }
    return pen;
  }
  const put0 = put, take0 = take;
  put = u => { put0(u); trackPut(u, 1); };
  take = u => { if (u.day >= 0) trackPut(u, -1); take0(u); };

  for (const u of units) if (u.fixed) put(u);
  const free = units.filter(u => !u.fixed);
  const domainSize = u => { let n = 0; for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) if (u.members.every(m => memberAvailable(m, d, p, null))) n++; return n; };
  for (const u of free) u.dom = domainSize(u);
  free.sort((a, b) => a.dom - b.dom || b.members.length - a.members.length || Math.max(...b.members.map(m => len(m.lesson))) - Math.max(...a.members.map(m => len(m.lesson))));

  let relaxed = false;
  // candidate evaluation shared by all phases
  function evaluate(unit, d, p) {
    const conf = new Set(), rooms = [];
    for (const m of unit.members) {
      const choices = m.lesson.roomIds?.length ? m.lesson.roomIds : [null];
      let pick = null, pickConf = null;
      for (const room of choices) {
        if (!memberAvailable(m, d, p, room)) continue;
        const c = new Set(); memberConflicts(unit, m, d, p, room, c);
        if (!pickConf || c.size < pickConf.size) { pick = room; pickConf = c; }
      }
      if (!pickConf) return null;
      rooms.push(pick); for (const x of pickConf) conf.add(x);
    }
    if (!relaxed) relationConflicts(unit, d, p, conf);
    if (spreadDays) for (const m of unit.members) if (m.lesson.cardsPerWeek <= D) for (const s of unitsOfLesson[m.lesson.id]) if (s !== unit && s.day === d) conf.add(s);
    return { conf, rooms };
  }
  const tries = unit => { let n = 0; for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) { const e = evaluate(unit, d, p); if (e && !e.conf.size) n++; } return n; };

  const tenure = opts.tenure || 20;
  const ejectCost = u => 10 + u.members.length;
  const queue = [...free];
  const tabu = new Map();
  let iter = 0, scatters = 0, lastImprove = 0;
  const start = Date.now();
  let best = null, bestUnplaced = Infinity, lastReport = 0;
  const snapshot = () => {
    const out = [];
    for (const u of units) {
      if (u.fixed && !keepExisting && !u.members[0].locked) continue;
      for (const m of u.members) out.push({ lessonId: m.lesson.id, day: u.day, period: u.period, roomId: m.room, locked: !!m.locked, id: m.id });
    }
    return out;
  };
  const unplacedCount = () => free.reduce((a, u) => a + (u.day < 0 ? u.members.length : 0), 0);
  const stagnLimit = opts.stagnation || Math.max(20000, free.length * 40);
  const constructEnd = timeLimit * (1 - (opts.optimizeShare ?? 0.25));

  // ---------- phase 1: construction + ejection ("vykop") with min-tries ordering ----------
  while (queue.length && Date.now() - start < constructEnd) {
    iter++;
    let qi = 0;
    if (queue.length <= (opts.mrv ?? 0)) { // dynamic most-constrained-first once the queue is small
      let bt = Infinity;
      queue.forEach((u, i) => { const t = tries(u) + rnd() * 0.5; if (t < bt) { bt = t; qi = i; } });
    } else if (rnd() < 0.1) qi = Math.floor(rnd() * queue.length);
    const unit = queue.splice(qi, 1)[0];
    let bestMove = null, bestScore = Infinity;
    for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) {
      const e = evaluate(unit, d, p); if (!e) continue;
      let lockedHit = false, cost = 0;
      for (const x of e.conf) { if (x.fixed) { lockedHit = true; break; } cost += ejectCost(x) + (tabu.get(x)?.[`${d}-${p}`] > iter ? 50 : 0); }
      if (lockedHit) continue;
      const score = cost + soft(unit, d, p) + rnd() * 0.5;
      if (score < bestScore) { bestScore = score; bestMove = { d, p, rooms: e.rooms, conf: e.conf }; }
    }
    if (!bestMove) { unit.unplaceable = true; continue; }
    for (const x of bestMove.conf) { take(x); queue.push(x); }
    unit.day = bestMove.d; unit.period = bestMove.p;
    unit.members.forEach((m, i) => { m.room = bestMove.rooms[i]; });
    put(unit);
    const t = tabu.get(unit) || {}; t[`${bestMove.d}-${bestMove.p}`] = iter + tenure; tabu.set(unit, t);

    const unplaced = queue.reduce((a, u) => a + u.members.length, 0) + free.filter(u => u.unplaceable && u.day < 0).reduce((a, u) => a + u.members.length, 0);
    if (unplaced < bestUnplaced) { bestUnplaced = unplaced; best = snapshot(); lastImprove = iter; }
    // stagnation ("mrtvost") -> scatter part of the timetable ("rozhadzovanie")
    if (iter - lastImprove > stagnLimit) {
      scatters++; lastImprove = iter;
      const placedU = free.filter(u => u.day >= 0);
      const k = Math.max(3, Math.floor(placedU.length * 0.04));
      for (let i = 0; i < k; i++) { const u = placedU[Math.floor(rnd() * placedU.length)]; if (u.day >= 0) { take(u); queue.push(u); } }
      // relax relation conditions after repeated stagnation ("zlava")
      if (scatters >= 3 && opts.allowRelax === true && !relaxed) relaxed = true;
    }
    if (Date.now() - lastReport > 300) { lastReport = Date.now(); onProgress({ phase: 'jana', iter, unplaced, best: bestUnplaced, total: totalCards(free), elapsed: Date.now() - start, relaxed, scatters }); }
  }

  // restore the best construction if the current one is worse
  if (best && unplacedCount() > bestUnplaced) {
    for (const u of free) if (u.day >= 0) take(u);
    const byLesson = new Map();
    for (const c of best) if (c.day >= 0 && !c.id) { if (!byLesson.has(c.lessonId)) byLesson.set(c.lessonId, []); byLesson.get(c.lessonId).push(c); }
    for (const u of free) {
      const c0 = byLesson.get(u.members[0].lesson.id)?.shift();
      if (!c0) continue;
      for (let i = 1; i < u.members.length; i++) byLesson.get(u.members[i].lesson.id)?.shift();
      u.day = c0.day; u.period = c0.period; u.members[0].room = c0.roomId; put(u);
    }
  }

  // ---------- phase 2: optimise points ("optimalizuj body") without creating conflicts ----------
  // swap: u (already taken out of d0/p0) goes to a slot held by exactly one unit v, and v moves into d0/p0.
  function trySwap(u, d0, p0, rooms0, cur) {
    const order = [];
    for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) if (!(d === d0 && p === p0)) order.push([d, p]);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const [d, p] of order.slice(0, 30)) {
      const e = evaluate(u, d, p); if (!e || e.conf.size !== 1) continue;
      const v = [...e.conf][0]; if (v.fixed || v.day < 0) continue;
      const dv = v.day, pv = v.period, roomsV = v.members.map(m => m.room);
      take(v);
      const vOld = soft(v, dv, pv);
      const e2 = evaluate(u, d, p);
      if (!e2 || e2.conf.size) { v.day = dv; v.period = pv; put(v); continue; }
      const uNew = soft(u, d, p);
      u.day = d; u.period = p; u.members.forEach((m, i) => { m.room = e2.rooms[i]; }); put(u);
      const ev = evaluate(v, d0, p0);
      if (ev && !ev.conf.size) {
        const vNew = soft(v, d0, p0);
        if (uNew + vNew < cur + vOld - 1e-6) { v.day = d0; v.period = p0; v.members.forEach((m, i) => { m.room = ev.rooms[i]; }); put(v); return true; }
      }
      take(u);
      v.day = dv; v.period = pv; v.members.forEach((m, i) => { m.room = roomsV[i]; }); put(v);
    }
    return false;
  }
  let moves = 0, optIter = 0;
  const movable = free.filter(u => u.day >= 0);
  while (movable.length && Date.now() - start < timeLimit) {
    optIter++;
    const u = movable[Math.floor(rnd() * movable.length)];
    if (u.day < 0) continue;
    const d0 = u.day, p0 = u.period, rooms0 = u.members.map(m => m.room);
    take(u);
    const cur = soft(u, d0, p0);
    let bestPos = null, bestCost = cur - 1e-6;
    for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) {
      if (d === d0 && p === p0) continue;
      const e = evaluate(u, d, p); if (!e || e.conf.size) continue;
      const c = soft(u, d, p);
      if (c < bestCost) { bestCost = c; bestPos = { d, p, rooms: e.rooms }; }
    }
    if (bestPos) { u.day = bestPos.d; u.period = bestPos.p; u.members.forEach((m, i) => { m.room = bestPos.rooms[i]; }); moves++; put(u); }
    else if (trySwap(u, d0, p0, rooms0, cur)) moves++;
    else { u.day = d0; u.period = p0; u.members.forEach((m, i) => { m.room = rooms0[i]; }); put(u); }
    if (Date.now() - lastReport > 300) { lastReport = Date.now(); onProgress({ phase: 'optimum', iter: iter + optIter, unplaced: unplacedCount(), best: bestUnplaced, total: totalCards(free), elapsed: Date.now() - start, moves }); }
  }

  const final = snapshot();
  const placedCards = final.filter(c => c.day >= 0);
  return { cards: placedCards, unplaced: final.length - placedCards.length, total: totalCards(free), iterations: iter + optIter, elapsed: Date.now() - start, relaxed, scatters, moves };
}
const totalCards = us => us.reduce((a, u) => a + u.members.length, 0);

function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
