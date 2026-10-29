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
