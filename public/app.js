'use strict';
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => s ? String(s).replace('T', ' ').slice(0, 16) : '—';

const state = { token: localStorage.getItem('cssd_token') || '', user: null, meta: null, view: 'dashboard' };

async function api(method, url, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (state.token) opt.headers['Authorization'] = 'Bearer ' + state.token;
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(url, opt);
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401) { doLogout(false); throw new Error('登录已过期，请重新登录'); }
    throw Object.assign(new Error(data.error || ('请求失败 ' + res.status)), { data });
  }
  return data;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

const TAG = {
  recycled: '已回收', washed: '已清洗', packed: '已包装', sterilized: '已灭菌待放行',
  pending_bi: '生物监测待检', released: '已放行', emergency_released: '紧急放行',
  frozen: '已冻结', reworked: '已返工', rejected: '已报废',
  in_transit: '在途', received: '已签收', in_use: '使用中', recalled: '已召回', returned: '已退回',
  pass: '合格', fail: '阳性/不合格', pending: '待检', na: '未做',
  open: '待处理', analyzing: '分析中', reworking: '返工中', closed: '已闭环',
  notified: '待确认', acknowledged: '已确认',
  confirmed: '已确认', rejected: '已拒认', rectifying: '整改中', scrapped: '已报废'
};
const tag = (s) => s ? `<span class="tag ${esc(s)}">${esc(TAG[s] || s)}</span>` : '—';

const STATUS_FLOW = ['recycled', 'washed', 'packed', 'sterilized', 'pending_bi', 'released', 'frozen'];
function flowBar(current) {
  const steps = [
    ['recycled', '回收'], ['washed', '清洗消毒'], ['packed', '包装赋码'],
    ['sterilized', '灭菌'], ['pending_bi', '生物监测'], ['released', '放行'], ['frozen', '冻结召回']
  ];
  const frozen = current === 'frozen';
  const reached = ['recycled', 'washed', 'packed', 'sterilized', 'pending_bi', 'released', 'frozen'];
  const released = current === 'released' || current === 'emergency_released';
  return `<div class="flowbar">` + steps.map((s, i) => {
    let cls = '';
    if (s[0] === 'frozen') cls = frozen ? 'cur' : '';
    else if (frozen) cls = ['recycled','washed','packed','sterilized','pending_bi'].includes(s[0]) ? 'done' : '';
    else if (released && reached.indexOf(s[0]) <= reached.indexOf('released')) cls = 'done';
    else {
      const idx = STATUS_FLOW.indexOf(current);
      const myIdx = STATUS_FLOW.indexOf(s[0]);
      if (idx >= 0 && myIdx <= idx) cls = 'done';
    }
    return `<span class="step ${cls}">${s[1]}</span>` + (i < steps.length - 1 ? '<span class="arrow">→</span>' : '');
  }).join('') + `</div>`;
}

function modal(title, html, opts = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-mask">
    <div class="modal ${opts.wide ? 'wide' : ''}">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="close-x" id="m-close">✕</button></div>
      <div class="modal-body">${html}</div>
      ${opts.foot !== false ? `<div class="modal-foot">
        <button class="btn" id="m-cancel">取消</button>
        <button class="btn primary" id="m-ok">${esc(opts.okText || '确定')}</button></div>` : ''}
    </div></div>`;
  const close = () => { root.innerHTML = ''; };
  $('#m-close').onclick = close;
  const cancelBtn = $('#m-cancel');
  if (cancelBtn) cancelBtn.onclick = close;
  const okBtn = $('#m-ok');
  if (okBtn && opts.onOk) okBtn.onclick = () => opts.onOk(close);
  else if (okBtn) okBtn.onclick = close;
  if (opts.onShow) opts.onShow();
  return { close, root };
}
function confirmBox(title, text, onOk, danger) {
  modal(title, `<p style="line-height:1.7">${esc(text)}</p>`, { okText: danger ? '确认执行' : '确定', onOk: (close) => { onOk(); close(); } });
  if (danger) $('#m-ok').classList.add('danger');
}

async function loadMeta() {
  state.meta = await api('GET', '/api/meta');
  state.user = state.meta.user;
}

const VIEWS = {
  dashboard: { title: '工作台', staff: true, clinic: true, render: renderDashboard },
  recycles: { title: '回收登记', staff: true, render: renderRecycles },
  washing: { title: '清洗 / 包装', staff: true, render: renderWashing },
  sterlist: { title: '灭菌批次', staff: true, render: renderSterList },
  distributions: { title: '发放与签收', staff: true, render: renderDistributions },
  discrepancies: { title: '差异确认', staff: true, clinic: true, render: renderDiscrepancies },
  recalls: { title: '召回任务', staff: true, clinic: true, render: renderRecalls },
  ncrs: { title: '不合格处置', staff: true, render: renderNcrs },
  inspections: { title: '专项检查', reviewer: true, render: renderInspections },
  trace: { title: '双向追溯', staff: true, clinic: true, render: renderTrace },
  instruments: { title: '器械台账', staff: true, render: renderInstruments },
  reports: { title: '感控报表', reviewer: true, render: renderReports },
  audit: { title: '审计日志', reviewer: true, render: renderAudit },
  clinic_home: { title: '诊所工作台', clinic: true, render: renderClinicHome }
};

async function go(view, param) {
  state.view = view;
  const v = VIEWS[view];
  $('#page-title').textContent = v.title;
  renderNav();
  $('#content').innerHTML = '<div class="muted">加载中…</div>';
  try { await v.render(param); } catch (e) { $('#content').innerHTML = `<div class="alert-box red">${esc(e.message)}</div>`; }
}

function renderNav() {
  const role = state.user.role;
  const menus = [
    { v: 'dashboard', i: '🏠', t: '工作台', show: role !== 'clinic' },
    { v: 'clinic_home', i: '🏥', t: '诊所工作台', show: role === 'clinic' },
    { v: 'recycles', i: '📥', t: '回收登记' },
    { v: 'washing', i: '💧', t: '清洗 / 包装' },
    { v: 'sterlist', i: '♨️', t: '灭菌 / 放行' },
    { v: 'distributions', i: '🚚', t: '发放与签收' },
    { v: 'discrepancies', i: '📝', t: '差异确认' },
    { v: 'recalls', i: '🚨', t: '召回任务' },
    { v: 'ncrs', i: '⚠️', t: '不合格处置' },
    { v: 'inspections', i: '🔍', t: '专项检查', show: role === 'supervisor' },
    { v: 'trace', i: '🔗', t: '双向追溯' },
    { v: 'instruments', i: '🔖', t: '器械台账', show: role !== 'clinic' },
    { v: 'reports', i: '📊', t: '感控报表', show: ['reviewer', 'supervisor'].includes(role) },
    { v: 'audit', i: '🗂️', t: '审计日志', show: ['reviewer', 'supervisor'].includes(role) }
  ];
  $('#nav').innerHTML = menus.filter((m) => {
    if (m.show === false) return false;
    if (role === 'clinic' && !['clinic_home', 'discrepancies', 'recalls', 'trace'].includes(m.v)) return false;
    return true;
  }).map((m) => `<div class="nav-item ${state.view === m.v ? 'active' : ''}" data-v="${m.v}"><span class="ico">${m.i}</span><span class="t">${m.t}</span></div>`).join('');
  $$('.nav-item').forEach((el) => { el.onclick = () => go(el.dataset.v); });
}

// ================= 工作台 =================
async function renderDashboard() {
  const d = await api('GET', '/api/dashboard');
  const c = d.counts;
  const role = state.user.role;
  let html = '';
  if (role !== 'clinic') {
    html += `<div class="stat-grid">
      <div class="stat"><div class="num">${c.ster_batches}</div><div class="lbl">灭菌批次总数</div></div>
      <div class="stat warn"><div class="num">${c.pending_bi}</div><div class="lbl">生物监测待检/已灭菌</div></div>
      <div class="stat alert"><div class="num">${c.frozen}</div><div class="lbl">冻结批次</div></div>
      <div class="stat"><div class="num">${c.in_transit}</div><div class="lbl">在途器械批次</div></div>
      <div class="stat alert"><div class="num">${c.pending_discrepancies}</div><div class="lbl">待确认差异</div></div>
      <div class="stat ${c.open_ncrs ? 'alert' : 'ok'}"><div class="num">${c.open_ncrs}</div><div class="lbl">未闭环处置单</div></div>
      <div class="stat ${c.open_inspections ? 'warn' : 'ok'}"><div class="num">${c.open_inspections}</div><div class="lbl">进行中专项检查</div></div>
      <div class="stat"><div class="num">${c.instruments}</div><div class="lbl">在册器械单件</div></div>
    </div>`;
    html += `<div class="card"><h3>近期灭菌批次 <span class="sub">（化学/生物监测状态、件数）</span></h3>
      <div class="table-wrap"><table><thead><tr><th>批次号</th><th>来源诊所</th><th>状态</th><th>化学</th><th>生物</th><th>件数</th><th>灭菌时间</th><th></th></tr></thead><tbody>
      ${d.recent_batches.map((b) => `<tr>
        <td class="mono">${esc(b.batch_no)}</td><td>${esc(b.clinic_name)}</td><td>${tag(b.status)}</td>
        <td>${tag(b.chem)}</td><td>${tag(b.bio)}</td><td>${b.item_count}</td><td class="muted">${fmt(b.sterilized_at)}</td>
        <td><button class="btn small" data-sb="${b.id}">查看</button></td></tr>`).join('')}
      </tbody></table></div></div>`;
  } else {
    html = await clinicDashboardHtml(d);
  }
  $('#content').innerHTML = html;
  $$('[data-sb]').forEach((b) => { b.onclick = () => go('sterlist', Number(b.dataset.sb)); });
}

async function clinicDashboardHtml(d) {
  const noteCount = (d.my_notifications || []).filter((n) => !n.read_flag).length;
  let h = `<div class="alert-box blue">欢迎使用诊所端。您有 <b>${noteCount}</b> 条未读通知，收到召回通知后请立即停用封存并在「召回任务」中确认。</div>`;
  h += `<div class="grid2">
    <div class="card"><h3>📨 通知</h3>${(d.my_notifications || []).slice(0, 8).map((n) =>
      `<div class="checkline"><div><b>${esc(n.title)}</b><div class="muted">${esc(n.body || '')}</div><div class="muted" style="font-size:11px;margin-top:2px">${fmt(n.created_at)}</div></div></div>`).join('') || '<p class="muted">暂无通知</p>'}</div>
    <div class="card"><h3>📦 我司器械动态</h3><div class="table-wrap"><table><thead><tr><th>UID</th><th>器械</th><th>批次</th><th>状态</th><th>使用时间</th></tr></thead><tbody>
      ${(d.my_instruments || []).map((x) => `<tr><td class="mono">${esc(x.uid)}</td><td>${esc(x.instrument_type)}</td><td class="mono">${esc(x.batch_no)}</td><td>${tag(x.dist_status)}</td><td class="muted">${fmt(x.first_used_at)}</td></tr>`).join('')}
    </tbody></table></div></div></div>`;
  h += `<div class="card"><h3>🚨 召回任务</h3><div id="cl-recalls"></div></div>`;
  setTimeout(async () => {
    const rec = await api('GET', '/api/recalls');
    $('#cl-recalls').innerHTML = `<div class="table-wrap"><table><thead><tr><th>UID</th><th>批次</th><th>状态</th><th>通知时间</th><th>操作</th></tr></thead><tbody>
      ${rec.map((r) => `<tr><td class="mono">${esc(r.uid)}</td><td class="mono">${esc(d.recent_batches ? '' : '')}</td><td>${tag(r.status)}</td><td class="muted">${fmt(r.notified_at)}</td>
        <td>${r.status === 'notified' ? `<button class="btn small pill-btn" data-ack="${r.id}">确认停用</button> <button class="btn small danger pill-btn" data-ret="${r.id}">已退回</button>` : (r.status === 'acknowledged' ? `<button class="btn small pill-btn" data-ret="${r.id}">登记退回</button>` : '已处理')}</td></tr>`).join('')}
    </tbody></table></div>`;
    $$('[data-ack]').forEach((b) => { b.onclick = async () => { await api('POST', `/api/recalls/${b.dataset.ack}/ack`, { reply: '已停用封存' }); toast('已确认停用封存', 'ok'); go('clinic_home'); }; });
    $$('[data-ret]').forEach((b) => { b.onclick = async () => { await api('POST', `/api/recalls/${b.dataset.ret}/return`, { reply: '已交配送带回' }); toast('退回已登记', 'ok'); go('clinic_home'); }; });
  }, 0);
  return h;
}

// ================= 回收登记 =================
async function renderRecycles() {
  const [rows, orders, meta] = await Promise.all([api('GET', '/api/recycles'), api('GET', '/api/orders'), Promise.resolve(state.meta)]);
  $('#content').innerHTML = `
    <div class="card">
      <h3>📥 回收登记 <span class="sub">按诊所 + 租赁单清点，逐件登记数量/外观/功能；缺失或损坏当场生成差异记录推送诊所确认</span></h3>
      <div class="row">
        <button class="btn primary" id="new-recycle">＋ 新建回收批次</button>
        <span class="muted grow">共 ${rows.length} 个回收批次</span>
      </div>
      <div class="space"></div>
      <div class="table-wrap"><table><thead><tr><th>回收批号</th><th>诊所</th><th>状态</th><th>回收时间</th><th>接收人</th><th>备注</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr>
        <td class="mono">${esc(r.batch_no)}</td><td>${esc(r.clinic_name)}</td><td>${tag(r.status)}</td>
        <td class="muted">${fmt(r.received_at)}</td><td>${esc(r.receiver_name || '')}</td><td class="muted">${esc(r.note || '')}</td>
        <td><button class="btn small" data-view="${r.id}">清点明细</button></td></tr>`).join('')}
      </tbody></table></div>
    </div>`;
  $('#new-recycle').onclick = () => recycleCreateModal(orders, meta);
  $$('[data-view]').forEach((b) => { b.onclick = () => recycleDetailModal(Number(b.dataset.view)); });
}

