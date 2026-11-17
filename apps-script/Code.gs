/**
 * Temp Watch — Google Apps Script backend (ผูกกับ Google Sheet ฐานข้อมูล)
 *
 * แหล่งข้อมูล: ไฟล์ "รายงาน_Temperature_Dashboard_YYYYMMDDHHMMSS" จากระบบ GPS (อัปโหลดทุกวัน)
 *   - ชีต "รายคัน"            → อัปเดต Vehicles + ต่อท้ายทุกแถวลงชีต "ข้อมูลรายวัน" พร้อมวันที่ของข้อมูล
 *                               แถวที่ สถานะ (คอลัมน์ H) = "วิกฤต" → สร้างแจ้งเตือนให้ DC
 *   - ชีต "ประวัติเกินเกณฑ์"   → เก็บ Events (ตัดซ้ำ) และใช้หา DC / ใบรายการ ล่าสุดของรถแต่ละคัน
 *
 * ชีตฐานข้อมูล: Vehicles, Alerts, ข้อมูลรายวัน, Events, Imports, Thresholds, Config, DCs, Teams
 *
 * ขั้นตอนงาน: นำเข้า Excel → Dashboard → DC/BKK เห็นเคสของตัวเอง (เข้าระบบด้วย PIN ในชีต Teams)
 *   → ตรวจสอบกับ พขร. → บันทึกสาเหตุ (รถ/คน/ระบบ) + ปิดเคส (แก้ไขแล้ว / แก้ไขไม่ได้ + สาเหตุ) → Dashboard สรุปเป็นกราฟและ %
 *
 * API (Deploy > Web app, Execute as: Me, Who has access: Anyone)
 *   POST body (text/plain JSON): { session | token, action, ... }
 *   ไม่ต้องเข้าสู่ระบบ: teams | login
 *   ต้องเข้าสู่ระบบ:   state | history | ack | inspect | manual | import* | importLink* | settings** | reading(token)
 *   (* admin/central, ** admin)
 */

// S = ข้อมูลรายวัน: แถวจากชีต "รายคัน" ของทุกรายงาน ต่อท้ายกันไปเรื่อย ๆ พร้อม "วันที่ข้อมูล" (dataDate)
const SH = { V: 'Vehicles', A: 'Alerts', S: 'ข้อมูลรายวัน', E: 'Events', I: 'Imports', T: 'Thresholds', C: 'Config', D: 'DCs', TM: 'Teams' };
const LEGACY_S = 'Snapshots'; // ชื่อเดิมของชีต ข้อมูลรายวัน (เปลี่ยนชื่อให้อัตโนมัติ)
// ทีมผู้ใช้งาน: role = admin (ทุก DC + นำเข้า + ตั้งค่า) | central (DC ตามรายการ + นำเข้า) | dc (DC ตามรายการ)
const TM_COLS = ['team', 'pin', 'role', 'dcs', 'note'];
const CATEGORIES = ['รถ', 'คน', 'ระบบ'];
const CLOSURES = ['fixed', 'unfixed'];
const BKK_DEFAULT_DCS = '610 DC พุทธมณฑลสาย 3, 691 CDC บางนา, ไม่ระบุ DC';
const SESSION_HOURS = 12;
const V_COLS = ['plate', 'gpsId', 'group', 'vtype', 'owner', 'driver', 'phone', 'dc', 'status', 'tempF', 'tempC', 'overCont', 'parkOut', 'updated', 'reportFile'];
const A_COLS = ['id', 'time', 'plate', 'gpsId', 'dc', 'waybill', 'group', 'owner', 'driver', 'gpsStatus', 'tempF', 'tempC',
  'type', 'temp', 'min', 'max', 'kind', 'dev', 'severity', 'source', 'reportFile', 'location', 'status', 'ackAt', 'ackBy',
  'inspAt', 'inspBy', 'category', 'cause', 'driverCheck', 'actions', 'closure', 'unfixedReason', 'measured', 'note', 'photos', 'adminLog'];
const S_COLS = ['dataDate', 'reportTime', 'reportFile', 'plate', 'gpsId', 'group', 'vtype', 'owner', 'driver', 'phone',
  'status', 'tempF', 'tempC', 'overCont', 'parkOut', 'updated', 'dc'];
const E_COLS = ['plate', 'gpsId', 'group', 'start', 'end', 'minutes', 'seq', 'waybill', 'waybillType', 'dc', 'reportFile', 'dataDate'];
const I_COLS = ['at', 'reportFile', 'reportTime', 'source', 'by', 'vehicles', 'critical', 'newAlerts', 'updatedAlerts', 'newEvents', 'dataDate',
  'undoneAt', 'undoneBy', 'undoReason'];
const T_COLS = ['type', 'label', 'min', 'max'];
const C_COLS = ['key', 'value', 'note'];
const D_COLS = ['dc', 'email', 'note'];
// ใช้คำนวณว่าช่องไหนเกินและเกินเท่าไร (การสร้างแจ้งเตือนใช้สถานะ "วิกฤต" จากระบบ GPS)
const DEFAULT_T = [['Frozen', 'ช่องแช่แข็ง', -30, -8], ['Chilled', 'ช่องแช่เย็น', -2, 8]];
const NO_DC = 'ไม่ระบุ DC';
// สถานะในคอลัมน์ H (ชีต รายคัน) ที่ต้องเปิดเคสให้ DC — ระบบ GPS เปลี่ยนคำจาก "วิกฤต" เป็น "แจ้งเตือน" (รายงาน 17 พ.ย. 2569)
// แก้ได้ที่ชีต Config › CASE_STATUSES (คั่นด้วย ,)
const CASE_STATUSES_DEFAULT = 'วิกฤต, แจ้งเตือน';
function caseStatuses_() {
  const v = String(config_().CASE_STATUSES || CASE_STATUSES_DEFAULT);
  return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}
const OFFLINE_STATUS = ['ออฟไลน์', 'ปิดใช้งาน'];
const KEEP_DAYS = 90;

// หัวคอลัมน์ในไฟล์รายงาน GPS (จับคู่จากคำขึ้นต้น)
const VMAP = { plate: ['ทะเบียน'], gpsId: ['GPS'], group: ['กลุ่ม'], vtype: ['ประเภทรถ'], owner: ['ชนิดรถ'], driver: ['ชื่อ'],
  phone: ['เบอร์'], status: ['สถานะ'], tempF: ['Frozen'], tempC: ['Chilled'], overCont: ['เกินเกณฑ์'], parkOut: ['จอด'], updated: ['อัพเดท', 'อัปเดต'] };
const EMAP = { plate: ['ทะเบียน'], gpsId: ['GPS'], group: ['กลุ่ม'], start: ['เริ่ม'], end: ['กลับปกติ', 'สิ้นสุด'], minutes: ['ระยะเวลา'],
  seq: ['ครั้งที่'], waybill: ['ใบรายการ'], waybillType: ['ประเภทใบรายการ'], dc: ['DC'] };

// ===================== Web app entry points =====================

