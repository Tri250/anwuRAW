/* UI 工具：元素构建、格式化、组件（toast/modal/图表/状态） */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- 元素构建 ---------- */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'readonly') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(9)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

/* ---------- 格式化 ---------- */
export const fmtMoney = (fen) => `¥${(Number(fen || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtNum = (n) => Number(n || 0).toLocaleString('zh-CN');
export function fmtQty(qty, upc = 16) {
  const c = Math.floor(qty / upc), l = qty - c * upc;
  if (c && l) return `${c}箱${l}散`;
  if (c) return `${c}箱`;
  return `${l}散`;
}
export const fmtTime = (s) => (s || '').replace('T', ' ').slice(5, 16);
export const fmtDay = (s) => (s || '').slice(5, 10);

/* ---------- 常量映射 ---------- */
export const ROLE_NAME = { gm: '总经理', mgr: '业务经理', sal: '业务员', prm: '促销员' };
export const ORDER_STATUS = {
  draft: ['草稿', 'grey'], pending: ['待审批', 'warn'], approved: ['已审批', 'info'],
  partial: ['部分出库', 'info'], shipped: ['已出库', 'brand'], done: ['已完成', 'ok'],
  rejected: ['已驳回', 'bad'], cancelled: ['已取消', 'grey'],
};
export const TRANSFER_STATUS = {
  pending: ['待审批', 'warn'], transit: ['在途', 'info'], received: ['已入库', 'ok'],
  rejected: ['已驳回', 'bad'], cancelled: ['已取消', 'grey'],
};
export const MOVE_TYPE = {
  purchase: ['采购入库', 'ok'], transfer_out: ['调拨出库', 'info'], transfer_in: ['调拨入库', 'info'],
  sale_out: ['销售出库', 'brand'], gift_out: ['赠品出库', 'gold'], loss: ['调拨损耗', 'bad'],
};
export const chip = (text, color) => h('span', { class: `chip ${color || 'grey'}` }, text);
export const statusChip = (map, key) => { const [t, c] = map[key] || [key, 'grey']; return chip(t, c); };

/* ---------- Toast ---------- */
export function toast(msg, type = '') {
  const t = h('div', { class: `toast ${type}` }, type === 'err' ? '⚠' : type === 'ok' ? '✓' : '·', msg);
  $('#toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 2600);
}

/* ---------- Modal ---------- */
export function modal({ title, body, footer, wide }) {
  const m = h('div', { class: 'mask' },
    h('div', { class: `modal ${wide ? 'wide' : ''}` },
      h('div', { class: 'm-hd' }, h('b', {}, title),
        h('button', { class: 'm-x', onclick: () => close() }, '✕')),
      h('div', { class: 'm-bd' }, body),
      footer ? h('div', { class: 'm-ft' }, footer) : null));
  const close = () => m.remove();
  m.addEventListener('click', (e) => { if (e.target === m) close(); });
  document.body.append(m);
  return { close, el: m };
}
export const confirmBox = (title, message, onOk, okText = '确定', danger) => {
  const m = modal({
    title,
    body: h('p', { style: 'color:var(--ink-2);font-size:13.5px;line-height:1.8' }, message),
    footer: [
      h('button', { class: 'btn ghost', onclick: () => m.close() }, '取消'),
      h('button', { class: `btn ${danger ? 'danger' : ''}`, onclick: async () => { await onOk(); m.close(); } }, okText),
    ],
  });
};

/* ---------- 图表（SVG 自绘，零依赖） ---------- */
export function lineChart(series, { height = 200, labels } = {}) {
  const W = 760, H = height, PL = 46, PR = 10, PT = 14, PB = 24;
  const n = series[0].data.length;
  const max = Math.max(1, ...series.flatMap((s) => s.data));
  const x = (i) => PL + (i * (W - PL - PR)) / Math.max(1, n - 1);
  const y = (v) => PT + (1 - v / max) * (H - PT - PB);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const gy = y(max * t);
    return [
      h('line', { x1: PL, y1: gy, x2: W - PR, y2: gy, stroke: '#ECEAE2', 'stroke-width': 1 }),
      h('text', { x: PL - 6, y: gy + 3.5, 'text-anchor': 'end', 'font-size': 9.5, fill: '#9AA6A1' }, fmtMoneyShort(max * t)),
    ];
  }).flat();
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  const xt = (labels || []).map((d, i) => (i % Math.ceil(n / 8) === 0
    ? h('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 9.5, fill: '#9AA6A1' },
      labels[i] ? (String(d).length >= 10 ? String(d).slice(5, 10) : d) : '')
    : null));
  const paths = series.map((s) => {
    const pts = s.data.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    const area = `M ${x(0)},${y(s.data[0])} ` + s.data.map((v, i) => `L ${x(i)},${y(v)}`).join(' ') + ` L ${x(n - 1)},${H - PB} L ${x(0)},${H - PB} Z`;
    return [
      h('path', { d: area, fill: s.color, opacity: .07 }),
      h('polyline', { points: pts, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
      ...s.data.map((v, i) => h('circle', { cx: x(i), cy: y(v), r: 2.4, fill: '#fff', stroke: s.color, 'stroke-width': 1.6 })),
    ];
  }).flat(9);
  const svg = h('svg', { viewBox: `0 0 ${W} ${H}`, style: 'width:100%;height:auto;display:block' }, grid, xt, paths);
  return svg;
}
const fmtMoneyShort = (fen) => {
  if (fen >= 100000) return `¥${(fen / 100000).toFixed(1)}万`;
  if (fen >= 10000) return `¥${Math.round(fen / 10000)}万`;
  if (fen >= 100) return `¥${Math.round(fen / 100)}`;
  return `¥${Math.round(fen)}`;
};

/* 简易灯箱日历轴 */
export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* 表单快捷构建 */
export function field(label, input, required) {
  return h('div', { class: 'field' }, h('label', {}, label, required ? h('span', { class: 'req' }, '*') : null), input);
}
export function stepper(value, onChange, { min = 0, max = 99999 } = {}) {
  const inp = h('input', { type: 'number', min, max, value: String(value) });
  const set = (v) => { inp.value = String(Math.max(min, Math.min(max, v))); onChange(Number(inp.value)); };
  const box = h('div', { class: 'stepper' },
    h('button', { type: 'button', onclick: () => set(Number(inp.value || 0) - 1) }, '−'),
    inp,
    h('button', { type: 'button', onclick: () => set(Number(inp.value || 0) + 1) }, '+'));
  inp.addEventListener('change', () => set(Number(inp.value || 0)));
  return box;
}

/* 通用列表加载骨架 */
export function skeleton(rows = 4) {
  return h('div', {}, ...Array.from({ length: rows }, () => h('div', { style: 'margin:14px 0' }, h('div', { class: 'skel', style: 'height:38px' }))));
}

/* 空态 */
export const empty = (title, sub, ico = '📦') =>
  h('div', { class: 'empty' }, h('div', { class: 'e-ico' }, ico), h('b', {}, title), sub ? h('span', {}, sub) : null);

/* 状态流水线 */
export function pipeline(steps, currentIdx, badIdx = -1) {
  return h('div', { class: 'pipeline' },
    steps.map((s, i) => h('span', { class: 'p-step' },
      h('span', { class: `p-node ${i === currentIdx ? 'cur' : ''} ${i === badIdx ? 'bad' : ''} ${i < currentIdx && badIdx < 0 ? 'done' : ''}` }, s),
      i < steps.length - 1 ? h('span', { class: 'p-arr' }, '→') : null)));
}

/* 表格构建 */
export function table(cols, rows, opts = {}) {
  return h('div', { class: 'tbl-wrap' },
    h('table', { class: 'tbl', style: opts.minWidth ? `min-width:${opts.minWidth}px` : '' },
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.align ? `ta-${c.align}` : '' }, c.title)))),
      h('tbody', {}, rows.length
        ? rows.map((r, ri) => h('tr', {}, cols.map((c) => h('td', { class: c.align ? `ta-${c.align}` : '' }, c.render(r, ri)))))
        : [h('tr', {}, h('td', { colspan: cols.length, style: 'padding:0' }, opts.empty || empty('暂无数据', '')))])));
}

/* 图标（内联 SVG，线性风格） */
export const ICON = {
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="8" height="10" rx="2"/><rect x="13" y="3" width="8" height="6" rx="2"/><rect x="13" y="11" width="8" height="10" rx="2"/><rect x="3" y="15" width="8" height="6" rx="2"/></svg>',
  order: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>',
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="20" r="1.6"/><circle cx="18" cy="20" r="1.6"/><path d="M2 3h3l2.6 12.4a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 7H6"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 4h14v13H1z"/><path d="M15 8h4l4 4v5h-8z"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/></svg>',
  stock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7l8-4 8 4v10l-8 4-8-4z"/><path d="M4 7l8 4 8-4M12 11v10"/></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 9v.01M18 15v.01"/></svg>',
  gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M12 8v13M12 8s-4 0-4-3a2 2 0 0 1 4 0M12 8s4 0 4-3a2 2 0 0 0-4 0"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 21h18"/><rect x="5" y="11" width="3.5" height="7" rx="1"/><rect x="10.5" y="7" width="3.5" height="11" rx="1"/><rect x="16" y="4" width="3.5" height="14" rx="1"/></svg>',
  store: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7l1.5-4h13L20 7M4 7h16v3a3 3 0 0 1-5.3 1.9A3 3 0 0 1 12 13a3 3 0 0 1-2.7-1.1A3 3 0 0 1 4 10z"/><path d="M5 12.8V21h14v-8.2M9 21v-5h6v5"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  prod: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2s5 4.5 5 9a5 5 0 0 1-10 0c0-4.5 5-9 5-9z"/><path d="M8 14c1 3 2.5 5 4 8 1.5-3 3-5 4-8"/></svg>',
  promo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 12l-8.5 8.5a2 2 0 0 1-2.8 0L3 14.8a2 2 0 0 1 0-2.8L11.5 3.5H17a3 3 0 0 1 3 3z"/><circle cx="16" cy="8" r="1.4"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6 19c1.2-2.5 3.4-4 6-4s4.8 1.5 6 4"/></svg>',
};
export const icon = (name, size = 18) => h('span', { html: ICON[name] || '', style: `display:inline-flex;width:${size}px;height:${size}px;flex:none;align-items:center;justify-content:center` });
