import {
  emptyState, loadLocal, saveLocal, normalize, uid, pickColor, indexState, findClashes, cardSlots,
  lessonClassIds, lessonLabel, placedCount, stats, teacherLoad, ensureEntireGroup, groupsClash,
} from './model.js';
import { importFile, exportAscXml, exportCsv, download } from './io.js';
import { RELATION_TYPES, relationLessonIds, serentakPartners } from './relations.js';

let S = loadLocal() || emptyState();
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('#main');
const ui = { view: 'utama', ttMode: 'c', ttId: null, lessonFilter: '', reliefDate: new Date().toISOString().slice(0, 10), printMode: 'c', printSel: 'all' };
try { Object.assign(ui, JSON.parse(localStorage.getItem('jadualweb.ui') || '{}')); } catch { /* ignore */ }

let saveTimer = null;
function commit(rerender = true) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (!saveLocal(S)) toast('Amaran: storan pelayar penuh/tidak tersedia — eksport JSON untuk simpan.'); }, 300);
  $('#schoolName').textContent = `${S.school.name} · ${S.school.year}`;
  if (rerender) render();
}
function saveUi() { try { localStorage.setItem('jadualweb.ui', JSON.stringify(ui)); } catch { /* ignore */ } }
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms); }

// ---------- modal ----------
function modal(title, bodyHtml, { ok = 'Simpan', onOk, wide = false, extra = '' } = {}) {
  const dlg = $('#modal'), form = $('#modalForm');
  dlg.style.width = wide ? 'min(980px, calc(100vw - 32px))' : '';
  form.innerHTML = `<div class="mh">${esc(title)}</div><div class="mb">${bodyHtml}</div>
    <div class="mf">${extra}<span class="grow"></span><button class="btn" value="cancel" formnovalidate>Batal</button>${ok ? `<button class="btn primary" value="ok">${esc(ok)}</button>` : ''}</div>`;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(res => {
    dlg.onclose = () => {
      if (dlg.returnValue === 'ok' && onOk) { const r = onOk(form); if (r === false) { dlg.showModal(); return; } }
      res(dlg.returnValue);
    };
  });
}
const confirmBox = (msg) => modal('Sahkan', `<p>${esc(msg)}</p>`, { ok: 'Ya' }).then(v => v === 'ok');

// ---------- routing ----------
function route() {
  ui.view = (location.hash || '#utama').slice(1) || 'utama';
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.v === ui.view));
  $('#nav').classList.remove('open');
  render();
}
window.addEventListener('hashchange', route);
$('#menuBtn').onclick = () => $('#nav').classList.toggle('open');

function render() {
  saveUi();
  const v = VIEWS[ui.view] || VIEWS.utama;
  main.innerHTML = v();
  (BIND[ui.view] || (() => {}))();
}

// =================== VIEWS ===================
const VIEWS = {};
const BIND = {};

VIEWS.utama = () => {
  const st = stats(S), clashes = findClashes(S).size;
  const pct = st.need ? Math.round(100 * st.cards / st.need) : 0;
  return `<h1>Utama</h1><p class="sub">Penyusun jadual waktu sekolah — semua data disimpan dalam pelayar anda sahaja.</p>
  <div class="stats">
    ${[['Subjek', st.subjects, 'subjek'], ['Guru', st.teachers, 'guru'], ['Kelas', st.classes, 'kelas'], ['Bilik', st.rooms, 'bilik'], ['Pelajaran', st.lessons, 'pelajaran']]
      .map(([n, v, h]) => `<a class="stat" href="#${h}" style="text-decoration:none;color:inherit"><b>${v}</b><span>${n}</span></a>`).join('')}
    <div class="stat"><b>${st.cards}/${st.need}</b><span>Kad diletak (${pct}%)</span></div>
    <div class="stat"><b style="color:${clashes ? 'var(--danger)' : 'var(--ok)'}">${clashes}</b><span>Kad bertembung</span></div>
  </div>
  <div class="panel" style="margin-top:16px">
    <h2 style="margin-top:0">Mula cepat</h2>
    <ol>
      <li><a href="#fail">Import</a> fail jadual sedia ada (<code>.roz</code>, <code>.rox</code>, <code>.ziptt</code>, XML atau JSON), <b>atau</b> isi data sendiri:</li>
      <li>Tetapkan <a href="#sekolah">hari &amp; waktu</a>, kemudian <a href="#subjek">subjek</a>, <a href="#guru">guru</a>, <a href="#kelas">kelas</a> dan <a href="#bilik">bilik</a>.</li>
      <li>Tambah <a href="#pelajaran">pelajaran</a> (subjek + kelas + guru + bilangan seminggu).</li>
      <li><a href="#jana">Jana jadual</a> secara automatik, kemudian <a href="#jadual">laras</a> dengan seret &amp; lepas.</li>
      <li><a href="#cetak">Cetak</a> jadual kelas/guru/bilik, dan urus <a href="#relief">guru ganti</a> harian.</li>
    </ol>
    <div class="row">
      <button class="btn" id="demoBtn">Muatkan data contoh</button>
      <button class="btn danger" id="resetBtn">Kosongkan semua data</button>
    </div>
  </div>`;
};
BIND.utama = () => {
  $('#demoBtn').onclick = async () => { if (S.lessons.length && !(await confirmBox('Gantikan data semasa dengan data contoh?'))) return; S = demoState(); commit(); toast('Data contoh dimuatkan'); };
  $('#resetBtn').onclick = async () => { if (await confirmBox('Padam semua data? Eksport dahulu jika perlu.')) { S = emptyState(); commit(); } };
};

// ---------- school, days, periods ----------
VIEWS.sekolah = () => `<h1>Sekolah &amp; waktu</h1><p class="sub">Nama sekolah, hari persekolahan dan waktu (period) harian.</p>
  <div class="panel row">
    <label class="f grow">Nama sekolah<input id="scName" value="${esc(S.school.name)}"></label>
    <label class="f">Tahun / sesi<input id="scYear" value="${esc(S.school.year)}" size="10"></label>
  </div>
  <div class="panel"><div class="row"><h2 class="grow" style="margin:0">Hari</h2><button class="btn sm" id="addDay">+ Hari</button></div>
    <table class="tbl"><thead><tr><th>#</th><th>Nama</th><th>Singkatan</th><th></th></tr></thead><tbody>
    ${S.days.map((d, i) => `<tr><td>${i + 1}</td><td><input data-day="${i}" data-k="name" value="${esc(d.name)}"></td><td><input data-day="${i}" data-k="short" value="${esc(d.short)}"></td>
      <td><button class="btn sm danger" data-delday="${i}">Padam</button></td></tr>`).join('')}
    </tbody></table></div>
  <div class="panel"><div class="row"><h2 class="grow" style="margin:0">Waktu</h2>
    <label class="f">Minit/waktu<input id="perLen" type="number" value="30" min="5" max="120" style="width:80px"></label>
    <button class="btn sm" id="addPer">+ Waktu</button></div>
    <table class="tbl"><thead><tr><th>#</th><th>Nama</th><th>Singkatan</th><th>Mula</th><th>Tamat</th><th></th></tr></thead><tbody>
    ${S.periods.map((p, i) => `<tr><td>${i + 1}</td><td><input data-per="${i}" data-k="name" value="${esc(p.name)}"></td><td><input data-per="${i}" data-k="short" value="${esc(p.short)}"></td>
      <td><input type="time" data-per="${i}" data-k="start" value="${esc(p.start)}"></td><td><input type="time" data-per="${i}" data-k="end" value="${esc(p.end)}"></td>
      <td><button class="btn sm danger" data-delper="${i}">Padam</button></td></tr>`).join('')}
    </tbody></table></div>`;
BIND.sekolah = () => {
  $('#scName').onchange = e => { S.school.name = e.target.value; commit(false); };
  $('#scYear').onchange = e => { S.school.year = e.target.value; commit(false); };
  $$('[data-day]').forEach(el => el.onchange = () => { S.days[+el.dataset.day][el.dataset.k] = el.value; commit(false); });
  $$('[data-per]').forEach(el => el.onchange = () => { S.periods[+el.dataset.per][el.dataset.k] = el.value; commit(false); });
  $('#addDay').onclick = () => { S.days.push({ name: `Hari ${S.days.length + 1}`, short: `H${S.days.length + 1}` }); commit(); };
  $('#addPer').onclick = () => {
    const len = +$('#perLen').value || 30, last = S.periods[S.periods.length - 1];
    const toM = t => { const [h, m] = (t || '07:30').split(':'); return +h * 60 + +m; }, f = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const s = last ? toM(last.end) : 450; const n = S.periods.length + 1;
    S.periods.push({ name: String(n), short: String(n), start: f(s), end: f(s + len) }); commit();
  };
  $$('[data-delday]').forEach(b => b.onclick = async () => {
    const i = +b.dataset.delday; if (!(await confirmBox(`Padam hari "${S.days[i].name}"? Kad pada hari ini akan dibuang.`))) return;
    S.days.splice(i, 1); S.cards = S.cards.filter(c => c.day !== i).map(c => (c.day > i ? { ...c, day: c.day - 1 } : c)); commit();
  });
  $$('[data-delper]').forEach(b => b.onclick = async () => {
    const i = +b.dataset.delper; if (!(await confirmBox(`Padam waktu "${S.periods[i].name}"? Kad pada waktu ini akan dibuang.`))) return;
    S.periods.splice(i, 1); S.cards = S.cards.filter(c => c.period !== i).map(c => (c.period > i ? { ...c, period: c.period - 1 } : c)); commit();
  });
};