function doGet() {
  return out_({ ok: true, service: 'temp-watch', time: new Date().toISOString() });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'รูปแบบข้อมูลไม่ถูกต้อง (JSON)' }); }

  // ---- ไม่ต้องเข้าสู่ระบบ: รายชื่อทีม / เข้าสู่ระบบด้วย PIN
  try {
    if (body.action === 'teams') return out_({ ok: true, teams: teams_().filter((t) => t.pin).map((t) => t.team) });
    if (body.action === 'login') return out_(Object.assign({ ok: true }, login_(body.team, body.pin)));
  } catch (err) { return out_({ ok: false, error: String(err.message || err) }); }

  // ---- ตรวจสิทธิ์: session จากการ login หรือ API token (สำหรับระบบภายนอก = admin)
  const token = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  let me = null;
  if (token && body.token && body.token === token) me = { team: 'API', role: 'admin', dcs: ['*'] };
  else if (body.session) me = verify_(body.session);
  if (!me) return out_({ ok: false, code: 'auth', error: 'กรุณาเข้าสู่ระบบใหม่ (session หมดอายุหรือไม่ถูกต้อง)' });
  const need = (roles) => { if (roles.indexOf(me.role) < 0) throw new Error('ทีม ' + me.team + ' ไม่มีสิทธิ์ทำรายการนี้'); };

  const write = !['state', 'history'].includes(body.action);
  const lock = LockService.getScriptLock();
  if (write) lock.waitLock(30000);
  try {
    let extra = {};
    switch (body.action) {
      case 'state': break;
      case 'history': return out_(Object.assign({ ok: true }, history_(body.plate, me)));
      case 'ack': ack_(body, me); break;
      case 'inspect': inspect_(body, me); break;
      case 'manual': {
        const v = read_(SH.V).rows.find((o) => String(o.plate) === String(body.plate));
        if (!v || !canSee_(me, v.dc || NO_DC)) throw new Error('ไม่มีสิทธิ์แจ้งเตือนรถคันนี้');
        ingest_(body.plate, body.temp, body.time, 'manual', body.location, body.compartment);
        break;
      }
      case 'reading': { // จากระบบ GPS/Temp sensor โดยตรง (ต้องใช้ API token) — { plate, temp, compartment, time } หรือ { readings: [...] }
        need(['admin']);
        const list = Array.isArray(body.readings) ? body.readings : [body];
        const results = list.map((r) => {
          try { return { ok: true, plate: r.plate, alertId: ingest_(r.plate, r.temp, r.time, 'sensor', r.location, r.compartment) }; }
          catch (err) { return { ok: false, plate: r.plate, error: String(err.message || err) }; }
        });
        SpreadsheetApp.flush();
        return out_({ ok: true, results: results });
      }
      case 'import': need(['admin', 'central']); extra.import = importReport_(body.fileName, body.vehicles, body.events, 'upload', me.team); break;
      case 'importLink': need(['admin', 'central']); extra.import = importFromLink_(body.url, me.team); break;
      case 'settings': need(['admin']); saveSettings_(body); break;
      case 'adminOpenCase': need(['admin']); adminOpenCase_(body, me); break;
      case 'adminReset': need(['admin']); extra.reset = adminReset_(body, me); break;
      case 'undoImport': need(['admin']); extra.undo = undoImport_(body, me); break;
      default: return out_({ ok: false, error: 'unknown action: ' + body.action });
    }
    if (write) SpreadsheetApp.flush();
    return out_(Object.assign({ ok: true }, readState_(me), extra));
  } catch (err) {
    return out_({ ok: false, error: String(err.message || err) });
  } finally {
    if (write) lock.releaseLock();
  }
}

// ===================== Import daily GPS report =====================

/**
 * นำเข้ารายงาน 1 ไฟล์
 * @param fileName ชื่อไฟล์ (ใช้กันนำเข้าซ้ำ และอ่านเวลารายงานจากตัวเลขท้ายชื่อ)
 * @param vRows    ตาราง 2 มิติของชีต "รายคัน" (รวมหัวตาราง)
 * @param eRows    ตาราง 2 มิติของชีต "ประวัติเกินเกณฑ์" (รวมหัวตาราง) — ไม่บังคับ
 */
