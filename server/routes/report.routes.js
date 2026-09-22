const db = require('../db');
const { requireRole, audit } = require('../auth');
const { ok, now } = require('../util');

const TYPE_NAMES = {
  'batch-monitor': '批次监测放行报表',
  'positive': '生物阳性处置报表',
  'clinic-usage': '诊所发放使用报表',
  'instrument-flow': '器械流转报表',
  'recall': '召回统计报表',
};

function getReportData(type) {
  if (type === 'batch-monitor') {
    return db.prepare(`SELECT sb.batch_no AS 批次号, sb.sterilizer_no AS 灭菌器, sb.started_at AS 灭菌时间,
      sb.chemical_result AS 化学监测, sb.biological_result AS 生物监测, sb.bio_result_at AS 生物结果时间,
      sb.status AS 批次状态, sb.early_release AS 提前放行
      FROM sterilization_batches sb ORDER BY sb.id DESC`).all();
  }
  if (type === 'positive') {
    return db.prepare(`SELECT sb.batch_no AS 批次号, sb.sterilizer_no AS 灭菌器,
      sb.frozen_at AS 锁定时间, nc.nc_no AS 处置单号, nc.root_cause AS 原因分析, nc.correction AS 整改措施, nc.status AS 处置状态
      FROM sterilization_batches sb LEFT JOIN nonconformances nc ON nc.stbatch_id=sb.id
      WHERE sb.biological_result='positive' ORDER BY sb.id DESC`).all();
  }
  if (type === 'clinic-usage') {
    return db.prepare(`SELECT c.name AS 诊所, COUNT(DISTINCT d.id) AS 发放单数,
      COUNT(DISTINCT di.instrument_id) AS 接收器械件次,
      SUM(CASE WHEN d.status='frozen' THEN 1 ELSE 0 END) AS 冻结单数,
      COUNT(DISTINCT u.id) AS 使用记录数
      FROM clinics c
      LEFT JOIN distributions d ON d.clinic_id=c.id
      LEFT JOIN distribution_items di ON di.distribution_id=d.id
      LEFT JOIN usages u ON u.clinic_id=c.id
      GROUP BY c.id ORDER BY c.id`).all();
  }
  if (type === 'instrument-flow') {
    return db.prepare(`SELECT i.udi AS 唯一标识, i.name AS 器械名称, i.current_status AS 当前状态,
      c.name AS 当前所在, COUNT(DISTINCT si.stbatch_id) AS 灭菌次数,
      MAX(sb.started_at) AS 最近灭菌时间
      FROM instruments i
      LEFT JOIN sterilization_items si ON si.instrument_id=i.id
      LEFT JOIN sterilization_batches sb ON sb.id=si.stbatch_id
      LEFT JOIN clinics c ON c.id=i.current_clinic_id
      GROUP BY i.id ORDER BY i.id DESC LIMIT 500`).all();
  }
  if (type === 'recall') {
    return db.prepare(`SELECT rc.recall_no AS 召回单号, sb.batch_no AS 批次号, rc.created_at AS 发起时间,
      rc.reason AS 召回原因, rc.status AS 状态,
      (SELECT COUNT(*) FROM recall_items ri WHERE ri.recall_id=rc.id) AS 涉及件数,
      (SELECT COUNT(*) FROM recall_items ri WHERE ri.recall_id=rc.id AND ri.return_status!='pending') AS 已退回件数
      FROM recalls rc JOIN sterilization_batches sb ON sb.id=rc.stbatch_id ORDER BY rc.id DESC`).all();
  }
  return null;
}

function toCsv(rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const headers = Object.keys(rows[0] || { 无数据: '' });
  const head = headers.map(esc);
  const body = rows.map((r) => headers.map((h) => esc(r[h])).join(','));
  return '﻿' + [head.join(','), ...body].join('\n');
}

module.exports = async function reportRoutes(req, res, path) {
  const gm = path.match(/^\/api\/reports\/([a-z-]+)$/);
  if (gm && req.method === 'GET') {
    const user = requireRole(req, res, ['reviewer', 'supervisor']);
    if (!user) return;
    const rows = getReportData(gm[1]);
    if (rows === null) return ok(res, []);
    return ok(res, rows);
  }

  const em = path.match(/^\/api\/reports\/([a-z-]+)\/export$/);
  if (em && req.method === 'GET') {
    const user = requireRole(req, res, ['supervisor']);
    if (!user) return;
    const type = em[1];
    const rows = getReportData(type);
    if (rows === null) { res.writeHead(404); return res.end('unknown report'); }
    const csv = toCsv(rows);
    const fileName = `${TYPE_NAMES[type] || type}_${now().slice(0, 10)}.csv`;
    db.prepare('INSERT INTO export_logs(user_id,username,report_type,params,file_name,created_at) VALUES(?,?,?,?,?,?)')
      .run(user.id, user.username, type, '', fileName, now());
    audit(user, 'EXPORT_REPORT', 'report', null, { type, file_name: fileName, rows: rows.length });
    const buf = Buffer.from(csv, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Content-Length': buf.length,
    });
    return res.end(buf);
  }

  if (path === '/api/export-logs' && req.method === 'GET') {
    const user = requireRole(req, res, ['supervisor']);
    if (!user) return;
    return ok(res, db.prepare('SELECT * FROM export_logs ORDER BY id DESC LIMIT 200').all());
  }

  return false;
};
