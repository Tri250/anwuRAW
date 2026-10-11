/* 页面：工作台 · 待办 · 报表 · 个人中心 · 审计 */
import { API } from './api.js';
import { h, $, $$, fmtMoney, fmtNum, fmtQty, fmtDay, ROLE_NAME, chip, statusChip, ORDER_STATUS, MOVE_TYPE, lineChart, empty, errCard, table, icon, toast, modal, field } from './ui.js';

/* ============ 工作台 ============ */
/* 临期预警卡（异步加载，有预警才显示；按角色范围：gm/mgr 全部 · sal 总仓 · prm 本店） */
function expiryCard() {
  const card = h('div', { class: 'card', style: 'display:none;border-color:var(--gold)' });
  API.get('/api/expiry/alerts').then(({ rows, stat }) => {
    if (!stat.batches) return;
    card.style.display = '';
    const lv = (n, label, color) => h('div', { style: 'text-align:center' },
      h('div', { style: `font-size:20px;font-weight:800;color:${color}` }, n),
      h('div', { style: 'font-size:11.5px;color:var(--ink-3)' }, label));
    card.append(
      h('div', { class: 'card-hd' }, h('b', {}, '⏰ 临期预警'),
        h('span', { class: 'chip gold', style: 'margin-left:2px' }, `${stat.batches} 批`),
        h('span', { style: 'margin-left:auto' }, h('a', { class: 'btn ghost sm', href: '#/expiry' }, '处理中心'))),
      h('div', { class: 'grid g3', style: 'margin-bottom:10px' },
        lv(stat.urgent, '紧急（≤3天）', '#D93025'),
        lv(stat.near, '临期（≤10天）', '#B98A1D'),
        lv(stat.expired, '已过期', 'var(--ink-2)')),
      h('div', {}, rows.slice(0, 3).map((r) => h('div', { class: 'todo-item' },
        h('div', { class: 't-ico' }, r.level === 'urgent' ? '🔴' : '🟠'),
        h('div', { class: 't-main' },
          h('b', {}, `${r.product_name} · ${r.location_name}`),
          h('span', {}, `${fmtQty(r.qty, r.units_per_carton)} · 到期 ${r.expire_date} · 剩 ${r.days_left} 天`)),
        h('span', { class: `chip ${r.level === 'urgent' ? 'danger' : 'gold'}` }, r.level === 'urgent' ? '紧急' : '临期')))));
  }).catch(() => {});
  return card;
}

