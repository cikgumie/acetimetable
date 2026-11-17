// Timetable generator: greedy construction + ejection-chain repair with tabu.
// Pure function; runs inside a Web Worker (generator-worker.js).

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

  // resources: teacher t:, group-atom per class, room r:
  // class groups are expanded into "atoms": a slot is busy for group g if any clashing group occupies it.
  const classGroups = {};
  for (const g of state.groups) (classGroups[g.classId] ||= []).push(g);
  const clash = (a, b) => a.classId === b.classId && (a.id === b.id || a.division === 0 || b.division === 0 || a.division !== b.division);

  // occupancy: key -> Int32Array(D*P) of card index+1 (teachers/rooms), classes keep lists
  const occ = new Map();
  const occOf = key => { let a = occ.get(key); if (!a) { a = new Array(D * P).fill(null); occ.set(key, a); } return a; };

  const cards = []; // {lesson, day, period, room, locked, fixed}
  const kept = keepExisting ? state.cards.filter(c => lessonById[c.lessonId]) : state.cards.filter(c => c.locked && lessonById[c.lessonId]);
  const countByLesson = {};
  for (const c of kept) {
    countByLesson[c.lessonId] = (countByLesson[c.lessonId] || 0) + 1;
    cards.push({ lesson: lessonById[c.lessonId], day: c.day, period: c.period, room: c.roomId, locked: true, id: c.id, src: c });
  }
  for (const l of state.lessons) {
    const need = (l.cardsPerWeek || 0) - (countByLesson[l.id] || 0);
    for (let k = 0; k < need; k++) cards.push({ lesson: l, day: -1, period: -1, room: null, locked: false });
  }

  const resKeys = (card) => {
    const l = card.lesson, keys = [];
    for (const t of l.teacherIds) keys.push('t:' + t);
    for (const g of l.groupIds) keys.push('g:' + g);
    if (card.room) keys.push('r:' + card.room);
    return keys;
  };
  const classKeysFor = (l) => [...new Set(l.groupIds.map(g => group[g]?.classId).filter(Boolean))].map(c => 'c:' + c);

  function available(card, day, period, room) {
    const l = card.lesson, len = Math.max(1, l.periodsPerCard);
    if (period + len > P) return false;
    for (let k = 0; k < len; k++) {
      const dp = `${day}-${period + k}`;
      for (const t of l.teacherIds) if (blocked.has('t:' + t + '@' + dp)) return false;
      for (const ck of classKeysFor(l)) if (blocked.has(ck + '@' + dp)) return false;
      if (blocked.has('s:' + l.subjectId + '@' + dp)) return false;
      if (room && blocked.has('r:' + room + '@' + dp)) return false;
    }
    return true;
  }

  // conflicting cards if `card` placed at (day, period, room)
  function conflicts(card, day, period, room) {
    const l = card.lesson, len = Math.max(1, l.periodsPerCard), out = new Set();
    for (let k = 0; k < len; k++) {
      const i = day * P + period + k;
      for (const t of l.teacherIds) { const c = occ.get('t:' + t)?.[i]; if (c) for (const x of c) if (x !== card) out.add(x); }
      if (room) { const c = occ.get('r:' + room)?.[i]; if (c) for (const x of c) if (x !== card) out.add(x); }
      for (const gid of l.groupIds) {
        const g = group[gid]; if (!g) continue;
        for (const og of classGroups[g.classId] || []) {
          if (!clash(g, og)) continue;
          const c = occ.get('g:' + og.id)?.[i]; if (c) for (const x of c) if (x !== card) out.add(x);
        }
      }
    }
    return out;
  }

  function put(card) {
    const len = Math.max(1, card.lesson.periodsPerCard);
    for (const key of resKeys(card)) { const a = occOf(key); for (let k = 0; k < len; k++) { const i = card.day * P + card.period + k; (a[i] ||= []).push(card); } }
  }
  function take(card) {
    const len = Math.max(1, card.lesson.periodsPerCard);
    for (const key of resKeys(card)) { const a = occOf(key); for (let k = 0; k < len; k++) { const i = card.day * P + card.period + k; if (a[i]) a[i] = a[i].filter(x => x !== card); } }
    card.day = -1; card.period = -1;
  }

  const siblings = {};
  for (const c of cards) (siblings[c.lesson.id] ||= []).push(c);
  const soft = (card, day, period) => {
    let pen = 0;
    if (spreadDays) for (const s of siblings[card.lesson.id]) if (s !== card && s.day === day) pen += 3;
    // prefer earlier periods slightly, avoid isolated late slots
    pen += period * 0.02;
    return pen;
  };

  for (const c of cards) if (c.locked) put(c);
  const free = cards.filter(c => !c.locked);
  // most constrained first: longer cards, more resources, fewer available slots
  const domainSize = c => { let n = 0; for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) if (available(c, d, p, null)) n++; return n; };
  for (const c of free) c.dom = domainSize(c);
  free.sort((a, b) => a.dom - b.dom || b.lesson.periodsPerCard - a.lesson.periodsPerCard || (b.lesson.teacherIds.length + b.lesson.groupIds.length) - (a.lesson.teacherIds.length + a.lesson.groupIds.length));

  const roomChoices = c => (c.lesson.roomIds && c.lesson.roomIds.length ? c.lesson.roomIds : [null]);
  const queue = [...free];
  const tabu = new Map();
  let iter = 0;
  const start = Date.now();
  let best = null, bestUnplaced = Infinity, lastReport = 0;

  const snapshot = () => cards.filter(c => !c.locked || keepExisting).map(c => ({ lessonId: c.lesson.id, day: c.day, period: c.period, roomId: c.room, locked: !!c.src?.locked, id: c.id }));

  while (queue.length && Date.now() - start < timeLimit) {
    iter++;
    // pick next: the one at the front, but occasionally random to diversify
    const qi = rnd() < 0.1 ? Math.floor(rnd() * queue.length) : 0;
    const card = queue.splice(qi, 1)[0];
    let bestMove = null, bestScore = Infinity;
    for (let d = 0; d < D; d++) for (let p = 0; p < P; p++) for (const room of roomChoices(card)) {
      if (!available(card, d, p, room)) continue;
      const conf = conflicts(card, d, p, room);
      let lockedHit = false, cost = 0;
      for (const x of conf) { if (x.locked) { lockedHit = true; break; } cost += 10 + (tabu.get(x)?.[`${d}-${p}`] > iter ? 50 : 0) + x.lesson.periodsPerCard; }
      if (lockedHit) continue;
      const score = cost + soft(card, d, p) + rnd() * 0.5;
      if (score < bestScore) { bestScore = score; bestMove = { d, p, room, conf }; }
    }
    if (!bestMove) { card.unplaceable = true; continue; }
    for (const x of bestMove.conf) {
      take(x);
      queue.push(x);
    }
    card.day = bestMove.d; card.period = bestMove.p; card.room = bestMove.room;
    put(card);
    const t = tabu.get(card) || {}; t[`${bestMove.d}-${bestMove.p}`] = iter + 7; tabu.set(card, t);

    const unplaced = queue.length + free.filter(c => c.unplaceable && c.day < 0).length;
    if (unplaced < bestUnplaced) { bestUnplaced = unplaced; best = snapshot(); }
    if (Date.now() - lastReport > 300) { lastReport = Date.now(); onProgress({ iter, unplaced, best: bestUnplaced, total: free.length, elapsed: Date.now() - start }); }
  }
  const unplacedNow = cards.filter(c => c.day < 0).length;
  if (unplacedNow <= bestUnplaced || !best) best = snapshot();
  const placed = best.filter(c => c.day >= 0);
  return { cards: placed, unplaced: best.length - placed.length, total: free.length, iterations: iter, elapsed: Date.now() - start };
}

function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
