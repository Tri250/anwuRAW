/**
 * 合沐纯牛奶进销存管理系统 · 数据层
 * SQLite(node:sqlite) + Schema + 种子数据（含 14 天历史演示数据）
 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.HEMU_DB || path.join(DATA_DIR, 'hemu.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/* ---------------- 工具 ---------------- */
function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pwd, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pwd, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(pwd, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}
const now = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const dayStr = (offset = 0) => {
  const d = new Date(Date.now() - offset * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* ---------------- Schema ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('gm','mgr','sal','prm')),
  password_hash TEXT NOT NULL,
  store_id INTEGER,
  phone TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('main','store')),
  region TEXT NOT NULL DEFAULT '江西省赣州市',
  address TEXT DEFAULT '',
  contact TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('bag','box')),
  spec TEXT NOT NULL DEFAULT '200ml',
  units_per_carton INTEGER NOT NULL DEFAULT 16,
  wholesale_price INTEGER NOT NULL,
  retail_price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  transit INTEGER NOT NULL DEFAULT 0,
  UNIQUE(location_id, product_id)
);
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  type TEXT NOT NULL,
  ref_no TEXT DEFAULT '',
  note TEXT DEFAULT '',
  user_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  no TEXT UNIQUE NOT NULL,
  supplier TEXT DEFAULT '',
  note TEXT DEFAULT '',
  items TEXT NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  no TEXT UNIQUE NOT NULL,
  from_loc INTEGER NOT NULL,
  to_loc INTEGER NOT NULL,
  items TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','transit','received','rejected','cancelled')),
  note TEXT DEFAULT '',
  requested_by INTEGER, approved_by INTEGER, approved_at TEXT,
  received_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  no TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('wholesale','retail')),
  store_id INTEGER NOT NULL,
  salesman_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','approved','partial','shipped','done','rejected','cancelled')),
  items_amount INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  payable INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  gift_value INTEGER NOT NULL DEFAULT 0,
  payment_mode TEXT DEFAULT 'credit',
  payment_method TEXT DEFAULT '',
  reject_reason TEXT DEFAULT '',
  note TEXT DEFAULT '',
  approved_by INTEGER, approved_at TEXT,
  shipped_at TEXT, done_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'normal' CHECK(kind IN ('normal','gift')),
  qty INTEGER NOT NULL,
  shipped_qty INTEGER NOT NULL DEFAULT 0,
  unit_price INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed')),
  recorded_by INTEGER, confirmed_by INTEGER, confirmed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'buy2_half',
  channels TEXT NOT NULL DEFAULT 'wholesale,retail',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, username TEXT,
  action TEXT NOT NULL, target TEXT DEFAULT '', detail TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moves_loc ON stock_moves(location_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
`);

/* ---------------- 单号 ---------------- */
function nextNo(prefix, table) {
  const today = dayStr(0).replace(/-/g, '');
  const like = `${prefix}-${today}-%`;
  const row = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE no LIKE ?`).get(like);
  return `${prefix}-${today}-${String((row ? row.c : 0) + 1).padStart(3, '0')}`;
}

