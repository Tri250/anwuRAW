/* 业务页面：订单 · POS · 库存 · 调拨 · 采购 · 回款 · 应收 · 商品 · 门店 · 用户 · 促销 */
import { API } from './api.js';
import {
  h, $, $$, fmtMoney, fmtNum, fmtQty, fmtDay, fmtTime, ROLE_NAME, chip, statusChip,
  ORDER_STATUS, TRANSFER_STATUS, MOVE_TYPE, empty, errCard, table, icon, toast, modal,
  confirmBox, field, stepper, skeleton, pipeline,
} from './ui.js';

/* ============ 工具 ============ */
const loadProducts = () => API.get('/api/products');
const loadLocations = () => API.get('/api/locations');
const catName = (c) => (c === 'bag' ? '袋装' : '盒装');
const CAT_CHIP = (c) => chip(catName(c), c === 'bag' ? 'brand' : 'gold');
const userCan = (...roles) => roles.includes(API.user.role);

/* 商品行编辑器（箱/散）：返回 { el, get } */
function qtyRows(products, { withStock = null } = {}) {
  const rows = products.map((p) => {
    const cartons = stepper(0, () => calc(), { min: 0 });
    const loose = stepper(0, () => calc(), { min: 0 });
    const stockEl = h('span', { class: 'chip grey' }, '—');
    const row = h('tr', {},
      h('td', {}, h('b', {}, p.name), h('div', { style: 'font-size:11px;color:var(--ink-3)' }, `${catName(p.category)} · 200ml × ${p.units_per_carton}/箱`)),
      withStock ? h('td', { align: 'center' }, stockEl) : null,
      h('td', { align: 'center' }, cartons),
      h('td', { align: 'center' }, loose),
      h('td', { class: 'ta-r sub-amt', style: 'font-weight:700' }, '—'));
    const get = () => ({
      product_id: p.id, cartons: Number(cartons.querySelector('input').value) || 0,
      loose: Number(loose.querySelector('input').value) || 0,
    });
    function calc() {
      const c = Number(cartons.querySelector('input').value) || 0;
      const l = Number(loose.querySelector('input').value) || 0;
      row.querySelector('.sub-amt').textContent = c + l > 0
        ? fmtMoney(c * p.wholesale_price + l * Math.round(p.wholesale_price / p.units_per_carton)) : '—';
      if (withStock) withStock(p, get()).then((t) => { stockEl.outerHTML = t.outerHTML; }).catch(() => {});
    }
    return { row, get, p };
  });
  return rows;
}

/* 数量录入表格（调拨/采购弹窗共用） */
function buildQtyTable(rows) {
  return h('div', { class: 'tbl-wrap' },
    h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {},
        h('th', {}, '商品'),
        h('th', { class: 'ta-c', style: 'width:110px' }, '整箱'),
        h('th', { class: 'ta-c', style: 'width:96px' }, '散件'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', {}, h('b', {}, r.p.name), h('span', { style: 'font-size:11px;color:var(--ink-3);margin-left:4px' }, catName(r.p.category))),
        h('td', { align: 'center' }, r.cartons), h('td', { align: 'center' }, r.loose))))));
}

/* ============ 订单列表 ============ */
export async function pageOrders(root) {
  const u = API.user;
  const seg = h('div', { class: 'seg' });
  const body = h('div', {});
  const tabs = [['', '全部'], ['draft', '草稿'], ['pending', '待审批'], ['approved', '待出库'], ['shipped', '待回款'], ['done', '已完成'], ['rejected', '已驳回'], ['cancelled', '已取消']];
  let cur = '';
  const render = async () => {
    body.innerHTML = '';
    body.append(skeleton(5));
    try {
      const rows = await API.get(`/api/orders?days=60${cur ? `&status=${cur}` : ''}`);
      body.innerHTML = '';
      if (!rows.length) { body.append(h('div', { class: 'card' }, empty('暂无订单', u.role === 'sal' ? '点击「新建订单」开始开单' : u.role === 'prm' ? '去工作台零售开单' : '', '🧾'))); return; }
      const cols = [
        { title: '订单号', render: (o) => h('a', { href: `#/orders/${o.id}`, style: 'font-weight:700' }, o.no) },
        { title: '类型', align: 'center', render: (o) => chip(o.type === 'wholesale' ? '批发' : '零售', o.type === 'wholesale' ? 'brand' : 'gold') },
        { title: '门店', render: (o) => o.store_name },
      ];
      if (!userCan('sal')) cols.push({ title: '业务员', render: (o) => o.salesman_name });
      cols.push(
        { title: '金额', align: 'right', render: (o) => h('b', {}, fmtMoney(o.payable)) },
        { title: '状态', align: 'center', render: (o) => statusChip(ORDER_STATUS, o.status) },
        { title: '时间', render: (o) => fmtDay(o.created_at) },
        { title: '', align: 'right', render: (o) => h('a', { class: 'btn sm ghost', href: `#/orders/${o.id}` }, '详情') });
      body.append(h('div', { class: 'card' },
        h('div', { class: 'card-hd' }, h('b', {}, `订单记录（${rows.length}）`), h('div', { class: 'hd-right' },
          u.role === 'sal' ? h('a', { class: 'btn sm', href: '#/orders/new' }, '+ 新建订单') : null)),
        table(cols, rows, { minWidth: 640 })));
    } catch (e) { body.innerHTML = ""; body.append(errCard(e, render)); }
  };
  for (const [k, label] of tabs) {
    if (userCan('sal', 'prm') && (k === 'rejected' || k === 'cancelled')) continue;
    const s = h('s', { onclick: () => { cur = k; $$('.seg s', seg).forEach((x) => x.classList.remove('on')); s.classList.add('on'); render(); } }, label);
    if (k === cur) s.classList.add('on');
    seg.append(s);
  }
  root.append(seg, body);
  await render();
}

/* ============ 订单详情 ============ */
export async function pageOrderDetail(root, id) {
  let o;
  try { o = await API.get(`/api/orders/${id}`); } catch (e) {
    root.append(h('div', { class: 'card' }, empty('无法加载订单', e.message, '⚠'))); return;
  }
  const u = API.user;
  const isRetail = o.type === 'retail';
  const steps = isRetail ? ['创建', '结算', '完成'] : ['创建', '审批', '出库', '回款', '完成'];
  const stepIdx = isRetail
    ? { done: 2 }[o.status] ?? 1
    : { draft: 0, pending: 1, approved: 1, partial: 2, shipped: 2, done: 4, rejected: 1, cancelled: 0 }[o.status];
  const bad = o.status === 'rejected' || o.status === 'cancelled' ? 1 : -1;
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-hd' },
      h('b', {}, `${o.no}`), statusChip(ORDER_STATUS, o.status),
      h('div', { class: 'hd-right' }, h('a', { class: 'btn ghost sm', href: '#/orders' }, '← 返回列表'))),
    pipeline(steps, stepIdx, bad),
    h('div', { class: 'grid g4', style: 'margin-top:6px' },
      kvCell('门店', o.store_name), kvCell('业务员', o.salesman_name),
      kvCell('类型', o.type === 'wholesale' ? '批发（账期/现结）' : '零售现结'),
      kvCell('下单时间', fmtTime(o.created_at))),
    o.reject_reason ? h('div', { style: 'margin-top:10px;padding:10px 14px;background:var(--danger-soft);border-radius:10px;font-size:13px;color:var(--danger)' }, `⚠ ${o.status === 'rejected' ? '驳回原因' : '取消原因'}：${o.reject_reason}`) : null));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-hd' }, h('b', {}, '商品明细'), h('span', { class: 'chip grey' }, `${o.items.length} 行`)),
    table([
      { title: '商品', render: (i) => h('div', {}, h('b', {}, i.product_name), i.kind === 'gift' ? h('span', { class: 'chip gold', style: 'margin-left:6px' }, '促销赠送') : null) },
      { title: '数量', align: 'center', render: (i) => fmtQty(i.qty, i.units_per_carton) },
      { title: '单价(散)', align: 'right', render: (i) => (i.unit_price ? fmtMoney(i.unit_price) : '—') },
      { title: '金额', align: 'right', render: (i) => (i.kind === 'gift' ? h('s', { style: 'color:var(--ink-3)' }, '赠') : h('b', {}, fmtMoney(i.amount))) },
      { title: '已出库', align: 'center', render: (i) => (o.type === 'retail' ? '现结即出' : i.shipped_qty >= i.qty ? chip('齐', 'ok') : chip(`${fmtQty(i.shipped_qty, i.units_per_carton)}`, 'info')) },
    ], o.items, { minWidth: 560 }),
    h('div', { style: 'display:flex;flex-direction:column;gap:4px;margin-top:12px;font-size:13.5px' },
      moneyLine('商品金额', o.items_amount),
      o.discount > 0 ? moneyLine('审批优惠', -o.discount, 'bad') : null,
      moneyLine('应收合计', o.payable, true),
      moneyLine('已回款', o.paid, false, 'var(--ok)'),
      o.payable - o.paid > 0 ? moneyLine('未收余额', o.payable - o.paid, false, 'var(--danger)') : null,
      o.gift_value > 0 ? h('div', { style: 'font-size:12px;color:#8A6410' }, `🎁 促销让利价值 ${fmtMoney(o.gift_value)}（买二送半箱）`) : null)));

  if (o.type === 'wholesale') {
    root.append(h('div', { class: 'card' },
      h('div', { class: 'card-hd' }, h('b', {}, '回款记录')),
      o.payments.length
        ? table([
          { title: '金额', align: 'right', render: (p) => h('b', {}, fmtMoney(p.amount)) },
          { title: '方式', render: (p) => p.method },
          { title: '登记人', render: (p) => p.recorder_name || '—' },
          { title: '状态', align: 'center', render: (p) => chip(p.status === 'confirmed' ? '已确认' : '待确认', p.status === 'confirmed' ? 'ok' : 'warn') },
          { title: '确认人', render: (p) => p.confirmer_name || '—' },
          { title: '', align: 'right', render: (p) => (p.status === 'pending' && userCan('gm', 'mgr') ? h('button', { class: 'btn sm', onclick: (e) => confirmPay(p, e, () => rerun()) }, '确认到账') : '') },
        ], o.payments, { minWidth: 560 })
        : empty('暂无回款记录', o.paid >= o.payable ? '' : '业务员可在「回款记录」页登记收款', '💰')));
  }

  /* 操作面板 */
  const acts = [];
  const isOwner = o.salesman_id === u.id;
  if (o.status === 'draft' && isOwner) {
    acts.push(h('button', { class: 'btn', onclick: () => act(`/api/orders/${o.id}/submit`, {}, '已提交审批', rerun) }, '提交审批'));
    acts.push(h('button', { class: 'btn danger', onclick: () => cancelOrder(o, rerun) }, '取消订单'));
  }
  if (o.status === 'pending' && userCan('gm', 'mgr')) {
    acts.push(h('button', { class: 'btn', onclick: () => approveOrder(o, rerun) }, '✓ 审批通过'));
    acts.push(h('button', { class: 'btn danger', onclick: () => rejectOrder(o, rerun) }, '✕ 驳回'));
  }
  if (o.status === 'pending' && isOwner) acts.push(h('button', { class: 'btn ghost', onclick: () => cancelOrder(o, rerun) }, '取消订单'));
  if (['approved', 'partial'].includes(o.status) && userCan('gm', 'mgr')) {
    acts.push(h('button', { class: 'btn', onclick: () => shipOrder(o, rerun) }, '📦 整单出库'));
  }
  if (['approved', 'partial', 'shipped'].includes(o.status) && o.type === 'wholesale' && o.paid < o.payable && (isOwner || userCan('gm', 'mgr'))) {
    acts.push(h('button', { class: 'btn gold', onclick: () => recordPay(o, rerun) }, '💰 登记回款'));
  }
  if (acts.length) root.append(h('div', { class: 'card', style: 'text-align:right' }, h('div', { class: 'btn-row', style: 'justify-content:flex-end' }, acts)));
  else if (o.status === 'done') root.append(h('div', { class: 'card', style: 'text-align:center;color:var(--ok);font-size:13.5px' }, '✓ 该订单已全部完成（出库与回款结清）'));
}
const kvCell = (k, v) => h('div', { style: 'font-size:12px;color:var(--ink-3)' }, k, h('div', { style: 'font-size:14px;color:var(--ink);font-weight:600;margin-top:2px' }, v));
const moneyLine = (label, val, strong, color) => h('div', { style: 'display:flex;justify-content:space-between' + (strong ? ';font-weight:800;font-size:15px;color:var(--ink)' : '') },
  h('span', { style: strong ? '' : 'color:var(--ink-3)' }, label), h('b', { style: color ? `color:${color}` : '' }, fmtMoney(val)));