export async function pageDash(root) {
  const u = API.user;
  const d = await API.get('/api/dashboard');
  const kpi = (label, value, foot, cls = '') =>
    h('div', { class: `kpi ${cls}` },
      h('div', { class: 'k-label' }, label),
      h('div', { class: 'k-value' }, value),
      foot ? h('div', { class: 'k-foot' }, foot) : null);

  if (u.role === 'prm') {
    const stockRows = (d.store_stock || []).map((s) =>
      h('div', { class: 'bar-row' },
        h('span', { class: 'b-name' }, s.name),
        h('div', { class: 'b-track' }, h('div', { class: 'b-fill', style: `width:${Math.min(100, (s.total / 600) * 100)}%` })),
        h('span', { class: 'b-val' }, fmtQty(s.qty, s.units_per_carton))));
    root.append(
      h('div', { class: 'grid g2' },
        kpi('本店今日销售额', fmtMoney(d.today.sales), `今日 ${d.today.orders} 单`),
        kpi('本店本月销售额', fmtMoney(d.month.sales), `本月 ${d.month.orders} 单 · 促销让利 ${fmtMoney(d.month.gift_value)}`, 'gold')),
      expiryCard(),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' },
          h('div', { class: 'card-hd' }, h('b', {}, '本店实时库存'), h('span', { style: 'margin-left:auto' },
            h('a', { class: 'btn ghost sm', href: '#/inventory' }, '查看库存'))),
          stockRows.length ? stockRows : empty('本店暂无库存', '请联系业务经理调拨补货', '🚚')),
        h('div', { class: 'card' },
          h('div', { class: 'card-hd' }, h('b', {}, '快捷操作')),
          h('div', { class: 'grid g2' },
            h('a', { class: 'btn lg block', href: '#/pos', style: 'height:64px;font-size:16px' }, '🛒 零售开单'),
            h('a', { class: 'btn lg ghost block', href: '#/transfers', style: 'height:64px;font-size:15px' }, '🚚 领货申请'))),
      ),
      trendCard(d.trend14, '本店销售趋势（近 14 天）'));
    return;
  }

  if (u.role === 'sal') {
    const stMap = Object.fromEntries((d.my_orders || []).map((x) => [x.status, x.c]));
    const st = (k, label) => h('div', { style: 'text-align:center;padding:8px 4px' },
      h('div', { style: 'font-size:19px;font-weight:800' }, stMap[k] || 0),
      h('div', { style: 'font-size:11.5px;color:var(--ink-3)' }, label));
    root.append(
      h('div', { class: 'grid g2' },
        kpi('我的今日销售额', fmtMoney(d.today.sales), `今日 ${d.today.orders} 单`),
        kpi('我的本月销售额', fmtMoney(d.month.sales), `本月 ${d.month.orders} 单 · 促销让利 ${fmtMoney(d.month.gift_value)}`, 'gold')),
      h('div', { class: 'card' },
        h('div', { class: 'card-hd' }, h('b', {}, '我的订单状态'), h('span', { style: 'margin-left:auto' },
          h('a', { class: 'btn sm', href: '#/orders/new' }, '+ 新建批发订单'))),
        h('div', { class: 'grid g4' }, st('draft', '草稿'), st('pending', '待审批'), st('approved', '待出库'), st('shipped', '待回款'))),
      expiryCard(),
      trendCard(d.trend14, '我的销售趋势（近 14 天）'),
      topStoresCard(d.top_stores));
    return;
  }

  /* gm / mgr */
  const pend = d.pending || {};
  const total = (pend.orders || 0) + (pend.transfers || 0) + (pend.payments || 0);
  root.append(
    h('div', { class: 'grid g4' },
      kpi('今日销售额', fmtMoney(d.today.sales), `今日 ${d.today.orders} 单`),
      kpi('本月销售额', fmtMoney(d.month.sales), `本月 ${d.month.orders} 单`, 'gold'),
      kpi('批发未回款', fmtMoney(d.receivable), '应收账款余额', 'warn'),
      kpi('总仓库存', fmtQty(d.main_stock, 16), '袋装 + 盒装合计')),
    h('div', { class: 'grid g2' },
      trendCard(d.trend14, '销售趋势（近 14 天）'),
      topStoresCard(d.top_stores)),
    expiryCard(),
    total > 0 ? h('div', { class: 'card', style: 'border-color:var(--brand-line)' },
      h('div', { class: 'card-hd' }, h('b', {}, '待我处理'),
        h('span', { class: 'chip warn', style: 'margin-left:2px' }, `${total} 项`),
        h('span', { style: 'margin-left:auto' }, h('a', { class: 'btn ghost sm', href: '#/todos' }, '全部待办'))),
      h('div', { class: 'todo-item' },
        h('div', { class: 't-ico' }, '📋'),
        h('div', { class: 't-main' }, h('b', {}, '待审批批发订单'), h('span', {}, '业务员提交的订货单')),
        h('span', { class: 'chip warn' }, `${pend.orders || 0}`),
        h('a', { class: 'btn sm ghost', href: '#/orders' }, '处理')),
      h('div', { class: 'todo-item' },
        h('div', { class: 't-ico' }, '🚚'),
        h('div', { class: 't-main' }, h('b', {}, '门店领货申请'), h('span', {}, '促销员发起的补货申请')),
        h('span', { class: 'chip warn' }, `${pend.transfers || 0}`),
        h('a', { class: 'btn sm ghost', href: '#/transfers' }, '处理')),
      h('div', { class: 'todo-item' },
        h('div', { class: 't-ico' }, '💰'),
        h('div', { class: 't-main' }, h('b', {}, '待确认回款'), h('span', {}, '业务员登记的收款记录')),
        h('span', { class: 'chip warn' }, `${pend.payments || 0}`),
        h('a', { class: 'btn sm ghost', href: '#/payments' }, '处理')))
      : h('div', { class: 'card', style: 'text-align:center;color:var(--ink-3);font-size:13px;padding:14px' }, '✓ 暂无待办，一切正常'));
}

