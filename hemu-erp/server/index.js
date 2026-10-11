/**
 * 合沐纯牛奶进销存管理系统 · 服务端
 * Express + node:sqlite · JWT 鉴权 · RBAC · 进销存全链路 API
 */
'use strict';
const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  db, hashPassword, verifyPassword, now, dayStr, nextNo,
  getInv, addStock, audit, buildOrderLines, DB_PATH,
} = require('./db');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = process.env.HEMU_SECRET || 'hemu-erp-secret-2026';
const UPC_DEFAULT = 16;

/* ================= 工具 ================= */
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const signJWT = (payload, hours = 12) => {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + hours * 3600 }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
};
function verifyJWT(token) {
  try {
    const [h, b, s] = String(token).split('.');
    const expect = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url');
    if (s !== expect) return null;
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}
const ok = (res, data) => res.json({ code: 0, data });
const fail = (res, msg, status = 400) => res.status(status).json({ code: 1, message: msg });
const wrap = (fn) => (req, res) => { try { fn(req, res); } catch (e) { fail(res, e.message || '服务器内部错误', 500); } };
/* 事务包装：多步库存/资金写入原子化 */
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}

/* 登录锁定 */
const lockMap = new Map();
const LOCK_LIMIT = 5, LOCK_MS = 10 * 60 * 1000;

/* 鉴权中间件 */
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const payload = verifyJWT(token);
  if (!payload) return fail(res, '未登录或登录已过期', 401);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(payload.uid);
  if (!u || u.status !== 'active') return fail(res, '账号不可用', 401);
  req.user = u;
  next();
}
const roles = (...rs) => (req, res, next) => {
  if (!rs.includes(req.user.role)) return fail(res, '无权限执行该操作', 403);
  next();
};

/* 展示辅助：最小单位 → 箱/散 */
function splitUnits(qty, upc = UPC_DEFAULT) {
  const cartons = Math.floor(qty / upc);
  return { cartons, loose: qty - cartons * upc, total: qty };
}

/* ================= 鉴权 ================= */
app.post('/api/auth/login', wrap((req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return fail(res, '请输入工号与密码');
  const lock = lockMap.get(username);
  if (lock && lock.until > Date.now()) {
    return fail(res, `密码错误次数过多，账号已锁定，请 ${Math.ceil((lock.until - Date.now()) / 60000)} 分钟后再试`);
  }
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).trim());
  if (!u || !verifyPassword(password, u.password_hash)) {
    const c = ((lock && lock.count) || 0) + 1;
    lockMap.set(username, c >= LOCK_LIMIT ? { count: 0, until: Date.now() + LOCK_MS } : { count: c, until: 0 });
    return fail(res, '工号或密码错误');
  }
  if (u.status !== 'active') return fail(res, '账号已停用，请联系总经理');
  lockMap.delete(username);
  const store = u.store_id ? db.prepare('SELECT name FROM locations WHERE id=?').get(u.store_id) : null;
  audit(u.id, u.username, 'login', 'auth', '');
  ok(res, {
    token: signJWT({ uid: u.id, role: u.role }),
    user: { id: u.id, username: u.username, name: u.name, role: u.role, store_id: u.store_id, store_name: store ? store.name : '' },
  });
}));

app.get('/api/auth/me', auth, wrap((req, res) => {
  const u = req.user;
  const store = u.store_id ? db.prepare('SELECT name,type FROM locations WHERE id=?').get(u.store_id) : null;
  ok(res, { id: u.id, username: u.username, name: u.name, role: u.role, store_id: u.store_id, store_name: store ? store.name : '' });
}));

app.post('/api/auth/password', auth, wrap((req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!verifyPassword(old_password || '', req.user.password_hash)) return fail(res, '原密码不正确');
  if (!new_password || String(new_password).length < 6) return fail(res, '新密码至少 6 位');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(new_password), req.user.id);
  audit(req.user.id, req.user.username, 'password.change', 'auth', '');
  ok(res, {});
}));

/* ================= 用户管理（总经理） ================= */
app.get('/api/users', auth, wrap((req, res) => {
  const rows = db.prepare(`
    SELECT u.id,u.username,u.name,u.role,u.phone,u.status,u.store_id,l.name AS store_name,u.created_at
    FROM users u LEFT JOIN locations l ON l.id=u.store_id ORDER BY u.id`).all();
  ok(res, rows);
}));
app.post('/api/users', auth, roles('gm'), wrap((req, res) => {
  const { username, name, role, store_id, phone, password } = req.body || {};
  if (!username || !name || !role) return fail(res, '工号、姓名、角色必填');
  if (!['gm', 'mgr', 'sal', 'prm'].includes(role)) return fail(res, '角色不合法');
  if (role === 'prm' && !store_id) return fail(res, '促销员必须绑定门店');
  if (!password || String(password).length < 6) return fail(res, '初始密码至少 6 位');
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) return fail(res, '工号已存在');
  const r = db.prepare('INSERT INTO users (username,name,role,password_hash,store_id,phone,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(String(username).trim(), String(name).trim(), role, hashPassword(password), store_id ? Number(store_id) : null, phone || '', now());
  audit(req.user.id, req.user.username, 'user.create', `user:${r.lastInsertRowid}`, { username, role });
  ok(res, { id: Number(r.lastInsertRowid) });
}));
app.put('/api/users/:id', auth, roles('gm'), wrap((req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return fail(res, '用户不存在', 404);
  const { name, role, store_id, phone, status, password } = req.body || {};
  if (u.role === 'gm' && role && role !== 'gm' && id === req.user.id) return fail(res, '不能修改自己的总经理角色');
  db.prepare('UPDATE users SET name=?, role=?, store_id=?, phone=?, status=? WHERE id=?')
    .run(name || u.name, role || u.role, store_id !== undefined ? (store_id ? Number(store_id) : null) : u.store_id,
      phone !== undefined ? phone : u.phone, status || u.status, id);
  if (password) {
    if (String(password).length < 6) return fail(res, '密码至少 6 位');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), id);
  }
  audit(req.user.id, req.user.username, 'user.update', `user:${id}`, { status, role });
  ok(res, {});
}));