async function act(url, body, msg, done) {
  try { await API.post(url, body); toast(msg, 'ok'); if (done) done(); } catch (e) { toast(e.message, 'err'); }
}
function rerun() { setTimeout(() => location.reload(), 350); }

function approveOrder(o, done) {
  const disc = h('input', { class: 'ipt num', type: 'number', min: 0, step: '0.01', placeholder: '0.00' });
  const m = modal({
    title: `审批订单 ${o.no}`,
    body: [
      h('p', { style: 'font-size:13px;color:var(--ink-2)' }, `商品金额 ${fmtMoney(o.items_amount)} · 促销让利 ${fmtMoney(o.gift_value)}`),
      field('优惠金额（元，选填）', disc),
      h('p', { style: 'font-size:12px;color:var(--ink-3)' }, '业务经理单笔优惠上限为应收的 10%；超出需总经理审批。'),
    ],
    footer: [
      h('button', { class: 'btn ghost', onclick: () => m.close() }, '取消'),
      h('button', { class: 'btn', onclick: async () => {
        try { await API.post(`/api/orders/${o.id}/approve`, { discount: Number(disc.value) || 0 }); m.close(); toast('已审批通过', 'ok'); done(); }
        catch (e) { toast(e.message, 'err'); }
      } }, '确认通过'),
    ],
  });
}
function rejectOrder(o, done) {
  const reason = h('input', { class: 'ipt', placeholder: '请填写驳回原因（必填）' });
  const m = modal({
    title: `驳回订单 ${o.no}`,
    body: field('驳回原因', reason, true),
    footer: [
      h('button', { class: 'btn ghost', onclick: () => m.close() }, '取消'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!reason.value.trim()) return toast('请填写驳回原因', 'err');
        try { await API.post(`/api/orders/${o.id}/reject`, { reason: reason.value.trim() }); m.close(); toast('已驳回', 'ok'); done(); }
        catch (e) { toast(e.message, 'err'); }
      } }, '确认驳回'),
    ],
  });
}
function cancelOrder(o, done) {
  confirmBox(`取消订单 ${o.no}`, '取消后订单将作废，不可恢复。确认取消？', async () => {
    await act(`/api/orders/${o.id}/cancel`, {}, '订单已取消', done);
  }, '确认取消', true);
}
async function shipOrder(o, done) {
  confirmBox('整单出库', '将从总仓库按订单数量全部出库，并扣减总仓库存。确认执行？', async () => {
    try {
      const r = await API.post(`/api/orders/${o.id}/ship`, {});
      toast(r.status === 'shipped' ? '已全部出库，等待回款' : '出库成功（部分批次）', 'ok');
      done();
    } catch (e) { toast(e.message, 'err'); }
  }, '确认出库');
}
function recordPay(o, done) {
  const unpaid = o.payable - o.paid;
  const amt = h('input', { class: 'ipt num', type: 'number', min: 0.01, step: '0.01', value: (unpaid / 100).toFixed(2) });
  const method = h('select', { class: 'ipt' }, ['现金', '银行转账', '微信', '支付宝'].map((m) => h('option', { value: m }, m)));
  const note = h('input', { class: 'ipt', placeholder: '备注（选填）' });
  const m = modal({
    title: `登记回款 · ${o.no}`,
    body: [
      h('p', { style: 'font-size:13px;color:var(--ink-2)' }, `应收 ${fmtMoney(o.payable)} · 已收 ${fmtMoney(o.paid)} · 未收 ${fmtMoney(unpaid)}`),
      field('回款金额（元）', amt, true), field('收款方式', method), field('备注', note),
      h('p', { style: 'font-size:12px;color:var(--ink-3)' }, '登记后需业务经理或总经理确认到账。'),
    ],
    footer: [
      h('button', { class: 'btn ghost', onclick: () => m.close() }, '取消'),
      h('button', { class: 'btn gold', onclick: async () => {
        try { await API.post(`/api/orders/${o.id}/pay`, { amount: Number(amt.value), method: method.value, note: note.value }); m.close(); toast('回款已登记，待确认', 'ok'); done(); }
        catch (e) { toast(e.message, 'err'); }
      } }, '提交回款'),
    ],
  });
}
async function confirmPay(p, ev, done) {
  ev.target.disabled = true;
  try { await API.post(`/api/payments/${p.id}/confirm`); toast('回款已确认到账', 'ok'); if (done) done(); }
  catch (e) { toast(e.message, 'err'); ev.target.disabled = false; }
}