function recycleCreateModal(orders, meta) {
  const typeOpts = meta.instrument_types;
  const body = `
    <div class="grid2">
      <div><label class="fld">诊所 *</label><select class="inp" id="rc-clinic">${meta.clinics.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div><label class="fld">关联租赁单</label><select class="inp" id="rc-order"><option value="">不关联</option>${orders.filter((o) => o.status !== 'closed').map((o) => `<option value="${o.id}">${esc(o.order_no)}（${esc(o.clinic_name)}）</option>`).join('')}</select></div>
    </div>
    <div class="space"></div>
    <label class="fld">器械清点明细（应收/实收可直接体现缺失；外观或功能异常会生成差异）</label>
    <table><thead><tr><th>器械类型</th><th width="80">应收</th><th width="80">实收</th><th width="110">外观</th><th width="100">功能</th><th></th></tr></thead>
    <tbody id="rc-items"></tbody></table>
    <div class="space"></div>
    <button class="btn small" id="rc-add">＋ 添加一行</button>
    <div class="space"></div>
    <label class="fld">备注</label><textarea class="inp" id="rc-note" placeholder="如包装破损、混放等"></textarea>`;
  const m = modal('新建回收批次', body, { wide: true, okText: '登记并生成差异（如有）', onShow: () => {
    const tb = $('#rc-items');
    const addRow = (type) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><select class="inp rc-type">${typeOpts.map((t) => `<option ${t === type ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
        <td><input class="inp rc-exp" type="number" min="0" value="0"></td>
        <td><input class="inp rc-recv" type="number" min="0" value="0"></td>
        <td><select class="inp rc-app"><option value="ok">正常</option><option value="damaged">损坏</option><option value="dirty">污染</option></select></td>
        <td><select class="inp rc-fn"><option value="ok">正常</option><option value="fault">异常</option></select></td>
        <td><button class="btn small danger rc-del">删</button></td>`;
      tb.appendChild(tr);
      tr.querySelector('.rc-del').onclick = () => tr.remove();
    };
    addRow(typeOpts[0]);
    $('#rc-add').onclick = () => addRow(typeOpts[0]);
  }, onOk: async (close) => {
    const items = $$('#rc-items tr').map((tr) => ({
      instrument_type: tr.querySelector('.rc-type').value,
      expected_qty: Number(tr.querySelector('.rc-exp').value),
      received_qty: Number(tr.querySelector('.rc-recv').value),
      appearance: tr.querySelector('.rc-app').value,
      function_status: tr.querySelector('.rc-fn').value
    })).filter((x) => x.expected_qty || x.received_qty);
    if (!items.length) return toast('请至少填写一种器械', 'err');
    try {
      const r = await api('POST', '/api/recycles', { clinic_id: Number($('#rc-clinic').value), order_id: Number($('#rc-order').value) || null, items, note: $('#rc-note').value });
      toast(`回收批次 ${r.batch_no} 已登记，差异已推送诊所确认`, 'ok');
      close(); go('recycles');
    } catch (e) { toast(e.message, 'err'); }
  }});
}

async function recycleDetailModal(id) {
  const d = await api('GET', '/api/recycles/' + id);
  modal(`回收批次 ${d.batch_no}`, `
    ${flowBar(d.status)}
    <div class="grid2">
      <dl class="kv">
        <dt>诊所</dt><dd>${esc(d.clinic_name)}</dd>
        <dt>接收人</dt><dd>${esc(d.receiver_name || '—')}</dd>
        <dt>回收时间</dt><dd>${fmt(d.received_at)}</dd>
        <dt>备注</dt><dd>${esc(d.note || '—')}</dd>
      </dl>
      <div><b>差异记录（${d.discrepancies.length}）</b>
        ${d.discrepancies.length ? `<div class="space"></div><div class="table-wrap"><table><thead><tr><th>器械</th><th>类型</th><th>数量</th><th>说明</th><th>状态</th></tr></thead><tbody>
          ${d.discrepancies.map((x) => `<tr><td>${esc(x.instrument_type)}</td><td>${({ missing: '缺失', damaged: '损坏', fault: '功能异常', surplus: '多出' })[x.kind]}</td><td>${x.qty}</td><td class="muted">${esc(x.detail)}</td><td>${tag(x.status)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted" style="margin-top:6px">无差异</p>'}
      </div>
    </div>
    <div class="space"></div>
    <b>清点明细</b>
    <div class="space"></div>
    <div class="table-wrap"><table><thead><tr><th>器械</th><th>应收</th><th>实收</th><th>外观</th><th>功能</th><th>问题备注</th></tr></thead><tbody>
    ${d.items.map((it) => `<tr><td>${esc(it.instrument_type)}</td><td>${it.expected_qty}</td><td>${it.received_qty}</td>
      <td>${({ ok: '正常', damaged: '损坏', dirty: '污染' })[it.appearance] || '—'}</td>
      <td>${({ ok: '正常', fault: '异常' })[it.function_status] || '—'}</td><td class="muted">${esc(it.issue_note || '')}</td></tr>`).join('')}
    </tbody></table></div>
    ${d.wash.length ? `<div class="space"></div><b>清洗记录</b>${d.wash.map((w) => `<p class="muted" style="margin-top:6px">${fmt(w.washed_at)}｜${esc(w.equipment_code)}｜${esc(w.program)}｜${w.temperature}℃｜${w.duration_min}分钟｜${esc(w.operator_name || '')}</p>`).join('')}` : ''}
  `, { foot: false, wide: true });
}

// ================= 清洗 / 包装 =================
async function renderWashing() {
  const [rows, eq] = await Promise.all([api('GET', '/api/recycles'), Promise.resolve(state.meta.equipment)]);
  const washers = eq.filter((e) => e.type === 'washer');
  $('#content').innerHTML = `<div class="card">
    <h3>💧 清洗消毒与包装赋码 <span class="sub">清洗记录设备/程序/温度/时长/操作人；包装时逐件生成唯一标识并绑定批次</span></h3>
    <div class="table-wrap"><table><thead><tr><th>回收批号</th><th>诊所</th><th>流程状态</th><th>清洗</th><th class="right">操作</th></tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td class="mono">${esc(r.batch_no)}</td><td>${esc(r.clinic_name)}</td><td>${tag(r.status)}</td>
      <td>${['washed', 'packed', 'sterilized', 'pending_bi', 'released', 'emergency_released', 'frozen'].includes(r.status) ? '✅ 已登记' : '⏳ 未登记'}</td>
      <td class="right" style="white-space:nowrap">
        <button class="btn small" data-wash="${r.id}">清洗登记</button>
        <button class="btn small primary" data-pack="${r.id}">包装赋码</button>
        <button class="btn small" data-ster="${r.id}">去灭菌</button>
      </td></tr>`).join('')}
    </tbody></table></div></div>`;
  $$('[data-wash]').forEach((b) => { b.onclick = () => washModal(Number(b.dataset.wash), washers); });
  $$('[data-pack]').forEach((b) => { b.onclick = () => packModal(Number(b.dataset.pack)); });
  $$('[data-ster]').forEach((b) => { b.onclick = () => go('sterlist'); });
}

function washModal(rbId, washers) {
  modal('清洗消毒登记', `
    <div class="grid2">
      <div><label class="fld">清洗消毒器 *</label><select class="inp" id="w-eq">${washers.map((w) => `<option value="${w.id}">${esc(w.code)} ${esc(w.name)}</option>`).join('')}</select></div>
      <div><label class="fld">程序 *</label><select class="inp" id="w-prog">
        <option>标准器械清洗程序</option><option>精细器械程序</option><option>管腔器械程序</option><option>返工程序-加强清洗</option></select></div>
      <div><label class="fld>温度 (℃)</label><input class="inp" id="w-temp" type="number" step="0.1" value="93"></div>
      <div><label class="fld">时长 (分钟)</label><input class="inp" id="w-dur" type="number" value="45"></div>
    </div>
    <div class="space"></div>
    <label class="fld">备注（A0值/酶液批次等）</label><input class="inp" id="w-note" placeholder="如 A0≥3000 合格">
  `, { okText: '提交清洗记录', onOk: async (close) => {
    try {
      await api('POST', `/api/recycles/${rbId}/wash`, {
        equipment_id: Number($('#w-eq').value), program: $('#w-prog').value,
        temperature: Number($('#w-temp').value), duration_min: Number($('#w-dur').value), note: $('#w-note').value
      });
      toast('清洗消毒记录已提交', 'ok'); close(); go('washing');
    } catch (e) { toast(e.message, 'err'); }
  }});
}

async function packModal(rbId) {
  const d = await api('GET', '/api/recycles/' + rbId);
  if (!d.wash.length) return toast('请先完成清洗消毒登记', 'err');
  const instCount = d.items.reduce((s, it) => s + it.received_qty, 0);
  modal('包装赋码', `
    <div class="alert-box blue">将按实收数量逐件生成唯一标识（UID），并与回收批次 <b>${esc(d.batch_no)}</b> 绑定。预计赋码 <b>${instCount}</b> 件。</div>
    <p class="muted">包装环节核对：器械完好 → 配包 → 包内放置化学指示卡 → 贴外标签与 UID 条码。</p>
  `, { okText: '执行包装赋码', onOk: async (close) => {
    try {
      const r = await api('POST', `/api/recycles/${rbId}/pack`, {});
      modal('赋码完成', `<div class="table-wrap"><table><thead><tr><th>UID</th><th>器械</th></tr></thead><tbody>
        ${r.instruments.map((i) => `<tr><td class="mono">${esc(i.uid)}</td><td>${esc(i.instrument_type)}</td></tr>`).join('')}
      </tbody></table></div>`, { okText: '知道了' });
      go('washing');
    } catch (e) {
      if (e.data && e.data.existing_count) {
        if (confirm(`该批次已赋码 ${e.data.existing_count} 件，无需重复操作。`)) {}
      } else toast(e.message, 'err');
    }
  }});
}

// ================= 灭菌批次列表 / 详情 =================
async function renderSterList(param) {
  const rows = await api('GET', '/api/sterilizations');
  const role = state.user.role;
  $('#content').innerHTML = `<div class="card">
    <h3>♨️ 灭菌批次与放行控制 <span class="sub">生物监测未出结果为待检，不能发放；阳性立即冻结全部器械、召回在途在库</span></h3>
    <div class="row">
      <button class="btn primary" id="new-ster">＋ 灭菌登记（对已包装批次）</button>
      <span class="muted grow">共 ${rows.length} 个灭菌批次</span>
    </div>
    <div class="space"></div>
    <div class="table-wrap"><table><thead><tr><th>灭菌批号</th><th>回收批号</th><th>诊所</th><th>灭菌器</th><th>状态</th><th>化学</th><th>生物</th><th>件数</th><th>已发</th><th>灭菌时间</th><th></th></tr></thead><tbody>
    ${rows.map((b) => `<tr style="${b.status === 'frozen' ? 'background:#fff5f5' : ''}">
      <td class="mono">${esc(b.batch_no)}</td><td class="mono">${esc(b.recycle_no)}</td><td>${esc(b.clinic_name)}</td>
      <td class="mono">${esc(b.sterilizer_code)}</td><td>${tag(b.status)}</td>
      <td>${tag(b.chemical && b.chemical.result)}</td><td>${tag(b.biological && b.biological.result)}</td>
      <td>${b.item_count}</td><td>${b.distributed_count}</td><td class="muted">${fmt(b.sterilized_at)}</td>
      <td><button class="btn small ${b.status === 'frozen' ? 'danger' : 'primary'}" data-sb="${b.id}">批次详情</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('#new-ster').onclick = sterCreateModal;
  $$('[data-sb]').forEach((b) => { b.onclick = () => sterDetailModal(Number(b.dataset.sb)); });
  if (param) sterDetailModal(param);
}

async function sterCreateModal() {
  const recycles = await api('GET', '/api/recycles');
  const ster = state.meta.equipment.filter((e) => e.type === 'sterilizer');
  const ready = recycles.filter((r) => ['packed', 'washed'].includes(r.status));
  modal('灭菌登记', `
    <div class="grid2">
      <div><label class="fld">已包装回收批次 *</label><select class="inp" id="s-rb">
        ${ready.length ? ready.map((r) => `<option value="${r.id}">${esc(r.batch_no)}（${esc(r.clinic_name)} / ${r.status}）</option>`).join('') : '<option value="">没有已包装待灭菌批次</option>'}
      </select></div>
      <div><label class="fld">灭菌器 *</label><select class="inp" id="s-eq">${ster.map((e) => `<option value="${e.id}">${esc(e.code)} ${esc(note(e.note))}</option>`).join('')}</select></div>
    </div>
    <div class="space"></div>
    <div class="grid2">
      <div><label class="fld">灭菌温度 ℃</label><input class="inp" id="s-temp" type="number" step="0.1" value="134"></div>
      <div><label class="fld">压力 kPa</label><input class="inp" id="s-pres" type="number" step="0.1" value="210"></div>
      <div><label class="fld">灭菌时长 min</label><input class="inp" id="s-dur" type="number" value="8"></div>
      <div><label class="fld">循环参数</label><input class="inp" id="s-cycle" value="脉动3次/干燥15min"></div>
    </div>
    <div class="space"></div>
    <label class="fld">装载图 / 装载方式说明</label><textarea class="inp" id="s-load" placeholder="如：上层6把止血钳，包间距≥2.5cm，总装载量≤90%"></textarea>
    <div class="space"></div>
    <div class="grid2">
      <div><label class="fld">化学监测结果</label><select class="inp" id="s-chem"><option value="pass">合格</option><option value="pending">待判读</option><option value="fail">不合格</option></select></div>
      <div><label class="fld">生物监测结果</label><select class="inp" id="s-bio"><option value="pending">待检（培养中）</option><option value="pass">阴性合格</option><option value="fail">阳性</option></select></div>
    </div>
    ${'' }
  `, { okText: '登记灭菌', onOk: async (close) => {
    if (!$('#s-rb').value) return toast('请先在清洗/包装页完成包装', 'err');
    try {
      const r = await api('POST', `/api/recycles/${$('#s-rb').value}/sterilize`, {
        sterilizer_id: Number($('#s-eq').value), temperature: Number($('#s-temp').value), pressure: Number($('#s-pres').value),
        duration_min: Number($('#s-dur').value), cycle_params: $('#s-cycle').value, load_diagram: $('#s-load').value,
        chemical_result: $('#s-chem').value, biological_result: $('#s-bio').value
      });
      toast('灭菌批次已登记' + (r.id ? `（#${r.id}）` : ''), 'ok');
      close(); go('sterlist', r.id);
    } catch (e) { toast(e.message, 'err'); }
  }});
}
function note(s) { return s ? '（' + s + '）' : ''; }

