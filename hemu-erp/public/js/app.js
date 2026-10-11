/* 合沐进销存 · 主入口：登录 / 布局 / 路由 */
import { API } from './api.js';
import { h, $, $$, toast, icon, ROLE_NAME } from './ui.js';
import { pageDash, pageTodos, pageReports, pageMe, pageAudit } from './pages-core.js';
import {
  pageOrders, pageOrderDetail, pageOrderNew, pagePOS, pageInventory,
  pageTransfers, pagePurchases, pagePayments, pageReceivables,
  pageProducts, pageStores, pageUsers, pagePromotions,
} from './pages-business.js';

/* ---------------- 登录页 ---------------- */
function renderLogin(root) {
  const uName = h('input', { class: 'ipt', placeholder: '工号', autocomplete: 'username', value: 'gm' });
  const uPass = h('input', { class: 'ipt', type: 'password', placeholder: '密码', autocomplete: 'current-password' });
  const btn = h('button', { class: 'btn lg block', style: 'margin-top:6px' }, '登 录');
  const doLogin = async () => {
    if (!uName.value.trim() || !uPass.value) return toast('请输入工号与密码', 'err');
    btn.disabled = true; btn.textContent = '登录中…';
    try {
      const r = await API.post('/api/auth/login', { username: uName.value.trim(), password: uPass.value });
      API.token = r.token; API.user = r.user;
      toast(`欢迎回来，${r.user.name}`, 'ok');
      location.hash = '#/dash';
      render();
    } catch (e) {
      btn.disabled = false; btn.textContent = '登 录';
      toast(e.message, 'err');
    }
  };
  btn.addEventListener('click', doLogin);
  uPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  uName.addEventListener('keydown', (e) => { if (e.key === 'Enter') uPass.focus(); });
  setTimeout(() => { (uName.value.trim() ? uPass : uName).focus(); }, 60);
  root.append(h('div', { class: 'login-wrap' },
    h('div', { class: 'login-card' },
      h('div', { class: 'login-brand' },
        h('img', { src: '/icons/icon-192.png', alt: '' }),
        h('div', {}, h('b', {}, '合沐进销存'), h('span', {}, 'HEMU ERP · 新疆合沐纯牛奶'))),
      h('div', { class: 'login-title' }, '欢迎登录'),
      h('div', { class: 'login-sub' }, '主仓库 + 赣州区域 + 多门店 一体化进销存管理'),
      fieldWrap('工号', uName), fieldWrap('密码', uPass),
      btn,
      h('div', { class: 'login-tip' },
        h('b', {}, '演示账号'), h('br'), '总经理 ', h('code', {}, 'gm / 123456'), '　业务经理 ', h('code', {}, 'mgr / 123456'),
        h('br'), '业务员 ', h('code', {}, 'sales01 / 123456'), '　促销员 ', h('code', {}, 'promo01 / 123456')))));
}
const fieldWrap = (label, input) => h('div', { class: 'field' }, h('label', {}, label), input);