/* ============ 新建批发订单（业务员） ============ */
export async function pageOrderNew(root) {
  if (!userCan('sal')) {
    root.append(h('div', { class: 'card', style: 'text-align:center;padding:40px 20px' },
      h('div', { style: 'font-size:34px' }, '🔒'),
      h('b', { style: 'display:block;margin:10px 0 6px' }, '无开单权限'),
      h('p', { style: 'font-size:13px;color:var(--ink-3)' }, '批发订单仅限业务员开单，审批请在「待办中心」处理。'),
      h('a', { class: 'btn', style: 'margin-top:10px', href: '#/todos' }, '前往待办中心')));
    return;
  }
  const [prods, locs] = await Promise.all([loadProducts(), loadLocations()]);
  const stores = locs.filter((l) => l.type === 'store' && l.status === 'active');
  const actProds = prods.filter((p) => p.status === 'active');
  if (!stores.length) { root.append(h('div', { class: 'card' }, empty('暂无可用门店', '请联系业务经理创建门店', '🏪'))); return; }

  const storeSel = h('select', { class: 'ipt' }, stores.map((s) => h('option', { value: s.id }, `${s.name}（${s.address || '赣州'}）`)));
  const payMode = h('select', { class: 'ipt' }, [h('option', { value: 'credit' }, '账期（先货后款）'), h('option', { value: 'cash' }, '现结（当场收款）')]);
  const note = h('input', { class: 'ipt', placeholder: '备注：如客户名称、送达要求（选填）' });

  /* 商品行 */
  const rowEls = actProds.map((p) => {
    const cartons = h('input', { class: 'ipt num', type: 'number', min: 0, value: '0', style: 'width:76px;text-align:center' });
    const loose = h('input', { class: 'ipt num', type: 'number', min: 0, value: '0', style: 'width:64px;text-align:center' });
    const amt = h('td', { class: 'ta-r row-amt', style: 'font-weight:700;color:var(--ink)' }, '—');
    const tr = h('tr', {},
      h('td', {}, h('b', {}, p.name), h('div', { style: 'font-size:11px;color:var(--ink-3)' }, `${catName(p.category)} · 批发 ${fmtMoney(p.wholesale_price)}/箱 · ${fmtMoney(p.wholesale_loose)}/散`)),
      h('td', { align: 'center' }, cartons),
      h('td', { align: 'center' }, loose),
      amt);
    const recalc = () => {
      const c = Number(cartons.value) || 0, l = Number(loose.value) || 0;
      amt.textContent = c + l > 0 ? fmtMoney(c * p.wholesale_price + l * Math.round(p.wholesale_price / p.units_per_carton)) : '—';
      sum();
    };
    cartons.addEventListener('input', recalc); loose.addEventListener('input', recalc);
    return { tr, p, cartons, loose };
  });

  /* 合计 + 促销预览（每满2整箱赠0.5箱，散件不参与） */
  const sAmount = h('span', {}, '¥0.00'); const sGift = h('span', {}, '0'); const sPay = h('b', {}, '¥0.00');
  function sum() {
    let amount = 0, giftUnits = 0;
    for (const r of rowEls) {
      const c = Number(r.cartons.value) || 0, l = Number(r.loose.value) || 0;
      amount += c * r.p.wholesale_price + l * Math.round(r.p.wholesale_price / r.p.units_per_carton);
      giftUnits += Math.floor(c / 2) * (r.p.units_per_carton / 2);
    }
    sAmount.textContent = fmtMoney(amount);
    sGift.textContent = `${Math.floor(giftUnits / 16)}箱${giftUnits % 16 ? `${giftUnits % 16}散` : ''}`;
    sPay.textContent = fmtMoney(amount);
  }
  sum();

  const draftBtn = h('button', { class: 'btn lg ghost' }, '保存草稿');
  const submitBtn = h('button', { class: 'btn lg' }, '提交审批');
  const collect = () => rowEls.map((r) => ({ product_id: r.p.id, cartons: Number(r.cartons.value) || 0, loose: Number(r.loose.value) || 0 }))
    .filter((x) => x.cartons + x.loose > 0);
  const submit = async (save_draft) => {
    if (!storeSel.value) return toast('请选择门店', 'err');
    const items = collect();
    if (!items.length) return toast('请至少填写一个商品数量', 'err');
    submitBtn.disabled = draftBtn.disabled = true;
    try {
      const r = await API.post('/api/orders', { type: 'wholesale', store_id: Number(storeSel.value), items, note: note.value, payment_mode: payMode.value, save_draft });
      toast(save_draft ? `草稿已保存：${r.no}` : `订单已提交：${r.no}`, 'ok');
      location.hash = `#/orders/${r.id}`;
    } catch (e) {
      submitBtn.disabled = draftBtn.disabled = false;
      toast(e.message, 'err');
    }
  };
  draftBtn.addEventListener('click', () => submit(true));
  submitBtn.addEventListener('click', () => submit(false));

  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'card-hd' }, h('b', {}, '收货门店'), h('span', { style: 'margin-left:auto' }, chip('促销：买二送半箱', 'gold'))),
      h('div', { class: 'form-2col' }, field('门店', storeSel, true), field('结算方式', payMode, true)),
      field('备注', note)),
    h('div', { class: 'card' },
    h('div', { class: 'card-hd' }, h('b', {}, '订货明细'), h('span', { class: 'chip grey' }, '箱 + 散（袋/盒）')),
    h('div', { class: 'tbl-wrap' },
      h('table', { class: 'tbl', style: 'min-width:520px' },
        h('thead', {}, h('tr', {},
          h('th', {}, '商品（批发价）'), h('th', { class: 'ta-c', style: 'width:130px' }, '整箱'), h('th', { class: 'ta-c', style: 'width:110px' }, '散件'), h('th', { class: 'ta-r', style: 'width:110px' }, '小计'))),
        h('tbody', {}, rowEls.map((r) => r.tr)))),
    h('div', { class: 'grid g3', style: 'margin-top:14px' },
      h('div', { class: 'kpi' }, h('div', { class: 'k-label' }, '商品金额'), h('div', { class: 'k-value', style: 'font-size:20px' }, sAmount)),
      h('div', { class: 'kpi gold' }, h('div', { class: 'k-label' }, '促销赠送（自动）'), h('div', { class: 'k-value', style: 'font-size:20px' }, sGift), h('div', { class: 'k-foot' }, '每满 2 箱赠 0.5 箱 · 散件不参与')),
      h('div', { class: 'kpi' }, h('div', { class: 'k-label' }, '应收合计'), h('div', { class: 'k-value', style: 'font-size:20px' }, sPay))),
    h('div', { class: 'btn-row', style: 'margin-top:14px;justify-content:flex-end' }, draftBtn, submitBtn)));
}

/* ============ 零售 POS（促销员） ============ */
export async function pagePOS(root) {
  if (!userCan('prm')) {
    root.append(h('div', { class: 'card', style: 'text-align:center;padding:40px 20px' },
      h('div', { style: 'font-size:34px' }, '🔒'),
      h('b', { style: 'display:block;margin:10px 0 6px' }, '无零售开单权限'),
      h('p', { style: 'font-size:13px;color:var(--ink-3)' }, '零售 POS 仅限门店促销员使用。'),
      h('a', { class: 'btn', style: 'margin-top:10px', href: '#/dash' }, '返回工作台')));
    return;
  }
  const [prods, inv] = await Promise.all([loadProducts(), API.get('/api/inventory')]);
  const stockMap = Object.fromEntries(inv.map((i) => [i.product_id, i.qty]));
  const actProds = prods.filter((p) => p.status === 'active');
  const cart = Object.fromEntries(actProds.map((p) => [p.id, 0]));
  const grid = h('div', { class: 'grid g2' });
  const summary = h('div', {});
  const totalEl = h('b', { style: 'font-size:22px' }, '¥0.00');
  const giftEl = h('div', { class: 'k-foot' }, '');
  const payMethod = h('select', { class: 'ipt' }, ['现金', '微信', '支付宝', '刷卡'].map((m) => h('option', {}, m)));

  function refresh() {
    let amount = 0, giftUnits = 0;
    for (const p of actProds) {
      const q = cart[p.id];
      amount += q * Math.round(p.retail_price / p.units_per_carton);
      giftUnits += Math.floor(q / p.units_per_carton / 2) * (p.units_per_carton / 2);
    }
    totalEl.textContent = fmtMoney(amount);
    const giftVal = actProds.reduce((s, p) => s + Math.floor(cart[p.id] / p.units_per_carton / 2) * (p.units_per_carton / 2) * Math.round(p.retail_price / p.units_per_carton), 0);
    giftEl.textContent = giftUnits > 0 ? `🎁 满2箱已赠 ${giftUnits} 件（8件/半箱）· 折让价值 ${fmtMoney(giftVal)}` : '满 2 箱自动赠半箱';
    for (const card of grid.children) {
      const pid = Number(card.dataset.pid);
      const p = actProds.find((x) => x.id === pid);
      const cnt = card.querySelector('.pos-cnt');
      cnt.textContent = String(cart[pid]);
      cnt.style.display = cart[pid] > 0 ? 'flex' : 'none';
      const st = stockMap[pid] || 0;
      card.querySelector('.pos-stock').textContent = st > 0 ? `库存 ${fmtQty(st, p.units_per_carton)}` : '无库存';
      card.querySelector('.pos-stock').style.color = st > 0 ? 'var(--ink-3)' : 'var(--danger)';
    }
  }
  const setQty = (pid, d) => {
    cart[pid] = Math.max(0, cart[pid] + d);
    refresh();
  };
  for (const p of actProds) {
    grid.append(h('div', { class: 'card pos-card', dataset: { pid: String(p.id) }, style: 'margin-bottom:0;padding:14px' },
      h('div', { style: 'display:flex;align-items:center;gap:10px' },
        h('div', { style: 'width:40px;height:40px;border-radius:12px;background:var(--brand-ghost);display:flex;align-items:center;justify-content:center;font-size:19px' }, p.category === 'bag' ? '🥛' : '📦'),
        h('div', { style: 'flex:1;min-width:0' },
          h('b', { style: 'font-size:14px' }, p.name),
          h('div', { class: 'pos-stock', style: 'font-size:11.5px;margin-top:2px' }, '')),
        h('div', { style: 'display:flex;align-items:center;gap:8px' },
          h('button', { class: 'btn sm ghost', style: 'width:32px;padding:0;height:32px;border-radius:9px', onclick: () => setQty(p.id, -1) }, '−'),
          h('span', { class: 'pos-cnt', style: 'min-width:30px;text-align:center;font-weight:800;font-size:15px;display:none;align-items:center;justify-content:center;height:32px;background:var(--brand-soft);border-radius:9px;color:var(--brand-deep)' }, '0'),
          h('button', { class: 'btn sm', style: 'width:32px;padding:0;height:32px;border-radius:9px', onclick: () => setQty(p.id, 1) }, '+'))),
      h('div', { style: 'margin-top:8px;font-size:12px;color:var(--ink-2)' },
        h('b', {}, fmtMoney(Math.round(p.retail_price / p.units_per_carton))), ' /件　',
        h('span', { class: 'chip brand' }, `${fmtMoney(p.retail_price)}/箱`))));
  }

  const payBtn = h('button', { class: 'btn lg block', style: 'height:52px;font-size:16px' }, '结算收款');
  const p_upc = (pid) => { const p = actProds.find((x) => x.id === pid); return p ? p.units_per_carton : 16; };
  payBtn.addEventListener('click', async () => {
    const items = actProds.filter((p) => cart[p.id] > 0).map((p) => ({
      product_id: p.id, cartons: Math.floor(cart[p.id] / p.units_per_carton), loose: cart[p.id] % p.units_per_carton,
    }));
    if (!items.length) return toast('请先选择商品数量', 'err');
    payBtn.disabled = true;
    try {
      const r = await API.post('/api/orders', { type: 'retail', items, payment_method: payMethod.value });
      toast(`成交！单号 ${r.no} · 实收 ${fmtMoney(r.payable)}${r.gift_value ? ' · 含赠品' : ''}`, 'ok');
      for (const p of actProds) cart[p.id] = 0;
      for (const i of items) stockMap[i.product_id] = Math.max(0, (stockMap[i.product_id] || 0) - (i.cartons * p_upc(i.product_id) + i.loose));
      refresh();
      payBtn.disabled = false;
    } catch (e) { payBtn.disabled = false; toast(e.message, 'err'); }
  });

  refresh();
  root.append(
    h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('b', {}, '选择商品'), h('span', { style: 'margin-left:auto' }, chip('买二送半箱 · 整箱参与', 'gold'))), grid),
    h('div', { class: 'card', style: 'position:sticky;bottom:64px' },
      h('div', { style: 'display:flex;align-items:center;justify-content:space-between' },
        h('div', {}, h('div', { class: 'k-label', style: 'font-size:12px;color:var(--ink-3)' }, '应收合计（零售价）'), giftEl),
        totalEl),
      h('div', { class: 'form-2col', style: 'margin-top:12px' }, field('收款方式', payMethod), h('div', {})),
      payBtn));
}