/* ================= 组织与门店 ================= */
app.get('/api/locations', auth, wrap((req, res) => {
  let rows = db.prepare('SELECT * FROM locations ORDER BY type DESC, code').all();
  if (req.user.role === 'prm') rows = rows.filter((l) => l.id === req.user.store_id || l.type === 'main');
  ok(res, rows);
}));
app.post('/api/locations', auth, roles('gm', 'mgr'), wrap((req, res) => {
  const { name, address, contact, phone } = req.body || {};
  if (!name) return fail(res, '门店名称必填');
  const n = db.prepare('SELECT COUNT(*) c FROM locations').get().c + 1;
  const code = `HM-S-${String(n).padStart(3, '0')}`;
  const r = db.prepare('INSERT INTO locations (code,name,type,region,address,contact,phone,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(code, String(name).trim(), 'store', '江西省赣州市', address || '', contact || '', phone || '', now());
  audit(req.user.id, req.user.username, 'location.create', `location:${r.lastInsertRowid}`, name);
  ok(res, { id: Number(r.lastInsertRowid) });
}));
app.put('/api/locations/:id', auth, roles('gm', 'mgr'), wrap((req, res) => {
  const id = Number(req.params.id);
  const l = db.prepare('SELECT * FROM locations WHERE id=?').get(id);
  if (!l) return fail(res, '地点不存在', 404);
  if (l.type === 'main' && req.body.status === 'disabled') return fail(res, '总仓库不可停用');
  const { name, address, contact, phone, status } = req.body || {};
  db.prepare('UPDATE locations SET name=?, address=?, contact=?, phone=?, status=? WHERE id=?')
    .run(name || l.name, address !== undefined ? address : l.address, contact !== undefined ? contact : l.contact,
      phone !== undefined ? phone : l.phone, status || l.status, id);
  audit(req.user.id, req.user.username, 'location.update', `location:${id}`, { status });
  ok(res, {});
}));

/* ================= 商品与价格 ================= */
app.get('/api/products', auth, wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM products ORDER BY id').all();
  ok(res, rows.map((p) => ({
    ...p,
    wholesale_loose: Math.round(p.wholesale_price / p.units_per_carton),
    retail_loose: Math.round(p.retail_price / p.units_per_carton),
  })));
}));
app.post('/api/products', auth, roles('gm'), wrap((req, res) => {
  const { sku, name, category, units_per_carton, wholesale_price, retail_price } = req.body || {};
  if (!sku || !name || !category) return fail(res, 'SKU、品名、分类必填');
  if (!['bag', 'box'].includes(category)) return fail(res, '分类必须为袋装或盒装');
  const upc = Number(units_per_carton) || 16;
  const wp = Math.round(Number(wholesale_price) * 100), rp = Math.round(Number(retail_price) * 100);
  if (!wp || !rp) return fail(res, '批发价与零售价必填');
  if (db.prepare('SELECT id FROM products WHERE sku=?').get(sku)) return fail(res, 'SKU 已存在');
  const r = db.prepare('INSERT INTO products (sku,name,category,spec,units_per_carton,wholesale_price,retail_price,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(String(sku).trim(), String(name).trim(), category, '200ml', upc, wp, rp, now());
  audit(req.user.id, req.user.username, 'product.create', `product:${r.lastInsertRowid}`, sku);
  ok(res, { id: Number(r.lastInsertRowid) });
}));
app.put('/api/products/:id', auth, roles('gm'), wrap((req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!p) return fail(res, '商品不存在', 404);
  const { name, wholesale_price, retail_price, status } = req.body || {};
  const wp = wholesale_price !== undefined ? Math.round(Number(wholesale_price) * 100) : p.wholesale_price;
  const rp = retail_price !== undefined ? Math.round(Number(retail_price) * 100) : p.retail_price;
  if (!wp || !rp) return fail(res, '价格不合法');
  db.prepare('UPDATE products SET name=?, wholesale_price=?, retail_price=?, status=? WHERE id=?')
    .run(name || p.name, wp, rp, status || p.status, id);
  if (wp !== p.wholesale_price || rp !== p.retail_price) {
    audit(req.user.id, req.user.username, 'product.price', `product:${id}`, { old: [p.wholesale_price, p.retail_price], new: [wp, rp] });
  }
  ok(res, {});
}));

