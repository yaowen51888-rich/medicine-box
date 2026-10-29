# 家庭药箱效期提醒 App 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 纯前端无构建的手机网页 App：拍照 → AI 识别药名+效期 → IndexedDB 存储 → 首页红橙绿仪表盘提醒过期药。

**Architecture:** 单页应用，hash 路由 4 屏（首页/录入/详情/设置）。app.js 一个文件承载全部逻辑（纯函数 + 数据层 + AI 模块 + 渲染），顶层函数即全局供 test.html 断言。无后端，AI 调用由浏览器直连用户自配的 OpenAI 兼容视觉接口。

**Tech Stack:** 原生 HTML/CSS/JS（ES2020，classic script），IndexedDB，Canvas 压缩，无任何依赖。

**Spec:** `docs/superpowers/specs/2026-10-29-medicine-box-design.md`

## Global Constraints

- 无构建、无依赖、无框架；classic `<script>`（非 module），顶层函数声明直接暴露到 window
- app.js 的 UI 初始化必须以 `document.getElementById('app')` 存在为守卫（test.html 无 #app，不触发 UI）
- 文件只有 4 个：`medicine-box/` 下 index.html、app.js、style.css、test.html（测试夹具可放 `medicine-box/test-fixtures/`）
- 移动优先（viewport ≤430px），正文字号 ≥16px；状态色语义：已过期红 / 临期橙 / 正常绿；界面语言简体中文
- **UI 任务（Task 4-6）开工前必须先用 Skill 工具加载 `landing-page-design` 并遵循其视觉规则**
- localStorage（前缀 `mb_`）：`mb_api_base`、`mb_api_key`、`mb_model`、`mb_remind_days`
- IndexedDB：库名 `medicine-box` 版本 1，store `medicines`，keyPath `id` 自增
- 默认值：base `https://open.bigmodel.cn/api/paas/v4`，model `glm-4v-flash`，提醒天数 30
- 记录结构：`{id, name, expiry: "YYYY-MM-DD", note, photo: Blob|null, createdAt, status: "active"|"disposed"}`
- 路由：`#/`（首页）、`#/add`（录入）、`#/detail/{id}`（详情）、`#/settings`（设置）
- git 仓库在 `E:\play\chat` 根，每个任务一次 commit
- 本地验证服务器：`cd medicine-box && npx -y http-server -p 8765`（后台运行），Playwright 访问 `http://localhost:8765/`

## Review Focus

1. **时区差一天**：`new Date("2027-05-31")` 按 UTC 解析，与本地日期相减可能差一天 → Task 1 钉死算法：两侧都用 `Date.UTC(本地年,月,日)` 再求差
2. **效期当天边界**：剩 0 天必须算"即将过期"而非"正常"或"过期" → Task 1 边界测试
3. **AI 返回脏数据**：markdown 围栏、前后杂文本、非法日期格式（"2027/05/31"）→ Task 3 解析测试：非法一律归 null，绝不猜
4. **无 Key / AI 失败时录入卡死** → Task 5 Playwright 验证无 Key 手动路径完整可用；callVisionAPI 任何失败返回 null 不抛异常
5. **首页重复渲染 Object URL 泄漏** → Task 4 renderHome 每次渲染前 revoke 上一批 URL（模块级数组跟踪）

---

### Task 1: 项目骨架 + 效期状态纯函数 + 自检页

**Files:**
- Create: `medicine-box/app.js`
- Create: `medicine-box/test.html`

**Interfaces:**
- Produces: `daysUntil(expiry: string, today?: Date) → number`（效期日−今天；当天 0，昨天 -1）
- Produces: `statusOf(expiry: string, today?: Date, remindDays?: number) → "expired"|"expiring"|"ok"`（remindDays 默认 30）

- [ ] **Step 1: 写失败测试** — 创建 test.html：断言助手 + 结果渲染（`<div id="result">`，末尾输出 `N passed, M failed` 并 console.log），script 引入 app.js，断言：

```js
const T = new Date(2026, 9, 29); // 2026-10-29 本地
assert(daysUntil("2026-10-29", T) === 0, "当天=0");
assert(daysUntil("2026-10-28", T) === -1, "昨天=-1");
assert(daysUntil("2026-11-28", T) === 30, "30天后=30");
assert(daysUntil("2027-01-01", new Date(2026, 11, 31)) === 1, "跨年");
assert(daysUntil("2027-02-28", new Date(2027, 1, 27)) === 1, "月末");
assert(statusOf("2026-10-29", T, 30) === "expiring", "剩0天=expiring");
assert(statusOf("2026-10-28", T, 30) === "expired", "过期1天=expired");
assert(statusOf("2026-11-28", T, 30) === "expiring", "剩30天=expiring");
assert(statusOf("2026-11-29", T, 30) === "ok", "剩31天=ok");
assert(statusOf("2026-11-06", T, 7) === "ok", "自定义remindDays");
```

