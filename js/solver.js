// Timetable generator: greedy construction + ejection-chain repair with tabu.
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

  function put(u) {
    for (const m of u.members) { const n = len(m.lesson); for (const key of memberKeys(m)) { const a = occOf(key); for (let k = 0; k < n; k++) { const i = u.day * P + u.period + k; (a[i] ||= []).push(u); } } }
  }
  function take(u) {
    for (const m of u.members) { const n = len(m.lesson); for (const key of memberKeys(m)) { const a = occOf(key); for (let k = 0; k < n; k++) { const i = u.day * P + u.period + k; if (a[i]) a[i] = a[i].filter(x => x !== u); } } }
    u.day = -1; u.period = -1;
  }

  const soft = (unit, day, period) => {
    let pen = period * 0.02;
    for (const m of unit.members) {
      if (spreadDays) for (const s of unitsOfLesson[m.lesson.id]) if (s !== unit && s.day === day) pen += 3;
      for (const r of relsOfLesson[m.lesson.id] || []) {
        if (r.type !== 'berturutan') continue;
        let adjacent = false, partnerToday = false;
        for (const lid of r.lessons) {
          if (lessonById[lid].subjectId === m.lesson.subjectId || !sharesClass(lessonById[lid], m.lesson)) continue;
          for (const u of unitsOfLesson[lid] || []) if (u.day === day) {
            partnerToday = true;
            const ul = len(lessonById[lid]);
            if (u.period + ul === period || period + len(m.lesson) === u.period) adjacent = true;
          }
        }
        if (partnerToday && !adjacent) pen += 4; else if (adjacent) pen -= 2;
      }
    }
    return pen;
  };

  for (const u of units) if (u.fixed) put(u);
  const free = units.filter(u => !u.fixed);
  const domainSize = u => { let n = 0; for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) if (u.members.every(m => memberAvailable(m, d, p, null))) n++; return n; };
  for (const u of free) u.dom = domainSize(u);
  free.sort((a, b) => a.dom - b.dom || b.members.length - a.members.length || Math.max(...b.members.map(m => len(m.lesson))) - Math.max(...a.members.map(m => len(m.lesson))));

  // ejecting big (school-wide) or tightly constrained units is expensive
  const V = opts.variant ?? 0;
  const ejectCost = u => {
    const res = u.members.reduce((n, m) => n + m.lesson.groupIds.length + m.lesson.teacherIds.length, 0);
    if (V === 0) return 10 + u.members.length;
    if (V === 1) return 10 + u.members.length + (res > 6 ? 40 : 0);
    return 10 + u.members.length + (res > 6 ? 40 : 0) + 20 / Math.max(1, u.dom || 1);
  };
  const tenure = opts.tenure || 20;
  const queue = [...free];
  const tabu = new Map();
  let iter = 0;
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

  while (queue.length && Date.now() - start < timeLimit) {
    iter++;
    const qi = rnd() < 0.1 ? Math.floor(rnd() * queue.length) : 0;
    const unit = queue.splice(qi, 1)[0];
    let bestMove = null, bestScore = Infinity;
    for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) {
      const conf = new Set(), rooms = [];
      let ok = true;
      for (const m of unit.members) {
        const choices = m.lesson.roomIds?.length ? m.lesson.roomIds : [null];
        let pick = null, pickConf = null;
        for (const room of choices) {
          if (!memberAvailable(m, d, p, room)) continue;
          const c = new Set(); memberConflicts(unit, m, d, p, room, c);
          if (!pickConf || c.size < pickConf.size) { pick = room; pickConf = c; }
        }
        if (!pickConf) { ok = false; break; }
        rooms.push(pick); for (const x of pickConf) conf.add(x);
      }
      if (!ok) continue;
      relationConflicts(unit, d, p, conf);
      let lockedHit = false, cost = 0;
      for (const x of conf) { if (x.fixed) { lockedHit = true; break; } cost += ejectCost(x) + (tabu.get(x)?.[`${d}-${p}`] > iter ? 50 : 0); }
      if (lockedHit) continue;
      const score = cost + soft(unit, d, p) + rnd() * 0.5;
      if (score < bestScore) { bestScore = score; bestMove = { d, p, rooms, conf }; }
    }
    if (!bestMove) { unit.unplaceable = true; continue; }
    for (const x of bestMove.conf) { take(x); queue.push(x); }
    unit.day = bestMove.d; unit.period = bestMove.p;
    unit.members.forEach((m, i) => { m.room = bestMove.rooms[i]; });
    put(unit);
    const t = tabu.get(unit) || {}; t[`${bestMove.d}-${bestMove.p}`] = iter + tenure; tabu.set(unit, t);

    const unplaced = queue.reduce((a, u) => a + u.members.length, 0) + free.filter(u => u.unplaceable && u.day < 0).reduce((a, u) => a + u.members.length, 0);
    if (unplaced < bestUnplaced) { bestUnplaced = unplaced; best = snapshot(); }
    if (Date.now() - lastReport > 300) { lastReport = Date.now(); onProgress({ iter, unplaced, best: bestUnplaced, total: totalCards(free), elapsed: Date.now() - start }); }
  }
  const unplacedNow = units.filter(u => u.day < 0).reduce((a, u) => a + u.members.length, 0);
  if (unplacedNow <= bestUnplaced || !best) best = snapshot();
  const placed = best.filter(c => c.day >= 0);
  return { cards: placed, unplaced: best.length - placed.length, total: totalCards(free), iterations: iter, elapsed: Date.now() - start };
}
const totalCards = us => us.reduce((a, u) => a + u.members.length, 0);

function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