function importReport_(fileName, vRows, eRows, source, by) {
  fileName = String(fileName || '').trim();
  if (!fileName) throw new Error('ไม่มีชื่อไฟล์รายงาน');
  ensureSchema_();
  const V = mapRows_(vRows, VMAP, 'รายคัน').filter((v) => v.plate);
  if (!V.length) throw new Error('ไม่พบข้อมูลรถในชีต "รายคัน" (ต้องมีคอลัมน์ ทะเบียน และ สถานะ)');

  // เวลาของรายงาน: จากตัวเลขท้ายชื่อไฟล์ (YYYYMMDDHHMMSS) หรือ "อัพเดทล่าสุด" ที่ใหม่ที่สุดในชีต รายคัน
  // ถ้าชื่อไฟล์ไม่มีเวลา (เช่น ใช้ไฟล์ "Temperature" เดิมอัปเดตทุกวัน) จะต่อท้ายเวลาข้อมูลไว้ในชื่อ เพื่อกันนำเข้าซ้ำได้ถูกต้อง
  let maxUpd = 0;
  V.forEach((v) => { const d = toDate_(v.updated); if (d && d.getTime() > maxUpd) maxUpd = d.getTime(); });
  const nameTime = timeFromName_(fileName);
  if (!nameTime && maxUpd) fileName += ' · ข้อมูล ' + Utilities.formatDate(new Date(maxUpd), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm');
  // ไฟล์ที่เคยนำเข้าแล้ว = "ตรวจซ้ำ": ไม่ต่อข้อมูลรายวันซ้ำ แต่ตรวจสร้างเคสใหม่ตามกติกาปัจจุบัน (เช่น หลังเปลี่ยน CASE_STATUSES)
  const recheck = read_(SH.I).rows.some((o) => String(o.reportFile) === fileName && !o.undoneAt);
  const reportTime = nameTime || (maxUpd ? new Date(maxUpd) : new Date());
  // วันที่ของข้อมูล (00:00 เวลาไทย)
  const dataDate = bkkDay_(reportTime);
  const E = eRows && eRows.length ? mapRows_(eRows, EMAP, 'ประวัติเกินเกณฑ์').filter((e) => e.plate && e.start) : [];

  // ---- Events: ตัดรายการซ้ำ (ทะเบียน + เวลาเริ่ม)
  const et = read_(SH.E);
  const seen = new Set(et.rows.map((o) => o.plate + '|' + ms_(o.start)));
  const newEvents = [];
  E.forEach((e) => {
    const start = toDate_(e.start);
    if (!start) return;
    const key = e.plate + '|' + start.getTime();
    if (seen.has(key)) return;
    seen.add(key);
    newEvents.push({ plate: e.plate, gpsId: e.gpsId, group: e.group, start: start, end: toDate_(e.end) || '', minutes: num_(e.minutes),
      seq: num_(e.seq), waybill: String(e.waybill || ''), waybillType: e.waybillType, dc: String(e.dc || '').trim(), reportFile: fileName, dataDate: dataDate });
  });
  appendRows_(et, newEvents);

  // ---- DC / ใบรายการล่าสุดของรถแต่ละคัน (จากประวัติทั้งหมด)
  const lastDc = {};
  et.rows.concat(newEvents).forEach((e) => {
    const dc = String(e.dc || '').trim();
    if (!dc) return;
    const t = ms_(e.start) || 0;
    if (!lastDc[e.plate] || t > lastDc[e.plate].t) lastDc[e.plate] = { t: t, dc: dc, waybill: String(e.waybill || '') };
  });

  // ---- Vehicles: อัปเดตจากรายงานล่าสุด (รถที่ไม่มีในรายงานคงไว้ตามเดิม)
  const vt = read_(SH.V);
  const byPlate = {};
  vt.rows.forEach((o) => { byPlate[o.plate] = o; });
  V.forEach((v) => {
    const old = byPlate[v.plate] || {};
    byPlate[v.plate] = {
      plate: v.plate, gpsId: v.gpsId || old.gpsId || '', group: v.group || old.group || '', vtype: v.vtype || old.vtype || '',
      owner: v.owner || old.owner || '', driver: v.driver || old.driver || '', phone: v.phone || old.phone || '',
      dc: (lastDc[v.plate] && lastDc[v.plate].dc) || old.dc || '', status: String(v.status || '').trim(),
      tempF: num_(v.tempF), tempC: num_(v.tempC), overCont: v.overCont, parkOut: v.parkOut,
      updated: toDate_(v.updated) || '', reportFile: fileName,
    };
  });
  writeAll_(vt, Object.keys(byPlate).map((k) => byPlate[k]));

  // ---- ข้อมูลรายวัน: นำแถวทั้งหมดของชีต รายคัน มาต่อท้าย พร้อมวันที่ของข้อมูล (ข้ามถ้าเป็นการตรวจซ้ำ)
  if (!recheck) appendRows_(read_(SH.S), V.map((v) => ({
    dataDate: dataDate, reportTime: reportTime, reportFile: fileName, plate: v.plate, gpsId: v.gpsId, group: v.group,
    vtype: v.vtype, owner: v.owner, driver: v.driver, phone: v.phone, status: String(v.status || '').trim(),
    tempF: num_(v.tempF), tempC: num_(v.tempC), overCont: num_(v.overCont), parkOut: num_(v.parkOut),
    updated: toDate_(v.updated) || '', dc: byPlate[v.plate].dc,
  })));

  // ---- Alerts: สถานะอยู่ใน CASE_STATUSES (วิกฤต / แจ้งเตือน) → เปิดเคส (ถ้ามีเคสค้างของรถคันนี้อยู่ ให้อัปเดตค่าแทนการสร้างใหม่)
  const caseSt = caseStatuses_();
  const th = thresholds_();
  const crit = Number(config_().criticalDelta) || 5;
  const at = read_(SH.A);
  const openByPlate = {};
  at.rows.forEach((o) => { if (o.status !== 'resolved') openByPlate[o.plate] = o; });
  const created = [];
  let updated = 0;
  const critical = V.filter((v) => caseSt.indexOf(String(v.status || '').trim()) >= 0);
  critical.forEach((v) => {
    const veh = byPlate[v.plate];
    const c = compartment_(veh.tempF, veh.tempC, th, crit);
    const open = openByPlate[v.plate];
    if (open) {
      Object.assign(open, { tempF: veh.tempF, tempC: veh.tempC, gpsStatus: veh.status, reportFile: fileName });
      if (c.dev > Number(open.dev || 0)) Object.assign(open, c);
      if (!open.dc || open.dc === NO_DC) { open.dc = veh.dc || NO_DC; open.waybill = (lastDc[v.plate] || {}).waybill || open.waybill; }
      writeRow_(at, open);
      updated++;
      return;
    }
    created.push(Object.assign({
      id: nextId_(reportTime), time: reportTime, plate: v.plate, gpsId: veh.gpsId, dc: veh.dc || NO_DC,
      waybill: (lastDc[v.plate] || {}).waybill || '', group: veh.group, owner: veh.owner, driver: veh.driver,
      gpsStatus: veh.status, tempF: veh.tempF, tempC: veh.tempC, source: 'gps-report', reportFile: fileName, status: 'new',
    }, c));
  });
  appendRows_(at, created);

  // ---- DCs: เพิ่ม DC ใหม่ที่พบอัตโนมัติ
  const dt = read_(SH.D);
  const known = new Set(dt.rows.map((o) => String(o.dc)));
  const newDcs = [];
  Object.keys(byPlate).forEach((k) => { const d = byPlate[k].dc; if (d && !known.has(d)) { known.add(d); newDcs.push({ dc: d, email: '', note: 'เพิ่มอัตโนมัติจากรายงาน' }); } });
  appendRows_(dt, newDcs);
  // ทีมของ DC ใหม่: สร้างให้อัตโนมัติพร้อม PIN สุ่ม 6 หลัก (ดู/แก้ PIN ได้ที่ชีต Teams)
  const tt = read_(SH.TM);
  const haveTeam = new Set(tt.rows.map((o) => String(o.team).trim()));
  appendRows_(tt, newDcs.filter((d) => !haveTeam.has(d.dc)).map((d) => ({ team: d.dc, pin: randomPin_(), role: 'dc', dcs: d.dc, note: 'สร้างอัตโนมัติ' })));

  const summary = { reportFile: fileName, reportTime: reportTime.getTime(), vehicles: V.length, critical: critical.length,
    newAlerts: created.length, updatedAlerts: updated, newEvents: newEvents.length };
  append_(read_(SH.I), Object.assign({ at: new Date(), source: (recheck ? 'ตรวจซ้ำ · ' : '') + (source || 'upload'), by: by || '' }, summary, { reportTime: reportTime, dataDate: dataDate }));
  summary.dataDate = dataDate.getTime();
  summary.recheck = recheck;
  summary.caseStatuses = caseSt;
  summary.dailyRows = recheck ? 0 : V.length;
  try { notifyDigest_(created, fileName); } catch (err) { console.warn('ส่งอีเมลไม่สำเร็จ: ' + err); }
  return summary;
}

/** นำเข้าจากลิงก์ Google Sheet ของรายงาน (ไฟล์ที่อัปโหลดเข้า Drive แล้ว) */
function importFromLink_(url, by) {
  const m = /\/d\/([\w-]{20,})/.exec(String(url || '')) || /^([\w-]{20,})$/.exec(String(url || '').trim());
  if (!m) throw new Error('ลิงก์ Google Sheet ไม่ถูกต้อง');
  let src;
  try { src = SpreadsheetApp.openById(m[1]); } catch (err) { throw new Error('เปิดไฟล์ไม่ได้ — บัญชีที่ Deploy Apps Script ต้องมีสิทธิ์เข้าถึงไฟล์นี้'); }
  const find = (key) => src.getSheets().find((s) => s.getName().indexOf(key) >= 0);
  const vs = find('รายคัน');
  if (!vs) throw new Error('ไม่พบชีต "รายคัน" ในไฟล์ ' + src.getName());
  const es = find('ประวัติเกินเกณฑ์');
  return importReport_(src.getName(), vs.getDataRange().getValues(), es ? es.getDataRange().getValues() : [], 'link', by);
}

/** หา compartment ที่เกินเกณฑ์มากที่สุด เพื่อแสดงค่าเบี่ยงเบน */
function compartment_(tempF, tempC, th, crit) {
  const dev = (t, k) => (t == null || !th[k] ? -1 : t > th[k].max ? t - th[k].max : t < th[k].min ? th[k].min - t : 0);
  const dF = dev(tempF, 'Frozen'), dC = dev(tempC, 'Chilled');
  const type = dC > dF ? 'Chilled' : 'Frozen';
  const temp = type === 'Chilled' ? tempC : tempF;
  const t = th[type] || { min: 0, max: 0 };
  const d = r1_(Math.max(0, type === 'Chilled' ? dC : dF));
  return { type: type, temp: temp, min: t.min, max: t.max, dev: d, kind: temp != null && temp < t.min ? 'low' : 'high',
    severity: d >= crit ? 'critical' : 'warning' };
}

function history_(plate, me) {
  plate = String(plate || '');
  const v = read_(SH.V).rows.find((o) => String(o.plate) === plate);
  if (!v || !canSee_(me, String(v.dc || '') || NO_DC)) throw new Error('ไม่มีสิทธิ์ดูข้อมูลรถคันนี้');
  const since = Date.now() - 60 * 864e5;
  const snapshots = read_(SH.S).rows.filter((o) => String(o.plate) === plate && (ms_(o.reportTime) || 0) >= since)
    .map((o) => ({ time: ms_(o.reportTime), status: String(o.status), tempF: num_(o.tempF), tempC: num_(o.tempC), updated: ms_(o.updated) }))
    .sort((a, b) => a.time - b.time);
  const events = read_(SH.E).rows.filter((o) => String(o.plate) === plate)
    .map((o) => ({ start: ms_(o.start), end: ms_(o.end), minutes: num_(o.minutes), waybill: String(o.waybill || ''), waybillType: String(o.waybillType || ''), dc: String(o.dc || '') }))
    .sort((a, b) => b.start - a.start).slice(0, 30);
  return { plate: plate, snapshots: snapshots, events: events };
}

// ===================== Actions =====================

function findAlert_(t, id, me) {
  const a = t.rows.find((o) => String(o.id) === String(id));
  if (!a) throw new Error('ไม่พบเคส ' + id);
  if (!canSee_(me, String(a.dc || '') || NO_DC)) throw new Error('ทีม ' + me.team + ' ไม่มีสิทธิ์ในเคสของ ' + a.dc);
  return a;
}

function ack_(b, me) {
  const t = read_(SH.A);
  const a = findAlert_(t, b.id, me);
  if (a.status !== 'new') return; // มีคนรับทราบไปแล้ว
  a.status = 'ack';
  a.ackAt = new Date();
  a.ackBy = String(b.by || me.team).trim();
  writeRow_(t, a);
}

/** บันทึกผลการตรวจสอบ + ปิดเคส: หมวดสาเหตุ (รถ/คน/ระบบ), ผลสอบถาม พขร., การปิดเคส (แก้ไขแล้ว / แก้ไขไม่ได้ + สาเหตุ) */
function inspect_(b, me) {
  const i = b.inspection || {};
  const miss = [];
  if (!String(i.by || '').trim()) miss.push('ผู้บันทึก');
  if (CATEGORIES.indexOf(i.category) < 0) miss.push('หมวดสาเหตุ (รถ/คน/ระบบ)');
  if (!String(i.cause || '').trim()) miss.push('สาเหตุ');
  if (!String(i.driverCheck || '').trim()) miss.push('ผลการตรวจสอบกับพนักงานขับรถ');
  if (CLOSURES.indexOf(i.closure) < 0) miss.push('การปิดเคส');
  if (i.closure === 'unfixed' && !String(i.unfixedReason || '').trim()) miss.push('สาเหตุที่แก้ไขไม่ได้');
  if (i.measured !== '' && i.measured != null && !isFinite(Number(i.measured))) miss.push('อุณหภูมิวัดซ้ำ (ตัวเลข)');
  if (miss.length) throw new Error('ข้อมูลไม่ครบ: ' + miss.join(', '));
  const t = read_(SH.A);
  const a = findAlert_(t, b.id, me);
  if (a.status === 'resolved') throw new Error('เคสนี้ถูกบันทึกผลและปิดไปแล้ว');
  const inspAt = i.at ? new Date(i.at) : new Date();
  if (!a.ackAt) { a.ackAt = inspAt; a.ackBy = i.by; }
  Object.assign(a, {
    status: 'resolved', inspAt: inspAt, inspBy: String(i.by).trim().indexOf(me.team) >= 0 || me.team === 'API' ? String(i.by).trim() : String(i.by).trim() + ' (' + me.team + ')', category: i.category, cause: String(i.cause).trim(),
    driverCheck: String(i.driverCheck).trim(), actions: (i.actions || []).join('\n'), closure: i.closure,
    unfixedReason: i.closure === 'unfixed' ? String(i.unfixedReason).trim() : '',
    measured: i.measured === '' || i.measured == null ? '' : Number(i.measured), note: i.note || '',
    photos: savePhotos_(i.photos || [], a.id).join('\n'),
  });
  writeRow_(t, a);
}

// ===================== Admin: เปิดเคสเอง / รีเซ็ตเป็นปกติ (ต้องระบุเหตุผล) =====================

function adminReason_(b) {
  const r = String(b.reason || '').trim();
  if (r.length < 3) throw new Error('กรุณาระบุเหตุผล');
  return r;
}
function stamp_(me, text) {
  return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm') + ' ' + me.team + ': ' + text;
}

/** เปิดเคสให้รถคันนี้ (แม้สถานะในไฟล์จะไม่ใช่วิกฤต) */
function adminOpenCase_(b, me) {
  const reason = adminReason_(b);
  addCols_(SH.A, A_COLS);
  const v = read_(SH.V).rows.find((o) => String(o.plate) === String(b.plate));
  if (!v) throw new Error('ไม่พบรถ: ' + b.plate);
  const at = read_(SH.A);
  if (at.rows.some((o) => String(o.plate) === String(v.plate) && o.status !== 'resolved')) throw new Error('รถคันนี้มีเคสที่ยังไม่ปิดอยู่แล้ว');
  const now = new Date();
  const c = compartment_(num_(v.tempF), num_(v.tempC), thresholds_(), Number(config_().criticalDelta) || 5);
  append_(at, Object.assign({
    id: nextId_(now), time: now, plate: v.plate, gpsId: v.gpsId, dc: v.dc || NO_DC, group: v.group, owner: v.owner, driver: v.driver,
    gpsStatus: v.status, tempF: num_(v.tempF), tempC: num_(v.tempC), source: 'admin', reportFile: v.reportFile, status: 'new',
    adminLog: stamp_(me, 'เปิดเป็นเคส — ' + reason),
  }, c));
}

/**
 * รีเซ็ตเป็น "ปกติ": ปิดเคสที่ค้าง (closure = reset) และตั้งสถานะรถเป็น ปกติ จนกว่าจะนำเข้ารายงานครั้งถัดไป
 * เลือกได้ 3 แบบ: { plates: [...] } รายคัน | { all: true } ทั้งหมด | { date: 'yyyy-MM-dd' } เคสของวันที่ข้อมูลนั้น
 */
function adminReset_(b, me) {
  const reason = adminReason_(b);
  addCols_(SH.A, A_COLS);
  const at = read_(SH.A);
  const vt = read_(SH.V);
  const caseSt = caseStatuses_();
  const isOpen = (o) => o.status !== 'resolved';
  let caseMatch, plates, label;
  if (b.all) {
    caseMatch = isOpen;
    plates = new Set(vt.rows.filter((v) => caseSt.indexOf(String(v.status).trim()) >= 0).map((v) => String(v.plate)));
    label = 'รีเซ็ตทั้งหมด';
  } else if (b.date) {
    const p = String(b.date).split('-').map(Number);
    if (p.length !== 3 || p.some(isNaN)) throw new Error('วันที่ไม่ถูกต้อง');
    const t0 = bkk_(p[0], p[1], p[2], 0, 0, 0).getTime(), t1 = t0 + 864e5;
    caseMatch = (o) => { const t = ms_(o.time) || 0; return isOpen(o) && t >= t0 && t < t1; };
    plates = new Set();
    label = 'รีเซ็ตเคสวันที่ ' + b.date;
  } else {
    const list = (Array.isArray(b.plates) ? b.plates : [b.plate]).map(String).filter(Boolean);
    if (!list.length) throw new Error('กรุณาเลือกทะเบียนรถ');
    plates = new Set(list);
    caseMatch = (o) => isOpen(o) && plates.has(String(o.plate));
    label = 'รีเซ็ตรายคัน';
  }
  const now = new Date();
  const log = stamp_(me, label + ' — ' + reason);
  let cases = 0;
  at.rows.forEach((o) => {
    if (!caseMatch(o)) return;
    Object.assign(o, {
      status: 'resolved', inspAt: now, inspBy: me.team + ' (ผู้ดูแล)', closure: 'reset', unfixedReason: '',
      note: 'รีเซ็ตเป็นปกติ: ' + reason, adminLog: [String(o.adminLog || ''), log].filter(String).join('\n'),
    });
    if (!o.ackAt) { o.ackAt = now; o.ackBy = me.team; }
    plates.add(String(o.plate));
    cases++;
  });
  let vehicles = 0;
  vt.rows.forEach((v) => { if (plates.has(String(v.plate)) && String(v.status) !== 'ปกติ') { v.status = 'ปกติ'; vehicles++; } });
  if (!cases && !vehicles) throw new Error('ไม่มีรถหรือเคสที่ต้องรีเซ็ตตามที่เลือก');
  // เขียนทั้งชีตครั้งเดียว (เร็วกว่าเขียนทีละแถวเมื่อรีเซ็ตจำนวนมาก)
  if (cases) writeAll_(at, at.rows);
  if (vehicles) writeAll_(vt, vt.rows);
  return { cases: cases, vehicles: vehicles };
}

/**
 * ยกเลิกการนำเข้ารายงาน 1 ไฟล์ (ผู้ดูแล):
 *  - ลบแถวของไฟล์นี้ในชีต ข้อมูลรายวัน และ Events
 *  - ลบเคสที่ไฟล์นี้สร้างขึ้นและยังไม่มีใครแตะ (รอรับทราบ) — เคสที่รับทราบ/บันทึกผลแล้วเก็บไว้
 *  - ถ้าเป็นการนำเข้าล่าสุด: คืนชีต Vehicles เป็นข้อมูลจากรายงานก่อนหน้า
 *  - ทำเครื่องหมาย "ยกเลิกแล้ว" ในชีต Imports (นำเข้าไฟล์นี้ใหม่ได้)
 */
function undoImport_(b, me) {
  const reason = adminReason_(b);
  ensureSchema_();
  const file = String(b.reportFile || '');
  const it = read_(SH.I);
  const rows = it.rows.filter((o) => String(o.reportFile) === file && !o.undoneAt);
  if (!rows.length) throw new Error('ไม่พบการนำเข้านี้ หรือถูกยกเลิกไปแล้ว');
  const rt = ms_(rows[0].reportTime);
  const others = it.rows.filter((o) => String(o.reportFile) !== file && !o.undoneAt);
  // "ล่าสุด" ตัดสินจากลำดับที่นำเข้า (เวลา at) — ไม่ใช้ reportTime เพราะไฟล์เก่าบางไฟล์บันทึกเวลารายงานผิด
  const lastAt = Math.max.apply(null, rows.map((o) => ms_(o.at) || 0));
  const isLatest = others.every((o) => (ms_(o.at) || 0) <= lastAt);

  const st = read_(SH.S);
  const keepS = st.rows.filter((o) => String(o.reportFile) !== file);
  const daily = st.rows.length - keepS.length;
  if (daily) writeAll_(st, keepS);

  const et = read_(SH.E);
  const keepE = et.rows.filter((o) => String(o.reportFile) !== file);
  const events = et.rows.length - keepE.length;
  if (events) writeAll_(et, keepE);

  const at = read_(SH.A);
  let removed = 0, kept = 0;
  const keepA = at.rows.filter((o) => {
    const created = String(o.reportFile) === file && String(o.source) === 'gps-report' && ms_(o.time) === rt;
    if (!created) return true;
    if (o.status === 'new' && !o.ackAt && !o.inspAt) { removed++; return false; }
    kept++;
    return true;
  });
  if (removed) writeAll_(at, keepA);

  // ทำเครื่องหมายยกเลิกก่อน แล้วค่อยคืนสถานะรถจากการนำเข้าที่ยังใช้งานอยู่
  const now = new Date();
  rows.forEach((o) => { o.undoneAt = now; o.undoneBy = me.team; o.undoReason = reason; writeRow_(it, o); });

  let vehiclesFrom = '';
  if (isLatest) vehiclesFrom = restoreFromLatestImport_(file);
  return { reportFile: file, daily: daily, events: events, alertsRemoved: removed, alertsKept: kept, vehiclesFrom: vehiclesFrom, restoredVehicles: isLatest };
}

/**
 * คืนสถานะรถ (Vehicles) และค่าในเคสที่ยังไม่ปิด ให้เป็นข้อมูลจาก "การนำเข้าล่าสุดที่ยังไม่ถูกยกเลิก" (เรียงตามเวลาที่นำเข้า)
 * @param undoneFile ไฟล์ที่เพิ่งยกเลิก — เคสที่ถูกไฟล์นี้อัปเดตค่าไว้ จะถูกคืนค่าจากรายงานก่อนหน้า
 * @return ชื่อไฟล์ที่ใช้คืนค่า ('' ถ้าไม่มีการนำเข้าเหลือ)
 */
function restoreFromLatestImport_(undoneFile) {
  const active = read_(SH.I).rows.filter((o) => !o.undoneAt).sort((x, y) => (ms_(y.at) || 0) - (ms_(x.at) || 0));
  const prev = active[0];
  const vt = read_(SH.V);
  if (!prev) { writeAll_(vt, []); return ''; }
  const prevFile = String(prev.reportFile);
  const src = read_(SH.S).rows.filter((o) => String(o.reportFile) === prevFile);
  if (!src.length) throw new Error('ไม่พบข้อมูลรายวันของรายงาน ' + prevFile + ' จึงคืนสถานะรถไม่ได้');
  // รายละเอียดรถที่รายงานเก่าไม่มี (กลุ่ม/ประเภท/คนขับ ฯลฯ) ใช้ค่าเดิมในชีต Vehicles
  const old = {};
  vt.rows.forEach((o) => { old[String(o.plate)] = o; });
  const keep = (o, k) => (o[k] !== '' && o[k] != null ? o[k] : (old[String(o.plate)] || {})[k] || '');
  const bySrc = {};
  writeAll_(vt, src.map((o) => {
    bySrc[String(o.plate)] = o;
    return {
      plate: o.plate, gpsId: keep(o, 'gpsId'), group: keep(o, 'group'), vtype: keep(o, 'vtype'), owner: keep(o, 'owner'),
      driver: keep(o, 'driver'), phone: keep(o, 'phone'), dc: keep(o, 'dc'), status: o.status, tempF: o.tempF, tempC: o.tempC,
      overCont: o.overCont, parkOut: o.parkOut, updated: o.updated, reportFile: prevFile,
    };
  }));
  if (undoneFile) {
    const at = read_(SH.A);
    let changed = false;
    at.rows.forEach((a) => {
      const p = bySrc[String(a.plate)];
      if (a.status === 'resolved' || String(a.reportFile) !== String(undoneFile) || !p) return;
      Object.assign(a, { gpsStatus: p.status, tempF: p.tempF, tempC: p.tempC, reportFile: prevFile });
      changed = true;
    });
    if (changed) writeAll_(at, at.rows);
  }
  return prevFile;
}

/** เมนู: คืนสถานะรถตามการนำเข้าล่าสุดที่ยังไม่ถูกยกเลิก (ใช้แก้ข้อมูลหลังยกเลิกการนำเข้าด้วยโค้ดรุ่นก่อน) */
function rebuildVehicles() {
  const undone = read_(SH.I).rows.filter((o) => o.undoneAt).map((o) => String(o.reportFile));
  const file = restoreFromLatestImport_('');
  // คืนค่าในเคสที่ยังไม่ปิด ซึ่งถูกไฟล์ที่ยกเลิกแล้วอัปเดตไว้
  undone.forEach((f) => restoreFromLatestImport_(f));
  SpreadsheetApp.getUi().alert(file ? 'คืนสถานะรถตามรายงาน: ' + file : 'ไม่มีการนำเข้าที่ใช้งานอยู่ — ล้างสถานะรถแล้ว');
}

/** รับค่าอุณหภูมิ 1 ค่า (แจ้งด้วยตนเอง / sensor API) — สร้างแจ้งเตือนถ้าเกินเกณฑ์ของช่องนั้น */
function ingest_(plate, temp, time, source, location, compartment) {
  if (temp === '' || temp == null || !isFinite(Number(temp))) throw new Error('ค่าอุณหภูมิไม่ถูกต้อง');
  temp = Number(temp);
  const type = compartment === 'Chilled' ? 'Chilled' : 'Frozen';
  const vt = read_(SH.V);
  const v = vt.rows.find((o) => String(o.plate) === String(plate));
  if (!v) throw new Error('ไม่พบรถ: ' + plate);
  const when = time ? new Date(time) : new Date();
  v[type === 'Chilled' ? 'tempC' : 'tempF'] = temp;
  v.updated = when;
  writeRow_(vt, v);

  const t = thresholds_()[type];
  if (!t) throw new Error('ไม่มีเกณฑ์อุณหภูมิสำหรับ ' + type + ' (ชีต Thresholds)');
  if (temp >= t.min && temp <= t.max) return null;
  const high = temp > t.max;
  const dev = r1_(high ? temp - t.max : t.min - temp);
  const c = { type: type, temp: temp, min: t.min, max: t.max, dev: dev, kind: high ? 'high' : 'low',
    severity: dev >= (Number(config_().criticalDelta) || 5) ? 'critical' : 'warning' };

  const at = read_(SH.A);
  const open = at.rows.find((o) => String(o.plate) === String(v.plate) && o.status !== 'resolved');
  if (open) {
    if (dev > Number(open.dev || 0)) { Object.assign(open, c); writeRow_(at, open); }
    return String(open.id);
  }
  const a = Object.assign({
    id: nextId_(when), time: when, plate: v.plate, gpsId: v.gpsId, dc: v.dc || NO_DC, group: v.group, owner: v.owner,
    driver: v.driver, gpsStatus: v.status, tempF: v.tempF, tempC: v.tempC, source: source || 'sensor', location: location || '', status: 'new',
  }, c);
  append_(at, a);
  try { notifyDigest_([a]); } catch (err) { console.warn('ส่งอีเมลไม่สำเร็จ: ' + err); }
  return a.id;
}

function saveSettings_(b) {
  const th = b.thresholds || {};
  const t = read_(SH.T);
  t.rows.forEach((o) => {
    const n = th[o.type];
    if (!n) return;
    if (!(Number(n.min) < Number(n.max))) throw new Error('เกณฑ์ ' + o.type + ': ค่าต่ำสุดต้องน้อยกว่าค่าสูงสุด');
    o.min = Number(n.min); o.max = Number(n.max);
    writeRow_(t, o);
  });
  if (b.criticalDelta != null) setConfig_('criticalDelta', Number(b.criticalDelta));
}

// ===================== Notifications =====================

/** ส่งอีเมล 1 ฉบับต่อ DC รวมรถวิกฤตทุกคันของ DC นั้น */
function notifyDigest_(alerts, fileName) {
  if (!alerts.length) return;
  const cfg = config_();
  if (String(cfg.EMAIL_ALERTS).toUpperCase() === 'FALSE') return;
  const emails = {};
  read_(SH.D).rows.forEach((o) => { if (o.email) (emails[o.dc] = emails[o.dc] || []).push(String(o.email).trim()); });
  const byDc = {};
  alerts.forEach((a) => { (byDc[a.dc] = byDc[a.dc] || []).push(a); });
  Object.keys(byDc).forEach((dc) => {
    const to = (emails[dc] || []).join(',');
    if (!to) return;
    const list = byDc[dc];
    const rows = list.map((a) => '<tr><td><b>' + a.plate + '</b></td><td>' + (a.tempF == null ? '-' : a.tempF) + '</td><td>' + (a.tempC == null ? '-' : a.tempC) +
      '</td><td>' + (a.waybill || '-') + '</td><td>' + (a.driver || '-') + '</td></tr>').join('');
    MailApp.sendEmail({
      to: to,
      subject: '[แจ้งเตือนอุณหภูมิ] ' + dc + ' — รถที่ต้องตรวจสอบ ' + list.length + ' คัน',
      htmlBody: '<p>รถต่อไปนี้มีสถานะ <b style="color:#a3153f">วิกฤต</b>' + (fileName ? ' จากรายงาน ' + fileName : '') + ' กรุณาตรวจสอบและบันทึกผล</p>' +
        '<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>ทะเบียน</th><th>Frozen (°C)</th><th>Chilled (°C)</th><th>ใบรายการ</th><th>พขร.</th></tr>' + rows + '</table>' +
        (cfg.APP_URL ? '<p><a href="' + cfg.APP_URL + '">เปิดระบบ Temp Watch เพื่อรับทราบ / บันทึกผล</a></p>' : ''),
    });
  });
}

// ===================== Read state for the web app =====================

function readState_(me) {
  const since = Date.now() - KEEP_DAYS * 864e5;
  const vehicles = read_(SH.V).rows.filter((o) => canSee_(me, String(o.dc || '') || NO_DC)).map((o) => {
    const status = String(o.status || '');
    const tempF = num_(o.tempF);
    return {
      id: String(o.plate), plate: String(o.plate), prov: '', gpsId: String(o.gpsId || ''), group: String(o.group || ''),
      vtype: String(o.vtype || ''), owner: String(o.owner || ''), driver: String(o.driver || ''), phone: String(o.phone || ''),
      dc: String(o.dc || '') || NO_DC, gpsStatus: status, tempF: tempF, tempC: num_(o.tempC), overCont: num_(o.overCont),
      type: 'Frozen', temp: tempF, updated: ms_(o.updated), online: OFFLINE_STATUS.indexOf(status) < 0,
    };
  });
  const alerts = read_(SH.A).rows.map(alertOut_).filter((a) => canSee_(me, a.dc) && (a.status !== 'resolved' || a.time >= since));
  const dcSet = {};
  read_(SH.D).rows.forEach((o) => { if (o.dc && canSee_(me, String(o.dc))) dcSet[String(o.dc)] = 1; });
  vehicles.forEach((v) => { dcSet[v.dc] = 1; });
  alerts.forEach((a) => { dcSet[a.dc] = 1; });
  const canImport = me.role === 'admin' || me.role === 'central';
  const imports = !canImport ? [] : read_(SH.I).rows.slice(-20).reverse().map((o) => ({
    at: ms_(o.at), reportFile: String(o.reportFile), reportTime: ms_(o.reportTime), source: String(o.source || ''), by: String(o.by || ''),
    vehicles: num_(o.vehicles), critical: num_(o.critical), newAlerts: num_(o.newAlerts), updatedAlerts: num_(o.updatedAlerts), newEvents: num_(o.newEvents),
    undoneAt: ms_(o.undoneAt), undoneBy: String(o.undoneBy || ''), undoReason: String(o.undoReason || ''),
  }));
  return {
    settings: { thresholds: thresholds_(), criticalDelta: Number(config_().criticalDelta) || 5 },
    dcs: Object.keys(dcSet).sort((a, b) => (a === NO_DC) - (b === NO_DC) || a.localeCompare(b, 'th')),
    vehicles: vehicles, alerts: alerts, imports: imports,
    me: { team: me.team, role: me.role, dcs: me.dcs, canImport: canImport },
  };
}

function alertOut_(o) {
  const a = {
    id: String(o.id), time: ms_(o.time), vehicleId: String(o.plate), plate: String(o.plate), prov: '', gpsId: String(o.gpsId || ''),
    dc: String(o.dc || '') || NO_DC, waybill: String(o.waybill || ''), group: String(o.group || ''), owner: String(o.owner || ''),
    driver: String(o.driver || ''), gpsStatus: String(o.gpsStatus || ''), tempF: num_(o.tempF), tempC: num_(o.tempC),
    type: String(o.type || 'Frozen'), temp: num_(o.temp), min: num_(o.min), max: num_(o.max), kind: String(o.kind || 'high'),
    dev: num_(o.dev) || 0, severity: String(o.severity || 'warning'), source: String(o.source || ''), reportFile: String(o.reportFile || ''),
    location: String(o.location || ''), status: String(o.status || 'new'), ackAt: ms_(o.ackAt), ackBy: o.ackBy ? String(o.ackBy) : null, inspection: null,
    adminLog: String(o.adminLog || ''),
  };
  if (a.status === 'resolved') {
    a.inspection = {
      at: ms_(o.inspAt) || a.ackAt || a.time, by: String(o.inspBy || ''), category: String(o.category || ''),
      cause: String(o.cause || ''), driverCheck: String(o.driverCheck || ''), actions: String(o.actions || '').split('\n').filter(String),
      closure: String(o.closure || ''), unfixedReason: String(o.unfixedReason || ''), measured: num_(o.measured),
      note: String(o.note || ''), photos: String(o.photos || '').split('\n').filter(String),
    };
  }
  return a;
}

// ===================== Teams / PIN login =====================

function teams_() {
  return read_(SH.TM).rows.map((o) => ({
    team: String(o.team).trim(), pin: String(o.pin == null ? '' : o.pin).trim(),
    role: String(o.role || 'dc').trim().toLowerCase(),
    dcs: String(o.dcs || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
  })).filter((t) => t.team);
}
const canSee_ = (me, dc) => !!me && (me.dcs.indexOf('*') >= 0 || me.dcs.indexOf(String(dc || NO_DC)) >= 0);
function secret_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty('SESSION_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('SESSION_SECRET', s); }
  return s;
}
function hmac_(v) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(v, secret_(), Utilities.Charset.UTF_8));
}
function login_(team, pin) {
  team = String(team || '').trim();
  const cache = CacheService.getScriptCache();
  const key = 'fail:' + Utilities.base64EncodeWebSafe(team, Utilities.Charset.UTF_8).slice(0, 200);
  const fails = Number(cache.get(key) || 0);
  if (fails >= 5) throw new Error('ใส่ PIN ผิดเกิน 5 ครั้ง กรุณารอ 10 นาทีแล้วลองใหม่');
  const t = teams_().find((x) => x.team === team);
  if (!t || !t.pin || String(pin || '').trim() !== t.pin) {
    cache.put(key, String(fails + 1), 600);
    throw new Error('ทีมหรือ PIN ไม่ถูกต้อง');
  }
  cache.remove(key);
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  const payload = Utilities.base64EncodeWebSafe(t.team + '|' + exp, Utilities.Charset.UTF_8);
  return { session: payload + '.' + hmac_(payload), team: t.team, role: t.role, dcs: t.dcs, exp: exp };
}
function verify_(session) {
  const parts = String(session || '').split('.');
  if (parts.length !== 2 || hmac_(parts[0]) !== parts[1]) return null;
  const raw = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString('UTF-8');
  const i = raw.lastIndexOf('|');
  const team = raw.slice(0, i), exp = Number(raw.slice(i + 1));
  if (!(exp > Date.now())) return null;
  const t = teams_().find((x) => x.team === team);
  return t && t.pin ? { team: t.team, role: t.role, dcs: t.dcs } : null; // ลบทีม/ล้าง PIN = ตัดสิทธิ์ทันที
}
function randomPin_() { return String(Math.floor(100000 + Math.random() * 900000)); }

