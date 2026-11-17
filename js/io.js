// Import / export: native .roz/.rox/.ziptt, aSc-compatible XML, and our own JSON.
import { readAscFile } from './roz.js';
import { emptyState, uid, DEFAULT_DAYS, pickColor, normalize, indexState, ensureEntireGroup } from './model.js';
import { relationFromAsc } from './relations.js';

const ROMAN_DAYS = DEFAULT_DAYS;

export async function importFile(file) {
  const name = file.name || '';
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder().decode(bytes.subarray(0, 200)).trimStart();
  if (/\.json$/i.test(name) || head.startsWith('{')) return { state: normalize(JSON.parse(new TextDecoder().decode(bytes))), report: 'Fail JSON dimuatkan.' };
  if (/\.xml$/i.test(name) || head.startsWith('<')) return importAscXml(new TextDecoder().decode(bytes));
  return importRoz(bytes, name);
}

// ---------------- native aSc file ----------------
export async function importRoz(bytes, name) {
  const d = await readAscFile(bytes, name);
  const s = emptyState();
  s.school.name = name.replace(/\.(roz|rox|ziptt|zipsubst)$/i, '').replace(/^\d+_/, '').replace(/^timetable_[\d_]+_/, '');
  s.days = ROMAN_DAYS.slice(0, Math.max(1, d.dayCount)).map(x => ({ ...x }));
  while (s.days.length < d.dayCount) s.days.push({ name: `Hari ${s.days.length + 1}`, short: `H${s.days.length + 1}` });
  s.periods = d.periods.map(p => ({ name: p.name, short: p.short, start: p.start, end: p.end }));
  if (!s.periods.length) s.periods = emptyState().periods;
  const subjects = d.subjects.map((x, i) => ({ id: uid('s'), name: x.name, short: x.short || x.name, color: x.color || pickColor(i) }));
  const teachers = d.teachers.map((x, i) => ({ id: uid('t'), name: x.name, short: x.short || x.name, color: x.color || pickColor(i) }));
  const rooms = d.rooms.map(x => ({ id: uid('r'), name: x.name, short: x.short || x.name }));
  const classes = d.classes.map((x, i) => ({ id: uid('c'), name: x.name, short: x.short || x.name, color: x.color || pickColor(i) }));
  s.subjects = subjects; s.teachers = teachers; s.rooms = rooms; s.classes = classes;
  const addOff = (prefix, list, src) => src.forEach((x, i) => { if (x.timeoff?.length) s.timeoff[`${prefix}:${list[i].id}`] = x.timeoff; });
  addOff('s', subjects, d.subjects); addOff('t', teachers, d.teachers); addOff('r', rooms, d.rooms); addOff('c', classes, d.classes);
  const groupMap = new Map();
  d.groups.forEach((g, gi) => {
    if (g.cls < 0 || !classes[g.cls]) return;
    const id = uid('g');
    s.groups.push({ id, classId: classes[g.cls].id, name: g.entire ? 'Seluruh kelas' : g.name, division: g.entire ? 0 : Math.max(1, g.division) });
    groupMap.set(gi, id);
  });
  for (const c of classes) ensureEntireGroup(s, c.id);
  let skipped = 0;
  const lessonIds = d.lessons.map((l) => {
    const sub = subjects[l.subject];
    const groupIds = l.groups.map(g => groupMap.get(g)).filter(Boolean);
    if (!sub || !groupIds.length) { skipped++; return null; }
    const lesson = {
      id: uid('l'), subjectId: sub.id, groupIds,
      teacherIds: l.teachers.map(t => teachers[t]?.id).filter(Boolean),
      roomIds: l.rooms.map(r => rooms[r]?.id).filter(Boolean),
      periodsPerCard: l.periodsPerCard, cardsPerWeek: l.cardsPerWeek,
    };
    s.lessons.push(lesson);
    return lesson.id;
  });
  for (const c of d.cards) {
    const lid = lessonIds[c.lesson]; if (!lid) continue;
    for (let day = 0; day < 16; day++) if (c.days & (1 << day)) {
      if (day >= s.days.length) continue;
      s.cards.push({ id: uid('k'), lessonId: lid, day, period: c.period, roomId: rooms[c.rooms[0]]?.id || null, locked: !!c.locked });
    }
  }
  s.relations = (d.relations || []).map(r => ({
    id: uid('x'), ...relationFromAsc(r.type), ascType: r.type, desc: r.desc,
    subjectIds: r.subjects.map(i => subjects[i]?.id).filter(Boolean),
    classIds: r.classes.map(i => classes[i]?.id).filter(Boolean),
  }));
  const m = d.meta.counts;
  const locked = s.cards.filter(c => c.locked).length;
  const report = `Fail aSc v${d.meta.version} dibaca: ${m.periods} waktu, ${m.subjects} subjek, ${m.teachers} guru, ${m.classes} kelas, ${m.rooms} bilik, ${m.lessons} pelajaran, ${s.cards.length} kad (${locked} berkunci), ${s.relations.length} relasi.` +
    (skipped ? ` ${skipped} pelajaran tanpa kelas/subjek dilangkau.` : '') + (d.meta.warnings.length ? ' Amaran: ' + d.meta.warnings.join(' ') : '');
  return { state: s, report };
}

