// Data model, persistence and clash detection.

export const DEFAULT_DAYS = [
  { name: 'Isnin', short: 'Isn' }, { name: 'Selasa', short: 'Sel' }, { name: 'Rabu', short: 'Rab' },
  { name: 'Khamis', short: 'Kha' }, { name: 'Jumaat', short: 'Jum' },
];

const PALETTE = ['#f4a3a3', '#f7c59f', '#f9e79f', '#c5e1a5', '#a5d6a7', '#80cbc4', '#81d4fa', '#9fa8da', '#ce93d8', '#f48fb1', '#bcaaa4', '#b0bec5'];
export const pickColor = i => PALETTE[i % PALETTE.length];

let seq = Date.now() % 100000;
export const uid = p => `${p}${(seq++).toString(36)}`;

export function emptyState() {
  return {
    version: 1,
    school: { name: 'Sekolah Saya', year: String(new Date().getFullYear()) },
    days: DEFAULT_DAYS.map(d => ({ ...d })),
    periods: Array.from({ length: 8 }, (_, i) => {
      const s = 7 * 60 + 30 + i * 30, e = s + 30, f = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      return { name: String(i + 1), short: String(i + 1), start: f(s), end: f(e) };
    }),
    subjects: [], teachers: [], rooms: [], classes: [], groups: [], lessons: [], cards: [],
    timeoff: {}, // key "t:<id>" | "c:<id>" | "r:<id>" | "s:<id>" -> ["d-p", ...] blocked slots
    relief: {},  // date -> { absent: [teacherId], assign: { cardId|day-period key: teacherId } }
  };
}

const KEY = 'jadualweb.state.v1';
export function loadLocal() {
  try { const s = localStorage.getItem(KEY); if (s) return normalize(JSON.parse(s)); } catch { /* storage unavailable */ }
  return null;
}
export function saveLocal(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; } catch { return false; }
}

export function normalize(s) {
  const base = emptyState();
  const out = { ...base, ...s };
  for (const k of ['subjects', 'teachers', 'rooms', 'classes', 'groups', 'lessons', 'cards']) out[k] = Array.isArray(s[k]) ? s[k] : [];
  out.timeoff = s.timeoff || {}; out.relief = s.relief || {};
  // every class needs an "entire class" group
  for (const c of out.classes) ensureEntireGroup(out, c.id);
  return out;
}

export function ensureEntireGroup(state, classId) {
  let g = state.groups.find(x => x.classId === classId && x.division === 0);
  if (!g) { g = { id: uid('g'), classId, name: 'Seluruh kelas', division: 0 }; state.groups.push(g); }
  return g;
}

// ---------- indexes ----------
export function indexState(s) {
  const by = arr => Object.fromEntries(arr.map(x => [x.id, x]));
  return {
    subject: by(s.subjects), teacher: by(s.teachers), room: by(s.rooms), cls: by(s.classes),
    group: by(s.groups), lesson: by(s.lessons),
  };
}

export function lessonClassIds(s, lesson, ix = indexState(s)) {
  return [...new Set(lesson.groupIds.map(g => ix.group[g]?.classId).filter(Boolean))];
}

// Two groups clash unless they belong to different classes, or are distinct groups of the same division.
export function groupsClash(a, b) {
  if (a.classId !== b.classId) return false;
  if (a.id === b.id) return true;
  if (a.division === 0 || b.division === 0) return true;
  return a.division !== b.division;
}

export function cardSlots(card, lesson) {
  const n = Math.max(1, lesson?.periodsPerCard || 1), out = [];
  for (let k = 0; k < n; k++) out.push(card.period + k);
  return out;
}

// Returns Map cardId -> [reasons]
export function findClashes(s, ix = indexState(s)) {
  const res = new Map();
  const add = (id, msg) => { if (!res.has(id)) res.set(id, []); const a = res.get(id); if (!a.includes(msg)) a.push(msg); };
  const slot = new Map(); // "d-p" -> [card]
  for (const c of s.cards) {
    const l = ix.lesson[c.lessonId]; if (!l) continue;
    for (const p of cardSlots(c, l)) {
      const k = `${c.day}-${p}`; if (!slot.has(k)) slot.set(k, []); slot.get(k).push(c);
      if (p >= s.periods.length) add(c.id, 'Melebihi waktu terakhir');
    }
  }
  for (const [, list] of slot) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const la = ix.lesson[a.lessonId], lb = ix.lesson[b.lessonId];
      for (const t of la.teacherIds) if (lb.teacherIds.includes(t)) { const n = ix.teacher[t]?.short || '?'; add(a.id, `Guru ${n} bertembung`); add(b.id, `Guru ${n} bertembung`); }
      for (const ga of la.groupIds) for (const gb of lb.groupIds) {
        const A = ix.group[ga], B = ix.group[gb];
        if (A && B && groupsClash(A, B)) { const n = ix.cls[A.classId]?.short || '?'; add(a.id, `Kelas ${n} bertembung`); add(b.id, `Kelas ${n} bertembung`); }
      }
      if (a.roomId && a.roomId === b.roomId) { const n = ix.room[a.roomId]?.short || '?'; add(a.id, `Bilik ${n} bertembung`); add(b.id, `Bilik ${n} bertembung`); }
    }
  }
  // time-off
  for (const c of s.cards) {
    const l = ix.lesson[c.lessonId]; if (!l) continue;
    for (const p of cardSlots(c, l)) {
      const k = `${c.day}-${p}`;
      const keys = [...l.teacherIds.map(t => 't:' + t), ...lessonClassIds(s, l, ix).map(x => 'c:' + x), 's:' + l.subjectId];
      if (c.roomId) keys.push('r:' + c.roomId);
      for (const key of keys) if ((s.timeoff[key] || []).includes(k)) add(c.id, 'Masa tidak tersedia');
    }
  }
  return res;
}

export function placedCount(s, lessonId) { return s.cards.filter(c => c.lessonId === lessonId).length; }

export function lessonLabel(s, l, ix = indexState(s)) {
  const sub = ix.subject[l.subjectId]?.short || '?';
  const cls = l.groupIds.map(g => { const G = ix.group[g]; if (!G) return '?'; const c = ix.cls[G.classId]?.short || '?'; return G.division === 0 ? c : `${c}:${G.name}`; }).join(', ');
  const t = l.teacherIds.map(x => ix.teacher[x]?.short || '?').join(', ');
  return { sub, cls, t };
}

export function stats(s) {
  const need = s.lessons.reduce((a, l) => a + (l.cardsPerWeek || 0), 0);
  return { subjects: s.subjects.length, teachers: s.teachers.length, classes: s.classes.length, rooms: s.rooms.length, lessons: s.lessons.length, cards: s.cards.length, need };
}

export function teacherLoad(s, teacherId, ix = indexState(s)) {
  let need = 0, placed = 0;
  for (const l of s.lessons) if (l.teacherIds.includes(teacherId)) need += l.cardsPerWeek * l.periodsPerCard;
  for (const c of s.cards) { const l = ix.lesson[c.lessonId]; if (l && l.teacherIds.includes(teacherId)) placed += l.periodsPerCard; }
  return { need, placed };
}