// ===================== Sheet helpers =====================

function ss_() { return SpreadsheetApp.getActive(); }
function tz_() { return ss_().getSpreadsheetTimeZone(); }
function sheet_(name) {
  const s = ss_().getSheetByName(name);
  if (!s) throw new Error('ไม่พบชีต "' + name + '" — กรุณารันฟังก์ชัน setup() ก่อน');
  return s;
}
function read_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const head = (values.shift() || []).map(String);
  const rows = [];
  values.forEach((r, i) => {
    const o = {};
    head.forEach((h, j) => { o[h] = r[j]; });
    o._row = i + 2;
    if (head.some((h) => o[h] !== '' && o[h] != null)) rows.push(o);
  });
  return { sh: sh, head: head, rows: rows };
}
const rowOf_ = (t, o) => t.head.map((h) => (o[h] == null ? '' : o[h]));
function writeRow_(t, o) { t.sh.getRange(o._row, 1, 1, t.head.length).setValues([rowOf_(t, o)]); }
function append_(t, o) { t.sh.appendRow(rowOf_(t, o)); }
function appendRows_(t, list) {
  if (!list.length) return;
  t.sh.getRange(t.sh.getLastRow() + 1, 1, list.length, t.head.length).setValues(list.map((o) => rowOf_(t, o)));
}
function writeAll_(t, list) {
  const last = t.sh.getLastRow();
  if (last > 1) t.sh.getRange(2, 1, last - 1, t.head.length).clearContent();
  if (list.length) t.sh.getRange(2, 1, list.length, t.head.length).setValues(list.map((o) => rowOf_(t, o)));
}
/** แปลงตารางจากไฟล์รายงานเป็น object ตามหัวคอลัมน์ */
function mapRows_(rows, spec, sheetName) {
  const hi = rows.slice(0, 10).findIndex((r) => r.some((c) => String(c).indexOf('ทะเบียน') === 0));
  if (hi < 0) throw new Error('ไม่พบหัวตาราง (คอลัมน์ ทะเบียน) ในชีต "' + sheetName + '"');
  const head = rows[hi].map((c) => String(c).trim());
  const idx = {};
  Object.keys(spec).forEach((k) => {
    let j = head.findIndex((h) => spec[k].some((p) => h.indexOf(p) === 0));
    if (j < 0) j = head.findIndex((h) => spec[k].some((p) => h.indexOf(p) >= 0));
    idx[k] = j;
  });
  return rows.slice(hi + 1).map((r) => {
    const o = {};
    Object.keys(idx).forEach((k) => { const v = idx[k] >= 0 ? r[idx[k]] : ''; o[k] = typeof v === 'string' ? v.trim() : v; });
    o.plate = String(o.plate == null ? '' : o.plate).trim();
    return o;
  });
}
function thresholds_() {
  const out = {};
  read_(SH.T).rows.forEach((o) => { out[String(o.type)] = { min: Number(o.min), max: Number(o.max) }; });
  return out;
}
function config_() {
  const out = {};
  read_(SH.C).rows.forEach((o) => { out[String(o.key)] = o.value; });
  return out;
}
function setConfig_(key, value) {
  const t = read_(SH.C);
  const row = t.rows.find((o) => o.key === key);
  if (row) { row.value = value; writeRow_(t, row); } else append_(t, { key: key, value: value });
}
function nextId_(when) {
  const p = PropertiesService.getScriptProperties();
  const seq = Number(p.getProperty('SEQ') || 0) + 1;
  p.setProperty('SEQ', String(seq));
  return 'TA-' + Utilities.formatDate(when, 'Asia/Bangkok', 'yyMMdd') + '-' + ('000' + seq).slice(-4);
}
function savePhotos_(list, id) {
  if (!list || !list.length) return [];
  const folder = photoFolder_();
  return list.slice(0, 3).map((d, k) => {
    const s = String(d);
    if (!/^data:/.test(s)) return s;
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(s);
    if (!m) return null;
    const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], id + '-' + (k + 1) + '.jpg'));
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (err) { /* โดเมนอาจไม่อนุญาต */ }
    return file.getId();
  }).filter(Boolean);
}
function photoFolder_() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('PHOTO_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (err) { /* ถูกลบไปแล้ว */ } }
  const f = DriveApp.createFolder('TempWatch Photos');
  p.setProperty('PHOTO_FOLDER', f.getId());
  return f;
}
const num_ = (v) => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v));
const r1_ = (n) => Math.round(n * 10) / 10;
function ms_(v) {
  const d = toDate_(v);
  return d ? d.getTime() : null;
}
/** แปลงค่าวันเวลาหลายรูปแบบ: Date, ms, Excel serial, "2026-11-05 13:22", "11/14/26 14:26", "14/11/2569 14:26" */
function toDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (v === '' || v == null) return null;
  if (typeof v === 'number') {
    if (v > 1e11) return new Date(v);
    if (v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5) - 7 * 3600e3); // Excel serial (เวลาไทย)
    return null;
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return bkk_(+m[1] > 2400 ? m[1] - 543 : +m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s);
  if (m) {
    const a = +m[1], b = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    const be = y > 2400;
    if (be) y -= 543;
    const dayFirst = a > 12 || be;
    return bkk_(y, dayFirst ? b : a, dayFirst ? a : b, +(m[4] || 0), +(m[5] || 0), 0);
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}
/**
 * สร้างวันเวลาตาม "เวลาประเทศไทย" (UTC+7, ไม่มี daylight saving) — ไม่ขึ้นกับเขตเวลาของโปรเจกต์ Apps Script
 * เวลาในรายงานจากระบบ GPS เป็นเวลาไทยเสมอ
 */