async function sterDetailModal(id) {
  const d = await api('GET', '/api/sterilizations/' + id);
  const role = state.user.role;
  const isReview = ['reviewer', 'supervisor'].includes(role);
  const frozen = d.status === 'frozen';
  const bio = (d.monitoring.find((m) => m.kind === 'biological') || {}).result;
  const chem = (d.monitoring.find((m) => m.kind === 'chemical') || {}).result;
  const canRelease = isReview && !frozen && !['released', 'emergency_released'].includes(d.status);
  const canDistribute = ['released', 'emergency_released'].includes(d.status);

  let head = '';
  if (frozen) head = `<div class="alert-box red">🚨 <b>批次已冻结：${esc(d.freeze_reason || '')}</b>。全部 ${d.items.length} 件器械已锁定，在途/在诊所器械已自动生成召回任务并推送诊所；同时生成不合格处置单，须返工并重新监测合格后方可放行。</div>`;
  else if (d.status === 'emergency_released') head = `<div class="alert-box amber">⚠️ 本批次为<b>紧急放行</b>：生物监测尚在待检期间已先行发放，放行结论与意见不可删除；BI 结果出具后系统自动联动。</div>`;

  const body = `
    ${head}
    ${flowBar(d.status)}
    <div class="grid2">
      <dl class="kv">
        <dt>灭菌批号</dt><dd class="mono">${esc(d.batch_no)}</dd>
        <dt>回收批号</dt><dd class="mono">${esc(d.recycle_no)}（${esc(d.clinic_name)}）</dd>
        <dt>灭菌器</dt><dd class="mono">${esc(d.sterilizer_code)}</dd>
        <dt>灭菌参数</dt><dd>${d.temperature}℃ / ${d.pressure}kPa / ${d.duration_min}min｜${esc(d.cycle_params || '—')}</dd>
        <dt>装载图</dt><dd>${esc(d.load_diagram || '—')}</dd>
        <dt>操作人</dt><dd>${esc(d.operator_name)}　${fmt(d.sterilized_at)}</dd>
        <dt>放行审核</dt><dd>${esc(d.release_name || '—')}　${fmt(d.released_at)}<div class="muted">${esc(d.release_note || '')}</div></dd>
      </dl>
      <div>
        <b>监测结果</b>
        <div class="space"></div>
        ${d.monitoring.map((m) => `<div class="card" style="padding:12px;margin-bottom:10px">
          <div class="row"><b>${({ chemical: '化学监测', biological: '生物监测', bd_test: 'B-D 试验' })[m.kind]}</b><span class="grow"></span>${tag(m.result)}</div>
          <div class="muted" style="margin:4px 0">${esc(m.value_text || '—')}</div>
          <div class="muted" style="font-size:12px">${esc(m.tester_name || '')} 录入 ${fmt(m.tested_at)}${m.issued_at ? ' / 出具 ' + fmt(m.issued_at) : ''}</div>
          ${role !== 'clinic' ? `<div class="space"></div><button class="btn small" data-mon='${JSON.stringify({ id: d.id, kind: m.kind, result: m.result }).replace(/'/g, '&apos;')}'>${m.result === 'pending' ? '出具结果' : '更正结果（需理由）'}</button>` : ''}
        </div>`).join('')}
        ${role !== 'clinic' ? `<button class="btn small" data-mon='${esc(JSON.stringify({ id: d.id, kind: 'bd_test' }))}'>补录 B-D 试验</button>` : ''}
      </div>
    </div>
    <div class="space"></div>
    <div class="row">
      <b>批次内器械（${d.items.length} 件）与去向</b><span class="grow"></span>
      ${canRelease ? `<button class="btn primary" id="sb-release">✅ 审核放行</button> <button class="btn warn" id="sb-emergency">紧急放行（BI待检急用）</button>` : ''}
      ${canDistribute ? `<button class="btn primary" id="sb-dist">🚚 发放器械</button>` : ''}
      ${!frozen && role !== 'clinic' ? `<button class="btn small" id="sb-revise">修改灭菌参数（留痕）</button>` : ''}
      ${role === 'supervisor' && frozen ? `<button class="btn warn" id="sb-inspect">发起专项检查</button>` : ''}
    </div>
    <div class="space"></div>
    <div class="table-wrap"><table><thead><tr><th>UID</th><th>器械</th><th>当前状态</th><th>去向诊所</th><th>交接/签收/使用</th></tr></thead><tbody>
    ${d.items.map((i) => `<tr>
      <td class="mono">${esc(i.uid)}</td><td>${esc(i.instrument_type)}</td><td>${tag(i.status)}</td>
      <td>${esc(i.dist_clinic_name || '中心库房')}</td>
      <td class="muted" style="font-size:12px">${i.handed_at ? `发 ${fmt(i.handed_at)} ${esc(i.handover_person || '')}` : ''}${i.received_at ? `<br>收 ${fmt(i.received_at)} ${esc(i.receive_person || '')}` : ''}${i.first_used_at ? `<br>用 ${fmt(i.first_used_at)}` : ''}${i.dist_status === 'recalled' ? '<br><b style="color:var(--red)">已召回</b>' : ''}</td>
    </tr>`).join('')}
    </tbody></table></div>`;
  const m = modal(`灭菌批次 ${d.batch_no}`, body, { foot: false, wide: true });
  $$('[data-mon]').forEach((b) => b.onclick = () => monitoringModal(JSON.parse(b.dataset.mon)));
  const rel = $('#sb-release'); if (rel) rel.onclick = () => releaseModal(d, false);
  const em = $('#sb-emergency'); if (em) em.onclick = () => releaseModal(d, true);
  const ds = $('#sb-dist'); if (ds) ds.onclick = () => distributeModal(d);
  const rv = $('#sb-revise'); if (rv) rv.onclick = () => reviseModal(d);
  const ip = $('#sb-inspect'); if (ip) ip.onclick = async () => {
    const title = `${d.batch_no} ${d.freeze_reason || '异常'}专项检查`;
    await api('POST', '/api/inspections', { title, ster_batch_id: d.id, trigger_reason: d.freeze_reason });
    toast('专项检查已发起', 'ok'); m.close(); go('inspections');
  };
  if (d.recalls.length) {
    // 召回摘要追加
  }
}