/* ================= 库存 ================= */
app.get('/api/inventory', auth, wrap((req, res) => {
  const locId = req.query.location_id ? Number(req.query.location_id) : null;
  let sql = `SELECT i.location_id, i.product_id, i.qty, i.transit, l.name AS location_name, l.type AS location_type,
    p.sku, p.name AS product_name, p.category, p.units_per_carton, p.status AS product_status
    FROM inventory i JOIN locations l ON l.id=i.location_id JOIN products p ON p.id=i.product_id`;
  const conds = [], args = [];
  if (locId) { conds.push('i.location_id=?'); args.push(locId); }
  if (req.user.role === 'prm') { conds.push('i.location_id=?'); args.push(req.user.store_id); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY l.type DESC, l.code, p.id';
  const rows = db.prepare(sql).all(...args);
  ok(res, rows.map((r) => ({ ...r, ...splitUnits(r.qty, r.units_per_carton), transit_split: splitUnits(r.transit, r.units_per_carton) })));
}));

app.get('/api/stock-moves', auth, wrap((req, res) => {
  const { location_id, product_id, type, days } = req.query;
  const n = Math.min(Number(days) || 30, 90);
  let sql = `SELECT m.*, l.name AS location_name, p.name AS product_name, p.units_per_carton, u.name AS user_name
    FROM stock_moves m JOIN locations l ON l.id=m.location_id JOIN products p ON p.id=m.product_id
    LEFT JOIN users u ON u.id=m.user_id WHERE m.created_at >= ?`;
  const args = [`${dayStr(n - 1)} 00:00:00`];
  if (location_id) { sql += ' AND m.location_id=?'; args.push(Number(location_id)); }
  if (product_id) { sql += ' AND m.product_id=?'; args.push(Number(product_id)); }
  if (type) { sql += ' AND m.type=?'; args.push(type); }
  if (req.user.role === 'prm') { sql += ' AND m.location_id=?'; args.push(req.user.store_id); }
  sql += ' ORDER BY m.id DESC LIMIT 500';
  ok(res, db.prepare(sql).all(...args));
}));

/* ================= 采购入库（总仓） ================= */
app.get('/api/purchases', auth, roles('gm', 'mgr'), wrap((req, res) => {
  const rows = db.prepare(`SELECT p.*, u.name AS user_name FROM purchases p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 200`).all();
  ok(res, rows.map((r) => ({ ...r, items: JSON.parse(r.items) })));
}));
app.post('/api/purchases', auth, roles('gm', 'mgr'), wrap((req, res) => {
  const { items, supplier, note } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return fail(res, '请至少录入一行商品');
  const main = db.prepare("SELECT id FROM locations WHERE type='main'").get();
  if (!main) return fail(res, '未找到总仓库', 500);
  const prods = db.prepare('SELECT * FROM products').all();
  const norm = [];
  let totalAmount = 0;
  for (const it of items) {
    const p = prods.find((x) => x.id === Number(it.product_id));
    if (!p) return fail(res, '商品不存在');
    const cartons = Math.max(0, Math.floor(Number(it.cartons) || 0));
    const loose = Math.max(0, Math.floor(Number(it.loose) || 0));
    if (cartons + loose <= 0) continue;
    const qty = cartons * p.units_per_carton + loose;
    const amount = cartons * p.wholesale_price + loose * Math.round(p.wholesale_price / p.units_per_carton);
    totalAmount += amount;
    norm.push({ product_id: p.id, cartons, loose, qty, amount });
  }
  if (norm.length === 0) return fail(res, '入库数量必须大于 0');
  const no = nextNo('CG', 'purchases');
  tx(() => {
    db.prepare('INSERT INTO purchases (no,supplier,note,items,user_id,created_at) VALUES (?,?,?,?,?,?)')
      .run(no, supplier || '', note || '', JSON.stringify(norm), req.user.id, now());
    for (const n of norm) {
      if (n.qty >= 0) addStock(main.id, n.product_id, n.qty, 'purchase', no, note || '', req.user.id);
    }
  });
  audit(req.user.id, req.user.username, 'purchase.create', no, { totalAmount, supplier });
  ok(res, { no });
}));

/* ================= 调拨（含门店领货申请） ================= */
app.get('/api/transfers', auth, wrap((req, res) => {
  let sql = `SELECT t.*, lf.name AS from_name, lt.name AS to_name, ur.name AS requester_name, ua.name AS approver_name
    FROM transfers t JOIN locations lf ON lf.id=t.from_loc JOIN locations lt ON lt.id=t.to_loc
    LEFT JOIN users ur ON ur.id=t.requested_by LEFT JOIN users ua ON ua.id=t.approved_by`;
  const conds = [], args = [];
  if (req.user.role === 'prm') { conds.push('t.to_loc=?'); args.push(req.user.store_id); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY t.id DESC LIMIT 200';
  const rows = db.prepare(sql).all(...args);
  const prods = db.prepare('SELECT id,name,units_per_carton,sku FROM products').all();
  ok(res, rows.map((r) => ({
    ...r,
    items: JSON.parse(r.items).map((it) => {
      const p = prods.find((x) => x.id === it.product_id);
      return { ...it, product_name: p ? p.name : '', units_per_carton: p ? p.units_per_carton : 16, ...splitUnits(it.qty, p ? p.units_per_carton : 16), received_split: splitUnits(it.received_qty || 0, p ? p.units_per_carton : 16) };
    }),
  })));
}));
function createTransfer(req, res, asApplication) {
  const { to_loc, items, note } = req.body || {};
  const to = db.prepare('SELECT * FROM locations WHERE id=?').get(Number(to_loc));
  if (!to || to.type !== 'store') return fail(res, '请选择收货门店');
  if (to.status !== 'active') return fail(res, '该门店已停用');
  const main = db.prepare("SELECT id FROM locations WHERE type='main'").get();
  const prods = db.prepare('SELECT * FROM products').all();
  const norm = [];
  for (const it of items || []) {
    const p = prods.find((x) => x.id === Number(it.product_id));
    if (!p) return fail(res, '商品不存在');
    const cartons = Math.max(0, Math.floor(Number(it.cartons) || 0));
    const loose = Math.max(0, Math.floor(Number(it.loose) || 0));
    if (cartons + loose <= 0) continue;
    norm.push({ product_id: p.id, qty: cartons * p.units_per_carton + loose, received_qty: 0 });
  }
  if (norm.length === 0) return fail(res, '调拨数量必须大于 0');
  if (asApplication) {
    const no = nextNo('DB', 'transfers');
    db.prepare('INSERT INTO transfers (no,from_loc,to_loc,items,status,note,requested_by,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(no, main.id, to.id, JSON.stringify(norm), 'pending', note || '门店领货申请', req.user.id, now());
    audit(req.user.id, req.user.username, 'transfer.apply', no, { to: to.name });
    const created = db.prepare('SELECT id FROM transfers WHERE no=?').get(no);
    return ok(res, { id: created.id, no, status: 'pending' });
  }
  // 经理/总经理直接调拨：校验总仓库存并立即出库
  const no = nextNo('DB', 'transfers');
  tx(() => {
    for (const n of norm) {
      const inv = getInv(main.id, n.product_id);
      if (inv.qty < n.qty) {
        const p = prods.find((x) => x.id === n.product_id);
        throw new Error(`总仓「${p.name}」库存不足：现有 ${inv.qty} 件，需 ${n.qty} 件`);
      }
    }
    db.prepare('INSERT INTO transfers (no,from_loc,to_loc,items,status,note,requested_by,approved_by,approved_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(no, main.id, to.id, JSON.stringify(norm), 'transit', note || '', req.user.id, req.user.id, now(), now());
    for (const n of norm) {
      addStock(main.id, n.product_id, -n.qty, 'transfer_out', no, '调拨出库', req.user.id);
      getInv(to.id, n.product_id);
      db.prepare('UPDATE inventory SET transit = transit + ? WHERE location_id=? AND product_id=?').run(n.qty, to.id, n.product_id);
    }
  });
  audit(req.user.id, req.user.username, 'transfer.create', no, { to: to.name });
  ok(res, { no, status: 'transit' });
}
app.post('/api/transfers', auth, wrap((req, res) => {
  if (req.user.role === 'prm') return createTransfer(req, res, true);
  return createTransfer(req, res, false);
}));
app.post('/api/transfers/:id/approve', auth, roles('gm', 'mgr'), wrap((req, res) => {
  const t = db.prepare('SELECT * FROM transfers WHERE id=?').get(Number(req.params.id));
  if (!t) return fail(res, '单据不存在', 404);
  const { approve, reason } = req.body || {};
  if (t.status !== 'pending') return fail(res, '该单据当前状态不可审批');
  if (!approve) {
    db.prepare("UPDATE transfers SET status='rejected', approved_by=?, approved_at=?, note=? WHERE id=?")
      .run(req.user.id, now(), reason || '未通过审批', t.id);
    audit(req.user.id, req.user.username, 'transfer.reject', t.no, { reason });
    return ok(res, { status: 'rejected' });
  }
  const items = JSON.parse(t.items);
  const prods = db.prepare('SELECT * FROM products').all();
  tx(() => {
    for (const n of items) {
      const inv = getInv(t.from_loc, n.product_id);
      if (inv.qty < n.qty) {
        const p = prods.find((x) => x.id === n.product_id);
        throw new Error(`总仓「${p.name}」库存不足：现有 ${inv.qty} 件，需 ${n.qty} 件`);
      }
    }
    db.prepare("UPDATE transfers SET status='transit', approved_by=?, approved_at=? WHERE id=?").run(req.user.id, now(), t.id);
    for (const n of items) {
      addStock(t.from_loc, n.product_id, -n.qty, 'transfer_out', t.no, '调拨出库', req.user.id);
      getInv(t.to_loc, n.product_id);
      db.prepare('UPDATE inventory SET transit = transit + ? WHERE location_id=? AND product_id=?').run(n.qty, t.to_loc, n.product_id);
    }
  });
  audit(req.user.id, req.user.username, 'transfer.approve', t.no, {});
  ok(res, { status: 'transit' });
}));
app.post('/api/transfers/:id/receive', auth, wrap((req, res) => {
  const t = db.prepare('SELECT * FROM transfers WHERE id=?').get(Number(req.params.id));
  if (!t) return fail(res, '单据不存在', 404);
  if (t.status !== 'transit') return fail(res, '仅「在途」单据可确认收货');
  if (req.user.role === 'prm' && req.user.store_id !== t.to_loc) return fail(res, '只能确认本店收货', 403);
  const items = JSON.parse(t.items);
  const recv = req.body && Array.isArray(req.body.items) ? req.body.items : null;
  tx(() => {
    for (const n of items) {
      let received = n.qty;
      if (recv) {
        const r = recv.find((x) => Number(x.product_id) === n.product_id);
        if (r) received = Math.max(0, Math.min(n.qty, Math.floor(Number(r.received_qty))));
      }
      n.received_qty = received;
      const diff = n.qty - received;
      getInv(t.to_loc, n.product_id);
      db.prepare('UPDATE inventory SET transit = transit - ?, qty = qty + ? WHERE location_id=? AND product_id=?')
        .run(n.qty, received, t.to_loc, n.product_id);
      addStock(t.to_loc, n.product_id, received, 'transfer_in', t.no, '调拨入库', req.user.id);
      if (diff > 0) addStock(t.to_loc, n.product_id, 0, 'loss', t.no, `调拨短少 ${diff} 件`, req.user.id);
    }
    db.prepare("UPDATE transfers SET status='received', received_at=? WHERE id=?").run(now(), t.id);
    db.prepare('UPDATE transfers SET items=? WHERE id=?').run(JSON.stringify(items), t.id);
  });
  audit(req.user.id, req.user.username, 'transfer.receive', t.no, { items });
  ok(res, {});
}));

/* ================= 订单 ================= */
function orderScope(req) {
  if (req.user.role === 'sal') return 'salesman_id=' + Number(req.user.id);
  if (req.user.role === 'prm') return `type='retail' AND store_id=${Number(req.user.store_id)}`;
  return '1=1';
}
app.get('/api/orders', auth, wrap((req, res) => {
  const { status, type, days } = req.query;
  const n = Math.min(Number(days) || 60, 180);
  let sql = `SELECT o.*, l.name AS store_name, u.name AS salesman_name
    FROM orders o JOIN locations l ON l.id=o.store_id JOIN users u ON u.id=o.salesman_id
    WHERE ${orderScope(req)} AND o.created_at >= ?`;
  const args = [`${dayStr(n - 1)} 00:00:00`];
  if (status) { sql += ' AND o.status=?'; args.push(status); }
  if (type) { sql += ' AND o.type=?'; args.push(type); }
  sql += ' ORDER BY o.id DESC LIMIT 300';
  const rows = db.prepare(sql).all(...args);
  ok(res, rows);
}));
app.get('/api/orders/:id', auth, wrap((req, res) => {
  const o = db.prepare(`SELECT o.*, l.name AS store_name, l.address AS store_address, u.name AS salesman_name
    FROM orders o JOIN locations l ON l.id=o.store_id JOIN users u ON u.id=o.salesman_id WHERE o.id=?`).get(Number(req.params.id));
  if (!o) return fail(res, '订单不存在', 404);
  if (req.user.role === 'sal' && o.salesman_id !== req.user.id) return fail(res, '无权查看该订单', 403);
  if (req.user.role === 'prm' && (o.type !== 'retail' || o.store_id !== req.user.store_id)) return fail(res, '无权查看该订单', 403);
  const items = db.prepare(`SELECT oi.*, p.name AS product_name, p.sku, p.units_per_carton FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? ORDER BY oi.id`).all(o.id);
  const pays = db.prepare(`SELECT p.*, u.name AS recorder_name, c.name AS confirmer_name FROM payments p LEFT JOIN users u ON u.id=p.recorded_by LEFT JOIN users c ON c.id=p.confirmed_by WHERE p.order_id=? ORDER BY p.id`).all(o.id);
  ok(res, {
    ...o,
    items: items.map((i) => ({ ...i, ...splitUnits(i.qty, i.units_per_carton), shipped_split: splitUnits(i.shipped_qty, i.units_per_carton) })),
    payments: pays,
  });
}));
/* 创建订单（批发=业务员；零售=促销员 POS 即时结） */
app.post('/api/orders', auth, wrap((req, res) => {
  const { type, store_id, items, note, payment_mode, payment_method, submit, save_draft } = req.body || {};
  const orderType = type === 'retail' ? 'retail' : 'wholesale';
  if (orderType === 'wholesale' && req.user.role !== 'sal') return fail(res, '仅业务员可创建批发订单', 403);
  if (orderType === 'retail' && req.user.role !== 'prm') return fail(res, '仅促销员可进行零售开单', 403);
  let store;
  if (orderType === 'retail') {
    store = db.prepare('SELECT * FROM locations WHERE id=?').get(Number(req.user.store_id));
  } else {
    store = db.prepare('SELECT * FROM locations WHERE id=?').get(Number(store_id));
  }
  if (!store) return fail(res, '门店不存在');
  if (store.status !== 'active') return fail(res, '该门店已停用，无法开单');
  const prods = db.prepare("SELECT * FROM products WHERE status='active'").all();
  let built;
  try {
    built = buildOrderLines(orderType, prods, items || []);
  } catch (e) { return fail(res, e.message); }

  const createOrder = (status) => {
    const prefix = orderType === 'wholesale' ? 'PF' : 'LS';
    const no = nextNo(prefix, 'orders');
    const payable = built.itemsAmount;
    const r = db.prepare(`INSERT INTO orders (no,type,store_id,salesman_id,status,items_amount,discount,payable,paid,gift_value,payment_mode,payment_method,note,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(no, orderType, store.id, req.user.id, status, payable, 0, payable, 0, built.giftValue,
        orderType === 'retail' ? 'cash' : (payment_mode === 'cash' ? 'cash' : 'credit'),
        orderType === 'retail' ? (payment_method || '现金') : '', note || '', now());
    const oid = Number(r.lastInsertRowid);
    const insItem = db.prepare('INSERT INTO order_items (order_id,product_id,kind,qty,shipped_qty,unit_price,amount) VALUES (?,?,?,?,?,?,?)');
    for (const l of built.lines) insItem.run(oid, l.product_id, l.kind, l.qty, 0, l.unit_price, l.amount);
    return { oid, no };
  };

  if (orderType === 'retail') {
    /* 零售：单步完成，实时扣本店库存（含赠品） */
    for (const l of built.lines) {
      const inv = getInv(store.id, l.product_id);
      if (inv.qty < l.qty) {
        const p = prods.find((x) => x.id === l.product_id);
        return fail(res, `门店「${p.name}」库存不足：现有 ${inv.qty} 件，本单需 ${l.qty} 件${l.kind === 'gift' ? '（含促销赠送）' : ''}`);
      }
    }
    const r = tx(() => {
      const { oid, no } = createOrder('done');
      for (const l of built.lines) {
        db.prepare('UPDATE order_items SET shipped_qty=? WHERE order_id=? AND product_id=? AND kind=?').run(l.qty, oid, l.product_id, l.kind);
        addStock(store.id, l.product_id, -l.qty, l.kind === 'gift' ? 'gift_out' : 'sale_out', no, '零售出库', req.user.id);
      }
      db.prepare('UPDATE orders SET shipped_at=?, done_at=? WHERE id=?').run(now(), now(), oid);
      return { oid, no };
    });
    audit(req.user.id, req.user.username, 'order.retail', r.no, { payable: built.itemsAmount, gift: built.giftValue });
    return ok(res, { id: r.oid, no: r.no, payable: built.itemsAmount, gift_value: built.giftValue, promo: built.promoName });
  }

  /* 批发：草稿或提交 */
  const status = save_draft ? 'draft' : 'pending';
  const { oid, no } = createOrder(status);
  audit(req.user.id, req.user.username, 'order.create', no, { store: store.name, payable: built.itemsAmount });
  ok(res, { id: oid, no, status, payable: built.itemsAmount, gift_value: built.giftValue, promo: built.promoName });
}));
app.post('/api/orders/:id/submit', auth, wrap((req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));
  if (!o) return fail(res, '订单不存在', 404);
  if (o.salesman_id !== req.user.id && req.user.role === 'sal') return fail(res, '只能提交本人订单', 403);
  if (o.status !== 'draft') return fail(res, '仅草稿订单可提交');
  db.prepare("UPDATE orders SET status='pending' WHERE id=?").run(o.id);
  audit(req.user.id, req.user.username, 'order.submit', o.no, {});
  ok(res, { status: 'pending' });
}));
app.post('/api/orders/:id/approve', auth, roles('gm', 'mgr'), wrap((req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));
  if (!o) return fail(res, '订单不存在', 404);
  if (o.status !== 'pending') return fail(res, '仅「待审批」订单可审批');
  const discount = Math.max(0, Math.round(Number((req.body || {}).discount || 0) * 100));
  if (discount > o.items_amount) return fail(res, '优惠金额不能超过应收金额');
  if (req.user.role === 'mgr' && discount > o.items_amount * 0.1) return fail(res, '业务经理优惠额度上限为应收的 10%，请由总经理审批');
  const payable = o.items_amount - discount;
  db.prepare("UPDATE orders SET status='approved', discount=?, payable=?, approved_by=?, approved_at=? WHERE id=?")
    .run(discount, payable, req.user.id, now(), o.id);
  audit(req.user.id, req.user.username, 'order.approve', o.no, { discount });
  ok(res, { status: 'approved', payable });
}));
app.post('/api/orders/:id/reject', auth, roles('gm', 'mgr'), wrap((req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));
  if (!o) return fail(res, '订单不存在', 404);
  if (o.status !== 'pending') return fail(res, '仅「待审批」订单可驳回');
  const reason = (req.body || {}).reason || '';
  if (!reason.trim()) return fail(res, '驳回必须填写原因');
  db.prepare("UPDATE orders SET status='rejected', reject_reason=?, approved_by=?, approved_at=? WHERE id=?")
    .run(reason.trim(), req.user.id, now(), o.id);
  audit(req.user.id, req.user.username, 'order.reject', o.no, { reason });
  ok(res, { status: 'rejected' });
}));
app.post('/api/orders/:id/cancel', auth, wrap((req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));
  if (!o) return fail(res, '订单不存在', 404);
  if (!['draft', 'pending'].includes(o.status)) return fail(res, '仅草稿或待审批订单可取消');
  if (req.user.role === 'sal' && o.salesman_id !== req.user.id) return fail(res, '只能取消本人订单', 403);
  db.prepare("UPDATE orders SET status='cancelled', reject_reason=? WHERE id=?").run((req.body || {}).reason || '创建人取消', o.id);
  audit(req.user.id, req.user.username, 'order.cancel', o.no, {});
  ok(res, { status: 'cancelled' });
}));
/* 出库（总仓扣减，支持整单或分批） */
app.post('/api/orders/:id/ship', auth, roles('gm', 'mgr'), wrap((req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));
  if (!o) return fail(res, '订单不存在', 404);
  if (!['approved', 'partial'].includes(o.status)) return fail(res, '仅已审批订单可出库');
  const main = db.prepare("SELECT id FROM locations WHERE type='main'").get();
  const items = db.prepare(`SELECT oi.*, p.name AS product_name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?`).all(o.id);
  const reqLines = (req.body && Array.isArray(req.body.lines)) ? req.body.lines : null;
  const plan = [];
  for (const it of items) {
    const remain = it.qty - it.shipped_qty;
    if (remain <= 0) continue;
    let shipQty = remain;
    if (reqLines) {
      const r = reqLines.find((x) => Number(x.item_id) === it.id || Number(x.product_id) === it.product_id && x.kind === it.kind);
      shipQty = r ? Math.max(0, Math.min(remain, Math.floor(Number(r.qty)))) : 0;
    }
    if (shipQty > 0) plan.push({ item: it, shipQty });
  }
  if (plan.length === 0) return fail(res, '没有可出库的数量');
  const r = tx(() => {
    for (const p of plan) {
      const inv = getInv(main.id, p.item.product_id);
      if (inv.qty < p.shipQty) {
        throw new Error(`总仓「${p.item.product_name}」库存不足：现有 ${inv.qty} 件，本次需出库 ${p.shipQty} 件`);
      }
    }
    for (const p of plan) {
      db.prepare('UPDATE order_items SET shipped_qty = shipped_qty + ? WHERE id=?').run(p.shipQty, p.item.id);
      addStock(main.id, p.item.product_id, -p.shipQty, p.item.kind === 'gift' ? 'gift_out' : 'sale_out', o.no, o.type === 'wholesale' ? '批发出库' : '零售出库', req.user.id);
    }
    const totalQty = items.reduce((s, i) => s + i.qty, 0);
    const shipped = db.prepare('SELECT SUM(shipped_qty) s FROM order_items WHERE order_id=?').get(o.id).s || 0;
    const fully = shipped >= totalQty;
    const newStatus = fully ? (o.paid >= o.payable ? 'done' : 'shipped') : 'partial';
    db.prepare('UPDATE orders SET status=?, shipped_at=? WHERE id=?').run(newStatus, now(), o.id);
    return { status: newStatus, shipped, total: totalQty };
  });
  audit(req.user.id, req.user.username, 'order.ship', o.no, r);
  ok(res, r);
}));

/* ================= 回款 ================= */
app.get('/api/payments', auth, wrap((req, res) => {
  let sql = `SELECT p.*, o.no AS order_no, o.type AS order_type, o.payable, o.paid AS order_paid, l.name AS store_name,
    u.name AS recorder_name, c.name AS confirmer_name
    FROM payments p JOIN orders o ON o.id=p.order_id JOIN locations l ON l.id=o.store_id
    LEFT JOIN users u ON u.id=p.recorded_by LEFT JOIN users c ON c.id=p.confirmed_by`;
  const conds = [], args = [];
  if (req.user.role === 'sal') { conds.push('o.salesman_id=?'); args.push(req.user.id); }
  if (req.user.role === 'prm') { conds.push('o.store_id=?'); args.push(req.user.store_id); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY p.id DESC LIMIT 200';
  ok(res, db.prepare(sql).all(...args));
}));
app.post('/api/orders/:id/pay', auth, wrap((req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));
  if (!o) return fail(res, '订单不存在', 404);
  if (o.type !== 'wholesale') return fail(res, '零售订单为现结，无需登记回款');
  if (!['approved', 'partial', 'shipped'].includes(o.status)) return fail(res, '订单当前状态不可回款（需审批通过后）');
  if (req.user.role === 'sal' && o.salesman_id !== req.user.id) return fail(res, '只能登记本人订单的回款', 403);
  const unpaid = o.payable - o.paid;
  if (unpaid <= 0) return fail(res, '该订单已结清');
  const amount = Math.round(Number((req.body || {}).amount) * 100);
  if (!amount || amount <= 0) return fail(res, '回款金额必须大于 0');
  if (amount > unpaid) return fail(res, `回款金额超过未收金额 ¥${(unpaid / 100).toFixed(2)}`);
  const method = (req.body || {}).method || '现金';
  db.prepare('INSERT INTO payments (order_id,amount,method,note,recorded_by,created_at) VALUES (?,?,?,?,?,?)')
    .run(o.id, amount, method, (req.body || {}).note || '', req.user.id, now());
  audit(req.user.id, req.user.username, 'payment.record', o.no, { amount, method });
  ok(res, {});
}));
app.post('/api/payments/:id/confirm', auth, roles('gm', 'mgr'), wrap((req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(Number(req.params.id));
  if (!p) return fail(res, '回款记录不存在', 404);
  if (p.status !== 'pending') return fail(res, '该回款已确认');
  const r = tx(() => {
    db.prepare("UPDATE payments SET status='confirmed', confirmed_by=?, confirmed_at=? WHERE id=?").run(req.user.id, now(), p.id);
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(p.order_id);
    const paid = o.paid + p.amount;
    let status = o.status;
    if (paid >= o.payable && ['shipped', 'partial'].includes(o.status)) status = 'done';
    db.prepare('UPDATE orders SET paid=?, status=? WHERE id=?').run(paid, status, o.id);
    return { order_status: status };
  });
  audit(req.user.id, req.user.username, 'payment.confirm', (db.prepare('SELECT no FROM orders WHERE id=?').get(p.order_id) || {}).no || '', { amount: p.amount });
  ok(res, r);
}));
/* 应收台账 */
app.get('/api/receivables', auth, roles('gm', 'mgr'), wrap((req, res) => {
  const rows = db.prepare(`
    SELECT o.id, o.no, o.store_id, l.name AS store_name, u.name AS salesman_name, o.status,
      o.payable, o.paid, (o.payable - o.paid) AS unpaid, o.shipped_at, o.created_at,
      CAST((julianday('now','localtime') - julianday(COALESCE(NULLIF(o.shipped_at,''), o.created_at))) AS INT) AS age_days
    FROM orders o JOIN locations l ON l.id=o.store_id JOIN users u ON u.id=o.salesman_id
    WHERE o.type='wholesale' AND o.payable > o.paid AND o.status IN ('approved','partial','shipped')
    ORDER BY unpaid DESC`).all();
  ok(res, rows);
}));

/* ================= 促销活动 ================= */
app.get('/api/promotions', auth, wrap((req, res) => {
  ok(res, db.prepare('SELECT * FROM promotions ORDER BY id DESC').all());
}));
app.post('/api/promotions', auth, roles('gm', 'mgr'), wrap((req, res) => {
  const { name, channels, start_date, end_date, type } = req.body || {};
  if (!name) return fail(res, '活动名称必填');
  const ch = Array.isArray(channels) && channels.length ? channels.join(',') : 'wholesale,retail';
  db.prepare('INSERT INTO promotions (name,type,channels,start_date,end_date,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(String(name).trim(), type || 'buy2_half', ch, start_date || dayStr(0), end_date || '2027-12-31', 'active', req.user.id, now());
  audit(req.user.id, req.user.username, 'promotion.create', name, { channels: ch });
  ok(res, {});
}));
app.put('/api/promotions/:id', auth, roles('gm', 'mgr'), wrap((req, res) => {
  const p = db.prepare('SELECT * FROM promotions WHERE id=?').get(Number(req.params.id));
  if (!p) return fail(res, '活动不存在', 404);
  const { status, end_date, channels } = req.body || {};
  db.prepare('UPDATE promotions SET status=?, end_date=?, channels=? WHERE id=?')
    .run(status || p.status, end_date || p.end_date, channels || p.channels, p.id);
  audit(req.user.id, req.user.username, 'promotion.update', p.name, { status });
  ok(res, {});
}));

/* ================= 工作台 ================= */
app.get('/api/dashboard', auth, wrap((req, res) => {
  const role = req.user.role;
  const today = dayStr(0);
  const monthStart = today.slice(0, 8) + '01';
  const pay = (cond) => `SELECT COALESCE(SUM(payable),0) s, COUNT(*) c FROM orders WHERE ${cond}`;
  const scope = role === 'sal' ? `salesman_id=${req.user.id}` : (role === 'prm' ? `store_id=${req.user.store_id}` : '1=1');
  const sToday = db.prepare(pay(`${scope} AND status IN ('done','shipped','partial') AND date(created_at)=date(?)`)).get(today).s;
  const cToday = db.prepare(pay(`${scope} AND status IN ('done','shipped','partial') AND date(created_at)=date(?)`)).get(today).c;
  const sMonth = db.prepare(pay(`${scope} AND status IN ('done','shipped','partial') AND date(created_at)>=?`)).get(monthStart).s;
  const cMonth = db.prepare(pay(`${scope} AND status IN ('done','shipped','partial') AND date(created_at)>=?`)).get(monthStart).c;
  const giftMonth = db.prepare(`SELECT COALESCE(SUM(gift_value),0) s FROM orders WHERE ${scope} AND date(created_at)>=?`).get(monthStart).s;
  const receivable = db.prepare(`SELECT COALESCE(SUM(payable-paid),0) s FROM orders WHERE type='wholesale' AND status IN ('approved','partial','shipped')`).get().s;
  const mainStock = db.prepare(`SELECT COALESCE(SUM(i.qty),0) s FROM inventory i JOIN locations l ON l.id=i.location_id WHERE l.type='main'`).get().s;

  const trend = db.prepare(`
    SELECT date(created_at) d,
      SUM(CASE WHEN type='wholesale' THEN payable ELSE 0 END) w,
      SUM(CASE WHEN type='retail' THEN payable ELSE 0 END) r
    FROM orders WHERE status IN ('done','shipped','partial') AND date(created_at) >= date(?, '-13 days')
    ${role === 'sal' ? 'AND salesman_id=' + req.user.id : ''} ${role === 'prm' ? 'AND store_id=' + req.user.store_id : ''}
    GROUP BY date(created_at) ORDER BY d`).all(today);
  const trendMap = Object.fromEntries(trend.map((t) => [t.d, t]));
  const trend14 = Array.from({ length: 14 }, (_, i) => {
    const d = dayStr(13 - i);
    return { date: d, wholesale: trendMap[d] ? trendMap[d].w : 0, retail: trendMap[d] ? trendMap[d].r : 0 };
  });

  const topStores = db.prepare(`
    SELECT l.name AS store_name, SUM(o.payable) amount, COUNT(*) c
    FROM orders o JOIN locations l ON l.id=o.store_id
    WHERE o.status IN ('done','shipped','partial') AND date(o.created_at)>=?
    GROUP BY o.store_id ORDER BY amount DESC LIMIT 5`).all(monthStart);

  const out = {
    role, today: { sales: sToday, orders: cToday },
    month: { sales: sMonth, orders: cMonth, gift_value: giftMonth },
    receivable, main_stock: mainStock, trend14, top_stores: topStores,
  };
  if (role === 'gm' || role === 'mgr') {
    out.pending = {
      orders: db.prepare("SELECT COUNT(*) c FROM orders WHERE status='pending'").get().c,
      transfers: db.prepare("SELECT COUNT(*) c FROM transfers WHERE status='pending'").get().c,
      payments: db.prepare("SELECT COUNT(*) c FROM payments WHERE status='pending'").get().c,
    };
    out.pending_list = {
      orders: db.prepare(`SELECT o.id,o.no,o.type,o.payable,o.created_at,l.name AS store_name,u.name AS salesman_name
        FROM orders o JOIN locations l ON l.id=o.store_id JOIN users u ON u.id=o.salesman_id
        WHERE o.status='pending' ORDER BY o.id LIMIT 20`).all(),
      transfers: db.prepare(`SELECT t.id,t.no,t.created_at,lt.name AS to_name,ur.name AS requester_name,t.note
        FROM transfers t JOIN locations lt ON lt.id=t.to_loc LEFT JOIN users ur ON ur.id=t.requested_by
        WHERE t.status='pending' ORDER BY t.id LIMIT 20`).all(),
      payments: db.prepare(`SELECT p.id,p.amount,p.method,p.created_at,o.no AS order_no,l.name AS store_name,u.name AS recorder_name
        FROM payments p JOIN orders o ON o.id=p.order_id JOIN locations l ON l.id=o.store_id LEFT JOIN users u ON u.id=p.recorded_by
        WHERE p.status='pending' ORDER BY p.id LIMIT 20`).all(),
    };
  }
  if (role === 'sal') {
    out.my_orders = db.prepare(`SELECT status, COUNT(*) c FROM orders WHERE salesman_id=? GROUP BY status`).all(req.user.id);
  }
  if (role === 'prm') {
    const storeId = req.user.store_id;
    out.store_stock = db.prepare(`SELECT p.name, i.qty, p.units_per_carton FROM inventory i JOIN products p ON p.id=i.product_id WHERE i.location_id=?`).all(storeId)
      .map((r) => ({ ...r, ...splitUnits(r.qty, r.units_per_carton) }));
    out.gift_today = db.prepare(`SELECT COALESCE(SUM(gift_value),0) s FROM orders WHERE store_id=? AND type='retail' AND date(created_at)=date(?)`).get(storeId, today).s;
  }
  ok(res, out);
}));

/* ================= 待办 ================= */
app.get('/api/todos', auth, wrap((req, res) => {
  const role = req.user.role;
  if (role === 'gm' || role === 'mgr') {
    ok(res, {
      orders: db.prepare(`SELECT o.id,o.no,o.type,o.payable,o.created_at,l.name AS store_name,u.name AS salesman_name
        FROM orders o JOIN locations l ON l.id=o.store_id JOIN users u ON u.id=o.salesman_id WHERE o.status='pending' ORDER BY o.id`).all(),
      transfers: db.prepare(`SELECT t.id,t.no,t.created_at,t.note,lt.name AS to_name,ur.name AS requester_name
        FROM transfers t JOIN locations lt ON lt.id=t.to_loc LEFT JOIN users ur ON ur.id=t.requested_by WHERE t.status='pending' ORDER BY t.id`).all(),
      payments: db.prepare(`SELECT p.id,p.amount,p.method,p.created_at,o.no AS order_no,l.name AS store_name,u.name AS recorder_name
        FROM payments p JOIN orders o ON o.id=p.order_id JOIN locations l ON l.id=o.store_id LEFT JOIN users u ON u.id=p.recorded_by WHERE p.status='pending' ORDER BY p.id`).all(),
    });
  } else if (role === 'sal') {
    ok(res, {
      rejected: db.prepare(`SELECT o.id,o.no,o.reject_reason,o.created_at,l.name AS store_name FROM orders o JOIN locations l ON l.id=o.store_id
        WHERE o.salesman_id=? AND o.status='rejected' ORDER BY o.id DESC LIMIT 10`).all(req.user.id),
      payments_pending: db.prepare(`SELECT p.id,p.amount,p.method,o.no AS order_no FROM payments p JOIN orders o ON o.id=p.order_id
        WHERE o.salesman_id=? AND p.status='pending' ORDER BY p.id DESC LIMIT 10`).all(req.user.id),
    });
  } else {
    ok(res, {
      transfers: db.prepare(`SELECT t.id,t.no,t.status,t.created_at,ua.name AS approver_name,t.note
        FROM transfers t LEFT JOIN users ua ON ua.id=t.approved_by WHERE t.to_loc=? ORDER BY t.id DESC LIMIT 10`).all(req.user.store_id),
    });
  }
}));

/* ================= 报表 ================= */
app.get('/api/reports/sales', auth, wrap((req, res) => {
  const n = Math.min(Number(req.query.days) || 14, 90);
  const scope = req.user.role === 'sal' ? `AND salesman_id=${req.user.id}` : (req.user.role === 'prm' ? `AND store_id=${req.user.store_id}` : '');
  const daily = db.prepare(`
    SELECT date(created_at) d,
      SUM(CASE WHEN type='wholesale' THEN payable ELSE 0 END) wholesale,
      SUM(CASE WHEN type='retail' THEN payable ELSE 0 END) retail,
      SUM(gift_value) gift
    FROM orders WHERE status IN ('done','shipped','partial') AND date(created_at) >= date(?, '-${n - 1} days') ${scope}
    GROUP BY date(created_at) ORDER BY d`).all(dayStr(0));
  const byCategory = db.prepare(`
    SELECT p.category, SUM(oi.qty) units, SUM(oi.amount) amount
    FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id
    WHERE o.status IN ('done','shipped','partial') AND oi.kind='normal' AND date(o.created_at)>=?
    GROUP BY p.category`).all(dayStr(0).slice(0, 8) + '01');
  ok(res, { daily, by_category: byCategory });
}));
app.get('/api/reports/by-store', auth, wrap((req, res) => {
  const monthStart = dayStr(0).slice(0, 8) + '01';
  ok(res, db.prepare(`
    SELECT l.name AS store_name, SUM(o.payable) amount, COUNT(*) orders, SUM(o.gift_value) gift
    FROM orders o JOIN locations l ON l.id=o.store_id
    WHERE o.status IN ('done','shipped','partial') AND date(o.created_at)>=?
    GROUP BY o.store_id ORDER BY amount DESC`).all(monthStart));
}));
app.get('/api/reports/by-salesman', auth, roles('gm', 'mgr'), wrap((req, res) => {
  const monthStart = dayStr(0).slice(0, 8) + '01';
  const rows = db.prepare(`
    SELECT u.name AS salesman_name,
      SUM(CASE WHEN o.status IN ('done','shipped','partial') THEN o.payable ELSE 0 END) sales,
      COUNT(CASE WHEN o.status IN ('done','shipped','partial') THEN 1 END) orders,
      COALESCE(SUM(CASE WHEN o.payable>0 THEN o.paid ELSE 0 END),0) paid,
      SUM(o.gift_value) gift
    FROM users u LEFT JOIN orders o ON o.salesman_id=u.id AND o.type='wholesale' AND date(o.created_at)>=?
    WHERE u.role='sal' GROUP BY u.id ORDER BY sales DESC`).all(monthStart);
  ok(res, rows);
}));
app.get('/api/reports/promo', auth, roles('gm', 'mgr'), wrap((req, res) => {
  const monthStart = dayStr(0).slice(0, 8) + '01';
  const rows = db.prepare(`
    SELECT p.name AS product_name, SUM(oi.qty) gift_units, SUM(oi.qty / p.units_per_carton) gift_cartons
    FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id
    WHERE oi.kind='gift' AND date(o.created_at)>=? GROUP BY p.id`).all(monthStart);
  const giftValue = db.prepare(`SELECT COALESCE(SUM(gift_value),0) s FROM orders WHERE date(created_at)>=?`).get(monthStart).s;
  ok(res, { rows, gift_value: giftValue });
}));
app.get('/api/reports/inventory', auth, wrap((req, res) => {
  let sql = `SELECT l.name AS location_name, l.type, p.name AS product_name, p.category, i.qty, i.transit, p.units_per_carton
    FROM inventory i JOIN locations l ON l.id=i.location_id JOIN products p ON p.id=i.product_id`;
  const conds = [];
  if (req.user.role === 'prm') conds.push(`i.location_id=${Number(req.user.store_id)}`);
  if (req.user.role === 'sal') conds.push(`l.type='main' OR l.type='store'`);
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY l.type DESC, l.code, p.id';
  ok(res, db.prepare(sql).all().map((r) => ({ ...r, ...splitUnits(r.qty, r.units_per_carton) })));
}));
app.get('/api/audit', auth, roles('gm'), wrap((req, res) => {
  ok(res, db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 300').all());
}));

/* ================= 静态资源 & SPA ================= */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { setHeaders: (res, p) => { if (p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`[hemu-erp] 服务已启动: http://localhost:${PORT}`);
  console.log(`[hemu-erp] 数据库: ${DB_PATH}`);
});