/* ---------------- 导航配置 ---------------- */
const NAV = {
  gm: [
    ['运营', [
      ['#/dash', 'dash', '工作台'],
      ['#/todos', 'bell', '待办中心', 'todos'],
    ]],
    ['业务', [
      ['#/orders', 'order', '订单管理'],
      ['#/receivables', 'money', '应收台账'],
      ['#/payments', 'check', '回款记录'],
      ['#/promotions', 'gift', '促销活动'],
    ]],
    ['仓储', [
      ['#/inventory', 'stock', '库存查询'],
      ['#/purchases', 'box', '采购入库'],
      ['#/transfers', 'truck', '调拨管理'],
    ]],
    ['基础数据', [
      ['#/products', 'prod', '商品价格'],
      ['#/stores', 'store', '门店组织'],
      ['#/users', 'user', '用户账号'],
    ]],
    ['分析', [
      ['#/reports', 'chart', '报表中心'],
      ['#/audit', 'order', '审计日志'],
    ]],
  ],
  mgr: [
    ['运营', [
      ['#/dash', 'dash', '工作台'],
      ['#/todos', 'bell', '待办中心', 'todos'],
    ]],
    ['业务', [
      ['#/orders', 'order', '订单管理'],
      ['#/receivables', 'money', '应收台账'],
      ['#/payments', 'check', '回款记录'],
      ['#/promotions', 'gift', '促销活动'],
    ]],
    ['仓储', [
      ['#/inventory', 'stock', '库存查询'],
      ['#/purchases', 'box', '采购入库'],
      ['#/transfers', 'truck', '调拨管理'],
    ]],
    ['基础数据', [
      ['#/products', 'prod', '商品价格'],
      ['#/stores', 'store', '门店组织'],
    ]],
    ['分析', [
      ['#/reports', 'chart', '报表中心'],
    ]],
  ],
  sal: [
    ['运营', [
      ['#/dash', 'dash', '工作台'],
      ['#/todos', 'bell', '待办中心'],
    ]],
    ['业务', [
      ['#/orders', 'order', '我的订单'],
      ['#/orders/new', 'cart', '新建订单', 'plus'],
      ['#/payments', 'money', '回款记录'],
    ]],
    ['查询', [
      ['#/inventory', 'stock', '库存查询'],
      ['#/products', 'prod', '商品价格'],
      ['#/reports', 'chart', '我的报表'],
    ]],
  ],
  prm: [
    ['门店', [
      ['#/dash', 'dash', '工作台'],
      ['#/pos', 'cart', '零售开单', 'plus'],
      ['#/orders', 'order', '销售记录'],
    ]],
    ['仓储', [
      ['#/inventory', 'stock', '本店库存'],
      ['#/transfers', 'truck', '领货申请'],
    ]],
    ['查询', [
      ['#/products', 'prod', '商品价格'],
      ['#/promotions', 'gift', '促销活动'],
      ['#/reports', 'chart', '销售报表'],
    ]],
  ],
};
const MOBILE_TABS = {
  gm: [['#/dash', 'dash', '工作台'], ['#/orders', 'order', '订单'], ['#/inventory', 'stock', '库存'], ['#/reports', 'chart', '报表'], ['#/me', 'me', '我的']],
  mgr: [['#/dash', 'dash', '工作台'], ['#/orders', 'order', '订单'], ['#/inventory', 'stock', '库存'], ['#/reports', 'chart', '报表'], ['#/me', 'me', '我的']],
  sal: [['#/dash', 'dash', '工作台'], ['#/orders', 'order', '订单'], ['#/orders/new', 'cart', '开单'], ['#/inventory', 'stock', '库存'], ['#/me', 'me', '我的']],
  prm: [['#/dash', 'dash', '工作台'], ['#/pos', 'cart', '开单'], ['#/inventory', 'stock', '库存'], ['#/transfers', 'truck', '领货'], ['#/me', 'me', '我的']],
};
const PAGE_TITLE = {
  dash: '工作台', todos: '待办中心', orders: '订单管理', 'orders/new': '新建批发订单',
  pos: '零售开单', inventory: '库存查询', transfers: '调拨管理', purchases: '采购入库',
  payments: '回款记录', receivables: '应收台账', products: '商品价格', stores: '门店组织',
  users: '用户账号', promotions: '促销活动', reports: '报表中心', me: '个人中心', audit: '审计日志',
};