// ---------------- aSc XML (documented interchange format) ----------------
const splitIds = v => (v || '').split(',').map(x => x.trim()).filter(Boolean);
function parseTime(t) { if (!t) return ''; const [h, m] = t.split(':'); return `${String(+h).padStart(2, '0')}:${String(+m || 0).padStart(2, '0')}`; }

export function importAscXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML tidak sah');
  const root = doc.querySelector('timetable');
  if (!root) throw new Error('Bukan fail XML jadual (tiada <timetable>)');
  const all = sel => [...root.querySelectorAll(sel)];
  const s = emptyState();
  const per = all('periods > period');
  if (per.length) s.periods = per.sort((a, b) => (+a.getAttribute('period')) - (+b.getAttribute('period'))).map(p => ({
    name: p.getAttribute('name') || p.getAttribute('period'), short: p.getAttribute('short') || p.getAttribute('name') || p.getAttribute('period'),
    start: parseTime(p.getAttribute('starttime')), end: parseTime(p.getAttribute('endtime')) }));
  const periodIndex = new Map(per.map((p, i) => [p.getAttribute('period'), i]));
  // days: derive from daysdefs single-day entries
  const dd = all('daysdefs > daysdef');
  const single = dd.filter(x => /^[01]+$/.test(x.getAttribute('days') || '') && (x.getAttribute('days').match(/1/g) || []).length === 1)
    .sort((a, b) => a.getAttribute('days').indexOf('1') - b.getAttribute('days').indexOf('1'));
  const width = Math.max(5, ...dd.map(x => (x.getAttribute('days') || '').split(',')[0].length));
  s.days = Array.from({ length: width }, (_, i) => {
    const e = single.find(x => x.getAttribute('days').indexOf('1') === i);
    return e ? { name: e.getAttribute('name'), short: e.getAttribute('short') || e.getAttribute('name').slice(0, 3) } : (DEFAULT_DAYS[i] || { name: `Hari ${i + 1}`, short: `H${i + 1}` });
  });
  const map = {};
  const take = (sel, f) => all(sel).map((e, i) => { const o = f(e, i); map[e.getAttribute('id')] = o.id; return o; });
  s.subjects = take('subjects > subject', (e, i) => ({ id: uid('s'), name: e.getAttribute('name'), short: e.getAttribute('short') || e.getAttribute('name'), color: e.getAttribute('color') || pickColor(i) }));
  s.teachers = take('teachers > teacher', (e, i) => ({ id: uid('t'), name: e.getAttribute('name') || `${e.getAttribute('firstname') || ''} ${e.getAttribute('lastname') || ''}`.trim(), short: e.getAttribute('short') || e.getAttribute('name'), color: e.getAttribute('color') || pickColor(i) }));
  s.rooms = take('classrooms > classroom', e => ({ id: uid('r'), name: e.getAttribute('name'), short: e.getAttribute('short') || e.getAttribute('name') }));
  s.classes = take('classes > class', (e, i) => ({ id: uid('c'), name: e.getAttribute('name'), short: e.getAttribute('short') || e.getAttribute('name'), color: e.getAttribute('color') || pickColor(i) }));
  const divTags = new Map();
  for (const e of all('groups > group')) {
    const cid = map[e.getAttribute('classid')]; if (!cid) continue;
    const entire = e.getAttribute('entireclass') === '1';
    let division = 0;
    if (!entire) { const tag = cid + ':' + (e.getAttribute('divisiontag') || '1'); if (!divTags.has(tag)) divTags.set(tag, 1 + [...divTags.keys()].filter(k => k.startsWith(cid + ':')).length); division = divTags.get(tag); }
    const id = uid('g'); map[e.getAttribute('id')] = id;
    s.groups.push({ id, classId: cid, name: entire ? 'Seluruh kelas' : e.getAttribute('name'), division });
  }
  for (const c of s.classes) ensureEntireGroup(s, c.id);
  const ix = () => indexState(s);
  for (const e of all('lessons > lesson')) {
    let groupIds = splitIds(e.getAttribute('groupids')).map(g => map[g]).filter(Boolean);
    if (!groupIds.length) groupIds = splitIds(e.getAttribute('classids')).map(c => map[c]).filter(Boolean).map(cid => ensureEntireGroup(s, cid).id);
    const ppc = +(e.getAttribute('periodspercard') || 1), ppw = +(e.getAttribute('periodsperweek') || ppc);
    const id = uid('l'); map[e.getAttribute('id')] = id;
    s.lessons.push({ id, subjectId: map[e.getAttribute('subjectid')], groupIds,
      teacherIds: splitIds(e.getAttribute('teacherids')).map(t => map[t]).filter(Boolean),
      roomIds: splitIds(e.getAttribute('classroomids')).map(r => map[r]).filter(Boolean),
      periodsPerCard: ppc, cardsPerWeek: Math.max(1, Math.round(ppw / ppc)) });
  }
  s.lessons = s.lessons.filter(l => l.subjectId);
  const lessonsById = ix().lesson;
  for (const e of all('cards > card')) {
    const lid = map[e.getAttribute('lessonid')]; if (!lid || !lessonsById[lid]) continue;
    const pi = periodIndex.has(e.getAttribute('period')) ? periodIndex.get(e.getAttribute('period')) : (+e.getAttribute('period') - 1);
    const days = (e.getAttribute('days') || '').trim();
    const room = splitIds(e.getAttribute('classroomids')).map(r => map[r]).find(Boolean) || null;
    [...days].forEach((ch, di) => { if (ch === '1' && di < s.days.length) s.cards.push({ id: uid('k'), lessonId: lid, day: di, period: pi, roomId: room, locked: false }); });
  }
  const school = root.getAttribute('displayname') || root.querySelector('school')?.getAttribute('name');
  if (school) s.school.name = school;
  return { state: s, report: `XML dibaca: ${s.subjects.length} subjek, ${s.teachers.length} guru, ${s.classes.length} kelas, ${s.lessons.length} pelajaran, ${s.cards.length} kad.` };
}