function monitoringModal(m) {
  const name = { chemical: '化学监测', biological: '生物监测', bd_test: 'B-D 试验' }[m.kind];
  modal(`${name}${m.result ? '（原结果：' + (TAG[m.result] || m.result) + '）' : ''}`, `
    <label class="fld">结果 *</label>
    <select class="inp" id="mn-result">
      <option value="pass">合格 / 阴性</option>
      <option value="fail">${m.kind === 'biological' ? '阳性（立即冻结召回）' : '不合格（立即冻结）'}</option>
      <option value="pending">待检</option>
      ${m.kind !== 'biological' ? '<option value="na">不适用</option>' : ''}
    </select>
    <div class="space"></div>
    <label class="fld">结果描述 / 读数</label>
    <input class="inp" id="mn-value" placeholder="如：嗜热脂肪杆菌芽孢培养阴性；第5类指示物变色合格">
    <div class="space"></div>
    <label class="fld">备注</label><input class="inp" id="mn-note">
    <div class="space"></div>
    <label class="fld">${m.result ? '若改变结果，必须填写修改理由（追加留痕，原记录不可删除）' : '说明'}</label>
    <textarea class="inp" id="mn-reason" placeholder="例如：初读阳性，复核培养管污染，重新采样结果阴性……"></textarea>
    <div class="space"></div>
    <div class="alert-box ${m.kind === 'biological' ? 'red' : 'amber'}">${m.kind === 'biological'
      ? '⚠️ 一旦录入「阳性」，系统将立即锁定该批次全部器械（含已发往诊所、在途、在库），自动生成逐器械召回任务和不合格处置单。'
      : '化学监测不合格同样触发批次冻结。'}</div>
  `, { okText: '提交监测结果', onOk: async (close) => {
    try {
      const r = await api('POST', `/api/sterilizations/${m.id}/monitoring`, {
        kind: m.kind, result: $('#mn-result').value, value_text: $('#mn-value').value,
        note: $('#mn-note').value, reason: $('#mn-reason').value
      });
      if (r.frozen) toast(`已冻结批次并召回：${(r.clinics || []).join('、')}；处置单 ${r.ncr_no}`, 'err');
      else toast('监测结果已记录', 'ok');
      close(); go('sterlist', m.id);
    } catch (e) { toast(e.message, 'err'); }
  }});
  if (m.result) $('#mn-result').value = m.result;
}