/* ---------------- 布局 ---------------- */
async function renderShell(root, route) {
  const u = API.user;
  const hash = location.hash.replace('#/', '').split('?')[0];
  const badges = await loadBadges();
  const nav = NAV[u.role] || [];

  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'sb-brand' },
      h('img', { src: '/icons/icon-192.png', alt: '' }),
      h('div', {}, h('b', {}, '合沐进销存'), h('i', {}, 'HEMU · 新鲜看得见'))),
    h('nav', { class: 'sb-nav' },
      nav.map(([group, items]) => h('div', {},
        h('div', { class: 'sb-group' }, group),
        items.map(([href, ico, label, badge]) => {
          const on = hash === href.replace('#/', '') || (href !== '#/dash' && hash.startsWith(href.replace('#/', '') + '/'))
            || (href === '#/orders' && (hash === 'orders' || (hash.startsWith('orders/') && hash !== 'orders/new')));
          const a = h('a', { class: `sb-item ${on ? 'on' : ''}`, href }, icon(ico, 17), label,
            badge && badges[badge] > 0 ? h('span', { class: 'bdg' }, String(badges[badge])) : null);
          return a;
        })))),
    h('div', { class: 'sb-foot' }, `赣州市区域运营 · v1.0 正式版`));

  const activeTab = Object.entries(MOBILE_TABS[u.role] || []).find(([href]) => hash === href.replace('#/', '') || hash.startsWith(href.replace('#/', '') + '/'));
  const tabbar = h('nav', { class: 'tabbar' },
    (MOBILE_TABS[u.role] || []).map(([href, ico, label]) =>
      h('a', { class: `tab ${activeTab && activeTab[0] === href ? 'on' : ''}`, href }, icon(ico, 21), h('span', {}, label))));
  const pendBadge = badges.todos || 0;
  const topbar = h('header', { class: 'topbar' },
    h('div', {},
      h('div', { class: 'tb-title' }, PAGE_TITLE[hash] || '合沐进销存'),
      h('div', { class: 'tb-sub' }, '新疆合沐纯牛奶 · 江西赣州')),
    h('div', { class: 'tb-right' },
      h('a', { class: 'ghost', href: '#/todos', style: 'position:relative;display:inline-flex;color:var(--ink-2)', title: '待办中心' },
        icon('bell', 19), pendBadge > 0 ? h('span', { class: 'chip bad', style: 'position:absolute;top:-8px;right:-10px;padding:0 5.5px;font-size:10px' }, String(pendBadge)) : null),
      h('a', { class: 'tb-user', href: '#/me' },
        h('span', { class: 'ava' }, u.name.slice(0, 1)),
        h('div', {}, h('b', {}, u.name), h('i', {}, ROLE_NAME[u.role])))));
  const mTop = h('div', { class: 'm-topbar' },
    h('div', {},
      h('div', { class: 'mt-title' }, PAGE_TITLE[hash] || '合沐进销存'),
      h('div', { class: 'tb-sub' }, '新疆合沐纯牛奶 · 赣州')),
    h('div', { class: 'mt-right' },
      h('a', { class: 'mt-bell', href: '#/todos' }, icon('bell', 18), pendBadge > 0 ? h('span', { class: 'bdg' }, String(pendBadge > 99 ? '99+' : pendBadge)) : null),
      h('a', { class: 'tb-user', href: '#/me' }, h('span', { class: 'ava' }, u.name.slice(0, 1)))));

  const content = h('main', { class: 'content' }, h('div', { class: 'skel', style: 'height:120px' }));
  root.append(h('div', { class: 'shell' }, sidebar,
    h('div', { class: 'main' }, topbar, mTop, content), tabbar));
  const main = h('div', {});
  content.innerHTML = '';
  content.append(main);
  await renderRoute(main, hash);
}
async function loadBadges() {
  try {
    const u = API.user;
    if (u.role === 'gm' || u.role === 'mgr') {
      const t = await API.get('/api/todos');
      return { todos: t.orders.length + t.transfers.length + t.payments.length };
    }
  } catch { /* 忽略 */ }
  return {};
}

/* ---------------- 路由 ---------------- */
async function renderRoute(root, hash) {
  if (hash.startsWith('orders/new')) return pageOrderNew(root);
  if (hash.startsWith('orders/')) return pageOrderDetail(root, Number(hash.split('/')[1]));
  const routes = {
    dash: pageDash, todos: pageTodos, orders: pageOrders, pos: pagePOS,
    inventory: pageInventory, transfers: pageTransfers, purchases: pagePurchases,
    payments: pagePayments, receivables: pageReceivables, products: pageProducts,
    stores: pageStores, users: pageUsers, promotions: pagePromotions,
    reports: pageReports, me: pageMe, audit: pageAudit,
  };
  const fn = routes[hash];
  if (!fn) { location.hash = '#/dash'; return; }
  await fn(root);
}

/* ---------------- 渲染入口 ---------------- */
export function rerender() { render(); }
function render() {
  const root = $('#app');
  root.innerHTML = '';
  const hash = location.hash.replace('#', '') || '/dash';
  if (!API.user) { location.hash = '#/login'; renderLogin(root); return; }
  if (hash === '/login') { location.hash = '#/dash'; }
  renderShell(root, hash).catch((e) => {
    root.innerHTML = '';
    root.append(h('div', { class: 'login-wrap' },
      h('div', { class: 'login-card', style: 'text-align:center' },
        h('div', { style: 'font-size:34px' }, '⚠'),
        h('b', { style: 'display:block;margin:10px 0 6px' }, '页面加载失败'),
        h('p', { style: 'font-size:13px;color:var(--ink-3);margin-bottom:16px' }, e.message),
        h('button', { class: 'btn', onclick: () => render() }, '重新加载'))));
  });
}
window.addEventListener('hashchange', render);
render();