// ---------- generic entity lists ----------
const ENT = {
  subjek: { key: 'subjects', tk: 's', title: 'Subjek', one: 'subjek', prefix: 's' },
  guru: { key: 'teachers', tk: 't', title: 'Guru', one: 'guru', prefix: 't' },
  bilik: { key: 'rooms', tk: 'r', title: 'Bilik', one: 'bilik', prefix: 'r' },
  kelas: { key: 'classes', tk: 'c', title: 'Kelas', one: 'kelas', prefix: 'c' },
};
function entityView(name) {
  const E = ENT[name], list = S[E.key], ix = indexState(S);
  const extraHead = name === 'guru' ? '<th>Beban (waktu/minggu)</th>' : name === 'kelas' ? '<th>Kumpulan</th>' : name === 'subjek' ? '<th>Pelajaran</th>' : '';
  const extra = x => {
    if (name === 'guru') { const ld = teacherLoad(S, x.id, ix); return `<td>${ld.placed}/${ld.need}</td>`; }
    if (name === 'kelas') { const gs = S.groups.filter(g => g.classId === x.id && g.division > 0); return `<td class="muted">${gs.length ? esc(gs.map(g => g.name).join(', ')) : '—'}</td>`; }
    if (name === 'subjek') return `<td>${S.lessons.filter(l => l.subjectId === x.id).length}</td>`;
    return '';
  };
  return `<h1>${E.title}</h1><p class="sub">${list.length} ${E.one}. Klik nama untuk sunting; "Masa" untuk tetapkan waktu tidak tersedia.</p>
  <div class="panel"><div class="row" style="margin-bottom:10px">
    <button class="btn primary" id="addEnt">+ Tambah ${E.one}</button>
    ${name !== 'kelas' ? `<button class="btn" id="bulkEnt">Tambah pukal…</button>` : `<button class="btn" id="bulkEnt">Tambah pukal…</button>`}
    <input id="entFilter" placeholder="Cari…" class="grow" style="max-width:260px">
  </div>
  <div class="scroll"><table class="tbl"><thead><tr><th></th><th>Nama</th><th>Singkatan</th>${extraHead}<th></th></tr></thead><tbody>
  ${list.map(x => `<tr data-name="${esc((x.name + ' ' + x.short).toLowerCase())}">
    <td><span class="swatch" style="background:${esc(x.color || '#ccc')}"></span></td>
    <td><a href="javascript:void 0" data-edit="${x.id}">${esc(x.name)}</a></td><td>${esc(x.short)}</td>${extra(x)}
    <td style="text-align:right;white-space:nowrap"><button class="btn sm" data-toff="${x.id}">Masa</button>
      <button class="btn sm" data-view="${x.id}">Jadual</button>
      <button class="btn sm danger" data-del="${x.id}">Padam</button></td></tr>`).join('')}
  </tbody></table></div></div>`;
}
function bindEntity(name) {
  const E = ENT[name];
  $('#entFilter').oninput = e => { const q = e.target.value.toLowerCase(); $$('tbody tr[data-name]').forEach(tr => { tr.style.display = tr.dataset.name.includes(q) ? '' : 'none'; }); };
  $('#addEnt').onclick = () => editEntity(name, null);
  $('#bulkEnt').onclick = () => modal(`Tambah ${E.one} secara pukal`, `<p class="muted">Satu baris setiap ${E.one}. Format: <code>Nama;Singkatan</code> (singkatan pilihan).</p><textarea name="bulk" rows="12"></textarea>`, {
    onOk: f => {
      const lines = f.bulk.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      lines.forEach(line => { const [n, s] = line.split(/[;\t]/); const o = { id: uid(E.prefix), name: n.trim(), short: (s || n).trim().slice(0, 12), color: pickColor(S[E.key].length) }; S[E.key].push(o); if (name === 'kelas') ensureEntireGroup(S, o.id); });
      commit(); toast(`${lines.length} ${E.one} ditambah`);
    } });
  $$('[data-edit]').forEach(a => a.onclick = () => editEntity(name, a.dataset.edit));
  $$('[data-toff]').forEach(b => b.onclick = () => editTimeoff(E.tk + ':' + b.dataset.toff, S[E.key].find(x => x.id === b.dataset.toff)?.name));
  $$('[data-view]').forEach(b => b.onclick = () => { ui.ttMode = E.tk; ui.ttId = b.dataset.view; location.hash = '#jadual'; });
  $$('[data-del]').forEach(b => b.onclick = async () => {
    const id = b.dataset.del, x = S[E.key].find(o => o.id === id);
    if (!(await confirmBox(`Padam ${E.one} "${x.name}"? Pelajaran berkaitan akan dikemas kini.`))) return;
    deleteEntity(name, id); commit();
  });
}
function deleteEntity(name, id) {
  const E = ENT[name];
  S[E.key] = S[E.key].filter(x => x.id !== id);
  delete S.timeoff[E.tk + ':' + id];
  if (name === 'subjek' || name === 'kelas') {
    S.relations = (S.relations || []).map(r => ({ ...r, subjectIds: r.subjectIds.filter(x => x !== id), classIds: r.classIds.filter(x => x !== id) })).filter(r => r.subjectIds.length);
  }
  if (name === 'subjek') { const gone = new Set(S.lessons.filter(l => l.subjectId === id).map(l => l.id)); S.lessons = S.lessons.filter(l => !gone.has(l.id)); S.cards = S.cards.filter(c => !gone.has(c.lessonId)); }
  if (name === 'guru') S.lessons.forEach(l => { l.teacherIds = l.teacherIds.filter(t => t !== id); });
  if (name === 'bilik') { S.lessons.forEach(l => { l.roomIds = l.roomIds.filter(r => r !== id); }); S.cards.forEach(c => { if (c.roomId === id) c.roomId = null; }); }
  if (name === 'kelas') {
    const gids = new Set(S.groups.filter(g => g.classId === id).map(g => g.id));
    S.groups = S.groups.filter(g => g.classId !== id);
    S.lessons.forEach(l => { l.groupIds = l.groupIds.filter(g => !gids.has(g)); });
    const gone = new Set(S.lessons.filter(l => !l.groupIds.length).map(l => l.id));
    S.lessons = S.lessons.filter(l => !gone.has(l.id)); S.cards = S.cards.filter(c => !gone.has(c.lessonId));
  }
}
function editEntity(name, id) {
  const E = ENT[name];
  const x = id ? S[E.key].find(o => o.id === id) : { name: '', short: '', color: pickColor(S[E.key].length) };
  let groupsHtml = '';
  if (name === 'kelas') {
    const divs = {};
    S.groups.filter(g => g.classId === id && g.division > 0).forEach(g => { (divs[g.division] ||= []).push(g.name); });
    const lines = Object.keys(divs).sort().map(k => divs[k].join(', ')).join('\n');
    groupsHtml = `<label class="f">Pembahagian kumpulan — satu baris setiap pembahagian, nama kumpulan dipisah koma
      <textarea name="divs" rows="4" placeholder="Kumpulan 1, Kumpulan 2&#10;Lelaki, Perempuan">${esc(lines)}</textarea></label>
      <p class="muted" style="margin:0">Kumpulan dalam pembahagian yang sama boleh belajar serentak (cth. Kumpulan 1 &amp; 2); kumpulan dari pembahagian berbeza tidak.</p>`;
  }
  modal(id ? `Sunting ${E.one}` : `Tambah ${E.one}`, `
    <div class="row"><label class="f grow">Nama<input name="name" required value="${esc(x.name)}"></label>
    <label class="f">Singkatan<input name="short" value="${esc(x.short)}" size="10"></label>
    <label class="f">Warna<input type="color" name="color" value="${esc(toHex(x.color))}"></label></div>${groupsHtml}`, {
    onOk: f => {
      const n = f.name.value.trim(); if (!n) return false;
      const o = id ? x : { id: uid(E.prefix) };
      o.name = n; o.short = f.short.value.trim() || n.slice(0, 8); o.color = f.color.value;
      if (!id) S[E.key].push(o);
      if (name === 'kelas') {
        ensureEntireGroup(S, o.id);
        const existing = S.groups.filter(g => g.classId === o.id && g.division > 0);
        const keep = [];
        f.divs.value.split(/\r?\n/).map(l => l.split(',').map(s => s.trim()).filter(Boolean)).filter(a => a.length).forEach((names, di) => {
          names.forEach(nm => {
            let g = existing.find(e => e.name === nm && !keep.includes(e));
            if (!g) { g = { id: uid('g'), classId: o.id, name: nm, division: di + 1 }; S.groups.push(g); }
            g.division = di + 1; keep.push(g);
          });
        });
        const removed = new Set(existing.filter(g => !keep.includes(g)).map(g => g.id));
        if (removed.size) {
          S.groups = S.groups.filter(g => !removed.has(g.id));
          const entire = ensureEntireGroup(S, o.id).id;
          S.lessons.forEach(l => { l.groupIds = [...new Set(l.groupIds.map(g => (removed.has(g) ? entire : g)))]; });
        }
      }
      commit();
    } });
}
function toHex(c) { return /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#cccccc'; }
// readable text colour for a given background
function ink(c) {
  const h = toHex(c), r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1d2733' : '#ffffff';
}
for (const n of Object.keys(ENT)) { VIEWS[n] = () => entityView(n); BIND[n] = () => bindEntity(n); }

function editTimeoff(key, label) {
  const set = new Set(S.timeoff[key] || []);
  const body = `<p class="muted" style="margin:0">Klik sel untuk tandakan <b style="color:var(--danger)">tidak tersedia</b>. Klik tajuk hari/waktu untuk togol seluruh baris/lajur.</p>
  <div class="scroll"><table class="toff"><thead><tr><th></th>${S.periods.map((p, i) => `<th data-col="${i}" style="cursor:pointer">${esc(p.short)}</th>`).join('')}</tr></thead><tbody>
  ${S.days.map((d, di) => `<tr><th data-row="${di}" style="cursor:pointer;padding:0 6px">${esc(d.short)}</th>${S.periods.map((p, pi) => `<td data-dp="${di}-${pi}" class="${set.has(`${di}-${pi}`) ? 'x' : ''}"></td>`).join('')}</tr>`).join('')}
  </tbody></table></div>`;
  const pr = modal(`Masa tidak tersedia — ${label || ''}`, body, {
    onOk: () => { const arr = $$('#modal td.x').map(td => td.dataset.dp); if (arr.length) S.timeoff[key] = arr; else delete S.timeoff[key]; commit(); },
  });
  $$('#modal td[data-dp]').forEach(td => td.onclick = () => td.classList.toggle('x'));
  $$('#modal th[data-row]').forEach(th => th.onclick = () => { const cells = $$(`#modal td[data-dp^="${th.dataset.row}-"]`); const on = !cells.every(c => c.classList.contains('x')); cells.forEach(c => c.classList.toggle('x', on)); });
  $$('#modal th[data-col]').forEach(th => th.onclick = () => { const cells = $$('#modal td[data-dp]').filter(c => c.dataset.dp.split('-')[1] === th.dataset.col); const on = !cells.every(c => c.classList.contains('x')); cells.forEach(c => c.classList.toggle('x', on)); });
  return pr;
}

// ---------- lessons ----------
VIEWS.pelajaran = () => {
  const ix = indexState(S);
  const f = ui.lessonFilter || '';
  const rows = S.lessons.filter(l => {
    if (!f) return true;
    const [t, id] = f.split(':');
    if (t === 'c') return lessonClassIds(S, l, ix).includes(id);
    if (t === 't') return l.teacherIds.includes(id);
    if (t === 's') return l.subjectId === id;
    return true;
  });
  const totalPeriods = rows.reduce((a, l) => a + l.cardsPerWeek * l.periodsPerCard, 0);
  return `<h1>Pelajaran</h1><p class="sub">Setiap pelajaran = subjek + kelas/kumpulan + guru, dengan bilangan kad seminggu dan tempoh setiap kad.</p>
  <div class="panel"><div class="row" style="margin-bottom:10px">
    <button class="btn primary" id="addLesson">+ Tambah pelajaran</button>
    <select id="lessonFilter"><option value="">Semua pelajaran</option>
      <optgroup label="Kelas">${S.classes.map(c => `<option value="c:${c.id}" ${f === 'c:' + c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>
      <optgroup label="Guru">${S.teachers.map(c => `<option value="t:${c.id}" ${f === 't:' + c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>
      <optgroup label="Subjek">${S.subjects.map(c => `<option value="s:${c.id}" ${f === 's:' + c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>
    </select>
    <span class="muted">${rows.length} pelajaran · ${totalPeriods} waktu/minggu</span>
  </div>
  <div class="scroll"><table class="tbl"><thead><tr><th>Subjek</th><th>Kelas / kumpulan</th><th>Guru</th><th>Bilik</th><th>Kad × tempoh</th><th>Diletak</th><th></th></tr></thead><tbody>
  ${rows.map(l => {
    const lb = lessonLabel(S, l, ix), pl = placedCount(S, l.id);
    return `<tr><td><span class="swatch" style="background:${esc(ix.subject[l.subjectId]?.color)}"></span> <a href="javascript:void 0" data-editl="${l.id}">${esc(ix.subject[l.subjectId]?.name || '?')}</a></td>
      <td>${esc(lb.cls)}</td><td>${esc(l.teacherIds.map(t => ix.teacher[t]?.name).join(', ') || '—')}</td>
      <td>${esc(l.roomIds.map(r => ix.room[r]?.short).join(', ') || '—')}</td>
      <td>${l.cardsPerWeek} × ${l.periodsPerCard}</td>
      <td><span class="badge ${pl === l.cardsPerWeek ? 'good' : pl > l.cardsPerWeek ? 'bad' : ''}">${pl}/${l.cardsPerWeek}</span></td>
      <td style="text-align:right;white-space:nowrap"><button class="btn sm" data-dupl="${l.id}">Salin</button> <button class="btn sm danger" data-dell="${l.id}">Padam</button></td></tr>`;
  }).join('')}
  </tbody></table></div></div>`;
};
BIND.pelajaran = () => {
  $('#lessonFilter').onchange = e => { ui.lessonFilter = e.target.value; render(); };
  $('#addLesson').onclick = () => editLesson(null);
  $$('[data-editl]').forEach(a => a.onclick = () => editLesson(a.dataset.editl));
  $$('[data-dupl]').forEach(b => b.onclick = () => { const l = S.lessons.find(x => x.id === b.dataset.dupl); S.lessons.push({ ...structuredClone(l), id: uid('l') }); commit(); });
  $$('[data-dell]').forEach(b => b.onclick = async () => { if (!(await confirmBox('Padam pelajaran ini dan kadnya?'))) return; S.lessons = S.lessons.filter(l => l.id !== b.dataset.dell); S.cards = S.cards.filter(c => c.lessonId !== b.dataset.dell); commit(); });
};
function editLesson(id, preset = {}) {
  if (!S.subjects.length || !S.classes.length) { toast('Tambah subjek dan kelas dahulu.'); return; }
  const l = id ? S.lessons.find(x => x.id === id) : { subjectId: S.subjects[0].id, groupIds: [], teacherIds: [], roomIds: [], periodsPerCard: 1, cardsPerWeek: 1, ...preset };
  const gset = new Set(l.groupIds), tset = new Set(l.teacherIds), rset = new Set(l.roomIds);
  const classBlocks = S.classes.map(c => {
    const gs = S.groups.filter(g => g.classId === c.id).sort((a, b) => a.division - b.division);
    return `<label title="${esc(c.name)}"><input type="checkbox" name="g" value="${gs.find(g => g.division === 0)?.id}" ${gs.some(g => g.division === 0 && gset.has(g.id)) ? 'checked' : ''}> ${esc(c.short)}</label>` +
      gs.filter(g => g.division > 0).map(g => `<label class="muted"><input type="checkbox" name="g" value="${g.id}" ${gset.has(g.id) ? 'checked' : ''}> ${esc(c.short)}: ${esc(g.name)}</label>`).join('');
  }).join('');
  modal(id ? 'Sunting pelajaran' : 'Tambah pelajaran', `
    <div class="row">
      <label class="f grow">Subjek<select name="subject">${S.subjects.map(s => `<option value="${s.id}" ${s.id === l.subjectId ? 'selected' : ''}>${esc(s.name)} (${esc(s.short)})</option>`).join('')}</select></label>
      <label class="f">Kad seminggu<input type="number" name="cpw" min="1" max="40" value="${l.cardsPerWeek}" style="width:90px"></label>
      <label class="f">Tempoh kad (waktu)<input type="number" name="ppc" min="1" max="10" value="${l.periodsPerCard}" style="width:90px"></label>
    </div>
    <div class="f">Kelas / kumpulan (pilih beberapa untuk kelas gabungan)<input placeholder="Tapis…" data-filter="gl"><div class="checklist" id="gl">${classBlocks}</div></div>
    <div class="f">Guru<input placeholder="Tapis…" data-filter="tl"><div class="checklist" id="tl">${S.teachers.map(t => `<label><input type="checkbox" name="t" value="${t.id}" ${tset.has(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('') || '<span class="muted">Tiada guru</span>'}</div></div>
    <div class="f">Bilik dibenarkan (kosong = bilik kelas sendiri)<div class="checklist">${S.rooms.map(r => `<label><input type="checkbox" name="r" value="${r.id}" ${rset.has(r.id) ? 'checked' : ''}> ${esc(r.name)}</label>`).join('') || '<span class="muted">Tiada bilik</span>'}</div></div>`, {
    wide: true,
    onOk: f => {
      const groupIds = $$('input[name=g]:checked', f).map(x => x.value);
      if (!groupIds.length) { toast('Pilih sekurang-kurangnya satu kelas'); return false; }
      const o = id ? l : { id: uid('l') };
      Object.assign(o, { subjectId: f.subject.value, groupIds, teacherIds: $$('input[name=t]:checked', f).map(x => x.value), roomIds: $$('input[name=r]:checked', f).map(x => x.value), cardsPerWeek: Math.max(1, +f.cpw.value || 1), periodsPerCard: Math.max(1, +f.ppc.value || 1) });
      if (!id) S.lessons.push(o);
      commit();
    } });
  $$('#modal [data-filter]').forEach(inp => inp.oninput = () => { const q = inp.value.toLowerCase(); $$(`#${inp.dataset.filter} label`).forEach(lb => { lb.style.display = lb.textContent.toLowerCase().includes(q) ? '' : 'none'; }); });
}

// ---------- timetable grid ----------
function entitiesFor(mode) { return mode === 'c' ? S.classes : mode === 't' ? S.teachers : S.rooms; }
function cardsFor(mode, id, ix) {
  return S.cards.filter(c => {
    const l = ix.lesson[c.lessonId]; if (!l) return false;
    if (mode === 'c') return lessonClassIds(S, l, ix).includes(id);
    if (mode === 't') return l.teacherIds.includes(id);
    return c.roomId === id;
  });
}
function cardHtml(c, l, ix, mode, clashes, { draggable = true, id = c?.id } = {}) {
  const sub = ix.subject[l.subjectId] || {};
  const lb = lessonLabel(S, l, ix);
  const line2 = mode === 't' ? lb.cls : mode === 'r' ? `${lb.cls} · ${lb.t}` : lb.t;
  const grp = mode === 'c' ? l.groupIds.map(g => ix.group[g]).filter(g => g && g.division > 0).map(g => g.name).join(', ') : '';
  const room = c?.roomId ? ix.room[c.roomId]?.short : '';
  const cls = ['card', c && clashes?.has(c.id) ? 'clash' : '', c?.locked ? 'locked' : ''].join(' ');
  const title = `${sub.name || ''}\n${lb.cls}\n${l.teacherIds.map(t => ix.teacher[t]?.name).join(', ')}${room ? '\nBilik: ' + room : ''}${c && clashes?.has(c.id) ? '\n⚠ ' + clashes.get(c.id).join('; ') : ''}`;
  return `<div class="${cls}" ${draggable ? 'draggable="true"' : ''} data-card="${id || ''}" data-lesson="${l.id}" title="${esc(title)}" style="background:${esc(sub.color || '#ddd')};color:${ink(sub.color)}">
    <b>${esc(sub.short || '?')}${grp ? ` <small>(${esc(grp)})</small>` : ''}</b><i>${esc(line2 || '')}</i>${room ? `<i>${esc(room)}</i>` : ''}</div>`;
}
function gridHtml(mode, id, ix, clashes, { interactive = true } = {}) {
  const list = cardsFor(mode, id, ix);
  const at = {};
  for (const c of list) { const l = ix.lesson[c.lessonId]; cardSlots(c, l).forEach((p, k) => { (at[`${c.day}-${p}`] ||= []).push({ c, l, first: k === 0 }); }); }
  const off = new Set(S.timeoff[`${mode}:${id}`] || []);
  return `<table class="tt"><thead><tr><th></th>${S.periods.map(p => `<th>${esc(p.short)}<small>${esc(p.start)}${p.end ? '–' + esc(p.end) : ''}</small></th>`).join('')}</tr></thead><tbody>
  ${S.days.map((d, di) => `<tr><th>${esc(d.name)}</th>${S.periods.map((p, pi) => {
    const items = at[`${di}-${pi}`] || [];
    return `<td data-cell="${di}-${pi}" class="${off.has(`${di}-${pi}`) ? 'off' : ''}">${items.map(({ c, l, first }) => cardHtml(c, l, ix, mode, clashes, { draggable: interactive && first && !c.locked })).join('')}</td>`;
  }).join('')}</tr>`).join('')}
  </tbody></table>`;
}
VIEWS.jadual = () => {
  const ents = entitiesFor(ui.ttMode);
  if (!ents.find(e => e.id === ui.ttId)) ui.ttId = ents[0]?.id || null;
  const ix = indexState(S), clashes = findClashes(S, ix);
  if (!ui.ttId) return `<h1>Susun jadual</h1><div class="panel">Tiada ${ui.ttMode === 'c' ? 'kelas' : ui.ttMode === 't' ? 'guru' : 'bilik'} lagi. <a href="#fail">Import</a> atau tambah data dahulu.</div>`;
  // unplaced cards for this entity
  const relevant = S.lessons.filter(l => ui.ttMode === 'c' ? lessonClassIds(S, l, ix).includes(ui.ttId) : ui.ttMode === 't' ? l.teacherIds.includes(ui.ttId) : l.roomIds.includes(ui.ttId));
  const pool = [];
  for (const l of relevant) { const miss = l.cardsPerWeek - placedCount(S, l.id); for (let k = 0; k < miss; k++) pool.push(l); }
  const idx = ents.findIndex(e => e.id === ui.ttId);
  return `<h1>Susun jadual</h1><p class="sub">Seret kad dari "Belum diletak" ke grid, atau alihkan kad dalam grid. Klik kad untuk kunci/buang. Kad merah = bertembung.</p>
  <div class="panel row no-print">
    <select id="ttMode"><option value="c" ${ui.ttMode === 'c' ? 'selected' : ''}>Kelas</option><option value="t" ${ui.ttMode === 't' ? 'selected' : ''}>Guru</option><option value="r" ${ui.ttMode === 'r' ? 'selected' : ''}>Bilik</option></select>
    <button class="btn" id="ttPrev" ${idx <= 0 ? 'disabled' : ''}>◀</button>
    <select id="ttId" class="grow" style="max-width:340px">${ents.map(e => `<option value="${e.id}" ${e.id === ui.ttId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
    <button class="btn" id="ttNext" ${idx >= ents.length - 1 ? 'disabled' : ''}>▶</button>
    <span class="grow"></span>
    <button class="btn" id="ttAddLesson">+ Pelajaran</button>
    <button class="btn" id="ttClear">Kosongkan (tidak berkunci)</button>
  </div>
  <div class="grid-wrap" id="grid">${gridHtml(ui.ttMode, ui.ttId, ix, clashes)}</div>
  <h2>Belum diletak (${pool.length})</h2>
  <div class="pool" id="pool" data-cell="pool">${pool.map(l => cardHtml(null, l, ix, ui.ttMode, clashes, { id: '' })).join('') || '<span class="muted">Semua kad sudah diletak 👍</span>'}</div>`;
};
BIND.jadual = () => {
  if (!ui.ttId) return;
  $('#ttMode').onchange = e => { ui.ttMode = e.target.value; ui.ttId = null; render(); };
  $('#ttId').onchange = e => { ui.ttId = e.target.value; render(); };
  const ents = entitiesFor(ui.ttMode), idx = ents.findIndex(e => e.id === ui.ttId);
  $('#ttPrev').onclick = () => { ui.ttId = ents[idx - 1].id; render(); };
  $('#ttNext').onclick = () => { ui.ttId = ents[idx + 1].id; render(); };
  $('#ttAddLesson').onclick = () => {
    const ix = indexState(S);
    const preset = ui.ttMode === 'c' ? { groupIds: [ensureEntireGroup(S, ui.ttId).id] } : ui.ttMode === 't' ? { teacherIds: [ui.ttId] } : { roomIds: [ui.ttId] };
    void ix; editLesson(null, preset);
  };
  $('#ttClear').onclick = async () => {
    const ix = indexState(S); const ids = new Set(cardsFor(ui.ttMode, ui.ttId, ix).filter(c => !c.locked).map(c => c.id));
    if (!ids.size || !(await confirmBox(`Buang ${ids.size} kad tidak berkunci dari jadual ini?`))) return;
    S.cards = S.cards.filter(c => !ids.has(c.id)); commit();
  };
  bindDrag();
  $$('#grid .card').forEach(el => el.onclick = () => cardMenu(el.dataset.card));
}
function bindDrag() {
  let drag = null;
  const ix = indexState(S);
  $$('.card[draggable=true]').forEach(el => {
    el.addEventListener('dragstart', e => {
      drag = { cardId: el.dataset.card || null, lessonId: el.dataset.lesson };
      e.dataTransfer.setData('text/plain', 'card'); e.dataTransfer.effectAllowed = 'move';
      // highlight feasible cells
      const l = ix.lesson[drag.lessonId];
      $$('#grid td[data-cell]').forEach(td => { const [d, p] = td.dataset.cell.split('-').map(Number); td.classList.add(placementClashes(l, d, p, drag.cardId, ix).length ? 'no' : 'ok'); });
    });
    el.addEventListener('dragend', () => { $$('#grid td').forEach(td => td.classList.remove('ok', 'no', 'over')); drag = null; });
  });
  $$('[data-cell]').forEach(td => {
    td.addEventListener('dragover', e => { if (!drag) return; e.preventDefault(); td.classList.add('over'); });
    td.addEventListener('dragleave', () => td.classList.remove('over'));
    td.addEventListener('drop', e => {
      e.preventDefault(); if (!drag) return;
      if (td.dataset.cell === 'pool') { if (drag.cardId) { S.cards = S.cards.filter(c => c.id !== drag.cardId); commit(); } return; }
      const [d, p] = td.dataset.cell.split('-').map(Number);
      const l = ix.lesson[drag.lessonId];
      if (p + l.periodsPerCard > S.periods.length) { toast('Kad terlalu panjang untuk waktu ini'); return; }
      const conf = placementClashes(l, d, p, drag.cardId, ix);
      if (drag.cardId) {
        const c = S.cards.find(x => x.id === drag.cardId);
        const partners = serentakPartners(S, c).filter(x => !x.locked);
        c.day = d; c.period = p;
        partners.forEach(x => { x.day = d; x.period = p; });
        if (partners.length) toast(`${partners.length} kad relasi serentak turut dialihkan`);
      }
      else S.cards.push({ id: uid('k'), lessonId: l.id, day: d, period: p, roomId: l.roomIds[0] || null, locked: false });
      if (conf.length) toast('⚠ ' + conf.join('; '), 4000);
      commit();
    });
  });
}
function placementClashes(l, day, period, ignoreCardId, ix) {
  const out = new Set();
  const len = l.periodsPerCard;
  if (period + len > S.periods.length) return ['Melebihi waktu terakhir'];
  for (const c of S.cards) {
    if (c.id === ignoreCardId || c.day !== day) continue;
    const o = ix.lesson[c.lessonId]; if (!o) continue;
    if (c.period >= period + len || period >= c.period + o.periodsPerCard) continue;
    for (const t of l.teacherIds) if (o.teacherIds.includes(t)) out.add(`Guru ${ix.teacher[t]?.short} sibuk`);
    for (const a of l.groupIds) for (const b of o.groupIds) { const A = ix.group[a], B = ix.group[b]; if (A && B && groupsClash(A, B)) out.add(`Kelas ${ix.cls[A.classId]?.short} sibuk`); }
  }
  for (let k = 0; k < len; k++) {
    const dp = `${day}-${period + k}`;
    for (const t of l.teacherIds) if ((S.timeoff['t:' + t] || []).includes(dp)) out.add(`Guru ${ix.teacher[t]?.short} tidak tersedia`);
    for (const c of lessonClassIds(S, l, ix)) if ((S.timeoff['c:' + c] || []).includes(dp)) out.add(`Kelas ${ix.cls[c]?.short} tidak tersedia`);
  }
  return [...out];
}
function cardMenu(cardId) {
  const c = S.cards.find(x => x.id === cardId); if (!c) return;
  const ix = indexState(S), l = ix.lesson[c.lessonId], clashes = findClashes(S, ix);
  const lb = lessonLabel(S, l, ix);
  modal(`${ix.subject[l.subjectId]?.name} — ${S.days[c.day]?.name}, waktu ${S.periods[c.period]?.name}`, `
    <div><b>Kelas:</b> ${esc(lb.cls)}<br><b>Guru:</b> ${esc(l.teacherIds.map(t => ix.teacher[t]?.name).join(', ') || '—')}</div>
    ${clashes.has(c.id) ? `<div class="badge bad">⚠ ${esc(clashes.get(c.id).join('; '))}</div>` : ''}
    <label class="f">Bilik<select name="room"><option value="">— Bilik kelas —</option>${S.rooms.map(r => `<option value="${r.id}" ${r.id === c.roomId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
    <label><input type="checkbox" name="locked" ${c.locked ? 'checked' : ''}> Kunci kad (penjana tidak akan mengalihkannya)</label>`, {
    extra: `<button class="btn danger" value="remove">Buang dari jadual</button><button class="btn" value="lesson">Sunting pelajaran</button>`,
    onOk: f => { c.roomId = f.room.value || null; c.locked = f.locked.checked; commit(); },
  }).then(v => {
    if (v === 'remove') { S.cards = S.cards.filter(x => x.id !== cardId); commit(); }
    if (v === 'lesson') editLesson(l.id);
  });
}

// ---------- master overview ----------
VIEWS.semua = () => {
  const ix = indexState(S), clashes = findClashes(S, ix);
  const mode = ui.masterMode || 'c';
  const ents = entitiesFor(mode);
  const cellMap = {};
  for (const c of S.cards) {
    const l = ix.lesson[c.lessonId]; if (!l) continue;
    const owners = mode === 'c' ? lessonClassIds(S, l, ix) : mode === 't' ? l.teacherIds : (c.roomId ? [c.roomId] : []);
    for (const o of owners) for (const p of cardSlots(c, l)) (cellMap[`${o}|${c.day}-${p}`] ||= []).push({ c, l });
  }
  return `<h1>Semua ${mode === 'c' ? 'kelas' : mode === 't' ? 'guru' : 'bilik'}</h1><p class="sub">Gambaran keseluruhan. Klik baris untuk buka jadualnya.</p>
  <div class="row no-print" style="margin-bottom:10px"><select id="mMode"><option value="c" ${mode === 'c' ? 'selected' : ''}>Kelas</option><option value="t" ${mode === 't' ? 'selected' : ''}>Guru</option><option value="r" ${mode === 'r' ? 'selected' : ''}>Bilik</option></select></div>
  <div class="grid-wrap panel" style="padding:0"><table class="master"><thead>
    <tr><th></th>${S.days.map(d => `<th colspan="${S.periods.length}" class="dsep">${esc(d.name)}</th>`).join('')}</tr>
    <tr><th></th>${S.days.map(() => S.periods.map((p, i) => `<th class="${i === 0 ? 'dsep' : ''}">${esc(p.short)}</th>`).join('')).join('')}</tr></thead><tbody>
    ${ents.map(e => `<tr data-open="${e.id}" style="cursor:pointer"><th>${esc(e.short)}</th>${S.days.map((d, di) => S.periods.map((p, pi) => {
      const it = cellMap[`${e.id}|${di}-${pi}`] || [];
      if (!it.length && (S.timeoff[`${mode}:${e.id}`] || []).includes(`${di}-${pi}`)) return `<td class="${pi === 0 ? 'dsep' : ''} muted" title="Tidak tersedia">×</td>`;
      const bad = it.some(x => clashes.has(x.c.id));
      const txt = it.map(x => mode === 't' ? lessonLabel(S, x.l, ix).cls : ix.subject[x.l.subjectId]?.short).join('/');
      return `<td class="${pi === 0 ? 'dsep' : ''}" style="${it[0] ? `background:${esc(ix.subject[it[0].l.subjectId]?.color)};color:${ink(ix.subject[it[0].l.subjectId]?.color)}` : ''};${bad ? 'outline:2px solid var(--danger);outline-offset:-2px' : ''}" title="${esc(txt)}">${esc(txt)}</td>`;
    }).join('')).join('')}</tr>`).join('')}
  </tbody></table></div>`;
};
BIND.semua = () => {
  $('#mMode').onchange = e => { ui.masterMode = e.target.value; render(); };
  $$('[data-open]').forEach(tr => tr.onclick = () => { ui.ttMode = ui.masterMode || 'c'; ui.ttId = tr.dataset.open; location.hash = '#jadual'; });
};

// ---------- generator ----------
let worker = null;
VIEWS.jana = () => {
  const st = stats(S), locked = S.cards.filter(c => c.locked).length;
  return `<h1>Jana automatik</h1><p class="sub">Penjana meletakkan semua kad pelajaran tanpa pertembungan guru, kelas/kumpulan dan bilik, mengikut masa tidak tersedia, kad berkunci dan <a href="#relasi">relasi</a>. Untuk jadual sekolah yang padat, beri 60 saat atau lebih.</p>
  <div class="panel">
    <div class="row">
      <label class="f">Had masa (saat)<input type="number" id="gSec" value="${ui.gSec || 60}" min="5" max="1800" style="width:100px"></label>
      <label class="f">Kad sedia ada<select id="gKeep"><option value="locked">Kekalkan kad berkunci sahaja (${locked})</option><option value="all" ${ui.gKeep === 'all' ? 'selected' : ''}>Kekalkan semua kad sedia ada (${S.cards.length})</option></select></label>
    </div>
    <h2>Syarat</h2>
    <div class="row">
      <label><input type="checkbox" id="gSpread" ${ui.gSpread === false ? '' : 'checked'}> Kad pelajaran sama pada hari berbeza</label>
      <label><input type="checkbox" id="gClassGaps" ${ui.gClassGaps === false ? '' : 'checked'}> Elak waktu kosong (gap) kelas</label>
      <label><input type="checkbox" id="gTeacherGaps" ${ui.gTeacherGaps === false ? '' : 'checked'}> Kurangkan gap guru</label>
      <label class="f">Maks. waktu berturutan guru (0 = tiada had)<input type="number" id="gConsec" value="${ui.gConsec || 0}" min="0" max="15" style="width:80px"></label>
      <label title="Jika buntu lama, abaikan relasi supaya lebih banyak kad dapat diletak"><input type="checkbox" id="gRelax" ${ui.gRelax ? 'checked' : ''}> Benarkan longgar relasi bila buntu</label>
    </div>
    <p class="muted">${st.lessons} pelajaran memerlukan ${st.need} kad. Jadual semasa akan diganti — eksport dahulu jika perlu.</p>
    <div class="row"><button class="btn primary" id="gRun">▶ Jana jadual</button><button class="btn" id="gStop" disabled>Henti</button></div>
    <div style="margin-top:14px"><div class="progress"><div id="gBar"></div></div><p id="gMsg" class="muted"></p></div>
  </div>`;
};
BIND.jana = () => {
  $('#gRun').onclick = () => {
    if (!S.lessons.length) { toast('Tiada pelajaran untuk dijana'); return; }
    ui.gSec = +$('#gSec').value || 60; ui.gKeep = $('#gKeep').value; ui.gSpread = $('#gSpread').checked;
    ui.gClassGaps = $('#gClassGaps').checked; ui.gTeacherGaps = $('#gTeacherGaps').checked; ui.gConsec = +$('#gConsec').value || 0; ui.gRelax = $('#gRelax').checked; saveUi();
    worker?.terminate();
    worker = new Worker(new URL('./generator-worker.js', import.meta.url), { type: 'module' });
    $('#gRun').disabled = true; $('#gStop').disabled = false; $('#gMsg').textContent = 'Menjana…';
    const t0 = Date.now();
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') {
        $('#gBar').style.width = `${Math.min(100, (Date.now() - t0) / (ui.gSec * 10))}%`;
        $('#gMsg').textContent = m.phase === 'optimum'
          ? `Fasa 2 — optimumkan markah: ${m.moves} pengubahan · belum diletak ${m.unplaced}`
          : `Fasa 1 — jana: lelaran ${m.iter} · belum diletak ${m.unplaced} (terbaik ${m.best}) daripada ${m.total}${m.scatters ? ` · selerak ${m.scatters}×` : ''}${m.relaxed ? ' · relasi dilonggarkan' : ''}`;
      }
      if (m.type === 'done') {
        const r = m.result; worker.terminate(); worker = null;
        S.cards = r.cards.map(c => ({ id: c.id || uid('k'), lessonId: c.lessonId, day: c.day, period: c.period, roomId: c.roomId || null, locked: !!c.locked }));
        commit(false);
        $('#gBar').style.width = '100%';
        $('#gMsg').innerHTML = `Selesai dalam ${(r.elapsed / 1000).toFixed(1)} s: <b>${r.total - r.unplaced}/${r.total}</b> kad baharu diletak${r.unplaced ? `, <b style="color:var(--danger)">${r.unplaced} tidak dapat diletak</b> — cuba lagi dengan masa lebih lama, atau letak manual dari "Belum diletak"` : ' ✔'}; ${r.moves} pengubahan untuk kurangkan gap${r.relaxed ? '; <b>relasi dilonggarkan</b>' : ''}. <a href="#semua">Lihat semua kelas →</a>`;
        $('#gRun').disabled = false; $('#gStop').disabled = true;
      }
      if (m.type === 'error') { $('#gMsg').textContent = 'Ralat: ' + m.message; $('#gRun').disabled = false; $('#gStop').disabled = true; }
    };
    worker.postMessage({ state: JSON.parse(JSON.stringify(S)), opts: { seconds: ui.gSec, keepExisting: ui.gKeep === 'all', spreadDays: ui.gSpread, classGaps: ui.gClassGaps !== false, teacherGaps: ui.gTeacherGaps !== false, maxConsecutive: ui.gConsec || 0, allowRelax: !!ui.gRelax } });
  };
  $('#gStop').onclick = () => { worker?.terminate(); worker = null; $('#gMsg').textContent = 'Dihentikan — jadual tidak diubah.'; $('#gRun').disabled = false; $('#gStop').disabled = true; };
};

// ---------- relief (substitution) ----------
function dayIndexOf(dateStr) { const d = new Date(dateStr + 'T00:00:00'); const w = (d.getDay() + 6) % 7; return w; }
VIEWS.relief = () => {
  const ix = indexState(S);
  const date = ui.reliefDate, di = dayIndexOf(date);
  const R = S.relief[date] || { absent: [], assign: {} };
  const dayName = S.days[di]?.name;
  const absent = new Set(R.absent);
  const busy = teacherBusy(di, ix);
  const affected = [];
  if (dayName) for (const c of S.cards.filter(c => c.day === di)) {
    const l = ix.lesson[c.lessonId]; if (!l) continue;
    for (const t of l.teacherIds) if (absent.has(t)) for (const p of cardSlots(c, l)) affected.push({ c, l, t, p, key: `${c.id}:${t}:${p}` });
  }
  affected.sort((a, b) => a.p - b.p);
  const reliefCount = {}; Object.values(R.assign).forEach(t => { reliefCount[t] = (reliefCount[t] || 0) + 1; });
  const optionsFor = (p, cur) => {
    const free = S.teachers.filter(t => t.id === cur || (!absent.has(t.id) && !busy[t.id]?.has(p)));
    free.sort((a, b) => ((busy[a.id]?.size || 0) + (reliefCount[a.id] || 0) * 2) - ((busy[b.id]?.size || 0) + (reliefCount[b.id] || 0) * 2));
    return `<option value="">— pilih —</option>` + free.map(t => `<option value="${t.id}" ${t.id === cur ? 'selected' : ''}>${esc(t.name)} (${busy[t.id]?.size || 0} waktu${reliefCount[t.id] ? `, ${reliefCount[t.id]} ganti` : ''})</option>`).join('');
  };
  return `<h1>Guru ganti</h1><p class="sub">Pilih tarikh dan guru tidak hadir; sistem cadangkan guru yang lapang mengikut beban paling rendah.</p>
  <div class="panel row">
    <label class="f">Tarikh<input type="date" id="rDate" value="${esc(date)}"></label>
    <div class="grow"><b>${esc(dayName || 'Hari tiada dalam jadual')}</b></div>
    <button class="btn" id="rAuto" ${affected.length ? '' : 'disabled'}>Agih automatik</button>
    <button class="btn primary" id="rPrint" ${affected.length ? '' : 'disabled'}>🖨️ Cetak slip</button>
  </div>
  <div class="panel"><h2 style="margin-top:0">Guru tidak hadir</h2><input placeholder="Tapis guru…" id="rFilter" style="margin-bottom:8px">
    <div class="chips" id="rChips">${S.teachers.map(t => `<span class="chip ${absent.has(t.id) ? 'on' : ''}" data-abs="${t.id}">${esc(t.name)}</span>`).join('')}</div></div>
  <div class="panel"><h2 style="margin-top:0">Kelas perlu diganti (${affected.length})</h2>
  ${affected.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Waktu</th><th>Kelas</th><th>Subjek</th><th>Guru tidak hadir</th><th>Guru ganti</th></tr></thead><tbody>
    ${affected.map(a => `<tr><td>${esc(S.periods[a.p]?.name)} <span class="muted">${esc(S.periods[a.p]?.start)}</span></td><td>${esc(lessonLabel(S, a.l, ix).cls)}</td><td>${esc(ix.subject[a.l.subjectId]?.name)}</td>
      <td>${esc(ix.teacher[a.t]?.name)}</td><td><select data-asg="${a.key}">${optionsFor(a.p, R.assign[a.key])}</select></td></tr>`).join('')}
  </tbody></table></div>` : '<p class="muted">Pilih guru tidak hadir di atas.</p>'}</div>`;
};
function teacherBusy(di, ix) {
  const busy = {};
  for (const c of S.cards) if (c.day === di) { const l = ix.lesson[c.lessonId]; if (!l) continue; for (const t of l.teacherIds) for (const p of cardSlots(c, l)) (busy[t] ||= new Set()).add(p); }
  const R = S.relief[ui.reliefDate];
  if (R) for (const [key, t] of Object.entries(R.assign)) { const p = +key.split(':')[2]; (busy[t] ||= new Set()).add(p); }
  return busy;
}
BIND.relief = () => {
  const date = ui.reliefDate;
  const R = () => (S.relief[date] ||= { absent: [], assign: {} });
  $('#rDate').onchange = e => { ui.reliefDate = e.target.value; render(); };
  $('#rFilter').oninput = e => { const q = e.target.value.toLowerCase(); $$('#rChips .chip').forEach(c => { c.style.display = c.textContent.toLowerCase().includes(q) || c.classList.contains('on') ? '' : 'none'; }); };
  $$('[data-abs]').forEach(ch => ch.onclick = () => {
    const r = R(), id = ch.dataset.abs;
    r.absent = r.absent.includes(id) ? r.absent.filter(x => x !== id) : [...r.absent, id];
    for (const k of Object.keys(r.assign)) if (k.split(':')[1] === id || r.absent.includes(r.assign[k])) delete r.assign[k];
    commit();
  });
  $$('[data-asg]').forEach(sel => sel.onchange = () => { const r = R(); if (sel.value) r.assign[sel.dataset.asg] = sel.value; else delete r.assign[sel.dataset.asg]; commit(); });
  $('#rAuto').onclick = () => {
    const r = R(); const ix = indexState(S); const di = dayIndexOf(date);
    for (const sel of $$('[data-asg]')) {
      if (r.assign[sel.dataset.asg]) continue;
      const p = +sel.dataset.asg.split(':')[2];
      const busy = teacherBusy(di, ix);
      const cnt = {}; Object.values(r.assign).forEach(t => { cnt[t] = (cnt[t] || 0) + 1; });
      const free = S.teachers.filter(t => !r.absent.includes(t.id) && !busy[t.id]?.has(p))
        .sort((a, b) => ((busy[a.id]?.size || 0) + (cnt[a.id] || 0) * 2) - ((busy[b.id]?.size || 0) + (cnt[b.id] || 0) * 2));
      if (free[0]) r.assign[sel.dataset.asg] = free[0].id;
    }
    commit(); toast('Guru ganti diagihkan');
  };
  $('#rPrint').onclick = () => {
    const ix = indexState(S), r = R();
    const rows = $$('[data-asg]').map(sel => { const [cid, t, p] = sel.dataset.asg.split(':'); const c = S.cards.find(x => x.id === cid); const l = ix.lesson[c?.lessonId]; return { p: +p, cls: l ? lessonLabel(S, l, ix).cls : '', sub: ix.subject[l?.subjectId]?.name, abs: ix.teacher[t]?.name, sub2: ix.teacher[r.assign[sel.dataset.asg]]?.name || '' }; });
    $('#printArea').innerHTML = `<div class="ppage relief-print"><h2>Jadual Guru Ganti — ${esc(S.school.name)}</h2><div class="meta">${esc(S.days[dayIndexOf(date)]?.name)}, ${esc(new Date(date + 'T00:00:00').toLocaleDateString('ms-MY', { day: 'numeric', month: 'long', year: 'numeric' }))}</div>
      <table><thead><tr><th>Waktu</th><th>Masa</th><th>Kelas</th><th>Subjek</th><th>Guru tidak hadir</th><th>Guru ganti</th><th>Tandatangan</th></tr></thead><tbody>
      ${rows.map(x => `<tr><td>${esc(S.periods[x.p]?.name)}</td><td>${esc(S.periods[x.p]?.start)}–${esc(S.periods[x.p]?.end)}</td><td>${esc(x.cls)}</td><td>${esc(x.sub)}</td><td>${esc(x.abs)}</td><td>${esc(x.sub2)}</td><td style="width:90px"></td></tr>`).join('')}
      </tbody></table></div>`;
    window.print();
  };
};

// ---------- print ----------
VIEWS.cetak = () => {
  const ents = entitiesFor(ui.printMode);
  return `<h1>Cetak</h1><p class="sub">Satu halaman A4 landskap setiap jadual. Gunakan "Simpan sebagai PDF" dalam dialog cetak untuk fail PDF.</p>
  <div class="panel row">
    <select id="pMode"><option value="c" ${ui.printMode === 'c' ? 'selected' : ''}>Kelas</option><option value="t" ${ui.printMode === 't' ? 'selected' : ''}>Guru</option><option value="r" ${ui.printMode === 'r' ? 'selected' : ''}>Bilik</option></select>
    <select id="pSel" class="grow" style="max-width:340px"><option value="all">Semua (${ents.length})</option>${ents.map(e => `<option value="${e.id}" ${ui.printSel === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
    <button class="btn primary" id="pGo">🖨️ Cetak</button>
  </div>
  <div class="panel" id="pPreview">${previewPrint(true)}</div>`;
};
function previewPrint(first) {
  const ix = indexState(S), clashes = new Map();
  const ents = entitiesFor(ui.printMode).filter(e => ui.printSel === 'all' || e.id === ui.printSel);
  const label = ui.printMode === 'c' ? 'Kelas' : ui.printMode === 't' ? 'Guru' : 'Bilik';
  return (first ? ents.slice(0, 1) : ents).map(e => `<div class="ppage"><h2>${label}: ${esc(e.name)}</h2><div class="meta">${esc(S.school.name)} · ${esc(S.school.year)}</div>${gridHtml(ui.printMode, e.id, ix, clashes, { interactive: false })}</div>`).join('') || '<p class="muted">Tiada data.</p>';
}
BIND.cetak = () => {
  $('#pMode').onchange = e => { ui.printMode = e.target.value; ui.printSel = 'all'; render(); };
  $('#pSel').onchange = e => { ui.printSel = e.target.value; render(); };
  $('#pGo').onclick = () => { $('#printArea').innerHTML = previewPrint(false); window.print(); };
};

// ---------- files ----------
VIEWS.fail = () => `<h1>Import / Eksport</h1><p class="sub">Fail dibaca terus dalam pelayar — tiada data dimuat naik ke mana-mana pelayan.</p>
  <div class="panel"><h2 style="margin-top:0">Import</h2>
    <div class="drop" id="drop">Seret fail ke sini atau <label class="btn" style="display:inline-block">pilih fail<input type="file" id="fileIn" accept=".roz,.rox,.ziptt,.zipsubst,.xml,.json" hidden></label>
    <p class="muted" style="margin:10px 0 0">Disokong: <code>.roz</code> / <code>.rox</code> / <code>.ziptt</code> (fail aSc TimeTables, diuji pada versi fail 702 &amp; 802), XML aSc (<code>&lt;timetable&gt;</code>), dan JSON Jadual Web.</p></div>
    <p id="impMsg"></p></div>
  <div class="panel"><h2 style="margin-top:0">Eksport</h2><div class="row">
    <button class="btn primary" id="expJson">💾 Simpan JSON (fail projek)</button>
    <button class="btn" id="expXml">Eksport XML (boleh diimport ke aSc)</button>
    <button class="btn" id="expCsv">Eksport CSV (Excel)</button>
  </div></div>`;
BIND.fail = () => {
  const handle = async file => {
    try {
      $('#impMsg').textContent = 'Membaca…';
      const { state, report } = await importFile(file);
      if ((S.lessons.length || S.classes.length) && !(await confirmBox('Gantikan data semasa dengan fail ini?'))) { $('#impMsg').textContent = ''; return; }
      S = state; commit(false);
      $('#impMsg').innerHTML = `✔ ${esc(report)} <a href="#semua">Lihat jadual →</a>`;
      $('#schoolName').textContent = `${S.school.name} · ${S.school.year}`;
    } catch (err) { console.error(err); $('#impMsg').textContent = '✖ Gagal membaca fail: ' + err.message; }
  };
  $('#fileIn').onchange = e => e.target.files[0] && handle(e.target.files[0]);
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); };
  const base = (S.school.name || 'jadual').replace(/[^\w\- ]+/g, '').trim() || 'jadual';
  $('#expJson').onclick = () => download(`${base}.json`, JSON.stringify(S, null, 1), 'application/json');
  $('#expXml').onclick = () => download(`${base}.xml`, exportAscXml(S), 'application/xml');
  $('#expCsv').onclick = () => download(`${base}.csv`, exportCsv(S), 'text/csv');
};

// ---------- relations ----------
VIEWS.relasi = () => {
  const ix = indexState(S), viol = findClashes(S, ix);
  const badRel = r => { const ids = new Set(relationLessonIds(S, r)); return S.cards.some(c => ids.has(c.lessonId) && (viol.get(c.id) || []).some(m => m.startsWith('Relasi'))); };
  return `<h1>Relasi</h1><p class="sub">Syarat antara pelajaran yang dipatuhi oleh penjana dan disemak dalam jadual. Diimport sekali dari fail aSc.</p>
  <div class="panel"><div class="row" style="margin-bottom:10px"><button class="btn primary" id="addRel">+ Tambah relasi</button><span class="muted">${(S.relations || []).length} relasi</span></div>
  <div class="scroll"><table class="tbl"><thead><tr><th>Jenis</th><th>Subjek</th><th>Kelas</th><th>Pelajaran terlibat</th><th>Status</th><th></th></tr></thead><tbody>
  ${(S.relations || []).map(r => `<tr><td><a href="javascript:void 0" data-editr="${r.id}">${esc(RELATION_TYPES[r.type]?.label || r.type)}</a>${r.groupsOnly ? ' <span class="muted">(kumpulan sahaja)</span>' : ''}</td>
    <td>${esc(r.subjectIds.map(s => ix.subject[s]?.short).join(', '))}</td><td>${esc(r.classIds.map(c => ix.cls[c]?.short).join(', ') || 'Semua')}</td>
    <td>${relationLessonIds(S, r).length}</td>
    <td>${r.type === 'lain' ? '<span class="badge">tidak disokong</span>' : badRel(r) ? '<span class="badge bad">dilanggar</span>' : '<span class="badge good">dipatuhi</span>'}</td>
    <td style="text-align:right"><button class="btn sm danger" data-delr="${r.id}">Padam</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Tiada relasi.</td></tr>'}
  </tbody></table></div></div>`;
};
BIND.relasi = () => {
  $('#addRel').onclick = () => editRelation(null);
  $$('[data-editr]').forEach(a => a.onclick = () => editRelation(a.dataset.editr));
  $$('[data-delr]').forEach(b => b.onclick = async () => { if (!(await confirmBox('Padam relasi ini?'))) return; S.relations = S.relations.filter(r => r.id !== b.dataset.delr); commit(); });
};
function editRelation(id) {
  const r = id ? S.relations.find(x => x.id === id) : { type: 'serentak', groupsOnly: true, subjectIds: [], classIds: [] };
  const ss = new Set(r.subjectIds), cs = new Set(r.classIds);
  modal(id ? 'Sunting relasi' : 'Tambah relasi', `
    <label class="f">Jenis<select name="type">${Object.entries(RELATION_TYPES).filter(([k]) => k !== 'lain' || r.type === 'lain').map(([k, v]) => `<option value="${k}" ${k === r.type ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
    <p class="muted" id="relHelp" style="margin:0">${esc(RELATION_TYPES[r.type]?.help || '')}</p>
    <label><input type="checkbox" name="groupsOnly" ${r.groupsOnly ? 'checked' : ''}> Untuk pelajaran berkumpulan sahaja (bukan seluruh kelas)</label>
    <div class="f">Subjek<div class="checklist">${S.subjects.map(s => `<label><input type="checkbox" name="s" value="${s.id}" ${ss.has(s.id) ? 'checked' : ''}> ${esc(s.short)} — ${esc(s.name)}</label>`).join('')}</div></div>
    <div class="f">Kelas (kosong = semua kelas)<div class="checklist">${S.classes.map(c => `<label><input type="checkbox" name="c" value="${c.id}" ${cs.has(c.id) ? 'checked' : ''}> ${esc(c.short)}</label>`).join('')}</div></div>`, {
    wide: true,
    onOk: f => {
      const subjectIds = $$('input[name=s]:checked', f).map(x => x.value);
      if (!subjectIds.length) { toast('Pilih sekurang-kurangnya satu subjek'); return false; }
      const o = id ? r : { id: uid('x') };
      Object.assign(o, { type: f.type.value, groupsOnly: f.groupsOnly.checked, subjectIds, classIds: $$('input[name=c]:checked', f).map(x => x.value) });
      if (!id) (S.relations ||= []).push(o);
      commit();
    } });
  $('#modal select[name=type]').onchange = e => { $('#relHelp').textContent = RELATION_TYPES[e.target.value]?.help || ''; };
}

VIEWS.bantuan = () => `<h1>Bantuan</h1>
  <div class="panel">
  <h2 style="margin-top:0">Konsep</h2>
  <ul>
    <li><b>Pelajaran</b> menghubungkan subjek, kelas/kumpulan dan guru. "Kad seminggu × tempoh" — cth. 2 × 2 bermaksud dua sesi berkembar seminggu.</li>
    <li><b>Kad</b> ialah satu sesi pelajaran yang diletakkan pada hari &amp; waktu tertentu.</li>
    <li><b>Kumpulan</b>: setiap kelas ada "Seluruh kelas". Tambah pembahagian (cth. Kumpulan 1/2, Lelaki/Perempuan) dalam suntingan kelas. Kumpulan dalam pembahagian sama boleh belajar serentak.</li>
    <li><b>Masa tidak tersedia</b> untuk guru, kelas, bilik atau subjek dipatuhi oleh penjana.</li>
    <li><b>Kunci</b> kad supaya penjana tidak mengalihkannya.</li>
  </ul>
  <h2>Data &amp; privasi</h2>
  <p>Semua data disimpan dalam storan pelayar (localStorage) peranti ini sahaja. Gunakan <a href="#fail">Simpan JSON</a> untuk sandaran atau pindah ke komputer lain.</p>
  <h2>Import daripada aSc TimeTables</h2>
  <p>Import terus fail <code>.roz</code>/<code>.rox</code> atau sandaran <code>.ziptt</code> (folder <code>backup</code>). Pembaca ini dibina melalui kejuruteraan balik format fail dan diuji pada versi fail 702 dan 802; data asas, pelajaran dan kad dibaca. Tetapan lanjutan (kekangan, reka bentuk cetakan, masa tidak tersedia) tidak dibaca. Untuk keserasian terbaik, eksport XML dari aSc dan import XML itu.</p>
  </div>`;

// ---------- demo data ----------
function demoState() {
  const s = emptyState();
  s.school = { name: 'SMK Contoh', year: String(new Date().getFullYear()) };
  s.periods = Array.from({ length: 9 }, (_, i) => { const st = 450 + i * 35, f = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; return { name: String(i + 1), short: String(i + 1), start: f(st), end: f(st + 35) }; });
  const subj = [['Bahasa Melayu', 'BM', 6], ['Bahasa Inggeris', 'BI', 5], ['Matematik', 'MT', 5], ['Sains', 'SN', 5], ['Sejarah', 'SJ', 3], ['Geografi', 'GEO', 2], ['Pendidikan Islam', 'PI', 3], ['Pendidikan Jasmani', 'PJ', 2], ['Seni Visual', 'PSV', 2], ['RBT', 'RBT', 2]];
  s.subjects = subj.map(([n, sh], i) => ({ id: uid('s'), name: n, short: sh, color: pickColor(i) }));
  const names = ['Aminah', 'Rahman', 'Siti Aisyah', 'Lim Wei', 'Kumar', 'Nurul Huda', 'Faizal', 'Zarina', 'Hafiz', 'Mei Ling', 'Rosli', 'Salmah', 'Arif', 'Devi'];
  s.teachers = names.map((n, i) => ({ id: uid('t'), name: n, short: n.split(' ')[0].slice(0, 5).toUpperCase(), color: pickColor(i + 3) }));
  s.rooms = [{ id: uid('r'), name: 'Makmal Sains', short: 'MSN' }, { id: uid('r'), name: 'Bilik Seni', short: 'BSN' }];
  const cls = ['1 Amanah', '1 Bestari', '2 Amanah', '2 Bestari', '3 Amanah', '3 Bestari'];
  s.classes = cls.map((n, i) => ({ id: uid('c'), name: n, short: n.replace(/ (\w)\w+/, '$1'), color: pickColor(i) }));
  s.classes.forEach(c => ensureEntireGroup(s, c.id));
  let ti = 0;
  for (const c of s.classes) {
    const g = s.groups.find(x => x.classId === c.id).id;
    subj.forEach(([, , per], si) => {
      const t = s.teachers[(ti++) % s.teachers.length].id;
      const dbl = per >= 4 && si % 2 === 0;
      s.lessons.push({ id: uid('l'), subjectId: s.subjects[si].id, groupIds: [g], teacherIds: [t], roomIds: si === 3 ? [s.rooms[0].id] : si === 8 ? [s.rooms[1].id] : [], periodsPerCard: dbl ? 2 : 1, cardsPerWeek: dbl ? Math.floor(per / 2) + (per % 2 ? 1 : 0) - (per % 2 ? 0 : 0) : per });
    });
  }
  s.lessons.forEach(l => { if (l.periodsPerCard === 2 && l.cardsPerWeek * 2 > 6) l.cardsPerWeek = 3; });
  s.timeoff['t:' + s.teachers[0].id] = ['4-6', '4-7', '4-8'];
  return s;
}

// boot
commit(false);
route();