function releaseModal(d, emergency) {
  modal(emergency ? '紧急放行（生物监测待检）' : '放行审核', `
    ${emergency ? `<div class="alert-box amber"><b>紧急放行风险提示：</b>生物监测结果尚未出具。本操作仅用于急诊手术等不可等待的情形；须审核人执行并持续跟踪 BI 结果，一旦阳性立即启动召回。</div>`
      : '<p>请复核：化学监测合格、生物监测阴性合格、装载与参数无误后放行。</p>'}
    <div class="space"></div>
    ${emergency ? '<label class="fld">紧急原因 *</label><textarea class="inp" id="rl-em" placeholder="如：急诊骨科手术急用，无备用无菌包，已报感控科同意"></textarea><div class="space"></div>' : ''}
    <label class="fld">放行审核意见 *</label>
    <textarea class="inp" id="rl-note" placeholder="复核意见，将写入批次记录与审计日志，不可删除">${emergency ? '' : '化学、生物监测均合格，装载与打印曲线复核无误，同意放行。'}</textarea>
  `, { okText: emergency ? '确认紧急放行' : '同意放行', onOk: async (close) => {
    try {
      await api('POST', `/api/sterilizations/${d.id}/release`, {
        note: $('#rl-note').value, emergency, emergency_reason: emergency ? $('#rl-em').value : undefined
      });
      toast(emergency ? '已紧急放行，请跟踪 BI 结果' : '批次已放行', 'ok');
      close(); go('sterlist', d.id);
    } catch (e) { toast(e.message, 'err'); }
  }});
  if (emergency) $('#m-ok').classList.add('warn');
}

function reviseModal(d) {
  modal('修改灭菌参数（追加留痕）', `
    <p class="muted">原值：${d.temperature}℃ / ${d.pressure}kPa / ${d.duration_min}min</p>
    <div class="space"></div>
    <div class="grid3">
      <div><label class="fld">温度 ℃</label><input class="inp" id="rv-temp" type="number" step="0.1" value="${d.temperature ?? ''}"></div>
      <div><label class="fld">压力 kPa</label><input class="inp" id="rv-pres" type="number" step="0.1" value="${d.pressure ?? ''}"></div>
      <div><label class="fld">时长 min</label><input class="inp" id="rv-dur" type="number" value="${d.duration_min ?? ''}"></div>
    </div>
    <div class="space"></div>
    <label class="fld">装载图</label><textarea class="inp" id="rv-load">${esc(d.load_diagram || '')}</textarea>
    <div class="space"></div>
    <label class="fld">循环参数</label><input class="inp" id="rv-cycle" value="${esc(d.cycle_params || '')}">
    <div class="space"></div>
    <label class="fld">修改理由 *（原记录保留，仅追加新版本）</label><textarea class="inp" id="rv-reason" placeholder="如：打印曲线复核补正"></textarea>
  `, { okText: '提交修改', onOk: async (close) => {
    try {
      await api('POST', `/api/sterilizations/${d.id}/revise`, {
        temperature: Number($('#rv-temp').value), pressure: Number($('#rv-pres').value), duration_min: Number($('#rv-dur').value),
        load_diagram: $('#rv-load').value, cycle_params: $('#rv-cycle').value, reason: $('#rv-reason').value
      });
      toast('修改已记录，历史版本保留', 'ok'); close(); go('sterlist', d.id);
    } catch (e) { toast(e.message, 'err'); }
  }});
}

function distributeModal(d) {
  const available = d.items.filter((i) => !['in_transit', 'in_use', 'recalled'].includes(i.status) && !(i.dist_status && ['in_transit', 'received', 'in_use'].includes(i.dist_status)));
  modal(`发放批次 ${d.batch_no}`, `
    ${d.status === 'emergency_released' ? '<div class="alert-box amber">本批次为紧急放行（BI 待检），请仅向急需诊所发放并跟踪结果。</div>' : ''}
    <div class="grid2">
      <div><label class="fld">接收诊所 *</label><select class="inp" id="ds-clinic">${state.meta.clinics.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div><label class="fld">交接人</label><input class="inp" id="ds-hand" placeholder="库房/配送人员姓名"></div>
    </div>
    <div class="space"></div>
    <label class="fld">勾选待发放器械（已在途/使用/召回的不可重复发放）</label>
    <div style="max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:8px">
      ${available.map((i) => `<label class="checkline"><input type="checkbox" class="ds-item" value="${i.id}">
        <span class="mono">${esc(i.uid)}</span><span class="muted">${esc(i.instrument_type)}</span><span class="grow"></span>${tag(i.status)}</label>`).join('') || '<p class="muted" style="padding:10px">没有可发放器械</p>'}
    </div>
  `, { okText: '确认发放并通知诊所', onOk: async (close) => {
    const items = $$('.ds-item:checked').map((c) => ({ instrument_id: Number(c.value) }));
    if (!items.length) return toast('请勾选器械', 'err');
    try {
      await api('POST', `/api/sterilizations/${d.id}/distribute`, {
        clinic_id: Number($('#ds-clinic').value), handover_person: $('#ds-hand').value, items
      });
      toast('已登记发放，诊所端可签收', 'ok'); close(); go('sterlist', d.id);
    } catch (e) { toast(e.message, 'err'); }
  }});
}

