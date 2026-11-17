/* Temp Watch — แจ้งเตือนรถอุณหภูมิผิดปกติให้ DC และบันทึกผลการตรวจสอบ
 * ข้อมูลเก็บใน localStorage (โหมดสาธิต) — จุดเชื่อมต่อระบบจริงดูที่ฟังก์ชัน ingestReading()
 */
(() => {
  'use strict';

  // ---------- Constants ----------
  const KEY = 'tempwatch.v1';
  // การเชื่อมต่อ Google Sheets (Apps Script Web app) — ตั้งค่าได้ในหน้า "เกณฑ์อุณหภูมิ / ระบบ"
  // Apps Script Web app ที่ใช้งานจริง (ค่าเริ่มต้น) — ทุกเครื่องที่เปิดหน้าเว็บจะเข้าหน้าเข้าสู่ระบบด้วย PIN ทันที
  // เปลี่ยนได้ในหน้าตั้งค่า หรือเปิด index.html?api=<URL ใหม่>
  const DEFAULT_API = 'https://script.google.com/macros/s/AKfycbykQP9PchMAgoNoU8TAkxZFgrPynSBFN6vavWeeuBzU9MDS0V5VOjw3acbh7YvKM5IN/exec';
  const api = (() => {
    try { const s = JSON.parse(localStorage.getItem(KEY + '.api')); if (s && typeof s.url === 'string') return s; } catch (e) { /* ignore */ }
    return { url: DEFAULT_API, token: '' }; // url: '' = ผู้ใช้เลือกยกเลิกการเชื่อมต่อเอง
  })();
  // แชร์ลิงก์ให้ DC ได้: index.html?api=<Web app URL> → บันทึก URL ลงเบราว์เซอร์แล้วลบออกจากแถบที่อยู่
  (() => {
    const u = new URLSearchParams(location.search).get('api');
    if (u && /^https:\/\/script\.google(usercontent)?\.com\//.test(u)) {
      api.url = u; api.token = '';
      try { localStorage.setItem(KEY + '.api', JSON.stringify({ url: u, token: '' })); } catch (e) { /* ignore */ }
      history.replaceState(null, '', location.pathname + location.hash);
    }
  })();
  const isSheets = () => !!api.url;
  // session หลังเข้าสู่ระบบด้วย PIN (หมดอายุตามที่ server กำหนด)
  let session = (() => { try { const s = JSON.parse(localStorage.getItem(KEY + '.session')); return s && s.exp > Date.now() ? s : null; } catch (e) { return null; } })();
  const storeKey = () => (isSheets() ? KEY + '.sheets' : KEY);
  const POLL_MS = 20000;
  const DCS = ['DC พุทธมณฑลสาย 3', 'CDC บางนา', 'DC ร้อยเอ็ด', 'DC ชุมพร', 'DC รังสิต', 'DC ชลบุรี', 'DC ลำพูน', 'DC ขอนแก่น'];
  const PROV = ['กรุงเทพมหานคร', 'สมุทรปราการ', 'ร้อยเอ็ด', 'ชุมพร', 'ปทุมธานี', 'ชลบุรี', 'ลำพูน', 'ขอนแก่น'];
  const LOCS = [
    ['ถ.พุทธมณฑลสาย 3 บางแค', 'ถ.เพชรเกษม ภาษีเจริญ', 'ถ.บรมราชชนนี ตลิ่งชัน'],
    ['ถ.บางนา-ตราด กม.18', 'ถ.ศรีนครินทร์', 'ถ.เทพารักษ์'],
    ['ถ.แจ้งสนิท ร้อยเอ็ด', 'ถ.ร้อยเอ็ด-ยโสธร', 'อ.เสลภูมิ'],
    ['ถ.เพชรเกษม ชุมพร', 'อ.หลังสวน', 'อ.ปะทิว'],
    ['ถ.พหลโยธิน รังสิต', 'ถ.รังสิต-นครนายก', 'อ.ลำลูกกา'],
    ['ถ.สุขุมวิท ชลบุรี', 'อ.ศรีราชา', 'อ.บ้านบึง'],
    ['นิคมอุตสาหกรรมลำพูน', 'ถ.ซุปเปอร์ไฮเวย์ ลำปาง-เชียงใหม่', 'อ.ป่าซาง'],
    ['ถ.มิตรภาพ ขอนแก่น', 'อ.บ้านไผ่', 'อ.น้ำพอง'],
  ];
  const DRIVERS = ['สมชาย ใจดี', 'ประเสริฐ ทองคำ', 'วิชัย ศรีสุข', 'อนุชา แก้วมณี', 'สุรชัย มั่นคง', 'ธนากร พรหมมา', 'บุญเลิศ สายทอง', 'กิตติ วงศ์ไทย', 'ณัฐพล บุญมา', 'อำนาจ ศักดิ์ดี', 'ชัยวัฒน์ รุ่งเรือง', 'สมศักดิ์ เพชรดี'];
  const INSPECTORS = ['หัวหน้ากะ DC', 'ผู้ควบคุมคุณภาพ (QC)', 'เจ้าหน้าที่ Fleet', 'Control Tower'];
  const TYPE_LABEL = { Frozen: 'แช่แข็ง (Frozen)', Chilled: 'แช่เย็น (Chilled)', Cool: 'ควบคุมอุณหภูมิ (Cool)' };
  const TYPE_SHORT = { Frozen: 'แช่แข็ง', Chilled: 'แช่เย็น', Cool: 'Cool' };
  const STATUS_LABEL = { new: 'รอรับทราบ', ack: 'กำลังตรวจสอบ', resolved: 'ปิดงานแล้ว' };
  // ---- ผลการตรวจสอบ: หมวดสาเหตุ (รถ / คน / ระบบ) + การปิดเคส (แก้ไขแล้ว / แก้ไขไม่ได้)
  const OTHER = 'อื่น ๆ (ระบุในหมายเหตุ)';
  const CATEGORIES = {
    'รถ': ['ระบบทำความเย็น / คอมเพรสเซอร์ขัดข้อง', 'ซีลยาง / ประตูตู้ชำรุด ปิดไม่สนิท', 'เซนเซอร์ / อุปกรณ์วัดอุณหภูมิเสีย', 'แบตเตอรี่ / ไฟเลี้ยงเครื่องทำความเย็น', OTHER],
    'คน': ['เปิดประตูตู้นาน / เปิดบ่อยระหว่างส่งสินค้า', 'ปิดหรือตั้งค่าเครื่องทำความเย็นผิด', 'ไม่ได้ Pre-cool ตู้ก่อนโหลดสินค้า', 'โหลดสินค้าที่อุณหภูมิไม่ได้มาตรฐาน', OTHER],
    'ระบบ': ['สัญญาณ GPS / ข้อมูลขาดหาย', 'ระบบรายงานอุณหภูมิผิดพลาด', 'ตั้งค่าเกณฑ์ในระบบไม่ถูกต้อง', 'รถจอด/ไม่ได้ใช้งาน แต่ระบบแจ้งวิกฤต', OTHER],
  };
  const CAT_COLOR = { 'รถ': 'var(--info)', 'คน': 'var(--warn)', 'ระบบ': '#8b5cf6' };
  const CAT_ICON = { 'รถ': 'truck', 'คน': 'clipboard', 'ระบบ': 'wifiOff' };
  const CLOSURE = { fixed: 'แก้ไขแล้ว', unfixed: 'แก้ไขไม่ได้', reset: 'รีเซ็ตเป็นปกติ (ผู้ดูแล)' };
  const CLOSURE_COLOR = { fixed: 'var(--ok)', unfixed: 'var(--orange)', reset: 'var(--slate)' };
  const UNFIXED_REASONS = ['รออะไหล่ / รอคิวซ่อม', 'รถอยู่ระหว่างวิ่งงาน ยังเข้าตรวจไม่ได้', 'ติดต่อพนักงานขับรถไม่ได้', 'รอผู้ให้บริการ GPS แก้ไขระบบ', OTHER];
  const ACTIONS = [
    'โทรสอบถามพนักงานขับรถ', 'ให้ พขร. ปรับตั้งค่าเครื่องทำความเย็น', 'ปิดประตู / ตรวจซีลยาง', 'ตรวจสอบสินค้าที่หน้างาน',
    'ย้ายสินค้าไปรถคันอื่น', 'ส่งรถเข้าศูนย์ซ่อม', 'แจ้งผู้ให้บริการ GPS',
  ];
  const closureText = (i) => (i ? `${CLOSURE[i.closure] || '–'}${i.closure === 'unfixed' && i.unfixedReason ? ` — ${i.unfixedReason}` : ''}` : '–');
  const ROUTE_META = {
    dashboard: ['ภาพรวมแจ้งเตือนอุณหภูมิ', 'TEMPERATURE CONTROL / DC ALERT'],
    alerts: ['รายการแจ้งเตือน', 'ALERTS / รับทราบและบันทึกผลการตรวจสอบ'],
    inspections: ['บันทึกผลการตรวจสอบ', 'INSPECTION LOG / ประวัติการแก้ไข'],
    vehicles: ['สถานะรถ / อุณหภูมิสด', 'LIVE TEMPERATURE / FLEET MONITOR'],
    report: ['สรุปผลตาม DC', 'REPORT / KPI การตอบสนองของ DC'],
    settings: ['เกณฑ์อุณหภูมิ / ระบบ', 'SETTINGS / THRESHOLD & NOTIFICATION'],
    import: ['นำเข้ารายงานประจำวัน', 'DAILY IMPORT / รายงาน Temperature Dashboard จาก GPS'],
  };
  const TYPE_LABEL_GPS = { Frozen: 'ช่องแช่แข็ง (Frozen)', Chilled: 'ช่องแช่เย็น (Chilled)' };
  const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  const FILTER_ROUTES = ['dashboard', 'alerts', 'inspections', 'vehicles', 'report'];

  // ---------- Icons (lucide-style) ----------
  const ICONS = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    thermo: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
    truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
    chart: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3 0 1.4.9 2.5 2.5 3z"/>',
    snow: '<path d="M2 12h20M12 2v20m8-6-4-4 4-4M4 8l4 4-4 4M16 4l-4 4-4-4M8 20l4-4 4 4"/>',
    check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    wifiOff: '<path d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 4.17-2.65M10.66 5c4.01-.36 8.14.9 11.34 3.76M16.85 11.25a10 10 0 0 1 2.22 1.68M5 13a10 10 0 0 1 5.24-2.76M2 2l20 20"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  };
  const icon = (n) => `<span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ''}</svg></span>`;
  function hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon).replace('class="ico"', `class="ico"${el.id ? ` id="${el.id}"` : ''}`); });
  }

  // ---------- Helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r1 = (n) => Math.round(n * 10) / 10;
  const fmtT = (n) => (n == null || isNaN(n) ? '–' : `${n > 0 ? '+' : ''}${r1(n).toFixed(1)}°C`);
  const MIN = 60000;
  function rng(seed) {
    return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  const fmtDate = (t) => (t ? new Date(t).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');
  const fmtTime = (t) => new Date(t).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  function dur(ms) {
    const m = Math.max(0, Math.round(ms / MIN));
    if (m < 60) return `${m} นาที`;
    if (m < 1440) return `${Math.floor(m / 60)} ชม. ${m % 60 ? (m % 60) + ' น.' : ''}`.trim();
    return `${Math.floor(m / 1440)} วัน ${Math.floor((m % 1440) / 60)} ชม.`;
  }
  const ago = (t) => (Date.now() - t < MIN ? 'เมื่อสักครู่' : `${dur(Date.now() - t)}ที่แล้ว`);
  const toLocalInput = (t) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

  // ---------- State ----------
  const DEFAULT_SETTINGS = {
    thresholds: { Frozen: { min: -25, max: -15 }, Chilled: { min: 0, max: 8 }, Cool: { min: 15, max: 25 } },
    criticalDelta: 5,
    sim: true,
    sound: true,
    desktop: false,
    user: 'admin',
    simEvery: 10,
  };
  let seedSeq = 1000;
  let state = null;
  state = load();
  const ui = {
    route: 'dashboard', q: '', dc: '', type: '', status: '', period: '7d',
    modalPhotos: [],
  };

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(storeKey()));
      if (isSheets() && !s) DCS.length = 0;
      const oldSchema = s && !isSheets() && Array.isArray(s.alerts) && s.alerts.some((a) => a.inspection && !a.inspection.closure);
      if (s && s.v === 1 && Array.isArray(s.alerts) && !oldSchema) {
        if (isSheets() && Array.isArray(s.dcs)) DCS.splice(0, DCS.length, ...s.dcs);
        return s;
      }
    } catch (e) { /* ignore */ }
    if (isSheets()) {
      const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      settings.sim = false;
      return { v: 1, seq: 0, settings, vehicles: [], alerts: [], role: 'ALL', loaded: false };
    }
    return seedData();
  }
  function save() {
    try { localStorage.setItem(storeKey(), JSON.stringify(state)); }
    catch (e) { toast('บันทึกไม่สำเร็จ', 'พื้นที่จัดเก็บเต็ม — ลองลดจำนวน/ขนาดรูปภาพ', 'danger'); }
  }
  const th = (type) => state.settings.thresholds[type] || DEFAULT_SETTINGS.thresholds[type] || { min: -Infinity, max: Infinity };

  // ---------- Google Sheets API ----------
  async function apiPost(action, payload = {}, conf = api) {
    const res = await fetch(conf.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // text/plain เพื่อเลี่ยง CORS preflight ของ Apps Script
      body: JSON.stringify({ token: conf.token || '', session: session ? session.session : '', action, ...payload }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let j;
    try { j = await res.json(); } catch (e) { throw new Error('Apps Script ไม่ได้ตอบกลับเป็น JSON — ตรวจสอบการ Deploy (Who has access: Anyone)'); }
    if (!j.ok) { const err = new Error(j.error || 'เกิดข้อผิดพลาด'); err.auth = j.code === 'auth'; throw err; }
    return j;
  }

  // ---------- เข้าสู่ระบบด้วย PIN (โหมด Google Sheets) ----------
  function logout(msg) {
    session = null;
    try { localStorage.removeItem(KEY + '.session'); localStorage.removeItem(KEY + '.sheets'); } catch (e) { /* ignore */ }
    if (msg !== undefined) { state.alerts = []; state.vehicles = []; state.loaded = false; ro.vehicles = []; showLogin(msg); }
    else location.reload();
  }
  async function showLogin(msg = '') {
    let el = $('#login');
    if (!el) { el = document.createElement('div'); el.id = 'login'; el.className = 'login-screen'; document.body.appendChild(el); }
    let last = '';
    try { last = localStorage.getItem(KEY + '.lastTeam') || ''; } catch (e) { /* ignore */ }
    el.innerHTML = `<form class="login-card" id="loginForm" autocomplete="on">
        <div class="brand" style="border:0;padding:0;margin:0 0 6px"><div class="brand-logo">${icon('thermo')}</div>
          <div><div class="brand-name">TEMP WATCH</div><div class="brand-sub">FLEET / COLD CHAIN</div></div></div>
        <h2>เข้าสู่ระบบ</h2>
        <p class="muted small" style="margin:-6px 0 4px">เลือก DC หรือทีม แล้วใส่ PIN ที่ได้รับจากผู้ดูแลระบบ</p>
        <label class="fl">DC / ทีม<select class="inp" id="lgTeam" disabled><option>กำลังโหลดรายชื่อ...</option></select></label>
        <label class="fl">PIN<input class="inp" id="lgPin" type="password" inputmode="numeric" autocomplete="current-password" placeholder="••••••"></label>
        <div class="login-err" id="lgErr">${esc(msg)}</div>
        <button class="btn btn-primary" type="submit" id="lgBtn">เข้าสู่ระบบ</button>
        <button class="link small" type="button" data-action="api-disconnect" style="margin-top:4px">ยกเลิกการเชื่อมต่อ Google Sheets (กลับไปโหมดอ่านข้อมูล)</button>
      </form>`;
    el.hidden = false;
    try {
      const j = await apiPost('teams');
      const sel = $('#lgTeam');
      sel.innerHTML = '<option value="">– เลือก DC / ทีม –</option>' + j.teams.map((t) => `<option>${esc(t)}</option>`).join('');
      sel.disabled = false;
      if (j.teams.includes(last)) { sel.value = last; $('#lgPin').focus(); } else sel.focus();
      if (!j.teams.length) $('#lgErr').textContent = 'ยังไม่มีทีมที่ตั้ง PIN — ให้ผู้ดูแลกรอก PIN ในชีต Teams';
    } catch (e) { $('#lgErr').textContent = 'โหลดรายชื่อทีมไม่ได้: ' + e.message; }
  }
  async function submitLogin() {
    const team = $('#lgTeam').value, pin = $('#lgPin').value.trim();
    if (!team || !pin) { $('#lgErr').textContent = 'กรุณาเลือกทีมและใส่ PIN'; return; }
    const btn = $('#lgBtn');
    btn.disabled = true; btn.textContent = 'กำลังตรวจสอบ...';
    try {
      const j = await apiPost('login', { team, pin });
      session = { session: j.session, team: j.team, role: j.role, dcs: j.dcs, exp: j.exp };
      try { localStorage.setItem(KEY + '.session', JSON.stringify(session)); localStorage.setItem(KEY + '.lastTeam', j.team); } catch (e) { /* ignore */ }
      $('#login').hidden = true;
      state.loaded = false;
      setupControls();
      await refresh();
      toast('เข้าสู่ระบบแล้ว', `${j.team} · เห็นข้อมูล ${j.dcs.includes('*') ? 'ทุก DC' : j.dcs.join(', ')}`);
    } catch (e) {
      $('#lgErr').textContent = e.message;
      btn.disabled = false; btn.textContent = 'เข้าสู่ระบบ';
      $('#lgPin').select();
    }
  }
  let lastSig = '';
  function applyRemote(j) {
    const prev = new Set(state.alerts.map((a) => a.id));
    const hadData = state.loaded;
    const sig = JSON.stringify([j.alerts, j.vehicles, j.settings, j.dcs]);
    state.imports = j.imports || [];
    if (j.me) ui.me = j.me;
    state.role = 'ALL'; // server ส่งเฉพาะ DC ที่ทีมนี้มีสิทธิ์อยู่แล้ว
    if (Array.isArray(j.dcs) && j.dcs.join('|') !== DCS.join('|')) {
      DCS.splice(0, DCS.length, ...j.dcs);
      setupControls();
    }
    state.dcs = DCS.slice();
    state.vehicles = j.vehicles;
    state.alerts = j.alerts.slice().sort((a, b) => b.time - a.time);
    state.settings.thresholds = j.settings.thresholds;
    state.settings.criticalDelta = j.settings.criticalDelta;
    state.loaded = true;
    ro.vehicles = state.vehicles;
    ro.loadedAt = Date.now();
    save();
    if (hadData) state.alerts.filter((a) => !prev.has(a.id) && a.status !== 'resolved').slice(0, 5).forEach(notifyNew);
    setLive(true);
    if (sig !== lastSig) { lastSig = sig; render(); }
  }
  /** เรียก API แล้วอัปเดตหน้าจอ — คืน true ถ้าสำเร็จ */
  async function remote(action, payload, { quiet = false } = {}) {
    document.body.classList.add('busy');
    try {
      const j = await apiPost(action, payload);
      applyRemote(j);
      return j;
    } catch (e) {
      if (e.auth) { logout(e.message); return false; }
      setLive(false, e.message);
      if (!quiet) toast('เชื่อมต่อ Google Sheets ไม่สำเร็จ', e.message, 'danger');
      return false;
    } finally {
      document.body.classList.remove('busy');
    }
  }
  const refresh = () => remote('state', {}, { quiet: state.loaded });

  // ---------- Google Sheet รายงาน (อ่านอย่างเดียว — ไม่ต้องติดตั้ง Apps Script) ----------
  // อ่านชีต "รายคัน", "ประวัติเกินเกณฑ์", "สรุปเกินเกณฑ์ตามคัน" ผ่าน gviz CSV (ไฟล์ต้องแชร์แบบ "ทุกคนที่มีลิงก์ดูได้")
  // ไม่ฝังรหัสไฟล์รายงานไว้ในโค้ด (โค้ดขึ้น GitHub แบบ Public) — ตั้งได้ที่หน้าตั้งค่า ถ้าต้องการโหมดดูอย่างเดียว
  const DEFAULT_SRC = '';
  const src = (() => { try { const s = JSON.parse(localStorage.getItem(KEY + '.src')); if (s && typeof s.id === 'string') return s; } catch (e) { /* ignore */ } return { id: DEFAULT_SRC }; })();
  const isRO = () => !isSheets() && !!src.id;
  const NO_DC = 'ไม่ระบุ DC';
  const GPS_STATUSES = ['วิกฤต', 'แจ้งเตือน', 'ปกติ', 'Standby', 'ออฟไลน์', 'ปิดใช้งาน'];
  const GPS_COLOR = { 'วิกฤต': 'var(--crit)', 'แจ้งเตือน': 'var(--warn)', 'ปกติ': 'var(--ok)', 'Standby': 'var(--info)', 'ออฟไลน์': 'var(--slate)', 'ปิดใช้งาน': '#9aa4b1' };
  const VMAP = { plate: ['ทะเบียน'], gpsId: ['GPS'], group: ['กลุ่ม'], vtype: ['ประเภทรถ'], owner: ['ชนิดรถ'], driver: ['ชื่อ'], phone: ['เบอร์'],
    status: ['สถานะ'], tempF: ['Frozen'], tempC: ['Chilled'], overCont: ['เกินเกณฑ์'], parkOut: ['จอด'], updated: ['อัพเดท', 'อัปเดต'] };
  const EMAP = { plate: ['ทะเบียน'], start: ['เริ่ม'], end: ['กลับปกติ', 'สิ้นสุด'], minutes: ['ระยะเวลา'], waybill: ['ใบรายการ'], waybillType: ['ประเภทใบรายการ'], dc: ['DC'] };
  const TMAP = { plate: ['ทะเบียน'], count: ['จำนวนครั้ง'], minutes: ['รวมเวลา'] };
  const ro = { vehicles: [], events: [], top: {}, loadedAt: 0, error: '', loading: false };
  const srcLink = (id) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

  function parseCsv(text) {
    const rows = [];
    let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  function mapCols(rows, spec) {
    const head = (rows[0] || []).map((h) => String(h).trim());
    const idx = {};
    Object.keys(spec).forEach((k) => {
      let j = head.findIndex((h) => spec[k].some((p) => h.indexOf(p) === 0));
      if (j < 0) j = head.findIndex((h) => spec[k].some((p) => h.includes(p)));
      idx[k] = j;
    });
    return {
      has: (k) => idx[k] >= 0,
      list: rows.slice(1).map((r) => { const o = {}; Object.keys(idx).forEach((k) => { o[k] = idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : ''; }); return o; }).filter((o) => o.plate),
    };
  }
  const numOrNull = (s) => (s === '' || s == null || !isFinite(Number(s)) ? null : Number(s));
  /** "2026-11-05 13:22" | "11/14/26 14:26" (เดือน/วัน/ปี ตามไฟล์) | "14/11/2569 14:26" */
  function parseDate(s) {
    s = String(s || '').trim();
    if (!s) return null;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    if (m) return new Date(+m[1] > 2400 ? m[1] - 543 : +m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s);
    if (m) {
      const a = +m[1], b = +m[2];
      let y = +m[3];
      if (y < 100) y += 2000;
      if (y > 2400) y -= 543;
      const dayFirst = a > 12;
      return new Date(y, (dayFirst ? b : a) - 1, dayFirst ? a : b, +(m[4] || 0), +(m[5] || 0)).getTime();
    }
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  }

  async function loadSheet({ quiet = false } = {}) {
    if (ro.loading) return;
    ro.loading = true;
    if (!ro.loadedAt) render();
    const url = (n) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(src.id)}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(n)}`;
    const get = async (n) => {
      const r = await fetch(url(n), { cache: 'no-store' });
      if (!r.ok) throw new Error(`โหลดชีต "${n}" ไม่ได้ (HTTP ${r.status}) — ตรวจสอบลิงก์และการแชร์ไฟล์`);
      const t = await r.text();
      if (/^\s*<(!doctype|html)/i.test(t)) throw new Error('เปิดไฟล์ไม่ได้ — ต้องแชร์ไฟล์แบบ "ทุกคนที่มีลิงก์ดูได้"');
      return parseCsv(t);
    };
    try {
      const [vr, er, tr] = await Promise.all([get('รายคัน'), get('ประวัติเกินเกณฑ์').catch(() => []), get('สรุปเกินเกณฑ์ตามคัน').catch(() => [])]);
      const V = mapCols(vr, VMAP);
      if (!V.has('status') || !V.has('tempF')) throw new Error('ไม่พบชีต "รายคัน" (ต้องมีคอลัมน์ ทะเบียน, สถานะ, Frozen, Chilled)');
      const E = mapCols(er, EMAP);
      const events = E.has('start') ? E.list.map((e) => ({ plate: e.plate, start: parseDate(e.start), end: parseDate(e.end), minutes: numOrNull(e.minutes),
        waybill: e.waybill, waybillType: e.waybillType, dc: e.dc })).filter((e) => e.start) : [];
      const T = mapCols(tr, TMAP);
      const top = {};
      if (T.has('count') && T.has('minutes')) T.list.forEach((t) => { top[t.plate] = { count: numOrNull(t.count), minutes: numOrNull(t.minutes) }; });
      const lastDc = {};
      events.forEach((e) => { if (e.dc && (!lastDc[e.plate] || e.start > lastDc[e.plate].start)) lastDc[e.plate] = e; });
      const vehicles = V.list.map((v) => {
        const updated = parseDate(v.updated);
        const overCont = numOrNull(v.overCont);
        const d = lastDc[v.plate];
        return {
          id: v.plate, plate: v.plate, gpsId: v.gpsId, group: v.group, vtype: v.vtype, owner: v.owner, driver: v.driver, phone: v.phone,
          gpsStatus: v.status, tempF: numOrNull(v.tempF), tempC: numOrNull(v.tempC), overCont, parkOut: numOrNull(v.parkOut), updated,
          dc: d ? d.dc : NO_DC, waybill: d ? d.waybill : '', online: !['ออฟไลน์', 'ปิดใช้งาน'].includes(v.status), type: 'Frozen', temp: numOrNull(v.tempF),
        };
      });
      const prevCrit = new Set(ro.vehicles.filter((v) => v.gpsStatus === 'วิกฤต').map((v) => v.plate));
      const first = !ro.loadedAt;
      Object.assign(ro, { vehicles, events, top, loadedAt: Date.now(), error: '' });
      const dcs = [...new Set(vehicles.map((v) => v.dc))].sort((a, b) => (a === NO_DC) - (b === NO_DC) || a.localeCompare(b, 'th', { numeric: true }));
      DCS.splice(0, DCS.length, ...dcs);
      setupControls();
      setLive(true);
      if (!first) {
        const fresh = vehicles.filter((v) => v.gpsStatus === 'วิกฤต' && !prevCrit.has(v.plate) && inRole(v.dc));
        fresh.slice(0, 3).forEach((v) => toast('สถานะวิกฤตใหม่', `${v.plate} · ${v.dc} · Frozen ${fmtT(v.tempF)} / Chilled ${fmtT(v.tempC)}`, 'danger'));
        if (fresh.length > 3) toast('สถานะวิกฤตใหม่', `และอีก ${fresh.length - 3} คัน`, 'danger');
        if (fresh.length && state.settings.sound) beep(2);
      }
    } catch (e) {
      ro.error = e.message;
      setLive(false, e.message);
      if (!quiet) toast('โหลดข้อมูลจาก Google Sheet ไม่สำเร็จ', e.message, 'danger');
    } finally {
      ro.loading = false;
      render();
    }
  }
  const center = (type) => (th(type).min + th(type).max) / 2;

  function seedData() {
    const r = rng(20261114);
    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    const vehicles = [];
    let n = 0;
    DCS.forEach((dc, i) => {
      const count = 7 + Math.floor(r() * 6);
      for (let k = 0; k < count; k++) {
        n++;
        const x = r();
        const type = x < 0.45 ? 'Frozen' : x < 0.8 ? 'Chilled' : 'Cool';
        const t = settings.thresholds[type];
        vehicles.push({
          id: 'V' + String(n).padStart(3, '0'),
          plate: `${pick(r, ['70', '71', '72'])}-${1000 + Math.floor(r() * 8999)}`,
          prov: PROV[i], dc, dcIdx: i, type,
          owner: r() < 0.8 ? 'บริษัท' : 'ผปก.',
          driver: pick(r, DRIVERS),
          temp: r1((t.min + t.max) / 2 + (r() - 0.5) * (t.max - t.min) * 0.5),
          updated: Date.now() - Math.floor(r() * 4) * MIN,
          online: r() > 0.06,
        });
      }
    });
    const alerts = [];
    const now = Date.now();
    for (let i = 0; i < 64; i++) {
      const v = pick(r, vehicles);
      const t = settings.thresholds[v.type];
      const ageMin = i < 6 ? Math.floor(r() * 90) + 3 : Math.floor(r() * 30 * 24 * 60);
      const time = now - ageMin * MIN;
      if (alerts.some((a) => a.vehicleId === v.id && a.status !== 'resolved')) continue;
      const high = r() < 0.78;
      const dev = r1(0.8 + r() * (r() < 0.3 ? 10 : 5));
      const temp = r1(high ? t.max + dev : t.min - dev);
      const a = makeAlert(v, temp, time, settings, 'sensor', r);
      if (ageMin < 120) {
        a.status = r() < 0.65 ? 'new' : 'ack';
      } else if (ageMin < 600) {
        a.status = r() < 0.35 ? 'ack' : 'resolved';
      } else a.status = 'resolved';
      if (a.status !== 'new') {
        a.ackAt = time + Math.floor(3 + r() * 40) * MIN;
        a.ackBy = pick(r, INSPECTORS);
      }
      if (a.status === 'resolved') {
        const x = r();
        const category = x < 0.45 ? 'คน' : x < 0.8 ? 'รถ' : 'ระบบ';
        const fixed = r() < 0.78;
        a.inspection = {
          at: a.ackAt + Math.floor(10 + r() * 150) * MIN,
          by: a.ackBy,
          category, cause: pick(r, CATEGORIES[category].slice(0, -1)),
          driverCheck: category === 'คน' ? 'พขร. ยืนยันว่าเปิดประตูส่งสินค้าหลายจุด แนะนำให้ปิดทันทีหลังส่ง' : 'โทรสอบถาม พขร. แล้ว รับทราบและตรวจสอบหน้างาน',
          actions: [ACTIONS[0], pick(r, ACTIONS.slice(1))],
          closure: fixed ? 'fixed' : 'unfixed',
          unfixedReason: fixed ? '' : pick(r, UNFIXED_REASONS.slice(0, -1)),
          measured: r1(center2(t) + (r() - 0.5) * 2),
          note: '', photos: [],
        };
      } else {
        v.temp = temp;
      }
      alerts.push(a);
    }
    alerts.sort((a, b) => b.time - a.time);
    return { v: 1, seq: seedSeq + 1, settings, vehicles, alerts, role: 'ALL', readBell: [] };
  }
  function center2(t) { return (t.min + t.max) / 2; }

  function makeAlert(v, temp, time, settings, source, r = Math.random) {
    const t = settings.thresholds[v.type];
    const high = temp > t.max;
    const dev = r1(high ? temp - t.max : t.min - temp);
    const seq = state ? ++state.seq : ++seedSeq;
    return {
      id: 'TA-' + new Date(time).toISOString().slice(2, 10).replace(/-/g, '') + '-' + String(seq).slice(-4).padStart(4, '0'),
      vehicleId: v.id, plate: v.plate, prov: v.prov, dc: v.dc, type: v.type, driver: v.driver, owner: v.owner,
      temp, min: t.min, max: t.max, kind: high ? 'high' : 'low', dev,
      severity: dev >= settings.criticalDelta ? 'critical' : 'warning',
      time, location: pick(r, LOCS[Math.max(0, DCS.indexOf(v.dc))]), source,
      status: 'new', ackAt: null, ackBy: null, inspection: null,
    };
  }

  // ---------- Filtering ----------
  const inRole = (dc) => state.role === 'ALL' || state.role === dc;
  function periodStart() {
    const now = new Date();
    if (ui.period === 'today') { now.setHours(0, 0, 0, 0); return +now; }
    if (ui.period === '7d') return Date.now() - 7 * 1440 * MIN;
    if (ui.period === '30d') return Date.now() - 30 * 1440 * MIN;
    return 0;
  }
  function matchQ(a) {
    if (!ui.q) return true;
    const q = ui.q.toLowerCase();
    return [a.plate, a.dc, a.id, a.driver, a.prov, a.vehicleId, a.gpsId, a.waybill].some((x) => String(x || '').toLowerCase().includes(q));
  }
  function filtered({ ignoreStatus = false, ignorePeriod = false } = {}) {
    const ps = periodStart();
    return state.alerts.filter((a) =>
      inRole(a.dc) && (!ui.dc || a.dc === ui.dc) && (!ui.type || a.type === ui.type) &&
      (ignoreStatus || !ui.status || a.status === ui.status) &&
      // งานที่ยังเปิดอยู่แสดงเสมอแม้เกินช่วงเวลา
      (ignorePeriod || a.time >= ps || a.status !== 'resolved') && matchQ(a));
  }
  const scopedVehicles = () => state.vehicles.filter((v) => inRole(v.dc) && (!ui.dc || v.dc === ui.dc) && (!ui.type || v.gpsStatus !== undefined || v.type === ui.type) && matchQ(v));
  const openAlerts = () => state.alerts.filter((a) => a.status !== 'resolved' && inRole(a.dc));

  // ---------- Rendering: shared pieces ----------
  function tempCell(a) {
    const cls = a.kind === 'high' ? 'hot' : 'cold';
    if (a.tempF !== undefined) {
      return `<div class="temp" style="font-weight:600">F ${a.tempF == null ? '–' : fmtT(a.tempF)}<small>C ${a.tempC == null ? '–' : fmtT(a.tempC)}</small></div>`;
    }
    return `<div class="temp ${cls}">${fmtT(a.temp)}<small>เกณฑ์ ${a.min}…${a.max}°C</small></div>`;
  }
  const sevChip = (a) => a.severity === 'critical'
    ? `<span class="chip crit">วิกฤต ${a.kind === 'high' ? '+' : '−'}${a.dev}°</span>`
    : `<span class="chip ${a.kind === 'high' ? 'warn' : 'cold'}">${a.kind === 'high' ? 'สูงกว่าเกณฑ์' : 'ต่ำกว่าเกณฑ์'} ${a.kind === 'high' ? '+' : '−'}${a.dev}°</span>`;
  const statusChip = (s) => `<span class="chip ${s}">${STATUS_LABEL[s]}</span>`;
  function rowActions(a) {
    if (a.status === 'new') return `<button class="btn btn-xs btn-warn" data-action="ack" data-id="${a.id}">รับทราบ</button><button class="btn btn-xs btn-primary" data-action="open" data-id="${a.id}">บันทึกผล</button>`;
    if (a.status === 'ack') return `<button class="btn btn-xs btn-primary" data-action="open" data-id="${a.id}">บันทึกผล</button>`;
    return `<button class="btn btn-xs btn-outline" data-action="open" data-id="${a.id}">ดูผล</button>`;
  }
  function alertTable(list, { compact = false } = {}) {
    if (!list.length) return `<div class="empty">ไม่มีรายการแจ้งเตือนตามเงื่อนไขที่เลือก</div>`;
    const rows = list.map((a) => {
      const age = a.status === 'resolved' ? dur(a.inspection.at - a.time) : dur(Date.now() - a.time);
      return `<tr data-action="open" data-id="${a.id}">
        <td><div style="font-weight:600">${fmtDate(a.time)}</div><div class="muted small">${a.id}</div></td>
        <td><div class="plate">${esc(a.plate)}<small>${a.tempF !== undefined ? esc(a.waybill ? 'ใบรายการ ' + a.waybill : a.group || '') : `${esc(a.prov)} · ${TYPE_SHORT[a.type]}`}</small></div></td>
        <td>${esc(a.dc)}${compact ? '' : `<div class="muted small">${esc(a.location)}</div>`}</td>
        <td>${tempCell(a)}</td>
        <td>${a.gpsStatus !== undefined ? gpsChip(a.gpsStatus) : sevChip(a)}</td>
        <td>${statusChip(a.status)}${a.ackBy && a.status === 'ack' ? `<div class="muted small">โดย ${esc(a.ackBy)}</div>` : ''}</td>
        <td class="muted">${a.status === 'resolved' ? 'แก้ไขใน ' : ''}${age}</td>
        <td><div class="actions">${rowActions(a)}</div></td>
      </tr>`;
    }).join('');
    return `<div class="table-wrap"><table>
      <thead><tr><th>เวลาแจ้งเตือน</th><th>ทะเบียนรถ</th><th>DC / ตำแหน่ง</th><th>อุณหภูมิ</th><th>${list.some((a) => a.gpsStatus !== undefined) ? 'สถานะ GPS' : 'ระดับ'}</th><th>สถานะเคส</th><th>ระยะเวลา</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }
  const sortOpen = (a, b) => (a.status === b.status ? 0 : a.status === 'new' ? -1 : b.status === 'new' ? 1 : 0) || (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1) || b.time - a.time;

  /** การ์ดตัวเลข: กรอบใช้สีเดียวกับไอคอน, glow = กรอบเรืองแสง (ใช้กับการ์ดที่ต้องการเน้น) */
  function kpi({ label, value, unit = '', ico, color, sub, go, blink, ring }) {
    return `<div class="kpi${blink ? ' blink' : ''}" style="--c:${ring || color}" ${go ? `data-action="go" data-go="${go}"` : ''}>
      <div class="kpi-top"><div class="kpi-label">${label}</div><div class="kpi-ico" style="background:${color}">${icon(ico)}</div></div>
      <div class="kpi-val">${value}${unit ? `<small>${unit}</small>` : ''}</div>
      <div class="kpi-sub">${sub}</div></div>`;
  }

  // ---------- สรุปเคส: จำนวนเคสรายวัน / สาเหตุ (รถ-คน-ระบบ) / การปิดเคส — กราฟและ % ----------
  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '–');
  const catChip = (c) => (c ? `<span class="chip" style="background:color-mix(in srgb, ${CAT_COLOR[c] || 'var(--slate)'} 16%, transparent);color:${CAT_COLOR[c] || 'var(--slate)'}">${esc(c)}</span>` : '–');
  const closureChip = (i) => (i && CLOSURE[i.closure] ? `<span class="chip ${i.closure === 'fixed' ? 'resolved' : i.closure === 'reset' ? 'off' : 'warn'}">${CLOSURE[i.closure]}</span>` : '–');
  const isAdmin = () => isSheets() && !!ui.me && ui.me.role === 'admin';
  /** ไอคอนผู้ดูแลบนการ์ดรถ (หน้า สถานะรถ / อุณหภูมิสด): ปรับเป็นเคส / รีเซ็ตเป็นปกติ */
  function adminIcons(plate) {
    if (!isAdmin()) return '';
    const hasOpen = state.alerts.some((a) => a.plate === plate && a.status !== 'resolved');
    if (hasOpen) return '';
    return `<div class="v-admin"><span class="v-admin-lbl">${icon('sliders')} Admin</span>
      <button class="v-admin-btn warn" data-action="admin-ask" data-mode="open" data-plate="${esc(plate)}" title="ปรับเป็นเคส">${icon('alert')}ปรับเป็นเคส</button>
    </div>`;
  }

  // ---------- รีเซ็ตเป็นปกติ (ผู้ดูแล): รายคัน / ทั้งหมด / ตามวันที่ของข้อมูล ----------
  const RESET_ST = ['วิกฤต', 'แจ้งเตือน'];
  /** รถที่รีเซ็ตได้ = สถานะวิกฤต/แจ้งเตือน หรือมีเคสค้าง */
  function resetCandidates() {
    const open = new Map();
    state.alerts.filter((a) => a.status !== 'resolved').forEach((a) => open.set(a.plate, (open.get(a.plate) || 0) + 1));
    const seen = new Set();
    const out = [];
    state.vehicles.forEach((v) => {
      if (RESET_ST.includes(v.gpsStatus) || open.has(v.plate)) { out.push({ plate: v.plate, dc: v.dc, status: v.gpsStatus, cases: open.get(v.plate) || 0 }); seen.add(v.plate); }
    });
    open.forEach((n, p) => { if (!seen.has(p)) { const a = state.alerts.find((x) => x.plate === p); out.push({ plate: p, dc: a ? a.dc : '', status: '', cases: n }); } });
    return out.sort((a, b) => a.plate.localeCompare(b.plate, 'th'));
  }
  function resetDates() {
    const m = new Map();
    state.alerts.filter((a) => a.status !== 'resolved').forEach((a) => { const k = dayKey(a.time); m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }
  const ymdOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  function openResetDialog() {
    ui.reset = { mode: 'plates', sel: new Set(), q: '', date: '' };
    openModal(`<div class="modal-head"><div><h2>รีเซ็ตเป็นปกติ</h2>
        <div class="muted small" style="margin-top:4px">ปิดเคสที่ค้าง และตั้งสถานะรถเป็น "ปกติ" จนกว่าจะนำเข้ารายงานครั้งถัดไป</div></div>
        <button class="icon-btn close" data-action="close-modal" aria-label="ปิด">${icon('x')}</button></div>
      <div class="modal-body">
        <div class="seg" id="rsMode">
          <label class="seg-opt" style="--c:var(--brand)"><input type="radio" name="rsMode" value="plates" checked>${icon('truck')}<b>รายคัน</b></label>
          <label class="seg-opt" style="--c:var(--danger)"><input type="radio" name="rsMode" value="all">${icon('grid')}<b>ทั้งหมด</b></label>
          <label class="seg-opt" style="--c:var(--info)"><input type="radio" name="rsMode" value="date">${icon('calendar')}<b>ตามวันที่ข้อมูล</b></label>
        </div>
        <div id="rsBody" style="margin-top:16px"></div>
        <label class="fl" style="margin-top:16px">เหตุผล <span class="req">*</span>
          <textarea class="inp" id="adminReason" placeholder="เช่น ตรวจสอบแล้วเป็นการแจ้งเตือนผิดพลาดจากเซนเซอร์ / เริ่มรอบติดตามใหม่"></textarea></label>
        <p class="muted small" style="margin:8px 0 0">เหตุผลจะถูกบันทึกพร้อมวันเวลาและทีมในชีต Alerts (คอลัมน์ adminLog) · เคสที่รีเซ็ตไม่นับในสถิติ แก้ไขแล้ว/แก้ไขไม่ได้</p>
      </div>
      <div class="modal-foot"><button class="btn btn-sm btn-outline" data-action="close-modal">ยกเลิก</button>
        <button class="btn btn-sm btn-primary" data-action="reset-submit" id="rsSubmit">ยืนยันรีเซ็ต</button></div>`);
    card.classList.add('modal-md');
    renderResetBody();
  }
  function renderResetBody() {
    const r = ui.reset;
    const box = $('#rsBody');
    if (!box) return;
    const cands = resetCandidates();
    if (r.mode === 'plates') {
      const q = r.q.toLowerCase();
      const shown = cands.filter((c) => !q || c.plate.toLowerCase().includes(q) || String(c.dc).toLowerCase().includes(q));
      box.innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label class="field search" style="height:40px;min-width:0;flex:1">${icon('search')}<input id="rsQ" placeholder="ค้นหาทะเบียน / DC" value="${esc(r.q)}"></label>
          <button class="btn btn-xs btn-outline" data-action="rs-all-shown">เลือกทั้งหมดที่แสดง</button>
          <button class="btn btn-xs btn-outline" data-action="rs-none">ล้างที่เลือก</button></div>
        <div class="rs-list">${shown.map((c) => `<label class="rs-item"><input type="checkbox" data-plate="${esc(c.plate)}" ${r.sel.has(c.plate) ? 'checked' : ''}>
            <b>${esc(c.plate)}</b><span class="muted small">${esc(c.dc && c.dc !== NO_DC ? c.dc : '')}</span>
            <span class="rs-tags">${c.status ? gpsChip(c.status) : ''}${c.cases ? `<span class="chip new">เคสค้าง ${c.cases}</span>` : ''}</span></label>`).join('') || '<div class="empty">ไม่พบรถที่รีเซ็ตได้</div>'}</div>
        <div class="muted small" style="margin-top:8px">แสดงเฉพาะรถที่สถานะวิกฤต/แจ้งเตือน หรือมีเคสค้าง (${cands.length} คัน) · เลือกแล้ว <b>${r.sel.size}</b> คัน</div>`;
    } else if (r.mode === 'all') {
      const cases = state.alerts.filter((a) => a.status !== 'resolved').length;
      box.innerHTML = `<div class="rs-warn">${icon('alert')}<div>จะรีเซ็ตรถทั้งหมด <b>${cands.length}</b> คัน และปิดเคสค้างทั้งหมด <b>${cases}</b> เคส<br>
        <span class="small">ใช้เมื่อต้องการเริ่มรอบติดตามใหม่ — ย้อนกลับไม่ได้ (ข้อมูลเดิมยังอยู่ในชีต และดูประวัติได้)</span></div></div>`;
    } else {
      const dates = resetDates();
      box.innerHTML = dates.length ? `<label class="fl">วันที่ของข้อมูล (วันที่เปิดเคส)<select class="inp" id="rsDate"><option value="">– เลือกวันที่ –</option>
          ${dates.map(([d, n]) => `<option value="${ymdOf(d)}" ${r.date === ymdOf(d) ? 'selected' : ''}>${new Date(d).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' })} — เคสค้าง ${n} เคส</option>`).join('')}</select></label>
        <div class="muted small" style="margin-top:8px">ปิดเคสค้างทั้งหมดที่เปิดในวันที่เลือก และตั้งรถเหล่านั้นเป็นปกติ</div>` : '<div class="empty">ไม่มีเคสค้าง</div>';
    }
    const n = r.mode === 'plates' ? r.sel.size : r.mode === 'all' ? cands.length : (resetDates().find(([d]) => ymdOf(d) === r.date) || [0, 0])[1];
    const btn = $('#rsSubmit');
    btn.textContent = r.mode === 'plates' ? `ยืนยันรีเซ็ต ${n} คัน` : r.mode === 'all' ? `ยืนยันรีเซ็ตทั้งหมด ${n} คัน` : r.date ? `ยืนยันรีเซ็ต ${n} เคส` : 'ยืนยันรีเซ็ต';
    btn.className = `btn btn-sm ${r.mode === 'all' ? 'btn-danger' : 'btn-primary'}`;
    btn.disabled = !n;
  }
  async function submitReset(btn) {
    const r = ui.reset;
    const reason = $('#adminReason').value.trim();
    if (reason.length < 3) { $('#adminReason').classList.add('invalid'); toast('กรุณาระบุเหตุผล', 'ต้องใส่เหตุผลก่อนยืนยัน', 'danger'); return; }
    const payload = r.mode === 'plates' ? { plates: [...r.sel] } : r.mode === 'all' ? { all: true } : { date: r.date };
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'กำลังรีเซ็ต...';
    const j = await remote('adminReset', Object.assign({ reason }, payload));
    if (!j) { btn.disabled = false; btn.textContent = label; return; }
    closeModal();
    toast('รีเซ็ตเป็นปกติแล้ว', `ปิดเคส ${j.reset ? j.reset.cases : 0} เคส · รถ ${j.reset ? j.reset.vehicles : 0} คันเป็นปกติ`);
  }
  /** กล่องใส่เหตุผลก่อนยืนยัน (ผู้ดูแล) */
  function adminAsk(mode, plate) {
    const open = mode === 'open';
    const hasOpen = state.alerts.some((a) => a.plate === plate && a.status !== 'resolved');
    ui.adminMode = mode;
    openModal(`<div class="modal-head"><div><h2>${open ? 'ปรับเป็นเคส' : 'รีเซ็ตเป็นปกติ'} · ${esc(plate)}</h2>
        <div class="muted small" style="margin-top:4px">${open ? 'เปิดเคสให้ DC ตรวจสอบรถคันนี้' : hasOpen ? 'ปิดเคสที่ค้างของรถคันนี้ และตั้งสถานะเป็นปกติจนกว่าจะนำเข้ารายงานครั้งถัดไป' : 'ตั้งสถานะเป็นปกติจนกว่าจะนำเข้ารายงานครั้งถัดไป'}</div></div>
        <button class="icon-btn close" data-action="close-modal" aria-label="ปิด">${icon('x')}</button></div>
      <div class="modal-body"><label class="fl">เหตุผล <span class="req">*</span><textarea class="inp" id="adminReason" placeholder="${open
        ? 'เช่น DC แจ้งว่าตู้มีปัญหา ต้องให้ตรวจสอบ แม้สถานะในระบบ GPS ยังไม่วิกฤต'
        : 'เช่น ตรวจสอบแล้วเป็นการแจ้งเตือนผิดพลาดจากเซนเซอร์ / รถจอดซ่อม ไม่ได้ใช้งาน'}"></textarea></label>
        <p class="muted small" style="margin:8px 0 0">เหตุผลจะถูกบันทึกพร้อมวันเวลาและทีมในชีต Alerts (คอลัมน์ adminLog)</p></div>
      <div class="modal-foot"><button class="btn btn-sm btn-outline" data-action="close-modal">ยกเลิก</button>
        <button class="btn btn-sm ${open ? 'btn-warn' : 'btn-primary'}" data-action="admin-submit" data-plate="${esc(plate)}" id="adminSubmit">${open ? 'ยืนยันปรับเป็นเคส' : 'ยืนยันรีเซ็ตเป็นปกติ'}</button></div>`);
    card.classList.add('modal-sm');
    $('#adminReason').focus();
  }
  const dayKey = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

  function dailyChart(list) {
    const DAY = 864e5;
    const today = dayKey(Date.now());
    const ps = periodStart();
    const span = Math.min(31, Math.max(7, ps ? Math.round((today - dayKey(ps)) / DAY) + 1 : 14));
    const days = Array.from({ length: span }, (_, i) => today - (span - 1 - i) * DAY);
    const rows = days.map((d) => {
      const l = list.filter((a) => dayKey(a.time) === d);
      const f = l.filter((a) => a.inspection && a.inspection.closure === 'fixed').length;
      const u = l.filter((a) => a.inspection && a.inspection.closure === 'unfixed').length;
      return { d, f, u, p: l.length - f - u, n: l.length };
    });
    const max = Math.max(1, ...rows.map((r) => r.n));
    const W = 720, H = 220, L = 30, R = 8, T = 18, B = 30;
    const bw = (W - L - R) / span;
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const step = Math.max(1, Math.ceil(max / 4));
    const grid = [];
    for (let v = 0; v <= max; v += step) grid.push(v);
    const seg = (x, from, n, color, tip) => (n ? `<rect x="${x.toFixed(1)}" y="${y(from + n).toFixed(1)}" width="${Math.max(2, bw * 0.62).toFixed(1)}" height="${(y(from) - y(from + n)).toFixed(1)}" fill="${color}" rx="2"><title>${tip}</title></rect>` : '');
    const bars = rows.map((r, i) => {
      const x = L + i * bw + bw * 0.19;
      const date = new Date(r.d).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
      const tip = (k, n) => `${date} · ${k} ${n} เคส`;
      return seg(x, 0, r.f, CLOSURE_COLOR.fixed, tip('แก้ไขแล้ว', r.f)) + seg(x, r.f, r.u, CLOSURE_COLOR.unfixed, tip('แก้ไขไม่ได้', r.u)) +
        seg(x, r.f + r.u, r.p, 'var(--danger)', tip('รอดำเนินการ', r.p)) +
        (r.n ? `<text x="${(x + bw * 0.31).toFixed(1)}" y="${(y(r.n) - 4).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text)">${r.n}</text>` : '') +
        (span <= 14 || i % Math.ceil(span / 10) === 0 || i === span - 1 ? `<text x="${(x + bw * 0.31).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--muted)">${date}</text>` : '');
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="จำนวนเคสรายวัน" style="width:100%;height:auto;display:block">
        ${grid.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${v}</text>`).join('')}
        ${bars}</svg>
      <div class="muted small" style="display:flex;gap:16px;flex-wrap:wrap;margin-top:6px">
        <span><i class="lg" style="background:${CLOSURE_COLOR.fixed}"></i>แก้ไขแล้ว</span><span><i class="lg" style="background:${CLOSURE_COLOR.unfixed}"></i>แก้ไขไม่ได้</span>
        <span><i class="lg" style="background:var(--danger)"></i>รอดำเนินการ</span></div>`;
  }

  function caseSummary(list) {
    // เคสที่ผู้ดูแลรีเซ็ตเป็นปกติ ไม่นับในสถิติ แก้ไขแล้ว/แก้ไขไม่ได้ และสาเหตุ (แสดงจำนวนแยกไว้)
    const resets = list.filter((a) => a.status === 'resolved' && a.inspection && a.inspection.closure === 'reset');
    const closed = list.filter((a) => a.status === 'resolved' && a.inspection && a.inspection.closure !== 'reset');
    const pending = list.filter((a) => a.status !== 'resolved');
    const fixed = closed.filter((a) => a.inspection.closure === 'fixed');
    const unfixed = closed.filter((a) => a.inspection.closure === 'unfixed');
    const t0 = dayKey(Date.now());
    const today = list.filter((a) => a.time >= t0);
    const todayClosed = today.filter((a) => a.status === 'resolved').length;
    const kpis = [
      kpi({ label: 'เคสวันนี้', value: today.length, unit: 'เคส', ico: 'calendar', color: 'var(--glow-blue)', sub: `ปิดแล้ว <b>${todayClosed}</b> ค้าง <b>${today.length - todayClosed}</b>`, go: 'alerts:' }),
      kpi({ label: 'รอดำเนินการ', value: pending.length, unit: 'เคส', ico: 'clock', color: 'var(--danger)', blink: pending.some((a) => a.status === 'new'),
        sub: `รอรับทราบ <b>${pending.filter((a) => a.status === 'new').length}</b> กำลังตรวจสอบ <b>${pending.filter((a) => a.status === 'ack').length}</b>`, go: 'alerts:' }),
      kpi({ label: 'แก้ไขแล้ว', value: fixed.length, unit: 'เคส', ico: 'check', color: CLOSURE_COLOR.fixed, sub: `<b>${pct(fixed.length, closed.length)}</b> ของเคสที่ปิด`, go: 'inspections' }),
      kpi({ label: 'แก้ไขไม่ได้', value: unfixed.length, unit: 'เคส', ico: 'alert', color: CLOSURE_COLOR.unfixed, sub: `<b>${pct(unfixed.length, closed.length)}</b> ของเคสที่ปิด`, go: 'inspections' }),
    ].join('');

    // สาเหตุ (รถ / คน / ระบบ)
    const catHtml = Object.keys(CATEGORIES).map((c) => {
      const l = closed.filter((a) => a.inspection.category === c);
      const sub = {};
      l.forEach((a) => { sub[a.inspection.cause] = (sub[a.inspection.cause] || 0) + 1; });
      const top = Object.entries(sub).sort((a, b) => b[1] - a[1]).slice(0, 3);
      return `<div class="cat-row">
        <div class="stat-row-top"><span class="dot" style="background:${CAT_COLOR[c]}"></span><span class="name">${c}</span>
          <span class="num">${l.length}</span><span class="pct" style="color:${CAT_COLOR[c]}">${pct(l.length, closed.length)}</span></div>
        <div class="bar"><i style="width:${closed.length ? (l.length / closed.length) * 100 : 0}%;background:${CAT_COLOR[c]}"></i></div>
        ${top.length ? `<div class="cat-sub">${top.map(([k, n]) => `<span>${esc(k)} <b>${n}</b></span>`).join('')}</div>` : ''}
      </div>`;
    }).join('');

    // การปิดเคส
    const fx = closed.length ? (fixed.length / closed.length) * 100 : 0;
    const donut = closed.length ? `conic-gradient(${CLOSURE_COLOR.fixed} 0 ${fx}%, ${CLOSURE_COLOR.unfixed} ${fx}% 100%)` : 'var(--track)';
    const reasons = {};
    unfixed.forEach((a) => { const k = a.inspection.unfixedReason || '–'; reasons[k] = (reasons[k] || 0) + 1; });
    const reasonRows = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
    const closureHtml = `<div class="closure-wrap">
        <div class="donut small-donut" style="background:${donut}"><div class="donut-center"><b>${pct(fixed.length, closed.length)}</b><span>แก้ไขแล้ว</span></div></div>
        <div class="stat-rows">
          ${['fixed', 'unfixed'].map((k) => { const n = k === 'fixed' ? fixed.length : unfixed.length; return `<div class="stat-row" style="cursor:default">
            <div class="stat-row-top"><span class="dot" style="background:${CLOSURE_COLOR[k]}"></span><span class="name">${CLOSURE[k]}</span><span class="num">${n}</span>
            <span class="pct" style="color:${CLOSURE_COLOR[k]}">${pct(n, closed.length)}</span></div>
            <div class="bar"><i style="width:${closed.length ? (n / closed.length) * 100 : 0}%;background:${CLOSURE_COLOR[k]}"></i></div></div>`; }).join('')}
        </div></div>
      ${reasonRows.length ? `<h4 class="sub-h">สาเหตุที่แก้ไขไม่ได้</h4><div class="dc-bars">${reasonRows.map(([k, n]) => `<div class="dc-bar" style="grid-template-columns:minmax(120px,1.4fr) 1fr 70px;cursor:default">
        <span class="dc-name" title="${esc(k)}">${esc(k)}</span><div class="bar"><i style="width:${(n / unfixed.length) * 100}%;background:${CLOSURE_COLOR.unfixed}"></i></div>
        <span class="n">${n} · ${pct(n, unfixed.length)}</span></div>`).join('')}</div>` : ''}`;

    return `<section class="panel">
        <div class="panel-head"><h2>สรุปผลการตรวจสอบเคส</h2><span class="muted small">เคส ${list.length} · ปิดแล้ว ${closed.length} (${pct(closed.length, list.length)})${resets.length ? ` · รีเซ็ตโดยผู้ดูแล ${resets.length}` : ''} · ตามช่วงเวลาที่เลือก</span></div>
        <div class="kpis">${kpis}</div>
        <div class="case-grid">
          <div class="case-box wide"><h3>จำนวนเคสรายวัน</h3>${dailyChart(list)}</div>
          <div class="case-box"><h3>สาเหตุ <span class="muted small" style="font-weight:400">(% ของเคสที่ปิด)</span></h3><div class="stat-rows">${catHtml}</div></div>
          <div class="case-box"><h3>การปิดเคส</h3>${closureHtml}</div>
        </div>
      </section>`;
  }

  /** Dashboard โหมด Google Sheets: สถานะรถจาก GPS + สรุปผลการตรวจสอบเคส + เคสที่ต้องดำเนินการ */
  function sheetsDashboard() {
    ro.vehicles = state.vehicles;
    ro.loadedAt = ro.loadedAt || Date.now();
    const cases = filtered({ ignoreStatus: true });
    const open = cases.filter((a) => a.status !== 'resolved').sort(sortOpen);
    return roViews.dashboard({
      middle: caseSummary(cases),
      critTable: `<section class="panel"><div class="panel-head"><h2>เคสที่ต้องดำเนินการ</h2>
        <button class="link" data-action="go" data-go="alerts:">ดูทั้งหมด ${open.length} เคส →</button></div>${alertTable(open.slice(0, 8), { compact: true })}</section>`,
    });
  }

  // ---------- Views ----------
  const views = {
    dashboard() {
      if (isSheets()) return sheetsDashboard();
      const list = filtered({ ignoreStatus: true });
      const nNew = list.filter((a) => a.status === 'new');
      const nAck = list.filter((a) => a.status === 'ack');
      const nRes = list.filter((a) => a.status === 'resolved');
      const open = list.filter((a) => a.status !== 'resolved');
      const crit = open.filter((a) => a.severity === 'critical');
      const acked = list.filter((a) => a.ackAt);
      const avgAck = acked.length ? acked.reduce((s, a) => s + (a.ackAt - a.time), 0) / acked.length : 0;
      const vs = scopedVehicles();
      const abnormal = vs.filter((v) => v.online && isAbnormal(v));
      const offline = vs.filter((v) => !v.online);
      const cnt = (arr, k) => arr.filter((a) => a.kind === k).length;

      const kpis = [
        kpi({ label: 'รอรับทราบ', value: nNew.length, unit: 'คัน', ico: 'alert', color: 'var(--danger)', sub: `สูงเกิน <b>${cnt(nNew, 'high')}</b> ต่ำเกิน <b>${cnt(nNew, 'low')}</b>`, go: 'alerts:new' }),
        kpi({ label: 'กำลังตรวจสอบ', value: nAck.length, unit: 'คัน', ico: 'clock', color: 'var(--warn)', sub: 'DC รับทราบแล้ว รอบันทึกผล', go: 'alerts:ack' }),
        kpi({ label: 'ระดับวิกฤต (ค้าง)', value: crit.length, unit: 'คัน', ico: 'flame', color: 'var(--crit)', sub: `เบี่ยงเบน ≥ ${state.settings.criticalDelta}°C จากเกณฑ์`, go: 'alerts:' }),
        kpi({ label: 'ปิดงานแล้ว', value: nRes.length, unit: 'รายการ', ico: 'check', color: 'var(--ok)', sub: `จากทั้งหมด <b>${list.length}</b> รายการในช่วงนี้`, go: 'inspections' }),
        kpi({ label: 'เวลารับทราบเฉลี่ย', value: Math.round(avgAck / MIN), unit: 'นาที', ico: 'bell', color: 'var(--info)', sub: 'นับจากแจ้งเตือนถึง DC กดรับทราบ', go: 'report' }),
        kpi({ label: 'รถที่ติดตาม', value: vs.length, unit: 'คัน', ico: 'truck', color: 'var(--slate)', sub: `ผิดปกติขณะนี้ <b>${abnormal.length}</b> ออฟไลน์ <b>${offline.length}</b>`, go: 'vehicles' }),
      ].join('');

      const total = list.length || 1;
      const parts = [
        { k: 'new', name: 'รอรับทราบ', hint: 'ยังไม่มีผู้รับเรื่อง', n: nNew.length, c: 'var(--danger)' },
        { k: 'ack', name: 'กำลังตรวจสอบ', hint: 'รอบันทึกผล', n: nAck.length, c: 'var(--warn)' },
        { k: 'resolved', name: 'ปิดงานแล้ว', hint: 'บันทึกผลเรียบร้อย', n: nRes.length, c: 'var(--ok)' },
      ];
      let acc = 0;
      const stops = parts.map((p) => { const s = acc; acc += (p.n / total) * 100; return `${p.c} ${s}% ${acc}%`; }).join(',');
      const donutBg = list.length ? `conic-gradient(${stops})` : 'var(--track)';
      const statRows = parts.map((p) => `<div class="stat-row" data-action="go" data-go="alerts:${p.k}">
          <div class="stat-row-top"><span class="dot" style="background:${p.c}"></span><span class="name">${p.name}</span>
          <span class="num">${p.n}</span><span class="pct" style="color:${p.c}">${((p.n / total) * 100).toFixed(1)}%</span></div>
          <div class="bar"><i style="width:${(p.n / total) * 100}%;background:${p.c}"></i></div><div class="hint">${p.hint}</div></div>`).join('');

      const byDc = DCS.filter(inRole).map((dc) => ({ dc, n: open.filter((a) => a.dc === dc).length, t: list.filter((a) => a.dc === dc).length }))
        .sort((a, b) => b.n - a.n || b.t - a.t);
      const maxDc = Math.max(1, ...byDc.map((d) => d.t));
      const dcBars = byDc.map((d) => `<div class="dc-bar" data-action="dc" data-dc="${esc(d.dc)}" title="ค้าง ${d.n} / ทั้งหมด ${d.t}">
          <span class="dc-name">${esc(d.dc)}</span>
          <div class="bar" style="position:relative"><i style="width:${(d.t / maxDc) * 100}%;background:var(--brand-soft);position:absolute;inset:0 auto 0 0"></i><i style="width:${(d.n / maxDc) * 100}%;background:${d.n ? 'var(--danger)' : 'var(--brand)'};position:relative"></i></div>
          <span class="n">${d.n}</span></div>`).join('');

      const urgent = open.slice().sort(sortOpen).slice(0, 8);
      return `
        <section class="panel">
          <div class="panel-head"><h2>ส่วนติดตามอุณหภูมิรถขนส่ง</h2><span class="muted small">อัปเดตล่าสุด ${fmtTime(Date.now())}</span></div>
          <div class="kpis">${kpis}</div>
          <div class="grid-2">
            <div>
              <h3>สถานะการแจ้งเตือน</h3>
              <div class="status-wrap">
                <div class="donut" style="background:${donutBg}"><div class="donut-center"><b>${open.length}</b><span>คันที่ต้องดำเนินการ</span></div></div>
                <div class="stat-rows">${statRows}</div>
              </div>
            </div>
            <div>
              <h3>DC ที่มีรถต้องดำเนินการ <span class="muted small" style="font-weight:400">(แดง = ค้าง · เขียวอ่อน = ทั้งหมด)</span></h3>
              <div class="dc-bars">${dcBars || '<div class="empty">–</div>'}</div>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>แจ้งเตือนที่ต้องดำเนินการ</h2><button class="link" data-action="go" data-go="alerts:">ดูทั้งหมด →</button></div>
          ${alertTable(urgent, { compact: true })}
        </section>`;
    },

    alerts() {
      const list = filtered().sort((a, b) => (a.status === 'resolved') - (b.status === 'resolved') || sortOpen(a, b));
      return `<section class="panel">
        <div class="panel-head"><h2>รายการแจ้งเตือนอุณหภูมิผิดปกติ <span class="muted small" style="font-weight:400">(${list.length} รายการ)</span></h2>
        <span class="muted small">ขั้นตอน: รอรับทราบ → DC กดรับทราบ → ตรวจสอบหน้างาน → บันทึกผล</span></div>
        ${alertTable(list)}</section>`;
    },

    inspections() {
      const all = filtered({ ignoreStatus: true });
      const list = all.filter((a) => a.status === 'resolved' && a.inspection).sort((a, b) => b.inspection.at - a.inspection.at);
      const rows = list.map((a) => {
        const i = a.inspection;
        return `<tr data-action="open" data-id="${a.id}">
          <td><div style="font-weight:600">${fmtDate(i.at)}</div><div class="muted small">${a.id}</div></td>
          <td><div class="plate">${esc(a.plate)}<small>${esc(a.dc)}</small></div></td>
          <td>${catChip(i.category)}</td>
          <td style="max-width:220px">${esc(i.cause || '–')}</td>
          <td style="max-width:240px" class="small">${esc(i.driverCheck || '–')}</td>
          <td>${closureChip(i)}${i.closure === 'unfixed' && i.unfixedReason ? `<div class="muted small">${esc(i.unfixedReason)}</div>` : ''}</td>
          <td class="small">${esc(i.by)}</td>
          <td class="muted">${dur(i.at - a.time)}</td>
        </tr>`;
      }).join('');
      return `${caseSummary(all)}
        <section class="panel">
          <div class="panel-head"><h2>ประวัติการบันทึกผล <span class="muted small" style="font-weight:400">(${list.length} เคส)</span></h2></div>
          ${list.length ? `<div class="table-wrap"><table><thead><tr><th>วันที่บันทึก</th><th>ทะเบียน / DC</th><th>หมวด</th><th>สาเหตุ</th><th>ผลตรวจสอบกับ พขร.</th><th>การปิดเคส</th><th>ผู้บันทึก</th><th>ใช้เวลา</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">ยังไม่มีการบันทึกผลในช่วงเวลานี้</div>'}
        </section>`;
    },

    vehicles() {
      if (isSheets()) { ro.vehicles = state.vehicles; ro.loadedAt = ro.loadedAt || Date.now(); return roViews.vehicles(); }
      const vs = scopedVehicles().sort((a, b) => (isAbnormal(b) && b.online) - (isAbnormal(a) && a.online) || a.online - b.online || a.dc.localeCompare(b.dc));
      const cards = vs.map((v) => {
        if (isGps(v)) return gpsCard(v);
        const t = th(v.type);
        const bad = v.online && isAbnormal(v);
        const open = state.alerts.find((a) => a.vehicleId === v.id && a.status !== 'resolved');
        const lo = t.min - 10, hi = t.max + 10;
        const pos = (x) => Math.min(100, Math.max(0, ((x - lo) / (hi - lo)) * 100));
        const cls = !v.online ? 'muted' : bad ? (v.temp > t.max ? 'hot' : 'cold') : 'ok';
        const chip = !v.online ? '<span class="chip off">ออฟไลน์</span>' : bad ? `<span class="chip ${v.temp > t.max ? 'new' : 'cold'}">ผิดปกติ</span>` : '<span class="chip resolved">ปกติ</span>';
        return `<div class="v-card ${bad ? 'bad' : ''}" ${open ? `data-action="open" data-id="${open.id}"` : ''}>
          <div class="row"><span class="plate">${esc(v.plate)}</span>${chip}</div>
          <div class="v-meta">${esc(v.dc)} · ${TYPE_SHORT[v.type]} · ${v.owner}</div>
          <div class="v-temp temp ${cls}">${v.online ? fmtT(v.temp) : '–'}</div>
          <div class="range-bar"><div class="ok-zone" style="left:${pos(t.min)}%;width:${pos(t.max) - pos(t.min)}%"></div>${v.online ? `<div class="needle" style="left:${pos(v.temp)}%"></div>` : ''}</div>
          <div class="row v-meta"><span>เกณฑ์ ${t.min}…${t.max}°C</span><span>${v.online ? ago(v.updated) : 'ขาดการเชื่อมต่อ'}</span></div>
          ${open ? `<div class="v-meta" style="margin-top:6px;color:var(--danger)">● ${open.id} · ${STATUS_LABEL[open.status]}</div>` : ''}
        </div>`;
      }).join('');
      return `<section class="panel"><div class="panel-head"><h2>อุณหภูมิตู้สินค้าแบบเรียลไทม์ <span class="muted small" style="font-weight:400">(${vs.length} คัน)</span></h2>
        <span class="muted small">${isSheets() ? 'ข้อมูลจาก Google Sheets · อัปเดตทุก 20 วินาที' : state.settings.sim ? `โหมดจำลอง: อัปเดตทุก ${state.settings.simEvery} วินาที` : 'ปิดการจำลองข้อมูล'}</span></div>
        <div class="v-grid">${cards || '<div class="empty">ไม่พบรถ</div>'}</div></section>`;
    },

    report() {
      const list = filtered({ ignoreStatus: true });
      const rows = DCS.filter(inRole).filter((dc) => !ui.dc || dc === ui.dc).map((dc) => {
        const l = list.filter((a) => a.dc === dc);
        const acked = l.filter((a) => a.ackAt);
        const res = l.filter((a) => a.status === 'resolved');
        const avgAck = acked.length ? acked.reduce((s, a) => s + (a.ackAt - a.time), 0) / acked.length : null;
        const avgFix = res.length ? res.reduce((s, a) => s + (a.inspection.at - a.time), 0) / res.length : null;
        const cc = {};
        res.forEach((a) => { cc[a.inspection.cause] = (cc[a.inspection.cause] || 0) + 1; });
        const top = Object.entries(cc).sort((a, b) => b[1] - a[1])[0];
        const slaOk = acked.filter((a) => a.ackAt - a.time <= 15 * MIN).length;
        return { dc, total: l.length, open: l.length - res.length, crit: l.filter((a) => a.severity === 'critical').length, avgAck, avgFix, top: top ? top[0] : '–', sla: acked.length ? (slaOk / acked.length) * 100 : null };
      });
      const slaColor = (p) => (p == null ? 'var(--muted)' : p >= 80 ? 'var(--ok)' : p >= 50 ? 'var(--warn)' : 'var(--danger)');
      return `<section class="panel">
        <div class="panel-head"><h2>KPI การตอบสนองต่อการแจ้งเตือน แยกตาม DC</h2><span class="muted small">SLA: รับทราบภายใน 15 นาที</span></div>
        <div class="table-wrap"><table><thead><tr><th>DC</th><th>แจ้งเตือน</th><th>ค้าง</th><th>วิกฤต</th><th>รับทราบเฉลี่ย</th><th>ผ่าน SLA</th><th>แก้ไขเฉลี่ย</th><th>สาเหตุหลัก</th></tr></thead>
        <tbody>${rows.map((r) => `<tr data-action="dc" data-dc="${esc(r.dc)}">
          <td style="font-weight:700">${esc(r.dc)}</td><td>${r.total}</td>
          <td>${r.open ? `<span class="chip new">${r.open}</span>` : '0'}</td><td>${r.crit}</td>
          <td>${r.avgAck == null ? '–' : dur(r.avgAck)}</td>
          <td><b style="color:${slaColor(r.sla)}">${r.sla == null ? '–' : r.sla.toFixed(0) + '%'}</b></td>
          <td>${r.avgFix == null ? '–' : dur(r.avgFix)}</td>
          <td class="small" style="max-width:260px">${esc(r.top)}</td></tr>`).join('')}</tbody></table></div>
      </section>`;
    },

    import() {
      if (!isSheets()) {
        return `<section class="panel"><div class="panel-head"><h2>นำเข้ารายงาน Temperature Dashboard</h2></div>
          <p class="muted" style="margin:0">ต้องเชื่อมต่อ Google Sheets ก่อน จึงจะนำเข้ารายงานและเก็บข้อมูลรายวันได้ — <a class="link" href="#/settings">ไปหน้าตั้งค่าการเชื่อมต่อ →</a></p></section>`;
      }
      const imps = state.imports || [];
      return `<section class="panel">
        <div class="panel-head"><h2>นำเข้ารายงาน Temperature Dashboard</h2><span class="muted small">ไฟล์ละ 1 ครั้ง (ระบบกันนำเข้าซ้ำจากชื่อไฟล์)</span></div>
        <div class="import-grid">
          <label class="drop" id="dropZone">${icon('upload')}<b>เลือกไฟล์ .xlsx ที่ export จากระบบ GPS</b>
            <span class="muted small">หรือลากไฟล์มาวางที่นี่ · ต้องมีชีต "รายคัน" และ "ประวัติเกินเกณฑ์"</span>
            <input type="file" id="importFile" accept=".xlsx,.xls" hidden></label>
          <div><label class="fl">หรือวางลิงก์ Google Sheet ของรายงานที่อัปโหลดไว้แล้ว<input class="inp" id="importLink" placeholder="https://docs.google.com/spreadsheets/d/..."></label>
            <button class="btn btn-sm btn-primary" data-action="import-link" style="margin-top:10px">นำเข้าจากลิงก์</button>
            <p class="muted small" style="margin:8px 0 0">บัญชี Google ที่ Deploy Apps Script ต้องเปิดไฟล์นั้นได้</p></div>
        </div>
        <div id="importStatus">${ui.importMsg || ''}</div>
        <p class="muted small" style="margin:14px 0 0">กติกา: ชีต <b>รายคัน</b> แถวที่ <b>สถานะ = วิกฤต</b> → สร้างแจ้งเตือนให้ DC (ถ้ารถคันนั้นยังมีงานค้าง จะอัปเดตค่าในงานเดิมแทน) ·
          DC และใบรายการ ใช้รายการล่าสุดของทะเบียนนั้นในชีต <b>ประวัติเกินเกณฑ์</b> · ทุกแถวของชีต รายคัน ถูกนำไปต่อท้ายในชีต <b>ข้อมูลรายวัน</b> พร้อมวันที่ของข้อมูล (อัปโหลดวันใหม่ก็ต่อกันไปเรื่อย ๆ)</p>
      </section>
      <section class="panel"><div class="panel-head"><h2>ประวัติการนำเข้า</h2></div>
        ${imps.length ? `<div class="table-wrap"><table style="min-width:860px"><thead><tr><th>นำเข้าเมื่อ</th><th>ไฟล์รายงาน</th><th>รถ</th><th>วิกฤต</th><th>แจ้งเตือนใหม่</th><th>อัปเดตงานค้าง</th><th>ประวัติใหม่</th><th>โดย</th><th></th></tr></thead><tbody>
          ${imps.map((i) => `<tr style="cursor:default" class="${i.undoneAt ? 'undone' : ''}"><td>${fmtDate(i.at)}</td><td class="small">${esc(i.reportFile)}</td><td>${i.vehicles ?? '–'}</td><td><span class="chip crit">${i.critical ?? 0}</span></td><td><b>${i.newAlerts ?? 0}</b></td><td>${i.updatedAlerts ?? 0}</td><td>${i.newEvents ?? 0}</td><td class="small">${esc(i.by || i.source)}</td>
            <td>${i.undoneAt ? `<span class="chip off" title="${esc(`${fmtDate(i.undoneAt)} · ${i.undoneBy}: ${i.undoReason}`)}">ยกเลิกแล้ว</span>`
              : isAdmin() ? `<button class="btn btn-xs btn-outline undo-btn" data-action="undo-import" data-file="${esc(i.reportFile)}" title="Admin: ยกเลิกการนำเข้านี้">${icon('x')} ยกเลิก</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">ยังไม่มีการนำเข้า</div>'}
      </section>`;
    },

    settings() {
      const s = state.settings;
      const types = isSheets() ? Object.keys(s.thresholds) : Object.keys(TYPE_LABEL);
      const rows = types.filter((k) => s.thresholds[k]).map((k) => `<tr><td style="font-weight:600">${typeLabel(k)}</td>
        <td><input class="inp" type="number" step="0.5" data-th="${k}.min" value="${s.thresholds[k].min}"></td>
        <td><input class="inp" type="number" step="0.5" data-th="${k}.max" value="${s.thresholds[k].max}"></td>
        <td class="muted small">${isSheets() ? '' : `${state.vehicles.filter((v) => v.type === k).length} คัน`}</td></tr>`).join('');
      const perm = 'Notification' in window ? Notification.permission : 'unsupported';
      const canEdit = !isSheets() || (ui.me && ui.me.role === 'admin');
      return `
        <section class="panel" ${canEdit ? '' : 'hidden'}><div class="panel-head"><h2>เกณฑ์อุณหภูมิตามประเภทรถ</h2></div>
          <div class="table-wrap"><table class="th-table" style="min-width:520px"><thead><tr><th>ประเภท</th><th>ต่ำสุด (°C)</th><th>สูงสุด (°C)</th><th>จำนวนรถ</th></tr></thead><tbody>${rows}</tbody></table></div>
          <div class="form-grid" style="margin-top:18px;max-width:640px">
            <label class="fl">ระดับวิกฤตเมื่อเบี่ยงเบนจากเกณฑ์ ≥ (°C)<input class="inp" type="number" step="0.5" min="0.5" id="sCrit" value="${s.criticalDelta}"></label>
            <label class="fl">ชื่อผู้ใช้งาน (ใช้เป็นผู้รับทราบ/ผู้ตรวจ)<input class="inp" id="sUser" value="${esc(s.user)}"></label>
          </div>
          <div style="margin-top:18px"><button class="btn btn-primary btn-sm" data-action="save-settings">บันทึกการตั้งค่า</button></div>
        </section>
        <section class="panel"><div class="panel-head"><h2>เชื่อมต่อ Google Sheets</h2>
            ${isSheets() ? `<span class="chip ${state.loaded ? 'resolved' : 'new'}">${state.loaded ? 'เชื่อมต่อแล้ว' : 'ยังโหลดข้อมูลไม่ได้'}</span>` : '<span class="chip off">โหมดสาธิต (ข้อมูลในเครื่อง)</span>'}</div>
          <div class="form-grid" style="max-width:860px">
            <label class="fl full">Apps Script Web app URL<input class="inp" id="apiUrl" placeholder="https://script.google.com/macros/s/xxxxxxxx/exec" value="${esc(api.url || '')}"></label>
            <label class="fl">API token<input class="inp" id="apiToken" type="password" autocomplete="off" placeholder="จากเมนู Temp Watch › แสดง API token" value="${esc(api.token || '')}"></label>
            <div class="fl" style="display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap">
              <button class="btn btn-sm btn-primary" data-action="api-connect">${isSheets() ? 'บันทึก / ทดสอบใหม่' : 'ทดสอบและเชื่อมต่อ'}</button>
              ${isSheets() ? '<button class="btn btn-sm btn-outline" data-action="api-refresh">โหลดข้อมูลใหม่</button><button class="btn btn-sm btn-outline" data-action="api-disconnect">ยกเลิกการเชื่อมต่อ</button>' : ''}
            </div>
          </div>
          <p class="muted small" style="margin:14px 0 0">เมื่อเชื่อมต่อแล้ว ทุก DC ที่เปิดเว็บนี้จะเห็นข้อมูลชุดเดียวกันจาก Google Sheets · หน้าเว็บดึงข้อมูลใหม่ทุก 20 วินาที · การรับทราบ/บันทึกผล/ตั้งเกณฑ์ จะเขียนลงชีตทันที · รูปภาพเก็บใน Google Drive โฟลเดอร์ "TempWatch Photos" · วิธีติดตั้งดูไฟล์ <code>GOOGLE-SHEETS-SETUP.md</code></p>
        </section>
        <section class="panel"><div class="panel-head"><h2>การแจ้งเตือน & ข้อมูล</h2></div>
          <div style="display:flex;flex-direction:column;gap:14px">
            <label class="switch"><input type="checkbox" id="sSound" ${s.sound ? 'checked' : ''}> เสียงเตือนเมื่อมีแจ้งเตือนใหม่</label>
            <label class="switch"><input type="checkbox" id="sDesktop" ${s.desktop ? 'checked' : ''}> แจ้งเตือนบนเดสก์ท็อป (Browser Notification) <span class="muted small">สถานะสิทธิ์: ${perm}</span></label>
            ${isSheets() ? '<p class="muted small" style="margin:0">อีเมลแจ้ง DC ตั้งค่าได้ที่ชีต <b>DCs</b> (คอลัมน์ email) และเปิด/ปิดที่ชีต <b>Config</b> › EMAIL_ALERTS</p>' : `
            <label class="switch"><input type="checkbox" id="sSim" ${s.sim ? 'checked' : ''}> จำลองข้อมูลเซนเซอร์แบบเรียลไทม์ (สำหรับสาธิต)</label>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button class="btn btn-sm btn-outline" data-action="sim-now">${icon('thermo')} สร้างแจ้งเตือนทดสอบ 1 รายการ</button>
              <button class="btn btn-sm btn-danger" data-action="reset">รีเซ็ตข้อมูลตัวอย่าง</button>
            </div>
            <p class="muted small" style="margin:0">โหมดสาธิต: ข้อมูลเก็บในเบราว์เซอร์เครื่องนี้เท่านั้น — เชื่อมต่อ Google Sheets ด้านบนเพื่อใช้งานจริงร่วมกันหลาย DC</p>`}
          </div>
        </section>`;
    },
  };

  // ---------- Views: ข้อมูลจาก Google Sheet รายงาน (อ่านอย่างเดียว) ----------
  const RO_META = {
    dashboard: ['ภาพรวมอุณหภูมิรถขนส่ง', 'TEMPERATURE DASHBOARD / ข้อมูลจาก Google Sheet'],
    alerts: ['รถสถานะวิกฤต', 'CRITICAL / ชีต รายคัน · สถานะ = วิกฤต'],
    vehicles: ['สถานะรถ / อุณหภูมิล่าสุด', 'FLEET / ชีต รายคัน'],
    report: ['สรุปเกินเกณฑ์ตาม DC', 'REPORT / ชีต ประวัติเกินเกณฑ์'],
    settings: ['ตั้งค่าแหล่งข้อมูล', 'SETTINGS / GOOGLE SHEET'],
  };
  const RO_HIDDEN_ROUTES = ['inspections', 'import'];
  const scopedRO = () => ro.vehicles.filter((v) => inRole(v.dc) && (!ui.dc || v.dc === ui.dc) && matchQ(v));
  const byOver = (a, b) => (b.overCont ?? -1) - (a.overCont ?? -1) || a.plate.localeCompare(b.plate);
  const srcNote = () => `<span class="muted small">ข้อมูล ณ ${fmtDate(ro.loadedAt)} · <button class="link small" data-action="src-reload">โหลดใหม่</button></span>`;

  function roTable(list) {
    if (!list.length) return '<div class="empty">ไม่มีรถตามเงื่อนไขที่เลือก</div>';
    const has = (k) => list.some((v) => v[k] != null && v[k] !== '');
    const cols = [
      ['ทะเบียนรถ', (v) => `<div class="plate">${esc(v.plate)}<small>${esc([v.group, v.vtype].filter(Boolean).join(' · '))}</small></div>`],
      ['DC / ใบรายการล่าสุด', (v) => (v.dc === NO_DC ? '<span class="muted">–</span>' : `${esc(v.dc)}${v.waybill ? `<div class="muted small">${esc(v.waybill)}</div>` : ''}`)],
      has('tempF') && ['Frozen', (v) => `<span class="temp">${v.tempF == null ? '–' : fmtT(v.tempF)}</span>`],
      has('tempC') && ['Chilled', (v) => `<span class="temp">${v.tempC == null ? '–' : fmtT(v.tempC)}</span>`],
      ['สถานะ GPS', (v) => gpsChip(v.gpsStatus)],
      has('overCont') && ['เกินเกณฑ์ต่อเนื่อง', (v) => (v.overCont == null ? '–' : dur(v.overCont * MIN))],
      has('updated') && ['อัพเดทล่าสุด', (v) => (v.updated ? `${fmtDate(v.updated)}<div class="muted small">${ago(v.updated)}</div>` : '–')],
    ].filter(Boolean);
    return `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th>${c[0]}</th>`).join('')}<th></th></tr></thead><tbody>
      ${list.map((v) => `<tr data-action="ro-open" data-plate="${esc(v.plate)}">${cols.map((c) => `<td>${c[1](v)}</td>`).join('')}
        <td><div class="actions"><button class="btn btn-xs btn-outline" data-action="ro-open" data-plate="${esc(v.plate)}">ดูประวัติ</button></div></td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function roState() {
    if (ro.loadedAt) return null;
    if (ro.error) {
      return `<section class="panel"><h2 style="margin:0 0 8px">โหลดข้อมูลจาก Google Sheet ไม่สำเร็จ</h2><p class="muted" style="margin:0 0 14px">${esc(ro.error)}</p>
        <button class="btn btn-sm btn-primary" data-action="src-reload">ลองใหม่</button> <a class="btn btn-sm btn-outline" href="#/settings">ตั้งค่าแหล่งข้อมูล</a></section>`;
    }
    return '<section class="panel"><div class="empty">กำลังโหลดข้อมูลจาก Google Sheet...</div></section>';
  }

  const roViews = {
    /** opts.middle = HTML แทรกหลังส่วนสถานะ GPS, opts.critTable = HTML แทนตารางรถวิกฤต (ใช้ในโหมด Google Sheets) */
    dashboard(opts = {}) {
      const vs = scopedRO();
      // วิกฤต = รถสถานะวิกฤตในไฟล์ล่าสุด + รถที่ยังมีเคสค้าง (ยังไม่บันทึกผล) — นับทะเบียนไม่ซ้ำ
      const critMap = new Map();
      vs.filter((v) => v.gpsStatus === 'วิกฤต').forEach((v) => critMap.set(v.plate, { plate: v.plate, group: v.group, dc: v.dc, src: 'file' }));
      const fromFile = critMap.size;
      if (isSheets()) {
        const byPlate = new Map(vs.map((v) => [v.plate, v]));
        state.alerts.filter((a) => a.status !== 'resolved' && inRole(a.dc) && (!ui.dc || a.dc === ui.dc) && matchQ(a)).forEach((a) => {
          if (critMap.has(a.plate)) return;
          const v = byPlate.get(a.plate);
          critMap.set(a.plate, { plate: a.plate, group: (v && v.group) || a.group, dc: (v && v.dc) || a.dc || NO_DC, src: 'case' });
        });
      }
      const critAll = [...critMap.values()];
      const cnt = (s) => (s === 'วิกฤต' ? critAll.length : vs.filter((v) => v.gpsStatus === s).length);
      const groups = [...new Set(vs.map((v) => v.group).concat(critAll.map((c) => c.group)).filter(Boolean))];
      const bySub = (s) => groups.map((g) => [g, (s === 'วิกฤต' ? critAll : vs.filter((v) => v.gpsStatus === s)).filter((v) => v.group === g).length])
        .filter((x) => x[1]).map(([g, n]) => `${esc(g)} <b>${n}</b>`).join(' ') +
        (s === 'วิกฤต' && critAll.length > fromFile ? `<br>ไฟล์ล่าสุด <b>${fromFile}</b> + เคสค้าง <b>${critAll.length - fromFile}</b>` : '');
      const meta = {
        'วิกฤต': ['flame', 'alerts:'], 'แจ้งเตือน': ['alert', 'vehicles:แจ้งเตือน'], 'ปกติ': ['check', 'vehicles:ปกติ'],
        'Standby': ['clock', 'vehicles:Standby'], 'ออฟไลน์': ['wifiOff', 'vehicles:ออฟไลน์'], 'ปิดใช้งาน': ['x', 'vehicles:ปิดใช้งาน'],
      };
      const kpis = GPS_STATUSES.map((s) => kpi({ label: s, value: cnt(s), unit: 'คัน', ico: meta[s][0], color: GPS_COLOR[s], sub: bySub(s) || '&nbsp;', go: meta[s][1],
        blink: s === 'วิกฤต' && cnt(s) > 0, ring: s === 'วิกฤต' ? 'var(--glow-red)' : undefined }))
        .concat(kpi({ label: 'รถทั้งหมด', value: vs.length, unit: 'คัน', ico: 'truck', color: 'var(--brand)', ring: 'var(--glow-blue)', sub: groups.length ? groups.map((g) => `${esc(g)} <b>${vs.filter((v) => v.group === g).length}</b>`).join(' ') : '', go: 'vehicles:' })).join('');

      // สัดส่วนสถานะ: ใช้สถานะจากไฟล์ล่าสุดเท่านั้น (รวมกันได้ = จำนวนรถทั้งหมด)
      const total = vs.length || 1;
      let acc = 0;
      const parts = GPS_STATUSES.map((s) => ({ s, n: vs.filter((v) => v.gpsStatus === s).length })).filter((p) => p.n);
      const stops = parts.map((p) => { const a = acc; acc += (p.n / total) * 100; return `${GPS_COLOR[p.s]} ${a}% ${acc}%`; }).join(',');
      const statRows = parts.map((p) => `<div class="stat-row" data-action="go" data-go="${p.s === 'วิกฤต' ? 'alerts:' : 'vehicles:' + p.s}">
          <div class="stat-row-top"><span class="dot" style="background:${GPS_COLOR[p.s]}"></span><span class="name">${p.s}</span>
          <span class="num">${p.n}</span><span class="pct" style="color:${GPS_COLOR[p.s]}">${((p.n / total) * 100).toFixed(1)}%</span></div>
          <div class="bar"><i style="width:${(p.n / total) * 100}%;background:${GPS_COLOR[p.s]}"></i></div></div>`).join('');

      const crit = vs.filter((v) => v.gpsStatus === 'วิกฤต');
      const byDc = {};
      critAll.forEach((v) => { byDc[v.dc] = (byDc[v.dc] || 0) + 1; });
      const dcList = Object.entries(byDc).filter((d) => d[0] !== NO_DC).sort((a, b) => b[1] - a[1]).slice(0, 11)
        .concat(byDc[NO_DC] ? [[NO_DC, byDc[NO_DC]]] : []);
      const maxDc = Math.max(1, ...dcList.map((d) => d[1]));
      const dcBars = dcList.map(([dc, n]) => `<div class="dc-bar" data-action="dc" data-dc="${esc(dc)}"><span class="dc-name">${esc(dc)}</span>
          <div class="bar"><i style="width:${(n / maxDc) * 100}%;background:${dc === NO_DC ? 'var(--slate)' : 'var(--crit)'}"></i></div><span class="n">${n}</span></div>`).join('');

      const plates = new Set(vs.map((v) => v.plate));
      const topList = Object.entries(ro.top).filter(([p, t]) => plates.has(p) && t.minutes != null).sort((a, b) => b[1].minutes - a[1].minutes).slice(0, 10);
      const maxTop = Math.max(1, ...topList.map((t) => t[1].minutes));
      const topHtml = topList.length ? `<section class="panel"><div class="panel-head"><h2>Top 10 รวมเวลาเกินเกณฑ์</h2><span class="muted small">ชีต สรุปเกินเกณฑ์ตามคัน</span></div>
        <div class="dc-bars">${topList.map(([p, t]) => `<div class="dc-bar" data-action="ro-open" data-plate="${esc(p)}" style="grid-template-columns:120px 1fr 150px">
          <span class="dc-name" style="font-weight:600">${esc(p)}</span><div class="bar"><i style="width:${(t.minutes / maxTop) * 100}%;background:var(--crit)"></i></div>
          <span class="n" style="font-weight:500">${dur(t.minutes * MIN)}${t.count != null ? ` · ${t.count} ครั้ง` : ''}</span></div>`).join('')}</div></section>` : '';

      return `
        <section class="panel">
          <div class="panel-head"><h2>สถานะรถจากระบบ GPS</h2>${srcNote()}</div>
          <div class="kpis">${kpis}</div>
          <div class="grid-2">
            <div><h3>สัดส่วนสถานะรวม</h3>
              <div class="status-wrap">
                <div class="donut" style="background:${vs.length ? `conic-gradient(${stops})` : 'var(--track)'}"><div class="donut-center"><b>${critAll.length}</b><span>คันสถานะวิกฤต</span></div></div>
                <div class="stat-rows">${statRows}</div>
              </div></div>
            <div><h3>DC ที่มีรถสถานะวิกฤต</h3>
              <div class="dc-bars">${dcBars || '<div class="empty">ไม่มีรถสถานะวิกฤต</div>'}</div>
              ${byDc[NO_DC] ? `<p class="muted small" style="margin:12px 0 0">"${NO_DC}" = ไม่พบใบรายการของทะเบียนนี้ในชีต ประวัติเกินเกณฑ์</p>` : ''}</div>
          </div>
        </section>
        ${opts.middle || ''}
        ${opts.critTable !== undefined ? opts.critTable : `<section class="panel">
          <div class="panel-head"><h2>รถสถานะวิกฤต — เกินเกณฑ์ต่อเนื่องนานสุด</h2><button class="link" data-action="go" data-go="alerts:">ดูทั้งหมด ${crit.length} คัน →</button></div>
          ${roTable(crit.slice().sort(byOver).slice(0, 8))}
        </section>`}
        ${topHtml}`;
    },

    alerts() {
      const list = scopedRO().filter((v) => v.gpsStatus === 'วิกฤต').sort(byOver);
      return `<div class="ro-note">${icon('alert')}<div><b>โหมดดูข้อมูลอย่างเดียว</b> — ยังไม่ได้เข้าสู่ระบบ จึงรับทราบ/บันทึกผลไม่ได้</div>
          <button class="btn btn-sm btn-primary" data-action="api-default">เข้าสู่ระบบเพื่อบันทึกผล</button></div>
        <section class="panel"><div class="panel-head"><h2>รถสถานะวิกฤต <span class="muted small" style="font-weight:400">(${list.length} คัน)</span></h2>${srcNote()}</div>
        ${roTable(list)}</section>`;
    },

    vehicles() {
      const order = (s) => { const i = GPS_STATUSES.indexOf(s); return i < 0 ? 99 : i; };
      const vs = scopedRO().filter((v) => !ui.status || v.gpsStatus === ui.status)
        .sort((a, b) => order(a.gpsStatus) - order(b.gpsStatus) || byOver(a, b));
      return `<section class="panel"><div class="panel-head"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <h2>${ui.status ? `สถานะ ${esc(ui.status)}` : 'รถทั้งหมด'} <span class="muted small" style="font-weight:400">(${vs.length} คัน)</span></h2>
          ${isAdmin() ? `<button class="btn btn-sm btn-outline reset-btn" data-action="reset-open" title="Admin: รีเซ็ตเป็นปกติ">${icon('check')} รีเซ็ต</button>` : ''}</div>${srcNote()}</div>
        <div class="v-grid">${vs.map(gpsCard).join('') || '<div class="empty">ไม่พบรถ</div>'}</div></section>`;
    },

    report() {
      const ps = periodStart();
      const ev = ro.events.filter((e) => e.start >= ps && inRole(e.dc || NO_DC) && (!ui.dc || (e.dc || NO_DC) === ui.dc) && matchQ(e));
      if (!ro.events.length) return '<section class="panel"><div class="empty">ไม่พบชีต "ประวัติเกินเกณฑ์" ในไฟล์</div></section>';
      const g = {};
      ev.forEach((e) => {
        const k = e.dc || NO_DC;
        const r = g[k] || (g[k] = { dc: k, n: 0, plates: new Set(), mins: 0, max: 0 });
        r.n++; r.plates.add(e.plate); r.mins += e.minutes || 0; r.max = Math.max(r.max, e.minutes || 0);
      });
      const critBy = {};
      scopedRO().filter((v) => v.gpsStatus === 'วิกฤต').forEach((v) => { critBy[v.dc] = (critBy[v.dc] || 0) + 1; });
      const rows = Object.values(g).sort((a, b) => (a.dc === NO_DC) - (b.dc === NO_DC) || b.n - a.n);
      const maxN = Math.max(1, ...rows.map((r) => r.n));
      return `<section class="panel"><div class="panel-head"><h2>เหตุการณ์เกินเกณฑ์แยกตาม DC <span class="muted small" style="font-weight:400">(${ev.length.toLocaleString()} ครั้ง)</span></h2>${srcNote()}</div>
        <div class="table-wrap"><table><thead><tr><th>DC</th><th style="width:28%">จำนวนครั้ง</th><th>จำนวนรถ</th><th>รวมเวลาเกิน</th><th>เฉลี่ยต่อครั้ง</th><th>นานสุด</th><th>วิกฤตขณะนี้</th></tr></thead><tbody>
        ${rows.map((r) => `<tr data-action="dc" data-dc="${esc(r.dc)}"><td style="font-weight:700">${esc(r.dc)}</td>
          <td><div style="display:flex;align-items:center;gap:10px"><div class="bar" style="flex:1;margin:0"><i style="width:${(r.n / maxN) * 100}%;background:var(--brand)"></i></div><b>${r.n}</b></div></td>
          <td>${r.plates.size}</td><td>${dur(r.mins * MIN)}</td><td>${dur((r.mins / r.n) * MIN)}</td><td>${dur(r.max * MIN)}</td>
          <td>${critBy[r.dc] ? `<span class="chip crit">${critBy[r.dc]}</span>` : '0'}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">ไม่มีเหตุการณ์ในช่วงเวลาที่เลือก</td></tr>'}
        </tbody></table></div>
        <p class="muted small" style="margin:12px 0 0">นับจากชีต ประวัติเกินเกณฑ์ ตามช่วงเวลาที่เลือกด้านบน (อิงเวลาเริ่มเกินเกณฑ์) · DC มาจากใบรายการของแต่ละเหตุการณ์</p></section>`;
    },

    settings() {
      return srcPanel() + `
        <section class="panel"><div class="panel-head"><h2>การแจ้งเตือนในหน้าเว็บ</h2></div>
          <div style="display:flex;flex-direction:column;gap:14px">
            <label class="switch"><input type="checkbox" id="sSound" ${state.settings.sound ? 'checked' : ''}> เสียงเตือนเมื่อมีรถสถานะวิกฤตใหม่ (ตรวจทุก 5 นาที)</label>
          </div></section>`;
    },
  };

  function srcPanel() {
    return `<section class="panel"><div class="panel-head"><h2>แหล่งข้อมูล: Google Sheet รายงาน Temperature Dashboard</h2>
        ${isRO() ? `<span class="chip ${ro.loadedAt ? 'resolved' : 'new'}">${ro.loadedAt ? 'เชื่อมต่อแล้ว' : 'ยังโหลดไม่ได้'}</span>` : '<span class="chip off">ไม่ได้ใช้</span>'}</div>
      <div class="form-grid" style="max-width:860px">
        <label class="fl full">ลิงก์ Google Sheet<input class="inp" id="srcUrl" placeholder="https://docs.google.com/spreadsheets/d/.../edit" value="${src.id ? esc(srcLink(src.id)) : ''}"></label>
        <div class="fl full" style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-sm btn-primary" data-action="src-save">บันทึกและโหลดข้อมูล</button>
          ${src.id ? `<a class="btn btn-sm btn-outline" href="${esc(srcLink(src.id))}" target="_blank" rel="noopener">เปิดไฟล์</a><button class="btn btn-sm btn-outline" data-action="src-clear">เลิกใช้ (กลับโหมดสาธิต)</button>` : ''}
        </div>
      </div>
      ${isRO() && ro.loadedAt ? `<p class="small" style="margin:14px 0 0">โหลดล่าสุด ${fmtDate(ro.loadedAt)} · รถ <b>${ro.vehicles.length}</b> คัน · ประวัติเกินเกณฑ์ <b>${ro.events.length.toLocaleString()}</b> รายการ</p>` : ''}
      <p class="muted small" style="margin:10px 0 0">อ่านชีต <b>รายคัน</b>, <b>ประวัติเกินเกณฑ์</b>, <b>สรุปเกินเกณฑ์ตามคัน</b> โดยตรง (ไฟล์ต้องแชร์แบบ "ทุกคนที่มีลิงก์ดูได้") ·
        โหมดนี้อ่านอย่างเดียว — การรับทราบและบันทึกผลการตรวจสอบจะเปิดใช้เมื่อติดตั้ง Apps Script ตามไฟล์ <code>GOOGLE-SHEETS-SETUP.md</code></p></section>`;
  }

  function openRoVehicle(plate) {
    const v = ro.vehicles.find((x) => x.plate === plate);
    if (!v) return;
    ui.modalId = 'ro:' + plate;
    $('#bellPanel').classList.remove('open');
    const ev = ro.events.filter((e) => e.plate === plate).sort((a, b) => b.start - a.start);
    const t = ro.top[plate];
    const info = [
      ['สถานะ GPS', gpsChip(v.gpsStatus)],
      v.tempF != null && ['Frozen', `<span class="temp">${fmtT(v.tempF)}</span>`],
      v.tempC != null && ['Chilled', `<span class="temp">${fmtT(v.tempC)}</span>`],
      v.overCont != null && ['เกินเกณฑ์ต่อเนื่อง', dur(v.overCont * MIN)],
      v.dc !== NO_DC && ['DC (ใบรายการล่าสุด)', esc(v.dc)],
      v.waybill && ['ใบรายการล่าสุด', esc(v.waybill)],
      v.group && ['กลุ่ม', esc(v.group)],
      v.vtype && ['ประเภทรถ', esc(v.vtype)],
      v.owner && ['ชนิดรถ', esc(v.owner)],
      v.driver && ['พขร.', esc(v.driver)],
      v.phone && ['เบอร์ พขร.', esc(v.phone)],
      v.parkOut != null && ['จอดนอกจุด/ต่อเนื่อง', dur(v.parkOut * MIN)],
      v.updated && ['อัพเดทล่าสุด', fmtDate(v.updated)],
      t && t.count != null && ['เกินเกณฑ์สะสม', `${t.count} ครั้ง · ${dur((t.minutes || 0) * MIN)}`],
      v.gpsId && ['GPS ID', `<span class="small">${esc(v.gpsId)}</span>`],
    ].filter(Boolean).map(([k, val]) => `<div class="info"><div class="k">${k}</div><div class="v">${val}</div></div>`).join('');
    openModal(`
      <div class="modal-head">
        <div class="kpi-ico" style="background:${GPS_COLOR[v.gpsStatus] || 'var(--slate)'};width:44px;height:44px">${icon('truck')}</div>
        <div><h2>${esc(v.plate)}</h2><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">${gpsChip(v.gpsStatus)}${v.dc !== NO_DC ? `<span class="chip off">${esc(v.dc)}</span>` : ''}</div></div>
        <button class="icon-btn close" data-action="close-modal" aria-label="ปิด">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="info-grid">${info}</div>
        ${ev.length ? historyEvents(ev).replace('ประวัติเกินเกณฑ์ล่าสุด (จากระบบ GPS)', `ประวัติเกินเกณฑ์ (${ev.length} ครั้ง — แสดง 10 ล่าสุด)`) : ''}
      </div>
      <div class="modal-foot"><button class="btn btn-sm btn-outline" data-action="close-modal">ปิด</button></div>`);
  }

  // รูปภาพ: โหมดสาธิตเก็บเป็น data URL, โหมด Sheets เก็บเป็น Google Drive file id
  const isDriveId = (p) => !/^(data:|https?:)/.test(p);
  const photoSrc = (p) => (isDriveId(p) ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(p)}&sz=w800` : p);
  const photoHref = (p) => (isDriveId(p) ? `https://drive.google.com/file/d/${encodeURIComponent(p)}/view` : p);

  // รถจากรายงาน GPS ใช้สถานะของระบบ GPS ("วิกฤต") — รถโหมดสาธิตใช้เกณฑ์อุณหภูมิ
  const isGps = (v) => v.gpsStatus !== undefined;
  const isAbnormal = (v) => (isGps(v) ? v.gpsStatus === 'วิกฤต' : v.temp > th(v.type).max || v.temp < th(v.type).min);
  const typeLabel = (t) => (isSheets() ? TYPE_LABEL_GPS[t] || t : TYPE_LABEL[t]);
  const gpsChip = (s) => {
    const cls = { 'วิกฤต': 'crit', 'แจ้งเตือน': 'warn', 'ปกติ': 'resolved', 'Standby': 'ack', 'ออฟไลน์': 'off', 'ปิดใช้งาน': 'off' }[s] || 'off';
    return `<span class="chip ${cls}">${esc(s || '–')}</span>`;
  };

  function gpsCard(v) {
    const bad = isAbnormal(v);
    const open = isSheets() ? state.alerts.find((a) => a.plate === v.plate && a.status !== 'resolved') : null;
    const cell = (label, val, k) => {
      const t = th(k);
      const cls = val == null ? 'muted' : isRO() ? '' : val > t.max ? 'hot' : val < t.min ? 'cold' : 'ok';
      return `<div><div class="v-meta">${label}</div><div class="temp ${cls}" style="font-size:22px">${val == null ? '–' : fmtT(val)}</div></div>`;
    };
    const act = isRO() || isSheets() ? `data-action="ro-open" data-plate="${esc(v.plate)}" style="cursor:pointer"` : open ? `data-action="open" data-id="${open.id}"` : '';
    return `<div class="v-card ${bad ? 'bad' : ''}" ${act}>
      <div class="row"><span class="plate">${esc(v.plate)}</span>${gpsChip(v.gpsStatus)}</div>
      <div class="v-meta">${esc([v.dc === NO_DC ? '' : v.dc, v.vtype || v.group, v.owner].filter(Boolean).join(' · '))}</div>
      <div class="row" style="margin:10px 0 6px;justify-content:flex-start;gap:22px">${cell('Frozen', v.tempF, 'Frozen')}${cell('Chilled', v.tempC, 'Chilled')}</div>
      <div class="row v-meta"><span>${v.driver ? 'พขร. ' + esc(v.driver) : esc(v.gpsId || '')}</span><span>${v.updated ? ago(v.updated) : '–'}</span></div>
      ${open ? `<div class="v-meta" style="margin-top:6px;color:var(--danger)">● ${open.id} · ${STATUS_LABEL[open.status]}</div>` : ''}
      ${adminIcons(v.plate)}
    </div>`;
  }

  function render() {
    const roMode = isRO();
    if (roMode && RO_HIDDEN_ROUTES.includes(ui.route)) ui.route = 'dashboard';
    if (isSheets() && ui.route === 'import' && ui.me && !ui.me.canImport) ui.route = 'dashboard';
    const [title, sub] = (roMode && RO_META[ui.route]) || ROUTE_META[ui.route];
    $('#pageTitle').textContent = title;
    $('#pageSub').textContent = sub;
    // แถบค้นหา/ตัวกรอง ซ่อนไว้ เปิดด้วยไอคอนค้นหา (จุดแดง = มีตัวกรองใช้งานอยู่)
    const canFilter = FILTER_ROUTES.includes(ui.route);
    $('#filters').classList.toggle('hidden', !canFilter || !ui.showFilters);
    $('#filterBtn').style.display = canFilter ? '' : 'none';
    $('#filterBtn').classList.toggle('on', !!ui.showFilters);
    $('#filterBtn').setAttribute('aria-expanded', String(!!ui.showFilters));
    $('#filterDot').hidden = !(ui.q || ui.type || ui.status || (ui.dc && state.role === 'ALL'));
    syncStatusOptions();
    $('#fStatus').style.display = (roMode ? ui.route === 'vehicles' : ui.route === 'alerts' || (isSheets() && ui.route === 'vehicles')) ? '' : 'none';
    $('#fType').style.display = roMode ? 'none' : '';
    $('#periodSel').closest('.select-pill').style.display = !roMode || ui.route === 'report' ? '' : 'none';
    $('[data-action="manual-alert"]').style.display = roMode ? 'none' : '';
    $('#navAlertsLbl').textContent = roMode ? 'รถสถานะวิกฤต' : isSheets() ? 'เคส / บันทึกผล' : 'รายการแจ้งเตือน';
    $('#navInspLbl').textContent = isSheets() ? 'ประวัติการบันทึกผล' : 'บันทึกผลการตรวจสอบ';
    document.querySelectorAll('.nav a').forEach((a) => {
      a.classList.toggle('active', a.dataset.route === ui.route);
      const hide = (roMode && RO_HIDDEN_ROUTES.includes(a.dataset.route)) ||
        (isSheets() && a.dataset.route === 'import' && !(ui.me && ui.me.canImport));
      a.style.display = hide ? 'none' : '';
    });
    $('#view').innerHTML = roMode
      ? (ui.route === 'settings' ? roViews.settings() : roState() || roViews[ui.route]())
      : (ui.route === 'settings' && !isSheets() ? srcPanel() : '') + views[ui.route]();
    renderBadges();
  }
  function renderBadges() {
    if (isRO()) {
      const n = scopedRO().filter((v) => v.gpsStatus === 'วิกฤต').length;
      $('#navBadge').textContent = n || '';
      $('#bellBadge').textContent = n ? (n > 99 ? '99+' : n) : '';
      document.title = n ? `(${n}) Temp Alert Control Tower` : 'Temp Alert Control Tower';
      if ($('#bellPanel').classList.contains('open')) renderBell();
      return;
    }
    const open = openAlerts();
    const n = open.filter((a) => a.status === 'new').length;
    $('#navBadge').textContent = open.length || '';
    $('#bellBadge').textContent = n || '';
    document.title = n ? `(${n}) Temp Alert Control Tower` : 'Temp Alert Control Tower';
    if ($('#bellPanel').classList.contains('open')) renderBell();
  }
  function renderBell() {
    if (isRO()) {
      const crit = scopedRO().filter((v) => v.gpsStatus === 'วิกฤต').sort(byOver);
      $('#bellPanel').innerHTML = `<div class="bell-head"><span>รถสถานะวิกฤต (${crit.length})</span><button class="link" data-action="go" data-go="alerts:">ดูทั้งหมด</button></div>` +
        (crit.slice(0, 12).map((v) => `<div class="bell-item" data-action="ro-open" data-plate="${esc(v.plate)}">
          <div class="ic" style="background:var(--crit)">${icon('flame')}</div>
          <div><b>${esc(v.plate)}</b>${v.dc !== NO_DC ? ' · ' + esc(v.dc) : ''}<div class="small">Frozen ${fmtT(v.tempF)} · Chilled ${fmtT(v.tempC)}</div>
          <div class="muted small">${v.overCont != null ? `เกินต่อเนื่อง ${dur(v.overCont * MIN)}` : ''}</div></div></div>`).join('') || '<div class="empty">ไม่มีรถสถานะวิกฤต</div>');
      return;
    }
    const list = openAlerts().sort(sortOpen).slice(0, 12);
    $('#bellPanel').innerHTML = `<div class="bell-head"><span>แจ้งเตือนที่ค้างอยู่ (${openAlerts().length})</span><button class="link" data-action="go" data-go="alerts:">ดูทั้งหมด</button></div>` +
      (list.map((a) => `<div class="bell-item" data-action="open" data-id="${a.id}">
        <div class="ic" style="background:${a.kind === 'high' ? 'var(--danger)' : 'var(--cold)'}">${icon(a.kind === 'high' ? 'flame' : 'snow')}</div>
        <div><b>${esc(a.plate)}</b> · ${esc(a.dc)}<div class="small">${fmtT(a.temp)} (เกณฑ์ ${a.min}…${a.max}) ${statusChip(a.status)}</div><div class="muted small">${ago(a.time)}</div></div>
      </div>`).join('') || '<div class="empty">ไม่มีแจ้งเตือนค้าง 🎉</div>');
  }

  // ---------- Temperature chart (SVG) ----------
  function series(a) {
    const r = rng(hash(a.id));
    const c = (a.min + a.max) / 2;
    const start = a.time - 120 * MIN;
    const end = a.status === 'resolved' ? a.inspection.at + 40 * MIN : Math.min(Date.now(), a.time + 8 * 60 * MIN);
    const endT = Math.max(end, a.time + 15 * MIN);
    const N = 60, pts = [];
    const fixAt = a.status === 'resolved' ? a.inspection.at : Infinity;
    for (let i = 0; i <= N; i++) {
      const t = start + ((endT - start) * i) / N;
      let v;
      if (t < a.time - 35 * MIN) v = c + (r() - 0.5) * (a.max - a.min) * 0.35;
      else if (t <= a.time) v = c + (a.temp - c) * ((t - (a.time - 35 * MIN)) / (35 * MIN)) + (r() - 0.5) * 0.6;
      else if (t < fixAt) v = a.temp + (r() - 0.5) * 1.2 * (1 + Math.min(1, (t - a.time) / (60 * MIN)));
      else v = a.temp + (a.inspection.measured - a.temp) * Math.min(1, (t - fixAt) / (25 * MIN)) + (r() - 0.5) * 0.4;
      pts.push([t, r1(v)]);
    }
    return { pts, start, end: endT };
  }
  function chartSvg(a) {
    const { pts, start, end } = series(a);
    const W = 640, H = 200, L = 40, R = 10, T = 10, B = 26;
    const vals = pts.map((p) => p[1]).concat([a.min, a.max]);
    const lo = Math.floor(Math.min(...vals) - 1.5), hi = Math.ceil(Math.max(...vals) + 1.5);
    const x = (t) => L + ((t - start) / (end - start)) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    const ticks = [];
    const step = Math.max(1, Math.ceil((hi - lo) / 5));
    for (let v = lo; v <= hi; v += step) ticks.push(v);
    const tTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => start + (end - start) * f);
    const fix = a.status === 'resolved' ? a.inspection.at : null;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="กราฟอุณหภูมิ">
      <rect x="${L}" y="${y(a.max)}" width="${W - L - R}" height="${y(a.min) - y(a.max)}" fill="var(--ok-soft)"/>
      <line x1="${L}" x2="${W - R}" y1="${y(a.max)}" y2="${y(a.max)}" stroke="var(--ok)" stroke-dasharray="4 4"/>
      <line x1="${L}" x2="${W - R}" y1="${y(a.min)}" y2="${y(a.min)}" stroke="var(--ok)" stroke-dasharray="4 4"/>
      ${ticks.map((v) => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${v}°</text>`).join('')}
      ${tTicks.map((t) => `<text x="${x(t)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${fmtTime(t)}</text>`).join('')}
      <line x1="${x(a.time)}" x2="${x(a.time)}" y1="${T}" y2="${H - B}" stroke="var(--danger)" stroke-dasharray="3 3"/>
      ${fix ? `<line x1="${x(fix)}" x2="${x(fix)}" y1="${T}" y2="${H - B}" stroke="var(--brand)" stroke-dasharray="3 3"/>` : ''}
      <path d="${line}" fill="none" stroke="${a.kind === 'high' ? 'var(--danger)' : 'var(--cold)'}" stroke-width="2.2" stroke-linejoin="round"/>
      <circle cx="${x(a.time)}" cy="${y(a.temp)}" r="5" fill="${a.kind === 'high' ? 'var(--danger)' : 'var(--cold)'}" stroke="var(--surface)" stroke-width="2"/>
    </svg>
    <div class="muted small" style="display:flex;gap:16px;flex-wrap:wrap;padding:4px 0 6px">
      <span><span style="display:inline-block;width:10px;height:10px;background:var(--ok-soft);border:1px solid var(--ok);border-radius:2px"></span> ช่วงอุณหภูมิที่ยอมรับได้</span>
      <span style="color:var(--danger)">┆ เวลาแจ้งเตือน</span>${fix ? '<span style="color:var(--brand)">┆ บันทึกผลแก้ไข</span>' : ''}</div>`;
  }

  // ---------- Modal ----------
  const modal = $('#modal'), card = $('#modalCard');
  function openModal(html) { card.innerHTML = html; modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); }
  function closeModal() {
    modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); card.innerHTML = ''; card.classList.remove('modal-sm', 'modal-md');
    ui.modalPhotos = []; ui.modalId = null; ui.reset = null;
    const r = ui.confirmResolve; ui.confirmResolve = null;
    if (r) r(false); // ปิดกล่องยืนยันด้วย Esc / คลิกพื้นหลัง = ยกเลิก
  }
  /** กล่องยืนยันในหน้าเว็บ (ใช้แทน confirm() ซึ่งบางเบราว์เซอร์/หน้าต่างฝังปิดไว้) — คืนค่า Promise<boolean> */
  function askConfirm(title, msg, okLabel = 'ยืนยัน', danger = false) {
    if (ui.confirmResolve) { const r = ui.confirmResolve; ui.confirmResolve = null; r(false); }
    return new Promise((res) => {
      openModal(`<div class="modal-head"><div><h2>${esc(title)}</h2></div>
          <button class="icon-btn close" data-action="confirm-no" aria-label="ปิด">${icon('x')}</button></div>
        <div class="modal-body"><p style="margin:0;line-height:1.7">${esc(msg)}</p></div>
        <div class="modal-foot"><button class="btn btn-sm btn-outline" data-action="confirm-no">ยกเลิก</button>
          <button class="btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}" data-action="confirm-yes" id="confirmYes">${esc(okLabel)}</button></div>`);
      card.classList.add('modal-sm');
      ui.confirmResolve = res;
      const b = $('#confirmYes'); if (b) b.focus();
    });
  }

  function openAlert(id) {
    const a = state.alerts.find((x) => x.id === id);
    if (!a) return;
    ui.modalId = id;
    ui.modalPhotos = [];
    $('#bellPanel').classList.remove('open');
    const tl = [
      { b: 'แจ้งเตือน', s: fmtDate(a.time), done: true },
      { b: 'DC รับทราบ', s: a.ackAt ? `${fmtDate(a.ackAt)} · ${esc(a.ackBy)}` : 'รอดำเนินการ', done: !!a.ackAt },
      { b: 'บันทึกผล / ปิดเคส', s: a.inspection ? `${fmtDate(a.inspection.at)} · ${esc(a.inspection.by)}` : 'รอดำเนินการ', done: !!a.inspection },
    ];
    const elapsed = a.inspection ? dur(a.inspection.at - a.time) : dur(Date.now() - a.time);
    const info = (a.tempF !== undefined ? [
      ['DC', esc(a.dc)], ['ใบรายการ', esc(a.waybill || '–')], ['พขร.', esc(a.driver || '–')], ['สถานะจาก GPS', gpsChip(a.gpsStatus)],
      ['Frozen', `<span class="temp">${a.tempF == null ? '–' : fmtT(a.tempF)}</span>`], ['Chilled', `<span class="temp">${a.tempC == null ? '–' : fmtT(a.tempC)}</span>`],
      ['กลุ่มรถ', esc(a.group || '–')], ['ระยะเวลา', elapsed],
    ] : [
      ['DC', esc(a.dc)], ['ประเภทรถ', TYPE_LABEL[a.type]], ['คนขับ', esc(a.driver)], ['ตำแหน่ง', `${esc(a.location)}`],
      ['อุณหภูมิที่วัดได้', `<span class="temp ${a.kind === 'high' ? 'hot' : 'cold'}">${fmtT(a.temp)}</span>`], ['เกณฑ์', `${a.min}…${a.max}°C`],
      ['เบี่ยงเบน', `${a.kind === 'high' ? 'สูงกว่า' : 'ต่ำกว่า'} ${a.dev}°C`], ['ระยะเวลา', elapsed],
    ]).filter((x) => x[1] !== '–').map(([k, v]) => `<div class="info"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

    let body;
    if (a.inspection) {
      const i = a.inspection;
      body = `<div class="section-title">${icon('clipboard')} ผลการตรวจสอบ</div>
        <div class="result-box">
          <div><div class="muted small">ผู้บันทึก</div><b>${esc(i.by)}</b></div>
          <div><div class="muted small">เวลาที่บันทึก</div><b>${fmtDate(i.at)}</b></div>
          <div><div class="muted small">หมวดสาเหตุ</div>${catChip(i.category)}</div>
          <div><div class="muted small">การปิดเคส</div>${closureChip(i)}</div>
          <div class="full"><div class="muted small">สาเหตุ</div><b>${esc(i.cause || '–')}</b></div>
          ${i.closure === 'unfixed' ? `<div class="full"><div class="muted small">สาเหตุที่แก้ไขไม่ได้</div><b style="color:var(--orange)">${esc(i.unfixedReason || '–')}</b></div>` : ''}
          <div class="full"><div class="muted small">ผลการตรวจสอบกับพนักงานขับรถ</div>${esc(i.driverCheck || '–')}</div>
          ${i.actions && i.actions.length ? `<div class="full"><div class="muted small">การดำเนินการ</div>${i.actions.map((x) => `<span class="chip resolved" style="margin:2px 4px 2px 0">${esc(x)}</span>`).join('')}</div>` : ''}
          ${i.measured != null ? `<div><div class="muted small">อุณหภูมิวัดซ้ำ</div><b class="temp">${fmtT(i.measured)}</b></div>` : ''}
          ${i.note ? `<div class="full"><div class="muted small">หมายเหตุ</div>${esc(i.note)}</div>` : ''}
          ${i.photos && i.photos.length ? `<div class="full"><div class="muted small">รูปภาพประกอบ</div><div class="thumbs">${i.photos.map((p) => `<a href="${esc(photoHref(p))}" target="_blank" rel="noopener"><img src="${esc(photoSrc(p))}" alt="รูปประกอบ"></a>`).join('')}</div></div>` : ''}
        </div>`;
    } else {
      const who = isSheets() && ui.me ? ui.me.team : (a.ackBy || state.settings.user);
      body = `<div class="section-title">${icon('clipboard')} บันทึกผลการตรวจสอบ</div>
        <form id="inspForm" class="form-grid" novalidate>
          <label class="fl">ชื่อผู้บันทึก <span class="req">*</span><input class="inp" name="by" value="${esc(isSheets() ? '' : who)}" placeholder="ชื่อ-สกุล ผู้ตรวจสอบ" required></label>
          <label class="fl">วันเวลาที่ตรวจสอบ <span class="req">*</span><input class="inp" type="datetime-local" name="at" value="${toLocalInput(Date.now())}" required></label>
          <label class="fl full">ผลการตรวจสอบกับพนักงานขับรถ <span class="req">*</span><textarea class="inp" name="driverCheck" placeholder="เช่น โทรสอบถาม พขร. แล้ว แจ้งว่าเปิดประตูส่งสินค้าหลายจุด / ปิดเครื่องทำความเย็นระหว่างจอด"></textarea></label>
          <div class="fl full">หมวดสาเหตุ <span class="req">*</span><div class="seg" data-name="category">
            ${Object.keys(CATEGORIES).map((c) => `<label class="seg-opt" style="--c:${CAT_COLOR[c]}"><input type="radio" name="category" value="${c}">${icon(CAT_ICON[c])}<b>${c}</b></label>`).join('')}</div></div>
          <label class="fl full">สาเหตุ <span class="req">*</span><select class="inp" name="cause" disabled><option value="">– เลือกหมวดสาเหตุก่อน –</option></select></label>
          <div class="fl full">การปิดเคส <span class="req">*</span><div class="seg" data-name="closure">
            <label class="seg-opt" style="--c:${CLOSURE_COLOR.fixed}"><input type="radio" name="closure" value="fixed">${icon('check')}<b>แก้ไขแล้ว</b></label>
            <label class="seg-opt" style="--c:${CLOSURE_COLOR.unfixed}"><input type="radio" name="closure" value="unfixed">${icon('alert')}<b>แก้ไขไม่ได้</b></label></div></div>
          <div class="fl full" id="unfixedBox" hidden>สาเหตุที่แก้ไขไม่ได้ <span class="req">*</span>
            <select class="inp" name="unfixedReason"><option value="">– เลือก –</option>${UNFIXED_REASONS.map((x) => `<option>${esc(x)}</option>`).join('')}</select></div>
          <div class="fl full">การดำเนินการ<div class="checks">${ACTIONS.map((x) => `<label class="check"><input type="checkbox" name="actions" value="${esc(x)}">${esc(x)}</label>`).join('')}</div></div>
          <label class="fl">อุณหภูมิที่วัดซ้ำ (°C)<input class="inp" type="number" step="0.1" name="measured" placeholder="ถ้ามี"></label>
          <label class="fl full">หมายเหตุ<textarea class="inp" name="note" placeholder="รายละเอียดเพิ่มเติม (จำเป็นถ้าเลือก &quot;อื่น ๆ&quot;)"></textarea></label>
          <div class="fl full">รูปภาพประกอบ (สูงสุด 3 รูป)<input type="file" accept="image/*" multiple id="photoInput" class="inp" style="padding:8px"><div class="thumbs" id="thumbs"></div></div>
        </form>`;
    }
    const foot = a.inspection
      ? `<button class="btn btn-sm btn-outline" data-action="close-modal">ปิด</button>`
      : `<button class="btn btn-sm btn-outline" data-action="close-modal">ยกเลิก</button>
         ${a.status === 'new' ? `<button class="btn btn-sm btn-warn" data-action="ack" data-id="${a.id}">รับทราบอย่างเดียว</button>` : ''}
         <button class="btn btn-sm btn-primary" data-action="submit-insp" data-id="${a.id}">${icon('check')} บันทึกผลและปิดเคส</button>`;

    openModal(`
      <div class="modal-head">
        <div class="kpi-ico" style="background:${a.kind === 'high' ? 'var(--danger)' : 'var(--cold)'};width:44px;height:44px">${icon(a.kind === 'high' ? 'flame' : 'snow')}</div>
        <div><h2>${esc(a.plate)} <span class="muted" style="font-weight:400;font-size:14px">${esc(a.prov)}</span></h2>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">${statusChip(a.status)}${a.gpsStatus !== undefined ? gpsChip(a.gpsStatus) : sevChip(a)}<span class="chip off">${a.id}</span>${a.source === 'manual' ? '<span class="chip off">แจ้งด้วยตนเอง</span>' : ''}</div></div>
        <button class="icon-btn close" data-action="close-modal" aria-label="ปิด">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="timeline">${tl.map((t) => `<div class="tl ${t.done ? 'done' : ''}"><b>${t.b}</b><span class="muted">${t.s}</span></div>`).join('')}</div>
        <div class="info-grid">${info}</div>
        <div class="chart-box">${isSheets() ? '<div id="histBox" class="muted small" style="padding:18px 4px">กำลังโหลดประวัติอุณหภูมิจากรายงานรายวัน...</div>' : chartSvg(a)}</div>
        ${body}
        ${a.adminLog ? `<div class="admin-log"><b>บันทึกผู้ดูแล</b><div>${esc(a.adminLog).replace(/\n/g, '<br>')}</div></div>` : ''}
      </div>
      <div class="modal-foot">${foot}</div>`);
    if (isSheets()) loadHistory(a);
  }

  // ---------- ประวัติจากรายงานรายวัน (โหมด Google Sheets) ----------
  async function loadHistory(a) {
    let h;
    try { h = await apiPost('history', { plate: a.plate }); } catch (e) { const b = $('#histBox'); if (b) b.textContent = 'โหลดประวัติไม่สำเร็จ: ' + e.message; return; }
    const box = $('#histBox');
    if (!box || ui.modalId !== a.id) return;
    box.classList.remove('muted', 'small');
    box.style.padding = '0';
    box.innerHTML = historyChart(h.snapshots) + historyEvents(h.events);
  }
  function historyChart(snaps) {
    const pts = snaps.filter((s) => s.tempF != null || s.tempC != null);
    if (pts.length < 2) return `<div class="muted small" style="padding:8px 0 10px">มีข้อมูลรายวัน ${pts.length} จุด — กราฟจะแสดงเมื่อนำเข้ารายงานตั้งแต่ 2 วันขึ้นไป</div>`;
    const W = 640, H = 190, L = 40, R = 10, T = 10, B = 26;
    const t0 = pts[0].time, t1 = pts[pts.length - 1].time || t0 + 1;
    const vals = pts.flatMap((p) => [p.tempF, p.tempC]).filter((v) => v != null).concat([th('Frozen').max, th('Chilled').max]);
    const lo = Math.floor(Math.min(...vals) - 2), hi = Math.ceil(Math.max(...vals) + 2);
    const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const line = (k, c) => {
      const p = pts.filter((s) => s[k] != null);
      return `<path d="${p.map((s, i) => `${i ? 'L' : 'M'}${x(s.time).toFixed(1)},${y(s[k]).toFixed(1)}`).join('')}" fill="none" stroke="${c}" stroke-width="2.2"/>` +
        p.map((s) => `<circle cx="${x(s.time).toFixed(1)}" cy="${y(s[k]).toFixed(1)}" r="${s.status === 'วิกฤต' ? 4.5 : 3}" fill="${s.status === 'วิกฤต' ? 'var(--danger)' : c}" stroke="var(--surface)" stroke-width="1.5"><title>${fmtDate(s.time)} · ${k === 'tempF' ? 'Frozen' : 'Chilled'} ${fmtT(s[k])} · ${s.status}</title></circle>`).join('');
    };
    const ticks = [];
    const step = Math.max(1, Math.ceil((hi - lo) / 5));
    for (let v = lo; v <= hi; v += step) ticks.push(v);
    const tl = (k, c) => `<line x1="${L}" x2="${W - R}" y1="${y(th(k).max)}" y2="${y(th(k).max)}" stroke="${c}" stroke-dasharray="4 4" opacity=".6"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="กราฟอุณหภูมิรายวัน">
      ${ticks.map((v) => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${v}°</text>`).join('')}
      ${[0, 0.5, 1].map((f) => `<text x="${x(t0 + (t1 - t0) * f)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${new Date(t0 + (t1 - t0) * f).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}</text>`).join('')}
      ${tl('Frozen', 'var(--info)')}${tl('Chilled', 'var(--brand)')}
      ${line('tempF', 'var(--info)')}${line('tempC', 'var(--brand)')}
    </svg>
    <div class="muted small" style="display:flex;gap:16px;flex-wrap:wrap;padding:4px 0 8px">
      <span style="color:var(--info)">━ Frozen</span><span style="color:var(--brand)">━ Chilled</span><span>┄ เส้นเกณฑ์สูงสุด</span><span style="color:var(--danger)">● วันที่สถานะวิกฤต</span></div>`;
  }
  function historyEvents(ev) {
    if (!ev.length) return '<div class="muted small" style="padding-bottom:8px">ไม่มีประวัติเกินเกณฑ์ของรถคันนี้</div>';
    return `<div class="section-title" style="font-size:13px;margin-top:4px">ประวัติเกินเกณฑ์ล่าสุด (จากระบบ GPS)</div>
      <div class="table-wrap"><table style="min-width:560px"><thead><tr><th>เริ่มเกินเกณฑ์</th><th>กลับปกติ</th><th>นาน</th><th>ใบรายการ</th><th>DC</th></tr></thead><tbody>
      ${ev.slice(0, 10).map((e) => `<tr style="cursor:default"><td>${fmtDate(e.start)}</td><td>${e.end ? fmtDate(e.end) : '<span class="chip new">ยังไม่กลับปกติ</span>'}</td><td>${e.minutes != null ? dur(e.minutes * MIN) : '–'}</td><td class="small">${esc(e.waybill || '–')}</td><td class="small">${esc(e.dc || '–')}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  async function ackAlert(id, silent) {
    const a = state.alerts.find((x) => x.id === id);
    if (!a || a.status !== 'new') return;
    if (isSheets()) {
      if (!(await remote('ack', { id, by: state.settings.user }))) return;
    } else {
      a.status = 'ack';
      a.ackAt = Date.now();
      a.ackBy = state.settings.user;
      save();
    }
    if (!silent) toast('รับทราบแล้ว', `${a.plate} · ${a.dc} — สถานะ: กำลังตรวจสอบ`);
    render();
    if (ui.modalId === id) openAlert(id);
  }

  async function submitInspection(id) {
    const a = state.alerts.find((x) => x.id === id);
    const f = $('#inspForm');
    if (!a || !f) return;
    const E = f.elements;
    const radio = (n) => (f.querySelector(`input[name="${n}"]:checked`) || {}).value || '';
    const category = radio('category'), closure = radio('closure');
    const missing = [];
    const mark = (el, bad, label) => { if (el) el.classList.toggle('invalid', bad); if (bad) missing.push(label); };
    mark(E.by, !E.by.value.trim(), 'ชื่อผู้บันทึก');
    mark(E.at, !E.at.value, 'วันเวลา');
    mark(E.driverCheck, !E.driverCheck.value.trim(), 'ผลตรวจสอบกับ พขร.');
    mark(f.querySelector('[data-name="category"]'), !category, 'หมวดสาเหตุ');
    mark(E.cause, !E.cause.value, 'สาเหตุ');
    mark(f.querySelector('[data-name="closure"]'), !closure, 'การปิดเคส');
    mark(E.unfixedReason, closure === 'unfixed' && !E.unfixedReason.value, 'สาเหตุที่แก้ไขไม่ได้');
    const needNote = E.cause.value === OTHER || (closure === 'unfixed' && E.unfixedReason.value === OTHER);
    mark(E.note, needNote && !E.note.value.trim(), 'หมายเหตุ (เลือก "อื่น ๆ")');
    if (missing.length) { toast('กรอกข้อมูลไม่ครบ', missing.join(', '), 'danger'); return; }
    let at = new Date(E.at.value).getTime();
    // ช่อง datetime-local ละวินาที — เทียบระดับนาที แล้วไม่ให้ก่อนเวลาแจ้งเตือน
    if (at >= a.time - (a.time % MIN)) at = Math.max(at, a.time);
    if (at < a.time) { E.at.classList.add('invalid'); toast('เวลาไม่ถูกต้อง', 'เวลาตรวจสอบต้องไม่ก่อนเวลาแจ้งเตือน', 'danger'); return; }
    const withNote = (v) => (v === OTHER ? `อื่น ๆ: ${E.note.value.trim()}` : v);
    const m = parseFloat(E.measured.value);
    const inspection = {
      at, by: E.by.value.trim(), category, cause: withNote(E.cause.value), driverCheck: E.driverCheck.value.trim(),
      actions: [...f.querySelectorAll('input[name="actions"]:checked')].map((x) => x.value),
      closure, unfixedReason: closure === 'unfixed' ? withNote(E.unfixedReason.value) : '',
      measured: isNaN(m) ? null : r1(m), note: E.note.value.trim(), photos: ui.modalPhotos.slice(0, 3),
    };
    const doneMsg = `${a.plate} — ${category} · ${CLOSURE[closure]}`;
    if (isSheets()) {
      const btn = document.querySelector('[data-action="submit-insp"]');
      if (btn) { btn.disabled = true; btn.lastChild.textContent = ' กำลังบันทึก...'; }
      const ok = await remote('inspect', { id, inspection });
      if (!ok) { if (btn) { btn.disabled = false; btn.lastChild.textContent = ' บันทึกผลและปิดเคส'; } return; }
      closeModal();
      toast('บันทึกผลเรียบร้อย', `${doneMsg} (บันทึกลง Google Sheets แล้ว)`);
      return;
    }
    if (!a.ackAt) { a.ackAt = Math.min(at, Date.now()); a.ackBy = inspection.by; }
    a.inspection = inspection;
    a.status = 'resolved';
    const v = state.vehicles.find((x) => x.id === a.vehicleId);
    if (v) {
      v.temp = inspection.measured == null ? r1(center(v.type)) : inspection.measured;
      v.updated = Date.now();
    }
    save();
    closeModal();
    toast('บันทึกผลเรียบร้อย', doneMsg);
    render();
  }
  /** ฟอร์มบันทึกผล: เลือกหมวด → แสดงรายการสาเหตุของหมวดนั้น, เลือก "แก้ไขไม่ได้" → แสดงช่องสาเหตุ */
  function onInspFormChange(t) {
    const f = $('#inspForm');
    if (!f || !f.contains(t)) return;
    if (t.name === 'category') {
      const sel = f.elements.cause;
      sel.disabled = false;
      sel.innerHTML = '<option value="">– เลือกสาเหตุ –</option>' + CATEGORIES[t.value].map((c) => `<option>${esc(c)}</option>`).join('');
      f.querySelector('[data-name="category"]').classList.remove('invalid');
    }
    if (t.name === 'closure') {
      $('#unfixedBox').hidden = t.value !== 'unfixed';
      f.querySelector('[data-name="closure"]').classList.remove('invalid');
    }
    if (t.classList && t.classList.contains('invalid') && String(t.value).trim()) t.classList.remove('invalid');
  }

  function readImg(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          const s = Math.min(1, 720 / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          res(c.toDataURL('image/jpeg', 0.65));
        };
        img.onerror = rej;
        img.src = fr.result;
      };
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
  }

  function manualAlertModal() {
    const vs = state.vehicles.filter((v) => inRole(v.dc)).sort((a, b) => a.dc.localeCompare(b.dc) || a.plate.localeCompare(b.plate));
    openModal(`
      <div class="modal-head"><div><h2>แจ้งเตือนอุณหภูมิผิดปกติด้วยตนเอง</h2><div class="muted small">ใช้เมื่อ DC/คนขับพบอุณหภูมิผิดปกติแต่ระบบเซนเซอร์ไม่แจ้ง</div></div>
        <button class="icon-btn close" data-action="close-modal" aria-label="ปิด">${icon('x')}</button></div>
      <div class="modal-body"><form id="manForm" class="form-grid" novalidate>
        <label class="fl full">รถ <span class="req">*</span><select class="inp" name="v" required><option value="">– เลือกทะเบียนรถ –</option>${vs.map((v) => `<option value="${esc(v.id)}">${esc(v.plate)} · ${esc(v.dc)}${isGps(v) ? '' : ` · ${TYPE_SHORT[v.type]} (${th(v.type).min}…${th(v.type).max}°C)`}</option>`).join('')}</select></label>
        ${isSheets() ? `<label class="fl full">ช่องที่วัด <span class="req">*</span><select class="inp" name="comp"><option value="Frozen">ช่องแช่แข็ง (Frozen) · เกณฑ์ ${th('Frozen').min}…${th('Frozen').max}°C</option><option value="Chilled">ช่องแช่เย็น (Chilled) · เกณฑ์ ${th('Chilled').min}…${th('Chilled').max}°C</option></select></label>` : ''}
        <label class="fl">อุณหภูมิที่วัดได้ (°C) <span class="req">*</span><input class="inp" type="number" step="0.1" name="temp" required></label>
        <label class="fl">เวลาที่พบ<input class="inp" type="datetime-local" name="at" value="${toLocalInput(Date.now())}"></label>
      </form></div>
      <div class="modal-foot"><button class="btn btn-sm btn-outline" data-action="close-modal">ยกเลิก</button><button class="btn btn-sm btn-primary" data-action="submit-manual">สร้างแจ้งเตือน</button></div>`);
  }
  function submitManual() {
    const f = $('#manForm');
    const v = state.vehicles.find((x) => x.id === f.elements.v.value);
    const temp = parseFloat(f.elements.temp.value);
    f.elements.v.classList.toggle('invalid', !v);
    f.elements.temp.classList.toggle('invalid', isNaN(temp));
    if (!v || isNaN(temp)) return;
    const comp = f.elements.comp ? f.elements.comp.value : v.type;
    const t = th(comp);
    if (temp <= t.max && temp >= t.min) { toast('อุณหภูมิอยู่ในเกณฑ์', `${v.plate} เกณฑ์ ${t.min}…${t.max}°C — ไม่ต้องสร้างแจ้งเตือน`, 'danger'); return; }
    const at = f.elements.at.value ? new Date(f.elements.at.value).getTime() : Date.now();
    closeModal();
    if (isSheets()) remote('manual', { plate: v.plate, compartment: comp, temp: r1(temp), time: Math.min(at, Date.now()) });
    else ingestReading(v.id, r1(temp), Math.min(at, Date.now()), 'manual');
  }

  // ---------- Ingest / alert creation ----------
  /** จุดเชื่อมต่อข้อมูลจริง: เรียกเมื่อได้รับค่าอุณหภูมิจาก GPS/Temp sensor */
  function ingestReading(vehicleId, temp, time = Date.now(), source = 'sensor') {
    const v = state.vehicles.find((x) => x.id === vehicleId);
    if (!v) return null;
    v.temp = temp; v.updated = time; v.online = true;
    const t = th(v.type);
    if (temp <= t.max && temp >= t.min) return null;
    const existing = state.alerts.find((a) => a.vehicleId === v.id && a.status !== 'resolved');
    if (existing) {
      // อัปเดตค่าสูงสุดของเหตุการณ์ที่ยังเปิดอยู่ ไม่สร้างซ้ำ
      const dev = r1(temp > t.max ? temp - t.max : t.min - temp);
      if (dev > existing.dev) { existing.temp = temp; existing.dev = dev; existing.kind = temp > t.max ? 'high' : 'low'; existing.severity = dev >= state.settings.criticalDelta ? 'critical' : 'warning'; }
      return existing;
    }
    const a = makeAlert(v, temp, time, state.settings, source);
    state.alerts.unshift(a);
    save();
    notifyNew(a);
    render();
    return a;
  }

  function notifyNew(a) {
    if (!inRole(a.dc)) return;
    toast(`แจ้งเตือน: ${a.kind === 'high' ? 'อุณหภูมิสูงเกิน' : 'อุณหภูมิต่ำเกิน'}`, `${a.plate} · ${a.dc} · ${fmtT(a.temp)} (เกณฑ์ ${a.min}…${a.max})`, 'danger', a.id);
    if (state.settings.sound) beep(a.severity === 'critical' ? 3 : 2);
    if (state.settings.desktop && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(`🌡️ ${a.plate} อุณหภูมิผิดปกติ`, { body: `${a.dc} · ${fmtT(a.temp)} (เกณฑ์ ${a.min}…${a.max}°C)`, tag: a.id });
        n.onclick = () => { window.focus(); openAlert(a.id); };
      } catch (e) { /* ignore */ }
    }
  }

  let audioCtx = null;
  function beep(times) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < times; i++) {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = 880; o.type = 'sine';
        const t0 = audioCtx.currentTime + i * 0.22;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.15, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
        o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.18);
      }
    } catch (e) { /* ignore */ }
  }

  function toast(title, msg, kind = '', alertId = null) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `<b>${esc(title)}</b><span class="small">${esc(msg)}</span>`;
    if (alertId) { el.dataset.action = 'open'; el.dataset.id = alertId; }
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), alertId ? 9000 : 4000);
  }

  // ---------- Simulation ----------
  let simTimer = null;
  function simTick(force = false) {
    const r = Math.random;
    state.vehicles.forEach((v) => {
      if (!v.online) { if (r() < 0.02) v.online = true; return; }
      const open = state.alerts.find((a) => a.vehicleId === v.id && a.status !== 'resolved');
      const c = center(v.type);
      if (open) v.temp = r1(open.temp + (r() - 0.5) * 0.8);
      else v.temp = r1(v.temp + (c - v.temp) * 0.2 + (r() - 0.5) * 0.8);
      v.updated = Date.now();
    });
    if (force || r() < 0.18) {
      const pool = state.vehicles.filter((v) => v.online && inRole(v.dc) && !state.alerts.some((a) => a.vehicleId === v.id && a.status !== 'resolved'));
      if (pool.length) {
        const v = pick(r, pool);
        const t = th(v.type);
        const high = r() < 0.75;
        const dev = 0.8 + r() * (r() < 0.3 ? 8 : 4);
        ingestReading(v.id, r1(high ? t.max + dev : t.min - dev), Date.now(), 'sensor');
        return;
      }
    }
    save();
    // re-render เฉพาะหน้ารถสด (หน้าอื่นจะ re-render เมื่อมีแจ้งเตือนใหม่เท่านั้น เพื่อไม่ให้คลิกหลุด)
    if (ui.route === 'vehicles' && !modal.classList.contains('open') && !document.activeElement.closest('.filters')) render();
  }
  function startSim() {
    clearInterval(simTimer);
    if (isRO()) {
      simTimer = setInterval(() => { if (!document.hidden) loadSheet({ quiet: true }); }, 5 * 60000);
      setLive(!!ro.loadedAt);
      return;
    }
    if (isSheets()) {
      simTimer = setInterval(() => { if (!document.hidden && session) refresh(); }, POLL_MS);
      setLive(state.loaded);
      return;
    }
    simTimer = state.settings.sim ? setInterval(simTick, state.settings.simEvery * 1000) : null;
    setLive(state.settings.sim);
  }
  function setLive(ok, err) {
    $('#liveDot').classList.toggle('off', !ok);
    $('#liveText').textContent = isSheets() && !session ? 'Google Sheets · รอเข้าสู่ระบบ' : isRO()
      ? (ok ? `Google Sheet · โหลดเมื่อ ${fmtTime(ro.loadedAt)}` : 'Google Sheet: โหลดไม่สำเร็จ')
      : isSheets()
      ? (ok ? 'Google Sheets · อัปเดตทุก 20 วิ' : 'Sheets: เชื่อมต่อไม่ได้')
      : (ok ? 'รับข้อมูลสด (จำลอง)' : 'หยุดรับข้อมูล');
    $('#liveText').title = err || '';
  }

  // ---------- Import daily report ----------
  function importSay(html) { ui.importMsg = html; const el = $('#importStatus'); if (el) el.innerHTML = html; }
  const importBox = (cls, html) => `<div class="import-result ${cls}">${html}</div>`;
  function importSummary(s) {
    return importBox('ok', `${icon('check')}<div>นำเข้า <b>${esc(s.reportFile)}</b> สำเร็จ<br>
      <span class="small">รถ ${s.vehicles} คัน · วิกฤต ${s.critical} คัน · แจ้งเตือนใหม่ <b>${s.newAlerts}</b> · อัปเดตงานค้าง ${s.updatedAlerts} · ประวัติเกินเกณฑ์ใหม่ ${s.newEvents} รายการ</span>
      ${s.dataDate ? `<br><span class="small">วันที่ของข้อมูล <b>${new Date(s.dataDate).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}</b> · ต่อท้ายชีต "ข้อมูลรายวัน" ${s.dailyRows} แถว</span>` : ''}
      <br><a class="link" href="#/alerts">ดูรายการแจ้งเตือน →</a></div>`);
  }
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = XLSX_URL;
      s.onload = res;
      s.onerror = () => rej(new Error('โหลดตัวอ่านไฟล์ Excel ไม่สำเร็จ (ตรวจสอบอินเทอร์เน็ต)'));
      document.head.appendChild(s);
    });
  }
  async function importFile(file) {
    if (!file) return;
    if (!/\.xlsx?$/i.test(file.name)) { importSay(importBox('err', 'รองรับเฉพาะไฟล์ .xlsx / .xls')); return; }
    importSay(importBox('', `กำลังอ่านไฟล์ ${esc(file.name)}...`));
    let vehicles, events;
    try {
      await loadXlsx();
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      const find = (k) => wb.SheetNames.find((n) => n.includes(k));
      const rows = (n) => (n ? window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' })
        .map((r) => r.map((c) => (c instanceof Date ? c.getTime() : c))) : []);
      if (!find('รายคัน')) throw new Error('ไม่พบชีต "รายคัน" ในไฟล์นี้');
      vehicles = rows(find('รายคัน'));
      events = rows(find('ประวัติเกินเกณฑ์'));
    } catch (e) { importSay(importBox('err', esc(e.message))); return; }
    importSay(importBox('', `กำลังบันทึกลง Google Sheets: รถ ${Math.max(0, vehicles.length - 1)} คัน · ประวัติ ${Math.max(0, events.length - 1)} รายการ...`));
    const j = await remote('import', { fileName: file.name.replace(/\.xlsx?$/i, ''), vehicles, events, by: state.settings.user }, { quiet: true });
    importSay(j ? importSummary(j.import) : importBox('err', esc($('#liveText').title || 'นำเข้าไม่สำเร็จ')));
  }
  async function importLink() {
    const url = $('#importLink').value.trim();
    if (!/docs\.google\.com\/spreadsheets\/d\//.test(url)) { $('#importLink').classList.add('invalid'); importSay(importBox('err', 'กรุณาวางลิงก์ Google Sheet (https://docs.google.com/spreadsheets/d/...)')); return; }
    importSay(importBox('', 'กำลังนำเข้าจากลิงก์...'));
    const j = await remote('importLink', { url, by: state.settings.user }, { quiet: true });
    importSay(j ? importSummary(j.import) : importBox('err', esc($('#liveText').title || 'นำเข้าไม่สำเร็จ')));
  }

  // ---------- Export ----------
  function downloadCsv(head, rows, name) {
    const csv = '﻿' + [head, ...rows].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const el = document.createElement('a');
    el.href = url; el.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(el); el.click(); el.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Export สำเร็จ', `${rows.length} รายการ`);
  }
  function exportCsv() {
    if (isRO()) {
      let list = scopedRO();
      if (ui.route === 'alerts' || ui.route === 'dashboard') list = list.filter((v) => v.gpsStatus === 'วิกฤต');
      else if (ui.route === 'vehicles' && ui.status) list = list.filter((v) => v.gpsStatus === ui.status);
      downloadCsv(['ทะเบียน', 'GPS ID', 'กลุ่ม', 'ประเภทรถ', 'ชนิดรถ', 'พขร.', 'เบอร์ พขร.', 'สถานะ', 'Frozen (°C)', 'Chilled (°C)', 'เกินเกณฑ์ต่อเนื่อง (นาที)', 'จอดนอกจุด (นาที)', 'อัพเดทล่าสุด', 'DC (ใบรายการล่าสุด)', 'ใบรายการล่าสุด'],
        list.sort(byOver).map((v) => [v.plate, v.gpsId, v.group, v.vtype, v.owner, v.driver, v.phone, v.gpsStatus, v.tempF, v.tempC, v.overCont, v.parkOut, v.updated ? fmtDate(v.updated) : '', v.dc === NO_DC ? '' : v.dc, v.waybill]),
        ui.route === 'vehicles' ? 'vehicles' : 'critical-vehicles');
      return;
    }
    const list = (ui.route === 'inspections' ? filtered({ ignoreStatus: true }).filter((a) => a.status === 'resolved') : filtered());
    const head = ['รหัส', 'เวลาแจ้งเตือน', 'ทะเบียน', 'จังหวัด', 'DC', 'ประเภท', 'คนขับ', 'ตำแหน่ง', 'อุณหภูมิ', 'เกณฑ์ต่ำสุด', 'เกณฑ์สูงสุด', 'เบี่ยงเบน', 'ระดับ', 'สถานะ', 'รับทราบเมื่อ', 'ผู้รับทราบ', 'ตรวจสอบเมื่อ', 'ผู้บันทึก', 'วัดซ้ำ', 'หมวดสาเหตุ', 'สาเหตุ', 'ผลตรวจสอบกับ พขร.', 'การดำเนินการ', 'การปิดเคส', 'สาเหตุที่แก้ไขไม่ได้', 'หมายเหตุ', 'ใบรายการ', 'Frozen (°C)', 'Chilled (°C)', 'สถานะ GPS', 'ไฟล์รายงาน'];
    const rows = list.map((a) => {
      const i = a.inspection || {};
      return [a.id, fmtDate(a.time), a.plate, a.prov, a.dc, typeLabel(a.type), a.driver, a.location, a.temp, a.min, a.max, a.dev, a.severity === 'critical' ? 'วิกฤต' : 'เตือน', STATUS_LABEL[a.status],
        a.ackAt ? fmtDate(a.ackAt) : '', a.ackBy || '', i.at ? fmtDate(i.at) : '', i.by || '', i.measured ?? '', i.category || '', i.cause || '', i.driverCheck || '', (i.actions || []).join(' / '), CLOSURE[i.closure] || '', i.unfixedReason || '', i.note || '', a.waybill || '', a.tempF ?? '', a.tempC ?? '', a.gpsStatus || '', a.reportFile || ''];
    });
    const csv = '﻿' + [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const el = document.createElement('a');
    el.href = url; el.download = `temp-alerts-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(el); el.click(); el.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Export สำเร็จ', `${list.length} รายการ`);
  }

  // ---------- Theme ----------
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const ic = $('#themeIco');
    if (ic) ic.innerHTML = icon(dark ? 'sun' : 'moon').replace(/^<span class="ico">|<\/span>$/g, '');
  }

  // ---------- Events ----------
  function setupControls() {
    $('#fDc').innerHTML = '<option value="">ทุก DC</option>' + DCS.map((d) => `<option>${esc(d)}</option>`).join('');
    $('#roleSel').innerHTML = '<option value="ALL">Admin · ทุก DC</option>' + DCS.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    $('#roleSel').value = DCS.includes(state.role) ? state.role : 'ALL';
    state.role = $('#roleSel').value;
    if (isSheets()) {
      $('#fType').innerHTML = '<option value="">ทุกช่องที่เกินเกณฑ์</option><option value="Frozen">ช่องแช่แข็ง (Frozen)</option><option value="Chilled">ช่องแช่เย็น (Chilled)</option>';
      $('#fType').value = ui.type;
    }
    if (isSheets()) {
      state.role = 'ALL';
      $('#roleSel').style.display = 'none';
      $('#userName').textContent = session ? session.team : '–';
      $('#navLogout').hidden = !session;
      $('#navLogout').title = session ? `ออกจากระบบ (${session.team})` : '';
    }
    $('#fStatus').dataset.kind = '';
    syncStatusOptions();
    $('#userName').textContent = isSheets() ? (session ? session.team : '–') : state.settings.user;
    syncDcFilter();
  }
  /** ตัวกรองสถานะ: หน้ารถใช้สถานะ GPS, หน้าเคสใช้สถานะเคส */
  function syncStatusOptions() {
    const sel = $('#fStatus');
    const kind = isRO() || (isSheets() && ui.route === 'vehicles') ? 'gps' : 'case';
    if (sel.dataset.kind !== kind) {
      sel.dataset.kind = kind;
      sel.innerHTML = kind === 'gps'
        ? '<option value="">ทุกสถานะ GPS</option>' + GPS_STATUSES.map((s) => `<option>${s}</option>`).join('')
        : '<option value="">ทุกสถานะ</option>' + Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    }
    const valid = kind === 'gps' ? GPS_STATUSES.includes(ui.status) : !!STATUS_LABEL[ui.status];
    if (!valid) ui.status = '';
    sel.value = ui.status;
  }
  function syncDcFilter() {
    const sel = $('#fDc');
    if (state.role !== 'ALL') { ui.dc = state.role; sel.value = state.role; sel.disabled = true; }
    else { sel.disabled = false; sel.value = ui.dc; }
  }
  function route() {
    const r = (location.hash.replace(/^#\//, '') || 'dashboard').split('?')[0];
    ui.route = ROUTE_META[r] ? r : 'dashboard';
    $('#sidebar').classList.remove('open');
    $('.scrim').classList.remove('open');
    render();
    window.scrollTo(0, 0);
  }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) {
      if (!e.target.closest('.bell-wrap')) $('#bellPanel').classList.remove('open');
      if (e.target === modal) closeModal();
      return;
    }
    const { action, id } = el.dataset;
    switch (action) {
      case 'open': if (e.target.closest('button') && e.target.closest('button') !== el) return; openAlert(id); break;
      case 'ack': e.stopPropagation(); ackAlert(id); break;
      case 'submit-insp': submitInspection(id); break;
      case 'close-modal': closeModal(); break;
      case 'manual-alert': manualAlertModal(); break;
      case 'submit-manual': submitManual(); break;
      case 'export': exportCsv(); break;
      case 'toggle-bell': $('#bellPanel').classList.toggle('open'); renderBell(); break;
      case 'toggle-theme': {
        const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        const next = cur === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(KEY + '.theme', next); } catch (er) { /* ignore */ }
        applyTheme(next);
        break;
      }
      case 'go': {
        const [r, st] = el.dataset.go.split(':');
        if (st !== undefined) { ui.status = st; $('#fStatus').value = st; }
        $('#bellPanel').classList.remove('open');
        if (location.hash === '#/' + r) render(); else location.hash = '#/' + r;
        break;
      }
      case 'dc':
        if (state.role === 'ALL') { ui.dc = el.dataset.dc; $('#fDc').value = ui.dc; }
        ui.status = ''; $('#fStatus').value = '';
        location.hash = '#/alerts';
        if (ui.route === 'alerts') render();
        break;
      case 'clear-filters':
        ui.q = ''; ui.type = ''; ui.status = ''; if (state.role === 'ALL') ui.dc = '';
        $('#fQ').value = ''; $('#fType').value = ''; $('#fStatus').value = ''; syncDcFilter();
        render();
        break;
      case 'open-nav': $('#sidebar').classList.add('open'); $('.scrim').classList.add('open'); break;
      case 'close-nav': $('#sidebar').classList.remove('open'); $('.scrim').classList.remove('open'); break;
      case 'save-settings': saveSettings(); break;
      case 'sim-now': if (!isSheets()) simTick(true); break;
      case 'api-connect': {
        const url = $('#apiUrl').value.trim();
        const token = $('#apiToken').value.trim();
        if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) { $('#apiUrl').classList.add('invalid'); toast('URL ไม่ถูกต้อง', 'ต้องเป็นลิงก์ Web app ของ Apps Script (https://script.google.com/macros/s/.../exec)', 'danger'); break; }
        el.disabled = true; el.textContent = 'กำลังทดสอบ...';
        try {
          const j = await apiPost('teams', {}, { url, token });
          try { localStorage.setItem(KEY + '.api', JSON.stringify({ url, token })); } catch (er) { /* ignore */ }
          try { localStorage.removeItem(KEY + '.session'); } catch (er) { /* ignore */ }
          toast('เชื่อมต่อสำเร็จ', `พบทีมที่ตั้ง PIN แล้ว ${j.teams.length} ทีม — กำลังไปหน้าเข้าสู่ระบบ`);
          setTimeout(() => location.reload(), 900);
        } catch (er) {
          el.disabled = false; el.textContent = 'ทดสอบและเชื่อมต่อ';
          toast('เชื่อมต่อไม่สำเร็จ', er.message, 'danger');
        }
        break;
      }
      case 'import-link': importLink(); break;
      case 'ro-open': {
        if (e.target.closest('button') && e.target.closest('button') !== el) return;
        const openCase = isSheets() && state.alerts.find((a) => a.plate === el.dataset.plate && a.status !== 'resolved');
        if (openCase) openAlert(openCase.id); else openRoVehicle(el.dataset.plate);
        break;
      }
      case 'src-reload': if (isSheets()) refresh(); else loadSheet(); break;
      case 'confirm-yes':
      case 'confirm-no': {
        const r = ui.confirmResolve; ui.confirmResolve = null;
        closeModal();
        if (r) r(action === 'confirm-yes');
        break;
      }
      case 'admin-ask': e.stopPropagation(); adminAsk(el.dataset.mode, el.dataset.plate); break;
      case 'reset-open': openResetDialog(); break;
      case 'undo-import': {
        const file = el.dataset.file;
        const imp = (state.imports || []).find((i) => i.reportFile === file);
        ui.undoFile = file;
        openModal(`<div class="modal-head"><div><h2>ยกเลิกการนำเข้า</h2><div class="muted small" style="margin-top:4px">${esc(file)}</div></div>
            <button class="icon-btn close" data-action="close-modal" aria-label="ปิด">${icon('x')}</button></div>
          <div class="modal-body">
            <div class="rs-warn">${icon('alert')}<div>ระบบจะ:<br>
              • ลบข้อมูลของไฟล์นี้ในชีต <b>ข้อมูลรายวัน</b> (${imp ? imp.vehicles : '–'} แถว) และ <b>ประวัติเกินเกณฑ์</b> ที่ไฟล์นี้เพิ่มเข้ามา (${imp ? imp.newEvents : '–'} รายการ)<br>
              • ลบเคสใหม่ที่ไฟล์นี้สร้าง (${imp ? imp.newAlerts : '–'} เคส) — <b>ยกเว้น</b>เคสที่ DC รับทราบหรือบันทึกผลไปแล้ว จะเก็บไว้<br>
              • ถ้าเป็นไฟล์ล่าสุด สถานะรถจะกลับไปเป็นข้อมูลจากรายงานก่อนหน้า<br>
              <span class="small">นำเข้าไฟล์นี้ใหม่ได้หลังยกเลิก · ย้อนกลับการยกเลิกไม่ได้</span></div></div>
            <label class="fl" style="margin-top:14px">เหตุผล <span class="req">*</span><textarea class="inp" id="adminReason" placeholder="เช่น นำเข้าไฟล์ผิดวัน / ไฟล์ข้อมูลไม่ครบ ต้องนำเข้าใหม่"></textarea></label>
          </div>
          <div class="modal-foot"><button class="btn btn-sm btn-outline" data-action="close-modal">ยกเลิก</button>
            <button class="btn btn-sm btn-danger" data-action="undo-submit">ยืนยันยกเลิกการนำเข้า</button></div>`);
        card.classList.add('modal-md');
        $('#adminReason').focus();
        break;
      }
      case 'undo-submit': {
        const reason = $('#adminReason').value.trim();
        if (reason.length < 3) { $('#adminReason').classList.add('invalid'); toast('กรุณาระบุเหตุผล', 'ต้องใส่เหตุผลก่อนยืนยัน', 'danger'); break; }
        el.disabled = true; el.textContent = 'กำลังยกเลิก...';
        const j = await remote('undoImport', { reportFile: ui.undoFile, reason });
        if (!j) { el.disabled = false; el.textContent = 'ยืนยันยกเลิกการนำเข้า'; break; }
        closeModal();
        const u = j.undo || {};
        ui.importMsg = '';
        toast('ยกเลิกการนำเข้าแล้ว', `ลบข้อมูลรายวัน ${u.daily || 0} แถว · ประวัติ ${u.events || 0} · เคส ${u.alertsRemoved || 0}${u.alertsKept ? ` (เก็บเคสที่ทำงานแล้ว ${u.alertsKept})` : ''}${u.restoredVehicles ? ' · คืนสถานะรถเป็นรายงานก่อนหน้า' : ''}`);
        break;
      }
      case 'reset-submit': submitReset(el); break;
      case 'rs-all-shown':
        document.querySelectorAll('.rs-list input[data-plate]').forEach((c) => ui.reset.sel.add(c.dataset.plate));
        renderResetBody();
        break;
      case 'rs-none': ui.reset.sel.clear(); renderResetBody(); break;
      case 'toggle-filters':
        ui.showFilters = !ui.showFilters;
        render();
        if (ui.showFilters) $('#fQ').focus();
        break;
      case 'admin-submit': {
        const reason = $('#adminReason').value.trim();
        if (reason.length < 3) { $('#adminReason').classList.add('invalid'); toast('กรุณาระบุเหตุผล', 'ต้องใส่เหตุผลก่อนยืนยัน', 'danger'); break; }
        const open = ui.adminMode === 'open';
        el.disabled = true; el.textContent = 'กำลังบันทึก...';
        const ok = await remote(open ? 'adminOpenCase' : 'adminReset', { plate: el.dataset.plate, reason });
        if (!ok) { el.disabled = false; el.textContent = open ? 'ยืนยันปรับเป็นเคส' : 'ยืนยันรีเซ็ตเป็นปกติ'; break; }
        closeModal();
        toast(open ? 'ปรับเป็นเคสแล้ว' : 'รีเซ็ตเป็นปกติแล้ว', `${el.dataset.plate} — ${reason}`);
        break;
      }
      case 'logout':
        if (await askConfirm('ออกจากระบบ', `ออกจากระบบทีม ${session ? session.team : ''} ใช่ไหม?`, 'ออกจากระบบ', true)) logout();
        break;
      case 'src-save': {
        const v = $('#srcUrl').value.trim();
        const m = /\/d\/([\w-]{20,})/.exec(v) || /^([\w-]{20,})$/.exec(v);
        if (!m) { $('#srcUrl').classList.add('invalid'); toast('ลิงก์ไม่ถูกต้อง', 'วางลิงก์ Google Sheet เช่น https://docs.google.com/spreadsheets/d/.../edit', 'danger'); break; }
        try { localStorage.setItem(KEY + '.src', JSON.stringify({ id: m[1] })); } catch (er) { /* ignore */ }
        location.hash = '#/dashboard';
        location.reload();
        break;
      }
      case 'src-clear':
        if (await askConfirm('เลิกใช้ Google Sheet นี้', 'เลิกใช้ Google Sheet นี้ และกลับไปโหมดสาธิต (ข้อมูลตัวอย่าง)?', 'เลิกใช้')) {
          try { localStorage.setItem(KEY + '.src', JSON.stringify({ id: '' })); } catch (er) { /* ignore */ }
          location.reload();
        }
        break;
      case 'api-refresh': if (await remote('state')) toast('โหลดข้อมูลแล้ว', 'ข้อมูลล่าสุดจาก Google Sheets'); break;
      case 'api-default':
        try { localStorage.setItem(KEY + '.api', JSON.stringify({ url: DEFAULT_API, token: '' })); } catch (er) { /* ignore */ }
        location.reload();
        break;
      case 'api-disconnect':
        if (await askConfirm('ยกเลิกการเชื่อมต่อ', 'ยกเลิกการเชื่อมต่อระบบบันทึกผล (Apps Script) และกลับไปโหมดดูข้อมูลอย่างเดียว? ข้อมูลในชีตไม่ถูกลบ', 'ยกเลิกการเชื่อมต่อ', true)) {
          try {
            localStorage.setItem(KEY + '.api', JSON.stringify({ url: '', token: '' }));
            localStorage.removeItem(KEY + '.sheets'); localStorage.removeItem(KEY + '.session');
          } catch (er) { /* ignore */ }
          location.reload();
        }
        break;
      case 'reset':
        if (isSheets()) break;
        if (await askConfirm('รีเซ็ตข้อมูลตัวอย่าง', 'ล้างข้อมูลทั้งหมดและสร้างข้อมูลตัวอย่างใหม่?', 'รีเซ็ต', true)) {
          const role = state.role;
          state = null; state = seedData(); state.role = role; save(); setupControls(); startSim(); render(); toast('รีเซ็ตแล้ว', 'สร้างข้อมูลตัวอย่างใหม่เรียบร้อย');
        }
        break;
      default: break;
    }
  });

  async function saveSettings() {
    const s = state.settings;
    const next = JSON.parse(JSON.stringify(s.thresholds));
    let bad = false;
    document.querySelectorAll('[data-th]').forEach((inp) => {
      const [k, f] = inp.dataset.th.split('.');
      const v = parseFloat(inp.value);
      if (isNaN(v)) bad = true; else next[k][f] = v;
    });
    Object.values(next).forEach((t) => { if (t.min >= t.max) bad = true; });
    const crit = parseFloat($('#sCrit').value);
    if (bad || !(crit > 0)) { toast('ค่าไม่ถูกต้อง', 'ค่าต่ำสุดต้องน้อยกว่าค่าสูงสุด และระดับวิกฤตต้องมากกว่า 0', 'danger'); return; }
    s.user = $('#sUser').value.trim() || 'admin';
    $('#userName').textContent = s.user;
    if (isSheets()) {
      if (!(await remote('settings', { thresholds: next, criticalDelta: crit }))) return;
    } else {
      s.thresholds = next; s.criticalDelta = crit;
    }
    save();
    toast('บันทึกการตั้งค่าแล้ว', 'เกณฑ์ใหม่จะใช้กับการแจ้งเตือนครั้งถัดไป');
    render();
  }

  document.addEventListener('change', async (e) => {
    const t = e.target;
    onInspFormChange(t);
    if (ui.reset && t.closest && t.closest('#modalCard')) {
      if (t.name === 'rsMode') { ui.reset.mode = t.value; renderResetBody(); return; }
      if (t.dataset && t.dataset.plate && t.type === 'checkbox') { if (t.checked) ui.reset.sel.add(t.dataset.plate); else ui.reset.sel.delete(t.dataset.plate); renderResetBody(); return; }
      if (t.id === 'rsDate') { ui.reset.date = t.value; renderResetBody(); return; }
    }
    if (t.id === 'fDc') { ui.dc = t.value; render(); }
    else if (t.id === 'fType') { ui.type = t.value; render(); }
    else if (t.id === 'fStatus') { ui.status = t.value; render(); }
    else if (t.id === 'periodSel') { ui.period = t.value; render(); }
    else if (t.id === 'roleSel') { state.role = t.value; if (t.value === 'ALL') ui.dc = ''; save(); syncDcFilter(); render(); toast('เปลี่ยนมุมมอง', t.value === 'ALL' ? 'แสดงข้อมูลทุก DC' : `แสดงเฉพาะ ${t.value}`); }
    else if (t.id === 'sSound') { state.settings.sound = t.checked; save(); if (t.checked) beep(1); }
    else if (t.id === 'sSim') { state.settings.sim = t.checked; save(); startSim(); render(); }
    else if (t.id === 'sDesktop') {
      if (t.checked && 'Notification' in window && Notification.permission !== 'granted') {
        const p = await Notification.requestPermission();
        if (p !== 'granted') { t.checked = false; toast('ไม่ได้รับสิทธิ์', 'เบราว์เซอร์ไม่อนุญาตการแจ้งเตือนบนเดสก์ท็อป', 'danger'); }
      }
      state.settings.desktop = t.checked; save(); render();
    } else if (t.id === 'importFile') {
      const file = t.files[0];
      t.value = '';
      importFile(file);
    } else if (t.id === 'photoInput') {
      const files = [...t.files].slice(0, 3 - ui.modalPhotos.length);
      for (const f of files) { try { ui.modalPhotos.push(await readImg(f)); } catch (er) { toast('อ่านรูปไม่สำเร็จ', f.name, 'danger'); } }
      $('#thumbs').innerHTML = ui.modalPhotos.map((p) => `<img src="${p}" alt="รูปประกอบ">`).join('');
      t.value = '';
    }
  });
  let qTimer;
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'rsQ' || !ui.reset) return;
    ui.reset.q = e.target.value;
    const pos = e.target.selectionStart;
    renderResetBody();
    const q = $('#rsQ'); if (q) { q.focus(); q.setSelectionRange(pos, pos); }
  });
  $('#fQ').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { ui.q = e.target.value.trim(); render(); }, 200); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (modal.classList.contains('open')) closeModal(); $('#bellPanel').classList.remove('open'); } });
  window.addEventListener('hashchange', route);
  document.addEventListener('dragover', (e) => { const z = e.target.closest && e.target.closest('#dropZone'); if (z) { e.preventDefault(); z.classList.add('over'); } });
  document.addEventListener('dragleave', (e) => { const z = e.target.closest && e.target.closest('#dropZone'); if (z) z.classList.remove('over'); });
  document.addEventListener('drop', (e) => {
    const z = e.target.closest && e.target.closest('#dropZone');
    if (!z) return;
    e.preventDefault();
    z.classList.remove('over');
    importFile(e.dataTransfer.files[0]);
  });

  // ---------- Boot ----------
  hydrateIcons();
  let savedTheme = null;
  try { savedTheme = localStorage.getItem(KEY + '.theme'); } catch (e) { /* ignore */ }
  applyTheme(savedTheme);
  setupControls();
  startSim();
  route();
  if (isSheets()) { if (session) refresh(); else showLogin(); }
  else if (isRO()) loadSheet();
  document.addEventListener('submit', (e) => { if (e.target.id === 'loginForm') { e.preventDefault(); submitLogin(); } });
  setInterval(renderBadges, 30000);
  window.TempWatch = { ingestReading, refresh, showLogin, state: () => state };
})();