function trendCard(trend14, title) {
  const days = trend14.map((t) => t.date);
  const hasData = trend14.some((t) => t.wholesale + t.retail > 0);
  return h('div', { class: 'card' },
    h('div', { class: 'card-hd' }, h('b', {}, title)),
    hasData
      ? h('div', { class: 'chart-box' },
        h('div', { class: 'chart-legend' },
          h('span', {}, h('s', { style: 'background:var(--brand)' }), '批发'),
          h('span', {}, h('s', { style: 'background:var(--gold)' }), '零售')),
        lineChart([
          { color: '#0E7C66', data: trend14.map((t) => t.wholesale) },
          { color: '#B98A1D', data: trend14.map((t) => t.retail) },
        ], { height: 190, labels: days }))
      : empty('近 14 天暂无销售数据', '开单后此处将展示趋势', '📈'));
}
function topStoresCard(top) {
  const max = Math.max(1, ...(top || []).map((t) => t.amount));
  return h('div', { class: 'card' },
    h('div', { class: 'card-hd' }, h('b', {}, '门店销量排行（本月）')),
    (top || []).length
      ? top.map((t, i) => h('div', { class: 'bar-row' },
        h('span', { class: 'b-name' }, `${['🥇', '🥈', '🥉'][i] || ''} ${t.store_name}`),
        h('div', { class: 'b-track' }, h('div', { class: 'b-fill', style: `width:${(t.amount / max) * 100}%` })),
        h('span', { class: 'b-val' }, fmtMoney(t.amount))))
      : empty('本月暂无门店销售', '', '🏪'));
}