function bkk_(y, mo, d, h, mi, s) {
  return new Date(Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0) - 7 * 3600e3);
}
/** เที่ยงคืน (00:00 เวลาไทย) ของวันเดียวกับ date */
function bkkDay_(date) {
  const p = Utilities.formatDate(date, 'Asia/Bangkok', 'yyyy-MM-dd').split('-').map(Number);
  return bkk_(p[0], p[1], p[2], 0, 0, 0);
}
/**
 * เวลาท้ายชื่อไฟล์ เช่น รายงาน_Temperature_Dashboard_20261117063040 — ระบบ GPS ใช้เวลา UTC
 * (ไฟล์นี้สร้าง 13:30:40 เวลาไทย = 06:30:40 UTC และข้อมูลล่าสุดในไฟล์คือ 13:24)
 */
function timeFromName_(name) {
  const m = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(name));
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ===================== Setup / admin (รันจากเมนู หรือ Apps Script editor) =====================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Temp Watch')
    .addItem('1) ตั้งค่าชีต (setup)', 'setup')
    .addItem('นำเข้ารายงานจากลิงก์ Google Sheet...', 'importFromLinkPrompt')
    .addItem('แสดง API token', 'showToken')
    .addItem('สุ่ม PIN ใหม่ให้ทีมที่ยังไม่มี PIN', 'fillMissingPins')
    .addSeparator()
    .addItem('คืนสถานะรถตามการนำเข้าล่าสุด', 'rebuildVehicles')
    .addItem('ล้างข้อมูลที่นำเข้าทั้งหมด (เก็บทีม/PIN ไว้)...', 'resetImportedData')
    .addToUi();
}