/* ============ 库存查询 ============ */
export async function pageInventory(root) {
  const u = API.user;
  const locs = await loadLocations();
  const sel = h('select', { class: 'ipt', style: 'width:auto;min-width:180px' },
    h('option', { value: '' }, '全部地点'),
    locs.filter((l) => l.status === 'active').map((l) => h('option', { value: l.id }, `${l.name}${l.type === 'main' ? '（总仓）' : ''}`)));
  const body = h('div', {});
  const render = async () => {
    body.innerHTML = '';
    body.append(skeleton(4));
    try {
      const rows = await API.get(`/api/inventory${sel.value ? `?location_id=${sel.value}` : ''}`);
      body.innerHTML = '';
      const grouped = {};
      for (const r of rows) (grouped[r.location_name] = grouped[r.location_name] || []).push(r);
      const keys = Object.keys(grouped);
      if (!keys.length) { body.append(h('div', { class: 'card' }, empty('暂无库存数据', '', '📦'))); return; }
      for (const loc of keys) {
        const items = grouped[loc];
        const isMain = items[0].location_type === 'main';
        body.append(h('div', { class: 'card' },
          h('div', { class: 'card-hd' }, h('b', {}, `${isMain ? '🏭' : '🏪'} ${loc}`), isMain ? chip('总仓库', 'brand') : chip('门店', 'info')),
          table([
            { title: '商品', render: (r) => h('div', {}, h('b', {}, r.product_name), h('span', { style: 'margin-left:6px' }, CAT_CHIP(r.category))) },
            { title: 'SKU', render: (r) => h('span', { class: 'mono', style: 'font-size:12px' }, r.sku) },
            { title: '在库', align: 'right', render: (r) => h('b', { style: 'font-size:14px' }, `${fmtNum(r.total)} 件`), },
            { title: '折合', align: 'right', render: (r) => `${r.cartons}箱${r.loose ? ` + ${r.loose}散` : ''}` },
            { title: '在途', align: 'right', render: (r) => (r.transit > 0 ? chip(`在途 ${fmtNum(r.transit)} 件`, 'info') : '—') },
            { title: '水位', align: 'center', render: (r) => {
              const t = r.total;
              if (t <= 0) return chip('缺货', 'bad');
              if (t < 32) return chip('偏低', 'warn');
              if (t > 800) return chip('偏高', 'info');
              return chip('正常', 'ok');
            } },
            { title: '', align: 'right', render: (r) => r.total > 0 ? h('button', { class: 'btn sm ghost', onclick: () => showBatches(r, render) }, '批次') : null },
          ], items, { minWidth: 620 })));
      }
    } catch (e) { body.innerHTML = ""; body.append(errCard(e, render)); }
  };
  sel.addEventListener('change', render);
  root.append(h('div', { class: 'card', style: 'padding:14px 18px' },
    h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, h('span', { style: 'font-size:13px;color:var(--ink-3)' }, '筛选地点'), sel),
    h('span', { style: 'margin-left:auto' }, h('a', { class: 'btn sm ghost', href: '#/expiry' }, '⏰ 临期预警'))), body);
  await render();
}

/* 批次明细弹窗（生产日期 / 到期日 / 剩余天数档位） */
const LEVEL_META = {
  urgent: { label: '紧急', cls: 'danger', hint: '剩余 ≤ 3 天' },
  near: { label: '临期', cls: 'gold', hint: '剩余 ≤ 10 天' },
  expired: { label: '已过期', cls: 'bad', hint: '' },
  ok: { label: '新鲜', cls: 'ok', hint: '' },
};
async function showBatches(r, refresh) {
  const box = h('div', {}, skeleton(3));
  const m = modal({
    title: `批次明细 · ${r.product_name} @ ${r.location_name}`,
    wide: true,
    body: box,
    footer: [h('button', { class: 'btn ghost', onclick: () => m.close() }, '关闭')],
  });
  try {
    const rows = await API.get(`/api/batches?location_id=${r.location_id}&product_id=${r.product_id}`);
    box.innerHTML = '';
    if (!rows.length) { box.append(empty('暂无批次数据', '', '📦')); return; }
    const canWriteoff = userCan('gm', 'mgr');
    box.append(table([
      { title: '生产日期', render: (b) => b.produced_date },
      { title: '到期日', render: (b) => h('b', {}, b.expire_date) },
      { title: '剩余', align: 'center', render: (b) => h('span', { style: `font-weight:700;color:${b.level === 'urgent' ? 'var(--danger)' : b.level === 'near' ? 'var(--gold-deep)' : 'var(--brand-deep)'}` }, `${b.days_left} 天`) },
      { title: '数量', align: 'right', render: (b) => fmtQty(b.qty, b.units_per_carton) },
      { title: '状态', align: 'center', render: (b) => chip(LEVEL_META[b.level].label, LEVEL_META[b.level].cls) },
      { title: '来源', render: (b) => h('span', { class: 'mono', style: 'font-size:11.5px' }, b.ref_no || '—') },
      canWriteoff ? { title: '', align: 'right', render: (b) => (b.level !== 'ok' && b.qty > 0) ? h('button', { class: 'btn sm danger ghost', onclick: () => writeoffBatch(b, r, m, refresh) }, '报废') : null } : null,
    ].filter(Boolean), rows, { minWidth: 620 }));
    box.append(h('p', { style: 'font-size:11.5px;color:var(--ink-3);margin-top:8px' }, '出库按「先到期先出」FIFO 自动扣减批次；临期（≤10天）/紧急（≤3天）批次建议优先促销或报废。'));
  } catch (e) { box.innerHTML = ''; box.append(errCard(e, () => showBatches(r, refresh))); }
}
async function writeoffBatch(b, r, parentModal, refresh) {
  const inp = h('input', { class: 'ipt num', type: 'number', min: 1, max: b.qty, value: String(b.qty), style: 'width:110px;text-align:center' });
  const reason = h('input', { class: 'ipt', placeholder: '报废原因（如：临期清货 / 变质）' });
  const m = modal({
    title: `报废登记 · ${r.product_name}`,
    body: [
      h('p', { style: 'font-size:12.5px;color:var(--ink-3);margin-bottom:10px' }, `批次 ${b.produced_date} 生产 · ${b.expire_date} 到期 · 余量 ${fmtQty(b.qty, b.units_per_carton)}。报废将从库存同步核减并记入审计。`),
      field('报废数量（件）', inp, true),
      field('报废原因', reason, false),
    ],
    footer: [
      h('button', { class: 'btn ghost', onclick: () => m.close() }, '取消'),
      h('button', { class: 'btn danger', onclick: async () => {
        try {
          await API.post('/api/expiry/writeoff', { batch_id: b.id, qty: Number(inp.value) || 0, reason: reason.value });
          m.close(); parentModal.close(); toast('报废完成，库存已核减', 'ok');
          if (refresh) refresh();
        } catch (e) { toast(e.message, 'err'); }
      } }, '确认报废'),
    ],
  });
}

