// Reader for aSc TimeTables native files (.roz / .rox / .ziptt).
// Format knowledge comes from our own reverse-engineering notes (see docs/FORMAT-ROZ.md).
// Only reads data; never writes the proprietary format.

import { unzip } from './zip.js';

const MARK = [2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 1, 0];

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dec = new TextDecoder('windows-1252');
  }
  u8(i) { return this.b[i]; }
  i32(i) { return this.dv.getInt32(i, true); }
  // MFC CArchive CString: len byte (0xFF => u16 follows, 0xFFFF => u32 follows)
  cstr(i) {
    let len = this.b[i], p = i + 1;
    if (len === 0xff) {
      len = this.dv.getUint16(p, true); p += 2;
      if (len === 0xfffe) { // unicode marker
        let l2 = this.b[p]; p += 1;
        const s = new TextDecoder('utf-16le').decode(this.b.subarray(p, p + l2 * 2));
        return [s, p + l2 * 2];
      }
      if (len === 0xffff) { len = this.dv.getUint32(p, true); p += 4; }
    }
    const s = this.dec.decode(this.b.subarray(p, p + len));
    return [s, p + len];
  }
}

function findHeaders(r) {
  const b = r.b, out = [];
  outer: for (let i = 0; i < b.length - 40; i++) {
    if (b[i] !== 2) continue;
    for (let k = 1; k < 12; k++) if (b[i + k] !== MARK[k]) continue outer;
    const idStart = i + 12;
    const nameAt = idStart + 8 + 8; // 8-byte id, 7 reserved bytes + 1 flag byte
    let name, short, after;
    try {
      [name, after] = r.cstr(nameAt);
      let isClass = false;
      if (name === 'CLASSTT') { isClass = true; [name, after] = r.cstr(after); }
      const nameEnd = after;
      [short, after] = r.cstr(after);
      const color = '#' + [b[i - 3], b[i - 2], b[i - 1]].map(x => x.toString(16).padStart(2, '0')).join('');
      out.push({ pos: i, nameAt, nameEnd, name, short, after, isClass, color });
    } catch { /* ignore */ }
    i += 11;
  }
  for (let k = 0; k < out.length; k++) out[k].size = (k + 1 < out.length ? out[k + 1].pos : b.length) - out[k].pos;
  return out;
}

function readPeriod(r, h) {
  // after flag byte: int32 number, 3 flag bytes, CString name, CString short, start h/m, end h/m (int32 each)
  const p = h.nameAt;
  if (p + 40 > r.b.length) return null;
  const num = r.i32(p);
  if (!(num >= 0 && num < 40)) return null;
  let name, short, q;
  try { [name, q] = r.cstr(p + 7); [short, q] = r.cstr(q); } catch { return null; }
  if (name.length > 40 || short.length > 40) return null;
  const sh = r.i32(q), sm = r.i32(q + 4), eh = r.i32(q + 8), em = r.i32(q + 12);
  const ok = sh >= 0 && sh < 24 && sm >= 0 && sm < 60 && eh >= 0 && eh < 24 && em >= 0 && em < 60 && (eh * 60 + em) > (sh * 60 + sm);
  if (!ok) return null;
  const f = n => String(n).padStart(2, '0');
  return { num, name: name || String(num), short: short || name || String(num), start: `${f(sh)}:${f(sm)}`, end: `${f(eh)}:${f(em)}` };
}

// teacher records repeat the first-name part of the full name as a separate CString
function looksLikeTeacher(r, h, nextPos) {
  const name = h.name.trim();
  if (name.length < 2) return false;
  const b = r.b;
  for (let i = h.after + 8; i < Math.min(nextPos, h.after + 2000) - 2; i++) {
    const L = b[i];
    if (L < 2 || L > name.length || i + 1 + L > nextPos) continue;
    if (b[i + 1] !== name.charCodeAt(0)) continue;
    const s = r.dec.decode(b.subarray(i + 1, i + 1 + L));
    if (name.startsWith(s) && (L >= 3 || L === name.length)) return true;
  }
  return false;
}

function readList(r, p) {
  const n = r.i32(p); p += 4;
  if (n < 0 || n > 500) throw new Error('bad list');
  const a = [];
  for (let k = 0; k < n; k++) { a.push(r.i32(p)); p += 4; }
  return [a, p];
}