/**
 * ล้างข้อมูลรายงานที่นำเข้าแล้ว เพื่อนำเข้าใหม่ — ลบแถวใน Vehicles, Alerts, ข้อมูลรายวัน, Events, Imports
 * เก็บ Teams (PIN), DCs (อีเมล), Config, Thresholds ไว้เหมือนเดิม
 */
function resetImportedData() {
  const ui = SpreadsheetApp.getUi();
  const t = read_(SH.A);
  const done = t.rows.filter((o) => o.status !== 'new').length;
  const msg = 'จะลบข้อมูลที่นำเข้าทั้งหมด: Vehicles, Alerts (' + t.rows.length + ' เคส' + (done ? ', ในนี้มี ' + done + ' เคสที่รับทราบ/บันทึกผลแล้ว' : '') +
    '), ข้อมูลรายวัน, Events, Imports\n\nทีม/PIN, อีเมล DC, Config และเกณฑ์ ยังอยู่ครบ\n\nยืนยันการลบ? (ย้อนกลับไม่ได้ ยกเว้นใช้ ไฟล์ › ประวัติเวอร์ชัน)';
  if (ui.alert('ล้างข้อมูลที่นำเข้า', msg, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  ensureSchema_();
  [SH.V, SH.A, SH.S, SH.E, SH.I].forEach((n) => {
    const sh = sheet_(n);
    const last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, Math.max(1, sh.getLastColumn())).clearContent();
  });
  PropertiesService.getScriptProperties().deleteProperty('SEQ');
  ui.alert('ล้างข้อมูลแล้ว — นำเข้ารายงานใหม่ได้ที่หน้าเว็บ เมนู "นำเข้ารายงานประจำวัน"');
}

function fillMissingPins() {
  const t = read_(SH.TM);
  let n = 0;
  t.rows.forEach((o) => { if (!String(o.pin || '').trim()) { o.pin = randomPin_(); writeRow_(t, o); n++; } });
  SpreadsheetApp.getUi().alert('สร้าง PIN ใหม่ ' + n + ' ทีม — ดูได้ที่ชีต Teams');
}

function setup() {
  ensure_(SH.V, V_COLS, []);
  ensure_(SH.A, A_COLS, []);
  ensure_(SH.E, E_COLS, []);
  ensure_(SH.I, I_COLS, []);
  ensureSchema_(); // สร้าง/อัปเกรดชีต ข้อมูลรายวัน + คอลัมน์วันที่ข้อมูล
  ensure_(SH.T, T_COLS, DEFAULT_T);
  ensure_(SH.C, C_COLS, [
    ['criticalDelta', 5, 'เบี่ยงเบนจากเกณฑ์ ≥ ค่านี้ (°C) แสดงเป็นระดับวิกฤต'],
    ['EMAIL_ALERTS', 'TRUE', 'ส่งอีเมลสรุปถึง DC เมื่อมีแจ้งเตือนใหม่ (TRUE/FALSE)'],
    ['APP_URL', '', 'ลิงก์หน้าเว็บ Temp Watch (แนบในอีเมล)'],
    ['CASE_STATUSES', CASE_STATUSES_DEFAULT, 'สถานะ (คอลัมน์ H ชีต รายคัน) ที่ต้องเปิดเคส คั่นด้วย ,'],
  ]);
  ensure_(SH.D, D_COLS, []);
  ensure_(SH.TM, TM_COLS, [
    ['ADMIN', randomPin_(), 'admin', '*', 'ผู้ดูแลระบบ: เห็นทุก DC, นำเข้ารายงาน, ตั้งค่า'],
    ['BKK', randomPin_(), 'central', BKK_DEFAULT_DCS, 'ทีมส่วนกลาง กทม. — แก้รายชื่อ DC ในคอลัมน์ dcs (คั่นด้วย ,)'],
  ]);
  sheet_(SH.TM).getRange('A:D').setNumberFormat('@');
  // กันไม่ให้ Sheets แปลงทะเบียน / GPS ID / ใบรายการ เป็นตัวเลขหรือวันที่
  sheet_(SH.V).getRange('A:I').setNumberFormat('@');
  sheet_(SH.A).getRange('A:A').setNumberFormat('@');
  sheet_(SH.A).getRange('C:J').setNumberFormat('@');
  sheet_(SH.E).getRange('A:C').setNumberFormat('@');
  sheet_(SH.E).getRange('H:K').setNumberFormat('@');
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('API_TOKEN')) p.setProperty('API_TOKEN', Utilities.getUuid());
  Logger.log('API_TOKEN = ' + p.getProperty('API_TOKEN'));
  return p.getProperty('API_TOKEN');
}

