// Relations (constraints between lessons), shared by the UI and the generator.

export const RELATION_TYPES = {
  serentak: { label: 'Mesti bermula pada waktu sama', help: 'Kad subjek-subjek berbeza (dalam kelas dipilih) yang sama tempoh diletak serentak — cth. kumpulan elektif TI (Kump. 1) dan SS (Kump. 2).' },
  waktuSama: { label: 'Waktu sama setiap hari', help: 'Semua kad subjek ini (dalam kelas dipilih) bermula pada waktu yang sama setiap hari.' },
  tidakHariSama: { label: 'Tidak boleh pada hari sama', help: 'Subjek-subjek berbeza ini tidak boleh berada pada hari yang sama dalam satu kelas.' },
  berturutan: { label: 'Mesti berturutan (sebarang susunan)', help: 'Dua subjek ini sebaiknya diletak bersebelahan pada hari yang sama (diutamakan oleh penjana).' },
  lain: { label: 'Jenis lain (tidak disokong)', help: 'Diimport dari fail asal; disimpan tetapi tidak dikuatkuasakan.' },
};

// aSc relation type codes observed in .roz files
export function relationFromAsc(code) {
  if (code === 12) return { type: 'serentak', groupsOnly: true };   // "...for the groups of listed classes must start at the same time"
  if (code === 13) return { type: 'serentak', groupsOnly: false };  // "...have to be at the same time in all selected classes"
  if (code === 14) return { type: 'waktuSama' };
  if (code === 1) return { type: 'tidakHariSama' };
  if (code === 5) return { type: 'berturutan' };
  return { type: 'lain' };
}

export function relationLessonIds(state, rel) {
  const gmap = Object.fromEntries(state.groups.map(g => [g.id, g]));
  const subs = new Set(rel.subjectIds), cls = new Set(rel.classIds);
  return state.lessons.filter(l => subs.has(l.subjectId) && l.groupIds.some(g => {
    const G = gmap[g]; if (!G) return false;
    if (cls.size && !cls.has(G.classId)) return false;
    return !(rel.type === 'serentak' && rel.groupsOnly && G.division === 0);
  })).map(l => l.id);
}

// For "serentak": buckets of lessons (same card length) whose cards of different subjects must align.
export function serentakBuckets(state, rel, lessonById) {
  const byLen = {};
  for (const lid of relationLessonIds(state, rel)) { const l = lessonById[lid]; (byLen[l.periodsPerCard] ||= []).push(l); }
  return Object.values(byLen).filter(ls => new Set(ls.map(l => l.subjectId)).size > 1);
}

// Returns Map cardId -> [messages] for relation violations.
export function relationViolations(state, ix) {
  const out = new Map();
  const add = (id, msg) => { if (!out.has(id)) out.set(id, []); const a = out.get(id); if (!a.includes(msg)) a.push(msg); };
  const cardsOf = lid => state.cards.filter(c => c.lessonId === lid);
  const classesOf = l => new Set(l.groupIds.map(g => ix.group[g]?.classId));
  for (const r of state.relations || []) {
    const name = r.subjectIds.map(s => ix.subject[s]?.short).join(', ');
    if (r.type === 'serentak') {
      for (const bucket of serentakBuckets(state, r, ix.lesson)) {
        const bySub = {};
        for (const l of bucket) for (const c of cardsOf(l.id)) (bySub[l.subjectId] ||= []).push(c);
        const subs = Object.keys(bySub);
        for (const a of subs) for (const b of subs) {
          if (a === b || bySub[b].length < bySub[a].length) continue;
          const slots = new Set(bySub[b].map(c => `${c.day}-${c.period}`));
          for (const c of bySub[a]) if (!slots.has(`${c.day}-${c.period}`)) add(c.id, `Relasi: ${name} mesti serentak`);
        }
      }
    } else if (r.type === 'waktuSama') {
      const cs = relationLessonIds(state, r).flatMap(cardsOf);
      if (new Set(cs.map(c => c.period)).size > 1) cs.forEach(c => add(c.id, `Relasi: ${name} mesti waktu sama setiap hari`));
    } else if (r.type === 'tidakHariSama') {
      const lids = relationLessonIds(state, r);
      for (let i = 0; i < lids.length; i++) for (let j = i + 1; j < lids.length; j++) {
        const A = ix.lesson[lids[i]], B = ix.lesson[lids[j]];
        if (A.subjectId === B.subjectId) continue;
        const ca = classesOf(A); if (![...classesOf(B)].some(x => ca.has(x))) continue;
        for (const a of cardsOf(A.id)) for (const b of cardsOf(B.id)) if (a.day === b.day) { add(a.id, `Relasi: ${name} tidak boleh hari sama`); add(b.id, `Relasi: ${name} tidak boleh hari sama`); }
      }
    }
  }
  return out;
}

// Cards that must move together with `card` (serentak partners starting at the same slot).
export function serentakPartners(state, card) {
  const lessonById = Object.fromEntries(state.lessons.map(l => [l.id, l]));
  const out = [];
  for (const r of state.relations || []) {
    if (r.type !== 'serentak') continue;
    for (const bucket of serentakBuckets(state, r, lessonById)) {
      const ids = bucket.map(l => l.id);
      if (!ids.includes(card.lessonId)) continue;
      const mySub = lessonById[card.lessonId].subjectId;
      for (const c of state.cards) if (c.id !== card.id && ids.includes(c.lessonId) && lessonById[c.lessonId].subjectId !== mySub && c.day === card.day && c.period === card.period && !out.includes(c)) out.push(c);
    }
  }
  return out;
}
