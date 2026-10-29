// 家庭药箱效期提醒 — 全部逻辑（无构建，classic script，顶层函数即全局供 test.html 断言）

// ---------- 效期状态计算 ----------

function daysUntil(expiry, today = new Date()) {
  const [y, m, d] = expiry.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d)
    - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
}

function statusOf(expiry, today = new Date(), remindDays = 30) {
  const n = daysUntil(expiry, today);
  return n < 0 ? "expired" : (n <= remindDays ? "expiring" : "ok");
}

// ---------- 配置层 ----------

const CFG_DEFAULTS = {
  base: "https://open.bigmodel.cn/api/paas/v4",
  model: "glm-4v-flash",
  remindDays: 30,
};

function getCfg() {
  const rd = localStorage.getItem("mb_remind_days");
  return {
    base: localStorage.getItem("mb_api_base") || CFG_DEFAULTS.base,
    key: localStorage.getItem("mb_api_key") || "",
    model: localStorage.getItem("mb_model") || CFG_DEFAULTS.model,
    remindDays: rd === null ? CFG_DEFAULTS.remindDays : Number(rd),
  };
}

function saveCfg(partial) {
  if (partial.base !== undefined) localStorage.setItem("mb_api_base", partial.base);
  if (partial.key !== undefined) localStorage.setItem("mb_api_key", partial.key);
  if (partial.model !== undefined) localStorage.setItem("mb_model", partial.model);
  if (partial.remindDays !== undefined) localStorage.setItem("mb_remind_days", String(partial.remindDays));
}

// ---------- IndexedDB 数据层 ----------

let dbConn = null;

function dbOpen() {
  if (!dbConn) {
    dbConn = new Promise((resolve, reject) => {
      const req = indexedDB.open("medicine-box", 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("medicines")) {
          req.result.createObjectStore("medicines", { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
  }
  return dbConn;
}

function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function os(store, mode) {
  const db = await dbOpen();
  return db.transaction(store, mode).objectStore(store);
}

async function dbAdd(med) {
  const store = await os("medicines", "readwrite");
  return reqDone(store.add({
    name: med.name,
    expiry: med.expiry,
    note: med.note || "",
    photo: med.photo || null,
    createdAt: Date.now(),
    status: "active",
  }));
}

async function dbAll() {
  const store = await os("medicines", "readonly");
  return reqDone(store.getAll());
}

async function dbGet(id) {
  const store = await os("medicines", "readonly");
  return reqDone(store.get(id));
}

async function dbUpdate(med) {
  const store = await os("medicines", "readwrite");
  return reqDone(store.put(med));
}

async function dbDelete(id) {
  const store = await os("medicines", "readwrite");
  return reqDone(store.delete(id));
}

// ---------- AI 识别模块 ----------

const AI_PROMPT = `你是药品信息提取助手。请从这张药品包装照片中提取：
1. name: 药品名称（中文优先，如"布洛芬缓释胶囊"）；识别不出返回 null
2. expiry: 有效期截止日期，换算为绝对日期，格式 YYYY-MM-DD；包装上只有年月时按该月最后一天；识别不出或无法换算返回 null，不要猜测
只返回 JSON：{"name": "..." | null, "expiry": "YYYY-MM-DD" | null}`;

function parseAIResponse(text) {
  try {
    let t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    let obj;
    try { obj = JSON.parse(t); }
    catch { const m = t.match(/\{[\s\S]*\}/); obj = m ? JSON.parse(m[0]) : null; }
    if (!obj || typeof obj !== "object") throw new Error("not an object");
    const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : null;
    const expiry = typeof obj.expiry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(obj.expiry) ? obj.expiry : null;
    return { name, expiry };
  } catch { return { name: null, expiry: null }; }
}

function buildVisionBody(base64, model) {
  return {
    model,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + base64 } },
        { type: "text", text: AI_PROMPT },
      ],
    }],
    response_format: { type: "json_object" },
  };
}

async function callVisionAPI(base64) {
  const cfg = getCfg();
  if (!cfg.key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(cfg.base + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
      body: JSON.stringify(buildVisionBody(base64, cfg.model)),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : null;
    if (typeof text !== "string") return null;
    return parseAIResponse(text);
  } catch { return null; } finally { clearTimeout(timer); }
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error("压缩失败")), "image/jpeg", 0.7);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片加载失败")); };
    img.src = url;
  });
}