/**
 * อัปเกรดโครงชีตให้เป็นเวอร์ชันล่าสุดโดยไม่ต้องรัน setup ซ้ำ (เรียกทุกครั้งก่อนนำเข้า)
 * - เปลี่ยนชื่อชีต Snapshots → ข้อมูลรายวัน
 * - เพิ่มคอลัมน์ที่ขาด (ต่อท้ายขวาสุด) และเติม dataDate ให้แถวเก่า
 */
function ensureSchema_() {
  const s = ss_();
  const legacy = s.getSheetByName(LEGACY_S);
  if (legacy && !s.getSheetByName(SH.S)) legacy.setName(SH.S);
  ensure_(SH.S, S_COLS, []);
  [[SH.E, E_COLS], [SH.I, I_COLS], [SH.A, A_COLS]].forEach((x) => addCols_(x[0], x[1]));
  // ชีต ข้อมูลรายวัน รูปแบบเก่า → จัดคอลัมน์ใหม่ให้ "dataDate" อยู่คอลัมน์แรก และเติมวันที่ให้แถวเก่า
  const t = read_(SH.S);
  if (t.head.join('|') !== S_COLS.join('|')) {
    // วันที่ของแถวเก่า = "อัพเดทล่าสุด" ที่ใหม่ที่สุดของรายงานเดียวกัน (ถ้าไม่มี ใช้ reportTime)
    const maxByFile = {};
    t.rows.forEach((o) => { const u = ms_(o.updated); if (u && u > (maxByFile[o.reportFile] || 0)) maxByFile[o.reportFile] = u; });
    const rows = t.rows.map((o) => {
      if (!o.dataDate) {
        const d = maxByFile[o.reportFile] ? new Date(maxByFile[o.reportFile]) : toDate_(o.reportTime);
        o.dataDate = d ? bkkDay_(d) : '';
      }
      return S_COLS.map((c) => (o[c] == null ? '' : o[c]));
    });
    const lastRow = t.sh.getLastRow(), lastCol = Math.max(t.head.length, t.sh.getLastColumn());
    if (lastRow) t.sh.getRange(1, 1, lastRow, lastCol).clearContent();
    t.sh.getRange(1, 1, 1, S_COLS.length).setValues([S_COLS]).setFontWeight('bold');
    if (rows.length) t.sh.getRange(2, 1, rows.length, S_COLS.length).setValues(rows);
  }
  if (s.getSheetByName(SH.C) && !('CASE_STATUSES' in config_())) {
    append_(read_(SH.C), { key: 'CASE_STATUSES', value: CASE_STATUSES_DEFAULT, note: 'สถานะ (คอลัมน์ H ชีต รายคัน) ที่ต้องเปิดเคส คั่นด้วย ,' });
  }
  formatCol_(SH.S, 'dataDate', 'yyyy-mm-dd');
  ['reportFile', 'plate', 'gpsId', 'group', 'vtype', 'owner', 'driver', 'phone', 'dc'].forEach((c) => formatCol_(SH.S, c, '@'));
  formatCol_(SH.E, 'dataDate', 'yyyy-mm-dd');
  formatCol_(SH.I, 'dataDate', 'yyyy-mm-dd');
}
function addCols_(name, cols) {
  const sh = ss_().getSheetByName(name);
  if (!sh) return;
  const lastCol = Math.max(1, sh.getLastColumn());
  const head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const miss = cols.filter((c) => head.indexOf(c) < 0);
  if (miss.length) sh.getRange(1, lastCol + 1, 1, miss.length).setValues([miss]).setFontWeight('bold');
}
function formatCol_(name, col, fmt) {
  const sh = ss_().getSheetByName(name);
  if (!sh) return;
  const head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
  const i = head.indexOf(col);
  if (i >= 0) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat(fmt);
}

function ensure_(name, cols, rows) {
  let sh = ss_().getSheetByName(name);
  if (!sh) sh = ss_().insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (rows.length) sh.getRange(2, 1, rows.length, cols.length).setValues(rows);
  }
}

function importFromLinkPrompt() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('นำเข้ารายงาน Temperature Dashboard', 'วางลิงก์ Google Sheet ของรายงาน:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const s = importFromLink_(r.getResponseText(), Session.getActiveUser().getEmail());
  ui.alert('นำเข้าแล้ว: ' + s.reportFile + '\nรถ ' + s.vehicles + ' คัน · วิกฤต ' + s.critical + ' คัน\nแจ้งเตือนใหม่ ' + s.newAlerts +
    ' · อัปเดตงานค้าง ' + s.updatedAlerts + ' · ประวัติเกินเกณฑ์ใหม่ ' + s.newEvents + ' รายการ');
}

function showToken() {
  const token = PropertiesService.getScriptProperties().getProperty('API_TOKEN') || setup();
  SpreadsheetApp.getUi().alert('API token สำหรับใส่ในหน้า ตั้งค่า ของเว็บ:\n\n' + token);
}