function readLesson(r, h) {
  // after short: 11 bytes, count/week, length, 5 bytes, int(1), int(0), subject, groups[], teachers[], rooms[]
  let p = h.after + 11;
  const count = r.i32(p), len = r.i32(p + 4);
  p += 8 + 5 + 4 + 4;
  const subject = r.i32(p); p += 4;
  let groups, teachers, rooms;
  [groups, p] = readList(r, p);
  [teachers, p] = readList(r, p);
  [rooms, p] = readList(r, p);
  // verified against placed cards: first field = periods per card, second = cards per week
  if (!(count >= 0 && count < 20 && len > 0 && len < 100)) throw new Error('bad lesson');
  return { periodsPerCard: Math.max(1, count), cardsPerWeek: len, subject, groups, teachers, rooms };
}

function readClassGroups(r, h) {
  let p = h.after + 1;
  const ndiv = r.i32(p); p += 4;
  const [groups] = readList(r, p);
  return { ndiv, groups };
}

function readGroup(r, h) {
  // groups have no short name: name, int32 entireClass flag, int32 division index, ... running index
  const p = h.nameEnd;
  const entire = r.i32(p) === 1;
  const division = r.i32(p + 4);
  return { entire, division };
}

// Cards: lesson(4) nRooms(4) rooms(4*n) period(4) dur(4) zero(4) daysMask(4) weeksMask(4) 00 ffffffff ...
function tryCard(r, p, lessonCount, periodCount, end) {
  if (p + 80 > end) return null;
  const lesson = r.i32(p);
  if (lesson < 0 || lesson >= lessonCount) return null;
  const n = r.i32(p + 4);
  if (n < 0 || n > 8) return null;
  let q = p + 8;
  const rooms = [];
  for (let k = 0; k < n; k++) { rooms.push(r.i32(q)); q += 4; }
  const period = r.i32(q), x = r.i32(q + 4), z = r.i32(q + 8), days = r.i32(q + 12), weeks = r.i32(q + 16);
  if (period < 0 || period >= Math.max(periodCount, 1)) return null;
  if (z !== 0 || days <= 0 || days > 0x7f || weeks <= 0 || weeks > 0xffff) return null;
  if (r.b[q + 20] !== 0 || r.i32(q + 21) !== -1) return null;
  if (x < 0 || x > 20) return null;
  return { card: { lesson, rooms, period, dur: x, days, weeks }, next: q + 63 };
}

// Card records are located by their fixed body
//   period, dur, 0, daysMask, weeksMask, 00 FFFFFFFF, K, ...
// and decoded backwards: ... lesson, [room], nList, list..., body.
// When the previous card's K == 1 the next card carries an assigned classroom index
// between the lesson index and the list (seen on lab lessons such as SC/KIM/BIO/FZ).
function findCards(r, start, end, lessonCount, periodCount, roomCount) {
  const b = r.b, cards = [];
  let last = 0, prevK = 0;
  for (let q = start + 12; q < end - 40; q++) {
    if (r.i32(q + 8) !== 0 || b[q + 20] !== 0 || r.i32(q + 21) !== -1) continue;
    const days = r.i32(q + 12), weeks = r.i32(q + 16), period = r.i32(q), dur = r.i32(q + 4);
    if (days <= 0 || days > 0x7f || weeks <= 0 || weeks > 0xffff) continue;
    if (period < 0 || period >= Math.max(periodCount, 1) || dur < 0 || dur > 20) continue;
    let found = null;
    for (let n = 0; n <= 8 && !found; n++) {
      const p = q - 4 * n; // list start
      if (p - 8 < start || r.i32(p - 4) !== n) continue;
      const list = []; for (let k = 0; k < n; k++) list.push(r.i32(p + 4 * k));
      const a = r.i32(p - 8), bb = r.i32(p - 12);
      // with assigned room: lesson, room, n, list ; without: lesson, n, list
      const withRoom = prevK === 1 && bb >= last && bb < lessonCount && a >= 0 && a < Math.max(roomCount, 1);
      if (withRoom) found = { lesson: bb, room: a, list };
      else if (a >= last && a < lessonCount) found = { lesson: a, room: list.find(x => x >= 0 && x < roomCount) ?? -1, list };
    }
    if (!found) continue;
    cards.push({ lesson: found.lesson, rooms: found.room >= 0 ? [found.room] : [], period, dur, days, weeks });
    last = found.lesson;
    prevK = r.i32(q + 25);
    q += 24;
  }
  return cards;
}