/* ============ 临期预警中心 ============ */
export async function pageExpiry(root) {
  const u = API.user;
  const body = h('div', {});
  const seg = h('div', { class: 'seg' }, [['', '全部'], ['urgent', '紧急'], ['near', '临期'], ['expired', '已过期']].map(([k, label], i) =>
    h('s', { class: i === 0 ? 'on' : '', 'data-k': k }, label)));
  let cur = '';
  const statBox = h('div', { class: 'grid g4' });
  const statCell = (n, label, color) => h('div', { class: 'kpi' },
    h('div', { class: 'k-label' }, label), h('div', { class: 'k-value', style: `color:${color}` }, n));
  const render = async () => {
    body.innerHTML = '';
    body.append(skeleton(5));
    try {
      const { rows, stat } = await API.get('/api/expiry/alerts');
      body.innerHTML = '';
      statBox.innerHTML = '';
      statBox.append(
        statCell(stat.urgent, '紧急（剩余 ≤ 3 天）', 'var(--danger)'),
        statCell(stat.near, '临期（剩余 ≤ 10 天）', 'var(--gold-deep)'),
        statCell(stat.expired, '已过期', 'var(--ink-2)'),
        statCell(stat.batches, '预警批次（个）', 'var(--brand-deep)'));
      const list = rows.filter((r) => !cur || r.level === cur);
      if (!list.length) {
        body.append(h('div', { class: 'card' }, empty(cur === 'expired' ? '没有过期批次' : '没有预警批次', '库存新鲜度良好，继续保持', '✅')));
        return;
      }
      const canWriteoff = userCan('gm', 'mgr');
      body.append(h('div', { class: 'card' },
        h('div', { class: 'card-hd' }, h('b', {}, `预警批次（${list.length}）`), h('span', { style: 'margin-left:auto' },
          h('span', { style: 'font-size:11.5px;color:var(--ink-3)' }, u.role === 'prm' ? '范围：本店' : u.role === 'sal' ? '范围：总仓' : '范围：全部库位'))),
        table([
          { title: '库位', render: (r) => h('div', {}, h('b', {}, r.location_name), h('span', { style: 'margin-left:4px' }, chip(r.location_type === 'main' ? '总仓' : '门店', r.location_type === 'main' ? 'brand' : 'info'))) },
          { title: '商品', render: (r) => h('div', {}, h('b', {}, r.product_name), h('span', { style: 'margin-left:4px' }, CAT_CHIP(r.category))) },
          { title: '生产日期', render: (r) => r.produced_date },
          { title: '到期日', render: (r) => h('b', {}, r.expire_date) },
          { title: '剩余', align: 'center', render: (r) => h('span', { style: `font-weight:800;color:${r.level === 'urgent' ? 'var(--danger)' : r.level === 'near' ? 'var(--gold-deep)' : 'var(--ink-2)'}` }, r.days_left < 0 ? `已过期 ${-r.days_left} 天` : `${r.days_left} 天`) },
          { title: '数量', align: 'right', render: (r) => h('b', {}, fmtQty(r.qty, r.units_per_carton)) },
          { title: '状态', align: 'center', render: (r) => chip(LEVEL_META[r.level].label, LEVEL_META[r.level].cls) },
          { title: '来源', render: (r) => h('span', { class: 'mono', style: 'font-size:11.5px' }, r.ref_no || '—') },
          canWriteoff ? { title: '', align: 'right', render: (r) => h('button', { class: 'btn sm danger ghost', onclick: () => writeoffDirect(r, render) }, '报废') } : null,
        ].filter(Boolean), list, { minWidth: 760 })),
        h('div', { class: 'card', style: 'padding:12px 18px' },
          h('span', { style: 'font-size:12px;color:var(--ink-3)' }, '💡 处置建议：紧急批次优先「买二送半箱」促销消化或调往高动销门店；无法消化的由经理/总经理登记报废（自动核减库存并写入审计日志）。')));
    } catch (e) { body.innerHTML = ""; body.append(errCard(e, render)); }
  };
  seg.addEventListener('click', (e) => {
    const s = e.target.closest('s[data-k]');
    if (!s) return;
    seg.querySelectorAll('s').forEach((x) => x.classList.toggle('on', x === s));
    cur = s.dataset.k;
    render();
  });
  root.append(h('div', { class: 'card', style: 'padding:14px 18px' },
    h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      h('b', { style: 'font-size:14px' }, '⏰ 临期预警中心'),
      seg)), statBox, body);
  await render();
}
async function writeoffDirect(r, refresh) {
  const inp = h('input', { class: 'ipt num', type: 'number', min: 1, max: r.qty, value: String(r.qty), style: 'width:110px;text-align:center' });
  const reason = h('input', { class: 'ipt', placeholder: '报废原因（如：临期清货 / 变质）' });
  const m = modal({
    title: `报废登记 · ${r.product_name} @ ${r.location_name}`,
    body: [
      h('p', { style: 'font-size:12.5px;color:var(--ink-3);margin-bottom:10px' }, `批次 ${r.produced_date} 生产 · ${r.expire_date} 到期（剩 ${r.days_left} 天）· 余量 ${fmtQty(r.qty, r.units_per_carton)}。报废将从库存同步核减并记入审计。`),
      field('报废数量（件）', inp, true),
      field('报废原因', reason, false),
    ],
    footer: [
      h('button', { class: 'btn ghost', onclick: () => m.close() }, '取消'),
      h('button', { class: 'btn danger', onclick: async () => {
        try {
          await API.post('/api/expiry/writeoff', { batch_id: r.id, qty: Number(inp.value) || 0, reason: reason.value });
          m.close(); toast('报废完成，库存已核减', 'ok');
          if (refresh) refresh();
        } catch (e) { toast(e.message, 'err'); }
      } }, '确认报废'),
    ],
  });
}

/* ============ 调拨 / 领货 ============ */
export async function pageTransfers(root) {
  const u = API.user;
  const body = h('div', {});
  const btnNew = h('button', { class: 'btn sm', onclick: () => newTransfer(root, refresh) }, u.role === 'prm' ? '+ 领货申请' : '+ 新建调拨');
  async function refresh() {
    body.innerHTML = '';
    body.append(skeleton(4));
    try {
      const rows = await API.get('/api/transfers');
      body.innerHTML = '';
      if (!rows.length) { body.append(h('div', { class: 'card' }, empty('暂无调拨单', u.role === 'prm' ? '点击「领货申请」向总仓申请补货' : '', '🚚'))); return; }
      body.append(h('div', { class: 'card' },
        h('div', { class: 'card-hd' }, h('b', {}, `调拨记录（${rows.length}）`), h('div', { class: 'hd-right' }, btnNew)),
        table([
          { title: '单号', render: (t) => h('b', {}, t.no) },
          { title: '流向', render: (t) => `${t.from_name} → ${t.to_name}` },
          { title: '明细', render: (t) => h('span', { style: 'font-size:12.5px' }, t.items.map((i) => `${i.product_name} ${fmtQty(i.qty, i.units_per_carton)}`).join('，')) },
          { title: '状态', align: 'center', render: (t) => statusChip(TRANSFER_STATUS, t.status) },
          { title: '申请时间', render: (t) => fmtDay(t.created_at) },
          {
            title: '', align: 'right', render: (t) => h('div', { class: 'actions' }, [
              t.status === 'pending' && userCan('gm', 'mgr') ? h('button', { class: 'btn sm', onclick: (e) => approveTransfer(t, e, refresh) }, '审批') : null,
              t.status === 'transit' && (userCan('gm', 'mgr') || (u.role === 'prm' && u.store_id === t.to_loc)) ? h('button', { class: 'btn sm gold', onclick: (e) => receiveTransfer(t, e, refresh) }, '确认收货') : null,
            ]),
          },
        ], rows, { minWidth: 680 })));
    } catch (e) { body.innerHTML = ""; body.append(errCard(e, refresh)); }
  }
  root.append(body);
  await refresh();
}
async function approveTransfer(t, ev, done) {
  const m = modal({
    title: `审批调拨 ${t.no}`,
    body: h('p', { style: 'font-size:13.5px;color:var(--ink-2)' }, `${t.from_name} → ${t.to_name}：${t.items.map((i) => `${i.product_name} ${fmtQty(i.qty, i.units_per_carton)}`).join('，')}。通过后总仓立即出库并进入在途。`),
    footer: [
      h('button', { class: 'btn ghost', onclick: () => m.close() }, '取消'),
      h('button', { class: 'btn danger', onclick: async () => {
        try { await API.post(`/api/transfers/${t.id}/approve`, { approve: false, reason: '经理驳回' }); m.close(); toast('已驳回', 'ok'); done(); } catch (e) { toast(e.message, 'err'); }
      } }, '驳回'),
      h('button', { class: 'btn', onclick: async () => {
        try { await API.post(`/api/transfers/${t.id}/approve`, { approve: true }); m.close(); toast('已通过，货品在途', 'ok'); done(); } catch (e) { toast(e.message, 'err'); }
      } }, '通过'),
    ],
  });
}
async function receiveTransfer(t, ev, done) {
  const rows = t.items.map((i) => {
    const inp = h('input', { class: 'ipt num', type: 'number', min: 0, max: i.qty, value: String(i.qty), style: 'width:84px;text-align:center' });
    return { i, inp };
  });
  const m = modal({
    title: `确认收货 ${t.no}`,
    body: [
      h('p', { style: 'font-size:12.5px;color:var(--ink-3);margin-bottom:10px' }, '请核对实收数量；实收少于发运数将记为调拨短少。'),
      ...rows.map(({ i, inp }) => h('div', { class: 'field' },
        h('label', {}, `${i.product_name}（发运 ${fmtQty(i.qty, i.units_per_carton)}）`), inp)),
    ],
    footer: [
      h('button', { class: 'btn ghost', onclick: () => m.close() }, '取消'),
      h('button', { class: 'btn', onclick: async () => {
        try {
          await API.post(`/api/transfers/${t.id}/receive`, { items: rows.map(({ i, inp }) => ({ product_id: i.product_id, received_qty: Number(inp.value) || 0 })) });
          m.close(); toast('收货完成，库存已更新', 'ok'); done();
        } catch (e) { toast(e.message, 'err'); }
      } }, '确认收货'),
    ],
  });
}
async function newTransfer(root, done) {
  const [prods, locs] = await Promise.all([loadProducts(), loadLocations()]);
  const stores = locs.filter((l) => l.type === 'store' && l.status === 'active');
  if (!stores.length) return toast('暂无可用门店', 'err');
  const note = h('input', { class: 'ipt', placeholder: '用途说明（选填）' });
  const rows = prods.filter((p) => p.status === 'active').map((p) => {
    const cartons = h('input', { class: 'ipt num', type: 'number', min: 0, value: '0', style: 'width:72px;text-align:center' });
    const loose = h('input', { class: 'ipt num', type: 'number', min: 0, value: '0', style: 'width:60px;text-align:center' });
    return { p, cartons, loose };
  });
  const isPrm = API.user.role === 'prm';
  const myStore = locs.find((l) => l.id === API.user.store_id);
  const storeSel = isPrm && myStore
    ? h('div', { class: 'ipt', style: 'background:var(--brand-ghost);color:var(--brand-deep);font-weight:600;display:flex;align-items:center' }, `${myStore.name}（本店）`)
    : h('select', { class: 'ipt' }, stores.map((s) => h('option', { value: s.id }, s.name)));
  const m = modal({
    title: isPrm ? '门店领货申请' : '新建调拨（总仓 → 门店）',
    wide: true,
    body: [
      field(isPrm ? '申请补货门店' : '收货门店', storeSel, true),
      h('div', { class: 'tbl-wrap' },
        h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, '商品'), h('th', { class: 'ta-c', style: 'width:110px' }, '整箱'), h('th', { class: 'ta-c', style: 'width:96px' }, '散件'))),
          h('tbody', {}, rows.map((r) => h('tr', {},
            h('td', {}, h('b', {}, r.p.name), h('span', { style: 'font-size:11px;color:var(--ink-3);margin-left:4px' }, catName(r.p.category))),
            h('td', { align: 'center' }, r.cartons), h('td', { align: 'center' }, r.loose)))))),
      h('div', { style: 'margin-top:12px' }, field('备注', note)),
      isPrm ? h('p', { style: 'font-size:12px;color:var(--ink-3)' }, '提交后需业务经理审批，审批通过后总仓发货。') : h('p', { style: 'font-size:12px;color:var(--ink-3)' }, '提交后总仓立即出库，货品进入在途。'),
    ],
    footer: [
      h('button', { class: 'btn ghost', onclick: () => m.close() }, '取消'),
      h('button', { class: 'btn', onclick: async () => {
        const items = rows.map((r) => ({ product_id: r.p.id, cartons: Number(r.cartons.value) || 0, loose: Number(r.loose.value) || 0 })).filter((x) => x.cartons + x.loose > 0);
        if (!items.length) return toast('请至少填写一个商品数量', 'err');
        const toLoc = isPrm ? API.user.store_id : Number(storeSel.value);
        try {
          const r = await API.post('/api/transfers', { to_loc: toLoc, items, note: note.value });
          m.close();
          toast(r.status === 'pending' ? '领货申请已提交，等待审批' : `调拨已发货：${r.no}`, 'ok');
          done();
        } catch (e) { toast(e.message, 'err'); }
      } }, isPrm ? '提交申请' : '确认发货'),
    ],
  });
}