/* ============ 待办中心 ============ */
export async function pageTodos(root) {
  const u = API.user;
  const t = await API.get('/api/todos');
  if (u.role === 'gm' || u.role === 'mgr') {
    root.append(
      h('div', { class: 'card' },
        h('div', { class: 'card-hd' }, h('b', {}, `待审批批发订单（${t.orders.length}）`)),
        t.orders.length
          ? table([
            { title: '订单号', render: (o) => h('a', { href: `#/orders/${o.id}` }, h('b', {}, o.no)) },
            { title: '门店', render: (o) => o.store_name },
            { title: '业务员', render: (o) => o.salesman_name },
            { title: '金额', align: 'right', render: (o) => h('b', {}, fmtMoney(o.payable)) },
            { title: '提交时间', render: (o) => fmtDay(o.created_at) },
            { title: '', align: 'right', render: (o) => h('a', { class: 'btn sm', href: `#/orders/${o.id}` }, '去审批') },
          ], t.orders)
          : empty('没有待审批订单', '业务员提交的订单会出现在这里', '✅')),
      h('div', { class: 'card' },
        h('div', { class: 'card-hd' }, h('b', {}, `门店领货申请（${t.transfers.length}）`)),
        t.transfers.length
          ? t.transfers.map((x) => h('div', { class: 'todo-item' },
            h('div', { class: 't-ico' }, '🚚'),
            h('div', { class: 't-main' }, h('b', {}, `${x.to_name} · 领货申请`), h('span', {}, `${x.requester_name || ''} · ${x.note || ''}`)),
            h('a', { class: 'btn sm ghost', href: '#/transfers' }, '去处理')))
          : empty('没有待审批的领货申请', '', '✅')),
      h('div', { class: 'card' },
        h('div', { class: 'card-hd' }, h('b', {}, `待确认回款（${t.payments.length}）`)),
        t.payments.length
          ? table([
            { title: '订单号', render: (p) => p.order_no },
            { title: '门店', render: (p) => p.store_name },
            { title: '金额', align: 'right', render: (p) => h('b', { style: 'color:var(--ok)' }, fmtMoney(p.amount)) },
            { title: '方式', render: (p) => p.method },
            { title: '登记人', render: (p) => p.recorder_name || '' },
            { title: '', align: 'right', render: (p) => h('button', { class: 'btn sm', onclick: async (e) => { await doConfirmPay(p, e); } }, '确认到账') },
          ], t.payments)
          : empty('没有待确认回款', '', '✅')));
  } else if (u.role === 'sal') {
    root.append(
      h('div', { class: 'card' },
        h('div', { class: 'card-hd' }, h('b', {}, '被驳回订单')),
        t.rejected.length
          ? t.rejected.map((o) => h('div', { class: 'todo-item' },
            h('div', { class: 't-ico' }, '❌'),
            h('div', { class: 't-main' }, h('b', {}, `${o.no} · ${o.store_name}`), h('span', {}, `驳回原因：${o.reject_reason}`)),
            h('a', { class: 'btn sm ghost', href: `#/orders/${o.id}` }, '查看')))
          : empty('没有被驳回的订单', '', '✅')),
      h('div', { class: 'card' },
        h('div', { class: 'card-hd' }, h('b', {}, '回款确认进度')),
        t.payments_pending.length
          ? t.payments_pending.map((p) => h('div', { class: 'todo-item' },
            h('div', { class: 't-ico' }, '💰'),
            h('div', { class: 't-main' }, h('b', {}, `${p.order_no} · ${fmtMoney(p.amount)}`), h('span', {}, `${p.method} · 等待经理确认`)),
            null))
          : empty('没有等待确认的回款', '', '✅')));
  } else {
    root.append(
      h('div', { class: 'card' },
        h('div', { class: 'card-hd' }, h('b', {}, '我的领货/补货动态')),
        t.transfers.length
          ? t.transfers.map((x) => h('div', { class: 'todo-item' },
            h('div', { class: 't-ico' }, '🚚'),
            h('div', { class: 't-main' },
              h('b', {}, `${x.no}`),
              h('span', {}, `${{ pending: '等待经理审批', transit: '货物在途，请准备收货', received: '已入库', rejected: `已驳回：${x.note || ''}` }[x.status] || x.status} · ${fmtDay(x.created_at)}`)),
            statusChip({ pending: ['待审批', 'warn'], transit: ['在途', 'info'], received: ['已入库', 'ok'], rejected: ['已驳回', 'bad'], cancelled: ['已取消', 'grey'] }, x.status)))
          : empty('暂无动态', '', '✅')));
  }
}
async function doConfirmPay(p, ev) {
  ev.target.disabled = true;
  try {
    await API.post(`/api/payments/${p.id}/confirm`);
    toast('回款已确认', 'ok');
    import('./app.js').then((m) => m.rerender());
  } catch (e) { toast(e.message, 'err'); ev.target.disabled = false; }
}