// ================= 发放与签收 =================
async function renderDistributions() {
  const rows = await api('GET', '/api/distributions');
  $('#content').innerHTML = `<div class="card"><h3>🚚 发放与签收 <span class="sub">记录交接人与时间；诊所确认收到后方可投入使用；召回后自动锁定不可使用</span></h3>
    <div class="table-wrap"><table><thead><tr><th>UID</th><th>器械</th><th>灭菌批次</th><th>诊所</th><th>状态</th><th>交接人/时间</th><th>接收人/时间</th><th>首次使用</th></tr></thead><tbody>
    ${rows.map((d) => `<tr>
      <td class="mono">${esc(d.uid)}</td><td>${esc(d.instrument_type)}</td><td class="mono">${esc(d.batch_no)}</td>
      <td>${esc(d.clinic_name)}</td><td>${tag(d.status)}</td>
      <td class="muted" style="font-size:12px">${esc(d.handover_person || '')}<br>${fmt(d.handed_at)}</td>
      <td class="muted" style="font-size:12px">${esc(d.receive_person || '')}<br>${fmt(d.received_at)}</td>
      <td class="muted">${fmt(d.first_used_at)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// ================= 差异确认 =================
async function renderDiscrepancies() {
  const rows = await api('GET', '/api/discrepancies');
  const isClinic = state.user.role === 'clinic';
  $('#content').innerHTML = `<div class="card"><h3>📝 差异记录流转 <span class="sub">回收现场标注 → 推送诊所确认；双方留痕</span></h3>
    <div class="table-wrap"><table><thead><tr><th>回收批号</th><th>诊所</th><th>器械</th><th>类型</th><th>数量</th><th>说明</th><th>状态</th><th>诊所回复</th><th class="right">操作</th></tr></thead><tbody>
    ${rows.map((d) => `<tr>
      <td class="mono">${esc(d.recycle_no)}</td><td>${esc(d.clinic_name)}</td><td>${esc(d.instrument_type)}</td>
      <td>${({ missing: '缺失', damaged: '损坏', fault: '功能异常', surplus: '多出' })[d.kind]}</td>
      <td>${d.qty}</td><td class="muted">${esc(d.detail)}</td><td>${tag(d.status)}</td><td class="muted">${esc(d.clinic_reply || '')}</td>
      <td class="right">${d.status === 'pending' ? `<button class="btn small" data-ok="${d.id}">确认</button> <button class="btn small danger" data-no="${d.id}">异议</button>` : '—'}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  $$('[data-ok]').forEach((b) => b.onclick = () => discrepancyReply(Number(b.dataset.ok), true));
  $$('[data-no]').forEach((b) => b.onclick = () => discrepancyReply(Number(b.dataset.no), false));
}
function discrepancyReply(id, accept) {
  modal(accept ? '确认差异' : '对差异提出异议', `
    <label class="fld">${accept ? '确认说明（可选）' : '异议说明 *'}</label>
    <textarea class="inp" id="dc-reply" placeholder="${accept ? '如：认可缺失，下次随租赁单补回' : '如：该器械已在上一批次归还，请核对'}"></textarea>
  `, { okText: accept ? '确认' : '提交异议', onOk: async (close) => {
    try {
      await api('POST', `/api/discrepancies/${id}/confirm`, { action: accept ? 'confirm' : 'reject', reply: $('#dc-reply').value });
      toast(accept ? '已确认' : '已提交异议', 'ok'); close(); go('discrepancies');
    } catch (e) { toast(e.message, 'err'); }
  }});
}

// ================= 召回任务 =================
async function renderRecalls() {
  const rows = await api('GET', '/api/recalls');
  const isClinic = state.user.role === 'clinic';
  $('#content').innerHTML = `<div class="card"><h3>🚨 召回任务 <span class="sub">阳性/不合格批次自动按器械去向逐件生成；诊所确认停用→登记退回；全过程留痕</span></h3>
    <div class="table-wrap"><table><thead><tr><th>UID</th><th>器械</th><th>去向诊所</th><th>状态</th><th>通知内容</th><th>通知/确认/退回时间</th><th class="right">操作</th></tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td class="mono">${esc(r.uid)}</td><td>${esc(r.instrument_type)}</td><td>${esc(r.clinic_name)}</td>
      <td>${tag(r.status)}</td><td class="muted" style="max-width:280px">${esc(r.message)}</td>
      <td class="muted" style="font-size:12px">通知 ${fmt(r.notified_at)}<br>确认 ${fmt(r.acknowledged_at)}<br>退回 ${fmt(r.returned_at)}</td>
      <td class="right" style="white-space:nowrap">
        ${r.status === 'notified' ? `<button class="btn small" data-ack="${r.id}">确认停用封存</button> <button class="btn small danger" data-ret2="${r.id}">登记退回</button>` : ''}
        ${r.status === 'acknowledged' ? `<button class="btn small" data-ret2="${r.id}">登记退回</button>` : ''}
        ${['returned', 'cancelled'].includes(r.status) ? '—' : ''}
      </td></tr>`).join('')}
    </tbody></table></div></div>`;
  const handler = (id, action, reply) => api('POST', `/api/recalls/${id}/${action}`, { reply });
  $$('[data-ack]').forEach((b) => b.onclick = async () => { await handler(b.dataset.ack, 'ack', '已停用封存'); toast('已确认停用封存', 'ok'); go('recalls'); });
  $$('[data-ret2]').forEach((b) => b.onclick = async () => { await handler(b.dataset.ret2, 'return', '已交配送带回'); toast('退回已登记', 'ok'); go('recalls'); });
}

// ================= 不合格处置（NCR） =================
async function renderNcrs() {
  const rows = await api('GET', '/api/ncrs');
  $('#content').innerHTML = `<div class="card"><h3>⚠️ 不合格处置单 <span class="sub">阳性自动生成；填写原因分析、纠正与预防措施，返工重新清洗灭菌，合格放行后自动闭环</span></h3>
    <div class="table-wrap"><table><thead><tr><th>单号</th><th>灭菌批次</th><th>原因</th><th>状态</th><th>返工批次</th><th>创建时间</th><th></th></tr></thead><tbody>
    ${rows.map((n) => `<tr>
      <td class="mono">${esc(n.ncr_no)}</td><td class="mono">${esc(n.batch_no)}</td><td>${esc(n.reason || '')}</td>
      <td>${tag(n.status)}</td><td>${n.new_ster_batch_id ? '#' + n.new_ster_batch_id : '—'}</td><td class="muted">${fmt(n.created_at)}</td>
      <td><button class="btn small ${n.status !== 'closed' ? 'primary' : ''}" data-ncr="${n.id}">${n.status === 'closed' ? '查看' : '处理'}</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
  $$('[data-ncr]').forEach((b) => b.onclick = () => ncrModal(Number(b.dataset.ncr)));
}

async function ncrModal(id) {
  const n = await api('GET', '/api/ncrs/' + id);
  const eq = state.meta.equipment;
  const body = `
    ${n.status === 'closed' ? '<div class="alert-box blue">本处置单已闭环：返工批次已重新清洗灭菌并监测合格放行。历史追加记录保留在下方。</div>' : '<div class="alert-box red">批次冻结中。完成原因分析与整改后，发起返工（重新清洗 + 更换/检修灭菌器重新灭菌）。</div>'}
    <dl class="kv"><dt>单号</dt><dd class="mono">${esc(n.ncr_no)}</dd><dt>批次</dt><dd class="mono">${esc(n.batch_no)}</dd><dt>状态</dt><dd>${tag(n.status)}</dd></dl>
    <div class="space"></div>
    <label class="fld">直接原因</label><input class="inp" id="n-reason" value="${esc(n.reason || '')}">
    <div class="space"></div>
    <label class="fld">原因分析 *</label><textarea class="inp" id="n-rca" placeholder="如：灭菌器门密封圈老化，脉动真空时密封不严，冷空气残留，温度不达标">${esc(n.root_cause_analysis || '')}</textarea>
    <div class="space"></div>
    <label class="fld">纠正（整改）措施 *</label><textarea class="inp" id="n-ca" placeholder="如：更换门密封圈，完成B-D试验合格；STE-B02停用检修">${esc(n.corrective_action || '')}</textarea>
    <div class="space"></div>
    <label class="fld">预防措施</label><textarea class="inp" id="n-pa" placeholder="如：建立密封圈月检与按周期强制更换台账；操作员再培训">${esc(n.preventive_action || '')}</textarea>
    <div class="space"></div>
    <label class="fld">本次填写/变更说明（留痕）</label><input class="inp" id="n-change" placeholder="如：设备科现场排查确认">
    <div class="space"></div>
    ${n.status !== 'closed' ? `<div class="card" style="background:#f8fafc">
      <b>发起返工（重新清洗灭菌）</b>
      <div class="space"></div>
      <div class="grid3">
        <div><label class="fld">重洗设备</label><select class="inp" id="n-washer">${eq.filter((e) => e.type === 'washer').map((e) => `<option value="${e.id}">${esc(e.code)}</option>`).join('')}</select></div>
        <div><label class="fld">重灭灭菌器 *</label><select class="inp" id="n-ster">${eq.filter((e) => e.type === 'sterilizer').map((e) => `<option value="${e.id}">${esc(e.code)}</option>`).join('')}</select></div>
        <div><label class="fld">返工后化学</label><select class="inp" id="n-chem"><option value="pass">合格</option><option value="pending">待判读</option></select></div>
      </div>
      <div class="space"></div>
      <div class="row">
        <label class="fld grow" style="margin:0">返工后生物监测：通常需重新培养，保持待检，合格后再放行</label>
        <select class="inp" id="n-bio" style="width:160px"><option value="pending">待检（推荐）</option><option value="pass">直接合格</option></select>
        <button class="btn warn" id="n-rework">🔁 保存分析并发起返工</button>
      </div>
    </div>` : ''}
    <div class="space"></div>
    <b>历史追加（不可删除）</b>
    <div class="space"></div>
    ${(n.history || []).length ? `<div class="timeline">${n.history.map((h) => `<div class="ev"><div><b>${esc(({ reason: '直接原因', root_cause_analysis: '原因分析', corrective_action: '整改措施', preventive_action: '预防措施', status: '状态' })[h.field] || h.field)}</b>：<span class="muted">${esc(h.old_value || '空')}</span> → ${esc(h.new_value || '空')}</div><div class="muted" style="font-size:12px">${esc(h.changer_name || '')} · ${fmt(h.changed_at)} · 理由：${esc(h.reason)}</div></div>`).join('')}</div>` : '<p class="muted">暂无修改记录</p>'}
  `;
  const m = modal(`不合格处置单 ${n.ncr_no}`, body, { wide: true, foot: n.status !== 'closed' });
  const ok = $('#m-ok');
  if (ok) ok.textContent = '保存分析/整改';
  if (ok) ok.onclick = async () => {
    try {
      await api('POST', `/api/ncrs/${id}/analyze`, {
        reason: $('#n-reason').value, root_cause_analysis: $('#n-rca').value,
        corrective_action: $('#n-ca').value, preventive_action: $('#n-pa').value, change_reason: $('#n-change').value
      });
      toast('分析整改已追加留痕', 'ok'); m.close(); go('ncrs');
    } catch (e) { toast(e.message, 'err'); }
  };
  const rw = $('#n-rework');
  if (rw) rw.onclick = async () => {
    try {
      const r = await api('POST', `/api/ncrs/${id}/rework`, {
        washer_id: Number($('#n-washer').value), sterilizer_id: Number($('#n-ster').value),
        root_cause_analysis: $('#n-rca').value, corrective_action: $('#n-ca').value, preventive_action: $('#n-pa').value,
        chemical_result: $('#n-chem').value, biological_result: $('#n-bio').value
      });
      toast(`返工批次 #${r.newId} 已创建，监测合格后请审核人放行`, 'ok'); m.close(); go('sterlist', r.newId);
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ================= 专项检查 =================
async function renderInspections() {
  const rows = await api('GET', '/api/inspections');
  $('#content').innerHTML = `<div class="card"><h3>🔍 异常批次专项检查 <span class="sub">督导员发起，填写检查记录与整改情况并跟踪闭环（仅督导员）</span></h3>
    <div class="row"><button class="btn primary" id="new-insp">＋ 发起专项检查</button><span class="muted grow">共 ${rows.length} 项</span></div>
    <div class="space"></div>
    <div class="table-wrap"><table><thead><tr><th>主题</th><th>关联批次</th><th>发起原因</th><th>状态</th><th>发起人/时间</th><th></th></tr></thead><tbody>
    ${rows.map((x) => `<tr><td>${esc(x.title)}</td><td class="mono">${esc(x.batch_no || '—')}</td><td class="muted">${esc(x.trigger_reason || '')}</td>
      <td>${tag(x.status)}</td><td class="muted" style="font-size:12px">${esc(x.starter_name)}<br>${fmt(x.started_at)}</td>
      <td><button class="btn small ${x.status !== 'closed' ? 'primary' : ''}" data-insp="${x.id}">${x.status === 'closed' ? '查看' : '检查记录'}</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('#new-insp').onclick = () => modal('发起专项检查', `
    <label class="fld">检查主题 *</label><input class="inp" id="i-title" placeholder="如：MJ... 批次生物监测阳性专项排查">
    <div class="space"></div><label class="fld">关联灭菌批次号（可选）</label><input class="inp" id="i-batch" placeholder="MJ20260920-02">
    <div class="space"></div><label class="fld">发起原因</label><textarea class="inp" id="i-reason"></textarea>
  `, { okText: '发起', onOk: async (close) => {
    let sbId = null;
    const bn = $('#i-batch').value.trim();
    if (bn) {
      try { const tr = await api('GET', '/api/trace/batch?batch_no=' + encodeURIComponent(bn)); sbId = tr.batch.id; }
      catch { return toast('关联批次号不存在', 'err'); }
    }
    await api('POST', '/api/inspections', { title: $('#i-title').value, trigger_reason: $('#i-reason').value, ster_batch_id: sbId });
    toast('专项检查已发起', 'ok'); close(); go('inspections');
  }});
  $$('[data-insp]').forEach((b) => b.onclick = () => inspModal(Number(b.dataset.insp)));
}
async function inspModal(id) {
  const rows = await api('GET', '/api/inspections');
  const x = rows.find((r) => r.id === id);
  modal(x.title, `
    <dl class="kv"><dt>状态</dt><dd>${tag(x.status)}</dd><dt>批次</dt><dd class="mono">${esc(x.batch_no || '—')}</dd><dt>发起</dt><dd>${esc(x.starter_name)} · ${fmt(x.started_at)}</dd><dt>闭环</dt><dd>${esc(x.closer_name || '—')} · ${fmt(x.closed_at)}</dd></dl>
    <div class="space"></div>
    <label class="fld">检查记录（发现的问题，追加保存）</label><textarea class="inp" id="sp-find">${esc(x.findings || '')}</textarea>
    <div class="space"></div>
    <label class="fld">整改情况 / 验收结论</label><textarea class="inp" id="sp-rec">${esc(x.rectification || '')}</textarea>
    <div class="space"></div>
    <label class="fld">本次追加说明（留痕理由）</label><input class="inp" id="sp-reason" placeholder="如：现场复核补充">
  `, { wide: true, okText: x.status === 'closed' ? '已闭环' : '保存记录', onOk: x.status === 'closed' ? undefined : async (close) => {
    try {
      const r = await api('POST', `/api/inspections/${id}/update`, {
        findings: $('#sp-find').value, rectification: $('#sp-rec').value, change_reason: $('#sp-reason').value
      });
      toast('检查记录已保存（' + ({ rectifying: '整改中' }[r.status] || r.status) + '）', 'ok'); close(); go('inspections');
    } catch (e) { toast(e.message, 'err'); }
  }, onShow: () => {
    if (x.status !== 'closed') {
      const foot = $('.modal-foot');
      const closeBtn = document.createElement('button');
      closeBtn.className = 'btn success'; closeBtn.textContent = '✔ 验收通过并闭环';
      closeBtn.style.background = 'var(--green)'; closeBtn.style.color = '#fff'; closeBtn.style.borderColor = 'var(--green)';
      closeBtn.onclick = async () => {
        try {
          await api('POST', `/api/inspections/${id}/update`, {
            findings: $('#sp-find').value, rectification: $('#sp-rec').value, action: 'close', change_reason: $('#sp-reason').value || '整改验收通过'
          });
          toast('专项检查已闭环', 'ok'); $('.modal-mask').remove(); go('inspections');
        } catch (e) { toast(e.message, 'err'); }
      };
      foot.insertBefore(closeBtn, $('#m-ok'));
    }
  }});
}

// ================= 双向追溯 =================
async function renderTrace() {
  $('#content').innerHTML = `
  <div class="card">
    <h3>🔗 双向追溯查询 <span class="sub">单件反查全历程 / 批次正查全部器械去向；问题发生时几分钟内圈定受影响范围</span></h3>
    <div class="grid2">
      <div class="card" style="margin:0">
        <b>① 单件反查</b>
        <p class="muted" style="margin:6px 0">输入器械唯一标识 UID，查询它经历过的全部灭菌批次、化学/生物监测结果、去向诊所与使用时间。</p>
        <div class="row"><input class="inp" id="tr-uid" placeholder="如 UID-00070"><button class="btn primary" id="tr-uid-btn">查询</button></div>
      </div>
      <div class="card" style="margin:0">
        <b>② 批次正查</b>
        <p class="muted" style="margin:6px 0">输入灭菌批次号，查出该批次全部器械、每件去向诊所、交接/签收/使用时间。</p>
        <div class="row"><input class="inp" id="tr-batch" placeholder="如 MJ20260920-02"><button class="btn primary" id="tr-batch-btn">查询</button></div>
      </div>
    </div>
    <div class="space"></div>
    <div class="card" style="margin:0;background:#f8fafc">
      <b>③ 应急影响面速查</b>
      <p class="muted" style="margin:6px 0">输入批次号或任一 UID，一键汇总受影响器械清单与按诊所分布（在库/在途/已签收/已使用数量）。</p>
      <div class="row"><input class="inp" id="tr-q" placeholder="批次号或 UID"><button class="btn danger" id="tr-q-btn">🚨 圈定影响面</button></div>
    </div>
  </div>
  <div id="tr-result"></div>`;
  $('#tr-uid-btn').onclick = async () => {
    try {
      const d = await api('GET', '/api/trace/instrument?uid=' + encodeURIComponent($('#tr-uid').value.trim()));
      $('#tr-result').innerHTML = instrumentTraceHtml(d);
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#tr-batch-btn').onclick = async () => {
    try {
      const d = await api('GET', '/api/trace/batch?batch_no=' + encodeURIComponent($('#tr-batch').value.trim()));
      $('#tr-result').innerHTML = batchTraceHtml(d);
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#tr-q-btn').onclick = async () => {
    try {
      const d = await api('GET', '/api/trace/impact?q=' + encodeURIComponent($('#tr-q').value.trim()));
      $('#tr-result').innerHTML = impactHtml(d);
    } catch (e) { toast(e.message, 'err'); }
  };
}

function instrumentTraceHtml(d) {
  return `<div class="card"><h3>🔖 单件追溯：${esc(d.instrument.uid)}</h3>
    <dl class="kv"><dt>器械类型</dt><dd>${esc(d.instrument.instrument_type)}</dd><dt>当前状态</dt><dd>${tag(d.instrument.status)}</dd>
      <dt>来源回收</dt><dd class="mono">${esc(d.recycle.batch_no)}（${esc(d.recycle.clinic_name)}）· ${fmt(d.recycle.received_at)}</dd></dl>
    <div class="space"></div>
    <b>清洗消毒记录</b>${d.washes.map((w) => `<p class="muted" style="margin-top:4px">${fmt(w.washed_at)} · ${esc(w.equipment_code)} · ${esc(w.program)} · ${w.temperature}℃ · ${w.duration_min}min</p>`).join('')}
    <div class="space"></div>
    <b>灭菌 / 监测 / 去向历程（${d.lifecycle.length} 个批次）</b>
    <div class="space"></div>
    <div class="timeline">${d.lifecycle.map((l) => `<div class="ev ${l.biological === 'fail' ? 'fail' : (l.biological === 'pass' ? 'ok' : '')}">
      <div><b class="mono">${esc(l.batch_no)}</b> ${tag(l.status)} · ${esc(l.sterilizer_code)} · ${fmt(l.sterilized_at)}</div>
      <div style="margin:4px 0">化学 ${tag(l.chemical)} ｜ 生物 ${tag(l.biological)}</div>
      <div class="muted">${l.clinic_name ? `去向：${esc(l.clinic_name)}（${tag(l.dist_status)}）交接 ${fmt(l.handed_at)} / 签收 ${fmt(l.received_at)} / 首次使用 ${fmt(l.first_used_at)}` : '中心库房，未发放'}${l.recall_status ? ` ｜ <b style="color:var(--red)">召回：${TAG[l.recall_status]}</b>` : ''}</div>
    </div>`).join('')}</div></div>`;
}

function batchTraceHtml(d) {
  return `<div class="card"><h3>📦 批次正查：${esc(d.batch.batch_no)} ${tag(d.batch.status)}</h3>
    <dl class="kv"><dt>灭菌器</dt><dd class="mono">${esc(d.batch.sterilizer_code)}</dd><dt>时间</dt><dd>${fmt(d.batch.sterilized_at)}</dd>
      <dt>监测</dt><dd>${d.monitoring.map((m) => `${({ chemical: '化学', biological: '生物', bd_test: 'B-D' })[m.kind]} ${tag(m.result)}`).join('　')}</dd>
      <dt>涉及诊所</dt><dd>${Object.keys(d.affected_clinics).length ? Object.entries(d.affected_clinics).map(([k, v]) => `${esc(k)} ${v} 件`).join('；') : '均在库'}</dd></dl>
    <div class="space"></div>
    <div class="table-wrap"><table><thead><tr><th>UID</th><th>器械</th><th>状态</th><th>诊所</th><th>发放状态</th><th>交接</th><th>签收</th><th>首次使用</th><th>召回</th></tr></thead><tbody>
    ${d.items.map((i) => `<tr><td class="mono">${esc(i.uid)}</td><td>${esc(i.instrument_type)}</td><td>${tag(i.status)}</td>
      <td>${esc(i.clinic_name || '中心库房')}</td><td>${tag(i.dist_status)}</td><td class="muted">${fmt(i.handed_at)}</td>
      <td class="muted">${fmt(i.received_at)}</td><td class="muted">${fmt(i.first_used_at)}</td><td>${tag(i.recall_status)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

function impactHtml(d) {
  return `<div class="card"><h3>🚨 影响面圈定：${esc(d.batch_no)} ${tag(d.status)}</h3>
    ${d.freeze_reason ? `<div class="alert-box red">冻结原因：${esc(d.freeze_reason)}</div>` : ''}
    <div class="stat-grid">
      <div class="stat ${d.freeze_reason ? 'alert' : ''}"><div class="num">${d.total_instruments}</div><div class="lbl">受影响器械总数</div></div>
      ${d.clinics.map((c) => `<div class="stat ${c.clinic !== '中心库房' ? 'warn' : 'ok'}"><div class="num">${c.total}</div><div class="lbl">${esc(c.clinic)}（在途${c.in_transit}/签收${c.received}/使用${c.in_use}/在库${c.in_stock}）</div></div>`).join('')}
    </div>
    <b>逐件清单与去向</b>
    <div class="space"></div>
    <div class="table-wrap"><table><thead><tr><th>UID</th><th>器械</th><th>位置/诊所</th><th>状态</th><th>使用时间</th><th>召回</th></tr></thead><tbody>
    ${d.instruments.map((i) => `<tr><td class="mono">${esc(i.uid)}</td><td>${esc(i.type)}</td><td>${esc(i.clinic)}</td><td>${tag(i.status)}</td><td class="muted">${fmt(i.first_used_at)}</td><td>${tag(i.dist_status === 'recalled' ? 'recalled' : '')}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// ================= 器械台账 =================
async function renderInstruments() {
  $('#content').innerHTML = `<div class="card"><h3>🔖 单件器械台账 <span class="sub">每件器械的唯一标识、当前状态、所在诊所与最近灭菌批次</span></h3>
    <div class="row">
      <input class="inp" id="ins-uid" placeholder="按 UID 搜索" style="max-width:240px">
      <select class="inp" id="ins-status" style="max-width:180px"><option value="">全部状态</option>
        ${['recycled','washed','packed','sterilized','released','in_transit','in_use','frozen','recalled','reworked'].map((s) => `<option value="${s}">${TAG[s]}</option>`).join('')}
      </select>
      <button class="btn primary" id="ins-search">查询</button>
    </div>
    <div class="space"></div>
    <div id="ins-list" class="table-wrap">加载中…</div></div>`;
  const load = async () => {
    const p = new URLSearchParams();
    if ($('#ins-uid').value.trim()) p.set('uid', $('#ins-uid').value.trim());
    if ($('#ins-status').value) p.set('status', $('#ins-status').value);
    const rows = await api('GET', '/api/instruments?' + p.toString());
    $('#ins-list').innerHTML = `<table><thead><tr><th>UID</th><th>器械</th><th>状态</th><th>当前所在</th><th>最近灭菌批次</th><th></th></tr></thead><tbody>
      ${rows.map((i) => `<tr><td class="mono">${esc(i.uid)}</td><td>${esc(i.instrument_type)}</td><td>${tag(i.status)}</td>
        <td>${esc(i.current_clinic_name || '中心库房')}</td><td class="mono">${esc(i.last_batch || '—')}</td>
        <td><button class="btn small" data-trace="${esc(i.uid)}">追溯</button></td></tr>`).join('')}
    </tbody></table>`;
    $$('[data-trace]').forEach((b) => b.onclick = () => { $('#tr-uid') ? go('trace') : go('trace'); setTimeout(() => { $('#tr-uid').value = b.dataset.trace; $('#tr-uid-btn').click(); }, 150); });
  };
  $('#ins-search').onclick = load;
  load();
}

// ================= 感控报表 =================
async function renderReports() {
  const d = await api('GET', '/api/reports/quality');
  $('#content').innerHTML = `
  <div class="card"><h3>📊 感控质量报表 <span class="sub">批次合格率、BI/化学监测、灭菌器分布、召回闭环；导出操作自动留痕</span></h3>
    <div class="row"><button class="btn primary" id="rp-export">⬇ 导出批次明细（JSON，留痕）</button><span class="muted grow">生成时间 ${fmt(d.generated_at)}</span></div></div>
  <div class="stat-grid">
    <div class="stat"><div class="num">${d.summary.total_batches}</div><div class="lbl">灭菌批次总数</div></div>
    <div class="stat ok"><div class="num">${d.summary.bi_pass || 0}</div><div class="lbl">生物监测合格</div></div>
    <div class="stat alert"><div class="num">${d.summary.bi_fail || 0}</div><div class="lbl">生物监测阳性</div></div>
    <div class="stat alert"><div class="num">${d.summary.chem_fail || 0}</div><div class="lbl">化学监测不合格</div></div>
    <div class="stat warn"><div class="num">${d.summary.frozen_batches || 0}</div><div class="lbl">冻结批次</div></div>
    <div class="stat"><div class="num">${d.recalls.total || 0}</div><div class="lbl">召回任务（待退回 ${d.recalls.pending || 0}）</div></div>
  </div>
  <div class="grid2">
    <div class="card"><h3>按灭菌器</h3><table><thead><tr><th>设备</th><th>名称</th><th>批次数</th><th>冻结</th></tr></thead><tbody>
      ${d.bySterilizer.map((x) => `<tr><td class="mono">${esc(x.code)}</td><td>${esc(x.name)}</td><td>${x.batches}</td><td>${x.frozen ? `<b style="color:var(--red)">${x.frozen}</b>` : 0}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="card"><h3>按诊所发放</h3><table><thead><tr><th>诊所</th><th>涉及批次</th><th>发放件次</th></tr></thead><tbody>
      ${d.byClinic.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.batches}</td><td>${x.distributed}</td></tr>`).join('')}
    </tbody></table></div>
  </div>
  <div class="card"><h3>异常批次台账</h3><div class="table-wrap"><table><thead><tr><th>批次</th><th>灭菌器</th><th>化学</th><th>生物</th><th>状态</th><th>原因</th><th>时间</th></tr></thead><tbody>
    ${d.abnormal.map((x) => `<tr><td class="mono">${esc(x.batch_no)}</td><td class="mono">${esc(x.sterilizer_code)}</td><td>${tag(x.chem)}</td><td>${tag(x.bio)}</td><td>${tag(x.status)}</td><td class="muted">${esc(x.freeze_reason || '')}</td><td class="muted">${fmt(x.sterilized_at)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">无异常</td></tr>'}
  </tbody></table></div>
  <div class="space"></div><b>处置单状态：</b>${d.ncrs.map((n) => `${TAG[n.status]} ${n.c} 件`).join('；') || '无'}</div>`;
  $('#rp-export').onclick = async () => {
    const res = await fetch('/api/reports/export?type=quality&t=' + Date.now(), { headers: { 'Authorization': 'Bearer ' + state.token } });
    if (!res.ok) return toast('导出失败', 'err');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cssd_quality_report_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('报表已导出，操作已写入导出留痕', 'ok');
  };
}

// ================= 审计日志 =================
async function renderAudit() {
  const rows = await api('GET', '/api/audit?limit=300');
  $('#content').innerHTML = `<div class="card"><h3>🗂️ 操作审计日志 <span class="sub">所有关键操作、参数/结果/放行修改均不可删除，仅可追加说明并记录理由</span></h3>
    <div class="table-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>角色</th><th>动作</th><th>对象</th><th>详情</th></tr></thead><tbody>
    ${rows.map((a) => `<tr><td class="muted" style="white-space:nowrap">${fmt(a.created_at)}</td><td>${esc(a.actor_name || '系统')}</td>
      <td>${({ operator: '操作员', reviewer: '审核人', supervisor: '督导员', clinic: '诊所', system: '系统' })[a.role] || a.role}</td>
      <td><b>${esc(a.action)}</b></td><td class="muted">${esc(a.entity || '')} ${a.entity_id ?? ''}</td>
      <td class="muted" style="max-width:420px;word-break:break-all;font-size:12px">${esc((a.detail || '').slice(0, 300))}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// ================= 诊所工作台（入口占位） =================
async function renderClinicHome() {
  $('#content').innerHTML = '<div class="muted">加载中…</div>';
  const d = await api('GET', '/api/dashboard');
  $('#content').innerHTML = await clinicDashboardHtml(d);
}

// ================= 启动 =================
async function boot() {
  $('#login-btn').onclick = doLogin;
  $('#login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#logout-btn').onclick = () => doLogout(true);
  if (state.token) {
    try {
      await loadMeta();
      enterApp();
    } catch { doLogout(false); }
  }
}
async function doLogin() {
  try {
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#login-username').value.trim(), password: $('#login-password').value }) });
    const data = await res.json();
    if (!res.ok) return toast(data.error || '登录失败', 'err');
    state.token = data.token; state.user = data.user;
    localStorage.setItem('cssd_token', state.token);
    await loadMeta();
    enterApp();
    toast(`欢迎，${state.meta.role_name}`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}
function enterApp() {
  $('#login-view').style.display = 'none';
  $('#app-view').style.display = 'flex';
  $('#user-name').textContent = `${state.user.name}（${state.user.username}）`;
  const badge = $('#role-badge');
  badge.textContent = state.meta.role_name;
  badge.className = 'badge ' + state.user.role;
  go(state.user.role === 'clinic' ? 'clinic_home' : 'dashboard');
}
async function doLogout(showMsg) {
  try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + state.token } }); } catch {}
  state.token = ''; state.user = null;
  localStorage.removeItem('cssd_token');
  $('#app-view').style.display = 'none';
  $('#login-view').style.display = 'flex';
  if (showMsg) toast('已退出登录', 'info');
}
boot();