export async function readAscFile(fileBytes, fileName = '') {
  let bytes = fileBytes;
  const warnings = [];
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) { // zip (.ziptt / .zipsubst)
    const entries = await unzip(bytes);
    const e = entries.find(x => /\.(roz|rox)$/i.test(x.name));
    if (!e) throw new Error('Zip tidak mengandungi fail .roz/.rox');
    bytes = e.data;
  }
  const r = new Reader(bytes);
  const version = r.i32(0);
  const [magic] = r.cstr(4);
  if (version < 600) warnings.push(`Versi fail ${version} lebih lama daripada yang diuji (702/802). Sesetengah data mungkin tidak dibaca.`);
  const H = findHeaders(r);

  // periods: consecutive headers decodable as times
  const periods = [];
  let k = 0, firstPeriod = -1;
  for (; k < H.length; k++) {
    const pd = readPeriod(r, H[k]);
    if (pd) { if (firstPeriod < 0) firstPeriod = k; periods.push(pd); }
    else if (firstPeriod >= 0) break;
  }
  const afterPeriods = firstPeriod >= 0 ? firstPeriod + periods.length : 0;

  const firstClass = H.findIndex(h => h.isClass);
  if (firstClass < 0) throw new Error('Tiada kelas ditemui — format tidak dikenali');
  let lastClass = firstClass;
  while (lastClass + 1 < H.length && H[lastClass + 1].isClass) lastClass++;
  const classH = H.slice(firstClass, lastClass + 1);
  const classInfo = classH.map(h => { try { return readClassGroups(r, h); } catch { return { ndiv: 0, groups: [] }; } });
  const groupCount = Math.max(0, ...classInfo.flatMap(c => c.groups)) + 1;
  const groupH = H.slice(firstClass - groupCount, firstClass);

  // between periods and groups: grades, subjects, teachers
  const mid = H.slice(afterPeriods, firstClass - groupCount);
  const nextPosOf = j => (afterPeriods + j + 1 < H.length ? H[afterPeriods + j + 1].pos : r.b.length);
  let t0 = mid.length;
  while (t0 > 0 && looksLikeTeacher(r, mid[t0 - 1], nextPosOf(t0 - 1))) t0--;
  // grades: leading run of small records whose short name repeats a pattern (G 1, G 2, ...)
  let s0 = 0;
  while (s0 < t0 && mid[s0].size <= 90) s0++;
  if (s0 >= t0) s0 = 0; // no grades detected
  const gradeH = mid.slice(0, s0), subjectH = mid.slice(s0, t0), teacherH = mid.slice(t0);

  // rooms then lessons (empty names) after classes
  const rest = H.slice(lastClass + 1);
  const lessonStart = rest.findIndex(h => h.name === '' && h.short === '');
  const roomH = rest.slice(0, Math.max(0, lessonStart));
  const lessons = [];
  let lastLessonH = null;
  for (let j = lessonStart; j >= 0 && j < rest.length; j++) {
    const h = rest[j];
    if (h.name !== '' || h.short !== '') break;
    try { lessons.push(readLesson(r, h)); lastLessonH = h; } catch { break; }
  }
  if (!lessons.length) warnings.push('Tiada rekod pelajaran ditemui.');
  const cardStart = lastLessonH ? lastLessonH.after + 40 : 0;
  const nextH = H.find(h => h.pos > cardStart);
  const rawCards = findCards(r, cardStart, nextH ? nextH.pos : r.b.length, lessons.length, periods.length, roomH.length);

  // map groups -> classes
  const groupClass = new Array(groupCount).fill(-1);
  classInfo.forEach((c, ci) => c.groups.forEach(g => { groupClass[g] = ci; }));
  const groups = groupH.map((h, gi) => ({ ...readGroup(r, h), name: h.name, cls: groupClass[gi] }));

  // determine day count from card masks
  let maxBit = 4;
  for (const c of rawCards) for (let d = 0; d < 16; d++) if (c.days & (1 << d)) maxBit = Math.max(maxBit, d);
  const dayCount = maxBit + 1;

  return {
    meta: { version, magic, fileName, warnings, counts: {
      periods: periods.length, grades: gradeH.length, subjects: subjectH.length, teachers: teacherH.length,
      groups: groups.length, classes: classH.length, rooms: roomH.length, lessons: lessons.length, cards: rawCards.length } },
    dayCount,
    periods,
    grades: gradeH.map(h => ({ name: h.name, short: h.short })),
    subjects: subjectH.map(h => ({ name: h.name, short: h.short, color: h.color })),
    teachers: teacherH.map(h => ({ name: h.name, short: h.short, color: h.color })),
    classes: classH.map((h, i) => ({ name: h.name, short: h.short, color: h.color, groups: classInfo[i].groups })),
    groups,
    rooms: roomH.map(h => ({ name: h.name, short: h.short, color: h.color })),
    lessons,
    cards: rawCards,
  };
}