/* ============ 采购入库 ============ */
export async function pagePurchases(root) {
  const body = h('div', {});
  async function refresh() {
    body.innerHTML = '';
    body.append(skeleton(4));
    try {
      const rows = await API.get('/api/purchases');
      body.innerHTML = '';
      body.append(h('div', { class: 'card' },
        h('div', { class: 'card-hd' }, h('b', {}, `采购入库记录（${rows.length}）`),
          h('div', { class: 'hd-right' }, h('button', { class: 'btn sm', onclick: () => newPurchase(refresh) }, '+ 采购入库'))),
        rows.length
          ? table([
            { title: '单号', render: (p) => h('b', {}, p.no) },
            { title: '供应商', render: (p) => p.supplier || '—' },
            { title: '明细', render: (p) => h('span', { style: 'font-size:12.5px' }, p.items.map((i) => {
              const prod = (productsCache || []).find((x) => x.id === i.product_id);
              return `${prod ? prod.name : '商品'} +${fmtQty(i.qty, prod ? prod.units_per_carton : 16)}`;
            }).join('，')) },
            { title: '经手人', render: (p) => p.user_name || '—' },
            { title: '时间', render: (p) => fmtTime(p.created_at) },
          ], rows, { minWidth: 620 })
          : empty('暂无采购记录', '点击「采购入库」登记到货', '🏭')));
    } catch (e) { body.innerHTML = ""; body.append(errCard(e, refresh)); }
  }
  const productsCache = await loadProducts();
  root.append(body);
  await refresh();
}
function newPurchase(done) {
  loadProducts().then((prods) => {
    const supplier = h('input', { class: 'ipt', placeholder: '供应商名称（选填）' });
    const note = h('input', { class: 'ipt', placeholder: '备注（选填）' });
    const rows = prods.filter((p) => p.status === 'active').map((p) => {
      const cartons = h('input', { class: 'ipt num', type: 'number', min: 0, value: '0', style: 'width:72px;text-align:center' });
      const loose = h('input', { class: 'ipt num', type: 'number', min: 0, value: '0', style: 'width:60px;text-align:center' });
      return { p, cartons, loose };
    });
    const m = modal({
      title: '采购入库（总仓）', wide: true,
      body: [
        h('div', { class: 'form-2col' }, field('供应商', supplier), field('备注', note)),
        buildQtyTable(rows),
      ],
      footer: [
        h('button', { class: 'btn ghost', onclick: () => m.close() }, '取消'),
        h('button', { class: 'btn', onclick: async () => {
          const items = rows.map((r) => ({ product_id: r.p.id, cartons: Number(r.cartons.value) || 0, loose: Number(r.loose.value) || 0 })).filter((x) => x.cartons + x.loose > 0);
          if (!items.length) return toast('请至少填写一个商品数量', 'err');
          try {
            const r = await API.post('/api/purchases', { items, supplier: supplier.value, note: note.value });
            m.close(); toast(`入库成功：${r.no}`, 'ok'); done();
          } catch (e) { toast(e.message, 'err'); }
        } }, '确认入库'),
      ],
    });
  });
}

/* ============ 回款记录 ============ */
export async function pagePayments(root) {
  const body = h('div', {});
  async function refresh() {
    body.innerHTML = '';
    body.append(skeleton(4));
    try {
      const rows = await API.get('/api/payments');
      body.innerHTML = '';
      const pend = rows.filter((r) => r.status === 'pending').length;
      body.append(h('div', { class: 'card' },
        h('div', { class: 'card-hd' }, h('b', {}, '回款记录'),
          h('span', { class: `chip ${pend ? 'warn' : 'ok'}` }, pend ? `${pend} 笔待确认` : '全部已确认')),
        rows.length
          ? table([
            { title: '订单号', render: (p) => h('a', { href: `#/orders/${p.order_id}`, style: 'font-weight:700' }, p.order_no) },
            { title: '门店', render: (p) => p.store_name },
            { title: '金额', align: 'right', render: (p) => h('b', { style: 'color:var(--ok)' }, fmtMoney(p.amount)) },
            { title: '方式', align: 'center', render: (p) => chip(p.method, 'grey') },
            { title: '登记人', render: (p) => p.recorder_name || '—' },
            { title: '状态', align: 'center', render: (p) => chip(p.status === 'confirmed' ? '已确认' : '待确认', p.status === 'confirmed' ? 'ok' : 'warn') },
            { title: '时间', render: (p) => fmtDay(p.created_at) },
            { title: '', align: 'right', render: (p) => (p.status === 'pending' && userCan('gm', 'mgr')
              ? h('button', { class: 'btn sm', onclick: async (e) => {
                e.target.disabled = true;
                try { await API.post(`/api/payments/${p.id}/confirm`); toast('已确认到账', 'ok'); refresh(); } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
              } }, '确认到账') : '') },
          ], rows, { minWidth: 680 })
          : empty('暂无回款记录', '在订单详情中可登记回款', '💰')));
    } catch (e) { body.innerHTML = ""; body.append(errCard(e, refresh)); }
  }
  root.append(body);
  await refresh();
}