const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const attrs = o => Object.entries(o).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');

export function exportAscXml(s) {
  const ix = indexState(s);
  const nd = s.days.length;
  const mask = i => Array.from({ length: nd }, (_, k) => (k === i ? '1' : '0')).join('');
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push(`<timetable ascttversion="2012" importtype="database" options="idprefix:JW,daynumbering1" displayname="${esc(s.school.name)}">`);
  L.push(' <periods options="canadd,export:silent" columns="period,name,short,starttime,endtime">');
  s.periods.forEach((p, i) => L.push(`  <period ${attrs({ period: i + 1, name: p.name, short: p.short, starttime: p.start, endtime: p.end })}/>`));
  L.push(' </periods>');
  L.push(' <daysdefs options="canadd,export:silent" columns="id,days,name,short">');
  L.push(`  <daysdef ${attrs({ id: 'DD_ANY', days: Array.from({ length: nd }, (_, i) => mask(i)).join(','), name: 'Setiap hari', short: 'X' })}/>`);
  s.days.forEach((d, i) => L.push(`  <daysdef ${attrs({ id: 'DD' + i, days: mask(i), name: d.name, short: d.short })}/>`));
  L.push(' </daysdefs>');
  L.push(' <weeksdefs options="canadd,export:silent" columns="id,weeks,name,short"><weeksdef id="WK_ALL" weeks="1" name="Setiap minggu" short="All"/></weeksdefs>');
  L.push(' <termsdefs options="canadd,export:silent" columns="id,terms,name,short"><termsdef id="TM_ALL" terms="1" name="Sepanjang tahun" short="Yr"/></termsdefs>');
  L.push(' <subjects options="canadd,export:silent" columns="id,name,short">');
  s.subjects.forEach(x => L.push(`  <subject ${attrs({ id: x.id, name: x.name, short: x.short, color: x.color })}/>`));
  L.push(' </subjects>');
  L.push(' <teachers options="canadd,export:silent" columns="id,name,short">');
  s.teachers.forEach(x => L.push(`  <teacher ${attrs({ id: x.id, name: x.name, short: x.short, color: x.color })}/>`));
  L.push(' </teachers>');
  L.push(' <classrooms options="canadd,export:silent" columns="id,name,short">');
  s.rooms.forEach(x => L.push(`  <classroom ${attrs({ id: x.id, name: x.name, short: x.short })}/>`));
  L.push(' </classrooms>');
  L.push(' <classes options="canadd,export:silent" columns="id,name,short">');
  s.classes.forEach(x => L.push(`  <class ${attrs({ id: x.id, name: x.name, short: x.short, color: x.color })}/>`));
  L.push(' </classes>');
  L.push(' <groups options="canadd,export:silent" columns="id,classid,name,entireclass,divisiontag">');
  s.groups.forEach(g => L.push(`  <group ${attrs({ id: g.id, classid: g.classId, name: g.name, entireclass: g.division === 0 ? 1 : 0, divisiontag: g.division })}/>`));
  L.push(' </groups>');
  L.push(' <lessons options="canadd,export:silent" columns="id,classids,groupids,subjectid,periodspercard,periodsperweek,teacherids,classroomids">');
  s.lessons.forEach(l => L.push(`  <lesson ${attrs({ id: l.id, classids: [...new Set(l.groupIds.map(g => ix.group[g]?.classId))].join(','), groupids: l.groupIds.join(','), subjectid: l.subjectId, periodspercard: l.periodsPerCard, periodsperweek: l.periodsPerCard * l.cardsPerWeek, teacherids: l.teacherIds.join(','), classroomids: l.roomIds.join(','), daysdefid: 'DD_ANY', weeksdefid: 'WK_ALL', termsdefid: 'TM_ALL' })}/>`));
  L.push(' </lessons>');
  L.push(' <cards options="canadd,export:silent" columns="lessonid,period,days,weeks,terms,classroomids">');
  s.cards.forEach(c => L.push(`  <card ${attrs({ lessonid: c.lessonId, period: c.period + 1, days: mask(c.day), weeks: '1', terms: '1', classroomids: c.roomId || '' })}/>`));
  L.push(' </cards>');
  L.push('</timetable>');
  return L.join('\n');
}

export function exportCsv(s) {
  const ix = indexState(s);
  const rows = [['Hari', 'Waktu', 'Mula', 'Tamat', 'Subjek', 'Kelas', 'Guru', 'Bilik']];
  const sorted = [...s.cards].sort((a, b) => a.day - b.day || a.period - b.period);
  for (const c of sorted) {
    const l = ix.lesson[c.lessonId]; if (!l) continue;
    const p = s.periods[c.period] || {};
    rows.push([s.days[c.day]?.name, p.name, p.start, p.end, ix.subject[l.subjectId]?.name,
      l.groupIds.map(g => { const G = ix.group[g]; const cn = ix.cls[G?.classId]?.short; return G?.division ? `${cn} (${G.name})` : cn; }).join(' / '),
      l.teacherIds.map(t => ix.teacher[t]?.name).join(' / '), ix.room[c.roomId]?.name || '']);
  }
  return '﻿' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

export function download(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
