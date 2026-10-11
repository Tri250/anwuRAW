#!/bin/bash
# 合沐进销存 API 冒烟测试
B=http://localhost:8080/api
J() { python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d,ensure_ascii=False)[:300])"; }
TOK() { curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"$1\",\"password\":\"123456\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])"; }

GM=$(TOK gm); MGR=$(TOK mgr); SAL=$(TOK sales01); PRM=$(TOK promo01)
echo "== 1. GM dashboard"; curl -s $B/dashboard -H "Authorization: Bearer $GM" | J
echo "== 2. GM inventory(main)"; curl -s "$B/inventory?location_id=1" -H "Authorization: Bearer $GM" | J
echo "== 3. sales01 创建批发单: 袋装 2箱(应赠8袋) 应收100"
OID=$(curl -s -X POST $B/orders -H "Authorization: Bearer $SAL" -H 'Content-Type: application/json' -d '{"type":"wholesale","store_id":2,"items":[{"product_id":1,"cartons":2,"loose":0}],"submit":true}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")
echo "order id=$OID"; curl -s $B/orders/$OID -H "Authorization: Bearer $SAL" | J
echo "== 4. sales01 创建批发单: 1箱+4袋(不赠) 应收62.52"
curl -s -X POST $B/orders -H "Authorization: Bearer $SAL" -H 'Content-Type: application/json' -d '{"type":"wholesale","store_id":2,"items":[{"product_id":1,"cartons":1,"loose":4}]}' | J
echo "== 5. mgr 审批 + 出库"
curl -s -X POST $B/orders/$OID/approve -H "Authorization: Bearer $MGR" -H 'Content-Type: application/json' -d '{}' | J
curl -s -X POST $B/orders/$OID/ship -H "Authorization: Bearer $MGR" -H 'Content-Type: application/json' -d '{}' | J
echo "== 6. sales 登记回款100 + mgr 确认"
curl -s -X POST $B/orders/$OID/pay -H "Authorization: Bearer $SAL" -H 'Content-Type: application/json' -d '{"amount":100,"method":"现金"}' | J
PID=$(curl -s "$B/payments" -H "Authorization: Bearer $MGR" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'][0]['id'])")
curl -s -X POST $B/payments/$PID/confirm -H "Authorization: Bearer $MGR" | J
curl -s $B/orders/$OID -H "Authorization: Bearer $MGR" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print('order status:',d['status'],'paid:',d['paid'])"
echo "== 7. promo01 零售 2箱+3袋 应收126.89 赠8袋"
curl -s -X POST $B/orders -H "Authorization: Bearer $PRM" -H 'Content-Type: application/json' -d '{"type":"retail","items":[{"product_id":1,"cartons":2,"loose":3}],"payment_method":"微信"}' | J
echo "== 8. prm 领货申请 -> mgr 审批 -> 收货"
TID=$(curl -s -X POST $B/transfers -H "Authorization: Bearer $PRM" -H 'Content-Type: application/json' -d '{"to_loc":2,"items":[{"product_id":1,"cartons":5,"loose":0}],"note":"补货申请"}' | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(d.get('id') or 0)")
if [ "$TID" = "0" ]; then TID=$(curl -s $B/transfers -H "Authorization: Bearer $PRM" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'][0]['id'])"); fi
echo "transfer id=$TID"
curl -s -X POST $B/transfers/$TID/approve -H "Authorization: Bearer $MGR" -H 'Content-Type: application/json' -d '{"approve":true}' | J
curl -s -X POST $B/transfers/$TID/receive -H "Authorization: Bearer $PRM" -H 'Content-Type: application/json' -d '{"items":[{"product_id":1,"received_qty":79}]}' | J
echo "== 9. RBAC: promo01 调审批接口应403"
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/orders/$OID/approve -H "Authorization: Bearer $PRM" -H 'Content-Type: application/json' -d '{}'
echo "== 10. reports"
curl -s "$B/reports/sales?days=14" -H "Authorization: Bearer $GM" | J
curl -s "$B/reports/by-salesman" -H "Authorization: Bearer $MGR" | J
echo "== 11. 采购入库"
curl -s -X POST $B/purchases -H "Authorization: Bearer $MGR" -H 'Content-Type: application/json' -d '{"items":[{"product_id":1,"cartons":100,"loose":0}],"supplier":"测试供应商"}' | J
echo "== 12. 临期预警: gm 视角统计（应含 urgent/near 批次）"
curl -s "$B/expiry/alerts" -H "Authorization: Bearer $GM" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print('stat:',d['stat'],'| sample:',[(r['location_name'][:6],r['days_left'],r['level']) for r in d['rows'][:2]])"
echo "== 13. prm 视角（应仅本店）+ prm 查总仓批次应403"
curl -s "$B/expiry/alerts" -H "Authorization: Bearer $PRM" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print('stores:',set(r['location_name'] for r in d['rows']))"
curl -s -o /dev/null -w "%{http_code}\n" "$B/batches?location_id=1&product_id=1" -H "Authorization: Bearer $PRM"
echo "== 14. 采购后总仓袋装批次应新增今日批(ref=CG开头)"
curl -s "$B/batches?location_id=1&product_id=1" -H "Authorization: Bearer $GM" | python3 -c "import sys,json;rows=json.load(sys.stdin)['data'];print([(r['qty'],r['days_left'],r['level'],r['ref_no'][:9]) for r in rows])"
echo "== 15. 报废: mgr 报废一批临期批次 10 件"
BID=$(curl -s "$B/expiry/alerts" -H "Authorization: Bearer $GM" | python3 -c "import sys,json;rows=json.load(sys.stdin)['data']['rows'];print(next(r['id'] for r in rows if r['level']=='urgent'))")
curl -s -X POST $B/expiry/writeoff -H "Authorization: Bearer $MGR" -H 'Content-Type: application/json' -d "{\"batch_id\":$BID,\"qty\":10,\"reason\":\"冒烟测试报废\"}" | J
echo "== 16. RBAC: prm 报废应403"
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/expiry/writeoff -H "Authorization: Bearer $PRM" -H 'Content-Type: application/json' -d "{\"batch_id\":$BID,\"qty\":1}"
echo "== DONE"
