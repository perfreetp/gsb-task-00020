const db = require('../db');
const { requireRole, audit, addVersion } = require('../auth');
const { bodyJson, ok, fail, now, genNo } = require('../util');
const trace = require('../services/trace');

function genUdi() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
  return `UDI${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${rand}`;
}

module.exports = async function packageRoutes(req, res, path) {
  if (path === '/api/packages' && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor']);
    if (!user) return;
    const rows = db.prepare(`SELECT p.*, u.real_name AS packer_name, w.batch_no AS wash_batch_no,
      (SELECT COUNT(*) FROM package_items pi WHERE pi.package_id=p.id) AS item_count
      FROM packages p JOIN users u ON u.id=p.packer_id
      JOIN wash_batches w ON w.id=p.wash_batch_id ORDER BY p.id DESC`).all();
    return ok(res, rows);
  }

  const gm = path.match(/^\/api\/packages\/(\d+)$/);
  if (gm && req.method === 'GET') {
    const user = requireRole(req, res, ['operator', 'reviewer', 'supervisor']);
    if (!user) return;
    const p = db.prepare(`SELECT p.*, u.real_name AS packer_name FROM packages p
      JOIN users u ON u.id=p.packer_id WHERE p.id=?`).get(gm[1]);
    if (!p) return fail(res, 404, '包装记录不存在');
    const items = db.prepare(`SELECT pi.*, i.udi, i.name, i.spec FROM package_items pi
      JOIN instruments i ON i.id=pi.instrument_id WHERE pi.package_id=?`).all(p.id);
    return ok(res, { ...p, items });
  }

  // 包装：每件器械贴唯一标识并绑定
  if (path === '/api/packages' && req.method === 'POST') {
    const user = requireRole(req, res, ['operator']);
    if (!user) return;
    const b = await bodyJson(req);
    if (!b.wash_batch_id || !b.package_name || !b.sterilization_method) return fail(res, 400, '清洗批次、包名称、灭菌方式必填');

    const tx = db.tx(() => {
      const wb = db.prepare('SELECT * FROM wash_batches WHERE id=?').get(b.wash_batch_id);
      if (!wb) throw new Error('清洗批次不存在');

      // 已清洗器械
      let instRows = db.prepare(`SELECT wi.instrument_id, i.udi, i.name FROM wash_items wi
        JOIN instruments i ON i.id=wi.instrument_id WHERE wi.wash_batch_id=?`).all(b.wash_batch_id);

      // 回收时未建档的散件（无 instrument_id）：包装环节建档并贴标
      if (wb.recovery_batch_id) {
        const loose = db.prepare(`SELECT * FROM recovery_items WHERE batch_id=? AND instrument_id IS NULL
          AND appearance_status!='missing'`).all(wb.recovery_batch_id);
        for (const lo of loose) {
          for (let n = 0; n < (lo.quantity || 1); n++) {
            const udi = lo.udi_scanned || genUdi();
            if (db.prepare('SELECT id FROM instruments WHERE udi=?').get(udi)) continue;
            const ii = db.prepare(`INSERT INTO instruments(udi,name,spec,category,current_status,label_printed,created_at)
              VALUES(?,?,?,?, 'packaged', 1, ?)`).run(udi, lo.item_name, '', '', now());
            db.prepare('UPDATE recovery_items SET instrument_id=? WHERE id=?').run(ii.lastInsertRowid, lo.id);
            instRows.push({ instrument_id: Number(ii.lastInsertRowid), udi, name: lo.item_name });
          }
        }
      }
      if (!instRows.length) throw new Error('该清洗批次没有可包装器械');

      const packageNo = genNo('BZ');
      const pinfo = db.prepare(`INSERT INTO packages(package_no,wash_batch_id,package_name,package_type,sterilization_method,packer_id,packed_at,note,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(packageNo, b.wash_batch_id, b.package_name,
        b.package_type || 'set', b.sterilization_method, user.id, b.packed_at || now(), b.note || '', now());
      const pid = Number(pinfo.lastInsertRowid);

      for (const row of instRows) {
        let iid = row.instrument_id;
        let inst = db.prepare('SELECT * FROM instruments WHERE id=?').get(iid);
        // 无唯一标识则当场贴标
        if (!inst.udi || !inst.label_printed) {
          const udi = inst.udi || genUdi();
          db.prepare('UPDATE instruments SET udi=?, label_printed=1 WHERE id=?').run(udi, iid);
        }
        db.prepare('INSERT INTO package_items(package_id,instrument_id,labeled_at) VALUES(?,?,?)').run(pid, iid, now());
        addVersion(user, 'instrument', iid, 'current_status', inst.current_status, 'packaged', `包装入包 ${packageNo}，UDI 绑定`);
        trace.setInstrumentStatus(iid, 'packaged');
      }
      if (wb.recovery_batch_id) db.prepare("UPDATE recovery_batches SET status='done' WHERE id=?").run(wb.recovery_batch_id);
      audit(user, 'CREATE', 'package', pid, { package_no: packageNo, items: instRows.length });
      return { id: pid, packageNo, itemCount: instRows.length };
    });
    try { return ok(res, tx()); } catch (e) { return fail(res, 400, e.message); }
  }

  return false;
};