/* ============ 报表中心 ============ */
export async function pageReports(root) {
  const u = API.user;
  const seg = h('div', { class: 'seg' });
  const tabs = [['sales', '销售报表'], ['stores', '门店排行'], ['salesman', '业务员业绩'], ['promo', '促销让利'], ['inv', '库存水位']];
  let cur = 'sales';
  const body = h('div', {});
  const isMgr = u.role === 'gm' || u.role === 'mgr';
  const avail = u.role === 'sal' ? ['sales'] : u.role === 'prm' ? ['sales', 'inv'] : ['sales', 'stores', 'salesman', 'promo', 'inv'];
  const render = async () => {
    body.innerHTML = '';
    body.append(h('div', { class: 'skel', style: 'height:120px;margin-top:12px' }));
    try {
      if (cur === 'sales') {
        const sales = await API.get('/api/reports/sales?days=14');
        const has = sales.daily.some((x) => x.wholesale + x.retail > 0);
        body.innerHTML = '';
        body.append(h('div', { class: 'card' },
          h('div', { class: 'card-hd' }, h('b', {}, '销售趋势（近 14 天）')),
          has ? h('div', {},
            h('div', { class: 'chart-legend' },
              h('span', {}, h('s', { style: 'background:var(--brand)' }), '批发'),
              h('span', {}, h('s', { style: 'background:var(--gold)' }), '零售')),
            lineChart([
              { color: '#0E7C66', data: sales.daily.map((x) => x.wholesale) },
              { color: '#B98A1D', data: sales.daily.map((x) => x.retail) },
            ], { height: 210, labels: sales.daily.map((x) => x.d) })) : empty('暂无销售数据', '', '📈')));
        const tot = sales.daily.reduce((s, x) => s + x.wholesale + x.retail, 0);
        const gift = sales.daily.reduce((s, x) => s + (x.gift || 0), 0);
        body.append(h('div', { class: 'grid g3' },
          h('div', { class: 'kpi' }, h('div', { class: 'k-label' }, '近 14 天销售额'), h('div', { class: 'k-value' }, fmtMoney(tot))),
          h('div', { class: 'kpi gold' }, h('div', { class: 'k-label' }, '促销让利价值'), h('div', { class: 'k-value' }, fmtMoney(gift))),
          h('div', { class: 'kpi info' }, h('div', { class: 'k-label' }, '商品结构'), h('div', { class: 'k-value', style: 'font-size:15px' },
            (sales.by_category || []).map((c) => `${c.category === 'bag' ? '袋装' : '盒装'} ${fmtQty(c.units, 16)}`).join(' · ') || '—'))));
      } else if (cur === 'stores') {
        const rows = await API.get('/api/reports/by-store');
        body.innerHTML = '';
        body.append(h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('b', {}, '门店排行（本月）')),
          table([
            { title: '排名', align: 'center', render: (r, i) => h('b', {}, String(i + 1)) },
            { title: '门店', render: (r) => h('b', {}, r.store_name) },
            { title: '订单数', align: 'center', render: (r) => r.orders },
            { title: '销售额', align: 'right', render: (r) => h('b', {}, fmtMoney(r.amount)) },
            { title: '促销让利', align: 'right', render: (r) => fmtMoney(r.gift) },
          ], rows)));
      } else if (cur === 'salesman') {
        const rows = await API.get('/api/reports/by-salesman');
        body.innerHTML = '';
        body.append(h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('b', {}, '业务员业绩（本月）')),
          table([
            { title: '业务员', render: (r) => h('b', {}, r.salesman_name) },
            { title: '成交订单', align: 'center', render: (r) => r.orders },
            { title: '销售额', align: 'right', render: (r) => h('b', {}, fmtMoney(r.sales)) },
            { title: '已回款', align: 'right', render: (r) => fmtMoney(r.paid) },
            { title: '回款率', align: 'right', render: (r) => chip(r.sales ? `${Math.round((r.paid / r.sales) * 100)}%` : '—', r.sales && r.paid >= r.sales ? 'ok' : 'warn') },
          ], rows)));
      } else if (cur === 'promo') {
        const rep = await API.get('/api/reports/promo');
        body.innerHTML = '';
        body.append(h('div', { class: 'grid g2' },
          h('div', { class: 'kpi gold' }, h('div', { class: 'k-label' }, '本月让利总价值'), h('div', { class: 'k-value' }, fmtMoney(rep.gift_value))),
          h('div', { class: 'kpi' }, h('div', { class: 'k-label' }, '活动'), h('div', { class: 'k-value', style: 'font-size:15px' }, '买二送半箱'))));
        body.append(h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('b', {}, '赠品投放明细（本月）')),
          table([
            { title: '商品', render: (r) => h('b', {}, r.product_name) },
            { title: '赠送数量', align: 'right', render: (r) => fmtQty(r.gift_units, 16) },
            { title: '折合箱数', align: 'right', render: (r) => `${Number(r.gift_cartons).toFixed(1)} 箱` },
          ], rep.rows)));
      } else {
        const rows = await API.get('/api/reports/inventory');
        body.innerHTML = '';
        body.append(h('div', { class: 'card' }, h('div', { class: 'card-hd' }, h('b', {}, '库存水位一览')),
          table([
            { title: '地点', render: (r) => h('b', {}, r.location_name) },
            { title: '商品', render: (r) => r.product_name },
            { title: '在库', align: 'right', render: (r) => h('b', {}, fmtQty(r.qty, r.units_per_carton)) },
            { title: '在途', align: 'right', render: (r) => r.transit ? chip(`在途 ${fmtQty(r.transit, r.units_per_carton)}`, 'info') : '—' },
          ], rows, { minWidth: 520 })));
      }
    } catch (e) { body.innerHTML = ''; body.append(errCard(e, render)); }
  };
  for (const [k, label] of tabs) {
    if (!avail.includes(k)) continue;
    const s = h('s', { onclick: () => { cur = k; $$('.seg s', seg).forEach((x) => x.classList.remove('on')); s.classList.add('on'); render(); } }, label);
    if (k === cur) s.classList.add('on');
    seg.append(s);
  }
  root.append(seg, body);
  await render();
}