/* ============ 应收台账 ============ */
export async function pageReceivables(root) {
  const rows = await API.get('/api/receivables');
  const totalUnpaid = rows.reduce((s, r) => s + r.unpaid, 0);
  const over30 = rows.filter((r) => r.age_days > 30);
  root.append(
    h('div', { class: 'grid g3' },
      h('div', { class: 'kpi warn' }, h('div', { class: 'k-label' }, '应收总额'), h('div', { class: 'k-value' }, fmtMoney(totalUnpaid)), h('div', { class: 'k-foot' }, `${rows.length} 笔未结清`)),
      h('div', { class: 'kpi' }, h('div', { class: 'k-label' }, '账龄 30 天以上'), h('div', { class: 'k-value', style: 'font-size:20px' }, `${over30.length} 笔`), h('div', { class: 'k-foot' }, '建议优先催收')),
      h('div', { class: 'kpi gold' }, h('div', { class: 'k-label' }, '最大单笔欠款'), h('div', { class: 'k-value', style: 'font-size:20px' }, rows.length ? fmtMoney(rows[0].unpaid) : '¥0.00'), h('div', { class: 'k-foot' }, rows.length ? rows[0].store_name : '—'))),
    h('div', { class: 'card' },
      h('div', { class: 'card-hd' }, h('b', {}, '应收明细（按欠款排序）')),
      rows.length
        ? table([
          { title: '订单号', render: (r) => h('a', { href: `#/orders/${r.id}`, style: 'font-weight:700' }, r.no) },
          { title: '门店', render: (r) => r.store_name },
          { title: '业务员', render: (r) => r.salesman_name },
          { title: '应收', align: 'right', render: (r) => fmtMoney(r.payable) },
          { title: '已收', align: 'right', render: (r) => fmtMoney(r.paid) },
          { title: '未收', align: 'right', render: (r) => h('b', { style: 'color:var(--danger)' }, fmtMoney(r.unpaid)) },
          { title: '账龄', align: 'center', render: (r) => chip(`${r.age_days} 天`, r.age_days > 30 ? 'bad' : r.age_days > 14 ? 'warn' : 'ok') },
          { title: '状态', align: 'center', render: (r) => statusChip(ORDER_STATUS, r.status) },
        ], rows, { minWidth: 720 })
        : empty('没有应收账款', '所有批发订单均已结清', '✅')));
}

/* ============ 商品价格 ============ */
export async function pageProducts(root) {
  const canEdit = userCan('gm');
  const rows = await loadProducts();
  const body = h('div', { class: 'card' },
    h('div', { class: 'card-hd' }, h('b', {}, '商品与价格'), h('div', { class: 'hd-right' },
      canEdit ? h('button', { class: 'btn sm', onclick: () => editProduct(null, refresh) }, '+ 新增商品') : chip('零售指导价由总部统一制定', 'grey'))),
    table([
      { title: '商品', render: (p) => h('div', {}, h('b', {}, p.name), h('span', { style: 'margin-left:6px' }, CAT_CHIP(p.category))) },
      { title: 'SKU', render: (p) => h('span', { class: 'mono', style: 'font-size:12px' }, p.sku) },
      { title: '规格', align: 'center', render: () => '200ml' },
      { title: '箱规', align: 'center', render: (p) => `${p.units_per_carton} 件/箱` },
      { title: '批发价', align: 'right', render: (p) => h('b', {}, `${fmtMoney(p.wholesale_price)}/箱`), },
      { title: '零售价', align: 'right', render: (p) => h('b', { style: 'color:var(--gold)' }, `${fmtMoney(p.retail_price)}/箱`) },
      { title: '拆零价', align: 'right', render: (p) => `批 ${fmtMoney(p.wholesale_loose)} / 零 ${fmtMoney(p.retail_loose)}` },
      { title: '促销', align: 'center', render: () => chip('买二送半箱', 'gold') },
      { title: '状态', align: 'center', render: (p) => chip(p.status === 'active' ? '在售' : '停售', p.status === 'active' ? 'ok' : 'grey') },
      canEdit ? { title: '', align: 'right', render: (p) => h('button', { class: 'btn sm ghost', onclick: () => editProduct(p, refresh) }, '编辑') } : null,
    ].filter(Boolean), rows, { minWidth: 760 }));
  root.append(body);
  async function refresh() { root.innerHTML = ''; await pageProducts(root); }
}
function editProduct(p, done) {
  const name = h('input', { class: 'ipt', value: p ? p.name : '', placeholder: '如：合沐纯牛奶（袋装）' });
  const sku = h('input', { class: 'ipt', value: p ? p.sku : '', placeholder: '如 HM-BAG-200', disabled: !!p });
  const cat = h('select', { class: 'ipt', disabled: !!p },
    h('option', { value: 'bag' }, '袋装'), h('option', { value: 'box' }, '盒装'));
  if (p) cat.value = p.category;
  const wp = h('input', { class: 'ipt num', type: 'number', step: '0.01', value: p ? (p.wholesale_price / 100).toFixed(2) : '', placeholder: '50.00' });
  const rp = h('input', { class: 'ipt num', type: 'number', step: '0.01', value: p ? (p.retail_price / 100).toFixed(2) : '', placeholder: '58.00' });
  const m = modal({
    title: p ? `编辑商品 · ${p.name}` : '新增商品',
    body: [
      h('div', { class: 'form-2col' }, field('SKU', sku, true), field('分类', cat, true)),
      field('商品名称', name, true),
      h('div', { class: 'form-2col' }, field('批发价（元/箱）', wp, true), field('零售价（元/箱）', rp, true)),
      h('p', { style: 'font-size:12px;color:var(--ink-3)' }, '规格统一为 200ml/件，16 件/箱；价格调整将记录到审计日志。'),
    ],
    footer: [
      h('button', { class: 'btn ghost', onclick: () => m.close() }, '取消'),
      h('button', { class: 'btn', onclick: async () => {
        const body = { name: name.value.trim(), wholesale_price: Number(wp.value), retail_price: Number(rp.value) };
        if (!body.name) return toast('请填写商品名称', 'err');
        if (!body.wholesale_price || body.wholesale_price <= 0) return toast('请填写有效的批发价', 'err');
        if (!body.retail_price || body.retail_price <= 0) return toast('请填写有效的零售价', 'err');
        if (!p && !sku.value.trim()) return toast('请填写 SKU', 'err');
        if (!p) { body.sku = sku.value.trim(); body.category = cat.value; body.units_per_carton = 16; }
        try {
          if (p) await API.put(`/api/products/${p.id}`, body);
          else await API.post('/api/products', body);
          m.close(); toast('已保存', 'ok'); done();
        } catch (e) { toast(e.message, 'err'); }
      } }, '保存'),
    ],
  });
}

/* ============ 门店组织 ============ */
export async function pageStores(root) {
  const canEdit = userCan('gm', 'mgr');
  const locs = await loadLocations();
  const main = locs.filter((l) => l.type === 'main');
  const stores = locs.filter((l) => l.type === 'store');
  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'card-hd' }, h('b', {}, '🏭 总仓库')),
      main.map((l) => h('div', { class: 'todo-item' },
        h('div', { class: 't-ico' }, '🏭'),
        h('div', { class: 't-main' }, h('b', {}, l.name), h('span', {}, `${l.region || '新疆'} · 全渠道货源中枢`)),
        chip('运行中', 'ok')))),
    h('div', { class: 'card' },
      h('div', { class: 'card-hd' }, h('b', {}, `门店（${stores.length}）`), h('div', { class: 'hd-right' },
        canEdit ? h('button', { class: 'btn sm', onclick: () => editStore(null, () => { root.innerHTML = ''; pageStores(root); }) }, '+ 新增门店') : null)),
      stores.length
        ? table([
          { title: '编码', render: (l) => h('span', { class: 'mono', style: 'font-size:12px' }, l.code) },
          { title: '门店', render: (l) => h('b', {}, l.name) },
          { title: '地址', render: (l) => l.address || '赣州市' },
          { title: '联系人', render: (l) => l.contact || '—' },
          { title: '电话', render: (l) => l.phone || '—' },
          { title: '状态', align: 'center', render: (l) => chip(l.status === 'active' ? '营业中' : '已停用', l.status === 'active' ? 'ok' : 'grey') },
          canEdit ? { title: '', align: 'right', render: (l) => h('button', { class: 'btn sm ghost', onclick: () => editStore(l, () => { root.innerHTML = ''; pageStores(root); }) }, '编辑') } : null,
        ].filter(Boolean), stores, { minWidth: 640 })
        : empty('暂无门店', '新增门店后即可开展批发与零售', '🏪')));
}
function editStore(l, done) {
  const name = h('input', { class: 'ipt', value: l ? l.name : '', placeholder: '如：赣州章贡一店' });
  const addr = h('input', { class: 'ipt', value: l ? l.address : '', placeholder: '江西省赣州市…' });
  const contact = h('input', { class: 'ipt', value: l ? l.contact : '', placeholder: '店长姓名' });
  const phone = h('input', { class: 'ipt', value: l ? l.phone : '', placeholder: '联系电话' });
  const status = h('select', { class: 'ipt', disabled: !l },
    h('option', { value: 'active' }, '营业中'), h('option', { value: 'disabled' }, '停用'));
  if (l) status.value = l.status;
  const m = modal({
    title: l ? `编辑门店 · ${l.name}` : '新增门店',
    body: [
      field('门店名称', name, true),
      field('地址', addr), h('div', { class: 'form-2col' }, field('联系人', contact), field('电话', phone)),
      l ? field('状态', status) : null,
      h('p', { style: 'font-size:12px;color:var(--ink-3)' }, '门店归属：江西省赣州市区域；新增后自动生成门店编码。'),
    ],
    footer: [
      h('button', { class: 'btn ghost', onclick: () => m.close() }, '取消'),
      h('button', { class: 'btn', onclick: async () => {
        if (!name.value.trim()) return toast('请填写门店名称', 'err');
        try {
          const body = { name: name.value.trim(), address: addr.value, contact: contact.value, phone: phone.value };
          if (l) { body.status = status.value; await API.put(`/api/locations/${l.id}`, body); }
          else await API.post('/api/locations', body);
          m.close(); toast('已保存', 'ok'); done();
        } catch (e) { toast(e.message, 'err'); }
      } }, '保存'),
    ],
  });
}