/* ---------------- 库存操作（业务核心） ---------------- */
function getInv(locationId, productId) {
  let row = db.prepare('SELECT * FROM inventory WHERE location_id=? AND product_id=?').get(locationId, productId);
  if (!row) {
    db.prepare('INSERT INTO inventory (location_id, product_id, qty, transit) VALUES (?,?,0,0)').run(locationId, productId);
    row = db.prepare('SELECT * FROM inventory WHERE location_id=? AND product_id=?').get(locationId, productId);
  }
  return row;
}
function addStock(locationId, productId, delta, type, refNo, note, userId, at) {
  getInv(locationId, productId);
  db.prepare('UPDATE inventory SET qty = qty + ? WHERE location_id=? AND product_id=?').run(delta, locationId, productId);
  db.prepare('INSERT INTO stock_moves (location_id, product_id, qty, type, ref_no, note, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(locationId, productId, delta, type, refNo || '', note || '', userId || null, at || now());
}
function audit(userId, username, action, target, detail) {
  db.prepare('INSERT INTO audit_logs (user_id, username, action, target, detail, created_at) VALUES (?,?,?,?,?,?)')
    .run(userId || null, username || '', action, target || '', typeof detail === 'string' ? detail : JSON.stringify(detail || {}), now());
}

/* ---------------- 促销引擎（唯一实现） ---------------- */
function activePromotion(orderType, dateStr) {
  const d = dateStr || dayStr(0);
  const rows = db.prepare(`SELECT * FROM promotions WHERE status='active' AND start_date<=? AND end_date>=? ORDER BY id ASC`).all(d, d);
  return rows.find((p) => p.channels.split(',').map((s) => s.trim()).includes(orderType)) || null;
}
/**
 * 输入正常行 [{product_id, cartons, loose}]，输出订单行（含赠品行）与汇总。
 * 价格口径：整箱按箱价，散件按散价（箱价/16 四舍五入到分）。
 */
function buildOrderLines(orderType, products, rawItems) {
  const promo = activePromotion(orderType);
  const upc = 16;
  const lines = [];
  let itemsAmount = 0, giftValue = 0;
  const gifts = []; // {product_id, qty}
  for (const it of rawItems) {
    const p = products.find((x) => x.id === Number(it.product_id));
    if (!p) throw new Error('商品不存在');
    const cartons = Math.max(0, Math.floor(Number(it.cartons) || 0));
    const loose = Math.max(0, Math.floor(Number(it.loose) || 0));
    if (cartons + loose <= 0) continue;
    const cartonPrice = orderType === 'wholesale' ? p.wholesale_price : p.retail_price;
    const loosePrice = Math.round(cartonPrice / p.units_per_carton);
    const amount = cartons * cartonPrice + loose * loosePrice;
    itemsAmount += amount;
    lines.push({ product_id: p.id, kind: 'normal', qty: cartons * upc + loose, cartons, loose, unit_price: loosePrice, carton_price: cartonPrice, amount });
    if (promo) {
      const giftUnits = Math.floor(cartons / 2) * (upc / 2); // 每满2箱赠0.5箱
      if (giftUnits > 0) {
        gifts.push({ product_id: p.id, qty: giftUnits });
        giftValue += giftUnits * loosePrice;
      }
    }
  }
  if (lines.length === 0) throw new Error('订单至少包含一个数量大于 0 的商品行');
  for (const g of gifts) {
    lines.push({ product_id: g.product_id, kind: 'gift', qty: g.qty, cartons: 0, loose: g.qty, unit_price: 0, carton_price: 0, amount: 0 });
  }
  return { lines, itemsAmount, giftValue, promoName: promo ? promo.name : '' };
}

/* ---------------- 种子数据 ---------------- */
function seed() {
  const has = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (has > 0) return;

  const insLoc = db.prepare('INSERT INTO locations (code,name,type,region,address,contact,phone,created_at) VALUES (?,?,?,?,?,?,?,?)');
  const insUser = db.prepare('INSERT INTO users (username,name,role,password_hash,store_id,phone,created_at) VALUES (?,?,?,?,?,?,?)');
  const insProd = db.prepare('INSERT INTO products (sku,name,category,spec,units_per_carton,wholesale_price,retail_price,created_at) VALUES (?,?,?,?,?,?,?,?)');
  const insPromo = db.prepare('INSERT INTO promotions (name,type,channels,start_date,end_date,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)');

  // 地点
  const mainId = Number(insLoc.run('HM-WH-001', '赣州总仓', 'main', '江西省赣州市', '赣州市章贡区沙河物流园 8 号库', '仓管办', '0797-8888001', now()).lastInsertRowid);
  const stores = [
    ['HM-S-001', '章贡区万达店', '赣州市章贡区万达广场 1 层', '刘店长', '13979700001'],
    ['HM-S-002', '赣州经开区门店', '赣州经济技术开发区金岭路 66 号', '肖店长', '13979700002'],
    ['HM-S-003', '南康区唐江店', '南康区唐江镇东风路 12 号', '钟店长', '13979700003'],
    ['HM-S-004', '赣县区城关店', '赣县区梅林镇双龙大道 45 号', '黄店长', '13979700004'],
    ['HM-S-005', '于都县长征店', '于都县贡江镇长征大道 201 号', '谢店长', '13979700005'],
  ].map((s, i) => Number(insLoc.run(s[0], s[1], 'store', '江西省赣州市', s[2], s[3], s[4], now()).lastInsertRowid));

  // 用户（初始密码 123456）
  const pwd = hashPassword('123456');
  const gmId = Number(insUser.run('gm', '王建军（总经理）', 'gm', pwd, null, '13800000001', now()).lastInsertRowid);
  const mgrId = Number(insUser.run('mgr', '李晓芸（业务经理）', 'mgr', pwd, null, '13800000002', now()).lastInsertRowid);
  const sal1 = Number(insUser.run('sales01', '张伟（业务员）', 'sal', pwd, null, '13800000003', now()).lastInsertRowid);
  const sal2 = Number(insUser.run('sales02', '陈强（业务员）', 'sal', pwd, null, '13800000004', now()).lastInsertRowid);
  const p1 = Number(insUser.run('promo01', '周敏（促销员）', 'prm', pwd, stores[0], '13800000005', now()).lastInsertRowid);
  const p2 = Number(insUser.run('promo02', '吴倩（促销员）', 'prm', pwd, stores[1], '13800000006', now()).lastInsertRowid);
  const p3 = Number(insUser.run('promo03', '郑芳（促销员）', 'prm', pwd, stores[4], '13800000007', now()).lastInsertRowid);

  // 商品
  const bagId = Number(insProd.run('HM-BAG-200', '合沐纯牛奶（袋装）', 'bag', '200ml/袋', 16, 5000, 5800, now()).lastInsertRowid);
  const boxId = Number(insProd.run('HM-BOX-200', '合沐纯牛奶（盒装）', 'box', '200ml/盒', 16, 5000, 5800, now()).lastInsertRowid);

  // 促销活动：买二送半箱
  insPromo.run('买二送半箱（袋装/盒装通用）', 'buy2_half', 'wholesale,retail', '2026-01-01', '2027-12-31', 'active', gmId, now());

  // 初始采购入库（总仓）
  const invInit = [
    [mainId, bagId, 26000], [mainId, boxId, 16000],
    [stores[0], bagId, 960], [stores[0], boxId, 640],
    [stores[1], bagId, 720], [stores[1], boxId, 480],
    [stores[2], bagId, 640], [stores[2], boxId, 400],
    [stores[3], bagId, 560], [stores[3], boxId, 320],
    [stores[4], bagId, 800], [stores[4], boxId, 480],
  ];
  const setInv = db.prepare('INSERT INTO inventory (location_id, product_id, qty, transit) VALUES (?,?,?,0)');
  for (const [loc, prod, qty] of invInit) setInv.run(loc, prod, qty);
  const cgNo = nextNo('CG', 'purchases');
  db.prepare('INSERT INTO purchases (no,supplier,note,items,user_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(cgNo, '新疆合沐乳业生产基地', '首批铺市到货', JSON.stringify([
      { product_id: bagId, cartons: 1625, loose: 0, amount: 812500 },
      { product_id: boxId, cartons: 1000, loose: 0, amount: 500000 },
    ]), gmId, now());
  for (const [loc, prod, qty] of invInit.filter((r) => r[0] === mainId)) {
    addStock(loc, prod, qty, 'purchase', cgNo, '首批铺市到货', gmId, now());
  }

  /* ---- 生成近 14 天历史订单 ---- */
  const products = [{ id: bagId }, { id: boxId }];
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const insOrder = db.prepare(`INSERT INTO orders (no,type,store_id,salesman_id,status,items_amount,discount,payable,paid,gift_value,payment_mode,payment_method,approved_by,approved_at,shipped_at,done_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insItem = db.prepare('INSERT INTO order_items (order_id,product_id,kind,qty,shipped_qty,unit_price,amount) VALUES (?,?,?,?,?,?,?)');

  const salesmen = [sal1, sal2];
  const promos = { [stores[0]]: p1, [stores[1]]: p2, [stores[4]]: p3 };
  let pfSeq = {}, lsSeq = {};

  for (let d = 13; d >= 1; d--) {
    const date = dayStr(d);
    const at = `${date} ${String(rnd(8, 18)).padStart(2, '0')}:${String(rnd(0, 59)).padStart(2, '0')}:00`;

    // 批发订单 1~2 笔/天
    const wCount = rnd(1, 2);
    for (let k = 0; k < wCount; k++) {
      const storeId = stores[rnd(0, stores.length - 1)];
      const salId = salesmen[rnd(0, 1)];
      const prodId = products[rnd(0, 1)].id;
      const isBag = prodId === bagId;
      const cartons = rnd(2, 10);
      const raw = [{ product_id: prodId, cartons, loose: 0 }];
      const built = buildOrderLines('wholesale', [{ id: bagId, id2: bagId, wholesale_price: 5000, retail_price: 5800, units_per_carton: 16 }, { id: boxId, wholesale_price: 5000, retail_price: 5800, units_per_carton: 16 }], raw);
      const payable = built.itemsAmount;
      pfSeq[date] = (pfSeq[date] || 0) + 1;
      const no = `PF-${date.replace(/-/g, '')}-${String(pfSeq[date]).padStart(3, '0')}`;
      const done = Math.random() < 0.85;
      const oid = Number(insOrder.run(no, 'wholesale', storeId, salId, done ? 'done' : 'shipped',
        payable, 0, payable, done ? payable : 0, built.giftValue, Math.random() < 0.5 ? 'cash' : 'credit',
        done ? ['现金', '微信', '银行转账'][rnd(0, 2)] : '', mgrId, at, at, done ? at : null, at).lastInsertRowid);
      for (const l of built.lines) insItem.run(oid, l.product_id, l.kind, l.qty, l.qty, l.unit_price, l.amount);
      addStock(mainId, prodId, -built.lines.reduce((s, l) => s + l.qty, 0), 'sale_out', no, '批发出库', mgrId, at);
    }

    // 零售订单 2~4 笔/天（仅有三家店有促销员）
    const rCount = rnd(2, 4);
    for (let k = 0; k < rCount; k++) {
      const storeIds = [stores[0], stores[1], stores[4]];
      const storeId = storeIds[rnd(0, 2)];
      const prodId = products[rnd(0, 1)].id;
      const cartons = rnd(1, 3);
      const loose = rnd(0, 5);
      const raw = [{ product_id: prodId, cartons, loose }];
      const built = buildOrderLines('retail', [{ id: bagId, wholesale_price: 5000, retail_price: 5800, units_per_carton: 16 }, { id: boxId, wholesale_price: 5000, retail_price: 5800, units_per_carton: 16 }], raw);
      const payable = built.itemsAmount;
      lsSeq[date] = (lsSeq[date] || 0) + 1;
      const no = `LS-${date.replace(/-/g, '')}-${String(lsSeq[date]).padStart(3, '0')}`;
      const oid = Number(insOrder.run(no, 'retail', storeId, promos[storeId], 'done',
        payable, 0, payable, payable, built.giftValue, 'cash', ['现金', '微信', '支付宝'][rnd(0, 2)],
        null, null, at, at, at).lastInsertRowid);
      for (const l of built.lines) insItem.run(oid, l.product_id, l.kind, l.qty, l.qty, l.unit_price, l.amount);
      addStock(storeId, prodId, -built.lines.reduce((s, l) => s + l.qty, 0), 'sale_out', no, '零售出库', promos[storeId], at);
    }
  }

  // 调拨示例：一条已完成 + 一条促销员领货申请待审批
  const insTr = db.prepare('INSERT INTO transfers (no,from_loc,to_loc,items,status,note,requested_by,approved_by,approved_at,received_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const tNo1 = nextNo('DB', 'transfers');
  const tr1 = Number(insTr.run(tNo1, mainId, stores[2], JSON.stringify([{ product_id: bagId, qty: 160, received_qty: 156 }, { product_id: boxId, qty: 80, received_qty: 80 }]), 'received', '常规补货', mgrId, mgrId, `${dayStr(2)} 09:30:00`, `${dayStr(2)} 15:10:00`, `${dayStr(2)} 09:00:00`).lastInsertRowid);
  addStock(mainId, bagId, -160, 'transfer_out', tNo1, '调拨出库', mgrId, `${dayStr(2)} 09:30:00`);
  addStock(mainId, boxId, -80, 'transfer_out', tNo1, '调拨出库', mgrId, `${dayStr(2)} 09:30:00`);
  addStock(stores[2], bagId, 156, 'transfer_in', tNo1, '调拨入库（短少4袋记损耗）', p1 || mgrId, `${dayStr(2)} 15:10:00`);
  addStock(stores[2], boxId, 80, 'transfer_in', tNo1, '调拨入库', mgrId, `${dayStr(2)} 15:10:00`);
  addStock(stores[2], bagId, 4, 'loss', tNo1, '调拨短少核销', mgrId, `${dayStr(2)} 15:10:00`);

  const tNo2 = nextNo('DB', 'transfers');
  insTr.run(tNo2, mainId, stores[4], JSON.stringify([{ product_id: boxId, qty: 96, received_qty: 0 }]), 'pending', '周末促销备货，请审批', p3, null, null, null, `${dayStr(0)} 08:20:00`);

  audit(gmId, 'gm', 'seed', 'system', '初始化种子数据（含 14 天演示订单）');
  console.log('[db] seed 完成：账号 gm/mgr/sales01/sales02/promo01-03 初始密码 123456');
}

seed();

module.exports = { db, hashPassword, verifyPassword, now, dayStr, nextNo, getInv, addStock, audit, buildOrderLines, activePromotion, DB_PATH };