/* ============ 个人中心 ============ */
/* 角色功能清单（可视化权限矩阵） */
const ROLE_FEATURES = {
  gm: [
    ['📊', '经营总览', '全局销售 / 应收 / 库存实时看板与 14 天趋势'],
    ['📋', '订单管理', '查看全部批发与零售订单、全程跟踪状态'],
    ['✅', '审批处理', '批发订单审批、门店领货申请审批'],
    ['💰', '资金管理', '应收台账、回款确认、促销让利监控'],
    ['⏰', '临期预警', '全部库位批次新鲜度监控与报废登记'],
    ['🏭', '仓储管理', '库存查询、采购入库、总仓调拨'],
    ['⚙️', '系统管理', '商品价格、门店组织、用户账号、审计日志'],
  ],
  mgr: [
    ['📊', '区域运营', '赣州区域销售 / 应收 / 库存看板'],
    ['✅', '订单审批', '批发订单审批与整单出库执行'],
    ['🚚', '调拨管理', '门店领货审批、总仓调拨、收货核销'],
    ['🏭', '采购入库', '供应商到货登记与入库'],
    ['💰', '回款确认', '业务员登记回款的到账确认'],
    ['⏰', '临期预警', '全部库位批次监控与报废登记'],
  ],
  sal: [
    ['🧾', '批发开单', '客户门店订货单创建（含买二送半箱自动赠品）'],
    ['📦', '订单跟进', '本人订单全状态跟踪、草稿续提'],
    ['💰', '回款登记', '登记客户回款并跟踪确认进度'],
    ['📊', '业绩看板', '个人销售趋势、待回款与门店排行'],
    ['🏭', '总仓查询', '总仓库存与临期预警查看'],
  ],
  prm: [
    ['🛒', '零售开单', '门店 POS 收银（现金/微信/支付宝，自动促销）'],
    ['🚚', '领货申请', '向总仓申请本店补货、确认收货'],
    ['🏪', '本店库存', '本店实时库存与批次新鲜度'],
    ['⏰', '临期预警', '本店临期批次监控（提前促销消化）'],
    ['📊', '销售报表', '本店销售趋势与促销活动查看'],
  ],
};
function roleFeaturesCard(role) {
  const feats = ROLE_FEATURES[role] || [];
  return h('div', { class: 'card' },
    h('div', { class: 'card-hd' }, h('b', {}, '我的角色功能'),
      h('span', { class: 'chip brand', style: 'margin-left:2px' }, `${feats.length} 项`)),
    h('div', { style: 'display:grid;gap:8px' }, feats.map(([ico, title, desc]) =>
      h('div', { class: 'todo-item', style: 'background:var(--bg-soft);border-radius:12px' },
        h('div', { class: 't-ico' }, ico),
        h('div', { class: 't-main' }, h('b', {}, title), h('span', {}, desc))))));
}