/* ============ 用户账号 ============ */
export async function pageUsers(root) {
  const [users, locs] = await Promise.all([API.get('/api/users'), loadLocations()]);
  const storeName = (id) => { const l = locs.find((x) => x.id === id); return l ? l.name : '—'; };
  const refresh = () => { root.innerHTML = ''; pageUsers(root); };
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-hd' }, h('b', {}, `账号管理（${users.length}）`),
      h('div', { class: 'hd-right' }, h('button', { class: 'btn sm', onclick: () => editUser(null) }, '+ 新增账号'))),
    table([
      { title: '工号', render: (u) => h('span', { class: 'mono', style: 'font-weight:700' }, u.username) },
      { title: '姓名', render: (u) => h('b', {}, u.name) },
      { title: '角色', align: 'center', render: (u) => chip(ROLE_NAME[u.role], { gm: 'bad', mgr: 'brand', sal: 'info', prm: 'gold' }[u.role]) },
      { title: '所属门店', render: (u) => (u.role === 'prm' ? storeName(u.store_id) : '—') },
      { title: '电话', render: (u) => u.phone || '—' },
      { title: '状态', align: 'center', render: (u) => chip(u.status === 'active' ? '启用' : '停用', u.status === 'active' ? 'ok' : 'grey') },
      { title: '', align: 'right', render: (u) => h('button', { class: 'btn sm ghost', onclick: () => editUser(u) }, '编辑') },
    ], users, { minWidth: 640 })));

  function editUser(u) {
    const username = h('input', { class: 'ipt', value: u ? u.username : '', placeholder: '登录工号，如 sal02', disabled: !!u });
    const name = h('input', { class: 'ipt', value: u ? u.name : '', placeholder: '真实姓名' });
    const role = h('select', { class: 'ipt', disabled: u && u.role === 'gm' },
      h('option', { value: 'gm' }, '总经理'), h('option', { value: 'mgr' }, '业务经理'),
      h('option', { value: 'sal' }, '业务员'), h('option', { value: 'prm' }, '促销员'));
    if (u) role.value = u.role;
    const store = h('select', { class: 'ipt' },
      h('option', { value: '' }, '— 不绑定（管理岗）—'),
      locs.filter((l) => l.type === 'store').map((l) => h('option', { value: l.id }, l.name)));
    if (u && u.store_id) store.value = String(u.store_id);
    const phone = h('input', { class: 'ipt', value: u ? u.phone : '', placeholder: '手机号' });
    const pass = h('input', { class: 'ipt', type: 'password', placeholder: u ? '留空则不修改密码' : '初始密码（至少6位）' });
    const status = h('select', { class: 'ipt', disabled: !u || (u && u.role === 'gm') },
      h('option', { value: 'active' }, '启用'), h('option', { value: 'disabled' }, '停用'));
    if (u) status.value = u.status;
    const m = modal({
      title: u ? `编辑账号 · ${u.name}` : '新增账号',
      body: [
        h('div', { class: 'form-2col' }, field('登录工号', username, true), field('姓名', name, true)),
        h('div', { class: 'form-2col' }, field('角色', role, true), field('绑定门店（促销员必选）', store)),
        h('div', { class: 'form-2col' }, field('电话', phone), field('密码', pass, !u)),
        u ? field('账号状态', status) : null,
        h('p', { style: 'font-size:12px;color:var(--ink-3)' }, '促销员必须绑定门店；业务经理/总经理无需绑定门店。'),
      ],
      footer: [
        h('button', { class: 'btn ghost', onclick: () => m.close() }, '取消'),
        h('button', { class: 'btn', onclick: async () => {
          if (!u && !username.value.trim()) return toast('请填写登录工号', 'err');
          if (!name.value.trim()) return toast('请填写姓名', 'err');
          if (role.value === 'prm' && !store.value) return toast('促销员必须绑定门店', 'err');
          if (!u && (pass.value || '').length < 6) return toast('初始密码至少 6 位', 'err');
          if (u && pass.value && pass.value.length < 6) return toast('新密码至少 6 位', 'err');
          try {
            if (u) {
              await API.put(`/api/users/${u.id}`, {
                name: name.value.trim(), role: role.value, store_id: store.value ? Number(store.value) : null,
                phone: phone.value, status: status.value, password: pass.value || undefined,
              });
            } else {
              await API.post('/api/users', {
                username: username.value.trim(), name: name.value.trim(), role: role.value,
                store_id: store.value ? Number(store.value) : null, phone: phone.value, password: pass.value,
              });
            }
            m.close(); toast('已保存', 'ok'); refresh();
          } catch (e) { toast(e.message, 'err'); }
        } }, '保存'),
      ],
    });
  }
}

/* ============ 促销活动 ============ */
export async function pagePromotions(root) {
  const rows = await API.get('/api/promotions');
  const canEdit = userCan('gm', 'mgr');
  const refresh = () => { root.innerHTML = ''; pagePromotions(root); };
  root.append(
    h('div', { class: 'card', style: 'background:linear-gradient(135deg,var(--brand-ghost),#fff);border-color:var(--brand-line)' },
      h('div', { style: 'display:flex;align-items:center;gap:14px' },
        h('div', { style: 'font-size:30px' }, '🎁'),
        h('div', { style: 'flex:1' },
          h('b', { style: 'font-size:15px' }, '买二送半箱 · 全渠道进行中'),
          h('div', { style: 'font-size:12.5px;color:var(--ink-2);margin-top:3px' },
            '每订购满 2 整箱，自动赠送 0.5 箱（8 袋/盒）；散件不参与；赠品随单出库、零元结算。')),
        chip('默认规则', 'brand'))),
    h('div', { class: 'card' },
      h('div', { class: 'card-hd' }, h('b', {}, '促销活动管理'), h('div', { class: 'hd-right' },
        canEdit ? h('button', { class: 'btn sm', onclick: () => newPromo(refresh) }, '+ 新建活动') : null)),
      rows.length
        ? table([
          { title: '活动', render: (p) => h('b', {}, p.name) },
          { title: '类型', align: 'center', render: (p) => chip(p.type === 'buy2_half' ? '买二送半箱' : p.type, 'gold') },
          { title: '渠道', align: 'center', render: (p) => p.channels.split(',').map((c) => chip(c === 'wholesale' ? '批发' : '零售', c === 'wholesale' ? 'brand' : 'info')) },
          { title: '有效期', render: (p) => `${p.start_date} ~ ${p.end_date}` },
          { title: '状态', align: 'center', render: (p) => chip(p.status === 'active' ? '进行中' : '已停止', p.status === 'active' ? 'ok' : 'grey') },
          canEdit ? {
            title: '', align: 'right', render: (p) => h('button', { class: `btn sm ${p.status === 'active' ? 'danger' : ''}`, onclick: async (e) => {
              e.target.disabled = true;
              try {
                await API.put(`/api/promotions/${p.id}`, { status: p.status === 'active' ? 'stopped' : 'active' });
                toast(p.status === 'active' ? '活动已停止' : '活动已开启', 'ok'); refresh();
              } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
            } }, p.status === 'active' ? '停止' : '开启'),
          } : null,
        ].filter(Boolean), rows, { minWidth: 640 })
        : empty('暂无活动', '', '🎁')));
}
function newPromo(done) {
  const name = h('input', { class: 'ipt', placeholder: '如：开春订货会 · 买二送半箱' });
  const chW = h('input', { type: 'checkbox', checked: true, style: 'margin-right:6px' });
  const chR = h('input', { type: 'checkbox', checked: true, style: 'margin-right:6px' });
  const start = h('input', { class: 'ipt', type: 'date', value: new Date().toISOString().slice(0, 10) });
  const end = h('input', { class: 'ipt', type: 'date', value: '2027-12-31' });
  const m = modal({
    title: '新建促销活动',
    body: [
      field('活动名称', name, true),
      field('适用渠道', h('div', { style: 'display:flex;gap:18px;padding:8px 0' },
        h('label', { style: 'display:flex;align-items:center;font-size:13.5px' }, chW, '批发'),
        h('label', { style: 'display:flex;align-items:center;font-size:13.5px' }, chR, '零售'))),
      h('div', { class: 'form-2col' }, field('开始日期', start), field('结束日期', end)),
      h('p', { style: 'font-size:12px;color:var(--ink-3)' }, '当前系统内置促销引擎：买二送半箱（整箱基数、散件不参与）。新建活动即启用该规则并归档旧活动。'),
    ],
    footer: [
      h('button', { class: 'btn ghost', onclick: () => m.close() }, '取消'),
      h('button', { class: 'btn', onclick: async () => {
        const channels = [chW.checked ? 'wholesale' : null, chR.checked ? 'retail' : null].filter(Boolean);
        if (!name.value.trim()) return toast('请填写活动名称', 'err');
        if (!channels.length) return toast('请至少选择一个渠道', 'err');
        try {
          await API.post('/api/promotions', { name: name.value.trim(), type: 'buy2_half', channels, start_date: start.value, end_date: end.value });
          m.close(); toast('活动已创建', 'ok'); done();
        } catch (e) { toast(e.message, 'err'); }
      } }, '创建'),
    ],
  });
}
