# CSSD 器械消毒追溯系统

面向区域消毒供应中心（CSSD）与多家合作租赁诊所的器械消毒全程追溯系统。覆盖
**回收 → 清洗消毒 → 包装赋码 → 灭菌 → 化学/生物监测 → 放行 → 发放 → 签收/使用**
全流程，按批次与单件双向记录，满足感控与监管核查要求。

零第三方依赖：仅使用 Node.js（≥22，内置 `node:sqlite`）+ 原生前端。

## 启动

```bash
node server/db.js --seed   # 初始化数据库并写入演示数据（仅首次/需要重置时）
npm start                  # 或 node server/index.js，默认 http://localhost:3000
```

## 演示账号（密码均为 `123456`）

| 账号 | 角色 | 权限 |
|---|---|---|
| `operator` / `operator2` | 操作员 | 回收、清洗、包装、灭菌、监测录入、发放登记；**不能放行** |
| `reviewer` | 审核人 | 全部录入 + **放行/紧急放行** + 报表 + 审计查看 |
| `supervisor` | 感控督导员 | 查看全部批次、发起专项检查、闭环整改、导出报表、审计 |
| `clinic1` `clinic2` `clinic3` | 诊所用户 | 差异确认、召回确认/退回、签收、投入使用、本所追溯 |

## 预置演示场景

- **MJ20260920-02（12 件：8 止血钳 + 4 剪刀，灭菌器 STE-B02）**：化学监测合格、
  **生物监测待检**，审核人已做紧急放行；其中 **5 件已发往康美（3）/仁和（2）**
  （含 1 件已使用、2 件在途），**7 件在中心库房**。
  进入「灭菌/放行 → 批次详情 → 生物监测」，将结果改为「阳性」即可触发完整联动：
  12 件即刻冻结 → 按去向逐件生成召回任务并推送两诊所 → 自动生成不合格处置单；
  随后可在「不合格处置」填写「密封圈老化」原因分析并发起返工（换 STE-B01 重洗重灭），
  BI 合格后由审核人放行，处置单自动闭环；督导员可同步发起并闭环专项检查。
- **MJ20260919-01**：全流程合格的历史批次（含签收/使用记录），用于正向追溯演示。
- 回收批次自带 1 条待诊所确认的缺失差异。

## 核心控制点实现

- **待检即禁发**：BI 未出结果批次处 `pending_bi`，发放接口直接 403；临床急需可由
  **审核人**紧急放行（强制填写紧急原因，全程醒目标识，BI 阳性仍立即召回）。
- **阳性即冻结召回**：录入阳性在同一事务内锁定批次与全部单件（含在途/在库/已使用），
  对有有效交接的器械逐件生成召回任务 + 站内通知（含器械编号、交接/使用时间），
  并自动生成 NCR 不合格处置单。
- **返工闭环**：NCR 强制原因分析与整改措施；返工产生新灭菌批次并关联原批次，
  重新监测合格放行后 NCR 自动关闭。
- **权限分离**：操作员只录入；审核人才能放行；督导员专享专项检查与报表导出；
  诊所只能处理本所数据。
- **审计不可删除**：灭菌参数、监测结果、放行结论的修改强制填写理由，原值/新值写入
  `field_history`（仅追加），全部动作写 `audit_logs`。
- **双向追溯**：UID 反查全部批次/监测/去向/使用时间；批次号正查全部单件去向；
  「影响面速查」一键按诊所汇总在库/在途/签收/使用数量。
- **导出留痕**：报表导出写入 `report_exports`。

## 主要接口

`POST /api/auth/login`、`GET /api/dashboard`、`POST /api/recycles`、
`POST /api/recycles/:id/wash|pack|sterilize`、
`POST /api/sterilizations/:id/monitoring|release|revise|distribute`、
`POST /api/distributions/:id/receive|use`、
`POST /api/recalls/:id/ack|return`、
`POST /api/ncrs/:id/analyze|rework`、
`POST /api/inspections`、`GET /api/trace/instrument|batch|impact`、
`GET /api/reports/quality|/api/reports/export`、`GET /api/audit`、`GET /api/history`。

## 结构

```
server/db.js            表结构、种子数据、事务/审计/历史版本工具
server/util.js          HTTP 工具、令牌会话、RBAC、通知、单号
server/routes-core.js   回收/差异/清洗/包装/灭菌/监测/放行/冻结召回
server/routes-quality.js 发放签收/召回/NCR返工/专项检查/追溯/报表/审计
server/index.js         HTTP 入口与静态服务
public/                 原生 SPA（index.html / styles.css / app.js）
```