- [ ] **Step 2: 起服务并验证测试失败** — `cd medicine-box && npx -y http-server -p 8765`（后台）；Playwright 打开 `http://localhost:8765/test.html`，期望 `10 failed`（ReferenceError: daysUntil is not defined）

- [ ] **Step 3: 实现 app.js 顶部两个函数** — 算法钉死（时区安全）：

```js
function daysUntil(expiry, today = new Date()) {
  const [y, m, d] = expiry.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d)
    - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
}
function statusOf(expiry, today = new Date(), remindDays = 30) {
  const n = daysUntil(expiry, today);
  return n < 0 ? "expired" : (n <= remindDays ? "expiring" : "ok");
}
```

- [ ] **Step 4: 验证测试通过** — 刷新 test.html，期望 `10 passed, 0 failed`

- [ ] **Step 5: Commit** — `git add medicine-box && git commit -m "feat: 效期状态计算与自检页"`

### Task 2: 配置层 + IndexedDB 数据层

**Files:**
- Modify: `medicine-box/app.js`（追加）
- Modify: `medicine-box/test.html`（追加异步测试）

**Interfaces:**
- Produces: `getCfg() → {base, key, model, remindDays}`（读 localStorage，缺省用全局约束的默认值）
- Produces: `saveCfg(partial)`（浅合并后写回；remindDays 存为数字）
- Produces: `dbAdd(med: {name, expiry, note?, photo?}) → Promise<id>`（自动补 `createdAt: Date.now(), status: "active"`）
- Produces: `dbAll() → Promise<Med[]>`、`dbGet(id) → Promise<Med|undefined>`、`dbUpdate(med) → Promise<void>`、`dbDelete(id) → Promise<void>`

- [ ] **Step 1: 写失败测试** — test.html 末尾追加异步块：

```js
// cfg 默认值与回写
const c = getCfg();
assert(c.base === "https://open.bigmodel.cn/api/paas/v4" && c.model === "glm-4v-flash" && c.remindDays === 30, "cfg默认值");
saveCfg({ remindDays: 7, key: "sk-test" });
assert(getCfg().remindDays === 7 && getCfg().key === "sk-test", "cfg回写");
saveCfg({ remindDays: 30, key: "" });
// db 往返
const id = await dbAdd({ name: "测试药", expiry: "2027-01-01", note: "", photo: null });
assert(typeof id === "number" && id >= 1, "add返回自增id");
const m = await dbGet(id);
assert(m.name === "测试药" && m.status === "active" && m.createdAt > 0, "get字段完整");
m.expiry = "2028-01-01"; m.status = "disposed";
await dbUpdate(m);
assert((await dbGet(id)).expiry === "2028-01-01", "update生效");
await dbDelete(id);
assert((await dbGet(id)) === undefined, "delete生效");
```

（test.html 的断言助手需支持 async/await 顶层：包在立即执行 async 函数里，结束才渲染结果）

- [ ] **Step 2: 验证失败** — 刷新，期望新断言全 fail（getCfg 未定义），原 10 条仍 pass

- [ ] **Step 3: 实现** — dbOpen() 缓存连接 Promise（onupgradeneeded 建库建 store）；全部操作 promisify；cfg 按全局约束的 key 读写

- [ ] **Step 4: 验证通过** — 刷新，期望 `16 passed, 0 failed`

- [ ] **Step 5: Commit** — `git commit -m "feat: 配置层与IndexedDB数据层"`

### Task 3: AI 识别模块（纯函数部分）

**Files:**
- Modify: `medicine-box/app.js`（追加）
- Modify: `medicine-box/test.html`（追加）

**Interfaces:**
- Produces: `AI_PROMPT`（常量，文案钉死见 Step 1）
- Produces: `buildVisionBody(base64: string, model: string) → object`（OpenAI 兼容请求体）
- Produces: `parseAIResponse(text: string) → {name: string|null, expiry: string|null}`（任何失败都是双 null，不抛）
- Produces: `callVisionAPI(base64: string) → Promise<{name,expiry}|null>`（无 key 或任何错误 → null；fetch + AbortController 20s 超时；URL 用 `${getCfg().base}/chat/completions`）
- Produces: `compressImage(file: File) → Promise<Blob>`（最长边 1024px、JPEG 0.7，经 canvas）

- [ ] **Step 1: 写失败测试**：

