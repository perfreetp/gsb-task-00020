const db = require('../db');
const { requireRole, audit, addVersion } = require('../auth');
const { bodyJson, ok, fail, now, genNo } = require('../util');
const trace = require('../services/trace');

module.exports = async function washRoutes(req, res, path) {
  if (path === '/api/wash-batches' && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor']);
    if (!user) return;
    const rows = db.prepare(`SELECT w.*, u.real_name AS operator_name,
      rb.batch_no AS recovery_batch_no, sb.batch_no AS rewash_batch_no,
      (SELECT COUNT(*) FROM wash_items wi WHERE wi.wash_batch_id=w.id) AS item_count
      FROM wash_batches w JOIN users u ON u.id=w.operator_id
      LEFT JOIN recovery_batches rb ON rb.id=w.recovery_batch_id
      LEFT JOIN sterilization_batches sb ON sb.id=w.source_stbatch_id
      ORDER BY w.id DESC`).all();
    return ok(res, rows);
  }

  const gm = path.match(/^\/api\/wash-batches\/(\d+)$/);
  if (gm && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor']);
    if (!user) return;
    const w = db.prepare(`SELECT w.*, u.real_name AS operator_name FROM wash_batches w
      JOIN users u ON u.id=w.operator_id WHERE w.id=?`).get(gm[1]);
    if (!w) return fail(res, 404, '清洗批次不存在');
    const items = db.prepare(`SELECT wi.*, i.udi, i.name FROM wash_items wi
      JOIN instruments i ON i.id=wi.instrument_id WHERE wi.wash_batch_id=?`).all(w.id);
    return ok(res, { ...w, items });
  }

  // 记录清洗消毒：设备编号、程序、温度、时长、操作人
  if (path === '/api/wash-batches' && req.method === 'POST') {
    const user = requireRole(req, res, ['operator']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!b.equipment_no || !b.program || b.temperature_c == null || !b.duration_min) {
      return fail(res, 400, '设备编号、程序、温度、时长必填');
    }
    if (!b.recovery_batch_id && !b.source_stbatch_id) return fail(res, 400, '请选择来源（回收批次或召回重处理）');

    const tx = db.tx(() => {
      let instruments = [];
      if (b.recovery_batch_id) {
        const rb = db.prepare('SELECT * FROM recovery_batches WHERE id=?').get(b.recovery_batch_id);
        if (!rb) throw new Error('回收批次不存在');
        instruments = db.prepare(`SELECT instrument_id FROM recovery_items
          WHERE batch_id=? AND instrument_id IS NOT NULL`).all(b.recovery_batch_id).map((r) => r.instrument_id);
      } else {
        const sb = db.prepare('SELECT * FROM sterilization_batches WHERE id=?').get(b.source_stbatch_id);
        if (!sb) throw new Error('灭菌批次不存在');
        instruments = db.prepare('SELECT instrument_id FROM sterilization_items WHERE stbatch_id=?')
          .all(b.source_stbatch_id).map((r) => r.instrument_id);
      }
      if (!instruments.length) throw new Error('来源批次没有可清洗的已登记器械');

      const batchNo = genNo('QX');
      const info = db.prepare(`INSERT INTO wash_batches(batch_no,recovery_batch_id,source_stbatch_id,equipment_no,program,temperature_c,duration_min,chemical,operator_id,started_at,ended_at,status,note,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?, 'done', ?, ?)`).run(
        batchNo, b.recovery_batch_id || null, b.source_stbatch_id || null,
        b.equipment_no, b.program, b.temperature_c, b.duration_min, b.chemical || '',
        user.id, b.started_at || now(), b.ended_at || now(), b.note || '', now());
      const wid = Number(info.lastInsertRowid);
      for (const iid of instruments) {
        db.prepare('INSERT INTO wash_items(wash_batch_id,instrument_id) VALUES(?,?)').run(wid, iid);
        const inst = db.prepare('SELECT * FROM instruments WHERE id=?').get(iid);
        addVersion(user, 'instrument', iid, 'current_status', inst.current_status, 'washing', '进入清洗消毒');
        trace.setInstrumentStatus(iid, 'washing');
      }
      if (b.recovery_batch_id) db.prepare("UPDATE recovery_batches SET status='washing' WHERE id=?").run(b.recovery_batch_id);
      audit(user, 'CREATE', 'wash_batch', wid, { batch_no: batchNo, items: instruments.length });
      return { id: wid, batchNo };
    });
    try { return ok(res, tx()); } catch (e) { return fail(res, 400, e.message); }
  }

  return false;
};