export function pageMe(root) {
  const u = API.user;
  const oldP = h('input', { class: 'ipt', type: 'password', placeholder: '请输入原密码' });
  const newP = h('input', { class: 'ipt', type: 'password', placeholder: '至少 6 位' });
  const newP2 = h('input', { class: 'ipt', type: 'password', placeholder: '再次输入新密码' });
  root.append(
    h('div', { class: 'card' },
      h('div', { style: 'display:flex;align-items:center;gap:14px' },
        h('div', { class: 'ava', style: 'width:56px;height:56px;font-size:20px;border-radius:18px;background:linear-gradient(135deg,var(--brand),#158C74);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800' }, u.name.slice(0, 1)),
        h('div', {}, h('div', { style: 'font-size:17px;font-weight:800' }, u.name),
          h('div', { style: 'font-size:12.5px;color:var(--ink-3);margin-top:2px' },
            `${ROLE_NAME[u.role]} · 工号 ${u.username}`, u.store_name ? ` · ${u.store_name}` : ''))),
      h('div', { style: 'margin-top:12px' }, chip(`权限范围：${{ gm: '全局数据与系统管理', mgr: '赣州区域运营管理', sal: '本人客户与订单', prm: '本店零售与库存' }[u.role]}`, 'brand'))),
    roleFeaturesCard(u.role),
    h('div', { class: 'card' },
      h('div', { class: 'card-hd' }, h('b', {}, '修改密码')),
      field('原密码', oldP, true),
      h('div', { class: 'form-2col' }, field('新密码', newP, true), field('确认新密码', newP2, true)),
      h('button', { class: 'btn', onclick: async () => {
        if (!oldP.value || !newP.value) return toast('请填写完整', 'err');
        if (newP.value !== newP2.value) return toast('两次输入的新密码不一致', 'err');
        try {
          await API.post('/api/auth/password', { old_password: oldP.value, new_password: newP.value });
          toast('密码修改成功', 'ok');
          oldP.value = newP.value = newP2.value = '';
        } catch (e) { toast(e.message, 'err'); }
      } }, '保存新密码')),
    h('div', { class: 'card' },
      h('div', { class: 'card-hd' }, h('b', {}, '安卓App安装')),
      h('p', { style: 'font-size:13px;color:var(--ink-2)' }, '在 Android 手机浏览器打开本系统地址，点击浏览器菜单中的「添加到主屏幕 / 安装应用」，即可获得全屏 App 体验。')),
    h('button', { class: 'btn danger block', style: 'margin-top:4px', onclick: () => {
      API.token = ''; API.user = null; location.hash = '#/login';
    } }, '退出登录'));
}

/* ============ 审计日志（总经理） ============ */
export async function pageAudit(root) {
  const rows = await API.get('/api/audit');
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-hd' }, h('b', {}, '审计日志'), h('span', { class: 'chip grey' }, `最近 ${rows.length} 条`)),
    table([
      { title: '时间', render: (r) => fmtDay(r.created_at) + ' ' + (r.created_at || '').slice(11, 16) },
      { title: '操作人', render: (r) => r.username },
      { title: '动作', render: (r) => h('b', {}, r.action) },
      { title: '对象', render: (r) => r.target || '—' },
      { title: '详情', render: (r) => { try { return JSON.stringify(JSON.parse(r.detail)); } catch { return r.detail || '—'; } } },
    ], rows, { minWidth: 640 })));
}