```js
const P = parseAIResponse;
assert(JSON.stringify(P('{"name":"布洛芬缓释胶囊","expiry":"2027-05-31"}')) === '{"name":"布洛芬缓释胶囊","expiry":"2027-05-31"}', "正常JSON");
assert(JSON.stringify(P('```json\n{"name":"感冒灵颗粒","expiry":null}\n```')) === '{"name":"感冒灵颗粒","expiry":null}', "围栏剥离");
assert(P('{"name":"x","expiry":"2027/05/31"}').expiry === null, "非法日期→null");
assert(P("前置说明 {\"name\":\"y\",\"expiry\":\"2027-05-31\"} 后缀").name === "y", "前后杂文本");
assert(P("完全不是JSON").name === null && P("完全不是JSON").expiry === null, "垃圾文本→双null");
const body = buildVisionBody("QUJD", "glm-4v-flash");
assert(body.model === "glm-4v-flash" && body.response_format.type === "json_object", "body结构");
assert(body.messages[0].content[0].image_url.url === "data:image/jpeg;base64,QUJD", "图片dataURL");
assert(body.messages[0].content[1].text === AI_PROMPT, "prompt进body");
```

- [ ] **Step 2: 验证失败** — 刷新，期望新断言 fail

- [ ] **Step 3: 实现** — AI_PROMPT 文案钉死：

```
你是药品信息提取助手。请从这张药品包装照片中提取：
1. name: 药品名称（中文优先，如"布洛芬缓释胶囊"）；识别不出返回 null
2. expiry: 有效期截止日期，换算为绝对日期，格式 YYYY-MM-DD；包装上只有年月时按该月最后一天；识别不出或无法换算返回 null，不要猜测
只返回 JSON：{"name": "..." | null, "expiry": "YYYY-MM-DD" | null}
```

parseAIResponse：剥 ``` 围栏 → 尝试 JSON.parse → 校验 expiry 匹配 `/^\d{4}-\d{2}-\d{2}$/` 否则归 null → name 非 string 归 null；catch 返回 `{name:null, expiry:null}`

- [ ] **Step 4: 验证通过** — 刷新，期望 `24 passed, 0 failed`

- [ ] **Step 5: Commit** — `git commit -m "feat: AI识别模块"`

### Task 4: UI 骨架 + 首页仪表盘（先加载 landing-page-design）

**Files:**
- Create: `medicine-box/index.html`
- Create: `medicine-box/style.css`
- Modify: `medicine-box/app.js`（追加路由与渲染）

**Interfaces:**
- Consumes: Task 1 `statusOf`、Task 2 `dbAll/getCfg`
- Produces: `renderHome()`（供其他屏保存/处理后调用刷新）；`onHashChange` 路由（index.html 内联注册或 app.js 内 `window.addEventListener('hashchange', route)`）
- index.html 结构钉死：`<main id="app">` 含 4 个 `<section id="view-home|view-add|view-detail|view-settings">`，底部固定导航 3 个 tab（药箱 `#/`、录入 `#/add`、设置 `#/settings`）

- [ ] **Step 1: 加载 landing-page-design 技能** — Skill 工具调用 `landing-page-design`，其排版/间距/配色规则用于 style.css；但状态语义色（红/橙/绿）与 ≥16px 字号是硬约束，冲突时以本计划为准

- [ ] **Step 2: 写 index.html + style.css** — 4 屏骨架、底部导航、首页占位结构（统计条 + 三段列表容器 + 悬浮录入按钮）；script 引 app.js（body 末尾）

- [ ] **Step 3: 实现路由 + renderHome** — hashchange 监听切换 section 显隐；renderHome：`dbAll()` → 过滤 active → 按 `getCfg().remindDays` 调 statusOf 分三段渲染（每条：缩略图 + 药名 + 效期 + "剩 N 天/已过期 N 天"）；统计条（共 N 盒 · 过期 X · 临期 Y）；缩略图用 `URL.createObjectURL(photo)`，`photo` 为 null 时显示占位符 💊，渲染前 revoke 上一批（模块级数组跟踪）；dbOpen 失败 → 首页顶部横幅"存储不可用，请换浏览器或关闭隐私模式"并禁用录入按钮；无药时显示空状态引导（"拍下第一盒药"）

- [ ] **Step 4: Playwright 验证** — 打开 `http://localhost:8765/`；用 browser_evaluate 依次 `await dbAdd(...)` 造 3 条数据（已过期 / 5 天内 / 明年）；刷新快照：三段分组、颜色类名、统计条数字（共 3 · 过期 1 · 临期 1）、缩略图渲染；再 evaluate 清掉这 3 条

- [ ] **Step 5: Commit** — `git commit -m "feat: UI骨架与首页仪表盘"`

### Task 5: 录入页（拍照 → AI → 表单 → 保存）

**Files:**
- Modify: `medicine-box/index.html`（录入屏表单）
- Modify: `medicine-box/app.js`（追加）
- Create: `medicine-box/test-fixtures/sample.png`（1×1 PNG 测试图）

**Interfaces:**
- Consumes: Task 2 `dbAdd/getCfg`、Task 3 `compressImage/callVisionAPI/parseAIResponse`
- Produces: 录入屏内联流程函数 `previewAndRecognize(file)`（压缩 → 预览 → callVisionAPI → 填表单；失败显示行内提示"识别失败，请手动填写"）

- [ ] **Step 1: 造测试图** — `node -e "require('fs').writeFileSync('test-fixtures/sample.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64'))"`（在 medicine-box/ 下执行）

- [ ] **Step 2: 写 UI + 逻辑** — index.html 录入屏：`<input type="file" accept="image/*" capture="environment" hidden>` + 大按钮触发、预览区、"识别中…"/错误提示位、表单（药名 text 必填、效期 `type="date"` 必填、备注 text）、保存按钮。app.js：选文件 → previewAndRecognize；保存校验（必填缺失标红 + 提示，不提交）→ `dbAdd` → 跳 `#/`

- [ ] **Step 3: Playwright 验证手动路径（无 Key）** — 确保未设置 key：点录入 → 上传 sample.png → 出现预览与"识别失败，请手动填写"提示 → 手动填药名"维生素C"+效期明天 → 保存 → 回首页出现在"即将过期"段

- [ ] **Step 4: Playwright 验证 AI 路径（mock）** — browser_evaluate 设 `saveCfg({key:"sk-mock"})`；browser_network_request 拦截 `*/chat/completions` 返回 `{"choices":[{"message":{"content":"```json\n{\"name\":\"布洛芬缓释胶囊\",\"expiry\":\"2027-05-31\"}\n```"}}]}`；重新上传图片 → 表单自动填好"布洛芬缓释胶囊"与 2027-05-31 → 保存 → 首页正常段出现；清理 mock 配置与测试数据

- [ ] **Step 5: 验证空表单拦截** — 不选图不填字段直接点保存 → 停留本页、必填项标红；刷新 test.html 确认 24 条纯函数断言仍全过

- [ ] **Step 6: Commit** — `git commit -m "feat: 拍照录入与AI识别流程"`

### Task 6: 详情/编辑页 + 设置页

**Files:**
- Modify: `medicine-box/index.html`（详情屏、设置屏）
- Modify: `medicine-box/app.js`（追加）

**Interfaces:**
- Consumes: Task 2 全部 db 函数 + `getCfg/saveCfg`、Task 4 `renderHome`
- Produces: `renderDetail(id)`（路由 `#/detail/{id}` 时调用）

- [ ] **Step 1: 写详情屏** — 大图（无图显示占位 emoji 💊）、编辑表单（药名/效期/备注）、「保存修改」（dbUpdate → 回首页）、「已扔掉/已用完」（status→disposed → 回首页）、「删除记录」（window.confirm 二次确认 → dbDelete → 回首页）

- [ ] **Step 2: 写设置屏** — 4 个字段（Base URL/Key/模型/提前天数，占位符显示默认值）+ 保存按钮（saveCfg → 提示已保存）；Key 输入框用 `type="password"`；页脚说明"Key 仅存于本机浏览器"

- [ ] **Step 3: Playwright 验证** — 造 1 条数据 → 点列表进详情 → 改效期为已过期日期 → 保存 → 首页变红段；再进详情点「已扔掉」→ 首页消失（dbGet 确认 status=disposed）；再造 1 条 → 删除 → browser_handle_dialog 确认 → 首页消失（dbGet undefined）；设置改提前天数=7 → 首页分组变化；刷新页面 → 设置与数据仍在（localStorage/IndexedDB 持久）

- [ ] **Step 4: Commit** — `git commit -m "feat: 详情编辑与设置页"`

### Task 7: 收尾全流程走查

**Files:**
- Modify: 仅修复走查中发现的问题

**Interfaces:**
- Consumes: 全部

- [ ] **Step 1: spec §9 人工验证清单** — Playwright 逐项过：① 无 Key 手动录入→列表状态正确 ② mock Key 识别→自动填充 ③ 标记已扔→消失 ④ 改提前天数→分组变化 ⑤ 空状态引导显示 ⑥ 无图占位符
- [ ] **Step 2: 双端截图** — viewport 390×844（手机）与 1280×800 各截首页一张，确认移动优先布局不破、字号可读
- [ ] **Step 3: 回归** — test.html 全量断言（24 passed, 0 failed）；`git status` 干净后最终 commit（如有修复）
